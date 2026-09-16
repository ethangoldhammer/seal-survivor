// ============================================================================
// POSSESSION, AS SHARED GLSL — the two-colour field that says whose ball it is.
//
// A LEAF MODULE WITH NO IMPORTS, for the reason noiseGlsl.js and causticsGlsl.js
// are leaf modules and say so at length: two consumers paint with this field and
// they have to paint with the SAME one.
//
//   systems/post.js   puts it on the BALL — the body itself, inside the goo
//                     pass, where the mix is a second metaball field running
//                     inside the first.
//   systems/grid.js   puts it on the WATER THE BALL HAS BEEN THROUGH — the
//                     backdrop lattice, where every dent the ball springs into
//                     the hexes is lit by the same drop, sampled in that dent's
//                     own frame.
//
// A copy in the second consumer would agree on the day it was written and drift
// the first time anyone retuned a lobe — and the failure is not an error, it is
// a trail in one arrangement of colours behind a ball in another. The whole
// read this is for ("that streak through the grid is MY ball") only works while
// the two are the same picture.
//
// WHAT IT DOES NOT CARRY. The colours' SOURCE — the momentum ledger, who has
// touched what, how far the newest colour has marched — is systems/ballLook.js
// and stays there. This is the drawing of a share, not the deciding of one.
//
// THE SKIN IS THE CONSUMER'S. The drop is walked back inside a body before it
// is drawn, and the two consumers have different bodies to be held by: the goo
// pass reads the ball's own density field, so a dent punched into the ball
// pushes the cells in it out of the way, while the lattice has no body at all
// and only ever clamps to the circle. So each consumer declares `posHold`
// BEFORE including POSSESSION_FIELD_GLSL, and the field calls it.
//
// NO `import * as THREE` either, deliberately: these are strings. The uniform
// VALUES live with whoever is building the material — post.js reads them off a
// goo group and grid.js off a published field, and neither should have to
// reach through the other to get them.
// ============================================================================

/**
 * The field's uniforms. Both consumers declare exactly these names, which is
 * what lets the function below be one function.
 *
 * uBallAt / uBallR / uBallAspect are NOT here: they belong to post.js's own
 * `posHold`, which projects into the pass's uv to read the density field. The
 * lattice has no density field and no uv.
 */
export const POSSESSION_UNIFORMS_GLSL = /* glsl */ `
  uniform vec3 uTeamA;      // the colour that HELD the ball
  uniform vec3 uTeamB;      // ...and the one marching in from the contact
  uniform float uShare;     // how much of the body B has taken, 0..1
  uniform float uSeed;      // the contact's world angle, radians
  uniform float uLobes;     // satellites riding the mass, 0..7
  uniform float uLobeSize;  // ...how big each is, x the mass's own kernel
  uniform float uWobble;    // ...and how far out they are thrown
  uniform float uSpin;      // how fast their ring rolls, rad/s
  uniform float uBreathe;   // how hard each swells and shrinks on its own clock
  uniform vec2 uDrift;      // the slosh: how far the mass is left behind, in ball radii
`;

/**
 * HOW MUCH OF THIS POINT IS TEAM B, 0..1 — `d` is the point in the body's own
 * frame, where the centre is 0 and the drawn edge is about 1, and `t` is the
 * clock the lobes roll on.
 *
 * Requires `vec2 posHold(vec2 lp, float rim)` to be declared above it.
 *
 * IT GROWS, IT DOES NOT SWEEP. A wedge widening out of the contact is the
 * obvious way to spend a share and it reads as a pie chart: the boundary is a
 * spoke, the spoke is a straight line through a molten body, and no amount of
 * noise on it stops it looking like a chart.
 *
 * So the colour arrives as THE BOOST METER'S DROP — the same construction as
 * the core in systems/strikeRing.js, which is the thing in this game that
 * already looks like what this wants to be: a blob with lobes riding a slowly
 * rolling ring around it, each breathing on a rate that shares no factor with
 * the roll, the lot summed into one field and thresholded once. They grow, they
 * spin, and they FUSE, because the welds between them are field rather than
 * geometry — two lobes that have only just met join with a waist, the same way
 * the ball's own splats make one body and not a bag of circles.
 *
 * WHERE IT STARTS AND WHERE IT ENDS. The mass is born ON THE RIM at the contact
 * and walks in to the middle as it grows, so the colour arrives from the touch
 * rather than blooming out of the centre; at a full share it is centred and big
 * enough to have swallowed the body.
 *
 * Since uShare is lerped on the CPU, the growth IS the lerp: nothing here has a
 * clock of its own except the roll, so a share that stops moving is a mass that
 * stops spreading, and the two can never disagree about how much is whose.
 */
export const POSSESSION_FIELD_GLSL = /* glsl */ `
  float possessionMix(vec2 d, float t) {
    vec2 seedP = vec2(cos(uSeed), sin(uSeed));
    float sh = clamp(uShare, 0.0, 1.0);
    // ...AND IT IS SLOSHED BY THE FLIGHT. uDrift is the ball's velocity MINUS a
    // lagged copy of it (systems/ballLook.js), in ball radii: when the ball is
    // struck the mass is left behind and piles against the trailing skin, and
    // it catches up as the lag does. The cells inherit the ball's motion; they
    // do not have a motion of their own.
    vec2 at = seedP * (1.0 - sh) + uDrift;
    // The kernel radius that puts the SURFACE where it is wanted: a blob of
    // kernel radius k has its isoline at about 0.55 k for this cubic, so the
    // mass reaches the far rim at a share of 1 without the guard below having
    // to paper over it.
    float k = (0.35 + 1.9 * sh) * 0.9;
    at = posHold(at, 0.85);
    float dens = 0.0;
    {
      vec2 q = d - at;
      float u = dot(q, q) / max(k * k, 1e-6);
      if (u < 1.0) { float f = 1.0 - u; dens += f * f * f; }
    }
    // THE LOBES ARE WHAT MAKE IT LIQUID. A circle grown from a point is a dial;
    // a circle with things moving under its skin is a substance.
    float roll = t * uSpin;
    float thrown = k * uWobble;
    for (int i = 0; i < 7; i++) {
      if (float(i) >= uLobes) break;
      // The even slot plus a fixed per-lobe offset, hashed off the index so the
      // drop is the same drop every frame and every run. Without the offset the
      // lobes sit on a perfect polygon, and an even spray is the one
      // arrangement a liquid never makes.
      float a = roll + 6.2831853 * float(i) / max(uLobes, 1.0)
              + sin(float(i) * 12.9898) * 0.4;
      float b = 1.0 + uBreathe * sin(t * 1.7 + float(i) * 2.399);
      // TRAPPED BY THE SKIN. The lobe is walked back inside the body before it
      // is drawn, so a dent in the ball is a dent in the mass and nothing ever
      // pokes out through the rim.
      vec2 lp = posHold(at + vec2(sin(a), cos(a)) * (thrown * b), 0.95);
      float lr = k * uLobeSize * b;
      vec2 q = d - lp;
      float u = dot(q, q) / max(lr * lr, 1e-6);
      if (u < 1.0) { float f = 1.0 - u; dens += f * f * f; }
    }
    // One threshold over the summed field, the same shape the body itself uses
    // — which is why the two read as the same substance.
    float kk = smoothstep(0.22, 0.5, dens);
    // ...and the ends are absolute. Nothing of B at a share of 0, and ALL of it
    // at 1: a ball one team owns outright has to be that team's colour and not
    // a colour with a lobe missing out of it.
    return mix(0.0, mix(kk, 1.0, smoothstep(0.9, 1.0, sh)), step(0.0001, sh));
  }
`;
