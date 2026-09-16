// ---------------------------------------------------------------------------
// THE CORAL LAB — growing a species
//
//   npm run looks:coral
//
// systems/coralOrb.js grows a coral from a block of about fifteen numbers. Two
// pickups use it today (the fire-rate coral and the score coral) and a third is
// a block in config.js and no code at all — which is only true if there is
// somewhere to FIND the block. This is that place.
//
// WHY THIS EXISTS AS A PAGE RATHER THAN AS THE ` TUNER. The tuner is the right
// home for a look you judge in the game, on the object, while it is in the
// water. A grown shape is not that: the whole promise of this asset is that no
// two are alike, so what you have to judge is not one coral but a POPULATION —
// and you have to judge it against the other species, side by side, because
// "can you tell these two apart at the edge of vision" is a question about
// both. The tuner can show you one coral at a time and cannot show you either
// of those.
//
// WHAT IS ON THE PAGE
//
//   THE SHEET      Every species that ships, grown from a fixed set of seeds,
//                  as a contact sheet. Fixed seeds because the question is
//                  "does this species come out well USUALLY" and a fresh roll
//                  every reload answers a different question each time — the
//                  same reason the harnesses seed their RNG. Each row also
//                  reports what it MEASURED: segments, how much of the frame
//                  the silhouette fills, and how bright the tips get, so a
//                  species that has quietly grown too sparse to read, or too
//                  bright to hold a gradient, says so in numbers.
//   THE SILHOUETTE Every species again at PICKUP SIZE against the water,
//                  because a coral you have magnified eight times is a coral
//                  you cannot judge. This row is the actual read.
//   THE BENCH      One live specimen with a slider per number and a seed you
//                  can step. Drag, watch, then copy the block out of the box
//                  at the bottom and paste it into config.js.
//
// IT WRITES NOTHING. The CONFIG reads are from the live object of a throwaway
// bundle; there is no save path on this page and no dev server behind it, so
// nothing here can reach imported-tuning.json. The paste box is the save path,
// and it is deliberately manual: a shape block is a design decision, not a
// slider position. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import { growCoral, createCoralOrb, updateCoralOrb, CORAL_SPECIES, coralParams } from '../../path/src/systems/coralOrb.js';
import { updateBeatSync } from '../../path/src/systems/beatSync.js';

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
// console about it, so the page would look like a bad shape decision instead of
// a broken program. The coral's light is injected GLSL — see the note in
// tools/looks/pickups.js, which is the same trap.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 260;
const H = 260;
const DT = 1 / 60;
// THE MAGNIFYING GLASS, for the sheet. Sized against the coral's own `fit`
// (0.7 today) and not against the arena: the geometry normalises itself to fit
// before the asset's size multiplier is applied, so a view wide enough to hold
// a pickup at game scale renders the specimen as a speck a few pixels across
// and every measurement below reads a structure that is not on screen.
const VIEW = 1.05;
// ...and the honest one, for the silhouette row. The corals there are drawn at
// their assets.csv size (2.4x, ~1.7 units), and this is roughly what a 44-unit
// arena view gives one on a phone.
const REAL = 9;

// Seeds. FIXED, and the same set for every species, so two species on this
// page are being compared on the same rolls rather than on their luck.
const SEEDS = [11, 23, 47, 91, 137, 211];

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// The water they are actually drawn on. A coral over black flatters every
// choice below — a dim holdfast reads as shape against black and as nothing
// against blue, which is the one mistake this page exists to catch.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x14344a }),
);
water.position.z = -40;
scene.add(water);

const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -100, 100,
);
camera.position.set(0, 0, 20);
const realCam = new THREE.OrthographicCamera(
  -REAL * (W / H) / 2, REAL * (W / H) / 2, REAL / 2, -REAL / 2, -100, 100,
);
realCam.position.set(0, 0, 20);
let activeCam = camera;

const post = createPost(gl);
const draw = () => { post.resize(); post.render(scene, activeCam, DT); };
// A raw render, no post chain — everything MEASURED below reads off this.
// Bloom is a blur by design: measuring coverage through it hands back the size
// of the halo, and measuring brightness through it hands back the bloom's
// answer rather than the shader's.
const drawRaw = () => gl.render(scene, activeCam);

// A seeded RNG, so a shape on this page is a shape you can come back to.
// Mulberry32 — small, and good enough that two adjacent seeds do not grow
// visibly related corals, which a plain LCG's low bits will.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];
let row = null;
const sheet = document.getElementById('sheet');

function section(title, columns) {
  const h = document.createElement('h2');
  h.innerHTML = title;
  sheet.appendChild(h);
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  sheet.appendChild(row);
}

// --- measuring --------------------------------------------------------------
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });

/**
 * How much of the frame the coral covers, and whether it is still a GRADIENT —
 * both off a RAW render (see drawRaw).
 *
 * The water is subtracted rather than assumed away: this scene has a blue plane
 * behind everything, so "any pixel that is not black" would report 100% cover
 * on every panel. A pixel counts as coral when it is meaningfully brighter than
 * the water it sits on.
 *
 * NOT A PEAK BRIGHTNESS, which is the obvious measurement and a useless one
 * here. The tips are SUPPOSED to clip: the material is the tint multiplied by
 * `glow`, deliberately sized so the tips sit past the bloom threshold, so the
 * brightest pixel of a correctly tuned coral reads 100% and so does the
 * brightest pixel of one pushed until the whole structure is a flat blob.
 *
 * NOR THE SHARE OF THE AREA THAT CLIPS, on the widest channel, which was the
 * next thing tried and is wrong for a subtler reason. A yellow coral at glow
 * 2.2 has a red channel of 2.2 and a blue of 0.44: red and green clamp across
 * nearly the whole body, so `max(r, g, b)` reads 255 almost everywhere and
 * reports a perfectly good gradient as 60% clipped. The ramp is alive in
 * whichever channel still has headroom, and which one that is depends on the
 * hue.
 *
 * SO WHAT IS MEASURED IS THE SPREAD — the ratio of a bright percentile to a
 * dim one, in luminance, across the lit area. That is the gradient itself:
 * near 1 means the holdfast and the tips are the same brightness and the one
 * thing that makes this read as a living structure is gone, whatever channel
 * it went in. (Luminance is right HERE, where the question is one object's own
 * internal contrast — it is the wrong basis for equalising bloom BETWEEN two
 * hues, which is a different question with its own memory.)
 */
function measure() {
  drawRaw();
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  const { data } = pctx.getImageData(0, 0, probe.width, probe.height);
  const lum = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // Against the water's own value, not against black.
    const over = Math.max(r - 20, g - 52, b - 74);
    if (over <= 26) continue;
    lum.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  const total = probe.width * probe.height / 4;
  if (!lum.length) return { cover: 0, spread: 1, dim: 0, bright: 0 };
  lum.sort((a, b) => a - b);
  // PERCENTILES, not min and max. One antialiased edge pixel is the minimum of
  // every panel and one clipped tip is the maximum, so the extremes measure the
  // renderer's edges rather than the structure's ramp.
  const at = (q) => lum[Math.min(lum.length - 1, Math.floor(q * lum.length))];
  const dim = at(0.15);
  const bright = at(0.9);
  return {
    cover: lum.length / total,
    spread: bright / Math.max(1, dim),
    dim: dim / 255,
    bright: bright / 255,
  };
}

function present(title, note) {
  draw();
  const cell = document.createElement('div');
  cell.className = 'cell';
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
  cap.innerHTML = `<b>${title}</b><br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// Put one coral in the scene, settle its pulse, and hand it back. Everything on
// this page goes through here so that no panel can accidentally be looking at a
// coral built a different way from the one the game spawns.
let live = null;
function stage(species, seed, params = null, opts = {}) {
  if (live) {
    scene.remove(live);
    live.geometry.dispose();
    live.material.dispose();
  }
  live = createCoralOrb(seeded(seed), {
    species,
    assetKey: opts.assetKey ?? SPECIES_ASSET[species] ?? 'rapidFireOrb',
    params,
  });
  // Standing straight up for the sheet: the lean is a per-individual roll and
  // two corals at different leans cannot be compared for SHAPE. The silhouette
  // row below puts it back.
  if (opts.upright !== false) live.rotation.set(0, opts.turn ?? 0, 0);
  live.position.set(0, 0, 0);
  if (opts.scale) live.scale.multiplyScalar(opts.scale);
  scene.add(live);
  // A few frames of its own clock so the pulse is somewhere sensible rather
  // than at phase 0, which is the one moment every coral looks identical.
  for (let i = 0; i < 14; i++) {
    updateBeatSync(DT);
    updateCoralOrb(live, DT, DT);
  }
  return live;
}

// Which assets.csv row each species hangs its tint and size on. Here rather
// than in coralOrb.js because it is a fact about the two PICKUPS, and the
// module deliberately takes the key as an argument so a species is not forced
// to have one.
const SPECIES_ASSET = { rapidFire: 'rapidFireOrb', score: 'scoreOrb' };
const SPECIES_LABEL = { rapidFire: 'fire rate (the open fan)', score: 'score (the dense head)' };

// --- what has to be true ----------------------------------------------------
log('CORAL LAB — every species that ships, grown from fixed seeds.');
log('');

const species = Object.keys(CORAL_SPECIES);
check('every species resolves a block of numbers',
  species.every((s) => Object.keys(coralParams(s)).length > 6),
  species.map((s) => `${s}: ${Object.keys(coralParams(s)).length} numbers`).join(', '));

// The one that would render a perfect-looking page and be wrong: if any helper
// in coralOrb.js still reached for the fire-rate coral's block, two species
// from the same seed would come out as the same object.
{
  const counts = species.map((s) => growCoral(seeded(SEEDS[0]), coralParams(s)).attributes.position.count);
  check('...and no two species grow the same coral from the same seed',
    new Set(counts).size === counts.length,
    species.map((s, i) => `${s}: ${counts[i]} verts`).join(', '));
}

// --- the sheets -------------------------------------------------------------
for (const s of species) {
  const p = coralParams(s);
  section(`${s} <span>— ${SPECIES_LABEL[s] ?? ''}, magnified, six fixed seeds</span>`, 3);
  activeCam = camera;
  let coverSum = 0;
  let spreadSum = 0;
  for (const seed of SEEDS) {
    const mesh = stage(s, seed);
    const verts = mesh.geometry.attributes.position.count;
    const m = measure();
    coverSum += m.cover;
    spreadSum += m.spread;
    present(`${s} ${seed}`,
      `${verts} verts · ${(m.cover * 100).toFixed(1)}% of frame · base-to-tip ${m.spread.toFixed(2)}x`);
  }
  const cover = coverSum / SEEDS.length;
  const spread = spreadSum / SEEDS.length;
  // A SILHOUETTE HAS TO EXIST. The specimen is normalised to `fit` and the
  // frame is sized against it, so a coral made of real branches covers a good
  // share of the panel — under about 8% the structure is a scatter of dashes
  // rather than an organism, which is usually a `depth` raised without cutting
  // `lengthFall`, shrunk by `fit` until the branches vanish.
  check(`${s}: it fills enough of the frame to have a shape`, cover > 0.08,
    `${(cover * 100).toFixed(1)}% mean cover across ${SEEDS.length} seeds`);
  // AND IT HAS TO STILL BE A GRADIENT — see the note on measure(). A coral lit
  // evenly is a neon sign, and one lit only at the very tips is a scatter of
  // sparks with no body under it.
  check(`${s}: it is still a gradient from holdfast to tips`,
    spread > 1.25,
    `the bright end is ${spread.toFixed(2)}x the dim end (glow ${p.glow}, restFloor ${p.restFloor})`);
}

// --- the silhouette row -----------------------------------------------------
// THE ACTUAL READ. Everything above is magnified eight times; this is the size
// the player sees, with the lean the spawner gives it. Two species next to each
// other at this size is the question the whole design rests on.
// ...AND EACH ONE TWICE, FACING AND EDGE ON. `flatten` pulls the branch fan
// toward the camera's plane, and the coral then TURNS about its own vertical
// axis all run (`spin`) — so every coral in the water passes through edge on,
// where a flattened fan is a vertical sliver a few pixels wide. That is not a
// bug and it is not avoidable by tuning `flatten` (the flatter it is, the
// thinner the edge), but it IS the worst frame of the pickup and it belongs on
// the page: if a species is unreadable there, the answer is a lower `flatten`
// trading some of the face-on spread for a body that survives the turn.
section('at pickup size <span>— against the water, at the two extremes of its own turn</span>', 4);
activeCam = realCam;
for (const s of species) {
  for (const [turn, label] of [[0, 'facing'], [Math.PI / 2, 'edge on, mid-turn']]) {
    const mesh = stage(s, SEEDS[0], null, { turn, scale: 2.4 });
    // The lean the spawner rolls, so this is the object as it hangs.
    mesh.rotation.z = (seeded(SEEDS[0] + 7)() - 0.5) * 0.5;
    present(`${s} ${label}`, `${SPECIES_LABEL[s] ?? ''} · flatten ${coralParams(s).flatten}`);
  }
}
// MEASURED, because "unreadable edge on" is a number. The thin side of a
// flattened fan is what the eye has to find for part of every rotation, and a
// species whose edge-on cover is a fraction of its face-on cover is a pickup
// that blinks out of existence twice a turn.
for (const s of species) {
  stage(s, SEEDS[0], null, { turn: 0, scale: 2.4 });
  const facing = measure().cover;
  stage(s, SEEDS[0], null, { turn: Math.PI / 2, scale: 2.4 });
  const edge = measure().cover;
  check(`${s}: it is still there when the turn takes it edge on`,
    edge > facing * 0.25,
    `${(edge * 100).toFixed(2)}% of frame edge on vs ${(facing * 100).toFixed(2)}% facing (flatten ${coralParams(s).flatten})`);
}

check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
log('');
log(fails ? `${fails} failing` : 'all passing', fails ? 'bad' : 'ok');

// ---------------------------------------------------------------------------
// THE BENCH
// ---------------------------------------------------------------------------
// One live specimen and a slider per number. The bench edits a COPY of the
// species block — never CONFIG — so dragging here cannot change what the sheets
// above measured, and cannot be mistaken for a saved tuning value.
//
// Every knob is listed explicitly rather than derived from the block's keys.
// Derived would be shorter and would also silently give `color` a 0..1 slider
// and `pulseSync` a numeric one, and would drop any number the current species
// happens not to have set — the union of what a coral CAN be told is the thing
// worth showing, not the intersection of what two of them happen to say.
const KNOBS = [
  ['depth', 1, 8, 1, 'generations'],
  ['maxSegments', 4, 260, 1, 'segment cap'],
  ['sides', 3, 12, 1, 'sides per branch'],
  ['length', 0.05, 1.2, 0.01, 'first stalk length'],
  ['radius', 0.01, 0.3, 0.005, 'first stalk radius'],
  ['lengthFall', 0.3, 1, 0.01, 'branch shortening'],
  ['radiusFall', 0.3, 1, 0.01, 'branch thinning'],
  ['taper', 0.2, 1, 0.01, 'narrowing along a branch'],
  ['spread', 0, 2, 0.02, 'how wide it forks'],
  ['bend', 0, 1.2, 0.02, 'branch curve'],
  ['singleChance', 0, 0.6, 0.01, 'chance of plain stalk'],
  ['tripleAbove', 0.1, 0.95, 0.01, 'bushiness (lower = more 3-way)'],
  ['fanJitter', 0, 2, 0.05, 'fork roll'],
  ['centreTilt', 0, 1, 0.05, 'lean of the middle branch'],
  ['flatten', 0, 1, 0.05, 'pulled into the camera plane'],
  ['fit', 0.2, 3, 0.05, 'size before assets.csv'],
  ['glow', 0, 6, 0.05, 'brightness'],
  ['restFloor', 0, 1, 0.01, 'how lit the base is'],
  ['waveTravel', 0, 2, 0.05, 'how much one wave spans'],
  ['waveSharp', 0.5, 12, 0.1, 'how tight the wave front is'],
  ['pulseGlow', 0, 8, 0.1, 'wave brightness at the tips'],
  ['spin', 0, 3, 0.05, 'turn (rad/s)'],
  ['bob', 0, 0.8, 0.01, 'nod'],
  ['bobRate', 0, 3, 0.05, 'nod rate'],
];

const benchCanvas = document.createElement('canvas');
benchCanvas.width = W * 2;
benchCanvas.height = H * 2;
benchCanvas.style.width = '100%';
document.getElementById('stage').appendChild(benchCanvas);
const bctx = benchCanvas.getContext('2d');

let benchSpecies = species[0];
let benchSeed = SEEDS[0];
let bench = { ...coralParams(benchSpecies) };
let benchMesh = null;

function regrow() {
  if (benchMesh) {
    scene.remove(benchMesh);
    benchMesh.geometry.dispose();
    benchMesh.material.dispose();
  }
  benchMesh = createCoralOrb(seeded(benchSeed), {
    species: benchSpecies,
    assetKey: SPECIES_ASSET[benchSpecies] ?? 'rapidFireOrb',
    // The bench's own copy, so nothing here writes CONFIG.
    params: bench,
  });
  benchMesh.rotation.set(0, 0, 0);
  scene.add(benchMesh);
  writeOut();
}

// The block, formatted the way it is written in config.js so it can go
// straight in. Only the numbers this page owns — the colour and the beat
// division are not sliders here (a hue picker and a division are the ` tuner's
// job, and both land on the live object rather than at the next spawn).
function writeOut() {
  const lines = KNOBS
    .filter(([k]) => bench[k] !== undefined)
    .map(([k]) => `      ${k}: ${Number(bench[k].toFixed(4))},`);
  document.getElementById('out').textContent =
    `    // ${benchSpecies}, off the bench (seed ${benchSeed})\n    coral: {\n${lines.join('\n')}\n    },`;
}

const knobs = document.getElementById('knobs');
function buildKnobs() {
  knobs.innerHTML = '';
  for (const [key, min, max, step, label] of KNOBS) {
    if (bench[key] === undefined) continue;
    const wrap = document.createElement('div');
    wrap.className = 'knob';
    const l = document.createElement('label');
    l.textContent = label;
    l.title = key;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = bench[key];
    const out = document.createElement('output');
    out.textContent = bench[key];
    input.addEventListener('input', () => {
      bench[key] = Number(input.value);
      out.textContent = input.value;
      regrow();
    });
    wrap.append(l, input, out);
    knobs.appendChild(wrap);
  }
}

const bar = document.getElementById('bar');
{
  const pick = document.createElement('select');
  for (const s of species) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = `${s} — ${SPECIES_LABEL[s] ?? ''}`;
    pick.appendChild(o);
  }
  pick.addEventListener('change', () => {
    benchSpecies = pick.value;
    bench = { ...coralParams(benchSpecies) };
    buildKnobs();
    regrow();
  });
  const next = document.createElement('button');
  next.textContent = 'next seed';
  next.addEventListener('click', () => { benchSeed = (benchSeed * 31 + 17) % 100000; regrow(); });
  const reset = document.createElement('button');
  reset.textContent = 'back to the shipped numbers';
  reset.addEventListener('click', () => {
    bench = { ...coralParams(benchSpecies) };
    buildKnobs();
    regrow();
  });
  const copy = document.createElement('button');
  copy.textContent = 'copy the block';
  copy.addEventListener('click', () => {
    navigator.clipboard?.writeText(document.getElementById('out').textContent);
    copy.textContent = 'copied';
    setTimeout(() => { copy.textContent = 'copy the block'; }, 1200);
  });
  bar.append(pick, next, reset, copy);
}

buildKnobs();
regrow();

// The bench runs on its own loop so the pulse and the turn are live — the
// sheets above are stills, and a wave travelling out along the branches is
// half of what these numbers do.
//
// The Browser pane suspends rAF, so this loop is the one part of the page that
// will not run there; the sheets and the checks above are stills and PNGs on
// purpose, and they are the half that has to survive being looked at through a
// screenshot. See SERVERS.md and the memory on rAF in the pane.
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  updateBeatSync(dt);
  if (benchMesh) {
    // The sheets share this scene, so anything they left in it has to be gone
    // before the bench draws — otherwise the last sheet coral sits inside the
    // specimen forever.
    if (live) { scene.remove(live); live = null; }
    updateCoralOrb(benchMesh, dt, dt);
    activeCam = camera;
    post.resize();
    post.render(scene, activeCam, dt);
    bctx.fillStyle = '#04070e';
    bctx.fillRect(0, 0, benchCanvas.width, benchCanvas.height);
    bctx.drawImage(gl.domElement, 0, 0);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// The same close-out every other look page uses: the title carries the verdict
// so a runner watching the tab knows without reading the log.
check('every panel rendered', shotIndex > 0, `${shotIndex} panels`);
Promise.all(posted).then(() => {
  log(`\n${fails === 0 ? 'All good.' : `${fails} failure(s).`}`, fails === 0 ? 'ok' : 'bad');
  document.title = fails === 0 ? 'coral lab — ok' : `coral lab — ${fails} FAIL`;
});
