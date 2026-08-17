// ============================================================================
// CALLOUT TABLE — every line the game SHOUTS at you, kept in callouts.csv.
//
// Two kinds of line, one table, because they are one thing on screen: a short
// sentence in a band across the middle, one at a time, that you are meant to
// read without taking your eyes off the seal.
//
//   warn   a state you need to fix RIGHT NOW — out of air, out of health, out
//          of boost, a boss on its way in. Fires every run, for as long as the
//          game is played.
//   coach  the first-run tips. Each one fires ONCE EVER on a device and then
//          never again (see systems/tutorial.js) — so the wording gets one
//          shot, which is most of why it is worth having in a file you can
//          edit without touching code.
//
// UNLIKE quips.csv, THE ID JOINS TO CODE. A warn row's id is the condition
// that fires it and a coach row's id is the step that offers it, both of which
// live in systems/ — so an unknown id IS a warning here, and deleting a row
// takes that callout out of the game rather than rewording it. Renaming an id
// is a code change; rewording `text` is not, and that split is the point.
//
// THE WORDS DEPEND ON WHAT IS IN THEIR HANDS. "Hold to charge" is the same
// instruction on a keyboard, a phone and a controller and it is useless on all
// three: what a first-run tip has to say is which THING to hold, and there is
// no phrasing that covers a spacebar, a double-tap and a shoulder trigger at
// once. So a row carries up to three wordings and the game picks one — see
// devices.js for the three, and input.js for how it decides which.
//
// A row can also be FOR one device and not exist on the others (`devices`),
// which is not the same thing as a reworded line: the two floating thumb
// sticks are invisible and have to be taught, and there is nothing to teach
// about WASD. A step whose row excludes the current device is skipped AND does
// not hold the first-run coach open waiting to be shown — see tutorial.js.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id        which condition/step this is. Must match one the code knows.
//   kind      `warn` or `coach`. Anything else is skipped with a warning.
//   text      the line itself, and the fallback for any device below that has
//             nothing of its own. Required unless every device the row reaches
//             has a column of its own — a keyboard has no column, so a row a
//             keyboard can see always needs this one. A row with nothing to say
//             to a device it can appear on is dropped, the way a row with no
//             text at all always was.
//
//             May name a control with a `{token}`: `{strike}` becomes whatever
//             strike is currently bound to and `{bumper}` becomes what this
//             particular pad calls its shoulders, so a tip stays true after a
//             rebind or a change of controller. See fillBindings in
//             systems/callouts.js, which also warns about a key token on a row
//             with no `textPad`: a controller player told to press Space is
//             the exact failure these columns exist to prevent.
//
//             `{player}` is the third kind and is about neither the hardware
//             nor the bindings — it becomes whatever the player is called (the
//             name they typed, or "Seal" if they never did), and it works the
//             same way in quips.csv and upgrades.csv. It does NOT need a
//             `textPad`, because a name reads identically in every pair of
//             hands. See systems/playerName.js.
//   textTouch what to say instead on a touchscreen. Blank = use `text`.
//   textPad   what to say instead on a controller. Blank = use `text`.
//   devices   which devices this row exists on at all, space-separated
//             (`kbm`, `touch`, `pad`). Blank = all of them, which is nearly
//             every row.
//   enabled   FALSE takes the callout out of the game. Blank means enabled.
//   anchor    WHERE it appears, and it is a separate one-at-a-time slot rather
//             than a position: `band` is the line across the middle, `player`
//             rides just above the boost ring on the seal. Two anchors means
//             two callouts CAN be up together — which is the point, since they
//             are different sizes in different places and are not competing
//             for the same eye. Within an anchor it is still strictly one.
//             Blank = band.
//   priority  who gets the band when two want it at once — higher wins. For a
//             coach step it doubles as the order steps are offered in, which is
//             the same question asked twice: if air and chum are both worth
//             saying, which one is the player's problem first.
//   hold      seconds on screen. Blank falls back to CONFIG.callouts.hold.
//   repeat    seconds before this may fire AGAIN while its condition is still
//             true. Blank means it fires once per crossing and then stays
//             quiet until the condition clears and comes back — which is what
//             you want for the boss, and NOT what you want for oxygen.
//             Ignored for coach rows: those fire once and are done.
//   arrow     what the arrow points at while the line is up. Two of them name
//             a THING and can come up empty — the tip is up because something
//             is in the water, and it can be eaten or expire mid-sentence:
//               chum     the nearest bite
//               pickup   the nearest power-up orb
//             The other two name a DIRECTION and are always answerable, which
//             is why they are separate targets rather than "the nearest bubble"
//             and "the nearest seabed orb": what they mean is up and down.
//               surface  straight up, out of the water
//               seabed   straight down, at the floor
//             Blank = no arrow, which is most rows.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';
import { DEVICES, DEVICE_LABELS } from './devices.js';

const LABEL = 'callouts';
const FILE = 'callouts.csv';

// device -> the column its wording lives in. `kbm` is absent on purpose: its
// column is `text`, which is also everyone else's fallback, and giving it an
// override column too would be two cells that mean the same thing and can
// disagree.
const DEVICE_TEXT_COLUMN = { touch: 'textTouch', pad: 'textPad' };

export const CALLOUT_KINDS = ['warn', 'coach'];
export const ARROW_TARGETS = ['chum', 'pickup', 'surface', 'seabed'];
/** The surfaces a callout can appear on. First entry is the default. */
export const CALLOUT_ANCHORS = ['band', 'player'];

/**
 * callouts.csv -> Map(id -> row). Rows keep the order of the file for the
 * benefit of an editor listing them; every consumer sorts by `priority`.
 */
export function parseCalloutCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = new Map();

  for (const [id, row] of rows) {
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const kind = String(row.kind ?? '').trim().toLowerCase();
    if (!CALLOUT_KINDS.includes(kind)) {
      warn(`[${LABEL}] "${id}" has kind="${row.kind}", which is not ${CALLOUT_KINDS.join(' or ')} — the row is being ignored.`);
      continue;
    }

    const line = String(row.text ?? '').trim();

    // The per-device rewordings. Blank is the normal case and means "say the
    // same thing" — most lines are about the water rather than about a button.
    const deviceText = {};
    for (const [device, column] of Object.entries(DEVICE_TEXT_COLUMN)) {
      const variant = String(row[column] ?? '').trim();
      if (variant) deviceText[device] = variant;
    }

    // Which devices this row exists on. An unknown name is dropped rather than
    // widening the list: `devices=gamepad` meaning "all devices" would be a row
    // that quietly shows up on a phone, where the words for a controller are
    // not merely unhelpful but describe buttons that are not there.
    let devices = null;
    const devicesRaw = String(row.devices ?? '').trim().toLowerCase();
    if (devicesRaw) {
      const named = devicesRaw.split(/[\s,]+/).filter(Boolean);
      const known = named.filter((d) => DEVICES.includes(d));
      for (const d of named) {
        if (!DEVICES.includes(d)) {
          warn(`[${LABEL}] "${id}" lists the device "${d}", which is not ${DEVICES.join(', ')} — ignoring that one.`);
        }
      }
      // Every name was a typo. Left as "all devices" rather than as an empty
      // list, because an empty list is a row that can never appear anywhere,
      // and that is a worse reading of a misspelling than showing it.
      if (known.length) devices = known;
      else warn(`[${LABEL}] "${id}" has no usable device in "${row.devices}" — showing it on all of them.`);
    }

    // WORDS FOR EVERY DEVICE IT CAN REACH. A callout with nothing to say is an
    // empty band flashing over the fight, which reads as a bug rather than as a
    // message — so the row is dropped rather than shown blank, exactly as it
    // always was. What changed is that "nothing to say" is now a question asked
    // once per device: `text` is the fallback, so a row that a keyboard can see
    // still needs one, while a touch-and-pad row is entitled to leave it empty
    // and let its two columns do the talking.
    const speechless = (devices ?? DEVICES).filter((d) => !calloutText({ text: line, deviceText }, d));
    if (speechless.length) {
      warn(`[${LABEL}] "${id}" has no words for ${speechless.map((d) => DEVICE_LABELS[d]).join(' or ')} — the row is being ignored.`);
      continue;
    }

    // An unrecognised anchor falls back to the band rather than dropping the
    // row: a callout in the wrong place is still a callout, where a callout
    // that silently does not exist is the failure this whole file is built to
    // avoid. Loudly, though — a typo here moves a line somewhere it was never
    // designed to be read.
    const anchorRaw = String(row.anchor ?? '').trim().toLowerCase();
    let anchor = CALLOUT_ANCHORS[0];
    if (anchorRaw) {
      if (CALLOUT_ANCHORS.includes(anchorRaw)) anchor = anchorRaw;
      else warn(`[${LABEL}] "${id}" is anchored to "${row.anchor}", which is not ${CALLOUT_ANCHORS.join(' or ')} — putting it on the band.`);
    }

    const arrowRaw = String(row.arrow ?? '').trim().toLowerCase();
    let arrow = null;
    if (arrowRaw) {
      if (ARROW_TARGETS.includes(arrowRaw)) arrow = arrowRaw;
      else warn(`[${LABEL}] "${id}" points its arrow at "${row.arrow}", which is not ${ARROW_TARGETS.join(' or ')} — no arrow will be drawn.`);
    }

    const priority = parseNumber(row.priority, LABEL, id, 'priority', warn);
    const hold = parseNumber(row.hold, LABEL, id, 'hold', warn, { min: 0 });
    const repeat = parseNumber(row.repeat, LABEL, id, 'repeat', warn, { min: 0 });

    out.set(id, {
      id,
      kind,
      anchor,
      text: line,
      // Only the devices that asked to differ appear as keys. Read through
      // calloutText() rather than directly — the fallback to `text` is the
      // whole point and a caller reaching for row.deviceText.pad would get
      // undefined for the ordinary row that simply had nothing else to say.
      deviceText,
      devices,
      // A blank priority is a real answer — "no opinion, go last" — so it is
      // 0 rather than being treated as missing. A typo (null) lands on the
      // same 0 having already been warned about.
      priority: priority ?? 0,
      // null (a typo) and undefined (blank) both mean "use the default", which
      // is resolved by the caller against CONFIG rather than baked in here:
      // the fallback is tunable and this file is parsed once at boot.
      hold: hold ?? null,
      // repeat is the one field where blank and zero genuinely differ: blank is
      // "never repeat", 0 would be "repeat as fast as you can". `?? null` keeps
      // blank distinguishable; a typo collapses onto it, which is the safe way
      // round — a mis-typed repeat goes quiet rather than machine-gunning.
      repeat: repeat ?? null,
      arrow,
    });
  }

  return out;
}

/**
 * What this row says to somebody holding `device`, falling back to `text`.
 *
 * Still carries any `{binding}` tokens — resolving those needs the player's
 * key bindings, which this file (a parser, run once at boot) has no business
 * reading. systems/callouts.js fills them in on the way to the screen.
 */
export function calloutText(row, device) {
  if (!row) return '';
  return row.deviceText?.[device] ?? row.text;
}

/** Does this row exist at all for somebody holding `device`? */
export function calloutOnDevice(row, device) {
  if (!row) return false;
  // No list is the common case and means every device. A device we were not
  // told about — an undefined ctx in a harness — counts as "show it": going
  // quiet would hide a line for a reason nobody asked for.
  if (!row.devices || !device) return true;
  return row.devices.includes(device);
}

/**
 * The rows of one kind, highest priority first. Ties keep file order, so two
 * rows left at the default priority stay in whatever order they were written.
 */
export function calloutsOfKind(table, kind) {
  return [...table.values()]
    .filter((r) => r.kind === kind)
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Warns about ids the code never asks for, and about conditions the code has
 * that the file has no line for. Called once at boot with the id lists the two
 * systems own — this is the join the header talks about, and without it a
 * mis-typed id is a callout that silently never appears.
 */
export function checkCalloutIds(table, knownWarn, knownCoach, warn = console.warn) {
  const known = { warn: new Set(knownWarn), coach: new Set(knownCoach) };
  for (const row of table.values()) {
    if (!known[row.kind].has(row.id)) {
      warn(`[${LABEL}] "${row.id}" is not a ${row.kind} the game knows how to fire — the row will never appear.`);
    }
  }
  for (const kind of CALLOUT_KINDS) {
    for (const id of known[kind]) {
      const row = table.get(id);
      if (!row || row.kind !== kind) {
        warn(`[${LABEL}] the game can fire the ${kind} "${id}" but ${FILE} has no enabled row for it — it will stay silent.`);
      }
    }
  }
}
