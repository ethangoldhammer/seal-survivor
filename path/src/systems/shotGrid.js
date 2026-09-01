// ---------------------------------------------------------------------------
// THE SHOT GRID — the basic shot, quantised to the music's bar grid.
//
// Two separate properties, and they fail in different ways:
//
//   TEMPO   the interval between shots is a power-of-two division of
//           CONFIG.music.barSeconds. Owned by snapToBarGrid in music.js and by
//           the multipliers being powers of two in the first place.
//   PHASE   the shots land ON the slot boundaries rather than merely the right
//           distance apart. This file. Tempo without phase is a gun at the
//           music's speed sitting at some arbitrary constant offset from it,
//           which reads as "in time but not with it" and is what the cadence
//           did before this existed.
//
// SCHEDULED AS AN ABSOLUTE SCORE POSITION, NOT AS A COUNTDOWN. A countdown
// ticked by the frame's dt drifts twice over: it fires on the first frame at or
// past zero, which is up to a frame late, and it then re-arms from that late
// moment so the error accumulates — at 60fps that is most of a beat inside two
// minutes, and it is worse on a machine dropping frames, which is exactly when
// nobody can tell a locked gun from a loose one. Re-deriving the next slot from
// the LIVE bar phase after every shot costs one modulo and cannot accumulate:
// a long frame, an upgrade that halves the interval, and a track switch that
// moves the anchor all resolve on the next shot.
//
// The fallback matters as much as the lock. There is no transport before the
// audio context is unlocked, and a player who never enables music never gets
// one at all — so `running: false` runs a plain countdown at the same snapped
// interval. Same cadence, no phase, and nothing about the gun waits on audio.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';
import { barGrid, snapToBarGrid } from './music.js';

// --- dealing a volley out in time -------------------------------------------
// How many TICKS one volley is spread across. 1 is the old behaviour — every
// emit point fires on the same frame. With CONFIG.weapon.alternateFins on it
// is ONE TICK PER PELLET, so the volley is dealt out a stone at a time and the
// scheduler below runs that many times faster. Nothing about the pellet count
// or the damage changes: the same stones leave in the same second, they are
// just spread across the interval instead of landing on top of each other.
//
// SO A PELLET IS A SUBDIVISION. Two flippers on a bar/4 gun is the pair of
// eighth notes this shipped with; the first Pocket Full of Stones makes it
// three, which is bar/12 — a triplet, 3 against the music's 2 — and the second
// makes it four, which is sixteenths. That is the card's whole read: every
// stone you own is a note in the bar rather than a thicker version of the same
// note. `CONFIG.weapon.staggerTicks` is where it stops subdividing; pellets
// past that thicken the ticks the way they always did.
//
// THE INTERVAL IS AN ARGUMENT BECAUSE THE SPLIT CAN FAIL. Dealing a volley out
// over n ticks only preserves the gun's output if the grid can actually hold a
// tick n times finer, and at the top of the ladder it cannot: a Rapid Fire
// stack sitting on bar/64 divides to bar/128, snapToBarGrid clamps that back to
// bar/64, and one fin firing per bar/64 is HALF the gun. Alternation is a look
// and a rhythm; it is not allowed to cost damage, so when the division does not
// land the volley goes back to leaving every fin at once.
function splitFits(volleyInterval, n, maxDivision) {
  if (!(volleyInterval > 0)) return false;
  const tick = snapToBarGrid(volleyInterval / n, maxDivision);
  const cycle = tick * n;
  // Both directions: too long is the clamp above and costs damage, too short
  // would hand the gun free rate. A rung divided by 2 or 3 is another rung
  // wherever the ladder still has room, so on every reachable cadence this is
  // exact and the window is only guarding the arithmetic.
  return cycle > volleyInterval * 0.999 && cycle < volleyInterval * 1.001;
}

// `shots` is the volley's TOTAL pellet count, across every limb — see the note
// on CONFIG.weapon.multishot. It defaults to `origins` so that a caller with
// nothing to say about pellets (and every existing assertion) still describes
// the plain one-per-flipper volley this started as.
//
// COUNTING DOWN, not one attempt. A cycle that does not divide cleanly is not
// a reason to collapse the whole thing back onto one frame: five pellets on a
// bar/4 gun have no rung (bar/20 is not on the ladder), but four do, so the
// gun keeps its sixteenths and the fifth stone rides along on the tick it
// lands on. Only a volley that cannot be split at all goes back to firing
// everything at once.
export function finSplit(origins, volleyInterval, shots = origins) {
  if (CONFIG.weapon.alternateFins === false) return 1;
  if (!(Math.floor(origins) > 1)) return 1;
  const maxDivision = CONFIG.weapon.beatLock?.maxDivision ?? 64;
  // Floored at 1 rather than 2, so `staggerTicks: 1` is a real off switch —
  // the loop below never runs and the volley goes out on one frame.
  const cap = Math.max(1, Math.floor(CONFIG.weapon.staggerTicks ?? 6));
  for (let n = Math.min(cap, Math.max(1, Math.floor(shots))); n >= 2; n--) {
    if (splitFits(volleyInterval, n, maxDivision)) return n;
  }
  return 1;
}

// WHAT LEAVES ON THIS TICK — which limb, and how many stones off it.
//
// Pure, and here rather than in fire() because the interesting part is not the
// spawning: it is that a cycle of these adds up to exactly one volley, spread
// evenly across both flippers, for every pellet count the run can reach. That
// is a property worth asserting, and it is not assertable from main.js.
//
// `cursor` is a free-running tick counter; the returned one is what to hold
// for the next tick. Returns one entry per limb when the volley is not being
// dealt out at all (no rig, the stagger off, or a cadence too fine to divide),
// which is the old simultaneous volley with its pellets split as evenly as
// they go.
export function dealTick(shotCount, ticks, origins, cursor) {
  const shots = Math.max(0, Math.floor(shotCount));
  const limbs = Math.max(1, Math.floor(origins));
  const n = Math.max(1, Math.floor(ticks));
  if (n < 2) {
    const per = Math.floor(shots / limbs);
    const rem = shots - per * limbs;
    const salvo = [];
    for (let o = 0; o < limbs; o++) salvo.push({ o, n: per + (o < rem ? 1 : 0) });
    return { salvo, cursor };
  }
  const c = ((cursor % (n * n * limbs)) + n * n * limbs) % (n * n * limbs);
  const slot = c % n;
  // `base` for every slot and one more for a few of them when the count does
  // not divide — five stones over four ticks is 2,1,1,1, and nothing is dropped
  // or invented in either direction.
  const base = Math.floor(shots / n);
  const surplus = shots - base * n;
  // ...AND WHICH SLOTS THOSE ARE MOVES EVERY CYCLE. Nailed to the first slots,
  // the surplus is nailed to a FLIPPER as well whenever the tick count is even:
  // slot 0 is always the left fin, so a five-stone gun would throw three left
  // and two right for the rest of the run — a 60/40 split that Flippers Up!
  // then makes visible, and that the playtest ledger's fin section reports as
  // the alternation failing. Rotating the window by one slot per cycle hands
  // every slot the extra stone in turn, which is what makes both flippers carry
  // the same number of them over a full wrap.
  //
  // Zero for the whole early game — a volley with no more stones than it has
  // ticks has no surplus at all, and this is the count's tail rather than its
  // shape.
  const rotation = Math.floor(c / n) % n;
  const spot = ((slot - rotation) % n + n) % n;
  return {
    salvo: [{ o: c % limbs, n: base + (spot < surplus ? 1 : 0) }],
    // Wrapped on a COMMON MULTIPLE of all three moduli above — the slot, the
    // rotation and the limb — so none of them jumps when the cursor comes
    // round, and the whole pattern repeats rather than stuttering once every
    // few seconds.
    cursor: (c + 1) % (n * n * limbs),
  };
}

// The interval to hand shotDue, given the volley interval the stats produced.
//
// Re-snapped after the division rather than trusted: bar/4 halved is bar/8 and
// needs no help, but a three-fin model, a triplet rung, or an interval already
// sitting on the finest division the ladder allows all divide into something
// that is NOT a rung — and a tick off the lattice is exactly the "in time but
// not with it" the grid exists to prevent.
export function tickInterval(volleyInterval, origins, shots = origins) {
  const split = finSplit(origins, volleyInterval, shots);
  if (split < 2) return volleyInterval;
  return snapToBarGrid(volleyInterval / split, CONFIG.weapon.beatLock?.maxDivision ?? 64);
}

// ---------------------------------------------------------------------------
// ONE SCHEDULER PER WEAPON.
//
// This was a single set of module-level variables for as long as the basic shot
// was the only thing on the grid. It cannot stay that way now the beams are on
// it too: `due` holds ONE absolute score position and `dueInterval` the one
// interval it was derived from, so two weapons sharing them do not merely
// interfere — the faster one re-derives on every call because the interval it
// reads is the other's, and both end up firing on whichever frame the race
// happened to land on. Nothing throws, and on screen it looks like the lock
// working badly rather than like two guns wearing one clock.
//
// So the state is closed over per instance, and the module-level API below is
// one instance the basic shot owns. Every existing caller — main.js and
// tools/beat-lock-test.mjs — keeps the function it already imports.
export function createShotGrid() {
  // Score position of the next shot. Null means unlocked — nothing has been
  // scheduled yet, or the transport went away underneath us.
  let due = null;
  // The run's FIRST shot is the one that waits for a downbeat; every re-lock
  // after it waits only for the next slot. Both are in phase, and the
  // difference is what the wait costs: a bar is up to 2.265s of a weapon that
  // will not fire, which is fine once at the top of a run and unacceptable
  // every time the aim stick returns to centre mid-fight.
  let opensRun = true;
  // The interval `due` was worked out with. A pick that moves the weapon to
  // another rung has to re-derive: the pending shot was placed on the lattice
  // it has just left, and on a rung change that does not nest — bar/4 to the
  // bar/6 triplet is the common one — every boundary of the old lattice is off
  // the new one. Left alone it is a single shot up to half a slot out, which is
  // audible as a stumble on the pick and was invisible to every assertion that
  // only ever held one interval.
  let dueInterval = 0;
  // The no-transport path.
  let cooldown = 0;

  function reset() {
    due = null;
    dueInterval = 0;
    opensRun = true;
    cooldown = 0;
  }

  /**
   * Whether this weapon fires this frame.
   *
   * Call it EVERY frame of a running game, firing or not: the idle path is what
   * holds the lock, parking the next shot one slot ahead so that resuming fire
   * lands on the grid instead of on the frame the aim came back.
   *
   * @param interval seconds between shots, already snapped to the grid
   * @param mayFire  whether the weapon is allowed to fire at all this frame
   * @param dt       the frame's seconds, for the no-transport fallback only
   */
  function shotDue(interval, mayFire, dt) {
    const lock = CONFIG.weapon.beatLock ?? {};
    const grid = barGrid();

    if (!grid.running || lock.enabled === false) {
      due = null;
      cooldown -= dt;
      if (!mayFire || cooldown > 0) return false;
      cooldown = interval;
      return true;
    }

    // A schedule further out than a bar and a slot is not a schedule this run
    // made — play() puts the transport back to zero, so anything held across a
    // restart points somewhere the clock will not reach for minutes. Re-lock
    // rather than trust it.
    const stale = due != null && (due - grid.pos > grid.bar + interval);

    if (!mayFire || due == null || stale || dueInterval !== interval) {
      const step = opensRun && lock.startOnBar !== false ? grid.bar : interval;
      // Re-deriving on EVERY interval change is safe, including the
      // pathological case of a change every frame: untilNext returns the
      // distance to the next boundary, which shrinks as the clock advances, so
      // `due` lands on the same absolute boundary each time rather than being
      // pushed forward. A guard that only re-derived "when it would be sooner"
      // was the alternative and it keeps the off-lattice shot whenever the
      // weapon slows down.
      due = grid.pos + untilNext(grid.phase, step);
      dueInterval = interval;
      return false;
    }

    if (grid.pos < due) return false;

    opensRun = false;
    // Re-derived from the phase we are at NOW rather than `due + interval`.
    // This is the self-correcting step — see the header.
    due = grid.pos + untilNext(grid.phase, interval);
    dueInterval = interval;
    cooldown = interval;
    return true;
  }

  // What the scheduler is holding, for tests and the debug panel. Score seconds
  // until the next shot, or null when nothing is locked.
  function state() {
    const grid = barGrid();
    return {
      locked: due != null && grid.running,
      opensRun,
      due,
      wait: due == null || !grid.running ? null : due - grid.pos,
    };
  }

  return { shotDue, reset, state };
}

// Score seconds from here to the next boundary of `step`, measured off the bar
// line. Never returns 0: sitting exactly on a boundary means the NEXT one, or a
// weapon held at the gate would fire every frame it was held.
function untilNext(phase, step) {
  if (!(step > 0)) return 0;
  const left = step - (phase % step);
  return left <= step * 1e-4 ? step : left;
}

// THE BASIC SHOT'S OWN. The module-level API is this instance, so main.js and
// every assertion written against it are unchanged.
const basic = createShotGrid();

export function shotDue(interval, mayFire, dt) { return basic.shotDue(interval, mayFire, dt); }
export function resetShotGrid() { basic.reset(); }
export function shotGridState() { return basic.state(); }
