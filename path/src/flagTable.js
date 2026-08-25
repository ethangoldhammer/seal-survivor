// ============================================================================
// FLAGS — what flies from a hull's masthead, in flags.csv.
//
// A flag is one image and nothing else: no gameplay, no hitbox, no sound. It
// exists because three of the boats in this game are the same two hulls wearing
// different tints, and a flag is the cheapest thing that can tell them apart at
// a glance — and because Bakalar's trawler is YOURS, and a boat that flies your
// flag reads as yours before anything else about it has been noticed.
//
// WHY A CSV AND NOT THE TUNER, for the same reason skins.csv gives: this is a
// LIST. The tuner saves an array wholesale and merges it back over config.js on
// the next boot, so a flag added later would be shadowed forever by whatever
// list happened to be saved first. Everything in here is a roster of rows, so
// it wants a file. How a flag is DRAWN — its size on the mast, how hard it
// flutters — is not a list, and lives on sliders in CONFIG.flags.
//
// THE IMAGE lives in public/flags/ and is referenced from the site root:
// public/flags/foo.webp is `/flags/foo.webp`. See that folder's README for what
// the format has to be (an alpha channel, if the flag is not a rectangle).
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id      what this flag is called. Warnings and tools/flag-test name it,
//           and nothing else joins to it — a new flag is just a new row.
//   src     the image, as a path from the site root. Required: a row with no
//           src is a flag with nothing on it, and is dropped with a warning
//           rather than flying a blank rectangle.
//   hulls   which hulls may fly it, comma-separated. BLANK IS THE GENERAL
//           POOL, and a row that names a hull is EXCLUSIVE to it — see below.
//   weight  how likely, relative to the other flags in the same pool. Blank
//           means 1.
//   enabled FALSE takes a flag out of rotation without deleting the row or
//           the file.
//   notes   working text. Nothing reads it.
//
// HOW `hulls` DECIDES A POOL, which is the one rule here worth stating twice.
// A hull that has rows written FOR IT flies only those; a hull that has none
// draws from the rows that name nobody. So Bakalar's row, which names
// `bakalarBoat`, is the only flag his trawler can ever fly — adding twenty
// flags to the general pool cannot put one on his mast — and the same row is
// not in the pool the bosses draw from, because it belongs to a hull.
//
// It is the convention quips.csv and epitaphs.csv already use for `causes`: a
// line written for one occasion BEATS the general pool rather than competing
// with it. The difference is only that a flag's occasion is a boat.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'flags';
const FILE = 'flags.csv';

export function parseFlagCsv(text, warn = console.warn) {
  return parseIdTable(text, LABEL, FILE, warn);
}

/**
 * Build the roster: { general: [flag, ...], byHull: { hullKey: [flag, ...] } }.
 *
 * @param rows        what parseFlagCsv returned.
 * @param opts.hulls  the hull keys that fly flags at all — the asset keys in
 *                    CONFIG.flags.hulls. Handed in rather than read from CONFIG
 *                    so this module stays a leaf, the same argument
 *                    beatDivisions.js and skinTable.js both make. A row naming
 *                    a hull that doesn't fly flags is a typo that would
 *                    otherwise cost a flag silently, so it is named out loud.
 *
 * Every rejection is a warning and a dropped row, never a throw: a bad cell in
 * a spreadsheet should cost you one flag, not the game's boot.
 */
export function buildFlags(rows, { hulls = [] } = {}, warn = console.warn) {
  const general = [];
  const byHull = {};

  for (const [id, row] of rows) {
    if ('enabled' in row && parseBool(row.enabled, LABEL, id, 'enabled', warn) === false) continue;

    const src = String(row.src ?? '').trim();
    if (!src) {
      warn(`[${LABEL}] "${id}" names no src, so there is no image it could fly — skipped.`);
      continue;
    }

    let weight = 1;
    if ('weight' in row && String(row.weight ?? '').trim() !== '') {
      const n = parseNumber(row.weight, LABEL, id, 'weight', warn, { min: 0 });
      if (n != null) weight = n;
    }

    // Split on commas OR whitespace: the column is short enough that it gets
    // typed both ways, and "bossBoat bossYacht" meaning one hull called
    // "bossBoat bossYacht" would be a flag that never flies anywhere.
    const named = String(row.hulls ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const flag = { id, src, weight };

    const targets = [];
    for (const name of named) {
      if (!hulls.includes(name)) {
        warn(`[${LABEL}] "${id}" is written for hull "${name}", which flies no flags — that hull is ignored.`);
        continue;
      }
      targets.push(name);
    }

    // A row whose every named hull was rejected does NOT fall back into the
    // general pool. It was written for a boat; putting it on every other boat
    // instead is the one outcome nobody asked for.
    if (named.length && !targets.length) continue;

    if (!targets.length) general.push(flag);
    else for (const h of targets) (byHull[h] ??= []).push(flag);
  }

  return { general, byHull };
}

/** Which flags a hull may fly — its own rows if it has any, else the pool. */
export function flagsFor(roster, hull) {
  const own = roster?.byHull?.[hull];
  if (own?.length) return own;
  return roster?.general ?? [];
}

/**
 * One flag for this hull, or null if there is nothing it could fly.
 *
 * @param rand  injected so tools/flag-test.mjs can roll a fixed sequence —
 *              a weighted pick tested against Math.random is a test that
 *              passes on average.
 */
export function pickFlag(roster, hull, rand = Math.random) {
  const pool = flagsFor(roster, hull);
  if (!pool.length) return null;
  const total = pool.reduce((sum, f) => sum + Math.max(0, f.weight), 0);
  // Every row weighted 0 is a deliberate "none of these", not a reason to
  // hand back the first one.
  if (total <= 0) return null;
  let r = rand() * total;
  for (const f of pool) {
    r -= Math.max(0, f.weight);
    if (r <= 0) return f;
  }
  return pool[pool.length - 1];
}
