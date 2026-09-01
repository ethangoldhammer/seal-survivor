// CALAMARI RING — the ride-along, the carry, and the squid.
//
// npm run test:upgrades proves the card stacks and npm run test:abilities proves
// the wave fires. Neither can see anything checked here, because all of it is
// motion: where the ring's CENTRE is after a second of swimming, and what the
// squid do with the seal's momentum once they let go.
//
// Three of these fail silently in play and are the reason the file exists:
//
//   THE CARRY ORDER. `follow` reels the ring back to the seal and `carry`
//   throws it forward. Spend them in the wrong order on a frame and they
//   cancel — the ring looks welded, the carry slider does nothing, and nothing
//   errors.
//
//   FRAMERATE. `follow` is a rate through an exponential, not a fraction per
//   frame. Written as a fraction it works on the machine it was tuned on and
//   the ring lags on a slower one, which is invisible unless measured.
//
//   THE POOLED SQUID'S SCALE. A squid fades out by shrinking, goes back to the
//   pool at nearly zero, and comes out again on the next wave. Multiply its
//   size on the way out instead of setting it and the second wave's squid are
//   microscopic — on screen, indistinguishable from a wave that just didn't
//   spawn any.
//
//   node --import ./tools/vite-loader.mjs tools/calamari-test.mjs

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { player } from '../path/src/entities/player.js';
import {
  updateCalamari, resetCalamari, calamariSquidCount, calamariDebug,
  currentCalamariStats, CALAMARI_ASSETS,
} from '../path/src/systems/calamari.js';
import { ASSETS } from '../path/src/assets.js';
import { damageGlowCfg, glowLevel } from '../path/src/systems/damageGlow.js';

const c = CONFIG.calamari;
const CAP = CONFIG.upgrades.find((u) => u.id === 'calamari')?.maxStacks ?? 8;

let failures = 0;
function ok(cond, label, detail = '') {
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`); }
}

const scene = new THREE.Scene();
const pos = new THREE.Vector3(0, 0, 0);

// The system reads player.velocity and player.stats directly. Stats stay empty
// so the level curve is the raw config one — this file is about motion, and a
// Splash Zone multiplier folded in would only make the numbers harder to read.
player.stats = {};

function run(level, { seconds, dt = 1 / 60, vel = [0, 0], move = [0, 0] } = {}) {
  resetCalamari(scene);
  pos.set(0, 0, 0);
  player.velocity.set(vel[0], vel[1]);
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    pos.x += move[0] * dt;
    pos.y += move[1] * dt;
    updateCalamari(dt, scene, pos, level, [], {});
  }
  return calamariDebug();
}

console.log('\n1. the asset it builds');
{
  ok(CALAMARI_ASSETS.length > 0, 'the system names the bodies it can build');
  for (const k of CALAMARI_ASSETS) ok(!!ASSETS[k], `"${k}" is a real asset key`);
}

console.log('\n2. how many squid a stack buys');
{
  const counts = [];
  for (let l = 1; l <= CAP; l++) counts.push(calamariSquidCount(l));
  console.log(`     ${counts.join(', ')}`);
  ok(calamariSquidCount(0) === 0, 'an unpicked card flings nothing');
  ok(counts[0] === Math.round(c.squidBase), 'level 1 is the configured base');
  ok(counts.every((n, i) => i === 0 || n >= counts[i - 1]), 'the count never goes down');
  // The whole ask: stacks have to be legible in the water.
  ok(counts[CAP - 1] > counts[0], 'the last stack flings visibly more than the first',
    `${counts[0]} -> ${counts[CAP - 1]}`);
  ok(counts.every((n) => n <= c.squidMax), `never past squidMax (${c.squidMax})`);
  ok(calamariSquidCount(200) <= c.squidMax, 'a level far past the cap still clamps');
}

console.log('\n3. the ring rides with the seal');
{
  // A wave only lives about maxRadius/speed seconds, so this is a short swim,
  // not a long one — measure it after the wave is gone and there is nothing to
  // measure. The control is the OLD behaviour: follow = 0 leaves the ring in
  // the water exactly where it was fired.
  const SECONDS = 0.3;
  const SPEED = 12;
  const travelled = SPEED * SECONDS;

  const saved = c.follow;
  c.follow = 0;
  const pinned = run(1, { seconds: SECONDS, move: [SPEED, 0] });
  const pinnedLag = pos.x - pinned.waves[0].mesh.position.x;
  c.follow = saved;

  const rode = run(1, { seconds: SECONDS, move: [SPEED, 0] });
  ok(rode.waves.length === 1, 'the wave is still in the water to be measured');
  const lag = pos.x - rode.waves[0].mesh.position.x;
  console.log(`     swam ${travelled.toFixed(2)}u — pinned ring falls ${pinnedLag.toFixed(2)}u behind, riding ring ${lag.toFixed(2)}u`);
  ok(lag < pinnedLag * 0.75, 'the ring follows the seal instead of staying where it was fired',
    `${lag.toFixed(3)}u vs the pinned control's ${pinnedLag.toFixed(3)}u`);
  ok(lag > 0, 'it still TRAILS the seal — a ring welded dead centre has no read of motion');
}

console.log('\n4. the carry is spent, not cancelled');
{
  // Same frame budget, same follow: the only difference is the seal's velocity
  // at the moment of firing. If the carry were applied and then immediately
  // undone by the follow, these two would land on the same spot.
  const stillCentre = run(1, { seconds: 0.2, vel: [0, 0] }).waves[0].mesh.position.x;
  const carriedCentre = run(1, { seconds: 0.2, vel: [12, 0] }).waves[0].mesh.position.x;
  console.log(`     parked seal ${stillCentre.toFixed(3)}, sprinting seal ${carriedCentre.toFixed(3)}`);
  ok(carriedCentre > stillCentre + 0.05,
    'a wave fired off a moving seal is thrown ahead of one fired off a parked seal',
    'carry is being undone by follow on the same frame');
}

console.log('\n5. follow is framerate independent');
{
  const SECONDS = 0.3;
  const SPEED = 12;
  run(1, { seconds: SECONDS, dt: 1 / 60, move: [SPEED, 0] });
  const lag60 = pos.x - calamariDebug().waves[0].mesh.position.x;
  run(1, { seconds: SECONDS, dt: 1 / 15, move: [SPEED, 0] });
  const lag15 = pos.x - calamariDebug().waves[0].mesh.position.x;
  console.log(`     lag at 60fps ${lag60.toFixed(3)}u, at 15fps ${lag15.toFixed(3)}u`);
  // Within a quarter of each other, not equal. The seal itself moves in coarser
  // steps at 15fps, so some spread is the harness and not the law — but a
  // `follow` written as a bare per-frame fraction moves the approach by the
  // ratio of the framerates, which is four times, not a fifth.
  const spread = Math.abs(lag60 - lag15) / Math.max(lag60, lag15);
  ok(spread < 0.25,
    'the same swim leaves about the same lag at 60fps and 15fps',
    `${lag60.toFixed(3)} vs ${lag15.toFixed(3)} (${(spread * 100).toFixed(0)}% apart) — follow is a per-frame fraction, not a rate`);
}

console.log('\n6. squid ride the front, then outrun it');
{
  const level = 3;
  const s = currentCalamariStats(level);
  const expected = calamariSquidCount(level);

  resetCalamari(scene);
  pos.set(0, 0, 0);
  player.velocity.set(0, 0);
  const dt = 1 / 60;
  updateCalamari(dt, scene, pos, level, [], {});
  let { waves, squids } = calamariDebug();
  ok(squids.length === expected, `a wave is born carrying ${expected} squid`, `saw ${squids.length}`);
  ok(squids.every((sq) => sq.wave === waves[0]), 'all of them start attached to that wave');

  // Walk to just before the release point and check they are ON the front.
  const w = waves[0];
  let guard = 0;
  while (w.radius < s.maxRadius * c.squidRelease - 0.3 && guard++ < 2000) updateCalamari(dt, scene, pos, level, [], {});
  const onFront = squids.every((sq) => {
    const d = Math.hypot(sq.mesh.position.x - w.mesh.position.x, sq.mesh.position.y - w.mesh.position.y);
    return Math.abs(d - w.radius) < 1e-6;
  });
  ok(onFront, 'while attached, every squid sits exactly on the wavefront');
  ok(squids.every((sq) => sq.wave), 'none has let go before the release point');

  // ...and past it, they are loose and moving outward faster than the front.
  while (w.radius < s.maxRadius * c.squidRelease + 0.3 && guard++ < 4000) updateCalamari(dt, scene, pos, level, [], {});
  ok(squids.every((sq) => !sq.wave), 'past the release point they have all let go');
  const speeds = squids.map((sq) => Math.hypot(sq.vx, sq.vy));
  const slowest = Math.min(...speeds);
  console.log(`     front ${c.speed} u/s, slowest squid ${slowest.toFixed(1)} u/s`);
  ok(slowest > c.speed, 'every squid outruns the ring it was riding');

  // Radial: each one is still on its own spoke.
  const radial = squids.every((sq) => {
    const want = Math.atan2(Math.sin(sq.angle), Math.cos(sq.angle));
    const got = Math.atan2(sq.vy, sq.vx);
    // squidLift tilts them upward, so this is a loose check that a squid on
    // the right side of the ring is going right, not that it is going exactly
    // where it was standing.
    return Math.cos(want - got) > 0.5;
  });
  ok(radial, 'they fling outward on their own spokes, not in one direction');
}

console.log('\n7. the squid take more of the seal than the ring does');
{
  ok(c.squidCarry > c.carry, 'squidCarry is configured above carry');
  const level = 2;
  const dt = 1 / 60;
  resetCalamari(scene);
  pos.set(0, 0, 0);
  player.velocity.set(10, 0);
  // Drag off for this section only: it is about what the squid LEAVES with,
  // and one frame of decay between the release and the read would turn an
  // exact check into a fuzzy one for no gain.
  const savedDrag = c.squidDrag;
  c.squidDrag = 0;
  updateCalamari(dt, scene, pos, level, [], {});
  const { waves, squids } = calamariDebug();
  const w = waves[0];
  // Freeze the seal after firing — the wave must be carrying the velocity it
  // was BORN with, not whatever the seal is doing when the squid release.
  player.velocity.set(0, 0);
  for (let i = 0; i < 2000 && !w.released; i++) updateCalamari(dt, scene, pos, level, [], {});
  // The squid on the LEFT of the ring: its radial component points -x, so any
  // net rightward push in it can only be the seal's inherited momentum.
  const left = squids.reduce((best, sq) => (Math.cos(sq.angle) < Math.cos(best.angle) ? sq : best), squids[0]);
  const radial = Math.cos(left.angle) * c.speed * c.squidSpeed;
  const inherited = left.vx - radial;
  console.log(`     seal 10 u/s at firing -> ${inherited.toFixed(2)} u/s carried into the squid`);
  ok(Math.abs(inherited - 10 * c.squidCarry) < 1e-6,
    'a released squid carries emit-time seal velocity x squidCarry');
  ok(inherited > 10 * c.carry, 'and more of it than the ring itself took');
  c.squidDrag = savedDrag;
}

console.log('\n8. a pooled squid comes back full size');
{
  const level = 4;
  const dt = 1 / 30;
  resetCalamari(scene);
  pos.set(0, 0, 0);
  player.velocity.set(0, 0);

  // First wave, all the way out and gone — the squid have to reach the END of
  // the fade, which is where the shrink leaves them near zero. Level 0 from the
  // second frame on so the cadence can't fire a second wave into the middle of
  // the measurement.
  updateCalamari(dt, scene, pos, level, [], {});
  const first = calamariDebug().squids[0].mesh.scale.x;
  for (let i = 0; i < 2000 && calamariDebug().squids.length; i++) {
    updateCalamari(dt, scene, pos, 0, [], {});
  }
  ok(calamariDebug().squids.length === 0, "the first wave's squid all retire");

  // Second wave off the recycled bodies. resetCalamari only to clear the
  // cadence — the pool it feeds is what is being tested and it survives.
  resetCalamari(scene);
  updateCalamari(dt, scene, pos, level, [], {});
  const second = calamariDebug().squids[0].mesh.scale.x;
  console.log(`     first wave ${first.toFixed(4)}, second wave ${second.toFixed(4)}`);
  ok(Math.abs(first - second) < 1e-9,
    'a recycled squid is the same size as a fresh one',
    'the fade-out shrink is compounding across pool reuses');
  ok(second > 0, 'and it is not zero');
}

console.log('\n9. a wave that is hitting something is brighter');
{
  const g = damageGlowCfg('calamari');
  ok(g.enabled, 'the calamari row is in CONFIG.damageGlow.sources');
  // A `source` string with no row falls back to the shared envelope rather
  // than throwing, so a typo renders a plausible, slightly wrong flare that
  // nothing else in the game would ever contradict.
  ok(g.perHit !== (CONFIG.damageGlow.perHit ?? 0.5) || g.peak !== (CONFIG.damageGlow.peak ?? 2),
    "...and it is its OWN row, not the shared envelope answering to a name that doesn't exist");

  // A body the front will cross. Position lives on e.mesh.position and nowhere
  // else — a stub that invents e.x hides exactly the bug it would be testing.
  const enemyAt = (x, y) => ({
    mesh: { position: { x, y, z: 0 } }, radius: 0.5, hp: 1e6, vx: 0, vy: 0, flash: 0,
  });

  const level = 3;
  const dt = 1 / 60;
  const contacts = [];
  resetCalamari(scene);
  pos.set(0, 0, 0);
  player.velocity.set(0, 0);
  const list = [enemyAt(3, 0), enemyAt(-3, 0), enemyAt(0, 3)];
  updateCalamari(dt, scene, pos, level, list, { onContact: (x, y) => contacts.push([x, y]) });

  let w = calamariDebug().waves[0];
  ok(w.heat === 0, 'a wave that has crossed nothing is cold');

  // Walk it out until it has swept the three bodies.
  for (let i = 0; i < 200 && contacts.length < 3; i++) {
    updateCalamari(dt, scene, pos, level, list, { onContact: (x, y) => contacts.push([x, y]) });
  }
  ok(contacts.length === 3, 'the front reports one contact per body it crosses', `${contacts.length}`);
  ok(w.heat > 0, 'and that leaves the ring hot', `heat ${w.heat.toFixed(2)}`);

  // THE CONTACT IS ON THE RING, not on the body — the shrimp ring makes the
  // same call for the same reason, and firing it at the enemy would put the
  // clack somewhere the player is not looking.
  const onRing = contacts.every(([x, y]) => {
    const d = Math.hypot(x - w.mesh.position.x, y - w.mesh.position.y);
    return Math.abs(d - w.radius) < w.maxRadius * c.ringWidth * 2;
  });
  ok(onRing, 'every contact is reported on the wavefront, not at the body');

  // The squid riding it are hot too — they are one object with the ring.
  const riding = calamariDebug().squids.filter((sq) => sq.wave === w);
  ok(riding.length > 0 && riding.every((sq) => sq.heat > 0),
    'every squid still riding the wave is hot with it');
  // ...and the punch is real, not a glow with nothing behind it.
  const punched = riding.some((sq) => sq.mesh.scale.x > sq.size * 1.0001);
  ok(c.hitPop > 0 && punched, 'a hot squid is visibly bigger — the half that survives a screenshot',
    `hitPop ${c.hitPop}`);

  // Cools back to nothing, on the shared envelope's own fade.
  const hot = w.heat;
  const before = calamariDebug().squids.length;
  for (let i = 0; i < Math.ceil(g.fade / dt) + 4; i++) updateCalamari(dt, scene, pos, 0, [], {});
  const stillRiding = calamariDebug().squids.filter((sq) => sq.heat > 0);
  ok(w.heat === 0, `the ring is cold again inside its ${g.fade}s fade`, `heat ${w.heat}`);
  ok(stillRiding.length === 0, 'and so is every squid', `${stillRiding.length} still warm of ${before}`);
  console.log(`     peak heat ${hot.toFixed(2)} over 3 bodies, glow ${glowLevel(hot, 'calamari').toFixed(2)}`);
}

console.log('\n10. reset clears the water');
{
  run(5, { seconds: 0.5 });
  ok(calamariDebug().squids.length > 0, 'squid in the water before the reset');
  resetCalamari(scene);
  const { waves, squids } = calamariDebug();
  ok(waves.length === 0 && squids.length === 0, 'resetCalamari takes waves and squid both');
  ok(!scene.children.some((o) => o.name === CALAMARI_ASSETS[0]),
    'and pulls the squid bodies out of the scene', 'a leaked body is an immortal squid');
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
