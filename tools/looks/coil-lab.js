// ---------------------------------------------------------------------------
// THE COIL LAB — what "STRIKE NOW!" looks like on the animal.
//
//   npm run looks:coillab       then open http://localhost:4737/coil-lab.html
//
// The real seal, the real swim clip, the real aim rig and the real coil driver
// (systems/strikePose.js), in the game's own side view — TWICE. The left animal
// never coils and the right one does, because the only question this page
// exists to answer is whether a player can SEE the difference in a profile
// silhouette at fight size, and a single seal cannot answer it: every pose
// looks like a pose when it is the only thing on screen.
//
// The small strip along the bottom is the same animal at roughly the size it
// is in a real frame. If the coil cannot be read there it does not exist.
//
// Every slider writes CONFIG.strikePose in memory. This is a vite build behind
// a read-only static server, so nothing here can reach imported-tuning.json.
// `W` saves the numbers to tools/looks/coil-lab.json beside this page, which is
// a file for a human to move into config.js — not a side effect of looking.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import {
  preloadAssets, createVisual, applySavedAssetLooks, applyNoiseSettings, applyToonSettings,
  applyBiolumSkinSettings,
} from '../../path/src/assets.js';
import { createAnimationController } from '../../path/src/systems/animation.js';
import { createAimRig } from '../../path/src/systems/aimRig.js';
import {
  createStrikePoseDriver, updateStrikePose, resetStrikePose, strikePoseState,
} from '../../path/src/systems/strikePose.js';
import {
  initParticles, updateParticles, resetParticles, updateParticleScale, particleCount,
} from '../../path/src/entities/particles.js';
import { updateBubbles, resetBubbles } from '../../path/src/systems/bubbles.js';
import { updatePoseBubbles, resetPoseBubbles } from '../../path/src/systems/poseBubbles.js';

const q = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const valsEl = document.getElementById('vals');
const noteEl = document.getElementById('note');
const slidersEl = document.getElementById('sliders');

// --- the numbers this page owns ---------------------------------------------
// [path, label, min, max, step]. Paths are into CONFIG.strikePose.
const SLIDERS = [
  ['pose', null],
  ['pose.up', 'fin up', -0.8, 0.8, 0.01],
  ['pose.fore', 'fin fore', -1, 0.8, 0.01],
  ['pose.spread', 'fin spread', 0, 0.8, 0.01],
  ['pose.finWeight', 'fin weight', 0, 1, 0.01],
  ['pose.headUp', 'head up', -0.8, 0.8, 0.01],
  ['pose.headFore', 'head fore', 0, 1.2, 0.01],
  ['pose.headWeight', 'head weight', 0, 1, 0.01],
  ['pose.tailUp', 'tail up', -0.8, 0.8, 0.01],
  ['pose.tailFore', 'tail fore', -1.2, 0, 0.01],
  ['pose.tailWeight', 'tail weight', 0, 1, 0.01],
  ['envelope', null],
  ['snap', 'snap s', 0.02, 0.4, 0.005],
  ['settle', 'settle s', 0.01, 0.6, 0.005],
  ['release', 'release s', 0.02, 0.6, 0.005],
  ['overshoot', 'overshoot', 1, 1.5, 0.01],
  ['weight', 'weight', 0, 1, 0.01],
  ['ik', null],
  ['ik.maxFold', 'maxFold', 0.5, 3.1, 0.01],
  ['ik.maxBend', 'maxBend', 0.2, 3.1, 0.01],
  ['ik.smoothing', 'smoothing', 4, 80, 1],
  ['ik.iterations', 'iterations', 1, 12, 1],
  ['ik.softness', 'softness', 0, 1, 0.01],
];
const DEFAULTS = JSON.parse(JSON.stringify(CONFIG.strikePose));

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
    r.value = getPath(CONFIG.strikePose, path) ?? 0;
    const o = document.createElement('output');
    o.textContent = Number(r.value).toFixed(step < 0.01 ? 3 : 2);
    r.addEventListener('input', () => {
      const v = Number(r.value);
      setPath(CONFIG.strikePose, path, v);
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
    const v = getPath(CONFIG.strikePose, path) ?? 0;
    r.value = v;
    o.textContent = Number(v).toFixed(step < 0.01 ? 3 : 2);
  }
}

let dirtyPreset = false;
let presetNote = '';
try {
  const saved = await (await fetch('/preset/coil-lab.json')).json();
  if (saved.strikePose) {
    for (const [path, label] of SLIDERS) {
      if (!label) continue;
      const v = getPath(saved.strikePose, path);
      if (typeof v === 'number') setPath(CONFIG.strikePose, path, v);
    }
    presetNote = 'preset loaded from tools/looks/coil-lab.json';
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

// --- the animals ------------------------------------------------------------
// Swimming RIGHT, the way the game shows it: createVisual leaves a side-view
// creature nose-up, and -PI/2 about Z is the heading the run's faceMotion
// writes for +X travel.
//
// TWO OF THEM, and only one is ever coiled. The reference seal is the control
// for the one question here — see the header.
function seal(y) {
  const holder = new THREE.Object3D();
  holder.rotation.z = -Math.PI / 2;
  holder.position.y = y;
  scene.add(holder);
  const body = createVisual('ship');
  holder.add(body);
  return {
    holder,
    body,
    anim: createAnimationController(body),
    rig: createAimRig(body),
    coil: createStrikePoseDriver(body),
  };
}
// STACKED, NOT SIDE BY SIDE. The animal is four times longer than it is tall,
// so two of them abreast leave a frame that is mostly empty water and a pair
// of small seals; one above the other fills the same frame with animal. It
// also puts the two silhouettes' NOSES and FLUKES directly above each other,
// which is where the difference between coiled and not is.
const SEP = 0.95; // world units above/below the centre line
const rest = seal(SEP);
const live = seal(-SEP);

// THE WATER, on the live animal only. The puff this page exists to judge
// (CONFIG.strikePose.bubbles) has to be looked at THROUGH the wind-up vent,
// not on its own: CONFIG.bubbles.charge is already pouring out of the mouth
// and down the tail at up to 73 firings a second while the button is held, and
// it does not stop when the bar tops out. A burst that reads beautifully
// against clear water and vanishes into that haze is the failure this page is
// here to catch, so the vent runs whenever the coil is armed.
initParticles(scene);
const FORWARD = new THREE.Vector2(1, 0);
const STILL = { x: 0, y: 0 };
let water = true;
let ventCharge = 1;
let puffed = 0;   // bubbles the COIL has emitted — see the note in step()

const DT = 1 / 60;
const aim = new THREE.Vector2(1, 0);
let swimming = true;
let armed = false;      // is the wind-up loaded and the button down
let pulsing = 0;        // seconds left of a timed arm, for the `pulse` button

function step(dt) {
  for (const s of [rest, live]) {
    s.anim?.update(dt, swimming ? 'swim' : 'idle', false);
    s.holder.updateMatrixWorld(true);
    s.rig?.update(dt, aim, { engaged: true });
  }
  if (pulsing > 0) {
    pulsing = Math.max(0, pulsing - dt);
    if (pulsing === 0) armed = false;
  }
  // The reference animal is stepped through the SAME driver with the state
  // forced off, rather than left without one: a difference between the two
  // seals then cannot be the driver merely existing.
  updateStrikePose(dt, armed);
  live.coil?.update(dt);
  const held = strikePoseState.active;
  strikePoseState.active = false;
  rest.coil?.update(dt);
  strikePoseState.active = held;
  for (const s of [rest, live]) s.holder.updateMatrixWorld(true);

  if (water) {
    // `armed ? 1 : 0` is the vent's charge: in a run it rides strikeState
    // .pending, which is pinned at the top for the whole of the moment this
    // page is about.
    // THE VENT, AT THE CHARGE THE GAME WOULD BE FEEDING IT. In a run this is
    // `input.strikeHeld ? strikeState.pending : 0` (main.js), and `pending` is
    // pinned at the top for the whole of the moment — so the wind-up's spray
    // does NOT stop when the bar fills, even though the tremble and the tail
    // lift do (they ride `charging`, which goes false the frame the tank runs
    // dry). `__vent(0)` from the console is the A/B for that: it shows the
    // same moment with the haze easing off instead of pouring through it.
    updateBubbles(dt, live.rig, STILL, false, armed ? ventCharge : 0, FORWARD);
    // COUNTED, because "the puff is too small" and "the puff never fired" look
    // identical through a vent pouring 73 bubbles a second past it — and the
    // second one is a one-line bug (an anchor name nothing resolves emits
    // NOTHING rather than falling back to the body; see systems/poseBubbles.js).
    puffed += updatePoseBubbles(dt, live.rig, { aboveSurface: false, velocity: STILL });
    updateParticles(dt);
  }
}

// Settle both animals before anything is measured or framed.
for (let i = 0; i < 180; i++) step(DT);
const box = new THREE.Box3().setFromObject(live.body);
const size = box.getSize(new THREE.Vector3());

// --- cameras ----------------------------------------------------------------
// The pair, at a size a pose can be judged at; and the same pair again along
// the bottom at about the scale the game actually draws them.
const camPair = new THREE.OrthographicCamera();
const camGame = new THREE.OrthographicCamera();
for (const c of [camPair, camGame]) { c.position.set(0, 0, 40); c.up.set(0, 1, 0); c.lookAt(0, 0, 0); }

const layout = { pair: [0, 0, 1, 1], game: [0, 0, 1, 1] };
function fitCams() {
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 720;
  renderer.setSize(w, h);
  const PANEL = 312;
  const stripH = Math.max(120, Math.floor(h * 0.24));
  layout.pair = [PANEL, stripH, w - PANEL, h - stripH];
  layout.game = [PANEL, 0, w - PANEL, stripH];

  // THE PAIR, framed on the two animals and nothing else — derived from where
  // they were put and how long they measure, so a change to either cannot
  // leave the page quietly cropping a flipper.
  const a = layout.pair[2] / Math.max(1, layout.pair[3]);
  const halfH = (SEP + size.y) * 1.15;
  const halfW = Math.max(halfH * a, size.x * 0.62);
  camPair.left = -halfW; camPair.right = halfW;
  camPair.top = halfW / a; camPair.bottom = -halfW / a;
  camPair.near = 0.1; camPair.far = 200;
  camPair.updateProjectionMatrix();

  // ...AND THE STRIP IS THE GAME'S OWN SCALE — its WORLD UNITS PER PIXEL, not
  // its frame. The game fits CONFIG.arena.viewHeight into the whole window, so
  // that is the ratio to reproduce; putting the whole 52 units into a strip a
  // fifth of the window tall would draw the seals a fifth of the size they
  // really are and condemn any pose as unreadable.
  const perPx = CONFIG.arena.viewHeight / Math.max(1, h);
  camGame.top = (layout.game[3] * perPx) / 2;
  camGame.bottom = -camGame.top;
  camGame.left = -(layout.game[2] * perPx) / 2; camGame.right = -camGame.left;
  camGame.near = 0.1; camGame.far = 200;
  camGame.updateProjectionMatrix();

  place('capPair', PANEL + 12, 10);
  place('capGame', PANEL + 12, h - stripH + 10);
}
function place(id, x, y) {
  const el = document.getElementById(id);
  el.style.left = `${x}px`; el.style.top = `${y}px`;
}
window.addEventListener('resize', fitCams);
fitCams();

// --- readout ----------------------------------------------------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
// How far each limb has travelled from where the SAME limb is on the reference
// animal, in world units — the pose as a number, so "is it doing anything" is
// not a matter of opinion. Both seals run the same clip from the same settle,
// so the difference is the coil and nothing else.
function drift(name) {
  const a = rest.body.getObjectByName(name);
  const b = live.body.getObjectByName(name);
  if (!a || !b) return NaN;
  a.getWorldPosition(_a); b.getWorldPosition(_b);
  // Measured against each animal's own root, or the 6.4 units between them
  // would be the whole answer.
  _a.sub(rest.holder.position); _b.sub(live.holder.position);
  return _a.distanceTo(_b);
}

function readout() {
  const s = strikePoseState;
  valsEl.textContent =
    `phase ${s.phase.padEnd(7)} t ${s.t.toFixed(3)}  hits ${s.hits}  ${armed ? 'ARMED' : 'idle'}\n`
    + `coil bubbles emitted ${puffed}  (the vent's are not counted)\n`
    + `drift from the reference seal (world units):\n`
    + `  hand L ${drift('hand_L_014').toFixed(3)}   hand R ${drift('hand_R_018').toFixed(3)}\n`
    + `  head   ${drift('head_07').toFixed(3)}   fluke ${drift('tail02_023').toFixed(3)}\n`
    + `body ${size.x.toFixed(2)} long, ${size.y.toFixed(2)} tall`;
  noteEl.textContent = presetNote + (dirtyPreset ? '  ·  unsaved changes (W)' : '');
}

// --- render -----------------------------------------------------------------
// PARTICLES ARE SIZED IN PIXELS, and this page has two cameras at different
// scales sharing one canvas — so the sprite size has to be set per VIEW or
// every bubble on the page is drawn at whatever the last view asked for.
//
// It is also the trap that cost the most time on this page: with no call at
// all the material sits at its default 40 device pixels per world unit, and
// this page's pair camera is nearer 140 — so a puff that was firing perfectly
// well rendered a third of its real size, which looks exactly like an effect
// that is too weak and invites tuning the wrong number.
//
// updateParticleScale divides by the CANVAS height, not the viewport's, so the
// camera handed to it is a stand-in whose frustum is what this view's scale
// would cover if it filled the canvas. Same ratio, right answer.
const _scaleCam = { isPerspectiveCamera: false, top: 1, bottom: -1, zoom: 1 };
function view(cam, [x, y, w, h]) {
  const worldPerPx = (cam.top - cam.bottom) / Math.max(1, h);
  const full = worldPerPx * (renderer.domElement.height / renderer.getPixelRatio());
  _scaleCam.top = full / 2;
  _scaleCam.bottom = -full / 2;
  updateParticleScale(_scaleCam, renderer);
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.setScissorTest(true);
  renderer.render(scene, cam);
}
function render() {
  renderer.setScissorTest(false);
  renderer.clear();
  view(camPair, layout.pair);
  view(camGame, layout.game);
}

// --- controls ---------------------------------------------------------------
const b = (id) => document.getElementById(id);
function setArmed(v) {
  armed = v;
  pulsing = 0;
  b('bArm').classList.toggle('on', armed);
}
b('bArm').addEventListener('click', () => setArmed(!armed));
b('bPulse').addEventListener('click', () => { armed = true; pulsing = 0.6; b('bArm').classList.add('on'); });
b('bSwim').addEventListener('click', () => { swimming = !swimming; b('bSwim').classList.toggle('on', swimming); });
b('bSwim').classList.add('on');
// The vent and the puff, off — for looking at the pose alone, which is what
// every measurement on this page is about.
b('bWater').addEventListener('click', () => {
  water = !water;
  b('bWater').classList.toggle('on', water);
  if (!water) { resetParticles(); resetBubbles(); resetPoseBubbles(); }
});
b('bWater').classList.add('on');
b('bReset').addEventListener('click', () => {
  for (const [path, label] of SLIDERS) {
    if (!label) continue;
    setPath(CONFIG.strikePose, path, getPath(DEFAULTS, path));
  }
  refreshSliders();
  presetNote = 'config.js defaults (as loaded, tuning included)';
  dirtyPreset = true;
});
b('bSave').addEventListener('click', writePreset);

window.addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); setArmed(!armed); }
  if (e.key === 'W') writePreset();
});

function preset() {
  const out = {};
  for (const [path, label] of SLIDERS) {
    if (!label) continue;
    setPath(out, path, getPath(CONFIG.strikePose, path));
  }
  return { strikePose: out, savedAt: new Date().toISOString() };
}
async function writePreset() {
  try {
    const r = await fetch('/preset/coil-lab.json', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    presetNote = r.ok ? `saved tools/looks/coil-lab.json ${new Date().toLocaleTimeString()}` : `save failed: ${r.status}`;
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
window.__arm = (v) => setArmed(!!v);
window.__set = (path, v) => { setPath(CONFIG.strikePose, path, v); refreshSliders(); dirtyPreset = true; };
// The PUFF'S OWN emitter, live. Not a slider row: `coilPuff` is an entry in
// CONFIG.emitters like every other emitter and belongs in the particle
// workbench with them — this is here so a sweep can be run from the console
// without a rebuild between each candidate.
window.__vent = (v) => { ventCharge = v; };
window.__live = () => particleCount();
window.__puff = (patch) => { Object.assign(CONFIG.emitters.coilPuff, patch); return { ...CONFIG.emitters.coilPuff }; };
window.__step = (n = 60) => { for (let i = 0; i < n; i++) step(DT); readout(); render(); };
window.__state = () => ({
  phase: strikePoseState.phase, t: strikePoseState.t, hits: strikePoseState.hits, puffed,
  drift: {
    handL: drift('hand_L_014'), handR: drift('hand_R_018'),
    head: drift('head_07'), fluke: drift('tail02_023'),
  },
  cfg: preset().strikePose,
});

// THE LIVE CLOCK, AND A WAY TO STOP IT. A pose is compared against another
// pose, and two frames grabbed a second apart are two different points of the
// swim cycle — which moves the flippers further than any of the numbers on
// this page do. `__pause(true)` freezes the loop so `__step(n)` can advance an
// exact number of frames, and every comparison shot is then taken from the
// same place.
let running = true;
window.__pause = (v) => { running = !v; };
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (running) step(dt);
  readout();
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// `?shots` posts the moment in four frames: uncoiled, the peak of the snap,
// the held pose, and halfway out of it.
if (q.has('shots')) {
  for (let i = 0; i < 60; i++) step(DT);
  readout(); render();
  await shoot('coil-idle');
  setArmed(true);
  // The peak of the snap is `snap` seconds in — stepped exactly, not waited
  // for, so the frame is the top of the accent rather than near it.
  const snapFrames = Math.max(1, Math.round((CONFIG.strikePose.snap ?? 0.07) / DT));
  for (let i = 0; i < snapFrames; i++) step(DT);
  readout(); render();
  await shoot('coil-snap');
  for (let i = 0; i < 60; i++) step(DT);
  readout(); render();
  await shoot('coil-held');
  setArmed(false);
  const outFrames = Math.max(1, Math.round((CONFIG.strikePose.release ?? 0.16) / DT / 2));
  for (let i = 0; i < outFrames; i++) step(DT);
  readout(); render();
  await shoot('coil-out');
  resetStrikePose();
  noteEl.textContent = 'shots posted';
}
