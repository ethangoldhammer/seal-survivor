// ---------------------------------------------------------------------------
// Frame times, recorded rather than glanced at.
//
// The tuner's fps number is an average over one frame and it is useless for the
// thing it gets asked about most: hitching. A 200ms stall IS one frame — the
// readout blinks once and by the time you look it is gone, so "did that
// stutter?" comes down to trusting your thumbs, and two runs an hour apart
// cannot be compared at all.
//
// So this keeps the distribution. A histogram for the percentiles (bounded
// memory, so a twenty-minute run costs the same as a one-minute one) plus the
// worst handful of frames with the time they happened, which is the part that
// actually finds a cause — "142ms at 1:12" is a question you can go and answer,
// where "the game felt bad" is not.
//
// IT MUST BE FED THE UNCLAMPED DELTA. The game loop's own `rawDt` is
// `Math.min(elapsed, 0.05)`, because a tab returning from the background must
// not teleport the simulation through half a second of physics. That clamp is
// right for gameplay and fatal here: every frame worse than 50ms would record
// as exactly 50ms, which is to say every hitch this exists to catch would be
// flattened into the same value and the worst-frame column would read 50.0 all
// the way down. perfFrame takes the timestamp and does its own subtraction.
// ---------------------------------------------------------------------------

// 1ms buckets to 120ms, then everything above in the last one. Anything past
// 120ms is already a disaster and its exact size doesn't change what you do
// about it — the worst-frames list below carries the real number anyway.
const BUCKETS = 121;
const OVERFLOW = BUCKETS - 1;

// What counts as a hitch. 33ms is a dropped frame at 60Hz — the point at which
// motion visibly steps rather than moves.
const HITCH_MS = 33;
// And the one worth going to look at: a third of a second is long enough to be
// felt as the game stopping.
const SPIKE_MS = 100;

const WORST_KEPT = 8;

// The rolling window behind the live readout, as a ring of raw frame times.
// Two seconds at 60fps — long enough that the worst frame doesn't vanish
// before you can read it, short enough that it clears after you fix something.
const WINDOW = 120;

const histogram = new Uint32Array(BUCKETS);
const recent = new Float32Array(WINDOW);
let recentAt = 0;
let recentFilled = 0;

let frames = 0;
let totalMs = 0;
let worstMs = 0;
let hitches = 0;
let spikes = 0;
let runClock = 0; // seconds of wall time since the run started
let recording = false;
let lastStamp = 0;
// [{ ms, at }], worst first, capped at WORST_KEPT.
let worst = [];

/**
 * Begin recording. Called when a run starts, not at boot — boot is a loading
 * screen and a shader warm-up, and folding those into a run's distribution
 * would put a 3000ms frame at the top of every report forever.
 */
export function perfRunStart(stamp = performance.now()) {
  histogram.fill(0);
  recent.fill(0);
  recentAt = 0;
  recentFilled = 0;
  frames = 0;
  totalMs = 0;
  worstMs = 0;
  hitches = 0;
  spikes = 0;
  runClock = 0;
  worst = [];
  lastStamp = stamp;
  recording = true;
}

export function perfStop() {
  recording = false;
}

/**
 * One frame. Takes the rAF timestamp and does its own subtraction — see the
 * note at the top about why it cannot take the loop's dt.
 */
export function perfFrame(stamp) {
  if (!recording) return;
  const ms = stamp - lastStamp;
  lastStamp = stamp;

  // The first frame of a run measures from perfRunStart to here, which spans
  // the menu teardown and every reset in startGame — real work, but not a
  // frame anybody rendered. Same for a tab that was in the background: the gap
  // is the time it spent not being asked to draw at all. Neither is a hitch,
  // and both would sit at the top of the report for the rest of the run.
  if (ms <= 0 || ms > 1000) return;

  frames++;
  totalMs += ms;
  runClock += ms / 1000;

  const bucket = ms >= OVERFLOW ? OVERFLOW : (ms | 0);
  histogram[bucket]++;

  recent[recentAt] = ms;
  recentAt = (recentAt + 1) % WINDOW;
  if (recentFilled < WINDOW) recentFilled++;

  if (ms >= HITCH_MS) hitches++;
  if (ms >= SPIKE_MS) spikes++;

  if (ms > worstMs) worstMs = ms;
  // Kept sorted and short, so this is a handful of comparisons on the rare
  // frames that qualify and a single one on every other.
  if (worst.length < WORST_KEPT || ms > worst[worst.length - 1].ms) {
    worst.push({ ms, at: runClock });
    worst.sort((a, b) => b.ms - a.ms);
    if (worst.length > WORST_KEPT) worst.length = WORST_KEPT;
  }
}

// The pth percentile in ms, read off the histogram. Bucket resolution is 1ms,
// which is finer than the difference anyone acts on.
function percentile(p) {
  if (!frames) return 0;
  const want = p * frames;
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    seen += histogram[i];
    if (seen >= want) return i;
  }
  return OVERFLOW;
}

/** What the live readout shows: the last couple of seconds, not the run. */
export function perfWindow() {
  let hi = 0;
  let over = 0;
  for (let i = 0; i < recentFilled; i++) {
    const ms = recent[i];
    if (ms > hi) hi = ms;
    if (ms >= HITCH_MS) over++;
  }
  return { worstMs: hi, hitches: over };
}

/** The whole run so far. */
export function perfSummary() {
  return {
    frames,
    seconds: runClock,
    meanMs: frames ? totalMs / frames : 0,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    worstMs,
    hitches,
    spikes,
    worst: worst.slice(),
  };
}

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Print the run. Called once when a run ends, so two runs can be compared by
 * reading two blocks rather than by remembering how the first one felt.
 *
 * `extra` is whatever the caller wants on the context line — draws and
 * megapixels, in practice, because a report without them cannot tell a run
 * that was slow from a window that was large.
 */
export function perfRunReport(label = 'run', extra = '') {
  const s = perfSummary();
  if (!s.frames) return s;

  const fps = s.meanMs ? 1000 / s.meanMs : 0;
  const lines = [
    `[perf] ${label} — ${clock(s.seconds)}, ${s.frames.toLocaleString()} frames, ${fps.toFixed(1)} fps mean${extra ? ` · ${extra}` : ''}`,
    `       median ${s.medianMs}ms · p95 ${s.p95Ms}ms · p99 ${s.p99Ms}ms · worst ${s.worstMs.toFixed(0)}ms`,
    `       hitches (>${HITCH_MS}ms): ${s.hitches}  ·  spikes (>${SPIKE_MS}ms): ${s.spikes}`,
  ];
  if (s.worst.length) {
    lines.push(`       worst frames: ${s.worst.map((w) => `${w.ms.toFixed(0)}ms @ ${clock(w.at)}`).join(' · ')}`);
  }
  // p99 is the number to watch across a change, not the mean: a fix that
  // removes stalls barely moves the average and halves this.
  console.log(lines.join('\n'));
  return s;
}
