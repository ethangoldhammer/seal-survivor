import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { removeEnemy } from '../entities/enemies.js';
import { createVisual } from '../assets.js';
import { createAnimationController, stateForSpeed } from './animation.js';
import { weatherState } from './weather.js';

let cooldown = 0;
const activeBolts = []; // { mesh, life }

// The eel's storm response. Weather makes the chain lightning visibly angrier:
// brighter, thicker, thrashing further off the straight line, throwing many
// more dead-end forks.
//
// Returned as a SNAPSHOT taken once per bolt rather than read live at each of
// the dozen places along the bolt path that touch CONFIG.eel. A storm is
// easing in and out continuously, and sampling it separately per hop and per
// branch would let one arc be built from several different storm intensities —
// a bolt whose first half is calm and second half is furious.
//
// Every multiplier folds in as 1 + (mul - 1) * intensity, so at intensity 0
// this returns CONFIG.eel untouched and clear weather behaves exactly as it
// always did. `damageInStorm` defaults to 1: a storm changes how the ability
// READS without quietly changing how strong it is.
// Exported for tools/ability-smoke.mjs. The storm response is otherwise only
// observable as pixels, and "the lightning looks angrier" is not something a
// terminal can check — but the numbers it derives are, and those are the whole
// mechanism.
export function eelCfg() {
  const c = CONFIG.eel;
  const st = c.storm;
  const k = st?.enabled ? Math.max(0, Math.min(1, weatherState.intensity ?? 0)) : 0;
  if (k <= 0) return c;

  const ramp = (mul) => 1 + ((mul ?? 1) - 1) * k;
  return {
    ...c,
    boltGlow: c.boltGlow * ramp(st.glowMul),
    coreWidth: c.coreWidth * ramp(st.widthMul),
    glowWidth: c.glowWidth * ramp(st.widthMul),
    noiseAmplitude: c.noiseAmplitude * ramp(st.amplitudeMul),
    noiseContrast: c.noiseContrast * ramp(st.contrastMul),
    // Clamped: branchChance is tested against a 0..1 hash, so a multiplied
    // value above 1 would mean "every fork, always" and the arc would stop
    // reading as lightning and start reading as a bush.
    branchChance: Math.min(1, c.branchChance * ramp(st.branchChanceMul)),
    branchesPerHop: c.branchesPerHop * ramp(st.branchesPerHopMul),
    flickerSpeed: c.flickerSpeed * ramp(st.flickerMul),
    boltLife: c.boltLife * ramp(st.lifeMul),
    boltColor: new THREE.Color(c.boltColor)
      .lerp(new THREE.Color(st.color ?? c.boltColor), (st.colorMix ?? 0) * k)
      .getHex(),
  };
}

// A companion eel that swims near the ship — the chain lightning originates
// from its position rather than the ship's, and it gets the same
// idle/swim/boost animation state machine every other creature uses,
// driven by its own follow velocity rather than the player's.
let companionMesh = null;
let companionAnim = null;
const companionPos = new THREE.Vector2();
const companionVel = new THREE.Vector2();
let wiggleClock = 0;

export function createEelCompanion() {
  companionMesh = createVisual('eelCompanion');
  companionAnim = createAnimationController(companionMesh);
  return companionMesh;
}

// Same singleton-swap need as the beluga drone — see rebuildBelugaDrone's
// comment. The animation controller is tied to the specific mesh instance,
// so it has to be rebuilt too, not just the mesh.
export function rebuildEelCompanion(scene) {
  if (!companionMesh) return;
  const { position, visible, rotation } = companionMesh;
  scene.remove(companionMesh);
  companionMesh = createVisual('eelCompanion');
  companionMesh.position.copy(position);
  companionMesh.rotation.copy(rotation);
  companionMesh.visible = visible;
  companionAnim = createAnimationController(companionMesh);
  scene.add(companionMesh);
}

export function resetEelCompanion(playerPos) {
  companionPos.set(playerPos.x, playerPos.y);
  companionVel.set(0, 0);
  wiggleClock = 0;
}

// Spring-follows an offset behind/below the player with a gentle wiggle. A
// damped spring rather than a fixed offset, so it lags naturally on turns
// instead of snapping into place every frame.
function updateCompanion(dt, playerPos, level) {
  const active = level > 0;
  companionMesh.visible = active;
  if (!active) return playerPos;

  wiggleClock += dt;
  const targetX = playerPos.x - 1.6;
  const targetY = playerPos.y - 0.6 + Math.sin(wiggleClock * 2) * 0.3;

  const k = 30;
  const damping = Math.exp(-6 * dt);
  companionVel.x = (companionVel.x + (targetX - companionPos.x) * k * dt) * damping;
  companionVel.y = (companionVel.y + (targetY - companionPos.y) * k * dt) * damping;
  companionPos.x += companionVel.x * dt;
  companionPos.y += companionVel.y * dt;
  companionMesh.position.set(companionPos.x, companionPos.y, 0.05);

  const speed = companionVel.length();
  if (speed > 0.3) companionMesh.rotation.z = Math.atan2(companionVel.y, companionVel.x) - Math.PI / 2;
  if (CONFIG.animation.enabled && companionAnim) companionAnim.update(dt, stateForSpeed(speed), false);

  return { x: companionPos.x, y: companionPos.y };
}

export function resetEel() {
  cooldown = 0;
}

export function currentEelStats(level) {
  const st = CONFIG.eel.storm;
  // 1 by default, so the storm is a look and not a balance change. Raising it
  // above 1 is the one knob that makes weather genuinely matter to output —
  // deliberately opt-in, because a run's damage silently doubling when the sky
  // changes is very hard to read from inside the fight.
  const k = st?.enabled ? Math.max(0, Math.min(1, weatherState.intensity ?? 0)) : 0;
  const damageMul = 1 + ((st?.damageInStorm ?? 1) - 1) * k;

  return {
    damage: (CONFIG.eel.baseDamage + CONFIG.eel.damagePerLevel * (level - 1)) * damageMul,
    chainRadius: CONFIG.eel.baseChainRadius + CONFIG.eel.radiusPerLevel * (level - 1),
    maxChain: Math.round(CONFIG.eel.baseMaxChain + CONFIG.eel.chainPerLevel * (level - 1)),
  };
}

// --- bolt geometry -------------------------------------------------------
// Each hop between two targets is a spline displaced PERPENDICULAR to the
// hop direction by layered value noise. Layering octaves (each finer and
// weaker than the last) is what turns a smooth curve into a jagged arc;
// raising the contrast exponent pushes the noise toward spikes and flats
// instead of gentle waves, which is what reads as electricity. Branches are
// short dead-end forks thrown off the main path.

function hash11(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

// Smooth 1D value noise, so consecutive spline points stay related instead
// of being independently random (which would look like static, not an arc).
function valueNoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash11(i) * (1 - u) + hash11(i + 1) * u;
}

// Layered octaves, remapped to -1..1 and contrast-shaped.
function fbm(x, octaves, contrast) {
  let sum = 0;
  let amp = 1;
  let totalAmp = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq) * amp;
    totalAmp += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  const n = (sum / totalAmp) * 2 - 1; // -1..1
  // Contrast > 1 must push values TOWARD the extremes. Since |n| <= 1,
  // raising to a power >1 shrinks it (flattening the arc into gentle waves —
  // the opposite of what "high contrast" means here), so the exponent is
  // inverted: 1/contrast expands, giving the spiky, mostly-hard-over
  // displacement that reads as electricity.
  return Math.sign(n) * Math.pow(Math.abs(n), 1 / Math.max(0.05, contrast));
}

// Build the displaced point list for one hop, plus any branches off it.
function hopPoints(a, b, seed, t, cfg) {
  const segs = Math.max(2, Math.round(cfg.segmentsPerHop));
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length() || 1;
  dir.divideScalar(len);
  const perp = new THREE.Vector3(-dir.y, dir.x, 0);

  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const f = i / segs;
    const p = new THREE.Vector3().lerpVectors(a, b, f);
    // Taper displacement to zero at both ends so the arc actually touches
    // the two creatures instead of floating near them.
    const taper = Math.sin(f * Math.PI);
    const n = fbm(seed + f * 6 + t * cfg.noiseScrollSpeed * 0.1, Math.round(cfg.noiseOctaves), cfg.noiseContrast);
    p.addScaledVector(perp, n * cfg.noiseAmplitude * taper * len * 0.25);
    pts.push(p);
  }
  return { pts, dir, perp, len };
}

// Expand a point list into a RIBBON (two triangles per segment) instead of
// a line. WebGL ignores LineBasicMaterial.linewidth entirely — every line
// renders exactly one pixel wide regardless of what you set — so the
// original line-based bolt was an invisible hairline and the width/glow
// controls did nothing at all. Real geometry is the only way to get width.
function ribbonFromPoints(pts, width, taperEnds) {
  const positions = [];
  const indices = [];
  const up = new THREE.Vector3(0, 0, 1);
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();

  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    dir.subVectors(next, prev);
    if (dir.lengthSq() < 1e-10) dir.set(1, 0, 0);
    dir.normalize();
    // Taper toward the ends so the arc comes to a point rather than
    // stopping in a blunt rectangle.
    const t = pts.length > 1 ? i / (pts.length - 1) : 0.5;
    const w = width * 0.5 * (taperEnds ? Math.sin(t * Math.PI) * 0.85 + 0.15 : 1);
    side.crossVectors(dir, up).normalize().multiplyScalar(w);
    const p = pts[i];
    positions.push(p.x + side.x, p.y + side.y, p.z, p.x - side.x, p.y - side.y, p.z);
    if (i < pts.length - 1) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

function buildBoltGeometry(points, t, cfg) {
  const mainRuns = [];
  const branchRuns = [];

  for (let i = 0; i < points.length - 1; i++) {
    const seed = i * 17.3 + points.length * 3.1;
    const { pts, perp, len } = hopPoints(points[i], points[i + 1], seed, t, cfg);
    mainRuns.push(pts);

    // Forks: start partway along the hop and shoot off at an angle, ending
    // in mid-water — dead ends are what make chain lightning look like it's
    // searching for a path.
    for (let bIdx = 0; bIdx < Math.round(cfg.branchesPerHop); bIdx++) {
      if (hash11(seed * 3.7 + bIdx * 11.9) > cfg.branchChance) continue;
      const startIdx = 2 + Math.floor(hash11(seed + bIdx) * (pts.length - 4));
      if (startIdx < 0 || startIdx >= pts.length - 1) continue;
      const from = pts[startIdx];
      const away = new THREE.Vector3().subVectors(pts[startIdx + 1], from).normalize();
      const sideSign = hash11(seed + bIdx * 5.5) > 0.5 ? 1 : -1;
      const bDir = new THREE.Vector3()
        .addScaledVector(away, 0.6)
        .addScaledVector(perp, sideSign * 0.8)
        .normalize();
      const bLen = len * cfg.branchLength * (0.5 + hash11(seed + bIdx * 2.2) * 0.7);
      const bEnd = new THREE.Vector3().copy(from).addScaledVector(bDir, bLen);
      branchRuns.push(hopPoints(from, bEnd, seed + bIdx * 31.1, t, cfg).pts);
    }
  }
  return { mainRuns, branchRuns };
}

function spawnBolt(scene, points) {
  const cfg = eelCfg();
  const t = performance.now() / 1000;
  const { mainRuns, branchRuns } = buildBoltGeometry(points, t, cfg);
  const group = new THREE.Group();
  const colour = new THREE.Color(cfg.boltColor);

  const addRibbons = (runs, width, opacity, glowMul) => {
    if (!runs.length) return;
    const mat = new THREE.MeshBasicMaterial({
      color: colour.clone().multiplyScalar(cfg.boltGlow * glowMul),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.userData.baseOpacity = opacity;
    for (const pts of runs) group.add(new THREE.Mesh(ribbonFromPoints(pts, width, true), mat));
  };

  // Wide soft halo behind a bright thin core — both real geometry now, so
  // the width sliders genuinely change the arc's thickness.
  addRibbons(mainRuns, cfg.glowWidth, cfg.glowOpacity, 0.4);
  addRibbons(mainRuns, cfg.coreWidth, 1, 1);
  addRibbons(branchRuns, cfg.glowWidth * 0.5, cfg.glowOpacity * cfg.branchTaper, 0.35);
  addRibbons(branchRuns, cfg.coreWidth * 0.6, cfg.branchTaper, 0.8);

  group.position.z = 0.12;
  scene.add(group);
  // flickerSpeed rides along on the bolt rather than being read from CONFIG
  // during the fade, for the same reason the rest of the snapshot exists: the
  // storm can ease out while a bolt is still fading, and a bolt that changes
  // its crackle rate halfway through its own fade reads as a stutter.
  activeBolts.push({ mesh: group, life: cfg.boltLife, maxLife: cfg.boltLife, flickerSpeed: cfg.flickerSpeed });
}

// hooks: { onEnemyDamaged(e, dmg), onEnemyKilled(e),
//          onBolt(x, y), onChainLink(x, y, index) }
//
// The two new ones split the ability's sound and rumble the way it actually
// behaves: onBolt fires ONCE at the eel, for the discharge, and onChainLink
// fires per hop at the creature that hop landed on. Doing it with one event
// at the eel would make a six-target chain feel identical to a one-target
// one, which is the whole ability.
export function updateEel(dt, scene, playerPos, level, enemiesList, hooks) {
  // Fade/remove existing bolts regardless of whether the eel is active this
  // frame — a bolt from a moment ago should still finish its fade.
  for (let i = activeBolts.length - 1; i >= 0; i--) {
    const b = activeBolts[i];
    b.life -= dt;
    const f = Math.max(0, b.life / b.maxLife);
    // Flicker on top of the fade so it crackles out rather than dimming
    // smoothly like a fading line.
    const flick = 0.65 + 0.35 * Math.sin(b.life * (b.flickerSpeed ?? CONFIG.eel.flickerSpeed));
    for (const child of b.mesh.children) {
      child.material.opacity = f * flick * (child.material.userData.baseOpacity ?? 1);
    }
    if (b.life <= 0) {
      scene.remove(b.mesh);
      for (const child of b.mesh.children) {
        child.geometry.dispose();
        child.material.dispose();
      }
      activeBolts.splice(i, 1);
    }
  }

  const origin = updateCompanion(dt, playerPos, level);
  if (level <= 0) return;
  cooldown -= dt;
  if (cooldown > 0) return;
  cooldown = CONFIG.eel.fireRate;

  const stats = currentEelStats(level);

  let current = null;
  let bestD = CONFIG.eel.initialRange;
  for (const e of enemiesList) {
    const d = Math.hypot(e.mesh.position.x - origin.x, e.mesh.position.y - origin.y);
    if (d < bestD) { bestD = d; current = e; }
  }
  if (!current) return;

  const points = [new THREE.Vector3(origin.x, origin.y, 0)];
  const visited = new Set();
  let target = current;

  for (let i = 0; i < stats.maxChain && target; i++) {
    visited.add(target);
    points.push(target.mesh.position.clone());

    // Read the position BEFORE the kill below can remove the mesh from the
    // scene — the link landed there whether or not the creature survived it.
    const linkX = target.mesh.position.x;
    const linkY = target.mesh.position.y;

    target.hp -= stats.damage;
    target.flash = CONFIG.fx.hitFlash;
    target.hitThisFrame = true;
    hooks.onEnemyDamaged?.(target, stats.damage);
    hooks.onChainLink?.(linkX, linkY, i);

    if (target.hp <= 0) {
      hooks.onEnemyKilled?.(target);
      const idx = enemiesList.indexOf(target);
      if (idx >= 0) removeEnemy(scene, idx);
    }

    let next = null;
    let nd = stats.chainRadius;
    for (const e of enemiesList) {
      if (visited.has(e) || e.hp <= 0) continue;
      const d = e.mesh.position.distanceTo(target.mesh.position);
      if (d < nd) { nd = d; next = e; }
    }
    target = next;
  }

  if (points.length > 1) {
    spawnBolt(scene, points);
    // At the eel, not the player — the arc originates from the companion, and
    // the sound coming from anywhere else is the one thing that would give
    // away that the eel is decorative.
    hooks.onBolt?.(origin.x, origin.y);
  }
}

export function resetEelBolts(scene) {
  for (const b of activeBolts) {
    scene.remove(b.mesh);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
  }
  activeBolts.length = 0;
}
