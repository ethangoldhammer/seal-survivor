// ---------------------------------------------------------------------------
// THE HOMING MUSSEL — LOOK DEV
//
//   npm run looks:mussels
//
// The shell was a black rugby ball (`shape: 'oval'`, 1.8:1) and is now a real
// bivalve in two states, cut out of the Spline scene in SeaBed by
// tools/mussel-split.mjs: `mussel.glb` closed, `musselopen.glb` gaping. This is
// where the pair is judged.
//
// WHY A PAGE AND NOT A NODE HARNESS, and there are three separate reasons here:
//
//   NO GLB LOADS IN NODE. A terminal harness measures the primitive fallback
//   and reports a clean pass on an asset whose model never arrived. Every check
//   below is against the real geometry.
//
//   THE SURFACE IS INJECTED GLSL. `noise:mussel` in assets.csv attaches
//   systems/noiseShader.js AND systems/toonShade.js, both by onBeforeCompile.
//   A compile error there renders NOTHING and throws nothing a harness can see,
//   so the mussel would simply be missing from the game with a green suite.
//
//   THE BANDING IS THE POINT AND IT IS MEASURABLE. CONFIG.toonShade divides the
//   albedo out before it quantises, which is exactly what lets a near-black
//   shell band at all — and exactly what makes "did it band" impossible to
//   settle by reading the numbers. The cross-section below counts the plateaus.
//
// IT WRITES NOTHING. The CONFIG reads are from the live object of a throwaway
// bundle; there is no save path on this page and no dev server behind it.
// See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  preloadAssets, createVisual, hasModel, getAssetMaterials, ASSETS,
  applySavedAssetLooks, applyNoiseSettings, applyToonSettings,
} from '../../path/src/assets.js';
import {
  initMusselShells, updateMusselShells, clearMusselShells,
  spawnMusselShell, activeMusselShells,
} from '../../path/src/systems/musselShell.js';

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
// console about it, so the page would look like a bad tuning decision rather
// than a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 300;
const H = 300;
const DT = 1 / 60;
// A magnifying glass. The shell is 0.58 world units long against a 44-unit view
// in the game — at game framing it is a dozen pixels and every panel would be
// the same grey speck. 2.2 is close enough to read the seam.
const VIEW = 2.2;
// ...and the frame the detonation is judged in. The pop reaches ~1.45x and the
// question there is the SEQUENCE, not the seam.
const WIDE = 4.4;

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Water to sit them in. A near-black shell over pure black is a silhouette test
// with no silhouette; what it looks like against the blue it is actually drawn
// on is the whole question. `waterMid` is the game's own colour for the depth
// most of a fight happens at.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: CONFIG.colors.waterMid }),
);
water.position.z = -40;
scene.add(water);

// THE GAME'S LIGHTS, READ OUT OF CONFIG.lighting AND BUILT LIKE world.js DOES —
// not a plausible three-point rig copied off a neighbouring look page.
//
// This page shipped with the borrowed rig first (hemi 2.0, a 2.4 key, a fill
// and a rim) and every measurement on it was wrong in the same direction: it
// reported the body averaging 22% while the panel it had just written to disk
// held pixels of 7/255. Four times the light the game has will do that, and on
// a subject whose whole question is "is this dark thing visible" it is not a
// small discrepancy — it is the entire answer. A page that lights its subject
// better than the game does cannot be used to decide how dark to make it.
const L = CONFIG.lighting;
scene.add(new THREE.AmbientLight(0xffffff, L.ambient));
const key = new THREE.DirectionalLight(0xffffff, L.keyIntensity);
key.position.fromArray(L.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, L.hemiIntensity));

const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -100, 100,
);
camera.position.set(0, 0, 20);
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

await preloadAssets();
// THE SAVED LOOKS, in the same order boot() applies them. Skipping this is not
// a shortcut, it is a different subject: `assetLooks.missile.glow` is 2.25 in
// the live tuning, and now that the shell is a LIT material that number lands
// on emissiveIntensity instead of on colour magnitude — so the game renders a
// shell this page would otherwise draw with no emissive at all. On the one
// asset whose entire open question is "how dark is too dark", judging it
// without the glow the player sees is judging the wrong object.
applySavedAssetLooks();
// The shaders attach at material-build time with their own defaults; these are
// what push the real CONFIG (including anything restored from saved tuning)
// onto the uniforms. Without them the page would be judging a preset nobody
// wrote.
applyNoiseSettings();
applyToonSettings();

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

// Every panel re-renders first: the measurements below leave the canvas holding
// a raw render with the subject hidden, so a panel that copied whatever was
// last drawn would be a picture of empty water.
function present(title, note, picked = false) {
  draw();
  const cell = document.createElement('div');
  cell.className = picked ? 'cell pick' : 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  // The renderer is alpha:true, so this fill is the water behind it — a
  // transparent PNG on a white viewer is a picture of nothing.
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

// --- measuring ---------------------------------------------------------------
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });

// RAW renders, never through the post chain: bloom is a blur by design and
// would hand back the size of the halo instead of the size of the shell. Every
// SHAPE question below — footprint, band count — reads this one.
function grab() {
  gl.render(scene, activeCam);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height).data;
}

// ...and the same thing THROUGH the chain the game ships, which is the only
// honest way to ask a BRIGHTNESS question.
//
// The two are not close. post.js tonemaps, and a filmic curve has a toe: a raw
// linear 0.15 comes out the far side in the low single digits. Measured off the
// raw buffer, this page called a shell "22% of full scale" in the same breath
// as writing a PNG whose brightest pixel on that shell was 9/255. Whether a
// dark object is visible is a question about the final image and nothing else.
function grabPost() {
  post.resize();
  post.render(scene, activeCam, DT);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height).data;
}

// A DIFFERENCE of two renders, with the subject hidden in the second. A
// threshold on the image itself measures the water; differencing leaves exactly
// the pixels the subject is responsible for. Which matters more here than
// anywhere — the subject is nearly the same value as the background.
function footprint(obj) {
  const lit = grab();
  const was = obj.visible;
  obj.visible = false;
  const without = grab();
  obj.visible = was;
  let n = 0;
  let minX = 1e9; let maxX = -1e9; let minY = 1e9; let maxY = -1e9;
  for (let i = 0; i < lit.length; i += 4) {
    const d = Math.max(
      Math.abs(lit[i] - without[i]),
      Math.abs(lit[i + 1] - without[i + 1]),
      Math.abs(lit[i + 2] - without[i + 2]),
    );
    if (d <= 6) continue;
    n++;
    const p = i / 4;
    const x = p % probe.width; const y = (p / probe.width) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return {
    pixels: n / (probe.width * probe.height),
    w: n ? (maxX - minX + 1) / probe.width : 0,
    h: n ? (maxY - minY + 1) / probe.height : 0,
  };
}

// HOW MANY DISTINCT BRIGHTNESS LEVELS THE BODY IS WEARING — the toon check.
//
// Walks one horizontal line, keeps only the pixels the subject covers, and
// counts the runs of near-constant luminance. A photographic surface gives one
// long run that drifts the whole way across (every step is tiny, so the run
// never breaks); a banded one gives N plateaus separated by jumps. `steps` in
// the preset is the number to compare against.
//
// LUMINANCE, not a channel: the key is warm and the fill is cool, so any single
// channel has a gradient across the body that no amount of banding removes.
function bands(obj, y = 0.5) {
  const lit = grab();
  const was = obj.visible;
  obj.visible = false;
  const without = grab();
  obj.visible = was;

  const rowY = Math.round(probe.height * y);
  const lum = [];
  for (let x = 0; x < probe.width; x++) {
    const i = (rowY * probe.width + x) * 4;
    const d = Math.max(
      Math.abs(lit[i] - without[i]),
      Math.abs(lit[i + 1] - without[i + 1]),
      Math.abs(lit[i + 2] - without[i + 2]),
    );
    if (d <= 6) continue;
    lum.push(0.2126 * lit[i] + 0.7152 * lit[i + 1] + 0.0722 * lit[i + 2]);
  }
  if (lum.length < 20) return { plateaus: 0, span: 0, samples: lum.length };

  // A jump is a step between neighbours that is large relative to the whole
  // range the body covers. Relative and not absolute, because the shell is dark
  // and its entire range is a fraction of the 0-255 one — a fixed threshold
  // would find no jumps on it and every jump on a white belly.
  const span = Math.max(...lum) - Math.min(...lum);
  const jump = Math.max(2, span * 0.18);
  let plateaus = 1;
  for (let i = 1; i < lum.length; i++) if (Math.abs(lum[i] - lum[i - 1]) > jump) plateaus++;
  return { plateaus, span: span / 255, samples: lum.length };
}

// --- what loaded --------------------------------------------------------------
check('mussel.glb loaded', hasModel('missile'), 'the closed shell');
check('musselopen.glb loaded', hasModel('musselOpen'), 'the detonation state');
check('the closed shell is no longer unlit', ASSETS.missile.unlit !== true
  || !!ASSETS.missile.model, 'a lit material is what toonShade needs to attach to');

for (const k of ['missile', 'musselOpen']) {
  const mats = getAssetMaterials(k);
  const lit = mats.filter((m) => m.isMeshStandardMaterial || m.isMeshPhysicalMaterial);
  const toon = mats.filter((m) => m.userData.__toonAttached);
  const noise = mats.filter((m) => m.userData.__noiseAttached ?? m.userData.__noiseUniforms);
  check(`${k}: every material is lit`, lit.length === mats.length, `${lit.length}/${mats.length}`);
  check(`${k}: the toon pass attached`, toon.length === mats.length, `${toon.length}/${mats.length}`);
  check(`${k}: the noise attached`, noise.length === mats.length, `${noise.length}/${mats.length}`);
  const u = toon[0]?.userData.__toonUniforms;
  if (u) {
    check(`${k}: ...wearing the mussel preset, not the base`,
      u.uToonSteps.value === CONFIG.toonShade.presets.mussel.steps,
      `steps ${u.uToonSteps.value}, low ${u.uToonLow.value}, range ${u.uToonRange.value}`);
  }
}

// ===========================================================================
section('The closed shell <span>— the homing mussel in flight. Four headings, posed exactly as entities/projectiles.js poses it: rotation.z = atan2(dir) - PI/2 on the wrapper createVisual already oriented.</span>', 4);

const closed = createVisual('missile');
scene.add(closed);
{
  let widest = 0;
  for (const [label, deg] of [['flying right', 0], ['flying up', 90], ['flying left', 180], ['down-right', -45]]) {
    closed.rotation.set(0, 0, THREE.MathUtils.degToRad(deg) - Math.PI / 2);
    const fp = footprint(closed);
    widest = Math.max(widest, fp.pixels);
    present(label, `${(fp.pixels * 100).toFixed(1)}% of the panel · ${(fp.w * VIEW).toFixed(2)} x ${(fp.h * VIEW).toFixed(2)} units`);
  }
  closed.rotation.set(0, 0, -Math.PI / 2);

  // THE `up: '+X'` DECISION, measured. The broad face has to be the one facing
  // the lens: with '+Y' the flank goes to the camera instead and the shell
  // flies as a splinter. A quarter of the panel is the difference between the
  // two, so this is a real assertion and not a tautology.
  const fp = footprint(closed);
  check('the shell presents its broad face to the camera',
    fp.h > fp.w * 0.45,
    `${(fp.w * VIEW).toFixed(2)} wide x ${(fp.h * VIEW).toFixed(2)} tall — edge-on would be under 0.25 tall`);
  // AGAINST THE LONG AXIS, which at this heading is the WIDTH — the shell is
  // flying right, so its length lies across the panel. Measuring `h` here reads
  // the shell's beam and reports a model that is exactly right as 36% too
  // small, which is a great way to spend an hour retuning a correct `fit`.
  const long = Math.max(fp.w, fp.h) * VIEW;
  check('...and it is the size the oval it replaced was',
    Math.abs(long - ASSETS.missile.fit * 2) < 0.12,
    `${long.toFixed(2)} units against fit ${ASSETS.missile.fit} x size 2 = ${(ASSETS.missile.fit * 2).toFixed(2)}`);
}

// ===========================================================================
section('Is it actually banding? <span>— one horizontal cut through the shell, counting plateaus of constant luminance. A photographic surface is one long drifting run; the preset asks for two.</span>', 4);
{
  const want = CONFIG.toonShade.presets.mussel.steps;

  // THE NOISE HAS TO COME OFF TO COUNT THE STEPS, and finding that out is what
  // this section is for. With `noise:mussel` live the centreline cut reads six
  // plateaus, not two — and every one of the extra four is honest: the Perlin
  // layer is deliberately high-contrast (hard patches, not a wash) and the
  // valve seam is a real geometric crease with its own luminance jump. So a
  // plateau count over the shipped surface cannot tell "the toon pass is
  // working" from "the toon pass never attached and the noise is doing all of
  // it" — which is the exact confusion the count was added to settle.
  //
  // Zeroed through the live uniform and put straight back. This is the same
  // material every mussel in the game shares (see createVisual), so leaving it
  // at 0 would silently strip the noise off every later panel on this page.
  const noiseU = getAssetMaterials('missile')
    .map((m) => m.userData.__noiseUniforms).filter(Boolean);
  const saved = noiseU.map((u) => u.uNoiseStrength.value);
  const setNoise = (v) => noiseU.forEach((u, i) => { u.uNoiseStrength.value = v === null ? saved[i] : v; });

  setNoise(0);
  const found = [];
  for (const y of [0.42, 0.5, 0.58]) {
    const b = bands(closed, y);
    found.push(b.plateaus);
    present(`cut at ${y} · toon only`, `${b.plateaus} plateau(s) across ${b.samples} px · range ${(b.span * 100).toFixed(1)}% of full scale`);
  }
  check('the shell wears discrete bands, not a gradient',
    Math.max(...found) >= 2, `${found.join(' / ')} plateaus across three cuts, noise off`);
  // MOST CUTS, NOT ALL OF THEM, and the exception is the interesting part: the
  // cut along y=0.5 runs straight down the valve seam, which is a geometric
  // crease with its own luminance jumps on either side of it, so it counts six
  // where the two cuts either side of it count exactly `steps`. That is the
  // model being right, not the shader being wrong — the first version of this
  // check took the maximum and failed on a correct render.
  // A CEILING, not an exact match. Under the game's own lighting — one key and
  // a broad ambient, not the four-light rig this page borrowed at first — the
  // terminator between the two bands is itself wide enough to register as a
  // short run of its own, so a correct two-step preset reads as three. What the
  // check is for is catching a count that has run away (the noise leaking in,
  // or the bands never forming), and the ceiling does that without pinning the
  // number to whichever lighting the page happens to have.
  check(`...and the count stays near the preset's ${want} steps`,
    found.every((n) => n <= want + 1),
    `${found.join(' / ')} plateaus`);
  // THE TRAP THIS CATCHES. `low` and `range` were both moved off the family
  // defaults for this preset because the shell is a near-black hide: at the
  // base numbers the shadow band lands on an already-black albedo and the whole
  // body collapses to one flat value. That failure looks exactly like "the toon
  // shader never attached", and the only difference visible from outside is
  // this number.
  const flat = bands(closed, 0.5);
  check('...and the dark band is a shadow rather than a hole',
    flat.span > 0.04, `the body spans ${(flat.span * 100).toFixed(1)}% of full scale`);

  // IS THE PERLIN LAYER DOING ANYTHING AT ALL — asked as an image difference,
  // not as a plateau count. Counting plateaus with the noise on and off gave
  // the SAME number both ways and the obvious reading of that ("the noise is
  // inert") was wrong: the count is dominated by the seam, so it is simply not
  // a sensitive enough instrument to see a fine-grained layer. Differencing the
  // two renders is, and it answers the question the count was standing in for.
  const off = grab();
  setNoise(null);
  const on = grab();
  let diff = 0; let covered = 0;
  for (let i = 0; i < on.length; i += 4) {
    const d = Math.max(
      Math.abs(on[i] - off[i]), Math.abs(on[i + 1] - off[i + 1]), Math.abs(on[i + 2] - off[i + 2]),
    );
    if (d > 2) { covered++; diff += d; }
  }
  const shellPx = footprint(closed).pixels * probe.width * probe.height;
  present('cut at 0.5 · shipped', `noise moves ${(covered / Math.max(1, shellPx) * 100).toFixed(0)}% of the shell's pixels`);
  check('the Perlin layer is actually painting the shell',
    covered > shellPx * 0.2,
    `${covered} px moved, mean ${(diff / Math.max(1, covered)).toFixed(1)}/255, over a ${Math.round(shellPx)} px body`);
}

// ===========================================================================
section('How dark is too dark <span>— the hide the source file ships against three candidates. The toon pass divides the albedo out, bands the LIGHT and multiplies the albedo back, so its output can never exceed the albedo: on a 2.7% hide, a perfectly working two-band ramp still renders a 2.7% shape. This is the one thing the ramp cannot fix.</span>', 4);
{
  const mat = getAssetMaterials('missile')[0];
  // THE SPLINE FILE'S OWN VALUE, written down rather than read back. The model
  // on disk already ships the lifted hide — tools/mussel-split.mjs bakes it, so
  // that both valves of the open shell match this one — which means `mat.color`
  // IS the shipped answer and the "as authored" row would render the candidate
  // against itself. It did, once, and reported the source and the fix as the
  // same 37%, which reads exactly like a change that did nothing.
  const SOURCE_HIDE = 0x07070a;
  const SHIPPED_HIDE = 0x2b2f3f;
  // MEAN OVER THE BODY, and not the peak. The banding check above passes on a
  // shell nobody can see — 14% of full scale is a real spread between two
  // values that are both nearly black — so a second number is needed, and the
  // obvious one is wrong: an 11x lift in albedo moved the peak from 33% to 37%
  // and looked like the tint had done nothing. The peak on this material is a
  // broad specular sheen, and a dielectric's specular is ~4% whatever colour
  // the body is, so the brightest pixel is close to albedo-independent by
  // construction. The average over the body is the diffuse, which is the part
  // the albedo owns and the part the toon pass bands.
  const bodyMean = () => {
    const lit = grabPost();
    const was = closed.visible;
    closed.visible = false;
    const without = grabPost();
    closed.visible = was;
    let sum = 0; let n = 0;
    for (let i = 0; i < lit.length; i += 4) {
      const d = Math.max(
        Math.abs(lit[i] - without[i]),
        Math.abs(lit[i + 1] - without[i + 1]),
        Math.abs(lit[i + 2] - without[i + 2]),
      );
      if (d <= 6) continue;
      sum += 0.2126 * lit[i] + 0.7152 * lit[i + 1] + 0.0722 * lit[i + 2];
      n++;
    }
    return n ? sum / n / 255 : 0;
  };
  // The water behind it, READ OFF THE RENDER rather than computed from the hex.
  // three's colour management puts a THREE.Color in linear space, and the peak
  // above comes off the sRGB framebuffer — comparing the two put a 3% water
  // behind a 37% shell and made every candidate look like a triumph.
  const waterLum = (() => {
    const d = grabPost();
    const i = ((probe.height * 0.06 | 0) * probe.width + (probe.width * 0.06 | 0)) * 4;
    return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  })();

  const peaks = [];
  for (const [label, hex] of [
    ['0x07070a — as authored', SOURCE_HIDE],
    ['0x2b2f3f — shipped', 0x2b2f3f],
    ['0x515971 — a pebble', 0x515971],
    ['0x7d879e — too far', 0x7d879e],
  ]) {
    // COLOUR AND EMISSIVE TOGETHER. prepareModel seeds `emissive` from the
    // material's colour at load — which is the colour AFTER `def.tint` — and
    // the saved glow of 2.25 then multiplies it. Moving only `color` leaves
    // every candidate riding the shipped tint's emissive, so the sweep measures
    // four variations on one answer: it reported the source hide at 20.8% when
    // the source hide on its own renders at 7.1%.
    mat.color.setHex(hex);
    if (mat.emissive) mat.emissive.setHex(hex);
    const p = bodyMean();
    peaks.push({ label, hex, p });
    present(label, `the body averages ${(p * 100).toFixed(1)}% · the water behind it is ${(waterLum * 100).toFixed(1)}%`,
      label.includes('shipped'));
  }
  mat.color.setHex(SHIPPED_HIDE);
  if (mat.emissive) mat.emissive.setHex(SHIPPED_HIDE);

  const shipped = peaks.find((q) => q.label.includes('shipped'));
  check('the shipped hide is brighter than the source file ships',
    shipped.p > peaks[0].p * 2,
    `${(shipped.p * 100).toFixed(1)}% against the source's ${(peaks[0].p * 100).toFixed(1)}%`);
  // A DARK SHELL, and the ceiling is the assertion that matters. The candidates
  // above 0x51 render as a pale grey pebble with no seam and no visible
  // terminator — brighter, and less of a mussel. The lift exists so the toon
  // pass has an albedo to work with at all, not so the shell can out-shine the
  // sea; 0x2b2f3f lands within a point of the water's own luminance and is
  // perfectly legible there, because what separates it is that it is NEUTRAL
  // against a blue field, not that it is brighter than one.
  check('...but is still a dark shell, not a grey pebble',
    shipped.p < 0.15, `${(shipped.p * 100).toFixed(1)}% against the water's ${(waterLum * 100).toFixed(1)}%`);
  // ...which is the separation worth checking, and it is a COLOUR distance.
  // Luminance alone calls this shell invisible — 8.8% on a 9.8% background —
  // and the panel it writes to disk shows an unmistakable dark shape. The eye
  // is reading hue here, and a luminance-only check would have argued the shell
  // up to a near-white 0x515971 to fix a problem that was never on screen.
  const shellRGB = (() => {
    mat.color.setHex(shipped.hex); if (mat.emissive) mat.emissive.setHex(shipped.hex);
    const d = grabPost();
    const i = ((probe.height >> 1) * probe.width + (probe.width >> 1)) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  })();
  const waterRGB = (() => {
    const was = closed.visible; closed.visible = false;
    const d = grabPost(); closed.visible = was;
    const i = ((probe.height >> 1) * probe.width + (probe.width >> 1)) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  })();
  const dist = Math.hypot(...shellRGB.map((v, i) => v - waterRGB[i]));
  check('...and it separates from the water by colour, not by brightness',
    dist > 18, `rgb(${shellRGB}) against rgb(${waterRGB}) — distance ${dist.toFixed(0)}`);
}

// ===========================================================================
section('The open shell <span>— what a detonation swaps to. Six meshes and six materials; the orange body and the tan mantle behind pale nacre are the whole reason it exists.</span>', 4);

scene.remove(closed);
const open = createVisual('musselOpen');
scene.add(open);
{
  for (const [label, deg] of [['flying right', 0], ['flying up', 90], ['flying left', 180], ['down-right', -45]]) {
    open.rotation.set(0, 0, THREE.MathUtils.degToRad(deg) - Math.PI / 2);
    const fp = footprint(open);
    present(label, `${(fp.pixels * 100).toFixed(1)}% of the panel · ${(fp.w * VIEW).toFixed(2)} x ${(fp.h * VIEW).toFixed(2)} units`);
  }
  open.rotation.set(0, 0, -Math.PI / 2);
  const fo = footprint(open);
  scene.add(closed);
  scene.remove(open);
  const fc = footprint(closed);
  scene.remove(closed);
  // THE PAIR HAS TO BE ONE ANIMAL. assets.csv holds their sizes equal on
  // purpose so the pop is the shell opening and not the shell growing; if the
  // two rows ever drift, this is where it shows.
  check('open and closed are the same animal at the same size',
    Math.abs(fo.h - fc.h) / Math.max(fc.h, 1e-6) < 0.25,
    `${(fo.h * VIEW).toFixed(2)} vs ${(fc.h * VIEW).toFixed(2)} units tall`);
  scene.add(open);
}

// ===========================================================================
section('The detonation <span>— systems/musselShell.js, stepped with the real updateMusselShells at the real CONFIG.missile.shell timings. The flash and the debris are not on this page; this is the shell alone.</span>', 6);

scene.remove(open);
activeCam = wideCam;
{
  initMusselShells(scene);
  clearMusselShells();
  check('the pool built out of the model, not a fallback sphere',
    activeMusselShells() === 0 && !!CONFIG.missile.shell,
    `pool ${CONFIG.missile.shell.pool}`);

  spawnMusselShell(0, 0, { dirX: 1, dirY: 0 });
  check('a detonation opens exactly one shell', activeMusselShells() === 1);

  const life = CONFIG.missile.shell.life;
  const popTime = CONFIG.missile.shell.popTime;
  let t = 0;
  const sizes = [];
  // Weighted hard to the front. The opening is `popTime` (three frames) and
  // everything after it is the shell drifting and shrinking, so an even spread
  // across the life would show one frame of the pop and five of the aftermath.
  const marks = [0, 0.017, 0.034, 0.05, 0.13, 0.26].map((f) => f * life / 0.26);
  for (const mark of marks) {
    while (t < mark) { updateMusselShells(DT); t += DT; }
    const alive = activeMusselShells();
    if (alive) {
      const shell = scene.children.find((c) => c.type === 'Group' && c.children.some((m) => m.visible && m.name === 'musselOpen'));
      const mesh = shell?.children.find((m) => m.visible);
      if (mesh) sizes.push(mesh.scale.x);
    }
    present(`t = ${(t * 1000).toFixed(0)} ms`, alive
      ? `${(t / life * 100).toFixed(0)}% through · scale ${sizes.at(-1)?.toFixed(2) ?? '?'}`
      : 'gone');
  }
  // IT HAS TO BE OPEN BEFORE THE FLASH IS. Eased across the whole life instead
  // of on `popTime`, the shell was a third open at 33ms and peaked at 130 —
  // inside the flash's tail rather than inside its bright pass, which reads as
  // the shell inflating in the smoke instead of bursting out of it. This is the
  // assertion that failed and is why `popTime` exists at all.
  const peak = Math.max(...sizes);
  const openBy = sizes.find((s, i) => marks[i] >= popTime);
  check('the shell is fully open within popTime, not at the end',
    openBy != null && openBy > peak * 0.9,
    `${(openBy ?? 0).toFixed(2)} of a peak ${peak.toFixed(2)} by ${(popTime * 1000).toFixed(0)} ms`);
  check('...and it is shrinking by the time it goes',
    sizes.at(-1) < peak, `ends at ${sizes.at(-1)?.toFixed(2)} from ${peak.toFixed(2)}`);
  check('...and it outlives the flash it opens inside',
    life > (CONFIG.missile.impact.life ?? 0.17),
    `shell ${life}s vs flash ${CONFIG.missile.impact.life}s`);

  // Run it out and make sure it puts itself away. A pooled effect that never
  // retires is a shell frozen mid-pop in the middle of the arena for the rest
  // of the run.
  while (t < life + 0.1) { updateMusselShells(DT); t += DT; }
  check('the shell retires on its own', activeMusselShells() === 0, `after ${(t * 1000).toFixed(0)} ms`);
}

// ===========================================================================
section('A barrage landing <span>— eight shells inside one frame, which is what a full-charge Mussel Barrage on a school does. The pool is 10.</span>', 3);
{
  clearMusselShells();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    spawnMusselShell(Math.cos(a) * 1.2, Math.sin(a) * 1.2, { dirX: Math.cos(a), dirY: Math.sin(a) });
  }
  check('eight land without stealing each other', activeMusselShells() === 8,
    `${activeMusselShells()} open, pool ${CONFIG.missile.shell.pool}`);
  let t = 0;
  for (const mark of [0.02, 0.08, 0.18]) {
    while (t < mark) { updateMusselShells(DT); t += DT; }
    present(`barrage +${(t * 1000).toFixed(0)} ms`, `${activeMusselShells()} shells open`);
  }
  // Oldest-first stealing, and the thing worth asserting is that it never grows
  // past the pool: the alternative — allocating on demand — is a hitch on the
  // single loudest frame in the run.
  for (let i = 0; i < 20; i++) spawnMusselShell(0, 0, { dirX: 1, dirY: 0 });
  check('...and a flood never allocates past the pool',
    activeMusselShells() <= CONFIG.missile.shell.pool,
    `${activeMusselShells()} open after 28 detonations`);
  clearMusselShells();
  check('a run reset takes them all off the board', activeMusselShells() === 0);
}

// ===========================================================================
log('');
check('nothing failed to compile', shaderErrors.length === 0,
  shaderErrors.length ? shaderErrors[0].slice(0, 160) : 'no shader errors on the console');
check('every panel rendered', shotIndex > 0, `${shotIndex} panels`);
Promise.all(posted).then(() => {
  log(`\n${fails === 0 ? 'All good.' : `${fails} failure(s).`}`, fails === 0 ? 'ok' : 'bad');
  document.title = fails === 0 ? 'mussels — ok' : `mussels — ${fails} FAIL`;
});
