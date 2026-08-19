// ---------------------------------------------------------------------------
// npm run looks:bosswarm
//
// THE ONE CLAIM A NODE HARNESS CANNOT CHECK: that warming a boss actually puts
// its textures on the GPU before the arrival, rather than appearing to.
//
// tools/boss-warmup-test.mjs proves the QUEUE is right — which bodies, which
// textures, one step per tick — against a stub, because there is no GL context
// in Node. Everything it asserts would still pass if `renderer.initTexture`
// were the wrong call, if the textures hanging off a cloned body were not the
// ones three uploads on a first draw, or if the upload happened and then got
// thrown away. All three fail silently: the game renders correctly either way
// and the only difference is which frame pays.
//
// So this page counts the uploads three itself reports —
// `renderer.info.memory.textures` — across a warm and then a first draw. The
// numbers to look for:
//
//   WARMING a boss body raises the texture count by its own texture count.
//   DRAWING it afterwards raises it by ZERO, because there is nothing left to
//     upload. That second number is the whole claim: a control body that was
//     never warmed uploads on its first draw instead, and the difference
//     between the two runs is the hitch this moves.
//
// A BUILD, NOT A DEV SERVER — see the config beside this file and SERVERS.md.
// Nothing here writes tuning: it reads the shipped assets and draws offscreen.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { ASSETS, preloadAssets, createVisual } from '../../path/src/assets.js';

const out = document.getElementById('out');
const lines = [];
const say = (s = '') => { lines.push(s); out.textContent = lines.join('\n'); };

// ONE RENDERER FOR THE PAGE. A context per subject is the obvious way to write
// this and browsers keep only about sixteen live, so the early ones would be
// discarded — silently, after appearing to work.
const canvas = document.createElement('canvas');
canvas.width = 480; canvas.height = 320;
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
// The counters are the instrument. autoReset would zero them inside the render
// call and every measurement below would read zero.
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1));
const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 500);
camera.position.set(0, 0, 60);

const texCount = () => renderer.info.memory.textures;

// Every texture on a body, deduplicated by SOURCE — the same rule
// systems/bossWarmup.js uses, and for the same reason: two Texture objects over
// one Source are one upload.
const SLOTS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap'];
function texturesOf(root, { uniforms = true } = {}) {
  const seen = new Map();
  const take = (t) => { if (t?.isTexture && t.source && !seen.has(t.source.uuid)) seen.set(t.source.uuid, t); };
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      for (const s of SLOTS) take(m[s]);
      // THE HALF THE SLOT LIST CANNOT SEE. Half this roster's materials have a
      // shader injected into them (biolum, the dissolve, the outline shells),
      // and a texture reaching an injected shader arrives through `uniforms`
      // rather than through a named material slot. Nothing about it looks
      // different on the GPU — it is the same upload on the same frame.
      if (uniforms && m.uniforms) for (const k in m.uniforms) take(m.uniforms[k]?.value);
    }
  });
  return [...seen.values()];
}

// What a first draw uploaded, named rather than counted — the residual above
// is only actionable if you can see what is in it.
function describe(list) {
  return list.map((t) => {
    const img = t.source?.data;
    return `${t.name || t.constructor.name}${img?.width ? ` ${img.width}x${img.height}` : ''}`;
  }).join(', ');
}

// A first draw, measured. The body goes in, one frame is rendered, it comes
// out — and what is counted is what that frame had to upload.
function drawOnce(visual) {
  visual.position.set(0, 0, 0);
  scene.add(visual);
  const before = texCount();
  const t0 = performance.now();
  renderer.render(scene, camera);
  // The GPU is asynchronous; without a readback the timing is the time spent
  // QUEUEING the work, not doing it. One pixel is enough to force the flush.
  const px = new Uint8Array(4);
  renderer.readRenderTargetPixels?.(null, 0, 0, 1, 1, px);
  renderer.getContext().finish();
  const ms = performance.now() - t0;
  const uploaded = texCount() - before;
  scene.remove(visual);
  return { ms, uploaded };
}

say('loading the roster…');
await preloadAssets(() => {});
say('');

// The archetypes worth the measurement: the heaviest body in the roster, the
// one every run can meet from level 0, and one with no embedded textures at
// all as the negative control — if warming "helped" that one too, the
// measurement is counting something other than uploads.
const SUBJECTS = ['enemyBossAnglerfish', 'enemyMegalodon', 'enemyGiantSquid', 'enemyOrcaBull'];

say('  body                     textures bone   warm    first draw   CONTROL first draw');
say('                                      tex.   upl.   upl.    ms   upl.    ms');

for (const key of SUBJECTS) {
  if (!ASSETS[key]) { say(`  ${key.padEnd(24)} (not in ASSETS)`); continue; }

  // --- THE CONTROL, and it has to go first --------------------------------
  // Textures are shared per ASSET, so the moment either body is warmed or
  // drawn the upload is paid for both. The un-warmed run therefore has to be
  // the one that happens while the asset is still cold.
  const control = createVisual(key);
  const cold = drawOnce(control);

  // --- THE WARMED RUN ------------------------------------------------------
  // Same asset, so its textures are already resident from the control's first
  // draw above — which would make this measure nothing. Disposing the SOURCE
  // uploads is what puts the asset back to cold, and it is exactly what a
  // fresh page would have.
  const slotsOnly = texturesOf(control, { uniforms: false });
  const texes = texturesOf(control);
  for (const t of texes) t.dispose();
  renderer.renderLists.dispose();

  const body = createVisual(key);
  // THE BONE TEXTURE, and it is per CLONE rather than per asset — see
  // skeletonClone in assets.js. three allocates it lazily, inside the first
  // render of a SkinnedMesh (`if (skeleton.boneTexture === null)
  // skeleton.computeBoneTexture()`), so it is an upload that belongs to the
  // arrival frame no matter how thoroughly the asset's own maps were warmed.
  // A body with ten skinned meshes brings ten of them.
  let bones = 0;
  body.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton && !o.skeleton.boneTexture) {
      o.skeleton.computeBoneTexture();
      bones++;
    }
  });

  const beforeWarm = texCount();
  const tw0 = performance.now();
  for (const t of texturesOf(body)) renderer.initTexture(t);
  body.traverse((o) => { if (o.skeleton?.boneTexture) renderer.initTexture(o.skeleton.boneTexture); });
  renderer.getContext().finish();
  const warmMs = performance.now() - tw0;
  const warmUploads = texCount() - beforeWarm;

  const hot = drawOnce(body);

  if (texes.length !== slotsOnly.length) {
    say(`      (${texes.length - slotsOnly.length} of those reach the GPU through a shader uniform, not a material slot)`);
  }
  say(
    `  ${key.padEnd(24)} ${String(texes.length).padStart(6)}${String(bones).padStart(4)}   ` +
    `${String(warmUploads).padStart(4)}   ` +
    `${String(hot.uploaded).padStart(4)} ${hot.ms.toFixed(1).padStart(5)}   ` +
    `${String(cold.uploaded).padStart(4)} ${cold.ms.toFixed(1).padStart(5)}`,
  );
}

say('');
say('READ IT LIKE THIS:');
say('  "warm upl." should equal the body\'s texture count — the warm-up did the work.');
say('  "first draw upl." should be 0 — the arrival frame has nothing left to upload.');
say('  "CONTROL first draw" is what that frame costs today, un-warmed.');
say('');
say(`three's live texture count: ${texCount()}`);
say('DONE');
