#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE OUTLINE SHELL'S VERTEX SHADER, THROUGH A REAL COMPILER.
//
//   npm run outline:glsl
//   → serve the printed file over http://localhost and open it. A file:// URL
//     never executes in the Browser pane and 127.0.0.1 is blocked.
//
// A GLSL error here renders NOTHING and throws NOTHING: every outlined creature
// in the game simply loses its rim, every Node harness goes on passing, and the
// first anybody knows is that the sharks are hard to find. The shell's shader is
// not written as a string in one place — it is three's own MeshBasicMaterial
// vertex shader with two `.replace` patches spliced into it (assets.js
// makeOutlineMaterial), which means it can also break because THREE renamed a
// chunk, not only because somebody typed badly.
//
// So this assembles the real thing: the real ShaderLib source, the real
// patches read off the real material, three's own #include resolution, and the
// prefix a WebGLProgram would put in front of it — then hands that to a driver.
//
// SKINNING IS NOT COMPILED HERE, deliberately, and the reason is worth knowing
// rather than discovering: the skinned variant needs a GLSL ES 3.00 prefix and
// a bone texture's worth of uniforms to assemble, and the only lines this file
// exists to check are the injected ones, which are identical in both variants
// and touch nothing skinning declares. What it costs is that a patch which
// broke ONLY under USE_SKINNING would pass — the offset's placement before
// <skinning_vertex> is the thing that would do it, and that is covered by
// tools/verify-creature-outline.mjs measuring where the hull actually lands.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { makeOutlineMaterial } from '../path/src/assets.js';

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '.outline-shader-check.html',
);

let bad = 0;
const lines = [];
const check = (label, ok, note = '') => {
  if (!ok) bad++;
  lines.push((ok ? 'ok   ' : 'FAIL ') + label + (note ? ` — ${note}` : ''));
};

// THE REAL PATCHES, off the real material. onBeforeCompile is handed the same
// shape three hands it — the stock basic shader plus a uniforms bag — so what
// comes back is exactly what the renderer would have compiled.
const material = makeOutlineMaterial({ color: 0xff7a3d, thickness: 0.05 });
const shader = {
  uniforms: {},
  vertexShader: THREE.ShaderLib.basic.vertexShader,
  fragmentShader: THREE.ShaderLib.basic.fragmentShader,
};
check('makeOutlineMaterial patches the shader', typeof material.onBeforeCompile === 'function');
material.onBeforeCompile(shader);

// The patches are `.replace` calls against chunk names, and a replace that
// matches nothing is a no-op that leaves a perfectly valid shader drawing a
// creature with no rim. So the presence of the injected text is checked before
// the compiler ever sees it, which is the failure mode a driver cannot report.
check('the offset was spliced in', /transformed \+= aOutlineNormal/.test(shader.vertexShader));
check('the width uniform was declared', /uniform float uOutline;/.test(shader.vertexShader));
check('the screen-space factor was declared', /uniform vec2 uOutlineView;/.test(shader.vertexShader));
check('...and is read by the offset', /uOutlineView\.x \+ uOutlineView\.y/.test(shader.vertexShader));
check('the welded normal is declared', /attribute vec3 aOutlineNormal;/.test(shader.vertexShader));
// Both uniform objects reach the shader BY REFERENCE, which is the whole of how
// a width set before the first frame lands and how one write a frame retunes
// every rim in the scene at once. A copy would test green here and be inert.
check('uOutline is the material’s own object',
  shader.uniforms.uOutline === material.userData.__outlineThickness);
// ...and the screen-space factor is the OPPOSITE: one object for the whole
// game, which is what lets a single write a frame rescale every rim in the
// scene without a registry of who is wearing one. A per-material copy would
// leave every static rim prepareModel built stuck at the identity.
const second = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: '' };
makeOutlineMaterial({}).onBeforeCompile(second);
check('uOutlineView is SHARED across materials', second.uniforms.uOutlineView === shader.uniforms.uOutlineView);

// three's own resolution, reimplemented rather than imported because it is not
// exported. An unknown chunk name resolves to nothing in three too — it would
// simply delete the line — so it is called out here instead.
const missing = [];
function resolveIncludes(src) {
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
    const chunk = THREE.ShaderChunk[name];
    if (chunk == null) { missing.push(name); return ''; }
    return resolveIncludes(chunk);
  });
}
const vertexBody = resolveIncludes(shader.vertexShader);
const fragmentBody = resolveIncludes(shader.fragmentShader);
check('every #include resolved', missing.length === 0, missing.join(', '));

// What WebGLProgram puts in front of a vertex shader, trimmed to the parts a
// MeshBasicMaterial with no maps actually uses. `modelViewMatrix` is in here
// and not in the chunks, which matters: the offset reads its translation for
// the object's depth, and a prefix that dropped it would fail to compile here
// exactly as it would in the game.
//
// The three `NUM_*` defines are not decoration: three writes them into every
// prefix it builds, and without them the chunks that read them fail on a
// `#if` with nothing after it — three errors that all name a clipping plane and
// none of which are about this shader.
const PREFIX_VERT = `precision highp float;
precision highp int;
#define SHADER_NAME outline
#define FLIP_SIDED
#define NUM_CLIPPING_PLANES 0
#define UNION_CLIPPING_PLANES 0
#define NUM_SPOT_LIGHT_COORDS 0
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
`;
// The FRAGMENT side is stock — nothing here patches it — and it is compiled
// only because a link needs both halves. `linearToOutputTexel` is three's
// output-colourspace hook, written per-target by the renderer and stubbed to a
// passthrough here: assembling the real one would be testing three's colour
// management, which is not what this file is for.
const PREFIX_FRAG = `precision highp float;
precision highp int;
#define SHADER_NAME outline
#define FLIP_SIDED
#define NUM_CLIPPING_PLANES 0
#define UNION_CLIPPING_PLANES 0
#define NUM_SPOT_LIGHT_COORDS 0
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
vec4 linearToOutputTexel( vec4 value ) { return value; }
`;

const html = `<!doctype html><meta charset="utf-8"><title>outline shader check</title>
<body style="font:14px ui-monospace,monospace;background:#111;color:#ddd;padding:16px">
<pre id="out">compiling...</pre>
<script>
const SRC = ${JSON.stringify({
  vertex: PREFIX_VERT + vertexBody,
  fragment: PREFIX_FRAG + fragmentBody,
})};
const NODE = ${JSON.stringify(lines)};
// webgl2, because that is what the game runs on and a driver's ES 1.00 front
// end is not always the same one. ES 1.00 source compiles there unchanged.
const gl = document.createElement('canvas').getContext('webgl2')
  || document.createElement('canvas').getContext('webgl');
const lines = NODE.slice();
let bad = lines.filter((l) => l.startsWith('FAIL')).length;
function compile(kind, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
  if (!ok) bad++;
  lines.push((ok ? 'ok   ' : 'FAIL ') + kind + ' shader compiled');
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
  lines.push((ok ? 'ok   ' : 'FAIL ') + 'program linked');
  const log = (gl.getProgramInfoLog(p) || '').trim();
  if (log) lines.push(log.replace(/^/gm, '      '));
  if (ok) {
    // WHAT THE DRIVER KEPT. A uniform the shader declares but never reads is
    // optimised out of the linked program, and that is not a warning — it is a
    // rim that ignores the camera while every line above still says PASS.
    const uniforms = [];
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      uniforms.push(gl.getActiveUniform(p, i).name);
    }
    for (const want of ['uOutline', 'uOutlineView']) {
      const live = uniforms.includes(want);
      if (!live) bad++;
      lines.push((live ? 'ok   ' : 'FAIL ') + want + ' survived into the linked program');
    }
    const attrs = [];
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) {
      attrs.push(gl.getActiveAttrib(p, i).name);
    }
    const live = attrs.includes('aOutlineNormal');
    if (!live) bad++;
    lines.push((live ? 'ok   ' : 'FAIL ') + 'aOutlineNormal survived (the welded rim, not a torn one)');
  }
}
lines.push('');
lines.push(bad === 0 ? 'ALL SHADER CHECKS PASSED' : bad + ' SHADER CHECK(S) FAILED');
document.getElementById('out').textContent = lines.join('\\n');
</script>
`;

fs.writeFileSync(OUT, html);
for (const line of lines) console.log('  ' + line);
console.log(`\nwrote ${OUT}`);
console.log(`serve it over http://localhost and open ${path.basename(OUT)}`);
if (bad) process.exitCode = 1;
