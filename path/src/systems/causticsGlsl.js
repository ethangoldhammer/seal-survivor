// THE CAUSTIC FIELD, as one GLSL function, in one file.
//
// It used to live inline in the water's fragment shader, which was right while
// the water was the only thing that had any. It is not any more: the seal's wet
// film samples the same veins so the dapple crawls over the animal as it swims
// through it (systems/noiseShader.js, CONFIG.sealShader.wetCaustics).
//
// WHY A SHARED STRING RATHER THAN TWO COPIES. The two sample it at the same
// world coordinates and the same time on purpose — a vein that crosses the
// water behind the seal has to be the vein that crosses the seal. Two copies of
// three sine terms would agree on the day they were written and then drift the
// first time anyone retuned one of the six constants, and the failure is not an
// error of any kind: it is a seal wearing a dapple that has nothing to do with
// the water it is in, which reads as the effect being fake without ever
// pointing at why.
//
// No imports on purpose — every Node harness that reaches systems/noiseShader.js
// now pulls this in, and it must not drag arena/daylight along behind it.

// Three interfering sine waves — a cheap, seamless stand-in for real caustic
// ray-tracing. Cubing sharpens the bright veins.
//
// `p` is WORLD xy already multiplied by the scale, and `t` is already multiplied
// by the speed, so both callers do that arithmetic on their own side and this
// function has no opinion about either.
export const CAUSTICS_GLSL = /* glsl */ `
  float caustics(vec2 p, float t) {
    float c = 0.0;
    c += sin(p.x * 1.3 + p.y * 0.7 + t);
    c += sin(p.x * -0.9 + p.y * 1.4 - t * 1.3);
    c += sin(p.x * 0.5 - p.y * 1.1 + t * 0.7);
    c = c / 3.0;
    return pow(max(c, 0.0), 3.0);
  }
`;
