// ---------------------------------------------------------------------------
// BALL LAB — the versus ball, live
//
//   npm run looks:ball      then open http://localhost:4716/tools/looks/ball-lab.html
//
// The ball is a soft body drawn through the goo pass (systems/versus.js), and
// what it does when a seal hits it depends on WHERE it is hit and HOW HARD:
// a square ram sends it down the dash's line, a glancing one sends it off the
// normal and spins it, a fast one dents it deeper and flatter. None of that
// can be judged in a match, where the hit is over in a frame and two seals
// are fighting for the rebound. This is the ball on its own, struck wherever
// the pointer says, with every number that shapes the answer in one column.
//
// WHY A PAGE AND NOT THE GAME. There is exactly one dev server in this project
// and it is the sole writer of path/src/imported-tuning.json; a second one is a
// second game quietly flattening real tuning work. This is a static BUILD of the
// shipped modules with no save path into the tuning file anywhere in it — `W`
// writes tools/looks/ball-lab.json, and "write to config.js" splices the
// numbers into the game through tools/apply-ball-lab.mjs, which clears the
// snapshot's copies rather than adding to them. See SERVERS.md.
//
// IT DRAWS THE SHIPPED BALL. stepBallAlone, strikeBallFrom and renderBall are
// the game's; the goo group is CONFIG.fx.goo.groups.ball through the game's
// own post chain; the sliders write CONFIG. If it reads right here it reads
// right in the match.
//
// THE POINTER IS THE SEAL. Press on (or near) the ball: that is the point of
// impact. Drag: that is the dash's line, and the drag's length is the wind-up
// (`drag = full power` below). Let go: strikeBallFrom moves a virtual seal
// onto the contact circle along that line and rams. A press with no drag is
// a square hit toward the centre at the panel's power.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { bounds, updateBounds, midWater } from '../../path/src/arena.js';
import { enableVersus } from '../../path/src/systems/versusFlag.js';
import { createPost } from '../../path/src/systems/post.js';
import { ballEvent, setBallDrive, updateBallLook, resetBallLook, teamColor } from '../../path/src/systems/ballLook.js';
import {
  initParticles, updateParticles, updateParticleScale,
} from '../../path/src/entities/particles.js';
import {
  ball, initBallAlone, stepBallAlone, strikeBallFrom, renderBall, resetBall, rimRadius, rimAngle, driveOutline,
} from '../../path/src/systems/versus.js';
import { ballSpinState } from '../../path/src/systems/ballSpin.js';

const q = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const slidersEl = document.getElementById('sliders');
const valsEl = document.getElementById('vals');
const noteEl = document.getElementById('note');
const b = (id) => document.getElementById(id);

// The pitch is the versus pitch: the flag is what arena.js reads its width off.
enableVersus(true);

// --- what the panel drives --------------------------------------------------
// LAB is the test bench — how the pointer becomes a strike, the view — and is
// not saved. CONFIG_SLIDERS is the ball, and every path is a real CONFIG key.
const lab = {
  view: 52,        // world units top to bottom in the frame
  power: 1,        // the wind-up behind a press with no drag, 0..1
  sealSpeed: 46,   // how fast the virtual seal arrives (the strike's dash speed)
  dragFull: 12,    // a drag this long (world units) is a full wind-up
  autoHz: 0.8,
  // ENGLISH on every strike the pointer makes, -1..1 — the two sticks'
  // disagreement, which the lab has no sticks to read. Positive is the swim
  // anticlockwise of the aim, which spins the ball clockwise.
  english: 0,
  spinNudge: 3,    // rad/s that [ and ] add to the spin directly
};
const LAB_SLIDERS = [
  ['view', 'view height', 30, 90, 1],
  ['power', 'press power', 0, 1, 0.05],
  ['sealSpeed', 'seal speed u/s', 5, 80, 1],
  ['dragFull', 'drag = full power', 3, 30, 0.5],
  ['autoHz', 'auto: per second', 0.1, 4, 0.1],
  ['english', 'english on strikes', -1, 1, 0.05],
  ['spinNudge', '[ ] spin nudge rad/s', 0.5, 10, 0.5],
];

// WHO HAS IT, in the lab. The match decides this from whoever last struck the
// ball; here it is a button, because the whole point of the lab is to see the
// possession colour without playing a match to earn it.
//
// Declared UP HERE rather than beside step(): the buttons that write it are
// bound near resize(), which runs first, and a `let` further down the file is
// in its temporal dead zone at that point — which fails as "cannot access
// before initialization" from a minified name that says nothing.
let labOwner = -1;

const CONFIG_SLIDERS = [
  ['the body', null],
  ['versus.ball.radius', 'radius', 1, 5, 0.05],
  ['versus.ball.maxSpeed', 'max speed', 20, 120, 1],
  ['versus.ball.drag', 'water drag /frame', 0.97, 1, 0.001],
  ['versus.ball.restitution', 'wall bounce', 0, 1.2, 0.02],
  ['versus.ball.contactRadius', 'seal contact radius', 0.5, 5, 0.1],
  ['heavy: mass, air, water', null],
  ['versus.ball.mass', 'mass (seals)', 0.2, 10, 0.1],
  ['versus.ball.air.gravityMul', 'air gravity x', 0, 5, 0.1],
  ['versus.ball.water.buoyancy', 'buoyancy u/s²', 0, 30, 0.5],
  ['versus.ball.water.buoyancyBelow', 'buoyant under u/s', 1, 40, 0.5],
  ['the strike', null],
  ['versus.ball.strikeImpulse', 'impulse @ 0 power', 0, 100, 1],
  ['versus.ball.strikeImpulseMax', 'impulse @ full', 0, 140, 1],
  ['versus.ball.keep', 'keeps own velocity', 0, 1, 0.02],
  ['versus.ball.carry', 'carries seal speed', 0, 1.5, 0.02],
  ['versus.ball.bumpGain', 'swim bump gain', 0, 3, 0.05],
  ['impact: where and how hard', null],
  ['versus.ball.impact.grip', 'grip (0 = frictionless)', 0, 1, 0.02],
  ['versus.ball.impact.speedRef', 'hard hit = u/s', 5, 80, 1],
  ['versus.ball.impact.dentBySpeed', 'deeper by speed', 0, 2, 0.05],
  ['versus.ball.impact.narrowBySpeed', 'narrower by speed', 0, 2, 0.05],
  ['versus.ball.impact.squash', 'whole-body squash', 0, 1, 0.02],
  ['versus.ball.impact.recoil', 'striker recoil', 0, 1.5, 0.02],
  ['versus.ball.impact.recoilMax', 'recoil cap u/s', 0, 80, 1],
  // SPIN IS FRICTION — the slip at the contact, Coulomb-capped, split
  // between spin and a sideways kick. See CONFIG.versus.ball.impact.
  ['spin: friction and the curve', null],
  ['versus.ball.impact.friction', 'contact friction μ', 0, 1.5, 0.02],
  ['versus.ball.impact.squirt', 'squirt (kick share)', 0, 1, 0.02],
  ['versus.ball.impact.spinMax', 'spin cap rad/s', 2, 40, 0.5],
  ['versus.ball.impact.spinDecay', 'spin decay /s (water)', 0, 4, 0.05],
  ['versus.ball.impact.spinDecayAir', 'spin decay /s (air)', 0, 2, 0.02],
  ['versus.ball.impact.magnus', 'curve (magnus, water)', 0, 0.2, 0.001],
  ['versus.ball.impact.magnusAir', 'curve in air, share', 0, 1, 0.01],
  ['versus.ball.impact.wallFriction', 'wall friction μ', 0, 1.5, 0.02],
  ['english', null],
  ['versus.ball.english.deadzone', 'sticks must disagree by', 0, 0.9, 0.02],
  ['versus.ball.english.sweep', 'sweep u/s at full', 0, 80, 1],
  ['spin streaks', null],
  ['versus.ball.spinStrokes.count', 'strokes', 1, 6, 1],
  ['versus.ball.spinStrokes.spinMin', 'show above rad/s', 0.5, 10, 0.25],
  ['versus.ball.spinStrokes.spinFull', 'full length at rad/s', 2, 30, 0.5],
  ['versus.ball.spinStrokes.arcMin', 'arc at least (rad)', 0.05, 1.5, 0.05],
  ['versus.ball.spinStrokes.arcMax', 'arc at most (rad)', 0.2, 4, 0.05],
  ['versus.ball.spinStrokes.travel', 'travel x rim speed', 0, 4, 0.05],
  ['versus.ball.spinStrokes.hug', 'hug (x radius)', 0.9, 1.8, 0.01],
  ['versus.ball.spinStrokes.lift', 'lift per stroke (x r)', 0, 0.5, 0.01],
  ['versus.ball.spinStrokes.width', 'band width', 0.05, 2, 0.01],
  ['versus.ball.spinStrokes.flare', 'tail flare (x r)', 0, 1, 0.01],
  ['versus.ball.spinStrokes.head', 'head taper share', 0.02, 0.9, 0.02],
  ['versus.ball.spinStrokes.tail', 'tail taper share', 0.02, 0.9, 0.02],
  ['versus.ball.spinStrokes.trimRate', 'trim chase /s', 0.5, 20, 0.5],
  ['versus.ball.spinStrokes.fadeIn', 'fade in s', 0.02, 1, 0.02],
  ['versus.ball.spinStrokes.fadeOut', 'fade out s', 0.02, 1.5, 0.02],
  ['versus.ball.spinStrokes.color', 'stroke colour', 'color'],
  ['versus.ball.spinStrokes.glow', 'stroke glow', 0, 4, 0.05],
  ['the soft body', null],
  ['versus.ball.soft.spring', 'spring', 5, 400, 1],
  ['versus.ball.soft.damping', 'damping', 0, 20, 0.1],
  ['versus.ball.soft.couple', 'ripple coupling', 0, 2000, 10],
  ['versus.ball.soft.dentDepth', 'dent depth', 0, 1, 0.02],
  ['versus.ball.soft.dentWidth', 'dent width rad', 0.1, 2.5, 0.05],
  ['versus.ball.soft.wallDent', 'wall dent', 0, 1, 0.02],
  ['versus.ball.soft.stretch', 'stretch by speed', 0, 0.6, 0.01],
  ['versus.ball.soft.maxDeform', 'max deform', 0.1, 0.9, 0.01],
  ['the look (splats)', null],
  ['versus.ball.look.color', 'colour', 'color'],
  ['versus.ball.look.glow', 'glow', 0, 4, 0.05],
  ['versus.ball.look.rimSize', 'rim splat size', 0.1, 2, 0.02],
  ['versus.ball.look.innerSize', 'inner splat size', 0.1, 2.5, 0.02],
  ['versus.ball.look.coreSize', 'core splat size', 0.1, 3, 0.02],
  ['versus.ball.look.innerAt', 'inner ring at', 0, 1, 0.02],
  ['versus.ball.look.inset', 'rim ring at', 0.3, 1.2, 0.01],
  ['the surface (goo group)', null],
  ['fx.goo.groups.ball.radius', 'splat radius', 1, 8, 0.1],
  ['fx.goo.groups.ball.iso', 'iso', 0.05, 1.5, 0.01],
  ['fx.goo.groups.ball.soft', 'edge softness', 0.01, 0.8, 0.01],
  ['fx.goo.groups.ball.opacity', 'opacity', 0, 1, 0.02],
  ['fx.goo.groups.ball.rim', 'rim (− = outline)', -1.5, 2, 0.05],
  ['fx.goo.groups.ball.rimWidth', 'rim width', 0.02, 0.8, 0.01],
  ['fx.goo.groups.ball.spec', 'specular', 0, 2, 0.05],
  ['fx.goo.groups.ball.specPower', 'spec power', 2, 80, 1],
  ['fx.goo.groups.ball.normal', 'normal strength', 0, 12, 0.1],

  // THE WARP — one noise layer folding through itself. `amount` is the RESTING
  // value: while a match runs, systems/ballLook.js overwrites it every frame
  // from speed, charge and the bounce/goal/reset pulses, so what you set here
  // is the floor those build on rather than the number you see in play. The
  // other three are the character of the noise and nothing drives them.
  ['the warp', null],
  ['fx.goo.groups.ball.warp.amount', 'warp at rest (texels)', 0, 12, 0.1],
  ['fx.goo.groups.ball.warp.scale', 'noise cells across', 1, 24, 0.5],
  ['fx.goo.groups.ball.warp.speed', 'drift speed', 0, 2, 0.02],
  ['fx.goo.groups.ball.warp.feed', 'feedback (0 = plain wobble)', 0, 3, 0.05],

  // HOW THE MATCH DRIVES IT. These are the curve, not the look — turn them all
  // down and the ball sits at the resting warp above however hard it is hit.
  ['what drives the warp', null],
  ['versus.ball.look.warpGain', 'texels per unit of drive', 0, 20, 0.1],
  ['versus.ball.look.bySpeed', 'share that is ball speed', 0, 1, 0.02],
  ['versus.ball.look.byCharge', 'share that is seal charge', 0, 1, 0.02],
  ['versus.ball.look.pulseDecay', 'pulse decay /s', 0.2, 8, 0.1],
  ['versus.ball.look.pulseMax', 'pulse ceiling', 0, 6, 0.1],
  ['versus.ball.look.pulses.bounce', 'kick: bounce', 0, 2, 0.05],
  ['versus.ball.look.pulses.goal', 'kick: goal', 0, 4, 0.05],
  ['versus.ball.look.pulses.reset', 'kick: reset', 0, 4, 0.05],

  // THE OUTLINE — a drawn line inside the surface with a BOIL: a noise field
  // that re-seeds boilHz times a second instead of drifting. boilAmp/boilHz
  // here are the rest; the block after is how the match drives them.
  ['the outline', null],
  ['fx.goo.groups.ball.outline.strength', 'outline', 0, 1, 0.02],
  ['fx.goo.groups.ball.outline.width', 'width (texels)', 0, 12, 0.25],
  ['fx.goo.groups.ball.outline.soft', 'feather (texels)', 0.1, 6, 0.1],
  ['fx.goo.groups.ball.outline.color', 'line colour', 'color'],
  ['fx.goo.groups.ball.outline.boilAmp', 'boil at rest (texels)', 0, 8, 0.1],
  ['fx.goo.groups.ball.outline.boilHz', 'boil at rest (Hz)', 0, 30, 0.5],
  ['fx.goo.groups.ball.outline.boilScale', 'boil cells across', 1, 60, 0.5],
  ['fx.goo.groups.ball.outline.boilEdge', 'silhouette boils too', 0, 1.5, 0.05],
  ['what drives the boil', null],
  ['versus.ball.outline.ampRest', 'amp rest', 0, 8, 0.1],
  ['versus.ball.outline.ampByPulse', 'amp by impact', 0, 12, 0.1],
  ['versus.ball.outline.ampBySpeed', 'amp by speed', 0, 8, 0.1],
  ['versus.ball.outline.ampBySpin', 'amp by spin', 0, 8, 0.1],
  ['versus.ball.outline.ampByCharge', 'amp by charge', 0, 8, 0.1],
  ['versus.ball.outline.ampMax', 'amp ceiling', 0, 16, 0.5],
  ['versus.ball.outline.hzRest', 'Hz rest', 0, 30, 0.5],
  ['versus.ball.outline.hzByPulse', 'Hz by impact', 0, 30, 0.5],
  ['versus.ball.outline.hzBySpeed', 'Hz by speed', 0, 30, 0.5],
  ['versus.ball.outline.hzMax', 'Hz ceiling', 1, 60, 1],

  // POSSESSION. The colour comes from CONFIG.versus.teams — green vs red — and
  // is not tunable here on purpose: it is the team's identity across the goal,
  // the posts and the HUD, not a per-ball look. How far the goo is pulled
  // toward it, and how fast, are.
  ['possession', null],
  ['versus.ball.look.tintMax', 'how far toward the team colour', 0, 1, 0.02],
  ['versus.ball.look.tintRate', 'how fast it changes hands /s', 0.5, 20, 0.5],

  ['the pitch', null],
  ['versus.widthScale', 'pitch width x frame', 1, 3, 0.05],
];

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
  o[ks[ks.length - 1]] = v;
}
const DEFAULTS = {};
for (const [path, label] of CONFIG_SLIDERS) if (label) DEFAULTS[path] = getPath(CONFIG, path);

const hex = (n) => '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');

let dirtyPreset = false;
const outputs = new Map();
function addRow(parent, label, min, max, step, read, write) {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  l.title = label;
  if (min === 'color') {
    const c = document.createElement('input');
    c.type = 'color';
    c.value = hex(read());
    const o = document.createElement('output');
    o.textContent = c.value;
    c.addEventListener('input', () => { write(parseInt(c.value.slice(1), 16)); o.textContent = c.value; });
    row.append(l, c, o);
    parent.appendChild(row);
    return { r: c, o, fmt: (v) => hex(v), read, color: true };
  }
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

function onConfigChange(path) {
  dirtyPreset = true;
  // Through resize(), not updateBounds directly: the wall override lives there
  // and calling updateBounds alone would put the collider back on the pitch.
  if (path === 'versus.widthScale') resize();
}

function buildSliders() {
  slidersEl.innerHTML = '';
  outputs.clear();
  const h = document.createElement('h2');
  h.textContent = 'test bench';
  slidersEl.appendChild(h);
  for (const [key, label, min, max, step] of LAB_SLIDERS) {
    addRow(slidersEl, label, min, max, step, () => lab[key], (v) => { lab[key] = v; if (key === 'view') resize(); });
  }
  for (const [path, label, min, max, step] of CONFIG_SLIDERS) {
    if (!label) {
      const head = document.createElement('h2');
      head.textContent = path;
      slidersEl.appendChild(head);
      continue;
    }
    const ctl = addRow(slidersEl, label, min, max, step,
      () => getPath(CONFIG, path) ?? 0,
      (v) => { setPath(CONFIG, path, v); onConfigChange(path); });
    outputs.set(path, ctl);
  }
}
function refreshSliders() {
  for (const [path, ctl] of outputs) {
    const v = getPath(CONFIG, path) ?? 0;
    ctl.r.value = ctl.color ? hex(v) : v;
    ctl.o.textContent = ctl.fmt(v);
  }
}

// The saved preset first, so the sliders open on the last session's numbers
// rather than on config.js and quietly discarding them on the first drag.
let presetNote = '';
try {
  const saved = await (await fetch('/preset/ball-lab.json')).json();
  let n = 0;
  for (const [path, label] of CONFIG_SLIDERS) {
    if (!label) continue;
    const v = saved[path];
    if (typeof v === 'number') { setPath(CONFIG, path, v); n++; }
  }
  if (n) presetNote = `preset loaded from tools/looks/ball-lab.json (${n} values)`;
} catch { /* no server, or nothing saved yet — the normal first run */ }
buildSliders();

// --- the frame --------------------------------------------------------------
const gl = new THREE.WebGLRenderer({ canvas: stage, antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
gl.outputColorSpace = THREE.SRGBColorSpace;
const post = createPost(gl);

const scene = new THREE.Scene();
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshBasicMaterial({ color: 0x0d3550 }),
);
water.position.z = -5;
scene.add(water);
// The air above the surface, so the ball's gravity above y=0 reads as leaving the water.
const sky = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 300),
  new THREE.MeshBasicMaterial({ color: 0x1a2a3c }),
);
sky.position.set(0, 150, -4);
scene.add(sky);

// The pitch: its walls, floor and ceiling as a line, rebuilt when the width changes.
let pitchLine = null;
function layoutPitch() {
  if (pitchLine) scene.remove(pitchLine);
  const pts = [
    new THREE.Vector3(bounds.left, bounds.bottom, 0), new THREE.Vector3(bounds.right, bounds.bottom, 0),
    new THREE.Vector3(bounds.right, bounds.top, 0), new THREE.Vector3(bounds.left, bounds.top, 0),
    new THREE.Vector3(bounds.left, bounds.bottom, 0),
  ];
  pitchLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x5ec8ff, transparent: true, opacity: 0.5 }));
  pitchLine.position.z = -1;
  scene.add(pitchLine);
}

const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
cam.position.set(0, 0, 20);
cam.lookAt(0, 0, 0);

// See bolt-lab.js for why this is not window.innerWidth: the pane reports 0
// while hidden and the frame is built out of NaN.
function viewport() {
  const w = window.innerWidth || document.documentElement?.clientWidth || 0;
  const h = window.innerHeight || document.documentElement?.clientHeight || 0;
  return { w: w > 1 ? w : 1280, h: h > 1 ? h : 720 };
}

function resize() {
  const { w, h } = viewport();
  gl.setSize(w, h, false);
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  updateBounds(w / h);
  const halfH = lab.view / 2;
  const halfW = halfH * (w / h);
  const cx = (bounds.left + bounds.right) / 2;
  const cy = bounds.bottom + (CONFIG.arena.viewHeight ?? 52) / 2;
  cam.left = cx - halfW; cam.right = cx + halfW; cam.top = cy + halfH; cam.bottom = cy - halfH;
  cam.updateProjectionMatrix();

  // THE WALLS ARE THE WINDOW, in the lab and only in the lab.
  //
  // The real pitch is `versus.widthScale` frames wide and the camera pans
  // across it, so a ball driven hard leaves the view and keeps bouncing off
  // walls nobody can see — which in a test bench is just the ball vanishing.
  // Here the collider is overwritten with the camera's own rect AFTER the
  // frustum is set, so every edge you can see is a wall and nothing can get
  // out. The pitch outline drawn below then traces the window exactly, which
  // is the honest picture of what the ball is actually hitting.
  //
  // This does not touch the game: `bounds` is arena.js's live object and the
  // match sets it from the real pitch every frame it runs.
  bounds.left = cam.left;
  bounds.right = cam.right;
  bounds.bottom = cam.bottom;
  bounds.top = cam.top;
  layoutPitch();
  post.resize();
  updateParticleScale(cam, gl);
}
// --- possession and the goal pulse, for testing the colour -------------------
// The match sets the owner from whoever last struck the ball and fires the goal
// pulse from the shutter. Neither happens here, so both are buttons — and they
// call the SAME functions systems/ballLook.js exposes to versus.js, so what you
// tune against is the shipping curve rather than a lab approximation.
const setOwner = (i) => {
  labOwner = i;
  for (const [id, want] of [['bOwnNone', -1], ['bOwn0', 0], ['bOwn1', 1]]) {
    document.getElementById(id)?.classList.toggle('on', labOwner === want);
  }
  if (i < 0) resetBallLook();
};
document.getElementById('bOwnNone')?.addEventListener('click', () => setOwner(-1));
document.getElementById('bOwn0')?.addEventListener('click', () => setOwner(0));
document.getElementById('bOwn1')?.addEventListener('click', () => setOwner(1));
document.getElementById('bGoal')?.addEventListener('click', () => ballEvent('goal'));
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === '0') setOwner(-1);
  if (e.key === '1') setOwner(0);
  if (e.key === '2') setOwner(1);
  if (e.key.toLowerCase() === 'g') ballEvent('goal');
});
setOwner(-1);

window.addEventListener('resize', resize);

initParticles(scene);
resize();
initBallAlone();

// --- the path trace ----------------------------------------------------------
// Where the ball has been, as a thin line: the curve a spin puts on a flight
// is a shape, and the shape is what a still frame of the ball cannot show.
let trace = q.has('trace');
const TRACE_N = 360;
const traceGeo = new THREE.BufferGeometry();
traceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACE_N * 3), 3));
const traceLine = new THREE.Line(traceGeo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.55 }));
traceLine.position.z = 1.4;
traceLine.frustumCulled = false;
scene.add(traceLine);
const tracePts = [];
function traceStep() {
  const l = tracePts[tracePts.length - 1];
  if (l && Math.hypot(l.x - ball.x, l.y - ball.y) < 0.15) return;
  tracePts.push({ x: ball.x, y: ball.y });
  if (tracePts.length > TRACE_N) tracePts.shift();
}
function clearTrace() { tracePts.length = 0; }
function updateTrace() {
  traceLine.visible = trace && tracePts.length > 1;
  if (!traceLine.visible) return;
  const pos = traceGeo.attributes.position;
  for (let i = 0; i < tracePts.length; i++) pos.setXYZ(i, tracePts[i].x, tracePts[i].y, 0);
  traceGeo.setDrawRange(0, tracePts.length);
  pos.needsUpdate = true;
}

// --- the rim overlay ----------------------------------------------------------
// The soft body drawn as a thin line, so the physics can be judged apart from
// the goo that dresses it. Plus the contact circle the seal rams against.
let overlay = q.has('overlay');
const rimGeo = new THREE.BufferGeometry();
const rimPts = new Float32Array((64 + 1) * 3);
rimGeo.setAttribute('position', new THREE.BufferAttribute(rimPts, 3));
const rimLine = new THREE.Line(rimGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
rimLine.position.z = 2;
scene.add(rimLine);
const contactRing = new THREE.Mesh(new THREE.RingGeometry(0.98, 1, 48), new THREE.MeshBasicMaterial({ color: 0xff8a5e, transparent: true, opacity: 0.6 }));
contactRing.position.z = 2;
scene.add(contactRing);
function updateOverlay() {
  rimLine.visible = overlay;
  contactRing.visible = overlay;
  if (!overlay) return;
  const n = ball.rim.length;
  const pos = rimGeo.attributes.position;
  for (let i = 0; i <= n; i++) {
    const j = i % n;
    const a = rimAngle(j);
    const r = rimRadius(j);
    pos.setXYZ(i, ball.x + Math.cos(a) * r, ball.y + Math.sin(a) * r, 0);
  }
  rimGeo.setDrawRange(0, n + 1);
  pos.needsUpdate = true;
  const cr = ball.r + (CONFIG.versus.ball.contactRadius ?? 2.2);
  contactRing.position.x = ball.x;
  contactRing.position.y = ball.y;
  contactRing.scale.setScalar(cr);
}

// --- the striker's marks ------------------------------------------------------
// Where the last seal was, and the line it came in on, fading.
const sealMark = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ color: 0x5ec8ff, transparent: true, opacity: 0 }));
sealMark.position.z = 1.5;
scene.add(sealMark);
const dragGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const dragLine = new THREE.Line(dragGeo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0 }));
dragLine.position.z = 1.6;
scene.add(dragLine);
let markFade = 0;

// --- the pointer is the seal --------------------------------------------------
function toWorld(ev) {
  const rect = stage.getBoundingClientRect();
  const u = (ev.clientX - rect.left) / Math.max(1, rect.width);
  const v = (ev.clientY - rect.top) / Math.max(1, rect.height);
  return { x: cam.left + (cam.right - cam.left) * u, y: cam.top - (cam.top - cam.bottom) * v };
}
let press = null;
let last = null;
stage.addEventListener('pointerdown', (ev) => {
  press = toWorld(ev);
  last = press;
  stage.setPointerCapture(ev.pointerId);
});
stage.addEventListener('pointermove', (ev) => {
  if (!press) return;
  last = toWorld(ev);
  dragGeo.setFromPoints([new THREE.Vector3(press.x, press.y, 0), new THREE.Vector3(last.x, last.y, 0)]);
  dragLine.material.opacity = 0.9;
});
stage.addEventListener('pointerup', (ev) => {
  if (!press) return;
  const up = toWorld(ev);
  let dx = up.x - press.x;
  let dy = up.y - press.y;
  const len = Math.hypot(dx, dy);
  let power = lab.power;
  if (len < 0.4) {
    // A press: square at the centre.
    dx = ball.x - press.x; dy = ball.y - press.y;
  } else {
    power = Math.min(1, len / lab.dragFull);
  }
  strikeAt(press, { x: dx, y: dy }, power);
  press = null;
  dragLine.material.opacity = 0;
});

let lastStrike = null;
function strikeAt(at, dir, power, english = lab.english) {
  const before = { spin: ball.spin };
  const hit = strikeBallFrom(at, dir, lab.sealSpeed, power, english);
  lastStrike = { at, dir, power, hit, dSpin: ball.spin - before.spin, t: 0 };
  sealMark.position.x = at.x;
  sealMark.position.y = at.y;
  sealMark.scale.setScalar(CONFIG.versus.ball.contactRadius ?? 2.2);
  markFade = 1;
  window.__strikes = (window.__strikes ?? 0) + 1;
  // The match fires this from strikeBall with the striking seal's index. Here
  // the buttons decide who is striking, so the colour follows the same path.
  ballEvent('bounce', { force: power, team: labOwner });
}

// A strike from a random point on the ball, in toward it with a random glance.
function randomStrike() {
  const a = Math.random() * Math.PI * 2;
  const R = ball.r + (CONFIG.versus.ball.contactRadius ?? 2.2) + 2;
  const at = { x: ball.x + Math.cos(a) * R, y: ball.y + Math.sin(a) * R };
  const glance = (Math.random() * 2 - 1) * 0.9;
  const dir = { x: Math.cos(a + Math.PI + glance), y: Math.sin(a + Math.PI + glance) };
  strikeAt(at, dir, 0.3 + Math.random() * 0.7);
}
function throwBall() {
  const a = Math.random() * Math.PI * 2;
  const s = 20 + Math.random() * 40;
  ball.vx = Math.cos(a) * s;
  ball.vy = Math.sin(a) * s;
}

// --- readout ----------------------------------------------------------------
function readout() {
  let worst = 0;
  for (let i = 0; i < ball.rim.length; i++) worst = Math.max(worst, Math.abs(ball.rim[i]));
  const ss = ballSpinState();
  const lines = [
    `speed ${Math.hypot(ball.vx, ball.vy).toFixed(1)}   spin ${ball.spin.toFixed(2)} rad/s ${ball.spin > 0.01 ? '↺' : ball.spin < -0.01 ? '↻' : ''}   deform ${(worst / ball.r * 100).toFixed(0)}%`,
    `at ${ball.x.toFixed(1)}, ${ball.y.toFixed(1)}   ${ball.y > 0 ? 'AIR' : 'water'}   colour ${hex(CONFIG.versus.ball.look.color)}   strokes ${ss.streaks.length}${ss.streaks.length ? ` arc ${(ss.streaks[0].arc).toFixed(2)} rad` : ''}`,
  ];
  if (lastStrike?.hit) {
    const h = lastStrike.hit;
    lines.push(`last strike: power ${lastStrike.power.toFixed(2)}  impulse ${h.imp?.toFixed(1)}  glance ${h.off?.toFixed(2)}  english ${(h.english ?? 0).toFixed(2)}  slip ${(h.slip ?? 0).toFixed(1)}  +spin ${lastStrike.dSpin.toFixed(2)}`);
    if (h.dent) lines.push(`  dent ${(h.dent.depth * 100).toFixed(0)}% deep, ${h.dent.width.toFixed(2)} rad wide, hardness ${h.dent.hard.toFixed(2)}`);
  } else if (lastStrike) {
    lines.push('last strike: MISSED (press nearer the ball)');
  }
  valsEl.textContent = lines.join('\n');
  noteEl.textContent = presetNote + (dirtyPreset ? '  ·  unsaved changes (W)' : '');
}

// --- controls ---------------------------------------------------------------
let auto = false;
let frozen = false;
let autoClock = 0;
b('bStrike').addEventListener('click', randomStrike);
b('bThrow').addEventListener('click', throwBall);
b('bAuto').addEventListener('click', () => { auto = !auto; b('bAuto').classList.toggle('on', auto); });
b('bFreeze').addEventListener('click', () => { frozen = !frozen; b('bFreeze').classList.toggle('on', frozen); });
b('bReset').addEventListener('click', () => resetBall());
b('bOverlay').addEventListener('click', () => { overlay = !overlay; b('bOverlay').classList.toggle('on', overlay); });
b('bOverlay').classList.toggle('on', overlay);
b('bSave').addEventListener('click', () => writePreset());
b('bApply').addEventListener('click', () => applyToConfig());
b('bDefaults').addEventListener('click', () => {
  // config.js as loaded — which INCLUDES imported-tuning.json, because that is
  // what the game actually runs.
  for (const [path, v] of Object.entries(DEFAULTS)) setPath(CONFIG, path, v);
  refreshSliders();
  updateBounds(viewport().w / viewport().h);
  layoutPitch();
  dirtyPreset = false;
  presetNote = 'config.js as loaded (tuning included)';
});
window.addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); randomStrike(); }
  if (e.key === 't' || e.key === 'T') throwBall();
  if (e.key === 'a' || e.key === 'A') b('bAuto').click();
  if (e.key === 'f' || e.key === 'F') b('bFreeze').click();
  if (e.key === 'r' || e.key === 'R') resetBall();
  if (e.key === 'o' || e.key === 'O') b('bOverlay').click();
  if (e.key === 'W') writePreset();
  if (e.key === '[') ball.spin -= lab.spinNudge;
  if (e.key === ']') ball.spin += lab.spinNudge;
  if (e.key === 'p' || e.key === 'P') { trace = !trace; if (trace) clearTrace(); }
  if (e.key === 'c' || e.key === 'C') clearTrace();
});

function preset() {
  const out = {};
  for (const [path, label] of CONFIG_SLIDERS) {
    if (!label) continue;
    out[path] = getPath(CONFIG, path);
  }
  out.savedAt = new Date().toISOString();
  return out;
}
async function writePreset() {
  try {
    const r = await fetch('/preset/ball-lab.json', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    presetNote = r.ok ? `saved tools/looks/ball-lab.json ${new Date().toLocaleTimeString()}` : `save failed: ${r.status}`;
    dirtyPreset = !r.ok;
  } catch (err) {
    presetNote = `save failed: ${err.message}`;
  }
}
async function applyToConfig() {
  try {
    const r = await fetch('/apply/ball-lab', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    const report = await r.json();
    if (report.error) { presetNote = `apply failed: ${report.error}`; return; }
    const changed = report.changes?.length ?? 0;
    const cleared = report.cleared?.length ?? 0;
    presetNote = (report.wrote ? `wrote config.js: ${changed} value(s)` : 'config.js already matches')
      + (cleared ? `, cleared ${cleared} shadowing tuning value(s)` : '')
      + '\n' + (report.notes ?? []).filter((n) => n.startsWith('!') || n.startsWith('?')).join('\n');
    dirtyPreset = false;
  } catch (err) {
    presetNote = `apply failed: ${err.message}`;
  }
}

// --- the loop ---------------------------------------------------------------
const DT = 1 / 60;
function step(dt) {
  // The same two calls the match makes, so the lab drives the SHIPPING state
  // machine rather than an impression of it. speedRef matches versus.js.
  const ref = Math.max(1, CONFIG.versus?.impact?.speedRef ?? 30);
  setBallDrive({
    speed01: Math.hypot(ball.vx, ball.vy) / ref,
    charge01: lab.pressPower ?? 0,
    owner: labOwner >= 0 ? labOwner : null,
  });
  // WALL CLOCK in the match; here dt already is one.
  updateBallLook(dt);
  driveOutline();
  if (auto) {
    autoClock += dt;
    const every = 1 / Math.max(0.05, lab.autoHz);
    if (autoClock >= every) { autoClock -= every; randomStrike(); }
  }
  stepBallAlone(dt);
  if (trace) traceStep();
  updateParticles(dt);
  if (markFade > 0) {
    markFade = Math.max(0, markFade - dt * 1.5);
    sealMark.material.opacity = markFade * 0.5;
  }
  if (lastStrike) lastStrike.t += dt;
}
function render() {
  updateOverlay();
  updateTrace();
  renderBall();
  post.render(scene, cam, DT);
}

let sizedW = 0;
let sizedH = 0;
function ensureSize() {
  const { w, h } = viewport();
  if (w === sizedW && h === sizedH) return;
  sizedW = w; sizedH = h;
  resize();
}

let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  ensureSize();
  if (!frozen) step(dt);
  readout();
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// A frame off disk on demand, for reading without a live pane.
async function shoot(name) {
  render();
  const blob = await new Promise((res) => stage.toBlob(res, 'image/png'));
  await fetch(`/shot/${name}.png`, { method: 'POST', body: blob });
}
window.__shoot = shoot;
window.__strike = strikeAt;
window.__random = randomStrike;
window.__ball = ball;
window.__set = (path, v) => { setPath(CONFIG, path, v); refreshSliders(); onConfigChange(path); };
window.__lab = lab;
window.__step = (n = 1) => { for (let i = 0; i < n; i++) step(DT); readout(); render(); };
window.__preset = preset;
window.__trace = (on = true) => { trace = on; clearTrace(); };
window.__spinState = ballSpinState;

// `?shots` posts a strip: the ball at rest, then a glancing strike a few frames in.
if (q.has('shots')) {
  for (let i = 0; i < 120; i++) {
    ensureSize();
    if (stage.width >= 8 && sizedW === viewport().w && sizedH === viewport().h) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 150));
  ensureSize();
  frozen = true;
  resetBall();
  window.__step(2);
  await shoot('ball-rest');
  strikeAt({ x: ball.x - ball.r - 3, y: ball.y + 1.5 }, { x: 1, y: 0.35 }, 1);
  window.__step(3);
  await shoot('ball-struck');
  window.__step(12);
  await shoot('ball-ripple');

  // THE SPIN. A ball turning hard each way, the strokes fully out, then a
  // struck ball with english on it, its path traced so the curve shows.
  resetBall();
  ball.spin = 12;
  window.__step(30);
  await shoot('ball-spin-ccw');
  resetBall();
  ball.spin = -12;
  window.__step(30);
  await shoot('ball-spin-cw');
  resetBall();
  ball.spin = 4;
  window.__step(30);
  await shoot('ball-spin-light');
  // The curve: square hit from the left, full power, english all the way.
  resetBall();
  ball.x = bounds.left + ball.r + 6;
  trace = true; clearTrace();
  strikeAt({ x: ball.x - ball.r - 3, y: ball.y }, { x: 1, y: 0 }, 1, 1);
  window.__step(48);
  await shoot('ball-english-curve');
  resetBall();
  ball.x = bounds.left + ball.r + 6;
  clearTrace();
  strikeAt({ x: ball.x - ball.r - 3, y: ball.y }, { x: 1, y: 0 }, 1, -1);
  window.__step(48);
  await shoot('ball-english-curve-reverse');
  resetBall();
  ball.x = bounds.left + ball.r + 6;
  clearTrace();
  strikeAt({ x: ball.x - ball.r - 3, y: ball.y }, { x: 1, y: 0 }, 1, 0);
  window.__step(48);
  await shoot('ball-english-none');
  trace = false;
  noteEl.textContent = 'shots posted';
}
