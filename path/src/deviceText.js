// ============================================================================
// DEVICE TEXT — the three-column rule that lets one row say a different thing
// to a keyboard, a thumb and a controller.
//
// callouts.csv invented this: `text` is the line, `textTouch` and `textPad`
// reword it for hardware that has no Space bar, and `devices` says which of
// the three a row exists on at all. It is not a callout idea, it is a
// CONTROLS idea — the moment any other table wants to name a button it wants
// the same three columns with the same blank-means-fallback rule and the same
// refusal to show a row with nothing to say.
//
// The loading screen's quick tips are the second table to want it (see
// loadTipTable.js), so the parse lives here rather than a second time over
// there. Two copies of "blank means use `text`" is two answers to the one
// question a writer asks of every cell in the file.
//
// PURE. No CONFIG, no settings, no `{token}` resolution — that is
// systems/bindingText.js, which needs the player's bindings and therefore
// cannot be imported by a parser that runs at module scope.
// ============================================================================

import { DEVICES, DEVICE_LABELS } from './devices.js';

// device -> the column its wording lives in. `kbm` is absent on purpose: its
// column is `text`, which is also everyone else's fallback, and giving it an
// override column too would be two cells that mean the same thing and can
// disagree.
export const DEVICE_TEXT_COLUMN = { touch: 'textTouch', pad: 'textPad' };

/**
 * The per-device rewordings on a raw CSV row. Blank is the normal case and
 * means "say the same thing" — most lines are about the water rather than
 * about a button.
 */
export function parseDeviceText(row) {
  const out = {};
  for (const [device, column] of Object.entries(DEVICE_TEXT_COLUMN)) {
    const variant = String(row?.[column] ?? '').trim();
    if (variant) out[device] = variant;
  }
  return out;
}

/**
 * Which devices a row exists on at all, or null for "all of them".
 *
 * An unknown name is DROPPED rather than widening the list: `devices=gamepad`
 * meaning "all devices" would be a row that quietly shows up on a phone, where
 * the words for a controller are not merely unhelpful but describe buttons
 * that are not there.
 */
export function parseDeviceList(raw, label, id, warn = console.warn) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const named = s.split(/[\s,]+/).filter(Boolean);
  const known = named.filter((d) => DEVICES.includes(d));
  for (const d of named) {
    if (!DEVICES.includes(d)) {
      warn(`[${label}] "${id}" lists the device "${d}", which is not ${DEVICES.join(', ')} — ignoring that one.`);
    }
  }
  // Every name was a typo. Left as "all devices" rather than as an empty list,
  // because an empty list is a row that can never appear anywhere, and that is
  // a worse reading of a misspelling than showing it.
  if (known.length) return known;
  warn(`[${label}] "${id}" has no usable device in "${raw}" — showing it on all of them.`);
  return null;
}

/** What a parsed row says to somebody holding `device`. */
export function textForDevice(row, device) {
  if (!row) return '';
  return row.deviceText?.[device] ?? row.text;
}

/** Does this row exist at all for somebody holding `device`? */
export function rowOnDevice(row, device) {
  if (!row) return false;
  // No list is the common case and means every device. A device we were not
  // told about — an undefined ctx in a harness — counts as "show it": going
  // quiet would hide a line for a reason nobody asked for.
  if (!row.devices || !device) return true;
  return row.devices.includes(device);
}

/**
 * The devices this row can appear on and has NOTHING to say to.
 *
 * A line with no words is an empty band flashing over the fight, which reads
 * as a bug rather than as a message — so a row that comes back non-empty here
 * is dropped at parse. "Nothing to say" is a question asked once per device:
 * `text` is the fallback, so a row a keyboard can see always needs one, while
 * a touch-and-pad row is entitled to leave it empty and let its two columns do
 * the talking.
 */
export function speechlessDevices(row) {
  return (row.devices ?? DEVICES).filter((d) => !textForDevice(row, d));
}

/** Those devices, worded for a warning. */
export function deviceNames(list) {
  return list.map((d) => DEVICE_LABELS[d] ?? d).join(' or ');
}
