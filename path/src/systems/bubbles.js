import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { chainPoint } from './ikChain.js';

// Bubbles off the seal itself, anchored to bones rather than to the body's
// centre — the mouth breathes and the tail leaves a wake, so both emitters
// follow the actual animation instead of floating out of a point in the
// middle of the model. The anchor positions come from systems/aimRig.js,
// which publishes them each frame after the pose is final.
//
// Both are underwater-only. A seal that has breached is in the air, and
// bubbles in the air read as a bug rather than as breath.
//
// The two have deliberately different cadences:
//   breath — a discrete puff on a randomised timer. Irregular on purpose;
//            a metronome-steady exhale looks mechanical.
//   wake   — continuous, with the rate scaled by speed. Below `minSpeed` the
//            tail isn't working hard enough to cavitate and it stops
//            entirely, which is what keeps a drifting seal from trailing
//            bubbles it isn't earning.
//
// The wake is not one point. See wakeOrigin below: each burst is born either
// off one of the two hind FLIPPER TIPS or somewhere along the tail, so the
// trail comes off the whole back half of the animal.

const _pt = new THREE.Vector3();

let breathTimer = 0;
let wakeCarry = 0; // fractional emissions carried between frames
let chargeCarry = 0; // the same, for the wind-up vent
let wakeSide = 0; // alternates the flipper a burst comes off

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function nextBreathDelay() {
  const [lo, hi] = CONFIG.bubbles.breath.interval;
  return randomBetween(lo, hi);
}

export function resetBubbles() {
  breathTimer = nextBreathDelay();
  wakeCarry = 0;
  chargeCarry = 0;
  wakeSide = 0;
}

// --- where a wake bubble is born -------------------------------------------
//
// Water leaves a swimming seal off the ENDS of the things pushing it, so this
// picks a fresh point per burst instead of pouring everything out of one
// anchor. Two kinds of place, split by `tailShare`:
//
//   a flipper tip — all four, stepped through in turn. The front pair are the
//     rig's muzzles, which sit on the outermost skinned vertex of each flipper
//     (see systems/aimRig.js — the same points the muzzle flash comes off, so
//     the shot and its bubbles agree). The hind pair are the `finL`/`finR`
//     anchors, just past the trailing edge of the webbing. The tail anchor that
//     used to carry all of this lands on the ankle joint the hind flippers hang
//     off — the wake came out of the BASE of the fins.
//
//   along the tail — sampled down the tail chain, crowded toward the tip by
//     `tipBias`, because that is how much of the tail is actually moving: the
//     root barely travels and the tip whips.
//
// Returns a live object with .x/.y — either an anchor, a muzzle, or the scratch
// vector — so nothing is copied per burst. Callers read it and emit at once.
//
// Degrades in the order tips -> tail chain -> the plain `tail` anchor -> null,
// so a model with no fin anchors, and any caller passing a hand-built rig,
// behaves exactly as it did before.
const _tips = []; // reused per call; wakeOrigin is on the emission path

function wakeOrigin(rig, cfg) {
  _tips.length = 0;
  for (const m of rig.muzzles ?? []) _tips.push(m);
  if (rig.anchors.finL) _tips.push(rig.anchors.finL);
  if (rig.anchors.finR) _tips.push(rig.anchors.finR);
  const chain = rig.tail;

  // With no tips to shed off, the tail carries the whole wake rather than
  // `tailShare` of it.
  if (chain && (_tips.length === 0 || Math.random() < (cfg.tailShare ?? 0))) {
    // u^(1/(1+bias)) skews a uniform draw toward 1 — at the shipped bias of 3
    // half the samples land in the last sixth of the tail. bias 0 is an even
    // spread, and no value of it can push a sample off the end.
    const s = Math.pow(Math.random(), 1 / (1 + Math.max(0, cfg.tipBias ?? 0)));
    return chainPoint(chain, s, _pt);
  }
  // Stepped rather than drawn at random: four tips picked uniformly leave
  // visible gaps and clumps at this burst rate, and the whole point is that
  // every limb is trailing something.
  if (_tips.length > 0) return _tips[wakeSide++ % _tips.length];
  return rig.anchors.tail || null;
}

/**
 * @param rig      the player's aim rig (may be null for a model with no anchors)
 * @param velocity player velocity, as {x, y}
 * @param charge   banked strike power, 0..1, or 0 when no strike is being wound
 *                 up. Opens every emitter at once — see the vent below.
 */
export function updateBubbles(dt, rig, velocity, aboveSurface, charge = 0) {
  const cfg = CONFIG.bubbles;
  if (!cfg.enabled || !rig || aboveSurface) return;

  const speed = Math.hypot(velocity.x, velocity.y);
  const maxSpeed = Math.max(1, CONFIG.player.maxSpeed);

  // --- breath ---------------------------------------------------------------
  const mouth = rig.anchors.mouth;
  if (cfg.breath.enabled && mouth) {
    breathTimer -= dt;
    if (breathTimer <= 0) {
      breathTimer = nextBreathDelay();
      const effort = 1 + cfg.breath.speedScale * Math.min(1, speed / maxSpeed);
      emit('breathBubbles', mouth.x, mouth.y, {
        // Straight up, with the emitter's own cone spreading it — bubbles
        // leave the mouth and immediately start rising, whichever way the
        // seal happens to be pointing.
        dirX: 0,
        dirY: 1,
        vx: velocity.x,
        vy: velocity.y,
        scale: cfg.breath.scale * effort,
      });
    }
  }

  // --- the wake -------------------------------------------------------------
  // Off all four flipper tips and along the tail — see wakeOrigin.
  const hasWake = !!(rig.muzzles?.length || rig.anchors.finL || rig.anchors.finR
    || rig.tail || rig.anchors.tail);
  if (cfg.wake.enabled && hasWake && speed >= cfg.wake.minSpeed) {
    // Rate ramps with speed rather than switching on at full strength, so
    // crossing minSpeed fades the wake in instead of popping it.
    const ramp = Math.min(1, (speed - cfg.wake.minSpeed) / Math.max(0.01, maxSpeed - cfg.wake.minSpeed));
    wakeCarry += cfg.wake.perSecond * ramp * dt;
    // A whole emission's worth of budget spends one burst; the remainder
    // carries so a low rate still fires at the right average frequency
    // instead of being rounded away to nothing every frame.
    let bursts = Math.floor(wakeCarry);
    wakeCarry -= bursts;
    // One frame after a hitch shouldn't dump a hundred bursts at once.
    bursts = Math.min(bursts, 4);
    if (bursts > 0) {
      const inv = speed > 1e-4 ? -1 / speed : 0;
      const dirX = velocity.x * inv;
      const dirY = velocity.y * inv;
      for (let i = 0; i < bursts; i++) {
        // Re-picked per burst, not per frame: that is what spreads consecutive
        // bursts across both flippers and down the tail instead of moving one
        // emitter around.
        const from = wakeOrigin(rig, cfg.wake);
        if (!from) break;
        emit('wakeBubbles', from.x, from.y, {
          // Cast off BEHIND the seal, along the reverse of travel.
          dirX,
          dirY,
          vx: velocity.x,
          vy: velocity.y,
          scale: cfg.wake.scale,
        });
      }
    }
  } else {
    wakeCarry = 0;
  }

  // --- the wind-up vent -----------------------------------------------------
  // Charging a strike opens the mouth and the tail together, hard, and harder
  // the more power is banked. Its own path rather than a multiplier on the two
  // above, because neither could carry it: breath fires on a 1-2 second timer
  // and the wake switches off below `wake.minSpeed`, which is the state a
  // wind-up usually IS — braking to a hold. This has to pour whether the seal
  // is moving or not.
  //
  // Each half still obeys its own emitter switch above. Those switches name a
  // PLACE bubbles come from, not a cadence, so a mouth turned off should stay
  // off through a wind-up too — `charge.enabled` is the switch for this effect.
  const cc = cfg.charge;
  const ventMouth = cfg.breath.enabled !== false ? mouth : null;
  const ventWake = cfg.wake.enabled !== false && hasWake;
  const wind = cc?.enabled === false ? 0 : Math.min(1, Math.max(0, charge || 0));
  if (wind <= 0 || (!ventMouth && !ventWake)) {
    chargeCarry = 0;
    return;
  }

  chargeCarry += lerp(cc?.perSecondMin ?? 10, cc?.perSecondMax ?? 70, wind) * dt;
  let bursts = Math.floor(chargeCarry);
  // The remainder carries, the backlog does not: subtracting the whole count
  // before the clamp is what keeps a hitch from being paid back over the
  // following frames as a second of bubbles arriving late.
  chargeCarry -= bursts;
  bursts = Math.min(bursts, cc?.maxPerFrame ?? 6);
  if (bursts <= 0) return;

  const ventScale = lerp(cc?.scaleMin ?? 0.6, cc?.scaleMax ?? 1.9, wind);
  // Behind the seal if it's still travelling, straight up if it isn't — a tail
  // vent from a standstill has no "behind" to cast into, and bubbles rise
  // anyway (the emitters carry positive gravity).
  const inv = speed > 1e-4 ? -1 / speed : 0;
  const tailX = inv !== 0 ? velocity.x * inv : 0;
  const tailY = inv !== 0 ? velocity.y * inv : 1;

  for (let i = 0; i < bursts; i++) {
    if (ventMouth) {
      emit('breathBubbles', ventMouth.x, ventMouth.y, {
        dirX: 0,
        dirY: 1,
        vx: velocity.x,
        vy: velocity.y,
        scale: cfg.breath.scale * ventScale,
      });
    }
    if (ventWake) {
      // Same picker the wake uses, so a wind-up vents off the flipper tips and
      // down the tail rather than out of one point.
      const from = wakeOrigin(rig, cfg.wake);
      if (from) {
        emit('wakeBubbles', from.x, from.y, {
          dirX: tailX,
          dirY: tailY,
          vx: velocity.x,
          vy: velocity.y,
          scale: cfg.wake.scale * ventScale,
        });
      }
    }
  }
}
