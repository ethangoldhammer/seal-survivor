import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { beatDuration, beatPhase } from './music.js';
import { createBoneSpring } from './boneSpring.js';

// A real state machine for rigged creatures, not just a 3-way switch.
//
// Two kinds of state:
//   LOCOMOTION (looping) — idle / swim / boost / surfaceIdle / surfaceMove.
//     Chosen every frame from the caller's current movement; whichever one is
//     passed to update() is what plays.
//   ONE-SHOT (fires once, then gets out of the way) — strike / hit / bark /
//     death. Triggered explicitly via trigger(), plays through, then hands
//     control back to whatever locomotion state is current. A one-shot always
//     wins over locomotion while it's running, and a higher-priority one-shot
//     can interrupt a lower one (so dying mid-bark cuts the bark off, but a
//     bark can't cut off a death).
//
// Clip resolution per state, in order:
//   1. ASSETS.<key>.animations[state] names a clip that exists -> play it.
//   2. Exactly one clip exists in the file and no explicit mapping was given
//      -> reuse that one clip for every state, at a different playback speed
//      per state (CONFIG.animation.states[state].clipTimeScale). Many games
//      stretch one locomotion cycle across speed tiers rather than authoring
//      idle/walk/run separately.
//   3. ASSETS.<key>.rig names a bone chain -> procedural sine-wave fallback.
//   4. Neither -> that state does nothing (logged once), not a crash.
//
// On top of whichever of those wrote the pose, a model with a `rig` chain also
// gets damped-spring secondary motion (systems/boneSpring.js, CONFIG.animation
// .spring). That does two jobs at once: it stops the sine-wave fallback from
// looking like a rigid metronome — the body now lags and overshoots when the
// creature turns — and it's what carries a hit reaction, since `impulse()`
// just shoves the same springs and lets them settle. See trigger('hit') vs
// impulse(): the former plays a clip, the latter kicks the skeleton, and a
// creature with no clips can still do the second.
//
// Anything not covered still degrades gracefully: a model with no clip for
// 'strike' just keeps swimming through the dash rather than freezing, and a
// caller that only ever passes idle/swim/boost (every enemy, the projectiles,
// the beluga drone) behaves exactly as it did before this file grew.

const AXES = { x: 'x', y: 'y', z: 'z' };
const BONE_LENGTH_AXIS = new THREE.Vector3(0, 1, 0);

// Build a spring for one chain, working out what the LAST bone should aim at.
//
// The solver needs a direction for every bone it drives, and it gets that by
// looking at the next joint down. The final bone has no next joint in the
// chain, so createBoneSpring falls back to the bone's own child, and failing
// that to `tipAxis * tipLength`. Leave tipLength at its default of 0 and that
// last fallback is a zero-length vector — the solver measures a direction of
// length 0, hits its degenerate-input guard, and skips the bone entirely.
//
// The result is silent and easy to miss: the chain still springs, just with a
// dead final bone. It only bites when the chain ends on a LEAF, which is a
// property of the model rather than of the chain we wrote — megalodon and
// mightyMeg end on a bare fin tip, while orca happens to end one bone above
// a fluke that forks, and so was fine by luck.
//
// Every rig in this project runs its bones along their own +Y, so a leaf
// bone's offset from its parent is the best estimate available of its own
// length. Chains ending on a bone that HAS a child are unaffected — that
// child still wins.
function makeSpring(bones) {
  const last = bones[bones.length - 1];
  const tipLength = last.children.some((c) => c.isBone) ? 0 : last.position.length();
  return createBoneSpring(bones, { tipAxis: BONE_LENGTH_AXIS, tipLength });
}


export const LOCOMOTION_STATES = ['idle', 'swim', 'boost', 'surfaceIdle', 'surfaceMove'];
// 'bite' is separate from 'strike' on purpose. 'strike' is the seal's dash;
// 'bite' is a predator snapping its jaws at what it's chasing, and the two want
// opposite handling — a dash is capped short so it can't lock the seal out of
// swimming, while a bite is a whole performance (megalodon's is 1.3s) that
// should play out. Sharing one state would have meant one maxDuration for both.
// Only megalodon.glb ships a clip for this; everything else bites through the
// procedural jaw in systems/jaw.js instead.
export const ONESHOT_STATES = ['strike', 'bite', 'hit', 'bark', 'death'];

export function createAnimationController(instance) {
  const clips = instance.userData.clips ?? [];
  const rig = instance.userData.rig ?? null;
  const clipNames = instance.userData.animationNames ?? {};
  const explicitlyMapped = Object.keys(clipNames).length > 0;
  const singleClipReuse = clips.length === 1 && !explicitlyMapped;

  const mixer = clips.length ? new THREE.AnimationMixer(instance) : null;

  const stateAction = {};
  const stateClipDuration = {};
  if (mixer) {
    for (const state of [...LOCOMOTION_STATES, ...ONESHOT_STATES]) {
      let clip = clipNames[state] ? THREE.AnimationClip.findByName(clips, clipNames[state]) : null;
      // Single-clip reuse only ever covers locomotion — firing the same
      // generic swim cycle as a "strike" or "death" would read as a bug, not
      // as a stylistic reuse, so unmapped one-shots simply stay unavailable.
      if (!clip && singleClipReuse && LOCOMOTION_STATES.includes(state)) clip = clips[0];
      if (!clip) continue;

      const action = mixer.clipAction(clip);
      action.enabled = true;
      const isOneShot = ONESHOT_STATES.includes(state);
      if (isOneShot) {
        action.setLoop(THREE.LoopOnce, 1);
        // 'death' should hold its final pose; other one-shots hand back to
        // locomotion, so clamping them would freeze the model mid-pose for a
        // frame before the crossfade takes over.
        action.clampWhenFinished = state === 'death';
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
      stateAction[state] = action;
      stateClipDuration[state] = clip.duration;
    }
  }

  // A state only gets the CONFIG-driven speed multiplier when it's SHARING a
  // clip with another state (that's the whole point of the multiplier —
  // differentiating one reused animation into several paces). A state with
  // its own distinct clip plays at that clip's authored speed instead, or a
  // clip already authored as a sprint ends up double-fast.
  const usersOf = new Map();
  for (const [state, action] of Object.entries(stateAction)) {
    if (!usersOf.has(action)) usersOf.set(action, []);
    usersOf.get(action).push(state);
  }

  let wagBones = [];
  let headBones = [];
  let axis = 'y';
  if (rig) {
    axis = AXES[rig.axis] ?? 'y';
    wagBones = (rig.wagChain ?? []).map((name) => instance.getObjectByName(name)).filter(Boolean);
    headBones = (rig.headChain ?? []).map((name) => instance.getObjectByName(name)).filter(Boolean);
    // Only worth warning about when the rig would actually be USED — a model
    // whose clips already cover everything doesn't care that a leftover
    // fallback rig from a previous model's bone names no longer matches.
    const locomotionCovered = LOCOMOTION_STATES.some((s) => stateAction[s]);
    if (rig.wagChain?.length && wagBones.length === 0 && !locomotionCovered) {
      console.warn('[animation] none of rig.wagChain bone names were found on this model, and it has no clips to fall back from.');
    }
  }

  // The bind pose these bones start in. Captured once, before anything has
  // had a chance to write to them, so it's the model's own rest shape rather
  // than whatever last frame left behind. See proceduralDrive.
  const wagRest = wagBones.map((b) => b.quaternion.clone());
  const headRest = headBones.map((b) => b.quaternion.clone());

  // The spring drives the SAME chain the sine wave does, one layer later —
  // sine sets a target pose, spring lags toward it. Bones only, so a model
  // with no rig simply doesn't get one and impulse() becomes a no-op.
  // Every bone rig in this project runs its length along its own +Y (each
  // child sits at a pure +Y offset), which is what the tip fallback needs.
  // That is NOT `rig.axis` — that's the axis the chain BENDS about.
  //
  // `rig.springChains` adds FURTHER independent chains that get a spring but
  // no procedural drive. One wagChain describes a fish — a spine, tip to
  // tail. It cannot describe a crab, which is a body with eight limbs coming
  // off it; there is no single root-to-tip ordering that covers them, and the
  // solver's whole method (each bone measuring its target after its parent
  // has moved) assumes one. So limbed creatures list each limb separately and
  // get one solver each, all shoved together by impulse().
  const springs = [];
  // makeSpring returns null for a chain too short to solve (under two bones).
  // Dropping those here rather than storing them keeps every later
  // `for (const s of springs)` from having to null-check.
  const addSpring = (bones) => {
    const s = makeSpring(bones);
    if (s) springs.push(s);
  };
  if (wagBones.length) addSpring(wagBones);
  for (const chain of rig?.springChains ?? []) {
    const bones = chain.map((name) => instance.getObjectByName(name)).filter(Boolean);
    if (bones.length) addSpring(bones);
  }
  if (rig?.springChains?.length && springs.length === 0) {
    console.warn('[animation] rig.springChains named no bones that exist on this model — it will not react to impacts.');
  }

  const warnedMissing = new Set();
  let current = null; // the action currently faded in
  let currentState = null;
  let locomotionState = 'idle';
  let oneShot = null; // { state, timeLeft, priority }
  let hitTimer = 0;
  let clock = 0;
  // -1 plays locomotion backwards. This is how a creature whose gait only
  // exists in ONE direction travels the other way: a walk cycle run in
  // reverse is the same gait mirrored in time, so the legs push the opposite
  // way. Used by the crabs, whose sideways walk can't simply be turned around
  // — see the faceCamera notes in entities/enemies.js. One-shots are never
  // reversed; a death or an attack played backwards is nonsense.
  let playbackDir = 1;
  // >0 stretches locomotion so exactly one loop of the clip spans this many
  // musical beats, whatever the clip was authored at. 0 = defer to the state's
  // own configured figure (see beatsFor). The caller re-sets this as the
  // creature speeds up and slows down; see the beatSync block in
  // entities/enemies.js, which quantises it to musical subdivisions so a
  // faster gait still starts each cycle on a beat.
  let beatSyncBeats = 0;
  // Position within the current procedural wag cycle, 0..1. Only used by the
  // sine fallback, and only while that state is beat-synced — see
  // proceduralDrive, which advances it as a PHASE rather than multiplying the
  // clock, so a tempo change bends the wag from where it is instead of
  // teleporting it mid-swing.
  let beatCycle = 0;

  // How many beats one loop of `state` should span. The caller's explicit
  // setBeatSync wins — the crabs re-derive theirs from their own speed every
  // frame — and otherwise the state's configured figure applies, which is how
  // idle animations ride the tempo without anyone driving them. One-shots are
  // never synced: a death or a bite is a performance, not a loop.
  function beatsFor(state) {
    if (ONESHOT_STATES.includes(state)) return 0;
    if (beatSyncBeats > 0) return beatSyncBeats;
    const beats = CONFIG.animation.states[state]?.beatsPerLoop ?? 0;
    return Number.isFinite(beats) && beats > 0 ? beats : 0;
  }

  // Start a beat-synced loop WHERE THE MUSIC IS rather than at frame 0.
  //
  // Stretching the clip to a whole number of beats gets its tempo right, but a
  // cycle that begins the instant the seal stopped moving still peaks between
  // beats — right length, visibly not in time, which reads as no sync at all.
  // Offsetting once on entry puts the loop in phase, and it stays there for as
  // long as the tempo holds, since the stretch keeps every cycle a whole
  // number of beats long. The crossfade into the state covers the jump.
  //
  // `action` null means the procedural fallback is driving this state, which
  // carries its own phase instead of a clip time.
  function alignToBeat(state, action) {
    const beats = beatsFor(state);
    if (beats <= 0) return;
    const cycles = beatPhase() / beats;
    const frac = cycles - Math.floor(cycles);
    if (!action) { beatCycle = frac; return; }
    const clipLen = stateClipDuration[state] ?? 0;
    if (clipLen > 0) action.time = frac * clipLen;
  }

  function fadeDuration(state) {
    return CONFIG.animation.states[state]?.fade ?? CONFIG.animation.crossfade ?? 0.2;
  }

  // `restart` re-fires a state that's ALREADY showing. Without it, re-
  // triggering a one-shot mid-play hits the dedupe below and returns without
  // touching the action — so the caller's fresh timeLeft holds locomotion
  // hostage while the underlying LoopOnce action runs to its end and disables
  // itself, freezing the model. See trigger().
  function switchTo(state, restart = false) {
    if (state === currentState && !restart) return;
    const action = stateAction[state];
    const prev = current;
    if (action) {
      const fade = fadeDuration(state);
      if (prev === action) {
        // Same action already in front: restart it in place. Crossfading an
        // action with itself would fade it out and back in simultaneously.
        action.reset().setEffectiveWeight(1).play();
      } else {
        action.reset().setEffectiveWeight(1).fadeIn(fade).play();
        if (prev) prev.fadeOut(fade);
      }
      // After reset(), which zeroes the clip time this is offsetting.
      alignToBeat(state, action);
      current = action;
    }
    currentState = state;
  }

  // The pose is rebuilt from the REST pose every frame, never accumulated onto
  // whatever is currently in the bone. Two reasons, both of which were real
  // bugs:
  //
  //   - `rotation[axis] = value` overwrites one Euler component and leaves the
  //     other two alone. A bone whose rest pose isn't identity on that axis
  //     (shark.glb's caudal bones sit ~34 degrees up) had its rest angle
  //     silently flattened the first time the wag ran.
  //   - The spring downstream writes a full quaternion. Without restoring the
  //     rest first, the next frame's "target" is last frame's spring OUTPUT,
  //     so the spring chases itself: an impulse drove the body to a new shape
  //     and stayed there forever instead of settling back.
  //
  // Restoring first makes this a pure function of the clock, exactly like a
  // mixer clip, which is what the spring needs to have something to pull back
  // toward.
  function proceduralDrive(dt, state, hitPulse, beats) {
    const cfg = CONFIG.animation.states[state] ?? CONFIG.animation.states.idle;
    const phase = CONFIG.animation.chainPhase;
    const n = wagBones.length;
    // A beat-synced state takes its tempo from the music instead of from
    // `wagSpeed`: one full sine cycle spans `beats` beats, which is the same
    // deal a clip gets from the timeScale stretch below. Advanced by dt over
    // the CURRENT beat length, so the wag simply follows the tempo when the
    // death dive drags it down rather than jumping.
    if (beats > 0) {
      beatCycle += dt / Math.max(0.001, beats * beatDuration());
      beatCycle -= Math.floor(beatCycle);
    }
    const wagPhase = beats > 0 ? beatCycle * Math.PI * 2 : clock * cfg.wagSpeed;
    for (let i = 0; i < n; i++) {
      const ramp = n > 1 ? i / (n - 1) : 1;
      const wave = Math.sin(wagPhase - i * phase);
      wagBones[i].quaternion.copy(wagRest[i]);
      wagBones[i].rotation[axis] += wave * cfg.wagAmplitude * ramp + hitPulse * (1 - ramp);
    }
    for (let i = 0; i < headBones.length; i++) {
      const wave = Math.sin(wagPhase * 0.5 + Math.PI / 2);
      headBones[i].quaternion.copy(headRest[i]);
      headBones[i].rotation[axis] += -wave * cfg.headBob - hitPulse * 0.6;
    }
  }

  // Writes this frame's pose and nothing else. Split out from update()
  // because every one of its exits needs to hand off to the spring below,
  // and three separate `return`s made that easy to forget.
  function writePose(dt, state, hitThisFrame) {
    clock += dt;
    if (hitThisFrame) hitTimer = CONFIG.animation.hit.duration;
    if (hitTimer > 0) hitTimer = Math.max(0, hitTimer - dt);
    const hitPulse = hitTimer > 0
      ? CONFIG.animation.hit.amplitude * (hitTimer / CONFIG.animation.hit.duration)
      : 0;

    if (state) locomotionState = state;

    // A running one-shot owns the pose until it expires; 'death' never
    // expires, since there's nothing sensible to hand back to.
    let activeState = locomotionState;
    if (oneShot) {
      oneShot.timeLeft -= dt;
      // Belt-and-braces: hand back as soon as the clip is actually done,
      // not only when the timer says so. A LoopOnce action that has
      // finished stops contributing a pose, so continuing to treat it as
      // the active state would hold the model frozen on its last frame.
      // 'death' is the deliberate exception — it clamps and stays.
      const act = stateAction[oneShot.state];
      const finished = act != null && !act.isRunning();
      if (oneShot.state !== 'death' && (oneShot.timeLeft <= 0 || finished)) oneShot = null;
      else activeState = oneShot.state;
    }

    const action = stateAction[activeState];
    if (action) {
      switchTo(activeState);
      const shared = (usersOf.get(action)?.length ?? 1) > 1;
      let base = shared ? (CONFIG.animation.states[activeState]?.clipTimeScale ?? 1) : 1;
      // Only locomotion reverses or beat-syncs. A one-shot is a performance
      // with a beginning and an end — running a death or a bite backwards, or
      // rubber-banding it to the tempo, reads as a glitch rather than as
      // direction or rhythm.
      const oneShotNow = ONESHOT_STATES.includes(activeState);
      const beats = beatsFor(activeState); // 0 for one-shots, so they never stretch
      if (beats > 0) {
        // Stretch the clip so one full loop lasts exactly `beats` beats. This
        // REPLACES clipTimeScale rather than multiplying it: the whole point
        // is that the tempo now comes from the music, so folding in a second
        // speed multiplier would put it back off the grid. Re-derived every
        // frame, so a tuner BPM change (or the death dive dragging the tape
        // down) retimes the loop as it happens.
        const clipLen = stateClipDuration[activeState] ?? 0;
        const target = beats * beatDuration();
        if (clipLen > 0 && target > 0) base = clipLen / target;
      }
      action.timeScale = oneShotNow ? base : base * playbackDir;
      mixer.update(dt);
      // Additive flinch on top of the clip: nudge the head after the mixer
      // has already written this frame's pose, rather than replacing it.
      if (hitPulse > 0) {
        for (const b of headBones) b.rotation[axis] += hitPulse;
      }
      return;
    }

    // No clip for this state — fall back to the procedural rig if there is
    // one, using the nearest locomotion config so a missing 'strike' still
    // reads as fast movement rather than freezing.
    if (wagBones.length) {
      const proceduralState = CONFIG.animation.states[activeState] ? activeState : locomotionState;
      // Entering the state, which is where a clip would be phase-aligned by
      // switchTo — the fallback never gets there, since it has no action to
      // switch to.
      if (activeState !== currentState) alignToBeat(proceduralState, null);
      currentState = activeState;
      proceduralDrive(dt, proceduralState, hitPulse, beatsFor(proceduralState));
      return;
    }

    // Still advance the mixer even with no action for THIS state, so a
    // previous action's fade-out finishes instead of freezing half-blended.
    if (mixer) mixer.update(dt);

    if (!warnedMissing.has(activeState)) {
      warnedMissing.add(activeState);
      console.warn(`[animation] state "${activeState}" has no clip and no rig fallback — this model will hold still for it.`);
    }
  }

  return {
    // Fire a one-shot. Silently ignored if this model has no clip for it, so
    // callers never have to check what a given creature supports.
    trigger(state) {
      const action = stateAction[state];
      if (!action) return false;
      // Per-one-shot enable toggle (CONFIG.animation.oneShots).
      if (CONFIG.animation.oneShots?.[state] === false) return false;
      const priority = CONFIG.animation.oneShotPriority?.[state] ?? 0;
      if (oneShot && (CONFIG.animation.oneShotPriority?.[oneShot.state] ?? 0) > priority) return false;

      const cfg = CONFIG.animation.states[state] ?? {};
      const speed = cfg.clipTimeScale ?? 1;
      const full = (stateClipDuration[state] ?? 0.4) / Math.max(0.01, speed);
      // Cap how long this one-shot may hold locomotion. These source clips
      // are multi-second performances; without a cap the seal is locked out
      // of swimming for the whole thing, which looks like it's stuck.
      const timeLeft = cfg.maxDuration == null ? full : Math.min(full, cfg.maxDuration);
      oneShot = { state, timeLeft, priority };
      // Restart the clip only when it is NOT already mid-play. Contact damage
      // re-fires this every frame (invulnAfterHit can be 0), and resetting an
      // action every frame pins it to frame 0 — a freeze, just a different
      // one. Already running: let it continue and only the timer refreshes.
      // Finished: restart it, since a finished LoopOnce action contributes no
      // pose at all.
      switchTo(state, !action.isRunning());
      return true;
    },

    isPlayingOneShot() {
      return oneShot != null;
    },

    // Lock one loop of locomotion to `beats` musical beats. 0 disables and
    // hands tempo back to the clip's own authored speed. See beatSyncBeats.
    setBeatSync(beats) {
      beatSyncBeats = Number.isFinite(beats) && beats > 0 ? beats : 0;
    },

    // Which way locomotion runs: 1 forward, -1 reversed. See playbackDir.
    // A reversed LoopRepeat action wraps around the start correctly, so this
    // is safe to flip mid-cycle — the legs just change which way they push.
    setPlaybackDirection(dir) {
      playbackDir = dir < 0 ? -1 : 1;
    },

    // Drop any one-shot and return to clean idle locomotion.
    //
    // 'death' deliberately never expires on its own — there's nothing
    // sensible to hand back to mid-run — which means it also survives a
    // RESTART unless something clears it. Without this, dying once left the
    // controller pinned to the death pose (clampWhenFinished holds the last
    // frame), so the next run's seal never animated again. Same for any
    // one-shot still in flight when a run ends.
    reset() {
      oneShot = null;
      hitTimer = 0;
      locomotionState = 'idle';
      playbackDir = 1;
      beatSyncBeats = 0;
      beatCycle = 0;
      // Stop every action outright rather than crossfading: fading from a
      // clamped death pose leaves it bleeding into the first moments of the
      // new run.
      for (const action of Object.values(stateAction)) action.stop();
      current = null;
      currentState = null;
      const idle = stateAction.idle;
      if (idle) {
        idle.reset().setEffectiveWeight(1).play();
        // Started outside switchTo, so it needs the phase offset applied by
        // hand — a run that begins mid-bar should still open in time.
        alignToBeat('idle', idle);
        current = idle;
        currentState = 'idle';
      }
    },

    update(dt, state, hitThisFrame) {
      writePose(dt, state, hitThisFrame);
      // The spring layers over WHATEVER wrote the pose — a clip, the sine
      // fallback, or nothing at all — so an impulse lands the same way no
      // matter how (or whether) the creature is animated.
      const cfg = CONFIG.animation.spring;
      if (cfg.enabled) for (const s of springs) s.update(dt, cfg, cfg.weight);
    },

    // Shove the skeleton. This is the hit reaction for a creature with no
    // authored flinch: the same springs that produce its swim lag absorb the
    // kick and carry it out along the body. A no-op on a model with no rig
    // chain, so callers never have to check.
    //
    // Every chain gets the same shove, which is what makes a crab read as
    // knocked rather than as one limb twitching — and because each spring's
    // target is still whatever the walk cycle wrote this frame, they all
    // converge back into the loop as the energy bleeds off. Nothing has to
    // switch the animation back on.
    impulse(dirWorld, strength) {
      const cfg = CONFIG.animation.spring;
      if (!cfg.enabled) return;
      for (const s of springs) s.impulse(dirWorld, strength, cfg.impulseTipBias);
    },

    resetSpring() {
      for (const s of springs) s.reset();
    },

    // Whether a shove would actually do anything — false for a model whose
    // rig named no bones that exist, so callers can skip the work.
    hasSpring: springs.length > 0,

    hasRealClips: !!mixer,
    availableStates: Object.keys(stateAction),
    clipCoverage: Object.fromEntries(
      [...LOCOMOTION_STATES, ...ONESHOT_STATES].map((s) => [s, !!stateAction[s]])
    ),
    singleClipReuse,
  };
}

// Speed thresholds -> locomotion state. `aboveSurface` picks the land/surface
// variants, so a seal that breaches uses its out-of-water clips instead of
// swimming through the air.
export function stateForSpeed(speed, aboveSurface = false) {
  if (aboveSurface) {
    return speed >= CONFIG.animation.moveThreshold ? 'surfaceMove' : 'surfaceIdle';
  }
  if (speed >= CONFIG.animation.boostThreshold) return 'boost';
  if (speed >= CONFIG.animation.moveThreshold) return 'swim';
  return 'idle';
}
