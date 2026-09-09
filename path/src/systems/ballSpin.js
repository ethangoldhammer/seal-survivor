// ============================================================================
// SPIN STREAKS — the versus ball's spin, drawn.
//
// A ball that curves for no visible reason reads as a bug. This is the
// reason: while the ball turns, curved strokes wrap around its rim and ride
// round with it, in the direction it is turning and at a pace that follows
// its rate, and their LENGTH is the rate — a short tick at the least spin
// worth showing, most of a half-turn of stroke at the most. Below the
// threshold they trim away to nothing and go; nothing is drawn on a ball that
// is not turning, so the mark's absence means something too.
//
// Each stroke is a ribbon sampled along an arc of the SOFT body — rimRadius,
// not the rigid circle — so a dent bends the stroke with the skin it sits
// over, `hug` times the radius out. The band is widest in the middle and
// tapers at both ends, the tail longer than the head: motion blur's shape,
// which is what makes a single frame say which way it is going.
//
// WHY A MESH AND NOT SPLATS. The ball itself is goo — driven splats through
// the post pass — and a stroke as splats would join the ball's field and read
// as a lump on it. This is a plain triangle strip, additive so the bloom
// takes it, with vertex colours carrying the fade and the taper, so the whole
// thing is one MeshBasicMaterial and there is no shader to break.
//
// WHERE IT IS DRAWN. Not in the world scene: the goo pass composites over the
// whole scene, and the goo body draws about 1.75x the physics radius, so a
// stroke in the world at any z sat under the ball and was seen on no frame.
// The mesh lives in post.js's `overlayScene`, drawn after the goo and before
// the bloom — see the note there — and versus.js hands that scene to
// initBallSpin. `hug` is measured against the DRAWN edge for the same reason.
//
// It knows nothing about the match: `updateBallSpin` is handed the ball and a
// clock, `renderBallSpin` writes the geometry. The lab drives it with a spin
// it sets by hand; the game with the spin the strikes made.
// ============================================================================

import * as THREE from 'three';
import { CONFIG } from '../config.js';

const cfg = () => CONFIG.versus?.ball?.spinStrokes ?? {};
const TAU = Math.PI * 2;
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

/** Every live stroke: `phase` is where its centre sits (world angle), `arc` its current length in radians. */
export const streaks = [];

const state = {
  mesh: null,
  geo: null,
  scene: null,
  spin: 0,          // last spin fed in, for the harness
  cap: 0,           // strokes the geometry was built for
  segs: 0,
};

function capacity() {
  const c = cfg();
  return { count: Math.max(1, Math.round(c.count ?? 3)), segs: Math.max(4, Math.round(c.segments ?? 28)) };
}

function build() {
  const { count, segs } = capacity();
  if (state.geo && state.cap === count && state.segs === segs) return;
  if (state.geo) state.geo.dispose();
  const verts = count * (segs + 1) * 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  const idx = [];
  for (let s = 0; s < count; s++) {
    const base = s * (segs + 1) * 2;
    for (let i = 0; i < segs; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  state.geo = geo;
  state.cap = count;
  state.segs = segs;
  if (state.mesh) state.mesh.geometry = geo;
}

/** Put the strokes in `scene`. Safe to call again; the mesh is reused. */
export function initBallSpin(scene) {
  build();
  if (!state.mesh) {
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      // BOTH SIDES. The strip is laid along the arc in the direction of the
      // spin, so a clockwise ball winds every triangle the other way — and
      // with the default FrontSide the culling ate the whole set: three
      // strokes drawn, none seen, only when the ball turned clockwise.
      side: THREE.DoubleSide,
    });
    state.mesh = new THREE.Mesh(state.geo, mat);
    state.mesh.name = 'ballSpinStreaks';
    state.mesh.frustumCulled = false;
    state.mesh.renderOrder = 3;
    state.mesh.position.z = 1.2;
  }
  if (state.scene !== scene) {
    state.scene?.remove(state.mesh);
    scene?.add(state.mesh);
    state.scene = scene;
  }
  streaks.length = 0;
}

export function disposeBallSpin() {
  if (state.mesh && state.scene) state.scene.remove(state.mesh);
  state.scene = null;
  streaks.length = 0;
  if (state.geo) state.geo.setDrawRange(0, 0);
}

/** The arc a stroke wants at this spin — 0 under spinMin, arcMax at spinFull. */
export function arcFor(spin) {
  const c = cfg();
  const a = Math.abs(spin);
  const lo = c.spinMin ?? 2.5;
  const hi = Math.max(lo + 0.01, c.spinFull ?? 14);
  if (a < lo) return 0;
  return (c.arcMin ?? 0.35) + ((c.arcMax ?? 2.4) - (c.arcMin ?? 0.35)) * smooth((a - lo) / (hi - lo));
}

/**
 * Advance the strokes against the ball's spin. `spin` in rad/s, `dt` the
 * clock the ball itself moved on — a stroke that kept turning through the
 * goal's freeze would be the one thing in the water still moving.
 */
export function updateBallSpin(spin, dt) {
  const c = cfg();
  state.spin = spin;
  if (c.enabled === false) { streaks.length = 0; return; }
  const count = Math.max(1, Math.round(c.count ?? 3));
  const want = arcFor(spin);
  const alive = streaks.filter((s) => !s.dying).length;

  // Born as the spin crosses the threshold: one full set at once, spaced
  // evenly round the ball, so the mark arrives as a pattern and not one
  // stroke at a time.
  if (want > 0 && alive === 0) {
    const start = Math.random() * TAU;
    for (let i = 0; i < count; i++) {
      streaks.push({ phase: start + (i / count) * TAU, arc: 0, fade: 0, lane: i, dying: false });
    }
  }

  const rate = Math.max(0.1, c.trimRate ?? 6);
  const travel = (c.travel ?? 1.35) * spin;
  const fadeIn = Math.max(0.01, c.fadeIn ?? 0.12);
  const fadeOut = Math.max(0.01, c.fadeOut ?? 0.25);
  for (const s of streaks) {
    if (want <= 0) s.dying = true;
    else if (s.dying && alive === 0) s.dying = false; // spin came back before the last set left
    s.phase += travel * dt;
    const target = s.dying ? 0 : want;
    s.arc += (target - s.arc) * Math.min(1, rate * dt);
    s.fade += (s.dying ? -dt / fadeOut : dt / fadeIn);
    s.fade = Math.max(0, Math.min(1, s.fade));
  }
  for (let i = streaks.length - 1; i >= 0; i--) {
    const s = streaks[i];
    if (s.dying && s.fade <= 0) streaks.splice(i, 1);
  }
}

const _col = new THREE.Color();

/**
 * Write the geometry. `ball` is anything with x/y/r; `radiusAt(angle)` gives
 * the soft body's radius at a world angle, so the strokes follow the dents —
 * pass null and they sit on the rigid circle.
 */
export function renderBallSpin(ball, radiusAt = null) {
  build();
  const geo = state.geo;
  if (!geo) return 0;
  const c = cfg();
  if (!streaks.length || c.enabled === false) { geo.setDrawRange(0, 0); return 0; }
  const segs = state.segs;
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  _col.set(c.color ?? 0xffffff).multiplyScalar(c.glow ?? 1);
  const hug = c.hug ?? 1.14;
  const lift = (c.lift ?? 0.11) * ball.r;
  const width = c.width ?? 0.34;
  const head = Math.max(0.01, Math.min(0.9, c.head ?? 0.22));
  const tail = Math.max(0.01, Math.min(0.9, c.tail ?? 0.55));
  const flare = (c.flare ?? 0) * ball.r;
  // Which end leads depends on which way it is going.
  const dir = state.spin >= 0 ? 1 : -1;
  let drawn = 0;
  let v = 0;
  const arcMax = Math.max(0.01, c.arcMax ?? 1.5);
  for (const s of streaks) {
    if (drawn >= state.cap) break;
    if (s.arc < 1e-3 || s.fade <= 0) continue;
    // A short stroke is a thin one: the band's width rides its length, so
    // the tick a light spin earns is a sliver and not a chip of the same
    // thickness as the full stroke.
    const wArc = width * (0.35 + 0.65 * Math.min(1, s.arc / arcMax));
    const base = drawn * (segs + 1) * 2;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;                         // 0 = trailing end, 1 = leading end
      const a = s.phase + (t - 0.5) * s.arc * dir;
      // The tail (t = 0) lifts off the surface by `flare`, the head sits on it.
      const rr = (radiusAt ? radiusAt(a) : ball.r) * hug + s.lane * lift + flare * (1 - t) * (1 - t);
      // The taper: a smooth rise over `tail` from the back, a smooth fall
      // over `head` to the front, full in between.
      const w = Math.min(1, smooth(t / tail), smooth((1 - t) / head));
      const half = wArc * 0.5 * w;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const vi = base + i * 2;
      pos.setXYZ(vi, ball.x + ca * (rr - half), ball.y + sa * (rr - half), 0);
      pos.setXYZ(vi + 1, ball.x + ca * (rr + half), ball.y + sa * (rr + half), 0);
      const k = w * s.fade;
      col.setXYZ(vi, _col.r * k, _col.g * k, _col.b * k);
      col.setXYZ(vi + 1, _col.r * k, _col.g * k, _col.b * k);
      v = vi + 2;
    }
    drawn++;
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geo.setDrawRange(0, drawn * segs * 6);
  return drawn;
}

/** For the harness and the lab. */
export function ballSpinState() {
  return { spin: state.spin, streaks: streaks.map((s) => ({ ...s })), drawn: state.geo ? state.geo.drawRange.count / 6 / Math.max(1, state.segs) : 0 };
}
