import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ease } from '../ease.js';
import { hdr, glowSprite } from './beams.js';

// ============================================================================
// WHAT A DECK GUN LOOKS LIKE — the tell, the shot, and the landing.
//
// The boats were the only gun in the game with no picture attached to any of
// it. A boss winds up behind a charge ring at its muzzle (systems/bossPerks.js
// GUNS / the `windup` stage), fires something that reads as ordnance, and the
// hit lands with a burst. A boat did all three of those things invisibly: the
// 0.45s wind-up had nothing on screen at all, the thing thrown was an ordinary
// dark fish against dark water, and the only evidence it had hit you was the
// health bar moving.
//
// THREE MOMENTS, ONE LAMP. All of it is the same additive sprite — the radial
// falloff systems/beams.js already paints once for the fin laser's halo — and
// the three differ only in colour, size and what drives them:
//
//   TELL     rides the muzzle for the whole wind-up, blinking, and the blink
//            ACCELERATES. A steady light says "a boat is there"; a light whose
//            rate is climbing says "now", and it says it without needing the
//            player to have counted the first blink.
//   SHOT     a fixed halo parented to the thing in the water, so a fish thrown
//            at you is lit and a fish swimming past you is not. Nothing per
//            frame: it is written once at spawn off a SHARED material, because
//            a shot's glow never changes and the arena holds a stream of them.
//   IMPACT   a hard bright pop where it landed on the seal, over in a sixth of
//            a second. This is the one that answers "what just took a third of
//            my bar" — see combat.js, where it fires.
//
// WHY THE TELL AND THE IMPACT ARE POOLED AND THE SHOT IS NOT. Both of those
// animate their own opacity and scale, so each needs a material of its own —
// and three.js refcounts a linked program by its materials, so building and
// disposing one per event relinks the identical shader every time (the measured
// case is in the note above the material cache in systems/beams.js). A free
// list instead: a handful ever exist, they are handed back, and the program is
// never released. The shot's halo has no per-instance state at all, so it takes
// the cached material and costs nothing.
//
// PEAK-CHANNEL NORMALISED (hdr), not luminance. These are three fixed warm
// colours rather than a hue roll, so the failure luminance-normalising exists
// to fix — a saturated blue that refuses to bloom — cannot happen here, and the
// peak is what the composite's soft shoulder actually reads. See the note above
// hdrInto in systems/beams.js.
//
// EVERY BUILD IS GUARDED. glowSprite() paints into a 2D canvas context and a
// Node harness has none (tools/dom-stub.mjs), so this throws from inside
// three.js in every headless test that fires a deck gun. Losing a halo is the
// right failure for a look; taking the harness down over one is not — the same
// call dressBolt in systems/finLaser.js makes, for the same reason.
// ============================================================================

const fxCfg = () => CONFIG.boats?.guns?.fx ?? {};

// One material per colour+overdrive, for the halo that never changes. Never
// disposed: see the header, and the measured note in systems/beams.js.
const sharedMats = new Map();
function sharedMaterial(hex, overdrive) {
  const key = `${hex}|${overdrive}`;
  let mat = sharedMats.get(key);
  if (!mat) {
    const map = glowSprite();
    if (!map) return null; // no 2D canvas — headless
    mat = new THREE.SpriteMaterial({
      map,
      color: hdr(hex, overdrive),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    sharedMats.set(key, mat);
  }
  return mat;
}

/**
 * THE SHOT'S OWN HALO. Called once per projectile, straight after the volley
 * spawns it.
 *
 * SIZED OFF THE ROUND, NOT IN WORLD UNITS. A fixed number was the first thing
 * tried and it is wrong in both directions at once: the five things a deck gun
 * throws span 0.76 to 2.5 units on screen, so one halo is a fireball with a
 * fish somewhere inside it AND a glow entirely swallowed by the gull. Measured
 * instead — the mesh's own long axis, which already carries `fit`, the row's
 * `scale` and whatever assets.csv's size multiplier did to it — then clamped,
 * because a halo proportional to the body all the way down is no halo at all on
 * the smallest round.
 *
 * The measurement is in WORLD units and the sprite is parented to the root, so
 * it is divided back out by the root's own scale: a sprite's scale is local,
 * and a model's `fit` lives on a grandchild rather than on the root (see
 * createVisual), so the root's scale is exactly what the sprite inherits.
 *
 * Growing a child is what takes this shot out of the instance pool, and that is
 * handled rather than assumed: entities/projectiles.js re-reads the
 * qualification every frame and puts a dressed shot back into the scene graph.
 */
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
export function dressBoatShot(mesh) {
  const fx = fxCfg();
  if (!mesh || fx.enabled === false) return null;
  const c = fx.shot ?? {};
  try {
    const mat = sharedMaterial(c.color ?? 0xffb347, c.overdrive ?? 1.9);
    if (!mat) return null;
    // BEFORE the sprite is added, or the halo's own bounds are in the answer —
    // the same order dressBolt measures its nose in.
    mesh.updateMatrixWorld(true);
    _box.setFromObject(mesh);
    const long = _box.isEmpty() ? 0 : Math.max(_box.getSize(_size).x, _size.y);
    const world = Math.min(c.maxSize ?? 3.2,
      Math.max(c.minSize ?? 0.9, long * (c.sizeMul ?? 2.2)));
    const sprite = new THREE.Sprite(mat);
    const s = Math.max(1e-3, mesh.scale.x || 1);
    sprite.scale.setScalar(world / s);
    // IN FRONT OF THE BODY IT IS LIGHTING. Left at the root's origin the halo
    // is drawn INSIDE the round and the round's own opaque geometry wins the
    // depth test over the brightest part of it — the mussel, which is a fat
    // near-black shell, came out as a black hole in the middle of an orange
    // ring. A ring is not a glow, and it is exactly what a bug in the sprite
    // would look like.
    //
    // Depth testing is left ON, deliberately: this is light coming off a thing
    // in the water, not a readout, so a creature swimming between it and the
    // camera is entitled to cover it. Moving it clear of its OWN body is all
    // that is wanted, and `margin` past the box's front face is what a fringe
    // of fur or fin needs so a corner of the animal does not clip back through.
    sprite.position.z = (_box.max.z - mesh.position.z) / s + (c.standoff ?? 0.15);
    sprite.name = 'boatShotGlow';
    mesh.add(sprite);
    return sprite;
  } catch { return null; } // no 2D canvas — see the header
}

// ---------------------------------------------------------------------------
// THE POOL — sprites that animate, and therefore own their material
// ---------------------------------------------------------------------------
const free = [];
const flashes = []; // live impact pops: { sprite, t, life, from, grow }

/**
 * A sprite of its own, out of the free list.
 *
 * `depthTest` is the one thing the two callers disagree about, and they are
 * both right. The TELL is light on the water coming off a boat — a creature
 * swimming between it and the camera is entitled to cover it, and a warning
 * that shone through the whole arena would be the only object in the game that
 * did. The IMPACT is not light, it is a confirmation: it answers "what just
 * took a third of my bar", it lasts a sixth of a second, and it happens ON the
 * seal, which is the one body always in front of it. There is no standoff that
 * clears a body the flash is inside, so the flash is simply allowed through —
 * the same call the threat rings make (systems/organicRing.js), for the same
 * reason and with the same cost, which is that it cannot be hidden behind
 * anything.
 */
function acquire(scene, hex, overdrive, depthTest = true) {
  let sprite = free.pop();
  if (!sprite) {
    const map = glowSprite();
    if (!map) return null; // headless
    sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
  }
  sprite.material.color.copy(hdr(hex, overdrive));
  sprite.material.opacity = 1;
  // Set per acquisition rather than per sprite: these come off one free list, so
  // a flash reusing a tell's sprite would otherwise inherit the tell's answer.
  sprite.material.depthTest = depthTest;
  sprite.visible = true;
  scene.add(sprite);
  return sprite;
}

function release(scene, sprite) {
  if (!sprite) return;
  scene.remove(sprite);
  sprite.visible = false;
  free.push(sprite);
}

// ---------------------------------------------------------------------------
// THE TELL
// ---------------------------------------------------------------------------
/**
 * Hold the wind-up light at (x, y, z) for hull `b`, `t` of the way through.
 *
 * Acquires on the first frame of a wind-up and is handed back by
 * `clearBoatTell`, which updateBoatGun calls on every path out of the stage —
 * including the abandoned one, where the seal crossed the surface and the shot
 * was never fired. A tell left burning over a gun that stood down is worse than
 * no tell at all: it teaches the player that the light means nothing.
 *
 * THE BLINK ACCELERATES rather than brightening alone. `blinkFrom` -> `blinkTo`
 * in blinks per second across the wind-up, on a squared ramp so the last
 * quarter of it is where the rate really goes — which is the quarter the player
 * has to react in.
 */
export function boatTell(dt, scene, b, x, y, z, t, ref = 1) {
  const fx = fxCfg();
  if (fx.enabled === false) { clearBoatTell(scene, b); return; }
  const c = fx.tell ?? {};
  if (!b.tell) {
    b.tell = acquire(scene, c.color ?? 0xff8a3c, c.overdrive ?? 3.2);
    b.tellPhase = 0;
    if (!b.tell) return;
  }
  const u = Math.max(0, Math.min(1, t));
  const rate = (c.blinkFrom ?? 3) + ((c.blinkTo ?? 11) - (c.blinkFrom ?? 3)) * u * u;
  // Phase is CARRIED rather than derived from `t * rate`: with the rate itself
  // climbing, a phase computed from the elapsed time runs backwards through the
  // ramp and the light stutters. Integrating the rate is the only way the
  // blinks stay blinks while their spacing shortens.
  b.tellPhase = ((b.tellPhase ?? 0) + rate * dt) % 1;
  const blink = 0.5 - 0.5 * Math.cos(b.tellPhase * Math.PI * 2);
  const floor = c.minAlpha ?? 0.12;
  b.tell.material.opacity = (floor + (1 - floor) * blink) * ((c.from ?? 0.45) + (1 - (c.from ?? 0.45)) * u);
  // SIZED OFF THE HULL, for the reason the halo above is sized off the round: a
  // trawler is two-thirds longer than a fishing boat and an artillery trawler
  // longer again, and a light in fixed world units is a warning that shrinks as
  // the thing warning you gets bigger. `ref` is the hull's half-length.
  b.tell.scale.setScalar(Math.max(c.minSize ?? 1.2, ref * (c.sizeMul ?? 0.5))
    * ((c.growFrom ?? 0.7) + (1 - (c.growFrom ?? 0.7)) * u));
  b.tell.position.set(x, y, z ?? 0);
}

/** The wind-up light off. Safe on a hull that never lit one. */
export function clearBoatTell(scene, b) {
  if (!b?.tell) return;
  release(scene, b.tell);
  b.tell = null;
}

// ---------------------------------------------------------------------------
// THE LANDING
// ---------------------------------------------------------------------------
/**
 * A deck gun's shot went off on the seal. Fired from systems/combat.js, at the
 * bullet rather than at the player, so a shot clipped on its edge pops on the
 * edge it clipped.
 */
export function boatImpactFlash(scene, x, y, z = 0) {
  const fx = fxCfg();
  if (fx.enabled === false) return null;
  const c = fx.impact ?? {};
  // NOT DEPTH-TESTED — see acquire. The shot that caused this is in the seal's
  // own z plane, so there is no standoff that puts the pop clear of the animal
  // it landed on.
  const sprite = acquire(scene, c.color ?? 0xffe6b0, c.overdrive ?? 4.2, false);
  if (!sprite) return null;
  const from = c.size ?? 3.6;
  sprite.position.set(x, y, z + (c.standoff ?? 0));
  sprite.scale.setScalar(from);
  flashes.push({ sprite, t: 0, life: Math.max(0.01, c.life ?? 0.18), from, grow: c.grow ?? 2.2, curve: c.curve ?? 'outCubic' });
  return sprite;
}

/** Carry every live pop to now. Called from updateBoats. */
export function updateBoatShotFx(dt, scene) {
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.t += dt;
    const u = f.t / f.life;
    if (u >= 1) { release(scene, f.sprite); flashes.splice(i, 1); continue; }
    const e = ease(f.curve, u);
    // Grows as it dies. A pop that shrinks reads as something being sucked in;
    // this one is a thing going off.
    f.sprite.scale.setScalar(f.from * (1 + (f.grow - 1) * e));
    f.sprite.material.opacity = 1 - e;
  }
}

/** Everything back to the free list. Called from resetBoats. */
export function resetBoatShotFx(scene) {
  for (const f of flashes) release(scene, f.sprite);
  flashes.length = 0;
}

/** For the harness. */
export function boatShotFxStats() {
  return { flashes: flashes.length, pooled: free.length, shared: sharedMats.size };
}
