// ---------------------------------------------------------------------------
// FIN TWITCH — the flick as each flipper throws
//
//   npm run looks:twitch
//
// The question: the gun already alternates fins and already flashes at the
// muzzle, but the flipper itself does not move, so the stone reads as being
// emitted rather than thrown. What shape of flick fixes that, and how much of
// it is too much?
//
// Numbers cannot settle this. The twitch goes in as an AIM, not as a pose (see
// CONFIG.fins.twitch), so what actually reaches the screen is whatever the CCD
// in systems/ikChain.js makes of it after maxBend, maxFold, maxTwist and the
// smoothing have all had a say — a curve that looks crisp on a graph can arrive
// as a shrug once the solver has finished with it. So every strip below is the
// SHIPPING rig: createVisual('ship'), createAnimationController and
// createAimRig, driven a frame at a time at 60fps by the same kickFin() the
// gun calls.
//
// WHAT TO LOOK AT. The orange thread is the muzzle's own path over the gesture
// — where the end of the flipper actually went, drawn on the frame it got
// there. The flat blue line is where that muzzle sits at rest. The gap between
// the two IS the twitch; the numbers under each strip are that gap measured in
// world units, next to the seal's own length for scale.
//
// IT WRITES NOTHING — a vite build with no dev server behind it and no save
// path. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { createAnimationController, stateForSpeed } from '../../path/src/systems/animation.js';
import { createAimRig } from '../../path/src/systems/aimRig.js';

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

const W = 300;
const H = 260;
const DT = 1 / 60;

// One WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

// The game's own lighting rig rather than a prettier one of this page's own:
// the twitch is read off a silhouette, and a key light from somewhere the game
// does not have one moves where that silhouette's edge falls.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070c16);
scene.add(new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient));
const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
key.position.fromArray(CONFIG.lighting.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity));

await preloadAssets();

// --- the seal, built the way initPlayer builds it ---------------------------
//
// THE CONTAINER IS NOT DECORATION. The art's forward is +Y (see the quarter
// turn in updatePlayer), and the seal is only ever pointed downrange by its
// CONTAINER's rotation.z — the body inside it always faces +Y. A page that
// added the body straight to the scene would leave a nose-up seal being asked
// to aim at +X, which is a quarter turn the fin chains cannot make: every
// strip would be measuring the joint limits clamping an impossible aim rather
// than the twitch. So the group is here, holding the same angle a seal swimming
// and aiming right holds in a run.
const group = new THREE.Group();
const body = createVisual('ship');
group.add(body);
group.rotation.z = Math.atan2(0, 1) - Math.PI / 2;
scene.add(group);
const anim = createAnimationController(body);
const rig = createAimRig(body);

check('the aim rig built off the real skeleton', rig != null);
check('both flippers resolved', (rig?.muzzles?.length ?? 0) === 2, `${rig?.muzzles?.length ?? 0} fin chains`);
check('the rig exposes the shot kick', typeof rig?.kickFin === 'function');

// AIMING FLAT AND FORWARD. The twitch is measured as a RISE, so an aim with a
// vertical component of its own would fold the thing being measured into the
// thing measuring it.
const AIM = new THREE.Vector2(1, 0);

// THE SWIM CLIP IS FROZEN FOR EVERY STRIP, and this is the one decision on the
// page that needs defending.
//
// The flipper is already moving. The swim clip sweeps the muzzle through
// several TENTHS of a world unit a second, and the twitch being looked at is a
// few HUNDREDTHS — so a strip shot over a running clip is mostly the clip, and
// the rise measured under each cell is the sum of two things with the smaller
// one buried. The first version of this page read option B as a twitch of
// exactly zero for that reason, which is not a shape anyone would have gone on
// to argue about; it was the paddle stroke happening to be on its way down.
//
// So the mixer is advanced by 0 during a strip: the seal holds one frame of the
// swim and the ONLY thing that moves is the flick. The IK still blends over the
// clip's pose exactly as it does in a run — `animQ` is read every frame either
// way — so this changes what is being measured, not how the twitch is solved.
// See [[measure displacement against a control run]]: freezing the other mover
// is the same trick as differencing it out, and it is legible in a filmstrip.
let clipDt = DT;

function frame(kick = -1) {
  anim?.update(clipDt, stateForSpeed(CONFIG.player.speed ?? 6), false);
  if (kick >= 0) rig?.kickFin(kick);
  rig?.update(DT, AIM, { engaged: true });
  group.updateMatrixWorld(true);
}

// Settle with the clip RUNNING, so the pose it freezes on is a real frame of
// the swim rather than the bind pose, and so the fin IK has eased its weight
// all the way in — a rig read on its first frame is measuring `weightLerp`.
for (let i = 0; i < 120; i++) frame();
clipDt = 0;
for (let i = 0; i < 30; i++) frame();

const box = new THREE.Box3().setFromObject(group);
const span = new THREE.Vector3();
box.getSize(span);
const REST = rig.muzzles.map((m) => m.clone());
check('the two muzzles are at different places', REST[0].distanceTo(REST[1]) > 1e-3,
  `${REST[0].distanceTo(REST[1]).toFixed(3)} apart`);

// WHICH FLIPPER THE PLAYER CAN ACTUALLY SEE. The two fins are separated in
// CAMERA DEPTH — the game is side-on, so the far one spends the whole run
// behind the animal's own silhouette, and a strip shot on it is a strip of a
// flipper nobody is looking at. Read off z rather than assumed: the fin defs
// are ordered ['left', 'right'] and which of those is nearer is a fact about
// the model, not about the naming.
const NEAR = rig.muzzles[0].z >= rig.muzzles[1].z ? 0 : 1;
const NEAR_NAME = rig.muzzleSides?.[NEAR] ?? (NEAR === 0 ? 'left' : 'right');

log('');
log(`seal ${span.x.toFixed(2)} long x ${span.y.toFixed(2)} tall  ·  left muzzle at y ${REST[0].y.toFixed(3)} z ${REST[0].z.toFixed(3)}, right at y ${REST[1].y.toFixed(3)} z ${REST[1].z.toFixed(3)}`);
log(`the ${NEAR_NAME} flipper is the near one — every strip below is shot on it`);
log(`shipped: mode ${CONFIG.fins.twitch.mode}, angle ${CONFIG.fins.twitch.angle} rad, ${CONFIG.fins.twitch.duration}s, reachPop ${CONFIG.fins.twitch.reachPop}`);
log(`gun: ${CONFIG.weapon.fireRate}s between volleys, so a two-fin alternation puts a shot on one flipper every ${(CONFIG.weapon.fireRate / 2).toFixed(3)}s`);
log('');

// --- camera -----------------------------------------------------------------
// ORTHOGRAPHIC, like the run, and framed on the FRONT HALF of the animal: the
// twitch is a tenth of a radian on a limb about a third of the body long, and
// a frame that fits the whole seal renders it as a couple of pixels.
const centre = new THREE.Vector3(REST[NEAR].x, REST[NEAR].y, 0);
const VIEW_W = span.x * 0.5;
const VIEW_H = VIEW_W * (H / W);
const camera = new THREE.OrthographicCamera(-VIEW_W / 2, VIEW_W / 2, VIEW_H / 2, -VIEW_H / 2, -100, 200);
camera.position.set(centre.x, centre.y, 20);

// --- the overlays -----------------------------------------------------------
//
// The rest line and the muzzle thread. Both are drawn in the same plane the
// seal is rendered in, at a z in front of it, so neither can be swallowed by
// the body it is describing.
const OVER_Z = 2;
function restLine(y) {
  const g = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(centre.x - VIEW_W / 2, y, OVER_Z),
    new THREE.Vector3(centre.x + VIEW_W / 2, y, OVER_Z),
  ]);
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x2f6f9e, transparent: true, opacity: 0.85 }));
}
const nearRest = restLine(REST[NEAR].y);
scene.add(nearRest);

// The thread. Rebuilt each frame from the points collected so far, capped at
// the gesture's own length rather than running for ever — a trail that outlives
// the twitch draws the swim clip instead of the flick.
const TRAIL = 90;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xffa23f }));
trail.frustumCulled = false;
scene.add(trail);
let path = [];
function pushTrail(p) {
  path.push(p.x, p.y, OVER_Z);
  if (path.length > TRAIL * 3) path = path.slice(-TRAIL * 3);
  const arr = trailGeo.attributes.position.array;
  arr.fill(0);
  arr.set(path);
  trailGeo.setDrawRange(0, path.length / 3);
  trailGeo.attributes.position.needsUpdate = true;
}
function clearTrail() { path = []; trailGeo.setDrawRange(0, 0); }

// A dot on the muzzle itself, so the frame where nothing has moved yet still
// says where to look.
const dot = new THREE.Mesh(
  new THREE.SphereGeometry(span.x * 0.012, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xffd08a }),
);
scene.add(dot);

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];

function cell(name, caption, flag) {
  const wrap = document.createElement('div');
  wrap.className = `cell${flag ? ' peak' : ''}`;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
  wrap.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = caption;
  wrap.appendChild(cap);
  const file = `${String(shotIndex++).padStart(2, '0')}-${name.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((b) => {
    fetch(`/shot/${file}`, { method: 'POST', body: b }).then(done, done);
  }, 'image/png')));
  return wrap;
}

function row(heading, sub, wide = false) {
  const h = document.createElement('h2');
  h.innerHTML = sub ? `${heading} <span>${sub}</span>` : heading;
  sheetEl.appendChild(h);
  const r = document.createElement('div');
  r.className = wide ? 'row wide' : 'row';
  sheetEl.appendChild(r);
  return r;
}

// --- one option, one strip --------------------------------------------------
//
// `preset` is written straight into CONFIG.fins.twitch, which is what the game
// reads — so a strip cannot show a shape the config could not produce.
const SHOTS = [0, 0.033, 0.067, 0.1, 0.133, 0.183, 0.25, 0.35];

function preset(p) {
  Object.assign(CONFIG.fins.twitch, { enabled: true, ...p });
  CONFIG.fins.twitch.spring = { ...CONFIG.fins.twitch.spring, ...(p.spring ?? {}) };
}

// Back to a flipper that is not mid-anything, with the twitch switched off so
// the settle cannot itself be a gesture. One option must never start inside the
// previous option's tail.
function home() {
  const was = CONFIG.fins.twitch.enabled;
  CONFIG.fins.twitch.enabled = false;
  for (let i = 0; i < 60; i++) frame();
  CONFIG.fins.twitch.enabled = was;
  clearTrail();
}

// WHAT THE GESTURE ACTUALLY DOES, on its own pass. Measured before anything is
// drawn rather than sampled at the eight times the strip happens to show: a
// peak that falls between two cells is a peak this page would otherwise report
// as whichever cell was nearest.
function measure(side) {
  home();
  let peak = 0;
  let tPeak = 0;
  let dip = 0;
  let back = 0;
  const rest = REST[side].y;
  for (let i = 0; i < 60; i++) {
    frame(i === 0 ? side : -1);
    const t = (i + 1) * DT;
    const d = rig.muzzles[side].y - rest;
    if (d > peak) { peak = d; tPeak = t; }
    if (d < dip) dip = d;
  }
  // Home is read BACKWARDS off the same run — the last moment the fin was still
  // more than a twentieth of its own peak away from where it started.
  home();
  for (let i = 0; i < 60; i++) {
    frame(i === 0 ? side : -1);
    if (Math.abs(rig.muzzles[side].y - rest) > peak * 0.05) back = (i + 1) * DT;
  }
  return { peak, tPeak, dip, back };
}

function strip(label, sub, p, side = NEAR) {
  preset(p);
  const m = measure(side);

  home();
  const r = row(label, sub);
  const rest = REST[side].y;
  let t = 0;
  let fired = false;
  for (const at of [...SHOTS].sort((a, b) => a - b)) {
    while (t < at - 1e-6) {
      frame(fired ? -1 : side);
      fired = true;
      t += DT;
      pushTrail(rig.muzzles[side]);
    }
    if (!fired) { frame(side); fired = true; pushTrail(rig.muzzles[side]); }
    dot.position.copy(rig.muzzles[side]).setZ(OVER_Z);
    gl.render(scene, camera);
    const d = rig.muzzles[side].y - rest;
    r.appendChild(cell(
      `${label}-${at.toFixed(3)}`,
      `<b>${(at * 1000).toFixed(0)}ms</b> — rise <b>${d >= 0 ? '+' : ''}${d.toFixed(3)}</b>`,
      Math.abs(t - m.tPeak) < DT,
    ));
  }
  log(`${label.padEnd(26)} peak +${m.peak.toFixed(3)} at ${(m.tPeak * 1000).toFixed(0)}ms`
    + `  ·  ${(100 * m.peak / span.y).toFixed(1)}% of the seal's depth`
    + `  ·  dip ${m.dip.toFixed(3)}  ·  home by ${(m.back * 1000).toFixed(0)}ms`);
  return m;
}

// --- the whole animal, first ------------------------------------------------
//
// Every other row on this page is cropped hard onto one flipper, and a crop is
// exactly where a preview lies to you: a seal posed at ninety degrees to the
// aim, or a muzzle resolving onto the wrong bone, both look like a perfectly
// reasonable close-up of something. So the sheet opens on the whole animal at
// rest and at the top of a twitch, with both muzzles marked, and the reader can
// see what the strips below are a detail OF.
const wide = new THREE.OrthographicCamera(
  -span.x * 0.62, span.x * 0.62, span.x * 0.62 * (H / W), -span.x * 0.62 * (H / W), -100, 200);
wide.position.set(box.min.x + span.x / 2, box.min.y + span.y / 2, 20);

const dot2 = new THREE.Mesh(dot.geometry, new THREE.MeshBasicMaterial({ color: 0x5fd6ff }));
dot2.visible = false;
scene.add(dot2);

function overview(label, caption, r) {
  dot2.visible = true;
  dot.position.copy(rig.muzzles[0]).setZ(OVER_Z);
  dot2.position.copy(rig.muzzles[1]).setZ(OVER_Z);
  gl.render(scene, wide);
  r.appendChild(cell(label, caption));
  dot2.visible = false;
}

preset({ mode: 'snap', angle: 0.13, duration: 0.15, returnEase: 'outCubic', reachPop: 0 });
home();
{
  const r = row('The animal', `aiming right, both muzzles marked — orange is the left flipper, blue the right; the ${NEAR_NAME} one is nearest the camera`, true);
  overview('overview-rest', `<b>at rest</b> — left muzzle at ${REST[0].x.toFixed(2)}, ${REST[0].y.toFixed(2)}`, r);
  frame(0);
  for (let i = 0; i < 3; i++) frame();
  overview('overview-left-peak', `<b>left fin, 67ms</b> — rise +${(rig.muzzles[0].y - REST[0].y).toFixed(3)}`, r);
  home();
  frame(1);
  for (let i = 0; i < 3; i++) frame();
  overview('overview-right-peak', `<b>right fin, 67ms</b> — rise +${(rig.muzzles[1].y - REST[1].y).toFixed(3)}`, r);
}
home();

// --- the four options -------------------------------------------------------
//
// THE ANGLES BELOW ARE NOT THE SAME NUMBER, ON PURPOSE, and this is the thing
// the page found that no graph of the four curves would have.
//
// `angle` is an input to the SOLVER, not an output. All four shapes reach 1.0
// of it — the spring's impulse is tuned so it does — but the chain chases its
// target through `CONFIG.fins.smoothing`, an 18-per-second slerp, which is a
// 55ms low pass. A snap is at full for one frame and is therefore mostly EATEN
// by that filter; a pop holds near its peak for 60ms and arrives almost whole.
// At a shared angle of 0.13 the same four shapes land 0.086, 0.142, 0.288 and
// 0.376 world units of muzzle — a factor of four, which would have read as
// four different SIZES of gesture rather than as four shapes. (C is the other
// way round: opening the reach pulls the tip back down toward the aim line, so
// it needs MORE angle to arrive at the same rise, not less.)
//
// So each angle here is scaled to put all four at about 0.145: the strips
// differ in shape and in nothing else, which is what makes them comparable.
// The measured peak under every row is what actually reached the screen.
log('OPTIONS — angles normalised so all four peak alike; see the note above');
const A = strip('A · snap', 'all of it on the firing frame, eased home over 150ms — the hardest read', {
  mode: 'snap', angle: 0.13, duration: 0.15, returnEase: 'outCubic', reachPop: 0,
});
const B = strip('B · pop', 'a visible 60ms rise before the fall — the fin is seen travelling up', {
  mode: 'pop', angle: 0.075, duration: 0.2, rise: 0.3, returnEase: 'outCubic', reachPop: 0,
});
const C = strip('C · flick', 'A, plus the reach opening 25% — the limb straightens as it lifts', {
  mode: 'snap', angle: 0.171, duration: 0.15, returnEase: 'outCubic', reachPop: 0.25,
});
const D = strip('D · spring', 'an impulse into a damped spring — the only shape that carries momentum', {
  mode: 'spring', angle: 0.058, spring: { stiffness: 420, damping: 24, impulse: 65 }, reachPop: 0,
});

log('');
check('every option actually lifts the muzzle', [A, B, C, D].every((o) => o.peak > 0.01),
  [A, B, C, D].map((o) => o.peak.toFixed(3)).join(' / '));
check('and the four are within a fifth of each other, so the strips compare shapes',
  Math.max(A.peak, B.peak, C.peak, D.peak) / Math.min(A.peak, B.peak, C.peak, D.peak) < 1.2,
  [A, B, C, D].map((o) => o.peak.toFixed(3)).join(' / '));

// --- how big does it have to be to READ -------------------------------------
//
// The four rows above are all about a tenth of the animal's depth at the tip,
// which is the size "slight" argues for. Whether that is enough to SEE is a
// different question, and the side view is the reason it is worth asking: the
// near flipper spends most of its stroke against the animal's own belly rather
// than against open water, so a lot of a small movement lands on a background
// the same colour as the thing moving.
//
// So: one shape, four sizes, and the answer read off the pictures rather than
// off the number. The last of them is deliberately too much — a row without a
// value that is obviously wrong gives the eye nothing to bracket against.
log('');
log('AMPLITUDE — one shape, four sizes');
const sizes = [0.08, 0.13, 0.24, 0.45].map((a) => strip(
  `Angle ${a}`, `snap at ${a} rad`,
  { mode: 'snap', angle: a, duration: 0.15, returnEase: 'outCubic', reachPop: 0 },
));
check('the rise tracks the angle rather than saturating',
  sizes.every((m, i) => i === 0 || m.peak > sizes[i - 1].peak),
  sizes.map((m) => m.peak.toFixed(3)).join(' / '));

// --- alternation, at the gun's own cadence ----------------------------------
//
// The strips above are one flipper, one shot. This is the thing the player
// actually sees: the gun trading fins at its real interval, with BOTH muzzles
// threaded, so the question stops being "is the flick nice" and becomes "do the
// two of them read as taking turns".
log('');
log('ALTERNATION — both fins, at the gun\'s real cadence');

const trail2Geo = new THREE.BufferGeometry();
trail2Geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
const trail2 = new THREE.Line(trail2Geo, new THREE.LineBasicMaterial({ color: 0x5fd6ff }));
trail2.frustumCulled = false;
scene.add(trail2);
const farRest = restLine(REST[NEAR === 0 ? 1 : 0].y);
farRest.visible = false;
scene.add(farRest);
let path2 = [];
function pushTrail2(p) {
  path2.push(p.x, p.y, OVER_Z);
  if (path2.length > TRAIL * 3) path2 = path2.slice(-TRAIL * 3);
  const arr = trail2Geo.attributes.position.array;
  arr.fill(0);
  arr.set(path2);
  trail2Geo.setDrawRange(0, path2.length / 3);
  trail2Geo.attributes.position.needsUpdate = true;
}

function alternating(label, sub, p, interval) {
  preset(p);
  home();
  path2 = [];
  trail2Geo.setDrawRange(0, 0);

  dot2.visible = true;
  farRest.visible = true;
  const r = row(label, sub, true);
  const total = interval * 4;
  const at = [];
  for (let i = 0; i < 4; i++) at.push(interval * i + interval * 0.35);
  let t = 0;
  let next = 0;
  let n = 0;
  let shown = 0;
  let maxNear = 0;
  let maxFar = 0;
  const FAR = NEAR === 0 ? 1 : 0;
  while (t < total && shown < at.length) {
    let kick = -1;
    if (t >= next - 1e-6) { kick = n % 2; n++; next += interval; }
    frame(kick);
    t += DT;
    pushTrail(rig.muzzles[0]);
    pushTrail2(rig.muzzles[1]);
    maxNear = Math.max(maxNear, rig.muzzles[NEAR].y - REST[NEAR].y);
    maxFar = Math.max(maxFar, rig.muzzles[FAR].y - REST[FAR].y);
    if (t >= at[shown] - 1e-6) {
      dot.position.copy(rig.muzzles[0]).setZ(OVER_Z);
      dot2.position.copy(rig.muzzles[1]).setZ(OVER_Z);
      gl.render(scene, camera);
      r.appendChild(cell(`${label}-alt-${shown}`,
        `<b>shot ${shown + 1}</b> — ${n % 2 === 1 ? 'left' : 'right'} · left ${(rig.muzzles[0].y - REST[0].y >= 0 ? '+' : '')}${(rig.muzzles[0].y - REST[0].y).toFixed(3)} · right ${(rig.muzzles[1].y - REST[1].y >= 0 ? '+' : '')}${(rig.muzzles[1].y - REST[1].y).toFixed(3)}`));
      shown++;
    }
  }
  dot2.visible = false;
  farRest.visible = false;
  log(`${label.padEnd(34)} near peak +${maxNear.toFixed(3)}  far peak +${maxFar.toFixed(3)}  at one shot per ${(interval * 1000).toFixed(0)}ms`);
  return { maxNear, maxFar };
}

const base = CONFIG.weapon.fireRate / 2;
alternating('Alternating · snap', `one shot per ${(base * 1000).toFixed(0)}ms, the gun as it starts`,
  { mode: 'snap', angle: 0.13, duration: 0.15, returnEase: 'outCubic', reachPop: 0 }, base);
alternating('Alternating · spring', 'the same cadence — the mode where two shots compound',
  { mode: 'spring', angle: 0.058, spring: { stiffness: 420, damping: 24, impulse: 65 }, reachPop: 0 }, base);

// A fast gun: the case that decides whether a shape survives. At 70ms between
// shots a 150ms gesture is re-thrown before it has come home twice over, and
// what that looks like is a flipper that never comes down.
const FAST = 0.07;
const fastSnap = alternating('Fast gun · snap', `one shot per ${(FAST * 1000).toFixed(0)}ms — does the fin ever come home`,
  { mode: 'snap', angle: 0.13, duration: 0.15, returnEase: 'outCubic', reachPop: 0 }, FAST);
const fastSpring = alternating('Fast gun · spring', 'the same, on the mode that accumulates',
  { mode: 'spring', angle: 0.058, spring: { stiffness: 420, damping: 24, impulse: 65 }, reachPop: 0 }, FAST);

log('');
check('a fast gun does not wind the fin up past half the animal',
  fastSpring.maxNear < 0.5 * span.y,
  `spring reaches +${fastSpring.maxNear.toFixed(3)} against ${(0.5 * span.y).toFixed(3)}`);
// WHAT A MAXED FIRE RATE DOES TO EACH FAMILY — asserted rather than admired,
// because "does the flipper stay up when the gun gets fast" is the question a
// run answers and a single strip cannot.
//
// The spring compounds BY DESIGN: the impulse lands on a fin that is still
// moving. The surprise is that snap compounds too, by about 40%, and it is not
// the curve doing it — the curve is back at zero within 150ms whatever happens.
// It is `CONFIG.fins.smoothing` again: at 70ms between shots the chain is still
// slerping toward the last kick when the next one restarts it, so the POSE
// accumulates under an aim that does not. There is no mode on this page with a
// hard ceiling, and a version of this comment that claimed one would have been
// wrong in the direction nobody checks.
//
// What matters is that neither runs away, so the bound is on both.
check('neither family runs away under a maxed gun',
  fastSnap.maxNear < A.peak * 1.6 && fastSpring.maxNear < D.peak * 1.6,
  `snap ${fastSnap.maxNear.toFixed(3)} vs ${A.peak.toFixed(3)}, spring ${fastSpring.maxNear.toFixed(3)} vs ${D.peak.toFixed(3)}`);
// ...and which of them compounds MORE is the other way round from the guess.
// The spring is the mode with momentum in it and it gains 15%; snap gains 39%,
// because a shape that spends its whole life inside the smoothing window is the
// one the smoothing has the most left to give. Recorded as a measurement rather
// than as an expectation, since it is the reverse of what the modes are named
// for.
check('both compound, and snap compounds harder than the spring',
  (fastSnap.maxNear / A.peak) > (fastSpring.maxNear / D.peak),
  `snap x${(fastSnap.maxNear / A.peak).toFixed(2)}, spring x${(fastSpring.maxNear / D.peak).toFixed(2)}`);

// Put the shipped values back, so nothing below reads a page preset.
Object.assign(CONFIG.fins.twitch, { mode: 'snap', angle: 0.13, duration: 0.15, rise: 0.3, returnEase: 'outCubic', reachPop: 0 });

await Promise.all(posted);
log('');
log(fails === 0 ? `all checks passed — ${shotIndex} frames written` : `${fails} FAILED — ${shotIndex} frames written`, fails === 0 ? 'ok' : 'bad');
document.title = fails === 0 ? 'fin twitch — ok' : `fin twitch — ${fails} FAILED`;
