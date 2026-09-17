// ---------------------------------------------------------------------------
// HEEL — LOOK DEV
//
//   npm run looks:heel
//
// Every hull in the ocean rocks laterally while it sails — about the axis it
// is travelling along, so the deck swings toward the lens and away again. This
// page is where that is judged, and where the axis is proved.
//
// WHY A PAGE AND NOT A NODE HARNESS. No .glb loads in Node, so a terminal test
// can only rotate a hand-built box — and a box has no deck, no rail and no
// mast, which is the entire thing this motion exists to show. Worse, a box is
// symmetric enough that heeling it about the WRONG axis looks fine: rotating a
// hull about its beam instead of its length foreshortens it end-on, which on a
// stand-in cube is invisible and on the real trawler is a boat pointing at the
// camera. The check below measures that against the real geometry.
//
// It also makes the amplitude judgeable. The numbers are radians, and radians
// are not a thing anybody has an opinion about until they are a picture: the
// strip shows one full cycle so the peak and the pace can be read together.
//
// IT WRITES NOTHING. CONFIG is read off a throwaway bundle and there is no dev
// server behind this. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import {
  createVisual, preloadAssets, applySavedAssetLooks, ensureAssetLoaded,
} from '../../path/src/assets.js';

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

const W = 340;
const H = 260;
const DT = 1 / 60;

const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Sky, because that is what a boat is seen against — these hulls are unlit
// near-black silhouettes on the horizon line and a heel judged over black is a
// heel judged against nothing.
const sky = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.MeshBasicMaterial({ color: 0x183450 }),
);
sky.position.z = -400;
scene.add(sky);

// The game's own rig, read from CONFIG rather than invented. It matters more
// here than on most pages: the whole claim being tested is that turning the
// deck toward the light changes how the hull is shaded.
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

await preloadAssets();
applySavedAssetLooks();

// THE YACHT IS NOT BUILT AT BOOT (`defer: true` — 4.6MB that only a boss ever
// wears), so preloadAssets leaves it out and createVisual hands back the
// primitive stand-in instead: a plain box, which passes every geometric check
// on this page while proving nothing about the hull. It is also the ONE hull
// whose length runs down a different model axis from the other two, which is
// to say the only one where the axis question has a real answer. Fetched by
// hand here, and reported, so a page that fell back to the box says so out
// loud rather than drawing an orange brick and calling it a boat.
const built = [];
for (const key of ['bossYacht']) {
  const ok = await ensureAssetLoaded(key);
  check(`${key}: the deferred model was fetched, not stood in for`, ok,
    ok ? 'loaded' : 'fell back to the primitive box — every measurement below is of a cube');
}

// ===========================================================================
// WHAT EACH HULL ROCKS BY. Read out of CONFIG rather than restated, so this
// page can never quietly disagree with the game: every one of these keys is a
// slider, and a page holding its own copy of the number is a page judging
// something nobody is running.
const HULLS = [
  { key: 'boat', amount: CONFIG.boats.heelAmount, speed: CONFIG.boats.heelSpeed, from: 'CONFIG.boats' },
  { key: 'trawler', amount: CONFIG.boats.heelAmount, speed: CONFIG.boats.heelSpeed, from: 'CONFIG.boats' },
  { key: 'bakalarBoat', amount: CONFIG.bakalar.heelAmount, speed: CONFIG.bakalar.heelSpeed, from: 'CONFIG.bakalar' },
  { key: 'bossBoat', amount: CONFIG.bossBoat.heelAmount, speed: CONFIG.bossBoat.heelSpeed, from: 'CONFIG.bossBoat' },
  { key: 'bossYacht', amount: CONFIG.bossBoat.heelAmount, speed: CONFIG.bossBoat.heelSpeed, from: 'CONFIG.bossBoat' },
];

const size = (o) => {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
};

// ===========================================================================
section('Level <span>— every hull that sails, at rest</span>', 5);
for (const h of HULLS) {
  const visual = createVisual(h.key);
  scene.add(visual);
  const level = size(visual);
  if (level.x < 1e-3) {
    check(`${h.key}: the model loaded`, false, 'nothing to measure');
    scene.remove(visual);
    continue;
  }

  // THE LENGTH RUNS ALONG X — which is what makes rotation.x a heel and not a
  // pitch. Three different bases get these hulls there (assets.js maps the
  // rowboat, the trawler and the yacht each their own way), and getting one
  // wrong does not throw: the boat simply rocks end-over-end instead, swinging
  // its bow at the camera. The only honest test is the built geometry.
  check(`${h.key}: the hull is longest along X, so rotation.x rolls it about its length`,
    level.x > level.y && level.x > level.z,
    `${level.x.toFixed(1)} long x ${level.y.toFixed(1)} tall x ${level.z.toFixed(1)} beam`);

  frame(new THREE.Box3().setFromObject(visual).getCenter(new THREE.Vector3()),
    Math.max(level.x, level.y) * 1.2);
  present(h.key, `${h.from}: heel ${h.amount} rad at ${h.speed} rad/s`);
  built.push({ ...h, visual, level });
  visual.visible = false;
}

// ===========================================================================
// THE HEEL ITSELF, one hull, a full cycle in eight steps. Read as a strip: the
// question is not whether any one frame looks right but whether the deck comes
// into view and goes again at a pace that reads as water rather than as a
// wobble.
const star = built.find((b) => b.key === 'trawler') ?? built[0];
if (star) {
  section('One cycle <span>— the trawler, eight steps through its own heel</span>', 8);
  star.visual.visible = true;
  frame(new THREE.Box3().setFromObject(star.visual).getCenter(new THREE.Vector3()),
    Math.max(star.level.x, star.level.y) * 1.2);
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    star.visual.rotation.x = Math.sin(t) * star.amount;
    present(`cycle ${i + 1} of 8`, `heel ${(Math.sin(t) * star.amount).toFixed(3)} rad`);
  }
  star.visual.rotation.x = 0;
  star.visual.visible = false;
}

// ===========================================================================
// AT THE PEAK, every hull, against itself at rest — the comparison the
// amplitude is actually chosen on.
section('At full heel <span>— each hull at the top of its own rock</span>', 5);
for (const b of built) {
  b.visual.visible = true;
  b.visual.rotation.x = b.amount;
  const heeled = size(b.visual);

  // THE LENGTH IS UNTOUCHED AND THE HEIGHT IS NOT. That pair is the whole
  // definition of a heel: rolling about the length cannot shorten the boat,
  // and it must swing the deck through the vertical. Rotating about the wrong
  // axis fails the first; a rotation that never got applied fails the second,
  // and both of those render as a boat that simply sails past looking fine.
  check(`${b.key}: heeling does not shorten the hull`,
    Math.abs(heeled.x - b.level.x) < Math.max(0.02, b.level.x * 0.005),
    `${b.level.x.toFixed(2)} -> ${heeled.x.toFixed(2)}`);
  check(`${b.key}: ...and it does swing the deck through the vertical`,
    Math.abs(heeled.y - b.level.y) > 1e-3,
    `${b.level.y.toFixed(3)} -> ${heeled.y.toFixed(3)} tall`);

  frame(new THREE.Box3().setFromObject(b.visual).getCenter(new THREE.Vector3()),
    Math.max(b.level.x, b.level.y) * 1.2);
  present(`${b.key} heeled`, `${b.amount} rad — ${(b.amount * 180 / Math.PI).toFixed(1)}°`);
  b.visual.rotation.x = 0;
  b.visual.visible = false;
}

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nheel: all checks passed', fails ? 'bad' : 'ok');
