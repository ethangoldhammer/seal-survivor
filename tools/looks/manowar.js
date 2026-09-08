// ---------------------------------------------------------------------------
// MAN O' WAR — the rig, posed
//
//   npm run looks:manowar
//
// tools/manowar-rig-test.mjs proves the skin works in numbers: every strand
// moves 48-93% of its own span and drags nothing else more than 1.2% of the
// model. Numbers cannot tell you whether eighteen filaments trailing off one
// float READS as a man o' war, and that is the only remaining question about
// this rig — so this puts it on screen and lets you turn it over.
//
// WHY THE DRIFT IS NOT THE ANIMAL'S MOTION. Nothing authors motion for this
// creature yet: it has no enemies.csv def, no assets.csv row and no behaviour.
// The sine below is a PROBE whose whole job is to make the deformation visible,
// and it says so on the page. Dressing it up as the real thing would be the
// worst outcome here — a look page that quietly becomes the design.
//
// It loads the .glb straight off the server rather than through assets.js. That
// is not a shortcut: assets.js needs an assets.csv row (an asset with no row
// spawns at size 1), and going through it would put this page's picture at the
// mercy of a row that does not exist. The file is the subject.
//
// IT WRITES NOTHING — a vite build with no dev server behind it and no save
// path. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CONFIG } from '../../path/src/config.js';
import { createTentacleRig } from '../../path/src/systems/tentacleRig.js';

const stage = document.getElementById('stage');
const gl = new THREE.WebGLRenderer({ antialias: true });
gl.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(gl.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);

// SIZED OFF THE ELEMENT, WATCHED — not off innerWidth at module-eval time. The
// first version read innerWidth once on load and the canvas came up 0x0,
// because the script ran before the window had laid out: setSize(0, 0) is not
// an error, it is a renderer that draws nothing into a canvas with no pixels,
// and the panel beside it renders perfectly so the page looks half-alive
// rather than broken. A ResizeObserver is also the only thing that survives
// the window being dragged to another size, which the load-time listener it
// replaced could miss entirely if the resize landed before its own registration.
function fit() {
  const w = stage.clientWidth || 1;
  const h = stage.clientHeight || 1;
  gl.setSize(w, h, false);
  gl.domElement.style.width = '100%';
  gl.domElement.style.height = '100%';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(fit).observe(stage);
fit();

const orbit = new OrbitControls(camera, gl.domElement);
orbit.enableDamping = true;

// Three lights and no environment. A clear-glass animal shows its FORM through
// specular shape, so the key is high and to one side, the fill is cold and low
// to keep the filaments from going black against the background, and the rim
// sits behind to separate eighteen overlapping tubes from each other.
scene.add(new THREE.AmbientLight(0x4a6fa5, 0.6));
const key = new THREE.DirectionalLight(0xdfefff, 2.2); key.position.set(3, 5, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0x6bb6ff, 1.4); rim.position.set(-2, -1, -5); scene.add(rim);

const gltf = await new GLTFLoader().loadAsync('/models/manowar.glb');
const model = gltf.scene;
scene.add(model);

let mesh = null;
model.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
if (!mesh) throw new Error('no SkinnedMesh in manowar.glb — the rig did not survive the export');
mesh.frustumCulled = false; // a curled filament leaves the bind-pose bounds

// Frame the animal by FITTING ITS BOX to the frustum — the WIDTH against the
// horizontal half-angle and the HEIGHT against the vertical one, standing off
// at whichever of the two demands more room.
//
// Not a multiple of the model's size, which is what a hand-tuned framing looks
// like and only holds at the one window shape it was tuned in. And not the
// bounding SPHERE either, which is the tempting one-liner and is wrong here for
// a reason worth stating: a sphere has one radius, so fitting it means fitting
// the model's LONGEST axis against the frustum's NARROWEST angle. This animal
// is 5.7 tall and about 2 wide, so in a tall narrow window that fits its height
// against the width of the frame and parks the camera four times too far back —
// which is exactly what it did, and it reads as a broken renderer rather than
// as a framing mistake, because all you see is an empty page.
const box = new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3());
orbit.target.copy(box.getCenter(new THREE.Vector3()));
function frameAll() {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = Math.max(
    (size.y / 2) / Math.tan(vFov / 2),
    (size.x / 2) / Math.tan(hFov / 2),
  ) * 1.15 + size.z / 2; // half the depth, so the near face is not already past the camera
  const dir = camera.position.clone().sub(orbit.target);
  if (dir.lengthSq() < 1e-6) dir.set(0.35, 0.12, 1);
  camera.position.copy(orbit.target).add(dir.setLength(dist));
  orbit.update();
}
frameAll();
// Re-frame on a resize as well: the distance that fits a tall window does not
// fit a wide one, and a page that opens correctly and then empties itself when
// you widen the window is the same bug arriving later.
new ResizeObserver(frameAll).observe(stage);

// The chains, read back off the bone names — the same fact tools/rig-manowar.mjs
// wrote and tools/manowar-rig-test.mjs checks, so all three agree by construction.
const bones = mesh.skeleton.bones;
const chains = new Map(); // strand id -> bones, root first
for (const b of bones) {
  const m = /^strand(\d+)_(\d+)$/.exec(b.name);
  if (!m) continue;
  const id = Number(m[1]);
  if (!chains.has(id)) chains.set(id, []);
  chains.get(id)[Number(m[2])] = b;
}
const strandIds = [...chains.keys()].sort((a, b) => a - b);
const restQ = bones.map((b) => b.quaternion.clone());

// THE REAL DRIVER, imported rather than reimplemented. That is the whole point
// of running it here: systems/tentacleRig.js is what poses the filaments in the
// game, and tools/tentacle-rig-test.mjs can only test it against a skeleton
// built by hand — no GLB loads in Node. This page is the only place the driver
// meets the actual 93 bones it was written for.
const rig = createTentacleRig(model);
if (!rig) console.error('no tentacle chains found on this model');

const skeleton = new THREE.SkeletonHelper(model);
skeleton.visible = false;
scene.add(skeleton);

// A second, wireframe copy of the mesh rather than a material swap: the shell
// is transparent, and toggling `wireframe` on a BLEND material gives a tangle
// with no depth to it at all. Sharing the geometry AND the skeleton means the
// wire deforms with the animal instead of hanging in the bind pose behind it.
const wire = new THREE.SkinnedMesh(mesh.geometry, new THREE.MeshBasicMaterial({
  color: 0x2f8fd8, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false,
}));
wire.bind(mesh.skeleton, mesh.bindMatrix);
wire.frustumCulled = false;
wire.visible = false;
model.add(wire);

// --- panel -----------------------------------------------------------------
const state = { drift: true, skeleton: false, wire: true, body: true, amp: 0.22, speed: 0.55, solo: -1, size: 1 };

let tris = 0;
model.traverse((o) => { if (o.isMesh && o !== wire) tris += o.geometry.index.count / 3; });
// A live clock in the stats block. It is here because a page whose animation
// has stopped looks exactly like a page whose animation is very slow, and both
// look like a correctly rendered still — the tick is the only thing that tells
// the three apart at a glance.
const clockEl = document.createElement('div');
clockEl.className = 'stat';
document.getElementById('stats').innerHTML = [
  ['triangles', tris.toLocaleString()],
  ['vertices', mesh.geometry.attributes.position.count.toLocaleString()],
  ['bones', bones.length],
  ['strands', strandIds.length],
].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
document.getElementById('stats').appendChild(clockEl);

const toggles = document.getElementById('toggles');
for (const [key2, label] of [['body', 'the animal'], ['wire', 'wireframe'], ['skeleton', 'skeleton'], ['drift', 'drift']]) {
  const l = document.createElement('label');
  const cb = document.createElement('input');
  cb.autocomplete = 'off';
  cb.type = 'checkbox';
  cb.checked = state[key2];
  cb.onchange = () => { state[key2] = cb.checked; };
  l.append(cb, document.createTextNode(label));
  toggles.appendChild(l);
}

const sliders = document.getElementById('sliders');
for (const [key2, label, min, max] of [['amp', 'amplitude', 0, 0.6], ['speed', 'speed', 0, 2]]) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  const cap = document.createElement('span');
  const r = document.createElement('input');
  // autocomplete=off for the reason the game's own debug picker carries it
  // (path/src/ui/upgradeDebug.js): a reload otherwise restores the BROWSER's
  // idea of a control's value while the module's state says something else,
  // and the slider then reads a number the shader is not using. Caught here as
  // amplitude showing 0.501 against a CONFIG default of 0.18.
  r.autocomplete = 'off';
  r.autocomplete = 'off';
  r.type = 'range'; r.min = min; r.max = max; r.step = (max - min) / 100; r.value = state[key2];
  const draw = () => { cap.innerHTML = `<span>${label}</span><b>${Number(r.value).toFixed(2)}</b>`; };
  r.oninput = () => { state[key2] = Number(r.value); draw(); };
  draw();
  wrap.append(cap, r);
  sliders.appendChild(wrap);
}

const reset = document.createElement('button');
reset.textContent = 'reset view';
reset.onclick = frameAll;
toggles.appendChild(reset);

// THE SHADER'S OWN NUMBERS, written straight onto CONFIG.tentacleSway — the
// same object the game reads, so what is tuned here is what ships. They are all
// LOOKS, which is why they are allowed on sliders at all: the sting the
// filaments appear to swing is a circle in combat.js and reads none of them.
const swayWrap = document.getElementById('sway');
const SWAY_ROWS = [
  ['rate', 0, 3, 'the whole animal\'s tempo'],
  ['amplitude', 0, 0.8, 'peak bend per bone, in radians'],
  ['lag', 0, 2, 'phase lag DOWN the chain — 0 bends the whole filament at once'],
  ['spread', 0, 3.2, 'phase offset between neighbouring strands'],
  ['roll', 0, 1.5, 'the second axis, as a fraction of amplitude'],
  ['rollRate', 0, 2, 'how fast the roll runs against the sway'],
  ['hold', 0, 1, 'how much bend the CROWN keeps — 0 welds it rigid'],
];
for (const [key, min, max, hint] of SWAY_ROWS) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  const cap = document.createElement('span');
  const r = document.createElement('input');
  // autocomplete=off for the reason the game's own debug picker carries it
  // (path/src/ui/upgradeDebug.js): a reload otherwise restores the BROWSER's
  // idea of a control's value while the module's state says something else,
  // and the slider then reads a number the shader is not using. Caught here as
  // amplitude showing 0.501 against a CONFIG default of 0.18.
  r.autocomplete = 'off';
  r.type = 'range'; r.min = min; r.max = max; r.step = (max - min) / 200;
  r.value = CONFIG.tentacleRig[key];
  r.title = hint;
  const draw = () => { cap.innerHTML = `<span title="${hint}">${key}</span><b>${Number(r.value).toFixed(3)}</b>`; };
  r.oninput = () => { CONFIG.tentacleRig[key] = Number(r.value); draw(); };
  draw();
  wrap.append(cap, r);
  swayWrap.appendChild(wrap);
}

// SIZE IS A PREVIEW HERE AND NOWHERE ELSE. It scales the model on this page and
// writes nothing: spawn size lives in path/src/assets.csv, and the panel slider
// that used to set it was made read-only on purpose, because the hitbox is
// derived from the visual scale — it decides how big a creature is to HIT as
// well as to see, and it drifted badly while it was live (a crab reached 10.46
// with nothing in the repo recording that anyone meant it). So this is for
// judging the number by eye; the number itself goes in the CSV.
const sizeWrap = document.createElement('div');
sizeWrap.className = 'slider';
const sizeCap = document.createElement('span');
const sizeR = document.createElement('input');
sizeR.autocomplete = 'off';
sizeR.type = 'range'; sizeR.min = 0.25; sizeR.max = 3; sizeR.step = 0.01; sizeR.value = 1;
const BASE_SIZE = 4.2; // enemyManOWar's row in assets.csv today
const drawSize = () => {
  const v = Number(sizeR.value);
  const csv = BASE_SIZE * v;
  sizeCap.innerHTML = `<span>assets.csv size</span><b>${csv.toFixed(2)}</b>`;
  document.getElementById('sizeNote').textContent =
    `${(2 * csv).toFixed(1)} world units long · boss ${(2 * csv * 2.6).toFixed(1)} · seal is 2.6`;
};
sizeR.oninput = () => { model.scale.setScalar(Number(sizeR.value)); drawSize(); };
drawSize();
sizeWrap.append(sizeCap, sizeR);
document.getElementById('sizebox').appendChild(sizeWrap);

const solo = document.getElementById('solo');
solo.autocomplete = 'off';
solo.innerHTML = `<option value="-1">all ${strandIds.length} strands</option>`
  + strandIds.map((s) => `<option value="${s}">strand${s} — ${chains.get(s).length} bones</option>`).join('');
solo.onchange = () => { state.solo = Number(solo.value); paintList(); };

const listEl = document.getElementById('strands');
function paintList() {
  listEl.innerHTML = strandIds.map((s) => {
    const chain = chains.get(s);
    const tip = chain[chain.length - 1].getWorldPosition(new THREE.Vector3());
    return `<div class="${state.solo === s ? 'solo' : ''}"><span>strand${s}</span>`
      + `<span>${chain.length} bones · tip y ${tip.y.toFixed(2)}</span></div>`;
  }).join('');
}
paintList();

// --- the probe -------------------------------------------------------------
// One travelling wave per filament. The phase runs DOWN the chain so the curl
// arrives at the tip after the root — a filament that bends everywhere at once
// reads as a wire being rotated, not as something hanging in water — and each
// strand is offset by its own index so eighteen of them are never in step.
let t = 0;
let last = performance.now();
function frame(now = performance.now()) {
  t += Math.min((now - last) / 1000, 0.1) * state.speed; // clamped: a backgrounded tab returns a huge delta
  last = now;
  // The shipping driver, not a copy of it. `solo` still works because it is
  // applied AFTER: the rig poses every strand and this puts the muted ones back
  // on their rest quaternion, which is the only way to isolate one without
  // teaching the driver about a debug control.
  if (state.drift) rig?.update(Math.min((now - last + 0.0001) / 1000, 0.1), 0);
  else rig?.reset();
  if (state.solo >= 0) {
    for (const s of strandIds) {
      if (s === state.solo) continue;
      chains.get(s).forEach((b) => { b.quaternion.copy(restQ[bones.indexOf(b)]); });
    }
  }
  clockEl.innerHTML = `<span>drift t</span><b>${t.toFixed(2)}</b>`;
  mesh.visible = state.body;
  wire.visible = state.wire;
  skeleton.visible = state.skeleton;
  orbit.update();
  gl.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
