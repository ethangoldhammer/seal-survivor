#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:touchglow
//
// Fingers on the glass, and what the backdrop does about them. Two layers, one
// gesture:
//
//   THE SLOTS  input.js — every contact on the canvas takes a slot, lowest free
//              one wins, and holds it until it lifts. Slot number IS finger
//              identity: it decides the colour and the power.
//   THE GLOW   systems/grid.js — turns those slots into shader uniforms, eased
//              in and out, with each finger's screen position resolved into the
//              water through the camera EVERY FRAME.
//
// That last word is the whole reason for the grid half of this file. The camera
// follows the player, so a thumb held perfectly still is over a different piece
// of ocean every frame. A world position cached at touchdown looks completely
// correct in a still screenshot and slides out from under the finger the moment
// the seal swims — which is exactly the class of bug a Node harness can catch
// and a screenshot cannot. The CAMERA PAN section is that regression test.
//
// Everything expected is derived from CONFIG rather than typed in: saved tuning
// is merged over the defaults at import (imported-tuning.json), so a hardcoded
// 6.0 here would be testing the tuning file rather than the code. The merged
// values are printed at the top for the same reason.
//
// What it cannot tell you: whether five fingers on a phone actually look good.
// That is a phone in your hands.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  initInput,
  clearPendingInput,
  input,
  touchSlots,
  TOUCH_SLOTS,
} from '../path/src/input.js';
import { createGrid } from '../path/src/systems/grid.js';
import { bounds } from '../path/src/arena.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

const GLOW = CONFIG.grid.touchGlow;

console.log('Merged CONFIG.grid.touchGlow (saved tuning wins over config.js defaults):');
console.log(`  enabled ${GLOW.enabled}  radius ${GLOW.radius}  gain ${GLOW.gain}  alpha ${GLOW.alpha}`);
console.log(`  push ${GLOW.push}  swirl ${GLOW.swirl}  wave ${GLOW.wave}  spin ${GLOW.spin}`);
console.log(`  attack ${GLOW.attack}/s  release ${GLOW.release}/s  slots ${TOUCH_SLOTS}`);
for (let i = 0; i < GLOW.fingers.length; i++) {
  const f = GLOW.fingers[i];
  console.log(`  finger ${i}: #${f.color.toString(16).padStart(6, '0')}  power ${f.power}  spread ${f.spread}`);
}

// --- a canvas that only does what initInput asks of it ----------------------
// 400x800 at the origin, so NDC works out in round numbers: (200,400) is dead
// centre, (400,0) is the top-right corner.
const RECT = { left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800 };
const handlers = {};
const canvas = {
  addEventListener(type, fn) { handlers[type] = fn; },
  getBoundingClientRect: () => RECT,
};
initInput(canvas);

const noop = { preventDefault() {} };
const touchList = (...ts) => ts.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY }));
const fire = (type, ...ts) => handlers[type]({ ...noop, changedTouches: touchList(...ts) });
const slotOf = (id) => touchSlots.findIndex((s) => s.id === id);

// ---------------------------------------------------------------------------
section('SLOTS — a finger claims one, and keeps it');
// ---------------------------------------------------------------------------

fire('touchstart', [10, 100, 600]);
fire('touchstart', [11, 300, 600]);
fire('touchstart', [12, 300, 200]);

check('first finger down takes slot 0', slotOf(10) === 0);
check('second takes slot 1', slotOf(11) === 1);
check('third takes slot 2', slotOf(12) === 2);
check('slots past the live fingers stay free',
  touchSlots.slice(3).every((s) => s.id === null));

check('centre of the canvas is NDC (0, 0)',
  (() => { fire('touchstart', [99, 200, 400]); const s = touchSlots[slotOf(99)];
    const ok = near(s.x, 0) && near(s.y, 0); fire('touchend', [99, 200, 400]); return ok; })());
check('top-right corner is NDC (+1, +1) — y is flipped out of screen space',
  (() => { fire('touchstart', [98, 400, 0]); const s = touchSlots[slotOf(98)];
    const ok = near(s.x, 1) && near(s.y, 1); fire('touchend', [98, 400, 0]); return ok; })());

fire('touchmove', [11, 320, 640]);
check('a move follows the finger that moved',
  near(touchSlots[1].x, (320 / 400) * 2 - 1) && near(touchSlots[1].y, -((640 / 800) * 2 - 1)));
check('...and leaves the others alone',
  near(touchSlots[0].x, (100 / 400) * 2 - 1) && near(touchSlots[0].y, -((600 / 800) * 2 - 1)));

// The reason slots are lowest-free rather than a running counter: without it,
// lifting and re-planting a thumb walks it up through the palette and the grid
// changes colour under a finger the player never moved.
const wasX = touchSlots[0].x;
fire('touchend', [10, 100, 600]);
check('a lift frees the slot', touchSlots[0].id === null);
check('...but leaves the position behind for the fade-out', near(touchSlots[0].x, wasX));
fire('touchstart', [13, 120, 620]);
check('a re-plant takes the SAME slot back, not the next one up', slotOf(13) === 0);
check('the other fingers keep their slots through it', slotOf(11) === 1 && slotOf(12) === 2);

fire('touchstart', [14, 50, 700]);
fire('touchstart', [15, 350, 700]);
check('a full hand fills every slot', touchSlots.every((s) => s.id !== null));
fire('touchstart', [16, 200, 700]);
check('a finger past the last slot is ignored rather than stealing one',
  slotOf(16) === -1 && slotOf(13) === 0 && slotOf(15) === 4);

fire('touchcancel', [12, 300, 200]);
check('touchcancel frees a slot the same as a lift', slotOf(12) === -1);

clearPendingInput();
check('a fresh run starts with no fingers held', touchSlots.every((s) => s.id === null));

// ---------------------------------------------------------------------------
section('STICKS — the two thumbs still steer');
// ---------------------------------------------------------------------------
// The slot registry runs alongside the stick roles rather than through them, so
// this is the check that it stayed alongside.

fire('touchstart', [20, 100, 400]);
fire('touchmove', [20, 100, 300]); // push up in the left (movement) half
input.move.set(0, 0);
const camera = new THREE.OrthographicCamera();
camera.position.set(0, 0, 40);
camera.left = bounds.left;
camera.right = bounds.right;
camera.top = bounds.top;
camera.bottom = bounds.bottom;
camera.near = -100;
camera.far = 200;
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
// updateInput is imported lazily through the module namespace so the stick read
// happens with the same camera the grid uses below.
const { updateInput } = await import('../path/src/input.js');
updateInput(camera, new THREE.Vector3(0, 0, 0));
check('a thumb dragged up the left half still drives the move stick',
  input.move.y > 0.5, `move.y = ${input.move.y.toFixed(2)}`);
check('...and lights a slot at the same time', slotOf(20) === 0);
clearPendingInput();

// ---------------------------------------------------------------------------
section('GLOW — slots become uniforms');
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
const grid = createGrid(scene);
const at = new THREE.Vector3(0, 0, 0);
const vel = new THREE.Vector3(0, 0, 0);
const step = (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) grid.update(dt, at, vel, camera); };
const uni = () => scene.children.find((c) => c.isLineSegments).material.uniforms;

check(`the shader loops over exactly ${TOUCH_SLOTS} fingers, the same number input.js hands out`,
  uni().uTouch.value.length === TOUCH_SLOTS && uni().uTouchColor.value.length === TOUCH_SLOTS);

step();
check('no fingers down, no glow', uni().uTouch.value.every((u) => u.w === 0));

fire('touchstart', [30, 100, 600]);
fire('touchstart', [31, 300, 600]);
step(1 / 60, 30); // half a second — long enough for the attack to land

const u0 = uni().uTouch.value[0];
const u1 = uni().uTouch.value[1];
check('the first finger lights slot 0 to its own power',
  near(u0.w, GLOW.fingers[0].power, 0.02), `w = ${u0.w.toFixed(3)}`);
check('the second lights slot 1 to a DIFFERENT power',
  near(u1.w, GLOW.fingers[1].power, 0.02) && GLOW.fingers[0].power !== GLOW.fingers[1].power,
  `w = ${u1.w.toFixed(3)}`);
check('each finger carries its own colour into the shader',
  uni().uTouchColor.value[0].getHex() === GLOW.fingers[0].color &&
  uni().uTouchColor.value[1].getHex() === GLOW.fingers[1].color);
check('every finger in the palette is a distinct colour',
  new Set(GLOW.fingers.map((f) => f.color)).size === GLOW.fingers.length);
check('reach is the base radius scaled per finger',
  near(u0.z, GLOW.radius * GLOW.fingers[0].spread, 1e-3) &&
  near(u1.z, GLOW.radius * GLOW.fingers[1].spread, 1e-3));
check('the warp uniform carries push / swirl / wave / spin',
  near(uni().uTouchWarp.value.x, GLOW.push) && near(uni().uTouchWarp.value.y, GLOW.swirl) &&
  near(uni().uTouchWarp.value.z, GLOW.wave) && near(uni().uTouchWarp.value.w, GLOW.spin));
check('the swirl is live, so the lattice shears rather than only bulging',
  GLOW.swirl > 0, `swirl = ${GLOW.swirl}`);

// The screen point, resolved by hand rather than through unproject — an
// orthographic frustum is two multiplies (see world.js projectAt, this is its
// inverse), and computing it the same way the code does would test nothing.
const worldXAt = (ndcX) =>
  camera.position.x + (camera.left + camera.right) / 2 + (ndcX * (camera.right - camera.left)) / (2 * camera.zoom);
const worldYAt = (ndcY) =>
  camera.position.y + (camera.top + camera.bottom) / 2 + (ndcY * (camera.top - camera.bottom)) / (2 * camera.zoom);

check('a finger lands where it is on screen, in the water',
  near(u0.x, worldXAt(touchSlots[0].x), 1e-3) && near(u0.y, worldYAt(touchSlots[0].y), 1e-3),
  `(${u0.x.toFixed(2)}, ${u0.y.toFixed(2)})`);

// ---------------------------------------------------------------------------
section('CAMERA PAN — a still finger stays under the finger');
// ---------------------------------------------------------------------------

const before = u0.x;
camera.position.x += 12;
camera.updateMatrixWorld(true);
step();
check('the world point follows the camera while the touch has not moved',
  near(u0.x, before + 12, 1e-3), `${before.toFixed(2)} -> ${u0.x.toFixed(2)}`);
check('...and is still exactly under the screen position',
  near(u0.x, worldXAt(touchSlots[0].x), 1e-3));
camera.position.x -= 12;
camera.updateMatrixWorld(true);
step();

// ---------------------------------------------------------------------------
section('EASE — nothing pops on or off');
// ---------------------------------------------------------------------------

fire('touchend', [30, 100, 600]);
step(1 / 60, 2);
const mid = u0.w;
check('a lifted finger starts falling', mid < GLOW.fingers[0].power && mid > 0, `w = ${mid.toFixed(3)}`);
step(1 / 60, 90);
check('...and reaches zero rather than lingering', u0.w === 0, `w = ${u0.w}`);
check('a finger still down is untouched by its neighbour lifting',
  near(u1.w, GLOW.fingers[1].power, 0.02));

// A slot freed and immediately re-taken must restart. Otherwise the new finger
// inherits the old one's level and its glow slides across the screen from
// wherever the last finger happened to be.
fire('touchstart', [32, 380, 100]);
step();
check('a new finger in a used slot starts from nothing',
  u0.w < 0.35 * GLOW.fingers[0].power, `w = ${u0.w.toFixed(3)}`);
check('...at its own position, not the last finger\'s',
  near(u0.x, worldXAt(touchSlots[0].x), 1e-3) && !near(u0.x, before, 0.5));

// Framerate independence — the ease is exponential for this reason, and a
// lerp-by-a-constant here would drift apart badly between the two rates.
const levelAfter = (dt, seconds) => {
  clearPendingInput();
  grid.reset();
  step(dt, 4);
  fire('touchstart', [40, 200, 400]);
  step(dt, Math.round(seconds / dt));
  return uni().uTouch.value[0].w;
};
const at60 = levelAfter(1 / 60, 0.1);
const at120 = levelAfter(1 / 120, 0.1);
check('the ease runs at the same speed on a 60Hz phone and a 120Hz one',
  near(at60, at120, 0.02), `${at60.toFixed(3)} vs ${at120.toFixed(3)}`);

clearPendingInput();
grid.reset();
step(1 / 60, 4);
check('reset clears every finger', uni().uTouch.value.every((u) => u.w === 0));

const wasEnabled = CONFIG.grid.touchGlow.enabled;
CONFIG.grid.touchGlow.enabled = false;
fire('touchstart', [50, 200, 400]);
step(1 / 60, 30);
check('the tuner switch really turns it off', uni().uTouch.value.every((u) => u.w === 0));
CONFIG.grid.touchGlow.enabled = wasEnabled;
clearPendingInput();
step(1 / 60, 60);

// ---------------------------------------------------------------------------
section('SHADER — the uniforms it declares are the ones it is given');
// ---------------------------------------------------------------------------

const mat = scene.children.find((c) => c.isLineSegments).material;
for (const [name, src] of [['vertex', mat.vertexShader], ['fragment', mat.fragmentShader]]) {
  check(`the ${name} shader is compiled for ${TOUCH_SLOTS} fingers`,
    new RegExp(`#define MAX_TOUCH ${TOUCH_SLOTS}\\b`).test(src));
  for (const [decl, key] of Object.entries({
    'uniform vec4 uTouch\\[MAX_TOUCH\\]': 'uTouch',
    ...(name === 'vertex'
      ? { 'uniform vec4 uTouchWarp': 'uTouchWarp' }
      : { 'uniform vec3 uTouchColor\\[MAX_TOUCH\\]': 'uTouchColor', 'uniform vec2 uTouchGain': 'uTouchGain' }),
  })) {
    check(`  ${name}: ${key} is declared and supplied`,
      new RegExp(decl).test(src) && mat.uniforms[key] !== undefined);
  }
}
check('the vertex shader disrupts the lattice — radial shove AND tangential shear',
  /uTouchWarp\.x/.test(mat.vertexShader) && /vec2\(-dir\.y, dir\.x\)/.test(mat.vertexShader));
check('the glow is measured per fragment against the DISPLACED position',
  /distance\(vPos, uTouch\[i\]\.xy\)/.test(mat.fragmentShader));
check('the glow is cut off at the water line with the rest of the grid',
  /fingerAmt \* uTouchGain\.y \* mask/.test(mat.fragmentShader));

// ---------------------------------------------------------------------------
section('COLOUR — five fingers you can actually tell apart');
// ---------------------------------------------------------------------------
// The fragment's finger maths, on the CPU. This is NOT a test of the shader —
// tools/grid-shader-check.mjs puts the real source in front of a real driver
// for that. It is a test of the NUMBERS in CONFIG, and of one specific way this
// feature can be pointless while every other check passes: the composite is LDR
// with no tonemapping (a glow over 1.0 lands as white), so a gain set by eye can
// clip all five fingers to the same white smudge. Colour is the only thing that
// says which finger is which, and five identical smudges say nothing.

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const base = new THREE.Color(CONFIG.grid.color);
// Where the glow is doing its job: inside the disc, outside the hot core. The
// centre is allowed to blow out — that IS the core — but this ring is what the
// player actually sees the colour of.
const READ_AT = 0.35;

const swatch = GLOW.fingers.map((f) => {
  const radius = GLOW.radius * (f.spread ?? 1);
  let fall = smoothstep(radius, 0, READ_AT * radius);
  fall *= fall;
  const amt = fall * (f.power ?? 1);
  const c = new THREE.Color(f.color);
  return {
    hex: f.color.toString(16).padStart(6, '0'),
    rgb: [
      base.r + c.r * amt * GLOW.gain,
      base.g + c.g * amt * GLOW.gain,
      base.b + c.b * amt * GLOW.gain,
    ],
  };
});
for (const s of swatch) {
  console.log(`  #${s.hex} at ${READ_AT} of its reach -> rgb(${s.rgb.map((v) => v.toFixed(2)).join(', ')})`);
}

check('no finger has washed out to white where it is read',
  swatch.every((s) => s.rgb.some((v) => v < 0.95)),
  swatch.filter((s) => s.rgb.every((v) => v >= 0.95)).map((s) => '#' + s.hex).join(' ') || 'all keep a hue');

let worstPair = { d: Infinity, a: '', b: '' };
for (let i = 0; i < swatch.length; i++) {
  for (let j = i + 1; j < swatch.length; j++) {
    const d = Math.max(...[0, 1, 2].map((k) =>
      Math.abs(Math.min(1, swatch[i].rgb[k]) - Math.min(1, swatch[j].rgb[k]))));
    if (d < worstPair.d) worstPair = { d, a: swatch[i].hex, b: swatch[j].hex };
  }
}
check('every pair of fingers is separable AFTER the LDR clip',
  worstPair.d >= 0.08,
  `closest pair #${worstPair.a} / #${worstPair.b}, ${worstPair.d.toFixed(3)} apart`);

check('the glow brightens through opacity as well as colour, so heat is not all hue',
  GLOW.alpha > 0);
check('later fingers hit harder than earlier ones',
  GLOW.fingers.every((f, i) => i === 0 || f.power >= GLOW.fingers[i - 1].power));

console.log(failures === 0 ? '\nAll touch-glow checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
