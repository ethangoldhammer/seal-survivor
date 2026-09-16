import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { celebrationState } from './celebrate.js';
import { clapState } from './clap.js';
import { strikePoseState } from './strikePose.js';

// ============================================================================
// BUBBLES ATTACHED TO A POSE — the water's answer to the animal doing
// something, authored beside the pose that does it.
//
// systems/bubbles.js already emits off this rig continuously: a breath on a
// randomised timer, a wake that scales with speed, a vent that opens with the
// wind-up. All three describe SWIMMING. None of them can carry a performance,
// and it is worth being exact about why rather than reaching for a multiplier:
// a celebration usually happens at a standstill, so the wake is off; the
// breath is on a one-to-two second timer, so a gesture that lasts half a
// second lands between two of them about two thirds of the time. A pose that
// wanted bubbles got whatever the swimming happened to be doing.
//
// TWO CADENCES, because a pose needs both and neither substitutes for the
// other:
//
//   BURSTS   a count of PUFFS at a PHASE of the pose — 0.5 is halfway to
//            full extension, 1 is the peak. This is how a puff lands on the
//            frame the flippers meet, or on the frame the flipper reaches the
//            brow. `count` is how many times the emitter FIRES, not how many
//            sprites land — one firing is a puff of whatever CONFIG.emitters
//            says, so a handful is usually plenty.
//
//            Fired on the EDGE, not on the frames either side of it: the
//            phase is walked past a threshold and the crossing is what counts,
//            so a slow frame cannot fire one twice and a fast one cannot skip
//            it. (A window test instead of an edge is how a timer once counted
//            one event 182 times in this project.)
//
//   A RATE   bubbles per second, scaled by the pose's WEIGHT — so it fades up
//            with the pose and back down through the release without a clock
//            of its own. This is the stream off a somersault, or the slow
//            leak from a held pose that keeps a still frame alive.
//
// EVERY NUMBER IS AUTHORED WITH THE POSE, in CONFIG.celebrate.poses.<name>
// .bubbles (and CONFIG.clap.bubbles for the button), not here. A pose is a
// shape plus what the water does about it, and splitting those across two
// blocks means tuning one and forgetting the other — which is the same
// argument the card descriptions make about measuring rather than typing a
// number.
//
// WHERE THEY COME FROM is a name, resolved against the aim rig's own anchors —
// the same measured points the breath and the wake come off, so a pose's
// bubbles leave the animal at the mouth or the flipper tips rather than out of
// a point in the middle of the model. An unknown name emits nothing rather
// than falling back to the body, because a silent fallback to the centre is
// exactly the bug that looks like a taste decision.
//
// UNDERWATER ONLY, like everything else in bubbles.js: a seal that has breached
// is in the air, and bubbles in the air read as a bug rather than as breath.
// ============================================================================

function anchorPoint(rig, name, side = 0) {
  if (!rig) return null;
  const a = rig.anchors ?? {};
  switch (name) {
    case 'mouth': return a.mouth ?? null;
    // The two front flipper tips — the measured skin at the end of each,
    // which is also where the muzzle flash comes off, so a burst and a shot
    // agree about where the hand is. `side` steps through them so a burst of
    // several is not all born at one tip.
    case 'fins': {
      const m = rig.muzzles;
      if (!m || !m.length) return null;
      return m[Math.abs(side) % m.length];
    }
    case 'finL': return a.finL ?? null;
    case 'finR': return a.finR ?? null;
    case 'tail': return a.tail ?? null;
    default: return null;
  }
}

// Per-source memory. `seq` is what tells one performance from the next — the
// same field the celebration driver captures its entry snapshot on — and
// `phase` is where the last frame left off, which is the other half of every
// edge test below.
function newTrack() {
  return { seq: -1, phase: 0, carry: 0, step: 0 };
}
const tracks = {
  celebrate: newTrack(),
  clap: newTrack(),
  coil: newTrack(),
};

export function resetPoseBubbles() {
  tracks.celebrate = newTrack();
  tracks.clap = newTrack();
  tracks.coil = newTrack();
}

/**
 * One source's worth of emission.
 *
 * @param spec    the `bubbles` block off whatever is being posed, or null
 * @param track   this source's memory (see newTrack)
 * @param seq     bumped once per performance, so a new one re-arms every burst
 * @param phase   0..1 toward full extension
 * @param weight  0..1 of the pose actually showing — what the rate scales by
 */
function run(spec, track, seq, phase, weight, rig, ctx, dt) {
  if (!spec || spec.enabled === false) return 0;
  let fired = 0;
  const emitter = spec.emitter ?? 'breathBubbles';
  const vx = ctx.velocity?.x ?? 0;
  const vy = ctx.velocity?.y ?? 0;

  // A NEW PERFORMANCE RE-ARMS EVERYTHING. Without this a second salute in the
  // same run starts with `track.phase` at wherever the last one ended, and
  // every burst below it is already "passed" — the second one is silent, which
  // looks precisely like the first one having been a fluke.
  if (track.seq !== seq) {
    track.seq = seq;
    track.phase = 0;
    track.carry = 0;
    track.step = 0;
  }

  // --- the bursts ----------------------------------------------------------
  for (const b of spec.bursts ?? []) {
    const at = Math.min(1, Math.max(0, b.at ?? 1));
    // Strictly greater on the leading edge and greater-or-equal on the
    // arrival, so a burst written at 1 fires on the frame the phase reaches
    // the peak rather than never (phase is capped there and can sit at
    // exactly 1 for the whole hold).
    const crossed = track.phase < at && phase >= at;
    if (!crossed) continue;
    const count = Math.max(0, Math.round(b.count ?? 0));
    for (let i = 0; i < count; i++) {
      const from = anchorPoint(rig, b.from ?? spec.from ?? 'mouth', track.step + i);
      if (!from) break;
      emit(b.emitter ?? emitter, from.x, from.y, {
        // Straight up with the emitter's own cone spreading it, like the
        // breath: bubbles leave the animal and start rising whichever way it
        // happens to be pointing.
        dirX: b.dirX ?? 0,
        dirY: b.dirY ?? 1,
        vx, vy,
        // `sizeMul`, NOT `scale` — see the note in the rate block below.
        sizeMul: (b.scale ?? 1) * (spec.scale ?? 1),
      });
      fired++;
    }
    track.step += count;
  }

  // --- the rate ------------------------------------------------------------
  const rate = (spec.rate ?? 0) * Math.min(1, Math.max(0, weight));
  if (rate > 0) {
    track.carry += rate * dt;
    let bursts = Math.floor(track.carry);
    // The remainder carries so a low rate still fires at the right average
    // frequency instead of being rounded away every frame; the BACKLOG does
    // not, so one long frame cannot pay itself back as a second of bubbles
    // arriving late.
    track.carry -= bursts;
    bursts = Math.min(bursts, spec.maxPerFrame ?? 4);
    for (let i = 0; i < bursts; i++) {
      const from = anchorPoint(rig, spec.from ?? 'mouth', track.step++);
      if (!from) break;
      emit(emitter, from.x, from.y, {
        dirX: spec.dirX ?? 0,
        dirY: spec.dirY ?? 1,
        vx, vy,
        // `sizeMul` IS THE SIZE. `scale` is not, and the name is the trap:
        // entities/particles.js spends `opts.scale` on the COUNT —
        //
        //   count = round((def.count ?? 8) * (opts.scale ?? 1) * density)
        //
        // — so every number the pose lab's "size" slider has ever written went
        // into how MANY bubbles came out, never how big they were. Dragged to
        // the floor it bottomed out at `Math.max(1, ...)`: one bubble, full
        // size, which reads as a slider that does nothing except at the very
        // end of its travel. `opts.sizeMul` is the one that multiplies
        // `def.size`.
        //
        // The block's field is still called `scale` because it is the name in
        // CONFIG.celebrate.poses.*.bubbles and in the lab's saved preset; what
        // it MEANS here is size. Rate and `puffs` already own the count, so
        // nothing has lost a control.
        sizeMul: spec.scale ?? 1,
      });
      fired++;
    }
  } else {
    track.carry = 0;
  }

  track.phase = phase;
  return fired;
}

/**
 * @param rawDt UNSCALED seconds — the same clock the performances run on. A
 *   celebration deliberately ignores the kill shot's slow motion, and bubbles
 *   timed against the water's dilated clock would arrive a second after the
 *   pose they belong to.
 * @param rig   the player's aim rig, for the anchors
 * @param ctx   { aboveSurface, velocity }
 * @returns how many bubbles were emitted this frame — for the tests, which
 *   otherwise have no way to tell "the pose emits nothing" from "the emitter
 *   name is wrong".
 */
export function updatePoseBubbles(rawDt, rig, ctx = {}) {
  if (!rig || ctx.aboveSurface) return 0;
  if (CONFIG.bubbles?.enabled === false) return 0;
  const dt = Math.min(Math.max(rawDt ?? 0, 0), 0.1);
  let fired = 0;

  if (celebrationState.active) {
    const p = CONFIG.celebrate?.poses?.[celebrationState.variant];
    // The same envelope the pose is being blended on, recomputed here rather
    // than exported: `phase` stops at the peak and `weight` covers the hold
    // and the release, which is exactly the split the two cadences want.
    const peak = Math.max(0.01, celebrationState.peakAt);
    const phase = Math.min(1, celebrationState.clock / peak);
    const release = celebrationState.release || (CONFIG.celebrate?.release ?? 0.5);
    const releaseFrom = Math.max(0, celebrationState.duration - release);
    const weight = celebrationState.clock <= peak
      ? phase
      : (celebrationState.clock <= releaseFrom
        ? 1
        : Math.max(0, 1 - (celebrationState.clock - releaseFrom) / Math.max(0.01, release)));
    fired += run(p?.bubbles, tracks.celebrate, celebrationState.seq, phase, weight, rig, ctx, dt);
  }

  // THE CLAP IS ITS OWN SOURCE, not a celebration variant — see the header of
  // systems/clap.js for the three reasons it is a separate system. Its phase
  // is `t`, which is the whole animation, and `presses` is its seq: a
  // re-trigger mid-stroke is a NEW clap even though the envelope was never let
  // go of, and it should get its own puff.
  if (clapState.active || clapState.t > 0.001) {
    fired += run(CONFIG.clap?.bubbles, tracks.clap, clapState.presses, clapState.t, clapState.t, rig, ctx, dt);
  }

  // THE COIL — the wind-up reaching its moment (systems/strikePose.js). A
  // third source for the same reason the clap is a second one: it is neither a
  // celebration nor a gesture but a STATE, and its clock is its own.
  //
  // `hits` is the seq — a player who lets go and grabs the button again inside
  // one wind-up has asked for the moment twice and should get two puffs, even
  // though the coil never returned to zero in between.
  //
  // PHASE IS CAPPED AT 1 AND `t` IS NOT. The snap overshoots the pose on
  // purpose (CONFIG.strikePose.overshoot), and a phase that went past 1 would
  // make a burst written at 1 fire on the way in and again on the way back
  // down through it — the double that the edge test exists to prevent, arriving
  // through the one door it leaves open. Capped, the hold sits at exactly 1 and
  // the crossing happens once.
  if (strikePoseState.active || strikePoseState.t > 0.001) {
    const phase = Math.min(1, strikePoseState.t);
    fired += run(CONFIG.strikePose?.bubbles, tracks.coil, strikePoseState.hits, phase, phase, rig, ctx, dt);
  }

  return fired;
}
