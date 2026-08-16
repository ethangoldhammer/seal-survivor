#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:surface
//
// Drives the T panel's Models tab under jsdom, for the two looks that had no
// control anywhere until now: how a body answers the key light (`material` on
// the ASSETS entry) and the inverted-hull rim (`outline`).
//
// The failure this is built around is specific and quiet. `setAssetRoughness`
// has existed and been exported for months with NO caller — a setter waiting
// for a slider — and a panel that renders a slider next to a setter it never
// calls looks identical to one that works. So nothing here checks that a row
// EXISTS; every check reads back the value on the real material, or on the real
// shared outline material, after moving the real control.
//
// The rim half also guards a second thing. addOutlineShells builds a FRESH
// material per mesh when handed none, which is what the static `outline` blocks
// used to get — so a colour written from the panel would have reached one shell
// of one creature and nothing already swimming. prepareModel now hands it one
// shared material per asset, and the check for that is that a write lands on
// every shell, not merely on the first.
//
// jsdom must load before the loader hooks, or jsdom's own CJS require chain
// breaks with an unrelated error about './fallback/encoding.js'.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

await import('./vite-loader.mjs');

const THREE = await import('three');
const { CONFIG } = await import('../path/src/config.js');
const {
  ASSETS, prepareModel, getAssetMaterials, installModel,
  setAssetRoughness, setAssetMetalness, supportsSurface,
  setAssetOutline, hasOutline, assetOutlineBase,
} = await import('../path/src/assets.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (t) => console.log(`\n${t}`);

// A stand-in body rather than a loaded .glb: prepareModel is the function under
// test and it takes a parsed scene, so a real file would only add a fetch and a
// format to the things that can go wrong. What it must NOT be is hand-built
// materials — the point is the path through prepareModel, which is exactly the
// seam a harness that builds its own subject would step over.
function scene(meshCount = 2) {
  const root = new THREE.Group();
  for (let i = 0; i < meshCount; i++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.11 }),
    );
    m.name = `part${i}`;
    root.add(m);
  }
  return root;
}

// ---------------------------------------------------------------------------
section('SURFACE — roughness and metalness reach the real material');
{
  const KEY = '__surfaceProbe';
  ASSETS[KEY] = { model: 'x.glb', fit: 2, forward: '+Z' };
  // installModel runs prepareModel itself — preparing first and installing the
  // result would put the body through it twice.
  installModel(KEY, scene(2));

  const mats = getAssetMaterials(KEY);
  check('the asset has materials to write', mats.length === 2, `${mats.length}`);
  check('...and they are lit, so the two rows are offered', supportsSurface(KEY) === true);

  setAssetRoughness(KEY, 0.9);
  setAssetMetalness(KEY, 0.75);
  check('roughness lands on every mesh, not just the first',
    mats.every((m) => m.roughness === 0.9), mats.map((m) => m.roughness).join(', '));
  check('metalness lands on every mesh', mats.every((m) => m.metalness === 0.75),
    mats.map((m) => m.metalness).join(', '));

  // NULL IS A REAL UNDO, and this is the half that is easy to get wrong: there
  // is no neutral roughness to reset TO, so the setter has to have kept what it
  // found. A reset that wrote 0.5 or 1 would look like it worked and would have
  // silently retuned every creature it touched.
  setAssetRoughness(KEY, null);
  setAssetMetalness(KEY, null);
  check('null restores the value the model shipped with, not a default',
    mats.every((m) => m.roughness === 0.42 && m.metalness === 0.11),
    `${mats[0].roughness} / ${mats[0].metalness}`);

  delete ASSETS[KEY];
}

// ---------------------------------------------------------------------------
section('RIM — one material per asset, so an edit reaches what is already swimming');
{
  const KEY = '__rimProbe';
  const DECLARED = { color: 0x9fc6e8, thickness: 0.02, glow: 1 };
  ASSETS[KEY] = { model: 'x.glb', fit: 2, forward: '+Z', outline: { ...DECLARED } };
  // prepareModel ONCE and inspect what it returns. Calling it a second time (as
  // installModel would) registers a second outline material for the same key,
  // and the shells held here would then belong to the one setAssetOutline is no
  // longer writing — a test that fails for a reason that is not the code's.
  const built = prepareModel(scene(3), ASSETS[KEY], [], null, KEY);

  check('the asset is registered as having a rim', hasOutline(KEY) === true);
  check('...and what it declared is recoverable, which is what a reset needs',
    assetOutlineBase(KEY)?.thickness === 0.02, `${assetOutlineBase(KEY)?.thickness}`);

  const shells = [];
  built.traverse((o) => { if (o.userData.__isOutline) shells.push(o); });
  check('a shell was built for each mesh', shells.length === 3, `${shells.length}`);

  // THE WHOLE POINT. Three shells, ONE material — if these are three separate
  // materials the panel can only ever recolour whichever it happens to hold.
  const unique = new Set(shells.map((s) => s.material));
  check('all three shells share ONE material', unique.size === 1, `${unique.size} distinct`);

  setAssetOutline(KEY, { color: 0xff0000, thickness: 0.05, glow: 2 });
  const mat = shells[0].material;
  check('a colour write reaches every shell at once',
    shells.every((s) => s.material === mat && s.material.color.r > 1.5),
    `r = ${mat.color.r.toFixed(2)}`);
  // Glow is the colour past 1.0 — there is no separate intensity — so this is
  // the check that the two are ONE write rather than two that undo each other.
  check('...with glow folded into it rather than applied separately',
    Math.abs(mat.color.r - 2) < 1e-3 && mat.color.g < 1e-3,
    `#ff0000 x2 -> (${mat.color.r.toFixed(2)}, ${mat.color.g.toFixed(2)}, ${mat.color.b.toFixed(2)})`);
  check('thickness reaches the uniform the vertex shader reads',
    mat.userData.__outlineThickness?.value === 0.05,
    `${mat.userData.__outlineThickness?.value}`);

  // An empty write is the reset, and it has to land on the ENTRY's numbers —
  // not on a shared default, because a thickness is in the source file's units
  // and 0.02 on a boat is a different quantity from 0.02 on a seagull.
  setAssetOutline(KEY, {});
  check('an empty write restores exactly what the entry declared',
    Math.abs(mat.color.r - new THREE.Color(0x9fc6e8).r) < 1e-3
    && mat.userData.__outlineThickness.value === 0.02,
    `thickness ${mat.userData.__outlineThickness.value}`);

  check('an asset with no outline is left alone rather than given one',
    setAssetOutline('__nothingHere', { color: 0xff0000 }) === false);

  delete ASSETS[KEY];
}

// ---------------------------------------------------------------------------
section('THE PANEL — the controls are wired to those setters');
{
  // MODELS FIRST, PANEL SECOND — which is also the game's order (preloadAssets
  // at main.js:275, initTexturePanel at 405) and not a detail: both questions
  // the block asks are asked of the LOADED material, so a row built before its
  // model exists shows no Surface section at all. Building the panel here
  // without this passed every check above and rendered nothing.
  const { initTexturePanel } = await import('../path/src/ui/textures.js');
  installModel('boat', scene(2));
  installModel('enemyShark', scene(1));
  CONFIG.assetLooks = CONFIG.assetLooks ?? {};
  initTexturePanel(() => {}, () => {});

  // Every folded block on the tab, and then the one belonging to an asset that
  // really has both — the boats are the outlined ones.
  const blocks = document.querySelectorAll('.sv-tex-surface');
  check('the Models tab grew Surface blocks', blocks.length > 0, `${blocks.length} rows carry one`);
  check('...and they are folded by default, so 48 rows did not each gain five',
    [...blocks].every((b) => !b.open));

  // THE BOAT IS UNLIT — `modelUnlit: true`, so MeshBasicMaterial, so no
  // roughness at all — and it has a rim. Its block must therefore be titled
  // "Rim" and hold no surface sliders. That pairing is the reason the block is
  // built from what the material actually has rather than from a fixed row
  // list: two sliders that move nothing look exactly like two that work.
  const boatBlock = [...blocks].find((b) => b.closest('.sv-tex-row')?.textContent.startsWith('Boat'));
  check('the boat, being unlit, gets a rim section and no surface sliders',
    boatBlock?.querySelector('summary').textContent === 'Rim',
    `titled "${boatBlock?.querySelector('summary').textContent}"`);
  check('...and its first slider is the rim width, not a roughness that cannot apply',
    boatBlock?.querySelectorAll('input[type=color]').length === 1
    && boatBlock?.querySelectorAll('input[type=range]').length === 2,
    `${boatBlock?.querySelectorAll('input[type=range]').length} sliders`);

  // DRIVE A REAL SLIDER AND READ THE MATERIAL. This is the check that would
  // have caught a panel wired to nothing: everything above it passes on a row
  // whose input listener is missing. On a LIT asset, because roughness is the
  // control being proved and the boat has nowhere to put one.
  const litKey = ['enemyShark', 'ship'].find((k) => supportsSurface(k));
  check('a lit asset is loaded to drive', !!litKey, litKey ?? 'none');
  if (litKey) {
    const mats = getAssetMaterials(litKey);
    const block = [...blocks].find((b) => b.closest('.sv-tex-row')?.dataset.key === litKey);
    const rough = block?.querySelector('input[type=range]');
    check(`the ${litKey} row has a roughness slider`, !!rough);
    if (rough) {
      rough.value = '0.83';
      rough.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      check('moving it writes the real material',
        mats.every((m) => Math.abs(m.roughness - 0.83) < 1e-6),
        mats.map((m) => m.roughness).join(', '));
      check('...and it is stored where a reload will find it',
        CONFIG.assetLooks[litKey]?.roughness === 0.83, `${CONFIG.assetLooks[litKey]?.roughness}`);
    }
  }
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
