import { CONFIG } from '../config.js';
import { attachDamageGlow, stoke, cool, glowLevel } from './damageGlow.js';
import { ease } from '../ease.js';

// ============================================================================
// BURN GLOW — a body that is BEING hurt is brighter than one that has been.
// ============================================================================
// systems/damageGlow.js is the same rule pointed at the weapon: a shrimp that
// just bit lights up, a garlic cloud grinding through a school runs hot. This
// file points it at the VICTIM, which is the half that was missing and the half
// a sustained weapon actually needs.
//
// WHY A HIT FLASH IS NOT THIS. Every other weapon in the game resolves in an
// instant, so "you hit it" is announced by an event — an impact sprite, a
// shake, a sound (systems/impactFlash.js, CONFIG.feedback). That vocabulary
// cannot say the thing a beam needs to say. A stream held on a boss for four
// seconds fires forty of those, and forty flashes is not "this is being cut
// open for four seconds", it is a strobe. The player reads a strobe as noise
// and stops seeing it inside a second.
//
// Damage over time needs a STATE, not a series of events: a level that climbs
// while contact is held, sits while it continues, and falls off when it stops.
// That is exactly the heat envelope damageGlow already owns, so this is fifty
// lines of bookkeeping and no new rule to learn.
//
// WHAT IT IS FOR, in the order it matters:
//
//   THE BOSS      A thirty-second fight where the health bar is the only thing
//                 saying anything. The bar is a number in the corner; the
//                 animal is the thing you are looking at, and until now it went
//                 through its whole death looking exactly as it did at full.
//   THE BOATS     Steel. It goes white-hot, which is the one material in the
//                 roster where "being cut" has an obvious visual language.
//   THE SHARKS    Big enough and long-lived enough that a hit flash is lost on
//                 them, and the exact bodies a player wants to know they are
//                 winning against.
//
// WHAT IT IS MADE OF DECIDES WHAT IT DOES, and the axis is one the game already
// committed to: CONFIG.boss.voiceClass sorts every boss into flesh, shell or
// hull for its impact sound. The same three answer "what does it look like
// while it burns" — steel goes white, shell goes hot at the edges, flesh goes
// angry — so this reuses that map rather than inventing a second taxonomy that
// could disagree with the one the player is already hearing.
//
// THE HANDLE IS SHARED WITH systems/bossLight.js AND MUST NOT BE HELD PAST
// DEATH. attachDamageGlow returns the SAME per-instance materials for a root it
// has already instanced, so a burn still writing while the kill light writes is
// two systems fighting over one material with last-write-wins deciding. They do
// not overlap in time — the kill light starts when hp reaches zero and this
// releases on exactly that — and `sweep` below is what makes that a rule rather
// than a coincidence.

const cfg = () => CONFIG.burnGlow ?? {};

// body -> { heat, flash, phase, glow, source }. A Map keyed on the creature
// itself, so a body that dies and is recycled cannot inherit the last one's
// heat — the same reason beams.js keys its per-target cooldowns this way.
//
// TWO ENVELOPES ON ONE HANDLE, because the game has two shapes of laser and
// they say different things:
//
//   heat   The sustained one. A beam held on a body — laser eyes, the bubble
//          jet — climbs while contact lasts and falls off when it stops. See
//          the note above: forty flashes over four seconds is a strobe, and a
//          state is the only vocabulary damage-over-time has.
//   flash  The instant one. A fin-laser BOLT is a single arrival with nothing
//          to sustain, so it gets what every other projectile in the game
//          gets — one hit, one flash — except that this is brightness rather
//          than the scale pop `e.flash` already does.
//
// They share the material handle and the per-class colour, and the write below
// takes whichever is higher: a bolt landing on a body already burning must not
// be able to DIM it.
const burning = new Map();

// A ceiling. One stream can only touch so many bodies at once, and anything
// past this is a leak rather than a fight — every entry holds cloned materials,
// so a Map that only ever grew would be a real one.
const MAX = 64;

/**
 * WHICH ROW DESCRIBES THIS BODY BURNING.
 *
 * Keyed by asset through CONFIG.boss.voiceClass, exactly as the impact voice
 * is, and falling back the same way: an unknown asset is flesh. That fallback
 * is doing real work — voiceClass only lists BOSSES, so every shark, fish and
 * crab in the game arrives here with no row and takes the flesh envelope,
 * which is correct rather than a gap.
 */
export function burnClass(e) {
  const key = e?.assetKey;
  const b = CONFIG.boss ?? {};
  const cls = (key && b.voiceClass?.[key]) || b.voiceDefault || 'flesh';
  return cls;
}

function sourceFor(e) {
  const name = `burn${burnClass(e)[0].toUpperCase()}${burnClass(e).slice(1)}`;
  // A class with no row would silently take the shared envelope, which is a
  // perfectly good look and the wrong one — the whole point of the split is
  // that steel and flesh do not burn alike. Named rather than derived so the
  // fallback is visible.
  return CONFIG.damageGlow?.sources?.[name] ? name : 'burnFlesh';
}

/**
 * FIND OR MAKE THIS BODY'S ENTRY. Shared by both envelopes, so a bolt and a
 * beam landing on the same shark are one set of instanced materials rather
 * than two systems each cloning their own and writing over each other.
 *
 * The handle is attached LAZILY, on the first contact rather than at spawn.
 * attachDamageGlow clones a material per mesh, and a roster where every body
 * paid that on the chance it might one day be shot with a laser would be
 * hundreds of clones for a loadout most runs never take.
 *
 * @returns the entry, or null if this body cannot be brightened at all.
 */
function entryFor(e) {
  // hp is checked here as well as in the sweep. A hit that lands on the frame
  // a body dies would otherwise attach a handle to a corpse the kill light is
  // about to take over, and the two would write the same materials.
  if (!e || !e.mesh || e.hp <= 0) return null;

  let s = burning.get(e);
  if (!s) {
    if (burning.size >= MAX) return null;
    // The VISUAL where there is one, the mesh otherwise — the same choice
    // bossLight makes, and for the same reason: the container carries the
    // position and has no materials on it at all.
    const root = e.visual?.isObject3D ? e.visual : (e.mesh?.isObject3D ? e.mesh : null);
    const glow = root ? attachDamageGlow(root) : null;
    if (!glow) return null;
    // `phase` starts at zero so the bloom BEGINS on the frame contact does —
    // the pulse is meant to read as this body catching light, and a shared
    // clock would have half a school arriving mid-swell. Entries are dropped
    // when they go cold, so re-contact restarts the bloom rather than picking
    // up wherever the last one left off.
    s = { heat: 0, flash: 0, phase: 0, glow, source: sourceFor(e) };
    burning.set(e, s);
  }
  return s;
}

/**
 * A tick of SUSTAINED damage landed on `e` — a beam standing on a body.
 *
 * `hits` rides through to stoke() as a multiplier on the row's perHit, which is
 * how a big body is made to climb slowly without a second envelope: see
 * `bossClimb`.
 */
export function sear(e, hits = 1) {
  if (cfg().enabled === false) return false;
  const s = entryFor(e);
  if (!s) return false;
  // A BIG BODY CLIMBS SLOWLY, and this is the only place the difference lives.
  // Heat saturates at 1, so a boss on the same envelope as a sardine is pinned
  // at full white after two ticks and then says nothing for the remaining
  // twenty-eight seconds of the fight — which is the failure this whole file
  // exists to fix, arriving by a different door.
  const climb = e.isBoss ? (cfg().bossClimb ?? 0.35) : 1;
  s.heat = stoke(s.heat, s.source, Math.max(0, hits) * climb);
  return true;
}

/**
 * A BOLT LANDED — one instant of laser, with nothing behind it to sustain.
 *
 * The other half of `sear`, and the reason it is a separate envelope rather
 * than a very hard stoke: heat's whole shape is a climb over several ticks, so
 * a fin laser firing four times a second through it would arrive as a slow
 * swell that peaks after the burst is over and outlives it by half a second.
 * A bolt is an arrival. It has to be bright on the frame it lands and mostly
 * gone by the next one.
 *
 * IT RE-ARMS RATHER THAN ACCUMULATING. Two bolts in one frame are one flash,
 * and a stream of them is a shimmer at the cadence the weapon is firing —
 * which is the honest picture. Adding them would pin a body at full white for
 * as long as the trigger was held, which is what `sear` is for and is a
 * different weapon.
 *
 * The colour and the peak are still the body's own material class, so a boat
 * shot with a laser goes the same white-hot it goes under a beam.
 *
 * @param strength 0..1 — how hard this one landed. The split's shards are
 *                 worth less than the bolt that made them.
 */
export function zap(e, strength = 1) {
  if (cfg().enabled === false) return false;
  const s = entryFor(e);
  if (!s) return false;
  s.flash = Math.min(1, Math.max(s.flash, strength));
  return true;
}

/**
 * THE LOOPING BLOOM, 0..1 — what a body being held in a beam breathes to.
 *
 * A held beam wants to say "this is STILL happening", and a flat level cannot:
 * once it has climbed it is a constant, and a constant is something the eye
 * stops reporting within about a second. The pulse is what keeps it alive
 * without becoming the strobe this file exists to avoid — slow enough to read
 * as a bloom rather than a flicker, and shallow enough that it never falls
 * back to cold between swells.
 *
 * ASYMMETRIC, on the same attack/release vocabulary CONFIG.emissivePulse uses
 * for the yacht's money: light arrives faster than it leaves, and a plain sine
 * reads as a body wobbling in brightness rather than as one catching fire over
 * and over.
 */
function pulseAt(phase) {
  const p = cfg().pulse ?? {};
  const attack = Math.min(0.9, Math.max(0.02, p.attack ?? 0.28));
  const t = phase % 1;
  return t < attack
    ? ease(p.rise ?? 'outCubic', t / attack)
    : 1 - ease(p.fall ?? 'inOutQuad', (t - attack) / (1 - attack));
}

/**
 * One frame: cool everything, write what it looks like, and let go of anything
 * that is cold or gone.
 *
 * WRITTEN EVERY FRAME RATHER THAN ONLY WHEN STOKED, because the fall is most of
 * the effect. A level that only moved on a hit would snap to cold the instant
 * the beam left, which reads as a light being switched off rather than as
 * something cooling.
 */
export function updateBurnGlow(dt) {
  if (!burning.size) return;
  const p = cfg().pulse ?? {};
  const depth = p.enabled === false ? 0 : Math.min(1, Math.max(0, p.depth ?? 0.34));
  const rate = Math.max(0, p.rate ?? 2.2);
  const flashSeconds = Math.max(0.01, cfg().flashSeconds ?? 0.13);
  const flashPeak = Math.max(0, cfg().flashPeak ?? 0.9);
  const flashCurve = cfg().flashCurve ?? 'outCubic';
  for (const [e, s] of burning) {
    // GONE, OR DYING. Released rather than left to cool, and this is the line
    // that keeps the handoff to systems/bossLight.js honest: the kill light
    // attaches to the same root and gets the same instanced materials back, so
    // a burn still writing them on the frame after death is two systems
    // fighting with last-write-wins deciding which is visible.
    if (!e || e.hp <= 0 || !e.mesh || !e.mesh.parent) {
      s.glow?.release();
      burning.delete(e);
      continue;
    }
    s.heat = cool(s.heat, s.source, dt);
    s.flash = Math.max(0, s.flash - dt / flashSeconds);
    s.phase = (s.phase + dt * rate) % 1;

    // THE SUSTAINED HALF, breathing. The pulse SCALES the level rather than
    // being added to it, so a body that is barely warm swells barely and a
    // cold one does not flicker at all — the bloom has to be a property of the
    // burn, not a light of its own running beside it.
    const sustained = glowLevel(s.heat, s.source)
      * (1 - depth + depth * pulseAt(s.phase));
    // THE INSTANT HALF. Its own clock, unpulsed: a flash that breathed would
    // be over before the first swell finished.
    const flash = s.flash > 0 ? flashPeak * ease(flashCurve, s.flash) : 0;

    // WHICHEVER IS BRIGHTER, never the sum. A bolt landing on a body already
    // held in a beam must not be able to dim it (which the pulse's trough
    // would do on a max of the two if the flash were written alone), and two
    // brightnesses added would put a burning boat well past the point where
    // emissive stops being light on a body and becomes a flat coloured cutout
    // in the shape of it.
    s.glow?.set(Math.max(sustained, flash), s.source);

    // Cold: drop the entry so an arena that has been fought through does not
    // carry a per-body write forever. The materials stay instanced on the body
    // — that is a one-time cost already paid, and re-searing the same creature
    // gets them back rather than cloning a clone.
    //
    // BOTH envelopes have to be out. A body dropped while its flash was still
    // running would leave the last written brightness on the material with
    // nothing left to take it back down.
    if (s.heat <= 0 && s.flash <= 0) burning.delete(e);
  }
}

/** Let one body go — a kill, a despawn, a body leaving the arena. */
export function releaseBurn(e) {
  const s = burning.get(e);
  if (!s) return false;
  s.glow?.release();
  burning.delete(e);
  return true;
}

/** Everything cold. A run reset. */
export function resetBurnGlow() {
  for (const [, s] of burning) s.glow?.release();
  burning.clear();
}

/** How hot one body is, 0..1. For the harness and the F panel's readout. */
export function burnHeat(e) {
  return burning.get(e)?.heat ?? 0;
}

/** How much bolt-flash is left on one body, 0..1. The other envelope. */
export function burnFlash(e) {
  return burning.get(e)?.flash ?? 0;
}

/** How many bodies are burning. */
export function burnCount() {
  return burning.size;
}
