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
