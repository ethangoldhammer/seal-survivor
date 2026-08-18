import { CONFIG } from '../config.js';
import calloutsCsv from '../callouts.csv?raw';
import {
  parseCalloutCsv, calloutsOfKind, checkCalloutIds, calloutText, calloutOnDevice,
  CALLOUT_ANCHORS,
} from '../calloutTable.js';
import { settings, keyLabel } from './settings.js';
import { playerName } from './playerName.js';
import { shoulderLabel } from '../devices.js';

// ---------------------------------------------------------------------------
// THE BAND — one line of text across the middle of the screen, and the rules
// about which line gets to be there.
//
// ONE AT A TIME PER SURFACE, ON PURPOSE. Everything that wants to shout wants
// to shout at the same moment: you are out of air BECAUSE you stayed down
// chasing chum, and the reason your health is low is the boss that just
// arrived. A stack of four bands is four things to read at the exact moment
// there is no time to read one, so a surface holds a single line and the losers
// are DROPPED rather than queued — a warning that arrives late is worse than
// one that never came, because by the time it lands it is describing a crisis
// you already resolved.
//
// THERE ARE TWO SURFACES, and that is not a loophole in the rule above. The
// band is the middle of the screen; the `player` anchor is a small line riding
// the boost ring. They can be up together because they are different sizes in
// different places saying different KINDS of thing — an emergency, and a gauge
// reading — and "Boost Empty!" competing with "Warning!" for the middle of the
// screen would mean the meter could never speak during the fight where running
// it dry actually costs you something. Within either surface it is still
// strictly one line: the ring's two lines ("STRIKE NOW!" and "Boost Empty!")
// take turns on the one slot like everything else does.
//
// PRIORITY DECIDES, and coach lines outrank every warning. That looks backwards
// — surely "Health low!" matters more than a tip? — but a coach line only ever
// exists on a player's first run (systems/tutorial.js), and on a first run the
// tip IS the fix for the warning: "Swim up for air" is what "Oxygen low!"
// wants you to know and does not say. After that first run they can never
// collide again, because there are no coach lines left to fire.
//
// WHAT LIVES WHERE. The words, the ordering and the timings are callouts.csv.
// The look and the motion are CONFIG.callouts and CONFIG.textMotion.warn (the
// Text panel, Y). This file owns only the arbitration and the clock, which is
// what makes it testable without a browser — see npm run test:callouts.
// ---------------------------------------------------------------------------

export const CALLOUTS = parseCalloutCsv(calloutsCsv);

/** Every warning the game knows how to fire. The join to callouts.csv. */
export const WARN_IDS = ['boss', 'health', 'oxygen', 'boost', 'strikeNow'];

// --- {token}s ---------------------------------------------------------------
// A tip may name a control as `{strike}` or `{bumper}`, which becomes whatever
// that control is called on the hardware in front of the player. Written into
// the CSV as a token rather than as the words "Space" or "LB" for the same
// reason an upgrade card's numbers are: the moment somebody rebinds a key or
// plugs in a different pad, a hand-typed name is a lie, and it is a lie in the
// one sentence whose entire job is to say which button to press.
//
// Three sources, and the split is about who KNOWS. Key bindings are read
// straight from the player's settings here. Anything about the physical
// hardware — what this pad calls its shoulders — is handed in by the frame
// loop, because that lives in input.js and this file has no devices in it on
// purpose. And `{player}` comes from systems/playerName.js, which owns the one
// name every text table in the game spends.
//
// Filled on the way to the screen rather than at parse time: bindings change
// while the game is running, pads are unplugged, a name is typed mid-session,
// and the table is parsed once.

const BINDING_TOKEN = /\{(\w+)\}/g;

// TOKENS THAT ARE NOT A KEY. Everything else in a `{token}` resolves against
// the player's bindings, and the boot check below warns about a row that names
// one without also having words for a pad. These two do not: `{bumper}` is
// hardware and answers itself on every device, `{player}` is a name.
//
// Kept as a set rather than tested inline because it is the SAME question in
// two places — what fillBindings resolves specially, and what the check is
// allowed to ignore — and the failure of letting those disagree is a warning
// nobody can act on ("this row names a key binding" about a row that says
// somebody's name) or, worse, a real missing textPad going unreported.
const NON_KEY_TOKENS = new Set(['bumper', 'player']);

// What a hardware token says when nobody has told us about the hardware. Not a
// safety net for a caller that forgot — it is the honest answer for a pad the
// browser will not name, and it is the SAME answer, because shoulderLabel gives
// this to any controller it does not recognise. A tip that read
// "{bumper} to charge a strike" would be a brace on screen in the one sentence
// a first-time player is reading most carefully.
const DEFAULT_TOKENS = { bumper: shoulderLabel(null) };

/**
 * Does this text name a KEY BINDING, as opposed to merely containing a token?
 *
 * The question the boot check below actually wants, and it used to ask a
 * broader one (`/\{\w+\}/`) that could not tell "press {strike}" from "nice
 * one, {player}". That was harmless while every token in the file was a key —
 * and became wrong the moment one wasn't.
 */
function namesKey(text) {
  BINDING_TOKEN.lastIndex = 0;
  for (const m of String(text ?? '').matchAll(BINDING_TOKEN)) {
    if (!NON_KEY_TOKENS.has(m[1])) return true;
  }
  return false;
}

/**
 * A row's words, resolved, for something that is not the band.
 *
 * The Text panel's specimen is the caller: it sets the longest line in the
 * table to show what the role has to survive, and a raw `{strike}` in there
 * would be both wrong on screen and the wrong LENGTH — eight characters
 * standing in for the five of "Space".
 *
 * Exported rather than duplicated because the resolution has a real rule in it
 * (hardware beats bindings, unknown tokens stay visible) and a second copy in a
 * panel would be a second answer to "what does this line say".
 */
export function resolveCalloutText(row, device, tokens = {}) {
  return fillBindings(calloutText(row, device) ?? '', tokens);
}

function fillBindings(text, tokens = {}) {
  if (!text.includes('{')) return text;
  return text.replace(BINDING_TOKEN, (whole, name) => {
    // The player's own name, from the one module that owns it. First, because
    // it is the only token whose value the player typed — a binding called
    // `player` would be a rebind quietly renaming somebody.
    if (name === 'player') return playerName();
    // The hardware words win over a key binding of the same name. Nothing
    // collides today; if something ever does, the thing actually in the
    // player's hands is the better answer.
    if (tokens[name] ?? DEFAULT_TOKENS[name]) return tokens[name] ?? DEFAULT_TOKENS[name];
    const key = settings.controls?.keys?.[name];
    // An unknown token is left standing as `{whatever}`. Loud on purpose: it
    // is a typo in a spreadsheet, and the alternative — dropping it — is a
    // sentence with a hole in it that reads like ordinary bad writing.
    return key ? keyLabel(key) : whole;
  });
}

/**
 * A key token is fine in `text` and a bug on a device with no keyboard, so a
 * row that uses one has to say something else to the other two. Checked at
 * boot, where the table is: the failure it catches — a phone told to press
 * Space — is invisible to whoever is editing the CSV on a laptop.
 *
 * Called at module scope, and exported so the test can drive it on a table of
 * its own rather than on the shipping one.
 */
export function checkCalloutBindings(table, warn = console.warn) {
  for (const row of table.values()) {
    if (!namesKey(row.text)) continue;
    for (const [device, column] of [['touch', 'textTouch'], ['pad', 'textPad']]) {
      if (row.deviceText?.[device]) continue;
      // A row that does not exist on that device has nothing to answer for —
      // a kbm-only line is entitled to name a key and say nothing else.
      if (!calloutOnDevice(row, device)) continue;
      warn(
        `[callouts] "${row.id}" names a key binding but has no ${column} — a ${device} ` +
          `player will be told to press a key they do not have.`,
      );
    }
  }
}

checkCalloutBindings(CALLOUTS);

export const WARN_ROWS = calloutsOfKind(CALLOUTS, 'warn');

/**
 * What is on each surface right now: anchor -> { row, age }. `row` is the
 * callouts.csv row (null for an empty surface) and `age` is seconds since it
 * last popped — the UI needs both, and nothing outside this file writes either.
 */
export const bandStates = Object.fromEntries(
  // `pinned` is the one flag that is not about arbitration: a pinned line has
  // no clock at all and stays until the thing that pinned it lets go. Only the
  // world anchor's tips ever use it — see pinCallout.
  CALLOUT_ANCHORS.map((a) => [a, { row: null, age: 0, pinned: false }]),
);

/** The middle-of-the-screen surface, which is what most callers mean. */
export const bandState = bandStates.band;

/**
 * How long the row showing on `row`'s own surface has been up.
 *
 * The coach used to read `bandState.age` directly, which was correct while
 * every tip was on the band and silently wrong the moment they were not: a
 * world-anchored tip would have been timed against whatever warning happened to
 * be in the middle of the screen, so its legibility floor would be satisfied by
 * an unrelated line having been up long enough.
 */
export function calloutAge(row) {
  const slot = slotFor(row);
  return slot.row === row ? slot.age : 0;
}

function slotFor(row) {
  return bandStates[row?.anchor] ?? bandStates.band;
}

// Per-warning memory: was its condition true last frame, and how long since it
// last spoke. Keyed by id rather than held on the row, so a re-parsed table (a
// CSV edit in dev) doesn't drag stale timers along with it.
const warnMemory = new Map();

function memoryFor(id) {
  let m = warnMemory.get(id);
  if (!m) {
    m = { was: false, since: Infinity };
    warnMemory.set(id, m);
  }
  return m;
}

/** Start of a run. These are per-run: nothing said in the last one is news. */
export function resetCallouts() {
  for (const slot of Object.values(bandStates)) {
    slot.row = null;
    slot.age = 0;
    slot.pinned = false;
  }
  warnMemory.clear();
}

/**
 * HOLD THIS LINE UNTIL I SAY OTHERWISE — or stop holding it.
 *
 * A tip that rides an object cannot be on a timer. Its subject is the clock:
 * the bubble is there until it is popped, the pile is on the seabed until it
 * has been cleared, and a sentence that expired six seconds in would leave the
 * player looking at a thing that no longer has a label while the condition it
 * described is still exactly as true as it was.
 *
 * So `hold` stops meaning "how long this is up" for these rows and goes back to
 * meaning what it means everywhere else — the most a line may take of somebody
 * — only once the pin is released and the tip is on its way out.
 *
 * DELIBERATELY NOT A ROW COLUMN. Whether a line can be pinned is a property of
 * the row (does it have a subject), but whether it IS pinned right now is a
 * property of the world (is that subject still in the water), and only the
 * coach knows the second one. A `pinned` cell in the CSV would be a tip that
 * could hang on screen forever because the orb it named had already been eaten.
 */
export function pinCallout(row, on = true) {
  const slot = slotFor(row);
  if (slot.row !== row) return;
  slot.pinned = !!on;
}

/** Seconds this row stays up: its own `hold`, or the shared default. */
export function holdFor(row) {
  return Math.max(0.1, row?.hold ?? CONFIG.callouts?.hold ?? 1.6);
}

/**
 * Ask for the row's own surface. Returns true if it got it. A row only ever
 * competes with rows on the SAME anchor — the boost line has no opinion about
 * what the band is doing and vice versa.
 *
 * The same row asking again RE-POPS rather than being ignored: age going back
 * to zero replays the arrival curve, which is the whole of the feedback for
 * "still true, and I am telling you again". It is also what makes the repeat
 * timer visible at all — without it a warning that re-fired while still on
 * screen would produce no change whatsoever.
 */
export function pushCallout(row) {
  if (!row) return false;
  const slot = slotFor(row);
  const live = slot.row;
  if (live === row) {
    slot.age = 0;
    return true;
  }
  if (live && !outranks(row, live)) return false;
  slot.row = row;
  slot.age = 0;
  // A new line arrives unpinned however the last one left. Otherwise a tip
  // whose subject vanished on the same frame as the next tip started would hand
  // its pin to a line that never asked for one — which is a callout with no
  // clock and nothing holding it, i.e. one that never leaves.
  slot.pinned = false;
  return true;
}

// Coach over warn, then priority. Ties go to the incoming row — the newer of
// two equally important things is the one that is still happening.
function outranks(row, live) {
  if (row.kind !== live.kind) return row.kind === 'coach';
  return row.priority >= live.priority;
}

/** Take a row off its surface. A no-op unless that row is the one showing. */
export function clearCallout(row) {
  if (!row) return;
  const slot = slotFor(row);
  if (slot.row !== row) return;
  slot.row = null;
  slot.age = 0;
  slot.pinned = false;
}

/**
 * One frame of the band.
 *
 * `conditions` is a plain object of warn id -> boolean, assembled by the frame
 * loop from the things it already has in hand (the seal's air, its health, the
 * charge meter, the boss clock). Passing the answers in rather than reaching
 * for them is what keeps this file free of imports from entities/ and lets a
 * harness drive a whole run's worth of crossings in a millisecond.
 *
 * `live` false — a menu is up, the run is over, the game is paused — ages the
 * band out but fires nothing new. The distinction matters: a warning must not
 * be able to appear over the score card, and one already on screen when the
 * run ended should leave rather than freeze there.
 */
export function updateCallouts(dt, conditions = {}, live = true) {
  if (CONFIG.callouts?.enabled === false) {
    for (const slot of Object.values(bandStates)) slot.row = null;
    return;
  }

  for (const row of WARN_ROWS) {
    const m = memoryFor(row.id);
    m.since += dt;
    const on = live && !!conditions[row.id];

    if (!on) {
      // The condition cleared. `since` is wound back to Infinity so the NEXT
      // crossing speaks on the frame it happens rather than waiting out a
      // repeat timer it has nothing to do with — the gap between two separate
      // scares is not the thing `repeat` is measuring.
      if (m.was) m.since = Infinity;
      m.was = false;
      continue;
    }

    // Rising edge always speaks. Holding speaks again only if the row asked to
    // repeat, and only once its own gap has passed.
    const crossed = !m.was;
    const nagging = row.repeat != null && m.since >= row.repeat;
    if (crossed || nagging) {
      if (pushCallout(row)) m.since = 0;
      // Not `else m.since = 0`: a row that lost the band did NOT speak, and
      // pretending it did would start its repeat gap from a line nobody saw.
      // Left alone, it tries again next frame and takes the band the moment
      // the louder thing above it is done.
    }
    m.was = true;
  }

  for (const slot of Object.values(bandStates)) {
    if (!slot.row) continue;
    slot.age += dt;
    // AGE STILL RUNS ON A PINNED LINE, only the expiry is skipped. The age is
    // what the legibility floor is measured against (see legibleFor in
    // tutorial.js), and a pinned tip that froze its own clock at zero could
    // never satisfy that floor — so the moment it was unpinned it would be
    // required to stay for its full reading time all over again.
    if (slot.pinned) continue;
    if (slot.age >= holdFor(slot.row)) {
      slot.row = null;
      slot.age = 0;
    }
  }
}

/**
 * What to draw on one surface: { text, arrow, age, hold, kind } or null.
 *
 * Read once per frame per anchor by ui/callout.js. A shape of its own rather
 * than the row itself so the UI never has a reference it could hold across a
 * re-parse.
 *
 * `device` is one of DEVICES and decides the WORDING (see calloutTable.js), and
 * `tokens` names the hardware for a line that asks (see inputTokens). Both
 * arrive as arguments rather than being read from input.js here so this file
 * stays a state machine with no devices in it — the frame loop knows what is in
 * the player's hands and is the one place that has to.
 */
export function activeCallout(anchor = 'band', device = undefined, tokens = undefined) {
  const slot = bandStates[anchor];
  const row = slot?.row;
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    anchor: row.anchor,
    // Resolved every frame rather than latched when the line went up, so a
    // player who puts the keyboard down and picks up a pad mid-tip is reading
    // the right button by the next frame. The alternative — deciding once, at
    // push time — sounds steadier and is wrong in the case that matters: the
    // first tip appears seconds into a run, which is often BEFORE the player
    // has touched anything at all.
    text: fillBindings(calloutText(row, device), tokens),
    // What this line is ABOUT: where it parks itself, and what the arrow points
    // at when the two are too far apart to read together. See calloutTable.js.
    subject: row.subject,
    age: slot.age,
    hold: holdFor(row),
    // Which motion block and which text role this line wears. Decided here,
    // once, rather than in the UI: it is a property of the callout, and the two
    // places that need it (the drawing and the Text panel's specimen) must
    // never be able to disagree about which curve a line is on.
    motion: motionKeyFor(row),
  };
}

// A row's motion block, which is also its text role. The lines on the ring have
// their own because they are their own size in their own place; everything else
// is either a warning or a tip.
//
// The world anchor deliberately shares the `coach` role rather than taking one
// of its own. It is the same voice saying the same kind of thing and it should
// be the same type — what changed is where the sentence stands, and a tip that
// also changed size and colour on its way to the bubble would read as a
// different system talking.
// ONE ROW SPEAKS IN A VOICE ITS ANCHOR DOES NOT IMPLY. "STRIKE NOW!" shares
// the ring's slot with "Boost Empty!" and is not the same kind of message at
// all: the gauge is reporting a fact you can act on whenever, and this is the
// FOOD CHAIN asking for an input inside a tenth of a second. It wears the
// chain's own type and the chain's own live colour (ui/callout.js), so it
// belongs to that family rather than to the instrument it is standing on.
//
// Written as a table rather than as an `id ===` in the branch below so the
// exception is visible next to the rule it breaks, and so a second one is a
// line rather than a nested ternary.
const VOICE_BY_ID = { strikeNow: 'strikeNow' };

function motionKeyFor(row) {
  if (VOICE_BY_ID[row.id]) return VOICE_BY_ID[row.id];
  if (row.anchor === 'player') return 'boostWarn';
  return row.kind === 'coach' ? 'coach' : 'warn';
}

/**
 * Boot-time join check, called once from main.js with the coach's own step
 * list. Split out rather than run on import so the ids come from the two
 * systems that actually own them instead of being written down twice here.
 */
export function checkCallouts(coachIds, warn = console.warn) {
  checkCalloutIds(CALLOUTS, WARN_IDS, coachIds, warn);
}
