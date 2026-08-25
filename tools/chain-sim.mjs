#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run sim:chain
//
// DOES THE FOOD CHAIN ACTUALLY TURN OVER? Measured, by playing the loop.
//
// This exists because "the chain isn't popping" could not be answered from the
// run logs — nothing recorded it — and because reasoning about it from the
// constants kept producing confident wrong answers. The mechanic has four
// interacting clocks (the wind-up, the dash, the window, the magnet's reach at
// speed) and the only honest way to know whether they compose is to run them.
//
// WHAT IS REAL HERE, and it is nearly everything:
//
//   the player      entities/player.js — the actual updatePlayer, so the dash
//                   throttle, the steering multiplier and the break-out are
//                   the shipped ones, not a model of them.
//   the strike      systems/strike.js — updateCharge, tryStrike, updateStrike.
//   the magnet      systems/chumMagnet.js through the real updatePickups, so
//                   the corridor and the per-state reach are exercised.
//   the chum        entities/pickups.js, real orbs with real collection.
//
// WHAT IS MODELLED: the PLAYER'S BRAIN and the chum supply.
//
//   THE SUPPLY IS WHAT THE SEAL EATS, NOT WHAT DIES. This harness used to take
//   kills/sec from playtest/runs.jsonl and feed it in as chum/sec on the
//   reasoning that one kill drops one orb — a median of 4.3/s. The logs record
//   BOTH numbers, and they are nothing like each other: across 124 runs the
//   seal kills 2.4-6.6 a second and SWALLOWS 0.17-1.6. Most of what dies drops
//   where the mussels killed it and is never reached.
//
//   Feeding the kill rate in overstated the supply by 3-25x, which is why this
//   harness reported a 92% link rate for a mechanic that scores 0-18% in the
//   logs it was calibrated against. `SCENARIOS` below is now the measured
//   EATEN rate, per 30s bucket of real play.
//
//   The brain is a deliberately COMPETENT-BUT-NOT-PERFECT player: it swims at
//   the nearest chum, winds up when it has eaten enough to arm a link, and
//   releases toward the densest water. It does not have frame-perfect timing
//   and it cannot see the window's clock. If the loop only works for a player
//   who can, that is the finding.
//
//   IT ALSO HAS A CHARGE DISCIPLINE, because how long you hold is the single
//   biggest thing a player varies and the wind-up SEALS THE MOUTH. A hold is
//   time the seal is structurally forbidden from eating, and eating is the only
//   thing that keeps the window open — so the two ends of the same rhythm pull
//   against each other, and the harness has to be able to see that. `hold` is
//   the banked power the brain waits for: 'min' is a twitch release at minFire,
//   'full' is a player buying the reach the charge is there to sell.
//
// The point is the MISS BREAKDOWN, not the link count. A link rate on its own
// says the chain is rare; the reasons say which of the three gates is shutting.
// `lapsed in hand` is the fourth number and the one that matters most: windows
// that died DURING a wind-up, i.e. chains lost to the mouth being shut.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { player, initPlayer, resetPlayer, updatePlayer } from '../path/src/entities/player.js';
import {
  strikeState, resetStrike, updateCharge, tryStrike, updateStrike, strikeLoaded,
  feedChum, consumeStrikeLink, consumeChainLink, linkPips, pipCount, liveChain,
} from '../path/src/systems/strike.js';
import {
  updatePickups, resetPickups, spawnXpOrb, pickups, gulpPickups,
} from '../path/src/entities/pickups.js';

const DT = 1 / 60;

// ONE scene and ONE initPlayer for the whole process: initPlayer builds the
// seal's visual, and resetPlayer assumes it already exists. Rebuilding it per
// scenario would also re-run the model load for no benefit.
const scene = new THREE.Scene();
initPlayer(scene);

// Seeded, because a Monte Carlo result that moves every run cannot be compared
// against the next tuning change — see the note on seeded spawn harnesses.
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/**
 * One run of the loop.
 *
 * @param chumPerSec how fast the seal is SWALLOWING food — from the real logs
 * @param seed       fixed per scenario so runs are comparable
 * @param seconds    simulated length
 * @param hold       charge discipline: 'min' releases the instant it can fire,
 *                   'full' banks the whole bar first. See the header — this is
 *                   the dial that decides how long the mouth stays shut.
 * @param cadence    seconds the brain waits between strikes, floor. 0 is "as
 *                   often as the food allows", which is 16-31 strikes a minute
 *                   and NOT what anybody plays like: the logs have real players
 *                   at 0.7-3.7 a minute. The chain is described as something a
 *                   striking RHYTHM sustains, so the harness has to be able to
 *                   ask what rhythm — a window that only works at 24 strikes a
 *                   minute is a window that works for nobody.
 */
export function simulate(chumPerSec, seed, seconds = 60, hold = 'min', cadence = 0) {
  const rand = rng(seed);
  resetPlayer(scene);
  resetStrike();
  resetPickups(scene);

  const stats = player.stats;
  const input = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) };
  const stat = {
    strikes: 0, armed: 0, links: 0, maxChain: 0,
    missOffBeat: 0, missNoFood: 0, missNoWindow: 0, missBoth: 0,
    eaten: 0, spawned: 0, holdFrames: 0, frames: 0,
    // Windows that ran out, split by what the player was doing when they did.
    // `lapsedHeld` is a chain lost while the mouth was shut by a wind-up — the
    // player was mid-rhythm and could not have eaten to save it.
    lapsedHeld: 0, lapsedFree: 0, windowFrames: 0,
  };

  // ONE MOUTHFUL, BOOKED THE WAY main.js BOOKS IT: into the meter, then the
  // FOOD CHAIN link it may have scored. Both call sites route through here so a
  // gulped orb and a swum-over one cannot be worth different amounts — exactly
  // the drift a simulation is supposed to be immune to.
  const eat = () => {
    feedChum(stats);
    stat.eaten++;
    const chain = consumeChainLink();
    if (chain) {
      stat.links++;
      if (chain > stat.maxChain) stat.maxChain = chain;
    }
  };

  let spawnAcc = 0;
  let holding = false;
  let sinceStrike = 1e9; // the first strike of a run waits on nothing

  for (let f = 0; f < seconds / DT; f++) {
    // --- the water fills with food, where the fighting is -------------------
    // Clustered near the seal rather than uniform across the arena: kills
    // happen where the player is, and scattering the supply over 80x52 units
    // would be measuring a walk to the food rather than the loop.
    spawnAcc += chumPerSec * DT;
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      const a = rand() * Math.PI * 2;
      const d = 4 + rand() * 22;
      spawnXpOrb(scene, new THREE.Vector3(
        player.mesh.position.x + Math.cos(a) * d,
        Math.max(-20, Math.min(-2, player.mesh.position.y + Math.sin(a) * d)),
        0,
      ), 2, 0.4);
      stat.spawned++;
    }

    // --- the brain ----------------------------------------------------------
    // Steer at the nearest orb. That is what a player does and it is also what
    // makes the magnet's reach matter, which is half of what is being measured.
    let best = null, bestD = 1e9;
    for (const p of pickups) {
      const dx = p.mesh.position.x - player.mesh.position.x;
      const dy = p.mesh.position.y - player.mesh.position.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) {
      const dx = best.mesh.position.x - player.mesh.position.x;
      const dy = best.mesh.position.y - player.mesh.position.y;
      const L = Math.hypot(dx, dy) || 1;
      input.move.set(dx / L, dy / L);
      input.aim.set(dx / L, dy / L);
    } else {
      input.move.set(0, 0);
    }

    // Wind up once enough has been eaten to arm a link — the whole point of
    // the rework is that this is the readable cue, so the brain uses it.
    // Gated behind the rhythm the scenario is testing: a brain that strikes the
    // instant it can is measuring the ceiling, not a player.
    sinceStrike += DT;
    // WHEN THIS BRAIN DECIDES TO WIND UP. It used to also wait for
    // `linkPips` mouthfuls, from a model where that was the price of a link;
    // the price is one chum now, so that clause was trivially true and the
    // brain struck on every cooldown. What is left is the real constraint —
    // enough fuel to fire, and whatever rhythm the scenario is testing.
    if (!holding && sinceStrike >= cadence
      && strikeState.charge > CONFIG.strike.charge.minFire) holding = true;
    if (holding) stat.holdFrames++;

    player.chumSealed = holding && CONFIG.strike.charge.gulp?.blockEating !== false;
    updateCharge(DT, holding, stats);

    // How fat a charge this player buys. 'min' is the twitch release — the
    // cheapest possible link and the kindest case for the window. 'full' waits
    // for the bar, which is what the reach and damage multipliers are there to
    // sell and what most of a real hold looks like; it is also up to a second
    // with the mouth shut, which the window has to survive.
    const canFire = strikeState.pending >= CONFIG.strike.charge.minFire;
    // 'full' holds until the tank is dry or the bank is capped — the bar
    // running dry is what ends a wind-up in play, and without that clause a
    // 'full' brain on a part-full bar would hold the button forever.
    // strikeLoaded() IS "the tank is dry or the bank is capped, with enough to
    // fire" — the same test main.js puts the STRIKE NOW! prompt on and the same
    // one tryStrike times the sweet spot against. It used to be spelled out
    // here, which made this brain a fourth copy of a rule that now has to be
    // one: a sim that releases a frame away from where the game rewards it
    // measures the wrong mechanic and reports a link rate nobody can reproduce.
    const ready = hold === 'full' ? strikeLoaded() : canFire;
    if (holding && ready) {
      const dir = { x: input.move.x || 1, y: input.move.y };
      const L = Math.hypot(dir.x, dir.y) || 1;
      if (tryStrike({ x: dir.x / L, y: dir.y / L }, stats)) {
        const rel = consumeStrikeLink();
        stat.strikes++;
        sinceStrike = 0;
        if (false) {
        } else if (!rel.sweet) stat.missOffBeat++;
        else stat.armed++;

        player.velocity.set(strikeState.dashDir.x * stats.strikeDashSpeed,
          strikeState.dashDir.y * stats.strikeDashSpeed);
        player.dashTimer = strikeState.dashDuration;
        // The release gulp, exactly as main.js fires it.
        gulpPickups(scene, player, () => eat());
      }
      holding = false;
      player.chumSealed = false;
    }

    // Sampled either side of updateStrike, which is the only thing that runs
    // the window's clock down — a lapse is invisible after the fact because
    // both counters are cleared with it.
    const windowBefore = strikeState.chainTimer;
    updateStrike(DT, scene, player.mesh.position, stats, [], {});
    if (windowBefore > 0) {
      stat.windowFrames++;
      if (strikeState.chainTimer <= 0) {
        if (holding) stat.lapsedHeld++; else stat.lapsedFree++;
      }
    }
    stat.frames++;
    updatePlayer(DT, input);
    updatePickups(DT, scene, player, () => eat(),
      () => {}, () => {}, () => {});
  }
  return stat;
}

// ---------------------------------------------------------------------------

// MEASURED, from the chumEaten counter in playtest/runs.jsonl, aggregated over
// 124 runs by 30-second bucket. Not the kill rate — see the header for why
// that distinction is the whole reason this table changed.
//
// The rate CLIMBS through a run (the seal gets faster, the magnet gets wider,
// the water gets busier), so the opening is the lean case and a good late
// stretch is the rich one. "wave 10ish", where the chain is reported to fall
// apart, is the 240-300s band: 1.0-1.6/s.
export const SCENARIOS = [
  ['opening      (0-60s)', 0.2],
  ['building     (90-150s)', 0.9],
  ['wave 10ish   (180-300s)', 1.3],
  ['best seen    (p90 bucket)', 2.4],
];
export const SEEDS = [1, 7, 13, 29, 101];
export const HOLDS = ['min', 'full'];

/**
 * Aggregate one scenario over every seed. Split out so a tuning sweep can call
 * it directly — importing this file used to run the whole report as a side
 * effect, which made "try it at a different chainWindow" a copy of the file.
 */
export function measure(rate, hold, seconds = 60, cadence = 0) {
  const agg = { strikes: 0, armed: 0, links: 0, maxChain: 0,
    missOffBeat: 0, missNoFood: 0, missNoWindow: 0, missBoth: 0,
    eaten: 0, lapsedHeld: 0, lapsedFree: 0 };
  for (const seed of SEEDS) {
    const r = simulate(rate, seed, seconds, hold, cadence);
    agg.strikes += r.strikes; agg.armed += r.armed; agg.links += r.links;
    agg.missOffBeat += r.missOffBeat;
    agg.missNoFood += r.missNoFood; agg.missNoWindow += r.missNoWindow; agg.missBoth += r.missBoth;
    agg.eaten += r.eaten; agg.lapsedHeld += r.lapsedHeld; agg.lapsedFree += r.lapsedFree;
    if (r.maxChain > agg.maxChain) agg.maxChain = r.maxChain;
  }
  agg.minutes = SEEDS.length * (seconds / 60);
  agg.hit = agg.strikes ? agg.armed / agg.strikes : 0;
  return agg;
}

export function report() {
console.log('\nFOOD CHAIN — simulated against the chum the seal actually SWALLOWS in real runs');
console.log(`(real player, real strike, real magnet, real pickups; ${SEEDS.length} seeds x 60s each)\n`);
console.log(`  a sweet release ARMS a chain; links are bought with the food inside it`
  + ` (${linkPips(null)} of ${pipCount(null)} pips for the first, +${CONFIG.strike.linkPipsPerLink} a link after)`);
console.log(`  chainWindow ${CONFIG.strike.chainWindow}s, windowFromDashEnd ${CONFIG.strike.windowFromDashEnd}`);
console.log(`  magnet reach: idle ${(CONFIG.player.pickupRadius).toFixed(1)}  striking ${(CONFIG.player.pickupRadius * CONFIG.pickups.magnet.striking.radiusMul).toFixed(1)}\n`);

for (const hold of HOLDS) {
  console.log(hold === 'min'
    ? '  RELEASING THE INSTANT IT FIRES — the cheapest link, the kindest case for the window'
    : '\n  CHARGING FULLY — what the reach and damage multipliers are selling, mouth shut for up to a second');
  console.log('  water                     strikes/min  links/min  on beat%  deepest   off beat   lapsed in hand');
  for (const [label, rate] of SCENARIOS) {
    const agg = measure(rate, hold);
    const lapses = agg.lapsedHeld + agg.lapsedFree;
    console.log([
      `  ${label.padEnd(25)}`,
      (agg.strikes / agg.minutes).toFixed(1).padStart(10),
      (agg.links / agg.minutes).toFixed(1).padStart(11),
      `${agg.strikes ? Math.round(100 * agg.armed / agg.strikes) : 0}%`.padStart(9),
      `x${agg.maxChain}`.padStart(10),
      String(agg.missOffBeat).padStart(11),
      `${agg.lapsedHeld}/${lapses}`.padStart(17),
    ].join(''));
  }
}

// --- WHAT RHYTHM DOES IT TAKE ----------------------------------------------
//
// The tables above let the brain strike the instant it can, which is 13-20
// times a minute. Real players are at 0.7-3.7. So the number those tables
// report is a CEILING, and a mechanic that only works at the ceiling works for
// nobody — this is the table that says whether an ordinary rhythm keeps a
// chain, and it is the one that condemned the 1.1s window.
console.log('\n  KEEPING ONE GOING — hit rate by how often the player strikes, at the "wave 10ish" rate');
const CADENCES = [1.5, 3, 6, 12];
console.log('  strike every        ' + CADENCES.map((c) => `${c}s`.padStart(10)).join(''));
const chainRate = SCENARIOS.find(([l]) => l.startsWith('wave 10ish'))[1];
console.log('  hit%, deepest       ' + CADENCES.map((c) => {
  const a = measure(chainRate, 'full', 90, c);
  return `${Math.round(a.hit * 100)}% x${a.maxChain}`.padStart(10);
}).join(''));
console.log('');
}

// Importable: a sweep wants `measure` without the report firing on import.
if (!process.env.SIM_IMPORT) report();
