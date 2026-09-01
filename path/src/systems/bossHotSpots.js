import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { hitShapeSpheres, worldToShapeLocal, shapeLocalToWorld } from './hitShape.js';
import { feedback } from './feedback.js';
import { advanceCycles, phaseOffset } from './beatSync.js';
import {
  makeOrganicRing, placeOrganicRing, updateOrganicRing, disposeOrganicRing,
} from './organicRing.js';

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
// AND A MARK DRAWN IN FRONT OF IT — the small target rings
//
// Everything above is why the glow reads so well when it reads, and it is also
// exactly why it does not read on every boss: it is ADDITIVE LIGHT ON A HIDE,
// so its legibility is a property of the animal underneath. Unmissable on the
// orca's near-black flank; one bright thing among several on a pale hull, a
// deck full of lights or a crab wearing a lit shell of its own; and correctly
// occluded the moment the body turns it away.
//
// So each spot also gets a RETICLE: the strike mark's own ring (systems/
// organicRing.js) at a fraction of its size, depth-test off, drawn in front of
// the animal. The two halves answer different questions and neither does the
// other's job — the ring says WHERE, from anywhere on screen and on any hide;
// the glow says WHAT, because heat, the throb, the hit flash and the chewed
// edge are all readable only on the light itself.
//
// IT IS THE MARK'S RING ON PURPOSE, IN A SHAPE OF ITS OWN. A bracket cut into
// segments is already the game's word for "this is the thing to hit" — a
// strike paints one on a target — so a smaller one on a weak spot is the same
// sentence about a smaller subject. What separates them is the SHAPE and the
// COLOUR: the mark is four arms on a circle in the strike's amber (or its
// target's status element), and these are six on a loose hexagon wearing the
// spot's own ramp. The hex is not decoration either — the upgrade comb, the
// hive and the level-up cells are all hexes, so a target drawn in that shape
// is speaking a language already on the screen. It all lives in
// CONFIG.hotSpots.look.target.
//
// THE RING IS NOT A PROMISE ABOUT REACH, which is why it is allowed to sit
// OUTSIDE the crit radius (`radiusMul` > 1) where a boss telegraph never could.
// The crit boundary is drawn by the glow's own band, at the radius the crit
// test reads, and the two cannot drift because they are one number. This is a
// label pointing at that boundary from just outside it.
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
//
// WHAT A SPOT PAYS OUT: BIG CHUM, AND IT IS FUEL RATHER THAN FOOD.
//
// Working a weak spot shakes lumps of the animal loose, and swallowing one
// refills BOOST PIPS — the strike meter — not health. That is the whole reason
// the payout is here rather than on the boss: a chunk kicked out on a timer
// (systems/chumChunkSpawner.js) is a break the fight hands you, and this is
// the fight paying for AIM. The two must not be the same currency, or the
// better-aimed fight would simply be the longer-surviving one and the meat
// would read as one pickup that sometimes heals and sometimes does not.
//
// PAID ON DAMAGE, NOT ON HITS. Every source that crits calls hotSpotDamage —
// bullets at ten a second, the club once. Counting hits would make an
// automatic weapon a chum fountain and a slow one pay nothing; counting the
// pool means a piece comes loose for every `chum.damageShare` of the rupture
// pool that goes in, so a spot pays the same whatever is chewing it, and the
// burst throws the rest.
//
// THIS MODULE NEVER SPAWNS ONE. It has no scene and no pickup list, and the
// three call sites that reach hotSpotDamage are deep inside combat, the club
// and the strike. So an ejection is QUEUED with a place and a throw, and
// main.js drains the queue once a frame — see drainHotSpotChum.

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
  // THE PHASE OFFSET IS ITS OWN ARRAY, and it does not share aMood.w with the
  // seed even though both are one float per spot. The seed drives the chewed
  // edge; the phase drives the throb — and at the shipped spread of 0 (every
  // spot in lockstep with the music) a shared slot would hand every spot on
  // every boss in the game the identical gnawed outline.
  uniform float uHotPhase[${MAX_SPOTS}];
  // HOW FAR THROUGH COMING APART each one is: 0 for its whole lit life, then
  // 0 → 1 over closeSeconds from the frame it ruptures. Its own array rather
  // than a fourth slot on aMood, because aMood.w is the seed and the seed is
  // the one value in there that must never change while a spot exists — the
  // chewed edge is a function of it, so borrowing that slot would make the
  // outline crawl as the spot died.
  uniform float uHotBurst[${MAX_SPOTS}];
  uniform float uHotTime;
  uniform float uHotGlow;
  uniform float uHotJag;
  uniform float uHotJagRate;
  uniform float uHotCore;
  uniform float uHotWhite;
  uniform float uHotFill;
  uniform float uHotCharge;
  uniform float uHotChargeEdge;
  uniform float uHotRing;
  uniform float uHotRingW;
  uniform float uHotSpill;
  uniform float uHotSpillGain;
  uniform float uHotBurstReach;
  uniform float uHotBurstW;
  uniform float uHotBurstGain;
  uniform float uHotCycle;
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

  vec3 hotSpotLight(vec4 s, vec4 m, float phase, float burst) {
    if (m.x <= 0.0 || s.w <= 0.0) return vec3(0.0);

    // r = 1.0 IS THE CRIT BOUNDARY. Everything below is built around that one
    // fact: the ring is drawn exactly there, the fill is inside it, the spill
    // is outside it, and nothing moves it.
    float r = distance(vHotWorld, s.xyz) / max(0.05, s.w);
    // The far edge of everything this spot can paint, and it is the SHOCK that
    // decides it — a cutoff sized for the spill alone would clip the burst ring
    // dead at the moment it left the boundary, which reads as the wave hitting
    // a wall the animal does not have.
    float outer = 1.0 + uHotSpill * 1.6 + uHotBurstReach * burst;
    if (r > outer) return vec3(0.0);

    // BREATHING IS BRIGHTNESS, NOT SIZE. It used to scale the reach, which
    // meant the drawn boundary swung either side of the number the crit test
    // uses several times a second — a small lie, told constantly, about the
    // one thing on a boss the player is aiming at. Pulsing the light says the
    // same "this is alive" and says nothing false.
    //
    // ON THE MUSICAL GRID. uHotCycle is a beat-synced counter in [0,1) from
    // systems/beatSync.js, one half bar per cycle by default — so every boss in
    // the water throbs with the track rather than each on its own rad/sec.
    // The phase argument is the per-spot offset, already quantised in JS by
    // beatSync's phaseOffset, so an offset spot still lands ON a beat. It
    // ships at 0 — lockstep — which is the OPPOSITE call from a school of
    // fish, and deliberately: a school spread over a bar reads as a section,
    // while two weak spots on one animal throbbing together read as the boss
    // pulsing with the track, which is the whole point of putting it on the
    // grid at all.
    //
    // HEAT DOUBLES THE RATE BY CROSSFADING TO THE SECOND HARMONIC, which is the
    // one way to speed a throb up without leaving the grid: sin(2t) over the
    // same cycle is the next division down, and it wraps cleanly at the same
    // point (both are whole periods of the counter — see the note on wrap in
    // advanceCycles). Multiplying the rate instead would put a damaged spot at
    // an arbitrary tempo of its own, which is the whole thing this replaced.
    float theta = (uHotCycle + phase) * 6.28318530718;
    float wave = mix(sin(theta), sin(theta * 2.0), m.z);
    float breathe = 1.0 + uHotPulseDepth * wave;

    // THE RING. The loudest thing in the effect and the reason the spot reads
    // as a TARGET rather than as a smudge: a hard bright band sitting on the
    // boundary. A soft blob has no edge, so at fight scale — where a boss is a
    // couple of hundred pixels — it is a green smear with no size and no
    // shape, which is what this whole arrangement replaced.
    float ring = smoothstep(uHotRingW, 0.0, abs(r - 1.0));

    // THE FILL, AND IT IS A LEVEL RATHER THAN A WASH.
    //
    // It used to be a fixed soft interior, which meant the only thing damage
    // moved was the colour and the tempo — both of which are qualities of the
    // light rather than quantities of anything, so "how close is this to
    // going" was a judgement about a shade of amber. Now the lit interior
    // GROWS: a fresh spot is lit out to uHotCharge of its radius and a spent
    // one is lit to the boundary, so the answer is a distance the player can
    // see against a line that is already drawn.
    //
    // NOTHING HERE MOVES THE BOUNDARY. The level rises INSIDE a ring that
    // stays exactly on the crit radius, which is what separates this from
    // pulsing the reach: the thing that grows is not the thing being aimed at,
    // and the moment they meet is the moment the spot bursts.
    float lvl = mix(uHotCharge, 1.0, m.z);
    // The same shoulder the ring is drawn with, on purpose. At full heat the
    // two land on top of each other and have to read as one line rather than
    // as a hard edge arriving beside a soft one.
    float fill = 1.0 - smoothstep(lvl - uHotRingW, lvl, r);
    // ...and the level's own leading edge, so it reads as a surface coming up
    // rather than as a patch getting wider. This is the part that makes a spot
    // at 90% look DIFFERENT from one at 60% in a single frame.
    float front = smoothstep(uHotRingW, 0.0, abs(r - lvl));
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

    // AND THE BURST: one band leaving the wound.
    //
    // Everything else a rupture does happens at the spot's own size — the goo,
    // the meat, the ring thrown outward — and none of it is drawn ON the
    // animal, so the skin's own account of the event was a light going out
    // over a fifth of a second. This is the shock: a hard band that starts on
    // the boundary the player has been chewing at and races out past it,
    // painted on the flesh like everything else here, so the body itself shows
    // the thing that went off inside it.
    //
    // It is NOT faded by hand. m.x — the same fade that takes the light out
    // — multiplies the whole return below, so the wave dying and the spot
    // going dark are one number and cannot drift into a shock still travelling
    // over a spot that has already gone.
    float sr = mix(1.0, outer, burst);
    float shock = smoothstep(uHotBurstW, 0.0, abs(r - sr)) * step(0.0001, burst);

    // GREEN -> AMBER as it takes damage, and all the way to white-red on the
    // frame it is struck. Three colours and three mixes, in that order,
    // because each has to win over the last: a nearly-ruptured spot is already
    // warm and a hit on it still has to read as a hit.
    vec3 col = mix(uHotLit, uHotHot, m.z);
    col = mix(col, uHotFlash, m.y);
    col = mix(col, vec3(1.0), core * uHotWhite);

    // ONLY THE RING AND THE SHOCK MAY CLIP, and that is the whole shape
    // budget in one line. The scene renders to HalfFloat, so a term over 1
    // survives the bright pass — but the composite still lands in 8 bits, and
    // anything past the ceiling there is flat white with no edge and no
    // interior. When the fill and the spill were both over it the spot was one
    // saturated smear the size of the spill's reach, with the boundary band
    // welded into the middle of it: every number in this block was doing
    // something and none of it could be seen. So the interior terms are sized
    // to stay under 1 at the PEAK of the throb (x breathe), and the two that
    // are meant to be lines are left an order of magnitude over it.
    float shape = fill * uHotFill
                + front * uHotChargeEdge
                + ring * uHotRing
                + spill * uHotSpillGain
                + shock * uHotBurstGain;
    float lift = 1.0 + m.y * uHotFlashSwell;
    return col * uHotGlow * shape * breathe * lift * m.x;
  }
`;

// Unrolled rather than looped. GLSL ES 1.00 will only take a loop with a
// constant bound anyway, and at four spots the unroll is shorter than the
// guard the loop would need.
const SKIN_FRAG = /* glsl */ `
  {
    vec3 hot = hotSpotLight(uHotSpot[0], uHotMood[0], uHotPhase[0], uHotBurst[0])
             + hotSpotLight(uHotSpot[1], uHotMood[1], uHotPhase[1], uHotBurst[1])
             + hotSpotLight(uHotSpot[2], uHotMood[2], uHotPhase[2], uHotBurst[2])
             + hotSpotLight(uHotSpot[3], uHotMood[3], uHotPhase[3], uHotBurst[3]);
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

// THE MUSICAL CYCLE, advanced once a frame for every boss in the water rather
// than once per boss. The transport position is the same answer for all of
// them, and two bosses throbbing on their own copies of it is two bosses that
// can drift apart — which is the one thing a beat-locked effect must not do.
//
// Wrapped at 1, which is a whole number of periods for BOTH harmonics the
// shader reads (sin(t) and sin(2t)); a wrap that is not shows up as a visible
// jump every time the counter comes round. See advanceCycles.
let pulseCycle = 0;

// The bodies wearing spots. One entry per boss: its shape, its spots, its
// shells and the one uniform block they share.
const owners = new Map();

// MEAT WAITING TO BE PUT IN THE WATER — see the header note. Each entry is a
// place, a throw and what it is worth in boost pips; main.js drains it once a
// frame. A plain array rather than a callback because the queue is what makes
// the payout testable at all: the harness feeds a spot damage and reads what
// came off it, with no scene, no pickup list and no game loop.
const chumQueue = [];

// AND THE SHOVE A RUPTURE PUTS THROUGH THE ANIMAL, queued for the same reason
// and drained the same way. This module cannot call applyKnockback directly:
// entities/enemies.js owns it, entities/projectiles.js imports THIS file, and
// enemies imports projectiles — so the import would close a cycle through the
// three biggest modules in the game to deliver one impulse a fight. main.js
// already holds both ends, and the queue is what keeps the shove testable
// without a scene: the harness bursts a spot and reads the impulse that came
// off it, exactly as it does for the meat.
const shoveQueue = [];

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
  const phases = new Float32Array(MAX_SPOTS);
  const bursts = new Float32Array(MAX_SPOTS);
  for (let i = 0; i < MAX_SPOTS; i++) {
    spots.push(new THREE.Vector4(0, 0, 0, 0));
    moods.push(new THREE.Vector4(0, 0, 0, 0));
  }
  return {
    uHotSpot: { value: spots },
    uHotMood: { value: moods },
    uHotPhase: { value: phases },
    uHotBurst: { value: bursts },
    uHotTime: { value: 0 },
    uHotGlow: { value: l.glow ?? 2.6 },
    uHotJag: { value: l.jag ?? 0.34 },
    uHotJagRate: { value: l.jagRate ?? 1.4 },
    uHotCore: { value: l.core ?? 3.2 },
    uHotWhite: { value: l.white ?? 0.85 },
    uHotFill: { value: l.fill ?? 0.55 },
    uHotCharge: { value: l.charge ?? 0.34 },
    uHotChargeEdge: { value: l.chargeEdge ?? 0.9 },
    uHotRing: { value: l.ring ?? 1.7 },
    uHotRingW: { value: l.ringWidth ?? 0.16 },
    uHotSpill: { value: l.spill ?? 0.5 },
    uHotSpillGain: { value: l.spillGain ?? 0.55 },
    uHotBurstReach: { value: l.burstReach ?? 0.9 },
    uHotBurstW: { value: l.burstWidth ?? 0.18 },
    uHotBurstGain: { value: l.burstGain ?? 3 },
    uHotCycle: { value: 0 },
    uHotPulseDepth: { value: l.pulseDepth ?? 0.55 },
    uHotFlashSwell: { value: l.flashSwell ?? 0.35 },
    uHotLit: { value: new THREE.Color(l.litColor ?? 0xffffff) },
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

// ---------------------------------------------------------------------------
// THE TARGET RING ON ONE SPOT
// ---------------------------------------------------------------------------

/**
 * Give a spot its reticle, if there is a scene to hang it in.
 *
 * ADDED TO THE SCENE, NOT TO THE ANIMAL. The ring is a readout drawn in world
 * space at the spot's current position, and parenting it under the boss would
 * inherit the body's own scale — every rig in the game carries a different fit
 * multiplier, so an identical `radiusMul` would come out a different size on
 * each boss for reasons nothing here could see.
 *
 * A NULL SCENE IS ORDINARY. tools/boss-hitbox-audit.mjs and anything else
 * measuring placement builds an owner without a world to draw in; a spot with
 * no ring is a spot that simply has no reticle, and every other part of the
 * feature runs unchanged.
 */
function makeSpotRing(owner) {
  const t = look().target ?? {};
  if (t.enabled === false || !owner.scene) return null;
  const ring = makeOrganicRing({
    // A LOOSE HEX IN SIX PIECES. The mark's bracket is four arms on a circle;
    // this is the same family in the shape the rest of the game's UI is cut
    // from, which is what keeps a weak spot from reading as a second lock-on.
    // The two counts move together — see the note in config.
    edge: t.edge ?? 'facet',
    arcs: Math.max(0, Math.round(t.arcs ?? 6)),
    facets: Math.max(3, Math.round(t.facets ?? 6)),
    arcGap: t.arcGap ?? 0.86,
    // Kinetic rather than an element: a weak spot is not a status and not an
    // attack type, and it takes its colour from the spot's own ramp below on
    // the first frame anyway. `edge` above overrides the dialect this would
    // otherwise bring with it.
    type: 'kinetic',
    color: look().litColor ?? 0xffffff,
    // ONE `thickness`, and it was two. The literal carried the key twice —
    // 0.09 up here and 0.17 further down — so the config value every comment
    // in this feature describes as THIN was read through a fallback nobody
    // could see and the ring shipped at nearly double its authored weight.
    // That is the whole reason six segments read as six blobs arranged in a
    // circle: it is the exact failure the config note warns about, arriving
    // through a dead line rather than through a number anybody chose.
    thickness: t.thickness ?? 0.09,
    glow: t.glow ?? 2.6,
    // --- HOW MUCH THE WATER IS ALLOWED TO HAVE BEEN AT IT ------------------
    //
    // Every one of these is the ring shader's own default made explicit,
    // because every one of those defaults was authored for a ring the size of
    // a blast or a strike mark and this is the smallest ring in the game.
    //
    // `noiseScale` is the load-bearing one and it is not an amplitude. The
    // field is sampled in WORLD units — cells per unit — so the grain is a
    // fixed physical size and a small ring covers less of it: at the shipped
    // 0.55, a reticle about three units across spans under two cells, which
    // means the two sides of one hexagon are reading opposite ends of a single
    // lobe. That is not a chewed edge, it is a lopsided ring, and it is why
    // the mark read as distorted rather than as organic. Sampled finer, the
    // perimeter crosses several cells and the wobble goes back to being an
    // edge quality instead of a shape.
    noiseScale: t.noiseScale ?? 2.4,
    // The excursion, as a fraction of the radius. The cap is what binds here
    // rather than the world-unit amplitude — 0.5 world units over a reticle of
    // 1.4 to 5.8 is 0.09 to 0.36, above this at every legal spot size — so
    // this number IS the wobble, at every boss in the game.
    wobbleMax: t.wobble ?? 0.12,
    // How much the band's own weight varies around the ring. The default is a
    // third of the thickness, which sells a goo boundary and eats a thin line:
    // on a band this narrow it is the difference between six segments and six
    // lumps of different sizes.
    massVar: t.massVar ?? 0.14,
    // ...and how ragged the ends of the six segments are. Kept, because a
    // bracket cut clean is a vector shape; kept small, because at this size a
    // torn end is most of a segment.
    arcJitter: t.arcJitter ?? 0.07,
    // Over the strike mark's 9, so a spot inside a marked boss's own reticle
    // draws on top of it rather than fighting it for the same pixels.
    renderOrder: 10,
  });
  owner.scene.add(ring);
  return ring;
}

/** Take one off. Safe on a spot that never had one. */
function dropSpotRing(spot) {
  if (!spot?.ring) return;
  disposeOrganicRing(spot.ring);
  spot.ring = null;
}

/** Every ring an owner is carrying, for release and reset. */
function dropRings(owner) {
  for (const s of owner.spots ?? []) dropSpotRing(s);
}

const _ringCol = new THREE.Color();
const _ringTo = new THREE.Color();
const TAU = Math.PI * 2;

/**
 * One reticle, for one frame.
 *
 * UNSCALED SECONDS, like the hit flash and the fade it rides on. A mark that
 * froze during the hit-stop it was drawing attention to would be the one thing
 * on screen holding still at the exact moment the player is looking at it.
 *
 * THE COLOUR IS THE SPOT'S, RE-DERIVED HERE rather than shared with the
 * shader's uniforms. Those are three separate colours the GLSL mixes per
 * fragment (the fill takes one path, the core another); this is one flat band
 * and it needs the single colour that mix lands on. Same three inputs, same
 * order, so a retune of any of them moves both — and the ring cannot end up
 * red while the light it surrounds is still white.
 */
function driveSpotRing(spot, owner, l, dt) {
  const ring = spot.ring;
  if (!ring) return;
  const t = l.target ?? {};

  // Ruptured or released: the fade is running down and the flash is pinned on,
  // so both halves of the burst read off one number.
  const dying = spot.dead || !spot.alive;
  const heat = spot.alive ? Math.min(1, spot.taken / Math.max(1, spot.pool)) : 1;
  const flash = spot.alive ? spot.flash : 1;
  const grow = dying ? (t.burstGrow ?? 1.1) * (1 - spot.fade) : 0;

  _ringCol.set(owner.tint ?? l.litColor ?? 0xffffff);
  _ringTo.set(l.hotColor ?? 0xffc23a);
  _ringCol.lerp(_ringTo, heat);
  _ringTo.set(l.flashColor ?? 0xff3a24);
  _ringCol.lerp(_ringTo, Math.min(1, flash));

  // THE POP. Out on the frame of the hit and eased back on the flash's own
  // clock, on top of whatever the rupture is doing to the radius — the two
  // never overlap in practice (a spot that has burst takes no more hits) but
  // they are written as one expression so that if they ever did, the burst
  // would carry the pop outward rather than cancelling it.
  const pop = (t.hitPop ?? 0.3) * flash;
  const r = spot.r * (t.radiusMul ?? 1.5) * (1 + grow + pop);
  // Position, scale and the shader's idea of the radius move together — the
  // world-unit wobble is divided by that radius, so setting the scale by hand
  // leaves the edge amplitude computed against last frame's size.
  //
  // AT THE SPOT'S OWN DEPTH. `depthTest` is off so nothing occludes the ring
  // either way, but z is still a perspective distance: pinning every reticle
  // to the arena plane would draw the ones on the near flank of a big animal
  // at the wrong size.
  placeOrganicRing(ring, spot.wx, spot.wy, r, spot.wz);
  ring.rotation.z += (t.spin ?? 0.6) * dt;

  // The sweep on has a clock of its own rather than reading `fade`, so the
  // hand's travel is a fixed length whatever the spot's open time is set to —
  // two numbers that mean different things (how fast the light comes up, how
  // fast the mark is drawn) and would otherwise be one.
  spot.ringOn = Math.min(1, (spot.ringOn ?? 0) + dt / Math.max(0.02, t.sweepIn ?? 0.3));

  // Breathing on the spot's own cycle and its own phase slot, so the ring and
  // the light inside it move together instead of beating against each other.
  const depth = Math.min(1, Math.max(0, t.pulseDepth ?? 0.35));
  // The same quantised offset the shader is handed for this spot, so a boss
  // whose spots are spread over the cycle has its rings spread with them.
  const phase = pulseCycle + phaseOffset(spot.seed, l.pulseSpread ?? 0, l.pulseSteps ?? 2);
  const wave = 0.5 - 0.5 * Math.cos(phase * TAU);

  updateOrganicRing(ring, dt, {
    color: _ringCol,
    // The fade carries the whole arrival and the whole departure; the pulse
    // only rides on top of it.
    opacity: spot.fade * (1 - depth + depth * wave),
    sweepIn: spot.ringOn,
    sweepOut: dying ? 1 - spot.fade : 0,
    // The same fallback makeSpotRing uses. Two different ones is how the band
    // ends up one weight on the frame it is built and another on every frame
    // after it, which reads as the ring settling for no reason.
    thickness: Math.max(0.01, (t.thickness ?? 0.09)
      * (1 + (t.hitSwell ?? 0.55) * flash + (t.burstSwell ?? 1.4) * grow)),
    glow: Math.max(0, (t.glow ?? 2.6) * (1 + (t.hitGlow ?? 2.2) * flash)),
    // The edge, re-sent every frame for the same reason the thickness is: the
    // panel these are tuned from is open while a boss is in the water, and a
    // number that only lands on a ring built after the change is a slider that
    // does nothing until the spot it is describing has burst.
    noiseScale: t.noiseScale ?? 2.4,
    wobbleMax: t.wobble ?? 0.12,
    massVar: t.massVar ?? 0.14,
    arcJitter: t.arcJitter ?? 0.07,
  });
}

export function initBossHotSpots() {
  resetBossHotSpots();
}

export function disposeBossHotSpots() {
  resetBossHotSpots();
}

export function resetBossHotSpots() {
  for (const owner of owners.values()) { dropShells(owner); dropRings(owner); }
  owners.clear();
  // Anything a dying fight shook loose and nobody drained. A queue that
  // survived a reset would put the last boss's meat in the water on the first
  // frame of the next run — and shove the next boss on its arrival frame with
  // an impulse the last one earned.
  chumQueue.length = 0;
  shoveQueue.length = 0;
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
// THE BIAS IS NOT DECORATION, and it needs to be STEEP. Without it the pick is
// uniform over candidates, and a small sphere on a fin tip contributes as many
// candidate angles as the torso while being a tenth of the flesh — so most
// spots land on extremities, which are the parts that move fastest, are
// thinnest and are hardest to hit.
//
// Linear weighting was enough while spots were small and stopped being enough
// the moment they got big: a spot wider than the body part it sits on has its
// boundary ring hanging over open water, where nothing paints it, so the whole
// thing renders as a flat glowing snout instead of as a marked zone with an
// edge. Cubed, the torso wins decisively over the fluke and the ring lands on
// flesh all the way round. The right lever for that is WHERE a spot goes, not
// how big it is — shrinking them to fit a fin tip is fixing the wrong end.
function pickCandidate(cands, taken, minGap, bias = 1, minHostR = 0) {
  let total = 0;
  const weights = new Array(cands.length);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    let w = Math.pow(c.hostR, bias);
    // A HOST TOO SMALL TO CARRY THE SPOT. `minRadius` is a floor applied after
    // `hostCap`, so on a small body part it wins and the spot comes out bigger
    // than the thing it is sitting on — which is the same failure the bias
    // above exists to avoid, arriving by a different route. Measured on the
    // megalodon, those are exactly the spots that sit furthest inside the
    // outline (70% of a radius, against 33% for one on a host that fits) and
    // the ones whose boundary ring falls in open water.
    //
    // Crushed rather than rejected, like the spacing rule: on a small enough
    // animal there may be no host that fits, and a hard filter there means the
    // spots silently never appear.
    if (c.hostR < minHostR) w *= 0.02;
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
function snapToSkin(pick, tolFrac, spotR) {
  // THE TUBE IS CAPPED AGAINST THE SPOT, not only scaled off the host.
  //
  // As a pure fraction of the host sphere it is fine on a fitted bone sphere
  // and absurd on a whole-body stand-in: the boat's circle is 4.2 units, so a
  // 0.35 tube is 1.5 wide and the fallback widens it to 3.7 — wide enough for
  // the support search to land the painted point several units to the SIDE of
  // the ray it was cast along. The collision anchor stays on the ray, so the
  // two drift apart in ANGLE, and a shot at the glow then writes its contact
  // somewhere else on the hull entirely. Measured on the boat: 223% of a
  // radius away, i.e. a dead-centre shot that does not crit.
  //
  // Bounding it by the spot's own size keeps the two anchors describing the
  // same place, which is the only reason either of them exists.
  const tol = Math.min(
    Math.max(0.15, pick.hostR * tolFrac),
    Math.max(0.2, spotR * 0.6),
  );
  // Widened once before giving up. At the sampled density a thin fin can have
  // nothing inside a tight tube while being perfectly real flesh, and dropping
  // the spot for that would quietly bias every boss's spots away from its
  // extremities.
  const hit = supportOnSkin(pick.sx, pick.sy, pick.sz, pick.nx, pick.ny, tol)
    ?? supportOnSkin(pick.sx, pick.sy, pick.sz, pick.nx, pick.ny, tol * 1.8);
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

// Try until one sticks. A single pick that fails its hull-match test is not a
// reason to leave the boss a spot short — it is a reason to look somewhere
// else on the animal, which is what the weighted roll is for.
function lightSpot(owner, cands, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const spot = tryLightSpot(owner, cands);
    if (spot) return spot;
  }
  return null;
}

function tryLightSpot(owner, cands) {
  const c = cfg();
  const e = owner.e;
  const taken = owner.spots.filter((s) => s && s.alive && !s.dead);
  // In multiples of the animal's own size, so "not on top of each other" means
  // the same thing on a megalodon and on a crab.
  const pick = pickCandidate(cands, taken, (c.minGapFrac ?? 0.7) * (e.radius ?? 1),
    c.hostBias ?? 3,
    // The smallest host that can carry a spot without the floor overriding the
    // cap — i.e. the host at which the two agree.
    (c.minRadius ?? 0.6) / Math.max(0.05, c.hostCap ?? 0.8));
  if (!pick) return null;

  // WHERE THE CANDIDATE SAT ON THE COLLISION HULL, taken before the snap moves
  // it onto the flesh. This is the point every contact in the game is written
  // against, and it is the one the crit reach is anchored to below.
  const hullX = pick.wx;
  const hullY = pick.wy;
  const hullZ = pick.wz;

  // ONTO THE SKIN. After the pick rather than before it, so the cost is one
  // nearest-vertex search per placement instead of one per candidate — and so
  // the silhouette logic above stays a question about the SHAPE, which is what
  // it is good at, with the mesh only correcting where the answer lands.
  //
  // A candidate with no flesh within reach is dropped rather than used: that
  // is a fitted sphere claiming body where there is none, and a spot there
  // would be a crit zone over open water.
  const r0 = spotRadius(e.radius, pick.hostR);
  const moved = snapToSkin(pick, c.snapTube ?? 0.35, r0);
  if (moved < 0) return null;

  // ONLY WHERE THE HULL AND THE SKIN AGREE, and this is the invariant the
  // whole feature rests on rather than a tidiness rule.
  //
  // The glow is painted on the flesh and every shot is resolved against the
  // INFLATED collision hull, so a bullet aimed at a spot registers its hit
  // wherever the hull stopped it — which on a body the hull fits badly is
  // nowhere near the light. Measured with tools/boss-hitbox-audit.mjs, a
  // dead-centre shot paid out on 25% of tries at the squid (hull covers 64% of
  // its flesh) and 42% at the yacht (five spheres over a long flat hull),
  // against 100% at the orca. No amount of anchoring fixes that: the two
  // surfaces are genuinely in different places there.
  //
  // What CAN be fixed is where the light goes. `moved` is exactly how far apart
  // the two surfaces were at this candidate, so refusing the ones where they
  // disagree puts every spot somewhere the player's aim and the game's answer
  // are the same place. On a boss whose hull fits badly that means fewer
  // eligible places, not a broken spot — which is the right trade, because a
  // weak spot that does not pay out is worse than one somewhere else.
  if (moved > r0 * (c.hullMatch ?? 0.6)) return null;

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
  const inset = r0 * (c.insetFrac ?? 0.4);
  pick.wx -= pick.nx * inset;
  pick.wy -= pick.ny * inset;

  if (!worldToShapeLocal(owner.shape, pick.index, pick.wx, pick.wy, pick.wz, _p)) return null;

  // THE COLLISION-SPACE ANCHOR, kept beside the mesh one.
  //
  // These are the same place on two different surfaces, and they have to be
  // both. Every hit in the game reports its contact point on the PADDED SPHERE
  // (hitShapeTest writes `centre + normal * wr * padding`), never on the mesh —
  // so a crit test that measured from the painted centre would be comparing a
  // point on the collision hull against a point on the skin. Measured by
  // tools/boss-hitbox-audit.mjs those surfaces stand apart by 0.09 to 0.61
  // units on the median boss and up to 2.20 at worst, against a spot radius
  // around 1.4: on the hammerhead a dead-centre shot would land at 40% of the
  // reach before it had missed by anything, and the worst case exceeds the spot
  // entirely. The glow would be telling the truth about where to aim and the
  // crit would be judged from somewhere else.
  //
  // So the light is anchored on the skin and the reach is anchored on the hull,
  // both in the SAME sphere's bone space, both riding the same matrix, and both
  // still sized by the one radius. That is what "the glowing area is mirrored
  // in the collision shape" has to mean when the two surfaces are not the same
  // surface.
  const collide = { x: 0, y: 0, z: 0 };
  if (!worldToShapeLocal(owner.shape, pick.index, hullX, hullY, hullZ, collide)) return null;

  const spot = {
    shape: owner.shape,
    owner,
    index: pick.index,
    lx: _p.x, ly: _p.y, lz: _p.z,
    cx: collide.x, cy: collide.y, cz: collide.z,
    // Where it is RIGHT NOW as well as where it is anchored. The world pair is
    // rewritten every frame from the anchor, but it has to exist before the
    // first update or the spacing rule above compares against undefined — and
    // NaN fails every distance test silently, so three spots would open on top
    // of each other on the frame a boss arrives and never again.
    wx: pick.wx, wy: pick.wy, wz: pick.wz,
    cwx: hullX, cwy: hullY,
    wnx: pick.nx, wny: pick.ny,
    r: r0,
    // Which way the body faces here, kept in the SPHERE's frame as well, so
    // the goo comes out along the skin's normal even after the animal has
    // turned ninety degrees since the spot was placed.
    nx: pick.nx, ny: pick.ny,
    // How much damage it has swallowed, against the pool that ruptures it.
    taken: 0,
    pool: Math.max(1, (e.maxHp ?? 1) * (c.ruptureFraction ?? 0.06)),
    // ...and how much of that has already been paid out as meat. Tracked as a
    // WATERMARK rather than as a countdown so the payout is a function of the
    // damage in the spot: whatever `chum.damageShare` is when a hit lands, the
    // pieces owed are (taken - paid) / share, and a mid-fight retune cannot
    // leave a spot owing a piece it already threw.
    paid: 0,
    alive: 1,
    fade: 0,       // eases 0 → 1 as it opens
    flash: 0,
    // Rolled, not derived from a slot index. Slots are reused, and a
    // slot-derived seed gives the replacement spot the same pulse phase and
    // the same chewed edge as the one that just burst in that position.
    seed: Math.random(),
    // The reticle in front of the animal. Placed on the first frame like
    // everything else here — see makeSpotRing.
    ring: null,
  };
  spot.ring = makeSpotRing(owner);

  owner.spots.push(spot);
  return spot;
}

// A STAND-IN SHAPE FOR A BOSS THAT COLLIDES AS A CIRCLE.
//
// `hitShape` is opt-in per creature and two bosses deliberately decline it: the
// crab, and the boat — whose def says in as many words that a circle you can
// see the edges of is the fairer target for a fight that is mostly about where
// you are standing. That is a design call about COLLISION and this feature has
// no business reversing it. But "every boss has a weak spot" and "every boss
// has a fitted hitbox" are different requirements, and only the second one is
// contentious.
//
// So a boss with no measured shape gets a synthetic one — a single sphere on
// its own circle, which is exactly the shape it already collides as. Everything
// downstream runs unchanged: hitShape.js's rigid branch refreshes any sphere
// whose `bone` is null straight off its object's world matrix, so the anchors,
// the snap to real vertices and the two-surface split all work with no second
// code path to keep in step.
//
// Centred on `e.mesh` rather than on the visual, and radius divided by the
// padding, so the sphere lands EXACTLY where hitCreature's circle fallback
// writes its contacts — `e.mesh.position + normal * e.radius`, with no
// padding applied. A stand-in that sat anywhere else would put the collision
// anchor somewhere no contact is ever reported.
function synthShape(e) {
  const pad = CONFIG.hitShape?.padding ?? 1;
  const sphere = {
    mesh: e.mesh,
    bone: null,
    pre: null,
    cx: 0, cy: 0, cz: 0,
    r: Math.max(0.1, (e.radius ?? 1) / Math.max(0.01, pad)),
    wx: 0, wy: 0, wz: 0, wr: 0,
    m: new THREE.Matrix4(),
  };
  return {
    key: `${e.assetKey ?? e.def?.asset ?? 'boss'}__hotSpotStandIn`,
    visual: e.visual,
    spheres: [sphere],
    bound: 0,
    stamp: -1,
    alive: true,
    recipe: null,
    // Not a hitbox. Nothing may test collisions against this, and the flag is
    // what lets the update tell a stand-in whose owner has left the world from
    // a real shape that was released back to the pool.
    synthetic: true,
  };
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
  if (!e.visual) return null;   // nothing to paint
  // A measured body where there is one, and its own collision circle where
  // there is not — see synthShape. EVERY boss gets spots; none of them has to
  // change how it collides to earn them.
  const shape = e.hitShape ?? synthShape(e);

  // A body arriving out of the pool may still be wearing the last boss's
  // shells if that boss died on a frame nothing swept. Clearing here as well
  // as on release is cheap and is the difference between a stale glow and a
  // stale glow nobody can explain.
  releaseHotSpots(e);

  // AT LEAST ONE, ALWAYS. The floor is here and not only in the CSV's `min`
  // column because a boss with no weak spot is a boss missing a mechanic the
  // player has been taught to look for on every other one — and a zero rolled
  // out of a spreadsheet is indistinguishable, in the water, from the feature
  // being broken.
  const lo = Math.max(1, Math.round(c.countMin ?? 1));
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
    shape,
    // WHERE THE RETICLES GO. The one thing this module has ever needed the
    // scene for — the glow is painted on the animal's own meshes and the meat
    // is queued for main.js to spawn, so `scene` was an unused argument until
    // the target rings arrived. Kept nullable: a harness that measures
    // placement has no world to draw in, and gets spots with no rings.
    scene: scene ?? null,
    want,
    spots: [],
    relightIn: 0,
    placed: false,
    visible: false,
    // THE OVERRIDE SLOTS. Null and 1 mean "wear what CONFIG says", which is
    // what every boss does until something decides otherwise — see
    // setHotSpotLook.
    tint: null,
    gain: 1,
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
  // AND SO DO THE RETICLES. Nothing ticks these spots after the owner is
  // dropped below, so a ring left in the scene is a bracket hanging in open
  // water where a boss used to be, for the rest of the run.
  dropRings(owner);
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
 * WHETHER A HIT WOULD CRIT, asked without dealing any damage.
 *
 * The caller that needs this is the strike (systems/strike.js): a dash deals
 * nothing to ordinary flesh and its full bite to a weak spot, so "is there a
 * spot under this contact" has to be answerable one line BEFORE the damage
 * exists. Everything else asks the question and pays for it in the same call.
 *
 * hotSpotDamage is built on this rather than beside it, and that is the whole
 * point of it being a function. Two copies of "which spot is under this
 * contact" — one deciding what a strike commits to, one deciding whether it
 * crits — is the failure that has already happened once in this codebase with
 * the crab's claw: a reach retuned at one end, both ends still passing their
 * own tests, and a weapon that silently stopped connecting. One reach, asked
 * twice.
 *
 * @returns the spot, or null for every creature in the game that is not a boss
 *          wearing a lit one.
 */
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
export function hotSpotUnder(e, at, where = null) {
  if (!at) return null;
  const owner = owners.get(e);
  if (!owner || !owner.placed) return null;

  // `where` is the caller's own position for the thing that did the damage,
  // when it has one. It is NOT better than the contact and must not be treated
  // as if it were: a bullet stops the moment it enters the collision hull, so
  // its position is a point on the hull too, just a slightly different one.
  // Both are tested the same way, against the hull anchor. The argument stays
  // because a swept weapon's own position is the more stable of the two when
  // the contact gets attributed to a neighbouring sphere.
  const probe = where ?? at;
  return spotAt(owner, probe.x, probe.y);
}

export function hotSpotDamage(e, at, dmg, where = null) {
  if (!at || !(dmg > 0)) return dmg;
  const spot = hotSpotUnder(e, at, where);
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

  // HOW CLOSE IT NOW IS TO GOING, read AFTER the damage lands so the hit that
  // pushes a spot over the line is the one that sounds like it.
  const heat = Math.min(1, spot.taken / Math.max(1, spot.pool));

  // A little of it comes out on every hit, and MORE of it the closer the spot
  // is to bursting. This is the same warning the colour shift and the doubling
  // throb give, in the two channels a player who is looking somewhere else
  // still gets: the leak grows and the hit gets louder. Without it every crit
  // on a spot sounds and looks identical from the first to the last, and the
  // rupture arrives with no run-up.
  const ramp = (c.rampMin ?? 0.45) + heat * ((c.rampMax ?? 1.9) - (c.rampMin ?? 0.45));
  bleed(spot, c, ramp);

  // WHAT THE HITS SHOOK LOOSE. Before the rupture test on purpose: a spot that
  // bursts on this hit has already paid for the damage that filled it, and the
  // burst's own pieces are thrown on top of those rather than instead of them.
  ejectChum(spot, c);

  if (spot.taken >= spot.pool) rupture(spot, c);
  return out;
}

// ---------------------------------------------------------------------------
// THE MEAT
// ---------------------------------------------------------------------------

/**
 * Queue one piece, born at the rim and thrown out along the skin's normal.
 *
 * OUT ALONG THE NORMAL, not in a random direction like the boss's timed chunk:
 * that one is thrown off a body the player is nowhere near and a full circle is
 * the only fair spread, while this leaves a spot the player is aiming at and
 * has to come TOWARD them or the reward for hitting the far flank is a piece of
 * meat behind the animal. The spread is small for the same reason.
 */
function queueChum(spot, c, pips) {
  const m = c.chum ?? {};
  const out = spot.r * (m.bornAt ?? 1);
  const spread = (Math.random() * 2 - 1) * (m.spread ?? 0.4);
  const cos = Math.cos(spread);
  const sin = Math.sin(spread);
  const dx = spot.wnx * cos - spot.wny * sin;
  const dy = spot.wnx * sin + spot.wny * cos;
  const speed = m.tossSpeed ?? 12;
  chumQueue.push({
    x: spot.wx + spot.wnx * out,
    y: spot.wy + spot.wny * out,
    vx: dx * speed,
    vy: dy * speed,
    pips: Math.max(0, pips),
  });
}

/**
 * The pieces the damage in a spot has bought, paid out in whole shares.
 *
 * A LOOP RATHER THAN A SINGLE PIECE, because one hit can be worth several
 * shares — a strike off a deep chain lands for a large fraction of the pool at
 * once, and paying one piece for it would make the biggest hit in the game the
 * worst-rewarded per point of damage.
 */
function ejectChum(spot, c) {
  const m = c.chum ?? {};
  if (m.enabled === false) return;
  const share = Math.max(0.02, m.damageShare ?? 0.34) * spot.pool;
  const pips = Math.max(0, m.pips ?? 2);
  if (!(pips > 0)) return;
  // The guard is a per-CALL ceiling, not a cap on what a spot pays: what is
  // still owed stays owed and comes out on the next hit. One frame handing out
  // forty pieces is the only failure mode here worth spending a branch on, and
  // it would take a hit worth thirteen times the whole pool to reach it.
  let guard = 8;
  while (spot.taken - spot.paid >= share && guard-- > 0) {
    spot.paid += share;
    queueChum(spot, c, pips);
  }
}

/**
 * The shoves a rupture owes, taken the same way as the meat. Each entry is
 * `{ e, x, y, dirX, dirY, strength }` — where the burst was, which way it is
 * pushing, and how hard as a multiple of a full-charge ram.
 */
export function drainHotSpotShoves() {
  if (!shoveQueue.length) return [];
  return shoveQueue.splice(0, shoveQueue.length);
}

/**
 * Take everything queued since the last call. Returns a NEW array each time —
 * the caller spawns into a scene while this module keeps running, and handing
 * out the live queue would have a spawn that queued more (it cannot today, but
 * nothing here can promise that forever) mutating the list being walked.
 */
export function drainHotSpotChum() {
  if (!chumQueue.length) return [];
  return chumQueue.splice(0, chumQueue.length);
}

/** The live spot a point is inside, or null. Exported for the harness. */
export function spotAt(owner, x, y) {
  if (!owner) return null;
  for (const s of owner.spots) {
    if (!s.alive || s.dead) continue;
    // AGAINST THE HULL ANCHOR, because that is the surface the question is
    // asked on.
    //
    // Four versions of this were wrong before this one, and the reason each
    // failed is the same fact seen from a different side: shots are resolved
    // against the INFLATED collision hull, never against the flesh. A bullet
    // stops when it enters the hull; the contact is written on the hull; so
    // both of the things a caller can hand this function live on the hull.
    // Testing either against a point on the SKIN asks where the shot was on a
    // surface the shot never reached — which is why measuring the painted
    // centre paid out on 25% of dead-centre shots at the squid.
    //
    // So the reach is anchored on the hull, and `hullMatch` in lightSpot is
    // what keeps the painted light within a fraction of a radius of it. The
    // glow and the crit zone are then the same zone because the placement
    // refused every position where they would not have been.
    const dx = x - (s.cwx ?? s.wx);
    const dy = y - (s.cwy ?? s.wy);
    if (dx * dx + dy * dy <= s.r * s.r) return s;
  }
  return null;
}

/** The owner record for a creature, for the harness and for boss.js. */
export function hotSpotsOf(e) {
  return owners.get(e) ?? null;
}

/**
 * Every spot currently LIT on one creature, newest placement last.
 *
 * A live spot and a placed one are not the same thing: a ruptured spot is still
 * in `owner.spots` while its relight timer runs, dark, with no crit zone. Both
 * halves of the filter are load-bearing, and the caller that needs them is the
 * first-run tip about weak spots — a label standing on a hole that has already
 * burst would be pointing at unlit flesh.
 *
 * An empty array for every creature in the game that is not a boss, and for a
 * boss whose opening set has not been placed yet.
 */
export function liveHotSpots(e) {
  const owner = owners.get(e);
  if (!owner || !owner.placed) return [];
  return owner.spots.filter((s) => s.alive && !s.dead);
}

/**
 * Is that exact spot still lit? The tip's cue that its subject is gone, and the
 * per-frame check a seeker holding one makes (entities/projectiles.js).
 *
 * Written out rather than as `liveHotSpots(e).indexOf(spot) !== -1`, which is
 * what it used to be and is the same answer: that version allocates a filtered
 * array, and the seeker asks this once per guided shot in the air per frame.
 */
export function hotSpotLit(e, spot) {
  if (!spot || !spot.alive || spot.dead) return false;
  const owner = owners.get(e);
  return !!owner && owner.placed && owner.spots.indexOf(spot) !== -1;
}

/**
 * The lit spots on one creature that a shot at (x, y) can actually SEE, filled
 * into a caller-supplied array and returned.
 *
 * "Can see" is the spot's own outward normal against the direction back to the
 * shot, and it is the whole difference between this being useful and being a
 * trap. A weak spot is on the perimeter by construction, so half of them at any
 * moment are on the far flank — behind the animal. Steering at one of those
 * throws the shot at the near side of the collision hull, where it lands an
 * ordinary hit, which is strictly worse than the body shot it gave up. `minCos`
 * is how squarely it has to be pointing back: 0 is edge-on (the shot arrives
 * along the skin and grazes), so callers pass a small positive number.
 *
 * OUT-PARAM, and the reason is the caller: this is asked once per guided shot
 * in the air per frame while a boss is up. `liveHotSpots` allocates and is the
 * right shape for the tip and the harness, which ask once.
 *
 * Empty for every creature in the game that is not a boss wearing a lit one.
 */
export function facingHotSpots(e, x, y, minCos = 0, out = []) {
  out.length = 0;
  const owner = owners.get(e);
  if (!owner || !owner.placed) return out;
  for (const s of owner.spots) {
    if (!s.alive || s.dead) continue;
    // AGAINST THE HULL ANCHOR, the same surface spotAt() asks on and the same
    // one the shot will be resolved against — see the note there. Aiming at
    // the painted centre would aim at a point on the flesh the bullet never
    // reaches, which is the four-wrong-versions bug seen from the other end.
    const sx = s.cwx ?? s.wx;
    const sy = s.cwy ?? s.wy;
    const dx = x - sx;
    const dy = y - sy;
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) { out.push(s); continue; }
    if ((dx * s.wnx + dy * s.wny) / d < minCos) continue;
    out.push(s);
  }
  return out;
}

/**
 * Where a spot is, in world units — THE HULL ANCHOR, which is the surface every
 * shot is resolved against.
 *
 * Exported so nothing outside this file has to decide between `cwx` and `wx`.
 * They are two different points on purpose (the crit zone sits on the collision
 * hull, the painted light is snapped onto the flesh), and the four wrong
 * versions of spotAt() are all the story anybody needs about picking the other
 * one — see the note there.
 */
export function hotSpotPoint(spot, out = null) {
  if (!spot) return null;
  // The out-param exists for the seeker, which reads the point it is steering
  // at every frame for every guided shot in the air — see facingHotSpots.
  const o = out ?? { x: 0, y: 0, r: 0 };
  o.x = spot.cwx ?? spot.wx;
  o.y = spot.cwy ?? spot.wy;
  o.r = spot.r;
  return o;
}

/**
 * Override one boss's weak-spot look.
 *
 * THE COLOUR AND THE BRIGHTNESS ARE DELIBERATELY EXPOSED, and the default is
 * deliberately WHITE — a neutral that reads on every hide in the game and that
 * anything tinting it lands on cleanly. Green was the first answer and it was
 * a decision made in the wrong place: it committed every boss in the game to
 * one palette from inside the effect, where nothing that knows anything about
 * the fight can reach it.
 *
 * What might drive it, none of which this module should decide:
 *   the boss's PERK    `bossSparkColor(perk)` in systems/bossLook.js already
 *                      resolves a perk to its attack colour out of the one
 *                      threat palette, so an electric boss's spots could match
 *                      its aura without either end learning about the other.
 *   the run's ELEMENT  `elementColor` in systems/elements.js.
 *   the ARCHETYPE      a column in bossLooks.csv, the way the hide is painted.
 *
 * Per boss rather than global, because "which boss is this" is the question
 * every one of those is answering.
 *
 * @param e     the creature
 * @param opts  { color, brightness } — color REPLACES CONFIG's `litColor`,
 *              brightness MULTIPLIES CONFIG's `glow`. Pass null, or omit a
 *              field, to hand that half back to the config.
 */
export function setHotSpotLook(e, opts = null) {
  const owner = owners.get(e);
  if (!owner) return false;
  owner.tint = opts?.color ?? null;
  owner.gain = opts?.brightness ?? 1;
  return true;
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
  // `scale` reaches the burst's COUNT, the shake, the glow, the ripple and the
  // sound's gain through one field — which is exactly why the ramp is passed
  // here rather than applied to the emitter alone. The whole feedback event
  // gets louder as the spot gets closer to going.
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

  // THE BODY TAKES IT. Out along the skin's normal at the spot, so the
  // direction is the wound pointing outward — a spot opened on the near flank
  // shoves the animal away from the player, one on the far side pulls it
  // across, and either way the burst is something that happened INSIDE the
  // boss rather than a light going out on it. See CONFIG.hotSpots.burstKnock,
  // and the queue's note for why this is not a call.
  const bk = c.burstKnock ?? {};
  if (bk.enabled !== false && spot.owner?.e) {
    shoveQueue.push({
      e: spot.owner.e,
      // WHERE IT WENT OFF, carried alongside the direction. Nothing needs it
      // to apply the impulse — the shove is linear on a boss — but a caller
      // that hands this to a rigid body, or to a bone spring, needs the point
      // and not just the angle, and a queue entry that only had the angle
      // would be one somebody has to widen at exactly the wrong moment.
      x: spot.wx,
      y: spot.wy,
      dirX: spot.wnx,
      dirY: spot.wny,
      strength: Math.max(0, bk.strength ?? 1.6),
    });
  }

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

  // AND THE REST OF THE ANIMAL COMES OUT WITH IT. The burst is the moment the
  // spot is worth the most, so it throws its own pieces rather than only the
  // ones the damage bought on the way in — see the header note.
  const m = c.chum ?? {};
  if (m.enabled !== false) {
    const pips = Math.max(0, m.rupturePips ?? m.pips ?? 2);
    const count = Math.max(0, Math.round(m.ruptureCount ?? 2));
    for (let i = 0; i < count; i++) queueChum(spot, c, pips);
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

  // Raw-ish time, like every other beat-synced shader in the game: a throb on
  // the musical grid has no business slowing down because the frame did.
  pulseCycle = advanceCycles(
    pulseCycle,
    l.pulseSync ?? '1/2',
    // The free-running fallback, in cycles per second. `pulse` is authored in
    // radians a second like the rest of the config's oscillators, so it is
    // divided here rather than being a second unit nobody can compare.
    (l.pulse ?? 3.4) / (Math.PI * 2),
    realDt,
    1,
  );
  const openRate = 1 / Math.max(0.02, l.openSeconds ?? 0.45);
  const closeRate = 1 / Math.max(0.02, l.closeSeconds ?? 0.22);
  const flashRate = 1 / Math.max(0.02, l.flashSeconds ?? 0.16);

  for (const [e, owner] of [...owners]) {
    // A boss whose shape went back to the pool takes its spots — and its
    // shells — with it. Same rule the impact smears follow, and for the same
    // reason: a glow with nothing to be a glow ON is a light in open water.
    //
    // A STAND-IN HAS NO POOL TO GO BACK TO, so `alive` on one never falls and
    // the creature leaving the world is the only signal there is. removeEnemy
    // takes the body out of the scene graph, which is the moment to notice.
    const gone = owner.shape?.synthetic
      ? !owner.e.mesh?.parent
      : !owner.shape?.alive;
    if (gone) { releaseHotSpots(e); continue; }

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
          // ONLY ONCE SOMETHING ACTUALLY LIT. Setting this unconditionally
          // hands a boss that placed nothing — every candidate crushed, or the
          // snap finding no flesh along any ray — over to the relight path,
          // which then makes it wait out the full gap before trying again. A
          // boss can arrive with no weak spot for four seconds that way, which
          // reads as the feature being broken on that one animal.
          if (owner.spots.length) owner.placed = true;
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
    // The tuned brightness, times whatever this individual has been given. A
    // multiplier rather than a replacement so the slider still means something
    // when something else is driving it: turn the glow down and every boss
    // dims, including the ones wearing an override.
    u.uHotGlow.value = (l.glow ?? 2.6) * (owner.gain ?? 1);
    u.uHotJag.value = l.jag ?? 0.34;
    u.uHotJagRate.value = l.jagRate ?? 1.4;
    u.uHotCore.value = l.core ?? 3.2;
    u.uHotWhite.value = l.white ?? 0.85;
    u.uHotFill.value = l.fill ?? 0.55;
    // Clamped under 1 as well as over 0: a level that started AT the boundary
    // would be a spot with nothing left to fill, and the whole run-up to a
    // rupture would be a colour change again.
    u.uHotCharge.value = Math.min(0.95, Math.max(0, l.charge ?? 0.34));
    u.uHotChargeEdge.value = l.chargeEdge ?? 0.9;
    u.uHotRing.value = l.ring ?? 1.7;
    u.uHotRingW.value = Math.max(0.01, l.ringWidth ?? 0.16);
    u.uHotSpill.value = Math.max(0.001, l.spill ?? 0.5);
    u.uHotSpillGain.value = l.spillGain ?? 0.55;
    u.uHotBurstReach.value = Math.max(0, l.burstReach ?? 0.9);
    u.uHotBurstW.value = Math.max(0.01, l.burstWidth ?? 0.18);
    u.uHotBurstGain.value = l.burstGain ?? 3;
    u.uHotCycle.value = pulseCycle;
    u.uHotPulseDepth.value = l.pulseDepth ?? 0.55;
    u.uHotFlashSwell.value = l.flashSwell ?? 0.35;
    // The whole colour is the one an override REPLACES, not multiplies. A
    // multiply cannot brighten — an override of pure blue over a white default
    // would come out blue, and over a green default it would come out black —
    // so the two ways of expressing "this boss's spots are blue" would give
    // different answers depending on a config value the caller cannot see.
    _col.set(owner.tint ?? l.litColor ?? 0xffffff); u.uHotLit.value.copy(_col);
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
      if (s.fade <= 0 && (s.dead || !s.alive)) {
        dropSpotRing(s);
        owner.spots.splice(i, 1);
        continue;
      }

      if (!shapeLocalToWorld(s.shape, s.index, s.lx, s.ly, s.lz, _p)) { s.dead = true; continue; }
      s.wx = _p.x;
      s.wy = _p.y;
      // ...and the collision-space twin, through the same transform, so the
      // reach rides the animal exactly as the light does.
      if (shapeLocalToWorld(s.shape, s.index, s.cx, s.cy, s.cz, _p)) {
        s.cwx = _p.x;
        s.cwy = _p.y;
      }
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

      // AFTER the world position and the flash, both of which it reads. A ring
      // driven before them lags the light it is drawn around by a frame, which
      // on a boss crossing the arena is a visible offset.
      driveSpotRing(s, owner, l, realDt);
    }

    // --- into the uniforms ------------------------------------------------
    // Rewritten wholesale every frame, including the empty slots. A slot left
    // holding a dead spot's last position keeps painting it, and the shader
    // has no way to know the difference.
    for (let i = 0; i < MAX_SPOTS; i++) {
      const s = i < owner.spots.length ? owner.spots[i] : null;
      const sv = u.uHotSpot.value[i];
      const mv = u.uHotMood.value[i];
      if (!s) {
        sv.set(0, 0, 0, 0);
        mv.set(0, 0, 0, 0);
        u.uHotPhase.value[i] = 0;
        u.uHotBurst.value[i] = 0;
        continue;
      }
      // HOW FAR THROUGH THE BURST, and only for a spot that actually BURST.
      // `dead` is the other way a light goes out — the boss left the world, or
      // the shape was released — and a shock wave riding that would fire a
      // charge going off in the flank of every animal that ever wore a spot,
      // on the frame its fight ended.
      u.uHotBurst.value[i] = !s.alive && s.ruptured && !s.dead
        ? Math.min(1, Math.max(0, 1 - s.fade))
        : 0;
      // Quantised through the shared helper rather than used raw, so a spot
      // given an offset still lands ON a division instead of a random fraction
      // of one — which would undo the grid the pulse was just put on.
      u.uHotPhase.value[i] = phaseOffset(s.seed, l.pulseSpread ?? 0, l.pulseSteps ?? 2);
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

/** ...and the reticles drawn in front of it, in spot order. */
export function hotSpotRings(e) {
  return (owners.get(e)?.spots ?? []).map((s) => s.ring).filter(Boolean);
}
