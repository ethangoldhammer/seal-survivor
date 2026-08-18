import { CONFIG } from '../config.js';
import { feedback } from './feedback.js';
import { flashPlayerOutlineDamage } from './outlines.js';
import { flashEyeLightsDamage } from './eyeLights.js';

// Everything that happens to the presentation when the SEAL takes damage. One
// door, so every source of player damage — a bullet, a crab's claw, a body
// chewing on you, a lightning strike — arrives on screen the same way and can
// be tuned in one place (CONFIG.fx.playerDamage).
//
// It exists because damage reaches the game in two completely different shapes
// and the difference is invisible at the call site.
//
//   A LUMP   a bullet or a trap enemy's claw: one number, on one frame.
//   A RATE   contact with a body. systems/combat.js hands over
//            contactDamage * dt, so a megalodon's 42/second reaches us as
//            0.70 on a 60fps frame and 0.35 at 120.
//
// Any threshold applied to a single call therefore answers a question about
// FRAMERATE rather than about damage — which is exactly how being eaten alive
// ended up completely silent. main.js used to gate the hit feedback on
// `dmg > 1`, and at 60fps that needs a contact rate above 60/second; the
// hungriest thing in the game is the megalodon at 42. So no contact damage in
// the game has ever made a sound, thrown a particle or shaken the camera. You
// could be ground down to zero by a shark with nothing on screen to say so.
//
// So nothing is thresholded per call. Damage ACCUMULATES, and the pile is spent
// as one hit once it is worth showing.
//
// The other half of the job is the opposite problem. Standing in a school takes
// damage from six fish on the same frame, and six sounds, six shakes and six
// rim flashes are not six hits — they are a smear, and the sound in particular
// just sums into a loud mush. The accumulator is thrown as a SINGLE impact and
// then re-arms after `minGap`, so no matter how many things are touching you
// the mix and the camera see one hit every sixth of a second — and the hit they
// see is as big as everything that landed inside the window. Same reasoning as
// `sfxMinGap` in feedback.js, applied to the whole event rather than the sound.
//
// The first hit after a quiet moment always fires on the frame it lands: the
// gap throttles what piles up BEHIND an impact, it never delays one. So six
// fish on the same frame make one sound at the size of the first of them, and
// the other five arrive together as one heavier hit a sixth of a second later.
// Deferring the whole frame's damage to a flush at the end of it would combine
// them perfectly, and is not worth what it costs: the flinch and the tail shove
// read this function's return value on the spot, and a hit that lands a frame
// after the bite is a hit that no longer looks like it came from the bite.
//
// Everything downstream is scaled by the fraction of the health bar the hit
// cost, not by raw damage. Max HP moves a long way over a run (Blubber stacks),
// and 20 damage taken at 300 HP is not the emergency the same 20 was on wave
// one — a readout in raw damage would call them the same thing.

// Damage banked since the last one that was shown.
let pool = 0;
// Real seconds until another hit may be shown. See `minGap`.
let gap = 0;

export function resetPlayerDamageFx() {
  pool = 0;
  gap = 0;
}

/**
 * Run down the throttle. REAL seconds — a hit-stop is fired BY this system, and
 * a gap measured in game time would be stretched by the freeze it caused.
 */
export function updatePlayerDamageFx(realDt) {
  if (gap > 0) gap = Math.max(0, gap - realDt);
}

/**
 * The seal took `dmg`. Bank it, and show a hit if the pile is worth one.
 *
 * Presentation only — it does not touch player.hp. The caller owns the health,
 * because the caller is also the one that has to notice it hit zero.
 *
 * @param {number} dmg   damage taken, whole or a per-frame slice of a rate.
 * @param {number} maxHp the CURRENT max, i.e. player.stats.maxHp — upgrades
 *                       move it, and the whole point is to read as a fraction
 *                       of the bar the player is actually looking at.
 * @param {object} at    { x, y } where the seal is, for the particles.
 * @returns {number}     the damage this hit was worth — everything banked since
 *                       the last one, not just `dmg` — or 0 if nothing was
 *                       shown. The caller uses it for the flinch, so the shove
 *                       matches the hit that was actually displayed rather than
 *                       the frame-slice that happened to trip it.
 */
export function playerDamageFx(dmg, maxHp, at = {}) {
  if (!(dmg > 0)) return 0;
  const cfg = CONFIG.fx?.playerDamage ?? {};

  pool += dmg;
  if (gap > 0) return 0;

  // Guarded rather than trusted: a caller that hasn't built its stat block yet
  // would otherwise divide by zero and hand every channel an Infinity, which
  // reaches the camera as NaN and parks the view off the edge of the world.
  const hp = maxHp > 0 ? maxHp : 1;
  // The floor is a fraction of the BAR, so it holds its meaning as max HP
  // grows: without it a fish brushing past at 3/second would clear any fixed
  // amount inside a couple of frames and fire the full hit treatment six times
  // a second forever.
  if (pool < (cfg.minFraction ?? 0.012) * hp) return 0;

  const spent = pool;
  const lost = pool / hp;
  pool = 0;
  gap = cfg.minGap ?? 0.16;

  const base = cfg.base ?? 0.35;
  const scale = Math.min(cfg.max ?? 2, base + lost * (cfg.gain ?? 4));

  // `scale` is the one number the feedback table multiplies everything by, so
  // the shake, the spray of blood, the grid ripple, the bloom pulse and the
  // volume of the grunt all come off the same reading of how bad it was.
  feedback('playerHit', { x: at.x ?? 0, y: at.y ?? 0, scale });

  // The rim saturates sooner than the camera does — see `flashFraction`. It is
  // the channel you can actually read mid-fight, so it should be at full red
  // well before the shake is at full rattle.
  const flash = Math.min(1, Math.max(
    cfg.minFlash ?? 0.3,
    lost / Math.max(0.001, cfg.flashFraction ?? 0.3),
  ));
  flashPlayerOutlineDamage(flash);
  // The eyes go red on the same reading, through this same door. Two surfaces,
  // one measure of how bad it was — the eye is the thing you are already
  // looking at while you aim, and the rim is the thing you can find anywhere
  // on screen. Unlike the rim, red takes the eye OUTRIGHT rather than being
  // added over a wind-up glow; see the priority note in systems/eyeLights.js.
  flashEyeLightsDamage(flash);
  return spent;
}
