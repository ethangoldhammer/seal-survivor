#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:accessories
//
// What the seal wears — systems/accessories.js.
//
// The failure this exists to catch is the same one the eye sockets have: a
// placement that is PLAUSIBLE and wrong. Every number in CONFIG.accessories is
// hand-dialled against a seal on a screen, which is the right way to place a
// hat and is also a process with no opinion about whether the units mean
// anything. Two bugs hide perfectly inside it:
//
//   THE FIT SCALE. The bone hands its children the model's ~2.89 fit, so an
//   offset written straight into `position` is 2.89x what the slider says and a
//   `size` of 0.5 is a hat 1.4 world units across. Both look like nothing worse
//   than "the sliders are twitchy", and both silently make the hat's numbers
//   incomparable with every other world-unit number in CONFIG.
//
//   THE PARENT. A hat placed at a world position read off the rig looks correct
//   in a still frame and lags the head in motion — which is the one state
//   nobody screenshots. So this asserts the mesh is a CHILD of the bone and
//   that it moves when the bone alone moves.
//
// Five sections:
//
//   ATTACH    the mesh is a child of the named bone, on the body in play.
//   UNITS     offset and size are world units — measured against a bone that
//             carries the model's fit scale, which is the whole trap.
//   RIDES     posing the head alone carries the accessory with it.
//   SWAP      taking it off detaches it; a rebuilt body re-adopts it; a bone
//             name this rig doesn't have takes it off rather than stranding it.
//   BONES     the bones offered in the tuner are ones an accessory can actually
//             ride — nothing whose SCALE is animated, which is what rules the
//             eye bones out and is invisible in any still pose.
//
// What it cannot tell you: whether the hat looks good on the seal. That is a
// seal on a screen.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG, TUNER_SCHEMA } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import {
  updateAccessories, resetAccessories, accessoryState,
  equipAccessory, cycleAccessory, accessoryRoster, accessoryTurn,
} from '../path/src/systems/accessories.js';
import { createAimRig } from '../path/src/systems/aimRig.js';
import { bustAim, bustPlumb, createBustPin } from '../path/src/systems/splashBust.js';
import { createAnimationController, stateForSpeed } from '../path/src/systems/animation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL} — the seal has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}

const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('ship', gltf.scene, gltf.animations);

const HAT = 'accessories.items.accessoryHat';
const hat = CONFIG.accessories.items.accessoryHat;

// The seal as the game holds it: entities/player.js carries the facing on a
// container above the model, so the body itself is never at the world origin
// with an identity rotation. Every assertion below is a RELATIVE measurement
// for that reason — a harness that measured absolute world positions would be
// measuring this holder as much as the accessory.
const scene = new THREE.Scene();
const holder = new THREE.Object3D();
holder.rotation.z = -Math.PI / 2;
holder.position.set(3, -2, 0);
scene.add(holder);
let body = createVisual('ship');
holder.add(body);

/** One frame: solve nothing, just get the matrices where the system expects. */
function frame() {
  scene.updateMatrixWorld(true);
  updateAccessories(body);
  scene.updateMatrixWorld(true);
}

const worldPos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
function worldScale(o) {
  const s = new THREE.Vector3();
  o.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  return (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
}

// ---------------------------------------------------------------------------
section('ATTACH');
// ---------------------------------------------------------------------------
equipAccessory('accessoryHat');
hat.bone = 'head_07';
hat.snout = 0; hat.lift = 0; hat.depth = 0;
hat.pitch = 0; hat.yaw = 0; hat.roll = 0;
hat.size = 0.4;
frame();

const entry = accessoryState().get('accessoryHat');
check('a visual was built for the worn accessory', !!entry?.visual);
const boneOf = (b, name) => b.getObjectByName(name);
const head = boneOf(body, 'head_07');
check('head_07 is on this rig', !!head);
check('the accessory is a CHILD of the bone, not a mesh in the scene',
  entry?.visual?.parent === head, entry?.visual?.parent?.name ?? 'no parent');
// It has to be inside the body for the seal's own mirror and the head IK to
// reach it. A hat added to the scene root would pass the parent check above if
// somebody ever "fixed" it by reparenting to a bone CLONE.
let insideBody = false;
body.traverse((o) => { if (o === entry.visual) insideBody = true; });
check('...and therefore inside the body that is on screen', insideBody);

// ---------------------------------------------------------------------------
section('UNITS');
// ---------------------------------------------------------------------------
// THE BONE CARRIES THE MODEL'S FIT. If this is 1 the test below proves nothing
// — it would pass just as well on a system that never divided the scale out —
// so the scale is asserted first, and asserted to be far from 1.
const inherited = worldScale(head);
check('head_07 hands its children a fit scale worth dividing out',
  inherited > 1.5, `${inherited.toFixed(4)}x`);

// The offset is bone-local along the bone's own axes, so the check is the
// DISTANCE from the bone's origin: that is the one quantity that is the same
// number in every frame, and it is exactly what the slider claims to be.
for (const d of [0.05, 0.2, 0.5]) {
  hat.lift = d;
  frame();
  const moved = worldPos(entry.visual).distanceTo(worldPos(head));
  check(`an offset of ${d} moves it ${d} WORLD units off the bone`,
    Math.abs(moved - d) < 1e-3, `${moved.toFixed(4)}`);
}
hat.lift = 0.16;

for (const s of [0.2, 0.5, 1.2]) {
  hat.size = s;
  frame();
  const ws = worldScale(entry.visual);
  check(`a size of ${s} renders at ${s} in world scale`,
    Math.abs(ws - s) < 1e-3, `${ws.toFixed(4)}`);
}
hat.size = 0.4;

// Nothing here may be left to the mixer's mercy: a size of 0 is a legal thing
// to drag a slider to and an invisible, un-recoverable hat if it reaches
// `scale` as a literal zero (a zero matrix has no inverse and three warns on
// the decompose).
hat.size = 0;
frame();
check('a size dragged to zero still leaves a non-degenerate matrix',
  worldScale(entry.visual) > 0, `${worldScale(entry.visual).toExponential(2)}`);
hat.size = 0.4;

// --- and the three names mean what they say --------------------------------
// THE DIRECTIONS, not just the distances. `lift`, `snout` and `depth` are the
// bone's axes under names measured in the seal's body space at rest, and two of
// the three are stored NEGATED to get there (see systems/accessories.js). A
// sign dropped in that conversion is a slider that moves the right distance the
// wrong way, which every check above passes.
//
// Measured against the BODY, not the world: the holder above is rotated, so a
// world-space assertion here would be testing this harness's own framing. And
// DIRECTION only — the body root carries the size multiplier from assets.csv
// (2.36 on the seal), so a body-local displacement is not in world units and a
// magnitude compared here would be measuring that instead of the offset.
const bodyDir = (from, to) => body.worldToLocal(worldPos(to))
  .sub(body.worldToLocal(worldPos(from))).normalize();
for (const [field, axis, sign, meaning] of [
  ['snout', 'y', +1, 'the way the seal swims'],
  ['lift', 'x', -1, 'screen-up (body -X)'],
  ['depth', 'z', +1, 'toward the lens'],
]) {
  hat.snout = 0; hat.lift = 0; hat.depth = 0;
  frame();
  const zero = worldPos(entry.visual).clone();
  const zeroObj = new THREE.Object3D();
  zeroObj.position.copy(zero);
  scene.add(zeroObj);
  scene.updateMatrixWorld(true);
  hat[field] = 0.3;
  frame();
  const d = bodyDir(zeroObj, entry.visual);
  scene.remove(zeroObj);
  const along = d[axis] * sign;
  const across = Math.hypot(...['x', 'y', 'z'].filter((a) => a !== axis).map((a) => d[a]));
  check(`+${field} goes toward ${meaning}`, along > 0.98, `${along.toFixed(4)} along`);
  check('...and barely anywhere else', across < 0.06, `${across.toFixed(4)} across`);
}
hat.snout = 0.06; hat.lift = 0.16; hat.depth = 0;

// ---------------------------------------------------------------------------
section('RIDES');
// ---------------------------------------------------------------------------
// THE POINT OF THE WHOLE FEATURE. Move the head bone and nothing else — no
// body transform, no rig solve — and the hat has to come with it. A hat placed
// from a world-space anchor passes every assertion above and fails this one.
frame();
const before = worldPos(entry.visual);
const beforeHead = worldPos(head);
const beforeQ = head.getWorldQuaternion(new THREE.Quaternion());
head.rotation.x += 0.4;
scene.updateMatrixWorld(true);
const afterHead = worldPos(head);
const after = worldPos(entry.visual);
// The bone's own ORIGIN does not move when it turns about itself — measuring
// its position here would be a check that can only ever read zero, and one that
// would have "proved" the accessory rode a bone that never moved. And
// getWorldQuaternion rather than setFromRotationMatrix(matrixWorld): the matrix
// carries the model's 2.8875 fit, and a quaternion pulled out of a scaled
// matrix comes back un-normalised — angleTo then clamps its own dot product and
// reports a flat 0 rad however far the bone has turned.
const afterQ = head.getWorldQuaternion(new THREE.Quaternion());
check('the head bone actually turned', beforeQ.angleTo(afterQ) > 0.01,
  `${beforeQ.angleTo(afterQ).toFixed(4)} rad`);
check('the accessory moved with it, WITHOUT another update call',
  before.distanceTo(after) > 1e-4, `${before.distanceTo(after).toFixed(4)}`);
// And it kept its place ON the head rather than merely being dragged about:
// the distance to the bone is unchanged.
check('...and stayed exactly where it sits on the bone',
  Math.abs(after.distanceTo(afterHead) - before.distanceTo(beforeHead)) < 1e-4);
head.rotation.x -= 0.4;
scene.updateMatrixWorld(true);

// ---------------------------------------------------------------------------
section('SWAP');
// ---------------------------------------------------------------------------
equipAccessory('');
frame();
check('taking it off removes it from the bone', !entry.visual.parent);

equipAccessory('accessoryHat');
frame();
check('putting it back on re-attaches it', entry.visual.parent === head);

// A body swap — rebuildShipBody, or a model changed in the workbench. The old
// skeleton leaves the scene; an accessory still parented to it is a hat that
// has quietly stopped being drawn.
const oldVisual = entry.visual;
holder.remove(body);
body = createVisual('ship');
holder.add(body);
frame();
const newHead = boneOf(body, 'head_07');
check('a rebuilt body re-adopts the accessory', entry.visual.parent === newHead);
check('...onto the NEW skeleton, not the old one', newHead !== head);
check('...reusing the mesh rather than building another', entry.visual === oldVisual);

hat.bone = 'no_such_bone_09';
frame();
check('a bone this rig does not have takes the accessory off', !entry.visual.parent);
hat.bone = 'head_07';
frame();
check('naming a real bone again puts it back', entry.visual.parent === newHead);

CONFIG.accessories.enabled = false;
frame();
check('the master switch takes everything off', !entry.visual.parent);
CONFIG.accessories.enabled = true;
frame();

resetAccessories();
check('reset forgets every accessory', accessoryState().size === 0);

// ---------------------------------------------------------------------------
section('THE SLOT');
// ---------------------------------------------------------------------------
// ONE AT A TIME, and the point is that it is a SHAPE rather than a rule. There
// is no `worn` flag to set on two items, so "wearing both" is not a state the
// config can hold — what is checked here is that the system honours the slot
// and that the two ways of moving it (equip, cycle) cannot put something
// unwearable in it.
resetAccessories();
const roster = accessoryRoster();
check('the roster is every declared accessory', roster.length >= 2, roster.join(', '));

equipAccessory('accessoryGlasses');
frame();
const glassesOn = accessoryState().get('accessoryGlasses');
const hatOff = accessoryState().get('accessoryHat');
check('equipping one puts it on', !!glassesOn?.visual?.parent);
check('...and takes the other off in the same frame — this is the whole feature',
  !hatOff?.visual?.parent);

equipAccessory('accessoryHat');
frame();
check('and back the other way', !!accessoryState().get('accessoryHat')?.visual?.parent
  && !accessoryState().get('accessoryGlasses')?.visual?.parent);

// A key nothing declares. The slot has to REFUSE rather than take it: a slot
// pointing at nothing is a cycle with a broken step in it, which on the menu
// reads as a click that does nothing every third press.
const slotWas = CONFIG.accessories.equipped;
equipAccessory('accessoryScarf');
check('an accessory that does not exist is refused', CONFIG.accessories.equipped === slotWas,
  CONFIG.accessories.equipped);

// LOCKED is refused on the same path, because the inventory and the menu both
// go through it — see the note above equipAccessory.
CONFIG.accessories.items.accessoryGlasses.unlocked = false;
equipAccessory('accessoryGlasses');
check('a locked accessory is refused too', CONFIG.accessories.equipped !== 'accessoryGlasses',
  CONFIG.accessories.equipped);
check('...and it is out of the inventory\'s roster',
  !accessoryRoster(true).includes('accessoryGlasses'));
check('...but still in the tools\' roster — placing one you have not unlocked is fine',
  accessoryRoster().includes('accessoryGlasses'));
CONFIG.accessories.items.accessoryGlasses.unlocked = true;

// THE CYCLE, including the bare seal. A ring that never comes back round to ''
// is a hat you cannot take off from the one screen that offers the gesture.
equipAccessory('');
const seen = [];
for (let i = 0; i < roster.length + 1; i++) seen.push(cycleAccessory(1));
check('the cycle visits every accessory and the bare seal',
  new Set(seen).size === roster.length + 1 && seen.includes(''),
  seen.map((k) => k || '(bare)').join(' -> '));
check('...and comes back where it started', seen[seen.length - 1] === '');
equipAccessory('');
check('stepping backwards works too', cycleAccessory(-1) === roster[roster.length - 1],
  CONFIG.accessories.equipped);

// Back to a known state for the sections below.
resetAccessories();
equipAccessory('accessoryHat');
frame();

// ---------------------------------------------------------------------------
section('HOW IT STANDS');
// ---------------------------------------------------------------------------
// WHAT THE SEAL HAS ON CAN ASK TO BE SEEN — `showTurns`, radians about the
// animal's own long axis, rolled when it goes on and applied by the menu.
//
// The SIGN is the thing worth testing and the thing that cannot be reasoned
// out safely: -PI/2 and +PI/2 both put the animal side-on to its old self and
// both show two eyes, and only one of them shows its FRONT. The other is a seal
// presenting its back to the camera while wearing sunglasses, which is a
// perfectly plausible screenshot of a bug.
resetAccessories();
equipAccessory('');
check('a bare seal stands the way the bust is composed', accessoryTurn() === 0, String(accessoryTurn()));

equipAccessory('accessoryGlasses');
check('the glasses ask to be faced', Math.abs(accessoryTurn() + Math.PI / 2) < 0.01,
  `${(accessoryTurn() * 180 / Math.PI).toFixed(0)}deg`);

// THE COIN. A cap declares two poses; put it on enough times and both have to
// come up, or the "random" is a constant nobody would notice.
const rolls = new Set();
for (let i = 0; i < 60; i++) { equipAccessory(''); equipAccessory('accessoryHat'); rolls.add(accessoryTurn()); }
const want = new Set(CONFIG.accessories.items.accessoryHat.showTurns);
check('the cap rolls every pose it declares', rolls.size === want.size
  && [...rolls].every((r) => want.has(r)),
  [...rolls].map((r) => `${(r * 180 / Math.PI).toFixed(0)}deg`).join(', '));
check('...and one of them is the profile it had before', rolls.has(0));

// The roll happens ONCE, on the way on. A turn that re-rolled per read is a
// seal spinning on the spot, and it would give the menu and this test different
// answers on the same frame.
equipAccessory('accessoryHat');
const held = accessoryTurn();
check('the roll is held, not re-rolled on every read',
  accessoryTurn() === held && accessoryTurn() === held);

// --- WHICH WAY IS THE FRONT ------------------------------------------------
// MEASURED, on a seal posed the way the menu poses it. The front flippers hang
// off the shoulders slightly ventral of the spine, so the midpoint of their
// root bones against chest_04 names the belly; the two eye anchors going from
// pure camera-depth to pure screen-width is the second, independent read that
// the animal has actually turned rather than leaned.
{
  const stand = new THREE.Object3D();
  scene.add(stand);
  const upright = createVisual('ship');
  stand.add(upright);
  const uprightRig = createAimRig(upright);
  // The chest's AUTHORED pose, taken before a single solve has run on this
  // animal — the lean check below needs a rest to put the bone back to, and
  // any pose captured later in this block is one the rig has already leaned.
  const chestBone = upright.getObjectByName('chest_04');
  const chestRest = chestBone.quaternion.clone();
  const _y = new THREE.Vector3(0, 1, 0);
  const cursor = new THREE.Vector3(0, 6, 0);
  const aim = new THREE.Vector2(0, 1);
  const wantAim = new THREE.Vector2(0, 1);

  const pose = (t) => {
    for (let i = 0; i < 90; i++) {
      upright.quaternion.setFromAxisAngle(_y, t);
      upright.updateMatrixWorld(true);
      bustAim(uprightRig, cursor, wantAim, Math.PI / 2, 1);
      aim.lerp(wantAim, 0.2).normalize();
      uprightRig.update(1 / 60, aim, { engaged: true });
      scene.updateMatrixWorld(true);
    }
    const chest = upright.getObjectByName('chest_04').getWorldPosition(new THREE.Vector3());
    const l = upright.getObjectByName('uparm_L_012').getWorldPosition(new THREE.Vector3());
    const r = upright.getObjectByName('uparm_R_016').getWorldPosition(new THREE.Vector3());
    const belly = l.add(r).multiplyScalar(0.5).sub(chest).normalize();
    const eyes = uprightRig.anchors.eyeL.clone().sub(uprightRig.anchors.eyeR).normalize();
    return { belly, eyes };
  };

  const profile = pose(0);
  check('at turn 0 the seal is in profile — both eyes on one screen pixel',
    Math.abs(profile.eyes.z) > 0.99, `eye axis depth ${Math.abs(profile.eyes.z).toFixed(3)}`);

  const faced = pose(-Math.PI / 2);
  check('the glasses\' turn puts both eyes across the screen',
    Math.abs(faced.eyes.x) > 0.99, `eye axis across ${Math.abs(faced.eyes.x).toFixed(3)}`);
  // THE SIGN. Positive z is toward the lens.
  check('...and it is the BELLY that comes round, not the back',
    faced.belly.z > 0.02, `belly toward the camera ${faced.belly.z.toFixed(3)}`);
  const wrong = pose(Math.PI / 2);
  check('...proved by the other quarter turn showing its back',
    wrong.belly.z < -0.02, `belly toward the camera ${wrong.belly.z.toFixed(3)}`);

  // THE HEAD STILL FOLLOWS. The aim is a screen-plane direction and the neck IK
  // solves toward a world point, so a spin about the axis it is aimed along
  // should cost nothing — checked rather than assumed, because the chain's cone
  // gate and twist limit are stated in the BODY's frame and a turned body asks
  // the neck to bend sideways in its own.
  const headErr = (t, target) => {
    cursor.copy(target);
    pose(t);
    const h = upright.getObjectByName('head_07').getWorldPosition(new THREE.Vector3());
    const fwd = uprightRig.anchors.mouth.clone().sub(h);
    let d = Math.atan2(fwd.y, fwd.x) - Math.atan2(target.y - h.y, target.x - h.x);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) * 180 / Math.PI;
  };
  // Somewhere the neck can actually reach — up and up-forward. The positions it
  // gives up on are the cone gate's and it gives up on them in profile too, so
  // they say nothing about the turn.
  for (const [name, target] of [['straight up', new THREE.Vector3(0, 6, 0)], ['up-forward', new THREE.Vector3(4, 4, 0)]]) {
    const flat = headErr(0, target);
    const turned = headErr(-Math.PI / 2, target);
    check(`the head still tracks ${name} with the body faced`,
      turned < flat + 15, `${turned.toFixed(0)}deg turned vs ${flat.toFixed(0)}deg in profile`);
  }
  // --- AND THE EYES HAVE TO END UP POINTING AT THE LENS ---------------------
  // Turning the body is only half of it. The aim the rig solves is a
  // SCREEN-PLANE direction, so the head's target has no depth: a seal stood
  // upright with the cursor above it points its face at the sky, and what the
  // camera gets is the top of a skull. `faceOut` leans that target toward the
  // lens — see the block of the same name in systems/aimRig.js.
  //
  // Measured on the EYE NORMALS, which are the thing the feature is about.
  // Nothing else here would notice: the head is at the right angle either way,
  // it is simply the wrong angle relative to a viewer.
  const eyeFace = () => {
    const n = uprightRig.anchorNormals.eyeL.clone().add(uprightRig.anchorNormals.eyeR);
    return n.lengthSq() > 1e-8 ? n.normalize() : n;
  };
  // `opts` verbatim rather than a faceOut number, so the "omitting it is the
  // same as passing 0" check below can leave the key out entirely instead of
  // testing a default this helper would have filled in for it.
  const poseOut = (t, opts, target) => {
    cursor.copy(target);
    for (let i = 0; i < 200; i++) {
      upright.quaternion.setFromAxisAngle(_y, t);
      upright.updateMatrixWorld(true);
      bustAim(uprightRig, cursor, wantAim, Math.PI / 2, 1);
      aim.lerp(wantAim, 0.2).normalize();
      uprightRig.update(1 / 60, aim, { engaged: true, ...opts });
      scene.updateMatrixWorld(true);
    }
    return { eyes: eyeFace(), head: upright.getObjectByName('head_07').getWorldPosition(new THREE.Vector3()) };
  };

  const ABOVE = new THREE.Vector3(0, 6, 0);
  const flatEyes = poseOut(-Math.PI / 2, { faceOut: 0 }, ABOVE).eyes;
  const outEyes = poseOut(-Math.PI / 2, { faceOut: 1 }, ABOVE).eyes;
  check('with no lean the faced seal looks straight past the camera',
    flatEyes.z < 0.2, `eyes toward the lens ${flatEyes.z.toFixed(3)}`);
  // 0.9 is twenty-five degrees off the lens. The shipped numbers measure 0.96
  // with the cursor over the buttons; the bar is set where "looking at you"
  // stops being arguable, not at the number, so a retune has room to move.
  check('leaning the target out points the eyes AT it',
    outEyes.z > 0.9, `eyes toward the lens ${outEyes.z.toFixed(3)}`);
  check('...which is the neck bending DOWN out of the sky, not the head levelling',
    outEyes.y < flatEyes.y - 0.2, `eyes up ${flatEyes.y.toFixed(3)} -> ${outEyes.y.toFixed(3)}`);

  // THE RANGE HAS TO SURVIVE IT, and the range that matters is the one a player
  // can see: how far the face swings ON SCREEN between a cursor high over the
  // buttons and one down by the animal's chest.
  //
  // MEASURED AS THE SCREEN-PLANE ANGLE, not as the angle between two 3D
  // directions. Those are different numbers and only one of them is the
  // feature: leaning a unit direction out of the screen necessarily shortens
  // its screen-plane component, so the 3D angle between any two poses shrinks
  // while the direction they PROJECT to is untouched. A 3D reading here would
  // report the head as having lost half its travel while it was tracking the
  // cursor exactly as before, and the obvious "fix" for that would be to weaken
  // the lean the feature is made of.
  //
  // Which is also the reason the lean is ADDED to z rather than lerped toward
  // the camera axis the way the give-up peek is: a lerp really does eat the
  // screen-plane direction, at exactly the moment somebody reaches for a button.
  // BOTH TARGETS INSIDE THE CONE. A cursor low beside a seal standing on its
  // tail is BEHIND its neck, and the head gives up on it and peeks at the
  // viewer instead — measured from there, the flat swing reads about one degree
  // and any comparison against it is noise. Straight up and up-forward are the
  // two the neck actually reaches, and between them is where the buttons are.
  const screenSwing = (out) => {
    const up = poseOut(-Math.PI / 2, { faceOut: out }, new THREE.Vector3(0, 6, 0)).eyes;
    const upA = Math.atan2(up.y, up.x);
    const down = poseOut(-Math.PI / 2, { faceOut: out }, new THREE.Vector3(4.5, 3.5, 0)).eyes;
    const downA = Math.atan2(down.y, down.x);
    let d = upA - downA;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) * 180 / Math.PI;
  };
  const flatSwing = screenSwing(0);
  const outSwing = screenSwing(1);
  check('the neck keeps its on-screen range with the target leaned out',
    outSwing > flatSwing * 0.9,
    `${outSwing.toFixed(0)}deg of screen travel leaned out vs ${flatSwing.toFixed(0)}deg flat`);

  // AND THE WIDER CAP IS PART OF WHAT PAYS FOR IT. Without it the lean is a
  // regression rather than a feature — a head aimed at the lens that has
  // stopped following the cursor — so the guard is proved by turning it off and
  // watching the travel drop. `maxBend` is a budget, and depth spends part of
  // it. Not "collapse": since the chest started leaning in too (faceOutLean),
  // the mid-section carries some of the swing on its own, so the cap's share
  // is a clear margin rather than the whole difference — measured 43 against
  // 51 degrees, where it was 24 against 48 with the neck doing it alone.
  //
  // MEASURED WITH THE CHEST HELD. At the shipped lean the mid-section carries
  // the whole swing on its own and the cap measures the same with or without
  // (45 against 45) — which is not the cap failing, it is the chest making it
  // redundant at this tuning. The cap is the NECK's guard, so it is proved on
  // the neck alone: lean off, the wider cap has to buy travel the old cap
  // cannot, or the first time somebody turns the lean down the head goes stiff
  // with nothing to say why.
  const bendWas = CONFIG.head.faceOutBend;
  const leanHeld = CONFIG.head.faceOutLean;
  CONFIG.head.faceOutLean = 0;
  chestBone.quaternion.copy(chestRest);
  const neckOnly = screenSwing(1);
  CONFIG.head.faceOutBend = 1;
  chestBone.quaternion.copy(chestRest);
  const pinched = screenSwing(1);
  CONFIG.head.faceOutBend = bendWas;
  CONFIG.head.faceOutLean = leanHeld;
  chestBone.quaternion.copy(chestRest);
  check('...and on the neck alone, the wider cap is what pays for it',
    pinched < neckOnly * 0.9,
    `${pinched.toFixed(0)}deg with the run's own cap vs ${neckOnly.toFixed(0)}deg with faceOutBend, chest held`);
  // AND THE MID-SECTION COMES WITH IT. The chest lean (faceOutLean) is not
  // about range — it is a fixed tilt about chest_04 and adds nothing to a
  // sweep, which is why it is not measured as one. It is about where the HEAD
  // ENDS UP: leaning in brings the skull toward the lens, and that is the
  // difference between a seal nodding at you and a seal coming forward to look.
  // So the claim is the head's depth, lean on against lean off, at the same
  // cursor. The sign is the whole test — a lean that took the head away from
  // the camera would pass a magnitude check and read as the animal recoiling.
  //
  // THE CHEST IS PUT BACK BETWEEN THE TWO POSES, by hand. There is no mixer in
  // this harness, and the rig stops OWNING the lean bone the moment the lean is
  // off — it leaves whatever it last wrote on the bone for the clip to
  // overwrite, which in the game it does every frame. Here nothing does, so
  // "lean off" measured second would be the leaned pose again and the two would
  // agree to the millimetre. They did — twice, the second time because the
  // "rest" had been captured after an earlier faceOut pose and was itself the
  // leaned bone. `chestRest` is taken at the top of this block for that reason.
  const leanWas = CONFIG.head.faceOutLean;
  chestBone.quaternion.copy(chestRest);
  const leaned = poseOut(-Math.PI / 2, { faceOut: 1 }, ABOVE).head;
  CONFIG.head.faceOutLean = 0;
  chestBone.quaternion.copy(chestRest);
  const upright2 = poseOut(-Math.PI / 2, { faceOut: 1 }, ABOVE).head;
  CONFIG.head.faceOutLean = leanWas;
  chestBone.quaternion.copy(chestRest);
  check('the chest leans the head TOWARD the lens, not away',
    leaned.z > upright2.z + 0.05,
    `head at z ${leaned.z.toFixed(3)} leaning vs ${upright2.z.toFixed(3)} bolt upright`);
  // ...and it is a lean, not a fall: measured against the animal's own length
  // so a rescale of the seal does not move the threshold.
  check('...by a lean\'s worth, not a collapse',
    leaned.z - upright2.z < 2,
    `${(leaned.z - upright2.z).toFixed(3)} world units forward, on a 2.6-unit animal`);

  // AND A RUN NEVER SEES ANY OF IT. `faceOut` defaults to 0 in the rig, so
  // every existing caller — the run, the title card, every harness — solves the
  // pose it solved before. A default that drifted would tilt the head of every
  // seal in the game and nothing here would be looking at it.
  const byDefault = poseOut(0, {}, ABOVE).eyes.clone();
  const byZero = poseOut(0, { faceOut: 0 }, ABOVE).eyes.clone();
  check('omitting faceOut is the same as passing 0 — a run is untouched',
    byDefault.distanceTo(byZero) < 1e-4, byDefault.distanceTo(byZero).toExponential(1));

  scene.remove(stand);
  cursor.set(0, 6, 0);
}

// ---------------------------------------------------------------------------
section('THE BUST, TURNED — over its own waist, and still');
// ---------------------------------------------------------------------------
// THE MENU'S OWN POSE, plumb and pin included, because the two failures this
// guards only exist there. bustPlumb measures the idle clip's spine curl in
// profile and hands back the counter-rotation that stands the animal up. That
// number is a rotation about the animal's LATERAL axis — which in profile is
// the screen's z, and only in profile. Applied about the screen's z on a
// turned animal, it is a sideways cant: measured 0.65 world units of head off
// the waist at the quarter turn, the seal leaning over with its head behind the
// name tag, and a flipper IK thrown against a limit it oscillated on at 0.16
// units a frame. mainMenu.js composes the plumb AFTER the turn for that
// reason, and the chest lean is about the screen's horizontal so it tips the
// animal at the camera at any turn rather than along its belly. Both are
// numbers a still profile cannot see, so both are measured here at the turns
// the accessories actually ask for.
{
  const holder = new THREE.Object3D();
  scene.add(holder);
  const bust = createVisual('ship');
  holder.add(bust);
  const bustAnim = createAnimationController(bust);
  const bustRig = createAimRig(bust);
  const pin = createBustPin(bust);
  const _z = new THREE.Vector3(0, 0, 1);
  const _y = new THREE.Vector3(0, 1, 0);
  const idle = stateForSpeed(0, false);
  const bAim = new THREE.Vector2(0, 1);
  const bWant = new THREE.Vector2(0, 1);
  const bCursor = new THREE.Vector3(0.9, 3.4, 0);   // over the buttons
  let plumb = 0;
  const qTurn = new THREE.Quaternion();
  const qPlumb = new THREE.Quaternion();
  // The menu's composition, verbatim in shape: cant, then turn, then plumb.
  const stepBust = (turn, faceOut, dt = 1 / 60) => {
    bustAnim?.update(dt, idle, false);
    bust.quaternion.copy(qTurn.setFromAxisAngle(_y, turn)).multiply(qPlumb.setFromAxisAngle(_z, plumb));
    bust.updateMatrixWorld(true);
    bustAim(bustRig, bCursor, bWant, Math.PI / 2 + plumb, 1);
    bAim.lerp(bWant, 1 - Math.exp(-7 * dt)).normalize();
    bustRig.update(dt, bAim, { engaged: true, faceOut });
    pin?.apply();
    bust.updateMatrixWorld(true);
  };
  for (let i = 0; i < 120; i++) stepBust(0, 0);
  plumb = bustPlumb(pin, bustRig);
  for (let i = 0; i < 60; i++) stepBust(0, 0);
  check('the plumb is a real correction, so the test below can fail',
    Math.abs(plumb) > 0.1, `${plumb.toFixed(3)} rad`);

  const at = (n) => bust.getObjectByName(n).getWorldPosition(new THREE.Vector3());
  for (const turn of [-Math.PI / 4, -Math.PI / 2]) {
    const faceOut = Math.abs(Math.sin(turn));
    for (let i = 0; i < 240; i++) stepBust(turn, faceOut);
    const head = at('head_07');
    const waist = at('tail00_019');
    const deg = (turn * 180 / Math.PI).toFixed(0);
    // The waist is pinned; the head is free. Sideways is x on a bust that
    // stands up the screen. The profile itself sits 0.1 off (the curl the plumb
    // could not fully remove), so the bar is a lean you would see, not zero.
    check(`turned ${deg}deg, the head stays over the waist`,
      Math.abs(head.x - waist.x) < 0.25,
      `${(head.x - waist.x).toFixed(3)} world units sideways`);
    check(`...and comes TOWARD the lens`,
      head.z - waist.z > 0.5, `${(head.z - waist.z).toFixed(3)} toward the camera`);
    // Still: the fin tip frame to frame at a steady cursor. The idle clip
    // moves it a little (0.009 measured); the oscillation was twenty times
    // that.
    let jitter = 0;
    let prev = at('hand_L_014');
    for (let i = 0; i < 60; i++) {
      stepBust(turn, faceOut);
      const now = at('hand_L_014');
      jitter = Math.max(jitter, now.distanceTo(prev));
      prev = now;
    }
    check(`...and the flippers hold still at ${deg}deg`,
      jitter < 0.03, `${jitter.toFixed(4)} world units a frame at the tip`);
  }
  scene.remove(holder);
}

resetAccessories();
equipAccessory('accessoryHat');
frame();

// ---------------------------------------------------------------------------
section('BONES');
// ---------------------------------------------------------------------------
// EVERY BONE THE TUNER OFFERS HAS TO BE ONE AN ACCESSORY CAN RIDE. The seal's
// eye bones carry the blink on their SCALE channel (0.2..1.3 across the clips),
// so anything socketed there is squashed several-fold several times a second —
// which is invisible in any still pose and ruinous in motion. This is the same
// guard test:eyes carries, applied to the dropdown so a future bone added to it
// cannot quietly reintroduce the bug.
const boneOptions = new Set();
for (const g of TUNER_SCHEMA) {
  for (const item of g.items ?? []) {
    if (item?.path?.startsWith('accessories.') && item.path.endsWith('.bone')) {
      for (const o of item.options ?? []) boneOptions.add(o);
    }
  }
}
check('the tuner offers a choice of bones', boneOptions.size > 0, `${boneOptions.size}`);

/** How much a bone's scale moves across every clip in the file. */
function scaleSwing(name) {
  let lo = Infinity; let hi = -Infinity; let keyed = false;
  for (const clip of gltf.animations) {
    for (const track of clip.tracks) {
      const [node, prop] = [track.name.slice(0, track.name.lastIndexOf('.')), track.name.split('.').pop()];
      if (prop !== 'scale' || node !== name) continue;
      keyed = true;
      for (const v of track.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  return keyed ? { lo, hi } : null;
}

for (const name of boneOptions) {
  const b = boneOf(body, name);
  check(`${name} is on this rig`, !!b);
  const swing = scaleSwing(name);
  check(`${name}'s scale is not animated`,
    !swing || (Math.abs(swing.hi - swing.lo) < 1e-3),
    swing ? `${swing.lo.toFixed(3)}..${swing.hi.toFixed(3)}` : 'no scale track');
}
// And the guard is proved rather than assumed: the eye bone it exists to keep
// out has to actually fail it. Without this, a `scaleSwing` that quietly
// stopped matching track names would pass every bone above and mean nothing.
const eyeSwing = scaleSwing('eye_L_09');
check('the guard would catch an eye bone (it is the thing being kept out)',
  !!eyeSwing && Math.abs(eyeSwing.hi - eyeSwing.lo) > 1e-3,
  eyeSwing ? `${eyeSwing.lo.toFixed(3)}..${eyeSwing.hi.toFixed(3)}` : 'no scale track found');

// Every accessory in CONFIG needs a full set of sliders, or it is a thing that
// exists and cannot be placed.
section('SCHEMA');
const schemaPaths = new Set(
  TUNER_SCHEMA.flatMap((g) => (g.items ?? []).map((i) => i?.path).filter(Boolean)),
);
for (const key of Object.keys(CONFIG.accessories.items)) {
  for (const field of ['bone', 'snout', 'lift', 'depth', 'pitch', 'yaw', 'roll', 'size']) {
    const path = `accessories.items.${key}.${field}`;
    check(`${key} has a control for ${field}`, schemaPaths.has(path));
  }
}
void HAT;

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failing\n`);
process.exit(failures === 0 ? 0 : 1);
