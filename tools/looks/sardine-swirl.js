// ---------------------------------------------------------------------------
// SARDINE SWIRL — LOOK DEV, AND THE ONE PLACE THE AXES ARE VISIBLE
//
//   npm run looks:swirl
//
// tools/sardine-swirl-test.mjs proves the school — the pairing, the divergence,
// the reach, the bed — and it has never seen a sardine. It cannot: Node serves
// no models, so every body in that harness is the `blade` fallback shape (see
// the note on `sardineBlade` in assets.js). Everything about the ART is a
// question about a picture, and this is the sheet:
//
//   * does sardine.glb load, keep its UVs and paint the fish, or is it the
//     one-flat-colour failure a dropped UV set gives you — which throws
//     nothing, logs nothing, and looks like a shading choice?
//   * is it POINTING? `forward: '-Z'` says the nose is the -Z end of the file.
//     Backwards, the school still swims and every fish in it swims tail-first.
//   * is it TURNING on the right axis? updateSardineSwirl writes two angles by
//     hand: `rotation.z` noses the body along the Lorenz flow and `rotation.y`
//     is the whip. The whip is a roll about the body's own long axis ONLY
//     because orientationQuaternion sends `forward` to entity +Y — and if that
//     is wrong, the fish cartwheels end over end instead of flashing, which is
//     a thing you have to see side by side to be sure of.
//   * does it GLINT? The chrome film (CONFIG.chromeSardine) is an invented
//     metal environment multiplied over the model's own paint, and its grain
//     jitters the normal that environment is read through so the body breaks
//     into scales. A facet fires ONCE as it crosses the key, so a single frame
//     of this looks like noise — the strip is eight rolls for that reason, and
//     it carries the grain-off frame beside them to compare against.
//   * and does any of it read at FIGHT SCALE, where a sardine is one unit
//     against fifty of water?
//
// It imports the SHIPPING modules — assets.js and sardineSwirl.js — so the last
// section is the game's own field with the game's own numbers. Built with vite
// rather than run off the dev server on purpose: a build resolves the JSON and
// ?raw CSV imports without starting a second game, which is the thing that
// overwrites imported-tuning.json.
//
// IT WRITES NOTHING. There is no save path in this page and no dev server
// behind it.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, orientationQuaternion, ASSETS } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import {
  createSardineSwirlVisual, updateSardineSwirl, resetSardineSwirl,
  sardineSize, sardineReach, sardineCount, sardineRoll,
} from '../../path/src/systems/sardineSwirl.js';
import { createPost } from '../../path/src/systems/post.js';

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

const W = 380;
const H = 300;
const DT = 1 / 60;

// ONE WebGL context for the whole page, blitted into a plain 2D canvas per
// cell. A renderer per cell is the obvious way to write this and it silently
// destroys the sheet: browsers keep about sixteen live contexts and discard the
// oldest, so past a dozen panels the early ones go black — AFTER they drew
// correctly, with nothing thrown and nothing in the console.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

updateBounds(W / H);

const ortho = (h) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(0, 0, 20);
  return c;
};
// Close enough to see a 1.25-unit sardine as an animal.
const camera = ortho(2.4);
// The whole school, magnified.
const fieldCam = ortho(20);
// THE SAME SHOT AT THE SIZE THE PLAYER SEES IT. At zoom 1 the frustum IS the
// arena (see world.js) — fifty-odd units of water against a fish that is one.
// Every panel above this is a magnifying glass, and a look decision made only
// under a magnifying glass is a decision about a picture nobody is shown.
const fightCam = ortho(bounds.top - bounds.bottom);

const scene = new THREE.Scene();

// NO LIGHTS, AND THAT IS THE ASSET'S DECISION RATHER THAN A SHORTCUT. The
// sardine is `modelUnlit` — a MeshBasicMaterial wearing the chrome film — so
// every light in this scene would be a light nothing reads. The illumination in
// section 4 is entirely invented inside the shader, which is the whole idea of
// the film: see makeChromeMaterial in assets.js. Adding a key here to "make it
// look right" would light nothing and prove nothing.
await preloadAssets();

// The game's own bloom, tone map and grade. `activeCam` is what draw() renders
// through, so every panel below sets it and calls draw() instead of reaching
// for gl.render.
const post = createPost(gl);
let activeCam = camera;
function draw(cam) {
  activeCam = cam ?? activeCam;
  post.resize();
  post.render(scene, activeCam, DT);
}

// --- the sheet --------------------------------------------------------------

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

// Blit whatever is in the renderer into a cell, and POST it. The frames are
// read off DISK rather than off the screen — the Browser pane's own screenshot
// goes blank or times out on a sheet this tall.
function present(title, note) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  // The renderer is alpha:true, so the water behind it is this fill and not
  // the sky — a transparent PNG on a white viewer is a picture of nothing.
  ctx.fillStyle = '#081426';
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

const props = [];
function clearAll() {
  for (const p of props) scene.remove(p);
  props.length = 0;
}
function add(mesh) {
  scene.add(mesh);
  props.push(mesh);
  return mesh;
}

// The two writes updateSardineSwirl makes on every body, in the order it makes
// them, so a panel here is posing a fish exactly the way the game does rather
// than approximating it. See the loop in systems/sardineSwirl.js.
//
// INCLUDING THE EULER ORDER, which is the whole subject of section 3 and is not
// a detail a preview may quietly get right on its own: addOne sets 'ZYX' so the
// whip is a roll about the long axis, and a sheet that left three's default
// here would draw a fish the game does not draw.
const ROTATION_ORDER = 'ZYX';
function pose(mesh, headingRad, rollRad) {
  mesh.rotation.order = ROTATION_ORDER;
  mesh.rotation.z = headingRad - Math.PI / 2;
  mesh.rotation.y = rollRad;
  mesh.scale.setScalar(sardineSize());
}

// ---------------------------------------------------------------------------
// 1. THE MODEL LOADED, AND IT IS A FISH
//
// The failure this panel is for is the quiet one: a model whose UVs were pruned
// still renders, at one texel of its map, as a single flat colour over the
// whole body. Nothing throws. Nothing logs. It looks like a decision.
// ---------------------------------------------------------------------------
section('1. the body — did the model arrive, painted, the right way up', 3);
{
  const def = ASSETS.sardineBlade;
  check('the asset declares a model', !!def?.model, def?.model ?? 'none');
  const mesh = createVisual('sardineBlade');
  let meshes = 0;
  let mapped = 0;
  let uv = 0;
  mesh.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m?.map)) mapped++;
    if (o.geometry?.getAttribute('uv')) uv++;
  });
  // THE FALLBACK IS A SINGLE `blade` MESH WITH NO MAP, so this is also the
  // check that the model loaded at all rather than the shape standing in.
  check('it is the model, not the blade fallback', mapped > 0, `${mapped}/${meshes} mesh(es) carry a base map`);
  check('...and its UVs survived the import', uv === meshes, `${uv}/${meshes} mesh(es) have a uv attribute`);

  // Drawn as the game draws it: nosed along +X (heading 0) with no roll, which
  // is the resting pose of a sardine crossing the screen to the right.
  clearAll();
  pose(add(mesh), 0, 0);
  draw(camera);
  present('at rest, heading right',
    `<span class="note">nose right, dorsal fin up, belly down.<br>` +
    `fit ${ASSETS.sardineBlade.fit} x size ${sardineSize()} = ` +
    `${(ASSETS.sardineBlade.fit * sardineSize()).toFixed(2)} units long</span>`);
}

// ---------------------------------------------------------------------------
// 2. POINTING
//
// `rotation.z = atan2(vy, vx) - PI/2` is the whole of the heading, and it is
// correct only if orientationQuaternion put the model's nose on entity +Y. The
// arithmetic is asserted first — it is exact, and a picture of eight fish is
// not — and then drawn, because "which end is the nose" is a fact about the
// geometry that no amount of quaternion algebra can check.
// ---------------------------------------------------------------------------
section('2. pointing — the nose follows the flow', 4);
{
  const q = orientationQuaternion(ASSETS.sardineBlade);
  const AX = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
  const nose = new THREE.Vector3().fromArray(AX[ASSETS.sardineBlade.forward]).applyQuaternion(q);
  check('the model\'s forward lands on entity +Y', nose.dot(new THREE.Vector3(0, 1, 0)) > 0.999,
    `forward '${ASSETS.sardineBlade.forward}' -> (${nose.toArray().map((n) => n.toFixed(3)).join(', ')})`);

  for (const deg of [0, 90, 180, 270]) {
    clearAll();
    const m = add(createVisual('sardineBlade'));
    pose(m, (deg * Math.PI) / 180, 0);
    draw(camera);
    present(`heading ${deg}`, `<span class="note">the nose should point ${
      { 0: 'right', 90: 'up', 180: 'left', 270: 'down' }[deg]}</span>`);
  }
}

// ---------------------------------------------------------------------------
// 3. TURNING
//
// The whip, sampled across half a turn. What must NOT happen is a cartwheel:
// the nose stays exactly where the heading put it and the BODY rolls under it,
// so the silhouette narrows to an edge at a quarter turn and comes back. A
// fish that pitches nose-over-tail here is a `forward` axis in the wrong place.
// ---------------------------------------------------------------------------
section('3. turning — the whip is a roll about the long axis', 5);
{
  const q = orientationQuaternion(ASSETS.sardineBlade);
  const AX = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
  // Where the nose ends up after BOTH writes, at four rolls, with the heading
  // held at 0. If the roll axis is the long axis this is invariant; anything
  // else moves it, and the largest deviation is what the check reports.
  let worst = 0;
  const probe = new THREE.Object3D();
  probe.rotation.order = ROTATION_ORDER;
  for (const roll of [0, 0.6, 1.2, 2.4, 3.9]) {
    probe.rotation.set(0, roll, 0 - Math.PI / 2, ROTATION_ORDER);
    probe.updateMatrixWorld(true);
    const n = new THREE.Vector3().fromArray(AX[ASSETS.sardineBlade.forward])
      .applyQuaternion(q).applyQuaternion(probe.quaternion);
    worst = Math.max(worst, n.distanceTo(new THREE.Vector3(1, 0, 0)));
  }
  check('the whip leaves the nose where the heading put it', worst < 1e-6,
    `nose moves ${worst.toExponential(1)} across half a turn`);

  for (const roll of [0, 0.6, 1.2, 2.4, 3.9]) {
    clearAll();
    pose(add(createVisual('sardineBlade')), 0, roll);
    draw(camera);
    present(`roll ${roll.toFixed(1)} rad`,
      `<span class="note">nose stays right; the flank turns edge-on and back</span>`);
  }
  // AND THE ROLL IS SIGNED PER BODY, which is what stops every chrome flash in
  // the school landing on the same frame. Sampled rather than asserted about
  // one draw — see sardineRoll.
  let neg = 0;
  for (let i = 0; i < 200; i++) if (sardineRoll() < 0) neg++;
  check('...and the school rolls both ways', neg > 40 && neg < 160, `${neg}/200 bodies roll negative`);
}

// ---------------------------------------------------------------------------
// 4. THE GLINT
//
// The chrome film over the model's own paint (CONFIG.chromeSardine), with the
// grain that makes it scales rather than a polished shell. The strip is one
// body at eight rolls, which is the only way to see the thing the effect IS: a
// facet is not a mark on the fish, it is a place that fires ONCE as it crosses
// the key and is dark either side of it, so a single frame of it looks like
// noise and eight frames look like metal.
//
// AND THE OFF STATE BESIDE IT. `grain` and `sparkle` at zero is the razor
// clam's smooth film on a painted body — a real look, and the one to compare
// against, because "is this better than nothing" is a question a sheet with
// only the new thing on it cannot answer.
// ---------------------------------------------------------------------------
section('4. the glint — the chrome film and its grain', 4);
{
  const cfg = CONFIG.chromeSardine ?? {};
  check('the sardine has its own chrome block', !!CONFIG.chromeSardine,
    `grain ${cfg.grain}, scale ${cfg.grainScale}, sparkle ${cfg.sparkle}`);
  check('...and it asks for grain, which is what makes it not the blade\'s film',
    (cfg.grain ?? 0) > 0 || (cfg.sparkle ?? 0) > 0,
    `grain ${cfg.grain ?? 0}, sparkle ${cfg.sparkle ?? 0}`);

  // THE FILM IS ON THE MATERIAL, not merely configured. makeChromeMaterial
  // parks its uniforms in userData, so this is the check that `modelChrome`
  // actually reached the model path — a flag nothing reads is the failure this
  // whole section would otherwise render straight past.
  let chromed = 0;
  let grainUniform = null;
  createVisual('sardineBlade').traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m?.userData?.__chrome) continue;
      chromed++;
      grainUniform = m.userData.__chrome.uChromeGrain.value;
    }
  });
  check('the film is attached to the model\'s material', chromed > 0, `${chromed} material(s)`);
  check('...and applyChromeSettings pushed the sardine block onto it, not the blade\'s',
    grainUniform === cfg.grain, `uChromeGrain ${grainUniform} against config ${cfg.grain}`);

  for (const roll of [0, 0.45, 0.9, 1.35, 1.8, 2.25, 2.7, 3.15]) {
    clearAll();
    pose(add(createVisual('sardineBlade')), 0, roll);
    draw(camera);
    present(`glint at roll ${roll.toFixed(2)}`,
      '<span class="note">facets crossing the key one at a time</span>');
  }

  // THE SAME BODY WITH THE GRAIN OFF. Written straight onto the live uniforms
  // and put back afterwards, rather than by editing CONFIG: this page must not
  // leave the block it borrowed in a state the next panel reads.
  const mats = [];
  const mesh = createVisual('sardineBlade');
  mesh.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m?.userData?.__chrome) mats.push(m.userData.__chrome);
    }
  });
  const saved = mats.map((u) => [u.uChromeGrain.value, u.uChromeSparkle.value]);
  for (const u of mats) { u.uChromeGrain.value = 0; u.uChromeSparkle.value = 0; }
  clearAll();
  pose(add(mesh), 0, 0.9);
  draw(camera);
  present('the same fish, grain off',
    '<span class="note">the razor clam\'s smooth film on painted art —<br>compare with roll 0.90 above</span>');
  mats.forEach((u, i) => { u.uChromeGrain.value = saved[i][0]; u.uChromeSparkle.value = saved[i][1]; });
}

// ---------------------------------------------------------------------------
// 5. THE REAL FIELD
//
// The game's own updateSardineSwirl, driven for long enough that the pairs have
// come apart, at two scales. The second one is the only picture on this page
// that is what the player is shown.
// ---------------------------------------------------------------------------
section('5. the school, through the shipping system', 2);
{
  clearAll();
  resetSardineSwirl();
  const group = createSardineSwirlVisual();
  scene.add(group);
  props.push(group);
  const pos = new THREE.Vector3(0, 0, 0);
  const stats = {};
  for (let i = 0; i < 60 * 25; i++) updateSardineSwirl(DT, scene, pos, 4, stats, []);
  check('the school is in the water', sardineCount() > 0, `${sardineCount()} bodies`);
  // THE ORDER THE PANELS ABOVE ASSUMED, read back off a body the system built.
  // Without this the whole of section 3 is the page agreeing with its own
  // constant — the check would still pass on a game that had gone back to
  // three's default and drawn a school of cartwheeling fish.
  const orders = new Set(group.children.map((m) => m.rotation.order));
  check('...and every body carries the roll-first rotation order',
    orders.size === 1 && orders.has(ROTATION_ORDER),
    `${[...orders].join(', ')} (the sheet posed with ${ROTATION_ORDER})`);
  check('...and the bite circle is the body\'s own size',
    Math.abs(sardineReach() * 2 - ASSETS.sardineBlade.fit * sardineSize()) < 0.2,
    `${(sardineReach() * 2).toFixed(2)} across, body ${(ASSETS.sardineBlade.fit * sardineSize()).toFixed(2)} long`);

  draw(fieldCam);
  present('the field, magnified',
    `<span class="note">${sardineCount()} bodies on a Lorenz attractor after 25s.<br>` +
    'every fish nosed along the flow, each rolling its own way</span>');

  draw(fightCam);
  present('the same field at fight scale',
    `<span class="note">${(bounds.top - bounds.bottom).toFixed(0)} units of water top to bottom — ` +
    'what the player is actually shown</span>');
  resetSardineSwirl();
}

// ---------------------------------------------------------------------------

log('');
log(fails ? `${fails} check(s) failed` : 'all checks passed', fails ? 'bad' : 'ok');
await Promise.all(posted);
log(`${shotIndex} frame(s) posted to the drop box`, 'note');
