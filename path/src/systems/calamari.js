import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { aoe } from './scaling.js';
import { playerOverlayZ } from '../entities/player.js';
import { player } from '../entities/player.js';
import { calamariLevelStats } from '../levelStats.js';
import { attachDamageGlow, stoke, cool, glowLevel, damageGlowCfg } from './damageGlow.js';

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
//
// The wave RIDES WITH THE SEAL rather than staying where it was fired, and
// leaves carrying part of the seal's velocity — see CONFIG.calamari.follow and
// .carry for why that doesn't collapse it into garlic. Squid ride the front and
// let go near the end of its travel; they are decoration with no damage of
// their own, and their count is the only place a stack of this card is legible
// at a glance.
//
// A WAVE THAT IS HITTING SOMETHING IS BRIGHTER THAN ONE THAT IS NOT — the same
// rule the shrimp ring, the garlic cloud and the harp's note rings all follow,
// through the same systems/damageGlow.js envelope. The ring itself and every
// squid riding it take the heat together, because on this ability they ARE one
// object: the squid did not bite anything, the front they are standing on did.

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
const waves = [];
const pool = [];

// WHAT THIS SYSTEM CAN BUILD, named rather than typed at the createVisual call
// below, for the reason shrimpRing.js spells out: systems/levelUpWarmup.js
// reads this to pay for the upload while the cards are up, and a list of keys
// kept anywhere but beside the code that uses them goes stale silently.
export const CALAMARI_ASSETS = ['enemySquid'];

// Flung squid, wave-attached and loose alike:
//   { mesh, wave, angle, vx, vy, life, maxLife, spin, size }
// `wave` is null once it has let go — a squid outlives the ring it rode, which
// is why this is a module-level list and not a field on the wave.
const squids = [];
const squidPool = [];
let cooldown = 0;

const TAU = Math.PI * 2;

// The row in CONFIG.damageGlow.sources that says how bright this aura goes and
// what colour. Named once rather than typed at each of the four call sites —
// a source string that only matches at three of them falls back to the shared
// envelope at the fourth and renders a plausible, slightly wrong flare.
const GLOW_SOURCE = 'calamari';

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
    w.heat = 0;
    scene.remove(w.mesh);
    pool.push(w.mesh);
  }
  waves.length = 0;
  for (const sq of squids) retireSquid(scene, sq);
  squids.length = 0;
  cooldown = 0;
}

/**
 * HOW MANY SQUID RIDE A WAVE at this stack. Not in levelStats.js on purpose:
 * everything in there is a number the tip quotes at the player, and this one
 * carries no damage, no reach and no cadence — it is the ability being legible,
 * not the ability being bought. Putting it there would spend one of the tip's
 * four rows on a decoration.
 */
export function calamariSquidCount(level) {
  const c = CONFIG.calamari;
  if (!(level > 0)) return 0;
  const n = (c.squidBase ?? 0) + (c.squidPerLevel ?? 0) * (level - 1);
  return Math.max(0, Math.min(Math.round(c.squidMax ?? n), Math.round(n)));
}

function retireSquid(scene, sq) {
  // Released, not just removed: the handle wrote a hot emissive into materials
  // this body keeps, so a recycled squid would come out of the pool already
  // glowing at whatever the last thing it hit left behind.
  sq.glow?.release();
  scene.remove(sq.mesh);
  squidPool.push(sq.mesh);
}

// One squid on the front of `w`, at `angle` around it. Born already in place so
// it never appears at the origin for a frame on the way to the rim.
function addSquid(scene, w, angle) {
  const c = CONFIG.calamari;
  const mesh = squidPool.pop() ?? createVisual(CALAMARI_ASSETS[0]);
  // The scale the asset was BORN at, remembered once. The root scale is this
  // key's size multiplier from assets.csv (`fit` lives further down the tree),
  // so squidSize has to multiply it rather than replace it — and it has to
  // multiply the birth value rather than the current one, because a pooled
  // body comes back shrunk from the fade-out below and compounding across
  // reuses would make the second wave's squid invisible.
  mesh.userData.__calamariBase ??= mesh.scale.x || 1;
  const size = mesh.userData.__calamariBase * (c.squidSize ?? 1);
  mesh.scale.setScalar(size);
  mesh.visible = true;
  scene.add(mesh);
  const sq = {
    mesh, wave: w, angle,
    vx: 0, vy: 0,
    life: 0, maxLife: c.squidLife ?? 1,
    spin: 0,
    size,
    heat: 0,
    // Per-instance materials, attached ONCE per body and cached on it: the
    // clone is the expensive half and these bodies are recycled, so attaching
    // per spawn would pay for it on every wave forever. Null on a build where
    // the model never loaded and the stand-in has nothing to brighten — every
    // call is optional-chained for that.
    glow: (mesh.userData.__calamariGlow ??= attachDamageGlow(mesh) ?? null),
  };
  squids.push(sq);
  placeAttached(sq);
  return sq;
}

// Riding the front: on the rim, nose pointing the way the ring is going.
// createVisual leaves a body facing world +Y, hence the quarter turn.
function placeAttached(sq) {
  const w = sq.wave;
  sq.mesh.position.set(
    w.mesh.position.x + Math.cos(sq.angle) * w.radius,
    w.mesh.position.y + Math.sin(sq.angle) * w.radius,
    w.mesh.position.z + 0.01,
  );
  sq.mesh.rotation.z = sq.angle - Math.PI / 2;
}

// Let go. The fling is radial and FASTER than the ring it was riding, plus a
// bigger share of the seal's own motion than the ring took — see the note on
// CONFIG.calamari.squidCarry.
function releaseSquid(sq) {
  const c = CONFIG.calamari;
  const w = sq.wave;
  const speed = (c.speed ?? 0) * (c.squidSpeed ?? 1);
  sq.vx = Math.cos(sq.angle) * speed + w.emitVx * (c.squidCarry ?? 0);
  sq.vy = Math.sin(sq.angle) * speed + w.emitVy * (c.squidCarry ?? 0) + (c.squidLift ?? 0);
  // Tumble direction from the side of the ring it left, so a wave's worth of
  // squid spin outward together instead of a random scatter.
  sq.spin = (c.squidSpin ?? 0) * (Math.cos(sq.angle) >= 0 ? -1 : 1);
  sq.wave = null;
}

function updateSquids(dt, scene) {
  const c = CONFIG.calamari;
  const drag = Math.exp(-(c.squidDrag ?? 0) * dt); // same reason as the wave's carry drag
  const pop = c.hitPop ?? 0;
  for (let i = squids.length - 1; i >= 0; i--) {
    const sq = squids[i];

    // HOT WHILE THE FRONT IT IS ON IS CONNECTING. Stoked in the wave loop and
    // only carried and spent here — on the model's own glow, which the bloom
    // pass then haloes, and on a scale punch. The punch is the same
    // per-instance channel a hit on a creature uses, and for the same reason:
    // it is the one that survives a shared material.
    sq.heat = cool(sq.heat, GLOW_SOURCE, dt);
    const heat = glowLevel(sq.heat, GLOW_SOURCE);
    sq.glow?.set(heat, GLOW_SOURCE);

    if (sq.wave) {
      placeAttached(sq);
      sq.mesh.scale.setScalar(sq.size * (1 + pop * heat));
      continue;
    }

    sq.vx *= drag;
    sq.vy *= drag;
    sq.mesh.position.x += sq.vx * dt;
    sq.mesh.position.y += sq.vy * dt;
    sq.mesh.rotation.z += sq.spin * dt;

    sq.life += dt;
    // Shrunk out, never faded out. A model-backed body shares its materials
    // with the template and every other copy of the asset, so turning opacity
    // down on one squid would dim every squid in the game — including the
    // enemy the asset belongs to. Scale is per instance and cannot do that.
    const t = Math.min(1, sq.life / Math.max(0.0001, sq.maxLife));
    const shrink = 1 - Math.max(0, (t - 0.6) / 0.4);
    sq.mesh.scale.setScalar(sq.size * shrink * (1 + pop * heat));

    if (t >= 1) {
      retireSquid(scene, sq);
      squids.splice(i, 1);
    }
  }
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
      const c0 = CONFIG.calamari;
      // The seal's motion AT THE MOMENT OF FIRING, kept on the wave rather than
      // read again later: the squid release seconds after this and would
      // otherwise inherit whatever the seal happened to be doing then, which is
      // a different animal's momentum by the time it lands.
      const pvx = player.velocity?.x ?? 0;
      const pvy = player.velocity?.y ?? 0;
      const w = {
        mesh,
        radius: 0,
        maxRadius: s.maxRadius,
        hit: new Set(),
        damage: s.damage,
        knockback: s.knockback,
        // Inherited drift, decayed by carryDrag and fought by follow.
        vx: pvx * (c0.carry ?? 0),
        vy: pvy * (c0.carry ?? 0),
        emitVx: pvx,
        emitVy: pvy,
        released: false,
        // 0..1, stoked by the bodies the front crosses and spent on the ring's
        // own brightness. See systems/damageGlow.js.
        heat: 0,
      };
      waves.push(w);
      const n = calamariSquidCount(level);
      // Offset by half a step each wave so successive rings don't stack their
      // squid in the same spokes.
      const phase = (waves.length % 2) * (n ? Math.PI / n : 0);
      for (let k = 0; k < n; k++) addSquid(scene, w, phase + (k / n) * TAU);
      hooks.onWave?.(playerPos.x, playerPos.y);
    }
  }

  const c = CONFIG.calamari;

  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    const prevRadius = w.radius;
    w.radius += c.speed * dt;

    // THE CENTRE MOVES. Two forces, in this order, and the order matters: the
    // inherited drift is spent first so the wave leaves the seal, then `follow`
    // reels it back. Run the other way round the follow would be undone by the
    // carry on the same frame and the ring would never look attached at all.
    //
    // `follow` is a rate, so the approach is exponential rather than a fixed
    // fraction per frame — the same slosh at 30fps and at 120.
    // exp, not (1 - rate * dt): a long frame on a loaded machine can drive the
    // linear form negative, which is drift that REVERSES instead of dying.
    const drag = Math.exp(-(c.carryDrag ?? 0) * dt);
    w.vx *= drag;
    w.vy *= drag;
    w.mesh.position.x += w.vx * dt;
    w.mesh.position.y += w.vy * dt;
    const a = 1 - Math.exp(-(c.follow ?? 0) * dt);
    w.mesh.position.x += (playerPos.x - w.mesh.position.x) * a;
    w.mesh.position.y += (playerPos.y - w.mesh.position.y) * a;

    // Carried to now; stoked below by whatever the front crosses this frame.
    w.heat = cool(w.heat, GLOW_SOURCE, dt);
    const heat = glowLevel(w.heat, GLOW_SOURCE);
    const g = damageGlowCfg(GLOW_SOURCE);

    w.mesh.scale.setScalar(w.maxRadius);
    const u = w.mesh.material.uniforms;
    u.uTime.value += dt;
    // OVERDRIVEN PAST 1, not tinted toward the hot colour — the same choice
    // attachDamageGlow makes for an unlit material, and the reason is the
    // same: pulling the hue over would RECOLOUR the wave, where this lights
    // it. The material is additive and per wave, so the overdrive lands in the
    // bright pass and only this ring flares.
    u.uColor.value.set(c.color).multiplyScalar(1 + g.peak * heat);
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

    // Counted rather than stoked per body: the envelope saturates at 1, and a
    // front sweeping a school should read hotter than one that clipped a crab
    // — which is what stoke's `hits` argument is for. Spent once, after the
    // loop, so the count is the whole frame's and not the first hit's.
    let hits = 0;

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

      hits += 1;
      hooks.onEnemyDamaged?.(e, w.damage);
      // ON THE WAVEFRONT, not on the enemy — the same call the shrimp ring
      // makes and for the same reason: the ring is the thing that hit, and a
      // clack coming off the expanding circle is what says so. The enemy may
      // be well inside or outside the band and still be caught by it.
      hooks.onContact?.(
        w.mesh.position.x + (dx / len) * w.radius,
        w.mesh.position.y + (dy / len) * w.radius,
      );
      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, j);
      }
    }

    if (hits) {
      // The wave and every squid still riding it, together: they are one
      // object on this ability, and a hot ring carrying cold squid would read
      // as the squid being unrelated to it.
      w.heat = stoke(w.heat, GLOW_SOURCE, hits);
      for (const sq of squids) if (sq.wave === w) sq.heat = w.heat;
    }

    // The squid let go part-way out, near where the shader starts dissipating.
    if (!w.released && w.radius >= w.maxRadius * (c.squidRelease ?? 1)) {
      w.released = true;
      for (const sq of squids) if (sq.wave === w) releaseSquid(sq);
    }

    if (w.radius >= w.maxRadius) {
      // Anything still holding on goes now — a wave leaving the scene with
      // squid attached would strand them reading a dead mesh's position.
      if (!w.released) for (const sq of squids) if (sq.wave === w) releaseSquid(sq);
      scene.remove(w.mesh);
      pool.push(w.mesh);
      waves.splice(i, 1);
    }
  }

  updateSquids(dt, scene);
}

/** Live waves and squid. Diagnostics and tests only. */
export function calamariDebug() {
  return { waves, squids };
}
