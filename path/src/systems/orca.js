import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { boats, damageBoat, hitsBoat } from './boats.js';
import { createAnimationController, stateForSpeed } from './animation.js';

// Orca Family — a pod of three that hunts the SURFACE BOATS specifically.
//
// Boats are the threat the rest of the arsenal handles worst. They sit up at
// the waterline, out of the way of the fight the seal is actually in, and chip
// away while you're busy below; dealing with one means breaking off, swimming
// up, and spending time where the fish aren't. Every other companion targets
// whatever is nearest, which in practice always means fish.
//
// So this pod deliberately looks PAST fish. Boat first, every time, out to
// `huntRange`; fish only when there is no boat left to hunt, and even then
// only fish above `fallbackMinRadius`, so it never degenerates into a third
// seal team mopping up minnows.
//
// The pod is fixed at `count` and stacks make them hit harder and hunt more
// often, rather than adding orcas. Splitting three across three levels would
// mean the first card bought one lone orca — and a lone orca is not the thing
// the card is promising.

const pod = []; // { root, visual, anim, pos, vel, state, target, cooldown, slot }
let clock = 0;

const _to = new THREE.Vector3();

export function podStats(level) {
  const c = CONFIG.orca;
  const lv = Math.max(1, level);
  return {
    damage: c.damage + c.damagePerLevel * (lv - 1),
    interval: Math.max(c.attackIntervalFloor, c.attackInterval - c.attackIntervalPerLevel * (lv - 1)),
    chargeSpeed: c.chargeSpeed + c.chargeSpeedPerLevel * (lv - 1),
  };
}

function buildOrca() {
  // Outer object owns position and heading; inner owns the left/right mirror.
  // They can't be the same object — the heading rotation would invert the
  // moment an orca swims left. Same arrangement as the seal team and the
  // beluga drone, and for the same reason.
  const root = new THREE.Group();
  const visual = createVisual('orcaFriend');
  root.add(visual);
  const anim = CONFIG.animation.enabled ? createAnimationController(visual) : null;
  return { root, visual, anim };
}

function newMember(root, visual, anim, slot, pos) {
  return {
    root, visual, anim, slot,
    pos: pos.clone(),
    vel: new THREE.Vector3(),
    state: 'cruise',
    target: null, // { kind: 'boat' | 'fish', ref }
    // Staggered from the start so all three don't breach the same hull on the
    // same frame — the pod should read as taking turns, not as a volley.
    cooldown: slot * 0.45,
  };
}

function resize(scene, count, playerPos) {
  while (pod.length < count) {
    const { root, visual, anim } = buildOrca();
    const c = CONFIG.orca;
    const start = new THREE.Vector3(
      playerPos.x + c.formationOffset[0],
      playerPos.y + c.formationOffset[1] + pod.length * c.formationSpacing,
      0,
    );
    root.position.copy(start);
    scene.add(root);
    pod.push(newMember(root, visual, anim, pod.length, start));
  }
  while (pod.length > count) {
    const m = pod.pop();
    scene.remove(m.root);
  }
}

// Rebuilt on a model swap from the T panel, same as every other companion.
export function rebuildOrcaPod(scene) {
  for (const m of pod) {
    scene.remove(m.root);
    const { root, visual, anim } = buildOrca();
    root.position.copy(m.pos);
    m.root = root;
    m.visual = visual;
    m.anim = anim;
    scene.add(root);
  }
}

// Where an idle orca sits: a loose line abreast trailing the seal.
function formationPoint(m, playerPos, out) {
  const c = CONFIG.orca;
  const lane = m.slot - (pod.length - 1) / 2;
  return out.set(
    playerPos.x + c.formationOffset[0] + Math.sin(clock * 0.6 + m.slot) * 0.5,
    playerPos.y + c.formationOffset[1] + lane * c.formationSpacing + Math.sin(clock * 0.9 + m.slot * 1.7) * 0.35,
    0,
  );
}

// Boat first, always. Fish only when the sea is clear of hulls.
function acquire(m, enemiesList) {
  const c = CONFIG.orca;
  const range2 = c.huntRange * c.huntRange;
  let best = null;
  let bestD2 = range2;

  for (const b of boats) {
    const dx = b.mesh.position.x - m.pos.x;
    const dy = b.mesh.position.y - m.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = { kind: 'boat', ref: b }; }
  }
  if (best) return best;

  for (const e of enemiesList) {
    if (e.radius < c.fallbackMinRadius) continue;
    const dx = e.mesh.position.x - m.pos.x;
    const dy = e.mesh.position.y - m.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = { kind: 'fish', ref: e }; }
  }
  return best;
}

// Is this target still something worth swimming at? A boat sunk or a fish
// killed by something else mid-charge has to drop the orca back to cruising,
// or it charges a hole in the water.
function targetAlive(target, enemiesList) {
  if (!target) return false;
  if (target.kind === 'boat') return boats.includes(target.ref);
  return enemiesList.includes(target.ref);
}

function faceTravel(m, dt) {
  const speed = Math.hypot(m.vel.x, m.vel.y);
  if (speed > 0.4) {
    m.root.rotation.z = Math.atan2(m.vel.y, m.vel.x);
    // Mirror rather than rolling belly-up when swimming leftward.
    m.visual.rotation.y = m.vel.x < 0 ? Math.PI : 0;
  }
  if (m.anim) m.anim.update(dt, stateForSpeed(speed), false);
}

/**
 * hooks: {
 *   onBoatHit(boat, dmg, x, y), onBoatDestroyed(boat, chum),
 *   onEnemyDamaged(e, dmg, x, y), onEnemyKilled(e),
 *   onStrike(x, y),
 * }
 */
export function updateOrcaPod(dt, scene, playerPos, level, enemiesList, hooks = {}) {
  const active = level > 0;
  if (!active) {
    if (pod.length) resize(scene, 0, playerPos);
    return;
  }

  const c = CONFIG.orca;
  const s = podStats(level);
  clock += dt;

  resize(scene, c.count, playerPos);

  const point = new THREE.Vector3();

  for (const m of pod) {
    if (m.cooldown > 0) m.cooldown -= dt;
    if (!targetAlive(m.target, enemiesList)) { m.target = null; m.state = 'cruise'; }

    if (m.state === 'cruise') {
      formationPoint(m, playerPos, point);
      // Spring back into the line rather than steering to it, so a pod
      // returning from a kill drifts home instead of snapping.
      const damping = Math.exp(-4 * dt);
      m.vel.x = (m.vel.x + (point.x - m.pos.x) * c.formationFollow * dt) * damping;
      m.vel.y = (m.vel.y + (point.y - m.pos.y) * c.formationFollow * dt) * damping;

      const cruiseMax = c.cruiseSpeed;
      const sp = Math.hypot(m.vel.x, m.vel.y);
      if (sp > cruiseMax) { m.vel.x *= cruiseMax / sp; m.vel.y *= cruiseMax / sp; }

      if (m.cooldown <= 0) {
        const found = acquire(m, enemiesList);
        if (found) { m.target = found; m.state = 'charge'; }
      }
    } else if (m.state === 'charge') {
      const tp = m.target.ref.mesh.position;
      _to.set(tp.x - m.pos.x, tp.y - m.pos.y, 0);
      const dist = _to.length() || 1e-4;
      _to.divideScalar(dist);

      // Turn-rate limited rather than steering instantly, so a charge reads as
      // a committed run the target could in principle swim out of.
      const want = Math.atan2(_to.y, _to.x);
      const have = Math.atan2(m.vel.y, m.vel.x);
      const delta = Math.atan2(Math.sin(want - have), Math.cos(want - have));
      const turn = Math.max(-c.turnRate * dt, Math.min(c.turnRate * dt, delta));
      const heading = (Math.hypot(m.vel.x, m.vel.y) > 0.2 ? have : want) + turn;
      m.vel.x = Math.cos(heading) * s.chargeSpeed;
      m.vel.y = Math.sin(heading) * s.chargeSpeed;

      const landed = m.target.kind === 'boat'
        ? hitsBoat(m.target.ref, m.pos.x, m.pos.y, c.hitRadius)
        : dist <= c.hitRadius + m.target.ref.radius;

      if (landed) {
        hooks.onStrike?.(m.pos.x, m.pos.y);

        if (m.target.kind === 'boat') {
          const index = boats.indexOf(m.target.ref);
          if (index >= 0) {
            const boat = m.target.ref;
            damageBoat(scene, index, s.damage, {
              onBoatDestroyed: (bt, chum) => hooks.onBoatDestroyed?.(bt, chum),
            }, { x: m.vel.x, y: m.vel.y }, { x: m.pos.x, y: m.pos.y });
            hooks.onBoatHit?.(boat, s.damage, m.pos.x, m.pos.y);
          }
        } else {
          const e = m.target.ref;
          e.hp -= s.damage;
          e.flash = CONFIG.fx.hitFlash;
          e.hitThisFrame = true;
          const len = Math.hypot(m.vel.x, m.vel.y) || 1;
          e.vx += (m.vel.x / len) * c.knockback;
          e.vy += (m.vel.y / len) * c.knockback;
          hooks.onEnemyDamaged?.(e, s.damage, e.mesh.position.x, e.mesh.position.y);
          if (e.hp <= 0) {
            const index = enemiesList.indexOf(e);
            hooks.onEnemyKilled?.(e);
            if (index >= 0) removeEnemy(scene, index);
          }
        }

        m.cooldown = s.interval;
        m.target = null;
        m.state = 'cruise';
      }
    }

    m.pos.x += m.vel.x * dt;
    m.pos.y += m.vel.y * dt;
    m.root.position.copy(m.pos);
    faceTravel(m, dt);
  }
}

export function resetOrcaPod(scene, playerPos) {
  for (const m of pod) scene.remove(m.root);
  pod.length = 0;
  clock = 0;
}
