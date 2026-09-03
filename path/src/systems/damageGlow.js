import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ease } from '../ease.js';

// ============================================================================
// DAMAGE GLOW — a field that is hurting something is brighter than one that
// is not.
//
// The auras in this game are persistent: the shrimp ring circles you for the
// whole run, the garlic cloud is always on, a charmed body wears its note ring
// until the charm lapses. All three are drawn at one brightness whether they
// are grinding through a school or floating in empty water — so the one moment
// they are actually earning their card looks exactly like every other moment,
// and the player learns nothing from watching them.
//
// This is the shared rule instead: a hit stokes HEAT, heat decays, and heat is
// pushed straight into brightness — an emissive lift on a model, an HDR
// overdrive on a flat colour. The bright pass thresholds on luminance at
// CONFIG.bloom.threshold, so a hot enough field haloes as well as brightens
// and the damage reads from the corner of the eye.
//
// ONE RULE, THREE SURFACES, and it has to stay that way: an aura that flares
// on its own numbers is a fourth thing to learn. `CONFIG.damageGlow` carries
// the shared envelope and one row per source for the two things that genuinely
// differ — how bright the peak is, and what colour it goes.
//
// THE HEAT IS PURE ARITHMETIC (stoke/cool/glowLevel), which is what lets the
// harness assert the envelope with no renderer and no model in it — see the
// DAMAGE GLOW section of tools/ability-smoke.mjs, which also stands two meshes
// on one material to prove the per-instance clone below actually clones.
// ============================================================================

const base = () => CONFIG.damageGlow ?? {};

/**
 * The resolved row for one source — the shared envelope with the source's own
 * overrides on top. Falling back to the shared numbers rather than to typed
 * defaults is the point: a source row exists to say what is DIFFERENT about
 * that aura, and a row that only names a colour still follows the one envelope
 * everything else uses.
 */
export function damageGlowCfg(source) {
  const b = base();
  const row = b.sources?.[source] ?? {};
  return {
    enabled: b.enabled !== false,
    perHit: row.perHit ?? b.perHit ?? 0.5,
    fade: Math.max(0.001, row.fade ?? b.fade ?? 0.45),
    peak: row.peak ?? b.peak ?? 2,
    curve: row.curve ?? b.curve ?? 'outCubic',
    color: row.color ?? b.color ?? 0xffffff,
  };
}

/**
 * A hit landed. Returns the new heat, 0..1.
 *
 * `hits` is how many bodies this event caught, so a tick through a school runs
 * the aura hotter than a tick that clipped one crab — the same reasoning the
 * garlic's onTick event already carries a count for. Saturating rather than
 * accumulating without bound: past full heat the difference between ten bodies
 * and thirty is not something a brightness can say.
 */
export function stoke(heat, source, hits = 1) {
  const c = damageGlowCfg(source);
  if (!c.enabled) return 0;
  return Math.min(1, (heat ?? 0) + c.perHit * Math.max(0, hits));
}

/**
 * Carry heat to now. Linear over `fade` seconds rather than exponential: an
 * exponential decay has no end, and "the ring is still faintly warm four
 * seconds after the last fish" is exactly the reading this is meant to prevent.
 */
export function cool(heat, source, dt) {
  const c = damageGlowCfg(source);
  if (!c.enabled) return 0;
  return Math.max(0, (heat ?? 0) - dt / c.fade);
}

/** Heat through the source's curve — what the brightness is actually driven by. */
export function glowLevel(heat, source) {
  const c = damageGlowCfg(source);
  if (!c.enabled) return 0;
  return ease(c.curve, Math.max(0, Math.min(1, heat ?? 0)));
}

/**
 * Give one INSTANCE its own brightness, so the shrimp that just bit is the one
 * that lights up rather than every shrimp on the ring.
 *
 * PER-INSTANCE MATERIALS, and the same trade instantiateBiolumSkin and
 * attachEmissiveCues both make for the same reason: createVisual hands every
 * clone of a key the template's material by reference, so writing it would
 * flare the whole ring at once and the individual that connected would be the
 * least informative thing on screen.
 *
 * Material.clone() DROPS onBeforeCompile — it is a function, and the copy
 * constructor does not carry functions across — so every injected shader in
 * this project (the toon ramp, the outline, biolumSkin) would silently stop
 * running while userData still claimed it was attached. It is carried over
 * explicitly and the program invalidated, exactly as attachEmissiveCues does.
 *
 * TWO KINDS OF MATERIAL, because the ring has both: the shrimp model is lit
 * (MeshStandardMaterial, no emissive of its own — see shrimp.glb) and takes
 * the heat as emissive intensity, while a primitive stand-in is unlit and has
 * no emissive channel at all, so it takes it as HDR overdrive on its colour.
 * `peak` means the same thing in both: how much brightness full heat adds.
 *
 * @returns a handle, or null if nothing here can be brightened — callers are
 *          not expected to check, every method is a no-op on a null handle
 *          because they use `?.`.
 */
export function attachDamageGlow(root) {
  if (!root) return null;
  const owned = [];

  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    // NOT THE OUTLINE SHELL. It is a back-faced copy of the whole body wearing
    // its own material (see assets.js), so overdriving it would light the
    // silhouette rather than the animal — a hot ring around a shrimp that is
    // itself unchanged, which is the opposite read.
    if (o.userData?.__isOutline) return;
    const swap = (mat) => {
      if (!mat || mat.userData?.__isOutline) return mat;
      const lit = 'emissive' in mat && 'emissiveIntensity' in mat;
      if (!lit && !mat.color) return mat;
      // Already instanced: hand it back rather than cloning a clone, so a
      // double attach cannot leave a stale copy driving nothing.
      if (mat.userData.__heatInstance) { owned.push(mat); return mat; }
      const copy = mat.clone();
      if (mat.onBeforeCompile) {
        copy.onBeforeCompile = mat.onBeforeCompile;
        copy.customProgramCacheKey = mat.customProgramCacheKey;
        copy.needsUpdate = true;
      }
      copy.userData.__heatInstance = true;
      copy.userData.__heatLit = lit;
      // What cold looks like, captured before anything is written. Per
      // instance, so the asset-keyed passes (the Look panel, the beat pulse)
      // and this one can never read each other's writes as a new resting
      // level — the same separation attachEmissiveCues keeps.
      copy.userData.__heatEmissive = lit ? (copy.emissive?.getHex?.() ?? 0x000000) : 0;
      copy.userData.__heatIntensity = lit ? (copy.emissiveIntensity ?? 0) : 0;
      copy.userData.__heatColor = copy.color?.getHex?.() ?? 0xffffff;
      // THE TWO LAYERS THIS MATERIAL IS COMPOSED FROM, kept on the material
      // rather than in any handle's closure — see compose() below for why.
      copy.userData.__heatT = 0;
      copy.userData.__heatCfg = null;
      copy.userData.__tint = null;
      owned.push(copy);
      return copy;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });

  if (!owned.length) return null;

  // What was written last, so a cold aura costs nothing: the ring spends most
  // of a run at zero and a material write per shrimp per frame to say "still
  // nothing" is a needsUpdate risk for no picture.
  let wrote = -1;
  let wroteColor = -1;
  let wroteTint = '';

  const handle = {
    /**
     * @param level 0..1 from glowLevel()
     * @param source which row in CONFIG.damageGlow.sources supplies peak/colour
     */
    set(level, source) {
      const t = Math.max(0, Math.min(1, level || 0));
      const c = damageGlowCfg(source);
      if (t === wrote && (t === 0 || c.color === wroteColor)) return;
      wrote = t;
      wroteColor = c.color;
      for (const m of owned) {
        m.userData.__heatT = t;
        m.userData.__heatCfg = t > 0 ? c : null;
        compose(m);
      }
    },
    /**
     * THE STATUS LAYER — what the body is WEARING, under whatever heat is on
     * it. A frozen fish is blue and a poisoned one is green for as long as the
     * status lasts, which is a different thing from a hit's flash: it is a
     * resting state, and the heat above rides on top of it and hands back to
     * it when it cools rather than to the template's own colour.
     *
     * Composed with the heat rather than written beside it because both land
     * on the SAME cloned materials — attachDamageGlow hands an already
     * instanced material back rather than cloning a clone — so two writers
     * with last-write-wins deciding would be a burn erasing a poison every
     * frame. See systems/statusFx.js for the caller.
     *
     * @param color     hex, or null to take the layer off
     * @param body      0..1 how far the material's own colour moves toward it
     * @param emissive  0..1 how far a lit material's emissive colour moves
     * @param intensity emissive intensity added at emissive = 1; an unlit
     *                  stand-in takes it as colour overdrive instead
     */
    setTint(color, body = 0, emissive = 0, intensity = 0) {
      const on = color != null && (body > 0 || (emissive > 0 && intensity > 0));
      const key = on ? `${color}|${body.toFixed(3)}|${emissive.toFixed(3)}|${intensity.toFixed(3)}` : '';
      if (key === wroteTint) return;
      wroteTint = key;
      const tint = on ? { color, body, emissive, intensity } : null;
      for (const m of owned) {
        m.userData.__tint = tint;
        compose(m);
      }
    },
    /** Back to cold. Called when the instance goes away or the run ends. */
    release() { handle.set(0, null); },
    /** The status layer off. A body released to the pool must not keep it. */
    releaseTint() { handle.setTint(null); },
    /** For the harness and the look pages. */
    get materials() { return owned; },
  };

  return handle;
}

const _rest = new THREE.Color();
const _tintCol = new THREE.Color();

/**
 * WRITE ONE MATERIAL FROM ITS TWO LAYERS.
 *
 * The rest state is the template's colour, moved toward the status tint by
 * however much of it there is; the heat is then laid over that. A lit material
 * takes the status as colour AND as emissive — a frozen body is blue in the
 * shadow and faintly lit blue — while heat replaces the emissive outright for
 * as long as it lasts, which is what "a bolt landing on a poisoned shark still
 * flashes white" means. An unlit stand-in has one channel for all of it and
 * takes both as overdrive on the tinted colour.
 */
function compose(m) {
  const d = m.userData;
  const tint = d.__tint;
  const t = d.__heatT ?? 0;
  const c = d.__heatCfg;
  const body = tint ? Math.max(0, Math.min(1, tint.body)) : 0;
  const em = tint ? Math.max(0, Math.min(1, tint.emissive)) : 0;
  if (tint) _tintCol.setHex(tint.color);
  if (d.__heatLit) {
    if (m.color) {
      m.color.setHex(d.__heatColor);
      if (body > 0) m.color.lerp(_tintCol, body);
    }
    const restIntensity = d.__heatIntensity + (tint ? em * tint.intensity : 0);
    if (t > 0 && c) {
      m.emissive.setHex(c.color);
      m.emissiveIntensity = restIntensity + c.peak * t;
    } else {
      _rest.setHex(d.__heatEmissive);
      if (em > 0) _rest.lerp(_tintCol, em);
      m.emissive.copy(_rest);
      m.emissiveIntensity = restIntensity;
    }
  } else if (m.color) {
    // Overdrive past 1 rather than a tint toward the hot colour: an unlit
    // material has no other way to cross the bright pass, and pulling the
    // hue over instead would recolour the shrimp rather than lighting it.
    m.color.setHex(d.__heatColor);
    if (body > 0) m.color.lerp(_tintCol, body);
    const over = 1 + (t > 0 && c ? c.peak * t : 0) + (tint ? em * tint.intensity : 0);
    m.color.multiplyScalar(over);
  }
}
