// ---------------------------------------------------------------------------
// THE REPLAY'S CAMERA POOL — virtual cameras with weighted targets, and a
// director that keeps the one with the best angle on the action.
//
// The game is filmed by one orthographic camera on the flat plane (world.js).
// A replay is filmed by THIS: a pool of PerspectiveCamera shots that leave the
// plane — swung round the action in yaw and pitch, dollied in and out, pushed
// in slowly — and a director that scores every shot every frame and cuts or
// blends to the best one the moment the current shot stops framing the play.
//
// A SHOT (CONFIG.versus.replay.cams.shots[]) is:
//   targets   { poi: weight } — the points of interest it frames. The look-at
//             is their weighted centroid; the framing score is how well each
//             projects into the frame, weighted.
//   yaw       degrees the camera swings round the look-at, ABOUT THE VERTICAL,
//             toward the goal the ball is heading for (so one shot serves
//             both ends). 0 is the flat plane.
//   pitch     degrees above the look-at (negative: a low angle looking up).
//   distance  world units from the look-at; `dolly` moves it per second held.
//   fov       degrees; `push` is a slow zoom-in — the fov it settles toward
//             over `pushTime` seconds on the shot.
//   beats     which of the replay's beats it may be used in.
//   lens      the defocus for post.js: amount, radius and feather of the
//             sharp region round the primary target (a radial focus — the
//             one lens the composite has; see cineLens in cineCamera.js).
//   hold      [min, max] seconds: never cut away before min, tire after max.
//
// THE DIRECTOR (updatePool): score = framing (weighted targets in frame and
// near centre; targets out of frame cost `edgePenalty` each) + beat affinity
// + a bonus for a fresh shot + a penalty growing past hold.max. The current
// shot keeps the frame while it is within `margin` of the best and past its
// hold.min; otherwise the best takes over — a CUT when the two angles differ
// by more than `cutAngle` degrees or the distance by more than `cutDistance`,
// a BLEND over `blend` seconds when they are neighbours. A target that leaves
// the frame is what usually forces the change, which is the rule as stated:
// when a shot no longer frames the action, go to the one that does.
//
// POINTS OF INTEREST come from the caller each frame (pois): ball, striker,
// strikerFace, scorer, scorerFace, defender, mouth, impact — world XY (z 0),
// posed from the replay's record. Faces are the seal's nose end.
//
// THE CAMERA IS KEPT IN THE WATER: x inside the walls, y above the sand,
// whatever the shot asked for — a camera inside the shore rock sees rock.
//
// AND IT NEVER SEES THE SEAMS. The shore is a carved mesh along the wall and
// the goal is a tunnel cut through it: from the flat plane the mouth is a
// dark hole and the rock a face, and from any angle they are a box with
// inner walls and side faces. Three rules keep those off screen, all in
// poseShot: a shot's yaw and pitch flatten toward zero as its look-at closes
// on a wall (`nearWall` → `nearWallMin`), so a shot looking at the mouth
// looks at it square, the way the game does; the frame is SLID off the wall
// — the look-at moves inward until the frame's edge on the action's plane
// sits `pastFace` past the goal's face, and the same off the sand and the
// top of the water — so the entrance is at the edge of the frame and the
// tunnel behind it is out of it, with the rest of the frame given to the
// pitch where the other targets are; and only a frame wider than the pitch
// itself has its fov capped. A last projection check shrinks the fov if any
// of that still left a face inside the frame.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../config.js';

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (t) => t * t * (3 - 2 * t);

const cfg = () => CONFIG.versus?.replay?.cams ?? {};

/** The pose a shot resolves to this frame. */
function makePose() {
  return { pos: new THREE.Vector3(), at: new THREE.Vector3(), fov: 40 };
}

export const poolState = {
  active: false,
  camera: new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 600),
  shot: -1,            // index into shots, -1 = none yet
  shotName: null,
  onShot: 0,           // seconds on the current shot
  used: [],            // seconds since each shot was last used (Infinity = never)
  cuts: 0,             // hard cuts this replay
  blends: 0,           // blends this replay
  blendT: 0,           // 0..1 through a blend, 1 = settled
  blendDur: 0,
  from: makePose(),    // the pose the blend left
  cur: makePose(),     // the pose being rendered
  scores: [],          // last frame's scores, by shot, for the harness
  fovPush: 0,          // 0..1 how far the current shot's push-in has run
  focus: new THREE.Vector3(), // the primary target, world
  focusUv: { x: 0.5, y: 0.5 }, // ...projected, for the lens
  lens: { defocus: 0, focusRadius: 1, focusFeather: 1 },
};

const _goal = makePose();
const _cam = new THREE.PerspectiveCamera();
const _v = new THREE.Vector3();
const _off = new THREE.Vector3();
const _q = new THREE.Vector3();

/** Start a replay's directing afresh. `aspect` is the canvas's. */
export function resetPool(aspect = 16 / 9) {
  const st = poolState;
  const shots = cfg().shots ?? [];
  st.active = true;
  st.shot = -1;
  st.shotName = null;
  st.onShot = 0;
  st.used = shots.map(() => Infinity);
  st.cuts = 0;
  st.blends = 0;
  st.blendT = 1;
  st.blendDur = 0;
  st.scores = shots.map(() => -Infinity);
  st.fovPush = 0;
  st.camera.aspect = aspect;
  st.camera.updateProjectionMatrix();
}

export function stopPool() {
  poolState.active = false;
}

/** The weighted centroid of a shot's targets. */
function lookAtOf(shot, pois, out) {
  let wx = 0; let wy = 0; let wz = 0; let W = 0;
  for (const [name, w] of Object.entries(shot.targets ?? {})) {
    const p = pois[name];
    if (!p || !(w > 0)) continue;
    wx += p.x * w; wy += p.y * w; wz += (p.z ?? 0) * w; W += w;
  }
  if (W <= 0) { out.set(pois.ball?.x ?? 0, pois.ball?.y ?? 0, 0); return out; }
  out.set(wx / W, wy / W, wz / W);
  return out;
}

/** The heaviest target of a shot — what the lens focuses on. */
function primaryOf(shot, pois) {
  let best = null; let bw = -1;
  for (const [name, w] of Object.entries(shot.targets ?? {})) {
    if (pois[name] && w > bw) { bw = w; best = pois[name]; }
  }
  return best;
}

/**
 * Where shot `i` would put the camera this frame, into `out` — and the fov,
 * with the push-in and the dolly for `held` seconds on the shot.
 */
function poseShot(shot, pois, side, held, bounds, out, aspect = 16 / 9) {
  const c = cfg();
  lookAtOf(shot, pois, out.at);
  // Flatten toward the plane as the look-at nears a wall: an angled look at
  // the mouth is a look into the tunnel.
  let flat = 1;
  if (bounds) {
    const dWall = Math.min(out.at.x - bounds.left, bounds.right - out.at.x);
    const near = c.nearWall ?? 26;
    const min = c.nearWallMin ?? 8;
    flat = clamp01((dWall - min) / Math.max(0.01, near - min));
  }
  const yaw = (shot.yaw ?? 0) * DEG * (side < 0 ? -1 : 1) * flat;
  const pitch = (shot.pitch ?? 0) * DEG * lerp(c.pitchAtWall ?? 0.25, 1, flat);
  const dist = Math.max(1, (shot.distance ?? 30) + (shot.dolly ?? 0) * held);
  _off.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist);
  out.pos.copy(out.at).add(_off);
  // In the water, whatever was asked.
  const inset = c.wallInset ?? 3;
  if (bounds) {
    out.pos.x = Math.max(bounds.left + inset, Math.min(bounds.right - inset, out.pos.x));
    out.pos.y = Math.max(bounds.bottom + (c.floorInset ?? 2), out.pos.y);
  }
  // The push: the fov eases from `fov` toward `push` over `pushTime`.
  const fov = shot.fov ?? 40;
  const push = shot.push ?? fov;
  const pt = Math.max(0.05, shot.pushTime ?? 3);
  const k = 1 - Math.exp(-held / pt);
  out.fov = lerp(fov, push, k);
  // THE FRAME STOPS AT THE MOUTH — by sliding, not shrinking. On the plane
  // the action is on the frame is ~2 d tan(fov/2) tall and `aspect` times as
  // wide about the look-at. Slide the look-at (and the camera with it, the
  // offset is the shot's) until no edge reaches past a goal's face, the sand
  // or the top of the water by more than `pastFace`; a frame wider or taller
  // than the room has its fov capped and sits centred.
  if (bounds) {
    const past = c.pastFace ?? 2.5;
    const loX = bounds.left - past; const hiX = bounds.right + past;
    const loY = bounds.bottom - past; const hiY = (bounds.top ?? out.at.y + 99) + past;
    const d = out.pos.distanceTo(out.at);
    let hh = d * Math.tan((out.fov * DEG) / 2);
    let hw = hh * aspect;
    const roomX = (hiX - loX) / 2;
    const roomY = (hiY - loY) / 2;
    if (hw > roomX || hh > roomY) {
      const scale = Math.min(roomX / hw, roomY / hh);
      out.fov = Math.max(c.fovMin ?? 12, 2 * Math.atan(hh * scale / Math.max(1e-6, d)) / DEG);
      hh = d * Math.tan((out.fov * DEG) / 2);
      hw = hh * aspect;
    }
    const nx = Math.max(loX + hw, Math.min(hiX - hw, out.at.x));
    const ny = Math.max(loY + hh, Math.min(hiY - hh, out.at.y));
    if (nx !== out.at.x || ny !== out.at.y) {
      out.pos.x += nx - out.at.x;
      out.pos.y += ny - out.at.y;
      out.at.x = nx;
      out.at.y = ny;
    }
    out.pos.x = Math.max(bounds.left + inset, Math.min(bounds.right - inset, out.pos.x));
    out.pos.y = Math.max(bounds.bottom + (c.floorInset ?? 2), out.pos.y);
    // The safety net: an angled frame is not the rectangle above. Project the
    // two faces (a little past `pastFace`) and shrink until both are out.
    for (let n = 0; n < 6; n++) {
      _cam.fov = out.fov; _cam.aspect = aspect; _cam.near = 0.5; _cam.far = 600;
      _cam.position.copy(out.pos); _cam.up.set(0, 1, 0); _cam.lookAt(out.at);
      _cam.updateMatrixWorld(); _cam.updateProjectionMatrix();
      let seam = false;
      for (const sd of [-1, 1]) {
        const fx = (sd < 0 ? bounds.left : bounds.right) + sd * (past + 1);
        _q.set(fx, out.at.y, 0).project(_cam);
        if (_q.z < 1 && Math.abs(_q.x) <= 1 && Math.abs(_q.y) <= 1) seam = true;
      }
      if (!seam || out.fov <= (c.fovMin ?? 12)) break;
      out.fov = Math.max(c.fovMin ?? 12, out.fov * 0.85);
    }
  }
  return out;
}

/**
 * How well a shot posed at `pose` frames its targets: each target projects
 * into the frame and scores its weight times how central it is; a target
 * outside the frame costs `edgePenalty` times its weight.
 */
function framingScore(shot, pose, pois, aspect) {
  const c = cfg().pool ?? {};
  _cam.fov = pose.fov; _cam.aspect = aspect; _cam.near = 0.5; _cam.far = 600;
  _cam.position.copy(pose.pos);
  _cam.up.set(0, 1, 0);
  _cam.lookAt(pose.at);
  _cam.updateMatrixWorld();
  _cam.updateProjectionMatrix();
  let score = 0;
  for (const [name, w] of Object.entries(shot.targets ?? {})) {
    const p = pois[name];
    if (!p || !(w > 0)) continue;
    _q.set(p.x, p.y, p.z ?? 0).project(_cam);
    const inside = _q.z < 1 && Math.abs(_q.x) <= 1 && Math.abs(_q.y) <= 1;
    if (!inside) { score -= (c.edgePenalty ?? 2) * w; continue; }
    const r = Math.hypot(_q.x, _q.y);
    score += w * (1 - 0.5 * Math.min(1, r * r));
  }
  return score;
}

/** Every target of a shot inside the frame it is rendering right now? For the harness. */
export function targetsInFrame(shot, pois, camera = poolState.camera) {
  for (const [name, w] of Object.entries(shot.targets ?? {})) {
    const p = pois[name];
    if (!p || !(w > 0)) continue;
    _q.set(p.x, p.y, p.z ?? 0).project(camera);
    if (!(_q.z < 1 && Math.abs(_q.x) <= 1 && Math.abs(_q.y) <= 1)) return false;
  }
  return true;
}

/**
 * The director's frame. `ctx`: { beat, side, pois, bounds, aspect, dt } — dt
 * is WALL seconds. Poses the pool's camera and lens for this frame.
 */
export function updatePool(ctx) {
  const st = poolState;
  const c = cfg();
  const pool = c.pool ?? {};
  const shots = c.shots ?? [];
  if (!st.active || !shots.length) return null;
  const { beat, side, pois, bounds, aspect, dt } = ctx;
  if (aspect && st.camera.aspect !== aspect) { st.camera.aspect = aspect; st.camera.updateProjectionMatrix(); }
  for (let i = 0; i < shots.length; i++) if (st.used[i] !== Infinity) st.used[i] += dt;
  st.onShot += dt;

  // Score every shot as it would be posed right now.
  let best = -1; let bestScore = -Infinity;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const held = i === st.shot ? st.onShot : 0;
    poseShot(shot, pois, side, held, bounds, _goal, aspect);
    let score = framingScore(shot, _goal, pois, aspect);
    const beats = shot.beats ?? null;
    if (beats && !beats.includes(beat)) score -= pool.offBeat ?? 3;
    const hold = shot.hold ?? [0.6, 2.2];
    if (i === st.shot) {
      if (st.onShot > hold[1]) score -= (pool.fatigue ?? 0.6) * (st.onShot - hold[1]);
    } else {
      // Fresh shots first: one used a moment ago is not the next cut.
      const since = st.used[i];
      if (since < (pool.cooldown ?? 3)) score -= (pool.recentPenalty ?? 1) * (1 - since / (pool.cooldown ?? 3));
      score += shot.priority ?? 0;
    }
    st.scores[i] = score;
    if (score > bestScore) { bestScore = score; best = i; }
  }

  // Stay or go. The current shot holds while it is close enough to the best
  // and has had its minimum; the first frame always takes the best.
  const curScore = st.shot >= 0 ? st.scores[st.shot] : -Infinity;
  const hold = st.shot >= 0 ? (shots[st.shot].hold ?? [0.6, 2.2]) : [0, 0];
  const mustStay = st.shot >= 0 && st.onShot < hold[0];
  if (best >= 0 && best !== st.shot && !mustStay && bestScore > curScore + (pool.margin ?? 0.35)) {
    switchTo(best, shots, pois, side, bounds, pool);
  }
  if (st.shot < 0) return null;

  // Pose the current shot, blend if one is running, and write the camera.
  const shot = shots[st.shot];
  poseShot(shot, pois, side, st.onShot, bounds, _goal, aspect);
  if (st.blendT < 1) {
    st.blendT = Math.min(1, st.blendT + dt / Math.max(0.01, st.blendDur));
    const e = smooth(st.blendT);
    st.cur.pos.lerpVectors(st.from.pos, _goal.pos, e);
    st.cur.at.lerpVectors(st.from.at, _goal.at, e);
    st.cur.fov = lerp(st.from.fov, _goal.fov, e);
  } else {
    st.cur.pos.copy(_goal.pos);
    st.cur.at.copy(_goal.at);
    st.cur.fov = _goal.fov;
  }
  const cam = st.camera;
  cam.position.copy(st.cur.pos);
  cam.up.set(0, 1, 0);
  cam.lookAt(st.cur.at);
  cam.fov = st.cur.fov;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  // For the particle scaler: how far the plane the action is on sits from the lens.
  cam.userData.focusDistance = cam.position.distanceTo(st.cur.at);
  st.fovPush = clamp01(((shot.fov ?? 40) - st.cur.fov) / Math.max(1e-6, (shot.fov ?? 40) - (shot.push ?? shot.fov ?? 40)));

  // The lens: the sharp region round the primary target, its size the shot's.
  const prim = primaryOf(shot, pois);
  if (prim) st.focus.set(prim.x, prim.y, prim.z ?? 0); else st.focus.copy(st.cur.at);
  _v.copy(st.focus).project(cam);
  st.focusUv.x = clamp01(_v.x * 0.5 + 0.5);
  st.focusUv.y = clamp01(_v.y * 0.5 + 0.5);
  const lens = shot.lens ?? {};
  const fade = clamp01(st.onShot / Math.max(0.05, pool.lensFade ?? 0.4));
  st.lens.defocus = (lens.defocus ?? c.lens?.defocus ?? 0) * fade;
  st.lens.focusRadius = lens.focusRadius ?? c.lens?.focusRadius ?? 0.25;
  st.lens.focusFeather = lens.focusFeather ?? c.lens?.focusFeather ?? 0.35;
  return cam;
}

/** Cut or blend to shot `i`, by how far its angle is from the current one. */
function switchTo(i, shots, pois, side, bounds, pool) {
  const st = poolState;
  const prev = st.shot;
  const next = shots[i];
  let cut = true;
  if (prev >= 0) {
    const a = shots[prev];
    const dYaw = Math.abs((a.yaw ?? 0) - (next.yaw ?? 0));
    const dPitch = Math.abs((a.pitch ?? 0) - (next.pitch ?? 0));
    const dDist = Math.abs((a.distance ?? 30) - (next.distance ?? 30));
    cut = Math.hypot(dYaw, dPitch) > (pool.cutAngle ?? 25) || dDist > (pool.cutDistance ?? 25) || next.cut === true;
    if (next.blend === true) cut = false;
  }
  if (prev >= 0) st.used[prev] = 0;
  st.shot = i;
  st.shotName = next.name ?? String(i);
  st.onShot = 0;
  if (cut || prev < 0) {
    st.cuts++;
    st.blendT = 1;
  } else {
    st.blends++;
    st.from.pos.copy(st.cur.pos);
    st.from.at.copy(st.cur.at);
    st.from.fov = st.cur.fov;
    st.blendT = 0;
    st.blendDur = Math.max(0.05, next.blendTime ?? pool.blend ?? 0.45);
  }
}
