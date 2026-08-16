// ---------------------------------------------------------------------------
// THE BOWHEAD SWEEP — body, stroke and gape
//
//   npm run looks:whale
//
// The question numbers cannot settle. tools/whale-test.mjs proves the rig bends
// dorsoventrally, that the morphs move the jaw 25 units and that the gulp reach
// is what CONFIG says — and none of that says whether the animal reads as a
// whale on screen. Four things about this asset can only be judged by eye:
//
//   THE SCALE      31 world units against an 80-wide frame is a number. Whether
//                  that is "an event arriving" or "the screen is now whale" is
//                  a picture, and it is the one number here most likely to be
//                  wrong — the model is deliberately out of family with the
//                  boss column (assets.csv).
//   THE STROKE     the wag is procedural, and its amplitude comes from
//                  CONFIG.animation.states, which was tuned on fish a fraction
//                  of this length. The same 0.12 radians that is a flick on a
//                  0.4-unit trout is metres of travel at the fluke here.
//   THE GAPE       `cruiseGape` and `feedGape` are morph influences with no
//                  units. 0.35 either reads as a feeding whale or as a whale
//                  with its mouth hanging open.
//   THE RIM        outline thickness is OBJECT space, i.e. the source file's
//                  180-unit scale, so the 1.1 in the asset entry is a
//                  calculation until you look at it.
//
// Everything on this page comes from the shipping code: the animal is
// createVisual('whale') — the same instance a sweep builds, fit and size
// multiplier and outline included — and the stroke is the real
// createAnimationController driving the real rig at CONFIG.whale.wagState.
// The gulp radius drawn under it is CONFIG.whale.mouthRadius, placed at the
// same point systems/whale.js measures the gulp from.
//
// IT WRITES NOTHING — a vite build with no dev server behind it and no save
// path. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, morphControl, ASSETS } from '../../path/src/assets.js';
import { createAnimationController } from '../../path/src/systems/animation.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import {
  mouthAheadOf, headingFor, intakeRadius,
  resetWhales, spawnWhale, updateWhales,
} from '../../path/src/systems/whale.js';
import { enemies, resetEnemies } from '../../path/src/entities/enemies.js';

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

const W = 620;
const H = 300;
const DT = 1 / 60;
const C = CONFIG.whale;

// One WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x081726);
scene.add(new THREE.AmbientLight(0xffffff, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(4, 8, 10);
scene.add(key);

await preloadAssets();
updateBounds(16 / 9);

// --- the whale, built the way a sweep builds one ----------------------------
const visual = createVisual('whale');
// LAID FLAT BY THE GAME'S OWN HEADING, not by a preview-only rotation.
//
// createVisual orients every creature so its `forward` points at world +Y, so
// something has to turn it; the question is what. Writing -PI/2 here would make
// this page look right while systems/whale.js was standing the animal on its
// tail in the actual arena, which is exactly what happened — the bug shipped
// and this page could not see it. Calling headingFor means a heading wrong in
// the game is wrong here too.
//
// The container/visual split is the game's as well: heading on the outer object,
// the side-view mirror on the inner one, so the two rotations never compound.
const container = new THREE.Group();
container.add(visual);
container.rotation.z = headingFor(1);
scene.add(container);
const anim = createAnimationController(visual);
const morphs = morphControl(visual);

check('the model loaded rather than falling back to the cone',
  visual.name === 'whale' && !!visual.userData?.rig,
  visual.userData?.rig ? 'real rig attached' : 'FELL BACK — every panel below is a cone');
check('the animation controller built off the real skeleton', anim != null);
check('the morph targets resolved by name', morphs.available,
  Object.keys(ASSETS.whale.morphs).join(', '));

// HOW BIG IT ACTUALLY IS, measured off the built instance. `fit` scales a
// grandchild and the assets.csv multiplier scales the root, so neither number
// alone says how much water this animal covers — and every judgement on this
// page is about exactly that.
container.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(container);
const span = box.getSize(new THREE.Vector3());
const length = Math.max(span.x, span.y, span.z);

// The SAME offset the gulp is billed at, from systems/whale.js — not a copy of
// it. The whale is laid along +X here (see the rotation above) while the system
// measures along its own heading, so only the distance is shared; the nose
// distance itself is read off this instance's box, exactly as spawnWhale reads
// it off the one it builds.
const noseAhead = box.max.x;
const mouthAhead = mouthAheadOf(noseAhead);

log('');
log(`body ${span.x.toFixed(1)} x ${span.y.toFixed(1)} x ${span.z.toFixed(1)} world units`);
// frameWidth, not width. The arena is wider than the camera sees at zoom 1
// (arena.widthScale) and the camera pans across the difference, so "how much of
// the screen is this" is a question about the frame — the arena number would
// make the animal look less than half as big as it plays.
log(`arena ${bounds.width.toFixed(0)} wide, ${(bounds.surfaceY - bounds.bottom).toFixed(0)} deep`
  + `  ·  frame ${bounds.frameWidth.toFixed(0)} wide`
  + ` — the animal is ${(length / bounds.frameWidth * 100).toFixed(0)}% of the SCREEN's width`);
log(`nose ${noseAhead.toFixed(1)} ahead of the pivot  ·  gulp centred ${mouthAhead.toFixed(1)} ahead`);
log(`gulp reach ${C.mouthRadius} (${(C.mouthRadius / length * 100).toFixed(0)}% of its own length)`
  + `  ·  crossing at ${C.speed} u/s takes ${((bounds.width + length * 1.5) / C.speed).toFixed(1)}s`);
log(`wag state "${C.wagState}" — amplitude ${CONFIG.animation.states[C.wagState].wagAmplitude} rad,`
  + ` speed ${CONFIG.animation.states[C.wagState].wagSpeed}`);
log('');

check('it is bigger than the biggest boss body', length > 27,
  `${length.toFixed(1)} against the mosasaur's 27.2`);
check('...but does not fill the screen', length < bounds.frameWidth * 0.6,
  `${(length / bounds.frameWidth * 100).toFixed(0)}% of the frame width`);

// --- the gulp sphere, where systems/whale.js measures it from ----------------
//
// Drawn rather than described, because "5.5 units" against a 31-unit animal is
// the whole question: it has to be a mouthful, not a bow wave.
const gulp = new THREE.Mesh(
  new THREE.SphereGeometry(C.mouthRadius, 32, 24),
  new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0.16, depthWrite: false }),
);
gulp.position.set(mouthAhead, 0, 0);
const gulpRim = new THREE.Mesh(
  new THREE.RingGeometry(C.mouthRadius - 0.06, C.mouthRadius + 0.06, 96),
  new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
);
gulpRim.position.copy(gulp.position);

// The seal, at the radius every contact check uses, for scale.
const seal = new THREE.Mesh(
  new THREE.SphereGeometry(CONFIG.player.hitRadius, 32, 24),
  new THREE.MeshStandardMaterial({ color: 0x5fd6ff, roughness: 0.4, emissive: 0x123044 }),
);

// --- camera -----------------------------------------------------------------
// Framed off the measured body, side-on, because that is the view the game is
// played in and the stroke is a vertical motion that only reads from the side.
const camera = new THREE.PerspectiveCamera(34, W / H, 0.1, 600);
// Fit a HORIZONTAL extent, which is the one that matters here — the body runs
// along X once it is laid flat, and a panel is twice as wide as it is tall.
// `fov` is the VERTICAL angle, so the horizontal half-angle is the one scaled
// by the aspect ratio; fitting against the vertical angle alone (which is what
// this did first) puts the camera about half as far back as it needs to be and
// crops both ends of the animal off the panel.
function fitX(extent, cam = camera, pad = 1.18, at = new THREE.Vector3()) {
  const halfH = Math.tan((cam.fov * Math.PI / 180) / 2);
  const halfW = halfH * cam.aspect;
  cam.position.set(at.x, at.y, (extent * pad) / (2 * halfW));
  cam.lookAt(at);
}
// Aimed at the BODY's centre, not at the origin. `ASSETS.whale.pivot` puts the
// instance origin 18% back from the nose so the animal banks about its skull,
// which means the origin is nowhere near the middle of the silhouette — a
// camera pointed at it hangs the tail off one side of the panel.
const bodyCentre = box.getCenter(new THREE.Vector3());
fitX(length, camera, 1.18, bodyCentre);

// --- the sheet --------------------------------------------------------------
let shotIndex = 0;
const posted = [];

function cell(title, caption, bad) {
  const wrap = document.createElement('div');
  wrap.className = `cell${bad ? ' hit' : ''}`;
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

// One frame of the real update order.
function step(n = 1) {
  for (let i = 0; i < n; i++) anim?.update(DT, C.wagState, false);
  container.updateMatrixWorld(true);
}

// Where the fluke tip is right now, so the stroke can be MEASURED off the
// picture rather than asserted next to it.
const tipBone = visual.getObjectByName(ASSETS.whale.rig.wagChain.at(-1));
const _tip = new THREE.Vector3();
const flukeY = () => (tipBone ? tipBone.getWorldPosition(_tip).y : NaN);

// ===========================================================================
// 1. THE STROKE — one full wag cycle, so the amplitude can be judged
// ===========================================================================
{
  const r = row('The stroke', `state "${C.wagState}" over one cycle — the fluke should sweep UP and DOWN, not side to side`);
  const cycle = (Math.PI * 2) / CONFIG.animation.states[C.wagState].wagSpeed;
  const frames = Math.round(cycle / DT);
  step(1);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 6; i++) {
    step(Math.round(frames / 6));
    const y = flukeY();
    lo = Math.min(lo, y); hi = Math.max(hi, y);
    gl.render(scene, camera);
    r.appendChild(cell(`stroke-${i}`,
      `<b>${(i / 6 * 100).toFixed(0)}%</b> through the cycle — fluke at y <b>${y.toFixed(2)}</b>`));
  }
  log('');
  log(`fluke sweeps ${(hi - lo).toFixed(2)} world units over one ${cycle.toFixed(2)}s cycle`
    + ` — ${((hi - lo) / length * 100).toFixed(1)}% of the body's length`);
  check('the tail actually moves', hi - lo > 0.2, `${(hi - lo).toFixed(2)} units`);
  // A whale's fluke travels a good fraction of a body length; a wag you have to
  // look for is a wag that is not there at this scale.
  check('...by an amount you can see at this size', (hi - lo) / length > 0.02,
    `${((hi - lo) / length * 100).toFixed(1)}% of body length`);
  check('...and not so far it looks broken', (hi - lo) / length < 0.35,
    `${((hi - lo) / length * 100).toFixed(1)}% of body length`);
}

// ===========================================================================
// 1b. THE HEADING — both directions, through the game's own headingFor
// ===========================================================================
//
// The bug this panel exists for shipped once: the heading was written as though
// the model's forward were +X, so the whale swam across the arena standing on
// its tail. Nothing threw, and the numbers all still passed.
{
  const r = row('The heading', 'the real container rotation for each direction — both must be FLAT');
  for (const [dir, label] of [[1, 'swimming right'], [-1, 'swimming left']]) {
    container.rotation.z = headingFor(dir);
    // The side-view mirror the game applies, so a left-swimming whale is not
    // rendered upside down.
    visual.rotation.y = dir < 0 ? Math.PI : 0;
    step(1);
    const b = new THREE.Box3().setFromObject(container);
    const sz = b.getSize(new THREE.Vector3());
    // Re-aim per direction. The pivot sits 18% back from the nose, so flipping
    // the heading swings the whole silhouette to the other side of the origin —
    // a camera left pointing at the right-facing centre frames empty water.
    fitX(length, camera, 1.18, b.getCenter(new THREE.Vector3()));
    gl.render(scene, camera);
    const flat = sz.x > sz.y * 1.8;
    check(`${label}: the body lies along the direction of travel`, flat,
      `box ${sz.x.toFixed(1)} wide x ${sz.y.toFixed(1)} tall — wider than tall, or it is nose-up`);
    r.appendChild(cell(`heading-${dir > 0 ? 'right' : 'left'}`,
      `<b>${label}</b> — rotation.z ${headingFor(dir).toFixed(2)}, box ${sz.x.toFixed(1)} x ${sz.y.toFixed(1)}`
      + (flat ? '' : ' <span class="tag">NOSE-UP</span>'), !flat));
  }
  container.rotation.z = headingFor(1);
  visual.rotation.y = 0;
  step(1);
  container.updateMatrixWorld(true);
  fitX(length, camera, 1.18, new THREE.Box3().setFromObject(container).getCenter(new THREE.Vector3()));
}

// ===========================================================================
// 2. THE GAPE — the two morphs, at the influences CONFIG actually uses
// ===========================================================================
{
  const r = row('The gape', `cruiseGape ${C.cruiseGape} held all the way across, feedGape ${C.feedGape} on top with prey in reach`);
  const states = [
    ['shut', 0, 0, 'jaw closed — not a state the sweep ever holds, here for reference'],
    ['cruise', C.cruiseGape, 0, `<b>cruise</b> — mouthNarrow ${C.cruiseGape}, what it crosses the arena wearing`],
    ['feeding', C.cruiseGape, C.feedGape, `<b>feeding</b> — mouthWide ${C.feedGape} on top, with a mouthful in reach`],
  ];
  for (const [name, narrow, wide, caption] of states) {
    morphs.set('mouthNarrow', narrow);
    morphs.set('mouthWide', wide);
    step(1);
    gl.render(scene, camera);
    r.appendChild(cell(`gape-${name}`, caption));
  }
  morphs.set('mouthNarrow', C.cruiseGape);
  morphs.set('mouthWide', 0);
}

// ===========================================================================
// 3. THE SPOUT
// ===========================================================================
{
  const r = row('The spout', `blowhole morph, popped above ${C.spoutDepth} of the water column`);
  for (const v of [0, 0.5, 1]) {
    morphs.set('blowhole', v);
    step(1);
    gl.render(scene, camera);
    r.appendChild(cell(`spout-${v}`, `blowhole influence <b>${v}</b>`));
  }
  morphs.set('blowhole', 0);
}

// ===========================================================================
// 3b. THE INTAKE — a school being vacuumed in
// ===========================================================================
//
// The whole reason this panel exists: the pull is MOTION, and every other
// check on this page is a still. Numbers can say a fish moved 6.9 units toward
// the mouth; only a filmstrip says whether that reads as being inhaled.
//
// This drives the REAL updateWhales over a real spawnWhale, so the field
// shape, the falloff and the gape coupling are the shipping ones. The fish are
// plain dots on purpose — what is being looked at is the FLOW, and rendering
// twenty little trout invites judging the trout.
{
  const r = row('The intake', `suction field ${intakeRadius(C).toFixed(1)} units against a ${C.mouthRadius} swallowing radius — the school should bend into the mouth`);

  const sub = new THREE.Scene();
  sub.background = new THREE.Color(0x081726);
  sub.add(new THREE.AmbientLight(0xffffff, 1.4));
  const k2 = new THREE.DirectionalLight(0xffffff, 2.0);
  k2.position.set(4, 8, 10);
  sub.add(k2);

  resetWhales(sub);
  const w = spawnWhale(sub, () => 0.1); // deterministic: left-hand entry, shallow band
  // Parked at the origin so the panel can frame it; the crossing itself is not
  // what this panel is about.
  w.container.position.x = 0;
  w.baseY = 0;
  const field = intakeRadius(C);
  const mouthX = w.container.position.x + w.dir * mouthAheadOf(w.noseAhead);

  // A block of fish sitting in front of the jaw, filling the field.
  const dotGeo = new THREE.SphereGeometry(0.55, 12, 10);
  const dotMat = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0x4a3208, roughness: 0.5 });
  const dots = [];
  resetEnemies(sub);
  for (let ix = 0; ix < 7; ix++) {
    for (let iy = -3; iy <= 3; iy++) {
      const mesh = new THREE.Mesh(dotGeo, dotMat);
      mesh.position.set(mouthX + w.dir * (3 + ix * (field / 6)), iy * 2.1, 0);
      sub.add(mesh);
      dots.push(mesh);
      enemies.push({ mesh, radius: 0.4, def: {}, hp: 10 });
    }
  }
  const started = dots.length;

  const cam = new THREE.PerspectiveCamera(34, W / H, 0.1, 600);
  const framed = length + field * 2;
  const halfH = Math.tan((cam.fov * Math.PI / 180) / 2);
  cam.position.set(w.dir * framed * 0.12, 0, (framed * 1.05) / (2 * halfH * cam.aspect));
  cam.lookAt(w.dir * framed * 0.12, 0, 0);

  const hold = w.container.position.x;
  let t = 0;
  for (let panel = 0; panel < 6; panel++) {
    // The whale is held in place so the ONLY thing closing the gap is suction —
    // a whale allowed to swim onto a stationary school would show the same
    // picture with the pull switched off entirely.
    for (let f = 0; f < (panel === 0 ? 1 : 34); f++) {
      updateWhales(1 / 60, sub, enemies, {});
      w.container.position.x = hold;
      t += 1 / 60;
    }
    // Dots whose creature has been swallowed leave the scene with it.
    for (let d = dots.length - 1; d >= 0; d--) {
      if (!enemies.some((e) => e.mesh === dots[d])) { sub.remove(dots[d]); dots.splice(d, 1); }
    }
    gl.render(sub, cam);
    r.appendChild(cell(`intake-${panel}`,
      `<b>${t.toFixed(2)}s</b> — gape ${w.gape.toFixed(2)}, ${dots.length}/${started} still in the water`));
  }
  check('the intake swallows the school it is pointed at', dots.length < started * 0.5,
    `${started - dots.length} of ${started} taken in ${t.toFixed(1)}s with the whale held still`);
  check('...and the jaw was open while it did it', w.gape > 0.5, `gape ${w.gape.toFixed(2)}`);
}

// ===========================================================================
// 4. SCALE — the gulp sphere and the seal, against the body
// ===========================================================================
{
  const r = row('Scale', 'the gulp reach and the seal drawn against the animal, at the sizes the game uses');
  scene.add(gulp);
  scene.add(gulpRim);
  step(1);
  gl.render(scene, camera);
  // The honest property is that the gulp is CENTRED on the animal, not that the
  // whole sphere fits behind the nose — it cannot, and should not. `mouthRadius`
  // is 18% of body length against a nose only 18% ahead of the pivot, and a
  // bowhead's mouth really is about a third of its body: a sphere small enough
  // to tuck entirely behind the tip would be a reach that misses the jaw it is
  // supposed to represent. What must not happen is the centre drifting past the
  // nose, which is what the first version did by half a body length.
  check('the gulp is centred on the jaw, not out in front of the nose',
    mouthAhead <= noseAhead,
    `centre ${mouthAhead.toFixed(1)}, nose at ${noseAhead.toFixed(1)}`);
  check('...and most of the reach is on the animal', mouthAhead + C.mouthRadius < length * 0.5,
    `reach ends ${(mouthAhead + C.mouthRadius).toFixed(1)} ahead of a pivot on a ${length.toFixed(1)}-unit body`);
  r.appendChild(cell('scale-gulp',
    `gulp reach <b>${C.mouthRadius}</b> at the jaw — <b>${(C.mouthRadius * 2 / length * 100).toFixed(0)}%</b> of the body across`));

  seal.position.set(mouthAhead, 0, 0);
  scene.add(seal);
  gl.render(scene, camera);
  r.appendChild(cell('scale-seal',
    `the seal at <b>${CONFIG.player.hitRadius}</b> — in the mouth`));

  // And the whole arena, so "how much of the screen is this" stops being a
  // percentage and becomes a picture.
  // The FRAME, not the arena: what the camera sees at zoom 1 is what the
  // player judges the animal's size against.
  const wide = new THREE.PerspectiveCamera(34, W / H, 0.1, 2000);
  fitX(bounds.frameWidth, wide, 1.05);
  const walls = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(bounds.frameWidth, bounds.surfaceY - bounds.bottom)),
    new THREE.LineBasicMaterial({ color: 0x3d6f96 }),
  );
  scene.add(walls);
  gl.render(scene, wide);
  scene.remove(walls);
  r.appendChild(cell('scale-arena',
    `against the visible frame — <b>${bounds.frameWidth.toFixed(0)}</b> wide`
    + ` by <b>${(bounds.surfaceY - bounds.bottom).toFixed(0)}</b> deep`));
  scene.remove(seal);
  scene.remove(gulp);
  scene.remove(gulpRim);
}

log('');
log(fails ? `${fails} FAILED` : 'the sweep reads at the size and stroke the config asks for',
  fails ? 'bad' : 'ok');

await Promise.all(posted);
log(`${shotIndex} frames posted`);
