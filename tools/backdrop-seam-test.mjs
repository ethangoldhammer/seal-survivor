#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:seams
//
// CAN A REPLAY SHOT SEE PAST THE BACKDROP?
//
// The game is filmed by one orthographic camera looking straight down -z, and
// the ocean behind it is a flat picture: a sky plane at z = -6, a water fill at
// -5.4, a strip of seabed at -4. That is a complete world for a camera that can
// only ever look at it square-on — it cannot reach the edge of anything.
//
// A REPLAY IS FILMED BY A PERSPECTIVE CAMERA THAT LEAVES THE PLANE
// (systems/replayCams.js): swung round the action in yaw and pitch, standing as
// much as 96 units off it. Two things follow, and neither is visible in a
// screenshot of any single shot:
//
//   1. Its rays keep spreading for the four-odd units from the play plane back
//      to the picture, so a shot at the far end of the pitch can look out past
//      the SIDE of a strip the game's own camera could never reach the end of.
//   2. Yawed far enough, it looks ALONG the picture and then past it — and no
//      backdrop at any distance helps, because the whole backdrop is at z ~ -5.
//
// The pixels that miss everything are `scene.background`: one flat colour, the
// sky's horizon.
//
// WHICH WAY THE RAY WAS POINTING IS THE WHOLE TEST. Above the horizon, bare
// background is RIGHT and always was: a ray going up from under the water would
// cross the surface somewhere out there and show sky, and the sky's own horizon
// colour is what sky at that distance looks like. Below it, it is the seam —
// pale sky where the black floor should simply keep going. So the bar is not
// "no bare pixels", which would demand a lid over the ocean that hides the sky
// (it was tried; see world.js). It is NO BARE PIXEL ON A DOWNWARD RAY.
//
// SO THIS COUNTS THEM. Every shot in the pool, soloed and posed by the shipping
// director at look-ats all over the pitch on both sides, its frame sampled on a
// grid, each sample's ray cast at the backdrop.
//
// It reads the rectangles from systems/backdropFit.js — the same functions
// world.js builds the meshes from — so it cannot pass on a copy of numbers the
// game has since changed. What it does NOT check is whether the picture is the
// right picture: a shot may frame a perfectly covered patch of nothing. That is
// the replay lab's job (`npm run looks:replaylab`), and this is the floor under
// it.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';

// THE PERSPECTIVE POOL IS WHAT THIS FILE IS ABOUT.
//
// A goal replay now ships filmed with the FLAT orthographic lens (CONFIG
// .versus.replay.cams.projection, default 'flat'), and a flat camera cannot
// produce the seam this file exists to catch: its rays are parallel to -z, so
// it looks AT the backdrop and never along it. Left on the default, every check
// below passes by being unable to fail, and the shell-is-necessary assertion at
// the end reads 0.0% — a green suite that means nothing.
//
// So the perspective lens is forced HERE, before any shot is posed. These are
// still the contract it has to keep whenever somebody switches to it, and they
// are the whole argument for why the flat one is the default.
CONFIG.versus.replay.cams.projection = 'perspective';
import { enableVersus } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import { resetPool, updatePool } from '../path/src/systems/replayCams.js';
import { backdropRects, replayStandOff, versusZoomFloor } from '../path/src/systems/backdropFit.js';
import { rockX, mouthY } from '../path/src/systems/versusGoal.js';

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
function note(text) { console.log(`        ${text}`); }

const ASPECT = 16 / 9;
enableVersus(true);
updateBounds(ASPECT);

const rects = backdropRects();
const DROP = process.env.DROP ?? '';
for (const n of DROP.split(',').filter(Boolean)) {
  const i = rects.findIndex((r) => r.name === n);
  if (i >= 0) rects.splice(i, 1);
}
const shots = CONFIG.versus.replay.cams.shots ?? [];
const pool = shots.map((s) => ({ ...s }));

// A ray is cast at every rectangle nearest-first and stops at the first hit;
// `axis` says which way the rectangle faces. The shell's two quads are
// horizontal (bounded in x and z) and the picture's three are upright (bounded
// in x and y) — see systems/backdropFit.js.
const _ray = new THREE.Vector3();
function covered(origin, ray, list = rects) {
  for (const r of list) {
    if (r.axis === 'y') {
      if (Math.abs(ray.y) < 1e-6) continue;
      const t = (r.y - origin.y) / ray.y;
      if (t <= 0) continue;
      const hx = origin.x + ray.x * t;
      const hz = origin.z + ray.z * t;
      if (hx >= r.x0 && hx <= r.x1 && hz >= r.z0 && hz <= r.z1) return r.name;
      continue;
    }
    if (Math.abs(ray.z) < 1e-6) continue;
    const t = (r.z - origin.z) / ray.z;
    if (t <= 0) continue;
    const hx = origin.x + ray.x * t;
    const hy = origin.y + ray.y * t;
    if (hx >= r.x0 && hx <= r.x1 && hy >= r.y0 && hy <= r.y1) return r.name;
  }
  return null;
}

const GRID = 24; // samples per axis across the frame, corners included

/**
 * Solo shot `i`, let the director settle on it, and count the samples of its
 * frame that reach no backdrop at all. Soloed the way the replay lab does it —
 * the pool is one shot with its beats cleared — because the point is to measure
 * every shot, including the ones a scored pool would never choose here.
 */
function barePixels(i, side, pois) {
  CONFIG.versus.replay.cams.shots = [{ ...pool[i], beats: null }];
  resetPool(ASPECT);
  let cam = null;
  for (let f = 0; f < 40; f++) {
    cam = updatePool({ beat: 'impact', side, pois, bounds, aspect: ASPECT, dt: 1 / 60 });
  }
  CONFIG.versus.replay.cams.shots = pool;
  if (!cam) return null;
  let bare = 0; let down = 0;
  for (let iy = 0; iy <= GRID; iy++) {
    for (let ix = 0; ix <= GRID; ix++) {
      _ray.set((ix / GRID) * 2 - 1, (iy / GRID) * 2 - 1, 0.5)
        .unproject(cam).sub(cam.position).normalize();
      if (covered(cam.position, _ray)) continue;
      bare++;
      if (_ray.y < 0) down++;
    }
  }
  return { bare, down, total: (GRID + 1) * (GRID + 1), cam };
}

// Look-ats all over the pitch: hard against each goal, mid-field, at the sand
// and just under the surface. The mouth targets are the real ones, so a shot of
// the goal is posed against the wall rules that flatten it.
const spots = [];
for (const fx of [0.05, 0.2, 0.5, 0.8, 0.95]) {
  for (const fy of [0.08, 0.35, 0.7, 0.95]) {
    spots.push({
      x: bounds.left + fx * bounds.width,
      y: bounds.bottom + fy * (bounds.surfaceY - bounds.bottom),
    });
  }
}

function poisAt(s, side) {
  return {
    ball: { x: s.x, y: s.y, z: 0 },
    striker: { x: s.x - 3, y: s.y + 1, z: 0 },
    strikerFace: { x: s.x - 1, y: s.y + 1.5, z: 0 },
    scorer: { x: s.x - 3, y: s.y, z: 0 },
    scorerFace: { x: s.x - 1, y: s.y + 1, z: 0 },
    defender: { x: s.x + 4, y: s.y - 1, z: 0 },
    mouth: { x: rockX(side) - side * 2, y: mouthY(), z: 0 },
    impact: { x: s.x, y: s.y, z: 0 },
  };
}

// ---------------------------------------------------------------------------
section('...and for the MATCH\'s own frame, at its widest, on every shape of screen');
{
  // THE ORTHOGRAPHIC ONE, which is the camera the game is actually played on.
  // Everything below this section is about the replay's perspective rig; this
  // is the flat frame, and what it can see is decided by how far the match's
  // camera may zoom OUT — which has no floor any more, because the rule is
  // that the player and the ball are both in frame and a floor is a promise to
  // break it (see versusCameraGoal). versusZoomFloor is the same arithmetic
  // run backwards — the widest that rule can ever take the shot — and it is
  // what matchMargins builds the picture for.
  //
  // SWEPT ACROSS ASPECTS BECAUSE THE MARGIN USED TO BE TYPED. It read a 0.55
  // that was chosen against a laptop, while the camera's floor was the same
  // constant: both were wrong off 16:9 in the same direction, so they agreed
  // with each other and the backdrop looked sized. It is four times too short
  // for a phone held upright.
  const savedAspect = 16 / 9;
  const origin = new THREE.Vector3();
  const down = new THREE.Vector3(0, 0, -1);
  for (const [name, aspect] of [
    ['laptop 16:9', 16 / 9],
    ['phone sideways 19.5:9', 19.5 / 9],
    ['tablet 4:3', 4 / 3],
    ['phone upright 9:16', 9 / 16],
    ['phone upright 9:19.5', 9 / 19.5],
  ]) {
    updateBounds(aspect);
    const list = backdropRects();
    const zoom = versusZoomFloor();
    const halfW = bounds.frameWidth / (2 * zoom);
    const halfH = (bounds.frameTop - bounds.frameBottom) / (2 * zoom);
    // Centred on the arena, which is where world.clampFocus pins the focus once
    // the frame is wider than the water — and at this zoom it always is.
    const cx = (bounds.left + bounds.right) / 2;
    const cy = (bounds.bottom + bounds.top) / 2;
    let bare = 0; let bareDown = 0; let total = 0;
    for (let iy = 0; iy <= GRID; iy++) {
      for (let ix = 0; ix <= GRID; ix++) {
        const x = cx + ((ix / GRID) * 2 - 1) * halfW;
        const y = cy + ((iy / GRID) * 2 - 1) * halfH;
        origin.set(x, y, 40);
        total++;
        if (covered(origin, down, list)) continue;
        bare++;
        if (y < bounds.surfaceY) bareDown++;
      }
    }
    check(`${name}: the widest frame (zoom ${zoom.toFixed(3)}) lands on no bare background below the water line`,
      bareDown === 0, `${bareDown} of ${total} samples`);
    if (bare) note(`${name}: ${((bare / total) * 100).toFixed(1)}% of that frame is above the water line, where scene.background is the sky's own colour`);
  }
  updateBounds(savedAspect);
}

// ---------------------------------------------------------------------------
section('The backdrop is sized for the camera that films the replay');
{
  check('every shot in the pool is covered by the stand-off', replayStandOff() > 0,
    `${replayStandOff().toFixed(0)}u`);
  const shell = rects.filter((r) => r.axis === 'y');
  check('the deep shell is one floor', shell.length === 1, shell.map((r) => r.name).join(', '));
  const floor = shell.find((r) => r.name === 'shellFloor');
  // The top of the sand, so it meets the seabed strip's own top edge: anywhere
  // else and it is a surface the game does not have.
  check('the floor sits on the sand', Math.abs(floor.y - (bounds.bottom + 1.2)) < 1e-6,
    `y ${floor.y.toFixed(2)}`);
  // poseShot clamps the camera to `floorInset` above the arena floor. Below the
  // shell's floor it would be under an opaque plane looking at its back.
  const inset = CONFIG.versus.replay.cams.floorInset ?? 2;
  check('the camera can never get under the floor', bounds.bottom + inset > floor.y,
    `floorInset ${inset} clears the sand by ${(bounds.bottom + inset - floor.y).toFixed(2)}u`);
}

// ---------------------------------------------------------------------------
section('No shot in the pool can see past it');
{
  let worstShot = null;
  for (let i = 0; i < pool.length; i++) {
    let worst = 0; let worstDown = 0; let where = null;
    for (const side of [-1, 1]) {
      for (const s of spots) {
        const r = barePixels(i, side, poisAt(s, side));
        if (!r) continue;
        const pct = (r.bare / r.total) * 100;
        const pctDown = (r.down / r.total) * 100;
        if (pctDown > worstDown) worstDown = pctDown;
        if (pct > worst) { worst = pct; where = { ...s, side }; }
      }
    }
    check(`\`${pool[i].name ?? i}\` shows no bare background below the horizon`, worstDown === 0,
      worstDown ? `${worstDown.toFixed(1)}% of the frame at x=${where.x.toFixed(0)} y=${where.y.toFixed(0)} side=${where.side}` : '');
    if (worst > (worstShot?.pct ?? 0)) worstShot = { name: pool[i].name, pct: worst, up: worst - worstDown };
  }
  if (worstShot?.pct) {
    note(`most bare sky in any frame: ${worstShot.name} at ${worstShot.pct.toFixed(1)}% — all of it above the horizon,`);
    note('which scene.background already paints the sky\'s own horizon colour.');
  }
}

// ---------------------------------------------------------------------------
section('...and the shell is what is doing it');
{
  // The seam this is all for: without the two horizontal quads the celebration
  // shot loses half its frame, because at 77 degrees of yaw it is looking along
  // the picture rather than at it. Kept as an assertion rather than a comment so
  // that deleting the shell fails here instead of quietly shipping.
  const flat = rects.filter((r) => r.axis === 'z');
  const withShell = rects.slice();
  rects.length = 0; rects.push(...flat);
  let worstFlat = 0;
  for (let i = 0; i < pool.length; i++) {
    for (const side of [-1, 1]) {
      for (const s of spots) {
        const r = barePixels(i, side, poisAt(s, side));
        if (r) worstFlat = Math.max(worstFlat, (r.down / r.total) * 100);
      }
    }
  }
  rects.length = 0; rects.push(...withShell);
  check('the upright planes alone are not enough', worstFlat > 5,
    `${worstFlat.toFixed(1)}% of a frame looking DOWN at nothing with the floor removed`);
  note('a picture at one depth cannot cover a camera that looks along it');
}

enableVersus(false);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
