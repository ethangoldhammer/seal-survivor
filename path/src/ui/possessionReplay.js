// ============================================================================
// THE POSSESSION BAR, REPLAYED — the match's share of the ball, run back over
// the stats page at a multiple of the speed it happened at.
//
// The bar used to be the final number and nothing else: one width, arrived at
// before the page faded in. A match where one side held the ball for the first
// two minutes and then lost it entirely ends at 50-50, and so does a match
// where neither side ever got a grip — the same bar for two matches nobody
// would say played alike. Running the ledger back puts the SHAPE of it on
// screen: the bar swings out early, comes back, and settles on the number that
// was always there at the end of it.
//
// A PURE FUNCTION OF ELAPSED TIME, and that is the whole reason this is a file
// of its own rather than a few lines inside ui/statsCard.js. That module
// cannot be imported outside a browser — it pulls in the Rive runtime and a
// `?url` of a binary — and an off-by-one in a replay clock is exactly the
// thing a test should be able to catch without a GPU. Same reason, same shape,
// as ui/statsSeats.js beside it.
//
// STATELESS, so `at()` may be asked for any moment in any order. The card
// drives it forward off a frame clock, a test asks it about the middle, and
// neither can put the other's answer out.
//
// IT ENDS ON THE LEDGER'S OWN NUMBERS, not on its last mark. The two are the
// same to within a quarter second of play, and "to within" is not good enough
// for a figure printed beside the bar: the page comes to rest on exactly what
// tallySnapshot() said, so nobody can catch the replay disagreeing with the
// match.
// ============================================================================

/** Where the bar sits before anybody has touched the ball. See tallyTimeline. */
const EVEN = { left: 50, right: 50 };

/**
 * Build the replay.
 *
 * @param points  [{ t, left, right }] from tallyTimeline() — `t` in seconds of
 *                play, the two shares in percent.
 * @param seconds how long the match's play ran, which is the replay's length
 *                before `speed`.
 * @param final   { left, right } the ledger's own closing numbers, which the
 *                replay comes to rest on.
 * @param speed   how many seconds of match run per second of the page.
 * @param delay   a beat of the closing number before it starts, so the page
 *                arrives before it begins to move.
 * @returns { duration, at(elapsed) } — `duration` is wall seconds including
 *          the delay, `at` is { left, right, done }.
 */
export function makePossessionReplay({ points = [], seconds = 0, final = null,
                                       speed = 5, delay = 0 } = {}) {
  // A speed of zero is a bar that never moves and a replay that never ends, so
  // it is not an option; the way to turn this off is not to build one.
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 5;
  const wait = Number.isFinite(delay) && delay > 0 ? delay : 0;
  const span = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  // The last mark can sit a fraction short of the whistle (marks land on
  // multiples of a step) and can also sit PAST `seconds` by nothing at all;
  // the replay runs to whichever is later so no mark is cut off.
  const last = points.length ? Math.max(span, points[points.length - 1].t) : span;
  const rest = final && Number.isFinite(final.left) && Number.isFinite(final.right)
    ? { left: final.left, right: final.right }
    : (points.length ? pick(points[points.length - 1]) : { ...EVEN });

  /** A mark, without its clock. */
  function pick(p) { return { left: p.left, right: p.right }; }

  return {
    duration: wait + last / rate,

    at(elapsed) {
      const e = Number.isFinite(elapsed) ? elapsed : 0;
      // Nothing to replay — a match that ended before a single mark. The
      // closing numbers are all there is, and they are already right.
      if (!points.length || last <= 0) return { ...rest, done: true };
      if (e <= wait) return { ...(points[0] ? pick(points[0]) : EVEN), done: false };

      const t = (e - wait) * rate;
      if (t >= last) return { ...rest, done: true };

      // THE FIRST MARK IS NOT THE START. Play begins at 0 with nobody holding
      // the ball, and the first mark is a step later — so the leg before it
      // runs from an even split rather than snapping to wherever the first
      // quarter second landed.
      let i = upperBound(points, t);
      const b = points[i];
      const a = i > 0 ? points[i - 1] : { t: 0, ...EVEN };
      const gap = b.t - a.t;
      const k = gap > 0 ? (t - a.t) / gap : 1;
      return {
        left: a.left + (b.left - a.left) * k,
        right: a.right + (b.right - a.right) * k,
        done: false,
      };
    },
  };
}

/** The first mark at or after `t`. `t < last` is the caller's guarantee. */
function upperBound(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t >= t) hi = mid; else lo = mid + 1;
  }
  return lo;
}
