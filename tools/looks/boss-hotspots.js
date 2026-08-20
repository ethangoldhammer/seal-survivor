// ---------------------------------------------------------------------------
// BOSS WEAK SPOTS — LOOK DEV
//
//   npm run looks:hotspots
//
// The questions this sheet exists to answer, in the order they were asked:
//
//   1. Does a spot READ as a place on the animal? It has to break the
//      silhouette, be findable at fight scale, and not look like a UI element
//      stuck to a model. That is why every panel here is a real megalodon with
//      the game's real post chain behind it and not a quad over black.
//   2. Does the flash win? A hit has to be legible over a spot that is already
//      warm from earlier damage, which is the one thing a screenshot of a
//      fresh spot cannot tell you — so the flash is shown at three heats.
//   3. Does the rupture read as MATTER leaving the animal rather than as a
//      flare? That is the ichor group's whole job, and it is a fusion
//      question: too fast and it is dots, too slow and it is a disc.
//
// A shader that fails to compile renders NOTHING and three only writes to the
// console about it, so a broken program would present here as a bad tuning
// decision. Collected from the first frame and reported at the top.
//
// IT WRITES NOTHING. The CONFIG assignments below are into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  initParticles, updateParticles, resetParticles, updateParticleScale,
} from '../../path/src/entities/particles.js';
import { spawnNamed, resetEnemies } from '../../path/src/entities/enemies.js';
import { stateForSpeed } from '../../path/src/systems/animation.js';
import { tickHitShapes, hitShapeSpheres } from '../../path/src/systems/hitShape.js';
import {
  initBossHotSpots, attachHotSpots, updateBossHotSpots, hotSpotDamage,
  hotSpotsOf, resetBossHotSpots,
} from '../../path/src/systems/bossHotSpots.js';

const logEl = document.getElementById('log');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};
let fails = 0;
const check = (name, ok, detail = '') => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`, ok ? 'ok' : 'bad');
  if (!ok) fails++;
};

const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 420;
const H = 300;
const DT = 1 / 60;

// FIXED DICE. Placement is a weighted roll over a couple of hundred candidate
// points and the rupture burst rolls a speed, a size and an angle per particle,
// so an unseeded page puts the spots somewhere different in every panel and the
// column-to-column difference is mostly luck.
let seed = 0;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = (v = 0x5ea15eed) => { seed = v >>> 0; };

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

updateBounds(W / H);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x2a3438, 2.0));
const key = new THREE.DirectionalLight(0xfff2e0, 2.4); key.position.set(-3, 4, 5); scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe4ff, 1.0); fill.position.set(4, 1, 3); scene.add(fill);

// Water to put the animal in. A spot is ADDITIVE, so a panel over black would
// make every colour on this page look like it was chosen by somebody who had
// never seen the game — the water is half the read.
//
// Authored much brighter than it looks: the composite writes linear straight to
// the default framebuffer with no sRGB conversion, so every value lands about a
// stop and a half darker than its hex. Same water as the goo sheet.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x38708f }),
);
water.position.z = -30;
scene.add(water);

await preloadAssets();
initParticles(scene);
initBossHotSpots(scene);
const post = createPost(gl);

const ortho = (h, y = 0) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(0, y, 20);
  return c;
};
// Two frames and both of them matter. The detail camera is where a spot is
// tuned; the fight camera is the only place a judgement about it is worth
// anything, because at zoom 1 the frustum IS the arena the player is given.
const detailCam = ortho(9);
const bodyCam = ortho(20);
const fightCam = ortho(bounds.top - bounds.bottom);

// --- the sheet --------------------------------------------------------------

let shotIndex = 0;
const posted = [];
let row = null;

function section(title, columns) {
  const h = document.createElement('h2');
  h.innerHTML = title;
  document.getElementById('sheet').appendChild(h);
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  document.getElementById('sheet').appendChild(row);
}

function present(title, note, picked = false) {
  const cell = document.createElement('div');
  cell.className = picked ? 'cell pick' : 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04070e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gl.domElement, 0, 0);
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b>${picked ? ' <span class="tag">— shipped</span>' : ''}<br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// --- one boss ---------------------------------------------------------------

const LOOK = CONFIG.hotSpots.look;
const LOOK_BASE = { ...LOOK };

let boss = null;

// SWUM BEFORE IT IS MEASURED. A rest pose is not the animal the player meets —
// the hitbox is fitted to the posed body, so the outline the spots sit on is a
// different shape in the two cases.
function newBoss(heading = 0) {
  resetEnemies(scene);
  resetBossHotSpots();
  resetParticles();
  reseed();
  const e = spawnNamed(scene, 'bossShark', 0, undefined, { ignoreCaps: true, overfill: true });
  e.isBoss = true;
  e.mesh.position.set(0, 0, 0);
  e.heading = heading;
  for (let i = 0; i < 30; i++) e.anim?.update(DT, stateForSpeed(e.def.speed ?? 5), false);
  e.mesh.rotation.z = heading - Math.PI / 2;
  scene.updateMatrixWorld(true);
  tickHitShapes();
  attachHotSpots(scene, e);
  // Fully open: the spots ease in over `openSeconds`, and a panel shot on the
  // frame after the attach is a picture of them arriving rather than of them.
  for (let i = 0; i < 45; i++) {
    tickHitShapes();
    updateBossHotSpots(DT, DT);
  }
  boss = e;
  return e;
}

function run(frames, cam) {
  for (let i = 0; i < frames; i++) {
    tickHitShapes();
    updateBossHotSpots(DT, DT);
    updateParticles(DT);
    post.resize();
    post.render(scene, cam, DT);
  }
}

function shoot(spot, dmg) {
  return hotSpotDamage(boss, { x: spot.wx, y: spot.wy }, dmg);
}

// Frame the camera on one spot, so a detail panel is a picture of the thing it
// is captioned as rather than of wherever the roll happened to put it.
function focus(cam, spot) {
  cam.position.x = spot.wx;
  cam.position.y = spot.wy;
  cam.updateMatrixWorld(true);
}

// --- THE COMPILE, FIRST -----------------------------------------------------
// Before any panel renders, or the assertion proves nothing: by the second
// section every program is long since linked and it would pass either way.
{
  const e = newBoss();
  const owner = hotSpotsOf(e);
  check('the boss carries a measured body', hitShapeSpheres(e.hitShape).length > 0,
    `${hitShapeSpheres(e.hitShape).length} spheres`);
  check('spots were placed on it', (owner?.spots.length ?? 0) > 0,
    `${owner?.spots.length ?? 0} lit`);
  run(2, detailCam);
  check('no shader errors on the first frames', shaderErrors.length === 0,
    shaderErrors[0] ?? '');
}

// ---------------------------------------------------------------------------
section('The animal <span>— what a boss looks like wearing them</span>', 2);
// ---------------------------------------------------------------------------
{
  newBoss(0);
  run(30, bodyCam);
  present('Whole body', 'Every spot on the OUTER EDGE of the silhouette. Half of each glow is over open water, which is what makes a small light findable while the animal turns.', true);

  newBoss(0);
  run(30, fightCam);
  present('At fight scale', 'The frustum the player is actually given (zoom 1 IS the arena). The only frame a judgement about size or glow is worth anything in.');
}

// ---------------------------------------------------------------------------
section('One spot <span>— whole, damaged, struck</span>', 3);
// ---------------------------------------------------------------------------
{
  const heats = [
    ['Whole', 0, 'litColor, breathing slowly. Nothing has hit it yet.'],
    ['Half eaten', 0.5, 'Drifting to hotColor, pulsing faster and chewed deeper at the edge. This IS the warning that it is nearly done — there is no bar.'],
    ['About to go', 0.9, 'Nearly the full shift. The next few pellets burst it.'],
  ];
  for (const [title, heat, note] of heats) {
    const e = newBoss();
    const spot = hotSpotsOf(e).spots[0];
    if (heat > 0) shoot(spot, (spot.pool * heat) / CONFIG.hotSpots.critMul);
    // Past the flash, so this is a picture of the HEAT rather than of a hit.
    run(20, detailCam);
    focus(detailCam, spot);
    run(2, detailCam);
    present(title, note, heat === 0);
  }
}

// ---------------------------------------------------------------------------
section('The hit <span>— does the flash win over a spot that is already warm?</span>', 3);
// ---------------------------------------------------------------------------
{
  for (const [title, heat] of [['Struck cold', 0], ['Struck warm', 0.5], ['Struck hot', 0.85]]) {
    const e = newBoss();
    const spot = hotSpotsOf(e).spots[0];
    if (heat > 0) {
      shoot(spot, (spot.pool * heat) / CONFIG.hotSpots.critMul);
      run(20, detailCam);
    }
    focus(detailCam, spot);
    shoot(spot, 1);
    // Two frames after the blow: the flash decays over `flashSeconds` and the
    // frame it lands on is the one the player's eye is caught by.
    run(2, detailCam);
    present(title, `flashColor over ${Math.round(heat * 100)}% heat. If the three read alike, the flash is not winning and it needs the swell or the lift, not a redder red.`, heat === 0.5);
  }
}

// ---------------------------------------------------------------------------
section('The rupture <span>— matter leaving the animal, not a flare</span>', 4);
// ---------------------------------------------------------------------------
{
  const beats = [
    ['Rupture +2f', 2, 'The instant it goes. The light is still full white and the ichor has barely left.'],
    ['Rupture +8f', 8, 'The mass fusing: a core with spikes torn out of it. This is the frame the ichor group is tuned on.'],
    ['Rupture +20f', 20, 'Coming apart. Lobes separating past their own radius stop summing over the isoline, which is what turns a mass into pieces.'],
    ['Rupture +45f', 45, 'Gone, and the light with it. The gap before another opens is the cost of popping one.'],
  ];
  for (const [title, frames, note] of beats) {
    const e = newBoss();
    const spot = hotSpotsOf(e).spots[0];
    focus(detailCam, spot);
    updateParticleScale(detailCam, gl);
    shoot(spot, spot.pool);
    run(frames, detailCam);
    present(title, note, frames === 8);
  }
}

// ---------------------------------------------------------------------------
section('The rupture at fight scale <span>— the only frame that decides its size</span>', 2);
// ---------------------------------------------------------------------------
{
  for (const [title, frames] of [['Fight scale +8f', 8], ['Fight scale +20f', 20]]) {
    const e = newBoss();
    const spot = hotSpotsOf(e).spots[0];
    updateParticleScale(fightCam, gl);
    shoot(spot, spot.pool);
    run(frames, fightCam);
    present(title, 'A burst tuned in close-up is routinely half the size it needs to be here. ruptureScale is the number this panel moves.', frames === 8);
  }
}

// ---------------------------------------------------------------------------
section('Glow <span>— a ladder, because bloom thresholds luminance</span>', 4);
// ---------------------------------------------------------------------------
{
  for (const g of [1.4, 2.6, 4, 6]) {
    Object.assign(LOOK, LOOK_BASE, { glow: g });
    const e = newBoss();
    const spot = hotSpotsOf(e).spots[0];
    focus(detailCam, spot);
    run(20, detailCam);
    present(`glow ${g}`, g === 2.6
      ? 'Crosses the bloom threshold and holds an edge. Green is most of luminance, so this blooms where a cold blue at the same number would not.'
      : (g < 2.6 ? 'Under the threshold in the water it sits in — a green dot rather than a light.'
        : 'Saturated to white with the bloom welded across it; the spot stops having a boundary.'),
      g === 2.6);
  }
  Object.assign(LOOK, LOOK_BASE);
}

// ---------------------------------------------------------------------------
section('Edge <span>— the number that must NOT be treated as taste</span>', 3);
// ---------------------------------------------------------------------------
{
  for (const ed of [0.3, 0.46, 0.7]) {
    Object.assign(LOOK, LOOK_BASE, { edge: ed });
    const e = newBoss();
    const spot = hotSpotsOf(e).spots[0];
    focus(detailCam, spot);
    run(20, detailCam);
    const drawn = spot.r * 2.2 * ed;
    present(`edge ${ed}`, `Drawn boundary ${drawn.toFixed(2)} against a crit reach of ${spot.r.toFixed(2)}. `
      + (Math.abs(drawn - spot.r) / spot.r < 0.02
        ? 'They agree — the light is telling the truth about where the crit is.'
        : (drawn < spot.r ? 'The light is SMALLER than the reach: hits that pay out look like misses.'
          : 'The light is BIGGER than the reach: hits that look clean pay nothing.')),
      Math.abs(drawn - spot.r) / spot.r < 0.02);
  }
  Object.assign(LOOK, LOOK_BASE);
}

// ---------------------------------------------------------------------------
log('');
check('no shader errors across the whole sheet', shaderErrors.length === 0,
  shaderErrors[0] ?? '');
await Promise.all(posted);
log(fails === 0 ? 'sheet complete' : `${fails} check(s) failed`, fails === 0 ? 'ok' : 'bad');
document.title = fails === 0 ? 'weak spots ok' : 'weak spots FAILED';
