// ---------------------------------------------------------------------------
// THE HARP'S NOTE VFX — every option, through the real post stack.
//
//   npx vite build --config tools/looks/vite.notes.config.mjs --outDir <dir>
//   node tools/looks/serve.mjs <dir> --out <dir>/shots
//
// The question this page exists to answer is which motion to ship, and that is
// not answerable from a Node harness: the glyphs came out of a Particle Flow
// bake (tools/note-glyphs.mjs), the colour is per-instance overdrive that only
// means anything once the bright pass has seen it, and "does a storm of notes
// read as music or as confetti" is a picture.
//
// It renders through systems/post.js — the SHIPPING bloom, with the shipping
// knee — because the colour half of the proposal lives or dies there. A note
// rolled at peak 1.9 is meant to clear CONFIG.bloom.threshold and get a halo;
// on a plain renderer it would just clip to white and every hue would look
// identical, which is exactly the wrong thing to judge from.
//
// A build rather than a dev server, always: a second dev server is a second
// game and it rewrites imported-tuning.json. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, hasModel } from '../../path/src/assets.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  createNoteField, installNoteGlyphs, rollNoteColor,
  BURST_PRESETS, AURA_PRESETS,
} from '../../path/src/systems/noteStorm.js';

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

// One panel is one moment. Three panels to a row, because a burst is a thing
// that happens over time and a single frame of it says nothing about whether it
// reads — the same reason the trail look page samples three.
const P = 420;
const PANELS = 3;

// ONE WebGLRenderer for the page. A renderer per cell is the obvious way to
// write this and it silently kills the page: browsers keep about sixteen live
// contexts and drop the oldest, so the early cells go black AFTER rendering
// correctly, with nothing thrown and a clean console.
const gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(P, P);
gl.outputColorSpace = THREE.SRGBColorSpace;
const post = createPost(gl);
post.resize();

let shotIndex = 0;
const posted = [];

/** Start a row of panels; returns a 2D canvas the renders get blitted into. */
function row() {
  const canvas = document.createElement('canvas');
  canvas.width = P * PANELS * 2;
  canvas.height = P * 2;
  canvas.style.width = `${P * PANELS}px`;
  canvas.style.height = `${P}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04070e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx, n: 0 };
}

function panel(r, label) {
  const x = r.n * P * 2;
  r.ctx.drawImage(gl.domElement, x, 0);
  r.ctx.font = '600 26px ui-monospace, Menlo, monospace';
  r.ctx.fillStyle = 'rgba(180,210,255,0.85)';
  r.ctx.fillText(label, x + 20, 40);
  r.n++;
}

function present(r, caption) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.appendChild(r.canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = caption;
  cell.appendChild(cap);
  document.getElementById('grid').appendChild(cell);
  const name = `${String(shotIndex++).padStart(2, '0')}-`
    + `${caption.split('—')[0].trim().toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => r.canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// --- the scene --------------------------------------------------------------
// Deliberately close to the game's: a dark blue-green ground so the coloured
// notes are judged against the water they will actually sit in, and no lights
// at all for the notes themselves, which are unlit by construction.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x061420);
scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x22323a, 1.8));
const key = new THREE.DirectionalLight(0xfff2e0, 2.0); key.position.set(-3, 4, 6); scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe4ff, 0.9); fill.position.set(4, 1, 3); scene.add(fill);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
function frame(cx, cy, halfHeight) {
  camera.position.set(cx, cy, halfHeight / Math.tan((42 * Math.PI) / 360));
  camera.lookAt(cx, cy, 0);
  camera.updateProjectionMatrix();
}

// --- glyphs -----------------------------------------------------------------
await preloadAssets();
const gltf = await new GLTFLoader().loadAsync('/models/musicnotes.glb');
const geoms = [];
gltf.scene.traverse((o) => { if (o.isMesh) geoms.push(o.geometry); });
installNoteGlyphs(geoms);
check('musicnotes.glb parsed', geoms.length === 8, `${geoms.length} glyphs`);
check('musicNote uses the extracted glyph', hasModel('musicNote'));
check('a host creature loaded', hasModel('enemyShark'));

// Every glyph is authored flat at z = 0 and one unit tall. If either stops being
// true the whole placement maths below is wrong, so it is asserted rather than
// assumed — a glyph with depth would not read as a glyph at any angle.
{
  let flat = true; let tallest = 0; let tris = 0;
  for (const g of geoms) {
    g.computeBoundingBox();
    const b = g.boundingBox;
    if (b.max.z - b.min.z > 1e-4) flat = false;
    tallest = Math.max(tallest, b.max.y - b.min.y);
    tris += g.index.count / 3;
  }
  check('glyphs are flat (z = 0)', flat);
  check('tallest glyph is the beamed triple at 1.48', Math.abs(tallest - 1.48) < 0.02, tallest.toFixed(3));
  log(`    ${tris} triangles for the whole set, 8 draw calls however many notes are live`);
}

// --- the colour claim, measured --------------------------------------------
// A random hue does not bloom evenly, and that is the whole difficulty in "a
// random emissive colour per charmed body". Measure all three modes on this
// project's real threshold before looking at any picture of them: the numbers
// say which ones can possibly work, and the pictures then say which of those
// is worth shipping.
const COLOUR_MODES = ['peak', 'lum', 'even'];
{
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const peak = (c) => Math.max(c.r, c.g, c.b);
  const thr = CONFIG.bloom?.threshold ?? 0.55;
  log(`    bloom threshold ${thr}, knee ${CONFIG.bloom?.knee ?? 0}  —  12 hues, each mode:`);
  const summary = {};
  for (const mode of COLOUR_MODES) {
    let lo = Infinity; let hi = -Infinity; let below = 0; let maxPeak = 0;
    for (let i = 0; i < 12; i++) {
      // The FULL wheel, explicitly: rollNoteColor's default is now the
      // restricted arc, and measuring the modes through it would hide the very
      // spread being measured.
      const c = rollNoteColor(() => i / 12, { mode, hues: [0, 1] });
      const L = lum(c);
      lo = Math.min(lo, L); hi = Math.max(hi, L);
      maxPeak = Math.max(maxPeak, peak(c));
      if (L < thr) below++;
    }
    summary[mode] = { lo, hi, below, maxPeak };
    log(`      ${mode.padEnd(5)} luminance ${lo.toFixed(2)}..${hi.toFixed(2)} (${(hi / lo).toFixed(1)}x spread)  `
      + `${below}/12 below threshold  worst peak channel ${maxPeak.toFixed(1)}`);
  }
  check(
    'the naive roll is the problem it is claimed to be',
    summary.peak.below > 0 && summary.peak.hi / summary.peak.lo > 4,
    `${summary.peak.below}/12 hues never bloom, ${(summary.peak.hi / summary.peak.lo).toFixed(1)}x spread`,
  );
  check(
    "'even': every hue clears the threshold",
    summary.even.below === 0,
    `dimmest hue lum ${summary.even.lo.toFixed(2)} vs threshold ${thr}`,
  );
  check(
    "'even': every hue blooms within 1.1x of every other",
    summary.even.hi / summary.even.lo < 1.1,
    `${summary.even.lo.toFixed(2)}..${summary.even.hi.toFixed(2)}`,
  );
  check(
    "'even' never drives a channel past its glow ceiling, so nothing clips",
    summary.even.maxPeak <= 1.91,
    `worst peak ${summary.even.maxPeak.toFixed(2)}`,
  );
  check(
    "'lum' also blooms evenly, but pays for it at the composite",
    summary.lum.below === 0 && summary.lum.maxPeak > 4,
    `worst peak channel ${summary.lum.maxPeak.toFixed(1)} — the knee turns that core white`,
  );

  // What actually ships: full saturation, no clipping, and the dead part of the
  // wheel simply never comes up. This is the check that would fail if anyone
  // widened CONFIG.harp.hueFrom/hueTo into the blues without re-measuring.
  const { hueFrom, hueTo } = CONFIG.harp;
  let arcLo = Infinity; let arcHi = -Infinity; let arcBelow = 0;
  for (let i = 0; i <= 40; i++) {
    const L = lum(rollNoteColor(() => i / 40, { hues: [hueFrom, hueTo] }));
    arcLo = Math.min(arcLo, L); arcHi = Math.max(arcHi, L);
    if (L < thr) arcBelow++;
  }
  log(`      SHIPPED arc ${hueFrom}..${hueTo}: luminance ${arcLo.toFixed(2)}..${arcHi.toFixed(2)} `
    + `(${(arcHi / arcLo).toFixed(2)}x spread), full saturation, nothing clipping`);
  check(
    'the shipped hue arc has no dead hues in it',
    arcBelow === 0 && arcHi / arcLo < 1.8,
    `${arcBelow} below threshold, ${(arcHi / arcLo).toFixed(2)}x spread`,
  );
}

// --- the field --------------------------------------------------------------
// Seeded, so a re-render of the same option is the same picture and two options
// are being compared on their motion rather than on their dice. See
// [[seeded-rng-in-spawn-harnesses]].
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let field = null;
function freshField(seed = 12345) {
  field?.dispose();
  field = createNoteField(scene, { rng: seeded(seed) });
  return field;
}

// A fixed step, so every option is integrated identically and a difference on
// screen is a difference in the preset.
const STEP = 1 / 60;
function run(seconds, alive = () => true) {
  for (let t = 0; t < seconds; t += STEP) field.update(STEP, alive);
}

function draw() {
  post.render(scene, camera, STEP);
}

// --- 1. the glyph set -------------------------------------------------------
{
  const r = row();
  const holder = new THREE.Group();
  scene.add(holder);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe9a3, side: THREE.DoubleSide, toneMapped: false });
  geoms.forEach((g, i) => {
    const m = new THREE.Mesh(g, mat);
    m.position.set((i - 3.5) * 1.6, 0, 0);
    holder.add(m);
  });
  frame(0, 0, 6.6);
  draw();
  panel(r, 'the 8 glyphs, 1 unit tall');

  // Against the animal that will carry them, at the size the aura draws them.
  // The only honest way to judge `auraNoteScale`: a note is legible or it isn't
  // at the size it sits next to a shark, and 0.55 is a number nobody can read
  // off a slider.
  holder.clear();
  const shark = createVisual('enemyShark');
  // createVisual points a creature's forward at world +Y, so anything previewed
  // side-on has to be laid down or it stands on its tail.
  shark.rotation.z = -Math.PI / 2;
  shark.position.set(0, 0, 0);
  scene.add(shark);
  geoms.forEach((g, i) => {
    const m = new THREE.Mesh(g, mat);
    m.scale.setScalar(CONFIG.harp.auraNoteScale);
    const a = (i / geoms.length) * Math.PI * 2;
    m.position.set(Math.cos(a) * 3.4, Math.sin(a) * 3.4 * 0.6, Math.sin(a) * 1.7);
    m.rotation.z = a * 0.5;
    holder.add(m);
  });
  frame(0, 0, 4.6);
  draw();
  panel(r, `on a shark at auraNoteScale ${CONFIG.harp.auraNoteScale}, radius ${CONFIG.harp.auraRadius}`);

  // The PROJECTILE, through createVisual — the one part of this that ships the
  // moment the asset entry changes, before any of the options below are wired
  // up. It is the only path that exercises `fit`, the forward/up mapping and
  // the unlit material together, and the failure it is looking for is silent:
  // get the `up` sign wrong and a zero-thickness plane presents its edge for
  // the whole flight, which looks like the model failed to load.
  holder.clear();
  scene.remove(shark);
  for (let i = 0; i < 6; i++) {
    const v = createVisual('musicNote');
    // Fanned through the angles the seeker actually carries a note through.
    // `orient: true` sets rotation.z from the flight direction, so this is what
    // the projectile does, not an approximation of it.
    v.rotation.z = (i / 6) * Math.PI * 2;
    v.position.set((i - 2.5) * 1.5, 0, 0);
    holder.add(v);
  }
  holder.updateMatrixWorld(true);
  {
    const b = new THREE.Box3().setFromObject(holder.children[0]);
    const s = b.getSize(new THREE.Vector3());
    log(`    createVisual('musicNote'): ${s.x.toFixed(2)} x ${s.y.toFixed(2)} x ${s.z.toFixed(3)} world units`);
    check(
      'the projectile glyph is fit to 0.85 units tall',
      Math.abs(Math.max(s.x, s.y) - 0.85) < 0.03,
      `longest axis ${Math.max(s.x, s.y).toFixed(3)}`,
    );
    check(
      'the projectile faces the camera, not edge-on',
      s.z < 0.02 && Math.min(s.x, s.y) > 0.3,
      `depth ${s.z.toFixed(4)}, short screen axis ${Math.min(s.x, s.y).toFixed(3)}`,
    );
  }
  frame(0, 0, 3.0);
  draw();
  panel(r, "createVisual('musicNote') — the harp's projectile, spun through its flight angles");
  scene.remove(holder);
  present(r, 'glyphs — what came out of the bake, and how big to draw it');
}

// --- 2. the storm, four ways ------------------------------------------------
// Each row is one preset sampled early, mid and late in its own life, fired
// from a shark the way a landing note would fire it.
for (const name of Object.keys(BURST_PRESETS)) {
  const r = row();
  const host = createVisual('enemyShark');
  host.rotation.z = -Math.PI / 2;
  scene.add(host);
  freshField(4242);
  const color = rollNoteColor(seeded(7));
  field.burst(0, 0, 0, { count: 26, color, preset: name, scale: 0.5, radius: 1.2 });
  frame(0, 1.2, 6.5);
  let t = 0;
  for (const at of [0.18, 0.5, 0.95]) {
    run(at - t); t = at;
    draw();
    panel(r, `${name}  t=${at.toFixed(2)}s  ${field.count} notes`);
  }
  scene.remove(host);
  const p = BURST_PRESETS[name];
  present(r, `storm option: ${name} — speed ${p.speed}, drag ${p.drag}, rise ${p.rise}, life ${p.life}s`);
}

// --- 3. the aura, three ways ------------------------------------------------
// A charmed body wearing its ring for real: the host is a shark that keeps
// swimming, because a ring that only works on a stationary animal is not a ring
// that works.
for (const name of Object.keys(AURA_PRESETS)) {
  const r = row();
  const visual = createVisual('enemyShark');
  visual.rotation.z = -Math.PI / 2;
  scene.add(visual);
  const host = { mesh: visual };
  freshField(99);
  const color = rollNoteColor(seeded(3));
  field.attach(host, {
    count: name === 'staff' ? 10 : CONFIG.harp.auraNotes,
    color,
    preset: name,
    scale: CONFIG.harp.auraNoteScale,
    radius: CONFIG.harp.auraRadius,
  });
  frame(0, 0, 5.0);
  let t = 0;
  for (const at of [0.4, 1.3, 2.6]) {
    // The host drifts, so the notes are seen tracking a moving body rather than
    // decorating a static one.
    const steps = Math.round((at - t) / STEP);
    for (let i = 0; i < steps; i++) {
      visual.position.x = Math.sin((t + i * STEP) * 0.8) * 1.4;
      visual.position.y = Math.cos((t + i * STEP) * 0.6) * 0.5;
      field.update(STEP);
    }
    t = at;
    draw();
    panel(r, `${name}  t=${at.toFixed(1)}s  ${field.count} notes`);
  }
  scene.remove(visual);
  present(r, `aura option: ${name} — ${JSON.stringify(AURA_PRESETS[name])}`);
}

// --- 4. the random colour, three ways --------------------------------------
// The proposal's second half: every charmed body gets its own hue. Six hosts to
// a panel so the spread across the wheel is visible at once, and the SAME six
// hues in every panel so the only difference between them is the mode.
{
  const r = row();
  // The decision, in three panels: the naive full wheel and what is wrong with
  // it, the arc that ships, and the arc with a storm going off inside it.
  const HUES = [[0.00, 'red'], [0.33, 'green'], [0.55, 'blue'], [0.85, 'magenta']];
  const shipped = [CONFIG.harp.hueFrom, CONFIG.harp.hueTo];
  const layouts = [
    ['the full wheel — red, green, blue, magenta', (i) => rollNoteColor(() => HUES[i][0], { hues: [0, 1] }), false],
    [`the shipped arc ${shipped[0]}..${shipped[1]}`, (i) => rollNoteColor(() => i / 4, { hues: shipped }), false],
    ['the shipped arc, mid-storm', (i) => rollNoteColor(() => i / 4, { hues: shipped }), true],
  ];
  for (const [label, colorAt, storm] of layouts) {
    freshField(2024);
    const visuals = [];
    for (let i = 0; i < 4; i++) {
      const v = createVisual('enemyShark');
      v.rotation.z = -Math.PI / 2; // createVisual points forward at world +Y
      v.position.set(i % 2 ? 4.2 : -4.2, i < 2 ? 3.2 : -3.2, 0);
      v.scale.setScalar(0.75);
      scene.add(v);
      visuals.push(v);
      const color = colorAt(i);
      field.attach({ mesh: v }, {
        count: CONFIG.harp.auraNotes,
        color,
        preset: 'ring',
        scale: CONFIG.harp.auraNoteScale,
        radius: 2.5,
      });
      // Both halves of the storm, exactly as systems/harp.js fires them.
      if (storm) {
        const p = v.position;
        field.burst(p.x, p.y, p.z, { count: CONFIG.harp.stormNotes, color, preset: 'bloom', scale: CONFIG.harp.stormScale, radius: 0.9 });
        field.burst(p.x, p.y, p.z, { count: CONFIG.harp.stormRiseNotes, color, preset: 'updraft', scale: CONFIG.harp.stormScale, radius: 0.6 });
      }
    }
    frame(0, 0, 7.0);
    run(storm ? 0.45 : 1.7);
    draw();
    panel(r, `${label}${storm ? `  (${field.count} notes)` : ''}`);
    for (const v of visuals) scene.remove(v);
  }
  present(r, 'random emissive colour — why the wheel is restricted, and what ships');
}

// --- 5. the whole ability, as it would play --------------------------------
// Storm and aura together on a real fight's worth of creatures, which is the
// only shot that shows whether the two halves fight each other.
{
  const r = row();
  freshField(5150);
  const visuals = [];
  for (let i = 0; i < 7; i++) {
    const v = createVisual(i % 3 === 0 ? 'enemyShark' : 'enemyFish');
    v.rotation.z = -Math.PI / 2;
    v.position.set(((i * 4.7) % 17) - 8.5, ((i * 3.1) % 8) - 4, ((i * 1.7) % 3) - 1.5);
    scene.add(v);
    visuals.push(v);
  }
  const hostA = { mesh: visuals[0] };
  const hostB = { mesh: visuals[3] };
  // Two hues chosen a third of the wheel apart rather than rolled. A random
  // pair lands close together often enough that this shot would be answering
  // "did the dice cooperate" instead of "do two hues stay apart".
  const colA = rollNoteColor(() => 0.09);
  const colB = rollNoteColor(() => 0.55);
  field.attach(hostA, { count: 5, color: colA, preset: 'swarm', scale: 0.55, radius: 3.4 });
  field.attach(hostB, { count: 5, color: colB, preset: 'swarm', scale: 0.55, radius: 3.4 });
  frame(0, 0, 8.0);
  run(0.9);
  draw();
  panel(r, 'two charmed bodies, auras only');

  field.burst(hostA.mesh.position.x, hostA.mesh.position.y, hostA.mesh.position.z,
    { count: 26, color: colA, preset: 'bloom', scale: 0.5, radius: 1.2 });
  run(0.22);
  draw();
  panel(r, `a note lands: burst + aura  (${field.count} notes)`);

  run(0.5);
  draw();
  panel(r, `the storm settling  (${field.count} notes)`);
  log(`    peak live notes drew ${JSON.stringify(field.stats())}`);
  check('the whole field is 8 draws or fewer', field.stats().draws <= 8, `${field.stats().draws} draws`);
  for (const v of visuals) scene.remove(v);
  present(r, 'in a fight — storm and aura together, two hosts, two hues');
}

await Promise.all(posted);
log(fails ? `${fails} FAILED` : 'all checks passed', fails ? 'bad' : 'ok');
document.title = fails ? `notes — ${fails} FAILED` : 'notes — ok';
