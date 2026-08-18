import * as THREE from 'three';
import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// THE ORGANIC RING — every circle the game draws around something that wants
// to hurt you.
//
// Before this there were four independent circles: the strike mark's bracket
// (systems/marks.js), the boss perk tells (systems/bossPerks.js), the boss
// boat's volley tell (systems/bossBoat.js) and the `ring` primitive shape in
// assets.js. Four hand-rolled RingGeometries with four sets of numbers, all
// reading as the same clean vector circle — which is exactly wrong for this
// game, where everything else on the water (the blood, the foam, the wake) is
// a fused liquid mass. A perfect circle was the one thing on screen that
// looked like it came out of a different program.
//
// So: one shader, one noise field, one transition, and a per-threat edge
// dialect on top. This module owns the look; the four callers own the timing
// and the placement, which is the half that is genuinely theirs.
//
// WHAT THE NOISE DOES TO THE BOUNDARY. It displaces the drawn radius BOTH
// WAYS — the ring bulges past its true radius and pulls inside it. That is a
// deliberate call and it has a real cost: a telegraph ring is a promise about
// where damage lands, and a bulge is the ring over-promising reach by
// `CONFIG.fx.organicRing.wobble` world units. It is capped twice for that
// reason — an absolute world-unit amplitude (so a huge blast ring does not
// wobble by metres) and a hard fraction-of-radius ceiling (so a tiny mark is
// not eaten by its own edge). Turn `wobble` to 0 and every ring here is
// geometrically exact again, which is the setting to reach for if a fight ever
// reads as unfair.
//
// THE FIELD IS FIXED IN THE WORLD. Noise is sampled at the fragment's world
// position, not its UV, and that is the decision the rest of the look hangs
// off:
//
//   - grain is a constant world size, so a 1.5-unit mark and a 30-unit blast
//     ring have the same lumpiness rather than one being a magnified copy of
//     the other;
//   - a GROWING ring sweeps THROUGH the field, so it churns as it expands and
//     reads as eating outward through the water instead of inflating like a
//     balloon;
//   - a SPINNING ring (the mark) counter-rotates against the field, so the
//     lumps crawl around the bracket rather than riding it.
//
// `drift` defaults to 0 — the field really is nailed down. It exists because
// a static telegraph on a stationary boss is the one case where a fixed field
// has no motion in it at all, and a very slow drift is the fix if that ever
// reads as frozen.
//
// THE TRANSITION IS THE TIMER. A ring does not fade in; a noise threshold
// sweeps around it like a clock hand (`sweepIn` 0..1) and it is whole exactly
// when the hand comes back round. Every boss wind-up already computes that
// number — `1 - timer / windup` in systems/bossPerks.js — so driving the
// sweep off it costs nothing and buys the player a readable countdown instead
// of a fade that only says "something, soon". Going away is the same hand
// continuing: `sweepOut` chases `sweepIn` around the same circle, so the tail
// eats forward in the direction the head travelled. Two thresholds against
// one angle, which is why an interrupted tell cannot leave a ring half-drawn
// in a way the player has not seen before.
//
// WHY NOT THE ACTUAL GOO PASS. The metaball chain (entities/particles.js into
// systems/post.js) is a screen-space density threshold over PARTICLES. Routing
// a telegraph through it would (a) put the attack boundary at the mercy of an
// isoline that moves when a nearby kill sprays blood into the same field, and
// (b) fuse the tell with that blood, which is the one thing a tell must never
// do. This is a shader that borrows the READ — soft bulbous lobes, varying
// mass, a boundary with surface tension — while staying an exact function of
// the radius it was handed. See the goo note in entities/particles.js for the
// real thing.
// ---------------------------------------------------------------------------

// Which dialect an edge speaks. Kept as ints because the branch is on a
// uniform — every fragment in a draw call takes the same arm, so this costs
// nothing at runtime — and as names because a CSV cell saying `3` would be
// unreadable. EDGE_KINDS is the join between the two.
export const EDGE_KINDS = {
  // Soft bulbous lobes. The base language: anything with no dialect of its
  // own gets this, which is most things.
  smooth: 0,
  // Held jagged splines. See the electric note in the fragment shader.
  electric: 1,
  // Lobes stretched and sagging downward, crawling as they go. Venom, and
  // anything else that reads as a fluid heavier than water.
  drip: 2,
  // Flat chords instead of arcs — the ring becomes a polygon with the true
  // radius as its INCIRCLE, so the facets sit inside the promise and only the
  // corners reach past it. Chill.
  facet: 3,
  // Smooth, but churning: two counter-moving samples so the mass turns over
  // instead of sitting still. Blast and beam, where the tell is short and
  // stillness reads as a dead ring.
  roil: 4,
};

// ---------------------------------------------------------------------------
// THE PALETTE
//
// One table for two jobs, on purpose. A boss's attack type and a status
// somebody is suffering are the same question asked from opposite ends — "what
// kind of harm is this" — and answering it with two unrelated palettes is how
// a game ends up with an electric boss that is not the colour of electricity.
//
// Entries that name an `element` take their colour from CONFIG.biolum.elements
// at read time rather than copying it, so the boss's electric ring and the
// player's Voltaic shots cannot drift apart in a later retune: there is one
// number and both ends read it. Entries with a literal `color` are threat
// types the element system has no opinion about.
//
// Read through `threatType()`, never indexed directly — an unknown type has to
// degrade to the neutral dialect rather than throw, because the id comes out
// of a CSV cell somebody can typo.
// ---------------------------------------------------------------------------
const FALLBACK_TYPES = {
  // Something is about to hit you with its body or with a thrown object.
  kinetic: { color: 0xffc65a, edge: 'smooth' },
  electric: { element: 'shock', edge: 'electric' },
  blast: { color: 0xffa64a, edge: 'roil' },
  beam: { color: 0xff6a4a, edge: 'roil' },
  // Teleport and phase: the boss refusing to be where you aimed.
  void: { color: 0xc9a2ff, edge: 'smooth' },
  venom: { element: 'venom', edge: 'drip' },
  chill: { element: 'chill', edge: 'facet' },
  infection: { element: 'infection', edge: 'drip' },
};

function ringCfg() {
  return CONFIG.fx?.organicRing ?? {};
}

/**
 * Resolve a threat type id to `{ color, edge }` — a THREE.Color-compatible hex
 * and an EDGE_KINDS index. Unknown ids fall back to `kinetic`, because the
 * caller is usually holding a CSV cell.
 */
export function threatType(id) {
  const table = { ...FALLBACK_TYPES, ...(CONFIG.fx?.attackTypes ?? {}) };
  const def = table[id] ?? table.kinetic ?? FALLBACK_TYPES.kinetic;
  // The element join. `?? def.color` rather than the other way round so a
  // palette entry can still override an element colour deliberately.
  const fromElement = def.element
    ? CONFIG.biolum?.elements?.[def.element]?.color
    : null;
  return {
    color: fromElement ?? def.color ?? 0xffffff,
    edge: EDGE_KINDS[def.edge] ?? EDGE_KINDS.smooth,
  };
}

/** Just the colour, for callers that only want to tint something else. */
export function threatColor(id) {
  return threatType(id).color;
}

// ---------------------------------------------------------------------------
// THE SHADER
//
// No backticks anywhere below, including in comments: this is a template
// literal, and one backtick ends the string thirty lines above the error the
// browser reports.
//
// No derivatives either — no fwidth, no dFdx. Injected shaders in this project
// compile as GLSL ES 1.00 where they do not exist at all, and a standalone
// ShaderMaterial that used them would work here and break the moment its body
// was moved into an onBeforeCompile. The antialias width is a uniform instead,
// which is also the only way to control how soft the edge is.
// ---------------------------------------------------------------------------

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vWorld;

  void main() {
    vUv = uv;
    // The world position of this fragment, which is what the noise is sampled
    // at. Taken before the view matrix so the field is nailed to the water and
    // not to the camera.
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xy;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uOpacity;    // the pulse, and the master fade
  uniform float uThickness;  // band HALF width, as a fraction of the radius
  uniform float uExtent;     // half the quad, in units where 1.0 is the radius
  uniform float uRadius;     // the ring's world radius, for world-unit amounts
  uniform float uTime;
  uniform float uNoiseScale; // noise cells per world unit
  uniform float uDrift;      // world units per second the field crawls
  uniform float uWobble;     // radial displacement, in WORLD units
  uniform float uWobbleMax;  // ceiling on it, as a fraction of the radius
  uniform float uMassVar;    // how much the band's own thickness varies
  uniform float uSweepIn;    // 0..1 the leading edge round the circle
  uniform float uSweepOut;   // 0..1 the trailing edge chasing it
  uniform float uSweepNoise; // how ragged the sweep edge is
  uniform float uSweepSoft;  // how wide the sweep edge is
  uniform float uLeadGlow;   // extra brightness on the leading edge
  uniform float uLeadFall;   // how far that brightness reaches back
  uniform float uCharge;     // 0..1 escalation, for the dialects that use it
  uniform float uArcs;       // 0 = closed ring; >0 = that many bracket arcs
  uniform float uArcGap;     // how much of each arc survives, 0..1
  uniform float uArcJitter;  // noise on the arc ends, so they are not cut clean
  uniform float uElecNodes;  // spline nodes around the circle
  uniform float uElecRate;   // node re-rolls per second
  uniform float uFacets;     // flat chords around the circle
  uniform float uAA;         // edge softness, in local units
  uniform float uCore;       // fraction of the half-width that is at full alpha
  uniform int uEdge;
  varying vec2 vUv;
  varying vec2 vWorld;

  #define TAU 6.28318530718

  // Cheap value noise. Deliberately the same family as systems/dissolve.js
  // rather than the gradient noise in systems/noiseShader.js: what is wanted
  // here is a lumpy field with a readable cell size, and the smoothstep
  // interpolation takes the blockiness out of the parts that show.
  float ringHash(vec2 p) {
    p = fract(p * vec2(0.3183099, 0.3678794) + vec2(0.71, 0.113));
    p += dot(p, p + 34.56);
    return fract(p.x * p.y);
  }

  float ringNoise(vec2 x) {
    vec2 i = floor(x);
    vec2 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float a = ringHash(i);
    float b = ringHash(i + vec2(1.0, 0.0));
    float c = ringHash(i + vec2(0.0, 1.0));
    float d = ringHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // Three octaves, weighted hard toward the first. Goo is a LOW frequency
  // read — big soft lobes with surface tension — and an even weighting gives
  // a fuzzy edge instead, which reads as a bad texture rather than as a
  // liquid.
  float ringFbm(vec2 x) {
    float n = ringNoise(x) * 0.6;
    n += ringNoise(x * 2.03 + 11.7) * 0.3;
    n += ringNoise(x * 4.11 + 27.3) * 0.1;
    return n;
  }

  void main() {
    // p is in units where length(p) == 1.0 is the ring's TRUE radius. The quad
    // is bigger than that by uExtent so an outward bulge has somewhere to go —
    // a ring drawn on a quad that stops at r=1 loses everything past it and
    // renders the overflow as four corner smears.
    vec2 p = (vUv - 0.5) * 2.0 * uExtent;
    float r = length(p);
    float ang = atan(p.y, p.x);
    float angFrac = fract(ang / TAU + 0.5);

    // Where to sample the field. World units times cells-per-unit, so the
    // grain is the same size on every ring in the game.
    vec2 w = vWorld * uNoiseScale + vec2(uDrift * uTime, uDrift * uTime * 0.7);

    // The amplitude, in local units. Converted from world units so the
    // physical lumpiness is constant, then capped as a fraction of the radius
    // so a small ring cannot be swallowed by its own edge.
    float amp = min(uWobble / max(uRadius, 0.0001), uWobbleMax);

    float off = 0.0;

    if (uEdge == 1) {
      // ELECTRIC. A closed spline through uElecNodes points around the circle,
      // each holding a random radius offset, all of them re-rolled on a
      // STEPPED clock rather than every frame. Held shapes read as discrete
      // arcs; per-frame jitter at 60Hz reads as a fuzzy band and strobes
      // badly over a long wind-up.
      //
      // Interpolation is LINEAR on purpose. The corner at every node is the
      // jag — smoothstep here gives a wobbling circle, which is the smooth
      // dialect with extra steps.
      float rate = uElecRate * (0.6 + 0.8 * uCharge);
      float step = floor(uTime * rate);
      float a = angFrac * uElecNodes;
      float i0 = floor(a);
      float t = fract(a);
      // The wrap is load-bearing: without the mod, node 0 and node uElecNodes
      // are different random numbers and the ring has a permanent seam at
      // three o'clock.
      float i1 = mod(i0 + 1.0, uElecNodes);
      // THE SIGN ALTERNATES WITH THE NODE INDEX, and only the MAGNITUDE is
      // random. A plain random offset per node gives neighbours that often land
      // on the same side of the circle, and the spline between them is a gentle
      // lump — the first render of this dialect read as a slightly wonky ring
      // with two sharp bits. Forcing consecutive nodes to straddle the radius
      // makes every segment cross it, so every node is a corner and the whole
      // ring zigzags the way an arc does.
      //
      // uElecNodes MUST BE EVEN for this to survive the wrap — with an odd
      // count, node 0 and node n-1 share a sign and the ring has one flat spot
      // where all the others are corners. makeOrganicRing rounds it.
      float sgn0 = mod(i0, 2.0) < 0.5 ? 1.0 : -1.0;
      float sgn1 = mod(i1, 2.0) < 0.5 ? 1.0 : -1.0;
      float v0 = (0.35 + ringHash(vec2(i0, step)) * 0.65) * sgn0;
      float v1 = (0.35 + ringHash(vec2(i1, step)) * 0.65) * sgn1;
      float jag = mix(v0, v1, t);
      // A second, faster, finer spline on top — the crackle riding the arc.
      float a2 = angFrac * uElecNodes * 3.0;
      float j0 = floor(a2);
      float j1 = mod(j0 + 1.0, uElecNodes * 3.0);
      float s2 = floor(uTime * rate * 2.7);
      float fine = mix(ringHash(vec2(j0, s2)), ringHash(vec2(j1, s2)), fract(a2)) * 2.0 - 1.0;
      off = (jag * 0.8 + fine * 0.25) * amp * (0.45 + 0.55 * uCharge);
    } else if (uEdge == 2) {
      // DRIP. The field is squashed along world Y so its lobes come out
      // elongated, and it crawls downward over time — the sag is a fluid
      // heavier than the water it is hanging in. The extra pull is masked to
      // the lower half of the ring, so the top stays taut and only the
      // underside runs.
      float n = ringFbm(vec2(w.x, w.y * 0.35 - uTime * 0.25));
      vec2 dir = r > 0.0001 ? p / r : vec2(0.0, 1.0);
      float down = max(0.0, -dir.y);
      // THE RUNS GET THEIR OWN, MUCH FINER FIELD. The shared grain is a cell
      // 1/uNoiseScale across — nearly two world units — and a boss aura is only
      // a few cells wide, so the base field has room for ONE lobe around the
      // whole ring and the sag came out as a single teardrop hanging off six
      // o'clock. Sampled at three times the frequency across and one times down,
      // which is both fine enough to fit several runs on the underside and
      // stretched enough that each one is a run rather than a bump.
      float runs = ringFbm(vec2(w.x * 3.0, w.y - uTime * 0.6));
      // The two terms are weighted to sum to about ONE amplitude at worst, not
      // two and a bit. Every dialect spends the same budget: uWobble is the
      // distance the boundary is allowed to lie by, and a dialect that quietly
      // spent triple would make that number mean nothing.
      // The sag is raised to a power so only the high spots of the field
      // actually run — that is what makes several distinct drips along the
      // underside instead of the whole lower half sinking as one teardrop,
      // which is what a linear mask gave. The down mask itself is NOT squared, so the
      // drips spread along the flank rather than piling up at six o'clock.
      // smoothstep, not pow. fbm lives in roughly 0.2..0.8 and never reaches
      // either end, so pow() on it is a curve that spends most of its range
      // near zero and never gets near one — the drips were there and were all
      // at a fifth of the amplitude they were budgeted. The smoothstep picks
      // the field's genuine high spots and gives THOSE the whole run.
      float drip = smoothstep(0.42, 0.80, runs);
      off = (n * 2.0 - 1.0) * amp * 0.30 + drip * down * amp * 1.0;
    } else if (uEdge == 3) {
      // FACET. Flat chords rather than arcs. r = 1/cos(offset from the facet
      // centre) is the polygon whose INCIRCLE is the true radius, so the flat
      // parts sit inside the promise and only the corners reach past it —
      // which is the honest way round for a shape drawn on an attack range.
      // The cosine is floored so a facet count that leaves a wide sector
      // cannot send the corner to infinity.
      float a = angFrac * uFacets;
      float i0 = floor(a);
      float ac = (i0 + 0.5) / uFacets * TAU - 3.14159265;
      float chord = 1.0 / max(0.35, cos(ang - ac));
      // NORMALISED against the deepest chord this facet count can make, which
      // is the whole reason the polygon reads at all: at nine facets a raw
      // 1/cos only reaches six percent past the incircle, so an un-normalised
      // chord is a circle with a rumour of corners and the random term below
      // swamps it. Mapped instead so a facet's FLAT sits a little inside the
      // true radius and its CORNERS just reach it.
      float halfSector = 3.14159265 / uFacets;
      float deepest = 1.0 / max(0.35, cos(halfSector)) - 1.0;
      float poly = (chord - 1.0) / max(0.0001, deepest);
      // Inward only. A crystal that grew OUTWARD per facet would put a random
      // share of the perimeter past the boundary, and this is the one dialect
      // picked for being honest about reach.
      float v = ringHash(vec2(i0, 3.7));
      off = (poly * 1.2 - 0.55) * amp - v * amp * 0.22;
    } else if (uEdge == 4) {
      // ROIL. Two samples moving against each other, so the mass turns over
      // rather than sitting still. The one dialect that ignores the fixed
      // field, because it is used on tells that live for half a second and a
      // still ring in that window reads as a frozen frame.
      float n = ringFbm(w + vec2(uTime * 0.6, 0.0)) * 0.62
              + ringFbm(w * 1.7 - vec2(0.0, uTime * 0.9)) * 0.38;
      off = (n * 2.0 - 1.0) * amp * 1.15;
    } else {
      // SMOOTH. The base.
      float n = ringFbm(w);
      off = (n * 2.0 - 1.0) * amp;
    }

    // The band's own thickness varies with a second, coarser sample. This is
    // most of what sells the goo: a boundary that wobbles at constant width
    // reads as a wavy line, where one that also gets FATTER and thinner reads
    // as a mass with surface tension.
    float fat = 1.0 + (ringNoise(w * 0.7 + 5.0) * 2.0 - 1.0) * uMassVar;
    float halfT = uThickness * fat;

    // Nothing may reach the edge of the quad. Without this the wobble cap and
    // the quad padding are two numbers that have to be kept in agreement by
    // hand, and the failure when they drift is a ring with clipped corners
    // that looks like a tuning mistake.
    float room = max(0.0, uExtent - 1.0 - halfT);
    off = clamp(off, -room, room);

    // The band. Centre at (1 - uThickness) rather than at 1, so the ring's
    // OUTER edge is the true radius — the same convention the RingGeometry
    // rings used before this and the one an attack range wants: the damage
    // boundary is where the paint stops.
    float centre = 1.0 - uThickness + off;

    // THE PROMISE. uWobbleMax is meant to be the one number a designer can read
    // as "this is how far the drawn edge may lie about the reach", and clamping
    // the CENTRE does not deliver that — the band's own half-width rides on top
    // of the offset, and the mass variance can widen it further. So the outer
    // edge is clamped directly, and the band is pushed INWARD to make room
    // rather than thinned, which keeps the mass reading the same while the
    // boundary stays honest.
    float outer = centre + halfT;
    float maxOuter = 1.0 + uWobbleMax;
    if (outer > maxOuter) centre -= outer - maxOuter;
    // THE BAND HAS A SOFT SHOULDER, and that is not decoration. A flat-topped
    // band drawn additively at this glow saturates to white across its whole
    // width, and the ring stops being a boundary with a position and becomes a
    // thick bright blob — which is exactly what the first render of the look
    // page came out as. uCore is how much of the half-width stays at full
    // alpha; the rest falls away, so the eye still reads a LINE at the centre
    // with mass around it.
    //
    // The RingGeometry rings this replaced had no such problem because they had
    // no thickness to speak of; the mark's shader had the same soft profile,
    // which is where the number came from.
    float dist = abs(r - centre);
    float band = 1.0 - smoothstep(halfT * uCore, halfT + uAA, dist);
    if (band <= 0.002) discard;

    // THE SWEEP. One angle, two thresholds. The in edge runs 0..1 and the out
    // edge chases it around the same circle, so a ring leaves the way it
    // arrived instead of retreating backwards.
    float sn = ringNoise(w * 0.9 + 17.0);
    float thr = mix(angFrac, sn, uSweepNoise);
    float inRaw = uSweepIn * (1.0 + uSweepSoft) - thr;
    float outRaw = uSweepOut * (1.0 + uSweepSoft) - thr;
    float inMask = smoothstep(0.0, uSweepSoft, inRaw);
    float outMask = smoothstep(0.0, uSweepSoft, outRaw);
    float sweep = inMask * (1.0 - outMask);
    if (sweep <= 0.002) discard;

    // The hand itself. A hot fringe just behind the leading edge, falling off
    // backward — this is what turns a reveal into a readable countdown rather
    // than a ring that happens to be growing.
    float lead = exp(-max(0.0, inRaw) / max(0.0001, uLeadFall)) * inMask;

    // The bracket, for the strike mark. Gaps on the diagonals, and their ends
    // jittered by the same field so a bracket arm stops in a torn edge rather
    // than at a knife cut.
    float arc = 1.0;
    if (uArcs > 0.5) {
      float seg = fract(angFrac * uArcs + 0.125);
      float g = uArcGap + (ringNoise(w * 1.9 + 31.0) - 0.5) * uArcJitter;
      arc = smoothstep(0.0, 0.06, seg) * (1.0 - smoothstep(g - 0.06, g, seg));
      if (arc <= 0.002) discard;
    }

    float a = band * arc * sweep * uOpacity;
    if (a <= 0.002) discard;
    vec3 col = uColor * (uGlow + lead * uLeadGlow);
    gl_FragColor = vec4(col * a, a);
  }
`;

// ---------------------------------------------------------------------------
// GEOMETRY
//
// One quad per extent, shared by every ring that wants that much padding —
// which in practice is one quad for the whole game. Never disposed: it is two
// triangles, and the alternative is every caller having to know whether it was
// the last owner.
// ---------------------------------------------------------------------------
const quads = new Map();

function quadFor(extent) {
  const key = extent.toFixed(3);
  let geo = quads.get(key);
  if (!geo) {
    geo = new THREE.PlaneGeometry(2 * extent, 2 * extent);
    quads.set(key, geo);
  }
  return geo;
}

/**
 * A ring. Scaled and placed by `placeOrganicRing`, driven by
 * `updateOrganicRing`, and it owns its own material — rings differ per
 * instance in colour, charge and sweep, so there is nothing to share.
 *
 * @param opts.type       a threat type id — sets colour and edge dialect
 * @param opts.color      an explicit colour, overriding the type's
 * @param opts.edge       an explicit EDGE_KINDS name, overriding the type's
 * @param opts.arcs       0 for a closed ring, 4 for the strike bracket
 * @param opts.thickness  band half width as a fraction of the radius
 */
export function makeOrganicRing(opts = {}) {
  const c = ringCfg();
  const t = threatType(opts.type);
  const wobbleMax = opts.wobbleMax ?? c.wobbleMax ?? 0.18;
  const thickness = opts.thickness ?? c.thickness ?? 0.16;
  // Room for the whole excursion plus the band that rides on it, plus a
  // little. The shader clamps against this same number, so the two cannot
  // disagree.
  const extent = 1 + wobbleMax + thickness + 0.06;

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // A readout, not geometry — the same reasoning marks.js has always
    // carried. A tell clipped by the boss it is drawn on would vanish exactly
    // when the boss turns side-on, which is the moment it matters most.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(opts.color ?? t.color) },
      uGlow: { value: opts.glow ?? c.glow ?? 2.2 },
      uOpacity: { value: 1 },
      uThickness: { value: thickness },
      uExtent: { value: extent },
      uRadius: { value: 1 },
      uTime: { value: 0 },
      uNoiseScale: { value: opts.noiseScale ?? c.noiseScale ?? 0.55 },
      uDrift: { value: opts.drift ?? c.drift ?? 0 },
      uWobble: { value: opts.wobble ?? c.wobble ?? 0.5 },
      uWobbleMax: { value: wobbleMax },
      uMassVar: { value: opts.massVar ?? c.massVar ?? 0.35 },
      uSweepIn: { value: 1 },
      uSweepOut: { value: 0 },
      uSweepNoise: { value: opts.sweepNoise ?? c.sweepNoise ?? 0.28 },
      uSweepSoft: { value: opts.sweepSoft ?? c.sweepSoft ?? 0.22 },
      uLeadGlow: { value: opts.leadGlow ?? c.leadGlow ?? 3.4 },
      uLeadFall: { value: opts.leadFall ?? c.leadFall ?? 0.12 },
      uCharge: { value: 0 },
      uArcs: { value: opts.arcs ?? 0 },
      uArcGap: { value: opts.arcGap ?? c.arcGap ?? 0.75 },
      uArcJitter: { value: opts.arcJitter ?? c.arcJitter ?? 0.16 },
      // Rounded to EVEN. The electric dialect alternates its sign per node, so
      // an odd count puts two same-signed nodes next to each other at the wrap
      // and leaves one flat spot in an otherwise jagged ring — a bug that looks
      // like a deliberate gap and only shows up on one twelfth of the circle.
      uElecNodes: { value: Math.max(2, Math.round((opts.elecNodes ?? c.elecNodes ?? 18) / 2) * 2) },
      uElecRate: { value: opts.elecRate ?? c.elecRate ?? 13 },
      uFacets: { value: opts.facets ?? c.facets ?? 9 },
      uAA: { value: opts.aa ?? c.aa ?? 0.014 },
      uCore: { value: opts.core ?? c.core ?? 0.22 },
      uEdge: { value: opts.edge != null ? (EDGE_KINDS[opts.edge] ?? 0) : t.edge },
    },
  });

  const mesh = new THREE.Mesh(quadFor(extent), material);
  // THE GEOMETRY IS SHARED and this flag is how a caller's own teardown finds
  // that out. Every ring in the game rides the same two triangles, so a
  // generic disposeObj() that frees `obj.geometry` would free them out from
  // under every other live ring — three re-uploads it silently, so the symptom
  // is a per-frame cost with no error attached to it. Route through
  // disposeOrganicRing() instead, which drops the material and leaves the quad
  // alone.
  mesh.userData.organicRing = true;
  // The quad is padded, so its bounding sphere is honest but its CONTENTS are
  // driven from a uniform the culler cannot see. Cheaper to skip the test than
  // to explain to it that the ring might be somewhere else.
  mesh.frustumCulled = false;
  mesh.renderOrder = opts.renderOrder ?? 9;
  return mesh;
}

/**
 * Put a ring somewhere, at a size. This is the only supported way to scale
 * one: the world-unit wobble has to be divided by the world radius, so the
 * scale and `uRadius` are a pair, and setting the scale by hand leaves the
 * amplitude computed against whatever the radius was last frame.
 */
export function placeOrganicRing(mesh, x, y, worldRadius, z = 0) {
  if (!mesh) return;
  const r = Math.max(0.0001, worldRadius);
  mesh.position.set(x, y, z);
  mesh.scale.setScalar(r);
  mesh.material.uniforms.uRadius.value = r;
}

/**
 * Advance a ring's clock and set the parts that change per frame.
 *
 * `sweepIn` and `sweepOut` both run 0..1 around the same circle: in leads, out
 * chases. Leave them alone for a ring that is simply on.
 */
export function updateOrganicRing(mesh, dt, opts = {}) {
  if (!mesh) return;
  const u = mesh.material.uniforms;
  u.uTime.value += dt;
  if (opts.opacity != null) u.uOpacity.value = opts.opacity;
  if (opts.sweepIn != null) u.uSweepIn.value = Math.min(1, Math.max(0, opts.sweepIn));
  if (opts.sweepOut != null) u.uSweepOut.value = Math.min(1, Math.max(0, opts.sweepOut));
  if (opts.charge != null) u.uCharge.value = Math.min(1, Math.max(0, opts.charge));
  if (opts.color != null) u.uColor.value.set(opts.color);
  if (opts.glow != null) u.uGlow.value = opts.glow;
  if (opts.thickness != null) u.uThickness.value = opts.thickness;
  if (opts.type != null) setRingThreat(mesh, opts.type);
}

/** Recolour and re-dialect a live ring — the strike mark tracking a status. */
export function setRingThreat(mesh, type) {
  if (!mesh) return;
  const t = threatType(type);
  const u = mesh.material.uniforms;
  u.uColor.value.set(t.color);
  u.uEdge.value = t.edge;
}

/** Is this one of ours? For callers with a generic teardown path. */
export function isOrganicRing(obj) {
  return !!obj?.userData?.organicRing;
}

/** Drop a ring's material. The geometry is shared and stays. */
export function disposeOrganicRing(mesh) {
  if (!mesh) return;
  mesh.parent?.remove(mesh);
  mesh.material?.dispose?.();
}

// For the harness and the look page. Nothing in Node compiles GLSL, so the
// realistic failure — a uniform renamed on one side of the pair and not the
// other — is otherwise uncovered, and its symptom is a ring that is silently
// invisible rather than an error. Same escape hatch, and the same reasoning,
// as marks.js's __ringShader and bakalar's __beamShader.
export const __organicRingShader = {
  vertexShader,
  fragmentShader,
  makeOrganicRing,
  FALLBACK_TYPES,
};
