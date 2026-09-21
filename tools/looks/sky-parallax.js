// ---------------------------------------------------------------------------
// THE SKY, AGAINST THE CAMERA.
//
//   npm run looks:skyparallax
//
// The sun and moon ride CONFIG.dayNight.orbit.drift — a counter-offset against
// the banked camera anchor, so they barely move through the frame. Everything
// else in the backdrop does not: the sky gradient is a function of vWorldPos.y
// on a plane that never moves (systems/sky.js), the star field is hashed off
// the same world position, and each cloud deck keeps its altitude above the
// water line. So "how far away is the sky" is answered by four systems and
// there is exactly one place the answers can be compared, which is a frame
// with all of them in it at a camera height that is not the default one.
//
// That comparison cannot be made from a screenshot of a run. The seal is at the
// default framing for nearly all of it, and the two heights that matter — the
// top of a breach and the first few units of a dive — last a fraction of a
// second each and are the frames nobody is holding a camera during.
//
// So: the REAL world, built the way main.js builds it, rendered at a grid of
// camera heights and hours. Reading down a column is the whole test.
//
// IT WRITES NOTHING. A vite build behind a read-only static server — there is
// no /__tuning endpoint to reach. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import {
  preloadAssets, applySavedAssetLooks, applyNoiseSettings, applyToonSettings,
  applyBiolumSkinSettings,
} from '../../path/src/assets.js';
import { createWorld } from '../../path/src/world.js';
import { bounds } from '../../path/src/arena.js';
import { updateDayCycle, dayState } from '../../path/src/systems/daylight.js';
import { celestialFrame } from '../../path/src/systems/celestial.js';

const q = new URLSearchParams(location.search);

const sheet = document.getElementById('sheet');
const logEl = document.getElementById('log');
const lines = [];
const say = (s) => { lines.push(s); logEl.textContent = lines.join('\n'); };

await preloadAssets();
applySavedAssetLooks();
applyNoiseSettings();
applyToonSettings();
applyBiolumSkinSettings();

// The real arena, camera and renderer. Nothing about the sky can be judged
// against a frame built any other way — the orbit is measured off bounds.frame*
// and the drift is measured off this camera's own anchor.
const world = createWorld(document.getElementById('stage'));

// THE RENDERER IS THE WINDOW, and sizing it is not this page's business.
// createWorld's resize() fills the viewport and re-runs on every window
// resize for the life of the page, so anything set on the renderer or on its
// host element here is undone at a moment nothing announces — and the frame
// the game composes is a function of the window's aspect anyway (see
// updateBounds in arena.js), so a renderer forced to some other shape would
// be showing a frame the game never has. The pane's own size IS the device
// being tested; resize the pane to test another one.
//
// So the cell takes the renderer's aspect rather than the other way round,
// and every draw scales the whole frame down into it. That sounds obvious and
// the default is the opposite: drawImage(src, 0, 0) with no destination size
// draws at the source's NATURAL size, which on a 2x buffer means the sheet
// quietly shows the top-left sixth of the frame. It reads as a plausible shot
// of the sky — a gradient, a water line, half a sun — which is exactly why it
// took a numbers dump to catch.
const CELL_W = 460;
const CELL_H = Math.round(CELL_W
  * world.renderer.domElement.height / world.renderer.domElement.width);
// Handles out, so the sheet can be interrogated from the console when a cell
// reads oddly — every number below is derived from these two.
window.__sky = { world, bounds, CONFIG, celestialFrame, dayState };
say(`frame  ${bounds.frameWidth.toFixed(1)} x ${(bounds.frameTop - bounds.frameBottom).toFixed(1)}  `
  + `top ${bounds.frameTop.toFixed(1)}  bottom ${bounds.frameBottom.toFixed(1)}  `
  + `surface ${bounds.surfaceY.toFixed(1)}  arena bottom ${bounds.bottom.toFixed(1)}`);

// --- the grid ---------------------------------------------------------------
// Camera heights, in world units of camAnchor.y — which is 0 at the framing the
// whole sky was composed against.
//
// +26 is the top of a dash breach (tools/gravity-test measures 28.0 straight up
// off a 46 u/s dash). -6 is a shallow dive, still with the water line in shot.
// -11 is where the water line leaves the top of the frame and the sky is gone;
// it is in the sheet as the control, because a row that is all sea is the
// correct answer and has to be told apart from a row that is broken.
const HEIGHTS = [
  { y: 26, label: 'breach  camY +26' },
  { y: 12, label: 'jump    camY +12' },
  { y: 0, label: 'surface camY 0  (the tuned framing)' },
  { y: -6, label: 'dive    camY -6' },
  { y: -11, label: 'under   camY -11 (clamps short — the frame stops at the arena)' },
];

const HOURS = [
  { h: 6.6, label: '06:36 sunrise' },
  { h: 12, label: '12:00 noon' },
  { h: 18.6, label: '18:36 sunset' },
  { h: 23, label: '23:00 moon up' },
];

// `?axis=x` swaps the rows for a SIDEWAYS sweep instead. Same question, other
// axis: the star field is hashed off vWorldPos on a plane that never moves and
// the constellations are strung between those same stars, so a body drifting
// through x at 0.04 while they stand still is a moon that walks across its own
// sky. Rows are camera x; the whole ocean is +/-92 and a quarter of it is a
// pan nobody would call fast.
const PANS = [
  { x: -60, label: 'camX -60  (west end)' },
  { x: -30, label: 'camX -30' },
  { x: 0, label: 'camX 0    (the tuned framing)' },
  { x: 30, label: 'camX +30' },
  { x: 60, label: 'camX +60  (east end)' },
];
const AXIS = q.get('axis') === 'x' ? 'x' : 'y';
const ROWS = AXIS === 'x' ? PANS : HEIGHTS;

// --- driving one frame ------------------------------------------------------
// The camera is placed through the game's own focus claim rather than by
// writing camera.position: applyFocus is what converts "centre this world
// point" into a position against an ASYMMETRIC frustum, and camAnchor — the
// thing the drift is measured against — is banked inside updateCamera at the
// end of it. Set the position by hand and the anchor is a frame stale and the
// whole measurement is off by one.
function frameAt(hour, camY, camX = 0, dt = 1 / 60) {
  CONFIG.dayNight.paused = true;
  CONFIG.dayNight.scrubHour = hour;
  updateDayCycle(0);

  // The focus point that lands camAnchor.y on camY. The frustum's centre sits
  // well below the camera (the water line is a fifth of the way down the
  // screen, not halfway), so the two differ by a constant that has to be added
  // back or every row is framed fifteen units low.
  const cy = (world.camera.top + world.camera.bottom) / 2;
  const cx = (world.camera.left + world.camera.right) / 2;
  const target = { x: camX, y: camY };
  world.focusCamera({ x: camX + cx, y: camY + cy }, 1, 1);
  world.updateCamera(target, dt, {});
  world.updateSurface(dt);
  world.renderer.render(world.scene, world.camera);
}

// Two settling frames before the one that is kept: waveT, the day cycle's own
// easing and the camera's spring all take a step, and a single frame renders
// the previous cell's sky with this cell's camera.
function settle(hour, camY, camX) {
  for (let i = 0; i < 3; i++) frameAt(hour, camY, camX);
}

const shots = [];

for (const row of ROWS) {
  const lab = document.createElement('div');
  lab.className = 'rowlab';
  lab.textContent = row.label;
  sheet.append(lab);

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.gridTemplateColumns = `repeat(${HOURS.length}, 1fr)`;
  sheet.append(grid);

  for (const col of HOURS) {
    settle(col.h, row.y ?? 0, row.x ?? 0);

    const cell = document.createElement('div');
    cell.className = 'cell';
    const canvas = document.createElement('canvas');
    canvas.width = CELL_W;
    canvas.height = CELL_H;
    // ONE renderer for the whole sheet, drawn into a plain 2D canvas per cell.
    // A renderer per cell dies silently: browsers keep about sixteen live
    // WebGL contexts and discard the oldest, so the early frames go black
    // AFTER rendering correctly and nothing throws.
    const src = world.renderer.domElement;
    canvas.getContext('2d').drawImage(
      src, 0, 0, src.width, src.height, 0, 0, CELL_W, CELL_H,
    );
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = col.label;
    cell.append(canvas, cap);
    grid.append(cell);

    // The numbers behind the picture, so a cell that reads oddly can be
    // checked rather than argued about. `screen` is the fraction of the way
    // down the frame the thing sits — which is the only unit in which "the sun
    // slid" and "the water line slid" are comparable.
    const top = (row.y ?? 0) + (world.camera.top + world.camera.bottom) / 2
      + (world.camera.top - world.camera.bottom) / 2;
    const h = world.camera.top - world.camera.bottom;
    const down = (worldY) => ((top - worldY) / h);
    const body = dayState.sun.y > dayState.moon.y ? 'sun' : 'moon';
    // WHAT THE CAMERA ACTUALLY DID, not what was asked for. clampFocus keeps
    // the frame inside the arena, so a deep row lands short of its label and
    // the row is then measuring a height the game cannot reach either.
    const camReached = world.camera.position.y;
    const z = celestialFrame[body];
    shots.push({
      name: `${AXIS}${row.y ?? row.x}_h${String(col.h).replace('.', '_')}`,
      canvas,
    });
    say(`${row.label.padEnd(34)} ${col.label.padEnd(14)} `
      + `${body} drawn y=${z.y.toFixed(1)} (${(down(z.y) * 100).toFixed(0)}% down frame)  `
      + `orbit y=${dayState[body].y.toFixed(1)}  `
      + `water line ${(down(bounds.surfaceY) * 100).toFixed(0)}% down  `
      + `[cam ${world.camera.position.x.toFixed(1)}, ${camReached.toFixed(1)} `
      + `zoom ${world.camera.zoom.toFixed(2)}]  `
      + `${body} x=${z.x.toFixed(1)} (cam-relative ${(z.x - world.camera.position.x).toFixed(1)})`);
  }
}

// --- off the screen, onto disk ---------------------------------------------
// The Browser pane's own screenshot goes blank or times out on a sheet this
// tall, so every cell POSTs itself and the PNGs are read from the shots dir.
say('\nposting frames...');
let posted = 0;
for (const s of shots) {
  const blob = await new Promise((r) => s.canvas.toBlob(r, 'image/png'));
  await fetch(`/shot/${s.name}.png`, { method: 'POST', body: blob });
  posted++;
}
say(`posted ${posted} frames`);
