// ---------------------------------------------------------------------------
// THE CLAP LAB — where the flippers meet, from three sides at once.
//
//   npm run looks:claplab        then open http://localhost:4713/clap-lab.html
//
// The real seal, the real swim clip, the real aim rig and the real clap driver
// (systems/clap.js), rendered through one renderer into three viewports: the
// game's own side view, a view from in front of the nose, and one from above.
// The side view is the only one the player ever sees, and it is the one that
// cannot show whether the hands actually meet — they close along the camera
// axis. The other two exist to answer that.
//
// Every slider writes CONFIG.clap in memory. This is a vite build behind a
// read-only static server, so nothing here can reach imported-tuning.json.
// `W` saves the numbers to tools/looks/clap-lab.json beside this page, which is
// a file for a human to move into config.js — not a side effect of looking.
//
// Green spheres are the muzzles (the measured skin at the end of each
// flipper, what the game calls the hands). Red spheres are the IK targets the
// pose asks for. Cyan is the chest bone. The readout gives the hand gap as a
// fraction of the resting gap, and the hands' midpoint in the body's own frame
// — dorsal, forward, lateral — relative to the chest, so "in front of the
// torso" is a number rather than an impression.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import {
  preloadAssets, createVisual, applySavedAssetLooks, applyNoiseSettings, applyToonSettings,
  applyBiolumSkinSettings,
} from '../../path/src/assets.js';
import { createAnimationController } from '../../path/src/systems/animation.js';
import { createAimRig } from '../../path/src/systems/aimRig.js';
import { createClapDriver, triggerClap, updateClap, resetClap, clapState, clapDuration } from '../../path/src/systems/clap.js';
import { createPoseRig } from '../../path/src/systems/poseRig.js';

const q = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const valsEl = document.getElementById('vals');
const noteEl = document.getElementById('note');
const slidersEl = document.getElementById('sliders');

// --- the numbers this page owns ---------------------------------------------
// [path, label, min, max, step]. Paths are into CONFIG.clap.
const SLIDERS = [
  ['pose', null],
  ['pose.up', 'up (dorsal)', -0.8, 0.8, 0.01],
  ['pose.fore', 'fore (nose)', -0.4, 1.2, 0.01],
  ['pose.close', 'close (lat)', -0.3, 0.6, 0.01],
  ['pose.bob', 'bob', -0.4, 0.4, 0.01],
  ['pose.headUp', 'head up', -0.8, 0.8, 0.01],
  ['pose.headFore', 'head fore', 0, 1.2, 0.01],
  ['pose.headWeight', 'head weight', 0, 1, 0.01],
  ['ik', null],
  ['ik.maxFold', 'maxFold', 0.5, 3.1, 0.01],
  ['ik.maxBend', 'maxBend', 0.2, 3.1, 0.01],
  ['ik.maxTwist', 'maxTwist', 0, 2, 0.01],
  ['ik.smoothing', 'smoothing', 4, 80, 1],
  ['ik.iterations', 'iterations', 1, 12, 1],
  ['ik.softness', 'softness', 0, 1, 0.01],
  ['stroke', null],
  ['attack', 'attack s', 0.02, 0.4, 0.005],
  ['hold', 'hold s', 0, 0.4, 0.005],
  ['release', 'release s', 0.05, 1, 0.005],
  ['weight', 'weight', 0, 1, 0.01],
];
const DEFAULTS = JSON.parse(JSON.stringify(CONFIG.clap));

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
  o[ks[ks.length - 1]] = v;
}

const outputs = new Map();
function buildSliders() {
  slidersEl.innerHTML = '';
  for (const [path, label, min, max, step] of SLIDERS) {
    if (!label) {
      const h = document.createElement('h2');
      h.textContent = path;
      slidersEl.appendChild(h);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    const r = document.createElement('input');
    r.type = 'range'; r.min = min; r.max = max; r.step = step;
    r.value = getPath(CONFIG.clap, path) ?? 0;
    const o = document.createElement('output');
    o.textContent = Number(r.value).toFixed(step < 0.01 ? 3 : 2);
    r.addEventListener('input', () => {
      const v = Number(r.value);
      setPath(CONFIG.clap, path, v);
      o.textContent = v.toFixed(step < 0.01 ? 3 : 2);
      dirtyPreset = true;
    });
    row.append(l, r, o);
    slidersEl.appendChild(row);
    outputs.set(path, { r, o, step });
  }
}
function refreshSliders() {
  for (const [path, { r, o, step }] of outputs) {
    const v = getPath(CONFIG.clap, path) ?? 0;
    r.value = v;
    o.textContent = Number(v).toFixed(step < 0.01 ? 3 : 2);
  }
}

// Saved preset first, so the sliders open on it.
let dirtyPreset = false;
let presetNote = '';
try {
  const saved = await (await fetch('/preset/clap-lab.json')).json();
  if (saved.clap) {
    for (const [path, label] of SLIDERS) {
      if (!label) continue;
      const v = getPath(saved.clap, path);
      if (typeof v === 'number') setPath(CONFIG.clap, path, v);
    }
    presetNote = 'preset loaded from tools/looks/clap-lab.json';
  }
} catch { /* no server or nothing saved — the normal first run */ }
buildSliders();

// --- the frame --------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1c3a4f);
scene.add(new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient));
const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
key.position.fromArray(CONFIG.lighting.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity));

await preloadAssets();
applySavedAssetLooks();
applyNoiseSettings();
applyToonSettings();
applyBiolumSkinSettings();

// --- the animal -------------------------------------------------------------
// Swimming RIGHT, the way the game shows it: createVisual leaves a side-view
// creature nose-up, and -PI/2 about Z is the heading the run's faceMotion
// writes for +X travel. Nose +X, dorsal +Y, flippers spread along Z.
const holder = new THREE.Object3D();
holder.rotation.z = -Math.PI / 2;
scene.add(holder);
const body = createVisual('ship');
holder.add(body);

const anim = createAnimationController(body);
const rig = createAimRig(body);
const clap = createClapDriver(body);
// A second pose rig, for DRAWING the targets the driver asks for. It never
// poses anything — createPoseRig only reads bones until capture/restore are
// called, and this one never calls them.
const probe = createPoseRig(body, 'lab-probe');
const chest = body.getObjectByName('chest_04');

// --- markers ----------------------------------------------------------------
function ball(color, r = 0.07) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.renderOrder = 10;
  scene.add(m);
  return m;
}
const handBalls = [ball(0x7ee081), ball(0x7ee081)];
const targetBalls = [ball(0xff6f8f, 0.05), ball(0xff6f8f, 0.05)];
const headTarget = ball(0xffc861, 0.045);
const chestBall = ball(0x7ad7ff, 0.06);
const gapLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0x7ee081, depthTest: false }),
);
gapLine.renderOrder = 10;
scene.add(gapLine);

// --- cameras ----------------------------------------------------------------
const camSide = new THREE.OrthographicCamera();
const camFront = new THREE.OrthographicCamera();
const camTop = new THREE.OrthographicCamera();
camSide.position.set(0, 0, 40); camSide.up.set(0, 1, 0);
camFront.position.set(40, 0, 0); camFront.up.set(0, 1, 0);
camTop.position.set(0, 40, 0); camTop.up.set(-1, 0, 0);
for (const c of [camSide, camFront, camTop]) c.lookAt(0, 0, 0);

const DT = 1 / 60;
const aim = new THREE.Vector2(1, 0);
let swimming = true;
let loop = false;
let scrub = false;
let scrubT = 1;
let bpm = 120;
let loopClock = 0;

function step(dt) {
  anim?.update(dt, swimming ? 'swim' : 'idle', false);
  holder.updateMatrixWorld(true);
  rig?.update(dt, aim, { engaged: true });
  if (scrub) {
    clapState.active = true;
    clapState.t = scrubT;
  } else {
    updateClap(dt);
  }
  clap?.update(dt);
  holder.updateMatrixWorld(true);
}

// Settle, then measure the resting hand gap the readout is a fraction of.
for (let i = 0; i < 180; i++) step(DT);
const restGap = rig.muzzles[0].distanceTo(rig.muzzles[1]);
const box = new THREE.Box3().setFromObject(body);
const size = box.getSize(new THREE.Vector3());
const centre = box.getCenter(new THREE.Vector3());
const span = Math.max(size.x, size.y, size.z) * 0.62;

function fitCams() {
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 720;
  renderer.setSize(w, h);
  // The panel sits on the left; the side view takes what is left of the left
  // 62%, and the front and top views stack on the right.
  const PANEL = 312;
  const sideW = Math.floor(w * 0.62), rightW = w - sideW, halfH = Math.floor(h / 2);
  layout.side = [PANEL, 0, sideW - PANEL, h];
  layout.front = [sideW, halfH, rightW, h - halfH];
  layout.top = [sideW, 0, rightW, halfH];
  const fit = (cam, vw, vh, cx, cy, zoom = 1) => {
    const a = vw / vh;
    const hh = (a >= 1 ? span : span / a) * zoom;
    const hw = hh * a;
    cam.left = cx - hw; cam.right = cx + hw; cam.top = cy + hh; cam.bottom = cy - hh;
    cam.near = 0.1; cam.far = 200;
    cam.updateProjectionMatrix();
  };
  fit(camSide, sideW - PANEL, h, centre.x, centre.y);
  // The two check views frame the front half of the animal, where the hands
  // are, at about twice the side view's scale.
  fit(camFront, rightW, h - halfH, -centre.z, centre.y, 0.5);
  fit(camTop, rightW, halfH, -centre.z, -centre.x - span * 0.45, 0.6);
  place('capSide', PANEL + 12, 10);
  place('capFront', sideW + 12, 10);
  place('capTop', sideW + 12, halfH + 10);
}
const layout = { side: [0, 0, 1, 1], front: [0, 0, 1, 1], top: [0, 0, 1, 1] };
function place(id, x, y) {
  const el = document.getElementById(id);
  el.style.left = `${x}px`; el.style.top = `${y}px`;
}
window.addEventListener('resize', fitCams);
fitCams();

// --- readout ----------------------------------------------------------------
const _v = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _chest = new THREE.Vector3();
function bodyFrame(p, origin, out) {
  _v.copy(p).sub(origin);
  out.up = _v.dot(probe.basis.up);
  out.fore = _v.dot(probe.basis.fore);
  out.lat = _v.dot(probe.basis.lat);
  return out;
}
const midF = {}, lF = {}, rF = {};

function readout() {
  const m = rig.muzzles;
  const gap = m[0].distanceTo(m[1]);
  probe.refreshBasis();
  chest.getWorldPosition(_chest);
  _mid.copy(m[0]).add(m[1]).multiplyScalar(0.5);
  bodyFrame(_mid, _chest, midF);
  bodyFrame(m[0], _chest, lF);
  bodyFrame(m[1], _chest, rF);
  const p = CONFIG.clap.pose ?? {};
  const bob = clapState.t * (p.bob ?? 0);
  probe.fins.forEach(({ chain, side }, i) => {
    probe.target(chain, targetBalls[i].position, side, (p.up ?? 0) + bob, p.fore ?? 0, p.close ?? 0);
  });
  if (probe.head) probe.target(probe.head, headTarget.position, 1, (p.headUp ?? 0) + bob, p.headFore ?? 0, 0);
  handBalls[0].position.copy(m[0]);
  handBalls[1].position.copy(m[1]);
  chestBall.position.copy(_chest);
  gapLine.geometry.setFromPoints([m[0], m[1]]);

  valsEl.textContent =
    `t ${clapState.t.toFixed(2)}  ${scrub ? 'HELD' : clapState.active ? 'stroke' : 'open'}  `
    + `stroke ${clapDuration().toFixed(2)}s  presses ${clapState.presses}\n`
    + `hand gap ${gap.toFixed(2)}  =  ${(100 * gap / restGap).toFixed(0)}% of rest (${restGap.toFixed(2)})\n`
    + `hands mid, from chest (body frame):\n`
    + `  dorsal ${midF.up.toFixed(2)}   fore ${midF.fore.toFixed(2)}   lat ${midF.lat.toFixed(2)}\n`
    + `  L  up ${lF.up.toFixed(2)} fore ${lF.fore.toFixed(2)} lat ${lF.lat.toFixed(2)}\n`
    + `  R  up ${rF.up.toFixed(2)} fore ${rF.fore.toFixed(2)} lat ${rF.lat.toFixed(2)}\n`
    + `body ${size.x.toFixed(2)} long, ${size.y.toFixed(2)} tall, ${size.z.toFixed(2)} wide`;
  noteEl.textContent = presetNote + (dirtyPreset ? '  ·  unsaved changes (W)' : '');
}

// --- render -----------------------------------------------------------------
function view(cam, [x, y, w, h]) {
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.setScissorTest(true);
  renderer.render(scene, cam);
}
function render() {
  renderer.setScissorTest(false);
  renderer.clear();
  view(camSide, layout.side);
  view(camFront, layout.front);
  view(camTop, layout.top);
}

// --- controls ---------------------------------------------------------------
const b = (id) => document.getElementById(id);
function fire() {
  if (scrub) return;
  const m = rig.muzzles;
  triggerClap({ x: (m[0].x + m[1].x) / 2, y: (m[0].y + m[1].y) / 2 });
}
b('bClap').addEventListener('click', fire);
b('bLoop').addEventListener('click', () => { loop = !loop; b('bLoop').classList.toggle('on', loop); loopClock = 0; });
b('bSwim').addEventListener('click', () => { swimming = !swimming; b('bSwim').classList.toggle('on', swimming); });
b('bSwim').classList.add('on');
b('bScrub').addEventListener('click', () => {
  scrub = !scrub;
  b('bScrub').classList.toggle('on', scrub);
  if (!scrub) { resetClap(); }
  scrubRow.style.display = scrub ? '' : 'none';
});
b('bReset').addEventListener('click', () => {
  for (const [path, label] of SLIDERS) {
    if (!label) continue;
    setPath(CONFIG.clap, path, getPath(DEFAULTS, path));
  }
  refreshSliders();
  presetNote = 'config.js defaults (as loaded, tuning included)';
  dirtyPreset = true;
});
b('bSave').addEventListener('click', writePreset);

// The hold slider and the loop tempo, appended under the others.
const scrubRow = document.createElement('div');
scrubRow.className = 'row';
scrubRow.style.display = 'none';
scrubRow.innerHTML = '<label>hold t</label><input type="range" min="0" max="1" step="0.01" value="1"><output>1.00</output>';
scrubRow.querySelector('input').addEventListener('input', (e) => {
  scrubT = Number(e.target.value);
  scrubRow.querySelector('output').textContent = scrubT.toFixed(2);
});
slidersEl.appendChild(scrubRow);
const bpmRow = document.createElement('div');
bpmRow.className = 'row';
bpmRow.innerHTML = '<label>loop bpm</label><input type="range" min="40" max="240" step="1" value="120"><output>120</output>';
bpmRow.querySelector('input').addEventListener('input', (e) => {
  bpm = Number(e.target.value);
  bpmRow.querySelector('output').textContent = String(bpm);
});
slidersEl.appendChild(bpmRow);

window.addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); fire(); }
  if (e.key === 'W') writePreset();
});

function preset() {
  const out = {};
  for (const [path, label] of SLIDERS) {
    if (!label) continue;
    setPath(out, path, getPath(CONFIG.clap, path));
  }
  return { clap: out, savedAt: new Date().toISOString() };
}
async function writePreset() {
  const bodyJson = JSON.stringify(preset(), null, 2);
  try {
    const r = await fetch('/preset/clap-lab.json', { method: 'POST', body: bodyJson });
    presetNote = r.ok ? `saved tools/looks/clap-lab.json ${new Date().toLocaleTimeString()}` : `save failed: ${r.status}`;
    dirtyPreset = !r.ok;
  } catch (err) {
    presetNote = `save failed: ${err.message}`;
  }
}

// A frame off disk on demand, for reading without a live pane.
async function shoot(name) {
  const blob = await new Promise((res) => stage.toBlob(res, 'image/png'));
  await fetch(`/shot/${name}.png`, { method: 'POST', body: blob });
}
window.__shoot = shoot;
window.__clap = fire;
window.__hold = (t) => { scrub = true; scrubT = t; b('bScrub').classList.add('on'); scrubRow.style.display = ''; scrubRow.querySelector('input').value = t; };
window.__set = (path, v) => { setPath(CONFIG.clap, path, v); refreshSliders(); dirtyPreset = true; };
window.__step = (n = 60) => { for (let i = 0; i < n; i++) step(DT); readout(); render(); };
window.__state = () => ({ t: clapState.t, gap: rig.muzzles[0].distanceTo(rig.muzzles[1]), restGap, mid: { ...midF }, L: { ...lF }, R: { ...rF }, cfg: preset().clap });

let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (loop && !scrub) {
    loopClock += dt;
    const beat = 60 / bpm;
    if (loopClock >= beat) { loopClock -= beat; fire(); }
  }
  step(dt);
  readout();
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// `?shots` posts a strip: open, then held at four points of the stroke.
if (q.has('shots')) {
  for (let i = 0; i < 60; i++) step(DT);
  readout(); render();
  await shoot('clap-open');
  for (const t of [0.5, 1]) {
    window.__hold(t);
    for (let i = 0; i < 90; i++) step(DT);
    readout(); render();
    await shoot(`clap-t${t}`);
  }
  scrub = false; resetClap();
  noteEl.textContent = 'shots posted';
}
