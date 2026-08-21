// ============================================================================
// THE WISP — one GLSL noise function, in one file, for exactly the same reason
// causticsGlsl.js is one file.
//
// A shaft of light in water is not a clean band with soft edges. It is a band
// that is being EATEN — thinned in places, torn open in others, drifting — by
// the silt and the surface chop between it and the sun. Every beam in this game
// that wants to read as light rather than as a gradient needs that, and there
// are now two of them: the shaft standing in the water (systems/water.js) and
// the light it puts on a gravestone (systems/graveBeam.js).
//
// WHY A SHARED STRING RATHER THAN TWO COPIES, and it is the whole argument for
// this file existing. Those two are THE SAME BEAM seen twice — the shaft is the
// water lit up, the band is what that light lands on. They are sampled at the
// same world coordinates and the same time, so a wisp that thins the shaft
// thins the stone under it on the same frame. Two copies of a noise function
// would agree on the day they were written and drift the first time anybody
// retuned one, and the failure is not an error of any kind: it is a stone lit
// by a beam that is demonstrably somewhere else, which reads as the light being
// fake without ever pointing at why.
//
// VALUE NOISE AND NOT A GRADIENT NOISE. Two reasons, and the second is the one
// that decides it: value noise is four hashes and three mixes, where simplex is
// a permutation table and a dozen more lines in a shader that is already
// injected into somebody else's; and the artefact value noise is criticised for
// — a faint axis-aligned grid — is invisible once the field is being sampled
// through a smoothstep band at an angle, which is the only way either caller
// uses it.
//
// NO DERIVATIVES ANYWHERE. fwidth is unreachable from an injected shader on
// GLSL ES 1.00 (see the note in systems/graveBeam.js), so nothing here may want
// one. Everything below is arithmetic.
//
// No imports, on purpose: the same rule causticsGlsl.js follows. Every harness
// that reaches a caller of this pulls it in, and it must not drag config or
// arena along behind it.
// ============================================================================

/**
 * `p` is a world coordinate the caller has already scaled, and `t` is a time
 * the caller has already multiplied by its own speed — so this function has no
 * opinion about either, exactly like caustics().
 *
 * `wisp` returns roughly 0..1 with the mass around the middle. It is a
 * MULTIPLIER, not a light: a caller uses it to eat into something it already
 * has, which is why there is no contrast or gain baked in here. Shaping belongs
 * to whoever is being eaten.
 */
export const WISP_GLSL = /* glsl */ `
  float wispHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float wispNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    // Hermite rather than a linear blend. A linear one leaves visible creases
    // along every cell boundary, and on a beam those creases read as straight
    // scratches down the shaft — the exact opposite of organic.
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = wispHash(i);
    float b = wispHash(i + vec2(1.0, 0.0));
    float c = wispHash(i + vec2(0.0, 1.0));
    float d = wispHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // Three octaves. Two is a blob and four is a texture — three is the range
  // where the field still has big slow shapes AND an edge fine enough to tear.
  // The 1.7 lacunarity is deliberately not 2.0: octaves at exact powers of two
  // line their cell grids up on top of each other, which puts the grid artefact
  // back that the Hermite blend above just removed.
  //
  // The time term slides the octaves against each other rather than moving the
  // whole field together. A field that translates as one is a photograph being
  // panned; one whose layers move at different speeds is something alive in
  // water, and it costs two multiplies.
  //
  // NO BACKTICKS ANYWHERE IN THIS STRING. One inside a shader comment ends the
  // template literal, and the syntax error it produces points at the comment
  // rather than at the backtick.
  float wisp(vec2 p, float t) {
    float sum = 0.0;
    float amp = 0.5;
    vec2 q = p;
    for (int i = 0; i < 3; i++) {
      sum += wispNoise(q + vec2(t * (0.6 + float(i) * 0.35), t * -0.2)) * amp;
      q *= 1.7;
      amp *= 0.55;
    }
    // The octave amplitudes sum to 0.5 + 0.275 + 0.151 = 0.926, so this lands
    // near 0..1 without a normalise term nobody would ever check.
    return sum;
  }
`;
