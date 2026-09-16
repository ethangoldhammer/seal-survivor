// ---------------------------------------------------------------------------
// NEAR DEATH — LOOK DEV
//
//   npm run looks:hurt
//
// What the last third of the health bar does to the picture: the frame closing
// in and going bloody, scan lines crawling over the whole of it, all of it
// breathing on a heartbeat that quickens as the bar empties. The band is wide
// and the curve is slow, so most of what this sheet shows is the QUIET end —
// which is the part that is hard to judge and easy to get wrong.
// See CONFIG.fx.nearDeath, the ramp in systems/lowHealthFx.js and
// `applyLowHealthVignette` in systems/post.js.
//
// WHY A PAGE AND NOT A NODE HARNESS. Every number this effect produces is a
// uniform read by the final composite shader, and a Node harness cannot see a
// fragment shader at all — a broken program does not throw, does not warn in
// Node, and renders NOTHING. tools/low-health-test.mjs proves the ramp and the
// heartbeat are the right numbers; only this page can say they reach the
// screen. It runs the SHIPPING post chain over real creatures, so the frames
// on it are the frames the game draws.
//
// Three rows, because the effect has to survive all three:
//   THE RAMP        on `crt`, the shipped preset. What a player actually sees.
//   EVERYTHING OFF  screen filter AND bloom off. Nothing under it to add to, so
//                   this row is the whole effect standing alone — a player on
//                   the cheapest settings still has to see themselves dying.
//   THE HEARTBEAT   one cycle at a fixed strain, so the squeeze can be read as
//                   a shape rather than inferred from a single frame.
//
// A fourth row is the SCAN LINES on their own, with the blood switched off, for
// the one reason a sheet like this exists: the lines are a darkening and the
// blood is a darkening, and measured on a composited frame each is a perfectly
// good explanation of the other. Separating them is the only way the page can
// say which of the two is actually running.
//
// THE MEASUREMENTS ARE ALL OFF THE COMPOSITED PIXELS, never off the uniforms.
// A uniform being set is not the same as it reaching the screen, and that gap
// is the entire reason this page exists.
//
// IT WRITES NOTHING. CONFIG here is the live object of a throwaway bundle;
// there is no save path on this page and no dev server behind it. See
// SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { createPost } from '../../path/src/systems/post.js';
import { lowHealthFxState, heartbeat } from '../../path/src/systems/lowHealthFx.js';

const logEl = document.getElementById('log');
const sheetEl = document.getElementById('sheet');
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
// console about it, so an all-black sheet would read as a tuning decision
// rather than as a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 440;
const H = 275; // roughly the game's letterbox
const DT = 1 / 60;

const gl = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x081b2b);
scene.add(new THREE.AmbientLight(0x9cc4ff, 0.9));
const key = new THREE.DirectionalLight(0xfff2dc, 2.0);
key.position.set(3, 8, 6);
scene.add(key);

// The water behind everything, at the game's own near-black. This is the exact
// condition the first version of the effect failed on — a tint that could only
// redirect light had nothing here to redirect — so a page rendering over a
// bright background would have certified an invisible effect.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x14486b }),
);
water.position.z = -60;
scene.add(water);

// Something with an EDGE in it, out at the corners as well as the middle. The
// corners are where this effect is at full strength, and the claim that the
// picture survives underneath it is only testable where there is a picture.
for (let i = 0; i < 26; i++) {
  const a = (i / 26) * Math.PI * 2;
  const r = 6 + (i % 5) * 2.6;
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.5 + (i % 3) * 0.35, 0),
    new THREE.MeshStandardMaterial({ color: 0x2a4f66, roughness: 0.9 }),
  );
  rock.position.set(Math.cos(a) * r * 1.7, Math.sin(a) * r, -8 - (i % 4) * 3);
  scene.add(rock);
}

// A bright thing in a CORNER as well as one in the middle. The corner orb is
// the readability test: it stands in for the shark you have to be able to see
// coming while the frame is at its reddest.
for (const [x, y, c] of [[-9, 3.5, 0x9be7ff], [8.5, -4, 0xffd479], [-19, -8.5, 0xff9f5a]]) {
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 16, 12),
    new THREE.MeshBasicMaterial({ color: c }),
  );
  orb.position.set(x, y, -2);
  scene.add(orb);
}

const VIEW = 26; // about the game's framing on the seal
const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -200, 200,
);
camera.position.set(0, 0, 40);

await preloadAssets();

// Lay the bodies flat — createVisual points a creature forward at world +Y, and
// a nose-up animal is a vertical sliver that tells you nothing.
function place(assetKey, x, y, scale = 1) {
  const v = createVisual(assetKey);
  if (!v) return null;
  v.rotation.z = -Math.PI / 2;
  v.position.set(x, y, 0);
  v.scale.multiplyScalar(scale);
  scene.add(v);
  return v;
}
const seal = place('ship', -2, -1.5, 1.6);
const shark = place('enemyGreatWhite', 7, 4, 1.2);
check('the scene has bodies in it', !!(seal || shark),
  [seal && 'seal', shark && 'great white'].filter(Boolean).join(' + ') || 'primitives only');

const post = createPost(gl);

// --- reading the frames -----------------------------------------------------
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });

/**
 * Render one frame with the effect held at a given state.
 *
 * The strain is WRITTEN rather than reached by stepping the ease, on purpose:
 * this page is about what a given strain looks like, and the curve that gets
 * you there is tools/low-health-test.mjs's job. `beatPhase` is set alongside it
 * so a frame can be pinned to a chosen point in the heartbeat instead of
 * whichever one the render happened to land on.
 */
function grab(strain, { beatPhase = 0.5, postEnabled = true, bloom = true, scan = true } = {}) {
  // The scan lines can be switched off for one frame so the sheet can ask which
  // of the two darkenings is doing the work — see the note at the top. Restored
  // before this returns, so no later frame inherits it.
  const wasScan = CONFIG.fx.nearDeath.scan;
  if (!scan) CONFIG.fx.nearDeath.scan = 0;
  const wasPost = CONFIG.post.enabled;
  const wasBloom = CONFIG.bloom.enabled;
  CONFIG.post.enabled = postEnabled;
  CONFIG.bloom.enabled = bloom;
  lowHealthFxState.strain = strain;
  lowHealthFxState.beatPhase = beatPhase;
  lowHealthFxState.beat = strain > 0 ? heartbeat(beatPhase) : 0;
  post.resize();
  post.render(scene, camera, DT);
  CONFIG.post.enabled = wasPost;
  CONFIG.bloom.enabled = wasBloom;
  CONFIG.fx.nearDeath.scan = wasScan;
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height);
}

/**
 * How strongly a horizontal stripe pattern is sitting in a box: the mean
 * absolute difference in luminance between neighbouring ROWS, over the box's
 * own mean luminance.
 *
 * Row-to-row difference rather than the variance of the box, which is the
 * obvious version and is useless here — rocks, orbs and the water's own
 * gradient all have variance, and a frame with no lines in it scores high on
 * it. Neighbouring rows are the one statistic a scan line has and the picture
 * underneath mostly does not, because the scene's features are many pixels tall
 * and a line is one.
 *
 * DIVIDED BY THE MEAN, and that is not a detail. The lines are a MULTIPLY, so
 * the absolute size of the wobble they produce is proportional to how bright
 * the picture under them already was — and this effect's other half spends its
 * time dimming the corners. Unnormalised, the deeper lines out in the band
 * measure SMALLER than the shallow ones in the middle, purely because the
 * vignette took the brightness they were modulating. That reads as scanCore
 * being ignored when it is working exactly as configured.
 */
function stripeEnergy(img, x0, y0, x1, y1) {
  const { data, width, height } = img;
  const xa = Math.floor(x0 * width);
  const xb = Math.floor(x1 * width);
  const ya = Math.floor(y0 * height);
  const yb = Math.floor(y1 * height);
  let sum = 0;
  let mean = 0;
  let n = 0;
  for (let y = ya; y < yb - 1; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * width + x) * 4;
      const j = ((y + 1) * width + x) * 4;
      sum += Math.abs(lum(data, i) - lum(data, j));
      mean += lum(data, i);
      n++;
    }
  }
  return n ? (sum / n) / Math.max(mean / n, 1e-4) : 0;
}

const lum = (d, i) => (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;

/** Mean of a channel-wise function over a box given in 0..1 frame coordinates. */
function boxMean(img, x0, y0, x1, y1, fn) {
  const { data, width, height } = img;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) {
    for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) {
      sum += fn(data, (y * width + x) * 4);
      n++;
    }
  }
  return n ? sum / n : 0;
}

const boxLum = (img, ...box) => boxMean(img, ...box, lum);

/**
 * How RED a box is, as red minus the mean of the other two channels, in 0..1.
 *
 * Not "how much red is in it" — the answer to that is high for anything bright,
 * including a clean white highlight, which would score this effect as already
 * running on an untouched frame. The gap between the channels is what actually
 * separates a tint from a brightness.
 */
const redness = (img, ...box) => boxMean(img, ...box,
  (d, i) => (d[i] - (d[i + 1] + d[i + 2]) / 2) / 255);

/**
 * The radius at which the band reaches half its full strength — i.e. where the
 * aperture actually IS, in the same 0..1.41 units the shader works in.
 *
 * Measured rather than read off the uniform, because the uniform is the claim
 * under test. Sampled as a walk out from the middle along both horizontal
 * edges, differenced against a clean frame so the rocks and orbs the ray
 * happens to cross cancel out instead of being read as the effect.
 *
 * This exists because the obvious probe — a fixed box somewhere in the band —
 * cannot tell the two halves of the heartbeat apart. The corners are pinned at
 * full whatever the aperture does, and a box far enough inside to see the edge
 * move is a box the edge has not reached at rest, so it reads zero at both
 * ends of the beat. Asking where the edge IS separates them by construction.
 */
function edgeRadius(img, clean) {
  const at = (r) => {
    const dx = r / 2;
    const l = redness(img, 0.5 - dx - 0.02, 0.42, 0.5 - dx + 0.02, 0.58)
      - redness(clean, 0.5 - dx - 0.02, 0.42, 0.5 - dx + 0.02, 0.58);
    const rt = redness(img, 0.5 + dx - 0.02, 0.42, 0.5 + dx + 0.02, 0.58)
      - redness(clean, 0.5 + dx - 0.02, 0.42, 0.5 + dx + 0.02, 0.58);
    return (l + rt) / 2;
  };
  const RS = Array.from({ length: 40 }, (_, i) => 0.05 + (i / 39) * 0.93);
  const vals = RS.map(at);
  const peak = Math.max(...vals);
  if (peak <= 0.005) return NaN; // nothing there to find an edge in
  const half = peak * 0.5;
  const i = vals.findIndex((v) => v >= half);
  if (i <= 0) return RS[Math.max(0, i)];
  // Linear between the two samples that straddle the crossing, so the answer
  // is not quantised to the sample spacing — the whole measurement is a
  // difference of two of these and the step would swamp it.
  const t = (half - vals[i - 1]) / (vals[i] - vals[i - 1]);
  return RS[i - 1] + t * (RS[i] - RS[i - 1]);
}

/** The four corners, averaged. Where this effect is at full strength. */
function corners(img, fn = boxLum) {
  return (fn(img, 0, 0, 0.1, 0.14) + fn(img, 0.9, 0, 1, 0.14)
    + fn(img, 0, 0.86, 0.1, 1) + fn(img, 0.9, 0.86, 1, 1)) / 4;
}
/** The middle of the frame, which the effect must never touch. */
const middle = (img, fn = boxLum) => fn(img, 0.4, 0.4, 0.6, 0.6);

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];

function row(heading, sub) {
  const h = document.createElement('h2');
  h.innerHTML = sub ? `${heading} <span>${sub}</span>` : heading;
  sheetEl.appendChild(h);
  const r = document.createElement('div');
  r.className = 'row';
  sheetEl.appendChild(r);
  return r;
}

function cell(into, title, caption, picked = false) {
  const wrap = document.createElement('div');
  wrap.className = picked ? 'cell pick' : 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
  wrap.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b><br>${caption}`;
  wrap.appendChild(cap);
  into.appendChild(wrap);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

const c = CONFIG.fx.nearDeath;
log(`threshold ${(c.threshold * 100).toFixed(0)}% of the bar   ramp strain^${c.rampCurve}`, 'dim');
log(`strength ${c.strength}   colour #${c.color.toString(16).padStart(6, '0')}   blood ${c.glow}`
  + `   keep ${c.keep}   drain ${c.drain}   band ${c.inner} → ${c.outer}`, 'dim');
log(`heart ${c.beatFar}s → ${c.beatNear}s   pulse +${c.pulse}   squeeze -${c.close}`, 'dim');
log(`scan ${c.scan} at the edge / x${c.scanCore} in the middle   ${c.scanCount} lines`
  + `   drifting ${c.scanDrift}/s`, 'dim');
log('');

// The vignette is driven by the RAMPED strain, which is what post.js is handed
// — so the sheet is labelled in health rather than in strain, because health is
// the thing the player is looking at.
const ramp = (strain) => Math.pow(strain, c.rampCurve);
const hpAt = (strain) => c.threshold * (1 - strain) * 100;

// Evenly spaced in STRAIN, which after the band widened means evenly spaced in
// HEALTH — 35% down to empty in five steps. Not evenly spaced in the effect,
// deliberately: the curve is the thing being looked at, so the sheet has to
// show what each slice of the bar buys rather than flatten it out.
const STRAINS = [0, 0.25, 0.5, 0.75, 1];
const onFrames = [];
const shipped = row('The ramp', 'on the crt preset — what a player sees');
for (const s of STRAINS) {
  const img = grab(ramp(s));
  onFrames.push(img);
  cell(shipped, `hp ${hpAt(s).toFixed(1)}%`,
    s === 0 ? 'at the threshold — the preset alone, nothing added'
      : `strain ${s.toFixed(2)} · vignette ${ramp(s).toFixed(2)}`,
    s === 0);
}

const offFrames = [];
const bare = row('Screen filter and bloom off', 'the effect standing completely alone');
for (const s of [0, 0.5, 1]) {
  offFrames.push(grab(ramp(s), { postEnabled: false, bloom: false }));
  cell(bare, `filter off, hp ${hpAt(s).toFixed(1)}%`,
    s === 0 ? 'a clean render — the baseline this row is measured against'
      : 'nothing under it to add to, so this is the whole effect', s === 0);
}

// One cycle of the heart at a fixed strain, so the squeeze is legible as a
// shape. Phase 0 is the lub, 0.26 the dub, 0.6 the rest between beats.
const beatFrames = [];
const beats = row('One heartbeat', `at ${hpAt(0.85).toFixed(1)}% health — the same strain in every frame`);
for (const p of [0, 0.26, 0.6]) {
  beatFrames.push(grab(ramp(0.85), { beatPhase: p }));
  cell(beats, `phase ${p.toFixed(2)}`,
    `beat ${heartbeat(p).toFixed(2)} — ${p === 0 ? 'the lub' : p === 0.26 ? 'the dub' : 'the rest between beats'}`,
    p === 0.6);
}

// The lines on their own, over a clean picture, at the two ends of the ramp.
// Blood off, so what is on screen is only the scan lines — this is the row that
// says which of the two darkenings a measurement is looking at.
const lineFrames = [];
const lines = row('The scan lines alone', 'the blood switched off, so only the lines are running');
for (const [s, scan] of [[1, false], [0.5, true], [1, true]]) {
  lineFrames.push(grab(ramp(s), { postEnabled: false, bloom: false, scan }));
  cell(lines, scan ? `lines on, hp ${hpAt(s).toFixed(1)}%` : `lines OFF, hp ${hpAt(s).toFixed(1)}%`,
    scan ? `${c.scanCount} lines, x${c.scanCore} of full through the middle`
      : 'the same frame with scan 0 — the baseline the lines are measured against',
    !scan);
}

// --- what the frames say ----------------------------------------------------
log('');
const clean = onFrames[0];
const gone = onFrames[onFrames.length - 1];

// It has to be RED, not merely dark. A vignette that only multiplies is
// indistinguishable from the three that are already in this shader, and the
// whole point of a separate uniform was to be able to tint.
const redClean = corners(clean, redness);
const redGone = corners(gone, redness);
check('the corners of the frame actually go red', redGone > redClean + 0.05,
  `corner redness ${(redClean * 100).toFixed(1)}% → ${(redGone * 100).toFixed(1)}%`);

// ...and the MIDDLE must not. `inner` at 0.5 leaves the middle half of the
// screen untouched, and that is a promise the shader has to keep or the effect
// is a filter over the game rather than a frame around it.
const midClean = redness(clean, 0.4, 0.4, 0.6, 0.6);
const midGone = redness(gone, 0.4, 0.4, 0.6, 0.6);
check('...while the middle of the screen is left completely alone',
  Math.abs(midGone - midClean) < 0.015,
  `middle redness ${(midClean * 100).toFixed(1)}% → ${(midGone * 100).toFixed(1)}%`);

// THE READABILITY CLAIM, and the reason the tint is modulated by luminance
// rather than mixed toward a flat wash. The bottom-left orb sits out in the
// band at full strength; if the corners were a blindfold it would be gone.
//
// TIGHT ON THE ORB. The box has to be about the size of the thing: this one is
// 0.6 world units across in a 41-unit frame, and the first version of this
// probe was a box eight times its width — which measured the water around it,
// scored a contrast of 1.14 against water, and would have passed just as
// happily with the orb deleted.
const ORB = [0.015, 0.78, 0.075, 0.875];
const WATER = [0.015, 0.61, 0.075, 0.70]; // beside it, at about the same radius
const orbClean = boxLum(clean, ...ORB);
const orbGone = boxLum(gone, ...ORB);
const bgClean = boxLum(clean, ...WATER);
const bgGone = boxLum(gone, ...WATER);
// Contrast against the water beside it, not raw brightness — the whole corner
// dims, and what matters is whether the bright thing still stands out of it.
const contrastClean = orbClean / Math.max(bgClean, 1e-4);
const contrastGone = orbGone / Math.max(bgGone, 1e-4);
check('a bright thing in the corner is still clearly visible at empty',
  contrastGone > contrastClean * 0.6,
  `orb/water contrast x${contrastClean.toFixed(2)} → x${contrastGone.toFixed(2)}`);

// Monotonic. A ramp that backs up mid-way reads as a glitch rather than a slide.
const walk = onFrames.map((f) => corners(f, redness));
check('it only ever gets worse as the bar empties',
  walk.every((v, i) => i === 0 || v > walk[i - 1] - 0.002),
  walk.map((v) => (v * 100).toFixed(1)).join('% → ') + '%');

// THE EASE, which is the reverse of what this check used to assert and is the
// reason the curve went above 1. The band is a third of the bar now, so a
// quarter of the way into it is still 26% health — a fight you are winning, and
// a frame that is already a quarter red there is an alarm that is usually on.
const quarter = corners(onFrames[1], redness) - redClean;
const full = redGone - redClean;
check('a quarter of the way in is still only a hint', quarter < full * 0.3,
  `${((quarter / full) * 100).toFixed(0)}% of the full effect at ${hpAt(0.25).toFixed(1)}% health`);

// ...and it must not be nothing either, or "starts earlier" has bought a
// stretch of bar where the effect is switched on and invisible.
check('...but it is a hint rather than nothing', quarter > full * 0.05,
  `${(quarter * 100).toFixed(1)} points of corner redness at ${hpAt(0.25).toFixed(1)}% health`);

// The landmark: 15% health is where this effect used to BEGIN, and after
// widening the band it has to be unmistakable there rather than just underway.
// Measured off its own frame, not interpolated between the sheet's.
const sliverFrame = grab(ramp((c.threshold - 0.15) / c.threshold));
const sliver = corners(sliverFrame, redness) - redClean;
// 0.3 of the FULL FRAME'S redness, which is a lower number than the same claim
// makes in tools/low-health-test.mjs (44% there). The two are not in
// disagreement: that harness reads the uniform, and this reads pixels that have
// been through an additive blood term and a soft shoulder, neither of which is
// linear in the uniform. The uniform claim belongs to the harness; what this
// can say is that the corners are a long way past a hint by the point the
// effect used to start.
check('by the old threshold the frame is unmistakably in trouble', sliver > full * 0.3,
  `${((sliver / full) * 100).toFixed(0)}% of the frame's full redness at 15% health`);

// The effect is the seal's only near-death visual, so it must not depend on
// anything a player can switch off in the pause menu.
const bareRed = corners(offFrames[2], redness) - corners(offFrames[0], redness);
check('it still reads with the screen filter and bloom both off', bareRed > 0.05,
  `corner redness +${(bareRed * 100).toFixed(1)} points`);

// THE SQUEEZE. The heart's brightness pulse alone reads as a flashing light;
// the aperture narrowing is what reads as a heart. So the claim is not "the
// beat frame is redder" — a pure brightness pulse would pass that — it is that
// the EDGE OF THE BAND IS IN A DIFFERENT PLACE, which only the squeeze can do.
const beatClean = grab(0);
const edgeRest = edgeRadius(beatFrames[2], beatClean);
const edgeLub = edgeRadius(beatFrames[0], beatClean);
check('the heartbeat squeezes the frame, not just brightens it',
  edgeLub < edgeRest - 0.03,
  `the band's edge moves in from r ${edgeRest.toFixed(3)} to r ${edgeLub.toFixed(3)}`);
const lubLum = middle(beatFrames[0]);
const restLum = middle(beatFrames[2]);
check('...without the beat reaching the middle of the screen',
  Math.abs(lubLum - restLum) < 0.01,
  `middle ${(restLum * 100).toFixed(1)}% → ${(lubLum * 100).toFixed(1)}%`);

// --- the scan lines ---------------------------------------------------------
// Measured against the SAME frame with `scan` at 0 rather than against a clean
// one, because the blood is a darkening too: a difference taken against an
// untouched frame is a perfectly good measurement of the vignette and would
// pass with the lines deleted.
log('');
const noLines = lineFrames[0];
const halfLines = lineFrames[1];
const allLines = lineFrames[2];
// Well out in the corner, where the band mask is ~0.94 and the lines are close
// to their full depth. Pulled in from the very edge so the box is all water and
// not a row of clamped pixels.
const BAND = [0.02, 0.02, 0.20, 0.20];
const stripeOff = stripeEnergy(noLines, ...BAND);
const stripeOn = stripeEnergy(allLines, ...BAND);
check('the frame actually gets scan lines in it', stripeOn > stripeOff * 1.5,
  `row-to-row contrast ${(stripeOff * 100).toFixed(2)}% → ${(stripeOn * 100).toFixed(2)}%`);

// ...and across the MIDDLE too, which is the one thing the lines are allowed to
// do that the blood is not. scanCore is what buys this, and at 0 the effect
// would be a textured vignette rather than a picture failing.
const midOff = stripeEnergy(noLines, 0.4, 0.4, 0.6, 0.6);
const midOn = stripeEnergy(allLines, 0.4, 0.4, 0.6, 0.6);
check('...including across the clean middle of the screen', midOn > midOff * 1.3,
  `middle ${(midOff * 100).toFixed(2)}% → ${(midOn * 100).toFixed(2)}%`);

// ...but NOT as hard as at the edge. If these came out equal, `scanCore` is
// being ignored and the band mask never reached the lines.
const edgeGain = stripeOn - stripeOff;
const midGain = midOn - midOff;
// The expected ratio is not `scanCore` flat: the corner box sits at a band mask
// of about 0.94, not 1, so what the shader mixes to there is a hair under full.
// Bounded rather than pinned for that reason — what is being ruled out is the
// mask never reaching the lines at all, which reads as 100%.
check('...more faintly there than out in the band', midGain < edgeGain * 0.95,
  `middle is ${((midGain / Math.max(edgeGain, 1e-9)) * 100).toFixed(0)}% of the edge`
  + `, config's floor is ${(c.scanCore * 100).toFixed(0)}%`);

// They ride the strain like everything else here: half way down the bar is
// fainter than empty, or the lines snap to full at the crossing.
const halfGain = stripeEnergy(halfLines, ...BAND) - stripeOff;
check('they come in with the rest of it rather than snapping on',
  halfGain > 0 && halfGain < edgeGain * 0.95,
  `${((halfGain / Math.max(edgeGain, 1e-9)) * 100).toFixed(0)}% of full at ${hpAt(0.5).toFixed(1)}% health`);

// The middle must still be a window. The lines are allowed across it; making it
// unreadable is not the same permission, and the corner-orb check above only
// speaks for the band.
const midLumOff = boxLum(noLines, 0.4, 0.4, 0.6, 0.6);
const midLumOn = boxLum(allLines, 0.4, 0.4, 0.6, 0.6);
check('...and the middle is still a window you can see the fight through',
  midLumOn > midLumOff * 0.8,
  `middle brightness ${(midLumOff * 100).toFixed(1)}% → ${(midLumOn * 100).toFixed(1)}%`);

check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');

log('');
log(fails === 0 ? 'all checks passed' : `${fails} check(s) failed`, fails === 0 ? 'ok' : 'bad');
await Promise.all(posted);
log('frames written', 'dim');
