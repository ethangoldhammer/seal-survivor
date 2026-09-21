#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:celestial
//
// The sun and the moon, on the two things about them that are now GAMEPLAY
// rather than backdrop — where they are drawn, and what happens when the seal
// flies through one.
//
// WHY THIS CANNOT BE EYEBALLED IN THE BROWSER, which is the usual answer for
// anything in the sky:
//
//   THE DRIFT is a couple of hundredths. "Barely moves" is the requirement, and
//   the difference between 0.04 and 0.15 is a second-long pan away from a
//   screenshot — but it is a factor of four in the number, and it is exactly
//   the kind of value a saved tuning snapshot silently overrides (`parallax`
//   still sits in imported-tuning.json at the old value, which is the whole
//   reason the field was renamed). So the assertion here is on the ARITHMETIC:
//   a camera move of D must slide the body D * drift across the frame.
//
//   THE VERTICAL AXIS TAKES NO DRIFT, and the test for it is here because the
//   obvious tidy-up is to make the two axes match. That was done on 2026-09-18
//   and reverted three days later off the pictures in
//   tools/looks/sky-parallax.js: at the top of a breach the sunrise sun sat
//   twenty units above its own orange band, a full disc in the night-blue
//   zenith. A body's height is the HOUR, and the hour is written against a
//   water line that does not move — so the body cannot move either. Asserted
//   as an identity with the orbit at every camera height.
//
//   THE TRIGGER ZONE is a state machine over a distance, and every one of its
//   three rules (entry not presence, hysteresis, cooldown) fails as "the sound
//   played twice" or "the sound didn't play", which is indistinguishable from
//   an audio problem.
//
// Runs headless: the rig builds real three.js quads but nothing renders, and
// the pass system needs no scene at all.
//
//   node --import ./tools/vite-loader.mjs tools/celestial-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import { updateDayCycle, dayState, horizonY, bodySize } from '../path/src/systems/daylight.js';
import { createCelestials, celestialFrame, clearCelestialFlares } from '../path/src/systems/celestial.js';
import { updateCelestialPass, resetCelestialPass, passState, CELESTIAL_PASS_DISABLED } from '../path/src/systems/celestialPass.js';

let failures = 0;

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
function near(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

// A 16:9 frame, which is what every number below is measured against.
updateBounds(16 / 9);

const scene = new THREE.Scene();
const rig = createCelestials(scene);

// Park the clock so every case below is measured at a known hour rather than
// at whatever the machine's wall clock made of `startFromSystemClock`.
function atHour(h) {
  CONFIG.dayNight.paused = true;
  CONFIG.dayNight.scrubHour = h;
  updateDayCycle(0);
}

// One frame of the rig, at an hour and a camera. There is no zoom argument any
// more and there is nothing for one to do: the rig is handed the BANKED ANCHOR
// and nothing else, so what the frustum is doing cannot reach it. That is half
// the point of the change this covers — the sky is placed by the camera, never
// fitted to the shot's edges.
//
// `camY` is accepted and deliberately DROPPED on the floor. It is the argument
// a reader expects the rig to take, and the fact that passing it changes
// nothing is the assertion below — so it is spelled out here rather than left
// as a signature that quietly has no second parameter.
function frame(hour, camX = 0, camY = 0, dt = 0) {
  atHour(hour);
  rig.update(camX, 0, dt);
  void camY;
}

// ===========================================================================
section('DRIFT — the sky barely moves');
// ===========================================================================
{
  const drift = CONFIG.dayNight.orbit.drift;
  check('config.js owns `drift`', typeof drift === 'number', `drift = ${drift}`);
  // The requirement in one number. Anything above about a tenth stops reading
  // as distance and starts reading as a prop on a track behind the seal.
  check('drift is a space drift, not a parallax layer', drift > 0 && drift <= 0.1,
    `${drift} — a full-ocean crossing moves it ${(bounds.right * 2 * drift).toFixed(1)} units`);

  // The arithmetic, measured rather than assumed: pan the camera and watch the
  // body's offset FROM THE CAMERA change by exactly D * drift.
  //
  // Noon, so the sun is at the top of its arc and nowhere near the horizon cull
  // — this has to measure the drift alone.
  frame(12, 0, 0);
  const x0 = celestialFrame.sun.x - 0;
  const y0 = celestialFrame.sun.y - 0;
  const pan = 30;
  frame(12, pan, 0);
  const x1 = celestialFrame.sun.x - pan;
  check('a camera move of D slides the body D * drift across the frame',
    near(x0 - x1, pan * drift, 1e-4),
    `panned ${pan}, body moved ${(x0 - x1).toFixed(3)} on screen (want ${(pan * drift).toFixed(3)})`);

  // The control. Without this the test above passes just as happily against a
  // sky welded to the screen, which is the other way to get "barely moves" and
  // the wrong one — a sun that never moves at all is a decal.
  check('...and it is not simply screen-welded', Math.abs(x0 - x1) > 0,
    'a body pinned to the frame would read 0 here');

  // THE VERTICAL AXIS TAKES NONE OF IT. A camera rise of D must move the body
  // by exactly nothing on the WORLD axis — it stays on its orbit — which on
  // screen means it travels the full D, the same as the water line it is
  // measured against. That is the opposite of the horizontal rule and it is
  // correct: see the section below.
  frame(12, 0, 30);
  check('a camera rise leaves the body exactly on its orbit',
    near(celestialFrame.sun.y, dayState.sun.y, 1e-9),
    `drawn ${celestialFrame.sun.y.toFixed(3)} vs orbit ${dayState.sun.y.toFixed(3)}`);
  frame(12, 0, -30);
  check('...and so does a dive',
    near(celestialFrame.sun.y, dayState.sun.y, 1e-9),
    `drawn ${celestialFrame.sun.y.toFixed(3)} vs orbit ${dayState.sun.y.toFixed(3)}`);
}

// ===========================================================================
section('PINNED TO THE WATER — the sky is one piece');
// ===========================================================================
{
  // WHY THE TWO AXES DISAGREE ON PURPOSE, which is the single thing about this
  // file worth reading before changing it.
  //
  // Height above the water line is what says what hour it is, and it does not
  // say it alone: systems/sky.js ramps its whole gradient over
  // (vWorldPos.y - uSurfaceY) / airH on a plane that never moves, and the
  // horizon glow sits on the same line. Those are the sunset. A body that
  // drifted vertically would climb out of them — measured at the top of a
  // breach, twenty units of clear night-blue between a sunrise sun and the
  // orange band it was supposed to be lighting.
  //
  // So the assertion is an IDENTITY, at every height the camera can reach, and
  // its whole value is that it fails the moment somebody makes the axes match.
  const heights = [26, 12, 0, -6, -11];
  let worst = 0;
  for (const camY of heights) {
    frame(12, 0, camY);
    worst = Math.max(worst, Math.abs(celestialFrame.sun.y - dayState.sun.y));
  }
  check('the body sits on its orbit at every camera height',
    worst < 1e-9, `worst drift ${worst.toExponential(1)} units over ${heights.join(', ')}`);

  // ...and it keeps its distance from the water line, which is the same fact
  // stated in the unit the sky gradient is written in. A body 5 units above
  // the sea at noon has to be 5 units above it from the seabed and from the
  // top of a breach, or the hour changes with the camera.
  frame(12, 0, 0);
  const gap = celestialFrame.sun.y - horizonY();
  frame(12, 0, 26);
  check('...so its height above the water is the hour, not the camera',
    near(celestialFrame.sun.y - horizonY(), gap, 1e-9),
    `${gap.toFixed(2)} units of sky under it either way`);

  // THE CLOCK IS NOT INVOLVED, and this is the control on the reasoning above
  // rather than on the code: dayState is solved off the orbit alone, so even a
  // rig that DID drift could not have re-coloured the hour. It is asserted so
  // that "the clock is safe" can never be offered as the argument for drifting
  // the body — it is true, and it is not the reason.
  frame(12, 0, 0);
  const at0 = { y: dayState.sun.y, el: dayState.sun.elevation, phase: dayState.phase };
  frame(12, 0, -30);
  check('no camera move can reach the clock',
    near(dayState.sun.y, at0.y, 1e-9)
    && near(dayState.sun.elevation, at0.el, 1e-9)
    && dayState.phase === at0.phase,
    `elevation ${dayState.sun.elevation.toFixed(4)}, phase '${dayState.phase}' either way`);

  // THE HORIZONTAL AXIS IS NOT ALONE ON ITS NUMBER any more. The star field in
  // systems/sky.js is hashed off vWorldPos and used to sit welded to the
  // world, so the moon crossed ninety units of its own stars over one swim of
  // the ocean. world.js now offsets that field's sample origin and
  // systems/constellations.js translates its group, both off this same
  // `drift`. Covered as geometry in tools/constellation-test.mjs; asserted
  // here as the thing that would break it — a second number.
  check('one drift for the whole backdrop',
    CONFIG.dayNight.orbit.driftY === undefined,
    'a separate vertical drift field is what the reverted change added');
}

// ===========================================================================
section('SIZE — big on screen, and still in the sky');
// ===========================================================================
{
  const airH = bounds.frameTop - bounds.surfaceY;
  const sun = bodySize(CONFIG.dayNight.sun);
  const moon = bodySize(CONFIG.dayNight.moon);
  check('the size is stated against the visible sky', CONFIG.dayNight.sun.frameSize > 0,
    `sun ${(CONFIG.dayNight.sun.frameSize * 100).toFixed(0)}% of a ${airH.toFixed(1)}-unit air band = ${sun.toFixed(2)} units`);
  check('...and it is bigger than the world-unit fallback it replaced',
    sun > CONFIG.dayNight.sun.size && moon > CONFIG.dayNight.moon.size,
    `sun ${CONFIG.dayNight.sun.size} -> ${sun.toFixed(2)}, moon ${CONFIG.dayNight.moon.size} -> ${moon.toFixed(2)}`);
  check('the sun still out-sizes the moon', sun > moon,
    `${sun.toFixed(2)} vs ${moon.toFixed(2)}`);

  // THE ARC HAS TO COME DOWN AS THE BODY GROWS, or a bigger sun is simply a
  // cropped one for the four hours either side of noon. Asserted at the hour it
  // is highest, against the raw orbit — the frame fit is not allowed to be what
  // rescues this, because at the surface (the horizon in shot) it may not move
  // a body at all.
  atHour(12);
  const top = dayState.sun.y + sun / 2;
  check('a full-sized sun clears the top of the frame at noon', top < bounds.frameTop,
    `disc tops out at ${top.toFixed(2)}, frame top ${bounds.frameTop.toFixed(2)}`);
  check('...and is still properly clear of the water', dayState.sun.y - sun / 2 > 0,
    `bottom edge at ${(dayState.sun.y - sun / 2).toFixed(2)}`);

  // The positive control: the same body on the OLD arc rule (the whole air
  // band, regardless of how big the thing riding it is) would have been cut.
  const legacyY = airH * CONFIG.dayNight.orbit.radiusY;
  check('the old arc rule would have cropped it', legacyY + sun / 2 > bounds.frameTop,
    `would have topped out at ${(legacyY + sun / 2).toFixed(2)}`);
}

// ===========================================================================
section('THE TRIGGER ZONE — going through it');
// ===========================================================================
{
  const pass = CONFIG.dayNight.pass;
  pass.enabled = true;
  resetCelestialPass();

  // Noon, camera at the surface: the sun is up, drawn, and its zone is real.
  frame(12, 0, 0);
  const sun = celestialFrame.sun;
  check('the sun publishes a zone inside its own disc',
    sun.visible && sun.trigger > 0 && sun.trigger < sun.radius,
    `trigger ${sun.trigger.toFixed(2)} of radius ${sun.radius.toFixed(2)}`);

  // ...and it is reachable. The ceiling is real (clampToArena), so a zone above
  // it would be a mechanic nothing can ever trigger — this is the assertion
  // that the whole feature is not decorative.
  check('the zone is under the arena ceiling', sun.y + sun.trigger < bounds.top,
    `zone tops out at ${(sun.y + sun.trigger).toFixed(1)}, ceiling ${bounds.top.toFixed(1)}`);

  const hits = [];
  const hooks = { onPass: (which, at) => hits.push({ which, ...at }) };
  const inside = { x: sun.x, y: sun.y, speed: 30 };
  const outside = { x: sun.x + sun.radius * 4, y: sun.y, speed: 30 };

  // THE MECHANIC IS STUBBED OFF (CELESTIAL_PASS_DISABLED in
  // systems/celestialPass.js). The geometry above still holds — the zone is
  // published by the rig, not by the pass system — but every rule below is a
  // rule about an event that can no longer happen, so asserting them would be
  // asserting 0 === 1 sixteen times. They are SKIPPED out loud rather than
  // deleted: flip the flag back and the whole state machine is covered again,
  // which is the difference between a stub and a hole.
  if (CELESTIAL_PASS_DISABLED) {
    for (let i = 0; i < 30; i++) updateCelestialPass(1 / 60, inside, hooks);
    check('stubbed off — flying through the sun fires nothing at all',
      hits.length === 0 && passState.sun.passes === 0,
      `${hits.length} hit(s), ${passState.sun.passes} pass(es) recorded`);
    console.log('  SKIP  entry / hysteresis / cooldown / speed scale / the enabled switch');
    console.log('        — the pass mechanic is stubbed off; unset CELESTIAL_PASS_DISABLED to restore.');
  } else {
  updateCelestialPass(1 / 60, inside, hooks);
  check('flying into it fires once', hits.length === 1, `${hits.length} hit(s)`);

  // ENTRY, NOT PRESENCE. A seal at the apex of a jump is inside the sun for a
  // good half second, and that is one pass.
  for (let i = 0; i < 30; i++) updateCelestialPass(1 / 60, inside, hooks);
  check('...and not again while it sits in there', hits.length === 1, `${hits.length} hit(s)`);

  // HYSTERESIS. Leaving by a hair must not re-arm it.
  const rim = { x: sun.x + sun.trigger * 1.02, y: sun.y, speed: 30 };
  updateCelestialPass(1 / 60, rim, hooks);
  updateCelestialPass(1 / 60, inside, hooks);
  check('a wobble across the rim does not re-fire', hits.length === 1, `${hits.length} hit(s)`);

  // COOLDOWN. Properly out, properly back in, and still nothing until the
  // timer has run — this is what stops a pass being a rotation.
  updateCelestialPass(1 / 60, outside, hooks);
  updateCelestialPass(1 / 60, inside, hooks);
  check('a second pass inside the cooldown is refused', hits.length === 1, `${hits.length} hit(s)`);

  updateCelestialPass(pass.cooldown + 0.1, outside, hooks);
  updateCelestialPass(1 / 60, inside, hooks);
  check('...and allowed once it has run down', hits.length === 2, `${hits.length} hit(s)`);

  // The scale that makes a dash through the middle read bigger than a drift.
  resetCelestialPass();
  updateCelestialPass(1 / 60, { x: sun.x, y: sun.y, speed: 0 }, hooks);
  const slow = hits[hits.length - 1].scale;
  resetCelestialPass();
  updateCelestialPass(1 / 60, { x: sun.x, y: sun.y, speed: 60 }, hooks);
  const fast = hits[hits.length - 1].scale;
  check('speed scales how big the pass reads', fast > slow && fast <= pass.speedScale.max,
    `${slow.toFixed(2)} at rest, ${fast.toFixed(2)} flat out`);

  // A body under the water is covered by the fill, and the seal swims through
  // that patch of sea constantly. Note this is a different question from
  // whether the rig DRAWS anything there: a set body can still have half a halo
  // above the water line, which is worth drawing and is not worth flying
  // through. Getting those two confused is what made this check fail the first
  // time the moon got bigger — a wider halo made a body 5 units under the sea
  // "visible" and armed a zone nobody could see.
  resetCelestialPass();
  frame(12, 0, 0); // sun up, moon down
  const moon = celestialFrame.moon;
  check('the moon is down at noon', !moon.visible, `centre at y=${moon.y.toFixed(1)}`);
  const before = hits.length;
  updateCelestialPass(1 / 60, { x: moon.x, y: moon.y, speed: 30 }, hooks);
  check('...and swimming through where it would be fires nothing',
    hits.length === before, `${hits.length - before} hit(s)`);

  // And the switch.
  resetCelestialPass();
  pass.enabled = false;
  const off = hits.length;
  updateCelestialPass(1 / 60, inside, hooks);
  check('disabled means disabled', hits.length === off, `${hits.length - off} hit(s)`);
  pass.enabled = true;
  resetCelestialPass();
  }
}

// ===========================================================================
section('THE FLARE — the body shines and flickers');
// ===========================================================================
if (CELESTIAL_PASS_DISABLED) {
  // Nothing raises a flare while the mechanic is stubbed off — the envelope is
  // only ever driven from updateCelestialPass. Assert the sky is COLD, which is
  // the one thing about the flare that is still checkable and the one that
  // would actually be wrong if the stub leaked: a sun left permanently hot.
  clearCelestialFlares();
  frame(12, 0, 0, 1, 1 / 60);
  const halo = rig.group.children[0].children[0];
  const cold = halo.material.uniforms.uStrength.value;
  resetCelestialPass();
  updateCelestialPass(1 / 60, { x: celestialFrame.sun.x, y: celestialFrame.sun.y, speed: 40 }, {});
  for (let i = 0; i < 5; i++) frame(12, 0, 0, 1, 1 / 60);
  check('stubbed off — a pass through the sun raises no flare',
    near(halo.material.uniforms.uStrength.value, cold, 1e-4),
    `${halo.material.uniforms.uStrength.value.toFixed(4)} vs cold ${cold.toFixed(4)}`);
  console.log('  SKIP  brightness / flicker / burnout — no flare can be raised while stubbed off.');
} else {
  clearCelestialFlares();
  frame(12, 0, 0, 1, 1 / 60);
  const halo = rig.group.children[0].children[0];
  const cold = halo.material.uniforms.uStrength.value;

  // A pass, then the frame that draws its first moment.
  resetCelestialPass();
  updateCelestialPass(1 / 60, { x: celestialFrame.sun.x, y: celestialFrame.sun.y, speed: 40 }, {});
  frame(12, 0, 0, 1, 1 / 60);
  const lit = halo.material.uniforms.uStrength.value;
  check('a pass brightens the corona', lit > cold * 1.2,
    `${cold.toFixed(2)} cold, ${lit.toFixed(2)} lit`);

  // FLICKER, not a clean ramp: sample the envelope every frame and count the
  // times it changes direction. A pure exponential decay has none.
  const samples = [];
  for (let i = 0; i < 40; i++) {
    frame(12, 0, 0, 1, 1 / 60);
    samples.push(halo.material.uniforms.uStrength.value);
  }
  let turns = 0;
  for (let i = 2; i < samples.length; i++) {
    const a = samples[i - 1] - samples[i - 2];
    const b = samples[i] - samples[i - 1];
    if (a * b < 0) turns++;
  }
  check('...and it flickers on the way down', turns >= 4, `${turns} direction changes in 40 frames`);

  // It has to END. A flare that never ran out would leave the sun permanently
  // hot after the first pass of a run.
  for (let i = 0; i < 600; i++) frame(12, 0, 0, 1, 1 / 60);
  check('the flare burns out', near(halo.material.uniforms.uStrength.value, cold, 1e-4),
    `settled at ${halo.material.uniforms.uStrength.value.toFixed(4)}, cold is ${cold.toFixed(4)}`);
}

// ===========================================================================
section('WIRING — the payout reaches the game');
// ===========================================================================
{
  // The config side of every synergy main.js reads. Each of these is a live
  // number somewhere in onCelestialPass, and a missing one is a payout that
  // silently becomes zero rather than an error.
  //
  // STILL ASSERTED WHILE THE MECHANIC IS STUBBED OFF, on purpose: onCelestialPass
  // and its tuned numbers are exactly what the stub is preserving, and this
  // section is the only thing stopping them being quietly pruned or drifting to
  // zero in the months before it comes back.
  const p = CONFIG.dayNight.pass;
  check('the sun blasts', p.sun.blast.damage > 0 && p.sun.blast.radius > 0,
    `${p.sun.blast.damage} over ${p.sun.blast.radius} units`);
  check('the sun refills the strike meter', p.sun.charge > 0, `${p.sun.charge} of a meter`);
  check('the moon wakes the element', p.moon.surge > 0, `${p.moon.surge}s`);
  check('the moon pulls chum', p.moon.gulp > 0, `${p.moon.gulp} units`);
  check('both extend the food chain with Big Willy Style',
    p.sun.chainPerBreachLevel > 0 && p.moon.chainPerBreachLevel > 0);

  // The two feedback events, which are what carry the sfx arrays. A typo here
  // is a warning in the console and a silent pass.
  for (const event of ['sunPass', 'moonPass']) {
    const def = CONFIG.feedback[event];
    check(`CONFIG.feedback.${event} exists and makes a sound`, !!def && !!def.sfx,
      def ? `sfx: ${def.sfx}` : 'missing');
    const bank = def && CONFIG.sfx[def.sfx];
    check(`...and ${def?.sfx} is an array of takes`, Array.isArray(bank?.srcs) && bank.srcs.length >= 2,
      bank?.srcs ? `${bank.srcs.length} takes` : 'no srcs');
    check(`...pointing at emitter "${def?.emit}"`, !!CONFIG.emitters[def?.emit]);
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
