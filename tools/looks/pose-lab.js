// ---------------------------------------------------------------------------
// THE POSE LAB — every canned animation the seal has, from three sides, with
// the bubbles it throws.
//
//   npm run looks:poselab        then open the URL it prints —
//   http://localhost:4740/tools/looks/pose-lab.html
//
// The real seal, the real swim clip, the real aim rig and the REAL drivers:
// systems/celebrate.js poses the five victory shapes and the salute,
// systems/clap.js poses the button, systems/poseBubbles.js emits off the same
// anchors the breath and the wake use, and entities/particles.js draws them.
// Nothing here reimplements a pose — if it looks wrong on this page it is
// wrong in the game.
//
// WHY THREE VIEWS. The seal is seen in profile: it swims in the world XY plane
// with the camera down Z, so the flippers spread along the CAMERA AXIS. That
// is the one fact that shapes every pose in this project (see the header of
// systems/celebrate.js) and it is the one thing the side view cannot show —
// two flippers a body-width apart in depth project to nearly the same place on
// screen. So "does the flipper actually reach the brow" and "do the hands
// actually meet" are questions only the front and top views can answer, and
// they are exactly the questions a salute and a clap are made of.
//
// WHAT IT WRITES. Every slider writes CONFIG in memory. This is a vite build
// behind a read-only static server, so nothing here can reach
// imported-tuning.json — the game's dev server is the sole writer of that file
// (see SERVERS.md). `W` saves the numbers to tools/looks/pose-lab.json beside
// this page, which is a file for a human to move into config.js rather than a
// side effect of looking.
//
// THE MARKERS. Green spheres are the flipper tips (the measured skin at the
// end of each, which is what the game calls the hands); red are the IK targets
// the pose asked for this frame; amber is the head chain's tip, which the
// salute measures its touch from; cyan is the chest. Red sitting a long way
// off green means the solver could not get there — usually the joint stops in
// `celebrate.ik`, not the target.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import {
  preloadAssets, createVisual, applySavedAssetLooks, applyNoiseSettings, applyToonSettings,
  applyBiolumSkinSettings,
} from '../../path/src/assets.js';
import { createAnimationController } from '../../path/src/systems/animation.js';
import { createAimRig } from '../../path/src/systems/aimRig.js';
import { createPoseRig } from '../../path/src/systems/poseRig.js';
import {
  createCelebrationDriver, playCelebration, updateCelebration, resetCelebration,
  celebrationState, celebrationSpin, celebrationFacing, CELEBRATION_VARIANTS,
} from '../../path/src/systems/celebrate.js';
import {
  createClapDriver, triggerClap, updateClap, resetClap, clapState, clapDuration,
} from '../../path/src/systems/clap.js';
import { updatePoseBubbles, resetPoseBubbles } from '../../path/src/systems/poseBubbles.js';
import {
  initParticles, updateParticles, updateParticleScale,
} from '../../path/src/entities/particles.js';

const q = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const valsEl = document.getElementById('vals');
const noteEl = document.getElementById('note');

// --- what a pose is made of -------------------------------------------------
//
// The sliders are built from the pose's OWN config keys rather than from a
// hand-written list per variant, and that is deliberate: a list here would be
// a second declaration of every pose's shape, and the first thing to rot when
// one grows a number. RANGES only says how far a named key may travel; a key
// nobody has ranged still gets a slider, on the reach-fraction default that
// suits almost all of them.
const RANGES = {
  // Reach fractions, the currency of nearly every number in these poses.
  up: [-1, 1.2, 0.01], fore: [-1, 1.2, 0.01], spread: [0, 1, 0.01], lateral: [0, 1, 0.01],
  open: [0, 1, 0.01], close: [-0.3, 0.8, 0.01], bob: [-0.4, 0.5, 0.01],
  headUp: [-1, 1.2, 0.01], headFore: [-1, 1.2, 0.01], headWeight: [0, 1, 0.02],
  finUp: [-1, 1.2, 0.01], finFore: [-1, 1.2, 0.01], finSpread: [0, 1, 0.01],
  offUp: [-1, 1.2, 0.01], offFore: [-1, 1.2, 0.01], offSpread: [0, 1, 0.01],
  tailUp: [-1.2, 1.2, 0.01], tailFore: [-1.2, 1.2, 0.01],
  browUp: [-0.6, 0.6, 0.01], browFore: [-0.6, 0.6, 0.01], browOut: [-0.4, 0.6, 0.01],
  tuck: [0, 1, 0.01], tuckUp: [-1, 1, 0.01], tuckFore: [-1, 1, 0.01],
  // Shapes of motion rather than places.
  sweep: [0, 1.5, 0.01], beats: [0.25, 4, 0.25], turns: [0, 3, 0.5],
  tremble: [0, 0.3, 0.005], trembleHz: [1, 20, 0.5],
  // The blend terms, which are shares and never distances.
  follow: [0, 0.9, 0.01], blendFrom: [0, 1, 0.05], faceWeight: [0, 1, 0.05],
};
const DEFAULT_RANGE = [-1, 1.2, 0.01];

// The timing each source runs on. Celebrations are started through
// playCelebration with these as arguments, which is what the salute and the
// level-up pose both do — the boss kill's own peak is derived from the trophy
// shutter and is not a general timing.
const TIMING = {
  peakAt: [0.05, 2, 0.01],
  hold: [0, 4, 0.05],
  release: [0.05, 2, 0.05],
};
const timing = { peakAt: 0.42, hold: 0.8, release: 0.5 };

// Every anchor systems/poseBubbles.js can resolve. Kept in step with the
// switch there by hand — it is five names, and a dropdown offering one that
// silently emits nothing is worse than a short list.
const ANCHORS = ['mouth', 'fins', 'finL', 'finR', 'tail'];
const EMITTERS = ['breathBubbles', 'wakeBubbles'];

// EVERY CANNED SHAPE THE SEAL HAS, and the last one is not a celebration: the
// button's clap is its own system (systems/clap.js) and its own config block.
// It is listed under a different name from the celebration variant ALSO called
// `clap` — same gesture, different implementation, different numbers — because
// two buttons reading "clap" is a picker where half the sliders do nothing and
// nothing says why.
const CLAP_BUTTON = 'clap button';
const SOURCES = [...CELEBRATION_VARIANTS, CLAP_BUTTON];
let variant = q.get('pose') && SOURCES.includes(q.get('pose')) ? q.get('pose') : 'salute';
const isClap = () => variant === CLAP_BUTTON;

// The pose's config block — CONFIG.clap.pose for the button, and the variant's
// own entry under CONFIG.celebrate.poses for everything else.
function poseCfg() {
  return isClap() ? (CONFIG.clap.pose ??= {}) : (CONFIG.celebrate.poses[variant] ??= {});
}
function bubbleCfg() {
  return bubblesOf(isClap() ? CONFIG.clap : poseCfg());
}

/** The bubbles block for one source, created with the lab's defaults if absent. */
function bubblesOf(owner) {
  return (owner.bubbles ??= { enabled: true, emitter: 'breathBubbles', from: 'mouth', rate: 0, scale: 1, bursts: [] });
}

/**
 * One bubble size for the whole lab — see the note on the slider.
 *
 * Every celebration variant plus the button's clap, which is a separate system
 * with its own block (systems/clap.js) and would otherwise be the one pose that
 * did not follow.
 *
 * A variant with no `bubbles` yet GETS ONE, seeded at rate 0 — which emits
 * nothing (`if (rate > 0)` in systems/poseBubbles.js), so this adds no bubbles
 * to a pose that had none. Leaving those poses out instead was the first
 * attempt and it half-worked: the celebration `clap` has no block, so it went
 * on reading the fallback 1 while the other six sat at the size you had just
 * chosen — the exact drift between poses this control exists to remove. The
 * lab already creates a block for any pose you so much as look at (bubbleCfg
 * above), so this is the same bargain, made once rather than per click.
 */
function setEveryBubbleScale(v) {
  for (const name of CELEBRATION_VARIANTS) bubblesOf(CONFIG.celebrate.poses[name] ??= {}).scale = v;
  bubblesOf(CONFIG.clap).scale = v;
}

const DEFAULTS = JSON.parse(JSON.stringify({
  celebrate: { poses: CONFIG.celebrate.poses },
  clap: { pose: CONFIG.clap.pose, bubbles: CONFIG.clap.bubbles },
  salute: CONFIG.salute,
}));

// --- preset -----------------------------------------------------------------
let dirty = false;
let presetNote = '';
try {
  const saved = await (await fetch('/preset/pose-lab.json')).json();
  if (saved.celebrate?.poses) Object.assign(CONFIG.celebrate.poses, saved.celebrate.poses);
  if (saved.clap?.pose) Object.assign(CONFIG.clap.pose, saved.clap.pose);
  if (saved.clap?.bubbles) CONFIG.clap.bubbles = saved.clap.bubbles;
  if (saved.salute) Object.assign(CONFIG.salute, saved.salute);
  presetNote = 'preset loaded from tools/looks/pose-lab.json';
} catch { /* no server or nothing saved — the normal first run */ }

function preset() {
  return {
    celebrate: { poses: CONFIG.celebrate.poses },
    clap: { pose: CONFIG.clap.pose, bubbles: CONFIG.clap.bubbles },
    salute: CONFIG.salute,
    savedAt: new Date().toISOString(),
  };
}
async function writePreset() {
  try {
    const r = await fetch('/preset/pose-lab.json', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    presetNote = r.ok ? `saved tools/looks/pose-lab.json ${new Date().toLocaleTimeString()}` : `save failed: ${r.status}`;
    dirty = !r.ok;
  } catch (err) {
    presetNote = `save failed: ${err.message}`;
  }
}

// --- panel ------------------------------------------------------------------
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function slider(parent, label, get, set, [min, max, step]) {
  const row = el('div', 'row');
  const l = el('label', null, label);
  l.title = label;
  const r = el('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step;
  r.value = get() ?? 0;
  const o = el('output', null, Number(r.value).toFixed(step < 0.01 ? 3 : 2));
  r.addEventListener('input', () => {
    const v = Number(r.value);
    set(v);
    o.textContent = v.toFixed(step < 0.01 ? 3 : 2);
    dirty = true;
  });
  row.append(l, r, o);
  parent.appendChild(row);
}

function buildVariants() {
  const box = document.getElementById('variants');
  box.innerHTML = '';
  for (const name of SOURCES) {
    const b = el('button', name === variant ? 'on' : null, name);
    b.addEventListener('click', () => {
      variant = name;
      stop();
      buildPanel();
      fire();
    });
    box.appendChild(b);
  }
}

function buildTiming() {
  const box = document.getElementById('timing');
  box.innerHTML = '';
  box.appendChild(el('h2', null, isClap() ? 'stroke (systems/clap.js)' : 'clock'));
  if (isClap()) {
    for (const [key, range] of [['attack', [0.01, 0.3, 0.005]], ['hold', [0, 0.3, 0.005]], ['release', [0.02, 1, 0.01]], ['weight', [0, 1, 0.02]]]) {
      slider(box, key, () => CONFIG.clap[key], (v) => { CONFIG.clap[key] = v; }, range);
    }
    return;
  }
  // The salute's clock is config, because it is a gesture the game fires with
  // its own timing (CONFIG.salute); every other variant is rolled by the boss
  // kill, whose peak is derived from the trophy shutter — so for those this
  // page owns the numbers and they are here to audition the shape at, not to
  // be saved.
  const owned = variant === 'salute';
  for (const [key, range] of Object.entries(TIMING)) {
    slider(box, owned ? `salute ${key}` : key,
      () => (owned ? CONFIG.salute[key] : timing[key]),
      (v) => { if (owned) CONFIG.salute[key] = v; else timing[key] = v; },
      range);
  }
  if (owned) slider(box, 'lean at stone', () => CONFIG.salute.lean, (v) => { CONFIG.salute.lean = v; }, [0, 1, 0.02]);
}

function buildShape() {
  const box = document.getElementById('shape');
  box.innerHTML = '';
  box.appendChild(el('h2', null, `${variant} — shape`));
  const p = poseCfg();
  const keys = Object.keys(p).filter((k) => typeof p[k] === 'number').sort();
  if (!keys.length) box.appendChild(el('div', 'hdr', 'this pose has no numbers of its own'));
  for (const key of keys) {
    slider(box, key, () => p[key], (v) => { p[key] = v; }, RANGES[key] ?? DEFAULT_RANGE);
  }
  // The solver's stops, shared by every celebration pose — the first place to
  // look when a target is reached for and not arrived at.
  box.appendChild(el('h2', null, 'ik (shared)'));
  const ik = isClap() ? CONFIG.clap.ik : CONFIG.celebrate.ik;
  for (const [key, range] of [['maxFold', [0.5, 3.1, 0.01]], ['maxBend', [0.2, 3.1, 0.01]], ['maxTwist', [0, 2, 0.01]], ['smoothing', [4, 80, 1]], ['iterations', [1, 12, 1]], ['softness', [0, 1, 0.01]]]) {
    slider(box, key, () => ik[key], (v) => { ik[key] = v; }, range);
  }
}

function buildBubbles() {
  const box = document.getElementById('bubbles');
  box.innerHTML = '';
  box.appendChild(el('h2', null, 'bubbles'));
  const b = bubbleCfg();

  const onRow = el('div', 'row');
  const onLabel = el('label', null, 'emits');
  const onBtn = el('button', b.enabled === false ? null : 'on', b.enabled === false ? 'off' : 'on');
  onBtn.classList.add('small');
  onBtn.addEventListener('click', () => {
    b.enabled = b.enabled === false;
    onBtn.textContent = b.enabled === false ? 'off' : 'on';
    onBtn.classList.toggle('on', b.enabled !== false);
    dirty = true;
  });
  onRow.append(onLabel, onBtn, el('output'));
  box.appendChild(onRow);

  const pick = (label, get, set, options) => {
    const row = el('div', 'row');
    const sel = el('select');
    for (const o of options) {
      const opt = el('option', null, o);
      opt.value = o;
      if (get() === o) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => { set(sel.value); dirty = true; });
    row.append(el('label', null, label), sel, el('output'));
    box.appendChild(row);
  };
  pick('emitter', () => b.emitter ?? 'breathBubbles', (v) => { b.emitter = v; }, EMITTERS);
  pick('stream from', () => b.from ?? 'mouth', (v) => { b.from = v; }, ANCHORS);
  slider(box, 'rate /s', () => b.rate ?? 0, (v) => { b.rate = v; }, [0, 60, 0.5]);
  // THE FLOOR IS 0.01, AND THE STEP MATCHES IT.
  //
  // This was [0.1, 3, 0.05], which is the wrong range at both ends. Every
  // authored pose in config.js sits between 0.7 and 1.4, so two thirds of the
  // travel bought sizes nobody has ever wanted — while the bottom, which is
  // where the work actually happens, was one notch wide: 0.1 to 0.15 is a 50%
  // jump in a single step, and 0.1 itself still renders as a white blob the
  // size of the seal's head. A wake bubble wants to be a speck.
  //
  // AND IT MOVES EVERY POSE AT ONCE, which is why it is labelled so.
  //
  // A bubble's size is a property of the WATER, not of the gesture that made
  // it: the same seal in the same sea blowing the same air. Six poses each
  // carrying their own scale meant dialling the look six times and getting six
  // slightly different answers, and the drift between them read as a bug in
  // whichever one you looked at second. The rate, the emitter, the anchor and
  // the bursts all stay per-pose — those ARE the gesture.
  //
  // It reads the pose in front of you and writes all of them, so the number
  // shown is always a real one. Note that the first drag FLATTENS what were
  // several different values (0.9, 0.75, 0.8, 1.3, 0.8 across the variants as
  // shipped); that is the point of the control, but it is not recoverable from
  // the panel, so `defaults` is the way back.
  slider(box, 'size (all poses)', () => b.scale ?? 1, setEveryBubbleScale, [0.01, 2, 0.01]);

  // THE BURSTS, one row each: when in the pose, how many, from where, how big.
  // `at` is a PHASE and not a time — 1 is full extension, whatever clock the
  // performance happens to be running on — which is what lets one burst stay
  // on the contact when the timing above is retuned.
  box.appendChild(el('div', 'hdr', 'bursts — at (phase) · puffs · from · size'));
  b.bursts ??= [];
  const redraw = () => { buildBubbles(); };
  b.bursts.forEach((burst, i) => {
    const row = el('div', 'burst');
    const at = el('input'); at.type = 'number'; at.min = 0; at.max = 1; at.step = 0.05; at.value = burst.at ?? 1;
    at.addEventListener('change', () => { burst.at = Number(at.value); dirty = true; });
    const count = el('input'); count.type = 'number'; count.min = 0; count.max = 60; count.step = 1; count.value = burst.count ?? 0;
    count.addEventListener('change', () => { burst.count = Number(count.value); dirty = true; });
    const from = el('select');
    for (const a of ANCHORS) {
      const o = el('option', null, a); o.value = a;
      if ((burst.from ?? b.from ?? 'mouth') === a) o.selected = true;
      from.appendChild(o);
    }
    from.addEventListener('change', () => { burst.from = from.value; dirty = true; });
    const scale = el('input'); scale.type = 'number'; scale.min = 0.01; scale.max = 2; scale.step = 0.01; scale.value = burst.scale ?? 1;
    scale.addEventListener('change', () => { burst.scale = Number(scale.value); dirty = true; });
    const kill = el('button', 'small', '×');
    kill.addEventListener('click', () => { b.bursts.splice(i, 1); dirty = true; redraw(); });
    row.append(at, count, from, scale, kill);
    box.appendChild(row);
  });
  const add = el('button', 'small', '+ burst');
  add.addEventListener('click', () => {
    b.bursts.push({ at: 1, count: 6, from: b.from ?? 'mouth', scale: 1 });
    dirty = true;
    redraw();
  });
  box.appendChild(add);
}

function buildPanel() {
  buildVariants();
  buildTiming();
  buildShape();
  buildBubbles();
}

// --- the frame --------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16303f);
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
initParticles(scene);

// --- the animal -------------------------------------------------------------
// The holder carries the HEADING, exactly as the run does: createVisual leaves
// a side-view creature nose-up, and -PI/2 about Z is what faceMotion writes
// for travel along +X. The body under it carries the mirror — the half roll
// about the art's own forward that keeps the animal belly-down when it turns
// around — which is the same axis entities/player.js composes it on.
const holder = new THREE.Object3D();
holder.rotation.z = -Math.PI / 2;
scene.add(holder);
const body = createVisual('ship');
holder.add(body);

const anim = createAnimationController(body);
const rig = createAimRig(body);
const celebrate = createCelebrationDriver(body);
const clap = createClapDriver(body);
// A second pose rig, for DRAWING what the pose asked for. It never poses
// anything — createPoseRig only reads bones until capture/restore are called,
// and this one never calls them.
const probe = createPoseRig(body, 'lab-probe');
const chest = body.getObjectByName('chest_04');

// --- the stone --------------------------------------------------------------
// A stand-in, not the real gravestone: what the salute needs from it is a
// PLACE, so the lean and the mirror have something to be measured against.
const grave = new THREE.Mesh(
  new THREE.BoxGeometry(1.1, 1.6, 0.35),
  new THREE.MeshStandardMaterial({ color: 0x8c8b84, roughness: 0.9 }),
);
grave.position.set(4.2, -2.4, 0);
scene.add(grave);
let showGrave = true;

// --- markers ----------------------------------------------------------------
function ball(color, r = 0.07) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.renderOrder = 10;
  scene.add(m);
  return m;
}
const handBalls = [ball(0x7ee081), ball(0x7ee081)];
const targetBalls = [ball(0xff6f8f, 0.05), ball(0xff6f8f, 0.05)];
const headBall = ball(0xffc861, 0.045);
const chestBall = ball(0x7ad7ff, 0.06);

// --- cameras ----------------------------------------------------------------
const camSide = new THREE.OrthographicCamera();
const camFront = new THREE.OrthographicCamera();
const camTop = new THREE.OrthographicCamera();
camSide.position.set(0, 0, 40); camSide.up.set(0, 1, 0);
camFront.position.set(40, 0, 0); camFront.up.set(0, 1, 0);
camTop.position.set(0, 40, 0); camTop.up.set(-1, 0, 0);
for (const c of [camSide, camFront, camTop]) c.lookAt(0, 0, 0);

// --- the clock --------------------------------------------------------------
const DT = 1 / 60;
const aim = new THREE.Vector2(1, 0);
const velocity = { x: 0, y: 0 };
let swimming = true;
let loop = false;
let scrub = false;
let scrubT = 1;
let loopClock = 0;

function fire() {
  if (scrub) return;
  if (isClap()) {
    const m = rig.muzzles;
    triggerClap({ x: (m[0].x + m[1].x) / 2, y: (m[0].y + m[1].y) / 2 });
    return;
  }
  resetCelebration();
  playCelebration({
    variant,
    peakAt: variant === 'salute' ? CONFIG.salute.peakAt : timing.peakAt,
    hold: variant === 'salute' ? CONFIG.salute.hold : timing.hold,
    release: variant === 'salute' ? CONFIG.salute.release : timing.release,
    escorts: false,
    // The stone is to the seal's right, so the lean is positive — the same
    // vector systems/salute.js builds from the grave it found.
    facing: variant === 'salute' ? { x: CONFIG.salute.lean, y: 1 } : null,
  });
}
function stop() {
  resetCelebration();
  resetClap();
  resetPoseBubbles();
  celebrate?.reset();
  clap?.reset?.();
}

// HOLDING A POSE AT A PHASE. For a celebration that means pinning the clock
// where the envelope wants it rather than freezing the driver: everything
// downstream — the pose, the facing, the bubbles' phase — is a function of
// that one number, so pinning it holds all three in step. The duration is kept
// well ahead of the clock so nothing expires underneath the hold.
function pin(t) {
  if (isClap()) {
    clapState.active = true;
    clapState.t = t;
    return;
  }
  const peak = variant === 'salute' ? CONFIG.salute.peakAt : timing.peakAt;
  celebrationState.active = true;
  celebrationState.variant = variant;
  celebrationState.peakAt = Math.max(0.01, peak);
  celebrationState.release = 0.5;
  celebrationState.duration = celebrationState.peakAt + 999;
  celebrationState.clock = celebrationState.peakAt * t;
  celebrationState.escorts = false;
  celebrationState.only = null;
  celebrationState.facing = variant === 'salute' ? { x: CONFIG.salute.lean, y: 1 } : null;
}

// WHICH WAY THE ANIMAL IS POINTING, through exactly the terms the run uses:
// celebrationFacing asks for a heading, the heading turns the holder, and a
// heading pointing left mirrors the body about its own forward axis instead of
// rolling it belly-up. Not poseBody itself — that function is the run's, wants
// a live `player` and owns five other axes — but the same two rules.
function faceBody() {
  let heading = 0; // swimming +X
  const face = celebrationFacing(null);
  if (face) {
    const target = Math.atan2(face.y, face.x);
    let delta = target - heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    heading += delta * face.weight;
  }
  holder.rotation.z = heading - Math.PI / 2;
  body.rotation.y = Math.cos(heading) < 0 ? Math.PI : 0;
  // The somersault, folded in the way entities/player.js folds it — about the
  // body's own lateral axis, which is also the camera axis.
  body.rotation.z = celebrationSpin(null);
}

function step(dt) {
  anim?.update(dt, swimming ? 'swim' : 'idle', false);
  holder.updateMatrixWorld(true);
  rig?.update(dt, aim, { engaged: true });
  if (scrub) pin(scrubT);
  else { updateCelebration(dt); updateClap(dt); }
  faceBody();
  holder.updateMatrixWorld(true);
  clap?.update(dt);
  celebrate?.update(dt);
  holder.updateMatrixWorld(true);
  updatePoseBubbles(dt, rig, { aboveSurface: false, velocity });
  updateParticles(dt);
}

// Settle before anything is measured.
for (let i = 0; i < 180; i++) step(DT);
const box = new THREE.Box3().setFromObject(body);
const size = box.getSize(new THREE.Vector3());
const centre = box.getCenter(new THREE.Vector3());
const span = Math.max(size.x, size.y, size.z) * 0.75;

const layout = { side: [0, 0, 1, 1], front: [0, 0, 1, 1], top: [0, 0, 1, 1] };
function place(id, x, y) {
  const n = document.getElementById(id);
  n.style.left = `${x}px`; n.style.top = `${y}px`;
}
function fitCams() {
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 720;
  renderer.setSize(w, h);
  const PANEL = 336;
  const sideW = Math.floor(w * 0.62), rightW = w - sideW, halfH = Math.floor(h / 2);
  layout.side = [PANEL, 0, Math.max(1, sideW - PANEL), h];
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
  // Tighter than the two check views and centred on the animal: this is the
  // frame the player actually sees, so it is the one that has to be judged at
  // something like the size it is judged at in the game.
  fit(camSide, Math.max(1, sideW - PANEL), h, 0, centre.y, 0.8);
  // The two check views frame the front half of the animal, where the hands
  // and the head are, at about twice the side view's scale.
  fit(camFront, rightW, h - halfH, 0, centre.y, 0.6);
  fit(camTop, rightW, halfH, 0, 0, 0.7);
  place('capSide', PANEL + 12, 10);
  place('capFront', sideW + 12, 10);
  place('capTop', sideW + 12, halfH + 10);
}
window.addEventListener('resize', fitCams);
fitCams();

// --- readout ----------------------------------------------------------------
const _v = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _head = new THREE.Vector3();
function bodyFrame(p, origin, out) {
  _v.copy(p).sub(origin);
  out.up = _v.dot(probe.basis.up);
  out.fore = _v.dot(probe.basis.fore);
  out.lat = _v.dot(probe.basis.lat);
  return out;
}
const lF = {}, rF = {};

function readout() {
  probe.refreshBasis();
  chest?.getWorldPosition(_chest);
  const m = rig.muzzles;
  handBalls[0].position.copy(m[0]);
  handBalls[1].position.copy(m[1]);
  chestBall.position.copy(_chest);
  if (probe.head) {
    probe.head.bones[0].updateWorldMatrix(true, true);
    _head.copy(probe.head.tipAxis).multiplyScalar(probe.head.tipLength);
    probe.head.tip.localToWorld(_head);
    headBall.position.copy(_head);
  }
  bodyFrame(m[0], _chest, lF);
  bodyFrame(m[1], _chest, rF);

  // WHERE THE POSE ASKED FOR, drawn from the probe rig — the targets the
  // celebration solves toward are built and consumed inside the driver, so the
  // only honest way to show them is to build the same ones here. Only the
  // shapes whose target is a plain reach-offset can be drawn this way; the
  // salute's saluting flipper is measured from the head, so it is drawn at the
  // head plus the same three offsets.
  const p = poseCfg();
  probe.fins.forEach(({ chain, side }, i) => {
    if (isClap()) {
      const bob = clapState.t * (p.bob ?? 0);
      probe.target(chain, targetBalls[i].position, side, (p.up ?? 0) + bob, p.fore ?? 0, p.close ?? 0);
    } else if (variant === 'salute' && side > 0 && probe.head) {
      const reach = Math.max(0.001, _head.distanceTo(_chest));
      targetBalls[i].position.copy(_head)
        .addScaledVector(probe.basis.up, (p.browUp ?? 0) * reach)
        .addScaledVector(probe.basis.fore, (p.browFore ?? 0) * reach)
        .addScaledVector(probe.basis.lat, side * (p.browOut ?? 0) * reach);
    } else if (variant === 'salute') {
      probe.target(chain, targetBalls[i].position, side, p.offUp ?? 0, p.offFore ?? 0, p.offSpread ?? 0);
    } else {
      probe.target(chain, targetBalls[i].position, side, p.up ?? p.finUp ?? 0, p.fore ?? p.finFore ?? 0, p.spread ?? p.finSpread ?? 0);
    }
  });

  const gap = m[0].distanceTo(m[1]);
  const toHead = probe.head ? Math.min(m[0].distanceTo(_head), m[1].distanceTo(_head)) : NaN;
  const phase = isClap()
    ? clapState.t
    : (celebrationState.active ? Math.min(1, celebrationState.clock / Math.max(0.01, celebrationState.peakAt)) : 0);
  const face = celebrationFacing(null);
  valsEl.textContent =
    `${variant}  phase ${phase.toFixed(2)}  ${scrub ? 'HELD' : (celebrationState.active || clapState.active ? 'playing' : 'idle')}\n`
    + `hand gap ${gap.toFixed(2)}   nearest hand to head ${Number.isNaN(toHead) ? '—' : toHead.toFixed(2)}\n`
    + `L  up ${lF.up.toFixed(2)} fore ${lF.fore.toFixed(2)} lat ${lF.lat.toFixed(2)}\n`
    + `R  up ${rF.up.toFixed(2)} fore ${rF.fore.toFixed(2)} lat ${rF.lat.toFixed(2)}\n`
    + `facing ${face ? `${(Math.atan2(face.y, face.x) * 180 / Math.PI).toFixed(0)}deg  w ${face.weight.toFixed(2)}` : '— (swim)'}\n`
    + (isClap() ? `stroke ${clapDuration().toFixed(2)}s  presses ${clapState.presses}` : `duration ${celebrationState.duration.toFixed(2)}s`);
  noteEl.textContent = presetNote + (dirty ? '  ·  unsaved changes (W)' : '');
}

// --- render -----------------------------------------------------------------
function view(cam, [x, y, w, h]) {
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.setScissorTest(true);
  updateParticleScale(cam, renderer);
  renderer.render(scene, cam);
}
function render() {
  grave.visible = showGrave;
  renderer.setScissorTest(false);
  renderer.clear();
  view(camSide, layout.side);
  view(camFront, layout.front);
  view(camTop, layout.top);
}

// --- controls ---------------------------------------------------------------
const b = (id) => document.getElementById(id);
b('bPlay').addEventListener('click', fire);
b('bLoop').addEventListener('click', () => { loop = !loop; b('bLoop').classList.toggle('on', loop); loopClock = 0; });
b('bSwim').addEventListener('click', () => { swimming = !swimming; b('bSwim').classList.toggle('on', swimming); });
b('bSwim').classList.add('on');
b('bGrave').addEventListener('click', () => { showGrave = !showGrave; b('bGrave').classList.toggle('on', showGrave); });
b('bGrave').classList.add('on');
b('bScrub').addEventListener('click', () => {
  scrub = !scrub;
  b('bScrub').classList.toggle('on', scrub);
  if (!scrub) stop();
  scrubRow.style.display = scrub ? '' : 'none';
});
b('bReset').addEventListener('click', () => {
  Object.assign(CONFIG.celebrate.poses, JSON.parse(JSON.stringify(DEFAULTS.celebrate.poses)));
  CONFIG.clap.pose = JSON.parse(JSON.stringify(DEFAULTS.clap.pose));
  CONFIG.clap.bubbles = JSON.parse(JSON.stringify(DEFAULTS.clap.bubbles));
  Object.assign(CONFIG.salute, JSON.parse(JSON.stringify(DEFAULTS.salute)));
  buildPanel();
  presetNote = 'config.js defaults (as loaded, tuning included)';
  dirty = true;
});
b('bSave').addEventListener('click', writePreset);

const scrubRow = el('div', 'row');
scrubRow.style.display = 'none';
scrubRow.innerHTML = '<label>hold at</label><input type="range" min="0" max="1" step="0.01" value="1"><output>1.00</output>';
scrubRow.querySelector('input').addEventListener('input', (e) => {
  scrubT = Number(e.target.value);
  scrubRow.querySelector('output').textContent = scrubT.toFixed(2);
});
document.getElementById('timing').before(scrubRow);

window.addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); fire(); }
  if (e.key === 'W') writePreset();
});

buildPanel();

// OPEN IN THE POSE, held at full extension. A design surface whose first frame
// is an idle seal is a page you have to press something to start using, and
// the held pose is the thing almost every judgement here is about.
scrub = true;
scrubT = 1;
b('bScrub').classList.add('on');
scrubRow.style.display = '';
scrubRow.querySelector('input').value = 1;

// A frame off disk on demand, for reading without a live pane.
async function shoot(name) {
  const blob = await new Promise((res) => stage.toBlob(res, 'image/png'));
  await fetch(`/shot/${name}.png`, { method: 'POST', body: blob });
}
window.__shoot = shoot;
window.__play = fire;
window.__pose = (name) => { if (SOURCES.includes(name)) { variant = name; stop(); buildPanel(); } };
window.__hold = (t) => {
  scrub = true; scrubT = t;
  b('bScrub').classList.add('on');
  scrubRow.style.display = '';
  scrubRow.querySelector('input').value = t;
};
window.__step = (n = 60) => { for (let i = 0; i < n; i++) step(DT); readout(); render(); };
window.__state = () => ({
  variant,
  phase: isClap() ? clapState.t : celebrationState.clock / Math.max(0.01, celebrationState.peakAt),
  gap: rig.muzzles[0].distanceTo(rig.muzzles[1]),
  toHead: probe.head ? Math.min(rig.muzzles[0].distanceTo(_head), rig.muzzles[1].distanceTo(_head)) : null,
  facing: celebrationFacing(null),
  pose: poseCfg(),
  bubbles: bubbleCfg(),
});

let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (loop && !scrub && !celebrationState.active && !clapState.active) {
    loopClock += dt;
    if (loopClock >= 0.4) { loopClock = 0; fire(); }
  }
  step(dt);
  readout();
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// `?shots` posts a strip of the current pose, held at four points.
if (q.has('shots')) {
  for (const t of [0.25, 0.5, 0.75, 1]) {
    window.__hold(t);
    for (let i = 0; i < 60; i++) step(DT);
    readout(); render();
    await shoot(`${variant}-t${t}`);
  }
  scrub = false; stop();
  noteEl.textContent = 'shots posted';
}
