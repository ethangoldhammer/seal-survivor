#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Writes a standalone page that COMPILES the water fill's two shaders against a
// real WebGL driver and prints the driver's own error log.
//
// Same job as tools/grid-shader-check.mjs and tools/sky-shader-check.mjs, and
// it exists for the same reason: a Node harness can prove every uniform is
// declared and supplied and that the numbers reaching them are right, and still
// sail straight past a GLSL type error — which does not draw a broken ocean, it
// draws no ocean at all.
//
// The fill is worth its own check because its fragment shader is BUILT, not
// written: systems/water.js interpolates the WAVE constants out of arena.js
// into surfaceAt() at module load, so a constant that happens to be whole
// arrives as an int literal and fails to compile in a file nobody edited.
//
// It also asserts that the absorption uniforms survive into the linked program.
// Their whole path sits behind `if (uAbsorbMix > 0.0)`, and the shipped default
// is 0 — so a driver that decided to fold the branch away would leave the tuner
// pushing values at a uniform the program no longer has, and the slider would
// do nothing for reasons invisible from the JS side.
//
// The page touches nothing else: no config.js at runtime, no dev server, no
// tuning file. The shader strings are baked into it at generation time.
//
//   node --import ./tools/vite-loader.mjs tools/water-shader-check.mjs [out.html]
//   → serve the directory over http and open it (file:// will not execute)
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWaterMaterial } from '../path/src/systems/water.js';

const mat = createWaterMaterial();

const OUT = process.argv[2] ?? path.join(
  path.dirname(fileURLToPath(import.meta.url)), '../.water-shader-check.html'
);

// three's own prefix, cut down to what these two shaders actually reference.
const PREFIX_VERT = `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
`;
const PREFIX_FRAG = `precision highp float;
`;

// Uniforms that must still be live after linking. The absorption pair is the
// point of the list; the rest are here so that a shader edit which quietly
// drops the caustics or the beams shows up as a failure rather than as a
// darker ocean somebody notices a week later.
const MUST_SURVIVE = [
  'uAbsorbMix', 'uAbsorb',
  'uShallow', 'uMid', 'uDeep', 'uStop1', 'uStop2',
  'uCausticsOn', 'uRayOn', 'uWaveAmp', 'uChop',
];

const html = `<!doctype html><meta charset="utf-8"><title>water shader check</title>
<body style="font:14px ui-monospace,monospace;background:#111;color:#ddd;padding:16px">
<pre id="out">compiling...</pre>
<script>
const SRC = ${JSON.stringify({
  vertex: PREFIX_VERT + mat.vertexShader,
  fragment: PREFIX_FRAG + mat.fragmentShader,
})};
const MUST_SURVIVE = ${JSON.stringify(MUST_SURVIVE)};
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
    const names = [];
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      names.push(gl.getActiveUniform(p, i).name);
    }
    for (const want of MUST_SURVIVE) {
      const live = names.some((n) => n === want || n === want + '[0]');
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
console.log('serve the directory over http and open it — file:// will not execute');
