import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual, isAssetLoaded } from '../assets.js';
import { unlockGranted } from './unlocks.js';

// ---------------------------------------------------------------------------
// WHAT THE SEAL WEARS — a hat, a pair of sunglasses, anything small enough to
// ride a bone.
//
// THE MESH IS A CHILD OF THE BONE, not a thing placed at where the bone was.
// That is the whole design and it is the same decision the eye beads make (see
// the note at the top of systems/eyeLights.js): a world-space position read
// from the rig is correct for something spawned at a point and then left — a
// bullet, a bubble — and one frame stale for anything that has to STAY on the
// skin. Anything that moves the animal between the aim rig's solve and the
// draw, or any frame where the rig does not solve at all, leaves a hat hanging
// where the head used to be: measured on the eyes at 0.12 world units on a
// 3 rad/s turn at 60fps and 0.25 at 30, and worst under time dilation, which is
// exactly when you are looking. As a child of the bone the drift is not small,
// it is unrepresentable.
//
// It also means the seal's mirror, its neck IK, the swim clip's head bob and
// the breath all reach the hat for nothing. No system here has to know they
// exist.
//
// WHAT THIS FILE OWNS, then, is only the three things a parented mesh cannot do
// for itself:
//
//   ATTACH   find the named bone on whatever body is currently on screen, and
//            re-find it when that body is swapped (rebuildShipBody, a model
//            change from the workbench). Idempotent, checked every frame — the
//            check is a pointer comparison and the alternative is a hat left
//            parented to a skeleton that has left the scene.
//   PLACE    write CONFIG's offset, rotation and size onto it, dividing the
//            bone's inherited fit scale back out so the numbers are world
//            units. Every frame, deliberately: that is what makes the tuner
//            sliders move the thing while you are dragging them, which is the
//            feature that was asked for.
//   SWAP     rebuild the visual once its real model has finished loading. Every
//            accessory is built the moment it is first worn, and if that is
//            before preloadAssets has landed the file, createVisual hands back
//            the primitive stand-in — correct, and permanent unless somebody
//            notices the model arriving later.
// ---------------------------------------------------------------------------

// One entry per accessory that has ever been worn, keyed by asset. Kept when it
// is taken off rather than thrown away: a visual is a clone with its own
// geometry references and materials, and a toggle in the tuner is something you
// flick back and forth while you look at it.
const worn = new Map();

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _base = new THREE.Quaternion();
const _trim = new THREE.Quaternion();
const _e = new THREE.Euler();
const _off = new THREE.Vector3();

/**
 * The scale this bone hands down to its children — the model's fit scale, plus
 * whatever the animation is doing to the bone itself.
 *
 * Read live off the matrix rather than cached from the def: a body swapped in
 * through the workbench carries its own fit, and the size slider in the T panel
 * moves it mid-run. Averaged across the three axes because a bone squashed
 * non-uniformly has no single scale, and the average is the honest answer for
 * something rigid hanging off it.
 */
function boneScale(bone) {
  bone.matrixWorld.decompose(_p, _q, _s);
  const s = (Math.abs(_s.x) + Math.abs(_s.y) + Math.abs(_s.z)) / 3;
  return s > 1e-6 ? s : 1;
}

/** Take one off: out of the scene graph, but kept for the next time. */
function detach(entry) {
  entry.visual?.parent?.remove(entry.visual);
  entry.bone = null;
}

/**
 * Put every accessory where CONFIG says it goes, on the body currently on
 * screen.
 *
 * @param body  the seal's model root — entities/player.js's `player.body`, or
 *   whatever a look page or a harness is holding. Null while there is no seal
 *   (before boot, mid-swap), which takes everything off rather than leaving it
 *   parented to a skeleton that is no longer drawn.
 */
export function updateAccessories(body) {
  const cfg = CONFIG.accessories;
  const items = cfg?.items;
  if (!items) return;

  for (const [key, item] of Object.entries(items)) {
    let entry = worn.get(key);
    // ONE SLOT, so this is an equality rather than a per-item flag — see
    // CONFIG.accessories.equipped. Everything not in the slot is taken off on
    // the same frame the new one goes on, which is what makes swapping a swap
    // rather than a stack.
    const wanted = !!(cfg.enabled && wornAccessory() === key && body);

    if (!wanted) {
      if (entry?.bone) detach(entry);
      continue;
    }

    // --- the mesh ------------------------------------------------------------
    // Built on the first frame it is worn, and REBUILT once — the frame the
    // real model lands. Before preload finishes, createVisual returns the
    // stand-in primitive from the asset's `shape`, which is right (something
    // visible to tune against) and would otherwise be what the player sees
    // forever, since nothing else in this file would ever ask again.
    if (!entry) {
      entry = { visual: null, bone: null, fromModel: false };
      worn.set(key, entry);
    }
    if (!entry.visual || (!entry.fromModel && isAssetLoaded(key))) {
      // detach() clears `bone`, which is what makes the attach below re-run and
      // put the new mesh where the old one was — in the same frame, so the swap
      // is invisible rather than a blink.
      if (entry.visual) detach(entry);
      entry.visual = createVisual(key);
      entry.visual.name = `accessory:${key}`;
      entry.fromModel = isAssetLoaded(key);
    }

    // --- the bone ------------------------------------------------------------
    // By name off the body, not off the aim rig: an accessory is not aim, and
    // going through the rig would mean a hat that vanishes on a model with no
    // rig at all (the sealhelper escorts, a look page holding a bare mesh).
    const boneName = item.bone;
    const bone = boneName ? body.getObjectByName(boneName) : null;
    if (!bone) {
      // Named a bone this body does not have. Take it off rather than leaving
      // it on the last body's — and say so once, because a silent nothing is
      // indistinguishable from a size slider left at zero.
      if (entry.bone) detach(entry);
      if (!entry.warned) {
        console.warn(`[accessories] "${key}" wants bone "${boneName}", which this body doesn't have.`);
        entry.warned = true;
      }
      continue;
    }
    entry.warned = false;
    if (entry.bone !== bone) {
      entry.visual.parent?.remove(entry.visual);
      bone.add(entry.visual);
      entry.bone = bone;
    }

    // --- the placement -------------------------------------------------------
    // EVERYTHING BELOW IS IN THE SEAL'S OWN FRAME, not the bone's, and the
    // bridge between the two is `boneAlign` — the bone's rest orientation
    // measured against the body (CONFIG.accessories.boneAlign). That one
    // quaternion is what lets six sliders mean one thing each:
    //
    //   body +Y   the way the animal swims           `snout`
    //   body -X   up the screen                      `lift`
    //   body +Z   toward the lens                    `depth`
    //
    // Written straight into the bone's own axes instead, the names would be
    // true for head_07 and lies for every other bone in the dropdown — the
    // frame turns with the joint. Worse, the ROTATIONS would be entangled: an
    // euler applied in the bone's frame composes each trim against the quarter
    // turn already in it, so `roll` swings the thing in a plane that has
    // nothing to do with rolling. That is not a subtle wrongness, it is the
    // difference between a slider you can aim and one you discover by dragging.
    //
    // The alignment is REST, deliberately, and read from config rather than off
    // the live bone: taking it live would re-derive the offset against whatever
    // pose the mixer is in, which is a hat that stays over the body's shoulders
    // while the head it is supposedly on bends away underneath it.
    placeAccessory(entry.visual, bone, boneName, item, cfg, entry);
  }
}

/**
 * Put one accessory where CONFIG says it goes, on one bone. The placement half
 * of updateAccessories, split out so a body that is NOT the player's can wear
 * the same hat at the same angle — see dressBody.
 *
 * @param warn  a bag the one-time warnings are flagged on, so a body that lacks
 *   a boneAlign says so once rather than every frame.
 */
function placeAccessory(visual, bone, boneName, item, cfg, warn = {}) {
  const align = cfg.boneAlign?.[boneName];
  if (!align && !warn.alignWarned) {
    console.warn(`[accessories] no boneAlign for "${boneName}" — placement will be in the bone's own axes.`);
    warn.alignWarned = true;
  }
  _e.set(align?.[0] ?? 0, align?.[1] ?? 0, align?.[2] ?? 0, 'XYZ');
  _base.setFromEuler(_e);

  // WORLD UNITS DIVIDED BY THE BONE'S SCALE, on both the offset and the size:
  // the bone hands its children the model's 2.8875 fit, so a raw 0.1 here is
  // not a tenth of anything on screen. Doing it on both means `lift` and
  // `size` are in the same unit as each other and as the seal's own 2.6
  // length, which is the only way the two sliders can be reasoned about
  // together.
  const inv = 1 / boneScale(bone);
  // `lift` is negated because the body's +X is screen-DOWN in the side-on
  // view the game is played in (see orientationQuaternion in assets.js) — so
  // without it, dragging `lift` up would push a hat through the jaw.
  _off.set(-(item.lift ?? 0), item.snout ?? 0, item.depth ?? 0)
    .applyQuaternion(_base).multiplyScalar(inv);
  visual.position.copy(_off);

  // THE TRIMS, about the seal's own axes and in ZYX order so each is applied
  // to the frame the one before it left — which is what makes them behave
  // like three separate knobs rather than one tangled gimbal:
  //
  //   pitch  about body +Z, the camera axis   tips it forward and back
  //   yaw    about body +X, the vertical      swings it toward the lens
  //   roll   about body +Y, the swim axis     tips it side to side
  //
  // ALL THREE START AT ZERO, and that is only possible because the rest
  // alignment above is a separate thing. Folding the two together would mean
  // a "no rotation" reading of -1.5708 on one slider, and every trim from
  // there compounding against it.
  _e.set(item.yaw ?? 0, item.roll ?? 0, item.pitch ?? 0, 'ZYX');
  _trim.setFromEuler(_e);
  visual.quaternion.copy(_base).multiply(_trim);

  // `fit: 1` on the asset normalised the file's longest axis to one world
  // unit, so this IS the width of the thing in world units — see the entries
  // in assets.js. The stand-in primitives are not fitted, so until the real
  // mesh lands this reads as a multiplier over the shape's own dimensions.
  visual.scale.setScalar(Math.max(0.0001, item.size ?? 0.5) * inv);
}

/**
 * Dress a body that is not the player's — the level-up seal, a portrait — in
 * whatever is in the slot right now. A fresh visual, parented and placed
 * exactly as updateAccessories would place the player's, and NOT recorded in
 * `worn`: that map is the one slot on the one body on screen, and a second
 * body written into it would take the hat off the first.
 *
 * Placed once, on the pose the body is in when called (boneScale reads the
 * bone's world matrix, so bring the matrices up to date first). Returns null
 * when the slot is empty or the body has no such bone, and a handle with
 * `remove()` otherwise.
 */
export function dressBody(body) {
  const cfg = CONFIG.accessories;
  const key = cfg?.enabled ? (cfg.equipped ?? '') : '';
  const item = key ? cfg.items?.[key] : null;
  if (!item || !body) return null;
  const bone = item.bone ? body.getObjectByName(item.bone) : null;
  if (!bone) return null;
  const visual = createVisual(key);
  visual.name = `accessory:${key}`;
  bone.add(visual);
  body.updateMatrixWorld(true);
  placeAccessory(visual, bone, item.bone, item, cfg, {});
  return {
    key,
    visual,
    remove() { visual.parent?.remove(visual); },
  };
}

/**
 * Take everything off and forget it.
 *
 * For a harness between cases, and for a body being torn down: the visuals hang
 * off bones inside it, so a seal removed from the scene with its hat still on
 * keeps the hat alive through the bone that holds it.
 */
export function resetAccessories() {
  for (const entry of worn.values()) detach(entry);
  worn.clear();
  turn = 0;
}

/** What is on the seal right now, for the tests. */
export function accessoryState() {
  return worn;
}

// ---------------------------------------------------------------------------
// THE SLOT
//
// Three functions over one field, rather than three places that write it. The
// menu cycles it, the inventory drops onto it, the tuner picks it from a list,
// and a Node harness sets it — and every one of those has to refuse the same
// two things: a key with no ASSETS entry (a hat that does not exist), and a key
// that is locked (one the player has not earned). A caller that wrote
// `CONFIG.accessories.equipped` directly would be a fourth copy of that rule,
// and the one that forgot it would be the one that shipped.
// ---------------------------------------------------------------------------

/**
 * Everything that could go in the slot, in config order.
 *
 * @param onlyUnlocked  the inventory's view — what the player may actually
 *   wear. False gives the whole roster, which is what the tuner and the lab
 *   want: a tool for placing an accessory has no business hiding one.
 */
export function accessoryRoster(onlyUnlocked = false) {
  const items = CONFIG.accessories?.items ?? {};
  return Object.keys(items).filter((k) => !onlyUnlocked || accessoryUnlocked(k));
}

/**
 * Is this key wearable — a real accessory, and one the player has?
 *
 * `unlocked !== false`, which is the SAME rule accessoryRoster filters on, and
 * they have to agree or the drawer offers a tile that the click then refuses.
 * They did not, briefly: this read `!!unlocked`, so an accessory imported
 * without the field showed up in the drawer and could not be put on — a tile
 * that does nothing, which looks exactly like a tile you missed.
 *
 * ABSENT MEANS AVAILABLE, deliberately. An accessory in config.js is one
 * somebody added on purpose, and the tool that imports a wardrobe knows about
 * meshes and not about progression; locking has to be something a file SAYS,
 * not something it forgets.
 */
/**
 * What is actually ON the seal: the slot, unless the slot holds something the
 * player has not earned — in which case nothing. The slot's default is the
 * glasses, written in config.js long before anything could be locked, and
 * equipAccessory only guards a NEW equip; this is the guard on the one it
 * inherited. The slot itself is left alone, so the moment the gate is met the
 * seal is wearing what it always was.
 */
export function wornAccessory() {
  const key = CONFIG.accessories?.equipped ?? '';
  return key && accessoryUnlocked(key) ? key : '';
}

export function accessoryUnlocked(key) {
  const item = CONFIG.accessories?.items?.[key];
  // Two locks, and both must be open. `unlocked: false` is the hand lock —
  // config.js, or a tool, taking a thing out of the drawer outright. The
  // second is the EARNED lock: a row in unlocks.csv naming this key, which
  // holds until its stat is met and only while the gate switch is on (see
  // systems/unlocks.js). A key with no row passes it untouched.
  return !!item && item.unlocked !== false && unlockGranted('accessory', key);
}

// HOW THE ANIMAL IS STANDING while it wears the current thing — radians about
// its own long axis, 0 being the profile the bust is composed in.
//
// ROLLED WHEN IT GOES ON, and held until it comes off. `showTurns` is a list
// and a cap declares two of them, so putting the same hat on twice can give two
// different portraits — which is the point. Rolling it per FRAME instead would
// be a seal spinning on the spot; rolling it per READ would give a different
// answer to the menu and to a test on the same frame. Once, here, is the only
// place that is true.
let turn = 0;

/** Radians the body is asking to be turned by, for whoever is posing it. */
export function accessoryTurn() {
  return turn;
}

/**
 * Put one on, or take everything off with '' / null.
 *
 * @returns the key now in the slot, so a caller can announce what happened
 *   without reading the config back.
 */
export function equipAccessory(key) {
  const cfg = CONFIG.accessories;
  if (!cfg) return '';
  // A key nothing declares is a typo or a removed accessory, and the honest
  // answer is a bare seal rather than a slot pointing at nothing — which would
  // read, in the menu, as the cycle having a broken step in it.
  if (key && !accessoryUnlocked(key)) {
    console.warn(`[accessories] "${key}" is not an unlocked accessory — the slot was left as it was.`);
    return cfg.equipped ?? '';
  }
  cfg.equipped = key || '';
  // The bare seal stands the way the bust was composed. An accessory with no
  // list does too — a new one is a profile until somebody says otherwise, which
  // is the same shape every other optional field here has.
  const turns = cfg.items?.[cfg.equipped]?.showTurns;
  turn = Array.isArray(turns) && turns.length
    ? turns[(Math.random() * turns.length) | 0]
    : 0;
  return cfg.equipped;
}

/**
 * Step through the roster, and through BARE — the empty slot is a position in
 * the cycle rather than a thing you get to by other means. A player who has put
 * a hat on and wants it off has exactly one gesture available on this screen,
 * and a cycle that never comes back round to nothing is a hat you cannot remove.
 *
 * @param dir  +1 or -1.
 */
export function cycleAccessory(dir = 1) {
  const roster = accessoryRoster(true);
  // '' is the bare seal, and it is FIRST so that a roster of one accessory is
  // still a meaningful toggle rather than a button that does nothing.
  const ring = ['', ...roster];
  const at = ring.indexOf(CONFIG.accessories?.equipped ?? '');
  const next = ring[(((at < 0 ? 0 : at) + (dir >= 0 ? 1 : -1)) % ring.length + ring.length) % ring.length];
  return equipAccessory(next);
}
