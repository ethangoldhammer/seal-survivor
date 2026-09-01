#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:airtime
//
// WHAT LEAVING THE WATER IS WORTH. Air time is a mechanic made entirely of
// things a screenshot cannot answer: a ramp that builds over seconds, a jump
// budget that refills on a crossing, a payout banked at the top of an arc and
// spent at the bottom of it. The browser preview cannot even run it — that pane
// suspends requestAnimationFrame, so the loop is frozen there and the seal
// never leaves the water at all.
//
// Seven things worth failing over:
//
//   FILES WIN   that weapons.csv is what CONFIG.airborne actually holds, and
//               that none of it leaks into a saved tuning snapshot. These were
//               never sliders, but the rule that keeps them out of the snapshot
//               is per-ROW and silently stops applying to a row nobody checked.
//
//   RAMP        that the two axes — hang time and jumps — sum, cap, and read
//               ZERO in the water. The identity value is the whole reason every
//               call site can multiply unconditionally; a ramp that returned
//               anything but 0 underwater would hand a submerged seal a bonus
//               at every one of them.
//
//   JUMPS       that the budget is per BREACH: granted in the air, refilled by
//               re-entry, never available below the line. And that the launch
//               speed is the same in every direction — the up-bias is a vector
//               blend, and getting it wrong makes a downward jump slower than
//               an upward one rather than merely lower.
//
//   THE ARC     that a mid-air jump actually buys hang time, MEASURED AGAINST A
//               CONTROL RUN rather than against the launch — an arc's height is
//               mostly the launch's, and a jump that did nothing would still
//               look like it worked if you only read the apex.
//
//   THE BANK    that the payout survives the descent. `airPeak` exists because
//               the slam is paid at the water line, seconds after the ramp that
//               earned it peaked; reading the live ramp there would refuse to
//               pay for a jump spent at the apex, which is the single most
//               expensive thing in the mechanic.
//
//   THE BREATH  that air time is also AIR: the tank refills only above the
//               line, at the rate weapons.csv states, and a run opens on a full
//               one. The rate is the exchange rate of the whole dive — how many
//               seconds under the water one second up here buys — and it lived
//               in a snapshot for long enough that config.js disagreed with the
//               shipped game by 35%.
//
//   THE TRAIL   that the ribbons start on the breach, stop recording at
//               re-entry, dissolve, and DON'T stripe across the arena from the
//               end of one arc to the start of the next.
//
// What it cannot tell you: whether any of it feels good, or whether the trail
// looks like paint. That is a controller and a screen. What it can tell you is
// whether the numbers are honest.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG, TUNER_SCHEMA } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer, updatePlayer } from '../path/src/entities/player.js';
import {
  airRampFor, airRamp, updateAirborne, resetAirborne, airState,
  airDamageMul, airFireRateMul, airPickupMul,
  canAirJump, spendAirJump, slamFor, launchFor,
} from '../path/src/systems/airborne.js';
import { updateBreachTrail, clearBreachTrail, breachTrailCount, breachTrailStats, breachTrailNodes } from '../path/src/systems/breachTrail.js';
import { onFeedback } from '../path/src/systems/feedback.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

// The animation controller warns for every state the procedural stand-in has
// no clip for, which here is all of them — no models are loaded in Node.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && msg.startsWith('[animation]')) return;
  realWarn(msg, ...rest);
};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
function note(text) { console.log(`        ${text}`); }
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

updateBounds(16 / 9);
initPlayer(scene);

const A = CONFIG.airborne;
const noInput = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) };

// ---------------------------------------------------------------------------
section('THE FILE WINS — weapons.csv owns every gameplay number here');
{
  const csv = readFileSync(new URL('../path/src/weapons.csv', import.meta.url), 'utf8');
  const rows = csv.split('\n').filter((l) => l.startsWith('airborne.'));
  check('airborne rows are in weapons.csv', rows.length >= 15, `${rows.length} rows`);

  // Every row's value is what CONFIG ended up holding. This is the check that
  // catches a path typo: pathTable warns and skips a path matching nothing, so
  // a misspelled row leaves the built-in in place and looks set.
  let mismatched = 0;
  for (const line of rows) {
    const [id, value] = line.split(',');
    const live = id.split('.').reduce((a, k) => (a == null ? a : a[k]), CONFIG);
    const want = typeof live === 'boolean' ? value === '1' : Number(value);
    if (live !== want) { mismatched++; note(`${id}: csv ${want} but CONFIG holds ${live}`); }
  }
  check('every row reached CONFIG', mismatched === 0, `${rows.length - mismatched}/${rows.length} agree`);

  // THE SPLIT, enforced. Look-and-feel is judged by eye in the second it
  // happens and belongs on a slider; throughput is judged over a run and
  // belongs in the file. One mechanic, two homes, and the only thing keeping
  // them apart is that nobody adds the wrong pill.
  const paths = TUNER_SCHEMA.flatMap((g) => g.items ?? []).map((i) => i.path ?? '');
  const trailPills = paths.filter((p) => p.startsWith('breachTrail.')).length;
  const airPills = paths.filter((p) => p.startsWith('airborne.'));
  check('the TRAIL is on sliders', trailPills > 10, `${trailPills} pills`);
  check('...and air time is NOT', airPills.length === 0,
    airPills.length ? airPills.join(', ') : 'every gameplay number stays in the CSV');
}

// ---------------------------------------------------------------------------
section('RAMP — hang time and jumps sum, cap, and read zero in the water');
{
  check('zero underwater, whatever the clock says',
    airRampFor(false, 99, 4) === 0, 'the identity value every call site relies on');
  check('zero at the instant of the crossing',
    airRampFor(true, 0, 0) === 0);
  check('half the ramp time is half the ramp',
    near(airRampFor(true, A.rampTime / 2, 0), 0.5, 1e-6),
    `${airRampFor(true, A.rampTime / 2, 0).toFixed(3)}`);
  check('hang alone tops out at 1',
    near(airRampFor(true, A.rampTime * 5, 0), 1, 1e-6), 'flat after rampTime, not runaway');
  check('one jump is worth jumpRamp on top',
    near(airRampFor(true, 0, 1), A.jumpRamp, 1e-6), `+${A.jumpRamp}`);
  check('the two axes sum',
    near(airRampFor(true, A.rampTime, 1), Math.min(A.maxRamp, 1 + A.jumpRamp), 1e-6));
  check('capped at maxRamp',
    near(airRampFor(true, A.rampTime * 3, 9), A.maxRamp, 1e-6), `${A.maxRamp}`);

  // The identity rule, at the three real consuming sites.
  resetAirborne();
  check('every multiplier is exactly 1 with no air',
    airDamageMul() === 1 && airFireRateMul() === 1 && airPickupMul() === 1,
    'a run that never breaches multiplies by 1 everywhere');

  airState.ramp = A.maxRamp;
  const dmg = airDamageMul();
  const rate = airFireRateMul();
  const pick = airPickupMul();
  check('...and above 1 at full air',
    dmg > 1 && rate > 1 && pick > 1,
    `damage x${dmg.toFixed(2)}, fire rate x${rate.toFixed(2)}, reach x${pick.toFixed(2)}`);
  resetAirborne();
}

// ---------------------------------------------------------------------------
section('JUMPS — a budget per breach, refilled by re-entry');
{
  resetPlayer();
  player.aboveSurface = false;
  player.airJumps = 0;
  check('none in the water', !canAirJump(player), 'the surface is the gate, not the counter');

  player.aboveSurface = true;
  check('granted in the air', canAirJump(player), `${A.jumps.max} per breach`);

  let spent = 0;
  while (canAirJump(player) && spent < 20) { spendAirJump(player, { x: 1, y: 0 }); spent++; }
  check('exactly the configured number', spent === A.jumps.max, `${spent} spent`);
  check('...and then nothing', !canAirJump(player) && spendAirJump(player, { x: 1, y: 0 }) === null);

  // Speed is direction-independent. The up-bias is a vector blend followed by a
  // renormalise, so aiming down must cost height and NOT speed — clamping
  // instead of blending is the mistake that makes a downward jump sluggish.
  player.airJumps = 0;
  const up = spendAirJump(player, { x: 0, y: 1 });
  player.airJumps = 0;
  const down = spendAirJump(player, { x: 0, y: -1 });
  player.airJumps = 0;
  const side = spendAirJump(player, { x: 1, y: 0 });
  const speeds = [up, down, side].map((j) => Math.hypot(j.vx, j.vy));
  check('the same launch speed in every direction',
    speeds.every((s) => near(s, A.jumps.speed, 1e-4)),
    speeds.map((s) => s.toFixed(2)).join(' / '));
  check('the bias lifts every launch toward vertical',
    up.vy > side.vy && side.vy > down.vy && side.vy > 0,
    `up ${up.vy.toFixed(1)} / level ${side.vy.toFixed(1)} / down ${down.vy.toFixed(1)}`);
  // Below an upBias of 0.5 an aim straight down stays a DIVE, and that is the
  // fork the move is built around: up buys hang time and the live multipliers,
  // down converts height into the impact speed the splash-down pays for. A
  // test that demanded height in every direction would be testing a different,
  // duller mechanic.
  check('...but aiming straight down is still a dive', down.vy < 0,
    `vy ${down.vy.toFixed(1)} — the setup for a heavy slam`);
  // No direction at all is the one case that must not be ambiguous.
  player.airJumps = 0;
  const idle = spendAirJump(player, { x: 0, y: 0 });
  player.airJumps = 0;
  check('a release with no direction goes straight up',
    near(idle.vx, 0, 1e-6) && near(idle.vy, A.jumps.speed, 1e-4));

  // The refill is the CROSSING, not a timer: player.js clears airJumps on the
  // upward crossing, so this proves the two files agree about who owns it.
  player.airJumps = A.jumps.max;
  resetPlayer();
  player.mesh.position.set(0, bounds.surfaceY - 0.5, 0);
  player.velocity.set(0, 26);
  for (let i = 0; i < 8 && !player.aboveSurface; i++) updatePlayer(dt, noInput);
  check('a fresh breach refills the budget', player.airJumps === 0 && canAirJump(player),
    'cleared on the upward crossing, in player.js');
}

// ---------------------------------------------------------------------------
// ONE ARC, FLOWN. Launched from the water line and run until it comes back
// down, with the option to spend a jump at a chosen moment.
//
// `jumpAt` is seconds after the launch. The whole point of the control run is
// that an arc's height is mostly its LAUNCH's — a jump that did nothing at all
// would still leave a tall arc, so the only honest reading is the difference
// between two runs that started identically.
// ---------------------------------------------------------------------------
function arc({ speed = 26, angleDeg = 80, jumpAt = null } = {}) {
  resetPlayer();
  resetAirborne();
  const a = (angleDeg * Math.PI) / 180;
  player.mesh.position.set(0, bounds.surfaceY + 0.01, 0);
  player.velocity.set(Math.cos(a) * speed, Math.sin(a) * speed);
  player.aboveSurface = true;
  player.airTime = 0;
  player.airJumps = 0;
  player.airPeak = 0;

  let air = 0;
  let apex = 0;
  let jumped = false;
  let slam = null;

  for (let i = 0; i < 60 * 20; i++) {
    if (jumpAt != null && !jumped && air >= jumpAt && canAirJump(player)) {
      const j = spendAirJump(player, { x: 0.2, y: 0.98 });
      if (j) { player.velocity.set(j.vx, j.vy); player.dashTimer = 0.12; jumped = true; }
    }
    updatePlayer(dt, noInput);
    updateAirborne(player);
    if (player.breachDir < 0) {
      slam = slamFor(player, Math.max(0, -player.velocity.y));
      break;
    }
    if (!player.aboveSurface) break;
    air += dt;
    apex = Math.max(apex, player.mesh.position.y - bounds.surfaceY);
  }
  return { air, apex, slam, peak: player.airPeak, jumps: player.airJumps };
}

section('THE ARC — a mid-air jump buys hang time, measured against a control');
{
  const control = arc({});
  const jumped = arc({ jumpAt: 0.35 });

  check('the control arc leaves the water and comes back',
    control.air > 0.4 && control.slam !== null,
    `${control.air.toFixed(2)}s airborne, apex ${control.apex.toFixed(1)}u`);
  check('the jump was actually spent', jumped.jumps === 1);
  check('...and it bought hang time',
    jumped.air > control.air * 1.15,
    `${control.air.toFixed(2)}s -> ${jumped.air.toFixed(2)}s`);
  check('...and height',
    jumped.apex > control.apex,
    `${control.apex.toFixed(1)}u -> ${jumped.apex.toFixed(1)}u`);
  check('the ramp ends higher for the jumped arc',
    jumped.peak > control.peak,
    `peak ${control.peak.toFixed(2)} -> ${jumped.peak.toFixed(2)}`);
}

section('THE BANK — the payout survives the descent');
{
  const jumped = arc({ jumpAt: 0.35 });
  // The live ramp at the water line is what a naive implementation would pay
  // against. It is not zero (the seal is still technically above the line on
  // the crossing frame), but the PEAK is what the jump earned, and the gap
  // between the two is exactly what airPeak exists to protect.
  check('the slam pays at all', jumped.slam !== null);
  check('...against the peak, not the moment of impact',
    near(jumped.slam.ramp, jumped.peak, 1e-6),
    `paid at ramp ${jumped.slam.ramp.toFixed(2)}`);
  check('damage and radius are both real',
    jumped.slam.damage > 0 && jumped.slam.radius > 0,
    `${jumped.slam.damage.toFixed(0)} dmg over ${jumped.slam.radius.toFixed(1)}u`);
  check('a jumped arc slams harder than a plain one',
    jumped.slam.damage > (arc({}).slam?.damage ?? 0),
    'the jump is worth something on landing, not just in the air');

  // Impact speed is the second axis, and it must move the damage without
  // moving the reach — reach is what the player aims with.
  const slow = slamFor({ airPeak: 1 }, 0);
  const fast = slamFor({ airPeak: 1 }, 40);
  check('a committed landing hits harder', fast.damage > slow.damage,
    `${slow.damage.toFixed(0)} -> ${fast.damage.toFixed(0)}`);
  check('...but does NOT reach further', near(fast.radius, slow.radius, 1e-9),
    'aiming stays predictable');
  check('the speed multiplier is capped',
    near(slamFor({ airPeak: 1 }, 9999).speedMul, A.slam.speedMax, 1e-6),
    `x${A.slam.speedMax}`);

  // A skim must pay NOTHING, or the mechanic fires on every accidental brush
  // with the surface and stops meaning anything.
  check('a skim off the surface pays nothing',
    slamFor({ airPeak: A.slam.minRamp * 0.5 }, 10) === null,
    `below minRamp ${A.slam.minRamp}`);
  check('...and just over the line pays something',
    slamFor({ airPeak: A.slam.minRamp * 1.01 }, 10) !== null);
}

// ---------------------------------------------------------------------------
section('THE CROSSING — a head coming up is not an animal leaving the sea');
// ---------------------------------------------------------------------------
// One upward crossing used to be one event whatever it was, so the quietest
// thing the seal does and the loudest were announced with the same sound, the
// same shake and the same wall of foam. THE FAILURE THIS CATCHES IS THE SPLIT
// COLLAPSING: a threshold nudged past every reachable speed, or a `flying`
// that is always true, leaves both cues wired, both audible in the F menu, and
// one of them never fired in a run. Nothing throws and the panel looks right.
//
// So the events are read off a REAL crossing rather than off launchFor, and
// both sides of the line are flown.
{
  const A_L = CONFIG.airborne.launch;
  // CONFIG.arena.gravity, and read rather than assumed: it is TUNED, and does
  // not hold config.js's declared 29.7 in a live run.
  const g = CONFIG.arena.gravity;
  // The speed that buys exactly `flyAir` seconds of hang — the line itself,
  // derived here the same way launchFor derives it. A hand-typed speed would
  // be a second opinion about where the line is.
  const lineSpeed = (g * A_L.flyAir) / 2;

  // Fly one crossing and report which surface events it announced.
  function cross(riseSpeed) {
    const heard = [];
    const stop = onFeedback((event) => {
      if (event === 'breach' || event === 'surfacing') heard.push(event);
    });
    resetPlayer();
    resetAirborne();
    // Started BELOW the water line and driven up through it, rather than
    // placed above it: `breachDir` is written by the crossing itself, so a
    // seal spawned in the air has already missed the only frame that fires
    // anything.
    player.mesh.position.set(0, bounds.surfaceY - 0.5, 0);
    player.velocity.set(0, riseSpeed);
    for (let i = 0; i < 60 && !player.aboveSurface; i++) updatePlayer(dt, noInput);
    stop();
    return heard;
  }

  // Well clear of the line on both sides — the frames before the crossing cost
  // a little speed to gravity, and a subject sitting exactly on it would be
  // measuring that loss rather than the decision.
  const slow = cross(lineSpeed * 0.5);
  const fast = cross(lineSpeed * 3);
  check('a slow crossing surfaces', slow.length === 1 && slow[0] === 'surfacing',
    slow.join(', ') || 'silence');
  check('a fast one breaches', fast.length === 1 && fast[0] === 'breach',
    fast.join(', ') || 'silence');
  // Exactly one of the two, always. Two cues on one crossing is the same bug
  // as none, and is what a split that forgot its `else` looks like.
  check('...and never both', slow.length === 1 && fast.length === 1,
    `${slow.length} slow / ${fast.length} fast`);

  // THE LINE IS REACHABLE FROM BOTH DIRECTIONS. A threshold set above any
  // speed the seal can leave the water at would make `breach` dead, and one at
  // zero would make `surfacing` dead — both pass every other check here.
  check('the line sits inside the speeds a seal actually leaves at',
    lineSpeed > 1 && lineSpeed < A.jumps.speed,
    `${lineSpeed.toFixed(1)} u/s, against a ${A.jumps.speed} u/s launch`);

  // The conversion itself. Seconds of air is the unit both numbers are
  // authored in, so it has to be the unit the code works in.
  const l = launchFor(player, lineSpeed);
  check('the line is exactly flyAir seconds of hang', near(l.air, A_L.flyAir, 1e-6),
    `${l.air.toFixed(3)}s`);
  check('...and a peak under a fifth of the seal', l.height < 1.3,
    `${l.height.toFixed(2)} world units of a ~6.1-unit animal`);
  check('...and it is the boundary, not a gap',
    launchFor(player, lineSpeed * 1.001).flying && !launchFor(player, lineSpeed * 0.999).flying);

  // The scale the loud cue rides is the formula it has always ridden — the
  // split must change WHICH cue fires and nothing about how the big one feels.
  // 14 is the divisor that was hand-typed into player.js for years; fullAir is
  // where it came from.
  // The loud cue's ramp is the number that was hand-typed into player.js, moved
  // rather than rewritten. If this ever stops being 14 it is a decision about
  // the existing breach and not a side effect of the split.
  check('a full breach still scales the way it always did', A_L.fullSpeed === 14,
    `${A_L.fullSpeed} u/s`);
  check('...and it is a SPEED, not a gravity-derived time — see the config note',
    near(launchFor(player, A_L.fullSpeed).scale, 1.5, 1e-9),
    `${launchFor(player, A_L.fullSpeed).scale}`);
  check('...and the cue is capped', launchFor(player, 9999).scale === 2);

  // THE TWO CUES HAVE TO BE DIFFERENT WEIGHTS. Identical channels would pass
  // everything above: the split would be working perfectly and inaudible.
  const B = CONFIG.feedback.breach;
  const S = CONFIG.feedback.surfacing;
  // ...ON A CHANNEL THE MUTE LEAVES ALONE. Neither of these is on
  // CONFIG.fx.shakeOnly, so both shakes are gated to 0 by design — a hundred
  // and sixteen events carrying one is the same as none of them carrying one,
  // and the guest list is what fixed that. Comparing them here asked whether
  // two muted numbers differ, which they cannot, and reported the feature as a
  // fault: `0 vs 0`.
  //
  // The claim is still worth making — the two cues must be different weights or
  // the split is inaudible — so it is made where the difference survives. The
  // camera half is checked as gating rather than as magnitude.
  const gated = CONFIG.fx.shakeOnly ?? [];
  if (gated.includes('breach') || gated.includes('surfacing')) {
    check('the quiet one barely moves the camera', S.shake < B.shake * 0.25,
      `${S.shake} vs ${B.shake}`);
  } else {
    check('neither surfacing nor breaching takes the camera — both off the guest list',
      !(S.shake > 0) && !(B.shake > 0), `${S.shake} / ${B.shake}`);
    check('...and the quiet one is still the dimmer of the two',
      S.glow < B.glow * 0.5, `glow ${S.glow} vs ${B.glow}`);
  }
  check('...and ripples smaller', S.ripple.strength < B.ripple.strength * 0.5,
    `${S.ripple.strength} vs ${B.ripple.strength}`);
  check('...and is its own voice, not the breach again', S.sfx !== B.sfx, `${S.sfx} / ${B.sfx}`);
  check('...darker than the breach, which is the separation',
    CONFIG.sfx[S.sfx].filter < CONFIG.sfx[B.sfx].filter,
    `${CONFIG.sfx[S.sfx].filter}Hz vs ${CONFIG.sfx[B.sfx].filter}Hz`);
  // A seal resting at the surface bobs through the water line, and every bob
  // is an honest upward crossing. Only the quiet one can chatter.
  check('...and is throttled, unlike the breach', S.sfxMinGap > 0 && !B.sfxMinGap,
    `${S.sfxMinGap}s vs ${B.sfxMinGap}`);

  // THE ESCAPE HATCH, and it has to be the old behaviour exactly rather than
  // "mostly": switching the split off is how a bad line is ruled out as the
  // cause of something, which only works if off means off.
  {
    const was = A_L.enabled;
    A_L.enabled = false;
    const off = cross(lineSpeed * 0.5);
    // Sampled BEFORE the restore. Asked after it, this reads the live config
    // and passes or fails on nothing to do with the switch.
    const silentWhileOff = launchFor(player, 1) === null;
    A_L.enabled = was;
    check('with the split off, every crossing is a breach again',
      off.length === 1 && off[0] === 'breach', off.join(', ') || 'silence');
    check('...and launchFor says so rather than guessing', silentWhileOff);
  }
}

// ---------------------------------------------------------------------------
section('THE BREATH — air refills the tank, and a run opens on a full one');
{
  const O = CONFIG.oxygen;
  // Same file-wins check as the airborne rows above, for the one oxygen number
  // that describes the breach rather than the bubble. It was a slider until
  // the refill was retuned, and the slider is why config.js said 26 while the
  // game ran on the 35 in imported-tuning.json — a value nobody could reach
  // from the file that appears to hold it.
  const csv = readFileSync(new URL('../path/src/weapons.csv', import.meta.url), 'utf8');
  const row = csv.split('\n').find((l) => l.startsWith('oxygen.refillRateSurface,'));
  check('weapons.csv owns the surface refill rate', !!row,
    row ? `row value ${row.split(',')[1]}` : 'no row — a snapshot can shadow it again');
  check('...and the row is what CONFIG holds',
    !!row && near(O.refillRateSurface, Number(row.split(',')[1]), 1e-9),
    `CONFIG ${O.refillRateSurface}`);
  const pills = TUNER_SCHEMA.flatMap((g) => g.items ?? []).map((i) => i.path ?? '');
  check('...with no slider left to disagree with it',
    !pills.includes('oxygen.refillRateSurface'));

  // A RUN OPENS ON A FULL TANK. resetPlayer clears the upgrades first, so this
  // is the BASE cap being filled rather than last run's Deep Lungs stack —
  // measured off the stat block for that reason, not off CONFIG.
  resetPlayer();
  check('a new run starts on a full breath',
    player.oxygen === player.stats.maxOxygen,
    `${player.oxygen} / ${player.stats.maxOxygen}`);

  // THE RATE THE PLAYER ACTUALLY GETS, integrated through updatePlayer rather
  // than read off CONFIG — the refill is one branch of a test on `aboveSurface`
  // and the interesting failure is the branch never running, which reading the
  // number back would never catch.
  const holdAt = (y, seconds) => {
    const from = player.oxygen;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      player.mesh.position.set(0, y, 0);
      player.velocity.set(0, 0);
      updatePlayer(dt, noInput);
    }
    return (player.oxygen - from) / seconds;
  };

  // Emptied by a real dive, not by assignment, and deep enough that the second
  // of air below cannot clip against the cap — a clamped measurement reads as
  // a refill rate that is merely "less than configured".
  const drain = holdAt((bounds.bottom + bounds.surfaceY) / 2, 15);
  check('the tank empties underwater at the configured rate',
    near(-drain, O.depleteRate, 1e-6), `${(-drain).toFixed(2)}/s`);

  const gain = holdAt(bounds.surfaceY + 3, 1);
  check('a breach refills it at the rate the file states',
    near(gain, O.refillRateSurface, 1e-6), `${gain.toFixed(2)}/s`);

  // THE EXCHANGE RATE, which is the number the mechanic is actually tuned on:
  // one second of air is worth this many seconds under. Stated rather than
  // asserted at a threshold — the claim worth failing over is that air buys
  // MORE than it costs, or surfacing is a losing trade and nobody does it.
  const exchange = O.refillRateSurface / O.depleteRate;
  check('a second in the air buys more than a second of dive', exchange > 1,
    `x${exchange.toFixed(1)} — a full ${O.max}-point breath in ${(O.max / O.refillRateSurface).toFixed(1)}s of air`);

  // And the branch really is the water line: below it nothing comes back, or
  // the whole mechanic is decoration.
  player.oxygen = O.max * 0.5;
  const under = holdAt(bounds.surfaceY - 4, 0.5);
  check('nothing refills below the line', under < 0, `${under.toFixed(2)}/s`);
  resetPlayer();
}

// ---------------------------------------------------------------------------
section('THE TRAIL — an RGB split, not a rainbow');
{
  clearBreachTrail(scene);
  const T = CONFIG.breachTrail;
  // The scene node is a root holding one subgroup PER PLUME (one per tail fin),
  // and the three channel ribbons live one level down inside each. `chan` walks
  // that for the first plume, which is the only one the fake seal below has.
  const ribbons = () => scene.getObjectByName('breachTrail');
  const plume0 = () => ribbons()?.children?.[0];
  const chan = (i) => plume0()?.children?.[i];
  const visible = () => !!(ribbons()?.visible && plume0()?.visible);

  // Underwater: nothing at all. A trail that built history below the line
  // would draw the seal's whole swim as paint.
  player.mesh.position.set(0, bounds.surfaceY - 4, 0);
  player.aboveSurface = false;
  for (let i = 0; i < 10; i++) updateBreachTrail(dt, scene, player, 0);
  check('nothing while submerged', !visible());

  // Airborne: three ribbons, drawn.
  player.aboveSurface = true;
  for (let i = 0; i < 20; i++) {
    player.mesh.position.set(i * 0.4, bounds.surfaceY + 2 + Math.sin(i * 0.3) * 2, 0);
    updateBreachTrail(dt, scene, player, 1);
  }
  check('three ribbons, one per channel', plume0()?.children.length === 3);
  check('drawn while airborne', visible());

  // The split. With a lag configured and a curving path, the three channels
  // must NOT sit on top of each other — that is the entire effect.
  // A SPLIT, NOT A RAINBOW. Every check below is about the same distinction:
  // three samples of ONE bright thing, a hair apart, so they reconstruct a white
  // core and fringe only at the edges. Three ribbons that never overlap are a
  // rainbow stripe, which is a different effect and a much worse one.

  // Sampled MID-RIBBON. The split is deliberately faded to zero at both tips —
  // the along-path read would otherwise clamp off the end of the curve and
  // splay the head into a comb of coloured hairs — so a reading taken at the
  // head measures the fade rather than the split.
  const midIdx = Math.floor(T.samples * 0.4);
  const spineHeads = plume0().children.map((m) => {
    const p = m.geometry.attributes.position;
    return [
      (p.getX(midIdx * 2) + p.getX(midIdx * 2 + 1)) / 2,
      (p.getY(midIdx * 2) + p.getY(midIdx * 2 + 1)) / 2,
    ];
  });
  const spread = Math.max(
    Math.hypot(spineHeads[0][0] - spineHeads[1][0], spineHeads[0][1] - spineHeads[1][1]),
    Math.hypot(spineHeads[1][0] - spineHeads[2][0], spineHeads[1][1] - spineHeads[2][1]),
  );
  check('the channels are offset from each other at all', spread > 0.001,
    `${spread.toFixed(3)}u between adjacent channel spines`);
  // ...and the offset lands INSIDE the band. This is the geometric condition
  // for a white core: channels further apart than the ribbon is wide have
  // nothing left to overlap, and the trail becomes three coloured stripes.
  check('...but by less than the ribbon is wide, so they still overlap',
    spread < CONFIG.breachTrail.width,
    `${spread.toFixed(3)}u offset vs ${CONFIG.breachTrail.width}u width`);

  // AND IT STAYS A FRINGE AT SPEED. This is the check that earns its keep: the
  // obvious implementation offsets the channels by FRAMES of history, which
  // makes the split scale with velocity — a fringe at a lazy swim and three
  // fully separated ribbons at dash speed, i.e. the rainbow arriving exactly
  // when the player is moving fast enough to look at it. Measured in units
  // along the path, the two runs below must agree.
  //
  // Compared as a RATIO rather than an equality. The two runs are not expected
  // to agree exactly any more: the spine the offset is walked along is a
  // billowing cloud, not a clean path, so its local direction wanders and the
  // measured separation moves with it. What must not happen is the split
  // SCALING with speed — a frame-based offset gives roughly a tenfold spread
  // across this range, which no tolerance here would let through.
  const splitAtSpeed = (perFrame) => {
    clearBreachTrail(scene);
    player.aboveSurface = true;
    player.velocity.set(perFrame * 60, 0);
    for (let i = 0; i < 24; i++) {
      player.mesh.position.set(i * perFrame, bounds.surfaceY + 5, 0);
      updateBreachTrail(dt, scene, player, 1);
    }
    // Sampled at MID-RIBBON, not at the head. The split is deliberately scaled
    // by the local band width, and the band is thin at the head (new particles
    // haven't grown into it yet) — so a head reading measures the taper rather
    // than the split, and reports it as scaling with speed.
    const at = Math.floor(T.samples * 0.4);
    const s = plume0().children.map((m) => {
      const p = m.geometry.attributes.position;
      return [
        (p.getX(at * 2) + p.getX(at * 2 + 1)) / 2,
        (p.getY(at * 2) + p.getY(at * 2 + 1)) / 2,
      ];
    });
    return Math.hypot(s[0][0] - s[2][0], s[0][1] - s[2][1]);
  };
  // Measured on a STRAIGHT, full-width spine at both speeds, which takes three
  // deliberate suspensions:
  //
  //   growth 0, foldSafety 1  the split is scaled by the LOCAL band width (see
  //                           `grip`), and that taper is age-dependent, so a
  //                           given sample is a different point in a particle's
  //                           life at 5 u/s than at 46.
  //   blowOut/turbulence 0    the along-path half of the offset is measured in
  //                           ARC LENGTH. On a tortuous spine a fixed arc length
  //                           maps to a much shorter straight-line distance, so
  //                           a tangled slow cloud and a stretched fast one read
  //                           differently for reasons that have nothing to do
  //                           with the question.
  //
  // What is left is exactly the thing under test: is the offset a DISTANCE, or
  // is it a number of frames? Frames would give roughly a tenfold spread here.
  const saved = { growth: T.growth, foldSafety: T.foldSafety, blowOut: T.blowOut, turbulence: T.turbulence };
  Object.assign(CONFIG.breachTrail, { growth: 0, foldSafety: 1, blowOut: 0, turbulence: 0 });
  const slow = splitAtSpeed(0.08); // ~5 u/s, a drift
  const fast = splitAtSpeed(0.77); // ~46 u/s, a full strike dash
  Object.assign(CONFIG.breachTrail, saved);
  const ratio = Math.max(slow, fast) / Math.max(1e-6, Math.min(slow, fast));
  check('the split does not scale with speed', ratio < 1.8,
    `${slow.toFixed(3)}u at 5 u/s vs ${fast.toFixed(3)}u at 46 u/s (x${ratio.toFixed(2)})`);
  check('...and stays inside the band at both',
    slow < CONFIG.breachTrail.width && fast < CONFIG.breachTrail.width,
    `vs ${CONFIG.breachTrail.width}u width — the white core survives`);

  // Rebuild the curving trail the checks below read.
  clearBreachTrail(scene);
  player.aboveSurface = true;
  for (let i = 0; i < 20; i++) {
    player.mesh.position.set(i * 0.4, bounds.surfaceY + 2 + Math.sin(i * 0.3) * 2, 0);
    updateBreachTrail(dt, scene, player, 1);
  }

  // The channels have to be PURE primaries or they cannot sum back to white,
  // however well they overlap. One non-zero component each, and the three
  // together neutral.
  const chans = CONFIG.breachTrail.colors.map((hex) => new THREE.Color(hex));
  const pure = chans.every((c) => [c.r, c.g, c.b].filter((v) => v > 0.001).length === 1);
  const sum = chans.reduce((a, c) => [a[0] + c.r, a[1] + c.g, a[2] + c.b], [0, 0, 0]);
  check('the channels are pure R/G/B', pure,
    CONFIG.breachTrail.colors.map((h) => '#' + h.toString(16).padStart(6, '0')).join(' '));

  // THE OVERLAP RULE, checked on the numbers rather than on the geometry.
  //
  // Every measurement in this section reads the MERGED config — a saved tuning
  // value beats a config.js default — so none of them can guard what the game
  // actually ships with. This one can, because both offsets are expressed as
  // fractions of the band width, which makes the invariant pure arithmetic: the
  // two are perpendicular (one along the path, one across it), so the distance
  // between adjacent channels is their hypotenuse, and it has to stay under one
  // full width or the halos stop overlapping and the neutral core is gone. That
  // is the line between an RGB split and a rainbow.
  // READ FROM THE SOURCE, not from CONFIG. This is the only check in the file
  // that can see what the game SHIPS with: a saved tuning value beats a
  // config.js default, so `CONFIG.breachTrail.channelSpread` is whatever was
  // last dragged in the tuner on this machine — which means every other
  // measurement here is validating one developer's session rather than the
  // committed defaults. Parsing the literal out of the file is the only way
  // past that, and it is worth doing for exactly these two numbers because
  // they are the ones with a cliff at the top of their range.
  const src = readFileSync(new URL('../path/src/config.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('  breachTrail: {'), src.indexOf('  trails: {'));
  const lit = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*([0-9.]+)`, 'm').exec(block);
    return m ? Number(m[1]) : NaN;
  };
  const dTrail = lit('channelTrail');
  const dSpread = lit('channelSpread');
  const dCore = lit('coreWidth');
  const offs = Math.hypot(dTrail, dSpread);
  check('the shipped split stays under one band width', offs < 1,
    `hypot(trail ${dTrail}, spread ${dSpread}) = ${offs.toFixed(2)} of a width`);
  // ...and the cores must be well INSIDE that, or there is nothing separating
  // to make colour with in the first place.
  check('...but is comfortably wider than the shipped core', offs > dCore * 3,
    `core ${dCore} of a half-width vs split ${offs.toFixed(2)}`);

  // WHETHER THE HALOS STILL OVERLAP — reported rather than failed, because it
  // is an art decision with a hard geometric consequence and the two are worth
  // keeping apart.
  //
  // The band's RADIUS is half its width, so a channel offset is measured
  // against 0.5, not against 1. Below about a quarter the three halos sit on
  // top of each other and sum to a neutral core with coloured fringes — an RGB
  // split. Past 0.5 they have no overlap left at all and each channel is drawn
  // alone, which is a SPECTRUM: red, orange, yellow, green, cyan, blue in
  // bands, with no white anywhere. The check above only catches the far end of
  // that; this line is what tells you which side of the line the look is on.
  const zone = offs < 0.25 ? 'a split — halos overlap, neutral core'
    : offs < 0.5 ? 'transitional — the core is thinning out'
    : 'a SPECTRUM — the halos no longer overlap, there is no white core';
  note(`split is ${offs.toFixed(2)} of a band width (radius is 0.5): ${zone}`);
  check('...so together they reconstruct white',
    near(sum[0], sum[1], 1e-6) && near(sum[1], sum[2], 1e-6),
    `sum ${sum.map((v) => v.toFixed(2)).join(', ')}`);

  // THE CROSS-SECTION, which lives in the fragment shader now rather than in
  // vertex colours. The JS twin below has to match trailFragmentShader exactly;
  // it is here because the shape is the single thing that decides whether the
  // trail reads as a glowing line or as cut paper, and a GLSL function is
  // otherwise unreachable from a Node harness (see the note in the memory about
  // GLSL errors needing a real GL context — this tests the MATHS, and only the
  // maths).
  updateBreachTrail(dt, scene, player, CONFIG.airborne.maxRamp);
  const profile = (d) => {
    const smooth = (e0, e1, x) => {
      const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    const core = 1 - smooth(0, Math.max(T.coreWidth, 0.001), d);
    const halo = Math.exp(-(d ** T.softness) * 4);
    return core * T.coreGain + halo * T.haloGain;
  };
  const centre = profile(0);
  const mid = profile(0.5);
  const lip = profile(1);
  check('the cross-section peaks at the centre', centre > mid && mid > lip,
    `${centre.toFixed(2)} / ${mid.toFixed(2)} / ${lip.toFixed(3)} at d = 0, 0.5, 1`);
  // THE WHOLE POINT. If the profile still has meaningful value where the
  // geometry stops, the quad's own straight edge is visible and the trail is a
  // hard-edged shape however smooth the spine is.
  check('...and has faded to nothing before the polygon edge',
    lip < centre * 0.05,
    `${(100 * lip / centre).toFixed(1)}% of centre at the lip — no silhouette`);

  // The vertex colour carries brightness only; the shape is the shader's.
  const gcol = chan(1).geometry.attributes.aColor;
  const gedge = chan(1).geometry.attributes.aEdge;
  check('two vertices per rib, parameterised -1..1 across the band',
    gedge.getX(0) === -1 && gedge.getX(1) === 1);

  // The core is genuinely over the bloom line once recombined. Bloom measures
  // LUMINANCE, so the white sum is what clears it — no single channel has to,
  // and blue never will (it weighs 0.07).
  const coreSum = gcol.getY(0) * centre;
  check('the recombined core blows past the bloom threshold',
    coreSum > CONFIG.bloom.threshold,
    `luminance ~${coreSum.toFixed(2)} vs threshold ${CONFIG.bloom.threshold}`);

  // Brightness tracks the ramp, which is what ties the look to the mechanic.
  const brightAt = (ramp) => {
    updateBreachTrail(dt, scene, player, ramp);
    return chan(1).geometry.attributes.aColor.getY(0);
  };
  const dim = brightAt(0);
  const hot = brightAt(CONFIG.airborne.maxRamp);
  check('a long hang burns brighter than a skim', hot > dim,
    `${dim.toFixed(2)} -> ${hot.toFixed(2)}`);

  // SMOOTHNESS, in two separate senses that a single measurement conflates.
  //
  // Built FRESH. The split checks above leave the cloud in whatever state their
  // last run put it in, including stretches where every particle has expired
  // and the spine is degenerate — and an angle measured across a zero-length
  // segment is atan2 of rounding error, which reports as a huge corner in a
  // part of the ribbon that draws nothing at all.
  clearBreachTrail(scene);
  player.aboveSurface = true;
  player.velocity.set(24, 0);
  for (let i = 0; i < 20; i++) {
    player.mesh.position.set(i * 0.4, bounds.surfaceY + 2 + Math.sin(i * 0.3) * 2, 0);
    updateBreachTrail(dt, scene, player, 1);
  }
  {
    const p = chan(1).geometry.attributes.position;
    const lum = chan(1).geometry.attributes.aColor;
    // Each rib is two lip vertices; the SPINE is their midpoint.
    const mid = (i) => [
      (p.getX(i * 2) + p.getX(i * 2 + 1)) / 2,
      (p.getY(i * 2) + p.getY(i * 2 + 1)) / 2,
    ];

    // 1. THE CURVE ITSELF turns gently. A polyline straight through a
    //    blown-apart cloud snaps through large angles; a centripetal
    //    Catmull-Rom through the same particles does not. (Uniform
    //    Catmull-Rom does — it overshoots into cusps on unevenly spaced
    //    points, which measured as a 178° reversal here.)
    //    Measured only where the ribbon is actually LIT and the segment has
    //    real length: a corner in a stretch that draws nothing is not a corner
    //    anybody can see, and an angle taken across a degenerate segment is
    //    atan2 of rounding error.
    let worst = 0;
    let prevA = null;
    for (let i = 1; i < T.samples; i++) {
      const [x0, y0] = mid(i - 1);
      const [x1, y1] = mid(i);
      const dx = x1 - x0;
      const dy = y1 - y0;
      if (Math.hypot(dx, dy) < 1e-3) continue;
      const a = Math.atan2(dy, dx);
      if (prevA !== null && lum.getY(i * 2) > 0.05) {
        let d = Math.abs(a - prevA);
        if (d > Math.PI) d = Math.PI * 2 - d;
        worst = Math.max(worst, d);
      }
      prevA = a;
    }
    check('the drawn curve turns gently rather than snapping',
      worst < 0.35,
      `worst corner ${(worst * 180 / Math.PI).toFixed(1)}° along the lit spine`);

    // 2. THE BAND NEVER TURNS INSIDE OUT. A band of half-width w on a curve of
    //    radius R inverts on the inner side once w > R: the lip crosses the
    //    spine, the quad flips, and additive blending draws the result as a
    //    bright hard wedge. Detected as the two lips swapping sides — the
    //    signed offset from the spine must keep its sign along the whole
    //    ribbon.
    let flips = 0;
    let prevSign = 0;
    for (let i = 0; i < T.samples; i++) {
      const [mx, my] = mid(i);
      const lx = p.getX(i * 2) - mx;
      const ly = p.getY(i * 2) - my;
      if (Math.hypot(lx, ly) < 1e-6) continue;
      // Which side the lip sits on, relative to the local travel direction.
      const [nx, ny] = mid(Math.min(T.samples - 1, i + 1));
      const tx = nx - mx;
      const ty = ny - my;
      if (Math.hypot(tx, ty) < 1e-6) continue;
      const sign = Math.sign(tx * ly - ty * lx);
      if (prevSign !== 0 && sign !== 0 && sign !== prevSign) flips++;
      if (sign !== 0) prevSign = sign;
    }
    check('...and the band never turns inside out', flips === 0,
      `${flips} lip crossings — the fold guard clamps width to the curve's radius`);
  }

  clearBreachTrail(scene);
}

// ---------------------------------------------------------------------------
section('THE CLOUD — the spine is particles, and they outlive the seal');
{
  const T = CONFIG.breachTrail;
  // The scene node is a root holding one subgroup PER PLUME (one per tail fin),
  // and the three channel ribbons live one level down inside each. `chan` walks
  // that for the first plume, which is the only one the fake seal below has.
  const ribbons = () => scene.getObjectByName('breachTrail');
  const plume0 = () => ribbons()?.children?.[0];
  const chan = (i) => plume0()?.children?.[i];
  const visible = () => !!(ribbons()?.visible && plume0()?.visible);
  const maxLife = T.life * (1 + T.lifeVary);

  // Particle positions come from the SIMULATION, not from the drawn geometry.
  // The ribbon is a Catmull-Rom curve resampled far more densely than the
  // particles are, so reading vertex positions would measure the spline's
  // opinion of where the cloud is rather than the cloud's.
  const spine = () => breachTrailNodes();

  // THE ERASE IS OFF for this whole section. It consumes the trail in half a
  // second the moment the seal goes under, which is exactly what the section
  // below it tests — and it would eat every cloud here before the drift had
  // anything to say. Restored at the end.
  const wasErase = CONFIG.breachTrail.erase.enabled;
  CONFIG.breachTrail.erase.enabled = false;

  // The dead-straight line every cloud in this section is laid along, so that
  // anything found off it got there by blowing outward rather than by following
  // the seal.
  const LINE_Y = bounds.surfaceY + 8;

  // Lay a plume down along a dead-straight horizontal line, so anything that
  // ends up off that line got there by blowing outward rather than by following
  // the seal.
  //
  // EVERY check below starts from its own fresh cloud. Chaining them shares one
  // ageing cloud between measurements, and since particles only live a second
  // or two the later checks end up reading an empty sky — which reports as
  // "drag is infinite" and "the cloud never thins", both of which are the test
  // running too long rather than the code being wrong.
  const layCloud = (frames = 40, perFrame = 0.33) => {
    clearBreachTrail(scene);
    player.aboveSurface = true;
    player.velocity.set(perFrame * 60, 0);
    for (let i = 0; i < frames; i++) {
      player.mesh.position.set(i * perFrame, LINE_Y, 0);
      updateBreachTrail(dt, scene, player, 1);
    }
  };
  // ...and then the seal is GONE: parked well under the water, not moving.
  // Everything measured afterwards is the cloud's own doing.
  const sealGone = () => {
    player.aboveSurface = false;
    player.mesh.position.set(0, bounds.surfaceY - 20, 0);
    player.velocity.set(0, 0);
  };

  layCloud(60);
  const born = breachTrailCount();
  check('a run of breach lays down a cloud', born > 20, `${born} particles alive`);

  // How far the cloud has strayed from the line it was born on. Averaged over
  // every particle rather than sampled, because the kick is random per particle
  // and one of them proves nothing.
  const strayFromLine = () => {
    const s = spine();
    if (!s.length) return 0;
    return s.reduce((a, [, y]) => a + Math.abs(y - LINE_Y), 0) / s.length;
  };
  sealGone();
  const before = spine();
  for (let i = 0; i < 12; i++) updateBreachTrail(dt, scene, player, 0);
  const after = spine();
  let moved = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    moved += Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1]);
  }
  check('the cloud keeps moving with the seal gone', moved > 0.5,
    `${moved.toFixed(2)}u of total drift in 12 frames`);
  check('...and is still drawn', visible(),
    'the trail belongs to the air, not to the animal that left it');

  // ...and it is moving OUTWARD, not just along. This is the difference between
  // a plume and a ribbon being dragged about. Measured from a SHORT lay, so the
  // first reading is taken before the cloud has had time to spread on its own.
  layCloud(6);
  const strayAtBirth = strayFromLine();
  sealGone();
  for (let i = 0; i < 45; i++) updateBreachTrail(dt, scene, player, 0);
  const strayLater = strayFromLine();
  check('it blows outward, away from the line it was laid on',
    strayLater > strayAtBirth * 1.5,
    `${strayAtBirth.toFixed(2)}u -> ${strayLater.toFixed(2)}u off the line`);

  // DRAG, MEASURED WITH THE TURBULENCE OFF.
  //
  // Isolating it is the whole point. With the field running, drag does not slow
  // the cloud down at all — the two settle at a terminal speed (accel / drag,
  // about 4.3 u/s at the shipped numbers) that happens to be ABOVE the birth
  // kick, so the particles gently speed up and a naive before/after reading
  // says drag is broken when it is working exactly as intended. What drag is
  // actually responsible for is that the initial rush doesn't coast forever,
  // and that is only visible with nothing else pushing.
  // Read off the particles' own velocities rather than differenced from their
  // positions: particles die, so diffing spine coordinates between two frames
  // compares different particles the moment one in the middle expires, and the
  // nonsense that comes out looks exactly like drag running backwards.
  const runFor = (frames) => {
    for (let i = 0; i < frames; i++) updateBreachTrail(dt, scene, player, 0);
    return breachTrailStats().meanSpeed;
  };
  {
    const wasTurb = T.turbulence;
    CONFIG.breachTrail.turbulence = 0;
    layCloud(10);
    sealGone();
    const early = runFor(6);
    const late = runFor(18);
    CONFIG.breachTrail.turbulence = wasTurb;
    check('drag runs the initial rush down rather than letting it coast',
      late < early * 0.75,
      `mean speed ${early.toFixed(2)} -> ${late.toFixed(2)} u/s with the field off`);
  }
  // ...and with the field back on, the cloud does NOT go still — it keeps
  // churning for as long as the particles live. Both halves matter: drag alone
  // is a puff that stops dead, turbulence alone is a cloud that never settles.
  // Together they reach a terminal speed of roughly accel/drag and mill about
  // at it, which is what a plume in moving air does.
  {
    layCloud(10);
    sealGone();
    const kept = runFor(24);
    check('...but the field keeps the cloud alive rather than letting it settle',
      kept > 0.5, `mean speed ${kept.toFixed(2)} u/s, still churning`);
  }

  // ...AND THEY EVENTUALLY DIE. One at a time, and then completely.
  layCloud(40);
  sealGone();
  const midCount = breachTrailCount();
  for (let i = 0; i < Math.ceil(T.life / dt * 0.6); i++) updateBreachTrail(dt, scene, player, 0);
  const thinned = breachTrailCount();
  check('the cloud thins as particles expire', thinned < midCount,
    `${midCount} -> ${thinned} particles`);
  for (let i = 0; i < Math.ceil(maxLife / dt) + 10; i++) updateBreachTrail(dt, scene, player, 0);
  check('...and is gone once the longest life is up', breachTrailCount() === 0,
    `life ${T.life}s +/- ${Math.round(T.lifeVary * 100)}%`);
  check('...and stops drawing', !visible());

  // THE POPULATION IS BOUNDED by rate x life, which is also what the geometry
  // was built for. A cloud that outgrew it would silently drop its own tail.
  clearBreachTrail(scene);
  player.aboveSurface = true;
  player.velocity.set(30, 0);
  for (let i = 0; i < 60 * 6; i++) {
    player.mesh.position.set(Math.sin(i * 0.05) * 20, LINE_Y, 0);
    updateBreachTrail(dt, scene, player, 1);
  }
  const ceiling = Math.min(T.maxNodes, Math.ceil(T.emitPerSecond * maxLife) + 4);
  check('a long breach never outgrows the geometry',
    breachTrailCount() <= ceiling,
    `${breachTrailCount()} alive, built for ${ceiling}`);

  // THE STRIPE. A second breach on the far side of the arena must not draw a
  // band joining the two clouds. This is the single most visible way the system
  // can break and it lasts one frame, which is why it needs a test and not an
  // eye. The old arc's particles are deliberately still alive — clearing them
  // would erase the first plume in front of the player — so the ribbon has to
  // be blanked at the strand boundary rather than the cloud emptied.
  player.aboveSurface = false;
  player.mesh.position.set(0, bounds.surfaceY - 20, 0);
  updateBreachTrail(dt, scene, player, 0);
  const survivors = breachTrailCount();
  player.aboveSurface = true;
  player.mesh.position.set(-60, LINE_Y, 0);
  player.velocity.set(0, 10);
  for (let i = 0; i < 3; i++) updateBreachTrail(dt, scene, player, 1);
  check('the previous arc is still alive', breachTrailCount() > survivors * 0.5,
    'a second jump must not erase the first plume');
  // Nothing may be DRAWN spanning the gap: every lit vertex belongs to one
  // cloud or the other, never to a band stretching between them.
  {
    const p = chan(1).geometry.attributes.position;
    const c = chan(1).geometry.attributes.aColor;
    // The window is the genuinely EMPTY water between the two clouds: the old
    // arc was laid across x -20..20 and the new one starts at -60, so anything
    // lit between -55 and -25 is a band spanning the gap and nothing else.
    let litBetween = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const lit = c.getY(i) > 0.01;
      if (lit && x > -55 && x < -25) litBetween++;
    }
    check('nothing is drawn spanning the gap between them', litBetween === 0,
      `${litBetween} lit vertices in the empty middle`);
  }

  // THE PAUSE GATE. Drifting and dying belong to the air and must carry on
  // whatever the run is doing; laying down NEW particles belongs to the seal,
  // and a seal frozen mid-arc behind the level-up cards is not moving. Without
  // the gate the whole emission rate is born at one set of coordinates and
  // stacks into a single bright blob that grows for as long as the menu is up.
  clearBreachTrail(scene);
  player.aboveSurface = true;
  player.velocity.set(15, 0);
  for (let i = 0; i < 30; i++) {
    player.mesh.position.set(i * 0.25, LINE_Y, 0);
    updateBreachTrail(dt, scene, player, 1, true);
  }
  {
    const paused = breachTrailCount();
    // Frozen in place, as a menu would leave it, with emission switched off.
    for (let i = 0; i < 40; i++) updateBreachTrail(dt, scene, player, 1, false);
    check('a paused seal lays down nothing', breachTrailCount() <= paused,
      `${paused} -> ${breachTrailCount()} particles`);
    check('...but the cloud it already made keeps drifting',
      breachTrailStats().meanSpeed > 0.1,
      `mean speed ${breachTrailStats().meanSpeed.toFixed(2)} u/s behind the menu`);
  }

  // DYING MID-ARC. updatePlayer stops on death, so `player.aboveSurface` is
  // stuck at whatever it last said — here, true — while the death dive carries
  // the body down through the water. The trail reads the POSITION for exactly
  // this case; reading the flag would go on emitting from a sinking corpse and
  // leave a plume that never ends.
  player.aboveSurface = true; // the stale flag a death mid-breach leaves behind
  player.mesh.position.set(-30, bounds.surfaceY - 6, 0);
  player.velocity.set(0, -8);
  for (let i = 0; i < Math.ceil(maxLife / dt) + 10; i++) {
    updateBreachTrail(dt, scene, player, 1);
  }
  check('a death mid-breach still lets the cloud die out', breachTrailCount() === 0,
    'position, not the stale aboveSurface flag');

  CONFIG.breachTrail.erase.enabled = wasErase;
  clearBreachTrail(scene);
  check('cleared on demand', !scene.getObjectByName('breachTrail'));
}

// ---------------------------------------------------------------------------
section('THE TAIL FINS — two plumes, off the flippers, not out of the ribcage');
{
  clearBreachTrail(scene);
  // A stand-in rig carrying the two anchors systems/aimRig.js publishes. The
  // real seal's are world-space Vector3s refreshed every frame off the posed
  // hind-flipper bones; these are the same shape, held still.
  const finL = new THREE.Vector3(-2, bounds.surfaceY + 9, 0);
  const finR = new THREE.Vector3(-2, bounds.surfaceY + 7, 0);
  const rigged = {
    mesh: { position: new THREE.Vector3(0, bounds.surfaceY + 8, 0) },
    velocity: new THREE.Vector2(14, 0),
    aimRig: { anchors: { finL, finR } },
  };

  for (let i = 0; i < 40; i++) {
    const x = i * 0.24;
    rigged.mesh.position.set(x, bounds.surfaceY + 8, 0);
    // The fins trail the body and sit either side of it, as a rig would put them.
    finL.set(x - 2, bounds.surfaceY + 9, 0);
    finR.set(x - 2, bounds.surfaceY + 7, 0);
    updateBreachTrail(dt, scene, rigged, 1, true);
  }

  const root = scene.getObjectByName('breachTrail');
  check('one plume per fin', root?.children.length === 2, `${root?.children.length} plumes`);
  check('...and both are drawn', root.children.every((g) => g.visible));

  // EVERY particle must be near a FIN, and none near the body origin. This is
  // the whole point of the change: the trail used to be born inside the seal's
  // ribcage, which is both wrong and the least interesting place on the animal.
  const pts = breachTrailNodes();
  const nearBody = pts.filter(([, y]) => Math.abs(y - (bounds.surfaceY + 8)) < 0.4).length;
  const nearFins = pts.filter(([, y]) =>
    Math.abs(y - (bounds.surfaceY + 9)) < 1.2 || Math.abs(y - (bounds.surfaceY + 7)) < 1.2).length;
  check('particles are born at the fins', nearFins > pts.length * 0.8,
    `${nearFins} of ${pts.length} within reach of a flipper tip`);
  check('...and not out of the body centre', nearBody < pts.length * 0.15,
    `${nearBody} of ${pts.length} on the body's own line`);

  // The two plumes must stay SEPARATE. One list fed from two points would put
  // consecutive particles on opposite flippers, and the ribbon through them
  // would zigzag between the fins instead of being two trails.
  const [a, b] = root.children;
  const ay = a.children[1].geometry.attributes.position.getY(1);
  const by = b.children[1].geometry.attributes.position.getY(1);
  check('the two ribbons are drawn apart', Math.abs(ay - by) > 1,
    `${Math.abs(ay - by).toFixed(2)}u between the two heads`);

  clearBreachTrail(scene);
}

// ---------------------------------------------------------------------------
section('THE ERASE — re-entry consumes the trail rather than letting it fade');
{
  const T = CONFIG.breachTrail;
  const lay = (frames = 50) => {
    clearBreachTrail(scene);
    player.aboveSurface = true;
    player.velocity.set(18, 0);
    for (let i = 0; i < frames; i++) {
      player.mesh.position.set(i * 0.3, bounds.surfaceY + 8, 0);
      updateBreachTrail(dt, scene, player, 1, true);
    }
    return breachTrailCount();
  };
  // Going UNDER is what seals it — the position, as everywhere else here.
  const sink = () => {
    player.aboveSurface = false;
    player.mesh.position.set(20, bounds.surfaceY - 3, 0);
    player.velocity.set(0, -10);
  };
  const runFor = (secs) => {
    for (let i = 0; i < Math.ceil(secs / dt); i++) updateBreachTrail(dt, scene, player, 0, false);
  };

  // WITH the erase: gone inside its own window, well before the particles would
  // have died of old age.
  const laid = lay();
  sink();
  runFor(T.erase.time * 1.2);
  const after = breachTrailCount();
  check('the trail is consumed within the erase window', after === 0,
    `${laid} particles gone in ${T.erase.time}s`);

  // WITHOUT it, the same trail is still there at the same moment — which is
  // what proves the wipe is doing the work rather than the lifetimes.
  {
    T.erase.enabled = false;
    lay();
    sink();
    runFor(T.erase.time * 1.2);
    const survivors = breachTrailCount();
    T.erase.enabled = true;
    check('...and it is the wipe doing it, not old age', survivors > 0,
      `${survivors} still alive at the same moment with the erase off`);
  }

  // DIRECTION. 'tail' eats the oldest end first, so the survivors are the
  // NEWEST particles — the ones nearest where the seal went in. 'head' is the
  // opposite. The seal travels +x, so the newest particles have the largest x.
  const midpointAfterWipe = (from) => {
    const was = T.erase.from;
    T.erase.from = from;
    lay();
    sink();
    runFor(T.erase.time * 0.5);
    const pts = breachTrailNodes();
    T.erase.from = was;
    if (!pts.length) return NaN;
    return pts.reduce((acc, [x]) => acc + x, 0) / pts.length;
  };
  const fromTail = midpointAfterWipe('tail');
  const fromHead = midpointAfterWipe('head');
  check('eating from the tail leaves the newest end', fromTail > fromHead,
    `mean x ${fromTail.toFixed(1)} (tail) vs ${fromHead.toFixed(1)} (head)`);

  // A FRESH BREACH CANCELS THE WIPE. Without this a second jump taken while the
  // first trail is still being eaten inherits its progress, and the new trail is
  // consumed the instant it is drawn.
  lay();
  sink();
  runFor(T.erase.time * 0.4);
  player.aboveSurface = true;
  player.velocity.set(18, 0);
  for (let i = 0; i < 40; i++) {
    player.mesh.position.set(60 + i * 0.3, bounds.surfaceY + 8, 0);
    updateBreachTrail(dt, scene, player, 1, true);
  }
  check('a new breach cancels the previous wipe', breachTrailCount() > 20,
    `${breachTrailCount()} particles on the new arc`);

  clearBreachTrail(scene);
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
