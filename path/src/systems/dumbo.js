import * as THREE from 'three';
import { faceSide } from './facing.js';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { createAnimationController, stateForSpeed } from './animation.js';
import { orbitTarget, springFollow } from './orbit.js';
import { aoe, applyCompanionScale } from './scaling.js';
import { canControl, charmEnemy } from './control.js';

// Dumbo Octopus — a companion that swims alongside the seal and charms
// enemies. A charmed creature is PACIFIED and nothing more: it stops chasing,
// stops dealing contact damage, and drifts there looking dazed until the charm
// wears off. It doesn't fight for you and it doesn't take damage differently.
//
// So this is crowd control, not DPS — the only ability in the roster whose
// entire job is to make a fight smaller while you deal with the rest of it.
// It pairs with everything that wants a stationary target and competes with
// nothing, which is deliberate.
//
// Charm uses `e.charmTimer`, kept separate from the beluga's `e.trapTimer` so
// the two can overlap without cutting each other short. The "harmless" half is
// enforced in combat.js, which skips contact damage for either timer.
//
// AGAINST A BOSS the pulse lands as a DAZE — a couple of seconds of heavy slow
// with the heading weaving, its next tell cancelled, and its contact damage
// still on. It is not a charm and never becomes one: a boss fighting for you is
// the fight being over. The conversion is charmEnemy's, not this file's, so the
// octopus does not know it is happening — see systems/control.js.

// Two nested objects, the mandatory convention for anything that swims —
// see the long note in systems/beluga.js for why these can't share an object:
//   octo   — outer, owns position and the heading rotation on Z
//   visual — inner, owns ONLY the left/right mirror on Y
let octo = null;
let visual = null;
// Tied to the specific mesh instance, so buildOcto remakes it — same reason
// rebuildEelCompanion rebuilds its controller rather than reusing one.
let anim = null;
let charmTimer = 0;
const octoPos = new THREE.Vector3();
const octoVel = new THREE.Vector3();

function buildOcto() {
  const root = new THREE.Group();
  visual = createVisual('dumboOcto');
  anim = CONFIG.animation.enabled ? createAnimationController(visual) : null;
  root.add(visual);
  return root;
}

export function createDumboOcto() {
  octo = buildOcto();
  octo.visible = false;
  return octo;
}

// Singleton created once at boot, not cloned per instance — without an
// explicit swap a model uploaded from the T panel wouldn't show up until a
// full reload. Same shape as rebuildBelugaDrone.
export function rebuildDumboOcto(scene) {
  if (!octo) return;
  const { position, visible } = octo;
  scene.remove(octo);
  octo = buildOcto();
  octo.position.copy(position);
  octo.visible = visible;
  scene.add(octo);
}

export function resetDumbo(playerPos) {
  charmTimer = 0;
  octoPos.set(playerPos?.x ?? 0, playerPos?.y ?? 0, 0);
  octoVel.set(0, 0, 0);
  if (octo) octo.visible = false;
}

export function currentDumboStats(level) {
  const c = CONFIG.dumbo;
  return {
    interval: Math.max(c.intervalFloor, c.interval - c.intervalPerLevel * (level - 1)),
    // The charm pulse is an area effect centred on the octopus, so it takes
    // the full Splash Zone multiplier.
    range: aoe(c.range + c.rangePerLevel * (level - 1)),
    duration: c.duration + c.durationPerLevel * (level - 1),
    // How many it can charm in one pulse — the stack's real payoff, since a
    // single charm at high enemy counts stops mattering quickly.
    targets: c.targets + Math.floor((level - 1) * c.targetsPerLevel),
  };
}

// hooks: { onCharm(enemy) } — for feedback only, no damage involved.
export function updateDumbo(dt, playerPos, level, enemiesList, clock, hooks = {}) {
  if (!octo) return;

  const active = level > 0;
  octo.visible = active;
  if (!active) return;

  const to = orbitTarget(clock, playerPos, CONFIG.dumbo);
  springFollow(octoPos, octoVel, to, dt, CONFIG.dumbo.followSpring, CONFIG.dumbo.followDamping);
  octo.position.copy(octoPos);
  applyCompanionScale(visual);

  // Heading on the OUTER object, mirror on the INNER one. Screen-plane
  // velocity only, so swinging through depth doesn't tip the model over.
  const spd = Math.hypot(octoVel.x, octoVel.y);
  anim?.update(dt, stateForSpeed(spd), false);
  if (spd > 0.3) {
    octo.rotation.z = Math.atan2(octoVel.y, octoVel.x) - Math.PI / 2;
    // Turned, not flipped — see systems/facing.js.
    faceSide(visual, octoVel.x, dt);
  }

  const s = currentDumboStats(level);
  charmTimer -= dt;
  if (charmTimer > 0) return;
  charmTimer = s.interval;

  // Charm the nearest un-charmed enemies in range. Nearest-first rather than
  // whatever the array happens to hold, so a pulse defuses what's actually
  // closing on you instead of something harmlessly far away.
  const candidates = [];
  for (const e of enemiesList) {
    if (e.charmTimer > 0) continue;
    // A boss is still never CHARMED — it takes the daze instead (see
    // systems/control.js), which is why this asks canControl rather than
    // canHold. The distinction earns its keep during the recovery window: a
    // boss that has just shaken one off drops out of the candidate list
    // entirely, so the pulse pacifies the fish beside it instead of being
    // spent on a creature that cannot take anything right now. Out of the list
    // rather than refused after the sort, so a pulse with `targets: 2` always
    // spends both on something.
    if (!canControl(e)) continue;
    const dx = e.mesh.position.x - octo.position.x;
    const dy = e.mesh.position.y - octo.position.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > s.range * s.range) continue;
    candidates.push({ e, d2 });
  }
  if (candidates.length === 0) return;

  candidates.sort((a, b) => a.d2 - b.d2);
  for (let i = 0; i < Math.min(s.targets, candidates.length); i++) {
    const e = candidates[i].e;
    // Through charmEnemy rather than writing the field, which is what buys the
    // boss's daze conversion for free — and the latch, so a pulse landing on a
    // fish another source already charmed can only ever lengthen it.
    if (charmEnemy(e, s.duration)) hooks.onCharm?.(e);
  }
}
