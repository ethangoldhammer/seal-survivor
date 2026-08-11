#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:glowphase
//
// The glowing creatures' patterns have to MOVE — drift across the body, breathe
// on the pulse, stutter on the flicker — and a school has to move out of step
// with itself. All of that is uniform writes from updateBiolumSkin, none of it
// is visible to any other test, and one of its failure modes is silent in a way
// worth spelling out:
//
//   EVERY PRESET IN USE IS BEAT-SYNCED. A synced clock is derived ABSOLUTELY
//   from the beat transport (systems/beatSync.js), not integrated from its own
//   last value. So if updateBeatSync stops being called, or is called AFTER
//   updateBiolumSkin instead of before, the transport reads 0 forever and every
//   pulse and flicker in the game freezes mid-cycle. Nothing throws, nothing
//   logs, the fish still spawn, and the drift keeps moving so it doesn't even
//   look dead — it looks like the pattern just doesn't do very much.
//
//   This is not hypothetical: the probe this test grew out of reproduced it by
//   forgetting one line, and read as a broken shader for a good ten minutes.
//
// So the order in main.js is asserted from the source, and the freeze is
// reproduced deliberately below as a positive control — a test that only
// checks the working path can't tell you the control was ever meaningful.
//
//   node --import ./tools/vite-loader.mjs tools/glow-phase-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';
import {
  attachBiolumSkin, instantiateBiolumSkin, applyBiolumSkinSettings, updateBiolumSkin,
} from '../path/src/systems/biolumSkin.js';
import { updateBeatSync } from '../path/src/systems/beatSync.js';

const dt = 1 / 60;
let failures = 0;

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// A stand-in body. The geometry only has to have a bounding box for the
// bind-pose attributes to be baked off; nothing here draws.
function glowingBody(preset) {
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 0.2), mat);
  attachBiolumSkin(mat, mesh, preset);
  return mesh;
}

// One template, N clones — exactly what createVisual does for a school.
function school(preset, n) {
  const template = glowingBody(preset);
  const bodies = [];
  for (let i = 0; i < n; i++) {
    const c = template.clone();
    instantiateBiolumSkin(c);
    bodies.push(c);
  }
  applyBiolumSkinSettings();
  return bodies;
}

// main.js's order: transport first, then everything that reads it.
function run(seconds, { tickTransport = true } = {}) {
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    if (tickTransport) updateBeatSync(dt);
    updateBiolumSkin(dt);
  }
}

// Only the presets something actually wears. An unused preset drifting out of
// tune is not a bug anyone can see.
const inUse = [...new Set(Object.values(ASSETS).map((a) => a.biolumSkin).filter((p) => typeof p === 'string'))];
const base = CONFIG.biolumSkin?.base ?? {};
const resolve = (name) => ({ ...base, ...(CONFIG.biolumSkin?.presets?.[name] ?? {}) });

// ---------------------------------------------------------------------------
section('THE CLOCKS MOVE — every preset a creature actually wears');

check('some preset is in use at all', inUse.length > 0, inUse.join(', '));

for (const preset of inUse) {
  const cfg = resolve(preset);
  const [body] = school(preset, 1);
  const u = body.material.userData.__bioSkinUniforms;
  const was = { drift: u.uBioDrift.value, cycle: u.uBioCycle.value, flick: u.uBioFlickerT.value };
  run(2);

  // A channel with no amplitude is switched off ON PURPOSE — the crab's shell
  // is pigment, the abyss shark doesn't stutter — so its clock standing still
  // is correct and asserting it moved would be asserting someone's art
  // direction. Each channel is only required to move if it is turned up.
  const channels = [
    ['drift (pattern crawling over the body)', cfg.flow ?? 0, u.uBioDrift.value - was.drift],
    ['pulse (the breath)', cfg.pulseAmp ?? 0, u.uBioCycle.value - was.cycle],
    ['flicker (the stutter)', cfg.flickerAmp ?? 0, u.uBioFlickerT.value - was.flick],
  ];
  for (const [label, amp, moved] of channels) {
    if (!(amp > 0)) {
      console.log(`  SKIP  ${preset}: ${label} — amplitude 0, off by choice`);
      continue;
    }
    check(`${preset}: ${label} advances`, Math.abs(moved) > 1e-9,
      `moved ${moved.toFixed(4)} over 2s at amplitude ${amp}`);
  }
}

// ---------------------------------------------------------------------------
section('A SCHOOL IS NOT ONE ANIMAL — phases spread across individuals');

for (const preset of inUse) {
  const cfg = resolve(preset);
  const n = 8;
  const bodies = school(preset, n);
  run(1);

  check(`${preset}: each body has its own material`,
    new Set(bodies.map((b) => b.material)).size === n,
    'a shared material would put the whole school in lockstep whatever the phases say');

  const phases = new Set(bodies.map((b) => b.material.userData.__bioSkinUniforms.uBioCycle.value.toFixed(5)));
  const steps = cfg.phaseSteps ?? 0;
  if (!(cfg.phaseSpread > 0)) {
    console.log(`  SKIP  ${preset}: phase spread — phaseSpread 0, lockstep on purpose`);
    continue;
  }
  // Quantised on purpose: `phaseSteps` snaps each individual to a slot so the
  // school breathes ON the beat grid rather than a random fraction off it. So
  // the bar is "more than one group", not "n distinct values" — with 4 steps,
  // eight fish SHOULD collapse into four.
  check(`${preset}: the school breathes in more than one group`, phases.size > 1,
    `${phases.size} distinct phases across ${n} bodies${steps > 0 ? `, quantised to ${steps} slots` : ', continuous'}`);
}

// ---------------------------------------------------------------------------
section('THE ORDER IN MAIN.JS — what makes the synced clocks work at all');

const mainSrc = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
const beatAt = mainSrc.indexOf('updateBeatSync(rawDt)');
const glowAt = mainSrc.indexOf('updateBiolumSkin(rawDt)');
check('main.js ticks the beat transport', beatAt > 0);
check('main.js ticks the glow', glowAt > 0);
check('...and the transport goes FIRST', beatAt > 0 && glowAt > 0 && beatAt < glowAt,
  'a synced clock reads the transport absolutely, so a stale one freezes every pulse in the game');

// The positive control. Same materials, same frames, transport never ticked —
// if this does NOT freeze, the ordering assertion above is guarding nothing.
const synced = inUse.find((p) => resolve(p).pulseSync && (resolve(p).pulseAmp ?? 0) > 0);
if (synced) {
  const [body] = school(synced, 1);
  const u = body.material.userData.__bioSkinUniforms;
  // One frame to settle first. A fresh uniform starts at 0 and jumps to
  // transport/beats on its first update, so sampling before that measures the
  // material waking up rather than the clock running — which is a change, and
  // would make this control pass for the wrong reason.
  run(dt, { tickTransport: false });
  const was = u.uBioCycle.value;
  run(2, { tickTransport: false });
  check('without the transport, a synced pulse freezes — and silently',
    Math.abs(u.uBioCycle.value - was) < 1e-9,
    `${synced} held at ${u.uBioCycle.value.toFixed(4)} for 2s with no error and no warning`);
} else {
  console.log('  SKIP  positive control — no preset in use has a synced pulse');
}

console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
