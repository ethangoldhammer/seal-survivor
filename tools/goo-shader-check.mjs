#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE GOO PASS'S FRAGMENT SHADER, THROUGH A REAL COMPILER.
//
// A GLSL error renders NOTHING and throws NOTHING: the pass simply stops
// drawing, every Node harness in this repo goes on passing, and the first
// anybody knows about it is a ball that is not there. The possession field —
// the two team colours mixing across the body, seeded at the contact — lives
// in this shader (systems/post.js) and is a dozen lines of trigonometry inside
// a template literal that one stray backtick in a comment cuts in half. It did
// exactly that the first time it was written.
//
// Node has no WebGL, so this writes a page that hands the real string to a real
// driver, the way tools/net-shader-check.mjs and tools/grid-shader-check.mjs
// do. What it CAN check here it checks here: that the template survived, and
// that every uniform the CPU writes is declared and read.
//
//   npm run test:goofx
//   → serve the printed file over http://localhost and open it. A file:// URL
//     never executes in the Browser pane and 127.0.0.1 is blocked.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gooFragmentShader } from '../path/src/systems/post.js';
import { POSSESSION_FIELD_GLSL, POSSESSION_UNIFORMS_GLSL } from '../path/src/systems/possessionGlsl.js';

let bad = 0;
const lines = [];
const check = (label, ok, note = '') => {
  if (!ok) bad++;
  lines.push((ok ? 'ok   ' : 'FAIL ') + label + (note ? ` — ${note}` : ''));
};

// THE TEMPLATE SURVIVED. A backtick inside a GLSL comment ends the literal and
// the rest of the shader becomes JavaScript; when the two halves happen to be
// valid JS on their own, nothing anywhere complains and the shader is simply
// short. The guarantee is cheap: the source still runs to its own end, and
// carries no backtick that could have ended it early.
check('the shader source is whole, not a template cut short by a backtick',
  /void main\(\)/.test(gooFragmentShader) && !gooFragmentShader.includes('`'),
  `${gooFragmentShader.length} chars`);

// Every uniform renderGooGroup writes is declared here AND read below it. A
// uniform that is declared and never read is dropped by the driver, so the CPU
// writes it into nothing — which is the failure that looks like a tuning slider
// that does not work.
for (const u of ['uTeamA', 'uTeamB', 'uShare', 'uSeed', 'uLobes', 'uLobeSize', 'uWobble', 'uSpin', 'uBreathe', 'uBallAt', 'uBallR', 'uBallAspect']) {
  const declared = new RegExp(`uniform [a-z0-9]+ ${u};`).test(gooFragmentShader);
  const uses = gooFragmentShader.split(new RegExp(`\\b${u}\\b`)).length - 1;
  check(`the possession field declares and reads ${u}`, declared && uses >= 2, `${uses} mention(s)`);
}
// ...and the single-colour path every OTHER goo group takes is still there.
check('the single-tint path is untouched for blood, foam and the rest',
  /col = mix\(col, uTint, uTintMix\);/.test(gooFragmentShader));
// THE CELLS ARE A FIELD, not a shape. The whole point of doing this as a
// second metaball pass is that neighbouring cells SUM and are thresholded
// together, which is what welds them; drawing each one and taking the max
// would give circles that touch and never fuse.
check('the possession lobes are summed into one field and thresholded together',
  (gooFragmentShader.split('dens += f * f * f;').length - 1) >= 2
    && /smoothstep\(0\.22, 0\.5, dens\)/.test(gooFragmentShader));
check('...on a ring that rolls, so they spin as well as grow',
  /float roll = t \* uSpin;/.test(gooFragmentShader)
    // ...and this pass hands it ITS clock. The field takes the roll clock as
    // an argument because the backdrop lattice includes the same function on a
    // clock of its own; a hardcoded uTime in there would have compiled here and
    // failed to compile over there, which is a shader that renders nothing.
    && /possessionMix\(d, uTime\)/.test(gooFragmentShader));
check('...born on the rim at the contact and walking in as the share grows',
  /vec2 at = seedP \* \(1\.0 - sh\) \+ uDrift;/.test(gooFragmentShader));
// THE SKIN HOLDS THEM IN, and it reads the body rather than assuming a circle
// — that is what makes a dent in the ball a dent in the mass. And it only ever
// READS: a cell that could write back into the density field would be a look
// changing the shape and the path of the thing it is a look on.
check('the cells are held inside the body by the body itself, not by a circle',
  /vec2 posHold\(vec2 lp, float rim\)/.test(gooFragmentShader)
    && /float body = texture2D\(tDiffuse, uvAt\)\.a;/.test(gooFragmentShader)
    // The mass's own centre AND every lobe go through it, or the one that
    // does not is the one that pokes out of the ball.
    && (gooFragmentShader.split('posHold(').length - 1) >= 3);
// ...AND IT IS THE SHARED FIELD, not a copy of it. The backdrop lattice paints
// the dents the ball springs into the grid with this same function
// (systems/possessionGlsl.js), which is the only reason a streak through the
// hexes reads as the same ball. A copy pasted back in here would look identical
// on the day it was pasted and drift the first time a lobe was retuned, so the
// string this pass ships is compared against the module both of them include.
check('the field is the shared one, so the grid and the ball cannot drift apart',
  gooFragmentShader.includes(POSSESSION_FIELD_GLSL.trim())
    && gooFragmentShader.includes(POSSESSION_UNIFORMS_GLSL.trim()));
check('...and the mass is sloshed by the flight rather than moving on its own',
  /uniform vec2 uDrift;/.test(gooFragmentShader)
    && (gooFragmentShader.split('uDrift').length - 1) >= 2);
check('...and a full share is solid, whatever the lobes left between them',
  /smoothstep\(0\.9, 1\.0, sh\)/.test(gooFragmentShader));

const OUT = process.argv[2] ?? path.join(
  path.dirname(fileURLToPath(import.meta.url)), '../.goo-shader-check.html',
);

// three's own prefix for a ShaderMaterial fragment on WebGL2, cut to what this
// shader references.
const PREFIX = `#version 300 es
#define varying in
out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
precision highp float;
precision highp int;
`;

const html = `<!doctype html><meta charset="utf-8"><title>goo shader check</title>
<style>body{background:#111;color:#ddd;font:13px/1.5 ui-monospace,monospace;padding:16px}</style>
<pre id="out">running…</pre>
<script>
const gl = document.createElement('canvas').getContext('webgl2');
const SRC = ${JSON.stringify(PREFIX + gooFragmentShader)};
const lines = [];
let bad = 0;
if (!gl) { lines.push('no webgl2 context'); bad++; }
else {
  const s = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(s, SRC);
  gl.compileShader(s);
  const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
  if (!ok) bad++;
  lines.push((ok ? 'PASS  ' : 'FAIL  ') + 'the goo pass fragment shader compiles');
  const log = (gl.getShaderInfoLog(s) || '').trim();
  if (log) {
    lines.push(log.replace(/^/gm, '      '));
    const body = SRC.split('\\n');
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
}
lines.push('');
lines.push(bad === 0 ? 'ALL SHADER CHECKS PASSED' : bad + ' SHADER CHECK(S) FAILED');
document.getElementById('out').textContent = lines.join('\\n');
</script>
`;

fs.writeFileSync(OUT, html);
lines.push('');
lines.push(`wrote ${OUT}`);
lines.push('serve it over http://localhost and open it — Node has no WebGL, and a');
lines.push('GLSL error is invisible to everything in this file above that line.');
console.log(lines.join('\n'));
console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
