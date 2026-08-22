// ---------------------------------------------------------------------------
// PAINTED SKINS — what the build would lose the texture for
//
//   npm run looks:skins
//
// The question this exists to settle: 12.3MB of the 40.2MB of .glb in
// public/models is embedded jpegs, and a species whose surface can be GENERATED
// does not need its share of that. Whether a given animal's can is not a number
// — every check in tools/biolum-skin-test.mjs passes on a shader that paints a
// shark like a countertop. So this puts the shipped model and each pigment
// preset side by side at the same size, in the same light, and lets the
// comparison be the thing you look at.
//
// Read it as: if a row's painted cells hold up next to its first cell, that
// species can take a `skin` in assets.csv and its texture can come out of the
// model. If they don't, either the preset needs work in the Procedural skins
// folder (T panel) or that animal keeps its jpeg. Both are fine answers; the
// point is being able to tell which.
//
// HOW THE PAINT GETS ON, and the one way this page is not the game. The game
// attaches a skin inside processMaterial, when the model is parsed, off
// `def.biolumSkin` — which assets.csv now writes (see setAssetSkin). That
// happens once, before anything can be rendered, so a page that used the real
// path could only ever show ONE treatment per load and there would be nothing
// to compare against. Here each cell clones the instance's materials and
// attaches to the clone, which is the same call with the same arguments at a
// different moment.
//
// The clone is not incidental: three's Material.clone() drops onBeforeCompile,
// so cloning AFTER an attach would silently throw the shader away. Clone first,
// attach second, always.
//
// That difference is exactly the seam a look page can hide, so the real path is
// checked in Node instead — see THE SKIN COLUMN in tools/biolum-skin-test.mjs,
// which walks setAssetSkin → def.biolumSkin, and tools/path-table-test.mjs,
// which walks assets.csv → setSkin.
//
// IT WRITES NOTHING — a vite build with no dev server behind it and no save
// path. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, ASSETS } from '../../path/src/assets.js';
import { attachBiolumSkin, applyBiolumSkinSettings, updateBiolumSkin } from '../../path/src/systems/biolumSkin.js';

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

const W = 420;
const H = 340;

// One WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels, and this sheet is
// four times that.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

// DAYLIGHT, NOT THE ABYSS. The lighting is the whole argument for pigment —
// paint is shaded and additive glow is not — so a dark scene would flatter the
// painted cells by hiding the only thing that separates them from a decal.
// Roughly CONFIG.lighting's key/fill relationship at the brighter end.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1420);
scene.add(new THREE.AmbientLight(0xbcd8ff, 1.1));
const key = new THREE.DirectionalLight(0xfff4e0, 2.4);
key.position.set(4, 7, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fb4ff, 0.8);
rim.position.set(-5, 2, -4);
scene.add(rim);

await preloadAssets();

// The presets whose job is to replace a texture. Read off CONFIG rather than
// listed, so a fourth one added to the pigment family turns up here without an
// edit — and so a preset that forgets `pigment` is visibly absent rather than
// quietly rendered as a glow.
const PIGMENT = Object.entries(CONFIG.biolumSkin?.presets ?? {})
  .filter(([, p]) => (p?.pigment ?? 0) > 0)
  .map(([name]) => name);
check('the pigment family is reachable from CONFIG', PIGMENT.length > 0, PIGMENT.join(', ') || 'none found');

// WHO IS WORTH ASKING ABOUT: the model assets carrying the most embedded
// texture, plus a couple of small fish to check the presets at the other end of
// the size range. None of them has a skin. Most ship a jpeg inside their .glb;
// the dolphin ships no image at all, which is the strongest case on the page —
// there is nothing for a skin to displace, only a flat colour to replace.
const SUBJECTS = [
  ['enemyGreatWhite', 'Great white', 'greatwhite.glb — 0.26MB in 3 images'],
  ['enemyMegalodon', 'Megalodon', 'megalodon.glb — 1.72MB in 7 images'],
  ['enemyDolphin', 'Dolphin', 'dolphin.glb — 0.13MB, no images at all'],
  ['enemyMosasaur', 'Mosasaur', 'mosasaurus.glb — 0.56MB in 3 images'],
  ['enemySeaTurtle', 'Sea turtle', 'seaturtle.glb'],
  ['enemyTuna', 'Tuna', 'fish.glb — 0.23MB in 2 images'],
  ['enemyBarracuda', 'Barracuda', 'barracuda.glb — 0.11MB in 1 image'],
  ['boat', 'Fishing boat', 'fishingboat.glb — 1.04MB in 4 images'],
];

const camera = new THREE.PerspectiveCamera(34, W / H, 0.05, 400);

// --- one cell ---------------------------------------------------------------
let shotIndex = 0;
const posted = [];

function cell(title, caption, shipped) {
  const wrap = document.createElement('div');
  wrap.className = `cell${shipped ? ' shipped' : ''}`;
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

// FRAMED OFF THE MEASURED BODY, not off a number. `fit` and the assets.csv
// multiplier both scale the instance, so no config value says how much frame an
// animal fills — and every cell has to be the same size as its neighbours or
// the comparison is between two framings rather than two surfaces.
function frame(visual) {
  visual.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(visual);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  const span = Math.max(size.x, size.y, size.z, 1e-4);
  const back = span * 1.9;
  camera.position.set(centre.x + back * 0.15, centre.y + back * 0.30, centre.z + back * 0.92);
  camera.lookAt(centre);
  return size;
}

// Lay the body flat. createVisual points a creature forward at world +Y — nose
// up — and a nose-up animal in a square panel is a thin vertical sliver that
// tells you nothing about its surface. See the same rotation in every other
// preview in this folder.
function makeSubject(assetKey) {
  const visual = createVisual(assetKey);
  if (!visual) return null;
  visual.rotation.z = -Math.PI / 2;
  return visual;
}

/**
 * Paint `visual` with `preset`, on materials of its own.
 *
 * The clone is what keeps one cell out of the next: createVisual hands back
 * instances that share the asset's materials, so attaching in place would put
 * the last preset on every cell in the row including the shipped one.
 */
function paint(visual, preset, axis) {
  let attached = 0;
  visual.traverse((o) => {
    if (!o.isMesh || o.userData.__isOutline) return;
    const clone = (m) => {
      const c = m.clone();
      attachBiolumSkin(c, o, preset, axis ?? null, null);
      attached++;
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(clone) : clone(o.material);
  });
  return attached;
}

// --- the sheet --------------------------------------------------------------
log(`presets: ${PIGMENT.join('  ')}`, 'dim');
log('');

for (const [assetKey, label, cost] of SUBJECTS) {
  const def = ASSETS[assetKey];
  if (!def) { check(`${label}: asset exists`, false, `no ASSETS.${assetKey}`); continue; }

  const r = row(label, cost);

  // 1. AS SHIPPED. First cell in every row, so the eye has the thing being
  //    replaced immediately to the left of each replacement.
  const shipped = makeSubject(assetKey);
  if (!shipped) { check(`${label}: builds a visual`, false); continue; }
  scene.add(shipped);
  const size = frame(shipped);
  gl.render(scene, camera);
  r.appendChild(cell(`${label}-shipped`, `<b>as shipped</b> — its own texture`, true));
  scene.remove(shipped);

  // 2..n. ONE CELL PER PIGMENT PRESET, each on a fresh instance so nothing
  //       carries over. The camera is NOT re-framed: it was set off the shipped
  //       body and every painted cell reuses it, which is what makes the four
  //       images comparable rather than merely similar.
  for (const preset of PIGMENT) {
    const painted = makeSubject(assetKey);
    scene.add(painted);
    const n = paint(painted, preset, def.biolumAxis);
    // Uniforms come from CONFIG the same way the game pushes them, so what is
    // on screen is what the sliders in the Procedural skins folder hold.
    applyBiolumSkinSettings();
    updateBiolumSkin(0);
    painted.updateMatrixWorld(true);
    gl.render(scene, camera);
    const p = CONFIG.biolumSkin.presets[preset];
    r.appendChild(cell(
      `${label}-${preset}`,
      `<b>${preset}</b> — ${p.pattern}, pigment ${p.pigment}`
      + ` <span class="tag">${n} material${n === 1 ? '' : 's'}</span>`,
      false,
    ));
    scene.remove(painted);
    check(`${label}: ${preset} reached a material`, n > 0, `${n} attached`);
  }

  log(`${label}: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} world units`, 'dim');
}

log('');
log(fails ? `${fails} FAILED` : 'every subject painted — judge the rows above', fails ? 'bad' : 'ok');
await Promise.all(posted);
log(`${shotIndex} frames posted`);
