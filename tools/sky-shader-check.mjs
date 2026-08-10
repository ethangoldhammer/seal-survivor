#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Writes a standalone page that COMPILES the night sky's shaders against a real
// WebGL driver and prints the driver's own error log.
//
// Same job as tools/grid-shader-check.mjs, and it exists for the same reason:
// tools/constellation-test.mjs can check that every uniform is supplied and
// that the numbers reaching them are right, and still sail straight past a GLSL
// type error that takes the whole backdrop out. Three programs are covered
// because all three share source that would otherwise only be exercised at
// runtime, at night:
//
//   stars / links  systems/constellations.js — two programs off one shared
//                  bloom chunk, and they are ASYMMETRIC on purpose: only the
//                  link program compiles the warp, because the stars are fixed
//                  points. The uniform lists below encode that, so a driver
//                  keeping uRipples alive in the star program is a real
//                  failure rather than a curiosity.
//   sky            systems/sky.js — it now includes systems/starField.js's
//                  GLSL rather than carrying its own hash, and this is what
//                  proves that swap compiles.
//
// The page touches nothing else: no config.js at runtime, no dev server, no
// tuning file. The shader strings are baked into it at generation time.
//
//   node --import ./tools/vite-loader.mjs tools/sky-shader-check.mjs [out.html]
//   → serve the directory over http and open it (file:// will not execute)
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createConstellations } from '../path/src/systems/constellations.js';
import { createSkyMaterial } from '../path/src/systems/sky.js';

const scene = new THREE.Scene();
const sky = createConstellations(scene);
const starMat = sky.group.children.find((c) => c.isMesh && !c.isLineSegments)?.material;
const linkMat = sky.group.children.find((c) => c.isLineSegments)?.material;
const skyMat = createSkyMaterial();

if (!starMat || !linkMat) {
  console.error('constellations built no geometry — is CONFIG.constellations.enabled off?');
  process.exit(1);
}

const OUT = process.argv[2] ?? path.join(
  path.dirname(fileURLToPath(import.meta.url)), '../.sky-shader-check.html'
);

// three's own prefix, cut down to what these shaders actually reference.
const PREFIX_VERT = `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
attribute vec2 uv;
`;
const PREFIX_FRAG = `precision highp float;
`;

// Uniforms that MUST survive linking. A driver drops anything it can prove has
// no effect on the output, so a name missing here is not a cosmetic warning —
// it means that whole path compiled to nothing and the feature does not exist.
//
// The stars deliberately do NOT list uRipples/uTouch: they are fixed points and
// their program never compiles the warp at all. If those ever show up in a
// linked star program, something has re-wired the displacement into the one
// place it must not be.
const PROGRAMS = [
  ['stars', starMat, ['uCycle', 'uBloom', 'uSize', 'uNight', 'uHaze']],
  ['links', linkMat, ['uRipples[0]', 'uTouch[0]', 'uCycle', 'uTravel', 'uBend', 'uBendMax', 'uWarpGain', 'uNight']],
  ['sky gradient', skyMat, ['uStars', 'uStarDensity', 'uZenith', 'uHorizon']],
];

const html = `<!doctype html><meta charset="utf-8"><title>night sky shader check</title>
<body style="font:14px ui-monospace,monospace;background:#111;color:#ddd;padding:16px">
<pre id="out">compiling...</pre>
<script>
const PROGRAMS = ${JSON.stringify(PROGRAMS.map(([name, mat, want]) => ({
  name,
  want,
  vertex: PREFIX_VERT + mat.vertexShader,
  fragment: PREFIX_FRAG + mat.fragmentShader,
})))};
const gl = document.createElement('canvas').getContext('webgl');
const lines = [];
let bad = 0;
function compile(label, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
  if (!ok) bad++;
  lines.push((ok ? 'PASS  ' : 'FAIL  ') + label + ' compiled');
  const log = (gl.getShaderInfoLog(s) || '').trim();
  if (log) lines.push(log.replace(/^/gm, '      '));
  return ok ? s : null;
}
for (const prog of PROGRAMS) {
  lines.push('');
  lines.push('--- ' + prog.name + ' ---');
  const vs = compile(prog.name + ' vertex', gl.VERTEX_SHADER, prog.vertex);
  const fs = compile(prog.name + ' fragment', gl.FRAGMENT_SHADER, prog.fragment);
  if (!vs || !fs) continue;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
  if (!ok) bad++;
  lines.push((ok ? 'PASS  ' : 'FAIL  ') + prog.name + ' linked');
  const log = (gl.getProgramInfoLog(p) || '').trim();
  if (log) lines.push(log.replace(/^/gm, '      '));
  if (!ok) continue;
  const names = [];
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    names.push(gl.getActiveUniform(p, i).name);
  }
  for (const want of prog.want) {
    const live = names.some((n) => n === want || n === want.replace('[0]', ''));
    if (!live) bad++;
    lines.push((live ? 'PASS  ' : 'FAIL  ') + want + ' survived into the linked program');
  }
}
lines.push('');
lines.push(bad === 0 ? 'ALL SHADER CHECKS PASSED' : bad + ' SHADER CHECK(S) FAILED');
document.getElementById('out').textContent = lines.join('\\n');
</script>
`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
console.log(`serve its directory over http and open it — file:// will not run the script`);
