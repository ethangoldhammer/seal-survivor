import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { bounds } from '../arena.js';
import { removeEnemy } from '../entities/enemies.js';
import { createAnimationController } from './animation.js';
import { aoe, targeting } from './scaling.js';

// SEAGULL BOMB — an attack run, not a projectile.
//
// A gull enters from off the side of the arena at altitude, cruises in over
// the water alternating flapping flight and glides, picks the densest knot of
// crabs on the seabed, and once it is overhead commits to a dive it holds all
// the way down. It is the crab layer's counter: crabs gather on your dropped
// chum, and the gulls come for the crabs.
//
// It is deliberately NOT built on entities/projectiles.js. A projectile has
// one velocity and one asset; this has flight phases, an animation state per
// phase, and a target it chooses in the air. Fitting that into the projectile
// struct would have meant special-casing the projectile update for one user.
//
// Phases:
//   'soar' — crossing the sky toward the target's X, flap/glide alternating
//   'dive' — committed, gaining speed, dive clip looped until it connects
//
// The three flight clips are ranges carved out of the model's single baked
// take; see ASSETS.seagull.subclips. This file drives them by name and never
// goes through stateForSpeed(): 'idle' is the glide, 'swim' the flap, 'boost'
// the dive.
const GLIDE = 'idle';
const FLAP = 'swim';
const DIVE = 'boost';

// How far past the arena edge a gull spawns and despawns.
const OFFSCREEN_MARGIN = 4;

const DEG = Math.PI / 180;

const gulls = [];

export function resetSeagulls(scene) {
  for (const g of gulls) scene.remove(g.container);
  gulls.length = 0;
}

export function seagullCount() {
  return gulls.length;
}

// Which enemies a gull considers food: anything living on the seabed — the
// crawlers and the anchored traps — rather than a hardcoded species list, so
// a new crab slots in without touching this file.
function isCrabLike(e) {
  return e.def.behavior === 'crawl' || e.def.behavior === 'trap';
}

// The "pile": the crab with the most neighbours within clusterRadius. Returns
// the centroid of that knot, so the gull aims at the middle of a group rather
// than at whichever individual it happened to score first.
function findCrabCluster(enemiesList) {
  const c = CONFIG.seagullBomb;
  // Acquisition: how wide a knot of crabs counts as one pile worth diving on.
  const r2 = targeting(c.clusterRadius) ** 2;
  let best = null;
  let bestCount = 0;
  for (const e of enemiesList) {
    if (!isCrabLike(e)) continue;
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (const o of enemiesList) {
      if (!isCrabLike(o)) continue;
      const dx = o.mesh.position.x - e.mesh.position.x;
      const dy = o.mesh.position.y - e.mesh.position.y;
      if (dx * dx + dy * dy > r2) continue;
      count += 1;
      sx += o.mesh.position.x;
      sy += o.mesh.position.y;
    }
    if (count > bestCount) {
      bestCount = count;
      best = { x: sx / count, y: sy / count, count };
    }
  }
  if (best && best.count >= (c.minClusterSize ?? 1)) return best;
  return null;
}

export function spawnSeagull(scene, enemiesList) {
  const c = CONFIG.seagullBomb;
  const target = findCrabCluster(enemiesList);
  // Nothing on the seabed worth the trip. Skipping the spawn (rather than
  // sending one out to wander) keeps the cooldown meaningful: the next tick
  // tries again, so a gull arrives shortly after the crabs do.
  if (!target) return null;

  // Enter from the side the target is furthest from, so the run has room to
  // read as an approach instead of appearing already on top of it.
  const fromLeft = target.x > (bounds.left + bounds.right) * 0.5;
  const dir = fromLeft ? 1 : -1;

  // Container carries position and heading; the visual inside it carries the
  // left/right flank flip. Same split entities/enemies.js uses for faceMotion
  // — the two rotations must not compound on one object.
  const container = new THREE.Group();
  const visual = createVisual('seagull');
  container.add(visual);
  container.position.set(
    fromLeft ? bounds.left - OFFSCREEN_MARGIN : bounds.right + OFFSCREEN_MARGIN,
    bounds.surfaceY + c.cruiseAltitude,
    0
  );
  scene.add(container);

  const anim = (visual.userData?.clips?.length || visual.userData?.rig)
    ? createAnimationController(visual)
    : null;

  const gull = {
    container,
    visual,
    anim,
    phase: 'soar',
    dir,
    target,
    vx: dir * c.cruiseSpeed,
    vy: 0,
    // Flap and glide alternate on a timer rather than tracking speed: a gull
    // crossing at constant velocity would otherwise sit in one clip the whole
    // way, and the glide is half of what makes it read as a seagull.
    gliding: false,
    phaseTimer: c.flapTime,
    retargetTimer: 0,
    life: c.life,
    // 0..1 through the rotation that cancels the stoop clip's baked pitch —
    // see the heading block in updateSeagulls.
    diveBlend: 0,
  };
  gulls.push(gull);
  return gull;
}

export function updateSeagulls(dt, scene, enemiesList, hooks = {}) {
  const c = CONFIG.seagullBomb;

  for (let i = gulls.length - 1; i >= 0; i--) {
    const g = gulls[i];
    g.life -= dt;
    let state = FLAP;

    if (g.phase === 'soar') {
      g.phaseTimer -= dt;
      if (g.phaseTimer <= 0) {
        g.gliding = !g.gliding;
        g.phaseTimer = g.gliding ? c.glideTime : c.flapTime;
      }
      state = g.gliding ? GLIDE : FLAP;

      // A glide sheds height and a flap regains it, so the cruise undulates
      // instead of tracking a ruler-straight line.
      g.vy += (g.gliding ? -c.glideSink : c.flapLift) * dt;

      // ...pulled back toward the cruising altitude, because the bob does NOT
      // cancel itself out. Lift x flapTime and sink x glideTime are two
      // independently tuned numbers, so any mismatch integrates: the first
      // pass climbed 10 units in 5 seconds and left the top of the screen
      // (the visible sky is only arena.viewHeight * surfaceFromTop tall).
      // A spring keeps the undulation without letting it drift.
      const cruiseY = bounds.surfaceY + c.cruiseAltitude;
      g.vy += (cruiseY - g.container.position.y) * c.altitudeHold * dt;
      g.vy *= 1 - Math.min(1, c.altitudeDamp * dt);

      const vyCap = c.cruiseSpeed * 0.5;
      g.vy = Math.max(-vyCap, Math.min(vyCap, g.vy));
      g.vx = g.dir * c.cruiseSpeed;

      // Retarget while inbound — crabs move, and the pile it picked may have
      // been eaten or killed by the time it gets there.
      g.retargetTimer -= dt;
      if (g.retargetTimer <= 0) {
        g.retargetTimer = c.retargetInterval;
        const fresh = findCrabCluster(enemiesList);
        if (fresh) g.target = fresh;
      }

      // Overhead? Commit. `diveZone` is the horizontal half-width of the
      // trigger, so it fires as the gull passes over the pile rather than
      // while it is still approaching on the diagonal.
      if (Math.abs(g.container.position.x - g.target.x) <= c.diveZone) {
        g.phase = 'dive';
        // Once, at the top of the stoop — the phase flip is edge-triggered by
        // this branch only running while still cruising, so it can't repeat
        // on the way down.
        hooks.onDive?.(g.container.position.x, g.container.position.y);
      }
    } else if (g.phase === 'dive') {
      // Held for the whole plunge — the clip loops rather than playing once,
      // so a long fall doesn't run out of animation partway down.
      state = DIVE;
      // Steer the remaining horizontal error out while accelerating down, so
      // the dive converges on the pile instead of falling past it.
      const dx = g.target.x - g.container.position.x;
      g.vx += Math.max(-1, Math.min(1, dx)) * c.diveSteer * dt;
      g.vx *= 0.96;
      g.vy -= c.diveAccel * dt;
      g.vy = Math.max(-c.diveSpeedMax, g.vy);
    }

    const prevY = g.container.position.y;
    g.container.position.x += g.vx * dt;
    g.container.position.y += g.vy * dt;

    // Breaking the surface on the way down.
    if (prevY > bounds.surfaceY && g.container.position.y <= bounds.surfaceY) {
      hooks.onSplash?.(g.container.position.x, bounds.surfaceY);
    }

    // Nose along the flight path. Model forward is mapped to the container's
    // +Y by the shared orientation code, hence the -90 degrees.
    //
    // ...minus the pitch the DIVE CLIP already contains. The two cruise clips
    // are near-level poses, so aiming the container down the velocity vector is
    // all they need. The stoop is not: it is authored as a tuck with the body
    // already 84 degrees nose-down (ASSETS.seagull.subclips), so a container
    // also aimed at the ground stacked the two and sent the gull down sideways.
    // CONFIG.seagullBomb.divePitch takes it back out.
    //
    // Eased on the clip's own crossfade clock rather than applied the instant
    // the phase flips, or the body would snap through 96 degrees on one frame
    // while the tuck was still fading in.
    const fade = Math.max(0.01, CONFIG.animation?.states?.boost?.fade ?? CONFIG.animation?.crossfade ?? 0.2);
    g.diveBlend = Math.max(0, Math.min(1, g.diveBlend + (g.phase === 'dive' ? dt : -dt) / fade));

    if (Math.hypot(g.vx, g.vy) > 0.05) {
      // Both the flank flip and the correction's sign come off `dir` — the side
      // the run entered from — and NOT off vx. A dive bleeds vx toward zero and
      // steers across it, so reading the sign live lets it cross mid-plunge,
      // which would mirror the bird and jump the correction by 192 degrees.
      // The gull never turns around, so `dir` is the honest answer for both.
      const flip = g.dir < 0 ? -1 : 1;
      const correction = flip * g.diveBlend * (c.divePitch ?? 0) * DEG;
      g.container.rotation.z = Math.atan2(g.vy, g.vx) - Math.PI / 2 + correction;
      if (CONFIG.view === 'side') g.visual.rotation.y = g.dir < 0 ? Math.PI : 0;
    }

    // Impact — only while diving. A gull cruising over the water shouldn't
    // detonate on a crab that happens to pass beneath it.
    if (g.phase === 'dive') {
      let hitIndex = -1;
      for (let k = enemiesList.length - 1; k >= 0; k--) {
        const e = enemiesList[k];
        if (!isCrabLike(e)) continue;
        const dx = e.mesh.position.x - g.container.position.x;
        const dy = e.mesh.position.y - g.container.position.y;
        const reach = e.radius + c.hitRadius;
        if (dx * dx + dy * dy <= reach * reach) { hitIndex = k; break; }
      }
      const grounded = g.container.position.y <= bounds.bottom + c.hitRadius;

      if (hitIndex !== -1 || grounded) {
        const x = g.container.position.x;
        const y = g.container.position.y;
        if (hitIndex !== -1) {
          const hit = enemiesList[hitIndex];
          hit.hp -= c.damage;
          hit.flash = CONFIG.fx.hitFlash;
          hit.hitThisFrame = true;
          hooks.onEnemyDamaged?.(hit, c.damage, x, y);
          if (hit.hp <= 0) {
            hooks.onEnemyKilled?.(hit);
            removeEnemy(scene, hitIndex);
          }
        }
        hooks.onImpact?.(x, y, c.splashDamage, aoe(c.splashRadius));
        scene.remove(g.container);
        gulls.splice(i, 1);
        continue;
      }
    }

    // Left the arena without ever lining up, or ran out of life.
    const offscreen = g.container.position.x > bounds.right + OFFSCREEN_MARGIN
      || g.container.position.x < bounds.left - OFFSCREEN_MARGIN;
    // A gull that has just spawned is legitimately offscreen — only cull one
    // that is heading further out, or the spawn would be removed on frame one.
    const leaving = g.dir > 0
      ? g.container.position.x > bounds.right
      : g.container.position.x < bounds.left;
    if ((offscreen && leaving) || g.life <= 0) {
      scene.remove(g.container);
      gulls.splice(i, 1);
      continue;
    }

    if (CONFIG.animation.enabled && g.anim) g.anim.update(dt, state, false);
  }
}
