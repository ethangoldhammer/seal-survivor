// ---------------------------------------------------------------------------
// PEBBLE BANDS — LOOK DEV, AND THE ONLY PLACE THIS SHADER DRAWS
//
//   npm run looks:bands
//
// The band field (makeBandMaterial in assets.js) paints the basic shot out of a
// scrolling noise field instead of one colour, so that a dense volley shows
// coloured weather blowing through it. Two things make that unverifiable
// anywhere else in the repo:
//
//   NODE HAS NO GL. tools/elements-test.mjs asserts the pellet's material
//   COLOUR, which this shader never touches — it mixes in the fragment stage.
//   A field that compiled and drew pure black would pass every Node harness in
//   the project, and the pellet would simply vanish.
//
//   AND ONE PELLET PROVES NOTHING. The whole effect is a property of the CROWD:
//   each stone samples one point of a shared field, so a single shot is one
//   colour and only a stream reveals the bands. Every panel below is therefore
//   a stream, at the density the card is actually sold on.
//
// Everything drawn here is the SHIPPING asset through the SHIPPING material —
// createVisual('bullet'), with setAssetBands driving the same uniforms
// updateShotTint drives in a run. A panel that comes out grey is a real break.
//
// The measurements are the half a screenshot cannot make:
//
//   THE FIELD IS ANISOTROPIC. Bands, not blobs. Two rows of the same frame are
//   compared: along the band direction the colour must hold, and across it must
//   change. An isotropic fbm passes the eye test in a still and reads as
//   confetti in motion.
//
//   IT TRAVELS. The same stream is sampled at two times and must differ. A
//   field with a dead clock is a texture painted on the water, which is the one
//   failure that looks completely fine in a screenshot.
//
//   AND IT IS STILL A ROCK. The rock's vertex colours multiply in downstream of
//   the injection, so a banded pellet must still have facet shading — a flat
//   coloured pill means the injection landed in the wrong chunk.
//
// IT WRITES NOTHING. There is no save path on this page and no dev server
// behind it — see SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createVisual, setAssetBands, getAssetSizeMultiplier } from '../../path/src/assets.js';

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
// console about it, so the page would look like a bad tuning decision instead
// of a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 360;
const H = 220;
const VIEW = 14; // world units across the short axis
const BUF = 2;

const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(BUF);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -100, 100);
camera.position.set(0, 0, 20);

// Water behind the stream. Over black every panel would read as its own colour
// at full strength, and the question being asked — whether bands are legible
// against the sea the game actually draws — would be unanswerable.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x0d2a3a }),
);
water.position.z = -30;
scene.add(water);

const EL = CONFIG.biolum?.elements ?? {};
const colorOf = (id) => EL[id]?.color ?? 0xffffff;

// --- the stream -------------------------------------------------------------
//
// A volley the way the gun actually lays one down: two fins trading shots, each
// tick a row of pellets fanned by finSpread, marching across the arena. The
// COUNT is the variable the card is about — this is what "when the amount of
// pebbles on screen is really high" looks like.
const pool = [];
function stream(rows, perRow) {
  for (const m of pool) scene.remove(m);
  pool.length = 0;
  const sizeMul = getAssetSizeMultiplier('bullet');
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < perRow; i++) {
      const m = createVisual('bullet');
      // Spread over the arena the way a marching volley is: rows separated by
      // the distance a pellet covers between ticks, pellets within a row by the
      // fin fan opened out to the range they have reached.
      m.position.set(-VIEW * (W / H) / 2 + 0.9 + r * 1.15,
        (i - (perRow - 1) / 2) * (0.55 + r * 0.09), 0);
      m.scale.setScalar(sizeMul * 1.5);
      m.rotation.set(r * 0.7 + i, i * 1.3, r * 0.4);
      scene.add(m);
      pool.push(m);
    }
  }
  return pool.length;
}

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

function present(title, note) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * BUF;
  canvas.height = H * BUF;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04070e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gl.domElement, 0, 0);
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b><br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// The clock is SET rather than advanced, so a panel is a frame of a named
// moment and re-rendering it twice gives the same picture.
function draw({ colors = [], amount = 0.72, time = 0 } = {}) {
  setAssetBands('bullet', { colors, amount, dt: 0 });
  for (const m of pool) {
    const u = m.material.userData.__bands;
    if (u) u.uBandTime.value = time;
  }
  gl.render(scene, camera);
}

// --- measuring off the frame ------------------------------------------------

const scratch = document.createElement('canvas');
scratch.width = W * BUF;
scratch.height = H * BUF;
const sctx = scratch.getContext('2d', { willReadFrequently: true });

function grab() {
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  sctx.drawImage(gl.domElement, 0, 0);
  return sctx.getImageData(0, 0, scratch.width, scratch.height);
}

// Only pixels that are actually a pellet: the water is a flat known colour and
// everything brighter than it, by a margin, is a stone.
const WATER = [0x0d, 0x2a, 0x3a];
function pellets(img) {
  const out = [];
  const d = img.data;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const i = (y * img.width + x) * 4;
      const dr = d[i] - WATER[0], dg = d[i + 1] - WATER[1], db = d[i + 2] - WATER[2];
      if (dr * dr + dg * dg + db * db < 900) continue;
      out.push({ x, y, r: d[i], g: d[i + 1], b: d[i + 2] });
    }
  }
  return out;
}

// Mean hue angle spread — how much the colours across a set of pellets differ.
function hueSpread(px) {
  if (px.length < 8) return 0;
  let sx = 0, sy = 0;
  for (const p of px) {
    const max = Math.max(p.r, p.g, p.b), min = Math.min(p.r, p.g, p.b);
    if (max === min) continue;
    let h;
    if (max === p.r) h = ((p.g - p.b) / (max - min)) % 6;
    else if (max === p.g) h = (p.b - p.r) / (max - min) + 2;
    else h = (p.r - p.g) / (max - min) + 4;
    h *= Math.PI / 3;
    sx += Math.cos(h);
    sy += Math.sin(h);
  }
  // 0 = every pellet the same hue, 1 = spread right round the wheel.
  return 1 - Math.hypot(sx, sy) / px.length;
}

const meanChannel = (px, k) => (px.length ? px.reduce((a, p) => a + p[k], 0) / px.length : 0);

// ---------------------------------------------------------------------------
log('PEBBLE BANDS — the basic shot painted out of a scrolling noise field');
log('');

const count = stream(11, 7);
check('the stream is dense enough to be the thing under test', count >= 60, `${count} pellets`);

// --- 1. the palettes --------------------------------------------------------
section('what a build throws', 2);

draw({ colors: [], amount: 0 });
const plain = pellets(grab());
present('no element', `${plain.length} lit pixels of plain stone. `
  + 'The identity: uBandAmt 0 collapses the whole branch to the asset colour.');
check('a run with no element draws a grey stone', hueSpread(plain) < 0.06,
  `hue spread ${hueSpread(plain).toFixed(3)}`);

draw({ colors: [colorOf('shock')], amount: 0.72 });
const one = pellets(grab());
present('one element — a lit flipper', 'One colour in the palette, so the field is left with '
  + 'brightness alone: ribbons of the same hue travelling through the stream.');

draw({ colors: [colorOf('shock'), colorOf('venom')], amount: 0.81 });
const two = pellets(grab());
present('two — both flippers lit', 'The noise alternates the pair. This is the shape the '
  + 'card is sold on: two fins, two colours, mingling rather than split down the middle.');

draw({ colors: [colorOf('shock'), colorOf('venom'), colorOf('chill')], amount: 0.9 });
const three = pellets(grab());
present('three — two flippers and a Glow Up!', 'The loudest the gun gets. The run\'s own '
  + 'element is the third colour in the field, not a wash over the other two.');

check('more elements means more colours in the air',
  hueSpread(three) > hueSpread(two) && hueSpread(two) > hueSpread(one),
  `1: ${hueSpread(one).toFixed(3)}  2: ${hueSpread(two).toFixed(3)}  3: ${hueSpread(three).toFixed(3)}`);
check('...and one element is still visibly coloured, not grey',
  meanChannel(one, 'b') > meanChannel(plain, 'b') + 12,
  `blue ${meanChannel(one, 'b').toFixed(0)} vs ${meanChannel(plain, 'b').toFixed(0)} plain`);

// --- 2. bands, not blobs ----------------------------------------------------
section('bands, not blobs', 2);

draw({ colors: [colorOf('shock'), colorOf('venom')], amount: 0.81 });
const img = grab();
const px = pellets(img);
// Along the band direction (uBandDir is +x at angle 0, and `stretch` squashes
// ACROSS it) colour should hold; across it, it should change. Sampling by
// column vs by row is the whole test.
const byColumn = new Map();
const byRow = new Map();
for (const p of px) {
  const c = Math.round(p.x / (img.width / 8));
  const r = Math.round(p.y / (img.height / 5));
  if (!byColumn.has(c)) byColumn.set(c, []);
  if (!byRow.has(r)) byRow.set(r, []);
  byColumn.get(c).push(p);
  byRow.get(r).push(p);
}
const spreadWithin = (groups) => {
  const vals = [...groups.values()].filter((g) => g.length >= 8).map(hueSpread);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
};
const withinColumn = spreadWithin(byColumn);
const withinRow = spreadWithin(byRow);
present('one frame, measured', `hue spread within a COLUMN ${withinColumn.toFixed(3)}, `
  + `within a ROW ${withinRow.toFixed(3)}. A band runs down a column, so a column should be `
  + 'one colour and a row should cross several.');
check('a column holds its colour better than a row does', withinColumn < withinRow,
  `${withinColumn.toFixed(3)} within a column vs ${withinRow.toFixed(3)} across a row`);

// --- 3. it travels ----------------------------------------------------------
section('it travels', 2);

draw({ colors: [colorOf('shock'), colorOf('venom')], amount: 0.81, time: 0 });
const t0 = pellets(grab());
present('t = 0', 'The same stones, the same positions.');
draw({ colors: [colorOf('shock'), colorOf('venom')], amount: 0.81, time: 0.9 });
const t1 = pellets(grab());
present('t = 0.9s', 'Only the field has moved. If these two frames matched, the bands would '
  + 'be painted on the water and the pellets would be flying through a texture.');

let moved = 0;
for (let i = 0; i < Math.min(t0.length, t1.length); i++) {
  const a = t0[i], b = t1[i];
  if (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) > 24) moved++;
}
check('the field moves through a stationary stream',
  moved > Math.min(t0.length, t1.length) * 0.25,
  `${moved} of ${Math.min(t0.length, t1.length)} sampled pixels changed colour`);

// --- 4. still a rock --------------------------------------------------------
section('still a rock', 2);

draw({ colors: [colorOf('venom')], amount: 0.9 });
const lit = pellets(grab());
// The rock's greyscale vertex colours multiply in AFTER the injection, so a
// banded pellet still has bright and dark facets. A flat pill means the
// injection landed downstream of <color_fragment> and ate them.
const vals = lit.map((p) => Math.max(p.r, p.g, p.b));
const lo = vals.length ? Math.min(...vals) : 0;
const hi = vals.length ? Math.max(...vals) : 0;
present('facets survive the repaint', `brightest ${hi}, darkest ${lo} across the lit pixels. `
  + 'The rock\'s baked vertex shading multiplies in downstream of the band.');
check('the stone still has facets under the colour', hi - lo > 40, `${lo} to ${hi}`);

// ---------------------------------------------------------------------------
log('');
check('nothing failed to compile', shaderErrors.length === 0,
  shaderErrors[0] ?? `${shotIndex} panels rendered`);
await Promise.all(posted);
log('');
log(fails ? `${fails} PROBLEM(S)` : 'ALL GOOD', fails ? 'bad' : 'ok');
document.title = fails ? 'pebble bands FAILED' : 'pebble bands ok';
