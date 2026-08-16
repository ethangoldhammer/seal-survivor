// ---------------------------------------------------------------------------
// KILL GOO — LOOK DEV
//
//   npm run looks:goo
//
// The question this sheet exists to answer: can a kill burst FUSE — read as a
// liquid coming apart rather than as a spray of round sprites — and what does
// each control actually buy.
//
// The answer is a screen-space metaball: entities/particles.js splats the
// flagged particles into a density field, systems/post.js thresholds it at an
// isoline, and neighbours weld across the gap between them. Both files carry
// the long version. Nothing here re-implements any of it — the page imports the
// SHIPPING modules and the SHIPPING post chain, so every panel is the game's
// own code with the game's own numbers, and a panel that renders nothing is a
// GLSL error a Node harness could never have seen.
//
// IT WRITES NOTHING. The CONFIG assignments below are into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, assetBaseColor } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  initParticles, updateParticles, resetParticles, updateParticleScale, emit,
} from '../../path/src/entities/particles.js';

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
// of a broken program. Collected from the first frame onward.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 420;
const H = 300;
const DT = 1 / 60;

// EVERY BURST ON THIS PAGE IS THE SAME BURST. emit() rolls a speed, a size, a
// life, a drag and an angle per particle, so a ladder of four values for one
// control was four different explosions and the panel-to-panel difference was
// mostly the dice. Reseeded to a fixed value before each kill, so the only
// thing that changes down a column is the thing being compared.
let seed = 0;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = () => { seed = 0x5ea15eed; };

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

// Water to put the goo in. The alpha option below hides whatever is behind it
// and the additive one adds to it, so a panel over empty black would make the
// two look identical — the water IS the comparison.
//
// Authored much brighter than it looks, on purpose. The game's composite is a
// raw ShaderMaterial writing gl_FragColor straight to the default framebuffer,
// so three never folds in the sRGB output conversion: the LINEAR value lands on
// the screen as if it were sRGB and every colour arrives about a stop and a
// half darker than its hex. That is the pipeline the whole game is tuned under
// (see systems/post.js) and not something for this page to fix — but a water
// colour picked by eye off a swatch renders here as black.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x38708f }),
);
water.position.z = -30;
scene.add(water);

await preloadAssets();
initParticles(scene);
const post = createPost(gl);

const VIEW = 9;
const ortho = (h) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(0, 0, 20);
  return c;
};
const camera = ortho(VIEW);
// The frame the player is actually given: at zoom 1 the frustum IS the arena.
const fightCam = ortho(bounds.top - bounds.bottom);

// A real creature's colour, because a death burst is always the dying thing's
// own emissive — a hand-picked red would be a picture of a decision nobody made.
const TINT = assetBaseColor('trout') ?? 0xff4d6d;
const TINT2 = assetBaseColor('barracuda') ?? 0x9d4dff;
check('a creature colour to tint with', TINT != null, `#${new THREE.Color(TINT).getHexString()}`);

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
  cell.appendChild(cap);
  row.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// --- one kill ---------------------------------------------------------------

const GOO = CONFIG.fx.goo;
const BASE = { ...GOO };

// Fire what feedback() fires for a kill — the spray and the goo, same position,
// same tint — and hold the world for `frames` before the shot is taken.
function kill({
  frames = 20, goo = {}, cam = camera, at = [0, 0], color = TINT,
  vx = 0, vy = 0, scale = 1, spray = true, clear = true,
} = {}) {
  if (clear) {
    resetParticles();
    reseed();
    Object.assign(GOO, BASE);
  }
  Object.assign(GOO, goo);
  updateParticleScale(cam, gl);
  const opts = { x: at[0], y: at[1], vx, vy, scale, color };
  if (spray) emit('explosion', at[0], at[1], opts);
  emit('killGoo', at[0], at[1], opts);
  run(frames, cam);
}

function run(frames, cam = camera) {
  for (let i = 0; i < frames; i++) {
    updateParticles(DT);
    post.resize();
    post.render(scene, cam, DT);
  }
}

// --- WHAT A KILL DOES TODAY -------------------------------------------------
section('A kill as it is today <span>— goo off, the sprite burst on its own</span>', 3);
for (const [f, note] of [[6, 'the first tenth of a second'], [20, 'a third of a second in'], [45, 'three quarters of a second in']]) {
  kill({ frames: f, goo: { enabled: false } });
  present(`Sprites ${f}f`, `${note} · round additive points, each one separate`);
}

// --- THE SAME KILL, FUSED ---------------------------------------------------
section('The same kill with goo <span>— identical sim, one extra pass</span>', 3);
for (const [f, note] of [[6, 'lands as one body'], [20, 'the current shears it'], [45, 'thinning out, breaking into lobes']]) {
  kill({ frames: f });
  present(`Goo ${f}f`, `${note} · iso ${BASE.iso}, blob ${BASE.radius}x, rim ${BASE.rim}`, true);
}

// --- BLOB SIZE --------------------------------------------------------------
// The control that decides whether anything fuses AT ALL.
section('Blob size <span>— splat diameter, x each particle\'s own size</span>', 4);
for (const r of [1.6, 2.6, 3.4, 5.5]) {
  kill({ frames: 18, goo: { radius: r } });
  present(`Blob ${r}x`, r < 2.5 ? 'too small to overlap — separate droplets, no fusion'
    : r > 4.5 ? 'one heavy slab; the lobes stop reading' : 'neighbours weld, necks between them', r === BASE.radius);
}

// --- THE ISOLINE ------------------------------------------------------------
section('The surface <span>— what density counts as liquid</span>', 4);
for (const iso of [0.45, 0.9, 1.5, 2.2]) {
  kill({ frames: 18, goo: { iso } });
  present(`Iso ${iso}`, iso < 0.6 ? 'swollen into one blanket'
    : iso > 2 ? 'only where several splats pile up — sparse, tense'
    : 'a body with lobes', iso === BASE.iso);
}

// --- EDGE -------------------------------------------------------------------
section('Edge softness <span>— half-width of the transition, in density</span>', 3);
for (const soft of [0.05, 0.22, 0.7]) {
  kill({ frames: 18, goo: { soft } });
  present(`Soft ${soft}`, soft < 0.1 ? 'a hard cut — reads as ink, not liquid'
    : soft > 0.5 ? 'a cloud; the surface is gone' : 'wet edge', soft === BASE.soft);
}

// --- WHAT KIND OF LIQUID ----------------------------------------------------
section('Which liquid <span>— one state change apart</span>', 4);
kill({ frames: 18, goo: { rim: 0, spec: 0 } });
present('Flat silhouette', 'threshold only, no shading · the cheap version');
kill({ frames: 18, goo: { spec: 0 } });
present('Wet rim', 'the band just inside the surface, brightened');
kill({ frames: 18 });
present('Rim and highlight', 'a specular lit off the density gradient · viscous', true);
kill({ frames: 18, goo: { additive: true } });
present('Additive', 'a glowing slick lying IN the water instead of hiding it');

// --- FIELD RESOLUTION -------------------------------------------------------
section('Field resolution <span>— the cost knob, and also the softness</span>', 3);
for (const divisor of [1, 2, 4]) {
  kill({ frames: 18, goo: { divisor } });
  present(`Divisor ${divisor}`, divisor === 1 ? 'full res · sharpest, 4x the fragments of 2'
    : divisor === 4 ? 'quarter res · edge goes chunky, blobs lose their necks'
    : 'half res · the wobble reads as surface tension', divisor === BASE.divisor);
}

// --- TWO KILLS --------------------------------------------------------------
// The thing a per-sprite trick cannot do: two bursts from different creatures
// meeting and blending across the weld.
section('Two kills at once <span>— separate bursts, one body</span>', 2);
kill({ frames: 16, at: [-1.1, 0], color: TINT });
kill({ frames: 16, at: [1.1, 0.3], color: TINT2, clear: false });
present('Overlapping deaths', 'two creatures, two tints · density-weighted blend across the neck', true);
kill({ frames: 16, at: [-2.6, 0], color: TINT });
kill({ frames: 16, at: [2.6, 0.3], color: TINT2, clear: false });
present('Apart', 'far enough that the field never bridges · two separate bodies');

// --- AT FIGHT SCALE ---------------------------------------------------------
// Everything above is a magnifying glass. This is the frame the player is given.
const seal = createVisual('ship');
seal.rotation.z = -Math.PI / 2; // createVisual points a body nose-up
seal.position.set(-7, -2, 0);
const fightView = (bounds.top - bounds.bottom).toFixed(0);
section(`At fight scale <span>— the whole arena, ${fightView} units tall, with the seal for scale</span>`, 3);
scene.add(seal);
kill({ frames: 14, cam: fightCam, at: [2, 1], scale: 1.4, vx: 4 });
present('One kill, in frame', 'the burst the player actually sees', true);
kill({ frames: 14, cam: fightCam, at: [0, 2], scale: 1.2 });
kill({ frames: 14, cam: fightCam, at: [3.5, 0.5], color: TINT2, scale: 1.2, clear: false });
kill({ frames: 10, cam: fightCam, at: [-2, -1.5], color: TINT, scale: 1.4, clear: false });
present('A school going down', 'three kills inside half a second');
kill({ frames: 14, cam: fightCam, at: [2, 1], scale: 1.4, vx: 4, goo: { enabled: false } });
present('...the same, goo off', 'for the direct comparison at the size it is played at');
// THE THING THE MAGNIFYING GLASS HIDES. Every panel above is 9 units of water
// and the arena is forty-odd: at that distance the shipped blob is a dot, and
// the fusion nobody can see is fusion nobody is paying for.
kill({ frames: 14, cam: fightCam, at: [2, 1], scale: 1.4, vx: 4, goo: { radius: 6 } });
present('Blob 6x, in frame', 'the same kill with the goo sized for the REAL frame');
kill({ frames: 14, cam: fightCam, at: [2, 1], scale: 1.4, vx: 4, goo: { radius: 8, iso: 0.7 } });
present('Blob 8x, iso 0.7', 'as far as it goes before it stops being a body');
scene.remove(seal);

// --- WHAT IT COSTS ----------------------------------------------------------
// Wall clock around the render loop with a forced finish at each end, so the
// GPU is actually made to answer rather than leaving the work queued.
//
// MEASURED IN ALTERNATING TRIALS, MIN OF EACH. Run once each in order, the
// first configuration measured pays for every program compile, every buffer
// upload and the JIT warming on the loop itself — which on the first attempt
// here made the goo look 56% FASTER than no goo at all. Alternating cancels
// any drift in the machine's load, and the minimum is the trial that was least
// interrupted; a browser tab is not a profiler, so the mean is mostly noise
// about other things.
function timeFrames(gooOn, frames = 90) {
  Object.assign(GOO, BASE, { enabled: gooOn });
  resetParticles();
  updateParticleScale(fightCam, gl);
  const ctx = gl.getContext();
  emit('explosion', 0, 0, { color: TINT });
  emit('killGoo', 0, 0, { color: TINT });
  run(4, fightCam);
  ctx.finish();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    // A kill every 8 frames, which is a heavier fight than the game runs.
    if (i % 8 === 0) {
      emit('explosion', (i % 5) - 2, (i % 3) - 1, { color: TINT, scale: 1.3 });
      emit('killGoo', (i % 5) - 2, (i % 3) - 1, { color: TINT, scale: 1.3 });
    }
    updateParticles(DT);
    post.resize();
    post.render(scene, fightCam, DT);
  }
  ctx.finish();
  return (performance.now() - t0) / frames;
}
const trials = { off: [], on: [] };
for (let i = 0; i < 4; i++) {
  trials.off.push(timeFrames(false));
  trials.on.push(timeFrames(true));
}
Object.assign(GOO, BASE);
const off = Math.min(...trials.off);
const on = Math.min(...trials.on);
const fmt = (a) => a.map((v) => v.toFixed(3)).join(' ');
log(`\nframe cost at ${gl.domElement.width}x${gl.domElement.height}, a kill every 8 frames`);
log('(4 alternating trials of 90 frames each, min taken)');
log(`  goo off  ${off.toFixed(3)} ms/frame   [${fmt(trials.off)}]`);
log(`  goo on   ${on.toFixed(3)} ms/frame   [${fmt(trials.on)}]`);
log(`  delta    ${(on - off >= 0 ? '+' : '')}${(on - off).toFixed(3)} ms/frame, ${((on / off - 1) * 100).toFixed(0)}% — against a 16.7ms budget`);

check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
check('the goo pass compiled into a program', gl.info.programs.length > 0, `${gl.info.programs.length} programs`);

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nall panels rendered', fails ? 'bad' : 'ok');
