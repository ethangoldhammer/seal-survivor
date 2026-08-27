#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:xp
//
// THE LEVELLING ECONOMY. Two curves race each other for a whole run: what the
// water pays out, and what the next level costs. Neither one is legible on its
// own — CONFIG.xp is a handful of multipliers, and the income side is the
// spawner, the wave clock, the roster's minDifficulty gates, the tier table and
// the early holdback all multiplied together. The only way to know whether
// level 12 arrives in ninety seconds or in six minutes is to run both.
//
// So this drives the REAL spawner for fifteen simulated minutes, drops a REAL
// orb for every kill (so tier scaling and CONFIG.xp.dropRamp are the shipped
// ones, not a copy of them), and spends the proceeds against the REAL
// xpForNextLevel. What it prints is a level ladder with wall-clock times on it.
//
// THE PLAYER MODEL, and its two knobs, because everything here is downstream
// of them:
//
//   hunt   seconds a creature survives, as a hazard rate — every live creature
//          has a dt/hunt chance of dying each frame. This is "how fast the seal
//          clears", and it also sets the standing population, exactly as it
//          does in a real run.
//   clear  the share of dropped chum that is actually eaten. Orbs expire on the
//          seabed and a seal cannot be everywhere; at 1.0 the seal eats
//          literally everything it kills, which nobody does.
//
// Both are swept rather than picked, and the assertions below are about the
// SHAPE of the ladder (does it keep accelerating, does it stall), never about
// an absolute time — a time depends on the model, but a stall is a stall under
// every setting of it.
//
// Seeded: the spawner rolls species, schools and jitter, and an unseeded run
// of this would move a level by twenty seconds between invocations and invite
// exactly the wrong conclusion. See tools/lib/seeded-random.mjs.
//
//   node --import ./tools/vite-loader.mjs tools/xp-economy-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG, xpForNextLevel, xpToughnessMul, difficultyRamp, chumValueRamp } from '../path/src/config.js';
import { enemies, resetEnemies, removeEnemy, updateSpawning, setSpawnLevel } from '../path/src/entities/enemies.js';
import { resetWaves } from '../path/src/systems/waves.js';
import { pickups, resetPickups, spawnXpOrb, setChumDifficulty, chumMassMul, chumRadiusOf } from '../path/src/entities/pickups.js';
import { strikeState, chainXpMul } from '../path/src/systems/strike.js';
import { xpAllowance, spillStep } from '../path/src/xpSpill.js';
import { bossArchetypes } from '../path/src/systems/boss.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// mulberry32 — small, fast, and identical from run to run.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUN_SECONDS = 15 * 60;
const MAX_LEVEL = 40;

/**
 * One simulated run. Returns the level ladder and a per-minute income trace.
 *
 * `foodChainMul(seconds)` lets a caller model chain bonuses without this
 * module needing to know what a chain is — it is applied to collected xp, the
 * same place systems/strike.js's multiplier would land.
 */
function simulate({ hunt = 7, clear = 0.8, seed = 1, foodChainMul = () => 1 } = {}) {
  const rand = seeded(seed);
  const realRandom = Math.random;
  Math.random = rand;

  resetEnemies(scene);
  resetPickups(scene);
  resetWaves(0);

  const gameState = { difficulty: 0, level: 1, xp: 0, xpToNext: CONFIG.xp.first };
  const ladder = [{ level: 1, at: 0 }];
  const perMinute = [];
  let minuteXp = 0;
  let minuteMark = 60;
  let totalXp = 0;
  let kills = 0;
  let orbXp = 0;

  try {
    const steps = Math.round(RUN_SECONDS / dt);
    for (let i = 0; i < steps; i++) {
      const t = i * dt;
      gameState.difficulty = t * CONFIG.spawn.difficultyPerSecond;
      setChumDifficulty(gameState.difficulty);

      // The LEVEL-keyed surcharge, pushed in exactly as main.js pushes it. Not
      // optional for this file: CONFIG.spawn.lateGame makes late creatures
      // tougher AND their chum worth more, and those are the two halves of the
      // question this harness exists to answer. Without this line the ladder
      // below would be measuring a game nobody plays.
      setSpawnLevel(gameState.level);
      updateSpawning(dt, gameState, scene);

      // THE HUNT. Walk backwards: removeEnemy takes an INDEX and splices, so a
      // forward walk would skip the creature that slid into the hole.
      //
      // `hunt` is the time-to-kill for a BASIC FISH at this moment, and every
      // other creature is scaled off it by hp — a shark carries about twelve
      // times a fish's health at any point in a run, so it takes about twelve
      // times as long to clear and it stands in the water that much longer.
      //
      // This used to be one flat rate for the whole roster, which is fine while
      // the composition never changes and silently wrong the moment it does:
      // moving the spawn mix toward big bodies then read as pure extra income,
      // because the model collected a megalodon's 40 xp at a sardine's speed.
      // Measured, it was worth 15,000 xp/min of pure fiction and two whole
      // levels on the ladder.
      //
      // Divided by the fish's OWN ramped hp rather than by a constant, so the
      // roster-wide hp ramp cancels out: the seal's damage grows over a run
      // too, and `hunt` is the knob that says how well it keeps up. What
      // survives the division is the spread WITHIN the roster at one moment,
      // which is the thing a composition change actually moves. Clamped at both
      // ends — nothing clears faster than about a clownfish, and the sea
      // turtle's invincible-sentinel hp would otherwise divide the hazard to
      // zero and pin the arena (see the note on xp.toughness.max in config.js).
      //
      // The reference deliberately carries the CLOCK ramp only, not
      // lateGameMul('hp'). That asymmetry is the point of the level surcharge
      // and the pessimistic read of it: the clock ramp cancels because the
      // seal's damage grows with the run, while the surcharge exists precisely
      // to outgrow a build that the clock ramp could not keep up with, so it
      // lands here as kills that genuinely take longer. Pessimistic because the
      // seal is still taking cards past level 20 and this credits it with none
      // of them — if the ladder holds against that, it holds.
      const fishDef = CONFIG.enemies.fish;
      const refHp = Math.max(1, (fishDef.hp + (fishDef.hpPerDifficulty ?? 0) * gameState.difficulty)
        * difficultyRamp('hp', gameState.difficulty));
      const hazard = dt / Math.max(0.1, hunt);
      for (let n = enemies.length - 1; n >= 0; n--) {
        const toughness = Math.max(1 / 40, Math.min(1.5, refHp / Math.max(1, enemies[n].hp ?? refHp)));
        if (rand() >= hazard * toughness) continue;
        const e = enemies[n];
        // The real drop, so the tier table and the early holdback are the
        // shipped ones. e.xp, not e.def.xp — a lull fish is worth a fraction.
        spawnXpOrb(scene, e.mesh.position, e.xp ?? e.def.xp, chumRadiusOf(e.def));
        // The LAST entry, not "did the array grow": past CONFIG.pickups.maxAlive
        // every spawn also recycles the oldest orb, so the length stops changing
        // a couple of minutes in and a growth test silently reads zero income
        // for the rest of the run.
        const orb = pickups[pickups.length - 1] ?? null;
        removeEnemy(scene, n);
        kills++;
        if (!orb) continue;
        orbXp += orb.value;
        if (rand() > clear) continue;
        const gained = orb.value * foodChainMul(t);
        totalXp += gained;
        minuteXp += gained;
        gameState.xp += gained;
        while (gameState.xp >= gameState.xpToNext && gameState.level < MAX_LEVEL) {
          gameState.xp -= gameState.xpToNext;
          gameState.level++;
          gameState.xpToNext = xpForNextLevel(gameState.level, gameState.xpToNext);
          ladder.push({ level: gameState.level, at: t });
        }
      }

      if (t >= minuteMark) {
        perMinute.push(minuteXp);
        minuteXp = 0;
        minuteMark += 60;
      }
    }
  } finally {
    Math.random = realRandom;
  }

  return { ladder, perMinute, level: gameState.level, totalXp, orbXp, kills };
}

/** Mean seconds each of `seeds` took to reach `level`, or null if none did. */
function timeToLevel(runs, level) {
  const hits = runs.map((r) => r.ladder.find((l) => l.level === level)?.at).filter((x) => x != null);
  if (!hits.length) return null;
  return hits.reduce((a, b) => a + b, 0) / hits.length;
}

const SEEDS = [1, 2, 3];
const runsFor = (opts) => SEEDS.map((seed) => simulate({ ...opts, seed }));

// ---------------------------------------------------------------------------
section('THE COST CURVE — what CONFIG.xp asks for, before any income');

{
  let prev = CONFIG.xp.first;
  let cum = 0;
  const rows = [];
  for (let lv = 1; lv <= 22; lv++) {
    cum += prev;
    rows.push({ lv, cost: prev, cum });
    prev = xpForNextLevel(lv, prev);
  }
  for (const r of rows.filter((r) => r.lv % 2 === 0 || r.lv <= 10)) {
    console.log(`        ${String(r.lv).padStart(2)} → ${String(r.lv + 1).padStart(2)}   ${String(Math.round(r.cost)).padStart(7)} xp   (${Math.round(r.cum)} cumulative)`);
  }
  const step = (lv) => rows.find((r) => r.lv === lv).cost / rows.find((r) => r.lv === lv - 1).cost;
  console.log(`        cost multiplier: ${step(5).toFixed(2)}x at level 5, ${step(11).toFixed(2)}x at 11, ${step(19).toFixed(2)}x at 19`);
}

// ---------------------------------------------------------------------------
section('THE DROP SPREAD — what one kill is worth, by species and by minute');

// What an orb from `key` pays, at `difficulty`. Assembled from the same four
// pieces spawnXpOrb and spawnOne use, imported rather than restated, so a
// change to any of them shows up here without this file being edited.
function orbValue(key, difficulty) {
  const def = CONFIG.enemies[key];
  const hp = (def.hp + (def.hpPerDifficulty ?? 0) * difficulty) * difficultyRamp('hp', difficulty);
  // chumRadiusOf, like the drop itself — see the note on it. Reading def.radius
  // here is how this file used to price the king crab as a minnow.
  const radius = chumRadiusOf(def);
  const tier = CONFIG.pickups.tiers.find((t) => radius <= t.maxRadius)
    ?? CONFIG.pickups.tiers[CONFIG.pickups.tiers.length - 1];
  // chumValueRamp, imported rather than restated. The holdback's SHAPE is
  // tunable now (CONFIG.xp.dropRamp.curve) and a copy of the old straight line
  // here would have this file quietly pricing a different game.
  return (def.xp ?? 0) * xpToughnessMul(hp, def.hp)
    * tier.xpMul * chumMassMul(radius).value * (CONFIG.xp.chumMul ?? 1) * chumValueRamp(difficulty);
}

{
  const dps = CONFIG.spawn.difficultyPerSecond;
  const show = ['fish', 'reeffish', 'barracuda', 'squid', 'dolphin', 'shark', 'greatWhite', 'mightyMeg', 'megalodon', 'bossShark'];
  console.log('        species          radius     m1     m5    m12    m12/m1');
  for (const k of show.filter((k) => CONFIG.enemies[k])) {
    const v = [1, 5, 12].map((m) => orbValue(k, m * 60 * dps));
    console.log(`        ${k.padEnd(16)}${String(CONFIG.enemies[k].radius).padStart(5)}`
      + v.map((x) => x.toFixed(1).padStart(7)).join('')
      + `${(v[2] / Math.max(0.01, v[0])).toFixed(1).padStart(9)}x`);
  }

  const d12 = 12 * 60 * dps;
  check('a big predator is worth plainly more than a starter fish',
    orbValue('megalodon', d12) > orbValue('fish', d12) * 20,
    `megalodon ${orbValue('megalodon', d12).toFixed(0)} vs fish ${orbValue('fish', d12).toFixed(1)}`);
  check('...and a boss is worth plainly more than the big predator',
    orbValue('bossShark', d12) > orbValue('megalodon', d12) * 2,
    `boss ${orbValue('bossShark', d12).toFixed(0)} vs megalodon ${orbValue('megalodon', d12).toFixed(0)}`);
  check('...and the biggest ordinary predator out-drops the smallest one',
    orbValue('megalodon', d12) > orbValue('shark', d12) * 2,
    `megalodon ${orbValue('megalodon', d12).toFixed(0)} vs shark ${orbValue('shark', d12).toFixed(0)}`);
  check('a late-run creature pays more than the same species did at minute one',
    orbValue('shark', d12) > orbValue('shark', 60 * dps) * 3,
    `shark ${orbValue('shark', 60 * dps).toFixed(0)} → ${orbValue('shark', d12).toFixed(0)}`);

  // The size tell has to move with the value or the rule is invisible.
  const smallSize = chumMassMul(CONFIG.enemies.fish.radius).size;
  const bigSize = chumMassMul(CONFIG.enemies.megalodon.radius).size;
  check('the orb a big predator drops is visibly bigger, without being absurd',
    bigSize > smallSize * 1.3 && bigSize < smallSize * 3,
    `x${smallSize.toFixed(2)} scale from a fish, x${bigSize.toFixed(2)} from a megalodon`);
}

// ---------------------------------------------------------------------------
section('THE FOOD CHAIN — what a live chain adds to a mouthful');

// The REAL multiplier, driven by writing the same two fields systems/strike.js
// writes. `chainPips` is mouthfuls; a bar is 1/chumRefill of them.
function chainMulAt(links) {
  const perLevel = Math.max(1, Math.round(1 / (CONFIG.strike.charge.chumRefill ?? 0.2)));
  strikeState.chainTimer = links > 0 ? 1 : 0;
  strikeState.chainPips = links * perLevel;
  const mul = chainXpMul(null);
  strikeState.chainTimer = 0;
  strikeState.chainPips = 0;
  return mul;
}

{
  const rows = [0, 1, 2, 4, 8, 16].map((n) => `${n} links: x${chainMulAt(n).toFixed(2)}`);
  console.log(`        ${rows.join('   ')}`);
  check('no chain is no bonus', chainMulAt(0) === 1);
  check('the first link is free, like every other chain multiplier', chainMulAt(1) === 1,
    `x${chainMulAt(1).toFixed(2)} at one link (offset ${CONFIG.strike.chainLevelOffset})`);
  check('a deep chain is worth real xp', chainMulAt(8) > 1.5, `x${chainMulAt(8).toFixed(2)} at 8 links`);
  check('...and it is capped', chainMulAt(100) <= (CONFIG.xp.chain?.max ?? Infinity) + 1e-9,
    `x${chainMulAt(100).toFixed(2)} at 100 links, cap x${CONFIG.xp.chain?.max}`);
}

// ---------------------------------------------------------------------------
section('INCOME — what the water actually pays, per minute');

// The run-average lift a live chain is worth. A player who holds a four-link
// chain over roughly a third of their mouthfuls averages about this, and it is
// a constant rather than a simulated chain because nothing in this harness
// plays: the strike system needs a stick and a seal. What it is here for is to
// stop the ladder below being quoted for a player who never chains at all.
const CHAIN_AVG = 1.15;

const base = runsFor({ hunt: 7, clear: 0.8, foodChainMul: () => CHAIN_AVG });
{
  const mins = base[0].perMinute.length;
  const avg = Array.from({ length: mins }, (_, i) =>
    base.reduce((a, r) => a + (r.perMinute[i] ?? 0), 0) / base.length);
  console.log(`        ${avg.map((v, i) => `m${i + 1}:${Math.round(v)}`).join('  ')}`);
  // Windows, not single minutes: the wave cycle swings one minute against the
  // next by a third on its own, and a check on two lone minutes is a coin flip
  // dressed up as an assertion.
  const window = (a, b) => avg.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
  const early = window(2, 5);   // minutes 3-5
  const late = window(9, 14);   // minutes 10-14
  console.log(`        income growth: x${(late / Math.max(1, early)).toFixed(2)} from minutes 3-5 to minutes 10-14`);
  // THE WHOLE POINT. Before the toughness ramp this was 1.0 — income flattened
  // at minute five and never moved again, while every level cost 1.6x the last.
  check('late income is well clear of mid-run income (a flat late income IS the wall)',
    late > early * 1.5, `${Math.round(early)} xp/min at minutes 3-5 → ${Math.round(late)} at 10-14`);
}

// ---------------------------------------------------------------------------
section('THE LADDER — when each level lands, at a normal clear rate');

function ladderReport(runs, label) {
  console.log(`      ${label}`);
  let prevAt = 0;
  const gaps = [];
  // Printed to the end of a fifteen-minute run, not to 20: the `endMul` band
  // starts at 21 and the levels it charges for were the ones nobody could see.
  for (let lv = 2; lv <= 26; lv++) {
    const at = timeToLevel(runs, lv);
    if (at == null) {
      console.log(`        ${String(lv).padStart(2)}   never reached in ${RUN_SECONDS / 60} minutes`);
      break;
    }
    gaps.push({ lv, at, gap: at - prevAt });
    console.log(`        ${String(lv).padStart(2)}   ${(at / 60).toFixed(1)}m   (+${(at - prevAt).toFixed(0)}s)`);
    prevAt = at;
  }
  return gaps;
}

const gaps = ladderReport(base, 'hunt 7s, clear 80%');

{
  const reached = base.map((r) => r.level);
  console.log(`        level at 15 minutes: ${reached.join(', ')}`);
  // The wall, stated as the thing a player feels. Averaged over three levels at
  // each end rather than compared level to level: one gap swings by a factor of
  // two on the wave cycle alone, and a single pair would report noise as a
  // trend. Before any of this it read 5.7x; the curve is unchanged, so what
  // moved is entirely the income side.
  const span = (a, b) => {
    const g = gaps.filter((x) => x.lv >= a && x.lv <= b);
    return g.length ? g.reduce((s, x) => s + x.gap, 0) / g.length : 0;
  };
  if (span(17, 19) && span(11, 13)) {
    console.log(`        a level in the 17-19 band costs ${(span(17, 19) / span(11, 13)).toFixed(1)}x `
      + `the wall-clock of one in the 11-13 band (${span(11, 13).toFixed(0)}s → ${span(17, 19).toFixed(0)}s)`);
  }
  if (span(21, 24) && span(11, 13)) {
    console.log(`        ...and one in the 21-24 band costs ${(span(21, 24) / span(11, 13)).toFixed(1)}x `
      + `(${span(11, 13).toFixed(0)}s → ${span(21, 24).toFixed(0)}s)`);
  }
  // Both ends matter. A run that reached level 30 would pass "levels still
  // arrive" while being a different game — every upgrade taken by minute six
  // and nothing left to want.
  //
  // The ceiling was 24 while CONFIG.xp.toughness.exponent was 0.4. Paying a
  // late creature's toughness back properly (0.6) is worth about two levels
  // over fifteen minutes, and they are levels 25 and 26 — arriving at minute
  // thirteen and minute fifteen, off a `endMul` band that is already charging
  // 50-60 seconds a level by then. That is the tail of a run, not a second
  // game: 26 levels is 25 picks against the 381 upgrades.csv actually holds.
  // Steepening `endMul` to hold the old number instead would have bought a
  // 90-second level at 24 to save a level at 26, which is the wall this file
  // exists to find, moved rather than removed.
  check('a fifteen-minute run finishes somewhere in the high teens or high twenties',
    reached.every((l) => l >= 18 && l <= 29), `reached ${reached.join(', ')}`);
  // The band nobody could see, and the reason the ceiling above moved 26 → 29.
  // `endMul` re-steepens the cost curve at level 21 while income is already
  // flattening (spawn.ramp.hp caps around minute eleven, and xp.toughness caps
  // with it), so 21+ was cost compounding against income that wasn't: measured
  // at endMul 1.6 the gaps ran 41s, 48s, 60s, 77s, 85s, 133s — a level in the
  // 21-24 band costing 2.3x one in the 11-13 band, which is the wall this file
  // exists to find, sitting one level past where the report stopped printing.
  //
  // The fix is on the COST side and only there. Buying it with income instead
  // (a higher xp.toughness.exponent) works on this band but pays out from the
  // first minute too, so it drags 11-20 in with it — and 11-20 is not the
  // problem, it is the part of the run that paces correctly.
  if (span(21, 24) && span(11, 13)) {
    check('...and the band past 21 does not fall off a cliff',
      span(21, 24) < span(11, 13) * 2.0,
      `${span(11, 13).toFixed(0)}s in the 11-13 band → ${span(21, 24).toFixed(0)}s in the 21-24 band`);
  }
  check('no single level past 10 takes more than three minutes',
    gaps.filter((x) => x.lv > 10).every((x) => x.gap <= 180),
    gaps.filter((x) => x.lv > 10).map((x) => `${x.lv}:${x.gap.toFixed(0)}s`).join(' ') || 'never got past 10');
  // A ladder whose gaps only ever grow is one the player experiences as slowing
  // to a stop, whatever the absolute numbers are. This is the shape assertion,
  // and the one that failed for every income setting until orbs started tracking
  // difficulty — see CONFIG.xp.toughness.
  const late = gaps.filter((x) => x.lv >= 10);
  check('the gaps between levels stop growing before the run ends',
    late.some((x, i) => i > 0 && x.gap <= late[i - 1].gap),
    late.map((x) => `${x.gap.toFixed(0)}s`).join(' → '));
  // THE OPENING, which has now been pulled in both directions and is the thing
  // to watch when any of this is retuned. `chumMul` and the mass ramp both pay
  // out from the first second and dragged level 10 in to 1.5m; the early
  // holdback (CONFIG.xp.dropRamp) is the counterweight, and it only started
  // working when it was given a `curve` — a straight-line ramp was already
  // paying 60% of full value one minute in, which is inside the stretch it
  // exists to hold back. At start 0.12 / fullAt 26 / curve 2 an orb pays 16%
  // there instead, and level 10 sits at 2.3m.
  //
  // The band is wide because this end of the run is allowed to move. What it
  // forbids is the two extremes: an opening that collapses into "take ten
  // upgrades in ninety seconds", and one so starved that the first upgrade is
  // minutes away.
  const l10 = timeToLevel(base, 10) ?? 0;
  check('the opening is not rushed — level 10 lands between one and three minutes',
    l10 > 60 && l10 < 180, `level 10 at ${(l10 / 60).toFixed(1)}m`);

  // ...and the very first card, specifically. The holdback bites hardest at
  // difficulty 0, so this is the number that goes wrong first if `start` is
  // pushed further down: a run whose opening minute hands out nothing at all is
  // a run that has not started yet.
  const l2 = timeToLevel(base, 2) ?? 0;
  check('...and the first upgrade still arrives promptly',
    l2 > 5 && l2 < 45, `level 2 at ${l2.toFixed(0)}s`);
}

// ---------------------------------------------------------------------------
// The ladder above is about AVERAGE income, and a boss is the one payout that
// average hides: it arrives as a single indivisible orb, and the multipliers
// that size it all read the creature while nothing reads the rung it lands on.
// playtest/runs.jsonl caught the result twice — six upgrade cards stamped at
// one identical timestamp, both times a boat boss — so what is measured here is
// the LUMP, against the shipped CONFIG.xp.spill.
section('THE LUMP — how many cards one boss opens');

// The shipped clamp and the shipped reserve, driven exactly as gainXP and
// updateXpSpill drive them: swallow `amount`, then run frames until the reserve
// is empty. Returns the seconds at which each level landed, relative to the
// swallow. The upgrade menu pauses the run, so the reserve does NOT drain while
// a card is up — the player's own reading time is not part of the window, and
// this loop leaves it out for the same reason.
function cardsFor(amount, fromLevel, { enabled = true, maxLevels = 1, seconds = 10 } = {}) {
  const state = { level: fromLevel, xp: 0, xpToNext: 0 };
  { let prev = CONFIG.xp.first; for (let L = 1; L < fromLevel; L++) prev = xpForNextLevel(L, prev); state.xpToNext = prev; }

  const at = [];
  let t = 0;
  let reserve = 0;
  let left = 0;
  const take = (n) => {
    let amt = n;
    if (enabled && amt > 0) {
      const room = xpAllowance(state, maxLevels);
      if (amt > room) { reserve += amt - room; left = Math.max(0.001, seconds); amt = room; }
    }
    state.xp += amt;
    while (state.xp >= state.xpToNext) {
      state.xp -= state.xpToNext;
      state.level += 1;
      state.xpToNext = xpForNextLevel(state.level, state.xpToNext);
      at.push(t);
    }
  };
  take(amount);
  // A whole simulated minute is far longer than any window this config can set,
  // so a reserve still alive at the end is a reserve that cannot empty.
  for (let i = 0; i < 60 / dt && reserve > 0; i++) {
    t += dt;
    const step = spillStep(reserve, left, dt);
    reserve = step.reserve;
    left = step.secondsLeft;
    take(step.pay);
  }
  return { at, stuck: reserve > 0 };
}

{
  const dps = CONFIG.spawn.difficultyPerSecond;
  // The wall-clock each boss level lands at, off the ladder printed above.
  const when = { 5: 24, 10: 90, 15: 222, 20: 540 };
  const gap = Math.max(1, Math.round(CONFIG.boss?.everyLevels ?? 5));
  const chainCap = CONFIG.xp?.chain?.max ?? 1;
  // The shipped roster, so an archetype added to bosses.csv is measured here
  // without this file being edited — and at the level that file holds it back
  // to, rounded up to the cadence, which is the first fight it can actually be.
  const roster = bossArchetypes()
    .filter((b) => CONFIG.enemies[b.enemy])
    .map((b) => ({ key: b.enemy, level: Math.max(gap, Math.ceil((b.minLevel || 1) / gap) * gap) }));

  // Levels landing on ONE frame is the whole bug: the run stops, and stops
  // again, with no water in between. Everything else here is about how the rest
  // of the payout is spread.
  const worstFrame = (at) => {
    const perFrame = new Map();
    for (const t of at) perFrame.set(t.toFixed(4), (perFrame.get(t.toFixed(4)) ?? 0) + 1);
    return Math.max(0, ...perFrame.values());
  };

  console.log('        boss            level      orb   levels   worst frame, before → after   pays over');
  const before = [];
  const after = [];
  for (const { key, level } of roster) {
    // The worst case on purpose: swallowed on a capped food chain, which is the
    // biggest a single mouthful in this game can be.
    const v = orbValue(key, (when[level] ?? when[20]) * dps) * chainCap;
    const off = cardsFor(v, level, { enabled: false });
    const on = cardsFor(v, level, CONFIG.xp.spill);
    before.push(worstFrame(off.at));
    after.push({ key, worst: worstFrame(on.at), levels: on.at.length, was: off.at.length, stuck: on.stuck });
    const span = on.at.length > 1 ? `${(on.at[on.at.length - 1] - on.at[0]).toFixed(1)}s` : 'one, at once';
    console.log(`        ${key.padEnd(16)}${String(level).padStart(4)}${v.toFixed(0).padStart(9)}`
      + `${String(on.at.length).padStart(8)}`
      + `${String(worstFrame(off.at)).padStart(14)} → ${String(worstFrame(on.at)).padEnd(6)}`
      + `${span.padStart(15)}`);
  }

  // Deliberately NOT "a boss still opens N cards at once without the clamp".
  // That was the original bug's magnitude and it moves with every retune of the
  // economy — the early-chum holdback alone cut it from 4 cards to 2 — so an
  // assertion pinned to it fails on a change that made the game better. What
  // has to hold is the MECHANISM, so this hands the clamp a swallow far bigger
  // than any orb in the game and checks it still comes apart.
  {
    let rung = CONFIG.xp.first;
    for (let L = 1; L < 5; L++) rung = xpForNextLevel(L, rung);
    const huge = xpAllowance({ level: 5, xp: 0, xpToNext: rung }, 12) * 1.5;
    const off = cardsFor(huge, 5, { enabled: false });
    const on = cardsFor(huge, 5, CONFIG.xp.spill);
    check('an impossible mouthful is still paid out one card at a time',
      worstFrame(off.at) > worstFrame(on.at)
      && worstFrame(on.at) <= Math.max(1, CONFIG.xp.spill.maxLevels),
      `${worstFrame(off.at)} cards on one frame unclamped → ${worstFrame(on.at)} clamped`);
    check('...and every level of it still arrives',
      on.at.length === off.at.length && !on.stuck,
      `${off.at.length} levels either way, over ${(on.at[on.at.length - 1] ?? 0).toFixed(1)}s`);
  }
  console.log(`        worst single frame across the roster: ${Math.max(...before)} cards unclamped`);
  check('no frame crosses more than the allowance',
    after.every((a) => a.worst <= Math.max(1, CONFIG.xp.spill.maxLevels)),
    after.map((a) => `${a.key.replace('boss', '')} ${a.worst}`).join(', '));
  check('...while every level the orb was worth still arrives',
    after.every((a) => a.levels === a.was),
    after.map((a) => `${a.key.replace('boss', '')} ${a.was}→${a.levels}`).join(', '));
  check('the held xp always pays itself out — no reserve survives its window',
    after.every((a) => !a.stuck));

  // Nothing is LOST, which is the difference between this and clamping the orb.
  // Checked against the ladder rather than by summing payments: what the player
  // is owed is the level they would have reached either way.
  const worst = orbValue('bossBoat', when[10] * dps) * chainCap;
  const off = cardsFor(worst, 10, { enabled: false });
  const on = cardsFor(worst, 10, CONFIG.xp.spill);
  check('...and the same orb is still worth the same levels, only spread out',
    off.at.length === on.at.length,
    `${off.at.length} levels either way, over ${(on.at[on.at.length - 1] ?? 0).toFixed(1)}s instead of instantly`);

  // The other half of "spread out" is that it does not become a drip. A player
  // who ate a boss should be done collecting on it before the next fight.
  check('a spill is paid in well inside the gap between two bosses',
    (on.at[on.at.length - 1] ?? 0) <= (CONFIG.xp.spill.seconds ?? 10) + 1,
    `last level ${(on.at[on.at.length - 1] ?? 0).toFixed(1)}s after the swallow`);

  // An ordinary mouthful must be untouched by any of this — the clamp only ever
  // fires on a swallow that would cross more than one threshold, and a run made
  // of small orbs should behave exactly as it did before.
  const fish = orbValue('fish', when[5] * dps);
  const one = cardsFor(fish, 5, CONFIG.xp.spill);
  check('an ordinary mouthful is not held back at all',
    !one.stuck && one.at.every((x) => x === 0),
    `a fish orb pays ${fish.toFixed(1)} xp, all of it on the frame it lands`);
}

// ---------------------------------------------------------------------------
section('SENSITIVITY — how much of this is the player model');

for (const opts of [{ hunt: 4, clear: 0.9 }, { hunt: 7, clear: 0.8 }, { hunt: 12, clear: 0.6 }]) {
  const r = runsFor({ ...opts, foodChainMul: () => CHAIN_AVG });
  const l12 = timeToLevel(r, 12);
  const l15 = timeToLevel(r, 15);
  console.log(`        hunt ${String(opts.hunt).padStart(2)}s clear ${(opts.clear * 100).toFixed(0)}%: `
    + `level 12 at ${l12 ? (l12 / 60).toFixed(1) + 'm' : '—'}, `
    + `level 15 at ${l15 ? (l15 / 60).toFixed(1) + 'm' : '—'}, `
    + `ends at level ${r.map((x) => x.level).join('/')}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
