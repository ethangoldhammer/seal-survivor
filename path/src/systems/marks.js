import * as THREE from 'three';
import { CONFIG } from '../config.js';

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
const ringGeometry = new THREE.PlaneGeometry(2, 2);

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A broken ring — four arcs with gaps at the diagonals, so it reads as a
// TARGETING bracket rather than as a bubble or an aura. Everything else that
// draws a circle around a body in this game (the beluga's trap, the charge
// meter) is a solid ring; the gaps are what keep those three apart at a
// glance.
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uFade;      // 0..1 — the pulse, and the ramp-out at the end
  uniform float uThickness;
  varying vec2 vUv;

  #define TAU 6.28318530718

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);

    // The band itself. Smoothstepped on both sides so the arc has soft edges
    // at any distance instead of aliasing into a dashed line when the camera
    // pulls back.
    float band = 1.0 - smoothstep(0.0, uThickness, abs(r - (1.0 - uThickness)));
    if (band <= 0.001) discard;

    // Four arcs. seg runs 0..1 across each quarter turn; the gap is cut out
    // of the middle of each one, which puts the four openings on the
    // diagonals and the four bracket corners on the axes.
    float ang = atan(p.y, p.x);
    float seg = fract((ang / TAU) * 4.0 + 0.125);
    float arc = smoothstep(0.0, 0.06, seg) * (1.0 - smoothstep(0.72, 0.78, seg));
    if (arc <= 0.001) discard;

    float a = band * arc * uFade;
    gl_FragColor = vec4(uColor * uGlow * a, a);
  }
`;

function makeRing() {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // Same reasoning as the impact flash: this is a readout, not geometry. A
    // reticle clipped by the shark it is painted on would vanish exactly when
    // the shark turns side-on, which is the moment it matters most.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0xffc65a) },
      uGlow: { value: 2.4 },
      uFade: { value: 0 },
      uThickness: { value: 0.16 },
    },
  });
  const mesh = new THREE.Mesh(ringGeometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;
  return mesh;
}

// For the harness only. Nothing in Node compiles GLSL and the browser preview
// never renders a frame to compile one in, so the realistic failure — a uniform
// renamed on one side of the pair and not the other — is otherwise completely
// uncovered, and its symptom is a reticle that is silently invisible. Same
// escape hatch, and the same reasoning, as bakalar's __beamShader.
export const __ringShader = { vertexShader, fragmentShader, makeRing };

/** Attach the reticle layer. Safe to call again — the old one is torn down. */
export function initMarks(scene) {
  if (group) disposeMarks(scene);
  group = new THREE.Group();
  group.frustumCulled = false;
  scene.add(group);
}

export function disposeMarks(scene) {
  if (!group) return;
  for (const m of marks.values()) m.ring?.material.dispose();
  marks.clear();
  scene.remove(group);
  group = null;
}

/** Drop every mark. Called on a fresh run — nothing survives a death. */
export function resetMarks() {
  for (const m of marks.values()) {
    m.ring?.material.dispose();
    if (m.ring) group?.remove(m.ring);
  }
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
      if (m.ring) {
        group?.remove(m.ring);
        m.ring.material.dispose();
      }
      marks.delete(target);
      continue;
    }

    if (!m.ring) continue;

    target.mesh.getWorldPosition(_pos);
    m.ring.position.set(_pos.x, _pos.y, _pos.z);
    const size = m.size * (ring.radiusMul ?? 1.55);
    m.ring.scale.setScalar(size);
    m.ring.rotation.z += (ring.spin ?? 0.7) * dt;

    // The pulse, plus a ramp-out over the last `fade` seconds — a reticle that
    // vanished on a frame boundary would read as the lock having been lost
    // rather than having expired.
    m.phase = (m.phase + dt * (ring.hz ?? 2.6)) % 1;
    const depth = Math.min(1, Math.max(0, ring.pulseDepth ?? 0.55));
    const wave = 0.5 - 0.5 * Math.cos(m.phase * TAU);
    const out = Math.min(1, m.timer / fade);
    const u = m.ring.material.uniforms;
    u.uFade.value = (1 - depth + depth * wave) * out;
    u.uThickness.value = ring.thickness ?? 0.16;
    u.uGlow.value = ring.glow ?? 2.4;
    u.uColor.value.set(ring.color ?? 0xffc65a);
  }
}
