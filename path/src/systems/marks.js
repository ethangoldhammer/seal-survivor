import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { isScenery } from '../enemyTable.js';
import {
  makeOrganicRing, placeOrganicRing, updateOrganicRing, disposeOrganicRing,
  setRingThreat, __organicRingShader,
} from './organicRing.js';

// THE MARK — what a strike does to something too big to throw around.
//
// A base strike carries almost no damage (CONFIG.strike.contactDamage). What
// it carries instead is INFORMATION: ram a shark, a crab or a hull and it
// comes away painted, and for the next few seconds every homing weapon the
// seal owns prefers that target over whatever happened to be nearest. The seal
// is the spotter; the mussels, the escort squad and the orca pod are the
// damage. That is the whole reason to swim at something you can't hurt.
//
// Kept in its own module, holding nothing but REFERENCES, because of who has
// to read it: entities/projectiles.js, systems/sealTeam.js and systems/orca.js
// all ask "is this one marked" while picking a target, and they target
// different things — creatures, boats, floating bodies. A mark that lived on
// the enemy list couldn't cover hulls, and one that imported both lists would
// wire a cycle through every targeting system in the game. This imports
// nothing but three and CONFIG, and everything else imports it.
//
// LIVENESS is answered without knowing what the target is. A creature killed
// or a hull sunk is removed from the scene by its own system (removeEnemy,
// updateBoats), so `mesh.parent` going null is the one signal that means
// "gone" for every kind of target there is. Holding a strong reference to a
// dead body for a few frames is fine; holding one forever is not, which is why
// this is checked every tick rather than trusted to the marker.

// ref -> { ref, timer, ring } for everything currently painted. A Map keyed on
// the object itself, so `isMarked` is a hash lookup rather than a scan — it is
// called once per candidate per acquisition, which on a full arena is a few
// hundred times a frame.
const marks = new Map();

let group = null;

// THE RETICLE IS THE SHARED ORGANIC RING (systems/organicRing.js), which owns
// the shader, the noise field and the sweep. What stays here is the two things
// that are genuinely the mark's own.
//
// THE GAPS. `arcs: 4` cuts the ring into four bracket arms with the openings
// on the diagonals, and that is not decoration — it is the only thing keeping
// this apart from the other circles drawn round a body. The beluga's trap and
// the charge meter are closed rings; a closed mark would read as one of them.
// The organic edge breaks the arms up and tears their ends, but the four gaps
// survive it.
//
// THE COLOUR IS THE TARGET'S STATUS. A mark says "every homing weapon prefers
// this" and, now, "and this is what is already happening to it" — the ring
// tints to whatever element is on the body through the same threat palette the
// boss tells read (CONFIG.fx.attackTypes), so a poisoned shark's reticle is
// venom green and a frozen one's is chill blue, each with that element's own
// edge dialect. One glance answers both questions instead of one.
const makeRing = () => makeOrganicRing({
  arcs: 4,
  type: 'kinetic',
  color: CONFIG.strike?.mark?.ring?.color ?? 0xffc65a,
  thickness: CONFIG.strike?.mark?.ring?.thickness ?? 0.16,
  glow: CONFIG.strike?.mark?.ring?.glow ?? 2.4,
  renderOrder: 9,
});

// WHICH STATUS THE RING SHOWS when a body is carrying more than one. Ordered by
// how much the status changes what the player should do about that target, not
// by how much damage it represents: a frozen shark is not coming at you and
// that outranks everything, an infected one is about to hand its status to the
// school around it, and a poisoned one is merely dying on its own schedule.
//
// `shock` is deliberately absent — it resolves inside a single frame and has no
// timer to read, so there is never a moment where a reticle could show it.
const STATUS_ORDER = [
  ['chillTimer', 'chill'],
  ['infectTimer', 'infection'],
  ['venomTimer', 'venom'],
];

function statusType(target) {
  for (const [field, type] of STATUS_ORDER) {
    if ((target?.[field] ?? 0) > 0) return type;
  }
  return null;
}

// For the harness only. Nothing in Node compiles GLSL and the browser preview
// never renders a frame to compile one in, so the realistic failure — a uniform
// renamed on one side of the pair and not the other — is otherwise completely
// uncovered, and its symptom is a reticle that is silently invisible. Same
// escape hatch, and the same reasoning, as bakalar's __beamShader. Now a
// re-export, because the shader it is checking is shared.
export const __ringShader = {
  vertexShader: __organicRingShader.vertexShader,
  fragmentShader: __organicRingShader.fragmentShader,
  makeRing,
};

/** Attach the reticle layer. Safe to call again — the old one is torn down. */
export function initMarks(scene) {
  if (group) disposeMarks(scene);
  group = new THREE.Group();
  group.frustumCulled = false;
  scene.add(group);
}

export function disposeMarks(scene) {
  if (!group) return;
  for (const m of marks.values()) disposeOrganicRing(m.ring);
  marks.clear();
  scene.remove(group);
  group = null;
}

/** Drop every mark. Called on a fresh run — nothing survives a death. */
export function resetMarks() {
  for (const m of marks.values()) disposeOrganicRing(m.ring);
  marks.clear();
}

/**
 * Is this body worth painting? Small fish are excluded deliberately: a school
 * does not need help dying, and marking one would pull every homing shell in
 * the arena off the thing that is actually eating you.
 *
 * Boats have no `radius` in the creature sense (they carry a hull box), so
 * they pass on `isBoat` instead of on size.
 */
export function markable(target, isBoat = false) {
  const cfg = CONFIG.strike?.mark ?? {};
  if (cfg.enabled === false) return false;
  // NEVER A TURTLE. The reticle is the seal saying "that one", and every
  // seeker and escort in the game obeys it outright (CONFIG.homing). Painting
  // a body nothing can hurt would turn that instruction into "empty every
  // volley into the wall" — see isScenery for the rule in full.
  if (isScenery(target)) return false;
  if (isBoat) return cfg.boats !== false;
  return (target?.radius ?? 0) >= (cfg.minRadius ?? 0.65);
}

/**
 * Paint a target. Re-marking one already painted refreshes its timer rather
 * than stacking, so a dash that clips the same shark twice doesn't leave it
 * marked for twice as long.
 *
 * @returns {boolean} true only when this call painted something NEW, so the
 *   caller can fire the lock-on feedback once instead of on every graze.
 */
export function markTarget(target, opts = {}) {
  if (!target || !markable(target, opts.isBoat)) return false;
  const existing = marks.get(target);
  const duration = CONFIG.strike?.mark?.duration ?? 6;
  if (existing) {
    existing.timer = duration;
    return false;
  }

  const ring = group ? makeRing() : null;
  if (ring) group.add(ring);
  marks.set(target, {
    ref: target,
    timer: duration,
    ring,
    // Measured ONCE, off whatever the target actually is. A creature's
    // `radius` already carries its asset size multiplier and whatever the run
    // has grown it by; a hull carries a measured box instead. Neither is a
    // number that can be hand-typed here.
    size: opts.radius ?? target.radius ?? 1,
    phase: Math.random(),
    // The sweep-on, 0..1. Starts closed so a new lock is DRAWN rather than
    // popped into existence at full strength.
    onT: 0,
    // Which element the ring is currently wearing, so the tint is only rewritten
    // when it actually changes rather than every frame.
    status: null,
  });
  return true;
}

export function isMarked(target) {
  return marks.has(target);
}

/**
 * The distance multiplier a target-picker should apply. A marked body LOOKS
 * closer than it is, so it wins the "nearest" comparison against anything up
 * to twice its distance away — which is a strong pull that a shark about to
 * bite can still beat by being genuinely on top of you.
 *
 * Returned as a multiplier rather than as a boolean so every caller weights
 * the mark identically without each one inventing its own bonus.
 */
export function markWeight(target) {
  if (!marks.has(target)) return 1;
  return CONFIG.strike?.mark?.homingPull ?? 0.45;
}

/** Every live mark, for pickers that want to consider targets off their own list. */
export function markedTargets() {
  return marks.keys();
}

const _pos = new THREE.Vector3();
const TAU = Math.PI * 2;

/**
 * Tick every mark and drive its reticle.
 *
 * @param dt seconds
 */
export function updateMarks(dt) {
  if (!marks.size) return;
  const cfg = CONFIG.strike?.mark ?? {};
  const ring = cfg.ring ?? {};
  const fade = Math.max(0.01, ring.fade ?? 0.6);

  for (const [target, m] of marks) {
    m.timer -= dt;
    // Dead, sunk, or otherwise off the board. `mesh.parent` is the one test
    // that works for a creature, a hull and anything added later — every one
    // of them is removed from the scene by whatever owns it.
    const gone = m.timer <= 0
      || !target.mesh
      || !target.mesh.parent
      || (target.hp != null && target.hp <= 0);
    if (gone) {
      if (m.ring) disposeOrganicRing(m.ring);
      marks.delete(target);
      continue;
    }

    if (!m.ring) continue;

    target.mesh.getWorldPosition(_pos);
    const size = m.size * (ring.radiusMul ?? 1.55);
    // Position, scale and the shader's own idea of the radius move together —
    // the world-unit wobble is divided by that radius, so setting the scale by
    // hand would leave the edge amplitude computed against last frame's size.
    placeOrganicRing(m.ring, _pos.x, _pos.y, size, _pos.z);
    m.ring.rotation.z += (ring.spin ?? 0.7) * dt;

    // The pulse. The ramp-out is no longer part of it: leaving is a sweep now,
    // below, so this is purely the breathing of a live lock.
    m.phase = (m.phase + dt * (ring.hz ?? 2.6)) % 1;
    const depth = Math.min(1, Math.max(0, ring.pulseDepth ?? 0.55));
    const wave = 0.5 - 0.5 * Math.cos(m.phase * TAU);

    // THE TWO SWEEPS. Painting a mark runs the hand round once to draw it; the
    // last `fade` seconds run a second hand round behind the first to eat it
    // away. Both travel the same direction, so a lock expires by being wiped
    // off in the order it was written rather than by dimming — which is the
    // difference between "that ran out" and "I lost it".
    m.onT = Math.min(1, (m.onT ?? 0) + dt / Math.max(0.01, ring.sweepIn ?? 0.28));
    const out = 1 - Math.min(1, m.timer / fade);

    // The status, re-read every frame: a shark that gets poisoned while marked
    // has to change under the reticle, and the element systems write these
    // fields without knowing marks.js exists.
    const status = statusType(target);
    if (status !== m.status) {
      m.status = status;
      if (status) {
        setRingThreat(m.ring, status);
      } else {
        // Back to the plain lock — colour AND dialect, or a shark that thaws
        // keeps its crystalline facets for the rest of the mark.
        setRingThreat(m.ring, 'kinetic');
        updateOrganicRing(m.ring, 0, { color: ring.color ?? 0xffc65a });
      }
    }

    updateOrganicRing(m.ring, dt, {
      opacity: 1 - depth + depth * wave,
      sweepIn: m.onT,
      sweepOut: out,
      thickness: ring.thickness ?? 0.16,
      glow: ring.glow ?? 2.4,
    });
  }
}
