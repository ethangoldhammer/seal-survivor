// ============================================================================
// BOSS LOOKS — what a perk does to the BODY, in bossLooks.csv.
//
// The name generator already guarantees that an electric boss is CALLED
// something electric (see rollBossName: one slot is always handed to the
// perk's vocabulary). This is the same guarantee made to the eye. A player who
// reads "Stormmaw the Live Wire" and then looks at an ordinary grey shark has
// been told twice and shown nothing, and the name stops being a telegraph the
// moment it is the only place the perk exists.
//
// WHY THIS IS KEYED ON THE PERK AND NOT ON THE NAME, given that the request
// was to adapt the name generator. Because the name is already keyed on the
// perk, and going through it would put a second, weaker copy of the same join
// in the middle: a look hung off name PARTS can be rolled away — a boss draws
// the electric perk, the roll hands the perk its epithet, and the prefix that
// was carrying the look never comes up. The perk is the fact; the name and the
// look are two renderings of it, and they are siblings rather than a chain.
// A `look` column on bossNames.csv remains possible later as an OVERRIDE for
// hand-written nicknames, which is the one case where a name really is more
// specific than the perk it belongs to.
//
// WHAT A ROW IS. A skin variant, in exactly the sense skins.csv means it — a
// subset of CONFIG.biolumSkin preset keys, stamped onto the individual's own
// material by systems/bossLook.js through setBiolumSkinVariant. So this file
// inherits that file's contract wholesale, including the important half:
// EVERY LOOK CELL MAY BE BLANK, and blank means "inherit" rather than "zero".
// A row that sets only colorA repaints one stop and leaves the pattern, the
// coverage and the shell exactly as the species wears them.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id        THE PERK ID from bossPerks.csv. This is a join, not a handle —
//             unlike skins.csv, where the id names nothing. A row whose id is
//             not a perk is dropped with a warning, because a typo here is a
//             look that silently never appears on any boss ever again.
//   enabled   FALSE takes the look out of rotation without deleting the row,
//             and the unwritten rows below ship that way: a blank row that was
//             ENABLED would stamp an empty variant over the species preset,
//             which is a no-op today and would quietly become a real repaint
//             the moment somebody added a column.
//
// ...and then the look, all optional:
//   pattern   one of BIOLUM_PATTERNS.
//   colorA/B/C  the three-stop ramp, `#rrggbb` or a bare hex.
//   shellColor  what the body reads as BETWEEN the markings, and
//   shellGlow   how much of it there is.
//   strength  how hard the markings light. THE KEY THAT MAKES THIS WORK ON A
//             SHARK: the pigment presets (`hide`, `plate`) ship at strength 0
//             — pure paint, no light — so raising it here is what turns a
//             painted body into a lit one for the duration of one fight, with
//             no second preset and no material swap.
//   pigment   0..1, how much of the pattern is paint rather than light. Left
//             partway on purpose in the shipped row: at 1 the body is repainted
//             and stops being a shark, at 0 it is a lamp in the shape of one.
//   coverage  how much of the body the markings claim.
//   scale     feature size as a fraction of body length.
//
// ...and one column that is not a skin key at all:
//   sparkColor  what the perk's arcs are drawn in. BLANK IS THE POINT: blank
//             takes the colour from the aura ring, which takes it from the
//             perk's `attack` type in bossPerks.csv, which resolves through
//             the one palette in systems/organicRing.js. So the body, the
//             boundary and the sparks are three readings of a single number
//             and cannot drift apart in a retune. A hex here breaks that on
//             purpose, for the case where an author wants the sparks to read
//             hotter than the boundary they cross.
//
// A NOTE ON WHAT THIS FILE MUST NOT BECOME. It is look, not gameplay: nothing
// here may change reach, damage, rate or size. Those live in bossPerks.csv,
// where the harness can see them. A `radius` column added here would be a
// second place a fight's numbers come from, and the first one to disagree.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'bossLooks';
const FILE = 'bossLooks.csv';

// The skin keys a row may set, and the ONLY ones stamped onto the material.
// An allowlist rather than "every column that isn't reserved", because the
// variant object goes straight into the shader's uniform resolve: a stray
// column would arrive as a key CONFIG.biolumSkin has never heard of, which is
// silently ignored today and a mystery in a year.
const COLOR_KEYS = ['colorA', 'colorB', 'colorC', 'shellColor'];
const NUMBER_KEYS = {
  shellGlow: { min: 0, max: 4 },
  strength: { min: 0, max: 8 },
  pigment: { min: 0, max: 1 },
  coverage: { min: 0, max: 1 },
  scale: { min: 0.01, max: 4 },
};

export function parseBossLookCsv(text, warn = console.warn) {
  return parseIdTable(text, LABEL, FILE, warn);
}

// '#4aa8ff' or '4aa8ff' -> 0x4aa8ff. Null on anything unreadable, and the
// caller then leaves the field out of the look entirely so the preset's own
// colour survives — a bad hex must not paint a boss black in the one fight the
// player was meant to remember. Deliberately a twin of skinTable.js's parser
// rather than an import from it: the two files are the same shape today and
// are not the same idea, and sharing four lines would tie a boss's look to a
// change made for the crabs.
function parseColor(raw, id, field, warn) {
  const s = String(raw ?? '').trim().replace(/^#/, '');
  if (!s) return null;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    warn(`[${LABEL}] "${id}" has ${field} "${raw}", which isn't a 6-digit hex — inheriting instead.`);
    return null;
  }
  return parseInt(s, 16);
}

function numberOrNull(row, id, field, warn, opts) {
  if (!(field in row)) return null;
  if (String(row[field] ?? '').trim() === '') return null;
  const n = parseNumber(row[field], LABEL, id, field, warn, opts);
  return n == null ? null : n;
}

/**
 * Build the table: { perkId: { look, sparkColor } }.
 *
 * @param rows          what parseBossLookCsv returned.
 * @param opts.patterns the legal pattern names (BIOLUM_PATTERNS). A row naming
 *                      one that doesn't exist would otherwise select
 *                      `blotches` silently, because the shader takes an index.
 * @param opts.perks    the legal perk ids from bossPerks.csv. Handed in rather
 *                      than imported so this module stays a leaf — the same
 *                      argument skinTable.js makes about presetIsNight.
 *
 * Every rejection is a warning and a dropped row, never a throw. A bad cell in
 * a spreadsheet should cost you one boss's paint, not the game's boot.
 */
export function buildBossLooks(rows, { patterns = [], perks = null } = {}, warn = console.warn) {
  const out = {};

  for (const [id, row] of rows) {
    if ('enabled' in row && parseBool(row.enabled, LABEL, id, 'enabled', warn) === false) continue;

    // THE JOIN, checked. Unlike every other id in the CSV family this one has
    // to match something, and it fails silently when it doesn't: a look tagged
    // for a perk that was renamed is simply a look no boss ever wears again,
    // and nothing about the game looks broken while it happens.
    if (perks && !perks.includes(id)) {
      warn(`[${LABEL}] "${id}" is not a perk in bossPerks.csv — the look will never appear. `
        + `Known: ${perks.join(', ')}.`);
      continue;
    }

    const look = {};

    const pattern = String(row.pattern ?? '').trim();
    if (pattern) {
      if (!patterns.includes(pattern)) {
        warn(`[${LABEL}] "${id}" asks for pattern "${pattern}", which is not one of `
          + `${patterns.join(', ')} — inheriting the species pattern instead.`);
      } else look.pattern = pattern;
    }

    for (const key of COLOR_KEYS) {
      const c = parseColor(row[key], id, key, warn);
      if (c != null) look[key] = c;
    }
    for (const [key, opts] of Object.entries(NUMBER_KEYS)) {
      const n = numberOrNull(row, id, key, warn, opts);
      if (n != null) look[key] = n;
    }

    // Not part of the look — see the header. Kept beside it because it is the
    // same author making the same decision in the same row.
    const sparkColor = parseColor(row.sparkColor, id, 'sparkColor', warn);

    // A row with an id, no look and no spark colour is the unwritten state,
    // and it is reported rather than stored: stamping an empty variant is a
    // traverse over every material on the boss to say nothing, on the arrival
    // frame of the fight, which is the worst frame in the game to spend on it.
    if (!Object.keys(look).length && sparkColor == null) {
      warn(`[${LABEL}] "${id}" sets nothing — the row is enabled but has no look in it, `
        + 'so the boss will wear its species skin. Set enabled=FALSE if that is deliberate.');
      continue;
    }

    out[id] = { id, look, sparkColor };
  }

  return out;
}
