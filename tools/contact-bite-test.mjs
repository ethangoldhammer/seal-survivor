#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:contactbite
//
// A PACK THAT BITES INSTEAD OF CHEWING — `contactBite` in enemies.csv, resolved
// in systems/combat.js.
//
// Contact damage has always been a per-second DRAIN, and a drain is bounded by
// being a rate: however long you spend inside a shark, it costs what the row
// says per second and no more. That bound is per ANIMAL, though, and nothing
// in the game noticed. Five barracuda overlapping the seal each bill their own
// 32/s, and 160/s takes a 115-point bar to zero in seven tenths of a second —
// with no single moment in it the player could point at, because nothing
// discrete happened. It was the fastest death in the game and it was invisible.
//
// So a species may now declare `contactBite`: the same damage, delivered as one
// whole number every N seconds on the 'strike' channel, which is the i-frame
// window at the top of onPlayerHit. That makes the pack share a ceiling.
//
// Two rows carry it — the barracuda, which arrives in threes to fives at minute
// one, and the sailfish, which comes in twos and whose period is its own
// authored strike. Every driven section below runs off the roster rather than
// off a list here, so the second species arrived in this file by existing.
//
// The four claims worth failing over:
//
//   SOLO IS UNCHANGED  the number on the row is damage per SECOND and stays
//                      that way — the bite is `contactDamage x contactBite`,
//                      so one barracuda is exactly as dangerous as it was and
//                      the run's damage ramp still applies to the number it
//                      always did. This is the one that rots: retune the
//                      damage or the period without the other and the species
//                      quietly changes tier.
//
//   THE PACK IS HELD   five of them cannot bill five times. The ceiling is one
//                      bite per i-frame window, and it has to be measured
//                      against a CONTROL RUN of the same pack with the cell
//                      cleared, because "less than before" is the whole claim
//                      and an absolute number could drift into agreement with
//                      a bug.
//
//   THE PERIOD IS LEGAL  a period under CONFIG.player.hitIFrames means a solo
//                      hunter's own bites start being refused — a silent nerf
//                      wearing a rhythm change's clothes. Checked for every row
//                      in the file, not just the one that has it today.
//
//   THE DRAIN SURVIVES a blank cell is nearly the whole roster and must be
//                      untouched. A body you are inside should keep costing
//                      what it costs, in slices, with no window: refusing a
//                      drain in bursts reads as the damage flickering rather
//                      than as the player being safe.
//
// Driven, not computed. The real resolveCombat, on real spawned creatures, with
// the i-frame gate re-stated from main.js exactly as tools/boss-grab-test.mjs
// re-states it and for the same reason — main.js builds a whole game at import
// time and cannot be imported, so the four lines are copied and then EXERCISED.
//
//   node --import ./tools/vite-loader.mjs tools/contact-bite-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG, difficultyRamp } from '../path/src/config.js';
import { updateBounds } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { resolveCombat } from '../path/src/systems/combat.js';

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]')
    || msg.startsWith('[feedback]'))) return;
  realWarn(msg, ...rest);
};

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const note = (t) => console.log(`        ${t}`);

updateBounds(16 / 9);
initPlayer(scene);

const W = CONFIG.player.hitIFrames ?? 0;
// THE WINDOW A BITE ARMS, which is the one every pack figure in this file is
// against — `hitIFrames` above is what a telegraphed blow arms and is only the
// floor here. Read separately rather than assumed equal: they were the same
// number for exactly one day, and every ceiling below would have gone on
// quietly passing against the wrong one.
const BW = Math.max(W, CONFIG.player.biteIFrames ?? 0);

// A run of overlapping bodies, resolved through the real combat pass.
//
// The creatures are PINNED to the seal after each updateEnemies rather than
// left to swim: what is being measured is the billing rhythm of a body in
// contact, and a barracuda at speed 9 with two units of variance would spend a
// different fraction of the run touching you on every run of this file. Their
// clocks still tick in updateEnemies, which is the point of calling it —
// `contactBiteTimer` lives there beside every other per-creature timer, and a
// harness that ticked it itself would be testing its own arithmetic.
//
// The i-frame gate is main.js's, restated. `strike` is refused inside the
// window and arms it; everything else is billed as it comes.
function run(type, count, seconds, dmg = null) {
  resetEnemies(scene);
  resetPlayer();
  player.invuln = 0;
  player.mesh.position.set(0, 0, 0);

  const l = { total: 0, hits: [], channels: new Set() };
  const hooks = {
    // Returns what it billed, the way main.js's does — 0 for a blow the window
    // refused. A harness that returned nothing would leave every bitten
    // creature's clock stalled and would quietly test the opposite feature.
    onPlayerHit: (dmg, dir, source = '?', channel = 'attack', iFrames = 0) => {
      if (channel === 'strike') {
        if (player.invuln > 0) return 0;
        // `iFrames` is the source asking for a longer window, folded in with a
        // Math.max exactly as main.js folds it — so it can only lengthen. A
        // harness that dropped the argument would measure the pack against a
        // 0.4s window the game no longer uses and pass while reporting numbers
        // nobody plays.
        player.invuln = Math.max(W, player.stats?.invulnAfterHit ?? 0, iFrames ?? 0);
      }
      l.total += dmg;
      l.hits.push(dmg);
      l.channels.add(channel);
      return dmg;
    },
    onEnemyKilled: () => {},
  };

  for (let i = 0; i < count; i++) spawnNamed(scene, type, 0, 0, { ignoreCaps: true, overfill: true });
  l.spawned = enemies.length;
  // LATE IN A RUN, without running fifteen minutes of one. `e.contactDamage` is
  // baked per instance at spawn from the row and the roster damage ramp, and
  // combat.js reads that and not the def — so writing it here is exactly what
  // minute fifteen hands the same code, and not a shortcut around it.
  if (dmg != null) for (const e of enemies) e.contactDamage = dmg;
  // Whatever the row says this individual's damage is, baked at spawn. Read off
  // the creature rather than off the def so a per-instance ramp cannot make
  // this file's arithmetic disagree with the game's.
  l.each = enemies[0]?.contactDamage ?? 0;

  for (let f = 0; f < Math.round(seconds / dt); f++) {
    updateEnemies(dt, scene, player.mesh.position, () => {}, () => {});
    for (const e of enemies) e.mesh.position.set(0, 0, 0);
    resolveCombat(dt, scene, hooks);
    if (player.invuln > 0) player.invuln -= dt;
  }
  return l;
}

// The same run with the cell cleared — the drain this replaced. Restored in a
// finally, because it is the live CONFIG the rest of the file reads.
function control(type, count, seconds, dmg = null) {
  const def = CONFIG.enemies[type];
  const had = def.contactBite;
  delete def.contactBite;
  try { return run(type, count, seconds, dmg); } finally { def.contactBite = had; }
}

// ===========================================================================
section('EVERY PERIOD ON THE ROSTER IS LEGAL');
// ===========================================================================
{
  check('there is an i-frame window to hang this on', W > 0, `${W}s`);
  check('...and a bite holds it open longer than a telegraphed blow does',
    BW > W, `${BW}s against the standard ${W}s`);

  // THE WINDOW'S OWN CEILING, and it is the quiet half of this pair. The window
  // is the only lever on what a PACK costs — a group is held to one bite per
  // window — so the temptation whenever a pack reads as too strong is to keep
  // lengthening it. Past the shortest period on the roster it stops being a
  // pack fix: a single animal's next bite starts landing inside the window its
  // own last bite armed, and is refused. That is a nerf to the solo creature
  // wearing a pack fix's clothes, and nothing on screen would say so.
  const shortest = Math.min(...Object.values(CONFIG.enemies)
    .map((d) => d.contactBite ?? Infinity));
  check('the bite window cannot outlast the shortest bite on the roster',
    BW <= shortest,
    `${BW}s window against a ${shortest}s period — at or past it a lone hunter `
    + `starts refusing its own bites`);
  check('...and leaves a margin, so a pack is still worse than one fish',
    BW < shortest,
    `${(shortest / BW).toFixed(2)}x — at exactly ${shortest}s a pack would cost `
    + `precisely what a single animal costs`);

  const biters = Object.entries(CONFIG.enemies).filter(([, d]) => (d.contactBite ?? 0) > 0);
  check('at least one species bites', biters.length > 0,
    biters.map(([id, d]) => `${id} ${d.contactBite}s`).join(', ') || 'none');

  // THE FLOOR, and it is the quiet one. A period under the window means the
  // creature's own second bite lands while the window its first bite armed is
  // still up, so it is refused — a solo hunter losing damage it used to deal,
  // with nothing to say so but the health bar going down slower.
  for (const [id, d] of biters) {
    check(`${id}'s period clears the window`, d.contactBite >= BW,
      `${d.contactBite}s against the ${BW}s window a bite arms`);
  }

  // ...and every biter still has to say what it is worth per second, because
  // that is the number the bite is derived from.
  for (const [id, d] of biters) {
    check(`${id} still carries a contactDamage`, (d.contactDamage ?? 0) > 0, `${d.contactDamage}`);
  }
}

// ===========================================================================
// EVERY BITER, DRIVEN — one of it, then a pack of it, against a control run of
// itself with the cell cleared.
//
// Run off the roster rather than off a list here: a species that gets the
// column tomorrow arrives in this file by existing. Which is not cosmetic —
// the sailfish was added a day after the barracuda and every claim below
// applied to it unchanged, which is the evidence the mechanism is a mechanism
// and not one creature's special case.
// ===========================================================================
for (const [id, def] of Object.entries(CONFIG.enemies).filter(([, d]) => (d.contactBite ?? 0) > 0)) {
  const SECONDS = 10;
  const period = def.contactBite;
  const PACK = def.group?.max ?? 3;

  section(`ONE ${id.toUpperCase()} IS EXACTLY AS DANGEROUS AS IT WAS`);

  const l = run(id, 1, SECONDS);
  const c = control(id, 1, SECONDS);
  check('it spawned', l.spawned === 1, `${l.spawned} in the water`);

  // Within one bite of the drain it replaces — the run cannot end mid-period,
  // so the two can only ever differ by whatever the last partial window held.
  const bite = l.each * period;
  check('ten seconds of contact costs what ten seconds of contact cost',
    Math.abs(l.total - c.total) <= bite * 1.05,
    `${l.total.toFixed(1)} biting against ${c.total.toFixed(1)} draining, `
    + `${l.each}/s x ${SECONDS}s = ${(l.each * SECONDS).toFixed(0)}`);

  // ...AS WHOLE NUMBERS. This is the half the player sees: the drain paid out
  // 600 slices over ten seconds and none of them was worth a flash.
  check('it arrives as bites, not as slices',
    Math.abs(l.hits.length - Math.floor(SECONDS / period)) <= 1,
    `${l.hits.length} bites in ${SECONDS}s, one per ${period}s`);
  check('...and the drain still arrives as slices', c.hits.length > SECONDS / dt * 0.9,
    `${c.hits.length} slices in ${SECONDS}s`);
  check('each bite is the row\'s damage times its period',
    l.hits.every((h) => Math.abs(h - bite) < 1e-6),
    `${bite.toFixed(1)} a bite, ${(bite / CONFIG.player.maxHp * 100).toFixed(0)}% of a starting bar`);
  check('and it rides the i-frame channel', l.channels.size === 1 && l.channels.has('strike'),
    [...l.channels].join(', '));

  section(`A PACK OF ${PACK} CANNOT BILL ${PACK} TIMES`);

  const p = run(id, PACK, SECONDS);
  const pc = control(id, PACK, SECONDS);
  check('the pack spawned', p.spawned === PACK, `${p.spawned} ${id}`);

  // THE CEILING, and it is the whole feature: one bite per window, whoever is
  // swinging. A little slack for the partial window the run ends inside.
  const ceiling = bite / BW * SECONDS;
  check('the pack is held to one bite per window', p.total <= ceiling * 1.05,
    `${p.total.toFixed(0)} over ${SECONDS}s against a ${ceiling.toFixed(0)} ceiling `
    + `(${(p.total / SECONDS).toFixed(0)}/s)`);

  // AGAINST THE CONTROL, which is the claim in the terms the bug was reported
  // in. Nothing absolute here — if both numbers move together the feature is
  // still doing its job.
  check('and it is a fraction of what the drain billed', p.total < pc.total * 0.75,
    `${p.total.toFixed(0)} against ${pc.total.toFixed(0)} draining — `
    + `${(pc.total / CONFIG.player.maxHp / SECONDS).toFixed(1)} bars a second became `
    + `${(p.total / CONFIG.player.maxHp / SECONDS).toFixed(1)}`);
  note(`a ${CONFIG.player.maxHp}hp seal survived ${(CONFIG.player.maxHp / (p.total / SECONDS)).toFixed(1)}s `
    + `in the pack, against ${(CONFIG.player.maxHp / (pc.total / SECONDS)).toFixed(1)}s before`);

  // ...AND STILL WORSE THAN ONE OF THEM, BY THE RIGHT FACTOR. A ceiling that
  // flattened the pack to a single animal would have deleted the encounter
  // rather than paced it, and this is not a hypothetical: the first cut of the
  // feature spent a fish's bite clock whether or not the window paid the bite,
  // so five clocks that expired together all reset together and the pack never
  // fell out of phase. It measured 504 against 504 — five barracuda billing
  // EXACTLY what one did, which every other check in this section passed.
  //
  // The factor is the arithmetic of the two clocks: a solo fish is gated by its
  // own period, a pack by the window, so the pack is worth period/window times
  // one of them. Anything at 1.0 is the lockstep bug back.
  const factor = p.total / l.total;
  check('a pack is worth about period/window of one of them',
    factor >= (period / BW) * 0.8,
    `x${factor.toFixed(2)} against a x${(period / BW).toFixed(2)} ceiling — `
    + `x1.00 would be the whole pack in lockstep`);
}

// ===========================================================================
section('A BITE ON A COMMITTED PASS LANDS ON THE PASS\'S OWN CLOCK');
// ===========================================================================
//
// The sailfish is the one creature here whose attack was already authored: a
// 0.45s tell, a committed 0.8s run down a line it showed you, then 3.2s of dead
// time. Its period is `lunge.strikeTime` and nothing else — a bite on any other
// clock would be a second rhythm playing over the one the player is reading,
// drifting in and out of the animation that is supposed to be the warning.
//
// The two live in different blocks of the same def and neither mentions the
// other, which is exactly the shape that goes quietly wrong: retune the strike
// and the bite stays where it was, still passing every check above, just no
// longer landing on the pass. This is the only thing that would notice.
{
  const lungers = Object.entries(CONFIG.enemies)
    .filter(([, d]) => (d.contactBite ?? 0) > 0 && d.lunge?.strikeTime > 0);
  check('at least one biter commits to a pass', lungers.length > 0,
    lungers.map(([id]) => id).join(', ') || 'none');
  for (const [id, d] of lungers) {
    check(`${id}'s bite is its strike`, d.contactBite === d.lunge.strikeTime,
      `${d.contactBite}s bite against a ${d.lunge.strikeTime}s run — if the strike was `
      + `retuned deliberately, move the bite with it rather than loosening this`);
  }
}

// ===========================================================================
section('NO ONE BITE CAN END A RUN FROM FULL HEALTH');
// ===========================================================================
//
// THE HALF A DRAIN NEVER NEEDED. Being inside a creature costs per second, so
// however far the roster damage ramp has climbed you can leave partway through
// and pay only for the time you spent. One whole number has no partway — and
// this shipped without noticing: measured on the real ramp, a barracuda's bite
// passed a full starting bar at minute eight and reached 314, nearly three
// bars, by minute fifteen. Every check above still passed, because every one of
// them is a statement about a RATIO and the cap is the only absolute claim in
// the file.
//
// Driven at a late-run `contactDamage` rather than computed, because the cap is
// applied at the call site in combat.js and a test that recomputed the Math.min
// here would agree with itself about a line nobody ran.
{
  const capFrac = CONFIG.player.contactBiteCap ?? 1;
  const HP = CONFIG.player.maxHp;
  check('there is a ceiling on one bite', capFrac > 0 && capFrac < 1, `${capFrac} of the bar`);
  check('...and it ranks below a boss\'s aimed attack',
    capFrac < CONFIG.boss.damageCap.perHit,
    `${capFrac} against a boss's ${CONFIG.boss.damageCap.perHit} perHit — a fish brushing `
    + `past you does not get to hit as hard as a barrel a boss threw`);
  check('...so a bite cannot kill from full', capFrac < 1,
    `${(1 / capFrac).toFixed(1)} bites from a full bar at worst`);

  // The measured ramp figure, not a round number: x14 is where spawn.ramp.damage
  // caps, which is what every creature in the game is worth by minute 12.5.
  const ramped = CONFIG.enemies.barracuda.contactDamage * difficultyRamp('damage', 15 * 60 * CONFIG.spawn.difficultyPerSecond);
  const l = run('barracuda', 1, 6, ramped);
  const biggest = Math.max(...l.hits);
  check('a minute-fifteen barracuda still cannot one-shot you',
    biggest < player.stats.maxHp,
    `${biggest.toFixed(0)} against a ${player.stats.maxHp} bar — uncapped this bite is `
    + `${(ramped * CONFIG.enemies.barracuda.contactBite).toFixed(0)}, ${(ramped * CONFIG.enemies.barracuda.contactBite / HP).toFixed(1)} bars`);
  check('...because every bite is held to the ceiling',
    l.hits.every((h) => h <= capFrac * player.stats.maxHp + 1e-6),
    `${biggest.toFixed(1)} a bite, ceiling ${(capFrac * player.stats.maxHp).toFixed(1)}`);

  // AND THE CEILING SCALES WITH THE SEAL. A flat number would mean a player who
  // spent a run buying health got the same absolute bite as one who did not,
  // which is the upgrade quietly doing less the longer you play.
  check('the ceiling is a fraction of the bar, not a number',
    /contactBiteCap[\s\S]{0,200}?player\.stats\?\.maxHp/.test(
      (await import('node:fs')).readFileSync(new URL('../path/src/systems/combat.js', import.meta.url), 'utf8')),
    'systems/combat.js reads player.stats.maxHp');

  // ...AND IT IS A CEILING, NOT THE DAMAGE. Everything under it is untouched, so
  // the opening minutes are exactly the row's own numbers.
  const early = run('barracuda', 1, 6);
  check('an early-run bite is not touched by it',
    early.hits.every((h) => h < capFrac * player.stats.maxHp),
    `${Math.max(...early.hits).toFixed(1)} a bite at the row's own damage, under the `
    + `${(capFrac * player.stats.maxHp).toFixed(1)} ceiling`);
}

// ===========================================================================
section('THE DRAIN IS UNTOUCHED FOR EVERYTHING ELSE');
// ===========================================================================
//
// Chosen out of the roster rather than named, so this keeps testing a real
// draining creature after somebody retunes the one that used to be here.
{
  const SECONDS = 4;
  const [id, def] = Object.entries(CONFIG.enemies).find(([k, d]) =>
    !k.startsWith('boss') && d.behavior === 'chase' && !(d.contactBite > 0)
    && (d.contactDamage ?? 0) > 0 && !d.invincible) ?? [];

  check('the roster still has a draining chaser to check', !!id, id ?? 'none found');
  if (id) {
    const l = run(id, 1, SECONDS);
    check(`${id} still bills its rate per second`,
      Math.abs(l.total - l.each * SECONDS) < l.each * 0.05,
      `${l.total.toFixed(1)} over ${SECONDS}s at ${l.each}/s`);
    check('...in slices, with no window', l.hits.length > SECONDS / dt * 0.9,
      `${l.hits.length} slices`);
    check('...on the contact channel', l.channels.has('contact') && !l.channels.has('strike'),
      [...l.channels].join(', '));
    note(`${def.contactDamage}/s of overlap, unchanged — a rate is its own limit`);
  }
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
