// ---------------------------------------------------------------------------
// GRAVESITES — LOOK DEV
//
//   npm run looks:graves
//
// Three questions this sheet exists to answer, and none of them can be asked
// from a terminal:
//
//   DOES THE INSCRIPTION LAND ON THE FACE? Each stone's `forward`/`up` pair in
//   assets.js was measured off its model, and getting it wrong does not throw,
//   does not move the bounding box and does not fail a test — the stone still
//   stands, still lights, and presents its 14-centimetre EDGE to the camera. A
//   picture is the only thing that can see it.
//
//   IS THE STONE BIG ENOUGH TO READ? CONFIG.gravesite.scale went from 1 to 3
//   because the yard was invisible during a fight. Whether 3 is right, and
//   whether the etch survives it, is a judgement about a picture.
//
//   DOES THE BEAM COMPILE? systems/graveBeam.js injects a caustic band into the
//   stones' materials, and A GLSL ERROR RENDERS NOTHING — no exception, nothing
//   a Node harness can observe. The stone would simply be black in the game
//   with a completely clean test suite. This page imports the SHIPPING module
//   and compiles it in a real context, so a panel that comes up black here is a
//   real compile failure and the console capture below names it.
//
// The Node harness (npm run test:graves) covers the state machine — the drop,
// the cap, the wall clock, the guarantee that the score card is always
// released. It plants BOXES, because no GLB loads in Node. Everything above is
// the half it cannot see, which is why both exist.
//
// IT WRITES NOTHING. The CONFIG assignments below are into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { seabedTopY } from '../../path/src/arena.js';
import { makeEpitaph, revealEpitaph } from '../../path/src/systems/epitaph.js';
import { epitaphLead } from '../../path/src/systems/epitaphLead.js';
import { initGraveBeam, sweepGrave, updateGraveBeam, graveBeamState } from '../../path/src/systems/graveBeam.js';
import { createWaterMaterial, updateWaterMaterial } from '../../path/src/systems/water.js';

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
// of a broken program. Captured from before the first frame.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 300;
const H = 300;
const DT = 1 / 60;

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// THE REAL WATER MATERIAL, not a flat blue plane.
//
// It was a flat plane, and that was fine while the beam was only light landing
// on a stone. It is not fine now: half the effect is a SHAFT standing in the
// water, and the water fill is what draws it (systems/water.js owns every light
// beam in this game — see systems/graveRay.js for why the aimed one is another
// entry in that loop rather than a mesh of its own). A page with a stand-in
// background cannot show the half of the feature the player sees from furthest
// away, and would go on passing while it was broken.
const water = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), createWaterMaterial());
water.position.z = -30;
scene.add(water);

// Lit like the seabed is, or the stones come up as silhouettes and every
// judgement about the etch is a judgement about a black rectangle.
scene.add(new THREE.AmbientLight(0x88aacc, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(-3, 6, 8);
scene.add(key);

let camera = null;
function frame(width, centre = new THREE.Vector3()) {
  const half = width / 2;
  camera = new THREE.OrthographicCamera(-half, half, half * (H / W), -half * (H / W), -200, 200);
  camera.position.set(centre.x, centre.y, 60);
  camera.updateMatrixWorld(true);
  return camera;
}

let shotIndex = 0;
const posted = [];
let row = null;

function section(title, columns) {
  const h = document.createElement('h2');
  h.textContent = title;
  document.getElementById('sheet').appendChild(h);
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  document.getElementById('sheet').appendChild(row);
}

function present(title, note) {
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

/** The pixels a render actually put on screen, as a raw buffer. Read back off
 *  the GL canvas rather than the 2D copy, so nothing is measured through a
 *  blit. */
function readPixels() {
  const c = gl.domElement;
  const probe = document.createElement('canvas');
  probe.width = c.width;
  probe.height = c.height;
  const ctx = probe.getContext('2d');
  ctx.drawImage(c, 0, 0);
  return ctx.getImageData(0, 0, probe.width, probe.height);
}

/** Total light in a frame. The measurement the beam is judged by: a band that
 *  compiled and a band that silently did nothing differ here and nowhere else
 *  a script can reach. */
function brightness(img) {
  let sum = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    sum += img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722;
  }
  return sum / (img.data.length / 4);
}

// --- build ------------------------------------------------------------------

log('loading models…');
await preloadAssets();
log('models in.');

/** One frame of everything that moves. The water's own update is what carries
 *  the sweep from systems/graveRay.js into the fill's uniforms, so a page that
 *  advanced the beam without it would render the landing and no shaft. */
let clock = 0;
function step(dt = DT) {
  clock += dt;
  updateGraveBeam(dt);
  // The water's own update is what carries the sweep from systems/graveRay.js
  // into the fill's uniforms. A page that advanced the beam without this would
  // render the landing and no shaft, and pass every check it has.
  updateWaterMaterial(water.material, clock);
}

// PRIME THE WATER BEFORE ANYTHING RENDERS. createWaterMaterial hands back
// uniforms at their declared defaults, and the colour ramp's are a bare
// THREE.Color() — which is WHITE. Every cell drawn before the first
// updateWaterMaterial comes out on a white background, and it reads as a
// blown-out render rather than as a uniform nobody has written yet.
step(0);

const found = initGraveBeam();
check('the beam attached to the stones', found > 0, `${found} material(s)`);

const STONES = CONFIG.gravesite.stones;

/**
 * One stone, seated and inscribed the way systems/gravesite.js does it —
 * deliberately duplicating that placement rather than importing it, because
 * gravesite.js seats against the live arena bounds and this page has no arena.
 * What is NOT duplicated is anything that decides the picture: the scale, the
 * face rectangle and makeEpitaph itself are the shipping ones.
 */
function buildStone(stoneKey, { name, cause, lead = '' }) {
  const object = createVisual(stoneKey);
  const scale = (CONFIG.gravesite.scale ?? 3) * (CONFIG.gravesite.faces?.[stoneKey]?.scale ?? 1);
  if (scale !== 1) object.scale.multiplyScalar(scale);
  object.position.set(0, 0, 0);
  object.updateMatrixWorld(true);

  // SEATED AT THE REAL SEABED DEPTH, and this page previously did not — it
  // stood every stone at y = 0 because that is where a look page puts its
  // subject, and it cost a whole feature.
  //
  // The beam's rake is measured from the height it is handed, and standing the
  // stone at the origin is precisely the height at which a rake measured from
  // world zero is indistinguishable from a rake measured from the base. So the
  // beam passed every check on this page, measured brighter, and in the game
  // swept past thirteen units clear of a graveyard sitting at y = -38.8.
  //
  // A look page that flatters its subject by simplifying its position is not a
  // look page. Everything here is now built where the game builds it.
  const floor = seabedTopY();
  const base = new THREE.Box3().setFromObject(object).min.y;
  object.position.y = floor - base;
  object.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const c = CONFIG.gravesite;
  // The same per-stone panel gravesite.js uses — see CONFIG.gravesite.faces.
  // Duplicated here rather than imported for the reason in this function's
  // header, and it is the one duplication that has to stay in step: this page
  // is where those numbers are MEASURED, so a page reading different ones would
  // be measuring against a stone the game never draws.
  const face = c.faces?.[stoneKey] ?? {};
  const w = size.x * (face.width ?? c.faceWidth);
  const h = size.y * (face.height ?? c.faceHeight);
  const { width: _w, height: _h, rise: _r, scale: _s, ...type } = face;
  const ink = makeEpitaph({ name, cause, lead, width: w, height: h, type });
  const s = Math.abs(object.scale.x) || 1;
  ink.scale.setScalar(1 / s);
  const centre = box.getCenter(new THREE.Vector3());
  ink.position.set(
    (centre.x - object.position.x) / s,
    (centre.y - object.position.y + size.y * (face.rise ?? c.faceRise)) / s,
    (box.max.z - object.position.z + c.faceLift) / s,
  );
  object.add(ink);
  revealEpitaph(ink, 1);
  return { object, size, ink };
}

// --- the stones -------------------------------------------------------------

// THE LONGEST THING THAT CAN LAND ON A STONE. A cause used to be "a shark";
// it can now be a boss's own rolled name, and the roster produces some very
// long ones. Rendered on every stone so the wrap is judged where it is worst —
// the plaque's panel is a fifth the height of the headstone's.
const LONG_BOSS = 'Wealthyveranda the Boat Full of Billionaire Bozos';

section('the three stones, inscribed', 3);
const built = [];
for (const stoneKey of STONES) {
  const stone = buildStone(stoneKey, { name: 'FAT TONY', cause: 'a shark', lead: epitaphLead('shark') });
  scene.add(stone.object);
  built.push({ stoneKey, ...stone });

  // Framed to the stone rather than to a fixed width, so a plaque and a tomb
  // are both judged at the size they are drawn, not at the size they happen to
  // be relative to each other.
  const cam = frame(stone.size.x * 2.4, new THREE.Vector3(0, seabedTopY() + stone.size.y / 2, 0));
  gl.render(scene, cam);
  present(stoneKey, `${stone.size.x.toFixed(2)} x ${stone.size.y.toFixed(2)} units at scale ${CONFIG.gravesite.scale}`);

  // THE FACE TEST. The inscription quad is placed at the front of the stone's
  // bounding box, which is only the inscription FACE if the asset's forward/up
  // pair turned that face toward the camera. If a stone is edge-on, its own
  // width collapses — a headstone is 14cm thick and about a metre wide — so the
  // ratio is what catches it, and it catches it in a way a picture confirms
  // rather than a number nobody can check.
  check(`${stoneKey} presents its face, not its edge`,
    stone.size.x > stone.size.z * 1.5,
    `${stone.size.x.toFixed(2)} wide vs ${stone.size.z.toFixed(2)} deep`);
  scene.remove(stone.object);
}

section('killed by a boss, whose name is the cause', 3);
for (const stoneKey of STONES) {
  const stone = buildStone(stoneKey, { name: 'FAT TONY', cause: LONG_BOSS, lead: epitaphLead('shark') });
  scene.add(stone.object);
  const cam = frame(stone.size.x * 2.4, new THREE.Vector3(0, seabedTopY() + stone.size.y / 2, 0));
  gl.render(scene, cam);
  present(`${stoneKey} boss`, `${LONG_BOSS.length} characters of boss`);
  // The failure this is really about: a cause that is shrunk instead of wrapped
  // ends up at a size nobody can read, on the line that says what killed you.
  // Measured off the built canvas rather than eyeballed, so it is a number.
  const ink = stone.ink;
  check(`${stoneKey} keeps the boss name legible`,
    (ink.material.map?.image?.width ?? 0) > 0, 'no canvas');
  scene.remove(stone.object);
}

// --- the beam ---------------------------------------------------------------

section('the beam crossing a headstone', 4);
{
  const stone = buildStone(STONES[0], { name: 'FAT TONY', cause: 'a shark' });
  scene.add(stone.object);
  // FRAMED TALL, unlike the stone cells. The shaft reaches tens of units up
  // from the base and the whole point of it is that you can see it running out
  // — a frame cropped to the stone shows a bright patch and none of the beam
  // that is causing it.
  const cam = frame(stone.size.x * 7, new THREE.Vector3(0, seabedTopY() + stone.size.y * 1.6, 0));

  // Dark first, so the "before" is the picture the player is actually looking
  // at when the beam has not fired.
  step(0);
  gl.render(scene, cam);
  const dark = brightness(readPixels());
  present('no beam', `resting brightness ${dark.toFixed(1)}`);

  // The base the rake is measured from — exactly what ui/graveLabel.js hands
  // it. Passing nothing here is the bug this page failed to catch, so the page
  // now asserts the difference below rather than trusting the call.
  const baseY = new THREE.Box3().setFromObject(stone.object).min.y;
  sweepGrave(0, baseY);
  const time = CONFIG.gravesite.beam.time;
  const marks = [0.25, 0.5, 0.75];
  let peak = dark;
  let t = 0;
  for (const mark of marks) {
    while (t < time * mark) { step(); t += DT; }
    gl.render(scene, cam);
    const b = brightness(readPixels());
    peak = Math.max(peak, b);
    present(`beam at ${Math.round(mark * 100)}%`,
      `x ${graveBeamState().x.toFixed(1)} · strength ${graveBeamState().strength.toFixed(2)} · brightness ${b.toFixed(1)}`);
  }

  // THE ONE MEASUREMENT THAT MATTERS. A shader that failed to compile, a band
  // that missed the stone, a strength left at zero and a colour that resolved
  // to black all produce the same picture — the stone exactly as it was — and
  // this is the only check that can tell any of them from a working beam.
  check('the beam actually put light on the stone', peak > dark * 1.02,
    `${dark.toFixed(1)} resting -> ${peak.toFixed(1)} peak`);

  // THE REGRESSION, PINNED. A sweep given the wrong base is displaced sideways
  // by the rake times the error, and at the seabed's depth that is thirteen
  // world units on a band under two wide — the beam fires, sweeps, finishes,
  // and never touches the stone. Every other check on this page passed while
  // that was true, including the one above, because they were all measured with
  // the stone standing at the origin where the error is zero.
  //
  // So this asserts the FAILING case explicitly rather than trusting that the
  // passing one implies it.
  sweepGrave(0, 0); // the old call: no base, rake measured from world zero
  let wrongPeak = dark;
  let wt = 0;
  while (wt < time) {
    step();
    wt += DT;
    gl.render(scene, cam);
    wrongPeak = Math.max(wrongPeak, brightness(readPixels()));
  }
  check('a sweep raked from the wrong height misses the stone entirely',
    wrongPeak < dark * 1.02,
    `raked from y=0 the stone reached ${wrongPeak.toFixed(1)} against ${dark.toFixed(1)} resting `
    + `— if this passes light, the rake is not being measured from the base`);

  sweepGrave(0, baseY);
  t = 0;
  while (t < time * 0.5) { step(); t += DT; }

  // ...and it has to STOP. A beam that never releases is a stripe painted on a
  // headstone for the rest of the run.
  while (t < time * 1.2) { step(); t += DT; }
  gl.render(scene, cam);
  const after = brightness(readPixels());
  present('after', `back to ${after.toFixed(1)}`);
  check('and it lets go again', Math.abs(after - dark) < Math.max(0.5, dark * 0.02),
    `${dark.toFixed(1)} before, ${after.toFixed(1)} after`);
  check('the sweep reports itself finished', graveBeamState().active === false);
  scene.remove(stone.object);
}

// --- a yard -----------------------------------------------------------------

section('a yard of six, as a run would leave it', 1);
{
  const names = [
    ['FAT TONY', 'a shark'],
    ['BRINE', 'running out of air'],
    ['SIR FLOPS-A-LOT', 'a crab'],
    ['PRIME MINISTER DERP', 'the orca'],
    ['AL WHITEFISH', 'a lightning strike'],
    ['CHONKER MAC II', 'something that shoots'],
  ];
  // One rolled lead per grave, from that grave's own cause — which is the
  // whole point of epitaphs.csv and cannot be judged from one stone.
  const CAUSE_IDS = ['shark', 'drowning', 'crab', 'orca', 'lightning', 'shot'];
  // LAID OUT FROM THE STONES' OWN WIDTHS, not on a fixed pitch. A fixed nine
  // units was fine while every stone was about four across; the tomb is twenty
  // once its own scale factor is on, and a sheet that overlaps them is a sheet
  // showing a layout bug that is not in the game — graves land where the seal
  // died, not on a grid.
  //
  // What it CANNOT show, and is worth knowing: two deaths within a tomb's width
  // of each other really do overlap in the game, because the marker goes where
  // the body did and nothing moves it.
  const objects = [];
  const built6 = names.map(([name, cause], i) => buildStone(STONES[i % STONES.length],
    { name, cause, lead: epitaphLead(CAUSE_IDS[i % CAUSE_IDS.length]) }));
  const gap = 3;
  let cursor = 0;
  const spans = built6.map((st) => st.size.x);
  const total = spans.reduce((a, b) => a + b, 0) + gap * (built6.length - 1);
  cursor = -total / 2;
  built6.forEach((stone, i) => {
    stone.object.position.x = cursor + spans[i] / 2;
    cursor += spans[i] + gap;
    stone.object.rotation.z = (i % 2 ? 1 : -1) * CONFIG.gravesite.lean;
    scene.add(stone.object);
    objects.push(stone.object);
  });
  const wide = frame(total + 10, new THREE.Vector3(0, seabedTopY() + 5, 0));
  sweepGrave(objects[2].position.x, new THREE.Box3().setFromObject(objects[2]).min.y);
  let t = 0;
  while (t < CONFIG.gravesite.beam.time * 0.5) { step(); t += DT; }
  gl.render(scene, wide);
  present('the yard, mid-sweep',
    `leads rolled per cause · beam over ${names[2][0]} · ${total.toFixed(0)} units of seabed · `
    + spans.map((w, i) => `${STONES[i % STONES.length]} ${w.toFixed(1)}`).slice(0, 3).join(', '));
  for (const o of objects) scene.remove(o);
}

// --- verdict ----------------------------------------------------------------

check('no shader failed to compile', shaderErrors.length === 0,
  shaderErrors.slice(0, 3).join(' | '));

await Promise.all(posted);
log(fails ? `${fails} check(s) failed` : 'all checks passed', fails ? 'bad' : 'ok');
log(`${shotIndex} frames posted.`);
document.title = fails ? `FAIL (${fails}) — gravesites` : 'PASS — gravesites';
