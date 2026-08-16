// ---------------------------------------------------------------------------
// GORE — LOOK DEV
//
//   npm run looks:gore
//
// The question this sheet exists to answer: does a man being eaten in the water
// read as a man being eaten, at the size the game is actually played at.
//
// Everything about this effect is judged and nothing about it can be asserted.
// npm run test:gore already proves the pool is never empty, that every shape is
// unit-sized, that the buffers never overrun and that the pieces sink and go —
// all of which can be true of an effect that looks like a bag of chips being
// emptied. What is left is the part only eyes can answer: whether the red is
// dark enough, whether one bone model plus two flesh lumps is enough variety,
// and whether any of it survives being forty units from the camera.
//
// Nothing here re-implements anything: the page imports the SHIPPING modules
// and the SHIPPING post chain, so every panel is the game's own code with the
// game's own numbers — and a panel that renders nothing is a GLSL error a Node
// harness could never have seen. See [[glsl-errors-need-a-real-gl-context]].
//
// IT WRITES NOTHING. The CONFIG assignments below are into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md and [[never-run-the-game-on-my-own-dev-server]].
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, hasModel } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  initParticles, updateParticles, resetParticles, updateParticleScale,
} from '../../path/src/entities/particles.js';
import {
  initGore, spawnGore, updateGore, resetGore, goreShapeCount,
} from '../../path/src/systems/gore.js';

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

const W = 420;
const H = 300;
const DT = 1 / 60;

// EVERY BURST ON THIS PAGE IS THE SAME BURST. spawnGore rolls a shape, a size,
// a stretch, a speed, a life and three spin rates per piece, so a ladder of
// four values for one control would be four different meals and most of the
// panel-to-panel difference would be the dice. Reseeded before each one, so the
// only thing that changes down a row is the thing being compared.
let seed = 0;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = () => { seed = 0x9017e5ed; };

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

updateBounds(W / H);

const scene = new THREE.Scene();
// The pieces are the ONLY lit thing in this effect, so the lighting is not
// dressing here the way it is on the goo sheet: a bone with no key on it is a
// flat silhouette, which is exactly the failure the material exists to avoid.
scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x2a3438, 2.0));
const key = new THREE.DirectionalLight(0xfff2e0, 2.4); key.position.set(-3, 4, 5); scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe4ff, 1.0); fill.position.set(4, 1, 3); scene.add(fill);

// Water to put the body in. Authored much brighter than it looks, on purpose:
// the game's composite writes gl_FragColor straight to the default framebuffer,
// so the LINEAR value lands as if it were sRGB and every colour arrives about a
// stop and a half darker than its hex. That is the pipeline the whole game is
// tuned under (systems/post.js), not something for this page to fix — but a
// water colour picked by eye off a swatch renders here as black.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x38708f }),
);
water.position.z = -30;
scene.add(water);

await preloadAssets();
initParticles(scene);
initGore(scene);
const post = createPost(gl);

const G = CONFIG.gore;
const P = G.pieces;
const BASE = { ...G, pieces: { ...P } };
const MAN = CONFIG.boats.crew.height;

check('the bone model loaded', hasModel(P.assets[0]), P.assets[0] ?? '(none listed)');
check('the pool has real shapes in it', goreShapeCount() > 1, `${goreShapeCount()} shapes`);

// Wide enough to hold the whole burst. Not a cosmetic choice: at 5 units the
// close-ups framed the middle of the spray and every panel looked like loose
// dots, which is indistinguishable from the goo failing to fuse. A sheet that
// cannot tell those two apart is worse than no sheet.
const VIEW = 14;
const ortho = (h) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(0, 0, 20);
  return c;
};
const camera = ortho(VIEW);
// The frame the player is actually given: at zoom 1 the frustum IS the arena.
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

// --- one meal ---------------------------------------------------------------

// Fire exactly what eatCrew fires — same call, same arguments — and hold the
// world for `frames` before the shot is taken.
// UNDER THE WATER LINE, always. The arena's surface is y = 0, and a body eaten
// exactly on it throws pieces that cross it on their way up and again on the
// way down — each crossing firing a `splash`, which is CYAN. The first version
// of this sheet was a red burst inside a cloud of blue dots that had nothing to
// do with the effect, and the effect looked broken because of it. Every panel
// here is a metre or so down, which is where a floating body actually is.
const DEEP = -4;

function meal({
  frames = 18, gore = {}, pieces = {}, cam = camera, at = [0, DEEP],
  vx = 0, vy = 0, height = MAN, clear = true,
} = {}) {
  if (clear) {
    resetParticles();
    resetGore();
    reseed();
    Object.assign(G, BASE);
    Object.assign(P, BASE.pieces);
    G.pieces = P;
  }
  Object.assign(G, gore);
  Object.assign(P, pieces);
  G.pieces = P;
  updateParticleScale(cam, gl);
  spawnGore(at[0], at[1], { height, vx, vy });
  run(frames, cam);
}

function run(frames, cam = camera) {
  for (let i = 0; i < frames; i++) {
    updateParticles(DT);
    updateGore(DT);
    post.resize();
    post.render(scene, cam, DT);
  }
}

// --- WHAT IT WAS ------------------------------------------------------------
// The honest before. Not "nothing" — a body eaten used to fire one `bite`
// burst, which is the same twenty-six pink specks a mackerel gets.
section('Before and after <span>— a man eaten, at arm\'s length</span>', 3);
meal({ frames: 12, gore: { spray: 0, mist: 0, cloud: 0 }, pieces: { enabled: false } });
present('As it was', 'the water on the frame after · one fish-sized bite burst, now removed');
meal({ frames: 12, pieces: { enabled: false } });
present('The red alone', 'spray, haze and mass · the effect with no solids at all');
meal({ frames: 12 });
present('The whole thing', 'red plus sixteen bones and pieces of him', true);

// --- THE THREE LAYERS -------------------------------------------------------
// Three emitters rather than one, because a burst thrown hard enough to read as
// an impact has torn itself apart long before it can read as a body of liquid.
section('The three red layers <span>— each one alone, then together</span>', 4);
meal({ frames: 16, gore: { mist: 0, cloud: 0 }, pieces: { enabled: false } });
present('Spray only', 'the hard burst · says the INSTANT it happened, gone in a second');
meal({ frames: 16, gore: { spray: 0, cloud: 0 }, pieces: { enabled: false } });
present('Haze only', 'barely thrown, long-lived · says WHERE it happened, and stays');
meal({ frames: 16, gore: { spray: 0, mist: 0 }, pieces: { enabled: false } });
present('Blob only', 'goo: fuses in the density pass · the body of blood', true);
meal({ frames: 16, pieces: { enabled: false } });
present('All three', 'the shipped mix', true);

// --- THE BLOB ---------------------------------------------------------------
// The layer the whole effect rests on, and the one that can silently stop
// working: fusion is a question of whether neighbours still OVERLAP in the
// density field, so a blob too small or a burst too fast comes out as a scatter
// of separate droplets with no error anywhere. Everything here is the SHIPPING
// pass (CONFIG.fx.goo) — the same one the kill goo goes through.
// The GROUP, not CONFIG.fx.goo itself. A group is a diff applied over those
// top-level keys, so `gore` overrides iso, soft, rim and spec — assigning to
// the parent here would change nothing and every panel in the row below would
// come out identical, which reads as the controls doing nothing rather than as
// the page reaching for the wrong object.
const GOO = CONFIG.fx.goo.groups.gore;
const GOO_BASE = { ...GOO };
section('The blood as one body <span>— the density pass, on the blood instead of a kill</span>', 4);
meal({ frames: 16, gore: { spray: 0, mist: 0, cloud: 0 }, pieces: { enabled: false } });
present('No blob', 'sprites only · the effect before the goo layer went in');
const CLOUD = CONFIG.emitters.goreCloud;
const CLOUD_COUNT = CLOUD.count;
for (const count of [14, CLOUD_COUNT, 70]) {
  // The count is the EMITTER's, not the system's, so meal()'s restore does not
  // reach it — set it here and put it back at the end of the row.
  CLOUD.count = count;
  meal({ frames: 16, gore: { spray: 0, mist: 0 }, pieces: { enabled: false } });
  present(`${Math.round(count * BASE.cloud)} blobs`,
    count < 20 ? 'too few to overlap — separate droplets, no body'
      : count > 60 ? 'one heavy slab; the lobes stop reading'
      : 'neighbours weld, necks between them',
    count === CLOUD_COUNT);
}
CLOUD.count = CLOUD_COUNT;

section('What the pass is doing to it <span>— one control at a time</span>', 4);
for (const [label, goo, note] of [
  ['As shipped', {}, 'a body with lobes and a wet edge'],
  ['Wider splat', { radius: 5.4 }, 'every splat overlaps every other · one flat disc'],
  ['Soft edge', { soft: 0.45 }, 'a cloud — the surface is gone, and so is the liquid'],
  ['Bright surface', { rim: 0.75, spec: 0.55 }, 'the kill goo\'s rim and specular · reads as fruit, not blood'],
]) {
  Object.assign(GOO, GOO_BASE, goo);
  meal({ frames: 16, gore: { spray: 0, mist: 0 }, pieces: { enabled: false } });
  present(label, note, Object.keys(goo).length === 0);
}
Object.assign(GOO, GOO_BASE);

// --- OVER TIME --------------------------------------------------------------
// The layers have deliberately different lifetimes. This is the row that says
// whether the handover between them works or whether the effect has a hole in
// the middle of it.
section('The whole event, frame by frame <span>— the spray goes, the haze stays, the bones sink</span>', 5);
for (const [f, note] of [
  [3, 'the frame it happens'],
  [14, 'a quarter second · spray at full spread'],
  [45, 'three quarters · spray thinning, bones falling'],
  [120, 'two seconds · haze and mass, bones sinking'],
  [260, 'four seconds · the smudge, and what is left on the way down'],
]) {
  meal({ frames: f });
  present(`${(f / 60).toFixed(2)}s`, note, f === 45);
}

// --- HOW MANY PIECES --------------------------------------------------------
section('How many pieces <span>— a body only has so much in it</span>', 4);
for (const count of [4, 10, 16, 34]) {
  meal({ frames: 22, pieces: { count } });
  present(`${count} pieces`, count <= 4 ? 'reads as debris, not as a body coming apart'
    : count > 30 ? 'a cloud of bones — more skeleton than one man has'
    : 'enough to be a person, few enough to be read', count === BASE.pieces.count);
}

// --- HOW BIG ----------------------------------------------------------------
// A MULTIPLE of the man's height, never world units: the crew height is the
// only scale on screen these read against.
section(`Piece size <span>— x the man's own height (${MAN})</span>`, 4);
for (const size of [0.12, 0.3, 0.5, 0.85]) {
  meal({ frames: 22, pieces: { size } });
  present(`Size ${size}x`, size < 0.2 ? 'gravel — no piece is identifiable'
    : size > 0.7 ? 'each piece is most of a man; the count stops making sense'
    : 'a bone is a bone at a glance', size === BASE.pieces.size);
}

// --- THE VARIETY TRICK ------------------------------------------------------
// bone.glb is ONE mesh, so the pool it gives is ONE shape. Two things keep that
// from reading as sixteen copies of one object, and this row is the only place
// either one can be judged.
section('One bone model, sixteen different bones <span>— stretch and flesh</span>', 4);
meal({ frames: 22, pieces: { lengthJitter: 0, girthJitter: 0, flesh: false } });
present('Raw', 'one geometry, uniform scale · sixteen copies of one object');
meal({ frames: 22, pieces: { flesh: false } });
present('Stretched', 'per-piece length and girth along the shape\'s OWN long axis');
meal({ frames: 22, pieces: { lengthJitter: 0, girthJitter: 0 } });
present('Flesh mixed in', 'the two procedural lumps at 1 - boneShare · colour contrast');
meal({ frames: 22 });
present('Both', 'the shipped burst', true);

// --- HOW MUCH IS BONE -------------------------------------------------------
section('Bone against flesh <span>— the only contrast the burst has</span>', 4);
for (const boneShare of [0, 0.35, 0.6, 1]) {
  meal({ frames: 22, pieces: { boneShare } });
  present(`Bone ${Math.round(boneShare * 100)}%`, boneShare === 0 ? 'all red — the pieces vanish into the spray behind them'
    : boneShare === 1 ? 'all ivory — reads as a bag of sticks, nothing of the man'
    : 'ivory against dark red', boneShare === BASE.pieces.boneShare);
}

// --- THE STAND-IN POOL ------------------------------------------------------
// Not a curiosity: this is what a failed load, an unlisted key or a bad export
// falls back to, and it has to be shippable rather than a placeholder.
section('The fallback, with no model at all <span>— what a failed load looks like</span>', 2);
meal({ frames: 22, pieces: { assets: [] } });
present('Stand-in shapes', 'four procedural bones + two flesh lumps · long bone, rib, vertebra, skull');
meal({ frames: 22 });
present('The real model', 'bone.glb, normalised to unit size on the way into the pool', true);

// --- AT FIGHT SCALE ---------------------------------------------------------
// Everything above is a magnifying glass. This is the frame the player is
// given, and it is where most effects quietly turn out to be invisible.
const seal = createVisual('ship');
seal.rotation.z = -Math.PI / 2; // createVisual points a body nose-up
seal.position.set(-7, -3, 0);
scene.add(seal);
const fightView = (bounds.top - bounds.bottom).toFixed(0);
section(`At fight scale <span>— the whole arena, ${fightView} units tall, with the seal for scale</span>`, 3);
meal({ frames: 12, cam: fightCam, at: [2, -6] });
present('One man, in frame', 'the burst the player actually sees', true);
meal({ frames: 20, cam: fightCam, at: [2, -6], vx: 12 });
present('Taken at a run', 'a shark carrying the body · the red and the bones both drift with it');
meal({ frames: 14, cam: fightCam, at: [0, -4] });
meal({ frames: 14, cam: fightCam, at: [4.5, -7], clear: false });
meal({ frames: 10, cam: fightCam, at: [-3, -9], clear: false });
present('A boat\'s crew going', 'three men inside half a second · the cap taking the oldest pieces');
scene.remove(seal);

check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
check('something is actually being drawn', gl.info.render.triangles > 0,
  `${gl.info.render.triangles} triangles on the last frame`);

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nall panels rendered', fails ? 'bad' : 'ok');
