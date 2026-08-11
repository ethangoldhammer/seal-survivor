import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { feedbackState } from './feedback.js';
import { suffocationPixelSize } from './oxygenFx.js';
import { cineLens } from './cineCamera.js';

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

    gl_FragColor = vec4(color, 1.0);
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
  };
  const finalPass = makeFullscreenPass(fragmentShader, finalUniforms);

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

  function cyclePreset() {
    const names = Object.keys(CONFIG.postPresets);
    const i = names.indexOf(CONFIG.post.preset);
    CONFIG.post.preset = names[(i + 1) % names.length];
    applyPreset(CONFIG.post.preset);
    return CONFIG.post.preset;
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

  function render(sceneToRender, sceneCamera, dt) {
    clock += dt;
    finalUniforms.uTime.value = clock;

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
    const postActive = CONFIG.post.enabled || CONFIG.bloom.enabled || suffocation > 1 || cine;
    if (!postActive) {
      renderer.setRenderTarget(null);
      renderer.render(sceneToRender, sceneCamera);
      return;
    }

    // 'off' zeroes every screen-filter uniform, so bloom can run completely
    // standalone with no CRT/VHS artifacts riding along when that system
    // itself is toggled off.
    applyPreset(CONFIG.post.enabled ? CONFIG.post.preset : 'off');

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

    // The flares are sampled from the bloom buffer, so they need it filled
    // even when bloom itself is switched off — the bright pass is what finds
    // the flare sources, and it's the same work either way. Only the additive
    // glow in the composite is gated on `bloom.enabled`.
    const wantBloomBuffer = CONFIG.bloom.enabled || finalUniforms.uFlare.value > 0;
    if (wantBloomBuffer) {
      const bloomResult = renderBloom();
      finalUniforms.tBloom.value = bloomResult.texture;
    }
    if (CONFIG.bloom.enabled) {
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

  applyPreset(CONFIG.post.preset);
  resize();

  return { render, resize, cyclePreset, applyPreset, warm };
}
