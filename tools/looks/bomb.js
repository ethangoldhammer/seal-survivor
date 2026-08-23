// ---------------------------------------------------------------------------
// THE VOICEMAIL BOMB — LOOK DEV
//
//   npm run looks:bomb
//
// Two things are being judged here and only the first one is about taste.
//
//   THE MODEL. A 4MB cartoon bomb cut to 0.11MB by tools/optimize-bomb.mjs,
//   wearing the game's toon banding and its outline, at the size it is
//   actually dropped at. The question is whether a ball that is roughly one
//   world unit across still reads as a bomb after the fuse lost 86% of its
//   triangles.
//
//   THE WICK. The flame's path is MEASURED out of the mesh by the optimizer
//   and baked into the file, then transformed into the model's own space by
//   assets.js. Two transforms and a Z-up source stand between the number in
//   the glb and the flame on screen, and every way of getting it wrong puts
//   the flame somewhere plausible — inside the ball, off to one side, or
//   travelling the wrong way along the fuse. So the panels draw the whole path
//   and the checks measure it.
//
// WHY A PAGE AND NOT A NODE HARNESS. No glb loads in Node — a webp-textured
// one will not even parse there — so the model, its wick path and its toon
// banding are all invisible to the terminal. This page imports the SHIPPING
// modules and the SHIPPING post chain, so what it renders is what the game
// renders, bloom included.
//
// (It used to judge a third thing: a hard-edged cel starburst for the blast.
// That is gone — the bomb leaves the same `boom` goo every other explosion in
// the game leaves, which is a shared surface tuned on its own panel and not
// this one.)
//
// IT WRITES NOTHING. CONFIG is read off a throwaway bundle and there is no dev
// server behind this. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import { createVisual, preloadAssets, applySavedAssetLooks } from '../../path/src/assets.js';

const logEl = document.getElementById('log');
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

// A shader that fails to compile renders NOTHING and three only writes to the
// console about it, so the page would look like a bad tuning decision rather
// than a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 300;
const H = 300;
const DT = 1 / 60;

const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Water behind it. The bomb is a near-black object drawn with an additive
// flame and an additive flash, and a panel over pure black flatters all three.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x14344a }),
);
water.position.z = -40;
scene.add(water);

// THE GAME'S OWN RIG, read from CONFIG rather than invented — the same three
// lights world.js builds, at the same intensities and the same key position.
//
// This page first shipped with a rig I made up (a brighter key, a cyan rim,
// and NO ambient at all), and the bomb came out so dark on it that I retuned
// the toon preset to compensate. Ambient alone is 0.85 in the game. A look
// page lit differently from the game is not a look page, it is a second
// opinion nobody asked for, and every number judged on it is wrong by
// whatever the difference is.
const L = CONFIG.lighting;
scene.add(new THREE.AmbientLight(0xffffff, L.ambient));
const key = new THREE.DirectionalLight(0xffffff, L.keyIntensity);
key.position.fromArray(L.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, L.hemiIntensity));

// A magnifying glass: the bomb is about one world unit against the game's
// 44-unit view, and what is being judged is the SHAPE.
let VIEW = 3.4;
function makeCam(view) {
  const c = new THREE.OrthographicCamera(
    -view * (W / H) / 2, view * (W / H) / 2, view / 2, -view / 2, -200, 200,
  );
  c.position.set(0, 0, 40);
  return c;
}
let camera = makeCam(VIEW);

const post = createPost(gl);
function draw() {
  post.resize();
  post.render(scene, camera, DT);
}

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];
let row = null;
function section(title, columns) {
  const h = document.createElement('h2');
  h.innerHTML = title;
  document.getElementById('sheet').appendChild(h);
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  document.getElementById('sheet').appendChild(row);
}
function present(title, note) {
  draw();
  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04070e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gl.domElement, 0, 0);
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b><br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);
  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// --- measuring --------------------------------------------------------------
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });
function grab() {
  gl.render(scene, camera);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height);
}

await preloadAssets();
applySavedAssetLooks();

// ===========================================================================
section('The model <span>— decimated, toon-banded, outlined, at drop size</span>', 4);

const bomb = createVisual('voicemailBomb');
bomb.scale.multiplyScalar(CONFIG.bakalar.bomb.size / 0.72);
scene.add(bomb);

const box = new THREE.Box3().setFromObject(bomb);
const size = box.getSize(new THREE.Vector3());
log(`bomb bbox ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} world units`);
log(`root ${bomb.type} children=${bomb.children.map((c) => c.type).join(',')} `
  + `rootQ=${bomb.quaternion.toArray().map((n) => n.toFixed(2)).join(',')} `
  + `childQ=${bomb.children[0]?.quaternion.toArray().map((n) => n.toFixed(2)).join(',')} `
  + `rootScale=${bomb.scale.x.toFixed(3)}`);
bomb.traverse((o) => {
  if (!o.isMesh) return;
  const b = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
  log(`  mesh ${o.name || '(unnamed)'} ${o.userData.__isOutline ? '[outline]' : ''} `
    + `${b.x.toFixed(2)}x${b.y.toFixed(2)}x${b.z.toFixed(2)} `
    + `${o.material.type} #${o.material.color?.getHexString()} map=${!!o.material.map} uv=${!!o.geometry.attributes.uv} `
    + `rough=${o.material.roughness} emissive=#${o.material.emissive?.getHexString()} ei=${o.material.emissiveIntensity} `
    + `toon=${o.material.userData?.__toonAttached ? (o.material.userData.__toonPreset ?? 'base') : 'NO'} compiled=${!!o.material.userData?.__toonCompiled}`);
});

// THE FIT ARITHMETIC, checked rather than trusted. `fit` normalises the
// model's LONGEST axis and the longest axis of this file is the ball PLUS the
// wick — so the obvious value (the ball's wanted diameter) makes a bomb a
// third too small, which is small enough to look deliberate. The ball is the
// model's width, since the wick only adds height.
check('the ball comes out the size the primitive it replaced was',
  Math.abs(size.x - 1.44) < 0.25, `${size.x.toFixed(2)} across, want ~1.44`);

// THE WICK POINTS UP. `forward: '+Z'` is what stands a Z-up source upright,
// and the failure is silent: a bomb lying on its side is still a bomb.
const wick = bomb.userData.wickPath;
check('the model carries its measured wick path',
  Array.isArray(wick) && wick.length >= 2, `${wick?.length ?? 0} points`);
if (wick?.length >= 2) {
  const root = new THREE.Vector3().fromArray(wick[0]);
  const tip = new THREE.Vector3().fromArray(wick.at(-1));
  log(`wick root ${root.toArray().map((n) => n.toFixed(2)).join(', ')}  tip ${tip.toArray().map((n) => n.toFixed(2)).join(', ')}`);
  check('the wick points UP, not sideways or into the ball',
    tip.y > root.y, `tip y ${tip.y.toFixed(2)} vs root y ${root.y.toFixed(2)}`);
  check('...and its tip clears the ball',
    tip.y > size.y * 0.18, `tip at y ${tip.y.toFixed(2)} on a ${size.y.toFixed(2)}-tall model`);
}

// DOES IT READ, or is it a hole with an outline round it?
//
// This is the check the eye is worst at and the one this asset kept failing.
// The source paint sits at sRGB 55, which is LINEAR 0.039 — a quarter of what
// the number looks like — and lighting happens in linear, so the game's whole
// rig brings it back out at sRGB 55 again: a ball the same value as the water,
// separated from it only by the rim. It looks like a slightly moody bomb in a
// screenshot and like a silhouette in motion.
//
// Measured as two contrasts rather than one brightness, because "bright
// enough" depends on the water and neither of these does: the ball has to have
// a LIT SIDE (or it is a flat disc) and the rope has to be lighter than the
// ball (or the fuse disappears into it). tools/optimize-bomb.mjs --brighten is
// the dial.
{
  bomb.rotation.y = Math.PI * 0.3;
  const img = grab();
  const at = (fx, fy) => {
    const x = Math.round(img.width * fx);
    const y = Math.round(img.height * fy);
    const i = (y * img.width + x) * 4;
    return (img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11);
  };
  // The key is at [4, 8, 14] — up and to the right — so the lit side of the
  // ball is upper-right of its centre and the shadow side is lower-left.
  const lit = at(0.60, 0.60);
  const shade = at(0.40, 0.76);
  const water = at(0.06, 0.5);
  // The rope is a few pixels of braid on a curl, so a fixed sample point is a
  // coin toss between the fuse, its own shadow and the water behind it — the
  // first version of this check read 88 against a ball of 86 and called the
  // fuse invisible while it was plainly brown on screen. Brightest pixel in
  // the band above the ball instead, which is the fuse wherever it curls to.
  let rope = 0;
  for (let y = 0; y < img.height * 0.22; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      rope = Math.max(rope, img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11);
    }
  }
  log(`lit ${lit.toFixed(0)}  shadow ${shade.toFixed(0)}  rope ${rope.toFixed(0)}  water ${water.toFixed(0)} (sRGB 0-255)`);
  check('the ball has a lit side, not one flat value',
    lit > shade * 1.35, `${lit.toFixed(0)} lit vs ${shade.toFixed(0)} in shadow`);
  check('the rope reads against the ball it is stuck in',
    rope > lit * 1.3, `rope ${rope.toFixed(0)} vs lit ball ${lit.toFixed(0)}`);
  // ...and the whole thing has to be brighter than the water it falls
  // through, at least on its lit side. Equal is a silhouette.
  check('the bomb is not the same value as the water',
    lit > water * 1.5, `lit ${lit.toFixed(0)} vs water ${water.toFixed(0)}`);
}

// WHICH HALF OF THE ARMING BLINK THIS MODEL GETS.
//
// paintArmedBombs in systems/bakalar.js branches on whether the material has
// an emissiveIntensity: a lit model blinks its GLOW (it already points its
// emissive at its own base map), and the procedural fallback — which has no
// emissive at all — blinks its base colour instead. Node cannot load a glb, so
// tools/ability-smoke.mjs only ever exercises the fallback branch: it would
// pass with the model's branch broken or gone.
//
// Checked here because this page is the only place the real material exists.
// If the def loses emissiveFromMap, or the material stops being a Standard
// one, the bomb silently falls back to repainting its own texture on every
// blink — which reads as the bomb changing colour rather than flashing.
{
  const lit = [];
  bomb.traverse((o) => { if (o.isMesh && !o.userData.__isOutline) lit.push(o.material); });
  check('the real model takes the GLOW branch of the arming blink',
    lit.length > 0 && lit.every((m) => m.emissiveIntensity != null),
    `${lit.filter((m) => m.emissiveIntensity != null).length} of ${lit.length} materials`);
  check('...and it is wired to its own paint, not a flat colour',
    lit.every((m) => !!m.emissiveMap), `${lit.filter((m) => m.emissiveMap).length} carry an emissive map`);
  check('...and it is switched off until something asks',
    lit.every((m) => (m.emissiveIntensity ?? 1) === 0),
    lit.map((m) => m.emissiveIntensity).join(', '));
}

for (const [label, ry] of [['front', 0], ['quarter', Math.PI * 0.3], ['side', Math.PI / 2], ['back', Math.PI]]) {
  bomb.rotation.y = ry;
  present(`bomb ${label}`, `y ${(ry * 180 / Math.PI).toFixed(0)}&deg;`);
}
bomb.rotation.y = Math.PI * 0.3;

// ===========================================================================
section('The wick burning <span>— the flame walks the measured path, tip to powder</span>', 5);

// The flame the game builds, rebuilt here rather than imported: systems/bakalar.js
// makes it inside updateBombs off a live bomb, and standing a whole sailing up
// on a look page to see one blob is the wrong trade. What IS imported is the
// path and the config, which is where every failure lives.
const w = CONFIG.bakalar.bomb.wick;
const flame = new THREE.Mesh(
  new THREE.SphereGeometry(1, 10, 8),
  new THREE.MeshBasicMaterial({
    color: new THREE.Color(w.flameColor).multiplyScalar(w.flameGlow),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }),
);
flame.scale.setScalar(w.flameSize);
bomb.add(flame);

// The path, drawn. A line through the points the flame is interpolating,
// so a path that runs down the wrong axis is visible rather than inferred.
if (wick?.length >= 2) {
  const g = new THREE.BufferGeometry().setFromPoints(wick.map((p) => new THREE.Vector3().fromArray(p)));
  bomb.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x39ff88 })));
}

function flameAt(burn) {
  const t = (1 - burn) * (wick.length - 1);
  const i = Math.min(wick.length - 2, Math.floor(t));
  const f = t - i;
  const a = wick[i];
  const b = wick[i + 1];
  return new THREE.Vector3(
    a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f,
  );
}

// IT HAS TO GO DOWN. burn 0 is lit at the tip and burn 1 is at the powder, so
// the flame walks the path BACKWARDS. Reversed, it starts at the ball and
// travels out to the tip — which looks like the bomb charging up rather than
// counting down, and reads as entirely intentional to anyone who has not seen
// the other one.
const heights = [];
for (const burn of [0, 0.25, 0.5, 0.75, 1]) {
  const p = flameAt(burn);
  heights.push(p.y);
  flame.position.copy(p);
  present(`burn ${burn.toFixed(2)}`, `flame at y ${p.y.toFixed(2)}`);
}
check('the flame burns DOWN the wick, toward the powder',
  heights.every((h, i) => i === 0 || h <= heights[i - 1] + 1e-4),
  heights.map((h) => h.toFixed(2)).join(' -> '));
check('...and travels far enough to be a countdown, not a wobble',
  heights[0] - heights.at(-1) > size.y * 0.1,
  `${(heights[0] - heights.at(-1)).toFixed(2)} of travel on a ${size.y.toFixed(2)}-tall model`);
flame.visible = false;

// ===========================================================================
section('In the water <span>— lit, falling, and one beat from going off</span>', 2);
bomb.visible = true;
flame.visible = true;
flame.position.copy(flameAt(0.15));
VIEW = 6;
camera = makeCam(VIEW);
present('lit and falling', 'wick burning, 15% gone');

flame.position.copy(flameAt(0.9));
present('about to go', 'flame at the powder');

// The toon banding is injected GLSL (systems/toonShade.js) and a compile
// error there renders NOTHING while throwing nothing a Node harness can see.
check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
log(fails === 0 ? '\nall checks passed' : `\n${fails} check(s) failed`, fails ? 'bad' : 'ok');
await Promise.all(posted);
log('frames written');
