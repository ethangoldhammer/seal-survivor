#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:popgrace
//
// A PICKUP STRUCK BY A DASH POPS EVEN IF IT LANDS AFTER THE DASH ENDS.
//
// The blast was gated on `strikeState.active` alone, and a dash lasts only
// 0.13-0.48s. But the magnet reaches 8.4u while the seal is dashing and closes
// at ~29u/s, so an orb the dash CLAIMED usually arrives at the mouth about
// 0.29s after the dash has finished — and was swallowed with no bang. That is
// the bug this covers, and it is invisible to any check that fires
// pickupBlast() while the dash is still up.
//
// The window must also stay SHUT for an ordinary swim-into, or every pickup in
// the game detonates.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import { strikeState, resetStrike, pickupBlast, updateStrike } from '../path/src/systems/strike.js';
import { magnetRadius, magnetSpeed } from '../path/src/systems/chumMagnet.js';
const stats = { strikeDamage: 10, aoeMul: 1 };
const ds = CONFIG.strike.dashSpeed, dt = 1/60;
let fail = 0;
const check=(n,c,d='')=>{console.log(`  ${c?'PASS':'FAIL'}  ${n}${d?' — '+d:''}`);if(!c)fail++;};

// How long an orb claimed at the edge of the dash magnet takes to reach the mouth
const reach = magnetRadius(CONFIG.player, ds), close = magnetSpeed(ds) - ds;
const travel = reach / close;
console.log(`the magnet claims out to ${reach.toFixed(2)}u and closes at ${close.toFixed(1)}u/s -> ${travel.toFixed(2)}s to arrive\n`);

resetStrike();
strikeState.active = true; strikeState.power = 1;
check('a pickup taken mid-dash pops', pickupBlast(stats, 1).damage > 0);

// the dash ends; the orb is still travelling
strikeState.active = false;
strikeState.blastGrace = CONFIG.strike.pickupBlast.grace;
let t = 0;
while (t < travel) { updateStrike(dt, stats); t += dt; }
check('...and still pops when it lands after the dash', pickupBlast(stats, 1).damage > 0,
  `${travel.toFixed(2)}s later, ${strikeState.blastGrace.toFixed(2)}s of grace left`);

// well past the window
while (strikeState.blastGrace > 0) { updateStrike(dt, stats); }
check('a pickup swum into long after does NOT pop', pickupBlast(stats, 1).damage === 0);

resetStrike();
check('a reset closes the window', strikeState.blastGrace === 0);
check('cruising into a pickup never pops', pickupBlast(stats, 1).damage === 0);

// power survives the dash so a flick still pops like a flick
resetStrike();
strikeState.power = 0.25; strikeState.blastGrace = 0.3;
const flick = pickupBlast(stats, 1);
strikeState.power = 1;
const full = pickupBlast(stats, 1);
check('the grace pop still rides the dash it came from', flick.radius < full.radius,
  `flick ${flick.radius.toFixed(1)}u vs full ${full.radius.toFixed(1)}u`);
console.log(fail ? `\n${fail} failing` : '\nall passing');
process.exit(fail?1:0);
