import { CONFIG } from '../config.js';
import { player } from '../entities/player.js';
import { hitCreature } from './hitShape.js';
import { addCharge } from './strike.js';
import { feedback } from './feedback.js';

// ---------------------------------------------------------------------------
// GETTING OUT OF THE WAY — and being paid for it.
//
// Every boss in this game commits. The four chasing archetypes lock a line at
// the end of a wind-up and run it (lungeChase in entities/enemies.js); the
// kraken crushes; the anglerfish strikes off the seabed; the lunge perk drives
// whatever is wearing it down a fixed heading. In all five cases the animal
// spends a second or so unable to follow you, and the entire skill of the
// fight is reading that second and not being where it ends.
//
// UNTIL NOW THAT PAID NOTHING. A dodged pass and a pass that never happened
// were worth exactly the same: no damage taken. The good outcome was the
// ABSENCE of the bad one, which is the shape of a fight you survive rather
// than one you play — and it is why a boss fight was the one stretch of a run
// where the boost meter only ever went down. Nothing in the water to eat, the
// bar empties, and the mechanic the fight most wants (repositioning) is the
// one the fight takes away.
//
// So a clean dodge refills the boost. It closes the loop the arena's food
// already closes everywhere else: strike -> eat -> strike out of water, and
// strike -> dodge -> strike in a boss fight.
//
// ---------------------------------------------------------------------------
// IT IS POLLED, NOT PUSHED.
// ---------------------------------------------------------------------------
// Five systems commit a boss to a run and they do it five different ways. The
// obvious build is a noteCommit/noteRelease pair called from each, and it is
// the wrong one: five call sites is five places for a sixth archetype to be
// forgotten, and the failure mode is silent — a boss whose dodges simply never
// pay, indistinguishable from a player who never dodged.
//
// There is already one flag that means "this body is committed", and it means
// it across every one of them. `e.ramming` is set by the perk, the kraken and
// the anglerfish (see the note on it in entities/enemies.js), and the shared
// lunge's own committed stage is `e.lungeStage === 'strike'`. Two tests, read
// once a frame, and a new archetype that commits through either mechanism is
// covered on the day it ships without anybody remembering this file exists.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS A DODGE.
// ---------------------------------------------------------------------------
//   IT MUST HAVE BEEN AIMED AT YOU. A pass that ended half an arena away was
//   not dodged, it was watched. `nearRadii` and `nearPad` are the test: at
//   some point during the run the animal has to have come within about a body
//   of the seal. Measured on the CLOSEST approach across the whole run rather
//   than at its end, because the end of a lunge is by definition the far side.
//
//   IT MUST HAVE MISSED. Any overlap of the body during the run disqualifies
//   it — including one the player took no damage from. Phasing through a boss
//   on strike i-frames is a fine thing to do and is not a dodge.
//
//   AND ONE PASS PAYS ONCE. `cooldown` is per boss, so an archetype with a
//   short cycle cannot fill the bar twice inside one wind-up, and two bodies
//   committing together (the perk on a boss that also lunges) pay for one
//   dodge rather than two.
//
// The refill goes through addCharge rather than restoreCharge because a dodge
// is not a mouthful: restoreCharge books a FOOD CHAIN link for the orb it
// represents, and a dodge that quietly extended a combo would make the chain
// a thing you could hold open by not being hit. It fills the meter and stops
// there; if that crosses the bar to full, fillMeter's own rules decide what
// that is worth, exactly as they do for the sun.
// ---------------------------------------------------------------------------

// Per-creature run state, keyed on the creature itself so nothing has to be
// cleaned up when it dies — a WeakMap forgets a body the moment the arena
// does.
const runs = new WeakMap();
// ...and the cooldown, kept the same way and for the same reason.
const paid = new WeakMap();

// Seconds on the run clock, advanced by updateDodge. Its own clock rather than
// gameState.time because this module is reached by harnesses that have no game
// state, and a cooldown measured against a clock that never moves is a
// cooldown that never expires.
let clock = 0;

export const dodgeState = {
  // Dodges awarded this run, for the harness and for anything that later wants
  // to say so on the score screen.
  dodges: 0,
  // The meter this run's last dodge handed back, 0..1. Read by the test.
  lastRefill: 0,
};

function cfg() {
  return CONFIG.boss?.dodge ?? {};
}

/** A new run starts with nothing dodged and nothing owed. */
export function resetDodge() {
  clock = 0;
  dodgeState.dodges = 0;
  dodgeState.lastRefill = 0;
}

/**
 * Is this creature mid-committed-run right now?
 *
 * BOSSES ONLY. The wildlife sharks and the sailfish carry the same lunge (see
 * `shark.lunge` in the roster), and six of them making passes at once would
 * hand the player a full meter every couple of seconds. The boss is the one
 * committed run a player is meant to be reading.
 */
function committed(e) {
  if (!e.isBoss) return false;
  return e.ramming === true || e.lungeStage === 'strike';
}

/** How close the run had to come for it to have been aimed at the seal. */
function nearRange(e) {
  const c = cfg();
  return e.radius * (c.nearRadii ?? 1.6) + (c.nearPad ?? 6);
}

/**
 * ONE FRAME OF EVERY BOSS'S COMMITTED RUN.
 *
 * @param enemyList the live creatures
 * @param hooks     { onDodge(e, refill) } — optional, for the ledger
 */
export function updateDodge(dt, enemyList, hooks = {}) {
  const c = cfg();
  if (c.enabled === false) return;
  clock += dt;

  const p = player.mesh.position;
  const r = player.stats.hitRadius;

  for (const e of enemyList) {
    const live = committed(e);
    let run = runs.get(e);

    if (live) {
      if (!run) {
        run = { closest: Infinity, touched: false };
        runs.set(e, run);
      }
      const d = Math.hypot(e.mesh.position.x - p.x, e.mesh.position.y - p.y);
      if (d < run.closest) run.closest = d;
      // Measured against the shape, not the circle: a boss's body is three
      // times longer than it is wide, and "did it touch you" asked of a circle
      // is a question about a different animal. See systems/hitShape.js.
      if (!run.touched && hitCreature(e, p.x, p.y, r)) run.touched = true;
      continue;
    }

    // --- THE RUN JUST ENDED ---------------------------------------------------
    if (!run) continue;
    runs.delete(e);
    if (run.touched) continue;
    if (!(run.closest <= nearRange(e))) continue;
    const since = clock - (paid.get(e) ?? -Infinity);
    if (since < (c.cooldown ?? 1.2)) continue;
    paid.set(e, clock);

    const refill = c.refill ?? 1;
    if (!(refill > 0)) continue;
    addCharge(refill, player.stats);
    dodgeState.dodges++;
    dodgeState.lastRefill = refill;
    feedback('bossDodge', { x: p.x, y: p.y });
    hooks.onDodge?.(e, refill);
  }
}
