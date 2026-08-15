import { CONFIG } from '../config.js';

// ============================================================================
// AIR TIME — what leaving the water is worth.
//
// Breaching used to be a movement flourish with two riders bolted on (oxygen
// refills, and a food chain link if Porpoising was taken). The air itself did
// nothing, which made the single most athletic thing in the game a detour from
// the fight rather than a way to fight.
//
// This module turns the arc into a resource on two axes that stack:
//
//   HANG TIME   player.airTime, ramped to 1 over CONFIG.airborne.rampTime.
//   AIR JUMPS   player.airJumps, worth `jumpRamp` each.
//
// They sum into ONE figure, `airRamp()`, capped at `maxRamp`. Everything else
// in the file is that figure spent two ways: LIVE, as multipliers the seal
// carries while it is up there, and BANKED, as the splash-down blast that
// fires when it comes back through the water line.
//
// WHY THE MULTIPLIERS ARE FUNCTIONS RATHER THAN STATS. Every other run-scoped
// number in the game lives in the stat block (stats.js) and is rebuilt by
// recomputeStats(). This one cannot: the stat block is rebuilt on level-up and
// on tuner nudges — a few times a minute — and the air ramp changes every
// frame. Writing it into `player.stats` would mean either recomputing the whole
// block per frame or leaving a field there that lies for minutes at a time.
// So it is read at the point of use, exactly like comboSpeedMul, and every
// consuming site multiplies by a number that is 1 for a seal in the water.
//
// This file imports CONFIG and nothing else, deliberately — the same rule
// stats.js and playtestAnalysis.js follow, so tools/airtime-test.mjs can
// replay the whole curve in Node without three.js.
// ============================================================================

function cfg() {
  return CONFIG.airborne ?? {};
}

/**
 * THE LIVE RAMP, as a module singleton — the same arrangement `strikeState`
 * and `feedbackState` use, and for the same reason.
 *
 * The multipliers below are read from half a dozen places, and one of them
 * (systems/chumMagnet.js) is handed a stat block and a speed, not a player. A
 * getter that demanded the player object would either force a reference
 * through three layers that have no other use for one, or push the caller into
 * recomputing the ramp itself — which is how two call sites end up disagreeing
 * about how much air the seal has.
 *
 * `updateAirborne` is the only writer, called once per frame from main.js
 * before anything reads it.
 */
export const airState = {
  ramp: 0,
};

/**
 * The 0..maxRamp air figure for a player state, or 0 for one in the water.
 *
 * Takes the raw fields rather than the player object so the harness can drive
 * it with plain numbers, and so nothing here can be tempted to reach into the
 * mesh.
 *
 * @param {boolean} aboveSurface
 * @param {number} airTime   seconds since the upward crossing
 * @param {number} airJumps  mid-air relaunches spent this breach
 */
export function airRampFor(aboveSurface, airTime, airJumps) {
  const c = cfg();
  if (!c.enabled || !aboveSurface) return 0;
  // Linear in time and flat after. A curve was tempting here and is wrong: the
  // player is reading this off their own altitude and the trail's brightness,
  // and a ramp that accelerates would make the trail disagree with the arc.
  const hang = Math.min(1, Math.max(0, airTime) / Math.max(0.05, c.rampTime ?? 1));
  const jumps = Math.max(0, airJumps) * (c.jumpRamp ?? 0);
  return Math.min(c.maxRamp ?? 1, hang + jumps);
}

/** The live ramp for the actual player, computed fresh. */
export function airRamp(player) {
  return airRampFor(player.aboveSurface, player.airTime, player.airJumps);
}

/**
 * Advance the ramp and the peak tracker. Called once per frame from main.js,
 * before anything reads the multipliers.
 *
 * The peak is what the splash-down is paid against, and it exists because the
 * payout happens at the BOTTOM of the arc: a jump spent at the apex is the
 * most expensive thing in the mechanic, and reading the live ramp at the moment
 * of impact would refuse to pay for it, because by then the seal has spent half
 * a second falling and nothing has been added since.
 */
export function updateAirborne(player) {
  const live = airRamp(player);
  airState.ramp = live;
  if (live > player.airPeak) player.airPeak = live;
  return live;
}

/**
 * Put the ramp back to nothing. Run start, and any time the seal stops being
 * the thing the multipliers should describe (death, the menus) — a stale ramp
 * left in the singleton would hand the next run's first shot a bonus it did
 * not earn.
 */
export function resetAirborne() {
  airState.ramp = 0;
}

// --- what the ramp scales ---------------------------------------------------
// Each is `1 + ramp * extra`, so a run that never leaves the water multiplies
// by exactly 1 and every call site stays unconditional — the same identity-value
// rule the cross-cutting stats in stats.js follow.

export function airDamageMul() {
  return 1 + airState.ramp * (cfg().damageMul ?? 0);
}

export function airFireRateMul() {
  return 1 + airState.ramp * (cfg().fireRateMul ?? 0);
}

export function airPickupMul() {
  return 1 + airState.ramp * (cfg().pickupMul ?? 0);
}

// --- mid-air jumps ----------------------------------------------------------

/**
 * Whether the seal has a relaunch left. Airborne only — the whole grant is
 * refilled by re-entry (player.js clears `airJumps` on the upward crossing),
 * so this can never hand out a jump in the water.
 */
export function canAirJump(player) {
  const c = cfg();
  if (!c.enabled || !player.aboveSurface) return false;
  return player.airJumps < (c.jumps?.max ?? 0);
}

/**
 * Spend one. Returns the launch velocity and the i-frames it carries, or null
 * if there was nothing left to spend.
 *
 * `dir` is the strike's own aim vector — this IS the strike, fired out of a
 * different tank (see the note in CONFIG.airborne.jumps), so it launches where
 * a strike would have. `upBias` then rotates that toward straight up.
 *
 * Blended as a VECTOR and renormalised, not clamped. That is what keeps the
 * launch SPEED identical in every direction: the bias changes where the jump
 * goes and never how hard it goes, so choosing to dive is a choice about
 * direction rather than a quietly worse jump. At the shipped bias an aim
 * straight down stays a dive — see the note on CONFIG.airborne.jumps.upBias
 * for why that fork is the point.
 */
export function spendAirJump(player, dir) {
  if (!canAirJump(player)) return null;
  const j = cfg().jumps ?? {};
  const bias = Math.min(1, Math.max(0, j.upBias ?? 0));

  let x = (dir?.x ?? 0) * (1 - bias);
  let y = (dir?.y ?? 0) * (1 - bias) + bias;
  const len = Math.hypot(x, y);
  if (len < 1e-6) {
    // Both inputs idle AND a full up-bias of zero. Straight up is the only
    // sensible reading of "jump with no direction", and returning null here
    // instead would eat the input on the one press that most obviously meant
    // something.
    x = 0;
    y = 1;
  } else {
    x /= len;
    y /= len;
  }

  const speed = j.speed ?? 0;
  player.airJumps += 1;
  // The peak follows immediately rather than waiting for the next frame's
  // updateAirborne: the feedback fired at this call site is scaled by the
  // ramp, and a jump that didn't count toward its own burst would read as the
  // second jump being weaker than the first.
  updateAirborne(player);
  return { vx: x * speed, vy: y * speed, invuln: j.invuln ?? 0 };
}

// --- the splash-down --------------------------------------------------------

/**
 * What re-entry is worth, or null for a crossing too small to pay out.
 *
 * `impactSpeed` is the DOWNWARD speed at the water line (positive), which is
 * folded in on top of the banked ramp: dropping in off the top of an arc should
 * land harder than sliding back through the surface, and the two are different
 * skills — one is how long you stayed up, the other is how committed the
 * landing was.
 *
 * Returns damage and radius already multiplied, plus the `scale` every feedback
 * channel is driven by, so the call site never re-derives any of it.
 */
export function slamFor(player, impactSpeed = 0) {
  const c = cfg();
  const s = c.slam ?? {};
  if (!c.enabled || !s.enabled) return null;

  const ramp = Math.max(0, player.airPeak);
  // Suppressed outright rather than fired at a fraction nobody can see. A slam
  // that always happens is a slam that means nothing, and skimming the water
  // line is the single easiest thing to do by accident.
  if (ramp < (s.minRamp ?? 0)) return null;

  const speedMul = Math.min(
    s.speedMax ?? 1,
    1 + Math.max(0, impactSpeed) * (s.speedBonus ?? 0),
  );
  const power = ramp * speedMul;

  return {
    ramp,
    speedMul,
    power,
    damage: (s.damage ?? 0) * power,
    // Radius takes the ramp but NOT the full speed multiplier — a fast landing
    // should hit harder, not reach further. Reach is the thing the player is
    // aiming with, and letting it breathe with impact speed would make the one
    // number they have to aim by unpredictable.
    radius: (s.radius ?? 0) * ramp,
    // The one figure the feedback channels ride. Capped well below where shake
    // and hitstop stop reading as impact and start reading as a fault.
    scale: Math.min(2.2, 0.5 + power),
  };
}
