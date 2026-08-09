import * as THREE from 'three';
import { CONFIG } from '../config.js';

// The water fill, replacing a flat rectangle. Everything — the three-stop
// depth gradient, the caustic veins, and the light beams — is one fragment
// shader over a single plane, driven entirely by world-space Y (depth) and X.
// No textures, no CPU simulation: uniforms are refreshed from CONFIG every
// frame, the same pattern the grid uses, so tuner sliders apply live.

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
        float x = anchor + sway + depth * uRayAngle * uRaySpread * 0.3;
        float d = abs(vWorldPos.x - x);
        sum += smoothstep(uRayWidth, 0.0, d);
      }
      color += uRayColor * min(sum, 1.5) * uRayIntensity * fade;
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

export function createWaterMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uSurfaceY: { value: 0 },
      uBottomY: { value: -1 },
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

// Called every frame — cheap uniform sets, so tuner sliders apply live with no
// rebuild. Geometry-affecting values (position/size) are handled separately by
// whoever positions the mesh.
export function updateWaterMaterial(material, clock) {
  const u = material.uniforms;
  u.uTime.value = clock;

  u.uShallow.value.set(CONFIG.colors.waterShallow);
  u.uMid.value.set(CONFIG.colors.waterMid);
  u.uDeep.value.set(CONFIG.colors.waterDeep);
  u.uStop1.value = CONFIG.colors.zoneStops[0];
  u.uStop2.value = CONFIG.colors.zoneStops[1];

  u.uCausticsOn.value = CONFIG.caustics.enabled ? 1 : 0;
  u.uCausticsIntensity.value = CONFIG.caustics.intensity;
  u.uCausticsScale.value = CONFIG.caustics.scale;
  u.uCausticsSpeed.value = CONFIG.caustics.speed;
  u.uCausticsFalloff.value = CONFIG.caustics.falloff;
  u.uCausticsColor.value.set(CONFIG.caustics.color);

  u.uRayOn.value = CONFIG.godrays.enabled ? 1 : 0;
  u.uRayCount.value = Math.min(MAX_GODRAYS, CONFIG.godrays.count);
  u.uRaySpread.value = CONFIG.godrays.spread;
  u.uRayAngle.value = CONFIG.godrays.angle;
  u.uRaySway.value = CONFIG.godrays.sway;
  u.uRaySpeed.value = CONFIG.godrays.speed;
  u.uRayWidth.value = CONFIG.godrays.beamWidth;
  u.uRayIntensity.value = CONFIG.godrays.intensity;
  u.uRayFalloff.value = CONFIG.godrays.falloff;
  u.uRayColor.value.set(CONFIG.godrays.color);
}
