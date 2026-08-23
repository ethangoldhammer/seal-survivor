import { CONFIG } from '../config.js';
import { adaptiveResEnabled } from './settings.js';

// ---------------------------------------------------------------------------
// ADAPTIVE RESOLUTION — give back pixels on a machine that is drowning in
// them, and take them again when it is not.
//
// WHY PIXELS AND NOT LESS WORK. The recorded production runs are almost all one
// machine class — a 6.0-6.4 megapixel laptop — and on it the game loop executes
// for about **6ms of a 19ms frame**. The other 13ms it is not running at all:
// not in `render`, not in any timed phase, not in untimed JS. A tab idle for
// two thirds of a frame it is nonetheless missing is not CPU-bound, and no
// amount of cutting simulation work can move it. It is waiting on a GPU that
// was asked for 6.4 million pixels of caustics, god-rays, a bloom chain and a
// twenty-tap composite. Pixels are the only thing left to give back.
//
// See `perfFrameJs` in systems/perfLog.js for the measurement that says so, and
// the note on CONFIG.render for why per-pixel cost has nothing to do with what
// is happening in the water.
//
// A CONTROLLER, SO IT NEEDS HYSTERESIS. The naive version — drop when slow,
// raise when fast — oscillates forever, because raising the resolution is the
// thing that makes it slow again. The two directions are therefore deliberately
// asymmetric: drop quickly on sustained pain, recover only from a long clean
// stretch, and stop trying after enough round trips.
//
// Its own module rather than a closure in world.js because world.js cannot be
// loaded in Node — it builds a WebGLRenderer — and a feedback loop with three
// thresholds and two streak counters is exactly the kind of thing that needs a
// test. See tools/adaptive-scale-test.mjs.
// ---------------------------------------------------------------------------

// How many recent frames it judges on, and how often it looks. Two seconds at
// 60fps, checked twice a second: long enough that one boss arriving cannot move
// it, short enough to react within a beat.
const WINDOW = 120;
const CHECK = 30;

// A gap larger than this is a tab coming back from the background, not a slow
// frame, and must not be read as the GPU struggling.
const MAX_PLAUSIBLE_MS = 200;

// Comparing a repeatedly-decremented float against a threshold — see the note
// at the drop below. Far smaller than any step anyone would configure.
const EPS = 1e-6;

export function createAdaptiveScale() {
  const recent = new Float32Array(WINDOW);
  let recentAt = 0;
  let recentFilled = 0;
  let sinceCheck = 0;
  let badStreak = 0;
  let goodStreak = 0;
  let drops = 0;
  let scale = 1;

  /**
   * FORGET EVERYTHING MEASURED AT THE OLD RESOLUTION.
   *
   * Without this the controller overshoots every time, and it looks like a
   * badly chosen floor rather than what it is. The window is two seconds long
   * and the check runs four times inside it, so immediately after a cut the
   * next three decisions are still reading frames rendered at the resolution
   * that was just abandoned — they are all still over budget, so it cuts
   * again, and again, until it hits the floor. Textbook integral windup, and
   * on a machine that only needed one step down it costs the player most of
   * their pixels for nothing. Measured: settled at the 0.6 floor where 0.7 was
   * comfortably inside budget.
   *
   * Clearing the window means the next decision cannot happen until a full
   * two seconds have been measured at the NEW resolution, which is the only
   * evidence that says anything about whether the cut worked.
   */
  function settle() {
    recent.fill(0);
    recentAt = 0;
    recentFilled = 0;
    sinceCheck = 0;
    badStreak = 0;
    goodStreak = 0;
  }

  return {
    /** The multiplier to fold into the render scale. Never above 1. */
    get value() { return scale; },

    /** How many times it has cut, for the readout and the run record. */
    get drops() { return drops; },

    /**
     * One frame's wall time in ms, unclamped — the same delta the recorder
     * gets. `live` is false for a menu, a loading screen or a paused game:
     * those produce frames the GPU had nothing to do with, and reading them as
     * the machine struggling would cut the resolution of a game that is
     * running perfectly well.
     *
     * @returns true if the scale CHANGED, which is the caller's cue to
     *   reapply it — the renderer call behind that reallocates render targets,
     *   so it must not happen on every frame.
     */
    tick(frameMs, live) {
      const cfg = CONFIG.render?.adaptive;
      // The player's switch over the authored one. Exposed because this is the
      // only performance feature that changes the picture WITHOUT being asked —
      // somebody watching the resolution step down mid-fight has no way to know
      // it is deliberate unless there is a control with its name on it.
      if (!adaptiveResEnabled(cfg?.enabled) || !live) return false;
      if (!(frameMs > 0) || frameMs > MAX_PLAUSIBLE_MS) return false;

      recent[recentAt] = frameMs;
      recentAt = (recentAt + 1) % WINDOW;
      if (recentFilled < WINDOW) recentFilled++;
      if (++sinceCheck < CHECK || recentFilled < WINDOW) return false;
      sinceCheck = 0;

      // The SHARE of recent frames that missed the budget, never the mean. One
      // 300ms stall inside two clean seconds drags a mean over any threshold
      // you care to pick, and dropping the whole game's resolution because a
      // boss arrived is precisely the overreaction this has to avoid.
      const budget = cfg.targetMs ?? 18;
      let over = 0;
      for (let i = 0; i < recentFilled; i++) if (recent[i] > budget) over++;
      const share = over / recentFilled;

      if (share > (cfg.dropAbove ?? 0.35)) { badStreak++; goodStreak = 0; }
      else if (share < (cfg.raiseBelow ?? 0.05)) { goodStreak++; badStreak = 0; }
      else { badStreak = 0; goodStreak = 0; }

      const floor = cfg.floor ?? 0.6;
      const step = cfg.step ?? 0.1;

      // EPS, because the steps do not land on the floor exactly. 1.0 less four
      // tenths is 0.6000000000000001 in binary floating point, which is still
      // greater than 0.6 — so a plain `scale > floor` grants one more cut that
      // the clamp then makes a no-op, and `drops` ends up counting attempts
      // rather than the changes maxDrops is written in terms of.
      if (badStreak >= (cfg.dropAfter ?? 2) && scale > floor + EPS) {
        scale = Math.max(floor, scale - step);
        drops++;
        settle();
        return true;
      }
      if (goodStreak >= (cfg.raiseAfter ?? 10) && scale < 1 - EPS
        // Each round trip is a visible resolution change, so a machine that
        // keeps failing at a level is left there rather than walked up and
        // down it for the rest of the run.
        && drops < (cfg.maxDrops ?? 4)) {
        scale = Math.min(1, scale + step);
        settle();
        return true;
      }
      return false;
    },

    /** A new run starts at the resolution the player asked for. */
    reset() {
      recent.fill(0);
      recentAt = 0;
      recentFilled = 0;
      sinceCheck = 0;
      badStreak = 0;
      goodStreak = 0;
      drops = 0;
      scale = 1;
    },
  };
}
