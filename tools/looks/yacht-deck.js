// ---------------------------------------------------------------------------
// THE YACHT BOSS, END TO END, IN A REAL BROWSER.
//
//   npx vite build --config tools/looks/vite.yacht.config.mjs
//   then serve the output over http and open yacht-deck.html
//
// This is the half of the yacht boss that a Node harness cannot reach. Node has
// no GLTFLoader that survives the headless stub, so tools/yacht-boss-test.mjs
// runs against the FALLBACK primitives — which is the right way to test the
// wiring and a useless way to test whether a man is standing on a deck. Every
// question below is about the actual geometry:
//
//   * does the hull float with its waterline on the water, or is the pivot
//     wrong and the yacht buried to its main deck?
//   * does systems/crew.js's deck measurement find the real deck on THIS hull,
//     rather than the flybridge roof or a piece of hull under the sea?
//   * does the guest bind to the skeleton tools/rig-guest.mjs gave him, or does
//     he silently fall back to the box body?
//   * and when he is knocked off, does the real verlet solver produce a body?
//
// It imports the SHIPPING modules — assets.js, crew.js, config.js — rather than
// copies, so what is on screen is what the game does. Built with vite rather
// than run off the dev server on purpose: a build resolves the JSON and ?raw
// CSV imports without ever starting a second game, which is the thing that
// overwrites imported-tuning.json.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, hasModel } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { ease } from '../../path/src/ease.js';
import {
  crew, spawnCrewFor, updateCrew, damageCrew, jostleCrew, throwCrewOff, resetCrew, clearDeckCache,
} from '../../path/src/systems/crew.js';
import { attachHitShape, refreshHitShape, tickHitShapes } from '../../path/src/systems/hitShape.js';

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

const W = 760;
const H = 320;

// ONE WebGL context for the whole page, blitted into a plain 2D canvas per
// frame. A renderer per cell is the obvious way to write this and it silently
// destroys the page: browsers keep about sixteen live WebGL contexts and
// discard the oldest to make room, so past a dozen shots the early ones simply go
// black — and they go black AFTER they were drawn correctly, so nothing fails
// and there is nothing in the console.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

let shotIndex = 0;
const posted = [];
function present(caption) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  // The page's own background, painted first. The renderer is alpha:true so
  // the sky comes out transparent, and a transparent PNG on a white viewer is
  // an unreadable picture of nothing.
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gl.domElement, 0, 0);
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = caption;
  cell.appendChild(cap);
  document.getElementById('grid').appendChild(cell);

  // Also written to disk, so the frames can be looked at without depending on
  // a screenshot of the page.
  const name = `${String(shotIndex++).padStart(2, '0')}-${caption.split('—')[0].trim().toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

updateBounds(W / H);
log(`arena: surfaceY ${bounds.surfaceY.toFixed(2)}  bottom ${bounds.bottom.toFixed(2)}  x ${bounds.left.toFixed(1)}..${bounds.right.toFixed(1)}`);

await preloadAssets();
check('the yacht hull loaded', hasModel('bossYacht'));
for (const a of CONFIG.enemies.bossYacht.crewAssets) check(`the ${a} model loaded`, hasModel(a));

// The scene: a sea plane at the waterline so "is it floating right" is a thing
// the picture can answer, and the same three-light rig the other look pages use.
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x2a3438, 2.0));
const key = new THREE.DirectionalLight(0xfff2e0, 2.4); key.position.set(-3, 4, 5); scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe4ff, 1.0); fill.position.set(4, 1, 3); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.1); rim.position.set(1, 2, -5); scene.add(rim);
const sea = new THREE.Mesh(
  new THREE.BoxGeometry(120, 0.06, 60),
  new THREE.MeshBasicMaterial({ color: 0x2f7fd0, transparent: true, opacity: 0.5 }),
);
sea.position.y = bounds.surfaceY;
scene.add(sea);

// The hull, placed exactly where systems/bossBoat.js pins it.
const hull = createVisual('bossYacht');
hull.position.set(0, bounds.surfaceY + (CONFIG.bossBoat.draft ?? -0.35), 0);
scene.add(hull);
hull.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(hull);
// What the deck measurement is actually looking at. It works in the HULL's
// local frame and bins along local x, so if the orientation lives on the outer
// group rather than on a child, "along the hull" is not local x at all.
{
  log(`hull group: scale ${hull.scale.toArray().map((v) => v.toFixed(3)).join(', ')}  `
    + `quat ${hull.quaternion.toArray().map((v) => v.toFixed(3)).join(', ')}`);
  const toLocal = new THREE.Matrix4().copy(hull.matrixWorld).invert();
  const local = new THREE.Box3();
  const localOutline = new THREE.Box3();
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  hull.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    m.multiplyMatrices(toLocal, o.matrixWorld);
    const pos = o.geometry.attributes.position;
    const into = o.userData.__isOutline ? localOutline : local;
    for (let i = 0; i < pos.count; i += 7) into.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
  });
  log(`hull LOCAL box (what deckProfile bins): x ${local.min.x.toFixed(2)}..${local.max.x.toFixed(2)}  `
    + `y ${local.min.y.toFixed(2)}..${local.max.y.toFixed(2)}  z ${local.min.z.toFixed(2)}..${local.max.z.toFixed(2)}`);
  if (localOutline.isEmpty()) log('   (no outline shell meshes)');
  else {
    log(`   outline shell LOCAL box: x ${localOutline.min.x.toFixed(2)}..${localOutline.max.x.toFixed(2)}  `
      + `y ${localOutline.min.y.toFixed(2)}..${localOutline.max.y.toFixed(2)}`);
  }
}
log(`hull on station: ${(box.max.x - box.min.x).toFixed(2)} long, `
  + `${(box.max.y - bounds.surfaceY).toFixed(2)} above the water, `
  + `${(bounds.surfaceY - box.min.y).toFixed(2)} below it`);
check('the yacht floats rather than wallows',
  box.max.y - bounds.surfaceY > (box.max.y - box.min.y) * 0.5,
  'more of the hull is above the waterline than under it');

// ---------------------------------------------------------------------------
// THE HITBOX — is it the hull, or a bubble around it?
// ---------------------------------------------------------------------------
// `radius` is a circle centred on the creature, and on a hull that is four
// times longer than it is tall most of that circle is empty sky and empty
// water. Drawn here against the silhouette so the fit is a thing you can see
// rather than a number to trust.
{
  const shape = attachHitShape(hull, 'bossYacht');
  check('the yacht has a fitted hit shape', !!shape,
    shape ? `${shape.spheres.length} spheres` : 'none — it is still a plain circle');
  if (shape) {
    tickHitShapes();
    refreshHitShape(shape);
    const box = new THREE.Box3().setFromObject(hull);
    const hullLen = box.max.x - box.min.x;
    const hullTall = box.max.y - box.min.y;

    let far = 0;
    let tallest = 0;
    const marks = new THREE.Group();
    for (const s of shape.spheres) {
      far = Math.max(far, Math.hypot(s.wx - hull.position.x, s.wy - hull.position.y) + s.wr);
      tallest = Math.max(tallest, s.wr);
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(s.wr, 20, 14),
        new THREE.MeshBasicMaterial({ color: 0xff9a4a, wireframe: true, transparent: true, opacity: 0.55 }),
      );
      m.position.set(s.wx, s.wy, 0);
      marks.add(m);
    }
    log(`hit shape: ${shape.spheres.length} spheres, biggest r ${tallest.toFixed(2)}, `
      + `reach ${far.toFixed(2)} — against a hull ${hullLen.toFixed(1)} long by ${hullTall.toFixed(1)} tall `
      + `and the old circle of r ${CONFIG.enemies.bossYacht.radius}`);
    // A CHAIN, not a ball: no single sphere may be as tall as the hull is long.
    check('no sphere swallows the whole boat', tallest < hullLen * 0.35,
      `biggest r ${tallest.toFixed(2)} against ${(hullLen * 0.35).toFixed(2)}`);
    // IT SHOULD REACH FURTHER ALONG and far less far UP. The old circle's
    // problem was both ways round at once: r 4.6 on a 13-long hull did not
    // reach the bow or the stern at all, while standing 4.6 into the sky and
    // 4.6 under the keel. So "tighter" is not one number — it is longer than
    // the circle in x and shorter in y.
    const sx = shape.spheres.map((q) => q.wx);
    const sy = shape.spheres.map((q) => q.wy);
    const spanX = (Math.max(...sx) + tallest) - (Math.min(...sx) - tallest);
    const spanY = (Math.max(...sy) + tallest) - (Math.min(...sy) - tallest);
    const r2 = CONFIG.enemies.bossYacht.radius * 2;
    log(`   shape spans ${spanX.toFixed(1)} x ${spanY.toFixed(1)} — hull is ${hullLen.toFixed(1)} x ${hullTall.toFixed(1)}, `
      + `the old circle was ${r2.toFixed(1)} x ${r2.toFixed(1)}`);
    check('...it covers the length the circle could not', spanX > r2,
      `${spanX.toFixed(1)} along against the circle's ${r2.toFixed(1)}`);
    check('...without standing as far into the sky', spanY < r2,
      `${spanY.toFixed(1)} tall against the circle's ${r2.toFixed(1)}`);
    check('...and it does not overhang the hull', spanX < hullLen * 1.25,
      `${spanX.toFixed(1)} against a hull ${hullLen.toFixed(1)} long`);
    // Laid along the boat rather than stacked up its mast — the bug that comes
    // of slicing a hull along the axis a fish is long on.
    const xs = shape.spheres.map((s) => s.wx);
    const ys = shape.spheres.map((s) => s.wy);
    const alongX = Math.max(...xs) - Math.min(...xs);
    const alongY = Math.max(...ys) - Math.min(...ys);
    check('...and it runs along the hull, not up the mast', alongX > alongY * 1.5,
      `spread ${alongX.toFixed(2)} along x against ${alongY.toFixed(2)} up y`);

    scene.add(marks);
    render('HIT SHAPE — the spheres it actually tests against', bounds.surfaceY - 1, 11);
    scene.remove(marks);
  }
}

// The adapter systems/bossBoat.js builds, verbatim in shape.
const def = CONFIG.enemies.bossYacht;
clearDeckCache();
resetCrew(scene);
// WHAT THE DECK GRID ACTUALLY HOLDS. deckProfile keeps its answer to itself —
// one height per bin — and when that answer is surprising there is no way to
// ask it why. This walks the same geometry into the same grid and prints the
// floor area row by row, so "which surface did it decide was the deck" is
// answerable. Diagnostic only; nothing below reads it.
{
  const BINS = 24;
  const toLocal = new THREE.Matrix4().copy(hull.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
  const ab = new THREE.Vector3(); const ac = new THREE.Vector3(); const cr = new THREE.Vector3();
  const tris = [];
  let lo = Infinity; let hi = -Infinity;
  hull.traverse((o) => {
    if (!o.isMesh || o.userData.__isOutline || !o.geometry?.attributes?.position) return;
    m.multiplyMatrices(toLocal, o.matrixWorld);
    const pos = o.geometry.attributes.position;
    const idx = o.geometry.index;
    const n = Math.floor((idx ? idx.count : pos.count) / 3);
    for (let t = 0; t < n; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      lo = Math.min(lo, a.x, b.x, c.x); hi = Math.max(hi, a.x, b.x, c.x);
    }
  });
  const span = hi - lo; const cell = span / BINS; const cellArea = cell * cell;
  const cols = Array.from({ length: BINS }, () => new Map());
  for (let i = 0; i < tris.length; i += 9) {
    a.set(tris[i], tris[i + 1], tris[i + 2]);
    b.set(tris[i + 3], tris[i + 4], tris[i + 5]);
    c.set(tris[i + 6], tris[i + 7], tris[i + 8]);
    cr.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const twice = cr.length();
    if (!(twice > 0)) continue;
    const area = twice * 0.5;
    const flat = Math.abs(cr.y) / twice;
    if (flat < 0.5) continue;
    const samples = Math.min(24, Math.max(1, Math.ceil(area / cellArea)));
    const share = (area * flat) / samples;
    for (let s = 0; s < samples; s++) {
      let u = Math.random(); let v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const px = a.x + ab.x * u + ac.x * v;
      const py = a.y + ab.y * u + ac.y * v;
      const col = Math.min(BINS - 1, Math.max(0, Math.floor((px - lo) / cell)));
      const row = Math.floor(py / cell);
      cols[col].set(row, (cols[col].get(row) ?? 0) + share);
    }
  }
  log(`\ndeck grid: lo ${lo.toFixed(2)} span ${span.toFixed(2)} cell ${cell.toFixed(3)} `
    + `need ${cellArea.toFixed(3)} of FLOOR per cell`);
  log('  bin  localX   rows above water with enough floor (row: area, row height)');
  for (let i = 0; i < BINS; i += 2) {
    const rows = [...cols[i].entries()].filter(([r, ar]) => r >= 0 && ar >= cellArea).sort((p, q) => p[0] - q[0]);
    log(`  ${String(i).padStart(3)}  ${(lo + (i + 0.5) * cell).toFixed(2).padStart(6)}   `
      + (rows.length
        ? rows.map(([r, ar]) => `${r}:${ar.toFixed(2)}@y${((r + 1) * cell).toFixed(2)}`).join('  ')
        : '— nothing standable'));
  }
  log('');
}

const deck = {
  mesh: hull,
  assetKey: def.asset,
  crewAsset: def.crewAsset,
  crewAssets: def.crewAssets,
  crewCount: def.crewCount,
  crewMin: def.crewMin,
  crewMax: def.crewMax,
  crewAt: def.crewAt ?? null,
  crewGlued: def.crewGlued === true,
  halfLength: def.radius,
  spawnScale: hull.scale.x || 1,
};
spawnCrewFor(scene, deck);

const DT = 1 / 60;
const DT_SWAY = 1 / 60;
check('the guests are aboard', crew.length > 0, `${crew.length} aboard`);
const modelled = crew.filter((f) => f.body.kind === 'model').length;
check('...and they are the MODEL, not the box fallback', modelled === crew.length,
  `${modelled} of ${crew.length} bound to the rigged skeleton`);

// Where they actually ended up. The deck measurement is the thing being tested:
// a guest standing under the sea means it read a piece of hull, and one far
// above the rail means it read the flybridge roof.
// IS HE STANDING ON IT, OR IN IT? The question the numbers have to answer, and
// the one a picture of a man behind a bulwark cannot. `originToFeet` used to be
// the lowest flesh CENTROID — the middle of a shoe — which stands a man half a
// foot into the deck. Measured here against the drawn mesh's own lowest point.
for (const f of crew) {
  const soleBox = new THREE.Box3().setFromObject(f.body.group);
  // The deck he was placed on, in world units.
  f.body.group.parent.updateMatrixWorld(true);
  const deckWorld = new THREE.Vector3(f.deckX, f.deckY, 0)
    .applyMatrix4(f.body.group.parent.matrixWorld);
  const gap = soleBox.min.y - deckWorld.y;
  log(`stance: deckX ${f.deckX.toFixed(2)}  deck at y ${deckWorld.y.toFixed(3)}  `
    + `sole at y ${soleBox.min.y.toFixed(3)}  ->  ${gap >= 0 ? 'floating' : 'sunk'} ${Math.abs(gap).toFixed(3)}`);
  check('his soles are ON the deck, not in it or above it', Math.abs(gap) < 0.06,
    `${(gap * 100).toFixed(1)} cm off, on a ${f.height.toFixed(2)}-unit man`);
  // PLUMB, to within his own idle. "Upright" is not zero for every model: a
  // real rig's idle pose has a little weight on one leg and a little tilt in
  // the head, and the ragdoll is built from the model's OWN rest pose, so that
  // tilt is carried faithfully rather than straightened out. What would be
  // wrong is a LEAN — the whole figure off its feet — and that is a different
  // order of magnitude.
  const lean = Math.abs(f.rig.points.head.x - f.rig.points.hips.x);
  f.__restLean = lean;
  check('...and he is standing up straight', lean < f.height * 0.05,
    `head is ${lean.toFixed(4)} off the hips, on a ${f.height.toFixed(2)}-unit man`);
}
check('the party is the size the row asks for',
  crew.length >= def.crewMin && crew.length <= def.crewMax,
  `${crew.length} aboard, asked for ${def.crewMin}-${def.crewMax}`);
{
  // A MIXED party, not one man printed four times. Only meaningful when more
  // than one turned up, and it is a roll, so this reports rather than fails.
  const kinds = new Set(crew.map((f) => f.body.group?.name ?? f.body.kind));
  log(`models aboard: ${[...kinds].join(', ')} (${kinds.size} of ${def.crewAssets.length} kinds, rolled per person)`);
}
{
  const hullBox = new THREE.Box3().setFromObject(hull);
  const bowward = crew.every((f) => f.rig.points.hips.x > hullBox.min.x + (hullBox.max.x - hullBox.min.x) * 0.6);
  check('...standing forward, at the bow', bowward,
    `x ${crew.map((f) => f.rig.points.hips.x.toFixed(1)).join(', ')} in hull ${hullBox.min.x.toFixed(1)}..${hullBox.max.x.toFixed(1)}`);
}

// A wide side-on camera. `r` is the half-width of the shot: the default frames
// the hull, and the throw needs far more room, because the real game's camera
// is 92 units across (bounds.frameWidth) and a body leaving a 26-unit crop is
// still in frame in the actual game.
function render(caption, focusY = bounds.surfaceY - 2, r = 13) {
  const cam = new THREE.OrthographicCamera(-r, r, r * (H / W), -r * (H / W), 0.1, 400);
  cam.position.set(0, focusY, 100);
  cam.lookAt(0, focusY, 0);
  gl.render(scene, cam);
  present(caption);
}

function closeUp(caption, at, r = 2.2, hideHull = false) {
  const cam = new THREE.OrthographicCamera(-r, r, r * (H / W), -r * (H / W), 0.1, 400);
  cam.position.set(at.x, at.y, 60);
  cam.lookAt(at.x, at.y, 0);
  // The ragdoll solves at z = 0 and the hull is 2.6 units thick around it, so
  // its near side sits BETWEEN the camera and the body. Fine in the wide shot,
  // where he stands at the deck edge; fatal in a close-up, which otherwise
  // photographs the side of the boat.
  // Hide the hull's OWN children only. `hull.visible = false` would take the
  // guest with it — while he is glued he is a CHILD of the hull, and an
  // invisible parent hides everything under it.
  const hidden = hideHull
    ? hull.children.filter((o) => o.userData.__crew !== true)
    : [];
  for (const o of hidden) o.visible = false;
  sea.visible = !hideHull;
  gl.render(scene, cam);
  for (const o of hidden) o.visible = true;
  sea.visible = true;
  present(caption);
}

render('ON STATION — one guest at the bow, parented to the hull');

// Framed on the FEET rather than the hips: the question these answer is
// whether each of them is standing on the deck or buried in it.
crew.forEach((f) => {
  closeUp(
    `AT THE BOW — deckX ${f.deckX.toFixed(2)}, deckY ${f.deckY.toFixed(2)}`,
    { x: f.rig.points.hips.x, y: f.rig.points.footL.y + 0.55 }, 1.9,
  );
  // Tight on the shoes. The HULL IS HIDDEN for this one and a line drawn at
  // the deck height instead: in an orthographic side view the near bulwark is
  // always between the camera and his feet, so a close-up of the boat is a
  // close-up of the boat, and the one thing it cannot show is where his soles
  // are relative to the deck they are standing on.
  f.body.group.parent.updateMatrixWorld(true);
  const deckY = new THREE.Vector3(f.deckX, f.deckY, 0)
    .applyMatrix4(f.body.group.parent.matrixWorld).y;
  const line = new THREE.Mesh(
    new THREE.BoxGeometry(4, 0.006, 4),
    new THREE.MeshBasicMaterial({ color: 0xff9a4a }),
  );
  line.position.set(f.rig.points.hips.x, deckY, 0);
  scene.add(line);
  closeUp('HIS FEET — orange line is the deck he was placed on; hull hidden',
    { x: f.rig.points.hips.x, y: f.rig.points.footL.y + 0.06 }, 0.5, true);
  scene.remove(line);
});

// COMING ABOUT. The hull turns to face the way it is sailing, and the guest has
// to turn WITH it — he is parented to this node for exactly that reason.
//
// STEPPED AT THE GAME'S OWN FRAME RATE, over the real turn duration, because
// the man is SPRUNG to his standing pose rather than snapped to it (see
// swayAboard). Jumping the hull through the turn in five big steps and ticking
// the solver a few times between them is not a faster version of the same test:
// the pose target leaps a metre at a time, the spring cannot follow, and the
// bone-length pass folds him in half. That looks exactly like a rigging bug and
// is entirely an artefact of the harness.
{
  const swing = CONFIG.bossBoat.turnSwing ?? 1.1;
  const turnTime = CONFIG.bossBoat.turnTime ?? 1.6;
  const curve = CONFIG.bossBoat.turnEase ?? 'inOutCubic';
  const frames = Math.round(turnTime / DT);
  const marks = new Map([[0, 0], [Math.round(frames * 0.35), 35], [Math.round(frames * 0.6), 60], [frames, 100]]);
  for (let i = 0; i <= frames; i++) {
    const yaw = Math.PI * ease(curve, i / frames);
    hull.rotation.y = yaw;
    hull.position.x = swing * Math.sin(yaw);
    updateCrew(DT, scene);
    if (marks.has(i)) {
      render(`COMING ABOUT ${marks.get(i)}% (yaw ${(yaw * 180 / Math.PI).toFixed(0)}°) — he stays on the bow`,
        bounds.surfaceY - 1, 11);
    }
  }
  closeUp('COME ABOUT — reversed, and still standing on the bow',
    { x: crew[0].rig.points.hips.x, y: crew[0].rig.points.footL.y + 0.55 }, 1.9);

  const turned = new THREE.Box3().setFromObject(hull);
  check('after coming about, he is on the bow — which is now the other end',
    crew.every((f) => f.rig.points.hips.x < turned.min.x + (turned.max.x - turned.min.x) * 0.4),
    `x ${crew.map((f) => f.rig.points.hips.x.toFixed(1)).join(', ')} in hull ${turned.min.x.toFixed(1)}..${turned.max.x.toFixed(1)}`);
  // HE LEANS THROUGH IT AND COMES BACK UP. A man on a deck that is swinging
  // under him should not arrive perfectly plumb — that would mean the sway is
  // not reading the boat at all — so what is checked is that he leaned, and
  // then that the spring brought him back.
  const leanAtEnd = Math.abs(crew[0].rig.points.head.x - crew[0].rig.points.hips.x);
  check('...he leaned as the hull swung under him', leanAtEnd > 0.01,
    `head ${leanAtEnd.toFixed(4)} off the hips at the end of the turn`);
  for (let i = 0; i < 180; i++) updateCrew(DT, scene);
  const leanSettled = Math.abs(crew[0].rig.points.head.x - crew[0].rig.points.hips.x);
  // Back to HIS OWN idle, which is not necessarily plumb — see the note above.
  check('...and came back to his idle once it settled',
    Math.abs(leanSettled - crew[0].__restLean) < 0.02,
    `${leanAtEnd.toFixed(4)} -> ${leanSettled.toFixed(4)}, idle is ${crew[0].__restLean.toFixed(4)}`);

  // Back to where the rest of the page expects it, at the same rate.
  for (let i = frames; i >= 0; i--) {
    const yaw = Math.PI * ease(curve, i / frames);
    hull.rotation.y = yaw;
    hull.position.x = swing * Math.sin(yaw);
    updateCrew(DT, scene);
  }
}

// THE GLUE HOLDS. The same call every bullet makes (systems/combat.js), aimed
// at the middle of the party with a radius that covers the whole boat — a
// working boat's crew would all be in the water after this.
const knocked = damageCrew(scene, crew[0].rig.points.hips.x, crew[0].rig.points.hips.y, 40);
check('gunfire does NOT take the guests off the yacht', knocked === 0, `${knocked} knocked off`);
check('...they are all still standing', crew.every((f) => f.state !== 'ragdoll'));
check('...and still children of the hull', crew.every((f) => f.body.group.parent === hull));

// A HIT ON THE HULL ROCKS THEM. The same call updateBossBoat makes whenever
// the boat's health drops.
{
  const head = crew[0].rig.points.head;
  const restX = head.x;
  const feetBefore = crew.map((f) => f.rig.points.footL.x);
  jostleCrew(hull.position.x, hull.position.y, def.radius * 2.5, 1.4);
  for (let i = 0; i < 10; i++) updateCrew(DT_SWAY, scene);
  const shifted = Math.abs(crew[0].rig.points.head.x - restX);
  check('a hit on the hull rocks the guests', shifted > 0.01,
    `head moved ${shifted.toFixed(3)} units`);
  check('...while their feet stay planted',
    crew.every((f, i) => Math.abs(f.rig.points.footL.x - feetBefore[i]) < 1e-6));
  closeUp('JOSTLED — hit by the hull taking damage, feet still planted',
    { x: crew[0].rig.points.hips.x, y: crew[0].rig.points.footL.y + 0.9 }, 1.5);
  // And it settles back: the same spring that let him move brings him home.
  // Seven seconds. The sway is deliberately soft (see CONFIG.boats.crew.sway)
  // and the jostle is deliberately strong, so a hard hit takes a while to bleed
  // off — which is the point of it, and makes this a slow check rather than a
  // failing one.
  for (let i = 0; i < 420; i++) updateCrew(DT_SWAY, scene);
  const settled = Math.abs(crew[0].rig.points.head.x - restX);
  check('...and he settles back to the idle', settled < shifted * 0.4,
    `${shifted.toFixed(3)} → ${settled.toFixed(3)} units off rest`);
  closeUp('SETTLED — back to the idle a few seconds later',
    { x: crew[0].rig.points.hips.x, y: crew[0].rig.points.footL.y + 0.9 }, 1.5);
}

// THEN THE HULL GOES DOWN. This is the call resetBossBoat makes on the frame
// the boss dies.
const before = crew.map((f) => ({ x: f.rig.points.hips.x, y: f.rig.points.hips.y }));
throwCrewOff(scene, deck, hull.position.x, hull.position.y, CONFIG.bossBoat.crewBlast);
check('the hull going down throws every one of them', crew.every((f) => f.state === 'ragdoll'));
check('...and they are no longer children of the hull',
  crew.every((f) => f.body.group.parent !== hull));
{
  // Verlet keeps velocity as the gap between this position and the last, so
  // this is what "thrown violently" actually measures as.
  const speeds = crew.map((f) => Math.hypot(
    f.rig.points.hips.x - f.rig.points.hips.px,
    f.rig.points.hips.y - f.rig.points.hips.py,
  ) * 120);
  log(`launch speeds: ${speeds.map((s) => s.toFixed(1)).join(', ')} units/s`);
  check('thrown violently, not nudged', Math.min(...speeds) > 6,
    `slowest ${Math.min(...speeds).toFixed(1)} u/s vs the ordinary crew knock of ~7`);
  const outward = crew.every((f, i) => Math.sign(f.rig.points.hips.x - f.rig.points.hips.px)
    === Math.sign(before[i].x - hull.position.x || 1));
  check('...outward from the hull, each away from its centre', outward);
}

// Then let the real solver run. 2.5 seconds at the game's own step.
const startY = crew.map((f) => f.rig.points.hips.y);
let sawAir = false;
for (let i = 0; i < 150; i++) {
  updateCrew(DT, scene);
  if (i === 12) {
    render('0.2s — thrown off the rails, still in the air', bounds.surfaceY - 1, 26);
    closeUp('0.2s CLOSE — is the mesh flopping, or distorting?', crew[0].rig.points.hips, 1.6, true);
  }
  if (i === 30) closeUp('0.5s CLOSE — same question, further into the fall', crew[0].rig.points.hips, 1.6, true);
  if (i === 45) {
    render('0.75s — at the top of the arc', bounds.surfaceY - 1, 26);
    closeUp('0.75s CLOSE', crew[0].rig.points.hips, 1.6, true);
  }
  if (i === 90) closeUp('1.5s CLOSE — under water', crew[0].rig.points.hips, 1.6, true);
  if (crew.some((f) => f.rig.points.hips.y > bounds.surfaceY)) sawAir = true;
}
render('2.5s — in the water, sinking, and edible', bounds.surfaceY - 6, 26);

check('they were thrown UP before they fell', sawAir);
const nowY = crew.map((f) => f.rig.points.hips.y);
check('every body ended up lower than it started',
  nowY.every((y, i) => y < startY[i]),
  nowY.map((y, i) => `${startY[i].toFixed(1)}→${y.toFixed(1)}`).join(' '));
check('and nobody reached a NaN', crew.every((f) => f.rig.list.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))));
check('nobody fell out of the world',
  crew.every((f) => f.rig.points.hips.y > bounds.bottom - 2 && Math.abs(f.rig.points.hips.x) < bounds.right + 5));

// Bones, not boxes, all the way through the ragdoll: the limbs have to have
// actually MOVED relative to each other, or this is a rigid statue falling.
let bent = 0;
for (const f of crew) {
  const { chest, elbowL, handL } = f.rig.points;
  const upper = Math.atan2(elbowL.y - chest.y, elbowL.x - chest.x);
  const lower = Math.atan2(handL.y - elbowL.y, handL.x - elbowL.x);
  if (Math.abs(upper - lower) > 0.2) bent++;
}
check('their elbows bent — this is a ragdoll, not a falling statue', bent > 0, `${bent} of ${crew.length}`);

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nALL PASS', fails ? 'bad' : 'ok');
document.title = fails ? `yacht deck — ${fails} FAILED` : 'yacht deck — all pass';
