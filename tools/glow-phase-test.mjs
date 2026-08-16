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
  BIOLUM_PATTERNS, __shaderSource,
} from '../path/src/systems/biolumSkin.js';
import { updateBeatSync, divisionSeconds } from '../path/src/systems/beatSync.js';
import {
  pulseDemoFor, panDemoFor, PATTERNS_WITHOUT_DRIFT, glowHeadroom, glowContrast, glowBloomSwing, patternPan,
} from '../path/src/systems/glowDebug.js';

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
  // The field offset is a vec3 (it can walk a closed lap now, not just a
  // line), so "how far has it moved" is a distance rather than a difference —
  // and cloned, or `was.drift` would be the live uniform and every comparison
  // below would measure zero against itself.
  const was = { drift: u.uBioDrift.value.clone(), cycle: u.uBioCycle.value, flick: u.uBioFlickerT.value };

  // SAMPLED THROUGH THE WINDOW, NOT JUST AT ITS ENDS, because every one of
  // these clocks WRAPS and the window's length in cycles is not fixed. The
  // audible tempo is ramped against the wall clock (advance() in music.js), so
  // how many beats a simulated 2 seconds covers depends on how fast this
  // process happens to run — and a window that lands on a whole number of
  // cycles reads a perfectly healthy clock as having moved exactly 0.
  //
  // That is not theoretical: taking the endpoints alone, this failed about one
  // run in four for the lanternfish as soon as the sampling order shifted by
  // one preset. The largest deviation across the window cannot alias that way,
  // and it is the stronger claim anyway — a frozen clock reads identical at
  // every sample, which is exactly what the positive control below freezes.
  const moved = { drift: 0, cycle: 0, flick: 0 };
  const STEPS = 8;
  for (let i = 0; i < STEPS; i++) {
    run(2 / STEPS);
    moved.drift = Math.max(moved.drift, u.uBioDrift.value.distanceTo(was.drift));
    moved.cycle = Math.max(moved.cycle, Math.abs(u.uBioCycle.value - was.cycle));
    moved.flick = Math.max(moved.flick, Math.abs(u.uBioFlickerT.value - was.flick));
  }

  // A channel with no amplitude is switched off ON PURPOSE — the crab's shell
  // is pigment, the abyss shark doesn't stutter — so its clock standing still
  // is correct and asserting it moved would be asserting someone's art
  // direction. Each channel is only required to move if it is turned up.
  const channels = [
    ['drift (pattern crawling over the body)', cfg.flow ?? 0, moved.drift],
    ['pulse (the breath)', cfg.pulseAmp ?? 0, moved.cycle],
    ['flicker (the stutter)', cfg.flickerAmp ?? 0, moved.flick],
  ];
  for (const [label, amp, moved] of channels) {
    if (!(amp > 0)) {
      console.log(`  SKIP  ${preset}: ${label} — amplitude 0, off by choice`);
      continue;
    }
    check(`${preset}: ${label} advances`, Math.abs(moved) > 1e-9,
      `moved ${moved.toFixed(4)} at most over 2s, at amplitude ${amp}`);
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

// ---------------------------------------------------------------------------
section('CAN THE BREATH BE SEEN — where each preset sits against the clip');

// The clocks moving is necessary and not sufficient. The pattern is ADDED to
// an LDR composite that clips at 1.0, so a breath whose TROUGH is already
// above 1.0 happens entirely inside white: the uniform changes every frame and
// the pixels never do. See systems/glowDebug.js.
//
// This is REPORTED per preset and not asserted, deliberately. A blown-out core
// is a legitimate look — these were tuned by eye against bloom — so failing the
// suite over it would be failing someone's art direction. What IS asserted is
// the thing with a right answer: that the forcing tool actually forces.
for (const preset of inUse) {
  const cfg = resolve(preset);
  const { lo, hi, clipped } = glowHeadroom(cfg);
  if ((cfg.pulseAmp ?? 0) <= 0) {
    console.log(`  ----  ${preset.padEnd(12)} no breath to see (pulseAmp 0)`);
    continue;
  }
  console.log(`  ${clipped ? 'NOTE' : ' ok '}  ${preset.padEnd(12)} core swings ${lo.toFixed(2)}..${hi.toFixed(2)}`
    + (clipped
      ? '  both ends above the 1.00 clip — the pulse is running but cannot show in the core'
      : '  crosses the clip, visible'));
}

// The demo variant is hand-picked numbers, and hand-picked numbers rot. If it
// ever stops straddling the clip it becomes a button that claims to prove the
// pulse works and shows the same flat white shape as before — worse than not
// having it, because it would be read as evidence.
const demoOn = (preset) => glowHeadroom({ ...resolve(preset), ...pulseDemoFor(resolve(preset)) });
for (const preset of inUse) {
  const cfg = resolve(preset);
  if ((cfg.pulseAmp ?? 0) <= 0 && (pulseDemoFor(cfg).pulseAmp ?? 0) <= 0) continue;
  const { lo, hi, crosses } = demoOn(preset);
  check(`Alt+N forces ${preset} into the visible range`, crosses,
    `demo swings ${lo.toFixed(2)}..${hi.toFixed(2)} against a 1.00 clip`);
}

const anyPulseDemo = pulseDemoFor(resolve(inUse[0]));
check('the demo changes brightness, not timing',
  anyPulseDemo.pulseSpeed != null && !('phaseSpread' in anyPulseDemo) && !('phaseSteps' in anyPulseDemo),
  'it exists to show the clock that is already running, not to install a different one');

// ---------------------------------------------------------------------------
section('CAN THE PAN BE SEEN — how far the pattern travels, and in what');

// Which patterns translate through the noise field, re-derived from the SHADER
// rather than trusted from the list in glowDebug.js. A branch that gains or
// loses `drift` is a one-word edit that would otherwise make that list — and
// every pan figure computed from it — quietly wrong.
// The pattern branches all live in the SURFACE half now — the body was split
// in two when pigment arrived, because paint has to be written before the
// lighting chunks and light has to be added after them. Both halves are joined
// here so this stays a question about the whole shader rather than about
// whichever half the branches happen to sit in today.
const frag = `${__shaderSource.FRAG_SURFACE}\n${__shaderSource.FRAG_EMIT}`;
// The VERTEX injection is not exported — it lives inside attachBiolumSkin — so
// the source text is the only way to check it from here.
const SRC_BIOLUM = readFileSync(new URL('../path/src/systems/biolumSkin.js', import.meta.url), 'utf8');
const branches = [...frag.matchAll(/uBioPattern == (\d+)\)\s*\{([\s\S]*?)(?=\}\s*else if \(uBioPattern|\}\s*\n\s*\/\/ Bloom|\}\s*\n\s*bioMaskV \*=|$)/g)];
const driftless = branches
  .filter(([, , body]) => !body.includes('drift'))
  .map(([, idx]) => BIOLUM_PATTERNS[Number(idx)])
  .filter(Boolean);
check('the shader agrees with PATTERNS_WITHOUT_DRIFT',
  driftless.length === PATTERNS_WITHOUT_DRIFT.length
    && driftless.every((p) => PATTERNS_WITHOUT_DRIFT.includes(p)),
  `shader says [${driftless.join(', ')}], glowDebug says [${PATTERNS_WITHOUT_DRIFT.join(', ')}]`);

// Reported, not asserted, for the same reason as the clip table: a crawl is a
// legitimate authored speed. What the numbers are for is that the two of them
// disagree wildly, and the second is the one people mean by "panning".
for (const preset of inUse) {
  const cfg = resolve(preset);
  const pan = patternPan(cfg);
  const secs = (s) => (Number.isFinite(s) ? `${s.toFixed(1)}s` : 'never');
  if (!pan.pans) {
    console.log(`  ----  ${preset.padEnd(12)} ${cfg.pattern} does not drift — it travels on the breath clock`);
    continue;
  }
  console.log(`  ${Number.isFinite(pan.bodySeconds) ? ' ok ' : 'NOTE'}  ${preset.padEnd(12)} ${String(cfg.pattern).padEnd(8)}`
    + ` feature turns over every ${secs(pan.featureSeconds)}, crosses the body in ${secs(pan.bodySeconds)}`);
}

// The pan demo has one job and it is a timing job, so unlike PULSE_DEMO this
// one IS asserted on rate.
for (const preset of inUse) {
  const forced = patternPan({ ...resolve(preset), ...panDemoFor(resolve(preset)) });
  if (!forced.pans) continue;
  check(`Alt+Shift+N makes ${preset} visibly pan`, forced.featureSeconds < 1,
    `a feature every ${forced.featureSeconds.toFixed(2)}s (crosses the body in ${forced.bodySeconds.toFixed(1)}s)`);
}
check('the pan demo also clears the clip, or there is nothing to watch pan',
  inUse.every((p) => !glowHeadroom({ ...resolve(p), ...panDemoFor(resolve(p)) }).clipped),
  'a pattern whose top is flat white pans as a moving silhouette edge, not as texture');
const anyPanDemo = panDemoFor(resolve(inUse[0]));
check('...and holds the brightness still, so the only motion is the pattern',
  anyPanDemo.pulseAmp === 0 && anyPanDemo.flickerAmp === 0);

// ---------------------------------------------------------------------------
section('VISIBLE WITHOUT A DEBUG KEY — the shipped values, as they load');

// Everything above can pass on a roster nobody can see: the clocks advance, the
// demos force them into view, and normal play still shows flat white fish. These
// are the assertions about the SHIPPED numbers, resolved the way the game
// resolves them — config.js defaults with imported-tuning.json merged over the
// top. That merge is the point. Editing config.js while a saved snapshot pins
// the same key changes nothing at runtime, and nothing anywhere says so.
// THERE ARE TWO PLACES A BREATH CAN SHOW, and this used to know about one.
//
// Asking only whether the core crosses 1.0 is right for a preset tuned near
// that clip and wrong for every preset tuned past it. The shipped set is tuned
// past it on purpose — strength up to 5 — and on an 8-bit target that would
// genuinely be a dead effect. This renderer does not have one: the scene target
// is HalfFloat, the bright pass passes anything over its gate through linearly,
// and the halo therefore keeps swinging at full depth long after the core has
// gone white. Failing those presets was the test describing a pipeline the game
// stopped having, and the fix it implied — pull `strength` back down — would
// have thrown away the look to satisfy the measurement.
//
// So the question is "can you see it breathe", not "does the core cross", and
// either mechanism is a yes. `driveHi/driveLo` is the halo's own swing, derived
// from the real bright-pass shader in glowBloomSwing.
const HALO_SWING = 1.5;
for (const preset of inUse) {
  const cfg = resolve(preset);
  const { lo, hi, crosses } = glowHeadroom(cfg);
  const contrast = glowContrast(cfg);
  const { ratio } = glowBloomSwing(cfg, CONFIG.bloom);
  if ((cfg.pulseAmp ?? 0) <= 0) {
    console.log(`  ----  ${preset}: no breath authored, nothing to see`);
  } else {
    const halo = ratio >= HALO_SWING;
    check(`${preset}: the breath is visible as shipped`, crosses || halo,
      `swings ${lo.toFixed(2)}..${hi.toFixed(2)} against a 1.00 clip — `
      + (crosses
        ? 'the core crosses it'
        : `the core is white all cycle, carried by a ${ratio === Infinity ? '∞' : ratio.toFixed(1)}x halo swing`));
  }
  // WHAT IS LEFT TO MOVE. The interior floor this used to assert (60% of the
  // mask below the clip) belongs to the same near-the-clip regime as `crosses`
  // above: overdrive the core and the blotches inside the silhouette do flatten
  // into one white shape, and the pan is read off the EDGE of that shape
  // instead. That is a weaker read and it is the one these presets were tuned
  // for, so the floor moved to what is actually load-bearing — some part of the
  // body must still sit below the clip, or there is no edge and nothing about
  // the pattern can move at all. 0% is still a hard failure; it is the case
  // where the whole creature is one flat white blob.
  check(`${preset}: the pattern has contrast to move`, contrast > 0,
    `${(contrast * 100).toFixed(0)}% of the mask is below the clip`
    + (contrast < 0.6 ? ' — interior flattened, the pan reads off the silhouette' : ''));
}

for (const preset of inUse) {
  const cfg = resolve(preset);
  const pan = patternPan(cfg);
  // `pans` false is a pattern with no drift term; flow 0 is a preset that
  // asked to hold still. The crab's shell is pigment — a drifting shell would
  // be the bug — so neither is something to assert a speed on.
  if (!pan.pans || (cfg.flow ?? 0) <= 0) {
    console.log(`  ----  ${preset}: static by choice (${!pan.pans ? `${cfg.pattern} has no drift term` : 'flow 0'})`);
    continue;
  }
  // Generous ceilings, sized against how long a creature is actually on
  // screen. The failure these exist for is a pattern sampled at a frequency
  // multiple, where `flow` reads as a normal number and the pattern still
  // takes a minute to travel the body.
  check(`${preset}: the pattern churns within a creature's lifetime`,
    pan.featureSeconds <= 12,
    `a feature turns over every ${pan.featureSeconds.toFixed(1)}s`);
  check(`${preset}: ...and actually travels`, pan.bodySeconds <= 45,
    `crosses the body in ${pan.bodySeconds.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
section('TRAVELLING STRIPES — the bands go somewhere');

// `stripes` is the one pattern whose whole read is a band sweeping the length
// of the animal, and its phase used to be `vBioAxis * 2pi * bands + warp` —
// no time term at all. The bands were pinned to the body and only the fbm warp
// moved, so they shimmered in place forever. `flow` did not help: it feeds the
// warp, which wobbles the band edges rather than moving the bands.
//
// The fix subtracts the breath clock from the AXIS, which is a pure
// translation. That is provable arithmetic rather than something needing a
// renderer, so it is checked here as arithmetic — the same expression the
// shader evaluates, ported.
const STRIPE_SRC = frag.slice(frag.indexOf('uBioPattern == 3'), frag.indexOf('uBioPattern == 4'));
check('the stripe phase carries the clock, not just the axis',
  STRIPE_SRC.includes('vBioAxis - uBioCycle'),
  'without a time term the bands are pinned to the body and only the warp moves');

// The ported phase, with the spatial warp held constant — the warp varies with
// position, so only the sine's phase term is a translation, and that term is
// exactly what decides whether the bands travel.
const bandCount = (scale) => Math.max(1, Math.floor(3.0 / Math.max(0.05, scale) + 0.5));
const stripeAt = (axis, cycle, bands, warp = 0.4) => Math.sin((axis - cycle) * 2 * Math.PI * bands + warp);

{
  const cfg = resolve('abyssHunter');
  const bands = bandCount(cfg.scale);

  // TRANSLATION: the value at (axis, cycle) has to reappear at (axis+d,
  // cycle+d) for any d. That is what "a band moves one body length per breath"
  // means, stated so it cannot be satisfied by a pattern that merely wobbles.
  let worst = 0;
  for (const a of [0, 0.13, 0.37, 0.62, 0.91]) {
    for (const c of [0, 0.25, 0.8, 1.4]) {
      for (const d of [0.05, 0.2, 0.5]) {
        worst = Math.max(worst, Math.abs(stripeAt(a, c, bands) - stripeAt(a + d, c + d, bands)));
      }
    }
  }
  check('the band pattern translates along the body, one length per breath',
    worst < 1e-9, `largest mismatch ${worst.toExponential(1)} across axis/cycle/offset samples`);

  // WRAP CONTINUITY: the clock wraps at 2, so the phase at cycle 2 has to be
  // the phase at cycle 0 or the whole pattern snaps sideways, several times a
  // minute, forever.
  let snap = 0;
  for (const a of [0, 0.13, 0.37, 0.62, 0.91]) {
    snap = Math.max(snap, Math.abs(stripeAt(a, 2, bands) - stripeAt(a, 0, bands)));
  }
  check('...and the clock wrapping at 2 is invisible', snap < 1e-9,
    `largest jump ${snap.toExponential(1)} with ${bands} whole bands`);

  // The positive control for the rounding. With the raw 3.0/scale the band
  // count is 5.45 on this body and the wrap moves the pattern visibly — so the
  // floor() is load-bearing, not tidiness.
  const raw = 3.0 / cfg.scale;
  let rawSnap = 0;
  for (const a of [0, 0.13, 0.37, 0.62, 0.91]) {
    rawSnap = Math.max(rawSnap, Math.abs(stripeAt(a, 2, raw) - stripeAt(a, 0, raw)));
  }
  check('...which the un-rounded band count would NOT be', rawSnap > 0.1,
    `raw ${raw.toFixed(2)} bands jumps by up to ${rawSnap.toFixed(2)} at every wrap`);

  // How long a band actually takes to cross, in seconds, from the clock it
  // rides. A traverse nobody can wait out is the same as no traverse.
  const traverse = cfg.pulseSync && cfg.pulseSync !== 'free'
    ? divisionSeconds(cfg.pulseSync)
    : (2 * Math.PI) / Math.max(1e-6, cfg.pulseSpeed ?? 1);
  check('a band crosses the whole animal in a watchable time', traverse > 0 && traverse <= 20,
    `${traverse.toFixed(1)}s per traverse on ${cfg.pulseSync ?? 'free'}, with ${bands} bands on the body`);
}

// ---------------------------------------------------------------------------
section('THE SCHOOL WAVE — one field in the water, not one clock per fish');

// The only term in this shader sampled in WORLD space. Its whole claim is that
// a shoal drifting through it lights a few fish at a time, in the order the
// water reaches them — which requires two things that pull in opposite
// directions from everything else here:
//
//   1. every creature reads the SAME travel value on a given frame, so the
//      field is one field. A per-material clock, or the per-instance phase
//      offset that the breath and flicker deliberately carry, would give each
//      fish a private wave and the effect would collapse into "they flicker
//      independently" — which is what the other clocks already do.
//   2. the value each fish sees still differs, because their POSITIONS differ.
//
// Both are checked. Only the first is visible in the uniforms; the second is
// the shader sampling vBioWorld, so it is checked as arithmetic against the
// same fbm the shader uses would require porting the noise — instead the
// wiring is checked (the varying is written, declared in both stages, and fed
// a world position) and the compile/link is proved by the GL page in the
// scratchpad. See the note in FRAG_BODY.
{
  const school = [];
  for (let i = 0; i < 4; i++) {
    const [b] = [glowingBody('lantern')];
    instantiateBiolumSkin(b);
    school.push(b);
  }
  applyBiolumSkinSettings();
  run(1);

  const ts = school.map((b) => b.material.userData.__bioSkinUniforms.uBioSchoolT.value);
  check('every creature reads the same field position on a frame',
    new Set(ts.map((t) => t.toFixed(6))).size === 1,
    `${ts.map((t) => t.toFixed(3)).join(', ')} — a spread here means each fish has its own wave`);

  const before = ts[0];
  run(2);
  const after = school[0].material.userData.__bioSkinUniforms.uBioSchoolT.value;
  const speed = CONFIG.biolumSkin?.base?.schoolSpeed ?? 0;
  check('the field drifts through the water', speed > 0 ? after > before : after === before,
    `travelled ${(after - before).toFixed(2)} world units in 2s at ${speed}/s`);

  // The wave is a property of the ocean, so it must NOT pick up the
  // per-individual offset that keeps the breath out of lockstep. Same numbers,
  // different intent — and getting this wrong looks like the feature working
  // right up until you notice the shoal never lights in a wave.
  const offsets = school.map((b) => b.material.userData.__bioSkinOffset ?? 0);
  check('...and does not inherit the per-individual phase offset',
    new Set(offsets.map((o) => o.toFixed(4))).size > 1 && new Set(ts.map((t) => t.toFixed(6))).size === 1,
    `phase offsets differ (${offsets.map((o) => o.toFixed(2)).join(', ')}) while the field value does not`);
}

// The wiring, on the shader side. A varying written in the vertex stage but
// missing from either declaration list does not warn — it fails the program
// link, and every creature wearing a glow skin renders as nothing at all.
{
  const vertexPart = SRC_BIOLUM.slice(
    SRC_BIOLUM.indexOf('shader.vertexShader = shader.vertexShader'),
    SRC_BIOLUM.indexOf('shader.fragmentShader = shader.fragmentShader'));
  check('vBioWorld is declared in the vertex stage', vertexPart.includes('varying vec3 vBioWorld'));
  check('...and written from the model matrix', vertexPart.includes('modelMatrix * vec4(transformed'));
  check('...and declared in the fragment stage too', __shaderSource.GLSL.includes('varying vec3  vBioWorld')
    || __shaderSource.GLSL.includes('varying vec3 vBioWorld'));
  check('...and actually sampled by the pattern code', frag.includes('vBioWorld /'));
}

// ---------------------------------------------------------------------------
section('ONE SOURCE OF TRUTH — nothing shadowing the values config.js owns');

// Asserted against the RESOLVED config rather than against the snapshot file,
// which is the only version that can be trusted: the snapshot is rewritten
// every time anyone saves, and while a game is open it will keep re-acquiring
// whatever was in memory. Reading the file would make this a test of when
// someone last pressed save.
//
// `glow` is declared on the base ONLY, and documented there as the one knob
// that moves the family's bloom together. A tuner save writes a resolved copy
// of every preset, which stamped `glow` onto all six — and since a preset
// resolves as { ...base, ...preset }, those copies shadowed the base outright.
// The base slider did nothing and the presets sat at whatever multiplier was
// current the day the snapshot was written, which is what put every creature's
// whole breath above the clip. withoutTableOwnedKeys now strips it on the way
// in, so this checks the strip is still doing its job.
//
// Per-preset `strength` is NOT part of this: it has a real slider, a real
// per-species default in config.js, and is meant to differ between creatures.
// The tuner owning it is correct.
for (const preset of inUse) {
  const cfg = resolve(preset);
  check(`${preset} does not shadow the family's bloom knob`,
    (cfg.glow ?? 1) === (base.glow ?? 1),
    `preset resolves glow ${cfg.glow}, base says ${base.glow}`);
}

// A preset the snapshot keeps alive after config.js has dropped it resolves,
// looks intentional in the tuner, and is mentioned in no source file.
const snapshot = JSON.parse(readFileSync(new URL('../path/src/imported-tuning.json', import.meta.url), 'utf8'));
const orphans = Object.keys(snapshot.biolumSkin?.presets ?? {})
  .filter((n) => !(n in (CONFIG.biolumSkin?.presets ?? {})));
check('the snapshot has no presets config.js has dropped', orphans.length === 0,
  orphans.join(', '));

console.log(failures === 0 ? '\nPASS — all checks' : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
