// ---------------------------------------------------------------------------
// THE SEABED BED — LOOK DEV
//
//   npm run looks:seabed
//
// tools/seabed-scatter-test.mjs already proves the LAYOUT: the spacing holds,
// the mix follows the weights, the same seed gives the same bed. None of that
// can tell you whether the bed looks like a seabed, and none of it would catch
// the two ways this fails silently:
//
//   A PLANT THAT NEVER LOADED. createVisual before preloadAssets resolves
//   hands back the procedural fallback — a green cone — without throwing. A bed
//   of 260 green cones passes every assertion in the Node harness, because the
//   harness never loads a model at all.
//
//   A PLANT LYING ON ITS SIDE. `forward`/`up` are a mapping into view space,
//   not a statement about the file, and the intuitive-looking pair lays every
//   plant flat. That is a picture-only bug: the transform is valid, the bounds
//   are the right size, and the bed is simply on the floor.
//
// So this page imports the SHIPPING scatter, the SHIPPING assets and the
// SHIPPING post chain and photographs the result at the framing a run is played
// at. It also measures the two things a picture is bad at — how many draw calls
// and triangles the bed really costs, read off the built objects rather than
// off the plan.
//
// IT WRITES NOTHING. There is no save path on this page and no dev server
// behind it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets } from '../../path/src/assets.js';
import { createPost } from '../../path/src/systems/post.js';
import { scatterSeabed, bedPlacements, clearSeabed } from '../../path/src/systems/seabedScatter.js';
import { applyGrassSettings, updateGrassSway } from '../../path/src/systems/grassSway.js';
import { seabedTopY, bounds } from '../../path/src/arena.js';

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

// A shader that fails to compile renders NOTHING and three only writes about it
// to the console, so the bed would look like a bad tuning decision rather than
// a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 1100;
const H = 460;

const gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Water behind it. A bed photographed over black flatters every plant in it —
// these are pale watercolour props and the question is what they look like
// against the blue they are actually drawn on.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x12314a }),
);
water.position.z = -40;
scene.add(water);

// The floor line, so "planted at ground level" is checkable rather than
// asserted. A plant hovering above it or buried in it is obvious against a
// drawn line and nearly invisible without one.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 0.06),
  new THREE.MeshBasicMaterial({ color: 0x2b5a78 }),
);
scene.add(floor);

scene.add(new THREE.HemisphereLight(0xbfe9ff, 0x14324a, 1.9));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(2, 4, 5);
scene.add(key);

let shotIndex = 0;
const posted = [];
function shot(title, caption, camera) {
  post.resize();
  post.render(scene, camera, 1 / 60);

  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = gl.domElement.width;
  canvas.height = gl.domElement.height;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b> — ${caption}`;
  cell.appendChild(cap);
  sheetEl.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => {
    canvas.toBlob((blob) => fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done), 'image/png');
  }));
}

await preloadAssets(() => {});
const post = createPost(gl);

// --- build it ---------------------------------------------------------------
const group = scatterSeabed(scene);
const bed = bedPlacements();

check('the bed was planted', bed.length > 0, `${bed.length} plants`);
check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? 'clean');

// Every draw is an InstancedMesh, not a Mesh. One stray Mesh here means a
// variant fell out of the instancing path and is being drawn per plant.
const draws = group.children;
check('one InstancedMesh per variant', draws.length > 0 && draws.every((d) => d.isInstancedMesh),
  `${draws.length} draws for ${bed.length} plants`);

let tris = 0;
let instances = 0;
for (const d of draws) {
  const g = d.geometry;
  tris += ((g.index ? g.index.count : g.attributes.position.count) / 3) * d.count;
  instances += d.count;
}
check('every plant got an instance', instances === bed.length, `${instances} of ${bed.length}`);
log(`\n  ${bed.length} plants · ${draws.length} draw calls · ${tris.toLocaleString()} triangles drawn`);

// THE FALLBACK CHECK. A cone is 32 triangles and every real prop is 150 or
// more, so a bed that quietly filled with fallbacks reads as an impossibly
// cheap one. This is the assertion the Node harness cannot make.
const cheapest = Math.min(...draws.map((d) => {
  const g = d.geometry;
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}));
check('no variant fell back to the procedural cone', cheapest >= 100,
  `cheapest variant is ${cheapest} triangles`);

// THE ORIENTATION CHECK, measured rather than eyeballed. These are plants:
// every one of them is taller than it is deep. A bed laid flat by the wrong
// forward/up pair inverts that, and inverts it for all of them at once.
const box = new THREE.Box3();
let upright = 0;
for (const d of draws) {
  d.geometry.computeBoundingBox();
  const b = d.geometry.boundingBox;
  if (b.max.y - b.min.y > b.max.z - b.min.z) upright++;
}
check('the plants stand up', upright >= draws.length - 2,
  `${upright} of ${draws.length} variants are taller than they are deep`);

// AND THAT THEY STAND ON THE FLOOR. Every instance's origin should be at the
// seabed, and the geometry's base is at y=0, so the lowest point of the bed is
// the floor itself — not somewhere above it, and not below.
box.setFromObject(group);
const floorY = seabedTopY();
floor.position.set(0, floorY, -3.5);
check('the bed sits on the seabed', Math.abs(box.min.y - floorY) < 0.05,
  `lowest plant at ${box.min.y.toFixed(3)}, floor at ${floorY.toFixed(3)}`);

// END TO END, measured against the walls the seal actually stops at rather
// than against the bed's own numbers — the point is that it reaches THEM.
check('the bed reaches both walls', box.min.x <= bounds.left && box.max.x >= bounds.right,
  `bed ${box.min.x.toFixed(1)}..${box.max.x.toFixed(1)}, walls ${bounds.left.toFixed(1)}..${bounds.right.toFixed(1)}`);

// --- photograph it ----------------------------------------------------------
// FRAMED OFF THE BED, not off a written-down view height. The bed runs wall to
// wall and the walls move with the aspect ratio, so a fixed frame crops the
// ends off — which is the one thing this shot exists to show.
const span = box.max.x - box.min.x;
const VIEW_W = span * 1.04;
const VIEW_H = VIEW_W * (H / W);
const wide = new THREE.OrthographicCamera(
  -VIEW_W / 2, VIEW_W / 2, VIEW_H / 2, -VIEW_H / 2, -200, 200,
);
wide.position.set((box.max.x + box.min.x) / 2, floorY + VIEW_H * 0.34, 40);

shot('The bed', `${bed.length} plants across ${span.toFixed(0)} world units, wall to wall. `
  + `${draws.length} draws, ${tris.toLocaleString()} triangles. Floor line drawn at y=${floorY.toFixed(1)}.`, wide);

// A close pass, at the size a plant is actually drawn next to the seal (1.68
// units long). The wide shot cannot answer whether an individual plant survived
// being decimated to a few hundred triangles.
const CLOSE = 7;
const close = new THREE.OrthographicCamera(
  -CLOSE * (W / H) / 2, CLOSE * (W / H) / 2, CLOSE / 2, -CLOSE / 2, -200, 200,
);
close.position.set(box.min.x + span * 0.5, floorY + CLOSE * 0.34, 40);
shot('Close', 'Roughly the scale the seal is drawn at — a seal is 1.68 units long.', close);

// --- the current ------------------------------------------------------------
// THE SWAY, which is the one thing on this page that a single still cannot
// show. The plants bend in a vertex shader (systems/grassSway.js) and the
// shells do not, and both halves of that are invisible in one frame.
//
// FORCED ON HERE regardless of CONFIG. The saved tuning may well have
// grass.sway.enabled false — it does at the time of writing — and a shot of a
// disabled sway is a photograph of nothing that looks exactly like a shot of a
// broken one. This page writes nothing and owns its own CONFIG copy for the
// duration, so turning it on costs the tuning nothing. Free-running rather than
// beat-synced for the same reason: nothing here ticks the beat transport, and a
// synced sway would sit still while looking deliberate.
const swayWas = { ...CONFIG.grass.sway };
CONFIG.grass.sway.enabled = true;
CONFIG.grass.sway.speedSync = 'free';
applyGrassSettings();

// Half a cycle apart at the configured rate: the two extremes of the lean,
// which is the widest the bed ever gets and therefore the frame where blades
// sliding through each other would show.
const halfCycle = Math.PI / CONFIG.grass.sway.speed;
shot('Current, one way', 'The sway forced on. Plants bend, shells do not — the bend is masked on each '
  + "plant's own height, so the base stays planted.", close);
updateGrassSway(halfCycle);
shot('Current, the other', `Half a cycle later (${halfCycle.toFixed(2)}s at ${CONFIG.grass.sway.speed} rad/s). `
  + 'Every plant leans the same way despite each one carrying a random yaw — that is the counter-rotation '
  + 'through the instance basis. Any shell that moved between these two frames is a bug.', close);

// A picture cannot assert. Diffing the two frames can: if nothing moved, the
// sway compiled and did nothing, which is exactly how a broken injection reads.
const frameA = document.createElement('canvas');
const cells = [...sheetEl.querySelectorAll('canvas')];
const [ca, cb] = cells.slice(-2);
frameA.width = ca.width; frameA.height = ca.height;
const pa = ca.getContext('2d').getImageData(0, 0, ca.width, ca.height).data;
const pb = cb.getContext('2d').getImageData(0, 0, cb.width, cb.height).data;
let moved = 0;
for (let i = 0; i < pa.length; i += 4) {
  if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 24) moved++;
}
const movedPct = (moved / (pa.length / 4)) * 100;
check('the bed actually moves between the two phases', movedPct > 0.15,
  `${movedPct.toFixed(2)}% of pixels changed`);
check('...and it is a bend, not the whole bed sliding', movedPct < 25,
  `${movedPct.toFixed(2)}% — much more than this means the roots are moving too`);

Object.assign(CONFIG.grass.sway, swayWas);
applyGrassSettings();

// The same bed with the shells and the small stuff turned off, so the tall
// species can be judged on their own silhouettes. Different weights, same
// seed: the layout is identical and only the planting changes.
clearSeabed();
CONFIG.seabed.species = { kelp: 1, ribbonweed: 1, bladegrass: 1, fern: 1, reed: 1, fanweed: 1, coral: 1, broadleaf: 1 };
scatterSeabed(scene);
shot('Even mix', 'Every species at equal weight and the shells off — the same seed, so the same positions.', wide);

await Promise.all(posted);
log(fails ? `\n${fails} failed` : '\nall passed', fails ? 'bad' : 'ok');
document.title = fails ? `seabed: ${fails} FAILED` : `seabed: ok (${bed.length} plants)`;
