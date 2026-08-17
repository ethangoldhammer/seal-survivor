#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chargefx
//
// What a strike wind-up does to the seal itself:
//
//   THE RIM     systems/outlines.js — the player's outline shell throbs while
//               power banks and blows out on the release.
//   THE VENT    systems/bubbles.js — every bubble emitter on the body opens at
//               once, harder the more power is banked, and thrown out the BACK
//               of the animal like the boost charge behind a vehicle.
//   THE TREMBLE entities/player.js — three channels of buzz on the model, two
//               angular and one positional, none of them on the hitbox.
//   THE BURST   the let-go: CONFIG.emitters.chargeBurst, fired from main.js on
//               the frame the dash launches.
//
// All of them are pure state machines over dt, which is exactly the kind of thing that
// looks right in a screenshot and is wrong over time — a pulse that never
// returns to the base look leaves the rim permanently lit, a vent whose carry
// is mishandled dumps a second of bubbles in one frame after a hitch. So they
// are driven here frame by frame and MEASURED, off the real material uniforms
// and the real particle ring buffer, with no GL context anywhere.
//
// Everything expected is computed from CONFIG rather than hardcoded: saved
// tuning wins over the config defaults (imported-tuning.json is merged at
// import), so a hardcoded 5.6 here would be a test of the tuning file.
//
// What it cannot tell you: whether the throb rate FEELS like a wind-up. That is
// a controller in your hands.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  attachPlayerOutline,
  applyPlayerOutline,
  updatePlayerOutline,
  flarePlayerOutline,
  flashPlayerOutlineDamage,
  resetPlayerOutlineCharge,
} from '../path/src/systems/outlines.js';
import { updateBubbles, resetBubbles } from '../path/src/systems/bubbles.js';
import { initParticles, resetParticles, particleCount, emit } from '../path/src/entities/particles.js';
import { attachNoiseShader } from '../path/src/systems/noiseShader.js';
// The wind-up tremble is composed inside updatePlayer, alongside the mirror and
// the barrel roll — it cannot be measured anywhere else without reimplementing
// the composition, which would be a test of the copy.
import { player, updatePlayer, resetPlayer, recomputeStats } from '../path/src/entities/player.js';
import { updateChargeSkin, resetChargeSkin, chargeCrossed } from '../path/src/systems/chargeSkin.js';
// Written directly rather than simulated: the sun's elevation is derived from
// the arena bounds, which a headless harness has none of, and `skyLight` IS
// the only thing the gate reads from the sky.
import { skyLight } from '../path/src/systems/daylight.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, '../path/src/main.js');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// ===========================================================================
// THE RIM
// ===========================================================================

// A stand-in for the seal's body: one mesh, so one shell, which is all the
// per-frame write path needs to be exercised. Under a scaled parent on purpose
// — thickness is specified in WORLD units and divided by the accumulated scale
// on the way to the shader, and that division has to survive the boost.
const PARENT_SCALE = 2;
const holder = new THREE.Group();
holder.scale.setScalar(PARENT_SCALE);
const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
holder.add(body);

attachPlayerOutline(body);
const shell = body.children.find((o) => o.userData.__isOutline);
const shellMat = shell?.material;

const glowOf = () => shellMat.color.r;
const thickOf = () => shellMat.userData.__outlineThickness.value;

section('RIM — the shell exists and starts at the tuned look');
check('one outline shell was attached', !!shellMat);
applyPlayerOutline();
const BASE_GLOW = glowOf();
const BASE_THICK = thickOf();
check('base glow is non-zero (so ratios below mean something)', BASE_GLOW > 0, `${BASE_GLOW.toFixed(3)}`);
check('thickness is world units / accumulated scale',
  Math.abs(BASE_THICK - (CONFIG.playerOutline.thickness / PARENT_SCALE)) < 1e-9,
  `${BASE_THICK} vs ${CONFIG.playerOutline.thickness}/${PARENT_SCALE}`);

const OC = CONFIG.strike.charge.outline;

// Run `seconds` of wind-up at a fixed power and report what the rim did.
function windUp(power, seconds, dt = 1 / 120) {
  resetPlayerOutlineCharge();
  const glow = [];
  const thick = [];
  for (let t = 0; t < seconds; t += dt) {
    updatePlayerOutline(dt, power);
    glow.push(glowOf());
    thick.push(thickOf());
  }
  return { glow, thick };
}

// Local maxima of a sampled signal, ignoring flat noise. Counting peaks is how
// the pulse RATE is measured without assuming the waveform.
function peaks(samples, eps = 1e-6) {
  let n = 0;
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i] - samples[i - 1] > eps && samples[i] - samples[i + 1] >= 0) n++;
  }
  return n;
}

section('RIM — winding up');
{
  const full = windUp(1, 2);
  const max = Math.max(...full.glow);
  const min = Math.min(...full.glow);
  check('glow rises above the tuned look', max > BASE_GLOW * 1.05,
    `peak ${max.toFixed(2)} vs base ${BASE_GLOW.toFixed(2)}`);
  check('and never dips below it — the pulse ADDS, it does not modulate down',
    min >= BASE_GLOW - 1e-9, `trough ${min.toFixed(3)}`);
  check('peak glow is base + glowAdd at full power',
    Math.abs(max - (BASE_GLOW + OC.glowAdd)) < 1e-3,
    `${max.toFixed(3)} vs ${(BASE_GLOW + OC.glowAdd).toFixed(3)}`);
  check('it actually throbs rather than sitting at one value',
    max - min > OC.glowAdd * 0.4, `swing ${(max - min).toFixed(3)}`);
  check('the rim swells too, in world units over the scale',
    Math.abs(Math.max(...full.thick) - (CONFIG.playerOutline.thickness + OC.thicknessAdd) / PARENT_SCALE) < 1e-6);
}

{
  // A wind-up has to GROW out of the untouched rim, or its first frame is a
  // visible pop. Driven the way the game drives it — banked power ramping from
  // zero over charge.time — because that ramp is half of what makes it smooth;
  // slamming power to 1 on frame one is not a state the player can reach.
  resetPlayerOutlineCharge();
  const dt = 1 / 120;
  let power = 0;
  let prev = BASE_GLOW;
  let worstJump = 0;
  for (let t = 0; t < CONFIG.strike.charge.time; t += dt) {
    power = Math.min(1, power + dt / CONFIG.strike.charge.time);
    updatePlayerOutline(dt, power);
    worstJump = Math.max(worstJump, Math.abs(glowOf() - prev));
    prev = glowOf();
  }
  // A frame of the throb at its steepest is the honest ceiling here: hzMax
  // cycles of amplitude glowAdd*pulseDepth, so pi*amp*hz*dt per frame.
  const steepest = Math.PI * OC.glowAdd * OC.pulseDepth * OC.hzMax * dt;
  check('a wind-up grows out of the base look with no jump on any frame',
    worstJump < steepest * 1.6, `worst step ${worstJump.toFixed(4)}, throb step ${steepest.toFixed(4)}`);
}

{
  const weak = windUp(0.25, 2);
  const strong = windUp(1, 2);
  check('a bigger bank glows brighter',
    Math.max(...strong.glow) > Math.max(...weak.glow) * 1.5,
    `${Math.max(...weak.glow).toFixed(2)} -> ${Math.max(...strong.glow).toFixed(2)}`);
  check('...and swells wider',
    Math.max(...strong.thick) > Math.max(...weak.thick));
}

{
  // The rate climb is the part that reads as urgency. Measured as peaks per
  // second at each end of the ramp, over enough seconds to count several.
  const SECS = 4;
  const slow = peaks(windUp(0.02, SECS).glow) / SECS;
  const fast = peaks(windUp(1, SECS).glow) / SECS;
  check('pulse rate at the start of a wind-up is about hzMin',
    Math.abs(slow - OC.hzMin) < 0.6, `${slow.toFixed(2)}Hz vs ${OC.hzMin}`);
  check('pulse rate at full power is about hzMax',
    Math.abs(fast - OC.hzMax) < 0.6, `${fast.toFixed(2)}Hz vs ${OC.hzMax}`);
  check('and it accelerates as power banks', fast > slow * 1.5);
}

section('RIM — the release flare, and getting back to the base look');
{
  resetPlayerOutlineCharge();
  // Wind up, then let go: no power held any more, one flare fired.
  for (let t = 0; t < 1; t += 1 / 120) updatePlayerOutline(1 / 120, 1);
  const heldPeak = glowOf();
  flarePlayerOutline(1);
  updatePlayerOutline(1 / 120, 0);
  const flarePeak = glowOf();
  check('the release spikes past anything the wind-up reached',
    flarePeak > BASE_GLOW + OC.glowAdd, `${flarePeak.toFixed(2)} vs held ${heldPeak.toFixed(2)}`);

  // ...and is gone within flareTime, all the way back to the tuned look rather
  // than to "close enough" — a rim left a few percent hot never recovers.
  let t = 0;
  while (t < OC.flareTime + 0.1 && glowOf() > BASE_GLOW + 1e-9) {
    updatePlayerOutline(1 / 120, 0);
    t += 1 / 120;
  }
  check('the flare eases out inside flareTime', t <= OC.flareTime + 1 / 60, `${t.toFixed(3)}s`);
  check('and lands exactly back on the tuned glow', Math.abs(glowOf() - BASE_GLOW) < 1e-9);
  check('and on the tuned thickness', Math.abs(thickOf() - BASE_THICK) < 1e-12);
}

{
  // A fizzle should not look like a commitment.
  const peakFor = (power) => {
    resetPlayerOutlineCharge();
    flarePlayerOutline(power);
    updatePlayerOutline(1 / 120, 0);
    return glowOf();
  };
  const small = peakFor(0.35);
  const big = peakFor(1);
  check('the flare is scaled by the power actually spent', big > small * 1.5,
    `${small.toFixed(2)} -> ${big.toFixed(2)}`);
}

section('RIM — idle, and not fighting the tuner');
{
  resetPlayerOutlineCharge();
  applyPlayerOutline();
  // Nothing held, nothing flaring: the update must not touch the materials at
  // all, or every slider drag would be overwritten on the next frame.
  shellMat.color.setRGB(0.123, 0.456, 0.789);
  for (let i = 0; i < 30; i++) updatePlayerOutline(1 / 60, 0);
  check('an idle frame writes nothing to the shell',
    Math.abs(shellMat.color.r - 0.123) < 1e-6, `${shellMat.color.r}`);
  applyPlayerOutline();
}

{
  // Both switches, from either side.
  const wasCharge = OC.enabled;
  const wasOutline = CONFIG.playerOutline.enabled;
  try {
    OC.enabled = false;
    resetPlayerOutlineCharge();
    flarePlayerOutline(1);
    for (let i = 0; i < 30; i++) updatePlayerOutline(1 / 60, 1);
    check('charge.outline.enabled = false leaves the rim alone',
      Math.abs(glowOf() - BASE_GLOW) < 1e-9, `${glowOf().toFixed(3)}`);
    OC.enabled = wasCharge;

    CONFIG.playerOutline.enabled = false;
    applyPlayerOutline();
    resetPlayerOutlineCharge();
    for (let i = 0; i < 30; i++) updatePlayerOutline(1 / 60, 1);
    check('an outline switched off entirely stays switched off', shell.visible === false);
  } finally {
    OC.enabled = wasCharge;
    CONFIG.playerOutline.enabled = wasOutline;
    applyPlayerOutline();
    resetPlayerOutlineCharge();
  }
}

// ===========================================================================
// THE INK LINE — the flat black rim drawn INSIDE the glowing one.
//
// What cannot be checked here is the picture: whether the ink actually covers
// the glow's inner edge is decided by the depth test between two inverted
// hulls, and no Node harness has a depth buffer. That was measured in a real
// GL context by reading a scanline back with gl.readPixels — background, then
// 5px of glow, then 2px of ink, then the seal — and the ordering falls out of
// the geometry: the thinner hull's back faces are nearer the camera wherever
// the two overlap.
//
// What IS checkable is everything that would silently take the effect away:
// the second shell existing at all, being thinner than the rim (equal or wider
// and it swallows the glow it is supposed to sit inside), and — the one that
// would drift — staying out of the way of every driver in outlines.js. The ink
// is the seal's drawn edge; a line that flared with the wind-up reads as the
// drawing wobbling rather than as the light behind it flaring.
// ===========================================================================
section('THE INK LINE');
{
  const shells = body.children.filter((o) => o.userData.__isOutline);
  check('a second shell was attached', shells.length === 2, `${shells.length} shell(s)`);

  // Order is load-bearing, not incidental: the glow is built first so that a
  // bare find() for "an outline" — which is how the rest of this file reaches
  // for it — lands on the rim rather than on the ink.
  const [glowShell, inkShell] = shells;
  check('the glow is the first of them', glowShell === shell);

  const inkMat = inkShell.material;
  const inkThick = () => inkMat.userData.__outlineThickness.value;
  const inkCfg = CONFIG.playerOutline.inner;

  // DARK AND NEUTRAL, not literally zero. The shipped ink is #212121 — a lifted
  // black, which is what it is for: an absolute 0 against a bloomed rim reads as
  // a hole cut in the picture, and a few points of lift keeps it a line. What
  // the ink must not become is either bright (a second rim, and the fringe stops
  // reading as a fringe) or coloured (two hues fighting on one silhouette), so
  // those are what this asks about instead of an exact value somebody has to
  // come back and edit every time they nudge it.
  const { r, g, b } = inkMat.color;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  check('the ink is dark', Math.max(r, g, b) <= 0.2,
    `peak channel ${Math.max(r, g, b).toFixed(3)}`);
  check('...and neutral, not a second colour', spread <= 0.05,
    `channel spread ${spread.toFixed(3)}`);
  check('...at its own width, in world units over the scale',
    Math.abs(inkThick() - inkCfg.thickness / PARENT_SCALE) < 1e-9,
    `${inkThick()} vs ${inkCfg.thickness}/${PARENT_SCALE}`);
  // The whole effect is the DIFFERENCE between the two hulls. At equal widths
  // there is no second band at all — whichever loses the depth test is simply
  // not on screen, and the seal gets one outline instead of two.
  //
  // WHICH ONE IS WIDER IS A LOOK, NOT A RULE. This used to require the ink to be
  // the thinner of the two, on the original design of a glow fringe around an
  // ink line. The shipped tuning is the other way up — ink 0.105 against a 0.01
  // rim — and that is a legible outline either way: the hulls are offset along
  // the normal and the thinner one's back faces are nearer the camera, so it
  // wins the overlap and the wider one becomes the outer band. Inverted, that
  // reads as a bold black outline with the glow as a bright line hugging the
  // body, which is a drawing decision rather than a broken one. What is NOT
  // survivable is the two being the same, so that is what is asked here.
  const [thin, thick] = [Math.min(inkThick(), thickOf()), Math.max(inkThick(), thickOf())];
  check('...at a different width from the rim, so both bands read',
    thick > thin * 1.2, `ink ${inkThick()} vs rim ${thickOf()}`);
  check('it draws after the glow and before the seal',
    inkShell.renderOrder > glowShell.renderOrder && inkShell.renderOrder < (body.renderOrder ?? 0),
    `glow ${glowShell.renderOrder}, ink ${inkShell.renderOrder}, seal ${body.renderOrder ?? 0}`);

  // A wind-up, a release flare and a hit, all at once — everything in
  // outlines.js that writes to a shell. The rim has to move; the ink must not.
  resetPlayerOutlineCharge();
  applyPlayerOutline();
  const inkBefore = inkMat.color.clone();
  const inkWidthBefore = inkThick();
  for (let t = 0; t < 0.5; t += 1 / 120) updatePlayerOutline(1 / 120, 1);
  flarePlayerOutline(1);
  flashPlayerOutlineDamage(1);
  updatePlayerOutline(1 / 120, 1);
  check('the rim is lit by all of that', glowOf() > BASE_GLOW * 1.05, `${glowOf().toFixed(2)}`);
  check('...and the ink did not move — still black', inkMat.color.equals(inkBefore));
  check('...still the same width', Math.abs(inkThick() - inkWidthBefore) < 1e-12);
  resetPlayerOutlineCharge();

  // The toggle, from both sides. The ink rides the rim's own switch as well as
  // its own: a black seal-shaped smudge with no glow behind it is not a look
  // anyone asked for.
  const wasInk = inkCfg.enabled;
  const wasOutline = CONFIG.playerOutline.enabled;
  try {
    inkCfg.enabled = false;
    applyPlayerOutline();
    check('the toggle hides the ink', inkShell.visible === false);
    check('...and leaves the glowing rim alone', glowShell.visible === true);

    inkCfg.enabled = true;
    CONFIG.playerOutline.enabled = false;
    applyPlayerOutline();
    check('switching the rim off takes the ink with it', inkShell.visible === false);
  } finally {
    inkCfg.enabled = wasInk;
    CONFIG.playerOutline.enabled = wasOutline;
    applyPlayerOutline();
  }
}

// ===========================================================================
// THE VENT
// ===========================================================================

const fxScene = new THREE.Scene();
initParticles(fxScene);

// The ring buffer's own attributes, which is where a DIRECTION test has to
// read: particleCount() says how many bubbles there are and nothing about
// where any of them went. Held as the live attribute rather than a copy — emit
// writes straight into these arrays.
const ring = fxScene.children.find((o) => o.isPoints).geometry.attributes;

// Every particle emitted since the last reset, as plain vectors. Turbulence
// lives entirely in the vertex shader, so aVelocity is exactly what emit()
// threw — no GL context needed to read the aim of a burst.
function shots() {
  const out = [];
  for (let i = 0; i < particleCount(); i++) {
    out.push({
      vx: ring.aVelocity.array[i * 3],
      vy: ring.aVelocity.array[i * 3 + 1],
      life: ring.aLife.array[i],
      size: ring.aSize.array[i],
      speed: Math.hypot(ring.aVelocity.array[i * 3], ring.aVelocity.array[i * 3 + 1]),
    });
  }
  return out;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const rigBoth = { anchors: { mouth: { x: 0, y: 0 }, tail: { x: 0, y: 0 } } };
const rigMouth = { anchors: { mouth: { x: 0, y: 0 } } };
const rigTail = { anchors: { tail: { x: 0, y: 0 } } };
const STILL = { x: 0, y: 0 };
const FACING_RIGHT = { x: 1, y: 0 }; // the seal pointing along +X

// Particles emitted by `seconds` of holding at a fixed banked power. The breath
// timer is reset each run so its 1-2s puff can't land inside one sample and not
// another; `charge` is the only thing that varies.
function vent(charge, seconds, rig = rigBoth, velocity = STILL, dt = 1 / 60, above = false, forward = null) {
  resetBubbles();
  resetParticles();
  for (let t = 0; t < seconds; t += dt) updateBubbles(dt, rig, velocity, above, charge, forward);
  return particleCount();
}

const BC = CONFIG.bubbles.charge;
// Particles in one full-power burst: both emitters, each emitter's own count
// scaled by the vent's size multiplier AND by the global sprite-thinning knob
// (bubbles are sprites, not goo), rounded the way emit() rounds it.
const DENSITY = CONFIG.fx.spriteDensity ?? 1;
const perEmitter = (name, scale) => Math.max(1, Math.round(CONFIG.emitters[name].count * scale * BC.scaleMax * DENSITY));
const PER_BURST = perEmitter('breathBubbles', CONFIG.bubbles.breath.scale)
  + perEmitter('wakeBubbles', CONFIG.bubbles.wake.scale);

section('VENT — a wind-up opens both emitters');
{
  const idle = vent(0, 1);
  const held = vent(1, 1);
  check('nothing extra comes out when no strike is being wound up',
    idle < 40, `${idle} particles in a still second`);
  check('a full hold pours', held > idle * 10, `${idle} -> ${held} particles/sec`);
}

{
  // Both anchors, separately — "all the bubble emitters" is the ask, and a vent
  // that quietly only used the mouth would still pass a total-count test.
  const mouthOnly = vent(1, 1, rigMouth);
  const tailOnly = vent(1, 1, rigTail);
  const both = vent(1, 1, rigBoth);
  check('the mouth vents', mouthOnly > 100, `${mouthOnly}`);
  check('the tail vents', tailOnly > 100, `${tailOnly}`);
  check('and both fire together, not one or the other',
    Math.abs(both - (mouthOnly + tailOnly)) < both * 0.02,
    `${mouthOnly} + ${tailOnly} vs ${both}`);
}

section('VENT — the longer it is held, the more comes out');
{
  // The real shape of a hold: banked power ramps 0 -> 1 over charge.time, so
  // each successive second of a wind-up must out-bubble the one before it.
  const perSecond = [];
  resetBubbles();
  resetParticles();
  const dt = 1 / 60;
  let power = 0;
  let last = 0;
  for (let s = 0; s < 3; s++) {
    for (let t = 0; t < 1; t += dt) {
      // Banked over three seconds rather than the shipped charge.time, so the
      // ramp is still climbing in the third second — at the real rate this
      // saturates inside the first one and every second after it ties.
      power = Math.min(1, power + dt / 3);
      updateBubbles(dt, rigBoth, STILL, false, power);
    }
    perSecond.push(particleCount() - last);
    last = particleCount();
  }
  check('each second of a hold vents more than the one before',
    perSecond[1] > perSecond[0] && perSecond[2] > perSecond[1], perSecond.join(' -> '));
}

{
  const steps = [0.1, 0.35, 0.7, 1].map((p) => vent(p, 1));
  let monotonic = true;
  for (let i = 1; i < steps.length; i++) if (steps[i] <= steps[i - 1]) monotonic = false;
  check('rate rises monotonically with banked power', monotonic, steps.join(' -> '));

  // The headline rate, checked against what the config actually says.
  const expected = BC.perSecondMax * PER_BURST;
  check('full-power rate matches the configured bursts/sec',
    Math.abs(steps[3] - expected) < expected * 0.12, `${steps[3]} vs ~${expected}`);
}

// ---------------------------------------------------------------------------
section('VENT — which way it blows, and how hard');
//
// The vent is EXHAUST, not breath: it leaves the back of the animal like the
// boost charge behind a vehicle. Two things have to hold for that to read, and
// neither is visible in a particle count — which is exactly why the vent
// pointed straight up for as long as it did.
//
//   it goes BACKWARD, off the seal's FACING, not off its travel. A wind-up is
//     usually a brake to a standstill, so travel has no direction to reverse.
//   it is THROWN, harder as power banks. A jet that only trickles is a breath
//     aimed sideways.
{
  vent(1, 1, rigBoth, STILL, 1 / 60, false, FACING_RIGHT);
  const back = shots();
  const rearward = back.filter((s) => s.vx < 0).length / back.length;
  check('a full hold vents out the BACK of the seal, not upward',
    mean(back.map((s) => s.vx)) < -1, `mean vx ${mean(back.map((s) => s.vx)).toFixed(2)}`);
  check('...and nearly every bubble in the jet is behind it',
    rearward > 0.9, `${(rearward * 100).toFixed(0)}% have vx < 0`);
  // The mouth alone, because the head's share is the one that used to go up and
  // the tail's could carry this test on its own.
  vent(1, 1, rigMouth, STILL, 1 / 60, false, FACING_RIGHT);
  check('the HEAD\'s share is rearward too — it is the one that used to rise',
    mean(shots().map((s) => s.vx)) < -1, `mean vx ${mean(shots().map((s) => s.vx)).toFixed(2)}`);

  // Facing beats travel, which is the whole reason `forward` is plumbed through
  // at all: swimming one way while pointing another must still vent off the
  // animal's own spine.
  vent(1, 1, rigBoth, { x: -CONFIG.player.maxSpeed, y: 0 }, 1 / 60, false, FACING_RIGHT);
  check('facing wins over travel — a seal drifting backwards still vents behind ITSELF',
    mean(shots().map((s) => s.vx)) < 0, `mean vx ${mean(shots().map((s) => s.vx)).toFixed(2)}`);

  // ...and with no facing to hand (a harness, a model with no rig) it falls
  // back to reverse travel rather than to nothing.
  //
  // At a DRIFT, not at full speed. Every bubble also inherits a share of the
  // seal's velocity (CONFIG.emitters.*.inherit), and at maxSpeed that share is
  // several times the jet — the emitted velocity comes out positive with the
  // jet still aimed correctly behind, because the water the bubble was born in
  // is itself moving forward faster than the bubble leaves. Which is what
  // really happens, and is why this samples where the two are separable.
  vent(1, 1, rigBoth, { x: 3, y: 0 }, 1 / 60, false, null);
  check('with no facing it falls back to the reverse of travel',
    mean(shots().map((s) => s.vx)) < 0, `mean vx ${mean(shots().map((s) => s.vx)).toFixed(2)}`);
}

{
  const wasBias = BC.backBias;
  const wasMin = BC.jetSpeedMin;
  const wasMax = BC.jetSpeedMax;
  try {
    // The knob at both ends. 0 is the old breath — straight up — and it has to
    // still be reachable, because that is what makes `backBias` a control
    // rather than a hardcoded direction with a number in front of it.
    BC.backBias = 0;
    vent(1, 1, rigBoth, STILL, 1 / 60, false, FACING_RIGHT);
    const up = shots();
    check('backBias 0 sends it straight up again',
      mean(up.map((s) => s.vy)) > 1 && Math.abs(mean(up.map((s) => s.vx))) < 1,
      `mean (${mean(up.map((s) => s.vx)).toFixed(2)}, ${mean(up.map((s) => s.vy)).toFixed(2)})`);

    // The blend is normalised, so a half-biased vent is an ANGLE rather than a
    // weaker jet — mixing direction and force into one number is how a tuner
    // ends up unable to aim the thing without also softening it.
    BC.backBias = 0.5;
    vent(1, 1, rigBoth, STILL, 1 / 60, false, FACING_RIGHT);
    const half = mean(shots().map((s) => s.speed));
    BC.backBias = 1;
    vent(1, 1, rigBoth, STILL, 1 / 60, false, FACING_RIGHT);
    const full = mean(shots().map((s) => s.speed));
    check('the bias changes the angle, not the force',
      Math.abs(half - full) < full * 0.12, `${half.toFixed(2)} vs ${full.toFixed(2)} u/s`);
    BC.backBias = wasBias;

    // THROWN, not let go of — and it spools up over a hold.
    vent(0.05, 1, rigBoth, STILL, 1 / 60, false, FACING_RIGHT);
    const weak = mean(shots().map((s) => s.speed));
    vent(1, 1, rigBoth, STILL, 1 / 60, false, FACING_RIGHT);
    const strong = mean(shots().map((s) => s.speed));
    check('the jet spools up with banked power', strong > weak * 1.4,
      `${weak.toFixed(2)} -> ${strong.toFixed(2)} u/s`);

    BC.jetSpeedMin = 1;
    BC.jetSpeedMax = 1;
    vent(1, 1, rigBoth, STILL, 1 / 60, false, FACING_RIGHT);
    const unthrown = mean(shots().map((s) => s.speed));
    check('and jetSpeed 1 is the emitters\' own speed, untouched',
      strong > unthrown * (wasMax * 0.8), `${unthrown.toFixed(2)} vs ${strong.toFixed(2)} u/s at x${wasMax}`);
  } finally {
    BC.backBias = wasBias;
    BC.jetSpeedMin = wasMin;
    BC.jetSpeedMax = wasMax;
  }
}

// ---------------------------------------------------------------------------
section('RELEASE — the burst the let-go leaves behind');
//
// CONFIG.emitters.chargeBurst, fired by main.js on the frame a strike launches.
// Everything about it is "quick to die, in every direction, dragged along by
// the water the seal was moving through", so that is what is measured — a
// release burst that lingers turns the launch into a cloud the dash swims out
// of, and one with a cone is a jet rather than pressure leaving.
{
  const def = CONFIG.emitters.chargeBurst;
  check('the emitter exists', !!def);

  // Eight bursts rather than one. Every direction here is a fresh random draw,
  // and 26 of them is a small enough sample that a lopsided burst is ordinary
  // luck — the mean of the batch is what the claim is actually about, and
  // widening the tolerance instead would be a test of nothing.
  resetParticles();
  for (let i = 0; i < 8; i++) emit('chargeBurst', 0, -10, { vx: 0, vy: 0, scale: 1 });
  const shell = shots();
  check('it fires in every direction, not in a cone',
    (def.cone ?? 0) === 0 && shell.some((s) => s.vx > 0) && shell.some((s) => s.vx < 0)
      && shell.some((s) => s.vy > 0) && shell.some((s) => s.vy < 0),
    `${shell.length} bubbles across all four quadrants`);
  check('quick to die — the whole burst is gone in under half a second',
    Math.max(...shell.map((s) => s.life)) < 0.5,
    `longest life ${Math.max(...shell.map((s) => s.life)).toFixed(2)}s`);
  check('and small — smaller than the vent bubbles it follows',
    Math.max(...shell.map((s) => s.size)) < CONFIG.emitters.breathBubbles.size[1],
    `biggest ${Math.max(...shell.map((s) => s.size)).toFixed(3)} vs breath ${CONFIG.emitters.breathBubbles.size[1]}`);
  // A shell drawn around the seal has to be centred on it, or the "in every
  // direction" above would pass on a burst quietly listing to one side.
  check('it is centred on the seal rather than listing to one side',
    Math.abs(mean(shell.map((s) => s.vx))) < mean(shell.map((s) => s.speed)) * 0.4,
    `mean vx ${mean(shell.map((s) => s.vx)).toFixed(2)} of ${mean(shell.map((s) => s.speed)).toFixed(2)} u/s`);

  // INFLUENCED BY THE PLAYER'S VELOCITY, which is the whole reason it reads as
  // water rather than as a sprite: the same shell fired out of a drift smears
  // downstream.
  resetParticles();
  const drift = 12;
  for (let i = 0; i < 8; i++) emit('chargeBurst', 0, -10, { vx: drift, vy: 0, scale: 1 });
  const dragged = mean(shots().map((s) => s.vx));
  check('the seal\'s own velocity drags it along',
    Math.abs(dragged - drift * (def.inherit ?? 0)) < drift * 0.35,
    `mean vx ${dragged.toFixed(2)}, expected ~${(drift * (def.inherit ?? 0)).toFixed(2)} at inherit ${def.inherit}`);

  // They must not sail into the sky. No surfacePop on this one — too small and
  // too brief to be worth a droplet burst each — but the water line still has
  // to stop them.
  check('a released bubble still dies at the water line',
    (def.killAtSurface ?? !!def.surfacePop) === true);
}

section('VENT — the cases the existing emitters could not cover');
{
  // A wind-up is usually a standstill, which is below wake.minSpeed — the wake
  // path refuses to fire there, and the breath path is on a 1-2s timer. If the
  // vent leaned on either, this is the test that would catch it.
  const still = vent(1, 1, rigBoth, STILL);
  const moving = vent(1, 1, rigBoth, { x: CONFIG.player.maxSpeed, y: 0 });
  check('the vent pours from a standstill, below wake.minSpeed', still > 100, `${still}`);
  check('and moving does not change the vent rate much (it reads power, not speed)',
    moving > still * 0.9, `${still} still vs ${moving} moving`);
}

{
  check('a breached seal vents nothing — bubbles in the air read as a bug',
    vent(1, 1, rigBoth, STILL, 1 / 60, true) === 0);
  check('no rig, no crash', vent(1, 1, null) === 0);
}

{
  // One long frame after a hitch must not pay back the backlog as a dump.
  resetBubbles();
  resetParticles();
  updateBubbles(2.0, rigBoth, STILL, false, 1);
  const dumped = particleCount();
  const cap = BC.maxPerFrame * PER_BURST;
  // A two-second frame also runs the ordinary breath timer out, so one ambient
  // puff rides along on top of the vent's clamped bursts. Allowed for rather
  // than suppressed — it is what really happens on a frame that long.
  const puff = Math.max(1, Math.round(CONFIG.emitters.breathBubbles.count * CONFIG.bubbles.breath.scale));
  check('one huge frame is clamped to maxPerFrame bursts',
    dumped >= cap && dumped <= cap + puff,
    `${dumped} particles, cap ${cap} + one ${puff}-particle breath (unclamped would be ${BC.perSecondMax * 2 * PER_BURST})`);

  // ...and the backlog is DROPPED, not paid back over the frames that follow.
  const before = particleCount();
  updateBubbles(1 / 60, rigBoth, STILL, false, 1);
  const next = particleCount() - before;
  check('and the frame after it is an ordinary frame, not a payback',
    next <= 2 * PER_BURST, `${next} particles`);
}

section('VENT — the switches');
{
  const wasCharge = BC.enabled;
  const wasBreath = CONFIG.bubbles.breath.enabled;
  const wasWake = CONFIG.bubbles.wake.enabled;
  try {
    BC.enabled = false;
    check('charge.enabled = false stops the vent', vent(1, 1) < 40, 'ambient breath only');
    BC.enabled = wasCharge;

    CONFIG.bubbles.breath.enabled = false;
    const noMouth = vent(1, 1, rigMouth);
    check('a disabled mouth stays shut through a wind-up', noMouth === 0, `${noMouth}`);
    CONFIG.bubbles.breath.enabled = wasBreath;

    CONFIG.bubbles.wake.enabled = false;
    const noTail = vent(1, 1, rigTail);
    check('a disabled tail stays shut through a wind-up', noTail === 0, `${noTail}`);
  } finally {
    BC.enabled = wasCharge;
    CONFIG.bubbles.breath.enabled = wasBreath;
    CONFIG.bubbles.wake.enabled = wasWake;
  }
}

// ===========================================================================
// WIRING — the game actually drives both of these
// ===========================================================================

// ---------------------------------------------------------------------------
section('BODY — the meter on the animal, and what it opens a run as');
//
// systems/chargeSkin.js lights the seal's own markings with the fuel bar. The
// regression this guards is not subtle once you see it: `strikeState.charge`
// starts at 1, so the "loaded" read was true from the first frame of every
// run — the seal spawned covered in glowing mint patches before the player had
// touched anything. A body read that is already on when you arrive is not
// telling you about a state, it is what the animal looks like.
//
// The first fix for that was a DAYLIGHT gate, and it is worth saying here why
// it was wrong, because the test that went with it passed: the opening hour
// comes from the player's own clock (dayNight.startFromSystemClock), so a run
// begun after dark opened exactly as lit as before. The rule is about the
// START of a run, not the time of day — hence the hour sweep below, which the
// daylight version could not have survived.
//
// Driven off the real uniforms, and every expected number computed from CONFIG
// — saved tuning beats the config defaults, so a hardcoded 1.125 here would be
// a test of imported-tuning.json rather than of the code.
{
  const mat = new THREE.MeshStandardMaterial();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 0.8), mat);
  attachNoiseShader(mat);
  const u = mat.userData.__noiseUniforms;
  const frames = (charge, n = 8) => {
    for (let i = 0; i < n; i++) updateChargeSkin(body, charge, 1 / 60);
    return u.uChargeStrength.value;
  };
  const s = CONFIG.sealCharge;
  const atFull = (s.strength ?? 0.9) * (s.fullBoost ?? 1.25);

  // AT EVERY HOUR OF THE DAY. `skyLight` is written directly rather than
  // simulated — the sun's elevation comes off the arena bounds, which a
  // headless harness has none of — and the point of sweeping it is that the
  // answer must not depend on it at all.
  let litAtSomeHour = null;
  for (const [label, night, twilight] of [['morning', 0, 0], ['dusk', 0, 1], ['midnight', 1, 0]]) {
    skyLight.night = night;
    skyLight.twilight = twilight;
    resetChargeSkin();
    const opening = frames(1, 30); // half a second of standing still
    if (opening !== 0) litAtSomeHour = `${label} (${opening.toFixed(3)})`;
  }
  check('a run opens with the seal dark, at any hour', litAtSomeHour === null,
    litAtSomeHour ? `lit at ${litAtSomeHour}` : 'morning, dusk and midnight all dark with a full meter');

  // Asleep means silent in every channel, not just the steady one.
  resetChargeSkin();
  frames(1);
  chargeCrossed();
  updateChargeSkin(body, 1, 1 / 60);
  check('...and no crossing band travels it while it is asleep',
    u.uChargeWave.value < 0, `wave ${u.uChargeWave.value}`);

  // THE WAKE-UP is the bar MOVING, which only the player can do.
  const spent = frames(0.35);
  check('spending the bar wakes it, dimly — the meter is low, not asleep',
    spent > 0 && spent < atFull * 0.5, `${spent.toFixed(3)}`);
  const refilled = frames(1);
  check('and a meter the player filled lights the seal',
    Math.abs(refilled - atFull) < 1e-9,
    `${refilled.toFixed(3)} vs strength x fullBoost = ${atFull.toFixed(3)}`);
  chargeCrossed();
  updateChargeSkin(body, 1, 1 / 60);
  check('...with the crossing flash, once it is awake', u.uChargeWave.value >= 0);

  // MONOCHROME ON THE BODY. Hue on the seal is Glow Up!'s alphabet: a lit
  // animal means an element, and this layer runs on every run including the
  // ones that never took the card. Measured as SATURATION off the live uniform
  // rather than compared against the config numbers, so a colour arriving from
  // anywhere — a tuner row, a re-coupling to CONFIG.strike.ring, whose ready
  // mint is what put a green seal in front of a player with no element — fails
  // here rather than only in a screenshot.
  const saturation = () => {
    const c = u.uChargeColor.value;
    return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  };
  check('a loaded seal glows grey-to-white, not a hue', saturation() < 0.02,
    `saturation ${saturation().toFixed(3)}`);
  frames(0.5);
  check('...and so does a filling one', saturation() < 0.02,
    `saturation ${saturation().toFixed(3)}`);

  check('an empty meter still reads dark', frames(0) === 0);

  // Per RUN, not per boot — a second run started from the score screen has to
  // open as dark as the first, and `armed` is module state that would happily
  // survive it.
  resetChargeSkin();
  check('the next run opens dark again', frames(1, 30) === 0);

  skyLight.night = 0;
  skyLight.twilight = 0;
}

section('WIRING — main.js');
const main = fs.readFileSync(MAIN, 'utf8');
check('ticks the seal\'s own read of the meter', /updateChargeSkin\(player\.body, strikeState\.charge/.test(main));
check('imports the rim pulse', /import \{[^}]*\bupdatePlayerOutline\b[^}]*\} from '\.\/systems\/outlines\.js'/.test(main));
check('imports the release flare', /import \{[^}]*\bflarePlayerOutline\b[^}]*\} from '\.\/systems\/outlines\.js'/.test(main));
check('ticks the rim every frame, on real time',
  /updatePlayerOutline\(\s*realDt,/.test(main));
check('the rim reads the BUTTON and the banked power',
  /updatePlayerOutline\([^;]*input\.strikeHeld[^;]*strikeState\.pending/s.test(main));
check('the flare fires on the frame a strike launches',
  /flarePlayerOutline\(strikeState\.power\)/.test(main));
check('the vent gets the banked power', /updateBubbles\([^;]*input\.strikeHeld \? strikeState\.pending : 0/s.test(main));
// ...and where the seal is POINTING, which is what makes the jet leave the back
// of the animal from a standstill. Without this the vent still runs and still
// pours — it just quietly aims itself out of the reverse of a velocity that
// isn't there, which is straight up.
check('the vent gets the seal\'s facing', /updateBubbles\([^;]*faceDir,/s.test(main));
check('the facing is the art\'s forward, a quarter turn off the container',
  /player\.mesh\.rotation\.z \+ Math\.PI \/ 2/.test(main));
// The release burst, and the velocity it inherits. Read BEFORE tryStrike on
// purpose: the impulse overwrites player.velocity with the dash's own, and
// inheriting that would fire the whole shell out the front as one streak.
check('the release fires the vent burst', /feedback\('strikeVent',/.test(main));
check('...dragged by the velocity from before the impulse',
  /const releaseVx = player\.velocity\.x[\s\S]{0,400}?tryStrike\(dir/.test(main));
check('...and scaled by the power actually spent',
  /feedback\('strikeVent',[\s\S]{0,300}?strikeState\.power/.test(main));
check('a fresh run clears the rim', /resetPlayerOutlineCharge\(\)/.test(main));

console.log(failures === 0 ? '\nAll charge-FX checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
