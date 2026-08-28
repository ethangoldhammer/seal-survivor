#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:palette
//
// WHAT COLOUR AN ANIMAL ACTUALLY IS — systems/bodyPalette.js, and the lift that
// turns it into smoke in systems/bossBoom.js.
//
// A single hex per asset was wrong in four different ways at once and every one
// of them renders a perfectly good explosion in a plausible colour, which is
// why this is a harness and not a look decision:
//
//   WHITE IS A MULTIPLIER  Every material on the megalodon is `color: #ffffff`
//                          with a 1024x1024 map — the white means "use the
//                          texture". Counted as a colour it makes every
//                          textured animal in the game pale grey; skipped when
//                          there is NO map, a genuinely white body loses its
//                          only colour. The two are the same value and are told
//                          apart solely by whether the map exists.
//
//   BLACK IS AN OFF SWITCH An unset `uBioColorC` is #000000 and means "this
//                          slot is unused", not "this animal is black" — and on
//                          a roster of near-black hides the difference is
//                          invisible in the output.
//
//   THE ORCA HAS NO COLOUR Its one material is plain white with no map. The
//                          entire animal is painted by biolumSkin uniforms, so
//                          a reader that only looks at materials answers
//                          "white" and is not obviously wrong.
//
//   AN EYE OUTWEIGHS A FLANK  Weighted per MATERIAL rather than per triangle, a
//                          boss whose eyes are their own material has its eye
//                          colour count for as much as thirty thousand
//                          triangles of hide.
//
//   THE LIFT FLATTENS IT   Every boss is a near-black hide and the composite
//                          drops it further, so each swatch has to be lifted
//                          clear of the water. Lifted to a CONSTANT lightness,
//                          a six-swatch palette becomes one swatch six times —
//                          which renders beautifully and is the whole feature
//                          silently not working.
//
// THE TEXTURE AVERAGE IS NOT REACHABLE FROM HERE and that is stated rather than
// worked around: it needs a 2D canvas and a Node harness has none, so
// `averageTextureColor` returns null and every texture-sourced swatch is
// absent. What that branch DOES gate — a white material under a map being
// skipped — is reachable and is checked. The averages themselves are looked at
// on the sheet: npm run looks:boom has a panel per boss.
//
// Everything expected is derived from CONFIG.
//
//   node --import ./tools/vite-loader.mjs tools/body-palette-test.mjs
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bodyPalette } from '../path/src/systems/bodyPalette.js';
import { bossBoomPalette } from '../path/src/systems/bossBoom.js';

let failures = 0;
const section = (t) => console.log(`\n${t}`);
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const P = CONFIG.bodyPalette;
const BOOM = CONFIG.boss.boom;

// A body built out of real THREE meshes, so the traversal, the material dedupe
// and the triangle weighting are the shipping ones rather than a description of
// them. `tris` is set by the geometry: a plane is two triangles, so the counts
// below are exact and the weights can be asserted rather than eyeballed.
function part(tris, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(tris * 9), 3));
  return new THREE.Mesh(g, mat);
}

function body(parts, extra = {}) {
  const root = new THREE.Group();
  for (const p of parts) root.add(p);
  root.updateMatrixWorld(true);
  return { visual: root, mesh: root, assetKey: '__none__', ...extra };
}

// A stand-in texture: it has dimensions, so the "is there a map" question
// answers yes, and averaging it returns null in Node because there is no
// canvas. That is exactly the state a real textured boss is in here.
function fakeMap() {
  const t = new THREE.Texture();
  t.image = { width: 64, height: 64 };
  return t;
}

const hexOf = (list, source) => list.find((s) => s.sources?.includes(source))?.hex ?? null;
const near = (a, b, tol = 0.03) => {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return Math.abs(ca.r - cb.r) < tol && Math.abs(ca.g - cb.g) < tol && Math.abs(ca.b - cb.b) < tol;
};

console.log('\nwhat colour an animal is\n');

// --- WHITE ------------------------------------------------------------------
section('white is a multiplier, or a white animal');
{
  // The megalodon's shape: white materials, all of them mapped.
  const e = body([part(100, new THREE.MeshStandardMaterial({ color: 0xffffff, map: fakeMap() }))]);
  const pal = bodyPalette(e);
  const fromColor = pal?.swatches?.some((s) => s.sources.includes('color')) ?? false;
  check('a white material under a map contributes nothing', !fromColor,
    'counted, and every textured animal in the game comes out pale grey');
}
{
  const e = body([part(100, new THREE.MeshStandardMaterial({ color: 0xffffff }))]);
  const pal = bodyPalette(e);
  check('...but a white material with no map is a white animal',
    near(hexOf(pal.swatches, 'color'), 0xffffff),
    `#${(hexOf(pal.swatches, 'color') ?? 0).toString(16)}`);
}

// --- WEIGHTING --------------------------------------------------------------
section('weighted by how much of the body wears it');
{
  // A big red flank and a tiny green eye, as two materials. The share is what
  // decides how much of the cloud each colour gets, so getting this the wrong
  // way round is a boss that goes up in the colour of its own eyes.
  const e = body([
    part(3000, new THREE.MeshStandardMaterial({ color: 0xff0000 })),
    part(10, new THREE.MeshStandardMaterial({ color: 0x00ff00 })),
  ]);
  const pal = bodyPalette(e);
  const red = pal.swatches.find((s) => near(s.hex, 0xff0000));
  const green = pal.swatches.find((s) => near(s.hex, 0x00ff00));
  check('both colours are found', !!red && !!green,
    pal.swatches.map((s) => `#${s.hex.toString(16)}@${s.share.toFixed(2)}`).join(' '));
  check('...and the flank outweighs the eye', red && green && red.share > green.share * 50,
    `${red?.share.toFixed(3)} vs ${green?.share.toFixed(3)} — weighted per MATERIAL rather than `
    + 'per triangle, these are equal and the boss goes up green');
}
{
  // THE OUTLINE SHELL IS NOT THE ANIMAL. It is a back-faced copy of the whole
  // body in one flat rim colour, so counting it gives every creature in the
  // game a large swatch of the same near-black.
  const shell = new THREE.MeshBasicMaterial({ color: 0x112233 });
  shell.userData.__isOutline = true;
  const e = body([
    part(500, new THREE.MeshStandardMaterial({ color: 0xcc4400 })),
    part(500, shell),
  ]);
  const pal = bodyPalette(e);
  check('the outline shell is not counted',
    !pal.swatches.some((s) => near(s.hex, 0x112233)),
    pal.swatches.map((s) => `#${s.hex.toString(16)}`).join(' '));
}

// --- THE BIOLUMINESCENT SKIN ------------------------------------------------
section('the skin, which for the orca IS the animal');
{
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  mat.userData.__bioSkinUniforms = {
    uBioPigment: { value: 1 },
    uBioColorA: { value: new THREE.Color(0x000000) },
    uBioColorB: { value: new THREE.Color(0x919191) },
    uBioColorC: { value: new THREE.Color(0x000000) },
    uBioShellColor: { value: new THREE.Color(0x1f1f1f) },
    uEyeColor: { value: new THREE.Color(0xffd166) },
    uEyeStrength: { value: 0 },
  };
  const e = body([part(1000, mat)]);
  const pal = bodyPalette(e);
  check('a shader-painted body still has colours',
    pal.swatches.some((s) => near(s.hex, 0x919191)),
    pal.swatches.map((s) => `#${s.hex.toString(16)}`).join(' ')
    + ' — read the materials only and the orca answers "white"');
  check('...its shell colour too', pal.swatches.some((s) => near(s.hex, 0x1f1f1f, 0.06)));
  // An unset slot is #000000 and means OFF. Counting it gives a black swatch
  // the weight of the whole body, and on a roster of near-black hides that is
  // invisible in the output.
  const blackFromSkin = pal.swatches.some((s) => s.sources.includes('skin') && s.hex === 0);
  check('an unset colour slot is not a black swatch', !blackFromSkin);
  // ...and the eyes are silent while they are not lit.
  check('unlit eyes contribute nothing',
    !pal.swatches.some((s) => s.sources.includes('eye')),
    'uEyeStrength 0 — the uniform still holds whatever colour the preset would use');
}
{
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  mat.userData.__bioSkinUniforms = {
    uBioPigment: { value: 1 },
    uBioColorA: { value: new THREE.Color(0x304050) },
    uEyeColor: { value: new THREE.Color(0xffd166) },
    uEyeStrength: { value: 1 },
  };
  const e = body([part(1000, mat)]);
  const pal = bodyPalette(e);
  const eye = pal.swatches.find((s) => s.sources.includes('eye'));
  const skin = pal.swatches.find((s) => s.sources.includes('skin'));
  check('a LIT eye does', !!eye, 'the one bright spot on the animal');
  check('...but nowhere near as much as the body', eye && skin && skin.share > eye.share * 3,
    `${skin?.share.toFixed(3)} body vs ${eye?.share.toFixed(3)} eye`);
}

// --- THE ELEMENTS -----------------------------------------------------------
section('what was on it when it died');
{
  const els = CONFIG.biolum?.elements ?? {};
  const e = body([part(1000, new THREE.MeshStandardMaterial({ color: 0x30302f }))],
    { venomTimer: 9 });
  const pal = bodyPalette(e);
  const venom = pal.swatches.find((s) => s.sources.includes('venom'));
  check('a poisoned boss is a green boss', !!venom && venom.hex === els.venom.color,
    `#${(venom?.hex ?? 0).toString(16)} vs #${els.venom.color.toString(16)}`);
  check('...and it is flagged raw', venom?.raw === true,
    'without it the hide correction desaturates the one swatch on the list that had '
    + 'something to say');
  // A dose about to lapse tints less than a fresh one.
  const faint = bodyPalette(body([part(1000, new THREE.MeshStandardMaterial({ color: 0x30302f }))],
    { venomTimer: 0.2 }));
  const faintVenom = faint.swatches.find((s) => s.sources.includes('venom'));
  check('a lapsing dose tints less', faintVenom && faintVenom.share < venom.share,
    `${faintVenom?.share.toFixed(3)} at 0.2s vs ${venom.share.toFixed(3)} at 9s`);
}
{
  const e = body([part(1000, new THREE.MeshStandardMaterial({ color: 0x30302f }))]);
  const pal = bodyPalette(e);
  check('a clean boss has no element swatch',
    !pal.swatches.some((s) => ['venom', 'chill', 'infection'].includes(s.sources[0])));
}

// --- MERGING ----------------------------------------------------------------
section('merging');
{
  // Six materials, three colours. Left unmerged the palette is six swatches and
  // the two distinctive ones are crowded out of the top of the list.
  const e = body([
    part(400, new THREE.MeshStandardMaterial({ color: 0x223344 })),
    part(400, new THREE.MeshStandardMaterial({ color: 0x223345 })),
    part(400, new THREE.MeshStandardMaterial({ color: 0x223346 })),
    part(400, new THREE.MeshStandardMaterial({ color: 0xcc5511 })),
    part(400, new THREE.MeshStandardMaterial({ color: 0xcc5512 })),
    part(400, new THREE.MeshStandardMaterial({ color: 0x88ddff })),
  ]);
  const pal = bodyPalette(e);
  check('near-duplicates collapse', pal.swatches.length === 3,
    `${pal.swatches.length} swatches: ${pal.swatches.map((s) => `#${s.hex.toString(16)}`).join(' ')}`);
  check('...and the shares still sum to 1',
    Math.abs(pal.swatches.reduce((n, s) => n + s.share, 0) - 1) < 1e-9);
  check('the cap holds', pal.swatches.length <= (P.max ?? 6));
}
{
  // TWO GREYS ARE ONE GREY. Their nominal hues are meaningless and far apart,
  // so without weighting hue by saturation nothing desaturated ever merges —
  // which is most of this roster.
  const e = body([
    part(400, new THREE.MeshStandardMaterial({ color: 0x3a3a39 })),
    part(400, new THREE.MeshStandardMaterial({ color: 0x393a3a })),
  ]);
  check('two near-greys merge whatever their hues say',
    bodyPalette(e).swatches.length === 1,
    'the megalodon\'s hue is a meaningless 0 and so is the crab\'s');
}

// --- NOTHING TO READ --------------------------------------------------------
section('nothing to read');
check('a body with no visual has no palette', bodyPalette({}) === null);
check('...and no creature at all is null', bodyPalette(null) === null);

// --- THE LIFT ---------------------------------------------------------------
// systems/bossBoom.js's half: near-black hides made visible without the palette
// collapsing into one colour.
section('the lift, in bossBoom');
{
  const dark = 0x11161c;
  const pale = 0xcdb6b4;
  const e = body([
    part(600, new THREE.MeshStandardMaterial({ color: dark })),
    part(600, new THREE.MeshStandardMaterial({ color: pale })),
  ]);
  const pal = bossBoomPalette(e);
  const lum = (hex) => { const c = new THREE.Color(hex); const h = {}; c.getHSL(h, THREE.SRGBColorSpace); return h.l; };
  check('two swatches survive the lift', pal.swatches.length === 2,
    pal.swatches.map((s) => `#${s.hex.toString(16)}`).join(' '));
  const ls = pal.swatches.map((s) => lum(s.hex)).sort((a, b) => a - b);
  check('both are lifted clear of the water', ls[0] > (BOOM.tint.lightnessFloor ?? 0.42) - 0.02,
    `darkest lands at ${ls[0].toFixed(3)} — the composite drops everything about a stop and a `
    + 'half, and an unlifted hide is a black cloud on dark water');
  check('...and the pale part is still paler than the dark one',
    ls[1] - ls[0] > 0.03,
    `${ls[0].toFixed(3)} vs ${ls[1].toFixed(3)} — lifted to a constant lightness this is a `
    + 'six-swatch palette rendering as one swatch six times, which looks completely fine');
}
{
  // AND AN ELEMENT IS NOT A HIDE. The lift exists because a boss's colour is a
  // near-black body colour; an element is a UI colour authored bright, and
  // putting it through the same correction is the one way to lose it.
  const els = CONFIG.biolum?.elements ?? {};
  const e = body([part(600, new THREE.MeshStandardMaterial({ color: 0x11161c }))],
    { venomTimer: 9 });
  const pal = bossBoomPalette(e);
  check('an elemental swatch is untouched by the hide correction',
    pal.swatches.some((s) => s.hex === els.venom.color),
    pal.swatches.map((s) => `#${s.hex.toString(16)}`).join(' '));
}
{
  // The fallback path, which has to keep working: switching the palette off is
  // the single flat tint this shipped with.
  const was = BOOM.palette.enabled;
  BOOM.palette.enabled = false;
  const pal = bossBoomPalette(body([part(600, new THREE.MeshStandardMaterial({ color: 0x11161c }))]));
  BOOM.palette.enabled = was;
  check('switched off, it is one colour', pal.swatches.length === 1,
    `${pal.swatches.length} swatches`);
  check('...and the mean is that colour', pal.mean === pal.swatches[0].hex);
}
{
  // A body nothing can be read from still explodes. The king crab has no
  // hitbox; a model that failed to load has no materials; neither may be a
  // frame that throws on the kill.
  const pal = bossBoomPalette({ mesh: { position: { x: 0, y: 0 } }, radius: 4, assetKey: '__none__' });
  check('a body with nothing on it still gets a colour',
    pal.swatches.length === 1 && pal.mean != null,
    JSON.stringify(pal.swatches));
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
