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

/**
 * Push every row's size into the live multiplier map.
 *
 * @param setSize   assets.js's setAssetSizeMultiplier
 * @param knownKey  (key) => boolean, so a row naming an asset that no longer
 *                  exists is REPORTED rather than silently doing nothing. A
 *                  renamed asset otherwise leaves a row that looks authoritative
 *                  and scales nothing.
 */
export function applyAssetTable(setSize, knownKey, warn = console.warn) {
  for (const [key, row] of ASSET_ROWS) {
    if (knownKey && !knownKey(key)) {
      warn(`[${LABEL}] "${key}" is not an asset in this build — skipped. `
        + 'Check the spelling against ASSETS in assets.js.');
      continue;
    }
    const raw = String(row.size ?? '').trim();
    // Blank means "leave it at 1", which is what an asset with no row gets.
    // Not zero — zero would scale the model out of existence.
    if (raw === '') { setSize(key, 1); continue; }
    const n = parseNumber(raw, LABEL, key, 'size', warn);
    if (n == null) continue; // parseNumber warned; leave the default alone
    if (!(n > 0)) {
      warn(`[${LABEL}] "${key}" has size=${raw}, which would collapse the model — ignored.`);
      continue;
    }
    setSize(key, n);
  }
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
