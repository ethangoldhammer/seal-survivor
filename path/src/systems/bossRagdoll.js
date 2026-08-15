import * as THREE from 'three';
import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// THE BODY TAKES THE HIT THAT KILLED IT
//
// systems/bossCorpse.js keeps a dead boss whole for a beat so the kill shot has
// something to photograph. What it kept was an animal that had stopped
// STEERING: the mixer went on running, so the body drifted and rolled while its
// skeleton swam. The one frame the whole game holds still for was a picture of a
// boss mid-stroke, showing no sign of ever having been hit.
//
// So the skeleton is cut loose on the killing frame. Three things happen at
// once, and they are three descriptions of the same blow:
//
//   THE SKELETON GOES LIMP. anim.setLimp() stops the mixer and freezes the pose
//                the animal died in as the only thing the bone springs are
//                pulled back toward (see systems/animation.js). Gravity is then
//                fed in every frame as a downward impulse, so the chains hang
//                instead of holding their shape.
//
//   THE CHAINS TAKE THE BLOW. One large impulse along the direction the killing
//                hit travelled, into the same damped springs that carry every
//                ordinary hit reaction (systems/boneSpring.js). There is no
//                second solver here and no physics of any kind — a ragdoll in
//                this game is the existing spring with its pose driver removed
//                and its lag cap opened up.
//
//   THE BODY TAKES IT TOO. Shoved along the blow, and rolled by its TORQUE:
//                a hit on the snout turns the animal one way and the same hit on
//                the tail turns it the other. This replaces the constant roll in
//                CONFIG.boss.corpse, which turned every boss the same way
//                whatever had killed it.
//
// AND IT IS ON ITS OWN CLOCK. This is the part that is easy to get wrong and
// impossible to see going wrong. The shutter fires at snapshotMoment(), about
// 1.02 WALL seconds after the kill, and the world spends nearly all of that at
// CONFIG.boss.kill.hold — 0.12. A corpse living on the water's clock therefore
// gets about 0.175 seconds of its own time before its photograph is taken, and
// nothing falls limp in 0.175 seconds. The ragdoll would run perfectly, look
// right in ordinary play, and be absent from every trophy in the game.
//
// So it runs mostly on the wall clock, like the countdown it is racing
// (corpseHoldSeconds) and like the camera push. `CONFIG.boss.ragdoll.clock` is
// the mix, short of 1 so the whip still decelerates with the water instead of
// reading as one object running at full speed through a slow-motion shot.
//
// EVERY BOSS SKELETON GETS THIS and none of them needed anything added to do
// it: megalodon, mosasaur, hammerhead, orca (bull and cow), the king crab's ten
// limbs and the kraken's ten arms all already declare spring chains for their
// hit reactions, and this drives whatever they declared. bossBoat is the one
// boss with no rig at all — trawler.glb is a hull — so it goes limp in the only
// way it can: the knock and the spin, with no skeleton to fold.
// ---------------------------------------------------------------------------

const _blow = new THREE.Vector3();
const _flow = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

function cfg() {
  return CONFIG.boss?.ragdoll ?? {};
}

// The spring settings a corpse solves with. Rebuilt only when the tuner has
// actually moved one of them — this is read once per corpse per frame and the
// values are global, so the whole thing is one shared object between rebuilds.
// Same reasoning as springCfgFor in systems/animation.js.
let limpCfg = null;
let limpStamp = '';
function limpSpring() {
  const c = cfg();
  const stamp = `${c.stiffness}|${c.damping}|${c.tipLooseness}|${c.maxLag}|${c.softness}|${c.snapAngle}`;
  if (limpStamp !== stamp) {
    limpStamp = stamp;
    limpCfg = {
      stiffness: c.stiffness ?? 8,
      damping: c.damping ?? 3,
      tipLooseness: Math.min(0.98, c.tipLooseness ?? 0.88),
      maxLag: c.maxLag ?? 1.6,
      softness: c.softness ?? 0.5,
      snapAngle: c.snapAngle ?? 3.0,
    };
  }
  return limpCfg;
}

/**
 * WHERE THE KILLING BLOW CAME FROM.
 *
 * `e.lastBlow` is written by main.js's damage funnel, which is the only place
 * that sees every source of damage in the game — see onEnemyDamagedFeedback.
 * A boss cannot die without having been damaged, so it is all but always there;
 * the fallback covers the exceptions that do no damage at all (a net haul, a
 * death blast) by throwing the body forward along its own heading, which at
 * least reads as momentum rather than as nothing.
 *
 * @returns { dx, dy, hx, hy } — unit direction of travel, and the point on the
 *          body it landed, in world units. Null if even the fallback is
 *          degenerate, which means no ragdoll rather than a ragdoll pointed at
 *          an arbitrary direction.
 */
function blowFor(e) {
  const p = e.mesh?.position;
  if (!p) return null;
  const b = e.lastBlow;
  let dx = b?.dx ?? 0;
  let dy = b?.dy ?? 0;
  let len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = e.vx ?? 0;
    dy = e.vy ?? 0;
    len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
  }
  return {
    dx: dx / len,
    dy: dy / len,
    // The contact point, defaulting to dead centre — which produces no torque
    // at all, so a blow with no known landing point shoves the body without
    // spinning it rather than guessing a direction to turn.
    hx: b?.hx ?? p.x,
    hy: b?.hy ?? p.y,
  };
}

/**
 * Cut a dead boss's skeleton loose. Called once, on the frame it died, from
 * systems/bossCorpse.js — the one place that owns a body that is out of
 * `enemies` but still in the water.
 *
 * Applies the linear knock to the creature's own velocity, so the corpse's
 * existing drag spends it; everything else the returned record carries.
 *
 * @returns the ragdoll record, or null if this body cannot take one. Null is
 *          not a failure: it is what bossBoat gets, and the caller falls back
 *          to the plain corpse roll.
 */
export function startBossRagdoll(e) {
  const c = cfg();
  if (c.enabled === false || !e?.mesh) return null;
  const blow = blowFor(e);
  if (!blow) return null;

  // THE TORQUE, and it is the only reason the contact point is carried this
  // far. r x F about the view axis, off the offset from the body's own origin
  // to where the hit landed: the same blow on the snout and on the tail turn
  // the animal opposite ways, which is the difference between a body reacting
  // to a hit and a body playing a spin animation.
  const rx = blow.hx - e.mesh.position.x;
  const ry = blow.hy - e.mesh.position.y;
  const torque = rx * blow.dy - ry * blow.dx;

  // Normalised by the lever arm, so the spin is a DIRECTION taken from the
  // geometry and a RATE taken from the config. Without this a forty-unit
  // megalodon hit at the tail would spin an order of magnitude faster than a
  // hammerhead hit at the shoulder, purely because it is longer. What is left
  // after the division is the sine of the angle between the blow and the arm it
  // landed on, so a glancing hit along the body turns it less than a square one
  // across it — which is the only part of this that is real physics.
  //
  // A blow with no lever at all — dead centre, or a source that reported no
  // landing point — turns the body at the full rate in the default direction
  // rather than not at all. A corpse rolling over is the one movement that says
  // "dead" rather than "slower" (see the note on corpse.roll, which this
  // replaced), and losing it on the sources that report least is how a boss
  // ends up dying perfectly level.
  const lever = Math.hypot(rx, ry);
  const spin = (lever > 1e-4 ? torque / lever : 1) * (c.spin ?? 0.6);

  // The shove. Straight onto the creature's velocity so the corpse's own drag
  // and sink spend it — this is the body being knocked, not a second mover
  // fighting the first.
  const knock = c.knock ?? 14;
  e.vx = (e.vx ?? 0) + blow.dx * knock;
  e.vy = (e.vy ?? 0) + blow.dy * knock;

  // No springs on this body: the knock and the spin above are the whole of what
  // it can do. Reported honestly rather than as a live ragdoll, so the caller
  // can tell "a boat took a hit" from "a skeleton is falling".
  const skeleton = e.anim?.setLimp?.(limpSpring()) ?? false;
  if (skeleton) {
    _blow.set(blow.dx, blow.dy, 0);
    e.anim.impulse(_blow, c.blow ?? 10, c.tipBias ?? 0.5);
  }

  return { dx: blow.dx, dy: blow.dy, spin, skeleton, clock: 0 };
}

/**
 * The ragdoll's own delta for this frame — see the header for why it is not
 * simply the world's.
 *
 * @param rawDt     wall seconds.
 * @param dilatedDt the water's seconds.
 */
export function ragdollDelta(rawDt, dilatedDt) {
  const mix = Math.max(0, Math.min(1, cfg().clock ?? 0.85));
  return dilatedDt + (rawDt - dilatedDt) * mix;
}

/**
 * Advance one falling body. Poses the skeleton and returns the roll to apply,
 * in radians — the caller owns `mesh.rotation` and this does not reach into it.
 *
 * @param rag the record from startBossRagdoll.
 * @param rdt the ragdoll's delta, from ragdollDelta.
 */
export function updateBossRagdoll(e, rag, rdt) {
  if (!rag || !(rdt > 0)) return 0;
  rag.clock += rdt;

  if (rag.skeleton && e.anim) {
    // GRAVITY, every frame, as an impulse rather than as a force in the solver.
    // The spring only knows about velocities, and `impulse` already projects
    // out the component along each bone (pushing a rigid segment along its own
    // length does nothing), so this is the whole of what a hanging chain needs.
    // Multiplied by dt because it is an acceleration being integrated by hand.
    //
    // Tips first: a chain that sags evenly reads as a banana, and one that sags
    // hardest at the far end reads as weight.
    const c = cfg();
    e.anim.impulse(DOWN, (c.sag ?? 18) * rdt, c.sagBias ?? 0.3);

    // AND THE WATER GOING PAST IT — which is what keeps the DIRECTION of the
    // blow in the photograph.
    //
    // The whip is a transient: it peaks a third of the way into the beat and
    // has settled by the time the shutter fires, and what it settles into is a
    // hang, which points the same way whatever killed the animal. Measured, on
    // two deaths differing in nothing but which way the hit travelled: the two
    // photographs were within 2% of each other on the orca. The body was
    // limp — it just was not limp in any particular direction, which is half of
    // what was asked for missing.
    //
    // So the chains are also dragged against the body's own travel, for as long
    // as it has any. A boss knocked sideways by the blow that killed it has its
    // fins and arms streaming behind it, and it goes on having them for exactly
    // as long as the shove lasts, because this force IS the shove: the strength
    // is the body's current speed, spent by the same drag in bossCorpse.js.
    const sp = Math.hypot(e.vx ?? 0, e.vy ?? 0);
    if (sp > 0.05) {
      _flow.set(-(e.vx ?? 0) / sp, -(e.vy ?? 0) / sp, 0);
      e.anim.impulse(_flow, (c.flow ?? 1.5) * sp * rdt, c.tipBias ?? 0.5);
    }
    // State and hit are ignored while limp — see setLimp. This is the mixer's
    // call site being reused rather than a second one being added.
    e.anim.update(rdt, null, false);
  }

  return rag.spin * rdt;
}

/**
 * Hand the skeleton back. Called when the body is let go — burst, or a run
 * ending under it.
 *
 * Belt to the braces in the controller's own reset(), which every recycled body
 * goes through on its next spawn: this module cut the skeleton loose, so it
 * should be the thing that admits when it is done rather than leaving a pooled
 * body limp and trusting the next spawn to notice.
 */
export function endBossRagdoll(e) {
  e?.anim?.setLimp?.(null);
}
