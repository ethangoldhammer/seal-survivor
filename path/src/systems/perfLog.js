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
// [{ ms, at, why }], worst first, capped at WORST_KEPT.
let worst = [];

// --- what a hitch WAS -------------------------------------------------------
//
// Counting hitches says the game stutters, which anybody playing it already
// knew. The useful question is which of the three one-off costs a stuttering
// frame was paying, because they have three different fixes and are otherwise
// indistinguishable after the fact:
//
//   a PROGRAM appeared   three linked a shader on this frame. A first draw the
//                        warm-up did not cover.
//   a TEXTURE appeared   three uploaded an image. Also a first draw, but the
//                        fix is different — an upload can be scheduled, a link
//                        mostly cannot.
//   NEITHER              not a first-draw cost at all: GC, a paging driver, or
//                        genuinely expensive work on that frame.
//
// three keeps both counts on renderer.info, so this is two integers a frame and
// the deltas across a hitch are the attribution.
let lastPrograms = 0;
let lastTextures = 0;
let hitchCompile = 0;
let hitchUpload = 0;
let hitchNeither = 0;
let programsAdded = 0;
let texturesAdded = 0;

// --- WHICH shader, and whether it had been built before ---------------------
//
// `programsAdded` says forty programs were linked and stops there, which is the
// difference between two completely different bugs:
//
//   forty DISTINCT keys   the warm-up missed forty material configurations.
//                         Annoying, bounded, and paid once — the fortieth is
//                         the last one.
//   one key, forty times  something is releasing a program and rebuilding the
//                         identical shader. That is unbounded: it goes on for
//                         as long as the run does, and no amount of warming
//                         helps because the program WAS warm and got thrown
//                         away. This is the one worth chasing.
//
// three's own numbers cannot tell them apart. `info.programs.length` is the
// live set, so a release-and-rebuild leaves it unchanged; `programsAdded` (max
// id, see programsEverBuilt in main.js) counts both cases identically. The
// cache key is what separates them, and three hangs it on every program.
//
// Keyed by the cache key, counting builds. A key with a count above one is a
// rebuild — the same shader, linked again.
const programBuilds = new Map(); // cacheKey -> times built this run
let lastProgramId = -1;          // highest program id seen, so new ones are new
let programRebuilds = 0;         // builds of a key already built this run

// Bounded, because the map is keyed on strings three builds by concatenating
// every program parameter and they are not short. Past this the count for keys
// already in the map keeps rising — which is the number that matters, since a
// rebuild is by definition a key that has been seen — and genuinely new keys
// stop being added. A run that reaches this has already answered the question.
const KEYS_KEPT = 400;

/**
 * Fold this frame's program list in. Takes three's live array
 * (`renderer.info.programs`), and picks out the ones built since the last call
 * by id — ids come from a counter that only goes up, so anything above the
 * high-water mark is new.
 *
 * Silent and free when the caller passes nothing, which is every Node harness:
 * there is no GL context there and so no programs to read.
 */
function notePrograms(list) {
  if (!list?.length) return;
  let highest = lastProgramId;
  for (const p of list) {
    if (p.id <= lastProgramId) continue;
    if (p.id > highest) highest = p.id;
    const key = p.cacheKey ?? '(no key)';
    const seen = programBuilds.get(key);
    if (seen !== undefined) {
      programBuilds.set(key, seen + 1);
      programRebuilds++;
    } else if (programBuilds.size < KEYS_KEPT) {
      programBuilds.set(key, 1);
    }
  }
  lastProgramId = highest;
}

// The fourth answer, and the one the other three were hiding: the JS heap.
// A collection is the only thing that makes used heap go DOWN, so a stall on a
// frame where it dropped is the collector and a stall where it didn't is real
// work on that frame. Without this, both land in "neither" and look identical.
// Chrome only; 0 means the browser doesn't expose it and the split is skipped.
let lastHeap = 0;
let hitchGC = 0;
let heapFreed = 0;   // total bytes reclaimed across the run
let heapPeak = 0;

/**
 * Begin recording. Called when a run starts, not at boot — boot is a loading
 * screen and a shader warm-up, and folding those into a run's distribution
 * would put a 3000ms frame at the top of every report forever.
 */
export function perfRunStart(stamp = performance.now(), programs = 0, textures = 0, heap = 0, programList = null) {
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
  lastPrograms = programs;
  lastTextures = textures;
  hitchCompile = 0;
  hitchUpload = 0;
  hitchNeither = 0;
  programsAdded = 0;
  texturesAdded = 0;
  // Seeded from the live set rather than from -1: everything the warm-up built
  // is already there, and counting it as "built during the run" would put the
  // whole boot compile at the top of every report. Same reasoning as the
  // `programs` seed above.
  programBuilds.clear();
  programRebuilds = 0;
  lastProgramId = -1;
  for (const p of programList ?? []) if (p.id > lastProgramId) lastProgramId = p.id;
  lastHeap = heap;
  hitchGC = 0;
  heapFreed = 0;
  heapPeak = heap;
  recording = true;
}

export function perfStop() {
  recording = false;
}

/**
 * One frame. Takes the rAF timestamp and does its own subtraction — see the
 * note at the top about why it cannot take the loop's dt.
 */
export function perfFrame(stamp, programs = lastPrograms, textures = lastTextures, heap = lastHeap, programList = null) {
  if (!recording) return;
  const ms = stamp - lastStamp;
  lastStamp = stamp;

  // Before the early return below, deliberately. A program built on the frame a
  // backgrounded tab came back is still a program that got built, and dropping
  // it would leave the rebuild count quietly short by however many times the
  // player alt-tabbed.
  notePrograms(programList);

  // Deltas first, and consumed whether or not this frame turns out to be a
  // hitch — otherwise a compile on a fast frame would still be sitting in the
  // delta when the next slow frame came along, and get blamed for it.
  const newPrograms = Math.max(0, programs - lastPrograms);
  const newTextures = Math.max(0, textures - lastTextures);
  lastPrograms = programs;
  lastTextures = textures;
  programsAdded += newPrograms;
  texturesAdded += newTextures;

  // Only a collection returns memory. Anything above the noise floor is one —
  // a megabyte, so a shrinking retained set doesn't read as a collection.
  const collected = heap > 0 && lastHeap - heap > 1048576;
  if (collected) heapFreed += lastHeap - heap;
  if (heap > heapPeak) heapPeak = heap;
  lastHeap = heap;

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

  let why = '';
  if (ms >= HITCH_MS) {
    hitches++;
    // Compile wins the tie when both landed on one frame: a link is the more
    // expensive of the two by a wide margin, and a first draw usually pulls its
    // textures in on the same frame it compiles its program.
    if (newPrograms > 0) { hitchCompile++; why = 'compile'; }
    else if (newTextures > 0) { hitchUpload++; why = 'upload'; }
    // Ranked below the two first-draw costs: a compile allocates, so a frame
    // that did both is still best described by the compile.
    else if (collected) { hitchGC++; why = 'gc'; }
    else { hitchNeither++; why = 'other'; }
  }
  if (ms >= SPIKE_MS) spikes++;

  if (ms > worstMs) worstMs = ms;
  // Kept sorted and short, so this is a handful of comparisons on the rare
  // frames that qualify and a single one on every other.
  if (worst.length < WORST_KEPT || ms > worst[worst.length - 1].ms) {
    worst.push({ ms, at: runClock, why });
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
    // What the hitches WERE. These three sum to `hitches`.
    hitchCompile,
    hitchUpload,
    hitchGC,
    hitchNeither,
    heapFreedMB: heapFreed / 1048576,
    heapPeakMB: heapPeak / 1048576,
    // And the totals, for context: 40 programs linked across a run is a
    // warm-up that missed 40 programs, however they were distributed.
    programsAdded,
    texturesAdded,
    // And the split that says which kind of problem those programs are. See
    // the note above programBuilds: `programRebuilds` above zero is a shader
    // being thrown away and rebuilt, which no warm-up can fix.
    programRebuilds,
    programKeys: programBuilds.size,
    topPrograms: topPrograms(),
    worst: worst.slice(),
  };
}

// The keys built most often, worst first. Trimmed hard: a three cache key runs
// to hundreds of characters of parameter soup, and the part that identifies the
// shader — the material type and whatever customProgramCacheKey pinned — is at
// the front of it. The whole string in a run record would dwarf the run.
const KEY_CHARS = 90;
const TOP_KEPT = 6;

function topPrograms() {
  return [...programBuilds.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_KEPT)
    .map(([key, builds]) => ({ builds, key: key.slice(0, KEY_CHARS) }));
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
    `       of those: ${s.hitchCompile} shader link · ${s.hitchUpload} texture upload · ${s.hitchGC} collection · ${s.hitchNeither} none of those`,
    `       built this run: ${s.programsAdded} programs (${s.programKeys} distinct, ${s.programRebuilds} rebuilt), ${s.texturesAdded} textures`
      + (s.heapPeakMB > 0 ? `  ·  heap peak ${s.heapPeakMB.toFixed(0)}MB, ${s.heapFreedMB.toFixed(0)}MB collected` : ''),
  ];
  // Only when something actually rebuilt. A clean run should print nothing
  // here, so the block appearing at all is the signal.
  for (const p of s.topPrograms) {
    lines.push(`       rebuilt ${p.builds}x: ${p.key}`);
  }
  if (s.worst.length) {
    lines.push(`       worst frames: ${s.worst.map((w) => `${w.ms.toFixed(0)}ms @ ${clock(w.at)}${w.why ? ` (${w.why})` : ''}`).join(' · ')}`);
  }
  // p99 is the number to watch across a change, not the mean: a fix that
  // removes stalls barely moves the average and halves this.
  console.log(lines.join('\n'));
  return s;
}
