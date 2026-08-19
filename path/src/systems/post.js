import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { FILTER_OPTIONS, bloomEnabled, setSetting, screenFilter } from './settings.js';
import { feedbackState } from './feedback.js';
import { suffocationPixelSize } from './oxygenFx.js';
import { cineLens } from './cineCamera.js';
import { gooLayer, activeGooGroups, gooGroupInfo, setGooDivisor } from '../entities/particles.js';

// Three passes, no EffectComposer:
//   1. render the scene at full res
//   2. bright-pass + ping-pong gaussian blur at half res -> the glow layer
//   3. one final shader: composite scene + glow, then everything in
//      CONFIG.postPresets (CRT/VHS/etc) on top of the combined result
//
// The bright-pass is a simple screen-space threshold, in the spirit of
// 2000s-era glow rather than a physically-based HDR pipeline — but it does
// read from a HalfFloat target, NOT an 8-bit one. That distinction is
// load-bearing and this comment used to deny it: because the scene target is
// float, a colour driven past 1.0 survives to the threshold instead of
// clamping on the way in, which is the entire mechanism behind every
// "overdrive" control in the game (particle glow, unlit asset glow,
// biolumSkin strength). On an 8-bit target 1.0 and 5.0 would be the same
// pixel and all of those sliders would stop above 1. See createPost.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const brightFragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float m = smoothstep(uThreshold, uThreshold + 0.25, lum);
    gl_FragColor = vec4(c * m, 1.0);
  }
`;

// Standard 5-tap linear-sampled gaussian (9-tap quality for 5 samples).
const blurFragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uDirection;
  varying vec2 vUv;
  void main() {
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
    sum += texture2D(tDiffuse, vUv + uDirection * 1.384615).rgb * 0.316216;
    sum += texture2D(tDiffuse, vUv - uDirection * 1.384615).rgb * 0.316216;
    sum += texture2D(tDiffuse, vUv + uDirection * 3.230769).rgb * 0.070270;
    sum += texture2D(tDiffuse, vUv - uDirection * 3.230769).rgb * 0.070270;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform sampler2D tDefocus;
  uniform float uBloomIntensity;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uPixel;
  uniform float uCurve;
  uniform float uScan;
  uniform float uScanCount;
  uniform float uChroma;
  uniform float uNoise;
  uniform float uPosterize;
  uniform float uVignette;
  uniform float uMask;
  uniform float uJitter;
  uniform float uBleed;

  // --- the cinematic lens ---------------------------------------------------
  // All three are gated to zero when the cinematic camera is off, and the
  // branches below are uniform-controlled, so the fixed-frame path pays for a
  // handful of comparisons and nothing else.
  uniform float uDefocus;      // tilt-shift: how much blur the edges take
  uniform vec2  uFocusUv;      // ...centred here — the seal, not the frame
  uniform float uFocusRadius;
  uniform float uFocusFeather;
  // The dash corridor. uPathDir is a WORLD-space direction and is used
  // directly in aspect-corrected uv, which is exact rather than lucky: the
  // ortho frustum is (h*aspect) wide by h tall, so a world vector (dx, dy)
  // becomes (dx/(h*aspect), dy/h) in uv, and multiplying x back by aspect to
  // correct it lands on (dx/h, dy/h) — the same vector, uniformly scaled.
  uniform float uPathAmount;
  uniform vec2  uPathDir;
  uniform float uPathLength;
  uniform float uPathWidth;
  uniform float uPathFeather;
  uniform float uPathVignette;
  uniform float uKnee;

  uniform float uFlare;
  uniform float uFlareSpacing;
  uniform float uFlareHalo;
  uniform float uFlareStreak;
  uniform float uFlareStreakGain;
  uniform float uDrops;        // 0..1, decays after a breach
  uniform float uDropDensity;
  uniform float uDropSize;
  uniform float uDropRefract;
  uniform float uDropSpec;
  uniform float uDropSlide;
  uniform float uDropStretch;
  uniform float uDropTaper;

  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float aspectOf() {
    return uResolution.x / max(uResolution.y, 1.0);
  }

  // How far outside the dash corridor a pixel is, 0 inside and 1 well clear.
  // The corridor is a capsule: the segment from the seal out along the dash
  // direction, thickened by uPathWidth. A capsule rather than a cone because
  // the near end has to stay the same width as the rest — taper it and the
  // lane pinches shut exactly where the seal is standing, which is the one
  // place it must not.
  float pathMask(vec2 uv) {
    if (uPathAmount <= 0.001 || uPathLength <= 0.0) return 1.0;
    vec2 a = vec2(aspectOf(), 1.0);
    vec2 p = (uv - uFocusUv) * a;
    vec2 d = uPathDir * uPathLength;
    float t = clamp(dot(p, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
    float dist = length(p - d * t);
    return smoothstep(uPathWidth, uPathWidth + uPathFeather, dist);
  }

  vec2 curveUv(vec2 uv) {
    uv = uv * 2.0 - 1.0;
    vec2 offset = abs(uv.yx) / vec2(6.0, 4.0);
    uv += uv * offset * offset * uCurve;
    return uv * 0.5 + 0.5;
  }

  // Water running down the glass after the seal breaks the surface.
  //
  // One drop per cell of a square grid in aspect-corrected screen space —
  // cheap enough to be free, and with the cell jitter below it doesn't read as
  // a grid. Each drop holds a fixed random threshold and is alive only while
  // uDrops is above it, so drying up removes them one at a time in a stable
  // random order rather than fading them all out together, which looks like a
  // dissolve rather than like evaporation.
  //
  // A drop is not a sphere. Three things deform it, all keyed off its own age:
  //
  //   RUN. It accelerates downward — the travel goes as age squared, so a
  //     fresh bead barely creeps and one that has been on the glass a while is
  //     visibly falling. Travel is measured in CELL HEIGHTS and is allowed to
  //     exceed one, which is why the caller evaluates the cell above as well:
  //     a drop that has run out of the bottom of its own cell has to keep
  //     existing in the next one down or it would blink out mid-fall.
  //   STRETCH. Elongated vertically in proportion to how fast it is going,
  //     because that is what surface tension does to a moving bead and it is
  //     most of what separates "running water" from "a circle sliding".
  //   TAPER. The trailing half — the part ABOVE the centre — is narrowed to a
  //     tail, so the silhouette is a teardrop with the fat end leading.
  //
  // And it does not shrink toward its own middle as it dries, which reads as
  // fading out in place. It DRAINS: the bottom edge is pinned and the top edge
  // descends onto it, so the last thing left is a flat smear on the glass
  // rather than a tiny perfect sphere.
  //
  // @param local  position within THIS drop's cell. The caller passes f for
  //               the drop that lives here and f - (0,1) for the one overhead,
  //               whose run may have carried it down into view.
  // Returns (refract.xy, specular, coverage).
  vec4 dropAt(vec2 cell, vec2 local) {
    float alive = hash(cell + 11.3);
    if (alive > uDrops) return vec4(0.0);

    // How far into its own life this particular drop is: the ones with a low
    // threshold survive longest, so age has to be measured against the drop's
    // own threshold rather than off a shared clock.
    float life = clamp((uDrops - alive) / max(0.0001, 1.0 - alive), 0.0, 1.0);
    float age = 1.0 - life;

    float rx = hash(cell + 3.7);
    float ry = hash(cell + 7.1);
    float rs = hash(cell + 5.9);
    float rv = hash(cell + 2.3); // this drop's own weight — how fast it runs

    // Accelerating fall. age * age rather than age: a drop that starts moving
    // at a constant rate reads as a scroll, not as something coming loose.
    float run = uDropSlide * (0.35 + 0.95 * rv) * age * age;

    vec2 centre = vec2(0.15 + rx * 0.7, 0.2 + ry * 0.6 - run);
    float rad = uDropSize * (0.45 + 0.55 * rs);
    if (rad < 0.0001) return vec4(0.0);

    // Speed is d(run)/d(age), which is proportional to age — so the stretch
    // grows with the fall for free rather than needing its own curve.
    float stretch = 1.0 + uDropStretch * (0.4 + 0.6 * rv) * age;

    vec2 q = (local - centre) / vec2(rad, rad * stretch);

    // Drain from the top down. Remap so the shape occupies [-1, top] in q.y
    // and still tests against a unit circle: q.y = -1 is untouched (the bottom
    // stays exactly where it is) and q.y = top maps to +1.
    float top = mix(-0.85, 1.0, life);
    float hgt = max(0.06, 0.5 * (top + 1.0));
    q.y = (q.y + 1.0) / hgt - 1.0;
    // A little of the drain comes off the sides too. Height alone leaves the
    // last remnant a full-width horizontal dash, which reads as a scratch on
    // the glass rather than as water; taking a quarter of the width with it
    // keeps the remnant a bead. Still bottom-anchored — this narrows the drop,
    // it does not pull it in toward its own centre.
    q.x /= mix(0.75, 1.0, life);

    // The tail. Dividing x by a number below 1 pushes the radius test outward,
    // so the shape is NARROWER wherever the taper bites — and it only bites
    // above the centre, leaving the leading edge full width.
    float taper = 1.0 - uDropTaper * clamp(q.y, 0.0, 1.0);
    q.x /= max(0.15, taper);

    float r = length(q);
    if (r >= 1.0) return vec4(0.0);

    // A bead sitting on the glass: the surface normal at radius r, with the
    // rim softened so a drop has an edge rather than a hard cut. The vertical
    // component is divided back down by the stretch — a long drop is a gentler
    // slope along its length, so it must not bend the image as hard there as a
    // round one does.
    vec2 n = vec2(q.x, q.y / max(1.0, stretch));
    float h = sqrt(max(0.0, 1.0 - r * r));
    float edge = smoothstep(1.0, 0.72, r);
    float spec = pow(max(0.0, dot(normalize(vec3(n, h)), normalize(vec3(-0.4, 0.6, 0.7)))), 24.0);
    // Aspect-corrected on the way out: the refraction is applied to uv, where
    // one unit of x covers more screen than one unit of y, and left uncorrected
    // a bead bends the picture sideways harder than it does vertically.
    return vec4(-vec2(n.x / aspectOf(), n.y) * uDropRefract * edge, spec * uDropSpec * edge, edge);
  }

  vec3 droplets(vec2 uv) {
    vec2 p = uv * uDropDensity * vec2(aspectOf(), 1.0);
    vec2 cell = floor(p);
    vec2 f = fract(p);

    // This cell's drop, and the one overhead that may have run down into it.
    // Strongest coverage wins rather than the two summing — where a falling
    // drop overlaps a stationary one, adding both refractions bends the image
    // twice as hard and puts a dark knot on the glass.
    vec4 a = dropAt(cell, f);
    vec4 b = dropAt(cell + vec2(0.0, 1.0), f - vec2(0.0, 1.0));
    return (b.w > a.w ? b : a).xyz;
  }

  // Lens flares, derived from the bloom buffer rather than from an authored
  // rig — so an explosion, a glowing orca patch or the sun on the water all
  // throw one automatically, and nothing has to be tagged as a flare source.
  //
  // Ghosts are the classic trick: reflections inside a lens land mirrored
  // through the optical centre, so sampling the bright buffer along the line
  // from a pixel through the middle of the frame finds whatever would have
  // bounced onto it.
  vec3 lensFlare(vec2 uv) {
    vec2 toCentre = vec2(0.5) - uv;
    vec3 sum = vec3(0.0);

    for (int i = 1; i <= 3; i++) {
      vec2 g = uv + toCentre * (2.0 * float(i) * uFlareSpacing);
      // Ghosts fade toward the edge of frame — an untapered one parks a bright
      // blob in the corner and sits there.
      float w = 1.0 - clamp(length(g - 0.5) * 1.6, 0.0, 1.0);
      vec3 tint = vec3(1.0, 0.75, 0.55);
      if (i == 2) tint = vec3(0.55, 0.85, 1.0);
      else if (i == 3) tint = vec3(0.7, 1.0, 0.8);
      sum += texture2D(tBloom, clamp(g, 0.0, 1.0)).rgb * w * tint;
    }

    float len = length(toCentre);
    if (len > 0.0001) {
      vec2 halo = uv + (toCentre / len) * uFlareHalo;
      sum += texture2D(tBloom, clamp(halo, 0.0, 1.0)).rgb * 0.6 * vec3(0.6, 0.8, 1.0);
    }

    // The anamorphic smear — a horizontal blue streak off anything bright.
    vec3 streak = vec3(0.0);
    for (int i = -4; i <= 4; i++) {
      streak += texture2D(tBloom, clamp(uv + vec2(float(i) * uFlareStreak, 0.0), 0.0, 1.0)).rgb;
    }
    sum += streak * (1.0 / 9.0) * uFlareStreakGain * vec3(0.35, 0.65, 1.0);

    return sum * uFlare;
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);

    if (uCurve > 0.0) uv = curveUv(uv);

    if (uJitter > 0.0) {
      float line = floor(uv.y * max(uScanCount, 1.0));
      uv.x += (hash(vec2(line, floor(uTime * 20.0))) - 0.5) * uJitter;
    }

    if (uPixel > 1.0) {
      vec2 blocks = max(uResolution / uPixel, vec2(1.0));
      uv = (floor(uv * blocks) + 0.5) / blocks;
    }

    // Droplets bend what is BEHIND them, so the refraction has to go into the
    // uv before anything is sampled — added last, as a colour, it would just
    // be circles painted over the picture. The specular is held back for
    // after the composite, where it can sit on top of the finished frame.
    float dropSpec = 0.0;
    if (uDrops > 0.0) {
      vec3 drop = droplets(uv);
      uv += drop.xy;
      dropSpec = drop.z;
    }

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    vec2 texel = 1.0 / uResolution;

    vec3 color;
    color.r = texture2D(tDiffuse, uv + vec2(uChroma, 0.0) * texel).r;
    color.g = texture2D(tDiffuse, uv).g;
    color.b = texture2D(tDiffuse, uv - vec2(uChroma, 0.0) * texel).b;

    // Tilt shift. Mixed in BEFORE the glow, because a defocused image is what
    // the lens delivers to the sensor and the bloom is what the sensor does
    // with it — adding the glow first and then blurring the sum would smear
    // the halo of a sharp object across a soft background.
    //
    // The distance is aspect-corrected, so the sharp region is a circle on
    // screen rather than an ellipse that stretches with the window.
    float lane = pathMask(uv);
    if (uDefocus > 0.0) {
      vec2 fd = (uv - uFocusUv) * vec2(aspect, 1.0);
      float m = smoothstep(uFocusRadius, uFocusRadius + uFocusFeather, length(fd));
      // UNION of the two sharp regions, by taking whichever says "sharper".
      // Mixing or averaging them would soften the seal every time the corridor
      // lit up, which is backwards — the corridor exists to add a sharp place,
      // never to take one away. Scaled by uPathAmount so a corridor blending
      // in cannot snap a lane into focus faster than the state behind it.
      float widened = mix(m, min(m, lane), uPathAmount);
      color = mix(color, texture2D(tDefocus, uv).rgb, widened * uDefocus);
    }

    // Neon glow: additive, sampled with the same chroma-split uv so the glow
    // shifts with the rest of the image rather than sitting static on top.
    if (uBloomIntensity > 0.0) {
      color += texture2D(tBloom, uv).rgb * uBloomIntensity;
    }

    if (uFlare > 0.0) color += lensFlare(uv);
    if (dropSpec > 0.0) color += vec3(dropSpec) * vec3(0.8, 0.92, 1.0);

    if (uBleed > 0.0) {
      vec3 left1 = texture2D(tDiffuse, uv - vec2(texel.x * 2.0, 0.0)).rgb;
      vec3 left2 = texture2D(tDiffuse, uv - vec2(texel.x * 4.0, 0.0)).rgb;
      color = mix(color, (color + left1 * 0.6 + left2 * 0.3) / 1.9, uBleed);
    }

    if (uPosterize > 1.0) {
      color = floor(color * uPosterize + 0.5) / uPosterize;
    }

    if (uScan > 0.0) {
      float s = sin(uv.y * uScanCount * 3.14159265);
      color *= 1.0 - uScan * s * s;
    }

    if (uMask > 0.0) {
      float col = mod(gl_FragCoord.x, 3.0);
      vec3 tint = vec3(0.85, 0.85, 1.15);
      if (col < 1.0) tint = vec3(1.15, 0.85, 0.85);
      else if (col < 2.0) tint = vec3(0.85, 1.15, 0.85);
      color *= mix(vec3(1.0), tint, uMask);
    }

    if (uNoise > 0.0) {
      color += (hash(uv * uResolution + uTime * 60.0) - 0.5) * uNoise;
    }

    if (uVignette > 0.0) {
      vec2 d = uv - 0.5;
      color *= 1.0 - uVignette * dot(d, d) * 2.2;
    }

    // The corridor's own vignette, on top of the radial one and shaped by the
    // dash line rather than by the frame. This is the half that does the
    // HIGHLIGHTING — a sharp lane through a soft picture is easy to miss, but
    // a sharp lane that is also the only bright thing on screen is not.
    if (uPathVignette > 0.0) {
      color *= 1.0 - uPathVignette * lane;
    }

    // ------------------------------------------------------------------
    // SOFT SHOULDER — the last thing that happens, so nothing downstream can
    // push a channel back over 1.
    //
    // The scene target is HalfFloat and the overdrive sliders deliberately
    // drive colours past 1 (see the note at the top). That survives all the
    // way to here, and then this write goes to an 8-bit framebuffer where each
    // channel truncates INDEPENDENTLY. A warm (6.96, 6.58, 4.59) does not
    // become a brighter amber, it becomes (1,1,1) — flat white with the hue
    // gone, and every value above it looks identical.
    //
    // NORMALISED ON THE PEAK CHANNEL, NOT ON LUMINANCE, which is the one part
    // of this worth arguing about. Luminance is the obvious choice and it does
    // not work: blue carries a Rec.709 weight of 0.0722, so a saturated blue
    // at (0, 0, 3) has a luminance of 0.22, sails under any sensible knee
    // untouched, and clips its blue channel anyway. The peak channel is what
    // actually decides whether anything truncates.
    //
    // All three channels are then scaled by ONE factor, so hue and saturation
    // are exactly preserved — the colour dims toward the knee instead of
    // sliding toward white. Compressing per channel would fix the clipping and
    // still wash the colour out, which is the thing being fixed.
    //
    // The curve is identity below the knee and asymptotic to 1 above it, and
    // it is C1 continuous at the join (the exponential's slope there is
    // exactly 1), so there is no visible seam where it engages.
    if (uKnee > 0.0) {
      float peak = max(color.r, max(color.g, color.b));
      if (peak > uKnee) {
        float range = max(1e-4, 1.0 - uKnee);
        float rolled = uKnee + range * (1.0 - exp(-(peak - uKnee) / range));
        color *= rolled / peak;
      }
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

// --- the goo surface --------------------------------------------------------
// Reads the density field that entities/particles.js splatted (see the goo note
// there) and finds its isoline. Everything below the line is not there at all;
// everything above it is liquid. That single threshold is what fuses separate
// particles into one body — nothing here knows there were ever particles.
//
// The extra shading is what stops the result reading as a flat sticker. A fake
// normal is taken from the GRADIENT of the density field — the field falls off
// fastest at the surface, so its gradient points out of the goo, which is a
// normal in everything but name — and that drives a specular highlight. The rim
// term brightens the band just inside the edge, which is where a thick liquid
// concentrates the light it is carrying. Four extra taps for both.
//
// Sampled with explicit texel offsets rather than dFdx/dFdy: derivatives are an
// extension in GLSL ES 1.00 and this shader has no business caring which one
// it compiled under.
const gooFragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uIso;       // density at the surface
  uniform float uSoft;      // half-width of the transition, in density
  uniform float uOpacity;
  uniform float uRim;
  uniform float uRimWidth;
  uniform float uSpec;
  uniform float uSpecPower;
  uniform float uNormal;    // how much the density gradient bends the normal
  uniform vec2 uLight;
  varying vec2 vUv;

  void main() {
    vec4 s = texture2D(tDiffuse, vUv);
    float dens = s.a;
    float a = smoothstep(uIso - uSoft, uIso + uSoft, dens);
    // The field is empty over most of the screen on most frames. Bailing here
    // is most of what makes this pass cheap.
    if (a <= 0.002) discard;

    // Back out of the premultiplied accumulation. Where two bursts overlap this
    // is a density-weighted average of their tints, so the weld between them
    // is a blend rather than whichever one drew last.
    vec3 col = s.rgb / max(dens, 1e-4);

    float dl = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).a;
    float dr = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).a;
    float dd = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).a;
    float du = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).a;
    vec3 n = normalize(vec3(-(dr - dl) * uNormal, -(du - dd) * uNormal, 1.0));
    vec3 l = normalize(vec3(uLight, 0.8));
    float spec = pow(max(dot(n, l), 0.0), uSpecPower) * uSpec;

    // A band that is 1 at the isoline and 0 once the goo is properly thick.
    float rim = (1.0 - smoothstep(uIso, uIso + uRimWidth, dens)) * uRim;

    vec3 lit = col * (1.0 + rim) + spec * mix(vec3(1.0), col, 0.35);
    gl_FragColor = vec4(lit, a * uOpacity);
  }
`;

function makeFullscreenPass(fragShader, extraUniforms) {
  const uniforms = { tDiffuse: { value: null }, ...extraUniforms };
  const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader: fragShader, uniforms, depthTest: false, depthWrite: false });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  return { scene, material, uniforms };
}

export function createPost(renderer) {
  // HalfFloat, not the usual 8-bit target: an emissive value can genuinely
  // exceed 1.0 here and survive all the way to the bloom bright-pass, instead
  // of clamping to plain white at the moment it's rendered. That's what makes
  // "push emissive way beyond threshold" actually mean something — on an
  // 8-bit target, 1.0 and 5.0 both simply become 1.0 and are indistinguishable
  // by the time bloom ever sees them. The final composite still writes to the
  // ordinary LDR screen, so overdriven pixels blow out to white there, which
  // is exactly the overwhelming look being asked for.
  const sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType,
  });

  // Bloom runs BELOW full resolution — cheap, and the blur hides the softness.
  // How far below is CONFIG.bloom.divisor; see the note there. Every pass in
  // renderBloom pays this twice over, once in fragments and once in the
  // bandwidth of reading a HalfFloat target, so it is the cheapest large win
  // in the whole pipeline.
  const bloomOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType };
  const bloomA = new THREE.WebGLRenderTarget(1, 1, bloomOpts);
  const bloomB = new THREE.WebGLRenderTarget(1, 1, bloomOpts);

  // The tilt-shift's blurred copy of the scene. It cannot share the bloom
  // buffers: those hold a BRIGHT-PASSED image, everything below the threshold
  // already thrown away, so mixing toward them doesn't defocus the picture, it
  // dissolves the picture into its own highlights. Same half-res ping-pong,
  // same blur shader, different source — only the bright pass is skipped.
  const defocusA = new THREE.WebGLRenderTarget(1, 1, bloomOpts);
  const defocusB = new THREE.WebGLRenderTarget(1, 1, bloomOpts);

  // The density field the goo particles splat into. HalfFloat is not optional
  // here: densities SUM, the isoline sits above 1 by design, and on an 8-bit
  // target every overlap would clamp to 1 — which is the same value a single
  // lonely splat reaches, so nothing would ever fuse. Alpha is the field; rgb
  // is the premultiplied tint.
  const gooTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType,
  });

  const camera = new THREE.Camera();

  const brightPass = makeFullscreenPass(brightFragmentShader, { uThreshold: { value: 0.55 } });
  const blurPass = makeFullscreenPass(blurFragmentShader, { uDirection: { value: new THREE.Vector2(1, 0) } });

  const finalUniforms = {
    tDiffuse: { value: sceneTarget.texture },
    tBloom: { value: bloomA.texture },
    tDefocus: { value: defocusA.texture },
    uBloomIntensity: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uPixel: { value: 0 },
    uCurve: { value: 0 },
    uScan: { value: 0 },
    uScanCount: { value: 600 },
    uChroma: { value: 0 },
    uNoise: { value: 0 },
    uPosterize: { value: 0 },
    uVignette: { value: 0 },
    uMask: { value: 0 },
    uJitter: { value: 0 },
    uBleed: { value: 0 },
    uDefocus: { value: 0 },
    uFocusUv: { value: new THREE.Vector2(0.5, 0.5) },
    uFocusRadius: { value: 1 },
    uFocusFeather: { value: 1 },
    uFlare: { value: 0 },
    uFlareSpacing: { value: 0.32 },
    uFlareHalo: { value: 0.42 },
    uFlareStreak: { value: 0.006 },
    uFlareStreakGain: { value: 0.5 },
    uDrops: { value: 0 },
    uDropDensity: { value: 9 },
    uDropSize: { value: 0.34 },
    uDropRefract: { value: 0.05 },
    uDropSpec: { value: 0.5 },
    uDropSlide: { value: 1.15 },
    uDropStretch: { value: 1.7 },
    uDropTaper: { value: 0.55 },
    uPathAmount: { value: 0 },
    uPathDir: { value: new THREE.Vector2(1, 0) },
    uPathLength: { value: 0 },
    uPathWidth: { value: 0.1 },
    uPathFeather: { value: 0.18 },
    uPathVignette: { value: 0 },
    uKnee: { value: 0 },
  };
  const finalPass = makeFullscreenPass(fragmentShader, finalUniforms);

  const gooPass = makeFullscreenPass(gooFragmentShader, {
    uTexel: { value: new THREE.Vector2(1, 1) },
    uIso: { value: 1 },
    uSoft: { value: 0.25 },
    uOpacity: { value: 1 },
    uRim: { value: 0.6 },
    uRimWidth: { value: 0.6 },
    uSpec: { value: 0.5 },
    uSpecPower: { value: 18 },
    uNormal: { value: 6 },
    uLight: { value: new THREE.Vector2(-0.5, 0.8) },
  });
  // Composited over the scene, so it needs to blend — and a ShaderMaterial with
  // `transparent: false` has its blending disabled outright by three, whatever
  // `blending` says. Every other pass here writes to a target it owns and never
  // wanted blending; this is the first one that draws ON TOP of something.
  gooPass.material.transparent = true;
  const gooClearColor = new THREE.Color();

  let clock = 0;

  function applyPreset(name) {
    const preset = CONFIG.postPresets[name] ?? CONFIG.postPresets.off;
    const u = finalUniforms;
    u.uPixel.value = preset.pixel ?? 0;
    u.uCurve.value = preset.curve ?? 0;
    u.uScan.value = preset.scan ?? 0;
    u.uScanCount.value = preset.scanCount ?? 600;
    u.uChroma.value = preset.chroma ?? 0;
    u.uNoise.value = preset.noise ?? 0;
    u.uPosterize.value = preset.posterize ?? 0;
    u.uVignette.value = preset.vignette ?? 0;
    u.uMask.value = preset.mask ?? 0;
    u.uJitter.value = preset.jitter ?? 0;
    u.uBleed.value = preset.bleed ?? 0;
  }

  // Called every frame from the game loop. setSize is a no-op when the numbers
  // haven't moved (three compares before reallocating), which is what lets the
  // divisor below be a live tuner slider rather than a reload-only setting.
  function resize() {
    const w = Math.max(1, Math.floor(renderer.domElement.width));
    const h = Math.max(1, Math.floor(renderer.domElement.height));
    sceneTarget.setSize(w, h);
    // Clamped to 2 at the low end: the bright-pass reads the full-res scene, so
    // a divisor of 1 would run the whole ping-pong at full resolution for a
    // buffer nobody ever sees sharp.
    const div = Math.max(2, Math.round(CONFIG.bloom.divisor ?? 4));
    const bw = Math.max(1, Math.floor(w / div));
    const bh = Math.max(1, Math.floor(h / div));
    bloomA.setSize(bw, bh);
    bloomB.setSize(bw, bh);
    // The tilt-shift stays at HALF whatever the bloom does. It is mixed into
    // the picture directly rather than added as a halo, so its resolution is
    // visible in a way the glow's is not — a quarter-res defocus reads as a
    // low-res copy of the scene fading in at the edges of frame.
    const dw = Math.max(1, Math.floor(w / 2));
    const dh = Math.max(1, Math.floor(h / 2));
    defocusA.setSize(dw, dh);
    defocusB.setSize(dw, dh);
    finalUniforms.uResolution.value.set(w, h);

    // The goo runs below full res too, and unlike the bloom that is not purely
    // a saving: the threshold is evaluated on a bilinear upsample of the field,
    // so the divisor is also the SOFTNESS of the surface. At 2 the edge wobbles
    // just enough to read as surface tension; much coarser and it reads as a
    // low-resolution image of goo.
    const gdiv = Math.max(1, Math.round(CONFIG.fx?.goo?.divisor ?? 2));
    const gw = Math.max(1, Math.floor(w / gdiv));
    const gh = Math.max(1, Math.floor(h / gdiv));
    gooTarget.setSize(gw, gh);
    gooPass.uniforms.uTexel.value.set(1 / gw, 1 / gh);
    setGooDivisor(gdiv);
  }

  // Push the cinematic camera's published lens into the composite. Everything
  // is written every frame, zeros included, for the same reason updatePunch
  // writes its zoom unconditionally: switching the camera off mid-blend has to
  // clear the lens, not leave it frozen at whatever it was.
  function applyCineLens() {
    const u = finalUniforms;
    const c = CONFIG.cinecam ?? {};
    if (!c.enabled || !cineLens.active) {
      u.uDefocus.value = 0;
      u.uFlare.value = 0;
      u.uDrops.value = 0;
      u.uPathAmount.value = 0;
      u.uPathVignette.value = 0;
      return;
    }
    const lens = c.lens ?? {};
    u.uDefocus.value = cineLens.defocus;
    u.uFocusUv.value.set(cineLens.focusX, cineLens.focusY);
    u.uFocusRadius.value = cineLens.focusRadius;
    u.uFocusFeather.value = cineLens.focusFeather;

    u.uFlare.value = cineLens.flare;
    const f = lens.flare ?? {};
    u.uFlareSpacing.value = f.spacing ?? 0.32;
    u.uFlareHalo.value = f.halo ?? 0.42;
    u.uFlareStreak.value = f.streak ?? 0.006;
    u.uFlareStreakGain.value = f.streakGain ?? 0.5;

    const d = lens.droplets ?? {};
    u.uDrops.value = (d.enabled ?? true) ? cineLens.droplets : 0;
    u.uDropDensity.value = d.density ?? 9;
    u.uDropSize.value = d.size ?? 0.34;
    u.uDropRefract.value = d.refract ?? 0.05;
    u.uDropSpec.value = d.spec ?? 0.5;
    u.uDropSlide.value = d.slide ?? 1.15;
    u.uDropStretch.value = d.stretch ?? 1.7;
    u.uDropTaper.value = d.taper ?? 0.55;

    u.uPathAmount.value = cineLens.pathAmount;
    u.uPathDir.value.set(cineLens.pathDirX, cineLens.pathDirY);
    u.uPathLength.value = cineLens.pathLength;
    u.uPathWidth.value = cineLens.pathWidth;
    u.uPathFeather.value = cineLens.pathFeather;
    u.uPathVignette.value = cineLens.pathVignette;

    // Summed onto whatever the CRT/VHS preset asked for rather than replacing
    // it — the preset's vignette is part of that look, and a camera state
    // closing the frame down is a separate claim on the same corner darkening.
    u.uVignette.value = Math.min(1.2, u.uVignette.value + cineLens.vignette);
  }

  // What is actually on screen: the player's pick from the pause menu, or the
  // authored preset when they have never made one. Resolved at every use
  // rather than cached, because both halves can move — the tuner changes the
  // authored value and the Video tab changes the override.
  function activePreset() {
    return screenFilter(CONFIG.post.preset);
  }

  function bloomOn() {
    return bloomEnabled(CONFIG.bloom.enabled);
  }

  // P cycles the filter. It writes the PLAYER'S setting, not CONFIG.post.preset
  // — which is what it used to do, and that was a quiet leak: the tuner
  // snapshots whole CONFIG sections, so idly pressing P and then touching any
  // slider wrote whatever filter you happened to land on into
  // imported-tuning.json as though it were an authoring decision.
  //
  // Cycles the same list the Video tab offers, so the key and the menu can't
  // disagree about what the options are.
  function cyclePreset() {
    const at = FILTER_OPTIONS.indexOf(activePreset());
    const next = FILTER_OPTIONS[(at + 1) % FILTER_OPTIONS.length];
    setSetting('video.filter', next);
    applyPreset(next);
    return next;
  }

  function renderBloom() {
    const bw = bloomA.width, bh = bloomA.height;
    const texel = new THREE.Vector2(1 / bw, 1 / bh);

    // Bright-pass: scene -> bloomA
    brightPass.uniforms.tDiffuse.value = sceneTarget.texture;
    brightPass.uniforms.uThreshold.value = CONFIG.bloom.threshold;
    renderer.setRenderTarget(bloomA);
    renderer.render(brightPass.scene, camera);

    // Ping-pong separable blur, iteration count and step distance both
    // controlled by `radius` — more iterations widens the glow further.
    const iterations = Math.max(1, Math.round(CONFIG.bloom.radius));
    let readTarget = bloomA;
    let writeTarget = bloomB;
    for (let i = 0; i < iterations; i++) {
      blurPass.uniforms.tDiffuse.value = readTarget.texture;
      blurPass.uniforms.uDirection.value.set(texel.x, 0);
      renderer.setRenderTarget(writeTarget);
      renderer.render(blurPass.scene, camera);
      [readTarget, writeTarget] = [writeTarget, readTarget];

      blurPass.uniforms.tDiffuse.value = readTarget.texture;
      blurPass.uniforms.uDirection.value.set(0, texel.y);
      renderer.setRenderTarget(writeTarget);
      renderer.render(blurPass.scene, camera);
      [readTarget, writeTarget] = [writeTarget, readTarget];
    }
    return readTarget;
  }

  // The defocus chain. First pass reads the FULL-res scene into a half-res
  // target, which does the downsample and the first blur in one draw; the rest
  // ping-pong at half res like the bloom does. `radius` is iterations, and
  // each one roughly doubles the apparent blur.
  function renderDefocus() {
    const texel = new THREE.Vector2(1 / defocusA.width, 1 / defocusA.height);
    blurPass.uniforms.tDiffuse.value = sceneTarget.texture;
    blurPass.uniforms.uDirection.value.set(texel.x, 0);
    renderer.setRenderTarget(defocusA);
    renderer.render(blurPass.scene, camera);

    let readTarget = defocusA;
    let writeTarget = defocusB;
    const iterations = Math.max(1, Math.round(CONFIG.cinecam?.lens?.tiltShift?.radius ?? 2));
    for (let i = 0; i < iterations; i++) {
      blurPass.uniforms.tDiffuse.value = readTarget.texture;
      blurPass.uniforms.uDirection.value.set(0, texel.y);
      renderer.setRenderTarget(writeTarget);
      renderer.render(blurPass.scene, camera);
      [readTarget, writeTarget] = [writeTarget, readTarget];

      // The last iteration's horizontal pass is skipped — the first draw above
      // already did one, so running a full H+V here leaves the blur one axis
      // heavier horizontally than vertically at every radius.
      if (i === iterations - 1) break;
      blurPass.uniforms.tDiffuse.value = readTarget.texture;
      blurPass.uniforms.uDirection.value.set(texel.x, 0);
      renderer.setRenderTarget(writeTarget);
      renderer.render(blurPass.scene, camera);
      [readTarget, writeTarget] = [writeTarget, readTarget];
    }
    return readTarget;
  }

  // Splat one goo group into the density target, threshold it, and lay the
  // result over the scene — BEFORE the bright pass, so the goo blooms, gets
  // defocused and takes the screen filter exactly like anything drawn as
  // geometry. Anywhere later in the chain and it would be a sticker on the
  // finished picture.
  //
  // Groups run one after another through the SAME target rather than one target
  // each: the field is cleared, filled, thresholded and composited before the
  // next group touches it, so the memory cost is one buffer no matter how many
  // substances the game grows, and the frame cost is only for the groups that
  // have something alive in them.
  function renderGooGroup(sceneCamera, group) {
    const layer = gooLayer();
    if (!layer) return;
    const g = group.def;

    layer.material.uniforms.uGroup.value = group.index;
    layer.material.uniforms.uGooRadius.value = g.radius ?? 3.2;

    const u = gooPass.uniforms;
    u.uIso.value = g.iso ?? 1;
    u.uSoft.value = Math.max(0.001, g.soft ?? 0.25);
    u.uOpacity.value = g.opacity ?? 1;
    u.uRim.value = g.rim ?? 0;
    u.uRimWidth.value = Math.max(0.001, g.rimWidth ?? 0.6);
    u.uSpec.value = g.spec ?? 0;
    u.uSpecPower.value = Math.max(1, g.specPower ?? 18);
    u.uNormal.value = g.normal ?? 6;
    u.uLight.value.set(g.lightX ?? -0.5, g.lightY ?? 0.8);
    // Additive is the OTHER liquid: alpha reads as a thick opaque body that
    // hides the water behind it, additive as a glowing slick lying in it. Both
    // are one state change, so this is a genuine choice rather than a preset.
    gooPass.material.blending = g.additive ? THREE.AdditiveBlending : THREE.NormalBlending;

    // Cleared explicitly to transparent black rather than trusting the
    // renderer's clear state: this target is a density FIELD, and a clear
    // colour set anywhere else in the game would show up here as a screen-wide
    // sheet of goo sitting just under the isoline.
    renderer.getClearColor(gooClearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(gooTarget);
    renderer.clear();
    renderer.render(layer.scene, sceneCamera);
    // ...and anything else made of this substance, into the same target before
    // the threshold runs. autoClear off, or each field would wipe the splats it
    // is supposed to be fusing with.
    const fieldsHere = [...gooFields].filter((f) => f.group === group.name);
    if (fieldsHere.length) {
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      for (const f of fieldsHere) renderer.render(f.object, sceneCamera);
      renderer.autoClear = auto;
    }
    renderer.setClearColor(gooClearColor, clearAlpha);

    // autoClear off for the composite, or this draw wipes the scene it is
    // supposed to be landing on.
    gooPass.uniforms.tDiffuse.value = gooTarget.texture;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(sceneTarget);
    renderer.render(gooPass.scene, camera);
    renderer.autoClear = autoClear;
  }

  // --- things that are made of goo without being particles -----------------
  //
  // The density field is splatted from dying particles, which is the whole
  // shape of the feature — but a particle burst is not the only thing that can
  // be liquid. The splash menu's buttons are hexagons that want to FUSE with
  // the goo they spit: a droplet leaving one should pull a neck out of its edge
  // rather than fly off in front of it, and no amount of drawing them near each
  // other does that. Fusion is a property of a field, so anything that wants it
  // has to be IN the field.
  //
  // A registered field is any Object3D whose material writes premultiplied
  // density (rgb = tint * density, a = density) additively — exactly what the
  // particle shader writes. It is rendered into the same target, in the same
  // pass, after the particles, so the threshold that finds the isoline cannot
  // tell the two apart. That is the point.
  //
  // The registry also FORCES its group to render: `activeGooGroups` reports
  // only groups with live particles, so a button standing alone would flicker
  // out the instant its last droplet died.
  const gooFields = new Set();

  /** @param group  a key of CONFIG.fx.goo.groups — the substance it is made of. */
  function registerGooField(object, group) {
    gooFields.add({ object, group });
  }

  function unregisterGooField(object) {
    for (const f of gooFields) if (f.object === object) gooFields.delete(f);
  }

  /** The groups that have a registered field, whether or not particles are alive. */
  function fieldGroups() {
    const out = [];
    for (const f of gooFields) {
      if (out.some((g) => g.name === f.group)) continue;
      const info = gooGroupInfo(f.group);
      if (info) out.push(info);
    }
    return out;
  }

  // COMPILE THE GOO PROGRAMS BEFORE THE FIRST KILL, not on it.
  //
  // warmPipeline draws one real frame to compile the passes that only exist
  // inside this file — but the goo pass is skipped on any frame with no goo
  // alive, which is every frame at boot. So the two programs it needs (the
  // density splat and the threshold) were linking on the frame of the first
  // kill of every run: tens of milliseconds on Chrome's ANGLE path, in the
  // middle of a fight, which is precisely the hitch systems/shaderWarmup.js
  // exists to prevent.
  //
  // Drawing it with nothing alive is enough — every point is parked outside the
  // frustum and every fragment of the threshold discards, but both programs
  // link, against the same render targets the real path uses so the cache keys
  // match. Deliberately NOT gated on `fx.goo.enabled`: switching the effect on
  // from the tuner mid-session should not pay for a compile either.
  function warmGoo(sceneCamera) {
    const layer = gooLayer();
    if (!layer) return;
    const groups = CONFIG.fx?.goo?.groups ?? {};
    const first = Object.values(groups)[0] ?? {};
    // Index -1 matches no particle — including the sprite particles, which are
    // group 0 and would otherwise all be splatted into the field by the warm
    // draw. The draw still happens, which is all a link needs.
    renderGooGroup(sceneCamera, { name: 'warm', index: -1, def: first });
  }

  function render(sceneToRender, sceneCamera, dt) {
    clock += dt;
    finalUniforms.uTime.value = clock;
    // The soft shoulder. Read every frame rather than at boot, so dragging it
    // in the tuner is live — and read UNCONDITIONALLY, unlike the cinecam
    // uniforms above, because clipping happens whether or not a lens is
    // active. 0 disables it and restores the old hard clip exactly.
    finalUniforms.uKnee.value = Math.min(0.99, Math.max(0, CONFIG.bloom?.knee ?? 0));

    // Bloom and the CRT/VHS preset system are independent toggles — either
    // can run without the other. Only skip the whole pipeline (a plain
    // passthrough render) when BOTH are off, for zero extra cost.
    //
    // Suffocation counts as a third reason to run: the blackout has to be
    // able to pixelate the screen on its own, or turning the CRT preset off
    // would silently take drowning's only visual with it.
    const suffocation = suffocationPixelSize();
    // A fourth reason to run, and the cinematic camera's lens is the only
    // thing that can claim it — with that camera off, `cineLens.active` is
    // false and this whole clause is a boolean read.
    const cine = CONFIG.cinecam?.enabled && cineLens.active
      && (cineLens.defocus > 0 || cineLens.flare > 0 || cineLens.droplets > 0
          || cineLens.vignette > 0 || cineLens.pathVignette > 0);
    // ...and a fifth: goo in the water. The sprite layer hands those particles
    // over to a pass that only exists inside this pipeline, so taking the
    // passthrough while goo is in flight would not "turn the effect off", it
    // would delete the burst. Zero cost with nothing goopy on screen, which is
    // almost every frame.
    // Live bursts, plus any group a registered field claims — see the registry
    // above. Merged by name so a group with both does not render twice.
    const goo = activeGooGroups();
    for (const g of fieldGroups()) if (!goo.some((x) => x.name === g.name)) goo.push(g);
    const postActive = CONFIG.post.enabled || bloomOn() || suffocation > 1 || cine || goo.length > 0;
    if (!postActive) {
      renderer.setRenderTarget(null);
      renderer.render(sceneToRender, sceneCamera);
      return;
    }

    // 'off' zeroes every screen-filter uniform, so bloom can run completely
    // standalone with no CRT/VHS artifacts riding along when that system
    // itself is toggled off.
    applyPreset(CONFIG.post.enabled ? activePreset() : 'off');

    // Whichever is chunkier wins, rather than adding: vhs and vga already
    // pixelate a little, and summing would mean the blackout hits harder on
    // those presets than on crt for no reason anyone chose.
    if (suffocation > finalUniforms.uPixel.value) finalUniforms.uPixel.value = suffocation;

    // After applyPreset, which rewrites uVignette from the preset every frame
    // and would otherwise stamp on the camera state's contribution.
    applyCineLens();

    renderer.setRenderTarget(sceneTarget);
    renderer.clear();
    renderer.render(sceneToRender, sceneCamera);

    for (const group of goo) renderGooGroup(sceneCamera, group);

    // The flares are sampled from the bloom buffer, so they need it filled
    // even when bloom itself is switched off — the bright pass is what finds
    // the flare sources, and it's the same work either way. Only the additive
    // glow in the composite is gated on `bloom.enabled`.
    const wantBloomBuffer = bloomOn() || finalUniforms.uFlare.value > 0;
    if (wantBloomBuffer) {
      const bloomResult = renderBloom();
      finalUniforms.tBloom.value = bloomResult.texture;
    }
    if (bloomOn()) {
      // Impact pulses temporarily push the glow brighter, on top of the
      // steady base intensity from the slider.
      finalUniforms.uBloomIntensity.value = CONFIG.bloom.intensity * (1 + feedbackState.glowPulse * CONFIG.bloom.pulseStrength);
    } else {
      finalUniforms.uBloomIntensity.value = 0;
    }

    if (finalUniforms.uDefocus.value > 0) {
      finalUniforms.tDefocus.value = renderDefocus().texture;
    }

    renderer.setRenderTarget(null);
    renderer.render(finalPass.scene, camera);
  }

  // Compile programs for `group` exactly as they will be compiled when the game
  // renders them — which means doing it with the scene target BOUND.
  //
  // That binding is the whole reason this lives in post.js rather than in the
  // warm-up system. three folds the current render target's colour space into
  // the program cache key (LinearSRGB for any ordinary target, the renderer's
  // outputColorSpace when the target is null), so a warm-up run against the
  // default framebuffer produces a DIFFERENT key from the one the game asks for
  // a frame later. Every program would be compiled twice: once here, and once
  // again mid-run at exactly the moment the warm-up existed to protect. It
  // fails silently — the warm-up appears to work, takes just as long, and buys
  // nothing.
  //
  // `world.scene` is passed as the target scene so the lights come from the
  // real scene: the light counts are in the cache key too.
  async function warm(group, camera, scene) {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(sceneTarget);
    try {
      await renderer.compileAsync(group, camera, scene);
    } finally {
      renderer.setRenderTarget(previous);
    }
  }

  // Upload one texture to the GPU, off the frame that would otherwise have
  // done it on its first draw.
  //
  // WHY THIS IS HERE AND NOT IN THE WARM-UP. shaderWarmup deliberately does
  // NOT sweep textures — see the long note there: making all 49 megapixels of
  // the roster resident from boot pushes past a phone's budget and turns one
  // stall into a driver that pages for the rest of the session. That reasoning
  // is about the WHOLE roster at boot. It says nothing against uploading one
  // creature's textures three seconds before that creature appears, which is
  // the opposite trade: nothing extra is resident for any longer than it is
  // about to be needed. See systems/bossWarmup.js, the only caller.
  //
  // No render target binding, unlike `warm` — an upload is not keyed on one.
  function initTexture(texture) {
    if (!texture) return false;
    renderer.initTexture(texture);
    return true;
  }

  applyPreset(activePreset());
  resize();

  return {
    registerGooField,
    unregisterGooField,
    render, resize, cyclePreset, applyPreset, warm, warmGoo, initTexture };
}
