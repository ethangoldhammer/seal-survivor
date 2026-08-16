#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:touchaim
//
// WHERE A PHONE IS POINTING. The aim half of the screen is a POINTER, not a
// stick: the seal aims from its own position at the world point under the
// fingertip, exactly the way it aims at a mouse cursor.
//
// It used to be a stick — direction and magnitude of the DRAG away from
// wherever the thumb landed. That reads fine in a screenshot and is wrong in
// the hand, because the line it draws starts at the anchor: an invisible point,
// chosen by accident, that is nowhere near the seal. Plant low, drag up-right,
// and the seal pointed up-right no matter where on the glass the thumb actually
// ended up. Nothing about the picture on screen predicted the heading.
//
// Everything here is a screen-to-world question, which is why this is a Node
// harness and not a look at a phone: the answers are geometry and can be
// derived, and the interesting failures (a stale player position, a thumb that
// re-aims when the camera pans, a rect of zeros) all produce a picture that
// looks perfectly plausible in a still frame.
//
// The canvas is a stub with a REAL rect — 400x800 at the origin — because the
// rect is half the arithmetic under test. The camera is orthographic and 40
// world units across, so NDC +1 is world +20 and every expectation below can be
// worked out by hand.
//
// What it cannot tell you: whether the aim half is big enough for a thumb, or
// whether the seal being under your own hand is a problem. That is a phone.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { initInput, updateInput, input, clearPendingInput } from '../path/src/input.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const aimStr = () => `aim (${input.aim.x.toFixed(3)}, ${input.aim.y.toFixed(3)})`;
// The heading a player at `from` should end up with when the fingertip lands on
// world point (wx, wy). Derived rather than typed so a camera change can't quietly
// turn a wrong answer into an expected one.
const heading = (wx, wy, from = { x: 0, y: 0 }) =>
  new THREE.Vector2(wx - from.x, wy - from.y).normalize();
const aimIs = (v) => near(input.aim.x, v.x) && near(input.aim.y, v.y);

// --- the canvas, with a rect that is actually a rect ------------------------
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

// Screen px → world, for the camera below. This is the transform under test
// stated independently: NDC from the rect, then the orthographic half-extents.
const HALF = 20;
const worldAt = (px, py) => ({
  x: (((px - RECT.left) / RECT.width) * 2 - 1) * HALF + camera.position.x,
  y: -(((py - RECT.top) / RECT.height) * 2 - 1) * HALF + camera.position.y,
});

const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 0.1, 100);
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);

const player = new THREE.Vector3(0, 0, 0);
const frame = () => updateInput(camera, player);

console.log(`Canvas ${RECT.width}x${RECT.height}, camera ${HALF * 2} world units across.`);
console.log(`CONFIG.touch: splitX ${CONFIG.touch.splitX}  stickRadius ${CONFIG.touch.stickRadius}px  deadzone ${CONFIG.touch.deadzone}px`);
console.log(`  aimFollowsMove ${CONFIG.touch.aimFollowsMove}`);

// ---------------------------------------------------------------------------
section('THE LINE RUNS FROM THE PLAYER TO THE FINGERTIP');
// ---------------------------------------------------------------------------
{
  // Right half, above centre. World (10, 15) with the player at the origin.
  fire('touchstart', [1, 300, 100]);
  frame();
  const w = worldAt(300, 100);
  check('a thumb up and to the right aims up and to the right',
    aimIs(heading(w.x, w.y)), `${aimStr()} for world (${w.x}, ${w.y})`);
  check('...and that counts as aiming', input.aiming === true);

  // Straight out to the right of the player: y must be exactly zero, which is
  // the one direction a rounding error in the rect maths cannot hide in.
  fire('touchmove', [1, 300, 400]);
  frame();
  check('a thumb level with the player aims flat', near(input.aim.y, 0) && near(input.aim.x, 1),
    aimStr());

  fire('touchmove', [1, 300, 700]);
  frame();
  const down = worldAt(300, 700);
  check('a thumb below the player aims down', aimIs(heading(down.x, down.y)) && input.aim.y < 0,
    aimStr());

  fire('touchend', [1, 300, 700]);
}

// ---------------------------------------------------------------------------
section('THE ANCHOR IS NOT PART OF THE ANSWER');
// ---------------------------------------------------------------------------
{
  // The regression. Same fingertip, two completely different landings: under
  // the old stick reading these gave opposite headings, because the heading was
  // the DRAG. Now the anchor is not consulted at all.
  fire('touchstart', [2, 390, 700]); // landed low-right, dragged up-left
  fire('touchmove', [2, 300, 400]);
  frame();
  const dragged = input.aim.clone();

  fire('touchend', [2, 300, 400]);
  fire('touchstart', [3, 210, 120]); // landed high-left, dragged down-right
  fire('touchmove', [3, 300, 400]);
  frame();
  const other = input.aim.clone();

  check('two opposite drags ending on the same spot give the same heading',
    near(dragged.x, other.x) && near(dragged.y, other.y),
    `(${dragged.x.toFixed(3)}, ${dragged.y.toFixed(3)}) vs (${other.x.toFixed(3)}, ${other.y.toFixed(3)})`);
  check('...and that heading is the one the fingertip names, not the drag',
    near(dragged.x, 1) && near(dragged.y, 0),
    `${aimStr()} — the drag was up-left`);

  // A thumb that lands and never moves is inside the old deadzone, so the old
  // code read it as centred and did not aim at all. A fingertip resting on the
  // glass is already naming a point.
  fire('touchend', [3, 300, 400]);
  fire('touchstart', [4, 340, 240]);
  frame();
  const still = worldAt(340, 240);
  check('a thumb that has not moved since it landed still aims',
    input.aiming === true && aimIs(heading(still.x, still.y)), aimStr());

  fire('touchend', [4, 340, 240]);
}

// ---------------------------------------------------------------------------
section('IT IS RECOMPUTED EVERY FRAME, FROM LIVE POSITIONS');
// ---------------------------------------------------------------------------
{
  // The seal swims out from under its own aim. A heading cached at touchdown
  // looks right in a screenshot and points at nothing a second later.
  fire('touchstart', [5, 300, 400]);
  frame();
  check('level with the player, the thumb aims flat right', near(input.aim.y, 0), aimStr());

  player.set(0, 12, 0);
  frame();
  const w = worldAt(300, 400);
  check('the player swimming north re-points the same thumb south',
    aimIs(heading(w.x, w.y, player)) && input.aim.y < 0, aimStr());

  // The camera follows the seal, so a thumb held perfectly still is over a
  // different piece of ocean every frame — the screen point is fixed, the world
  // point under it is not.
  camera.position.set(0, 12, 10);
  camera.updateMatrixWorld(true);
  frame();
  const panned = worldAt(300, 400);
  check('panning the camera moves the world point under a motionless thumb',
    aimIs(heading(panned.x, panned.y, player)) && near(input.aim.y, 0),
    `${aimStr()} for world (${panned.x}, ${panned.y})`);

  // Straight through the seal: there is no direction in a zero-length line, so
  // the previous heading stands rather than snapping to whichever way the
  // subtraction rounded.
  const before = input.aim.clone();
  fire('touchmove', [5, 200, 400]); // dead centre of the canvas = the camera = the player
  player.set(worldAt(200, 400).x, worldAt(200, 400).y, 0);
  frame();
  check('a thumb resting exactly on the seal holds the last heading',
    aimIs(before), `${aimStr()} vs (${before.x.toFixed(3)}, ${before.y.toFixed(3)})`);

  fire('touchend', [5, 200, 400]);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);
  player.set(0, 0, 0);
}

// ---------------------------------------------------------------------------
section('THE OTHER HALF IS STILL A STICK');
// ---------------------------------------------------------------------------
{
  clearPendingInput();
  // Left half: this thumb steers, and steering is still deflection from where
  // it landed. Nothing about absolute aim reaches it.
  fire('touchstart', [6, 100, 400]);
  fire('touchmove', [6, 100, 300]); // 100px up, past full deflection
  frame();
  check('a left-half thumb dragged up swims up', near(input.move.x, 0) && input.move.y > 0.9,
    `move (${input.move.x.toFixed(3)}, ${input.move.y.toFixed(3)})`);
  check('...and with no aim thumb down, the seal faces where it is swimming',
    near(input.aim.y, 1), aimStr());
  check('...which is not aiming — it is just not swimming backwards',
    input.aiming === false);

  // Both thumbs down: they do different jobs and neither leaks into the other.
  fire('touchstart', [7, 300, 700]);
  frame();
  const w = worldAt(300, 700);
  check('with both down, movement still comes from the left thumb',
    input.move.y > 0.9, `move (${input.move.x.toFixed(3)}, ${input.move.y.toFixed(3)})`);
  check('...and aim comes only from the right one — swimming up, aiming down',
    aimIs(heading(w.x, w.y)) && input.aim.y < 0, aimStr());

  // Lifting the aim thumb hands the heading back to travel, rather than leaving
  // the seal pointing at the last place a finger happened to be.
  fire('touchend', [7, 300, 700]);
  frame();
  check('lifting the aim thumb points the seal back along its travel',
    near(input.aim.y, 1), aimStr());

  fire('touchend', [6, 100, 300]);
  frame();
  check('lifting everything holds the last heading', near(input.aim.y, 1), aimStr());
}

// ---------------------------------------------------------------------------
section('A CANVAS WITH NO SIZE AIMS NOWHERE');
// ---------------------------------------------------------------------------
{
  // First frame after a rotate, or a canvas measured before layout: the rect is
  // all zeros. Dividing by it puts every touch at NDC (-1, 1) — the top-left
  // corner — and the seal snaps there for a frame with nothing to show for it.
  clearPendingInput();
  fire('touchstart', [8, 300, 100]);
  frame();
  const real = input.aim.clone();

  const w = RECT.width, h = RECT.height;
  RECT.width = 0; RECT.height = 0;
  fire('touchmove', [8, 320, 120]);
  frame();
  check('an unmeasured canvas leaves the heading alone', aimIs(real), aimStr());
  RECT.width = w; RECT.height = h;

  fire('touchend', [8, 320, 120]);
  clearPendingInput();
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
