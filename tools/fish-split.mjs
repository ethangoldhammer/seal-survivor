#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Cuts a merged fish pack into one standalone, game-ready .glb per animal.
//
//   node --import ./tools/vite-loader.mjs tools/fish-split.mjs [--src f.glb] [--out dir] [--list]
//
// WHY THIS EXISTS AND `npm run split` DOES NOT DO IT. tools/split-islands.mjs
// cuts ONE merged primitive into connected components and bakes the node chain
// flat. That is the right tool for a pile of cash rolls and the wrong one here
// twice over: these animals are already separate nodes (nothing needs
// component analysis), and they are SKINNED (baking the node chain throws the
// skeleton away). What this needs is a subtree cut, which is what
// tools/orca-split.mjs does — this is that idea made general, because the orca
// tool knows the names of three specific whales.
//
// `meshIndex` in assets.js cannot do it either, and that is the whole reason a
// tool is needed. isolateMesh keeps exactly ONE mesh, and every fish in this
// pack is two or three: the clownfish is orange, white and black as three
// separate meshes because it is three separate materials. `meshIndex` on it
// yields a clownfish with no stripes.
//
// WHAT IT TAKES, per animal: the `*Armature_*` subtree, which holds BOTH the
// bone root and the mesh group. Lifting the meshes alone takes the flesh and
// leaves the skeleton.
//
// THREE THINGS THAT ARE NOT OBVIOUS, all of them learned in orca-split.mjs and
// all of them failing silently rather than loudly:
//
//   A SKIN CAN NAME BONES THAT ARE NOT IN THE FILE ANY MORE. If the source
//   binds every mesh to every armature's bones — legal, normal for a scene
//   exported as one take — the exported GLB writes a joint list pointing at
//   nodes that were left behind, and GLTFLoader dies reading it back with
//   "Cannot set properties of undefined". The exporter does not warn. So the
//   skeleton is rebuilt to the bones that actually survived and the geometry's
//   joint indices are remapped, and a vertex carrying real weight on a dropped
//   bone ABORTS the run: that is another animal pulling on this one, which
//   means the subtree was wrong.
//
//   ONE CLIP DRIVES ALL FOUR ANIMALS. three.js binds tracks by name and drops
//   the misses in silence, so keeping the whole clip looks fine and is the
//   exact failure mode that hides a bad split. Tracks are filtered by whether
//   their target node survived — the honest test, and it needs to know nothing
//   about how the file was packed.
//
//   THE BIND POSE IS ABSOLUTE, so rotating the animal has to move it too. Each
//   fish is posed at its own angle in the pile and is straightened onto its
//   principal axes here (assets.js cannot express a diagonal `forward`) — and a
//   boneInverse is an inverse bind WORLD matrix, `bindMatrix` the mesh's world
//   matrix at bind. Carry them over unchanged and the skin describes a body
//   that is no longer there; recompute them naively and the rotation lands in
//   the equation twice. They are transformed instead: boneInverse·R⁻¹ and
//   R·bindMatrix, which cancels every R but the outermost.
//
// Every output is VERIFIED before it is written: reloaded through the real
// GLTFLoader, posed at four points around its own clip, and compared against
// the same poses measured on the source subtree. The comparison is a
// ROTATION-INVARIANT fingerprint — the spread along each pose's own principal
// axes — because the output has deliberately been turned, so a bounding box
// would differ for a reason that is not a bug. Posed rather than at rest
// because a split that lost its rig still loads and still measures a perfectly
// plausible bind pose; it only shows up once something is supposed to move.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// The GLB parse decodes embedded textures through createImageBitmap; without a
// stub the promise never settles and the script exits silently. Nothing here
// reads a pixel. (This pack ships no textures at all, but the stub costs
// nothing and the next pack might.)
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
// The binary export packs its buffer through a Blob and a FileReader, neither
// of which Node has. Both shims touch nothing but the bytes.
class NodeFileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.(); });
  }
}
globalThis.FileReader = NodeFileReader;

import * as THREE from 'three';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const SRC = resolve(arg('--src', `${process.env.HOME}/Documents/_DesignSystems/SealSurvivor/3 low poly fish to split.glb`));
const OUT_DIR = resolve(arg('--out', join(HERE, '../public/models')));
const LIST_ONLY = process.argv.includes('--list');

// Armature node name -> output basename. Read off the source with --list; the
// map is here rather than derived so a rename in the source is a loud KeyError
// at the top instead of a file called `browfisharmature_13.glb`.
const NAMES = {
  BrownFishArmature_13: 'brownfish',
  ClownFishArmature_23: 'clownfish',
  TunaArmature_33: 'tunafish',
  DoryArmature_47: 'surgeonfish',
};

async function parse(path) {
  const buf = readFileSync(path);
  return new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
}

/**
 * Where this rig's skinned vertices actually are, in world space.
 *
 * `updateMatrixWorld(true)` is forced: without it every pose measures the same
 * and nothing throws, which makes a broken rig look perfect.
 */
function skinnedPoints(root) {
  root.updateMatrixWorld(true);
  const out = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.isSkinnedMesh) o.skeleton.update();
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
      out.push(o.localToWorld(v.clone()));
    }
  });
  return out;
}

/** Mean and 3x3 covariance of a point cloud. */
function moments(pts) {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const d = new THREE.Vector3();
  for (const p of pts) {
    d.subVectors(p, c);
    const a = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += a[i] * a[j] / pts.length;
  }
  return { centroid: c, cov: m };
}

/**
 * All three principal axes, largest spread first — Jacobi on a symmetric 3x3.
 *
 * The dominant axis alone is not enough here. `build-squid.mjs` only ever
 * needed "which way is long"; this needs the full frame, because a fish is
 * flattened and the two SHORT axes are not interchangeable: the thinnest is
 * the flank (side to side) and the middle one is dorsal-ventral. Getting those
 * two the wrong way round rolls the animal onto its side.
 */
function principalFrame(cov) {
  let a = cov.map((r) => r.slice());
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let p = 0, q = 1, best = Math.abs(a[0][1]);
    for (const [i, j] of [[0, 2], [1, 2]]) {
      if (Math.abs(a[i][j]) > best) { best = Math.abs(a[i][j]); p = i; q = j; }
    }
    if (best < 1e-12) break;
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1), s = t * c;
    const rot = (m) => {
      for (let k = 0; k < 3; k++) {
        const mkp = m[k][p], mkq = m[k][q];
        m[k][p] = c * mkp - s * mkq;
        m[k][q] = s * mkp + c * mkq;
      }
    };
    rot(a);
    a = a[0].map((_, i) => a.map((r) => r[i])); // transpose
    rot(a);
    a = a[0].map((_, i) => a.map((r) => r[i]));
    rot(v);
  }
  const eig = [0, 1, 2]
    .map((i) => ({ value: a[i][i], vec: new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize() }))
    .sort((x, y) => y.value - x.value);
  return eig;
}

/**
 * Which end of the body the CLIP moves, as {atLow, atHigh} mean displacement.
 *
 * THE TAIL IS THE END THAT MOVES. That is what swimming is — a fish holds its
 * head steady and sweeps everything behind it — and unlike any shape test it
 * does not care what the animal looks like. Two shape heuristics were tried
 * first and both got half this set wrong: "the tail is a thin blade" is true
 * of a tuna and false of a clownfish, whose caudal fin is a rounded paddle
 * thicker than its own tail muscle.
 *
 * Each pose is centred before measuring, so a clip that translates the whole
 * body does not read as motion everywhere. What survives that is bending, and
 * bending is what the answer is made of.
 */
function tailEnd(root, clip, times, fwd, centroid) {
  const raw = skinnedPoints(root);
  const along = raw.map((p) => p.clone().sub(centroid).dot(fwd));
  const lo = Math.min(...along), hi = Math.max(...along);
  // BOTH SIDES OF THE COMPARISON GET CENTRED. Centring only the animated pose
  // leaves every displacement dominated by however far the fish sits from the
  // origin — 19.87 against 19.79 on the brownfish, two large numbers whose
  // difference is the entire signal, drowned in a constant they both carry.
  const rest = raw.map((p) => p.clone().sub(centroid));

  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  const sum = new Float64Array(rest.length);
  for (const t of times) {
    mixer.setTime(t);
    const pts = skinnedPoints(root);
    const c = new THREE.Vector3();
    for (const p of pts) c.add(p);
    c.multiplyScalar(1 / pts.length);
    for (let i = 0; i < pts.length; i++) sum[i] += pts[i].sub(c).distanceTo(rest[i]);
  }
  mixer.stopAllAction();

  // The outer fifth at each end, so the comparison is tip against tip and not
  // one half of the animal against the other.
  const band = (hi - lo) / 5;
  let low = 0, lowN = 0, high = 0, highN = 0;
  for (let i = 0; i < rest.length; i++) {
    if (along[i] < lo + band) { low += sum[i]; lowN += 1; }
    else if (along[i] > hi - band) { high += sum[i]; highN += 1; }
  }
  return { atLow: low / Math.max(1, lowN), atHigh: high / Math.max(1, highN) };
}

/**
 * A rotation-invariant fingerprint of one pose: the spread along the cloud's
 * OWN principal axes, biggest first.
 *
 * Invariant on purpose. The check this feeds compares the source against an
 * output that has been deliberately rotated onto a new frame, so an
 * axis-aligned bounding box would differ for a reason that is not a bug. What
 * has to survive the cut is the SHAPE the rig makes at each moment, and this is
 * that shape with the orientation divided out.
 */
function poseSignature(root, clip, t) {
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  const pts = skinnedPoints(root);
  mixer.stopAllAction();
  const { cov } = moments(pts);
  return principalFrame(cov).map((e) => Math.sqrt(Math.max(0, e.value)));
}

const source = await parse(SRC);
source.scene.updateMatrixWorld(true);

const armatures = [];
source.scene.traverse((o) => { if (/Armature/i.test(o.name ?? '')) armatures.push(o.name); });
if (LIST_ONLY) {
  console.log(`${SRC}\n  armatures: ${armatures.join(', ')}`);
  console.log(`  clips: ${source.animations.map((c) => `${c.name} (${c.duration.toFixed(2)}s)`).join(', ')}`);
  process.exit(0);
}

const missing = Object.keys(NAMES).filter((n) => !armatures.includes(n));
if (missing.length) {
  console.error(`REFUSING: ${SRC} has no ${missing.join(', ')}.`);
  console.error(`It holds: ${armatures.join(', ')}. The source changed shape — fix NAMES.`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
let wrote = 0;

for (const [armName, base] of Object.entries(NAMES)) {
  // Re-parsed per animal. The cut REPARENTS nodes rather than cloning them
  // (SkeletonUtils.clone is one more place for a bind matrix to go missing),
  // so the scene is consumed by the first cut and each one needs its own.
  const gltf = await parse(SRC);
  gltf.scene.updateMatrixWorld(true);

  let arm = null;
  gltf.scene.traverse((o) => { if (o.name === armName) arm = o; });

  // The tracks that drive THIS armature, resolved before anything is measured.
  // Doing it here rather than after the cut is not tidiness: a mixer rooted at
  // one armature and handed the whole four-animal clip logs a PropertyBinding
  // warning per missing bone — 100-odd lines of noise that look like an error
  // and are not one — and the filter has to be proven anyway.
  const present = new Set();
  arm.traverse((o) => { if (o.name) present.add(o.name); });
  const srcClip = gltf.animations[0];
  const armTracks = srcClip.tracks.filter((t) => present.has(t.name.split('.')[0]));
  // A filter that kept everything told nothing apart, which on a four-animal
  // file means the packing scheme changed and the bone names stopped being
  // unique. See the note on renaming in orca-split.mjs — this is the tell.
  if (armTracks.length === 0 || armTracks.length === srcClip.tracks.length) {
    console.error(`REFUSING ${base}: kept ${armTracks.length} of ${srcClip.tracks.length} tracks — the filter told nothing apart.`);
    process.exit(1);
  }
  const armClip = new THREE.AnimationClip(srcClip.name, srcClip.duration, armTracks);

  const TIMES = [0, srcClip.duration * 0.25, srcClip.duration * 0.5, srcClip.duration * 0.75];

  // --- orientation ---------------------------------------------------------
  // EACH FISH IS POSED AT ITS OWN ANGLE IN THE PILE. Auditioned as they come
  // out they swim diagonally across the screen, and no `forward`/`up` pair in
  // assets.js can express a diagonal — the same wall tools/build-squid.mjs hit,
  // solved the same way: bake the rotation into the file so the entry can
  // declare a clean '+Z'/'+Y'.
  //
  // The frame comes from the VERTICES, not the bounding box. An axis-aligned
  // box around a fish lying diagonally is inflated corner to corner and reads
  // as a squat animal — the brownfish measures 2.30 x 2.98 x 1.74 that way and
  // 0.74 x 1.48 x 3.65 once it is on its own axis.
  //
  // Worked out here, on the measurement parse and while its bones are still at
  // rest, because both of the tests below need the rig untouched and one of
  // them needs to run the clip — which writes bones a mixer cannot put back.
  const bindPts = skinnedPoints(arm);
  const { centroid, cov } = moments(bindPts);
  const eig = principalFrame(cov);
  let fwd = eig[0].vec.clone();   // longest: nose to tail
  let up = eig[1].vec.clone();    // middle: dorsal to ventral. A fish is
  //                                 flattened side to side, so the SMALLEST
  //                                 axis is the flank; mixing these two rolls
  //                                 the animal onto its side.

  // Which end is the nose: the one the swim cycle does NOT move.
  {
    const { atLow, atHigh } = tailEnd(arm, armClip, TIMES, fwd, centroid);
    // `fwd` has to end up pointing at the NOSE. If the far end along it is the
    // one doing the swimming, it is currently aimed at the tail.
    if (atHigh > atLow) fwd.negate();
    const ratio = Math.max(atLow, atHigh) / Math.max(1e-9, Math.min(atLow, atHigh));
    // A fish whose two ends move about equally is one this cannot answer, and
    // guessing quietly is how the wrong-way-round versions of these shipped
    // twice already.
    if (ratio < 1.5) {
      console.error(`REFUSING ${base}: both ends move about the same across the clip (${atLow.toFixed(3)} vs ${atHigh.toFixed(3)}).`);
      console.error('Nothing here can tell the head from the tail — orient this one by hand against a render.\n');
      process.exit(1);
    }
  }

  // Which way is up. The dorsal fin reaches further off the spine than the
  // anal fin does — true of all four of these and of most fish, and the only
  // asymmetry on this axis that is not a coin flip. Checked against a render
  // regardless: an upside-down fish is not subtle.
  {
    let above = 0, below = 0;
    for (const p of bindPts) {
      const d = p.clone().sub(centroid).dot(up);
      if (d > above) above = d; else if (d < below) below = d;
    }
    if (above < -below) up.negate();
  }

  // Right-handed by construction. Taking the third axis from a cross product
  // rather than from the eigenvector guarantees a ROTATION; raw eigenvectors
  // carry arbitrary signs and can just as easily describe a reflection, which
  // would mirror the animal.
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  up = new THREE.Vector3().crossVectors(fwd, right).normalize();
  const R = new THREE.Matrix4().makeBasis(right, up, fwd).invert(); // fwd -> +Z, up -> +Y

  // Measured on the source, so the check at the end is against how this fish
  // really swims and not against itself.
  const want = TIMES.map((t) => poseSignature(arm, armClip, t));

  // The mixer just wrote every animated bone, and a mixer does not put a bone
  // back (a single-keyframe track is as unrecoverable as an unkeyed one). The
  // re-bind below is only valid in the BIND pose, so the cut works on a clean
  // parse and the measured one is thrown away.
  const cutGltf = await parse(SRC);
  cutGltf.scene.updateMatrixWorld(true);
  let cut = null;
  cutGltf.scene.traverse((o) => { if (o.name === armName) cut = o; });

  const out = new THREE.Scene();
  out.name = base;
  // THE ANCESTOR CHAIN IS BAKED ONTO THE ARMATURE. A Sketchfab export carries
  // real work above it — here `Sketchfab_model` and `GLTF_SceneRootNode` hold
  // the Z-up correction and a scale — and reparenting into a bare Scene
  // silently drops the lot. The first run of this did, and the posed bounds
  // came out 232% off.
  const world = cut.matrixWorld.clone();
  out.add(cut);
  cut.matrix.copy(world);
  cut.matrix.decompose(cut.position, cut.quaternion, cut.scale);
  cut.applyMatrix4(R);
  out.updateMatrixWorld(true);

  const strays = [];
  out.traverse((o) => { if (o.isLight || o.isCamera) strays.push(o); });
  for (const s of strays) s.parent?.remove(s);

  // --- the skeleton --------------------------------------------------------
  // THE BIND POSE HAS TO FOLLOW THE ROTATION, and this is the step where a
  // rotated split quietly goes wrong. A boneInverse is the INVERSE BIND WORLD
  // MATRIX of its bone, and `bindMatrix` is the mesh's world matrix at bind —
  // both are absolute, so rotating the subtree and carrying them over unchanged
  // leaves the skin describing a body that is no longer there. Rebinding in
  // place instead (`new Skeleton(bones)`, which recomputes inverses from the
  // rest pose) is the usual fix and assumes the glTF's inverseBindMatrices
  // agree with its node rest transforms — normally true, not guaranteed.
  //
  // So they are transformed rather than recomputed, which needs no assumption:
  // bone worlds become R*B, hence boneInverse becomes boneInverse*R⁻¹, and
  // bindMatrix becomes R*bindMatrix. Substituted into the skinning equation
  // every R cancels but the outermost, which is the definition of "the animal
  // rotated and nothing else changed".
  const Rinv = new THREE.Matrix4().copy(R).invert();
  const mine = new Set();
  out.traverse((o) => { if (o.isBone) mine.add(o); });

  let worstOrphan = 0;
  const rebound = [];
  out.traverse((o) => { if (o.isSkinnedMesh) rebound.push(o); });

  for (const mesh of rebound) {
    const old = mesh.skeleton;
    const keep = [];
    const inverses = [];
    const remap = new Int32Array(old.bones.length).fill(-1);
    for (let i = 0; i < old.bones.length; i++) {
      if (!mine.has(old.bones[i])) continue;
      remap[i] = keep.length;
      keep.push(old.bones[i]);
      inverses.push(old.boneInverses[i].clone().multiply(Rinv));
    }

    const si = mesh.geometry.attributes.skinIndex;
    const sw = mesh.geometry.attributes.skinWeight;
    for (let v = 0; v < si.count; v++) {
      for (const c of ['X', 'Y', 'Z', 'W']) {
        const b = si[`get${c}`](v);
        const w = sw[`get${c}`](v);
        const to = remap[b] ?? -1;
        if (to >= 0) { si[`set${c}`](v, to); continue; }
        if (w > worstOrphan) worstOrphan = w;
        si[`set${c}`](v, 0);
        sw[`set${c}`](v, 0);
      }
    }
    si.needsUpdate = true;
    sw.needsUpdate = true;
    mesh.bind(new THREE.Skeleton(keep, inverses), new THREE.Matrix4().multiplyMatrices(R, mesh.bindMatrix));
  }

  if (worstOrphan > 1e-4) {
    console.error(`\nREFUSING ${base}: vertices carry up to ${worstOrphan.toFixed(4)} weight on bones outside "${armName}".`);
    console.error('That is another animal pulling on this one — the subtree is wrong, not the file.\n');
    process.exit(1);
  }

  const glb = await new GLTFExporter().parseAsync(out, {
    binary: true, animations: [armClip], onlyVisible: false,
  });

  // --- verify, then write --------------------------------------------------
  const back = await new GLTFLoader().parseAsync(glb.slice(0), '');
  back.scene.updateMatrixWorld(true);
  const gotClip = back.animations[0];
  if (!gotClip) {
    console.error(`REFUSING ${base}: the exported file has no clip on the way back in.`);
    process.exit(1);
  }

  let worstDrift = 0;
  TIMES.forEach((t, i) => {
    const got = poseSignature(back.scene, gotClip, t);
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(got[k] - want[i][k]) / Math.max(1e-6, want[i][k]);
      if (d > worstDrift) worstDrift = d;
    }
  });
  // A rig that survived the round trip poses within rounding. A rig that did
  // NOT still measures a sane bind pose, which is exactly why this poses it —
  // and why the fingerprint is taken at four points around the cycle rather
  // than at rest, where a rig driving nothing looks identical to one working.
  if (worstDrift > 0.01) {
    console.error(`REFUSING ${base}: posed shape drifted ${(worstDrift * 100).toFixed(1)}% from the source across the clip.`);
    console.error('The skeleton or the clip did not survive the cut.\n');
    process.exit(1);
  }

  let tris = 0, verts = 0, bones = 0;
  back.scene.traverse((o) => {
    if (o.isBone) bones += 1;
    if (!o.isMesh) return;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    verts += g.attributes.position.count;
  });
  // Reported in the OUTPUT's frame, which after the rotation above should be
  // z-longest and x-thinnest on every animal. A file that comes out otherwise
  // is one whose principal frame was misread, and it says so here rather than
  // in the game.
  back.scene.updateMatrixWorld(true);
  const span = new THREE.Box3().setFromPoints(skinnedPoints(back.scene)).getSize(new THREE.Vector3());
  const shaped = span.z >= span.y && span.y >= span.x;

  const dest = join(OUT_DIR, `${base}.glb`);
  writeFileSync(dest, Buffer.from(glb));
  wrote += 1;
  console.log(`${base.padEnd(10)} ${String(Math.round(tris)).padStart(5)} tris  ${String(verts).padStart(5)} verts  ${String(bones).padStart(3)} bones  `
    + `${String(armClip.tracks.length).padStart(2)} tracks  `
    + `box ${span.x.toFixed(2)} x ${span.y.toFixed(2)} x ${span.z.toFixed(2)}${shaped ? '' : '  <-- NOT z-long/x-thin, check it'}  `
    + `drift ${(worstDrift * 100).toFixed(2)}%  -> ${(glb.byteLength / 1024).toFixed(0)}KB`);
}

console.log(`\nwrote ${wrote} file(s) to ${OUT_DIR}`);
