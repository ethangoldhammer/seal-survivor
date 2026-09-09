#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:frontlayer
//
// THE DEAD BOSS OVER ITS OWN SMOKE — systems/frontLayer.js.
//
// The goo is composited over the finished frame and the sprites draw with the
// depth test off, so nothing in the world pass can be put in front of either.
// The held corpse is therefore moved onto a layer the world pass skips and a
// second pass draws after the goo. Every way that can go wrong is silent:
//
//   STILL UNDER          bringToFront marks the root but not the meshes under
//                        it — a Group draws nothing, so the body draws in the
//                        world pass exactly as before and the change is a no-op.
//
//   A GHOST IN THE POOL  The visual goes back to the pool still on the front
//                        layer. The next creature to wear it is skipped by the
//                        world pass and drawn only while a boss is dying: an
//                        invisible fish, and nothing throws.
//
//   THE CAMERA KEPT      renderFrontLayer leaves the camera's mask on the front
//                        layer. The next world pass draws the corpse and
//                        nothing else — one black frame, then whatever the
//                        next system to touch the camera happens to do.
//
//   UNLIT                A directional light on layer 0 alone is not gathered
//                        for a pass through another mask. The body draws, in
//                        the right place, black.
//
//   WIPED                The front pass clears. The boss is drawn over a blank
//                        frame, which the bloom then dutifully blooms. There
//                        are two ways in: autoClear, and the scene's Color
//                        background, which three clears to regardless — the
//                        one that actually shipped, as a boss on a blue sky.
//
// No renderer, on purpose: the pass is three calls on a stub, and what matters
// is which mask and which flags it was called with.
//
//   node --import ./tools/vite-loader.mjs tools/front-layer-test.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  FRONT_LAYER, bringToFront, sendBack, frontLayerActive, frontLayerCount,
  renderFrontLayer, resetFrontLayer,
} from '../path/src/systems/frontLayer.js';
import {
  holdBossCorpse, updateBossCorpses, resetBossCorpses, bossCorpseCount,
} from '../path/src/systems/bossCorpse.js';
import { startBossKill, updateBossKill, resetBossKill } from '../path/src/systems/bossKill.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';
import { initBossBooms } from '../path/src/systems/bossBoom.js';
import { initBossLight } from '../path/src/systems/bossLight.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(resolve(HERE, '..', p), 'utf8');
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const WORLD = new THREE.Layers();           // mask 1: what the world pass sees
const FRONT = new THREE.Layers();
FRONT.set(FRONT_LAYER);

// A body with something to draw under the root: a Group, a Mesh, and a
// SkinnedMesh with a bone under it, because a boss is all three.
function body() {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x884422 }));
  const g = new THREE.PlaneGeometry(4, 2, 2, 2);
  const n = g.attributes.position.count;
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) sw[i * 4] = 1;
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const bone = new THREE.Bone();
  const skin = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial({ color: 0x66aa88 }));
  skin.add(bone);
  skin.bind(new THREE.Skeleton([bone]));
  const visual = new THREE.Group();
  visual.add(mesh, skin);
  root.add(visual);
  root.updateMatrixWorld(true);
  return { root, visual, drawn: [mesh, skin] };
}

const every = (root, layers) => {
  let ok = true;
  root.traverse((o) => { if (!o.layers.test(layers)) ok = false; });
  return ok;
};
const none = (root, layers) => {
  let ok = true;
  root.traverse((o) => { if (o.layers.test(layers)) ok = false; });
  return ok;
};

console.log('\nthe front layer\n');

// --- THE MARK ---------------------------------------------------------------
section('the mark');
{
  resetFrontLayer();
  const b = body();
  check('nothing in front at rest', !frontLayerActive() && frontLayerCount() === 0);
  check('a fresh body is on the world layer', every(b.root, WORLD) && none(b.root, FRONT));

  bringToFront(b.root);
  check('bringToFront reaches every mesh under the root',
    b.drawn.every((m) => m.layers.test(FRONT)));
  check('...and takes them OFF the world layer, or they draw twice', none(b.root, WORLD));
  check('the pass has something to draw', frontLayerActive() && frontLayerCount() === 1);
  bringToFront(b.root);
  check('a second call on the same body is one body, not two', frontLayerCount() === 1);

  sendBack(b.root);
  check('sendBack puts every mesh back on the world layer',
    every(b.root, WORLD) && none(b.root, FRONT));
  check('...and the pass has nothing to draw', !frontLayerActive());
  sendBack(b.root);
  check('sendBack on a body that was never in front is harmless', frontLayerCount() === 0);

  const c = body();
  bringToFront(b.root);
  bringToFront(c.root);
  resetFrontLayer();
  check('reset puts every body back and forgets it',
    every(b.root, WORLD) && every(c.root, WORLD) && frontLayerCount() === 0);
}

// --- THE PASS ---------------------------------------------------------------
section('the pass');
{
  resetFrontLayer();
  const scene = new THREE.Scene();
  // A sky, like the world's. three clears to a Color background on every render
  // of the scene whatever autoClear says, so this is the one property that can
  // turn "draw the boss over the frame" into "draw the boss over blue".
  const sky = new THREE.Color(0x87ceeb);
  scene.background = sky;
  const camera = new THREE.PerspectiveCamera();
  const calls = [];
  const renderer = {
    autoClear: true,
    render(s, cam) {
      calls.push({ s, mask: cam.layers.mask, autoClear: this.autoClear, background: s.background });
    },
  };

  renderFrontLayer(renderer, scene, camera);
  check('nothing in front: no draw at all', calls.length === 0);

  const b = body();
  scene.add(b.root);
  bringToFront(b.root);
  renderFrontLayer(renderer, scene, camera);
  check('one draw of the WORLD scene, not a scene of its own',
    calls.length === 1 && calls[0].s === scene);
  check('drawn through the front mask alone', calls[0]?.mask === FRONT.mask,
    `mask ${calls[0]?.mask}`);
  check('without clearing what is already in the target', calls[0]?.autoClear === false);
  check('...and with the sky taken off the scene, or three clears to it anyway',
    calls[0]?.background === null);
  check('the sky is put back afterwards', scene.background === sky);
  check('the camera gets its own mask back', camera.layers.mask === 1, `mask ${camera.layers.mask}`);
  check('...and so does the renderer', renderer.autoClear === true);

  camera.layers.enable(5);
  const before = camera.layers.mask;
  renderFrontLayer(renderer, scene, camera);
  check('a camera with its own odd mask gets exactly that mask back', camera.layers.mask === before);
  resetFrontLayer();
}

// --- THE HOLD ---------------------------------------------------------------
// Through the REAL bossCorpse.js: in front from the killing frame, back before
// the pool, on both routes out.
section('the hold');
{
  const scene = new THREE.Scene();
  initParticles(scene);
  initBossBooms(scene);
  initBossLight(scene);
  resetParticles();
  resetFrontLayer();
  resetBossKill();
  resetBossCorpses();

  const b = body();
  scene.add(b.root);
  const e = {
    isBoss: true, mesh: b.root, visual: b.visual, anim: null, hitShape: null,
    def: { radius: 2 }, radius: 2, vx: 3, vy: 0, assetKey: 'enemyMegalodon',
  };
  const held = holdBossCorpse(e, scene);
  check('the body is held', held === true && bossCorpseCount() === 1);
  check('...and in front from the killing frame',
    every(b.root, FRONT) && frontLayerCount() === 1);

  // The whole beat, past the burst.
  let t = 0;
  let started = false;
  const end = (CONFIG.boss.kill.dilateTime ?? 0.12) + (CONFIG.boss.kill.beatTime ?? 1.5) + 1;
  let stillFrontAtShutterish = false;
  while (t < end && bossCorpseCount() > 0) {
    const scale = started ? updateBossKill(DT) : 1;
    if (!started) started = startBossKill();
    updateBossCorpses(DT, DT * scale);
    scene.updateMatrixWorld(true);
    t += DT;
    if (bossCorpseCount() > 0 && every(b.root, FRONT)) stillFrontAtShutterish = true;
  }
  check('the body burst inside the beat', bossCorpseCount() === 0, `t=${t.toFixed(2)}`);
  check('it stayed in front for the whole hold', stillFrontAtShutterish);
  check('after the burst nothing is in front', frontLayerCount() === 0);
  check('...and the visual is back on the world layer for the pool',
    every(b.visual, WORLD) && none(b.visual, FRONT));

  // The other route: a run ending under a held body.
  const c = body();
  scene.add(c.root);
  const e2 = { ...e, mesh: c.root, visual: c.visual };
  holdBossCorpse(e2, scene);
  check('held again, in front again', every(c.root, FRONT));
  resetBossCorpses();
  check('a run ending under it sends it back too',
    frontLayerCount() === 0 && every(c.visual, WORLD));
  resetBossKill();
}

// --- THE ORDER, IN THE SOURCE -----------------------------------------------
// Which of two lines comes first is not something a stand-in can measure: a
// foreign visual is disposed, not pooled, so the ghost never appears here.
section('the order');
{
  const corpse = src('path/src/systems/bossCorpse.js');
  const burst = corpse.slice(corpse.indexOf('function burst('));
  const reset = corpse.slice(corpse.indexOf('export function resetBossCorpses('));
  const before = (s, a, b) => s.indexOf(a) > -1 && s.indexOf(b) > -1 && s.indexOf(a) < s.indexOf(b);
  check('burst(): sendBack before releaseVisual', before(burst, 'sendBack(', 'releaseVisual('));
  check('resetBossCorpses(): sendBack before releaseVisual', before(reset, 'sendBack(', 'releaseVisual('));

  const post = src('path/src/systems/post.js');
  const overlay = post.slice(post.indexOf('function renderOverlay('), post.indexOf('function renderOverlay(') + 600);
  check('post.js draws the front layer at the overlay point, after the goo',
    /renderFrontLayer\(renderer,\s*sceneToRender,\s*sceneCamera\)/.test(overlay));
  check('...on both routes through render()',
    (post.match(/^\s+renderOverlay\(renderer,\s*sceneToRender,\s*sceneCamera\);/gm) ?? []).length === 2);
  const gooThenOverlay = post.indexOf('for (const group of goo) renderGooGroup(sceneCamera, group);');
  const overlayCall = post.indexOf('renderOverlay(renderer, sceneToRender, sceneCamera)', gooThenOverlay);
  const bloom = post.indexOf('THE BLOOM BUFFER IS BUILT', gooThenOverlay);
  check('...between the goo and the bloom',
    gooThenOverlay > -1 && overlayCall > gooThenOverlay && bloom > overlayCall);

  const world = src('path/src/world.js');
  for (const light of ['ambient', 'key', 'hemi']) {
    check(`world.js: the ${light} light is on every layer`,
      world.includes(`${light}.layers.enableAll()`));
  }
}

resetFrontLayer();
console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
