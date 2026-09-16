import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { enemies } from '../entities/enemies.js';
import { projectiles } from '../entities/projectiles.js';
import { player } from '../entities/player.js';

// ===========================================================================
// THE GATES, DRAWN. The other half of systems/attackTrace.js.
// ===========================================================================
// The ledger says WHY a boss did not commit. This says WHERE — every distance
// the decision is made against, on the floor under the animal, at the moment it
// is being made. Together they are the whole answer to "it never commits" and
// "the bite went straight through me", and neither is much use without the
// other: a number without a picture is a claim, and a picture without the
// reason is a shape you have to interpret.
//
// WHAT IS DRAWN, and every one of them is read from the same place the
// behaviour reads it:
//
//   RANGE / MINRANGE  the window a run may be opened from. Two rings, and the
//                     gap between them is the only place in the arena a lunge
//                     can start. When the seal is inside the inner ring the
//                     boss is refusing on `minRange` and the trace says so.
//   THE CONE          two rays off the nose at the narrower of `commitCone`
//                     and the wind-up's turn budget — see lungeLineGate. They
//                     are drawn at the actual ceiling being applied, so a boss
//                     whose slow turn rate has quietly halved its cone shows a
//                     narrow wedge rather than the wide one the CSV says.
//   THE BITE          the radius onPlayerBite measures, which is the boss's own
//                     radius times `bite.mouthReach` PLUS the seal's hit
//                     radius. Drawn on the boss rather than on the seal because
//                     that is where the test is centred, and because the whole
//                     point of the bite is that it happens at one end of an
//                     animal.
//   THE RUN           during a strike, the line the body is committed down, as
//                     long as the run has left to travel. What a dodge is
//                     dodging.
//   THE SHOTS         every hostile projectile's hit radius, tinted by how much
//                     of its hp is left (CONFIG.enemyShot) — a shot you can
//                     still swat reads differently from one you cannot.
//
// ---------------------------------------------------------------------------
// TWO RULES ABOUT HOW IT IS BUILT.
// ---------------------------------------------------------------------------
//
//   ONE GEOMETRY, MANY LINES. Every ring is the same 64-segment unit circle
//   scaled per draw, and every ray is the same two-point segment rotated and
//   scaled. A ring built per creature per frame would allocate two buffers a
//   frame per body and is the obvious way to write this.
//
//   NOTHING IS CREATED UNTIL IT IS SHOWN, and everything is disposed when it is
//   hidden. A debug overlay that leaves a pool of line meshes in the scene for
//   the rest of the session is a debug overlay that shows up in the memory
//   census as a leak somebody else has to chase.
//
// It reads and writes nothing about the fight. Switching it off changes no
// number and no decision — only whether you were shown.
// ===========================================================================

const SEGMENTS = 72;

// ---------------------------------------------------------------------------
// WHY NONE OF THIS IS DRAWN WITH LINES.
// ---------------------------------------------------------------------------
// It was, and it was unreadable in a fight. `LineBasicMaterial.linewidth` is
// ignored by every WebGL2 core profile — the spec allows only 1.0 — so a debug
// ring is one physical pixel however far away the camera is and whatever you
// set. On a 4K display, over a moving boss, against bloom, at a ring radius of
// twenty units, that is not a diagnostic; it is a rumour.
//
// So every shape here is real geometry with a thickness in WORLD UNITS:
//
//   a ring    an annulus (RingGeometry), thick in world units rather than in
//             pixels, so the bite ring at 1.7u and the range ring at 22u are
//             the same weight on screen.
//   the cone  a filled sector at low alpha with its two edges drawn solid over
//             the top. A wedge you can see out of the corner of your eye beats
//             two hairlines you have to go looking for, and the fill is what
//             makes "am I inside it" answerable without tracing an edge.
//   the run   a bar, not a line, tapered nowhere and bright — it is the thing
//             being dodged and it gets the most weight on screen.
//
// THE GEOMETRY CACHE is what makes that affordable. An annulus of constant
// world thickness is a different shape at every radius, so the naive version
// builds one per ring per frame — two buffers a frame per body. Cached on the
// RATIO of thickness to radius, quantised, which collapses a fight's worth of
// radii onto a handful of shapes; the same trick holds for the sector, cached
// on its quantised angle. Both are built once and scaled thereafter.
// ---------------------------------------------------------------------------

// Everything built lazily on the first show, so a run with the panel closed
// allocates none of it.
let group = null;
let scene = null;
const mats = new Map();
const ringGeos = new Map();
const wedgeGeos = new Map();
let barGeo = null;
// Meshes handed out per frame and handed back at the end of it, so the count
// settles at the most the busiest frame needed rather than growing.
const pool = { rings: [], bars: [], wedges: [] };
let used = { rings: 0, bars: 0, wedges: 0 };

// HOW HEAVY THE WHOLE OVERLAY IS, as a multiplier on every thickness and every
// alpha. The panel drives it: a boss fight at speed wants more weight than a
// still frame does, and "can you see it" is a judgement made while moving that
// nobody can make for somebody else. See setAttackOverlayWeight.
let weight = 1;

/** How heavy to draw everything. 1 is the default; the V panel drives it. */
export function setAttackOverlayWeight(v) {
  weight = Math.max(0.25, Math.min(4, Number(v) || 1));
}

export function attackOverlayWeight() {
  return weight;
}

function material(color, opacity) {
  const a = Math.min(1, opacity * weight);
  // Quantised into the key as well as applied, or a weight slider would build a
  // new material per frame of its own drag.
  const key = `${color}:${a.toFixed(2)}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: a,
      side: THREE.DoubleSide,
      // OVER EVERYTHING. A gate drawn behind the animal it describes is a gate
      // you cannot read on the frame that matters, which is always the frame
      // the animal is on top of you.
      depthTest: false,
      depthWrite: false,
    });
    mats.set(key, m);
  }
  return m;
}

// An annulus of unit outer radius whose wall is `ratio` of that radius. Cached
// on the quantised ratio — see the note above.
function ringGeometry(ratio) {
  const q = Math.max(0.004, Math.min(0.6, Math.round(ratio * 400) / 400));
  let g = ringGeos.get(q);
  if (!g) {
    g = new THREE.RingGeometry(1 - q, 1, SEGMENTS);
    ringGeos.set(q, g);
  }
  return g;
}

// A filled sector of unit radius, centred on +X, opening `angle` radians to
// each side. Cached on the quantised half-angle.
function wedgeGeometry(angle) {
  const q = Math.max(0.02, Math.min(Math.PI, Math.round(angle * 50) / 50));
  let g = wedgeGeos.get(q);
  if (!g) {
    g = new THREE.CircleGeometry(1, Math.max(6, Math.round((q * 2) / 0.08)), -q, q * 2);
    wedgeGeos.set(q, g);
  }
  return g;
}

function ensure() {
  if (barGeo) return;
  // A unit bar running +X from the origin, one unit tall, so a draw is a
  // non-uniform scale and nothing else.
  barGeo = new THREE.PlaneGeometry(1, 1);
  barGeo.translate(0.5, 0, 0);
}

function take(kind, geo, color, opacity) {
  const list = pool[kind];
  let mesh = list[used[kind]];
  if (!mesh) {
    mesh = new THREE.Mesh(geo, material(color, opacity));
    mesh.renderOrder = 900;
    mesh.frustumCulled = false;
    list.push(mesh);
    group.add(mesh);
  }
  mesh.geometry = geo;
  mesh.material = material(color, opacity);
  mesh.visible = true;
  used[kind] += 1;
  return mesh;
}

// `thick` is in WORLD UNITS, which is the whole point — see the note above.
function ring(x, y, z, r, color, opacity = 0.7, thick = 0.14) {
  if (!(r > 0)) return;
  const mesh = take('rings', ringGeometry((thick * weight) / r), color, opacity);
  mesh.position.set(x, y, z);
  mesh.scale.setScalar(r);
  mesh.rotation.set(0, 0, 0);
}

function bar(x, y, z, angle, length, color, opacity = 0.7, thick = 0.14) {
  if (!(length > 0)) return;
  const mesh = take('bars', barGeo, color, opacity);
  mesh.position.set(x, y, z);
  mesh.rotation.set(0, 0, angle);
  mesh.scale.set(length, thick * weight, 1);
}

function wedge(x, y, z, angle, half, radius, color, opacity = 0.14) {
  if (!(radius > 0) || !(half > 0)) return;
  const mesh = take('wedges', wedgeGeometry(half), color, opacity);
  mesh.position.set(x, y, z);
  mesh.rotation.set(0, 0, angle);
  mesh.scale.setScalar(radius);
}

/** Put the overlay in the scene. Idempotent. */
export function showAttackOverlay(target) {
  if (group && scene === target) return;
  hideAttackOverlay();
  ensure();
  scene = target;
  group = new THREE.Group();
  group.name = 'attackOverlay';
  scene.add(group);
}

/** Take it out again, and give everything it built back. */
export function hideAttackOverlay() {
  if (!group) return;
  scene?.remove(group);
  // The meshes are NOT disposed one by one: every one of them shares a cached
  // geometry, so a per-mesh dispose would release the same handful of buffers
  // once per ring on screen. The caches go below, once each.
  for (const m of mats.values()) m.dispose();
  mats.clear();
  for (const g of ringGeos.values()) g.dispose();
  for (const g of wedgeGeos.values()) g.dispose();
  ringGeos.clear();
  wedgeGeos.clear();
  barGeo?.dispose();
  barGeo = null;
  pool.rings.length = 0;
  pool.bars.length = 0;
  pool.wedges.length = 0;
  used = { rings: 0, bars: 0, wedges: 0 };
  group = null;
  scene = null;
}

export function attackOverlayOn() {
  return !!group;
}

// Saturated on purpose. This is drawn over a blue-green ocean with bloom on it,
// and the muted palette a UI would use disappears into the water — the first
// version of this file used one and could not be seen while anything moved.
const C = {
  range: 0x4fa3ff,   // the outer window
  floor: 0xff5a45,   // minRange — inside this there is no run to be had
  bite: 0xffc531,    // what the jaws actually reach
  cone: 0x54ffa8,    // the line may be committed down inside these
  run: 0xffffff,     // a committed run
  seal: 0x5ff0dd,
  shot: 0xff7a3d,
  shotDead: 0xb98cff,
};

/**
 * One frame of the overlay.
 *
 * Draws the boss alone by default; `showWildlife` adds every other lunging body
 * in the water, which is off by default because six sharks' worth of range,
 * floor, bite and cone is a picture nobody can read. Called after updateEnemies
 * so every ring is around the body where it ended up rather than where it
 * started the frame.
 */
export function updateAttackOverlay({ showWildlife = false, showShots = true } = {}) {
  if (!group) return;
  for (const m of pool.rings) m.visible = false;
  for (const m of pool.bars) m.visible = false;
  for (const m of pool.wedges) m.visible = false;
  used = { rings: 0, bars: 0, wedges: 0 };

  const pr = player.stats?.hitRadius ?? 0.5;
  const pp = player.mesh.position;
  ring(pp.x, pp.y, pp.z, pr, C.seal, 0.95, 0.1);

  const rules = CONFIG.lungeRules ?? {};
  for (const e of enemies) {
    if (!e.def?.lunge) continue;
    if (!showWildlife && !e.isBoss) continue;
    const c = e.def.lunge;
    const { x, y, z } = e.mesh.position;
    const stage = e.lungeStage;
    // THE STATE IS IN THE WEIGHT, not only in the colour. A body that has
    // committed is the one thing on screen you have to react to, so everything
    // about it gets heavier — which is readable at the edge of vision, where
    // a colour change is not.
    const hot = stage === 'strike' ? 1.9 : stage === 'wind' ? 1.35 : 1;

    // The window a run may open from: two rings, and the gap between them is
    // the only place in the arena a lunge can start.
    ring(x, y, z, c.range ?? 12, C.range, 0.4, 0.1);
    ring(x, y, z, c.minRange ?? 6, C.floor, 0.5, 0.1);
    // The same expression onPlayerBite measures — see the note there on why it
    // is centred on the body rather than on the head. Heaviest of the three,
    // because it is the only one that decides whether anything happens.
    ring(x, y, z, (e.radius ?? 1) * (CONFIG.bite?.mouthReach ?? 0.55) + pr,
      C.bite, 0.95, 0.2 * hot);

    const heading = e.heading ?? 0;
    // THE CEILING ACTUALLY BEING APPLIED, which is the narrower of the tuned
    // cone and what the wind-up can physically turn through. Drawing the CSV's
    // number would show a wide wedge on exactly the bodies whose turn rate has
    // quietly closed it to a third of that — which is the bug, not the setting.
    const budget = (e.turnRate ?? e.def.turnRate ?? 3) * (c.windup ?? 0.45) * 0.8;
    const half = Math.min(c.commitCone ?? rules.commitCone ?? 1.75, budget);
    const lateral = !!e.def.hunt?.lateral;
    if (lateral && stage !== 'strike') {
      // Filled, low, plus its two edges solid over the top. The fill is what
      // makes "am I inside it" a glance instead of tracing an edge.
      wedge(x, y, z, heading, half, c.range ?? 12, C.cone, 0.1 * hot);
      bar(x, y, z, heading + half, c.range ?? 12, C.cone, 0.7, 0.09);
      bar(x, y, z, heading - half, c.range ?? 12, C.cone, 0.7, 0.09);
    }
    if (stage === 'strike') {
      // How much run is LEFT, at this step's own speed — the length of the
      // thing being dodged rather than the length of the whole pass. The widest
      // thing the overlay draws, because it is the only one you have under a
      // second to act on.
      const step = e.lungePlan?.[e.lungeStep];
      const speed = (e.speed ?? 0) * (step?.speedMul ?? c.speedMul ?? 3.6);
      const left = speed * Math.max(0, e.lungeClock ?? 0);
      bar(x, y, z, heading, left, C.run, 0.55, (e.radius ?? 1) * 1.2);
      bar(x, y, z, heading, left, C.run, 1, 0.16);
    }
  }

  if (!showShots) return;
  for (const p of projectiles) {
    if (p.faction !== 'enemy') continue;
    const frac = p.hpMax > 0 ? Math.max(0, p.hp) / p.hpMax : 1;
    ring(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, p.radius,
      p.hpMax > 0 ? C.shot : C.shotDead, 0.45 + 0.55 * frac, 0.09);
  }
}

/** What the overlay drew this frame, for a harness. */
export function attackOverlayStats() {
  return { ...used, geometries: ringGeos.size + wedgeGeos.size, materials: mats.size };
}
