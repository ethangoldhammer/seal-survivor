import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { hitShapeSpheres, worldToShapeLocal, shapeLocalToWorld } from './hitShape.js';
import { feedback } from './feedback.js';
import { hotSpotZoneBonus } from './damageZones.js';
import { advanceCycles, phaseOffset } from './beatSync.js';
import { retireMaterial } from './programPin.js';
import { bossArmorMul, isAttacking } from '../entities/enemies.js';
import bossHotSpotsCsv from '../bossHotSpots.csv?raw';
import bossesCsv from '../bosses.csv?raw';
import { parseBossHotSpotCsv, buildBossHotSpots } from '../bossHotSpotTable.js';
import { parseBossCsv } from '../bossTable.js';

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
// THERE IS NO MARK DRAWN IN FRONT OF IT ANY MORE
//
// There was, and the argument for it was good: the glow above is ADDITIVE
// LIGHT ON A HIDE, so its legibility is a property of the animal underneath —
// unmissable on the orca's near-black flank, one bright thing among several on
// a pale hull or a deck full of lights. So each spot also carried a reticle,
// the strike mark's ring at a fraction of its size with depth testing off,
// drawn in front of the body. The ring said WHERE, from anywhere on screen and
// on any hide; the glow said WHAT.
//
// TWO MARKS FOR ONE OBJECT IS ONE MARK TOO MANY. Read in the water rather than
// on paper, a boss carried up to three weak spots, each of them a six-segment
// hexagon spinning on its own axis with a sweep, a pop and a swell, drawn over
// a patch of skin that was itself compositing six layers and a crawling noise
// field. Every one of those was answering a real question and none of the
// answers arrived, because the player's eye was being handed eleven
// simultaneous statements about a thing the size of a fist.
//
// THE FIX IS PAINT, NOT A SECOND OBJECT. The reason the glow needed rescuing
// was never that it was drawn on the body — it was that it could only ADD. An
// additive layer over near-black flesh and the same layer over a white hull
// are different amounts of contrast for the same number, so no single
// brightness could ever read on both, and a mark in front was the way around
// that. Coverage is the way through it: the patch REPLACES the hide by a
// fraction (see the note on the blend mode in makeSkinMaterial), which lands
// the same way on a black flank, a white belly and a lit deck, for the same
// reason a decal does. With that turned up, the skin can carry the whole mark
// and the second object has nothing left to do.
//
// AND EACH BOSS SAYS WHAT COLOUR ITS OWN MARK IS — bossHotSpots.csv, which is
// the other half of the same thought. "Which colour reads on this animal" is a
// fact about that animal's hide, and it was being answered once for the whole
// roster from inside this file, where nothing that knows anything about a
// particular boss can reach it.
//
// WHAT THE RETICLE USED TO SAY AND SOMETHING STILL HAS TO. It was also the
// lock indicator: a designated spot takes the whole volley (see aimHotSpots),
// and a lock the player cannot see is a lock they cannot use. That moved onto
// the patch — uHotLock brightens it and uHotLockRing fattens its boundary ring
// — which is where the eye already is, and it cost nothing, because deleting
// the chewed edge freed the per-spot slot the seed had been using.
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
  // x alive 0..1, y flash, z heat, w LOCK — is this the spot the player's aim
  // is on. The w slot used to carry a per-spot random seed, which existed for
  // one consumer: the noise field that chewed the outline. That field is gone
  // (see the note on the composite below) and the seed went with it, which is
  // what freed a slot for the thing the reticle used to say.
  uniform vec4 uHotMood[${MAX_SPOTS}];
  // THE PHASE OFFSET IS ITS OWN ARRAY. At the shipped spread of 0 every spot
  // in the game throbs in lockstep with the music, which is the point; the
  // array is what makes a spread possible at all without the phase riding a
  // slot something else needs.
  uniform float uHotPhase[${MAX_SPOTS}];
  // HOW FAR THROUGH COMING APART each one is: 0 for its whole lit life, then
  // 0 → 1 over closeSeconds from the frame it ruptures.
  uniform float uHotBurst[${MAX_SPOTS}];
  uniform float uHotCore;
  uniform float uHotCoreGain;
  uniform float uHotGlow;
  uniform float uHotFill;
  uniform float uHotFloor;
  uniform float uHotHeatGain;
  uniform float uHotCover;
  uniform float uHotCoverFull;
  uniform float uHotCharge;
  uniform float uHotRing;
  uniform float uHotRingW;
  uniform float uHotLock;
  uniform float uHotLockRing;
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

  // ---------------------------------------------------------------------
  // FOUR THINGS, AND THE COUNT IS THE DESIGN.
  //
  // This block used to composite six: an interior floor, the fill level, the
  // level's own leading edge, the boundary ring, a haze spilling past that
  // boundary with an animated noise field chewing its outline, and the burst
  // shock — times a throb, times a heat gain, times a hit swell, through a
  // three-colour mix and a white core, with a six-segment hexagonal reticle
  // drawn in front of the animal on top of all of it. Every one of those was
  // a good idea about a different question and the answer to none of them was
  // legible, because eleven simultaneous statements about one small object is
  // not eleven readings, it is texture.
  //
  // What survives is the four that answer the only questions the player is
  // actually asking, each owning exactly one of them:
  //
  //   WHERE IS IT    the patch, which REPLACES the hide rather than lighting
  //                  it (see the coverage note at the bottom). This is the
  //                  half that fixes "too hard to see", and it is not a
  //                  brightness change: additive light over a near-black orca
  //                  and over a white yacht hull are different amounts of
  //                  contrast for the same number, so no single glow value
  //                  could ever read on both. Paint does.
  //   HOW FAR CAN I  the ring, a hard band exactly on r = 1, which is the crit
  //                  boundary. One number, read from one place.
  //   HOW CLOSE IS   the fill level rising from charge to the boundary, plus
  //                  the colour drifting lit → hot.
  //   IS IT MINE     the lock, which brightens the whole thing and fattens the
  //                  ring. This was the reticle's job and the reticle is gone.
  //
  // The burst shock is the fifth and is exempt because it is TRANSIENT: it
  // exists for a fifth of a second on the frame a spot comes apart, so it is
  // never on screen at the same time as the questions above are being asked.
  // ---------------------------------------------------------------------

  // rgb = the light this spot adds. a = how much of the HIDE it stands in for.
  vec4 hotSpotLight(vec4 s, vec4 m, float phase, float burst) {
    if (m.x <= 0.0 || s.w <= 0.0) return vec4(0.0);

    // r = 1.0 IS THE CRIT BOUNDARY. Everything below is built around that one
    // fact: the ring is drawn exactly there, the fill is inside it, and
    // nothing moves it. Nothing is drawn OUTSIDE it any more either, which is
    // new — the spill used to put a chewed haze half a radius past the reach,
    // so the brightest thing on the animal was wider than the thing it was
    // describing and the player was aiming at the middle of a smear.
    float r = distance(vHotWorld, s.xyz) / max(0.05, s.w);
    // The far edge of everything this spot can paint, and it is the SHOCK that
    // decides it: the only layer that leaves the boundary, and only while a
    // spot is bursting.
    float outer = 1.0 + uHotBurstReach * burst;
    if (r > outer) return vec4(0.0);

    // BREATHING IS BRIGHTNESS, NOT SIZE. Scaling the reach would swing the
    // drawn boundary either side of the number the crit test uses several
    // times a second — a small lie, told constantly, about the one thing on a
    // boss the player is aiming at.
    //
    // ON THE MUSICAL GRID. uHotCycle is a beat-synced counter in [0,1) from
    // systems/beatSync.js, so every boss in the water throbs with the track
    // rather than each on its own rad/sec. Heat doubles the rate by crossfading
    // to the second harmonic, which is the one way to speed a throb up without
    // leaving the grid: sin(2t) over the same cycle is the next division down
    // and wraps at the same point.
    float theta = (uHotCycle + phase) * 6.28318530718;
    float wave = mix(sin(theta), sin(theta * 2.0), m.z);
    float breathe = 1.0 + uHotPulseDepth * wave;

    // THE RING, AND IT FATTENS WHEN THIS IS THE LOCKED SPOT. A brightness lift
    // alone could not say "this one" on a boss whose spots all throb in
    // lockstep — at pulseSpread 0, which is what ships, they are otherwise
    // identical objects. Weight is the second reading, and it lands on the
    // boundary, which is where the eye already is.
    float rw = uHotRingW * (1.0 + m.w * uHotLockRing);
    float ring = smoothstep(rw, 0.0, abs(r - 1.0));

    // THE FILL, AND IT IS A LEVEL RATHER THAN A WASH. A fresh spot is lit out
    // to uHotCharge of its radius and a spent one is lit to the boundary, so
    // "how close is this to going" is a distance the player can see against a
    // line that is already drawn. Nothing here moves the boundary: the thing
    // that grows is not the thing being aimed at, and the moment they meet is
    // the moment the spot bursts.
    float lvl = mix(uHotCharge, 1.0, m.z);
    // THE WHOLE DISC IS PAINTED, ALWAYS. The level says how far the spot has
    // been chewed; this says the spot is a spot. Without it the interior above
    // the level is bare hide, so a fresh weak spot is a ring with the animal's
    // own skin inside it — an outline drawn ON the boss rather than a place
    // that is glowing.
    float body = 1.0 - smoothstep(1.0 - rw, 1.0, r);
    // The same shoulder the ring is drawn with, on purpose. At full heat the
    // two land on top of each other and have to read as one line.
    float fill = 1.0 - smoothstep(lvl - rw, lvl, r);
    // AND THE WHOLE INSIDE BRIGHTENS AS IT TAKES DAMAGE. The level covers more
    // of the disc as the spot fills, which is a change in AREA — legible head
    // on and easy to miss on a boss crossing the arena. This is the same fact
    // told in brightness, which carries at any size.
    float heat = mix(1.0, uHotHeatGain, m.z);
    // A soft hot middle. The one thing kept from the old core term, and kept
    // because a flat disc has no centre to aim at; what went is the white
    // mix that used to sit on top of it and bleached the colour ramp out of
    // the middle of every spot at exactly the moment the ramp mattered most.
    float core = pow(max(0.0, 1.0 - r), uHotCore);

    // AND THE BURST: one band leaving the wound. Everything else a rupture
    // does happens at the spot's own size and none of it is drawn ON the
    // animal, so without this the skin's account of the event is a light going
    // out over a fifth of a second.
    //
    // It is NOT faded by hand. m.x — the same fade that takes the light out —
    // multiplies the whole return below, so the wave dying and the spot going
    // dark are one number and cannot drift into a shock still travelling over
    // a spot that has already gone.
    float sr = mix(1.0, outer, burst);
    float shock = smoothstep(uHotBurstW, 0.0, abs(r - sr)) * step(0.0001, burst);

    // LIT -> HOT as it takes damage, and all the way to the struck colour on
    // the frame it is hit. Three colours and two mixes, in that order, because
    // each has to win over the last: a nearly-ruptured spot is already warm and
    // a hit on it still has to read as a hit.
    vec3 col = mix(uHotLit, uHotHot, m.z);
    col = mix(col, uHotFlash, m.y);

    // ONLY THE RING AND THE SHOCK MAY CLIP, and that is the whole shape budget
    // in one line. The scene renders to HalfFloat, so a term over 1 survives
    // the bright pass — but the composite still lands in 8 bits, and anything
    // past the ceiling there is flat white with no edge and no interior. So
    // the interior terms are sized to stay under 1 at the PEAK of the throb
    // (x breathe), and the two that are meant to be LINES are left an order of
    // magnitude over it.
    float shape = body * uHotFloor * heat
                + fill * uHotFill * heat
                + core * uHotCoreGain
                + ring * uHotRing
                + shock * uHotBurstGain;
    float lift = 1.0 + m.y * uHotFlashSwell + m.w * uHotLock;

    // AND HOW MUCH OF THE ANIMAL THIS STANDS IN FOR — see the note on the
    // blend mode in makeSkinMaterial. THIS IS THE LEGIBILITY.
    //
    // Additive light cannot win an argument with a dark hide, and that reads
    // as backwards until you write it down: a spot on near-black flesh IS the
    // brightest thing there, and it is still only as bright as the number it
    // adds — so the interior lands at a fraction of the ceiling over a body at
    // nearly zero and comes out a dim smear. Turning it up is the move that
    // failed twice: it takes the ring's headroom with it and puts the whole
    // spot back into one flat saturated mass.
    //
    // What the interior actually wants to say is not "there is light here", it
    // is "this patch of the animal is a different colour" — a statement about
    // the hide, not about light on top of it. Coverage replaces the hide by
    // this fraction, so the patch reads on black flesh, on a white belly and
    // on a lit deck for the same reason a decal does, while every bright layer
    // above it still adds on top exactly as it did.
    //
    // IT DOES NOT BREATHE and it does not take the flash. Those move LIGHT; a
    // hide that changed colour twice a bar would read as the animal's own skin
    // flickering, which is a different creature rather than a marked one.
    float cover = clamp(max(body, fill) * mix(uHotCover, uHotCoverFull, m.z) * m.x, 0.0, 1.0);

    return vec4(col * uHotGlow * shape * breathe * lift * m.x, cover);
  }
`;

const SKIN_FRAG = /* glsl */ `
  {
    vec4 h0 = hotSpotLight(uHotSpot[0], uHotMood[0], uHotPhase[0], uHotBurst[0]);
    vec4 h1 = hotSpotLight(uHotSpot[1], uHotMood[1], uHotPhase[1], uHotBurst[1]);
    vec4 h2 = hotSpotLight(uHotSpot[2], uHotMood[2], uHotPhase[2], uHotBurst[2]);
    vec4 h3 = hotSpotLight(uHotSpot[3], uHotMood[3], uHotPhase[3], uHotBurst[3]);
    // THE LIGHT SUMS AND THE COVERAGE DOES NOT. Two spots overlapping would
    // add their light, which is what light does — but coverage is a fraction
    // of one surface, and adding two of them takes it past 1, which the blend
    // reads as multiplying the flesh behind them by a negative number and
    // renders as a black bite out of the animal. The strongest claim on the
    // hide wins.
    //
    // AND THEY CAN OVERLAP NOW. This used to be a guard against a case
    // minGapFrac made impossible — but that rule lives in pickCandidate, and
    // an AUTHORED boss (bossHotSpots.csv) skips the roll entirely: two anchors
    // are a statement about where the spots go, not a request the spacing rule
    // is entitled to overrule. The crab's claws on a body that collides as a
    // circle are exactly that case.
    vec3 hot = h0.rgb + h1.rgb + h2.rgb + h3.rgb;
    float cover = max(max(h0.a, h1.a), max(h2.a, h3.a));
    // NOTHING NEAR A SPOT DRAWS AT ALL. The shell covers the whole animal, so
    // without this every boss pays a full-body pass writing nothing — and on a
    // body already carrying an outline shell that is the third draw of the same
    // geometry. Both channels have to be quiet: a fragment with no light but
    // real coverage is the darkened edge of a patch, and discarding it would
    // cut the patch off with a hard rim.
    if (hot.r + hot.g + hot.b < 0.002 && cover < 0.002) discard;
    // PREMULTIPLIED. hot is already the light's full contribution and is NOT
    // scaled by the coverage — the blend adds it whole and uses the alpha only
    // to decide how much of the animal underneath survives.
    gl_FragColor = vec4(hot, cover);
  }
`;

// ---------------------------------------------------------------------------

// THE MUSICAL CYCLE, advanced once a frame for every boss in the water rather
// than once per boss. The transport position is the same answer for all of
// them, and two bosses throbbing on their own copies of it is two bosses that
// can drift apart — which is the one thing a beat-locked effect must not do.
//
// Wrapped at 1, which is a whole number of periods for BOTH harmonics the
// shader reads (sin(t) and sin(2t)); a wrap that is not shows up as a visible
// jump every time the counter comes round. See advanceCycles.
let pulseCycle = 0;

// WHAT EACH ARCHETYPE SAYS ABOUT ITS OWN WEAK SPOTS — see bossHotSpotTable.js.
// Built once at module load, with the archetype ids handed in so a row tagged
// for a boss that was renamed is a warning at boot rather than a row nothing
// ever reads.
const AUTHORED = buildBossHotSpots(
  parseBossHotSpotCsv(bossHotSpotsCsv),
  { bosses: parseBossCsv(bossesCsv, CONFIG.enemies, () => {}).map((b) => b.id) },
);

/** The parsed table, for the harness, the look page and the audit. */
export function bossHotSpotRoster() {
  return AUTHORED;
}

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
// The jostle's direction, reused — a Vector3 per crit is a Vector3 ten times a
// second for the length of a boss fight.
const _jolt = new THREE.Vector3();

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
    uHotGlow: { value: l.glow ?? 2.6 },
    uHotCore: { value: l.core ?? 3.2 },
    uHotCoreGain: { value: l.coreGain ?? 0.35 },
    uHotFill: { value: l.fill ?? 0.55 },
    uHotFloor: { value: l.floor ?? 0.3 },
    uHotHeatGain: { value: l.heatGain ?? 1.8 },
    uHotCover: { value: l.cover ?? 0.5 },
    uHotCoverFull: { value: l.coverFull ?? 0.85 },
    uHotCharge: { value: l.charge ?? 0.34 },
    uHotRing: { value: l.ring ?? 1.7 },
    uHotRingW: { value: l.ringWidth ?? 0.16 },
    uHotLock: { value: l.lockGlow ?? 0.9 },
    uHotLockRing: { value: l.lockRing ?? 0.8 },
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
    // PREMULTIPLIED ALPHA, WHICH IS ADDITIVE AND A DECAL IN ONE PASS.
    //
    // src x ONE + dst x (1 - srcAlpha). Read the two halves separately and it
    // is obvious what it buys: with alpha 0 the destination survives whole and
    // the colour is added on top — that is AdditiveBlending exactly, which is
    // what this was and what every bright layer in the shader still wants. With
    // alpha above 0 the animal underneath is scaled down first, so the same
    // pass can also STAND IN for the hide instead of only lighting it.
    //
    // WHY THAT MATTERS ON A DARK ANIMAL. Additive light can only ever add, so
    // a quiet layer over near-black flesh is a quiet colour over nothing and
    // reads as a smear; the only lever is brightness, and brightness is the
    // ring's, not the interior's. Coverage is a different sentence — "this
    // patch of animal is a different colour" — and it lands the same way on a
    // black flank, a white belly and a lit deck.
    //
    // The alternative was a second shell in NormalBlending under this one,
    // which is a third full-body draw of the boss's geometry to say something
    // one blend function already says. See the shader's gl_FragColor.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
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
    retireMaterial(s.material);
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

// ---------------------------------------------------------------------------
// A BOSS THAT IS TOLD WHERE ITS WEAK SPOTS GO
//
// A row in bossHotSpots.csv names one or more ANCHORS and the roll below is
// skipped: the spots open at those places, on every arrival, for the whole life
// of the archetype.
//
// WHY AUTHORED AND NOT A BETTER ROLL. The weighted pick answers "somewhere good
// on this outline", which is the right question for a body with a lot of
// outline and the wrong one where the answer is a design decision. "Its weak
// points are its claws" is a thing a designer says about an animal, not a thing
// a placement heuristic can be tuned into discovering — and on the three bosses
// that collide as a CIRCLE by choice (the crab, the boat, the man o' war) there
// are no fitted spheres for a heuristic to prefer at all, so the roll there was
// picking points on a disc.
//
// ALONG THE BODY'S OWN AXIS, from `heading`, rather than in world x or y: the
// animal turns, and a tail found in world space is whichever end happened to be
// pointing left. `faceMotion` bodies keep `heading` in step with where they are
// going and the mesh's rotation is derived from it, so this is the same forward
// every other system on the creature reads.
//
// NORMALISED AGAINST THE BODY'S OWN MEASURED EXTENT, not against `e.radius`.
// A megalodon is far longer than it is wide, so a fraction of its radius would
// put "the tail" somewhere near its middle; the candidates themselves describe
// how long the animal is this frame, and that is the only scale that is right
// on every body including a synthetic circle.

// Where each candidate sits in the body's frame, as two fractions in -1..1:
// `along` from tail to head, `across` from the right flank to the left. Filled
// once per placement pass and read by the ordering below.
function bodyFrame(cands, e) {
  const a = e.heading ?? 0;
  const fx = Math.cos(a);
  const fy = Math.sin(a);
  const ox = e.mesh?.position.x ?? 0;
  const oy = e.mesh?.position.y ?? 0;
  let spanA = 0;
  let spanC = 0;
  let spanU = 0;
  const out = cands.map((c) => {
    const dx = c.wx - ox;
    const dy = c.wy - oy;
    // The left-hand normal of the heading, so `across` is positive to port.
    const along = dx * fx + dy * fy;
    const across = dx * -fy + dy * fx;
    // ...and the same offset in WORLD up, un-rotated. This is the axis a flank
    // cannot express: `across` follows the animal round when it turns, so a
    // dorsal spot written as a flank becomes a belly spot on the way home.
    // Normalised on its own span for the same reason the other two are -- a
    // megalodon is far longer than it is tall, and sharing a scale would make
    // "the back" mean "the nearest end".
    const up = dy;
    if (Math.abs(along) > spanA) spanA = Math.abs(along);
    if (Math.abs(across) > spanC) spanC = Math.abs(across);
    if (Math.abs(up) > spanU) spanU = Math.abs(up);
    return { c, along, across, up };
  });
  // Guarded rather than assumed non-zero: a body whose candidates all sit on
  // one line — a synthetic circle sampled at a single radius, in principle —
  // would divide by zero and hand every comparison below a NaN, which fails
  // silently and orders the candidates at random.
  const sa = spanA > 1e-4 ? spanA : 1;
  const sc = spanC > 1e-4 ? spanC : 1;
  const su = spanU > 1e-4 ? spanU : 1;
  for (const p of out) { p.along /= sa; p.across /= sc; p.up /= su; }
  return out;
}

// Candidates ordered by how near they sit to one authored anchor, so the caller
// can walk outward from the named place and take the first spot that survives
// the snap and the hull-match tests.
//
// AN ORDER AND NOT A POINT, which is the whole reason an anchor can never fail.
// The extreme candidate is often one the mesh cannot support — a tail is an END
// of an animal, not a vertex — and on a badly fitted hull (`hullMatch`) whole
// regions are refused outright. Ordering rather than selecting means the worst
// case is a spot a little away from where it was asked for, instead of a boss
// with a weak spot fewer than it should have.
//
// THE SIDE IS A TIE-BREAK, NOT A FILTER. A wrong-flank candidate is pushed to
// the back of the order rather than removed: on a body with no flesh on the
// named side the spot still opens, and it opens as near as the animal allows.
// Filtering would make a claw anchor silently place nothing on a crab whose
// near-side sphere happened to be buried this frame.
function anchoredOrder(frame, anchor) {
  if (!anchor) return null;
  const side = anchor.side ?? 0;
  // The world-up axis, when the anchor named the back or the belly rather than
  // a flank. Exclusive with `side` by construction -- see VERTS in
  // bossHotSpotTable.js -- so exactly one of the two penalties below can fire.
  const vert = anchor.vert ?? 0;
  return frame
    .map((p) => {
      // Distance in the body's own frame. On an UNSIDED anchor the lateral
      // term is weighted down: both axes are normalised to full scale, so
      // without it "the tail" pulls as hard sideways as it does lengthwise and
      // becomes "the nearest tail corner". On a SIDED anchor it drops out
      // entirely — the flank is already being said by the penalty below, and
      // counting it twice would pull the spot toward the widest part of the
      // named side rather than toward the station that was asked for.
      const d = Math.abs(p.along - anchor.along) + (side || vert ? 0 : Math.abs(p.across) * 0.35);
      // A FULL UNIT OF PENALTY — the whole length of the body — so every
      // candidate on the named flank is tried before any on the other one.
      const wrongSide = side && Math.sign(p.across) !== Math.sign(side) ? 1 : 0;
      // The same penalty on the other axis, and it has to be the same SIZE: a
      // dorsal anchor that merely preferred the top would put the spot on a
      // belly whenever the back happened to be a little further from the
      // station, which is the bug this axis exists to make impossible.
      const wrongVert = vert && Math.sign(p.up) !== Math.sign(vert) ? 1 : 0;
      // ...and pull toward the extreme of the named axis, not merely onto the
      // right half of it: "the back" is the TOP of the back, the way `tail` is
      // the end of the tail rather than anywhere aft of amidships.
      const pull = vert ? Math.abs(vert - p.up) * 0.5 : 0;
      return { c: p.c, d: d + wrongSide + wrongVert + pull };
    })
    .sort((x, y) => x.d - y.d)
    .map((x) => x.c);
}

/**
 * The order one anchor puts a body's perimeter candidates in, for the harness.
 *
 * Exported for the same reason perimeterCandidates is: the ordering is the
 * whole of what an anchor DOES, and measuring it through a placement measures
 * it through the snap and the hull-match as well — which on a body whose
 * flanks are thin at the named station (a shark's snout) refuses the near-side
 * candidates and lands the spot on the far one, correctly, while looking
 * exactly like the ordering being broken.
 */
export function anchorOrder(cands, e, anchor) {
  return anchoredOrder(bodyFrame(cands, e), anchor);
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
  let fitTotal = 0;
  const weights = new Array(cands.length);
  const fits = new Array(cands.length);
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
    //
    // BUT KEPT IN ITS OWN POOL, which is the correction — see below. Crushing
    // both of these by the same factor makes them the same kind of objection,
    // and they are not: "there is nowhere better" is a fact about the animal,
    // while "this one is too close to the last spot" is a preference about the
    // arrangement, and a preference must never be able to outvote the fact.
    const tooSmall = c.hostR < minHostR;
    if (tooSmall) w *= 0.02;
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
    fits[i] = !tooSmall;
    total += w;
    if (!tooSmall) fitTotal += w;
  }
  if (total <= 0) return null;

  // A HOST THAT CAN CARRY THE SPOT WINS OUTRIGHT OVER ONE THAT CANNOT, and the
  // two crushes above are why this has to be a separate pass rather than a
  // bigger multiplier.
  //
  // THE MOSASAUR IS THE CASE. Twelve fitted spheres and exactly ONE of them is
  // wide enough to hold a spot at `minRadius`; the rest are neck, jaw, paddles
  // and four tail bones a fifth of that. The first spot lands on the torso, as
  // it should — and then the spacing rule crushes the whole of that torso for
  // being near it, by the same 0.02 the too-small hosts carry. Two crushed
  // pools of similar weight, so the roll is a coin toss, and about half the
  // time the second spot opens on a tail bone with a radius floored at nearly
  // five times the flesh it is attached to: a light bigger than the tail, a
  // boundary ring entirely in open water, and a crit zone that is mostly sea.
  // Read from the water it does not look like a placement rule tie-breaking —
  // it looks like the spot came off the animal, which is exactly how it was
  // reported.
  //
  // So the fallback is a FALLBACK. Roll among the hosts that fit; only when the
  // animal genuinely has none — which is the case the crush was written for —
  // fall through to the rest. A second spot crowding the first on the torso is
  // a worse arrangement and still a spot on the boss; a spot on the tail tip is
  // not a spot on the boss at all.
  const useFit = fitTotal > 0;
  let roll = Math.random() * (useFit ? fitTotal : total);
  for (let i = 0; i < cands.length; i++) {
    if (useFit && !fits[i]) continue;
    roll -= weights[i];
    if (roll <= 0) return cands[i];
  }
  for (let i = cands.length - 1; i >= 0; i--) if (!useFit || fits[i]) return cands[i];
  return null;
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

// ---------------------------------------------------------------------------
// AND IT HAS TO STAY THERE — THE RIM IS AN INVARIANT, NOT A PLACEMENT
//
// Everything above puts a spot on the outer edge of the collision hull, and
// then the animal swims. The anchor is a point in one sphere's BONE SPACE, so
// it rides the flesh faithfully — and being on the rim is not a property of
// the flesh, it is a property of the flesh's relationship to every OTHER piece
// of the animal. A shark bends; a sphere that had nothing in front of it now
// sits behind two others; the spot is inside the body, and nothing in the
// per-frame path was in a position to notice.
//
// WHY THAT IS A GAMEPLAY BUG AND NOT A LOOK ONE. The game is played in two
// dimensions. A shot travelling toward a weak spot stops at the FIRST hull
// surface it meets, and the contact it writes is the point the crit test is
// asked about — so a crit zone a body-thickness behind that surface cannot be
// hit at all, from any angle, by any weapon. It is not "hard to hit"; it is
// unreachable, while still being lit, painted and pointed at by a reticle.
// Measured with tools/boss-hitbox-audit.mjs, a dead-centre shot at a weak spot
// paid out on 0% of tries at the boat, 25% at the squid and 45% at the yacht.
//
// So the rim is re-established every frame: walk the anchor out along its own
// outward direction until it is outside every padded sphere. That is the exact
// surface `hitShapeTest` writes contacts on, so the spot lands where a shot
// can land, by construction rather than by luck.
//
// THE DIRECTION IS RE-DERIVED FROM THE HOST SPHERE, not taken from the stored
// normal. The stored one is the placement normal carried through the bone's
// matrix, which is right for the goo and the shove — those are about the wound
// — and can point anywhere after the bone has turned. Away from the centre of
// the sphere the spot is riding is outward from that body part at the pose it
// is in NOW, which is the only reading that cannot walk a spot out through the
// opposite flank.

/**
 * How far along (nx, ny) the point (px, py) has to travel to leave the padded
 * sphere union. 0 when it is already outside.
 *
 * Marched sphere by sphere rather than solved in one go, because the union of
 * overlapping spheres has no closed form: leaving one puts you inside the next,
 * and the exit that matters is the last one. Bounded by the sphere count, so a
 * pathological arrangement costs one pass and not a hang.
 */
function pushToRim(spheres, pad, px, py, nx, ny) {
  let t = 0;
  for (let pass = 0; pass < spheres.length + 2; pass++) {
    let moved = false;
    const cx = px + nx * t;
    const cy = py + ny * t;
    for (const s of spheres) {
      const r = s.wr * pad;
      if (!(r > 0)) continue;
      const dx = s.wx - cx;
      const dy = s.wy - cy;
      const proj = dx * nx + dy * ny;
      const perp2 = dx * dx + dy * dy - proj * proj;
      if (perp2 >= r * r) continue;              // the ray misses this one
      const half = Math.sqrt(r * r - perp2);
      // Inside it only when the entry is behind us and the exit ahead. A
      // sphere further down the ray that we have not reached yet is not
      // containing us and must not push us into it.
      if (proj - half > 1e-4 || proj + half <= 1e-4) continue;
      t += proj + half;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return t;
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
function spotRadius(owner, bodyR, hostR) {
  const c = cfg();
  // The archetype's own fraction where it has one. This is the crit's REACH as
  // well as the drawn boundary — one number, on purpose — so it is gameplay,
  // and it is still per boss: how big a target an animal offers is a property
  // of that animal, the same way its weak points' places are.
  const r = (bodyR ?? 1) * (owner?.radiusFrac ?? c.radiusFrac ?? 0.34);
  const capped = Math.min(r, hostR * (c.hostCap ?? 1.1));
  return Math.max(c.minRadius ?? 0.6, Math.min(c.maxRadius ?? 3.2, capped));
}

// WHICH AUTHORED PLACE IS STANDING EMPTY, or null on a boss with no row.
//
// A SPOT RELIGHTS WHERE IT BURST, which is the opposite of what an unauthored
// boss does and is the point of authoring one. "Its weak point is the tip of
// its tail" is a sentence about the animal rather than about this arrival: if
// the replacement opened somewhere else, the fight would teach the player the
// place for four seconds and then contradict it, and the second spot would be
// the roll's answer wearing the authored boss's colour.
function freeAnchor(owner) {
  if (!owner.anchors?.length) return null;
  const held = new Set();
  for (const s of owner.spots) if (!s.dead && s.anchorAt != null) held.add(s.anchorAt);
  for (let i = 0; i < owner.anchors.length; i++) if (!held.has(i)) return i;
  return null;
}

// Try until one sticks. A single pick that fails its hull-match test is not a
// reason to leave the boss a spot short — it is a reason to look somewhere
// else on the animal, which is what the weighted roll is for.
function lightSpot(owner, cands, tries = 12) {
  // TOLD, NOT ROLLED. The order runs outward from the authored place, so this
  // walks away from it and takes the first spot the mesh and the hull both
  // agree on, rather than re-rolling a weighted pick a dozen times over a body
  // whose answer was written down.
  const at = freeAnchor(owner);
  if (at != null) {
    const order = anchoredOrder(bodyFrame(cands, owner.e), owner.anchors[at]);
    for (let i = 0; i < order.length; i++) {
      const spot = tryLightSpot(owner, cands, order[i]);
      if (spot) { spot.anchorAt = at; return spot; }
    }
    return null;
  }
  for (let i = 0; i < tries; i++) {
    const spot = tryLightSpot(owner, cands);
    if (spot) return spot;
  }
  return null;
}

function tryLightSpot(owner, cands, forced = null) {
  const c = cfg();
  const e = owner.e;
  const taken = owner.spots.filter((s) => s && s.alive && !s.dead);
  // In multiples of the animal's own size, so "not on top of each other" means
  // the same thing on a megalodon and on a crab.
  const pick = forced ?? pickCandidate(cands, taken, (c.minGapFrac ?? 0.7) * (e.radius ?? 1),
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
  // AN AUTHORED SPOT IS NOT CAPPED BY ITS HOST, and that is the one place an
  // anchor has to change more than the choice. `hostCap` exists to stop a spot
  // the ROLL happened to drop on a fin tip being drawn several times the size
  // of the fin — an accident, caught. A claw or a tail tip the designer named
  // is not that accident, and capping it there would produce a light a fifth
  // of the size of every other boss's, on exactly the bosses whose weak points
  // the player is meant to go looking for. Sized against the whole animal
  // instead, the way `radiusFrac` reads everywhere else.
  const r0 = forced
    ? Math.max(c.minRadius ?? 0.6, Math.min(c.maxRadius ?? 3.2,
      (e.radius ?? 1) * (owner.radiusFrac ?? c.radiusFrac ?? 0.34)))
    : spotRadius(owner, e.radius, pick.hostR);
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
    // slot-derived seed gives the replacement spot the same pulse phase as the
    // one that just burst in that position. Its only consumer now is
    // phaseOffset below — the chewed edge that was the other one is gone.
    seed: Math.random(),
  };

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
export function attachHotSpots(scene, e, archetype = null) {
  if (!e || !e.isBoss) return null;
  const c = cfg();
  // WHAT THIS PARTICULAR ANIMAL SAYS ABOUT ITS OWN WEAK SPOTS, or null for a
  // boss with no row — which is the ordinary case and means "roll them and
  // wear the roster colour". Passed in rather than read off the creature: the
  // archetype is a fact about the FIGHT (bosses.csv) and not about the body,
  // bodies are pooled, and a stale id riding a recycled megalodon would paint
  // the next one with the last one's authored colour.
  const authored = archetype ? AUTHORED[archetype] ?? null : null;
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
  let want = lo + Math.floor(Math.random() * (hi - lo + 1));
  // A TOLD BOSS GETS WHAT IT WAS TOLD. Anchors are the count as well as the
  // places — "its weak points are its claws" is a sentence about how many
  // there are — and a `count` with no anchors fixes the number without naming
  // the places. Both blank is the roll above, which is what most bosses do.
  //
  // THIS MOVES THE FIGHT'S NUMBERS AND IT IS MEANT TO. `ruptureFraction` is
  // per spot, so a one-spot boss holds a third of what a three-spot boss holds
  // in weak points rather than the same total arranged differently: the
  // mosasaur and the angler are longer to chew and have one place to chew
  // them. Stated here rather than absorbed quietly.
  if (authored?.anchors?.length) want = authored.anchors.length;
  else if (authored?.count != null) want = authored.count;
  want = Math.min(want, MAX_SPOTS);
  if (want <= 0) return null;

  const u = freshUniforms();
  const owner = {
    e,
    shape,
    // KEPT, AND UNUSED AGAIN. The glow is painted on the animal's own meshes
    // and the meat is queued for main.js to spawn, so this module has nothing
    // to add to a world — it had for exactly as long as the reticles existed.
    // The argument stays because every caller passes it and a harness that
    // measures placement passes null; removing it is a change to five call
    // sites to delete one null.
    scene: scene ?? null,
    want,
    spots: [],
    relightIn: 0,
    placed: false,
    visible: false,
    // The spot the player's aim is lying across, as of this frame — see
    // aimHotSpots. Null until an aim claims one, and null again the moment it
    // bursts, which is what hands the volley back to the per-pellet rule.
    designated: null,
    // THE AUTHORED PLACES, in order, or null on a boss that rolls. Read by
    // freeAnchor as spots burst and relight — a spot goes back where it was.
    anchors: authored?.anchors ?? null,
    // ...and its own size, if the row named one. Null falls through to
    // hotSpots.radiusFrac like every unauthored boss.
    radiusFrac: authored?.radiusFrac ?? null,
    // THE OVERRIDE SLOTS, seeded from the row. Null and 1 mean "wear what
    // CONFIG says", which is what a boss with no row does. setHotSpotLook
    // still writes over both — a perk's attack colour or a run's element is a
    // fact about THIS FIGHT and outranks a fact about the archetype.
    tint: authored?.color ?? null,
    gain: authored?.brightness ?? 1,
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

export function hotSpotDamage(e, at, dmg, where = null, source = null) {
  if (!at || !(dmg > 0)) return dmg;
  const spot = hotSpotUnder(e, at, where);
  if (!spot) return dmg;

  const c = cfg();
  // THE BAND'S OWN BONUS, on top of the crit. On a body that grades hits by
  // where they came from (systems/damageZones.js — the man o' war), finding a
  // weak spot while you are airborne over it is the best thing the player can
  // do, and it should pay more than the two rewards multiplied would give on
  // their own. Every other boss returns 1 here and the line costs nothing.
  //
  // The BAND multiplier itself is NOT applied here — it lands in the hp setter
  // that every damage path already runs through, so applying it again would
  // charge it twice. This is only the extra.
  // ...AND IT GOES THROUGH SUPER ARMOR. While a boss is committed its hp
  // setter takes CONFIG.boss.armor.committed of every decrement (see
  // armBossArmor in entities/enemies.js), and the spot is the one thing the
  // armor is meant to leave open: a lunge is when the spots are in front of
  // you and the body is holding a straight line, so the answer to a committed
  // boss is the spot rather than the flank. Divided back out here because the
  // setter is going to re-apply it a line later in the caller — exactly the
  // bargain the BAND multiplier already lives under, two paragraphs up, and
  // single-sourced in `bossArmorMul` so the two cannot drift apart.
  const armor = Math.max(1e-4, bossArmorMul(e));
  const mul = Math.max(1, c.critMul ?? 2.2) * hotSpotZoneBonus(e);
  // WHAT ACTUALLY LANDS, and what the caller has to HAND the setter to make it
  // land, are two different numbers while the armor is up — and everything
  // below wants the first one. `out` is returned for `e.hp -= out`, where the
  // armor scales it straight back down to `landed`; `landed` is what fills the
  // pool, and getting that wrong is not a rounding error: at committed 0.15 a
  // spot would have filled nearly seven times faster during a lunge than at
  // any other moment of the fight, and ruptured on a hit worth a seventh of
  // what the pool says it costs.
  const landed = dmg * mul;
  const out = landed / armor;

  // THE POOL TAKES THE CRIT DAMAGE, not the raw damage. Two reasons and they
  // point the same way: a spot should burst on the strength of what actually
  // went into it, and pooling the raw number would make the rupture threshold
  // silently mean `ruptureFraction / critMul` of the bar — a second number
  // hidden inside the first, which is exactly the kind of coupling that makes
  // a CSV row stop meaning what it says.
  spot.taken += landed;
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

  // AND THE ANIMAL FLINCHES, harder than anything else in the game can make it.
  //
  // SIZED BY WHAT THIS HIT WAS WORTH rather than by the fact that it happened.
  // Ten pellets and one club swing carrying the same damage reach the same
  // total, because the springs integrate impulses — which is the only reading
  // under which an automatic weapon and a slow one can look like the same
  // fight. It is the chum payout's argument applied to the body language, and
  // it is what makes this answer to the player's build for every weapon rather
  // than only for the one that was threaded.
  //
  // `landed` and not `out`: the pool takes the crit damage, and this is the
  // same event measured the same way. On a committed boss the armor divides
  // `out` back up, and a flinch scaled to that would be seven times too big
  // during the one window the spot is meant to be the answer.
  {
    const j = c.jostle ?? {};
    const gate = jostleGate(e, source);
    if (gate > 0) {
      const share = landed / Math.max(1, spot.pool);
      jostle(spot, c, share * (j.heatRamp === false ? 1 : ramp) * gate, j.tipBias);
    }
  }

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

// ---------------------------------------------------------------------------
// THE SPOT THE PLAYER IS POINTING AT
//
// Every guided shot in this game used to choose its own weak spot, nearest
// wins, one pellet at a time. That is a reasonable rule and it is the wrong
// one, for a reason that has nothing to do with the arithmetic: the player
// cannot see it. A volley leaves the flippers and fans out over three
// different lights, each pellet answering a question about its own position,
// and from behind the seal it reads as the ordnance ignoring the aim entirely.
// The crit that is supposed to be the fight's whole skill expression arrives
// as weather.
//
// So the AIM decides, and every seeker in the air obeys the same answer. The
// reticle is already drawn along `input.aim` (systems/aimIndicator.js) — this
// is that beam asking which light it is lying across, once a frame, and
// writing the winner onto the boss. Point at a spot and the whole volley goes
// there; point anywhere else and every shot falls back to the per-pellet rule
// below, which is what the game did before this existed.
//
// PER BOSS, not global: two bosses in the water at once (the blubberball
// roster can do it) each get their own answer, and a shot chasing one is not
// steered by an aim that happens to cross the other.
//
// STICKY, with two cones. `aimGrab` is how close the beam has to pass to CLAIM
// a spot; `aimRelease` is how far it may wander before the claim drops. One
// number for both meant a spot flickering on and off across the boundary while
// a hand held still, and a volley split between the spot and the body centre —
// visibly the same bug this whole mechanism exists to remove.
// ---------------------------------------------------------------------------

/**
 * Which weak spot the player's aim is lying across, on every boss in the
 * water. Called once a frame from main.js, BEFORE the projectiles update:
 * the answer is read by every seeker that steers this frame, and one computed
 * after them would steer the whole volley on the previous frame's aim.
 *
 * @param px,py  where the seal is
 * @param ax,ay  the aim direction (input.aim — normalised, but not trusted to
 *               be: a zero-length aim HOLDS the last answer rather than
 *               clearing it, because a pad's stick returning to centre is not
 *               the player saying "stop aiming at that")
 */
export function aimHotSpots(px, py, ax, ay) {
  const len = Math.hypot(ax ?? 0, ay ?? 0);
  if (!(len > 1e-4)) return;
  const nx = ax / len;
  const ny = ay / len;
  const c = CONFIG.homing?.hotSpots ?? {};
  const grab = c.aimGrab ?? 2.2;
  const release = Math.max(grab, c.aimRelease ?? 3.6);

  for (const owner of owners.values()) {
    if (!owner.placed) { owner.designated = null; continue; }
    let best = null;
    let bestScore = Infinity;
    let heldScore = Infinity;
    for (const s of owner.spots) {
      if (!s.alive || s.dead) continue;
      const sx = s.cwx ?? s.wx;
      const sy = s.cwy ?? s.wy;
      const vx = sx - px;
      const vy = sy - py;
      // BEHIND THE SEAL IS NOT AIMED AT. The beam is a ray, not a line, and
      // without this a spot directly astern scores as well as the one the
      // player is looking at — the aim indicator draws forward only.
      if (vx * nx + vy * ny <= 0) continue;
      // How far the beam passes from the light, IN UNITS OF THAT LIGHT'S OWN
      // RADIUS. Under 1 means the ray goes through the spot. Relative rather
      // than absolute because spot size varies by a factor of four across the
      // roster (hotSpots.minRadius to maxRadius) and a fixed miss distance
      // would make the small ones unclaimable and the big ones magnetic.
      const score = Math.abs(vx * ny - vy * nx) / Math.max(1e-4, s.r);
      if (s === owner.designated) heldScore = score;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    const held = owner.designated;
    const holding = held && held.alive && !held.dead && heldScore <= release;
    // The held one keeps it unless the beam has MOVED ONTO another — inside
    // the tighter cone and clearly nearer, not merely nearer by a hair. Two
    // spots on one flank sit close enough together that a hand holding still
    // still crosses between them, and "nearest wins" there hands the claim
    // back and forth several times a second; `aimSwap` is what makes a change
    // of target a thing the player did rather than a thing that happened.
    const swap = CONFIG.homing?.hotSpots?.aimSwap ?? 0.6;
    if (holding && !(bestScore <= grab && bestScore < heldScore * swap)) continue;
    owner.designated = bestScore <= grab ? best : null;
  }
}

/**
 * The spot the player's aim claimed on this creature, or null.
 *
 * Null for everything that is not a boss wearing one, and null on a boss whose
 * lights the aim is nowhere near — both of which mean "use the per-pellet
 * rule", so a caller never has to special-case the ordinary fight.
 */
export function designatedHotSpot(e) {
  const owner = owners.get(e);
  const s = owner?.designated;
  if (!s || !s.alive || s.dead) return null;
  return s;
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

// MAY THIS HITTER SHAKE THIS BOSS?
//
// A BOSS DOES NOT ANSWER TO BEING SHOT AT. That is CONFIG.boss.tenacity, and
// it is a rule about the FIGHT rather than about the picture: a flinching boss
// is a boss that is not lunging, so a hit reaction per pellet makes the answer
// to a wind-up "shoot harder" instead of "move". The generic flinch every
// creature takes (onEnemyDamagedFeedback in main.js) is already weighted by
// `hitReactionMul`, which ships at zero for a boss.
//
// THE WEAK SPOT DOES NOT GET TO WALK AROUND THAT, and the first version of
// this did — by calling anim.impulse directly, which is exactly the hole the
// rule's own harness was written to watch for: "the tenacity gate is added in
// front of the SHOVE and forgotten in front of the FLINCH". npm run
// test:tenacity caught it, by counting the runs a boss under fire got through
// against a control it was not being shot at.
//
// SO THE JOSTLE ANSWERS TO THE SAME LIST THE SHOVE DOES — `tenacity.sources`,
// which is the game's single statement of what a boss can be moved by: the
// seal's own body, a weak spot bursting inside it, and a swung club. A stream
// of pellets into a lit spot pays double damage, sheds meat, leaks, brightens
// and bursts, and it does not rock the animal. An unnamed caller is refused,
// deny-by-default, so the failure lands on a new weapon that forgot to say
// what it is rather than on the boss.
//
// COMMITTED MEANS COMMITTED, and that half is NOT here — it lives in jostle()
// itself, keyed on `isAttacking`, so it covers every caller rather than only
// the ones that remembered to ask this. Two committed checks in two places is
// how one of them ends up stale. This function answers only the other
// question: whether this HITTER is allowed to shake a boss at all.
function jostleGate(e, source) {
  const ten = CONFIG.boss?.tenacity ?? {};
  if (ten.enabled === false) return 1;
  if (!e?.isBoss) return 1;
  const allowed = ten.sources ?? ['ram', 'rupture', 'club'];
  if (source && allowed.includes(source)) return 1;
  // The same weight an unnamed shove gets, which ships at 0. Read from the one
  // field rather than hard-coded, so turning tenacity down turns BOTH channels
  // down together — two numbers here is how a boss ends up unshoveable and
  // still visibly buckling.
  return Math.max(0, ten.shove ?? 0);
}

// SHAKE THE ANIMAL'S SKELETON, out along the skin at the wound.
//
// DIRECTLY RATHER THAN THROUGH A QUEUE, unlike the meat and the rupture's
// shove. Those two both need something this module cannot reach — a pickup
// list, and applyKnockback, which lives in entities/enemies.js at the far end
// of an import cycle through the three biggest modules in the game. The bone
// springs are on the creature's own `anim`, which is already in hand, so there
// is nothing to route: an impulse is a method call on the thing being hit.
//
// A NO-OP ON A BODY WITH NO RIG. Three bosses arrive as hulls with no spring
// chains at all, and anim.impulse is written to do nothing on those rather
// than make every caller check which ones they are.
//
// AND A NO-OP ON A BOSS THAT IS MID-ATTACK, which is the one rule in this file
// that is not about weak spots at all. CONFIG.boss.tenacity says a boss that is
// attacking takes no hit reaction from anything, at any weight — hitReactionMul
// returns 0 and applyKnockback withholds its own bone kick — and this was the
// single channel that never asked. It was also by far the loudest:
// `jostle.strength` is 34 against the 14 an ordinary hit can ever deliver, it
// fires per crit, and the note on its caller says out loud that it shakes the
// animal harder than anything else in the game can.
//
// Which landed exactly where it must not. Super armor deliberately leaves a
// lit spot open DURING a run (see bossArmorMul) — a lunge is when the spots
// are in front of you and the body is holding a line, so the answer to a
// committed boss is the spot — so the one window the game tells the player to
// pour crits into a spot was also the one window the animal was being whipped
// through. On a hammerhead, whose five-bone tail chain is the longest in the
// roster and whose whole tell is the head swinging round to face you, the pass
// read as a flinch rather than as an attack, and the tell was gone.
//
// The damage, the crit, the pool, the light, the goo, the chum and the rupture
// all still land mid-attack untouched. What goes is the fraction of a second
// of the animal's own body language — the same thing tenacity takes off every
// other channel, for the same reason.
//
// `isAttacking` rather than a copy of its test: one reach, asked four times,
// so a fifth kind of boss attack is a line there and nothing here. It covers
// the wind-up as well as the run, and it covers the grab and the crab's pinch,
// which is what makes this a rule about bosses rather than about lunges.
function jostle(spot, c, scale, tipBias) {
  const j = c.jostle ?? {};
  if (j.enabled === false) return 0;
  const e = spot.owner?.e;
  const ten = CONFIG.boss?.tenacity ?? {};
  if (e?.isBoss && ten.enabled !== false && ten.committed !== false
      && isAttacking(e)) return 0;
  const strength = Math.max(0, (j.strength ?? 0) * scale);
  if (!(strength > 0)) return 0;
  const anim = e?.anim;
  if (!anim?.impulse) return 0;
  // The world normal, kept in the sphere's own frame and re-derived every
  // frame, so it is where OUT is on this body right now rather than where it
  // was when the spot opened. The same direction the goo leaves along and the
  // same one the rupture's shove is thrown down — all three read `wnx`/`wny`,
  // because three answers to "which way is out of the animal here" is how a
  // hit ends up spraying one way and kicking another.
  _jolt.set(spot.wnx ?? 1, spot.wny ?? 0, 0);
  anim.impulse(_jolt, strength, tipBias);
  return strength;
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

  // ...AND THE BODY COMES APART AROUND THAT SHOVE. The knock above moves the
  // whole animal as one piece; without this it moves RIGIDLY, which reads as a
  // boss being pushed rather than as a charge going off under its skin. Flat
  // rather than damage-scaled, unlike the per-hit jostle: a rupture is one
  // event of one size however it was reached, and the last pellet in should
  // not be worth more of it than the first.
  {
    const j = c.jostle ?? {};
    // 'rupture' by name: a charge going off inside the flesh is one of the
    // three things a boss answers to, and it is the one the whole feature is
    // built around. Still refused mid-run, like everything else — see
    // jostleGate, and the shove queued above, which is gated the same way
    // inside applyKnockback.
    const gate = jostleGate(spot.owner?.e, 'rupture');
    if (gate > 0) {
      jostle(spot, c, (j.rupture ?? 0) / Math.max(1e-4, j.strength ?? 1) * gate, j.ruptureTipBias);
    }
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
    // The tuned brightness, times whatever this individual has been given. A
    // multiplier rather than a replacement so the slider still means something
    // when something else is driving it: turn the glow down and every boss
    // dims, including the ones wearing an override.
    u.uHotGlow.value = (l.glow ?? 2.6) * (owner.gain ?? 1);
    u.uHotCore.value = Math.max(0.5, l.core ?? 3.2);
    u.uHotCoreGain.value = Math.max(0, l.coreGain ?? 0.35);
    u.uHotFill.value = l.fill ?? 0.55;
    u.uHotFloor.value = Math.max(0, l.floor ?? 0.3);
    // At least 1: a "heat gain" under one would DIM a spot as it filled, which
    // is the opposite sentence in the same words and is the kind of thing a
    // slider dragged past its own middle can say by accident.
    u.uHotHeatGain.value = Math.max(1, l.heatGain ?? 1.8);
    // Both clamped to 0..1. Over 1 is a hole in the animal — the blend scales
    // the destination by (1 - alpha), so 1.2 does not mean "more opaque", it
    // means the flesh behind the spot is multiplied by a negative number and
    // the patch renders as a black bite out of the boss.
    u.uHotCover.value = Math.min(1, Math.max(0, l.cover ?? 0.5));
    u.uHotCoverFull.value = Math.min(1, Math.max(0, l.coverFull ?? 0.85));
    // Clamped under 1 as well as over 0: a level that started AT the boundary
    // would be a spot with nothing left to fill, and the whole run-up to a
    // rupture would be a colour change again.
    u.uHotCharge.value = Math.min(0.95, Math.max(0, l.charge ?? 0.34));
    u.uHotRing.value = l.ring ?? 1.7;
    u.uHotRingW.value = Math.max(0.01, l.ringWidth ?? 0.16);
    // WHAT BEING THE AIMED-AT SPOT IS WORTH, in brightness and in ring weight.
    // Both, because a boss's spots throb in lockstep at the shipped spread and
    // a brightness lift alone is a difference the eye has nothing to compare
    // against. Floored at 0: a negative lock would DIM the spot the player is
    // pointing at, which is the same words in the opposite order.
    u.uHotLock.value = Math.max(0, l.lockGlow ?? 0.9);
    u.uHotLockRing.value = Math.max(0, l.lockRing ?? 0.8);
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

      // BACK OUT ONTO THE RIM — see pushToRim. The anchors ride the flesh
      // faithfully and the flesh moves behind other flesh, so this is the one
      // place "on the outer edge" can be kept true rather than merely arranged
      // once. Both anchors take the SAME correction: the crit reach so a shot
      // can reach it, and the painted centre so the light stays the same
      // distance inboard of it that placement chose. Moving one alone is
      // exactly the drift `hullMatch` exists to prevent.
      {
        const spheres = hitShapeSpheres(s.shape);
        const pad = CONFIG.hitShape?.padding ?? 1;
        // Outward from the piece of body the spot is riding, at the pose it is
        // in this frame. `wnx` is the placement normal carried through the
        // bone and can point anywhere once that bone has turned — good enough
        // for the goo, which only has to leave the wound, and not good enough
        // for a push that could otherwise walk a spot out through the far side.
        const host = spheres[s.index];
        let ox = s.wnx;
        let oy = s.wny;
        if (host) {
          const hx = (s.cwx ?? s.wx) - host.wx;
          const hy = (s.cwy ?? s.wy) - host.wy;
          const hl = Math.hypot(hx, hy);
          if (hl > 1e-4) {
            ox = hx / hl;
            oy = hy / hl;
            // AND IT BECOMES THE SPOT'S NORMAL, rather than being a second
            // opinion held privately by this block. Four things read that
            // direction — the goo, the rupture's shove, the seeker's "is this
            // spot pointing at me" test and the audit's probe — and every one
            // of them is asking the same question this push just answered:
            // which way is OUT of the animal here, right now. Two answers to
            // that is how a shot gets aimed down one line while the light is
            // pushed along another, which reads as the crit simply not paying.
            s.wnx = ox;
            s.wny = oy;
          }
        }
        const push = pushToRim(spheres, pad, s.cwx ?? s.wx, s.cwy ?? s.wy, ox, oy);
        if (push > 1e-4) {
          s.cwx += ox * push;
          s.cwy += oy * push;
          s.wx += ox * push;
          s.wy += oy * push;
        }
      }

      s.flash = Math.max(0, s.flash - flashRate * realDt);

      // WHAT IS COMING OUT OF IT WHILE NOBODY IS SHOOTING.
      //
      // The per-hit leak already scales with heat (`rampMin`/`rampMax`), so a
      // late crit throws more than an early one — but that is only visible on
      // the frames the player is landing shots, and it says nothing at all
      // about a spot they opened and walked away from. This is the state of
      // the wound rather than the event: a fresh spot seeps nothing, one about
      // to go is bleeding steadily, and the run-up is legible on a boss the
      // player is not currently shooting.
      //
      // ON A HEAT-DRIVEN INTERVAL rather than a heat-scaled count, because the
      // two look completely different. A fixed cadence throwing more each time
      // reads as one thing pulsing harder; puffs arriving closer together read
      // as a leak getting worse, which is what it is. `everyFull` at the
      // bottom and `everyEmpty` at the top, so heat shortens the gap.
      const seep = c.seep ?? {};
      if (seep.enabled !== false && s.alive && !s.dead) {
        const h = Math.min(1, s.taken / Math.max(1, s.pool));
        // Below the threshold it is silent. A spot that dribbles from the
        // first pellet has nothing left to escalate, and three of them
        // dribbling from the moment a boss arrives is the fight's whole
        // opening spent on an effect that is supposed to mean "nearly".
        if (h > (seep.from ?? 0.15)) {
          const t = (h - (seep.from ?? 0.15)) / Math.max(0.01, 1 - (seep.from ?? 0.15));
          const gap = (seep.everyEmpty ?? 0.5) + ((seep.everyFull ?? 0.11) - (seep.everyEmpty ?? 0.5)) * t;
          s.seepIn = (s.seepIn ?? Math.random() * gap) - realDt;
          if (s.seepIn <= 0) {
            s.seepIn = Math.max(0.02, gap);
            // Out along the skin, at the same offset a hit's leak uses — fired
            // from the centre the lobes fuse into a disc sitting ON the light
            // and cover the very thing they are meant to be advertising.
            const out = s.r * (c.bleedOffset ?? 0.8);
            feedback('hotSpotSeep', {
              x: s.wx + s.wnx * out,
              y: s.wy + s.wny * out,
              dirX: s.wnx,
              dirY: s.wny,
              // ...and it grows on the same ramp, so the puffs get closer
              // together AND bigger. One or the other alone reads as a cadence
              // change or as a size change; together it reads as a wound.
              scale: (seep.scaleEmpty ?? 0.4) + ((seep.scaleFull ?? 1.2) - (seep.scaleEmpty ?? 0.4)) * t,
            });
          }
        } else {
          s.seepIn = null;
        }
      }

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
        // IS THIS THE ONE THE PLAYER IS POINTING AT. The whole volley is going
        // here (see aimHotSpots), and a lock the player cannot see is a lock
        // they cannot use. It used to be said by the reticle drawn in front of
        // the animal; with that gone it is said on the patch itself, which is
        // where the eye already is. A LIVE spot only — one that has burst is on
        // its way out and its last frames belong to the rupture.
        s === owner.designated && s.alive && !s.dead ? 1 : 0,
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
