import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { spawnProjectile } from '../entities/projectiles.js';
import { player } from '../entities/player.js';
import { projectileCount } from '../stats.js';
import { abilityDamage, aoe } from './scaling.js';
import { strikeState, pipCount } from './strike.js';
import { musselLevelStats } from '../levelStats.js';

// MUSSEL BARRAGE — the flight of homing mussels a strike released at or above
// CONFIG.musselVolley.chargeThreshold strews across its dash.
//
// This is not a weapon with a cooldown: it is a thing a FULL CHARGE does, and
// its cost is the wind-up that was already spent, so a cooldown here would be
// charging twice for the same commitment.
//
// The shape is the Hades multishot bow. You do not get a stream, you get one
// loud moment, and the fan is wide enough (`arc`, ~120 degrees) that it is an
// area answer rather than an aimed one — the homing is what turns that spread
// back into hits. Below the threshold nothing happens at all, which is what
// stops it becoming the thing you spam: a flick strike is still just a dash.
//
// Aimed along the dash heading rather than the cursor, so the barrage and the
// seal go the same way and the shells lead the dash into whatever it is diving
// at. Commit, and everything leaves in the direction you committed.
//
// IT IS STAGGERED, WHICH IS WHY THIS FILE NOW HAS AN update(). The shells used
// to leave on one frame from one point; queued a few frames apart instead they
// leave from wherever the seal HAS GOT TO, so a barrage is a line of mussels
// laid down the length of the dash rather than a bouquet dropped at the release
// site. The heading is still the one snapshotted at release (strikeState.dashDir
// does not move once the dash is launched), so the fan stays the fan — what
// changes is where each shell is born, and that is the whole read.
//
// THE FLIGHT IS PAID FOR IN PIPS. `barrageCount` is the base the card promises;
// on top of it comes one shell for every whole PIP of the fuel bar this dash
// spent (see chargePips). That makes the barrage the one ability whose size is
// set by the meter rather than only by the card — a deeper bar, or a chain
// running, is more mussels — and it is why the threshold can stay high without
// the ability being a binary.

/** How many shells the CARD is worth at this level, before the charge pays. */
export function barrageCount(level) {
  const c = CONFIG.musselVolley;
  return musselLevelStats(level, player.stats).musselCount;
}

/**
 * Whole pips of the fuel bar this dash was bought with.
 *
 * `power` is a fraction of the BAR and the bar is drawn in pips, so this is
 * simply the two put together — it is the number the player watched fill,
 * which is the only reason a shell-per-pip rule is legible at all. Floored,
 * not rounded: a bar four and a half pips deep spent four whole pips, and
 * rounding up would hand out a mussel for a pip that was never filled. The
 * epsilon is the same one strike.js's pip snapping uses, so a genuinely full
 * bar cannot come back one short off a float.
 */
export function chargePips(power, stats = null) {
  if (!(power > 0)) return 0;
  return Math.max(0, Math.floor(Math.min(1, power) * pipCount(stats) + 1e-6));
}

/**
 * The whole flight: the card's shells, the charge's shells, and Clone Warz on
 * top of both. Capped by `pipShellsMax` — a chained bar runs to twelve pips,
 * and without a ceiling a late-run barrage is a wall of mussels that hides the
 * arena behind its own projectiles.
 */
export function barrageShells(level, power, stats = null) {
  const c = CONFIG.musselVolley;
  const pips = Math.min(chargePips(power, stats), Math.max(0, c.pipShellsMax ?? Infinity));
  return projectileCount(barrageCount(level) + pips, stats);
}

/** What one shell hits for at this level, on the body it lands on. */
export function barrageDamage(level) {
  const c = CONFIG.musselVolley;
  return musselLevelStats(level, player.stats).musselDamage;
}

/**
 * ...and what the shell does to everything ELSE when it goes off.
 *
 * Its own function beside barrageDamage rather than a field read at the launch
 * because the two are read in different places and mean different things — the
 * direct hit is what the seeker earned, the blast is what the barrage is
 * actually for — and because the card text and the harness both need to be
 * able to ask for the blast without spawning one.
 *
 * `radius` goes through aoe() and the damage does not, which is what Splash
 * Zone has always meant: it widens blasts, it does not make them hit harder.
 */
export function barrageSplash(level) {
  const c = CONFIG.musselVolley;
  const lv = Math.max(1, level) - 1;
  return {
    damage: musselLevelStats(level, player.stats).musselSplash,
    radius: aoe(c.splashRadius ?? 0),
  };
}

/**
 * Does a strike released with this much banked power earn a barrage?
 *
 * Split out because two places need the same answer and they must not be able
 * to disagree: this system, and anything that wants to TELL the player it is
 * coming (the charge ring going hot at the threshold).
 */
export function barrageReady(power, level) {
  const c = CONFIG.musselVolley;
  return !!c?.enabled && level > 0 && power >= c.chargeThreshold;
}

// ---------------------------------------------------------------------------
// THE QUEUE
//
// Shells waiting for their slot in the stagger. Flat rather than one entry per
// barrage: two barrages CAN overlap (a chained eat-and-strike loop releases
// again well inside a previous dash's flight), and a nested shape would have
// to decide which of them owns the frame. A flat list simply fires whatever is
// due, in the order it was queued.
//
// Each shell carries its own scene, origin callback and hooks rather than
// reading module state, for the same reason: the barrage that queued it may no
// longer be the newest one by the time it leaves.
// ---------------------------------------------------------------------------
const queued = [];

/** Shells still waiting to leave. For the harnesses and the tuner readout. */
export function pendingShells() {
  return queued.length;
}

/**
 * Drop everything unfired. Called on a run reset — without it the last dash of
 * a dead run keeps throwing mussels into the opening seconds of the next one.
 */
export function resetMusselVolley() {
  queued.length = 0;
}

/**
 * Seconds between one shell and the next.
 *
 * `shotGap` is the intent — a few frames, enough that the ear hears a rattle
 * rather than one thump and the eye sees shells being laid down. The dash is
 * the ceiling: a big flight (deep bar, five stacks, Clone Warz) would otherwise
 * run on for a second after the seal has stopped, and the last shells would
 * leave from a standstill with nothing about them saying "dash". Compressed to
 * fit rather than truncated, so every shell the player paid for is still
 * thrown.
 *
 * `dashSeconds` <= 0 means there is no dash to fit inside (a harness, or a
 * barrage fired from something that isn't the strike) and the plain gap stands.
 */
function shellGap(count, dashSeconds) {
  const c = CONFIG.musselVolley;
  const gap = Math.max(0, c.shotGap ?? 0.05);
  if (!(dashSeconds > 0) || count <= 0) return gap;
  return Math.max(c.shotGapFloor ?? 1 / 60, Math.min(gap, dashSeconds / count));
}

/**
 * Throw the barrage. Returns how many shells the release BOUGHT — including the
 * ones still queued — so the caller can skip its own bookkeeping when the
 * release didn't qualify.
 *
 * The first shell leaves on this frame. That is deliberate and not an
 * optimisation: the release frame is the one the player pressed, and a barrage
 * whose first shell arrived three frames later would feel like input lag on the
 * loudest moment in the game.
 *
 * @param scene    where the projectiles go
 * @param power    the banked power the dash was bought with, 0..1. NOT the
 *                 meter — tryStrike has already zeroed that by release time.
 * @param level    stats.musselVolleyLevel
 * @param dashDir  { x, y } the dash heading, already normalized
 * @param originFor (index, dirX, dirY) -> THREE.Vector3-ish launch point. A
 *                 callback rather than a point, because the emit points walk
 *                 across the seal's flippers and only main.js owns that rig —
 *                 and because it is now asked again on every shell's own frame,
 *                 which is what walks the launch site along the dash.
 * @param hooks    { onLaunch(index, x, y, dirX, dirY, speed) }
 */
export function fireMusselBarrage(scene, power, level, dashDir, originFor, hooks = {}) {
  if (!barrageReady(power, level)) return 0;

  const c = CONFIG.musselVolley;
  // Clone Warz and the charge's pips are applied HERE rather than inside
  // barrageCount, which stays a pure level -> shells function for the card text
  // and the tuner readout. The barrage is already gated on being owned by
  // barrageReady above.
  const count = barrageShells(level, power, player.stats);
  const damage = abilityDamage(barrageDamage(level));
  const splash = barrageSplash(level);
  const heading = Math.atan2(dashDir.y, dashDir.x);
  const gap = shellGap(count, strikeState.dashDuration ?? 0);

  for (let i = 0; i < count; i++) {
    // Evenly across the arc, centred on the heading — a lone shell sits dead
    // centre rather than at one edge of the fan. Random jitter on top so two
    // barrages never trace the same eight curves.
    //
    // Rolled NOW, for every shell, rather than when each one leaves: the fan is
    // a property of the release, and a shell that picked its lane three frames
    // late would be aiming out of a barrage that no longer exists.
    const lane = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
    const angle = heading + lane * c.arc * 0.5 + (Math.random() * 2 - 1) * c.spread;
    queued.push({
      // The first shell is due on this frame; `drain` fires everything at or
      // below zero, so a gap of 0 collapses the whole thing back to the single
      // loud moment it used to be.
      due: i * gap,
      index: i,
      dirX: Math.cos(angle),
      dirY: Math.sin(angle),
      speed: c.speed * (1 + (Math.random() * 2 - 1) * c.speedJitter),
      damage,
      // Snapshotted with the shell, like its damage, rather than re-read when
      // it lands: a barrage's blast is a property of the release that bought
      // it, and a level taken mid-flight must not resize a shell already in
      // the water.
      splash,
      scene,
      originFor,
      hooks,
    });
  }
  drain(0);
  return count;
}

/**
 * Age the queue and throw whatever is due.
 *
 * Called every frame from main.js with the SCALED dt — the same clock the dash
 * itself runs on — so hitstop holds the barrage and the dash together instead
 * of the shells marching on through a frozen frame.
 */
export function updateMusselVolley(dt) {
  if (!queued.length) return;
  drain(dt);
}

function drain(dt) {
  // EVERY entry is examined, not just the front of the line, and that is the
  // whole reason this is a compacting sweep rather than a splice: two barrages
  // can overlap (the eat-and-strike loop releases again well inside a previous
  // dash's flight), and the newer one's first shell is due NOW while the older
  // one still has shells owed. Stopping at the first entry that isn't due yet
  // would hold the new barrage's opening shot behind the old barrage's tail —
  // input lag on the loudest frame in the game, visible only in the one case
  // the mechanic is built to reward.
  //
  // Front to back, so order within a barrage survives: the lanes were queued
  // across the fan, and firing them out of order would put its edges in the
  // middle of the line.
  let write = 0;
  for (let i = 0; i < queued.length; i++) {
    const shell = queued[i];
    shell.due -= dt;
    if (shell.due <= 0) { launch(shell); continue; }
    queued[write] = shell;
    write += 1;
  }
  queued.length = write;
}

function launch(shell) {
  const c = CONFIG.musselVolley;
  // Asked on THIS frame, which is what walks the launch point down the dash.
  const origin = shell.originFor(shell.index, shell.dirX, shell.dirY);

  shell.hooks.onLaunch?.(shell.index, origin.x, origin.y, shell.dirX, shell.dirY, shell.speed);

  spawnProjectile(shell.scene, {
    origin,
    dir: new THREE.Vector2(shell.dirX, shell.dirY),
    faction: 'player',
    damage: shell.damage,
    speed: shell.speed,
    life: c.life,
    radius: c.radius,
    pierce: 0,
    splashDamage: shell.splash?.damage ?? 0,
    splashRadius: shell.splash?.radius ?? 0,
    // ITS OWN BANG. Without this the blast borrowed `bigKill` — the event a
    // creature DYING fires — so a barrage read as eight things dying whether
    // or not anything did, and the loudest moment the strike can buy sounded
    // like the ordinary one. See CONFIG.feedback.musselBlast.
    splashFx: 'musselBlast',
    asset: 'missile',
    // Its own source tag, not 'missile': the playtest report has to be able
    // to say whether the barrage earned its pick, and folding it into the
    // missile's numbers would hide that behind a weapon most runs also have.
    source: 'musselVolley',
    orient: true,
    homing: true,
    // Longer delay than a standard missile, for a different reason: the shells
    // need to visibly BE a volley before the seekers pull them apart. Homing
    // that engages instantly collapses the fan into a single stream within a
    // few frames of launch — and now that the launch points walk along the
    // dash, it would collapse the LINE too.
    homingDelay: c.homingDelay,
    turnRate: c.turnRate,
    acquireRadius: c.acquireRadius,
  });
}
