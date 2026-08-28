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
//   INSIDE THE ANIMAL The bands are struck off the measured SILHOUETTE now, not
//                     rings about the centroid, so that the cloud is an aura
//                     round the boss instead of a wash across it. Every way of
//                     getting that wrong draws a perfectly good explosion: a
//                     rim clamped by `maxRadius` lands several units inside
//                     every boss in the roster, harmonics applied to the
//                     distance rather than to the stand-off push a third of
//                     each band back through the body, and lobes spaced by
//                     ANGLE rather than by ARC crowd a shark's nose and leave
//                     thirty units of flank bare.
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
  measureBossRim, bossBoomBands,
} from '../path/src/systems/bossBoom.js';
import { attachHitShape, tickHitShapes } from '../path/src/systems/hitShape.js';

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

// A LONG ANIMAL WITH A REAL HITBOX, built out of primitives rather than loaded.
//
// The rim is measured off the posed hitbox spheres, so the whole shape half of
// this file is unreachable from the point-and-radius body above — that one has
// no hitbox at all and measures as a circle, which is exactly the fallback and
// exactly not the thing worth checking. This runs the real attachHitShape over
// a real mesh: five stretched spheres in a line, which is the same chain of
// overlapping balls a shark's spine bins into and needs no model on disk.
function longBody(halfLength = 6, halfThick = 1.2, at = [0, 0]) {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial());
    m.position.set((i / 4 - 0.5) * 2 * (halfLength - halfThick), 0, 0);
    m.scale.set(halfThick, halfThick, halfThick);
    g.add(m);
  }
  g.position.set(at[0], at[1], 0);
  g.updateMatrixWorld(true);
  const shape = attachHitShape(g, `__long_${halfLength}_${halfThick}__`);
  tickHitShapes();
  return {
    mesh: g,
    visual: g,
    hitShape: shape,
    radius: halfLength,
    assetKey: '__none__',
    vx: 0,
    vy: 0,
  };
}

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

check('...and so is the last puff of it', (() => {
  const last = Math.max(...WAVES.map((w) => w.at ?? 0)) + (BOOM.organic?.stagger ?? 0);
  return last < bossBoomLead();
})(), `last wave ${Math.max(...WAVES.map((w) => w.at ?? 0))}s + stagger `
  + `${BOOM.organic?.stagger ?? 0}s vs lead ${bossBoomLead()}s — a ring is spread over a `
  + 'few frames now, and the tail of it still has to be in the photograph');

check('the front is out before the shutter too', (() => {
  const rings = BOOM.shock?.rings ?? [];
  if (BOOM.shock?.enabled === false || !rings.length) return true;
  return rings.every((r) => (r.at ?? 0) + (r.seconds ?? 0.26) <= bossBoomLead() + 0.001);
})(), 'a shockwave still expanding when the picture is taken is a photograph of a hoop');

{
  const all = detonate(10);
  // ASKED, NOT REIMPLEMENTED. On a rim the puff counts are derived from the
  // band's own perimeter, so a literal here — or a second copy of the
  // arithmetic — would be testing this file rather than the effect.
  const plan = bossBoomBands(body(10));
  const expected = plan.bands.reduce((n, b) => n + b.puffs * (CONFIG.emitters.bossBoom.count ?? 3), 0);
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
  // MEASURED AT THE CLAMPS, and derived from them rather than typed. The
  // property here is that the cloud scales LINEARLY with the body it is
  // measured off; a hardcoded pair either side of the ceiling tests the CLAMP
  // instead, and reports the ratio of the clamps as a scaling bug. The two
  // endpoints of the live band are inside it by definition, wherever the band
  // is tuned to.
  const lo = BOOM.minRadius;
  const hi = BOOM.maxRadius;
  const want = hi / lo;
  const small = detonate(lo);
  const big = detonate(hi);
  const spread = (ls) => Math.max(...ls.map((l) => Math.hypot(l.x, l.y)));
  const ratio = spread(big) / spread(small);
  check('the cloud is scaled by the body', Math.abs(ratio - want) < 0.01,
    `a ${hi}-unit body spreads ${ratio.toFixed(2)}x a ${lo}-unit one, expected ${want.toFixed(2)}`);
  const lobeRatio = Math.max(...big.map((l) => l.size)) / Math.max(...small.map((l) => l.size));
  check('...and so are the lobes', Math.abs(lobeRatio - want) < 0.01,
    `${lobeRatio.toFixed(2)}x, expected ${want.toFixed(2)} — sizeMul is what carries this and it is easy to drop`);
}

{
  // Both clamps, through the real entry point.
  const below = detonate(0.5);
  const atFloor = detonate(BOOM.minRadius);
  const above = detonate(100);
  const atCeiling = detonate(BOOM.maxRadius);
  const spread = (ls) => Math.max(...ls.map((l) => Math.hypot(l.x, l.y)));
  const biggest = (ls) => Math.max(...ls.map((l) => l.size));
  check('a tiny body is floored', Math.abs(spread(below) - spread(atFloor)) < 1e-3,
    `${spread(below).toFixed(2)} vs ${spread(atFloor).toFixed(2)}`);
  // TWO CLAMPS NOW, AND THEY BOUND DIFFERENT THINGS — see sizeBoom.
  //
  // `maxRadius` caps HOW MUCH SMOKE: the lobes, the throw and how far the bands
  // stand off the skin. It cannot also cap where the skin IS, because the tuned
  // ceiling sits below every boss in the roster and a rim placed at it would be
  // drawn several units inside every one of them. So the SIZE is what this
  // asserts is capped, and the rim gets a rail of its own below.
  // Read off the real derivation rather than off the buffer: a rim gives the
  // two bodies different puff COUNTS, so the largest of a hundred rolled lobe
  // sizes and the largest of sixty differ by a percent or two even when the
  // clamp is working perfectly.
  check('a huge one is capped',
    bossBoomBands(body(100)).r === bossBoomBands(body(BOOM.maxRadius)).r,
    `${bossBoomBands(body(100)).r} vs ${bossBoomBands(body(BOOM.maxRadius)).r}`);
  check('...which is what sizes the lobes', biggest(above) > 0 && biggest(atCeiling) > 0,
    `${biggest(above).toFixed(3)} / ${biggest(atCeiling).toFixed(3)}`);
  if (BOOM.rim?.enabled !== false) {
    const atBodyCap = detonate(BOOM.rim?.maxBody ?? 24);
    check('...and the rim has a rail of its own',
      Math.abs(spread(above) - spread(atBodyCap)) < 1e-3,
      `${spread(above).toFixed(2)} vs ${spread(atBodyCap).toFixed(2)} at maxBody `
      + `${BOOM.rim?.maxBody ?? 24} — without it a nonsense measurement draws a ring `
      + 'across the whole arena');
  }
  // THE CEILING IS INSIDE THE ROSTER, ON PURPOSE. This check used to require
  // maxRadius > 16.8 so that the whole roster — kraken 12.5 to megalodon 16.8 —
  // landed below the cap and kept its range. The tuned ceiling is lower than
  // that now, which is a deliberate look decision and not drift, so the check
  // no longer asserts the range: every boss measuring at or above the ceiling
  // DOES go up the same size, and only bodies under it vary.
  //
  // What is still worth guarding is that the band has not collapsed at both
  // ends. A floor at or above the ceiling silently pins every explosion in the
  // game — bosses and the small bodies alike — to one radius, and that renders
  // perfectly.
  check('the clamps are a real band',
    BOOM.minRadius < BOOM.maxRadius,
    `clamps are [${BOOM.minRadius}, ${BOOM.maxRadius}] — the ceiling sits inside the `
    + `roster (kraken 12.5, megalodon 16.8), so bosses at or above it share one size`);
}

check('a body with no hitbox is still measured', (() => {
  const m = measureBossBody(body(6));
  return m != null && m.r === 6;
})(), 'the collision-radius fallback is the last resort and must still answer');

check('nothing to measure is nothing fired', fireBossBoom({}) === false);

// --- FUSION -----------------------------------------------------------------
// The arithmetic a Node harness CAN do about a screen-space metaball: whether
// neighbours in a band are still within a lobe of each other. The emitter rolls
// a size per particle, so the check uses the SMALLEST it can roll — a band that
// only fuses on a lucky roll is a band that beads half the time.
//
// THE COUNTS ARE DERIVED ON A RIM, so the question this asks changes shape with
// the mode. With rings about the centre it is "did the author write enough
// puffs"; with bands on a silhouette the count is computed FROM the fusion
// condition and cannot be too low — the thing that can go wrong instead is the
// particle budget biting, which pins a band at `maxPuffs` and beads it silently.
console.log('\nfusion — every band must still overlap itself');
{
  const minSize = CONFIG.emitters.bossBoom.size[0];
  const lobeDiameter = (w) => minSize * (w.lobe ?? 0.3) * (GROUP.radius ?? 3.2);
  const worstLobe = 1 - (BOOM.organic?.lobeVary ?? 0) / 2;

  if (BOOM.rim?.enabled === false) {
    for (const [i, w] of WAVES.entries()) {
      const spacing = (2 * Math.PI * (w.ring ?? 1)) / Math.max(1, Math.round(w.puffs ?? 8));
      const dia = lobeDiameter(w);
      check(`ring ${i} (r=${w.ring}, ${w.puffs} puffs)`, dia > spacing,
        `lobes ${dia.toFixed(3)} across, spaced ${spacing.toFixed(3)} apart — `
        + `raise puffs or lobe until the first number is the larger`);
    }
    // ...AND THE SAME RING AT ITS UNLUCKIEST. Every lobe is rolled a size of its
    // own now (CONFIG.boss.boom.organic.lobeVary), so the bar above describes a
    // ring nothing in the game ever draws: two neighbours can both come out at
    // the bottom of that roll.
    //
    // `lumps` is deliberately absent from the arithmetic, and that is a fact
    // about the code rather than an omission: a bulge scales the lobes by the
    // same factor it scales the spacing (see buildPuffs), so the harmonics
    // cannot bead a ring at any depth. `jitter` is absent for the reason it
    // always was — it displaces radially, where fusion is held by the
    // neighbouring RING.
    for (const [i, w] of WAVES.entries()) {
      const spacing = (2 * Math.PI * (w.ring ?? 1)) / Math.max(1, Math.round(w.puffs ?? 8));
      const dia = lobeDiameter(w) * worstLobe;
      check(`ring ${i} at the bottom of the size roll`, dia > spacing,
        `lobes ${dia.toFixed(3)} across at ${worstLobe.toFixed(2)}x, spaced ${spacing.toFixed(3)} apart`);
    }
    for (let i = 1; i < WAVES.length; i++) {
      const gap = (WAVES[i].ring ?? 1) - (WAVES[i - 1].ring ?? 1);
      const reach = (lobeDiameter(WAVES[i]) + lobeDiameter(WAVES[i - 1])) / 2;
      check(`ring ${i - 1} reaches ring ${i}`, reach > gap,
        `${gap.toFixed(3)} between them, ${reach.toFixed(3)} of lobe to cross it`);
    }
  } else {
    // THE TWO SHAPES THAT BOUND THE ROSTER. A round body is the longest
    // perimeter a given reach can have and a long one is close to the shortest,
    // so a derivation that fuses on both fuses on everything between.
    const cap = Math.max(1, Math.round(BOOM.rim?.maxPuffs ?? 34));
    const size = Math.max(0, BOOM.size ?? 1);
    for (const [name, subject] of [
      ['a round body', body(10)],
      ['a long one', longBody(12, 2.2)],
    ]) {
      const plan = bossBoomBands(subject);
      for (const [i, band] of plan.bands.entries()) {
        // The band's own perimeter in world units, asked of the measured loop
        // rather than of a circle — that difference IS the feature.
        const perim = plan.rim.len * plan.br + 2 * Math.PI * band.off * plan.r * size;
        const spacing = perim / band.puffs;
        const dia = plan.r * size * lobeDiameter(band.w) * worstLobe;
        check(`${name}, band ${i} at the bottom of the size roll`, dia > spacing,
          `lobes ${dia.toFixed(3)} across at ${worstLobe.toFixed(2)}x, spaced `
          + `${spacing.toFixed(3)} apart over ${perim.toFixed(1)} units of band`);
      }
      // AND THE BUDGET MUST NOT BE WHAT DECIDED IT. A band pinned at `maxPuffs`
      // has stopped being derived and is a fixed count again, on a perimeter
      // nobody checked — which is the old bug with a new name.
      const pinned = plan.bands.filter((b) => b.puffs >= cap).length;
      check(`${name} is not pinned at the particle cap`, pinned === 0,
        `${pinned}/${plan.bands.length} bands at maxPuffs ${cap} — raise it, or `
        + 'thin the bands, or the outermost one beads');
    }
    // ...and consecutive bands have to reach each other across the gap between
    // them, or the aura is a set of concentric shells rather than one body.
    {
      const plan = bossBoomBands(body(10));
      for (let i = 1; i < plan.bands.length; i++) {
        const gap = (plan.bands[i].off - plan.bands[i - 1].off) * plan.r * size;
        const reach = plan.r * size
          * (lobeDiameter(plan.bands[i].w) + lobeDiameter(plan.bands[i - 1].w)) / 2;
        check(`band ${i - 1} reaches band ${i}`, reach > gap,
          `${gap.toFixed(3)} between them, ${reach.toFixed(3)} of lobe to cross it`);
      }
    }
  }
}

// --- THE EDGE OF THE ANIMAL -------------------------------------------------
// The rim itself. Every check here fails as a perfectly good-looking explosion.
if (BOOM.rim?.enabled !== false) {
  console.log('\nthe edge of the animal');
  const rc = BOOM.rim ?? {};

  {
    const e = longBody(12, 2.2);
    const m = measureBossBody(e);
    const rim = measureBossRim(e, m, rc);
    check('a long animal measures as a long loop', !!rim && rim.d.length === (rc.samples ?? 48));
    // The loop is normalised to a peak of 1 so that one multiply turns it into
    // world units — the rule every other number in the file follows.
    const peak = Math.max(...rim.d);
    check('...normalised to a peak of 1', Math.abs(peak - 1) < 1e-9, `peak ${peak}`);
    // ALONG vs ACROSS. Sampled at 0 and PI/2, which for a body lying on x is the
    // nose and the flank. A loop that came out round here is a loop that
    // measured nothing and fell back to the circle, which is the failure that
    // looks most like success.
    const along = rim.d[0];
    const across = rim.d[Math.round((rc.samples ?? 48) / 4)];
    check('...longer along the body than across it', along > across * 1.5,
      `${along.toFixed(3)} along vs ${across.toFixed(3)} across — a round loop here `
      + 'means the hitbox was never read and every boss wears a circle');
  }

  {
    // A CIRCLE IS THE FALLBACK, NOT AN ERROR. The king crab has no hitbox at
    // all and is the biggest boss in the game; measuring nothing has to give
    // back the shape this effect had before, not null.
    const e = body(8);
    const rim = measureBossRim(e, measureBossBody(e), rc);
    const spreadD = Math.max(...rim.d) - Math.min(...rim.d);
    check('a body with no hitbox measures as a circle', spreadD < 1e-9,
      `${spreadD.toFixed(6)} of variation round the loop`);
  }

  {
    // THE NORMALS POINT OUT. Rotating the tangent the wrong way is a sign flip
    // that fires every band INWARD — a cloud drawn entirely inside the animal,
    // which from the outside is a boss that went up in almost no smoke.
    const e = longBody(12, 2.2);
    const rim = measureBossRim(e, measureBossBody(e), rc);
    let out = 0;
    for (let i = 0; i < rim.n; i++) {
      if (rim.nx[i] * rim.px[i] + rim.ny[i] * rim.py[i] > 0) out += 1;
    }
    check('every normal points away from the body', out === rim.n,
      `${out}/${rim.n} outward`);
  }

  {
    // NOTHING IS BORN INSIDE THE SILHOUETTE. The whole point, stated against
    // the real particle buffer: every lobe of a real detonation has to be at
    // least at the skin, allowing for the innermost band's own `hug`.
    //
    // Measured along the ray each lobe sits on rather than against one radius,
    // because on a long body "outside the animal" is a different distance in
    // every direction — checking against the reach would pass a cloud sitting
    // in the middle of the flank.
    const e = longBody(12, 2.2, [3, -2]);
    const plan = bossBoomBands(e);
    const m = plan.m;
    const rim = plan.rim;
    resetParticles();
    resetBossBooms();
    reseed();
    fireBossBoom(e);
    for (let t = 0; t < bossBoomLead(); t += DT) updateBossBooms(DT);
    const ls = lobes();
    // WHERE THE SKIN IS, as the polygon the effect actually used rather than
    // as a radius. Sampling the loop by angle would quantise a long body badly
    // enough at the ends to fail a correct cloud, and comparing against the
    // reach would pass one sitting in the middle of the flank.
    const poly = [];
    for (let i = 0; i < rim.n; i++) {
      poly.push([m.x + rim.px[i] * plan.br, m.y + rim.py[i] * plan.br]);
    }
    const depthInside = (x, y) => {
      let inside = false;
      let near = Infinity;
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[k];
        if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
        const ex = bx - ax;
        const ey = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
        near = Math.min(near, Math.hypot(x - (ax + ex * t), y - (ay + ey * t)));
      }
      return inside ? near : 0;
    };
    // The two things that can legitimately pull a lobe back through the skin,
    // and nothing else: the harmonics riding the innermost band's own `hug`,
    // and half a band's worth of per-puff jitter. Anything deeper than the pair
    // of them is placement rather than noise.
    const bandStep = Math.abs((rc.reach ?? 0.6) - (rc.hug ?? 0.02))
      / Math.max(1, WAVES.length - 1);
    const slack = ((rc.hug ?? 0.02) * (BOOM.organic?.lumps ?? 0)
      + (bandStep * Math.max(...WAVES.map((w) => w.jitter ?? 0))) / 2)
      * plan.r * Math.max(0, BOOM.size ?? 1);
    let inside = 0;
    let worst = 0;
    for (const l of ls) {
      const depth = depthInside(l.x, l.y);
      if (depth > slack) { inside += 1; worst = Math.max(worst, depth); }
    }
    check('no lobe is born inside the silhouette', inside === 0,
      `${inside}/${ls.length} lobes deeper than ${slack.toFixed(2)} units in, worst `
      + `${worst.toFixed(2)} — this is the whole feature: a cloud that starts at the `
      + 'centroid photographs the animal as a wash');
    check('...and the aura went off at all', ls.length > 0, 'no lobes emitted');
  }

  {
    // SPACED BY ARC, NOT BY ANGLE. On a long body the two are nowhere near each
    // other, and the angular build leaves most of the flank bare while crowding
    // the nose — which still renders as a fused cloud and still reads wrong.
    // Checked as the ratio between the widest and narrowest gap between
    // neighbouring lobes of one band, which for equal angles on a 5:1 body is
    // several times what it is for equal arc.
    const e = longBody(12, 2.4);
    const m = measureBossBody(e);
    const rim = measureBossRim(e, m, rc);
    const seg = [];
    for (let i = 0; i < rim.n; i++) {
      const j = (i + 1) % rim.n;
      seg.push(Math.hypot(rim.px[j] - rim.px[i], rim.py[j] - rim.py[i]));
    }
    const byAngle = Math.max(...seg) / Math.min(...seg);
    check('an even walk round the loop is not an even walk round the angles',
      byAngle > 2,
      `the loop's own samples are ${byAngle.toFixed(1)}x further apart at one end than `
      + 'the other, which is exactly the error equal-angle spacing would bake in');
  }
}

// --- THE SURFACE ------------------------------------------------------------
console.log('\nthe surface');

check('the isoline is below 1', (GROUP.iso ?? 1) < 1,
  `iso ${GROUP.iso} — a splat peaks at exactly 1.0 by construction, so at or above `
  + 'it a lone lobe renders NOTHING and only overlaps show');
// THE BODY HAS TO BE VISIBLE THROUGH IT. This is the whole reason the group is
// additive: the explosion is centred on the boss and fires a third of a second
// before the photograph, so an opaque cloud big enough to read as an explosion
// photographs the animal as a hole. Both halves are asserted because either one
// alone brings it back — additive at opacity 1 is still a wall of light.
check('the cloud is LIGHT, not substance', GROUP.additive === true,
  'additive — it adds to the animal instead of standing in front of it');
check('...and it is not opaque', (GROUP.opacity ?? 1) <= 0.7,
  `opacity ${GROUP.opacity} — the silhouette reads through the brightest part of the blast`);
// The dark cel outline is gone with the alpha, and cannot come back: additive
// light has no way to be darker than the water it lands on. A negative rim here
// is therefore not a look, it is a value that does nothing.
check('the rim is a light edge', (GROUP.rim ?? 0) > 0,
  `rim ${GROUP.rim} — the threshold shader does col * (1 + rim), and on an additive `
  + 'surface only a positive value draws anything at all');
// The ceiling here follows the tuned value rather than config.js's declared
// 0.06 — the softer edge is a look decision taken in the panel. It is still a
// ceiling and not an open door: past roughly a quarter of the density range the
// cloud stops reading as drawn smoke and becomes fog, which is the failure this
// line exists for.
check('the edge is still hard', (GROUP.soft ?? 1) <= 0.22,
  `soft ${GROUP.soft} — the cel read moved from the outline to the edge hardness, `
  + 'and a wide transition here is what turns the cloud into fog');
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
