import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import {
  createRig, runRibbon, clearRig, rigStats, HARD_MAX_NODES,
} from './ribbonTrail.js';

// ============================================================================
// THE BREACH TRAIL — the RGB-split exhaust the seal drags through the air.
//
// ...and the SWIM TRAIL, the plain white ribbon it draws underwater. They are
// one effect with two settings blocks rather than two systems; see "TWO TRAILS,
// ONE ALGORITHM" below. Everything in this header describes both,
// except the RGB split, which is the air trail's alone.
//
// Three ribbons, one per colour channel, drawn additively over each other. Each
// reads the SAME spine at a different offset, so where they agree they sum back
// to white and where they don't they fringe. That is what makes the split read
// as a bright thing photographed badly rather than as a rainbow: it is three
// samples of one exhaust, a hair apart, not three coloured ribbons.
//
// THE SPINE IS NOT A PATH. It used to be — a ring of the seal's recent
// positions, rebuilt every frame, so the ribbon was rigidly welded to where the
// body had been and the only thing it could do at the end of an arc was dim.
// Now every point on it is a PARTICLE: born at the seal with an outward kick,
// pushed by the same divergence-free turbulence field the sprites ride, slowed
// by drag, and carrying its own lifetime. The ribbon is drawn THROUGH them. So
// the trail keeps living after the seal has gone — it billows outward, frays,
// and dies raggedly a particle at a time instead of fading out as one object.
//
// WHY THE FIELD IS THE ONE FROM entities/particles.js. It is divergence-free by
// construction (see the long note there), which means it can only ever swirl
// the particles around — never pile them together or tear them apart. That is
// the whole difference between a plume shearing and a plume shattering. A
// particle cloud driven by independent per-particle noise comes apart into
// confetti; driven by a coherent field, neighbours move like neighbours and the
// ribbon through them stays a ribbon while it billows.
//
// WHY NOT ACTUAL PARTICLES. entities/particles.js is one draw call for every
// particle in the game and it has a hard rule — a burst's colour is its
// emitter's and nobody else's, because a burst's colour is how you know what
// KIND of event it was. Three per-channel palettes fighting that rule is
// exactly the rainbow the rule exists to prevent. It is also a GPU system with
// no per-frame CPU position, and a ribbon has to be threaded through points
// somebody knows the coordinates of.
//
// Geometry is allocated once and rewritten in place — this runs every frame of
// every breach and for a second or two after each one.
//
// THE MACHINERY IS systems/ribbonTrail.js, and everything in the paragraphs
// above is a description of it: the particle spine, the turbulence, the
// centripetal spline through the cloud, the fold guard, the shaded
// cross-section, the channel split. It lived in this file until the Blubberball
// needed the same trail (systems/ballTrail.js) and moved out whole. WHAT IS
// LEFT HERE IS THE PART THAT IS ABOUT A SEAL: the two profiles below, where the
// plumes come out of, when each gate is open, and what a strike wind-up does to
// them.
// ============================================================================

// ============================================================================
// TWO TRAILS, ONE ALGORITHM — the profiles.
//
// The seal drags a ribbon in the air and a ribbon through the water, and they
// are the same effect photographed under different conditions:
//
//   air    three channels, pure R/G/B, split apart by `channelTrail` and
//          `channelSpread` and summing back to white where they overlap. A
//          blown-out highlight. This is the original, and nothing about it has
//          changed.
//   water  ONE channel, white. Water does not blow a sensor out; there is no
//          aberration to photograph, so the split would be a rainbow drawn on
//          purpose — exactly what CONFIG.emitters' palette rule exists to
//          prevent. What is left is the thing underneath the split: the core
//          and the halo, which is the glowing line.
//
// Everything else — the particle cloud, the turbulence, the centripetal spline,
// the fold guard, the cross-section shader, the fin anchors, the strand
// boundaries, the taper — is shared, because all of it is about how a ribbon
// through a drifting cloud is drawn and none of it is about which medium the
// cloud is in. A profile is a SETTINGS BLOCK, not a second implementation:
// CONFIG.breachTrail.water names only what differs and inherits the rest, so a
// fix to the ribbon is a fix to both and there is no second copy to drift.
//
// THE CHANNEL COUNT IS THEREFORE READ OFF THE COLOURS, not a constant. One
// colour is one ribbon, and the split arithmetic collapses to zero offset on
// its own — `(ch - (n-1)/2)` is 0 when n is 1 — so the white trail needs no
// special case anywhere in the draw loop.
//
// SEPARATE SCENE ROOTS, one per profile, and that is deliberate rather than
// tidy: the two clouds have different lifetimes and different gates, and
// anything asking "what is the breach trail doing" (the harness, perf logging)
// must not be handed a swim trail in the same answer.
// ============================================================================

const profiles = {
  air: createRig('air', 'breachTrail'),
  water: createRig('water', 'swimTrail'),
};
const PROFILE_LIST = [profiles.air, profiles.water];

// The water profile's numbers, rebuilt in place each frame. It is the air block
// with `breachTrail.water` laid over it, so the water trail inherits every knob
// it does not name — which is what makes this two settings blocks rather than
// two effects. Assembled fresh rather than cached because every value in it is
// a live tuner slider, and a cache would freeze the water trail at whatever the
// air one happened to be at load.
const _water = {};

function cfg(key = 'air') {
  const base = CONFIG.breachTrail ?? {};
  if (key !== 'water') return base;
  return Object.assign(_water, base, base.water ?? {});
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// THE WIND-UP, and it is a TELEGRAPH before it is an effect.
//
// A charging strike is the one moment the player has committed to something the
// water around them has not been told about yet, and the trail is the loudest
// thing they own — so it is what should say it. The longer the hold, the more
// of it: the plume reaches further, swells, and burns brighter, all off the
// same banked power the strike itself is priced on.
//
// A THIRD SETTINGS LAYER, applied over whichever profile is drawing. Not a
// profile of its own: a wind-up in the air and a wind-up underwater are the
// same tell, and the trail it is boosting is already the right one for where
// the seal is. So this multiplies rather than replaces, and the air trail's
// wind-up is still an RGB split while the water one is still white.
//
// It ends by simply stopping. On release `wind` drops to zero and every number
// here goes back to 1 for the NEXT particle — but the long, bright, wide ones
// already laid down keep the life and the ramp stamped on them at birth, so the
// telegraph does not vanish on the release frame. It blooms outward and dies on
// its own clock while the dash is happening, which is the release read.
//
// Written into a copy, never onto CONFIG. `c` for the air profile IS
// CONFIG.breachTrail, and multiplying its `life` in place would ratchet the
// stored value up every frame of every hold until the tuning file was ruined.
const _boosted = { air: {}, water: {} };

function withCharge(c, key, wind) {
  const b = CONFIG.breachTrail?.charge ?? {};
  if (!(wind > 0) || b.enabled === false) return c;
  const o = Object.assign(_boosted[key], c);

  // The two that make it "more trail": more particles a second, each living
  // longer. Rate is what makes it denser, life is what makes it REACH — the
  // cloud's length is its lifetime, not a number of points (see `life` in
  // CONFIG.breachTrail), so this is the one that extends the plume out behind
  // the animal.
  const rateMul = lerp(1, b.rate ?? 1.9, wind);
  const lifeMul = lerp(1, b.life ?? 2.2, wind);
  o.emitPerSecond = (c.emitPerSecond ?? 60) * rateMul;
  o.life = (c.life ?? 1) * lifeMul;

  // BRIGHTNESS HAS TO COME THROUGH `glow` AND NOT THROUGH THE RAMP. The ramp
  // is clamped to 1 where intensity is worked out in resampleSpine, so pushing
  // it harder does nothing at all once a hold is past its first fraction —
  // which would look exactly like the boost not being wired up.
  o.glow = (c.glow ?? 1) * lerp(1, b.glow ?? 1.8, wind);
  o.width = (c.width ?? 1) * lerp(1, b.width ?? 1.3, wind);
  o.blowOut = (c.blowOut ?? 0) * lerp(1, b.blowOut ?? 1.5, wind);

  // THE CEILING HAS TO MOVE WITH THEM, and this is the line the whole effect
  // fails silently without. `wantNodeCap` is rate x life clamped by `maxNodes`,
  // and both multipliers are already at their ceiling on the shipped numbers —
  // so a boost that raised the rate and the life but not the cap would emit
  // every extra particle and immediately pop it off the end of the list. The
  // trail would be no longer, only churnier, and nothing would say why.
  o.maxNodes = Math.min(HARD_MAX_NODES,
    Math.ceil((c.maxNodes ?? 100) * rateMul * lifeMul));

  // `samples` is deliberately NOT boosted. It is the geometry's rib count, and
  // changing it rebuilds the plume — see the rebuild test in runRibbon. Charge
  // climbs continuously through a hold, so scaling it here would dispose and
  // reallocate two BufferGeometries every frame the player is winding up.
  return o;
}
/**
 * Rebuild both trails for this frame.
 *
 * @param dt      real seconds — the cloud is weather, and a hit-stop must not
 *                stall it mid-billow.
 * @param scene
 * @param player  read for position, velocity and height only
 * @param ramp    the live air ramp (systems/airborne.js) — stamped onto each
 *                particle at birth, which is what makes a long hang leave a
 *                visibly hotter trail than a skim. The AIR trail's; the water
 *                trail stamps its own speed ramp, see below.
 * @param emitting whether the seal is actually swimming or flying right now, as
 *                opposed to merely being somewhere. Drifting and dying happen
 *                regardless — that is the point of running outside the pause
 *                gate — but laying down new particles must not. A seal frozen
 *                mid-arc behind the level-up cards is not moving, so eighty-five
 *                particles a second would all be born at the same coordinates
 *                and stack into one bright blob; the same goes for a corpse on
 *                its way down through the death dive.
 * @param charge  banked strike power, 0..1, or 0 when no strike is being wound
 *                up. THE TELEGRAPH — see withCharge. Defaulted, so every caller
 *                that predates it (the harnesses, tools/looks) behaves as it did.
 */
export function updateBreachTrail(dt, scene, player, ramp = 0, emitting = true, charge = 0) {
  const base = CONFIG.breachTrail ?? {};
  if (!base.enabled) {
    if (profiles.air.root || profiles.water.root) clearBreachTrail(scene);
    return;
  }

  // Measured off the POSITION rather than read off `player.aboveSurface`, and
  // that is not a stylistic preference: the flag is written by updatePlayer,
  // and updatePlayer stops running the moment the seal dies. A run that ended
  // mid-breach would leave the flag stuck true, and this function — which
  // deliberately runs outside the pause and run gates so the cloud can finish
  // dying — would keep emitting from a body that is now sinking through the
  // death dive. The position cannot lie about where the seal is.
  const airborne = player.mesh.position.y > bounds.surfaceY;
  const vx = player.velocity?.x ?? 0;
  const vy = player.velocity?.y ?? 0;
  const speed = Math.hypot(vx, vy);

  // Shared scratch, and both profiles read it in this frame before anything can
  // change it — so it is fetched once rather than per profile.
  const tips = tipsFor(player);

  // The wind-up, 0..1. See withCharge for what it does to a profile.
  const boost = base.charge ?? {};
  const wind = boost.enabled === false ? 0 : Math.min(1, Math.max(0, charge || 0));
  // What the hold asserts as a floor under the drive, independent of speed —
  // see the water gate below for why a wind-up needs one at all.
  const windDrive = wind * (boost.rampFloor ?? 1);

  // --- THE AIR TRAIL ---------------------------------------------------------
  // Exactly as it was: it exists for as long as the seal is above the line, at
  // a flat rate, carrying the air ramp — plus the wind-up on top, because a
  // strike charged mid-arc is the same tell as one charged in the water.
  runRibbon(profiles.air, dt, scene, tips, withCharge(cfg('air'), 'air', wind), {
    active: airborne,
    emitting,
    rate: 1,
    nodeRamp: Math.max(ramp, windDrive),
    vx,
    vy,
  });

  // --- THE WATER TRAIL -------------------------------------------------------
  // SPEED-GATED AND RAMPED, exactly the way the tail-fin bubble wake is
  // (systems/bubbles.js) and for the same reason: below `minSpeed` the flippers
  // are not working hard enough to leave anything, and switching on at full
  // strength at the threshold would pop rather than fade.
  //
  // The ramp does two jobs at once. It scales the EMISSION RATE, so a faster
  // seal lays a denser cloud; and it is stamped on each particle in place of
  // the air ramp, so it also scales BRIGHTNESS through the same `intensity`
  // term the air trail uses for hang time. One number, and the trail gets
  // thicker and hotter together the way a wake does.
  const w = cfg('water');
  const minSpeed = Math.max(0, w.minSpeed ?? 8);
  const full = Math.max(minSpeed + 0.01, w.fullSpeed ?? CONFIG.player?.maxSpeed ?? 34);
  const wRamp = Math.min(1, Math.max(0, (speed - minSpeed) / (full - minSpeed)));

  // THE WIND-UP HAS TO OPEN THE GATE, and this is the whole reason the boost is
  // not simply a multiplier on what was already being drawn.
  //
  // A strike wind-up is a BRAKE TO A STANDSTILL — holding seals the mouth, so
  // you stop and commit — which is precisely the state this gate exists to shut.
  // Left speed-gated, the telegraph would be silent for every wind-up taken the
  // way wind-ups are actually taken, and would only ever show on the rare one
  // charged mid-swim. systems/bubbles.js has the identical problem with the
  // identical answer: see the vent there, which gives the charge its own path
  // for exactly this reason rather than scaling the wake.
  //
  // So the charge SUBSTITUTES for speed. It opens the gate, and it drives the
  // trail at whatever a hold of that depth is worth — a seal that has stopped
  // dead and banked a full charge draws the same intensity as one at top speed,
  // which is the right claim to make about it.
  const openedByWind = windDrive > 0 && (boost.openGate ?? true);
  const drive = Math.max(wRamp, openedByWind ? windDrive : 0);
  runRibbon(profiles.water, dt, scene, tips, withCharge(w, 'water', wind), {
    // NOT `!airborne` alone. A seal drifting to a stop underwater has to close
    // its strand, or the next burst of speed is joined to this one by a ribbon
    // drawn straight across everything in between.
    active: w.enabled !== false && !airborne && (speed >= minSpeed || openedByWind),
    emitting,
    rate: drive,
    nodeRamp: drive,
    vx,
    vy,
  });
}

// ONE PLUME PER TAIL FIN.
//
// The trail used to come out of the seal's origin, which is inside its ribcage
// — so the brightest thing on screen was welded to the middle of the animal and
// the two surfaces actually doing the work were unlit. A breaching seal drives
// with its hind flippers, and those are the tips a wake should shed from
// (systems/bubbles.js already sheds its own off exactly the same two anchors).
//
// Two emission points means two INDEPENDENT clouds, not one cloud fed from two
// places. That distinction is forced: the spine is a polyline through particles
// in birth order, so interleaving two emitters into one list makes every
// consecutive pair jump from one flipper to the other, and the ribbon threaded
// through it is a zigzag between the fins rather than two trails. Each plume
// therefore owns its particles, its geometry and its own strand counter.
//
// ...and one set of plumes PER PROFILE on top of that, so the air trail and the
// water trail are four independent clouds in all. See the profiles above.

/**
 * WHERE THE TRAIL COMES OUT OF: the hind flipper tips, which on a seal are the
 * tail fins and the surfaces actually driving the breach.
 *
 * `anchors.finL/finR` are published by systems/aimRig.js from the outermost
 * skinned vertex of each hind flipper, just past the trailing edge of the
 * webbing — the same two points systems/bubbles.js sheds its wake from, so the
 * two effects agree about where the animal ends.
 *
 * Degrades in the order fins -> the tail anchor -> the body origin, so a model
 * with no rig at all (and any caller passing a hand-built player, which the
 * harness does) still gets a single plume rather than nothing.
 */
const _tips = [];
function tipsFor(player) {
  _tips.length = 0;
  const rig = player.aimRig;
  if (rig?.anchors?.finL) _tips.push(rig.anchors.finL);
  if (rig?.anchors?.finR) _tips.push(rig.anchors.finR);
  if (!_tips.length && rig?.anchors?.tail) _tips.push(rig.anchors.tail);
  if (!_tips.length) _tips.push(player.mesh.position);
  return _tips;
}

/** Tear both trails down — run start, and whenever the effect is switched off. */
export function clearBreachTrail(scene) {
  for (const profile of PROFILE_LIST) clearRig(profile, scene);
}

// THE READOUTS BELOW DEFAULT TO THE AIR TRAIL, and that is the contract rather
// than a convenience. Everything that asks these questions — the harness, perf
// logging — is asking about the breach, and folding a swim trail into the same
// number would make "the cloud is gone" quietly mean "the cloud is gone unless
// the seal happens to be moving". Pass 'water' to ask about the other one.
function plumesOf(key) {
  return (profiles[key] ?? profiles.air).plumes;
}

/** How many particles are alive. For the harness, and for perf logging. */
export function breachTrailCount(key = 'air') {
  let n = 0;
  for (const p of plumesOf(key)) n += p.nodes.length;
  return n;
}

/**
 * Every live particle's position, newest first, as flat [x, y] pairs.
 *
 * For the harness only. It exists because the drawn geometry is NO LONGER the
 * particles — it is a Catmull-Rom curve resampled far more densely than they
 * are — so reading vertex positions to find out where the cloud is measures the
 * spline's opinion rather than the simulation's. Anything asking "did the
 * particles move" has to ask the particles.
 */
export function breachTrailNodes(key = 'air') {
  const out = [];
  for (const p of plumesOf(key)) for (const n of p.nodes) out.push([n.x, n.y]);
  return out;
}

/**
 * The cloud's state as three numbers, for the harness and for perf logging.
 * See rigStats in systems/ribbonTrail.js for why the SPEED is reported rather
 * than left to be inferred from two frames of positions.
 */
export function breachTrailStats(key = 'air') {
  return rigStats(profiles[key] ?? profiles.air);
}
