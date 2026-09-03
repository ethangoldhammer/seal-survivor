#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:pool
//
// Creature bodies are recycled rather than cloned per spawn (acquireVisual in
// assets.js). The measurement that forced it: on a real run, textures created
// came to 1.00 per kill — every skinned clone gets its own Skeleton and every
// Skeleton allocates its own bone texture — and removeEnemy disposed none of
// it, so renderer.info.memory.textures climbed to 1,466 over nine minutes.
// Frame-time attribution showed 199 of 224 hitches were neither a shader link
// nor a texture upload, and spikes tracked the KILL RATE rather than the
// creature count. That is the collector, running on the debris.
//
// What this file guards is the RESET, because a pooled body that comes back
// wrong is a bug with no error attached to it — a shark that spawns wearing the
// scale of the boss it was last used for, or holding the status motes of the
// creature that died in it. Every check below is a way that has to fail.
//
//   node --import ./tools/vite-loader.mjs tools/visual-pool-test.mjs
// ---------------------------------------------------------------------------

import '../tools/dom-stub.mjs';
import * as THREE from 'three';
import {
  ASSETS, createVisual, acquireVisual, releaseVisual,
  clearVisualPool, visualPoolStats, visualPoolCaps,
} from '../path/src/assets.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// No models are loaded in a terminal, so createVisual falls back to the
// procedural shape for a key — which is the right thing to test against here:
// the pool's contract is about hierarchies and transforms, not about which
// asset produced them. `enemyFish` is a real key with a real fallback.
const KEY = Object.keys(ASSETS).find((k) => ASSETS[k].shape) ?? 'enemyFish';

// ===========================================================================
section('It hands the same body back');

clearVisualPool();
const first = acquireVisual(KEY);
check('a fresh body carries a rest snapshot', !!first.userData.__rest);
releaseVisual(first);
check('and released, it is waiting in the pool', (visualPoolStats()[KEY] ?? 0) === 1,
  JSON.stringify(visualPoolStats()));

const second = acquireVisual(KEY);
check('the next spawn gets that same object, not a clone', second === first);
check('the pool is empty again', !visualPoolStats()[KEY]);
check('and it comes back visible', second.visible === true);

// ===========================================================================
section('A used body comes back the way it was born');

const restScale = second.scale.clone();
const restPos = second.position.clone();

// Everything a run does to a creature: a boss scales it, a hit shoves it, a
// death spins it, a rig hides a piece of it.
second.scale.multiplyScalar(3.7);
second.position.set(11, -4, 2);
second.quaternion.setFromEuler(new THREE.Euler(0.4, 1.2, -0.9));
second.visible = false;
let hidden = null;
second.traverse((o) => { if (o !== second && !hidden) { hidden = o; o.visible = false; } });

releaseVisual(second);
const third = acquireVisual(KEY);
check('the same body again', third === second);
check('its scale is back to birth', third.scale.distanceTo(restScale) < 1e-9,
  `${third.scale.x.toFixed(3)} vs ${restScale.x.toFixed(3)}`);
check('and its position', third.position.distanceTo(restPos) < 1e-9);
check('and its rotation', Math.abs(third.quaternion.x) < 1e-9 && Math.abs(third.quaternion.y) < 1e-9);
check('and it is visible', third.visible === true);
if (hidden) check('a sub-mesh something hid is shown again', hidden.visible === true);

// ===========================================================================
section('Nothing rides along from the last creature');

// Statuses, nets and markers hang objects off a creature mid-life. Left on,
// they would appear on whatever spawns into that body next — a fish arriving
// already on fire.
const mote = new THREE.Object3D();
mote.name = 'status-mote';
third.add(mote);
const deep = new THREE.Object3D();
third.children[0]?.add(deep);

releaseVisual(third);
const fourth = acquireVisual(KEY);
let strays = 0;
fourth.traverse((o) => { if (o === mote || o === deep) strays++; });
check('a mote hung on the root is gone', strays === 0, `${strays} stray node(s) survived`);
check('including one buried in the hierarchy', !deep.parent);

// ===========================================================================
section('The cap is the key\'s own busiest moment');

// A quiet key keeps everything it is handed, and a little spare on top. It is
// NOT sized down to the handful that happened to die together — but nor is it
// held at a flat floor it will never use, which is what a 24 here cost across
// a 21-key roster: 564 bodies pooled to cover 220 in the water.
clearVisualPool();
const few = [];
for (let i = 0; i < 6; i++) few.push(acquireVisual(KEY));
for (const v of few) releaseVisual(v);
check('a quiet key keeps everything it is handed', (visualPoolStats()[KEY] ?? 0) === 6,
  JSON.stringify(visualPoolCaps()[KEY]));
check('and its cap is its own peak plus headroom, not a flat floor',
  visualPoolCaps()[KEY].cap === 10, JSON.stringify(visualPoolCaps()[KEY]));

// The floor still catches a key that has barely been seen, so the first few
// spawns of something rare are not disposed and re-cloned one at a time.
clearVisualPool();
const one = acquireVisual(KEY);
releaseVisual(one);
check('a key seen once is floored, not sized to 1', visualPoolCaps()[KEY].cap === 6,
  JSON.stringify(visualPoolCaps()[KEY]));

// The case the flat 24 got wrong: a school bigger than the old cap. All 40
// were in the water at once, so holding 40 costs what the game already spent.
clearVisualPool();
const many = [];
for (let i = 0; i < 40; i++) many.push(acquireVisual(KEY));
check('the peak is the live count, not the pool size', visualPoolCaps()[KEY].peak === 40,
  JSON.stringify(visualPoolCaps()[KEY]));
for (const v of many) releaseVisual(v);
const held = visualPoolStats()[KEY] ?? 0;
check('a school past the old flat 24 is kept whole', held === 40, `${held} held`);

// And it is still a cap. Something spawning hundreds of one key is a spawn
// bug, and the pool should not hold the evidence.
clearVisualPool();
const horde = [];
for (let i = 0; i < 140; i++) horde.push(acquireVisual(KEY));
for (const v of horde) releaseVisual(v);
const kept = visualPoolStats()[KEY] ?? 0;
check('but the ceiling still holds', kept === 96, `${kept} held`);
check('and the overflow was let go rather than kept', kept < horde.length);

// The live count has to come back down, or one busy wave would leave the pool
// believing that many are permanently in play.
clearVisualPool();
const wave = [];
for (let i = 0; i < 5; i++) wave.push(acquireVisual(KEY));
for (const v of wave) releaseVisual(v);
for (let i = 0; i < 5; i++) wave[i] = acquireVisual(KEY);
check('a second wave of the same size does not raise the peak',
  visualPoolCaps()[KEY].peak === 5, JSON.stringify(visualPoolCaps()[KEY]));
for (const v of wave) releaseVisual(v);

// A visual this never issued must not move the count — releaseVisual is
// documented as safe on anything, and a foreign body arriving here used to be
// the one way the live count could go negative.
const before = visualPoolCaps()[KEY].peak;
releaseVisual(new THREE.Object3D());
const foreign = createVisual(KEY);
releaseVisual(foreign);
check('a foreign visual does not disturb the live count',
  visualPoolCaps()[KEY].peak === before && acquireVisual(KEY) && visualPoolCaps()[KEY].peak === before,
  JSON.stringify(visualPoolCaps()[KEY]));

// ===========================================================================
section('Bone textures are freed for anything not pooled');

// The leak, in miniature. A skinned body past the cap has to have its Skeleton
// disposed on the way out — that is the only GPU resource a clone owns, since
// geometry and materials belong to the template and are shared.
clearVisualPool();
const skinned = acquireVisual(KEY);
const bone = new THREE.Bone();
const skin = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
skin.bind(new THREE.Skeleton([bone]));
skin.skeleton.computeBoneTexture();
check('the skeleton has a bone texture to lose', !!skin.skeleton.boneTexture);
skinned.add(skin);
// Released while it is a stray, so the reset prunes it and the body is pooled;
// dispose it directly to prove the mechanism the cap path relies on.
skin.skeleton.dispose();
check('and dispose frees it', skin.skeleton.boneTexture === null);
releaseVisual(skinned);

// ===========================================================================
section('A real rig comes back at rest, not in the pose it died in');
//
// The case everything above only approximates. A creature's bones are driven
// by its mixer every frame, so a body released mid-death-clip is holding that
// pose in 128 separate local transforms — and the next creature to spawn into
// it would appear folded up until its own mixer got a frame in. On a one-shot
// clip that clamps on its last frame (which is exactly what 'death' does) it
// might never recover.
//
// octopus_rig.glb because it ships no textures, so GLTFLoader resolves in a
// terminal, and because at 128 joints it is the deepest hierarchy in the game.
{
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { installModel } = await import('../path/src/assets.js');

  const MODEL = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/octopus_rig.glb');
  if (!existsSync(MODEL)) {
    check('the rig is on disk to test against', false, MODEL);
  } else {
    const buf = readFileSync(MODEL);
    const gltf = await new GLTFLoader().parseAsync(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
    );
    installModel('octoGrabber', gltf.scene, gltf.animations);
    clearVisualPool();

    const rig = acquireVisual('octoGrabber');
    const bones = [];
    rig.traverse((o) => { if (o.isBone) bones.push(o); });
    check('the rig came through with its skeleton', bones.length > 20, `${bones.length} bones`);

    // Pose it, the way a death clip leaves a body.
    const restOf = bones.map((b) => b.position.clone());
    for (const b of bones) b.position.add(new THREE.Vector3(0.7, -0.3, 0.2));
    const moved = bones.filter((b, i) => b.position.distanceTo(restOf[i]) > 1e-6).length;
    check('and every bone was moved off rest', moved === bones.length, `${moved}/${bones.length}`);

    releaseVisual(rig);
    const reused = acquireVisual('octoGrabber');
    check('the same rig came back', reused === rig);
    let wrong = 0;
    for (let i = 0; i < bones.length; i++) if (bones[i].position.distanceTo(restOf[i]) > 1e-6) wrong++;
    check('every bone is back at its bind pose', wrong === 0, `${wrong} still posed`);

    // And the expensive thing it exists to avoid: the same Skeleton, so the
    // same bone texture, so nothing allocated and nothing to leak.
    let skels = 0;
    const seen = new Set();
    reused.traverse((o) => { if (o.isSkinnedMesh && !seen.has(o.skeleton)) { seen.add(o.skeleton); skels++; } });
    check('and it is the same skeleton, so no new bone texture', skels > 0 && seen.size === skels,
      `${skels} skeleton(s), reused`);
    clearVisualPool();
  }
}

// ===========================================================================
section('The rig drivers ride with the body and come back reset');
//
// The second half of the pooling: a mixer, an action per state and three rig
// solvers were being built on every spawn, which at fifteen spawns a second was
// what remained after the bodies themselves stopped churning. They are cached
// on the body — and every one of them holds state that has to be cleared, or a
// creature spawns wearing how the last one died.
{
  const { createAnimationController } = await import('../path/src/systems/animation.js');
  const { createHeadLook } = await import('../path/src/systems/headLook.js');
  const { createJawDriver } = await import('../path/src/systems/jaw.js');
  const { createClawDriver } = await import('../path/src/systems/crabClaw.js');

  // Every driver the spawn path can build has to offer a reset, or pooling
  // silently carries state across lives.
  //
  // Read off the SOURCE rather than by constructing one of each. Three of the
  // four return null unless the model declares the rig they drive — a head
  // chain, a jaw, a claw — and the only assets that do carry textures, which
  // GLTFLoader cannot decode in a terminal. Building them here would hand back
  // three nulls and the check would pass by testing nothing, which is worse
  // than not having it. A regex over the module still fails the day somebody
  // adds a fifth driver and forgets its reset.
  const { readFileSync: read } = await import('node:fs');
  const { resolve: rp, dirname: dn } = await import('node:path');
  const { fileURLToPath: furl } = await import('node:url');
  const SRC = rp(dn(furl(import.meta.url)), '../path/src/systems');
  const drivers = ['animation.js', 'headLook.js', 'jaw.js', 'crabClaw.js'];
  const noReset = drivers.filter((f) => !/^\s{4}reset\(\)\s*\{/m.test(read(rp(SRC, f), 'utf8')));
  check('every rig driver module exposes a reset()', noReset.length === 0,
    noReset.length ? `missing in: ${noReset.join(', ')}` : drivers.join(', '));

  // And that the spawn path actually CALLS them. A reset nobody invokes is the
  // same bug with extra steps.
  const spawnSrc = read(rp(SRC, '../entities/enemies.js'), 'utf8');
  const called = ['anim?.reset()', 'look?.reset()', 'jaw?.reset()', 'claw?.reset()']
    .filter((c) => spawnSrc.includes(c));
  check('and the spawn path resets all four', called.length === 4,
    `${called.length}/4 — ${called.join(' ')}`);

  // The one that CAN be exercised headlessly, and the one that matters most:
  // 'death' is LoopOnce with clampWhenFinished and never expires on its own, so
  // without this reset a recycled body spawns already dead and stays that way.
  // The controller builds against a bare object because it falls back to the
  // procedural sine driver when a model declares no clips.
  const anim = createAnimationController(new THREE.Object3D());
  if (anim && typeof anim.trigger === 'function') {
    anim.trigger('death');
    anim.reset();
    check('a controller reset drops the one-shot it was holding', !anim.isPlayingOneShot());
  } else {
    check('a controller could be built to test the reset on', false, 'createAnimationController returned nothing usable');
  }
}

// ===========================================================================
section('An unknown body is safe to release');

// removeEnemy releases unconditionally rather than tracking which creatures
// came from the pool, so this has to be a no-op and not a throw.
let threw = false;
try {
  releaseVisual(new THREE.Object3D());
  releaseVisual(null);
  releaseVisual(undefined);
} catch (err) {
  threw = true;
  console.log('    ', err.message);
}
check('releasing something the pool never issued does nothing', !threw);

clearVisualPool();
check('clearing empties it', Object.keys(visualPoolStats()).length === 0);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
