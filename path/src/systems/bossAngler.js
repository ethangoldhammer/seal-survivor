import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { activeBossPerk } from './bossPerks.js';
import { attachEmissiveCues, resetEmissiveCues } from './emissivePulse.js';
import { faceSide } from './facing.js';
import { spawnBeam } from './beams.js';
import {
  makeOrganicRing, placeOrganicRing, updateOrganicRing, disposeOrganicRing, threatColor,
} from './organicRing.js';
import { feedback } from './feedback.js';

// ---------------------------------------------------------------------------
// THE ANGLERFISH — the boss that waits.
//
// The shark chases. The orca chases faster. The kraken holds mid-range and
// blinds you. Every one of them decides when the fight happens. This one does
// not: it holds station with its lure lit and makes the PLAYER choose, which
// is the verb the roster did not have.
//
// WHY IT IS A SYSTEM AND NOT A PERK — the kraken's answer, and the same one.
// Perks are things a boss HAS: rolled from a table, interchangeable, and a
// shark with a lunge is still a shark. Waiting is what this one IS. It comes
// with a body built for it (an 8s ambush take with the jaw cranked past its
// rest gape), a light that says what it is about to do, and a cadence you are
// meant to learn. It still rolls one ordinary perk on top, which is what keeps
// two anglerfish fights from being the same fight.
//
// ---------------------------------------------------------------------------
// THE CADENCE, and what each stage is telling you
// ---------------------------------------------------------------------------
//
//   lurk      Station-keeping, `idle` -> the `trap` take, lure throbbing low.
//             It will sit here indefinitely if you stay out of `triggerRange`.
//             That is the whole proposition: the fight starts when you say so.
//   windup    You came inside the range. It turns to face you, fires the `bark`
//             one-shot (`swim_start`, the file's own gather-yourself take), and
//             the lure ramps to its peak over exactly `windup` seconds.
//   lunge     It commits along the line locked at the END of the wind-up, at
//             `boost` (`swim2`, 2.4x the cruise), hitting far harder on
//             contact. The light is held bright for exactly as long as the body
//             is dangerous.
//   snap      The `bite` one-shot at the end of the run, whether or not it
//             connected. This is a predator closing its mouth, not a hit
//             confirm — selling the miss is most of what makes the dodge feel
//             like a dodge.
//   recover   It coasts, `swim` -> `swim1`, and the lure goes OUT. This is the
//             punishable window and the two are deliberately the same event: a
//             dark anglerfish is a safe one, which is a rule a player can learn
//             in a single fight without being told it.
//
// ...AND THE SECOND CADENCE, for a player who will not come down to it:
//
//   charge    The lure ramps over `chargeTime` with a ring swept on around it,
//             and the animal never leaves the seabed. Longer than the lunge's
//             wind-up because the lunge is a body moving — which reads from
//             anywhere on screen — and this is a light on a motionless fish
//             that may be forty units away.
//   pulse     The radial, if the seal is inside `pulseRadius` of the lure. Very
//             little damage and a SNARE: the seal's own swimming is cut to a
//             fraction of itself for about a second. It is not how this boss
//             kills you. It is how it stops you leaving, and what kills you is
//             whatever else is in the water while you cannot swim.
//   beam      The electric line, if the seal is further out than that. Aimed
//             from the esca along a direction locked at the end of the charge
//             and never steered afterwards; the big damage number in the fight,
//             and the answer to standing off at range shooting down at it.
//   discharge The follow-through, dark, and the window to close the distance in.
//
// WHICH OF THE TWO IT THROWS IS THE DISTANCE AND NOTHING ELSE — no roll, no
// alternation. Three ranges, three answers, and a player learns them by
// standing in the wrong one. A random pick would make the same position mean
// two things, which is the one thing a fight built entirely out of reading the
// animal cannot afford.
//
// AND IT HOLDS THE BOTTOM. The lurk settles onto the floor and every station it
// picks is on the floor, which is what makes the arena vertical: the surface is
// safe, the trap is the seabed, and a run is spent deciding how far down to go.
// The two lure attacks exist BECAUSE of that — an ambusher pinned to the bottom
// with only a melee lunge is a boss you beat by floating out of reach.
//
// THE LINE IS LOCKED AT THE END OF THE WIND-UP, not steered during the lunge —
// the lunge perk's rule, for the lunge perk's reason. A homing ambush is not a
// fight, it is a damage race with extra steps. The counterplay has to be real:
// read the light, move sideways, watch it commit to where you were.
//
// THE TELL IS ON THE ANIMAL. Every other boss telegraphs with a threat ring
// drawn on the water, because its body has nothing to say with. This one
// arrived with an emissive atlas that already paints the esca and two rows of
// photophores down its flank, so the light lives on the creature. See
// CONFIG.emissiveCues for the envelopes and systems/emissivePulse.js for why
// the materials have to be per-instance.
//
// ---------------------------------------------------------------------------
// TWO THINGS THIS FILE DOES NOT DO
// ---------------------------------------------------------------------------
//
//   IT DOES NOT DEAL DAMAGE ITSELF. Every point of both lure attacks goes out
//   through `hooks.onPlayerHit`, which is main.js's — so both pass the seal's
//   i-frames, are trimmed by the boss damage ceilings (capBossDamage in
//   systems/boss.js, which is keyed on a source string starting with "boss"),
//   and are recorded by the playtest ledger under their own names. A boss
//   attack that subtracted hp directly would be invisible to all three.
//
//   IT DOES NOT OWN THE BEAM. systems/beams.js does, and this fires one the
//   same way the eye-beam perk does — the boss's line and the seal's Laser Eyes
//   are one object pointed in opposite directions, down to the per-target
//   cooldown that stops a persistent hazard dealing its damage sixty times a
//   second.
//
//   IT DOES NOT DECIDE WHAT ANIMATION MEANS. Which clip a state resolves to is
//   ASSETS.enemyBossAnglerfish.animations, in assets.js with the rest of the
//   data. This file names STATES; a re-export that renames a take is one line
//   there and nothing here.
// ---------------------------------------------------------------------------

export function isAnglerBoss(e) {
  return !!e?.def?.ambushBoss;
}

const cfg = () => CONFIG.boss?.angler ?? {};

// HOW AN AMBUSHER AIMS WITHOUT MOVING.
//
// `faceMotion` in entities/enemies.js only writes `mesh.rotation.z` when the
// body is travelling faster than 0.05 u/s — below that it declines, and the
// heading simply stays where it was. For every other creature that is correct:
// a drifting fish has no opinion about which way it points. For this one it is
// the whole problem, because the animal spends most of the fight at a dead
// stop and must still be looking at you — an anglerfish aiming its lure
// somewhere else is not a trap, it is scenery.
//
// The first version of this file solved it by creeping toward the player fast
// enough to clear that 0.05 gate. That works, and it is why the boss slowly
// swam at you for the whole fight and never actually held station.
//
// So the ambush writes the heading itself, and the 0.05 gate becomes the
// HANDOFF rather than an obstacle: below it this function owns the facing,
// above it (the lunge, the reposition) enemies.js does, and the two can never
// both be writing on the same frame. Eased at `turnRate` rather than snapped,
// so the turn onto you is a thing you can watch happen — which is half the
// tell.
function faceToward(e, dx, dy, dt, turnRate) {
  if (!e.mesh) return;
  const rate = Math.max(0.01, turnRate);

  // TWO ROTATIONS, AND THEY ARE ONE MANOEUVRE. Getting that wrong is what put
  // this animal on its back, and it went wrong twice for two different reasons.
  //
  // THE FIRST VERSION WROTE ONLY THE HEADING. `rotation.z` points the NOSE, and
  // aiming a nose that starts pointing right at something on the left is 180
  // degrees in the plane of the screen — which puts the dorsal exactly where
  // the belly was. Measured on the shipped fish with the seal to its left:
  // dorsal 180.0 degrees off vertical, for the whole time it was lurking.
  // `faceMotion` in entities/enemies.js never had that problem because it
  // writes the heading AND calls faceSide; this function was written to take
  // the facing off it below its 0.05 u/s gate and reproduced only the first
  // half. Half of a two-part transform is not a subset of it.
  //
  // THE SECOND VERSION ADDED THE ROLL AND RACED IT. faceSide eases the side
  // over CONFIG.facing.time — 0.4s — while the heading eases at `turnRate`,
  // 0.9 rad/s at the lurk, which is 3.5 seconds for the same half turn. So the
  // body finished rolling nearly three seconds before the nose came round, and
  // spent the gap upside down: 173.8 degrees at worst, measured over a fight.
  // Two eased values that describe one turn have to be driven by one clock.
  //
  // SO THE DECOMPOSITION IS THE SIDE-ON ONE, and it makes the animal upright by
  // construction rather than by timing:
  //
  //   THE SIDE is a YAW about world up (rotation.y on the visual, which is the
  //   model's own forward axis). A fish turning round in place swims a
  //   horizontal U-turn; on this camera that is a rotation through
  //   pointing-at-the-lens, and the dorsal stays up through every frame of it.
  //
  //   THE PITCH is what is left: how far above or below the target is, measured
  //   INSIDE whichever half-plane it is in (`Math.abs(dx)`), so it is bounded
  //   at +-90 degrees and can never carry the body past vertical. That bound is
  //   the guarantee — the dorsal works out to (-sin p, cos p), and cos p is
  //   positive for every pitch in range, whichever side the yaw has settled on.
  //
  // The yaw is given `PI / rate` seconds, which is exactly how long this turn
  // rate would take to sweep a half turn — so the two stay in step at every
  // speed the fight asks for, and `lurkTurnRate` still means what it says
  // (slow, so a player circling wide can get behind it).
  let frac = 0;
  if (CONFIG.view === 'side' && e.visual) {
    const face = faceSide(e.visual, dx, dt, { time: Math.PI / rate });
    frac = Math.min(1, Math.max(0, face.at / Math.PI));
  }

  // The heading the pitch and the settled side agree on. Blended by the SAME
  // eased fraction the yaw is using rather than switching on the side's sign:
  // switching would step the target by most of PI on the frame the seal crosses
  // vertical, and the ease below would then chase a discontinuity — which is
  // the snap, arriving from the other direction.
  // THE RATE LIMIT GOES ON THE PITCH, NOT ON THE FINISHED HEADING, and that is
  // the difference between a body that is upright by construction and one that
  // is upright when the numbers happen to agree.
  //
  // Rate-limiting the composed heading was the third version of this and it was
  // still wrong: `frac` is eased with an inOutCubic, which runs at twice its
  // average rate through the middle of the turn, so the target outran a heading
  // capped at the average and the body sat at the difference — 134 degrees off
  // vertical at worst, measured. A cap that the thing it is chasing is allowed
  // to exceed is not a cap.
  //
  // The pitch is a bounded quantity (+-90 degrees) that only has to follow the
  // seal, so capping IT is what `turnRate` was always describing: how fast the
  // animal can re-aim. The heading is then composed from two already-smooth
  // values and is never chased at all.
  const wantPitch = Math.atan2(dy, Math.abs(dx));
  // Seeded outright the first time, or a fresh arrival opens the fight sweeping
  // its nose up from wherever the number happened to start.
  if (e.__facePitch == null) e.__facePitch = wantPitch;
  const dp = Math.max(-rate * dt, Math.min(rate * dt, wantPitch - e.__facePitch));
  e.__facePitch += dp;
  const pitch = e.__facePitch;

  e.mesh.rotation.z = (1 - frac) * (pitch - Math.PI / 2) + frac * (Math.PI / 2 - pitch);

  // WHO OWNS THE FACING THIS FRAME, declared by the frame that wrote it rather
  // than inferred from a speed. `faceMotion` gives up below 0.05 u/s, and that
  // gate used to be the whole handoff — safe while the ambush was a literal
  // dead stop, and wrong the moment it started settling onto the seabed at up
  // to 3.4 u/s. Both writers were then live on the same frames: this one aiming
  // at the seal, faceMotion aiming at the fish's own vertical drift, each
  // overwriting the other every frame. That is the other half of the snapping.
  //
  // Cleared at the top of the stage machine, so a stage that does not call this
  // hands the facing straight back — which is what the lunge and the recovery
  // want, because there the animal genuinely is going somewhere.
  e.faceLocked = true;
}

// ---------------------------------------------------------------------------
// WHERE IT IS ALLOWED TO WAIT
// ---------------------------------------------------------------------------
// A station is picked as a point `stationRange` from the PLAYER, and nothing
// about that says it is a point in the ocean: with the seal near a wall, most
// of the ring is out past the rock. The fish then drives at a target it can
// never reach — the arena clamp in entities/enemies.js holds it at
// `bounds.right - radius` while the recovery runs out — and the cycle ends
// with the animal parked inside the cliff, which is where it stays, because a
// lurking anglerfish is a dead stop by design.
//
// That is also how it arrives: the entrance hands over the moment the body is
// fully inside the wall (see the `entering` clear in entities/enemies.js), so
// an anglerfish that swims in from a wing is at x = wall - radius on the frame
// it becomes a boss. Every other boss immediately swims at you and leaves;
// this one holds station, so it holds THAT one — half buried in the rock,
// out of reach until the player swims into the wall themselves.
//
// So a station is clamped into water the animal can actually occupy, and the
// margin is a BODY on top of the radius: an ambusher whose flank is inside the
// scenery is not hiding, it is stuck.
function stationMargin(e) {
  const c = cfg();
  return (e.radius ?? 0) * (1 + (c.wallMargin ?? 0.35));
}

function clampStation(e, x, y) {
  const m = stationMargin(e);
  // Vertically too, and for the same reason: a caller is free to hand this a
  // point above the waterline, and the arena clamp would then hold the fish
  // flat against the surface for the whole recovery — the horizontal bug stood
  // on its end. The recovery's own station does not come through here (it is a
  // floor station, which is deliberately below this margin — see floorY); this
  // is the general clamp, and the lurk's wall-escape is what still uses it.
  const loY = bounds.bottom + m;
  const hiY = bounds.surfaceY - m;
  return {
    x: Math.max(bounds.left + m, Math.min(bounds.right - m, x)),
    y: loY > hiY ? (bounds.bottom + bounds.surfaceY) / 2 : Math.max(loY, Math.min(hiY, y)),
  };
}

// Is the body in a WALL right now? Asked with a little slack over the margin so
// an animal that has just eased off one is not immediately judged to be on it
// again, which would leave it drifting on the spot.
//
// THE SIDE WALLS ONLY, and the two it leaves out are left out on purpose. The
// waterline is not scenery — clampBelowSurface holds every swimmer under it and
// a fish waiting just below the surface is waiting somewhere real. And the
// seabed is where this animal is SUPPOSED to be able to sit (see floorY): a
// lurk that fled the floor would fight the floor hold every frame, at the
// cruise speed, which is the opposite of an ambush.
function againstScenery(e) {
  const m = stationMargin(e) * 0.9;
  const p = e.mesh.position;
  return p.x < bounds.left + m || p.x > bounds.right - m;
}

/**
 * Drift toward `anglerState.station` at the cruise, and report whether it has
 * arrived. Shared by the recovery (which relocates on purpose) and by a lurk
 * that has found itself in the rock (which relocates because it must) — one
 * mover, so the two can never disagree about how the animal repositions.
 */
function driftToStation(e, dt, c, dx, dy, hasPlayer) {
  const st = anglerState.station;
  if (!st) return true;
  const sx = st.x - e.mesh.position.x;
  const sy = st.y - e.mesh.position.y;
  const sd = Math.hypot(sx, sy);
  if (sd > 0.4) {
    const sp = c.repositionSpeed ?? (e.def.speed ?? 4.2);
    e.vx = (sx / sd) * sp;
    e.vy = (sy / sd) * sp;
    return false;
  }
  e.vx = 0; e.vy = 0;
  if (hasPlayer) faceToward(e, dx, dy, dt, c.lurkTurnRate ?? 0.9);
  return true;
}

// ---------------------------------------------------------------------------
// THE BOTTOM
// ---------------------------------------------------------------------------
// The line the animal rests on between attacks, and the reason it is measured
// off `bounds.bottom + radius` rather than off seabedTopY().
//
// clampVertical in entities/enemies.js will not let ANY creature below
// bounds.bottom + its own radius. This body's radius is 7.9 world units and the
// drawn seabed strip is 1.2 tall, so a hover expressed as "N units above the
// sand" would name a height six units under a clamp that is going to overrule
// it — the fish would rest at the clamp, and the number would be describing
// nothing. Measured off the clamp instead, so "on the bottom" is the same fact
// to the hold and to the thing enforcing it.
//
// DELIBERATELY BELOW clampStation'S VERTICAL MARGIN, which holds a station a
// body and a third clear of every boundary. That margin is right for a station
// picked at an arbitrary angle around the player, which can land anywhere
// including against the ceiling; it is wrong for the one boundary this animal
// is supposed to be sitting on. So the floor station clamps its x through the
// shared margin and takes its y from here.
function floorY(e, c) {
  return bounds.bottom + (e.radius ?? 0) + (c.floorLift ?? 0.6);
}

// A station on the seabed, `stationRange` to one side of the seal. Horizontally
// clamped by the shared wall margin (an ambusher inside the rock is stuck, not
// hidden); vertically it is the floor, which is where it is trying to be.
function floorStation(e, c, x) {
  const m = stationMargin(e);
  return {
    x: Math.max(bounds.left + m, Math.min(bounds.right - m, x)),
    y: floorY(e, c),
  };
}

// SETTLING ONTO IT, not falling onto it. Eased rather than driven at a fixed
// speed so the last unit is slow — an animal that arrives at its resting height
// at full speed and stops dead reads as having hit something.
//
// THE ENTRANCE OUTRANKS IT. While `deep` is set the body is still climbing out
// from under the seabed and entities/enemies.js is pushing it up on the
// POSITION; a sink written into the velocity there does not stop the climb (the
// entrance is a floor under it, so a negative vy makes it push harder) but it
// does mean the animal fights its own arrival all the way up. It holds still
// and lets the entrance finish, then settles.
function holdFloor(e, dt, c) {
  if (e.deep || e.entering) { e.vx = 0; e.vy = 0; return; }
  e.vx = 0;
  const gap = floorY(e, c) - e.mesh.position.y;
  if (Math.abs(gap) < 0.05) { e.vy = 0; return; }
  const sp = Math.max(0, c.floorSink ?? 3.4);
  e.vy = Math.max(-sp, Math.min(sp, gap * (c.floorEase ?? 1.8)));
}

// ---------------------------------------------------------------------------
// SAYING IT OUT LOUD
// ---------------------------------------------------------------------------
// `e.telegraph` is 0..1 through whichever tell is running, and 0 the rest of
// the time. It is the channel systems/bossEyes.js reads to light the animal's
// eyes through a wind-up — a plain field rather than an import, so the eyes
// know about "a boss is winding something up" and never about this fight.
//
// IT IS A PROGRESS, NOT A FLAG, and that is the difference between the two
// tells the eyes can now show. A perk publishes only "winding up", so the eyes
// ease a hardcoded ramp onto a flag and the shape is the ease's. Both of this
// animal's tells know exactly how far through they are, so the eyes can build
// with them and land on full at the frame the thing fires — the same promise
// CONFIG.emissiveCues.windup.attack makes to the lure, kept by the same clock.
function tell(e, total) {
  const t = Math.max(0.001, total);
  e.telegraph = Math.min(1, Math.max(0, 1 - anglerState.timer / t));
}

// ---------------------------------------------------------------------------
// THE LURE
// ---------------------------------------------------------------------------
// Where the light actually is. Both lure attacks are born at the esca and not
// at the middle of the animal: the silhouette is a long rod with a bulb on the
// end, and a beam leaving its belly is one the player cannot connect to the
// thing that was glowing at them.
//
// WORLD POSITION, so the pose is in it. The illicium is being animated every
// frame and its rest offset is nowhere near where the tip currently is — the
// same reason systems/bossPerks.js reads its eye sockets this way.
//
// Cached per creature, and a MISS CACHES NULL so a model without the node costs
// one traversal for the whole fight rather than one per frame. The fallback is
// the body centre: wrong, but on screen. A named bone that does not exist must
// not put the attack at the origin of the world.
const _lure = new THREE.Vector3();
function lureAt(e, c) {
  if (e.__lureNode === undefined) {
    const name = c.lureNode;
    e.__lureNode = (name && e.visual?.getObjectByName(name)) || null;
  }
  if (!e.__lureNode) {
    _lure.copy(e.mesh.position);
    return _lure;
  }
  e.__lureNode.getWorldPosition(_lure);
  // FLAT. The arena is a plane and the rod genuinely sits off it; a ring or a
  // beam born at the real z sorts behind the water and is simply not there.
  _lure.z = e.mesh.position.z;
  return _lure;
}

// ---------------------------------------------------------------------------
// THE TELEGRAPH RING
// ---------------------------------------------------------------------------
// The shared organic ring, with the shared threat palette deciding both colour
// and edge dialect — so the radial is the same blue as the player's own Chill
// and the beam's charge is the same cyan as their Voltaic, and both crackle or
// facet the way the palette says that kind of harm does. See
// systems/organicRing.js: there is one table, and a boss inventing its own
// colour for electricity is exactly what it exists to prevent.
//
// TWO SIZES FOR TWO SHAPES OF THREAT. The radial's ring is drawn AT
// `pulseRadius`, so the circle the player is looking at is the circle that is
// about to seize — a tell whose art is smaller than its reach is a lie the
// player pays for. The beam has no radius to draw, so its ring is a small one
// at the lure that says only "this is charging", and where it is pointed is
// told by the body turning.
function makeTell(kind, c) {
  const ring = makeOrganicRing({
    type: kind === 'pulse' ? 'chill' : 'electric',
    thickness: kind === 'pulse' ? 0.09 : 0.18,
    renderOrder: 6,
  });
  ring.visible = false;
  return ring;
}

function tellRadius(e, c) {
  return anglerState.attack === 'pulse'
    ? (c.pulseRadius ?? 13)
    : Math.max(1, (e.radius ?? 1) * 0.45);
}

function dropRing() {
  if (!anglerState.ring) return;
  // The ring's OWN parent, not a scene handed in. A stage can be left from a
  // path that has no scene to hand (the perk yield, a boss dying) and a ring
  // removed from the wrong parent is one that stays in the water.
  anglerState.ring.parent?.remove(anglerState.ring);
  disposeOrganicRing(anglerState.ring);
  anglerState.ring = null;
  anglerState.ringFade = 0;
}

export const anglerState = {
  fish: null,
  // 'lurk' -> waiting  |  'windup' -> the tell  |  'lunge' -> committed
  // 'snap' -> the bite  |  'recover' -> dark and punishable
  stage: 'lurk',
  timer: 0,
  // The line, locked when the wind-up ends. Published for the same reason
  // bossState and krakenState publish theirs: a decision taken inside one
  // frame is otherwise unobservable, and "the lunge went the wrong way" is not
  // something anyone can debug from the outside. tools/boss-angler-test.mjs
  // asserts on these.
  dirX: 0,
  dirY: 0,
  // The handle from attachEmissiveCues — per instance, so this boss's tell
  // does not light every anglerfish in the water.
  cues: null,
  // Restored when the lunge ends. Read off the saved base rather than
  // compounding, so an ambush interrupted by a perk and re-entered cannot
  // stack the multiplier.
  baseContact: 0,
  // How many full cycles this arrival has completed, for the harness.
  cycles: 0,
  // Where it is drifting to during the recovery, picked once per cycle.
  station: null,
  // Health FRACTION last frame, for the hurt flash. A fraction and not hit
  // points, for the kraken's reason: hp scales with difficulty, so a threshold
  // in points would fire on every scratch at level 30 and never at level 20.
  lastHpFrac: 1,
  // --- THE LURE ATTACKS -----------------------------------------------------
  // Which one is being wound up: 'pulse' (the radial hold) or 'beam' (the
  // electric line). Null outside a charge. Chosen when the charge STARTS rather
  // than when it fires, so the ring the player spent 1.25s reading is the
  // attack they actually get — picking at the end would let a player who
  // stepped back mid-charge be hit by the other one, which is a telegraph that
  // lies.
  attack: null,
  // The telegraph, and the seconds of fade left on it after the attack has
  // fired. Owned here rather than pooled: one ring at a time, ever.
  ring: null,
  ringFade: 0,
  // Seconds until the LURE may be used again. The lunge is not gated by it —
  // see the note on CONFIG.boss.angler.attackGap.
  cooldown: 0,
  // Where the seal was on the frame the attack fired. A copy and not the live
  // vector: fireLure runs inside the stage machine and the caller owns that
  // object, so holding a reference would mean the radial measured against
  // wherever the seal had got to by the time anything read it.
  playerAt: null,
  // What this arrival has actually thrown, for the harness and the debug panel.
  // Counted rather than inferred: "it never uses the beam" is otherwise a thing
  // nobody can see from outside a fight.
  fired: { lunge: 0, pulse: 0, beam: 0 },
};

export function releaseAngler() {
  const e = anglerState.fish;
  // Put back anything this file borrowed from the body. A boss that dies
  // mid-lunge would otherwise leave its contact damage multiplied on a def
  // object the NEXT arrival reads, and leave `animState` pinned so the corpse
  // holds a lunge pose.
  if (e) {
    if (anglerState.baseContact > 0) e.contactDamage = anglerState.baseContact;
    e.ramming = false;
    e.animState = null;
    e.perkDrive = false;
    // A boss killed mid-tell hands its eyes back dark, and the facing goes back
    // to entities/enemies.js. The stage machine stops running on the frame it
    // dies, so neither clear at the top of it ever comes — and a corpse left
    // with the facing locked is one nothing else can turn.
    e.telegraph = 0;
    e.faceLocked = false;
  }
  anglerState.cues?.release();
  anglerState.cues = null;
  anglerState.fish = null;
  anglerState.stage = 'lurk';
  anglerState.timer = 0;
  anglerState.baseContact = 0;
  anglerState.cycles = 0;
  anglerState.lastHpFrac = 1;
  anglerState.station = null;
  // The ring is a live scene object, so this is a dispose and not a flag reset:
  // a boss that dies mid-charge would otherwise leave its telegraph burning in
  // the water for the rest of the run, and its material leaked with it.
  // `e.visual` is the parent — the ring is added to the scene, so the scene it
  // came from is the one that has to take it back. Kept on the state for that
  // reason rather than being re-derived here.
  if (anglerState.ring) {
    anglerState.ring.parent?.remove(anglerState.ring);
    disposeOrganicRing(anglerState.ring);
    anglerState.ring = null;
  }
  anglerState.ringFade = 0;
  anglerState.attack = null;
  anglerState.cooldown = 0;
  anglerState.fired = { lunge: 0, pulse: 0, beam: 0 };
}

export function resetAngler() {
  releaseAngler();
  resetEmissiveCues();
}

export function attachAngler(scene, e) {
  releaseAngler();
  if (!isAnglerBoss(e)) return;
  anglerState.fish = e;
  anglerState.baseContact = e.contactDamage ?? 0;
  // The visual, not the enemy record — the materials hang off the model.
  anglerState.cues = attachEmissiveCues(e.mesh ?? e.visual ?? null);
  anglerState.stage = 'lurk';
  // Settled, not armed. A boss that arrives already able to strike gets its
  // wind-up over with while the player is still reading the banner, so the
  // first ambush of the fight — the one that teaches the tell — is the one
  // they never see.
  anglerState.timer = cfg().settle ?? 0.6;
  anglerState.cues?.hold('lurk');
}

// ---------------------------------------------------------------------------
// SPENDING THE CHARGE
// ---------------------------------------------------------------------------
// Both lure attacks leave from the esca along a line locked on this frame, and
// neither steers afterwards — the lunge's rule, for the lunge's reason. A
// homing beam is not a fight, it is a tax on having been seen. The counterplay
// has to be real: read the light, move, watch it commit to where you were.
//
// DAMAGE IS A MULTIPLE OF THIS BODY'S CONTACT DAMAGE, resolved here rather than
// typed in config, so both attacks ride the two ramps the rest of the roster
// rides (spawn.ramp.damage and the creature's own) and neither quietly stops
// mattering at minute eight. `baseContact` and not `e.contactDamage`: the lunge
// multiplies the live field, and reading it mid-lunge would compound.
//
// EVERY POINT GOES THROUGH hooks.onPlayerHit, which is main.js's — so both are
// held to the boss damage ceilings (capBossDamage), pass through the seal's
// i-frames, and are recorded by the playtest ledger under their own source
// names. A boss attack that subtracted hp itself would be invisible to all
// three, which is the shape the eye-beam perk's accounting bug had.
function fireLure(scene, e, dirX, dirY, hooks) {
  const c = cfg();
  const at = lureAt(e, c);
  const base = anglerState.baseContact || (e.def?.contactDamage ?? 0);
  anglerState.cues?.fire('zap');

  if (anglerState.attack === 'beam') {
    spawnBeam(scene, {
      x: at.x, y: at.y, dirX, dirY,
      length: c.beamLength ?? 150,
      width: c.beamWidth ?? 1.1,
      life: c.beamLife ?? 0.85,
      damage: base * (c.beamDamage ?? 1.35),
      tickEvery: c.beamTick ?? 0.3,
      // The shared palette, so this line and the player's Voltaic shots are one
      // substance seen from two ends. See threatType in systems/organicRing.js.
      color: threatColor('electric'),
      coreColor: c.beamCore ?? 0xdff8ff,
      hitsPlayer: true,
      // NOT hitsEnemies. It is tempting — a boss beam scything its own escorts
      // reads well — and it is a damage source the player did not fire, so
      // every kill it took would be credited to nobody and would still count
      // against the run's clear rate. The whale is the one thing in the game
      // allowed to remove creatures for free, and it is a relief valve by
      // design; this is an attack.
      hitsEnemies: false,
      // Prefixed `boss` because that is literally what isBossDamage tests for
      // in systems/boss.js — without it the beam escapes both damage ceilings
      // and a run can be ended between two frames by an attack that is supposed
      // to be survivable.
      source: 'boss:anglerBeam',
      // NO `follow`. A beam that tracked the head would sweep onto a player who
      // had already dodged it, which is the homing lunge wearing a different
      // hat. It burns exactly where it was aimed.
    });
    feedback('anglerBeam', { x: at.x, y: at.y });
    anglerState.fired.beam++;
    return;
  }

  // THE RADIAL. Measured from the LURE and against the same radius the ring was
  // drawn at — see tellRadius. The two have to be one number or the tell is
  // decoration.
  const r = c.pulseRadius ?? 13;
  feedback('anglerPulse', { x: at.x, y: at.y });
  anglerState.fired.pulse++;
  const p = anglerState.playerAt;
  if (!p) return;
  if (Math.hypot(p.x - at.x, p.y - at.y) > r) return;

  // CAUGHT. The damage is the small half of this and the hold is the point —
  // see CONFIG.boss.angler.pulseDamage. Fired in this order deliberately: the
  // hit may be refused outright by the seal's i-frames, and the grip should
  // still land. A radial that only holds you on frames you were not already
  // invulnerable is one that mysteriously does nothing during a dash.
  hooks.onPlayerSnare?.(
    c.pulseSnare ?? 1.05, c.pulseSnareMul ?? 0.12, c.pulseSnareThaw ?? 0.35,
  );
  feedback('anglerSnare', { x: p.x, y: p.y });
  hooks.onPlayerHit?.(
    base * (c.pulseDamage ?? 0.35),
    // Away from the lure, so the shove that rides on a hit throws the seal out
    // of the circle rather than in a direction the attack has no opinion about.
    { x: (p.x - at.x) / (Math.hypot(p.x - at.x, p.y - at.y) || 1),
      y: (p.y - at.y) / (Math.hypot(p.x - at.x, p.y - at.y) || 1) },
    'boss:anglerPulse',
  );
}

// One frame of the telegraph. `t` is 0..1 through the charge.
//
// PLACED EVERY FRAME rather than parented to the animal: `placeOrganicRing` is
// the only supported way to scale one (the shader's edge amplitude is divided
// by the world radius, so the scale and uRadius are a pair), and the lure moves
// under its own animation regardless of whether the body does.
function tickTell(dt, e, c) {
  const ring = anglerState.ring;
  if (!ring) return;
  const at = lureAt(e, c);
  placeOrganicRing(ring, at.x, at.y, tellRadius(e, c), e.mesh.position.z + 0.02);
  ring.visible = true;
  const total = Math.max(0.001, c.chargeTime ?? 1.25);
  if (anglerState.ringFade > 0) {
    // Spent. Fading rather than cut on the firing frame — the ring vanishing on
    // the same frame as the flash takes the reach off screen at the exact
    // moment the player wants to check whether they were inside it.
    anglerState.ringFade = Math.max(0, anglerState.ringFade - dt);
    const fade = Math.max(0.001, (c.dischargeTime ?? 0.55) * 0.5);
    updateOrganicRing(ring, dt, { opacity: anglerState.ringFade / fade, sweepIn: 1, charge: 1 });
    if (anglerState.ringFade <= 0) dropRing();
    return;
  }
  const t = Math.min(1, Math.max(0, 1 - anglerState.timer / total));
  // The sweep draws the circle ON over the charge, so how much of it exists is
  // how much of the wind-up has run — the tell says WHEN as well as WHERE, and
  // a ring that simply appeared would say only where.
  updateOrganicRing(ring, dt, { opacity: 1, sweepIn: t, charge: t });
}

/**
 * The cadence. GAME time and inside the run gate, like the kraken's — an
 * ambush is a fight mechanic and it has to stop when the fight does. A boss
 * that went on winding up behind the level-up cards would launch at a player
 * who never saw the tell.
 *
 * Runs AFTER updateBossPerks (see updateBossAbilities), which is what makes
 * the yield below correct rather than merely polite.
 */
export function updateBossAngler(dt, scene, playerPos, hooks = {}) {
  const e = anglerState.fish;
  if (!e || e.dead || !isAnglerBoss(e)) return;
  // The stage machine fires cues; the envelope is advanced once afterwards, so
  // anything fired this frame is on the material this frame. See the hurt note.
  stageMachine(dt, scene, e, playerPos, hooks);
  anglerState.cues?.update(dt);
}

function stageMachine(dt, scene, e, playerPos, hooks) {
  const c = cfg();

  // --- THE HURT FLASH -------------------------------------------------------
  // Read off the health here rather than from a damage callback, the way the
  // kraken reads its flinch: every path that hurts a boss already writes `hp`,
  // and hooking one of them would light the lure for that path only.
  //
  // BEFORE the envelope is advanced, not after. A cue fired below a completed
  // update() does not reach the material until the NEXT frame — one frame of
  // lag on a 30ms flash, which is a third of the whole thing and reads as the
  // hit not registering. Every cue this function fires is subject to the same
  // rule, which is why the stage machine below runs before the update too.
  const frac = e.maxHp > 0 ? Math.max(0, (e.hp ?? 0) / e.maxHp) : 1;
  if (anglerState.lastHpFrac - frac >= (c.hurtDamage ?? 0.02)) anglerHurt();
  anglerState.lastHpFrac = frac;

  // --- YIELD TO A PERK ------------------------------------------------------
  // A perk mid-lunge or mid-teleport owns the body. This file runs after
  // updateBossPerks, so without this it would overwrite that velocity every
  // frame and the perk would never move the animal — the bug that presents as
  // "the lunge perk does nothing on this one boss". Anything committed is
  // abandoned rather than resumed: the perk has moved the animal somewhere
  // else, and an ambush that carried on afterwards would launch from a
  // position it never aimed from.
  const perk = activeBossPerk();
  if (perk && perk.stage && perk.stage !== 'ready') {
    if (anglerState.baseContact > 0) e.contactDamage = anglerState.baseContact;
    e.ramming = false;
    e.animState = null;
    anglerState.stage = 'lurk';
    anglerState.timer = c.settle ?? 0.6;
    anglerState.cues?.hold('lurk');
    anglerState.cues?.clearFire();
    // The telegraph goes with the charge it was telling you about. A ring left
    // burning over an attack the perk just cancelled is the worst kind of lie:
    // one the player reads correctly and is punished for believing.
    dropRing();
    anglerState.attack = null;
    return;
  }

  const px = playerPos?.x;
  const py = playerPos?.y;
  const hasPlayer = Number.isFinite(px) && Number.isFinite(py);
  let dx = 0; let dy = 0; let dist = Infinity;
  if (hasPlayer) {
    // `e.mesh.position`, NOT `e.x` — an enemy record has no x/y at all, and
    // reading them gives undefined, which turns dx/dy into NaN, makes the
    // trigger comparison permanently false, and writes NaN into the velocity
    // the integrator steps. The boss then has no position and simply is not on
    // screen: no error, no warning, an invisible boss. Every other system that
    // needs a boss's position goes through the mesh — see bossPerks.js and
    // kraken.js — because the mesh IS where a creature is.
    dx = px - e.mesh.position.x;
    dy = py - e.mesh.position.y;
    dist = Math.hypot(dx, dy) || 1;
    dx /= dist; dy /= dist;
  }

  // THE SAME QUESTION ASKED FROM THE ESCA, and it is a genuinely different
  // answer. The body is twelve world units long and the lure hangs off the
  // front of it, so on an animal side-on to the seal the two distances differ
  // by most of a body — enough to pick the wrong attack, and enough for the
  // radial's reach to disagree with the circle drawn for it. Everything the
  // lure does is measured here; everything the BODY does (the lunge, the
  // facing) stays on the pair above.
  let lureDx = 0; let lureDy = 0; let lureDist = Infinity;
  if (hasPlayer) {
    const at = lureAt(e, c);
    lureDx = px - at.x;
    lureDy = py - at.y;
    lureDist = Math.hypot(lureDx, lureDy) || 1;
    lureDx /= lureDist; lureDy /= lureDist;
  }

  anglerState.timer -= dt;
  // THE GAP BEFORE THE NEXT LURE ATTACK, and it is spent by ANY attack — the
  // lunge arms it too (see the commit below). One-directional on purpose: the
  // lunge is never gated by it, the lure always is.
  //
  // Both halves of that matter. If the lunge did not arm it, a player could
  // step into melee range, eat a lunge, step back out, and be beamed on the
  // next frame — the animal spending two attacks on one breath. If the lure
  // gated the lunge in return, an anglerfish that had just beamed would decline
  // to bite a seal swimming into its mouth, which is the one thing an ambush
  // predator must never do.
  if (anglerState.cooldown > 0) anglerState.cooldown -= dt;
  anglerState.playerAt = hasPlayer ? { x: px, y: py } : null;
  // ...and the same for the facing. faceToward sets it on any frame it writes
  // the heading; a frame that does not hands the body straight back to
  // `faceMotion` in entities/enemies.js.
  e.faceLocked = false;
  // CLEARED HERE, ONCE, and written back only by the two stages that are
  // actually telegraphing something. Every other arrangement leaks: a clear at
  // the bottom of each of the six other stages is six places to forget it, and
  // the yield below returns early past all of them — so a boss whose ambush was
  // cancelled by a perk mid-wind-up would keep its eyes lit for the rest of the
  // fight, announcing an attack that is never coming.
  e.telegraph = 0;

  // --- LURK -----------------------------------------------------------------
  if (anglerState.stage === 'lurk') {
    e.animState = 'idle';
    // A DEAD STOP HORIZONTALLY, and a slow settle onto the bottom — see
    // holdFloor. It holds its station and turns its head; faceToward explains
    // why the facing is written here rather than left to `faceMotion`.
    //
    // The animal is on the seabed for the whole of this stage, which is what
    // makes the arena vertical: the surface is the safe place, the trap is the
    // floor, and the run is spent deciding how far down to go. It is also the
    // reason the two lure attacks below have to exist — an ambusher pinned to
    // the bottom with only a melee lunge is a boss you beat by floating out of
    // reach and shooting down at it.
    e.perkDrive = true;
    holdFloor(e, dt, c);

    // ...UNLESS THE STOP IS INSIDE THE SCENERY. The hold is the whole design
    // and this does not weaken it: an animal waiting in open water waits, and
    // only one that is in the rock backs out of it first. It has to be here
    // rather than only in the recovery, because the arrival lands the body on
    // the wall before a single cycle has ever run — see the note above
    // clampStation. `swim` while it moves, so the fish is not sliding along in
    // its trap pose.
    //
    // NOT A `return`. The trigger below still gets asked on the same frame: a
    // seal that has swum into the corner with it is in range whether or not
    // the animal has finished tidying its position, and an ambusher that
    // declined to strike while backing off a wall would be one the player
    // could safely stand next to.
    // `station ||` is a LATCH: once it has decided to move it finishes the
    // move. Testing againstScenery alone stops the animal on the exact frame
    // the test goes false, which is a body halted one nose-length off the rock
    // with its momentum cut — the shape of the bug, an inch further out.
    if (anglerState.station || againstScenery(e)) {
      if (!anglerState.station) {
        // Straight out from whichever wall it is on, toward the middle of the
        // ocean. Not the player-relative ring the recovery uses: this is not a
        // reposition to a better ambush spot, it is getting unstuck, and the
        // seal may be nowhere near.
        anglerState.station = clampStation(e,
          e.mesh.position.x * 0.75,
          e.mesh.position.y * 0.75 + bounds.surfaceY * 0.25);
      }
      e.animState = 'swim';
      if (driftToStation(e, dt, c, dx, dy, hasPlayer)) anglerState.station = null;
    } else if (hasPlayer) {
      faceToward(e, dx, dy, dt, c.lurkTurnRate ?? 0.9);
    }
    anglerState.cues?.hold('lurk');

    // It only strikes at something inside its reach AND only after it has
    // settled — otherwise a player who walks in during the recovery gets an
    // instant second lunge with no readable gap between them.
    if (anglerState.timer <= 0 && hasPlayer && dist <= (c.triggerRange ?? 11)) {
      anglerState.stage = 'windup';
      anglerState.timer = c.windup ?? 0.85;
      // Dropped on the way out, so a wall-escape half finished cannot be
      // mistaken for this cycle's chosen ambush spot when the recovery asks.
      anglerState.station = null;
      anglerState.cues?.fire('windup');
      // THE TELL, fired once at the top of the wind-up rather than every
      // frame. `bark` is the one-shot slot the kraken already telegraphs
      // through; here it resolves to `swim_start`, the file's own take of the
      // animal gathering itself to move.
      e.anim?.trigger('bark');
      hooks.onAnglerWindup?.(e);
      return;
    }

    // --- THE LURE ------------------------------------------------------------
    // Everything the lunge cannot reach. Asked SECOND so the lunge always wins
    // a tie: inside `triggerRange` the animal is close enough to simply take
    // you, and a boss that stood on the seabed beaming at something it could
    // have bitten would read as not knowing where the player was.
    //
    // The pick is the DISTANCE and nothing else, which is the whole lesson of
    // the fight — inside the radial's reach it holds you, outside it zaps you,
    // and a player learns both by standing in the wrong one. Measured from the
    // LURE rather than from the body, because the lure is what both attacks
    // come out of; against a 13-unit radius on an animal 12 units long, the
    // difference decides the wrong attack surprisingly often.
    if (anglerState.timer <= 0 && anglerState.cooldown <= 0 && hasPlayer
        && !anglerState.station && lureDist <= (c.lureRange ?? 46)) {
      anglerState.attack = lureDist <= (c.pulseRadius ?? 13) * (c.pulsePick ?? 1.15)
        ? 'pulse' : 'beam';
      anglerState.stage = 'charge';
      anglerState.timer = c.chargeTime ?? 1.25;
      anglerState.ringFade = 0;
      anglerState.ring = makeTell(anglerState.attack, c);
      scene?.add?.(anglerState.ring);
      anglerState.cues?.fire('charge');
      feedback('anglerCharge', { x: e.mesh.position.x, y: e.mesh.position.y });
      // The same gather-yourself one-shot the lunge tells with. It is the only
      // take on this rig that reads as the animal committing to something, and
      // using it for both is honest: the player is being told SOMETHING is
      // coming, and which one is what the light and the ring are for.
      e.anim?.trigger('bark');
      hooks.onAnglerCharge?.(e, anglerState.attack);
    }
    return;
  }

  // --- CHARGE ---------------------------------------------------------------
  // The lure attacks' tell, and it is a longer one than the lunge's on purpose.
  // A lunge is a body moving, which a player reads instantly and from anywhere
  // on screen. This is a light on a motionless animal that may be forty units
  // away on the seabed: if the light and the ring do not carry the whole
  // message there is no message, so the wind-up is 1.25s against the lunge's
  // 0.85 and the ring is swept ON across it rather than simply appearing.
  //
  // IT STAYS ON THE BOTTOM THROUGHOUT. Charging is not a commitment of the
  // body, which is exactly what separates these two attacks from the lunge: the
  // punishable window afterwards is short, and the animal never leaves the one
  // place the player has to come down to reach.
  if (anglerState.stage === 'charge') {
    // `idle` — the `trap` take — underneath, for the same reason the wind-up
    // keeps it: `bark` is a one-shot playing OVER the locomotion, and dropping
    // the animal into a cruise for the last frames of its own tell would be the
    // body saying it had changed its mind.
    e.animState = 'idle';
    e.perkDrive = true;
    holdFloor(e, dt, c);
    // Turning at the wind-up's rate, not the lurk's: the body snapping onto you
    // is the half of the telegraph that says WHERE. Still a rate rather than a
    // snap, so moving during the charge makes it commit slightly off — which is
    // the counterplay, and the only one the beam has.
    if (hasPlayer) faceToward(e, dx, dy, dt, c.windupTurnRate ?? 2.4);
    tell(e, c.chargeTime ?? 1.25);
    tickTell(dt, e, c);

    // A seal that has left is not something to fire at. Abandoned rather than
    // finished: an attack that resolved against a player who is no longer there
    // would put a beam through empty water on a cooldown the fight paid for.
    if (!hasPlayer) {
      dropRing();
      anglerState.attack = null;
      anglerState.stage = 'lurk';
      anglerState.timer = c.settle ?? 0.6;
      anglerState.cues?.hold('lurk');
      return;
    }

    if (anglerState.timer <= 0) {
      // LOCKED HERE, at the end of the tell, and from the lure — see fireLure.
      anglerState.dirX = lureDx;
      anglerState.dirY = lureDy;
      fireLure(scene, e, lureDx, lureDy, hooks);
      // Spent on the same frame, for the wind-up's reason above.
      e.telegraph = 0;
      anglerState.stage = 'discharge';
      anglerState.timer = c.dischargeTime ?? 0.55;
      anglerState.cooldown = c.attackGap ?? 2.6;
      // Half the follow-through, so the reach the player was reading is still
      // on screen while they work out whether they were inside it.
      anglerState.ringFade = Math.max(0.001, (c.dischargeTime ?? 0.55) * 0.5);
      anglerState.cues?.hold('recover');
      hooks.onAnglerFired?.(e, anglerState.attack);
    }
    return;
  }

  // --- DISCHARGE ------------------------------------------------------------
  // Spent. The lure is out and the animal is stuck in its own follow-through,
  // which is the window a player at range gets to close the distance in for
  // free — the same bargain the recovery makes after a lunge, and deliberately
  // the same shape: a dark anglerfish is a safe one, whichever attack put it
  // in the dark.
  if (anglerState.stage === 'discharge') {
    e.animState = 'swim';
    e.perkDrive = true;
    holdFloor(e, dt, c);
    // STILL WATCHING YOU, at the lurk's lazy rate — it is spent, not
    // uninterested. It also has to own the facing here for the reason the lurk
    // does: holdFloor settles the body onto the seabed at up to 3.4 u/s, well
    // over faceMotion's 0.05 gate, so left alone the animal would spend its
    // whole follow-through pointing at its own descent.
    if (hasPlayer) faceToward(e, dx, dy, dt, c.lurkTurnRate ?? 0.9);
    tickTell(dt, e, c);
    if (anglerState.timer <= 0) {
      dropRing();
      anglerState.attack = null;
      anglerState.stage = 'recover';
      anglerState.timer = c.recoverTime ?? 1.6;
    }
    return;
  }

  // --- WINDUP ---------------------------------------------------------------
  if (anglerState.stage === 'windup') {
    // Deliberately still `idle` (the `trap` take) underneath: `bark` is a
    // one-shot playing OVER the locomotion, and systems/animation.js hands
    // control back to whatever locomotion state is current when it finishes.
    // Setting `swim` here would mean the tell ends by dropping the animal into
    // a cruise for the last few frames before it launches.
    e.animState = 'idle';
    e.perkDrive = true;
    e.vx = 0;
    e.vy = 0;
    // Turning HARDER than it lurks — the body visibly snapping onto you is the
    // half of the telegraph that says WHERE, as against WHEN. It is still a
    // rate rather than a snap, so a player who moves during the tell can watch
    // it fail to fully correct, which is what makes circling it work.
    if (hasPlayer) faceToward(e, dx, dy, dt, c.windupTurnRate ?? 2.4);
    tell(e, c.windup ?? 0.85);

    if (anglerState.timer <= 0) {
      anglerState.stage = 'lunge';
      anglerState.timer = c.lungeTime ?? 0.75;
      // Set here rather than left to next frame's branch. The transition frame
      // already carries the doubled contact damage, and a body that is
      // dangerous while still playing its wind-up pose is one frame of the
      // animal lying about what it is doing.
      e.animState = 'boost';
      // LOCKED HERE, at the end of the tell — see the note at the top.
      anglerState.dirX = dx;
      anglerState.dirY = dy;
      // THE TELL ENDS ON THE FRAME THE BODY COMMITS, not on the one after it.
      // The clear at the top of the stage machine would do it next frame, and
      // the animal would spend that frame committed AND still announcing —
      // which is a boss telling you to move at the moment moving stops working.
      // The same reason the contact damage and `ramming` are set here.
      e.telegraph = 0;
      e.contactDamage = anglerState.baseContact * (c.lungeDamage ?? 2);
      // Spent. See the note on the cooldown above: an attack is an attack, and
      // the gap is measured from the last thing the animal did rather than from
      // the last thing it did with the lure.
      anglerState.cooldown = c.attackGap ?? 5.6;
      anglerState.fired.lunge++;
      // The committed run is an ATTACK, not overlap — see `ramming` in
      // entities/enemies.js for which of the boss ceilings each is held to.
      e.ramming = true;
      anglerState.cues?.fire('commit');
      anglerState.cues?.hold('travel');
      hooks.onAnglerLunge?.(e);
    }
    return;
  }

  // --- LUNGE ----------------------------------------------------------------
  if (anglerState.stage === 'lunge') {
    e.animState = 'boost';
    e.perkDrive = true;
    e.vx = anglerState.dirX * (c.lungeSpeed ?? 26);
    e.vy = anglerState.dirY * (c.lungeSpeed ?? 26);

    if (anglerState.timer <= 0) {
      anglerState.stage = 'snap';
      anglerState.timer = c.snapTime ?? 0.45;
      e.contactDamage = anglerState.baseContact;
      e.ramming = false;
      // The jaws close whether or not anything was in them. See the cadence
      // note: selling the miss is most of what makes the dodge land.
      e.anim?.trigger('bite');
      // A HOLD, not a fire — the light going out is a level the animal settles
      // at, and a descending fire would be swallowed by the travel hold it is
      // meant to replace. See the note in systems/emissivePulse.js.
      anglerState.cues?.hold('recover');
      hooks.onAnglerSnap?.(e);
    }
    return;
  }

  // --- SNAP -----------------------------------------------------------------
  // The bite one-shot is playing over the top; underneath, the body is already
  // coasting to a stop so the recovery has somewhere to decelerate FROM.
  if (anglerState.stage === 'snap') {
    e.animState = 'swim';
    e.perkDrive = true;
    const decay = Math.max(0, 1 - dt * (c.snapDrag ?? 4));
    e.vx *= decay;
    e.vy *= decay;
    if (anglerState.timer <= 0) {
      anglerState.stage = 'recover';
      anglerState.timer = c.recoverTime ?? 1.6;
    }
    return;
  }

  // --- RECOVER --------------------------------------------------------------
  // It relocates. NOT by handing the wheel to `behavior: 'hunt'`, which is what
  // this used to do and which made the boss chase you between ambushes — an
  // ambusher that chases is just a slow chaser, and it throws away the reason
  // the fight exists. Instead it drifts, at its own cruise speed, to a station
  // it picked when the recovery began.
  //
  // Relocating at all rather than sitting where it landed: a trap in a known
  // spot stops being a trap after the first one, and the player should have to
  // find it again each cycle. `faceMotion` owns the heading through this stage
  // — the drift is well above the 0.05 gate — which is correct, because here
  // the animal genuinely is going somewhere and should point that way.
  e.animState = 'swim';
  e.perkDrive = true;
  if (!anglerState.station && hasPlayer) {
    // ALONG THE BOTTOM, `stationRange` to one side of the seal. It used to be a
    // point on a ring around the player at an arbitrary angle, which is a fine
    // way to pick an ambush spot for an animal that ambushes from open water
    // and the wrong one for this one: half that ring is ABOVE the seal, and an
    // anglerfish waiting near the surface has given up the only thing the
    // seabed was doing for it. The height is not a choice any more — see
    // floorStation — and only which side is.
    //
    // The sign alternates by cycle rather than being rolled, so the animal
    // works its way back and forth across the player over a fight instead of
    // sometimes going nowhere. Relocating at all is the point: a trap in a
    // known spot stops being a trap after the first one.
    const side = (anglerState.cycles % 2) ? 1 : -1;
    anglerState.station = floorStation(e, c, px + side * (c.stationRange ?? 13));
  }
  driftToStation(e, dt, c, dx, dy, hasPlayer);
  if (anglerState.timer <= 0) {
    anglerState.stage = 'lurk';
    anglerState.timer = c.settle ?? 0.6;
    anglerState.cycles++;
    anglerState.station = null;
    anglerState.cues?.hold('lurk');
  }
}

/** A hit landed: bite the lure bright for a moment. Never changes the stage. */
export function anglerHurt() {
  anglerState.cues?.fire('hurt');
}

/** What the fight is doing right now — for the harness and the debug panel. */
export function anglerStage() {
  return {
    stage: anglerState.stage,
    timer: anglerState.timer,
    cycles: anglerState.cycles,
    emissive: anglerState.cues?.level ?? 1,
    cue: anglerState.cues?.stage() ?? null,
    // Which lure attack is loaded, when the next one may be, and what this
    // arrival has actually thrown. Published for the reason the locked line is:
    // "it never uses the beam" and "it beams every two seconds" are both
    // invisible from outside a fight, and neither is something anyone can
    // debug from a screenshot.
    attack: anglerState.attack,
    cooldown: Math.max(0, anglerState.cooldown),
    fired: { ...anglerState.fired },
    tell: !!anglerState.ring,
  };
}
