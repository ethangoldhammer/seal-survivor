// ---------------------------------------------------------------------------
// FLAGS — LOOK DEV
//
//   npm run looks:flags
//
// Where a flag ends up on each of the three hulls that fly one, and what the
// cloth does once it is there.
//
// WHY A PAGE AND NOT A NODE HARNESS. The hoist point is MEASURED off the hull's
// own vertices, and no .glb loads in Node — so tools/flag-test.mjs can only
// measure the arithmetic over a hand-built boat, and the one question that
// actually matters (does that arithmetic land on the mast of the real trawler,
// and of a yacht built on a completely different axis?) is invisible from the
// terminal. Every way of getting it wrong puts the flag somewhere plausible:
// above the wheelhouse, halfway down the rigging, or in clear sky beside the
// mast, and all three read as bad art rather than as a stale number.
//
// It also compiles the wave. An injected shader that fails renders NOTHING and
// three only writes to the console, so a broken flag and a missing image look
// exactly alike from the game.
//
// THE IMAGE IS DRAWN HERE, on a canvas, and is deliberately not art: a test
// pattern with its hoist edge marked, so the aspect, the mirroring and the
// direction the cloth flies are all readable off one frame. The real flags are
// files in public/flags/ and rows in flags.csv — this page never reads them,
// because it is judging the rigging, not the pool.
//
// IT WRITES NOTHING. CONFIG is read off a throwaway bundle and there is no dev
// server behind this. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import { createVisual, preloadAssets, applySavedAssetLooks } from '../../path/src/assets.js';
import {
  measureMast, hullVertices, hoistPoint, buildFlagQuad, updateFlags,
} from '../../path/src/systems/flags.js';

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
// console about it, so the page would look like a placement bug rather than a
// broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 340;
const H = 300;
const DT = 1 / 60;

const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Sky behind them, because that is what a boat is seen against: these hulls are
// unlit near-black silhouettes on the horizon line, and a flag judged over
// black is a flag judged against nothing.
const sky = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.MeshBasicMaterial({ color: 0x183450 }),
);
sky.position.z = -400;
scene.add(sky);

// The game's own rig, read from CONFIG rather than invented — see the same note
// on tools/looks/bomb.js, which learned it the hard way.
const L = CONFIG.lighting;
scene.add(new THREE.AmbientLight(0xffffff, L.ambient));
const key = new THREE.DirectionalLight(0xffffff, L.keyIntensity);
key.position.fromArray(L.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, L.hemiIntensity));

let camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -2000, 2000);
function frame(centre, view) {
  camera = new THREE.OrthographicCamera(
    -view * (W / H) / 2, view * (W / H) / 2, view / 2, -view / 2, -2000, 2000,
  );
  camera.position.set(centre.x, centre.y, 400);
  camera.lookAt(centre.x, centre.y, 0);
}

const post = createPost(gl);
function draw() {
  post.resize();
  post.render(scene, camera, DT);
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

// --- reading the pixels back ------------------------------------------------
// A vertex-shader wave leaves the geometry's bounding box exactly where it was,
// so the only place the flutter exists is the drawn image.
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });
function grab() {
  draw();
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height);
}
/** Fraction of pixels that differ between two grabs, ignoring encoder-level noise. */
function differing(a, b) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > 6
      || Math.abs(a.data[i + 1] - b.data[i + 1]) > 6
      || Math.abs(a.data[i + 2] - b.data[i + 2]) > 6) n++;
  }
  return n / (a.data.length / 4);
}

// --- the stand-in image -----------------------------------------------------
// 2:1, the shape most flags are, with the HOIST edge (the one tied to the mast)
// marked and an arrow across it. Everything about how a flag is put on a boat
// is directional — which edge is tied, which way the cloth flies, whether it
// mirrors when the boat comes about — and a symmetric test pattern would pass
// all three of those questions without answering any of them.
function testFlagTexture(w = 256, h = 128) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#f2f6ff';
  x.fillRect(0, 0, w, h);
  x.fillStyle = '#d2361f';
  for (let i = -h; i < w; i += 32) {
    x.beginPath();
    x.moveTo(i, 0); x.lineTo(i + 16, 0); x.lineTo(i + 16 + h, h); x.lineTo(i + h, h);
    x.closePath(); x.fill();
  }
  // The hoist: a solid band down the edge that is tied to the mast.
  x.fillStyle = '#101a2c';
  x.fillRect(w - h * 0.22, 0, h * 0.22, h);
  // ...and an arrow running fly -> hoist, so a mirrored flag is obvious.
  x.strokeStyle = '#101a2c';
  x.lineWidth = h * 0.09;
  x.beginPath();
  x.moveTo(w * 0.12, h / 2); x.lineTo(w * 0.72, h / 2);
  x.moveTo(w * 0.56, h * 0.28); x.lineTo(w * 0.72, h / 2); x.lineTo(w * 0.56, h * 0.72);
  x.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// THE REAL FLAG if there is one, the test pattern if there is not. A look page
// judging a stand-in when the actual art is sitting in public/flags/ is a look
// page answering a question nobody has any more — and the stand-in has to stay,
// because it is the only thing that can be judged before the art exists.
let TEX = testFlagTexture();
let TEX_NOTE = 'stand-in test pattern (no image in public/flags/ for this row)';
const REAL = '/flags/bakalar.webp';
try {
  const tex = await new THREE.TextureLoader().loadAsync(REAL);
  tex.colorSpace = THREE.SRGBColorSpace;
  TEX = tex;
  TEX_NOTE = `${REAL} (${tex.image.width}x${tex.image.height})`;
} catch {
  // Expected until an image lands. Not a failure: the page's job is the
  // rigging, and the rigging is judgeable with any picture on it.
}
log(`flag image: ${TEX_NOTE}`);

await preloadAssets();
applySavedAssetLooks();

// ===========================================================================
// Every hull that flies a flag, hoisted exactly the way systems/flags.js does
// it — the same four calls attachFlag makes.
const HULLS = Object.keys(CONFIG.flags.hulls);
log(`hulls that fly flags: ${HULLS.join(', ')}`);
log(`flag height ${CONFIG.flags.heightFraction} of the hull, drop ${CONFIG.flags.hoistDrop}, `
  + `stand-off ${CONFIG.flags.standoff}, band ${CONFIG.flags.mastBand}`);

const rigged = [];

section('On the mast <span>— each hull, wearing the same image</span>', 3);
for (const hull of HULLS) {
  const visual = createVisual(hull);
  scene.add(visual);

  const mast = measureMast(hullVertices(visual), CONFIG.flags.mastBand);
  const hullBox = new THREE.Box3().setFromObject(visual);
  const hullSize = hullBox.getSize(new THREE.Vector3());

  if (!mast) {
    check(`${hull}: the hull could be measured`, false, 'no vertices — did the model load?');
    scene.remove(visual);
    continue;
  }

  const height = mast.height * (CONFIG.flags.hulls[hull].size ?? 1) * CONFIG.flags.heightFraction;
  const { mesh, uniforms } = buildFlagQuad(TEX, { height, rand: () => 0.5 });
  const group = new THREE.Group();
  group.position.copy(hoistPoint(mast));
  group.add(mesh);
  visual.add(group);

  visual.updateMatrixWorld(true);
  const flagBox = new THREE.Box3().setFromObject(mesh);

  log(`${hull}: hull ${hullSize.x.toFixed(1)} x ${hullSize.y.toFixed(1)} world units, `
    + `mast at local ${mast.x.toFixed(2)}, ${mast.y.toFixed(2)}, ${mast.z.toFixed(2)} (height ${mast.height.toFixed(2)}), `
    + `flag ${(flagBox.max.x - flagBox.min.x).toFixed(2)} x ${(flagBox.max.y - flagBox.min.y).toFixed(2)}`);

  // THE HOIST IS ON THE BOAT. The failure this catches is a flag in clear sky
  // beside the hull, which happens the moment the measurement is taken in the
  // wrong frame — and the number it produces is always plausible.
  // In WORLD units for the comparison: the mast is measured in the visual's own
  // frame, and createVisual scales that frame by the T panel's Size multiplier.
  // Comparing the two directly passes at size 1 and quietly fails at any other,
  // which is the shape of a check that never catches anything.
  const s = visual.scale.x || 1;
  check(`${hull}: the hoist point is over the hull, not out in the sky`,
    mast.x * s > hullBox.min.x - 0.01 && mast.x * s < hullBox.max.x + 0.01,
    `mast x ${(mast.x * s).toFixed(2)} in hull x ${hullBox.min.x.toFixed(2)}..${hullBox.max.x.toFixed(2)}`);
  // ...AND AT THE TOP OF IT. Within the drop the config asks for, so a flag
  // that quietly slid down the rigging is a failure rather than a look.
  check(`${hull}: ...and at the masthead, within the configured drop`,
    Math.abs(flagBox.max.y - hullBox.max.y) < mast.height * (CONFIG.flags.hoistDrop + 0.02) + 1e-3,
    `flag top ${flagBox.max.y.toFixed(2)} vs masthead ${hullBox.max.y.toFixed(2)}`);
  // THE CLOTH FLIES AFT. The hull faces +X at rest, so every one of these must
  // hang to -X of its hoist — the yacht included, and that one is built on a
  // different axis from the other two, which is exactly where a sign gets lost.
  check(`${hull}: the cloth flies aft of the mast`,
    flagBox.min.x < flagBox.max.x && flagBox.max.x <= hullBox.max.x + 1e-3,
    `flag x ${flagBox.min.x.toFixed(2)}..${flagBox.max.x.toFixed(2)}`);
  // A FLAG YOU CAN SEE. Big enough to read at fight scale, small enough not to
  // be a sail: a fraction of the hull rather than a world-unit size.
  check(`${hull}: it is a flag, not a sail`,
    (flagBox.max.y - flagBox.min.y) < hullSize.y * 0.35
    && (flagBox.max.y - flagBox.min.y) > hullSize.y * 0.05,
    `${(flagBox.max.y - flagBox.min.y).toFixed(2)} tall on a ${hullSize.y.toFixed(1)} hull`);

  frame(hullBox.getCenter(new THREE.Vector3()), Math.max(hullSize.x, hullSize.y) * 1.25);
  present(hull, `hull ${hullSize.x.toFixed(1)}x${hullSize.y.toFixed(1)}, flag ${(flagBox.max.y - flagBox.min.y).toFixed(2)} tall`);

  rigged.push({ hull, visual, mesh, uniforms, mast, hullBox });
  visual.visible = false;
}

// ===========================================================================
section('At the masthead <span>— close, where the halyard is</span>', 3);
for (const r of rigged) {
  r.visual.visible = true;
  const at = new THREE.Vector3().setFromMatrixPosition(r.mesh.matrixWorld);
  frame(at, r.mast.height * 0.55);
  present(`${r.hull} masthead`, 'the tie-off, the stand-off from the spar, and which edge is hoisted');
  r.visual.visible = false;
}

// ===========================================================================
// THE FLUTTER, one hull, four frames of one cycle. Judged as a strip: a wave
// that looks right frozen can still travel the wrong way or snap at the seam.
section('The flutter <span>— quarter-cycle steps, Bakalar\'s hull</span>', 4);
const flapper = rigged.find((r) => r.hull === 'bakalarBoat') ?? rigged[0];
if (flapper) {
  flapper.visual.visible = true;
  const at = new THREE.Vector3().setFromMatrixPosition(flapper.mesh.matrixWorld);
  frame(at, flapper.mast.height * 0.55);
    const period = (Math.PI * 2) / Math.max(0.01, CONFIG.flags.speed);
  const frames = [];
  for (let i = 0; i < 4; i++) {
    // The game's own tick, so what is drawn here is what a frame of the game
    // would draw — updateFlags owns the clock every flag shares.
    updateFlags(period / 4);
    present(`flutter ${i + 1} of 4`, `t = ${(i + 1) / 4} of a cycle`);
    frames.push(grab());
  }
  // THE CLOTH ACTUALLY MOVES — measured in PIXELS, which is the only place it
  // can be. The wave is a vertex-shader displacement, so the geometry's own
  // bounding box is identical on every frame of it: a box comparison here would
  // report a rigid flag as flying and a failed injection as fine. Two frames
  // half a cycle apart are compared instead, on the drawn image.
  const moved = differing(frames[0], frames[2]);
  check('the cloth moves — half a cycle apart is a different picture',
    moved > 0.004, `${(moved * 100).toFixed(2)}% of pixels differ`);
}

// ===========================================================================
check('no shader compiled with an error', shaderErrors.length === 0, shaderErrors[0] ?? '');

await Promise.all(posted);
log(`\n${fails ? `FAILED — ${fails} check(s)` : 'PASS — all checks'}`, fails ? 'bad' : 'ok');
document.title = fails ? `FLAGS — ${fails} FAILED` : 'FLAGS — pass';
