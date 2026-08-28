import { CONFIG } from '../config.js';
import { attachDamageGlow, stoke, cool, glowLevel } from './damageGlow.js';

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

// body -> { heat, glow, source }. A Map keyed on the creature itself, so a body
// that dies and is recycled cannot inherit the last one's heat — the same
// reason beams.js keys its per-target cooldowns this way.
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
 * A tick of sustained damage landed on `e`.
 *
 * The handle is attached LAZILY, on the first tick rather than at spawn.
 * attachDamageGlow clones a material per mesh, and a roster where every body
 * paid that on the chance it might one day be beamed would be hundreds of
 * clones for a weapon most runs never take.
 *
 * `hits` rides through to stoke() as a multiplier on the row's perHit, which is
 * how a big body is made to climb slowly without a second envelope: see
 * `bossClimb`.
 */
export function sear(e, hits = 1) {
  if (cfg().enabled === false) return false;
  // hp is checked here as well as in the sweep. A tick that lands on the frame
  // a body dies would otherwise attach a handle to a corpse the kill light is
  // about to take over, and the two would write the same materials.
  if (!e || !e.mesh || e.hp <= 0) return false;

  let s = burning.get(e);
  if (!s) {
    if (burning.size >= MAX) return false;
    // The VISUAL where there is one, the mesh otherwise — the same choice
    // bossLight makes, and for the same reason: the container carries the
    // position and has no materials on it at all.
    const root = e.visual?.isObject3D ? e.visual : (e.mesh?.isObject3D ? e.mesh : null);
    const glow = root ? attachDamageGlow(root) : null;
    if (!glow) return false;
    s = { heat: 0, glow, source: sourceFor(e) };
    burning.set(e, s);
  }
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
    s.glow?.set(glowLevel(s.heat, s.source), s.source);
    // Cold: drop the entry so an arena that has been fought through does not
    // carry a per-body write forever. The materials stay instanced on the body
    // — that is a one-time cost already paid, and re-searing the same creature
    // gets them back rather than cloning a clone.
    if (s.heat <= 0) burning.delete(e);
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

/** How many bodies are burning. */
export function burnCount() {
  return burning.size;
}
