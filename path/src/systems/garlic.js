import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { removeEnemy } from '../entities/enemies.js';
import { aoe } from './scaling.js';
import { playerOverlayZ } from '../entities/player.js';
import { stoke, cool, glowStir, hotFieldColor } from './damageGlow.js';
import { player } from '../entities/player.js';
import { garlicLevelStats } from '../levelStats.js';

// A constant low-damage aura around the ship. The cloudy look is two layers
// of value noise scrolling at different rates — cheap, no texture needed.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  // THE SCROLL PHASE, INTEGRATED ON THE CPU — not a clock times a rate.
  //
  // This used to be uTime x uSwirl, which is the same picture right up until
  // the rate moves: the phase is rate x elapsed, so stirring the cloud harder
  // rewrites where the noise has always been and the whole field jumps a
  // fraction of a second sideways on the frame the aura catches something. That
  // is the exact frame the stir exists to draw attention to. See glowStir().
  uniform float uFlow;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDensity;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;

    vec2 q = p * uDensity + vec2(uFlow * 0.3, uFlow * 0.2);
    float n = noise(q * 3.0) * 0.6 + noise(q * 6.0 + 10.0) * 0.4;
    float edge = smoothstep(1.0, 0.55, r);

    gl_FragColor = vec4(uColor, uOpacity * edge * (0.35 + 0.65 * n));
  }
`;

let mesh = null;
let tickTimer = 0;
// Where the noise has crawled to, integrated rather than derived from a clock —
// see the uniform's note above.
let flow = 0;
// How hard the cloud is working, 0..1 — see systems/damageGlow.js. One number
// for the whole field, unlike the shrimp ring's per-instance heat, because the
// field IS one object: it ticks as a unit and it is drawn as a unit.
let heat = 0;

export function createGarlicVisual() {
  const geometry = new THREE.CircleGeometry(1, 32);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uFlow: { value: 0 },
      uColor: { value: new THREE.Color(CONFIG.garlic.color) },
      uOpacity: { value: CONFIG.garlic.opacity },
      uDensity: { value: CONFIG.garlic.density },
    },
  });
  mesh = new THREE.Mesh(geometry, material);
  // Behind the whole seal — see playerOverlayZ. Restamped per frame below,
  // since it is derived from the seal's live size.
  mesh.position.z = playerOverlayZ();
  mesh.visible = false;
  return mesh;
}

// Splash Zone applies here rather than at the call sites because the aura's
// radius is read three times a frame — the mesh scale, the damage test, and
// the tuner readout — and they must not be able to disagree about how big the
// cloud is. The mesh is scaled by exactly this number, so the picture and the
// hitbox are the same value by construction.
export function currentGarlicRadius(garlicLevel) {
  // Through levelStats.js, like the damage above it, so the reach the tip
  // quotes and the reach the cloud actually has are one number. Splash Zone is
  // folded in there, which is why aoe() is no longer applied here.
  return garlicLevelStats(garlicLevel, player.stats).garlicRadius;
}

// hooks: { onEnemyDamaged(e, dmg), onEnemyKilled(e), onTick(x, y, count) }
// — the first two are the shape combat.js uses, so feedback wiring stays
// consistent across every damage source.
//
// onTick is the aura's own voice, and it fires ONCE per tick with however
// many creatures that tick caught — not once per creature. Per-creature would
// be twenty calls on the same frame from a single tick through a school,
// which `sfxMinGap` would collapse back to one sound anyway while still
// paying for twenty rumble calls. The count rides along so a tick through a
// crowd can be louder than a tick that caught one crab.
export function updateGarlic(dt, scene, playerPos, garlicLevel, enemiesList, hooks) {
  if (!mesh) return;

  const active = garlicLevel > 0;
  mesh.visible = active;
  if (!active) return;

  const radius = currentGarlicRadius(garlicLevel);
  mesh.position.x = playerPos.x;
  mesh.position.y = playerPos.y;
  mesh.position.z = playerOverlayZ();
  mesh.scale.setScalar(radius);

  // HOT WHILE IT IS GRINDING — on all three channels the field has, because
  // brightness alone could not be told apart from the water it was floating
  // over. Stoked below by a tick that caught something, carried to now here,
  // and spent on:
  //
  //   COLOUR   brightness and hue together, through the shared hotFieldColor().
  //            Brightness goes to the colour rather than to the opacity because
  //            the layer is additive: a channel driven past 1 is real light
  //            that survives into the bright pass and haloes, where more alpha
  //            would only make the cloud thicker.
  //   FLOW     the noise crawls faster. Integrated, never multiplied into an
  //            elapsed clock — see the uniform.
  //
  // See CONFIG.damageGlow.sources.garlic for all three numbers.
  heat = cool(heat, 'garlic', dt);

  const u = mesh.material.uniforms;
  flow += dt * CONFIG.garlic.swirl * glowStir(heat, 'garlic');
  u.uFlow.value = flow;
  hotFieldColor(u.uColor.value, CONFIG.garlic.color, heat, 'garlic');
  u.uOpacity.value = CONFIG.garlic.opacity;
  u.uDensity.value = CONFIG.garlic.density;

  tickTimer -= dt;
  if (tickTimer > 0) return;
  tickTimer = CONFIG.garlic.tickInterval;
  // WHAT A TICK HITS FOR AT THIS STACK. A stack used to buy reach alone, so
  // the aura got wider without ever getting stronger. Sourced from
  // levelStats.js — the same function the hover tip quotes — so the number a
  // card promises is the number a creature standing in the cloud takes.
  const tickDamage = garlicLevelStats(garlicLevel, player.stats).garlicDps
    * CONFIG.garlic.tickInterval;

  let caught = 0;
  for (let i = enemiesList.length - 1; i >= 0; i--) {
    const e = enemiesList[i];
    const dx = e.mesh.position.x - playerPos.x;
    const dy = e.mesh.position.y - playerPos.y;
    if (dx * dx + dy * dy > radius * radius) continue;

    caught += 1;
    e.hp -= tickDamage;
    e.flash = CONFIG.fx.hitFlash;
    e.hitThisFrame = true;
    hooks.onEnemyDamaged?.(e, tickDamage);
    if (e.hp <= 0) {
      hooks.onEnemyKilled?.(e);
      removeEnemy(scene, i);
    }
  }

  // Only when the field actually caught something. A tick that hit nothing is
  // not an event — swimming around with garlic up would otherwise pulse in
  // your hands forever, at the tick rate, for the entire run.
  // Scaled by how many the tick caught — a sweep through a school runs the
  // cloud hotter than one that clipped a single crab, which is the same fact
  // the event below carries a count for.
  if (caught) heat = stoke(heat, 'garlic', caught);
  if (caught) hooks.onTick?.(playerPos.x, playerPos.y, caught);
}

export function resetGarlic() {
  tickTimer = 0;
  heat = 0;
  flow = 0;
}
