// ---------------------------------------------------------------------------
// THE SEAL'S WET FILM — LOOK DEV
//
//   npm run looks:wet
//
// The question this sheet exists to answer: does the seal read as WET, and does
// the light on it belong to the water it is in?
//
// The second half is the whole reason the layer was built the way it was. The
// caustic veins on the animal are sampled from the same function, at the same
// world position, on the same phase as the veins on the water plane behind it
// (systems/causticsGlsl.js) — so a vein that crosses the water has to cross the
// seal without breaking at the silhouette. That is a thing you can only check by
// looking, and it is the one failure mode that makes the whole effect read as
// fake: any drift between the two turns the dapple into a texture stuck on the
// animal. The `veins` cells below put the seal on the plane, in the frame, at
// the size a run is played at, for exactly that.
//
// WHY A PAGE AND NOT A NODE HARNESS. This is one injected GLSL program. A
// compile error there renders NOTHING and throws nothing Node can see — the
// seal would be missing from the game with a clean `npm test`. This page
// imports the SHIPPING modules and builds the material the real asset pipeline
// builds, so a cell that comes up empty is a real compile failure, and the
// console error three prints is captured and shown at the top.
//
// IT WRITES NOTHING. Every CONFIG assignment below is into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { applyNoiseSettings, setNoiseGlow, setNoiseWetEnv } from '../../path/src/systems/noiseShader.js';
import { createWaterMaterial, updateWaterMaterial, liveCaustics } from '../../path/src/systems/water.js';

const logEl = document.getElementById('log');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};
let fails = 0;

// THREE PRINTS A FAILED PROGRAM AND CARRIES ON. renderer.debug.checkShaderErrors
// is on by default and reports through console.error — which on a page nobody
// is watching the console of is the same as reporting nothing. Captured here so
// a broken shader is the first line of the sheet instead of an empty panel.
const shaderErrors = [];
const realError = console.error;
console.error = (...args) => {
  const text = args.map((a) => (a && a.stack) || String(a)).join(' ');
  if (/shader|glsl|program/i.test(text)) shaderErrors.push(text);
  realError.apply(console, args);
};

const W = 520;
const H = 340;

const gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

// THE GAME'S OWN LIGHTING RIG, read from config rather than invented — the wet
// highlight rides the key light's direction, so a page with its own prettier
// three-point setup would be tuning against a sun that does not exist. See
// world.js, which builds exactly this.
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient));
const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
key.position.fromArray(CONFIG.lighting.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity));

// ORTHOGRAPHIC, like the run. The caustic scale is in WORLD UNITS per cycle, so
// a perspective frame would show the veins at a size no player ever sees and
// every number tuned against it would be wrong in the game.
const VIEW_W = 9;
const VIEW_H = VIEW_W * (H / W);
const camera = new THREE.OrthographicCamera(-VIEW_W / 2, VIEW_W / 2, VIEW_H / 2, -VIEW_H / 2, -100, 200);
camera.position.z = 20;

// THE WATER, at the depth a run is actually played at rather than at the
// surface: `falloff` fades the veins with depth, so a seal held at the top of
// the column would show a dapple nobody sees in the game.
const SURFACE_Y = 6;
const BOTTOM_Y = -22;
const waterMat = createWaterMaterial();
const water = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), waterMat);
water.position.set(0, 0, -6);
waterMat.uniforms.uCenter.value.set(water.position.x, water.position.y);
waterMat.uniforms.uSurfaceY.value = SURFACE_Y;
waterMat.uniforms.uBottomY.value = BOTTOM_Y;
scene.add(water);

await preloadAssets();

// THE REAL SEAL, off the real pipeline. createVisual hands back a visual whose
// materials ALREADY carry the noise shader — assets.js attaches it there, per
// `noiseShader: true` on the `ship` def. Not cloned and not re-attached: this
// page is about the shared CONFIG.sealShader settings, so the shared materials
// are the right subject, and Material.clone() would drop onBeforeCompile and
// leave a body with every flag saying "attached" and no shader on it.
const seal = createVisual('ship');
if (!seal) { log('FAIL createVisual returned nothing for `ship`', 'bad'); fails++; }
else {
  // createVisual points a creature forward at world +Y — nose up — and a nose-up
  // seal is a vertical sliver that says nothing about its surface. Same rotation
  // as every preview in this folder.
  seal.rotation.z = -Math.PI / 2;
  seal.position.set(0, -1.4, 0);
  scene.add(seal);
}

const sheet = document.getElementById('sheet');
let shotIndex = 0;
const posted = [];

/** Render the scene as it stands and drop the frame into the sheet and on disk. */
function shot(title, note) {
  gl.render(scene, camera);
  const canvas = document.createElement('canvas');
  canvas.width = gl.domElement.width;
  canvas.height = gl.domElement.height;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b><br>${note ?? ''}`;
  cell.appendChild(cap);
  (current ?? sheet).appendChild(cell);
  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// The cell grid `shot` is currently filling. A module-level cursor rather than a
// returned handle passed around: every cell in a block belongs to the heading
// above it, and threading that through each call is four more characters per
// line for a thing that is never ambiguous.
let current = null;
function row(label) {
  const h = document.createElement('h2');
  h.textContent = label;
  sheet.appendChild(h);
  current = document.createElement('div');
  current.className = 'row';
  sheet.appendChild(current);
}

// The clock every frame of the sheet is taken at. FIXED, not a wall clock: two
// cells meant to differ by one setting have to differ by ONLY that setting, and
// a caustic field that had moved between them would put a different pattern
// under each comparison.
const CLOCK = 12.5;

/** Push a set of overrides onto CONFIG.sealShader and re-resolve every uniform. */
function wet(over) {
  Object.assign(CONFIG.sealShader, over);
  applyNoiseSettings();
  // The ocean's side, in the same order world.js does it: the water resolves
  // its state for this frame first, and the film reads what the water resolved.
  updateWaterMaterial(waterMat, CLOCK);
  setNoiseWetEnv(liveCaustics);
}

// The shipped numbers, captured before anything below moves them, so each block
// starts from the config the game boots with rather than from the last cell.
const BASE = { ...CONFIG.sealShader };
const reset = (over) => wet({ ...BASE, ...over });

// ---------------------------------------------------------------------------
// THE SHEET
// ---------------------------------------------------------------------------
row('dry vs wet — is it the same animal?');

reset({ wet: 0 });
shot('dry', 'wet 0 — the seal with the layer off. Every cell below has to still be this animal.');
reset({});
shot('shipped — wet 0.55', 'the defaults: a soft two-step sheet, a wet silhouette, and the water’s veins.');

reset({ wet: 1.2 });
shot('wet 1.2', 'past surfacing — where the film starts eating the markings under it.');
reset({ wetSteps: 1 });
shot('one step', 'wetSteps 1 — a single sheet with a shoulder. Nothing to count.');

reset({ wetSteps: 4 });
shot('four steps', 'the toon read at its most literal — four terraces down the shoulder.');
reset({ wetSoft: 0 });
shot('hard cel edge', 'wetSoft 0. The steps are razors again and they trace the mesh — the reason the default is 0.5.');

row('the shape of the sheet — this model is low-poly, and a cel highlight shows it');
// SOFTNESS IS IN TERRACE UNITS, not in units of the lobe — 0.08 is eight per
// cent of ONE STEP, which is still a razor. The sweep runs to 1, where the
// shoulder fills a whole terrace and the steps are as soft as they can get
// while still being steps.
for (const soft of [0.02, 0.2, 0.5, 1]) {
  reset({ wetSoft: soft });
  shot(`soft ${soft}`, soft <= 0.02
    ? 'a razor cut through a value interpolated across a low-poly body: the isoline IS the tessellation.'
    : 'the same sheet, with the shoulder opened up.');
}

row('what it picks up');
reset({ wetCaustics: 0 });
shot('no veins', 'wetCaustics 0 — highlight and rim alone. Compare the water behind it.');
reset({ wetGloss: 0, wetRim: 0, wetCaustics: 2 });
shot('veins only', 'gloss and rim off — the dapple, at the shipped 4x.');
reset({ wetGloss: 0, wetRim: 0, wetCaustics: 2, wetCausticScale: 1 });
shot('veins at 1x — the honest one', 'exactly the ocean’s veins. The seal fits inside a quarter of one, so it just dims. This is why the default is not 1.');

reset({ wetGloss: 0, wetRim: 0, wetCaustics: 2, wetCausticUp: 0 });
shot('veins, no up-weight', 'wetCausticUp 0 — the veins wrap the belly and it reads as print, not light.');
reset({ wetGloss: 0, wetRim: 0, wetCaustics: 2, wetCausticScale: 8 });
shot('veins at 8x', 'past the point where they are caustics — a speckle competing with the markings.');

reset({ wetGloss: 0, wetCaustics: 0, wetRim: 1.6 });
shot('rim only', 'the wet silhouette alone — and the reason the shipped rim outweighs the gloss. dot(N,V) over a convex body has no isoline to break, so it stays smooth where the highlight goes polygonal.');
reset({ wetPatch: 1 });
shot('patch 1', 'the film only where the markings are bright — fur that has drained unevenly, and the one thing that softens the flat flipper plates.');

row('a glowing seal burns its own sheen');
if (seal) {
  const GLOW = { color: 0x00e5ff, tipColor: 0xffffff, strength: 1.6, coverage: 0.62, contrast: 0.22, white: 0.4, scale: 1.6 };
  setNoiseGlow(seal, GLOW);
  reset({ wet: 0, wetGlow: 1 });
  shot('glowing, dry', 'Glow Up! on a dry animal — the layer this one has to sit with.');
  reset({ wetGlow: 0 });
  shot('glowing, wet, no reaction', 'wetGlow 0 — the film ignores the glow. The sheen and the light are two pictures.');
  reset({});
  shot('glowing, wet, shipped', 'wetGlow 1 — the film burns where the animal does. Lighting the seal up also makes it look wetter.');
  reset({ wetGlow: 3 });
  shot('glowing, wet, wetGlow 3', 'too far: the sheen has swallowed the animal and the markings the glow was riding are gone.');
  setNoiseGlow(seal, null);
  reset({});
  shot('back to ordinary', 'the glow cleared — this must be the shipped cell again, exactly.');
}

// ---------------------------------------------------------------------------
// WHAT THE SHEET CANNOT SHOW: whether the program compiled at all.
// ---------------------------------------------------------------------------
if (shaderErrors.length) {
  fails++;
  log('FAIL the injected shader did not compile — every cell above is a lie', 'bad');
  for (const e of shaderErrors) log('  ' + e, 'bad');
} else {
  log('ok   the noiseShader program compiled, wet film and all', 'ok');
}
log(`ok   ${shotIndex} frames, at a fixed clock of ${CLOCK}s`, 'ok');
log('note the `veins only` cell is the one to look at: a vein must cross the seal’s', 'note');
log('     edge without breaking. If it does, the film is lit by the water it is in.', 'note');

reset({});
await Promise.all(posted);
document.title = fails ? 'seal wet FAILED' : 'seal wet ok';
log(fails ? `${fails} PROBLEM(S)` : 'ALL GOOD', fails ? 'bad' : 'ok');
