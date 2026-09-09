#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:split
//
// THE SKY/OCEAN SPLIT on the noise shader — the wiring a look page cannot see.
//
// The split runs the mottle a second time with an underside set of numbers and
// crossfades the two on how much the posed normal faces world +Y. Four things
// about it break silently, and each is asserted here rather than remembered:
//
//   THE VARYING HAS TO BE WRITTEN ON EVERY MATERIAL CLASS. It is filled off
//   `transformedNormal` after <defaultnormal_vertex> — a chunk MeshBasicMaterial
//   only includes when skinned. An unwritten varying is not zero, it is
//   UNDEFINED, and an unlit procedural shape would split by whatever the driver
//   felt like. So it is seeded at <begin_vertex> off the raw attribute first.
//
//   THE UNDERSIDE PASS STARTS FROM THE PHOTOGRAPH, not from the top pass's
//   result. `noisePre` has to be captured before the first pass writes
//   diffuseColor, or the belly is the back painted twice.
//
//   ONE BODY OF ARITHMETIC. Both passes are the same template in noiseGlsl.js
//   with different names; a copy would drift the day someone fixed the polarity
//   test on one side only.
//
//   THE LAB AND CONFIG.JS AGREE. Every slider in the lab's SPLIT list has a base
//   value in config.js and defaults to it, and both colour keys spell "color"
//   so tools/apply-shaders.mjs writes them as hex rather than as 667187.
//
//   node --import ./tools/vite-loader.mjs tools/noise-split-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { attachNoiseShader, applyNoiseSettings } from '../path/src/systems/noiseShader.js';
import { MOTTLE_FRAGMENT_GLSL, mottleGlsl } from '../path/src/systems/noiseGlsl.js';
import { attachBiolumSkin, applyBiolumSkinSettings, biolumUniformsOf } from '../path/src/systems/biolumSkin.js';

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const CHUNKS_FRAG = ['#include <common>', '#include <map_fragment>',
  '#include <emissivemap_fragment>', '#include <dithering_fragment>'].join('\n');
// A lit or skinned body has <defaultnormal_vertex>; an unlit, unskinned one
// (meshbasic_vert) does not. Both shapes are compiled below.
const VERT_LIT = ['#include <common>', '#include <begin_vertex>', '#include <defaultnormal_vertex>',
  '#include <project_vertex>'].join('\n');
const VERT_BASIC = ['#include <common>', '#include <begin_vertex>', '#include <project_vertex>'].join('\n');

function injected(material, vert = VERT_LIT) {
  const shader = { uniforms: {}, vertexShader: vert, fragmentShader: CHUNKS_FRAG };
  material.onBeforeCompile(shader, null);
  return shader;
}
const stripComments = (glsl) => glsl.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ---------------------------------------------------------------------------
section('the varying is written on every material class');
{
  const m = new THREE.MeshStandardMaterial();
  attachNoiseShader(m);
  const lit = injected(m, VERT_LIT).vertexShader;
  const writes = (src) => (src.match(/vNoiseUp = /g) ?? []).length;
  check('declared in the vertex shader', lit.includes('varying float vNoiseUp;'));
  check('lit body: seeded at <begin_vertex> AND overwritten off transformedNormal',
    writes(lit) === 2 && lit.indexOf('normalMatrix * normal') < lit.indexOf('transformedNormal'),
    `${writes(lit)} write(s)`);
  check('the posed write comes AFTER <defaultnormal_vertex>',
    lit.indexOf('#include <defaultnormal_vertex>') < lit.indexOf('normalize(transformedNormal)'));
  const basic = injected(m, VERT_BASIC).vertexShader;
  check('unlit, unskinned body: still written once, off the attribute',
    writes(basic) === 1 && basic.includes('normalMatrix * normal'), `${writes(basic)} write(s)`);
  check('dotted against world up taken into view space',
    (lit.match(/viewMatrix \* vec4\(0\.0, 1\.0, 0\.0, 0\.0\)/g) ?? []).length === 2);
}

// ---------------------------------------------------------------------------
section('the fragment: two passes, one photograph, blended after the mottle');
{
  const m = new THREE.MeshStandardMaterial();
  attachNoiseShader(m);
  const sh = injected(m);
  const f = stripComments(sh.fragmentShader);
  const at = (s) => { const i = f.indexOf(s); check(`present: ${s}`, i >= 0); return i; };
  const pre = at('vec3 noisePre = diffuseColor.rgb;');
  const firstWrite = f.indexOf('diffuseColor.rgb = mix(diffuseColor.rgb, uNoiseBase');
  const lit = f.indexOf('float noiseLit = ');
  const split = at('if (uSplit > 0.0) {');
  const under = at('vec3 noiseUnderRgb = noisePre;');
  const blend = at('diffuseColor.rgb = mix(diffuseColor.rgb, noiseUnderRgb, splitW);');
  check('noisePre is captured BEFORE the top pass first writes diffuseColor', pre < firstWrite);
  check('the split block comes AFTER the top pass leaves noiseLit in scope', lit < split);
  check('the underside pass starts from noisePre, inside the branch', split < under && under < blend);
  check('noiseLit and noisePolarity are blended too, for the glow and wet layers',
    f.includes('noiseLit = mix(noiseLit, noiseUnderLit, splitW);')
    && f.includes('noisePolarity = mix(noisePolarity, noiseUnderPolarity, splitW);'));
  check('never a zero-width smoothstep: soft 0 is a step()',
    f.includes('uSplitSoft > 1e-4') && f.includes('step(vNoiseUp, uSplitLine)'));
  check('the blend is on vNoiseUp between line ± soft',
    f.includes('smoothstep(uSplitLine - uSplitSoft, uSplitLine + uSplitSoft, vNoiseUp)'));

  const declared = [...f.matchAll(/uniform\s+\w+\s+(uSplit\w*);/g)].map((x) => x[1]);
  const expected = ['uSplit', 'uSplitLine', 'uSplitSoft', 'uSplitPaint', 'uSplitStrength',
    'uSplitSize', 'uSplitContrast', 'uSplitColor', 'uSplitBase'];
  check('all nine split uniforms declared', expected.every((k) => declared.includes(k)),
    declared.join(' '));
  check('...and every one of them attached to the program', expected.every((k) => k in sh.uniforms));
  const used = expected.filter((k) => f.split(k).length - 1 >= 2);
  check('...and every one of them READ, not just declared', used.length === expected.length,
    `unused: ${expected.filter((k) => !used.includes(k)).join(', ') || 'none'}`);
}

// ---------------------------------------------------------------------------
section('one body of arithmetic for both halves');
{
  const names = {
    size: 'uSplitSize', strength: 'uSplitStrength', contrast: 'uSplitContrast',
    color: 'uSplitColor', base: 'uSplitBase', paint: 'uSplitPaint',
    n: 'noiseUnderN', polarity: 'noiseUnderPolarity', lit: 'noiseUnderLit', dst: 'noiseUnderRgb',
  };
  const under = stripComments(mottleGlsl(names));
  // Rename the default pass into the underside's names and the two must be
  // the same text — which is only true while both come from one template.
  let renamed = stripComments(MOTTLE_FRAGMENT_GLSL)
    .replace(/diffuseColor\.rgb/g, names.dst)
    .replace(/\bnoiseN\b/g, names.n).replace(/\bnoisePolarity\b/g, names.polarity)
    .replace(/\bnoiseLit\b/g, names.lit)
    .replace(/\buNoiseSize\b/g, names.size).replace(/\buNoiseStrength\b/g, names.strength)
    .replace(/\buNoiseContrast\b/g, names.contrast).replace(/\buNoiseColor\b/g, names.color)
    .replace(/\buNoiseBase\b/g, names.base).replace(/\buNoisePaint\b/g, names.paint);
  check('the underside pass is the top pass with the names swapped', renamed === under);
  check('the default render still reads and writes diffuseColor.rgb',
    (MOTTLE_FRAGMENT_GLSL.match(/diffuseColor\.rgb/g) ?? []).length >= 4);
}

// ---------------------------------------------------------------------------
section('applyNoiseSettings maps the preset onto the uniforms');
{
  const base = CONFIG.sealShader;
  check('config.js ships split 0 — every wearer is what it was', base.split === 0);
  const m = new THREE.MeshStandardMaterial();
  attachNoiseShader(m, 'splitProbe');
  const u = m.userData.__noiseUniforms;
  const saved = structuredClone(base.presets?.splitProbe ?? null);
  base.presets ??= {};

  base.presets.splitProbe = {};
  applyNoiseSettings();
  check('no preset fields: uSplit 0', u.uSplit.value === 0);
  check('underside defaults mirror the base', near(u.uSplitStrength.value, base.splitStrength)
    && near(u.uSplitSize.value, base.splitSize) && near(u.uSplitSoft.value, base.splitSoft));

  base.presets.splitProbe = {
    split: 1, splitLine: 0.3, splitSoft: 0.1, splitPaint: 1, splitStrength: 0.9,
    splitSize: 0.12, splitContrast: 2.5, splitColor: 0x112233, splitBaseColor: 0xf0e0d0,
  };
  applyNoiseSettings();
  check('every split key reaches its uniform', u.uSplit.value === 1 && near(u.uSplitLine.value, 0.3)
    && near(u.uSplitSoft.value, 0.1) && u.uSplitPaint.value === 1 && near(u.uSplitStrength.value, 0.9)
    && near(u.uSplitSize.value, 0.12) && near(u.uSplitContrast.value, 2.5));
  check('colours land as colours', u.uSplitColor.value.getHex() === 0x112233
    && u.uSplitBase.value.getHex() === 0xf0e0d0);

  base.presets.splitProbe = { split: 3, splitLine: 4, splitPaint: -1 };
  applyNoiseSettings();
  check('master clamps to 0..1, line to -1..1, paint to 0..1',
    u.uSplit.value === 1 && u.uSplitLine.value === 1 && u.uSplitPaint.value === 0);

  base.presets.splitProbe = { split: 1, enabled: false };
  applyNoiseSettings();
  check('enabled:false folds into the master like every other layer on this root', u.uSplit.value === 0);

  base.presets.splitProbe = { split: 0.5, splitStrength: 0.7 };
  applyNoiseSettings();
  check('a preset overriding one underside field keeps the rest at base (flat keys, shallow spread)',
    near(u.uSplitStrength.value, 0.7) && near(u.uSplitSize.value, base.splitSize)
    && near(u.uSplit.value, 0.5));

  if (saved) base.presets.splitProbe = saved; else delete base.presets.splitProbe;
}

// ---------------------------------------------------------------------------
section('the lab and config.js agree');
{
  const lab = readFileSync(new URL('./looks/shader-lab.js', import.meta.url), 'utf8');
  const block = lab.match(/const SPLIT = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const rows = [...block.matchAll(/key: '(\w+)'[^\n]*?def: ([-\d.]+)/g)].map((x) => [x[1], +x[2]]);
  check('the SPLIT list is in the lab', rows.length >= 7, `${rows.length} rows`);
  for (const [key, def] of rows) {
    check(`lab "${key}" defaults to the config.js base`, key in CONFIG.sealShader
      && near(CONFIG.sealShader[key], def), `lab ${def}, config ${CONFIG.sealShader[key]}`);
  }
  check('the split section is built under the noise layer',
    /section\('split', 'sealShader', target\.noise, SPLIT/.test(lab));
  check('record carries the split fields', /gather\('split', 'sealShader', target\.noise, SPLIT\)/.test(lab));
  for (const k of ['splitColor', 'splitBaseColor']) {
    check(`"${k}" is in the recorded colour list`, lab.includes(`['${k}',`));
    check(`"${k}" spells color, so apply-shaders writes it as hex`, /color/i.test(k) && k in CONFIG.sealShader);
  }
}

// ---------------------------------------------------------------------------
section('the biolum layer: the same bias on the normal, optional');
{
  // `base`, not the root: CONFIG.biolumSkin keeps its defaults under a base
  // block that every preset spreads over (applyBiolumSkinSettings).
  check('config.js ships upBias 0 — every pattern is what it was', CONFIG.biolumSkin.base.upBias === 0);
  const m = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m);
  attachBiolumSkin(m, mesh, 'lantern', 'x');
  const sh = { uniforms: {}, vertexShader: VERT_LIT, fragmentShader: CHUNKS_FRAG };
  m.onBeforeCompile(sh, null);
  const v = sh.vertexShader, f = stripComments(sh.fragmentShader);
  check('vBioUp declared in both stages', v.includes('varying float vBioUp;') && f.includes('varying float vBioUp;'));
  check('written twice on a lit body, posed write after <defaultnormal_vertex>',
    (v.match(/vBioUp = /g) ?? []).length === 2
    && v.indexOf('#include <defaultnormal_vertex>') < v.indexOf('normalize(transformedNormal)'));
  const basic = { uniforms: {}, vertexShader: VERT_BASIC, fragmentShader: CHUNKS_FRAG };
  m.onBeforeCompile(basic, null);
  check('written once on an unlit, unskinned body', (basic.vertexShader.match(/vBioUp = /g) ?? []).length === 1);
  check('the bias multiplies the mask, same idiom as tailBias, right after it',
    f.indexOf('uBioTailBias * (vBioAxis - 0.5) * 2.0') < f.indexOf('bioMaskV *= clamp(1.0 + uBioUpBias * vBioUp, 0.0, 2.0);'));
  check('...and BEFORE the pigment mix, so paint is biased as well as light',
    f.indexOf('uBioUpBias * vBioUp') < f.indexOf('clamp(uBioPigment, 0.0, 1.0)'));
  check('uBioUpBias is on the program', 'uBioUpBias' in sh.uniforms);

  const u = biolumUniformsOf(m);
  const base = CONFIG.biolumSkin;
  const saved = structuredClone(base.presets?.lantern ?? {});
  applyBiolumSkinSettings();
  check('no preset field: uniform 0', u.uBioUpBias.value === 0);
  base.presets.lantern = { ...saved, upBias: 0.6 };
  applyBiolumSkinSettings();
  check('preset upBias reaches the uniform', near(u.uBioUpBias.value, 0.6));
  base.presets.lantern = { ...saved, upBias: 5 };
  applyBiolumSkinSettings();
  check('clamped to -1..1', u.uBioUpBias.value === 1);
  base.presets.lantern = saved;
  applyBiolumSkinSettings();

  const lab = readFileSync(new URL('./looks/shader-lab.js', import.meta.url), 'utf8');
  const row = lab.match(/const BIO = \[[\s\S]*?key: 'upBias'[^\n]*def: ([-\d.]+)/);
  check('the lab has the row under pattern, defaulting to the base', !!row && +row[1] === base.base.upBias);
  const cfg = readFileSync(new URL('../path/src/config.js', import.meta.url), 'utf8');
  check('the tuner has the row beside tailBias', /at\('tailBias'\)[\s\S]{0,200}at\('upBias'\)/.test(cfg));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
