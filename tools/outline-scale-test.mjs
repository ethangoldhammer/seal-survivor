#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:rimscale
//
// THE RIM HOLDS ITS PIXELS WHEN THE LENS MOVES.
//
// Every outline width in the game is a WORLD number — CONFIG.playerOutline
// .thickness, CONFIG.creatureOutline.thickness, a boat's outlineThickness — and
// left at that a rim is a different line every time the camera moves. The death
// dive pushes to 3.5x, the menu crops to whatever the hex row needs, a
// Blubberball replay flies a perspective camera in to arm's length. At each of
// those the one line whose whole job is to make the animal findable was quietly
// retuned, and it got FATTER exactly when the screen was fullest.
//
// So the shader multiplies every rim by a factor taken off the camera each
// frame (assets.js setOutlineViewFactor, systems/outlines.js
// updateOutlineScale), and this is the arithmetic behind it. It is worth a
// harness rather than an eye because both ways of getting it wrong look
// deliberate: an inverted factor is a rim that swells on a push-in, which is
// what it did before, and a factor of the wrong magnitude is simply a rim you
// would retune the config to fix — hiding the bug in the number.
//
// THE ONE FACT EVERYTHING ELSE HANGS OFF: at the framing the numbers were
// authored at, the factor is exactly 1. Not near 1. If it were 0.98 this change
// would have silently restyled all 40-odd rims in the game on the frame it
// landed, and no test anywhere would have said so.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { outlineViewFactor, resetOutlineViewFactor } from '../path/src/assets.js';
import { updateOutlineScale } from '../path/src/systems/outlines.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// The run's camera, near enough: an orthographic frustum whose height is the
// reference every rim in CONFIG was tuned against.
const REF = 60;
function ortho(zoom) {
  const c = new THREE.OrthographicCamera(-40, 40, REF / 2, -REF / 2, 0.1, 1000);
  c.zoom = zoom;
  return c;
}

// --- the framing the numbers were authored at -------------------------------
updateOutlineScale(ortho(1), REF);
let f = outlineViewFactor();
check('zoom 1 is EXACTLY 1 — not one authored width moves', f.flat === 1 && f.perDepth === 0,
  `${f.flat}, ${f.perDepth}`);

// --- pushing in -------------------------------------------------------------
updateOutlineScale(ortho(2), REF);
f = outlineViewFactor();
check('a 2x push-in halves the world width (so the pixels hold)', near(f.flat, 0.5));
updateOutlineScale(ortho(3.5), REF);
f = outlineViewFactor();
check('...and the death dive’s 3.5x is 1/3.5', near(f.flat, 1 / 3.5));

// A zoom BELOW 1 is the versus camera pulling back to hold both seals
// (CONFIG.versus.camera.zoomMin), and it has to go the other way — a rim that
// only ever shrank would vanish at exactly the moment the frame got busiest.
updateOutlineScale(ortho(0.5), REF);
f = outlineViewFactor();
check('pulling back FATTENS the world width', near(f.flat, 2));

// Nothing depth-dependent, ever, on an orthographic frame: a creature at the
// back of the arena and one at the front are the same distance in pixels.
updateOutlineScale(ortho(2), REF);
check('an orthographic frame has no per-depth term', outlineViewFactor().perDepth === 0);

// --- the replay's perspective camera ----------------------------------------
// A perspective frame has no fixed world-per-pixel at all, so the WHOLE factor
// is the per-depth term. The test is the distance at which that camera frames
// exactly the reference height: there, and only there, the rim must come out at
// the width the config authored.
const persp = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 600);
updateOutlineScale(persp, REF);
f = outlineViewFactor();
check('a perspective frame is nothing but depth', f.flat === 0 && f.perDepth > 0);
const matched = (REF / 2) / Math.tan((40 * Math.PI) / 360);
check('at the distance that frames the reference height, the factor is 1',
  near(f.perDepth * matched, 1, 1e-12), String(f.perDepth * matched));
check('half that distance is half the width — twice as close, same pixels',
  near(f.perDepth * (matched / 2), 0.5, 1e-12));

// A LONGER LENS AT THE SAME DISTANCE IS A PUSH-IN, and it has to read as one.
// The pool changes `fov` rather than moving the camera for most of its shots
// (systems/replayCams.js fovPush), so a factor that only watched position would
// hold still through the one move the replays actually make.
const tight = new THREE.PerspectiveCamera(20, 16 / 9, 0.5, 600);
updateOutlineScale(tight, REF);
const tightF = outlineViewFactor().perDepth * matched;
check('a tighter lens thins the rim at the same distance', tightF < 1, String(tightF));

// --- the surfaces that compose their own framing ----------------------------
// The level-up bust draws through a camera on which one world unit IS one CSS
// pixel and asks for its rim in pixels outright, so it resets rather than being
// handed a factor it would have to divide back out (systems/levelUpSeal.js).
resetOutlineViewFactor();
f = outlineViewFactor();
check('the reset is the identity — the rim the game drew before this existed',
  f.flat === 1 && f.perDepth === 0);

// ...and no camera, or a reference of zero, is that same identity rather than a
// division by nothing. A harness or a look page that never calls this gets the
// untouched world-unit rim.
updateOutlineScale(ortho(2), REF);
updateOutlineScale(null, REF);
f = outlineViewFactor();
check('no camera falls back to the identity', f.flat === 1 && f.perDepth === 0);
updateOutlineScale(ortho(2), 0);
f = outlineViewFactor();
check('no reference framing falls back to the identity', f.flat === 1 && f.perDepth === 0);

console.log(failures ? `\n${failures} FAILED` : '\nthe rim holds its pixels');
process.exitCode = failures ? 1 : 0;
