import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, WAVE } from '../arena.js';
import { skyLight } from './daylight.js';

// The water fill, replacing a flat rectangle. Everything — the three-stop
// depth gradient, the caustic veins, and the light beams — is one fragment
// shader over a single plane, driven entirely by world-space Y (depth) and X.
// No textures, no CPU simulation: uniforms are refreshed from CONFIG every
// frame, the same pattern the grid uses, so tuner sliders apply live.
//
// The plane itself runs some way ABOVE the still-water line (world.js sizes it
// that way) and the shader cuts it back down to the wave curve, so the top of
// the fill rides the swell instead of sitting flat under it. The clip uses the
// WAVE constants from arena.js, exactly as the grid does, so the fill, the drawn
// surface line and the grid can never disagree about where the water ends.

const MAX_GODRAYS = 8; // must match the shader's loop bound

const vertexShader = /* glsl */ `
  uniform vec2 uCenter;
  varying vec2 vWorldPos;

  void main() {
    vWorldPos = position.xy + uCenter;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #define MAX_GODRAYS ${MAX_GODRAYS}

  uniform float uTime;
  uniform float uSurfaceY;
  uniform float uBottomY;
  uniform float uWaveT;
  uniform float uWaveAmp;

  uniform vec3 uShallow;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform float uStop1;
  uniform float uStop2;

  uniform float uCausticsOn;
  uniform float uCausticsIntensity;
  uniform float uCausticsScale;
  uniform float uCausticsSpeed;
  uniform float uCausticsFalloff;
  uniform vec3 uCausticsColor;

  uniform float uRayOn;
  uniform float uRayCount;
  uniform float uRaySpread;
  uniform float uRayOffset;
  uniform float uRayAngle;
  uniform float uRaySway;
  uniform float uRaySpeed;
  uniform float uRayWidth;
  uniform float uRayIntensity;
  uniform float uRayFalloff;
  uniform vec3 uRayColor;

  varying vec2 vWorldPos;

  float hash(float n) {
    return fract(sin(n * 12.9898) * 43758.5453);
  }

  // Mirrors surfaceHeightAt() in arena.js — and the grid's copy of it. Every
  // constant carries a decimal point because GLSL ES will not coerce int to
  // float, so a WAVE value that happened to be whole would fail to compile.
  float surfaceAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)};
  }

  // Three interfering sine waves — a cheap, seamless stand-in for real
  // caustic ray-tracing. Cubing sharpens the bright veins.
  float caustics(vec2 p, float t) {
    float c = 0.0;
    c += sin(p.x * 1.3 + p.y * 0.7 + t);
    c += sin(p.x * -0.9 + p.y * 1.4 - t * 1.3);
    c += sin(p.x * 0.5 - p.y * 1.1 + t * 0.7);
    c = c / 3.0;
    return pow(max(c, 0.0), 3.0);
  }

  void main() {
    // A soft band rather than a hard cut, so the crest edge doesn't crawl with
    // stair-steps as the wave slides. Narrow enough (~1px at play scale) to
    // still read as an edge.
    const float FADE = 0.08;
    float surf = surfaceAt(vWorldPos.x);
    float mask = 1.0 - smoothstep(surf - FADE, surf, vWorldPos.y);
    if (mask <= 0.0) discard;

    // Depth stays measured from the STILL line, not from the wave above it, so
    // the gradient and the caustic falloff don't pump up and down with the
    // swell. Only the cut moves.
    float depth = clamp((uSurfaceY - vWorldPos.y) / max(uSurfaceY - uBottomY, 0.0001), 0.0, 1.0);

    vec3 color;
    if (depth < uStop1) {
      color = mix(uShallow, uMid, depth / max(uStop1, 0.0001));
    } else {
      float t = (depth - uStop1) / max(uStop2 - uStop1, 0.0001);
      color = mix(uMid, uDeep, clamp(t, 0.0, 1.0));
    }

    if (uCausticsOn > 0.5) {
      float fade = pow(1.0 - depth, uCausticsFalloff);
      float c = caustics(vWorldPos * uCausticsScale, uTime * uCausticsSpeed);
      color += uCausticsColor * c * uCausticsIntensity * fade;
    }

    if (uRayOn > 0.5) {
      float fade = pow(1.0 - depth, uRayFalloff);
      float sum = 0.0;
      for (int i = 0; i < MAX_GODRAYS; i++) {
        if (float(i) >= uRayCount) break;
        float seed = float(i) * 71.31;
        float anchor = (hash(seed) * 2.0 - 1.0) * uRaySpread;
        float sway = sin(uTime * uRaySpeed + seed) * uRaySway * uRaySpread;
        // uRayOffset slides the whole bundle under the light source; uRayAngle
        // leans it away from that source as it goes down. Both are zero with
        // the day/night coupling off, leaving the original fixed beams.
        float x = anchor + sway + uRayOffset + depth * uRayAngle * uRaySpread * 0.3;
        float d = abs(vWorldPos.x - x);
        sum += smoothstep(uRayWidth, 0.0, d);
      }
      color += uRayColor * min(sum, 1.5) * uRayIntensity * fade;
    }

    gl_FragColor = vec4(color, mask);
  }
`;

export function createWaterMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    // Transparent for the sake of the clipped edge alone: the fill is opaque
    // everywhere below the wave and only feathers out across the last fraction
    // of a unit at the crest, where what shows through is the sky behind it.
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uSurfaceY: { value: 0 },
      uBottomY: { value: -1 },
      uWaveT: { value: 0 },
      uWaveAmp: { value: 0 },
      uShallow: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color() },
      uStop1: { value: 0.3 },
      uStop2: { value: 0.7 },
      uCausticsOn: { value: 1 },
      uCausticsIntensity: { value: 0.4 },
      uCausticsScale: { value: 0.16 },
      uCausticsSpeed: { value: 0.55 },
      uCausticsFalloff: { value: 1.6 },
      uCausticsColor: { value: new THREE.Color() },
      uRayOn: { value: 1 },
      uRayCount: { value: 5 },
      uRaySpread: { value: 30 },
      uRayOffset: { value: 0 },
      uRayAngle: { value: 0.5 },
      uRaySway: { value: 0.12 },
      uRaySpeed: { value: 0.18 },
      uRayWidth: { value: 2.4 },
      uRayIntensity: { value: 0.22 },
      uRayFalloff: { value: 1.2 },
      uRayColor: { value: new THREE.Color() },
    },
  });
}

// Pushed in from world.updateSurface at the moment the surface line itself is
// rewritten, rather than read during the colour pass, so the fill is cut on the
// same wave the line is drawn on. A frame of disagreement here is a visible
// hairline gap between the two.
export function setWaterWaveTime(material, t) {
  material.uniforms.uWaveT.value = t;
}

// Called every frame — cheap uniform sets, so tuner sliders apply live with no
// rebuild. Geometry-affecting values (position/size) are handled separately by
// whoever positions the mesh.
export function updateWaterMaterial(material, clock) {
  const u = material.uniforms;
  u.uTime.value = clock;
  u.uWaveAmp.value = CONFIG.arena.waveAmplitude;

  u.uShallow.value.set(CONFIG.colors.waterShallow);
  u.uMid.value.set(CONFIG.colors.waterMid);
  u.uDeep.value.set(CONFIG.colors.waterDeep);
  u.uStop1.value = CONFIG.colors.zoneStops[0];
  u.uStop2.value = CONFIG.colors.zoneStops[1];

  // Both the veins and the beams are the SAME light seen two ways — sunlight
  // refracted through a moving surface — so both ride the day/night light bus
  // rather than each having its own opinion about the time. `intensity` in
  // config becomes the value at noon; the bus scales down from there to
  // `nightFloor` under a full moon, and mixes the light's own colour (warm at
  // dawn, cold at night) into the authored one. With the coupling off, or the
  // day cycle off, `lightMix` is 1 and every line below is what it always was.
  const day = CONFIG.dayNight?.enabled;

  const cc = CONFIG.caustics;
  const causticsLight = day && cc.followSun
    ? cc.nightFloor + (1 - cc.nightFloor) * skyLight.intensity
    : 1;
  u.uCausticsOn.value = cc.enabled ? 1 : 0;
  u.uCausticsIntensity.value = cc.intensity * causticsLight;
  u.uCausticsScale.value = cc.scale;
  u.uCausticsSpeed.value = cc.speed;
  u.uCausticsFalloff.value = cc.falloff;
  u.uCausticsColor.value.set(cc.color);
  if (day && cc.followSun) u.uCausticsColor.value.lerp(skyLight.color, cc.tintMix ?? 0);

  const gr = CONFIG.godrays;
  const rayLight = day && gr.followSun
    ? gr.nightFloor + (1 - gr.nightFloor) * skyLight.intensity
    : 1;
  // Where the light is, as a fraction of half the arena: 0 at the top of the
  // arc, ±1 at the horizon. That single number is what makes the beams lean
  // hardest at sunrise and sunset and stand straight up at noon — no separate
  // elevation term needed, because the ellipse already encodes it.
  const lean = day && gr.followSun
    ? Math.max(-1.5, Math.min(1.5, skyLight.x / Math.max(1, bounds.width / 2)))
    : 0;

  u.uRayOn.value = gr.enabled ? 1 : 0;
  u.uRayCount.value = Math.min(MAX_GODRAYS, gr.count);
  u.uRaySpread.value = gr.spread;
  u.uRayOffset.value = lean * gr.spread * (gr.followShift ?? 0);
  // Negated: light entering the water from the left travels down and to the
  // RIGHT, so a body on the left (negative x) has to produce a positive drift.
  u.uRayAngle.value = gr.angle - lean * (gr.followTilt ?? 0);
  u.uRaySway.value = gr.sway;
  u.uRaySpeed.value = gr.speed;
  u.uRayWidth.value = gr.beamWidth;
  u.uRayIntensity.value = gr.intensity * rayLight;
  u.uRayFalloff.value = gr.falloff;
  u.uRayColor.value.set(gr.color);
  if (day && gr.followSun) u.uRayColor.value.lerp(skyLight.color, gr.tintMix ?? 0);
}
