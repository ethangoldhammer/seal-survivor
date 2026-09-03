#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:whale
//
// THE BOWHEAD SWEEP — a whale that crosses the arena on a timer and takes the
// small stuff out of the water. See CONFIG.whale and systems/whale.js.
//
// The failures worth catching here are the ones that leave a whale visibly
// swimming across the screen while doing the wrong thing, because none of them
// throw:
//
//   THE MODEL      the source .fbx is FBX 6100 and unreadable, so the shipped
//                  .glb comes out of tools/build-whale.mjs. Three things that
//                  build fixes can each silently come back on a re-export: the
//                  empty "Take 001" (which would bind as a locomotion state and
//                  suppress the only thing animating this animal), the two
//                  baked directional lights (which would brighten the arena a
//                  little more with every sweep), and the unnamed morph targets
//                  (which would leave the gape reaching for an index).
//   THE AXIS       rotating this rig's spine about local Y sweeps the tail
//                  sideways like a fish and about local Z sweeps it up and down
//                  like a whale. 'y' is this project's default and every fish in
//                  the roster uses it, so the wrong answer is the one a guess
//                  lands on — and a bowhead swimming like a trout is wrong in a
//                  way you see instantly at 31 units long.
//   THE CADENCE    "a valve, not a metronome" and "a crowded screen pulls the
//                  next one in" are claims about MINUTES. At 60fps they are
//                  invisible; to a simulated run they take a millisecond.
//   THE MENU       `maxPreyRadius` is one number standing between a housekeeping
//                  event and one that eats the sharks you were meant to fight.
//                  It is checked against the live enemies.csv rather than a
//                  typed list, so a new creature lands on one side of it here.
//   THE CAPSULE    a 31-unit animal tested for contact as a circle at its own
//                  centre misses the seal along most of its length. The shove
//                  has to fire from the flank as well as from the head.
//   THE SILHOUETTE ...and it has to STOP firing where the animal stops. A
//                  constant radius is over twice the real half-height across
//                  eleven of this body's twenty-four sections and nineteen
//                  times it at the fluke, which is a seal thrown by open water.
//                  Measured off the real glb, because the stand-in every other
//                  section below runs on is a cone — convex, symmetric and
//                  tapered exactly the way a wrong profile would guess.
//   THE ORBS       what the whale swallows pays NOTHING. The one line enforcing
//                  that is an empty callback, which is exactly the kind of thing
//                  a later edit "fixes".
//
// Everything expected is derived from CONFIG and the CSVs rather than typed in:
// saved tuning is merged over the defaults at import, so a hardcoded 5.5 would
// be testing imported-tuning.json rather than the code.
//
// What it cannot tell you: whether the sweep FEELS like relief when it arrives
// mid-fight. That is a run.
//
//   node --import ./tools/vite-loader.mjs tools/whale-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, TUNER_SCHEMA } from '../path/src/config.js';
import { ASSETS, orientationQuaternion } from '../path/src/assets.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import { enemies, resetEnemies } from '../path/src/entities/enemies.js';
import { pickups, resetPickups } from '../path/src/entities/pickups.js';
import {
  whaleClock, resetWhaleClock, updateWhaleClock, isPrey, headingFor, intakeRadius, mouthAheadOf,
  resetWhales, spawnWhale, updateWhales, whaleCount,
  measureBodyProfile, sectionAt, bodyDistance,
} from '../path/src/systems/whale.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// Seeded. Every statistical claim below is averaged over fixed seeds — a Monte
// Carlo assertion on Math.random fails one run in fifty for no reason, and the
// standard "fix" is to loosen the threshold until it stops.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEEDS = [1, 7, 13, 42, 99];

const C = CONFIG.whale;
updateBounds(16 / 9);

// ===========================================================================
section('THE MODEL — public/models/whale.glb, built by tools/build-whale.mjs');

const buf = readFileSync(resolve(HERE, '../public/models/whale.glb'));
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
const model = gltf.scene;
model.updateMatrixWorld(true);

let skin = null;
let lights = 0;
const boneNames = new Set();
model.traverse((o) => {
  if (o.isSkinnedMesh) skin ??= o;
  if (o.isLight) lights++;
  if (o.isBone) boneNames.add(o.name);
});

check('the empty "Take 001" is not shipped', gltf.animations.length === 0,
  gltf.animations.length
    ? `${gltf.animations.length} clip(s) survived — they would bind as a locomotion state and kill the wag`
    : 'no clips, so the procedural rig owns the body');
check('the baked directional lights are stripped', lights === 0, `${lights} in the file`);
check('the skin survived', !!skin, skin ? `${skin.skeleton.bones.length} joints` : 'none');

// The morph targets, by NAME. The C4D exporter writes none, so this is entirely
// the build step's doing and entirely what the gape depends on.
const dict = skin?.morphTargetDictionary ?? {};
for (const name of Object.values(ASSETS.whale.morphs)) {
  check(`morph target "${name}" is named in the file`, dict[name] != null,
    dict[name] != null ? `index ${dict[name]}` : `dictionary is {${Object.keys(dict).join(', ')}}`);
}

// ...and that driving one by name actually moves the mesh. A dictionary entry
// is a promise about an index; this is the thing itself.
if (skin && dict.mouthWide != null) {
  const sample = [];
  const p = new THREE.Vector3();
  for (let v = 0; v < skin.geometry.attributes.position.count; v += 5) {
    skin.getVertexPosition(v, p); sample.push(p.clone());
  }
  skin.morphTargetInfluences[dict.mouthWide] = 1;
  let moved = 0;
  let k = 0;
  for (let v = 0; v < skin.geometry.attributes.position.count; v += 5) {
    skin.getVertexPosition(v, p); moved = Math.max(moved, p.distanceTo(sample[k++]));
  }
  skin.morphTargetInfluences[dict.mouthWide] = 0;
  const box = new THREE.Box3().setFromObject(model);
  const len = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  check('the wide gape actually opens the jaw', moved > len * 0.08,
    `${moved.toFixed(1)} units on a ${len.toFixed(0)}-unit body (${(moved / len * 100).toFixed(1)}%)`);
}

// Every bone the asset entry names has to exist, or the wag silently drives
// nothing — animation.js only warns when the model ALSO has no clips to fall
// back on, and this model having no clips is exactly the case that warns.
const rig = ASSETS.whale.rig;
const named = [
  ...rig.wagChain,
  ...(rig.headChain ?? []),
  ...(rig.springChains ?? []).flatMap((c) => c.names),
];
const missing = named.filter((n) => !boneNames.has(n));
check('every bone named by ASSETS.whale.rig exists on the model', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${named.length} bones`);

// ===========================================================================
section('THE BEND AXIS — dorsoventral, not lateral');

// Measured by skinning, not read off a name. Rotate one spine bone about the
// configured axis and see which way the flesh goes: world Y is a whale's
// stroke, world X is a fish's.
if (skin) {
  const bone = model.getObjectByName(rig.wagChain[0]);
  const rest = bone.quaternion.clone();
  const grab = () => {
    // Forced, or every pose measures identical and nothing throws.
    model.updateMatrixWorld(true);
    const out = [];
    const p = new THREE.Vector3();
    for (let v = 0; v < skin.geometry.attributes.position.count; v += 11) {
      skin.getVertexPosition(v, p); out.push(p.clone().applyMatrix4(skin.matrixWorld));
    }
    return out;
  };
  const base = grab();
  bone.rotation[rig.axis] += 0.35;
  const now = grab();
  bone.quaternion.copy(rest);
  model.updateMatrixWorld(true);

  const dir = new THREE.Vector3();
  let maxD = 0;
  for (let i = 0; i < now.length; i++) {
    const d = now[i].distanceTo(base[i]);
    dir.add(new THREE.Vector3().subVectors(now[i], base[i]).multiplyScalar(d));
    maxD = Math.max(maxD, d);
  }
  dir.normalize();
  check(`rig.axis '${rig.axis}' sweeps the body DORSOVENTRALLY`,
    Math.abs(dir.y) > Math.abs(dir.x) * 1.5,
    `displacement direction [${dir.x.toFixed(2)}, ${dir.y.toFixed(2)}, ${dir.z.toFixed(2)}]`
    + ` — |y| must beat |x|, or this whale swims like a trout`);
  check('...and it moves a useful amount of body', maxD > 1,
    `${maxD.toFixed(1)} units at 0.35 rad`);

  // The chain has to run root-to-tip, or the phase offset in proceduralDrive
  // runs the wave up the animal instead of down it.
  const zOf = (n) => {
    const b = model.getObjectByName(n);
    return b ? b.getWorldPosition(new THREE.Vector3()).z : NaN;
  };
  const zs = rig.wagChain.map(zOf);
  const descending = zs.every((z, i) => i === 0 || z < zs[i - 1]);
  check('the wag chain is ordered root-to-tip along the body',
    descending, `z runs ${zs.map((z) => z.toFixed(0)).join(' -> ')} (head is +Z)`);
}

// ===========================================================================
section('THE OTHER BODY — public/models/humpback.glb, built by tools/build-humpback.mjs');
//
// The sweep can wear either animal (CONFIG.whale.asset). The humpback is the
// clip-driven one, and the things that go wrong with it are different from the
// bowhead's: a texture that was meant to be stripped coming back (the body is
// painted, and a map underneath the pigment is a photograph bleeding through),
// the Sketchfab water quad surviving (it floats 5 units above the animal and
// every measurement in systems/whale.js comes off the bounding box), a clip
// name that no longer matches the mapping (the body holds still, silently),
// and a bone name that GLTFLoader's sanitizer changed under us.
{
  const H = ASSETS.humpbackWhale;
  check('CONFIG.whale.asset names a registered model', !!ASSETS[C.asset]?.model, `"${C.asset}"`);
  check('the tuner can switch bodies and pace the loop',
    ['whale.asset', 'whale.clipSpeed'].every((p) => TUNER_SCHEMA.some((g) => g.items?.some((i) => i.path === p))));
  check('clipSpeed is a slow-down, not a speed-up', C.clipSpeed > 0 && C.clipSpeed <= 1, `${C.clipSpeed}x`);

  const hbuf = readFileSync(resolve(HERE, '../public/models/humpback.glb'));
  const hg = await new GLTFLoader().parseAsync(
    hbuf.buffer.slice(hbuf.byteOffset, hbuf.byteOffset + hbuf.byteLength), '',
  );
  const hm = hg.scene;
  hm.updateMatrixWorld(true);
  const meshes = [];
  const bones = new Set();
  hm.traverse((o) => { if (o.isMesh) meshes.push(o); if (o.isBone) bones.add(o.name); });
  check('one skinned mesh — the water quad is gone', meshes.length === 1 && meshes[0].isSkinnedMesh,
    meshes.map((m) => `${m.name} (${m.geometry.attributes.position.count} verts)`).join(', '));
  const mats = meshes.flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material]));
  check('no texture in the file — the pigment is the hide', mats.every((m) => !m.map),
    mats.map((m) => m.type).join(', '));
  check('the material is lit (KHR_materials_unlit stripped) so it can band', mats.every((m) => !m.isMeshBasicMaterial),
    mats.map((m) => m.type).join(', '));
  const clipName = H.animations?.idle;
  const eat = hg.animations.find((a) => a.name === clipName);
  check(`the mapped clip "${clipName}" is in the file`, !!eat,
    eat ? `${eat.duration.toFixed(3)}s, ${eat.tracks.length} tracks` : `clips: ${hg.animations.map((a) => a.name).join(', ')}`);
  const named = (H.rig.springChains ?? []).flatMap((c) => c.names);
  const missing = named.filter((n) => !bones.has(n));
  check('every bone the spring chains name exists after the loader\'s sanitizer', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${named.length} bones`);

  // Head at +Z, as `forward` claims — the jaw ahead of the fluke.
  const jaw = hm.getObjectByName('jaw');
  const fluke = hm.getObjectByName('tailFin02');
  if (jaw && fluke) {
    const jz = jaw.getWorldPosition(new THREE.Vector3()).z;
    const fz = fluke.getWorldPosition(new THREE.Vector3()).z;
    check('the jaw is at +Z and the fluke at -Z, so forward:+Z is the nose', jz > 0 && fz < 0,
      `jaw z ${jz.toFixed(2)}, fluke z ${fz.toFixed(2)}`);
  }
  // ...and the clip actually works the jaw. A clip that binds but keys nothing
  // we can see is the same as no clip.
  if (eat && jaw) {
    const rest = jaw.quaternion.clone();
    const mixer = new THREE.AnimationMixer(hm);
    const action = mixer.clipAction(eat);
    action.play();
    let widest = 0;
    for (let i = 0; i < 20; i++) {
      mixer.update(eat.duration / 20);
      widest = Math.max(widest, rest.angleTo(jaw.quaternion));
    }
    check('the feeding loop opens the jaw', widest > 0.5,
      `${(widest * 180 / Math.PI).toFixed(0)}° at the widest`);
  }
}

// ===========================================================================
section('THE HEADING — the whale swims flat, not on its tail');

// The bug this exists for: `createVisual` points every model's `forward` at
// world +Y, so a container at rotation.z = 0 is a whale standing on its tail
// and sliding sideways across the arena. It shipped that way, and nothing threw.
//
// Checked by taking the model's own forward axis through the heading rotation
// and seeing where it ends up, rather than by comparing the angle to a number —
// an assertion that the answer is -PI/2 is just the same mistake written twice.
{
  const FORWARD = new THREE.Vector3(0, 1, 0); // what createVisual aims down
  for (const [dir, label, wantX] of [[1, 'swimming right', 1], [-1, 'swimming left', -1]]) {
    const v = FORWARD.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), headingFor(dir));
    check(`${label}: the nose points along the direction of travel`,
      Math.abs(v.x - wantX) < 1e-6 && Math.abs(v.y) < 1e-6,
      `forward ends up [${v.x.toFixed(2)}, ${v.y.toFixed(2)}] — y must be 0 or the animal is nose-up`);
  }
  // The bank leans the nose off horizontal, and by the amount asked for.
  const leaned = FORWARD.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), headingFor(1, 0.2));
  check('bank tilts the nose off the horizontal', Math.abs(leaned.y) > 0.15,
    `nose y = ${leaned.y.toFixed(2)} at 0.2 rad of bank`);
  // ...and in the SAME sense whichever way it is swimming, since the side-view
  // mirror reverses the apparent direction.
  const leftLean = FORWARD.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), headingFor(-1, 0.2));
  check('...in the same sense in both directions',
    Math.sign(leaned.y) === Math.sign(leftLean.y),
    `right ${leaned.y.toFixed(2)}, left ${leftLean.y.toFixed(2)}`);
}

// ===========================================================================
section('THE SILHOUETTE — the hitbox is the animal, not a tube around it');

// MEASURED OFF THE REAL glb, and it has to be. Everything below THE CROSSING
// runs on the cone stand-in createVisual falls back to with no model loaded,
// and a cone is convex, symmetric about its own axis and tapers exactly the way
// a naive profile would guess — so a silhouette bug is invisible to every one
// of those checks. This section builds the profile from the file that ships.
//
// The whale is measured in ENTITY space, which is the frame createVisual hands
// its visual back in: +Y is the direction of travel, +X is what the camera
// reads as the animal's height. So the model is wrapped in a group and turned
// by the game's own orientationQuaternion rather than by an angle typed here.
const entity = new THREE.Group();
{
  const posed = model.clone(true);
  posed.quaternion.copy(orientationQuaternion(ASSETS.whale));
  entity.add(posed);
}
const profile = measureBodyProfile(entity.children[0]);
check('the body profile could be measured at all', !!profile,
  profile ? `${profile.n} sections over ${(profile.maxS - profile.minS).toFixed(0)} source units` : 'null');

if (profile) {
  const entityBox = new THREE.Box3().setFromObject(entity);
  const eSize = entityBox.getSize(new THREE.Vector3());
  // t: 0 at the fluke, 1 at the nose.
  const at = (t) => sectionAt(profile, profile.minS + (profile.maxS - profile.minS) * t);
  const halfAt = (t) => at(t).half;

  console.log(`  entity box ${eSize.x.toFixed(1)} tall x ${eSize.y.toFixed(1)} long x ${eSize.z.toFixed(1)} wide`);
  console.log('  half-height along the body: '
    + [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map((t) => `${t.toFixed(2)}:${halfAt(t).toFixed(1)}`).join('  '));

  // NO HOLES. This model is 2812 triangles over 180 units, so binning the
  // VERTICES alone leaves empty bins in the middle of the animal — measured,
  // three of twenty-four, straddling the widest part of the body. An empty bin
  // is a section with no thickness: a hole through the whale that the seal
  // swims into without being shoved, and it looks exactly like a correct taper.
  let thinnest = Infinity;
  for (let i = 0; i < profile.n; i++) thinnest = Math.min(thinnest, (profile.hi[i] - profile.lo[i]) * 0.5);
  check('every section along the body has thickness', thinnest > 0,
    `thinnest section ${thinnest.toFixed(2)} — 0 is a hole you can swim through`);

  // THE TAPER, which is the whole point. A bowhead's tail stock is a stalk and
  // its fluke is a blade; a constant radius shoves the seal from open water for
  // most of the length of the animal.
  const fluke = halfAt(0.05);
  const barrel = halfAt(0.5);
  check('the fluke is a fraction of the barrel', fluke < barrel * 0.25,
    `${fluke.toFixed(1)} at the fluke against ${barrel.toFixed(1)} through the body`);
  check('...and the barrel is the thickest part of it', barrel > halfAt(0.95) * 1.5,
    `${barrel.toFixed(1)} amidships against ${halfAt(0.95).toFixed(1)} at the nose`);

  // WHAT THE OLD CAPSULE CLAIMED. Half the smallest of the three extents, held
  // constant end to end and centred on the container origin — printed as a
  // multiple of the real half-height so the number is the size of the fix.
  const oldRadius = Math.min(eSize.x, eSize.y, eSize.z) * 0.5;
  let over = 0;
  for (let i = 0; i < profile.n; i++) if (oldRadius > (profile.hi[i] - profile.lo[i]) * 0.5 * 2) over++;
  console.log(`  the old constant radius was ${oldRadius.toFixed(1)}`
    + ` — over twice the real half-height across ${over} of ${profile.n} sections`
    + `, and ${(oldRadius / fluke).toFixed(0)}x it at the fluke`);
  check('the old constant radius really was claiming water the animal is not in',
    over > profile.n * 0.3, `${over} of ${profile.n} sections`);

  // OFF ITS OWN ORIGIN. ASSETS.whale.pivot puts the instance origin near the
  // skull and the body hangs below the axis, so a capsule symmetric about zero
  // is not even centred on the animal it stands in for.
  check('the body does not sit centred on its container origin',
    Math.abs(at(0.5).mid) > barrel * 0.2,
    `centre of the barrel is ${at(0.5).mid.toFixed(1)} off the origin`);
}

// ---------------------------------------------------------------------------
// And the contact test that reads it. bodyDistance takes a point into the
// animal's own frame first, so it is the thing that has to get the heading, the
// side-view mirror and the off-centre profile right all at once.
if (profile) {
  // A container EACH, not one reused. Both headings are live at the same time
  // in the mirror check below, and a shared object would have the second `fake`
  // silently re-aim the first one — which is a test comparing a whale to itself.
  const fake = (dir) => {
    const container = new THREE.Object3D();
    container.rotation.z = headingFor(dir);
    return {
      container,
      profile,
      flip: dir < 0,
      length: profile.maxS - profile.minS,
      bodyRadius: profile.thickest,
    };
  };
  // (along, across) in the animal's own frame -> world, through the same
  // rotation bodyDistance will undo. Written as the inverse rather than as a
  // second guess at the maths: a test that builds its points with the same
  // mistake as the code passes on any heading at all.
  const world = (w, along, across) => {
    const th = w.container.rotation.z;
    const ex = (w.flip ? -1 : 1) * across;
    return [Math.cos(th) * ex - Math.sin(th) * along, Math.sin(th) * ex + Math.cos(th) * along];
  };
  const on = (w, along, across) => bodyDistance(w, ...world(w, along, across)) === 0;

  const mid = profile.minS + (profile.maxS - profile.minS) * 0.5;
  const sec = sectionAt(profile, mid);
  const right = fake(1);

  check('a point inside the barrel is on the body', on(right, mid, sec.mid));
  check('...and one just outside its dorsal edge is not', !on(right, mid, sec.mid - sec.half * 1.2));
  // THE ASYMMETRY, which is what the flip has to preserve. The pectorals hang
  // a long way below this animal's axis and nothing hangs above it, so the same
  // distance either side of the container origin is one point on the whale and
  // one point in open water.
  const reach = Math.max(Math.abs(sec.mid - sec.half), Math.abs(sec.mid + sec.half));
  const deep = -reach * 0.95; // toward the model's back, in entity X
  check('the body reaches further one side of its origin than the other',
    on(right, mid, deep) !== on(right, mid, -deep),
    `entity X ${deep.toFixed(1)} vs ${(-deep).toFixed(1)}`);
  // ...and that stays true of the SCREEN when it turns round, because the side
  // view mirrors the visual. Same world point, both headings: a whale drawn the
  // same way up has to be hit the same way up.
  const left = fake(-1);
  const [rx, ry] = world(right, mid, deep);
  const [lx, ly] = world(left, mid, deep);
  check('...and the mirror keeps the hitbox the same way up as the drawing',
    Math.abs(ry - ly) < 1e-6 && Math.abs(rx + lx) < 1e-6
    && bodyDistance(right, rx, ry) === 0 && bodyDistance(left, lx, ly) === 0,
    `the animal's back is at y ${ry.toFixed(1)} swimming right and y ${ly.toFixed(1)} swimming left`
    + ' — the same height, on the other side of the screen');

  // The one that was worst before. Beside the tail, a body-radius off the axis:
  // open water on any picture of this animal, and a shove under the old test.
  const tailS = profile.minS + (profile.maxS - profile.minS) * 0.05;
  const tailSec = sectionAt(profile, tailS);
  check('open water beside the tail is not the whale',
    !on(right, tailS, tailSec.mid + profile.thickest * 0.6),
    `${(profile.thickest * 0.6).toFixed(1)} off a tail ${tailSec.half.toFixed(1)} thick`);
  check('...but the fluke itself still is', on(right, tailS, tailSec.mid));
}

// ===========================================================================
section('THE CADENCE — a valve, not a metronome');

{
  // Over ten minutes, how many sweeps and how far apart.
  const runs = SEEDS.map((seed) => {
    const rand = mulberry32(seed);
    resetWhaleClock(rand);
    const at = [];
    let t = 0;
    for (let i = 0; i < 60 * 600; i++) {
      t += 1 / 60;
      if (updateWhaleClock(1 / 60, 0, rand)) at.push(t);
    }
    return at;
  });
  const counts = runs.map((r) => r.length);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const expected = (600 - C.firstAt) / ((C.intervalMin + C.intervalMax) / 2);
  console.log(`  ${avg.toFixed(1)} sweeps in a ten-minute quiet run (${counts.join(', ')})`);
  check('the quiet cadence matches its configured interval',
    Math.abs(avg - expected) < expected * 0.3, `expected about ${expected.toFixed(1)}`);

  const firsts = runs.map((r) => r[0] ?? Infinity);
  check('no sweep lands before whale.firstAt',
    firsts.every((f) => f >= C.firstAt), `earliest ${Math.min(...firsts).toFixed(1)}s, gate ${C.firstAt}s`);
  // Held at zero rather than left to run negative, or every run would fire its
  // first sweep on exactly the same second.
  const spread = Math.max(...firsts) - Math.min(...firsts);
  check('...and the first one is not pinned to that exact second',
    spread > 1, `${spread.toFixed(1)}s of spread across ${SEEDS.length} seeds`);

  const gaps = runs.flatMap((r) => r.slice(1).map((t, i) => t - r[i]));
  check('two sweeps never land inside ten seconds of each other',
    gaps.every((g) => g > 10), `tightest gap ${Math.min(...gaps).toFixed(1)}s`);
  check('...and never further apart than the configured maximum',
    gaps.every((g) => g <= C.intervalMax + 0.1), `widest gap ${Math.max(...gaps).toFixed(1)}s`);
}

{
  // The valve. A crowded screen has to actually pull the next sweep in.
  const busy = (pop) => {
    const counts = SEEDS.map((seed) => {
      const rand = mulberry32(seed);
      resetWhaleClock(rand);
      let n = 0;
      for (let i = 0; i < 60 * 600; i++) if (updateWhaleClock(1 / 60, pop, rand)) n++;
      return n;
    });
    return counts.reduce((a, b) => a + b, 0) / counts.length;
  };
  const quiet = busy(0);
  const crowded = busy(C.crowdThreshold + 1);
  console.log(`  quiet ${quiet.toFixed(1)} sweeps, crowded ${crowded.toFixed(1)}`);
  check('a crowded screen brings sweeps in faster', crowded > quiet * 1.4,
    `${(crowded / quiet).toFixed(2)}x — this is the whole reason it is a valve`);
  // Continuous rather than a one-frame rewrite of the timer: burning the clock
  // at 1/crowdRush should land near that multiple, not at some arbitrary number.
  const want = 1 / C.crowdRush;
  check('...at about the configured rush multiple',
    Math.abs(crowded / quiet - want) < want * 0.35,
    `${(crowded / quiet).toFixed(2)}x against 1/crowdRush = ${want.toFixed(2)}x`);
  check('the sweep is still an event, not a parade', crowded < 600 / 20,
    `one every ${(600 / crowded).toFixed(0)}s at full crowd`);
}

{
  // The concurrency gate. A crossing now outlasts the crowded interval, so
  // without this a busy screen fills with whales — the exact opposite of a
  // spawn-pressure valve.
  const scene0 = new THREE.Scene();
  resetWhales(scene0);
  const rand = mulberry32(5);
  resetWhaleClock(rand);
  // Put one in the water and never update it, so it never leaves.
  whaleClock.timer = 0;
  whaleClock.elapsed = C.firstAt + 1;
  spawnWhale(scene0, mulberry32(5));
  let more = 0;
  for (let i = 0; i < 60 * 900; i++) if (updateWhaleClock(1 / 60, 999, rand)) more++;
  check('a sweep already in the water blocks the next one', more === 0,
    more ? `${more} extra sweeps called over 15 minutes at full crowd` : `maxAlive ${C.maxAlive}`);
  resetWhales(scene0);
  // ...and the clock is not left holding banked credit that fires the instant
  // the first one leaves.
  const fired = updateWhaleClock(1 / 60, 0, rand);
  check('...and does not fire the moment it leaves', !fired || whaleClock.timer > 0);
}

// A sweep has to be an EVENT, and that is a claim about the crossing time
// against the gap, not about either alone. `speed` and the interval rows move
// together or the animal is on screen permanently.
{
  const crossing = (bounds.width + 22 * 2) / C.speed;
  console.log(`  one crossing is ${crossing.toFixed(0)}s at ${C.speed} u/s`
    + `  ·  quiet gap ${C.intervalMin}-${C.intervalMax}s`
    + `  ·  crowded gap ${(C.intervalMin * C.crowdRush).toFixed(0)}-${(C.intervalMax * C.crowdRush).toFixed(0)}s`);
  check('the water is whale-free for most of a quiet run',
    crossing < C.intervalMin * 0.6,
    `${crossing.toFixed(0)}s of animal per ${C.intervalMin}s at the tightest quiet gap`);
}

check('whale.enabled off means no sweeps at all', (() => {
  const was = CONFIG.whale.enabled;
  CONFIG.whale.enabled = false;
  const rand = mulberry32(1);
  resetWhaleClock(rand);
  let n = 0;
  for (let i = 0; i < 60 * 600; i++) if (updateWhaleClock(1 / 60, 999, rand)) n++;
  CONFIG.whale.enabled = was;
  return n === 0;
})());

// ===========================================================================
section('THE MENU — what it is allowed to swallow');

// Against the LIVE roster — CONFIG.enemies after enemies.csv has been merged
// over it — so a new creature lands on one side of this line here rather than
// in a run.
//
// This calls the SAME `isPrey` the gulp calls rather than re-implementing the
// radius test, because the two are exactly the kind of pair that drifts: the
// gate grew a boss check that a mirrored copy here would not have, and the
// mirrored copy would have gone on passing while the real one changed.
{
  const eaten = [];
  const spared = [];
  for (const [id, def] of Object.entries(CONFIG.enemies)) {
    const r = Number(def.radius);
    if (!Number.isFinite(r)) continue;
    // The struct the gate reads: a creature spawned at its listed size, with
    // no live boss flag — i.e. the most permissive case, so anything spared
    // here is spared for a reason in the def rather than in the moment.
    const e = { def, radius: r, isBoss: false, mesh: { position: new THREE.Vector3() } };
    (isPrey(e, C) ? eaten : spared).push(`${id}(${r})`);
  }
  console.log(`  swallowed: ${eaten.join(' ')}`);
  console.log(`  spared:    ${spared.join(' ')}`);
  const isEaten = (id) => eaten.some((e) => e.startsWith(`${id}(`));
  check('the schools are on the menu', isEaten('fish') && isEaten('trout') && isEaten('tang'));
  check('every shark is off it',
    !isEaten('shark') && !isEaten('greatWhite') && !isEaten('megalodon') && !isEaten('hammerhead'));
  check('every boss body is off it',
    !Object.keys(CONFIG.enemies).some((id) => id.startsWith('boss') && isEaten(id)));
  check('the invincible sea turtle is off it', !isEaten('seaTurtle'));
  // The radius check is the ONLY gate on size, so something has to still be
  // spared — a maxPreyRadius nudged past the sharks turns the sweep from
  // housekeeping into an event that clears the fight for you.
  check('the sweep leaves the real threats in the water', spared.length >= 10,
    `${eaten.length} on the menu, ${spared.length} spared`);
}

// ===========================================================================
section('THE CROSSING');

// A stand-in for the enemy struct. The real spawn path needs a loaded model and
// a live scene; what updateWhales actually reads off a creature is its position,
// its radius and its boss/invincible flags.
const scene = new THREE.Scene();
function fakeEnemy(x, y, radius, extra = {}) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return { mesh, radius, def: {}, hp: 10, ...extra };
}
function seed(list) {
  resetEnemies(scene);
  for (const e of list) enemies.push(e);
}

{
  resetWhales(scene);
  seed([]);
  const w = spawnWhale(scene, mulberry32(3));
  check('it spawns fully offscreen',
    w.container.position.x < bounds.left - w.length * 0.5
    || w.container.position.x > bounds.right + w.length * 0.5,
    `x=${w.container.position.x.toFixed(1)} against arena [${bounds.left.toFixed(0)}, ${bounds.right.toFixed(0)}], body ${w.length.toFixed(1)} long`);
  check('...at a depth inside the configured band', (() => {
    const span = bounds.surfaceY - bounds.bottom;
    const d = (bounds.surfaceY - w.baseY) / span;
    return d >= C.depthMin - 1e-6 && d <= C.depthMax + 1e-6;
  })(), `y=${w.baseY.toFixed(1)}`);
  // The length is MEASURED off the instance, not derived from `fit` — fit
  // scales a grandchild and the size row scales the root, so no single number
  // in the asset entry is the animal's world length.
  check('...and its body length was measured, not assumed', w.length > 1 && w.bodyRadius > 0,
    `length ${w.length.toFixed(1)}, body radius ${w.bodyRadius.toFixed(1)}`);

  // Run it all the way across.
  let frames = 0;
  while (whaleCount() > 0 && frames < 60 * 120) { updateWhales(1 / 60, scene, enemies, {}); frames++; }
  const secs = frames / 60;
  check('it crosses the arena and despawns', whaleCount() === 0, `${secs.toFixed(1)}s`);
  const span = bounds.width + w.length * 1.5 * 2;
  check('...taking about as long as its speed says it should',
    Math.abs(secs - span / C.speed) < span / C.speed * 0.35,
    `expected about ${(span / C.speed).toFixed(1)}s at ${C.speed} u/s`);
  check('...and left nothing in the scene', scene.children.length === 0,
    `${scene.children.length} object(s) still parented`);
}

{
  // The gulp. A school on the line, a shark alongside it, a boss behind it.
  resetWhales(scene);
  const w = spawnWhale(scene, mulberry32(3));
  const y = w.baseY;
  const ahead = w.dir > 0 ? 1 : -1;
  const school = [];
  for (let i = 0; i < 20; i++) school.push(fakeEnemy(ahead * (i * 1.5), y + (i % 5) - 2, 0.4));
  const shark = fakeEnemy(0, y, 1.2);
  const boss = fakeEnemy(ahead * 4, y, 0.3, { isBoss: true });
  const turtle = fakeEnemy(ahead * 6, y, 0.3, { invincible: true });
  seed([...school, shark, boss, turtle]);

  let sawGape = false;
  let gapeBeforeFirstGulp = null;
  let gulped = 0;
  for (let i = 0; i < 60 * 60 && whaleCount() > 0; i++) {
    const before = enemies.length;
    updateWhales(1 / 60, scene, enemies, {
      onGulp: (x, yy, n) => {
        if (gapeBeforeFirstGulp === null) gapeBeforeFirstGulp = sawGape;
        gulped += n;
      },
    });
    if (w.gape > 0.5) sawGape = true;
    if (enemies.length > before) throw new Error('the whale added creatures');
  }
  check('it swallows the school', gulped >= 15, `${gulped} of ${school.length}`);
  check('the shark is left alone', enemies.includes(shark));
  check('the boss is left alone', enemies.includes(boss));
  check('the invincible creature is left alone', enemies.includes(turtle));
  // The gape leads the gulp. Opening ON the mouthful is opening too late — the
  // fish is deleted the frame it comes inside mouthRadius.
  check('the jaw is already open before the first mouthful', gapeBeforeFirstGulp === true,
    'gapeLead is what buys this');
}

{
  // THE JAW STAYS OPEN. Two separate claims, and the first is the one that
  // shows on screen: a school is a scatter of individuals, so "is anything in
  // reach" flickers as the whale swims through it, and a gape tracking that
  // exactly chatters open and shut several times a second.
  resetWhales(scene);
  const w = spawnWhale(scene, mulberry32(3));
  const ahead = w.dir > 0 ? 1 : -1;
  // A deliberately GAPPY school — pairs of fish with clear water between them,
  // which is what makes the search answer flicker.
  const school = [];
  for (let i = 0; i < 8; i++) school.push(fakeEnemy(ahead * i * 11, w.baseY, 0.4));
  seed(school);

  let flips = 0;
  let wasOpen = false;
  let openFrames = 0;
  let frames = 0;
  let closedAfterFood = 0;
  let foodGone = -1;
  for (let i = 0; i < 60 * 200 && whaleCount() > 0; i++) {
    updateWhales(1 / 60, scene, enemies, {});
    frames++;
    const open = w.gape > 0.5;
    if (open !== wasOpen) { flips++; wasOpen = open; }
    if (open) openFrames++;
    if (enemies.length === 0 && foodGone < 0) foodGone = i;
    if (foodGone >= 0 && open) closedAfterFood = i - foodGone;
  }
  console.log(`  the jaw crossed the half-open line ${flips} time(s) over ${(frames / 60).toFixed(1)}s,`
    + ` and was open for ${(openFrames / 60).toFixed(1)}s`);
  check('the jaw does not chatter through a gappy school', flips <= 4,
    `${flips} open/shut transitions — more than a couple is a jaw tracking the search, not feeding`);
  check('...and stays open for a good long stretch', openFrames / 60 > 5,
    `${(openFrames / 60).toFixed(1)}s open`);
  check('...and is still open well after the last fish is gone',
    closedAfterFood / 60 > 2,
    `${(closedAfterFood / 60).toFixed(1)}s of hold after the water emptied`);
  // It must still SHUT eventually, or the whale simply swims with its mouth open.
  check('...but does shut in the end', w.gape < 0.5 || whaleCount() === 0,
    `gape ended at ${w.gape.toFixed(2)}`);
}

{
  // THE INTAKE — the fish have to TRAVEL to the mouth, not blink out.
  //
  // This is the whole difference between the sweep reading as the whale eating
  // and reading as the fish despawning, and it is invisible to any check that
  // only counts what is left alive at the end.
  resetWhales(scene);
  const w = spawnWhale(scene, mulberry32(3));
  const field = intakeRadius(C);
  // Placed relative to the MOUTH, not to the container. Those are two very
  // different landmarks and the harness is where that bites: with no model
  // loaded createVisual falls back to the primitive cone, whose pivot is its
  // centre — so `noseAhead` is 18.2 here against the real model's 5.6, and a
  // fish positioned off the container starts inside the swallowing radius and
  // is eaten on frame one with no travel at all. Measure off what the code
  // measures off.
  const mouthX = (ww) => ww.container.position.x + ww.dir * mouthAheadOf(ww.noseAhead);
  const fish = fakeEnemy(mouthX(w) + w.dir * field * 0.85, w.baseY, 0.4);
  seed([fish]);
  const startGap = Math.abs(fish.mesh.position.x - mouthX(w));

  let closed = 0;
  let swallowed = false;
  let travelled = 0;
  let prev = fish.mesh.position.clone();
  for (let i = 0; i < 60 * 60 && whaleCount() > 0; i++) {
    const had = enemies.length;
    // Freeze the whale in place for this one, so the ONLY thing that can move
    // the fish is the suction. Otherwise a whale swimming onto a stationary
    // fish closes the gap by itself and the test passes without any pull.
    //
    // THE LINE IS WHAT HAS TO BE HELD, not the drawn position. `lineX` is the
    // crossing and `container.position.x` is that plus whatever nudge the body
    // is carrying (see CONFIG.whale.ram), rewritten from the line every frame —
    // so pinning the drawn position alone is undone on the next update and the
    // whale swims onto the fish anyway, which is exactly the false pass this
    // freeze exists to prevent.
    const holdX = w.lineX;
    updateWhales(1 / 60, scene, enemies, {});
    w.lineX = holdX;
    w.container.position.x = holdX + w.nudgeX;
    if (enemies.length < had) { swallowed = true; break; }
    travelled += fish.mesh.position.distanceTo(prev);
    prev = fish.mesh.position.clone();
    closed = startGap - Math.abs(fish.mesh.position.x - mouthX(w));
  }
  console.log(`  a fish at the rim of a ${field.toFixed(1)}-unit field moved ${travelled.toFixed(1)} units into a stationary whale`);
  check('the suction drags prey toward the mouth', travelled > 1,
    `${travelled.toFixed(1)} units of travel — 0 means it is still deleting on contact`);
  check('...and gets it all the way in', swallowed,
    swallowed ? 'swallowed at the lips' : 'never arrived');

  // Nothing outside the field may move at all, or the whale is a screen-wide
  // tractor beam rather than a mouth.
  resetWhales(scene);
  const w2 = spawnWhale(scene, mulberry32(3));
  const far = fakeEnemy(mouthX(w2) + w2.dir * field * 2.5, w2.baseY, 0.4);
  seed([far]);
  const farStart = far.mesh.position.clone();
  for (let i = 0; i < 30; i++) {
    const holdX = w2.lineX;
    updateWhales(1 / 60, scene, enemies, {});
    w2.lineX = holdX;
    w2.container.position.x = holdX + w2.nudgeX;
  }
  check('...but nothing outside the field is touched',
    far.mesh.position.distanceTo(farStart) < 1e-6,
    `moved ${far.mesh.position.distanceTo(farStart).toFixed(3)} units at ${(field * 2.5).toFixed(1)} away`);

  // And a shut jaw sucks nothing. The gape scales the pull, so this is what
  // stops a whale hoovering a school through a closed mouth.
  resetWhales(scene);
  const w3 = spawnWhale(scene, mulberry32(3));
  w3.gape = 0;
  w3.gapeHold = 0;
  const near = fakeEnemy(mouthX(w3) + w3.dir * field * 0.8, w3.baseY, 0.4);
  // A creature the whale will not open for, so the gape stays shut while
  // something IS inside the field.
  seed([near, fakeEnemy(0, 0, 99)]);
  near.radius = 99; // ineligible: too big to be prey, so no gape and no pull
  const nearStart = near.mesh.position.clone();
  for (let i = 0; i < 60; i++) {
    const holdX = w3.lineX;
    updateWhales(1 / 60, scene, enemies, {});
    w3.lineX = holdX;
    w3.container.position.x = holdX + w3.nudgeX;
  }
  check('...and a closed jaw pulls nothing', near.mesh.position.distanceTo(nearStart) < 1e-6,
    `gape ${w3.gape.toFixed(2)}, moved ${near.mesh.position.distanceTo(nearStart).toFixed(3)}`);
}

{
  // The orbs, and the rule that they pay nothing.
  resetWhales(scene);
  seed([]);
  resetPickups(scene);
  const w = spawnWhale(scene, mulberry32(3));
  // On the whale's own line and well ahead of it, so the crossing sweeps
  // through the whole pile.
  const pileAt = w.container.position.x + w.dir * 60;
  for (let i = 0; i < 12; i++) {
    const mesh = new THREE.Object3D();
    mesh.position.set(pileAt + w.dir * i * 2, w.baseY, 0);
    pickups.push({ mesh, value: 7, healMul: 1 });
  }
  const before = pickups.length;
  const startAt = pickups.map((p) => p.mesh.position.clone());
  let paid = 0;
  let reported = 0;
  let crumbs = 0;
  let orbTravel = 0;
  for (let i = 0; i < 60 * 60 && whaleCount() > 0; i++) {
    const was = new Map(pickups.map((p) => [p, p.mesh.position.clone()]));
    updateWhales(1 / 60, scene, enemies, {
      onOrbsEaten: (x, y, n) => { reported += n; },
      onOrbHoover: () => { crumbs++; },
      // Nothing here credits anything. If a later edit routes the orbs through
      // a collect callback, `paid` is what catches it.
      onCollect: () => { paid++; },
    });
    for (const p of pickups) {
      const prev = was.get(p);
      if (prev) orbTravel += p.mesh.position.distanceTo(prev);
    }
  }
  check('the orbs are dragged in rather than deleted where they float',
    orbTravel > 1, `${orbTravel.toFixed(1)} units of orb travel across the pass`);
  check('...shedding crumbs on the way', crumbs > 0, `${crumbs} hoover frames reported`);
  check('the whale takes uncollected orbs out of the water', pickups.length < before,
    `${before} -> ${pickups.length}`);
  check('...and reports what it took', reported === before - pickups.length,
    `reported ${reported}`);
  check('...and the player is paid nothing for them', paid === 0,
    paid ? `${paid} orbs were credited — the sweep is meant to COST you` : 'gone entirely, as designed');
}

{
  // The shove capsule. A 31-unit body has to push the seal from its flank, not
  // only from the point at its centre.
  const at = (px, py) => {
    resetWhales(scene);
    seed([]);
    const w = spawnWhale(scene, mulberry32(3));
    // Put the seal directly on the whale's line, offset along the body.
    const p = { position: new THREE.Vector3(px, w.baseY + py, 0), radius: 0.5 };
    let shoved = null;
    for (let i = 0; i < 60 * 60 && whaleCount() > 0; i++) {
      updateWhales(1 / 60, scene, enemies, {
        player: p,
        onShove: (nx, ny) => { shoved ??= { nx, ny }; },
      });
    }
    return { shoved, w };
  };

  const centre = at(0, 0);
  check('the body shoves the seal it swims through', !!centre.shoved);
  // Out of the body, never along it: a shove with any forward component would
  // carry the seal in front of the whale for the rest of the crossing.
  if (centre.shoved) {
    check('...pushing OUT rather than along the body',
      Math.abs(centre.shoved.ny) > Math.abs(centre.shoved.nx),
      `normal [${centre.shoved.nx.toFixed(2)}, ${centre.shoved.ny.toFixed(2)}]`);
  }
  // Off the axis by most of the body radius — still inside the animal, and the
  // case a circle-at-the-centre test would miss.
  const flank = at(0, centre.w.bodyRadius * 0.6);
  check('...and from the flank as well as head-on', !!flank.shoved,
    `${(centre.w.bodyRadius * 0.6).toFixed(1)} units off the axis of a ${centre.w.bodyRadius.toFixed(1)}-radius body`);
  const clear = at(0, centre.w.bodyRadius + 8);
  check('...but not from clear water beside it', !clear.shoved,
    `${(centre.w.bodyRadius + 8).toFixed(1)} units off the axis`);
}

section('THE NUDGE — a ram moves it, and the crossing does not care');

// The other half of that same contact: the seal is shoved aside, and a seal
// that arrived at ramming speed moves the whale a little in return. Every
// claim here is about the difference between NUDGED and KNOCKED, which is the
// whole design — see CONFIG.whale.ram.
{
  // A seal parked on the whale's line, so the animal swims onto it. `dashing`
  // is the state the strike is in when it connects; power 1 is a full charge.
  const rammedRun = ({ dashing = true, power = 1, frames = 60 * 60 } = {}) => {
    resetWhales(scene);
    seed([]);
    const w = spawnWhale(scene, mulberry32(3));
    const p = { position: new THREE.Vector3(0, w.baseY, 0), radius: 0.5 };
    // Along the whale's own heading, which is the worst case for the line: a
    // nudge that survived would show up as the animal arriving early.
    const ram = { dashing, dirX: w.dir, dirY: 0, power };
    let peak = 0;
    let hits = 0;
    let peakAt = 0;
    const lineAtStart = w.lineX;
    let touched = 0;
    for (let i = 0; i < frames && whaleCount() > 0; i++) {
      updateWhales(1 / 60, scene, enemies, { player: p, ram, onNudge: () => { hits++; } });
      const off = Math.hypot(w.nudgeX, w.nudgeY);
      if (off > peak) { peak = off; peakAt = i; }
      if (off > 1e-6) touched = i;
    }
    return { w, peak, hits, peakAt, touched, lineAtStart };
  };

  const full = rammedRun({});
  check('a ram moves the whale off its line', full.peak > 0.05,
    `${full.peak.toFixed(2)} units of give on a ${full.w.bodyRadius.toFixed(1)}-radius body`);
  // ...and NOT far. The cap is the promise, and the give should sit well
  // inside it at the shipped impulse — a peak pinned to the ceiling means the
  // spring is not what is holding the animal in, the clamp is.
  check('...but nowhere near far', full.peak <= (C.ram.maxOffset ?? 1.5) + 1e-6
    && full.peak < C.ram.maxOffset * 0.9,
    `peak ${full.peak.toFixed(2)} against a ${C.ram.maxOffset} cap`);
  check('...and it settles back onto its line',
    Math.hypot(full.w.nudgeX, full.w.nudgeY) < 1e-6 || full.touched < full.peakAt + 60 * 3,
    `off the line for ${((full.touched - full.peakAt) / 60).toFixed(2)}s after the peak`);

  // ONE NUDGE PER DASH. The contact test runs every frame and a dash lasts a
  // quarter of a second, so an un-edged impulse is fifteen rams for the price
  // of one — and it would read as the seal steering a whale.
  check('one dash is one nudge', full.hits === 1, `${full.hits} impulse(s) from one dash`);

  // Not dashing is not a ram. Swimming into a whale is the shove, and the
  // shove alone.
  const idle = rammedRun({ dashing: false });
  check('swimming into it does nothing to it', idle.hits === 0 && idle.peak === 0,
    `${idle.hits} impulse(s), peak ${idle.peak.toFixed(3)}`);

  // Charge scales it, like everything else the strike does.
  const flick = rammedRun({ power: 0 });
  check('a flick moves it less than a full charge', flick.peak < full.peak * 0.9,
    `${flick.peak.toFixed(2)} vs ${full.peak.toFixed(2)} units`);

  // -------------------------------------------------------------------------
  // THE FLINCH — the body BENDS as well as moving.
  //
  // The nudge above translates the whole animal along one vector, and on a body
  // 31 units long that is the one motion the eye reads as the camera rather
  // than as a hit: every part goes the same way by the same amount, so there is
  // nothing to see it against. The give the player is actually looking for is
  // the spine, which is what carries a hit on every other creature in the game.
  //
  // Driven through a STUBBED controller. The real one needs a skeleton, and
  // createVisual has no model to build one from in Node — so a whale spawned
  // here has `anim: null` and a broken impulse would fire nothing and pass
  // every check on this page. The stub is the only way to see the call at all.
  {
    const flinchRun = ({ dashing = true, power = 1, strength = null } = {}) => {
      resetWhales(scene);
      seed([]);
      const w = spawnWhale(scene, mulberry32(3));
      const kicks = [];
      w.anim = {
        update() {},
        setRate() {},
        impulse(dir, mag, tipBias) { kicks.push({ x: dir.x, y: dir.y, mag, tipBias }); },
      };
      const p = { position: new THREE.Vector3(0, w.baseY, 0), radius: 0.5 };
      const ram = { dashing, dirX: w.dir, dirY: 0, power };
      const held = C.ram.flinch?.strength;
      if (strength != null) C.ram.flinch.strength = strength;
      try {
        for (let i = 0; i < 60 * 60 && whaleCount() > 0; i++) {
          updateWhales(1 / 60, scene, enemies, { player: p, ram });
        }
      } finally {
        if (strength != null) C.ram.flinch.strength = held;
      }
      return kicks;
    };

    const kicks = flinchRun({});
    check('a ram shoves the skeleton as well as the body', kicks.length === 1,
      `${kicks.length} impulse(s) at ${kicks[0]?.mag.toFixed(2) ?? '—'}`);
    if (kicks.length) {
      // Along the dash, like the nudge and like every other thing the strike
      // shoves. A flinch that ran along the whale's own heading instead would
      // buckle it the same way whichever side it was hit from.
      check('...along the dash, not along the whale',
        Math.abs(kicks[0].x - Math.sign(kicks[0].x || 1)) < 1e-6 && Math.abs(kicks[0].y) < 1e-6,
        `direction [${kicks[0].x.toFixed(2)}, ${kicks[0].y.toFixed(2)}] — a unit vector, or the spring gets a scaled shove twice`);
      // Small, against the cap on an ordinary creature's hit reaction. This
      // animal is thirty tonnes and the flinch is the thing that says so.
      check('...and gently, against what an ordinary hit does',
        kicks[0].mag < CONFIG.animation.spring.impulseMax * 0.5,
        `${kicks[0].mag.toFixed(2)} against an impulseMax of ${CONFIG.animation.spring.impulseMax}`);
      check('...toward the fluke rather than through the middle',
        kicks[0].tipBias === C.ram.flinch.tipBias, `tipBias ${kicks[0].tipBias}`);
    }
    const flickKicks = flinchRun({ power: 0 });
    check('a flick buckles it less than a full charge',
      flickKicks.length === 1 && kicks.length === 1 && flickKicks[0].mag < kicks[0].mag * 0.9,
      `${flickKicks[0]?.mag.toFixed(2)} vs ${kicks[0]?.mag.toFixed(2)}`);
    check('swimming into it bends nothing', flinchRun({ dashing: false }).length === 0);
    // Tuned to nothing means nothing, rather than a zero-length impulse the
    // spring solver has to decide what to do with.
    check('...and a flinch tuned to zero fires no impulse at all',
      flinchRun({ strength: 0 }).length === 0);
  }

  // THE SWEEP IS NOT MOVED. This is the claim that separates a nudge from a
  // knock: the body gives, and the line it is travelling along is untouched,
  // so no amount of ramming can hold a whale up, hurry it along or push it out
  // of the arena. Measured as the crossing TIME against an untouched sweep.
  const crossing = ({ ram }) => {
    resetWhales(scene);
    seed([]);
    const w = spawnWhale(scene, mulberry32(3));
    const p = { position: new THREE.Vector3(0, w.baseY, 0), radius: 0.5 };
    let frames = 0;
    while (whaleCount() > 0 && frames < 60 * 240) {
      // A fresh dash every 20 frames, so the seal is ramming it continuously
      // for as long as the body is on top of it — the worst case there is.
      const on = ram && frames % 20 < 10;
      updateWhales(1 / 60, scene, enemies, {
        player: ram ? p : null,
        ram: { dashing: on, dirX: w.dir, dirY: 0, power: 1 },
      });
      frames++;
    }
    return frames;
  };
  const clean = crossing({ ram: false });
  const harried = crossing({ ram: true });
  check('a whale rammed the whole way across still crosses on time',
    Math.abs(harried - clean) <= 1,
    `${(harried / 60).toFixed(2)}s against ${(clean / 60).toFixed(2)}s untouched`);
}

// ===========================================================================
console.log(`\n${failures === 0 ? 'All good.' : `${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
