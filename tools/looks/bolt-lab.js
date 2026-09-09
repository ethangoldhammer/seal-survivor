// ---------------------------------------------------------------------------
// BOLT LAB — the chain lightning, live
//
//   npm run looks:bolt        then open http://localhost:4715/tools/looks/bolt-lab.html
//
// The eel's arc is the one picture three different cards draw: the Electric Eel
// Friend's chain, Voltaic's second target, and the zappy club's hop. It is also
// the effect that is hardest to judge in the game, because it lasts a third of
// a second, fires on a cooldown, and only ever appears in the middle of a fight
// with everything else going off at the same time. This is that bolt, on demand,
// at any level, with every knob in one column.
//
// WHY A PAGE AND NOT THE GAME. There is exactly one dev server in this project
// and it is the sole writer of path/src/imported-tuning.json; a second one is a
// second game quietly flattening real tuning work. This is a static BUILD of the
// shipped modules with no save path into the tuning file anywhere in it — `W`
// writes tools/looks/bolt-lab.json, which is a file for a human to move across.
// See SERVERS.md.
//
// WHY A PAGE AND NOT A NODE HARNESS. Everything numeric about the ramp is
// already checkable from a terminal (crackleCfg is exported for exactly that),
// and none of it is the question here. The question is whether the bolt reads as
// electricity — which is a bright pass, an additive halo over water, and a
// flicker at 40-odd Hz. Node has no bright pass and no frames.
//
// IT DRAWS THE SHIPPED BOLT. Nothing about the arc is reimplemented here:
// spawnChainBolt and updateEel are the game's, the post chain is the game's, and
// the sliders write CONFIG. If it looks right here it looks right in the run.
//
// THE LADDER IS THE POINT OF THE PAGE. "It grows with level" is not a thing
// anyone can judge one bolt at a time — you are comparing what is on screen with
// what you remember from thirty seconds ago. `L` fires one bolt per level, all
// at once, stacked down the frame, so the growth is a comparison.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets } from '../../path/src/assets.js';
import { createPost } from '../../path/src/systems/post.js';
import { weatherState } from '../../path/src/systems/weather.js';
import {
  updateEel, createEelCompanion, resetEelBolts, spawnChainBolt, crackleCfg, eelCfg,
} from '../../path/src/systems/eel.js';

const q = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const slidersEl = document.getElementById('sliders');
const valsEl = document.getElementById('vals');
const noteEl = document.getElementById('note');
const b = (id) => document.getElementById(id);

// --- what the panel drives --------------------------------------------------
// Two lists. LAB holds the things that are not the effect — which level is
// firing, whether it is storming, how many bodies the chain finds — and they
// are deliberately not saved into the preset: they are the test conditions, not
// the look. CONFIG_SLIDERS is the look, and every path is a real CONFIG.eel key.
const lab = {
  level: 1,
  storm: 0,
  hops: 4,
  autoHz: 1.4,
  spread: 3.2,
};
const LAB_SLIDERS = [
  ['level', 'LEVEL', 0, 8, 1],
  ['storm', 'storm 0-1', 0, 1, 0.05],
  ['hops', 'bodies in chain', 1, 8, 1],
  ['spread', 'how scattered', 0, 8, 0.1],
  ['autoHz', 'auto: per second', 0.2, 8, 0.1],
];

const CONFIG_SLIDERS = [
  ['the bolt', null],
  ['boltGlow', 'brightness', 0, 12, 0.1],
  ['boltLife', 'lifetime s', 0.05, 1.5, 0.01],
  ['coreWidth', 'core width', 0.01, 0.5, 0.01],
  ['glowWidth', 'halo width', 0.02, 1.5, 0.02],
  ['glowOpacity', 'halo opacity', 0, 1, 0.02],
  ['crackle: brightness', null],
  ['crackle.overdrive', 'overdrive', 0.2, 4, 0.05],
  ['crackle.bloom', 'bloom (halo)', 0.2, 5, 0.05],
  ['crackle.flash', 'ignition x', 1, 8, 0.1],
  ['crackle.flashDecay', 'ignition s', 0.01, 0.3, 0.005],
  ['crackle: flicker', null],
  ['flickerSpeed', 'base rate', 0, 120, 1],
  ['crackle.flickerDepth', 'depth', 0, 1, 0.02],
  ['crackle.flickerOctaves', 'rates stacked', 1, 6, 1],
  ['crackle.flickerSpread', 'each rate x', 1.1, 5, 0.05],
  ['crackle: reshape', null],
  ['crackle.reseedHz', 'reshapes/sec', 0, 60, 1],
  ['crackle.reseedJitter', 'timing ragged', 0, 1, 0.05],
  ['crackle.variants', 'shapes per bolt', 1, 6, 1],
  ['crackle: bolt to bolt', null],
  ['crackle.vary.amplitude', 'thrash ±', 0, 1, 0.05],
  ['crackle.vary.width', 'width ±', 0, 1, 0.05],
  ['crackle.vary.life', 'lifetime ±', 0, 1, 0.05],
  ['crackle.vary.flicker', 'flicker rate ±', 0, 1, 0.05],
  ['shape', null],
  ['noiseAmplitude', 'jaggedness', 0, 3, 0.05],
  ['noiseOctaves', 'noise detail', 1, 5, 1],
  ['noiseContrast', 'spikiness', 0.5, 5, 0.1],
  ['noiseScrollSpeed', 'noise churn', 0, 80, 1],
  ['segmentsPerHop', 'spline segments', 3, 40, 1],
  ['branchChance', 'fork chance', 0, 1, 0.05],
  ['branchesPerHop', 'forks per hop', 0, 5, 1],
  ['branchLength', 'fork length', 0.1, 1.5, 0.05],
  ['branchTaper', 'fork dimness', 0, 1, 0.05],
  ['the level ramp', null],
  ['crackle.ramp.perLevel', 'per level', 0, 0.6, 0.01],
  ['crackle.ramp.max', 'CEILING', 1, 5, 0.05],
  ['crackle.ramp.overdrive', 'share: overdrive', 0, 1, 0.05],
  ['crackle.ramp.bloom', 'share: bloom', 0, 1, 0.05],
  ['crackle.ramp.flash', 'share: ignition', 0, 1, 0.05],
  ['crackle.ramp.noise', 'share: jaggedness', 0, 1, 0.05],
  ['crackle.ramp.flicker', 'share: flicker', 0, 1, 0.05],
  ['crackle.ramp.branches', 'share: forks', 0, 1, 0.05],
  ['crackle.ramp.width', 'share: width', 0, 1, 0.05],
];

const DEFAULTS = JSON.parse(JSON.stringify(CONFIG.eel));

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
  o[ks[ks.length - 1]] = v;
}

let dirtyPreset = false;
const outputs = new Map();
function addRow(parent, label, min, max, step, read, write) {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  l.title = label;
  const r = document.createElement('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step;
  r.value = read();
  const o = document.createElement('output');
  const fmt = (v) => Number(v).toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0);
  o.textContent = fmt(r.value);
  r.addEventListener('input', () => {
    const v = Number(r.value);
    write(v);
    o.textContent = fmt(v);
  });
  row.append(l, r, o);
  parent.appendChild(row);
  return { r, o, fmt, read };
}

function buildSliders() {
  slidersEl.innerHTML = '';
  outputs.clear();
  const h = document.createElement('h2');
  h.textContent = 'test conditions';
  slidersEl.appendChild(h);
  for (const [key, label, min, max, step] of LAB_SLIDERS) {
    addRow(slidersEl, label, min, max, step, () => lab[key], (v) => { lab[key] = v; });
  }
  for (const [path, label, min, max, step] of CONFIG_SLIDERS) {
    if (!label) {
      const head = document.createElement('h2');
      head.textContent = path;
      slidersEl.appendChild(head);
      continue;
    }
    const ctl = addRow(slidersEl, label, min, max, step,
      () => getPath(CONFIG.eel, path) ?? 0,
      (v) => { setPath(CONFIG.eel, path, v); dirtyPreset = true; });
    outputs.set(path, ctl);
  }
}
function refreshSliders() {
  for (const [path, ctl] of outputs) {
    const v = getPath(CONFIG.eel, path) ?? 0;
    ctl.r.value = v;
    ctl.o.textContent = ctl.fmt(v);
  }
}

// The saved preset first, so the sliders open on the last session's numbers
// rather than on config.js and quietly discarding them on the first drag.
let presetNote = '';
try {
  const saved = await (await fetch('/preset/bolt-lab.json')).json();
  if (saved.eel) {
    for (const [path, label] of CONFIG_SLIDERS) {
      if (!label) continue;
      const v = getPath(saved.eel, path);
      if (typeof v === 'number') setPath(CONFIG.eel, path, v);
    }
    presetNote = 'preset loaded from tools/looks/bolt-lab.json';
  }
} catch { /* no server, or nothing saved yet — the normal first run */ }
buildSliders();

// --- the frame --------------------------------------------------------------
const gl = new THREE.WebGLRenderer({ canvas: stage, antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
gl.outputColorSpace = THREE.SRGBColorSpace;
const post = createPost(gl);

const scene = new THREE.Scene();
// The water, and it is authored brighter than it looks: the composite writes a
// linear value to an sRGB framebuffer, so every colour lands about a stop and a
// half darker than the hex says. Judging a bolt over the wrong ground is judging
// the wrong contrast — this is the one thing on the page that is not the effect
// and it still has to be right.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshBasicMaterial({ color: 0x0d3550 }),
);
water.position.z = -1;
scene.add(water);

const HALF_W = 19;
const cam = new THREE.OrthographicCamera(-HALF_W, HALF_W, 10, -10, 0.1, 100);
cam.position.set(0, 0, 20);
cam.lookAt(0, 0, 0);

// THE VIEWPORT, AND WHY IT IS NOT JUST window.innerWidth.
//
// The Browser pane reports an innerWidth/innerHeight of 0 while the tab is
// hidden or still laying out, and the frame height is `HALF_W * (h / w)` — 0/0
// is NaN, which lands in cam.top, which lands in the ladder's cell centres,
// which lands in a bolt built entirely out of NaN. It throws NOTHING: three logs
// a bounding-sphere warning per ribbon and draws an empty frame, the drawing
// buffer stays 0x0, and every saved shot is a zero-byte file. Falling through to
// the document and then to a sane frame is what keeps a hidden tab drawing a
// real picture; ensureSize below is what picks the true size up the moment the
// pane gets around to reporting one.
function viewport() {
  const w = window.innerWidth || document.documentElement?.clientWidth || 0;
  const h = window.innerHeight || document.documentElement?.clientHeight || 0;
  return { w: w > 1 ? w : 1280, h: h > 1 ? h : 720 };
}

function resize() {
  // FLOORED, and that is not defensive noise. The Browser pane reports an
  // innerWidth/innerHeight of 0 while the tab is hidden or still laying out, and
  // the frame height is `HALF_W * (h / w)` — 0/0 is NaN, which lands in cam.top,
  // which lands in the ladder's cell centres, which lands in a bolt built
  // entirely out of NaN. It throws nothing: three logs a bounding-sphere warning
  // per ribbon and draws an empty frame, and the drawing buffer stays 0x0 so
  // every saved shot is a zero-byte file.
  const { w, h } = viewport();
  gl.setSize(w, h, false);
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  const halfH = HALF_W * (h / w);
  cam.left = -HALF_W; cam.right = HALF_W; cam.top = halfH; cam.bottom = -halfH;
  cam.updateProjectionMatrix();
  post.resize();
}
window.addEventListener('resize', () => { resize(); placeLadderLabels(ladder); });

await preloadAssets();
// updateEel's fade pass is what animates every bolt on this page, and it runs
// updateCompanion before it gets there — so the companion has to exist even
// though it is hidden at level 0, which is the level the lab always passes.
scene.add(createEelCompanion());
resize();

// --- the bodies the chain hops through --------------------------------------
// Drawn as dim discs rather than left invisible: a bolt with nothing at its
// kinks reads as a squiggle, and half of what makes chain lightning legible is
// that every corner is ON something.
const markers = [];
function marker() {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(0.45, 16),
    new THREE.MeshBasicMaterial({ color: 0x14364d }),
  );
  m.position.z = 0.02;
  scene.add(m);
  markers.push(m);
  return m;
}
function showMarkers(points) {
  while (markers.length < points.length) marker();
  for (let i = 0; i < markers.length; i++) {
    markers[i].visible = i < points.length;
    if (i < points.length) markers[i].position.set(points[i].x, points[i].y, 0.02);
  }
}

// A chain across the frame: evenly spaced along X, scattered in Y. The first
// point is the eel, so it sits off to the left the way the companion does.
function chainPoints(hops, y = 0, width = 30) {
  const n = Math.max(1, Math.round(hops)) + 1;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) : 0;
    pts.push({
      x: -width / 2 + width * f,
      y: y + (i === 0 ? 0 : (Math.random() * 2 - 1) * lab.spread),
    });
  }
  return pts;
}

// --- the ladder -------------------------------------------------------------
// ONE BOLT PER LEVEL, all on the same frame, in a grid of cells.
//
// A GRID AND NOT EIGHT STACKED ROWS, which is what this was first. The bolt's
// displacement is a share of the HOP'S OWN LENGTH (see hopPoints), so a row
// spanning the frame thrashes several world units off its line — further than
// eight rows can be spaced apart in the same frame. Every bolt ate its
// neighbours and the ladder read as one solid mass, which is the exact opposite
// of what it is for. Short bolts in wide cells is the fix: the cell is sized so
// a maxed bolt's thrash still lands inside it.
const LADDER_COLS = 4;
const LADDER_ROWS = 2;
const LADDER_MAX = 8;
const labelBox = document.createElement('div');
labelBox.id = 'ladderLabels';
document.body.appendChild(labelBox);

// The panel is opaque and fixed to the left edge, so the first column of a grid
// laid out across the full frame is behind it — which cost the ladder two of its
// eight levels, the two it is most often read against.
const PANEL_PX = 336;
// viewport(), NOT window.innerWidth. The pane reports 0 there and this divides
// by it: at innerWidth 1 the panel is "12768 world units wide" and every ladder
// cell is placed a mile off the right of the frame. The screen goes black, the
// labels land in the right places anyway, and nothing anywhere says why.
function ladderLeft() {
  return -HALF_W + (PANEL_PX / viewport().w) * HALF_W * 2;
}

function ladderCell(i) {
  const col = i % LADDER_COLS;
  const row = Math.floor(i / LADDER_COLS);
  const halfH = cam.top;
  const left = ladderLeft();
  const cw = (HALF_W - left) / LADDER_COLS;
  const ch = (halfH * 2) / LADDER_ROWS;
  return {
    x: left + cw * (col + 0.5),
    y: halfH - ch * (row + 0.5),
    // Most of the cell's width, leaving the rest for the thrash. A shorter
    // bolt is not a smaller one — the widths are absolute world units and the
    // displacement is a share of the hop — so a cramped cell draws a blob
    // rather than a bolt, and the ladder would be comparing the wrong thing.
    len: cw * 0.8,
  };
}

function placeLadderLabels(on) {
  labelBox.innerHTML = '';
  labelBox.style.display = on ? '' : 'none';
  if (!on) return;
  const halfH = cam.top;
  for (let lv = 1; lv <= LADDER_MAX; lv++) {
    const c = ladderCell(lv - 1);
    const d = document.createElement('div');
    d.className = 'lvl';
    d.textContent = `level ${lv}`;
    const vp = viewport();
    d.style.left = `${((c.x + HALF_W) / (HALF_W * 2)) * vp.w}px`;
    d.style.top = `${((halfH - c.y) / (halfH * 2)) * vp.h + 34}px`;
    labelBox.appendChild(d);
  }
}

let ladder = false;
function fire() {
  if (ladder) {
    for (let lv = 1; lv <= LADDER_MAX; lv++) {
      const c = ladderCell(lv - 1);
      spawnChainBolt(scene, [
        { x: c.x - c.len / 2, y: c.y },
        { x: c.x + c.len / 2, y: c.y },
      ], 1, lv);
    }
    showMarkers([]);
    return;
  }
  const pts = chainPoints(lab.hops);
  showMarkers(pts);
  spawnChainBolt(scene, pts, 1, lab.level);
}

// --- readout ----------------------------------------------------------------
// The resolved numbers, so the ceiling is visible rather than trusted. Sampled
// at the level being fired AND at the top of the ladder, because the whole
// promise of the ramp block is "it grows and then it stops".
function readout() {
  const at = (lv) => {
    const fx = crackleCfg(eelCfg(), lv);
    return `L${lv}  gain ${fx.gain.toFixed(2)}  od ${fx.overdrive.toFixed(2)}`
      + `  bloom ${fx.bloom.toFixed(2)}  dip ${fx.flickerDepth.toFixed(2)}`
      + `  reshape ${fx.reseedHz.toFixed(0)}Hz  forks x${fx.branches.toFixed(2)}`;
  };
  valsEl.textContent = [at(1), at(Math.max(1, Math.round(lab.level))), at(8), at(99)].join('\n')
    + `\nstorm ${weatherState.intensity.toFixed(2)}   bolts ${window.__bolts ?? 0}`;
  noteEl.textContent = presetNote + (dirtyPreset ? '  ·  unsaved changes (W)' : '');
}

// --- controls ---------------------------------------------------------------
let auto = false;
let frozen = false;
let autoClock = 0;
b('bFire').addEventListener('click', fire);
b('bAuto').addEventListener('click', () => { auto = !auto; b('bAuto').classList.toggle('on', auto); });
b('bLadder').addEventListener('click', () => { ladder = !ladder; b('bLadder').classList.toggle('on', ladder); placeLadderLabels(ladder); fire(); });
b('bFreeze').addEventListener('click', () => { frozen = !frozen; b('bFreeze').classList.toggle('on', frozen); });
b('bSave').addEventListener('click', () => writePreset());
b('bReset').addEventListener('click', () => {
  // config.js as loaded — which INCLUDES imported-tuning.json, because that is
  // what the game actually runs. A "defaults" that reverted to the source
  // literals would be reverting to numbers no player has ever seen.
  Object.assign(CONFIG.eel, JSON.parse(JSON.stringify(DEFAULTS)));
  refreshSliders();
  dirtyPreset = false;
  presetNote = 'config.js as loaded (tuning included)';
});
window.addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); fire(); }
  if (e.key === 'a' || e.key === 'A') b('bAuto').click();
  if (e.key === 'l' || e.key === 'L') b('bLadder').click();
  if (e.key === 'f' || e.key === 'F') b('bFreeze').click();
  if (e.key === 'W') writePreset();
});

function preset() {
  const out = {};
  for (const [path, label] of CONFIG_SLIDERS) {
    if (!label) continue;
    setPath(out, path, getPath(CONFIG.eel, path));
  }
  return { eel: out, savedAt: new Date().toISOString() };
}
async function writePreset() {
  try {
    const r = await fetch('/preset/bolt-lab.json', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    presetNote = r.ok ? `saved tools/looks/bolt-lab.json ${new Date().toLocaleTimeString()}` : `save failed: ${r.status}`;
    dirtyPreset = !r.ok;
  } catch (err) {
    presetNote = `save failed: ${err.message}`;
  }
}

// --- the loop ---------------------------------------------------------------
const DT = 1 / 60;
function step(dt) {
  // The storm the sliders ask for, written straight in. The lab never runs the
  // weather schedule — a page where you cannot see the effect until the sky
  // agrees is a page nobody uses. `phase` matters: eelCfg only reads intensity,
  // but anything that gates on the phase should see a consistent pair.
  weatherState.intensity = lab.storm;
  weatherState.phase = lab.storm > 0 ? 'storm' : 'clear';

  if (auto) {
    autoClock += dt;
    const every = 1 / Math.max(0.05, lab.autoHz);
    if (autoClock >= every) { autoClock -= every; fire(); }
  }
  // Level 0 and an empty world: updateEel's own fade pass is all this page
  // wants from it, and that pass runs before any of the firing logic precisely
  // so a bolt lent to Voltaic still fades when the eel was never taken.
  updateEel(dt, scene, { x: -16, y: 0 }, 0, [], {});
}
function render() {
  post.render(scene, cam, DT);
}

// The pane can report its real size several frames after the module runs, and a
// window `resize` event is not always fired for it. Cheap enough to poll: two
// integer compares a frame.
let sizedW = 0;
let sizedH = 0;
function ensureSize() {
  const { w, h } = viewport();
  if (w === sizedW && h === sizedH) return;
  sizedW = w; sizedH = h;
  resize();
  placeLadderLabels(ladder);
}

let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  ensureSize();
  if (!frozen) step(dt);
  readout();
  render();
  requestAnimationFrame(tick);
}
fire();
requestAnimationFrame(tick);

// A frame off disk on demand, for reading without a live pane.
async function shoot(name) {
  // DRAW, THEN READ, in that order and with nothing between them. preserveDraw-
  // ingBuffer keeps the last frame around, but "the last frame" is whatever the
  // tick loop drew most recently — and the tick loop is still running here, so a
  // shot posted after a state change can catch the frame before it. Rendering
  // on the spot makes the file the picture the caller just asked for.
  render();
  const blob = await new Promise((res) => stage.toBlob(res, 'image/png'));
  await fetch(`/shot/${name}.png`, { method: 'POST', body: blob });
}
window.__shoot = shoot;
window.__fire = fire;
window.__set = (path, v) => { setPath(CONFIG.eel, path, v); refreshSliders(); dirtyPreset = true; };
window.__lab = lab;
window.__step = (n = 1) => { for (let i = 0; i < n; i++) step(DT); readout(); render(); };
window.__fx = (lv) => crackleCfg(eelCfg(), lv);
window.__ladder = () => { ladder = true; b('bLadder').classList.add('on'); placeLadderLabels(true); resetEelBolts(scene); fire(); };

// `?shots` posts a strip: the ladder, then one bolt a few frames into its life.
if (q.has('shots')) {
  // NOT UNTIL THE CANVAS HAS SETTLED ON A SIZE — see viewport(). Two ways this
  // goes wrong and neither says anything: a shot on the 0x0 buffer posts a
  // 102-byte PNG, and a shot taken across the resize that follows — the pane
  // reports its real size a few frames in — catches half-reallocated render
  // targets and posts a frame that is almost black.
  for (let i = 0; i < 120; i++) {
    ensureSize();
    if (stage.width >= 8 && sizedW === viewport().w && sizedH === viewport().h) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 150));
  ensureSize();
  frozen = true;
  window.__ladder();
  window.__step(3);
  await shoot('bolt-ladder');
  resetEelBolts(scene);
  ladder = false;
  lab.level = 8;
  fire();
  window.__step(2);
  await shoot('bolt-level8');
  noteEl.textContent = 'shots posted';
}
