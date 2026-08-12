import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createBoneSpring } from './boneSpring.js';
import { buildChain, applyChain, coneGate, tipWorld } from './ikChain.js';

// Aim rig — the parts of the seal that point at what the player is pointing
// at, plus the bone points other systems hang things off.
//
// Three jobs, one system, because they're all the same question asked about
// different bones: where is this bit of the skeleton right now?
//
//   1. IK the front flippers onto the aim direction (CONFIG.fins).
//   2. IK the neck/head onto the aim direction (CONFIG.head).
//   3. Hang a damped spring off the tail so it lags the body (CONFIG.tail).
//      Not IK — that's systems/boneSpring.js, shared with the creatures whose
//      models shipped with no animation at all.
//   4. Publish world-space emit points — flipper tips, the mouth and the end
//      of the tail — which weapons fire from and the bubbles come off. These
//      sit ON the skin, at measured points, and are NOT the IK effectors the
//      chains above aim with; see the muzzles in createAimRig.
//
// This runs AFTER the AnimationMixer has written the frame's pose, and it
// only ever writes to bones named in ASSETS.<key>.aimRig. Everything the clip
// did to the spine, the rear flippers and the tail survives untouched — the
// override is scoped to the named chains by construction, not by convention,
// so no tuning value can leak out into the rest of the body.
//
// The CCD solver itself, the bend limits and the cone gate all live in
// systems/ikChain.js — shared with systems/headLook.js, which points the
// sharks and orcas at what they are hunting using exactly these pieces. What
// stays here is everything specific to the seal: which chains exist, that
// they aim at the player's cursor, the glance-to-camera behaviour, and the
// emit points weapons fire from.

// Scratch that stays here: the two aim directions this rig reasons about.
const _aim = new THREE.Vector3();
const _headAim = new THREE.Vector3();
const _up = new THREE.Vector3();
const _peek = new THREE.Vector3();

// Build the rig for one model instance. Returns null when this model has no
// aimRig descriptor or nothing in it resolves — every caller treats that as
// "no rig", falls back to the body position, and carries on.
export function createAimRig(instance) {
  const def = instance?.userData?.aimRig;
  if (!def) return null;

  const tipAxis = def.tipAxis ?? '+Y';
  const fins = (def.fins ?? [])
    .map((d, i) => {
      const chain = buildChain(instance, d, tipAxis, `aimRig fin chain "${d.name ?? i}"`);
      // Where the FLIPPER ENDS, as opposed to where the solver aims. See the
      // muzzle block in update() — these are two different questions and used
      // to share one answer.
      if (chain) chain.muzzleLength = d.muzzleLength ?? chain.tipLength;
      return chain;
    })
    .filter(Boolean);
  const head = def.head ? buildChain(instance, def.head, tipAxis, 'aimRig head chain') : null;
  const tail = def.tail ? buildChain(instance, def.tail, tipAxis, 'aimRig tail chain') : null;
  // The tail isn't aimed at anything — it just lags. Same solver the
  // unanimated creatures use for their whole body; see systems/boneSpring.js.
  const tailSpring = tail
    ? createBoneSpring(tail.bones, { tipAxis: tail.tipAxis, tipLength: tail.tipLength })
    : null;

  // Anchors are read-only bone points — no IK, just a world position
  // published every frame for particle emitters to fire from.
  const anchorDefs = [];
  for (const [name, a] of Object.entries(def.anchors ?? {})) {
    const bone = instance.getObjectByName(a.bone);
    if (!bone) {
      console.warn(`[aimRig] anchor "${name}" wants bone "${a.bone}", which this model doesn't have.`);
      continue;
    }
    anchorDefs.push({ name, bone, offset: new THREE.Vector3().fromArray(a.offset ?? [0, 0, 0]) });
  }

  if (fins.length === 0 && !head && !tail && anchorDefs.length === 0) return null;

  // Live objects, updated in place — callers hold these, not copies.
  //
  // A muzzle is NOT the chain's tip point. `chain.point` is the IK effector:
  // the thing the solver puts on a target placed `reach` chain-lengths away,
  // which is why it sits past the end of the limb — you aim a flipper by
  // straightening it along the aim, and an effector short of the skin would
  // fight the joint limits for the last few degrees. Fine for aiming, wrong
  // for anything you can SEE: the flash, the bullet and the club were all
  // hanging in open water off the end of the flipper.
  const muzzles = fins.map(() => new THREE.Vector3());
  const anchors = {};
  for (const a of anchorDefs) anchors[a.name] = new THREE.Vector3();

  let finWeight = 0;
  let headWeight = 0;
  // How far the head has given up on the aim, 0..1. Published so the body can
  // do the craning (see entities/player.js) — the neck alone should never be
  // the thing that reaches a target behind the animal.
  let glanceOut = 0;
  // Drives the wind-up tremble. Its own clock rather than a shared one, so a
  // rebuilt rig starts its buzz from zero instead of mid-cycle.
  let chargeClock = 0;
  let tailWeight = 0;

  // Fins and head ease between two weights: one for while the player is
  // actually shooting, a gentler one for the rest of the time, so the seal
  // isn't permanently locked in a firing pose while it swims.
  // `gate` folds in the cone falloff — routing it through the SAME ease is
  // what makes the head glide out of an unreachable target instead of
  // switching off.
  function easeWeight(current, cfg, engaged, suppressed, hasAim, dt, gate = 1) {
    const want = (!cfg.enabled || suppressed || !hasAim) ? 0 : (engaged ? cfg.weight : cfg.idleWeight) * gate;
    return current + (want - current) * (1 - Math.exp(-cfg.weightLerp * dt));
  }

  return {
    fins,
    head,
    tail,
    muzzles,
    anchors,

    // `aim` is the 2D world-space aim direction (input.aim). `engaged` is true
    // while the player is shooting. `suppressed` hands every chain back to the
    // clip outright, which is what lets an authored one-shot (the roll, the
    // death) play exactly as it was animated. `charge` is 0..1 of a strike
    // being wound up, which shivers the look target — see below.
    update(dt, aim, { engaged = false, suppressed = false, charge = 0 } = {}) {
      const finCfg = CONFIG.fins;
      const headCfg = CONFIG.head;
      const hasAim = aim && aim.lengthSq() > 1e-6;
      chargeClock += dt;
      if (hasAim) _aim.set(aim.x, aim.y, 0).normalize();

      finWeight = easeWeight(finWeight, { ...finCfg, enabled: finCfg.enabled && finCfg.ik }, engaged, suppressed, hasAim, dt);
      for (const chain of fins) applyChain(chain, dt, finCfg, finWeight, finCfg.tipLengthMul ?? 1, _aim);

      // ...and then the muzzles, off the same posed bones but at the asset's
      // MEASURED skin edge rather than at the effector. Read after the solve,
      // which leaves the world matrices fresh (see applyChain).
      const muzzleMul = finCfg.muzzleLengthMul ?? 1;
      for (let i = 0; i < fins.length; i++) {
        const chain = fins[i];
        // tipWorld measures in units of the chain's own tipLength, so this is
        // the ratio that lands it on muzzleLength instead. A chain with no
        // tipLength has no axis to walk down; its muzzle is the last joint.
        const along = chain.tipLength > 1e-6 ? (chain.muzzleLength * muzzleMul) / chain.tipLength : 0;
        tipWorld(chain, muzzles[i], along);
      }

      if (head) {
        // `glance` is how far the head has given up on the aim (0 while the
        // cursor is comfortably in front, 1 once it's fully behind).
        const gate = hasAim ? coneGate(head, headCfg, _aim) : 1;
        const glance = 1 - gate;
        glanceOut = glance;

        // Rather than sagging back to the clip when the cursor goes behind,
        // the head peeks out toward the viewer — a seal losing track of
        // something turns to look around itself, it doesn't fold its neck
        // backwards.
        //
        // The target is BLENDED onto the camera axis, not nudged toward it.
        // Adding a little +Z to a target still pointing behind the seal left
        // the neck craning back and merely leaning cameraward — the crane was
        // still the dominant motion, and on a real neck it reads as a break.
        // Lerping means that at full give-up the head is simply looking at the
        // viewer, with no backward component left to crane into. The heavy
        // lifting for "target is behind me" now belongs to the BODY twist (see
        // craneAngle in entities/player.js), which is how the animal actually
        // does it.
        _headAim.copy(_aim);
        const peek = glance * (headCfg.cameraBias ?? 0);
        if (peek > 0) {
          // Keeps a fraction of the target's height so the peek still looks up
          // or down toward whatever it lost, instead of levelling out.
          _peek.set(0, _aim.y * (headCfg.peekKeepY ?? 0.35), 1).normalize();
          _headAim.lerp(_peek, Math.min(1, peek));
          if (_headAim.lengthSq() > 1e-8) _headAim.normalize();
        }

        // Winding up a strike shivers the look target. Deliberately NOT a
        // pose: an authored coil pulled the neck back into exactly the crane
        // the peek above exists to avoid. A tremble reads as effort without
        // moving the head anywhere it shouldn't be.
        //
        // Two incommensurate frequencies, so it buzzes rather than settling
        // into a visible standing wave — and both are kept well under the
        // 60fps Nyquist limit, or the "vibration" aliases into a slow wobble.
        if (charge > 0) {
          const vib = CONFIG.strike.charge.vibrate ?? {};
          const amp = charge * (vib.head ?? 0);
          if (amp > 0) {
            const w = (vib.hz ?? 22) * Math.PI * 2;
            _headAim.x += amp * Math.sin(chargeClock * w);
            _headAim.y += amp * Math.sin(chargeClock * w * 1.37 + 1.1);
            if (_headAim.lengthSq() > 1e-8) _headAim.normalize();
          }
        }

        // ...and the weight doesn't fall all the way to zero any more, or
        // there'd be no pose left to put that glance into. It settles on
        // `glanceWeight` instead of 0.
        const effGate = gate + glance * (headCfg.glanceWeight ?? 0);
        headWeight = easeWeight(headWeight, headCfg, engaged, suppressed && headCfg.releaseOnOneShot, hasAim, dt, effGate);
        applyChain(head, dt, headCfg, headWeight, 1, _headAim);
      }

      if (tail && tailSpring) {
        const tailCfg = CONFIG.tail;
        const suppress = suppressed && tailCfg.releaseOnOneShot;
        const want = (tailCfg.enabled && !suppress) ? tailCfg.weight : 0;
        tailWeight += (want - tailWeight) * (1 - Math.exp(-tailCfg.weightLerp * dt));

        // The other half of the coil: the tail lifts while a strike is being
        // wound up. A SUSTAINED force rather than a kick — the spring's own
        // damping balances it out at a steady lift, so the tail eases up while
        // the button is held and settles back on its own when it isn't,
        // without this needing any state or easing of its own. Scaled by dt so
        // the steady-state height doesn't depend on framerate.
        if (charge > 0) {
          const lift = charge * (CONFIG.strike.charge.tailLift ?? 0) * dt;
          if (lift > 0) tailSpring.impulse(_up.set(0, 1, 0), lift, tailCfg.impulseTipBias ?? 1);
        }

        tailSpring.update(dt, tailCfg, tailWeight);
        tail.bones[0].updateWorldMatrix(false, true);
        tipWorld(tail, tail.point, 1);
      }

      // Anchors last: the mouth hangs off the head chain and the wake anchor
      // off the tail, so both have to be read after those chains are posed.
      for (const a of anchorDefs) {
        a.bone.updateWorldMatrix(true, false);
        anchors[a.name].copy(a.offset);
        a.bone.localToWorld(anchors[a.name]);
      }
    },

    // Rebuilt-model / new-run housekeeping: drop the smoothing history so
    // nothing eases out of a pose that belonged to the previous seal.
    reset() {
      finWeight = 0;
      headWeight = 0;
      tailWeight = 0;
      glanceOut = 0;
      chargeClock = 0;
      for (const chain of fins) chain.primed = false;
      if (head) head.primed = false;
      tailSpring?.reset();
    },

    // Shove the tail (a hit, a wall bounce). Handled by the same spring that
    // produces the swim lag, so the kick decays through it naturally.
    tailImpulse(dirWorld, strength) {
      tailSpring?.impulse(dirWorld, strength, CONFIG.tail.impulseTipBias ?? 1);
    },

    get finWeight() { return finWeight; },
    get headWeight() { return headWeight; },
    get glance() { return glanceOut; },
    get tailWeight() { return tailWeight; },
  };
}

// --- emit points -----------------------------------------------------------
//
// Which bit of the seal a weapon comes out of. `source` is one of the values
// in CONFIG.emitPoints: 'fins' (both flipper tips, indexed), 'mouth', 'tail',
// or 'body'. Anything a given model can't provide silently degrades to the
// body centre, so a ship model with no rig still fires.

// How many distinct origins `source` offers. 0 means "this model can't do it",
// which is the caller's cue to fall back. Callers also use the fin count to
// decide how many pellets a volley splits into.
export function emitPointCount(rig, source) {
  // Gated on `muzzle` alone, deliberately — `fins.enabled` switches off the
  // fin IK, and a flipper that isn't being aimed is still a perfectly good
  // place to fire from. It also has no business silencing the mouth.
  if (!rig || !CONFIG.fins.muzzle) return 0;
  if (source === 'fins') return rig.muzzles.length;
  if (source === 'mouth' || source === 'tail') return rig.anchors[source] ? 1 : 0;
  return 0;
}

// World-space firing point for origin `index` of `source`. ON the geometry by
// default — the end of the flipper, the snout, the tip of the tail — because
// every one of these points already sits at the outside edge of the animal and
// a shot has nothing left to clear.
//
// `muzzleNudge` can still push it further down the aim, and is 0. It replaces
// `muzzleOffset`, which was 0.35: stacked on an effector that already overshot
// the skin, that hung the muzzle flash an eighth of the seal's own length out
// in open water. The rename is deliberate — a saved tuning value outranks a
// config default, so the old field could not simply be re-defaulted.
//
// Returns `fallback` itself (not a copy) when the point isn't available, which
// is how callers tell the two cases apart.
export function emitPoint(rig, source, index, aimDir, fallback, out) {
  const cfg = CONFIG.fins;
  const count = emitPointCount(rig, source);
  if (count === 0) return fallback;

  if (source === 'fins') out.copy(rig.muzzles[((index % count) + count) % count]);
  else out.copy(rig.anchors[source]);

  const nudge = cfg.muzzleNudge ?? 0;
  if (aimDir && nudge !== 0) {
    out.x += aimDir.x * nudge;
    out.y += aimDir.y * nudge;
  }

  // The two flippers sit on opposite sides of the seal, which in side view is
  // pure camera depth — invisible, but enough to sort a projectile behind the
  // water plane. Flattening onto the body's z keeps every emit point firing
  // into the same plane everything else lives in.
  if (cfg.flattenZ) out.z = fallback.z;
  return out;
}
