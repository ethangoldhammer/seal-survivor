// ---------------------------------------------------------------------------
// THE CLUB'S FEEDBACK — LOOK DEV
//
//   npm run looks:clubs
//
// Every club attack now throws an ACCENT burst of the substance that club is
// made of, and the clubs the seal is not holding — the thrown ones and the ring
// — trail a glowing ribbon. Both grow with the cards that bought them
// (CONFIG.club.fx). This is where that is judged.
//
// WHY A PAGE AND NOT THE GAME. There is exactly one dev server in this project
// and it is the sole writer of path/src/imported-tuning.json; a second one is a
// second game quietly flattening real tuning work. This is a static BUILD of
// the shipped modules with no save path anywhere in it. See SERVERS.md.
//
// WHY A PAGE AND NOT A NODE HARNESS. tools/club-test.mjs already fails over
// every claim that can be settled by reading numbers — which club reports which
// substance, that the growth grows, that the ring gets anchors and the fins do
// not. None of that is the question here. The question here is whether nine fat
// splinters read as debris at the distance a fight is played at, and whether a
// ribbon on five orbiting clubs draws a readable object or a solid disc over
// the water. Both need pixels, and Node has none: no GLB loads there, the
// particle sprites never rasterise, and the ribbon is additive geometry under
// a bloom pass that only exists in a real GL context.
//
// EVERY PANEL IS DRAWN THROUGH systems/post.js. These bursts are authored past
// the bright pass on purpose (the embers sit at glow 2.6) and judging them
// unbloomed is judging a different effect.
//
// THE LAST SECTION IS THE ONE THAT MATTERS. Everything above it is a close-up,
// and a close-up is where every one of these decisions looks fine. The fight
// framing at the bottom is the frame the player is actually given.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { preloadAssets, createVisual, hasModel } from '../../path/src/assets.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  initParticles, updateParticles, resetParticles, updateParticleScale, particleCount, emit,
} from '../../path/src/entities/particles.js';
import {
  updateProjectileTrails, clearProjectileTrails,
} from '../../path/src/systems/projectileTrails.js';
import { clubFxFor, trailScaleFor } from '../../path/src/systems/club.js';
import { player } from '../../path/src/entities/player.js';

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

// A shader that fails to compile renders nothing and three only writes to the
// console about it, so the page would look like a tuning problem rather than a
// broken program. See [[glsl-errors-need-a-real-gl-context]].
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 320;
const H = 260;
const DT = 1 / 60;

updateBounds(16 / 9);

// ONE WebGL context for the whole page, blitted into a plain 2D canvas per
// cell. A renderer per cell silently goes black past a dozen panels — browsers
// keep about sixteen live contexts and discard the oldest, after the early
// cells have already rendered correctly.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Water to draw them on. Authored brighter than it looks: the game's composite
// writes straight to the default framebuffer, so a linear value lands as if it
// were sRGB and every colour arrives about a stop and a half darker than its
// hex. That is the pipeline everything here is tuned under, not something for
// this page to correct — but a water colour picked off a swatch renders black.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x2c5f7d }),
);
water.position.z = -30;
scene.add(water);

const L = CONFIG.lighting;
scene.add(new THREE.AmbientLight(0xffffff, L.ambient));
const key = new THREE.DirectionalLight(0xffffff, L.keyIntensity);
key.position.fromArray(L.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, L.hemiIntensity));

await preloadAssets();
initParticles(scene);
const post = createPost(gl);

check('the club model loaded', hasModel('club'), hasModel('club') ? 'club.glb' : 'procedural fallback');

const ortho = (h) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(0, 0, 20);
  return c;
};
// A magnifying glass for the bursts...
const nearCam = ortho(9);
// ...a middle frame for one club and its wake...
const midCam = ortho(20);
// ...and the frame the player is actually given: at zoom 1 the frustum IS the
// arena. Nothing on this page may be signed off anywhere but here.
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

// The last cell's pixels, so a panel can be MEASURED rather than only looked
// at. Kept as the 2D copy: reading back off the GL canvas after a post pass is
// a different buffer on some drivers.
let lastPixels = null;
let lastCam = null;

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
  lastPixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
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

// HOW MUCH OF THE PANEL IS THE EFFECT, and what colour it is.
//
// MEASURED AGAINST AN EMPTY FRAME OF THE SAME PANEL, not against a hand-typed
// water colour. That was the first version and every panel came back at 100%:
// the water is authored as a hex and then goes through systems/post.js, which
// tone-maps, blooms and writes a linear value to an sRGB framebuffer — so the
// blue that reaches the canvas is nowhere near the number in the source, and a
// threshold against that number counts the entire background as the effect.
// The reference frame has been through the identical pipeline, so the only
// thing left in the difference is what was drawn.
//
// Per CAMERA, because the empty frame is not identical at every framing: the
// bloom's kernel is in screen space and the water plane's edge is not.
const baselines = new Map();
function baselineFor(cam) {
  if (baselines.has(cam)) return baselines.get(cam);
  resetParticles();
  clearProjectileTrails(scene);
  post.resize();
  post.render(scene, cam, DT);
  const c = document.createElement('canvas');
  c.width = W * 2;
  c.height = H * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#04070e';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(gl.domElement, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  baselines.set(cam, px);
  return px;
}

// A pixel counts as the effect if it moved from the empty frame — in EITHER
// direction, since the frost is brighter than the water and a club's own body
// is darker than it.
const MOVED = 0.10;
function litFraction() {
  const px = lastPixels;
  const base = baselineFor(lastCam);
  if (!px || !base) return 0;
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) {
    const d = Math.abs(px[i] - base[i]) + Math.abs(px[i + 1] - base[i + 1]) + Math.abs(px[i + 2] - base[i + 2]);
    if (d / 255 > MOVED) lit++;
  }
  return lit / (px.length / 4);
}

// The average colour of what was ADDED, which is what says two panels are
// drawing different substances rather than the same one twice. The baseline is
// subtracted rather than only used as a mask: the water underneath is common to
// both panels and leaving it in pulls every answer toward the same blue.
function litHue() {
  const px = lastPixels;
  const base = baselineFor(lastCam);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const dr = (px[i] - base[i]) / 255;
    const dg = (px[i + 1] - base[i + 1]) / 255;
    const db = (px[i + 2] - base[i + 2]) / 255;
    if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) <= MOVED) continue;
    r += dr; g += dg; b += db; n++;
  }
  if (!n) return [0, 0, 0];
  // Normalised on the peak channel, so what is compared is the HUE and not how
  // much of it there was — otherwise a bigger burst of the same substance reads
  // as a different colour. See [[glow-clips-any-baked-shading]] for why the
  // peak and not the luminance.
  const peak = Math.max(Math.abs(r), Math.abs(g), Math.abs(b), 1e-6);
  return [r / peak, g / peak, b / peak];
}

function run(frames, cam, movers = null) {
  // Remembered so a measurement can be taken against an empty frame at the
  // SAME framing — see baselineFor.
  lastCam = cam;
  for (let i = 0; i < frames; i++) {
    updateParticles(DT);
    if (movers) updateProjectileTrails(DT, scene, [], movers);
    post.resize();
    post.render(scene, cam, DT);
  }
}

// --- ONE IMPACT -------------------------------------------------------------
//
// Fired through emit() with exactly the multipliers systems/club.js computes —
// clubFxFor is the same function the weapon calls, imported rather than
// re-derived, so a page that agrees with the game today cannot drift from it.
const CLUBS = [
  { asset: 'club', label: 'Driftwood', note: 'splinters, and the only wood in the game' },
  { asset: 'clubBoom', label: 'Boom Boom', note: 'embers — they RISE, the only club burst that does' },
  { asset: 'clubIce', label: 'Cold Snap', note: 'shards, braking hard and hanging where they were made' },
  { asset: 'clubThrow', label: 'Hurler', note: 'driftwood again — a thrown club is a club' },
];

function burst(asset, { level = 1, power = 1, draw = 1, frames = 7, cam = nearCam, at = [0, 0] } = {}) {
  resetParticles();
  updateParticleScale(cam, gl);
  const fx = clubFxFor(level, power, draw);
  const name = CONFIG.club.fx.accent[asset];
  emit(name, at[0], at[1], {
    dirX: 0.6, dirY: 0.8,
    scale: fx.amount, sizeMul: fx.size, speedMul: fx.speed,
  });
  const n = particleCount();
  run(frames, cam);
  return { fx, n, name };
}

section('What each club is made of <span>— one stack, a full swing, seven frames in</span>', 4);
const substance = {};
for (const c of CLUBS) {
  const { n, name } = burst(c.asset);
  present(c.label, `<span class="tag">${name}</span> · ${n} particles · ${c.note}`, true);
  substance[c.asset] = { lit: litFraction(), hue: litHue(), n };
}
check('every club puts something on the screen',
  CLUBS.every((c) => substance[c.asset].lit > 0.0008),
  CLUBS.map((c) => `${c.label} ${(substance[c.asset].lit * 100).toFixed(1)}%`).join(' · '));
// Three substances, three colours. If two of these came out the same, the
// accent is decorative rather than informative and the whole feature is a
// spray that happens to fire on club hits.
const apart = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const wood = substance.club.hue;
const fire = substance.clubBoom.hue;
const iceHue = substance.clubIce.hue;
check('...and you can tell them apart',
  apart(wood, fire) > 0.06 && apart(wood, iceHue) > 0.06 && apart(fire, iceHue) > 0.06,
  `wood/fire ${apart(wood, fire).toFixed(2)} · wood/ice ${apart(wood, iceHue).toFixed(2)} · fire/ice ${apart(fire, iceHue).toFixed(2)}`);

// --- WHAT THE CARDS DO TO IT ------------------------------------------------
section('What the cards do to it <span>— Boom Boom Club, one stack to six, then the Bouncer and Big Rigz on top</span>', 4);
{
  const one = burst('clubBoom', { level: 1 });
  present('One stack', `amount ${one.fx.amount.toFixed(2)}x · size ${one.fx.size.toFixed(2)}x · ${one.n} particles`);
  const oneLit = litFraction();

  const six = burst('clubBoom', { level: 6 });
  present('Six stacks', `amount ${six.fx.amount.toFixed(2)}x · ${six.n} particles`);
  const sixLit = litFraction();

  // THE BOUNCER AND BIG RIGZ, arriving the way they actually arrive — through
  // the stat block. clubFxFor reads them off `player.stats` itself, which is
  // why they are written here rather than passed.
  const saved = player.stats;
  player.stats = { ...saved, clubDamageMul: 1.6, clubKnockMul: 1.6, companionScale: 1.8 };
  const loaded = burst('clubBoom', { level: 6, draw: 1.8 });
  player.stats = saved;
  present('Six, loaded', `amount ${loaded.fx.amount.toFixed(2)}x · size ${loaded.fx.size.toFixed(2)}x · speed ${loaded.fx.speed.toFixed(2)}x`, true);
  const loadedLit = litFraction();

  // ...and the same club at a drift. The weapon is a readout of the animation
  // and the particles have to say so, or a six-stack club looks identical
  // whether it was swung or carried into something.
  const lazy = burst('clubBoom', { level: 6, power: 0.05 });
  present('Six, barely swung', `amount ${lazy.fx.amount.toFixed(2)}x · ${lazy.n} particles`);

  check('a deeper stack fills more of the frame', sixLit > oneLit,
    `${(oneLit * 100).toFixed(1)}% at one, ${(sixLit * 100).toFixed(1)}% at six`);
  check('...and the Bouncer and Big Rigz go further still', loadedLit > sixLit,
    `${(sixLit * 100).toFixed(1)}% -> ${(loadedLit * 100).toFixed(1)}%`);
  check('...and a drift is visibly a drift', lazy.n < six.n,
    `${lazy.n} particles at a drift vs ${six.n} at a whip`);
}

// --- THE RIBBON -------------------------------------------------------------
//
// A club the seal is NOT holding, on a scripted course, drawn with the real
// systems/projectileTrails.js. The mover is shaped exactly like the record
// systems/club.js hands that file for a club on the ring — an anchor at the
// head, a heading, a speed and the run's `trailScale`.
function ribbon(asset, { trailScale = 1, frames = 46, cam = midCam, spin = 9, radius = 5.5 } = {}) {
  clearProjectileTrails(scene);
  resetParticles();
  updateParticleScale(cam, gl);

  // The club itself, so the ribbon is judged behind the object it belongs to
  // rather than on its own — a trail with nothing at the front of it reads as
  // a streak of paint whatever its width.
  const mesh = createVisual(asset);
  scene.add(mesh);

  const anchor = new THREE.Object3D();
  anchor.name = asset;
  const mover = { mesh: anchor, dir: { x: 1, y: 0 }, speed: 0, trailScale };
  let px = null;
  let py = null;

  for (let i = 0; i < frames; i++) {
    // An orbit, which is what a club on the ring is doing — and a curve is the
    // only course that shows whether the ribbon holds together through a turn.
    const t = i * DT;
    const a = t * 2.6;
    const cx = Math.cos(a) * radius;
    const cy = Math.sin(a) * radius * 0.62;
    // ...tumbling end over end on top of it, which is what the ring does and
    // what puts the head somewhere other than the orbit point.
    const tumble = t * spin;
    const reach = CONFIG.club.length * (CONFIG.club.orbit.scale ?? 1);
    mesh.position.set(cx, cy, 0);
    mesh.rotation.z = tumble - Math.PI / 2;
    anchor.position.set(cx + Math.cos(tumble) * reach, cy + Math.sin(tumble) * reach, 0);
    if (px != null) {
      const dx = anchor.position.x - px;
      const dy = anchor.position.y - py;
      const len = Math.hypot(dx, dy);
      mover.speed = len / DT;
      if (len > 1e-6) { mover.dir.x = dx / len; mover.dir.y = dy / len; }
    }
    px = anchor.position.x;
    py = anchor.position.y;
    run(1, cam, [mover]);
  }
  scene.remove(mesh);
  return mover;
}

section('The ribbon <span>— a club on the ring, tumbling through three quarters of a turn</span>', 4);
const ribbons = {};
for (const c of CLUBS) {
  ribbon(c.asset);
  present(c.label, `<span class="tag">CONFIG.trails.${c.asset}</span> · width ${CONFIG.trails[c.asset].width} · sheds ${CONFIG.trails[c.asset].particles.emitter}`, true);
  ribbons[c.asset] = { lit: litFraction(), hue: litHue() };
}
check('every club that is not in a fin trails one',
  CLUBS.every((c) => ribbons[c.asset].lit > 0.0015),
  CLUBS.map((c) => `${c.label} ${(ribbons[c.asset].lit * 100).toFixed(1)}%`).join(' · '));
check('...in its own colour, like the debris it sheds',
  apart(ribbons.club.hue, ribbons.clubBoom.hue) > 0.05
  && apart(ribbons.club.hue, ribbons.clubIce.hue) > 0.05,
  `wood/fire ${apart(ribbons.club.hue, ribbons.clubBoom.hue).toFixed(2)} · wood/ice ${apart(ribbons.club.hue, ribbons.clubIce.hue).toFixed(2)}`);

section('...thickened by the cards <span>— the Hurler, one stack to five</span>', 3);
{
  const thin = trailScaleFor(clubFxFor(1, 1).amount);
  ribbon('clubThrow', { trailScale: thin });
  present('One stack', `trailScale ${thin.toFixed(2)}x`);
  const thinLit = litFraction();

  const fat = trailScaleFor(clubFxFor(5, 1).amount);
  ribbon('clubThrow', { trailScale: fat });
  present('Five stacks', `trailScale ${fat.toFixed(2)}x`, true);
  const fatLit = litFraction();

  const capped = trailScaleFor(99);
  ribbon('clubThrow', { trailScale: capped });
  present('At the ceiling', `trailScale ${capped.toFixed(2)}x · CONFIG.club.fx.maxTrail`);

  check('a deeper Hurler trails a fatter ribbon', fatLit > thinLit,
    `${(thinLit * 100).toFixed(1)}% -> ${(fatLit * 100).toFixed(1)}%`);
  check('...and the ceiling is not a solid stripe', litFraction() < 0.35,
    `${(litFraction() * 100).toFixed(1)}% of the frame at ${capped.toFixed(2)}x`);
}

// --- THE FRAME THE PLAYER IS GIVEN ------------------------------------------
//
// The only panel worth signing off. Everything above is a close-up, and a
// close-up is where every one of these decisions looks fine.
section('At fight scale <span>— the whole ring, at the framing the game is played in</span>', 2);
{
  const draw = (n, label, note) => {
    clearProjectileTrails(scene);
    resetParticles();
    updateParticleScale(fightCam, gl);
    const assets = ['club', 'clubIce', 'clubBoom', 'clubThrow', 'clubIce'];
    const meshes = [];
    const movers = [];
    for (let i = 0; i < n; i++) {
      const asset = assets[i % assets.length];
      const mesh = createVisual(asset);
      scene.add(mesh);
      const anchor = new THREE.Object3D();
      anchor.name = asset;
      meshes.push(mesh);
      movers.push({ mesh: anchor, dir: { x: 1, y: 0 }, speed: 0, trailScale: 1.4, px: null, py: null, slot: i });
    }
    const ring = CONFIG.club.orbit;
    for (let f = 0; f < 70; f++) {
      const t = f * DT;
      for (let i = 0; i < movers.length; i++) {
        const m = movers[i];
        const a = t * ring.speed + (i / movers.length) * Math.PI * 2;
        const cx = Math.cos(a) * ring.radius;
        const cy = Math.sin(a) * ring.radius * 0.7;
        const tumble = t * ring.spin + i * 1.7;
        const reach = CONFIG.club.length * (ring.scale ?? 1);
        meshes[i].position.set(cx, cy, 0);
        meshes[i].rotation.z = tumble - Math.PI / 2;
        m.mesh.position.set(cx + Math.cos(tumble) * reach, cy + Math.sin(tumble) * reach, 0);
        if (m.px != null) {
          const dx = m.mesh.position.x - m.px;
          const dy = m.mesh.position.y - m.py;
          const len = Math.hypot(dx, dy);
          m.speed = len / DT;
          if (len > 1e-6) { m.dir.x = dx / len; m.dir.y = dy / len; }
        }
        m.px = m.mesh.position.x;
        m.py = m.mesh.position.y;
      }
      run(1, fightCam, movers);
    }
    present(label, note, true);
    const lit = litFraction();
    for (const mesh of meshes) scene.remove(mesh);
    return lit;
  };

  const two = draw(2, 'Two on the ring', 'an early club run · 3.6u out, tumbling at 8 rad/s');
  const five = draw(5, 'Five on the ring', 'a run built on the class · the read has to survive this');
  check('the ring stays legible at fight scale', five < 0.3,
    `${(two * 100).toFixed(1)}% of the frame at two, ${(five * 100).toFixed(1)}% at five`);
}

check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? 'clean');

await Promise.all(posted);
log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failure(s), ${shotIndex} frames posted`,
  fails === 0 ? 'ok' : 'bad');
