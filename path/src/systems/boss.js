// ---------------------------------------------------------------------------
// THE BOSS
// ---------------------------------------------------------------------------
// Every fifth level the water sends one enormous creature: a body drawn from
// bosses.csv, a special power from bossPerks.csv, a name rolled out of
// bossNames.csv that tells you which power it has, and a red health bar across
// the top of the screen for as long as it is alive.
//
// The arrival is a THREE-PART CEREMONY, and only the middle part was ever in
// this file's original job description:
//
//   1. THE HUSH      the threshold is crossed and nothing happens. Every
//                    spawner in the game stops and the ocean empties itself.
//   2. THE ARRIVAL   the creature swims in over two seconds, untouchable,
//                    while its health bar fills and a riser climbs under it.
//   3. THE KILL SHOT the world drops into slow motion and the frame pushes in
//                    on the seal — systems/bossKill.js.
//
// ...and then the water comes back, quietly at first, building across the five
// levels to the next one (CONFIG.spawn.waves.bossCycle). The fight is the
// middle of a shape rather than a spike in a flat line.
//
// FOUR FILES, ONE FIGHT, and they are separate because they answer different
// questions and are edited by different kinds of change:
//
//   bosses.csv      WHICH creature, how big, and from what level
//   enemies.csv     what that creature's body is worth — hp, damage, speed
//   bossPerks.csv   the one special thing it can do, and that power's numbers
//   bossNames.csv   what it is called, narrowed by both of the above
//
// This file is the only thing that can put one in the water, and the only
// thing that decides when.
//
// It is paced in LEVELS, not seconds. The run already has a clock scaling
// everything else (difficulty), and hanging the marquee spawn off that too
// would make the boss one more thing that gets bigger over time rather than an
// interruption. Levels are also the player's own pace: a build that is eating
// well meets its boss sooner, which is the right way round.
//
// WHY THIS IS A SYSTEM AND NOT A ROW IN THE SPAWN TABLE. The weighted pool
// answers "what should the water send next"; a boss is not an answer to that
// question at any weight. `bossShark` sits in CONFIG.enemies at weight 0 so it
// can carry stats, a model and a spawn group like every other creature, and
// this file is the only thing that can put one in the water.
//
// The whole file is one small state machine with three states — waiting for
// the level, alive, and gone — and no timers of its own.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { clearForBoss, enemies, holdSpawns, removeEnemy, spawnNamed } from '../entities/enemies.js';
import bossNamesCsv from '../bossNames.csv?raw';
import bossesCsv from '../bosses.csv?raw';
import bossPerksCsv from '../bossPerks.csv?raw';
import { ease } from '../ease.js';
import { parseBossNameCsv, rollBossName } from '../bossNameTable.js';
import { parseBossCsv, newBossBag, nextBoss, FALLBACK_BOSS } from '../bossTable.js';
import { parseBossPerkCsv, rollBossPerk } from '../bossPerkTable.js';
import { attachBossPerk, resetBossPerks, updateBossPerks } from './bossPerks.js';
import { startBossRiser, stopBossRiser } from './bossRiser.js';
import { startBossMusic, endBossMusic, resetBossMusic } from './music.js';
import { startBossKill } from './bossKill.js';
import { attachBossBoat, isBoatBoss, resetBossBoat, updateBossBoat } from './bossBoat.js';
import { attachKraken, releaseKraken, resetKraken, updateKraken } from './kraken.js';
import { attachAngler, releaseAngler, resetAngler, updateBossAngler } from './bossAngler.js';
import { beginBossWarmup, cancelBossWarmup, tickBossWarmup } from './bossWarmup.js';
import { startCelebration } from './celebrate.js';
import { bossCycleRelief, setBossCycle } from './waves.js';
import { playSfx } from './audio.js';
import { damageCreditFor } from './playtest.js';
// Not sourceLabel directly: the ledger's name for a weapon is its BASE name,
// and by the time a boss goes down the pebbles are usually something else. See
// weaponName.js.
import { weaponName } from '../weaponName.js';

// Parsed once — the files can't change without a page reload, since it's the
// dev server that notices the write. Same deal as the quip table.
const ROSTER = parseBossCsv(bossesCsv, CONFIG.enemies);

// The enemy defs the boss roster is built out of, as a set of the def OBJECTS
// rather than of ids — `e.def` is the object, so a caller holding a creature
// can ask about it without knowing what it is called.
//
// This exists because `e.isBoss` is a LIVE FLAG and there are windows where a
// boss body is in `enemies` without it: the tuner's disable path clears it off
// a creature still in the water, and the corpse hold keeps a body around after
// the fight. A caller that only wants to know "is this creature a boss body"
// gets the wrong answer in exactly those windows, and for most callers that is
// harmless. It is not harmless for systems/whale.js, whose whole menu is a
// radius test: `bossCrab` has a radius of 0.5 — smaller than a puffer, because
// the king crab's size lives in its sizeMul — so it is the one boss the sweep
// could otherwise swallow whole.
const BOSS_DEFS = new Set(ROSTER.map((b) => CONFIG.enemies[b.enemy]).filter(Boolean));

/** Is this creature's def one the boss roster spawns? Independent of `isBoss`. */
export function isBossDef(def) {
  return !!def && BOSS_DEFS.has(def);
}
const PERKS = parseBossPerkCsv(bossPerksCsv);
// The name table is parsed LAST and handed the other two, so a name part
// tagged for an archetype or a perk that no longer exists is caught at boot
// with the ids it could have meant. Both columns fail silently otherwise — a
// mistagged part is simply one that never appears again, and nothing about the
// game looks wrong while it happens.
const NAME_PARTS = parseBossNameCsv(bossNamesCsv, console.warn, {
  bosses: ROSTER.map((b) => b.id),
  perks: PERKS.map((p) => p.id),
  // Which archetypes name themselves and nothing else — checked slot by slot,
  // because an exclusive archetype missing a slot quietly borrows the shared
  // pool for it. See bosses.csv's ownNames column.
  exclusive: ROSTER.filter((b) => b.ownNames).map((b) => b.id),
});

// Whether this archetype draws only from its own vocabulary. Looked up rather
// than passed around: every caller that rolls a name has the id, and only this
// file has the roster row it came from.
function ownNames(bossId) {
  return !!ROSTER.find((b) => b.id === bossId)?.ownNames;
}

/**
 * What is in the water, for anything that needs to draw it.
 *
 * `enemy` is the live creature, or null. Everything else is only meaningful
 * while it is non-null, and `hpFrac` is kept up to date each frame so the HUD
 * doesn't have to know what a boss is made of.
 */
export const bossState = {
  enemy: null,
  name: '',
  // What killed the LAST boss, as a player-facing weapon name ('Homing
  // Missile') or '' — the polaroid's stamp. Written on the frame the boss
  // leaves the enemy list and read a few frames later by the kill-shot grab in
  // main.js, which is the whole reason it is state and not an argument.
  killedBy: '',
  killedBySource: '',
  hpFrac: 1,
  // The level the next boss arrives at. Advanced by exactly one gap on every
  // spawn, from the threshold it just answered rather than from the player's
  // current level, so the cadence stays on its grid for a whole run.
  nextLevel: 0,
  // The level the last boss DIED at, or 0 while the run has yet to kill one.
  // The bottom end of the cycle the wave clock ramps across (see publishCycle);
  // the top end is `nextLevel`, and the schedule itself is still that.
  //
  // The kill and not the arrival, because the ramp is what the player is
  // recovering from: a fight that ran two levels long should leave the water
  // as quiet afterwards as one that ended immediately, and anchoring on the
  // spawn would have the ocean already back at half strength on the frame the
  // boss went down.
  lastLevel: 0,
  // THE HELD BREATH. True for `hush.seconds` between the level threshold being
  // crossed and the creature actually arriving: the water stops sending
  // anything and everything already in it turns for the wall, so the boss
  // swims into an ocean that has already got out of its way.
  //
  // It exists because the clear-out cannot be instant — creatures leave under
  // their own power, which takes seconds — so a boss that spawned on the frame
  // the threshold was crossed arrived into forty bodies mid-exodus and shared
  // its entrance with them. The hush moves that exodus BEFORE the arrival,
  // where it reads as the sea emptying rather than as a bug in the clear-out.
  hushing: false,
  hushLeft: 0,
  // WHICH boss the current hush is leading up to, drawn on the frame the hush
  // began and consumed on the frame it ends. Null at every other moment.
  //
  // It is state rather than a local because the draw and the spawn are now
  // three seconds apart — and they are three seconds apart on purpose, because
  // the warm-up cannot prepare a boss nobody has picked yet. See
  // systems/bossWarmup.js.
  //
  // A draw held here is NOT lost if the hush is abandoned: the bag has already
  // moved on, so the next arrival consumes this rather than drawing again.
  // Only a run reset clears it, which is also when the bag itself is rebuilt.
  pending: null,
  // How many have been sent this run. Not used for scaling — the creature's
  // own hpPerDifficulty already does that — but it is what a HUD or a score
  // screen would want, and it is one line to keep honest.
  defeated: 0,
  // How many have been SENT, including the one currently swimming. This is
  // what the perk roll reads, not `defeated`: the first boss of a run must
  // have no perk, and `defeated` is still 0 while that first boss is alive —
  // so using it would leave every boss perk-less until one had been killed.
  sent: 0,
  // Which archetype is in the water (a row from bosses.csv) and which perk it
  // is carrying (a row from bossPerks.csv), or null for neither.
  archetype: null,
  perk: null,
  // The shuffle bag, so a run does not fight the same archetype four times.
  // See nextBoss — a plain object rather than module state so a reset is one
  // assignment and a harness can hold two independent runs at once.
  bag: newBossBag(),
  // THE ARRIVAL. `arriving` is true for CONFIG.boss.arrival.seconds after the
  // spawn, during which the boss cannot be hurt and cannot hurt you, and
  // `arrivalFrac` walks 0→1 across it. The health bar draws the second number
  // instead of the first while this is on, which is what makes the bar fill
  // rather than appear.
  arriving: false,
  arrivalFrac: 0,
  // The boss's full health, so the HUD can size the bar to the fight. A later
  // boss is not just harder, it is visibly LONGER across the top of the
  // screen — the one piece of the escalation the player can read before the
  // first hit lands.
  maxHp: 1,
};

// EVERY FIFTH LEVEL. Floored at 1 so a hand-edited 0 is a legal cadence rather
// than a boss on every frame of the rest of the run.
//
// It used to be a roll between 8 and 12, and losing the jitter is the point
// rather than a simplification: the run is now built AROUND the boss — the
// water empties before it, the kill punctuates, and everything between two of
// them is one build that ramps (see CONFIG.spawn.waves.bossCycle) — and a
// build whose end date moves is one the player cannot feel the shape of. The
// variety lives in which archetype and which perk, both still rolled.
function bossGap() {
  return Math.max(1, Math.round(CONFIG.boss?.everyLevels ?? 5));
}

/**
 * Back to "no boss, first one due at level 5". Called at the start of every
 * run — the creature itself is removed by resetEnemies, so this only drops our
 * reference to it.
 */
// ---------------------------------------------------------------------------
// WHAT A BOSS IS ALLOWED TO DO TO YOU
// ---------------------------------------------------------------------------
// A boss is a wall of health, not a coin flip. The whole fight is built on the
// player being able to stay in the water and read it — the arrival ceremony,
// the empty ocean, the health bar — and none of that survives an animal that
// can end a run between two frames.
//
// TWO CEILINGS, because there are two ways to be killed instantly and a cap on
// either one alone leaves the other wide open:
//
//   PER HIT      the burst. A barrel, an eye beam, a volley landing all at
//                once. Capped as a fraction of the bar, so it stays a fraction
//                however far the run's damage ramp has climbed and whatever
//                perk gets added next year.
//
//   PER SECOND   the grind. Contact damage arrives as `contactDamage * dt`,
//                which is fifty separate hits a second, each one far under any
//                per-hit ceiling and adding up to a bar and a half. The lunge
//                perk doubles it outright. A rolling one-second budget is what
//                makes "cannot kill you instantly" mean anything for a source
//                that never deals a large number.
//
// APPLIED AT THE FUNNEL, in main.js's onPlayerHit, which every single point of
// damage in the game already goes through — contact, shots, perks, blasts.
// Capping at the sources would mean finding all of them, and bossPerks.csv is
// a file designed to grow.
//
// SOURCE-GATED, not global. Ordinary wildlife is not covered: a school of
// barracuda chewing through the bar in a second is the fight working, and the
// answer to it is to move. This is about the one creature the run stops for.
let bossDamageWindow = [];

/** Every source string the boss can deal damage under starts with "boss". */
function isBossDamage(source) {
  return typeof source === 'string' && source.startsWith('boss');
}

/**
 * Trim a single point of incoming damage to what a boss is allowed to do.
 * Returns the damage to actually apply — unchanged for everything that is not
 * a boss, and for a boss that is inside both ceilings.
 *
 * @param {number} dmg
 * @param {string} source  the tag main.js's onPlayerHit was given
 * @param {number} maxHp   the player's CURRENT maximum, so the ceilings track
 *                         every point of health the run has bought
 * @param {number} now     seconds, any monotonic clock
 */
export function capBossDamage(dmg, source, maxHp, now) {
  const cap = CONFIG.boss?.damageCap;
  if (cap?.enabled === false || !(dmg > 0) || !(maxHp > 0) || !isBossDamage(source)) return dmg;

  let out = Math.min(dmg, maxHp * (cap?.perHit ?? 0.35));

  // The rolling second. Entries older than the window are dropped on the way
  // in, so this costs a few array ops per hit and never grows.
  const window = cap?.window ?? 1;
  const budget = maxHp * (cap?.perSecond ?? 0.75);
  const cutoff = now - window;
  while (bossDamageWindow.length && bossDamageWindow[0].t < cutoff) bossDamageWindow.shift();
  let spent = 0;
  for (const h of bossDamageWindow) spent += h.d;

  out = Math.max(0, Math.min(out, budget - spent));
  if (out > 0) bossDamageWindow.push({ t: now, d: out });
  return out;
}

/** A new run starts owing nothing. */
export function resetBossDamageCap() {
  bossDamageWindow = [];
}

export function resetBoss(scene = null) {
  if (scene) resetBossBoat(scene);
  // The kraken's FULL teardown, cloud included — this is the run reset, and the
  // one place ink already in the water is not allowed to survive. Every other
  // exit uses releaseKraken, which leaves it drifting.
  if (scene) resetKraken(scene);
  resetAngler();
  bossState.enemy = null;
  bossState.name = '';
  bossState.killedBy = '';
  bossState.killedBySource = '';
  bossState.hpFrac = 1;
  bossState.defeated = 0;
  bossState.sent = 0;
  bossState.archetype = null;
  bossState.perk = null;
  bossState.arriving = false;
  bossState.arrivalFrac = 0;
  bossState.maxHp = 1;
  bossState.lastLevel = 0;
  bossState.hushing = false;
  bossState.hushLeft = 0;
  // The one place a held draw IS thrown away, because it is the one place the
  // bag it came from is thrown away too — see `pending`. Anything the warm-up
  // had half-built goes back to the visual pool rather than being disposed:
  // a spare body costs a pool slot, and the next run may well want it.
  bossState.pending = null;
  cancelBossWarmup();
  // A FRESH BAG PER RUN. Carrying it across would mean a run whose first boss
  // is the orca purely because the last run had already drawn the shark, which
  // is the previous run reaching into this one — and the whole reason the
  // shark is available from level 0 is that it should be what a run meets
  // first.
  bossState.bag = newBossBag();
  resetBossDamageCap();
  resetBossPerks();
  stopBossRiser(false);
  // No handover — play() picks the opening loop for the new run a moment later,
  // and a switch scheduled here would be overwritten by it anyway.
  resetBossMusic();
  // Levels start at 1, so a gap of 5 means the first boss arrives AT level 5 —
  // four level-ups in, not five past the first one. That is also what keeps
  // the whole run on the same grid: 5, 10, 15, and every threshold after it is
  // measured from the last one rather than from the arrival (see updateBoss).
  bossState.nextLevel = bossGap();
  setBossCycle(1);
}

// The size step, applied to all three things that have to move together: the
// model, the hitbox, and the "how big is this one for its species" number that
// physics and feedback read. Scaling only the visual gives a boss you can
// shoot through the nose of; scaling only the radius gives an invisible wall.
//
// multiplyScalar rather than setScalar on the visual, because the scale it
// already carries is the model's own fit times the tuner's Size slider — see
// the note on createVisual's root scale. Setting it would silently drop both.
function applyBossScale(e, mul) {
  if (!e || !(mul > 0) || mul === 1) return;
  e.visual.scale.multiplyScalar(mul);
  e.spawnScale *= mul;
  e.sizeMul *= mul;
  e.radius *= mul;
}

// ---------------------------------------------------------------------------
// THE ARRIVAL
// ---------------------------------------------------------------------------
// For `arrival.seconds` after the spawn the boss is in the water, swimming and
// visible, and neither side can touch the other. The health bar fills from
// empty across exactly that window with a filter riser under it, and the fight
// starts on the frame both land — see CONFIG.boss.arrival.
//
// INVULNERABILITY IS ENFORCED TWICE, and the second one is the one that
// matters. `e.invuln` is checked by resolveCombat, which is where essentially
// all of the player's damage goes — but not all of it: nineteen files in this
// project subtract from an enemy's hp, and a guard in each is nineteen places
// for the next ability to forget. So the hp is also simply RESTORED here every
// frame, which cannot be forgotten by code that doesn't exist yet.
//
// The two are not redundant. The restore alone would leave a boss that could
// still be KILLED — the death check runs the instant hp crosses zero, inside
// the same loop that dealt the damage, and a burst big enough to cross it in
// one frame would remove the creature before this ever saw it. The guard in
// resolveCombat is what makes that impossible for the one source big enough to
// do it; the restore is what mops up everything else.
function tickArrival(dt, e) {
  const cfg = CONFIG.boss?.arrival ?? {};
  const seconds = Math.max(0.01, cfg.seconds ?? 2);

  bossState.arrivalFrac = Math.min(1, bossState.arrivalFrac + dt / seconds);
  // The bar shows the CEREMONY, not the health, for as long as it is running.
  // Feeding it the real hpFrac would draw a full bar for two seconds and then
  // a full bar for the fight, and nothing would ever appear to fill.
  //
  // EASED HERE, not in CSS. `arrivalFrac` is honest linear time — it is what
  // the riser is scheduled against and what decides when the fight starts —
  // and the curve is applied only to the number the bar draws. The first
  // version of this had a linear value driving a 0.4s CSS transition, and a
  // transition that restarts every frame chasing a moving target never
  // catches it: the bar crawled for most of the ceremony and then snapped the
  // last third in the final moments. One owner of the curve, and it is this.
  bossState.hpFrac = ease(cfg.ease ?? 'outCubic', bossState.arrivalFrac);

  if (cfg.invulnerable !== false) {
    e.invuln = Math.max(0, (seconds - bossState.arrivalFrac * seconds));
    e.hp = e.maxHp;
  }

  if (bossState.arrivalFrac < 1) return;

  // Landed. The cue and the full bar are the same frame on purpose — the riser
  // has been climbing toward this for two seconds, and a cue that arrived even
  // a few frames off would read as two sounds rather than as a resolution.
  bossState.arriving = false;
  bossState.arrivalFrac = 1;
  bossState.hpFrac = 1;
  e.invuln = 0;
  stopBossRiser();
  playSfx('bossArrive');
  // ...and the score changes hands. HERE rather than at the spawn or at the
  // held breath: the riser has spent the whole ceremony climbing toward this
  // frame, and the boss music arriving with its resolution makes the two one
  // sound instead of two.
  //
  // It does not land on this frame, though — startBossMusic queues it for the
  // next BAR LINE, up to 2.265s out, so the run's loop is never cut mid-phrase
  // and the boss music starts on its own downbeat. The cue and the riser cover
  // the gap; what the player hears is the arrival, and then the music already
  // being different.
  startBossMusic();
}

// ---------------------------------------------------------------------------
// HOW FAR THE RUN IS BETWEEN TWO BOSSES
// ---------------------------------------------------------------------------
// 0 on the level the last one died at, 1 on the level the next one is due, and
// published to the wave clock every frame — that is what makes the water build
// across a cycle instead of resuming at whatever intensity the fight
// interrupted. See cycleState in systems/waves.js for what is done with it.
//
// Pushed rather than pulled because waves.js cannot ask: it is imported by
// entities/enemies.js, which this file imports, so a call in that direction
// would be a cycle. Both ends of the ramp are LEVELS, like the schedule
// itself, so a player who is levelling fast gets their next boss sooner AND
// walks up the ramp to it faster, rather than the two disagreeing.
//
// 1 until the first boss of a run has been killed: a run that has not fought
// one is not recovering from one, and the opening already has its own build.
function publishCycle(gameState) {
  if (bossState.lastLevel <= 0) { setBossCycle(1); return; }
  const level = gameState?.level ?? 1;
  // Floored at 1 rather than trusted: a player who gains the whole gap during
  // the fight leaves the two ends of the ramp on the same level, and dividing
  // by that is an Infinity that would pin the ocean at full intensity for the
  // rest of the run.
  const span = Math.max(1, bossState.nextLevel - bossState.lastLevel);
  setBossCycle((level - bossState.lastLevel) / span);
}

/**
 * One tick of the boss clock. Call it from the running branch of the frame
 * loop, after spawning — it reads `gameState.level` and the live enemy list,
 * and owns nothing else.
 *
 * Returns the boss that was spawned this frame, or null. Nothing needs that
 * today; it is there so an arrival cue (a sound, a camera push) has something
 * to hang off without this file growing a callback.
 *
 * `opts.skipHush` puts a boss in the water on this frame instead of a few
 * seconds after it. Exactly one caller uses it — forceBoss, the debug door —
 * and it is the one part of the real arrival that door does not reproduce: the
 * hush is a property of the SCHEDULE (the water going quiet as a level
 * threshold comes up), and a button that has already decided a boss is coming
 * has nothing to lead up to. Everything after it still runs.
 */
export function updateBoss(dt, gameState, scene, opts = {}) {
  const cfg = CONFIG.boss ?? {};
  publishCycle(gameState);
  if (!cfg.enabled) {
    // Switched off mid-run: let go of whatever is in the water rather than
    // holding a stale reference (and a stale health bar) forever. The creature
    // stays and is killable — it just stops being THE boss.
    //
    // `isBoss` has to come off it with the reference, and that is not tidiness:
    // the spawn lockout is keyed on that flag rather than on this module (see
    // bossLockout), so a creature left carrying it would suppress every other
    // spawn in the game for the rest of the run — an ocean that quietly
    // emptied itself and never refilled, from a toggle in the tuner.
    if (bossState.enemy) {
      bossState.enemy.isBoss = false;
      // The arrival's two effects are written ONTO THE CREATURE, so letting go
      // of our reference is not enough to undo them: a boss abandoned mid
      // ceremony would swim on permanently untouchable and permanently
      // harmless, which is the same silent-ocean class of bug as leaving
      // `isBoss` set.
      bossState.enemy.invuln = 0;
    }
    bossState.enemy = null;
    bossState.arriving = false;
    // The hush goes with it, and the spawner's claim is released on the same
    // frame rather than left to run down: with the boss switched off there is
    // no longer an arrival for the quiet to be leading up to, and an empty
    // ocean waiting for nothing is exactly the silent-ocean bug above wearing
    // a different hat.
    if (bossState.hushing) holdSpawns(0);
    bossState.hushing = false;
    bossState.hushLeft = 0;
    // `pending` is deliberately LEFT SET: the bag has already moved past this
    // archetype, and a boss switched off and on again should meet the one it
    // had drawn rather than silently skip it. The queue does stop — there is
    // no longer an arrival for it to be racing.
    cancelBossWarmup();
    setBossCycle(1);
    resetBossPerks();
    resetBossBoat(scene);
    // NOT resetKraken: the cadence stops, the cloud does not. See releaseKraken.
    releaseKraken();
    // The anglerfish has nothing that outlives it, so this is the whole
    // teardown: the cadence stops, the body gets its contact damage and its
    // locomotion state back, and the borrowed materials go back to resting.
    releaseAngler();
    stopBossRiser();
    // The score goes back to the run's own, at the next bar rather than on this
    // frame: unlike a kill there is no hush to hide the switch under, so this
    // one is audible and has to land musically. Cheap to call every frame while
    // the toggle is off — after the first it finds no fight and returns.
    endBossMusic({ immediate: false });
    return null;
  }

  // Is the one we sent still alive? `enemies` is the authority: a boss can
  // leave the list by being killed, by a run reset, or by anything else that
  // removes a creature, and none of those routes owes this file a callback.
  if (bossState.enemy) {
    if (enemies.includes(bossState.enemy)) {
      const e = bossState.enemy;
      if (bossState.arriving) tickArrival(dt, e);
      else bossState.hpFrac = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)));
      return null;
    }
    // WHAT FINISHED IT, read while the body is still referenced — one line
    // before the reference is dropped, and it cannot move any later than this.
    // The kill shot is grabbed several frames from now (main.js, after the
    // draw) and by then this file has forgotten which creature the fight was
    // about, so the answer has to be banked here or not at all.
    //
    // The credit comes from the same WeakMap the balance report gives the kill
    // to (see damageCreditFor), so the stamp on the print and the ability that
    // gets the kill in the ledger are one answer rather than two that agree
    // most of the time. It is the LAST thing that damaged the boss, which is
    // the killing blow for everything except an aura ticking over a body a
    // bullet had already broken — the same small lie the ledger has always
    // told, and the right one for a caption.
    //
    // Already a display name, not a source key: nothing downstream of here has
    // any use for 'clubBoom', and resolving it once means the print, the
    // shared PNG and the score-screen fan cannot caption the same kill three
    // ways. Empty string, never a guess, when nothing was recorded — a card
    // that says nothing beats a card that says "unknown".
    //
    // RESOLVED AGAINST THE BUILD AS IT STANDS ON THIS FRAME, which is the whole
    // reason it happens here rather than when a card is drawn: the player goes
    // on levelling after this kill, and a print that re-derived its own caption
    // on the score screen would rename a weapon that beat this boss after the
    // fact — "Cloned Pebbles" on a photograph taken before the pebbles were
    // ever cloned.
    const credit = damageCreditFor(bossState.enemy);
    bossState.killedBy = credit ? weaponName(credit) : '';
    // And the key behind it, unresolved — see causeSource in systems/bossShot.js.
    bossState.killedBySource = credit ?? '';
    bossState.enemy = null;
    bossState.hpFrac = 0;
    bossState.arriving = false;
    bossState.defeated += 1;
    // WHERE THE NEXT CYCLE STARTS FROM. Set before anything else reads it, and
    // set to the level the kill happened at rather than the one the fight
    // began at — see bossState.lastLevel.
    bossState.lastLevel = gameState?.level ?? 1;
    // The two halves of the aftermath, and they are deliberately in different
    // files: the SHOT (slow motion, the frame closing in on the seal) belongs
    // to systems/bossKill.js, and what the water does next belongs to the wave
    // clock. Neither knows about the other, and this is the only place that
    // knows there is anything to tell them about.
    //
    // Gated on the run still being live because the branch this sits in fires
    // on "the boss is no longer in the enemy list", and a player who died on
    // the same frame their last hit landed is one of the ways that becomes
    // true. A victory lap over a corpse would be a bad look, and it would be
    // fighting the death dive for the same camera.
    if (gameState?.running) {
      // The shot normally owns the music's handover: it hushes the score on the
      // killing blow and swaps back to the run's own loop under the silence.
      // `false` means it is switched off in the tuner, and then nothing else
      // ever will — so the fight's music has to end itself, at a bar, since
      // there is no silence here to hide the switch in.
      if (!startBossKill()) endBossMusic({ immediate: false });
      // The third part of the aftermath, and it starts from the same zero as
      // the shot because it is posing FOR the shot — see systems/celebrate.js,
      // which derives its peak from the snapshot's own timing. Rolls its own
      // chance internally and returns null on the kills that don't get one.
      startCelebration();
      bossCycleRelief(gameState?.difficulty ?? 0);
    } else {
      // Killed on the same frame the player died, so there is no shot and
      // nothing will ever hand the transport back — the rotation would chain
      // another boss loop under the score card of a run that is over.
      //
      // Dropped WITHOUT a handover, unlike every other exit: the loop that is
      // playing stays, and rides the death dive's tape drag down with
      // everything else. Swapping to the run's ordinary music on this frame
      // would be the game changing the subject in the middle of a death.
      resetBossMusic();
    }
    resetBossPerks();
    // `true` — this branch is the boss having DIED, not the fight being
    // switched off, and that is the difference between a yacht's guests being
    // thrown into the sea and being deleted along with the run. The other two
    // call sites are switch-offs and correctly pass nothing.
    resetBossBoat(scene, true);
    // NOT resetKraken. A kraken's ink outlives the kraken — that is most of what
    // the ink IS — so the fight's clock is dropped here and the cloud is left to
    // finish dissolving on its own. See releaseKraken.
    releaseKraken();
    releaseAngler();
    // A boss killed DURING its own entrance is not reachable while
    // `arrival.invulnerable` is on, but the toggle is a toggle — and a riser
    // left sounding over an empty ocean would climb to its scheduled end and
    // resolve into nothing, which is the one sound in the game that would
    // announce a bug to a player who couldn't see one.
    stopBossRiser();
    // Nothing else this frame. A player who gained the whole next gap DURING
    // the fight is already past the threshold, and without this the next boss
    // would arrive in the same tick the last one died — the bar would never
    // clear, and the kill would read as the health bar refilling itself. It
    // arrives on the next frame instead, which is a breath rather than a wait.
    return null;
  }

  if (!gameState?.running) return null;
  if ((gameState.level ?? 1) < bossState.nextLevel) return null;

  // -------------------------------------------------------------------------
  // THE HELD BREATH
  // -------------------------------------------------------------------------
  // The threshold has been crossed, but nothing arrives yet. For
  // `hush.seconds` the spawner is stopped dead — every source, not just the
  // weighted pool (see holdSpawns and bossLockout) — and everything already in
  // the water turns for the wall. Then, and only then, the boss.
  //
  // WHY THE EXODUS MOVED IN FRONT OF THE ARRIVAL. The clear-out has always run
  // on the spawn frame, and it cannot be instant: creatures leave under their
  // own power, which takes several seconds across an eighty-unit arena. So the
  // marquee spawn of the run happened in the middle of forty bodies streaming
  // for the edges — the one moment the game most wants a clean stage was the
  // busiest frame in it. Run the same sweep a few seconds early and the same
  // machinery produces the opposite reading: the sea empties, the sea is
  // empty, and then something enormous swims into it.
  //
  // The quiet is also the tell. Nothing else in the run stops the water, so a
  // player who has met one boss knows exactly what an empty ocean means.
  //
  // Re-armed EVERY FRAME rather than set once, because the spawner's hold is a
  // countdown that expires on its own — the two together mean a hush can only
  // last as long as this branch keeps asking for it, and can never outlive it.
  const hush = cfg.hush ?? {};
  if (hush.enabled !== false && !opts.skipHush) {
    if (!bossState.hushing) {
      bossState.hushing = true;
      bossState.hushLeft = Math.max(0.01, hush.seconds ?? 3);
      // Everything that is not a minion turns for the wall now, with no boss
      // to pass in — clearForBoss is asked about the CROWD, not about the
      // fight, and the creature it would be handed does not exist yet.
      clearForBoss(null);
      // WHICH BOSS IS DECIDED HERE, at the START of the hush, and it used to be
      // decided at the end of it. That one move is what the whole warm-up
      // hangs off: three seconds of known lead time are worth nothing if the
      // thing they are leading up to is a secret until the last frame.
      //
      // The draw is otherwise unchanged — same bag, same eligibility — and it
      // reads the level at the moment the threshold was crossed rather than
      // three seconds later. That is if anything the more correct of the two:
      // it is the level that ASKED for this boss. A player who gains a level
      // inside the hush would previously have been able to unlock a higher
      // `minLevel` archetype during the held breath, which is a door nobody
      // designed and which nothing depended on.
      //
      // `??=`, NOT `=`, and that is not defensiveness. A hush can be abandoned
      // with its draw still held — the tuner switching the fight off is the
      // ordinary way — and the draw has already come OUT OF THE BAG by then.
      // Overwriting it on the next hush would draw a second time for one
      // arrival, so a run that toggled the boss off and on would burn through
      // the shuffle bag at twice the rate and start repeating archetypes it
      // had never actually sent.
      bossState.pending ??= nextBoss(ROSTER, bossState.bag, gameState.level ?? 1) ?? FALLBACK_BOSS;
      // ...and now the empty ocean is spent building it. See
      // systems/bossWarmup.js: the body, its textures and its programs, one
      // step per frame, so the arrival frame has nothing left to pay for.
      beginBossWarmup(bossState.pending);
    }
    // One unit of warm-up work per frame of the hush. Deliberately before the
    // countdown's early return, so it runs on every frame of the quiet rather
    // than on none of them.
    tickBossWarmup();
    bossState.hushLeft -= dt;
    // Exactly what is left and not a frame more. There is no gap to cover at
    // the far end: every spawner in the game runs BEFORE this function in the
    // frame (see main.js), so the last tick the spawner takes with the hush
    // running is the one before the arrival, and by its next tick the boss is
    // in the water and holding the lockout itself. An overhang would only
    // outlive the thing it was covering for.
    holdSpawns(Math.max(0, bossState.hushLeft));
    if (bossState.hushLeft > 0) return null;
    bossState.hushing = false;
    bossState.hushLeft = 0;
  }

  // WHICH boss. Drawn from the shuffle bag rather than rolled independently,
  // so a run with two eligible archetypes meets both — see nextBoss.
  //
  // ALREADY DRAWN, on the frame the hush began, so that the warm-up had
  // something to warm — see THE HELD BREATH above. The draw still happens here
  // for the paths with no hush in front of them: a hush switched off in the
  // tuner, and forceBoss, which passes `skipHush`. Those arrive cold, which is
  // the behaviour they had before this existed.
  const level = gameState.level ?? 1;
  const archetype = bossState.pending ?? nextBoss(ROSTER, bossState.bag, level) ?? FALLBACK_BOSS;
  bossState.pending = null;
  const key = archetype.enemy;
  if (!CONFIG.enemies[key]) {
    // Only reachable through FALLBACK_BOSS, since parseBossCsv already refuses
    // rows whose creature does not exist. Kept anyway, and it must not retry
    // every frame for the rest of the run: that is a warning per frame and a
    // check per frame, both for a config error that will not fix itself
    // mid-run.
    console.warn(`[boss] archetype "${archetype.id}" wants enemy "${key}", which is not in CONFIG.enemies — no boss this run.`);
    bossState.nextLevel = Infinity;
    return null;
  }

  // ignoreCaps: the boss holds a slot in the `apex` and `shark` families for
  // as long as it lives (which is the point — a boss fight is not also a
  // shiver), but its own arrival can't be blocked by them, or the marquee
  // spawn of the run would silently not happen because two sharks were
  // already swimming.
  // `overfill` as well: maxAlive was the last door left, and it is the one
  // that shuts hardest at exactly the wrong moment. A boss is due at a LEVEL,
  // and the ocean is fullest when the player has been farming their way to
  // one — so the arrival would silently not happen, and the retry would find
  // the arena just as full next frame, and the run's marquee spawn would be
  // skipped in precisely the fights that most needed clearing. One body over a
  // memory bound, for the few seconds it takes the clear-out below to empty
  // the water. See spawnNamed.
  const e = spawnNamed(scene, key, gameState.difficulty ?? 0, undefined, {
    ignoreCaps: true,
    overfill: true,
  });
  if (!e) return null; // unreachable today; the guard costs nothing

  applyBossScale(e, archetype.sizeMul ?? 1);

  // Marked BEFORE the clear-out, so the sweep can recognise the boss without
  // being handed it, and so the spawn lockout is live from this same frame
  // rather than from the next one — a tick's worth of ordinary spawning
  // landing on top of the arrival is exactly the frame the water should be
  // emptying.
  e.isBoss = true;
  // Everything that is not an escort turns for the wall. See clearForBoss:
  // they swim out, they do not vanish, and nothing is credited as a kill.
  clearForBoss(e);

  // THE PERK, rolled off how many bosses this run has already sent — so the
  // first one has none and every one after it does. `sent` is incremented
  // BEFORE the roll reads it, hence the 0 on the first call. See rollBossPerk.
  const perk = rollBossPerk(PERKS, bossState.sent);
  bossState.sent += 1;
  attachBossPerk(scene, e, perk);
  // ...and, if this one is a boat, the bombardment it always has. Its own
  // system rather than a perk, because it comes with a body that cannot swim
  // and a station on the surface — see systems/bossBoat.js. The rolled perk
  // above still applies on top, which is what keeps two boat fights different.
  attachBossBoat(scene, e);
  // ...and, if this one is a kraken, the ink it always has. Its own system for
  // the same reason the boat's bombardment is: it comes with a body built for
  // it and a standoff it will not leave — see systems/kraken.js.
  attachKraken(scene, e);
  attachAngler(scene, e);

  bossState.enemy = e;
  bossState.archetype = archetype;
  bossState.perk = perk;
  // The name is rolled from BOTH, and one of the perk's own words is
  // guaranteed to land in it — the name is the only warning the player gets
  // that this one teleports. See rollBossName.
  bossState.name = rollBossName(NAME_PARTS, {
    boss: archetype.id,
    perk: perk?.id ?? null,
    exclusive: archetype.ownNames,
    // How often a hand-written whole name wins over a built one. The only
    // naming number that is not a cell in bossNames.csv, because it is about
    // the BALANCE between the two kinds of row rather than about any row.
    nicknameChance: CONFIG.boss?.names?.nicknameChance,
  });
  bossState.maxHp = e.maxHp ?? 1;
  // THE CADENCE IS KEPT ON ITS GRID, not restarted from wherever the player
  // happens to be standing. Measured from the threshold this arrival answered
  // rather than from `level`, so "every fifth level" means levels 5, 10, 15
  // for the whole run — a player who banks two levels inside a fight would
  // otherwise push every boss after it one level later, and the cadence would
  // drift away from the round numbers the whole feature is named after.
  //
  // Floored past the current level so the run cannot owe a boss it has already
  // gone past: a player who leapt from 4 to 14 fights one now and the next at
  // 15, not four in a row on consecutive frames.
  bossState.nextLevel = Math.max(level + 1, bossState.nextLevel + bossGap());

  // The ceremony. Started here rather than on the next frame so the riser's
  // sweep is scheduled against exactly the window the bar will fill across.
  const arrival = cfg.arrival ?? {};
  if (arrival.enabled !== false) {
    bossState.arriving = true;
    bossState.arrivalFrac = 0;
    bossState.hpFrac = 0;
    if (arrival.invulnerable !== false) e.invuln = Math.max(0.01, arrival.seconds ?? 2);
    startBossRiser(arrival.seconds ?? 2);
  } else {
    bossState.arriving = false;
    bossState.arrivalFrac = 1;
    bossState.hpFrac = 1;
  }

  return e;
}

/**
 * Drive whatever the boss's perk does. Called from the frame loop AFTER
 * updateBoss and BEFORE updateEnemies — see updateBossPerks for why the order
 * is load-bearing rather than tidy.
 */
export function updateBossAbilities(dt, scene, playerPos, hooks) {
  updateBossPerks(dt, scene, playerPos, hooks);
  // AFTER the perks, and for the same reason they run before updateEnemies:
  // the boat writes the position and velocity the integrator is about to step,
  // and a frame late is a hull that visibly lags its own wake. Second of the
  // two so a rolled perk cannot move a boat off its station — the boat's ride
  // is the last word on where a hull is.
  updateBossBoat(dt, scene, playerPos, hooks);
  // The kraken's burst cadence. GAME time and inside the run gate, unlike the
  // cloud itself — see the two-clocks note at the top of systems/kraken.js. It
  // moves nothing, so unlike the boat it does not care whether it runs before or
  // after the perks.
  updateKraken(dt, scene, playerPos, hooks);
  // The anglerfish's ambush. Like the kraken's cadence this is GAME time and
  // inside the run gate; unlike it, this one MOVES the animal, so it matters
  // that it runs after the perks — see the yield in systems/bossAngler.js.
  updateBossAngler(dt, scene, playerPos, hooks);
}

// ---------------------------------------------------------------------------
// THE DEBUG DOOR — see ui/upgradeDebug.js
// ---------------------------------------------------------------------------
// A boss is the rarest thing in the game: eight to twelve LEVELS apart, with
// its archetype drawn from a bag and its perk rolled, and its name assembled
// from three tables that all narrow on each other. Seeing one specific
// combination the way it will actually read means playing until the dice hand
// it to you — and there are archetypes × perks of them, most of which a normal
// session will never produce. That is the same problem the upgrade panel
// exists to solve, and this is the same answer.

/** The roster and the perk list, so a panel can offer what actually exists. */
export function bossArchetypes() { return ROSTER; }
export function bossPerkList() { return PERKS; }

/**
 * Roll `count` names for one combination WITHOUT spawning anything.
 *
 * This is the cheap half and the one that matters most: "do all the
 * combinations read right" is a question about text, and reading twenty of
 * them at once answers it far better than twenty boss fights would.
 */
export function previewBossNames(count = 12, { boss = null, perk = null } = {}) {
  const out = [];
  // Exclusivity is resolved HERE rather than asked of the caller, so the debug
  // panel cannot preview a vocabulary the game would never actually roll —
  // which would make the one tool for reading these names lie about them.
  const exclusive = ownNames(boss);
  // Same nickname odds the real roll uses, for the same reason exclusivity is
  // resolved above: a preview that never showed a hand-written name would be
  // the one tool for reading these names hiding a quarter of them.
  for (let i = 0; i < count; i++) {
    out.push(rollBossName(NAME_PARTS, {
      boss, perk, exclusive, nicknameChance: CONFIG.boss?.names?.nicknameChance,
    }));
  }
  return out;
}

/**
 * Put a boss in the water right now, with a chosen archetype and perk.
 *
 * Goes through the SAME PATH the real arrival does — spawnNamed, the size
 * step, the clear-out, the perk attach, the name roll, the ceremony — rather
 * than assembling a creature here. A debug spawn that skipped any of those
 * would be showing you something the game never produces, which is worse than
 * no button at all. `boss` and `perk` are ids; null means roll it normally.
 */
export function forceBoss(scene, gameState, opts = {}) {
  if (!scene) return null;

  const boss = opts.boss ?? null;
  // THREE STATES, and a default parameter cannot express them: `undefined` is
  // "roll one normally", `null` is "force the perk-less boss", and a string is
  // "force that perk". Written as `perk = null` in the signature, undefined
  // would collapse into null and the panel's (roll) chip would silently be a
  // second (none) chip — the one bug a debug tool must not have, because it
  // would make the thing you are inspecting differ from the thing that ships.
  const perk = Object.hasOwn(opts, 'perk') ? opts.perk : undefined;
  // Whatever is in the water goes first. Without this a second click leaves
  // the first boss swimming with its health bar handed to the new one — and
  // the old one keeps `isBoss`, which holds the spawn lockout open forever.
  if (bossState.enemy) {
    const i = enemies.indexOf(bossState.enemy);
    if (i >= 0) removeEnemy(scene, i);
    bossState.enemy.isBoss = false;
    bossState.enemy.invuln = 0;
    bossState.enemy = null;
    resetBossPerks();
    stopBossRiser(false);
  }
  // A hush that was counting down toward a natural arrival is abandoned with
  // it. Left set, the next real threshold would resume a countdown that had
  // already been half spent and the water would go quiet for a fraction of the
  // time it should — the sort of thing that looks like nothing at all until
  // someone wonders why the ocean only sometimes empties.
  bossState.hushing = false;
  bossState.hushLeft = 0;
  // AND THE DRAW THAT HUSH WAS HOLDING. This is load-bearing rather than
  // tidiness: the spawn below reads `pending` before it reads the bag, so a
  // leftover draw from an abandoned hush would be spawned INSTEAD of the
  // archetype the panel asked for — a debug button that shows you a different
  // boss than the one you clicked, intermittently, only when a hush happened
  // to be running. Stashed rather than dropped, so the natural schedule that
  // had already drawn it is not quietly skipped when this returns.
  const savedPending = bossState.pending;
  bossState.pending = null;
  cancelBossWarmup();

  // The archetype is forced by putting it at the front of a one-shot roster
  // rather than by bypassing the draw, so the size step, the enemy lookup and
  // the fallback all still run exactly as they do in a real arrival.
  const chosen = ROSTER.find((b) => b.id === boss) ?? null;
  const savedBag = bossState.bag;
  const savedSent = bossState.sent;
  const savedNextLevel = bossState.nextLevel;

  // Everything else marked as already drawn, so the bag has exactly one legal
  // answer left. Forced through the real draw rather than around it, so the
  // eligibility rules, the size step and the fallback all still run.
  if (chosen) bossState.bag = { drawn: ROSTER.filter((b) => b.id !== chosen.id).map((b) => b.id) };
  // `sent` is what rollBossPerk reads to decide the first boss of a run gets
  // none, so it is also the lever for reaching either state on demand. A
  // forced perk is swapped in after the spawn (below); this just makes sure
  // the spawn does not roll the opposite of what was asked for.
  if (perk === null) bossState.sent = 0;
  else if (perk !== undefined) bossState.sent = Math.max(1, bossState.sent);

  // The level the boss is spawned AGAINST — raised past the archetype's own
  // gate so a level-2 dev run can look at a boss that unlocks at 15, and past
  // the pending threshold so the spawn happens this frame instead of whenever
  // the schedule next came due.
  const level = gameState?.level ?? 1;
  const at = Math.max(level, chosen?.minLevel ?? 0);
  bossState.nextLevel = 0;

  const e = updateBoss(1 / 60, { ...gameState, level: at, running: true }, scene, { skipHush: true });

  bossState.bag = savedBag;
  bossState.pending = savedPending;
  bossState.sent = savedSent + (e ? 1 : 0);
  // THE NATURAL SCHEDULE IS PUT BACK. updateBoss just rolled a fresh gap off
  // `at`, which for a forced spawn is a level the player has not reached — so
  // leaving it would push the run's next real boss tens of levels away, and a
  // debug spawn would silently disable the feature it exists to inspect.
  bossState.nextLevel = savedNextLevel;
  if (!e) return null;

  // A specific perk was asked for, and updateBoss rolled its own. Swapped
  // here, and the NAME is re-rolled with it — a boss wearing a name for the
  // perk it nearly had is precisely the bug this panel is for finding.
  const want = perk ? (PERKS.find((p) => p.id === perk) ?? null) : null;
  if (perk !== undefined && (bossState.perk?.id ?? null) !== (want?.id ?? null)) {
    bossState.perk = want;
    attachBossPerk(scene, e, want);
    bossState.name = rollBossName(NAME_PARTS, {
      boss: bossState.archetype?.id ?? null,
      perk: want?.id ?? null,
      exclusive: !!bossState.archetype?.ownNames,
      nicknameChance: CONFIG.boss?.names?.nicknameChance,
    });
  }
  return e;
}

/**
 * What the HUD should draw, or null for "no boss". A view rather than the
 * state itself, so the UI never has to reason about a dead enemy that hasn't
 * been noticed yet.
 *
 * `maxHp` is here so the bar can be SIZED to the fight — a later boss gets a
 * longer bar, which is the escalation made readable before the first hit. It
 * is the creature's own scaled maximum rather than a count of bosses defeated,
 * so the bar is honest about the specific animal in the water: a orca boss is
 * shorter than a shark boss at the same point in the run, and it should be.
 */
export function bossBanner() {
  if (!bossState.enemy) return null;
  return {
    name: bossState.name,
    frac: bossState.hpFrac,
    maxHp: bossState.maxHp,
    arriving: bossState.arriving,
    perk: bossState.perk?.id ?? null,
  };
}
