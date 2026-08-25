import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { removeEnemy } from '../entities/enemies.js';
import { aoe } from './scaling.js';
import { playerOverlayZ } from '../entities/player.js';
import { player } from '../entities/player.js';
import { calamariLevelStats } from '../levelStats.js';

// Calamari Ring — a glowing shockwave that sweeps outward from the seal on a
// cadence, damaging and shoving everything the wavefront passes through.
//
// Same cloudy value-noise look as Sea Garlic (systems/garlic.js), deliberately:
// they're siblings, one a field you stand in and one a pulse you send out. The
// difference is entirely in how damage lands. Garlic ticks everything inside a
// radius on a timer, so standing still in a crowd is a grinder. This hits each
// enemy exactly ONCE per wave, as the front crosses them — so it rewards
// timing and position instead of parking, and the knockback buys space rather
// than holding ground.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Differs from garlic's shader in one way: instead of filling the disc, it
// keeps a band around `uProgress` and discards the rest, so the lit region is
// an annulus that marches outward as progress runs 0 -> 1.
const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSwirl;
  uniform float uDensity;
  uniform float uProgress;
  uniform float uRingWidth;
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

    // Distance from the wavefront, in units of the band's half-width.
    float d = abs(r - uProgress) / max(0.0001, uRingWidth);
    if (d > 1.0) discard;
    // Soft on both sides, so the band has no hard edge to strobe against the
    // grid as it expands.
    float band = 1.0 - smoothstep(0.0, 1.0, d);

    vec2 q = p * uDensity + vec2(uTime * uSwirl * 0.3, uTime * uSwirl * 0.2);
    float n = noise(q * 3.0) * 0.6 + noise(q * 6.0 + 10.0) * 0.4;

    // Fade the whole wave out as it runs, so it dissipates rather than
    // vanishing at full brightness the instant it hits max radius.
    float fade = 1.0 - smoothstep(0.65, 1.0, uProgress);

    gl_FragColor = vec4(uColor, uOpacity * band * fade * (0.35 + 0.65 * n));
  }
`;

// One mesh per live wave. Pooled because the cadence can drop below a wave's
// travel time at high stacks, and a wave that vanished the moment the next one
// spawned would make the ability look like it was stuttering rather than
// firing faster.
const waves = []; // { mesh, radius, maxRadius, hit:Set, damage, knockback }
const pool = [];
let cooldown = 0;

function makeMesh() {
  const geometry = new THREE.CircleGeometry(1, 48);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(CONFIG.calamari.color) },
      uOpacity: { value: CONFIG.calamari.opacity },
      uSwirl: { value: CONFIG.calamari.swirl },
      uDensity: { value: CONFIG.calamari.density },
      uProgress: { value: 0 },
      uRingWidth: { value: CONFIG.calamari.ringWidth },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = -0.2;
  return mesh;
}

export function resetCalamari(scene) {
  for (const w of waves) {
    scene.remove(w.mesh);
    pool.push(w.mesh);
  }
  waves.length = 0;
  cooldown = 0;
}

export function currentCalamariStats(level) {
  const c = CONFIG.calamari;
  const lvs = calamariLevelStats(level, player.stats);
  return {
    // Through levelStats.js — one implementation of the level curve, shared
    // with the tip that quotes it. Splash Zone is folded in there.
    interval: lvs.calamariGap,
    // The wave's whole existence is its reach, so Splash Zone lands here. The
    // lit band is a FRACTION of this (ringWidth), which is what keeps a
    // widened wave in proportion instead of thinning to a hairline.
    maxRadius: lvs.calamariRadius,
    damage: lvs.calamariDamage,
    knockback: c.knockback,
  };
}

// hooks: { onEnemyDamaged(e, dmg), onEnemyKilled(e), onWave(x, y) } — same
// shape combat.js uses, so feedback wiring stays consistent across every
// damage source.
export function updateCalamari(dt, scene, playerPos, level, enemiesList, hooks = {}) {
  const active = level > 0;

  if (active) {
    const s = currentCalamariStats(level);
    cooldown -= dt;
    if (cooldown <= 0) {
      cooldown = s.interval;
      const mesh = pool.pop() ?? makeMesh();
      // Behind the seal like every other overlay the player wears — see
      // playerOverlayZ. A wave is born under the animal and only clears it a
      // few frames later, which is exactly when a plane inside the body shows.
      mesh.position.set(playerPos.x, playerPos.y, playerOverlayZ());
      scene.add(mesh);
      waves.push({
        mesh,
        radius: 0,
        maxRadius: s.maxRadius,
        hit: new Set(),
        damage: s.damage,
        knockback: s.knockback,
      });
      hooks.onWave?.(playerPos.x, playerPos.y);
    }
  }

  const c = CONFIG.calamari;

  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    const prevRadius = w.radius;
    w.radius += c.speed * dt;

    // The wave is fired from where the seal was standing and stays there — a
    // shockwave that followed you around would just be garlic with extra
    // steps, and the whole point is that you can swim out of your own blast.
    w.mesh.scale.setScalar(w.maxRadius);
    const u = w.mesh.material.uniforms;
    u.uTime.value += dt;
    u.uColor.value.set(c.color);
    u.uOpacity.value = c.opacity;
    u.uSwirl.value = c.swirl;
    u.uDensity.value = c.density;
    u.uRingWidth.value = c.ringWidth;
    u.uProgress.value = Math.min(1, w.radius / w.maxRadius);

    // Damage band in WORLD units, matching the lit band in the shader: an
    // enemy is hit when the front crosses it, not when it's merely inside the
    // swept circle. Tested against the span between last frame's radius and
    // this one so a fast wave can't tunnel past a fish between frames.
    const halfBand = c.ringWidth * w.maxRadius;
    const inner = prevRadius - halfBand;
    const outer = w.radius + halfBand;

    for (let j = enemiesList.length - 1; j >= 0; j--) {
      const e = enemiesList[j];
      if (w.hit.has(e)) continue; // once per wave, per enemy
      const dx = e.mesh.position.x - w.mesh.position.x;
      const dy = e.mesh.position.y - w.mesh.position.y;
      const d = Math.hypot(dx, dy);
      if (d + e.radius < inner || d - e.radius > outer) continue;

      w.hit.add(e);
      e.hp -= w.damage;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;

      // Shove outward along the radial. Same field enemies.js uses for its own
      // separation pass, so this reads as being pushed rather than teleported.
      const len = d || 0.0001;
      e.vx += (dx / len) * w.knockback;
      e.vy += (dy / len) * w.knockback;

      hooks.onEnemyDamaged?.(e, w.damage);
      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, j);
      }
    }

    if (w.radius >= w.maxRadius) {
      scene.remove(w.mesh);
      pool.push(w.mesh);
      waves.splice(i, 1);
    }
  }
}
