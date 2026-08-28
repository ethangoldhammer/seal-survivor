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
import { fireBossBoom, updateBossBooms, resetBossBooms, bossBoomCount, measureBossBody, initBossBooms, bossBoomPalette } from '../../path/src/systems/bossBoom.js';
import { bodyPalette } from '../../path/src/systems/bodyPalette.js';
import { spawnBossDissolve, resetBossDissolve } from '../../path/src/systems/bossDissolve.js';
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

// Water to put the cloud in. The `boom` group is ADDITIVE — it adds light to
// whatever is behind it rather than hiding it — so a panel over empty black
// would be the one background on which that reads as a solid cloud, and would
// prove the opposite of what this page is for.
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
// The shockwave is a scene object. Without this the cloud fires exactly as it
// does in the game and the front is silently missing from every panel — which
// is the same failure the game would have, and the reason it is one call.
initBossBooms(scene);
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

function present(title, note, picked = false, swatches = null) {
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
  // THE PALETTE, DRAWN. A list of hexes in a caption is unreadable and the
  // whole question this section asks — did the cloud get the animal's colours —
  // is answered by putting the swatches beside the cloud at the width they
  // actually cover.
  if (swatches?.length) {
    const strip = document.createElement('div');
    strip.style.cssText = 'display:flex;height:14px;margin-top:7px;border-radius:3px;overflow:hidden';
    for (const sw of swatches) {
      const cellSw = document.createElement('div');
      cellSw.style.cssText = `flex:${Math.max(0.02, sw.share)};background:#${sw.hex.toString(16).padStart(6, '0')}`;
      cellSw.title = `#${sw.hex.toString(16).padStart(6, '0')} · ${Math.round(sw.share * 100)}%`
        + `${sw.sources ? ` · ${sw.sources.join(', ')}` : ''}${sw.raw ? ' · raw' : ''}`;
      strip.appendChild(cellSw);
    }
    cap.appendChild(strip);
  }
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
present('Hollow ring (a wave table)', 'a hot core and a ring of GOO racing away from it — not the real front, which is its own row below · reads bigger, leaves the body visible '
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
detonate({ wall: 0.34, goo: { iso: 0.36, soft: 0.05, opacity: 0.97, additive: false, rim: -0.55, rimWidth: 0.5 } });
present('Dark outline (was)', 'rim -0.55 · the same band every other group BRIGHTENS, darkened '
  + 'instead — a cel outline for no extra pass, and an opaque cloud to draw it on');
detonate({ wall: 0.34, goo: { additive: false, opacity: 0.97, rim: 0.7 } });
present('Wet rim', 'rim +0.7 · the blood group\'s highlight. Reads as liquid, which is the one thing '
  + 'smoke is not');
detonate({ wall: 0.34, goo: { additive: false, opacity: 0.75, soft: 0.42, rim: 0 } });
present('Misty', 'a soft wide edge · the burning-hull smoke at explosion scale. Photographic, not drawn');
detonate({ wall: 0.34 });
present('Additive (ships)', 'adds light to the water instead of hiding it · the body stays '
  + 'visible through it', true);

// --- THE EDGE, ONCE IT IS LIGHT ---------------------------------------------
// The rim band is a share of DENSITY, not a distance: it brightens everything
// between the isoline and `iso + rimWidth`. On the old alpha surface that band
// was mostly hidden under an opaque interior. On an additive one it is not, and
// a wide band lights the dip between every pair of lobes — so the cloud comes
// back as fifty overlapping CIRCLES instead of one mass with an edge. This row
// is where that number gets settled.
section('The edge, now that it is light <span>— rimWidth, over the animal, at the shutter</span>', 4);
{
  const shark = () => spawnBoss('bossShark', { x: 4, y: -14 });
  const over = (goo, boom, title, note, picked = false) => {
    resetParticles(); resetBossBooms(); resetBossGibs(); restore(); reseed();
    resetEnemies(scene);
    const boss = shark();
    updateParticleScale(fightCam, gl);
    Object.assign(GROUP, goo);
    Object.assign(BOOM, boom);
    fireBossBoom(boss);
    run(0.34, HOLD, fightCam);
    present(title, note, picked);
  };

  over({ rimWidth: 0.34 }, {}, 'rimWidth 0.34',
    'the band reaches a third of the way down the density · every lobe draws its own ring '
    + 'and the mass reads as a raft of bubbles');
  over({ rimWidth: 0.14 }, {}, 'rimWidth 0.14',
    'only the true outer edge is lit · the interior goes back to being one body');
  over({ rimWidth: 0.14, iso: 0.38 }, {}, '...and a higher isoline',
    'iso 0.38 · pulls the surface in, so the lobes are rounder and the silhouette is tighter');
  over({ rimWidth: 0.14 }, { glow: 0.42 }, '...and a dimmer core',
    'glow 0.42 · additive light is already a lift, so the emitter\'s own brightness comes '
    + 'down and the core stops blowing out to flat white', true);
  resetEnemies(scene);
}

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

// --- STRUCK OFF THE EDGE ----------------------------------------------------
// THE ONE SECTION WITH AN ANIMAL IN IT, and it has to be: every panel above
// detonates a `stand()` — a point and a radius — which measures as a CIRCLE by
// definition and so cannot show the thing this is about. The bands are laid
// along the body's measured silhouette and pushed outward from it, so the only
// way to see whether that is happening is to put a body under one.
//
// The question: does the cloud stay off the animal. An explosion centred on the
// centroid puts its brightest, densest lobes exactly where the boss is, and the
// trophy comes out with a lit shape in it that is the smoke rather than the
// shark. Left column is that; the rest is the aura.
section('Struck off the edge <span>— the same explosion, over the animal that made it</span>', 3);
{
  const RIM = BOOM_BASE.rim ?? {};
  for (const [key, name] of [['bossShark', 'megalodon'], ['bossSquid', 'kraken'], ['bossCrab', 'king crab']]) {
    for (const [rim, label, note] of [
      [{ ...RIM, enabled: false }, 'rings about the centre',
        'what this was — the core lands on the body and the animal is photographed through it'],
      [RIM, 'struck off the edge',
        'the bands walk the measured silhouette and push outward · nothing is born inside it'],
    ]) {
      const e = spawnBoss(key, { x: 0, y: 0 });
      if (!e) { resetEnemies(scene); continue; }
      updateParticleScale(fightCam, gl);
      detonate({ wall: 0.34, body: e, boom: { rim }, cam: fightCam });
      present(`${name} · ${label}`, note, rim.enabled !== false);
      resetEnemies(scene);
    }
  }
}

// HOW FAR THE AURA STANDS OFF. `reach` is where the outermost band lands, x the
// body radius, measured OUTWARD from the skin — the one number to move if the
// cloud is too thick to see the boss through, or too thin to read as an
// explosion at all.
section('How far it stands off <span>— CONFIG.boss.boom.rim.reach, over a megalodon</span>', 4);
{
  const RIM = BOOM_BASE.rim ?? {};
  for (const reach of [0.25, 0.45, RIM.reach ?? 0.6, 0.95]) {
    const e = spawnBoss('bossShark', { x: 0, y: 0 });
    if (!e) { resetEnemies(scene); continue; }
    updateParticleScale(fightCam, gl);
    detonate({ wall: 0.34, body: e, boom: { rim: { ...RIM, reach } }, cam: fightCam });
    present(`reach ${reach}`,
      reach < 0.3 ? 'a rim light — reads as the animal glowing, not as it ending'
        : reach > 0.9 ? 'the aura has outgrown the body and is closing over it again'
          : 'a band with the animal legible inside it',
      reach === (RIM.reach ?? 0.6));
    resetEnemies(scene);
  }
}

// --- EVERY COLOUR IT HAD ----------------------------------------------------
// THE SECTION THE STAND-INS CANNOT SHOW. Everything above detonates a point and
// a radius, which has no materials at all — so the palette falls all the way
// through to the tuned signature and the sheet would prove nothing.
//
// systems/bodyPalette.js reads the colours off the LIVE shaders: the texture
// averages (which is where the megalodon keeps its entire colour), the material
// colours, the bioluminescent uniforms (which is where the orca keeps its
// entire colour), the Look panel's signature, and any elemental status. The
// strip under each cell is what it found, at the width each colour covers.
//
// THE AVERAGES ARE ONLY REACHABLE HERE. They need a 2D canvas, so
// tools/body-palette-test.mjs cannot see them at all and says so — this page is
// the only place the texture half of the palette is ever checked.
section('Every colour it had <span>— read off the live shaders, not off one hex per asset</span>', 4);
for (const [key, name] of BOSSES) {
  const e = spawnBoss(key, { x: 0, y: 0 });
  if (!e) { resetEnemies(scene); continue; }
  const raw = bodyPalette(e);
  const pal = bossBoomPalette(e);
  updateParticleScale(fightCam, gl);
  detonate({ wall: 0.34, body: e, cam: fightCam });
  present(name,
    `${raw?.swatches?.length ?? 0} colours off ${Math.round(raw?.tris ?? 0)} triangles · `
    + `sources: ${[...new Set((raw?.swatches ?? []).flatMap((x) => x.sources))].join(', ') || '—'}`,
    false, pal.swatches);
  resetEnemies(scene);
}

// AND THE SAME FOUR WITH IT SWITCHED OFF, which is the comparison the section
// exists for: one flat tint off `assetBaseColor`, exactly as this shipped.
section('...against the single tint it replaced <span>— CONFIG.boss.boom.palette.enabled off</span>', 4);
for (const [key, name] of BOSSES) {
  const e = spawnBoss(key, { x: 0, y: 0 });
  if (!e) { resetEnemies(scene); continue; }
  const off = { ...(BOOM_BASE.palette ?? {}), enabled: false };
  updateParticleScale(fightCam, gl);
  detonate({ wall: 0.34, body: e, boom: { palette: off }, cam: fightCam });
  present(`${name} · one tint`, 'the Look panel\u2019s signature, lifted — which for a body '
    + 'that keeps its colour in a texture or in a shader is a colour nothing on screen wears',
  false, bossBoomPalette(e).swatches);
  resetEnemies(scene);
}

// AND WHAT WAS ON IT WHEN IT DIED. An elemental status is on the CREATURE, not
// in any material — see the venomTimer block in entities/enemies.js — so it is
// the one part of the palette that is about this individual rather than about
// the species. It arrives flagged `raw` and skips the hide lift: these are UI
// colours, authored bright, and put through the correction a near-black hide
// needs they come out as the same pale wash as everything else.
section('...and what was on it when it died <span>— the elemental statuses, weighted by what is left of them</span>', 4);
{
  const els = CONFIG.biolum?.elements ?? {};
  for (const [field, id] of [[null, null], ['venomTimer', 'venom'], ['chillTimer', 'chill'], ['infectTimer', 'infection']]) {
    const e = spawnBoss('bossShark', { x: 0, y: 0 });
    if (!e) { resetEnemies(scene); continue; }
    if (field) e[field] = 9;
    updateParticleScale(fightCam, gl);
    detonate({ wall: 0.34, body: e, cam: fightCam });
    present(id ? `${els[id]?.label ?? id}` : 'clean',
      id ? `${field} · #${(els[id]?.color ?? 0).toString(16)} — the swatch is the element's own `
        + 'colour, untouched'
        : 'nothing on the body — the species\u2019 own colours only',
    false, bossBoomPalette(e).swatches);
    resetEnemies(scene);
  }
}

// HOW FAR A PUFF MOVES FROM THE MEAN toward its own swatch. 0 is the single
// flat tint; 1 is the full palette with nothing holding it together.
section('How much of the palette reaches the cloud <span>— CONFIG.boss.boom.palette.spread</span>', 4);
{
  const P = BOOM_BASE.palette ?? {};
  for (const spread of [0, 0.4, P.spread ?? 0.75, 1]) {
    const e = spawnBoss('bossSquid', { x: 0, y: 0 });
    if (!e) { resetEnemies(scene); continue; }
    updateParticleScale(fightCam, gl);
    detonate({ wall: 0.34, body: e, boom: { palette: { ...P, spread } }, cam: fightCam });
    present(`spread ${spread}`,
      spread === 0 ? 'the mean only — one colour, which is what this shipped as'
        : spread === 1 ? 'every puff its own swatch, with nothing pulling them together'
          : 'the animal\u2019s colours, still reading as one cloud',
      spread === (P.spread ?? 0.75));
    resetEnemies(scene);
  }
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
    : size > 1.6 ? 'swallows the frame; at fight scale the seal goes with it'
      : size > 1.2 ? 'half again on top of that — the cloud outgrows the animal it came out of'
        : 'the body, and half again',
  size === 1);
}

// --- THE BODY LETTING GO ----------------------------------------------------
// THE FRAME AFTER THE PHOTOGRAPH. systems/bossCorpse.js hands the visual back
// to the pool and the boss is simply gone; systems/bossDissolve.js replaces it
// on that frame with a cloud of its own vertices, each wearing the colour of
// the skin it came off.
//
// THIS SECTION IS THE ONLY PLACE THE TEXEL SAMPLING IS EVER SEEN. It needs a 2D
// canvas, so tools/boss-dissolve-test.mjs cannot reach it at all and says so —
// every point there falls through to the palette. Here the megalodon's gums
// come out pink and its flank grey, in the places those things were, or the
// UVs are being read wrong and it does not.
//
// The mesh is left IN the frame for the first panel of each pair, which is the
// comparison that matters: the cloud has to be dense enough to stand in for the
// body it is replacing.
section('The body letting go <span>— one particle per vertex, in the colour of the skin it came off</span>', 4);
for (const [key, name] of BOSSES) {
  const e = spawnBoss(key, { x: 0, y: 0 });
  if (!e) { resetEnemies(scene); continue; }
  resetParticles();
  resetBossBooms();
  resetBossDissolve();
  reseed();
  updateParticleScale(fightCam, gl);
  const n = spawnBossDissolve(e);
  // The body goes, exactly as burst() takes it — this panel is what is left.
  e.visual.visible = false;
  // A short run on the WATER's clock: by the time this fires the kill shot has
  // let go and the world is back at full speed.
  run(0.25, 1, fightCam);
  present(name, `${n} points · the mesh is hidden, so this is all there is`);
  e.visual.visible = true;
  resetEnemies(scene);
}

// AND HOW IT GOES. The whole point is the ramp: everything stops within a few
// tenths of a second and then spends three seconds shrinking away, so a panel
// at the moment of the swap says nothing about whether it works.
section('...over the next few seconds <span>— tons of drag, then the size ramp</span>', 4);
for (const after of [0, 0.6, 1.6, 3]) {
  const e = spawnBoss('bossShark', { x: 0, y: 0 });
  if (!e) { resetEnemies(scene); continue; }
  resetParticles();
  resetBossBooms();
  resetBossDissolve();
  reseed();
  updateParticleScale(fightCam, gl);
  spawnBossDissolve(e);
  e.visual.visible = false;
  run(Math.max(1 / 60, after), 1, fightCam);
  present(`+${after}s`,
    after === 0 ? 'the frame of the swap — the cloud is the body'
      : after < 1 ? 'the drag has caught them and the silhouette is opening'
        : after < 2 ? 'shrinking, and the current has started to take it'
          : 'nearly gone',
  after === 0);
  e.visual.visible = true;
  resetEnemies(scene);
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

// --- THE FRONT --------------------------------------------------------------
// Everything above is the cloud. This is the thing that leaves before it.
//
// CAUGHT MID-EXPANSION, not at the shutter, and that is the whole point of the
// element: both rings are deliberately GONE by the time the picture is taken
// (asserted in tools/boss-boom-test.mjs). The front is what the player sees in
// the tenth of a second after the kill; the smoke is what the trophy keeps.
section('Options — the front <span>— the shockwave, caught 0.10s in · the shipped cloud under all five</span>', 5);
{
  const RINGS = CONFIG.boss.boom.shock.rings;
  const WALL = 0.10;

  detonate({ r: 7, wall: WALL, boom: { shock: { enabled: false } } });
  present('No front', 'the cloud alone — it reads as something that GREW, which is the '
    + 'thing a bang is meant to have caused');

  detonate({ r: 7, wall: WALL, boom: { shock: { ...CONFIG.boss.boom.shock, rings: [RINGS[0]] } } });
  present('One ring', 'the hero front on its own · white-hot, thinning as it opens, eaten from behind');

  detonate({
    r: 7, wall: WALL,
    boom: {
      shock: {
        ...CONFIG.boss.boom.shock,
        glow: 3.2,
        wobble: 0.17,
        rings: [
          { ...RINGS[0], to: 2.25, thick: [0.24, 0.05], fade: 1.6 },
          { ...RINGS[1], glow: 0.55 },
        ],
      },
    },
  });
  present('Two rings, restrained', 'a clean hoop leaving a cloud · correct, and a diagram of a '
    + 'shockwave rather than one');

  detonate({ r: 7, wall: WALL });
  present('Two rings, loud', 'the same pair pushed until the front TEARS — brighter, reaching 2.7 '
    + 'bodies, a rougher edge. The second one, slower and in the boss’s own colour, is what says '
    + 'which animal it was', true);

  detonate({
    r: 7, wall: WALL,
    boom: {
      shock: {
        ...CONFIG.boss.boom.shock,
        ease: 1.4,
        rings: [{ at: 0, from: 0.3, to: 3.0, seconds: 0.3, thick: [0.3, 0.04], glow: 1, white: 1, fade: 1.4, eat: 0.4 }],
      },
    },
  });
  present('One wide, slow one', 'reaches three bodies out and takes its time · at fight scale this is '
    + 'most of the arena, and it stops reading as coming off the animal');

  detonate({
    r: 7, wall: WALL,
    boom: {
      shock: {
        ...CONFIG.boss.boom.shock,
        glow: 7.5,
        wobble: 0.34,
        rings: [
          { ...RINGS[0], to: 3.1, thick: [0.34, 0.07], fade: 1.0 },
          { ...RINGS[1], glow: 1.1 },
        ],
      },
    },
  });
  present('Louder still', 'past the shipped setting · the front starts washing the cloud out, and at '
    + 'fight scale it reaches far enough to stop reading as coming off the animal');
}

section('The front, frame by frame <span>— the shipped pair, on the wall clock, with the water held at a tenth speed</span>', 5);
for (const [wall, note] of [
  [0.02, 'the bang · the ring is already a third of the way out'],
  [0.06, 'the second ring is born as the first thins'],
  [0.12, 'the leading edge is nearly at its full reach'],
  [0.20, 'eaten from behind — it is rubbed out, not faded'],
  [0.34, 'the shutter · the front is gone and the smoke is what is left'],
]) {
  detonate({ r: 7, wall });
  present(`${wall}s`, note, wall === 0.34);
}

// --- WHAT THE CLOUD IS MADE OF NOW ------------------------------------------
// THE CHANGE THIS PAGE EXISTS TO JUDGE. The cloud used to be an opaque cel puff
// with a dark outline, which is the right reference for a Wind Waker explosion
// and the wrong thing to put on the one frame of the run the player keeps: it
// is centred on the body and fires a third of a second before the shutter, so
// the trophy came back with a hole in it where the animal was.
section('The surface — alpha or additive <span>— a real megalodon under a real cloud, at the shutter</span>', 3);
{
  const shark = () => spawnBoss('bossShark', { x: 4, y: -14 });
  const ALPHA = { iso: 0.36, soft: 0.05, opacity: 0.97, additive: false, rim: -0.55, rimWidth: 0.5 };

  const shot = (goo, title, note, picked = false) => {
    resetParticles(); resetBossBooms(); resetBossGibs(); restore(); reseed();
    resetEnemies(scene);
    const boss = shark();
    updateParticleScale(fightCam, gl);
    Object.assign(GROUP, goo);
    fireBossBoom(boss);
    run(0.34, HOLD, fightCam);
    present(title, note, picked);
  };

  shot(ALPHA, 'Alpha, opaque (was)', 'the cel outline is real and so is the hole: '
    + 'the animal the picture is of is behind the cloud');
  shot({ ...GROUP_BASE, opacity: 0.85 }, 'Additive, most of the way up',
    'the body is back, but the core is a flat white blowout with no shape in it');
  shot({}, 'Additive at 0.52 (ships)', 'light rather than substance · the silhouette reads '
    + 'through the brightest part of the blast, and the hard isoline keeps it a drawn shape', true);
  resetEnemies(scene);
}

// --- THE ROSTER, AT FIGHT SCALE ---------------------------------------------
// The colour row above is close-up and on a synthetic body. This is the shipped
// effect on the four real animals, in the frustum the player is given, at the
// frame the picture is taken — which is the only view that answers the question
// the change was made for: can you still see what died.
section('The four bosses, at the shutter <span>— the arena frustum, the shipped surface, each animal under its own cloud</span>', 4);
for (const b of ROSTER) {
  resetParticles(); resetBossBooms(); resetBossGibs(); restore(); reseed();
  resetEnemies(scene);
  const key = BOSSES.find(([, n]) => n === b.name)?.[0];
  const boss = key ? spawnBoss(key, { x: 3, y: -14 }) : null;
  if (!boss) { continue; }
  updateParticleScale(fightCam, gl);
  fireBossBoom(boss);
  run(0.34, HOLD, fightCam);
  present(b.name, `#${b.color != null ? new THREE.Color(b.color).getHexString() : '—'} · body ${b.r.toFixed(1)}`,
    b.name === 'megalodon');
}
resetEnemies(scene);

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
  present('The shutter', 'the cloud is ON the animal and the animal is still in the picture · '
    + 'that is the whole change: a trophy of a kill has to show what was killed', true);

  // ...and 0.18s of wall clock later the body bursts, behind the cloud.
  resetParticles(); resetBossBooms(); resetBossGibs(); reseed();
  resetEnemies(scene); boss = shark();
  updateParticleScale(fightCam, gl);
  fireBossBoom(boss);
  run(0.34, HOLD, fightCam);
  spawnBossGibs(boss);
  run(0.4, HOLD, fightCam);
  present('...and the body bursts under it', 'afterShot later · the gibs arrive inside the cloud, and the '
    + 'light of it is what covers the swap from animal to wreckage now that the cloud does not');
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
