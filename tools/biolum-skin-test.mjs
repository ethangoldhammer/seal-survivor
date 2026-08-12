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
// crabpincer.glb (loaded by the EYE GLOW section) embeds its textures, and
// GLTFLoader decodes them through createImageBitmap. Without a stub the parse
// promise never settles and the script exits with "unsettled top-level await"
// and no error at all.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import {
  attachBiolumSkin, applyBiolumSkinSettings, updateBiolumSkin, instantiateBiolumSkin,
  BIOLUM_PATTERNS, patternIndex, biolumSkinMaterialCount, setBiolumSkinVariant,
} from '../path/src/systems/biolumSkin.js';
import * as THREE_NS from 'three';
import { CONFIG, TUNER_SCHEMA, withoutInheritedPresetKeys } from '../path/src/config.js';
import { updateBeatSync } from '../path/src/systems/beatSync.js';
import { ASSETS } from '../path/src/assets.js';
import { pulseDemoFor, panDemoFor } from '../path/src/systems/glowDebug.js';

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
    !!shader.uniforms.uBioPattern && !!shader.uniforms.uBioColorA
    && !!shader.uniforms.uBioCycle && !!shader.uniforms.uBioFlickerT);
  check(`${label}: vertex hook landed`,
    shader.vertexShader.includes('attribute vec3 aBioPos') &&
    shader.vertexShader.includes('vBioAxis = aBioAxis'));
  check(`${label}: glow is added to the final colour`,
    shader.fragmentShader.includes('gl_FragColor.rgb += bioRamp(bioHue)'));
  // The eyes ride the same injection. Checked on BOTH materials because that
  // is the entire reason they are a vertex attribute rather than an emissive
  // map — an unlit creature has no emissive slot to put one in.
  check(`${label}: the eye term landed`,
    shader.fragmentShader.includes('gl_FragColor.rgb += uEyeColor')
    && !!shader.uniforms.uEyeStrength && !!shader.uniforms.uEyeColor
    && !!shader.uniforms.uEyeFalloff);
  check(`${label}: aEyeGlow reaches the fragment stage`,
    shader.vertexShader.includes('attribute float aEyeGlow')
    && shader.vertexShader.includes('vEyeGlow = aEyeGlow'));

  // EVERY VARYING THIS MODULE WRITES IS DECLARED IN THE STAGE THAT WRITES IT.
  //
  // The regression: `vEyeGlow = aEyeGlow;` shipped without a matching
  // `varying float vEyeGlow;` in the VERTEX shader — the declaration existed
  // only in GLSL, which is injected into the fragment stage. That is not a
  // silent no-op like a missed hook, it is a compile error ('vEyeGlow' :
  // undeclared identifier), so the program never links and EVERY creature
  // wearing a glow skin renders as nothing at all: the lanternfish, the ray,
  // the shark and both crabs, on one missing line.
  //
  // Every check above passed while that was true, because each one asks
  // whether a string landed. This asks whether the result is a shader.
  //
  // Keyed on `varying = attribute` assignments rather than a hardcoded list,
  // so the next attribute anyone pipes through is covered without an edit —
  // and three's own chunks are still unresolved #includes here, so their
  // varyings are correctly out of scope.
  {
    const written = [...shader.vertexShader.matchAll(/^\s*(\w+)\s*=\s*(a[A-Z]\w*)\s*;/gm)];
    const undeclared = written.filter(([, name]) =>
      !new RegExp(`varying\\s+\\w+\\s+${name}\\b`).test(shader.vertexShader));
    check(`${label}: every varying the vertex stage writes is declared there`,
      written.length >= 3 && undeclared.length === 0,
      undeclared.length
        ? `undeclared: ${undeclared.map(([, n]) => n).join(', ')} — the vertex shader will not compile`
        : `${written.map(([, n]) => n).join(', ')}`);
    // ...and that the fragment stage can still read them, which is the other
    // half of a varying and the half the old code had.
    check(`${label}: ...and the fragment stage declares them too`,
      written.every(([, name]) => new RegExp(`varying\\s+\\w+\\s+${name}\\b`).test(shader.fragmentShader)));
  }
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

// --- eye glow ---------------------------------------------------------------
// The attribute the crabs' eyes ride on. Baked from the SKELETON rather than
// from a texture, because the eyes have no UV island to paint into and half
// the creatures that want the effect are unlit and cannot take an emissive map
// at all. See bakeEyeGlow.
section('EYE GLOW');
{
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = dirname(fileURLToPath(import.meta.url));
  const MODEL = resolve(HERE, '../public/models/crabpincer.glb');

  if (!existsSync(MODEL)) {
    check('crabpincer.glb is on disk', false, MODEL);
  } else {
    const buf = readFileSync(MODEL);
    const gltf = await new GLTFLoader().parseAsync(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
    );
    let skinned = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
    gltf.scene.updateMatrixWorld(true);

    const STALKS = ASSETS.enemyWalkingCrab.eyeStalks;
    check('the asset declares both eye stalks', STALKS?.length === 2,
      STALKS ? STALKS.map((s2) => `${s2[0]}..${s2[s2.length - 1]}`).join(', ') : 'none');

    const mat = new THREE_NS.MeshStandardMaterial();
    attachBiolumSkin(mat, skinned, BASE_ONLY, 'z', STALKS);
    const eye = skinned.geometry.attributes.aEyeGlow;
    check('aEyeGlow was baked', !!eye, eye ? `${eye.count} verts` : '');

    // Every bone name has to resolve. A typo bakes an all-zero attribute and
    // the eyes simply never light — no error, no warning at runtime.
    const bones = new Set(skinned.skeleton.bones.map((b) => b.name));
    const missing = STALKS.flat().filter((n) => !bones.has(n));
    check('every declared stalk bone is on the skeleton', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${STALKS.flat().length} bones, all present`);

    let lit = 0;
    let peak = 0;
    for (let i = 0; i < eye.count; i++) {
      const v = eye.getX(i);
      if (v > 0.001) lit++;
      peak = Math.max(peak, v);
    }
    // A handful of stalk vertices out of thousands. If this were most of the
    // mesh the projection would be leaking onto the shell.
    check('only the stalks are lit, not the body',
      lit > 20 && lit < eye.count * 0.1,
      `${lit} of ${eye.count} verts carry any glow (${(lit / eye.count * 100).toFixed(1)}%)`);
    check('the ramp reaches full brightness at the tip', peak > 0.9,
      `peak ${peak.toFixed(3)}`);

    // THE POINT OF THE WHOLE THING: brighter at the tip than at the socket.
    //
    // Checked as a CORRELATION against each vertex's distance from the stalk's
    // base bone, rather than by re-deriving the axis the way bakeEyeGlow does.
    // Re-deriving it would make this tautological — it would pass just as
    // happily against the version of the bake whose axis pointed at the model
    // origin. Distance from a named bone is a fact about the rig instead, so
    // the two only agree if the ramp is genuinely running up the stalk.
    //
    // Bind space, via the inverse bind matrix: the position attribute is in
    // bind space and bone.matrixWorld is the current pose in world space.
    const baseBone = skinned.skeleton.bones.findIndex((b) => b.name === 'Eye1L_02');
    const bindBase = new THREE_NS.Vector3().setFromMatrixPosition(
      new THREE_NS.Matrix4().copy(skinned.skeleton.boneInverses[baseBone]).invert(),
    ).applyMatrix4(skinned.bindMatrixInverse);

    // ONE STALK AT A TIME. Both eyes are lit and they are mirrored about the
    // head, so a right-eye vertex's distance from the LEFT socket is not a
    // position along any stalk — mixing them buries the signal in noise
    // (measured: r=0.21 pooled, against r=1.00 on a stalk taken alone).
    // Membership comes from the skin weights, the same way the bake picks it.
    const si2 = skinned.geometry.attributes.skinIndex;
    const sw2 = skinned.geometry.attributes.skinWeight;
    const pos = skinned.geometry.attributes.position;
    const v3 = new THREE_NS.Vector3();

    const bindPosOf = (name) => {
      const bi = skinned.skeleton.bones.findIndex((b) => b.name === name);
      return new THREE_NS.Vector3().setFromMatrixPosition(
        new THREE_NS.Matrix4().copy(skinned.skeleton.boneInverses[bi]).invert(),
      ).applyMatrix4(skinned.bindMatrixInverse);
    };

    for (const stalk of STALKS) {
      const ids = new Set(stalk.map((n) => skinned.skeleton.bones.findIndex((b) => b.name === n)));
      const socket = bindPosOf(stalk[0]);
      const ds = [];
      const gs = [];
      for (let i = 0; i < eye.count; i++) {
        const gv = eye.getX(i);
        if (gv <= 0.001) continue;
        let w = 0;
        for (let k = 0; k < 4; k++) if (ids.has(si2.getComponent(i, k))) w += sw2.getComponent(i, k);
        if (w <= 0.001) continue;
        ds.push(v3.fromBufferAttribute(pos, i).distanceTo(socket));
        gs.push(gv);
      }
      const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
      const md = mean(ds);
      const mg = mean(gs);
      let num = 0;
      let dd = 0;
      let dg = 0;
      for (let i = 0; i < ds.length; i++) {
        num += (ds[i] - md) * (gs[i] - mg);
        dd += (ds[i] - md) ** 2;
        dg += (gs[i] - mg) ** 2;
      }
      const r = num / Math.sqrt((dd * dg) || 1);
      check(`${stalk[0]}: glow rises with distance from the socket`, r > 0.6,
        `Pearson r = ${r.toFixed(3)} over ${ds.length} verts`);
    }

    // ...and that it is a RAMP rather than a constant, which the correlation
    // alone would not catch — a bake that lit every stalk vertex to exactly
    // 1.0 has an undefined correlation, not a failing one.
    //
    // What this would catch: a bake that skipped the rescale in bakeEyeGlow.
    // At 13% decimation the eye survives as a tight ball with no shaft behind
    // it, so against the raw socket-to-tip length every vertex lands between
    // 0.99 and 1.00 — a perfect correlation and a completely flat eye.
    const all = [];
    for (let i = 0; i < eye.count; i++) {
      const gv = eye.getX(i);
      if (gv > 0.001) all.push(gv);
    }
    check('the ramp varies rather than sitting at one value',
      Math.min(...all) < 0.6 && Math.max(...all) > 0.9,
      `${Math.min(...all).toFixed(3)}..${Math.max(...all).toFixed(3)} across ${all.length} lit verts`);

    // A model that declares nothing must be untouched, or every fish in the
    // roster pays for a feature only the crabs use.
    const plain = makeBody();
    attachBiolumSkin(plain.material, plain, BASE_ONLY);
    const none = plain.geometry.attributes.aEyeGlow;
    check('a model with no stalks bakes an all-zero attribute', !!none
      && [...Array(none.count)].every((_, i) => none.getX(i) === 0),
      `${none?.count ?? 0} verts, all 0 — the shader multiplies it out to nothing`);
  }
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
CONFIG.biolumSkin.base.glow = 1;
CONFIG.biolumSkin.base.bodyDarken = 0.4;
applyBiolumSkinSettings();
check('the pattern index reached the uniform',
  u.uBioPattern.value === patternIndex('veins') && u.uBioPattern.value === 4,
  `veins = ${u.uBioPattern.value}`);
check('strength reached the uniform', u.uBioStrength.value === 2.5);

// `glow` is the family-wide bloom push, multiplied onto the per-species
// strength. Two knobs rather than one because they are re-tuned at different
// times: strength when the palettes move, glow when CONFIG.bloom does.
CONFIG.biolumSkin.base.glow = 2;
applyBiolumSkinSettings();
check('glow multiplies strength rather than replacing it',
  u.uBioStrength.value === 5, `${u.uBioStrength.value}`);
CONFIG.biolumSkin.base.glow = 1;
applyBiolumSkinSettings();

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

const t0 = u.uBioDrift.value;
updateBiolumSkin(0.5);
check('update advances the drift clock', u.uBioDrift.value > t0);

// --- presets ---------------------------------------------------------------
section('PRESETS');
CONFIG.biolumSkin.base.pattern = 'blotches';
CONFIG.biolumSkin.base.strength = 1.8;
CONFIG.biolumSkin.base.glow = 1;
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
  phases.add(inst.material.userData.__bioSkinSeed);
}
check('each instance got its own material',
  roots.every(({ inst }) => inst.material !== template.material));
check('and its own seed', phases.size === 6, `${phases.size} distinct seeds from 6 spawns`);
check('the template material has no individual to be',
  template.material.userData.__bioSkinSeed === undefined
  && (template.material.userData.__bioSkinOffset ?? 0) === 0);

// THE REGRESSION. The offset used to be stored ON the uniform and recomputed
// as `phase = (phase % 100) * phaseSpread` every time settings were pushed —
// and settings are pushed on every spawn and every slider move. At the shipped
// spread of 0.5 that halved the whole school's spread each time, so a shoal
// collapsed into lockstep after a dozen fish. Deriving from a stored SEED
// makes the computation idempotent, which is what this checks.
CONFIG.biolumSkin.presets.lantern.phaseSpread = 0.5;
CONFIG.biolumSkin.presets.lantern.phaseSteps = 0;
applyBiolumSkinSettings();
const firstOffsets = roots.map(({ inst }) => inst.material.userData.__bioSkinOffset);
for (let i = 0; i < 20; i++) applyBiolumSkinSettings();
check('the phase offset survives repeated applies',
  roots.every(({ inst }, i) => inst.material.userData.__bioSkinOffset === firstOffsets[i]),
  'apply runs on every spawn — a compounding offset collapses a school into lockstep');
check('...and the spread is honoured, not the raw seed',
  firstOffsets.every((o) => o >= 0 && o <= 0.5),
  `offsets ${firstOffsets.map((o) => o.toFixed(3)).join(', ')}`);

// QUANTISED PHASE. A continuous random offset puts every fish a random
// fraction of a beat off the grid, which undoes the division picker one
// creature at a time. Snapping to slots is what keeps a school musical.
CONFIG.biolumSkin.presets.lantern.phaseSpread = 1;
CONFIG.biolumSkin.presets.lantern.phaseSteps = 4;
applyBiolumSkinSettings();
const quantised = roots.map(({ inst }) => inst.material.userData.__bioSkinOffset);
check('phaseSteps snaps every individual onto a slot',
  quantised.every((o) => Math.abs(o * 4 - Math.round(o * 4)) < 1e-9),
  `offsets ${quantised.map((o) => o.toFixed(3)).join(', ')}`);
check('...and the slots are still spread across the cycle',
  new Set(quantised).size > 1, `${new Set(quantised).size} distinct slots from 6 spawns`);

// phaseSpread 0 is the "judge the pattern" setting — it has to actually
// collapse a school back into lockstep.
CONFIG.biolumSkin.presets.lantern.phaseSpread = 0;
applyBiolumSkinSettings();
check('phaseSpread 0 collapses a school into lockstep',
  roots.every(({ inst }) => inst.material.userData.__bioSkinOffset === 0));
delete CONFIG.biolumSkin.presets.lantern.phaseSpread;
delete CONFIG.biolumSkin.presets.lantern.phaseSteps;

// An unparented instance must keep updating — this is the regression that
// froze every creature's glow at whatever it had when it was created.
CONFIG.biolumSkin.presets.lantern.strength = 3.7;
// `glow` is the family-wide bloom push and multiplies onto strength, so it has
// to be pinned for the uniform to be comparable against the number set above —
// otherwise this reads as a broken instance whenever anyone retunes the glow.
const lanternGlow = CONFIG.biolumSkin.presets.lantern.glow;
CONFIG.biolumSkin.presets.lantern.glow = 1;
applyBiolumSkinSettings();
check('an unparented instance still receives settings',
  roots.every(({ inst }) => inst.material.userData.__bioSkinUniforms.uBioStrength.value === 3.7),
  'a creature is unparented between createVisual and being added to its container');
if (lanternGlow === undefined) delete CONFIG.biolumSkin.presets.lantern.glow;
else CONFIG.biolumSkin.presets.lantern.glow = lanternGlow;
const tBefore = roots[0].inst.material.userData.__bioSkinUniforms.uBioDrift.value;
updateBiolumSkin(0.5);
check('and its clock still advances',
  roots[0].inst.material.userData.__bioSkinUniforms.uBioDrift.value > tBefore);
delete CONFIG.biolumSkin.presets.lantern.strength;

// --- beat sync --------------------------------------------------------------
section('BEAT SYNC');
// The end-to-end version of what tools/beat-sync-test.mjs checks in isolation:
// that the phase a MATERIAL ends up with really is derived from the transport,
// and that two individuals with different seeds sit a whole slot apart rather
// than a random fraction of one.
{
  const synced = makeBody();
  attachBiolumSkin(synced.material, synced, BASE_ONLY);
  CONFIG.biolumSkin.base.pulseSync = '1 bar';
  CONFIG.biolumSkin.base.flickerSync = '1/4';
  applyBiolumSkinSettings();
  const su = synced.material.userData.__bioSkinUniforms;

  // Frame-rate independence is the whole reason the phase is derived rather
  // than integrated: one 0.6s step and six 0.1s steps must land in the same
  // place, or a frame drop permanently shifts a creature off the beat.
  updateBeatSync(0.6);
  updateBiolumSkin(0.6);
  const coarse = su.uBioCycle.value;
  const fine = makeBody();
  attachBiolumSkin(fine.material, fine, BASE_ONLY);
  applyBiolumSkinSettings();
  for (let i = 0; i < 6; i++) { updateBeatSync(0.0); updateBiolumSkin(0.1); }
  check('a synced phase is frame-rate independent',
    Math.abs(fine.material.userData.__bioSkinUniforms.uBioCycle.value - coarse) < 1e-6,
    `${coarse.toFixed(5)} vs ${fine.material.userData.__bioSkinUniforms.uBioCycle.value.toFixed(5)}`);

  // Drift is deliberately NOT synced — it translates through the noise rather
  // than repeating, so there is no cycle to quantise.
  const d0 = su.uBioDrift.value;
  updateBiolumSkin(0.5);
  check('drift keeps running on seconds, not on the grid', su.uBioDrift.value > d0);

  // ...and 'free' has to still work, or the master switch is a one-way door.
  CONFIG.biolumSkin.base.pulseSync = 'free';
  applyBiolumSkinSettings();
  const f0 = su.uBioCycle.value;
  updateBiolumSkin(0.4);
  check('a free phase still advances on dt', su.uBioCycle.value !== f0);
  check('...and stays inside the wrap the shader needs',
    su.uBioCycle.value >= 0 && su.uBioCycle.value < 2,
    `${su.uBioCycle.value.toFixed(4)} (wrap 2, for the half-rate hue term)`);
  delete CONFIG.biolumSkin.base.pulseSync;
  delete CONFIG.biolumSkin.base.flickerSync;
}

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
  // LUMINOUS assets, not merely patterned ones. The generator is also used as
  // pigment now — the day crab's `carapace` is a dim static shell texture on a
  // creature that must keep spawning in daylight — so "has a biolumSkin" no
  // longer means "emits light". The preset says which it is; see
  // CONFIG.biolumSkin.base.luminous.
  const isLuminous = (preset) => {
    const p = CONFIG.biolumSkin.presets[preset] ?? {};
    return (p.luminous ?? CONFIG.biolumSkin.base.luminous ?? true) !== false;
  };
  const glowAssets = new Set(
    Object.entries(ASSETS)
      .filter(([, d]) => d.biolumSkin && isLuminous(d.biolumSkin))
      .map(([k]) => k));
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
  // This one deliberately covers every PATTERNED asset, luminous or not: a
  // typo'd preset name falls back to the base pattern in silence, and that is
  // just as wrong on a crab's shell as on a lanternfish.
  const patterned = Object.entries(ASSETS).filter(([, d]) => d.biolumSkin).map(([k]) => k);
  check('every patterned asset names a preset that exists',
    patterned.every((k) => ASSETS[k].biolumSkin in CONFIG.biolumSkin.presets),
    patterned.map((k) => `${k}:${ASSETS[k].biolumSkin}`).join(', '));
  // The gate multiplies the spawn weight by 0 in daylight, so a glowing
  // creature is unreachable before dusk. Arriving at difficulty 0 would mean a
  // species that exists on paper and never once appears in a short run.
  check('and arrives late enough that its first night has come',
    glowCreatures.every((k) => (CONFIG.enemies[k].minDifficulty ?? 0) > 0),
    glowCreatures.map((k) => `${k}@${CONFIG.enemies[k].minDifficulty}`).join(', '));
}

// --- per-instance variants --------------------------------------------------
// setBiolumSkinVariant stamps ONE individual's material, over the top of its
// species preset. Its live caller is the Alt+N glow lineup in main.js, which
// forces PULSE_DEMO / PAN_DEMO onto the creatures it spawns so a breath that
// is clipping can be seen at all (systems/glowDebug.js).
//
// The failure this guards is the obvious one — stamping the shared template
// instead of the instance clone, which repaints every creature of that species
// and looks exactly like the demo "not working" rather than like a leak.
//
// (The seal team used to be the headline caller: a different pattern and
// palette per squad member. The escorts now wear the player's own noise
// mottling instead — see systems/noiseShader.js — so the variant path is the
// debug lineup's alone.)
section('PER-INSTANCE VARIANTS');
{
  const lit = [];
  const tpl = makeBody();
  attachBiolumSkin(tpl.material, tpl, 'lantern');
  // Both demos now SIZE THEMSELVES against the creature they are stamped on —
  // strength is derived from that preset's `glow` and palette rather than
  // hardcoded, so a shared constant would no longer describe either of them.
  // See strengthForCeiling in systems/glowDebug.js.
  const lanternCfg = { ...CONFIG.biolumSkin.base, ...CONFIG.biolumSkin.presets.lantern };
  const pulseDemo = pulseDemoFor(lanternCfg);
  const panDemo = panDemoFor(lanternCfg);
  const variants = [pulseDemo, panDemo];

  for (const variant of variants) {
    const root = new THREE_NS.Group();
    const inst = new THREE_NS.Mesh(tpl.geometry, tpl.material);
    root.add(inst);
    instantiateBiolumSkin(root);
    setBiolumSkinVariant(root, variant);
    lit.push(inst);
  }

  const lantern = CONFIG.biolumSkin.presets.lantern;
  const u = (m) => m.material.userData.__bioSkinUniforms;
  // Each demo drops strength to its own derived value — the pan demo aims a
  // little lower than the pulse one, since it has no breath to clip — so the
  // stamp is proved per variant, against the TEMPLATE, which keeps the
  // preset's own value.
  const expected = [pulseDemo, panDemo].map((v) => v.strength * (lantern.glow ?? 1));
  check('a stamped individual takes the variant\'s value, not the preset\'s',
    lit.every((s, i) => Math.abs(u(s).uBioStrength.value - expected[i]) < 1e-9)
    && expected.every((e) => Math.abs(u(tpl).uBioStrength.value - e) > 1e-9),
    `${lit.map((s) => u(s).uBioStrength.value.toFixed(3)).join(', ')} vs template ${u(tpl).uBioStrength.value.toFixed(3)}`);

  // ...and two individuals off the same template disagree, which is the whole
  // reason the stamp is per-material: the pulse demo opens the breath right up
  // and the pan demo holds it still.
  check('two individuals off one template can disagree',
    u(lit[0]).uBioPulseAmp.value === pulseDemo.pulseAmp
    && u(lit[1]).uBioPulseAmp.value === panDemo.pulseAmp,
    `${lit.map((s) => u(s).uBioPulseAmp.value).join(' vs ')}`);

  // The leak check. If the variant were stamped on the template, this would be
  // whichever individual was built last instead of the preset's own value.
  check('the shared template is not repainted by any of them',
    tpl.material.userData.__bioSkinVariant === undefined
    && tpl.material.userData.__bioSkinUniforms.uBioPattern.value
       === patternIndex(lantern.pattern));

  // A variant is a LAYER, not a replacement: anything it doesn't mention still
  // has to come from the preset, or every stamp would silently reset the
  // creature's shared look back to `base`.
  check('a variant layers over the preset rather than replacing it',
    lit.every((s) => s.material.userData.__bioSkinUniforms.uBioBodyDarken.value === lantern.bodyDarken),
    `bodyDarken ${lantern.bodyDarken} survives on all ${lit.length}`);
}

// The escorts left the glow system entirely: they wear CONFIG.sealShader, the
// player's own procedural mottling, so `biolumSkin` on that asset would be a
// second unrelated pattern painted over the first.
//
// The preset clause is the half that needs a test. `escort` is still in every
// saved snapshot on disk, and a deep merge adds keys it finds, so without
// pruneUnknownGlowPresets it comes back as a group the tuner never built —
// which is what 'every preset in the config has a tuner group' above would
// catch, one section too late to say why.
check('the seal team wears the player\'s noise, not a glow skin',
  ASSETS.sealTeam.noiseShader === true && ASSETS.sealTeam.biolumSkin === undefined
  && CONFIG.biolumSkin.presets.escort === undefined,
  `noiseShader=${ASSETS.sealTeam.noiseShader}, biolumSkin=${ASSETS.sealTeam.biolumSkin}, escort preset=${CONFIG.biolumSkin.presets.escort ? 'resurrected' : 'gone'}`);

check('the lanternfish still schools like the fish it copies',
  !!CONFIG.enemies.lanternfish?.swarm && CONFIG.enemies.lanternfish?.behavior === 'swarm');
check('the ray still glides and the shark still hunts',
  CONFIG.enemies.lanternRay?.behavior === 'glide' && CONFIG.enemies.abyssShark?.behavior === 'hunt');

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
