// ---------------------------------------------------------------------------
// BOSS WEAK SPOTS — LOOK DEV
//
//   npm run looks:hotspots
//
// The questions this sheet exists to answer, in the order they were asked:
//
//   1. Does a spot READ as a place ON the animal? It is painted into the
//      boss's own skin by a shell bound to its skeleton, so it wraps the body,
//      shears with a turning flank and is occluded by whatever is in front of
//      it — none of which a quad at the same position can do, and all of which
//      only exist as questions on a real megalodon under the real post chain.
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
import { updateBeatSync, syncBpm } from '../../path/src/systems/beatSync.js';
import {
  initBossHotSpots, attachHotSpots, updateBossHotSpots, hotSpotDamage,
  hotSpotsOf, resetBossHotSpots, releaseHotSpots, setHotSpotLook,
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
    // THE MUSICAL CLOCK, or the throb is frozen at phase 0 in every panel. With
    // no audio context here beatPhase() returns a flat 0 and updateBeatSync
    // free-runs the transport off CONFIG.music.bpm instead — which is the same
    // grid the game animates on (it is NOT the 2.265s audio bar grid, and the
    // two are about 1% apart on purpose; see systems/music.js).
    updateBeatSync(DT);
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
section('The animal <span>— what a boss looks like wearing them</span>', 3);
// ---------------------------------------------------------------------------
{
  // THE CONTROL. The same body, same lights, same post chain, with the shells
  // taken off — so "the glow lands on the animal" is a comparison rather than
  // an impression, and so a change in how the SHARK looks can never be
  // mistaken for a change in how the spots look.
  {
    const e = newBoss(0);
    releaseHotSpots(e);
    run(30, bodyCam);
    present('No spots (control)', 'The boss as it renders with the shells removed. Everything that differs between this panel and the next one is the weak spots and nothing else.');
  }

  newBoss(0);
  run(30, bodyCam);
  present('Whole body', 'Painted into the skin: the glow is clipped to the animal\'s own silhouette, wraps the body and is occluded by whatever is in front of it. The halo past the edge is the bloom.', true);

  newBoss(0);
  run(30, fightCam);
  present('At fight scale', 'The frustum the player is actually given (zoom 1 IS the arena). The only frame a judgement about size or glow is worth anything in.');
}

// ---------------------------------------------------------------------------
section('The mark around it <span>— the half that does not depend on the hide</span>', 3);
// ---------------------------------------------------------------------------
// AT FIGHT SCALE, WHICH IS THE ONLY SCALE THIS ARGUMENT CAN BE HAD AT. The
// painted glow is additive light on an animal, so how far it carries is a
// property of that animal — and on a boss a couple of hundred pixels across it
// is competing with its own bloom, the water and whatever else is lit. The
// ring is drawn in front of everything at a fixed fraction of the spot, so the
// comparison here is "can you find the thing you are supposed to shoot", not
// "is the glow pretty".
{
  const BASE = { ...(LOOK.target ?? {}) };

  LOOK.target = { ...BASE, enabled: false };
  newBoss(0);
  run(30, fightCam);
  present('Glow alone (control)', 'The light on its own at the frustum the player is given. Everything that differs between this panel and the next is the reticle.');

  LOOK.target = { ...BASE };
  newBoss(0);
  run(30, fightCam);
  present('With the target ring', 'The strike mark\'s own bracket at a fraction of its size, depth-test off so a spot on the far flank is still findable. It wears the spot\'s colour ramp — that is what keeps it from reading as a second strike mark.', true);

  // STRUCK, at the same scale. The band fattens and brightens for the length of
  // the spot's own flash: more mass in the same place rather than a whiter
  // white, which is the response that looks like the stuff coming out of it.
  {
    const e = newBoss(0);
    const spot = hotSpotsOf(e).spots[0];
    // THE GOO IS SIZED AGAINST THE CAMERA, and the panels above this one are
    // shot on the close cameras — without this the bleed renders at detail-cam
    // scale over a fight-cam frame and one small leak covers the whole animal.
    updateParticleScale(fightCam, gl);
    shoot(spot, spot.pool / (CONFIG.hotSpots.critMul * 6));
    run(3, fightCam);
    present('The frame it is hit', 'The ring fattens and brightens with the hit and the ichor comes out of the wound underneath it. If the two do not read as one event, it is `hitSwell` that is wrong, not the goo.');
    updateParticleScale(detailCam, gl);
  }

  LOOK.target = BASE;
}

// ---------------------------------------------------------------------------
section('One spot <span>— whole, damaged, struck</span>', 3);
// ---------------------------------------------------------------------------
{
  const heats = [
    ['Whole', 0, 'The base colour, breathing on the half bar. White by default — the neutral anything tinting it lands on cleanly (setHotSpotLook).'],
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
section('The throb <span>— one cycle per half bar, sampled across it</span>', 4);
// ---------------------------------------------------------------------------
// Four frames down one cycle of the pulse, so what the beat lock actually buys
// is visible as a change in BRIGHTNESS rather than having to be taken on trust.
// The reach does not move between these panels and that is the point: pulsing
// the radius would swing the drawn boundary either side of the crit's number
// twice a bar.
{
  const beatSeconds = 60 / Math.max(1, syncBpm());
  const cycle = beatSeconds * 2; // '1/2' is two beats
  const quarter = Math.max(1, Math.round((cycle / 4) / DT));
  const e = newBoss();
  const spot = hotSpotsOf(e).spots[0];
  focus(detailCam, spot);
  for (const [title, note] of [
    ['Throb 0/4', 'The start of the cycle.'],
    ['Throb 1/4', 'Peak. The ring is the part that moves — it is already an order of magnitude over the bloom threshold, so the halo swells with it.'],
    ['Throb 2/4', 'Back through the middle.'],
    ['Throb 3/4', 'Trough. Never dark: pulseDepth moves the brightness around 1, it does not switch the spot off.'],
  ]) {
    run(quarter, detailCam);
    present(title, `${note} At ${Math.round(syncBpm())}bpm one cycle is ${cycle.toFixed(2)}s.`, title === 'Throb 1/4');
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
section('Tinted <span>— the base is white so anything can drive it</span>', 3);
// ---------------------------------------------------------------------------
{
  for (const [title, color, note] of [
    ['Base (white)', null, 'No override. The default every boss wears until something decides otherwise.'],
    ['Perk tint', 0xffd83a, 'The electric perk\'s own yellow, as bossSparkColor would resolve it — the spots and the aura would then be the same fight.'],
    ['Element tint', 0x38b6ff, 'A cold override. Nothing wires this yet; setHotSpotLook is the hook and this is what it buys.'],
  ]) {
    const e = newBoss();
    const spot = hotSpotsOf(e).spots[0];
    if (color != null) setHotSpotLook(e, { color });
    focus(detailCam, spot);
    run(20, detailCam);
    present(title, note, color === null);
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
      ? 'Crosses the bloom threshold and holds an edge. The pass thresholds LUMINANCE, so a white base is the brightest a colour can be at a given value — any tint an override applies can only cost it headroom. The halo past the silhouette is the BLOOM, which is the honest way to get one: bright skin throws light.'
      : (g < 2.6 ? 'Under the threshold in the water it sits in — a green patch rather than a light.'
        : 'Saturated to white with the bloom welded across it; the spot stops having a boundary.'),
      g === 2.6);
  }
  Object.assign(LOOK, LOOK_BASE);
}

// ---------------------------------------------------------------------------
section('On the skin <span>— the whole reason this is not a quad</span>', 3);
// ---------------------------------------------------------------------------
// The three things a decal cannot do, each in the frame that shows it.
{
  const shots = [
    ['Wrapping the flank', 0, 'The patch curves over the body and shears with it. A quad at the same position is a flat disc facing the camera whatever the animal is doing.'],
    ['Turned away', 2.3, 'The same spot with the shark swung round. The lit skin foreshortens, and a spot that has gone round the far side is simply not drawn — nothing here knows which side that is.'],
    ['Occluded by its own body', 1.1, 'Depth-tested against identical geometry at identical skinning, so the glow never shows through the parts of the animal in front of it.'],
  ];
  for (const [title, heading, note] of shots) {
    const e = newBoss(heading);
    const spot = hotSpotsOf(e).spots[0];
    focus(bodyCam, spot);
    run(20, bodyCam);
    present(title, note, heading === 0);
    bodyCam.position.x = 0;
    bodyCam.position.y = 0;
    bodyCam.updateMatrixWorld(true);
  }
}

// ---------------------------------------------------------------------------
log('');
check('no shader errors across the whole sheet', shaderErrors.length === 0,
  shaderErrors[0] ?? '');
await Promise.all(posted);
log(fails === 0 ? 'sheet complete' : `${fails} check(s) failed`, fails === 0 ? 'ok' : 'bad');
document.title = fails === 0 ? 'weak spots ok' : 'weak spots FAILED';
