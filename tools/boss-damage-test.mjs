#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bossdamage
//
// WHAT A BOSS IS ALLOWED TO DO TO YOU, and — the half that was missing — what
// each of the two channels it does it through is allowed to do on its own.
//
// The bug this file exists for was invisible to every reading anyone had. The
// boss cap was doing its job: nothing ever exceeded three quarters of the bar
// in a second, exactly as designed, and the game never killed anyone between
// two frames. What it did instead was decide WHICH source got to spend that
// budget, and the answer was always the same one — contact damage arrives as
// `contactDamage * dt`, fifty slices a second, before anything a boss aims can
// land. Measured on the shipped numbers, the shark's contact drain passed the
// entire budget by itself at the second boss of a run, so from that point on
// every barrel, eye beam, volley and pinch in the fight was clipped to zero
// for as long as the player was touching the animal. The fight had one damage
// source wearing eight costumes, and the player's report of it was "I just
// take a ton of damage if I'm touching a boss anywhere".
//
// So the two claims worth failing over are not "is there a ceiling" — there
// always was — but:
//
//   CHIP        overlap is chip and cannot become the fight. Contact is held
//               to `contactPerSecond` no matter how far the run's damage ramp
//               has climbed, and the shared budget still sees it, so the
//               old guarantee is intact.
//
//   HEADROOM    a boss chewing on you at its ceiling leaves room for the
//               things it aims. This is the one that was false, and it is the
//               one that rots: raise `contactPerSecond`, or the boss rows in
//               enemies.csv, far enough and the aimed damage silently stops
//               landing again with nothing on screen to say so.
//
// Plus the two halves of the change that made those possible:
//
//   RAMMING     the three systems that multiply contact for a committed run —
//               the kraken's crush, the anglerfish's strike, the lunge perk —
//               are billed as attacks. Held to the chip ceiling instead, a
//               x3.2 crush is worth exactly as much as brushing a tail fin,
//               which is how the multiplier came to mean nothing.
//
//   BITE        the four bosses that chase have an attack at all. Until
//               `biteDamage`, the megalodon's authored 1.30s bite and the
//               mosasaur's 62 degrees of gape were theatre over a drain that
//               did not care where the animal's head was.
//
// Pure arithmetic against the real CSV and the real config — no scene, no
// creatures, no renderer. capBossDamage is a function of (damage, source,
// maxHp, clock, channel) and nothing else, which is most of why the ceilings
// live at the funnel rather than at the sources.
//
//   node --import ./tools/vite-loader.mjs tools/boss-damage-test.mjs
// ---------------------------------------------------------------------------
import { CONFIG, difficultyRamp } from '../path/src/config.js';
import { capBossDamage, resetBossDamageCap } from '../path/src/systems/boss.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const cap = CONFIG.boss.damageCap;
const HP = CONFIG.player.maxHp;
const FPS = 60;
const DT = 1 / FPS;

// The bosses, off the rows the game actually reads rather than off a list here
// — a new archetype should arrive in this file by existing, not by being
// remembered.
const BOSSES = Object.entries(CONFIG.enemies)
  .filter(([id]) => id.startsWith('boss'))
  .map(([id, def]) => ({ id, def }));

// One second of overlap at a given point in the run, resolved through the funnel
// exactly as combat.js resolves it: a slice per frame, tagged 'contact'.
function contactInOneSecond(def, difficulty, maxHp = HP, t0 = 0) {
  const raw = (def.contactDamage + (def.contactDamagePerDifficulty ?? 0) * difficulty)
    * difficultyRamp('damage', difficulty);
  let took = 0;
  for (let f = 0; f < FPS; f++) {
    took += capBossDamage(raw * DT, 'bossShark', maxHp, t0 + f * DT, 'contact');
  }
  return { raw, took };
}

// --- CHIP ------------------------------------------------------------------
section('OVERLAP IS CHIP');
{
  const ceiling = HP * cap.contactPerSecond;
  // Ten minutes in, where the damage ramp is at 3.2x and climbing to its 4x cap
  // — the point the old single budget had been fully saturated by contact
  // alone for three minutes.
  const difficulty = 600 * CONFIG.spawn.difficultyPerSecond;
  for (const { id, def } of BOSSES) {
    resetBossDamageCap();
    const { raw, took } = contactInOneSecond(def, difficulty);
    check(`${id} cannot chew past the chip ceiling`,
      took <= ceiling + 1e-6,
      `${took.toFixed(1)} taken of ${raw.toFixed(0)} offered, ceiling ${ceiling.toFixed(1)}`);
  }
}
{
  // The ceilings are FRACTIONS of the bar, so a run that has bought health has
  // bought time in the same proportion — the whole reason they are written that
  // way rather than as hit points.
  const difficulty = 600 * CONFIG.spawn.difficultyPerSecond;
  const big = HP + 90; // three Vitality stacks
  resetBossDamageCap();
  const a = contactInOneSecond(CONFIG.enemies.bossShark, difficulty, HP).took / HP;
  resetBossDamageCap();
  const b = contactInOneSecond(CONFIG.enemies.bossShark, difficulty, big).took / big;
  check('the ceiling tracks the bar, not a number of hit points',
    Math.abs(a - b) < 1e-6, `${(a * 100).toFixed(1)}% of a ${HP}hp bar, ${(b * 100).toFixed(1)}% of a ${big}hp one`);
}
{
  // WHERE THE CSV STOPS AND THE CEILING TAKES OVER, in run seconds, for each
  // boss. Reported rather than pinned, because the crossover is the shape of
  // the tuning and not a target: the authored number is what a player feels in
  // their first fight or two, and the ceiling is what they feel afterwards.
  //
  // The floor is the claim. A boss row raised far enough that its contact is
  // already at the ceiling on the frame it spawns is a row nobody can edit —
  // every value above the line behaves identically — and that is the state the
  // whole file is here to stop coming back.
  const ceiling = HP * cap.contactPerSecond;
  const rate = CONFIG.spawn.ramp.damage;
  const perSec = CONFIG.spawn.difficultyPerSecond;
  const FLOOR = 40;
  for (const { id, def } of BOSSES) {
    const base = def.contactDamage;
    const at = base >= ceiling ? 0 : Math.log(ceiling / base) / Math.log(1 + rate) / perSec;
    check(`${id}'s authored contact is the number for a while`,
      at >= FLOOR,
      `${base} dps authored, at the ${ceiling.toFixed(1)} ceiling from ${at.toFixed(0)}s into a run`);
  }
}

// --- HEADROOM --------------------------------------------------------------
section('AN AIMED ATTACK STILL LANDS THROUGH THE CHEWING');
{
  const difficulty = 600 * CONFIG.spawn.difficultyPerSecond;
  const raw = (CONFIG.enemies.bossShark.contactDamage) * difficultyRamp('damage', difficulty);
  // A full second of overlap, and a shell arriving on the last frame of it —
  // the worst case for the attack, and the case that used to deal zero.
  resetBossDamageCap();
  let chewed = 0;
  for (let f = 0; f < FPS; f++) chewed += capBossDamage(raw * DT, 'bossShark', HP, f * DT, 'contact');
  const shell = capBossDamage(40, 'boss:boatRain', HP, (FPS - 1) * DT, 'attack');
  check('a shell lands while the player is being chewed on',
    shell > 0, `${shell.toFixed(1)} of 40 offered, after ${chewed.toFixed(1)} of contact that second`);
  check('...and it is most of what was aimed, not a token',
    shell >= HP * cap.perHit - 1e-6,
    `${shell.toFixed(1)}, per-hit ceiling ${(HP * cap.perHit).toFixed(1)}`);
  const room = HP * cap.perSecond - HP * cap.contactPerSecond;
  check('the fight keeps at least half the bar per second for aimed damage',
    room >= HP * 0.5, `${room.toFixed(1)} of the ${(HP * cap.perSecond).toFixed(1)} budget`);
}
{
  // The old guarantee, unchanged: contact still spends from the shared budget,
  // so nothing about the split lets a boss deal MORE in a second than before.
  const difficulty = 600 * CONFIG.spawn.difficultyPerSecond;
  const raw = CONFIG.enemies.bossMosasaur.contactDamage * difficultyRamp('damage', difficulty);
  resetBossDamageCap();
  let total = 0;
  for (let f = 0; f < FPS; f++) {
    total += capBossDamage(raw * DT, 'bossMosasaur', HP, f * DT, 'contact');
    total += capBossDamage(999, 'boss:barrels', HP, f * DT, 'attack');
  }
  check('everything together still cannot pass the shared budget',
    total <= HP * cap.perSecond + 1e-6,
    `${total.toFixed(1)} of ${(HP * cap.perSecond).toFixed(1)} in one second`);
  check('...and a boss cannot end a full run in a second',
    total < HP, `${total.toFixed(1)} against a ${HP}hp bar`);
}

// --- RAMMING ---------------------------------------------------------------
section('A COMMITTED RUN IS AN ATTACK, NOT OVERLAP');
{
  const difficulty = 600 * CONFIG.spawn.difficultyPerSecond;
  const base = CONFIG.enemies.bossSquid.contactDamage * difficultyRamp('damage', difficulty);
  const crush = base * (CONFIG.kraken.crush.damage ?? 3.2);
  const dur = CONFIG.kraken.crush.duration ?? 0.8;
  const frames = Math.round(dur * FPS);
  const bill = (channel) => {
    resetBossDamageCap();
    let took = 0;
    for (let f = 0; f < frames; f++) took += capBossDamage(crush * DT, 'bossSquid', HP, f * DT, channel);
    return took;
  };
  const asAttack = bill('attack');
  const asChip = bill('contact');
  check('the kraken\'s crush is worth more than brushing it',
    asAttack > asChip * 1.5,
    `${asAttack.toFixed(1)} billed as an attack against ${asChip.toFixed(1)} billed as chip`);
  check('...and it is a real bite of the bar',
    asAttack >= HP * 0.25, `${asAttack.toFixed(1)} over ${dur}s of a ${HP}hp bar`);
}

// --- BITE ------------------------------------------------------------------
section('THE BOSSES THAT CHASE HAVE AN ATTACK');
{
  // WHICH ARCHETYPES NEED A BITE, derived rather than listed. `hunt` plus
  // `behavior: 'hunt'` is what builds the jaw and gates the snap in
  // entities/enemies.js — but that alone catches the anglerfish, which carries
  // the flag and barely hunts, and which already HAS an attack: its ambush
  // lunge (systems/bossAngler.js), billed against the fight's budget through
  // `ramming`. Same for the kraken's crush, the crab's pinch and the boats'
  // ordnance, each of which announces itself with a flag its own system reads.
  //
  // So the rule is: a boss that chases you and has no system of its own must
  // bite, because contact is the only other thing it could possibly do to you
  // — and "the only thing it does is contact" is the state this whole change
  // exists to end. A new archetype arrives here by existing.
  const armed = ({ def }) => def.ambushBoss || def.inkBoss || def.surfaceBoss || def.claw;
  const chasers = BOSSES.filter((b) => b.def.hunt && b.def.behavior === 'hunt' && !armed(b));
  check('there are chasing bosses to check', chasers.length > 0, `${chasers.length} found`);
  {
    // ...and nothing that already has an attack quietly grew a second one.
    const doubled = BOSSES.filter((b) => armed(b) && (b.def.biteDamage ?? 0) > 0);
    check('a boss with its own attack does not also bite', doubled.length === 0,
      doubled.length ? doubled.map((b) => b.id).join(', ') : 'each armed boss has exactly one');
  }
  for (const { id, def } of chasers) {
    check(`${id} bites`, (def.biteDamage ?? 0) > 0, `biteDamage ${def.biteDamage ?? 'blank'}`);
  }
  for (const { id, def } of chasers) {
    if (!(def.biteDamage > 0)) continue;
    // AS AUTHORED: a snap is worth more than the contact it interrupts, or the
    // player cannot tell the two apart and we are back where we started. Both
    // sides ride the same run ramp, so comparing the raw rows compares them at
    // every point in a run at once.
    const cd = def.hunt?.biteCooldown ?? CONFIG.bite.cooldown ?? 1;
    const chip = def.contactDamage * cd;
    check(`${id}'s bite reads as bigger than the chewing`,
      def.biteDamage > chip,
      `${def.biteDamage} a snap against ${chip.toFixed(1)} of contact over the same ${cd}s`);
  }
  {
    // AT THE CEILINGS: the same claim once the run ramp has pinned both
    // channels, which is where a fight spends most of its life. This one is
    // pure config — `perHit` against a bite cooldown of `contactPerSecond` —
    // and it is the reason contactPerSecond is 0.15 rather than the 0.25 this
    // change started with. At 0.25 a capped bite was worth LESS than the
    // second of chewing it landed amongst, and no CSV number could fix that.
    const slowest = Math.max(...chasers.map(({ def }) =>
      def.hunt?.biteCooldown ?? CONFIG.bite.cooldown ?? 1));
    const snap = HP * cap.perHit;
    const chewed = HP * cap.contactPerSecond * slowest;
    check('a capped bite still beats a capped second of chewing',
      snap > chewed,
      `${snap.toFixed(1)} a snap against ${chewed.toFixed(1)} of contact over the longest cooldown (${slowest}s)`);
  }
  for (const { id, def } of chasers) {
    if (!(def.biteDamage > 0)) continue;
    // ...and the jaws are not the whole fight. Sustained, at the per-hit
    // ceiling, a bite has to leave the shared budget room for everything else
    // the boss brought — the perk it rolled, and the chewing itself.
    const cd = def.hunt?.biteCooldown ?? CONFIG.bite.cooldown ?? 1;
    const dps = Math.min(def.biteDamage, HP * cap.perHit) / cd;
    const room = HP * cap.perSecond - HP * cap.contactPerSecond;
    check(`${id}'s bite leaves room for the rest of the fight`,
      dps <= room * 0.5,
      `${dps.toFixed(1)} dps sustained of the ${room.toFixed(1)} left for aimed damage`);
  }
}

// --- WILDLIFE --------------------------------------------------------------
section('ORDINARY WILDLIFE IS UNTOUCHED');
{
  resetBossDamageCap();
  let took = 0;
  for (let f = 0; f < FPS; f++) took += capBossDamage(60 * DT, 'barracuda', HP, f * DT, 'contact');
  check('a school can still chew through the bar', Math.abs(took - 60) < 1e-6,
    `${took.toFixed(1)} of 60 offered — the answer to a school is to move`);
  const wild = Object.entries(CONFIG.enemies)
    .filter(([id, def]) => !id.startsWith('boss') && (def.biteDamage ?? 0) > 0);
  check('no wildlife row grew a bite by accident', wild.length === 0,
    wild.length ? wild.map(([id]) => id).join(', ') : 'every biteDamage is on a boss');
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
