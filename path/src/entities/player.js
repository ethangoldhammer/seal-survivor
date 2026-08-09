import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { baseStats, applyLevelGrowth } from '../stats.js';
import { createVisual } from '../assets.js';
import { bounds, clampToArena, midWater } from '../arena.js';
import { feedback } from '../systems/feedback.js';
import { createAnimationController, stateForSpeed } from '../systems/animation.js';
import { createAimRig } from '../systems/aimRig.js';
import { attachPlayerOutline } from '../systems/outlines.js';

// Scratch for the body transform, which composes the mirror, the barrel roll,
// the crane and the wind-up shudder every frame.
const _rollQ = new THREE.Quaternion();
const _craneQ = new THREE.Quaternion();
const TAU = Math.PI * 2;
const _yAxis = new THREE.Vector3(0, 1, 0); // the art's forward — the roll axis
const _xAxis = new THREE.Vector3(1, 0, 0); // swings the nose toward the camera

export const player = {
  mesh: null, // container — carries the aim rotation
  body: null, // visual — carries the left/right flip
  aimRig: null, // fin/head IK, muzzles and bone anchors; null for a model with no rig
  velocity: new THREE.Vector2(0, 0),
  hp: 100,
  invuln: 0,
  upgrades: [],
  stats: {},
  aboveSurface: false,
  // Which way the surface was crossed on THIS frame: 1 up, -1 down, 0 not at
  // all. A one-frame edge, cleared at the top of updatePlayer — `aboveSurface`
  // alone can't carry it, since a caller reading it after the fact sees only
  // the state, not the crossing. Porpoising (main.js) is what reads it; kept
  // as a plain field for the same reason as dashTimer and comboSpeedMul —
  // entities/ doesn't import from systems/.
  breachDir: 0,
  // The side-view mirror, as an ANGLE rather than written straight onto the
  // body. 0 or PI — a mirror about the forward axis IS a half roll, so it
  // lives in the same channel the barrel roll does and the two simply add.
  // Before this the mirror wrote body.rotation.y absolutely from three
  // different places, which left nowhere for a roll to go without one of them
  // stomping it mid-spin.
  mirrorAngle: 0,
  // Procedural barrel roll — the only thing rolling the seal now that the
  // spin clip is gone. Driven by main.js at launch (like dashTimer) and
  // integrated in updatePlayer; both ends land on whole turns, so the roll
  // always finishes flush with the mirror underneath it.
  rollAngle: 0,
  // From/to rather than a bare total, so a strike fired while an earlier roll
  // is still turning continues from where that one had got to instead of
  // snapping the seal back to upright and starting again. With the rhythm
  // loop, re-striking mid-roll is the normal case, not an edge one.
  rollFrom: 0,
  rollTo: 0,
  rollElapsed: 0,
  rollDuration: 0,
  // 0..1 of a strike being wound up, pushed in by main.js each frame — the
  // coil pose the aim rig applies. Same plain-field arrangement as dashTimer
  // and comboSpeedMul, and for the same reason: entities/ doesn't import from
  // systems/, so the strike state comes to it rather than the other way round.
  chargePose: 0,
  // True while a wind-up has the mouth sealed — chum still magnetises in but
  // nothing is swallowed until the strike fires and gulps the lot (see
  // CONFIG.strike.charge.gulp and updatePickups). Pushed in by main.js each
  // frame for the same reason as chargePose above.
  chumSealed: false,
  // Body twist toward the camera when the aim goes behind, and the clock for
  // the wind-up tremble. Both live on the same body transform as the mirror
  // and the barrel roll, composed together in updatePlayer.
  craneAngle: 0,
  chargeClock: 0,
  shudderAmp: 0, // eased amplitude, so the tremble fades out instead of cutting
  oxygen: 100,
  level: 1, // mirrors gameState.level so stat scaling can read it
  mirrored: null, // side-view facing flip state (null until first resolved)
  // The mirror turnaround, eased rather than swapped. `mirrorAngle` above is
  // the live value; these describe the roll currently carrying it across.
  mirrorFrom: 0,
  mirrorTo: 0,
  mirrorT: 1, // 1 = settled
  mirrorDuration: 0,
  anim: null,
  hitThisFrame: false,
  // >0 while a strike dash is in flight. Set by main.js when the dash fires;
  // the only thing it does is swap which ceiling the velocity clamp uses (see
  // updatePlayer). Lives here rather than being read off strikeState so this
  // module stays free of a systems/ import, like every other entity file.
  dashTimer: 0,
  // Speed multiplier from the live strike combo, pushed in by main.js each
  // frame (same reason as dashTimer above — no systems/ import here). Scales
  // thrust, the speed ceiling AND the dash turn rate together, so a combo is
  // uniformly more agile rather than fast-but-unsteerable.
  comboSpeedMul: 1,
};

export function initPlayer(scene) {
  const group = new THREE.Group();
  group.name = 'player';

  const body = createVisual('ship');
  group.add(body);
  // Readability comes from the seal's own silhouette now, not from a ring
  // drawn around it — see systems/outlines.js and CONFIG.playerOutline.
  attachPlayerOutline(body);

  player.mesh = group;
  player.body = body;
  player.anim = createAnimationController(body);
  player.aimRig = createAimRig(body);
  scene.add(group);
  recomputeStats();
}

// player.body is a singleton created once above, not repeatedly cloned like
// an enemy — startGame()'s resetPlayer() only resets its position/stats, it
// never recreates the mesh. That means a T-menu size change (or a restored
// one from a previous session) would update the multiplier used for FUTURE
// createVisual('ship') calls, but silently do nothing to the ship already on
// screen — indistinguishable from "the slider doesn't work" if you're trying
// to make it bigger to see it. Swaps the body mesh in place, same rotation
// state, and rebuilds the animation controller since that's tied to the
// specific mesh instance.
export function rebuildShipBody() {
  if (!player.mesh || !player.body) return;
  const oldRotationY = player.body.rotation.y;
  player.mesh.remove(player.body);
  const body = createVisual('ship');
  body.rotation.y = oldRotationY;
  player.mesh.add(body);
  player.body = body;
  // The shells hang off the meshes inside the OLD body, which just left the
  // scene — a rebuilt seal starts with no outline until they're remade.
  attachPlayerOutline(body);
  player.anim = createAnimationController(body);
  // Bones are per-instance, so the aim rig is as tied to this mesh as the
  // animation controller is — a swapped body leaves the old one pointing at
  // bones that are no longer in the scene.
  player.aimRig = createAimRig(body);
}

// Rebuild the stat block from CONFIG, then replay every upgrade on top. Called
// on reset, on level-up, and whenever the tuner changes a value — which is why
// sliders affect a run already in progress.
export function recomputeStats() {
  const s = baseStats();

  for (const id of player.upgrades) {
    CONFIG.upgrades.find((u) => u.id === id)?.apply(s);
  }

  // Baseline growth applied AFTER upgrades — see stats.js for the why.
  applyLevelGrowth(s, player.level);

  player.stats = s;
  player.hp = Math.min(player.hp, s.maxHp);
  return s;
}

export function addUpgrade(id) {
  player.upgrades.push(id);
  const beforeHp = player.stats.maxHp;
  const beforeO2 = player.stats.maxOxygen;
  recomputeStats();
  player.hp = Math.min(player.stats.maxHp, player.hp + Math.max(0, player.stats.maxHp - beforeHp));
  // Same grant for oxygen as for health: taking a bigger tank hands you the
  // extra air, rather than leaving the bar looking emptier than it did a
  // second ago because only the denominator moved.
  player.oxygen = Math.min(
    player.stats.maxOxygen,
    player.oxygen + Math.max(0, player.stats.maxOxygen - beforeO2),
  );
}

export function availableUpgrades() {
  return CONFIG.upgrades.filter((u) => {
    // `enabled: false` (set in the upgrade table) removes an upgrade from
    // the offer pool entirely, without deleting it from config.
    if (u.enabled === false) return false;
    if (u.maxStacks == null) return true;
    return player.upgrades.filter((id) => id === u.id).length < u.maxStacks;
  });
}

export function resetPlayer() {
  player.mesh.position.set(0, midWater(), 0);
  player.mesh.rotation.z = 0;
  player.mirrorAngle = 0;
  player.craneAngle = 0;
  player.chargeClock = 0;
  player.shudderAmp = 0;
  player.body.rotation.y = 0;
  player.body.quaternion.identity();
  player.rollAngle = 0;
  player.rollElapsed = 0;
  player.rollDuration = 0;
  player.rollFrom = 0;
  player.rollTo = 0;
  player.velocity.set(0, 0);
  player.aboveSurface = false;
  player.breachDir = 0;
  player.level = 1;
  player.mirrored = null;
  player.mirrorFrom = 0;
  player.mirrorTo = 0;
  player.mirrorT = 1;
  player.mirrorDuration = 0;
  player.upgrades.length = 0;
  player.invuln = 0;
  player.dashTimer = 0;
  player.comboSpeedMul = 1;
  player.chumSealed = false;
  // The controller is reused across runs, and 'death' is a one-shot that
  // never expires by design — so without this the seal stays clamped in its
  // death pose for every subsequent run.
  player.anim?.reset();
  player.aimRig?.reset();
  recomputeStats();
  player.hp = player.stats.maxHp;
  // After recomputeStats, not before: upgrades were just cleared above, so the
  // cap is back to base and this fills the real tank rather than last run's.
  player.oxygen = player.stats.maxOxygen;
}

export function updatePlayer(dt, input) {
  const s = player.stats;
  const pos = player.mesh.position;

  // Decremented up here rather than down by the clamp: everything below wants
  // to know whether this frame is a dash frame, not just the clamp.
  if (player.dashTimer > 0) player.dashTimer -= dt;
  const dashing = player.dashTimer > 0;
  const combo = player.comboSpeedMul || 1;

  if (CONFIG.player.thrustEnabled) {
    player.velocity.x += input.move.x * s.thrust * combo * dt;
    player.velocity.y += input.move.y * s.thrust * combo * dt;
  }

  // Steering mid-dash. A strike used to be a straight line you waited out —
  // the impulse set velocity once and thrust alone (19 u/s^2 against a 46 u/s
  // dash) couldn't meaningfully bend it inside 0.22s. Now the dash keeps its
  // SPEED and swings its HEADING toward the stick at a capped angular rate,
  // which is what makes it a turn radius rather than a lerp: speed/turnRate,
  // ~3.8 world units at defaults. The rate scales with the combo alongside
  // the speed it divides, so the radius stays constant as you get faster.
  if (dashing && CONFIG.strike.dashTurnRate > 0 && input.move.lengthSq() > 0.001) {
    const v = player.velocity.length();
    if (v > 0.001) {
      const cur = Math.atan2(player.velocity.y, player.velocity.x);
      let delta = Math.atan2(input.move.y, input.move.x) - cur;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const maxStep = CONFIG.strike.dashTurnRate * combo * dt;
      const a = cur + Math.max(-maxStep, Math.min(maxStep, delta));
      player.velocity.set(Math.cos(a) * v, Math.sin(a) * v);
    }
  }

  // Breaching the surface is free; gravity above it is opt-in (default 0).
  if (CONFIG.arena.airGravity > 0 && pos.y > bounds.surfaceY) {
    player.velocity.y -= CONFIG.arena.airGravity * dt;
  }

  // The strike dash gets its own, higher ceiling for the length of the dash.
  // Without this the clamp ran before the impulse ever moved anything: main.js
  // sets velocity to dashSpeed (46), then the very next frame this line cut it
  // back to maxSpeed (34) BEFORE position integrated — so the dash never
  // actually travelled at dash speed and the dashSpeed slider did nothing.
  // Still clamped, just against the dash's own ceiling, so nothing runs away.
  // Both ceilings ride the combo multiplier: every live chain link makes the
  // seal faster, in the dash AND in the swimming between dashes.
  const ceiling = (dashing ? Math.max(s.maxSpeed, s.strikeDashSpeed) : s.maxSpeed) * combo;
  const speed = player.velocity.length();
  if (speed > ceiling) player.velocity.multiplyScalar(ceiling / speed);

  player.velocity.multiplyScalar(Math.pow(s.friction, dt * 60));

  pos.x += player.velocity.x * dt;
  pos.y += player.velocity.y * dt;

  const wasAbove = player.aboveSurface;
  const hitWall = clampToArena(pos, player.velocity, s.hitRadius, CONFIG.arena.wallRestitution);
  if (hitWall) {
    feedback('bounce', { x: pos.x, y: pos.y, vx: player.velocity.x, vy: player.velocity.y });
  }

  // Breaching the surface throws up a splash, in either direction.
  player.aboveSurface = pos.y > bounds.surfaceY;
  player.breachDir = player.aboveSurface === wasAbove ? 0 : (player.aboveSurface ? 1 : -1);
  if (player.aboveSurface !== wasAbove) {
    feedback('breach', {
      x: pos.x,
      y: bounds.surfaceY,
      dirX: 0,
      dirY: 1,
      vx: player.velocity.x,
      vy: Math.abs(player.velocity.y),
      scale: Math.min(2, 0.5 + Math.abs(player.velocity.y) / 14),
    });
    // Bark only on the way UP — surfacing for air is the moment a seal
    // vocalizes; barking as you dive back under reads as a hiccup.
    // Lowest one-shot priority, so a hit or death cuts it off cleanly.
    if (player.aboveSurface) player.anim?.trigger('bark');
  }

  if (CONFIG.oxygen.enabled) {
    if (player.aboveSurface) {
      player.oxygen = Math.min(s.maxOxygen, player.oxygen + s.oxygenRefillRate * dt);
    } else {
      player.oxygen = Math.max(0, player.oxygen - CONFIG.oxygen.depleteRate * dt);
    }
  }

  // --- facing -------------------------------------------------------------
  // The seal points where it's MOVING by default, not where it's aiming — a
  // swimming animal turns its body to travel, and following the cursor made
  // it twitch on every mouse jiggle while drifting the other way. Aim-facing
  // is still selectable via CONFIG.player.faceMode.
  const useVelocity = CONFIG.player.faceMode !== 'aim';
  const dirX = useVelocity ? player.velocity.x : input.aim.x;
  const dirY = useVelocity ? player.velocity.y : input.aim.y;
  const dirLen = Math.hypot(dirX, dirY);

  // Below the threshold there's no meaningful direction, so hold the current
  // facing instead of spinning on near-zero noise.
  if (dirLen > (useVelocity ? CONFIG.player.minSpeedToTurn : 0.0001)) {
    // The art's forward is +Y, so subtract a quarter turn.
    const target = Math.atan2(dirY, dirX) - Math.PI / 2;
    // Smooth toward the target the SHORT way around, so crossing the
    // -pi/pi seam doesn't send it spinning the long way. Frame-rate
    // independent, so the feel doesn't change with framerate.
    let delta = target - player.mesh.rotation.z;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // Dashing swaps in its own, much faster facing rate, and a combo scales
    // the normal one — at combo speeds the default smoothing reads as the
    // model lagging behind where you're actually going.
    const lerpRate = dashing ? CONFIG.strike.dashFaceLerp : CONFIG.player.turnLerp * combo;
    const t = 1 - Math.exp(-lerpRate * dt);
    player.mesh.rotation.z += delta * t;

    // In side view a full turn would leave the animal belly-up, so the model
    // is mirrored about its own forward axis instead of rolling over.
    //
    // That mirror used to be a hard 180 swap, hidden by playing a spin CLIP
    // and deferring the swap to the clip's midpoint — the pop was still there,
    // it just happened while the seal was edge-on and hardest to see. Now the
    // mirror is rolled: it is a half turn about the same axis the barrel roll
    // uses, so easing the angle across IS the turnaround, and there is no
    // moment where anything jumps. The clip is gone.
    if (CONFIG.view === 'side') {
      const facingX = Math.cos(player.mesh.rotation.z + Math.PI / 2);
      const wantMirror = facingX < 0;

      if (player.mirrored == null) {
        // First resolve of the run — there is no previous facing to ease from.
        player.mirrored = wantMirror;
        player.mirrorAngle = wantMirror ? Math.PI : 0;
        player.mirrorT = 1;
      } else if (wantMirror !== player.mirrored) {
        // Always rolls the same way rather than unwinding the way it came, so
        // reversing twice reads as one continuous corkscrew instead of a
        // wobble. Started from the CURRENT angle, so a reversal that arrives
        // mid-turnaround simply extends the roll already happening.
        player.mirrored = wantMirror;
        player.mirrorFrom = player.mirrorAngle;
        player.mirrorTo = player.mirrorAngle + Math.PI;
        player.mirrorT = 0;
        // A dash redirect still turns over much faster — waiting out a lazy
        // swim turnaround for the model to agree with where you are already
        // going is the "animation has to finish before the input counts" feel.
        // It is a shorter roll now, not an instant flip: the snap this whole
        // mechanism exists to avoid was just as ugly during a dash.
        player.mirrorDuration = (!dashing && CONFIG.player.turnAroundEnabled)
          ? CONFIG.player.turnAroundDuration
          : (CONFIG.player.turnAroundDashDuration ?? 0.12);
      }
    }
  }

  // Ease the mirror across. Smoothstep, like the barrel roll — a linear sweep
  // starts and stops abruptly, which is the same pop in a different costume.
  if (player.mirrorT < 1) {
    player.mirrorT = Math.min(1, player.mirrorT + dt / Math.max(0.01, player.mirrorDuration));
    const e = player.mirrorT * player.mirrorT * (3 - 2 * player.mirrorT);
    player.mirrorAngle = player.mirrorFrom + (player.mirrorTo - player.mirrorFrom) * e;
    if (player.mirrorT >= 1) {
      // Wrapped once settled, or a long run of reversals walks the angle up
      // forever and bleeds float precision into everything added to it.
      player.mirrorAngle = ((player.mirrorTo % TAU) + TAU) % TAU;
    }
  }

  // --- barrel roll ----------------------------------------------------------
  // Advanced here and composited with the mirror in ONE place, so neither can
  // stomp the other. Whole extra turns, bought with how hard the strike was
  // charged. (The state machine no longer rolls at all — see the note on the
  // mirror above; this is the only thing rolling the seal now.)
  if (player.rollDuration > 0) {
    player.rollElapsed += dt;
    const t = Math.min(1, player.rollElapsed / player.rollDuration);
    // Smoothstep rather than a linear sweep or an ease-out: a roll that starts
    // and stops abruptly reads as a snap, and one that decelerates into the
    // finish reads as running out of steam halfway through the manoeuvre.
    player.rollAngle = player.rollFrom + (player.rollTo - player.rollFrom) * (t * t * (3 - 2 * t));
    if (t >= 1) {
      // Zeroed rather than left at rollTo. Both ends are whole turns, so the
      // two are the same pose, but letting the raw angle accumulate across a
      // run would bleed float precision into the mirror it's added to.
      player.rollDuration = 0;
      player.rollElapsed = 0;
      player.rollFrom = 0;
      player.rollTo = 0;
      player.rollAngle = 0;
    }
  }
  // --- body crane -----------------------------------------------------------
  // A target behind the seal is reached by turning the BODY, not by folding
  // the neck backwards. `glance` is the aim rig's own measure of how far the
  // head has given up (see systems/aimRig.js); the body twists that far toward
  // the camera, which brings the target back inside the head's cone and lets
  // the neck go back to doing something a neck can do.
  //
  // Read from LAST frame's glance on purpose: the rig solves at the end of
  // this function, against the body orientation set here, so using this
  // frame's value would need the rig to run first and then re-pose the body
  // it had already solved against. The value is heavily eased anyway, so a
  // frame of lag is invisible.
  const wantCrane = (player.aimRig?.glance ?? 0) * (CONFIG.head.craneAngle ?? 0);
  player.craneAngle += (wantCrane - player.craneAngle) * (1 - Math.exp(-(CONFIG.head.craneLerp ?? 5) * dt));

  // Wind-up tremble on the body, the companion to the head's (aimRig.js).
  //
  // The amplitude is EASED rather than read straight off chargePose. Releasing
  // drops chargePose to 0 in one frame, and since the shudder is applied raw
  // to the body (unlike the head's, which the IK smoothing rounds off) that
  // left the body snapping up to two degrees on the frame of the launch — a
  // visible tick on the single most-repeated action in the game.
  const wantShudder = player.chargePose;
  player.shudderAmp += (wantShudder - player.shudderAmp) * (1 - Math.exp(-18 * dt));
  if (player.shudderAmp < 0.001) player.shudderAmp = 0;
  let shudder = 0;
  if (player.shudderAmp > 0) {
    const vib = CONFIG.strike.charge.vibrate ?? {};
    player.chargeClock += dt;
    shudder = player.shudderAmp * (vib.body ?? 0)
      * Math.sin(player.chargeClock * (vib.hz ?? 22) * Math.PI * 2);
  } else {
    player.chargeClock = 0;
  }

  // One composition for all four. They are separate axes of the same
  // transform, and writing them as Euler components would make the result
  // depend on Euler order — the roll has to happen about the seal's own long
  // axis (+Y is the art's forward) whatever the crane is doing to it, which is
  // exactly what `crane * roll` gives and what `rotation.set(x, y, z)` does
  // not. Crane about the PARENT's X swings the nose out toward the camera and
  // is mirror-independent, since a 180 roll about forward leaves forward alone.
  _rollQ.setFromAxisAngle(_yAxis, player.mirrorAngle + player.rollAngle);
  _craneQ.setFromAxisAngle(_xAxis, player.craneAngle + shudder);
  player.body.quaternion.copy(_craneQ).multiply(_rollQ);

  if (player.invuln > 0) player.invuln -= dt;

  if (player.hp < s.maxHp) {
    player.hp = Math.min(s.maxHp, player.hp + s.regenPerSec * dt);
  }

  if (CONFIG.animation.enabled && player.anim) {
    // aboveSurface picks the land clips (idle/walk) over the water ones —
    // a seal that's breached shouldn't be swim-cycling through the air.
    const state = stateForSpeed(player.velocity.length(), player.aboveSurface);
    player.anim.update(dt, state, player.hitThisFrame);
  }

  // Fin and head IK run AFTER the mixer, deliberately: they overwrite the
  // flipper and neck bones the clip just posed, and nothing else. Outside the
  // CONFIG.animation.enabled gate above, so turning creature animation off
  // leaves the seal still aiming — these are control surfaces, not a
  // performance. This is also the last thing to touch the skeleton before the
  // frame renders, which is what makes the muzzles and bubble anchors it
  // publishes current rather than one frame stale.
  updateAimRig(dt, input.aim, CONFIG.weapon.autofire || input.firing, player.chargePose);

  player.hitThisFrame = false;
}

export function applyRecoil(dir) {
  if (!CONFIG.weapon.recoilEnabled) return;
  player.velocity.x -= dir.x * player.stats.recoil;
  player.velocity.y -= dir.y * player.stats.recoil;
}

// Shared by the game loop and by the menus: the rig must keep ticking even
// when updatePlayer isn't running, or the seal idling behind a menu freezes
// its flippers mid-aim and the bubble anchors go stale where they stand.
// `limp` is the death dive (systems/deathDive.js). It doesn't pose anything —
// it just declines to hand the rig over to the one-shot that's playing, which
// matters because 'death' is the one clip that never expires: left suppressed,
// the tail spring's weight eases to zero and the corpse sinks with a tail as
// stiff as a board. The fins and head still go slack, but they do that on
// their own, because the dive stops feeding the rig an aim to point at.
export function updateAimRig(dt, aim, engaged, charge = 0, limp = false) {
  player.aimRig?.update(dt, aim, {
    engaged,
    // 0..1 of a strike being wound up — coils the head back and lifts the
    // tail. Passed in rather than read off strikeState, for the same reason
    // dashTimer and comboSpeedMul are: entities/ doesn't import from systems/.
    charge,
    // One `suppressed` flag for both chains — the fins and the head read it
    // through their own releaseOnOneShot toggles, so either can opt out of
    // handing control back to an authored performance.
    suppressed: !limp && (player.anim?.isPlayingOneShot() ?? false),
  });
}
