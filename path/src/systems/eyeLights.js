import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { hdrInto, glowSprite } from './beams.js';

// EYE LIGHTS — two wet black beads socketed into the seal's own eyeballs, and
// everything they are allowed to say.
//
// WHAT THIS IS FOR. The seal is drawn small against water and at speed the one
// thing you cannot read off it is which way it is LOOKING. The head is on IK
// (systems/aimRig.js) and already tracks the cursor, so the animal is telling
// you where your shots are going a moment before they go — and nobody could
// see it. A catchlight on a dark eye turns an existing, correct, invisible
// behaviour into a readout, and costs nothing when nothing is happening.
//
// AT REST THE EYE IS BLACK AND ONLY SHINY. That is the whole resting state,
// and it is deliberate: an eye that glows all the time has spent its only
// channel, and everything below — the wind-up, the release, being bitten —
// would have to shout over it. Black is the floor the four signals rise from.
//
// FOUR THINGS IT SAYS, in strict priority. See `resolve` below.
//
//   HURT     any damage. Red, and it takes the eye OUTRIGHT rather than
//            mixing. The rim can afford to show a hit on top of a wind-up
//            (CONFIG.playerOutline.hit is added to the charge throb) because
//            it is a long thin shape with room for two readings; this is four
//            pixels, where two colours are mud and "you were bitten" must
//            never be something the player decodes.
//   RELEASE  the strike leaving. A one-shot spike far past anything the
//            wind-up reaches, eased out — the same shape and the same numbers'
//            meaning as the rim's `flareGlow`/`flareTime`.
//   LASER    a volley of Laser Eyes leaving. The muzzle flare, in the beam's
//            own colour, so the line has a visible source.
//   CHARGE   the wind-up. Eases on with the banked power and rides the CHARGE
//            RING'S OWN COLOURS — blue filling, mint at a full bank — so the
//            bank can be read off the animal's face without looking away from
//            what you are about to hit. That is the same reason the ring is
//            drawn around the seal rather than in a corner.
//
// LOUDEST WINS, it does not blend. Hurt beats everything; below that the
// brightest of the other three takes both the colour and the level. A laser
// firing on the frame a strike releases is a real thing that happens, and
// averaging two hues on a four-pixel dot produces a third colour that means
// nothing.
//
// ---------------------------------------------------------------------------
// THE THING TO KNOW BEFORE CHANGING ANY OF THIS: A SEAL HAS TWO EYES AND THIS
// CAMERA CAN ONLY EVER SEE ONE.
// ---------------------------------------------------------------------------
// The camera is orthographic, parked at +Z, never rotated and never given a
// lookAt (see world.js). The seal turns to its heading about Z and mirrors
// about its own forward axis, so its LEFT-RIGHT axis is pure camera depth —
// exactly the same fact that makes emitPoint flatten the two flipper muzzles
// onto one z. Measured on furseal.glb, the eye sockets sit at world ±0.21 in
// z and share their x and y to four decimal places.
//
// So the two beads land on the SAME SCREEN PIXEL. Whatever you do here, you
// will see one eye side-on: that is the animal, not a bug in this file. What
// this file must get right is that it is the NEAR one you see, and that the
// far one does not shine through the back of the skull.
//
// Depth testing is the obvious way to do that and is the wrong one twice
// over. The eyeball disc is set flush into the skin — the skull reaches only
// 0.005 world units past the eyeball centroid within 0.1 of the eye axis, and
// 0.09 within 0.2 — so a halo wide enough to bloom (see `haloRadius`) is
// sliced into a crescent by the brow of the near eye's own face, while the far
// eye needs to be occluded by a head that is only 0.4 units thick. One number
// cannot do both.
//
// Instead the beads are drawn on top (`depthTest: false`) and the far one is
// faded out by WHERE IT LOOKS: each anchor publishes its socket normal (see
// the `normal` field in ASSETS.ship.aimRig.anchors), and an eye pointing away
// from the camera is turned down. Side-on that is one eye at full and one at
// nothing. When the body cranes toward the camera to reach a target behind it
// (CONFIG.head.craneAngle, up to 0.7 rad) the far eye's normal swings back
// toward the lens and it comes up on its own — which is the real behaviour,
// arrived at with a dot product instead of a depth buffer.

// Which anchors this reads, and in which order the meshes are built. Names
// match ASSETS.ship.aimRig.anchors.
const SOCKETS = ['eyeL', 'eyeR'];

const state = {
  group: null,
  eyes: [],       // { bead, halo, name }
  lit: 0,         // eased master fade, so the eyes go out rather than pop out
  charge: 0,      // eased wind-up power, 0..1
  flare: 0,       // the release spike, 1 -> 0 over flareTime
  flarePower: 0,  // ...scaled by the power actually spent
  laser: 0,       // the beam muzzle flare, 1 -> 0 over laserTime
  hurt: 0,        // the damage flash, 1 -> 0 over its own scaled time
  hurtPower: 0,   // ...how bad the hit was, 0..1
  hurtTime: 0.45, // ...and how long THIS flash was given
};

// Scratch. Resolving a colour every frame must not allocate — this runs on the
// render path and two Colors a frame is two Colors a frame forever, which is
// also why beams.js grew hdrInto alongside its hdr.
const _col = new THREE.Color();
const _a = new THREE.Color();
const _b = new THREE.Color();
const _emissive = new THREE.Color();
const _halo = new THREE.Color();
const BLACK = new THREE.Color(0, 0, 0);

function cfg() {
  return CONFIG.eyeLights ?? {};
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Build the pair. One group, added to the scene by the caller.
 *
 * WORLD SPACE, NOT PARENTED TO THE EYE BONES — the same call the clubs make
 * (see main.js) and for the same reason: a mesh hung off a skinned bone
 * inherits that bone's scale along with its transform, and the seal's fit
 * scale is 2.36. The aim rig already publishes these sockets in world space
 * every frame, so there is nothing to gain by parenting and a scale to lose.
 */
export function createEyeLights() {
  const group = new THREE.Group();
  const c = cfg();
  const eyes = [];
  for (const name of SOCKETS) {
    // A MATERIAL PER ORB, not one shared between the two. They fade
    // independently — that is the entire near/far mechanism above — and a
    // shared opacity is exactly the bug that makes fading one bubble fade
    // every bubble in the primitive pool.
    //
    // THE BEAD IS THE ONE LIT THING THIS SYSTEM OWNS, and the only lit thing
    // in a stack that is otherwise all unlit additive quads. That is the
    // point: the catchlight is a real specular off the scene's own key light
    // (CONFIG.lighting, a directional at [4, 8, 14] — mostly toward the
    // camera), so it slides across the eye as the head turns instead of being
    // painted on at a fixed spot. A flat quad could not do it at all: one
    // normal across the whole face gives one shading value, so a "highlight"
    // on a quad is a decal, and a decal on an eye that turns is a sticker.
    //
    // The lights are fixed for the whole run — world.js reads CONFIG.lighting
    // and nothing in the day/night cycle writes it — so the glint does not
    // quietly go out at midnight.
    const beadMat = new THREE.MeshStandardMaterial({
      color: c.color ?? 0x05070a,
      roughness: c.roughness ?? 0.12,
      metalness: c.metalness ?? 0.1,
      emissive: new THREE.Color(0, 0, 0),
      emissiveIntensity: 1,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      // The emissive below is pushed past 1 on its peak channel so the glow
      // reaches the bright pass; tone mapping would pull it back under.
      toneMapped: false,
    });
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: glowSprite(),
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, toneMapped: false,
    });
    // A SPHERE for the bead, a quad for the halo. The sphere is what carries
    // the specular (see above); the halo is flat because it is glow laid over
    // the scene and this camera is axis aligned, so a quad in the XY plane
    // already faces it and needs no billboarding.
    //
    // Unit radius, scaled per frame — the radius is tunable and rebuilding
    // geometry for a slider would allocate on every input event.
    const bead = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), beadMat);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat);
    bead.frustumCulled = false;
    halo.frustumCulled = false;
    // The bead draws AFTER its halo. Both have depthTest off and sit at the
    // same point, so nothing about their positions can order them — three.js
    // would fall through its transparent sort to object id, which happens to
    // give the right answer today and would stop the moment either mesh was
    // built in a different order. A bead under its own halo is a halo with a
    // dim middle, so this is stated rather than inherited.
    halo.renderOrder = 0;
    bead.renderOrder = 1;
    group.add(halo, bead);
    eyes.push({ name, bead, halo });
  }
  // Above the seal, and above the beams, so a lit eye is never sorted under
  // the face it is set into. depthTest is off, so this ordering is the only
  // thing deciding what covers what. On the GROUP, which is what three.js
  // reads as the group order every descendant is sorted within — the per-mesh
  // renderOrder above then orders the pair inside that.
  group.renderOrder = 6;
  state.group = group;
  state.eyes = eyes;
  resetEyeLights();
  return group;
}

/**
 * How much of the camera an eye is showing, 0..1.
 *
 * `nz` is the z of the socket's normal in world space. The camera looks down
 * -Z from +Z and is never rotated (world.js), so "toward the lens" is simply
 * +z — no camera object needs to be threaded through here, and none should
 * be: a caller passing the SHAKEN camera would make the eyes flicker with the
 * shake.
 *
 * Exported so the harness can check the near/far split without a renderer.
 */
export function eyeFacing(nz, c = cfg()) {
  const start = c.faceStart ?? -0.05;
  const full = c.faceFull ?? 0.25;
  const span = Math.max(1e-4, full - start);
  const t = clamp01((nz - start) / span);
  // `farEye` is a floor, not a fade target: at 0 the away-facing eye is off
  // outright, which is what a side view wants. It is here because a stylised
  // pair — the far eye bleeding faintly through a thin skull — is a real look
  // and one slider away, and because a floor is a much clearer thing to read
  // off a tuner than a second curve.
  const floor = clamp01(c.farEye ?? 0);
  return floor + (1 - floor) * t;
}

// ---------------------------------------------------------------------------
// The four things an eye is allowed to say
// ---------------------------------------------------------------------------

/**
 * The strike left. A one-shot spike, eased out over `flareTime`.
 *
 * ON THE RELEASE, NOT ON THE END OF THE DASH — the same frame
 * flarePlayerOutline gets, from the same call site. The wind-up is what has
 * been building, so the pop belongs where the building stops; a flash at the
 * far end of the dash would be a second, unrelated event with nothing leading
 * into it.
 *
 * @param power the banked power actually spent, 0..1. A fizzle pops, a full
 *              commitment detonates.
 */
export function flareEyeLights(power = 1) {
  const p = clamp01(power);
  // `flarePower * flare` is the spike still burning: a small release fired
  // while a big one is still fading must not DOWNGRADE it. Same rule as the
  // rim's damage flash, and for the same reason.
  state.flarePower = Math.max(state.flarePower * state.flare, p);
  state.flare = 1;
}

/**
 * A volley of Laser Eyes left the sockets. The muzzle.
 *
 * Deliberately its own channel rather than being folded into the release
 * above: the two fire on completely different clocks (the beam is on a
 * cooldown, the strike is on a button) and giving them one decay would make
 * whichever fired second silently re-light the first.
 */
export function flashEyeLightsLaser(strength = 1) {
  state.laser = Math.max(state.laser, clamp01(strength));
}

/**
 * The seal was hit. Red, and it takes the eye outright until it burns out.
 *
 * Called from systems/playerDamageFx.js, next to the rim's own flash and
 * through the same door — every source of player damage arrives on screen the
 * same way, and that file is where the throttling and the fraction-of-the-bar
 * scaling already live.
 *
 * @param strength 0..1, how much of the health bar the hit cost. Drives both
 *                 how bright the flash is and how long it lasts.
 */
export function flashEyeLightsDamage(strength = 1) {
  const s = clamp01(strength);
  if (!(s > 0)) return;
  const c = cfg();
  // A hit landing inside a flash re-lights it from full, and must not
  // downgrade one: a scratch taken a moment after a maiming re-lights at the
  // maiming's brightness rather than cutting it short at the scratch's. Same
  // rule as flashPlayerOutlineDamage.
  state.hurtPower = Math.max(state.hurtPower * state.hurt, s);
  state.hurtTime = Math.max(
    c.hitMinTime ?? 0.18,
    (c.hitTime ?? 0.45) * state.hurtPower,
  );
  state.hurt = 1;
}

/**
 * What the eye is showing this frame: a colour in `out` and a glow level.
 *
 * LOUDEST WINS, no blending — see the header. Split out from the update so the
 * harness can walk the whole priority chain without a renderer, a rig or a
 * model, which is the only way the "hurt beats a full charge" rule is
 * cheap enough to assert exhaustively.
 *
 * @returns the glow level: 0 is a black bead, and the number is the emissive
 *          strength on its peak channel (so it is directly comparable to
 *          CONFIG.beams.overdrive).
 */
export function resolveEyeLook(s = state, c = cfg(), out = _col) {
  // 1. HURT — outright, no mixing. Squared so it peaks instantly and lingers,
  // the same curve the rim's flash uses.
  if (s.hurt > 0) {
    out.set(c.hitColor ?? 0xff2a18);
    return (c.hitGlow ?? 4.5) * s.hurtPower * s.hurt * s.hurt;
  }

  // 2..4 — the brightest of the three, taking its own colour with it.
  const flare = (c.flareGlow ?? 7) * s.flarePower * s.flare * s.flare;
  const laser = (c.laserGlow ?? 4) * s.laser * s.laser;
  const charge = (c.chargeGlow ?? 3.2) * s.charge;

  if (flare >= laser && flare >= charge) {
    // The release keeps the colour the bank had reached, so the spike reads as
    // the thing that was building letting go rather than as a new event in a
    // different hue. `flarePower` is that bank.
    chargeColour(s.flarePower, c, out);
    return flare;
  }
  if (laser >= charge) {
    out.set(c.laserColor ?? CONFIG.laserEyes?.color ?? 0x64f0ff);
    return laser;
  }
  chargeColour(s.charge, c, out);
  return charge;
}

/**
 * The wind-up's colour at bank `t`: the CHARGE RING'S OWN two colours, so the
 * eye and the meter never disagree about what "loaded" looks like. Blue while
 * it fills, mint at a full bank.
 */
function chargeColour(t, c = cfg(), out = _col) {
  _a.set(c.chargeColor ?? 0x7ad7ff);
  _b.set(c.chargeReadyColor ?? 0x9dffd0);
  return out.copy(_a).lerp(_b, clamp01(t));
}

/**
 * One frame.
 *
 * @param rig  the player's aim rig, or null. A model with no eye sockets — any
 *            seal swapped in through the model workbench — simply gets no
 *            beads, rather than two of them hanging at the world origin.
 * @param opts.lit    0..1 master gate. main.js hands it 1 while the seal is
 *                    alive and 0 once it isn't, and the ease turns that into
 *                    the eyes going out over a beat rather than on a frame.
 * @param opts.charge 0..1 of a strike being wound up. THE BUTTON, not
 *                    `strikeState.charging` — exactly the expression the rim
 *                    is given, computed once in main.js and handed to both.
 *                    Charging goes false the instant the bar runs dry, and the
 *                    tell must not cut out halfway through a hold the player
 *                    is still committing to; it plateaus at what was banked.
 */
export function updateEyeLights(dt, rig, { lit = 1, charge = 0 } = {}) {
  const group = state.group;
  if (!group) return;
  const c = cfg();

  const sockets = rig?.anchors;
  const normals = rig?.anchorNormals;
  const has = !!(c.enabled !== false && sockets && normals
    && SOCKETS.every((n) => sockets[n] && normals[n]));

  // --- run the clocks down, ALWAYS -------------------------------------------
  // Before the visibility gate below, deliberately: a flash left mid-decay
  // while the eyes were hidden would still be burning when they came back, and
  // the seal would blink red on the first frame of the next run.
  if (state.flare > 0) state.flare = Math.max(0, state.flare - dt / Math.max(0.01, c.flareTime ?? 0.3));
  if (state.laser > 0) state.laser = Math.max(0, state.laser - dt / Math.max(0.01, c.laserTime ?? 0.22));
  if (state.hurt > 0) state.hurt = Math.max(0, state.hurt - dt / Math.max(0.01, state.hurtTime));
  // The wind-up EASES rather than tracking `pending` directly. Letting go
  // drops the button to 0 on one frame, and an eye that cut with it would
  // strobe on every flick — the release spike is what that moment is for.
  const wantCharge = clamp01(charge);
  const chargeRate = wantCharge > state.charge ? (c.chargeLerp ?? 7) : (c.chargeFall ?? 12);
  state.charge += (wantCharge - state.charge) * (1 - Math.exp(-chargeRate * dt));
  if (state.charge < 0.002) state.charge = 0;

  // Ease toward the gate. Driven to 0 outright when there is nothing to sit
  // in — a rig that vanished mid-run (a model swap) must not leave two beads
  // easing down at the coordinates the old seal's head used to be.
  const want = has ? clamp01(lit) : 0;
  const rate = has ? (c.fadeIn ?? 9) : (c.fadeOut ?? 5);
  state.lit += (want - state.lit) * (1 - Math.exp(-rate * dt));
  if (state.lit < 0.002) state.lit = 0;

  if (state.lit === 0) {
    if (group.visible) group.visible = false;
    return;
  }
  group.visible = true;

  const glow = resolveEyeLook(state, c, _col);
  // Derived ONCE, not per eye: both eyes belong to one animal and say the same
  // thing at the same moment. PEAK-CHANNEL, not luminance — the bright pass
  // weights blue at 7% and green at 72%, so a cyan authored at a sane 1.0
  // never crosses the threshold and simply does not glow however bright it
  // looks. Shared with the beams so the eye and the line it fires reach the
  // bright pass on identical terms.
  //
  // At glow 0 the emissive is BLACK, which is the resting eye: nothing added,
  // so the bead is exactly as the scene shades it.
  if (glow > 0) hdrInto(_emissive, _col, glow); else _emissive.copy(BLACK);
  hdrInto(_halo, _col, c.haloOverdrive ?? 1.2);
  const beadR = Math.max(0.001, c.radius ?? 0.08);
  const haloR = Math.max(0.001, c.haloRadius ?? 0.42);
  // The halo grows a little with the glow as well as brightening. A halo that
  // only ever changed opacity reads as the same lamp behind a thinner filter;
  // one that swells reads as more light coming out of the same hole.
  const haloScale = haloR * 2 * (1 + (c.haloSwell ?? 0.35) * clamp01(glow / Math.max(0.001, c.haloSwellAt ?? 5)));

  for (const eye of state.eyes) {
    const p = sockets?.[eye.name];
    const n = normals?.[eye.name];
    // `has` already proved these exist; this is the frame where a rig went
    // away between the check and here (it cannot, but a null deref in a
    // render loop is a black screen and the guard is one comparison).
    if (!p || !n) continue;

    const face = eyeFacing(n.z, c);
    const a = state.lit * face;

    eye.bead.position.copy(p);
    eye.halo.position.copy(p);
    eye.bead.scale.setScalar(beadR);
    eye.halo.scale.setScalar(haloScale);

    eye.bead.material.opacity = a;
    eye.bead.material.emissive.copy(_emissive);
    // The halo is the part that actually blooms — the bead at 0.16 world units
    // is about 3 screen pixels and sub-pixel in a sixth-scale bright pass.
    eye.halo.material.color.copy(_halo);
    eye.halo.material.opacity = a * (c.haloOpacity ?? 0.7) * clamp01(glow / Math.max(0.001, c.haloFullAt ?? 3));
  }
}

/**
 * Where the beams leave from. `side` is 0 for the left socket, 1 for the
 * right; anything else wraps, so a fan of four beams can just pass its index.
 *
 * Returns `fallback` itself — not a copy — when this seal has no eye sockets,
 * which is how systems/laserEyes.js tells "use the anchor" from "fall back to
 * the old body-relative offset". Same contract as emitPoint in aimRig.js.
 */
export function eyeSocket(rig, side, fallback) {
  const a = rig?.anchors;
  if (!a) return fallback;
  const p = a[SOCKETS[((side % SOCKETS.length) + SOCKETS.length) % SOCKETS.length]];
  return p ?? fallback;
}

/** A new run starts with the eyes dark, cold and unhurt. */
export function resetEyeLights() {
  state.lit = 0;
  state.charge = 0;
  state.flare = 0;
  state.flarePower = 0;
  state.laser = 0;
  state.hurt = 0;
  state.hurtPower = 0;
  state.hurtTime = cfg().hitTime ?? 0.45;
  if (state.group) state.group.visible = false;
  for (const eye of state.eyes) {
    eye.bead.material.opacity = 0;
    eye.bead.material.emissive.copy(BLACK);
    eye.halo.material.opacity = 0;
  }
}

/**
 * Re-read the tuned bead. Its colour, roughness and metalness are material
 * properties rather than per-frame writes, so a slider on them reads as dead
 * until this re-stamps them. The emissive, the halo colour and every size are
 * written every frame and need nothing.
 */
export function applyEyeLightColours() {
  const c = cfg();
  for (const eye of state.eyes) {
    eye.bead.material.color.set(c.color ?? 0x05070a);
    eye.bead.material.roughness = c.roughness ?? 0.12;
    eye.bead.material.metalness = c.metalness ?? 0.1;
    eye.bead.material.needsUpdate = true;
  }
}

/** The live look, for the debug panel and the harness. Read-only. */
export function eyeLightState() {
  return state;
}
