#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:width
//
// The expanded arena. `arena.widthScale` pushes the walls out past the frame so
// there is ocean to swim into rather than a wall at the edge of the screen, and
// `arena.airScale` raises the ceiling off it so a breach is not caught by a lid
// nine units over the water. Thirteen things are checked, each one a bug with a
// plausible way of happening:
//
//   1. NEUTRAL   At widthScale 1 the arena IS the REFERENCE frame — the same
//                width at every aspect, because the walls are measured off
//                `arena.referenceAspect` and not off the player's window. This
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
//  10. ORIENTATION  A phone flipped between portrait and landscape gets the
//                same ocean — same walls, same stopping coordinate, same
//                crossing time. This was a real bug and not a small one: the
//                playfield used to be `viewHeight * LIVE aspect * widthScale`,
//                which handed a portrait iPhone a 48-unit arena and the same
//                phone sideways 225, with identical per-second spawn budgets
//                pouring into both.
//  11. LENS      ...and the camera is what answers the window instead, showing
//                a constant WIDTH of ocean. Neutral at 16:9, so the screen
//                every number in config.js was tuned on is untouched.
//  12. FOV       The player's field of view moves the FRAME and never a wall,
//                grows about the frame's own centre (anchoring it at the water
//                line would undo `surfaceFromTop`), and is clamped by the
//                seabed skirt rather than by a typed number. Driven past its
//                own maximum, because the cost of it being wrong is bare scene
//                background under the ocean.
//  13. ...and it survives the aspect correction. The two are the same quantity
//                pulling opposite ways: left alone they cancel exactly and the
//                slider does nothing at any aspect.
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
import { bounds, updateBounds, clampToArena, seabedTopY, maxWaveExcursion, FLOOR_OVERSCAN } from '../path/src/arena.js';
import { setSetting } from '../path/src/systems/settings.js';
import { skyPlaneMetrics } from '../path/src/systems/sky.js';
import { createWallRocks } from '../path/src/systems/wallRocks.js';
import { ASSETS, getAssetSizeMultiplier } from '../path/src/assets.js';
import { updateCineCamera, resetCineCamera, cineAspectZoom } from '../path/src/systems/cineCamera.js';
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
section('NEUTRAL — at widthScale 1 the arena is the REFERENCE frame, exactly');

// Anchored to `referenceAspect` rather than to the live one, which is the whole
// of the orientation fix: the arena used to be `viewHeight * aspect * scale`,
// so a portrait phone got a 48-unit ocean and the same phone turned sideways
// got 225. Same rules, same spawn budgets, 4.7x the water. Now the reference
// frame is the ruler and the window only decides how much of it is on screen.
const REF = VH * (CONFIG.arena.referenceAspect ?? 16 / 9);
for (const [name, aspect] of [['landscape 16:9', LANDSCAPE], ['phone 9:19.5', PORTRAIT], ['square', 1]]) {
  at(1, aspect);
  // The frame still follows the window — it is a rectangle of screen and has
  // to. Asserted alongside, because an implementation that pinned BOTH would
  // pass the arena half of this and letterbox the game.
  check(`${name}: walls at the reference frame, frustum at the window's`,
    near(bounds.width, Math.max(REF, VH * aspect)) && near(bounds.frameWidth, VH * aspect),
    `arena ${bounds.width.toFixed(2)}, frame ${bounds.frameWidth.toFixed(2)}`);
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
// 4 units, and it used to be 5, because the jump itself changed underneath
// this: air stopped applying the seal's WATER drag (arena.airDrag), so the same
// dash now traces the honest ballistic arc and reaches ~70% higher — 28.0 units
// off the surface where it used to reach 16.4 (npm run test:gravity). What is
// left over the lid is 4.4 units, which at this game's scale is a metre and a
// half of daylight: real clearance, not a hair. Raising `arena.airScale` is the
// knob if that margin ever wants to be generous again; the guard here is that a
// plain strike must not come within touching distance of the lid.
check('...with real headroom over the apex, not a hair', free.lid - free.hi > 4,
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

// WHERE THE SEAL ACTUALLY STOPS. clampToArena holds its CENTRE at
// bounds.right - hitRadius, and the animal reaches half its drawn length past
// that — `fit` world units at the assets.csv size multiplier, which is three
// times the hit circle. This test used to call bounds.right "the seal body",
// i.e. it assumed hitRadius WAS the half-length, and so certified a shore
// whose face sat two units inside the animal: swim nose-first into a wall and
// most of the head was in the rock.
//
// Both directions are still a visible bug — set the face back and the seal
// bounces off open water short of the rock, bite deep and it disappears into
// the cliff — they are just measured against the nose now rather than against
// a circle the player cannot see.
const sealReach = (ASSETS.ship.fit * (getAssetSizeMultiplier('ship') || 1)) / 2;
const nose = bounds.right - CONFIG.player.hitRadius + sealReach;
// What a boulder is allowed to take off the tip, which is the same spread the
// face has always been given so it is not a drawn straight line.
const bite = Math.min(0.7, CONFIG.player.hitRadius * 0.7);
const f = faces();
check('no boulder intrudes meaningfully past the seal body',
  f.rIn >= nose - bite - 1e-6,
  `innermost rock ${f.rIn.toFixed(2)}, the seal's nose reaches ${nose.toFixed(2)} (hit circle ${CONFIG.player.hitRadius}, drawn half-length ${sealReach.toFixed(2)})`);
check('...and the face sits on the nose, not set back from it',
  f.rIn <= nose + 1e-6 && f.rIn > nose - 1.2,
  `face ${f.rIn.toFixed(2)} vs the seal's nose at ${nose.toFixed(2)} (wall ${bounds.right.toFixed(2)})`);
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

// ---------------------------------------------------------------------------
section('DRIFT — the frame may pass the wall, but only as far as the rock does');

// `rocks.cover` is the number the camera spends: the depth of the drawn face
// at its THINNEST point, so a frame that drifts by it is still looking at
// rock at every height. Re-measured here at a different step and a different
// phase, because the realistic way for that measurement to be wrong is a
// bucket boundary — one that lands its samples on the fat part of every
// boulder reads a face deeper than it is, and the failure is a strip of open
// water outside the shore at one height, on one window size.
function silhouette(step, phase = 0) {
  const pos = rocks.mesh.geometry.attributes.position;
  // The band that has to stay hidden, and the same one measureCover uses: the
  // top of the seabed (below it the floor strip is opaque and overscans on its
  // own) up to the highest the water ever reaches. Above that line, past the
  // rock, is sky — and it is the same sky on both sides of the shore.
  const lo = seabedTopY();
  const hi = bounds.surfaceY
    + maxWaveExcursion(CONFIG.arena.waveAmplitude * Math.max(1, CONFIG.weather?.sea?.amp ?? 1), 1);
  const out = [];
  for (let y = lo + phase; y <= hi; y += step) {
    let r = -Infinity, l = -Infinity;
    for (let t = 0; t + 2 < pos.count; t += 3) {
      let far = -Infinity;
      let side = 0;
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3;
        const x0 = pos.getX(t + k), y0 = pos.getY(t + k);
        const x1 = pos.getX(t + j), y1 = pos.getY(t + j);
        side = x0 > 0 ? 1 : -1;
        if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
          const f = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
          const x = x0 + (x1 - x0) * f;
          const d = side > 0 ? x - bounds.right : bounds.left - x;
          if (d > far) far = d;
        }
      }
      if (far > -Infinity) {
        if (side > 0) r = Math.max(r, far); else l = Math.max(l, far);
      }
    }
    out.push({ y, right: Math.max(0, r === -Infinity ? 0 : r), left: Math.max(0, l === -Infinity ? 0 : l) });
  }
  return out;
}

const sil = silhouette(0.17, 0.09);
const thinnest = sil.reduce((m, b) => Math.min(m, b.right, b.left), Infinity);
const deepest = sil.reduce((m, b) => Math.max(m, b.right, b.left), 0);
check('the shore reports a depth to spend at all', rocks.cover > 0,
  `${rocks.cover.toFixed(2)} units of face past each wall`);
check('...and the face really is that deep at every height', thinnest >= rocks.cover - 1e-9,
  `thinnest scanline ${thinnest.toFixed(2)} vs reported ${rocks.cover.toFixed(2)}`);
// The thinnest point, not the average one. A mean here would read about three
// times as deep and would be wrong exactly where it matters — at the notch.
check('...and it is the thinnest point, not the typical one', rocks.cover < deepest * 0.9,
  `thinnest ${rocks.cover.toFixed(2)} against a face up to ${deepest.toFixed(2)} deep`);

// What the camera actually spends, which is the smaller of the two. Both
// directions are a bug you could ship: take the config number alone and the
// frame shows open water past the shore, take the rock alone and the tuner's
// ceiling does nothing.
const spend = (drift) => Math.max(0, Math.min(drift, rocks.cover));
check('the tuner can ask for less than the rock allows', near(spend(0.5), 0.5),
  `edgeDrift 0.5 -> ${spend(0.5).toFixed(2)}`);
check('...but never for more', near(spend(999), rocks.cover),
  `edgeDrift 999 -> ${spend(999).toFixed(2)}, the face's own depth`);
check('the shipped ceiling is the rock, not the number',
  spend(CONFIG.camera.edgeDrift) <= rocks.cover + 1e-9,
  `edgeDrift ${CONFIG.camera.edgeDrift} -> ${spend(CONFIG.camera.edgeDrift).toFixed(2)} spent`);

// Turned off, there is nothing drawn out there to hide behind, so the frame
// has to go back to stopping dead on the wall. A cover left at its last
// measured value would drift the frame into bare water.
CONFIG.wallRocks.enabled = false;
rocks.build();
check('no shore, no drift', rocks.cover === 0, `cover ${rocks.cover}`);
CONFIG.wallRocks.enabled = true;
rocks.build();

// The cap follows the ART. This is the whole reason it is measured rather
// than written: bigger boulders are a bigger frame budget, with nothing to
// keep in step by hand.
const baseCover = rocks.cover;
const savedSize = CONFIG.wallRocks.size.slice();
CONFIG.wallRocks.size = [savedSize[0] * 1.8, savedSize[1] * 1.8];
rocks.build();
check('a deeper wall buys more drift', rocks.cover > baseCover * 1.2,
  `${baseCover.toFixed(2)} -> ${rocks.cover.toFixed(2)} at 1.8x boulder size`);
CONFIG.wallRocks.size = savedSize;
rocks.build();

// ---------------------------------------------------------------------------
section('EASING — the frame slows into the wall instead of hitting it');

// The real rig, driven against the real limits. No renderer is involved: the
// cine camera talks to world.js through four callbacks and nothing else, so
// the arithmetic below is exactly what runs in a game.
const ZOOM_HALF = (z) => ({ w: (bounds.frameWidth / 2) / z, h: (VH / 2) / z });
function rigCtx() {
  const side = spend(CONFIG.camera.edgeDrift);
  const limitsOf = (zoom) => {
    const half = ZOOM_HALF(zoom);
    return {
      loX: bounds.left + half.w - side,
      hiX: bounds.right - half.w + side,
      loY: bounds.bottom + half.h,
      hiY: bounds.top - half.h,
    };
  };
  return {
    target: { x: 0, y: -12 },
    velocity: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
    dashDir: { x: 0, y: 0 },
    chargePower: 0,
    strikeHeld: false, charging: false, boosting: false,
    deathPhase: 'none', deathElapsed: 0,
    halfExtents: ZOOM_HALF,
    focusLimits: (zoom) => limitsOf(zoom),
    clampFocus: (x, y, zoom) => {
      const l = limitsOf(zoom);
      return {
        x: l.loX > l.hiX ? 0 : Math.min(Math.max(x, l.loX), l.hiX),
        y: l.loY > l.hiY ? (bounds.bottom + bounds.top) / 2 : Math.min(Math.max(y, l.loY), l.hiY),
      };
    },
  };
}

// A flat-out swim from the middle of the ocean into the right-hand wall, at
// the real top speed, until the seal is stopped by clampToArena. `legacy`
// withholds focusLimits, which is how the rig behaved before any of this: the
// target left pointing at a seal past the wall, and the frame's POSITION
// truncated at the limit. It is the control the easing is measured against,
// and it exercises the fallback branch at the same time.
function swimAtWall(edgeEase, legacy = false) {
  CONFIG.cinecam.enabled = true;
  CONFIG.cinecam.base.edgeEase = edgeEase;
  resetCineCamera();
  const ctx = rigCtx();
  if (legacy) delete ctx.focusLimits;
  const dt = 1 / 60;
  const speed = 40;
  const frames = [];
  for (let i = 0; i < 420; i++) {
    const nx = Math.min(bounds.right - CONFIG.player.hitRadius, ctx.target.x + speed * dt);
    ctx.velocity.x = (nx - ctx.target.x) / dt;
    ctx.target.x = nx;
    const out = updateCineCamera(dt, ctx);
    frames.push({ x: out.x, edge: out.x + ZOOM_HALF(out.zoom).w, seal: ctx.target.x });
  }
  return frames;
}

const savedEase = CONFIG.cinecam.base.edgeEase;
const savedEnabled = CONFIG.cinecam.enabled;
const eased = swimAtWall(CONFIG.cinecam.base.edgeEase ?? 0.3);
const noRamp = swimAtWall(0);
const legacy = swimAtWall(0, true);

const wallLine = bounds.right + spend(CONFIG.camera.edgeDrift);
check('the eased frame never passes the rock face',
  eased.every((f) => f.edge <= wallLine + 1e-6),
  `furthest edge ${Math.max(...eased.map((f) => f.edge)).toFixed(2)} vs rock out to ${wallLine.toFixed(2)}`);
check('...and does get past the wall itself',
  Math.max(...eased.map((f) => f.edge)) > bounds.right + 0.5,
  `${(Math.max(...eased.map((f) => f.edge)) - bounds.right).toFixed(2)} units of drift used`);

// THE POINT OF THE WHOLE THING, and the only honest way to measure it: how
// fast the frame is still moving on its LAST unit of travel. A stop is a stop
// whatever precedes it — what reads as a lurch is arriving at one at speed.
function arrivalSpeed(frames) {
  const end = frames[frames.length - 1].x;
  let fastest = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].x > end - 1) fastest = Math.max(fastest, Math.abs(frames[i].x - frames[i - 1].x));
  }
  return fastest;
}
const vEased = arrivalSpeed(eased);
const vNoRamp = arrivalSpeed(noRamp);
const vLegacy = arrivalSpeed(legacy);
check('the frame no longer arrives at the wall at speed', vEased < vLegacy * 0.25,
  `last unit of travel: ${vEased.toFixed(3)} u/frame eased vs ${vLegacy.toFixed(3)} hard-clamped`);
// Which half of the fix did what. Softening the target at all is most of it;
// the ramp is the rest. Split out because a regression that quietly dropped
// the ramp would still look like a large win against the old behaviour.
check('...the softened target is most of that', vNoRamp < vLegacy * 0.35,
  `${vNoRamp.toFixed(3)} u/frame with the limit but no ramp`);
check('...and the ramp takes it the rest of the way', vEased < vNoRamp,
  `${vEased.toFixed(3)} with the ramp vs ${vNoRamp.toFixed(3)} without`);

// A soft wall that overshot and came back would read as a bounce off the
// scenery, which is worse than the stop it replaces. The spring's own damping
// is under 1, so a hair of settle is expected — a bounce is not.
let worstBack = 0;
for (let i = 1; i < eased.length; i++) worstBack = Math.min(worstBack, eased[i].x - eased[i - 1].x);
check('the approach never bounces back off the wall', worstBack > -0.02,
  `worst reversal ${worstBack.toFixed(4)} units in a frame`);

CONFIG.cinecam.base.edgeEase = savedEase;
CONFIG.cinecam.enabled = savedEnabled;
resetCineCamera();

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
{
  const wideNose = bounds.right - CONFIG.player.hitRadius + sealReach;
  check('and it follows the wall when the arena widens',
    Math.abs(faces().rIn - wideNose) < 1.2,
    `wall +/-${bounds.right.toFixed(1)}, seal stops at ${wideNose.toFixed(1)}, face ${faces().rIn.toFixed(1)}`);
}
check('one draw call, whatever the count', rocks.stats().draws === 1,
  `${rocks.stats().verts.toLocaleString()} verts in ${rocks.stats().draws}`);

// ---------------------------------------------------------------------------
section('ORIENTATION — turning the phone re-frames the game, it does not replace it');

// The bug this section exists for. `bounds.right` used to be measured off the
// LIVE frame, so the playfield was a function of the window's aspect ratio: a
// portrait iPhone 14 Pro got a 48-unit ocean, the same phone turned sideways
// got 225. Under 8 seal lengths wall to wall against 37, with the same
// per-second spawn budgets pouring into both — every wall bounce, entrance
// distance, crossing time and chase geometry moved by 4.7x mid-run.
//
// Portrait is checked against the phone's OWN landscape rather than against a
// literal, because the failure was always a comparison between two orientations
// of one device and a fixed expected number would pass an implementation that
// broke both ends equally.
CONFIG.arena.widthScale = 2;
CONFIG.arena.airScale = 3;

const PHONES = [
  ['iPhone 14 Pro', 393, 852],
  ['Pixel 8', 412, 915],
  ['iPad mini', 744, 1133],
];
const ARENA_KEYS = ['left', 'right', 'width', 'top', 'bottom', 'height', 'surfaceY'];

for (const [name, w, h] of PHONES) {
  const port = { ...updateBounds(w / h) };
  const land = { ...updateBounds(h / w) };
  const moved = ARENA_KEYS.filter((k) => !near(port[k], land[k], 1e-9));
  check(`${name}: the ocean is the same ocean either way up`, moved.length === 0,
    moved.length ? `moved: ${moved.join(', ')}` : `${port.width.toFixed(1)} wide, ${(-port.bottom).toFixed(1)} deep, both`);
  // And the frustum still moves, which is the half that must NOT be pinned.
  check(`${name}: ...while the frame really does change shape`,
    land.frameWidth > port.frameWidth * 2,
    `frame ${port.frameWidth.toFixed(1)} -> ${land.frameWidth.toFixed(1)}`);
}

// Driving the real clamp rather than reading bounds, for the same reason the
// REACH section does: bounds moving and the WALL moving are different
// functions, and the physics reads the second one.
{
  const [, w, h] = PHONES[0];
  const stops = [w / h, h / w].map((a) => {
    updateBounds(a);
    const pos = new THREE.Vector3(500, -8, 0);
    clampToArena(pos, new THREE.Vector2(10, 0), 1.2, 0.5);
    return pos.x;
  });
  check('a seal swimming right stops at the same coordinate in both',
    near(stops[0], stops[1], 1e-9), `x = ${stops[0].toFixed(2)}`);
}

// The trip, through the real updatePlayer. The one number a player would feel.
{
  const [, w, h] = PHONES[0];
  const swim = (aspect) => {
    updateBounds(aspect);
    resetPlayer();
    player.mesh.position.set(bounds.left + 3, -8, 0);
    player.velocity.set(0, 0);
    for (let t = 0; t < 90; t += DT) {
      updatePlayer(DT, input);
      if (player.mesh.position.x >= bounds.right - (player.stats.hitRadius ?? 1.2) - 0.05) return t;
    }
    return null;
  };
  const [tp, tl] = [swim(w / h), swim(h / w)];
  check('a flat-out crossing takes the same time in both',
    tp != null && tl != null && Math.abs(tp - tl) < 0.05,
    `${tp?.toFixed(2)}s portrait vs ${tl?.toFixed(2)}s landscape`);
}

// THE ONE CASE WHERE A WINDOW STILL MOVES THE WALLS, and it has to: a frame
// wider than the arena would show bare scene background past both sides, which
// no camera work can hide. It is also the case world.js's cheap resize path
// must fall through on (see onWindowResize) — miss it and the shore is drawn
// inside the shot. Reachable at the shipped widthScale 2 only past about 32:9,
// but at widthScale 1 every landscape phone is already there.
for (const [scale, aspect, label] of [[1, 21 / 9, 'widthScale 1 on a 21:9'], [2, 40 / 9, 'widthScale 2 on a 40:9']]) {
  at(scale, aspect);
  check(`${label}: the walls give way to the frame`,
    near(bounds.width, bounds.frameWidth) && bounds.frameWidth > VH * (CONFIG.arena.referenceAspect ?? 16 / 9) * scale - 1e-9,
    `arena ${bounds.width.toFixed(1)} = frame ${bounds.frameWidth.toFixed(1)}`);
}
CONFIG.arena.widthScale = 2;

// ---------------------------------------------------------------------------
section('LENS — the camera is what answers the window, and it shows a constant width');

// The other half of the fix. Every zoom in config.js was typed on a 16:9 screen
// and means "show this much ocean"; cineAspectZoom is what makes that true on a
// screen that is not 16:9. Neutral at the reference aspect is the check that
// protects the shipped game — a correction that fired on the laptop everything
// was tuned on would be a silent retune of the whole feel.
{
  updateBounds(LANDSCAPE);
  check('neutral at the reference aspect — the typed number, untouched',
    near(cineAspectZoom(), 1, 1e-9), `x${cineAspectZoom().toFixed(4)}`);

  const span = (aspect) => {
    updateBounds(aspect);
    // The same clamp the zoom spring applies. Below 1 there is no frustum to
    // zoom out of, so a narrow window simply keeps what it has.
    return bounds.frameWidth / Math.max(1.001, ZOOM * cineAspectZoom());
  };
  const ref = span(LANDSCAPE);
  for (const [name, a] of [['iPad mini', 1133 / 744], ['iPhone landscape', 852 / 393], ['ultrawide 21:9', 21 / 9]]) {
    check(`${name}: the same width of ocean as 16:9`, Math.abs(span(a) - ref) < 0.5,
      `${span(a).toFixed(1)} vs ${ref.toFixed(1)} units`);
  }

  // Portrait is the case that CANNOT be equalised, and saying so here is the
  // point: it is held at zoom 1 and keeps whatever its frustum holds. What it
  // must never do is come out worse than it was — the old base zoom of 1.24
  // was punching in on a frame already only 24 units wide.
  const portraitSpan = span(393 / 852);
  updateBounds(393 / 852);
  check('a portrait phone is never punched in past 1',
    near(Math.max(1.001, ZOOM * cineAspectZoom()), 1.001, 1e-6),
    `x${(ZOOM * cineAspectZoom()).toFixed(2)} asked, clamped to 1`);
  check('...and it recovers the span the old base zoom was taking',
    portraitSpan > bounds.frameWidth / ZOOM,
    `${portraitSpan.toFixed(1)} units, up from ${(bounds.frameWidth / ZOOM).toFixed(1)}`);

  // THROUGH THE REAL RIG rather than through arithmetic on cineAspectZoom,
  // because what matters is where the springs and clamps actually leave the
  // zoom over a run of frames, and this is the regime where the aspect term
  // makes the ceiling (zoomMax * 0.26 = 0.92) fall UNDER the 1.001 floor.
  // clamp() tests the floor first, so today that inversion is caught on the
  // way past and never reaches the `v > hi` branch — checked, this section
  // passes with the Math.max guard in cineCamera.js removed. Which is the
  // reason to assert the OUTCOME here and not the guard: a zoom below 1 asks
  // the frustum to show more than the frame it was built from, and that stays
  // the thing that must not happen however the limits get computed.
  {
    const wasEnabled = CONFIG.cinecam.enabled;
    CONFIG.cinecam.enabled = true;
    updateBounds(393 / 852);
    resetCineCamera();
    const ctx = rigCtx();
    let worst = Infinity;
    for (let i = 0; i < 240; i++) worst = Math.min(worst, updateCineCamera(DT, ctx).zoom);
    check('the rig never settles below zoom 1 on a portrait phone',
      worst >= 1 - 1e-9, `lowest zoom over 4s: ${worst.toFixed(4)}`);
    CONFIG.cinecam.enabled = wasEnabled;
    resetCineCamera();
  }

  // Without the cap a 32:9 display plays the game through a slot, which is a
  // worse answer than letting it see a little extra ocean.
  updateBounds(32 / 9);
  check('the punch-in is capped before a 32:9 monitor becomes a keyhole',
    cineAspectZoom() <= (CONFIG.cinecam.base.maxPunch ?? 1.6) + 1e-9,
    `x${cineAspectZoom().toFixed(2)} at the ${(CONFIG.cinecam.base.maxPunch ?? 1.6)} cap`);
}

// ---------------------------------------------------------------------------
section('FIELD OF VIEW — the frame moves, the ocean does not');

// Why the FRUSTUM and not the rig's zoom, which is the obvious implementation:
// zoom can only ever punch IN, and on any portrait screen the rig already sits
// at 1. Measured above — x1.00 of headroom on an iPad or iPhone held upright.
// A zoom-based fov slider would be a dead control on most of mobile, so this
// scales the frame instead, which is a rectangle we choose rather than a limit
// the display imposes.
CONFIG.arena.widthScale = 2;
CONFIG.arena.airScale = 3;
{
  const FOVS = [0.8, 1.0, 1.2];
  const SCREENS = [['16:9 laptop', LANDSCAPE], ['iPhone landscape', 852 / 393],
    ['iPhone portrait', 393 / 852], ['iPad portrait', 744 / 1133]];

  // 1.0 IS AN EXACT NO-OP, and it is the only check here that protects the
  // shipped game — every other line describes a setting nobody has touched.
  setSetting('video.fov', 1);
  updateBounds(LANDSCAPE);
  const air = VH * CONFIG.arena.surfaceFromTop;
  check('at fov 1 the frame is exactly what it always was',
    near(bounds.frameTop, air) && near(bounds.frameBottom, bounds.bottom)
    && near(bounds.frameWidth, VH * LANDSCAPE),
    `top ${bounds.frameTop.toFixed(2)}, bottom ${bounds.frameBottom.toFixed(2)} = floor ${bounds.bottom.toFixed(2)}`);

  // THE WHOLE POINT: it works on the screens the zoom version could not.
  for (const [name, aspect] of SCREENS) {
    const spans = FOVS.map((f) => { setSetting('video.fov', f); updateBounds(aspect); return bounds.frameWidth; });
    check(`${name}: a wider view really is wider`,
      spans[2] > spans[1] * 1.15 && spans[0] < spans[1] * 0.85,
      `${spans[0].toFixed(1)} / ${spans[1].toFixed(1)} / ${spans[2].toFixed(1)} units`);
  }

  // ...and the ocean underneath is untouched, which is the promise the arena
  // change makes and this setting is the first thing that could break.
  for (const [name, aspect] of SCREENS) {
    const seen = FOVS.map((f) => { setSetting('video.fov', f); updateBounds(aspect); return { ...bounds }; });
    const moved = ARENA_KEYS.filter((k) => !seen.every((b) => near(b[k], seen[0][k], 1e-9)));
    check(`${name}: fov never moves a wall`, moved.length === 0,
      moved.length ? `moved: ${moved.join(', ')}` : `arena ${seen[0].width.toFixed(1)} at every fov`);
  }

  // SCALED ABOUT THE FRAME'S CENTRE, not about the water line. Anchoring at the
  // surface would slide the water line up the screen as the view widened, which
  // is `surfaceFromTop` being quietly undone by a video setting.
  {
    const centres = FOVS.map((f) => {
      setSetting('video.fov', f); updateBounds(LANDSCAPE);
      return (bounds.frameTop + bounds.frameBottom) / 2;
    });
    check('the frame grows about its own centre', centres.every((c) => near(c, centres[0], 1e-9)),
      `centre ${centres[0].toFixed(2)} at every fov`);
  }

  // THE FLOOR IS THE BINDING CONSTRAINT, and it is derived rather than typed:
  // below the frame there is only the seabed skirt, and past that is bare scene
  // background under the ocean. Driven to the schema's maximum and past it.
  for (const f of [1.2, 1.5, 4]) {
    setSetting('video.fov', f);
    updateBounds(LANDSCAPE);
    check(`fov ${f}: the frame never drops through the seabed skirt`,
      bounds.frameBottom >= bounds.bottom - FLOOR_OVERSCAN - 1e-9,
      `frame bottom ${bounds.frameBottom.toFixed(2)} vs skirt at ${(bounds.bottom - FLOOR_OVERSCAN).toFixed(2)}`);
    check(`fov ${f}: ...and never past the jump ceiling`,
      bounds.frameTop <= bounds.top + 1e-9,
      `frame top ${bounds.frameTop.toFixed(2)} vs ceiling ${bounds.top.toFixed(2)}`);
  }

  // The aspect term has to divide fov back out or the two cancel exactly and
  // the slider does nothing at any aspect — the correction's entire job is to
  // hold frameWidth/zoom constant, and fov is a deliberate change to frameWidth.
  {
    const spanAt = (f) => {
      setSetting('video.fov', f); updateBounds(LANDSCAPE);
      return bounds.frameWidth / Math.max(1.001, ZOOM * cineAspectZoom());
    };
    const [lo, mid, hi] = [spanAt(0.8), spanAt(1), spanAt(1.2)];
    check('fov survives the aspect correction instead of cancelling against it',
      Math.abs(hi / mid - 1.2) < 0.01 && Math.abs(lo / mid - 0.8) < 0.01,
      `${lo.toFixed(1)} / ${mid.toFixed(1)} / ${hi.toFixed(1)} units on screen`);
  }
  setSetting('video.fov', 1);
}

CONFIG.arena.widthScale = 1;
CONFIG.arena.airScale = 1;
updateBounds(LANDSCAPE);
console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
