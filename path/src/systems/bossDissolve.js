import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emitCloud } from '../entities/particles.js';
import { sampleTexture, bodyPalette } from './bodyPalette.js';

// ---------------------------------------------------------------------------
// THE BODY COMING APART INTO ITS OWN COLOURS
//
// THE PROBLEM IS ONE FRAME. systems/bossCorpse.js holds the dead animal whole
// for a beat, the photograph is taken, and then burst() throws the gibs, hands
// the hitbox back and calls releaseVisual — and on that frame the boss is
// simply GONE. A few hundred chunks fly out of where it was, which reads as
// debris rather than as a body, and the largest thing in the run vanishes on a
// cut in the middle of the one moment the game holds still for.
//
// So on that exact frame the mesh is replaced by a cloud in its own shape: one
// particle per sampled vertex, each wearing the colour of the skin it came off,
// hanging almost still in the water and shrinking away over a few seconds. The
// animal is never seen being deleted, because what is standing there afterwards
// is still the animal.
//
// TONS OF DRAG, ALMOST NO VELOCITY. This is not an explosion — the explosion
// already happened half a second ago (systems/bossBoom.js) and threw a cloud
// off the body's outline. This is the body ITSELF letting go, so the points
// barely move: a whisper outward from the centroid so the silhouette softens
// rather than sitting there as a perfect stencil, and a drag high enough that
// they have stopped within a few tenths of a second. Everything after that is
// the size ramp.
//
// THE COLOUR IS READ OFF THE SKIN, PER POINT. Not one tint, and not the palette
// mixed — the actual texel under that vertex's UV, so the megalodon's gums come
// out pink and its flank grey and its eye dark, in the places those things were.
// See sampleTexture in systems/bodyPalette.js. A body that keeps its colour
// somewhere a texel cannot answer for — the orca, which is painted entirely by
// biolumSkin uniforms — falls back to that body's measured palette, picked per
// point, which is the same set of colours without the placement.
//
// IT IS SAMPLED FROM THE POSED BODY. The mesh is skinned and has been folding
// since it died (systems/bossRagdoll.js), so a cloud built from the bind pose
// is a cloud in the shape of an animal that is not there. Every point goes
// through SkinnedMesh.applyBoneTransform and then the mesh's own world matrix,
// which is the same two steps systems/hitShape.js takes for its spheres.
//
// IT REUSES THE PARTICLE POOL. There is no second buffer, no second shader and
// no second closed form for drag — entities/particles.js already has all three
// and they are already tuned. What it did not have was a way to place particles
// individually, which is emitCloud(); see the note there for why a thousand
// emit() calls is the wrong shape rather than merely slower.
//
// TUNING is CONFIG.boss.dissolve for the shape of it and CONFIG.emitters
// .bossDissolve for what a point looks like.
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();
const _matCol = new THREE.Color();
const _uv = new THREE.Vector2();
const _uv2 = new THREE.Vector2();

// The scratch the cloud is built into, grown once and reused. A boss death
// allocating eight typed arrays of two thousand floats is a garbage spike on
// the frame the body bursts, which is the one frame in the run already doing
// the most work.
const buf = {
  count: 0,
  cap: 0,
  x: null, y: null, vx: null, vy: null, r: null, g: null, b: null, size: null,
};

function ensure(n) {
  if (buf.cap >= n) return;
  buf.cap = n;
  buf.x = new Float32Array(n);
  buf.y = new Float32Array(n);
  buf.vx = new Float32Array(n);
  buf.vy = new Float32Array(n);
  buf.r = new Float32Array(n);
  buf.g = new Float32Array(n);
  buf.b = new Float32Array(n);
  buf.size = new Float32Array(n);
}

function cfg() {
  return CONFIG.boss?.dissolve ?? {};
}

// Every mesh worth sampling, with how many vertices each has.
//
// NOT THE OUTLINE SHELL. It is a back-faced copy of the whole body wearing one
// flat rim colour (see assets.js), so sampling it would double every point and
// paint half the cloud the same near-black — the same exclusion attachDamageGlow
// and bodyPalette both make, for the same reason.
function partsOf(root) {
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat?.userData?.__isOutline) return;
    const area = areaTableFor(o.geometry);
    if (!area) return;
    out.push({ mesh: o, mat, area });
  });
  return out;
}

// ---------------------------------------------------------------------------
// WHERE TO SAMPLE, AND WHY IT IS NOT THE VERTICES
// ---------------------------------------------------------------------------
// "One particle per vertex" is the obvious build and it produced a THIN
// ZIGZAG STRAND with a bright knot at the mouth, which is not what a shark
// looks like. Two separate faults, both invisible from the code:
//
//   THE STRIDE ALIASED. Walking the vertex array every nth entry samples a
//   structured list with a regular comb. A rigged fish's vertices are ordered
//   in rings around the body, so every eleventh one traces a helix — the
//   samples came out as a neat strand winding down the animal instead of as a
//   body. The pattern looks deliberate, which is the worst kind of wrong.
//
//   VERTEX DENSITY IS NOT SURFACE. Half the megalodon's triangles are its
//   teeth and its eye. Sampled per vertex, half the cloud was the inside of its
//   mouth, in bright pink, in a knot the size of its head — an accurate
//   reading of where the polygons are and a terrible reading of where the
//   ANIMAL is.
//
// So points are drawn from TRIANGLES, weighted by area, at a random barycentric
// point inside each. Uniform over the actual surface: dense where the animal is
// big rather than where the modeller happened to spend geometry, and with no
// comb to alias against. It also stops being "a vertex" — the colour is the
// interpolated UV's texel, which is strictly more of the skin than the corners
// were.
//
// THE AREAS ARE MEASURED IN THE BIND POSE and cached on the geometry. Measuring
// them posed would mean skinning every triangle of every boss on the frame it
// bursts, for a correction of a few percent — a swimming animal's surface area
// is very nearly its bind area, and what this number is for is deciding how
// many points a flank gets relative to a fin.
const areaCache = new WeakMap();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c3 = new THREE.Vector3();
function areaTableFor(geo) {
  const hit = areaCache.get(geo);
  if (hit !== undefined) return hit;
  const pos = geo.attributes?.position;
  let out = null;
  if (pos) {
    const idx = geo.index;
    const tris = idx ? idx.count / 3 : pos.count / 3;
    if (tris >= 1) {
      const cum = new Float64Array(tris);
      let total = 0;
      for (let t = 0; t < tris; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        _a.fromBufferAttribute(pos, i0);
        _b.fromBufferAttribute(pos, i1).sub(_a);
        _c3.fromBufferAttribute(pos, i2).sub(_a);
        total += _b.cross(_c3).length() * 0.5;
        cum[t] = total;
      }
      if (total > 0) out = { cum, total, tris, idx };
    }
  }
  areaCache.set(geo, out);
  return out;
}

// Which triangle a uniform draw over the surface lands in.
function triangleAt(area, r) {
  let lo = 0;
  let hi = area.tris - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (area.cum[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Replace this body with a cloud of its own vertices.
 *
 * Called from systems/bossCorpse.js's burst(), on the frame the visual goes
 * back to the pool and BEFORE releaseVisual — the mesh has to still be posed
 * and still be in the scene graph for any of this to read anything.
 *
 * @returns how many points went out. 0 means nothing was sampled and the
 *          caller has nothing to wait for; the body simply disappears as it
 *          did before, which is the whole of the fallback.
 */
export function spawnBossDissolve(e) {
  const c = cfg();
  if (c.enabled === false || !e) return 0;
  const root = e.visual?.isObject3D ? e.visual : (e.mesh?.isObject3D ? e.mesh : null);
  if (!root) return 0;

  // WORLD MATRICES FIRST, and this is the line the whole effect fails silently
  // without: three only refreshes them during a render, so a body sampled after
  // the ragdoll's last write but before the next frame reports every vertex at
  // the place it was one frame ago — or, on the frame of a spawn, at its bind
  // pose. The cloud comes out as a perfectly good animal in the wrong shape.
  root.updateWorldMatrix(true, true);

  const parts = partsOf(root);
  if (!parts.length) return 0;
  const total = parts.reduce((n, p) => n + p.area.total, 0);
  if (!(total > 0)) return 0;

  const want = Math.max(1, Math.round(c.points ?? 1400));
  ensure(want);
  buf.count = 0;

  // THE FALLBACK COLOURS, resolved once. A body with no texture to sample —
  // the orca is painted entirely in shader uniforms — still has a measured
  // palette, and picking from it per point gives the same set of colours
  // without the placement. Resolved here rather than per point because
  // bodyPalette walks the whole mesh.
  const pal = bodyPalette(e)?.swatches ?? null;

  // Where the body's middle is, for the outward whisper. The mean of the points
  // themselves rather than mesh.position: a rig's origin sits wherever the
  // artist left it, which for most of this roster is the head — see the same
  // note in measureBossBody.
  let cx = 0;
  let cy = 0;

  for (const part of parts) {
    // Proportional to the part's SURFACE AREA, so a boss whose teeth carry half
    // its triangles does not get half its cloud made of teeth — see the note on
    // areaTableFor, where that is one of the two faults this replaced.
    const share = Math.max(1, Math.round((part.area.total / total) * want));
    const geo = part.mesh.geometry;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const vcol = geo.attributes.color;
    const idx = part.area.idx;
    const skinned = part.mesh.isSkinnedMesh;
    const map = part.mat?.map ?? null;
    if (part.mat?.color) _matCol.copy(part.mat.color);
    else _matCol.setRGB(1, 1, 1);
    // A white material colour under a map is a MULTIPLIER of 1, not a tint —
    // the same fact bodyPalette turns on. Multiplying by it is correct either
    // way; what would be wrong is treating it as the answer.

    for (let s = 0; s < share && buf.count < want; s++) {
      // STRATIFIED, not uniform: the draw is jittered inside its own slice of
      // the area rather than taken freely over the whole of it. Free draws
      // clump and leave holes at this count, which on a silhouette reads as the
      // body being moth-eaten; one draw per equal slice covers the animal and
      // still has no comb to alias against.
      const r = ((s + Math.random()) / share) * part.area.total;
      const t = triangleAt(part.area, r);
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      // A uniform point in a triangle. The sqrt is what makes it uniform rather
      // than piled toward one corner.
      let bu = Math.random();
      let bv = Math.random();
      const su = Math.sqrt(bu);
      bu = 1 - su;
      bv = bv * su;
      const bw = 1 - bu - bv;

      // THE POSE, not the bind. applyBoneTransform folds in the skeleton and
      // the bind matrix; without it every boss dissolves in a T-pose, which on
      // a fish is a straight rigid body and looks like a deliberate style.
      // Done per CORNER and then interpolated, because a skinned triangle's
      // interior is not the transform of its bind interior.
      _v.fromBufferAttribute(pos, i0);
      if (skinned) part.mesh.applyBoneTransform(i0, _v);
      _p.copy(_v).multiplyScalar(bu);
      _v.fromBufferAttribute(pos, i1);
      if (skinned) part.mesh.applyBoneTransform(i1, _v);
      _p.addScaledVector(_v, bv);
      _v.fromBufferAttribute(pos, i2);
      if (skinned) part.mesh.applyBoneTransform(i2, _v);
      _p.addScaledVector(_v, bw);
      part.mesh.localToWorld(_p);

      let got = false;
      if (vcol) {
        // A model that carries real vertex colours is the easy case and none of
        // this roster does — kept because an uploaded model might, and because
        // it is the thing this effect is named after.
        _col.fromBufferAttribute(vcol, i0).multiplyScalar(bu);
        _col2.fromBufferAttribute(vcol, i1);
        _col.addScaledVector(_col2, bv);
        _col2.fromBufferAttribute(vcol, i2);
        _col.addScaledVector(_col2, bw);
        got = true;
      } else if (map && uv) {
        _uv.fromBufferAttribute(uv, i0).multiplyScalar(bu);
        _uv2.fromBufferAttribute(uv, i1);
        _uv.addScaledVector(_uv2, bv);
        _uv2.fromBufferAttribute(uv, i2);
        _uv.addScaledVector(_uv2, bw);
        got = sampleTexture(map, _uv.x, _uv.y, _col);
      }
      if (got) {
        _col.multiply(_matCol);
      } else if (pal?.length) {
        // Weighted by share, so the cloud has the same colour mix the body
        // measured as even where it cannot be placed.
        let f = Math.random();
        let pick = pal[pal.length - 1];
        for (const sw of pal) { f -= sw.share; if (f <= 0) { pick = sw; break; } }
        _col.setHex(pick.hex);
      } else {
        _col.copy(_matCol);
      }

      const k = buf.count++;
      buf.x[k] = _p.x;
      buf.y[k] = _p.y;
      buf.r[k] = _col.r;
      buf.g[k] = _col.g;
      buf.b[k] = _col.b;
      cx += _p.x;
      cy += _p.y;
    }
  }

  const n = buf.count;
  if (!n) return 0;
  cx /= n;
  cy /= n;

  // THE WHISPER. Outward from the middle, and small — a body letting go, not
  // an explosion. Scaled by how far the point is from the centre rather than
  // flat, so the silhouette opens instead of the whole cloud sliding: the
  // outside edge drifts and the middle stays put, which is what softens the
  // stencil the sampled vertices would otherwise be.
  //
  // Plus a share of what the animal was doing, for the reason the explosion
  // takes one: a cloud hanging exactly where the body was reads as an effect
  // played at a coordinate.
  const push = c.push ?? 0.55;
  const spin = c.swirl ?? 0.25;
  const inherit = c.inherit ?? 0.25;
  const jitter = Math.max(0, c.jitter ?? 0.35);
  const sizeLo = c.size?.[0] ?? 0.55;
  const sizeHi = c.size?.[1] ?? 1.35;
  const minPeak = Math.max(0, c.minPeak ?? 0.22);
  for (let i = 0; i < n; i++) {
    const dx = buf.x[i] - cx;
    const dy = buf.y[i] - cy;
    // PER UNIT OF DISTANCE, not a flat speed: `push` times the offset itself,
    // so the outside edge drifts and the middle stays put. A flat speed slides
    // the whole cloud outward as a shell of constant thickness, which keeps the
    // stencil it is meant to soften and just makes it bigger.
    const out = push * (1 + (Math.random() - 0.5) * jitter);
    // A little rotation on top of it. Purely so the cloud is not a radial star:
    // at swirl 0 every point moves along its own spoke, and the few tenths of a
    // second before the drag catches them reads as a zoom.
    buf.vx[i] = dx * out - dy * spin + (e.vx ?? 0) * inherit;
    buf.vy[i] = dy * out + dx * spin + (e.vy ?? 0) * inherit;
    buf.size[i] = sizeLo + Math.random() * (sizeHi - sizeLo);

    // AND A FLOOR UNDER THE DARK POINTS. The colours here are the animal's own
    // and most of this roster is a near-black hide; the composite writes linear
    // straight to the framebuffer and drops everything about a stop and a half
    // further, so an untouched hide texel is a particle nobody can see. Lifted
    // on the PEAK CHANNEL, which keeps the hue and the point's place in the
    // body's own light-to-dark order — scaling toward white instead would give
    // every boss the same grey cloud, which is the thing sampling per vertex
    // exists to avoid.
    if (minPeak > 0) {
      const peak = Math.max(buf.r[i], buf.g[i], buf.b[i]);
      if (peak > 0 && peak < minPeak) {
        const m = minPeak / peak;
        buf.r[i] *= m;
        buf.g[i] *= m;
        buf.b[i] *= m;
      }
    }
  }

  return emitCloud('bossDissolve', buf, {
    glow: c.glow ?? 1,
    sizeMul: c.sizeMul ?? 1,
  });
}

/** For the harness and the look sheet. How many points the LAST body produced. */
export function bossDissolveCount() {
  return buf.count;
}

/**
 * For the harness. The cloud as it was built, before it went into the pool.
 *
 * A copy of the live scratch, which is reused between bodies — a caller holding
 * the arrays themselves would be reading the next boss's cloud.
 */
export function bossDissolveCloud() {
  const n = buf.count;
  return {
    count: n,
    x: buf.x?.slice(0, n),
    y: buf.y?.slice(0, n),
    vx: buf.vx?.slice(0, n),
    vy: buf.vy?.slice(0, n),
    r: buf.r?.slice(0, n),
    g: buf.g?.slice(0, n),
    b: buf.b?.slice(0, n),
    size: buf.size?.slice(0, n),
  };
}

/**
 * End of a run, or the start of one.
 *
 * Only the bookkeeping: the points themselves are the particle system's from
 * the moment they are emitted, and resetParticles() is what clears those. A
 * second owner of a slot in that ring buffer is how a cloud ends up describing
 * whatever burst recycled it.
 */
export function resetBossDissolve() {
  buf.count = 0;
}
