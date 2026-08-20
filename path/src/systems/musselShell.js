import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';

// THE SHELL AT THE INSTANT IT GOES OFF.
//
// A homing mussel is on screen for up to four seconds and then it is a white
// disc and forty orange chips. Nothing in that moment is the mussel — the
// object the player has been tracking simply stops existing, and the
// detonation reads as "a hit happened here" rather than as "the thing I fired
// arrived". This puts the shell back into its own explosion: the closed body
// is replaced by the open one (ASSETS.musselOpen) for a quarter of a second,
// which pops, tumbles off the hit and shrinks away.
//
// Modelled on systems/impactFlash.js and pooled for the same reason: these
// fire in bursts — a mussel barrage is eight shells and they can land on one
// school inside a frame — and building a clone per detonation would churn
// exactly when the frame is already at its busiest. Oldest-first stealing when
// the pool is dry, because a quarter-second effect means the one being
// recycled is already almost gone, where dropping the NEW one would swallow
// the detonation actually being looked at.
//
// ---------------------------------------------------------------------------
// EVERY PER-SHELL EFFECT HERE IS A TRANSFORM, and that is not a style choice.
//
// createVisual clones a loaded model and the clone SHARES the template's
// material by reference — deliberately, so the Look panel reaches every
// instance at once. So writing `opacity`, `color` or any uniform on one of
// these pooled shells writes it on all of them AND on nothing else, because
// there is only one material: the natural way to fade an effect out would fade
// every mussel on screen in lockstep and leave the material permanently
// transparent for the rest of the run. Same trap as fading one bubble.
//
// Position, quaternion and scale are per-Object3D, so the pop, the tumble, the
// drift and the shrink are all safe. The shrink is why `endScale` exists at
// all — it is the fade, done the only way this material allows.
// ---------------------------------------------------------------------------

const shells = [];
let group = null;
// Null when musselopen.glb failed to load. createVisual answers a missing model
// with its `shape` fallback and ASSETS.musselOpen deliberately declares none,
// so the fallback would be getGeometry's default 0.3 sphere — a grey ball
// appearing at every mussel hit, which looks like a bug in the weapon rather
// than a missing file. Better to draw nothing and say so once.
let available = false;

const _q = new THREE.Quaternion();

/**
 * Build the pool. MUST be called from inside boot(), AFTER preloadAssets — not
 * at module scope beside initImpactFlashes, which is where it looks like it
 * belongs. createVisual before the models are in finds an empty cache and hands
 * back a procedural fallback, and the check below would then read that as "the
 * file is missing" and switch the effect off for the whole session.
 */
export function initMusselShells(scene) {
  if (group) disposeMusselShells(scene);
  // A previous init that bailed on a missing model left the pool empty but did
  // not necessarily leave `group` set, so neither is safe to infer from the
  // other. Both are reset here rather than only in dispose.
  shells.length = 0;
  available = false;
  group = new THREE.Group();
  group.frustumCulled = false;

  const cfg = CONFIG.missile?.shell ?? {};
  const count = Math.max(1, Math.round(cfg.pool ?? 10));

  // BUILT ONCE AT INIT, not on demand. The first clone of a model compiles its
  // material, and doing that on the frame a barrage lands is a hitch on the
  // loudest moment in the run — the same reason every spawn used to allocate a
  // bone texture. These are cheap to hold: one geometry set, shared, six small
  // meshes each.
  for (let i = 0; i < count; i++) {
    const mesh = createVisual('musselOpen');
    // A visual with no model at all comes back as a bare Object3D (unknown
    // asset) or as the primitive fallback. Either way it has no business
    // standing in for a shell — checked on the first one and the whole system
    // stands down.
    if (i === 0) {
      let meshes = 0;
      mesh.traverse((o) => { if (o.isMesh) meshes++; });
      // The open mussel is six meshes; the sphere fallback is one. Anything
      // that isn't the model is not worth drawing.
      available = meshes > 1;
      if (!available) {
        console.warn('[musselShell] /models/musselopen.glb did not load — '
          + 'mussel detonations will show the flash and the debris only.');
        group = null;
        return;
      }
    }
    mesh.visible = false;
    // Above the particles (renderOrder 10) would be wrong: the burst is the
    // thing in front. Left at the default so it depth-sorts against the
    // creature it just hit like any other solid body — this one IS geometry,
    // unlike the flash.
    //
    // `rest` is the scale createVisual just baked in, which is the asset's own
    // `sizeMultiplier` from assets.csv (and anything the Look panel has done to
    // it). Captured because every frame below WRITES scale outright to drive
    // the pop, and setScalar on a raw multiple would throw the asset's own size
    // away — the shell would open at 1x while the mussel that made it flies at
    // 2x. Same shape of mistake as a setScalar that loses the model's fit.
    shells.push({
      mesh, life: 0, maxLife: 0, rest: mesh.scale.x, base: 1,
      spin: 0, axis: new THREE.Vector3(0, 0, 1), vx: 0, vy: 0,
    });
    group.add(mesh);
  }
  scene.add(group);
}

export function disposeMusselShells(scene) {
  if (!group) { shells.length = 0; return; }
  scene.remove(group);
  // Geometry and materials belong to the template these were cloned from, not
  // to the clones — disposing them here would take out every future mussel and
  // the closed shell's siblings with them. The clones themselves are garbage
  // the moment the group is dropped.
  shells.length = 0;
  group = null;
  available = false;
}

/**
 * Pop one shell open at a detonation.
 *
 * @param {number} x
 * @param {number} y
 * @param {object} opts { dirX, dirY }
 *   dirX/dirY  the heading the mussel arrived on, so the open shell keeps the
 *              pose the closed one had and carries a little of its momentum.
 *              Absent, it lies along +X — which is what a hit with no recorded
 *              direction deserves and never looks wrong, since the shell is
 *              tumbling within two frames anyway.
 *
 * THERE IS NO SIZE ARGUMENT, and that is deliberate rather than an omission.
 * The open shell takes its size from its own assets.csv row, which is held
 * equal to the missile's on purpose (see the note there) — so the two states
 * track each other through the Look panel without this call having to measure
 * the projectile and divide its multiplier back out. `pop` is the only thing
 * that scales a detonation, and it is a look, not a property of the hit.
 */
export function spawnMusselShell(x, y, opts = {}) {
  const cfg = CONFIG.missile?.shell ?? {};
  if (!group || !available || cfg.enabled === false) return;

  let s = shells.find((p) => p.life <= 0);
  if (!s) s = shells.reduce((a, b) => (a.life <= b.life ? a : b));

  s.maxLife = Math.max(0.02, cfg.life ?? 0.26);
  s.life = s.maxLife;
  s.base = s.rest * Math.max(0.01, cfg.pop ?? 1.45);

  const dx = opts.dirX ?? 1;
  const dy = opts.dirY ?? 0;
  const heading = Math.atan2(dy, dx);

  s.mesh.position.set(x, y, 0);
  // The same pose the projectile held. entities/projectiles.js writes
  // `rotation.z = atan2(dy, dx) - PI/2` because orientationQuaternion has
  // already put the model's forward on entity +Y — so the quarter turn is part
  // of the convention, not an offset to be tidied away, and dropping it lands
  // every shell broadside to its own flight.
  s.mesh.rotation.set(0, 0, heading - Math.PI / 2);
  s.mesh.scale.setScalar(0.001);
  s.mesh.visible = true;

  const [lo, hi] = cfg.spin ?? [7, 13];
  s.spin = (lo + Math.random() * Math.max(0, hi - lo)) * (Math.random() < 0.5 ? -1 : 1);
  // A tumble axis that is mostly the screen normal, tilted a little. Pure z is
  // a flat spin and reads as a sprite turning; a fully random axis rolls the
  // gape away from the camera as often as not, which is the one thing this
  // effect exists to show. This keeps the mouth pointed out and still gives
  // the shell somewhere to fall.
  s.axis.set((Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.7, 1).normalize();

  const drift = cfg.drift ?? 2.6;
  const len = Math.hypot(dx, dy) || 1;
  s.vx = (dx / len) * drift;
  s.vy = (dy / len) * drift;
}

export function updateMusselShells(dt) {
  if (!group) return;
  const cfg = CONFIG.missile?.shell ?? {};
  const endScale = cfg.endScale ?? 0.55;

  for (const s of shells) {
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.life = 0;
      s.mesh.visible = false;
      continue;
    }
    const t = 1 - s.life / s.maxLife; // 0 at the detonation, 1 at the end

    // THE POP, cubic-out, on its OWN clock — `popTime` seconds, not a fraction
    // of the life. Eased across the whole life instead, the shell is a third
    // open at 33ms and does not reach full size until 130, by which point the
    // flash it is meant to open inside has nearly gone; what you read then is a
    // shell inflating in the smoke rather than a shell bursting. Measured on
    // the look page, which is where this was wrong first.
    const popT = Math.min(1, (s.maxLife - s.life) / Math.max(1e-4, cfg.popTime ?? 0.05));
    const pop = 1 - (1 - popT) * (1 - popT) * (1 - popT);
    // ...and the shrink under it, linear across the whole life, so the shell is
    // still near full size while the flash is bright and only goes once the
    // light has.
    s.mesh.scale.setScalar(s.base * pop * (1 + (endScale - 1) * t));

    // Tumble composed onto the pose rather than written over it: the heading
    // from spawn is the shell's whole orientation and rewriting the Euler
    // angles each frame — which is what the projectile does — would throw it
    // away on the first tick.
    _q.setFromAxisAngle(s.axis, s.spin * dt);
    s.mesh.quaternion.multiply(_q);

    s.mesh.position.x += s.vx * dt;
    s.mesh.position.y += s.vy * dt;
  }
}

export function clearMusselShells() {
  for (const s of shells) {
    s.life = 0;
    s.mesh.visible = false;
  }
}

/** For harnesses: how many shells are open right now. */
export function activeMusselShells() {
  return shells.reduce((n, s) => n + (s.life > 0 ? 1 : 0), 0);
}
