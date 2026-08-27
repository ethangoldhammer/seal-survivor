#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:grass
//
// Checks the seabed grass without a GL context. Three halves:
//
//   ASSET       that tools/optimize-grass.mjs produced what grassSway.js
//               assumes. The sway masks on uv.y and measures blade height
//               from y=0, so "v spans 0..1" and "base sits at the origin" are
//               not cosmetic facts about the file — they are the contract the
//               shader is written against. A re-export that breaks either one
//               produces grass that bends from the wrong place, which is a
//               thing you have to notice by eye rather than a thing that
//               errors.
//
//   INJECTION   that the GLSL actually lands. Every hook is a string replace
//               against three.js's own shader chunks, and a replace that
//               finds nothing is a silent no-op: the material compiles and
//               the grass simply stands still. That is the failure a three.js
//               upgrade causes. So this runs onBeforeCompile against the REAL
//               ShaderLib source and asserts the uniforms and the
//               displacement are present afterwards — including that
//               vMapUv is genuinely declared, since guarding on the wrong
//               define silently falls back to the height mask.
//
//   MOTION      that the displacement does what it claims. The GLSL is ported
//               to JS here and run over the actual blade vertices: roots
//               planted, tips moving, blades keeping their length, and
//               neighbouring clumps out of phase with each other.
//
// What it cannot tell you: whether the sway looks good. That is a screenshot.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import { attachGrassSway, applyGrassSettings, updateGrassSway, setGrassSwayHeight,
  registerShovedInstances, clearShovedInstances, shovedInstanceCount } from '../path/src/systems/grassSway.js';
import { ASSETS } from '../path/src/assets.js';
import { SEABED_PROPS } from '../path/src/seabedProps.js';
import { updateBeatSync, BEAT_DIVISIONS } from '../path/src/systems/beatSync.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = path.join(HERE, '../public/models/grass.glb');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --------------------------------------------------------------------- asset

section('ASSET — what optimize-grass.mjs guarantees the shader');

const raw = fs.readFileSync(MODEL);
// Strip the atlas: GLTFLoader would need an image decoder, and nothing here
// looks at pixels. The geometry and the material flags survive untouched.
let o = 12, gltfJson = null, bin = null;
while (o < raw.length) {
  const len = raw.readUInt32LE(o), type = raw.toString('ascii', o + 4, o + 8);
  if (type === 'JSON') gltfJson = JSON.parse(raw.toString('utf8', o + 8, o + 8 + len));
  if (type.startsWith('BIN')) bin = raw.subarray(o + 8, o + 8 + len);
  o += 8 + len;
}
const srcMaterial = gltfJson.materials[0];
check('one material', gltfJson.materials.length === 1);
check('one mesh, one primitive',
  gltfJson.meshes.length === 1 && gltfJson.meshes[0].primitives.length === 1);
check('alphaMode is MASK, not BLEND', srcMaterial.alphaMode === 'MASK', srcMaterial.alphaMode);
check('doubleSided kept (flat cards need both faces)', srcMaterial.doubleSided === true);
check('atlas sampler clamps (REPEAT would fetch the next cell)',
  gltfJson.samplers[0].wrapS === 33071 && gltfJson.samplers[0].wrapT === 33071);

const stripped = structuredClone(gltfJson);
delete stripped.textures; delete stripped.images; delete stripped.samplers;
delete stripped.materials[0].pbrMetallicRoughness.baseColorTexture;
const jsonBuf = Buffer.from(JSON.stringify(stripped), 'utf8');
const jsonPad = Buffer.concat([jsonBuf, Buffer.alloc((4 - jsonBuf.length % 4) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + bin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonPad.length, 0); jh.write('JSON', 4, 'ascii');
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'ascii');
const rebuilt = Buffer.concat([header, jh, jsonPad, bh, bin]);

const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(rebuilt.buffer.slice(rebuilt.byteOffset, rebuilt.byteOffset + rebuilt.byteLength), '', res, rej));

let mesh = null;
gltf.scene.traverse((n) => { if (n.isMesh && !mesh) mesh = n; });
const geo = mesh.geometry;
const pos = geo.attributes.position;
const uv = geo.attributes.uv;

check('geometry carries UVs', !!uv);
let vMin = Infinity, vMax = -Infinity, yMin = Infinity, yMax = -Infinity;
for (let i = 0; i < pos.count; i++) {
  vMin = Math.min(vMin, uv.getY(i)); vMax = Math.max(vMax, uv.getY(i));
  yMin = Math.min(yMin, pos.getY(i)); yMax = Math.max(yMax, pos.getY(i));
}
check('uv.y spans the full 0..1 root-to-tip range', vMin < 0.001 && vMax > 0.999,
  `${vMin.toFixed(4)}..${vMax.toFixed(4)}`);
check('blade base sits at y=0', Math.abs(yMin) < 0.001, `min y ${yMin.toFixed(4)}`);
check('nothing dips below the base', yMin > -0.001);
check('no leftover swatch quads far above the clump', yMax < 5, `max y ${yMax.toFixed(3)}`);
// The swatches were the tallest thing in the source; with them gone the clump
// is wider than it is tall, which is what makes `fit` read as WIDTH.
let xMin = Infinity, xMax = -Infinity;
for (let i = 0; i < pos.count; i++) { xMin = Math.min(xMin, pos.getX(i)); xMax = Math.max(xMax, pos.getX(i)); }
check('clump is wider than tall (fit normalises width)', (xMax - xMin) > yMax,
  `${(xMax - xMin).toFixed(2)} wide vs ${yMax.toFixed(2)} tall`);

// --------------------------------------------------------------------- config

section('CONFIG — defaults survive the saved-tuning merge');
const sway = CONFIG.grass?.sway;
check('CONFIG.grass.sway exists', !!sway);
check('enabled is not nulled out by saved tuning', sway?.enabled === true, String(sway?.enabled));
for (const key of ['amplitude', 'stiffness', 'speed', 'wavelength', 'direction', 'flutter', 'flutterSpeed', 'bend']) {
  check(`${key} is a number`, typeof sway?.[key] === 'number', String(sway?.[key]));
}
// A division name that isn't in the table silently reads as 'free', so a typo
// here is a setting that looks applied and does nothing.
for (const key of ['speedSync', 'flutterSync']) {
  check(`${key} names a real division`, BEAT_DIVISIONS.includes(sway?.[key]), String(sway?.[key]));
}

// ------------------------------------------------------------------ injection

section('INJECTION — the GLSL lands in three.js\'s real shader');

const CLUMP_HEIGHT = yMax;
const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
attachGrassSway(material, CLUMP_HEIGHT);
applyGrassSettings();

const shader = {
  uniforms: {},
  vertexShader: THREE.ShaderLib.standard.vertexShader,
  fragmentShader: THREE.ShaderLib.standard.fragmentShader,
};
const before = shader.vertexShader;
material.onBeforeCompile(shader, {});

check('vertex shader was modified', shader.vertexShader !== before);
check('uniform block landed', shader.vertexShader.includes('uniform float uSwayAmplitude'));
check('displacement landed', shader.vertexShader.includes('transformed.xz += push'));
check('arc-length correction landed', shader.vertexShader.includes('transformed.y -='));
for (const u of ['uSwayCycle', 'uSwayFlutterCycle', 'uSwayAmplitude', 'uSwayStiffness',
  'uSwayWavelength', 'uSwayDir', 'uSwayFlutter', 'uSwayBend', 'uSwayHeight', 'uSwayUseUv']) {
  check(`uniform ${u} bound`, shader.uniforms[u] !== undefined);
}
// The rates are gone from the shader on purpose: it is handed POSITIONS, which
// is what lets the same GLSL run free or on a musical division. A uniform
// named for a rate reappearing here means someone put the clock back.
check('no rate uniforms survive in the shader',
  !shader.vertexShader.includes('uSwaySpeed') && !shader.vertexShader.includes('uSwayFlutterSpeed'),
  'the shader takes a phase, not a clock and a rate');
// The one that a three.js upgrade breaks silently: vMapUv is declared under
// USE_MAP, and <uv_vertex> must assign it BEFORE <begin_vertex> or the sway
// reads last frame's garbage.
check('three still declares vMapUv under USE_MAP',
  THREE.ShaderChunk.uv_pars_vertex.includes('#ifdef USE_MAP')
  && THREE.ShaderChunk.uv_pars_vertex.includes('varying vec2 vMapUv'));
check('three still assigns vMapUv in <uv_vertex>', THREE.ShaderChunk.uv_vertex.includes('vMapUv ='));
check('<uv_vertex> runs before <begin_vertex>',
  before.indexOf('#include <uv_vertex>') < before.indexOf('#include <begin_vertex>'));
check('the guard matches the varying (USE_MAP, not USE_UV)',
  shader.vertexShader.includes('#ifdef USE_MAP')
  && shader.vertexShader.includes('vMapUv.y'));

// The instancing branch. The seabed bed is nineteen InstancedMeshes, and
// without this every plant of a variant reads the SAME world position (the
// mesh's own matrix, which is the identity) and the whole bed pulses as one
// object — while still swaying, so it looks tuned rather than broken.
check('the instanced world position landed', shader.vertexShader.includes('instanceMatrix * swayLocal'));
check('the direction is carried back through the instance basis',
  shader.vertexShader.includes('instanceMatrix[0].xyz') && shader.vertexShader.includes('instanceMatrix[2].xyz'),
  'or every plant leans its own way');
// Three facts about three.js that the branch above is written against, each of
// which an upgrade could change without anything erroring.
check('three still declares instanceMatrix in the vertex prefix',
  fs.readFileSync(path.join(HERE, '../node_modules/three/src/renderers/webgl/WebGLProgram.js'), 'utf8')
    .includes('attribute mat4 instanceMatrix;'));
check('three still applies instanceMatrix BEFORE modelMatrix',
  THREE.ShaderChunk.worldpos_vertex.indexOf('instanceMatrix * worldPosition')
    < THREE.ShaderChunk.worldpos_vertex.indexOf('modelMatrix * worldPosition'),
  'the sway composes them in that order');
check('the shove attribute is declared', shader.vertexShader.includes('attribute float aShove'));
check('the shove landed in the push', shader.vertexShader.includes('push += shoveDir'));
check('...on its own mask exponent, not the current\'s',
  shader.vertexShader.includes('pow(swayT, uShoveStiffness)'),
  'a body pushing past bends lower down the stem than a current does');
check('uniform uShoveStiffness bound', shader.uniforms.uShoveStiffness !== undefined);
check('three still keys the program on instancing itself',
  fs.readFileSync(path.join(HERE, '../node_modules/three/src/renderers/webgl/WebGLPrograms.js'), 'utf8')
    .includes('parameters.instancing'),
  'which is what makes one customProgramCacheKey safe for both');

// Chaining: an outline shell brings its own onBeforeCompile and it has to live.
let priorRan = false;
const chained = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
chained.onBeforeCompile = (sh) => {
  priorRan = true;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n// PRIOR_EFFECT');
};
attachGrassSway(chained, CLUMP_HEIGHT);
const sh2 = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: '' };
chained.onBeforeCompile(sh2, {});
check('a pre-existing onBeforeCompile still runs', priorRan);
check('its edit survives', sh2.vertexShader.includes('// PRIOR_EFFECT'));
check('and the sway is added on top', sh2.vertexShader.includes('transformed.xz += push'));

// Idempotence: assets.js processes materials on every look rebuild.
const twice = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
attachGrassSway(twice, CLUMP_HEIGHT);
attachGrassSway(twice, CLUMP_HEIGHT);
const sh3 = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: '' };
twice.onBeforeCompile(sh3, {});
const occurrences = sh3.vertexShader.split('transformed.xz += push').length - 1;
check('attaching twice does not stack the displacement', occurrences === 1, `${occurrences} copies`);

// --------------------------------------------------------------------- motion

section('MOTION — the displacement over the real blade vertices');

// A direct port of GLSL_SWAY_BODY. Kept deliberately literal so a change to
// the shader that is not mirrored here shows up as a failing expectation
// rather than as a quietly divergent model.
function swayVertex(px, py, pz, u, v, t, cfg, worldOffset = [0, 0]) {
  const dir = [Math.cos(cfg.direction), Math.sin(cfg.direction)];
  const swayT = Math.min(1, Math.max(0, v));
  const mask = Math.pow(swayT, cfg.stiffness);
  const wx = px + worldOffset[0], wz = pz + worldOffset[1];
  const phase = (wx * dir[0] + wz * dir[1]) * cfg.wavelength + t * cfg.speed;
  const body = Math.sin(phase);
  const flutter = Math.sin(phase * 2.7 + t * cfg.flutterSpeed) * cfg.flutter * swayT;
  const push = [
    dir[0] * (body * cfg.amplitude + flutter) * mask * py,
    dir[1] * (body * cfg.amplitude + flutter) * mask * py,
  ];
  const d = Math.hypot(push[0], push[1]);
  const h = Math.max(py, 0.0001);
  const drop = Math.min(d * d / (2 * h), py) * cfg.bend;
  return [px + push[0], py - drop, pz + push[1]];
}

const cfg = { ...sway };

// Roots: uv.y == 0 must not move at all, at any time. This is the whole point
// of the mask — grass that slides along the seabed reads as broken instantly.
let rootMax = 0, rootCount = 0;
for (let t = 0; t < 6; t += 0.25) {
  for (let i = 0; i < pos.count; i++) {
    if (uv.getY(i) > 0.001) continue;
    rootCount++;
    const [x, y, z] = swayVertex(pos.getX(i), pos.getY(i), pos.getZ(i), uv.getX(i), uv.getY(i), t, cfg);
    rootMax = Math.max(rootMax, Math.hypot(x - pos.getX(i), y - pos.getY(i), z - pos.getZ(i)));
  }
}
check('root vertices exist to test', rootCount > 0, `${rootCount} samples`);
check('roots never move', rootMax < 1e-9, `max ${rootMax.toExponential(2)}`);

// Tips: must actually move, and each by a fraction of ITS OWN height rather
// than a flat distance — that is what keeps short blades from thrashing.
let tipMax = 0, tipCount = 0, worstRatio = 0, tallestTipY = 0;
for (let t = 0; t < 12; t += 0.05) {
  for (let i = 0; i < pos.count; i++) {
    if (uv.getY(i) < 0.999) continue;
    tipCount++;
    const py = pos.getY(i);
    const [x, , z] = swayVertex(pos.getX(i), py, pos.getZ(i), uv.getX(i), uv.getY(i), t, cfg);
    const travel = Math.hypot(x - pos.getX(i), z - pos.getZ(i));
    tipMax = Math.max(tipMax, travel);
    tallestTipY = Math.max(tallestTipY, py);
    if (py > 0.2) worstRatio = Math.max(worstRatio, travel / py);
  }
}
const perHeight = cfg.amplitude + cfg.flutter; // the most one tip can travel, per unit of its height
check('tips move', tipMax > 0, `max ${tipMax.toFixed(3)}`);
check('tallest tip travels the configured fraction of its own height',
  tipMax > cfg.amplitude * tallestTipY * 0.9 && tipMax < perHeight * tallestTipY * 1.05,
  `${tipMax.toFixed(3)} on a ${tallestTipY.toFixed(2)}-tall blade`);
check('no blade exceeds that fraction of its own height (short ones stay stiff)',
  worstRatio <= perHeight * 1.001, `worst ${(worstRatio * 100).toFixed(1)}% vs cap ${(perHeight * 100).toFixed(1)}%`);

// Blade length: the arc-length correction is what stops the grass reading as
// rubber, so measure it rather than trusting the algebra.
//
// Measured from the vertex's OWN base — the point directly below it on the
// seabed — not from the model origin. The origin is the middle of a stand
// 6.4 units across, so distance-from-origin mostly reports how far out the
// blade is planted and says nothing about whether it stretched. That is the
// same "height above the base plane" the shader's correction assumes, so the
// test and the model are measuring one quantity, not two.
const stretchAt = (bend) => {
  let worst = 0;
  for (let t = 0; t < 12; t += 0.1) {
    for (let i = 0; i < pos.count; i++) {
      if (uv.getY(i) < 0.999) continue;
      const py = pos.getY(i);
      if (py < 0.5) continue; // a stub too short for the ratio to mean much
      const [x, y, z] = swayVertex(pos.getX(i), py, pos.getZ(i), uv.getX(i), uv.getY(i), t, { ...cfg, bend });
      const bent = Math.hypot(x - pos.getX(i), y, z - pos.getZ(i));
      worst = Math.max(worst, bent / py - 1);
    }
  }
  return worst;
};

const worstStretch = stretchAt(cfg.bend);
check('blades do not stretch while bending', worstStretch < 0.005,
  `worst +${(worstStretch * 100).toFixed(3)}% of rest length`);

// Without the correction they SHOULD stretch — proving the check above is
// measuring the correction and not simply an amplitude too small to show.
const uncorrected = stretchAt(0);
check('...and they do stretch with bend:0, so the test has teeth',
  uncorrected > worstStretch * 5, `+${(uncorrected * 100).toFixed(3)}% uncorrected`);

// Spatial phase: two clumps standing apart must not bend in lockstep, or the
// field pulses as one object.
const sample = { x: pos.getX(0), y: pos.getY(0), z: pos.getZ(0) };
let maxDivergence = 0;
for (let t = 0; t < 12; t += 0.05) {
  const a = swayVertex(sample.x, CLUMP_HEIGHT, sample.z, 0, 1, t, cfg, [0, 0]);
  const b = swayVertex(sample.x, CLUMP_HEIGHT, sample.z, 0, 1, t, cfg, [9, 0]);
  maxDivergence = Math.max(maxDivergence, Math.abs(a[0] - b[0]));
}
check('clumps 9 units apart bend out of phase', maxDivergence > cfg.amplitude * CLUMP_HEIGHT * 0.5,
  `max separation ${maxDivergence.toFixed(3)}`);

// wavelength 0 is documented as "all in unison" — check that it is.
let unisonDivergence = 0;
for (let t = 0; t < 12; t += 0.05) {
  const a = swayVertex(sample.x, CLUMP_HEIGHT, sample.z, 0, 1, t, { ...cfg, wavelength: 0 }, [0, 0]);
  const b = swayVertex(sample.x, CLUMP_HEIGHT, sample.z, 0, 1, t, { ...cfg, wavelength: 0 }, [9, 0]);
  unisonDivergence = Math.max(unisonDivergence, Math.abs(a[0] - b[0]));
}
check('wavelength 0 puts every clump in unison, as documented', unisonDivergence < 1e-9);

// ----------------------------------------------------------------- the clock
section('CLOCK — free-running and beat-synced');

// The grass ships beat-synced ('2 bars'), which means its phase is DERIVED
// from the beat transport rather than integrated from dt. A harness that never
// ticks updateBeatSync therefore sees it frozen — and so would the game, if the
// call in main.js ever went missing.
const cycleOf = () => material.userData.__swayUniforms.uSwayCycle.value;
CONFIG.grass.sway.speedSync = '2 bars';
applyGrassSettings();
updateGrassSway(0.5);
check('a synced sway does not move on dt alone', cycleOf() === 0,
  'it reads the transport, not the frame time');
updateBeatSync(0.5);
updateGrassSway(0.5);
check('...and does move once the beat clock has been ticked', cycleOf() > 0,
  `cycle ${cycleOf().toFixed(4)}`);

// Free-running is the path swayVertex above mirrors: phase = t * speed, which
// is exactly cycle * 2π once the rate has been divided by 2π. That equivalence
// is why the motion section is still a valid model of the shader.
CONFIG.grass.sway.speedSync = 'free';
applyGrassSettings();
const c0 = cycleOf();
updateGrassSway(0.5);
const advanced = (cycleOf() - c0 + 1) % 1;
check('updateGrassSway advances a free clock', advanced > 0);
check('...at the configured rate', Math.abs(advanced - (0.5 * CONFIG.grass.sway.speed) / (Math.PI * 2)) < 1e-6,
  `${advanced.toFixed(5)} cycles in 0.5s at ${CONFIG.grass.sway.speed} rad/s`);
check('and keeps the phase inside one cycle', cycleOf() >= 0 && cycleOf() < 1);
delete CONFIG.grass.sway.speedSync;

// disabling settles the grass rather than freezing it mid-bend
CONFIG.grass.sway.enabled = false;
applyGrassSettings();
check('disabling zeroes amplitude (blades settle straight)',
  material.userData.__swayUniforms.uSwayAmplitude.value === 0
  && material.userData.__swayUniforms.uSwayFlutter.value === 0);
CONFIG.grass.sway.enabled = true;
applyGrassSettings();

// ---------------------------------------------------------------------- seabed

section('SEABED — plants sway, shells do not');

// WHO. The bed is nineteen props and only the plants move. A shell that
// breathes is the one thing in a seabed that reads as a bug rather than as
// weather, so this is the check that matters most and it is a plain list.
const SHOULD_NOT_SWAY = ['clamshell', 'conchshell', 'bubble', 'cloudcard'];
const swayingSpecies = [];
const stillSpecies = [];
for (const [species, variants] of Object.entries(SEABED_PROPS)) {
  const flags = variants.map((v) => ASSETS[v.id]?.sway === true);
  check(`${species}: every variant agrees on swaying`,
    flags.every((f) => f === flags[0]), `${flags.filter(Boolean).length}/${flags.length}`);
  (flags[0] ? swayingSpecies : stillSpecies).push(species);
}
for (const shell of SHOULD_NOT_SWAY) {
  check(`${shell} does NOT sway`, !swayingSpecies.includes(shell));
}
check('every other species does', stillSpecies.every((s) => SHOULD_NOT_SWAY.includes(s)),
  stillSpecies.join(', ') || 'none left still');
check('the bed is mostly plants', swayingSpecies.length >= 8, `${swayingSpecies.length} swaying`);
// A species turned on in CONFIG.seabed.species but absent from the sway table
// is a plant standing rigid in a field that moves — visible, and easy to leave
// behind when a new prop is added.
const weighted = Object.entries(CONFIG.seabed?.species ?? {}).filter(([, w]) => w > 0).map(([n]) => n);
const rigidInBed = weighted.filter((n) => !swayingSpecies.includes(n) && !SHOULD_NOT_SWAY.includes(n));
check('no scattered species was left out of the sway table', rigidInBed.length === 0, rigidInBed.join(', '));

// HOW. These props share a cropped atlas whose v does not run root-to-tip, so
// they must mask on height. Selecting the wrong one is the failure with no
// symptom but a wrong-looking bend, which is exactly what a test is for.
for (const species of swayingSpecies) {
  for (const v of SEABED_PROPS[species]) {
    check(`${v.id} masks on height, not uv.y`, ASSETS[v.id]?.swayMask === 'height');
  }
}
// ...and the measurement that justifies it. If a re-export ever makes v honest
// root-to-tip this still passes; what it catches is the reverse, someone
// switching the bed to 'uv' because grass uses it.
check('coral is softened relative to the fronds',
  (ASSETS.coral?.swayScale ?? 1) < (ASSETS.kelp?.swayScale ?? 1),
  `coral ${ASSETS.coral?.swayScale} vs kelp ${ASSETS.kelp?.swayScale}`);

// THE SHARED PROGRAM. customProgramCacheKey is pinned to one constant, so every
// sway material reuses the first one's compiled shader. That is only sound
// while the injected SOURCE is byte-identical, which is the whole reason the
// mask is a uniform and not a #define — and the reason this check exists.
const uvMat = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
const hMat = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
attachGrassSway(uvMat, 1, { mask: 'uv' });
attachGrassSway(hMat, 1, { mask: 'height', scale: 0.3 });
const srcOf = (m) => {
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: '' };
  m.onBeforeCompile(sh, {});
  return sh;
};
const uvSh = srcOf(uvMat); const hSh = srcOf(hMat);
check('both masks compile the SAME vertex source', uvSh.vertexShader === hSh.vertexShader,
  'a #define here would hand the second material the first one\'s program');
check('...and differ only in a uniform',
  uvSh.uniforms.uSwayUseUv.value === 1 && hSh.uniforms.uSwayUseUv.value === 0);
check('both keep the one cache key', uvMat.customProgramCacheKey() === hMat.customProgramCacheKey());

applyGrassSettings();
check('swayScale softens amplitude and flutter together',
  Math.abs(hMat.userData.__swayUniforms.uSwayAmplitude.value - CONFIG.grass.sway.amplitude * 0.3) < 1e-9
  && Math.abs(hMat.userData.__swayUniforms.uSwayFlutter.value - CONFIG.grass.sway.flutter * 0.3) < 1e-9);
check('...and leaves an unscaled material alone',
  uvMat.userData.__swayUniforms.uSwayAmplitude.value === CONFIG.grass.sway.amplitude);

// THE HEIGHT. seabedScatter bakes fit, the orientation group and the size
// multiplier into the geometry, so the height assets.js measured off the raw
// model is in the wrong units and the mask would saturate part-way up.
check('setGrassSwayHeight corrects it', (setGrassSwayHeight(hMat, 4.2),
  hMat.userData.__swayUniforms.uSwayHeight.value === 4.2));
check('...and refuses a degenerate one rather than dividing by it',
  (setGrassSwayHeight(hMat, 0), setGrassSwayHeight(hMat, NaN),
    hMat.userData.__swayUniforms.uSwayHeight.value === 4.2));

// MOTION under the height mask, over a real prop's proportions. The seabed
// props are one plant per file with the base at y=0, which is the fact that
// makes height a valid root-to-tip parameter at all.
const KELP_H = SEABED_PROPS.kelp[0].size[1];
const heightSway = (py, t, c, worldOffset = [0, 0], yaw = 0) => {
  // port of the shader with uSwayUseUv = 0 and the instancing branch live
  const swayT = Math.min(1, Math.max(0, py / KELP_H));
  const mask = Math.pow(swayT, c.stiffness);
  const dir = [Math.cos(c.direction), Math.sin(c.direction)];
  // the instance's basis columns for a pure yaw about +Y
  const axisX = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const axisZ = [Math.sin(yaw), 0, Math.cos(yaw)];
  const want = [dir[0], 0, dir[1]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const local = [dot3(want, axisX), dot3(want, axisZ)];
  const phase = (worldOffset[0] * dir[0] + worldOffset[1] * dir[1]) * c.wavelength + t * c.speed;
  const body = Math.sin(phase);
  const flutter = Math.sin(phase * 2.7 + t * c.flutterSpeed) * c.flutter * swayT;
  const amt = (body * c.amplitude + flutter) * mask * py;
  // world push = the instance rotation applied to the local push
  const px = local[0] * amt; const pz = local[1] * amt;
  return [px * axisX[0] + pz * axisZ[0], px * axisX[2] + pz * axisZ[2]];
};

check('a plant\'s root does not move under the height mask',
  Math.hypot(...heightSway(0, 1.3, cfg)) < 1e-12);
let kelpTip = 0;
for (let t = 0; t < 12; t += 0.05) kelpTip = Math.max(kelpTip, Math.hypot(...heightSway(KELP_H, t, cfg)));
check('its tip travels the configured fraction of its own height',
  kelpTip > cfg.amplitude * KELP_H * 0.9 && kelpTip < (cfg.amplitude + cfg.flutter) * KELP_H * 1.05,
  `${kelpTip.toFixed(3)} on a ${KELP_H.toFixed(2)}-tall frond`);

// THE ONE THE COUNTER-ROTATION IS FOR. Every plant in the bed gets a random
// yaw, and an object-space push would send each one a different way in the
// world — a field of plants each leaning on its own, rather than one current.
let worstYawSpread = 0;
for (let t = 0; t < 12; t += 0.1) {
  const straight = heightSway(KELP_H, t, cfg, [0, 0], 0);
  for (const yaw of [0.7, 1.9, -2.4, Math.PI]) {
    const turned = heightSway(KELP_H, t, cfg, [0, 0], yaw);
    worstYawSpread = Math.max(worstYawSpread, Math.hypot(straight[0] - turned[0], straight[1] - turned[1]));
  }
}
check('a plant\'s yaw does not change which way it leans', worstYawSpread < 1e-9,
  `worst ${worstYawSpread.toExponential(2)} world units apart`);
// ...and the same measurement without the counter-rotation, so the check above
// is proving the fix rather than an amplitude too small to show.
const naiveSpread = (() => {
  let worst = 0;
  for (let t = 0; t < 12; t += 0.1) {
    const a = heightSway(KELP_H, t, cfg, [0, 0], 0);
    // object-space push, rotated by the instance: what it did before
    const yaw = Math.PI / 2;
    const amt = Math.hypot(...a);
    const b = [amt * Math.cos(cfg.direction + yaw), amt * Math.sin(cfg.direction + yaw)];
    worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  return worst;
})();
check('...and the uncorrected push really would scatter them', naiveSpread > cfg.amplitude * KELP_H * 0.5,
  `${naiveSpread.toFixed(3)} apart at 90 degrees`);

// ----------------------------------------------------------------- the shove

section('SHOVE — plants pushed aside, and springing back');

// A stand-in bed: three plants in a row, each 2 units tall, standing on y=0.
// Real geometry is not needed — what is under test is the per-plant spring and
// the field that drives it, both of which are plain arithmetic over these
// numbers. The DISPLACEMENT those numbers cause is the shader's half and is
// modelled separately below.
const SHOVE_MAT = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
attachGrassSway(SHOVE_MAT, 2, { mask: 'height' });
const stems = [
  { x: -2, y0: 0, y1: 2 },  // to the left of the source
  { x: 0, y0: 0, y1: 2 },   // directly under it
  { x: 20, y0: 0, y1: 2 },  // far outside the radius
];
const bedMesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), SHOVE_MAT, stems.length);
clearShovedInstances();
registerShovedInstances(bedMesh, stems);
check('the draw registered', shovedInstanceCount() === 1);

const aShove = bedMesh.geometry.getAttribute('aShove');
check('an aShove attribute was created', !!aShove);
check('it is per-INSTANCE, not per-vertex', aShove?.isInstancedBufferAttribute === true,
  'a plain BufferAttribute here indexes by vertex and shoves nothing');
check('one float per plant', aShove?.itemSize === 1 && aShove?.count === stems.length);

const shoveOf = (i) => bedMesh.geometry.getAttribute('aShove').array[i];
const settle = (seconds, at) => {
  for (let t = 0; t < seconds; t += 1 / 60) updateGrassSway(1 / 60, at);
};

// THE ONE THAT WOULD SHIP BROKEN AND SILENT. The shove runs above the sway's
// own `enabled` check, so a saved tuning with the current switched off must
// still part the weeds. Tested FIRST, with the sway off, so every check below
// is also proving that wiring.
const swayWas = CONFIG.grass.sway.enabled;
CONFIG.grass.sway.enabled = false;
applyGrassSettings();

const AT = { x: 0, y: 1 };
settle(2, AT);
check('a plant beside the source is pushed', Math.abs(shoveOf(0)) > 0.01, shoveOf(0).toFixed(4));
check('...even with the ambient current switched off', CONFIG.grass.sway.enabled === false,
  'the two forces have separate switches on purpose');
check('it is pushed AWAY from the source', shoveOf(0) < 0,
  `plant at x=-2, source at x=0, shove ${shoveOf(0).toFixed(4)}`);
check('a plant far outside the radius is untouched', Math.abs(shoveOf(2)) < 1e-6, shoveOf(2).toExponential(2));
check('a plant the source is directly over is barely pushed sideways',
  Math.abs(shoveOf(1)) < Math.abs(shoveOf(0)) * 0.2,
  `${shoveOf(1).toFixed(4)} vs ${shoveOf(0).toFixed(4)} beside it — it is passed over, not shouldered`);

// The push is bounded by what the config asked for. A spring under 1 damping
// overshoots on the way IN as well, so the allowance is the overshoot, not a
// free multiplier — see the note in memory about asserting the multiplier.
const peak = Math.abs(shoveOf(0));
check('the settled push is at most the configured strength',
  peak <= CONFIG.grass.shove.strength * 1.001,
  `${peak.toFixed(4)} vs strength ${CONFIG.grass.shove.strength}`);

// FEATHERED. Two plants at different distances inside the radius must differ,
// or the "radius" is a hard disc with a step at its edge.
clearShovedInstances();
const ramp = [{ x: 1, y0: 0, y1: 2 }, { x: 2.5, y0: 0, y1: 2 }, { x: 3.8, y0: 0, y1: 2 }];
const rampMesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), SHOVE_MAT, ramp.length);
registerShovedInstances(rampMesh, ramp);
settle(2, { x: 0, y: 1 });
const r = [0, 1, 2].map((i) => rampMesh.geometry.getAttribute('aShove').array[i]);
check('the push falls off with distance', r[0] > r[1] && r[1] > r[2],
  r.map((v) => v.toFixed(4)).join(' > '));
check('...and reaches nearly nothing at the rim', r[2] < r[0] * 0.2,
  `rim ${r[2].toFixed(4)} vs near ${r[0].toFixed(4)}`);

// A TALL PLANT IS A STEM, NOT A POINT. The bed runs 0.4x to 2.1x, so a frond's
// tip can be five units above its root. A seal swimming past that tip has to
// reach it, and measuring every plant from its base is how it would not.
clearShovedInstances();
const tallMesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), SHOVE_MAT, 2);
registerShovedInstances(tallMesh, [
  { x: 1, y0: 0, y1: 5 },   // tall frond, tip up at y=5
  { x: 1, y0: 0, y1: 0.5 }, // seedling beside it
]);
settle(2, { x: 0, y: 4.5 }); // level with the frond's tip, far above the seedling
const tall = tallMesh.geometry.getAttribute('aShove').array;
check('a seal at the tip of a tall frond still moves it', Math.abs(tall[0]) > 0.05, tall[0].toFixed(4));
check('...while the seedling under it is out of reach', Math.abs(tall[1]) < Math.abs(tall[0]) * 0.2,
  `${tall[1].toFixed(4)} vs ${tall[0].toFixed(4)}`);

// SETTLING BACK — the whole point of holding state at all. Three separate
// claims, and the middle one is what separates a spring from a fade.
clearShovedInstances();
const oneMesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), SHOVE_MAT, 1);
registerShovedInstances(oneMesh, [{ x: -2, y0: 0, y1: 2 }]);
const one = () => oneMesh.geometry.getAttribute('aShove').array[0];
settle(2, AT);
const held = one();
check('it holds its bend while the source stays', Math.abs(held) > 0.01, held.toFixed(4));

// Sampled every frame after the source leaves, because "it overshoots" is a
// claim about the PATH and the endpoint alone cannot tell you.
const trace = [];
for (let t = 0; t < 3; t += 1 / 60) { updateGrassSway(1 / 60, null); trace.push(one()); }
check('it comes back to upright', Math.abs(trace[trace.length - 1]) < 1e-3,
  `${trace[trace.length - 1].toExponential(2)} after 3s`);
const crossed = trace.some((v) => Math.sign(v) === -Math.sign(held) && Math.abs(v) > 1e-4);
check('it overshoots on the way, rather than sliding to a stop', crossed,
  `springDamping ${CONFIG.grass.shove.springDamping} is under 1 — a fade would never cross zero`);
// ...and it is a settle, not a snap: still visibly bent a couple of frames later.
check('the recovery takes time', Math.abs(trace[3]) > Math.abs(held) * 0.5,
  `${trace[3].toFixed(4)} four frames after the source left, from ${held.toFixed(4)}`);
// THE UPLOAD, and its other half. A moving plant has to reach the GPU every
// frame; a bed that is upright with nothing near it must stop paying for one.
// Read off `version`, not `needsUpdate` — three's needsUpdate is a write-only
// setter that bumps version, and reading it back gives undefined, so an
// `=== true` assertion on it fails no matter what the code does.
const versionOf = () => oneMesh.geometry.getAttribute('aShove').version;
settle(0.4, AT);
const movingFrom = versionOf();
updateGrassSway(1 / 60, AT);
check('a moving plant uploads every frame', versionOf() > movingFrom);
settle(3, null);
const restingFrom = versionOf();
settle(0.5, null);
check('a bed at rest with nothing near it stops uploading', versionOf() === restingFrom,
  'the sleep is the only reason a per-plant buffer is affordable here');
// ...and wakes again the moment something arrives, or the first plant the seal
// swims into never moves.
updateGrassSway(1 / 60, AT);
check('...and wakes the moment the seal comes back', versionOf() > restingFrom);
settle(2, null);

// SWITCHING IT OFF SETTLES THE BED rather than freezing it mid-bend — the same
// contract the sway's `enabled` has, and the reason strength folds into the
// target instead of skipping the loop.
settle(2, AT);
check('bent again', Math.abs(one()) > 0.01);
CONFIG.grass.shove.enabled = false;
settle(3, AT); // source still there, but the force is off
check('disabling settles the plants rather than freezing them', Math.abs(one()) < 1e-3,
  one().toExponential(2));
CONFIG.grass.shove.enabled = true;

// STABILITY. dt here is the WALL clock, so an alt-tab, a GC pause or the first
// frame after a model load all hand this a step far bigger than a frame. A
// spring integrated over that in one go does not lag — it diverges, and a bed
// of NaN vertices renders as nothing.
updateGrassSway(2.5, AT);
updateGrassSway(0.9, null);
check('a huge dt does not blow the spring up', Number.isFinite(one()) && Math.abs(one()) < 1,
  `${one().toFixed(4)} after a 2.5s step`);
settle(3, null);
check('...and it still comes back afterwards', Math.abs(one()) < 1e-3, one().toExponential(2));

// A REBUILD DROPS THE OLD BED. scatterSeabed runs again on every resize and
// every tuner move of the floor; a registry that kept the old meshes would
// integrate springs against geometry nobody is drawing any more, forever.
clearShovedInstances();
check('clearing drops every registered draw', shovedInstanceCount() === 0);
updateGrassSway(1 / 60, AT); // must not throw with nothing registered

CONFIG.grass.sway.enabled = swayWas;
applyGrassSettings();

// THE DISPLACEMENT the attribute causes, as a port of the shader's shove term.
// Kept literal for the same reason the sway's port is: a change to the GLSL
// that is not mirrored here fails a stated expectation instead of quietly
// modelling a different shader.
section('SHOVE — the displacement it causes');
const shoveVertex = (py, height, shove, yaw = 0) => {
  const swayT = Math.min(1, Math.max(0, py / height));
  const m = Math.pow(swayT, CONFIG.grass.shove.stiffness);
  // world +X carried into the instance's space, then back out again
  const axisX = [Math.cos(yaw), -Math.sin(yaw)]; // (x, z) of the normalised column
  const axisZ = [Math.sin(yaw), Math.cos(yaw)];
  const local = [axisX[0], axisZ[0]];
  const amt = shove * m * py;
  const px = local[0] * amt; const pz = local[1] * amt;
  // world x, world z
  return [px * axisX[0] + pz * axisZ[0], px * axisX[1] + pz * axisZ[1]];
};
check('the root does not move under a shove', Math.hypot(...shoveVertex(0, 2, 0.35)) < 1e-12);
const tip = shoveVertex(2, 2, 0.35);
check('the tip moves by the configured fraction of its height', Math.abs(tip[0] - 0.35 * 2) < 1e-9,
  `${tip[0].toFixed(4)} on a 2-unit plant`);
check('...and stays in the plane of the screen', Math.abs(tip[1]) < 1e-9,
  'a shove along world Z is invisible in a side view, so there is none');
let yawSpread = 0;
for (const yaw of [0.6, 2.2, -1.4, Math.PI]) {
  const t2 = shoveVertex(2, 2, 0.35, yaw);
  yawSpread = Math.max(yawSpread, Math.hypot(t2[0] - tip[0], t2[1] - tip[1]));
}
check('a plant\'s random yaw does not change which way it is shoved', yawSpread < 1e-9,
  `worst ${yawSpread.toExponential(2)} apart`);
check('the shove bends lower down the stem than the current does',
  CONFIG.grass.shove.stiffness < CONFIG.grass.sway.stiffness,
  `shove ${CONFIG.grass.shove.stiffness} vs sway ${CONFIG.grass.sway.stiffness}`);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
