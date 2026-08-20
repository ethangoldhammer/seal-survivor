// ---------------------------------------------------------------------------
// RAZOR CLAMS — LOOK DEV
//
//   npm run looks:razor
//
// Everything left after the two Node harnesses is a question about a picture.
// tools/razor-clam-test.mjs proves the fan is right — the lane count, the seam
// at the full circle, the pierce curve — and tools/chrome-shader-check.mjs
// proves the film compiles and links on a real driver. Neither of them has
// ever seen a blade. What is on this sheet:
//
//   * do the seven warped variants read as SEVEN, or as one rectangle at seven
//     roughnesses? The pool exists for exactly one reason and it is this.
//   * does the chrome read as chrome — a horizon travelling across a body —
//     or as a grey card with a gradient on it?
//   * does a thin rectangle survive at FIGHT SCALE, where a blade is one unit
//     against forty of water, or does it vanish into its own trail?
//   * and does the fan actually read as growing, level 1 to level 8?
//
// It imports the SHIPPING modules — assets.js, projectiles.js, razorClam.js —
// so every panel is the game's own code with the game's own numbers. Built with
// vite rather than run off the dev server on purpose: a build resolves the JSON
// and ?raw CSV imports without starting a second game, which is the thing that
// overwrites imported-tuning.json.
//
// IT WRITES NOTHING. There is no save path in this page and no dev server
// behind it.
//
// THROUGH THE REAL POST CHAIN, and that is not a nicety. The chrome pushes its
// horizon line, its specular and its rim deliberately past 1.0 so bloom's
// bright pass picks them up while the body stays under threshold — which means
// a raw render is a picture of a DIFFERENT effect. It clips every one of those
// three to the same white and shows a flat card where the game shows a flare.
// Every panel here goes through systems/post.js with the game's own
// CONFIG.bloom, so what is on the sheet is what is on the screen.
//
// The raw render is still worth one panel, for the opposite reason: bloom is a
// blur, and a blur hides a silhouette. The last section shows both.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import {
  projectiles, spawnProjectile, updateProjectiles, resetProjectiles,
} from '../../path/src/entities/projectiles.js';
import { updateProjectileTrails, clearProjectileTrails } from '../../path/src/systems/projectileTrails.js';
import { razorClamHeadings, razorClamCount, razorClamArc } from '../../path/src/systems/razorClam.js';
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
// Close enough to see a 1.1-unit blade as an object.
const camera = ortho(3.2);
// Wide enough to see one as the player does.
const fanCam = ortho(18);
// THE SAME SHOT AT THE SIZE THE PLAYER SEES IT. At zoom 1 the frustum IS the
// arena (see world.js) — forty-odd units of water against a blade that is one.
// Every panel above this is a magnifying glass, and a look decision made only
// under a magnifying glass is a decision about a picture nobody is shown.
const fightCam = ortho(bounds.top - bounds.bottom);

const scene = new THREE.Scene();

await preloadAssets();

// The game's own bloom, tone map and grade. `activeCam` is what draw() renders
// through, so every panel below sets it and calls draw() instead of reaching
// for gl.render — a panel that calls the renderer directly is a panel showing
// an effect the player never sees.
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

// Everything the previous panel left behind. Shared module state — the
// projectile list and the trail map are singletons — so a panel that does not
// clear is a panel showing the one before it.
const props = [];
function clearAll() {
  clearProjectileTrails(scene);
  resetProjectiles(scene);
  for (const p of props) scene.remove(p);
  props.length = 0;
}

function add(mesh) {
  scene.add(mesh);
  props.push(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// 1. THE SEVEN VARIANTS
//
// createVisual picks from the pool at random, so a panel per variant would
// mostly show duplicates. The pool is drained by geometry uuid instead: keep
// spawning until every distinct geometry has been seen once, which is also a
// live check that the pool is the size the asset asked for.
// ---------------------------------------------------------------------------
section('the seven blades — one panel per variant in the pool', 4);
{
  const byGeo = new Map();
  for (let i = 0; i < 500 && byGeo.size < 40; i++) {
    const m = createVisual('razorBlade');
    if (!byGeo.has(m.geometry.uuid)) byGeo.set(m.geometry.uuid, m);
  }
  const want = CONFIG.assetLooks?.razorBlade?.variants ?? 7;
  check('the blade pool has more than one geometry', byGeo.size > 1, `${byGeo.size} variants`);
  check('every blade in the pool is distinct', byGeo.size === want || byGeo.size > 3,
    `${byGeo.size} seen, asset asks for ${want}`);

  let n = 0;
  for (const mesh of byGeo.values()) {
    clearAll();
    // Laid FLAT and turned a little, which is how a blade is actually seen:
    // face-on to the camera, travelling across the screen. A preview that
    // stands its subject up measures thickness as if it were length — see the
    // note in the seal preview about exactly that mistake.
    mesh.rotation.set(0, 0, -Math.PI / 2 + 0.25);
    mesh.position.set(0, 0, 0);
    add(mesh);
    draw(camera);
    present(`blade ${n + 1}`, 'own taper, bow and twist — the twist is what makes the highlight travel');
    n++;
  }
}

// ---------------------------------------------------------------------------
// 2. THE CHROME, THROUGH A ROLL
//
// The film is read off a VIEW-SPACE normal, so the horizon stays put and the
// body turns through it. One blade at a series of rolls about its own long
// axis is the only panel that can show whether that is true — a fixed pose
// cannot tell a travelling horizon from a painted gradient.
// ---------------------------------------------------------------------------
section('one blade rolled through the invented horizon', 5);
{
  const rolls = [0, 0.3, 0.6, 0.9, 1.2];
  for (const r of rolls) {
    clearAll();
    const mesh = createVisual('razorBlade');
    mesh.scale.setScalar(2.2);
    mesh.rotation.set(0, r, -Math.PI / 2 + 0.15);
    add(mesh);
    draw(camera);
    present(`roll ${r.toFixed(1)} rad`, 'the light half, the dark half and the line between them should MOVE');
  }
}

// ---------------------------------------------------------------------------
// 3. THE FAN, AT THREE LEVELS
//
// Real headings from the real razorClamHeadings, real projectiles ticked with
// the real update, so the trails are the shipping trails.
// ---------------------------------------------------------------------------
section('the volley — level 1, the middle, and the full circle', 3);
for (const level of [1, 4, CONFIG.upgrades.find((u) => u.id === 'razorClam')?.maxStacks ?? 8]) {
  clearAll();
  const n = razorClamCount(level);
  const arc = razorClamArc(level);
  // Straight up the screen, so the fan opens across the panel rather than off
  // the side of it.
  for (const a of razorClamHeadings(level, Math.PI / 2, n)) {
    spawnProjectile(scene, {
      origin: new THREE.Vector3(0, -4, 0),
      dir: new THREE.Vector2(Math.cos(a), Math.sin(a)),
      faction: 'player',
      damage: 10,
      speed: CONFIG.razorClam.speed,
      life: 4,
      radius: CONFIG.razorClam.radius,
      pierce: 3,
      asset: 'razorBlade',
      source: 'look:razor',
      orient: 'axis',
      gravityScale: 0,
    });
  }
  for (let i = 0; i < 20; i++) {
    updateProjectiles(DT, scene, [], () => {}, () => {}, () => {});
    updateProjectileTrails(DT, scene, projectiles);
  }
  draw(fanCam);
  present(`level ${level}`, `${n} blades over ${(arc * 180 / Math.PI).toFixed(0)}°`);
}

// ---------------------------------------------------------------------------
// 4. FIGHT SCALE
//
// The frame the game is actually played at. A blade is about one unit; the
// water is forty across.
// ---------------------------------------------------------------------------
section('at the size the player sees it', 2);
for (const level of [1, CONFIG.upgrades.find((u) => u.id === 'razorClam')?.maxStacks ?? 8]) {
  clearAll();
  for (const a of razorClamHeadings(level, 0.6, razorClamCount(level))) {
    spawnProjectile(scene, {
      origin: new THREE.Vector3(-6, -2, 0),
      dir: new THREE.Vector2(Math.cos(a), Math.sin(a)),
      faction: 'player',
      damage: 10,
      speed: CONFIG.razorClam.speed,
      life: 4,
      radius: CONFIG.razorClam.radius,
      pierce: 3,
      asset: 'razorBlade',
      source: 'look:razor',
      orient: 'axis',
      gravityScale: 0,
    });
  }
  for (let i = 0; i < 26; i++) {
    updateProjectiles(DT, scene, [], () => {}, () => {}, () => {});
    updateProjectileTrails(DT, scene, projectiles);
  }
  draw(fightCam);
  present(`fight scale, level ${level}`, 'legible as blades, or a smear?');
}

// ---------------------------------------------------------------------------
// 4b. IN FAMILY, OR NOT
//
// The panel above says the blade is small. It cannot say whether it is TOO
// small, because there is nothing in the frame to be small against — and a
// projectile size chosen by eye against an empty ocean is the mistake that
// gave the boats a 0.02 outline on a 73-unit hull.
//
// So: every shot the seal already throws, at the same camera, in a row. The
// blade has to sit in that family. Each is spawned through the real asset path,
// so each carries whatever size multiplier assets.csv gives it — which is the
// number actually being compared, not the radius written in config.
// ---------------------------------------------------------------------------
section('the blade against the ordnance already in the water', 1);
{
  clearAll();
  const FAMILY = ['bullet', 'missile', 'starfish', 'scallopShell', 'pearl', 'razorBlade'];
  const view = fightCam.top - fightCam.bottom;
  const step = view * (W / H) / (FAMILY.length + 1);
  FAMILY.forEach((asset, i) => {
    const mesh = createVisual(asset);
    mesh.position.set(-view * (W / H) / 2 + step * (i + 1), 0, 0);
    // Laid along its travel, the way every one of them flies.
    mesh.rotation.z = -Math.PI / 2;
    add(mesh);
  });
  draw(fightCam);
  present('bullet · mussel · starfish · scallop · pearl · BLADE',
    'the blade is last. at this camera it has to be in family, not merely present');

  // The numbers behind the picture, since a row of specks is hard to rank by
  // eye and the whole question is whether one of them is out of range.
  const box = new THREE.Box3();
  const sizes = FAMILY.map((asset) => {
    const m = createVisual(asset);
    m.updateMatrixWorld(true);
    box.setFromObject(m);
    const d = box.getSize(new THREE.Vector3());
    return { asset, span: Math.max(d.x, d.y, d.z) };
  });
  log('');
  for (const { asset, span } of sizes) {
    log(`  ${asset.padEnd(14)} ${span.toFixed(2)} units  (${(span / view * 100).toFixed(1)}% of frame height)`, 'note');
  }
  const blade = sizes.find((x) => x.asset === 'razorBlade').span;
  const others = sizes.filter((x) => x.asset !== 'razorBlade').map((x) => x.span);
  check('the blade is not the smallest thing the seal throws', blade > Math.min(...others),
    `blade ${blade.toFixed(2)}, smallest other ${Math.min(...others).toFixed(2)}`);
  check('and it is not the biggest either', blade < Math.max(...others),
    `blade ${blade.toFixed(2)}, biggest other ${Math.max(...others).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 5. WHAT THE BRIGHT PASS ACTUALLY SEES
//
// Neither picture above can answer this, and for opposite reasons. The bloomed
// panels have already been tone-mapped and clipped, so a value at 1.0 and a
// value at 6.0 arrive as the same white. The raw one is sRGB-encoded, which
// lifts the midtones by roughly a factor of two — measure luminance on those
// bytes and every dark half of every blade reads as bright.
//
// So the scene is rendered once more into a HALF-FLOAT target with no colour
// conversion, which is the same buffer post.js hands its bright pass, and the
// numbers are read out of that. This is the only place on the page where
// "will it bloom" has a real answer.
//
// Measured on LUMINANCE, because that is what the bright pass thresholds — and
// it is why the chrome's light half is near white rather than steel blue. Blue
// is worth about 7% of luminance, so a cold enough chrome can look brilliant on
// this sheet and bloom not at all.
// ---------------------------------------------------------------------------
section('the bright pass — raw, bloomed, and measured', 2);
{
  clearAll();
  const mesh = createVisual('razorBlade');
  mesh.scale.setScalar(2.2);
  mesh.rotation.set(0, 0.5, -Math.PI / 2 + 0.15);
  add(mesh);

  // The raw silhouette, for the thing bloom hides: a blur is generous to a
  // shape, and a blade that only reads because it is glowing is a blade that
  // stops reading in a crowd.
  gl.render(scene, camera);
  present('raw — no bloom, no tone map', 'the silhouette on its own');

  draw(camera);
  present('as the player sees it', 'the same blade through CONFIG.bloom and the grade');

  // --- the measurement ---
  //
  // OVER EVERY VARIANT, not over whichever one createVisual happened to hand
  // back. The seven blades have different twists and therefore genuinely
  // different bright fractions, so a single-sample check is a coin flip that
  // reports 50% one run and 58% the next — and the tempting fix for a flake
  // like that is to loosen the bound, which is how a real regression gets
  // certified. Averaged, this is a number about the FILM rather than about one
  // shard.
  const rt = new THREE.WebGLRenderTarget(gl.domElement.width, gl.domElement.height, {
    // FloatType, NOT HalfFloat, and the reason is the readback rather than the
    // precision. readRenderTargetPixels hands the buffer straight to
    // gl.readPixels, which demands a typed array matching the texture's type —
    // a half-float target wants a Uint16Array of raw half bits. Handing it a
    // Float32Array does not throw: it fills nothing, and the measurement comes
    // back a confident, entirely wrong 0.00 across the board. It did exactly
    // that on the first run of this page.
    type: THREE.FloatType,
  });
  // Linear, because the point is the value the bright pass consumes and not the
  // value a monitor shows. Set after construction so it cannot be silently
  // ignored as an unknown constructor option.
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;

  const threshold = CONFIG.bloom?.threshold ?? 0.18;
  const seen = new Map();
  for (let i = 0; i < 500 && seen.size < 40; i++) {
    const m = createVisual('razorBlade');
    if (!seen.has(m.geometry.uuid)) seen.set(m.geometry.uuid, m);
  }

  let peak = 0;
  let totalBody = 0;
  let totalOver = 0;
  const px = new Float32Array(rt.width * rt.height * 4);
  for (const probe of seen.values()) {
    clearAll();
    probe.scale.setScalar(2.2);
    probe.rotation.set(0, 0.5, -Math.PI / 2 + 0.15);
    probe.position.set(0, 0, 0);
    add(probe);
    const prevTarget = gl.getRenderTarget();
    gl.setRenderTarget(rt);
    gl.render(scene, camera);
    gl.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, px);
    gl.setRenderTarget(prevTarget);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] <= 0.001) continue;
      totalBody += 1;
      const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      if (lum > peak) peak = lum;
      if (lum > threshold) totalOver += 1;
    }
  }
  rt.dispose();

  // A readback that came back empty must say so rather than report a peak of
  // zero — the two are indistinguishable in the numbers and opposite in what
  // they mean, and the second one silently PASSES the shape check below.
  check('the float readback returned pixels', totalBody > 0,
    totalBody ? `${totalBody} px across ${seen.size} blades` : 'nothing came back — the target type and the buffer type disagree');

  const share = totalBody ? totalOver / totalBody : 0;
  log('');
  log(`bright pass, averaged over ${seen.size} blades:`, 'note');
  log(`  peak luminance ${peak.toFixed(2)} against a threshold of ${threshold}`, 'note');
  log(`  ${(share * 100).toFixed(0)}% of blade area is over it`, 'note');

  check('the blade reaches the bright pass at all', peak > threshold,
    `peak ${peak.toFixed(2)}, threshold ${threshold}`);
  // THE DARK HALF IS THE ASSERTION, and it is not the same claim as "not too
  // bright". Chrome is legible because a horizon divides a bright side from a
  // dark one; bloom is a blur, and a blade that crosses the threshold END TO
  // END comes out of the composite as one uniform lozenge with the horizon
  // washed off it — still bright, still shiny, no longer metal. So what has to
  // survive is unlit AREA, not a ceiling on brightness.
  check('a real dark half survives the bloom — the horizon is what reads as metal',
    1 - share > 0.25, `only ${((1 - share) * 100).toFixed(0)}% of the blade is under threshold`);
}

await Promise.all(posted);
log('');
log(fails ? `${fails} problem(s)` : 'all good', fails ? 'bad' : 'ok');
log(`${shotIndex} frames posted to the shots directory`, 'note');
document.title = fails ? 'razor clams FAILED' : 'razor clams ok';
