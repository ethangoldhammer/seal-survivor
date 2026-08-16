// ---------------------------------------------------------------------------
// CRAB REACH — the pinch, frame by frame
//
//   npm run looks:crab
//
// The question: the claw mechanic passes every check in tools/crab-claw-test.mjs
// and is reported as never being seen in play. Numbers cannot settle that. This
// draws the gesture on the REAL rig, at the REAL gate distances, with the three
// radii that decide it drawn on the floor underneath — so "does the claw reach
// the seal" stops being a number and becomes something you look at.
//
// Every distance on this page comes from the shipping code:
//   * the crab is createVisual('enemyWalkingCrab') — crabpincer.glb, fit and
//     size multiplier included, the same instance a spawn builds
//   * the arm is measured by the driver's own reach(), not by this page
//   * the two rings are pinchReach() called exactly as entities/enemies.js
//     calls it for the commit gate and as systems/combat.js calls it for the
//     damage check — the pair that has to agree, and that silently disagreed
//     once before
//
// The seal is a plain sphere at CONFIG.player.hitRadius. It is not the seal
// model on purpose: the thing being looked at is WHERE THE CLAW ENDS UP against
// the body it is aiming at, and a rendered seal invites judging the animation
// instead of the distance.
//
// IT WRITES NOTHING — a vite build with no dev server behind it and no save
// path. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { createAnimationController, stateForSpeed } from '../../path/src/systems/animation.js';
import { createClawDriver, pinchReach } from '../../path/src/systems/crabClaw.js';

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

const W = 460;
const H = 340;
const DT = 1 / 60;

// One WebGL context for the whole page, blitted into a 2D canvas per cell —
// a renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070c16);
scene.add(new THREE.AmbientLight(0xffffff, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 6, 8);
scene.add(key);

await preloadAssets();

// --- the crab, built the way a spawn builds one -----------------------------
const visual = createVisual('enemyWalkingCrab');
scene.add(visual);
const anim = createAnimationController(visual);
const claw = createClawDriver(visual);

check('the claw driver built off the real skeleton', claw != null);
const rig = visual.userData?.clawRig;
check('both arms resolved', rig?.arms?.length === 2, `${rig?.arms?.length ?? 0} declared`);

// A frame of the real update order: the mixer writes the walk, then the driver
// poses over the top of it. Reversed, the mixer overwrites the reach and
// nothing visible happens.
function frame(aim) {
  anim?.update(DT, stateForSpeed(3), false);
  claw?.update(DT, aim);
  visual.updateMatrixWorld(true);
}

// One frame before anything is asked of it: reach() needs the skeleton posed
// and its world matrices current, and a 0 here would switch the mechanic off.
frame(null);

const armReach = claw.reach();
const playerR = CONFIG.player.hitRadius;
const pc = CONFIG.crabClaw;
// The two numbers the whole mechanic lives between, each asked for exactly the
// way its own caller asks. If these two ever cross, the crab commits to a
// gesture that cannot bill damage — which is how it died the first time.
const commit = pinchReach(armReach, playerR, pc.commitRange ?? 0.55);
const reach = pinchReach(armReach, playerR, pc.range ?? 0.65);

check('the arm measures a real reach', armReach > 0, `${armReach.toFixed(2)} world units`);
check('the pinch reaches further than it commits at', reach > commit,
  `commit ${commit.toFixed(2)}, reach ${reach.toFixed(2)}`);

// HOW BIG THE CRAB ACTUALLY IS, measured off the posed instance rather than
// read out of a config. `fit` is the model's longest axis in world units and
// the assets.csv multiplier scales the whole instance on top of it, so neither
// number alone says how much floor this thing covers — and every range on this
// page is measured from its CENTRE, which only means something next to its
// silhouette. See the note in assets.csv about the multiplier.
const box = new THREE.Box3().setFromObject(visual);
const span = new THREE.Vector3();
box.getSize(span);
const bodyR = Math.max(span.x, span.z) / 2;

log('');
log(`arm ${armReach.toFixed(2)}  ·  player radius ${playerR}  ·  commit ${commit.toFixed(2)}  ·  damage ${reach.toFixed(2)}`);
log(`crab silhouette ${span.x.toFixed(2)} x ${span.z.toFixed(2)} on the floor, ${span.y.toFixed(2)} tall — half-width ${bodyR.toFixed(2)}`);
log(`gesture ${(pc.windup + pc.strike + pc.recover).toFixed(2)}s — windup ${pc.windup} / strike ${pc.strike} / recover ${pc.recover}`);
log('');

check('the pinch gate is outside the crab, not under it', commit > bodyR,
  `gate ${commit.toFixed(2)} against a body half-width of ${bodyR.toFixed(2)}`);

// --- the floor, and the four radii on it ------------------------------------
//
// Drawn as rings around the CRAB, because every one of them is measured from
// the crab: this is the picture of what standing at a given distance buys you.
function ring(radius, color, opacity) {
  const g = new THREE.RingGeometry(radius - 0.035, radius + 0.035, 96);
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  return mesh;
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(bodyR * 8, bodyR * 8),
  new THREE.MeshStandardMaterial({ color: 0x101a2b, roughness: 1 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
scene.add(ring(bodyR, 0x8f6fd8, 0.7));      // where the crab's own silhouette ends
scene.add(ring(playerR, 0x4a5f7d, 0.75));   // touching: contact damage already applies
scene.add(ring(commit, 0xffc46b, 0.95));    // the gate: the pinch starts here
scene.add(ring(reach, 0xff7a5c, 0.95));     // the furthest the pinch can bill damage

// --- the seal ---------------------------------------------------------------
const seal = new THREE.Mesh(
  new THREE.SphereGeometry(playerR, 32, 24),
  new THREE.MeshStandardMaterial({ color: 0x5fd6ff, roughness: 0.4, emissive: 0x123044 }),
);
seal.position.y = playerR;
scene.add(seal);

// Where the claw tip actually is, so the filmstrip shows the reach closing
// rather than only the pose.
const _tip = new THREE.Vector3();
function clawTip() {
  const spec = rig?.arms?.[0];
  const tip = spec && visual.getObjectByName(spec.tip);
  if (!tip) return null;
  return tip.getWorldPosition(_tip.clone());
}

// --- camera -----------------------------------------------------------------
// Framed off the crab's measured span rather than by hand: the body is several
// times the size of every range drawn under it, and a camera placed for the
// rings puts the animal off the edge of the panel.
const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 200);
// The crab is TALLER than every range on the floor is wide (6.44 against a
// 2.43 reach), so the height is what sets the framing, not the rings.
const back = Math.max(span.y, (reach + playerR) * 2) * 1.75;
camera.position.set(back * 0.30, back * 0.40, back * 0.92);
camera.lookAt(1.1, span.y * 0.28, 0);

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];

function cell(title, caption, hit) {
  const wrap = document.createElement('div');
  wrap.className = `cell${hit ? ' hit' : ''}`;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(gl.domElement, 0, 0);
  wrap.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = caption;
  wrap.appendChild(cap);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
  return wrap;
}

function row(heading, sub) {
  const h = document.createElement('h2');
  h.innerHTML = sub ? `${heading} <span>${sub}</span>` : heading;
  sheetEl.appendChild(h);
  const r = document.createElement('div');
  r.className = 'row';
  sheetEl.appendChild(r);
  return r;
}

const _aim = new THREE.Vector3();

/**
 * Put the seal at `dist` from the crab, ask for a pinch the way enemies.js
 * does, then run the gesture and shoot it at the given elapsed times.
 */
function pinchAt(dist, shots, heading, sub) {
  // A fresh gesture each time: the driver refuses a re-fire mid-pinch.
  while (claw.isStriking()) frame(null);
  for (let i = 0; i < 20; i++) frame(null); // settle back into the walk

  seal.position.set(dist, playerR, 0);
  _aim.set(seal.position.x, seal.position.y, 0);

  const gated = dist < commit;
  const fired = gated ? claw.strike() : false;

  const r = row(heading, sub);
  let t = 0;
  let closest = Infinity;
  const want = [...shots].sort((a, b) => a - b);
  for (const at of want) {
    while (t < at - 1e-6) { frame(_aim); t += DT; const tip = clawTip(); if (tip) closest = Math.min(closest, tip.distanceTo(seal.position)); }
    gl.render(scene, camera);
    const tip = clawTip();
    const gap = tip ? tip.distanceTo(seal.position) : NaN;
    const touching = gap <= playerR;
    r.appendChild(cell(
      `${heading}-${at.toFixed(2)}`,
      `<b>${at.toFixed(2)}s</b> — claw tip to seal <b>${gap.toFixed(2)}</b>`
      + (touching ? ' <span class="tag">CONTACT</span>' : ''),
      touching,
    ));
  }
  return { fired, closest };
}

// --- 1. standing at the gate, which is where a crab commits -----------------
const atGate = pinchAt(
  commit - 0.02,
  [0, 0.21, 0.42, 0.5, 0.58, 0.75, 0.92],
  'At the commit gate',
  `seal at ${(commit - 0.02).toFixed(2)} — the first distance a crab will start a pinch from`,
);
check('a pinch fires at the gate', atGate.fired === true);
check('and the claw reaches the seal from there',
  atGate.closest <= playerR, `closest approach ${atGate.closest.toFixed(2)} against radius ${playerR}`);

// --- 2. one step further out, which must NOT fire ---------------------------
const outside = pinchAt(
  commit + 0.6,
  [0, 0.42, 0.58, 0.92],
  'Half a body outside it',
  `seal at ${(commit + 0.6).toFixed(2)} — outside the gate, so no pinch may start`,
);
check('no pinch starts outside the gate', outside.fired === false);

// --- 3. touching, where contact damage was the only threat before -----------
const close = pinchAt(
  playerR + 0.1,
  [0, 0.42, 0.58, 0.92],
  'Already touching',
  `seal at ${(playerR + 0.1).toFixed(2)} — inside contact range, where the crab always hurt you`,
);
check('a pinch also fires point blank', close.fired === true);

log('');
log(fails ? `${fails} FAILED` : 'the gesture reaches the seal from the furthest distance it will start at',
  fails ? 'bad' : 'ok');

await Promise.all(posted);
log(`${shotIndex} frames posted`);
