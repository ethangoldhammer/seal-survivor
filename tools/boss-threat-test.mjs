#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bossthreat
//
// WHETHER A BOSS IS ACTUALLY A THREAT — the one question the boss suite could
// not answer, spread as it was across a dozen files that each held one piece.
//
// THE REPORT THAT MADE THIS FILE. Measured against 160 logged runs: a boss
// deals a median 0.8% of the player's bar per second while it is in the water,
// mean 1.5%, and CONFIG.boss.damageCap allows it 75%. Bosses were 15% of all
// damage taken across a run and a single sailfish was worth more than any of
// them. Worse than the level, the SHAPE: the opening boss was the most
// dangerous one in the game, and every fight after it was shorter and cheaper
// than the one before — 69s and 71% of a bar at level 5 against 34s and 10% at
// level 20.
//
// Four causes, and each of them is a claim below.
//
//   COMMITTED     the telegraphed pass the four chasing bosses do sets
//                 `lungeStage = 'strike'` and nothing else, and the contact
//                 call in systems/combat.js asked `e.ramming` — a flag only
//                 the kraken, the anglerfish, the crab and the lunge PERK set.
//                 So the most readable attack in the game was billed on the
//                 chip channel and held to `contactPerSecond`, a seventh of
//                 the bar a second. Every other rule about a boss already
//                 asked `isCommittedRun`; this was the last one that did not,
//                 and it was the one that decided what the attack was WORTH.
//
//   ARMOR         and nothing made standing in front of it cost anything.
//                 `tenacity.committed` refused the flinch and the shove during
//                 a run and let the damage through at full, so the answer to
//                 three tonnes of animal winding up was to hold the trigger
//                 down. CONFIG.boss.armor is the other half — with the lit
//                 weak spot exempt, because a lunge is when the spots are in
//                 front of you.
//
//   ONE DOOR      a boss could spend 47% of a fight not fighting: a 1.6s daze
//                 on a 5s cooldown (24%) plus the weak-spot stagger (23%), and
//                 the daze was handed out by SEVEN abilities, six of which
//                 cost nothing but having picked the card. A perfect strike
//                 into a lit spot — a full charge, a release on the beat, a
//                 dash onto a spot the size of a fin — was buying the same
//                 window as a bubble that happened to be off cooldown.
//
//   THE LADDER    boss health grew 44x between the level-5 fight and the
//                 level-20 one while a real build's damage grew 90x. The
//                 existing ladder check measures the UN-CARDED GUN, which is
//                 the floor of what a player brings to the FIRST boss and a
//                 fiction fifteen cards later; this one reads the ledger.
//
// Arithmetic and the real tables — no scene, no renderer. The one thing it
// cannot measure is whether a lunge CONNECTS, which is the player's half; it
// measures what one is worth when it does.
//
//   node --import ./tools/vite-loader.mjs tools/boss-threat-test.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import fs from 'node:fs';
import { updateBounds } from '../path/src/arena.js';
import { spawnNamed, resetEnemies, armBossArmor } from '../path/src/entities/enemies.js';
import { hotSpotDamage, attachHotSpots } from '../path/src/systems/bossHotSpots.js';
import {
  CONFIG, enemyPaceMul, bossDifficulty, bossHpRamp, difficultyRamp,
} from '../path/src/config.js';
import { committedDamageMul, isCommittedRun, bossArmorMul } from '../path/src/entities/enemies.js';

let fails = 0;
const section = (n) => console.log(`\n${n}`);
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const pad = (s, n) => String(s).padStart(n);
const r1 = (n) => Math.round(n * 10) / 10;
const pct = (n) => `${Math.round(n * 100)}%`;

const BOSS_KEYS = Object.keys(CONFIG.enemies)
  .filter((k) => k.startsWith('boss') && !CONFIG.enemies[k].bossMinion);
const CHASERS = BOSS_KEYS.filter((k) => CONFIG.enemies[k].lunge);
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

const hpAt = (key, level) => {
  const def = CONFIG.enemies[key];
  const axis = bossDifficulty(level);
  return (def.hp + (def.hpPerDifficulty ?? 0) * axis)
    * bossHpRamp(axis) * (CONFIG.spawn?.bossHp?.mul ?? 1) * enemyPaceMul('hp');
};
const medianHp = (level) => median(BOSS_KEYS.map((k) => hpAt(k, level)));

// ---------------------------------------------------------------------------
// THE LEDGER. What a player actually deals, and what a boss actually took off
// them, per level — the only honest input to "is this a fight".
// ---------------------------------------------------------------------------
function readLedger() {
  const path = new URL('../playtest/runs.jsonl', import.meta.url);
  if (!fs.existsSync(path)) return null;
  const dealt = {}; const took = {};
  let bossTaken = 0; let allTaken = 0; let contact = 0; let aimed = 0;
  for (const line of fs.readFileSync(path, 'utf8').trim().split('\n').slice(-160)) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const bar = o.startMaxHp || 100;
    for (const b of o.buckets ?? []) {
      if (!b.seconds) continue;
      const L = b.level || 1;
      const d = Object.values(b.dealtBySource ?? {}).reduce((a, x) => a + x, 0);
      if (d) (dealt[L] = dealt[L] ?? []).push(d / b.seconds);
      let bd = 0;
      for (const [k, v] of Object.entries(b.takenBySource ?? {})) {
        allTaken += v;
        if (!/^boss/.test(k)) continue;
        bd += v; bossTaken += v;
        if (k.includes(':')) aimed += v; else contact += v;
      }
      if (bd > 0) (took[L] = took[L] ?? []).push(bd / b.seconds / bar);
    }
  }
  return { dealt, took, bossTaken, allTaken, contact, aimed };
}
const led = readLedger();
const nearest = (bag, L) => {
  for (let d = 0; d <= 3; d++) {
    if (bag[L - d]?.length) return median(bag[L - d]);
    if (bag[L + d]?.length) return median(bag[L + d]);
  }
  return null;
};

// ---------------------------------------------------------------------------
section('1. A COMMITTED RUN IS AN ATTACK');
// ---------------------------------------------------------------------------
// The regression that rots. `isCommittedRun` is the shared answer and four
// systems read it; combat.js asking `e.ramming` instead was invisible because
// the lunge still LOOKED like an attack — the tell played, the body ran, the
// numbers were just chip. Asserted on the function rather than on a grep, so a
// rewrite that keeps the name and drops the branch still fails here.
ok(isCommittedRun({ lungeStage: 'strike' }) === true,
  "a body mid-strike is committed — this is the case combat.js used to miss");
ok(isCommittedRun({ ramming: true }) === true, 'and so is one the perk is driving');
ok(isCommittedRun({ lungeStage: 'wind' }) === false,
  'a wind-up is NOT — the tell is the window the player is given, not the hit');
ok(isCommittedRun({}) === false, 'and ordinary swimming is not');

const combat = fs.readFileSync(new URL('../path/src/systems/combat.js', import.meta.url), 'utf8');
ok(/isCommittedRun\(e\)/.test(combat) && !/e\.ramming \? 'attack'/.test(combat),
  "...and the contact call bills off it — the narrow `e.ramming ?` test is gone");

section("2. ...AND IT IS WORTH MORE THAN DRIFTING INTO THE TAIL");
for (const k of CHASERS) {
  const mul = committedDamageMul({ lungeStage: 'strike', def: CONFIG.enemies[k] });
  ok(mul > 1, `${k} multiplies its contact for the run — x${mul}`);
}
ok(committedDamageMul({ ramming: true, def: CONFIG.enemies.bossShark }) === 1,
  'a `ramming` body takes 1 — the kraken, the angler and the perk already wrote '
  + 'e.contactDamage themselves, and charging both would double every one of them');
ok(committedDamageMul({ lungeStage: 'strike', def: { lunge: {} } }) === 1,
  'a lunge with no number is worth exactly what it was before this existed');

// WHAT ONE COSTS YOU. Contact is a per-second drain, so a pass is worth
// (contactDamage x the run's damage ramp x damageMul) for as long as the seal
// is inside the body — and then CONFIG.boss.damageCap.perSecond decides how
// much of that may actually land.
const cap = CONFIG.boss.damageCap;
section('   what a connecting pass takes, as a fraction of the bar');
console.log('   boss            level   raw hp/s   over the overlap   after the cap');
const passes = [];
for (const L of [5, 20]) {
  for (const k of CHASERS) {
    const def = CONFIG.enemies[k];
    // The run clock a level lands at, from the ledger's pace.
    const d = L === 5 ? 4.5 : 35;
    const bar = L === 5 ? 115 : 200;
    const raw = def.contactDamage * difficultyRamp('damage', d) * (def.lunge.damageMul ?? 1);
    // How long the seal is inside it: the chord through a body of this radius
    // at the lunge's speed. Generous — dead centre — so this is the ceiling.
    const reach = def.radius * 1.6 + 1;
    const speed = def.speed * def.lunge.speedMul;
    const overlap = Math.min(def.lunge.strikeTime, (reach * 2) / speed);
    const gross = raw * overlap;
    const landed = Math.min(gross, bar * cap.perSecond);
    passes.push({ k, L, frac: landed / bar });
    console.log(`   ${k.padEnd(16)}${pad(L, 5)}${pad(Math.round(raw), 11)}`
      + `${pad(pct(gross / bar), 19)}${pad(pct(landed / bar), 16)}`);
  }
}
// ---------------------------------------------------------------------------
// WHAT A FIGHT COSTS, which is the question — not what a pass costs.
// ---------------------------------------------------------------------------
// This used to band the PASS: 15-35% of a fresh bar early, 40%+ late. Those
// numbers were authored when a committed run reached a real player about 1-5%
// of the time, so "a pass is worth a fifth of your bar" and "a fight is
// survivable" were the same statement. They are not any more. The reach retune
// (2026-09-16) took the connect rate to 50-68% against a seal that dodges, and
// holding the per-pass band would have put a late fight at 2.1-3.8 bars — three
// deaths' worth — while every check in this file stayed green.
//
// So the assertion is the fight. A pass is priced by how OFTEN it lands and how
// long the fight lasts, and both of those are measurements rather than
// arithmetic — they live here as named constants with their provenance, and the
// point of naming them is that a retune which moves them has to come back here.
//
//   npm run aim -- <boss> --dodge     connect rate and runs per minute
//   section 6 of this file            the fight's own length, against a build
const CONNECT = { bossShark: 0.66, bossOrca: 0.71, bossHammerhead: 0.70, bossMosasaur: 0.60 };
const RUNS_PER_MIN = { bossShark: 12.5, bossOrca: 12.6, bossHammerhead: 14.2, bossMosasaur: 12.0 };
const FIGHT_SECONDS = { 5: 43, 20: 61 };
// A late boss should cost a competent player about a bar — demanding, and
// survivable with what the water gives you back. The opening one should cost a
// quarter of that: it is the fight that teaches you what a boss is.
const BUDGET = { 5: [0.12, 0.40], 20: [0.7, 1.6] };

const fights = passes.map((p) => {
  const bar = p.L === 5 ? 115 : 200;
  const perPass = p.frac * bar;
  const bars = (perPass * RUNS_PER_MIN[p.k] * CONNECT[p.k] * (FIGHT_SECONDS[p.L] / 60)) / bar;
  return { ...p, bars };
});
section('   ...and what a whole fight costs a player who dodges');
for (const L of [5, 20]) {
  const row = fights.filter((f) => f.L === L);
  console.log(`   level ${String(L).padEnd(3)} ${row.map((f) => `${f.k.replace('boss', '')} ${f.bars.toFixed(2)}`).join('  ')}`);
}
for (const L of [5, 20]) {
  const [lo, hi] = BUDGET[L];
  const row = fights.filter((f) => f.L === L);
  ok(row.every((f) => f.bars >= lo && f.bars <= hi),
    `a level-${L} boss costs ${lo}-${hi} bars across the fight — `
    + row.map((f) => `${f.k.replace('boss', '')} ${f.bars.toFixed(2)}`).join(', '));
}
// ...AND THE FOUR ARE WITHIN REACH OF EACH OTHER. They differ in HOW they
// threaten — a hammerhead's pass is quick and shallow, a mosasaur's is slow and
// heavy — and `damageMul` is what holds the totals together across that. One
// archetype costing twice what another does is an accident, not a design.
for (const L of [5, 20]) {
  const row = fights.filter((f) => f.L === L).map((f) => f.bars);
  ok(Math.max(...row) / Math.min(...row) <= 1.35,
    `...and no archetype is more than a third worse than another at level ${L} — `
    + `${Math.min(...row).toFixed(2)} to ${Math.max(...row).toFixed(2)}`);
}
// A pass still has to be a BLOW rather than chip, whatever the fight totals.
ok(passes.every((p) => p.frac >= 0.03),
  `every pass is still a blow and not a drain — smallest ${pct(Math.min(...passes.map((p) => p.frac)))} of the bar`);
ok(passes.every((p) => p.frac <= cap.perSecond + 1e-9),
  `...but never the whole bar: damageCap.perSecond holds every one of them at ${pct(cap.perSecond)}`);

// ---------------------------------------------------------------------------
section('3. SUPER ARMOR — a committed boss is one you move away from');
// ---------------------------------------------------------------------------
const armor = CONFIG.boss.armor ?? {};
// `bossArmor` on every one of these: it is the marker armBossArmor leaves, and
// the multiplier asks for it as well as for `isBoss` so that the exemption and
// the armor cannot disagree. A literal without it is a body whose hp setter was
// never wrapped, which must read 1 — see the last case.
const runner = { isBoss: true, bossArmor: true, lungeStage: 'strike' };
ok(bossArmorMul(runner) < 1, `hitting a committed boss is worth x${bossArmorMul(runner)} of a hit`);
ok(bossArmorMul(runner) > 0,
  'and not zero — a hit that does literally nothing is the wrong teacher, the same '
  + 'argument that turned damageZones from a gate into a grade');
ok(bossArmorMul({ isBoss: true, bossArmor: true }) === 1, 'a boss that is merely swimming takes full damage');
ok(bossArmorMul({ isBoss: true, bossArmor: true, perkDrive: true }) < 1,
  '...and a perk driving the body is committed too');
ok(bossArmorMul({ lungeStage: 'strike', bossArmor: true }) === 1,
  'and NOTHING else in the water gets it — a lunging shark is not armoured');
ok(bossArmorMul({ isBoss: true, lungeStage: 'strike' }) === 1,
  '...nor a boss whose setter was never wrapped — the exemption would be a 6.7x '
  + 'weak-spot hit with no armor behind it');

// ...AND ON A REAL BODY, through the real hp setter. Every assertion above
// reads `bossArmorMul` on a literal, which is a fact about a function and not
// about the game: the armor is spent by a WRAPPER around the creature's hp
// property (armBossArmor), and a wrapper that never got installed, or that got
// installed twice, or that was shadowed by the damage-zone grade, would leave
// every one of those checks green while a lunging boss took full damage.
{
  const scene = new THREE.Scene();
  updateBounds();
  resetEnemies(scene);
  const e = spawnNamed(scene, 'bossShark', 0, { x: 0, y: 0 }, { ignoreCaps: true, overfill: true, boss: true });
  e.isBoss = true;
  armBossArmor(e);

  const bite = (state) => {
    Object.assign(e, { lungeStage: null, perkDrive: false }, state);
    const before = e.hp;
    e.hp -= 1000;
    return before - e.hp;
  };
  const cruising = bite({});
  const running = bite({ lungeStage: 'strike' });
  ok(Math.abs(cruising - 1000) < 1,
    `a cruising boss takes the whole hit through the real setter — ${Math.round(cruising)} of 1000`);
  ok(Math.abs(running - 1000 * (armor.committed ?? 1)) < 1,
    `...and a running one takes ${Math.round(running)} of the same 1000`);

  // Twice-armed is the failure the guard exists for: `isBoss` is cleared and
  // set again on a body still in the water, and a second wrapper would SQUARE
  // the multiplier — 2% instead of 15%, with nothing to say so.
  armBossArmor(e);
  armBossArmor(e);
  ok(Math.abs(bite({ lungeStage: 'strike' }) - running) < 1,
    'arming it three times is worth exactly once — the wrapper cannot square itself');

  // Healing is not an attack. The zone grade makes the same promise for the
  // same reason; this is the half of it that belongs to the armor.
  const healed = (() => {
    e.lungeStage = 'strike';
    const before = e.hp;
    e.hp = before + 500;
    return e.hp - before;
  })();
  ok(Math.abs(healed - 500) < 1, '...and an INCREMENT is ungraded — healing is not an attack');
}

// The exemption, which is the whole design rather than a softener.
const hot = fs.readFileSync(new URL('../path/src/systems/bossHotSpots.js', import.meta.url), 'utf8');
ok(/bossArmorMul\(e\)/.test(hot),
  'a lit weak spot is EXEMPT — hotSpotDamage divides the armor back out, so the '
  + 'answer to a lunge is the spot rather than the flank');
// MEASURED, on a real placed spot, in npm run test:hotspots — that file has the
// model and the placer, and the claim belongs beside them. What is asserted
// here is that the mechanism is still wired; what is asserted there is that a
// spot hit on a running boss lands the same damage as on a cruising one and
// the flank does not.
const hotTest = fs.readFileSync(new URL('boss-hotspot-test.mjs', import.meta.url), 'utf8');
ok(/committed boss as on a cruising one/.test(hotTest),
  '...and npm run test:hotspots measures that end to end, on a placed spot');
// ...and the exemption does not also make the spot FILL faster. `out` is what
// the caller hands the hp setter (armor-compensated) and `landed` is what
// actually lands; the pool wants the second. Crediting `out` — which the first
// draft of this did — would have a spot fill nearly seven times faster during
// a lunge and rupture on a hit worth a seventh of what its pool says it costs.
ok(/spot\.taken \+= landed/.test(hot) && !/spot\.taken \+= out/.test(hot),
  'and the rupture pool is credited what LANDED, not what was handed to the setter');

const critMul = CONFIG.hotSpots?.critMul ?? 2.2;
const gap = critMul / (armor.committed ?? 1);
ok(gap >= 8,
  `...and the gap is worth finding: a spot hit is x${r1(gap)} a body hit during the same run`);

// ---------------------------------------------------------------------------
section('4. ONE DOOR STOPS A BOSS, AND IT IS THE EXPENSIVE ONE');
// ---------------------------------------------------------------------------
const daze = CONFIG.boss?.control?.daze ?? {};
const stag = CONFIG.strike?.weakSpot?.stagger ?? {};
ok(CONFIG.boss?.control?.holdsDaze === false,
  'holds do not daze a boss — seven abilities, six of them free, bought the same '
  + 'window a perfect strike does');
ok(CONFIG.boss?.control?.immune !== false, '...and they are still refused outright, so none of them HOLDS one');
ok(stag.enabled !== false && stag.seconds > 0,
  `a perfect strike into a lit weak spot still stops it — ${stag.seconds}s`);
const stopUptime = stag.seconds / (stag.seconds + (stag.cooldown ?? 0));
// Read off `holdsDaze`, not `daze.enabled`: the mechanism stays on as a debug
// door and its numbers stay tuned — what changed is that nothing reaches it.
const dazeUptime = CONFIG.boss?.control?.holdsDaze !== true
  ? 0 : (daze.max ?? 0) / ((daze.max ?? 0) + (daze.cooldown ?? 0));
console.log(`   ceiling on a fight spent not fighting: ${pct(stopUptime + dazeUptime)}`
  + `  (stagger ${pct(stopUptime)}, daze ${pct(dazeUptime)})`);
ok(stopUptime + dazeUptime <= 0.3,
  `and the ceiling is ${pct(stopUptime + dazeUptime)} of a fight — it was 47%`);

// The cold still lands. A control build is not deleted, it is demoted.
const chillMax = CONFIG.biolum?.elements?.chill?.maxSlow ?? CONFIG.elements?.chill?.maxSlow ?? 0;
ok(chillMax > 0,
  'the chill SLOW is untouched — a Cold Snap build still makes a boss sluggish '
  + `(up to ${pct(chillMax)}), it just cannot stop one`);

// ---------------------------------------------------------------------------
section('5. HOW OFTEN IT COMMITS TO SOMETHING');
// ---------------------------------------------------------------------------
console.log('   boss             wind-up   strike   cooldown   one run every');
const cadence = [];
for (const k of CHASERS) {
  const c = CONFIG.enemies[k].lunge;
  const period = c.windup + c.strikeTime + c.cooldown;
  cadence.push({ k, period });
  console.log(`   ${k.padEnd(16)}${pad(c.windup, 8)}${pad(c.strikeTime, 9)}`
    + `${pad(c.cooldown, 11)}${pad(r1(period) + 's', 15)}`);
}
ok(cadence.every((c) => c.period <= 9),
  `every chasing boss commits at least every ${r1(Math.max(...cadence.map((c) => c.period)))}s`);
ok(cadence.every((c) => c.period >= 5),
  '...and not so often that the tell stops being a tell');

// The six that do not swim have their own committed attack, and every one of
// them is billed as one. The man o' war is the exception ON PURPOSE — it
// drifts and stings, and a lunging jellyfish would be a different creature.
const src = (f) => fs.readFileSync(new URL(`../path/src/systems/${f}`, import.meta.url), 'utf8');
for (const [k, f] of [['bossSquid', 'kraken.js'], ['bossAnglerfish', 'bossAngler.js'], ['bossCrab', 'bossCrab.js']]) {
  ok(/ramming = true/.test(src(f)),
    `${k} has its own committed attack and bills it as one (${f})`);
}

// ---------------------------------------------------------------------------
section('6. THE LADDER, AGAINST A REAL BUILD');
// ---------------------------------------------------------------------------
if (!led || !Object.keys(led.dealt).length) {
  console.log('  SKIP  no playtest/runs.jsonl to read — the shape below is unmeasurable here');
} else {
  console.log(`   ${led.allTaken ? `bosses are ${pct(led.bossTaken / led.allTaken)} of all damage taken` : ''}`
    + `, of which ${pct(led.aimed / Math.max(1, led.aimed + led.contact))} is aimed and the rest is chip`);
  console.log('\n   boss at level   boss hp    your dps     ttk');
  const rows = [];
  for (const L of [5, 10, 15, 20]) {
    const hp = medianHp(L);
    const d = nearest(led.dealt, L);
    if (!d) continue;
    rows.push({ L, hp, d, ttk: hp / d });
    console.log(`   ${pad(L, 12)}${pad(Math.round(hp), 10)}${pad(Math.round(d), 12)}${pad(Math.round(hp / d) + 's', 8)}`);
  }
  const first = rows[0];
  const shorter = rows.filter((r) => r.ttk < first.ttk * 0.95);
  ok(shorter.length === 0,
    shorter.length
      ? `level ${shorter.map((r) => r.L).join(', ')} is a QUICKER kill than the opening boss — raise spawn.bossHp.perLevel`
      : 'no fight in the run is shorter than the opening one — a boss never gets less dangerous');
  ok(rows.every((r) => r.ttk <= 150),
    `...and none of them is a wall — longest ${Math.round(Math.max(...rows.map((r) => r.ttk)))}s`);
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall good\n');
process.exit(fails ? 1 : 0);
