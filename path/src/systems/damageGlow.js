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
// the shared envelope and one row per source for the handful of things that
// genuinely differ — how bright the peak is, what colour it goes, and for a
// FIELD (see the second block below) how hard its noise stirs and how far its
// hue swings.
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
    stir: row.stir ?? b.stir ?? 1.6,
    hue: row.hue ?? b.hue ?? 26,
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

// ============================================================================
// THE OTHER TWO CHANNELS — for the fields, which have somewhere to put them.
//
// Brightness alone is one axis, and on an additive cloud it is the axis the
// bright pass is already using for everything else in the frame: a garlic aura
// grinding a school and a garlic aura sitting in a bloom-heavy patch of water
// look the same from the corner of the eye. A field has two more channels no
// model has, and they cost nothing to drive:
//
//   STIR   how fast the value noise crawls. A cloud that is working churns.
//          This is the one a player reads without looking directly at it,
//          because motion is peripheral and brightness is not.
//   HUE    a rotation, NOT a wash toward the hot colour. The aura stays its own
//          colour — garlic is still green, the calamari front is still pink —
//          it just swings toward the hot end of itself. A wash would recolour
//          the ability, and the player would have to learn a second thing.
//
// WHY A ROTATION AND NOT A LERP TO `color`: `color` is what a MODEL's emissive
// goes (attachDamageGlow), where the body's own albedo is still underneath it.
// A flat additive disc has nothing underneath, so the same lerp there replaces
// the aura outright at full heat. Rotating keeps saturation and identity and
// still moves far enough to be seen beside a cold ring on the same screen.
// ============================================================================

/**
 * How much faster this field's noise should crawl right now, as a MULTIPLIER
 * on its resting rate — 1 when cold.
 *
 * NEVER MULTIPLY AN ACCUMULATED CLOCK BY THIS. `uTime * uSwirl` in a shader,
 * or `n.t * spin * rate` on an orbit, both teleport the moment the rate moves:
 * the phase is rate x elapsed, so raising the rate rewrites where the field has
 * ALWAYS been, and a stir that was meant to read as churn reads as the cloud
 * jumping. Every caller here integrates a phase instead — `flow += dt * rate *
 * stir` — which is why garlic and calamari carry a `uFlow` rather than a
 * `uTime`.
 */
export function glowStir(heat, source) {
  const c = damageGlowCfg(source);
  if (!c.enabled) return 1;
  return 1 + c.stir * glowLevel(heat, source);
}

/** Degrees of hue rotation at this heat. Signed; 0 when cold. */
export function glowHue(heat, source) {
  const c = damageGlowCfg(source);
  if (!c.enabled) return 0;
  return c.hue * glowLevel(heat, source);
}

const _hot = new THREE.Color();

// The luminance the bright pass thresholds on — Rec. 709, see CONFIG.bloom.
// Blue is worth 7% of green to it, which is the fact the rotation below is
// built around.
const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

// AN ORTHONORMAL BASIS FOR THE ZERO-LUMINANCE PLANE — the two directions you
// can move a colour in without changing what it weighs. Built once from the
// weights above: (1,0,0) and (0,0,1) each with their own luminance subtracted
// off the grey axis, then Gram-Schmidt'd so a rotation in this basis is an
// actual rotation rather than a shear.
const [HUE_U, HUE_V] = (() => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };
  const u = norm([1 - LR, -LR, -LR]);
  let v = [-LB, -LB, 1 - LB];
  const k = dot(v, u);
  v = norm([v[0] - k * u[0], v[1] - k * u[1], v[2] - k * u[2]]);
  return [u, v];
})();

/**
 * ROTATE A COLOUR'S HUE, IN DEGREES, WITHOUT CHANGING WHAT IT WEIGHS.
 *
 * POSITIVE GOES UP THE WHEEL — red toward yellow toward green — the same
 * direction SVG's hueRotate turns, so a number can be carried between the two.
 *
 * WHICH WAY IS "HOTTER" IS THEREFORE PER AURA, and the source rows in
 * CONFIG.damageGlow are signed for exactly that reason: red is at BOTH ends of
 * this range, so the garlic cloud's green warms by turning DOWN the wheel
 * toward yellow while the harp's and the calamari's pinks warm by turning UP it
 * toward red. One shared sign would send one of them the wrong way, and the
 * wrong way still looks like a deliberate colour.
 *
 * THE DEGREES ARE NOT HSL DEGREES. This turns the chroma in linear light, where
 * HSL's wheel is a hexagon over gamma-encoded channels; 30 here is in the
 * neighbourhood of 30 there and is not equal to it. Tune by eye, not by
 * matching a number out of a colour picker.
 *
 * Two reasons this is a rotation in the zero-luminance plane rather than
 * getHSL/setHSL:
 *
 * HSL CANNOT HOLD THESE COLOURS. Half the values that arrive here are already
 * above 1 — an aura overdriven into the bright pass, a note colour rolled with
 * deliberate headroom (rollNoteColor) — and a round trip through HSL clamps
 * exactly the headroom that gives them their halo.
 *
 * AND HSL'S L IS NOT LUMINANCE. A rotation that held L constant would swing how
 * hard the aura BLOOMS while claiming to move only its hue, and the brightness
 * channel would stop meaning one thing. Splitting the colour into its grey and
 * its chroma and turning only the chroma holds the luminance fixed to the last
 * bit, which is what keeps the two channels independent — drive both and you
 * get both, drive one and you get exactly one.
 */
export function rotateHue(c, deg) {
  if (!deg) return c;
  // Negated because the basis above comes out left-handed about the grey axis;
  // this is what puts a positive `deg` back on the wheel's own direction.
  const a = (-deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const y = c.r * LR + c.g * LG + c.b * LB;
  // What is left after the grey is taken out weighs nothing, so it lies in the
  // plane HUE_U and HUE_V span — exactly, not approximately.
  const dr = c.r - y;
  const dg = c.g - y;
  const db = c.b - y;
  const p = dr * HUE_U[0] + dg * HUE_U[1] + db * HUE_U[2];
  const q = dr * HUE_V[0] + dg * HUE_V[1] + db * HUE_V[2];
  const p2 = p * cos - q * sin;
  const q2 = p * sin + q * cos;
  c.r = y + p2 * HUE_U[0] + q2 * HUE_V[0];
  c.g = y + p2 * HUE_U[1] + q2 * HUE_V[1];
  c.b = y + p2 * HUE_U[2] + q2 * HUE_V[2];
  // A far enough turn on a saturated colour lands a channel below zero.
  // Negative light is not a thing, and an additive blend would subtract it.
  c.r = Math.max(0, c.r);
  c.g = Math.max(0, c.g);
  c.b = Math.max(0, c.b);
  return c;
}

/**
 * THE WHOLE FLARE FOR A FLAT FIELD, in one call: the aura's resting colour,
 * rotated by the hue channel and then overdriven by the brightness one.
 *
 * One function rather than three lines at each call site, for the reason the
 * GLOW_SOURCE constants exist: three fields each doing their own arithmetic is
 * three auras that drift apart, and the drift looks like tuning.
 *
 * @param out    a THREE.Color to write (allocation-free callers)
 * @param cold   the aura's resting colour, hex or THREE.Color
 * @param heat   raw heat 0..1 — the curve is applied in here
 * @param source the row in CONFIG.damageGlow.sources
 */
export function hotFieldColor(out, cold, heat, source) {
  const c = damageGlowCfg(source);
  const target = out ?? _hot;
  if (typeof cold === 'number') target.set(cold); else target.copy(cold);
  if (!c.enabled) return target;
  const level = glowLevel(heat, source);
  if (level <= 0) return target;
  rotateHue(target, c.hue * level);
  return target.multiplyScalar(1 + c.peak * level);
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
