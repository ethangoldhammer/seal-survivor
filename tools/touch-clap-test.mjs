#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:touchclap
//
// THE SEAL IS THE CLAP BUTTON on a phone. There is no X to press and no key to
// hold, so the gesture goes on the one thing the player is already looking at:
// touch the animal and it claps — or salutes, in front of a headstone, exactly
// as the key and the pad button do (systems/salute.js decides which).
//
// Two things here are worth a harness rather than a look at a phone, because
// both fail INVISIBLY — the picture is fine and something else is wrong:
//
//   1. IT FIRES ON THE WAY DOWN. The whole design of systems/clap.js is about
//      latency (it will not even play an anticipation, because a wind-up reads
//      as the input being late). A finger is on the glass for 60-150ms, so a
//      clap raised on the LIFT is uniformly behind the beat — and a video of
//      it looks exactly like a clap that is on time.
//   2. IT MUST NOT ARM THE DOUBLE-TAP STRIKE. Tap-then-press in one half is
//      the phone's boost (CONFIG.touch.strike.doubleTap). Without the guard,
//      clapping to a beat charges a dash on every second tap and LAUNCHES it
//      on the lift: a real shove out of a gesture that has no business moving
//      the animal, and on screen it is just the seal wandering.
//
// The circle over the seal is published by main.js, which owns the camera —
// see sealTapCircle there. What is under test is the other side of that
// contract: given a circle, which contacts are claps and what a clap costs the
// rest of the touch vocabulary. The canvas is a stub with a REAL rect, 400x800,
// so a coordinate below can be read off the page.
//
// What it cannot tell you: whether the circle main.js publishes is the right
// size for a thumb. That is a phone.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { initInput, updateInput, input, clearPendingInput, setSealTapTarget } from '../path/src/input.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

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

const HALF = 20;
const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 0.1, 100);
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);
const player = new THREE.Vector3(0, 0, 0);
const frame = () => updateInput(camera, player);

// The seal, in the middle of the glass where the camera keeps it. Its centre
// sits exactly on splitX, so the circle straddles both halves — which is the
// real geometry, and the reason the guards below have to hold on either side.
const SEAL = { x: 200, y: 400, r: 46 };
// Far from the animal and in the MOVE half, for the controls: everything the
// seal takes away from the strike has to still work out here.
const AWAY = [80, 620];

// A fresh hand — no fingers down, no tap armed, nothing half-pressed.
function reset(target = SEAL) {
  fire('touchcancel', [1, 0, 0], [2, 0, 0], [3, 0, 0]);
  clearPendingInput();
  frame();
  setSealTapTarget(target);
}

console.log(`Canvas ${RECT.width}x${RECT.height}, splitX ${CONFIG.touch.splitX} (move half is x < ${RECT.width * CONFIG.touch.splitX}).`);
console.log(`Seal target (${SEAL.x}, ${SEAL.y}) r ${SEAL.r}px.  CONFIG.touch.clap:`, CONFIG.touch.clap);

// ---------------------------------------------------------------------------
section('A TOUCH ON THE ANIMAL CLAPS, ON THE FRAME IT LANDS');
// ---------------------------------------------------------------------------
{
  reset();
  fire('touchstart', [1, 210, 400]);
  frame();
  check('a finger on the seal raises the clap', input.clap === true);
  frame();
  check('...for exactly one frame', input.clap === false);
  fire('touchend', [1, 210, 400]);
  frame();
  check('...and the lift does not raise a second one', input.clap === false);

  // The other half of "on the way down": the clap above happened with the
  // finger still on the glass, which the lift-then-check above cannot prove on
  // its own. This one never lifts at all.
  reset();
  fire('touchstart', [2, 190, 380]);
  frame();
  check('the clap is there with the finger still down', input.clap === true);
  fire('touchend', [2, 190, 380]);
}

// ---------------------------------------------------------------------------
section('...AND ONLY ON THE ANIMAL');
// ---------------------------------------------------------------------------
{
  reset();
  fire('touchstart', [1, SEAL.x + SEAL.r + 8, SEAL.y]);
  frame();
  check('a finger just outside the circle does not clap', input.clap === false);
  fire('touchend', [1, SEAL.x + SEAL.r + 8, SEAL.y]);

  reset();
  fire('touchstart', [1, ...AWAY]);
  frame();
  check('a thumb on the open water does not clap', input.clap === false);
  fire('touchend', [1, ...AWAY]);

  // The edge is inclusive, and it is checked because an off-by-one here is a
  // dead ring of pixels nobody would ever find by hand.
  reset();
  fire('touchstart', [1, SEAL.x + SEAL.r, SEAL.y]);
  frame();
  check('the rim of the circle is on the seal', input.clap === true);
  fire('touchend', [1, SEAL.x + SEAL.r, SEAL.y]);
}

// ---------------------------------------------------------------------------
section('NO TARGET, NO BUTTON');
// ---------------------------------------------------------------------------
// main.js publishes null whenever the seal is not a thing to be touched — the
// menu (where a press on the bust already cycles its outfit), a pause, a death.
// The gesture has to be gone in that state rather than aimed at a stale circle.
{
  reset(null);
  fire('touchstart', [1, 200, 400]);
  frame();
  check('with no target published, the middle of the screen is not a button', input.clap === false);
  fire('touchend', [1, 200, 400]);

  reset();
  const was = CONFIG.touch.clap.enabled;
  CONFIG.touch.clap.enabled = false;
  fire('touchstart', [1, 200, 400]);
  frame();
  check('the switch turns it off outright', input.clap === false);
  fire('touchend', [1, 200, 400]);
  CONFIG.touch.clap.enabled = was;
}

// ---------------------------------------------------------------------------
section('A CLAP IS NOT THE FIRST HALF OF A BOOST');
// ---------------------------------------------------------------------------
// The one that matters. Tap, then press and hold, is the phone's strike — and
// clapping to a beat is exactly that shape, twice a second.
{
  // The control first, so a guard that simply broke the double-tap everywhere
  // fails here rather than passing silently below.
  reset();
  fire('touchstart', [1, ...AWAY]);
  fire('touchend', [1, ...AWAY]);
  frame();
  fire('touchstart', [2, ...AWAY]);
  frame();
  check('off the seal, tap-then-hold still charges a strike', input.strikeHeld === true);
  fire('touchend', [2, ...AWAY]);
  frame();
  check('...and letting go launches it', input.strikeRelease === true);

  reset();
  fire('touchstart', [1, 190, 400]);
  fire('touchend', [1, 190, 400]);
  frame();
  fire('touchstart', [2, 190, 400]);
  frame();
  check('on the seal, the second tap claps again', input.clap === true);
  check('...and charges nothing', input.strikeHeld === false);
  fire('touchend', [2, 190, 400]);
  frame();
  check('...so the lift launches nothing', input.strikeRelease === false);
}

// ---------------------------------------------------------------------------
section('A SECOND FINGER ON THE ANIMAL IS A CLAP, NOT A BOOST');
// ---------------------------------------------------------------------------
// The other strike route: any finger beyond the two sticks charges for as long
// as it is down. A clap has to be able to happen with a thumb already steering,
// which is most of a run.
{
  reset();
  fire('touchstart', [1, ...AWAY]);        // the steering thumb
  frame();
  fire('touchstart', [2, 60, 700]);        // a second finger, off the seal
  frame();
  check('a third touch off the seal charges, as it always did', input.strikeHeld === true);
  fire('touchend', [2, 60, 700]);

  reset();
  fire('touchstart', [1, ...AWAY]);
  frame();
  fire('touchstart', [2, 195, 410]);       // ...and one on the seal
  frame();
  check('a second finger on the seal claps', input.clap === true);
  check('...and does not charge', input.strikeHeld === false);
  fire('touchend', [2, 195, 410]);
  frame();
  check('...so nothing launches when it lifts', input.strikeRelease === false);
  fire('touchend', [1, ...AWAY]);
}

// ---------------------------------------------------------------------------
section('A THUMB THAT LANDS ON THE SEAL STILL STEERS');
// ---------------------------------------------------------------------------
// The floating stick's anchor is wherever the thumb goes down, and the seal is
// in the middle of the glass — so a plant on the animal is an ordinary thing to
// do. It claps once and then it is a stick like any other.
{
  reset();
  fire('touchstart', [1, 190, 400]);
  frame();
  check('the plant claps', input.clap === true);
  fire('touchmove', [1, 190 - CONFIG.touch.stickRadius, 400]);
  frame();
  check('...and dragging it left still swims left',
    input.move.x < -0.9, `move (${input.move.x.toFixed(2)}, ${input.move.y.toFixed(2)})`);
  fire('touchend', [1, 190 - CONFIG.touch.stickRadius, 400]);
  frame();
  // A drag is not a tap, so this arms nothing either way — but it is the one
  // press that has BOTH reasons not to, and a guard that only looked at the
  // drift would still be wrong about it.
  fire('touchstart', [2, 190 - CONFIG.touch.stickRadius, 400]);
  frame();
  check('...and the drag arms no strike behind it', input.strikeHeld === false);
  fire('touchend', [2, 190 - CONFIG.touch.stickRadius, 400]);
}

// ---------------------------------------------------------------------------
section('THE AIM HALF IS NO DIFFERENT');
// ---------------------------------------------------------------------------
// The seal sits on the split, so the same circle is reachable from the pointer
// half — and the pointer half is where a right-handed player's spare finger is.
{
  reset();
  fire('touchstart', [1, 215, 405]);
  frame();
  check('a finger on the seal from the aim side claps', input.clap === true);
  fire('touchend', [1, 215, 405]);
  frame();
  fire('touchstart', [2, 215, 405]);
  frame();
  check('...and pairs into no strike there either', input.strikeHeld === false);
  fire('touchend', [2, 215, 405]);
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
