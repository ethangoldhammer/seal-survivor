#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The seabed bed's LAYOUT, checked in Node.
//
//   npm run test:seabed
//
// No model loads here and there is no GL context, so this deliberately tests
// planBed() and blueNoiseDisc() rather than scatterSeabed() — the split in
// seabedScatter.js exists for exactly this. What it can check is everything
// that decides where a plant goes, which is where the bugs in a sampler live.
//
// The one that matters most is the SPACING check. A rejection sampler whose
// neighbour lookup is wrong still returns the right number of points, still
// looks random, and still passes any test that counts things — it just lets
// pairs land on top of each other, occasionally, in a way you notice on screen
// and cannot reproduce. So the minimum pairwise distance is measured
// all-pairs, brute force, deliberately NOT reusing the grid the sampler uses:
// a test that shares the code under test's spatial index cannot catch that
// index being wrong.
// ---------------------------------------------------------------------------

import { blueNoiseBand, planBed, bedSpan } from '../path/src/systems/seabedScatter.js';
import { SEABED_PROPS } from '../path/src/seabedProps.js';
import { CONFIG, DEFAULTS } from '../path/src/config.js';

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Brute force, on purpose — see the header. */
function minGap(points) {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i][0] - points[j][0];
      const dz = points[i][1] - points[j][1];
      const d = Math.hypot(dx, dz);
      if (d < min) min = d;
    }
  }
  return min;
}

console.log('\nblue-noise band');
{
  const spacing = 1.8;
  const width = 70;
  const depth = 4;
  const pts = blueNoiseBand(mulberry32(1337), { width, depth, spacing, count: 400, attempts: 30 });
  ok(pts.length > 0, 'produces points', `${pts.length} of 400 attempted`);

  const gap = minGap(pts);
  ok(gap >= spacing - 1e-9, 'no two points closer than spacing',
    `closest pair ${gap.toFixed(4)}, spacing ${spacing}`);

  const outside = pts.filter(([x, z]) => Math.abs(x) > width / 2 + 1e-9 || Math.abs(z) > depth / 2 + 1e-9);
  ok(outside.length === 0, 'every point is inside the band', `${outside.length} outside`);

  // END TO END. A sampler that quietly favours the middle leaves the walls
  // bare, which is the exact complaint this domain change answers — so it is
  // checked rather than assumed. Each outer sixth of the width should hold
  // about a sixth of the plants.
  const sixth = width / 6;
  const leftEnd = pts.filter(([x]) => x < -width / 2 + sixth).length / pts.length;
  const rightEnd = pts.filter(([x]) => x > width / 2 - sixth).length / pts.length;
  ok(Math.abs(leftEnd - 1 / 6) < 0.06 && Math.abs(rightEnd - 1 / 6) < 0.06,
    'the ends are as populated as the middle',
    `${(leftEnd * 100).toFixed(1)}% / ${(rightEnd * 100).toFixed(1)}% in the outer sixths, want ~16.7%`);

  // The rejection has to actually bite somewhere, or the spacing dial is
  // decorative. A band this narrow saturates well under 400 darts.
  const tight = blueNoiseBand(mulberry32(1337), { width: 30, depth: 4, spacing: 1.8, count: 400, attempts: 30 });
  ok(tight.length < 400, 'the spacing rejection actually rejects', `${400 - tight.length} of 400 darts dropped`);
  ok(minGap(tight) >= 1.8 - 1e-9, 'and holds the spacing while it does',
    `closest pair ${minGap(tight).toFixed(4)}`);

  // Spacing 0 is a legitimate setting (a bed that may overlap) and must not
  // divide by zero or spin on a rejection that can never succeed.
  const loose = blueNoiseBand(mulberry32(7), { width, depth, spacing: 0, count: 50, attempts: 30 });
  ok(loose.length === 50, 'spacing 0 keeps every dart', `${loose.length} of 50`);

  // A spacing nothing can satisfy must terminate, not hang.
  const impossible = blueNoiseBand(mulberry32(7), { width: 2, depth: 2, spacing: 40, count: 50, attempts: 30 });
  ok(impossible.length === 1, 'an impossible spacing yields one point and returns', `${impossible.length}`);
}

// A saved snapshot outranks the literal in config.js, so CONFIG.seabed here is
// whatever the running game last wrote — not what this file declares. That is
// the right thing to assert most of the below against (it is what actually
// runs) and the wrong thing to assert a DEFAULT against, so the shipped
// defaults get their own section reading DEFAULTS directly. Without it, editing
// a default in config.js and having a stale snapshot silently ignore it looks
// exactly like the edit working.
console.log('\nshipped defaults (DEFAULTS, not the saved snapshot)');
{
  const d = DEFAULTS.seabed;
  const live = CONFIG.seabed;
  const shadowed = ['count', 'spacing', 'bedScale', 'attempts', 'overhang']
    .filter((k) => live[k] !== d[k])
    .concat(JSON.stringify(live.scale) !== JSON.stringify(d.scale) ? ['scale'] : []);
  if (shadowed.length) {
    console.log(`  note  a saved snapshot is shadowing ${shadowed.join(', ')} — `
      + 'the tuner\'s Reset restores these');
  }

  const bed = planBed(d, { width: 86, centre: 0 });
  const scales = bed.map((p) => p.scale);
  ok(minGap(bed.map((p) => [p.x, p.z])) >= d.spacing - 1e-9,
    'the default spacing holds', `closest pair ${minGap(bed.map((p) => [p.x, p.z])).toFixed(3)}`);
  // Density, stated as the thing you actually see: how much floor each plant
  // gets. A count on its own says nothing without the width it is spread over.
  const perPlant = 86 / bed.length;
  ok(perPlant > 0.5, 'the default bed is sparse enough to have clearings',
    `${bed.length} plants over 86 units — one every ${perPlant.toFixed(2)} units`);
  ok(Math.max(...scales) / Math.min(...scales) > 3,
    'the default size spread is wide', `${Math.min(...scales).toFixed(2)}x to ${Math.max(...scales).toFixed(2)}x`
    + ` — a ${(Math.max(...scales) / Math.min(...scales)).toFixed(1)}x range`);
}

console.log('\ndeterminism');
{
  const a = planBed(CONFIG.seabed);
  const b = planBed(CONFIG.seabed);
  ok(JSON.stringify(a) === JSON.stringify(b), 'same seed, same bed', `${a.length} plants`);

  const c = planBed({ ...CONFIG.seabed, seed: 1338 });
  ok(JSON.stringify(a) !== JSON.stringify(c), 'a different seed is a different bed');
  ok(a.length > 0, 'the configured bed is not empty', `${a.length} plants`);
}

console.log('\nplacements');
{
  const bed = planBed(CONFIG.seabed);
  const cfg = CONFIG.seabed;
  const [sMin, sMax] = cfg.scale;

  const known = new Set(Object.values(SEABED_PROPS).flat().map((v) => v.id));
  ok(bed.every((p) => known.has(p.variant)), 'every plant names a variant that exists');

  ok(bed.every((p) => p.scale >= sMin && p.scale <= sMax), 'scales stay inside the range',
    `${Math.min(...bed.map((p) => p.scale)).toFixed(3)}..${Math.max(...bed.map((p) => p.scale)).toFixed(3)} of ${sMin}..${sMax}`);

  const halfYaw = cfg.yawRange / 2;
  ok(bed.every((p) => Math.abs(p.yaw) <= halfYaw + 1e-9), 'yaw stays inside yawRange');

  // Every WEIGHTED species should appear, and nothing else should. A species
  // whose weight is set but whose name is misspelled would otherwise vanish in
  // silence — the picker just never rolls it.
  const seen = new Set(bed.map((p) => p.species));
  const wanted = Object.entries(cfg.species).filter(([, w]) => w > 0).map(([n]) => n);
  const missing = wanted.filter((n) => !seen.has(n));
  const extra = [...seen].filter((n) => !wanted.includes(n));
  ok(missing.length === 0, 'every weighted species is planted', missing.join(', ') || 'none missing');
  ok(extra.length === 0, 'nothing unweighted is planted', extra.join(', ') || 'none extra');

  const unknownName = wanted.filter((n) => !SEABED_PROPS[n]);
  ok(unknownName.length === 0, 'every weighted name is a real species in seabedProps.js',
    unknownName.join(', ') || 'all real');

  // Variants inside a species should all get used, or the extra files are
  // dead weight in the build.
  const usedVariants = new Set(bed.map((p) => p.variant));
  const unused = Object.entries(SEABED_PROPS)
    .filter(([name]) => (cfg.species[name] ?? 0) > 0)
    .flatMap(([, vs]) => vs.map((v) => v.id))
    .filter((id) => !usedVariants.has(id));
  ok(unused.length === 0, 'every variant of a weighted species gets planted',
    unused.join(', ') || 'all used');

  // Rough proportions. Weighted sampling that ignores its weights still plants
  // every species, so "all present" is not enough to know the mix is right.
  const total = Object.values(cfg.species).reduce((s, w) => s + w, 0);
  const counts = {};
  for (const p of bed) counts[p.species] = (counts[p.species] ?? 0) + 1;
  console.log('\n  species mix (measured vs weighted):');
  let mixOk = true;
  for (const [name, w] of Object.entries(cfg.species).filter(([, x]) => x > 0)) {
    const want = w / total;
    const got = (counts[name] ?? 0) / bed.length;
    // Generous: this is a few hundred draws, so the sampling noise on a 3%
    // species is large. It is here to catch a picker that is wrong, not one
    // that is unlucky.
    const near = Math.abs(got - want) < Math.max(0.04, want * 0.5);
    if (!near) mixOk = false;
    console.log(`    ${name.padEnd(12)} ${String(counts[name] ?? 0).padStart(4)}  `
      + `${(got * 100).toFixed(1)}%  want ${(want * 100).toFixed(1)}%${near ? '' : '   <-- off'}`);
  }
  ok(mixOk, 'the mix follows the weights');
}

console.log('\nbed geometry');
{
  const bed = planBed(CONFIG.seabed);
  const cfg = CONFIG.seabed;
  const xs = bed.map((p) => p.x);
  const spread = Math.max(...xs) - Math.min(...xs);
  const { width } = bedSpan(cfg);
  // WALL TO WALL. The plan is in band coordinates centred on 0, so the spread
  // of the plants should be nearly the whole domain — a bed reaching only 80%
  // of it is one that stops short of the walls, which is the thing you see and
  // no other assertion here would catch.
  ok(spread > width * 0.95, 'the bed reaches both ends',
    `${spread.toFixed(1)} of ${width.toFixed(1)} units`);

  const triCount = Object.values(SEABED_PROPS).flat()
    .reduce((m, v) => m.set(v.id, v.tris), new Map());
  const tris = bed.reduce((s, p) => s + (triCount.get(p.variant) ?? 0), 0);
  const variants = new Set(bed.map((p) => p.variant)).size;
  const scales = bed.map((p) => p.scale);
  console.log(`\n  ${bed.length} plants · ${variants} draw calls · ${tris.toLocaleString()} triangles`);
  console.log(`  spread ${spread.toFixed(1)} units · sizes ${Math.min(...scales).toFixed(2)}x to ${Math.max(...scales).toFixed(2)}x`);
  // For scale: the whole 55-model creature roster is 428,649 triangles, and
  // the source scene these were cut from was 368,982 for a single still.
  ok(tris < 150000, 'the bed costs less than a third of the creature roster',
    `${tris.toLocaleString()} triangles`);
  ok(variants <= 19, 'one draw call per variant, not per plant', `${variants} draws for ${bed.length} plants`);
}

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
