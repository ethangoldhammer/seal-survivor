// ---------------------------------------------------------------------------
// ONE BAD FRAME MUST NOT END THE GAME.
//
// The frame loop is `renderer.setAnimationLoop(animate)`, and three's
// WebGLAnimation schedules the next frame AFTER the callback returns:
//
//     function onAnimationFrame( time, frame ) {
//         animationLoop( time, frame );
//         requestId = context.requestAnimationFrame( onAnimationFrame );
//     }
//
// So a throw out of animate() does not drop a frame — it drops EVERY frame
// after it. Nothing reschedules, and there is no second loop to notice. The
// canvas keeps its last picture, the audio graph carries on playing because it
// runs on its own clock in its own thread, and the game sits there: not
// crashed, not reset, not paused. Frozen, with the music still going.
//
// That is the shape of every lock-up this game has had. `t.hitShape` off the
// end of the enemy list was one instance of it (systems/hitShape.js, and
// tools/hit-guard-test.mjs); the freeze it caused was not a property of that
// bug, it was a property of the loop. Any throw anywhere in three thousand
// lines of frame does the same thing, and the next one is already written.
//
// So the loop is guarded here, and a throw costs one frame instead of the run.
// A transient — a stale index, a null on the frame something was torn down, a
// texture that went away mid-swap — recovers completely on the next tick and
// the player sees a hitch.
//
// WHAT THIS IS NOT. It is not a licence to leave throwing code in the frame.
// A swallowed error that nobody hears is a worse bug than the freeze, because
// the freeze at least got reported. So every distinct failure is announced
// once — to the console for whoever has one, and to the crash trail for
// whoever is holding a phone — and a signature that keeps coming back is
// counted rather than repeated, because the interesting number about an error
// that fires every frame is HOW MANY, not the message sixty more times.
//
// AND IT DOES NOT PRETEND TO SURVIVE THE UNSURVIVABLE. If every frame throws,
// the game is as frozen as it ever was; the difference is only that we now
// know. `stuckAfter` consecutive failures says the loop is not recovering, and
// that gets recorded as the thing that ended the session rather than as
// another hitch — one report, not one per frame, so the trail pulled off the
// phone reads `frame:stuck` and names the error instead of scrolling.
// ---------------------------------------------------------------------------

// How many frames in a row may throw before the loop is declared beyond
// recovery. Two seconds at 60fps: long enough that a bad stretch — a boss
// spawning into a torn-down roster, a level-up landing on a dying creature —
// gets its chance to come back, short enough that the report is written while
// the run it describes is still the one on screen.
const STUCK_AFTER = 120;

/**
 * The one line that identifies an error, for deciding whether we have seen it
 * before. Message plus the first frame of the stack: the message alone would
 * collapse ten different `undefined is not an object` throws into one, and the
 * whole stack would make every re-entry through a different path look new.
 *
 * Pure, and exported, because it is the only part of this file whose answer
 * can be wrong.
 */
export function signatureOf(err) {
  const msg = String(err?.message ?? err ?? 'unknown');
  // TWO STACK FORMATS, and the phone speaks the second one. V8 writes a header
  // line and then `    at fn (file:1:2)`; JavaScriptCore writes no header at
  // all and frames read `fn@file:1:2`. Taking "the first line of the stack"
  // gets the header on desktop — `Error: undefined is not an object` — which
  // is the message again and identifies nothing. So a frame is recognised by
  // shape, and anything that is not one is skipped.
  const top = String(err?.stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('at ') || /\S@\S/.test(l)) ?? '';
  return top ? `${msg} @ ${top}` : msg;
}

/**
 * Wrap a frame function so it cannot end the loop.
 *
 * @param fn        the frame — called with whatever the loop hands it.
 * @param report    told about failures. `{ signature, err, count, consecutive,
 *                  stuck }` — `stuck` is true exactly once, on the frame the
 *                  loop is declared beyond recovery.
 * @param stuckAfter consecutive failures before that verdict.
 * @returns a function with the same signature as `fn`, which never throws.
 */
export function guardFrame(fn, { report = () => {}, stuckAfter = STUCK_AFTER } = {}) {
  // Per signature, so an error that fires every frame is one entry with a
  // count on it rather than a trail of sixty identical crumbs — and so a
  // SECOND, different error appearing behind the first is still announced.
  const seen = new Map();
  let consecutive = 0;
  let stuckOn = null;

  return function guarded(...args) {
    try {
      const out = fn(...args);
      // A frame that completed. The streak is the thing being counted, so it
      // resets here and nowhere else; `seen` deliberately does not, because
      // "this happened 400 times across the run" is the reading that matters
      // for something intermittent.
      consecutive = 0;
      stuckOn = null;
      return out;
    } catch (err) {
      const signature = signatureOf(err);
      const count = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, count);
      consecutive++;
      // The verdict fires ONCE per stretch. Without the latch this would
      // report on every frame past the threshold, which is the flood the
      // whole file exists to avoid — and it is keyed on the signature so a
      // stuck loop that changes its mind about how it is failing says so.
      const stuck = consecutive >= stuckAfter && stuckOn !== signature;
      if (stuck) stuckOn = signature;
      // The report itself must never be the thing that kills the loop.
      try {
        report({ signature, err, count, consecutive, stuck, first: count === 1 });
      } catch { /* an instrument that throws is not an instrument */ }
      return undefined;
    }
  };
}
