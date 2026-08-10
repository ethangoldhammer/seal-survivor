#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chargefx
//
// The two things a strike wind-up now does to the seal itself:
//
//   THE RIM     systems/outlines.js — the player's outline shell throbs while
//               power banks and blows out on the release.
//   THE VENT    systems/bubbles.js — every bubble emitter on the body opens at
//               once, harder the more power is banked.
//
// Both are pure state machines over dt, which is exactly the kind of thing that
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
  resetPlayerOutlineCharge,
} from '../path/src/systems/outlines.js';
import { updateBubbles, resetBubbles } from '../path/src/systems/bubbles.js';
import { initParticles, resetParticles, particleCount } from '../path/src/entities/particles.js';

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
// THE VENT
// ===========================================================================

initParticles(new THREE.Scene());

const rigBoth = { anchors: { mouth: { x: 0, y: 0 }, tail: { x: 0, y: 0 } } };
const rigMouth = { anchors: { mouth: { x: 0, y: 0 } } };
const rigTail = { anchors: { tail: { x: 0, y: 0 } } };
const STILL = { x: 0, y: 0 };

// Particles emitted by `seconds` of holding at a fixed banked power. The breath
// timer is reset each run so its 1-2s puff can't land inside one sample and not
// another; `charge` is the only thing that varies.
function vent(charge, seconds, rig = rigBoth, velocity = STILL, dt = 1 / 60, above = false) {
  resetBubbles();
  resetParticles();
  for (let t = 0; t < seconds; t += dt) updateBubbles(dt, rig, velocity, above, charge);
  return particleCount();
}

const BC = CONFIG.bubbles.charge;
// Particles in one full-power burst: both emitters, each emitter's own count
// scaled by the vent's size multiplier and rounded the way emit() rounds it.
const PER_BURST = Math.max(1, Math.round(CONFIG.emitters.breathBubbles.count * CONFIG.bubbles.breath.scale * BC.scaleMax))
  + Math.max(1, Math.round(CONFIG.emitters.wakeBubbles.count * CONFIG.bubbles.wake.scale * BC.scaleMax));

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

section('WIRING — main.js');
const main = fs.readFileSync(MAIN, 'utf8');
check('imports the rim pulse', /import \{[^}]*\bupdatePlayerOutline\b[^}]*\} from '\.\/systems\/outlines\.js'/.test(main));
check('imports the release flare', /import \{[^}]*\bflarePlayerOutline\b[^}]*\} from '\.\/systems\/outlines\.js'/.test(main));
check('ticks the rim every frame, on real time',
  /updatePlayerOutline\(\s*realDt,/.test(main));
check('the rim reads the BUTTON and the banked power',
  /updatePlayerOutline\([^;]*input\.strikeHeld[^;]*strikeState\.pending/s.test(main));
check('the flare fires on the frame a strike launches',
  /flarePlayerOutline\(strikeState\.power\)/.test(main));
check('the vent gets the banked power', /updateBubbles\([^;]*input\.strikeHeld \? strikeState\.pending : 0/s.test(main));
check('a fresh run clears the rim', /resetPlayerOutlineCharge\(\)/.test(main));

console.log(failures === 0 ? '\nAll charge-FX checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
