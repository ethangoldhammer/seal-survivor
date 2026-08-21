import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, WAVE, sea } from '../arena.js';
import { skyLight } from './daylight.js';
// The veins are sampled here AND on the seal's wet film — see the note in that
// file for why there is only one copy of them.
import { CAUSTICS_GLSL } from './causticsGlsl.js';
import { WISP_GLSL } from './wispGlsl.js';
// A LEAF, deliberately — see its header. The beam's numbers are owned by
// systems/graveBeam.js, which imports assets.js and everything behind it; this
// file has no business loading a glTF parser to find out where a light is.
import { graveRay } from './graveRay.js';

// The water fill, replacing a flat rectangle. Everything — the depth gradient,
// the caustic veins, and the light beams — is one fragment
// shader over a single plane, driven entirely by world-space Y (depth) and X.
// No textures, no CPU simulation: uniforms are refreshed from CONFIG every
// frame, the same pattern the grid uses, so tuner sliders apply live.
//
// THE GRADIENT HAS TWO SHAPES and CONFIG.absorption.mix crossfades between
// them. The original is two straight ramps through `waterMid`; the second is
// Beer-Lambert extinction, which eats each channel at its own rate and is why
// real deep water goes blue instead of just going dark. Both run between the
// same authored endpoints, so the palette drives either one. See the config
// block for the reasoning; the shader below only has to do the arithmetic.
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
  uniform float uChop;

  uniform vec3 uShallow;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform float uStop1;
  uniform float uStop2;

  uniform float uAbsorbMix;
  uniform vec3 uAbsorb;

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

  // THE AIMED ONE. Everything above is the ambient bundle — five beams the
  // daylight scatters across the arena and nobody is looking at. This is a
  // single beam pointed AT something: the gravestone the seal has just swum
  // over. See systems/graveRay.js for why its numbers arrive from another
  // system rather than from CONFIG, and systems/graveBeam.js for the other half
  // of it — the light this shaft is carrying, landing on the stone.
  uniform float uGraveRayStrength;
  uniform float uGraveRayX;
  uniform float uGraveRayY;
  uniform float uGraveRayHalf;
  uniform float uGraveRayTilt;
  uniform float uGraveRayTime;
  uniform float uGraveRayWisp;
  uniform float uGraveRayWispScale;
  uniform float uGraveRayWispSpeed;
  uniform float uGraveRayReach;
  uniform vec3 uGraveRayColor;

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
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)}
      + sin(x * ${WAVE.k3.toFixed(4)} + uWaveT * ${WAVE.w3.toFixed(4)}) * uWaveAmp * ${WAVE.amp3.toFixed(4)} * uChop;
  }

${CAUSTICS_GLSL}
${WISP_GLSL}

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

    // Beer-Lambert: what SURVIVES the trip down is exp(-k * distance), per
    // channel. At depth 0 nothing has been absorbed and this is exactly
    // uShallow; at the floor each channel has decayed by its own coefficient
    // toward uDeep, which is why the two curves share endpoints and disagree
    // everywhere between.
    //
    // Behind a branch rather than folded into a mix() so that the default
    // (mix = 0) costs the fill NOTHING. This plane covers most of the screen,
    // so it is the one place where three unconditional exp() calls per
    // fragment would be worth counting. The branch is on a uniform, so every
    // fragment in the draw takes the same side of it.
    if (uAbsorbMix > 0.0) {
      vec3 transmitted = exp(-uAbsorb * depth);
      color = mix(color, uDeep + (uShallow - uDeep) * transmitted, uAbsorbMix);
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

    // --- THE AIMED SHAFT ---------------------------------------------------
    // Behind a branch on a uniform, like the absorption above and for the same
    // reason: this plane covers most of the screen, the branch is uniform so
    // every fragment in the draw takes the same side of it, and a graveyard the
    // seal is nowhere near should cost the fill nothing at all.
    if (uGraveRayStrength > 0.0) {
      // The SAME line the stone's own band is cut from — rake included, and
      // measured from the same base. If these two expressions ever stop
      // matching, the shaft stands beside the stone it is lighting, and neither
      // system can tell: each is correct on its own. See systems/graveRay.js.
      float gd = abs(vWorldPos.x - uGraveRayX + (vWorldPos.y - uGraveRayY) * uGraveRayTilt);
      float band = smoothstep(uGraveRayHalf, 0.0, gd);

      // IT COMES FROM ABOVE AND DIES AT THE FLOOR. Without this the shaft is a
      // stripe the full height of the arena, which is a curtain rather than a
      // beam — light entering water gets eaten on the way down, and the thing
      // that makes a god ray read as one is that you can see it running out.
      // Brightest at the top of its reach, gone by the time it has travelled
      // 'reach' world units below the stone's own base. (No backticks anywhere
      // in this string: one inside a shader comment ends the template literal,
      // and the error points at the comment rather than at the backtick.)
      float up = (vWorldPos.y - uGraveRayY) / max(uGraveRayReach, 0.0001);
      band *= smoothstep(-0.15, 0.25, up) * (1.0 - smoothstep(0.55, 1.0, up));

      // Torn by the same field, at the same coordinates, on the same frame as
      // the band on the stone under it — that is the whole reason wispGlsl.js
      // is a shared string. A hole in the shaft is a hole in what lands.
      float w = wisp(vWorldPos * uGraveRayWispScale, uGraveRayTime * uGraveRayWispSpeed);
      band *= mix(1.0, w, uGraveRayWisp);

      // And the veins inside it, from the water's own caustic field. A shaft
      // with nothing moving inside it is a shape; this is what makes it light.
      float gc = caustics(vWorldPos * uCausticsScale, uTime * uCausticsSpeed);
      color += uGraveRayColor * band * uGraveRayStrength * (0.35 + gc);
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
      uChop: { value: 0 },
      uShallow: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color() },
      uStop1: { value: 0.3 },
      uStop2: { value: 0.7 },
      uAbsorbMix: { value: 0 },
      uAbsorb: { value: new THREE.Vector3(4, 1.5, 0.7) },
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

      // The aimed shaft. Zero strength is "no beam" and is what the branch in
      // the fragment shader tests, so the whole block costs nothing on every
      // frame the seal is not over a grave — which is nearly all of them.
      uGraveRayStrength: { value: 0 },
      uGraveRayX: { value: 0 },
      uGraveRayY: { value: 0 },
      uGraveRayHalf: { value: 2 },
      uGraveRayTilt: { value: 0.35 },
      uGraveRayTime: { value: 0 },
      uGraveRayWisp: { value: 0.75 },
      uGraveRayWispScale: { value: 0.55 },
      uGraveRayWispSpeed: { value: 0.35 },
      uGraveRayReach: { value: 26 },
      uGraveRayColor: { value: new THREE.Color(0xbfe9ff) },
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

// --- THE PUNCH-IN COMPENSATION ---------------------------------------------
//
// WHAT THIS IS FOR. CONFIG.caustics is authored for the framing a run is played
// at — some fifty world units across — where `intensity` 0.28 at a `scale` of
// half a cycle per unit is a fine dapple over the whole ocean. The main menu
// holds the same water at fifteen times that zoom (systems/mainMenu.js), and
// both numbers fail there for opposite reasons: the veins are magnified into
// two or three soft blobs the size of the seal, and what is left of them at the
// depth a run starts at (`pow(1 - depth, falloff)` — half, at the surface-to-
// floor midpoint) is too faint to see at all. The light in the water simply
// stops existing on the one screen that is nothing but water.
//
// So the menu multiplies both while it owns the frame, and eases the multiplier
// back to 1 as the shot pulls out — the veins tighten into the arena's own
// dapple over the same second the camera opens up.
//
// A SETTER RATHER THAN AN ARGUMENT, like setWaterWaveTime above: the caller is
// four layers up (mainMenu -> main -> world.updateSurface -> updateColors) and
// nothing in between has any business carrying it. Both default to 1, so the
// game with no menu in front of it is exactly what it was.
let causticsGain = 1;
let causticsScaleMul = 1;

/**
 * Scale the caustics for a frame that is not the run's.
 *
 * @param gain  multiplies CONFIG.caustics.intensity, 1 = the arena's own
 * @param scale multiplies CONFIG.caustics.scale — bigger is MORE veins across
 *              the same water, which is what a punched-in frame needs
 */
export function setCausticsPunch(gain = 1, scale = 1) {
  causticsGain = Math.max(0, gain);
  causticsScaleMul = Math.max(0.0001, scale);
}

// THE LIVE CAUSTIC STATE, for anything that has to be lit by the same veins the
// water is drawing. Written once a frame at the bottom of updateWaterMaterial;
// see the note there. Read-only to everyone else — it is a mirror of what was
// uploaded, not a second place to set it.
export const liveCaustics = {
  on: 1,
  light: 1,        // the day/night bus alone — see the note where it is written
  intensity: 0.4,  // ...and the value the water plane actually uploaded
  scale: 0.16,
  phase: 0,
  falloff: 1.6,
  color: new THREE.Color(0xbfefff),
  surfaceY: 0,
  bottomY: -1,
};

// Called every frame — cheap uniform sets, so tuner sliders apply live with no
// rebuild. Geometry-affecting values (position/size) are handled separately by
// whoever positions the mesh.
export function updateWaterMaterial(material, clock) {
  const u = material.uniforms;
  u.uTime.value = clock;
  // The LIVE sea state, not the config baseline: the weather multiplies the
  // amplitude and mixes in the chop term, and a fill clipped to a different
  // wave than the line drawn on it is a visible tear.
  u.uWaveAmp.value = sea.amp;
  u.uChop.value = sea.chop;

  u.uShallow.value.set(CONFIG.colors.waterShallow);
  u.uMid.value.set(CONFIG.colors.waterMid);
  u.uDeep.value.set(CONFIG.colors.waterDeep);
  u.uStop1.value = CONFIG.colors.zoneStops[0];
  u.uStop2.value = CONFIG.colors.zoneStops[1];

  // Optional-chained like the day/night additions below it: this block is
  // newer than the tuning files on disk, and a saved snapshot that predates it
  // has no `absorption` key at all.
  const ab = CONFIG.absorption;
  u.uAbsorbMix.value = ab?.mix ?? 0;
  u.uAbsorb.value.set(ab?.red ?? 4, ab?.green ?? 1.5, ab?.blue ?? 0.7);

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
  u.uCausticsIntensity.value = cc.intensity * causticsLight * causticsGain;
  u.uCausticsScale.value = cc.scale * causticsScaleMul;
  u.uCausticsSpeed.value = cc.speed;
  u.uCausticsFalloff.value = cc.falloff;
  u.uCausticsColor.value.set(cc.color);
  if (day && cc.followSun) u.uCausticsColor.value.lerp(skyLight.color, cc.tintMix ?? 0);

  // PUBLISHED FOR THE SEAL'S WET FILM. The veins that fall on the animal are
  // the same light as the veins in the water behind it, so everything the film
  // needs is taken from the values THIS function just finished resolving —
  // after the punch-in gain, after the day/night bus, after the sun's tint.
  //
  // Recomputing any of it on the other side would mean a second copy of the
  // `nightFloor + (1 - nightFloor) * intensity` curve and the menu's gain, and
  // the first tuner change to either would leave the seal lit by a time of day
  // the ocean had already moved on from.
  liveCaustics.on = u.uCausticsOn.value;
  // THE DAY BUS ALONE — 1 at noon, `nightFloor` under a full moon — and NOT
  // `intensity`, which is the other half of what got uploaded above.
  //
  // The difference is the whole reason the seal's veins were invisible in the
  // first cut. CONFIG.caustics.intensity is authored for a fifty-unit fill
  // where the dapple is a wash you are barely meant to notice; at 0.28 it is
  // three hundredths of a value once the depth fade has had it, and three
  // hundredths spread over a two-unit animal is nothing at all. It is the same
  // mismatch setCausticsPunch exists to fix for the menu.
  //
  // So the film gets the TIME OF DAY and owns its own strength
  // (CONFIG.sealShader.wetCaustics). The veins still die at night, still switch
  // off with the tuner, and are no longer scaled by a number that describes a
  // completely different surface.
  // --- THE AIMED SHAFT ---------------------------------------------------
  // Read, never written — systems/graveBeam.js owns the sweep and is the only
  // thing that sets it. The x, the rake and the clock come from THERE so the
  // shaft and the light it lands on the stone are one beam; everything about
  // how it LOOKS is config, exactly like the ambient bundle above.
  //
  // Multiplied by the same day/night bus the veins ride. A shaft that stayed
  // full brightness at midnight would be the one thing in the water that has
  // not noticed the sun has gone.
  {
    const gb = CONFIG.gravesite?.beam ?? {};
    const on = gb.enabled !== false && gb.shaft !== false;
    u.uGraveRayStrength.value = on
      ? graveRay.strength * (gb.shaftStrength ?? 0.5) * causticsLight
      : 0;
    u.uGraveRayX.value = graveRay.x;
    u.uGraveRayY.value = graveRay.baseY;
    // WIDER THAN THE LANDING, and deliberately: a shaft exactly the width of
    // the bright patch on the stone reads as a rectangle standing on it. Light
    // spreading through water is wider than the pool it makes.
    u.uGraveRayHalf.value = graveRay.halfWidth * (gb.shaftWidth ?? 1.7);
    u.uGraveRayTilt.value = graveRay.tilt;
    u.uGraveRayTime.value = graveRay.time;
    u.uGraveRayWisp.value = gb.wisp ?? 0.75;
    u.uGraveRayWispScale.value = gb.wispScale ?? 0.55;
    u.uGraveRayWispSpeed.value = gb.wispSpeed ?? 0.35;
    u.uGraveRayReach.value = gb.shaftReach ?? 26;
    u.uGraveRayColor.value.set(gb.color ?? 0xbfe9ff);
    if (day && cc.followSun) u.uGraveRayColor.value.lerp(skyLight.color, cc.tintMix ?? 0);
  }

  liveCaustics.light = causticsLight;
  liveCaustics.intensity = u.uCausticsIntensity.value;
  liveCaustics.scale = u.uCausticsScale.value;
  // The PHASE, not the speed — sampled exactly as the water samples it, so the
  // two patterns are the same pattern rather than two at the same rate.
  liveCaustics.phase = clock * u.uCausticsSpeed.value;
  liveCaustics.falloff = u.uCausticsFalloff.value;
  liveCaustics.color.copy(u.uCausticsColor.value);
  // The depth ramp the falloff is measured against — the still line and the
  // floor, not the wave above it, for the same reason the fill measures depth
  // that way.
  liveCaustics.surfaceY = u.uSurfaceY.value;
  liveCaustics.bottomY = u.uBottomY.value;

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
