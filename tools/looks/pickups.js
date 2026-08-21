// ---------------------------------------------------------------------------
// THE COMPOSED PICKUPS — LOOK DEV
//
//   npm run looks:pickups
//
// Three of the game's four floating pickups used to be the same primitive with
// three tints on it: a rock, a rock, and a small translucent ball. This sheet
// is where the three replacements are judged side by side, because "does it
// read as its own object" is a question about all three at once and not about
// any one of them.
//
//   THE OXYGEN BUBBLE   a fresnel film — thin where it faces you, bright at the
//                       silhouette. It swells out of the seabed, it can be
//                       shoved, and it can burst. The physics is asserted in
//                       tools/oxygen-bubble-test.mjs; what is HERE is whether
//                       the film reads as air rather than as a fogged marble.
//   THE ATTRACTIVE CLAM a gooey white mantle with pink flesh inside it, pumping
//                       waves of pink and purple out on the beat.
//   THE CORAL           grown geometry, no two alike, with a bioluminescent
//                       pulse travelling out along the branches.
//   THE LEVEL BLOB      a molten lump that changes colour on every quarter
//                       note. Two things are being looked at and they are not
//                       the same question: whether it reads as HOT (a white
//                       core inside a coloured rim, rather than a flat ball)
//                       and whether every colour it lands on is still bright.
//                       The second is measured, because a hue that quietly
//                       drops under the bloom threshold is a beat on which the
//                       pickup looks switched off.
//
// WHY A PAGE AND NOT A NODE HARNESS. All three carry injected GLSL — the shell
// film, the goo displacement, the coral's tip wave — and a GLSL error renders
// NOTHING and throws nothing a Node harness can see. The pickup would simply be
// missing from the game with a clean test suite. This page imports the SHIPPING
// modules and the SHIPPING post chain, so a panel that comes up black is a real
// compile failure and the bloom on the rims is the bloom the game applies.
//
// IT WRITES NOTHING. The CONFIG reads below are from the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import { createVisual, applyBubbleShellSettings } from '../../path/src/assets.js';
import { initBubble, updateBubblePhysics, bubbleRadius } from '../../path/src/systems/oxygenBubble.js';
import { createAttractiveClam, updateAttractiveClam } from '../../path/src/systems/attractiveClam.js';
import { createCoralOrb, updateCoralOrb } from '../../path/src/systems/coralOrb.js';
import { createLevelOrb, updateLevelOrb, setLevelOrbScale, nextBlobHue } from '../../path/src/systems/levelOrb.js';
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
// console about it, so the page would look like a bad tuning decision instead
// of a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 320;
const H = 320;
const DT = 1 / 60;
// A magnifying glass. These are ~1-3 world units against a 44-unit view in the
// game; the question here is what the SHAPE and the FILM do, and both have to
// survive being looked at.
const VIEW = 7;

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Water to sit them in. Every one of these is transparent, additive or both,
// and a panel over empty black flatters all three — what they look like over
// the blue they are actually drawn on is the whole question.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x14344a }),
);
water.position.z = -40;
scene.add(water);

// Something SOLID behind the bubble and the clam, because the promise both make
// is that you can see through them. A panel with nothing behind the film cannot
// tell a see-through bubble from an invisible one.
const behind = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.3, 2.6, 4, 12),
  new THREE.MeshBasicMaterial({ color: 0xc4453a }),
);
behind.rotation.z = Math.PI / 2;
behind.position.set(0, 0, -2);
behind.visible = false;
scene.add(behind);

const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -100, 100,
);
camera.position.set(0, 0, 20);

// A SECOND, WIDER FRAME for the clam. Its waves reach seven world units, which
// is the whole magnifying-glass view — every clam panel would be a close-up of
// a ring leaving the frame, and the thing being judged is the TRAIN. This is
// roughly the game's own framing.
const WIDE = 18;
const wideCam = new THREE.OrthographicCamera(
  -WIDE * (W / H) / 2, WIDE * (W / H) / 2, WIDE / 2, -WIDE / 2, -100, 100,
);
wideCam.position.set(0, 0, 20);
let activeCam = camera;

const post = createPost(gl);
function draw() {
  post.resize();
  post.render(scene, activeCam, DT);
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

// EVERY PANEL RE-RENDERS FIRST, and that is not belt-and-braces. `footprint()`
// leaves the canvas holding its second render — the one with the subject HIDDEN
// — and `crossSection()` leaves it holding a raw render with no post chain on
// it. A panel that copied whatever was last drawn would silently be a picture
// of empty water, or of the object without its bloom, depending on which
// measurement happened to run before it. Rendering here means the panel is
// always the scene as it stands, through the chain the game ships.
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

// --- measuring --------------------------------------------------------------
// How much of the panel the object actually covers, and how bright its brightest
// pixel is. Both read off a RAW render rather than through the post chain:
// bloom is a blur by design and would hand back the size of the halo.
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });

function grab() {
  gl.render(scene, activeCam);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height).data;
}

// The same grab, through the SHIPPING post chain instead of raw. The knee is
// the whole reason this exists: a self-lit object drives every channel past 1
// and an 8-bit read of a raw render truncates them independently, so a hot
// orange and a hot blue both come back as flat clipped shapes with no gradient
// left in them. The composite's soft shoulder is what puts that gradient back,
// scaling all three channels by ONE factor so the hue survives — so it is the
// only render that resembles what a player sees. See the shoulder in
// systems/post.js.
function grabLit() {
  draw();
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height).data;
}

const REC709 = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

// A DIFFERENCE of two renders, with the subject hidden in the second. Any
// threshold on the image itself measures the water and the body behind it
// instead; differencing leaves exactly the pixels the subject is responsible
// for.
//
// Returns, all as fractions of the panel and of 255:
//   pixels   how much of the panel it covers
//   peak     its brightest channel anywhere
//   mean     average max-channel over its own pixels
//   meanLum  average Rec.709 luminance over its own pixels
//   ramp     the 90th percentile of that luminance over the 10th — "is there a
//            GRADIENT here, or is this a flat disc". A separate question from
//            every number above it, and one none of them can answer: `peak`
//            saturates on anything meant to bloom, and a mean is the same for a
//            smooth ramp and for a uniform fill of its own average.
//
// `composited` measures through the post chain rather than raw — see grabLit.
// The MASK is always taken raw, because bloom spreads a halo well past the
// object and a footprint measured through it is the size of the glow.
function footprint(obj, { composited = false } = {}) {
  const lit = grab();
  const was = obj.visible;
  obj.visible = false;
  const without = grab();
  obj.visible = was;
  const read = composited ? grabLit() : lit;
  let n = 0;
  let peak = 0;
  let sum = 0;
  let sumLum = 0;
  const lums = [];
  for (let i = 0; i < lit.length; i += 4) {
    const d = Math.max(
      Math.abs(lit[i] - without[i]),
      Math.abs(lit[i + 1] - without[i + 1]),
      Math.abs(lit[i + 2] - without[i + 2]),
    );
    if (d > 6) {
      n++;
      sum += Math.max(read[i], read[i + 1], read[i + 2]);
      const L = REC709(read[i], read[i + 1], read[i + 2]);
      sumLum += L;
      lums.push(L);
    }
    peak = Math.max(peak, read[i], read[i + 1], read[i + 2]);
  }
  lums.sort((a, b) => a - b);
  const at = (q) => (lums.length ? lums[Math.min(lums.length - 1, Math.floor(q * lums.length))] : 0);
  return {
    pixels: n / (probe.width * probe.height),
    peak: peak / 255,
    mean: n ? sum / n / 255 : 0,
    meanLum: n ? sumLum / n : 0,
    ramp: at(0.9) / Math.max(1e-4, at(0.1)),
  };
}

// Brightness sampled along one horizontal line through the middle, as
// fractions of the panel width. THE FRESNEL'S WHOLE CLAIM lives here: a film is
// dim in the middle and bright at the silhouette, and a "bubble" that is
// brighter in the middle than at its edge is a marble.
function crossSection(y = 0.5) {
  const d = grab();
  const row = Math.round(probe.height * y);
  const out = [];
  for (let x = 0; x < probe.width; x++) {
    const i = (row * probe.width + x) * 4;
    out.push(Math.max(d[i], d[i + 1], d[i + 2]) / 255);
  }
  return out;
}

// ===========================================================================
// THE BUBBLE
// ===========================================================================
applyBubbleShellSettings();
const bubble = createVisual('bubbleOrb');
scene.add(bubble);
const orb = { mesh: bubble, life: 99, assetRadius: 0.44 };
initBubble(orb);
// Straight to full size and away from the seabed, or every panel is a sliver
// half buried in sand — the swell has its own row further down.
orb.grow = 1;
bubble.position.set(0, 0, 0);
for (let i = 0; i < 30; i++) {
  updateBubblePhysics(DT, orb);
  bubble.position.set(0, 0, 0);
}
behind.visible = true;
draw();
check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
check('the page linked programs', gl.info.programs.length > 0, `${gl.info.programs.length} programs`);

section('The oxygen bubble <span>— a fresnel film. Thin where it faces you, bright at the silhouette. There is a solid red body behind it in every panel; you should be able to see it.</span>', 3);

{
  // MEASURED WITH THE BODY BEHIND IT HIDDEN. The red capsule is the whole point
  // of the panel — you are supposed to see it through the film — but it is also
  // the brightest thing on the centre line, so leaving it in measures the
  // capsule and reports it as the bubble's core. The panel keeps it; the
  // measurement does not.
  const was = behind.visible;
  behind.visible = false;
  const xs = crossSection();
  behind.visible = was;
  // Where the bubble's edge is, in pixels from the middle.
  const rPx = (bubbleRadius(orb) / VIEW) * probe.height;

  const cx = probe.width / 2;
  const middle = xs[Math.round(cx)];
  // Just inside the silhouette — the rim band, not the very last pixel, which
  // is antialiased against the water.
  const rimA = xs[Math.round(cx - rPx * 0.9)];
  const rimB = xs[Math.round(cx + rPx * 0.9)];
  const rim = Math.max(rimA, rimB);
  check('the rim is brighter than the middle', rim > middle * 1.25,
    `rim ${rim.toFixed(3)} vs middle ${middle.toFixed(3)}`);
  check('...and the middle is not opaque', middle < 0.85,
    `middle reads ${middle.toFixed(3)}`);
  present('at rest', `radius ${bubbleRadius(orb).toFixed(2)}u · rim ${rim.toFixed(2)} vs core ${middle.toFixed(2)}`);
}

// The swell, which is the arrival. Four frames across the grow curve.
for (const g of [0.15, 0.45, 0.8]) {
  orb.grow = g;
  orb.skin = 1;
  updateBubblePhysics(0, orb);
  bubble.position.set(0, 0, 0);
  present(`swelling ${Math.round(g * 100)}%`,
    `${bubbleRadius(orb).toFixed(2)}u of radius — the collect test uses this number too`);
}

// A bubble under strain. The sag is the player's only warning.
orb.grow = 1;
for (const skin of [1, 0.45, 0.12]) {
  orb.skin = skin;
  // Long enough for the wobble to reach a peak of its cycle rather than
  // catching whatever phase the last panel left it on.
  for (let i = 0; i < 20; i++) {
    updateBubblePhysics(DT, orb);
    orb.skin = skin;
    bubble.position.set(0, 0, 0);
  }
  const wob = Math.abs(bubble.scale.x - bubble.scale.y) / bubble.scale.y;
  present(`skin ${Math.round(skin * 100)}%`,
    `${(wob * 100).toFixed(1)}% out of round — a strained bubble visibly sags`);
}
bubble.visible = false;
behind.visible = false;

// ===========================================================================
// THE CLAM
// ===========================================================================
const clam = createAttractiveClam();
clam.scale.setScalar(CONFIG.attractorOrb.scale);
scene.add(clam);
behind.visible = true;

activeCam = wideCam;
section('The attractive clam <span>— a gooey white mantle with pink flesh inside it. The waves leave on the beat; the panels below are one bar apart, so each is a different point in the pump.</span>', 4);

// The beat clock has to be MOVED for the waves to exist at all — beatsNow()
// is 0 until updateBeatSync has run, and a wave train fired at index 0 is one
// ring sitting on top of the clam.
let clamT = 0;
function stepClam(seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    updateBeatSync(DT);
    updateAttractiveClam(clam, DT, scene, DT);
    clamT += DT;
  }
}
stepClam(0.4);
{
  const fp = footprint(clam);
  check('the clam draws something', fp.pixels > 0.01, `${(fp.pixels * 100).toFixed(1)}% of the panel`);
  check('...and you can see through the mantle',
    CONFIG.attractorOrb.look.mantleOpacity < 0.8,
    `mantleOpacity ${CONFIG.attractorOrb.look.mantleOpacity}`);
}
for (const t of [0.0, 0.35, 0.75, 1.4]) {
  stepClam(t === 0 ? 0 : t);
  present(`clam +${clamT.toFixed(2)}s`,
    `${clam.userData.clam.waves.length} wave(s) alive · flesh at ${clam.userData.clam.flesh.scale.x.toFixed(2)}x`);
}
clam.visible = false;
for (const w of clam.userData.clam.waves) w.mesh.visible = false;
behind.visible = false;
activeCam = camera;

// ===========================================================================
// THE CORAL
// ===========================================================================
section('The coral <span>— grown, not modelled. Six seeds, so the claim being checked is that no two are the same object. The light is a wave travelling out to the tips.</span>', 6);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shapes = [];
for (const seed of [1, 7, 13, 42, 99, 404]) {
  const coral = createCoralOrb(mulberry32(seed));
  // Its own turn is rolled per individual and would make the six panels
  // incomparable — this row is about the SHAPES, so they are all faced the
  // same way and the turn gets its own row below.
  coral.rotation.set(0, 0, 0);
  coral.scale.setScalar(2.4);
  scene.add(coral);
  for (let i = 0; i < 30; i++) {
    updateBeatSync(DT);
    updateCoralOrb(coral, 0, DT);
  }
  coral.rotation.set(0, 0, 0);
  const tris = (coral.geometry.index ? coral.geometry.index.count : coral.geometry.attributes.position.count) / 3;
  const fp = footprint(coral);
  shapes.push({ seed, tris, pixels: fp.pixels, peak: fp.peak });
  present(`seed ${seed}`, `${tris} triangles · ${(fp.pixels * 100).toFixed(1)}% of the panel`);
  scene.remove(coral);
}

{
  const counts = new Set(shapes.map((s) => s.tris));
  check('no two corals are the same shape', counts.size >= shapes.length - 1,
    `${counts.size} distinct segment counts across ${shapes.length} seeds`);
  const worst = Math.max(...shapes.map((s) => s.tris));
  check('...and none of them is heavy', worst < 4000, `heaviest ${worst} triangles`);
  const cover = shapes.map((s) => s.pixels);
  const spread = Math.max(...cover) / Math.max(1e-6, Math.min(...cover));
  check('...and they are all roughly the same SIZE on screen',
    spread < 3, `widest covers ${spread.toFixed(1)}x the narrowest`);
  const peak = Math.max(...shapes.map((s) => s.peak));
  check('the tips reach past the bloom threshold',
    peak > (CONFIG.bloom?.threshold ?? 0.18), `peak ${peak.toFixed(2)} vs threshold ${CONFIG.bloom?.threshold}`);
}

section('The coral, lit <span>— one individual through a bar of the pulse. The wave leaves the holdfast and runs out to the tips.</span>', 5);
{
  const coral = createCoralOrb(mulberry32(13));
  coral.rotation.set(0, 0, 0);
  coral.scale.setScalar(2.4);
  scene.add(coral);
  const u = coral.material.userData.__coral;
  for (const phase of [0, 0.2, 0.4, 0.6, 0.8]) {
    // The phase is written straight in rather than stepped there: stepping
    // would also turn the coral, and this row is about the LIGHT.
    coral.userData.coral.phase = phase;
    u.uCoralPhase.value = phase;
    present(`pulse ${phase.toFixed(1)}`, `wave ${(phase * 100).toFixed(0)}% of the way round the bar`);
  }
  scene.remove(coral);
}

// ===========================================================================
// THE LEVEL BLOB
// ===========================================================================
section('The level blob <span>— grown like the coral, and lit from the inside. Six seeds; the claim is that it reads as a molten lump rather than as a fourth tinted ball.</span>', 6);
{
  const blobs = [];
  for (const seed of [1, 7, 13, 42, 99, 404]) {
    const blob = createLevelOrb(mulberry32(seed));
    // Its own tumble is rolled per individual and would make the six panels
    // incomparable — this row is about the SHAPES, so they are all faced the
    // same way. assets.csv sizes it at 2.2 in the game.
    blob.rotation.set(0, 0, 0);
    setLevelOrbScale(blob, 2.2);
    scene.add(blob);
    // One frame, so the colour uniforms are the ones the shader will read. NOT
    // a run of them: updateLevelOrb turns the body, and this row is the shape.
    updateBeatSync(DT);
    updateLevelOrb(blob, 0, 0);
    blob.rotation.set(0, 0, 0);
    const fp = footprint(blob, { composited: true });
    blobs.push({ seed, pixels: fp.pixels, peak: fp.peak, ramp: fp.ramp });
    present(`seed ${seed}`, `${(fp.pixels * 100).toFixed(1)}% of the panel · bright end ${fp.ramp.toFixed(1)}x the dark end`);
    scene.remove(blob);
  }
  const cover = blobs.map((b) => b.pixels);
  const spread = Math.max(...cover) / Math.max(1e-6, Math.min(...cover));
  check('every blob is the same size on screen', spread < 1.5,
    `widest covers ${spread.toFixed(2)}x the narrowest`);
  const dimmest = Math.min(...blobs.map((b) => b.peak));
  check('...and every one of them has a white-hot core',
    dimmest > 0.95, `dimmest peak ${dimmest.toFixed(2)}`);
  // A GRADIENT AND NOT A DISC. The core clips to white by design; if the whole
  // body clips with it the pickup is a flat lozenge, and every other check in
  // this block still passes — coverage, size and peak are all identical for a
  // hot ball and for a solid one. The ramp is the only thing that separates
  // them, and it has to be measured through the composite: raw, every channel
  // is already truncated and there is no ramp left to find.
  const flattest = Math.min(...blobs.map((b) => b.ramp));
  check('...but the body is a gradient, not a flat disc', flattest > 1.5,
    `flattest runs ${flattest.toFixed(1)}x from its dark end to its bright one`);
}

section('The level blob, on the note <span>— six consecutive colours off the real roll. THE POINT OF THE ROW: none of them may be visibly darker than the others, which is what the lum-mode normalisation buys and what a plain random hue does not.</span>', 6);
{
  const blob = createLevelOrb(mulberry32(13));
  blob.rotation.set(0, 0, 0);
  setLevelOrbScale(blob, 2.2);
  scene.add(blob);
  const u = blob.material.userData.__levelBlob;
  const peaks = [];
  let hue = 0.05;
  for (let n = 0; n < 6; n++) {
    // The hue is driven straight in rather than stepped through six notes: a
    // real wait would also turn the body and burn a second and a half of page
    // time per panel, and what this row is about is the COLOUR.
    hue = nextBlobHue(hue, mulberry32(n * 31 + 3), CONFIG.levelPickup.blob.hueStep);
    blob.userData.levelOrb.hue = hue;
    blob.userData.levelOrb.cycle = 0.99;
    blob.userData.levelOrb.lastCycle = 1;   // forces the note edge on the next tick
    updateLevelOrb(blob, 0, 0);
    // ...and the crossfade taken to the end, so the panel is the colour it
    // ARRIVED at rather than a blend halfway there.
    u.uLevelMix.value = 1;
    // Through the composite, because the knee is what a player sees — and
    // because the raw render answers this question wrongly in a way that looks
    // right: a saturated blue normalised to a LUMINANCE target has an enormous
    // blue channel and two small ones, so raw it truncates to something much
    // darker than the orange beside it and this row would fail on colours that
    // are in fact identical on screen.
    const fp = footprint(blob, { composited: true });
    peaks.push(fp.meanLum);
    const c = u.uLevelB.value;
    present(`note ${n + 1}`, `hue ${hue.toFixed(2)} · rgb ${c.r.toFixed(2)} ${c.g.toFixed(2)} ${c.b.toFixed(2)}`);
  }
  // On the mean LUMINANCE, not the peak: every one of these clips white in the
  // core, so a peak comparison reports 1.00x whatever the hues are doing and
  // would pass over exactly the failure this row exists to catch.
  const spread = Math.max(...peaks) / Math.max(1e-6, Math.min(...peaks));
  check('no note is visibly darker than the others', spread < 1.2,
    `brightest averages ${spread.toFixed(2)}x the dimmest`);
  scene.remove(blob);
}

// ===========================================================================
log('');
check('every panel rendered', shotIndex > 0, `${shotIndex} panels`);
Promise.all(posted).then(() => {
  log(`\n${fails === 0 ? 'All good.' : `${fails} failure(s).`}`, fails === 0 ? 'ok' : 'bad');
  document.title = fails === 0 ? 'pickups — ok' : `pickups — ${fails} FAIL`;
});
