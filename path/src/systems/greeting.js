import { CONFIG } from '../config.js';
import greetingsCsv from '../greetings.csv?raw';
import { parseGreetingCsv, pickGreeting, expandLastRun } from '../greetingTable.js';
import { causesOfDeath, primaryCause } from '../deathCauses.js';
import { lastRun, noteRunStart } from './lastRun.js';
import {
  pushCallout, clearCallout, pinCallout, calloutAge, bandStates, holdFor,
} from './callouts.js';

// ---------------------------------------------------------------------------
// HELLO — one line on the band at the top of every run, with the player's name
// in it, and on a run that follows a death it can name what killed them.
//
// THE COACH SAYS SOMETHING ON A FIRST RUN AND NOTHING EVER AGAIN. That is the
// correct behaviour for a tip (systems/tutorial.js: a step is spent once per
// browser and the set then goes quiet forever) and it leaves the game with no
// voice at all after the first afternoon — the water opens, the camera moves,
// and nothing acknowledges that a person is there. This is the one line that
// keeps speaking: not an instruction, not a warning, just the game saying the
// player's name at the start of a run.
//
// WHAT IT SAYS IS A ROLL, NOT A STRING. greetings.csv is a weighted pool with
// the same shape quips.csv has, and the pick is narrowed by two facts about
// the run BEFORE this one (systems/lastRun.js): whether there was one, and
// what ended it. So a first run is welcomed, a second is greeted as a return,
// and a run that follows a death can comment on it — "Last time it was a
// crab, {player}." The words and the tagging are the CSV's; the two chips are
// `{player}` (systems/playerName.js, spent by the band on its way to the
// screen) and `{cause}` (deathCauses.js, spent HERE, once, when the line is
// rolled — the last run's cause cannot change during this one, and re-deriving
// it sixty times a second to answer the same question would be absurd).
//
// IT IS A SYNTHETIC CALLOUT ROW rather than an entry in callouts.csv, because
// the two files answer different questions: a callouts.csv row is a line of
// text joined to a condition in code by its id, and this line's TEXT is a
// different string every run. What it borrows from that system is everything
// else — the band's one-at-a-time arbitration, the pin, the coach voice, the
// dissolve — by building the row the band expects and handing it over. See
// pushCallout.
//
// IT OUTRANKS THE TIPS ON PURPOSE, and that is what makes the two systems
// cooperate rather than interrupt each other. The first control tip is offered
// at CONFIG.tutorial.openDelay; if the greeting is still up, pushCallout
// refuses the tip and the coach's own contract does the rest — a step that
// could not be shown is NOT spent, so it simply arrives the moment the hello
// leaves. Without the priority it would be the other way round: the tip would
// take the band and cut the greeting off mid-word.
//
// AND IT LEAVES THE WAY A TIP DOES. Pinned while it is up (so nothing ages it
// out from under the dissolve), then eroded over CONFIG.tutorial.dissipate —
// the same departure, because it is the same voice in the same place and a
// hello that snapped out of existence while a tip melted would read as two
// different systems. `greetingState.fade` is what the drawing reads; see the
// note in main.js about which fade the band is on.
//
// NOTHING IN HERE TOUCHES THE SCREEN, which is what lets a harness play a
// hundred runs through it in a millisecond — see npm run test:greeting.
// ---------------------------------------------------------------------------

export const GREETINGS = parseGreetingCsv(greetingsCsv);

/** How far through leaving the line is: 0 whole, 1 gone. Read by the drawing. */
export const greetingState = { fade: 0 };

// The row on the band this run, or null when there is nothing to say. Built
// fresh per run because its text is.
let row = null;
// 'idle' nothing to say | 'wait' counting down to it | 'up' on the band
// | 'leaving' dissolving | 'done' said and gone
let phase = 'idle';
let wait = 0;
let fadeLeft = 0;

function cfg() {
  return CONFIG.greeting ?? {};
}

/**
 * How long this line stays, in seconds — its own floor, stretched by how long
 * it takes to read, capped by its own ceiling.
 *
 * The reading speed is the coach's (CONFIG.tutorial.readCharsPerSec) rather
 * than a second number of its own. There is one answer to "how fast is a line
 * of text read while something is trying to eat you", and two knobs for it
 * would be two answers that drift — see legibleFor in systems/tutorial.js,
 * which is the same calculation for the same reason.
 */
function holdSeconds(text) {
  const c = cfg();
  const perSec = Math.max(1, CONFIG.tutorial?.readCharsPerSec ?? 12);
  const floor = Math.max(0.2, c.hold ?? 2.6);
  const ceiling = Math.max(floor, c.maxHold ?? 5);
  return Math.min(ceiling, Math.max(floor, String(text).length / perSec));
}

// The shape systems/callouts.js expects. `kind: 'coach'` is not a label — it
// decides the voice (ui/callout.js draws a coach line in the tip's colour and
// type) and it is what makes the line outrank a warning, which is right for
// the two seconds at the top of a run when nothing has gone wrong yet.
function buildRow(text) {
  return {
    id: 'greeting',
    kind: 'coach',
    anchor: 'band',
    text,
    // No per-device wordings and no device list: a hello reads identically in
    // every pair of hands, which is the same reason `{player}` needs no
    // `textPad` (see calloutTable.js).
    deviceText: {},
    devices: null,
    priority: cfg().priority ?? 100,
    hold: holdSeconds(text),
    repeat: null,
    subject: null,
  };
}

/**
 * Start of a run: roll this run's line and arm it.
 *
 * `random` is injectable for the same reason pickQuip's is: the pool's
 * narrowing is the whole behaviour here — first run against returning, a
 * cause-tagged line against the general ones — and none of it is checkable
 * against a roll nobody controls. The game passes nothing.
 *
 * THE ROLL HAPPENS HERE, at the start, rather than when the line is spoken a
 * second later. It has to: noteRunStart is what makes this run count as "a run
 * that happened" for the NEXT one, and a player who quits during the opening
 * camera move must still be a returning player afterwards.
 */
export function resetGreetingRun(random = Math.random) {
  end();
  row = null;
  phase = 'idle';

  // Read before it is written — see noteRunStart, which returns the record as
  // it stood and then bumps it.
  const before = lastRun();
  const returning = before.runs > 0;
  // TWO ANSWERS FROM ONE SOURCE STRING, and both are needed: the SET is what
  // the `causes` column is matched against (a megalodon boss is a shark death
  // and a boss death, and a line written for either should be allowed to
  // fire), while the ONE cause is what the `{cause}` chip is worded from. See
  // deathCauses.js, where that split is the whole point of having both.
  const causes = returning ? causesOfDeath(before.source) : null;
  const cause = returning ? primaryCause(before.source) : null;
  // WHO died, as well as what killed them. A different character from the seal
  // about to swim — death is permanent (systems/nameLedger.js), so the name in
  // the record and the name on the HUD are two people, and a line naming both
  // is naming two people. Null on a run that followed no death, and on any
  // death filed before this field existed; `{departed}` rows are gated on it.
  const departed = returning ? before.name : null;
  const pick = cfg().enabled === false ? null : pickGreeting(GREETINGS, random, {
    returning,
    causes,
    departed,
    avoid: before.greeting,
  });

  // COUNTED EVEN WITH THE GREETING TURNED OFF, and even when the table had
  // nothing to say. The record is about RUNS — see systems/lastRun.js — and a
  // player who switches the hellos back on after an evening of playing with
  // them off is a returning player, not a new one. This call is also what
  // clears the last run's death, which has to happen whether or not anybody is
  // going to mention it.
  noteRunStart(pick?.id ?? null);
  if (!pick) return;

  // `{cause}` and `{departed}` now, `{player}` never. The two spent here are
  // facts about a run that is already OVER and cannot change during this one.
  // The name is spent on the way to the screen every frame (fillBindings in
  // systems/callouts.js) so that a player who renames themselves mid-run is
  // called by it immediately — which is also exactly why the dead seal's name
  // cannot go through that path: it would follow the rename and put the living
  // seal's name on the headstone line.
  row = buildRow(expandLastRun(pick.text, { cause: cause?.label, departed }));
  phase = 'wait';
  wait = Math.max(0, cfg().delay ?? 0.8);
}

/**
 * One frame of the greeting. Real time, like the band it sits on.
 *
 * `live` false — a menu, a paused game, a dead seal — takes the line off and
 * spends it. Deliberately unlike a tip, which is put back in the queue when it
 * is interrupted: a tip is a lesson that has to land eventually, and a hello is
 * a thing said at the top of a run. Held over and delivered two minutes later,
 * over the corpse of the fight it opened, it would not be a greeting at all.
 */
export function updateGreeting(dt, live = true) {
  if (phase === 'idle' || phase === 'done') return;
  if (!live) {
    end();
    return;
  }

  if (phase === 'wait') {
    wait -= dt;
    if (wait > 0) return;
    if (pushCallout(row)) {
      phase = 'up';
      pinCallout(row, true);
      return;
    }
    // The band was busy. Only reachable with `priority` tuned under a coach
    // row's, and it is not worth much patience: a hello that arrives late is
    // not a hello. Tried again on the following frames until the window is up,
    // then dropped — never carried into the middle of the run.
    if (wait <= -(cfg().patience ?? 2)) end();
    return;
  }

  // Pinned every frame rather than once, exactly as the coach does it: a
  // re-parsed table hands out new row objects in dev, and re-asserting is
  // cheaper than reasoning about that.
  if (phase === 'up') {
    if (bandStates.band.row !== row) {
      // Something outranked it. Nothing in the shipping table can, and if
      // something ever does, the line is gone rather than half-shown.
      end();
      return;
    }
    pinCallout(row, true);
    if (calloutAge(row) >= holdFor(row)) {
      phase = 'leaving';
      fadeLeft = Math.max(0, CONFIG.tutorial?.dissipate?.seconds ?? 0.7);
      greetingState.fade = 0;
      if (fadeLeft <= 0) end();
    }
    return;
  }

  // Leaving. The row stays pinned to the band for the whole dissolve — without
  // the pin the ager would take it away mid-erode, which on screen is a line
  // that does not dissipate at all, it just disappears.
  if (bandStates.band.row !== row) {
    end();
    return;
  }
  pinCallout(row, true);
  const seconds = Math.max(0.001, CONFIG.tutorial?.dissipate?.seconds ?? 0.7);
  fadeLeft -= dt;
  greetingState.fade = Math.min(1, Math.max(0, 1 - fadeLeft / seconds));
  if (fadeLeft <= 0) end();
}

/** Is the greeting the line currently on the band? */
export function greetingOnBand() {
  return !!row && bandStates.band.row === row;
}

/** What is being said this run, or null. For the harness and for the panel. */
export function greetingLine() {
  return row?.text ?? null;
}

// Off the band, fade dropped, SPENT. However this run's hello ended — read
// through, cut off by a menu, outranked — it is over and cannot come back,
// which is the whole difference between this and a tip (see the note on `live`
// above).
function end() {
  if (row) clearCallout(row);
  greetingState.fade = 0;
  fadeLeft = 0;
  if (row) phase = 'done';
}
