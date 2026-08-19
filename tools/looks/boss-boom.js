// ---------------------------------------------------------------------------
// THE BOSS GOING UP — LOOK DEV
//
//   npm run looks:boom
//
// The question this sheet exists to answer: what does a Wind Waker smoke
// explosion look like when it is made out of the goo pass this game already
// has, how big should it be, and which of half a dozen shapes should ship.
//
// Nothing here re-implements any of it. The page imports the SHIPPING modules —
// systems/bossBoom.js, entities/particles.js, systems/post.js — so every panel
// is the game's own code with the game's own numbers, and a panel that renders
// nothing is a GLSL error or a bad isoline rather than a bug in a mock.
//
// THE TWO CLOCKS ARE THE WHOLE POINT AND THIS PAGE RUNS BOTH. A boss dies
// inside the kill shot, which holds the water at CONFIG.boss.kill.hold (a tenth
// speed) through the beat the photograph is taken in. So every panel below
// advances updateBossBooms on the WALL clock and updateParticles on the DILATED
// one, exactly as main.js does — which is the only way to see the thing the
// design turns on: the cloud blooms because each ring is BORN at its radius,
// across an ocean that is barely moving.
//
// IT WRITES NOTHING. The CONFIG assignments below are into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, assetBaseColor } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  initParticles, updateParticles, resetParticles, updateParticleScale,
} from '../../path/src/entities/particles.js';
import { fireBossBoom, updateBossBooms, resetBossBooms, bossBoomCount, measureBossBody } from '../../path/src/systems/bossBoom.js';
import { spawnNamed, resetEnemies } from '../../path/src/entities/enemies.js';
import { refreshHitShape, hitShapeSpheres } from '../../path/src/systems/hitShape.js';
import { initBossGibs, updateBossGibs, resetBossGibs, spawnBossGibs } from '../../path/src/systems/bossGibs.js';

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

// A shader that fails to compile renders NOTHING and three only writes to the
// console about it, so the page would look like a bad tuning decision instead
// of a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 460;
const H = 330;
const DT = 1 / 60;

// EVERY EXPLOSION ON THIS PAGE IS THE SAME EXPLOSION. The ring phase, the
// jitter, and every size, speed and life inside emit() are rolled per particle,
// so a ladder of four values for one control was four different explosions and
// the panel-to-panel difference was mostly the dice. Reseeded before each
// detonation, so the only thing that changes down a row is the thing being
// compared.
let seed = 0;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = () => { seed = 0xb0551f00; };

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

// Water to put the cloud in. The `boom` group is ALPHA — it hides what is
// behind it — so a panel over empty black would prove nothing about the one
// property the whole effect depends on.
//
// Authored much brighter than it looks, on purpose: the game's composite writes
// linear straight to the default framebuffer, so every colour lands about a
// stop and a half darker than its hex. That is the pipeline the game is tuned
// under, not something for this page to fix.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x38708f }),
);
water.position.z = -30;
scene.add(water);

await preloadAssets();
initParticles(scene);
initBossGibs(scene);
const post = createPost(gl);

const ortho = (h, y = 0) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(0, y, 20);
  return c;
};
// Close enough to read the edge of the cloud. Most panels compare SHAPE.
const camera = ortho(34);
// The frame the player is actually given: at zoom 1 the frustum IS the arena.
const fightCam = ortho(bounds.top - bounds.bottom, (bounds.top + bounds.bottom) / 2);

// --- the clocks -------------------------------------------------------------
// What the water is doing while this fires. The explosion lands inside the kill
// shot's held beat, so the world is at `hold` and the wall clock is not.
const HOLD = Math.max(0.02, Math.min(1, CONFIG.boss?.kill?.hold ?? 0.12));

// --- the colours a boss actually has ----------------------------------------
const BOSSES = [
  ['bossShark', 'megalodon'],
  ['bossOrca', 'orca'],
  ['bossSquid', 'kraken'],
  ['bossCrab', 'king crab'],
];
// The ASSET each archetype wears, not the archetype id — `bossShark` is a row
// in CONFIG.enemies and the body it puts on is `enemyMosasaur`. Read off a
// spawned creature rather than typed, which is also what fireBossBoom does.
const BOSS_MUL = { bossShark: 1.6, bossOrca: 1.7, bossSquid: 1.2, bossCrab: 3.6 };

function spawnBoss(key, at = { x: 0, y: -6 }) {
  const e = spawnNamed(scene, key, 0, at, { ignoreCaps: true, overfill: true });
  if (!e) return null;
  // The boss step from bosses.csv, applied the way systems/boss.js applies it.
  const mul = BOSS_MUL[key] ?? 1;
  e.visual.scale.multiplyScalar(mul);
  e.spawnScale = (e.spawnScale ?? 1) * mul;
  e.sizeMul = (e.sizeMul ?? 1) * mul;
  e.radius *= mul;
  e.isBoss = true;
  e.vx = 0;
  e.vy = 0;
  // WITHOUT THIS EVERY SPHERE MEASURES ITS BIND-POSE PLACE. A hitbox rides the
  // bones, and three only refreshes world matrices during a render — so a shape
  // refreshed on the frame of a spawn reads the matrices from before the visual
  // was scaled or posed, and reports a plausible, wrong number.
  scene.updateMatrixWorld(true);
  if (e.hitShape) refreshHitShape(e.hitShape);
  return e;
}

let TINT = 0xff4d6d;
{
  const e = spawnBoss('bossShark');
  const c = e ? assetBaseColor(e.assetKey) : null;
  if (c != null) TINT = c;
  check('a boss colour to tint with', c != null,
    `${e?.assetKey ?? '?'} #${new THREE.Color(TINT).getHexString()}`);
  resetEnemies(scene);
}

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

// --- one explosion ----------------------------------------------------------

const BOOM = CONFIG.boss.boom;
const BOOM_BASE = JSON.parse(JSON.stringify(BOOM));
const GROUP = CONFIG.fx.goo.groups.boom;
const GROUP_BASE = { ...GROUP };

function restore() {
  for (const k of Object.keys(BOOM)) delete BOOM[k];
  Object.assign(BOOM, JSON.parse(JSON.stringify(BOOM_BASE)));
  Object.assign(GROUP, GROUP_BASE);
}

// A body with no visual: a point, a radius and a colour, which is exactly the
// three things fireBossBoom reads off a creature with no hitbox. Lets a panel
// ask for "a nine-unit boss" without having to find an animal that is one.
function stand(r, color, at = [0, 0], v = [0, 0]) {
  return {
    mesh: { position: { x: at[0], y: at[1] } },
    radius: r,
    assetKey: '__none__',
    // fireBossBoom falls back to gibs.fallbackColor for an unknown key, so the
    // colour under test is forced through the same field the real one uses.
    vx: v[0], vy: v[1],
    __color: color,
  };
}

// Every panel: reset, seed, override, detonate, and run BOTH clocks for a while.
//
// `wall` is how long after the explosion starts the picture is taken. The
// default is the shipped lead, which is the frame the game's own shutter goes —
// so an unqualified panel on this page is showing the trophy photograph.
function detonate({
  r = 5, color = TINT, at = [0, 0], v = [0, 0],
  wall = CONFIG.boss.boom.lead, scale = HOLD,
  boom = {}, goo = {}, cam = camera, clear = true, body = null,
} = {}) {
  if (clear) {
    resetParticles();
    resetBossBooms();
    restore();
    reseed();
  }
  Object.assign(BOOM, boom);
  Object.assign(GROUP, goo);
  updateParticleScale(cam, gl);

  const e = body ?? stand(r, color, at, v);
  // The colour comes off the asset inside fireBossBoom, so a synthetic body is
  // given its colour through the one field that answers for an unknown key.
  const wasFallback = CONFIG.boss.gibs.fallbackColor;
  if (e.__color != null) CONFIG.boss.gibs.fallbackColor = e.__color;
  fireBossBoom(e);
  CONFIG.boss.gibs.fallbackColor = wasFallback;

  run(wall, scale, cam);
}

function run(wall, scale = HOLD, cam = camera) {
  const frames = Math.max(1, Math.round(wall / DT));
  for (let i = 0; i < frames; i++) {
    // WALL for the schedule, DILATED for the water. Both, every frame, exactly
    // as main.js runs them.
    updateBossBooms(DT);
    updateParticles(DT * scale);
    updateBossGibs(DT * scale);
    post.resize();
    post.render(scene, cam, DT);
  }
}

// --- THE COMPILE, FIRST -----------------------------------------------------
// The goo pass is skipped on any frame with nothing goopy alive, so its
// programs link on the frame of the first burst unless the warm-up has already
// drawn the pass empty. Checked here, before any panel, or the assertion passes
// for the wrong reason.
post.render(scene, camera, 0);
const beforeWarm = gl.info.programs.length;
post.warmGoo(camera);
const warmed = gl.info.programs.length;
check('the warm-up links the goo programs', warmed > beforeWarm,
  `${beforeWarm} -> ${warmed} programs`);
detonate({ wall: 0.34 });
check('the first boss to go up compiles nothing', gl.info.programs.length === warmed,
  `${warmed} before, ${gl.info.programs.length} after`);
check('the wave table emptied itself', bossBoomCount() === 0, `${bossBoomCount()} still queued`);
resetParticles();
resetBossBooms();

// --- WHAT THE BODY MEASURES AS ----------------------------------------------
// The one number the whole effect is scaled by, read off the real animals so
// the clamps below can be judged against something rather than guessed at.
const measured = [];
// What each archetype actually turned out to be, filled in by the sweep below
// and used by the colour and size rows further down — so no asset key or hex
// on this page is typed, and a roster change cannot leave the sheet lying.
const ROSTER = [];
for (const [key, name] of BOSSES) {
  const e = spawnBoss(key);
  if (!e) { measured.push(`${name}: no spawn`); continue; }
  const sph = e.hitShape ? hitShapeSpheres(e.hitShape) : null;
  let extent = 0;
  let biggest = 0;
  if (sph?.length) {
    let cx = 0; let cy = 0; let vol = 0;
    for (const s of sph) { if (!(s.wr > 0)) continue; const w = s.wr ** 3; cx += s.wx * w; cy += s.wy * w; vol += w; biggest = Math.max(biggest, s.wr); }
    if (vol > 0) {
      cx /= vol; cy /= vol;
      for (const s of sph) { if (!(s.wr > 0)) continue; extent = Math.max(extent, Math.hypot(s.wx - cx, s.wy - cy) + s.wr); }
    }
  }
  const c = assetBaseColor(e.assetKey);
  // What fireBossBoom will ACTUALLY use — the same call, not a second copy of
  // the maths, so a body with no hitbox reports the visual bounds it falls back
  // to rather than the collision radius the sweep above can see.
  const used = measureBossBody(e);
  ROSTER.push({
    name,
    assetKey: e.assetKey,
    color: c,
    // Exactly what fireBossBoom will use: the measured extent, or the
    // collision radius for a body that has no hitbox to measure.
    r: used?.r ?? e.radius,
    hasShape: !!extent,
  });
  measured.push(`${name} (${e.assetKey}, #${c != null ? new THREE.Color(c).getHexString() : '—'}): `
    + `extent ${extent ? extent.toFixed(1) : '—'}, `
    + `thickest sphere ${biggest ? biggest.toFixed(1) : '—'}, def radius ${e.radius.toFixed(1)}, `
    + `${sph?.length ?? 0} spheres · SIZED OFF ${(used?.r ?? 0).toFixed(1)}`);
  resetEnemies(scene);
}
for (const m of measured) log(`  ${m}`);
log(`clamped into [${BOOM_BASE.minRadius}, ${BOOM_BASE.maxRadius}] before anything is scaled by it`);

// --- THE MOMENT -------------------------------------------------------------
section('The bloom, on the wall clock <span>— the water is held at a tenth speed for all four of these</span>', 4);
for (const [wall, note] of [
  [0.02, 'the core only · one white-hot knot'],
  [0.08, 'the first ring is out'],
  [0.16, 'the body ring, opening'],
  [0.34, 'the outer ring, and the shutter'],
]) {
  detonate({ wall });
  present(`+${Math.round(wall * 1000)}ms`, note, wall === 0.34);
}

// --- WHY IT IS BORN SPREAD --------------------------------------------------
section('Why the rings are born at their radius <span>— the same explosion with the bloom left to velocity</span>', 2);
detonate({
  wall: 0.34,
  boom: { waves: [{ at: 0, ring: 0.1, puffs: 30, lobe: 0.3, throw: 6, tone: 1.3, white: 0.2, jitter: 0.4 }] },
});
present('One burst, thrown outward', 'the honest version: 30 lobes fired from one point at 6x the body. '
  + 'At a tenth speed they have travelled almost nowhere by the shutter — this is what the photo would keep');
detonate({ wall: 0.34 });
present('Four rings, born spread', 'the same 0.34s, the same frozen water · the bloom is in the SCHEDULE, '
  + 'not in the velocity', true);

// --- THE SHAPE --------------------------------------------------------------
section('Options — the shape <span>— four wave tables, all at the shutter</span>', 4);
detonate({ wall: 0.34 });
present('Cauliflower', 'four rings, opening and darkening outward · a lit core with a heavy edge', true);
detonate({
  wall: 0.34,
  boom: { waves: [{ at: 0, ring: 0.80, puffs: 26, lobe: 0.32, throw: 1.2, tone: 1.15, white: 0.2, jitter: 0.55 }] },
});
present('Single puffball', 'one ring, everything at once · rounder, flatter, no ramp through it — '
  + 'cheapest and the least like an explosion');
detonate({
  wall: 0.34,
  boom: {
    waves: [
      { at: 0.00, ring: 0.14, puffs: 4, lobe: 0.30, throw: 0.4, tone: 1.9, white: 0.6, jitter: 0.4 },
      { at: 0.10, ring: 1.35, puffs: 28, lobe: 0.24, throw: 2.2, tone: 1.05, white: 0, jitter: 0.18 },
      { at: 0.20, ring: 2.10, puffs: 56, lobe: 0.22, throw: 2.8, tone: 0.7, white: 0, jitter: 0.10 },
    ],
  },
});
present('Shockwave', 'a hot core and a hollow ring racing away from it · reads bigger, leaves the body visible '
  + 'in the hole');
detonate({
  wall: 0.34,
  boom: {
    waves: [
      { at: 0.00, ring: 0.16, puffs: 5, lobe: 0.34, throw: 0.5, tone: 1.45, white: 0.5, jitter: 0.45, rise: 0 },
      { at: 0.06, ring: 0.46, puffs: 9, lobe: 0.30, throw: 0.8, tone: 1.15, white: 0.15, jitter: 0.3, rise: 0.55 },
      { at: 0.13, ring: 0.78, puffs: 14, lobe: 0.28, throw: 1.0, tone: 0.85, white: 0, jitter: 0.28, rise: 1.25 },
      { at: 0.22, ring: 1.12, puffs: 20, lobe: 0.25, throw: 1.3, tone: 0.62, white: 0, jitter: 0.24, rise: 2.0 },
    ],
  },
});
present('Column', 'the same rings, each centred higher than the last · a mushroom. Right for a burning hull, '
  + 'wrong for an animal dying underwater');

// --- THE SURFACE ------------------------------------------------------------
section('Options — the surface <span>— one wave table, five thresholds of the same field</span>', 5);
detonate({ wall: 0.34, goo: { rim: 0, soft: 0.05 } });
present('Flat cel', 'threshold only · a drawn silhouette with no line round it');
detonate({ wall: 0.34 });
present('Dark outline', 'rim -0.55 · the same band every other group BRIGHTENS, darkened instead — '
  + 'a cel outline for no extra pass', true);
detonate({ wall: 0.34, goo: { rim: 0.7 } });
present('Wet rim', 'rim +0.7 · the blood group\'s highlight. Reads as liquid, which is the one thing '
  + 'smoke is not');
detonate({ wall: 0.34, goo: { soft: 0.42, rim: 0, opacity: 0.75 } });
present('Misty', 'a soft wide edge · the burning-hull smoke at explosion scale. Photographic, not drawn');
detonate({ wall: 0.34, goo: { additive: true, rim: 0.4, opacity: 0.85 } });
present('Additive', 'adds light to the water instead of hiding it · the body stays visible through it');

// --- SIZE -------------------------------------------------------------------
section('Size comes off the measured body <span>— the same table, three animals</span>', 4);
for (const [r, note] of [
  [4.1, 'the king crab · no hitbox, so its collision radius stands in'],
  [12.5, 'the kraken · the smallest measured hitbox in the boss roster'],
  [16.8, 'the megalodon · the biggest'],
  [17.0, 'the ceiling · anything bigger is clamped here'],
]) {
  detonate({ wall: 0.34, r, cam: fightCam });
  present(`Body r=${r}`, `${note} · shown in the arena frustum`, r === 16.8);
}

// --- COLOUR -----------------------------------------------------------------
section('Colour comes off the boss <span>— assetBaseColor, the same field its wreckage uses</span>', 4);
for (const b of ROSTER) {
  detonate({ wall: 0.34, color: b.color ?? TINT, r: b.r, cam: fightCam });
  present(b.name, `${b.assetKey} · ${b.color != null ? `#${new THREE.Color(b.color).getHexString()}` : 'no asset colour — the fallback'}`
    + ` · body ${b.r.toFixed(1)}${b.hasShape ? '' : ' (no hitbox)'}`);
}

// --- HOW LOUD ---------------------------------------------------------------
section('How much cloud <span>— the one master that means “bigger” without changing the shape</span>', 4);
for (const size of [0.65, 1, 1.4, 1.9]) {
  detonate({ wall: 0.34, boom: { size } });
  present(`Size x${size}`, size < 0.8 ? 'a puff — reads as damage, not as an ending'
    : size > 1.6 ? 'swallows the frame; at fight scale the seal goes with it' : 'the body, and half again',
  size === 1);
}

// --- AFTER THE SHUTTER ------------------------------------------------------
section('After the picture <span>— the water comes back and the cloud finishes its life</span>', 4);
for (const [after, note] of [
  [0, 'the shutter'],
  [0.5, 'half a second of real time later'],
  [1.4, 'opening and rising'],
  [2.6, 'thinning out, breaking into separate lobes'],
]) {
  detonate({ wall: 0.34 });
  if (after > 0) run(after, 1, camera);
  present(`+${after}s real`, note, after === 0);
}

// --- IN THE FRAME THE PLAYER GETS -------------------------------------------
section('At fight scale, over the animal <span>— the arena frustum, a real megalodon, its own wreckage under it</span>', 3);
{
  const shark = () => spawnBoss('bossShark', { x: 4, y: -14 });

  resetParticles(); resetBossBooms(); resetBossGibs(); restore(); reseed();
  let boss = shark();
  check('a real boss to blow up', !!boss);
  updateParticleScale(fightCam, gl);
  run(0.34, HOLD, fightCam);
  present('The body, no explosion', 'what the trophy holds today: a corpse rolling over in dilated water');

  resetParticles(); resetBossBooms(); resetBossGibs(); reseed();
  resetEnemies(scene); boss = shark();
  updateParticleScale(fightCam, gl);
  fireBossBoom(boss);
  run(0.34, HOLD, fightCam);
  present('The shutter', 'the cloud is over the animal and hides most of it — which is the point: '
    + 'the boss is never seen being deleted', true);

  // ...and 0.18s of wall clock later the body bursts, behind the cloud.
  resetParticles(); resetBossBooms(); resetBossGibs(); reseed();
  resetEnemies(scene); boss = shark();
  updateParticleScale(fightCam, gl);
  fireBossBoom(boss);
  run(0.34, HOLD, fightCam);
  spawnBossGibs(boss);
  run(0.4, HOLD, fightCam);
  present('...and the body bursts under it', 'afterShot later · the gibs arrive inside the smoke, so the '
    + 'switch from animal to wreckage happens where nobody can see it');
  resetEnemies(scene);
}

restore();
resetParticles();
resetBossBooms();
resetBossGibs();

check('no shader errors', shaderErrors.length === 0, shaderErrors[0] ?? '');
await Promise.all(posted);
log(fails ? `${fails} FAILED` : 'all checks passed', fails ? 'bad' : 'ok');
log(`${shotIndex} frames written`);
document.title = fails ? `boss boom — ${fails} FAILED` : 'boss boom — ok';
