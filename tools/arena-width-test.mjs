#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:width
//
// The expanded arena. `arena.widthScale` pushes the walls out past the frame so
// there is ocean to swim into rather than a wall at the edge of the screen, and
// `arena.airScale` raises the ceiling off it so a breach is not caught by a lid
// nine units over the water. Nine things are checked, each one a bug with a
// plausible way of happening:
//
//   1. NEUTRAL   At widthScale 1 the arena IS the frame, at every aspect. This
//                is the only check that protects the shipped game: everything
//                else here describes a mode nobody is in by default, and a
//                regression that widened the arena unconditionally would sail
//                past all of them.
//   2. WALLS     Above 1 the walls move and the FRAME DOES NOT. Coupling the
//                frustum to the walls is the obvious wrong implementation —
//                it looks right in a screenshot (you can see more ocean) and
//                is just the old zoom-out with extra steps.
//   3. REACH     Driving the real clampToArena: the seal is actually stopped
//                at the new wall. bounds moving is not the same as the wall
//                moving, and the physics reads a different function.
//   4. PAN       The camera gets somewhere to go. A widened arena the camera
//                cannot follow into is a seal that swims off screen, so the
//                room to pan has to grow with the walls.
//   5. FRAMING   The sun's arc is hung off the FRAME, not the arena. It reads
//                bounds like everything else, so a widened ocean would quietly
//                swing sunrise out past where the camera can reach and the
//                disc would only ever be seen near noon.
//   6. TRAVERSE  What it buys, through the real updatePlayer: how long a
//                flat-out crossing takes. This is the number the knob exists
//                for, and it is asserted rather than eyeballed.
//   7. CEILING   A breach clears the lid, driven by the real strike dash. Also
//                pins the ORIGINAL bug in place: at airScale 1 a plain
//                straight-up strike is caught, and that check failing is how
//                you would know the ceiling had been welded shut again.
//   8. SKY       The gradient is measured on the frame while the plane covers
//                the arena. Tying them together is the natural mistake and it
//                does not look like a bug — it looks like a washed-out sky,
//                because the ramp gets stretched over air that is off screen.
//   9. SHORE     The drawn rock face lands where clampToArena actually stops
//                the seal. Off in one direction the seal bounces off open
//                water; off in the other it swims into the cliff.
//
// No renderer, on purpose: the browser preview suspends requestAnimationFrame
// and reports innerWidth 0, so a screenshot proves nothing about the frame.
// Every number below comes from the same functions main.js calls.
//
//   node --import ./tools/vite-loader.mjs tools/arena-width-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds, clampToArena, seabedTopY } from '../path/src/arena.js';
import { skyPlaneMetrics } from '../path/src/systems/sky.js';
import { createWallRocks } from '../path/src/systems/wallRocks.js';
import { dayState, resetDayCycle, advanceClock, updateDayCycle } from '../path/src/systems/daylight.js';
import { player, updatePlayer, recomputeStats, resetPlayer } from '../path/src/entities/player.js';

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const LANDSCAPE = 16 / 9;
const PORTRAIT = 9 / 19.5;
// The MERGED zoom, not the literal in config.js — saved tuning deep-merges over
// the defaults, and the rig's base zoom is what decides how much of the arena
// is on screen and therefore how far the camera is free to pan.
const ZOOM = CONFIG.cinecam?.base?.zoom ?? 1;
const VH = CONFIG.arena.viewHeight;

// Room the camera has to move before the frame runs past a wall. world.js
// spends exactly this, in clampFocus, off the same two numbers.
const panRoom = () => Math.max(0, bounds.right - (bounds.frameWidth / 2) / ZOOM);

function at(widthScale, aspect = LANDSCAPE) {
  CONFIG.arena.widthScale = widthScale;
  return updateBounds(aspect);
}

// ---------------------------------------------------------------------------
section('NEUTRAL — at widthScale 1 the arena is the frame, exactly');

for (const [name, aspect] of [['landscape 16:9', LANDSCAPE], ['phone 9:19.5', PORTRAIT], ['square', 1]]) {
  at(1, aspect);
  check(`${name}: walls flush with the frame`,
    near(bounds.width, VH * aspect) && near(bounds.frameWidth, VH * aspect),
    `${bounds.width.toFixed(2)} wide`);
}
// The two knobs are independent, so this compares vertical ACROSS widthScale
// rather than against a literal — pinning it to `viewHeight * surfaceFromTop`
// would just be re-asserting airScale's default from the other direction.
at(1, LANDSCAPE);
const vert1 = { top: bounds.top, bottom: bounds.bottom, frameTop: bounds.frameTop, height: bounds.height };
at(2.5, LANDSCAPE);
check('widening leaves every vertical number alone',
  near(bounds.top, vert1.top) && near(bounds.bottom, vert1.bottom)
  && near(bounds.frameTop, vert1.frameTop) && near(bounds.height, vert1.height),
  `${bounds.top.toFixed(1)} of air over ${(-bounds.bottom).toFixed(1)} of water, either way`);
check('...and the frame is still viewHeight tall', near(bounds.frameTop - bounds.bottom, VH),
  `${(bounds.frameTop - bounds.bottom).toFixed(1)} vs viewHeight ${VH}`);
// Narrower than the frame would put the walls INSIDE the shot, with bare scene
// background either side of the ocean. The clamp is why the knob has a floor.
at(0.4, LANDSCAPE);
check('below 1 is clamped, never narrower than the frame', near(bounds.width, bounds.frameWidth),
  `widthScale 0.4 -> ${(bounds.width / bounds.frameWidth).toFixed(2)}x frame`);

// ---------------------------------------------------------------------------
section('WALLS — the ocean grows, the frame does not');

const frame1 = at(1).frameWidth;
for (const s of [1.25, 1.5, 2, 3]) {
  at(s);
  check(`x${s}: walls scale, frame holds`,
    near(bounds.width, frame1 * s) && near(bounds.frameWidth, frame1),
    `wall +/-${bounds.right.toFixed(1)}, frame ${bounds.frameWidth.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('REACH — the real wall, through clampToArena');

for (const s of [1, 1.5, 2]) {
  at(s);
  const pos = { x: 1e6, y: -8 };  // launched at the wall from well outside it
  const vel = { x: 40, y: 0 };
  const radius = 1.2;
  const hit = clampToArena(pos, vel, radius, CONFIG.arena.wallRestitution);
  check(`x${s}: stopped at the wall, and bounced`,
    hit && near(pos.x, bounds.right - radius) && vel.x < 0,
    `held at x=${pos.x.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('PAN — the camera has somewhere to follow into');

at(1);
const pan1 = panRoom();
check('at 1, the pan is whatever the rig zoom alone allows', pan1 >= 0,
  `+/-${pan1.toFixed(1)} at zoom ${ZOOM}`);
let lastPan = pan1;
for (const s of [1.25, 1.5, 2]) {
  at(s);
  const p = panRoom();
  check(`x${s}: more room than x${s === 1.25 ? 1 : (s === 1.5 ? 1.25 : 1.5)}`, p > lastPan + 1,
    `+/-${p.toFixed(1)}`);
  lastPan = p;
}
// The seal must never be able to reach ocean the camera cannot bring into
// frame — that is the failure the whole pan exists to prevent.
for (const s of [1, 1.5, 2, 3]) {
  at(s);
  const reachable = panRoom() + (bounds.frameWidth / 2) / ZOOM;
  check(`x${s}: every wall is reachable by the camera`, reachable >= bounds.right - 1e-6,
    `camera reaches ${reachable.toFixed(1)}, wall at ${bounds.right.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('FRAMING — the sun rises at the edge of the SHOT, not the ocean');

function sunSweep(widthScale) {
  at(widthScale);
  resetDayCycle(true);
  const xs = [];
  for (let h = 0; h < 24; h += 2) {
    advanceClock(0); // no-op tick so the clock is where resetDayCycle left it
    CONFIG.dayNight.paused = true;
    CONFIG.dayNight.scrubHour = h;
    updateDayCycle(1 / 60);
    xs.push(dayState.sun.x);
  }
  CONFIG.dayNight.paused = false;
  return xs;
}
const sunNarrow = sunSweep(1);
const sunWide = sunSweep(2);
const peak = (xs) => Math.max(...xs.map(Math.abs));
check('the sun traces the same arc in a doubled ocean',
  sunNarrow.every((x, i) => near(x, sunWide[i], 1e-6)),
  `peak |x| ${peak(sunNarrow).toFixed(1)} at x1 vs ${peak(sunWide).toFixed(1)} at x2`);
check('...and that arc is inside the frame it has to set in',
  Math.max(...sunNarrow.map(Math.abs)) <= bounds.frameWidth / 2 + 1e-6,
  `${Math.max(...sunNarrow.map(Math.abs)).toFixed(1)} vs half-frame ${(bounds.frameWidth / 2).toFixed(1)}`);

// ---------------------------------------------------------------------------
section('TRAVERSE — what the knob actually buys, at real swim speed');

// initPlayer builds a mesh out of loaded assets; the physics only needs the
// transform it writes into, so the harness supplies that and skips the load.
player.mesh = new THREE.Group();
player.body = new THREE.Group();
recomputeStats();

const DT = 1 / 60;
const input = { move: new THREE.Vector2(1, 0), aim: new THREE.Vector2(1, 0) };

function sprintToWall(widthScale, limit = 60) {
  at(widthScale);
  resetPlayer();
  player.mesh.position.set(0, -8, 0);
  player.velocity.set(0, 0);
  for (let t = 0; t < limit; t += DT) {
    updatePlayer(DT, input);
    if (player.mesh.position.x >= bounds.right - (player.stats.hitRadius ?? 1.2) - 0.05) return t;
  }
  return null;
}

const base = sprintToWall(1);
check('a crossing at widthScale 1 is the trip it has always been', base != null && base > 1,
  `${base.toFixed(2)}s at ${player.stats.speed.toFixed(1)} u/s`);
let prev = base;
for (const s of [1.25, 1.5, 2]) {
  const t = sprintToWall(s);
  check(`x${s}: a longer swim than the step below it`, t != null && t > prev + 0.2,
    `${t.toFixed(2)}s (${(t / base).toFixed(2)}x the trip)`);
  prev = t;
}

// ---------------------------------------------------------------------------
section('CEILING — a breach clears the lid, through the real strike dash');

// What main.js does on a strike: velocity <- dashDir * strikeDashSpeed * combo,
// and dashTimer <- the dash duration, which is what raises the speed ceiling in
// updatePlayer for the length of it. Anything less than this launches at swim
// speed and never gets near the lid, which is how a broken ceiling looks fine.
function breach(combo = 1, angleDeg = 90) {
  resetPlayer();
  player.mesh.position.set(0, -2, 0);
  player.comboSpeedMul = combo;
  const a = (angleDeg * Math.PI) / 180;
  const sp = player.stats.strikeDashSpeed * combo;
  player.velocity.set(Math.cos(a) * sp, Math.sin(a) * sp);
  player.dashTimer = CONFIG.strike.dashDuration ?? 0.22;
  const still = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(0, 1) };
  const lid = bounds.top - (player.stats.hitRadius ?? 1);
  let hi = -Infinity, clipped = false;
  for (let t = 0; t < 8; t += DT) {
    updatePlayer(DT, still);
    hi = Math.max(hi, player.mesh.position.y);
    if (player.mesh.position.y >= lid - 1e-3) clipped = true;
  }
  player.comboSpeedMul = 1;
  return { hi, clipped, lid };
}

CONFIG.arena.airScale = 1;
updateBounds(LANDSCAPE);
const capped = breach(1);
check('at airScale 1 a plain straight-up strike is caught — the bug this fixes',
  capped.clipped, `stopped at y=${capped.lid.toFixed(1)}`);

CONFIG.arena.airScale = CONFIG.arena.airScale === 1 ? 3 : CONFIG.arena.airScale;
updateBounds(LANDSCAPE);
const free = breach(1);
check('at the shipped airScale it flies clear', !free.clipped,
  `apex y=${free.hi.toFixed(1)} under a lid at ${free.lid.toFixed(1)}`);
check('...with real headroom over the apex, not a hair', free.lid - free.hi > 5,
  `${(free.lid - free.hi).toFixed(1)} units to spare`);
const angled = breach(1, 60);
check('an angled strike clears it too', !angled.clipped, `apex y=${angled.hi.toFixed(1)}`);

// The ceiling is the one direction the frame does NOT grow into: the frustum
// top stays put, so raising it costs sky to look at, not a zoom-out.
for (const s of [1, 2, 3, 5]) {
  CONFIG.arena.airScale = s;
  updateBounds(LANDSCAPE);
  check(`airScale ${s}: ceiling scales, frame top holds`,
    near(bounds.top, bounds.frameTop * s) && near(bounds.frameTop, VH * CONFIG.arena.surfaceFromTop),
    `ceiling ${bounds.top.toFixed(1)}, frame top ${bounds.frameTop.toFixed(1)}`);
}
CONFIG.arena.airScale = 0.3;
updateBounds(LANDSCAPE);
check('below 1 is clamped — the lid never comes inside the frame',
  near(bounds.top, bounds.frameTop), `airScale 0.3 -> ceiling ${bounds.top.toFixed(1)}`);

// Same contract as the walls: nowhere the seal can reach may be out of shot.
// Modelled on clampFocus itself — focus y is held in [loY, hiY], so the highest
// the frame's top edge can get is hiY + half, and that only equals the ceiling
// while the range is non-degenerate. Below zoom 1 it inverts and the camera is
// pinned to the arena's centre, which is the case worth naming.
for (const s of [1, 3, 5, 8]) {
  CONFIG.arena.airScale = s;
  updateBounds(LANDSCAPE);
  const half = ((bounds.frameTop - bounds.bottom) / 2) / ZOOM;
  const loY = bounds.bottom + half, hiY = bounds.top - half;
  const reach = loY > hiY ? (bounds.bottom + bounds.top) / 2 + half : hiY + half;
  check(`airScale ${s}: the camera can frame the ceiling`, reach >= bounds.top - 1e-6,
    `camera reaches ${reach.toFixed(1)}, ceiling at ${bounds.top.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('SKY — the gradient is measured on the frame, the plane on the arena');

CONFIG.arena.airScale = 3;
updateBounds(LANDSCAPE);
const sky = skyPlaneMetrics(bounds);
check('the plane covers the whole arena ceiling, plus headroom',
  sky.centerY + sky.height / 2 >= bounds.top + 1,
  `plane tops out at ${(sky.centerY + sky.height / 2).toFixed(1)}, ceiling ${bounds.top.toFixed(1)}`);
check('the plane starts at or below the water line',
  sky.centerY - sky.height / 2 <= bounds.surfaceY + 1e-6,
  `bottom edge ${(sky.centerY - sky.height / 2).toFixed(1)}`);
// The whole point. Normalised on the plane instead, the top of the FRAME sat a
// third of the way up the ramp and the zenith never appeared on screen.
check('the gradient is normalised on the frame, not the ceiling',
  near(sky.gradientAirH, bounds.frameTop - bounds.surfaceY) && sky.gradientAirH < bounds.top,
  `gradient over ${sky.gradientAirH.toFixed(1)} units, ceiling at ${bounds.top.toFixed(1)}`);
const curve = CONFIG.dayNight?.skyCurve ?? 1.35;
const tAtFrameTop = Math.pow(Math.min(1, (bounds.frameTop - bounds.surfaceY) / sky.gradientAirH), curve);
check('...so the top of the frame reaches full zenith', near(tAtFrameTop, 1, 1e-9),
  `gradient t=${tAtFrameTop.toFixed(3)} at the top of the shot`);
for (const s of [1, 2, 5]) {
  CONFIG.arena.airScale = s;
  updateBounds(LANDSCAPE);
  check(`airScale ${s}: the gradient does not move`,
    near(skyPlaneMetrics(bounds).gradientAirH, VH * CONFIG.arena.surfaceFromTop),
    `${skyPlaneMetrics(bounds).gradientAirH.toFixed(1)} units, every time`);
}

// ---------------------------------------------------------------------------
section('SHORE — the walls are drawn where the seal actually stops');

CONFIG.arena.widthScale = 2;
CONFIG.arena.airScale = 3;
updateBounds(LANDSCAPE);
const rockScene = new THREE.Scene();
const rocks = createWallRocks(rockScene);
rocks.build();

function faces() {
  const pos = rocks.mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  let rIn = Infinity, lIn = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    if (v.x > 0) rIn = Math.min(rIn, v.x); else lIn = Math.max(lIn, v.x);
  }
  return { rIn, lIn, minY, maxY };
}

// The seal's CENTRE stops at bounds.right - hitRadius and its body reaches the
// wall. Both directions are a visible bug: set the face back and the seal
// bounces off open water short of the rock, bite deeper than its body and the
// seal disappears into the cliff.
const body = bounds.right - CONFIG.player.hitRadius;
const f = faces();
check('no boulder intrudes past the seal body', f.rIn >= body - 1e-6,
  `innermost rock ${f.rIn.toFixed(2)}, seal body reaches ${body.toFixed(2)}`);
check('...and the face sits on the wall, not set back from it',
  f.rIn <= bounds.right + 1e-6 && f.rIn > bounds.right - 1.2,
  `face ${f.rIn.toFixed(2)} vs wall ${bounds.right.toFixed(2)}`);
check('both walls get one', Math.abs(Math.abs(f.lIn) - f.rIn) < 6,
  `left ${f.lIn.toFixed(1)}, right ${f.rIn.toFixed(1)}`);
check('the stack is bedded in the seabed, not floating on it', f.minY < seabedTopY(),
  `lowest vert ${f.minY.toFixed(1)} under seabed ${seabedTopY().toFixed(1)}`);
check('...and breaks the surface', f.maxY > bounds.surfaceY, `highest vert ${f.maxY.toFixed(1)}`);

// A hole in the face shows the background through the boundary, which is the
// one thing the shore exists to prevent — so it is measured, not eyeballed.
const bands = new Array(24).fill(0);
const pos = rocks.mesh.geometry.attributes.position;
const vtx = new THREE.Vector3();
for (let i = 0; i < pos.count; i++) {
  vtx.fromBufferAttribute(pos, i);
  if (vtx.x < 0) continue;
  const b = Math.floor(((vtx.y - seabedTopY()) / (bounds.surfaceY - seabedTopY())) * bands.length);
  if (b >= 0 && b < bands.length) bands[b]++;
}
check('no gaps up the underwater face', bands.every((n) => n > 0),
  `${bands.filter((n) => n > 0).length}/${bands.length} bands covered`);

// The backdrop is rebuilt on every resize. A shore that reshuffled would read
// as the scenery glitching rather than as the window moving.
const beforeBuild = faces();
rocks.build();
const afterBuild = faces();
check('a rebuild gives back the identical shore',
  near(beforeBuild.rIn, afterBuild.rIn, 1e-9) && near(beforeBuild.maxY, afterBuild.maxY, 1e-9),
  `face ${afterBuild.rIn.toFixed(4)} both times`);

CONFIG.arena.widthScale = 3;
updateBounds(LANDSCAPE);
rocks.build();
check('and it follows the wall when the arena widens',
  Math.abs(faces().rIn - bounds.right) < 1.2,
  `wall +/-${bounds.right.toFixed(1)}, face ${faces().rIn.toFixed(1)}`);
check('one draw call, whatever the count', rocks.stats().draws === 1,
  `${rocks.stats().verts.toLocaleString()} verts in ${rocks.stats().draws}`);

CONFIG.arena.widthScale = 1;
CONFIG.arena.airScale = 1;
console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
