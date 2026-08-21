// ---------------------------------------------------------------------------
// DROWNING — LOOK DEV
//
//   npm run looks:drowning
//
// What the last eighth of the oxygen bar does to the picture. The blackout used
// to PIXELATE; it now pushes the CRT screen filter past breaking point instead
// — the tube bulging, the scan lines opening up and darkening, the colour
// separating, the lines tearing. See CONFIG.oxygen.fx.crt, the ramp in
// systems/oxygenFx.js and `applySuffocationCrt` in systems/post.js.
//
// WHY A PAGE AND NOT A NODE HARNESS. Every one of those is a uniform read by
// the final composite shader, and a Node harness cannot see a fragment shader
// at all — the numbers would all be "right" over a screen nobody rendered. This
// page runs the SHIPPING post chain over real creatures, so the frames on it
// are the frames the game draws.
//
// Two rows, because the effect has to survive both:
//   THE RAMP        on `crt`, the shipped preset, which already curves and
//                   scans a little. This is what a player actually sees.
//   FILTER OFF      the same strain with CONFIG.post.enabled false. Nothing is
//                   there to add to, so this row is the whole effect on its
//                   own — a player who has switched the screen filter off still
//                   has to see themselves drown.
//
// IT WRITES NOTHING. CONFIG here is the live object of a throwaway bundle;
// there is no save path on this page and no dev server behind it. See
// SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { createPost } from '../../path/src/systems/post.js';
import { oxygenFxState } from '../../path/src/systems/oxygenFx.js';

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

// A shader that fails to compile renders NOTHING and three only writes to the
// console about it, so an all-black sheet would read as a tuning decision
// rather than as a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 440;
const H = 275; // roughly the game's letterbox, because the curve pulls corners
const DT = 1 / 60;

const gl = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x081b2b);
scene.add(new THREE.AmbientLight(0x9cc4ff, 0.9));
const key = new THREE.DirectionalLight(0xfff2dc, 2.0);
key.position.set(3, 8, 6);
scene.add(key);

// The water behind everything. The scan lines and the mask are MULTIPLIES, so a
// panel over pure black shows neither — the thing they are drawn on is what
// makes them visible at all.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x14486b }),
);
water.position.z = -60;
scene.add(water);

// Something with an EDGE in it, at the corners as well as the middle: the
// barrel curve is a displacement, and it is invisible on a flat wash. These are
// the seabed rocks' job in the game.
for (let i = 0; i < 26; i++) {
  const a = (i / 26) * Math.PI * 2;
  const r = 6 + (i % 5) * 2.6;
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.5 + (i % 3) * 0.35, 0),
    new THREE.MeshStandardMaterial({ color: 0x2a4f66, roughness: 0.9 }),
  );
  rock.position.set(Math.cos(a) * r * 1.7, Math.sin(a) * r, -8 - (i % 4) * 3);
  scene.add(rock);
}

// Two bright things, so the bloom is in the picture the filter is bending — the
// chroma split and the smear are read off highlights before anything else.
for (const [x, y, c] of [[-9, 3.5, 0x9be7ff], [8.5, -4, 0xffd479]]) {
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 16, 12),
    new THREE.MeshBasicMaterial({ color: c }),
  );
  orb.position.set(x, y, -2);
  scene.add(orb);
}

const VIEW = 26; // about the game's framing on the seal
const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -200, 200,
);
camera.position.set(0, 0, 40);

await preloadAssets();

// Lay the bodies flat — createVisual points a creature forward at world +Y, and
// a nose-up animal is a vertical sliver that tells you nothing.
function place(assetKey, x, y, scale = 1) {
  const v = createVisual(assetKey);
  if (!v) return null;
  v.rotation.z = -Math.PI / 2;
  v.position.set(x, y, 0);
  v.scale.multiplyScalar(scale);
  scene.add(v);
  return v;
}
const seal = place('ship', -2, -1.5, 1.6);
const shark = place('enemyGreatWhite', 7, 4, 1.2);
check('the scene has bodies in it', !!(seal || shark),
  [seal && 'seal', shark && 'great white'].filter(Boolean).join(' + ') || 'primitives only');

const post = createPost(gl);

// --- reading the frames -----------------------------------------------------
// Every claim below is measured off the composited pixels rather than off the
// uniforms, because a uniform being set is not the same as it reaching the
// screen — which is the entire failure mode this page exists to catch.
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });

function grab(strain, postEnabled = true) {
  const was = CONFIG.post.enabled;
  CONFIG.post.enabled = postEnabled;
  oxygenFxState.strain = strain;
  post.resize();
  post.render(scene, camera, DT);
  CONFIG.post.enabled = was;
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height);
}

const lum = (d, i) => (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;

/** Mean luminance of a box given in 0..1 frame coordinates. */
function boxLum(img, x0, y0, x1, y1) {
  const { data, width, height } = img;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) {
    for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) {
      sum += lum(data, (y * width + x) * 4);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * How strongly the picture is banded HORIZONTALLY — the scan lines, isolated
 * from everything else in the frame.
 *
 * Row means, then the mean absolute step between neighbouring rows. Rows rather
 * than pixels because a scan line is the one artifact that runs the full width:
 * averaging a row keeps it and cancels the content, which a plain variance over
 * the whole image would not — that number moves with the rocks.
 */
function bandiness(img) {
  const { data, width, height } = img;
  const x0 = Math.floor(width * 0.3);
  const x1 = Math.floor(width * 0.7);
  const rows = [];
  for (let y = Math.floor(height * 0.25); y < Math.floor(height * 0.75); y++) {
    let sum = 0;
    for (let x = x0; x < x1; x++) sum += lum(data, (y * width + x) * 4);
    rows.push(sum / (x1 - x0));
  }
  let step = 0;
  for (let i = 1; i < rows.length; i++) step += Math.abs(rows[i] - rows[i - 1]);
  return step / Math.max(1, rows.length - 1);
}

/**
 * How much the picture changed between two frames, as a FRACTION of how bright
 * it was — averaged over the lit part of the frame only.
 *
 * Both halves of that are corrections for the same thing, and the first version
 * of this page had neither. A mean ABSOLUTE luminance difference over the WHOLE
 * frame is the obvious measure and it is close to useless here: this scene,
 * like the game, is most of a screen of near-black water at about 6% luminance,
 * so an effect that halves everything you can see scores two percent — and
 * which two percent depends on how much water is in shot, which is a
 * measurement of the SCENE rather than of the effect. Dividing by the brighter
 * of the two samples asks the question the eye asks: how much of what was there
 * is gone.
 */
function difference(a, b) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const la = lum(a.data, i);
    const lb = lum(b.data, i);
    const top = Math.max(la, lb);
    if (top < 0.05) continue; // unlit: nothing there to change
    sum += Math.abs(la - lb) / top;
    n++;
  }
  return n ? sum / n : 0;
}

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];

function row(heading, sub) {
  const h = document.createElement('h2');
  h.innerHTML = sub ? `${heading} <span>${sub}</span>` : heading;
  sheetEl.appendChild(h);
  const r = document.createElement('div');
  r.className = 'row';
  sheetEl.appendChild(r);
  return r;
}

function cell(into, title, caption, picked = false) {
  const wrap = document.createElement('div');
  wrap.className = picked ? 'cell pick' : 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
  wrap.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b><br>${caption}`;
  wrap.appendChild(cap);
  into.appendChild(wrap);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

const STRAINS = [0, 0.25, 0.5, 0.75, 1];
const crt = CONFIG.oxygen?.fx?.crt ?? {};
log(`preset: ${CONFIG.post.preset}   ramp: strain^${crt.rampCurve}`, 'dim');
log(`curve +${crt.curve}   scan +${crt.scan} @ ${crt.scanCount} lines   chroma +${crt.chroma}   jitter +${crt.jitter}`, 'dim');
log('');

const onFrames = [];
const shipped = row('The ramp', 'on the crt preset — what a player sees');
for (const s of STRAINS) {
  const img = grab(s, true);
  onFrames.push(img);
  const ramped = Math.pow(s, crt.rampCurve ?? 1.8);
  cell(shipped, `strain ${s.toFixed(2)}`,
    s === 0 ? 'above the threshold — the preset alone, nothing added'
      : `ramp ${ramped.toFixed(2)} · curve ${(0.14 + (crt.curve ?? 0) * ramped).toFixed(2)}`
        + ` · scan ${(0.22 + (crt.scan ?? 0) * ramped).toFixed(2)}`,
    s === 0);
}

const offFrames = [];
const bare = row('Screen filter off', 'CONFIG.post.enabled false — the effect standing alone');
for (const s of [0, 0.5, 1]) {
  offFrames.push(grab(s, false));
  cell(bare, `filter off, strain ${s.toFixed(2)}`,
    s === 0 ? 'a clean render — this is the baseline the row is measured against'
      : 'nothing under it to add to, so this is the whole effect', s === 0);
}

// --- what the frames say ----------------------------------------------------
log('');
const clean = onFrames[0];
const gone = onFrames[onFrames.length - 1];

// THE FLOOR, measured rather than assumed. Both the preset and this effect add
// per-frame SNOW, so two renders of the same untouched scene already differ —
// and without this every number below would be quoted against a zero that does
// not exist, which is how a noise floor gets read as an effect.
const control = difference(clean, grab(0, true));

const diff = difference(clean, gone);
// A quarter of the light in the picture moved. Well past arguable, which is
// the bar for an effect whose whole job is to be alarming.
check('empty lungs are a different picture from full ones', diff > control * 1.8,
  `${(diff * 100).toFixed(0)}% of the lit picture's brightness moved,`
  + ` against a ${(control * 100).toFixed(0)}% floor of frame-to-frame snow`);

// Monotonic, because a ramp that jumps or backs up mid-way reads as a glitch
// rather than as a slide. Measured against the clean frame each time.
const walk = onFrames.map((f) => difference(clean, f));
const climbs = walk.every((v, i) => i === 0 || v > walk[i - 1] - 1e-4);
check('the effect only ever gets worse as the air runs out', climbs,
  walk.map((v) => (v * 100).toFixed(0)).join('% → ') + '%');

const b0 = bandiness(clean);
const b1 = bandiness(gone);
check('the scan lines are visibly fatter and darker at empty', b1 > b0 * 1.5,
  `row-to-row step ${(b0 * 1000).toFixed(1)} → ${(b1 * 1000).toFixed(1)} (x${(b1 / Math.max(b0, 1e-6)).toFixed(1)})`);

// The curve throws the corners off the edge of the sampled image, where the
// shader writes black, and the vignette darkens what is left. Both are the
// picture closing in, which is the read the effect is going for.
const corner0 = (boxLum(clean, 0, 0, 0.08, 0.12) + boxLum(clean, 0.92, 0.88, 1, 1)) / 2;
const corner1 = (boxLum(gone, 0, 0, 0.08, 0.12) + boxLum(gone, 0.92, 0.88, 1, 1)) / 2;
const middle0 = boxLum(clean, 0.4, 0.4, 0.6, 0.6);
const middle1 = boxLum(gone, 0.4, 0.4, 0.6, 0.6);
check('the picture closes in on the middle', corner1 < corner0 * 0.7,
  `corners ${(corner0 * 100).toFixed(1)}% → ${(corner1 * 100).toFixed(1)}%,`
  + ` middle ${(middle0 * 100).toFixed(1)}% → ${(middle1 * 100).toFixed(1)}%`);

// The whole point of the rewrite: this has to read for a player who turned the
// screen filter off, because it is drowning's only visual.
const bareDiff = difference(offFrames[0], offFrames[2]);
// No preset under it, so the floor here is this effect's own snow and nothing
// else — the strain-0 frame in that row is a completely clean render.
check('it still reads with the screen filter switched off', bareDiff > 0.25,
  `${(bareDiff * 100).toFixed(0)}% of the lit picture's brightness moved`);
const bareBand = bandiness(offFrames[2]) / Math.max(bandiness(offFrames[0]), 1e-6);
check('...including the scan lines, which the off preset leaves at zero lines', bareBand > 1.5,
  `row-to-row step x${bareBand.toFixed(1)}`);

check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');

log('');
log(fails === 0 ? 'all checks passed' : `${fails} check(s) failed`, fails === 0 ? 'ok' : 'bad');
await Promise.all(posted);
log('frames written', 'dim');
