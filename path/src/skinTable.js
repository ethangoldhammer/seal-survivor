// ============================================================================
// SKINS — the per-individual variants of a creature's glow preset, in skins.csv.
//
// A PRESET says what a species looks like and is shared by every clone of an
// asset key: nine lanternfish wearing one pattern IS the read for a school. A
// SKIN is the layer above it — one crab in a heap of them wearing a different
// palette from its neighbours, rolled at spawn and stamped on that individual's
// own material (systems/biolumSkin.js, setBiolumSkinVariant).
//
// The crabs are what this is for. They arrive in crowds, they walk slowly
// enough to be looked at, and a wall of nine identical shells reads as one
// sprite repeated. Nothing about the roster limits it to them — any asset
// carrying a `biolumSkin` preset picks up every skin listed against that
// preset, and an empty table means every creature wears its preset, which is
// exactly what shipped before this file existed.
//
// WHY A CSV AND NOT THE TUNER. Not because these are gameplay numbers — they
// are look, and the preset they layer over is on sliders. Because they are a
// LIST. The tuner's snapshot saves an array wholesale and merges it back over
// config.js on the next boot, so a variant added here later would be shadowed
// forever by whatever list happened to be saved first. A roster of rows wants
// a file, the same way the boss perks and the rarity ladder do.
//
// Columns (order doesn't matter, unknown columns are ignored):
//   id        what this skin is called. Warnings and tools/biolum-skin-test
//             name it, and nothing else joins to it.
//   preset    which glow preset it is a variant OF — a key under
//             CONFIG.biolumSkin.presets. A skin only ever appears on a
//             creature already wearing that preset, which is what makes the
//             day/night gate below structural rather than a rule someone has
//             to remember.
//   gate      `day` or `night`, and it is CHECKED, not decoration: the preset's
//             own `luminous` flag decides which one the row is allowed to say,
//             and a row that disagrees is dropped with a warning rather than
//             silently spawning a glowing crab at noon. See buildSkins.
//   weight    how likely, RELATIVE TO THE OTHER SKINS ON THE SAME PRESET.
//             Blank means 1. They are all 1 today, on purpose — the column
//             exists so the roster can be tilted later without a code change.
//   enabled   FALSE takes a skin out of rotation without deleting the row.
//
// ...and then the look itself. EVERY ONE OF THESE MAY BE BLANK, and blank
// means "inherit from the preset" rather than "zero" — which is what lets the
// shipped look be a row (`shell`, `ember`) with nothing in it but an id, and
// what keeps a palette-only variant from silently resetting the pattern.
//   pattern   one of BIOLUM_PATTERNS.
//   colorA/B/C  the three-stop ramp, `#rrggbb` or a bare hex.
//   shellColor  what the animal reads as BETWEEN the markings, and
//   shellGlow   how much of it there is. Blank inherits the preset's, which on
//             the night crab is a deep orange. Author the colour SATURATED and
//             let the amount make it dark — a dark hex is already near zero
//             once it is converted to linear. Worth stating per skin even
//             though it inherits: the shell is most of the animal, so a cold
//             palette over a warm shell is two creatures at once.
//   scale     feature size as a fraction of body length.
//   warpMin   how far the organic patterns displace their own sample point —
//   warpMax   and, for `lattice`, how far the cells travel on each ripple.
//             Give BOTH to roll a value per individual (the lattice crabs use
//             1..3, so a heap of them springs by visibly different amounts);
//             give only warpMin for a fixed value; give neither to inherit.
//
// ...and the RIM, because a look is the body and its edge together. These
// three follow the same blank-inherits rule as everything above, over
// CONFIG.creatureOutline / CONFIG.companionOutline rather than over the glow
// preset — whichever of the two the creature's asset is listed in.
//   rim       blank inherits the species' rim, `none` takes it OFF this
//             individual, and a hex sets its colour. The same three-way shape
//             assets.csv's `skin` column uses (blank / `none` / a value), for
//             the same reason: "inherit" and "off" are different answers and a
//             colour column alone cannot say the second one.
//   rimGlow   how far past 1.0 the colour is pushed, i.e. how hard it blooms.
//   rimThickness  world units, converted per model like the shared number.
//
// The rim is NOT per individual in the way the palette is: one material is
// built per skin ROW, shared by every creature wearing that row. That keeps
// the tuner's switches and sliders reaching creatures already swimming — the
// whole reason outlines.js shares a material per species — and bounds the
// material count at the length of this table rather than at the population.
//
// A NOTE ON PALE PALETTES. `bone` is near-white, and the bloom's bright pass
// thresholds Rec.709 luminance — so at the same `strength` as the ember shell
// it blooms several times harder, while a deep blue at the same strength may
// not reach the threshold at all. That is a property of the palette, not a bug
// in the row: judge a new colour on screen, in crab-skins.html, rather than by
// how bright the hex looks in a swatch.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'skins';
const FILE = 'skins.csv';

export function parseSkinCsv(text, warn = console.warn) {
  return parseIdTable(text, LABEL, FILE, warn);
}

// '#4aa8ff' or '4aa8ff' -> 0x4aa8ff. Null on anything unreadable, and the
// caller then leaves the field out of the variant entirely so the preset's own
// colour survives — an unparseable hex must not paint a creature black.
function parseColor(raw, id, field, warn) {
  const s = String(raw ?? '').trim().replace(/^#/, '');
  if (!s) return null;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    warn(`[${LABEL}] "${id}" has ${field} "${raw}", which isn't a 6-digit hex — inheriting the preset's colour instead.`);
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
 * Build the roster: { presetName: [skin, ...] }.
 *
 * @param rows      what parseSkinCsv returned.
 * @param opts.patterns   the legal pattern names (BIOLUM_PATTERNS). A row
 *                  naming one that doesn't exist would otherwise select
 *                  `blotches` silently, because the shader takes an index.
 * @param opts.presetIsNight  (name) => true if that preset is luminous, false
 *                  if it is pigment, null if config.js has never heard of it.
 *                  Handed in rather than read from CONFIG so this module stays
 *                  a leaf — see the same argument on beatDivisions.js.
 *
 * Every rejection is a warning and a dropped row, never a throw: a bad cell in
 * a spreadsheet should cost you one variant, not the game's boot.
 */
export function buildSkins(rows, { patterns = [], presetIsNight = () => null } = {}, warn = console.warn) {
  const out = {};

  for (const [id, row] of rows) {
    if ('enabled' in row && parseBool(row.enabled, LABEL, id, 'enabled', warn) === false) continue;

    const preset = String(row.preset ?? '').trim();
    if (!preset) {
      warn(`[${LABEL}] "${id}" names no preset, so there is no creature it could appear on — skipped.`);
      continue;
    }
    const night = presetIsNight(preset);
    if (night == null) {
      warn(`[${LABEL}] "${id}" is a variant of preset "${preset}", which config.js does not declare — skipped.`);
      continue;
    }

    // THE GATE, enforced rather than trusted. The preset already decides this
    // — a luminous preset is only ever worn by a night asset — so the column
    // is a second statement of the same fact, and the whole value of a second
    // statement is that the two can be compared. A row saying `day` on a
    // glowing preset is somebody expecting a shell and getting a lamp.
    const gate = String(row.gate ?? '').trim().toLowerCase();
    const want = night ? 'night' : 'day';
    if (gate && gate !== want) {
      warn(`[${LABEL}] "${id}" is gated ${gate} but preset "${preset}" is ${want} (luminous ${night}) — skipped rather than spawned at the wrong hour.`);
      continue;
    }

    const weight = numberOrNull(row, id, 'weight', warn, { min: 0 }) ?? 1;
    if (weight <= 0) continue;

    // The overrides, and only the ones the row actually states. An absent key
    // is what makes the variant layer transparent — applyBiolumSkinSettings
    // spreads it over the preset, so a key present with value `undefined`
    // would blank the preset's own.
    const look = {};
    const pattern = String(row.pattern ?? '').trim();
    if (pattern) {
      if (!patterns.includes(pattern)) {
        warn(`[${LABEL}] "${id}" asks for pattern "${pattern}", which is not one of: ${patterns.join(', ')} — inheriting the preset's instead.`);
      } else look.pattern = pattern;
    }
    for (const field of ['colorA', 'colorB', 'colorC', 'shellColor']) {
      const c = parseColor(row[field], id, field, warn);
      if (c != null) look[field] = c;
    }
    const scale = numberOrNull(row, id, 'scale', warn, { min: 0.01 });
    if (scale != null) look.scale = scale;
    const shellGlow = numberOrNull(row, id, 'shellGlow', warn, { min: 0 });
    if (shellGlow != null) look.shellGlow = shellGlow;

    // `let`, because the swap below writes it. It was `const`, which made that
    // branch a TypeError in strict mode rather than a swap — the whole skin
    // table would have failed to build, and only for a row that got its two
    // warp ends the wrong way round. No shipped row does, which is why it sat
    // here unseen; esbuild refuses to bundle the file and is how it surfaced.
    let warpMin = numberOrNull(row, id, 'warpMin', warn, { min: 0 });
    let warpMax = numberOrNull(row, id, 'warpMax', warn, { min: 0 });
    if (warpMax != null && warpMin == null) {
      warn(`[${LABEL}] "${id}" gives warpMax with no warpMin — a range needs both ends, so it is being ignored.`);
      warpMax = null;
    }
    if (warpMin != null && warpMax != null && warpMax < warpMin) {
      warn(`[${LABEL}] "${id}" has warpMax ${warpMax} below warpMin ${warpMin} — swapping them.`);
      [warpMin, warpMax] = [warpMax, warpMin];
    }

    // THE RIM. Kept in its own object rather than merged into `look`, because
    // `look` is spread straight onto the biolum uniforms — a rim colour in
    // there would be an inert key that reads like a setting, which is the kind
    // of thing that gets "fixed" into a real one later.
    //
    // `none` is a state, not a colour: a row that wants this individual bare
    // has to be able to say so, and blank already means inherit.
    const rimRaw = String(row.rim ?? '').trim().toLowerCase();
    const rim = {};
    if (rimRaw === 'none') rim.off = true;
    else if (rimRaw) {
      const c = parseColor(row.rim, id, 'rim', warn);
      if (c != null) rim.color = c;
    }
    const rimGlow = numberOrNull(row, id, 'rimGlow', warn, { min: 0 });
    if (rimGlow != null) rim.glow = rimGlow;
    const rimThickness = numberOrNull(row, id, 'rimThickness', warn, { min: 0 });
    if (rimThickness != null) rim.thickness = rimThickness;

    (out[preset] ??= []).push({
      id,
      preset,
      gate: want,
      weight,
      look,
      // Null when the row says nothing about the rim at all, which is every
      // shipped crab row — and null is what tells outlines.js to leave the
      // species' own shared material in place rather than building a second
      // one identical to it.
      rim: Object.keys(rim).length ? rim : null,
      // Null when the row states no range; a fixed warp is min == max, which
      // rolls to itself and needs no second code path.
      warp: warpMin == null ? null : [warpMin, warpMax ?? warpMin],
    });
  }

  return out;
}

/**
 * Roll one skin for a creature about to spawn.
 *
 * Returns a variant object ready for setBiolumSkinVariant — the row's look
 * with any per-individual value already resolved — or null if this preset has
 * no skins, which is the ordinary case for every creature but the crabs and
 * means "wear the preset".
 *
 * `rng` is injectable so tools/biolum-skin-test.mjs can walk the table
 * deterministically instead of rolling thousands of times and hoping.
 */
export function rollSkin(table, preset, rng = Math.random) {
  const list = preset ? table?.[preset] : null;
  if (!list?.length) return null;

  let total = 0;
  for (const s of list) total += s.weight;
  if (total <= 0) return null;

  let roll = rng() * total;
  let picked = list[list.length - 1];
  for (const s of list) {
    roll -= s.weight;
    if (roll <= 0) { picked = s; break; }
  }

  // A fresh object every spawn: the variant is stamped by reference onto the
  // individual's material, so handing out the shared row would let a later
  // roll's warp reach back into every crab already wearing it.
  const variant = { ...picked.look, __skin: picked.id };
  if (picked.warp) {
    const [lo, hi] = picked.warp;
    variant.warp = lo + (hi - lo) * rng();
  }
  // The rim rides along under a namespaced key. applyBiolumSkinSettings
  // spreads this object over the preset and writes only the uniforms it knows
  // about, so an extra key is inert there; the caller that rolled the skin
  // pulls it out and hands it to outlines.js. Carried rather than returned
  // separately so a caller cannot roll a body and its edge apart.
  if (picked.rim) variant.__rim = { id: picked.id, ...picked.rim };
  return variant;
}

/** Every skin, flattened — for the contact sheet and the tests. */
export function allSkins(table) {
  return Object.values(table ?? {}).flat();
}
