#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bosswarm
//
// The boss arrival's cost, paid during the hush instead of on the frame the
// creature appears — see systems/bossWarmup.js.
//
// FOUR CLAIMS, and every one of them is a bug that ships SILENTLY if it flips:
// a warm-up that warms nothing runs, reports itself finished, costs the same
// three seconds and buys nothing at all. None of these throw.
//
//   THE BODY IS REUSED   The whole mechanism. The warm-up builds the boss's
//                        body during the hush and hands it to the visual pool;
//                        the arrival's acquireVisual must POP THAT BODY rather
//                        than clone a second one. Measured on the POOL, not on
//                        the returned object — "a body came back" is equally
//                        true of a fresh clone, so what is asserted is that one
//                        was waiting beforehand and that the arrival consumed
//                        it. A body built with createVisual instead of
//                        acquireVisual is refused by the pool and would leave
//                        that count at zero while nothing else here noticed.
//
//   EVERY TEXTURE        The upload is the expensive half (the anglerfish is
//                        four 2048-squares, ~89MB). The queue must reach all of
//                        them, deduplicated by SOURCE — two Texture objects
//                        over one Source share the GPU upload, so counting
//                        texture objects would report success while uploading
//                        the same image six times.
//
//   ONE STEP A FRAME     The point is to spread the work, not to move it. A
//                        queue that did everything on its first tick would put
//                        the same stall three seconds earlier and this test
//                        would still pass every other claim.
//
//   IT SURVIVES A CANCEL A hush is abandoned by the tuner, by a forced spawn
//                        and by a run ending. The bodies must go back to the
//                        pool exactly ONCE — released twice, one body is filed
//                        under two pool slots and handed to two creatures at
//                        once, which is two enemies sharing one skeleton.
//
// AND IT RUNS WITHOUT A GPU. There is no renderer here, so `post` is a stub
// that counts what it was asked to do. That is the right subject anyway: what
// is being tested is the QUEUE — which bodies, which textures, in what order,
// how many per tick — and not whether three's uploader works.
//
//   node --import ./tools/vite-loader.mjs tools/boss-warmup-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// Both boss bodies embed their textures and GLTFLoader decodes those through
// createImageBitmap. Without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all — the same
// trap tools/boss-rig-test.mjs documents.
globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { CONFIG } from '../path/src/config.js';
import { updateBoss, resetBoss, bossState } from '../path/src/systems/boss.js';
import { installModel, acquireVisual, releaseVisual, clearVisualPool, visualPoolStats } from '../path/src/assets.js';
import {
  installBossWarmup, beginBossWarmup, tickBossWarmup,
  cancelBossWarmup, bossWarmupState, bossWarmupReady,
} from '../path/src/systems/bossWarmup.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- the real bodies --------------------------------------------------------
// The megalodon is the archetype every run can meet from level 0, and it is
// the second-heaviest body in the roster by texture. Loaded for real: a
// warm-up tested against a bare THREE.Group would pass with no materials to
// find and no skeleton to clone, which is the whole thing it exists to move.
const BODIES = [
  { asset: 'enemyMegalodon', model: 'megalodon.glb' },
];

const loader = new GLTFLoader();
for (const body of BODIES) {
  const path = resolve(HERE, '../public/models', body.model);
  if (!existsSync(path)) {
    console.error(`\nmissing ${path} — the warm-up cannot be tested against a model that isn't there.\n`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  const gltf = await loader.parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  installModel(body.asset, gltf.scene, gltf.animations);
}

// --- the pipeline stub ------------------------------------------------------
// Records rather than renders. `warm` resolves on a microtask, like the real
// compileAsync, so the release-before-compile ordering is actually exercised
// instead of being flattened into a synchronous call that could never expose it.
function makeStub() {
  const seen = { uploads: [], compiles: 0, compiled: null };
  return {
    seen,
    post: {
      initTexture(tex) { seen.uploads.push(tex); return true; },
      async warm(group) {
        seen.compiles++;
        seen.compiled = group.children.slice();
        await Promise.resolve();
      },
    },
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
  };
}

// Drive the queue to completion the way the hush does: one tick per frame,
// with a cap so a queue that never finishes fails the test instead of hanging.
async function drain(maxTicks = 200) {
  let ticks = 0;
  while (ticks < maxTicks) {
    const before = bossWarmupState();
    if (!before.active) break;
    tickBossWarmup();
    ticks++;
    // Let an in-flight compile settle — the real one settles between frames.
    await Promise.resolve();
    await Promise.resolve();
  }
  return ticks;
}

const SHARK = { id: 'bossShark', enemy: 'bossShark' };

// ---------------------------------------------------------------------------
section('the queue is inert until a pipeline is installed');
{
  installBossWarmup({});
  check('reports not ready', !bossWarmupReady());
  check('refuses to start', beginBossWarmup(SHARK) === false);
  check('a tick is a harmless no-op', tickBossWarmup() === false);
}

// ---------------------------------------------------------------------------
section('the body the warm-up builds is the body the arrival gets');
{
  clearVisualPool();
  const stub = makeStub();
  installBossWarmup(stub);

  check('the pool starts empty', (visualPoolStats().enemyMegalodon ?? 0) === 0);
  check('starts', beginBossWarmup(SHARK) === true);
  await drain();

  // THE POOL IS THE HANDOVER, so the pool is where the claim is measured. A
  // warm-up that built a body and kept it — or built one the pool refused,
  // which is what a createVisual body would be — leaves this at zero while
  // every other assertion in this file still passes.
  const waiting = visualPoolStats().enemyMegalodon ?? 0;
  check(
    'the warm-up left a body waiting in the pool',
    waiting === 1,
    `${waiting} waiting`,
  );

  // ...and this is what spawnOne does on the arrival frame. It must TAKE that
  // body rather than clone a second one beside it.
  const arrival = acquireVisual('enemyMegalodon');
  check('the arrival got a body', !!arrival);
  check(
    'and it took the warmed one rather than cloning',
    (visualPoolStats().enemyMegalodon ?? 0) === 0,
    'the pool is empty again',
  );
  releaseVisual(arrival);
}

// ---------------------------------------------------------------------------
section('every texture on the body is uploaded, once per source');
{
  clearVisualPool();
  const stub = makeStub();
  installBossWarmup(stub);
  beginBossWarmup(SHARK);
  await drain();

  // What the body actually carries, counted independently of the queue so this
  // is a comparison rather than the queue marking its own homework.
  const probe = acquireVisual('enemyMegalodon');
  const sources = new Set();
  let skinned = 0;
  probe.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.isSkinnedMesh && o.skeleton) skinned++;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      for (const slot of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap']) {
        if (m[slot]?.source) sources.add(m[slot].source.uuid);
      }
    }
  });
  releaseVisual(probe);

  const uploaded = new Set(stub.seen.uploads.map((t) => t.source.uuid));
  check(
    'the body has textures to warm at all',
    sources.size > 0,
    `${sources.size} distinct source(s)`,
  );
  check(
    'every one of the asset\'s own maps was uploaded',
    sources.size > 0 && [...sources].every((id) => uploaded.has(id)),
    `${sources.size} map(s)`,
  );
  check(
    'nothing was uploaded twice',
    stub.seen.uploads.length === uploaded.size,
    `${stub.seen.uploads.length} call(s) for ${uploaded.size} distinct source(s)`,
  );

  // THE PER-CLONE HALF. The maps above belong to the asset and are shared by
  // every body built from it; the bone texture is not — three builds one per
  // skeleton, lazily, inside the first render. Warming the maps and stopping
  // leaves exactly one upload per skinned mesh on the arrival frame, which is
  // what tools/looks/boss-warm.js measured in a real context before this
  // existed. It is asserted by COUNT rather than by identity because the
  // texture does not exist until the warm-up itself calls for it.
  const boneTextures = stub.seen.uploads.length - sources.size;
  check(
    'and one bone texture per skinned mesh on top of them',
    skinned > 0 && boneTextures === skinned,
    `${boneTextures} bone texture(s) for ${skinned} skinned mesh(es)`,
  );

  check('the programs were compiled', stub.seen.compiles === 1, `${stub.seen.compiles} compile pass(es)`);
}

// ---------------------------------------------------------------------------
section('the work is spread — one unit per tick, never a burst');
{
  clearVisualPool();
  const stub = makeStub();
  installBossWarmup(stub);
  beginBossWarmup(SHARK);

  // ONE tick. A queue that front-loads would have uploaded everything here,
  // which is the same stall three seconds earlier — the failure this whole
  // design is arranged around, and the one nothing else in the file can see.
  tickBossWarmup();
  const afterOne = stub.seen.uploads.length;
  check(
    'the first tick uploads nothing (it is still building the body)',
    afterOne === 0,
    `${afterOne} upload(s) on tick 1`,
  );

  tickBossWarmup();
  check(
    'the second tick uploads exactly one texture',
    stub.seen.uploads.length === 1,
    `${stub.seen.uploads.length} after tick 2`,
  );

  const ticks = await drain();
  check(
    'and it takes a tick per unit of work, not one tick total',
    ticks >= 3,
    `${ticks + 2} ticks for 1 body + textures + compile`,
  );
}

// ---------------------------------------------------------------------------
section('an abandoned hush releases its bodies exactly once');
{
  clearVisualPool();
  const stub = makeStub();
  installBossWarmup(stub);
  beginBossWarmup(SHARK);
  tickBossWarmup();               // build the body
  const built = bossWarmupState().built;
  check('a body was built before the cancel', built === 1, `${built} built`);

  cancelBossWarmup();
  check('the queue stood down', bossWarmupState().active === false);
  cancelBossWarmup();             // the double-cancel the lifecycle can produce

  // A body released twice sits in the pool twice, and the second acquire hands
  // out an object that is already a live creature. Two acquires must therefore
  // give two DIFFERENT objects.
  const a = acquireVisual('enemyMegalodon');
  const b = acquireVisual('enemyMegalodon');
  check(
    'the pool never hands the same body out twice',
    a !== b,
    a === b ? 'two creatures would share one skeleton' : 'distinct',
  );
  releaseVisual(a);
  releaseVisual(b);
}

// ---------------------------------------------------------------------------
section('an unknown archetype is refused rather than half-started');
{
  const stub = makeStub();
  installBossWarmup(stub);
  check('no archetype', beginBossWarmup(null) === false);
  check('an enemy key config has never heard of', beginBossWarmup({ enemy: 'notACreature' }) === false);
  check('nothing was left queued', bossWarmupState().active === false);
}

// ---------------------------------------------------------------------------
section('the roster it will be asked to warm');
{
  const rows = [];
  for (const enemy of ['bossShark', 'bossOrca', 'bossSquid', 'bossCrab', 'bossMosasaur', 'bossHammerhead', 'bossBoat', 'bossYacht', 'bossAnglerfish']) {
    const def = CONFIG.enemies[enemy];
    if (!def) continue;
    const keys = def.assets?.length ? [...def.assets] : (def.asset ? [def.asset] : []);
    if (def.crewAssets?.length) keys.push(...def.crewAssets);
    else if (def.crewAsset) keys.push(def.crewAsset);
    rows.push({ enemy, keys });
  }
  for (const r of rows) console.log(`    ${r.enemy.padEnd(16)} ${r.keys.join(', ')}`);
  check(
    'every archetype resolves to at least one asset to warm',
    rows.every((r) => r.keys.length > 0),
    rows.filter((r) => !r.keys.length).map((r) => r.enemy).join(', ') || 'all nine',
  );
}

// ---------------------------------------------------------------------------
section('one arrival still costs exactly one draw from the shuffle bag');
// THE REGRESSION THIS FILE WAS EXTENDED FOR. Moving the draw to the front of
// the hush (so there is something to warm) put it somewhere that can happen
// MORE THAN ONCE per arrival: a hush is abandoned with its draw already out of
// the bag — the tuner switching the fight off is the ordinary way — and a
// naive re-draw on the next hush burns two archetypes to send one boss. The
// run then starts repeating bosses it never actually sent, which reads as the
// shuffle bag being broken and is nowhere near the code that broke it.
//
// Measured on the BAG rather than on the archetype, because the archetype is
// random and would need a seed to compare: `drawn` grows by exactly one per
// arrival however the roll lands.
{
  const scene = new THREE.Scene();
  resetBoss(scene);
  installBossWarmup({});   // no pipeline — the draw must be right regardless

  // The hush's frames only. updateBoss returns null all through it and spawns
  // nothing, so this needs none of the enemy machinery a full arrival does.
  const gameState = { level: 99, running: true, difficulty: 0 };
  const hushFrames = Math.ceil((CONFIG.boss?.hush?.seconds ?? 3) * 60) - 2;
  const runHush = (frames) => { for (let i = 0; i < frames; i++) updateBoss(1 / 60, gameState, scene); };

  bossState.nextLevel = 1;
  runHush(3);
  const afterFirst = bossState.bag.drawn.length;
  check('the hush draws as soon as it begins', afterFirst === 1, `${afterFirst} drawn`);
  check('and holds it', !!bossState.pending, bossState.pending?.id ?? 'nothing held');

  // The tuner path: switched off mid-hush, then back on. This is the one that
  // used to draw a second time.
  CONFIG.boss.enabled = false;
  updateBoss(1 / 60, gameState, scene);
  CONFIG.boss.enabled = true;
  runHush(3);
  const afterToggle = bossState.bag.drawn.length;
  check(
    'a hush abandoned and restarted does NOT draw again',
    afterToggle === 1,
    `${afterToggle} drawn for one pending arrival`,
  );

  // ...and the held draw survived the toggle rather than being thrown away,
  // which would silently skip an archetype for the rest of the bag.
  check('the archetype it had drawn is still the one coming', !!bossState.pending);

  resetBoss(scene);
  check('a run reset clears the held draw', bossState.pending === null);
  check('...and rebuilds the bag', bossState.bag.drawn.length === 0);
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
