#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:wet
//
// THE SEAL'S WET FILM — the wiring the look page cannot see.
//
// tools/looks/seal-wet.js answers "does it look wet", in a browser, because a
// GLSL error renders nothing and throws nothing Node can watch. This answers the
// other half, which is the half that breaks silently:
//
//   THE FILM IS LIT BY THE WATER, AND THE WATER HAS TO TELL IT SO. The caustic
//   veins on the animal are sampled from the same function, at the same world
//   position and phase, as the veins on the plane behind it — but only because
//   world.js calls setNoiseWetEnv(liveCaustics) every frame, AFTER
//   updateWaterMaterial has resolved them. Drop that call and nothing throws,
//   nothing logs, and the seal keeps its highlight and its rim: it just stops
//   being dappled, which reads as the caustics having been tuned down rather
//   than as a call having gone missing.
//
//   THE ENV UNIFORMS ARE SHARED BY REFERENCE. Every wearer holds the same three
//   uniform objects so one write a frame reaches all of them. Anything that
//   copies them instead — a spread, a clone, a well-meant `{...wetSea}` — leaves
//   each material with a private snapshot that is never written again, and the
//   veins freeze on frame one at whatever the water happened to be doing.
//
//   `light` IS NOT `intensity`. The first cut fed the film the caustic strength
//   the water plane uploads, which is authored for a fifty-unit fill; on a
//   2.6-unit animal it came out at three hundredths of a value and the veins
//   were invisible. The film rides the DAY/NIGHT BUS and owns its own strength.
//   Both are on `liveCaustics` and they look interchangeable, which is exactly
//   why the difference is asserted rather than remembered.
//
//   node --import ./tools/vite-loader.mjs tools/seal-wet-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { CAUSTICS_GLSL } from '../path/src/systems/causticsGlsl.js';
import { createWaterMaterial, updateWaterMaterial, liveCaustics } from '../path/src/systems/water.js';
import {
  attachNoiseShader, applyNoiseSettings, setNoiseWetEnv,
} from '../path/src/systems/noiseShader.js';

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// A stand-in for the seal's material. MeshStandardMaterial specifically: the
// film is fenced to `#ifdef STANDARD` in the shader, and the uniforms are
// attached to anything with a colour, so a basic material would pass every
// check here while rendering no film at all.
function sealMaterial(preset = null) {
  const m = new THREE.MeshStandardMaterial();
  attachNoiseShader(m, preset);
  return m;
}

// The compiled fragment, without a GPU: run the material's own onBeforeCompile
// over a stub carrying the chunk names it splices into. If an injection point
// is ever renamed out from under it, the replace is a silent no-op and the
// string comes back without the block — which is the whole point of looking.
const CHUNKS_FRAG = ['#include <common>', '#include <map_fragment>', '#include <dithering_fragment>'].join('\n');
const CHUNKS_VERT = ['#include <common>', '#include <begin_vertex>', '#include <project_vertex>'].join('\n');
function injected(material) {
  const shader = { uniforms: {}, vertexShader: CHUNKS_VERT, fragmentShader: CHUNKS_FRAG };
  material.onBeforeCompile(shader, null);
  return shader;
}

// ---------------------------------------------------------------------------
section('THE FILM IS DECLARED, AND IT IS THE WATER’S OWN FIELD');

const mat = sealMaterial();
const shader = injected(mat);
check('the wet block reaches the fragment shader', shader.fragmentShader.includes('uWetAmount > 0.0'));
check('...fenced to a lit material, or it is a compile error on the unlit shapes',
  shader.fragmentShader.includes('#ifdef STANDARD'));
check('...and the animated world position reaches the vertex shader',
  shader.vertexShader.includes('vNoiseWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'));

// THE SAME FUNCTION, not a copy of it. Two sets of three sine terms would agree
// on the day they were written; this is what stops them drifting apart.
const water = createWaterMaterial();
const body = CAUSTICS_GLSL.trim();
check('the water samples the shared caustic function', water.fragmentShader.includes(body));
check('...and so does the seal, character for character', shader.fragmentShader.includes(body));

// ---------------------------------------------------------------------------
section('THE ENV IS SHARED BY REFERENCE, NOT COPIED');

const second = sealMaterial();
const shader2 = injected(second);
check('two materials hold the SAME uWetSea object', shader.uniforms.uWetSea === shader2.uniforms.uWetSea);
check('...the same colour object', shader.uniforms.uWetSeaColor === shader2.uniforms.uWetSeaColor);
check('...and their OWN copies of everything else',
  shader.uniforms.uWetAmount !== shader2.uniforms.uWetAmount);

// ---------------------------------------------------------------------------
section('WHAT THE WATER TELLS IT');

// world.js's order, and the order is the point: updateWaterMaterial is what
// resolves liveCaustics for the frame, so reading it first lights every wet
// animal with the previous frame's ocean.
water.uniforms.uSurfaceY.value = 6;
water.uniforms.uBottomY.value = -22;
updateWaterMaterial(water, 12.5);
setNoiseWetEnv(liveCaustics);
const sea = shader.uniforms.uWetSea.value;
check('the vein scale is the water’s own', near(sea.x, water.uniforms.uCausticsScale.value),
  `${sea.x}`);
check('the phase is clock x speed, sampled as the water samples it',
  near(sea.y, 12.5 * water.uniforms.uCausticsSpeed.value), `${sea.y.toFixed(4)}`);
check('the depth falloff is the water’s own', near(sea.z, water.uniforms.uCausticsFalloff.value));
check('the sea span is the still line and the seabed',
  shader.uniforms.uWetSeaSpan.value.x === 6 && shader.uniforms.uWetSeaSpan.value.y === -22);

// THE ONE THAT WAS WRONG. `intensity` is the fill's strength; `light` is the
// time of day. They differ by a factor of CONFIG.caustics.intensity, which is
// 0.28 — small enough that feeding the wrong one looks like a tuning problem.
check('the film rides the day/night bus, NOT the fill’s intensity',
  near(sea.w, liveCaustics.light) && !near(liveCaustics.light, liveCaustics.intensity),
  `light ${liveCaustics.light.toFixed(3)} vs fill intensity ${liveCaustics.intensity.toFixed(3)}`);

// ...and the tuner's off switch has to reach the animals in the same frame it
// reaches the water.
const wasOn = CONFIG.caustics.enabled;
CONFIG.caustics.enabled = false;
updateWaterMaterial(water, 12.5);
setNoiseWetEnv(liveCaustics);
check('caustics off takes the veins off the seal too', shader.uniforms.uWetSea.value.w === 0);
CONFIG.caustics.enabled = wasOn;
updateWaterMaterial(water, 12.5);
setNoiseWetEnv(liveCaustics);

// ---------------------------------------------------------------------------
section('THE SETTINGS, AND WHO IS WEARING THEM');

applyNoiseSettings();
check('the base seal is wet', shader.uniforms.uWetAmount.value === CONFIG.sealShader.wet,
  `${shader.uniforms.uWetAmount.value}`);

// THE SHARKS. enemyGreatWhite and enemyMightyMeg take a `noise:` surface in
// assets.csv, so a base `wet` above 0 shipped them a gloss nobody asked for.
// Their presets opt out, and the opt-out has to survive the tuning merge — a
// saved snapshot carries these preset names and deepMerges into them.
for (const name of ['greatWhite', 'mightyMeg']) {
  const shark = injected(sealMaterial(name));
  applyNoiseSettings();
  check(`the ${name} preset stays dry`, shark.uniforms.uWetAmount.value === 0,
    `${shark.uniforms.uWetAmount.value}`);
}

// `enabled` folds into the amount rather than branching in the shader, so the
// master switch has to take the film with it.
const wasEnabled = CONFIG.sealShader.enabled;
CONFIG.sealShader.enabled = false;
applyNoiseSettings();
check('the noise master switch takes the film with it', shader.uniforms.uWetAmount.value === 0);
CONFIG.sealShader.enabled = wasEnabled;
applyNoiseSettings();

// A preset overriding ONE wet field must not lose the other fourteen — the
// reason these are flat keys rather than a nested block. applyNoiseSettings
// spreads shallowly, and a `wet: {}` object would be replaced whole.
const partial = injected(sealMaterial('__partialTest'));
CONFIG.sealShader.presets.__partialTest = { wetRim: 2.5 };
applyNoiseSettings();
check('a preset can disagree about one wet field alone',
  partial.uniforms.uWetRim.value === 2.5
  && partial.uniforms.uWetGloss.value === CONFIG.sealShader.wetGloss,
  `rim ${partial.uniforms.uWetRim.value}, gloss ${partial.uniforms.uWetGloss.value}`);
delete CONFIG.sealShader.presets.__partialTest;

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll passed.');
process.exit(failures ? 1 : 0);
