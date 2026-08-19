import { CONFIG } from '../config.js';
import { ease } from '../ease.js';
import { advanceCycles } from './beatSync.js';
import { getAssetMaterials, hasModel } from '../assets.js';

// ============================================================================
// EMISSIVE PULSE — an asset's own glow, breathing on the beat grid.
//
// One row in CONFIG.emissivePulse per asset key, read here every frame. The
// whole system is four lines of arithmetic; everything below it is the two
// things that are easy to get wrong.
//
// IT WRITES A SHARED MATERIAL, AND THAT IS THE POINT. createVisual clones the
// template's meshes but hands every clone the SAME material by reference (only
// biolumSkin assets get their own), so one write here reaches every roll of
// cash in the water at once. Which is what a beat-synced flash wants: forty
// objects pulsing in unison read as the music moving them, and the
// per-individual phase offset that a school of fish needs — phaseOffset in
// beatSync.js — is exactly the wrong tool here. It also means the cost is per
// ASSET rather than per projectile: two materials a frame, whatever is in the
// air.
//
// IT DOES NOT OWN THE LEVEL, only the shape of it. The multiplier is applied
// to whatever the material's resting emissiveIntensity is, which starts as the
// asset def's `material.emissiveIntensity` and becomes the Look panel's glow
// slider the moment anybody drags it. Keeping the two apart is why the base is
// re-read whenever the property does not match what this file last wrote:
// setAssetGlow assigns emissiveIntensity directly, and without that check the
// next frame would overwrite the drag and the slider would look broken.
// ============================================================================

// asset key -> cycle position, in [0, 1). Kept per key rather than derived
// fresh each frame because advanceCycles needs the previous value to integrate
// a FREE-running row; a synced one ignores it and reads the transport.
const cycles = new Map();

/**
 * The multiplier at a point in the cycle.
 *
 * The cycle is folded into a triangle first — up over `attack`, down over the
 * rest — and the named curve is applied to that, so one row covers both shapes
 * this needs to make. A short attack with an `out` curve is a flash on the beat
 * (fast up, long fall); an attack near 0.5 with `smoothstep` is a swell. Doing
 * it the obvious way instead, easing the raw cycle, can only ever produce a
 * sawtooth that snaps back to the floor on the downbeat — which is a strobe,
 * not a pulse.
 *
 * Exported for the harness, which asserts the bounds and the shape without
 * standing up a material.
 */
export function pulseLevel(cfg, cycle) {
  const min = cfg.min ?? 1;
  const max = cfg.max ?? 1;
  // Clamped away from both ends: at 0 the rise is a division by zero, at 1
  // there is no fall at all and the level sits at `max` forever.
  const a = Math.min(0.999, Math.max(0.001, cfg.attack ?? 0.1));
  const t = cycle < a ? cycle / a : 1 - (cycle - a) / (1 - a);
  return min + (max - min) * ease(cfg.curve ?? 'outCubic', t);
}

/**
 * Carry every pulsing asset to now.
 *
 * Raw dt, like every other beat-synced effect: an object's own light has no
 * business stopping because the game froze for 60ms on a hit. Call after
 * updateBeatSync, which is what moves the transport this reads.
 */
export function updateEmissivePulse(rawDt) {
  const table = CONFIG.emissivePulse;
  if (!table) return;
  const on = table.enabled !== false;

  for (const key of Object.keys(table)) {
    const cfg = table[key];
    // `enabled` lives in the same object, so anything that is not a row is
    // skipped rather than assumed to be one.
    if (!cfg || typeof cfg !== 'object') continue;
    // hasModel rather than a bare getAssetMaterials: that helper falls back to
    // BUILDING a procedural material for a key with no model loaded, so asking
    // every frame before the assets are in would allocate a stand-in material
    // per key and then pulse something that is not on screen.
    if (!hasModel(key)) continue;

    let mul = 1;
    if (on) {
      const next = advanceCycles(cycles.get(key) ?? 0, cfg.pulseSync, cfg.pulseRate ?? 1, rawDt, 1);
      cycles.set(key, next);
      mul = pulseLevel(cfg, next);
    } else {
      cycles.delete(key);
    }

    for (const m of getAssetMaterials(key)) {
      if (!('emissiveIntensity' in m)) continue;
      // WHOSE VALUE IS IN THERE? Ours, if it is exactly what we wrote last
      // frame — nothing else touches this property between frames, and the
      // comparison is against a number we assigned rather than one we
      // computed, so there is no float drift to be tolerant of. Anything else
      // means the Look panel (or the asset's own def, on the first frame) has
      // set a new resting level, and that becomes the base.
      if (m.userData.__pulseWrote !== m.emissiveIntensity) {
        m.userData.__pulseBase = m.emissiveIntensity;
      }
      // Switched off, the material goes back to its resting glow and stays
      // there. Left at whatever the last frame happened to compute, turning
      // the pulse off would freeze every roll mid-flash — a control that looks
      // like it did nothing, or worse, like it broke the look.
      const v = (m.userData.__pulseBase ?? m.emissiveIntensity) * mul;
      m.emissiveIntensity = v;
      m.userData.__pulseWrote = v;
    }
  }
}

// ============================================================================
// EMISSIVE CUES — the same surface, driven by events instead of by the beat.
//
// The block above is an ASSET's glow breathing on the transport: shared
// materials, one continuous cycle, forty rolls of cash flashing as one object.
// This is the opposite half of the same idea and it is here, in this file,
// because it writes THE SAME PROPERTY. Two files both assigning
// emissiveIntensity would fight over it every frame, and the `__pulseWrote`
// base-tracking above would read the other one's write as the artist dragging
// the glow slider — so the resting level would ratchet. One writer per field.
//
// WHAT AN EVENT CUE NEEDS THAT A BEAT PULSE DOES NOT:
//
//   PER-INSTANCE MATERIALS. A telegraph says "THIS animal is about to do
//   something". createVisual hands every clone the template's material by
//   reference, so writing it would flare every anglerfish in the water on the
//   boss's wind-up — the tell would be the least informative thing on screen.
//   So `attachEmissiveCues` clones per instance, the same trade
//   instantiateBiolumSkin makes for the same reason.
//
//   AN ENVELOPE, not a cycle. A tell has a beginning and an end and has to
//   land ON the frame the attack commits. advanceCycles is the wrong clock —
//   it is phase-locked to the music, and an attack that had to wait for the
//   downbeat would be a fight about the transport rather than about the boss.
//
//   TWO LAYERS. There is a state the animal is IN (lurking, travelling, dark)
//   and things that HAPPEN to it (a wind-up completing, a hit landing). `hold`
//   sets the first, `fire` plays the second over the top, and the level taken
//   is whichever is BRIGHTER — so a one-shot can never make a bright animal
//   momentarily dimmer, which is the specific way a max-less crossfade reads
//   as a glitch.
//
//   WHICH IS WHY GOING DARK IS A HOLD, NOT A FIRE, and getting that wrong is
//   the bug this note exists to prevent. The anglerfish's recovery — the light
//   going out, which is the whole punishable window — was written as a fire
//   descending from the travel level. Under the max rule it did exactly
//   nothing: the travel hold was still 2.4, the descending cue was below it
//   from its first frame, and the animal simply stayed bright through the one
//   stage it is supposed to be dark in. Nothing errored and the envelope was
//   correct in isolation. A level the animal SETTLES at is a hold; a transient
//   over the top is a fire. So `hold` ramps rather than snapping — from
//   wherever the level is now to the new row's `to`, over its `attack` — and a
//   state change reads as the light moving rather than cutting.
//
// IT IS NOT A LIGHT. Nothing here illuminates anything: it scales an emissive
// map that the model already carries, which is why the anglerfish is the asset
// this was built against — the esca and the photophore rows are painted into
// its atlas, so raising the level lights the lure and the dot rows and nothing
// else. On a model whose emissive map is blank this does nothing at all, and
// does it silently, which is correct: there is no glow to cue.
// ============================================================================

// Every live handle, so the tuner can rebuild envelopes mid-fight and so a
// reset can put every borrowed material back. WeakRef because a boss that dies
// is dropped by the enemy list and should not be kept alive by this.
const cueHandles = new Set();

/**
 * The envelope level at `t` seconds into a cue.
 *
 * attack -> hold -> release, all in seconds, so a cue's shape is stated in the
 * same units as the thing it is telegraphing: a 0.7s wind-up gets a 0.7s
 * attack and the peak lands on the frame the boss commits. Returns null once
 * the cue is spent, which is how `fire` knows to drop back to the hold layer.
 *
 * Exported for the harness, which asserts the shape without standing up a
 * material or a boss.
 */
export function cueLevel(cfg, t) {
  const a = Math.max(0, cfg.attack ?? 0.12);
  const h = Math.max(0, cfg.hold ?? 0);
  const r = Math.max(0, cfg.release ?? 0.25);
  const from = cfg.from ?? 1;
  const to = cfg.to ?? 2;
  if (t < 0) return from;
  if (t < a) return from + (to - from) * ease(cfg.curve ?? 'outCubic', a > 0 ? t / a : 1);
  if (t < a + h) return to;
  if (t < a + h + r) return to + (from - to) * ease(cfg.releaseCurve ?? cfg.curve ?? 'outCubic', r > 0 ? (t - a - h) / r : 1);
  return null;
}

/** Total seconds a cue occupies, so callers can line a stage up with its tell. */
export function cueDuration(cfg) {
  return Math.max(0, cfg?.attack ?? 0.12) + Math.max(0, cfg?.hold ?? 0) + Math.max(0, cfg?.release ?? 0.25);
}

const cueCfg = (name) => CONFIG.emissiveCues?.[name] ?? null;

/**
 * Give one INSTANCE its own emissive level, driven by named cues.
 *
 * @param root  an object from createVisual
 * @returns a handle, or null if this model has no emissive channel to drive —
 *          callers are not expected to check, since every method on the handle
 *          is a no-op when there is nothing to write.
 */
export function attachEmissiveCues(root) {
  if (!root) return null;
  const owned = [];

  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const swap = (mat) => {
      if (!mat || !('emissiveIntensity' in mat)) return mat;
      // Already instanced for cues: hand it back rather than cloning a clone,
      // so a double attach cannot leave a stale copy driving nothing.
      if (mat.userData.__cueInstance) { owned.push(mat); return mat; }
      const copy = mat.clone();
      // Material.clone() DROPS onBeforeCompile — it is a function and the copy
      // constructor does not carry functions across. Every injected shader in
      // this project rides on it (biolumSkin, the toon ramp, the outline), and
      // losing one is invisible: the clone renders, just without whatever the
      // injection was doing, while userData still claims it is attached. So it
      // is carried over explicitly and the program is invalidated.
      if (mat.onBeforeCompile) {
        copy.onBeforeCompile = mat.onBeforeCompile;
        copy.customProgramCacheKey = mat.customProgramCacheKey;
        copy.needsUpdate = true;
      }
      copy.userData.__cueInstance = true;
      // The level this instance rests at. Captured from the template BEFORE
      // anything is written, so it survives the boss being cued and released
      // — and it is per instance, so the asset-keyed pass above (which only
      // ever sees template materials through getAssetMaterials) and this one
      // cannot end up reading each other's writes as a new resting level.
      copy.userData.__cueBase = mat.emissiveIntensity ?? 1;
      owned.push(copy);
      return copy;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });

  if (!owned.length) return null;

  let hold = null;          // { name, cfg, t, from } — the state the animal is in
  let fire = null;          // { name, cfg, t } — something happening to it
  let level = 1;

  const handle = {
    /** The sustained layer. Same name twice is a no-op, so it is safe per frame. */
    hold(name) {
      if (hold?.name === name) return;
      const cfg = cueCfg(name);
      // Ramps FROM the level showing right now, not from the previous row's
      // resting value — a hold changed mid-fire (the lunge's commit spike into
      // the recovery, which is exactly when it happens) would otherwise jump
      // down to the old baseline for a frame before starting its fade.
      hold = cfg ? { name, cfg, t: 0, from: level } : null;
    },
    /** A one-shot over the top. Re-firing restarts it. */
    fire(name) {
      const cfg = cueCfg(name);
      if (!cfg) return false;
      fire = { name, cfg, t: 0 };
      return true;
    },
    /** Drop the one-shot layer without touching the hold. */
    clearFire() { fire = null; },
    update(dt) {
      if (CONFIG.emissiveCues?.enabled === false) { level = 1; write(1); return; }
      // The hold layer is a level, not an envelope: `to` is where it sits, and
      // an optional throb rides on top of it so a lurking animal is visibly
      // alive rather than simply lit.
      let v = 1;
      if (hold) {
        const c = hold.cfg;
        const to = c.to ?? 1;
        const a = Math.max(0, c.attack ?? 0.25);
        hold.t += dt;
        // The ramp, then the settled level. `>= a` rather than a clamped
        // fraction so a row with attack 0 lands on `to` immediately instead of
        // dividing by zero.
        v = hold.t >= a ? to : hold.from + (to - hold.from) * ease(c.curve ?? 'outCubic', a > 0 ? hold.t / a : 1);
        // The throb rides on the settled level only. Applied during the ramp it
        // would wobble the fade, which reads as the light failing rather than
        // as the animal breathing.
        if (c.throbRate > 0 && hold.t >= a) {
          hold.phase = ((hold.phase ?? 0) + dt * c.throbRate) % 1;
          v += (c.throbDepth ?? 0) * Math.sin(hold.phase * Math.PI * 2);
        }
      }
      if (fire) {
        fire.t += dt;
        const f = cueLevel(fire.cfg, fire.t);
        if (f == null) fire = null;
        // Brighter of the two — see the TWO LAYERS note above.
        else v = Math.max(v, f);
      }
      level = v;
      write(v);
    },
    /** What the envelope is at right now, for the harness and the look page. */
    get level() { return level; },
    stage() { return { hold: hold?.name ?? null, fire: fire?.name ?? null, level }; },
    /** Put every material back to its resting level and stop driving them. */
    release() {
      write(1);
      cueHandles.delete(handle);
    },
  };

  function write(mul) {
    for (const m of owned) {
      const base = m.userData.__cueBase ?? 1;
      m.emissiveIntensity = base * mul;
    }
  }

  cueHandles.add(handle);
  return handle;
}

/** Every handle back to rest — called when a run ends. */
export function resetEmissiveCues() {
  for (const h of [...cueHandles]) h.release();
  cueHandles.clear();
}
