// ---------------------------------------------------------------------------
// EYE LIGHTS — can you read the eyeline?
//
//   npm run looks:eyes
//
// The question a test cannot answer. tools/eye-light-test.mjs proves the orbs
// are on the eyeballs, that they ride the head IK and that exactly one is lit
// side-on — all true of an orb that is invisible at the size the game draws
// the seal. This renders the real thing at the real pixel density and lets it
// be looked at.
//
// TRUE SCALE IS THE POINT AND THE FIRST ROW IS THE VERDICT. The arena frame is
// 80 world units wide (arena.js) and the seal is about 6 of them, so on a
// 1600px canvas the animal is ~120px and its eye orb is ~4px of core inside
// ~17px of halo. Every cell here is rendered at exactly 20 px per world unit,
// which is that canvas — a look page framed on the head would make anything
// look legible and would have been worthless.
//
// WHAT THIS PAGE IS NOT SHOWING. There is no bloom pass: post.js needs the
// whole world. The halo carries the glow in game and it will be brighter and
// softer than it is here, so read this for POSITION and SIZE and not for how
// hot the orbs look. There is no toon shade or outline pass either.
//
// IT WRITES NOTHING — a vite build with no dev server behind it and no save
// path. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { createAnimationController, stateForSpeed } from '../../path/src/systems/animation.js';
import { createAimRig } from '../../path/src/systems/aimRig.js';
import {
  createEyeLights, updateEyeLights, resetEyeLights,
  flareEyeLights, flashEyeLightsDamage, eyeLightState,
} from '../../path/src/systems/eyeLights.js';
import { beams, updateBeams, resetBeams } from '../../path/src/systems/beams.js';
import { updateLaserEyes, setLaserAim, resetLaserEyes } from '../../path/src/systems/laserEyes.js';

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

// 20 px per world unit at pixelRatio 2 — the arena's 80-unit frame on a 1600px
// canvas, which is a normal desktop game window. Everything on this page is
// rendered at that density and only the FRAMING changes between rows, so a
// close crop is a crop and never a zoom.
const PX_PER_UNIT = 20;
const W = 400;
const H = 300;
const DT = 1 / 60;

// One WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Converted, not just assigned. three treats a background Color as being in
// the WORKING (linear) space, so a hex authored as sRGB — which every colour in
// config.js is — comes out several stops too bright and every glow on this page
// would be judged against the wrong contrast.
scene.background = new THREE.Color(CONFIG.colors.waterMid).convertSRGBToLinear();
// THE GAME'S OWN LIGHTS, read out of CONFIG rather than invented here. The
// resting eye is a black bead whose entire look is a specular off the key
// light, so a page lit any other way would be tuning the glint against a lamp
// that does not exist. world.js builds exactly these three.
scene.add(new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient));
const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
key.position.fromArray(CONFIG.lighting.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity));

await preloadAssets();

// --- the seal, held the way entities/player.js holds it ---------------------
//
// A container carrying the facing (`rotation.z + PI/2` is the swim direction)
// and the model under it carrying the side-view mirror as a half roll about
// its own forward axis. Both matter here: the mirror is what swaps which eye
// is nearest the camera, and it is the one transform that can make this whole
// feature light the wrong side of the head.
const holder = new THREE.Object3D();
scene.add(holder);
const body = createVisual('ship');
holder.add(body);
const anim = createAnimationController(body);
const rig = createAimRig(body);
check('the aim rig resolved off the real model', !!rig);
check('both eye sockets are published', !!rig?.anchors?.eyeL && !!rig?.anchors?.eyeR);

const eyeGroup = createEyeLights();
scene.add(eyeGroup);

// How big the animal actually is, measured rather than assumed — every framing
// below is in world units and only means something next to this.
const span = new THREE.Vector3();
new THREE.Box3().setFromObject(body).getSize(span);
log('');
// Measured BEFORE any facing is applied, so the seal is still nose-up (+Y is
// the art's forward) and its length is the y span, not the x.
log(`seal ${span.y.toFixed(2)} long x ${span.x.toFixed(2)} thick, world units`
  + `  ·  ${(span.y * PX_PER_UNIT).toFixed(0)} px long at the arena's own zoom`);
log(`bead ${(CONFIG.eyeLights.radius * 2).toFixed(2)} units = `
  + `${(CONFIG.eyeLights.radius * 2 * PX_PER_UNIT).toFixed(1)} px`
  + `  ·  halo ${(CONFIG.eyeLights.haloRadius * 2).toFixed(2)} units = `
  + `${(CONFIG.eyeLights.haloRadius * 2 * PX_PER_UNIT).toFixed(1)} px`);
log('');

const camera = new THREE.OrthographicCamera();
camera.position.set(0, 0, 40);
camera.near = -100;
camera.far = 200;

/** Frame `units` of world across the cell, centred on (cx, cy). */
function frame(units, cx = 0, cy = 0) {
  const half = units / 2;
  camera.left = cx - half;
  camera.right = cx + half;
  camera.top = cy + (half * H) / W;
  camera.bottom = cy - (half * H) / W;
  camera.updateProjectionMatrix();
}
// The cell is 400x300 CSS at pixelRatio 2, so `units` across it must be
// 800/PX_PER_UNIT to hold the arena's density.
const TRUE_UNITS = (W * 2) / PX_PER_UNIT;

const _aim = new THREE.Vector2(1, 0);

/**
 * Advance everything by one frame in the game's own order: the mixer writes
 * the clip, the rig poses over the top of it, then the orbs read the sockets
 * the rig just published. Reversed, the orbs would sit a frame behind the head
 * and this page would quietly be looking at last frame's stare.
 */
function step(aim, { facing = 0, mirror = 0, lit = 1, charge = 0 } = {}) {
  holder.rotation.z = facing - Math.PI / 2;
  body.rotation.y = mirror;
  anim?.update(DT, stateForSpeed(6), false);
  scene.updateMatrixWorld(true);
  rig.update(DT, aim, { engaged: true });
  updateEyeLights(DT, rig, { lit, charge });
}

/** Settle into a pose — the rig eases, so one frame is never the answer. */
function settle(aim, opts, frames = 90) {
  for (let i = 0; i < frames; i++) step(aim, opts);
}

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];

function cell(title, caption) {
  const wrap = document.createElement('div');
  wrap.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
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

/** Where the lit socket ended up, in world units — printed under every cell. */
function litSocket() {
  const l = rig.anchors.eyeL; const r = rig.anchors.eyeR;
  return l.z >= r.z ? l : r;
}

// ---------------------------------------------------------------------------
// 1. TRUE SCALE — the verdict
// ---------------------------------------------------------------------------
{
  const r = row('True scale', 'the arena frame at 20 px per world unit — this is the size you play at');
  const poses = [
    ['aim forward', new THREE.Vector2(1, 0), 0],
    ['aim up', new THREE.Vector2(0.4, 1).normalize(), 0],
    ['aim down', new THREE.Vector2(0.4, -1).normalize(), 0],
    ['aim behind', new THREE.Vector2(-1, 0.15).normalize(), 0],
  ];
  for (const [name, aim, facing] of poses) {
    settle(aim, { facing });
    frame(TRUE_UNITS, 0, 0);
    gl.render(scene, camera);
    const p = litSocket();
    r.appendChild(cell(`true-${name}`, `<b>${name}</b> — socket at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`));
  }
}

// ---------------------------------------------------------------------------
// 2. THE RESTING EYE — a crop, and the whole default state
// ---------------------------------------------------------------------------
// A black bead with a catchlight and nothing else. The thing to look for is
// the GLINT: it is a real specular off the game's own key light, so it should
// sit on a different part of the eye in each of these as the head turns. If it
// is in the same place every time, the bead has stopped being lit.
{
  const r = row('At rest', 'black and only shiny — the glint should MOVE as the head turns');
  const cases = [
    ['facing right', new THREE.Vector2(1, 0), 0, 0],
    ['facing left', new THREE.Vector2(-1, 0), Math.PI, Math.PI],
    ['looking up', new THREE.Vector2(0.3, 1).normalize(), 0, 0],
    ['looking down', new THREE.Vector2(0.3, -1).normalize(), 0, 0],
  ];
  for (const [name, aim, facing, mirror] of cases) {
    settle(aim, { facing, mirror });
    const p = litSocket();
    frame(TRUE_UNITS / 5, p.x, p.y);
    gl.render(scene, camera);
    r.appendChild(cell(`rest-${name}`, `<b>${name}</b> — lit eye at z ${p.z.toFixed(2)}`));
  }
  const st = eyeLightState();
  check('the resting eye is emitting nothing',
    st.charge === 0 && st.flare === 0 && st.hurt === 0 && st.laser === 0);
}

// ---------------------------------------------------------------------------
// 3. THE WIND-UP — ease on, then the release
// ---------------------------------------------------------------------------
// The sequence, sampled at real times off one continuous run: hold the button
// until the bank fills, let go, and watch the spike ease out. The colours are
// the charge ring's own — blue filling, mint at a full bank.
{
  const aim = new THREE.Vector2(1, 0);
  const r = row('Strike charge', 'the bank filling, then let go — ring blue to mint, then the release spike');
  resetEyeLights();
  settle(aim, {}, 40);
  const st = eyeLightState();

  // Hold. `charge` here is what main.js hands both the rim and the eyes: the
  // BUTTON, plateauing at whatever the bar banked.
  const holdMarks = [0.12, 0.4, 1.4];
  let t = 0;
  let bank = 0;
  for (const at of holdMarks) {
    while (t < at - 1e-6) {
      // A bank that fills over about a second, which is the shape
      // updateCharge gives a full hold at the shipped burn rate.
      bank = Math.min(1, bank + DT / 0.85);
      step(aim, { charge: bank });
      t += DT;
    }
    const p = litSocket();
    frame(TRUE_UNITS / 5, p.x, p.y);
    gl.render(scene, camera);
    r.appendChild(cell(`charge-${at}`,
      `<b>holding ${at.toFixed(2)}s</b> — bank ${bank.toFixed(2)}, glow ${st.charge.toFixed(2)}`));
  }
  check('a full hold reaches the ready colour', st.charge > 0.95, `${st.charge.toFixed(2)}`);
  const haloMesh = eyeGroup.children.find((o) => o.geometry?.type === 'PlaneGeometry');
  const chargeHalo = haloMesh.scale.x;

  // Release: the spike, then the ramp down. Same call main.js makes.
  let flareHalo = 0;
  const r2 = row('Strike release', 'the spike on the frame it fires, then eased out over flareTime');
  flareEyeLights(bank);
  // ONE STEP BEFORE THE FIRST SHOT. flareEyeLights only sets the channel;
  // nothing reaches a material until updateEyeLights runs. Rendering straight
  // after the call shows the PREVIOUS frame — which is the full charge, and
  // looks close enough to a release spike that it read as "the flare does
  // nothing" rather than as a stale frame.
  step(aim, { charge: 0 });
  let t2 = DT;
  for (const at of [DT, 0.08, 0.2, CONFIG.eyeLights.flareTime + 0.05]) {
    while (t2 < at - 1e-6) { step(aim, { charge: 0 }); t2 += DT; }
    const p = litSocket();
    frame(TRUE_UNITS / 5, p.x, p.y);
    gl.render(scene, camera);
    if (at === DT) flareHalo = haloMesh.scale.x;
    r2.appendChild(cell(`flare-${at.toFixed(2)}`,
      `<b>${at.toFixed(2)}s</b> after release — flare ${st.flare.toFixed(2)}, `
      + `halo ${haloMesh.scale.x.toFixed(2)} (a full charge was ${chargeHalo.toFixed(2)})`));
  }
  check('the release flare is over by flareTime', st.flare === 0);
  // The halo SIZE is the only channel left that can say "louder" — the bead's
  // emissive is already flat white at a full bank — so this is what the spike
  // actually looks like, and it is worth an assertion rather than an eyeball.
  check('the release halo is visibly wider than a full charge',
    flareHalo > chargeHalo * 1.25,
    `${flareHalo.toFixed(3)} against ${chargeHalo.toFixed(3)} world units`);
  // Not `=== 0`: `chargeFall` is an exponential ease and the snap-to-zero floor
  // is 0.002, so at flareTime + 0.05 there is still about 1.5% of it left. The
  // claim is that it went with the release, not that it was cut.
  check('...and the charge glow went with it', st.charge < 0.05, `${st.charge.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 4. BITTEN — red, outright
// ---------------------------------------------------------------------------
// Including the case the priority chain exists for: hit at a FULL BANK. The
// eye must go red and stay red until the flash burns out, not blend to some
// third colour between mint and red.
{
  const aim = new THREE.Vector2(1, 0);
  const r = row('Taking damage', 'red wins outright — the last two are a hit taken at a full charge');
  const st = eyeLightState();

  resetEyeLights();
  settle(aim, {}, 40);
  flashEyeLightsDamage(1);
  step(aim, {}); // see the note on the release row — a flash needs one update
  let t = DT;
  for (const at of [DT, 0.22]) {
    while (t < at - 1e-6) { step(aim, {}); t += DT; }
    const p = litSocket();
    frame(TRUE_UNITS / 5, p.x, p.y);
    gl.render(scene, camera);
    r.appendChild(cell(`hurt-${at}`, `<b>${at.toFixed(2)}s</b> after a full hit — hurt ${st.hurt.toFixed(2)}`));
  }

  // ...and mid-charge.
  resetEyeLights();
  settle(aim, {}, 40);
  for (let i = 0; i < 90; i++) step(aim, { charge: 1 });
  const p0 = litSocket();
  frame(TRUE_UNITS / 5, p0.x, p0.y);
  gl.render(scene, camera);
  r.appendChild(cell('hurt-precharge', `<b>a full bank</b>, unbitten — glow ${st.charge.toFixed(2)}`));

  flashEyeLightsDamage(1);
  step(aim, { charge: 1 });
  const p1 = litSocket();
  frame(TRUE_UNITS / 5, p1.x, p1.y);
  gl.render(scene, camera);
  r.appendChild(cell('hurt-midcharge', `<b>bitten at a full bank</b> — hurt ${st.hurt.toFixed(2)}, charge held at ${st.charge.toFixed(2)}`));
  check('a hit at a full bank still reads as a hit', st.hurt > 0 && st.charge > 0.9,
    `hurt ${st.hurt.toFixed(2)} over a charge of ${st.charge.toFixed(2)}`);
  resetEyeLights();
}

// The mirror is the transform that can light the wrong side of the head, and
// the crop above is where it would show. Assert it too, so a regression fails
// the build rather than waiting to be noticed in a panel.
{
  settle(new THREE.Vector2(1, 0), { facing: 0, mirror: 0 });
  const rightZ = litSocket().z;
  settle(new THREE.Vector2(-1, 0), { facing: Math.PI, mirror: Math.PI });
  const leftZ = litSocket().z;
  check('the near eye is toward the camera whichever way the seal faces',
    rightZ > 0 && leftZ > 0, `facing right ${rightZ.toFixed(2)}, facing left ${leftZ.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 5. THE BEAMS — do they leave the thing that is glowing?
// ---------------------------------------------------------------------------
{
  const r = row('Laser eyes', 'the beam origin against the lit socket — these used to disagree by 2.6 units');
  const aim = { x: 1, y: 0 };
  const aimV = new THREE.Vector2(1, 0);
  const playerPos = new THREE.Vector3(0, 0, 0);

  for (const level of [1, 3, 6]) {
    resetBeams(scene);
    resetLaserEyes();
    settle(aimV, {});
    setLaserAim(aim);
    updateLaserEyes(DT, scene, playerPos, level, aim, rig);
    // A few frames so the beams fade up and place their quads.
    for (let i = 0; i < 6; i++) {
      step(aimV, {});
      setLaserAim(aim);
      updateBeams(DT, scene, { enemies: [], playerPos, playerRadius: CONFIG.player.hitRadius, hooks: {} });
    }
    const socket = litSocket();
    // Each beam against ITS OWN socket. Measuring them all against the lit one
    // folds in however far the swim clip has rolled the head apart this frame,
    // which is a real distance and not the one being asserted.
    const gap = Math.max(...beams.map((b, i) => {
      const s = i % 2 === 0 ? rig.anchors.eyeL : rig.anchors.eyeR;
      return Math.hypot(b.x - s.x, b.y - s.y);
    }));
    frame(TRUE_UNITS / 2.5, socket.x + TRUE_UNITS / 9, socket.y);
    gl.render(scene, camera);
    r.appendChild(cell(`beams-l${level}`,
      `<b>level ${level}</b> — ${beams.length} beam${beams.length === 1 ? '' : 's'}, `
      + `furthest origin ${gap.toFixed(2)} from the socket`));
    check(`level ${level}: every beam leaves the eye`,
      gap <= (CONFIG.laserEyes.eyeSide ?? 0.28) + 1e-3,
      `${gap.toFixed(3)} against a straddle of ${CONFIG.laserEyes.eyeSide}`);
  }
  resetBeams(scene);
  resetLaserEyes();
}

// ---------------------------------------------------------------------------
// 6. DEATH — the eyes go out
// ---------------------------------------------------------------------------
{
  const r = row('Going out', 'the master fade, so a dead seal does not keep staring');
  settle(new THREE.Vector2(1, 0), {});
  const marks = [0, 0.1, 0.25, 0.6];
  let t = 0;
  for (const at of marks) {
    while (t < at - 1e-6) { step(new THREE.Vector2(1, 0), { lit: 0 }); t += DT; }
    const p = litSocket();
    frame(TRUE_UNITS / 5, p.x, p.y);
    gl.render(scene, camera);
    r.appendChild(cell(`death-${at}`, `<b>${at.toFixed(2)}s</b> after the seal dies`));
  }
  resetEyeLights();
}

await Promise.all(posted);
log('');
log(fails === 0 ? `all checks passed — ${shotIndex} frames written` : `${fails} FAILURE(S)`,
  fails === 0 ? 'ok' : 'bad');
