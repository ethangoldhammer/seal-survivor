// ============================================================================
// BINDING TEXT — `{strike}` on screen becomes whatever strike is bound to.
//
// A tip may name a control as `{clap}` or `{bumper}`, which becomes whatever
// that control is called on the hardware in front of the player. Written into
// a CSV as a token rather than as the words "Space" or "LB" for the same
// reason an upgrade card's numbers are measured: the moment somebody rebinds a
// key or plugs in a different pad, a hand-typed name is a lie, and it is a lie
// in the one sentence whose entire job is to say which button to press.
//
// Three sources, and the split is about who KNOWS. Key bindings are read
// straight from the player's settings here. Anything about the physical
// hardware — what this pad calls its shoulders — is handed in by the caller,
// because that lives in input.js and this file has no devices in it on
// purpose. And `{player}` comes from systems/playerName.js, which owns the one
// name every text table in the game spends.
//
// Filled on the way to the screen rather than at parse time: bindings change
// while the game is running, pads are unplugged, a name is typed mid-session,
// and a table is parsed once.
//
// THIS WAS INSIDE systems/callouts.js and moved out when the loading screen's
// quick tips wanted the same tokens (see ui/loading.js). Not a refactor for
// tidiness: a second copy of the resolver is a second answer to "what does
// this line say", and the copy that drifts is always the one naming a button.
// ============================================================================

import { settings, keyLabel } from './settings.js';
import { playerName } from './playerName.js';
import { shoulderLabel, faceLeftLabel } from '../devices.js';
import { rowOnDevice, textForDevice, DEVICE_TEXT_COLUMN } from '../deviceText.js';
import { DEVICES } from '../devices.js';

export const BINDING_TOKEN = /\{(\w+)\}/g;

// TOKENS THAT ARE NOT A KEY. Everything else in a `{token}` resolves against
// the player's bindings, and the boot check below warns about a row that names
// one without also having words for a pad. These do not: `{bumper}` and
// `{faceLeft}` are hardware and answer themselves on every device, `{player}`
// is a name.
//
// Kept as a set rather than tested inline because it is the SAME question in
// two places — what fillBindings resolves specially, and what the check is
// allowed to ignore — and the failure of letting those disagree is a warning
// nobody can act on ("this row names a key binding" about a row that says
// somebody's name) or, worse, a real missing textPad going unreported.
const NON_KEY_TOKENS = new Set(['bumper', 'faceLeft', 'player']);

// What a hardware token says when nobody has told us about the hardware. Not a
// safety net for a caller that forgot — it is the honest answer for a pad the
// browser will not name, and it is the SAME answer, because shoulderLabel gives
// this to any controller it does not recognise. A tip that read
// "{bumper} to charge a strike" would be a brace on screen in the one sentence
// a first-time player is reading most carefully.
const DEFAULT_TOKENS = { bumper: shoulderLabel(null), faceLeft: faceLeftLabel(null) };

/**
 * Does this text name a KEY BINDING, as opposed to merely containing a token?
 *
 * The question the boot check below actually wants, and it used to ask a
 * broader one (`/\{\w+\}/`) that could not tell "press {strike}" from "nice
 * one, {player}". That was harmless while every token in the file was a key —
 * and became wrong the moment one wasn't.
 */
export function namesKey(text) {
  BINDING_TOKEN.lastIndex = 0;
  for (const m of String(text ?? '').matchAll(BINDING_TOKEN)) {
    if (!NON_KEY_TOKENS.has(m[1])) return true;
  }
  return false;
}

/** Spend every `{token}` in one line. */
export function fillBindings(text, tokens = {}) {
  const s = String(text ?? '');
  if (!s.includes('{')) return s;
  return s.replace(BINDING_TOKEN, (whole, name) => {
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

// HARDWARE NAMED IN PLAIN ENGLISH, which no token check can see.
//
// `namesKey` catches "{clap}" on a pad. It cannot catch "Hold a trigger to
// charge a strike" sitting in `text`, because there is no token in it — and
// that is the same bug with the same symptom: a keyboard player reading an
// instruction about a controller they are not holding. It arrived the first
// day this table had more than four rows in it, in two rows at once, written
// by somebody looking at a laptop.
//
// PER DEVICE, because a word is only wrong on the hardware that does not have
// it. "Left stick" is exactly right in a `textPad` and nonsense in `text`,
// which is the keyboard's column as well as everyone's fallback.
//
// DELIBERATELY SHORT AND UNAMBIGUOUS. Every entry here is a physical part that
// one device has and another cannot: no verbs that a sentence about the water
// might reach for, nothing that needs context to read. A list that guessed
// would cost more in false alarms than it saved, and the first one somebody
// waves through is the last one anybody reads.
const PAD_PARTS = /\b(left stick|right stick|thumb ?stick|trigger|bumper|d-?pad|shoulder button)s?\b/i;
const TOUCH_PARTS = /\b(tap|double-?tap|swipe|pinch)(s|ped|ping)?\b/i;

// What each device must not be told about. `kbm` is the strict one because its
// column is also the fallback every row without a variant lands on.
const FOREIGN_PARTS = {
  kbm: [['a controller', PAD_PARTS], ['a touchscreen', TOUCH_PARTS]],
  touch: [['a controller', PAD_PARTS]],
  pad: [['a touchscreen', TOUCH_PARTS]],
};

/**
 * The hardware this line names that `device` does not have, or null.
 *
 * TOKENS ARE STRIPPED FIRST, and that is the difference between this check and
 * a grep. `{bumper}` contains the word "bumper" and is the one construction
 * that is CORRECT on every device — it is how a row says "the shoulder button,
 * whatever this pad calls it" — so scanning the raw cell flags exactly the
 * rows that did the right thing. Only prose is prose.
 */
export function namesForeignHardware(text, device) {
  const prose = String(text ?? '').replace(BINDING_TOKEN, ' ');
  for (const [what, re] of FOREIGN_PARTS[device] ?? []) {
    if (re.test(prose)) return what;
  }
  return null;
}

/**
 * A key token is fine in `text` and a bug on a device with no keyboard, so a
 * row that uses one has to say something else to the other two. Checked at
 * boot, where the table is: the failure it catches — a phone told to press
 * Space — is invisible to whoever is editing the CSV on a laptop.
 *
 * `rows` is anything iterable of parsed rows carrying `{ id, text, deviceText,
 * devices }`, which is the shape deviceText.js produces for every table that
 * uses those columns.
 */
export function checkBindingText(label, rows, warn = console.warn) {
  for (const row of rows) {
    for (const [device, column] of Object.entries(DEVICE_TEXT_COLUMN)) {
      // A row that does not exist on that device has nothing to answer for —
      // a kbm-only line is entitled to name a key and say nothing else.
      if (!rowOnDevice(row, device)) continue;
      const variant = row.deviceText?.[device];
      // THE LINE THAT DEVICE ACTUALLY GETS, which is the variant when there is
      // one and `text` when there is not. Asked this way round rather than
      // "is the variant missing", which is what this checked at first and is
      // only half the question: a `textPad` filled in with the KEYBOARD line
      // still in it passes a presence check and still puts "Press E" in front
      // of somebody holding a controller. Filling the cell is not the fix —
      // taking the key token out of it is.
      if (!namesKey(variant ?? row.text)) continue;
      warn(variant
        ? `[${label}] "${row.id}" has a ${column} that still names a key binding — a `
          + `${device} player will be told to press a key they do not have. Use a `
          + `hardware token ({faceLeft}, {bumper}) or name the gesture instead.`
        : `[${label}] "${row.id}" names a key binding but has no ${column} — a ${device} `
          + 'player will be told to press a key they do not have.');
    }

    // ...and the other half of the same question, asked of every device this
    // row reaches INCLUDING the keyboard — which the loop above cannot do,
    // since a keyboard has no column of its own to be missing.
    for (const device of DEVICES) {
      if (!rowOnDevice(row, device)) continue;
      const line = textForDevice(row, device);
      const foreign = namesForeignHardware(line, device);
      if (!foreign) continue;
      const column = DEVICE_TEXT_COLUMN[device];
      // WHERE THE LINE CAME FROM, said precisely, because the fix is different
      // in each case: edit the variant, edit `text`, or add the variant that
      // would have stopped `text` reaching this device at all.
      const via = row.deviceText?.[device] ? `its ${column}`
        : column ? `\`text\`, which is what it falls back to with no ${column}`
        : '`text`';
      warn(`[${label}] "${row.id}" names part of ${foreign} in ${via} — "${line}" is what a `
        + `${device} player reads, and they are not holding one.`);
    }
  }
}
