import * as THREE from 'three';

// Binding a ragdoll to somebody else's skeleton.
//
// The fisherman's bones are named `Bone.006.l.001.l.001_01` and friends —
// Blender leftovers with an actual `peg leg` in the middle of them. Nothing
// here reads a bone name. Every joint is found by MEASURING where the vertices
// each bone drives actually sit (its "flesh"), which is the only description of
// a rig that can't lie: a bone called `head` that moves the coat is a bone that
// moves the coat.
//
// What comes back is a map from the ragdoll's own joints to bones, plus the
// rest pose measured off the model — so the verlet figure is built at the
// model's proportions instead of at some assumed ones, and the two can't drift
// apart. Returns null when the model doesn't measure up as a humanoid, and the
// caller falls back to the box body.

// Where each joint sits on a human, as a fraction of standing height and of
// half the arm span. Only used to CHOOSE among measured bones — the positions
// that get used are the model's own.
const TARGETS = {
  head: [0.00, 0.94],
  chest: [0.00, 0.78],
  hips: [0.00, 0.55],
  upperArmL: [0.14, 0.77], upperArmR: [-0.14, 0.77],
  lowerArmL: [0.26, 0.68], lowerArmR: [-0.26, 0.68],
  upperLegL: [0.06, 0.42], upperLegR: [-0.06, 0.42],
  lowerLegL: [0.07, 0.17], lowerLegR: [-0.07, 0.17],
};

// A bone has to be within this much of the target (in heights) to be accepted,
// or the segment simply isn't driven and keeps whatever pose it had.
const MAX_MISS = 0.22;

function descendsFrom(bone, ancestor) {
  for (let p = bone; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

// The joint two limbs hang off — a pelvis, or a chest, defined by what attaches
// to it rather than by where it sits.
function commonAncestor(a, b) {
  const seen = new Set();
  for (let p = a; p; p = p.parent) seen.add(p);
  for (let p = b; p; p = p.parent) if (seen.has(p)) return p.isBone ? p : null;
  return null;
}

// The heaviest bone hanging directly off this one. Used for "the next joint
// down the limb", which is a fact about the skeleton rather than about where
// the model happens to be posed.
function heaviestChild(bones, flesh, parentIndex) {
  if (parentIndex == null) return null;
  const parent = bones[parentIndex];
  let best = null;
  let bestWeight = 0;
  for (let i = 0; i < bones.length; i++) {
    if (bones[i].parent !== parent || !flesh[i]) continue;
    if (flesh[i].weight > bestWeight) { bestWeight = flesh[i].weight; best = i; }
  }
  return best;
}

// The top of a chain: the highest flesh anywhere under this bone, ignoring
// anything hanging off the listed branches.
function highestUnder(bones, flesh, rootIndex, without = []) {
  if (rootIndex == null) return null;
  const under = bones[rootIndex];
  const skip = without.filter((i) => i != null).map((i) => bones[i]);
  let best = null;
  let bestY = -Infinity;
  for (let i = 0; i < bones.length; i++) {
    if (!flesh[i] || i === rootIndex || !descendsFrom(bones[i], under)) continue;
    if (skip.some((s) => descendsFrom(bones[i], s))) continue;
    if (flesh[i].at.y > bestY) { bestY = flesh[i].at.y; best = i; }
  }
  return best;
}

// The axis a body is mirrored about, measured off its legs. See the note at
// the call site for why the legs and not the arms.
function lateralAxis(bones, flesh, lo, height) {
  const band = [];
  for (let i = 0; i < bones.length; i++) {
    const f = flesh[i];
    if (!f) continue;
    const y = (f.at.y - lo) / height;
    if (y > 0.2 && y < 0.62) band.push({ i, f, y });
  }
  band.sort((a, b) => b.f.weight - a.f.weight);
  const first = band[0];
  if (!first) return 'x';
  // The heaviest thing at the same height that isn't part of the same limb.
  const second = band.find((b) => b !== first
    && Math.abs(b.y - first.y) < 0.12
    && !descendsFrom(bones[b.i], bones[first.i])
    && !descendsFrom(bones[first.i], bones[b.i]));
  if (!second) return 'x';
  return Math.abs(second.f.at.z - first.f.at.z) > Math.abs(second.f.at.x - first.f.at.x) ? 'z' : 'x';
}

function skinnedMeshOf(root) {
  let found = null;
  root.traverse((o) => { if (!found && o.isSkinnedMesh && o.skeleton) found = o; });
  return found;
}

// The weighted centroid of the vertices each bone moves, in the ROOT's space —
// SKINNED, not read straight out of the vertex buffer.
//
// That distinction is the whole game on this model. Its vertex positions are
// the bind pose, and the pose the file actually loads in is a different one, so
// a raw position is a claim about where a vertex used to be. Running the same
// blend the GPU runs is the only way to get a number that can be compared with
// where the bones are now. (Doing it the easy way put the fisherman's head 4
// units from his neck and read as "this model isn't a humanoid".)
function fleshCentroids(root, mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const skinIndex = geo.attributes.skinIndex;
  const skinWeight = geo.attributes.skinWeight;
  if (!pos || !skinIndex || !skinWeight) return null;

  const skeleton = mesh.skeleton;
  const bones = skeleton.bones;
  const inverses = skeleton.boneInverses;
  if (!inverses?.length) return null;

  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  // The full chain the skinning shader applies, minus the per-vertex part.
  const post = new THREE.Matrix4()
    .multiplyMatrices(toRoot, mesh.matrixWorld)
    .multiply(mesh.bindMatrixInverse);

  // bone.matrixWorld * boneInverse, once per bone rather than once per vertex.
  const offset = bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, inverses[i]));

  const sums = bones.map(() => ({ w: 0, v: new THREE.Vector3() }));
  const bind = new THREE.Vector3();
  const skinned = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const part = new THREE.Vector3();

  // Every 3rd vertex. The centroid of a few thousand samples lands in the same
  // place as the centroid of all of them, and this runs on a 20k-vertex mesh.
  for (let i = 0; i < pos.count; i += 3) {
    bind.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
    acc.set(0, 0, 0);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w <= 0.001) continue;
      const b = skinIndex.getComponent(i, k);
      if (!offset[b]) continue;
      acc.addScaledVector(part.copy(bind).applyMatrix4(offset[b]), w);
      total += w;
    }
    if (total <= 0) continue;
    skinned.copy(acc).divideScalar(total).applyMatrix4(post);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w <= 0.001) continue;
      const s = sums[skinIndex.getComponent(i, k)];
      if (!s) continue;
      s.w += w;
      s.v.addScaledVector(skinned, w);
    }
  }
  return sums.map((s) => (s.w > 0 ? { weight: s.w, at: s.v.clone().divideScalar(s.w) } : null));
}

export function buildHumanoidRig(root) {
  const mesh = skinnedMeshOf(root);
  if (!mesh) return null;
  const flesh = fleshCentroids(root, mesh);
  if (!flesh) return null;

  const bones = mesh.skeleton.bones;
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const bonePos = bones.map((b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(toRoot));

  // Standing height and the mid-line, measured off the flesh rather than off
  // the bounding box — a coat or a fishing rod would widen the box without
  // moving anybody's shoulders.
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of flesh) {
    if (!f) continue;
    lo = Math.min(lo, f.at.y);
    hi = Math.max(hi, f.at.y);
  }
  const height = hi - lo;
  if (!(height > 0)) return null;

  // WHICH WAY IS LEFT? Not x, necessarily. A model oriented side-on to the
  // camera — which is what this game does to everything — has its left-right
  // axis pointing INTO the screen, so it stands at x≈0 and its two legs are
  // separated in z. Telling left from right by x then picks the same leg
  // twice, and everything downstream (which limb is which, where the chest is,
  // which bone is the head) is built on that mistake.
  //
  // Found from the LEGS. The widest spread of flesh is the obvious-looking
  // answer and it is wrong: this fisherman stands with an arm reaching
  // forward, which makes him wider front-to-back than shoulder-to-shoulder.
  // Two legs, though, are two heavy bones at the same height that belong to
  // neither each other — and the axis that separates THEM is the axis a body
  // is mirrored about, whatever it is doing with its arms.
  const lateral = lateralAxis(bones, flesh, lo, height);

  // Pick the best-weighted bone near a target. Weight matters as well as
  // distance: a fingertip and a forearm sit near each other, and the one that
  // moves an arm's worth of mesh is the one the ragdoll wants.
  //
  // `under` is the constraint that does the real work. This fisherman wears a
  // COAT, and its flaps are rigged — a coat bone hangs exactly where a forearm
  // is and won a straight distance contest, so the left arm was being driven
  // by a bit of clothing. Requiring a candidate to descend from the limb it
  // belongs to rules that out by construction, and no measurement of position
  // ever could.
  const pick = (target, under = null, notUnder = null) => {
    const [tx, ty] = target;
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < bones.length; i++) {
      const f = flesh[i];
      if (!f) continue;
      if (under != null && !descendsFrom(bones[i], bones[under])) continue;
      // The other side's limb, and everything hanging off it. Without this the
      // second arm is free to pick a bone on the FIRST arm — they are both
      // "an arm-ish distance from the middle" — and then the two joints the
      // chest is derived from are on one chain and the chest lands on a
      // shoulder.
      if (notUnder != null && descendsFrom(bones[i], bones[notUnder])) continue;
      const dx = f.at[lateral] / height - tx;
      const dy = (f.at.y - lo) / height - ty;
      const miss = Math.hypot(dx, dy);
      if (miss > MAX_MISS) continue;
      const score = miss / Math.log10(10 + f.weight); // distance dominates
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  };

  const chosen = {};
  // LIMBS FIRST, then the torso derived from where they attach. A pelvis is
  // not "the bone near the hips" — half a dozen bones are near the hips,
  // including the top of each leg. It is the bone BOTH legs hang off, and the
  // same for the chest and the arms. Picking the torso by position instead
  // bound the hips to the left leg's root, which would have turned "lean the
  // body forward" into "swing the left leg".
  chosen.upperLegL = pick(TARGETS.upperLegL);
  chosen.upperLegR = pick(TARGETS.upperLegR, null, chosen.upperLegL);
  if (chosen.upperLegL == null || chosen.upperLegR == null) return null;
  chosen.upperArmL = pick(TARGETS.upperArmL);
  chosen.upperArmR = pick(TARGETS.upperArmR, null, chosen.upperArmL);
  if (chosen.upperArmL == null || chosen.upperArmR == null) {
    chosen.upperArmL = null;
    chosen.upperArmR = null;
  }

  const hipsBone = commonAncestor(bones[chosen.upperLegL], bones[chosen.upperLegR]);
  if (!hipsBone) return null;
  chosen.hips = bones.indexOf(hipsBone);

  const chestBone = chosen.upperArmL != null && chosen.upperArmR != null
    ? commonAncestor(bones[chosen.upperArmL], bones[chosen.upperArmR])
    : null;
  chosen.chest = chestBone ? bones.indexOf(chestBone) : pick(TARGETS.chest, chosen.hips);
  if (chosen.chest == null || chosen.chest === chosen.hips) return null;

  // The head is the top of the SPINE: the highest flesh hanging off the chest
  // that isn't on an arm. The exclusion is the whole of it — a man with a hand
  // raised has flesh higher than his head, and binding the head to a forearm
  // is a mistake the ragdoll then wears for the rest of the run.
  chosen.head = highestUnder(bones, flesh, chosen.chest, [chosen.upperArmL, chosen.upperArmR]);
  if (chosen.head == null) return null;

  // A forearm is the next joint down the arm — structure again, not position.
  // This model stands with its arms in two different poses, so the left
  // forearm sits nowhere near where a forearm "should" be and a position
  // search simply lost it.
  chosen.lowerArmL = heaviestChild(bones, flesh, chosen.upperArmL);
  chosen.lowerArmR = heaviestChild(bones, flesh, chosen.upperArmR);
  chosen.lowerLegL = heaviestChild(bones, flesh, chosen.upperLegL);
  chosen.lowerLegR = heaviestChild(bones, flesh, chosen.upperLegR);

  for (const key of Object.keys(chosen)) if (chosen[key] == null) delete chosen[key];

  // The direction each bone's own flesh lies in, expressed in that bone's
  // LOCAL space. This is the axis the limb runs along, measured rather than
  // assumed to be +Y — which it is on a Blender rig, right up until it isn't.
  const segments = {};
  const boneInverse = new THREE.Matrix4();
  for (const [joint, index] of Object.entries(chosen)) {
    const bone = bones[index];
    boneInverse.copy(bone.matrixWorld).invert();
    // Flesh is in root space; the bone's inverse expects world.
    const world = flesh[index].at.clone().applyMatrix4(root.matrixWorld);
    const axis = world.applyMatrix4(boneInverse);
    if (axis.lengthSq() < 1e-10) continue;
    segments[joint] = { name: bone.name, bone, axis: axis.normalize(), rest: bone.quaternion.clone() };
  }

  // The rest pose, in heights above the feet, for the verlet figure to be
  // built from. Joint positions come from the BONES (a joint is where a bone
  // starts), not from the flesh, which sits mid-limb.
  const at = (joint) => {
    const i = chosen[joint];
    if (i == null) return null;
    const p = bonePos[i];
    return { x: p.x / height, y: (p.y - lo) / height };
  };

  // How far the feet sit below the model's own origin, so a figure can be
  // stood on a deck rather than buried to the waist in it. prepareModel
  // re-centres every model on its centre of mass, which for a person is
  // somewhere around the navel.
  //
  // Taken from the flesh, NOT from a bounding box: Box3 on a skinned mesh
  // measures the BIND pose, and this model's bind pose is nowhere near the
  // pose it loads in — asking the box put his feet a metre underground.
  const originToFeet = lo;

  return {
    height, // in the root's units, before whatever scale it is drawn at
    originToFeet,
    segments,
    // Where the ragdoll's joints go, as fractions of height. Anything the
    // measurement couldn't place comes back null and the caller substitutes
    // its own default, so a partial rig still stands up.
    rest: {
      head: at('head'), chest: at('chest'), hips: at('hips'),
      elbowL: at('lowerArmL'), elbowR: at('lowerArmR'),
      shoulderL: at('upperArmL'), shoulderR: at('upperArmR'),
      kneeL: at('lowerLegL'), kneeR: at('lowerLegR'),
      hipL: at('upperLegL'), hipR: at('upperLegR'),
    },
    mesh,
  };
}

// Re-attach a measured rig to another copy of the same model. The measurement
// walks every vertex, which is worth doing once per asset and not once per
// person — and a skeleton clone keeps its bone names, so the map transfers by
// name. Returns null if this copy doesn't have the bones the map expects,
// which is the honest answer for a model that was swapped underneath us.
export function bindHumanoidRig(root, measured) {
  if (!measured) return null;
  const segments = {};
  for (const [joint, seg] of Object.entries(measured.segments)) {
    const bone = root.getObjectByName(seg.name);
    if (!bone?.isBone) return null;
    segments[joint] = { name: seg.name, bone, axis: seg.axis, rest: seg.rest };
  }
  let mesh = null;
  root.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
  return { ...measured, segments, mesh };
}

// Aim one bone along a world direction. The bone's own measured axis is what
// gets pointed; twist is left alone, which for a body tumbling through the air
// is a distinction nobody can see.
const _parentQuat = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();

export function aimBone(segment, wx, wy) {
  const { bone, axis } = segment;
  _dir.set(wx, wy, 0);
  if (_dir.lengthSq() < 1e-10) return;
  _dir.normalize();
  // Parents first: a bone's local rotation is relative to wherever its parent
  // has ended up this frame, so the parent chain has to be current before this
  // one can be solved. Children are left for their own turn.
  bone.updateWorldMatrix(true, false);
  bone.parent.getWorldQuaternion(_parentQuat);
  _inv.copy(_parentQuat).invert();
  _dir.applyQuaternion(_inv);
  bone.quaternion.copy(_q.setFromUnitVectors(axis, _dir));
  bone.updateMatrixWorld(true);
}

// Put the whole model where the ragdoll says its hips are. Done by measuring
// the error and correcting it rather than by arithmetic on the rest pose: the
// bones have all just moved, and where the hips ENDED UP is the only number
// that accounts for that.
const _hips = new THREE.Vector3();
export function anchorToHips(root, hipsBone, x, y) {
  root.updateMatrixWorld(true);
  _hips.setFromMatrixPosition(hipsBone.matrixWorld);
  root.position.x += x - _hips.x;
  root.position.y += y - _hips.y;
  root.updateMatrixWorld(true);
}
