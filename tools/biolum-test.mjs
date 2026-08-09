#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:biolum
//
// Checks the bioluminescence system without a GL context.
//
// Two halves, and the second is the one that matters:
//
//   PARAMETERISATION  the per-vertex (channel, param) attributes it bakes.
//                     These are plain arithmetic over geometry and skin
//                     weights, so they are fully checkable here — including
//                     the property the whole design rests on, that `param` is
//                     normalised 0..1 regardless of mesh size.
//
//   INJECTION         that the GLSL actually lands. Every hook is a string
//                     replace against three.js's own shader chunks, and a
//                     replace that finds nothing is a silent no-op: the
//                     material compiles perfectly and simply never glows.
//                     That is the failure a three.js upgrade causes, and it
//                     would otherwise only ever be found by eye. So the test
//                     runs onBeforeCompile against the REAL ShaderLib source
//                     and asserts the uniforms and the glow code are present
//                     afterwards.
//
// What it cannot tell you: whether the glow looks good. That is a screenshot.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { attachBioluminescence } from '../path/src/systems/bioluminescence.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// A strip of `segments` vertices skinned one-per-bone down a chain — the
// simplest thing with the shape of a tentacle.
function makeLimb(segments, chains, scale = 1) {
  const bones = [];
  const names = [];
  chains.forEach((chainNames) => {
    chainNames.forEach((n) => {
      const b = new THREE.Bone();
      b.name = n;
      bones.push(b);
      names.push(n);
    });
  });

  const total = chains.reduce((a, c) => a + c.length, 0);
  const pos = [];
  const skinIndex = [];
  const skinWeight = [];
  for (let i = 0; i < total; i++) {
    pos.push(i * scale, 0, 0);
    skinIndex.push(i, 0, 0, 0);
    skinWeight.push(1, 0, 0, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  mesh.bind(new THREE.Skeleton(bones));
  const root = new THREE.Group();
  root.add(mesh);
  return { root, mesh };
}

// --- parameterisation ------------------------------------------------------
section('PARAMETERISATION (boneChains)');
const chains = [
  ['a0', 'a1', 'a2', 'a3'],
  ['b0', 'b1', 'b2', 'b3'],
];
const { root, mesh } = makeLimb(4, chains);
const handle = attachBioluminescence(root, {
  channels: 2,
  source: { type: 'boneChains', chains },
  tag: 'test',
});

check('it attached', !!handle);
const ch = mesh.geometry.attributes.aGlowChannel;
const pm = mesh.geometry.attributes.aGlowParam;
check('a channel attribute was baked', !!ch, ch ? `${ch.count} verts` : '');
check('a param attribute was baked', !!pm);

const chanOf = (i) => ch.getX(i);
const paramOf = (i) => pm.getX(i);
check('chain 0 vertices land on channel 0',
  [0, 1, 2, 3].every((i) => chanOf(i) === 0));
check('chain 1 vertices land on channel 1',
  [4, 5, 6, 7].every((i) => chanOf(i) === 1));
// The core contract: 0 at the base, 1 at the tip, for every chain.
check('param runs 0 at the base to 1 at the tip',
  paramOf(0) === 0 && paramOf(3) === 1 && paramOf(4) === 0 && paramOf(7) === 1,
  `[${paramOf(0)}, ${paramOf(1)}, ${paramOf(2)}, ${paramOf(3)}]`);

// Size independence — the entire reason `param` is normalised at build time.
const big = makeLimb(4, chains, 1000);
attachBioluminescence(big.root, { channels: 2, source: { type: 'boneChains', chains }, tag: 'test' });
const bigParam = big.mesh.geometry.attributes.aGlowParam;
check('a 1000x larger mesh produces identical params',
  [0, 1, 2, 3].every((i) => Math.abs(bigParam.getX(i) - paramOf(i)) < 1e-6),
  'normalised, so any mesh size works unchanged');

// --- other sources ---------------------------------------------------------
section('OTHER SOURCES');
function plainMesh(scale = 1) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [0, 0, 0, 0, 1 * scale, 0, 0, 2 * scale, 0, 0, 3 * scale, 0], 3));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  const g = new THREE.Group(); g.add(m);
  return { root: g, mesh: m };
}
const ax = plainMesh(7);
attachBioluminescence(ax.root, { channels: 1, source: { type: 'axis', axis: 'y' }, tag: 'ax' });
const axP = ax.mesh.geometry.attributes.aGlowParam;
check('axis source normalises 0..1', axP.getX(0) === 0 && axP.getX(3) === 1,
  `${axP.getX(0)} .. ${axP.getX(3)}`);

const rad = plainMesh(5);
attachBioluminescence(rad.root, { channels: 1, source: { type: 'radial', origin: [0, 0, 0] }, tag: 'rad' });
const radP = rad.mesh.geometry.attributes.aGlowParam;
check('radial source normalises 0..1', radP.getX(0) === 0 && radP.getX(3) === 1);

// --- intensity plumbing ----------------------------------------------------
section('INTENSITY');
const u = handle.uniforms.uGlowIntensity.value;
handle.setAll(0);
handle.setChannel(1, 0.8);
check('setChannel writes only its own channel', u[0] === 0 && Math.abs(u[1] - 0.8) < 1e-6,
  `[${u[0]}, ${u[1]}]`);
handle.setChannel(99, 1);
check('an out-of-range channel is ignored', u.length === 2);
const t0 = handle.uniforms.uGlowTime.value;
handle.update(0.5);
check('update advances the shimmer clock', handle.uniforms.uGlowTime.value > t0);

// --- INJECTION against real three.js source --------------------------------
section('SHADER INJECTION (against real three.js chunks)');
for (const [label, libKey] of [['lit (standard)', 'standard'], ['unlit (basic)', 'basic']]) {
  const mat = libKey === 'basic' ? new THREE.MeshBasicMaterial() : new THREE.MeshStandardMaterial();
  const probe = makeLimb(4, chains);
  probe.mesh.material = mat;
  const h = attachBioluminescence(probe.root, {
    channels: 2, source: { type: 'boneChains', chains }, tag: `inject-${libKey}`,
  });

  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib[libKey].vertexShader,
    fragmentShader: THREE.ShaderLib[libKey].fragmentShader,
  };
  mat.onBeforeCompile(shader, {});

  check(`${label}: uniforms reached the shader`,
    !!shader.uniforms.uGlowIntensity && !!shader.uniforms.uGlowColor);
  check(`${label}: vertex hook landed`,
    shader.vertexShader.includes('attribute float aGlowParam') &&
    shader.vertexShader.includes('vGlowLevel = uGlowIntensity[i]'));
  check(`${label}: fragment hook landed`,
    shader.fragmentShader.includes('uGlowColor') &&
    shader.fragmentShader.includes('gl_FragColor.rgb += uGlowColor'));
  // The channel count is baked into the array declaration, so a mismatch here
  // is a shader that will not compile at all.
  check(`${label}: channel count baked into the array`,
    shader.vertexShader.includes('uniform float uGlowIntensity[2]'));
  check(`${label}: no GLOW_CHANNELS placeholder survived`,
    !shader.vertexShader.includes('GLOW_CHANNELS'));
  h?.dispose();
}

// --- composing with an existing onBeforeCompile ----------------------------
section('COMPOSITION');
// Outline shells and the wreck dissolve already own onBeforeCompile. Glow must
// chain onto them, not replace them — a stomped callback is another silent
// failure, this time in someone else's effect.
const composed = new THREE.MeshStandardMaterial();
let previousRan = false;
composed.onBeforeCompile = (sh) => {
  previousRan = true;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n// PRIOR_EFFECT');
};
const cprobe = makeLimb(4, chains);
cprobe.mesh.material = composed;
attachBioluminescence(cprobe.root, { channels: 2, source: { type: 'boneChains', chains }, tag: 'compose' });
const sh2 = {
  uniforms: {},
  vertexShader: THREE.ShaderLib.standard.vertexShader,
  fragmentShader: THREE.ShaderLib.standard.fragmentShader,
};
composed.onBeforeCompile(sh2, {});
check('the pre-existing onBeforeCompile still ran', previousRan);
check('its edit survived', sh2.vertexShader.includes('// PRIOR_EFFECT'));
check('and the glow was added on top', sh2.vertexShader.includes('aGlowParam'));

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
