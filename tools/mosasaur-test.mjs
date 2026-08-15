#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:mosasaur
//
// The mosasaur boss, against the real public/models/mosasaurus.glb — because
// every way this particular asset can be wrong is a way that throws nothing and
// logs nothing.
//
// It is the second entry in the roster whose animation comes from `subclips`
// (the seagull is the first), and that mechanism has three silent failure
// modes stacked on top of the ordinary ones:
//
//   A RANGE THAT MISSES      subclip() keeps whatever keyframes fall inside the
//                            range. A range past the end of the take yields a
//                            clip with no motion in it — a creature frozen mid
//                            -stroke, not an error.
//   THE WRONG FPS            `subclipFps` is the FILE's keyframe rate, not the
//                            display rate. At 30 against this file's 25 every
//                            range lands 20% early: the swim take would start
//                            inside the bite.
//   A RANGE THAT DOES NOT    which is invisible for exactly one loop and then
//   LOOP                     snaps, forever, once every 1.6 seconds.
//
// And two that belong to this body rather than to the mechanism:
//
//   THE JAW GETS DRIVEN      This is one of two models in the game shipping a
//   TWICE                    real `bite` clip. entities/enemies.js skips the
//                            procedural jaw driver only when the controller
//                            reports clipCoverage.bite — if the clip stops
//                            resolving, a second rotation is piled onto the
//                            bone the clip is already writing.
//   THE BITE OUTLASTS ITS    A 1.68s performance on a 1.5s cooldown is an
//   COOLDOWN                 animal due to bite again while its jaws are still
//                            closing on the last one. It is why the megalodon's
//                            "Tear" take goes unused, and the same trap is one
//                            tuning pass away here.
//
// The seam measurements below are the same ones tools/clip-takes.mjs prints,
// taken here on the clips assets.js ACTUALLY BUILT rather than on ranges typed
// into a comment — so a range edited in one place and not the other fails.
//
//   node --import ./tools/vite-loader.mjs tools/mosasaur-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// The file embeds its textures and GLTFLoader decodes those through
// createImageBitmap; without a stub the parse promise never settles and the
// process exits with a bare "unsettled top-level await". Nothing here reads a
// pixel — the bones and the clips are the whole subject.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel, createVisual } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/mosasaurus.glb');
const KEY = 'enemyMosasaur';
const BOSS = 'bossMosasaur';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n${t}`);

if (!existsSync(MODEL)) {
  console.error(`\npublic/models/mosasaurus.glb is missing. Rebuild it:\n  node tools/optimize-mosasaurus.mjs\n`);
  process.exit(1);
}

const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
const def = ASSETS[KEY];
installModel(KEY, gltf.scene, gltf.animations);
const visual = createVisual(KEY);

// ---------------------------------------------------------------------------
section('THE FILE');
// ---------------------------------------------------------------------------
// The take everything is cut out of. Asserted rather than assumed because a
// re-export that renames or re-times it takes every subclip with it.
const source = gltf.animations[0];
check('the reel is still one clip', gltf.animations.length === 1, `${gltf.animations.length} clips`);
check('...and still 13.2s long', Math.abs(source.duration - 13.2) < 0.05, `${source.duration.toFixed(2)}s`);

// THE FRAME RATE, re-derived from the smallest gap between adjacent keys — the
// same way tools/clip-takes.mjs derives it, and the number `subclipFps` has to
// agree with. Smallest gap rather than keys-over-duration: a track with a held
// section has sparse keys through it, and the average reports a rate no
// keyframe was ever authored on.
let step = Infinity;
for (const track of source.tracks) {
  for (let i = 1; i < track.times.length; i++) {
    const d = track.times[i] - track.times[i - 1];
    if (d > 1e-6 && d < step) step = d;
  }
}
const fileFps = Math.round(1 / step);
check(`subclipFps matches the file's own keyframe rate`, def.subclipFps === fileFps,
  `declared ${def.subclipFps}, file is ${fileFps}`);

const frames = Math.round(source.duration * fileFps);
for (const [name, [from, to]] of Object.entries(def.subclips)) {
  check(`"${name}" is inside the take`, to <= frames && from >= 0 && from < to,
    `${from}-${to} of ${frames} frames`);
}

// ---------------------------------------------------------------------------
section('THE STATES');
// ---------------------------------------------------------------------------
// createAnimationController resolves clips by name and `.filter(Boolean)`s the
// misses, so a renamed subclip does not throw — the state simply never plays.
const controller = createAnimationController(visual, def);
check('the controller found real clips', controller.hasRealClips === true);
for (const state of ['idle', 'swim', 'boost', 'bite']) {
  check(`${state} resolves to an action`, controller.clipCoverage[state] === true,
    controller.clipCoverage[state] ? def.animations[state] : 'MISSING');
}

// THE JAW. `wantJaw` in entities/enemies.js is exactly `!clipCoverage.bite`, so
// this is the condition that decides whether the authored 62-degree gape owns
// the bone or gets a procedural rotation piled on top of it.
check('the authored bite owns the jaw — no procedural driver is wanted',
  controller.clipCoverage.bite === true);

// ---------------------------------------------------------------------------
section('THE CUTS — do they hold the motion they claim?');
// ---------------------------------------------------------------------------
const built = new Map(
  Object.keys(def.subclips).map((n) => [n, THREE.AnimationClip.findByName(gltf.animations, n)]),
);
// installModel is what runs buildSubclips, so the cuts live on the installed
// clips rather than on the parse. Fall back to searching the visual's own list.
const clipsFor = (name) => built.get(name)
  ?? THREE.AnimationClip.findByName(ASSETS[KEY].__clips ?? [], name);

// Rebuild the cuts here rather than reaching into assets.js internals: same
// call, same arguments, so this measures the arithmetic the game runs.
const cuts = new Map();
for (const [name, [from, to]] of Object.entries(def.subclips)) {
  const cut = THREE.AnimationUtils.subclip(source.clone(), name, from, to, def.subclipFps);
  cut.duration = (to - from) / def.subclipFps;
  cuts.set(name, cut);
  check(`"${name}" carries keyframes`, cut.tracks.length > 0 && cut.tracks.some((t) => t.times.length > 1),
    `${cut.tracks.length} tracks`);
}

// ---------------------------------------------------------------------------
section('THE SEAMS — which cuts may loop, and which must not');
// ---------------------------------------------------------------------------
// A range loops iff the pose at its first frame and the pose at its last are
// the SAME pose. Measured on bone WORLD POSITIONS, not on quaternions: q and -q
// are the same rotation and would report a difference nobody can see, and it is
// where the flesh ends up that a viewer looks at.
let skinned = null;
visual.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
const bones = skinned.skeleton.bones;

const bbMin = new THREE.Vector3(Infinity, Infinity, Infinity);
const bbMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
visual.updateMatrixWorld(true);
for (const b of bones) {
  const p = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  bbMin.min(p); bbMax.max(p);
}
const SPAN = Math.max(...bbMax.clone().sub(bbMin).toArray());

/**
 * Every bone's world position at time `t` of `clip`.
 *
 * LoopOnce and clampWhenFinished are what make the last frame reachable at all.
 * On the default LoopRepeat, `setTime(clip.duration)` wraps straight back to
 * zero — so a seam measured between t=0 and t=duration compares the first frame
 * with ITSELF and reports a flawless 0.000 for every range, including the ones
 * that snap. That is a green test measuring nothing, which is worse than a red
 * one.
 */
function poseAt(clip, t) {
  const mixer = new THREE.AnimationMixer(visual);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(t);
  // Forced, and not optional: without it every sample comes back identical and
  // nothing throws.
  visual.updateMatrixWorld(true);
  const out = bones.map((b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
  action.stop();
  mixer.uncacheClip(clip);
  return out;
}
const seamOf = (clip) => {
  const a = poseAt(clip, 0);
  const b = poseAt(clip, clip.duration);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i].distanceTo(b[i]);
  return (sum / a.length) / SPAN;
};

// The two LOCOMOTION cuts have to loop — they play on repeat for the whole
// fight. 1% of the body's length is the threshold tools/clip-takes.mjs calls
// clean; both of these measure far under it, and the margin is the point: the
// ranges that were rejected sit at 1.6% to 4%.
for (const name of ['mosaSwim', 'mosaIdle']) {
  const seam = seamOf(cuts.get(name));
  check(`"${name}" loops invisibly`, seam < 0.01, `seam ${(seam * 100).toFixed(3)}% of body span`);
}
// And the BITE must not be judged by that rule at all. It is a one-shot: it
// starts with the mouth shut, opens, strikes, and hands the body back somewhere
// else entirely. A bite whose ends matched would be a bite that went nowhere.
{
  const seam = seamOf(cuts.get('mosaBite'));
  check('"mosaBite" travels — it is a performance, not a loop', seam > 0.01,
    `seam ${(seam * 100).toFixed(3)}%`);
}

// ---------------------------------------------------------------------------
section('THE BITE — the mouth, and the clock it runs against');
// ---------------------------------------------------------------------------
// THE GAPE, measured at the TIP of each bone rather than at its origin. A jaw
// hinges about its own root, so the distance between the jaw bone's origin and
// the skull's never changes no matter how wide the mouth is — measured, it sits
// at 0.2278 units through the entire bite. What separates is the far end, so
// both bones are walked out along the axis their flesh runs down (+X on this
// rig, the same axis the look chain uses) and the tips are what get compared.
//
// Against the SKULL's tip rather than against the world, so a whole-body thrash
// cannot be mistaken for a mouth opening: both points move together when the
// animal moves and apart only when the jaw actually drops.
const jaw = bones.find((b) => b.name === 'Bone021_6');
const skull = bones.find((b) => b.name === 'Bone004_7');
check('the jaw and skull bones are both still in the rig', !!jaw && !!skull);

const JAW_REACH = 260; // local units, the same order as the skull's own reach
const gapeNow = () => {
  visual.updateMatrixWorld(true);
  const a = jaw.localToWorld(new THREE.Vector3(JAW_REACH, 0, 0));
  const b = skull.localToWorld(new THREE.Vector3(JAW_REACH, 0, 0));
  return a.distanceTo(b);
};

const bite = cuts.get('mosaBite');
let maxGape = 0;
let closedAtStart = null;
let closedAtEnd = null;
{
  const mixer = new THREE.AnimationMixer(visual);
  const action = mixer.clipAction(bite);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const SAMPLES = 40;
  for (let i = 0; i <= SAMPLES; i++) {
    mixer.setTime((bite.duration * i) / SAMPLES);
    const gape = gapeNow();
    if (i === 0) closedAtStart = gape;
    if (i === SAMPLES) closedAtEnd = gape;
    maxGape = Math.max(maxGape, gape);
  }
  action.stop();
  mixer.uncacheClip(bite);
}
check('the mouth actually opens during the bite', maxGape > closedAtStart + 0.3,
  `jaw tip ${closedAtStart.toFixed(2)} -> ${maxGape.toFixed(2)} units off the skull's`);
check('...and it starts and ends CLOSED, so it blends back into the swim',
  Math.abs(closedAtEnd - closedAtStart) < (maxGape - closedAtStart) * 0.35,
  `shut ${closedAtStart.toFixed(2)}, peak ${maxGape.toFixed(2)}, shut again ${closedAtEnd.toFixed(2)}`);

// THE CLOCK. The megalodon's "Tear" take is 2.93s against a 1.5s cooldown and
// is unused for exactly this reason — see the note on enemyMegalodon.
const cooldown = CONFIG.enemies[BOSS]?.hunt?.biteCooldown;
check('the boss has a bite cooldown at all', Number.isFinite(cooldown), `${cooldown}`);
check('the bite finishes before the animal is due to bite again',
  bite.duration <= cooldown, `clip ${bite.duration.toFixed(2)}s, cooldown ${cooldown}s`);

// ---------------------------------------------------------------------------
section('THE HEAD — where the look chain thinks the snout is');
// ---------------------------------------------------------------------------
// tipLength is in the tip bone's OWN local units, which tipWorld() hands to
// localToWorld — so the armature's scale is applied for us, and a value copied
// from a world measurement lands the effector a quarter of the way down the
// jaw. The check is that the tip is out at the snout: past the furthest vertex
// the skull drives would be too far, well short of it too near.
const look = def.lookRig.head;
const tipBone = bones.find((b) => b.name === look.bones.at(-1));
check('the look chain resolves on the model',
  look.bones.every((n) => bones.some((b) => b.name === n)), look.bones.join(' -> '));

visual.updateMatrixWorld(true);
const axis = { '+X': [1, 0, 0], '+Y': [0, 1, 0], '+Z': [0, 0, 1] }[look.tipAxis];
const tip = tipBone.localToWorld(new THREE.Vector3(...axis).multiplyScalar(look.tipLength));

// WHICH WAY IS FORWARD, read off the RIG rather than off `def.forward`. The def
// declares the model's own axis; createVisual then reorients the whole animal
// onto the game's convention, so by the time there is a visual to measure, +Z
// is not where the snout is (it is +Y, and only because of that reorientation).
// Taking the direction from the tail chain's last bone to the head bone is
// independent of both — and independent of the tipAxis being tested here, which
// is the point: deriving forward FROM the tip would make this check agree with
// itself no matter what.
const tailTip = bones.find((b) => b.name === 'Bone017_14');
const headAt = new THREE.Vector3().setFromMatrixPosition(tipBone.matrixWorld);
const fwd = headAt.clone().sub(new THREE.Vector3().setFromMatrixPosition(tailTip.matrixWorld)).normalize();

// How far the animal actually reaches ahead of its head bone.
let snout = -Infinity;
{
  const pos = skinned.geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    skinned.applyBoneTransform(i, v);
    v.applyMatrix4(skinned.matrixWorld);
    snout = Math.max(snout, v.dot(fwd));
  }
}
const reach = (tip.dot(fwd) - headAt.dot(fwd)) / (snout - headAt.dot(fwd));
check('the look effector sits at the snout, not inside the skull',
  reach > 0.8 && reach < 1.25,
  `${(reach * 100).toFixed(0)}% of the way from the head bone to the snout tip`);

// ---------------------------------------------------------------------------
console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
