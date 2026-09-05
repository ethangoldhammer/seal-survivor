// HOW THE FIRST NAME ARRIVES: two reels of halves, slowing, landing on one.
//
// The splash used to come up with the artboard's own placeholder in the pill —
// a line asking for a name on a screen that has no way to type one (see the
// header of ui/riveSplash.js for how the text field left). The dice is the only
// control, so the honest first frame is the dice already rolling: the pill
// flips through combinations out of sealNames.csv, each flip a little slower
// than the last, and settles on the one the player starts as. A returning
// player keeps their own seal and skips this, unless `always` asks for the
// reel to land on it anyway.
//
// THE HALVES FLIP SEPARATELY. A seal name is an adjective and a nickname drawn
// from two hats (sealNameTable.js), and a reel that swapped whole names would
// hide that — it would read as a list being scrolled. So the adjective and the
// nickname are two reels on two clocks: the adjective stops first, the nickname
// keeps going and lands last, and every flip in between changes ONE half while
// the other stands. Watching "Fat Tony" become "Fat Marge" become "Salty Marge"
// is watching the name get built, which is the whole point.
//
// A SCHEDULE, NOT A SIMULATION. Each reel's flips sit on a geometric ladder:
// every gap is the previous one times a fixed ratio, and the last gap is
// `slowdown` times the first. That is what a slot reel's deceleration looks
// like from the outside, and it is three numbers that each mean one thing on
// a slider — how many names, how long, how hard it brakes — rather than a
// curve exponent whose effect on the first flip nobody can predict. A reel's
// `stop` is where in the whole run it lands, so the adjective at 0.6 gets a
// ladder 60% as long with 60% of the flips. The whole run is a merged list of
// millisecond offsets computed up front, so a test can read the shape without
// a clock.
//
// The flips are hard cuts on purpose. The dice's dissolve (ui/nameSwap.js)
// photographs the old name and boils it away over ~0.45s; at thirty
// milliseconds a flip, a dozen of those stacked would be a smear, and a reel
// that reads as a reel is one where each word is briefly THERE. The landing
// alone is handed to the caller separately, so the splash can give that one
// flip the dissolve — the last word breaking up into the name that stays.
//
// Dependency-free, like nameSwap.js: the timers are injectable and nothing
// here touches the DOM or the table, so a look page can drive it with sliders
// and a test can run it on a fake clock with a two-word hat.

/**
 * What a scramble may be given. CONFIG.reveals.nameScramble is passed straight
 * in by the game; a look page can hand in its own. Every field is optional.
 */
export const NAME_SCRAMBLE_DEFAULTS = {
  enabled: true,
  // Flips of the LAST reel to land before it does. Reels that stop earlier
  // get proportionally fewer. Zero shows the landing at once.
  ticks: 12,
  // From the first flip to the last reel landing, in seconds.
  time: 1.5,
  // How many times longer a reel's last gap is than its first. 1 is an even
  // tick; the reel reads as braking from about 4 up.
  slowdown: 10,
  // Seconds before the first name is shown. Zero is the first frame — the
  // pill never shows its placeholder at all.
  delay: 0,
  // Where in the run the ADJECTIVE reel lands, as a fraction of `time`. The
  // nickname always lands at 1. Below 1 the front half settles while the back
  // half is still spinning, which is the slot-machine read; 1 lands both at
  // once.
  adjectiveStop: 0.6,
  // Run the reel for a returning player too, landing on the name on file.
  // Off by default: a player who has a seal sees their seal.
  always: false,
};

/**
 * One reel's flip times in milliseconds from the start, first flip first,
 * landing last. `ticks + 1` entries; the first is `delay` and the last is
 * `delay + time`. Gaps grow by a fixed ratio, so consecutive differences never
 * shrink and the final gap is `slowdown` times the first.
 *
 * @param {object} [opts] any subset of NAME_SCRAMBLE_DEFAULTS
 * @returns {number[]} offsets in ms, strictly increasing
 */
export function scrambleSchedule(opts) {
  const o = { ...NAME_SCRAMBLE_DEFAULTS, ...(opts || {}) };
  const ticks = Math.max(0, Math.floor(Number(o.ticks) || 0));
  const delayMs = Math.max(0, (Number(o.delay) || 0) * 1000);
  const timeMs = Math.max(0, (Number(o.time) || 0) * 1000);
  if (ticks === 0 || timeMs === 0) return [delayMs];
  const n = ticks;                                  // gaps between ticks+1 flips
  const slow = Math.max(1, Number(o.slowdown) || 1);
  // gap_k = g0 * r^k for k = 0..n-1, summing to timeMs, with r^(n-1) = slow.
  const r = n > 1 ? Math.pow(slow, 1 / (n - 1)) : 1;
  const g0 = r === 1 ? timeMs / n : timeMs * (r - 1) / (Math.pow(r, n) - 1);
  const out = [delayMs];
  let t = delayMs;
  let gap = g0;
  for (let k = 0; k < n; k += 1) {
    t += gap;
    out.push(t);
    gap *= r;
  }
  // The last entry is the landing and must be exactly on time, not a float
  // sum's idea of it.
  out[out.length - 1] = delayMs + timeMs;
  return out;
}

/**
 * The flip times of every reel, merged: one entry per distinct moment, each
 * naming the reels that flip then and whether that flip is the reel's landing.
 * Reel `i` runs a ladder over `stop_i * time` with `round(stop_i * ticks)`
 * flips (at least one, while ticks > 0), so a reel stopping at 0.6 brakes over
 * the first 60% and the last reel lands at `delay + time`.
 *
 * @param {Array<{stop?: number}>} reels
 * @param {object} [opts]
 * @returns {Array<{at: number, flips: Array<{reel: number, last: boolean}>}>}
 */
export function reelSchedule(reels, opts) {
  const o = { ...NAME_SCRAMBLE_DEFAULTS, ...(opts || {}) };
  const ticks = Math.max(0, Math.floor(Number(o.ticks) || 0));
  const events = new Map();
  reels.forEach((reel, i) => {
    const stop = Math.min(1, Math.max(0, Number(reel?.stop ?? 1) || 0));
    const own = ticks > 0 && stop > 0 ? Math.max(1, Math.round(ticks * stop)) : 0;
    const times = scrambleSchedule({ ...o, ticks: own, time: o.time * stop });
    times.forEach((at, k) => {
      const key = Math.round(at * 1000) / 1000;
      if (!events.has(key)) events.set(key, { at: key, flips: [] });
      events.get(key).flips.push({ reel: i, last: k === times.length - 1 });
    });
  });
  return [...events.values()].sort((a, b) => a.at - b.at);
}

/**
 * Run a scramble over `reels`. Each reel is `{ roll, landing, stop }`:
 * `roll(previous, values)` supplies its next interim value (`values` is what
 * every reel currently shows, so a half can be drawn to fit beside the other),
 * `landing` is the value it stops on, `stop` where in the run it stops (0..1,
 * default 1). Whenever any reel flips, `show(join(values))` is called; when the
 * last reel lands, `land(join(landings))` is called instead.
 *
 * A reel's roll is asked again, once, if it hands back the value it is already
 * showing or its landing — a reel that shows the answer early, or the same
 * word twice, reads as a stall.
 *
 * With `enabled: false` or no ticks, `land` is called on the first moment and
 * nothing is shown in between.
 *
 * @returns {{ cancel(): void, schedule: Array<{at:number, flips:Array}> }} —
 *   cancel stops the reels where they are; nothing further is shown and
 *   `land` is never called.
 */
export function runNameScramble({
  reels,
  join = (values) => values.filter(Boolean).join(' '),
  show,
  land,
  opts,
  setTimeout: schedule = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: unschedule = (id) => clearTimeout(id),
}) {
  const o = { ...NAME_SCRAMBLE_DEFAULTS, ...(opts || {}) };
  const landings = reels.map((r) => r.landing ?? '');
  const events = o.enabled === false
    ? [{ at: 0, flips: reels.map((_, i) => ({ reel: i, last: true })) }]
    : reelSchedule(reels, o);
  const values = reels.map(() => '');
  let alive = true;
  let timer = null;
  let at = 0;

  const draw = (i) => {
    const reel = reels[i];
    const previous = values[i];
    let v = reel.roll(previous, values);
    if (v === previous || v === landings[i]) v = reel.roll(previous, values);
    return v ?? '';
  };

  const step = () => {
    timer = null;
    if (!alive) return;
    const ev = events[at];
    for (const f of ev.flips) values[f.reel] = f.last ? landings[f.reel] : draw(f.reel);
    const finished = at === events.length - 1;
    if (finished) {
      alive = false;
      land(join(landings.slice()));
      return;
    }
    show(join(values.slice()));
    at += 1;
    timer = schedule(step, Math.max(0, events[at].at - ev.at));
  };

  timer = schedule(step, events[0]?.at ?? 0);

  return {
    schedule: events,
    cancel() {
      if (!alive) return;
      alive = false;
      if (timer != null) unschedule(timer);
      timer = null;
    },
  };
}
