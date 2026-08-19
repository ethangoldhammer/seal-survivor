import * as THREE from 'three';
import { CONFIG } from '../config.js';
import {
  createEyePair, createEyeLights, updateEyeLights, resetEyeLights,
  flashEyeLightsDamage,
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
  for (let i = 0; i < sockets.length; i++) {
    entry.rig.sockets[`eye${i}`] = sockets[i];
    entry.rig.normals[`eye${i}`] = new THREE.Vector3(0, 0, 1);
  }
  pairs.set(e, entry);
  return entry;
}

/**
 * One frame, for every boss alive.
 *
 * @param bosses the live boss creatures. Read rather than tracked: a boss can
 *               die, be removed and have its visual recycled between two
 *               frames of this system, and a list this file maintained would
 *               hold the corpse.
 */
export function updateBossEyes(dt, scene, bosses = []) {
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
    const charge = windingUp && perk.enemy === e ? 1 : 0;

    // DAMAGE THROUGH THE FLASH EVERY SOURCE ALREADY SETS. `e.flash` is written
    // by combat.js, club.js, bakalar.js, calamari.js and the rest — one field,
    // every damage source, already there. Hooking those call sites one by one
    // would have been six edits and a seventh missed.
    const flash = e.flash ?? 0;
    if (flash > 0 && flash > (e.__eyeFlash ?? 0)) {
      flashEyeLightsDamage(1, entry.pair);
    }
    e.__eyeFlash = flash;

    // Socket normals, refreshed against the body's own centre.
    e.visual.getWorldPosition(_centre);
    for (let i = 0; i < entry.sockets.length; i++) {
      socketNormal(entry.sockets[i], _centre, entry.rig.normals[`eye${i}`]);
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
