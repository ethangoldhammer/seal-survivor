#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bite
//
// WHERE A BOSS'S BITE ACTUALLY LANDS, measured on the bodies the game loads.
//
// NOT ONLY THE BOSSES ANY MORE. The six apex sharks carry a `biteDamage` too
// now that they commit to a readable pass (see `shark.lunge` in config.js), so
// this file measures ten bodies rather than five — and it always would have,
// because BITERS is built off the CSV rather than off a list here. The wildlife
// bodies are half the length of a boss's and the seal's hitRadius is the same
// 1.0 in every reach, which is exactly the kind of thing that quietly makes a
// gate mean something different; the measurement note further down is what came
// out of running them through it.
//
// The bite is the only attack the four chasing bosses have (see `biteDamage`
// in enemies.csv and onPlayerBite in main.js), and the thing that decides
// whether it is an attack or just a second contact drain is WHERE it is
// allowed to land. The snap itself fires from a very long way out on purpose:
// `playerBiteReach` times CONFIG.bite.lead is about twenty-five units on a
// boss, a whole body length, because a twenty-metre animal telegraphing a bite
// is the entire reason the jaw is animated. Bill damage on that gate and a
// megalodon bites you with its tail fluke.
//
// So the damage is gated a second time, on CONFIG.bite.mouthReach — a sphere
// around the creature's own origin. That works because of a fact about these
// rigs which is TRUE AND NOT OBVIOUS: the container's origin sits up near the
// head, not at the middle of the animal. The megalodon's snout is 3.9 units in
// front of it and its fluke 21.9 units behind. Nothing enforces that; it falls
// out of each model's `pivot`, and the next boss to be added could easily be
// built around its middle instead — at which point the same fraction that
// reads as "the head" here would quietly become "everywhere", and the fix that
// answered a player saying "I take a ton of damage touching a boss anywhere"
// would have reintroduced it through a different door.
//
// Hence: measured, per body, against the real snout and the real tail.
//
//   REACHES   the head is inside the zone. A gate too tight for the animal's
//             own snout is a bite that can never land, and it fails silently —
//             the jaw still opens, the sound still plays, and nothing happens.
//
//   STOPS     the tail is outside it, with room to spare. This is the half
//             that rots.
//
//   BODY      every biting row's model is actually on disk and its origin is
//             forward of its own centre, which is the assumption the whole
//             gate rests on.
//
//   node --import ./tools/vite-loader.mjs tools/boss-bite-test.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
// The boss models embed their textures and GLTFLoader decodes those through
// createImageBitmap — without a stub the parse promise never settles and this
// exits with no error at all. Nothing here reads a pixel; the geometry is the
// whole subject.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { parseBossCsv } from '../path/src/bossTable.js';
import bossesCsv from '../path/src/bosses.csv?raw';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// Every creature that bites, off the CSV rather than off a list here — a boss
// given a `biteDamage` arrives in this file by existing.
const BITERS = Object.entries(CONFIG.enemies).filter(([, def]) => (def.biteDamage ?? 0) > 0);
// ...and the size step each one arrives at, from bosses.csv, since that is
// what the hitbox and the reach are both scaled by.
const ROSTER = parseBossCsv(bossesCsv, CONFIG.enemies, () => {});
const sizeMulOf = (key) => (ROSTER.find((b) => b.enemy === key)?.sizeMul ?? 1);

const loader = new GLTFLoader();
const PLAYER_R = CONFIG.player.hitRadius ?? 0.5;

section('THE BITE LANDS ON THE HEAD');
check('there are biting creatures to check', BITERS.length > 0, `${BITERS.length} found`);

for (const [key, def] of BITERS) {
  // A def may name one asset or roll between several bodies (the orca sends a
  // bull or a cow). EVERY one has to pass — a gate that works on the bull and
  // not the cow is a boss that bites half the time.
  const assets = def.assets ?? [def.asset];
  for (const assetKey of assets) {
    const model = ASSETS[assetKey]?.model;
    const path = model ? resolve(HERE, '..', 'public', model.replace(/^\//, '')) : null;
    if (!path || !existsSync(path)) {
      check(`${key} / ${assetKey}: model on disk`, false, model ?? 'no model declared');
      continue;
    }
    const buf = readFileSync(path);
    const gltf = await loader.parseAsync(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    installModel(assetKey, gltf.scene, gltf.animations);

    // The body as the boss arrives in it: createVisual's own scale (the asset's
    // size multiplier, already carrying its `fit`) times the archetype's step.
    const vis = createVisual(assetKey);
    const mul = sizeMulOf(key);
    const spawnScale = (vis.scale.x || 1) * mul;
    vis.scale.multiplyScalar(mul);
    const scene = new THREE.Scene();
    scene.add(vis);
    scene.updateMatrixWorld(true);

    // Laid out nose-up by createVisual: forward is +Y, and the container's
    // origin is (0,0,0), which is exactly what onPlayerBite measures from.
    const box = new THREE.Box3().setFromObject(vis);
    const snout = box.max.y;
    const tail = box.min.y;
    const length = snout - tail;
    const radius = def.radius * spawnScale;
    const reach = radius * (CONFIG.bite.mouthReach ?? 0.55) + PLAYER_R;
    const label = `${key} / ${assetKey}`;

    // The gate the whole thing rests on: is the origin at the front?
    check(`${label}: the body is built around its head`,
      snout < length * 0.35,
      `origin ${snout.toFixed(1)}u behind the snout on a ${length.toFixed(1)}u body`);

    // REACHES — a player at the very tip of the snout is bitten.
    check(`${label}: the snout is inside the bite`,
      reach >= snout,
      `reach ${reach.toFixed(1)}u against a snout ${snout.toFixed(1)}u out`);

    // STOPS — and one at the fluke is not, by a clear margin rather than by a
    // rounding difference.
    check(`${label}: the tail is not`,
      reach < Math.abs(tail) * 0.5,
      `reach ${reach.toFixed(1)}u against a tail ${Math.abs(tail).toFixed(1)}u back`);

    // ...and the zone is a HEAD rather than most of the animal. The number to
    // watch: what fraction of the body's length can bite you.
    //
    // MEASURED ALONG THE BODY, NOT AS A DIAMETER. This used to be `reach * 2`,
    // which is the sphere's full width — and most of the front half of that
    // sphere is open water, because the sphere is centred on the ORIGIN and the
    // origin sits near the snout (that is the whole fact this file exists to
    // hold). So it counted several units of nothing as though they were body.
    //
    // On a boss the error is small and it passed anyway. It stopped being small
    // the moment the six wildlife sharks grew a `biteDamage` and arrived here:
    // the seal's own hitRadius is a CONSTANT 1.0 in every reach, so on a 10-unit
    // shark it is a fifth of the body all by itself, and doubling it read as
    // 55% of the animal biting when the real covered span is 43%. The tail
    // check above — which is the one that actually rots — passed on every one
    // of them with room to spare, which is the tell that this measurement, not
    // the gate, was what had gone wrong.
    //
    // The covered span is the snout (the front of the body) back to `-reach`
    // (the rear of the sphere), because the check above has already established
    // that the reach clears the snout.
    const frac = (snout + reach) / length;
    check(`${label}: the bite is the front of the animal, not the animal`,
      frac <= 0.5,
      `${(frac * 100).toFixed(0)}% of a ${length.toFixed(1)}u body`);

    // Finally, against the gate that FIRED the snap — the two must not agree,
    // or the second gate is doing nothing and the tail bites again.
    const fired = (radius + PLAYER_R) * (CONFIG.bite.playerReach ?? 1.35)
      * (CONFIG.bite.lead ?? 2.2);
    check(`${label}: the damage gate is tighter than the gate that fired it`,
      reach < fired * 0.5,
      `bites at ${reach.toFixed(1)}u, snaps from ${fired.toFixed(1)}u`);
  }
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nevery bite lands on a head\n');
process.exit(failures ? 1 : 0);
