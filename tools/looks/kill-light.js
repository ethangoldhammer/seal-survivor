// ---------------------------------------------------------------------------
// THE LIGHT ON THE KILL — LOOK DEV
//
//   npm run looks:killlight
//
// The question this sheet exists to answer: at the moment the trophy photograph
// is taken, can you tell what the seal did and what it did it to.
//
// The picture (systems/bossShot.js) is a SQUARE crop of two bodies on dark
// water. Every boss in the roster is a near-black hide and the seal is a small
// pale animal in a big frame; lit by the game's own ambient and key, which are
// tuned for reading a whole screen of gameplay, both come out as silhouettes.
// systems/bossLight.js raises a hero shaft on the seal and a cold wash behind
// the body in the second before the shutter, and this page is where that is
// judged — with the animals in the frame, at the exact moment the picture is
// taken, through the real post chain.
//
// NOTHING HERE IS RE-IMPLEMENTED. The page imports the shipping modules, so a
// panel that renders nothing is a real failure rather than a bug in a mock.
//
// THE TWO CLOCKS. The light fires inside the kill shot, which holds the water
// at CONFIG.boss.kill.hold. Every panel advances updateBossLight and
// updateBossBooms on the WALL clock and updateParticles on the DILATED one,
// exactly as main.js does — the light is at full in the photograph only because
// it is not on the water's clock, and that is visible here and nowhere else.
//
// IT WRITES NOTHING. The CONFIG assignments are into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  initParticles, updateParticles, resetParticles, updateParticleScale,
} from '../../path/src/entities/particles.js';
import {
  fireBossBoom, updateBossBooms, resetBossBooms, initBossBooms, bossBoomLead,
} from '../../path/src/systems/bossBoom.js';
import {
  initBossLight, fireBossLight, updateBossLight, resetBossLight, bossLightLead,
  bossLightState, shaftAlpha,
} from '../../path/src/systems/bossLight.js';
import { snapshotMoment } from '../../path/src/systems/bossKill.js';
import { spawnNamed, resetEnemies } from '../../path/src/entities/enemies.js';
import { refreshHitShape } from '../../path/src/systems/hitShape.js';
import { measureBossBody } from '../../path/src/systems/bossBoom.js';

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

// EVERY PANEL IS THE SAME EXPLOSION AND THE SAME BLADE PHASES. Both are rolled,
// so an unseeded page compares the dice down a row instead of the control being
// varied.
let seed = 0;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = () => { seed = 0x11e57a1; };

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

updateBounds(W / H);

// THE GAME'S OWN LIGHTING, not a look-dev rig, and on this page that matters
// more than on any other: the whole subject is how dark two bodies are before
// the kill light arrives. A page lit to flatter them would answer the wrong
// question. These are CONFIG.lighting, exactly as world.js builds them.
const scene = new THREE.Scene();
const ambient = new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient);
const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
key.position.fromArray(CONFIG.lighting.keyPosition);
const hemi = new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity);
scene.add(ambient, key, hemi);

// Water to put it all in. Additive light adds to what is behind it, so a panel
// over black would be the one background on which any of this reads as bright.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshBasicMaterial({ color: 0x1d4864 }),
);
water.position.z = -30;
scene.add(water);

await preloadAssets();
initParticles(scene);
initBossBooms(scene);
initBossLight(scene);
const post = createPost(gl);

// THE SEAL. A visual out of the pool, not the player module — entities/player.js
// owns input, stats and an animation controller, none of which this page has any
// use for, and all of which would have to be driven for it to stand still.
//
// NOSE-UP. createVisual points a body forward at world +Y; a side-on view needs
// it laid down, which is the same rotation every preview in tools/ applies.
const seal = createVisual('ship');
seal.rotation.z = -Math.PI / 2;
const sealRig = new THREE.Group();
sealRig.add(seal);
scene.add(sealRig);

const ortho = (h, y = 0, x = 0) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(x, y, 20);
  return c;
};

// THE FRAME THE PHOTOGRAPH IS ACTUALLY TAKEN IN. The kill shot pushes in to
// CONFIG.boss.kill.cam.zoom on the arena frustum and aims between the seal and
// the body — see applyFraming in systems/bossKill.js. Reproduced rather than
// eyeballed, because "is it readable" is a question about a frame at a size,
// and judged in a wider one every answer is yes.
const ARENA_H = bounds.top - bounds.bottom;
const SHOT_ZOOM = Math.max(1, CONFIG.boss?.kill?.cam?.zoom ?? 2.05);
const HOLD = Math.max(0.02, Math.min(1, CONFIG.boss?.kill?.hold ?? 0.12));

const BOSS_MUL = { bossShark: 1.6, bossOrca: 1.7, bossSquid: 1.2, bossCrab: 3.6 };

function spawnBoss(fkey, at) {
  const e = spawnNamed(scene, fkey, 0, at, { ignoreCaps: true, overfill: true });
  if (!e) return null;
  const mul = BOSS_MUL[fkey] ?? 1;
  e.visual.scale.multiplyScalar(mul);
  e.spawnScale = (e.spawnScale ?? 1) * mul;
  e.sizeMul = (e.sizeMul ?? 1) * mul;
  e.radius *= mul;
  e.isBoss = true;
  e.vx = 0;
  e.vy = 0;
  // WITHOUT THIS EVERY SPHERE MEASURES ITS BIND-POSE PLACE — a hitbox rides the
  // bones and three only refreshes world matrices during a render.
  scene.updateMatrixWorld(true);
  if (e.hitShape) refreshHitShape(e.hitShape);
  // A corpse, not a swimmer: rolled over, which is what the shot actually sees.
  e.mesh.rotation.z += 0.5;
  scene.updateMatrixWorld(true);
  if (e.hitShape) refreshHitShape(e.hitShape);
  return e;
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

// THE SQUARE IS THE PICTURE. A 16:9 frame throws away 44% of its width on the
// way into the print (see squareCrop in systems/bossShot.js), so a panel judged
// full-width is judging something the player never sees. Drawn as a guide on
// every cell rather than cropped to, so what fell outside it is visible.
function present(title, note, { picked = false, crop = true } = {}) {
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
  if (crop) {
    const side = canvas.height;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.strokeRect((canvas.width - side) / 2 + 1, 1, side - 2, side - 2);
  }
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

// --- one shutter ------------------------------------------------------------

const LIGHT = CONFIG.boss.light;
const LIGHT_BASE = JSON.parse(JSON.stringify(LIGHT));
const BOOM = CONFIG.boss.boom;
const BOOM_BASE = JSON.parse(JSON.stringify(BOOM));

function restore() {
  for (const k of Object.keys(LIGHT)) delete LIGHT[k];
  Object.assign(LIGHT, JSON.parse(JSON.stringify(LIGHT_BASE)));
  for (const k of Object.keys(BOOM)) delete BOOM[k];
  Object.assign(BOOM, JSON.parse(JSON.stringify(BOOM_BASE)));
}

/**
 * Replay the run-up to the photograph and stop on the frame it is taken.
 *
 * THE SCHEDULE IS THE REAL ONE. systems/bossCorpse.js counts a single wall
 * clock down to the shutter and fires the light a `bossLightLead` ahead of it
 * and the smoke a `bossBoomLead` ahead of it; both leads are derived from
 * CONFIG, so this page cannot drift from the game by having its own numbers.
 */
function shutter({
  boss = 'bossShark', at = { x: 7, y: -2 }, sealAt = { x: -6, y: 3 },
  light = {}, boom = {}, withBoom = true, withLight = true, after = 0,
} = {}) {
  resetParticles();
  resetBossBooms();
  resetBossLight();
  resetEnemies(scene);
  restore();
  reseed();
  Object.assign(LIGHT, light);
  Object.assign(BOOM, boom);

  sealRig.position.set(sealAt.x, sealAt.y, 0);
  const e = boss ? spawnBoss(boss, at) : null;

  // AIMED BETWEEN THE TWO AND OPENED OUT UNTIL BOTH FIT, which is what
  // applyFraming in systems/bossKill.js actually does — the push-in is a
  // ceiling on the zoom and the FIT is what decides it. A panel that hardcoded
  // the push would crop a megalodon out of its own trophy and blame the light.
  //
  // Fitted to the SQUARE rather than to the frame, for the same reason the
  // shot is: the print keeps a square out of the middle and a body that sits
  // comfortably in the widescreen frame can be entirely outside the picture.
  const cfgCam = CONFIG.boss?.kill?.cam ?? {};
  const bias = cfgCam.subjectBias ?? 0.42;
  const pad = cfgCam.framePad ?? 1.8;
  const m = e ? measureBossBody(e) : null;
  const bx = m ? m.x : sealAt.x;
  const by = m ? m.y : sealAt.y;
  const br = m ? m.r : 0;
  const fx = sealAt.x + (bx - sealAt.x) * bias;
  const fy = sealAt.y + (by - sealAt.y) * bias;
  const half = Math.max(
    Math.abs(sealAt.x - fx) + pad, Math.abs(bx - fx) + br + pad,
    Math.abs(sealAt.y - fy) + pad, Math.abs(by - fy) + br + pad,
  );
  // The square's side is the frame's HEIGHT, so fitting the square is setting
  // the ortho height. Never tighter than the push-in.
  //
  // NO UPPER CLAMP HERE, and that is a difference from the game rather than an
  // oversight: applyFraming floors the zoom at 1 (the arena frustum) because
  // below it the frame runs off the water plane onto the bare scene background.
  // This page's water is six hundred units across and its panels are 460 wide,
  // so the equivalent clamp would crop a megalodon out of the panel that exists
  // to show one. What is being judged here is the light on two bodies, and they
  // have to both be in the cell for that to mean anything.
  const camH = Math.max(ARENA_H / SHOT_ZOOM, half * 2);
  const cam = ortho(camH, fy, fx);
  updateParticleScale(cam, gl);

  const total = snapshotMoment();
  const lightAt = Math.max(0, total - bossLightLead());
  const boomAt = Math.max(0, total - bossBoomLead());
  let lit = false;
  let boomed = false;
  let t = 0;
  const frames = Math.max(1, Math.round((total + after) / DT));
  for (let i = 0; i < frames; i++) {
    if (withLight && !lit && t >= lightAt) { lit = true; if (e) fireBossLight(e); }
    if (withBoom && !boomed && t >= boomAt) { boomed = true; if (e) fireBossBoom(e); }
    // WALL for the two schedules, DILATED for the water — both, every frame,
    // exactly as main.js runs them.
    updateBossBooms(DT);
    updateBossLight(DT, sealRig.position, seal);
    updateParticles(DT * HOLD);
    post.resize();
    post.render(scene, cam, DT);
    t += DT;
  }
  return { e, cam };
}

// --- IS IT AT FULL WHEN THE PICTURE IS TAKEN --------------------------------
// The one assertion this page can make that a still cannot show.
shutter();
check('the light is at full on the frame of the shutter',
  bossLightState.level >= 0.999, `level ${bossLightState.level.toFixed(3)}`);
check('no shader errors', shaderErrors.length === 0, shaderErrors.join(' | '));

// --- THE PHOTOGRAPH ---------------------------------------------------------
section('The trophy, with the light and without <span>— the dashed square is what the print keeps</span>', 2);
for (const [boss, name] of [['bossShark', 'megalodon'], ['bossSquid', 'kraken'], ['bossCrab', 'king crab']]) {
  shutter({ boss, withLight: false });
  present(`${name} · unlit`,
    'the game’s own ambient and key · a near-black hide on dark water, and a small pale '
    + 'animal in a big frame');
  shutter({ boss });
  present(`${name} · lit`,
    'a warm shaft on the seal, a cold wash behind the body, and both hides brought up',
    { picked: true });
}

// --- WHAT EACH HALF IS DOING ------------------------------------------------
section('What each half is doing <span>— one control at a time, megalodon</span>', 4);
{
  const BASE = LIGHT_BASE;
  for (const [label, over, note] of [
    ['shaft only', { wash: { ...BASE.wash, enabled: false }, heroLift: 0, subjectLift: 0 },
      'the cone and its pool · light in the water with nothing lit by it'],
    ['wash only', { shaft: { ...BASE.shaft, enabled: false }, heroLift: 0, subjectLift: 0 },
      'the cold glow BEHIND the body · the hide becomes the one dark shape on a light field'],
    ['lifts only', { shaft: { ...BASE.shaft, enabled: false }, wash: { ...BASE.wash, enabled: false } },
      'the bodies’ own materials brought up · the only half that puts anything back INSIDE '
      + 'the silhouette'],
    ['all three', {}, 'what ships'],
  ]) {
    shutter({ light: over });
    present(label, note, { picked: label === 'all three' });
  }
}

// --- THE RISE ---------------------------------------------------------------
section('The rise, on the wall clock <span>— the water is held at a tenth speed through all of it</span>', 4);
{
  const total = snapshotMoment();
  for (const [when, note] of [
    [0, 'the killing blow'],
    [0.3, 'coming up under the held beat'],
    [total, 'the shutter — flat, which is the whole point of the lead'],
    [total + 0.9, 'the print is in the air and it is on its way out'],
  ]) {
    // Stopped early by shortening the run rather than by scaling the clock:
    // the schedule is what is being shown.
    const keep = Math.min(when, total);
    const after = Math.max(0, when - total);
    const savedMoment = keep;
    shutter({ after, boom: after > 0 || keep >= total ? {} : { enabled: false },
      withLight: true, withBoom: keep >= total * 0.5 });
    present(`+${when.toFixed(2)}s`, note, Math.abs(when - total) < 1e-6);
    void savedMoment;
  }
}

// --- HOW HEROIC -------------------------------------------------------------
section('How heroic <span>— the shaft’s own brightness, over the shipped wash</span>', 4);
{
  const BASE = LIGHT_BASE.shaft ?? {};
  for (const over of [0.9, 1.2, BASE.overdrive ?? 1.5, 2.2]) {
    shutter({ light: { shaft: { ...BASE, overdrive: over } } });
    present(`overdrive ${over}`,
      over < 1 ? 'below the bright pass — the cone is there and does not bloom, which reads '
        + 'as a grey wedge'
        : over > 2 ? 'the shaft is the subject and the seal is standing in it'
          : 'the cone blooms and the seal is still the brightest thing in it',
      { picked: over === (BASE.overdrive ?? 1.5) });
  }
}

// --- THE STAND-OFF ----------------------------------------------------------
section('How far the wash spreads <span>— CONFIG.boss.light.wash.spread, x the measured body</span>', 4);
{
  const BASE = LIGHT_BASE.wash ?? {};
  for (const spread of [1.05, 1.3, BASE.spread ?? 1.55, 2.2]) {
    shutter({ light: { wash: { ...BASE, spread } } });
    present(`spread ${spread}`,
      spread < 1.2 ? 'inside the silhouette — it lights the hide instead of standing behind it'
        : spread > 2 ? 'a soft field with the animal lost in the middle of it'
          : 'a halo the body reads against',
      { picked: spread === (BASE.spread ?? 1.55) });
  }
}

// --- THE CONE ---------------------------------------------------------------
// The baked profile, drawn from the same pure function the texture is baked
// from. A shaft is two gradients that are NOT the same shape: across it has no
// edge, and down it runs out. Plotted rather than described, because "it fades"
// is true of a stripe as well.
section('The cone, as it is baked <span>— shaftAlpha, the function the texture comes from</span>', 2);
{
  const cv = document.createElement('canvas');
  cv.width = W * 2;
  cv.height = H * 2;
  const g = cv.getContext('2d');
  g.fillStyle = '#04070e';
  g.fillRect(0, 0, cv.width, cv.height);
  // The bake itself, drawn big.
  const img = g.createImageData(cv.width, cv.height);
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const a = shaftAlpha(x / (cv.width - 1) - 0.5, y / (cv.height - 1));
      const i = (y * cv.width + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 244; img.data[i + 2] = 220;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const cell = document.createElement('div');
  cell.className = 'cell';
  cv.style.width = `${W}px`;
  cell.appendChild(cv);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = '<b>The baked cone</b><br>narrow at the top, wide where it lands, and eaten '
    + 'on the way down — a band of even brightness reads as a wall';
  cell.appendChild(cap);
  row.appendChild(cell);
  posted.push(new Promise((done) => cv.toBlob((b) => {
    fetch(`/shot/${String(shotIndex++).padStart(2, '0')}-the-baked-cone.png`, { method: 'POST', body: b })
      .then(done, done);
  }, 'image/png')));

  // And its cross-sections, so the two gradients can be compared.
  const plot = document.createElement('canvas');
  plot.width = W * 2;
  plot.height = H * 2;
  const p = plot.getContext('2d');
  p.fillStyle = '#070b14';
  p.fillRect(0, 0, plot.width, plot.height);
  const line = (fn, color, label, ly) => {
    p.strokeStyle = color;
    p.lineWidth = 4;
    p.beginPath();
    for (let i = 0; i <= 200; i++) {
      const u = i / 200;
      const v = fn(u);
      const x = 60 + u * (plot.width - 120);
      const y = plot.height - 60 - v * (plot.height - 120);
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    p.stroke();
    p.fillStyle = color;
    p.font = '28px ui-monospace, monospace';
    p.fillText(label, 70, ly);
  };
  line((u) => shaftAlpha(u * 0.5 - 0.25, 0.5), '#ffd9a0', 'across, at half depth', 60);
  line((u) => shaftAlpha(0, u), '#9fd8ff', 'down the middle', 100);
  const cell2 = document.createElement('div');
  cell2.className = 'cell';
  plot.style.width = `${W}px`;
  cell2.appendChild(plot);
  const cap2 = document.createElement('div');
  cap2.className = 'cap';
  cap2.innerHTML = '<b>Its two gradients</b><br>across is a quartic that reaches zero before the '
    + 'quad’s edge; down is the light running out, with a fade-in at the top so the shaft has '
    + 'no beginning';
  cell2.appendChild(cap2);
  row.appendChild(cell2);
  posted.push(new Promise((done) => plot.toBlob((b) => {
    fetch(`/shot/${String(shotIndex++).padStart(2, '0')}-its-two-gradients.png`, { method: 'POST', body: b })
      .then(done, done);
  }, 'image/png')));
}

restore();
resetBossLight();
resetEnemies(scene);
await Promise.all(posted);
log(`\n${fails ? `${fails} FAILED` : 'all checks passed'} · ${shotIndex} shots posted`,
  fails ? 'bad' : 'ok');
