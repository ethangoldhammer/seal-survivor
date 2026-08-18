import { CONFIG } from '../config.js';
import {
  CALLOUTS, pushCallout, clearCallout, pinCallout, calloutAge, bandStates, holdFor,
} from './callouts.js';
import { calloutOnDevice, calloutText } from '../calloutTable.js';

// ---------------------------------------------------------------------------
// THE FIRST-RUN COACH — a handful of short sentences, once per device, and then
// never again. Twelve on a keyboard, fourteen on a phone or a pad — but almost
// nobody meets all of them in one run, which is the point of the per-step
// ledger further down.
//
// THEY COME IN TWO HALVES. The first is the CONTROLS, handed out one input at a
// time and chained to each other. The second is the OCEAN — chum, power-ups,
// the seabed, the things that cannot be killed — and those are not chained to
// anything, because the water decides when each of them is teachable and a
// single run may never contain one of them at all.
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
// A TIP ABOUT A THING STANDS NEXT TO THAT THING. Not in a band across the
// middle of the screen with an arrow pointing away from it — beside the bubble,
// riding it, so that reading the sentence and finding the object it describes
// are one look instead of two. The rows that name a `subject` (callouts.csv)
// are the ones this is about; the three control tips name nothing, because a
// stick is not somewhere in the water, and they stay on the band.
//
// AND IT STAYS THERE UNTIL THAT THING IS GONE. This is the half that replaced a
// clock. A tip riding an orb cannot expire six seconds in: the orb is still
// there, still unexplained, and the label that named it has vanished — which
// reads as the game changing its mind. So a world tip is PINNED (see
// pinCallout) and ends on exactly one of three things: the player did what it
// asked, the subject left the water, or the moment it described lapsed. The
// air-bubble tip goes when the bubble is popped, and not one frame before.
//
// WHAT MARKS A STEP DONE IS THE ACTION, OR THE MOMENT PASSING. Doing the thing
// clears the tip — the tip's job is finished the moment it is obeyed, and a
// line still sitting there after you have obeyed it reads as the game not
// noticing. The moment ending clears it too: the orb expired unswallowed, the
// pile got cleared, the turtle swam off. Either way it is done and does not
// return.
//
// THE ROW'S `hold` STILL RUNS THE BAND TIPS, and only those. For a world tip it
// is not a life any more — it is the cap on the legibility floor below, which
// is the only thing left that reads it.
//
// BUT NEVER BEFORE IT CAN BE READ. Obeying is allowed to end a tip, not to make
// it unreadable, so clearing waits out CONFIG.tutorial.minShow. Handing the
// controls out one per input means the confident player answers each line on
// the frame it appears — and without the floor, playing well is what turns the
// tutorial into three flickers.
//
// IT NEVER STOPS THE GAME. There is no acknowledge, no keypress, no pause; the
// fight runs underneath the whole time. What a tip gets instead is its own
// surface — the band, which outranks every warning (see the note in
// callouts.js), or the water beside its subject, which competes with nothing at
// all because it is not where anything else is drawn.
//
// AND WHILE IT TALKS, THE SUBJECT IS LIT. Whatever the line is about pulses in
// its own colour for as long as the line is up — see systems/telegraph.js. A
// sentence and a glowing object are the same message twice, which is the whole
// business of a first run: nobody should be reading "this one's a real deal
// seal meal" while trying to work out which of four things in the water it
// means.
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

// ---------------------------------------------------------------------------
// ONE TIP PER PICKUP TYPE, BUILT RATHER THAN WRITTEN OUT FIVE TIMES.
//
// WHY FIVE AND NOT ONE. They were one tip ("that is a power-up") and it taught
// nothing: the five pickups do five unrelated things — the blue orb is the
// boost meter, a bubble is air, the yellow one is fire rate, a chunk is
// health, an attractor drags the seabed to you — and the only thing a single
// sentence can honestly say about all of them is that they glow, which the
// player can see. What is worth a tip is WHICH ONE THIS IS, and that is five
// sentences.
//
// They are generated because the shape really is identical — one of these is
// in the water, swim into it, the tip is spent — and five hand-written copies
// of that would be five places for it to drift. Everything that DIFFERS
// between them is in the table: the words and the timing are their callouts.csv
// rows, and the one behavioural difference is `swim` below.
//
// THE ID IS ONE STRING END TO END: the step, the callouts row, the ctx query
// and the mesh name in assets.js. That is what lets the arrow point at the
// right orb by reading the row's own id (see arrowTarget in ui/callout.js), and
// it is why there is no mapping table anywhere on the path — a mapping is
// exactly how a tip ends up firing for the wrong pickup.
const PICKUP_TIPS = {
  // Ordered as a reader meets them; who speaks first is the `priority` column.
  bubbleOrb: { swim: true },
  strikeOrb: { swim: true },
  rapidFireOrb: { swim: true },
  chumChunk: { swim: true },
  // THE ODD ONE, and the reason this is a table rather than a list of names.
  // An attractor is a FIELD, not a collectable: it rises where the trawler
  // dropped it and drags every scrap of chum in the arena to the seal. There
  // is nothing to swim into, so there is nothing that can answer the tip and
  // it ends on its own clock — the same contract `invincible` has.
  attractorOrb: { swim: false },
};

function pickupSteps() {
  const out = {};
  for (const [id, { swim }] of Object.entries(PICKUP_TIPS)) {
    out[id] = {
      // Gated on the strike being taught and on nothing else. NOT chained to
      // each other or to `chum`: the priority column already decides who
      // speaks when two are ready on the same frame, and a chain here would
      // mean a player whose first bubble arrives before their first kill is
      // shown nothing at all about it.
      ready: (ctx, events, done) => done.has('strike') && !!ctx.pickupInWater?.(id),
      done: swim ? (ctx, events) => events.has(id) : () => false,
    };
  }
  return out;
}

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
  // --- everything the OCEAN teaches, rather than a button -------------------
  // None of what follows is chained to anything except where a tip literally
  // cannot be understood without an earlier one. They are ordered by the
  // `priority` column, which is enough: a run puts them in the water in roughly
  // that order anyway, and hard-chaining them would mean a player who never
  // sees a whale never gets told about crabs.
  //
  // What they have in common is that the moment is not repeatable. A power-up
  // orb expires, a whale leaves, the seabed pile gets eaten — so each of these
  // is READY only while its subject is actually there, and a step that misses
  // its window simply waits for the next one rather than firing into blank
  // water. That is the same contract the chum tip has always had.

  // The five pickups, one tip each — see PICKUP_TIPS at the top of the file.
  ...pickupSteps(),

  // THE FOOD CHAIN, and it is the only tip in the file about a LOOP rather
  // than about a thing. Taught after `chum`, because it is the sentence that
  // joins the two halves the player now has: they can strike, and they know
  // eating fills the meter, and nobody has said that doing them in that order
  // on a clock is the whole engine of the game.
  //
  // Offered while a combo window is actually open, which is the only moment the
  // instruction is performable. It outlives the window, and that is fine and
  // deliberate: the line is a rule to carry, not a prompt to obey inside two
  // seconds.
  //
  // WHAT KEEPS IT UP IS NOW THE LEGIBILITY FLOOR rather than the row's hold. A
  // world tip ends when its moment lapses, and this step's moment is the combo
  // window — a couple of seconds against a hundred-character sentence. The
  // floor is derived from that sentence's own length (see legibleFor) and is
  // several times longer than the window, so the line still gets its full
  // reading time. That is not a coincidence to rely on quietly: shorten this
  // line and it will leave sooner, which is the correct behaviour and worth
  // knowing before wondering where it went.
  foodChain: {
    ready: (ctx, events, done) => done.has('chum') && ctx.feeding && ctx.chumInWater,
    // A link actually scored. The one tip whose answer is the thing it
    // described happening, rather than a button or a pickup.
    done: (ctx, events) => events.has('chainLink'),
  },
  // Chum reaching the floor, which is the moment the seabed becomes a place
  // with rules. Offered as it lands rather than when the first crab walks on:
  // by then the answer ("get there first") is already gone, and a tip that
  // arrives with the consequence teaches nothing that the consequence didn't.
  crab: {
    ready: (ctx) => ctx.chumOnSeabed,
    // Clearing the floor is the action, and it is a real one — this is the only
    // tip down here that can be obeyed. Polled rather than evented because what
    // matters is the PILE being gone, not one orb of it going down: a player
    // who eats one and swims off has not done the thing.
    done: (ctx) => !ctx.chumOnSeabed,
  },
  // A turtle, or the whale. One step and one line for both, because what a
  // player has to learn is the same fact in both cases and it is a fact about
  // the ocean rather than about either animal: some of what swims past is not
  // an opponent. Whichever arrives first says it.
  invincible: {
    ready: (ctx) => ctx.unkillableNear,
    // Nothing to do about it — this tip is a fact, not an instruction, so it
    // is the only one in the file with no answer. It ends on its row's `hold`
    // through the "or the clock" half of the contract at the top of this file.
    // Deliberately NOT "the creature left": that is not the player doing
    // anything, and it would let a turtle drifting out of range cut the
    // sentence off mid-read.
    done: () => false,
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
  // WHERE THE LIVE TIP IS SPOKEN, in world units, or null for a band tip. Read
  // by the drawing (ui/callout.js) and by nothing else.
  //
  // A POSITION AND NOT THE OBJECT, on purpose: it is the last place the subject
  // was, so a tip whose bubble is popped mid-sentence stays exactly where the
  // bubble was rather than snapping to the middle of the screen for the half
  // second it takes to dissolve. The object itself is `subjectMesh`, and that
  // one DOES go null the moment it is gone — the light on it has to.
  anchor: null,
  // The thing being talked about, for whatever wants to light it up. Null for
  // a band tip and for a tip about a PLACE, neither of which has an object.
  subjectMesh: null,
  // How far through leaving the live tip is: 0 whole, 1 gone. Drives the
  // dissolve in ui/tipDissolve.js. The row stays on its surface for the whole
  // of this — a tip that vanished the frame it was answered would take its own
  // exit away.
  fade: 0,
};

// The subject handle the frame loop gave us when this step started, and whether
// it has since gone. Held here rather than on tutorialState because nothing
// outside this file has any business dereferencing it: it is whatever
// ctx.takeSubject chose to hand over, and only ctx.subjectAt can read it.
let subject = null;
let subjectGone = false;
// Seconds left of the dissolve, and the row it belongs to. The row is held
// separately from tutorialState.active because the step is DONE while this
// runs — it has been marked, the ledger is saved, and the only thing left is
// the picture of it leaving.
let fadeRow = null;
let fadeLeft = 0;

// Has the live tip been obeyed yet? Latched, and cleared with the step — see
// the legibility floor in updateTutorial.
let answered = false;

/**
 * The shortest this row may be on screen before the player's own input is
 * allowed to take it down.
 *
 * Never longer than the row's own `hold`: on a band tip a floor above the hold
 * would be a tip whose timer could not end it, and on a world tip the hold is
 * now nothing BUT this cap — the number that says how long a sentence this long
 * is allowed to demand before the thing it describes is gone.
 */
// Exported for the harness, which asserts the timing directly rather than by
// counting frames: "a long tip is held longer than a short one" is a claim
// about this function, and measuring it through a whole simulated run would be
// measuring the run.
export function legibleFor(row, device) {
  const c = CONFIG.tutorial ?? {};
  // THE FLOOR SCALES WITH THE SENTENCE, because a fixed one is wrong at both
  // ends of the table. 1.6 seconds is plenty for "Swim up for air" and is not
  // close to enough for "Strike then hoover the chum to keep a FOOD CHAIN
  // going. Each level of chain adds a score multiplier." — a hundred
  // characters, read while something is trying to eat you.
  //
  // Measured off the wording this player is actually being shown, not the
  // `text` column: the touch and pad variants are different lengths, and a
  // phone reading the keyboard line's length would hurry its own longer one.
  //
  // Derived rather than a per-row column on purpose. A `minShow` cell in
  // callouts.csv would be a number to keep in step with the words beside it,
  // and it would go stale the first time anybody reworded a tip — which is the
  // one edit this file is built to make cheap.
  const chars = (calloutText(row, device) ?? '').length;
  const perSec = Math.max(1, c.readCharsPerSec ?? 12);
  const want = Math.max(c.minShow ?? 1.6, chars / perSec);
  // NEVER LONGER THAN THE ROW'S OWN HOLD, which is unchanged and is the MAX.
  // A floor above the hold would be a tip whose timer could not end it — see
  // the note this function has always carried.
  return Math.min(want, holdFor(row));
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
  endStep(false, false);
  dropFade();
}

/** Start of a run. The step ledger SURVIVES this; only the live tip doesn't. */
export function resetTutorialRun() {
  events.clear();
  endStep(false, false);
  dropFade();
  // ...and the silence endStep just armed goes with it. A run opens on a camera
  // move over empty water and the first tip already waits out `openDelay`; a
  // gap left over from the last run would be a second delay stacked on that
  // one, for a reason belonging to a run that is over.
  quiet = 0;
  spokePriority = -Infinity;
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

// ---------------------------------------------------------------------------
// THE QUIET BETWEEN TIPS
//
// Nothing used to separate them. A step ended and the next one that was ready
// took the band on the very next frame, which was survivable when the water
// half of the coach was one line and is not now: a player swimming through a
// bubble, a blue orb and a chunk gets three sentences back to back, each
// arriving before the last has been understood, and the whole set reads as one
// long unskippable wall.
//
// SO A TIP BUYS SILENCE AFTER IT. `gap` seconds during which the coach says
// nothing, counted from the moment the last line left the band.
//
// ...UNLESS THE NEXT ONE IS MORE IMPORTANT. An escalation always gets through,
// and that is what `spokeAt` is for rather than a second exemption knob: the
// gap blocks a step whose priority is at or below the one that just spoke, so
// running out of air (80) interrupts the quiet after a bubble tip (38) while a
// second orb tip (36) waits its turn. The coach will not chatter, but it will
// always escalate.
// ---------------------------------------------------------------------------
let quiet = 0;
let spokePriority = -Infinity;

/**
 * Take the live tip off the screen.
 *
 * `dissolve` false takes it off NOW — a dead seal, a run ending, a step
 * preempted by something louder. Those are not the tip finishing; they are the
 * screen being taken away from it, and a sentence eroding gently through the
 * game-over card would be the wrong thing happening at the wrong moment.
 *
 * `dissolve` true hands the row to the fade, which keeps it on its surface for
 * a further `CONFIG.tutorial.dissipate.seconds` while it is eaten away. The
 * step is already done by then: the ledger is written here, so a player who
 * dies mid-dissolve has still been taught the thing they answered.
 */
function endStep(markDone, dissolve = true) {
  const id = tutorialState.active;
  answered = false;
  subject = null;
  subjectGone = false;
  tutorialState.subjectMesh = null;
  if (!id) return;
  if (markDone) {
    doneIds.add(id);
    saveDone();
  }
  const row = CALLOUTS.get(id);
  // Armed on the way out whether or not the step was spent. A tip cut off by
  // dying still occupied the screen a moment ago, and the next line should not
  // land on the frame the last one vanished either way.
  //
  // COUNTED FROM HERE AND NOT FROM THE END OF THE DISSOLVE, deliberately: the
  // gap is about how quickly the coach speaks again, and the dissolve is the
  // last line still going. Stacking them would be a second and a half of empty
  // water between every pair of tips.
  quiet = Math.max(0, CONFIG.tutorial?.gap ?? 1.2);
  spokePriority = row?.priority ?? 0;
  tutorialState.active = null;

  const seconds = dissolve ? Math.max(0, CONFIG.tutorial?.dissipate?.seconds ?? 0.7) : 0;
  if (!row || seconds <= 0) {
    dropFade();
    clearCallout(row);
    return;
  }
  // Straight from one fade into another, if a tip somehow ends while the last
  // one is still leaving: the older row goes immediately rather than being
  // left pinned to a surface nothing is driving any more.
  if (fadeRow && fadeRow !== row) clearCallout(fadeRow);
  fadeRow = row;
  fadeLeft = seconds;
  tutorialState.fade = 0;
  // Still pinned, and this is the load-bearing half of the fade. The row is
  // sitting on its surface past whatever `hold` it has, and without the pin the
  // ager would take it away mid-dissolve — the text would simply cut out a
  // third of the way through being eaten, which reads as a dropped frame.
  pinCallout(row, true);
}

/** The dissolve, abandoned. The row goes now, wherever it had got to. */
function dropFade() {
  if (fadeRow) clearCallout(fadeRow);
  fadeRow = null;
  fadeLeft = 0;
  tutorialState.fade = 0;
  tutorialState.anchor = null;
}

// One frame of a tip leaving. Real time, like the drawing: a dissolve is not
// gameplay and should not slow down inside a hit-stop.
function advanceFade(dt) {
  if (!fadeRow) return;
  const seconds = Math.max(0.001, CONFIG.tutorial?.dissipate?.seconds ?? 0.7);
  fadeLeft -= dt;
  tutorialState.fade = Math.min(1, Math.max(0, 1 - fadeLeft / seconds));
  // Pinned every frame rather than once: a warning cannot take this surface
  // (nothing else draws on it) but a re-parsed table in dev hands out new row
  // objects, and re-asserting is cheaper than reasoning about that.
  pinCallout(fadeRow, true);
  if (fadeLeft <= 0) dropFade();
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
    if (tutorialState.active) endStep(false, false);
    dropFade();
    return;
  }
  if (!live) {
    events.clear();
    if (tutorialState.active) endStep(false, false);
    dropFade();
    return;
  }

  advanceFade(dt);

  const activeId = tutorialState.active;
  if (activeId) {
    const step = STEPS[activeId];
    const row = CALLOUTS.get(activeId);
    const slot = bandStates[row?.anchor ?? 'band'];
    // WHERE IT IS BEING SAID, re-asked every frame. A bubble rises, a chunk
    // sinks, a turtle swims — a tip that latched a position when it started
    // would drift off its own subject within a second, which is worse than the
    // band it replaced: at least the band never claimed to be pointing at
    // anything in particular.
    if (subject) followSubject(ctx);

    // ANSWERED IS LATCHED, CLEARING IS NOT. The two are separate because a
    // player can answer a tip on the frame it appears — the control tips are
    // handed out one per input, and a confident player has the next thumb down
    // already. Remembering the answer means the tip can still come off the
    // moment it has been read, without needing the player to hold the stick
    // there until the floor is up.
    if (!answered && step.done(ctx, events, doneIds)) answered = true;

    const readable = calloutAge(row) >= legibleFor(row, ctx.device);
    if (row?.subject) {
      // A WORLD TIP HAS NO CLOCK — see the header. It is pinned for as long as
      // it is up, and what ends it is the subject: answered, gone, or the
      // moment it described no longer being true.
      pinCallout(row, true);
      // `ready` is re-asked as the LAPSE test rather than a second condition
      // written out here. The two would say the same thing today and would not
      // stay saying it: `ready` is where each step already decides whether its
      // moment exists, and a duplicate of that in the clearing path is how a
      // reworked step ends up with a tip that can never leave.
      const lapsed = subjectGone || !step.ready(ctx, events, doneIds);
      // ...BUT NEVER BEFORE IT CAN BE READ, and that is why the anchor above is
      // the LAST position rather than the live one. A bubble popped on the
      // frame the tip appeared leaves the sentence hanging in the water where
      // the bubble was, for exactly as long as it takes to read, and then it
      // dissolves.
      if ((answered || lapsed) && readable) endStep(true);
    } else if (answered && readable) {
      // Read, and answered. Off the band now rather than at the end of its
      // hold — the tip has been obeyed, and holding it there would be the game
      // arguing with something the player has already done.
      endStep(true);
    } else if (slot.row !== row) {
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
    const current = CALLOUTS.get(tutorialState.active);
    // Preemption is between lines that share a surface. A world tip and a band
    // tip do not, so the louder one simply takes its own place and both are up
    // — which is the right answer for the case this rule exists for: "swim up
    // for air" is spoken at the surface, and it should not have to knock a
    // label off a bubble to be read.
    if (bestReady(ctx, current?.priority ?? 0, current?.anchor)) endStep(false, false);
  }

  if (!tutorialState.active) {
    // The quiet only runs while the band is FREE. Counted here rather than at
    // the top of the frame so a long tip does not spend its own hold burning
    // down the silence that is meant to follow it — otherwise a 7-second line
    // arrives, and the next one lands the instant it leaves.
    if (quiet > 0) quiet = Math.max(0, quiet - dt);

    const next = bestReady(ctx, -Infinity);
    // Held back unless it outranks the line that just spoke — see the note on
    // `quiet`. A step refused here is NOT spent: it stays ready and is offered
    // again the moment the silence is up, which is the same contract
    // pushCallout's refusal has always had.
    const escalating = (next?.row?.priority ?? 0) > spokePriority;
    if (quiet > 0 && !escalating) {
      events.clear();
      return;
    }
    // `pushCallout` has the final say, and its answer is respected: a step that
    // could not be shown is not started, so it stays available for the next
    // frame rather than being spent on a line nobody saw.
    if (next && startStep(next, ctx)) tutorialState.active = next.id;
  }
  events.clear();
}

// ---------------------------------------------------------------------------
// THE SUBJECT — the one object a tip is about
//
// ONE SPECIFIC THING, CHOSEN ONCE, and that is the whole difference between a
// label and a search. "The nearest bubble" re-asked every frame is not one
// bubble: two rise past each other, the answer swaps, and the sentence jumps
// across the screen to a different orb without anything having happened. The
// player reads that as the tip being about whatever is nearest, which is not a
// thing the game is trying to teach.
//
// SO THE FRAME LOOP HANDS OVER A REFERENCE, not a position. It is opaque here —
// whatever main.js chose, an orb, a chunk, a creature, or the little standing
// object a PLACE gets — and it is only ever read back through ctx.subjectAt,
// which answers null once it is gone. That null is what ends the tip.
//
// A PLACE HAS A SUBJECT TOO, and it is not a special case anywhere in this
// file: "the waterline above the seal" is a position that answers every frame
// and never dies. The alternative — a branch here for `surface` and `seabed` —
// would be this file knowing about the arena, which is the one thing it has
// never had to.
// ---------------------------------------------------------------------------

/**
 * Begin a step: take the surface, and lock onto what the line is about.
 *
 * Returns false if it could not start, which leaves the step AVAILABLE rather
 * than spent — the same contract pushCallout's refusal has always had. Both
 * refusals happen: the surface can be busy, and a subject can be swallowed
 * between the frame `ready` saw it and this one.
 */
function startStep(next, ctx) {
  const { row, id } = next;
  let handle = null;
  if (row.subject) {
    handle = ctx.takeSubject?.(row.subject, id) ?? null;
    // Nothing to stand beside. NOT a fallback to the band: a line about an orb,
    // read in the middle of the screen, with no orb anywhere, is the exact
    // confusion this change was made to remove — and the step is offered again
    // on the next frame anyway, by which time there usually is one.
    if (!handle) return false;
  }
  if (!pushCallout(row)) return false;
  subject = handle;
  subjectGone = false;
  tutorialState.anchor = null;
  tutorialState.subjectMesh = null;
  if (subject) followSubject(ctx);
  return true;
}

// Where the subject is this frame, or the last place it was. See tutorialState
// .anchor for why those are the same field.
function followSubject(ctx) {
  const at = ctx.subjectAt?.(subject) ?? null;
  if (!at) {
    // GONE. The anchor is left exactly where it was — the words stay in the
    // water the bubble was in — but the object reference is dropped on the same
    // frame, because something is lighting it up and a light left burning on a
    // collected pickup would be a glow with nothing under it.
    subjectGone = true;
    tutorialState.subjectMesh = null;
    return;
  }
  tutorialState.anchor = { x: at.x, y: at.y };
  tutorialState.subjectMesh = at.mesh ?? null;
}

// The best step that is ready, not yet done, and louder than `minPriority`.
// One function for both "what should be talking" and "is anything allowed to
// interrupt", because they are the same question with a different floor.
//
// `anchor`, when given, narrows it to one surface — which is only ever asked
// by the preemption test, because taking a line down to make room for another
// only makes sense between two lines wanting the same room.
function bestReady(ctx, minPriority, anchor = null) {
  let best = null;
  for (const id of COACH_IDS) {
    if (doneIds.has(id)) continue;
    const row = CALLOUTS.get(id);
    if (!row || row.kind !== 'coach') continue;
    if (anchor && row.anchor !== anchor) continue;
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
