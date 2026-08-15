import { CONFIG } from '../config.js';
import { CALLOUTS, pushCallout, clearCallout, bandState, holdFor } from './callouts.js';
import { calloutOnDevice } from '../calloutTable.js';

// ---------------------------------------------------------------------------
// THE FIRST-RUN COACH — a handful of short sentences, once per device, and then
// never again. Four on a keyboard, six on a phone or a pad.
//
// WHAT IT SAYS DEPENDS ON WHAT THEY ARE HOLDING, and so does WHICH STEPS EXIST.
// Both halves live in callouts.csv rather than here: a step can be worded three
// ways (a spacebar, a third finger and a shoulder button are not one
// instruction), and a step can exist for some devices only — which is what the
// swim and aim tips are. A phone needs them because both sticks are INVISIBLE
// and float wherever the thumb lands; a pad needs one line each because naming
// a stick is cheap; a keyboard needs neither, because WASD is the most guessed
// control in games and a mouse aims by existing. This file reads `ctx.device`
// for both questions and owns neither answer.
//
// THE CONTROLS COME ONE INPUT AT A TIME. swim, then aim, then strike — each
// waiting on the one before, so the screen never holds two instructions and the
// next only arrives once the last is a thing you have actually done.
//
// THE UNIT OF "SEEN" IS THE STEP, NOT THE RUN. The obvious build is one flag:
// has this browser played before. It is wrong for the only player it matters
// to — the one who starts a run, dies to a crab in ninety seconds, and comes
// back. Under a run flag that player has been taught to strike and nothing
// else, permanently, because the chum tip never got an orb to point at and the
// air tip never got a lungful low enough. Each step carries its own "done",
// so a short first run teaches what it had time for and the next one picks up
// the rest. Once the set is done nothing here ever speaks again.
//
// WHAT MARKS A STEP DONE IS THE ACTION, OR THE CLOCK. Doing the thing clears
// the tip — the tip's job is finished the moment it is obeyed, and a line still
// sitting there after you have obeyed it reads as the game not noticing. Not
// doing it clears it too, on the row's `hold` seconds: a tip that waits forever
// for an action is a tip you have started playing around, and it only had one
// useful moment anyway. Either way it is done and does not return.
//
// BUT NEVER BEFORE IT CAN BE READ. Obeying is allowed to end a tip, not to make
// it unreadable, so clearing waits out CONFIG.tutorial.minShow. Handing the
// controls out one per input means the confident player answers each line on
// the frame it appears — and without the floor, playing well is what turns the
// tutorial into three flickers.
//
// IT NEVER STOPS THE GAME. There is no acknowledge, no keypress, no pause; the
// fight runs underneath the whole time. What a tip gets instead is the band
// (which outranks every warning — see the note in callouts.js) and, for the two
// steps that are about a PLACE rather than a button, an arrow.
//
// THIS FILE DECIDES WHICH STEP AND WHEN. The words are callouts.csv, the band
// is systems/callouts.js, the arrow is ui/callout.js, and everything the steps
// read about the seal is handed in from the frame loop — so a harness can play
// a whole first run through it without a browser. See npm run test:callouts.
// ---------------------------------------------------------------------------

// Per browser, and deliberately NOT in the tuning snapshot: the tuning file is
// shared, checked in and hand-edited, and "which tips has this person seen" is
// none of those things. Versioned so a rewritten set of tips can be shown
// again to everybody by bumping the key rather than by asking them to clear
// storage — which they would not do, and should not have to.
const STORAGE_KEY = 'sealSurvivor.tips.v1';

/**
 * The steps, richest-in-context first. Each one is:
 *
 *   ready  may this be offered right now
 *   done   has the player done the thing (the tip's early out)
 *
 * Both are handed the same `ctx` the frame loop assembles, plus `events`, the
 * set of one-frame things that happened since the last tick. `ctx.device` is
 * in there too, but no step below tests it: which devices a step exists on is
 * its ROW's business, so that a wording change and an availability change are
 * the same kind of edit to the same file.
 *
 * PRIORITY IS THE csv's, not this list's order — a step that becomes ready
 * while a lower one is talking TAKES the band (running out of air is the case
 * that matters: a chum arrow is a suggestion to go the wrong way from a seal
 * that has seconds of breath left). The list order here is only how a reader
 * meets them.
 */
const STEPS = {
  // --- the controls, one input at a time -----------------------------------
  // THREE STEPS THAT HAND OUT THE CONTROLS ONE AT A TIME, in the order a player
  // physically acquires them: swim, then aim, then strike. Each waits for the
  // one before it to be answered, so the screen never holds two instructions
  // and the second only arrives once the first is a thing you have done.
  //
  // The first two are TOUCH AND PAD only, gated by the `devices` column on
  // their rows rather than by a test here. A keyboard needs neither: WASD is
  // the most guessed control in games, and a mouse aims by existing. A phone
  // has the opposite problem — both sticks are INVISIBLE and float wherever the
  // thumb lands — and a pad is in between, where naming the stick is worth one
  // short line.
  swim: {
    // The delay is not politeness: the run opens on a camera move over an empty
    // ocean, and a line of text during it is a line nobody was looking at yet.
    ready: (ctx) => ctx.runTime >= (CONFIG.tutorial?.openDelay ?? 2.5),
    // Polled rather than evented, unlike a strike or a bite: there is no moment
    // to catch, because moving is a STATE and is still true on the next frame.
    done: (ctx) => !!ctx.moving,
  },
  aim: {
    ready: (ctx, events, done) => settled('swim', done, ctx.device),
    done: (ctx) => !!ctx.aiming,
  },
  // The core verb, and the only one of the three every device is taught.
  strike: {
    ready: (ctx, events, done) =>
      settled('aim', done, ctx.device) && ctx.runTime >= (CONFIG.tutorial?.openDelay ?? 2.5),
    // Charging counts, and so does a strike that actually went off. The line
    // asks them to CHARGE one, so the button going down is the thing it asked
    // for — but a player who charged and launched inside a single frame gap
    // must not be left with the tip still up, which is what the event covers.
    done: (ctx, events) => !!ctx.charging || events.has('strike'),
  },
  // Only once striking is understood, and only with something to point at —
  // an arrow to the nearest bite is the entire content of this tip, so it must
  // not fire into empty water.
  chum: {
    ready: (ctx, events, done) => done.has('strike') && ctx.chumInWater,
    done: (ctx, events) => events.has('chum'),
  },
  // The emergency, and the one tip that answers a warning: it fires on the
  // same condition as "Oxygen low!" and says the thing that warning does not.
  surface: {
    ready: (ctx) => ctx.oxygenLow && !ctx.aboveSurface,
    // Either fix counts. Breaking the surface is the taught answer; the air
    // coming back some other way (a pickup, a run that ended) means the tip
    // has nothing left to be about.
    done: (ctx) => ctx.aboveSurface || !ctx.oxygenLow,
  },
  // Last, and taught only once air is understood: this is the same upward
  // swim, kept going. Offered near the surface with air to spare, because
  // anywhere else it is a suggestion to drown.
  breach: {
    ready: (ctx, events, done) => done.has('surface') && ctx.nearSurface && !ctx.oxygenLow,
    done: (ctx) => ctx.airTime >= (CONFIG.tutorial?.breachAir ?? 0.3),
  },
};

/** Every coach step the game knows how to offer. The join to callouts.csv. */
export const COACH_IDS = Object.keys(STEPS);

/**
 * Is `id` BEHIND US — either answered, or a step this device is never offered?
 *
 * The second half is what lets the three control steps chain. `strike` waits on
 * `aim`, and `aim` does not exist on a keyboard, so a plain `done.has('aim')`
 * would mean a keyboard player waiting forever for a tip they were never going
 * to be shown — the strike would simply never be taught, on the one device
 * where it is the only control tip there is.
 */
function settled(id, done, device) {
  return done.has(id) || !calloutOnDevice(CALLOUTS.get(id), device);
}

const doneIds = new Set(loadDone());
const events = new Set();

export const tutorialState = {
  // The step talking right now, or null. Held as the id rather than the row so
  // it survives a re-parsed table.
  active: null,
};

// Has the live tip been obeyed yet? Latched, and cleared with the step — see
// the legibility floor in updateTutorial.
let answered = false;

/**
 * The shortest this row may be on screen before the player's own input is
 * allowed to take it down.
 *
 * Never longer than the row's own `hold`: a floor above the hold would be a tip
 * whose timer could not end it, which would leave the "or the clock" half of
 * the contract unreachable and the step stuck talking until something louder
 * took the band.
 */
function legibleFor(row) {
  return Math.min(CONFIG.tutorial?.minShow ?? 1.6, holdFor(row));
}

// ---------------------------------------------------------------------------
// Persistence. Every path is wrapped: localStorage throws outright in a private
// window and on an opaque origin, and a tutorial is not worth taking the game
// down for. The failure mode of a throw swallowed here is that the tips show
// again next time, which is the right way to be wrong.
// ---------------------------------------------------------------------------

function loadDone() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    // Filtered against the live step list so an id from a bumped or hand-edited
    // key cannot mark a step that no longer exists — and, more usefully, cannot
    // silently suppress a NEW step added later under the same key.
    return Array.isArray(list) ? list.filter((id) => id in STEPS) : [];
  } catch {
    return [];
  }
}

function saveDone() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...doneIds]));
  } catch { /* private window, quota, opaque origin — the tips just come back */ }
}

/**
 * Has this browser been through the whole set?
 *
 * A step whose row does not exist on `device` does NOT hold this open. It has
 * to work that way: the movement tip is touch-only, and counting it would mean
 * every keyboard player's coach was permanently one step from finished — which
 * is not a tip that never fires, it is the whole system never going quiet.
 *
 * Left out (a harness, mostly) it answers strictly, about every step there is.
 */
export function tutorialComplete(device) {
  return COACH_IDS.every(
    (id) => doneIds.has(id) || !calloutOnDevice(CALLOUTS.get(id), device),
  );
}

/** Which steps are behind us. A copy — nothing outside this file writes it. */
export function tutorialDone() {
  return new Set(doneIds);
}

/**
 * Show the tips again from scratch. There is no button for this in the game —
 * it is a development door (window.__tips.reset()) and the thing a harness
 * calls between runs.
 */
export function resetTutorial() {
  doneIds.clear();
  saveDone();
  endStep(false);
}

/** Start of a run. The step ledger SURVIVES this; only the live tip doesn't. */
export function resetTutorialRun() {
  events.clear();
  endStep(false);
}

/**
 * A thing that just happened, recorded for one tick. Called from the frame
 * loop's own callbacks — `strike` on a release, `chum` when an orb goes down,
 * `pick` when a card is taken — because those are events with no state to poll
 * afterwards: by the time the next tick asks, the strike is over and the orb
 * is gone.
 */
export function noteTutorialEvent(name) {
  events.add(name);
}

function endStep(markDone) {
  const id = tutorialState.active;
  answered = false;
  if (!id) return;
  if (markDone) {
    doneIds.add(id);
    saveDone();
  }
  clearCallout(CALLOUTS.get(id));
  tutorialState.active = null;
}

/**
 * One frame of the coach.
 *
 * `live` false — a dead seal, a run that hasn't started — ends whatever was
 * talking WITHOUT marking it done: a tip interrupted by dying was never given
 * its chance, and burning it would mean the player who dies mid-lesson is the
 * one player who never gets taught.
 */
export function updateTutorial(dt, ctx = {}, live = true) {
  if (CONFIG.tutorial?.enabled === false || tutorialComplete(ctx.device)) {
    events.clear();
    if (tutorialState.active) endStep(false);
    return;
  }
  if (!live) {
    events.clear();
    if (tutorialState.active) endStep(false);
    return;
  }

  const activeId = tutorialState.active;
  if (activeId) {
    const step = STEPS[activeId];
    // ANSWERED IS LATCHED, CLEARING IS NOT. The two are separate because a
    // player can answer a tip on the frame it appears — the control tips are
    // handed out one per input, and a confident player has the next thumb down
    // already. Remembering the answer means the tip can still come off the
    // moment it has been read, without needing the player to hold the stick
    // there until the floor is up.
    if (!answered && step.done(ctx, events, doneIds)) answered = true;
    if (answered && bandState.age >= legibleFor(CALLOUTS.get(activeId))) {
      // Read, and answered. Off the band now rather than at the end of its
      // hold — the tip has been obeyed, and holding it there would be the game
      // arguing with something the player has already done.
      endStep(true);
    } else if (bandState.row !== CALLOUTS.get(activeId)) {
      // Timed out, or something louder took the band. Either way it had its
      // moment: this is the "or the clock" half of the contract, and the timer
      // that ran it is the band's own hold (see holdFor) rather than a second
      // clock here that could disagree with it.
      endStep(true);
    }
  }

  // PREEMPTION. A step that becomes ready while a lesser one is talking takes
  // the band off it — running out of air is the case this exists for: a chum
  // arrow left up while the seal is drowning is pointing away from the only
  // thing that matters in the next two seconds.
  //
  // The interrupted step is NOT marked done. It was cut off rather than shown,
  // which is the same judgement dying makes a few lines up, and for the same
  // reason: a step only gets one chance, so it must not lose it to something
  // that was never about it.
  if (tutorialState.active) {
    const live = CALLOUTS.get(tutorialState.active);
    if (bestReady(ctx, live?.priority ?? 0)) endStep(false);
  }

  if (!tutorialState.active) {
    const next = bestReady(ctx, -Infinity);
    // `pushCallout` has the final say, and its answer is respected: a step that
    // could not be shown is not started, so it stays available for the next
    // frame rather than being spent on a line nobody saw.
    if (next && pushCallout(next.row)) tutorialState.active = next.id;
  }
  events.clear();
}

// The best step that is ready, not yet done, and louder than `minPriority`.
// One function for both "what should be talking" and "is anything allowed to
// interrupt", because they are the same question with a different floor.
function bestReady(ctx, minPriority) {
  let best = null;
  for (const id of COACH_IDS) {
    if (doneIds.has(id)) continue;
    const row = CALLOUTS.get(id);
    if (!row || row.kind !== 'coach') continue;
    // Wrong device — the row does not exist for this player at all. Not the
    // same as a reworded line, which needs nothing from here: that is picked
    // when the words are drawn.
    if (!calloutOnDevice(row, ctx.device)) continue;
    if (row.priority <= minPriority) continue;
    if (best && row.priority <= best.row.priority) continue;
    if (!STEPS[id].ready(ctx, events, doneIds)) continue;
    best = { id, row };
  }
  return best;
}

// The development door. Not a debug panel and not in the pause menu: this is
// for the one afternoon somebody is writing the tips and needs to see them
// again, and a control in the shipping UI for that would be a control every
// player has to be shown past.
if (typeof window !== 'undefined') {
  window.__tips = {
    reset: () => { resetTutorial(); return 'tips will show again'; },
    done: () => [...doneIds],
  };
}
