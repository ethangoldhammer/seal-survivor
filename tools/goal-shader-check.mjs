#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE GOAL MOUTHS' LIGHT, THROUGH A REAL COMPILER.
//
// A GLSL error renders NOTHING and throws NOTHING. The light in each mouth is
// the whole read of a Blubberball pitch — which goal is whose, where the ball
// is, whether a shot is coming — and it is built as a template literal with a
// falloff chunk and a throw chunk spliced into it, which is a string one stray
// backtick in a comment cuts in half. Every Node harness in this repo goes on
// passing while it happens: versus-test asserts the quad's SIZE and the
// uniforms' VALUES, and both of those are right on a shader that never
// compiled.
//
// Node has no WebGL, so the driver's half is a page (as in
// tools/band-shader-check.mjs and tools/goo-shader-check.mjs). What can be
// checked here is checked here: that both templates survived, and that every
// uniform the CPU writes is declared AND read — a uniform written from
// applyGoalShape and missing from the source is a knob that silently does
// nothing, which is how a new reach or a new noise term arrives dead.
//
//   npm run test:goalfx
//   → serve the printed file over http://localhost and open it. A file:// URL
//     never executes in the Browser pane and 127.0.0.1 is blocked.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goalGlowMaterial, goalBackMaterial } from '../path/src/systems/wallRocks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(HERE, '..');

let bad = 0;
const say = (ok, name, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// Both surfaces of a mouth: the additive light, and the slab behind it that
// stops the open corridor being a window onto the seabed. They share the
// falloff chunk, so a break in it takes out both.
const SURFACES = {
  light: goalGlowMaterial(0x3399ff, 3, 0.55, {}, -1, {}),
  back: goalBackMaterial(0x3399ff, 0.22, -1),
};

for (const [name, mat] of Object.entries(SURFACES)) {
  const fsSrc = mat.fragmentShader;
  const vsSrc = mat.vertexShader;
  say(/void\s+main\s*\(/.test(fsSrc) && /void\s+main\s*\(/.test(vsSrc),
    `${name}: both halves of the template survived`);
  say(/float\s+goalFalloff\s*\(/.test(fsSrc), `${name}: the falloff chunk is spliced in`);
  // THE TWO REACHES ARE BOTH SPENT. The fade past the lips and the throw into
  // the water are separate numbers now (CONFIG.versus.goal.spill and
  // spillOut); a falloff that reads only one of them is the rectangle this
  // replaced, and it looks plausible in every other check.
  const falloff = fsSrc.slice(fsSrc.indexOf('float goalFalloff'), fsSrc.indexOf('void main'));
  say(/uSpill/.test(falloff) && /uOut/.test(falloff),
    `${name}: the falloff spends both reaches, not one twice`);
  // `out` is a parameter qualifier in GLSL: a variable of that name fails to
  // compile, and the only symptom is a mouth with no light in it.
  say(!/\b(float|vec2|vec3|vec4|int)\s+out\b/.test(fsSrc),
    `${name}: nothing is named "out"`);

  // EVERY UNIFORM THE CPU WRITES, DECLARED AND READ. Declared once and never
  // read is a knob that does nothing; written and never declared is a knob
  // that throws nothing and does nothing.
  const src = `${vsSrc}\n${fsSrc}`;
  const dead = [];
  const missing = [];
  for (const key of Object.keys(mat.uniforms)) {
    const declared = new RegExp(`uniform\\s+[\\w]+\\s+${key}\\s*[;\\[]`).test(src);
    const uses = (src.match(new RegExp(`\\b${key}\\b`, 'g')) || []).length;
    if (!declared) missing.push(key);
    else if (uses < 2) dead.push(key);
  }
  say(missing.length === 0, `${name}: every uniform written from JS is declared`, missing.join(', '));
  say(dead.length === 0, `${name}: ...and every one of them is read`, dead.join(', '));
}

const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<meta charset="utf-8">
<title>goal light shader</title>
<style>body{background:#0b0f14;color:#cfe;font:13px ui-monospace,monospace;padding:16px}</style>
<pre id="out">compiling…</pre>
<script>
// THE CONTEXT MUST BE WEBGL2 — what three 0.183 asks for and so what the game
// runs on. These are still GLSL ES 1.00 shaders, where the derivative
// functions are an extension rather than core, so a rim sharpened with fwidth
// compiles in a text editor and fails on a driver.
const SRC = ${esc(JSON.stringify(Object.fromEntries(
  Object.entries(SURFACES).map(([k, m]) => [k, { vs: m.vertexShader, fs: m.fragmentShader }]),
)))};
// The chunk three prepends itself. Compiled without it, every one of these
// shaders fails on modelMatrix and the page reports a fault that is not there.
const PRELUDE = [
  'precision highp float;', 'precision highp int;',
  'uniform mat4 modelMatrix;', 'uniform mat4 modelViewMatrix;',
  'uniform mat4 projectionMatrix;', 'uniform mat4 viewMatrix;',
  'uniform mat3 normalMatrix;', 'uniform vec3 cameraPosition;',
].join('\\n');
const VS_PRE = PRELUDE + '\\nattribute vec3 position;\\nattribute vec3 normal;\\nattribute vec2 uv;\\n';
const lines = [];
let bad = 0;
const gl = document.createElement('canvas').getContext('webgl2');
if (!gl) { bad++; lines.push('FAIL no webgl2 context'); }
else for (const name of Object.keys(SRC)) {
  const prog = gl.createProgram();
  let built = true;
  for (const half of ['vs', 'fs']) {
    const sh = gl.createShader(half === 'vs' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    gl.shaderSource(sh, (half === 'vs' ? VS_PRE : PRELUDE + '\\n') + SRC[name][half]);
    gl.compileShader(sh);
    if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.attachShader(prog, sh); lines.push('ok   ' + name + '.' + half + ' compiles'); }
    else {
      bad++; built = false;
      lines.push('FAIL ' + name + '.' + half);
      for (const l of (gl.getShaderInfoLog(sh) || '').trim().split('\\n')) lines.push('       ' + l);
    }
  }
  if (!built) continue;
  gl.linkProgram(prog);
  // A varying declared differently on the two sides compiles on both and
  // fails only here.
  if (gl.getProgramParameter(prog, gl.LINK_STATUS)) lines.push('ok   ' + name + ' links');
  else {
    bad++;
    lines.push('FAIL ' + name + ' does NOT link');
    for (const l of (gl.getProgramInfoLog(prog) || '').trim().split('\\n')) lines.push('       ' + l);
  }
}
lines.push('');
lines.push(bad === 0 ? 'ALL GOOD' : bad + ' PROBLEM(S)');
document.getElementById('out').textContent = lines.join('\\n');
document.title = bad === 0 ? 'goal shader ok' : 'goal shader FAILED';
</script>
`;

const out = path.join(OUT_DIR, '.goal-shader-check.html');
fs.writeFileSync(out, html);
console.log('');
console.log(bad === 0 ? 'all good (Node half)' : `${bad} PROBLEM(S)`);
console.log(`wrote ${out}`);
console.log('serve that directory over http and open it — file:// will not execute.');
process.exit(bad === 0 ? 0 : 1);
