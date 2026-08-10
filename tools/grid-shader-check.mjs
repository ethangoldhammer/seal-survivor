#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Writes a standalone page that COMPILES the grid's two shaders against a real
// WebGL driver and prints the driver's own error log.
//
// It exists because nothing else in the test suite can do this. A Node harness
// can check that every uniform the shader declares is supplied and that the
// numbers reaching them are right — see tools/touch-glow-test.mjs — and still
// sail straight past a GLSL type error, which takes the whole backdrop out.
//
// The page deliberately touches NOTHING else: no config.js, no dev server, no
// tuning file. It pulls the two shader strings out of systems/grid.js (the real
// ones, off the built material) and hands them to the driver with the same
// prelude three.js would, and that is all it does.
//
//   node --import ./tools/vite-loader.mjs tools/grid-shader-check.mjs
//   → open the printed file:// path
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createGrid } from '../path/src/systems/grid.js';

const scene = new THREE.Scene();
createGrid(scene);
const mat = scene.children.find((c) => c.isLineSegments).material;

const OUT = process.argv[2] ?? path.join(
  path.dirname(fileURLToPath(import.meta.url)), '../.grid-shader-check.html'
);

// three's own prefix, cut down to what these two shaders actually reference.
const PREFIX_VERT = `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
`;
const PREFIX_FRAG = `precision highp float;
`;

const html = `<!doctype html><meta charset="utf-8"><title>grid shader check</title>
<body style="font:14px ui-monospace,monospace;background:#111;color:#ddd;padding:16px">
<pre id="out">compiling...</pre>
<script>
const SRC = ${JSON.stringify({
  vertex: PREFIX_VERT + mat.vertexShader,
  fragment: PREFIX_FRAG + mat.fragmentShader,
})};
const gl = document.createElement('canvas').getContext('webgl');
const lines = [];
let bad = 0;
function compile(kind, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
  if (!ok) bad++;
  lines.push((ok ? 'PASS  ' : 'FAIL  ') + kind + ' shader compiled');
  const log = (gl.getShaderInfoLog(s) || '').trim();
  if (log) lines.push(log.replace(/^/gm, '      '));
  return ok ? s : null;
}
const vs = compile('vertex', gl.VERTEX_SHADER, SRC.vertex);
const fs = compile('fragment', gl.FRAGMENT_SHADER, SRC.fragment);
if (vs && fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
  if (!ok) bad++;
  lines.push((ok ? 'PASS  ' : 'FAIL  ') + 'program linked');
  const log = (gl.getProgramInfoLog(p) || '').trim();
  if (log) lines.push(log.replace(/^/gm, '      '));
  if (ok) {
    // The uniforms the driver kept. A finger uniform missing here means the
    // shader optimised the whole touch path out — i.e. it does nothing.
    const names = [];
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      names.push(gl.getActiveUniform(p, i).name);
    }
    for (const want of ['uTouch[0]', 'uTouchColor[0]', 'uTouchWarp', 'uTouchGain']) {
      const live = names.some((n) => n === want || n === want.replace('[0]', ''));
      if (!live) bad++;
      lines.push((live ? 'PASS  ' : 'FAIL  ') + want + ' survived into the linked program');
    }
  }
}
lines.push('');
lines.push(bad === 0 ? 'ALL SHADER CHECKS PASSED' : bad + ' SHADER CHECK(S) FAILED');
document.getElementById('out').textContent = lines.join('\\n');
</script>
`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
console.log(`open file://${path.resolve(OUT)}`);
