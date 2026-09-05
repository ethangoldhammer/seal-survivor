#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:pickupblast
//
// A PICKUP STRUCK BY A DASH GOES OFF — CONFIG.strike.pickupBlast, resolved by
// pickupStruck() in main.js through pickupBlast() in systems/strike.js. This
// measures the arithmetic, which is the half that can silently revert: the
// wiring in main.js is five one-line calls beside handlers that already fire,
// and the feedback audit in test:upgrades catches a missing event entry.
//
// Worth failing over:
//
//   GATE      nothing goes off without a dash in flight — a bubble taken at
//             cruising speed is a bubble — and nothing goes off for a kind
//             that is not on the list, or with the switch off.
//   POWER     a full charge hits harder AND reaches further than a flick.
//             Both axes, off the one function the game calls.
//   HIGH      it is the strike's heaviest hit: a flick alone out-damages the
//             release burst, and a full charge clears a shark's worth of
//             health — which is the reason to aim a dash at a pickup at all.
//   SPLASH    Splash Zone widens the radius and leaves the damage alone.
//   TIMING    it is NOT gated on the sweet spot. Aiming is the skill here.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../path/src/config.js';
import { baseStats } from '../path/src/stats.js';
import { strikeState, resetStrike, strikeBurst, pickupBlast } from '../path/src/systems/strike.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);

const stats = baseStats();
const p = CONFIG.strike.pickupBlast;

function armDash(power = 1, sweet = true) {
  resetStrike();
  strikeState.active = true;
  strikeState.power = power;
  strikeState.sweetStrike = sweet;
  strikeState.dashTimeLeft = 1;
  strikeState.dashDuration = 1;
  strikeState.dashDir = { x: 1, y: 0 };
}

section('GATE — only a dash in flight sets one off');
{
  resetStrike();
  const idle = pickupBlast(stats, 1);
  check('no dash, no blast', idle.damage === 0 && idle.radius === 0 && idle.knock === 0);
  armDash(1);
  const off = pickupBlast(stats, 0);
  check('a kind at 0 is collected, not detonated', off.damage === 0 && off.radius === 0);
  const missing = pickupBlast(stats, p.kinds.notAKind ?? 0);
  check('...and so is a kind missing from the list', missing.damage === 0);
  check('the loose chum orb is deliberately not on the list', !(p.kinds.chum > 0));
  for (const k of ['strikeOrb', 'bubbleOrb', 'rapidFireOrb', 'levelOrb', 'chumChunk']) {
    check(`${k} is on the list`, p.kinds[k] > 0);
  }
  p.enabled = false;
  const sw = pickupBlast(stats, 1);
  check('the switch reaches the arithmetic', sw.damage === 0 && sw.radius === 0);
  p.enabled = true;
}

section('POWER — a bigger strike is a bigger bomb');
armDash(1);
const full = pickupBlast(stats, 1);
armDash(0.35);
const flick = pickupBlast(stats, 1);
check('a flick still goes off', flick.damage > 0 && flick.radius > 0);
check('a full charge hits harder', full.damage > flick.damage * 1.5,
  `${full.damage.toFixed(1)} vs ${flick.damage.toFixed(1)}`);
check('...reaches further', full.radius > flick.radius * 1.3,
  `${full.radius.toFixed(2)} vs ${flick.radius.toFixed(2)} units`);
check('...and throws harder', full.knock > flick.knock,
  `${full.knock.toFixed(2)} vs ${flick.knock.toFixed(2)}`);

section('HIGH — it is the heaviest thing a strike does');
{
  armDash(1);
  const release = strikeBurst(stats);
  armDash(0.35);
  const flickRelease = strikeBurst(stats);
  check('a flick into a pickup out-damages a flick release',
    flick.damage > flickRelease.damage * 3,
    `${flick.damage.toFixed(1)} vs ${flickRelease.damage.toFixed(1)}`);
  check('...and out-reaches it', flick.radius > flickRelease.radius,
    `${flick.radius.toFixed(2)} vs ${flickRelease.radius.toFixed(2)}`);
  const shark = CONFIG.enemies.shark;
  check('a full charge clears a shark', full.damage >= shark.hp,
    `${full.damage.toFixed(1)} vs ${shark.hp} hp`);
  check('...and is bigger than the full release in every way',
    full.damage > release.damage && full.radius > release.radius,
    `${full.damage.toFixed(1)}/${full.radius.toFixed(2)} vs ${release.damage.toFixed(1)}/${release.radius.toFixed(2)}`);
  // Still a blast around the orb, not the corridor going off.
  const dashReach = CONFIG.strike.dashSpeed * CONFIG.strike.dashDuration
    * CONFIG.strike.charge.reachMulMax;
  check('it is a ring around the pickup, not the whole dash corridor',
    full.radius < dashReach * 0.5,
    `${full.radius.toFixed(2)} vs a ${dashReach.toFixed(1)}-unit dash`);
}

section('SPLASH — Splash Zone widens, never inflates');
{
  armDash(1);
  const wide = pickupBlast({ ...stats, aoeMul: 1.5 }, 1);
  check('Splash Zone widens the blast', wide.radius > full.radius * 1.4,
    `${wide.radius.toFixed(2)} vs ${full.radius.toFixed(2)}`);
  check('...and leaves its damage alone', wide.damage === full.damage);
  const bite = pickupBlast({ ...stats, strikeDamage: stats.strikeDamage * 2 }, 1);
  check('the strike cards grow it', bite.damage > full.damage * 1.9,
    `${bite.damage.toFixed(1)} vs ${full.damage.toFixed(1)}`);
}

section('TIMING — the sweet spot is not the gate');
{
  armDash(1, false);
  const late = pickupBlast(stats, 1);
  check('an off-beat dash still detonates a pickup', late.damage === full.damage && late.radius === full.radius);
  check('...while the release burst it belongs to does not', strikeBurst(stats).damage === 0);
}

section('LOOK — its own burst, in the colour of what went off');
{
  // THE AUTHORED DEFAULT, read off config.js itself rather than off CONFIG:
  // the feedback event is tuned in the F panel and imported-tuning.json wins
  // over the code default the moment a slider moves, so a check through CONFIG
  // would be a check on whatever was last saved, not on what the code ships.
  const src = readFileSync(new URL('../path/src/config.js', import.meta.url), 'utf8');
  const def = src.match(/\n\s+pickupBlast: \{ emit: '(\w+)', goo: '(\w+)'/);
  check('the event has its own emitter by default', def?.[1] === 'pickupBlast' && !!CONFIG.emitters.pickupBlast);
  check('...bigger than the release burst\'s', CONFIG.emitters.pickupBlast.count > CONFIG.emitters.explosion.count
    && CONFIG.emitters.pickupBlast.size[1] > CONFIG.emitters.explosion.size[1]);
  check('...and leaves the pickup splat behind it by default', def?.[2] === 'pickupGoo');
  check('the fx block scales up with power', p.fx.spray.sizeMul[1] > p.fx.spray.sizeMul[0]
    && p.fx.goo.sizeMul[1] > p.fx.goo.sizeMul[0]);
  // Every call site hands over a colour — the tint IS the identity of the
  // blast, and a kind that forgot it would go off white.
  const main = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  const calls = [...main.matchAll(/pickupStruck\(x, y, '(\w+)'(,\s*[^)]+)?\)/g)];
  check('every pickup kind is wired', new Set(calls.map((m) => m[1])).size === Object.keys(p.kinds).length,
    calls.map((m) => m[1]).join(', '));
  for (const m of calls) check(`${m[1]} passes its colour`, !!m[2]);
  check('the blast flash is sized to the damage ring', main.includes('radius: blast.radius * (fx.flash?.radiusMul ?? 1)'));
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
