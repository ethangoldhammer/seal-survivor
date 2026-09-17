// ============================================================================
// LOAD TIP TABLE — the quick tips that rotate on the loading screen, in
// loadTips.csv.
//
// The loading screen is the one stretch of the game where the player is
// looking straight at the glass with nothing to do, and until now it said
// nothing at all: a bar, a vortex, and on a resumed run one line about the
// resume. The shader warm-up deliberately spends seconds there
// (systems/shaderWarmup.js), and seconds a player has already agreed to wait
// are the cheapest seconds in the game to say something in.
//
// IT IS A POOL, NOT A JOIN. The `id` means nothing to code — nothing fires a
// tip by name, nothing counts which one was shown. Adding a row adds a tip;
// deleting one takes it away. That makes this a sibling of quips.csv and
// greetings.csv rather than of callouts.csv, whose ids ARE conditions.
//
// IT IS ALSO NOT A COACH LINE, and the difference is worth being clear about
// because the two are both "tips". A callouts.csv coach row fires ONCE EVER
// per device, at the moment in the water when it is the answer to what the
// player is doing, and it is pinned to the thing it is about. A load tip is
// read cold, out of context, by somebody who may be on their fortieth run —
// so it can never be the only place something is taught, and it repeats
// forever on purpose.
//
// THE WORDS DEPEND ON WHAT IS IN THEIR HANDS, exactly as they do for a
// callout, so the same three columns are here and are parsed by the same code
// (deviceText.js). "Press E to clap" is nonsense held in two hands, and a tip
// that names a control is the only kind whose whole point is the control.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id        a short handle for the row. Never shown — it exists so a
//             reworded tip keeps its identity in a diff.
//   text      the tip, and the fallback for any device below with nothing of
//             its own. May name a control with a `{token}` — `{clap}` becomes
//             whatever clap is bound to right now — and may spend `{player}`.
//             See systems/bindingText.js.
//   textTouch what to say instead on a touchscreen. Blank = use `text`.
//   textPad   what to say instead on a controller. Blank = use `text`.
//   devices   which devices the row exists on at all, space-separated (`kbm`,
//             `touch`, `pad`). Blank = all of them.
//   review    whether the wording still wants Ethan's eye (see CLAUDE.md).
//   enabled   FALSE takes it out of rotation. Blank means enabled.
//   weight    likelihood relative to the other rows. Blank = 1, 0 is never
//             shown.
//   notes     the brief. Nothing reads it.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';
import loadTipsCsv from './loadTips.csv?raw';
import { parseDeviceText, parseDeviceList, speechlessDevices, deviceNames, rowOnDevice } from './deviceText.js';

const LABEL = 'loadTips';
const FILE = 'loadTips.csv';

export function parseLoadTipCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];

  for (const [id, row] of rows) {
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const line = String(row.text ?? '').trim();
    const deviceText = parseDeviceText(row);
    const devices = parseDeviceList(row.devices, LABEL, id, warn);

    // Same rule as callouts.csv: a row with nothing to say to a device it can
    // still appear on is dropped rather than shown blank. A blank tip on the
    // loading screen is a gap where a sentence was, which reads as the screen
    // being broken rather than as the screen having nothing to say.
    const speechless = speechlessDevices({ text: line, deviceText, devices });
    if (speechless.length) {
      warn(`[${LABEL}] "${id}" has no words for ${deviceNames(speechless)} — the row is being ignored.`);
      continue;
    }

    const w = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
    out.push({ id, text: line, deviceText, devices, weight: w == null ? 1 : w });
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} produced no usable tips — the loading screen will be silent.`);
  }
  return out;
}

// Parsed once at module scope, like every other CSV in the game. Two readers:
// the screen itself (ui/loading.js) and the Text panel's specimen, which shows
// the longest tip in the table so the role is designed against the line that
// actually decides it.
export const LOAD_TIPS = parseLoadTipCsv(loadTipsCsv);

/**
 * The rows somebody holding `device` can be shown, in file order.
 *
 * Narrowed ONCE when the screen goes up rather than per rotation: the device
 * cannot change during a boot (nothing is being pressed yet), and re-filtering
 * every few seconds would be the same answer computed again.
 */
export function tipsForDevice(rows, device) {
  return (rows ?? []).filter((r) => rowOnDevice(r, device));
}

/**
 * A rotation order over `rows`: every tip once, shuffled, weighted.
 *
 * A BAG RATHER THAN A ROLL PER SLOT, and that is the whole reason this is not
 * three lines at the call site. A boot shows three or four tips, and an
 * independent draw each time means a four-tip screen repeats itself about half
 * the time on a four-row table — the one failure a player is certain to
 * notice, because the repeat is thirty seconds after the original and there is
 * nothing else on the screen to look at.
 *
 * Weight decides ORDER here rather than frequency: a heavier tip is likelier
 * to be drawn EARLY, which on a screen that shows most of the bag is the only
 * thing weight can honestly mean. (The usual exponential-key trick — a key of
 * random^(1/w) sorts a weighted sample correctly.)
 *
 * `random` is injectable so the distribution can be checked without a browser.
 */
export function tipOrder(rows, random = Math.random) {
  const pool = (rows ?? []).filter((r) => r.weight > 0);
  // Every weight zero is a misconfigured file rather than an instruction to be
  // silent — the same reading pickQuip and pickGreeting take.
  const usable = pool.length ? pool : (rows ?? []).slice();
  return usable
    .map((r) => ({ r, key: Math.pow(random(), 1 / Math.max(r.weight, 1e-6)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.r);
}
