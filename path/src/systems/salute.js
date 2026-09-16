import { CONFIG } from '../config.js';
import { celebrationState, playCelebration } from './celebrate.js';
import { graveInReach } from './graveGaze.js';

// ============================================================================
// SALUTING A GRAVE — the gesture button, in front of a headstone.
//
// THE SAME BUTTON AS THE CLAP, and that is a design decision rather than a
// saving. The alternative was a binding of its own, and a second key would
// have to be taught, shown in the controls screen, and found on a pad — for a
// gesture that is only ever available in front of one of six stones on the
// floor of the arena. The button already means "do the thing an animal does
// because I asked it to"; what that thing IS is allowed to depend on where the
// animal is standing.
//
// So: a stone in reach makes the button a salute, and everywhere else in the
// ocean it is still a clap. The cost is honest and worth naming — you cannot
// clap AT a grave — and `CONFIG.salute.enabled` is the switch that gives the
// clap back if that ever reads wrong.
//
// IT DOES NOT ASK YOU TO HAVE STOPPED. The camera push (systems/graveGaze.js)
// does, because a frame that moves itself has to be sure you meant it; a
// button press IS the player saying they meant it, so the only condition here
// is that there is a stone close enough to salute. In practice the two arrive
// together — you stop, the frame creeps in, you press — but tying the gesture
// to the dwell would mean a press half a second early did nothing at all,
// which reads as the button being broken rather than as being early.
//
// NO RE-ENTRY, unlike the clap. A celebration re-captures its entry snapshot
// whenever `seq` changes, so a second salute fired over a live one would
// snapshot the SALUTED pose as the thing to return to — the exact ratchet
// systems/poseRig.js exists to prevent, and the reason the clap has a system
// of its own instead of being a variant. A press during one is refused.
// ============================================================================

function cfg() {
  return CONFIG.salute ?? {};
}

// Wall seconds since the last accepted press. Against auto-repeat and mashing,
// not as a cooldown — the refusal above already covers the length of a
// performance, and this only keeps the frames either side of it quiet.
let since = Infinity;

export function updateSalute(rawDt) {
  since += Math.max(0, rawDt ?? 0);
}

export function resetSalute() {
  since = Infinity;
}

/**
 * WHY THE BUTTON DID NOTHING — every gate, in one object.
 *
 * Four different conditions can refuse a press and all four look identical
 * from the outside: no stone, a performance already running, the throttle, and
 * the switch. For a gesture with no UI of its own that is the whole debugging
 * surface, so it is published rather than left to be worked out from the
 * source. Read by ui/animDebug.js.
 */
export function saluteDebug() {
  const c = cfg();
  return {
    enabled: c.enabled !== false,
    grave: graveInReach()?.name ?? null,
    busy: celebrationState.active ? (celebrationState.variant ?? 'a celebration') : null,
    since,
    minGap: c.minGap ?? 0.25,
    ready: saluteReady() && !celebrationState.active && since >= (c.minGap ?? 0.25),
  };
}

/** Is the button a salute right now rather than a clap? */
export function saluteReady() {
  if (cfg().enabled === false) return false;
  return !!graveInReach();
}

/**
 * Press it.
 *
 * @param at  where the gesture happens, for the voice and the burst — the
 *            caller's, because the seal's hands are a better place for it than
 *            the middle of the body and only the run knows where those are.
 * @param seal  { x, y } the animal's position, for which side the stone is on
 * @returns the variant that started, or null if nothing did — which the caller
 *          treats as "then it was an ordinary clap".
 */
export function trySalute(at = null, seal = null) {
  if (!saluteReady()) return null;
  const c = cfg();
  // A performance already running is refused rather than restarted — see the
  // header. `active` covers any celebration, not just a salute: pressing this
  // through a boss lap would cut the lap short and hand the seal a pose it did
  // not finish arriving at.
  if (celebrationState.active) return null;
  if (since < (c.minGap ?? 0.25)) return null;
  const grave = graveInReach();
  if (!grave) return null;

  // UPRIGHT, LEANING AT THE STONE. `+Y` is up the screen, so a facing of
  // (0, 1) stands the animal on its tail; the x term turns the nose toward the
  // marker and — just as importantly — is what decides the MIRROR, since the
  // seal is belly-first toward whichever way it points and a perfectly
  // vertical facing leaves that to rounding. See celebrationFacing for how the
  // direction reaches the body.
  const dx = grave.x - (seal?.x ?? grave.x);
  const lean = Math.max(0, c.lean ?? 0.25) * (dx === 0 ? 1 : Math.sign(dx));

  since = 0;
  return playCelebration({
    variant: 'salute',
    peakAt: c.peakAt ?? 0.42,
    hold: c.hold ?? 1.4,
    release: c.release ?? 0.55,
    // NOT THE SQUAD'S MOMENT. The escorts clap along with a boss kill because
    // the kill is the team's; a grave is one animal's business, and six seals
    // applauding a headstone is the joke this gesture is not making.
    escorts: false,
    facing: { x: lean, y: 1 },
    at,
  });
}
