// Give a static humanoid mesh a skeleton, so systems/crew.js can ragdoll it.
//
//   npm run rig:guest -- <source.glb> [out.glb]
//
// The SOURCE is the untouched download, which lives outside the repo:
//   ~/Documents/_DesignSystems/SealSurvivor/ballroom_character.glb
// The output overwrites public/models/ballroomguest.glb. Run it against the
// source, never against the output — a second pass over an already-rigged file
// would flatten the skin it just made.
//
// WHY THIS EXISTS. The crew ragdoll drives REAL BONES: systems/humanoidRig.js
// measures where each bone's vertices actually sit, picks the eleven joints the
// verlet figure needs, and systems/crew.js aims those bones at the solver's
// points every frame. It needs a SkinnedMesh. `ballroom_character.glb` — the
// yacht's guest — ships 0 skins and 0 clips: it is a 9,128-triangle statue.
// Loaded as-is it fails buildHumanoidRig, silently falls back to the box body,
// and the man in the tailcoat is never drawn at all. That failure is invisible
// in code review and obvious on screen, which is why this is a build step and
// not a runtime fallback.
//
// WHAT IT DOES, in the order it matters:
//
//   MEASURES THE FIGURE. Crotch, neck, shoulders, hands and feet are found by
//        slicing the mesh horizontally and reading the silhouette — see each
//        rule below. Nothing here is a hand-typed fraction of height except the
//        two places that say so.
//
//   SEGMENTS BEFORE IT SKINS. The tempting one-liner — weight every vertex by
//        inverse distance to the nearest bone — fails on exactly this pose. A
//        man stands in an A-pose with his hands at his hips; the flank of his
//        jacket is 0.10 from the upper-arm bone and 0.20 from the spine, so
//        inverse distance hands his ribs to his arm and the torso tears open on
//        the first tumble. So vertices are first sorted into PARTS by the
//        measured silhouette (below the crotch and left of centre is a leg, and
//        no distance test can overrule it), and only then assigned to the
//        nearest bone WITHIN that part.
//
//   SMOOTHS THE SEAMS. That gives hard edges at the shoulder, hip and neck. A
//        few passes of Laplacian smoothing over the welded vertex graph turns
//        them into blends, and because the graph crosses part boundaries the
//        blend happens exactly where two parts meet and nowhere else.
//
// The output keeps the source's material and all three of its textures. It
// drops TANGENT: three.js derives a tangent frame in the fragment shader when
// the attribute is absent, and the normal map looks the same for 60 KB less.
import { writeFileSync } from 'node:fs';
import {
  readGlb, flattenMesh, writeSkinnedGlb, imageBytes,
} from './lib/glb.mjs';

const SRC = process.argv[2]
  ?? `${process.env.HOME}/Documents/_DesignSystems/SealSurvivor/ballroom_character.glb`;
const OUT = process.argv[3] ?? 'public/models/ballroomguest.glb';
if (SRC === OUT) {
  console.error('refusing to rig a file onto itself — pass the untouched source, not the output');
  process.exit(1);
}

const glb = readGlb(SRC);
const mesh = flattenMesh(glb);
const { positions, normals, uvs, indices } = mesh;
const N = positions.length / 3;
const px = (i) => positions[i * 3];
const py = (i) => positions[i * 3 + 1];
const pz = (i) => positions[i * 3 + 2];

// ---------------------------------------------------------------------------
// Measuring the figure
// ---------------------------------------------------------------------------

let lo = Infinity;
let hi = -Infinity;
for (let i = 0; i < N; i++) {
  if (py(i) < lo) lo = py(i);
  if (py(i) > hi) hi = py(i);
}
const H = hi - lo;
const frac = (y) => (y - lo) / H;

// Vertices in a horizontal band, as indices.
function band(y0, y1) {
  const out = [];
  for (let i = 0; i < N; i++) if (py(i) >= y0 && py(i) < y1) out.push(i);
  return out;
}

const SLICES = 160;
const step = H / SLICES;
const slices = [];
for (let s = 0; s < SLICES; s++) {
  const idx = band(lo + s * step, lo + (s + 1) * step);
  let absMax = 0;
  let centre = 0;
  for (const i of idx) {
    absMax = Math.max(absMax, Math.abs(px(i)));
    // A narrow column on the mid-line. Empty means two legs, not one body.
    if (Math.abs(px(i)) < H * 0.012) centre++;
  }
  slices.push({ y: lo + (s + 0.5) * step, idx, absMax, centre });
}

// THE CROTCH is the lowest height at which anything stands on the mid-line.
// Below it the model is two separate legs with a hole between them; at it the
// hole closes. Measured rather than assumed because it is the one landmark
// every other leg number is derived from.
const crotchSlice = slices.findIndex((s) => s.idx.length > 0 && s.centre > 0);
if (crotchSlice < 0) throw new Error('no crotch found — is this a humanoid?');
const crotchY = slices[crotchSlice].y;

// THE NECK is the narrowest slice in the upper body. A collar is the thinnest
// thing on a dressed man, and both the head above it and the shoulders below it
// are wider — which is what makes a minimum, rather than a threshold, the right
// tool: it needs no idea in advance of how wide a neck is.
//
// Measured on a DILATED profile — each slice takes the widest reading within
// two slices of itself. A thin horizontal slice through a curved surface can
// catch almost no vertices at all (the crown of the top hat is the worst case
// on this model), and a slice holding four stray vertices reports a half-width
// near zero. Taken raw, that noise wins the minimum every time and the "neck"
// lands on top of the hat — from where the shoulders come out above the arms,
// the arm search runs the length of the body, and both legs are rigged as
// sleeves. Dilating first is what makes the minimum a fact about the SHAPE.
const widths = slices.map((s, i) => {
  let w = 0;
  for (let k = Math.max(0, i - 2); k <= Math.min(SLICES - 1, i + 2); k++) {
    w = Math.max(w, slices[k].absMax);
  }
  return w;
});
let neckSlice = -1;
let neckWidth = Infinity;
for (let s = 0; s < SLICES; s++) {
  const f = frac(slices[s].y);
  // Capped below the crown for the same reason: above the hat's brim the
  // silhouette narrows again, and the very top of a head is narrower than any
  // neck.
  if (f < 0.60 || f > 0.90 || !slices[s].idx.length) continue;
  if (widths[s] < neckWidth) { neckWidth = widths[s]; neckSlice = s; }
}
if (neckSlice < 0) throw new Error('no neck found');
const neckY = slices[neckSlice].y;

// THE SHOULDERS are where the body stops being a neck. Scanning down from the
// neck, the first slice more than twice its width is the top of the deltoid;
// the joint itself sits a little under that.
let shoulderY = neckY;
for (let s = neckSlice; s >= 0; s--) {
  if (slices[s].idx.length && widths[s] > neckWidth * 2) { shoulderY = slices[s].y; break; }
}
// The waist. Not a landmark anybody can see on a tailcoat, and it is not asked
// to be one: it exists only to split the torso's vertices between the two
// bones that carry it, and half way up is where a spine bends.
const waistY = (crotchY + shoulderY) / 2;

// ARMS, one side at a time. In any slice between the hands and the shoulders,
// an arm is separated from the torso by a real gap in x — the largest gap on
// that side of the mid-line is the armpit seam, and everything outboard of it
// is arm. This is what a silhouette actually gives you, and it survives the
// arm's angle changing as it rises, which a fixed "wider than the torso"
// threshold does not.
const MIN_GAP = H * 0.01;
function armSide(sign) {
  const verts = [];
  for (const s of slices) {
    // Bounded at the crotch as well as at the shoulder. Below the crotch the
    // largest gap on a side is the one between the two LEGS, and an unbounded
    // search happily reports a trouser leg as a sleeve — which is not a subtle
    // failure, it rigs the whole lower body to the arms.
    if (s.y > shoulderY || s.y < crotchY || !s.idx.length) continue;
    const side = s.idx.filter((i) => Math.sign(px(i)) === sign);
    if (side.length < 4) continue;
    side.sort((a, b) => Math.abs(px(a)) - Math.abs(px(b)));
    let gap = 0;
    let cut = -1;
    for (let k = 1; k < side.length; k++) {
      const d = Math.abs(px(side[k])) - Math.abs(px(side[k - 1]));
      if (d > gap) { gap = d; cut = k; }
    }
    if (gap < MIN_GAP || cut < 0) continue;
    for (let k = cut; k < side.length; k++) verts.push(side[k]);
  }
  return verts;
}

// A limb's own centre-line, as a polyline sampled along y. Taking the centroid
// of each band rather than the extreme vertex is what keeps a sleeve's cuff
// from dragging the line sideways.
function centreLine(verts, bands = 10) {
  if (!verts.length) return [];
  let a = Infinity;
  let b = -Infinity;
  for (const i of verts) { a = Math.min(a, py(i)); b = Math.max(b, py(i)); }
  const out = [];
  for (let k = 0; k < bands; k++) {
    const y0 = a + ((b - a) * k) / bands;
    const y1 = a + ((b - a) * (k + 1)) / bands;
    let n = 0; let sx = 0; let sy = 0; let sz = 0;
    for (const i of verts) {
      if (py(i) < y0 || py(i) >= y1) continue;
      sx += px(i); sy += py(i); sz += pz(i); n++;
    }
    if (n) out.push([sx / n, sy / n, sz / n]);
  }
  // Top of the limb first, so `along` below reads root -> tip.
  return out.reverse();
}

// A point a fraction of the way along a polyline, by arc length.
function along(line, t) {
  if (line.length < 2) return line[0] ?? [0, 0, 0];
  const seg = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const d = Math.hypot(
      line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1], line[i][2] - line[i - 1][2],
    );
    seg.push(d); total += d;
  }
  let want = t * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const u = seg[i] > 0 ? Math.min(1, want / seg[i]) : 0;
      return [0, 1, 2].map((k) => line[i][k] + (line[i + 1][k] - line[i][k]) * u);
    }
    want -= seg[i];
  }
  return line[line.length - 1];
}

const armL = armSide(1);
const armR = armSide(-1);
if (armL.length < 20 || armR.length < 20) throw new Error('could not separate the arms');
const lineL = centreLine(armL);
const lineR = centreLine(armR);

// Legs: everything below the crotch, split by which side of the mid-line it is
// on. No gap test needed — the crotch measurement already proved there is
// nothing in the middle down here.
const legVerts = (sign) => {
  const out = [];
  for (let i = 0; i < N; i++) if (py(i) < crotchY && Math.sign(px(i)) === sign) out.push(i);
  return out;
};
const legL = legVerts(1);
const legR = legVerts(-1);
const legLineL = centreLine(legL);
const legLineR = centreLine(legR);
// How far out the leg's own centre-line runs. Used as the width of the pelvis
// below, so the split between "hip" and "groin" is taken from where this
// figure's legs actually are.
const legX = (Math.abs(legLineL[0]?.[0] ?? 0) + Math.abs(legLineR[0]?.[0] ?? 0)) / 2;

// THE TWO PROPORTIONS. Everything above is measured off this model; these two
// are anatomy, because the geometry does not mark them. A trouser leg is the
// same width at the knee as above and below it, and a sleeve is the same width
// at the elbow — there is no silhouette feature to find. Both are placed by arc
// length along the limb's own measured centre-line, so they still land on THIS
// figure's limbs however long they are.
const KNEE_ALONG = 0.55;
const ELBOW_ALONG = 0.45;
const WRIST_ALONG = 0.86;
const ANKLE_ALONG = 0.88;

// WHICH END OF A BONE ITS ORIGIN SITS AT is not a matter of taste, and the two
// halves of a body answer it differently. systems/humanoidRig.js measures each
// bone's `axis` as the direction from its origin toward its own flesh, and
// systems/crew.js then aims that axis along the ragdoll's limb. So:
//
//   A LIMB starts at the joint ABOVE it — a forearm at the elbow, a shin at the
//        knee — and its flesh hangs below. Aiming it points the limb.
//   THE SPINE starts at the joint BELOW it and its flesh stacks above, which is
//        what a Blender spine chain does and what crew.js's DRIVEN list expects
//        when it aims the chest from the chest TOWARD THE HEAD.
//
// Get the torso backwards — pelvis at the navel, chest at the sternum, both
// with their flesh underneath — and every bone still binds, every joint is
// still found, and the rig still reports as healthy. It simply loads upside
// down, because the root's axis is being aimed 180° from where it was measured.
const joint = {
  hips: [0, crotchY, 0],
  chest: [0, waistY, 0],
  head: [0, neckY, 0],
  headTop: [0, hi, 0],

  upperArmL: along(lineL, 0), lowerArmL: along(lineL, ELBOW_ALONG),
  handL: along(lineL, WRIST_ALONG), armTipL: along(lineL, 1),
  upperArmR: along(lineR, 0), lowerArmR: along(lineR, ELBOW_ALONG),
  handR: along(lineR, WRIST_ALONG), armTipR: along(lineR, 1),

  // THE HIP SOCKET IS NOT THE CROTCH. It is level with the pelvis and out at
  // the top of the thigh — which is both what a skeleton looks like and, less
  // obviously, what makes this model rig at all. buildHumanoidRig looks for a
  // thigh 0.42 of the way up the body and scores candidates by distance and
  // weight; a thigh bone that starts at the crotch has its flesh centred at
  // 0.29, and the PELVIS — sitting at 0.54 and carrying most of the jacket —
  // wins the thigh's own target. The rig is then rejected outright, because
  // the search for the second thigh excludes everything descending from the
  // first pick and every bone descends from the pelvis. Lifting the socket and
  // handing the thigh its share of the hip moves that centroid to 0.38 and
  // settles the contest on the merits.
  upperLegL: [along(legLineL, 0)[0], crotchY + H * 0.10, along(legLineL, 0)[2]],
  lowerLegL: along(legLineL, KNEE_ALONG), footL: along(legLineL, ANKLE_ALONG),
  upperLegR: [along(legLineR, 0)[0], crotchY + H * 0.10, along(legLineR, 0)[2]],
  lowerLegR: along(legLineR, KNEE_ALONG), footR: along(legLineR, ANKLE_ALONG),
};
// The toe, so the foot bone has a direction to point. The shoe's furthest
// vertex in z, which is the only part of this figure that sticks out forwards.
for (const [key, verts] of [['toeL', legL], ['toeR', legR]]) {
  const ankleY = joint[key === 'toeL' ? 'footL' : 'footR'][1];
  let best = null;
  for (const i of verts) {
    if (py(i) > ankleY) continue;
    if (!best || pz(i) > pz(best)) best = i;
  }
  joint[key] = best == null ? [0, lo, 0] : [px(best), py(best), pz(best)];
}

// The hips bone sits on the mid-line, but each leg starts at its own hip
// socket — out at the top of the thigh, where the measurement already puts it.
console.log(`\n${SRC}`);
console.log(`  ${N} verts, ${indices.length / 3} tris, height ${H.toFixed(3)}`);
console.log('  LANDMARKS (as fractions of total height)');
console.log(`    crotch    ${frac(crotchY).toFixed(3)}`);
console.log(`    neck      ${frac(neckY).toFixed(3)}   half-width ${neckWidth.toFixed(3)}`);
console.log(`    shoulder  ${frac(shoulderY).toFixed(3)}`);
console.log(`    arm verts ${armL.length} / ${armR.length}`);
console.log(`    leg verts ${legL.length} / ${legR.length}`);
console.log('  JOINTS');
for (const [k, v] of Object.entries(joint)) {
  console.log(`    ${k.padEnd(11)} x ${v[0].toFixed(3).padStart(7)}  y ${v[1].toFixed(3).padStart(7)} (${frac(v[1]).toFixed(3)})  z ${v[2].toFixed(3).padStart(7)}`);
}

// ---------------------------------------------------------------------------
// The skeleton
// ---------------------------------------------------------------------------

// Each bone: its origin (which IS the joint — systems/humanoidRig.js reads the
// rest pose straight off bone positions), its parent, and the segment its own
// flesh lies along, which the skinning uses and which ends at its child.
//
// FEET AND HANDS EARN THEIR PLACE. Nothing drives them — the ragdoll has ten
// points and none of them is a toe. They are here because buildHumanoidRig
// measures standing height as the span of the FLESH, and without a foot bone
// the lowest flesh in the model is mid-shin. Every target it then checks is
// scaled to a body that appears to have no feet, and the thigh lands 0.22 of a
// height from where it is looked for — which is exactly the tolerance, i.e. a
// coin toss between a rigged man and a box.
//
// The spine's two bones split the torso at the waist, which falls out of the
// convention above rather than needing a rule of its own: `hips` runs crotch to
// waist and `chest` runs waist to neck, so each owns half. A single spine bone
// from pelvis to collar would leave the chest owning nothing but a collar, and
// a body that tumbles as one rigid slab from the hips up.
const BONES = [
  { name: 'hips', parent: null, at: 'hips', to: 'chest' },
  { name: 'chest', parent: 'hips', at: 'chest', to: 'head' },
  { name: 'head', parent: 'chest', at: 'head', to: 'headTop' },

  { name: 'upperArmL', parent: 'chest', at: 'upperArmL', to: 'lowerArmL' },
  { name: 'lowerArmL', parent: 'upperArmL', at: 'lowerArmL', to: 'handL' },
  { name: 'handL', parent: 'lowerArmL', at: 'handL', to: 'armTipL' },
  { name: 'upperArmR', parent: 'chest', at: 'upperArmR', to: 'lowerArmR' },
  { name: 'lowerArmR', parent: 'upperArmR', at: 'lowerArmR', to: 'handR' },
  { name: 'handR', parent: 'lowerArmR', at: 'handR', to: 'armTipR' },

  { name: 'upperLegL', parent: 'hips', at: 'upperLegL', to: 'lowerLegL' },
  { name: 'lowerLegL', parent: 'upperLegL', at: 'lowerLegL', to: 'footL' },
  { name: 'footL', parent: 'lowerLegL', at: 'footL', to: 'toeL' },
  { name: 'upperLegR', parent: 'hips', at: 'upperLegR', to: 'lowerLegR' },
  { name: 'lowerLegR', parent: 'upperLegR', at: 'lowerLegR', to: 'footR' },
  { name: 'footR', parent: 'lowerLegR', at: 'footR', to: 'toeR' },
];
const boneIndex = new Map(BONES.map((b, i) => [b.name, i]));
const bones = BONES.map((b) => ({
  name: b.name,
  parent: b.parent == null ? null : boneIndex.get(b.parent),
  position: joint[b.at],
}));

// Which bones a part is allowed to claim. This is the wall that keeps a jacket
// flank out of an arm.
const PARTS = {
  head: ['head'],
  torso: ['hips', 'chest'],
  armL: ['upperArmL', 'lowerArmL', 'handL'],
  armR: ['upperArmR', 'lowerArmR', 'handR'],
  legL: ['upperLegL', 'lowerLegL', 'footL'],
  legR: ['upperLegR', 'lowerLegR', 'footR'],
};

const part = new Array(N).fill('torso');
for (let i = 0; i < N; i++) if (py(i) >= neckY) part[i] = 'head';
for (const i of legL) part[i] = 'legL';
for (const i of legR) part[i] = 'legR';
// THE HIP FLARE. Above the crotch a leg has not ended — the buttock and the
// hip belong to the thigh, and only the groin between them belongs to the
// pelvis. Split at half the gap between the two legs' own centre-lines, so the
// dividing line is this figure's stance rather than a number. This is what
// lifts the thigh's flesh to where buildHumanoidRig looks for it; see the note
// on the hip socket above for what happens without it.
for (let i = 0; i < N; i++) {
  if (py(i) < crotchY || py(i) > joint.upperLegL[1]) continue;
  if (Math.abs(px(i)) < legX * 0.5) continue;
  part[i] = px(i) > 0 ? 'legL' : 'legR';
}
for (const i of armL) part[i] = 'armL';
for (const i of armR) part[i] = 'armR';

// Welded by position, because a UV seam splits a vertex in two and a graph
// built on raw indices is cut in half down every seam — smoothing across a
// shoulder would stop dead at the jacket's texture seam.
const key = (i) => `${Math.round(px(i) * 1e4)},${Math.round(py(i) * 1e4)},${Math.round(pz(i) * 1e4)}`;
const rep = new Map();
const canonical = new Array(N);
for (let i = 0; i < N; i++) {
  const k = key(i);
  if (!rep.has(k)) rep.set(k, i);
  canonical[i] = rep.get(k);
}
const neighbours = new Map();
const link = (a, b) => {
  const ca = canonical[a]; const cb = canonical[b];
  if (ca === cb) return;
  if (!neighbours.has(ca)) neighbours.set(ca, new Set());
  neighbours.get(ca).add(cb);
};
for (let t = 0; t < indices.length; t += 3) {
  link(indices[t], indices[t + 1]); link(indices[t + 1], indices[t]);
  link(indices[t + 1], indices[t + 2]); link(indices[t + 2], indices[t + 1]);
  link(indices[t + 2], indices[t]); link(indices[t], indices[t + 2]);
}

// AND ACROSS SURFACES THAT ARE NOT JOINED. Edges alone leave one graph per
// connected surface, and this figure is TWO: the tailcoat and, tucked inside
// its opening as a separate 468-triangle shell, the shirt front. Neither the
// vote below nor the weight smoothing can reach from one to the other, so the
// shirt gets its bones from the slice rules alone and keeps whatever they said
// — including, on the first version of this, a piece of it rigged to an arm,
// which then flew off with the arm as a black shard hanging in the air.
//
// Linking anything within a couple of centimetres of a man's height fixes it
// without touching the real topology: two surfaces that close together are one
// piece of clothing as far as a viewer is concerned, and they should deform as
// one. Hashed into cells rather than compared pairwise — 5,206 vertices is
// 13.5 million pairs and this runs on every build.
const NEAR = H * 0.02;
const cellOf = (i) => `${Math.floor(px(i) / NEAR)},${Math.floor(py(i) / NEAR)},${Math.floor(pz(i) / NEAR)}`;
const grid = new Map();
for (let i = 0; i < N; i++) {
  if (canonical[i] !== i) continue;
  const k = cellOf(i);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(i);
}
let bridged = 0;
for (let i = 0; i < N; i++) {
  if (canonical[i] !== i) continue;
  const cx = Math.floor(px(i) / NEAR);
  const cy = Math.floor(py(i) / NEAR);
  const cz = Math.floor(pz(i) / NEAR);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let oz = -1; oz <= 1; oz++) {
        for (const j of grid.get(`${cx + ox},${cy + oy},${cz + oz}`) ?? []) {
          if (j === i) continue;
          const d = Math.hypot(px(i) - px(j), py(i) - py(j), pz(i) - pz(j));
          if (d > NEAR) continue;
          if (neighbours.get(i)?.has(j)) continue;
          link(i, j); link(j, i);
          bridged++;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cleaning up the part map
// ---------------------------------------------------------------------------

// A MAJORITY VOTE OVER THE MESH. Every rule above works on one horizontal slice
// at a time, and a slice is a bad place to make a decision about a surface: a
// stray vertex whose neighbours are all sleeve but which fell on the wrong side
// of that slice's armpit gap gets rigged to the chest, and then the arm swings
// and it does not. On screen that is a black shard of jacket hanging in the air
// where the cuff used to be — which reads as the model breaking apart, and is
// the single most visible thing that can go wrong here.
//
// No threshold can fix that, because the vertex is genuinely ambiguous by
// position. Its NEIGHBOURS are not: a vertex surrounded by sleeve is sleeve.
// Three passes of "take whichever part most of my neighbours are" absorbs the
// strays without moving any real boundary, because a real boundary has half its
// neighbours on each side and a tie leaves the vertex where it was.
for (let pass = 0; pass < 3; pass++) {
  const next = part.slice();
  for (let i = 0; i < N; i++) {
    const ns = neighbours.get(canonical[i]);
    if (!ns || ns.size < 3) continue;
    const votes = new Map();
    for (const j of ns) votes.set(part[j], (votes.get(part[j]) ?? 0) + 1);
    // The vertex's own vote, worth more than any one neighbour's, so this
    // smooths noise rather than eroding whichever part is smaller.
    votes.set(part[i], (votes.get(part[i]) ?? 0) + 2);
    let bestPart = part[i];
    let bestVotes = 0;
    for (const [name, n] of votes) if (n > bestVotes) { bestVotes = n; bestPart = name; }
    next[i] = bestPart;
  }
  // Split vertices have to agree, or a seam is a boundary the vote can never
  // settle and the strays come straight back.
  for (let i = 0; i < N; i++) next[i] = next[canonical[i]];
  part.splice(0, N, ...next);
}

// Distance from a point to a bone's segment.
function segDist(p, a, b) {
  const abx = b[0] - a[0]; const aby = b[1] - a[1]; const abz = b[2] - a[2];
  const apx = p[0] - a[0]; const apy = p[1] - a[1]; const apz = p[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
}

// One bone per vertex, to start with: the nearest segment inside its own part.
const owner = new Array(N).fill(0);
for (let i = 0; i < N; i++) {
  const p = [px(i), py(i), pz(i)];
  let best = null;
  let bestD = Infinity;
  for (const name of PARTS[part[i]]) {
    const b = BONES[boneIndex.get(name)];
    const [from, to] = b.skin ?? [b.at, b.to];
    const d = segDist(p, joint[from], joint[to]);
    if (d < bestD) { bestD = d; best = boneIndex.get(name); }
  }
  owner[i] = best;
}

// ---------------------------------------------------------------------------
// Softening the seams
// ---------------------------------------------------------------------------


const B = BONES.length;
let W = new Float64Array(N * B);
for (let i = 0; i < N; i++) W[i * B + owner[i]] = 1;

// Each pass replaces a vertex's weights with the average of its own and its
// neighbours'. Six passes spreads a blend about three vertices either side of a
// seam, which on this mesh is roughly the width of a real joint.
const PASSES = 6;
for (let pass = 0; pass < PASSES; pass++) {
  const next = new Float64Array(N * B);
  for (let i = 0; i < N; i++) {
    const c = canonical[i];
    const ns = neighbours.get(c);
    let count = 1;
    for (let k = 0; k < B; k++) next[i * B + k] = W[c * B + k];
    if (ns) {
      for (const j of ns) {
        for (let k = 0; k < B; k++) next[i * B + k] += W[j * B + k];
        count++;
      }
    }
    for (let k = 0; k < B; k++) next[i * B + k] /= count;
  }
  // Split vertices have to agree, or the seam tears open when the arm moves.
  for (let i = 0; i < N; i++) {
    const c = canonical[i];
    if (c === i) continue;
    for (let k = 0; k < B; k++) next[i * B + k] = next[c * B + k];
  }
  W = next;
}

// glTF carries four influences per vertex. Keep the four heaviest, drop the
// noise the smoothing spread into far-away bones, and renormalise.
const joints = new Uint16Array(N * 4);
const weights = new Float32Array(N * 4);
let maxInfluences = 0;
for (let i = 0; i < N; i++) {
  const row = [];
  for (let k = 0; k < B; k++) if (W[i * B + k] > 0.02) row.push([k, W[i * B + k]]);
  row.sort((a, b) => b[1] - a[1]);
  const top = row.slice(0, 4);
  maxInfluences = Math.max(maxInfluences, top.length);
  const total = top.reduce((s, r) => s + r[1], 0) || 1;
  for (let k = 0; k < top.length; k++) {
    joints[i * 4 + k] = top[k][0];
    weights[i * 4 + k] = top[k][1] / total;
  }
}

// ---------------------------------------------------------------------------
// Out
// ---------------------------------------------------------------------------

const { json } = glb;
const out = writeSkinnedGlb({
  positions,
  normals,
  uvs,
  indices,
  joints,
  weights,
  bones,
  images: json.images ?? [],
  imageData: (json.images ?? []).map((img) => imageBytes(glb, img)),
  textures: json.textures ?? [],
  samplers: json.samplers ?? [],
  materials: mesh.material == null ? [] : [json.materials[mesh.material]],
  name: 'guest',
});
writeFileSync(OUT, out);

const counts = new Array(B).fill(0);
for (let i = 0; i < N; i++) counts[owner[i]]++;
console.log(`  GRAPH     ${bridged} proximity links bridging surfaces that share no edge`);
console.log('  VERTICES PER BONE (before smoothing)');
for (let k = 0; k < B; k++) console.log(`    ${BONES[k].name.padEnd(11)} ${counts[k]}`);
console.log(`\n  wrote ${OUT} — ${(out.length / 1024 / 1024).toFixed(2)} MB, `
  + `${B} bones, up to ${maxInfluences} influences per vertex`);
