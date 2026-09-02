#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Writes a page that COMPILES the element bands' injected GLSL (assets.js,
// makeBandMaterial) against a real driver and prints the driver's own log.
//
// Same reason as the other *-shader-check pages, and the same failure mode: a
// GLSL error does not throw, does not warn in Node, and renders NOTHING. This
// film is on the BASIC SHOT, so a broken band shader is a gun that deals its
// damage with no pellet visible anywhere — on the one weapon every run has, from
// the first second of the first level. Every Node harness in the repo passes
// cheerfully while it happens, tools/elements-test.mjs included: it asserts the
// material's COLOUR, which is untouched by any of this.
//
// THE CONTEXT MUST BE WEBGL2, because that is what three 0.183 requires and so
// what the game runs on. It matters twice here: these are GLSL ES 1.00 shaders,
// where the derivative functions are an extension rather than core (so a band
// edge sharpened with fwidth would fail on a real driver), and the fbm loop
// needs constant bounds — a driver is entitled to reject a loop this compiles
// fine in a text editor.
//
// BOTH HALVES, AND THEN A LINK. The bands are a pair — the vertex chunk
// publishes vBandW, the fragment chunk consumes it — and a varying declared
// differently on the two sides compiles cleanly on both and fails only at link
// time. Compiling the fragment alone would miss exactly the mistake this
// pairing is most likely to make.
//
//   node --import ./tools/vite-loader.mjs tools/band-shader-check.mjs [outDir]
//   → serve that directory over http and open it (file:// will not execute)
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVisual } from '../path/src/assets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(HERE, '..');

// THE MATERIAL INJECTS ITSELF. An earlier version of this file scraped the
// GLSL out of assets.js as text, and got it wrong twice in a row for the same
// reason: makeShellMaterial sits in the same file and splices its own block
// into the same <common> hook, and makeChromeMaterial hooks <common> TWICE
// (once per shader stage). Both mistakes produced a page that compiled a
// perfectly valid shader that was not the one under test — the worst possible
// outcome for a check whose entire job is to be believed.
//
// So nothing is scraped. A real bullet material is built through the real asset
// path and handed a probe shader carrying only the two chunk names it hooks,
// plus a sentinel marking where main() begins. Whatever comes back IS what the
// driver would be asked to compile, by construction.
const mat = createVisual('bullet').material;
if (typeof mat.onBeforeCompile !== 'function') {
  console.error('bullet has no onBeforeCompile — the band film never attached');
  process.exit(1);
}

const MARK = '//@@main@@';
const probe = {
  uniforms: {},
  vertexShader: `#include <common>\n${MARK}\n#include <project_vertex>\n`,
  fragmentShader: `#include <common>\n${MARK}\nvec4 diffuseColor = vec4( diffuse, opacity );\n`,
};
mat.onBeforeCompile(probe);

// PROOF THE INJECTION LANDED. Both hooks are plain string replacements against
// three's own chunk text, so a three upgrade that rewords either one turns this
// whole material into an unmodified MeshBasicMaterial — no error, no warning,
// and blades that render as flat grey rectangles. Node cannot see that either,
// but it CAN see that the replacement did nothing.
if (!probe.fragmentShader.includes('uBandScale')) {
  console.error('the band fragment injection did not land — three\'s <common> hook or the'
    + '\ndiffuseColor line has changed wording, and the field is silently not applied.');
  process.exit(1);
}
if (probe.fragmentShader.includes('vec4 diffuseColor = vec4( diffuse, opacity );')) {
  console.error('the diffuseColor replacement did not land — the band body is not in the shader.');
  process.exit(1);
}
if (!probe.vertexShader.includes('vBandW = (modelMatrix')) {
  console.error('the band vertex injection did not land — three\'s <project_vertex> hook has moved.');
  process.exit(1);
}
// AND THE INSTANCE BRANCH, which is the one the game actually runs now: the
// pellets are drawn from an instance buffer (entities/projectiles.js), and
// three's <project_vertex> leaves `transformed` in object space, so without
// this every shot in a volley samples the field at the InstancedMesh's origin
// and the whole volley comes out one flat colour. Checked as a string here
// because the compile below cannot see it — the branch is behind an #ifdef,
// and a driver skips a dead branch without reading it.
if (!probe.vertexShader.includes('instanceMatrix * bandLocal')) {
  console.error('the band vertex chunk no longer folds in instanceMatrix — every pellet of a'
    + '\nvolley will sample the field at the same point and render the same colour.');
  process.exit(1);
}

const split = (src, what) => {
  const i = src.indexOf(MARK);
  if (i < 0) { console.error(`lost the ${what} sentinel`); process.exit(1); }
  return [src.slice(0, i), src.slice(i + MARK.length)];
};

// three's prelude, cut to what these two chunks actually reference, and kept
// explicit rather than borrowed from the renderer: the point of this page is to
// be told what the DRIVER thinks, and a prelude generated by the same library
// that generated the shader can hide a mismatch between them.
const [vGlobal, vBody] = split(probe.vertexShader.replace('#include <common>', ''), 'vertex');
const vertex = `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform mat4 modelMatrix;
attribute vec3 position;
attribute vec3 normal;
${vGlobal}
void main() {
  // Stands in for three's <project_vertex>. transformed is what the band
  // chunk reads, and it is the vertex AFTER every earlier chunk has had it —
  // declared here for the same reason diffuse is declared below. (No backticks
  // in this comment on purpose: it lives inside a template literal.)
  vec3 transformed = position;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
${vBody.replace('#include <project_vertex>', '')}
}
`;

// THE SAME CHUNK WITH INSTANCING ON, because that is how the pellets are drawn
// and it is a DIFFERENT SHADER: the #ifdef branch above is skipped entirely by
// a driver compiling the plain variant, so a typo inside it would pass this
// page and then render nothing on the one weapon every run has. three defines
// USE_INSTANCING and declares the attribute itself on an InstancedMesh; both
// are spelled out here for the same reason the rest of the prelude is.
const vertexInstanced = `#define USE_INSTANCING
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform mat4 modelMatrix;
attribute vec3 position;
attribute vec3 normal;
attribute mat4 instanceMatrix;
${vGlobal}
void main() {
  vec3 transformed = position;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
${vBody.replace('#include <project_vertex>', '')}
}
`;

const [fGlobal, fBody] = split(probe.fragmentShader.replace('#include <common>', ''), 'fragment');
const fragment = `precision highp float;
${fGlobal}
void main() {
  // Declared here because three declares both for real in every material this
  // injects into. Leaving them out would fail the check on a line the game
  // compiles perfectly.
  vec3 diffuse = vec3(1.0);
  float opacity = 1.0;
${fBody}
  gl_FragColor = diffuseColor;
}
`;

const html = `<!doctype html><meta charset="utf-8"><title>band shader check</title>
<body style="font:13px ui-monospace,monospace;background:#111;color:#ddd;padding:16px">
<pre id="out">compiling...</pre>
<script>
const SRC = ${JSON.stringify({ vertex, vertexInstanced, fragment })};
const gl = document.createElement('canvas').getContext('webgl2');
const lines = [];
let bad = 0;

function show(label, source, log) {
  lines.push('FAIL ' + label);
  for (const l of log.trim().split('\\n')) lines.push('       ' + l);
  // A GLSL error is a line number and nothing else, so show the source there.
  const body = source.split('\\n');
  const seen = new Set();
  for (const m of log.matchAll(/ERROR: \\d+:(\\d+)/g)) {
    const n = +m[1];
    if (seen.has(n)) continue;
    seen.add(n);
    lines.push('');
    for (let i = Math.max(0, n - 3); i < Math.min(body.length, n + 2); i++) {
      lines.push((i === n - 1 ? '  >> ' : '     ') + String(i + 1).padStart(4) + '  ' + body[i]);
    }
  }
}

function compile(label, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    lines.push('ok   ' + label);
    return s;
  }
  bad++;
  show(label, source, gl.getShaderInfoLog(s) || '');
  return null;
}

if (!gl) {
  lines.push('no webgl2 context — nothing was checked, and the game needs one');
  bad++;
} else {
  const v = compile('the band VERTEX chunk compiles', gl.VERTEX_SHADER, SRC.vertex);
  // The instanced variant is its own compile, not a formality: the #ifdef
  // branch is invisible to the plain one, and it is the branch the pellets run.
  const vi = compile('the band VERTEX chunk compiles WITH INSTANCING',
    gl.VERTEX_SHADER, SRC.vertexInstanced);
  const f = compile('the band FRAGMENT chunk compiles', gl.FRAGMENT_SHADER, SRC.fragment);
  if (vi && f) {
    const pi = gl.createProgram();
    gl.attachShader(pi, vi);
    gl.attachShader(pi, f);
    gl.linkProgram(pi);
    if (gl.getProgramParameter(pi, gl.LINK_STATUS)) {
      lines.push('ok   the instanced pair links too');
    } else {
      bad++;
      lines.push('FAIL the instanced halves do NOT link');
      for (const l of (gl.getProgramInfoLog(pi) || '').trim().split('\\n')) lines.push('       ' + l);
    }
  }
  if (v && f) {
    // LINKED, not just compiled — see the header. This is the only step that
    // can see a varying the two halves disagree about.
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (gl.getProgramParameter(p, gl.LINK_STATUS)) {
      lines.push('ok   the two halves link — vBandW agrees across the pair');
      lines.push('');
      lines.push('     the basic shot is the only asset wearing this film,');
      lines.push('     so this is the whole of it.');
    } else {
      bad++;
      lines.push('FAIL the two halves do NOT link');
      for (const l of (gl.getProgramInfoLog(p) || '').trim().split('\\n')) lines.push('       ' + l);
    }
  }
}

lines.push('');
lines.push(bad === 0 ? 'ALL GOOD' : bad + ' PROBLEM(S)');
document.getElementById('out').textContent = lines.join('\\n');
document.title = bad === 0 ? 'band shader ok' : 'band shader FAILED';
<\/script>
`;

const out = path.join(OUT_DIR, '.band-shader-check.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out}`);
console.log('serve that directory over http and open it — file:// will not execute.');
