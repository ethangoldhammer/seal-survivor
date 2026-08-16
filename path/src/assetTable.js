// ---------------------------------------------------------------------------
// ASSET TABLE — how big each model spawns, kept in assets.csv.
//
// `sizeMultiplier` scales every future createVisual() of an asset key. It used
// to be a live slider in the model/texture panel, saved into
// CONFIG.assetLooks, and it is out of there for a reason that is not tidiness:
// IT IS NOT A LOOK. The hitbox is derived from the visual scale, so dragging
// Size changes how big a creature is to HIT as well as to see — it is a
// balance number wearing a look's clothes. Ethan's rule applies: a number
// judged against other numbers belongs in a table.
//
// It also failed in the way live tuning fails. CONFIG.assetLooks ships EMPTY,
// so every value in it was a snapshot of whatever the panel last held; the
// walking crab drifted to 10.46 mid-session — a crab 29 world units tall in a
// 40-unit arena — while its own night variant sat at 2.42, and nothing in the
// repo recorded that either number was intended.
//
// Keyed by ASSET KEY, not creature id: one asset can back several creatures,
// and plenty of assets (grass, boats, the escorts) are not creatures at all.
// That makes this an id table like enemies.csv rather than a path table like
// spawning.csv.
//
// Lives here rather than in config.js because setAssetSizeMultiplier is
// assets.js's, and assets.js already imports config.js — putting the apply in
// config.js would close that loop. config.js imports this module only to strip
// the field out of saved snapshots.
// ---------------------------------------------------------------------------

import assetsCsv from './assets.csv?raw';
import { parseIdTable, parseNumber } from './csvTable.js';

const LABEL = 'assetTable';
const FILE = 'assets.csv';

export const ASSET_ROWS = parseIdTable(assetsCsv, LABEL, FILE);

// Values in the `skin` column that mean "no procedural skin", as opposed to a
// BLANK cell, which means "whatever assets.js declares". The distinction is the
// only reason the column can turn a skin OFF as well as on.
const SKIN_OFF = new Set(['none', 'off', 'no', '-']);

/**
 * Push every row into the live asset maps: `size` into the multiplier map, and
 * `skin` onto the asset definition itself.
 *
 * WHY THE SKIN IS A FILE AND NOT A SLIDER. Every other look in this game is
 * live, and this one cannot be: attachBiolumSkin runs once, inside the material
 * processing that happens when a model is parsed, and it bakes two per-vertex
 * attributes off the geometry while it is there. Nothing short of re-parsing
 * the model can add a pattern to a body that loaded without one. A control that
 * looked live and only took effect on the next reload is the exact failure the
 * Size slider was taken out of the panel for; a column in a file that the panel
 * reports and says "reload" is honest about what it is.
 *
 * It is also the right shape for the job. Deciding which species wear a
 * generated pattern is deciding which texture files the build can stop
 * shipping — a roster-wide judgement made against the other rows, which is
 * Ethan's rule for what belongs in a table.
 *
 * @param setSize    assets.js's setAssetSizeMultiplier
 * @param setSkin    (key, preset|null) => void — null clears any skin the asset
 *                   declared in code. Only called for a NON-BLANK cell, so a
 *                   blank leaves assets.js's own value alone.
 * @param knownKey   (key) => boolean, so a row naming an asset that no longer
 *                   exists is REPORTED rather than silently doing nothing. A
 *                   renamed asset otherwise leaves a row that looks authoritative
 *                   and scales nothing.
 * @param knownSkin  (preset) => boolean. Passed in rather than imported because
 *                   the presets live in config.js and config.js imports THIS
 *                   file — asking it directly would close the loop.
 */
export function applyAssetTable(opts) {
  for (const [key, row] of ASSET_ROWS) applyAssetTableRow(key, row, opts);
}

/**
 * One row's worth of the above, exported so a test can drive a synthetic row.
 * ASSET_ROWS is parsed from the shipped file, so without this the only rows any
 * test can reach are the ones that happen to be in it today — and "what does a
 * misspelled preset do" is not a question to answer by misspelling one in the
 * file everybody's game reads.
 */
export function applyAssetTableRow(key, row, { setSize, setSkin, knownKey, knownSkin, warn = console.warn }) {
  if (knownKey && !knownKey(key)) {
    warn(`[${LABEL}] "${key}" is not an asset in this build — skipped. `
      + 'Check the spelling against ASSETS in assets.js.');
    return;
  }
  // Before the size, and deliberately not sharing its early exits: a row may
  // name a good skin and a bad size, and the skin should still land.
  applySkin(key, row, setSkin, knownSkin, warn);

  const raw = String(row.size ?? '').trim();
  // Blank means "leave it at 1", which is what an asset with no row gets.
  // Not zero — zero would scale the model out of existence.
  if (raw === '') { setSize?.(key, 1); return; }
  const n = parseNumber(raw, LABEL, key, 'size', warn);
  if (n == null) return; // parseNumber warned; leave the default alone
  if (!(n > 0)) {
    warn(`[${LABEL}] "${key}" has size=${raw}, which would collapse the model — ignored.`);
    return;
  }
  setSize?.(key, n);
}

function applySkin(key, row, setSkin, knownSkin, warn) {
  if (!setSkin) return;
  const raw = String(row.skin ?? '').trim();
  if (raw === '') return; // the asset keeps whatever it declares in code
  if (SKIN_OFF.has(raw.toLowerCase())) { setSkin(key, null); return; }
  // A MISSPELLED PRESET MUST NOT SILENTLY DISABLE THE SKIN. Passing it through
  // would attach a material whose config lookup misses and falls all the way
  // back to `base` — a creature wearing the family default, which looks like a
  // deliberate choice and is the hardest kind of wrong to notice.
  if (knownSkin && !knownSkin(raw)) {
    warn(`[${LABEL}] "${key}" asks for skin="${raw}", which is not a preset in `
      + 'CONFIG.biolumSkin.presets — left as it was. Check the spelling against '
      + 'the Procedural skins folder on the T panel.');
    return;
  }
  setSkin(key, raw);
}

// Take `sizeMultiplier` back out of a saved snapshot, in both directions.
//
// The half that makes the file authoritative rather than advisory: the panel
// wrote this field for months, a saved value beats a default, and left in it
// would keep whatever the last drag set while the CSV appeared to do nothing.
export function withoutAssetTableFields(assetLooks) {
  if (!assetLooks || typeof assetLooks !== 'object') return assetLooks;
  const out = {};
  for (const [key, look] of Object.entries(assetLooks)) {
    if (!look || typeof look !== 'object') { out[key] = look; continue; }
    const { sizeMultiplier, ...rest } = look;
    // An entry that held nothing else is dropped whole, so snapshots do not
    // accumulate a hollow object per asset.
    if (Object.keys(rest).length) out[key] = rest;
  }
  return out;
}
