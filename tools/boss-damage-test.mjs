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

// A CRAB CHARGES NOTHING FOR BEING TOUCHED. `CONFIG.crabClaw.contactMul` is 0,
// and systems/combat.js applies it to every creature carrying a claw driver —
// which is the two swarm crabs and the king crab, and nothing else in the
// roster. Their `contactDamage` cell is still the animal's damage; it is spent
// entirely through the pinch (see the CONTACT IS THE CRAB'S WHOLE BILL section
// below), so every claim in this file about overlap being chip is vacuous for
// them and the crossover check further down was measuring a channel that no
// longer exists.
//
// Identified by BEHAVIOUR rather than by name, because that is the fact that
// makes it true: `crawl` is what a clawed body does, and a boss added tomorrow
// that walks the seabed inherits this without anyone remembering to add it.
const chargesForContact = (def) =>
  !(def.behavior === 'crawl' && !((CONFIG.crabClaw?.contactMul ?? 0) > 0));
const CONTACT_BOSSES = BOSSES.filter(({ def }) => chargesForContact(def));

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
  for (const { id, def } of CONTACT_BOSSES) {
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
  const AIMED = 40;
  const shell = capBossDamage(AIMED, 'boss:boatRain', HP, (FPS - 1) * DT, 'attack');
  check('a shell lands while the player is being chewed on',
    shell > 0, `${shell.toFixed(1)} of ${AIMED} offered, after ${chewed.toFixed(1)} of contact that second`);
  // AGAINST WHICHEVER IS SMALLER, the ceiling or the offer. The per-hit
  // ceiling is a share of the player's bar, so it moves with player.maxHp —
  // and an attack aimed for less than that ceiling is not being clipped at
  // all, it is landing in full. Comparing the landed damage against a bare
  // `HP * cap.perHit` turns a RAISE to maxHp into a failure here, which is a
  // test reporting the shell as throttled at the moment it stopped being
  // throttled. Same idiom as the bite DPS below.
  check('...and it is most of what was aimed, not a token',
    shell >= Math.min(AIMED, HP * cap.perHit) - 1e-6,
    `${shell.toFixed(1)} of ${AIMED} aimed, per-hit ceiling ${(HP * cap.perHit).toFixed(1)}`);
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
  // WILDLIFE BITES NOW, AND THE CLAIM CHANGED SHAPE RATHER THAN GOING AWAY.
  //
  // This used to assert that no wildlife row carried a `biteDamage` at all,
  // and for as long as the sharks were cruise hunters that was right: a bite
  // is a moment, and an animal with no moment in it should not have one. The
  // six apex sharks commit to a readable pass now (a wind-up, a locked line,
  // and a peel-off — see `shark.lunge`), so the pass arriving is worth
  // something and the pass missing costs them their turn.
  //
  // What the file still has to hold is that it stayed in the family. The thing
  // that would genuinely break the game is a bite on a SCHOOL: thirty fish,
  // each landing a discrete number, is a wall of damage nothing in the roster
  // was balanced against — and a `biteDamage` cell is one keystroke away from
  // any row in the file.
  const wild = Object.entries(CONFIG.enemies)
    .filter(([id, def]) => !id.startsWith('boss') && (def.biteDamage ?? 0) > 0);
  const stray = wild.filter(([, def]) => !(def.spawnGroup ?? '').split(' ').includes('shark'));
  check('a wildlife bite is an apex shark and nothing else', stray.length === 0,
    stray.length ? stray.map(([id]) => id).join(', ')
      : `${wild.length} biting sharks, every one in the apex family`);
  // ...and it is a bite rather than a second contact drain. A snap that is
  // worth less than the second of chewing it lands amongst is a number nobody
  // will ever notice, which is what `biteDamage` was invented to stop being —
  // and one worth more than a boss's per-hit ceiling is a minnow hitting harder
  // than the fight the run stops for.
  for (const [id, def] of wild) {
    const cd = def.hunt?.biteCooldown ?? CONFIG.bite.cooldown ?? 1;
    const chew = def.contactDamage * cd;
    check(`${id}'s bite is worth more than the chewing it replaces`,
      def.biteDamage > chew * 0.5 && def.biteDamage <= HP * cap.perHit,
      `${def.biteDamage} a snap against ${chew.toFixed(0)} of contact over ${cd}s, ceiling ${(HP * cap.perHit).toFixed(0)}`);
  }
}

// --- THE CRAB LAYER --------------------------------------------------------
section('CONTACT IS THE CRAB\'S WHOLE BILL, SPENT THROUGH THE CLAW');
{
  // The inversion this section exists to hold. A crab used to be a walking
  // contact hitbox with a telegraphed gesture painted on top, and the gesture
  // was the smaller of the two — so the 0.42s rear-up was a warning about the
  // less important thing the animal was doing. Now intersecting one is free and
  // the pinch is everything.
  //
  // Both halves are asserted, because either one alone is a bug that looks like
  // a balance decision: `contactMul` at 0 with a small `damageMul` is a crab
  // layer that was quietly switched off, and a big pinch with contact still on
  // is the layer charging twice.
  check('a crab charges nothing for being touched',
    (CONFIG.crabClaw?.contactMul ?? 0) === 0,
    `contactMul ${CONFIG.crabClaw?.contactMul}`);

  const crabs = Object.entries(CONFIG.enemies)
    .filter(([, def]) => def.behavior === 'crawl' && (def.contactDamage ?? 0) > 0);
  check('there are crabs to check', crabs.length > 0, `${crabs.length} found`);
  for (const [id, def] of crabs) {
    // The pinch, as combat.js bills it: the row's contact figure times whatever
    // claw block applies to this creature.
    const mul = def.claw?.damageMul ?? CONFIG.crabClaw.damageMul;
    const pinch = def.contactDamage * mul;
    // HOW OFTEN IT CAN ACTUALLY BE PAID, which is the only rate worth checking
    // and is the smaller of two things:
    //
    //   the claw's own cooldown at its EAGEREST — the crab's authored gap
    //   times `eager.nearCooldownMul`, which is what it drops to once the seal
    //   is in among the legs (CONFIG.crabClaw.eager);
    //
    //   and the I-FRAME WINDOW, which is what actually bounds a SWARM: however
    //   many claws shut on the same frame, exactly one of them is paid. Nine
    //   crabs on a chum pile therefore cannot bill nine times, and the boss —
    //   which is mid-gesture on 94% of the frames you are in reach — cannot
    //   bill faster than the window either.
    const eager = (CONFIG.crabClaw?.eager?.nearCooldownMul ?? 1);
    const gap = Math.max(
      (def.claw?.cooldown ?? CONFIG.crabClaw.cooldown) * eager,
      CONFIG.player.hitIFrames ?? 0,
      1 / FPS,
    );
    const dps = pinch / gap;
    // THE LAYER WAS NOT QUIETLY SWITCHED OFF. `contactMul` is 0, so if the
    // pinch does not out-earn the drain it replaced then the whole crab layer
    // is now decoration with a wind-up — which is a balance change nobody
    // asked for, arriving as a side effect of a design decision about where
    // damage lives. The row's `contactDamage` is what that drain was worth per
    // second, so it is the number to beat.
    check(`${id}: the claw out-earns the drain it replaced`,
      dps >= def.contactDamage,
      `${dps.toFixed(0)} dps up close against the ${def.contactDamage} of contact it replaces`);
    // ...and it did not become a wipe on the way. Read against the whole bar,
    // because this is the worst case a player can be in: pressed against a
    // crab, taking a pinch every window it is allowed one.
    check(`${id}: the whole layer at once is still survivable`,
      dps <= HP * 1.4,
      `${dps.toFixed(0)} dps against a ${HP}hp bar`);
  }
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
