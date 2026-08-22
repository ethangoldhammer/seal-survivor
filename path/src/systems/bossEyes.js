import * as THREE from 'three';
import { CONFIG } from '../config.js';
import {
  createEyePair, createEyeLights, updateEyeLights, resetEyeLights,
  flashEyeLightsDamage, EYE_SOCKETS,
} from './eyeLights.js';
import { activeBossPerk } from './bossPerks.js';

// BOSS EYES — the seal's own eye system, pointed at whatever is hunting it.
//
// Deliberately the same object (systems/eyeLights.js) rather than a second
// implementation: the near/far fade, the bone parenting, the luminance-
// normalised bloom and the priority chain are all that file's, and this one
// only decides WHICH bodies get a pair, where the sockets are, and what a boss
// is allowed to say with them. Two implementations would have been two of
// every bug in there — and, more to the point, a player learning that lit eyes
// mean "something is about to happen" should learn it once.
//
// TWO THINGS A BOSS SAYS, and they are a subset of the seal's four:
//
//   WIND-UP  gold, easing on through the tell. The same colour
//            CONFIG.boss.perkFx.lunge.flareColor already flares in, so the
//            eyes reinforce a tell the player is being taught rather than
//            adding a second vocabulary next to it. Every perk's tell stage is
//            called `windup` — see the INTERRUPTIBLE note in bossPerks.js —
//            so this is one read for all of them, and a perk written tomorrow
//            gets eyes by naming its stage what everyone else does.
//   HURT     red, and it takes the eye outright, exactly as the player's does.
//
// No release flare and no laser muzzle: a boss's dash IS the payoff and the
// wind-up dropping to nothing as it commits is the readable thing. Adding a
// spike there would put the loudest frame of the tell AFTER the moment the
// player needed to have already moved.
//
// ---------------------------------------------------------------------------
// WHICH BOSSES HAVE EYES, AND WHY IT IS NOT ALL OF THEM
// ---------------------------------------------------------------------------
// Four of the eight rigs carry eye sockets, and `npm run test:bosseyes` prints
// the inventory and checks every name against the model that boss wears:
//
//   bossShark      megalodon.glb    `eye`                       one node, both
//                                                               eyes share it
//   bossOrca       orca_male/female `Eye_L1`, `Eye_L2`          a mirrored pair
//                                   the model names both "L";
//                                   Eye_L2 is at +x, so it is the right eye
//   bossSquid      giantsquid.glb   `Eyeball.L_57` / `.R_58`    the spheres
//   bossCrab       crabpincer.glb   `Eye.3.L_04` / `.R_07`      the stalk tips
//
// The mosasaur and the hammerhead have no eye bones at all — their sockets
// have to be measured off the skull the way the seal's were, which is per-model
// work and is not done yet; they simply get no pair until it is. The trawler
// and the yacht are boats and are never getting eyes.
//
// A body with no sockets is not an error and does not warn. It is the ordinary
// case for half the roster, and a warning per boss spawn would be noise.

/** Live pairs, keyed by the enemy object itself. */
const pairs = new Map();

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

function cfg() {
  return CONFIG.boss?.eyes ?? {};
}

/**
 * The socket list for one boss, or null.
 *
 * Shares CONFIG.boss.perkFx.eyeSockets with the eye BEAMS, on purpose: the
 * thing that lights up and the thing that shoots must be the same point, and
 * two lists would drift the first time a model was swapped. That is not
 * hypothetical — two of the four entries were stale from exactly that, and the
 * beams had been firing from a fallback for as long as anyone could tell.
 *
 * The offset is zero and the normal is derived, because unlike the seal's
 * hand-measured eyeball discs these nodes ARE the eye: `Eyeball.L_57` is the
 * sphere, `Eye.3.L_04` is the eyeball on the end of the stalk. There is
 * nothing to offset by.
 */
function socketsFor(e) {
  const entries = CONFIG.boss?.perkFx?.eyeSockets?.[e.type];
  if (!entries?.length || !e.visual) return null;
  const found = [];
  for (const entry of entries) {
    // TWO SHAPES. A bare string is a node that IS the eye — `Eyeball.L_57` is
    // the sphere, `Eye3L_04` is the ball on the end of the stalk — and needs
    // no offset. A `{ bone, offset }` is a MEASURED socket on a rig with no
    // eye bone at all, in that bone's own space; see the note in config.js on
    // how the two were found, and `npm run sockets` to redo it.
    const name = typeof entry === 'string' ? entry : entry.bone;
    const bone = e.visual.getObjectByName(name);
    if (!bone) continue;
    found.push({
      bone,
      offset: new THREE.Vector3().fromArray(typeof entry === 'string' ? [0, 0, 0] : (entry.offset ?? [0, 0, 0])),
      normal: null,
    });
  }
  return found.length ? found : null;
}

/**
 * Which way a socket faces, in world space — the near/far fade needs it.
 *
 * DERIVED FROM WHERE THE SOCKET SITS relative to the body's centre, not from a
 * measured normal on the node. The seal could be measured because its eyes are
 * flat discs with a real facing; these four nodes are spheres and stalk tips
 * whose local axes point wherever three different authors left them, and a
 * node's own +Z is as likely to run down the animal as out of its face.
 *
 * An eye sits on the outside of a head, so the outward direction is the one
 * leading away from the body's midline. That is true of all four of these rigs
 * and of any rig anyone adds, which is worth more here than a per-model axis
 * table that would go stale the way the names did.
 */
function socketNormal(socket, centre, out) {
  // FROM THE SOCKET, not from the bone. On a measured rig the bone is the
  // whole skull and its origin is on the midline — asking which way THAT
  // faces gives no side at all, and both eyes would fade together.
  out.copy(socket.offset).applyMatrix4(socket.bone.matrixWorld).sub(centre);
  // A single-node rig (the megalodon's `eye`) sits ON the midline, so there is
  // no side to be on. Face the camera: with one node there is no near/far
  // question to answer and the eye should simply be visible.
  if (out.lengthSq() < 1e-8) return out.set(0, 0, 1);
  return out.normalize();
}

/** Build (or fetch) the pair for one boss. Null when its rig has no sockets. */
function pairFor(e, scene) {
  let entry = pairs.get(e);
  if (entry !== undefined) return entry;

  const sockets = socketsFor(e);
  if (!sockets) { pairs.set(e, null); return null; }

  const pair = createEyePair('boss');
  const group = createEyeLights(pair);
  scene.add(group);
  entry = {
    pair,
    group,
    // The shape updateEyeLights reads. Names are positional — the system only
    // needs a stable key per socket, and a boss's are not `eyeL`/`eyeR`
    // because a one-node rig has neither.
    rig: { sockets: {}, normals: {} },
    sockets,
  };
  // KEYED BY THE NAMES updateEyeLights ACTUALLY REQUIRES, which is a contract
  // and not a convention — see EYE_SOCKETS. This used to publish them as
  // `eye0`/`eye1` on the reasoning that a one-node rig has neither a left nor a
  // right, which is true about the ANIMAL and irrelevant to the system: the
  // gate in updateEyeLights asks for `eyeL` and `eyeR` by name, found neither,
  // and held every boss's eyes at zero brightness for the whole run. Nothing
  // warned, and the harness passed, because the hurt and wind-up clocks are run
  // before that gate — so `hurt` went to 0.96 on a pair whose beads were never
  // once made visible.
  //
  // A ONE-NODE RIG POINTS BOTH KEYS AT THE SAME SOCKET. That is the megalodon,
  // whose file names a single `eye` on the midline; two orbs at one point is
  // exactly what "both eyes share it" has always meant here, and it is why the
  // clamp is `min(i, length - 1)` rather than a skip.
  for (let i = 0; i < EYE_SOCKETS.length; i++) {
    const name = EYE_SOCKETS[i];
    entry.rig.sockets[name] = sockets[Math.min(i, sockets.length - 1)];
    entry.rig.normals[name] = new THREE.Vector3(0, 0, 1);
  }
  // THE DISTINCT BONES, for the tracker. A one-node rig publishes the SAME
  // socket object under both keys (see above), and aiming it twice a frame
  // would apply the swivel twice — the second pass reads the first's write as
  // the animation's pose, which is exactly the ratchet the reference guard in
  // trackEyes exists to prevent, arriving through the front door.
  entry.tracked = [...new Set(EYE_SOCKETS.map((n) => entry.rig.sockets[n]))];
  pairs.set(e, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// TRACKING — turning the eye bones so the lit bead follows the seal
// ---------------------------------------------------------------------------
// WHAT ACTUALLY MOVES, because the obvious answer is wrong. Rolling the eyeball
// about its own centre does nothing on these rigs: the anglerfish's eye mesh is
// a smooth shaded sphere with no iris painted on it, and the other three are
// spheres and stalk tips in the same state. What moves is the BEAD — the lit
// orb this file hangs at the socket, which sits OFF the bone (1.2 file units
// out along its own axis on the anglerfish). Turning the bone swings the bead
// across the face of the eye, and a bright dot sliding over a dark eyeball is
// what a pupil tracking you looks like.
//
// SO THE ROTATION IS BUILT FROM THE OFFSET, not from a fixed axis. The socket
// on this rig points along the CAMERA axis — the eyes are on the sides of the
// head and the game is seen from the side — so a rotation about world Z, the
// obvious choice for a game on a plane, is a rotation about the offset itself
// and moves the bead not one pixel on screen. What is wanted is the offset
// tipped out of the view axis and toward the seal, which is a rotation the
// offset direction has to be measured to build.
//
// AND IT COMPOSES ONTO THE POSE, never replaces it. Every clip in the
// anglerfish file keyframes both eye bones, so what is on the bone when this
// runs is the animation's, and the swivel is a delta on top — the same layering
// the head-look does one step earlier in the frame.
const _eyeDir = new THREE.Vector3();
const _eyeOut = new THREE.Vector3();
const _eyeWant = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _pqi = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
const _socketW = new THREE.Vector3();
const _boneW = new THREE.Vector3();

function trackCfg() {
  return cfg().track ?? {};
}

/**
 * Aim one boss's eyes at `playerPos`.
 *
 * Runs BEFORE the sockets are read for the lights, so the bead is placed at
 * this frame's aim rather than at last frame's — a bead lagging its own bone by
 * a frame is the difference between an eye following you and an eye being
 * dragged.
 */
function trackEyes(entry, e, playerPos, dt) {
  const t = trackCfg();
  if (t.enabled === false || !playerPos) return;
  const maxSwivel = Math.max(0, t.maxSwivel ?? 0.55);
  if (maxSwivel <= 0) return;

  for (const socket of entry.tracked) {
    const bone = socket.bone;
    if (!bone?.parent) continue;

    // THE ANTI-RATCHET, and it is the same measurement systems/ikChain.js's
    // restoreReference makes for the same reason. The mixer does not
    // necessarily rewrite a bone every frame — a clip holding a key skips it,
    // which keyframe COUNT does not predict — so a delta composed onto
    // whatever is currently on the bone would compound its own last write and
    // the eye would wind round until it left the head. If the bone still holds
    // exactly what this function wrote, nothing else has touched it, and the
    // pose to build from is the one saved before that write.
    if (socket.wrote && quatEquals(bone.quaternion, socket.wrote)) {
      bone.quaternion.copy(socket.ref);
    }
    if (!socket.ref) socket.ref = new THREE.Quaternion();
    socket.ref.copy(bone.quaternion);

    // Which way the socket currently points, off its own bone, in world space.
    bone.updateWorldMatrix(true, false);
    bone.getWorldPosition(_boneW);
    _socketW.copy(socket.offset).applyMatrix4(bone.matrixWorld);
    _eyeOut.copy(_socketW).sub(_boneW);
    // A socket ON its bone has no direction to tip. That is the megalodon's
    // single midline `eye`, which has no side and nothing to swing.
    if (_eyeOut.lengthSq() < 1e-8) continue;
    _eyeOut.normalize();

    // ...and which way the seal is, flattened onto the arena plane.
    _eyeDir.set(playerPos.x - _socketW.x, playerPos.y - _socketW.y, 0);
    if (_eyeDir.lengthSq() < 1e-8) continue;
    _eyeDir.normalize();
    // The part of that the eye can actually turn toward — the component
    // perpendicular to where it already points. Without this an eye whose
    // socket happens to lie along the bearing gets a zero-length axis and the
    // quaternion below comes out NaN, which writes NaN into a skeleton and
    // renders as the boss vanishing.
    _eyeWant.copy(_eyeDir).addScaledVector(_eyeOut, -_eyeDir.dot(_eyeOut));
    if (_eyeWant.lengthSq() < 1e-8) continue;
    _eyeWant.normalize();

    // EASED, not tracked. The swivel is a level the eye settles at, and one
    // that snapped onto the seal every time they crossed the midline would
    // strobe — the slow follow is the whole reason this reads as attention
    // rather than as a glitch.
    socket.swivel = socket.swivel ?? 0;
    const lerp = Math.max(0, t.lerp ?? 4);
    socket.swivel += (maxSwivel - socket.swivel) * (1 - Math.exp(-lerp * dt));
    // The direction is eased with it: `aim` is where the eye is pointing now,
    // walked toward where the seal is. Easing only the ANGLE would leave the
    // eye snapping between bearings at a smoothly-changing magnitude, which is
    // the same strobe with extra steps.
    if (!socket.aim) socket.aim = _eyeWant.clone();
    else socket.aim.lerp(_eyeWant, 1 - Math.exp(-lerp * dt)).normalize();

    // Tip the socket out of where it points and toward the seal, by the eased
    // angle. Both vectors are unit and perpendicular, so this is a rotation in
    // their plane and nothing else.
    _eyeWant.copy(_eyeOut).multiplyScalar(Math.cos(socket.swivel))
      .addScaledVector(socket.aim, Math.sin(socket.swivel));
    _dq.setFromUnitVectors(_eyeOut, _eyeWant);

    // The delta is in WORLD space and the bone's quaternion is in its parent's,
    // so it has to be carried across: newLocal = parent^-1 * delta * parent *
    // local. Getting this wrong does not throw — it produces an eye that turns
    // the right amount in the wrong direction, which looks like a sign error
    // in the bearing and is not one.
    bone.parent.getWorldQuaternion(_pq);
    _pqi.copy(_pq).invert();
    _delta.copy(_pqi).multiply(_dq).multiply(_pq);
    bone.quaternion.premultiply(_delta);
    if (!socket.wrote) socket.wrote = new THREE.Quaternion();
    socket.wrote.copy(bone.quaternion);
    bone.updateWorldMatrix(true, false);
  }
}

// Exact enough to answer "did anything else write this bone", which is the only
// question asked of it. Not Quaternion.equals: the value being compared is one
// this file wrote and then read back unchanged, so any difference at all is
// another writer.
function quatEquals(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
}

/**
 * One frame, for every boss alive.
 *
 * @param bosses the live boss creatures. Read rather than tracked: a boss can
 *               die, be removed and have its visual recycled between two
 *               frames of this system, and a list this file maintained would
 *               hold the corpse.
 */
export function updateBossEyes(dt, scene, bosses = [], playerPos = null) {
  const c = cfg();
  const on = c.enabled !== false && CONFIG.eyes?.enabled !== false;
  const perk = activeBossPerk();
  // Every perk calls its tell `windup`; see the header.
  const windingUp = perk?.stage === 'windup';

  const seen = new Set();
  for (const e of bosses) {
    if (!e || e.hp <= 0 || !e.visual) continue;
    seen.add(e);
    const entry = on ? pairFor(e, scene) : null;
    if (!entry) continue;

    // The tell, eased on by the same ramp the seal's boost uses. `windingUp`
    // is a flag rather than a 0..1 because bossPerks does not publish how far
    // through the wind-up it is — the ease is what turns the flag into a
    // build, and it is the same ease the player already reads on their own
    // eyes, which is the point.
    // ...and only on the body that is actually winding up. A second boss
    // telegraphing an attack it is not making is worse than no tell at all,
    // which is why activeBossPerk publishes its enemy.
    // ...OR THE BOSS'S OWN TELL, which is not a perk at all.
    //
    // `e.telegraph` is a plain 0..1 field any boss system may write while it is
    // winding something up — systems/bossAngler.js writes it through both of
    // its tells. It exists because the perk check above cannot see them: the
    // anglerfish's ambush and its lure are the animal rather than something
    // rolled onto it, so they have no perk and no `stage`, and a boss whose
    // whole fight is telegraphed had eyes that never once lit for any of it.
    //
    // A FIELD RATHER THAN AN IMPORT. The alternative is this file importing
    // bossAngler, then kraken, then bossBoat, each with its own idea of what
    // "winding up" is called — and the eyes would then know about every fight
    // in the game. One number, written by whoever is doing the winding, read
    // by whoever wants to show it.
    //
    // The LOUDER of the two wins rather than the newer: a perk winding up on
    // top of an ambush is still a wind-up, and taking the second writer's value
    // would let one cancel the other's tell mid-build.
    const charge = Math.max(
      windingUp && perk.enemy === e ? 1 : 0,
      Math.min(1, Math.max(0, e.telegraph ?? 0)),
    );

    // DAMAGE THROUGH THE FLASH EVERY SOURCE ALREADY SETS. `e.flash` is written
    // by combat.js, club.js, bakalar.js, calamari.js and the rest — one field,
    // every damage source, already there. Hooking those call sites one by one
    // would have been six edits and a seventh missed.
    const flash = e.flash ?? 0;
    if (flash > 0 && flash > (e.__eyeFlash ?? 0)) {
      flashEyeLightsDamage(1, entry.pair);
    }
    e.__eyeFlash = flash;

    // THE AIM, before anything reads where the sockets are. A bead placed from
    // last frame's bone lags its own eye by a frame, which on a slow follow is
    // most of the movement.
    trackEyes(entry, e, playerPos, dt);

    // Socket normals, refreshed against the body's own centre. Walked over the
    // PUBLISHED keys rather than over the found list, so a one-node rig — whose
    // two keys share one socket — refreshes the normal it actually uses under
    // both, instead of writing one and leaving the other at its (0, 0, 1) seed.
    e.visual.getWorldPosition(_centre);
    for (const name of EYE_SOCKETS) {
      socketNormal(entry.rig.sockets[name], _centre, entry.rig.normals[name]);
    }

    updateEyeLights(dt, entry.rig, { lit: 1, charge, pair: entry.pair });
  }

  // Anything that stopped being a live boss gives its pair back.
  for (const [e, entry] of pairs) {
    if (seen.has(e)) continue;
    if (entry) {
      resetEyeLights(entry.pair);
      entry.group.parent?.remove(entry.group);
    }
    pairs.delete(e);
  }
}

const _centre = new THREE.Vector3();

/** A new run starts with no boss eyes at all. */
export function resetBossEyes() {
  for (const entry of pairs.values()) {
    if (!entry) continue;
    resetEyeLights(entry.pair);
    entry.group.parent?.remove(entry.group);
  }
  pairs.clear();
}

/** How many bosses currently have a lit pair. For the harness and the panel. */
export function bossEyeCount() {
  let n = 0;
  for (const entry of pairs.values()) if (entry) n++;
  return n;
}

/** The live pairs, for the harness. Read-only. */
export function bossEyePairs() {
  return pairs;
}
