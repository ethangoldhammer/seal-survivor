import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';

// Ribbon trails behind projectiles. Same reason as the lightning arcs: WebGL
// ignores line width, so a trail has to be real geometry to be visible at
// all. Each trail keeps a short history of world positions and rebuilds a
// tapering, fading ribbon through them every frame.
//
// Geometry is allocated ONCE per trail at its maximum length and rewritten
// in place — allocating a new BufferGeometry every frame for every bullet on
// screen would churn the GC hard during a busy fight.

const trails = new Map(); // projectile object -> trail record

function makeTrail(scene, cfg) {
  const maxPts = Math.max(2, Math.round(cfg.points));
  const positions = new Float32Array(maxPts * 2 * 3);
  const colors = new Float32Array(maxPts * 2 * 3);
  const indices = [];
  for (let i = 0; i < maxPts - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, geo, history: [], maxPts, emitDebt: 0, extents: null, extentsKey: null };
}

// How big the projectile ACTUALLY renders, in world units.
//
// This has to be measured rather than assumed. The asset's configured radius
// is only half the story: every asset can carry a `sizeMultiplier` from the
// Look panel, and the mussel's is 7.38 — so a shell described in config.js as
// radius 0.16 is a 2.4-unit-long object on screen. Anything positioned
// relative to the shell in hand-typed world units is therefore wrong by
// whatever that multiplier happens to be, and silently re-breaks the moment
// somebody drags the size slider.
//
// Measured with rotation zeroed so the numbers are the shell's own dimensions
// rather than the bounding box of however it's currently turned — otherwise
// the trail offset would breathe as the mussel curves. Art forward is +Y (see
// the `oval` shape), so that axis is the length.
function measureShell(mesh) {
  const { x: rx, y: ry, z: rz } = mesh.rotation;
  mesh.rotation.set(0, 0, 0);
  mesh.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  mesh.rotation.set(rx, ry, rz);
  mesh.updateMatrixWorld(true);
  return { halfLength: size.y * 0.5, halfDepth: size.z * 0.5 };
}

// Cached, and refreshed only when the scale actually changes — a Box3 over a
// model every frame for every shot in the air is not free, and this only moves
// when somebody touches the size slider.
function shellExtents(t, p) {
  const key = `${p.mesh.scale.x}|${p.mesh.scale.y}|${p.mesh.scale.z}`;
  if (t.extentsKey !== key) {
    t.extentsKey = key;
    t.extents = measureShell(p.mesh);
  }
  return t.extents;
}

// How far behind the shell's centre the trail is anchored, in world units.
// `tailOffset` is a MULTIPLE of the shell's own half-length (1 = exactly at
// the tail), so it stays correct at any size. A trail is exhaust, and exhaust
// comes out of the back of the thing — anchored at the centre, the widest,
// brightest end of the ribbon sat in the middle of the shell and the burning
// chips spawned inside its body, which is what made the mussel look like it
// was disintegrating rather than trailing a plume.
function tailBack(t, p, cfg) {
  if (!cfg.tailOffset) return 0;
  return shellExtents(t, p).halfLength * cfg.tailOffset;
}

// Where the ribbon sits in z. `depthClearance` is a MULTIPLE of the shell's
// half-depth, so the ribbon clears the body whatever size it renders at. The
// projectile is opaque and writes depth, so once the ribbon is genuinely
// behind it the shell occludes its own trail for free. Presets that don't set
// this keep the legacy near-zero offset, so the small bullets are untouched.
function trailZ(t, p, cfg) {
  if (cfg.depthClearance == null) return cfg.z ?? -0.02;
  return Math.min(-0.02, -shellExtents(t, p).halfDepth * cfg.depthClearance);
}

function tailPoint(p, back, extraBack = 0) {
  const d = back + extraBack;
  return {
    x: p.mesh.position.x - p.dir.x * d,
    y: p.mesh.position.y - p.dir.y * d,
  };
}

// Shed particles along the path at a fixed rate. The leftover fraction is
// carried in emitDebt rather than dropped, so the rate holds at any framerate
// instead of quietly thinning out when frames are long — and a rate under one
// per frame still emits, just not every frame.
function shedParticles(t, p, cfg, dt, back) {
  const spec = cfg.particles;
  if (!spec?.emitter || !(spec.perSecond > 0)) return;
  t.emitDebt += spec.perSecond * dt;
  let bursts = Math.floor(t.emitDebt);
  if (bursts <= 0) return;
  t.emitDebt -= bursts;
  // One long frame shouldn't dump a whole second of chips in one place.
  bursts = Math.min(bursts, 4);
  for (let i = 0; i < bursts; i++) {
    // Spread the burst back along the segment just travelled, so the chips
    // lie in a line behind the shell rather than stacking at its current
    // position in clumps of `bursts`. On top of that, the whole line starts
    // at the shell's TAIL (see tailPoint) — chips shedding from the middle of
    // the body read as the mussel disintegrating, not as an exhaust plume.
    const { x, y } = tailPoint(p, back, (i / bursts) * p.speed * dt);
    emit(spec.emitter, x, y, {
      vx: p.dir.x * p.speed,
      vy: p.dir.y * p.speed,
    });
  }
}

// Which trail preset a projectile uses, by its asset key. Anything not
// listed simply gets no trail.
function presetFor(p) {
  return CONFIG.trails[p.mesh?.name] ?? null;
}

export function updateProjectileTrails(dt, scene, projectiles) {
  if (!CONFIG.trails.enabled) {
    if (trails.size) clearProjectileTrails(scene);
    return;
  }

  const live = new Set();

  for (const p of projectiles) {
    const cfg = presetFor(p);
    if (!cfg) continue;
    live.add(p);

    let t = trails.get(p);
    if (!t) {
      t = makeTrail(scene, cfg);
      trails.set(p, t);
    }

    // Both are measured off the shell as it actually renders, so a size
    // change in the Look panel moves them with it.
    const back = tailBack(t, p, cfg);
    shedParticles(t, p, cfg, dt, back);

    // Tracked live, so dragging the depth in the tuner moves a trail that's
    // already in the air rather than only the next one to spawn.
    t.mesh.position.z = trailZ(t, p, cfg);

    // Record the head position — the shell's TAIL, not its centre — and drop
    // the oldest once past the cap.
    const head = tailPoint(p, back);
    t.history.unshift(new THREE.Vector3(head.x, head.y, 0));
    while (t.history.length > t.maxPts) t.history.pop();

    const pos = t.geo.attributes.position;
    const col = t.geo.attributes.color;
    const colour = new THREE.Color(cfg.color);
    const up = new THREE.Vector3(0, 0, 1);
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    const n = t.history.length;

    for (let i = 0; i < t.maxPts; i++) {
      // Past the end of the recorded history, collapse remaining vertices
      // onto the tail so the ribbon doesn't stretch back to the origin
      // while it's still filling up.
      const idx = Math.min(i, n - 1);
      const cur = t.history[idx];
      const prev = t.history[Math.max(0, idx - 1)];
      const next = t.history[Math.min(n - 1, idx + 1)];
      dir.subVectors(next, prev);
      if (dir.lengthSq() < 1e-10) dir.set(1, 0, 0);
      dir.normalize();

      const f = i / (t.maxPts - 1); // 0 at the head, 1 at the tail
      const w = cfg.width * 0.5 * (1 - f) ** cfg.taper;
      side.crossVectors(dir, up).normalize().multiplyScalar(w);

      const a = i * 2;
      pos.setXYZ(a, cur.x + side.x, cur.y + side.y, 0);
      pos.setXYZ(a + 1, cur.x - side.x, cur.y - side.y, 0);

      // Fade to black toward the tail — with additive blending, black is
      // transparent, so this doubles as the alpha ramp.
      const bright = cfg.glow * (1 - f) ** cfg.fade;
      col.setXYZ(a, colour.r * bright, colour.g * bright, colour.b * bright);
      col.setXYZ(a + 1, colour.r * bright, colour.g * bright, colour.b * bright);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // Tear down trails whose projectile is gone.
  for (const [p, t] of trails) {
    if (live.has(p)) continue;
    scene.remove(t.mesh);
    t.geo.dispose();
    t.mesh.material.dispose();
    trails.delete(p);
  }
}

export function clearProjectileTrails(scene) {
  for (const [, t] of trails) {
    scene.remove(t.mesh);
    t.geo.dispose();
    t.mesh.material.dispose();
  }
  trails.clear();
}
