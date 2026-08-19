#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:boom
//
// THE CLOUD A BOSS GOES UP IN — systems/bossBoom.js.
//
// This drives the real system against the real merged CONFIG and reads the
// answers back out of the real particle buffer, because every way this effect
// can be wrong is invisible from the code and silent at runtime — it renders
// SOMETHING in all of them:
//
//   THE WRONG CLOCK   The whole design is that the rings are scheduled on the
//                     WALL clock while the water is held at CONFIG.boss.kill.
//                     hold. Fed the dilated clock instead, the explosion still
//                     works — it just arrives eight times too late, which is
//                     several seconds AFTER the photograph it exists to be in.
//                     Nothing throws and the effect looks perfect in isolation.
//
//   MISSING THE SHOT  The lead has to be longer than the last wave's `at`, or
//                     the outermost ring is born after the shutter. Retuning
//                     either number alone breaks it, and the only symptom is a
//                     trophy photo of a smaller cloud than the one on screen.
//
//   BEADS, NOT SMOKE  A ring only fuses into an edge if neighbours still
//                     overlap at that radius. Widen a ring or thin its puffs
//                     and the goo pass thresholds a string of separate round
//                     dots — a plausible-looking effect that reads as bubbles.
//                     Checked as arithmetic against the group's own `radius`,
//                     because no Node harness can see the pass itself.
//
//   THE WRONG SIZE    Sized off the measured body, and the fallback for a body
//                     with no hitbox is what matters: the king crab has none
//                     and is the biggest boss in the game, so a fallback to its
//                     collision radius gives the largest animal the smallest
//                     cloud.
//
//   FIRING FOREVER    The trigger in systems/bossCorpse.js is a threshold that
//                     stays true for the rest of the hold. Without the latch it
//                     is twenty explosions, which at this size is one solid
//                     white frame.
//
// Everything expected is derived from CONFIG. imported-tuning.json is merged at
// import and wins over config.js, so a literal here would test the tuning file
// rather than the code.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';
import {
  fireBossBoom, updateBossBooms, resetBossBooms, bossBoomCount, bossBoomLead, measureBossBody,
} from '../path/src/systems/bossBoom.js';

const scene = new THREE.Scene();
initParticles(scene);

const points = scene.children.find((c) => c.isPoints);
const attrs = points.geometry.attributes;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const BOOM = CONFIG.boss.boom;
const WAVES = BOOM.waves;
const GROUP = CONFIG.fx.goo.groups.boom;
// The index the `boom` group rides in the aGoo attribute: 0 means "not goo",
// so a group's flag is its position in the object plus one. Derived rather than
// typed, because adding a group above it in config.js renumbers every one after.
const GROUP_INDEX = Object.keys(CONFIG.fx.goo.groups).indexOf('boom') + 1;

const DT = 1 / 60;

// SEEDED, and it is load-bearing rather than tidy. The ring phase and the
// jitter are rolled per puff and every size and speed inside emit() is rolled
// per particle, so two detonations of the same explosion differ by several
// percent — enough that "a 16-unit body spreads exactly 4x a 4-unit one" is a
// statement about the dice unless both runs roll the same ones. Reseeded before
// each detonation below.
let seed = 0;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = () => { seed = 0xb0551f00; };

// A body with no hitbox and no visual, which is the branch that falls through
// to the collision radius — the one measurement this harness can make without
// a loaded model.
const body = (r, at = [0, 0]) => ({
  mesh: { position: { x: at[0], y: at[1] } },
  radius: r,
  assetKey: '__none__',
  vx: 0,
  vy: 0,
});

// Every particle in the buffer that belongs to this effect, as {x, y, size}.
// Read off the real attributes: a burst that emitted into the wrong group, or
// with the size multiplier dropped, is invisible to anything that counts calls.
function lobes() {
  const out = [];
  for (let i = 0; i < attrs.aGoo.count; i++) {
    if (attrs.aGoo.array[i] !== GROUP_INDEX) continue;
    // A slot that has been retired rather than filled.
    if (attrs.aStart.array[i] < -1e8) continue;
    out.push({
      x: attrs.position.array[i * 3],
      y: attrs.position.array[i * 3 + 1],
      size: attrs.aSize.array[i],
    });
  }
  return out;
}

function detonate(r, { dt = DT, seconds = null, at = [0, 0] } = {}) {
  resetParticles();
  resetBossBooms();
  reseed();
  fireBossBoom(body(r, at));
  const total = seconds ?? bossBoomLead();
  for (let t = 0; t < total; t += dt) updateBossBooms(dt);
  return lobes();
}

console.log('\nboss boom\n');

// --- THE SCHEDULE -----------------------------------------------------------
console.log('the schedule');

check('the last ring is born before the shutter',
  Math.max(...WAVES.map((w) => w.at ?? 0)) < bossBoomLead(),
  `last wave at ${Math.max(...WAVES.map((w) => w.at ?? 0))}s, lead ${bossBoomLead()}s`);

{
  const all = detonate(10);
  const expected = WAVES.reduce((n, w) => n + Math.round(w.puffs ?? 8) * (CONFIG.emitters.bossBoom.count ?? 3), 0);
  check('every wave is out by the shutter', all.length === expected,
    `${all.length} lobes, expected ${expected}`);
  check('nothing is left queued', bossBoomCount() === 0, `${bossBoomCount()} still live`);
}

// THE CLOCK. Advanced by the DILATED delta instead — the same total wall time,
// scaled the way the water is during the held beat — and the cloud is barely
// born. This is the bug the whole design exists to avoid, stated as a number.
{
  resetParticles();
  resetBossBooms();
  fireBossBoom(body(10));
  const hold = CONFIG.boss.kill.hold ?? 0.12;
  for (let t = 0; t < bossBoomLead(); t += DT) updateBossBooms(DT * hold);
  const onWater = lobes().length;
  const onWall = detonate(10).length;
  check('the water\'s clock would not have delivered it', onWater < onWall,
    `${onWater} lobes on the dilated clock vs ${onWall} on the wall — the rings are ${(onWall / Math.max(1, onWater)).toFixed(1)}x behind`);
}

// A frame long enough to cross two waves fires both, rather than dropping one.
{
  const oneBigFrame = detonate(10, { dt: bossBoomLead() });
  const sixtyHz = detonate(10);
  check('a dropped frame costs the shape, never a ring',
    oneBigFrame.length === sixtyHz.length,
    `${oneBigFrame.length} lobes in one frame vs ${sixtyHz.length} at 60Hz`);
}

// --- THE SIZE ---------------------------------------------------------------
console.log('\nthe size');

{
  const small = detonate(4);
  const big = detonate(16);
  const spread = (ls) => Math.max(...ls.map((l) => Math.hypot(l.x, l.y)));
  const ratio = spread(big) / spread(small);
  check('the cloud is scaled by the body', Math.abs(ratio - 4) < 0.01,
    `a 16-unit body spreads ${ratio.toFixed(2)}x a 4-unit one, expected 4`);
  const lobeRatio = Math.max(...big.map((l) => l.size)) / Math.max(...small.map((l) => l.size));
  check('...and so are the lobes', Math.abs(lobeRatio - 4) < 0.01,
    `${lobeRatio.toFixed(2)}x, expected 4 — sizeMul is what carries this and it is easy to drop`);
}

{
  // Both clamps, through the real entry point.
  const below = detonate(0.5);
  const atFloor = detonate(BOOM.minRadius);
  const above = detonate(100);
  const atCeiling = detonate(BOOM.maxRadius);
  const spread = (ls) => Math.max(...ls.map((l) => Math.hypot(l.x, l.y)));
  check('a tiny body is floored', Math.abs(spread(below) - spread(atFloor)) < 1e-3,
    `${spread(below).toFixed(2)} vs ${spread(atFloor).toFixed(2)}`);
  check('a huge one is capped', Math.abs(spread(above) - spread(atCeiling)) < 1e-3,
    `${spread(above).toFixed(2)} vs ${spread(atCeiling).toFixed(2)}`);
  check('the roster measures INSIDE the clamps',
    BOOM.maxRadius > 16.8 && BOOM.minRadius < 12.5,
    `the megalodon measures 16.8 and the kraken 12.5; a ceiling inside that band `
    + `makes every boss go up the same size (clamps are [${BOOM.minRadius}, ${BOOM.maxRadius}])`);
}

check('a body with no hitbox is still measured', (() => {
  const m = measureBossBody(body(6));
  return m != null && m.r === 6;
})(), 'the collision-radius fallback is the last resort and must still answer');

check('nothing to measure is nothing fired', fireBossBoom({}) === false);

// --- FUSION -----------------------------------------------------------------
// The arithmetic a Node harness CAN do about a screen-space metaball: whether
// neighbours in a ring are still within a lobe of each other. The emitter rolls
// a size per particle, so the check uses the SMALLEST it can roll — a ring that
// only fuses on a lucky roll is a ring that beads half the time.
console.log('\nfusion — every ring must still overlap itself');
{
  const minSize = CONFIG.emitters.bossBoom.size[0];
  const lobeDiameter = (w) => minSize * (w.lobe ?? 0.3) * (GROUP.radius ?? 3.2);
  for (const [i, w] of WAVES.entries()) {
    const spacing = (2 * Math.PI * (w.ring ?? 1)) / Math.max(1, Math.round(w.puffs ?? 8));
    const dia = lobeDiameter(w);
    check(`ring ${i} (r=${w.ring}, ${w.puffs} puffs)`, dia > spacing,
      `lobes ${dia.toFixed(3)} across, spaced ${spacing.toFixed(3)} apart — `
      + `raise puffs or lobe until the first number is the larger`);
  }
  // ...and consecutive rings have to reach each other, or the cloud is a set of
  // concentric shells rather than one body.
  for (let i = 1; i < WAVES.length; i++) {
    const gap = (WAVES[i].ring ?? 1) - (WAVES[i - 1].ring ?? 1);
    const reach = (lobeDiameter(WAVES[i]) + lobeDiameter(WAVES[i - 1])) / 2;
    check(`ring ${i - 1} reaches ring ${i}`, reach > gap,
      `${gap.toFixed(3)} between them, ${reach.toFixed(3)} of lobe to cross it`);
  }
}

// --- THE SURFACE ------------------------------------------------------------
console.log('\nthe surface');

check('the isoline is below 1', (GROUP.iso ?? 1) < 1,
  `iso ${GROUP.iso} — a splat peaks at exactly 1.0 by construction, so at or above `
  + 'it a lone lobe renders NOTHING and only overlaps show');
check('the outline is a DARK band', (GROUP.rim ?? 0) < 0,
  `rim ${GROUP.rim} — the threshold shader does col * (1 + rim), so a positive value `
  + 'is the wet highlight the liquid groups want and this one is a cel outline');
check('it hides what is behind it', GROUP.additive !== true,
  'alpha, not additive — the body bursts into gibs under this cloud and must not be seen doing it');
check('no specular', (GROUP.spec ?? 0) === 0, 'a highlight off the density gradient is wetness');

// --- THE COLOUR -------------------------------------------------------------
// The lift is the difference between a visible cloud and a black one. Every
// boss in the roster is a near-black hide.
console.log('\nthe colour');
{
  const t = BOOM.tint ?? {};
  check('the tint is lifted clear of the water', (t.lightness ?? 0) > 0.6,
    `lightness ${t.lightness} — the roster is #bababa, #22303c, #2a0f14, #0d1016, and the `
    + 'composite drops every one of them about a stop and a half further');
  check('saturation has no floor', t.minSaturation === undefined,
    'a floor gives the megalodon — hue 0, saturation 0 — a bright red explosion');
  check('...and does have a ceiling', (t.maxSaturation ?? 1) < 1,
    `maxSaturation ${t.maxSaturation}`);
}

// --- THE LATCH --------------------------------------------------------------
// The threshold in systems/bossCorpse.js stays true for the rest of the hold,
// so the guard against re-firing is the only thing between one explosion and
// twenty. Modelled here rather than driven through updateBossCorpses, which
// needs a posed creature this harness has no model to build.
console.log('\nfiring once');
{
  const rec = { left: CONFIG.boss.corpse.afterShot + bossBoomLead() + 0.2, boomed: false };
  const threshold = (CONFIG.boss.corpse.afterShot ?? 0.18) + bossBoomLead();
  resetParticles();
  resetBossBooms();
  let fired = 0;
  for (let i = 0; i < 60; i++) {
    rec.left -= DT;
    if (!rec.boomed && rec.left <= threshold) {
      rec.boomed = true;
      fired += 1;
      fireBossBoom(body(10));
    }
  }
  check('one boss, one explosion', fired === 1, `${fired} fired across a second of hold`);
}

// A reset drops queued rings rather than firing them over a menu.
{
  resetParticles();
  resetBossBooms();
  fireBossBoom(body(10));
  updateBossBooms(DT);
  const midFlight = bossBoomCount();
  resetBossBooms();
  const after = lobes().length;
  updateBossBooms(1);
  check('a reset drops the rings still queued',
    midFlight === 1 && bossBoomCount() === 0 && lobes().length === after,
    `${midFlight} in flight, ${bossBoomCount()} after the reset`);
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
