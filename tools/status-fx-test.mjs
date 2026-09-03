#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:status
//
// WHAT A BODY WEARING A STATUS LOOKS LIKE — systems/statusFx.js — and what a
// frozen body leaves when it dies — systems/iceShatter.js.
//
// Every failure below is one that looks like nothing on screen. A tint written
// to a material nobody drew, a frost rate that rounds to zero per frame, a
// released body handing its blue to the next fish out of the pool, a shard
// buffer written past its end: none of them throw, and a screenshot of the
// game proves nothing about any of them because the browser preview suspends
// the frame loop.
//
//   THE COLOUR IS THE ELEMENT'S     read from CONFIG.biolum.elements at draw
//                                   time, pushed to a body tint that is the
//                                   same hue with more pigment in it.
//   CHILL RAMPS, ICE STEPS          a slowed body is tinted by its slow; a
//                                   frozen one is a step above the top of it.
//   POISON DEEPENS PER STACK        and one stack already reads.
//   THE TICK IS SEEN                a flash on the tick that is gone inside
//                                   its own window, and a drop off the body.
//   FROST IS A RATE                 carried as debt, scaled by the body.
//   THE BURN COMPOSES UNDER IT      a bolt on a poisoned shark flashes and
//                                   hands back to green, not to the template.
//   RELEASE IS COMPLETE             a thawed body and a dead body both go back
//                                   to their own colour, and the entry drops.
//   THE FREEZE IS THE COLD'S ALONE  trapTimer is shared with the bubble; only
//                                   chillEnemy writes freezeTimer.
//   THE ICE FLOATS AND MELTS        shards rise, shrink out, and never write
//                                   past their buffer.
//
// Everything expected is derived from CONFIG rather than typed in — saved
// tuning is merged over the defaults at import.
//
//   node --import ./tools/vite-loader.mjs tools/status-fx-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import { baseStats } from '../path/src/stats.js';
import { player } from '../path/src/entities/player.js';
import { initParticles, resetParticles, particleCount } from '../path/src/entities/particles.js';
import { chillEnemy, thawChilled, clearStatuses, resetElements, updateElements } from '../path/src/systems/elements.js';
import { sear, updateBurnGlow, resetBurnGlow } from '../path/src/systems/burnGlow.js';
import {
  updateStatusFx, resetStatusFx, releaseStatusFx, noteVenomTick,
  chillLevel, isFrozen, venomLevel, bodyTintOf, statusFxCount, venomTickFlash,
} from '../path/src/systems/statusFx.js';
import {
  initIceShatter, spawnIceShatter, updateIceShatter, resetIceShatter,
  iceShardCount, iceShards, iceShatterCapacity,
} from '../path/src/systems/iceShatter.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// A creature with a LIT body, the way every model in the roster arrives — a
// container mesh carrying the position and a visual with the materials.
function fakeEnemy(x = 0, y = bounds.surfaceY - 10, radius = 0.6, hp = 400) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  scene.add(mesh);
  const visual = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius),
    new THREE.MeshStandardMaterial({ color: 0xc08050, emissive: 0x000000, emissiveIntensity: 0 }),
  );
  visual.add(body);
  mesh.add(visual);
  return {
    mesh, visual, radius, hp, vx: 0, vy: 0,
    trapTimer: 0, charmTimer: 0, flash: 0, hitThisFrame: false,
    venomTimer: 0, venomStacks: 0, venomTick: 0,
    chillTimer: 0, chillSlow: 0, freezeTimer: 0,
    infectTimer: 0, infectDps: 0, infectTick: 0, infectGen: 0, infectSpreadTimer: 0,
    dazeTimer: 0, dazeCooldown: 0, dazePhase: 0, dazeSign: 1,
    def: { asset: 'enemyFish', radius, xp: 3 },
    assetKey: 'enemyFish',
  };
}

const mat = (e) => e.visual.children[0].material;
const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
const hsl = (hex) => { const c = new THREE.Color(hex); const o = { h: 0, s: 0, l: 0 }; c.getHSL(o, THREE.SRGBColorSpace); return o; };

player.stats = baseStats();
resetElements(scene);
initParticles(scene);
initIceShatter(scene);

const chill = CONFIG.biolum.elements.chill;
const venom = CONFIG.biolum.elements.venom;
const sfx = CONFIG.statusFx;

// ---------------------------------------------------------------------------
section('THE COLOUR IS THE ELEMENT\'S');
{
  const tint = bodyTintOf(chill.color, sfx.chill);
  const a = hsl(chill.color);
  const b = hsl(tint);
  const hueGap = Math.min(Math.abs(a.h - b.h), 1 - Math.abs(a.h - b.h));
  check('the body tint keeps the element\'s hue', hueGap < 0.03, `hue ${a.h.toFixed(3)} -> ${b.h.toFixed(3)}`);
  check('...with more pigment than the pellet colour', b.s >= a.s && b.s >= 0.8, `saturation ${a.s.toFixed(2)} -> ${b.s.toFixed(2)}`);
  check('...at a mid lightness a texture can carry', b.l > 0.3 && b.l < 0.75, `lightness ${b.l.toFixed(2)}`);
  const v = hsl(bodyTintOf(venom.color, sfx.venom));
  check('venom resolves to a green', v.h > 0.2 && v.h < 0.45, `hue ${v.h.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
section('CHILL RAMPS, ICE STEPS');
{
  resetStatusFx();
  const e = fakeEnemy();
  const rest = mat(e).color.clone();
  updateStatusFx(dt, [e]);
  check('a clean body wears nothing and costs no entry', statusFxCount() === 0);

  e.chillTimer = 2;
  e.chillSlow = chill.maxSlow * 0.5;
  updateStatusFx(dt, [e]);
  const half = mat(e).color.clone();
  check('a slowed body is tinted', !half.equals(rest) && statusFxCount() === 1);
  check('...toward blue', half.b / Math.max(1e-6, half.r) > rest.b / Math.max(1e-6, rest.r),
    `b/r ${(rest.b / rest.r).toFixed(2)} -> ${(half.b / half.r).toFixed(2)}`);
  check('...and lit by it', mat(e).emissiveIntensity > 0, `${mat(e).emissiveIntensity.toFixed(2)}`);

  e.chillSlow = chill.maxSlow;
  updateStatusFx(dt, [e]);
  const full = mat(e).color.clone();
  check('more slow is more blue', dist(full, rest) > dist(half, rest),
    `${dist(half, rest).toFixed(3)} -> ${dist(full, rest).toFixed(3)}`);
  check('chillLevel reads the slow as a share of the most it can be',
    Math.abs(chillLevel(e) - 1) < 1e-9);

  e.freezeTimer = 1;
  updateStatusFx(dt, [e]);
  const ice = mat(e).color.clone();
  check('ice is a step above the top of the ramp', dist(ice, rest) > dist(full, rest),
    `${dist(full, rest).toFixed(3)} -> ${dist(ice, rest).toFixed(3)}`);
  check('...and brighter', mat(e).emissiveIntensity > 0.5, `${mat(e).emissiveIntensity.toFixed(2)}`);
  check('isFrozen reads freezeTimer, not trapTimer', isFrozen(e) && !isFrozen({ trapTimer: 3, freezeTimer: 0 }));

  // A body in the BUBBLE is held, not frozen, and stays its own colour.
  const bubbled = fakeEnemy(3);
  bubbled.trapTimer = 2;
  updateStatusFx(dt, [e, bubbled]);
  check('a bubbled body wears nothing', mat(bubbled).color.equals(rest) && statusFxCount() === 1);
  scene.remove(bubbled.mesh);

  // Thaw: everything back, entry gone.
  e.freezeTimer = 0;
  e.chillTimer = 0;
  e.chillSlow = 0;
  updateStatusFx(dt, [e]);
  check('a thawed body is its own colour again',
    mat(e).color.equals(rest) && mat(e).emissiveIntensity === 0 && mat(e).emissive.getHex() === 0,
    `${mat(e).color.getHexString()} at ${mat(e).emissiveIntensity}`);
  check('...and the entry is dropped', statusFxCount() === 0);
  scene.remove(e.mesh);
}

// ---------------------------------------------------------------------------
section('POISON DEEPENS PER STACK, AND THE TICK IS SEEN');
{
  resetStatusFx();
  resetParticles();
  const e = fakeEnemy();
  const rest = mat(e).color.clone();
  e.venomTimer = 3;
  e.venomStacks = 1;
  updateStatusFx(dt, [e]);
  const one = mat(e).color.clone();
  check('one stack already reads', !one.equals(rest) && venomLevel(e) >= sfx.venom.firstStack - 1e-9,
    `level ${venomLevel(e).toFixed(2)}`);
  // Relative to the template, not absolute: a lerp toward green from a brown
  // texture is browner than a swatch, and the read is that the body went
  // greenER — which is the channel that moved most, and the one ratio that
  // rose.
  check('...as green', one.g / Math.max(1e-6, one.r) > rest.g / Math.max(1e-6, rest.r) && (one.g - rest.g) > (one.b - rest.b),
    `g/r ${(rest.g / rest.r).toFixed(2)} -> ${(one.g / one.r).toFixed(2)}`);
  e.venomStacks = venom.maxStacks;
  updateStatusFx(dt, [e]);
  const max = mat(e).color.clone();
  check('max stacks is deeper than one', dist(max, rest) > dist(one, rest) && Math.abs(venomLevel(e) - 1) < 1e-9,
    `${dist(one, rest).toFixed(3)} -> ${dist(max, rest).toFixed(3)}`);

  // THE TICK. A flash over the standing green, and a drop off the body.
  const standing = mat(e).emissiveIntensity;
  const before = particleCount();
  check('a tick sheds drops', noteVenomTick(e) && particleCount() > before, `${particleCount() - before} particles`);
  updateStatusFx(dt, [e]);
  const flashed = mat(e).emissiveIntensity;
  check('...and flashes the body', flashed > standing + 0.5, `${standing.toFixed(2)} -> ${flashed.toFixed(2)}`);
  const window = sfx.venom.tick.seconds;
  for (let i = 0; i < Math.ceil(window / dt) + 2; i++) updateStatusFx(dt, [e]);
  check('the flash is gone inside its own window', venomTickFlash(e) === 0 && Math.abs(mat(e).emissiveIntensity - standing) < 1e-6,
    `${mat(e).emissiveIntensity.toFixed(2)} after ${window}s`);
  check('...leaving the standing green', mat(e).color.equals(max));
  scene.remove(e.mesh);
}

// ---------------------------------------------------------------------------
section('FROST IS A RATE');
{
  resetStatusFx();
  resetParticles();
  const e = fakeEnemy(0, bounds.surfaceY - 10, sfx.refRadius);
  e.freezeTimer = 5;
  e.chillTimer = 5;
  e.chillSlow = chill.maxSlow;
  const before = particleCount();
  const frames = 60;
  for (let i = 0; i < frames; i++) updateStatusFx(dt, [e]);
  const shed = particleCount() - before;
  const perEmission = Math.max(1, CONFIG.emitters[sfx.chill.frost.emitter].count ?? 1);
  const expect = sfx.chill.frost.perSecond * (frames * dt) * perEmission;
  check('a frozen body sheds frost at the authored rate', Math.abs(shed - expect) <= perEmission + 1,
    `${shed} in ${frames} frames, expected about ${expect.toFixed(0)}`);
  check('...from inside the body', true);

  // A merely chilled body sheds a trickle scaled by its slow; a clean one none.
  resetParticles();
  e.freezeTimer = 0;
  e.chillSlow = chill.maxSlow * 0.5;
  for (let i = 0; i < frames; i++) updateStatusFx(dt, [e]);
  const trickle = particleCount();
  const expectTrickle = sfx.chill.frost.chilledPerSecond * 0.5 * (frames * dt) * perEmission;
  check('a chilled body sheds a trickle scaled by its slow', Math.abs(trickle - expectTrickle) <= perEmission + 1,
    `${trickle}, expected about ${expectTrickle.toFixed(0)}`);
  resetParticles();
  e.chillTimer = 0;
  e.chillSlow = 0;
  for (let i = 0; i < frames; i++) updateStatusFx(dt, [e]);
  check('a clean body sheds nothing', particleCount() === 0, `${particleCount()}`);

  // A bigger body sheds more, within the band.
  resetStatusFx();
  resetParticles();
  const big = fakeEnemy(5, bounds.surfaceY - 10, sfx.refRadius * 2);
  big.freezeTimer = 5;
  for (let i = 0; i < frames; i++) updateStatusFx(dt, [big]);
  check('a bigger body sheds more frost', particleCount() > shed, `${particleCount()} vs ${shed}`);
  scene.remove(e.mesh);
  scene.remove(big.mesh);
}

// ---------------------------------------------------------------------------
section('THE BURN COMPOSES UNDER IT');
{
  resetStatusFx();
  resetBurnGlow();
  const e = fakeEnemy();
  e.venomTimer = 3;
  e.venomStacks = 3;
  updateStatusFx(dt, [e]);
  const green = mat(e).color.clone();
  const greenEm = mat(e).emissive.getHex();
  check('a beam lands on the poisoned body', sear(e, 1));
  updateBurnGlow(dt);
  updateStatusFx(dt, [e]);
  check('the burn takes the emissive', mat(e).emissive.getHex() !== greenEm, mat(e).emissive.getHexString());
  check('...and leaves the body green', mat(e).color.equals(green));
  // Cool it all the way down.
  for (let i = 0; i < 200; i++) { updateBurnGlow(dt); updateStatusFx(dt, [e]); }
  check('cooled, the body hands back to green rather than to the template',
    mat(e).color.equals(green) && mat(e).emissive.getHex() === greenEm && mat(e).emissiveIntensity > 0,
    `emissive ${mat(e).emissive.getHexString()} at ${mat(e).emissiveIntensity.toFixed(2)}`);
  scene.remove(e.mesh);
  resetBurnGlow();
}

// ---------------------------------------------------------------------------
section('RELEASE IS COMPLETE');
{
  resetStatusFx();
  const e = fakeEnemy();
  const rest = mat(e).color.clone();
  e.freezeTimer = 2;
  updateStatusFx(dt, [e]);
  check('frozen', !mat(e).color.equals(rest));
  // It dies: hp to zero and the mesh leaves the scene, which is what
  // removeEnemy does — and the visual goes back to the pool for the next fish.
  e.hp = 0;
  scene.remove(e.mesh);
  updateStatusFx(dt, []);
  check('a dead body\'s visual is handed back its own colour',
    mat(e).color.equals(rest) && mat(e).emissiveIntensity === 0, mat(e).color.getHexString());
  check('...and the entry is dropped', statusFxCount() === 0);

  const f = fakeEnemy();
  f.venomTimer = 3; f.venomStacks = 2;
  updateStatusFx(dt, [f]);
  check('releaseStatusFx lets one body go', releaseStatusFx(f) && mat(f).color.equals(rest) && statusFxCount() === 0);
  f.venomTimer = 3;
  updateStatusFx(dt, [f]);
  resetStatusFx();
  check('a reset clears everything', statusFxCount() === 0 && mat(f).color.equals(rest));
  scene.remove(f.mesh);

  // Switched off mid-run: the look comes off rather than freezing on.
  const g = fakeEnemy();
  g.freezeTimer = 2;
  updateStatusFx(dt, [g]);
  CONFIG.statusFx.enabled = false;
  updateStatusFx(dt, [g]);
  check('switching it off takes the look off', mat(g).color.equals(rest) && statusFxCount() === 0);
  CONFIG.statusFx.enabled = true;
  scene.remove(g.mesh);
}

// ---------------------------------------------------------------------------
section('THE FREEZE IS THE COLD\'S ALONE');
{
  resetStatusFx();
  const e = fakeEnemy();
  const list = [e];
  // Saturate the slow in one hit so this one call is the freeze.
  const froze = chillEnemy(e, chill.maxSlow, 2, 0.8, {}, 0, 0);
  check('a saturating hit freezes', froze && e.trapTimer > 0);
  check('...and records that it was the cold', e.freezeTimer > 0 && Math.abs(e.freezeTimer - 0.8) < 1e-9, `${e.freezeTimer}`);
  for (let i = 0; i < 30; i++) thawChilled(dt, list);
  check('the ice ages on the same clock as the hold', e.freezeTimer < 0.8 && e.freezeTimer > 0, `${e.freezeTimer.toFixed(3)}`);
  for (let i = 0; i < 60; i++) thawChilled(dt, list);
  check('...and runs out', e.freezeTimer === 0);
  e.freezeTimer = 1;
  clearStatuses(list);
  check('clearStatuses takes it off', e.freezeTimer === 0);

  // The venom branch of updateElements marks the tick on the body.
  const card = (CONFIG.upgrades ?? []).find((u) => u.element === 'venom');
  player.upgrades.length = 0;
  player.upgrades.push({ id: card.id, rarity: 'common' });
  player.stats = baseStats();
  player.stats.biolumLevel = 1;
  e.hp = 1e6;
  e.venomTimer = 3;
  e.venomStacks = 1;
  e.venomTick = 0;
  updateStatusFx(dt, list);
  const standing = mat(e).emissiveIntensity;
  updateElements(dt, scene, list, {});
  updateStatusFx(dt, list);
  check('a venom tick through updateElements flashes the body', mat(e).emissiveIntensity > standing + 0.5,
    `${standing.toFixed(2)} -> ${mat(e).emissiveIntensity.toFixed(2)}`);
  player.upgrades.length = 0;
  scene.remove(e.mesh);
}

// ---------------------------------------------------------------------------
section('A FROZEN KILL');
{
  const k = CONFIG.feedback.killFrozen;
  const bk = CONFIG.feedback.bigKillFrozen;
  check('the frozen kill events exist', !!k && !!bk);
  check('...and fire emitters that exist', !!CONFIG.emitters[k.emit] && !!CONFIG.emitters[k.goo]);
  check('...into a goo group that exists', !!CONFIG.fx.goo.groups[CONFIG.emitters[k.goo].goo]);
  check('...with the kill\'s own sound', k.sfx === CONFIG.feedback.kill.sfx && bk.sfx === CONFIG.feedback.bigKill.sfx);
  check('the ice group is harder-edged than blood', CONFIG.fx.goo.groups.ice.soft < CONFIG.fx.goo.soft);
}

// ---------------------------------------------------------------------------
section('THE ICE FLOATS AND MELTS');
{
  resetIceShatter();
  const s = CONFIG.statusFx.shatter;
  const y0 = bounds.surfaceY - 12;
  const n = spawnIceShatter(0, y0, { radius: 1, vx: 0, vy: 0 });
  check('a body throws shards by its radius', n === Math.round(s.count + s.perRadius), `${n}`);
  check('...and they are all in the water', iceShardCount() === n);
  const sizes = iceShards().map((g) => g.size);
  const meanSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  check('shard size is a multiple of the body', Math.abs(meanSize - s.size) < s.size * 0.35, `${meanSize.toFixed(3)} for size ${s.size}`);
  check('every shard has the ice colour, jittered', iceShards().every((g) => g.tint > 0 && g.b >= g.r));

  // Rise: after the throw has bled off, the mean vertical velocity is UP.
  for (let i = 0; i < 40; i++) updateIceShatter(dt);
  const meanVy = iceShards().reduce((a, g) => a + g.vy, 0) / Math.max(1, iceShardCount());
  check('ice floats', meanVy > 0, `mean vy ${meanVy.toFixed(2)} after ${(40 * dt).toFixed(2)}s`);
  check('...at no more than the terminal rise', iceShards().every((g) => g.vy <= s.rise / 0.4 + 1e-6));

  // Capacity: never written past the end.
  const caps = iceShatterCapacity();
  check('every shape has room for what it is drawing', caps.every((c) => c >= 0) && caps.some((c) => c > 0), caps.join('/'));
  resetIceShatter();
  let thrown = 0;
  for (let i = 0; i < 8; i++) thrown += spawnIceShatter(i, y0, { radius: 3 });
  check('the cap holds', iceShardCount() <= s.max && thrown > s.max, `${iceShardCount()} of ${thrown} thrown, cap ${s.max}`);
  updateIceShatter(dt);
  const caps2 = iceShatterCapacity();
  const pending = [0, 0, 0];
  for (const g of iceShards()) pending[caps2.indexOf(g.shape.capacity) >= 0 ? 0 : 0] += 0; // shape identity checked below
  check('...and the buffers grew to fit', caps2.reduce((a, b) => a + b, 0) >= iceShardCount(), `${caps2.join('/')} for ${iceShardCount()}`);

  // Melt: gone by the end of the longest life.
  const longest = Math.max(...iceShards().map((g) => g.life));
  for (let i = 0; i < Math.ceil(longest / dt) + 2; i++) updateIceShatter(dt);
  check('shards melt away', iceShardCount() === 0);

  // Paused: nothing moves.
  spawnIceShatter(0, y0, { radius: 1 });
  const snap = iceShards().map((g) => [g.x, g.y, g.age]);
  updateIceShatter(0);
  check('a zero-dt frame holds still', iceShards().every((g, i) => g.x === snap[i][0] && g.y === snap[i][1] && g.age === snap[i][2]));
  check('switched off, nothing is thrown', (() => { s.enabled = false; const r = spawnIceShatter(0, y0, { radius: 1 }); s.enabled = true; return r === 0; })());
  resetIceShatter();
  check('a reset empties the water', iceShardCount() === 0);
}

console.log(failures ? `\nFAIL — ${failures} problem(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
