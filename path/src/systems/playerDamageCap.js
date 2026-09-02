import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// HOW MUCH OF THE BAR ONE SECOND MAY COST, from everything in the water at
// once. See CONFIG.player.damageCap for the argument; this file is the
// arithmetic.
//
// IT IS THE SECOND CEILING AND NOT A REPLACEMENT FOR THE FIRST. capBossDamage
// (systems/boss.js) bounds what a BOSS may take off you and is deliberately
// blind to everything else — which is correct for what it is for, and is
// exactly why it cannot see the shape that actually ends runs. A hammerhead
// hit that throws you into a wall, past a barracuda pack, into a pin, is five
// sources on four channels, and the only thing that ever looked at the total
// was the health bar going to zero.
//
// So this is the same rolling window, source-blind and channel-blind. The two
// stack by construction: a boss's damage is trimmed by its own ceiling first
// and then counted against this one, so the boss cap stays the tuning and this
// stays the backstop.
//
// WHY IT TRIMS AND DOES NOT REFUSE. Refusal is the i-frame answer, and it is
// the wrong tool here: 'attack' and 'contact' damage are rates and sequences
// that other systems are built on top of — the slam's three prices, the pin's
// ramp, a beam burning through you — and switching them off in bursts would
// both delete those mechanics and read as the damage flickering. Trimming
// leaves every one of them firing, every effect on screen, and takes only the
// arithmetic off the top.
//
// EVERY CHANNEL PAYS IN, INCLUDING THE ONES IT CANNOT REFUSE. That is the
// point: a second of pin damage is a real second of the bar and has to be
// visible to the ceiling, or the one source with no exit is the one source
// that never counts.
// ---------------------------------------------------------------------------

let window = [];

/** Sum of everything still inside the window, dropping what has aged out. */
function spentSince(cutoff) {
  let total = 0;
  // Backwards, so the splice below is one contiguous cut off the front rather
  // than a shift per entry. Entries are pushed in time order and never
  // reordered, so the first one inside the window is the boundary.
  let firstLive = window.length;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].t <= cutoff) break;
    total += window[i].d;
    firstLive = i;
  }
  if (firstLive > 0) window.splice(0, firstLive);
  return total;
}

/**
 * TRIM A HIT TO WHAT THE SECOND HAS LEFT.
 *
 * Called from onPlayerHit AFTER capBossDamage, so a boss's share is already
 * its own ceiling's answer and this only ever sees figures the game has agreed
 * to deal. Returns the damage to actually bill — the original when there is
 * room, a smaller number when there is not, and 0 when the second is spent.
 *
 * `capped` in the result says whether it trimmed, which is the caller's cue to
 * arm the grace window. It is reported rather than done here because the
 * i-frame clock lives on the player and this file has no business writing it.
 *
 * @param dmg    what the source wants to take
 * @param maxHp  the seal's CURRENT maximum, so a player who bought health gets
 *               a ceiling that grew with them and the fraction keeps meaning
 *               the same thing all run
 * @param now    the run clock, the same one capBossDamage is read against
 * @returns {{ damage: number, capped: boolean }}
 */
export function capPlayerDamage(dmg, maxHp, now) {
  const cap = CONFIG.player?.damageCap;
  if (cap?.enabled === false || !(dmg > 0) || !(maxHp > 0)) {
    return { damage: dmg, capped: false };
  }
  const budget = maxHp * (cap?.perSecond ?? 0.9);
  const spent = spentSince(now - (cap?.window ?? 1));
  const room = budget - spent;
  if (room <= 0) return { damage: 0, capped: true };

  const out = Math.min(dmg, room);
  window.push({ t: now, d: out });
  // `out < dmg` rather than `out <= room`: a hit that exactly fills the budget
  // was not trimmed, and telling the player they were spared when they were
  // not is how a mercy rule starts lying about itself.
  return { damage: out, capped: out < dmg };
}

/** What the rolling window is holding, for the harness and the ledger. */
export function playerDamageInWindow(now) {
  const cap = CONFIG.player?.damageCap;
  return spentSince(now - (cap?.window ?? 1));
}

/** A new run starts owing nothing. */
export function resetPlayerDamageCap() {
  window = [];
}
