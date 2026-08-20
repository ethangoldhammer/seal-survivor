import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { hitShapeSpheres, worldToShapeLocal, shapeLocalToWorld } from './hitShape.js';
import { feedback } from './feedback.js';

// ---------------------------------------------------------------------------
// WEAK SPOTS ON A BOSS
//
// One to three of them, lit bright green, sitting ON THE OUTER EDGE of the
// animal's silhouette. Shooting one crits. Feed it enough damage and it
// RUPTURES — a burst of hot jagged ichor, the light goes out, and a few
// seconds later a new one opens somewhere else on the perimeter.
//
// WHY THE PERIMETER AND NOT ANYWHERE ON THE BODY. A mark in the middle of a
// megalodon is a mark you cannot see the shape of: the animal is dark and a
// bright patch surrounded on all sides by flesh reads as a texture on the
// model rather than as a place. On the edge it breaks the silhouette, which is
// the only way a small light stays findable while a boss is turning, and it is
// also how the player sees one on the far flank coming round.
//
// ---------------------------------------------------------------------------
// IT IS PAINTED ON THE SKIN, NOT DRAWN IN FRONT OF IT
//
// The first version was an additive quad at the spot's world position. It lit
// correctly, bloomed correctly, and read as a STICKER — a flat disc hanging in
// the water in front of the animal, because that is exactly what it was. It
// did not wrap the body, it did not shear when the flank turned away, and it
// was never occluded by the parts of the shark in front of it.
//
// So the glow is now a shader on the boss's OWN GEOMETRY. Each spot is a world
// position and a radius in a uniform, and every fragment of the animal's skin
// asks how near it is to each of them — the light is wherever the flesh is
// within reach, which means it curves over the body, foreshortens on a flank
// edge-on to the camera, and disappears round the far side without anything
// here knowing which side that is.
//
// A SHELL, NOT AN INJECTION INTO THE CREATURE'S MATERIAL. Same construction as
// the outline rims in assets.js: a second SkinnedMesh sharing the animal's
// geometry and BOUND TO ITS EXISTING SKELETON, drawn additively over it with
// depth testing on. Three reasons it is not a patch on the body's own shader:
//
//   1. CREATURE MATERIALS ARE SHARED PER ASSET KEY. enemyMegalodon's material
//      is one object behind every clone of it, so writing this boss's spot
//      positions into it would light the CORPSE of the last boss as well — at
//      world coordinates that are on the live one. The orcas dodge that by
//      carrying per-instance materials (they wear a biolumSkin), which is
//      exactly the kind of difference between two bosses that must not decide
//      whether a feature works.
//   2. A PER-INSTANCE MATERIAL WOULD HAVE TO BE CLONED, and Material.clone()
//      drops onBeforeCompile — so the copy loses the noise pattern, the banded
//      lighting and the glow skin the body already wears, while its userData
//      still claims all three are attached.
//   3. Binding to the mesh's EXISTING skeleton is what keeps the cost at one
//      extra draw. A shell with a skeleton of its own would make three compute
//      the bone matrices and upload the bone texture twice a frame.
//
// Depth-tested with the default LEQUAL against identical geometry at identical
// skinning, so the shell passes exactly where the body is visible and fails
// everywhere the animal is in front of itself. The glow spilling past the
// silhouette is the BLOOM doing it, which is the honest way to get a halo:
// bright skin throws light, a quad pretending to be bright skin does not.
// ---------------------------------------------------------------------------
//
// WHAT A SPOT IS ANCHORED TO. A point in the BONE SPACE of one of the hit
// shape's spheres (systems/hitShape.js), the same anchor the impact smears in
// bossImpact.js use. Not a world position, which is off the animal one frame
// later, and not a bone name, which lies. And — the part that matters — the
// crit test and the painted glow read the SAME anchor and the SAME radius, so
// the light and the reach cannot drift apart the way a paired reach in two
// files always eventually does.
//
// WHAT IS GAMEPLAY AND WHAT IS LOOK. The split is the usual one and it is
// enforced by where the number lives:
//
//   behaviour.csv owns  how many, how big, the crit multiplier, how much
//                       damage ruptures one, how long until it relights.
//                       Judged over a fight and against the rest of the
//                       economy, so it belongs in a spreadsheet next to the
//                       other creature throughput.
//   CONFIG.hotSpots     owns the colours, the glow, the pulse, the jag on the
//                       edge, the goo. Judged by eye in the second it happens.
// ---------------------------------------------------------------------------

// How many spots one shader can paint. The loop is unrolled against this, so
// it is a compile-time constant and not a config value — `countMax` is clamped
// to it, loudly, rather than silently dropping the spots past the end.
const MAX_SPOTS = 4;

// ---------------------------------------------------------------------------
// THE GLOW, ON THE SKIN
// ---------------------------------------------------------------------------

const SKIN_PARS = /* glsl */ `
  varying vec3 vHotWorld;
`;

// Injected after <project_vertex>, which is after <skinning_vertex> — so
// `transformed` is the POSED local position and this is where the flesh
// actually is. Reading it before the skinning chunks would measure every
// fragment against the bind pose, which on a swimming shark is most of a body
// length out at the tail and looks like the spot sliding.
const SKIN_VERT = /* glsl */ `
  vHotWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const SKIN_FRAG_PARS = /* glsl */ `
  uniform vec4 uHotSpot[${MAX_SPOTS}];   // xyz world centre, w world radius
  uniform vec4 uHotMood[${MAX_SPOTS}];   // x alive 0..1, y flash, z heat, w seed
  uniform float uHotTime;
  uniform float uHotGlow;
  uniform float uHotJag;
  uniform float uHotJagRate;
  uniform float uHotCore;
  uniform float uHotWhite;
  uniform float uHotFill;
  uniform float uHotRing;
  uniform float uHotRingW;
  uniform float uHotSpill;
  uniform float uHotSpillGain;
  uniform float uHotPulse;
  uniform float uHotPulseDepth;
  uniform float uHotFlashSwell;
  uniform vec3 uHotLit;
  uniform vec3 uHotHot;
  uniform vec3 uHotFlash;

  varying vec3 vHotWorld;

  float hotHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float hotNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hotHash(i), hotHash(i + vec2(1.0, 0.0)), f.x),
               mix(hotHash(i + vec2(0.0, 1.0)), hotHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  vec3 hotSpotLight(vec4 s, vec4 m) {
    if (m.x <= 0.0 || s.w <= 0.0) return vec3(0.0);

    // r = 1.0 IS THE CRIT BOUNDARY. Everything below is built around that one
    // fact: the ring is drawn exactly there, the fill is inside it, the spill
    // is outside it, and nothing moves it.
    float r = distance(vHotWorld, s.xyz) / max(0.05, s.w);
    if (r > 1.0 + uHotSpill * 1.6) return vec3(0.0);

    // BREATHING IS BRIGHTNESS, NOT SIZE. It used to scale the reach, which
    // meant the drawn boundary swung either side of the number the crit test
    // uses several times a second — a small lie, told constantly, about the
    // one thing on a boss the player is aiming at. Pulsing the light says the
    // same "this is alive" and says nothing false.
    float rate = uHotPulse * mix(1.0, 3.2, m.z);
    float breathe = 1.0 + uHotPulseDepth * sin(uHotTime * rate + m.w * 43.0);

    // THE RING. The loudest thing in the effect and the reason the spot reads
    // as a TARGET rather than as a smudge: a hard bright band sitting on the
    // boundary. A soft blob has no edge, so at fight scale — where a boss is a
    // couple of hundred pixels — it is a green smear with no size and no
    // shape, which is what this whole arrangement replaced.
    float ring = smoothstep(uHotRingW, 0.0, abs(r - 1.0));

    // THE FILL, deliberately kept well under the ring. A solid interior at
    // full brightness clips flat once the glow lifts it past 1, and everything
    // that has to be legible INSIDE the spot — the heat shift, the hot core,
    // the hit flash — is then invisible because all of it is over the ceiling.
    float fill = 1.0 - smoothstep(0.72, 1.0, r);
    float core = pow(max(0.0, 1.0 - r), uHotCore);

    // THE SPILL, outside the boundary, and the ONLY part the chewed edge
    // touches. The jag is what stops the spot being a clean vector circle, but
    // a jag applied to the ring would be the boundary lying about reach by
    // whatever the jag amplitude is — so the ring stays true and the gnawing
    // happens in the light beyond it.
    //
    // Sampled in cos/sin rather than on the angle, so it wraps with no seam: a
    // noise field sampled on the angle has a discontinuity at pi that puts a
    // notch in the same place on every spot. The domain radii are the other
    // half of the trick — a unit circle scaled by 2.6 crosses about four cells
    // of a unit lattice, so the "noise" had four-fold symmetry and every spot
    // rendered as the same diamond.
    vec2 rel = vHotWorld.xy - s.xy;
    float ang = atan(rel.y, rel.x);
    vec2 dir = vec2(cos(ang), sin(ang));
    float t = uHotTime * uHotJagRate;
    float n = (hotNoise(dir * 9.0 + vec2(t, m.w * 51.0)) - 0.5)
            + (hotNoise(dir * 19.0 + vec2(-t * 1.7, m.w * 17.0)) - 0.5) * 0.55
            + (hotNoise(dir * 41.0 + vec2(t * 0.6, m.w * 83.0)) - 0.5) * 0.22;
    float reach = 1.0 + uHotSpill * (1.0 + n * uHotJag * mix(1.0, 1.8, m.z));
    float spill = (1.0 - smoothstep(1.0, reach, r)) * step(1.0, r);

    // GREEN -> AMBER as it takes damage, and all the way to white-red on the
    // frame it is struck. Three colours and three mixes, in that order,
    // because each has to win over the last: a nearly-ruptured spot is already
    // warm and a hit on it still has to read as a hit.
    vec3 col = mix(uHotLit, uHotHot, m.z);
    col = mix(col, uHotFlash, m.y);
    col = mix(col, vec3(1.0), core * uHotWhite);

    float shape = fill * uHotFill + ring * uHotRing + spill * uHotSpillGain;
    float lift = 1.0 + m.y * uHotFlashSwell;
    return col * uHotGlow * shape * breathe * lift * m.x;
  }
`;

// Unrolled rather than looped. GLSL ES 1.00 will only take a loop with a
// constant bound anyway, and at four spots the unroll is shorter than the
// guard the loop would need.
const SKIN_FRAG = /* glsl */ `
  {
    vec3 hot = hotSpotLight(uHotSpot[0], uHotMood[0])
             + hotSpotLight(uHotSpot[1], uHotMood[1])
             + hotSpotLight(uHotSpot[2], uHotMood[2])
             + hotSpotLight(uHotSpot[3], uHotMood[3]);
    // NOTHING NEAR A SPOT DRAWS AT ALL. The shell covers the whole animal, so
    // without this every boss pays a full-body additive pass writing black —
    // and on a body already carrying an outline shell that is the third draw
    // of the same geometry.
    if (hot.r + hot.g + hot.b < 0.002) discard;
    gl_FragColor = vec4(hot, 1.0);
  }
`;

// ---------------------------------------------------------------------------

let clock = 0;

// The bodies wearing spots. One entry per boss: its shape, its spots, its
// shells and the one uniform block they share.
const owners = new Map();

const _p = { x: 0, y: 0, z: 0 };
const _col = new THREE.Color();

function cfg() {
  return CONFIG.hotSpots ?? {};
}

function look() {
  return cfg().look ?? {};
}

function freshUniforms() {
  const l = look();
  const spots = [];
  const moods = [];
  for (let i = 0; i < MAX_SPOTS; i++) {
    spots.push(new THREE.Vector4(0, 0, 0, 0));
    moods.push(new THREE.Vector4(0, 0, 0, 0));
  }
  return {
    uHotSpot: { value: spots },
    uHotMood: { value: moods },
    uHotTime: { value: 0 },
    uHotGlow: { value: l.glow ?? 2.6 },
    uHotJag: { value: l.jag ?? 0.34 },
    uHotJagRate: { value: l.jagRate ?? 1.4 },
    uHotCore: { value: l.core ?? 3.2 },
    uHotWhite: { value: l.white ?? 0.85 },
    uHotFill: { value: l.fill ?? 0.55 },
    uHotRing: { value: l.ring ?? 1.7 },
    uHotRingW: { value: l.ringWidth ?? 0.16 },
    uHotSpill: { value: l.spill ?? 0.5 },
    uHotSpillGain: { value: l.spillGain ?? 0.55 },
    uHotPulse: { value: l.pulse ?? 3.4 },
    uHotPulseDepth: { value: l.pulseDepth ?? 0.11 },
    uHotFlashSwell: { value: l.flashSwell ?? 0.35 },
    uHotLit: { value: new THREE.Color(l.litColor ?? 0x4dff7a) },
    uHotHot: { value: new THREE.Color(l.hotColor ?? 0xffc23a) },
    uHotFlash: { value: new THREE.Color(l.flashColor ?? 0xff3a24) },
  };
}

// The shell's material. A MeshBasicMaterial with the fragment replaced rather
// than a ShaderMaterial, for the same reason the outline rims are one: three's
// own vertex path brings skinning, morph targets and instancing with it, and a
// hand-written vertex shader would have to reproduce all three and would go
// silently wrong the first time a boss arrived with a morph on its face.
function makeSkinMaterial(u) {
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    // Depth TESTED, depth WRITE off. Tested is the whole point — the shell is
    // the animal's own geometry at the animal's own skinning, so at the
    // default LEQUAL it passes exactly on the visible surface and fails
    // wherever the body is in front of itself. Writing depth would then block
    // anything drawn behind it later for no gain.
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // FRONT faces. The outline shells are BackSide because they are a rim
    // pushed outward; this is paint on the skin the camera can see.
    side: THREE.FrontSide,
    color: 0x000000,
  });

  // One compiled program for every boss in the game rather than one per
  // material. Same reason biolumSkin pins its key: three keys programs partly
  // by the SOURCE of onBeforeCompile, and a fresh closure per boss would
  // compile a new program on the frame each one arrives — which is the frame
  // that can least afford it.
  mat.customProgramCacheKey = () => 'hotSpotSkin';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SKIN_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${SKIN_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SKIN_FRAG_PARS}`)
      // AFTER <opaque_fragment>, which is where the basic material first
      // assigns gl_FragColor — so this overwrites it and then goes through the
      // same tone-mapping and colour-space chunks as every other surface in
      // the game. Written after <dithering_fragment> instead, the glow would
      // skip both and be the one thing on screen in a different colour space.
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${SKIN_FRAG}`);
  };
  // Findable from the material, the way noiseShader and toonShade keep theirs.
  // An effect whose live numbers cannot be read off the thing drawing it is an
  // effect nobody can debug from a breakpoint.
  mat.userData.__hotUniforms = u;
  mat.needsUpdate = true;
  return mat;
}

// A second draw of the animal, bound to the animal's own skeleton.
//
// SIBLING, NOT CHILD, for a skinned mesh: the skeleton already places those
// vertices in world space, so nesting the shell under the mesh would apply the
// mesh's transform a second time. Copied from addOutlineShells, which learned
// it the same way.
function buildShells(visual, u) {
  const shells = [];
  const targets = [];
  visual.traverse((o) => {
    // Not the outline rims, and not a shell from a previous life of this
    // pooled body — outlining an outline draws a rim inside-out, and painting
    // a shell would paint the paint.
    if (o.isMesh && !o.userData.__isOutline && !o.userData.__isHotSpotShell) targets.push(o);
  });

  for (const mesh of targets) {
    if (!mesh.geometry) continue;
    const mat = makeSkinMaterial(u);
    let shell;
    if (mesh.isSkinnedMesh) {
      shell = new THREE.SkinnedMesh(mesh.geometry, mat);
      shell.bind(mesh.skeleton, mesh.bindMatrix);
      mesh.parent?.add(shell);
    } else {
      shell = new THREE.Mesh(mesh.geometry, mat);
      mesh.add(shell);
    }
    shell.name = `${mesh.name}__hotspots`;
    // AFTER the body, so the paint lands on top of the skin it is painted on.
    // The outline rims go one BEFORE for the opposite reason.
    shell.renderOrder = (mesh.renderOrder ?? 0) + 1;
    shell.userData.__isHotSpotShell = true;
    shell.frustumCulled = false;
    // Hidden until the first update places something. attachHotSpots
    // deliberately places nothing (the body is not posed yet), so a shell
    // visible from birth is one frame of a full-body discard pass for a boss
    // that has no spots on it.
    shell.visible = false;
    shells.push(shell);
  }
  return shells;
}

function dropShells(owner) {
  for (const s of owner.shells ?? []) {
    s.parent?.remove(s);
    // The GEOMETRY is the animal's and is emphatically not ours to dispose —
    // a generic teardown that frees it takes the boss's body with it. Only the
    // material was made here.
    s.material.dispose();
  }
  owner.shells = [];
}

export function initBossHotSpots() {
  resetBossHotSpots();
}

export function disposeBossHotSpots() {
  resetBossHotSpots();
}

export function resetBossHotSpots() {
  for (const owner of owners.values()) dropShells(owner);
  owners.clear();
}

// ---------------------------------------------------------------------------
// WHERE A SPOT GOES
//
// The silhouette is the union of the hit shape's spheres projected into the
// arena plane — z is a drawing lane in this game, not a dimension, so that
// projection is the whole shape. A point is ON THE PERIMETER when it is on
// one sphere's rim and inside no other sphere. That is the entire test, and it
// is why this cannot be done from a bone name: which parts of a shark are on
// its outline depends on how it is bent right now.
// ---------------------------------------------------------------------------

/**
 * Sample candidate points on the outer boundary of a posed body.
 *
 * @param shape   a live hit shape (systems/hitShape.js)
 * @param rays    angular samples per sphere
 * @returns       [{ index, wx, wy, wz, nx, ny, hostR }] in no particular order
 */
export function perimeterCandidates(shape, rays = 24) {
  const spheres = hitShapeSpheres(shape);
  const out = [];
  if (!spheres.length) return out;

  // The same inflation the contacts land on. A spot placed on the raw flesh
  // while every hit reports a point on the padded surface would sit a few
  // percent inside the boundary the player is actually shooting at — small,
  // constant, and exactly the kind of offset nobody finds by looking.
  const pad = CONFIG.hitShape?.padding ?? 1;

  for (let i = 0; i < spheres.length; i++) {
    const s = spheres[i];
    const sr = s.wr * pad;
    if (!(sr > 0)) continue;

    for (let k = 0; k < rays; k++) {
      // Offset per sphere so neighbouring spheres do not sample the same
      // angles — an aligned grid puts candidates in radial lines and the
      // spacing rule below then rejects most of them for being in the same
      // spoke.
      const ang = (k + (i * 0.37)) / rays * Math.PI * 2;
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);
      const wx = s.wx + nx * sr;
      const wy = s.wy + ny * sr;

      let buried = false;
      for (let j = 0; j < spheres.length; j++) {
        if (j === i) continue;
        const o = spheres[j];
        const or = o.wr * pad;
        const dx = wx - o.wx;
        const dy = wy - o.wy;
        // A hair inside, so a point sitting exactly on the seam where two
        // spheres touch is not rejected by both of them and kept by neither.
        if (dx * dx + dy * dy < or * or * 0.9801) { buried = true; break; }
      }
      if (buried) continue;

      // The sphere's centre travels with the candidate: it is the ORIGIN of
      // the ray the mesh is resolved along, and re-deriving it later from the
      // point and the normal would only work while the point is still on the
      // rim — which it stops being the moment it is snapped.
      out.push({ index: i, wx, wy, wz: s.wz, nx, ny, hostR: sr, sx: s.wx, sy: s.wy, sz: s.wz });
    }
  }
  return out;
}

// Pick one candidate, biased toward the big parts of the animal and away from
// the spots already placed.
//
// THE BIAS IS NOT DECORATION. Without it the pick is uniform over candidates,
// and a small sphere on a fin tip contributes as many candidates as the torso
// while being a tenth of the flesh — so most spots would land on extremities,
// which are the parts that move fastest, are thinnest, and are hardest to
// hit. Weighting by the host sphere's radius puts them on the animal.
function pickCandidate(cands, taken, minGap) {
  let total = 0;
  const weights = new Array(cands.length);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    let w = c.hostR;
    for (const t of taken) {
      const dx = c.wx - t.wx;
      const dy = c.wy - t.wy;
      // Not a hard reject: on a small body there may be no candidate far
      // enough from the first spot, and a hard rule there means the second
      // spot silently never appears. Crushed instead, so distance wins
      // wherever distance is available.
      if (dx * dx + dy * dy < minGap * minGap) w *= 0.02;
    }
    weights[i] = w;
    total += w;
  }
  if (total <= 0) return null;

  let roll = Math.random() * total;
  for (let i = 0; i < cands.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

// ---------------------------------------------------------------------------
// ONTO THE FLESH
//
// A candidate is on the rim of a fitted SPHERE, and a sphere is not the animal.
// The fit is mean + 1.6 sigma of the vertex cloud and then inflated by
// `padding`, so its rim runs OUTSIDE the mesh wherever the body is thinner than
// its own statistics — measured on the shipped megalodon, up to 1.18 world
// units out, which is 69% of a spot's radius.
//
// With the old quad that did not matter: it drew wherever it was put. Painting
// the skin, it is the whole thing. The light is only wherever flesh is within
// reach, so a centre floating a unit off the body loses the entire bright
// middle of the patch and the spot renders as a dim smear with its core
// nowhere — and nothing about that is visible from the placement code.
//
// So the picked point is snapped to the nearest actual posed vertex. Once per
// placement (an arrival, a rupture), never per frame.
//
// SAMPLED, NOT EXHAUSTIVE. Every eighth vertex: this is looking for the
// nearest piece of flesh to a point on a body whose vertices are millimetres
// apart, and the eighth-density answer is within a rounding error of the full
// one for an eighth of the work.
// ---------------------------------------------------------------------------

const SKIN_STRIDE = 8;
const _v = new THREE.Vector3();
let skinCloud = new Float32Array(0);
let skinCount = 0;

function sampleSkin(visual) {
  skinCount = 0;
  const out = [];
  visual.updateWorldMatrix(true, true);
  visual.traverse((o) => {
    if (!o.isMesh || o.userData.__isOutline || o.userData.__isHotSpotShell) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i += SKIN_STRIDE) {
      _v.fromBufferAttribute(pos, i);
      // The POSE, via three's own skinning — the same transform the GPU
      // applies. Reading the raw attribute measures the bind pose, which on a
      // swimming shark is most of a body length out at the tail.
      if (o.isSkinnedMesh) o.applyBoneTransform(i, _v);
      o.localToWorld(_v);
      out.push(_v.x, _v.y, _v.z);
    }
  });
  if (skinCloud.length < out.length) skinCloud = new Float32Array(out.length);
  skinCloud.set(out);
  skinCount = out.length / 3;
  return skinCount;
}

// THE OUTERMOST PIECE OF FLESH ALONG THE CANDIDATE'S OWN RAY.
//
// Two wrong versions came before this one and both are worth naming, because
// each looked correct and produced a spot that was simply not on the edge:
//
//   NEAREST VERTEX. The nearest flesh to a rim point that pokes out past the
//   belly is usually on the near FLANK, half a body-thickness inboard. It put
//   spots 0.92 units short of the animal's own outline — on a spot of radius
//   0.8, the glow never reached the silhouette at all.
//
//   OUTERMOST VERTEX WITHIN A RADIUS. Better in principle and worse in fact:
//   the outward direction it maximised along was the SPHERE's normal, which on
//   a small sphere off to one side points nowhere near "out of the animal", so
//   the spot walked several units along the body looking for it.
//
// What is actually wanted is the support point: cast the candidate's ray out
// from its sphere's centre and take the mesh vertex that reaches furthest
// along it, out of those close enough to the ray to be the same piece of body.
// That is the silhouette by definition, and it lands on a real vertex.
//
// The tolerance is a TUBE around the ray, sized off the sphere, and it is the
// one judgement call here: too tight and a body between sampled vertices has
// no support point at all, too loose and the answer drifts sideways onto
// whatever else happens to be pointing outward.
function supportOnSkin(sx, sy, sz, nx, ny, tol) {
  const tol2 = tol * tol;
  let best = -Infinity;
  let bi = -1;
  for (let i = 0; i < skinCount; i++) {
    const dx = skinCloud[i * 3] - sx;
    const dy = skinCloud[i * 3 + 1] - sy;
    const along = dx * nx + dy * ny;
    if (along <= 0 || along < best) continue; // behind the origin, or already beaten
    const px = dx - along * nx;
    const py = dy - along * ny;
    const dz = skinCloud[i * 3 + 2] - sz;
    // The tube is measured in the ARENA PLANE plus depth, because a silhouette
    // in this game is an XY outline and a vertex directly behind another one is
    // a different point on the same edge, not a different edge.
    if (px * px + py * py + dz * dz > tol2) continue;
    best = along;
    bi = i;
  }
  if (bi < 0) return null;
  return { x: skinCloud[bi * 3], y: skinCloud[bi * 3 + 1], z: skinCloud[bi * 3 + 2], along: best };
}

// Resolve a picked candidate onto the mesh. Returns how far it moved, or -1
// when no flesh sits along its ray at all — which is a real answer rather than
// a failure: a fitted sphere claiming body where the mesh has none is exactly
// the place a spot must not go, and one fewer spot beats a crit zone over open
// water.
function snapToSkin(pick, tolFrac) {
  const tol = Math.max(0.15, pick.hostR * tolFrac);
  // Widened once before giving up. At the sampled density a thin fin can have
  // nothing inside a tight tube while being perfectly real flesh, and dropping
  // the spot for that would quietly bias every boss's spots away from its
  // extremities.
  const hit = supportOnSkin(pick.sx, pick.sy, pick.sz, pick.nx, pick.ny, tol)
    ?? supportOnSkin(pick.sx, pick.sy, pick.sz, pick.nx, pick.ny, tol * 2.5);
  if (!hit) return -1;
  const moved = Math.hypot(hit.x - pick.wx, hit.y - pick.wy, hit.z - pick.wz);
  pick.wx = hit.x;
  pick.wy = hit.y;
  pick.wz = hit.z;
  return moved;
}

// ---------------------------------------------------------------------------
// LIGHTING ONE
// ---------------------------------------------------------------------------

// AGAINST THE WHOLE ANIMAL, then capped by the piece of it the spot is sitting
// on. Both halves are load-bearing and the first version had only the second.
//
// Sizing off the host sphere alone reads as the obviously right answer and is
// wrong on every body in the game: a megalodon's twelve fitted spheres are
// about 1.9 units at their biggest against a boss whose overall reach is 5, so
// half of one is a light under a metre across on an animal thirteen metres
// long. Every spot clamped to `minRadius` and the fraction did nothing at all —
// which the harness caught and no amount of looking at the code would have.
//
// The cap is what stops the other failure: a spot that landed on a fin tip
// would otherwise be drawn several times the size of the fin, and a crit reach
// bigger than the flesh it is attached to is reach over open water.
function spotRadius(bodyR, hostR) {
  const c = cfg();
  const r = (bodyR ?? 1) * (c.radiusFrac ?? 0.34);
  const capped = Math.min(r, hostR * (c.hostCap ?? 1.1));
  return Math.max(c.minRadius ?? 0.6, Math.min(c.maxRadius ?? 3.2, capped));
}

function lightSpot(owner, cands) {
  const c = cfg();
  const e = owner.e;
  const taken = owner.spots.filter((s) => s && s.alive && !s.dead);
  // In multiples of the animal's own size, so "not on top of each other" means
  // the same thing on a megalodon and on a crab.
  const pick = pickCandidate(cands, taken, (c.minGapFrac ?? 0.7) * (e.radius ?? 1));
  if (!pick) return null;

  // ONTO THE SKIN. After the pick rather than before it, so the cost is one
  // nearest-vertex search per placement instead of one per candidate — and so
  // the silhouette logic above stays a question about the SHAPE, which is what
  // it is good at, with the mesh only correcting where the answer lands.
  //
  // A candidate with no flesh within reach is dropped rather than used: that
  // is a fitted sphere claiming body where there is none, and a spot there
  // would be a crit zone over open water.
  const moved = snapToSkin(pick, c.snapTube ?? 0.35);
  if (moved < 0) return null;

  // PULLED SLIGHTLY INBOARD OF THE EDGE IT WAS FOUND ON.
  //
  // A centre sitting exactly on the silhouette wastes half its circle over
  // open water: the glow is painted on skin, so only the inboard half is ever
  // drawn, and the boundary ring — the thing that makes the spot read as a
  // target rather than as a bright patch — is off the body for most of its
  // length. Moved in by a fraction of its own radius, the ring lands on flesh
  // nearly all the way round and the spot still reaches the outline, because
  // the inset is smaller than the radius by construction.
  //
  // The crit centre moves with it, which is the right way round: the reach is
  // unchanged and it now covers body rather than water.
  const r0 = spotRadius(e.radius, pick.hostR);
  const inset = r0 * (c.insetFrac ?? 0.4);
  pick.wx -= pick.nx * inset;
  pick.wy -= pick.ny * inset;

  if (!worldToShapeLocal(owner.shape, pick.index, pick.wx, pick.wy, pick.wz, _p)) return null;

  const spot = {
    shape: owner.shape,
    owner,
    index: pick.index,
    lx: _p.x, ly: _p.y, lz: _p.z,
    // Where it is RIGHT NOW as well as where it is anchored. The world pair is
    // rewritten every frame from the anchor, but it has to exist before the
    // first update or the spacing rule above compares against undefined — and
    // NaN fails every distance test silently, so three spots would open on top
    // of each other on the frame a boss arrives and never again.
    wx: pick.wx, wy: pick.wy, wz: pick.wz,
    wnx: pick.nx, wny: pick.ny,
    r: r0,
    // Which way the body faces here, kept in the SPHERE's frame as well, so
    // the goo comes out along the skin's normal even after the animal has
    // turned ninety degrees since the spot was placed.
    nx: pick.nx, ny: pick.ny,
    // How much damage it has swallowed, against the pool that ruptures it.
    taken: 0,
    pool: Math.max(1, (e.maxHp ?? 1) * (c.ruptureFraction ?? 0.06)),
    alive: 1,
    fade: 0,       // eases 0 → 1 as it opens
    flash: 0,
    // Rolled, not derived from a slot index. Slots are reused, and a
    // slot-derived seed gives the replacement spot the same pulse phase and
    // the same chewed edge as the one that just burst in that position.
    seed: Math.random(),
  };

  owner.spots.push(spot);
  return spot;
}

/**
 * Give a boss its weak spots. Called from systems/boss.js the same way the
 * perk, the boat and the kraken's ink are attached.
 *
 * NOTHING IS PLACED HERE, and that is the whole reason this is two steps. The
 * spheres a spot rides are meaningless until the body has been posed and its
 * world matrices are current, and at attach time the creature is still being
 * built — the identical trap that put a shark's hit spheres a hundred units
 * off the animal when the prune ran too early. So this records the intent and
 * the first update that finds a refreshed shape does the placing.
 */
export function attachHotSpots(scene, e) {
  if (!e || !e.isBoss) return null;
  const c = cfg();
  if (c.enabled === false) return null;
  if (!e.hitShape) return null; // no measured body, no silhouette to sit on
  if (!e.visual) return null;   // nothing to paint

  // A body arriving out of the pool may still be wearing the last boss's
  // shells if that boss died on a frame nothing swept. Clearing here as well
  // as on release is cheap and is the difference between a stale glow and a
  // stale glow nobody can explain.
  releaseHotSpots(e);

  const lo = Math.max(0, Math.round(c.countMin ?? 1));
  let hi = Math.max(lo, Math.round(c.countMax ?? 3));
  if (hi > MAX_SPOTS) {
    // Loudly. Silently dropping the spots past the end of the uniform array
    // would present as "the CSV says four and I keep seeing three".
    console.warn(`[hotSpots] countMax ${hi} is above the ${MAX_SPOTS} the shader can paint — clamped.`);
    hi = MAX_SPOTS;
  }
  const want = lo + Math.floor(Math.random() * (hi - lo + 1));
  if (want <= 0) return null;

  const u = freshUniforms();
  const owner = {
    e,
    shape: e.hitShape,
    want,
    spots: [],
    relightIn: 0,
    placed: false,
    visible: false,
    u,
    shells: buildShells(e.visual, u),
  };
  if (!owner.shells.length) {
    // No mesh to paint on. Not an error — a boss could in principle be a
    // primitive — but it is worth saying, because the spots would otherwise
    // crit invisibly and the fight would have a reward nobody can see.
    console.warn('[hotSpots] this boss has no mesh to paint — no weak spots.');
    return null;
  }
  owners.set(e, owner);
  return owner;
}

/** The body is gone (or its shape went back to the pool). Put its lights out. */
export function releaseHotSpots(e) {
  const owner = owners.get(e);
  if (!owner) return;
  for (const s of owner.spots) s.dead = true;
  // THE SHELLS COME OFF WITH THEM. Bodies are pooled: a shell left on the
  // visual rides back into the pool and the next creature built from it draws
  // an extra additive pass of itself for the rest of the run — invisible
  // (every spot is dark) and permanent.
  dropShells(owner);
  owners.delete(e);
}

// ---------------------------------------------------------------------------
// BEING HIT
// ---------------------------------------------------------------------------

/**
 * Did this hit land on a weak spot, and what is the damage worth?
 *
 * Called by the damage sources that AIM — bullets, the club's swing, the
 * strike. Deliberately not by the auras and rings: a weak spot is a reward for
 * putting a shot somewhere, and a field that covers the whole animal cannot
 * put a shot anywhere. An aura that critted would multiply its own tick rate
 * against a target that is standing in it by definition, which is a different
 * (and much larger) change than this one.
 *
 * @param {object} e    the creature that was hit
 * @param {object} at   the contact from systems/hitShape.js — { x, y, index }
 * @param {number} dmg  damage about to be applied
 * @returns {number}    the damage to apply instead. `dmg` unchanged when the
 *                      hit missed every spot, which is every hit on every
 *                      creature in the game that is not a boss.
 */
export function hotSpotDamage(e, at, dmg) {
  if (!at || !(dmg > 0)) return dmg;
  const owner = owners.get(e);
  if (!owner || !owner.placed) return dmg;

  const spot = spotAt(owner, at.x, at.y);
  if (!spot) return dmg;

  const c = cfg();
  const mul = Math.max(1, c.critMul ?? 2.2);
  const out = dmg * mul;

  // THE POOL TAKES THE CRIT DAMAGE, not the raw damage. Two reasons and they
  // point the same way: a spot should burst on the strength of what actually
  // went into it, and pooling the raw number would make the rupture threshold
  // silently mean `ruptureFraction / critMul` of the bar — a second number
  // hidden inside the first, which is exactly the kind of coupling that makes
  // a CSV row stop meaning what it says.
  spot.taken += out;
  spot.flash = 1;

  // A little of it comes out on every hit. Small and thrown along the skin's
  // normal, so a spot you are chewing on visibly leaks before it goes.
  bleed(spot, c, 1);

  if (spot.taken >= spot.pool) rupture(spot, c);
  return out;
}

/** The live spot a point is inside, or null. Exported for the harness. */
export function spotAt(owner, x, y) {
  if (!owner) return null;
  for (const s of owner.spots) {
    if (!s.alive || s.dead) continue;
    const dx = x - s.wx;
    const dy = y - s.wy;
    // THE DRAWN RADIUS, exactly. The glow's boundary and the crit's reach are
    // one number read from one place — the moment they become two numbers in
    // two files, one of them gets retuned and the other does not, and the
    // symptom is a weak spot that stops paying out with nothing in the diff
    // that looks like it could have caused it.
    if (dx * dx + dy * dy <= s.r * s.r) return s;
  }
  return null;
}

/** The owner record for a creature, for the harness and for boss.js. */
export function hotSpotsOf(e) {
  return owners.get(e) ?? null;
}

// A little of it comes out on every crit.
//
// BORN AT THE RIM, NOT AT THE CENTRE, and the offset is the whole difference
// between a spurt and a lid. Fired from the middle of the spot the lobes fuse
// into one disc sitting exactly on top of the light — it covers the white core
// and the hit flash underneath it, so the frame that is supposed to read as a
// hit reads as an orange lozenge appearing. Started a radius out along the
// skin's normal, the same mass is leaving the wound instead of capping it.
function bleed(spot, c, scale) {
  if (c.goo === false) return;
  const out = spot.r * (c.bleedOffset ?? 0.8);
  // THROUGH THE EVENT, not through emit(). Both of these used to fire their
  // emitter directly, which worked and cost the feature everything the shared
  // hook carries: no sound, no shake, no ripple, no haptics, and no row in the
  // Feel Workbench for anybody to tune them from. A burst fired inline is a
  // burst that exists outside the one table the game's feel is edited in.
  feedback('hotSpotHit', {
    x: spot.wx + spot.wnx * out,
    y: spot.wy + spot.wny * out,
    dirX: spot.wnx,
    dirY: spot.wny,
    scale,
  });
}

function rupture(spot, c) {
  spot.alive = 0;
  spot.ruptured = true;

  if (c.goo !== false) {
    // THE BIG ONE. Scaled by multiplying `size` and `speed` together and by
    // the same factor, which is the only lever that makes a fusing mass bigger
    // without changing what it is: blobs twice as big thrown twice as far are
    // the same shape at twice the size. Bigger blobs alone weld into one flat
    // slab; faster ones alone tear into separate dots.
    // Against a stated reference size rather than against the size floor with
    // a fudge factor on top: `ruptureScale` has to mean "1 is the burst as
    // authored", or the CSV row is a number whose neutral value nobody can
    // work out.
    const ref = Math.max(0.2, c.ruptureRefRadius ?? 1.6);
    const g = Math.max(0.3, (c.ruptureScale ?? 1) * (spot.r / ref));
    feedback('hotSpotBurst', {
      x: spot.wx,
      y: spot.wy,
      dirX: spot.wnx,
      dirY: spot.wny,
      sizeMul: g,
      speedMul: g,
      // The shake, the hitstop and the sound all read `scale`, and a bigger
      // spot bursting IS a bigger event — the same factor the burst's size and
      // speed ride on, held under the table's own ceiling.
      scale: Math.min(1.6, g),
    });
  }

  // The replacement is scheduled on the OWNER rather than on the spot, because
  // the spot is about to stop existing and the promise has to outlive it.
  const owner = spot.owner;
  if (owner) owner.relightIn = Math.max(0, c.relightSeconds ?? 4);
}

// ---------------------------------------------------------------------------
// THE FRAME
// ---------------------------------------------------------------------------

/**
 * @param dt      the run's scaled seconds — the pulse and the relight are part
 *                of the fight and should slow down when the fight does.
 * @param realDt  unscaled, for the hit flash. A flash that freezes during its
 *                own hit-stop is the one thing guaranteed to be on screen
 *                while everything else is held, and holding it reads as a
 *                stall — the same call bossImpact.js makes.
 */
export function updateBossHotSpots(dt, realDt = dt) {
  clock += realDt;

  const c = cfg();
  const l = look();
  const openRate = 1 / Math.max(0.02, l.openSeconds ?? 0.45);
  const closeRate = 1 / Math.max(0.02, l.closeSeconds ?? 0.22);
  const flashRate = 1 / Math.max(0.02, l.flashSeconds ?? 0.16);

  for (const [e, owner] of [...owners]) {
    // A boss whose shape went back to the pool takes its spots — and its
    // shells — with it. Same rule the impact smears follow, and for the same
    // reason: a glow with nothing to be a glow ON is a light in open water.
    if (!owner.shape?.alive) { releaseHotSpots(e); continue; }

    // --- what is owed -----------------------------------------------------
    const live = owner.spots.filter((s) => s.alive && !s.dead);
    let owed = owner.want - live.length;
    if (owed > 0) {
      if (!owner.placed) {
        // The opening set. No wait: the arrival is invulnerable anyway, so
        // there is nothing to be gained by holding them back and there is a
        // whole ceremony's worth of screen time to light up during.
        const cands = perimeterCandidates(owner.shape, c.rays ?? 24);
        // The posed vertex cloud, sampled ONCE for however many spots this
        // pass places. Doing it inside lightSpot would re-skin the whole body
        // three times on the frame a boss arrives.
        if (cands.length && sampleSkin(owner.e.visual)) {
          while (owed-- > 0 && lightSpot(owner, cands)) { /* placed */ }
          owner.placed = true;
        }
      } else {
        owner.relightIn -= dt;
        if (owner.relightIn <= 0) {
          const cands = perimeterCandidates(owner.shape, c.rays ?? 24);
          if (cands.length && sampleSkin(owner.e.visual) && lightSpot(owner, cands)) {
            // One at a time. Two ruptures close together should relight on
            // their own clocks rather than both arriving on the frame the
            // second timer expires.
            owner.relightIn = Math.max(0, c.relightSeconds ?? 4);
          }
        }
      }
    }

    // --- the look, re-read every frame ------------------------------------
    // Rather than at build time, so dragging a slider moves the boss that is
    // already in the water instead of only the next one.
    const u = owner.u;
    u.uHotTime.value = clock;
    u.uHotGlow.value = l.glow ?? 2.6;
    u.uHotJag.value = l.jag ?? 0.34;
    u.uHotJagRate.value = l.jagRate ?? 1.4;
    u.uHotCore.value = l.core ?? 3.2;
    u.uHotWhite.value = l.white ?? 0.85;
    u.uHotFill.value = l.fill ?? 0.55;
    u.uHotRing.value = l.ring ?? 1.7;
    u.uHotRingW.value = Math.max(0.01, l.ringWidth ?? 0.16);
    u.uHotSpill.value = Math.max(0.001, l.spill ?? 0.5);
    u.uHotSpillGain.value = l.spillGain ?? 0.55;
    u.uHotPulse.value = l.pulse ?? 3.4;
    u.uHotPulseDepth.value = l.pulseDepth ?? 0.11;
    u.uHotFlashSwell.value = l.flashSwell ?? 0.35;
    _col.set(l.litColor ?? 0x4dff7a); u.uHotLit.value.copy(_col);
    _col.set(l.hotColor ?? 0xffc23a); u.uHotHot.value.copy(_col);
    _col.set(l.flashColor ?? 0xff3a24); u.uHotFlash.value.copy(_col);

    // --- each spot --------------------------------------------------------
    for (let i = owner.spots.length - 1; i >= 0; i--) {
      const s = owner.spots[i];

      if (s.dead) {
        s.fade = Math.max(0, s.fade - closeRate * realDt);
      } else if (s.alive) {
        s.fade = Math.min(1, s.fade + openRate * realDt);
      } else {
        // Ruptured: the light goes out fast, and it goes out WHITE-HOT rather
        // than dimming green, because the burst it just threw is the event and
        // a spot that faded politely would read as having been switched off.
        s.fade = Math.max(0, s.fade - closeRate * realDt);
      }
      if (s.fade <= 0 && (s.dead || !s.alive)) { owner.spots.splice(i, 1); continue; }

      if (!shapeLocalToWorld(s.shape, s.index, s.lx, s.ly, s.lz, _p)) { s.dead = true; continue; }
      s.wx = _p.x;
      s.wy = _p.y;
      // NO LIFT TOWARD THE CAMERA. The old quad needed one to sit off the
      // skin; this IS the skin, and nudging the centre forward would pull the
      // brightest part of the patch off the flesh nearest the camera and onto
      // whatever happened to be a few centimetres in front of it.
      s.wz = _p.z;

      // The normal, carried through the same transform as the point and then
      // differenced, which is how a direction survives a matrix that includes
      // a translation. Cheaper than inverting anything, and right for a scaled
      // body — transforming a direction as if it were a point is the bug whose
      // tell is goo firing toward the world origin.
      if (shapeLocalToWorld(s.shape, s.index, s.lx + s.nx, s.ly + s.ny, s.lz, _p)) {
        const dx = _p.x - s.wx;
        const dy = _p.y - s.wy;
        const len = Math.hypot(dx, dy) || 1;
        s.wnx = dx / len;
        s.wny = dy / len;
      } else {
        s.wnx = s.nx;
        s.wny = s.ny;
      }

      s.flash = Math.max(0, s.flash - flashRate * realDt);
    }

    // --- into the uniforms ------------------------------------------------
    // Rewritten wholesale every frame, including the empty slots. A slot left
    // holding a dead spot's last position keeps painting it, and the shader
    // has no way to know the difference.
    for (let i = 0; i < MAX_SPOTS; i++) {
      const s = i < owner.spots.length ? owner.spots[i] : null;
      const sv = u.uHotSpot.value[i];
      const mv = u.uHotMood.value[i];
      if (!s) { sv.set(0, 0, 0, 0); mv.set(0, 0, 0, 0); continue; }
      sv.set(s.wx, s.wy, s.wz, s.r);
      mv.set(
        s.fade,
        // The rupture reads as one long flash rather than as a fade, which is
        // what makes the burst and the light going out look like one event.
        s.alive ? s.flash : 1,
        s.alive ? Math.min(1, s.taken / Math.max(1, s.pool)) : 1,
        s.seed,
      );
    }

    // NOTHING LIT, NOTHING DRAWN. Between a rupture and its replacement a boss
    // has a spot fewer, and during the whole relight gap it can have none at
    // all — and a shell whose every fragment discards still rasterises the
    // entire animal to find that out. This is the one line that keeps the
    // effect free when it is not happening.
    const anyLit = owner.spots.length > 0;
    if (owner.visible !== anyLit) {
      owner.visible = anyLit;
      for (const sh of owner.shells) sh.visible = anyLit;
    }
  }
}

/** For the harness — how many lights are currently riding a body. */
export function liveHotSpotCount() {
  let n = 0;
  for (const owner of owners.values()) {
    for (const s of owner.spots) if (s.alive && !s.dead) n += 1;
  }
  return n;
}

/** For the harness and the look page — the shells painting one boss. */
export function hotSpotShells(e) {
  return owners.get(e)?.shells ?? [];
}
