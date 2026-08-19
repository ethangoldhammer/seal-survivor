import { CONFIG } from '../config.js';
import { spawnBossGibs } from './bossGibs.js';
import { releaseHitShape, hitShapeSpheres, refreshHitShape } from './hitShape.js';
import { releaseVisual } from '../assets.js';
import { stateForSpeed } from './animation.js';
import { snapshotMoment } from './bossKill.js';
import { startBossRagdoll, updateBossRagdoll, ragdollDelta, endBossRagdoll } from './bossRagdoll.js';
import { fireBossBoom, bossBoomLead } from './bossBoom.js';

// ---------------------------------------------------------------------------
// THE BODY, BRIEFLY
//
// A boss used to burst on the frame its health ran out. systems/bossGibs.js
// throws a few hundred chunks out of its posed hitbox and the visual goes
// straight back to the pool — which meant that by the time the kill shot took
// its picture, about a second of wall clock later, there was no boss in the
// frame at all. The trophy was a seal celebrating over a cloud of debris, and
// the thing it had beaten was already gone.
//
// So the body is KEPT. For a beat after the kill it hangs in the water where
// it died, going limp — drifting to a stop, sinking a little, rolling over —
// and only then comes apart. The picture gets the animal; the explosion still
// happens, a moment later, and lands while the print is flying to the corner
// (see ui/snapshotPrint.js), which is a better place for it than under the
// shutter anyway.
//
// HOW LONG IS DERIVED, NOT TYPED. The hold is `snapshotMoment()` plus a
// margin — the shutter's own timing, out of systems/bossKill.js — so retuning
// the shot cannot leave the body bursting a frame before the picture is taken.
// A hand-typed 1.2 here would be a second description of the same instant, and
// the failure when they drift is silent: a perfectly good trophy of an
// explosion.
//
// WHY THE CREATURE OBJECT SURVIVES. spawnBossGibs samples the POSED hitbox,
// so the burst has to be thrown off a body that still exists and is still in
// the pose it died in — that is the whole reason the burst lives in main.js's
// kill hook rather than in systems/boss.js. Holding the creature keeps that
// true a second longer: entities/enemies.js hands ownership over instead of
// releasing the visual (see `corpseHeld` in removeEnemy), and this file is
// what eventually gives it back. Every route out of a run goes through
// resetBossCorpses, so a held body can never outlive the run that made it.
//
// It is out of `enemies` from the instant it dies, which is what matters for
// everything else: nothing collides with it, nothing shoots it, it takes no
// damage, it counts for nothing. It is scenery with a timer.
//
// WHAT THE BODY DOES WHILE IT IS HELD is not this file's decision any more.
// Drifting to a stop and sinking still are — that is the water acting on it —
// but the SKELETON is cut loose by systems/bossRagdoll.js on the same frame,
// which also takes the killing blow and turns it into a shove, a spin and a
// whip down every bone chain. This file drives it and owns the timer; that one
// owns what a dead animal looks like.
// ---------------------------------------------------------------------------

// Held bodies, oldest first. An array rather than a single slot because two
// bosses in the water at once is reachable (the debug spawner does it, and
// nothing in boss.js forbids it), and the second kill must not silently
// abandon the first body in the scene graph forever.
const held = [];

// Where the last body was when it burst, kept so the shot's framing has
// something to point at for the rest of its run. Without it the frame would
// snap off the wreckage and back onto the seal on the frame the boss came
// apart — a hard cut in the middle of the one shot the game holds still for.
let lastSeen = null;

function cfg() {
  return CONFIG.boss?.corpse ?? {};
}

/** How long a body is kept whole, in wall seconds. See the header. */
export function corpseHoldSeconds() {
  return Math.max(0, snapshotMoment() + (cfg().afterShot ?? 0.18));
}

// How much of the frame this body needs, in world units: the distance from its
// origin out to the far edge of the furthest hitbox sphere. Measured ONCE, at
// the moment of death, and off the hitbox rather than off `def.radius` — a
// boss is several times its species' figure (see the note in bossGibs.js), and
// framing a forty-unit megalodon as if it were a four-unit shark is exactly
// the crop this whole change exists to stop.
function framingRadius(e) {
  let r = 0;
  const p = e.mesh?.position;
  const spheres = e.hitShape ? hitShapeSpheres(e.hitShape) : null;
  if (spheres?.length && p) {
    for (const s of spheres) {
      if (!(s.wr > 0)) continue;
      r = Math.max(r, Math.hypot(s.wx - p.x, s.wy - p.y) + s.wr);
    }
  }
  return r > 0 ? r : Math.max(0.5, e.radius ?? e.def?.radius ?? 1);
}

/**
 * Take ownership of a dead boss and keep it whole for a beat.
 *
 * Called from main.js's kill hook, on the frame the last hit lands, in place
 * of the immediate burst.
 *
 * @returns true if the body was claimed — the caller must NOT burst it, and
 *          entities/enemies.js must not release its visual. False means the
 *          hold is switched off and the old behaviour stands, which is the
 *          whole of the fallback: the caller bursts it itself.
 */
export function holdBossCorpse(e, scene) {
  if (cfg().enabled === false || !e?.mesh || !scene) return false;
  e.corpseHeld = true;
  held.push({
    e,
    scene,
    // WALL seconds. The body is being kept for a photograph, and the photograph
    // is taken on the wall clock — a countdown on the dilated clock would run
    // at a tenth speed through the very beat it exists to survive, and the boss
    // would still be whole ten seconds into ordinary play.
    left: corpseHoldSeconds(),
    r: framingRadius(e),
    roll: 0,
    // Whether this body has already gone up. A latch rather than a second
    // countdown: the threshold below is crossed on every frame after the
    // first one, and without it a boss would fire a fresh explosion every
    // frame for a third of a second.
    boomed: false,
    // Cut loose HERE, on the killing frame, for the same reason the burst used
    // to be: the blow that killed it is only knowable while the creature object
    // is still whole, and one frame later systems/boss.js will have noticed the
    // death with no idea what caused it. Null for a body with no skeleton and
    // no known blow — the plain roll below is then what happens, exactly as
    // before.
    rag: startBossRagdoll(e),
  });
  lastSeen = { x: e.mesh.position.x, y: e.mesh.position.y, r: held[held.length - 1].r };
  return true;
}

/**
 * What the kill shot should frame besides the seal: the newest body, or where
 * the last one was if it has already burst. Null once the run has moved on.
 */
export function bossCorpseFocus() {
  const rec = held[held.length - 1];
  if (rec) {
    const p = rec.e.mesh.position;
    return { x: p.x, y: p.y, r: rec.r };
  }
  return lastSeen;
}

/**
 * @param rawDt    UNSCALED seconds — the countdown, which is racing a shutter.
 * @param dilatedDt the world's clock, which is what the body MOVES on: it is
 *                  in the water with everything else, and a corpse drifting at
 *                  full speed through a shot held at 0.12x would be the only
 *                  thing in the frame not in slow motion.
 */
export function updateBossCorpses(rawDt, dilatedDt) {
  if (!held.length) return;
  const c = cfg();
  // Floor only. This is a per-second rate fed to exp() below, not a 0..1
  // fraction, so an upper clamp of 1 is not a safety rail — it is a cap that
  // silently turned every value above it into 1.0, the shipped 1.6 included.
  const drag = Math.max(0, c.drag ?? 1.6);
  const sink = c.sink ?? 2.2;
  const rollRate = c.roll ?? 0.9;

  for (let i = held.length - 1; i >= 0; i--) {
    const rec = held[i];
    const e = rec.e;
    rec.left -= rawDt;

    // GOING LIMP. Whatever the animal was doing, it stops doing it: the drive
    // is gone, so the water takes the speed out of it and gravity puts a
    // little back in, downward. Exponential rather than linear so a boss
    // killed mid-charge decelerates hard and then coasts, which is what a body
    // that has stopped swimming actually does.
    const k = Math.exp(-drag * dilatedDt);
    e.vx = (e.vx ?? 0) * k;
    e.vy = ((e.vy ?? 0) + -sink * dilatedDt) * k;
    e.mesh.position.x += e.vx * dilatedDt;
    e.mesh.position.y += e.vy * dilatedDt;
    // And it turns over. The one movement that says "dead" rather than
    // "slower" — about the view axis, because this is a side-on game and a
    // roll about any other only reads as the body flickering edge-on.
    //
    // WHICH WAY it turns is the ragdoll's to say when there is one: a corpse
    // should roll away from whatever hit it, and `rollRate` is a constant that
    // turned every boss the same way whatever had killed it. It stays as the
    // fallback for a body the ragdoll declined — bossBoat's hull with no known
    // blow, or the tuner switching the whole thing off mid-hold.
    //
    // The skeleton and the spin run on the RAGDOLL's clock, not the water's:
    // the shutter is barely a fifth of a dilated second away and a body that
    // fell limp on the water's clock would still be swimming in its own
    // photograph. See systems/bossRagdoll.js, which is where that number lives.
    let turn;
    if (rec.rag) {
      turn = updateBossRagdoll(e, rec.rag, ragdollDelta(rawDt, dilatedDt));
    } else {
      turn = rollRate * dilatedDt;
      // NO RAGDOLL, so the old behaviour stands whole: the mixer keeps running
      // on the world's own clock, for the reason the seal's does through the
      // same beat (see systems/bossKill.js) — a body that stops dead reads as a
      // dropped frame, and one still drifting through its last stroke at a
      // tenth speed reads as an animal. It has no swim left to do, so it is
      // asked for the pose that matches the speed it now has, which is falling
      // toward nothing.
      e.anim?.update(dilatedDt, stateForSpeed(Math.hypot(e.vx, e.vy)), false);
    }
    rec.roll += turn;
    e.mesh.rotation.z += turn;

    // AND THE HITBOX FOLLOWS THE POSE. It is no longer only a hitbox: nothing
    // can shoot this body any more, but the burst is sampled from these spheres
    // (see spawnBossGibs) and so is the shot's framing radius. Left unrefreshed
    // they describe the pose the animal was in when it died, and the chunks
    // would come off a shape the folded body has since left.
    if (e.hitShape) refreshHitShape(e.hitShape);

    // AND THEN IT GOES UP. Fired from this countdown rather than from a clock
    // of its own, because this is the only clock in the game already racing
    // the shutter on the wall — `left` reaches `afterShot` on the frame the
    // picture is taken, so anything that has to be IN the picture is a lead
    // ahead of that. A second countdown would be a second description of the
    // same moment and would drift the first time the beat was retuned.
    //
    // Deliberately AFTER the hitbox has been refreshed above: the cloud is
    // sized and centred on the spheres, and one frame of a folding ragdoll is
    // the difference between a cloud on the body and a cloud beside it.
    //
    // The body is still whole under it and stays whole for `afterShot` longer.
    // That is the trick the effect is built on: the boss is never seen being
    // deleted, because the smoke is already over it when it bursts.
    if (!rec.boomed && rec.left <= (c.afterShot ?? 0.18) + bossBoomLead()) {
      rec.boomed = true;
      fireBossBoom(e);
    }

    if (rec.left <= 0) burst(rec, i);
  }
}

// The moment it has been waiting for. Everything the creature was holding goes
// back where it came from, in the order removeEnemy would have done it — the
// hitbox rides the visual, so it is dropped first, and the burst is sampled
// off both before either is let go.
function burst(rec, index) {
  const e = rec.e;
  lastSeen = { x: e.mesh.position.x, y: e.mesh.position.y, r: rec.r };
  spawnBossGibs(e);
  // AFTER the burst is sampled and before the body goes back to the pool: the
  // chunks come off the pose the ragdoll left it in, and the next creature to
  // wear this body gets a skeleton the mixer can drive again.
  endBossRagdoll(e);
  releaseHitShape(e.hitShape);
  releaseVisual(e.visual);
  rec.scene.remove(e.mesh);
  e.corpseHeld = false;
  held.splice(index, 1);
}

/**
 * End of a run, or the start of one. Bodies are released WITHOUT bursting:
 * this is a restart, a death, the tuner switching the hold off mid-hold, and
 * none of them wants a boss exploding over a menu.
 */
export function resetBossCorpses() {
  for (let i = held.length - 1; i >= 0; i--) {
    const rec = held[i];
    endBossRagdoll(rec.e);
    releaseHitShape(rec.e.hitShape);
    releaseVisual(rec.e.visual);
    rec.scene.remove(rec.e.mesh);
    rec.e.corpseHeld = false;
  }
  held.length = 0;
  lastSeen = null;
}

/** For the harness. How many bodies are being held right now. */
export function bossCorpseCount() {
  return held.length;
}
