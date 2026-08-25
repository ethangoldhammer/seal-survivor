// RAZOR CLAM — the fan.
//
// npm run test:upgrades proves the STAT is wired: the card exists, the stack
// counts, the feedback event has a home. It cannot see any of what is checked
// here, because none of it is in the stat block — the blade count, the arc, the
// pierce and the lane placement all live in systems/razorClam.js and are only
// ever spent at the moment a volley leaves.
//
// The one that has to be tested rather than eyeballed is THE SEAM. An open fan
// spans its arc inclusively (a blade on each edge); a closed one cannot, because
// -PI and +PI are the same heading. Get it wrong and the full circle the last
// card promises silently arrives one blade short with a doubled lane in it —
// which on screen is indistinguishable from a fan that merely got wide, and
// which no amount of playing would reliably surface.
//
//   node --import ./tools/vite-loader.mjs tools/razor-clam-test.mjs

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  razorClamCount, razorClamArc, razorClamDamage, razorClamPierce,
  razorClamFireRate, razorClamHeadings, razorClamVolley,
  bladeSize, razorClamRadius, razorClamRoll,
} from '../path/src/systems/razorClam.js';
import { ASSETS, createVisual } from '../path/src/assets.js';
import { projectiles, spawnProjectile, updateProjectiles, resetProjectiles } from '../path/src/entities/projectiles.js';

const TAU = Math.PI * 2;
const c = CONFIG.razorClam;
const CAP = CONFIG.upgrades.find((u) => u.id === 'razorClam')?.maxStacks ?? 8;

let failures = 0;
function ok(cond, label, detail = '') {
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`); }
}

// Deterministic stand-in for Math.random, so a jitter check is a check and not
// a coin flip. 0.5 is the midpoint, which the (rand()*2 - 1) form turns into
// exactly zero jitter — the lanes come out where they were placed.
const noJitter = () => 0.5;

console.log('\n1. the two curves');
{
  const counts = [];
  const arcs = [];
  for (let l = 1; l <= CAP; l++) { counts.push(razorClamCount(l)); arcs.push(razorClamArc(l)); }
  console.log(`     blades  ${counts.join(', ')}`);
  console.log(`     arc     ${arcs.map((a) => (a * 180 / Math.PI).toFixed(0) + '°').join(', ')}`);

  ok(counts[0] === c.count, 'level 1 fires the configured blade count');
  ok(counts.every((n, i) => i === 0 || n >= counts[i - 1]), 'the blade count never goes down');
  ok(arcs.every((a, i) => i === 0 || a >= arcs[i - 1]), 'the fan never narrows');
  ok(Math.abs(arcs[0] - c.arc) < 1e-9, 'level 1 is the configured arc');
  // The card's whole promise. If arcFullAt and maxStacks ever drift apart, the
  // last card stops delivering the circle and this is the only thing that says so.
  ok(Math.abs(arcs[CAP - 1] - TAU) < 1e-6, `the fan is a FULL CIRCLE at the cap (level ${CAP})`,
    `arcFullAt=${c.arcFullAt}, maxStacks=${CAP} — these must match`);
  ok(arcs[Math.floor(CAP / 2)] > c.arc * 2 && arcs[Math.floor(CAP / 2)] < TAU,
    'the middle levels are a real wedge, not a waypoint');
  // A level past the cap must not buy a 400-degree arc.
  ok(Math.abs(razorClamArc(CAP + 5) - TAU) < 1e-6, 'a level past the cap clamps at one full turn');
}

console.log('\n2. lane placement');
{
  // --- open fan ---
  const level = 1;
  const arc = razorClamArc(level);
  const n = razorClamCount(level);
  const open = razorClamHeadings(level, 0, n, noJitter);
  ok(open.length === n, `an open fan places every blade (${n})`);
  ok(Math.abs(open[0] + arc / 2) < 1e-9 && Math.abs(open[n - 1] - arc / 2) < 1e-9,
    'an open fan spans its arc INCLUSIVELY — a blade on each edge',
    `edges ${open[0].toFixed(4)} / ${open[n - 1].toFixed(4)}, wanted ${(-arc / 2).toFixed(4)} / ${(arc / 2).toFixed(4)}`);
  ok(open.some((a) => Math.abs(a) < 1e-9) || n % 2 === 0, 'an odd fan puts a blade on the crosshair');

  // A lone blade must sit on the aim, not on one edge of a fan it is the whole of.
  const solo = razorClamHeadings(1, 1.2, 1, noJitter);
  ok(solo.length === 1 && Math.abs(solo[0] - 1.2) < 1e-9, 'a single blade flies down the aim');

  // --- the seam ---
  const top = razorClamHeadings(CAP, 0, razorClamCount(CAP), noJitter);
  const norm = (a) => { let x = a % TAU; if (x < 0) x += TAU; return x; };
  const wrapped = top.map(norm).sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 0; i < wrapped.length; i++) {
    const next = i === wrapped.length - 1 ? wrapped[0] + TAU : wrapped[i + 1];
    minGap = Math.min(minGap, next - wrapped[i]);
  }
  const want = TAU / wrapped.length;
  ok(minGap > 1e-6, 'NO TWO BLADES SHARE A HEADING at the full circle',
    `closest pair ${minGap.toFixed(6)} rad apart`);
  ok(Math.abs(minGap - want) < 1e-6, 'the full circle is evenly divided',
    `smallest gap ${minGap.toFixed(6)}, even spacing would be ${want.toFixed(6)}`);
  ok(!wrapped.some((a) => Math.abs(a) < 1e-9),
    'the ring straddles the aim rather than seating a lane on it');
}

console.log('\n3. jitter');
{
  const clean = razorClamHeadings(4, 0, null, noJitter);
  const rough = razorClamHeadings(4, 0, clean.length, () => 1); // full positive jitter
  const moved = rough.map((a, i) => a - clean[i]);
  ok(moved.every((d) => Math.abs(d - c.spread) < 1e-9), 'jitter is applied per blade, at the configured size');
  ok(c.spread < razorClamArc(4) / (clean.length * 2),
    'jitter is smaller than half a lane — the fan\'s WIDTH stays the level readout',
    `spread ${c.spread}, half-lane ${(razorClamArc(4) / (clean.length * 2)).toFixed(4)}`);
}

console.log('\n4. damage, pierce and cadence');
{
  const dmg = [];
  const prc = [];
  const rate = [];
  for (let l = 1; l <= CAP; l++) { dmg.push(razorClamDamage(l)); prc.push(razorClamPierce(l)); rate.push(razorClamFireRate(l)); }
  console.log(`     damage  ${dmg.join(', ')}`);
  console.log(`     pierce  ${prc.join(', ')}`);
  console.log(`     volley  ${rate.map((r) => r.toFixed(2)).join(', ')}s`);

  ok(dmg.every((d) => d > 0 && Number.isFinite(d)), 'damage is finite and positive at every level');
  ok(dmg[CAP - 1] > dmg[0], 'damage climbs');
  ok(prc.every(Number.isInteger), 'pierce is always a whole number of bodies');
  ok(prc.every((p) => p <= (c.pierceMax ?? Infinity)), 'pierce respects its ceiling');
  ok(prc[0] >= 1, 'the FIRST pick already pierces — the card says so');
  ok(rate.every((r, i) => i === 0 || r <= rate[i - 1]), 'the volley never gets slower');
  ok(rate[CAP - 1] > 0.15, 'the top cadence is not a stream', `${rate[CAP - 1].toFixed(2)}s between volleys`);
}

console.log('\n5. damage per volley, across the levels');
{
  // What the card is actually worth per second, ignoring targets. Not an
  // assertion about balance — a printout, because the interesting thing about
  // this weapon is that its output and its COVERAGE grow together, and a curve
  // that looks tame per blade can be steep once the ring closes.
  for (let l = 1; l <= CAP; l++) {
    const v = razorClamVolley(l, 0, null, noJitter);
    const dps = (v.count * v.damage) / v.fireRate;
    console.log(`     lvl ${l}: ${v.count} blades × ${v.damage} over ${(v.arc * 180 / Math.PI).toFixed(0)}°`
      + ` every ${v.fireRate.toFixed(2)}s  ->  ${dps.toFixed(0)} dmg/s before pierce`);
  }
  const first = razorClamVolley(1, 0, null, noJitter);
  const last = razorClamVolley(CAP, 0, null, noJitter);
  const growth = ((last.count * last.damage) / last.fireRate) / ((first.count * first.damage) / first.fireRate);
  ok(growth > 3 && growth < 30, 'the cap is worth 3x-30x the first pick before pierce',
    `measured ${growth.toFixed(1)}x`);
}

console.log('\n6. the asset the blades are thrown as');
{
  // Cheap, and it catches the two ways this ability renders nothing: a typo in
  // the asset key (createVisual warns and hands back an empty Object3D) and a
  // blade block that never reached the geometry builder.
  const def = CONFIG.trails?.razorBlade;
  ok(!!def, 'the blade has a trail entry keyed on its ASSET name');
  ok(CONFIG.emitPoints?.razorClam != null, 'the volley has an emit point');
  ok(!!CONFIG.chromeBlade, 'the chrome film has a config block');
  ok(!!CONFIG.feedback?.razorClamLaunch?.sfx && !!CONFIG.sfx?.[CONFIG.feedback.razorClamLaunch.sfx],
    'the launch sound exists in the bank');
}

console.log('\n7. the shell, the whip and the wake');
{
  // HOW BIG IT ACTUALLY IS. assets.csv is the only place a spawn size lives
  // (the Size slider is a readout), so a blade with no row — or a row somebody
  // reset to 1 — is a shell drawn at a third of the length the reach, the
  // ribbon and the roll were all tuned against.
  const size = bladeSize();
  const drawn = (ASSETS.razorBlade?.blade?.length ?? 0) * size;
  console.log(`     ${size}x on a ${ASSETS.razorBlade?.blade?.length}-unit shell  ->  ${drawn.toFixed(2)} units long,`
    + ` reach ${razorClamRadius().toFixed(2)}`);
  ok(size > 1.5, 'the shell is drawn much bigger than it is authored', `size ${size}`);
  // THE PAIR THAT MUST MEASURE ALIKE. The picture and the cut are one edit
  // apart in two different files, and a shell three times the size with the
  // old quarter-unit reach passes visibly through fish while every other check
  // in this file still comes up green.
  ok(Math.abs(razorClamRadius() - CONFIG.razorClam.radius * size) < 1e-9,
    'the reach is derived from the size rather than typed beside it');
  ok(razorClamRadius() > drawn * 0.15 && razorClamRadius() < drawn * 0.5,
    'the reach is a believable fraction of the shell it draws',
    `${razorClamRadius().toFixed(2)} against ${drawn.toFixed(2)} units of blade`);
  // The volley carries both, so the launch cannot pick up one and not the other.
  const v = razorClamVolley(3, 0, null, noJitter);
  ok(v.size === size && v.radius === razorClamRadius(), 'a volley hands over both');
}

{
  // THE WHIP, and the trap under it: `orient` and a roll are two Euler angles
  // on one object, and in three's default XYZ order the roll is applied AFTER
  // the heading — which swings the nose out of the screen plane. A blade fired
  // on a diagonal then flies broadside while still travelling on its heading,
  // which looks like a bad model rather than like a bad rotation order.
  const scene = new THREE.Scene();
  resetProjectiles(scene);
  const heading = Math.PI / 3;
  const dir = new THREE.Vector2(Math.cos(heading), Math.sin(heading));
  spawnProjectile(scene, {
    origin: new THREE.Vector3(0, 0, 0),
    dir,
    faction: 'player',
    damage: 1,
    speed: CONFIG.razorClam.speed,
    life: 5,
    radius: razorClamRadius(),
    asset: 'razorBlade',
    orient: 'axis',
    roll: 9,
    trailScale: bladeSize(),
  });
  const p = projectiles[0];
  ok(!!p, 'a blade goes into the water');
  ok(p.mesh.rotation.order === 'ZYX', 'a rolling shot is switched to the order that keeps its nose',
    `order ${p.mesh.rotation.order}`);

  const longAxis = new THREE.Vector3(0, 1, 0);
  const face = new THREE.Vector3(1, 0, 0);
  const noses = [];
  const faces = [];
  let worstNose = 0;
  for (let i = 0; i < 20; i++) {
    updateProjectiles(1 / 60, scene, [], [], {});
    const nose = longAxis.clone().applyEuler(p.mesh.rotation);
    // Against the shot's LIVE heading, not the one it launched on: a blade
    // arcs under gravity like everything else in the water, so the launch
    // direction stops being the answer within a few frames — and a test that
    // asserted against it would be measuring the arc and calling it a rotation
    // bug.
    worstNose = Math.max(worstNose, nose.distanceTo(new THREE.Vector3(p.dir.x, p.dir.y, 0)));
    noses.push(nose);
    faces.push(face.clone().applyEuler(p.mesh.rotation));
  }
  ok(worstNose < 1e-6, 'the blade still flies nose-first while it whips',
    `${worstNose.toFixed(6)} off its own heading at the worst frame`);
  ok(noses.every((n) => Math.abs(n.z) < 1e-9), '...and never leaves the screen plane',
    `worst z ${Math.max(...noses.map((n) => Math.abs(n.z))).toExponential(1)}`);
  // ...and the faces DO turn, which is the whole point: CONFIG.chromeBlade is
  // an environment the body has to sweep through before it shows a highlight.
  const swept = Math.max(...faces.map((f) => f.distanceTo(faces[0])));
  ok(swept > 0.5, 'the faces sweep through the light', `${swept.toFixed(2)} of travel on the face normal`);
  ok(Math.abs(p.rollAngle) > 0.5, 'the roll accumulates', `${p.rollAngle.toFixed(2)} rad in 20 frames`);
  // The ribbon is the other half of the size change — trailScale multiplies
  // the width and the shed rate, so it is the only channel a bigger shell has
  // on a preset it shares with nothing.
  ok(p.trailScale === bladeSize(), 'the ribbon is scaled to the shell');
  resetProjectiles(scene);
}

{
  // A fan whose blades all roll the same way at the same rate is one rigid
  // object being turned, and every chrome flash in the volley lands on the
  // same frame.
  let seed = 20260825;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const rolls = Array.from({ length: 12 }, () => razorClamRoll(rand));
  ok(rolls.some((r) => r > 0) && rolls.some((r) => r < 0), 'blades whip both ways',
    rolls.map((r) => r.toFixed(1)).join(', '));
  ok(new Set(rolls.map((r) => Math.abs(r).toFixed(2))).size > 6, '...at their own rates');
  const speeds = rolls.map(Math.abs);
  ok(Math.min(...speeds) > 1 && Math.max(...speeds) < 25,
    'every blade whips fast enough to read and slow enough to strobe',
    `${Math.min(...speeds).toFixed(1)} - ${Math.max(...speeds).toFixed(1)} rad/s`);
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
