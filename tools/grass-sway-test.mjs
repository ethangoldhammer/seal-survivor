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
import { attachGrassSway, applyGrassSettings, updateGrassSway } from '../path/src/systems/grassSway.js';
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
  'uSwayWavelength', 'uSwayDir', 'uSwayFlutter', 'uSwayBend', 'uSwayHeight']) {
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

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
