import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { feedbackState } from './feedback.js';
import { suffocationPixelSize } from './oxygenFx.js';

// Three passes, no EffectComposer:
//   1. render the scene at full res
//   2. bright-pass + ping-pong gaussian blur at half res -> the glow layer
//   3. one final shader: composite scene + glow, then everything in
//      CONFIG.postPresets (CRT/VHS/etc) on top of the combined result
//
// This is deliberately an LDR (8-bit) bloom, not a physically-based HDR one —
// thresholding straight off the normal 0..1 rendered image is exactly how
// simple screen-space glow worked on 2000s-era hardware, and it's plenty for
// a stylized neon look without needing float render targets.

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

  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  vec2 curveUv(vec2 uv) {
    uv = uv * 2.0 - 1.0;
    vec2 offset = abs(uv.yx) / vec2(6.0, 4.0);
    uv += uv * offset * offset * uCurve;
    return uv * 0.5 + 0.5;
  }

  void main() {
    vec2 uv = vUv;

    if (uCurve > 0.0) uv = curveUv(uv);

    if (uJitter > 0.0) {
      float line = floor(uv.y * max(uScanCount, 1.0));
      uv.x += (hash(vec2(line, floor(uTime * 20.0))) - 0.5) * uJitter;
    }

    if (uPixel > 1.0) {
      vec2 blocks = max(uResolution / uPixel, vec2(1.0));
      uv = (floor(uv * blocks) + 0.5) / blocks;
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

    // Neon glow: additive, sampled with the same chroma-split uv so the glow
    // shifts with the rest of the image rather than sitting static on top.
    if (uBloomIntensity > 0.0) {
      color += texture2D(tBloom, uv).rgb * uBloomIntensity;
    }

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

  // Bloom runs at half resolution — cheap, and the blur hides the softness.
  const bloomOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType };
  const bloomA = new THREE.WebGLRenderTarget(1, 1, bloomOpts);
  const bloomB = new THREE.WebGLRenderTarget(1, 1, bloomOpts);

  const camera = new THREE.Camera();

  const brightPass = makeFullscreenPass(brightFragmentShader, { uThreshold: { value: 0.55 } });
  const blurPass = makeFullscreenPass(blurFragmentShader, { uDirection: { value: new THREE.Vector2(1, 0) } });

  const finalUniforms = {
    tDiffuse: { value: sceneTarget.texture },
    tBloom: { value: bloomA.texture },
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

  function resize() {
    const w = Math.max(1, Math.floor(renderer.domElement.width));
    const h = Math.max(1, Math.floor(renderer.domElement.height));
    sceneTarget.setSize(w, h);
    const bw = Math.max(1, Math.floor(w / 2));
    const bh = Math.max(1, Math.floor(h / 2));
    bloomA.setSize(bw, bh);
    bloomB.setSize(bw, bh);
    finalUniforms.uResolution.value.set(w, h);
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
    const postActive = CONFIG.post.enabled || CONFIG.bloom.enabled || suffocation > 1;
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

    renderer.setRenderTarget(sceneTarget);
    renderer.clear();
    renderer.render(sceneToRender, sceneCamera);

    if (CONFIG.bloom.enabled) {
      const bloomResult = renderBloom();
      finalUniforms.tBloom.value = bloomResult.texture;
      // Impact pulses temporarily push the glow brighter, on top of the
      // steady base intensity from the slider.
      finalUniforms.uBloomIntensity.value = CONFIG.bloom.intensity * (1 + feedbackState.glowPulse * CONFIG.bloom.pulseStrength);
    } else {
      finalUniforms.uBloomIntensity.value = 0;
    }

    renderer.setRenderTarget(null);
    renderer.render(finalPass.scene, camera);
  }

  applyPreset(CONFIG.post.preset);
  resize();

  return { render, resize, cyclePreset, applyPreset };
}
