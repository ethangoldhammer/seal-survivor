// ---------------------------------------------------------------------------
// ACCESSORY LAB — place what the seal wears, in a viewport, with handles
//
//   npm run looks:accessorylab
//
// tools/looks/accessories.js is the contact sheet: it answers "does this read"
// by rendering the shipped numbers a dozen ways. This is the other half — the
// place you MOVE them. Six sliders and a memory of the last frame is how the
// glasses got placed the first time, and it took four rebuilds to find a
// position that a drag would have found in ten seconds.
//
// WHAT IT IS, exactly: the real seal off the real asset pipeline, the real
// systems/accessories.js writing the real CONFIG onto it every frame, and a
// three.js TransformControls gizmo on the accessory. Nothing here re-implements
// the placement — the gizmo moves the mesh, the mesh's transform is read BACK
// into CONFIG, and the system then writes CONFIG onto the mesh again. That loop
// is the whole design, and it is why the sliders and the handles cannot
// disagree: they are two ways of editing one number.
//
// THE READBACK IS THE EXACT INVERSE OF THE SYSTEM'S OWN MATH, and it has to be
// stated in the SEAL's frame rather than the world's or the bone's:
//
//     d     = bodyQ⁻¹ · (visualWorldPos − boneWorldPos)   -> (−x, y, z) = lift, snout, depth
//     trim  = bodyQ⁻¹ · visualWorldQuat                   -> euler ZYX  = yaw, roll, pitch
//     size  = the visual's world scale
//
// The second line is the one worth reading twice. `visualWorldQ = boneWorldQ ·
// base · trim` and `boneWorldQ · base = bodyWorldQ` by the definition of
// `boneAlign`, so the bone drops out entirely and the trim is readable straight
// off the body. That is what makes a gizmo drag land on numbers whose meaning
// survives switching bones.
//
// TWO VIEWS, and the small one is not decoration. The big viewport is a
// perspective camera you can orbit, which is what placing needs. The inset is
// the GAME's camera — orthographic, side-on, at the arena's own zoom — which is
// the only view that can answer whether the thing reads at all. The sunglasses
// are the standing proof: worn the way a real pair sits they are perfect in the
// orbit view and a black stick in the game.
//
// SAVE WRITES THE GAME. The button POSTs to /accessory/, which writes
// tools/looks/accessory-lab.json and then splices the numbers into config.js
// and clears the shadowing key out of imported-tuning.json — see
// tools/apply-accessories.mjs, and the note there about why the delete is not
// optional. ONLY FIELDS THAT ACTUALLY MOVED are sent: this page renders every
// field resolved, and a resolved value is not a declared one.
//
// It is a vite BUILD with no dev server behind it, so nothing here can reach
// the tuning file by itself. See SERVERS.md.
//
// ONE GL CONTEXT for the page — a renderer per view goes black past a dozen, so
// the inset is a second viewport on the same renderer rather than a second one.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import {
  updateAccessories, accessoryState, equipAccessory, accessoryTurn,
} from '../../path/src/systems/accessories.js';

const $ = (id) => document.getElementById(id);
const W = 560;
const H = 460;
// The inset, bottom-right of the viewport. Wide and short because it is the
// game's frame and the game is a side-on animal in a letterbox.
const INSET_W = 200;
const INSET_H = 132;

const stage = $('stage');
const gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;
gl.autoClear = false;
stage.prepend(gl.domElement);

const say = (msg, cls = '') => { $('status').className = cls; $('status').textContent = msg; };
const note = (msg) => { $('notes').textContent = msg; };

// THE GAME'S OWN LIGHTING RIG, read from config rather than invented. Same
// argument the contact sheet makes: a prettier three-point setup would be
// placing a thing under a sun that does not exist.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1a28);
scene.add(new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient));
const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
key.position.fromArray(CONFIG.lighting.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity));

await preloadAssets();

// THE SEAL AS THE GAME HOLDS IT. entities/player.js carries the facing on a
// container above the model and createVisual points a creature's nose at world
// +Y, so this is a seal swimming to the right. Kept even though the readback
// below is frame-independent: the inset has to be the game's frame, and the
// game's frame is this one.
const holder = new THREE.Object3D();
holder.rotation.z = -Math.PI / 2;
scene.add(holder);
const seal = createVisual('ship');
holder.add(seal);
scene.updateMatrixWorld(true);

// --- HOW THE MENU WILL BE STANDING IT --------------------------------------
// What the seal has on can ask to be seen from a particular angle — the
// sunglasses turn it to face the lens, a cap flips a coin between the profile
// and a three-quarter (CONFIG.accessories `showTurns`). The menu applies that;
// so does this page, because placing a pair of glasses against a profile that
// the player will never see is placing them against the wrong picture.
//
// The readback is untouched by it: every number on this page is stated in the
// SEAL's frame, and this turns the seal.
const _turnQuat = new THREE.Quaternion();
const _yUp = new THREE.Vector3(0, 1, 0);
let turn = accessoryTurn();

// --- the two cameras --------------------------------------------------------
const focus = (seal.getObjectByName('head_07') ?? seal).getWorldPosition(new THREE.Vector3());

const orbitCam = new THREE.PerspectiveCamera(35, W / H, 0.05, 200);
orbitCam.position.set(focus.x + 0.6, focus.y + 0.5, focus.z + 3.4);
const orbit = new OrbitControls(orbitCam, gl.domElement);
orbit.target.copy(focus);
orbit.enableDamping = true;
orbit.update();

// THE GAME'S CAMERA. Orthographic and never rotated (world.js), at roughly the
// arena's own zoom — the frame in which the decision about whether an accessory
// reads is actually made.
const GAME_W = 5;
const gameCam = new THREE.OrthographicCamera(-GAME_W / 2, GAME_W / 2, 1, -1, -100, 200);
gameCam.position.set(focus.x, focus.y, 20);

// THE FRUSTUM IS SET FROM THE VIEWPORT IT IS ABOUT TO DRAW INTO, every time.
// This camera draws into two of them — the inset, and the whole stage when
// `game view` is on — and an orthographic frustum does not adapt to the
// viewport the way a perspective one's aspect does: fixed at the inset's shape,
// the full-frame version stretches the seal a third taller and every judgement
// made in it is about an animal the game does not draw.
function frameGameCam(w, h) {
  const half = (GAME_W * h / w) / 2;
  if (gameCam.top === half) return;
  gameCam.top = half;
  gameCam.bottom = -half;
  gameCam.updateProjectionMatrix();
}

// --- the gizmo --------------------------------------------------------------
// WORLD SPACE, not local. The handles then stay put while the thing on them
// turns, which is what you want when a quarter-turn yaw is the FIRST thing you
// do to a pair of glasses: local handles would rotate with it and the next drag
// would go somewhere you did not point.
const gizmo = new TransformControls(orbitCam, gl.domElement);
gizmo.setSpace('world');
// Big enough to grab. The default is sized for a person-sized object in a
// person-sized scene; an accessory is a third of a world unit on an animal
// filling half the frame, and at the default the three arrows are about twenty
// pixels long and land on top of each other.
gizmo.setSize(1.3);
scene.add(gizmo.getHelper());
// three r169+ made TransformControls a plain Controls rather than an Object3D;
// `getHelper()` is the visible part and the one that goes in the scene. Adding
// the controls object itself renders nothing and throws nothing.
gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
gizmo.addEventListener('objectChange', () => readBack());

// ---------------------------------------------------------------------------
// THE ROSTER
// ---------------------------------------------------------------------------
const items = CONFIG.accessories.items;
const KEYS = Object.keys(items);
// SELECTING ONE PUTS IT ON, because the seal has ONE SLOT
// (CONFIG.accessories.equipped) and this page is for placing the thing you are
// looking at. Two accessories on at once is not a state the game can hold, so a
// lab that showed both would be placing them against a picture the player never
// sees — and a lab that showed the selected one while a different one was
// equipped would be a gizmo on a mesh that is not there. Opening on whatever
// the config boots wearing, or on the first in the file if that is nothing.
let subject = CONFIG.accessories.equipped || KEYS[0];
equipAccessory(subject);

// Every field this page has actually moved, as `<key>.<field>`. The save sends
// only these — see the header, and tools/apply-accessories.mjs. A Set rather
// than a diff against the boot values, because a slider dragged away and back
// is still a decision, and a float that round-trips through a gizmo is not
// reliably equal to the number it started at.
const moved = new Set();
const touch = (field, key = subject) => { moved.add(`${key}.${field}`); paintMoved(); };

const bones = Object.keys(CONFIG.accessories.boneAlign ?? { head_07: 1 });

// The controls, in the order they are worth reaching for.
const SPEC = [
  { f: 'snout', min: -1, max: 1, step: 0.001, label: 'toward the snout' },
  { f: 'lift', min: -1, max: 1, step: 0.001, label: 'lift' },
  { f: 'depth', min: -1, max: 1, step: 0.001, label: 'toward the camera' },
  { f: 'pitch', min: -3.15, max: 3.15, step: 0.001, label: 'pitch' },
  { f: 'yaw', min: -3.15, max: 3.15, step: 0.001, label: 'yaw' },
  { f: 'roll', min: -3.15, max: 3.15, step: 0.001, label: 'roll' },
  { f: 'size', min: 0.02, max: 2, step: 0.001, label: 'size (world units)' },
];

const rows = new Map();

function buildPanel() {
  const panels = $('panels');
  panels.textContent = '';

  const sect = (title) => {
    const el = document.createElement('div');
    el.className = 'sect';
    el.innerHTML = `<h3>${title}</h3>`;
    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);
    panels.appendChild(el);
    return body;
  };

  // --- worn / bone ---
  const top = sect('the accessory');
  // WHICH ONE IS ON, rather than a `worn` checkbox per accessory. Selecting in
  // the list equips; this row says what the seal is wearing and offers the bare
  // seal, which is a position in the slot and not an absence — the same
  // argument cycleAccessory makes about the menu's cycle.
  const bareRow = document.createElement('div');
  bareRow.className = 'row';
  const bareLabel = document.createElement('label');
  bareLabel.textContent = 'wearing';
  const bareSel = document.createElement('select');
  for (const [v, text] of [['', 'nothing'], ...KEYS.map((k) => [k, k.replace(/^accessory/, '').toLowerCase()])]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = text;
    bareSel.appendChild(o);
  }
  bareSel.addEventListener('change', () => {
    equipAccessory(bareSel.value);
    if (bareSel.value) { subject = bareSel.value; paintPanel(); paintMoved(); }
    paintList();
  });
  bareRow.append(bareLabel, bareSel, document.createElement('output'));
  top.appendChild(bareRow);
  rows.set('__equipped', { sel: bareSel });

  const boneRow = document.createElement('div');
  boneRow.className = 'row';
  const boneLabel = document.createElement('label');
  boneLabel.textContent = 'bone';
  const boneSel = document.createElement('select');
  for (const b of bones) {
    const o = document.createElement('option');
    o.value = b; o.textContent = b;
    boneSel.appendChild(o);
  }
  boneSel.addEventListener('change', () => {
    // THE OFFSETS ARE KEPT, not re-solved. They are in the seal's frame, so
    // "0.1 above the head" means the same thing on the neck as on the skull —
    // which is the entire reason for boneAlign, and it is what makes trying
    // another bone a click rather than a re-placement.
    items[subject].bone = boneSel.value;
    touch('bone');
  });
  boneRow.append(boneLabel, boneSel, document.createElement('output'));
  top.appendChild(boneRow);
  rows.set('__bone', { sel: boneSel });

  // --- the placement ---
  const place = sect('placement — world units, in the seal\'s own frame');
  for (const s of SPEC) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = s.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = s.min; input.max = s.max; input.step = s.step;
    const out = document.createElement('output');
    input.addEventListener('input', () => {
      items[subject][s.f] = parseFloat(input.value);
      out.textContent = fmt(items[subject][s.f]);
      touch(s.f);
    });
    row.append(label, input, out);
    place.appendChild(row);
    rows.set(s.f, { row, input, out });
  }

  // --- what the handles do ---
  const help = sect('handles');
  const keys = document.createElement('div');
  keys.className = 'keys';
  keys.innerHTML = '<b>W</b> move &nbsp; <b>E</b> rotate &nbsp; <b>R</b> size'
    + '<br><b>G</b> game view &nbsp; <b>H</b> hide the handles'
    + '<br>drag empty space to orbit, wheel to zoom';
  help.appendChild(keys);

  const btns = document.createElement('div');
  btns.className = 'btns';
  const save = document.createElement('button');
  save.className = 'act';
  save.textContent = 'save → config.js';
  save.addEventListener('click', doSave);
  const reset = document.createElement('button');
  reset.className = 'act quiet';
  reset.textContent = 'back to shipped';
  reset.addEventListener('click', () => {
    Object.assign(items[subject], SHIPPED[subject]);
    for (const k of [...moved]) if (k.startsWith(subject + '.')) moved.delete(k);
    paintPanel(); paintMoved(); paintList();
    say('back to the numbers config.js boots with.');
  });
  btns.append(save, reset);
  help.appendChild(btns);
}

// The numbers the page loaded with, so `back to shipped` means something after
// a session of dragging.
const SHIPPED = Object.fromEntries(KEYS.map((k) => [k, { ...items[k] }]));

const fmt = (v) => (Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(2));

function paintPanel() {
  const item = items[subject];
  rows.get('__equipped').sel.value = CONFIG.accessories.equipped ?? '';
  rows.get('__bone').sel.value = item.bone ?? bones[0];
  for (const s of SPEC) {
    const r = rows.get(s.f);
    const v = item[s.f] ?? 0;
    // The slider is clamped and the value is not: a gizmo can drag something
    // past a slider's range, and a range input silently rewrites the value it
    // is given to its own max. Showing the true number beside a pegged slider
    // is the honest version — the alternative moves the accessory when you look
    // at it.
    r.input.value = String(Math.min(s.max, Math.max(s.min, v)));
    r.out.textContent = fmt(v);
  }
}

function paintMoved() {
  for (const s of SPEC) {
    rows.get(s.f).row.classList.toggle('moved', moved.has(`${subject}.${s.f}`));
  }
  const n = moved.size;
  $('notes').textContent = n
    ? `${n} field(s) moved — save writes exactly these into config.js.`
    : 'nothing moved yet. Drag a handle or a slider; only what moves gets written.';
}

function paintList() {
  const list = $('list');
  list.textContent = '';
  const g = document.createElement('div');
  g.className = 'group';
  g.textContent = 'what the seal wears';
  list.appendChild(g);
  for (const k of KEYS) {
    const b = document.createElement('button');
    b.className = k === subject ? 'on' : '';
    const dirty = [...moved].some((m) => m.startsWith(k + '.'));
    b.innerHTML = `${k.replace(/^accessory/, '')}`
      + (CONFIG.accessories.equipped === k ? '' : ' <span class="off">off</span>')
      + (dirty ? ' <span class="tag">•</span>' : '');
    // SELECTING PUTS IT ON. See the note by `subject`: one slot, so the thing
    // being placed is the thing being worn.
    b.addEventListener('click', () => {
      subject = k;
      equipAccessory(k);
      paintPanel(); paintMoved(); paintList();
    });
    list.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// THE LOOP: gizmo -> CONFIG -> system -> mesh
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/** The seal's own orientation — what every number on this page is stated in. */
function bodyQuat(out) { return seal.getWorldQuaternion(out); }

/**
 * Read the gizmo's object back into CONFIG. The exact inverse of the placement
 * block in systems/accessories.js; see the header for why the bone drops out.
 */
function readBack() {
  const entry = accessoryState().get(subject);
  const visual = entry?.visual;
  const bone = entry?.bone;
  if (!visual || !bone) return;
  const item = items[subject];

  bodyQuat(_q);
  const inv = _q.clone().invert();

  visual.getWorldPosition(_v).sub(bone.getWorldPosition(new THREE.Vector3())).applyQuaternion(inv);
  item.lift = -_v.x;
  item.snout = _v.y;
  item.depth = _v.z;

  _e.setFromQuaternion(inv.clone().multiply(visual.getWorldQuaternion(new THREE.Quaternion())), 'ZYX');
  item.yaw = _e.x;
  item.roll = _e.y;
  item.pitch = _e.z;

  // Uniform, from the average: the gizmo scales per axis and an accessory that
  // has been squashed on one of them is not something any config field can
  // describe. Taking the average and re-applying it uniformly is what makes the
  // scale handle behave like the `size` slider it is standing in for.
  visual.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), _s);
  item.size = Math.max(0.001, (Math.abs(_s.x) + Math.abs(_s.y) + Math.abs(_s.z)) / 3);

  const mode = gizmo.getMode();
  if (mode === 'translate') for (const f of ['snout', 'lift', 'depth']) touch(f);
  else if (mode === 'rotate') for (const f of ['pitch', 'yaw', 'roll']) touch(f);
  else touch('size');
  paintPanel();
}

let gameView = false;
let showHandles = true;

function frame() {
  requestAnimationFrame(frame);
  orbit.update();

  // Eased, exactly as the menu eases it — a lab that snapped would be showing a
  // pose the game never draws on its way there.
  const wantTurn = accessoryTurn();
  turn += (wantTurn - turn) * (1 - Math.exp(-(CONFIG.accessories?.turnLerp ?? 6) * 0.016));
  if (Math.abs(wantTurn - turn) < 1e-4) turn = wantTurn;
  seal.quaternion.copy(_turnQuat.setFromAxisAngle(_yUp, turn));

  scene.updateMatrixWorld(true);
  updateAccessories(seal);
  scene.updateMatrixWorld(true);

  // The gizmo follows whatever is selected and worn. Re-attached every frame
  // rather than on selection: the visual is REBUILT when its model finishes
  // loading and when it is taken off and put back on, and a gizmo holding the
  // old mesh moves something that is no longer in the scene.
  const visual = accessoryState().get(subject)?.visual;
  const attachable = showHandles && visual && visual.parent && CONFIG.accessories.equipped === subject;
  if (attachable && gizmo.object !== visual) gizmo.attach(visual);
  else if (!attachable && gizmo.object) gizmo.detach();
  gizmo.getHelper().visible = !!attachable;

  gl.clear();
  gl.setScissorTest(false);
  gl.setViewport(0, 0, W, H);
  if (gameView) frameGameCam(W, H);
  gl.render(scene, gameView ? gameCam : orbitCam);

  // THE INSET: the game's frame, always, whatever the orbit camera is doing.
  // Drawn without the gizmo — the handles are the tool, not the game.
  if (!gameView) {
    const hidden = gizmo.getHelper().visible;
    gizmo.getHelper().visible = false;
    const x = W - INSET_W - 10;
    const y = 10;
    gl.setViewport(x, y, INSET_W, INSET_H);
    gl.setScissor(x, y, INSET_W, INSET_H);
    gl.setScissorTest(true);
    gl.clearDepth();
    frameGameCam(INSET_W, INSET_H);
    gl.render(scene, gameCam);
    gl.setScissorTest(false);
    gizmo.getHelper().visible = hidden;
  }
}

// ---------------------------------------------------------------------------
// SAVING
// ---------------------------------------------------------------------------
async function doSave() {
  if (!moved.size) { say('nothing has moved — nothing to write.', 'warn'); return; }
  const out = {};
  for (const id of moved) {
    const [k, f] = id.split('.');
    (out[k] ??= {})[f] = items[k][f];
  }
  // Rounded on the way out. A gizmo drag lands on 0.30217383384704589 and there
  // is nothing in a config file more useless than eleven digits of a number
  // somebody chose by eye; three is finer than the seal is long divided by a
  // thousand.
  for (const k of Object.keys(out)) {
    for (const f of Object.keys(out[k])) {
      if (typeof out[k][f] === 'number') out[k][f] = Math.round(out[k][f] * 1000) / 1000;
    }
  }
  say('saving…');
  try {
    const res = await fetch('/accessory/accessory-lab.json', {
      method: 'POST', body: JSON.stringify({ items: out }, null, 2),
    });
    const report = await res.json();
    if (report.error) { say(`saved the file, but the apply failed: ${report.error}`, 'err'); return; }
    const warn = (report.notes ?? []).filter((n) => n.startsWith('!'));
    say(`${report.written?.length ?? 0} field(s) into config.js, `
      + `${report.dropped?.length ?? 0} cleared from the snapshot.`, warn.length ? 'warn' : '');
    note((report.notes ?? []).join('\n'));
    moved.clear();
    paintMoved();
    paintList();
  } catch (err) {
    say(`could not save: ${err.message}`, 'err');
  }
}

// ---------------------------------------------------------------------------
// KEYS
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === 'w') gizmo.setMode('translate');
  else if (k === 'e') gizmo.setMode('rotate');
  else if (k === 'r') gizmo.setMode('scale');
  else if (k === 'g') gameView = !gameView;
  else if (k === 'h') showHandles = !showHandles;
  else return;
  $('modeTag').textContent = gameView
    ? 'game view'
    : (showHandles ? { translate: 'move', rotate: 'rotate', scale: 'size' }[gizmo.getMode()] : 'handles off');
});

buildPanel();
paintPanel();
paintMoved();
paintList();
say('drag the handles, or the sliders. Save writes only what moved.');
frame();
