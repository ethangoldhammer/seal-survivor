#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:skin
//
// Checks systems/biolumSkin.js without a GL context. Three halves, and the
// first two are the ones that catch real bugs:
//
//   ATTRIBUTES   the per-vertex aBioPos / aBioAxis it bakes. Plain arithmetic
//                over the bounding box, so fully checkable here — including
//                the property the whole design rests on: that a mesh 1000x
//                bigger bakes IDENTICAL values, which is what makes the
//                pattern survive the per-asset Size slider.
//
//   INJECTION    that the GLSL lands. Every hook is a string replace against
//                three.js's own chunks, and a replace that matches nothing is
//                a silent no-op — the material compiles perfectly and simply
//                never glows. That is the failure a three.js upgrade causes,
//                and it would otherwise only ever be found by eye.
//
//   SETTINGS     that CONFIG reaches the uniforms, that `enabled: false`
//                takes the body darkening off with the glow (otherwise
//                switching it off leaves a black fish behind), and that every
//                pattern name in the tuner dropdown maps to a real pattern.
//
// What it cannot tell you: whether the patterns look good, or whether the
// GLSL compiles. That is dist/biolum-sheet.html and a screenshot.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  attachBiolumSkin, applyBiolumSkinSettings, updateBiolumSkin, instantiateBiolumSkin,
  BIOLUM_PATTERNS, patternIndex, biolumSkinMaterialCount, setBiolumSkinVariant,
} from '../path/src/systems/biolumSkin.js';
import * as THREE_NS from 'three';
import { CONFIG, TUNER_SCHEMA, withoutInheritedPresetKeys } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// A fish-shaped box: long on X, shallow on Y and Z, deliberately off-origin
// so the centring is actually exercised rather than accidentally satisfied.
function makeBody(scale = 1, offset = 0) {
  const pos = [];
  for (const x of [0, 0.5, 1]) {
    for (const y of [0, 0.25]) {
      for (const z of [0, 0.2]) {
        pos.push((x + offset) * scale, y * scale, z * scale);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
}

// A preset name deliberately absent from CONFIG.biolumSkin.presets, so these
// materials resolve to `base` alone. Attaching with a REAL preset would mean
// every base assertion below was silently testing that preset's override.
const BASE_ONLY = '__test_base_only__';

// --- attributes ------------------------------------------------------------
section('ATTRIBUTES');
const mesh = makeBody(1, 3);
attachBiolumSkin(mesh.material, mesh, BASE_ONLY);

const bioPos = mesh.geometry.attributes.aBioPos;
const bioAxis = mesh.geometry.attributes.aBioAxis;
check('aBioPos was baked', !!bioPos, bioPos ? `${bioPos.count} verts, ${bioPos.itemSize}D` : '');
check('aBioAxis was baked', !!bioAxis);

const axisVals = [...Array(bioAxis.count)].map((_, i) => bioAxis.getX(i));
check('aBioAxis runs exactly 0..1 along the long axis',
  Math.min(...axisVals) === 0 && Math.max(...axisVals) === 1,
  `${Math.min(...axisVals)} .. ${Math.max(...axisVals)}`);

// Centred: the mean of a symmetric box is its middle, so every component
// should straddle zero rather than sitting in the positive octant.
let maxAbs = 0;
for (let i = 0; i < bioPos.count; i++) {
  maxAbs = Math.max(maxAbs, Math.abs(bioPos.getX(i)), Math.abs(bioPos.getY(i)), Math.abs(bioPos.getZ(i)));
}
check('aBioPos is centred and bounded to ±0.5',
  maxAbs <= 0.5 + 1e-6 && maxAbs > 0.4,
  `max |component| = ${maxAbs.toFixed(4)}`);

// Proportions survive: the box is 1 x 0.25 x 0.2, so the baked spans must be
// in the same ratio. Normalising per axis instead of by the longest side
// would make all three 1 and turn every spot into an ellipse.
const span = (get) => {
  const v = [...Array(bioPos.count)].map((_, i) => get(i));
  return Math.max(...v) - Math.min(...v);
};
const sx = span((i) => bioPos.getX(i));
const sy = span((i) => bioPos.getY(i));
check('proportions are preserved (not normalised per axis)',
  Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 0.25) < 1e-6,
  `x span ${sx.toFixed(3)}, y span ${sy.toFixed(3)}`);

// THE contract. Per-asset Size multipliers are live in the tuner, so anything
// measured in world units would repaint itself every time one moved.
const big = makeBody(1000, 3);
attachBiolumSkin(big.material, big, BASE_ONLY);
const bigPos = big.geometry.attributes.aBioPos;
let identical = true;
for (let i = 0; i < bioPos.count; i++) {
  identical = identical
    && Math.abs(bigPos.getX(i) - bioPos.getX(i)) < 1e-5
    && Math.abs(bigPos.getY(i) - bioPos.getY(i)) < 1e-5;
}
check('a 1000x larger mesh bakes identical values', identical,
  'so the pattern survives any fit or Size multiplier');

// Clones of one asset share geometry; re-baking per instance would be pure
// waste on a school of forty.
const shared = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial());
const before = mesh.geometry.attributes.aBioPos;
attachBiolumSkin(shared.material, shared, BASE_ONLY);
check('shared geometry is not re-baked', mesh.geometry.attributes.aBioPos === before);

// --- injection -------------------------------------------------------------
section('SHADER INJECTION (against real three.js chunks)');
for (const [label, libKey] of [['lit (standard)', 'standard'], ['unlit (basic)', 'basic']]) {
  const probe = makeBody();
  probe.material = libKey === 'basic' ? new THREE.MeshBasicMaterial() : new THREE.MeshStandardMaterial();
  attachBiolumSkin(probe.material, probe, BASE_ONLY);

  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib[libKey].vertexShader,
    fragmentShader: THREE.ShaderLib[libKey].fragmentShader,
  };
  probe.material.onBeforeCompile(shader, {});

  check(`${label}: uniforms reached the shader`,
    !!shader.uniforms.uBioPattern && !!shader.uniforms.uBioColorA && !!shader.uniforms.uBioTime);
  check(`${label}: vertex hook landed`,
    shader.vertexShader.includes('attribute vec3 aBioPos') &&
    shader.vertexShader.includes('vBioAxis = aBioAxis'));
  check(`${label}: glow is added to the final colour`,
    shader.fragmentShader.includes('gl_FragColor.rgb += bioRamp(bioHue)'));
  // The one that would otherwise fail silently as a washed-out fish rather
  // than as a missing effect.
  check(`${label}: body darkening landed on the base colour`,
    shader.fragmentShader.includes('diffuseColor.rgb *= uBioBodyDarken'));
  check(`${label}: every pattern branch is present`,
    BIOLUM_PATTERNS.every((_, i) => i === BIOLUM_PATTERNS.length - 1
      || shader.fragmentShader.includes(`uBioPattern == ${i}`)),
    `${BIOLUM_PATTERNS.length} patterns, last is the else branch`);
  check(`${label}: the voronoi helper survived`,
    shader.fragmentShader.includes('vec3 bioVoronoi(vec3 p)'));
}

// --- composition -----------------------------------------------------------
section('COMPOSITION');
// Outline shells and the wreck dissolve already own onBeforeCompile. This has
// to chain onto them — a stomped callback is a silent failure in someone
// else's effect.
const composed = makeBody();
let previousRan = false;
composed.material.onBeforeCompile = (sh) => {
  previousRan = true;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n// PRIOR_EFFECT');
};
attachBiolumSkin(composed.material, composed, BASE_ONLY);
const sh2 = {
  uniforms: {},
  vertexShader: THREE.ShaderLib.basic.vertexShader,
  fragmentShader: THREE.ShaderLib.basic.fragmentShader,
};
composed.material.onBeforeCompile(sh2, {});
check('the pre-existing onBeforeCompile still ran', previousRan);
check('its edit survived', sh2.vertexShader.includes('// PRIOR_EFFECT'));
check('and the skin was added on top', sh2.vertexShader.includes('aBioPos'));

const twice = makeBody();
attachBiolumSkin(twice.material, twice, BASE_ONLY);
const count = biolumSkinMaterialCount();
attachBiolumSkin(twice.material, twice, BASE_ONLY);
check('attaching twice is a no-op', biolumSkinMaterialCount() === count);

// --- settings --------------------------------------------------------------
section('SETTINGS');
const u = mesh.material.userData.__bioSkinUniforms;

// Every generated group, not just base — the groups share one item builder,
// so a drift here would be a drift everywhere at once, and a dropdown entry
// that isn't a real pattern silently selects blotches instead of erroring.
{
  const dropdowns = TUNER_SCHEMA
    .filter((g) => g.group?.startsWith('Bioluminescence'))
    .map((g) => g.items.find((i) => i.path.endsWith('.pattern')));
  check('every bioluminescence group has a pattern dropdown',
    dropdowns.length >= 4 && dropdowns.every(Boolean),
    `${dropdowns.length} groups`);
  check('and every option in them is a real pattern',
    dropdowns.every((d) => d.options.length === BIOLUM_PATTERNS.length
      && d.options.every((o) => BIOLUM_PATTERNS.includes(o))),
    `${BIOLUM_PATTERNS.length} patterns`);
}

CONFIG.biolumSkin.base.pattern = 'veins';
CONFIG.biolumSkin.base.strength = 2.5;
CONFIG.biolumSkin.base.bodyDarken = 0.4;
applyBiolumSkinSettings();
check('the pattern index reached the uniform',
  u.uBioPattern.value === patternIndex('veins') && u.uBioPattern.value === 4,
  `veins = ${u.uBioPattern.value}`);
check('strength reached the uniform', u.uBioStrength.value === 2.5);

CONFIG.biolumSkin.enabled = false;
applyBiolumSkinSettings();
// Both halves, not just the glow: leaving the darkening on would turn the
// toggle into "make the fish black" rather than "make it an ordinary fish".
check('disabling zeroes the glow AND restores the body',
  u.uBioStrength.value === 0 && u.uBioBodyDarken.value === 1,
  `strength ${u.uBioStrength.value}, darken ${u.uBioBodyDarken.value}`);

CONFIG.biolumSkin.enabled = true;
applyBiolumSkinSettings();
check('re-enabling restores both', u.uBioStrength.value === 2.5 && u.uBioBodyDarken.value === 0.4);

check('an unknown pattern name falls back to the first', patternIndex('nonsense') === 0);

const t0 = u.uBioTime.value;
updateBiolumSkin(0.5);
check('update advances the pattern clock', u.uBioTime.value > t0);

// --- presets ---------------------------------------------------------------
section('PRESETS');
CONFIG.biolumSkin.base.pattern = 'blotches';
CONFIG.biolumSkin.base.strength = 1.8;
CONFIG.biolumSkin.base.flickerAmp = 0;

// A synthetic preset, because the layering has to be tested against a preset
// with a KNOWN gap in it — and a shipped preset has no guaranteed gaps once
// anyone has tuned it (the tuner writes whole objects; see
// withoutInheritedPresetKeys). Asserting against a real one made this test a
// tripwire for ordinary tuning rather than for the resolve path.
CONFIG.biolumSkin.presets.__probe__ = { pattern: 'marble', strength: 4.25 };
const probeMesh = makeBody();
attachBiolumSkin(probeMesh.material, probeMesh, '__probe__');
const ru = probeMesh.material.userData.__bioSkinUniforms;
applyBiolumSkinSettings();
check('a preset overrides base where it disagrees',
  ru.uBioPattern.value === patternIndex('marble') && ru.uBioStrength.value === 4.25,
  `pattern ${BIOLUM_PATTERNS[ru.uBioPattern.value]}, base is ${CONFIG.biolumSkin.base.pattern}`);
check('and inherits base where it is silent',
  ru.uBioHueScale.value === CONFIG.biolumSkin.base.hueScale,
  `hueScale ${ru.uBioHueScale.value} from base`);
delete CONFIG.biolumSkin.presets.__probe__;

// The shipped presets must still actually differ from base, or the whole
// per-species idea is decoration.
check('every shipped preset overrides something',
  Object.entries(CONFIG.biolumSkin.presets).every(([, p]) =>
    Object.entries(p).some(([k, v]) => v !== CONFIG.biolumSkin.base[k])),
  Object.keys(CONFIG.biolumSkin.presets).join(', '));

const unknown = makeBody();
attachBiolumSkin(unknown.material, unknown, 'no-such-preset');
applyBiolumSkinSettings();
check('an unknown preset name falls back to base rather than to nothing',
  unknown.material.userData.__bioSkinUniforms.uBioPattern.value === patternIndex('blotches'));

check('every preset in the config has a tuner group',
  Object.keys(CONFIG.biolumSkin.presets).every((name) =>
    TUNER_SCHEMA.some((g) => g.items?.some((i) => i.path === `biolumSkin.presets.${name}.pattern`))),
  'a preset with no group is one nobody can reach');

// --- per-instance phase ----------------------------------------------------
section('PER-INSTANCE PHASE');
// The whole reason instances get their own material. A shared uniform block
// means a school breathes as one animal, which is worse than not animating.
const template = makeBody();
attachBiolumSkin(template.material, template, 'lantern');
let roots = [];
const phases = new Set();
for (let i = 0; i < 6; i++) {
  // Deliberately NOT parented to anything. A creature is unparented for the
  // whole window between createVisual and the caller adding it to a container,
  // and an earlier version of this system reaped instance materials on exactly
  // that window — silently freezing every creature's glow at its spawn values.
  const root = new THREE_NS.Group();
  const inst = new THREE_NS.Mesh(template.geometry, template.material);
  root.add(inst);
  roots.push({ root, inst });
  instantiateBiolumSkin(root);
  phases.add(inst.material.userData.__bioSkinUniforms.uBioPhase.value);
}
check('each instance got its own material',
  roots.every(({ inst }) => inst.material !== template.material));
check('and its own phase', phases.size === 6, `${phases.size} distinct phases from 6 spawns`);
check('the template material is untouched',
  template.material.userData.__bioSkinUniforms.uBioPhase.value === 0);

// phaseSpread 0 is the "judge the pattern" setting — it has to actually
// collapse a school back into lockstep.
CONFIG.biolumSkin.presets.lantern.phaseSpread = 0;
applyBiolumSkinSettings();
check('phaseSpread 0 collapses a school into lockstep',
  roots.every(({ inst }) => inst.material.userData.__bioSkinUniforms.uBioPhase.value === 0));
delete CONFIG.biolumSkin.presets.lantern.phaseSpread;

// An unparented instance must keep updating — this is the regression that
// froze every creature's glow at whatever it had when it was created.
CONFIG.biolumSkin.presets.lantern.strength = 3.7;
applyBiolumSkinSettings();
check('an unparented instance still receives settings',
  roots.every(({ inst }) => inst.material.userData.__bioSkinUniforms.uBioStrength.value === 3.7),
  'a creature is unparented between createVisual and being added to its container');
const tBefore = roots[0].inst.material.userData.__bioSkinUniforms.uBioTime.value;
updateBiolumSkin(0.5);
check('and its clock still advances',
  roots[0].inst.material.userData.__bioSkinUniforms.uBioTime.value > tBefore);
delete CONFIG.biolumSkin.presets.lantern.strength;

// --- collection -------------------------------------------------------------
section('COLLECTION');
// Every spawn adds a material, so they are held weakly — a strong set would
// leave thousands alive after a ten-minute run, walked by every slider drag.
check('instance materials are held weakly, not strongly',
  (() => {
    const src = readFileSync(new URL('../path/src/systems/biolumSkin.js', import.meta.url), 'utf8');
    return src.includes('new WeakRef(copy)') && !src.includes('attached.add(copy)');
  })(),
  'a strong reference here is an unbounded leak, and it cannot be observed from a test');

// --- the creature ----------------------------------------------------------
section('LANTERNFISH, LANTERN RAY, ABYSS SHARK');
for (const [id, asset, copiedFrom] of [
  ['lanternfish', 'enemyLanternfish', 'enemyFish'],
  ['lanternRay', 'enemyLanternRay', 'enemyStingray'],
  ['abyssShark', 'enemyAbyssShark', 'enemyGreatWhite'],
]) {
  const def = CONFIG.enemies[id];
  check(`${id} exists in CONFIG.enemies`, !!def);
  check(`${id} uses its OWN asset key`, def?.asset === asset,
    `sharing ${copiedFrom} would light every ordinary one of those too`);
}
// --- the save path ----------------------------------------------------------
section('SAVED SNAPSHOT');
// The tuner writes whole objects, so without this a preset is saved in full
// and pins every key it never meant to override — severing that species from
// `base` on the first slider drag. Dropping a key the user MEANT to keep is
// the worse failure of the two, so both directions are asserted.
{
  const skin = {
    enabled: true,
    base: { pattern: 'blotches', strength: 1.8, hueScale: 1.2, colorA: 0x00e5ff },
    presets: {
      a: { pattern: 'marble', strength: 1.8, hueScale: 1.2 }, // only pattern differs
      b: { strength: 3.0, colorA: 0x00e5ff },                 // only strength differs
    },
  };
  const out = withoutInheritedPresetKeys(skin);
  check('keys that merely restate base are dropped',
    JSON.stringify(out.presets.a) === JSON.stringify({ pattern: 'marble' }),
    JSON.stringify(out.presets.a));
  check('keys that genuinely differ are kept',
    JSON.stringify(out.presets.b) === JSON.stringify({ strength: 3.0 }),
    JSON.stringify(out.presets.b));
  check('base itself is written in full', out.base === skin.base);
  check('the live config is not mutated',
    Object.keys(skin.presets.a).length === 3,
    'this runs on CONFIG itself at save time');
  check('a config with no presets passes through untouched',
    withoutInheritedPresetKeys({ enabled: true }).enabled === true);
}

// --- the two bioluminescence systems agree ---------------------------------
// `biolumSkin` (this file: what a creature LOOKS like) and `bioluminescent`
// (enemies.csv + spawn.nightlife: WHEN it appears) are separate systems that
// happen to share a word. Nothing forces them to describe the same set of
// creatures, and the failure is quiet in both directions: a glowing creature
// that spawns at noon reads as a bug in the shader, and a night-gated creature
// with no glow is a species nobody can see and no message saying why.
{
  const glowAssets = new Set(
    Object.entries(ASSETS).filter(([, d]) => d.biolumSkin).map(([k]) => k));
  const glowCreatures = Object.entries(CONFIG.enemies)
    .filter(([, d]) => glowAssets.has(d.asset)).map(([k]) => k);
  const nightCreatures = Object.entries(CONFIG.enemies)
    .filter(([, d]) => d.bioluminescent).map(([k]) => k);

  check('every creature with a glowing asset is night-gated',
    glowCreatures.every((k) => CONFIG.enemies[k].bioluminescent),
    glowCreatures.join(', '));
  check('and every night-gated creature actually glows',
    nightCreatures.every((k) => glowAssets.has(CONFIG.enemies[k].asset)),
    nightCreatures.join(', '));
  check('every glowing asset names a preset that exists',
    [...glowAssets].every((k) => ASSETS[k].biolumSkin in CONFIG.biolumSkin.presets),
    [...glowAssets].map((k) => `${k}:${ASSETS[k].biolumSkin}`).join(', '));
  // The gate multiplies the spawn weight by 0 in daylight, so a glowing
  // creature is unreachable before dusk. Arriving at difficulty 0 would mean a
  // species that exists on paper and never once appears in a short run.
  check('and arrives late enough that its first night has come',
    glowCreatures.every((k) => (CONFIG.enemies[k].minDifficulty ?? 0) > 0),
    glowCreatures.map((k) => `${k}@${CONFIG.enemies[k].minDifficulty}`).join(', '));
}

// --- per-seal variants ------------------------------------------------------
// The seal team is the one asset that varies its look PER INDIVIDUAL rather
// than per species: one model, one shared `escort` preset, and a different
// pattern and palette stamped onto each squad member. The failure this guards
// is the obvious one — stamping the shared template instead of the instance
// clone, which repaints the entire squad the same colour and looks exactly
// like the variants "not working" rather than like a leak.
section('PER-SEAL VARIANTS');
{
  const seals = [];
  const tpl = makeBody();
  attachBiolumSkin(tpl.material, tpl, 'escort');
  const variants = CONFIG.sealTeam.skin.variants;

  for (let i = 0; i < variants.length; i++) {
    const root = new THREE_NS.Group();
    const inst = new THREE_NS.Mesh(tpl.geometry, tpl.material);
    root.add(inst);
    instantiateBiolumSkin(root);
    setBiolumSkinVariant(root, variants[i % variants.length]);
    seals.push(inst);
  }

  const patterns = new Set(seals.map((s) => s.material.userData.__bioSkinUniforms.uBioPattern.value));
  check('every seal in the squad wears a different pattern',
    patterns.size === variants.length, `${patterns.size} distinct from ${variants.length} seals`);

  const colors = new Set(seals.map((s) => s.material.userData.__bioSkinUniforms.uBioColorA.value.getHexString()));
  check('...and a different colour', colors.size === variants.length,
    `${colors.size} distinct from ${variants.length} seals`);

  // The leak check. If the variant were stamped on the template, this would be
  // whichever seal was built last instead of the preset's own pattern.
  check('the shared template is not repainted by any of them',
    tpl.material.userData.__bioSkinVariant === undefined
    && tpl.material.userData.__bioSkinUniforms.uBioPattern.value
       === patternIndex(CONFIG.biolumSkin.presets.escort.pattern));

  // A variant is a LAYER, not a replacement: anything it doesn't mention still
  // has to come from the preset, or every variant would silently reset the
  // squad's shared look back to `base`.
  const escort = CONFIG.biolumSkin.presets.escort;
  check('a variant layers over the preset rather than replacing it',
    seals.every((s) => s.material.userData.__bioSkinUniforms.uBioBodyDarken.value === escort.bodyDarken),
    `bodyDarken ${escort.bodyDarken} survives on all ${seals.length}`);

  // The tuner's off switch has to genuinely collapse them, since that is the
  // only way to judge the shared preset.
  const before = seals[0].material.userData.__bioSkinUniforms.uBioPattern.value;
  check('the variants are what is doing it, not the preset',
    before !== patternIndex(escort.pattern) || variants[0].pattern === escort.pattern);
}

check('the lanternfish still schools like the fish it copies',
  !!CONFIG.enemies.lanternfish?.swarm && CONFIG.enemies.lanternfish?.behavior === 'swarm');
check('the ray still glides and the shark still hunts',
  CONFIG.enemies.lanternRay?.behavior === 'glide' && CONFIG.enemies.abyssShark?.behavior === 'hunt');

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
