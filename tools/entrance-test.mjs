#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:entrance
//
// NOTHING APPEARS IN OPEN WATER, and the camera turns to look at the one
// arrival that deserves it.
//
// Every creature in the game is now placed past the edge of the picture and
// swims in, hidden behind the rock face at the walls or the seabed strip under
// the floor for as long as the crossing takes (see THE ENTRANCE in
// entities/enemies.js). The whole trick rests on the camera being ORTHOGRAPHIC
// — a body moved in z does not move, resize or shift on screen, so a creature
// can be tucked behind the cliff and eased back into its lane with nothing
// visible happening. That also means none of it can be checked by looking:
// every failure here renders as a perfectly ordinary fish.
//
//   1. THE SHORE     What the rock face actually measures — how far past the
//                    wall it reaches, and how deep a body has to be to be
//                    behind it. Both come off the built geometry, and the
//                    hiding depth has to land in a narrow band: behind the
//                    rock, but in FRONT of the backdrop planes, or the hider
//                    is occluded by the sky and pops into existence when it
//                    eases forward again.
//   2. THE SPAWN     Every creature in the roster, spawned through the real
//                    spawner: off screen on frame one, behind whatever it is
//                    entering through, every time.
//   3. THE CROSSING  Driven through the real updateEnemies: it gets in, it is
//                    hidden for the whole stretch where it is over drawn rock,
//                    and it ends up in the lane it was rolled into.
//   4. THE SCHOOL    A group spawn scatters around its anchor, and the scatter
//                    is wider than the margin. The one that lands nearest the
//                    arena is the one that gives the trick away.
//   5. THE BOSS      It approaches unannounced — no bar, no riser, no fight —
//                    and the ceremony starts on the frame it is clear of the
//                    rock, not on the frame it spawned.
//   6. THE REVEAL    ...and the frame goes to it, through the real cine rig:
//                    the shot is of the BOSS rather than of the seal, it
//                    travels rather than cuts, and it comes home as the
//                    ceremony lands.
//
// No renderer, on purpose: the browser preview suspends requestAnimationFrame,
// so a screenshot proves nothing about a spawn loop. Every number below comes
// from ticking the same functions main.js ticks.
//
//   node --import ./tools/vite-loader.mjs tools/entrance-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds, seabedTopY, SEABED_Z, WATER_FILL_Z } from '../path/src/arena.js';
import { createWallRocks, shore, shoreOverscan } from '../path/src/systems/wallRocks.js';
import {
  enemies, resetEnemies, spawnNamed, updateEnemies, updateSpawning, clearForBoss,
} from '../path/src/entities/enemies.js';
import { updateBoss, resetBoss, bossState, bossBanner, forceBoss } from '../path/src/systems/boss.js';
import {
  updateCineCamera, resetCineCamera, cineDebug, cineRevealing, cineSubject,
} from '../path/src/systems/cineCamera.js';
import { resetWaves, setBossCycle, lullEligible } from '../path/src/systems/waves.js';
import { resetBaitBalls, updateBaitBallClock, baitSeed } from '../path/src/systems/baitBall.js';

const DT = 1 / 60;
const ASPECT = 16 / 9;

let failures = 0;
const quiet = () => {};
function section(name) { console.log(`\n${name}`); }
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

updateBounds(ASPECT);
const scene = new THREE.Scene();
const wallRocks = createWallRocks(scene);
wallRocks.build();

// A deterministic stand-in for Math.random. Every spawn in this file goes
// through the real roll — which side of the arena, which depth, which body —
// and a harness that let the dice decide would report a different set of
// creatures every run. Seeded per use, like every other spawn harness here.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// The furthest right any frame can see, which is where "off screen" starts.
// Asked of the same function world.js's clampFocus spends, so this cannot
// drift away from what the camera actually does.
const edgeX = () => bounds.right + shoreOverscan();

// The water fill's depth (see world.js). Everything the entrance hides behind
// has to sit in FRONT of this: past it a body is not concealed, it is gone,
// and it would appear out of nothing as it eased forward into its lane.
// Imported rather than typed: arena.js owns it, world.js draws the fill there,
// and a copy here would go stale the moment either moved.
const FILL_Z = WATER_FILL_Z;

// Is this body behind the piece of scenery it is coming through? The hiding
// depth carries a share of the body's own reach, because the measured face is
// a SURFACE and a creature has thickness — so this asks the same question
// spawnOne answers rather than comparing against the bare measurement.
function isHidden(e) {
  const cfg = CONFIG.spawn.entrance;
  const bodyHide = Math.min(e.radius * cfg.hideBySize, cfg.hideDepthMax);
  // ...and the same floor spawnOne applies: a body big enough to want more
  // depth than the water leaves is held in front of the fill instead, which
  // is the one case where "hidden" is a slightly weaker claim than the
  // arithmetic asks for and deliberately so.
  const floorZ = FILL_Z + cfg.fillClearance;
  const want = e.deep ? SEABED_Z - cfg.hideMargin - bodyHide : shore.hideZ - bodyHide;
  return e.mesh.position.z <= Math.max(want, floorZ) + 1e-9;
}

// Is this body's whole silhouette outside the picture? The CENTRE is what gets
// placed; the nose is what gives it away.
function offPicture(e) {
  return Math.abs(e.mesh.position.x) - e.radius > edgeX()
    || e.mesh.position.y + e.radius < Math.min(bounds.bottom, seabedTopY());
}

// ---------------------------------------------------------------------------
section('THE SHORE — what the rock is measured to be');
// ---------------------------------------------------------------------------
{
  check('the wall was built', shore.built);
  check('it reaches past the wall at every height', shore.cover > 0.5,
    `${shore.cover.toFixed(2)} units at its thinnest`);
  check('...and the frame may spend all of it or less, never more',
    shoreOverscan() <= shore.cover + 1e-9 && shoreOverscan() <= (CONFIG.camera?.edgeDrift ?? 0) + 1e-9,
    `drift ${shoreOverscan().toFixed(2)} of ${shore.cover.toFixed(2)} rock, capped at ${CONFIG.camera?.edgeDrift}`);

  // THE HIDING DEPTH, and the band it has to land in. Too shallow and the
  // rock does not cover the creature; too deep and the BACKDROP does, which
  // is worse — a hider behind the fog band is invisible rather than hidden,
  // and it materialises the moment it eases forward into its lane.
  const geo = wallRocks.mesh.geometry;
  const pos = geo.attributes.position;
  let front = -Infinity;
  for (let i = 0; i < pos.count; i++) front = Math.max(front, pos.getZ(i));
  check('a hider sits behind the rock, not in front of it', shore.hideZ < front,
    `hide at ${shore.hideZ.toFixed(2)}, rock reaches ${front.toFixed(2)}`);
  // The frontmost thing world.js draws behind the swimming plane: the surface
  // stroke at -3, with the horizon band at -3.2 behind it.
  check('...and in front of the backdrop, so it is hidden and not erased',
    shore.hideZ > -3,
    `hide at ${shore.hideZ.toFixed(2)}, surface line at -3.0`);
  check('the floor has its own hiding depth, behind the seabed strip',
    SEABED_Z - (CONFIG.spawn.entrance.hideMargin ?? 0.4) < SEABED_Z,
    `${(SEABED_Z - (CONFIG.spawn.entrance.hideMargin ?? 0.4)).toFixed(2)} vs strip at ${SEABED_Z}`);

  // Switched off, there is nothing to hide behind and nothing to spend. The
  // entrance falls back to being merely off screen, which is what it was.
  wallRocks.dispose();
  check('with the shore gone, so is the drift', shoreOverscan() === 0 && !shore.built);
  wallRocks.build();
}

// ---------------------------------------------------------------------------
section('THE SPAWN — nobody starts on screen');
// ---------------------------------------------------------------------------
{
  const roster = Object.keys(CONFIG.enemies);
  const rand = seeded(0x5EA1);
  const realRandom = Math.random;
  Math.random = rand;

  const onScreen = [];
  const unhidden = [];
  const drowned = [];
  const buried = [];
  const lanes = [];
  for (const key of roster) {
    resetEnemies(scene);
    // Ten of each, because the entrance is ROLLED: left wall, right wall, or
    // up out of the seabed. One spawn per species would test one third of the
    // mechanism and pass.
    for (let i = 0; i < 10; i++) {
      const e = spawnNamed(scene, key, 6, undefined, { ignoreCaps: true, overfill: true });
      if (!e) continue;
      if (!offPicture(e)) onScreen.push(`${key} at x ${e.mesh.position.x.toFixed(1)}, y ${e.mesh.position.y.toFixed(1)}, r ${e.radius.toFixed(1)}`);
      // ...and behind whichever piece of scenery it is coming through.
      if (e.deep && e.def.floorSpawn) buried.push(`${key} at y ${e.mesh.position.y.toFixed(1)}`);
      if (!isHidden(e)) unhidden.push(`${key} at z ${e.mesh.position.z.toFixed(2)}, r ${e.radius.toFixed(1)}`);
      // ...and never so deep that the WATER hides it instead of the rock. The
      // fill spans the whole column at z = -5.4; a body behind that is erased
      // rather than concealed, and it would materialise on the way forward.
      if (e.mesh.position.z <= FILL_Z) drowned.push(`${key} at z ${e.mesh.position.z.toFixed(2)}`);
      lanes.push(e.laneZ);
    }
  }
  Math.random = realRandom;

  check('every creature in the roster spawns off the picture',
    onScreen.length === 0, onScreen.slice(0, 4).join('; ') || `${roster.length} species, ten each`);
  check('...and behind the scenery it is entering through',
    unhidden.length === 0, unhidden.slice(0, 4).join('; ') || 'rock face or seabed, every time');
  check('...without hiding behind the WATER, which would erase it instead',
    drowned.length === 0, drowned.slice(0, 4).join('; ') || `all in front of the fill at ${FILL_Z}`);
  // The lane roll still happens — a body hidden at a fixed depth that FORGOT
  // its lane would pass everything above and then swim the whole run in one
  // flat rank, which is the depth spread silently switched off.
  // A CREATURE THAT LIVES ON THE FLOOR NEVER TAKES THE DEEP ENTRANCE. Its
  // resting place is inside the drawn seabed strip — an oyster is half buried,
  // which is the pose — so a body hidden behind that strip has nowhere to
  // emerge to: it would either rise out of the sand it is supposed to sit in,
  // or hold its hiding depth at rest and never be seen again. The bug this
  // catches is silent in both directions, because a missing oyster looks
  // exactly like an ocean that did not roll one.
  check('floor dwellers come in along the floor, not up out of it',
    buried.length === 0, buried.slice(0, 4).join('; ') || 'every floorSpawn species came from a wing');

  check('...while still keeping the depth lane it was rolled into',
    lanes.some((z) => z !== 0), `${lanes.filter((z) => z !== 0).length} of ${lanes.length} off the centre plane`);
  resetEnemies(scene);
}

// ---------------------------------------------------------------------------
section('THE CROSSING — it gets in, and it is hidden the whole way');
// ---------------------------------------------------------------------------
{
  const rand = seeded(0xC0FFEE);
  const realRandom = Math.random;
  Math.random = rand;
  resetEnemies(scene);

  // A representative spread rather than the whole roster: a swimmer, a school
  // fish, a crawler and the biggest body in the game. The crossing is driven
  // through the real integrator, which is expensive per creature.
  // A swimmer, a school fish, a crawler, the biggest body in the game, and a
  // SIMULATED one — the sea turtle carries a rigid body, whose own walls
  // bounce it off the arena edge. That is a second opinion about where the
  // world ends, held by the one creature whose entrance it could shove.
  const subjects = ['trout', 'shark', 'walkingCrab', 'bossShark', 'seaTurtle']
    .filter((k) => CONFIG.enemies[k]);
  check('the subjects exist in the roster', subjects.length === 5, subjects.join(', '));

  const player = { x: 0, y: -12, z: 0 };
  const late = [];
  const exposed = [];
  const stranded = [];
  for (const key of subjects) {
    for (let trial = 0; trial < 6; trial++) {
      resetEnemies(scene);
      const e = spawnNamed(scene, key, 6, undefined, { ignoreCaps: true, overfill: true });
      if (!e) continue;
      const laneZ = e.laneZ;
      let t = 0;
      while ((e.entering || e.deep) && t < 12) {
        updateEnemies(DT, scene, player, quiet, quiet);
        t += DT;
        if (!enemies.includes(e)) break;
        // THE ONE THING THAT MUST NEVER HAPPEN: any part of the body inside
        // the picture while it is still in front of the rock it is crossing.
        const visible = !offPicture(e);
        if (visible && !isHidden(e)) {
          exposed.push(`${key} at x ${e.mesh.position.x.toFixed(1)} z ${e.mesh.position.z.toFixed(2)}`);
          break;
        }
      }
      if (e.entering || e.deep) { stranded.push(`${key} after ${t.toFixed(1)}s`); continue; }
      if (t > 4) late.push(`${key} took ${t.toFixed(1)}s`);
      // ...and then it comes forward into its lane, over a beat rather than on
      // one frame. Given three seconds, which is far longer than it needs.
      let settle = 0;
      while (Math.abs(e.mesh.position.z - laneZ) > 1e-6 && settle < 3) {
        updateEnemies(DT, scene, player, quiet, quiet);
        settle += DT;
        if (!enemies.includes(e)) break;
      }
      if (enemies.includes(e) && Math.abs(e.mesh.position.z - laneZ) > 1e-6) {
        stranded.push(`${key} never reached its lane (z ${e.mesh.position.z.toFixed(2)} vs ${laneZ.toFixed(2)})`);
      }
    }
  }
  Math.random = realRandom;

  check('nothing is ever visible in front of the rock it came through',
    exposed.length === 0, exposed.slice(0, 3).join('; ') || 'every frame of every crossing');
  check('every creature actually gets in', stranded.length === 0,
    stranded.slice(0, 3).join('; ') || 'all of them');
  check('...and does it promptly, on the entrance\'s own floor speed',
    late.length === 0, late.slice(0, 3).join('; ') || 'under four seconds each');
  resetEnemies(scene);
}

// ---------------------------------------------------------------------------
section('THE SCHOOL — the scatter cannot put one on screen');
// ---------------------------------------------------------------------------
{
  // A group spawn is an anchor plus a random scatter, and the scatter is wider
  // than the entrance margin. The clamp that saves this lives in spawnOne, at
  // the single point every spawn passes through, rather than in the six places
  // that build a spawn point — which is the whole reason it can be relied on.
  const grouped = Object.keys(CONFIG.enemies).filter((k) => CONFIG.enemies[k].group);
  check('there are schooling species to test', grouped.length > 0, `${grouped.length} of them`);

  const realRandom = Math.random;
  Math.random = seeded(0xB0A7);
  resetEnemies(scene);
  resetWaves(0);
  setBossCycle(1);
  let spawned = 0;
  const onScreen = [];
  const gs = { time: 0, difficulty: 8, level: 12 };
  for (let i = 0; i < 3000 && spawned < 400; i++) {
    updateSpawning(DT, gs, scene);
    for (const e of enemies) {
      if (e.__seen) continue;
      e.__seen = true;
      spawned += 1;
      if (!offPicture(e)) onScreen.push(`${e.type} at x ${e.mesh.position.x.toFixed(1)}`);
    }
  }
  Math.random = realRandom;
  check('a run\'s worth of real spawning puts nobody on screen',
    onScreen.length === 0, onScreen.slice(0, 4).join('; ') || `${spawned} creatures through the real spawner`);
  resetEnemies(scene);

  // THE BAIT BALL, COMPUTED RATHER THAN SAMPLED. A ball's fish are seeded
  // through the column's volume around an anchor that declares no `side`, so
  // they never get spawnOne's outward push — the anchor alone has to be far
  // enough out that the member rolled nearest the arena still clears the
  // picture. The seeded run above can only prove that for the draws it made:
  // this one placed a member 0.07 units inside the edge on one seed and
  // passed on the next, which is a pass that means nothing. So build the
  // worst case by hand — baitSeed's angle at exactly pi and its radius at
  // its full extent — on the biggest body a ball can hold, and ask that.
  const bc = CONFIG.baitBall ?? {};
  resetBaitBalls();
  const ballRand = seeded(0xBA17);
  const spec = updateBaitBallClock((bc.firstDelay ?? 10) + 1, {
    level: 12, difficulty: 8, boss: null, hold: false, aliveNonBoss: 0,
    maxAlive: CONFIG.spawn.maxAlive, bounds,
    offscreenX: bounds.right + shoreOverscan() + (CONFIG.spawn.entrance.margin ?? 1.5),
    player: { x: 0, y: -12 }, rand: ballRand,
  });
  check('the clock will place a ball', !!spec, spec ? `anchor x ${spec.x.toFixed(1)}` : 'no spec');
  if (spec) {
    const R = bc.radius ?? 1.7;
    // Toward the arena is +x from a left-wall anchor and -x from a right-wall
    // one: index 0 puts baitSeed's angle at 0 (cos +1), index count/2 at pi
    // (cos -1). rand 0.5 leaves the angle jitter at zero, rand 1 takes the
    // radius to its ceiling. The member on the arena side, as far in as
    // baitSeed can put one.
    const worst = [0.5, 1, 0.5];
    const inwardIndex = spec.x < 0 ? 0 : spec.count / 2;
    const inner = baitSeed(inwardIndex, spec.count, { x: spec.x, y: spec.y, shell: R }, () => worst.shift() ?? 0.5, bc);
    let fishR = 0;
    for (const def of Object.values(CONFIG.enemies)) if (lullEligible(def)) fishR = Math.max(fishR, def.radius ?? 0);
    const clear = Math.abs(inner.x) - fishR - edgeX();
    check('...and its innermost fish is off the picture in the worst case, not on average',
      clear > 0,
      `anchor ${Math.abs(spec.x).toFixed(2)}, in by ${(Math.abs(spec.x) - Math.abs(inner.x)).toFixed(2)}, nose r ${fishR.toFixed(2)}, edge ${edgeX().toFixed(2)} — clears by ${clear.toFixed(2)}`);
  }
  resetBaitBalls();
}

// ---------------------------------------------------------------------------
section('THE BOSS — announced when it can be seen, not when it exists');
// ---------------------------------------------------------------------------
{
  resetEnemies(scene);
  resetBoss(scene);
  const gameState = { difficulty: 5, level: 12, running: true };
  const player = { x: 0, y: -12, z: 0 };
  const boss = forceBoss(scene, gameState, { boss: 'bossShark', perk: null });
  check('a boss was put in the water', !!boss, boss?.type);

  check('it starts off the picture', offPicture(boss),
    `x ${boss.mesh.position.x.toFixed(1)}, edge at ${edgeX().toFixed(1)}, r ${boss.radius.toFixed(1)}`);
  // Whichever way it rolled in — through a wall, or up out of the seabed.
  check(`...behind the ${boss.deep ? 'seabed' : 'rock face'}`, isHidden(boss),
    `z ${boss.mesh.position.z.toFixed(2)}, r ${boss.radius.toFixed(1)}`);
  check('...and still in front of the water fill', boss.mesh.position.z > FILL_Z,
    `z ${boss.mesh.position.z.toFixed(2)} vs ${FILL_Z}`);
  check('it is approaching, not arriving', bossState.approaching && !bossState.arriving);
  // THE HUD SAYS NOTHING. A name and an empty red bar over an empty ocean
  // announces a boss the player cannot see, and spends the surprise on the
  // health bar rather than on the animal.
  check('...and there is no bar to draw yet', bossBanner() === null);
  check('...and nothing can hurt it in the meantime', boss.invuln > 0);

  // The swim in, through the real integrator.
  let t = 0;
  while (bossState.approaching && t < 12) {
    updateEnemies(DT, scene, player, quiet, quiet);
    updateBoss(DT, gameState, scene);
    t += DT;
  }
  check('it arrives under its own power, well inside the guard rail',
    !bossState.approaching && t < (CONFIG.boss.approachSeconds ?? 6) - 1,
    `${t.toFixed(2)}s of a ${CONFIG.boss.approachSeconds ?? 6}s allowance`);
  // Clear of the SCENERY IT CAME THROUGH, which is the whole gate: the whole
  // body inside the walls for a side entrance, and the floor entrance's own
  // flag dropped for a deep one. Not "above the seabed line" — a creature is
  // free to swim with its belly in the sand once it is in, and always was.
  check('...fully clear of the scenery when the ceremony starts',
    !boss.deep && !boss.entering
      && Math.abs(boss.mesh.position.x) + boss.radius <= bounds.right + 1e-6,
    `x ${boss.mesh.position.x.toFixed(1)} + r ${boss.radius.toFixed(1)} vs wall ${bounds.right.toFixed(1)}`);
  check('the ceremony starts on that frame', bossState.arriving);
  check('...with the bar empty and visible, both for the first time',
    bossBanner()?.arriving === true && bossBanner()?.frac === 0,
    `${bossBanner()?.frac}`);

  // And the fill still runs its full length from there, rather than having
  // quietly spent itself during the approach.
  let fill = 0;
  while (bossState.arriving && fill < 10) {
    updateBoss(DT, gameState, scene);
    fill += DT;
  }
  check('the arrival is still the length it is tuned to be',
    Math.abs(fill - CONFIG.boss.arrival.seconds) < 0.05,
    `${fill.toFixed(2)}s vs ${CONFIG.boss.arrival.seconds}s`);
  check('...and the fight is on', bossBanner()?.arriving === false && boss.invuln === 0);
}

// ---------------------------------------------------------------------------
section('THE REVEAL — the one shot that is not of the seal');
// ---------------------------------------------------------------------------
{
  const VH = CONFIG.arena.viewHeight;
  const half = (z) => ({ w: (bounds.frameWidth / 2) / z, h: (VH / 2) / z });
  const limitsOf = (zoom) => {
    const h = half(zoom);
    const side = shoreOverscan();
    return {
      loX: bounds.left + h.w - side,
      hiX: bounds.right - h.w + side,
      loY: bounds.bottom + h.h,
      hiY: bounds.top - h.h,
    };
  };
  const ctx = {
    target: { x: 0, y: -12 },
    velocity: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
    dashDir: { x: 0, y: 0 },
    chargePower: 0,
    strikeHeld: false, charging: false, boosting: false,
    deathPhase: 'none', deathElapsed: 0,
    halfExtents: half,
    focusLimits: limitsOf,
    clampFocus: (x, y, zoom) => {
      const l = limitsOf(zoom);
      return {
        x: l.loX > l.hiX ? 0 : Math.min(Math.max(x, l.loX), l.hiX),
        y: l.loY > l.hiY ? (bounds.bottom + bounds.top) / 2 : Math.min(Math.max(y, l.loY), l.hiY),
      };
    },
  };

  const wasEnabled = CONFIG.cinecam.enabled;
  CONFIG.cinecam.enabled = true;
  resetCineCamera();
  resetEnemies(scene);
  resetBoss(scene);
  const gameState = { difficulty: 5, level: 12, running: true };
  const player = { x: 0, y: -12, z: 0 };

  // Settle the rig on the seal first, so the pan below is measured from a
  // frame that had already stopped moving rather than from a rig still
  // finding its subject on frame one.
  for (let i = 0; i < 120; i++) updateCineCamera(DT, ctx);
  const restX = cineDebug().x;
  const restZoom = cineDebug().zoom;
  check('the frame is on the seal to start with', Math.abs(restX - ctx.target.x) < 12,
    `frame at ${restX.toFixed(1)}, seal at ${ctx.target.x}`);

  // SEEDED, like the two blocks above it and for the same reason — this one was
  // simply never given one. `forceBoss` rolls which side of the arena the
  // animal comes in on and how far out, and the pan measured below is the
  // distance from the seal to wherever that landed. Most rolls put the boss
  // most of an arena away and the frame travels ~64 units; a roll that drops it
  // near the seal's own x leaves 1.3, and the check asking for more than 5
  // failed about one run in five on a rig that was working perfectly.
  //
  // Seeded rather than loosened: a threshold low enough to accept the closest
  // roll is one a rig that barely moved would also pass, which is the whole
  // claim gone. See the note in tools/boss-perk-test.mjs.
  const realRandom = Math.random;
  Math.random = seeded(0xCA3E4A);
  const boss = forceBoss(scene, gameState, { boss: 'bossShark', perk: null });
  Math.random = realRandom;
  check('nothing is revealed while it is still behind the rock', !cineRevealing());

  const samples = [];
  let t = 0;
  let firedAt = -1;
  let bossSide = 0;
  let lensOnBoss = 0;
  let lensOffBoss = 0;
  while (t < 8) {
    updateEnemies(DT, scene, player, quiet, quiet);
    updateBoss(DT, gameState, scene);
    updateCineCamera(DT, ctx);
    t += DT;
    if (firedAt < 0 && cineRevealing()) {
      firedAt = t;
      bossSide = Math.sign(boss.mesh.position.x);
    }
    if (firedAt >= 0) {
      samples.push({ t: t - firedAt, x: cineDebug().x, zoom: cineDebug().zoom, on: cineRevealing() });
      if (cineSubject.active) {
        const dx = Math.abs(cineSubject.x - boss.mesh.position.x);
        const dy = Math.abs(cineSubject.y - boss.mesh.position.y);
        if (dx < 1e-6 && dy < 1e-6) lensOnBoss += 1; else lensOffBoss += 1;
      }
    }
  }

  check('the reveal fires', firedAt > 0, `${firedAt.toFixed(2)}s after the spawn`);
  const during = samples.filter((s) => s.on);
  check('...and it holds for the ceremony', during.length > 0
    && Math.abs(during[during.length - 1].t - CONFIG.boss.arrival.seconds) < 0.1,
    `${during.length ? during[during.length - 1].t.toFixed(2) : 0}s vs ${CONFIG.boss.arrival.seconds}s`);

  // THE PAN ITSELF. The frame has to travel toward the boss's side of the
  // arena, and travel is the word: a rig that jumped there would satisfy any
  // "did it move" test and read as a cut.
  const travelled = during.length ? during[during.length - 1].x - restX : 0;
  check('the frame travels toward the boss', bossSide !== 0 && Math.sign(travelled) === bossSide
    && Math.abs(travelled) > 5,
    `${travelled.toFixed(1)} units, boss on the ${bossSide > 0 ? 'right' : 'left'}`);
  const steps = during.slice(1).map((s, i) => Math.abs(s.x - during[i].x));
  check('...rather than cutting to it', steps.length > 0 && Math.max(...steps) < Math.abs(travelled) * 0.25,
    `biggest single frame ${Math.max(...steps).toFixed(2)} of ${Math.abs(travelled).toFixed(1)}`);
  // ...and it eases in and out rather than running at a constant rate, which
  // is the difference between a camera move and a slide.
  const fastest = steps.indexOf(Math.max(...steps));
  check('...on a curve, with the middle of the move the quickest part',
    fastest > 0 && fastest < steps.length - 1, `quickest frame ${fastest} of ${steps.length}`);

  // THE SHARP BIT OF THE PICTURE. The tilt-shift focal point is projected from
  // the camera's subject, and world.js has always projected the player because
  // until now the player was always the subject. A reveal that forgot to say
  // otherwise puts the sharp disc on a seal at the edge of frame and leaves
  // the boss — the entire point of the shot — as the blurred thing beside it.
  check('the lens is told the shot is of the boss', lensOnBoss > 0 && lensOffBoss === 0,
    `${lensOnBoss} frames on the animal, ${lensOffBoss} on something else`);
  check('...and hands the focus back when it is over', cineSubject.active === false);
  const midway = during[Math.floor(during.length / 2)];
  check('...it punched in for the shot', midway && midway.zoom > restZoom + 0.05,
    `${midway?.zoom.toFixed(2)} vs a resting ${restZoom.toFixed(2)}`);

  // THE TWO CLOCKS. The camera runs on the wall clock and the ceremony runs on
  // the game's, and an xp spill can open a level-up card in the middle of an
  // arrival — which stops the boss's clock and not the camera's. A shot on its
  // own countdown ends there, over a health bar frozen half full. Simulated by
  // ticking the camera while the boss gets nothing.
  {
    resetCineCamera();
    resetEnemies(scene);
    resetBoss(scene);
    const paused = { difficulty: 5, level: 12, running: true };
    forceBoss(scene, paused, { boss: 'bossShark', perk: null });
    let n = 0;
    while (bossState.approaching && n++ < 800) {
      updateEnemies(DT, scene, player, quiet, quiet);
      updateBoss(DT, paused, scene);
      updateCineCamera(DT, ctx);
    }
    check('the reveal is running before the pause', cineRevealing());
    // Four seconds of camera with the run stopped — twice the whole ceremony.
    for (let i = 0; i < 240; i++) updateCineCamera(DT, ctx);
    check('...and a paused run cannot end it early',
      cineRevealing() && bossState.arriving,
      `revealing ${cineRevealing()}, bar at ${(bossBanner()?.frac ?? 0).toFixed(2)}`);
    // Let the run go again: the two land together.
    let m = 0;
    while (bossState.arriving && m++ < 800) {
      updateBoss(DT, paused, scene);
      updateCineCamera(DT, ctx);
    }
    check('...and when it resumes, the shot ends with the ceremony',
      !cineRevealing() && !bossState.arriving, `${(m * DT).toFixed(2)}s to finish`);
  }
  CONFIG.cinecam.enabled = wasEnabled;

  // ...and it comes home. The state is gone by the last sample; the frame
  // catches up to the seal over the blend out.
  for (let i = 0; i < 300; i++) updateCineCamera(DT, ctx);
  // Back inside the rig's own dead zone, which is as close as the frame ever
  // gets to anything: below that box the spring is deliberately still. A
  // tighter number here would be asserting that the camera does something it
  // is tuned not to do.
  const deadZone = CONFIG.cinecam.base.deadZone.x * half(cineDebug().zoom).w;
  check('the frame comes back to the seal afterwards',
    Math.abs(cineDebug().x - restX) <= deadZone + 0.5,
    `back at ${cineDebug().x.toFixed(1)}, was ${restX.toFixed(1)}, dead zone ${deadZone.toFixed(1)}`);
  resetEnemies(scene);
  resetBoss(scene);
}

console.log(failures === 0 ? '\nAll good.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
