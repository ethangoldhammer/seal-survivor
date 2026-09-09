import { CONFIG } from '../config.js';
import { ease } from '../ease.js';

// ---------------------------------------------------------------------------
// HOW A FISH COMES ABOUT — and the shimmy it does before it goes.
//
// This replaces the heading-plus-faceSide pair in entities/enemies.js for any
// creature whose def carries `comeAbout`. Both halves of what it does are
// about the same thing: a fast fish is only readable if you can see it decide.
//
// ---------------------------------------------------------------------------
// 1. THE TURN GOES THROUGH THE LENS, NOT OVER THE TOP.
// ---------------------------------------------------------------------------
// The shared path writes ONE angle — `mesh.rotation.z = atan2(vy, vx) - PI/2`
// — and then calls faceSide to roll the body upright again. Both end states
// are correct and the PATH between them is not, which is the whole bug: a fish
// reversing from +X to -X has its heading swing through PI/2, and PI/2 in the
// plane of the screen is NOSE STRAIGHT UP. Measured on the composed matrix at
// the halfway frame: forward (0, 1, 0), dorsal pointing at the camera. The
// animal loops vertically and barrel-rolls at the same time. It is quick
// enough on a sprat to get away with and it does not survive being 4.3 units
// of barracuda.
//
// systems/bossAngler.js already describes the right answer in its own comment
// — "a fish turning round in place swims a horizontal U-turn; on this camera
// that is a rotation through pointing-at-the-lens" — and then builds it out of
// the same two angles, which cannot express it. A yaw about world up is not
// reachable from `rotation.z` on the parent and `rotation.y` on the child: the
// child's +Y IS the model's forward axis (see orientationQuaternion — in the
// side view model forward goes to entity +Y, model up to entity -X), so that
// rotation is a barrel roll about the spine, and no amount of easing turns a
// roll into a yaw.
//
// So the decomposition is done where it can actually be written down — as an
// Euler on the MESH, in `YXZ` order, which three.js composes as Ry * Rx * Rz:
//
//   YAW    `rotation.y`, held in [-PI, 0]. 0 is facing +X, -PI is facing -X,
//          and every value between the two has a POSITIVE +Z component — so
//          every turn, in both directions, sweeps the nose through the camera.
//          That is the one interval where that is true; the mirror image
//          [0, PI] sweeps it through the back wall, which is the same
//          manoeuvre performed where nobody can see it.
//   PITCH  `rotation.z`, as `atan2(vy, |vx|) - PI/2`. Measured inside whichever
//          half-plane the fish is in, so it is bounded at +-90 degrees and can
//          never carry the body past vertical. The dorsal comes out exactly up
//          for every (yaw, pitch) pair in range — by construction, not by the
//          two clocks agreeing.
//   BANK   `rotation.y` on the VISUAL, which is that same roll about the spine,
//          used for what a roll is actually for. Driven by how fast the yaw
//          and the pitch are currently moving, so the body leans into its own
//          turn and comes level as it finishes.
//
// The end poses are IDENTICAL to the old ones, to within 1e-4 on both the
// forward and the dorsal vector, at every pitch — tools/fish-turn-test.mjs
// asserts that against the legacy composition directly. Nothing downstream
// sees a different animal parked; only the seconds in between changed.
//
// This is also why the yaw and the pitch do not have to share a clock, which
// the anglerfish's note is at pains about. There the two eased values were
// both feeding `rotation.z`, so one running ahead of the other put the fish on
// its back. Here they are separate axes of one Euler and neither can express
// the other's mistake.
//
// ---------------------------------------------------------------------------
// 2. THE WIND-UP IS A SHIMMY.
// ---------------------------------------------------------------------------
// lungeChase's `wind` stage already throttles the fish back and turns it onto
// the player, which is a tell you can read if you are looking straight at the
// animal and know what it means. A fish gathering itself does something much
// louder than that: it coils and shakes.
//
// So the wind-up adds an oscillation to the yaw, the pitch and the bank
// together, with the amplitude RAMPING over the stage rather than sitting flat
// — a shimmy that arrives is a countdown, a shimmy that is simply present is
// texture. On this camera the yaw component is the one that carries: the nose
// swings toward and away from the lens and the silhouette narrows and widens
// with it, which reads at a distance and at any size.
//
// It is deliberately NOT bone motion. barracuda.glb is 3 nodes, 0 joints and 0
// clips — a rigid board with no spine to wave — so anything living in the rig
// would exist for the sailfish and silently do nothing for the animal that
// needs it more. One whole-body oscillation is a shimmy on both.
//
// A PACK WINDING UP TOGETHER IS THE SWARM TELL, and that is `lunge.stagger`
// rather than anything here: see the note on it in config.js.
//
// ---------------------------------------------------------------------------
// 3. A FISH IN A BAIT BALL TURNS THROUGH ITS OWN ORBIT.
// ---------------------------------------------------------------------------
// The second way into this file, and the only one that is not a `comeAbout` on
// a def. A ball's fish were on the shared path — `mesh.rotation.z` for the
// heading and faceSide rolling the body upright — and that pair is the flip
// section 1 is about, happening fifteen times over in one knot of fish. On a
// column of sardines it does not read as a school changing direction, it reads
// as a handful of bodies rotating on their own spines, which is exactly what
// it is: `visual.rotation.y` is a roll about the model's forward axis.
//
// The fix is not merely to route them through the come-about above, because a
// bait ball is the one place in this game where THE DEPTH IS REAL. Every other
// creature swims in a plane and its `vz` is a lane it is easing into; a ball's
// fish orbit a standing column in x/z and systems/baitBall.js integrates a
// genuine third velocity for each one (see the `baitBall` branch in
// updateEnemies). So the yaw does not have to be inferred from which way the
// fish is drifting across the screen — it is known:
//
//   yaw = atan2(-vz, vx)      the fish's actual heading about world up
//
// and it is taken UNWRAPPED and rate-limited rather than eased between two
// endpoints. That difference is the whole feature: a fish going round the
// column rotates continuously through a full turn, near half sweeping through
// the camera and far half through the back wall, because that is what the
// orbit IS. Section 1's two-endpoint ease cannot express it — it can only
// arrive at +X or -X — and forcing every turn through the lens would be a
// second lie on top of the first.
//
// `depthHurry` is the one cheat, and it is the camera's fault. Orthographic:
// a fish at the left or right edge of the column is swimming straight at or
// away from the lens and is drawn as a sliver. It IS edge-on — nothing here
// can make it otherwise without bending the geometry — but the yaw is passed
// through `t - k*sin(2t)`, which is monotone and leaves both broadside poses
// exactly where they were while moving faster through the two edge-on
// quarters. The fish still goes fully edge-on; it spends less of its orbit
// there, which is the difference between a column of fish and a column of
// fish with holes flickering in it.
//
// AND IT KEEPS THE BODY WHEN THE BALL ENDS. A survivor hands back to section
// 1's two-sided ease — its yaw shifted by a whole number of turns, which is
// the same pose to the frame — rather than back to faceSide, which would be
// two writers with two decompositions again, the exact bug the anglerfish note
// above is about. So a fish that has been in a ball comes about for the rest
// of its life. That is a nicer animal than the one it was, and the alternative
// is a handover that has to snap.
// ---------------------------------------------------------------------------

const RIGHT = 0;
const LEFT = -Math.PI;
const TWO_PI = Math.PI * 2;

function cfg() {
  return CONFIG.fishTurn ?? {};
}

// Per-species overrides live on the def as `comeAbout: {...}`; `comeAbout:
// true` takes the shared block whole. Read key by key rather than by spreading
// the two objects together, because this runs per fish per frame and a pack of
// barracuda is up to 26 bodies.
function num(def, c, key, fallback) {
  const own = typeof def.comeAbout === 'object' ? def.comeAbout?.[key] : undefined;
  return own ?? c[key] ?? fallback;
}

/**
 * The yaw that points a body along a real 3D heading, shaped by `hurry`.
 *
 * `atan2(-dz, dx)` and not `atan2(dz, dx)`: rotating by y maps model forward
 * +X to (cos y, 0, -sin y), so a heading with a POSITIVE z — toward the camera
 * — is a NEGATIVE yaw. That sign is what puts the near half of an orbit in the
 * same [-PI, 0] interval section 1 sweeps its U-turns through, so the two
 * modes agree about what the number on the object means.
 *
 * The shaping is `t - k*sin(2t)`: periodic-compatible (sin(2t) has period PI,
 * so f(t + 2PI) = f(t) + 2PI and an unwrapped angle stays unwrapped), monotone
 * for k < 0.5, and fixed at every multiple of PI/2 — so both broadside poses
 * and both edge-on poses are exactly where they would be and only the time
 * spent getting between them moves.
 */
function orbitYaw(dx, dz, hurry) {
  const t = Math.atan2(-dz, dx);
  const k = Math.max(0, Math.min(0.45, hurry));
  return k > 0 ? t - k * Math.sin(2 * t) : t;
}

/**
 * Out of the orbit and back onto the two-sided ease, without moving the body.
 *
 * The orbit yaw is unwrapped and can be anywhere; section 1 works in [-PI, 0]
 * and compares its target against the LEFT/RIGHT constants by value. So the
 * yaw is shifted onto the nearest broadside pose's own turn — and because
 * `home - half*PI` is always a whole number of turns for either parity, the
 * shift is a multiple of 2PI and the rendered pose is identical on the frame
 * it happens. The ease is then opened from there, so the fish finishes coming
 * level instead of arriving level.
 */
function handBack(e) {
  const half = Math.round(e.__turnYaw / Math.PI);
  const home = (half % 2 === 0) ? RIGHT : LEFT;
  e.__turnYaw += home - half * Math.PI;
  e.__turnFrom = e.__turnYaw;
  e.__turnTo = home;
  e.__turnT = 0;
}

/**
 * Write this frame's whole orientation for one creature.
 *
 * Owns `mesh.rotation` and `visual.rotation.y` outright — do not call faceSide
 * on the same body, which is the two-writers bug the anglerfish's comment is
 * about, arriving from a third direction.
 *
 * @param e         the creature. Reads vx/vy (or `turnAim`, below), def, and
 *                  the lunge stage; keeps its own state in `__turn*` fields,
 *                  all rolled on the first frame so a fish never eases in from
 *                  a heading it never had.
 * @param dt        seconds.
 * @param launched  the rigid body is flying, so IT owns the transform — write
 *                  nothing, the same handoff the shared path makes. No
 *                  creature with a `rigidBody` has opted into `comeAbout`
 *                  today (only the sea turtle has one at all); if one ever
 *                  does, the body's roll and this yaw have to be reconciled
 *                  rather than merely taking turns, because RigidBody writes
 *                  `rotation.z` and would be composing it under a stale yaw.
 */
export function turnFish(e, dt, launched = false) {
  if (!e.mesh || !e.visual || launched) return;
  const c = cfg();
  const def = e.def;

  const dead = num(def, c, 'deadzone', 0.05);

  // --- WHAT IT IS POINTING AT ----------------------------------------------
  // Velocity, unless something has set `turnAim` this frame.
  //
  // WHY AN INPUT RATHER THAN A SECOND WRITER. A creature that is going
  // somewhere points where it is going, and for every fish in the roster that
  // is the whole story. An AMBUSHER is the exception: systems/bossAngler.js
  // spends most of its fight at a dead stop with its lure lit, and a trap that
  // is not looking at you is scenery.
  //
  // That used to be solved by the ambush writing the orientation itself on the
  // frames it held station and handing the body back on the frames it moved,
  // gated on `faceLocked`. Two writers with two different decompositions of the
  // same pose, taking turns: measured over a fight, the handoff frames inside
  // the recovery swung the body up to 166.9 degrees between two frames and put
  // the dorsal 179.9 degrees off vertical — the fish snapping round and
  // finishing upside down, every cycle. Neither writer was wrong on its own;
  // they simply did not agree about what the numbers on the object meant.
  //
  // So there is one writer and the ambush hands it a DIRECTION instead. The
  // yaw, the pitch and the bank keep easing through the switch because there is
  // no switch: `turnAim` changes what the targets are computed from and nothing
  // about the state carrying the body between them.
  //
  // `turnAimRate` and `turnAimTime` let the aimer name its own pitch rate and
  // yaw duration — an anglerfish lurks at 0.9 rad/s and snaps onto you at 2.4
  // during a tell, and that difference is the telegraph.
  const aim = e.turnAim;
  const ax = aim ? aim.x : e.vx;
  const ay = aim ? aim.y : e.vy;
  // ORBITING, rather than crossing the screen — see section 3. An aimer names
  // a point in the picture and has no depth to give, so it wins: a fish being
  // pointed at something is not swimming its own heading by definition.
  const orbit = !!e.baitBall && !aim;
  const az = orbit ? (e.vz ?? 0) : 0;
  const speed = Math.hypot(ax, ay, az);

  // 'YXZ' is what makes `rotation.y` a world yaw rather than a third rotation
  // stacked inside the heading. Set once, on the frame this creature is first
  // steered: `mesh` is a fresh Group per spawn (see spawnOne) so there is no
  // recycled body arriving with somebody else's order on it, and assigning an
  // Euler's order every frame dirties the matrix for nothing.
  if (e.__turnYaw == null) {
    e.mesh.rotation.order = 'YXZ';
    e.__turnYaw = orbit
      ? orbitYaw(ax, az, num(def, c, 'depthHurry', 0.3))
      : (ax < 0 ? LEFT : RIGHT);
    e.__turnFrom = e.__turnYaw;
    e.__turnTo = e.__turnYaw;
    e.__turnT = 1;
    // Off the FULL heading, so a fish seeded into a ball on a mostly-depth
    // course does not open its life pitched at the climb it is not making.
    // Identical to the old `Math.abs(ax)` everywhere else, since `az` is 0
    // outside the orbit.
    e.__turnPitch = speed > dead ? Math.atan2(ay, Math.hypot(ax, az)) : 0;
    e.__turnBank = 0;
    e.__wigglePhase = Math.random() * Math.PI * 2;
  }

  // --- THE SIDE ------------------------------------------------------------
  // Eased over a DURATION, like faceSide, because a come-about is a manoeuvre
  // with a beginning and an end rather than a constant swing — and it is a
  // longer duration than the flip it replaces, since there is now something to
  // watch happen.
  const time = Math.max(0.001, aim?.time ?? num(def, c, 'time', 0.55));
  const curve = num(def, c, 'curve', 'inOutCubic');
  const yawPrev = e.__turnYaw;
  if (orbit) {
    // THE ORBIT. Rate-limited and unwrapped rather than eased to an endpoint:
    // the target moves every frame and it goes all the way round, so a
    // duration ease would restart forever and could only ever arrive at one of
    // two poses anyway. `Math.round` on the turn count takes the short way, so
    // a fish never spins the long way to a heading it is already nearly on.
    const flat = Math.hypot(ax, az);
    if (flat > dead) {
      let want = orbitYaw(ax, az, num(def, c, 'depthHurry', 0.3));
      want += TWO_PI * Math.round((e.__turnYaw - want) / TWO_PI);
      const rate = Math.max(0.01, num(def, c, 'depthRate', 5)) * dt;
      e.__turnYaw += Math.max(-rate, Math.min(rate, want - e.__turnYaw));
    }
  } else {
    // The ball ended under this fish. Give the yaw back to the two-sided ease
    // at the same pose it is already in — see handBack.
    if (e.__turnOrbit) handBack(e);
    const want = ax < -dead ? LEFT : (ax > dead ? RIGHT : e.__turnTo);
    if (want !== e.__turnTo) {
      // From where the body actually is, so a turn reversed halfway through
      // continues from here instead of snapping back to begin the new one.
      e.__turnFrom = e.__turnYaw;
      e.__turnTo = want;
      e.__turnT = 0;
    }
    if (e.__turnT < 1) {
      e.__turnT = Math.min(1, e.__turnT + dt / time);
      e.__turnYaw = e.__turnFrom + (e.__turnTo - e.__turnFrom) * ease(curve, e.__turnT);
    }
  }
  e.__turnOrbit = orbit;

  // --- THE PITCH -----------------------------------------------------------
  // Rate-limited rather than eased: this one chases a target that moves every
  // frame (the fish's own climb), and a duration ease restarted on every new
  // target never finishes one. Bounded by construction — `Math.abs(e.vx)` puts
  // it in (-PI/2, PI/2) whichever side the yaw has settled on.
  const pitchRate = Math.max(0.01, aim?.rate ?? num(def, c, 'pitchRate', 4));
  if (speed > dead) {
    // Against the whole horizontal heading, which is `Math.abs(ax)` for
    // anything not orbiting. In a ball it is the difference between a fish
    // that is climbing and one that is merely swimming away from the camera:
    // with `az` left out, a heading of (0, 0.1, 3) reads as a 90-degree climb.
    const wantPitch = Math.atan2(ay, Math.hypot(ax, az));
    const step = Math.max(-pitchRate * dt, Math.min(pitchRate * dt, wantPitch - e.__turnPitch));
    e.__turnPitch += step;
  }

  // --- THE BANK ------------------------------------------------------------
  // How fast the body is currently changing direction, on both axes, turned
  // into a lean. `bank` is a signed taste knob: flipping its sign leans the
  // fish the other way through the same turn, and which one reads as banking
  // rather than as sliding is a thing to look at rather than to derive.
  const yawVel = dt > 0 ? (e.__turnYaw - yawPrev) / dt : 0;
  const bankMax = num(def, c, 'bankMax', 0.5);
  const wantBank = Math.max(-bankMax, Math.min(bankMax, yawVel * num(def, c, 'bank', 0.22)));
  const settle = 1 - Math.exp(-Math.max(0.01, num(def, c, 'bankSettle', 7)) * dt);
  e.__turnBank += (wantBank - e.__turnBank) * settle;

  // --- THE WIND-UP SHIMMY --------------------------------------------------
  // Only during lungeChase's `wind` stage, and only for a def that has one.
  // `lungeClock` counts DOWN through the stage, so `1 - clock/windup` is how
  // far into the gather this fish is; squaring it makes the shake arrive
  // rather than switch on, which is the difference between a countdown and a
  // vibration.
  let wYaw = 0;
  let wPitch = 0;
  let wBank = 0;
  if (e.lungeStage === 'wind') {
    const windup = def.lunge?.windup ?? 0.45;
    const u = windup > 0 ? Math.min(1, Math.max(0, 1 - (e.lungeClock ?? 0) / windup)) : 1;
    const ramp = u * u;
    e.__wigglePhase += dt * Math.PI * 2 * num(def, c, 'wiggleHz', 7);
    const wave = Math.sin(e.__wigglePhase);
    wYaw = wave * num(def, c, 'wiggleYaw', 0.3) * ramp;
    // A quarter cycle behind the yaw, so the body describes a small figure
    // rather than nodding along one line — the same trick the wag chain plays
    // with `chainPhase`, at one bone's worth of scale.
    wPitch = Math.sin(e.__wigglePhase - Math.PI / 2) * num(def, c, 'wigglePitch', 0.1) * ramp;
    wBank = wave * num(def, c, 'wiggleBank', 0.22) * ramp;
  } else {
    // Reset, not left running: a phase that kept advancing through the strike
    // and the cooldown would have the next wind-up open on a random part of
    // the cycle, and half of them would open mid-swing.
    e.__wigglePhase = 0;
  }

  e.mesh.rotation.y = e.__turnYaw + wYaw;
  e.mesh.rotation.z = e.__turnPitch + wPitch - Math.PI / 2;
  e.visual.rotation.y = e.__turnBank + wBank;
}

/**
 * Whether this creature steers itself with the above. Kept here rather than
 * spelled out at the call site so the flag is defined in one place.
 */
export function comesAbout(def, e) {
  if (CONFIG.view !== 'side') return false;
  // Three ways in, and the third is the one that looks odd. A fish this file
  // has already claimed keeps it for good — `__turnYaw` is only ever set here
  // — because handing a body back to faceSide means two writers holding two
  // different decompositions of one pose, and the handover can only be a snap.
  // In practice it is the survivor of a bait ball, which goes on turning like
  // an animal instead of reverting to a flip halfway through a run.
  return !!def?.comeAbout || !!e?.baitBall || e?.__turnYaw != null;
}
