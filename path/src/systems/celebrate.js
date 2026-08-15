import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { buildChain, applyChainToPoint, measureReach, smoothstep } from './ikChain.js';
import { trackCoverage } from './animation.js';
import { snapshotMoment } from './bossKill.js';

// ============================================================================
// THE VICTORY LAP — what the seal does with its body in the second after a
// boss dies.
//
// systems/bossKill.js already stops the world and pushes the frame in on the
// seal, and systems/bossShot.js keeps one PNG of it. Until now the pose in
// that picture was whatever the seal happened to be doing when the last shot
// landed — usually mid-swim-cycle, facing away, indistinguishable from any
// other frame of the run. Eight bosses, eight pictures of a seal swimming.
//
// So the seal now PERFORMS, and it performs a different thing each time.
//
// -----------------------------------------------------------------------
// WHY THIS IS PROCEDURAL AND NOT A CLIP
//
// furseal.glb ships 11 clips and none of them is a celebration. The escorts'
// model (sealhelper.glb) DOES have a `clapping` clip, and the obvious move —
// play the escorts' clap on the player — does not work, because the two files
// are not the same rig despite coming from the same author:
//
//   furseal.glb    28 joints, neck SPLIT in two (neck01_05 -> neck02_06),
//                  tail00 parented to chest_04, plus tail02_023 and ball_026
//   sealhelper.glb 25 joints, one neck bone, tail00 parented to all_ctrl_02
//
// three.js binds animation tracks by node NAME, and the split neck shifts
// every suffix below it by one: the escorts' `hand_L_013` is the player's
// `arm_L_014`, and their `foot_R_023` is the player's TAIL. The clip would
// still play — it would just drive the wrong bone at every joint. Renaming the
// tracks doesn't rescue it either, because the two rigs disagree on rest pose
// (shoulder_R by 1.40 in quaternion components, tail00 by 1.79) and on
// proportion (the player's forearm is 3.5x the escort's). Same local
// rotations, different pose. tools/celebrate-probe.mjs prints all of it.
//
// What the player's rig DOES have is room to move: its flippers rest 15.5% of
// its body span apart against the escorts' 41.1%, on a proportionally longer
// arm. So the celebration is posed rather than played, through the same CCD
// solver the aim rig and the crab claws use.
//
// -----------------------------------------------------------------------
// WHICH WAY IS UP (all measured, none of it guessed — see the probe)
//
// In the posed instance's own frame:
//
//   forward  = +Y   (tail -> head runs +2.15 on Y)
//   dorsal   = -X   ("up" on screen; the bark clip throws the snout to -0.885
//                   on X, and the skin spans -1.037..0.158)
//   lateral  = ±Z   (left flipper at z=-0.71, right at z=+0.74)
//
// THE FLIPPERS SPREAD ALONG THE CAMERA AXIS. The seal swims in the world XY
// plane with the camera down Z, so it is seen in profile: 6.14 long and 1.39
// thick on screen, with 3.51 of flipper span pointing at and away from the
// viewer. That is the single fact that shapes every pose below — a literal
// clap closes along DEPTH, where the two flippers project to nearly the same
// place on screen and the contact reads as almost nothing.
//
// So the poses that carry are the ones that move things in the SCREEN plane
// (dorsal -X and forward +Y): flippers thrown up over the head, a somersault
// about the lateral axis, a tail sweeping through the frame. `clap` is still
// here because the user asked for it and because it is the one that reads as
// the animal being pleased rather than merely athletic — it just swings the
// flippers up into frame FIRST so there is a silhouette to watch close.
//
// -----------------------------------------------------------------------
// THE CLOCK. This runs on the WALL clock, and that is not a detail.
//
// A kill shot drops the world to 0.12x for its hold, and every mixer in the
// game runs on that dilated delta — which is what makes the seal read as held
// rather than frozen. The snapshot is taken about a second of WALL time after
// the kill (dilateTime 0.12 + 0.6 of beatTime 1.5). On the dilated clock only
// a tenth of a second of animation has elapsed by then. A celebration timed
// that way would be caught in its first twitch in every single trophy,
// forever.
//
// So the envelope below is fed rawDt, exactly like the camera push it is
// posing for, and its peak is derived FROM the shot's own timing rather than
// hand-typed next to it — retune the shot and the pose follows it.
// ============================================================================

// Scratch, module-level so posing allocates nothing per frame.
const _root = new THREE.Vector3();
const _target = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fore = new THREE.Vector3();
const _lat = new THREE.Vector3();

/**
 * The performance in flight, shared by the player's driver and the escorts.
 * Modelled on bossKillState: one module owns the clock, and everything that
 * wants to move to it reads the same numbers rather than keeping its own.
 */
export const celebrationState = {
  active: false,
  variant: null,
  // Bumped once per celebration. Anything that has to act ONCE at the start of
  // one — the escorts, who each arm a staggered clap — watches this rather
  // than `active`, which is equally true on every frame of the performance and
  // so cannot tell a new celebration from the middle of the last one.
  seq: 0,
  // WALL seconds since the kill. Never the dilated clock — see the header.
  clock: 0,
  duration: 0,
  // When the pose is meant to be at full extension, in the same wall seconds.
  peakAt: 0,
};

function cfg() {
  return CONFIG.celebrate ?? {};
}

// When the trophy frame is grabbed, in wall seconds after the kill. It lives
// in systems/bossKill.js now — the shot owns its own timing, and three modules
// time themselves off it — and is re-exported here because this is where the
// callers (ui/animDebug.js, tools/celebrate-test.mjs) have always imported it
// from, and because the pose below is the main thing that reads it.
export { snapshotMoment };

/** Pick a variant by weight. Returns null when every weight is 0 or absent. */
function pickVariant(rng) {
  const weights = cfg().weights ?? {};
  const entries = Object.entries(weights).filter(([, w]) => Number.isFinite(w) && w > 0);
  if (!entries.length) return null;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [name, w] of entries) {
    roll -= w;
    if (roll <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

/**
 * Roll for a celebration. Called the instant a boss dies, from the same place
 * that starts the kill shot — both are the aftermath of one event and both run
 * on the wall clock from the same zero.
 *
 * @param rng  injectable for the tests, which must not be at the mercy of a
 *             coin flip (see tools/celebrate-test.mjs).
 * @returns the variant that will play, or null if this kill doesn't get one.
 */
export function startCelebration(rng = Math.random) {
  const c = cfg();
  if (c.enabled === false) return null;
  if (rng() > (c.chance ?? 0)) return null;
  const variant = pickVariant(rng);
  if (!variant) return null;

  // Land full extension a hair BEFORE the shutter rather than exactly on it.
  // The pose is smoothed (the IK chains slerp toward their solution), so it is
  // still arriving for a frame or two after the envelope says it got there,
  // and a picture taken on the leading edge of that catches the seal on its
  // way into the pose instead of in it.
  const peak = Math.max(0.05, snapshotMoment() - (c.peakLead ?? 0.03));
  celebrationState.active = true;
  celebrationState.variant = variant;
  celebrationState.seq++;
  celebrationState.clock = 0;
  celebrationState.peakAt = peak;
  celebrationState.duration = peak + (c.hold ?? 0.35) + (c.release ?? 0.5);
  return variant;
}

/**
 * @param rawDt UNSCALED seconds. Handing this the dilated delta is the one
 *              mistake that makes the whole system invisible — see the header.
 */
export function updateCelebration(rawDt) {
  if (!celebrationState.active) return;
  celebrationState.clock += rawDt;
  if (celebrationState.clock >= celebrationState.duration) resetCelebration();
}

export function resetCelebration() {
  celebrationState.active = false;
  celebrationState.variant = null;
  celebrationState.clock = 0;
  celebrationState.duration = 0;
  celebrationState.peakAt = 0;
}

/**
 * How far into the performance we are, 0..1, and how much of the pose is
 * showing. Split because the two are genuinely different questions: `phase`
 * drives the motion (a clap's rhythm, a somersault's rotation) and `weight`
 * drives how much of it replaces the swim cycle underneath.
 */
function envelope() {
  const { clock, peakAt, duration } = celebrationState;
  const phase = peakAt > 0 ? Math.min(1, clock / peakAt) : 1;
  const release = cfg().release ?? 0.5;
  const releaseFrom = Math.max(0, duration - release);
  let weight;
  if (clock <= peakAt) weight = smoothstep(0, 1, phase);
  else if (clock <= releaseFrom) weight = 1;
  else weight = 1 - smoothstep(0, 1, (clock - releaseFrom) / Math.max(0.01, release));
  return { phase, weight };
}

// ---------------------------------------------------------------------------
// THE POSES.
//
// Every target is built from the chain's OWN root and its OWN measured reach,
// in the instance's own frame — never in hand-typed world units. Two reasons,
// both of which have bitten this project before: the seal carries a size
// multiplier that a literal offset would ignore, and the two flippers do not
// even have the same reach (1.818 left, 2.037 right — the rig is not
// symmetric). A target written as "0.8 of the way up this limb's own length"
// is right on both flippers and stays right if the model is ever re-exported.
//
// `side` is -1 for the left flipper and +1 for the right, matching the
// measured rest positions (left at z=-0.71, right at z=+0.74).
// ---------------------------------------------------------------------------

function finTarget(chain, out, basis, side, up, fore, lateral) {
  chain.bones[0].updateWorldMatrix(true, true);
  chain.bones[0].getWorldPosition(_root);
  const reach = measureReach(chain, 1);
  // `up` and `fore` are measured from the limb's OWN root, because how high a
  // flipper is held is a question about that shoulder. `lateral` is measured
  // from the BODY'S CENTRELINE instead, because how far out to the side a
  // flipper is held is a question about the animal.
  //
  // That distinction is the difference between a clap and a shrug, and it is
  // worth spelling out because the first version got it wrong in a way that
  // still looked plausible: anchored at the shoulder, `close: 0.08` asked each
  // flipper to come 8% of its reach toward the midline FROM A SHOULDER THAT IS
  // ALREADY 0.24 OUT, so the two hands stopped 0.84 apart — a measurable
  // closing motion that never touches. Measured from the centreline it means
  // what it says.
  const latRoot = _lat.copy(_root).sub(basis.origin).dot(basis.lat);
  out.copy(_root)
    .addScaledVector(basis.up, up * reach)
    .addScaledVector(basis.fore, fore * reach)
    .addScaledVector(basis.lat, side * lateral * reach - latRoot);
  return out;
}

const POSES = {
  // Both flippers thrown up over the head and held there. The plainest read of
  // the five and the one that survives the profile view best: it is a pure
  // silhouette change, so it does not matter which way the seal is facing or
  // how much of the flipper is hidden behind the body.
  finsUp(ctx) {
    const p = cfg().poses?.finsUp ?? {};
    // A slow tremble, because a held pose with no motion in it reads as a
    // frozen frame — the exact thing the kill shot is at pains not to look
    // like. Runs on the shared clock so both flippers shake together.
    const shake = Math.sin(celebrationState.clock * (p.trembleHz ?? 9)) * (p.tremble ?? 0.04);
    for (const { chain, side } of ctx.fins) {
      finTarget(chain, _target, ctx.basis, side, (p.up ?? 0.85) + shake, p.fore ?? 0.35, p.spread ?? 0.3);
      ctx.solve(chain, _target);
    }
    if (ctx.head) {
      // Looking up after them. Without this the seal holds both flippers over
      // a head that is still tracking the cursor, which reads as two animals.
      finTarget(ctx.head, _target, ctx.basis, 1, p.headUp ?? 0.45, p.headFore ?? 0.8, 0);
      ctx.solve(ctx.head, _target);
    }
  },

  // The sea lion clap. The flippers come up and forward INTO frame first and
  // only then close, so there is a silhouette to watch the contact happen in —
  // see the header on why the closing itself is mostly depth.
  clap(ctx) {
    const p = cfg().poses?.clap ?? {};
    // Closeness on a raised cosine: 0 apart, 1 together. `beats` wants to be a
    // HALF-INTEGER so that a contact lands exactly on the peak, which is the
    // frame the trophy is taken on — at 1.5 the flippers meet a third of the
    // way in and again right on the shutter.
    const beats = p.beats ?? 1.5;
    const close = (1 - Math.cos(ctx.phase * Math.PI * 2 * beats)) / 2;
    const lateral = (p.open ?? 0.5) + ((p.close ?? 0.08) - (p.open ?? 0.5)) * close;
    // The body bobs with the clap rather than the flippers moving alone.
    const bob = close * (p.bob ?? 0.08);
    for (const { chain, side } of ctx.fins) {
      finTarget(chain, _target, ctx.basis, side, (p.up ?? 0.32) + bob, p.fore ?? 0.5, lateral);
      ctx.solve(chain, _target);
    }
    if (ctx.head) {
      finTarget(ctx.head, _target, ctx.basis, 1, (p.headUp ?? 0.3) + bob, p.headFore ?? 0.85, 0);
      ctx.solve(ctx.head, _target);
    }
  },

  // A somersault, about the seal's own lateral axis — which is the camera axis,
  // so the whole turn happens in the screen plane and reads at any facing.
  //
  // The rotation is deliberately NOT multiplied by the envelope weight. Every
  // other pose here blends out by easing back toward the clip; a rotation that
  // did that would visibly UNWIND the somersault, spinning the seal backwards
  // through the turn it just did. Instead it eases monotonically to a whole
  // number of turns, which IS the identity — the pose blends out by arriving.
  flip(ctx) {
    const p = cfg().poses?.flip ?? {};
    // The rotation itself is NOT applied here — see celebrationSpin(), which
    // entities/player.js folds into the body quaternion alongside the crane and
    // the barrel roll. Tucked, the way anything that means to rotate fast tucks.
    for (const { chain, side } of ctx.fins) {
      finTarget(chain, _target, ctx.basis, side, p.tuckUp ?? 0.1, p.tuckFore ?? -0.25, p.tuck ?? 0.35);
      ctx.solve(chain, _target);
    }
  },

  // The tail sweeping through the frame, dorsal-ventral like a fluke — which
  // is the plane the animal actually swims in and, in profile, the plane the
  // camera can see.
  tailWag(ctx) {
    const p = cfg().poses?.tailWag ?? {};
    if (ctx.tail) {
      // On the UNCAPPED phase, unlike every other pose here. `ctx.phase` stops
      // at 1 on the peak, which is right for a pose that arrives and is held —
      // and wrong for the one pose that is a repeating motion, since the tail
      // would swing once and then freeze mid-sweep for the whole hold.
      //
      // `beats` then wants to be an ODD QUARTER (2.25, not 2.5) so that the
      // peak lands on full deflection: on a whole or half beat the sine is at
      // a zero crossing exactly when the shutter opens, and every trophy gets
      // a tail hanging straight down.
      const swung = celebrationState.clock / Math.max(0.01, celebrationState.peakAt);
      const sweep = Math.sin(swung * Math.PI * 2 * (p.beats ?? 2.25)) * (p.sweep ?? 0.5);
      finTarget(ctx.tail, _target, ctx.basis, 1, sweep, p.fore ?? -0.85, 0);
      ctx.solve(ctx.tail, _target);
    }
    // The front half braces against it, or the tail reads as detached.
    for (const { chain, side } of ctx.fins) {
      finTarget(chain, _target, ctx.basis, side, p.finUp ?? 0.35, p.finFore ?? 0.15, p.finSpread ?? 0.45);
      ctx.solve(chain, _target);
    }
    if (ctx.head) {
      finTarget(ctx.head, _target, ctx.basis, 1, p.headUp ?? 0.35, p.headFore ?? 0.8, 0);
      ctx.solve(ctx.head, _target);
    }
  },

  // Head thrown back and barking at the sky, flippers swept behind. The most
  // "animal" of the five and the one that reads at the smallest size, since it
  // is all in the line of the neck.
  headToss(ctx) {
    const p = cfg().poses?.headToss ?? {};
    if (ctx.head) {
      finTarget(ctx.head, _target, ctx.basis, 1, p.up ?? 0.8, p.fore ?? 0.35, 0);
      ctx.solve(ctx.head, _target);
    }
    for (const { chain, side } of ctx.fins) {
      finTarget(chain, _target, ctx.basis, side, p.finUp ?? -0.15, p.finFore ?? -0.35, p.finSpread ?? 0.5);
      ctx.solve(chain, _target);
    }
  },
};

/**
 * THE SOMERSAULT, as an angle rather than as a write.
 *
 * Every other pose here is applied by this file directly to the bones. The
 * flip is not, and the reason is ownership: entities/player.js builds the body
 * quaternion out of a crane and a barrel roll every frame and is explicit
 * about composing them rather than writing Euler components, because the roll
 * has to happen about the seal's own long axis whatever the crane is doing.
 * The flip is a third term in exactly that composition — about the seal's own
 * LATERAL axis, which is also the camera axis, so the turn happens in the
 * screen plane and reads at any facing.
 *
 * Written from here it would be a fourth writer of one transform, and it would
 * depend on player.js having already written this frame — a dependency that
 * holds today and silently accumulates a spin into the seal on any frame where
 * it doesn't (the first version of this drifted 36 degrees over one
 * celebration, which is how the ordering got found).
 *
 * A pure function of the shared clock, so the caller can ask whenever it likes.
 *
 * @returns radians about the body's local Z. 0 when nothing is flipping.
 */
export function celebrationSpin() {
  if (!celebrationState.active || celebrationState.variant !== 'flip') return 0;
  const p = cfg().poses?.flip ?? {};
  // Over the attack AND the hold, so the seal is caught mid-turn by the
  // shutter (upside down, at roughly two-thirds round) rather than posed neatly
  // upright in every picture. It eases to a WHOLE number of turns, which is
  // the identity — so the flip needs no blend-out and cannot leave the seal
  // part-rotated. Enveloping it like the other poses would visibly unwind the
  // somersault instead, spinning the seal backwards through the turn it just
  // did.
  const spinFor = Math.max(0.01, celebrationState.peakAt + (cfg().hold ?? 0.35));
  const u = Math.min(1, celebrationState.clock / spinFor);
  return smoothstep(0, 1, u) * Math.PI * 2 * (p.turns ?? 1);
}

/** Every variant this build knows how to pose, for the tuner and the tests. */
export const CELEBRATION_VARIANTS = Object.keys(POSES);

/**
 * Build the poser for one model instance.
 *
 * REUSES THE AIM RIG'S CHAIN DESCRIPTORS rather than declaring its own. Those
 * bone lists and tip lengths were measured onto this exact model (see the
 * notes on ASSETS.ship.aimRig — the fin tips are measured onto the outermost
 * skinned vertex, the head chain deliberately stops short of the jaw so the
 * seal doesn't gape). A second copy of that in this file would be a second
 * thing to keep right, and it would silently rot the first time the model is
 * re-exported.
 *
 * @returns null for a model with no aim rig, which every caller treats as
 *   "this creature doesn't celebrate".
 */
export function createCelebrationDriver(instance) {
  const def = instance?.userData?.aimRig;
  if (!def) return null;

  const tipAxis = def.tipAxis ?? '+Y';
  const fins = (def.fins ?? [])
    .map((d) => {
      const chain = buildChain(instance, d, tipAxis, `celebrate fin "${d.name ?? '?'}"`);
      if (!chain) return null;
      // Which side of the body this flipper is on, taken from where the bone
      // ACTUALLY IS rather than from its name — `left`/`right` in the asset
      // are labels, and a mirrored re-export would swap the geometry without
      // touching them. Measured at build time, once.
      chain.bones[0].updateWorldMatrix(true, true);
      chain.bones[0].getWorldPosition(_root);
      instance.worldToLocal(_root);
      return { chain, side: _root.z < 0 ? -1 : 1 };
    })
    .filter(Boolean);
  const head = def.head ? buildChain(instance, def.head, tipAxis, 'celebrate head chain') : null;
  const tail = def.tail ? buildChain(instance, def.tail, tipAxis, 'celebrate tail chain') : null;
  if (!fins.length && !head && !tail) return null;

  const basis = {
    up: new THREE.Vector3(), fore: new THREE.Vector3(), lat: new THREE.Vector3(),
    origin: new THREE.Vector3(), // the body's centreline, which `lateral` is measured from
  };
  const ctx = { fins, head, tail, basis, phase: 0, solve: null };

  // THE POSE THE SEAL WAS IN WHEN THE BOSS DIED, captured on the first frame
  // of each celebration and restored at the top of every frame after it.
  //
  // This is not tidiness, it is the only thing standing between this system
  // and a permanent ratchet — and the reason is a property of the model, not
  // of this code. THE `swim` CLIP DOES NOT KEY THE FRONT FLIPPERS: it writes
  // 19 of the rig's nodes and shoulder_L_011, uparm_L_012, arm_L_013,
  // hand_L_014 and shoulder_R_015 are not among them (every other clip in the
  // file keys 23 and covers them all).
  //
  // So while the seal is swimming, NOTHING lays an absolute pose on those
  // bones each frame. applyChainToPoint blends from whatever is already in a
  // bone toward its solution, which means on an unkeyed bone it blends from
  // its own previous output — the weight easing back to 0 hands the flipper
  // back to the celebration pose rather than to the swim cycle, and the seal
  // finishes every boss fight a little further into a wave it never lowers.
  // Measured before this existed: 0.54 out of position after eight kills,
  // against a control seal that never celebrated.
  //
  // Restoring an entry snapshot rather than the bind pose keeps the blend
  // honest at both ends: the pose grows out of exactly where the animal was
  // and returns to exactly there, with nothing to pop at either edge.
  // ...but ONLY on the bones that actually need it, which is the other half of
  // this and was found the same way (measured, against a control seal).
  //
  // Restoring a bone the mixer IS driving does not merely waste work, it
  // breaks the mixer: three.js's PropertyMixer skips its write whenever the
  // value it computes equals the one it last wrote, on the reasonable
  // assumption that nobody else touched the bone in between. Overwrite one and
  // that cache is stale, so the clip stops restoring it — the right flipper
  // finished 13.8 degrees out and STAYED there, while the unkeyed left one was
  // perfect. Exactly backwards from what the fix was supposed to do.
  //
  // So a bone is restored only when the mixer cannot be relied on to take it
  // back, and is otherwise left alone to be overwritten by the clip as the
  // weight comes off.
  //
  // "Cannot be relied on" is NOT the same as "unkeyed", and the difference is
  // the whole trap. A track with a SINGLE keyframe is a constant: the mixer
  // computes the same value every frame, its value-unchanged check fires, and
  // it stops writing after the first one — so a constant-keyed bone is exactly
  // as unrecoverable as an unkeyed bone, while looking keyed to any check that
  // only asks whether a track exists. On this model the swim cycle keys
  // uparm_R_016, arm_R_017, hand_R_018 and neck01_05 with one keyframe each,
  // against 31 for head_07 and tail01_020 — so the flipper that LOOKED safe
  // was the one that stuck 74 degrees out of place.
  // The test itself lives in systems/animation.js, shared with the state
  // inspector (ui/animDebug.js) — one answer to "will the clip put this bone
  // back", so the panel cannot tell you something different from what this
  // file acts on.
  const coverage = trackCoverage(instance);
  const mixerOwns = (bone) => coverage.get(bone.name)?.owned === true;

  const posedBones = [...new Set([
    ...fins.flatMap(({ chain }) => chain.bones),
    ...(head?.bones ?? []),
    ...(tail?.bones ?? []),
  ])].filter((b) => !mixerOwns(b));
  const entryQ = posedBones.map((b) => b.quaternion.clone());
  let entrySeq = -1;

  return {
    /**
     * Pose this frame. MUST run after the animation controller and after the
     * aim rig, for the reason systems/crabClaw.js spells out: those write an
     * absolute pose every frame, so anything that runs before them is simply
     * overwritten and appears to do nothing at all. Being last is also what
     * lets the blend weight mean what it says — the pose it eases out of is
     * whatever the swim cycle and the aim were already doing.
     *
     * @param rawDt UNSCALED seconds.
     */
    update(rawDt) {
      if (!celebrationState.active) {
        // The frame the performance ends, put the bones back exactly once.
        // Without this the seal keeps whatever fraction of the pose the last
        // live frame happened to leave in them — small, but it is never
        // cleaned up on the bones the swim clip doesn't key, so it is the seed
        // of the same ratchet entryQ exists to prevent.
        if (entrySeq !== -1) {
          for (let i = 0; i < posedBones.length; i++) posedBones[i].quaternion.copy(entryQ[i]);
          entrySeq = -1;
        }
        return;
      }
      const pose = POSES[celebrationState.variant];
      if (!pose) return;
      const ik = cfg().ik ?? {};
      const { phase, weight } = envelope();

      // First frame of this celebration: remember where the animal was. After
      // that, put it back there before posing — see the entryQ note above for
      // why this is load-bearing rather than housekeeping.
      if (entrySeq !== celebrationState.seq) {
        entrySeq = celebrationState.seq;
        for (let i = 0; i < posedBones.length; i++) entryQ[i].copy(posedBones[i].quaternion);
      } else {
        for (let i = 0; i < posedBones.length; i++) posedBones[i].quaternion.copy(entryQ[i]);
      }

      if (weight <= 0.001 && celebrationState.clock > celebrationState.peakAt) return;

      // The seal's own axes, in world space, re-read every frame because the
      // body turns: `up` is dorsal (-X), `fore` is the nose (+Y) and `lat`
      // runs left-to-right through the flippers (+Z). Normalised, so the
      // size multiplier on the instance can't scale the pose targets twice.
      instance.updateWorldMatrix(true, false);
      instance.matrixWorld.extractBasis(basis.up, basis.fore, basis.lat);
      basis.up.normalize().multiplyScalar(-1);
      basis.fore.normalize();
      basis.lat.normalize();
      instance.getWorldPosition(basis.origin);

      ctx.phase = phase;
      ctx.solve = (chain, target) => applyChainToPoint(chain, rawDt, ik, weight, 1, target);
      pose(ctx);
    },

    /**
     * Drop the pose. The IK chains keep a smoothed pose across frames, so a
     * driver that isn't unprimed here would blend the last celebration's
     * flipper position into the first frames of the next one — most visibly on
     * a restart, where the seal would begin its run finishing a clap for a
     * boss that died in the previous game.
     */
    reset() {
      for (const { chain } of fins) chain.primed = false;
      if (head) head.primed = false;
      if (tail) tail.primed = false;
    },

    // What actually resolved, for the tests: bone lookup drops names that miss
    // silently, so this is the only way to tell "two flippers" from "two
    // declared, one survived".
    finCount: fins.length,
    hasHead: !!head,
    hasTail: !!tail,
  };
}
