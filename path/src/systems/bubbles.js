import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';

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

let breathTimer = 0;
let wakeCarry = 0; // fractional emissions carried between frames

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

function nextBreathDelay() {
  const [lo, hi] = CONFIG.bubbles.breath.interval;
  return randomBetween(lo, hi);
}

export function resetBubbles() {
  breathTimer = nextBreathDelay();
  wakeCarry = 0;
}

/**
 * @param rig      the player's aim rig (may be null for a model with no anchors)
 * @param velocity player velocity, as {x, y}
 */
export function updateBubbles(dt, rig, velocity, aboveSurface) {
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

  // --- tail wake ------------------------------------------------------------
  const tail = rig.anchors.tail;
  if (cfg.wake.enabled && tail && speed >= cfg.wake.minSpeed) {
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
        emit('wakeBubbles', tail.x, tail.y, {
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
}
