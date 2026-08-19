// ---------------------------------------------------------------------------
// THE ANGLERFISH — every take, and what the four maps are each doing
//
//   npm run looks:angler
//
// tools/build-anglerfish.mjs proves the merge is faithful: it re-poses each
// clip out of the finished glb against the same clip driving its own original
// .FBX and compares skinned vertex positions, worst error 0.0747u on a 62-unit
// animal. That says the seven takes SURVIVED. It cannot say what they look
// like, and four things about this asset can only be judged by eye:
//
//   THE TAKES       seven clips is more than anything else in the roster, and
//                   the mapping in ASSETS.enemyAnglerfish was decided on
//                   MEASUREMENTS — travel per second and jaw gape. Whether
//                   swim2 reads as a gear change rather than a panic, and
//                   whether `bite` reads as a snap, is a picture.
//   THE SCALE       fit 3.4 x the assets.csv 2.5 is 8.5 units on screen. That
//                   is a calculation until you see it beside the frame.
//   THE MAPS        the roughness came from an INVERTED gloss and the normal
//                   was derived by Sobel out of a bump map. Both are defensible
//                   conversions and neither is the artist's own authoring, so
//                   they get a panel each, isolated.
//   THE ESCA        the lure is the whole point of the animal. The build asserts
//                   the bright emissive texels land in the top 15% of the body,
//                   which catches a mirrored atlas but says nothing about
//                   whether the bulb actually reads as lit.
//
// THE FILMSTRIPS DRIVE THE MIXER DIRECTLY, not createAnimationController, and
// that is deliberate: the controller can only reach the four states the asset
// maps, and three of the seven clips are mapped to nothing on purpose. A page
// called "every take" that quietly showed four of them would be worse than no
// page. The controller IS exercised, once, in the checks at the top — so a
// mapping that stops resolving still fails here.
//
// The animal itself is createVisual('enemyAnglerfish'), so the fit, the
// assets.csv multiplier and the material processing are all the shipping ones.
//
// IT WRITES NOTHING — a vite build with no dev server behind it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { preloadAssets, createVisual, ASSETS } from '../../path/src/assets.js';
import { createAnimationController, stateForSpeed } from '../../path/src/systems/animation.js';
import { CONFIG } from '../../path/src/config.js';
import {
  attachAngler, releaseAngler, updateBossAngler, anglerStage,
} from '../../path/src/systems/bossAngler.js';

const logEl = document.getElementById('log');
const sheetEl = document.getElementById('sheet');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};
let fails = 0;
const check = (name, ok, detail = '') => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`, ok ? 'ok' : 'bad');
  if (!ok) fails++;
};

const W = 420;
const H = 340;
const KEY = 'enemyAnglerfish';

// One WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;
gl.toneMapping = THREE.ACESFilmicToneMapping;
gl.toneMappingExposure = 1.5;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050a12);
const ambient = new THREE.HemisphereLight(0x7fb0e0, 0x0a1420, 1.0);
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(-4, 6, 8);
const rim = new THREE.DirectionalLight(0x66ccff, 1.6);
rim.position.set(7, 1, -6);
scene.add(ambient, key, rim);

await preloadAssets();

// --- the animal, built the way a wave builds one ----------------------------
const visual = createVisual(KEY);
// createVisual points every creature's `forward` at world +Y, so a preview has
// to lay it flat or it measures and photographs the animal nose-up — which on
// a body this deep would read as a completely different silhouette.
const container = new THREE.Group();
container.rotation.z = -Math.PI / 2;
container.add(visual);
scene.add(container);

const clips = visual.userData.clips ?? [];
const anim = createAnimationController(visual);

check('the model loaded rather than falling back to the primitive',
  visual.name === KEY && clips.length > 0,
  clips.length ? `${clips.length} clips` : 'FELL BACK — every panel below is an icosahedron');
check('all seven takes came through the merge',
  clips.length === 7, clips.map((c) => c.name).join(', '));
check('the animation controller resolved the mapped states',
  anim != null && Object.keys(ASSETS[KEY].animations).every((s) => clips.some((c) => c.name === ASSETS[KEY].animations[s])),
  Object.entries(ASSETS[KEY].animations).map(([s, c]) => `${s}=${c}`).join('  '));

// HOW BIG IT ACTUALLY IS, measured off the built instance rather than
// recomputed from the table. `fit` scales a grandchild and the assets.csv
// multiplier scales the root, so neither number alone says how much water this
// animal covers.
container.updateMatrixWorld(true);
const restBox = new THREE.Box3().setFromObject(container);
const length = Math.max(...restBox.getSize(new THREE.Vector3()).toArray());
check('fit x the assets.csv size lands where the row says',
  Math.abs(length - 8.5) < 0.6, `${length.toFixed(2)} units on screen (row predicts 8.5)`);

const camera = new THREE.PerspectiveCamera(32, W / H, 0.05, 400);

const mixer = new THREE.AnimationMixer(visual);
const poseAt = (clip, phase) => {
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.reset(); action.play();
  mixer.setTime(clip.duration * phase);
  container.updateMatrixWorld(true);
};

// THE FRAMING IS THE UNION OF EVERY POSE THIS PAGE WILL DRAW, computed before
// anything is rendered. Two reasons, and the first is the one that bit:
//
//   The rest box is not where the animal IS. Each take moves the body several
//   units off its bind pose, so a camera aimed at the rest centre puts the
//   subject off-frame by a third of its own length — which reads as a bad
//   render rather than a bad camera.
//
//   A per-cell refit would be worse. Every strip on this page exists to be read
//   ACROSS, and a camera that re-frames per frame silently normalises away the
//   thing being compared: swim2's whole point is that it throws the body
//   further than swim1, and a self-fitting camera would draw them identically.
//
// So: one box over all 7 clips x 6 phases, one camera, every cell.
// The cloud is SKINNED VERTICES, not box corners. Box3.expandByObject reads a
// mesh's bind-pose bounding box, which is wrong twice over here: it ignores
// what the bones are doing, and an axis-aligned box around a fish has corners
// that stick a long way past the fish. Framing on those corners at an oblique
// angle left the animal covering 42% of the frame width with the camera
// believing it was a tight fit.
const PHASES = [0, 0.2, 0.4, 0.6, 0.8, 0.95];
const cloud = [];
{
  const picks = [];
  visual.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const n = o.geometry.attributes.position.count;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 90))) picks.push([o, i]);
  });
  const v = new THREE.Vector3();
  for (const clip of clips) for (const p of PHASES) {
    poseAt(clip, p);
    for (const [m, i] of picks) { m.skeleton.update(); m.getVertexPosition(i, v); m.localToWorld(v); cloud.push(v.clone()); }
  }
}
const union = new THREE.Box3().setFromPoints(cloud);
const span = union.getSize(new THREE.Vector3());
const centre = union.getCenter(new THREE.Vector3());
const reach = Math.max(span.x, span.y, span.z);
log(`framing: rest ${length.toFixed(2)}u; every take together ${span.toArray().map((n) => n.toFixed(2)).join(' x ')}u over ${cloud.length} sampled points`);

// FRAMED AGAINST THE PROJECTED BOX, not against its longest side. Dividing the
// longest dimension by the vertical fov is the usual shortcut and it wastes
// most of the frame here: the animal is 8.50 long and 5.10 tall, so fitting
// 8.50 vertically leaves it at 60% of the frame height before the wider
// horizontal fov gives away more still. This solves for the distance at which
// the box's eight corners just fit BOTH fovs, which is the same camera for
// every cell and simply a closer one.
const frame = (target, points, azimuth, elevation, pad = 1.04) => {
  const tanV = Math.tan((camera.fov * Math.PI / 180) / 2);
  const tanH = tanV * camera.aspect;
  const dir = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation),
  ).normalize();
  let d = 20;   // any start; the solve walks it in from either side
  // Iterated because the view basis depends on the distance and vice versa.
  // Converges in two or three; five is free.
  for (let pass = 0; pass < 5; pass++) {
    camera.position.copy(dir).multiplyScalar(d).add(target);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    const inv = camera.matrixWorldInverse.clone();
    // -Infinity, NOT 0. Seeded at 0 this only ever moves the camera BACK: when
    // every point is already inside the frustum each term is negative, the max
    // stays 0, and the distance sticks at whatever it started on. That is a
    // camera that silently never tightens — it renders a correct, centred,
    // far-too-small subject and looks like a framing preference.
    let need = -Infinity;
    const v = new THREE.Vector3();
    for (const c of points) {
      v.copy(c).applyMatrix4(inv);   // camera space, looking down -Z
      need = Math.max(need, Math.max(Math.abs(v.x) / tanH, Math.abs(v.y) / tanV) + v.z);
    }
    d += need * pad;
  }
  camera.position.copy(dir).multiplyScalar(d).add(target);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  // What the solve actually achieved, so a framing that quietly stops working
  // shows up in the log rather than in the pictures.
  const inv = camera.matrixWorldInverse.clone(); const p = new THREE.Vector3();
  let mx = 0, my = 0;
  for (const c of points) { p.copy(c).applyMatrix4(inv);
    mx = Math.max(mx, Math.abs(p.x) / (-p.z) / tanH); my = Math.max(my, Math.abs(p.y) / (-p.z) / tanV); }
  return { d, fillX: mx, fillY: my };
};
const place = (azimuth, elevation, pad) => frame(centre, cloud, azimuth, elevation, pad);

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];

function cell(title, caption, bad) {
  const wrap = document.createElement('div');
  wrap.className = `cell${bad ? ' hit' : ''}`;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
  wrap.appendChild(canvas);
  if (caption) {
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.innerHTML = caption;
    wrap.appendChild(cap);
  }
  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
  return wrap;
}

function row(heading, sub, cols = 6) {
  const h = document.createElement('h2');
  h.innerHTML = sub ? `${heading} <span>${sub}</span>` : heading;
  sheetEl.appendChild(h);
  const r = document.createElement('div');
  r.className = 'row';
  r.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  sheetEl.appendChild(r);
  return r;
}

// --- 1. every take, six phases each -----------------------------------------
// The same six phases for every clip, so a row can be read across as a strip
// and DOWN against the other takes at the same point in their cycle.
const NOTES = {
  idle: 'the quiet hold — 0.74u/s, the lowest-energy take in the file',
  swim1: 'the cruise — 3.22u/s, mapped to <b>swim</b>',
  swim2: 'the sprint — 7.79u/s, <b>2.4x the cruise</b>, mapped to <b>boost</b>',
  swim_start: 'transition into the cruise — 3.50u/s, <b>mapped to nothing</b>',
  swim_end: 'transition out of it — 2.36u/s, <b>mapped to nothing</b>',
  bite: 'the snap — the only take that CLOSES the jaw (gape 11.9 down to 7.8)',
  trap: 'the ambush — near-still at 1.84u/s with the jaw opening PAST rest, to 13.2. <b>Mapped to nothing</b>: this is the animal’s whole character and it has no state to live in yet.',
};
const ORDER = ['idle', 'swim1', 'swim2', 'bite', 'trap', 'swim_start', 'swim_end'];

{
  const f = place(1.15, 0.12);
  log(`camera: ${f.d.toFixed(2)}u out, the takes fill ${(f.fillX * 100).toFixed(0)}% x ${(f.fillY * 100).toFixed(0)}% of frame`);
  check('the camera actually tightened onto the subject',
    Math.max(f.fillX, f.fillY) > 0.9, `filling ${(Math.max(f.fillX, f.fillY) * 100).toFixed(0)}% of the frame's shorter fit`);
}
for (const name of ORDER) {
  const clip = clips.find((c) => c.name === name);
  if (!clip) { check(`clip "${name}" is in the file`, false); continue; }
  const mapped = Object.entries(ASSETS[KEY].animations).filter(([, c]) => c === name).map(([s]) => s);
  const r = row(name, `${clip.duration.toFixed(2)}s &middot; ${mapped.length ? `state: ${mapped.join(' + ')}` : 'unmapped'} &middot; ${NOTES[name] ?? ''}`);
  for (const p of PHASES) {
    poseAt(clip, p);
    gl.render(scene, camera);
    r.appendChild(cell(`take-${name}-${Math.round(p * 100)}`, `${Math.round(p * 100)}%`));
  }
}

// --- 2. the maps, isolated --------------------------------------------------
// Each panel keeps ONE map and neutralises the others, so what a channel
// contributes is visible on its own rather than inferred from a beauty shot.
const mats = [];
visual.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (!mats.includes(m)) mats.push(m); });
check('every material carries all four maps', mats.length > 0 && mats.every((m) => m.map && m.normalMap && m.emissiveMap && (m.roughnessMap || m.metalnessMap)),
  `${mats.length} materials`);

const saved = mats.map((m) => ({
  m, map: m.map, normalMap: m.normalMap, emissiveMap: m.emissiveMap,
  roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap,
  emissive: m.emissive.clone(), color: m.color.clone(), roughness: m.roughness,
}));
const restore = () => saved.forEach((s) => {
  Object.assign(s.m, { map: s.map, normalMap: s.normalMap, emissiveMap: s.emissiveMap, roughnessMap: s.roughnessMap, metalnessMap: s.metalnessMap, roughness: s.roughness });
  s.m.emissive.copy(s.emissive); s.m.color.copy(s.color); s.m.needsUpdate = true;
});
const only = (fn) => { restore(); mats.forEach((m) => { fn(m); m.needsUpdate = true; }); };

poseAt(clips.find((c) => c.name === 'trap'), 0.55);
const r2 = row('the four maps', 'each isolated on the same frame of <b>trap</b>', 5);

only(() => {});
place(1.15, 0.12); gl.render(scene, camera);
r2.appendChild(cell('maps-beauty', '<b>everything</b> — how it ships'));

only((m) => { m.normalMap = null; m.emissiveMap = null; m.emissive.setHex(0x000000); m.roughnessMap = null; m.metalnessMap = null; });
gl.render(scene, camera);
r2.appendChild(cell('maps-basecolor', '<b>base colour only</b> — the painted atlas, 2048&sup2;'));

only((m) => { m.map = null; m.color.setHex(0x9aa8b4); m.emissiveMap = null; m.emissive.setHex(0x000000); });
gl.render(scene, camera);
r2.appendChild(cell('maps-normal', '<b>normal only</b> — derived by Sobel from the bump map, on flat grey'));

only((m) => { m.map = null; m.color.setHex(0xb8c4cc); m.normalMap = null; m.emissiveMap = null; m.emissive.setHex(0x000000); });
gl.render(scene, camera);
r2.appendChild(cell('maps-rough', '<b>roughness only</b> — the gloss map INVERTED into G'));

only((m) => { m.map = null; m.color.setHex(0x000000); m.normalMap = null; });
ambient.visible = key.visible = rim.visible = false;
gl.render(scene, camera);
ambient.visible = key.visible = rim.visible = true;
r2.appendChild(cell('maps-emissive', '<b>emissive only, no lights</b> — the esca and the photophore rows'));

restore();

// --- 3. the esca, close ------------------------------------------------------
const r3 = row('the lure', 'the esca on the tip of the illicium — the reason the emissive map exists', 4);
poseAt(clips.find((c) => c.name === 'trap'), 0.55);

// THE ESCA IS FOUND, NOT GUESSED. A fraction of the bounding box is the obvious
// way to aim at "the top of the animal" and it lands on the head spines: the
// illicium arcs FORWARD as well as up, so the bulb is nowhere near the box's
// top-centre. This reads the emissive atlas the material is actually using and
// takes the centroid of the vertices that sample its brightest texels — the
// same definition tools/build-anglerfish.mjs asserts against, so the two agree
// by construction rather than by both being tuned to the same picture.
const esca = (() => {
  const tex = mats[0].emissiveMap;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tex.image, 0, 0, 512, 512);
  const px = ctx.getImageData(0, 0, 512, 512).data;
  const hits = [];
  const v = new THREE.Vector3();
  visual.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const uv = o.geometry.attributes.uv;
    o.skeleton.update();
    for (let i = 0; i < uv.count; i++) {
      const x = Math.min(511, Math.max(0, Math.round(uv.getX(i) * 511)));
      const y = Math.min(511, Math.max(0, Math.round(uv.getY(i) * 511)));
      const k = (y * 512 + x) * 4;
      if (Math.max(px[k], px[k + 1], px[k + 2]) > 200) {
        o.getVertexPosition(i, v); o.localToWorld(v); hits.push(v.clone());
      }
    }
  });
  check('the esca was located from the emissive map', hits.length > 20, `${hits.length} vertices sample emissive > 200`);
  if (!hits.length) return new THREE.Vector3(centre.x, union.max.y, centre.z);
  // The brightest cluster spans the lure AND the photophore rows down the body,
  // so take the highest quarter of the hits — the bulb is the top of the animal
  // by a wide margin.
  hits.sort((a, b) => b.y - a.y);
  const top = hits.slice(0, Math.max(8, Math.floor(hits.length / 4)));
  const m = top.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / top.length);
  log(`the esca sits at ${m.toArray().map((n) => n.toFixed(2)).join(', ')} — ${(m.y - centre.y).toFixed(2)}u above the body's centre`);
  return m;
})();
const top = esca;
// A close-up is the same solve against a box drawn AROUND the feature, so the
// crop is stated in world units rather than tuned by eye against one pose.
// A close-up frames the cloud points that fall inside a sphere around the
// feature — the same solve, restricted to what is being looked at, so the crop
// is stated in world units rather than tuned by eye against one pose.
const closeUp = (az, el, radius, target) => {
  const near = cloud.filter((p) => p.distanceTo(target) < radius);
  frame(target, near.length > 20 ? near : cloud, az, el, 1.0);
};
closeUp(1.15, 0.05, reach * 0.22, top); gl.render(scene, camera);
r3.appendChild(cell('esca-lit', 'lit'));
ambient.visible = key.visible = rim.visible = false;
gl.render(scene, camera);
ambient.visible = key.visible = rim.visible = true;
r3.appendChild(cell('esca-dark', 'the same frame with <b>every light off</b>'));

const head = new THREE.Vector3(centre.x, centre.y, union.max.z - span.z * 0.24);
closeUp(1.45, 0.02, reach * 0.24, head); gl.render(scene, camera);
r3.appendChild(cell('head-lit', 'the head — teeth, eye and the photophore rows'));
poseAt(clips.find((c) => c.name === 'bite'), 0.5);
gl.render(scene, camera);
r3.appendChild(cell('head-bite', 'the same view mid-<b>bite</b>, jaw shut'));

// --- 4. the atlases themselves ----------------------------------------------
// Straight from the GPU textures the material is actually using, so this is the
// sheet as shipped — WebP, re-encoded, V-flipped — not the source PNG on disk.
const r4 = row('the atlas', 'the four 2048&sup2; maps as the material holds them', 4);
const SHEET = 460;
for (const [label, tex, note] of [
  ['baseColor', mats[0].map, 'painted colour, alpha flattened'],
  ['normal', mats[0].normalMap, 'derived — Sobel over the bump map'],
  ['metalRough', mats[0].roughnessMap ?? mats[0].metalnessMap, 'R unused &middot; <b>G roughness</b> &middot; B metal (black)'],
  ['emissive', mats[0].emissiveMap, 'near-black except the esca and the dots'],
]) {
  const wrap = document.createElement('div');
  wrap.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = SHEET; canvas.height = SHEET;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, SHEET, SHEET);
  if (tex?.image) ctx.drawImage(tex.image, 0, 0, SHEET, SHEET);
  wrap.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${label}</b> — ${note}`;
  wrap.appendChild(cap);
  r4.appendChild(wrap);
  const name = `${String(shotIndex++).padStart(2, '0')}-atlas-${label.toLowerCase()}.png`;
  posted.push(new Promise((done) => canvas.toBlob((b) => fetch(`/shot/${name}`, { method: 'POST', body: b }).then(done, done), 'image/png')));
}



// ---------------------------------------------------------------------------
// 5. THE AMBUSH — the real fight, on the real boss body
//
// Everything below is systems/bossAngler.js stepping at 60fps. Nothing here
// poses the animal or sets a glow: the state machine picks the locomotion
// state, the animation controller resolves it to a clip, and the emissive cue
// layer writes the material — exactly the chain that runs in the arena. The
// only thing this page adds is a camera.
//
// tools/boss-angler-test.mjs already proves the timings and the envelope
// numerically. What it cannot show is the thing the feature is FOR: whether
// the tell reads. That is what these frames are.
// ---------------------------------------------------------------------------
const BOSS = 'enemyBossAnglerfish';
{
  // NO -PI/2 WRAPPER HERE, unlike the take rows above, and that is the whole
  // difference between this section and them.
  //
  // Those rows lay a nose-up model flat for a side-on portrait. This one is
  // driving the real fight, and the fight WRITES `mesh.rotation.z` as the
  // animal's heading — the same field entities/enemies.js writes for
  // `faceMotion`. Put a rotation wrapper around that and the two compose: the
  // preview tumbled the fish through its own aim and the ambush frames came
  // out cropped at wild angles, which looks like the ambush is broken rather
  // than like the preview is.
  //
  // So the boss goes into the scene the way the arena puts it there — flat in
  // XY with rotation.z as its heading — and the camera looks down at that plane
  // instead. That is also the honest picture: it is what the player sees.
  const bossVisual = createVisual(BOSS);
  scene.add(bossVisual);
  container.visible = false;

  // LIT LIKE THE ARENA, NOT LIKE THE ROWS ABOVE. The take sheets want a neutral
  // studio key so the animation is legible; this section is asking a different
  // question — does the TELL read — and answering it under a 2.4 key light
  // would be answering it about a fish that is already brightly lit. The fight
  // happens in deep water, where the emissive is most of what reaches the
  // player. Dimmed here and restored afterwards, so the two sets of frames are
  // each lit for the thing they are evidence of.
  const litKey = key.intensity;
  const litRim = rim.intensity;
  const litAmb = ambient.intensity;
  key.intensity = 0.45;
  rim.intensity = 0.3;
  ambient.intensity = 0.12;

  const def = CONFIG.enemies.bossAnglerfish;
  const e = {
    def, mesh: bossVisual, x: 0, y: 0, vx: 0, vy: 0, dead: false,
    contactDamage: def.contactDamage, animState: null, perkDrive: false,
    anim: createAnimationController(bossVisual),
  };
  check('the boss body loaded with its own clip mapping',
    (bossVisual.userData.clips ?? []).length === 7 && ASSETS[BOSS].animations.idle === 'trap',
    `idle -> ${ASSETS[BOSS].animations.idle}`);

  // The player sits inside triggerRange, so the fight cycles without anyone
  // having to drive it.
  const playerPos = { x: CONFIG.boss.angler.triggerRange * 0.55, y: 0 };
  attachAngler(scene, e);

  // Frame the boss on its own cloud, gathered the same way as above.
  const bossCloud = [];
  {
    const picks = [];
    bossVisual.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const n = o.geometry.attributes.position.count;
      for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 90))) picks.push([o, i]);
    });
    const v = new THREE.Vector3();
    for (const clip of bossVisual.userData.clips ?? []) {
      for (const ph of [0, 0.35, 0.7]) {
        const mx = new THREE.AnimationMixer(bossVisual);
        mx.clipAction(clip).play(); mx.setTime(clip.duration * ph);
        bossVisual.updateMatrixWorld(true);
        for (const [m, i] of picks) { m.skeleton.update(); m.getVertexPosition(i, v); m.localToWorld(v); bossCloud.push(v.clone()); }
      }
    }
  }
  const bossCentre = new THREE.Box3().setFromPoints(bossCloud).getCenter(new THREE.Vector3());

  // WANTED FRAMES, named by what the player would be reading at that moment
  // rather than by a timestamp — so a retune moves the picture with the fight
  // instead of leaving the sheet pointing at the wrong instants.
  const wanted = [
    { stage: 'lurk', at: 0.55, cap: 'the <b>lurk</b> — jaw wide, lure throbbing low. It will sit here forever if you stay out of range.' },
    { stage: 'windup', at: 0.15, cap: '<b>wind-up</b>, early — the tell has started and the light is on its way up' },
    { stage: 'windup', at: 0.97, cap: '<b>wind-up</b>, the last frame — peak brightness, and it launches on the next one' },
    { stage: 'lunge', at: 0.06, cap: 'the <b>commit</b> — the brightest frame of the whole fight' },
    { stage: 'lunge', at: 0.75, cap: 'mid-<b>lunge</b>, held bright for exactly as long as the body is dangerous' },
    { stage: 'snap', at: 0.5, cap: 'the <b>snap</b> — the jaws close whether or not they caught anything' },
    { stage: 'recover', at: 0.55, cap: 'the <b>recovery</b>: the light is out. A dark anglerfish is a safe one.' },
    { stage: 'lurk', at: 0.9, cap: 'back to the <b>lurk</b>, lit again and waiting' },
  ];
  const shots = [];
  let prevStage = null;
  let inStage = 0;
  let idx = 0;
  const DTF = 1 / 60;
  for (let i = 0; i < 60 * 30 && idx < wanted.length; i++) {
    updateBossAngler(DTF, scene, playerPos, {});
    e.x += e.vx * DTF; e.y += e.vy * DTF;
    const st = anglerStage();
    inStage = st.stage === prevStage ? inStage + DTF : 0;
    prevStage = st.stage;
    // The clip, driven exactly as entities/enemies.js drives it — the override
    // if the fight set one, the speed-derived state otherwise.
    e.anim?.update(DTF, e.animState ?? stateForSpeed(Math.hypot(e.vx, e.vy)), false);
    // Held at the origin so the camera can stay put — the fight's real
    // translation is measured in the harness, not looked at here. The HEADING
    // is left exactly as the fight wrote it, because that is the subject.
    bossVisual.position.set(0, 0, 0);
    bossVisual.updateMatrixWorld(true);

    const w = wanted[idx];
    const total = st.stage === 'lurk' ? (CONFIG.boss.angler.settle ?? 0.6)
      : st.stage === 'windup' ? CONFIG.boss.angler.windup
      : st.stage === 'lunge' ? CONFIG.boss.angler.lungeTime
      : st.stage === 'snap' ? CONFIG.boss.angler.snapTime
      : CONFIG.boss.angler.recoverTime;
    if (st.stage === w.stage && inStage >= total * w.at) {
      shots.push({ ...w, glow: st.emissive, t: i * DTF });
      idx++;
      // THE PLAYER'S CAMERA. world.js puts it at (0, 0, 40) looking at the XY
      // plane, so azimuth 0 / elevation 0 — straight down -Z — is not "a nice
      // angle for the sheet", it is the arrangement the game renders from.
      // Which is the only thing that makes these frames evidence about whether
      // the tell READS: a telegraph judged from an angle nobody plays at is
      // not judged at all.
      frame(bossCentre, bossCloud, 0, 0, 1.25);
      gl.render(scene, camera);
      shots[shots.length - 1].canvas = true;
      const r = shots.length === 1 ? row('the ambush', 'the real state machine at 60fps, lit like the arena rather than like a studio — nothing here is posed by hand', 4) : null;
      if (r) window.__ambushRow = r;
      window.__ambushRow.appendChild(cell(`ambush-${idx}-${w.stage}`,
        `${w.cap}<br><b>glow x${st.emissive.toFixed(2)}</b> &middot; state <b>${e.animState ?? 'auto'}</b> -> ${ASSETS[BOSS].animations[e.animState] ?? '(speed-derived)'}`));
    }
  }
  check('every stage of the ambush was reached and photographed',
    shots.length === wanted.length, `${shots.length} of ${wanted.length}`);
  const lurkGlow = shots.find((x) => x.stage === 'lurk')?.glow ?? 0;
  const peakGlow = Math.max(...shots.map((x) => x.glow));
  const darkGlow = shots.find((x) => x.stage === 'recover')?.glow ?? 99;
  check('the tell brightens well past the lurk', peakGlow > lurkGlow * 3,
    `x${peakGlow.toFixed(2)} against a lurk of x${lurkGlow.toFixed(2)}`);
  check('and the recovery is the darkest the animal gets', darkGlow < lurkGlow,
    `x${darkGlow.toFixed(2)}`);
  releaseAngler();
  key.intensity = litKey;
  rim.intensity = litRim;
  ambient.intensity = litAmb;
  container.visible = true;
}

await Promise.all(posted);
log(`\n${shotIndex} frames posted (final)`, fails ? 'bad' : 'ok');
log(fails ? `${fails} CHECK(S) FAILED` : 'all checks passed', fails ? 'bad' : 'ok');
