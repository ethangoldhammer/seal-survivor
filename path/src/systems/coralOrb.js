import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { advanceCycles } from './beatSync.js';
import { telegraphMul } from './telegraph.js';

// ---------------------------------------------------------------------------
// THE CORAL — the fire-rate pickup, the yellow one that doubles your gun for
// eight seconds.
//
// It used to be a rock: the same tumbling stone the strike orb is, in a
// different colour. Three of the game's four floating pickups were the same
// primitive with three tints on it, so the only thing separating "full strike
// meter", "a breath of air" and "double fire rate" was hue — on a screen where
// the water is blue, the blood is red and half the creatures glow.
//
// So this one is a piece of BIOLUMINESCENT CORAL, and the two words are doing
// separate jobs:
//
//   FRACTAL   the geometry is grown, not modelled. A stalk splits, each branch
//             splits again, and every angle, length and taper along the way is
//             rolled. No two are the same object — which is the point, because
//             a hand-modelled coral repeated forty times a run is a prop, and
//             the seabed here is already full of props. See growCoral().
//   LIT       the light is a VERTEX ATTRIBUTE, not a texture and not an
//             emissive map: `aTip` runs 0 at the holdfast to 1 at the tips, and
//             the pulse in the fragment shader is a wave travelling OUT along
//             it. An unlit MeshBasicMaterial cannot take an emissive map at all
//             (see the note on eye glow), and a wave that travels is what makes
//             this read as a living thing rather than as a lamp.
//
// THE PULSE IS ON THE BEAT, through systems/beatSync.js like every other
// synced effect. It is a slow one — a whole bar by default — because this is
// ambient light on a stationary object and a fast pulse would read as a
// warning.
//
// IT TURNS, SLOWLY. That is the whole of its motion: the rock it replaced
// tumbled on three axes at 1.2 rad/s, which is what you do to a featureless
// stone. A branching thing has a silhouette, and the silhouette is the read, so
// it turns about one axis slowly enough that you can see the shape change.
//
// Numbers: CONFIG.rapidFirePickup.coral.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.rapidFirePickup?.coral ?? {};
}

// Which side each child of a fork takes: left, right, then straight on. See
// the note in growCoral — the order matters, because a two-child fork must be
// the balanced pair and only a three-child one gets the middle branch.
const LEAN = [-1, 1, 0];

// ---------------------------------------------------------------------------
// GROWING ONE
// ---------------------------------------------------------------------------

// A tapered segment, built as a cone frustum and then bent slightly, because a
// coral branch that is a straight tube reads as a pipe. `bend` is applied along
// the segment's own length, which is why this builds in local space and the
// caller supplies the matrix.
function segment(len, r0, r1, bend, sides) {
  // openEnded: the caps are never visible — the base is inside its parent and
  // the tip is capped by the branch that grows out of it or by nothing at all,
  // at a radius small enough to be a point.
  const geo = new THREE.CylinderGeometry(r1, r0, len, sides, 3, true);
  // Cylinders are built centred; move it so the segment starts at its own
  // origin and grows along +Y, which is what makes the recursive placement
  // below a single translate-and-rotate rather than an offset per level.
  geo.translate(0, len / 2, 0);
  if (bend) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const t = y / len;
      // Quadratic in the length, so the base leaves straight and the curve
      // gathers toward the tip. Linear reads as a segment leaning over.
      p.setX(i, p.getX(i) + bend * t * t * len);
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

/**
 * Grow one coral and return a single merged BufferGeometry.
 *
 * `rand` is injected so the harness can seed it — the whole promise of this
 * asset is that no two are alike, and "are they actually different" is a
 * question you can only ask by growing several from known seeds and measuring
 * them. See tools/coral-orb-test.mjs.
 *
 * The geometry carries an extra `aTip` attribute: 0 at the holdfast, 1 at the
 * tips. Everything about the light reads off it.
 */
export function growCoral(rand = Math.random) {
  const c = cfg();
  const parts = [];
  const tips = [];
  const sides = Math.max(3, Math.round(c.sides ?? 6));
  const depthMax = Math.max(1, Math.round(c.depth ?? 4));
  const spread = c.spread ?? 0.85;
  const lengthFall = c.lengthFall ?? 0.72;
  const radiusFall = c.radiusFall ?? 0.62;

  // BREADTH-FIRST, and that is not a detail. `maxSegments` is a hard stop, and
  // a depth-first walk spends the whole budget growing one branch all the way
  // out before it starts the next — so a coral that hits the cap comes out as
  // one long spike with stumps beside it. A queue spends the budget a
  // generation at a time, so the cap trims the finest tips evenly and a capped
  // coral is simply a slightly less detailed coral.
  const stack = [{
    matrix: new THREE.Matrix4(),
    len: c.length ?? 0.5,
    r: c.radius ?? 0.075,
    depth: 0,
  }];

  const cap = Math.max(1, Math.round(c.maxSegments ?? 60));
  while (stack.length && parts.length < cap) {
    const node = stack.shift();
    const taper = c.taper ?? 0.62;
    const bend = (rand() * 2 - 1) * (c.bend ?? 0.35);
    const geo = segment(node.len, node.r, node.r * taper, bend, sides);
    geo.applyMatrix4(node.matrix);
    parts.push(geo);

    // How lit this segment is, base to tip, as a fraction of the whole tree's
    // depth. Written per SEGMENT rather than per vertex position so a long
    // branch and a short one at the same generation glow alike — the light is
    // about how far out on the structure you are, not how far from the origin.
    const t0 = node.depth / depthMax;
    const t1 = Math.min(1, (node.depth + 1) / depthMax);
    tips.push({ geo, t0, t1, len: node.len });

    if (node.depth + 1 >= depthMax) continue;

    // 2 or 3 children. Sometimes 1, which is what makes a coral look grown
    // rather than generated: a tree that branches at every node is a fractal
    // diagram, and a real one has runs of plain stalk in it.
    const roll = rand();
    // THE HOLDFAST ALWAYS FORKS. A single child at depth 0 puts two segments
    // end to end before the first branch, which is a trunk — and a trunk is the
    // one silhouette a coral must not have. Everywhere else a run of plain
    // stalk is exactly what stops this looking generated.
    const single = node.depth > 0 && roll < (c.singleChance ?? 0.08);
    const children = single ? 1 : (roll < (c.tripleAbove ?? 0.55) ? 2 : 3);
    // A small per-node roll on top of the fan, or every fork in every coral in
    // the game faces exactly the same way.
    const phase = (rand() - 0.5) * (c.fanJitter ?? 0.9);
    for (let i = 0; i < children; i++) {
      // The child's frame: translate to the parent's ACTUAL tip, roll about the
      // parent's own axis, then tilt away from it.
      //
      // The x offset is the bend, and leaving it out is a real bug rather than
      // a nicety: `segment` curves the parent's vertices to `bend * len` at the
      // top, so a child attached at x=0 starts wherever the parent WOULD have
      // ended if it were straight. On a bent parent that is a visible gap, and
      // a coral with gaps in it renders as a cluster of floating dashes rather
      // than as one organism.
      const m = new THREE.Matrix4().makeTranslation(bend * node.len, node.len, 0);
      // LEFT, RIGHT, AND STRAIGHT ON. Written out rather than derived from
      // `i / children`, and this is the difference between a coral and a
      // leaning tree.
      //
      // An even fan round the parent's axis looks right on paper and is wrong
      // here twice over. The game is a side view of the XY plane, so a branch a
      // quarter turn round the axis tilts into Z and is foreshortened to
      // nothing — which is why the fan is FLATTENED back toward the plane
      // below. But flattening an even fan collapses it: with three children the
      // second and third both round to the same half turn and grow out the same
      // side, and the whole coral leans. Naming the sides makes the fan
      // balanced by construction, and the third child carries the parent's
      // direction on instead of picking a side.
      const lean = LEAN[i % LEAN.length];
      // The half-turn IS the mirror: rotating a further pi about the parent's
      // axis flips its local X, so both sides take the same positive tilt below
      // and come out opposed. Applying an alternating SIGN to the tilt as well
      // would undo the flip and put both children back on one side — which is
      // exactly the lean this replaced.
      let about = phase + (lean < 0 ? Math.PI : 0) + (rand() - 0.5) * 0.5;
      const flatten = Math.max(0, Math.min(1, c.flatten ?? 0.75));
      about += (Math.round(about / Math.PI) * Math.PI - about) * flatten;
      m.multiply(new THREE.Matrix4().makeRotationY(about));
      // Wider at the base and tighter toward the tips, so the silhouette opens
      // out and then closes — a constant angle grows a bush. The straight-on
      // child barely tilts at all; that is what makes it read as the parent
      // continuing rather than as a third arm.
      const tilt = spread * (0.55 + 0.75 * (1 - node.depth / depthMax)) * (0.6 + rand() * 0.8)
        * (lean === 0 ? (c.centreTilt ?? 0.25) : 1);
      m.multiply(new THREE.Matrix4().makeRotationZ(tilt));
      stack.push({
        matrix: node.matrix.clone().multiply(m),
        len: node.len * lengthFall * (0.75 + rand() * 0.5),
        r: node.r * radiusFall,
        depth: node.depth + 1,
      });
    }
  }

  // The tip attribute, per part, before the merge — mergeGeometries requires
  // every input to carry the same attribute set, so this cannot be added
  // afterwards without walking the merged buffer and re-deriving which vertex
  // came from where.
  for (const { geo, t0, t1, len } of tips) {
    const p = geo.attributes.position;
    const a = new Float32Array(p.count);
    // The segment has already been transformed into tree space by the time we
    // get here, so the along-the-segment position has to come from the
    // UNtransformed cylinder — which is what the second attribute the cylinder
    // still carries, its UV, gives for free. uv.y is 0..1 along the length.
    const uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const along = uv ? uv.getY(i) : 1;
      a[i] = t0 + (t1 - t0) * along;
    }
    geo.setAttribute('aTip', new THREE.BufferAttribute(a, 1));
    void len;
  }

  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) return new THREE.SphereGeometry(0.3, 8, 8);

  // Centre it on its own mass and stand it up. The tree grew from the origin
  // along +Y, so without this the pickup rotates about its holdfast and swings
  // its whole body around like a flag.
  merged.computeBoundingBox();
  const box = merged.boundingBox;
  const mid = new THREE.Vector3();
  box.getCenter(mid);
  merged.translate(-mid.x, -mid.y, -mid.z);

  // Normalised to a known size, so `radius`/`length` above are free to be about
  // the SHAPE (how thin the branches are relative to their length) and the
  // pickup's actual size stays the asset table's business. Without this a lucky
  // roll grows a coral three times the size of an unlucky one.
  const size = new THREE.Vector3();
  box.getSize(size);
  const biggest = Math.max(size.x, size.y, size.z) || 1;
  const k = (c.fit ?? 1) / biggest;
  merged.scale(k, k, k);
  return merged;
}

// ---------------------------------------------------------------------------
// THE LIGHT
// ---------------------------------------------------------------------------

// A pulse that travels OUT along the branches, plus a floor so the whole thing
// is always faintly lit. `aTip` is the distance along the structure; subtracting
// it from the phase is what makes the wave move rather than blink.
//
// NO BACKTICK IN HERE, comments included — one ends the template literal and
// reports itself as an error in a completely different file. And no fwidth:
// this has to compile under GLSL ES 1.00.
const CORAL_FRAGMENT = `
  float coralWave = fract(uCoralPhase - vCoralTip * uCoralTravel);
  // Sharpened with a power rather than a smoothstep pair: one instruction, and
  // the shoulder it leaves is the part that reads as light bleeding along a
  // branch instead of a band sliding down it.
  float coralPulse = pow(1.0 - coralWave, uCoralSharp);
  // Brighter at the tips even at rest. A coral lit evenly is a neon sign.
  float coralBase = uCoralFloor + (1.0 - uCoralFloor) * vCoralTip;
  vec4 diffuseColor = vec4(diffuse * (coralBase + coralPulse * uCoralGlow * vCoralTip), opacity);
`;

function makeCoralMaterial(color) {
  const c = cfg();
  const mat = new THREE.MeshBasicMaterial({ color });
  mat.userData.__coral = {
    uCoralPhase: { value: 0 },
    uCoralTravel: { value: c.waveTravel ?? 0.85 },
    uCoralSharp: { value: c.waveSharp ?? 3.5 },
    uCoralGlow: { value: c.pulseGlow ?? 2.6 },
    uCoralFloor: { value: c.restFloor ?? 0.35 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.__coral);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aTip;\nvarying float vCoralTip;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvCoralTip = aTip;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform float uCoralPhase;\nuniform float uCoralTravel;'
        + '\nuniform float uCoralSharp;\nuniform float uCoralGlow;\nuniform float uCoralFloor;'
        + '\nvarying float vCoralTip;')
      // Replaces the line that DECLARES diffuseColor, so the map, the tint and
      // the alpha test downstream all still run on top of it — same injection
      // point, and the same reason, as the bubble film's.
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', CORAL_FRAGMENT);
  };
  return mat;
}

// ---------------------------------------------------------------------------
// THE PICKUP
// ---------------------------------------------------------------------------

/**
 * One coral pickup — a Mesh with its own grown geometry and its own material.
 *
 * BOTH are per instance, and that is the cost of this asset: the geometry
 * because it is the whole point, and the material because the pulse phase lives
 * in a uniform and a shared one would beat every coral in the water as a single
 * organism. There are at most two of these alive at a time (one every 10-26s,
 * living 14s), so it is two draw calls' worth of state, not forty.
 *
 * The saved Look-panel TINT is read here rather than reaching this through
 * applySavedAssetLooks, which only ever writes the cached material for an asset
 * key. Same arrangement the rock pool already has for its bake, and for the
 * same reason: a slider drag lands on the next one spawned.
 *
 * THE SAVED GLOW IS DELIBERATELY NOT READ. It was tuned against a rock, whose
 * shading is baked into its vertex colours with a floor deep enough to survive
 * being multiplied — 6.9 there is a lit stone. Here the brightness IS the
 * gradient: the shader ramps from a dim holdfast to blooming tips, and putting
 * a 6.9 in front of that pushes the entire structure past the clip, so the
 * trunk and the tips come out as the same flat yellow and the one thing that
 * makes this read as a living coral is deleted. This asset carries its own
 * `glow`, which is what that ramp is sized against.
 */
export function createCoralOrb(rand = Math.random) {
  const c = cfg();
  const look = CONFIG.assetLooks?.rapidFireOrb ?? {};
  const tint = look.tint ?? c.color ?? 0xffe066;
  const glow = c.glow ?? 1.6;
  const geo = growCoral(rand);
  const mat = makeCoralMaterial(new THREE.Color(tint).multiplyScalar(glow));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'rapidFireOrb';
  mesh.userData.coral = {
    // Its own base colour, kept so the coach's highlight can multiply rather
    // than replace — see updateCoralOrb.
    base: new THREE.Color(tint).multiplyScalar(glow),
    phase: 0,
    // A per-individual spin direction and a starting angle, so two on screen
    // at once are plainly two objects.
    spin: (rand() < 0.5 ? -1 : 1) * (c.spin ?? 0.55) * (0.7 + rand() * 0.6),
    bobPhase: rand() * Math.PI * 2,
  };
  mesh.rotation.y = rand() * Math.PI * 2;
  // Corals here are grown along +Y and the game looks at the XY plane from +Z,
  // so a small lean is what stops the branch fan from being drawn edge-on. Not
  // a full rotation: standing it up IS the read.
  mesh.rotation.z = (rand() - 0.5) * 0.5;
  return mesh;
}

/**
 * One coral, one frame. `rawDt` for the same reason every other beat-synced
 * effect takes it — a light in the water does not stop because the game froze
 * for 60ms on a hit.
 */
export function updateCoralOrb(mesh, dt, rawDt = dt) {
  const state = mesh?.userData?.coral;
  if (!state) return;
  const c = cfg();

  // THE TURN. One axis, slowly — see the header. `dt`, not raw: this is the
  // object moving in the water, and the water is what hit-stop dilates.
  mesh.rotation.y += state.spin * dt;
  // A lazy nod on top, so it reads as hanging in the water rather than as being
  // driven by a motor.
  state.bobPhase += rawDt * (c.bobRate ?? 0.7);
  mesh.rotation.z = Math.sin(state.bobPhase) * (c.bob ?? 0.14);

  // THE PULSE, on the grid. `wrap` is 1 because the shader takes fract() of it
  // and nothing else reads the count — see advanceCycles.
  state.phase = advanceCycles(state.phase, c.pulseSync ?? '1 bar', c.freeRate ?? 0.5, rawDt, 1);
  const u = mesh.material?.userData?.__coral;
  if (u) u.uCoralPhase.value = state.phase;

  // The coach's highlight, folded into this module because it is the coral's
  // one colour writer — the 'ask' mode in systems/telegraph.js. 1 whenever the
  // tip on screen is about something else, which is nearly always.
  const lit = telegraphMul(mesh);
  mesh.material?.color?.copy(state.base).multiplyScalar(lit);
}

/** Give back a coral's geometry and material — both are its own. */
export function disposeCoralOrb(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose?.();
  mesh.material?.dispose?.();
}

// For the harness and the look page. Nothing in Node compiles GLSL, so a
// uniform renamed on one side of the pair and not the other is otherwise
// silently invisible rather than an error.
export const __coralShader = { CORAL_FRAGMENT };
