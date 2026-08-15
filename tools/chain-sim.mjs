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
//   The supply rate is taken from playtest/runs.jsonl — one kill drops one orb,
//   so kills/sec IS chum/sec, and real runs sit at a median of about 4.3.
//   Inventing that number would have made the whole exercise circular.
//
//   The brain is a deliberately COMPETENT-BUT-NOT-PERFECT player: it swims at
//   the nearest chum, winds up when it has eaten enough to arm a link, and
//   releases toward the densest water. It does not have frame-perfect timing
//   and it cannot see the window's clock. If the loop only works for a player
//   who can, that is the finding.
//
// The point is the MISS BREAKDOWN, not the link count. A link rate on its own
// says the chain is rare; the reasons say which of the three gates is shutting.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { player, initPlayer, resetPlayer, updatePlayer } from '../path/src/entities/player.js';
import {
  strikeState, resetStrike, updateCharge, tryStrike, updateStrike,
  feedChum, consumeStrikeLink, linkPips, pipCount, liveChain,
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
 * @param chumPerSec how fast kills are dropping food — from the real logs
 * @param seed       fixed per scenario so runs are comparable
 * @param seconds    simulated length
 */
export function simulate(chumPerSec, seed, seconds = 60) {
  const rand = rng(seed);
  resetPlayer(scene);
  resetStrike();
  resetPickups(scene);

  const stats = player.stats;
  const input = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) };
  const stat = {
    strikes: 0, links: 0, maxChain: 0,
    missNoFood: 0, missNoWindow: 0, missBoth: 0,
    eaten: 0, spawned: 0, holdFrames: 0,
  };

  let spawnAcc = 0;
  let holding = false;

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
    const armed = strikeState.pipsSinceStrike >= linkPips(stats);
    if (!holding && armed && strikeState.charge > CONFIG.strike.charge.minFire) holding = true;
    if (holding) stat.holdFrames++;

    player.chumSealed = holding && CONFIG.strike.charge.gulp?.blockEating !== false;
    updateCharge(DT, holding, stats);

    // Release as soon as it would fire. Waiting for a fatter charge is a real
    // strategy but it spends window, and the brain is modelling a player who
    // wants the link.
    if (holding && strikeState.pending >= CONFIG.strike.charge.minFire) {
      const dir = { x: input.move.x || 1, y: input.move.y };
      const L = Math.hypot(dir.x, dir.y) || 1;
      if (tryStrike({ x: dir.x / L, y: dir.y / L }, stats)) {
        const rel = consumeStrikeLink();
        stat.strikes++;
        if (rel.chain > 0) {
          stat.links++;
          if (rel.chain > stat.maxChain) stat.maxChain = rel.chain;
        } else if (!rel.hadFood && !rel.hadWindow) stat.missBoth++;
        else if (!rel.hadFood) stat.missNoFood++;
        else stat.missNoWindow++;

        player.velocity.set(strikeState.dashDir.x * stats.strikeDashSpeed,
          strikeState.dashDir.y * stats.strikeDashSpeed);
        player.dashTimer = strikeState.dashDuration;
        // The release gulp, exactly as main.js fires it.
        gulpPickups(scene, player, (v, x, y) => { if (feedChum(stats)) {} stat.eaten++; });
      }
      holding = false;
      player.chumSealed = false;
    }

    updateStrike(DT, scene, player.mesh.position, stats, [], {});
    updatePlayer(DT, input);
    updatePickups(DT, scene, player, () => { feedChum(stats); stat.eaten++; },
      () => {}, () => {}, () => {});
  }
  return stat;
}

// ---------------------------------------------------------------------------

export const SCENARIOS = [
  ['lean water   (p10)', 1.9],
  ['typical      (median)', 4.3],
  ['busy         (p90)', 9.4],
];
export const SEEDS = [1, 7, 13, 29, 101];

if (!process.env.SIM_QUIET) console.log('\nFOOD CHAIN — simulated against chum rates measured from playtest/runs.jsonl');
console.log(`(real player, real strike, real magnet, real pickups; ${SEEDS.length} seeds x 60s each)\n`);
console.log(`  linkBarFraction ${CONFIG.strike.linkBarFraction}  ->  a link costs ${linkPips(null)} of ${pipCount(null)} pips`);
console.log(`  chainWindow ${CONFIG.strike.chainWindow}s, windowFromDashEnd ${CONFIG.strike.windowFromDashEnd}`);
console.log(`  magnet reach: idle ${(CONFIG.player.pickupRadius).toFixed(1)}  striking ${(CONFIG.player.pickupRadius * CONFIG.pickups.magnet.striking.radiusMul).toFixed(1)}\n`);

console.log('  water                strikes/min  links/min   hit%   deepest   miss: food  window  both');
let worstHit = 1;
for (const [label, rate] of SCENARIOS) {
  const agg = { strikes: 0, links: 0, maxChain: 0, missNoFood: 0, missNoWindow: 0, missBoth: 0, eaten: 0 };
  for (const seed of SEEDS) {
    const r = simulate(rate, seed, 60);
    agg.strikes += r.strikes; agg.links += r.links;
    agg.missNoFood += r.missNoFood; agg.missNoWindow += r.missNoWindow; agg.missBoth += r.missBoth;
    agg.eaten += r.eaten;
    if (r.maxChain > agg.maxChain) agg.maxChain = r.maxChain;
  }
  const mins = SEEDS.length;             // 60s each
  const hit = agg.strikes ? agg.links / agg.strikes : 0;
  if (hit < worstHit) worstHit = hit;
  console.log([
    `  ${label.padEnd(20)}`,
    (agg.strikes / mins).toFixed(1).padStart(10),
    (agg.links / mins).toFixed(1).padStart(11),
    `${Math.round(hit * 100)}%`.padStart(7),
    `x${agg.maxChain}`.padStart(10),
    String(agg.missNoFood).padStart(13),
    String(agg.missNoWindow).padStart(8),
    String(agg.missBoth).padStart(6),
  ].join(''));
}
console.log('');
