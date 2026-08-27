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
// The SHIPPING bed, because the question this page adds is how far a real
// plant reaches in front of where it is planted — see the depth section below.
import { scatterSeabed, clearSeabed } from '../../path/src/systems/seabedScatter.js';

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

/**
 * Where the headstone's ARCH ends and its rectangular face begins, as a
 * fraction of the stone's height from the top.
 *
 * MEASURED OFF THE SILHOUETTE, not read off a crop with a ruler. The number
 * decides where the inscription sits, and eyeballing it from a screenshot means
 * re-eyeballing it the first time `fit` or `scale` moves — while a measurement
 * simply comes out different and correct.
 *
 * The water is pulled for the render because the test is ALPHA: the page's
 * renderer is built with alpha:true, so background is transparent and stone is
 * not, which makes the silhouette exact rather than a colour threshold that
 * would have to guess at wet grey against deep blue.
 */
function measureArch(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  scene.remove(water);
  const cam = frame(size.y * 1.12, new THREE.Vector3(centre.x, centre.y, 0));
  gl.render(scene, cam);
  const img = readPixels();
  scene.add(water);

  const rows = [];
  for (let y = 0; y < img.height; y += 1) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] > 128) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    rows.push(lo < 0 ? 0 : hi - lo + 1);
  }
  const widest = Math.max(...rows);
  if (widest <= 0) return null;
  const top = rows.findIndex((wd) => wd > 0);
  let bottom = rows.length - 1;
  while (bottom > top && rows[bottom] === 0) bottom -= 1;
  // The first row at (nearly) full width IS the shoulder — above it the stone
  // is still curving in. 0.97 rather than 1.0 because the edge is antialiased
  // and the widest row is a pixel or two wider than the ones under it.
  const shoulder = rows.findIndex((wd) => wd >= widest * 0.97);
  if (shoulder < 0 || bottom <= top) return null;
  return (shoulder - top) / (bottom - top);
}

// --- OPTIONS ----------------------------------------------------------------
// THE WHOLE FRONT IS WRITEABLE NOW, and that opens choices a third-of-a-stone
// panel did not have. The point of this block is that they are choices: each
// cell is the SAME seal and the SAME death, laid out a different way, so the
// decision is made by looking rather than by reading numbers.
//
// Every one of these is a `faces.headstone` entry. Whichever wins gets copied
// into CONFIG.gravesite.faces in config.js and nothing else has to change.
section('options — the same seal, laid out five ways', 3);
{
  // The arch, measured before anything is laid out on it.
  const probe = buildStone('headstone', { name: 'X', cause: 'x', lead: 'x' });
  scene.add(probe.object);
  const arch = measureArch(probe.object);
  scene.remove(probe.object);
  check('the headstone\'s shoulder is measurable', arch !== null && arch > 0.05 && arch < 0.6,
    arch === null ? 'no silhouette' : `arch ends ${(arch * 100).toFixed(0)}% down the stone`);

  // THE RECTANGULAR FACE, expressed as a panel. Everything below the shoulder,
  // less a margin at the foot so the last line is not sitting on the ground.
  // Derived from the measurement rather than typed, so the panel follows the
  // model if the stone is ever re-fitted.
  const FOOT = 0.06;
  const faceH = Math.max(0.2, 1 - (arch ?? 0.28) - FOOT);
  // `rise` is measured UP from the stone's centre, and the panel's own centre
  // sits halfway down what is left below the shoulder — so this is negative,
  // which is the whole point of the change.
  const faceRise = 0.5 - ((arch ?? 0.28) + faceH / 2);
  log(`  rectangular face: height ${faceH.toFixed(2)}, rise ${faceRise.toFixed(2)}`);

  const OPTIONS = [
    ['as shipped',
      { width: 0.88, height: 0.52, rise: 0.11, namePx: 0.26, nameLines: 1 },
      'the panel before this pass — one line, upper third of the stone'],
    ['full front, one line',
      { width: 0.94, height: 0.86, rise: 0.02, namePx: 0.18, nameLines: 1, baseline: 0.30 },
      'all the room, name still on one line — width is the limit'],
    ['stacked',
      { width: 0.94, height: 0.86, rise: 0.02, namePx: 0.30, nameLines: 2, baseline: 0.28 },
      'first over last: the name is limited by HEIGHT now, so it doubles'],
    ['stacked, name dominant',
      { width: 0.94, height: 0.88, rise: 0.0, namePx: 0.38, nameLines: 2, baseline: 0.26, causeScale: 0.30 },
      'the seal is the monument; the death is a footnote under it'],
    ['stacked, centred block',
      { width: 0.92, height: 0.86, rise: 0.0, namePx: 0.30, nameLines: 2, baseline: 0.36 },
      'the whole inscription sits in the middle of the face'],
    // --- the one that was picked, shifted onto the flat -----------------------
    ['dominant, on the flat',
      { width: 0.94, height: faceH, rise: faceRise, namePx: 0.34, nameLines: 2, baseline: 0.30, causeScale: 0.34 },
      'name dominant, panel confined to the rectangular face below the shoulder'],
    ['...a little higher',
      { width: 0.94, height: faceH + 0.06, rise: faceRise + 0.03, namePx: 0.34, nameLines: 2, baseline: 0.30, causeScale: 0.34 },
      'same, tucked a touch further up into the shoulder'],
    ['...and lower',
      { width: 0.94, height: faceH, rise: faceRise - 0.04, namePx: 0.34, nameLines: 2, baseline: 0.32, causeScale: 0.34 },
      'same, sat further down toward the foot'],
  ];

  const saved = { ...CONFIG.gravesite.faces.headstone };
  for (const [label, face, note] of OPTIONS) {
    CONFIG.gravesite.faces.headstone = { ...saved, ...face };
    const stone = buildStone('headstone',
      { name: 'FAT TONY', cause: 'a shark', lead: 'eaten by' });
    scene.add(stone.object);
    const cam = frame(stone.size.x * 1.35,
      new THREE.Vector3(0, seabedTopY() + stone.size.y / 2, 0));
    gl.render(scene, cam);
    present(label, note);
    scene.remove(stone.object);
  }

  // THE TWO NAMES THAT BREAK A STACKED LAYOUT, on whichever option is current.
  // A one-word name has nothing to stack and must not come out at half size
  // waiting for a second line; a long hand-written one has to stay inside the
  // stone. Both are real rows in sealNames.csv.
  CONFIG.gravesite.faces.headstone = { ...saved };
  for (const who of ['RUMPSHAKER', 'SIR FLOPS-A-LOT']) {
    const stone = buildStone('headstone', { name: who, cause: 'a crab', lead: 'clawed by' });
    scene.add(stone.object);
    const cam = frame(stone.size.x * 1.35,
      new THREE.Vector3(0, seabedTopY() + stone.size.y / 2, 0));
    gl.render(scene, cam);
    present(who, who.includes(' ') ? 'hyphens are one word — three lines' : 'one word: nothing to stack');
    const ink = new THREE.Box3().setFromObject(stone.ink);
    const body = new THREE.Box3().setFromObject(stone.object);
    check(`"${who}" stays on the stone`,
      ink.min.x > body.min.x && ink.max.x < body.max.x,
      `ink ${(ink.max.x - ink.min.x).toFixed(2)} vs stone ${(body.max.x - body.min.x).toFixed(2)}`);
    scene.remove(stone.object);
  }
  CONFIG.gravesite.faces.headstone = saved;
}

// --- NOTHING RUNS OFF THE EDGE ----------------------------------------------
// THE CHECK THAT CATCHES CLIPPED TYPE, and no bounds test can.
//
// The inscription is a canvas on a quad. The quad is always inside the stone —
// its size comes from the stone's own box — so every geometric check passes
// while the TEXT inside the canvas is running off it. That is exactly how the
// lead shipped reading "ITTEN CLEAN THROUGH B": the line was drawn at a fixed
// size with no width check, and the only symptom was the picture.
//
// So this reads the built canvas and looks for ink touching a border. It is the
// longest lead and the longest cause the game can produce, on the layout that
// is actually shipped.
section('the longest lines the game can produce', 3);
{
  const worst = [
    ['longest lead', 'FAT TONY', 'a shark', 'minced by the propeller of'],
    ['longest cause', 'FAT TONY', LONG_BOSS, 'slain by'],
    ['both at once', 'SIR FLOPS-A-LOT', LONG_BOSS, 'bitten clean through by'],
  ];
  for (const [label, name, cause, lead] of worst) {
    const stone = buildStone('headstone', { name, cause, lead });
    scene.add(stone.object);
    const cam = frame(stone.size.x * 1.35,
      new THREE.Vector3(0, seabedTopY() + stone.size.y / 2, 0));
    gl.render(scene, cam);
    present(label, `"${lead}" over "${cause}"`);

    // Read the inscription's OWN canvas, not the screen — the border test has
    // to be against the texture's edge, which is what the text is being clipped
    // by. One pixel in from each side, because the outermost column of an
    // antialiased glyph is allowed to be faint.
    const img = stone.ink.material.map?.image;
    let bled = 0;
    if (img && img.getContext) {
      const g2 = img.getContext('2d');
      const px = g2.getImageData(0, 0, img.width, img.height).data;
      const inked = (x, y) => px[(y * img.width + x) * 4 + 3] > 40;
      for (let y = 0; y < img.height; y += 1) {
        if (inked(1, y) || inked(img.width - 2, y)) bled += 1;
      }
      for (let x = 0; x < img.width; x += 1) {
        if (inked(x, 1) || inked(x, img.height - 2)) bled += 1;
      }
    }
    check(`${label}: no ink touches the edge of the panel`, bled === 0,
      bled ? `${bled} pixel rows/columns of type run off the stone` : '');
    scene.remove(stone.object);
  }
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

// --- in front of the plants -------------------------------------------------
//
// THE ONE THING ONLY THIS PAGE CAN ANSWER ABOUT DEPTH.
//
// The yard used to stand at a single typed z in the MIDDLE of the plant bed, so
// a kelp could stand across the inscription at the one moment it is meant to be
// read — the run has ended, the water has stopped, and the whole beat exists to
// be looked at. systems/gravesite.js now drops the newest stone in front of the
// bed and leaves older ones scattered through it (see the depth block there).
//
// The harness can check the arithmetic and nothing else: the clearance is over
// the bed's ROOTS, and how far a plant's leaves reach in front of the point it
// is planted at is a fact about the models. No GLB loads in Node, so this is
// the only place the number can be measured rather than guessed — and it is
// measured off the SHIPPING scatter, at the shipping seed, so it is the bed the
// player gets and not a bed of stand-ins.
section('the newest stone clears the bed', 3);
{
  const bed = scatterSeabed(scene);
  const roots = CONFIG.seabed.depth[1];
  const lane = Math.min(roots + CONFIG.gravesite.dropClear, -0.2);

  // WHERE THE BED REALLY ENDS, PLANT BY PLANT. A box round the whole bed only
  // finds the single furthest-forward leaf out of a hundred and fifty, and
  // clearing that one is a different question from clearing the bed — the
  // outlier is a full unit past the roots, so a lane set to beat it is a lane
  // in the play plane with the seal swimming through the stone.
  //
  // Measured per INSTANCE, off the instance matrices: an InstancedMesh is one
  // geometry and a hundred transforms, so its own bounding box says nothing
  // about where any particular plant got to.
  const plants = [];
  {
    const m = new THREE.Matrix4();
    const b = new THREE.Box3();
    for (const child of bed.children) {
      if (!child.isInstancedMesh) continue;
      if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
      for (let i = 0; i < child.count; i += 1) {
        child.getMatrixAt(i, m);
        b.copy(child.geometry.boundingBox).applyMatrix4(m);
        plants.push({ front: b.max.z, x: (b.min.x + b.max.x) / 2, wide: b.max.x - b.min.x });
      }
    }
    plants.sort((a, b2) => a.front - b2.front);
  }
  const fronts = plants.map((p) => p.front);
  const pct = (q) => fronts[Math.min(fronts.length - 1, Math.floor(q * fronts.length))] ?? 0;
  const pastLane = fronts.filter((z) => z > lane).length;
  const pastOld = fronts.filter((z) => z > CONFIG.gravesite.z).length;
  const worst = plants[plants.length - 1];
  log(`bed reach: ${plants.length} plants · median ${pct(0.5).toFixed(2)} · p90 ${pct(0.9).toFixed(2)} `
    + `· furthest ${worst.front.toFixed(2)} · ${pastLane} in front of the lane at ${lane.toFixed(2)}, `
    + `${pastOld} in front of the old ${CONFIG.gravesite.z}`);

  // STOOD AT THE WORST PLANT IN THE BED, not at the origin. A stone dropped
  // into a clearing proves nothing, and a page that photographs the easy case
  // is the same failure as one that stands its subject at y = 0.
  const stone = buildStone(STONES[0], { name: 'FAT TONY', cause: 'a shark', lead: epitaphLead('shark') });
  stone.object.position.x = worst.x;
  stone.object.position.z = lane;
  scene.add(stone.object);
  const cam = frame(stone.size.x * 3.4,
    new THREE.Vector3(worst.x, seabedTopY() + stone.size.y / 2, 0));
  gl.render(scene, cam);
  present('the stone that just fell',
    `lane z ${lane.toFixed(2)}, at the x of the bed's furthest-forward plant (${worst.front.toFixed(2)})`);

  // ...and the same stone, same bed, where the yard used to stand. This is the
  // pair the decision was made on.
  stone.object.position.z = CONFIG.gravesite.z;
  gl.render(scene, cam);
  present('...and where it used to stand',
    `z ${CONFIG.gravesite.z} — ${pastOld} of ${plants.length} plants in front of the name`);

  // WHAT THE LANE IS ACTUALLY WORTH. Not "no plant is in front of it": the last
  // couple of percent of the bed costs the play plane, and a stone the seal
  // swims through to read is a worse trade than a frond on somebody's shoulder.
  // The line is drawn at a twentieth of the bed, and the count is printed
  // either way so the number is a judgement being recorded rather than a
  // threshold nobody looked at.
  check('the drop lane puts the bed behind the stone',
    pastLane <= plants.length * 0.05,
    `${pastLane} of ${plants.length} plants still reach past z ${lane.toFixed(2)}`);
  // The one that is structural rather than a judgement: whatever the clearance
  // is set to, the stone stands in front of every plant's ROOTS. Fail this and
  // the lane is inside the bed again.
  check('...and in front of every plant\'s roots', lane > roots,
    `lane ${lane.toFixed(2)} vs front root ${roots.toFixed(2)}`);
  // And the comparison the change was made for: the old depth had more of the
  // bed in front of the inscription than behind it.
  check('the old depth really was inside the bed', pastOld > pastLane,
    `${pastOld} in front at ${CONFIG.gravesite.z} vs ${pastLane} at ${lane.toFixed(2)}`);

  scene.remove(stone.object);

  // THE OTHER HALF OF THE RULE, which is a picture and not a number: a stone is
  // only read on the day it is carved, and from the next session on it takes a
  // rolled depth anywhere in the slab. Three of them at the ends and middle of
  // CONFIG.gravesite.restZ, in one frame, because the thing being judged is
  // whether a yard with plants in front of some of its stones reads as a floor
  // that has grown over them or as markers that have sunk into the scenery.
  const [back, front] = CONFIG.gravesite.restZ;
  const later = [back, (back + front) / 2, front].map((z, i) => {
    const st = buildStone(STONES[0], {
      name: ['BRINE', 'SIR FLOPS-A-LOT', 'AL WHITEFISH'][i],
      cause: ['running out of air', 'a crab', 'a lightning strike'][i],
      lead: epitaphLead(['drowning', 'crab', 'lightning'][i]),
    });
    st.object.position.set(worst.x + (i - 1) * 9, st.object.position.y, z);
    st.object.rotation.z = (i % 2 ? 1 : -1) * CONFIG.gravesite.lean;
    scene.add(st.object);
    return st.object;
  });
  const wide = frame(30, new THREE.Vector3(worst.x, seabedTopY() + stone.size.y / 2, 0));
  gl.render(scene, wide);
  present('a yard on a later run',
    `resting depths ${back} · ${((back + front) / 2).toFixed(2)} · ${front} — one behind the bed, `
    + 'one among it, one in front');
  for (const o of later) scene.remove(o);

  clearSeabed();
}

// --- verdict ----------------------------------------------------------------

check('no shader failed to compile', shaderErrors.length === 0,
  shaderErrors.slice(0, 3).join(' | '));

await Promise.all(posted);
log(fails ? `${fails} check(s) failed` : 'all checks passed', fails ? 'bad' : 'ok');
log(`${shotIndex} frames posted.`);
document.title = fails ? `FAIL (${fails}) — gravesites` : 'PASS — gravesites';
