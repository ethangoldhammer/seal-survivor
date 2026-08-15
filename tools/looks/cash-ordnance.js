// ---------------------------------------------------------------------------
// THE YACHT'S ORDNANCE — LOOK DEV
//
//   npm run looks:cash
//
// The yacht throws money now (CONFIG.enemies.bossYacht `ordnance`), and every
// question left after tools/yacht-boss-test.mjs is a question about a picture.
// That harness proves the wiring — the right asset key, the right spin, a trail
// preset that exists — and it runs against the FALLBACK primitives, because
// Node's GLTFLoader hangs in the headless stub. It cannot see a roll of cash at
// all. What is on this sheet:
//
//   * do the four separated rolls actually look like rolls, at the size a shot
//     renders, or did the split leave a cylinder with no end caps?
//   * tumbling or pointing — which of the two reads as "thrown object" and
//     which as "shell"?
//   * how much trail is too much on a body that already has a texture on it?
//   * and does the detonation read as money coming apart, or as sparks?
//
// It imports the SHIPPING modules — assets.js, projectiles.js,
// projectileTrails.js, particles.js — so every panel is the game's own code
// with the game's own numbers. Built with vite rather than run off the dev
// server on purpose: a build resolves the JSON and ?raw CSV imports without
// starting a second game, which is the thing that overwrites
// imported-tuning.json.
//
// IT WRITES NOTHING. The trail overrides below are assignments into the live
// CONFIG object of a throwaway bundle. There is no save path in this page and
// no dev server behind it.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, hasModel } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import {
  projectiles, spawnProjectile, updateProjectiles, resetProjectiles,
} from '../../path/src/entities/projectiles.js';
import { updateProjectileTrails, clearProjectileTrails } from '../../path/src/systems/projectileTrails.js';
import {
  initParticles, updateParticles, resetParticles, updateParticleScale, emit,
} from '../../path/src/entities/particles.js';

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

const W = 420;
const H = 300;
const DT = 1 / 60;

// ONE WebGL context for the whole page, blitted into a plain 2D canvas per
// cell. A renderer per cell is the obvious way to write this and it silently
// destroys the sheet: browsers keep about sixteen live contexts and discard the
// oldest, so past a dozen panels the early ones go black — AFTER they drew
// correctly, with nothing thrown and nothing in the console.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

updateBounds(W / H);

// A patch of open water, a few units across, seen the way the game sees it.
// Deliberately small: these objects are about one world unit long, and a camera
// framing the arena would render every panel as four green pixels.
const VIEW = 7;
const ortho = (h) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(0, 0, 20);
  return c;
};
const camera = ortho(VIEW);

// THE SAME SHOT AT THE SIZE THE PLAYER SEES IT.
//
// At zoom 1 the frustum IS the arena (see world.js), and zoom rests at 1: the
// only things that move it are the impact punch and the death dive, and
// CONFIG.cinecam is `enabled: false`, so its 1.18 resting width is not what
// anybody is playing at. The frame is the whole ocean — forty-odd units of
// water against a shot that is one.
//
// Every panel above this is a magnifying glass, and a look decision made only
// under a magnifying glass is a decision about a picture nobody is ever shown.
const fightCam = ortho(bounds.top - bounds.bottom);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x2a3438, 2.0));
const key = new THREE.DirectionalLight(0xfff2e0, 2.4); key.position.set(-3, 4, 5); scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe4ff, 1.0); fill.position.set(4, 1, 3); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.1); rim.position.set(1, 2, -5); scene.add(rim);

await preloadAssets();
initParticles(scene);
updateParticleScale(camera, gl);

for (const k of ['moneyRoll1', 'moneyRoll2', 'moneyRoll3', 'moneyRoll4']) {
  check(`${k} loaded`, hasModel(k));
}
const ORD = CONFIG.enemies.bossYacht.ordnance;
check('the yacht names two of them', !!ORD?.barrels?.asset && !!ORD?.missiles?.asset,
  `${ORD?.barrels?.asset} / ${ORD?.missiles?.asset}`);

// --- the sheet --------------------------------------------------------------

let shotIndex = 0;
const posted = [];
let row = null;

function section(title, columns) {
  const h = document.createElement('h2');
  h.textContent = title;
  document.getElementById('sheet').appendChild(h);
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  document.getElementById('sheet').appendChild(row);
}

// Blit whatever is in the renderer into a cell, and POST it. The frames are
// read off DISK rather than off the screen — the Browser pane's own screenshot
// goes blank or times out on a sheet this tall.
function present(title, note, picked = false) {
  const cell = document.createElement('div');
  cell.className = picked ? 'cell pick' : 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  // The renderer is alpha:true, so the water behind it is this fill and not
  // the sky — a transparent PNG on a white viewer is a picture of nothing.
  ctx.fillStyle = '#081426';
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

// Everything the previous panel left behind. Shared module state — the
// projectile list, the trail map and the particle buffer are all singletons —
// so a panel that does not clear is a panel showing the one before it.
function clearAll() {
  clearProjectileTrails(scene);
  resetProjectiles(scene);
  resetParticles();
}

// --- one flight -------------------------------------------------------------

// A shot fired left to right across the panel, ticked with the REAL
// updateProjectiles and the REAL trail update, and captured mid-flight once the
// ribbon has had time to fill. `gravityScale: 0` and a flat heading are what
// fireBossShot gives a boat's ordnance below the water.
function flight({ asset, orient = false, spin = 0, speed = 9, frames = 46, trail, tilt = 0, cam = camera }) {
  clearAll();
  updateParticleScale(cam, gl);
  const restore = Object.prototype.hasOwnProperty.call(CONFIG.trails, asset)
    ? CONFIG.trails[asset] : undefined;
  if (trail !== undefined) {
    if (trail === null) delete CONFIG.trails[asset];
    else CONFIG.trails[asset] = trail;
  }

  const view = cam.top - cam.bottom;
  spawnProjectile(scene, {
    origin: new THREE.Vector3(-view * (W / H) / 2 + view * 0.09, -view * 0.03, 0),
    dir: new THREE.Vector3(1, 0.16, 0),
    faction: 'enemy',
    damage: 16,
    speed,
    life: 9,
    radius: 0.5,
    asset,
    scale: 1,
    orient,
    spin,
    gravityScale: 0,
    source: 'look:cash',
  });

  // THE CANT, and it is the whole reason this parameter exists. The game is a
  // side view: the camera looks straight down -Z, so a cylinder whose axis lies
  // in the XY plane presents its curved side flat-on for the entire flight and
  // renders as a RECTANGLE. Spinning it about z does not help — it is a
  // rectangle at every angle. Tilting the body out of the screen plane brings
  // the end cap into view as an ellipse, which is the only part of this model
  // that says "roll" rather than "brick".
  //
  // Set on the ROOT, after the spawn: `spin` writes rotation.z and nothing
  // else, so an x tilt survives every frame of the tumble.
  if (tilt) for (const p of projectiles) p.mesh.rotation.x = tilt;

  for (let i = 0; i < frames; i++) {
    updateProjectiles(DT, scene, [], () => {}, () => {}, () => {});
    updateProjectileTrails(DT, scene, projectiles);
    updateParticles(DT);
  }
  gl.render(scene, cam);

  if (trail !== undefined) {
    if (restore === undefined) delete CONFIG.trails[asset];
    else CONFIG.trails[asset] = restore;
  }
}

// A roll held still, at the size a shot renders, turned a little off axis so
// the sheet shows a body rather than a silhouette.
function still(asset, turn = 0.5) {
  clearAll();
  const mesh = createVisual(asset);
  mesh.rotation.set(0.35, turn, 0.2);
  scene.add(mesh);
  gl.render(scene, camera);
  scene.remove(mesh);
}

// A burst on its own, at the blast radius `rain` actually uses — the same call
// boom() makes in systems/bossPerks.js, including the radius scaling.
function burst(emitter, radius, frames, cam = camera) {
  clearAll();
  updateParticleScale(cam, gl);
  emit(emitter, 0, 0, { scale: Math.max(0.5, radius / 3) });
  for (let i = 0; i < frames; i++) updateParticles(DT);
  gl.render(scene, cam);
}

// --- WHICH MESH -------------------------------------------------------------
// The split, seen at shot size. `fit` normalises the longest axis, so all four
// are the same length here whatever they measured in the pile — what differs is
// the banding and the state of the paper.
section('The four rolls — which mesh goes in which gun', 4);
for (const k of ['moneyRoll1', 'moneyRoll2', 'moneyRoll3', 'moneyRoll4']) {
  still(k);
  const picked = k === ORD.barrels.asset || k === ORD.missiles.asset;
  const role = k === ORD.barrels.asset ? 'the explosive'
    : k === ORD.missiles.asset ? 'the seeker' : 'spare';
  present(k, `${role} · fit ${CONFIG.assets?.[k]?.fit ?? '—'}`, picked);
}

// --- HOW IT FLIES -----------------------------------------------------------
section('How the explosive flies — the one read the player gets at a glance', 3);
flight({ asset: ORD.barrels.asset, orient: false, spin: 4.6 });
present('Tumbling', 'orient off, spin 4.6 · reads as a thing that was thrown', true);
flight({ asset: ORD.barrels.asset, orient: true, spin: 0 });
present('End-on', 'orient on · points down its heading, like a shell');
flight({ asset: ORD.barrels.asset, orient: false, spin: 0 });
present('Rigid', 'neither · the drum\'s own behaviour, on a body that has a top and a bottom');

// --- THE CANT ---------------------------------------------------------------
// The problem the panels above show and cannot fix: side-on, a cylinder is a
// rectangle, and no amount of spinning it in the screen plane makes it a roll.
section('Canting it out of the screen plane — brick or roll', 4);
for (const [t, note] of [
  [0, 'flat in the plane · a brick with a banknote printed on it'],
  [0.35, 'a fifth of a turn · the end cap comes in as an ellipse'],
  [0.6, 'a third · reads as a roll, still shows the banding'],
  [1.0, 'most of a quarter turn · nearly end-on, the banding is gone'],
]) {
  flight({ asset: ORD.barrels.asset, spin: 4.6, tilt: t });
  present(`Cant ${t.toFixed(2)}`, note);
}

// --- WHAT IT LEAVES ---------------------------------------------------------
const CASH = CONFIG.trails[ORD.barrels.asset];
section('What it leaves behind', 4);
flight({ asset: ORD.barrels.asset, spin: 4.6, trail: null });
present('Nothing', 'what the oil drum does today · no trail preset at all');
flight({ asset: ORD.barrels.asset, spin: 4.6, trail: { ...CASH, particles: null } });
present('Ribbon only', 'the green-gold ribbon, no paper');
flight({ asset: ORD.barrels.asset, spin: 4.6 });
present('Ribbon and bills', `cashTrail at ${CASH.particles.perSecond}/s · cold, slow, barely falling`, true);
flight({ asset: ORD.barrels.asset, spin: 4.6, trail: { ...CONFIG.trails.missile } });
present('The fire trail', 'the mussel\'s preset, borrowed · a banknote reading as an exhaust plume');

// --- THE SEEKER -------------------------------------------------------------
// Read the pair together. Everything about them is deliberately the same
// except the two things that carry the warning.
section('The pair, as shipped — this is what has to be told apart mid-fight', 2);
flight({ asset: ORD.barrels.asset, spin: ORD.barrels.spin, tilt: ORD.barrels.tilt, speed: 9 });
present('The explosive', `${ORD.barrels.asset} · tumbles, canted ${ORD.barrels.tilt}, wider ribbon, fuse`, true);
flight({ asset: ORD.missiles.asset, orient: true, speed: 13 });
present('The seeker', `${ORD.missiles.asset} · points at you, faster, narrower ribbon, no fuse`, true);

// --- THE DETONATION ---------------------------------------------------------
const rainRadius = CONFIG.bossBoat.patterns.rain.blastRadius;
section('The detonation — what a fuse leaves in the water', 3);
burst('missileImpact', rainRadius, 14);
present('Sparks', 'missileImpact · the game\'s existing blast, for scale');
burst('cashBurst', rainRadius, 14);
present('Cash, at the blast', `cashBurst scaled by radius ${rainRadius}`, true);
burst('cashBurst', rainRadius, 70);
present('Cash, a second later', 'the same burst held · the blast is over long before the litter is', true);

// --- AT FIGHT SCALE ---------------------------------------------------------
// Everything above is a magnifying glass. This is the frame the player is
// actually given — with the SEAL in it, because "one unit" means nothing and
// "a third the length of the animal you are driving" means everything.
const fightView = (bounds.top - bounds.bottom).toFixed(0);
const seal = createVisual('ship');
// createVisual points a body's forward axis at world +Y — nose-up — because
// that is what the game's own facing code then turns. A still preview has to
// lay it down itself, or the scale reference is a seal seen end-on.
seal.rotation.z = -Math.PI / 2;
function withSeal(fn) {
  seal.position.set(-6, -3, 0);
  scene.add(seal);
  fn();
  scene.remove(seal);
}
section(`At fight scale — the whole arena, ${fightView} units tall, with the seal for scale`, 3);
withSeal(() => flight({ asset: ORD.barrels.asset, spin: ORD.barrels.spin, tilt: ORD.barrels.tilt, cam: fightCam, frames: 150, speed: 9 }));
present('The explosive, in frame', `fit ${CONFIG.assets?.[ORD.barrels.asset]?.fit ?? 1} against ${fightView} units of water · the trail is the read`, true);
withSeal(() => flight({ asset: ORD.barrels.asset, spin: ORD.barrels.spin, tilt: ORD.barrels.tilt, cam: fightCam, frames: 150, speed: 9, trail: { ...CASH, width: CASH.width * 2.2, glow: CASH.glow * 1.5, particles: { ...CASH.particles, perSecond: 40 } } }));
present('...with the trail pushed', 'ribbon 2.2x wider, 1.5x brighter, 40 bills/s · the same shot, legible');
burst('cashBurst', CONFIG.bossBoat.patterns.rain.blastRadius, 26, fightCam);
present('The blast, in frame', `radius ${CONFIG.bossBoat.patterns.rain.blastRadius} against the arena`, true);

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nall panels rendered', fails ? 'bad' : 'ok');
