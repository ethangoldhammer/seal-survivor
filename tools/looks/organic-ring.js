// ---------------------------------------------------------------------------
// THE ORGANIC RING — LOOK DEV, AND THE ONLY PLACE ITS SHADER COMPILES
//
//   npm run looks:ring
//
// Two jobs, and the second one is why this is a page rather than a Node
// harness. A GLSL compile error renders NOTHING and three only writes to the
// console about it, so every ring in the game would go silently invisible and
// no test in tools/ could see it — nothing in Node has a GL context to compile
// against. Every panel below is the SHIPPING module drawing with the SHIPPING
// numbers, so a panel that comes out empty is a real break.
//
// The measurements are the half a screenshot cannot make. Four of them pin
// decisions that are otherwise only opinions:
//
//   THE BOUNDARY IS BOUNDED. The edge is displaced BOTH WAYS, which means a
//   telegraph ring can bulge past the radius it is promising. Every lit pixel
//   is measured against radius * (1 + wobbleMax) — if that cap ever stops
//   holding, a boss is claiming reach it does not have and the fight reads as
//   unfair for a reason nobody can name.
//
//   THE HAND CLOSES. At sweepIn 0 nothing draws; at 1 every one of 96 rays out
//   of the centre finds paint. A sweep that never quite closed would leave a
//   permanent notch in an attack ring, which is exactly the gap a player would
//   swim into.
//
//   THE GRAIN IS A WORLD SIZE. A ring five times the radius is measured for
//   five times the lobes rather than the same lobes drawn bigger. This is the
//   whole "world-space, fixed" decision, and a UV-space field would pass every
//   other check on this page.
//
//   ELECTRIC HOLDS ITS JAGS. The radial profile is sampled a millisecond apart
//   (must be identical) and a tenth of a second apart (must not be). Per-frame
//   jitter and a stepped hold look nearly the same in a still, and only one of
//   them reads as arcs in motion.
//
// IT WRITES NOTHING. There is no save path on this page and no dev server
// behind it — see SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import {
  makeOrganicRing, placeOrganicRing, updateOrganicRing, threatType,
  EDGE_KINDS, __organicRingShader,
} from '../../path/src/systems/organicRing.js';
import { ATTACK_IDS, parseBossPerkCsv } from '../../path/src/bossPerkTable.js';
import PERKS_CSV from '../../path/src/bossPerks.csv?raw';

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
// of a broken program. Collected from the first frame onward.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 300;
const H = 300;
const VIEW = 10;             // world units across the short axis
const BUF = 2;               // device pixel ratio
const PX = (H * BUF) / VIEW; // pixels per world unit
const CX = (W * BUF) / 2;
const CY = (H * BUF) / 2;

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(BUF);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -100, 100);
camera.position.set(0, 0, 20);

// Water behind the rings. They blend ADDITIVELY, so over black every panel
// would read as its own colour at full strength and the thing being judged —
// whether a lumpy edge still reads as a boundary against a busy sea — would be
// invisible. Same reasoning, and the same brightness caveat, as kill-goo.js.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x24485c }),
);
water.position.z = -30;
scene.add(water);

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
  cap.innerHTML = `<b>${title}</b>${picked ? ' <span class="tag">— shipped</span>' : ''}<br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
  return ctx;
}

// --- drawing one ring -------------------------------------------------------

let live = null;

function draw({ type = 'kinetic', radius = 3, sweepIn = 1, sweepOut = 0, charge = 1,
                arcs = 0, thickness, color, opacity = 1, time = 0, at = [0, 0] } = {}) {
  if (live) { scene.remove(live); live.material.dispose(); }
  live = makeOrganicRing({ type, arcs, thickness, color });
  live.visible = true;
  scene.add(live);
  placeOrganicRing(live, at[0], at[1], radius);
  // The clock is set outright rather than advanced, so a panel is a FRAME of a
  // named moment and re-rendering it twice gives the same picture. The stepped
  // dialects care: an advanced clock would put every electric panel on a
  // different jag.
  live.material.uniforms.uTime.value = time;
  updateOrganicRing(live, 0, { opacity, sweepIn, sweepOut, charge });
  gl.render(scene, camera);
  return live;
}

// --- measuring off the frame ------------------------------------------------

// Read the drawing buffer back through a 2D canvas. drawImage off a WebGL
// canvas needs preserveDrawingBuffer, which is set above.
const scratch = document.createElement('canvas');
scratch.width = W * BUF;
scratch.height = H * BUF;
const sctx = scratch.getContext('2d', { willReadFrequently: true });

function grab() {
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  sctx.drawImage(gl.domElement, 0, 0);
  return sctx.getImageData(0, 0, scratch.width, scratch.height).data;
}

// The water is a flat colour and the rings blend additively, so "lit" is
// anything meaningfully brighter than the background rather than anything
// non-black. Sampled off the corner of the frame, which no ring reaches.
function backgroundLevel(px) {
  const i = ((8 * scratch.width) + 8) * 4;
  return px[i] + px[i + 1] + px[i + 2];
}

/**
 * The OUTERMOST lit radius along each of `rays` directions, in world units, or
 * 0 for a direction with no paint on it at all. This is the measurement every
 * assertion below is built out of: a ring is exactly a function from angle to
 * radius, and that is the thing worth checking.
 */
function radialProfile(px, rays = 96, maxR = VIEW / 2) {
  const bg = backgroundLevel(px);
  const out = new Float64Array(rays);
  const steps = Math.floor(maxR * PX);
  for (let a = 0; a < rays; a++) {
    const th = (a / rays) * Math.PI * 2;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    let found = 0;
    for (let s = steps; s >= 1; s--) {
      const x = Math.round(CX + dx * s);
      // Screen y runs down; the world's runs up. Only matters for which lobe
      // is which, but a drip dialect measured upside down would look correct
      // and be wrong.
      const y = Math.round(CY - dy * s);
      if (x < 0 || y < 0 || x >= scratch.width || y >= scratch.height) continue;
      const i = ((y * scratch.width) + x) * 4;
      if (px[i] + px[i + 1] + px[i + 2] > bg + 40) { found = s / PX; break; }
    }
    out[a] = found;
  }
  return out;
}

/**
 * The CORRELATION LENGTH of a radial profile, in world units along the
 * circumference: how far you have to walk around the edge before the wobble
 * stops resembling itself.
 *
 * This replaced a lobe count, which was the obvious instrument and the wrong
 * one. Counting extrema saturates — fbm stacks three octaves and the finest one
 * that survives the readback sets the count, so a ring at r3 and one at r4.8
 * both came out around 14 and the measurement said nothing either way.
 *
 * The correlation length says exactly the thing in question. If the field is
 * fixed in the world, this is a WORLD DISTANCE — about one noise cell — and it
 * is the same number on a small ring and a huge one. If the field were locked
 * to the ring's UVs, it would scale with the radius, because a cell would be a
 * fixed FRACTION of the circumference. One number, and the two hypotheses
 * predict completely different things about it.
 *
 * The profile must be sampled at a constant number of rays per world unit of
 * circumference, so a lag of k samples is k/RAYS_PER_UNIT world units on every
 * ring.
 */
function correlationLength(profile, raysPerUnit, threshold = 0.3) {
  const n = profile.length;
  let mean = 0;
  for (const v of profile) mean += v;
  mean /= n;
  const d = Float64Array.from(profile, (v) => v - mean);
  let power = 0;
  for (const v of d) power += v * v;
  if (power <= 1e-9) return 0;
  for (let k = 1; k < n / 2; k++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += d[i] * d[(i + k) % n];
    if (acc / power < threshold) return k / raysPerUnit;
  }
  return (n / 2) / raysPerUnit;
}

// ============================================================================
// THE CHECKS THAT NEED NO PIXELS
// ============================================================================

section('THE PAIR — <span>uniforms declared against uniforms read</span>', 1);
{
  const { vertexShader, fragmentShader } = __organicRingShader;
  const mat = makeOrganicRing().material;
  const declared = Object.keys(mat.uniforms);
  const missing = declared.filter((u) => !fragmentShader.includes(u) && !vertexShader.includes(u));
  check('every uniform the material declares is read by the shader',
    missing.length === 0, missing.length ? missing.join(', ') : `${declared.length} uniforms`);
  const used = [...fragmentShader.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]);
  const unsupplied = used.filter((u) => !declared.includes(u));
  check('...and every uniform the shader reads is supplied',
    unsupplied.length === 0, unsupplied.length ? unsupplied.join(', ') : `${used.length} read`);
  // The one that ends a template literal thirty lines above where it reports.
  check('no backtick anywhere in the shader source',
    !vertexShader.includes('`') && !fragmentShader.includes('`'));
  // Injected shaders in this project compile as GLSL ES 1.00, where these do
  // not exist. This one is standalone and would get away with it today, and
  // would break the moment its body moved into an onBeforeCompile.
  check('...and no derivatives, so the body can be injected later',
    !/\bfwidth\b|\bdFdx\b|\bdFdy\b/.test(fragmentShader));
  mat.dispose();
}

section('THE PALETTE — <span>two tables that must not drift</span>', 1);
{
  const cfgIds = Object.keys(CONFIG.fx.attackTypes);
  const onlyCfg = cfgIds.filter((k) => !ATTACK_IDS.includes(k));
  const onlyCsv = ATTACK_IDS.filter((k) => !cfgIds.includes(k));
  // bossPerkTable.js cannot import CONFIG without dragging three and the tuning
  // JSON into every Node harness that parses the table, so the id list is
  // duplicated there. This is what stops the copy rotting.
  check('the CSV validator knows exactly the types the palette defines',
    onlyCfg.length === 0 && onlyCsv.length === 0,
    [...onlyCfg.map((k) => `+${k}`), ...onlyCsv.map((k) => `-${k}`)].join(' ') || `${cfgIds.length} types`);

  // The join that makes an electric boss the colour of the player's Voltaic.
  const elec = threatType('electric');
  const shock = CONFIG.biolum.elements.shock.color;
  check('an element-backed type reads the element\'s own colour',
    elec.color === shock, `#${new THREE.Color(elec.color).getHexString()}`);
  check('...and carries the crackling dialect', elec.edge === EDGE_KINDS.electric);
  check('an unknown type degrades instead of throwing',
    threatType('not-a-real-type').edge === EDGE_KINDS.smooth);

  const perks = parseBossPerkCsv(PERKS_CSV, () => {});
  const withRing = ['lunge', 'electric', 'teleport', 'phase', 'eyebeam', 'barrels', 'spitfish', 'finfish'];
  const unset = withRing.filter((id) => !perks.find((p) => p.id === id)?.attack);
  check('every perk that draws a tell names its attack type',
    unset.length === 0, unset.join(', ') || `${withRing.length} rows`);
}

// ============================================================================
// THE SHEET
// ============================================================================

const c = CONFIG.fx.organicRing;

section('THE DIALECTS — <span>one base language, five accents, all at the same radius</span>', 3);
for (const [type, note] of [
  ['kinetic', 'the base. soft lobes, low frequency — a mass with surface tension'],
  ['electric', 'held jagged splines, re-rolled on a stepped clock'],
  ['blast', 'roiling: two counter-moving samples, so it turns over'],
  ['venom', 'stretched and sagging — only the underside runs'],
  ['chill', 'flat chords. the true radius is the INCIRCLE, so the flats sit inside it'],
  ['void', 'the base again, in the colour of a boss refusing to be where you aimed'],
]) {
  // A TELEGRAPH-WEIGHT BAND, not the module default. The default 0.16 is the
  // strike mark's thickness — the fattest ring in the game — and judging the
  // dialects at it makes every one of them read as a blob. The boss tells pass
  // 0.05 to 0.09.
  draw({ type, radius: 3.4, time: 2.5, thickness: 0.07 });
  present(type, note, type === 'electric');
}

section('THE HAND — <span>the transition is the countdown, not a fade</span>', 5);
for (const t of [0.15, 0.4, 0.65, 0.9, 1]) {
  draw({ type: 'electric', radius: 3.4, sweepIn: t, charge: t, time: 2.5, thickness: 0.07 });
  present(`windup ${Math.round(t * 100)}%`,
    t === 1 ? 'closed on the frame the shot fires' : `${Math.round((1 - t) * 100)}% of the warning left`,
    t === 1);
}

section('...AND LEAVING — <span>the same hand continuing, not a dim</span>', 4);
for (const t of [0, 0.35, 0.7, 0.95]) {
  draw({ type: 'blast', radius: 3.4, sweepIn: 1, sweepOut: t, time: 1.2, thickness: 0.07 });
  present(`out ${Math.round(t * 100)}%`, 'the trailing edge eats forward, in the direction the head went');
}

section('THE GRAIN IS A WORLD SIZE — <span>a big ring has more lobes, not bigger ones</span>', 3);
// Radii chosen so the smallest is still MEASURABLE. A 1-unit ring is sixty
// pixels across in this frame and its band is a few pixels thick, so the
// readback's own antialias jitter counts as more lobes than the noise puts
// there — the first run of this page read 23 lobes on it against a theoretical
// 3, and would have "passed" a UV-locked field on the strength of that noise.
// SAMPLED AT A CONSTANT DENSITY PER WORLD UNIT OF CIRCUMFERENCE, not at a
// constant number of rays. A fixed ray count measures a small ring at a finer
// angular resolution in world terms, so it resolves more of fbm's high octaves
// and counts them as lobes — which biases the count UP exactly where the
// hypothesis predicts it should be low. The first run of this check read 14.5
// lobes at r3 against 15.0 at r4.8 and passed on that artifact alone.
const RAYS_PER_UNIT = 8;
const grainProfiles = [];
for (const r of [1.6, 3, 4.8]) {
  draw({ type: 'kinetic', radius: r, time: 4, thickness: 0.07 });
  const rays = Math.round(2 * Math.PI * r * RAYS_PER_UNIT);
  grainProfiles.push({ r, rays, p: radialProfile(grab(), rays) });
  present(`radius ${r}`, `same noise cells, more of them around the edge — ${rays} rays`);
}

section('THE MARK — <span>the bracket keeps its gaps, and wears the target\'s status</span>', 4);
for (const [type, label] of [
  [null, 'plain lock — nothing on the target yet'],
  ['venom', 'poisoned: the arms sag and run'],
  ['chill', 'chilled: the arms go crystalline'],
  ['infection', 'infected'],
]) {
  draw({
    type: type ?? 'kinetic',
    color: type ? null : (CONFIG.strike.mark.ring.color),
    radius: 2.6,
    arcs: 4,
    thickness: CONFIG.strike.mark.ring.thickness,
    time: 3,
  });
  present(type ?? 'unstatused', label, type === null);
}

// ============================================================================
// THE MEASUREMENTS
// ============================================================================

section('MEASURED — <span>the things a still frame cannot tell you</span>', 1);

// --- the boundary is bounded ------------------------------------------------
{
  const R = 3.4;
  let worst = 0;
  let worstType = '';
  for (const type of ATTACK_IDS) {
    for (const time of [0, 0.7, 2.5, 6.1]) {
      draw({ type, radius: R, time, charge: 1 });
      const p = radialProfile(grab(), 128);
      for (const v of p) if (v > worst) { worst = v; worstType = type; }
    }
  }
  // The cap the shader clamps against, plus the band riding on it and a pixel
  // of antialias. Anything past this is the ring promising reach it has not
  // got.
  const cap = R * (1 + c.wobbleMax) + 2 / PX;
  check('no dialect ever draws past the wobble cap',
    worst <= cap, `worst ${worst.toFixed(2)}u (${worstType}) against a ${cap.toFixed(2)}u ceiling on a ${R}u ring`);
  // And the other half: an edge that only ever pulled inward would be honest
  // and would not be what was asked for.
  check('...and it does genuinely displace outward, not just inward',
    worst > R * 1.01, `${((worst / R - 1) * 100).toFixed(1)}% past the true radius`);
}

// --- the hand closes --------------------------------------------------------
{
  draw({ type: 'kinetic', radius: 3.4, sweepIn: 0, time: 1 });
  const closed = radialProfile(grab(), 96);
  check('at the start of the sweep the ring draws nothing at all',
    closed.every((v) => v === 0), `${closed.filter((v) => v > 0).length}/96 rays lit`);

  let worstGap = 0;
  for (const type of ATTACK_IDS) {
    draw({ type, radius: 3.4, sweepIn: 1, time: 2.2 });
    const p = radialProfile(grab(), 96);
    const dark = p.filter((v) => v === 0).length;
    if (dark > worstGap) worstGap = dark;
  }
  check('at the end of it every ray out of the centre finds paint',
    worstGap === 0, worstGap ? `${worstGap}/96 rays dark` : 'closed on all 8 dialects');

  // Monotonic: the hand only ever adds. A sweep that went backwards anywhere
  // would read as the tell being interrupted and restarting.
  let lit = -1;
  let monotonic = true;
  for (let i = 0; i <= 10; i++) {
    draw({ type: 'kinetic', radius: 3.4, sweepIn: i / 10, time: 1 });
    const n = radialProfile(grab(), 96).filter((v) => v > 0).length;
    if (n < lit - 2) monotonic = false; // 2 rays of slack for the ragged edge
    lit = Math.max(lit, n);
  }
  check('...and it never goes backwards on the way there', monotonic);
}

// --- the grain -------------------------------------------------------------
{
  const lens = grainProfiles.map((g) => ({
    r: g.r, len: correlationLength(g.p, RAYS_PER_UNIT),
  }));
  const small = lens[0];
  const big = lens[lens.length - 1];
  const drift = big.len / Math.max(0.0001, small.len);
  const sizeRatio = big.r / small.r;
  // The falsification. Under a UV-locked field this ratio would be the radius
  // ratio (3x here); under a world-fixed one it is 1.
  check('the wobble decorrelates over the same WORLD distance at every radius',
    drift > 0.6 && drift < 1.7,
    lens.map((l) => `r${l.r}: ${l.len.toFixed(2)}u`).join(', ')
      + ` (x${drift.toFixed(2)} across a x${sizeRatio.toFixed(1)} radius range)`);

  // And the absolute value, which pins the GRAIN SIZE rather than just its
  // constancy: the field's own cell is 1/noiseScale world units across, and the
  // profile should stop resembling itself somewhere around there. Wide bounds —
  // fbm stacks three octaves and the correlation is dominated by the first —
  // but wrong by an order of magnitude is what a mis-scaled field looks like.
  const cell = 1 / c.noiseScale;
  check('...and that distance is about one noise cell',
    big.len > cell * 0.25 && big.len < cell * 2.5,
    `${big.len.toFixed(2)}u against a ${cell.toFixed(2)}u cell`);
}

// --- electric holds ---------------------------------------------------------
{
  const rate = c.elecRate;                 // node re-rolls per second
  const holdFor = 1 / (rate * (0.6 + 0.8)); // the step at full charge
  const at = (t) => {
    draw({ type: 'electric', radius: 3.4, time: t, charge: 1 });
    return radialProfile(grab(), 128);
  };
  const diff = (a, b) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d / a.length;
  };
  const base = at(2.0);
  const nudged = at(2.0 + holdFor * 0.1);   // well inside one step
  const later = at(2.0 + holdFor * 3.5);    // several steps on
  const held = diff(base, nudged);
  const moved = diff(base, later);
  check('the electric jags HOLD inside a step rather than jittering per frame',
    held < 0.01, `${held.toFixed(4)}u of movement across a tenth of a step`);
  check('...and re-roll once the step turns over',
    moved > held * 5 && moved > 0.02, `${moved.toFixed(3)}u across three and a half steps`);

  // The wrap. Without the mod in the shader, node 0 and node uElecNodes are
  // different random numbers and the ring carries a permanent seam at three
  // o'clock — which looks exactly like a deliberate gap.
  const p = at(2.0);
  const n = p.length;
  const jumps = [];
  for (let i = 0; i < n; i++) jumps.push(Math.abs(p[(i + 1) % n] - p[i]));
  const atSeam = jumps[n - 1];
  const typical = [...jumps].sort((x, y) => x - y)[Math.floor(n * 0.9)];
  check('...with no seam where the spline wraps',
    atSeam <= Math.max(typical * 1.5, 0.05),
    `${atSeam.toFixed(3)}u at the wrap against a ${typical.toFixed(3)}u 90th percentile`);
}

// --- the chill facets sit inside the promise --------------------------------
{
  const R = 3.4;
  draw({ type: 'chill', radius: R, time: 2.5 });
  const p = radialProfile(grab(), 192);
  const inside = [...p].filter((v) => v > 0 && v < R).length;
  const lit = p.filter((v) => v > 0).length;
  // A polygon on an incircle spends most of its perimeter inside the circle and
  // only its corners outside it. If that ever inverted, the one dialect chosen
  // for being honest about reach would be the least honest one on the page.
  check('the chill polygon spends most of its edge INSIDE the true radius',
    inside > lit * 0.5, `${inside}/${lit} sampled rays land short of ${R}u`);
}

// --- the shader compiled ----------------------------------------------------
section('THE PROGRAM', 1);
check('the shader compiled — every panel above is a real draw',
  shaderErrors.length === 0, shaderErrors[0] ?? `${shotIndex} panels rendered`);

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nall good', fails ? 'bad' : 'ok');
document.title = fails ? `${fails} FAILED — organic ring` : 'ok — organic ring';
