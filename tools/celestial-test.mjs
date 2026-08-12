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
//   THE FRAME FIT only engages at zooms and depths the game reaches for a
//   fraction of a second at a time. Its failure mode is a sun cropped in a
//   cinematic push-in, which is precisely the moment nobody is holding a
//   camera. And its BOUND — that a body may never be lowered while the water
//   line is still in shot — is invisible when it works and reads as a staged
//   sunset when it doesn't.
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
import { updateDayCycle, dayState, horizonY } from '../path/src/systems/daylight.js';
import { createCelestials, celestialFrame, clearCelestialFlares } from '../path/src/systems/celestial.js';
import { updateCelestialPass, resetCelestialPass, passState } from '../path/src/systems/celestialPass.js';

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

// The frame the fit is given, as world.js builds it: the frustum's own centre
// (which sits well below the camera — the water line is a fifth of the way down
// the screen, not halfway) and its half extents at a zoom.
function view(camX, camY, zoom = 1) {
  const cx = 0;
  const cy = (bounds.frameTop + bounds.bottom) / 2;
  return {
    x: camX + cx,
    y: camY + cy,
    halfW: bounds.frameWidth / (2 * zoom),
    halfH: (bounds.frameTop - bounds.bottom) / (2 * zoom),
  };
}

// Park the clock so every case below is measured at a known hour rather than
// at whatever the machine's wall clock made of `startFromSystemClock`.
function atHour(h) {
  CONFIG.dayNight.paused = true;
  CONFIG.dayNight.scrubHour = h;
  updateDayCycle(0);
}

// One frame of the rig, at an hour, a camera and a zoom.
function frame(hour, camX = 0, camY = 0, zoom = 1, dt = 0) {
  atHour(hour);
  rig.update(camX, 0, view(camX, camY, zoom), dt);
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
  // Noon, so the sun is at the top of its arc and nowhere near either the frame
  // fit or the horizon cull — this has to measure the drift alone.
  frame(12, 0, 0);
  const at0 = celestialFrame.sun.x - 0;
  const pan = 30;
  frame(12, pan, 0);
  const at1 = celestialFrame.sun.x - pan;
  check('a camera move of D slides the body D * drift across the frame',
    near(at0 - at1, pan * drift, 1e-4),
    `panned ${pan}, body moved ${(at0 - at1).toFixed(3)} on screen (want ${(pan * drift).toFixed(3)})`);

  // The control. Without this the test above passes just as happily against a
  // sky welded to the screen, which is the other way to get "barely moves" and
  // the wrong one — a sun that never moves at all is a decal.
  check('...and it is not simply screen-welded', Math.abs(at0 - at1) > 0,
    'a body pinned to the frame would read 0 here');
}

// ===========================================================================
section('THE FRAME FIT — a body stays in the shot');
// ===========================================================================
{
  const orbit = CONFIG.dayNight.orbit;
  const pad = (CONFIG.dayNight.sun.size * 0.5) * orbit.framePad;

  // Zoomed in hard, at the hour the sun is furthest out along the arc. This is
  // the cinematic push-in that used to crop it.
  frame(7, 0, 0, 1.8);
  const v = view(0, 0, 1.8);
  check('a zoomed frame keeps the sun inside it',
    celestialFrame.sun.x <= v.x + v.halfW - pad + 1e-6
    && celestialFrame.sun.x >= v.x - v.halfW + pad - 1e-6,
    `sun x ${celestialFrame.sun.x.toFixed(2)} in [${(v.x - v.halfW + pad).toFixed(2)}, ${(v.x + v.halfW - pad).toFixed(2)}]`);

  // THE BOUND, and the reason the fit is allowed to touch Y at all. With the
  // camera at the surface the water line is in shot, so a body must sit exactly
  // where the orbit put it — the fit may not lower it by so much as a unit,
  // however far off the top of the frame that leaves it.
  frame(12, 0, 0);
  check('with the horizon in shot, the fit does not move the sun vertically',
    near(celestialFrame.sun.y, dayState.sun.y, 1e-6),
    `drawn ${celestialFrame.sun.y.toFixed(3)} vs orbit ${dayState.sun.y.toFixed(3)}`);

  // Dive, and the water line leaves the top of the frame. Now the sky may come
  // down with the camera — but only as far as the horizon's own head start, so
  // the water line is never dragged back into view to be compared against.
  const deep = -14;
  frame(12, 0, deep);
  const v2 = view(0, deep);
  const slack = horizonY() - (v2.y + v2.halfH);
  check('...and the water line really has left the shot', slack > 0,
    `horizon sits ${slack.toFixed(1)} units above the top of the frame`);
  check('deep down, the fit lowers the sun',
    celestialFrame.sun.y < dayState.sun.y,
    `drawn ${celestialFrame.sun.y.toFixed(2)} vs orbit ${dayState.sun.y.toFixed(2)}`);
  check('...by no more than the horizon is off-frame',
    celestialFrame.sun.y >= dayState.sun.y - slack - 1e-6,
    `moved ${(dayState.sun.y - celestialFrame.sun.y).toFixed(2)}, bound ${slack.toFixed(2)}`);

  // The switch, which is what makes the whole thing arguable in the tuner.
  orbit.keepInFrame = 0;
  frame(12, 0, deep);
  check('keepInFrame 0 puts it back on the orbit exactly',
    near(celestialFrame.sun.y, dayState.sun.y, 1e-6) && near(celestialFrame.sun.x, dayState.sun.x + 0 * 1, 1e-3),
    `drawn (${celestialFrame.sun.x.toFixed(2)}, ${celestialFrame.sun.y.toFixed(2)})`);
  orbit.keepInFrame = 1;
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

  // A body under the water is drawn by nothing and covered by the fill, and the
  // seal swims through that patch of sea constantly.
  resetCelestialPass();
  frame(12, 0, 0); // sun up, moon down
  const moon = celestialFrame.moon;
  check('the moon is down at noon', !moon.visible, `visible = ${moon.visible}`);
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

// ===========================================================================
section('THE FLARE — the body shines and flickers');
// ===========================================================================
{
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
