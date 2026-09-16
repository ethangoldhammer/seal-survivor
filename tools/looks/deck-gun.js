// ---------------------------------------------------------------------------
// DECK GUNS — LOOK DEV
//
//   npm run looks:deckgun
//
// The three moments a boat's gun has, and they were all invisible until now:
// the wind-up, the thing in the water, and the landing. See
// systems/boatShotFx.js for what each one is for, and CONFIG.boats.guns.fx for
// the numbers this page is here to judge.
//
// WHY A PAGE AND NOT A NODE HARNESS. All three are additive sprites over an
// HDR target, and the one question that matters about every one of them — is it
// bright enough to read against water, and does the bright pass pick it up — is
// a question about PIXELS AFTER THE POST CHAIN. tools/boat-guns-test.mjs can
// assert the state machine around them and does; it cannot see a light. Worse,
// systems/boatShotFx.js paints its falloff into a 2D canvas context and
// tools/dom-stub.mjs has none, so in Node every sprite on this page comes back
// null and the whole effect is a silent no-op that passes every check.
//
// EVERY FRAME GOES THROUGH createPost, not straight to the canvas. Bloom is
// most of what these are: `overdrive` is a peak-channel multiplier whose whole
// job is to clear CONFIG.bloom.threshold, and a raw render would show three
// flat discs and tell you nothing about whether any of them haloes.
//
// IT WRITES NOTHING. CONFIG is read off a throwaway bundle and there is no dev
// server behind this. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import { createVisual, preloadAssets, applySavedAssetLooks } from '../../path/src/assets.js';
import {
  dressBoatShot, boatTell, clearBoatTell, boatImpactFlash,
  updateBoatShotFx, resetBoatShotFx,
} from '../../path/src/systems/boatShotFx.js';

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
// WATER, not black. Every one of these is judged against the thing it is seen
// over, and the shot's halo especially: the whole complaint that produced it
// was that a dark fish over dark water is not a shot, it is nothing.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.MeshBasicMaterial({ color: 0x0a2436 }),
);
water.position.z = -400;
scene.add(water);

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
// A light is only in the drawn image: none of these moves a bounding box, and
// the two that animate do it entirely through material opacity and sprite
// scale, both of which a scene-graph assertion would report as "present" at
// every level including zero.
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
/**
 * How much light is in the frame, over the water it is drawn on.
 *
 * Summed rather than peaked: every one of these effects clips its own core to
 * white at its brightest (that is what `overdrive` past CONFIG.bloom.knee IS),
 * so a peak reads 255 for a pinprick and for a flare alike and cannot tell them
 * apart. The total is what grows when a light gets brighter OR bigger, which is
 * what all three of these do.
 */
function litness(img, region = null) {
  const x0 = region ? Math.max(0, Math.floor(region.x0 * img.width)) : 0;
  const x1 = region ? Math.min(img.width, Math.ceil(region.x1 * img.width)) : img.width;
  const y0 = region ? Math.max(0, Math.floor(region.y0 * img.height)) : 0;
  const y1 = region ? Math.min(img.height, Math.ceil(region.y1 * img.height)) : img.height;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i]; const g = img.data[i + 1]; const b = img.data[i + 2];
      // The flat water's own value, subtracted, so this counts only what was
      // ADDED over it — an additive sprite's whole contribution.
      sum += Math.max(0, r - 14) + Math.max(0, g - 42) + Math.max(0, b - 60);
      n++;
    }
  }
  return n ? sum / n : 0;
}
/** Pixels bright enough for the bright pass to pick up, as a fraction. */
function bloomingFraction(img) {
  const t = CONFIG.bloom?.threshold ?? 0.58;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const lum = (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / 255;
    if (lum > t) n++;
  }
  return n / (img.data.length / 4);
}

await preloadAssets();
applySavedAssetLooks();

const FX = CONFIG.boats.guns.fx;
log(`fx enabled: ${FX.enabled}`);
log(`tell: ${FX.tell.blinkFrom}->${FX.tell.blinkTo} blinks/s, overdrive ${FX.tell.overdrive}, `
  + `size = hull half-length x ${FX.tell.sizeMul} (min ${FX.tell.minSize})`);
log(`shot: overdrive ${FX.shot.overdrive}, size = the round's long axis x ${FX.shot.sizeMul} `
  + `clamped to ${FX.shot.minSize}..${FX.shot.maxSize}`);
log(`impact: overdrive ${FX.impact.overdrive}, size ${FX.impact.size} -> x${FX.impact.grow} over ${FX.impact.life}s`);
log(`bloom: threshold ${CONFIG.bloom?.threshold}, knee ${CONFIG.bloom?.knee}`);

// ===========================================================================
// THE TELL — a hull, and the light at its muzzle through one wind-up.
//
// Drawn on the real trawler because that is the hull it has to read against:
// an unlit near-black silhouette with a pale rim, which is the reason the tell
// is a light beside the boat rather than a flash ON it. A colour written into
// that hide would have to beat 0x0a1018 to be seen at all.
section('The tell <span>— one wind-up, quarter steps. The blink accelerates.</span>', 5);
const hull = createVisual('trawler');
hull.scale.multiplyScalar(CONFIG.boats.trawlerScale);
scene.add(hull);
hull.updateMatrixWorld(true);
const hullBox = new THREE.Box3().setFromObject(hull);
const hullSize = hullBox.getSize(new THREE.Vector3());
const hullCentre = hullBox.getCenter(new THREE.Vector3());
// Where systems/boats.js puts it: amidships, a little under the waterline.
const muzzle = new THREE.Vector3(hullCentre.x, hullBox.min.y - 0.3, 0);
frame(new THREE.Vector3(hullCentre.x, hullCentre.y - hullSize.y * 0.25, 0), hullSize.x * 1.5);

// THE BOTTOM THIRD OF THE FRAME, which is where the muzzle is. Measured over a
// region rather than the whole picture because the hull is most of what is lit
// in it — its pale rim alone outweighs the tell, so a whole-frame average
// answers "how bright is a trawler" and reports a tell that tripled in size as a
// 20% change. The failure mode is a check that cannot fail.
const MUZZLE_REGION = { x0: 0.25, x1: 0.75, y0: 0.55, y1: 1 };
const fakeBoat = {};
{
  const windup = CONFIG.boats.guns.windup;
  const halfLength = hullSize.x / 2;
  present('tell 0.00 — dark', `the hull with the gun at rest, ${hullSize.x.toFixed(1)} units long`);
  const dark = grab();

  const lit = [];
  const blooms = [];
  // Stepped at the game's own dt so the phase integrates exactly as it does in
  // a run — the blink's rate is climbing, so a phase computed from elapsed time
  // instead would stutter, and a page that took the shortcut would never see it.
  const steps = Math.round(windup / DT);
  const marks = [0.25, 0.5, 0.75, 1];
  let next = 0;
  // The PEAK over each quarter rather than the value at its boundary: the
  // light is blinking, so a sample landing in a trough would report the tell
  // getting dimmer as it winds up, which is the opposite of what it does.
  let peak = 0;
  let peakImg = null;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    boatTell(DT, scene, fakeBoat, muzzle.x, muzzle.y, muzzle.z, t, halfLength);
    const img = grab();
    const v = litness(img, MUZZLE_REGION);
    if (v > peak) { peak = v; peakImg = img; }
    if (next < marks.length && t >= marks[next]) {
      present(`tell ${marks[next].toFixed(2)}`, `brightest frame of this quarter — ${(peak).toFixed(1)} light at the muzzle`);
      lit.push(peak);
      blooms.push(bloomingFraction(peakImg));
      peak = 0;
      next++;
    }
  }
  check('the tell lights at all', lit[0] > litness(dark, MUZZLE_REGION) + 0.5,
    `${lit[0].toFixed(2)} vs a dark hull's ${litness(dark, MUZZLE_REGION).toFixed(2)}`);
  // IT GROWS INTO THE SHOT. Not merely present: a tell at one brightness for
  // its whole wind-up says "a boat is there", and the thing being told is WHEN.
  check('...and builds through the wind-up', lit[3] > lit[0] * 1.3,
    `${lit.map((v) => v.toFixed(1)).join(' -> ')}`);
  // AND IT HALOES. `overdrive` exists for exactly this and nothing else; a
  // number under the bright-pass threshold is a sprite that renders and does
  // not read. See the two normalisation notes in systems/beams.js.
  check('...brightly enough to cross the bloom threshold', blooms[3] > 0,
    `${(blooms[3] * 100).toFixed(3)}% of pixels over ${CONFIG.bloom?.threshold}`);
  clearBoatTell(scene, fakeBoat);
  check('and it goes out when the gun stands down',
    litness(grab(), MUZZLE_REGION) < litness(dark, MUZZLE_REGION) + 0.05,
    'a tell left burning over a gun that is not going to fire teaches the player the light means nothing');
}
scene.remove(hull);

// ===========================================================================
// THE SHOT — every round a hull throws, lit and unlit side by side.
section('The ordnance <span>— what a deck gun puts in the water, bare and dressed</span>', 5);
const ROUNDS = [
  ...CONFIG.boats.guns.tiers.map((t) => ({ label: t.id, asset: t.asset, scale: t.scale })),
  { label: 'mussel', asset: CONFIG.boats.guns.artillery.mussel.asset, scale: CONFIG.boats.guns.artillery.mussel.scale },
  { label: 'gull', asset: CONFIG.boats.guns.artillery.gull.asset, scale: CONFIG.boats.guns.artillery.gull.scale },
];
// The same arithmetic dressBoatShot does, so the page frames what it is about
// to draw rather than a guess at it — a cell cropped tighter than the halo
// reports a glow that runs off the edge as a dim one.
const haloSize = (size) => Math.min(FX.shot.maxSize,
  Math.max(FX.shot.minSize, Math.max(size.x, size.y) * FX.shot.sizeMul));
const haloView = (size) => Math.max(size.x, size.y, haloSize(size)) * 2;
const bare = new Map();
for (const r of ROUNDS) {
  const mesh = createVisual(r.asset);
  if (r.scale !== 1) mesh.scale.multiplyScalar(r.scale);
  // Nose down the flight, the way `orient` lays every one of these — a preview
  // that leaves a creature nose-up is measuring a body it never draws.
  mesh.rotation.z = -Math.PI / 2;
  scene.add(mesh);
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  frame(box.getCenter(new THREE.Vector3()), haloView(size));
  present(`${r.label} bare`, `${r.asset}, ${size.x.toFixed(2)} x ${size.y.toFixed(2)} units — what it looked like before`);
  bare.set(r.label, litness(grab()));
  scene.remove(mesh);
}
for (const r of ROUNDS) {
  const mesh = createVisual(r.asset);
  if (r.scale !== 1) mesh.scale.multiplyScalar(r.scale);
  mesh.rotation.z = -Math.PI / 2;
  scene.add(mesh);
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const sprite = dressBoatShot(mesh);
  check(`${r.label}: the halo was built`, !!sprite, sprite ? '' : 'dressBoatShot returned null — no 2D canvas?');
  frame(box.getCenter(new THREE.Vector3()), haloView(size));
  present(`${r.label} dressed`, `halo ${haloSize(size).toFixed(2)} units on a ${Math.max(size.x, size.y).toFixed(2)}-unit round`);
  const img = grab();
  // AGAINST THE SAME FRAME WITHOUT IT. A ratio over the whole cell is a test of
  // how dark the round already was — the gull is a pale bird and lights a
  // quarter of its own cell before anything is added to it, so it failed a 1.5x
  // threshold that the near-black mussel sailed through on almost no light at
  // all. The difference is what the halo put there.
  const added = litness(img) - bare.get(r.label);
  check(`${r.label}: it is visibly lit over water`, added > 1.5,
    `+${added.toFixed(1)} over a bare ${bare.get(r.label).toFixed(1)}`);
  // ONE NUMBER, EVERY ROUND. `size` is world units divided back out by the
  // root's scale, so the gull thrown at 0.3 and the sailfish at 0.45 wear the
  // same lamp. Divide by the wrong scale and the smallest round gets the
  // biggest halo, which reads as a bug in the art rather than in the maths.
  check(`${r.label}: ...and haloes`, bloomingFraction(img) > 0,
    `${(bloomingFraction(img) * 100).toFixed(3)}% of pixels over the threshold`);
  scene.remove(mesh);
}

// ===========================================================================
// THE LANDING — the pop, across its own short life.
section('The landing <span>— the pop on the seal, frame by frame</span>', 5);
{
  resetBoatShotFx(scene);
  const seal = createVisual('ship'); // the player's own body — see ASSETS.ship
  seal.rotation.z = -Math.PI / 2;
  scene.add(seal);
  seal.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(seal);
  const size = box.getSize(new THREE.Vector3());
  const at = box.getCenter(new THREE.Vector3());
  frame(at, Math.max(size.x, FX.impact.size * FX.impact.grow) * 1.8);
  // THE SEAL IS PALE HERE and it is not in the game. This page draws the bare
  // `ship` asset with no run shading on it, so the body is near-white — and the
  // pop is ADDITIVE, so over white it adds nothing visible and reads as a ring
  // around the animal rather than a flash on it. In a run the seal is a shaded
  // body and the light lands on it. Judge the pop's SIZE and its FALL here; its
  // brightness against the seal is a question for the game.
  present('landing 0.00 — before', 'the seal, un-hit — pale because this is the bare asset, see the note in the source');

  // At the seal's own depth, the way combat.js hands it the bullet's z — the
  // standoff that clears the body is the effect's own, not the caller's.
  boatImpactFlash(scene, at.x + size.x * 0.2, at.y, at.z);
  const life = FX.impact.life;
  const lit = [];
  const seen = [];
  for (const u of [0.02, 0.3, 0.6, 0.92]) {
    // Stepped FORWARD from wherever the last sample left it, so the sequence is
    // one pop running rather than four pops sampled.
    const want = life * u;
    const already = seen.length ? seen[seen.length - 1] : 0;
    for (let t = already; t < want - 1e-9; t += DT) updateBoatShotFx(Math.min(DT, want - t), scene);
    seen.push(want);
    present(`landing ${u.toFixed(2)}`, `${(want * 1000).toFixed(0)}ms into a ${(life * 1000).toFixed(0)}ms pop`);
    lit.push(litness(grab()));
  }
  check('the landing is bright at once', lit[0] > lit[3] * 2,
    `${lit.map((v) => v.toFixed(1)).join(' -> ')} — it is an answer to "what just hit me", not an animation`);
  check('...and is gone inside a fifth of a second', life <= 0.25, `${life}s`);
  // Run it out and check the pool took it back. A flash that is never released
  // presents as the effect quietly running out of sprites over a long run —
  // late, silently, and only in a game that has been played for a while.
  for (let t = 0; t < life + DT * 2; t += DT) updateBoatShotFx(DT, scene);
  check('...and hands its sprite back', litness(grab()) < lit[3] + 0.05,
    'nothing left drawn once the pop is spent');
  scene.remove(seal);
}

// ===========================================================================
check('no shader compiled with an error', shaderErrors.length === 0, shaderErrors[0] ?? '');

await Promise.all(posted);
log(`\n${fails ? `FAILED — ${fails} check(s)` : 'PASS — all checks'}`, fails ? 'bad' : 'ok');
document.title = fails ? `DECK GUNS — ${fails} FAILED` : 'DECK GUNS — pass';
