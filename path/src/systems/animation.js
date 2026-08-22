import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { beatDuration, beatPhase } from './music.js';
import { createBoneSpring } from './boneSpring.js';
import { axisVec } from './ikChain.js';

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
//
// `boneAxis` is the direction a bone's own length runs in ITS OWN local space,
// which is what the tip fallback needs and is a property of the exporter that
// made the file. Almost every rig here runs along +Y and that is the default,
// but it is not a law: hammerhead.glb runs along local +X (measured — each
// child bone's bind offset from its parent is (1,0,0) to three decimals), and
// feeding it +Y would hand the last bone of every chain a tip direction square
// to the bone it belongs to. The spring still runs, it just lags about an axis
// the fin does not have — the kind of wrong that looks like bad tuning.
//
// Only chains ending on a LEAF are affected. A last bone with a child reads its
// direction from that child and never consults this.
function makeSpring(bones, boneAxis) {
  const last = bones[bones.length - 1];
  const tipLength = last.children.some((c) => c.isBone) ? 0 : last.position.length();
  return createBoneSpring(bones, { tipAxis: boneAxis, tipLength });
}

// One spring config per ROLE, derived from the single shared CONFIG.animation
// .spring block — see the roleLooseness note there for what the scaling means
// and why damping moves with the square root.
//
// Rebuilt only when the inputs actually change. This is read once per chain
// per creature per frame, so allocating a fresh object each time would put a
// few thousand short-lived objects a second on the heap for values that are
// identical between frames — and identical between CREATURES, since the config
// is global. A module-level cache means the whole roster shares one object per
// role, rebuilt on the frame a tuner slider moves and not otherwise.
const roleCfgCache = new Map();
let roleCfgSource = null;
function springCfgFor(cfg, role) {
  const looseness = cfg.roleLooseness?.[role];
  // Absent role, or a role that is already 1.0: hand back the config itself
  // rather than a copy of it. `tail` takes this path always.
  if (!(looseness > 0) || looseness === 1) return cfg;
  // Any edit to the spring block invalidates every derived config. Comparing
  // the object identity is not enough — the tuner mutates CONFIG in place — so
  // this keys on the three values the scaling actually reads.
  const stamp = `${cfg.stiffness}|${cfg.damping}|${cfg.maxLag}`;
  if (roleCfgSource !== stamp) {
    roleCfgCache.clear();
    roleCfgSource = stamp;
  }
  let derived = roleCfgCache.get(role);
  if (!derived || derived.__looseness !== looseness) {
    derived = {
      ...cfg,
      stiffness: cfg.stiffness / looseness,
      damping: cfg.damping / Math.sqrt(looseness),
      maxLag: cfg.maxLag * looseness,
      __looseness: looseness,
    };
    roleCfgCache.set(role, derived);
  }
  return derived;
}

// `rig.springChains` entries come in two forms: a bare array of bone names
// (role defaults to 'tail', which is unscaled, so every chain written before
// roles existed keeps behaving exactly as it did), or { bones, role }.
//
// `asleep: true` declares a chain that exists but does not run: it is muted the
// moment it is built and stays muted through every reset, so it neither solves
// nor stores an impulse until something explicitly wakes it. setLimp() is the
// one thing that does — a body cut loose has nobody posing it, and every chain
// on it is rope.
//
// It is declared on the RIG rather than muted by the caller because the callers
// are the problem: the seal's ragdoll chains have to be dormant in the game, in
// the tuner, on the title card, in the look pages and in every harness that
// builds a controller by hand, and a mute that each of those has to remember is
// a mute that reaches about half of them. See ASSETS.ship.rig.springChains.
function chainSpec(entry) {
  if (Array.isArray(entry)) return { names: entry, role: 'tail', asleep: false };
  return { names: entry?.bones ?? [], role: entry?.role ?? 'tail', asleep: entry?.asleep === true };
}


export const LOCOMOTION_STATES = ['idle', 'swim', 'boost', 'surfaceIdle', 'surfaceMove'];
// 'bite' is separate from 'strike' on purpose. 'strike' is the seal's dash;
// 'bite' is a predator snapping its jaws at what it's chasing, and the two want
// opposite handling — a dash is capped short so it can't lock the seal out of
// swimming, while a bite is a whole performance (megalodon's is 1.3s) that
// should play out. Sharing one state would have meant one maxDuration for both.
// Only megalodon.glb ships a clip for this; everything else bites through the
// procedural jaw in systems/jaw.js instead.
// 'celebrate' is the boss-kill victory lap. Only the Seal Team escorts have a
// clip for it (sealhelper.glb's `clapping`) — the PLAYER's celebration is posed
// procedurally instead, because the two seals are not the same skeleton and the
// clip cannot be moved between them. See systems/celebrate.js, which owns the
// whole performance and explains why.
export const ONESHOT_STATES = ['strike', 'bite', 'hit', 'bark', 'celebrate', 'death'];

// THE TWO ATTACKS, and the reason they are a list rather than a pair of
// priority numbers: an attack always beats a flinch, and that is a rule about
// what the game is rather than a taste setting. `oneShotPriority` had 'hit'
// (3) above both of them, so a creature taking fire refused to swing for as
// long as the flinch was playing — and a boss under a stream of pellets is
// re-flinching every few frames, which is "it reacts to every hit and never
// attacks", exactly as it looks. The numbers still order everything else
// (death outranks all of it; a bark loses to both), and they are ALSO a saved
// tuning value, so correcting them in config.js alone would have changed
// nothing on a machine with a snapshot on disk. Hence the rule in code.
const ATTACK_STATES = ['strike', 'bite'];

/**
 * WHICH BONES THE MIXER WILL ACTUALLY PUT BACK.
 *
 * The question any system that poses bones over a clip has to answer before it
 * can hand them back, and it is not the obvious one. three.js's PropertyMixer
 * skips its write whenever the value it computes matches the one it last wrote
 * — a sound optimisation that assumes nothing else touched the bone. Overwrite
 * one and that cache is stale, so the clip may never take it back.
 *
 * Which makes a SINGLE-KEYFRAME track a trap. It is a constant: written once,
 * then skipped forever, so it is exactly as unrecoverable as a bone with no
 * track at all — while looking perfectly well animated to any check that only
 * asks whether a track exists. On furseal.glb the `swim` clip leaves five bones
 * unkeyed AND pins four more (uparm_R_016, arm_R_017, hand_R_018, neck01_05)
 * with one keyframe each, against 31 for head_07. The flipper that looked safe
 * was the one that stuck 74 degrees out of place.
 *
 * A bone is owned only if EVERY locomotion clip this model has drives it with
 * more than one keyframe — anything less and some state leaves it stranded.
 *
 * @returns Map of bone name -> { owned, keys: { state: keyframeCount } }.
 *   Empty for a model with no clips, which correctly reports nothing as owned.
 */
export function trackCoverage(instance) {
  const clips = instance?.userData?.clips ?? [];
  const names = instance?.userData?.animationNames ?? {};
  const out = new Map();

  const locomotion = LOCOMOTION_STATES
    .map((state) => ({ state, clip: names[state] && clips.find((c) => c.name === names[state]) }))
    .filter((e) => e.clip);

  const bones = [];
  instance?.traverse?.((o) => { if (o.isBone) bones.push(o); });

  for (const bone of bones) {
    const keys = {};
    for (const { state, clip } of locomotion) {
      // Track names are `<boneName>.<property>`; one bone can carry several
      // (rotation, position, scale) and the most-keyed of them is what decides
      // whether the mixer keeps writing.
      let most = 0;
      for (const t of clip.tracks) {
        if (t.name.startsWith(`${bone.name}.`)) most = Math.max(most, t.times.length);
      }
      keys[state] = most;
    }
    const owned = locomotion.length > 0 && locomotion.every(({ state }) => keys[state] > 1);
    out.set(bone.name, { owned, keys });
  }
  return out;
}

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
  //
  // `rig.boneAxis` is the direction a bone's length runs in its own local
  // space, defaulting to the +Y that nearly every file here uses — see
  // makeSpring for what it feeds and which bones care. That is NOT `rig.axis`,
  // which is the axis the chain BENDS about; the two are different questions
  // and on this project's rigs they are usually different answers.
  //
  // `rig.springChains` adds FURTHER independent chains that get a spring but
  // no procedural drive. One wagChain describes a fish — a spine, tip to
  // tail. It cannot describe a crab, which is a body with eight limbs coming
  // off it; there is no single root-to-tip ordering that covers them, and the
  // solver's whole method (each bone measuring its target after its parent
  // has moved) assumes one. So limbed creatures list each limb separately and
  // get one solver each, all shoved together by impulse().
  //
  // Each entry is stored as { solver, role } — the role picks which scaled
  // copy of the spring config this chain solves with, so a fin can be stiffer
  // than the tail it hangs behind. See springCfgFor.
  const springs = [];
  // makeSpring returns null for a chain too short to solve (under two bones).
  // Dropping those here rather than storing them keeps every later walk over
  // `springs` from having to null-check.
  const boneAxis = axisVec(rig?.boneAxis ?? '+Y');
  const addSpring = (bones, role) => {
    const solver = makeSpring(bones, boneAxis);
    if (solver) springs.push({ solver, role });
  };
  // The wag chain is the body's own undulation, so it is a tail by default
  // whatever the creature is.
  //
  // `rig.wagRole` overrides that for creatures whose body is not a fish's.
  // `tail` is the unscaled baseline every wag chain in the game shares, so it
  // cannot be retuned for one animal without retuning all of them — and a
  // 31-unit whale wants a far looser body than a 0.4-unit fish. Declaring a
  // role is how one creature gets its own without touching the rest of the
  // roster. See CONFIG.animation.spring.roleLooseness.
  if (wagBones.length) addSpring(wagBones, rig?.wagRole ?? 'tail');
  // Roles declared `asleep` — see chainSpec. Collected as the chains are built
  // so a role that resolved to no bones at all never enters the set.
  const asleepRoles = new Set();
  for (const entry of rig?.springChains ?? []) {
    const { names, role, asleep } = chainSpec(entry);
    const bones = names.map((name) => instance.getObjectByName(name)).filter(Boolean);
    if (bones.length) {
      addSpring(bones, role);
      if (asleep) asleepRoles.add(role);
    }
  }
  if (rig?.springChains?.length && springs.length === 0) {
    console.warn('[animation] rig.springChains named no bones that exist on this model — it will not react to impacts.');
  }

  // THE SPRING NEEDS SOMETHING TO PULL BACK TOWARD, and on a spring-only chain
  // nothing supplies it.
  //
  // Read the solver and this falls out: each bone's target is the direction it
  // is ALREADY pointing when update() runs, so once the spring has caught up,
  // whatever pose it happens to be sitting in is a fixed point. It converges to
  // "stop changing", not to "go back". A pose driver is what makes that a
  // restoring force — proceduralDrive rebuilds the wag chain from `wagRest`
  // every frame for exactly this reason, and the mixer does the same for any
  // bone its clip keys.
  //
  // A `springChains` bone that neither one touches has no such driver, so an
  // impulse bends it and it stays bent. Measured, not theorised: shove the
  // megalodon's lower caudal lobe and five seconds later it is still further
  // from where it started than the shove itself moved it. Every fin on
  // shark.glb would ratchet the same way — that file ships no clips at all —
  // and so would the crab limbs, whose clips key the body but not every leg.
  //
  // So the rest pose of every sprung bone is captured here, before anything has
  // written to the skeleton, and restored at the top of each frame. A bone the
  // clip does key is then immediately overwritten by the mixer, which is why
  // this needs no notion of who owns what — with ONE exception, below.
  const springBones = [...new Set(springs.flatMap(({ solver }) => solver.bones))];
  const springRest = springBones.map((b) => b.quaternion.clone());

  // THE EXCEPTION IS A MUTED CHAIN, and it is not a nicety.
  //
  // The restore above exists to stop an impulse ratcheting a bone nothing else
  // drives. A muted chain cannot take an impulse and does not solve, so there is
  // nothing to ratchet — and restoring its bones anyway is not free: it hands
  // the bind pose to every OTHER system that writes them. The seal's aim rig is
  // the case. Its flipper tip (`hand_L_014`) is keyed by the idle clips and NOT
  // by the swim clip, so before the ragdoll chains existed the IK carried on
  // from where it left that bone last frame; restoring it re-based the solve on
  // the bind pose every frame, which measurably changed how the flippers aim on
  // a LIVING seal. A dormant chain has to be worth exactly nothing.
  //
  // So the restore runs over the bones of AWAKE chains only, and the list is
  // rebuilt whenever the mute set moves rather than filtered per frame — this
  // is a hot path with hundreds of creatures in it, and mutes change a few
  // times a run.
  //
  // Which roles could bend each bone, worked out ONCE here rather than on every
  // rebuild: the crabs mute and unmute a claw on every pinch, and walking ten
  // chains' bone lists per toggle per crab is the kind of cost that only shows
  // up in a fight.
  const boneRoles = springBones.map(
    (bone) => [...new Set(springs.filter(({ solver }) => solver.bones.includes(bone)).map(({ role }) => role))],
  );
  let restBones = [];
  let restPose = [];
  function refreshRest() {
    restBones = [];
    restPose = [];
    for (let i = 0; i < springBones.length; i++) {
      if (!boneRoles[i].some((role) => !mutedRoles.has(role))) continue;
      restBones.push(springBones[i]);
      restPose.push(springRest[i]);
    }
  }

  // LIMP. Null while the creature is alive; a { pose, cfg } record once
  // something has cut the skeleton loose — see systems/bossRagdoll.js, which is
  // the only caller.
  //
  // `pose` is the quaternions the sprung bones held at the moment it was set,
  // and it takes the place of BOTH drivers: the mixer is not advanced at all,
  // and `springRest` is not restored. That is what the mode is. The spring
  // needs something to pull back toward or an impulse ratchets it (see the
  // springRest note above), and for a corpse the only honest target is the pose
  // it died in — not the bind pose, which is a shape the animal was never in.
  let limp = null;

  // SPRING CHAINS SOMETHING ELSE HAS TAKEN OVER, by role. See muteSpring — and
  // it opens holding every `asleep` role, which is the state anything that
  // clears it has to come back to rather than to empty.
  const mutedRoles = new Set(asleepRoles);
  const restoreMutes = () => {
    mutedRoles.clear();
    for (const role of asleepRoles) mutedRoles.add(role);
    refreshRest();
  };
  refreshRest();

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
      // THE ATTACK/FLINCH CONTEST, BOTH WAYS ROUND — see ATTACK_STATES. An
      // attack may always interrupt a playing flinch, and a flinch may never
      // interrupt a playing attack. One direction alone fixes nothing: let the
      // swing start and then hand the pose straight back to the next pellet,
      // and the animal is still reacting rather than attacking, just half a
      // frame later. Nothing else is affected — a death still owns the body,
      // and a re-fired attack is handled by the timer refresh below.
      const attacking = oneShot != null && ATTACK_STATES.includes(oneShot.state);
      if (oneShot && state === 'hit' && attacking) return false;
      const overFlinch = oneShot?.state === 'hit' && ATTACK_STATES.includes(state);
      if (oneShot && !overFlinch
        && (CONFIG.animation.oneShotPriority?.[oneShot.state] ?? 0) > priority) return false;

      const cfg = CONFIG.animation.states[state] ?? {};
      const speed = cfg.clipTimeScale ?? 1;
      // WHERE IN THE CLIP TO OPEN. Almost every one-shot here wants frame 0,
      // but an authored performance does not have to keep its point at the
      // front: sealhelper.glb's `clapping` is 3.47s long and the flippers do
      // not actually MEET until 1.66s (measured through the real mixer —
      // tools/celebrate-test.mjs
      // asserts it). Started at zero and capped like the other one-shots, the
      // escorts would play a second of wind-up and hand back before the clap
      // ever happened, which looks like the animation is broken rather than
      // like a seal deciding not to clap.
      const startAt = Math.max(0, Math.min(cfg.startAt ?? 0, (stateClipDuration[state] ?? 0) - 0.01));
      const remaining = Math.max(0.05, (stateClipDuration[state] ?? 0.4) - startAt);
      const full = remaining / Math.max(0.01, speed);
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
      const restarted = !action.isRunning();
      switchTo(state, restarted);
      // After switchTo, which calls reset() and zeroes the time this is
      // setting. Only on a restart: a one-shot already mid-play is deliberately
      // left where it is (see above), and yanking it back to the offset every
      // frame would pin it there exactly the way reset() used to.
      if (restarted && startAt > 0) action.time = startAt;
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
      // AND THE RAGDOLL, WHICH OUTLIVES THE CREATURE OTHERWISE. This controller
      // is cached on the visual and handed to whoever recycles that body (see
      // `__rigs` in entities/enemies.js), so a boss that died limp would hand
      // its successor a skeleton that ignores the mixer entirely. The pooled
      // visual's transforms are restored by resetVisual; the SOLVER's velocity
      // is not, and a mackerel spawning with a megalodon's death whip still in
      // its springs is the same leak wearing a smaller body.
      limp = null;
      restoreMutes();
      for (const { solver } of springs) solver.reset();
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
      // CUT LOOSE. No mixer, no sine, no rest pose — the pose it died in is
      // restored instead and the springs are all that move it. `state` and
      // `hitThisFrame` are ignored rather than rejected, so the caller that was
      // already updating this creature (systems/bossCorpse.js) does not have to
      // learn a second call. See `limp`.
      if (limp) {
        for (let i = 0; i < springBones.length; i++) springBones[i].quaternion.copy(limp.pose[i]);
        const live = CONFIG.animation.spring;
        if (live.enabled) {
          for (const { solver } of springs) solver.update(dt, limp.cfg, live.weight);
        }
        return;
      }
      // Before the pose driver, not after: whatever writes this frame's pose —
      // mixer or sine — is meant to win over the rest pose wherever it has an
      // opinion. See springRest, and the note there on why this is the AWAKE
      // chains' bones rather than every sprung bone.
      for (let i = 0; i < restBones.length; i++) restBones[i].quaternion.copy(restPose[i]);
      writePose(dt, state, hitThisFrame);
      // The spring layers over WHATEVER wrote the pose — a clip, the sine
      // fallback, or nothing at all — so an impulse lands the same way no
      // matter how (or whether) the creature is animated.
      const cfg = CONFIG.animation.spring;
      if (cfg.enabled) {
        for (const { solver, role } of springs) {
          if (mutedRoles.has(role)) continue; // posed by hand this frame — see muteSpring
          solver.update(dt, springCfgFor(cfg, role), cfg.weight);
        }
      }
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
    // A stiffer chain absorbs the same shove into a smaller swing on its own,
    // through its own spring constant, so the impulse is NOT role-scaled here.
    // Scaling it as well would apply the same stiffening twice.
    //
    // `tipBias` overrides the configured one for this shove only. A corpse
    // buckles through its middle where a live hit flicks the tail, and the two
    // are the same solver being asked for different shapes — see
    // CONFIG.boss.ragdoll.tipBias.
    impulse(dirWorld, strength, tipBias) {
      const cfg = CONFIG.animation.spring;
      if (!cfg.enabled) return;
      const bias = tipBias ?? cfg.impulseTipBias;
      for (const { solver, role } of springs) {
        // A MUTED CHAIN DOES NOT FLINCH. This is the impulse half of the same
        // rule update() applies: a limb that is mid-attack is being posed
        // deliberately, and a shove it absorbs now would still be bleeding out
        // of it when the attack lands. See muteSpring.
        if (mutedRoles.has(role)) continue;
        solver.impulse(dirWorld, strength, bias);
      }
    },

    /**
     * HAND A SPRING CHAIN OVER TO WHOEVER IS POSING IT — or take it back.
     *
     * THE ATTACK BEATS THE HIT REACTION, for a creature that has no authored
     * flinch to out-prioritise. A model with clips resolves that contest in
     * trigger(), where an attack one-shot interrupts a playing 'hit'. Most of
     * the roster has no such clip: their flinch IS the spring, and a limb that
     * is being aimed by an IK solver has no way to say so. So the solver says
     * it here.
     *
     * Muting does two things, and both are needed. The chain stops solving, so
     * the pose the attack writes is the pose that ships; and it stops taking
     * impulses, so a shove landing mid-swing is not stored up to be released
     * the moment the limb is handed back. The velocity already in it is
     * dropped on the way in for the same reason — an arm that finishes its
     * pinch and then whips is the flinch arriving late rather than not at all.
     *
     * Coming back out costs nothing: the solver's target is whatever pose it
     * finds, so it resumes from where the attack left the limb instead of
     * snapping to where it would have been.
     *
     * @param role  the `role` on the rig's springChains entry ('claw' on the
     *              crabs). A role no chain wears is a silent no-op.
     * @param muted true while something else owns the chain.
     */
    muteSpring(role, muted) {
      const already = mutedRoles.has(role);
      if (muted === already) return;
      if (muted) {
        mutedRoles.add(role);
        for (const { solver, role: r } of springs) if (r === role) solver.reset();
      } else {
        mutedRoles.delete(role);
      }
      refreshRest();
    },

    /**
     * CUT THE SKELETON LOOSE, or hand it back. See `limp`.
     *
     * @param springCfg the spring settings to solve every chain with while
     *        limp — role scaling deliberately does not apply, since a stiff fin
     *        is a fact about a fin with muscle in it. Null hands control back
     *        to the mixer.
     * @returns true if the model actually has springs to go limp WITH. False
     *          means this body cannot ragdoll and the caller should not pretend
     *          it did — bossBoat's trawler has no rig at all.
     */
    setLimp(springCfg) {
      // A BODY CUT LOOSE HAS NOBODY POSING IT. Whatever had claimed a chain —
      // a crab mid-pinch is the case — is not going to run again to hand it
      // back, and a corpse with one limb that will not swing reads as the
      // ragdoll having missed it. See muteSpring.
      // ...and this is the one thing that wakes an `asleep` chain, which is the
      // other half of the same rule: dormant until the body is let go of.
      mutedRoles.clear();
      refreshRest();
      if (!springCfg || !springs.length) {
        limp = null;
        // Handing the skeleton back puts the dormant chains back to sleep. A
        // corpse-then-reused body that came back with its ragdoll awake is the
        // same leak in a different direction.
        restoreMutes();
        return false;
      }
      limp = { pose: springBones.map((b) => b.quaternion.clone()), cfg: springCfg };
      // PRIMED BEFORE ANYTHING SHOVES IT. A spring that has never solved snaps
      // its state onto its target and DROPS WHATEVER VELOCITY IT IS HOLDING on
      // the first frame it does (see `primed` in systems/boneSpring.js) — and
      // that frame is the one right after this call, so the killing blow every
      // caller lands here would be thrown away. Harmless on a chain that has
      // been solving all along, and load-bearing for one that has not: an
      // `asleep` chain is never primed by definition, which is every chain in
      // the seal's ragdoll. A dt of nothing, because this is not a step — it is
      // the solver being shown where it starts.
      const live = CONFIG.animation.spring;
      for (const { solver } of springs) solver.update(1e-6, springCfg, live.weight);
      return true;
    },

    isLimp() {
      return limp != null;
    },

    resetSpring() {
      for (const { solver } of springs) solver.reset();
    },

    // Whether a shove would actually do anything — false for a model whose
    // rig named no bones that exist, so callers can skip the work.
    hasSpring: springs.length > 0,

    // How many chains actually resolved into solvers. Bone lookup silently
    // drops names that miss, so this is the only way to tell "four chains, all
    // solving" from "four declared, one survived" — see tools/apex-spring-test
    // .mjs, which asserts it against the model files.
    springCount: springs.length,

    /**
     * A snapshot of the machine RIGHT NOW, for ui/animDebug.js. Read-only and
     * allocated fresh, so a panel holding onto one can't reach in and move the
     * state it is describing.
     *
     * Everything here is otherwise invisible from outside: which locomotion
     * state the caller last passed, which one-shot is holding the pose and how
     * much of its budget is left, and whether the clip is running backwards or
     * stretched to the beat. All four are decisions this file makes silently
     * every frame, and "the seal is doing something I didn't ask for" has no
     * other way to be answered than by reading them.
     */
    debugState() {
      return {
        locomotion: locomotionState,
        showing: currentState,
        oneShot: oneShot
          ? { state: oneShot.state, timeLeft: oneShot.timeLeft, priority: oneShot.priority }
          : null,
        playbackDir,
        beatSyncBeats,
        // >0 while the flinch pulse is still bleeding off, which is additive on
        // top of whatever else is playing and so is not an `oneShot`.
        hitTimer,
        clipTime: current?.time ?? 0,
        clipLength: currentState ? (stateClipDuration[currentState] ?? 0) : 0,
      };
    },

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
export function stateForSpeed(speed, aboveSurface = false, surfaceRest = 0) {
  if (aboveSurface) {
    return speed >= CONFIG.animation.moveThreshold ? 'surfaceMove' : 'surfaceIdle';
  }
  // RESTING AT the surface, as opposed to flying above it. Without this,
  // `surfaceIdle` was reachable only at the apex of a dead-vertical jump — a
  // window of about 100ms, and of exactly ZERO once the seal had any sideways
  // drift, because there is no drag up there to bleed it off. See
  // CONFIG.surfaceRest for the measurements.
  //
  // Still gated on speed as well as on the caller's ramp: the ramp releases
  // over a sixth of a second, and a seal already swimming away during that
  // release should be swimming, not standing on the water.
  if (surfaceRest > 0.001 && speed < CONFIG.animation.moveThreshold) return 'surfaceIdle';
  if (speed >= CONFIG.animation.boostThreshold) return 'boost';
  if (speed >= CONFIG.animation.moveThreshold) return 'swim';
  return 'idle';
}
