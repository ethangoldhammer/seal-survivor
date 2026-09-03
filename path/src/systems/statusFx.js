import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { attachDamageGlow } from './damageGlow.js';
import { emit } from '../entities/particles.js';

// ============================================================================
// STATUS LOOKS — what a body WEARING a status looks like, for as long as it
// wears it.
// ============================================================================
// Chill and venom (systems/elements.js) were numbers on the creature and
// nothing else: a fish carrying five stacks of poison looked exactly like a
// clean one between ticks, and a fish frozen solid looked exactly like a fish
// in the beluga's bubble — held, but by nothing you could see. The freeze had
// a burst on the frame it landed and the poison had a hit-pop on every tick,
// and both were EVENTS, over in a frame, on a status that lasts seconds.
//
// This is the STATE half, the same split systems/burnGlow.js makes for the
// beam: a resting look that is on the body while the status is, rather than
// a series of flashes standing in for it.
//
//   FROZEN     the body goes blue and sheds frost the whole time it is ice.
//   CHILLED    the same blue, by how much of its speed the cold has taken,
//              so the freeze is the end of a ramp rather than a switch — the
//              player can see it coming on the body that is about to lock.
//   POISONED   green, deeper with every stack, and every tick of the poison
//              FLASHES the body and sheds a drop of it, so damage-over-time
//              reads as over time.
//
// THE COLOUR IS THE ELEMENT'S. Read from CONFIG.biolum.elements at draw time
// rather than copied here, the same rule CONFIG.boss.attackTypes follows: a
// retune of the chill's colour moves the shot, the ring, the ice and this
// together, and none of them can be left the old blue. The BODY tint is that
// colour pushed to a saturated mid-tone (see bodyTintOf), because the element
// palette is authored bright for pellets and UI and a pale cyan multiplied
// into a texture reads as a slightly dimmer fish rather than as a blue one.
//
// ON THE SAME MATERIALS AS THE BURN. attachDamageGlow hands back the one set
// of per-instance materials a body has, and the tint is a LAYER of that
// handle rather than a second writer on the material — a bolt landing on a
// poisoned shark flashes white over the green and hands back to green when it
// cools. See setTint in systems/damageGlow.js.
//
// LAZY, like the burn: a handle is attached on the first frame a status is
// found on a body, not at spawn, because attaching clones a material per
// mesh and most fish in most runs are never chilled or poisoned.
//
// WHAT IT DOES NOT DO. Nothing here changes a number the game tests against —
// the slow is chillSlow, the hold is trapTimer, the damage is the tick in
// elements.js. This reads all three and writes only materials and particles.
// ============================================================================

const cfg = () => CONFIG.statusFx ?? {};

// body -> { glow, tick, frostDebt }. Keyed on the creature itself for the
// same reason burnGlow's map is: a body that dies and is recycled must not
// inherit the last one's look.
const bodies = new Map();

// A ceiling, like the burn's: every entry holds cloned materials.
const MAX = 96;

const _tint = new THREE.Color();
const _other = new THREE.Color();
// bodyTintOf's own scratch. NOT `_tint`: the composer calls bodyTintOf twice
// while holding the first answer in `_tint`, and sharing one colour between
// them handed every chilled body the venom's green — the first version did.
const _body = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));

/**
 * How chilled a body is, 0..1 — the slow as a share of the most the cold can
 * take. 0 for a body carrying no cold, so a caller can multiply unconditionally.
 */
export function chillLevel(e) {
  if (!e || !(e.chillTimer > 0)) return 0;
  const max = CONFIG.biolum?.elements?.chill?.maxSlow ?? 0.7;
  return max > 0 ? clamp01((e.chillSlow ?? 0) / max) : 0;
}

/**
 * Is this body ICE right now — locked by the cold, not merely slowed by it,
 * and not held by anything else. `freezeTimer` is written only by chillEnemy,
 * which is what lets a bubbled fish stay its own colour.
 */
export function isFrozen(e) {
  return !!e && (e.freezeTimer ?? 0) > 0;
}

/**
 * How poisoned, 0..1. The FIRST stack is worth a real fraction rather than a
 * fifth — one dose has to read as poisoned, or the look only arrives once the
 * focus-fire has already paid off. Every stack after it deepens the green.
 */
export function venomLevel(e) {
  if (!e || !(e.venomTimer > 0)) return 0;
  const max = Math.max(1, CONFIG.biolum?.elements?.venom?.maxStacks ?? 5);
  const first = clamp01(cfg().venom?.firstStack ?? 0.45);
  const stacks = Math.max(1, e.venomStacks ?? 1);
  return first + (1 - first) * clamp01((stacks - 1) / Math.max(1, max - 1));
}

/**
 * THE BODY COLOUR FOR AN ELEMENT: its authored colour pushed to a saturated
 * mid-tone. Multiplied into a texture, the pale pellet colour (0xbdf5ff for
 * chill) barely moves a fish; this is the same hue with enough pigment in it
 * to read as "blue" on skin. The emissive keeps the raw colour, so the light
 * the body gives off still matches the pellets that put it there.
 */
export function bodyTintOf(hex, row = {}) {
  _body.setHex(hex ?? 0xffffff);
  _body.getHSL(_hsl, THREE.SRGBColorSpace);
  const sat = Math.max(_hsl.s, clamp01(row.saturate ?? 0.9));
  const light = clamp01(row.lightness ?? 0.5);
  _body.setHSL(_hsl.h, sat, light, THREE.SRGBColorSpace);
  return _body.getHex(THREE.SRGBColorSpace);
}

function entryFor(e) {
  if (!e || !e.mesh || e.hp <= 0) return null;
  let s = bodies.get(e);
  if (!s) {
    if (bodies.size >= MAX) return null;
    // The VISUAL where there is one, the mesh otherwise — the same choice the
    // burn and the kill light make, and for the same reason: the container
    // carries the position and has no materials on it at all.
    const root = e.visual?.isObject3D ? e.visual : (e.mesh?.isObject3D ? e.mesh : null);
    const glow = root ? attachDamageGlow(root) : null;
    if (!glow) return null;
    s = { glow, tick: 0, frostDebt: 0 };
    bodies.set(e, s);
  }
  return s;
}

/**
 * A TICK OF POISON LANDED ON `e`. Called from the venom branch of
 * updateElements, before the damage is applied, so a tick that kills still
 * shows on the body the burst comes off.
 *
 * The drop is shed whether or not the body can be tinted — a primitive
 * stand-in with no material to write still bleeds green — and the flash
 * re-arms rather than accumulating: two ticks in one frame are one flash.
 */
export function noteVenomTick(e) {
  const c = cfg();
  if (c.enabled === false || !e?.mesh) return false;
  const t = c.venom?.tick ?? {};
  if (t.emitter) {
    emit(t.emitter, e.mesh.position.x, e.mesh.position.y, {
      scale: t.scale ?? 1,
      sizeMul: bodyScaleOf(e, t),
      vx: e.vx ?? 0, vy: e.vy ?? 0,
    });
  }
  const s = entryFor(e);
  if (!s) return false;
  s.tick = 1;
  return true;
}

// How big this body's particles are, relative to a fish of the reference
// radius — a frozen shark sheds bigger frost than a frozen sardine, within a
// band so neither end vanishes or fills the screen.
function bodyScaleOf(e, row = {}) {
  const ref = Math.max(0.05, row.refRadius ?? cfg().refRadius ?? 0.6);
  const r = Math.max(0.05, e?.radius ?? e?.def?.radius ?? ref);
  return Math.max(row.minScale ?? 0.7, Math.min(row.maxScale ?? 2.2, r / ref));
}

/**
 * One frame: read every status, write the look, shed what the body sheds,
 * and let go of anything that is clean or gone.
 *
 * Walks the enemy list rather than the map, because the first frame of a
 * status is exactly the frame no entry exists yet. The map is only ever a
 * subset of the list, so this is one compare per clean fish.
 *
 * @param dt SCALED seconds — the frost and the tick fade ride the water's
 *           clock, so a frozen body under a hit-stop keeps its frost hanging.
 */
export function updateStatusFx(dt, enemiesList) {
  const c = cfg();
  if (c.enabled === false) {
    if (bodies.size) resetStatusFx();
    return;
  }
  const chillRow = c.chill ?? {};
  const venomRow = c.venom ?? {};
  const els = CONFIG.biolum?.elements ?? {};
  const chillHex = els.chill?.color ?? 0xbdf5ff;
  const venomHex = els.venom?.color ?? 0x7dff3d;
  const tickSeconds = Math.max(0.01, venomRow.tick?.seconds ?? 0.24);

  for (const e of enemiesList) {
    const frozen = isFrozen(e);
    const chill = frozen ? 1 : chillLevel(e);
    const venom = venomLevel(e);
    let s = bodies.get(e);
    if (!frozen && chill <= 0 && venom <= 0 && !s) continue;
    if (!s) s = entryFor(e);
    if (!s) continue;

    // --- the cold ---------------------------------------------------------
    // Body and emissive weights. The ramp is the chilled share of the full
    // figure; ice is its own, higher figure, so the lock is a visible step at
    // the top of the ramp and not merely the ramp's end.
    const cBody = frozen ? (chillRow.frozenBody ?? 0.75) : (chillRow.body ?? 0.35) * chill;
    const cEm = frozen ? (chillRow.frozenEmissive ?? 0.9) : (chillRow.emissive ?? 0.5) * chill;
    const cInt = chillRow.intensity ?? 1.2;

    // --- the poison -------------------------------------------------------
    // The tick's flash is laid over the standing green: a spike in the
    // emissive and a little more body, both gone inside a quarter second.
    s.tick = Math.max(0, s.tick - dt / tickSeconds);
    const tick = venom > 0 ? s.tick : 0;
    const vBody = Math.min(1, (venomRow.body ?? 0.5) * venom + (venomRow.tick?.body ?? 0.3) * tick);
    const vEm = Math.min(1, (venomRow.emissive ?? 0.6) * venom + tick * 0.4);
    const vInt = (venomRow.intensity ?? 0.9) + (venomRow.tick?.intensity ?? 2.4) * tick;

    // --- composed -----------------------------------------------------------
    // Both at once — a poisoned fish that gets frozen — is a colour between
    // the two, weighted by how much of each is on it, at the STRONGER of the
    // two weights rather than their sum. Summing would double-dip: a body at
    // full ice and full venom is not twice as tinted as one at full ice.
    const wC = cBody + cEm;
    const wV = vBody + vEm;
    if (wC <= 0 && wV <= 0) {
      s.glow.releaseTint();
    } else {
      const mixV = wV / (wC + wV);
      _tint.setHex(bodyTintOf(chillHex, chillRow));
      _other.setHex(bodyTintOf(venomHex, venomRow));
      // The emissive stays the element's own light; the body carries the
      // pigment. One hex goes into the handle, so the blend is of the BODY
      // colours and the emissive follows it — a frozen body is lit blue by
      // its own tint, which is what ice in dark water does.
      _tint.lerp(_other, mixV);
      const intensity = (wC + wV) > 0 ? (cInt * wC + vInt * wV) / (wC + wV) : 0;
      s.glow.setTint(
        _tint.getHex(),
        Math.max(cBody, vBody),
        Math.max(cEm, vEm),
        intensity,
      );
    }

    // --- what it sheds -----------------------------------------------------
    // Frost, on a rate — carried as debt so a rate under one per frame is not
    // rounded to nothing, the same reason the trails carry theirs. Ice sheds at
    // the full rate; a merely chilled body sheds a trickle scaled by how cold
    // it is, so the ramp is visible off the body and not only on it.
    const frost = chillRow.frost ?? {};
    const rate = frozen
      ? (frost.perSecond ?? 12)
      : (frost.chilledPerSecond ?? 3) * chill;
    if (rate > 0 && frost.emitter) {
      const bodyScale = bodyScaleOf(e, frost);
      s.frostDebt += rate * bodyScale * dt;
      const r = Math.max(0.05, e.radius ?? e.def?.radius ?? 0.5) * (frost.spread ?? 0.8);
      let n = 0;
      while (s.frostDebt >= 1 && n < 8) {
        s.frostDebt -= 1;
        n += 1;
        emit(frost.emitter,
          e.mesh.position.x + (Math.random() * 2 - 1) * r,
          e.mesh.position.y + (Math.random() * 2 - 1) * r,
          { sizeMul: bodyScale, vx: e.vx ?? 0, vy: e.vy ?? 0 });
      }
    } else {
      s.frostDebt = 0;
    }
  }

  // The sweep: gone, or clean. A body that has thawed and shaken off its
  // poison drops its entry so a fought-through arena does not carry a per-body
  // write forever; the materials stay instanced on it, which is a one-time
  // cost already paid, and a second status gets them back rather than cloning
  // a clone. A body released to the pool MUST drop its tint here — the next
  // creature to wear that visual must not spawn blue.
  for (const [e, s] of bodies) {
    const gone = !e || e.hp <= 0 || !e.mesh || !e.mesh.parent;
    const clean = !gone && !isFrozen(e) && chillLevel(e) <= 0 && venomLevel(e) <= 0 && s.tick <= 0;
    if (gone || clean) {
      s.glow?.releaseTint();
      bodies.delete(e);
    }
  }
}

/** Let one body go — a kill, a despawn, a body leaving the arena. */
export function releaseStatusFx(e) {
  const s = bodies.get(e);
  if (!s) return false;
  s.glow?.releaseTint();
  bodies.delete(e);
  return true;
}

/** Everything clean. A run reset. */
export function resetStatusFx() {
  for (const [, s] of bodies) s.glow?.releaseTint();
  bodies.clear();
}

/** How many bodies are wearing a status look. For the harness. */
export function statusFxCount() {
  return bodies.size;
}

/** The venom flash left on one body, 0..1. For the harness. */
export function venomTickFlash(e) {
  return bodies.get(e)?.tick ?? 0;
}
