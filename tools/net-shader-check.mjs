#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Writes a standalone page that COMPILES the twine's two shaders against a real
// WebGL driver and prints the driver's own error log.
//
// Same reason as tools/grid-shader-check.mjs, which this is modelled on:
// nothing else in the suite can do it. tools/bakalar-net-test.mjs checks that
// every uniform the material declares is read and that the sim moves the mesh
// the way it should, and it would sail straight past a GLSL type error — which
// renders NOTHING, silently, with no exception anywhere in JS.
//
// The page touches nothing else: no config, no dev server, no tuning file. It
// pulls the two real strings off the built material and hands them to the
// driver with the prelude three.js would.
//
//   node --import ./tools/vite-loader.mjs tools/net-shader-check.mjs
//   → serve the printed file over http://localhost and open it. A file:// URL
//     never executes in the Browser pane and 127.0.0.1 is blocked.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createBakalarNet } from '../path/src/systems/bakalarNet.js';

const scene = new THREE.Scene();
createBakalarNet(scene);
const mat = scene.children.find((c) => c.isLineSegments).material;

const OUT = process.argv[2] ?? path.join(
  path.dirname(fileURLToPath(import.meta.url)), '../.net-shader-check.html'
);

// three's own prefix, cut down to what these two shaders actually reference.
const PREFIX_VERT = `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
`;
const PREFIX_FRAG = `precision highp float;
`;

const html = `<!doctype html><meta charset="utf-8"><title>bakalar net shader check</title>
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
    // What the driver KEPT. The warp attribute is the one that matters: it is
    // the only thing making this look like the arena's lattice rather than a
    // flat wireframe, and a shader that never reads it links perfectly and
    // draws a perfectly good net in one colour.
    const uniforms = [];
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      uniforms.push(gl.getActiveUniform(p, i).name);
    }
    for (const want of ['uColor', 'uHotColor', 'uOpacity', 'uWarpGain']) {
      const live = uniforms.includes(want);
      if (!live) bad++;
      lines.push((live ? 'PASS  ' : 'FAIL  ') + want + ' survived into the linked program');
    }
    const attrs = [];
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) {
      attrs.push(gl.getActiveAttrib(p, i).name);
    }
    const warpLive = attrs.includes('aWarp');
    if (!warpLive) bad++;
    lines.push((warpLive ? 'PASS  ' : 'FAIL  ') + 'aWarp survived (the heat, not a flat wireframe)');
  }
}
lines.push('');
lines.push(bad === 0 ? 'ALL SHADER CHECKS PASSED' : bad + ' SHADER CHECK(S) FAILED');
document.getElementById('out').textContent = lines.join('\\n');
</script>
`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
console.log(`serve it over http://localhost and open ${path.basename(OUT)}`);
