#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE OPENING PLACEMENT FOR A NEWLY IMPORTED ACCESSORY.
//
//   npm run acc:seed                       # every accessory in ASSETS
//   npm run acc:seed -- accessoryJester    # or named keys
//
// CONFIG.accessories.items says, twice, that its numbers are "derived" and then
// describes the derivation in prose. Nothing computed it. Both batches were
// worked out by hand against a paragraph, which is why the third batch's comment
// has to re-explain the formula and re-state which of the shipped values it
// reproduces — the check was a memory of a check. This is that paragraph as
// code, so the next import is a command rather than an afternoon.
//
// IT SEEDS. It does not tune, and nothing here is final: every number it prints
// is a starting point for `npm run looks:accessorylab`, and what that writes
// back through tools/apply-accessories.mjs replaces all of it. What a seed has
// to be is CONSISTENT — a new hat landing where the solved hats already land —
// because a placement that starts somewhere arbitrary gets dragged to somewhere
// arbitrary and the drawer slowly stops looking like one wardrobe.
//
// THE THREE NUMBERS IT ANSWERS
//
//   `size` — WIDTH ACROSS THE HEAD. The solved items measure 0.945 world units
//   across for a hat and 0.786 for glasses, so size is that over the model's own
//   across-extent in fit:1 units.
//
//     AND "ACROSS" IS NOT ALWAYS X. The config comment says x, and says so
//     because every accessory it was written about declares `forward: '+Z'`,
//     which puts the flank (forward x up) on x. accessoryStetson declares
//     `forward: '+X'` — its brim runs front-to-back along x, which is why x is
//     also its LONGEST axis — and for that one the across-extent is z. Taking x
//     would divide by the front-to-back span, come out near 0.945, and put a
//     hat on the seal at two thirds the width of every other hat, looking like
//     a hat that is merely a bit small rather than like a bug. So the flank is
//     computed from the entry's own forward/up, the way orientationQuaternion
//     does it.
//
//   `lift` — HOW FAR ABOVE head_07 THE MODEL'S ORIGIN SITS. Two answers, and
//   the honest thing is that they disagree:
//
//     THE FORMULA puts the model's lowest vertex 0.197 above the bone, which is
//     the skull's top vertex (0.489) less the 0.292 the captain's cap is
//     deliberately buried by. So 0.197 + the centroid-to-lowest drop, in fit:1
//     units, times `size`. The drop is measured from the AREA-WEIGHTED CENTROID
//     because that is what createVisual re-centres on — for a hat the centroid
//     and the bbox centre are about 5% of its height apart, which is the
//     difference between a brim on the skull and a brim inside it.
//
//     THE HATS DISAGREE WITH IT. Every hat dialled in the lab was raised above
//     the formula's answer, by between 0.057 and 0.135 — and they all landed in
//     the same place, 0.472 with a spread of 0.015, near enough independent of
//     which hat. So a HAT is seeded at that 0.472 and the formula is printed
//     beside it as `formula`, because the gap is a real finding about this rig
//     rather than noise to hide.
//
//     AND THE FORMULA IS NOT THE ANSWER FOR A DEEP OBJECT EITHER. It puts the
//     LOWEST vertex at 0.197 whatever the object is, which is right for a brim
//     resting on a skull and wrong for anything the skull goes INSIDE: the
//     ushanka's flaps hang past the ears, so its lowest vertex belongs BELOW
//     the skull's top, and the formula floats the whole hat 0.93 up instead.
//     The shark hood is the worked example — seeded at the formula's 0.574,
//     its own config row predicted it would have to come DOWN, and the lab left
//     it at 0.217.
//
//     So there are three families and each has one number:
//
//       hat   0.472  rests ON the head. Every hat the lab has dialled, and
//                    both haircuts — a wig is a SHELL the thickness of hair,
//                    so it sits on the skull like a brim does. Seeded at the
//                    hood's number first, on the argument that a wig encloses
//                    a skull; on the seal that buried it and left a fringe.
//       wrap  0.217  the head goes INSIDE it. The hood's solved value, and
//                    the only measurement this family has — a bowl with real
//                    depth to sink into, which is what separates it from
//                    hair rather than "does it go round the head".
//       —     formula  a shallow decal with nothing to sink into.
//
//     `--<key>=<family>` says which, because "does this rest on the head or go
//     round it" is a fact about the object and cannot be read off its bounds.
//
//   `snout`, `pitch`, `depth` and the other two rotations are INHERITED, not
//   derived. They are facts about where the skull and the eye are, not about
//   which hat is on, so they come from the family mean of the solved items of
//   the same kind.
//
// THE SELF-CHECK, and where it is EXPECTED to disagree. Run with no arguments
// and it prints the shipped value beside its own for every accessory already in
// config.js. It reproduces nine of the twelve exactly — accessoryHat 1.275,
// Glasses 0.786, Bowler 1.027, Fedora 1.171, Aviators 0.811, WireFrames 0.786,
// HardHat 1.269, Cowboy 1.187, Wizard 1.1 — which is what makes it worth
// trusting on a new one. The three it misses are the three whose config rows
// say they were moved by hand:
//
//   accessoryTricorn  1.025 vs 0.978, dialled up to match the captain's cap
//   accessoryRounds   1.090 vs 0.910, dialled in the lab
//   accessorySharkHood 1.824 vs 0.945, sized on the fins rather than the bounds
//
// A fourth name appearing in that list means either a new hand-tune nobody
// wrote down or a change to the import pipeline, and both are worth knowing.
//
// THE ONE SHAPE IT CANNOT MEASURE is a hat whose widest part is not the part
// that meets the head. `size` divides by the model's across-extent, which for
// every brimmed hat IS roughly the head's width — and for accessoryJester is
// the span of three horns three and a half times the width of its cap. Measured
// on the whole model it seeds a pea-sized cap; measured on the cap's own
// primitive it seeds 3.404, a hat wider than the seal is long. That is a taste
// call rather than a measurement error, so it is made in the lab and the number
// is recorded in the config row. This tool will report the bounds answer.
//
// WHAT IT WILL NOT DO is write config.js. It prints a block to paste, and the
// reason it stops there is that CONFIG.accessories.items is hand-commented
// per row and a generator that owned the block would have to own the prose too.
// ---------------------------------------------------------------------------

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'public/models');

// ---------------------------------------------------------------------------
// THE SOLVED ITEMS, and everything below is measured against them.
//
// Hard-coded rather than read out of config.js, deliberately: these are the
// numbers this tool CHECKS ITSELF against (run it on accessoryBowler and
// accessoryFedora and it has to reproduce 1.027 and 1.171), and a self-check
// that reads its own expected answer from the file it is validating is not one.
// If the lab moves a shipped hat far enough that these stop matching, that is
// worth being told about rather than silently absorbing.
// ---------------------------------------------------------------------------
const ACROSS = { hat: 0.945, glasses: 0.786, wrap: 0.945 };
// The skull's top vertex above head_07 (0.489), less how far the captain's cap
// is deliberately sunk into it (0.292).
const FLOOR = 0.197;
// Where the lab actually left each family. See the header.
const LIFT = { hat: 0.472, wrap: 0.217 };
// The family means of the solved hats and the solved glasses.
const INHERIT = {
  hat: { snout: 0.349, depth: 0, pitch: -0.372, yaw: 0, roll: 0, showTurns: [0, -0.7854] },
  glasses: { snout: 0.586, depth: -0.006, pitch: -0.147, yaw: 0.059, roll: -0.019, showTurns: [-1.5708] },
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const AXES = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Which of x/y/z an axis vector lies along, and which way. */
const dominant = (v) => {
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[k])) k = i;
  return { axis: k, sign: Math.sign(v[k]) || 1 };
};

/**
 * The area-weighted centroid and the bounds, in the file's own units.
 *
 * The same two-pass median-capped sum computeCentroid does in assets.js, and it
 * has to be: this number's whole job is to predict where createVisual will put
 * the origin, and a bbox centre — which is the obvious thing to reach for — is
 * about 5% of a hat's height away from it. These files are flattened and
 * unskinned by the importer, so a raw POSITION read is already world space.
 */
function measure(doc) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  let totalArea = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    const tris = [];
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!pos) continue;
      const count = idx ? idx.getCount() : pos.getCount();
      const a = [0, 0, 0]; const b = [0, 0, 0]; const c = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, a);
        for (let k = 0; k < 3; k++) { if (a[k] < min[k]) min[k] = a[k]; if (a[k] > max[k]) max[k] = a[k]; }
      }
      for (let i = 0; i + 2 < count; i += 3) {
        pos.getElement(idx ? idx.getScalar(i) : i, a);
        pos.getElement(idx ? idx.getScalar(i + 1) : i + 1, b);
        pos.getElement(idx ? idx.getScalar(i + 2) : i + 2, c);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = cross(u, v);
        const area = Math.hypot(n[0], n[1], n[2]) * 0.5;
        if (area < 1e-12) continue;
        tris.push({ area, c: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
      }
    }
    if (!tris.length) continue;
    // Per MESH, like assets.js — a median taken across the whole document would
    // let a dense mesh set the cap for a coarse one.
    const sorted = tris.map((t) => t.area).sort((x, y) => x - y);
    const cap = sorted[Math.floor(sorted.length / 2)] * 75;
    for (const t of tris) {
      if (t.area > cap) continue;
      for (let k = 0; k < 3; k++) sum[k] += t.c[k] * t.area;
      totalArea += t.area;
    }
  }

  const centroid = totalArea > 1e-9
    ? sum.map((s) => s / totalArea)
    : [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  // The per-axis bounds guard assets.js applies, for the same reason it does.
  for (let k = 0; k < 3; k++) {
    const slack = (max[k] - min[k]) * 0.05;
    if (centroid[k] < min[k] - slack || centroid[k] > max[k] + slack) centroid[k] = (min[k] + max[k]) / 2;
  }
  return { min, max, centroid, size: [0, 1, 2].map((k) => max[k] - min[k]) };
}

/** Everything the seed needs, for one ASSETS entry. */
export async function seedFor(def, kind) {
  const file = path.join(MODELS, path.basename(def.model));
  if (!fs.existsSync(file)) return null;
  if (!measureCache.has(file)) {
    measureCache.set(file, measure(await io.readBinary(new Uint8Array(fs.readFileSync(file)))));
  }
  const m = measureCache.get(file);

  const f = AXES[def.forward ?? '-Z'];
  const u = AXES[def.up ?? '+Y'];
  const flank = dominant(cross(f, u));
  const upAxis = dominant(u);

  // `fit` normalises the LONGEST axis to one world unit, whichever it is.
  const longest = Math.max(...m.size);
  const acrossFit = m.size[flank.axis] / longest;
  const size = +(across(kind) / acrossFit).toFixed(3);

  // How far the origin sits above the lowest point, along the model's own up.
  const lowest = upAxis.sign > 0 ? m.min[upAxis.axis] : -m.max[upAxis.axis];
  const centreUp = m.centroid[upAxis.axis] * upAxis.sign;
  const dropFit = (centreUp - lowest) / longest;
  const formula = +(FLOOR + dropFit * size).toFixed(3);

  return {
    size,
    formula,
    longestAxis: 'xyz'[m.size.indexOf(longest)],
    acrossAxis: 'xyz'[flank.axis],
    acrossFit: +acrossFit.toFixed(4),
    dropFit: +dropFit.toFixed(4),
  };
}

const measureCache = new Map();

// ---------------------------------------------------------------------------

const { ASSETS } = await import('../path/src/assets.js');
const { CONFIG } = await import('../path/src/config.js');

const argv = process.argv.slice(2);
const wanted = argv.filter((a) => !a.startsWith('--'));

/**
 * Hat, glasses, or something that goes ROUND the head rather than on it.
 *
 * Read off the entry where it can be — a `forward` of '+Z' with eyewear's
 * showTurns is not a thing that can be inferred — and otherwise asked for. The
 * default is `hat`, because that is what most of the wardrobe is and a wrong
 * guess here is a hat seeded 0.1 too low rather than something unrecoverable.
 */
function kindOf(key) {
  const flag = argv.find((a) => a.startsWith(`--${key}=`));
  if (flag) return flag.split('=')[1];
  const item = CONFIG.accessories?.items?.[key];
  if (item?.showTurns?.length === 1 && item.showTurns[0] < -1) return 'glasses';
  return 'hat';
}

// `glasses` shares the hat's lift table by not being in it — a pair of frames
// is a shallow decal, so it takes the formula. Named here so the absence reads
// as a decision.
function across(kind) {
  return ACROSS[kind] ?? ACROSS.hat;
}

const keys = wanted.length
  ? wanted
  : Object.keys(ASSETS).filter((k) => k.startsWith('accessory') && ASSETS[k].model);

console.log('  key                     size   lift   formula  across  longest  drop');
console.log('  ' + '-'.repeat(70));
for (const key of keys) {
  const def = ASSETS[key];
  if (!def?.model) { console.error(`  ${key}: no model`); process.exitCode = 1; continue; }
  const kind = kindOf(key);
  const s = await seedFor(def, kind);
  if (!s) { console.error(`  ${key}: ${def.model} is not in public/models`); process.exitCode = 1; continue; }
  // A hat takes the empirical 0.472; anything else takes the formula. See the
  // header — this is the one input that is a judgement rather than a
  // measurement, and `--<key>=hood` is how you say so.
  const lift = LIFT[kind] ?? s.formula;
  const shipped = CONFIG.accessories?.items?.[key];
  const drift = shipped
    ? `   shipped size ${shipped.size} lift ${shipped.lift}` +
      (Math.abs(shipped.size - s.size) > 0.02 ? `  <- SIZE MOVED ${(shipped.size - s.size).toFixed(3)}` : '')
    : '';
  console.log(
    `  ${key.padEnd(22)} ${String(s.size).padStart(6)} ${String(lift).padStart(6)} ${String(s.formula).padStart(8)}` +
    `  ${s.acrossAxis}=${String(s.acrossFit).padEnd(6)}  ${s.longestAxis}       ${s.dropFit}${drift}`,
  );
}
