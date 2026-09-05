import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ease } from '../ease.js';
import { createVisual, addOutlineShells, setOutlineThicknessOn } from '../assets.js';
import { createAnimationController, stateForSpeed } from './animation.js';
import { dressBody } from './accessories.js';
import { celebrationState } from './celebrate.js';

// ---------------------------------------------------------------------------
// THE SEAL COMING BACK.
//
// A pick sends the watching seal (systems/levelUpSeal.js) off the top of the
// screen, and the comb drains behind it. Then, for as long as the clock takes
// to ramp from half speed back to full, a translucent copy of the RUN'S seal
// swims in from the bottom of the screen, follows the last stretch of the
// path the player actually swam before the level, and lands in the exact pose
// the real seal has been holding under the cards — bone for bone. The frame
// it lands is the frame the run goes live.
//
// It is one animal leaving as a menu and arriving as the player. The two
// bodies never share a canvas (the menu's is a DOM layer over the comb; this
// one is in the arena, behind everything the comb was covering), so the tie
// is made in the timing and the motion: the exit is the strike's barrel roll
// off the top, the return is the run's own swim clip from the bottom, and the
// world's clock is what both are timed against.
//
// WHY THE RUN WAITS. Before this the run re-engaged on the frame of the click,
// at half speed, under a comb still draining — playable and not, for most of
// a second. Now the run stays held (gameState.paused) through the exit and the
// drain, the ramp back starts the frame the screen is clear, and the pause
// lets go when the ghost has merged. The ramp's length IS the ghost's length:
// progress is read off levelUpState.restore rather than off a copy of
// restoreTime, so retuning the ramp retunes the swim.
//
// THE HELD POSE is this file's too. The player's mixer and aim rig used to go
// on idling behind the cards; now they hold once the salute has released (see
// playerPoseHeld, read by main.js's pause branch), so "returning to its held
// pose" is literal — the ghost blends its swim into the very frame the real
// seal is stopped on, and the mixer resumes from that frame on the merge.
//
// TWO HALVES, as levelUpSeal.js: createLevelUpGhost is the animal and its
// motion — no scene, no renderer, handed a progress — and the module-level
// functions below are the trail record and the wiring. tools/
// level-up-ghost-test.mjs drives the first half on the real furseal.glb.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.levelUpGhost ?? {};
}

export function levelUpGhostEnabled() {
  return cfg().enabled !== false;
}

function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

// Shortest-arc blend between two headings.
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// The player's heading convention (entities/player.js): rotation.z, with the
// nose along (-sin, cos) — forward is local +Y.
function headingFromTangent(tx, ty) {
  return Math.atan2(ty, tx) - Math.PI / 2;
}

function bonesByName(root) {
  const map = new Map();
  root?.traverse?.((o) => { if (o.isBone) map.set(o.name, o); });
  return map;
}

// ---------------------------------------------------------------------------
// THE TRAIL — the last stretch the player swam, sampled every live frame.
//
// A ring of world positions and headings in gameplay time, kept only as long
// as `trailSeconds` asks for. Recorded by main.js from the run block (after
// updatePlayer, so it is where the seal ENDED the frame), which is also why a
// level-up lands with the trail's last sample exactly on the held position.
// ---------------------------------------------------------------------------

const TRAIL_CAP = 240;
const trail = [];
let trailClock = 0;

export function recordPlayerTrail(x, y, rot, dt) {
  trailClock += Math.max(0, dt);
  trail.push({ x, y, rot, t: trailClock });
  const keep = Math.max(0.05, cfg().trailSeconds ?? 0.6);
  while (trail.length > TRAIL_CAP || (trail.length > 1 && trailClock - trail[0].t > keep)) trail.shift();
}

/** The recorded trail, oldest first. A copy — the record keeps moving. */
export function playerTrail() {
  return trail.slice();
}

export function clearPlayerTrail() {
  trail.length = 0;
  trailClock = 0;
}

/**
 * The path the ghost swims, as control points oldest-first: the entry off the
 * bottom of the screen, the recorded trail thinned to a handful of points, and
 * the held position last. Exported for the harness.
 *
 * @param from  {x, y} where the seal is held
 * @param view  {x, y, halfW, halfH} what is on screen, world units
 * @param samples  the trail, oldest first
 */
export function ghostPathPoints(from, view, samples) {
  const c = cfg();
  const pts = [];
  const bottom = view.y - view.halfH;
  const startY = Math.min(bottom - (c.startBelow ?? 4), from.y - (c.startBelow ?? 4));
  // `entryX` is how much of the entry sits under the PLAYER rather than under
  // the middle of the screen (where the menu seal left from): 1 is straight
  // below the seal, 0 is the screen's centre line.
  const w = Math.max(0, Math.min(1, c.entryX ?? 0.8));
  pts.push({ x: from.x + (view.x - from.x) * (1 - w), y: startY });

  // The trail, thinned: at most `trailPoints` of it, never two closer than
  // `minGap` (a seal treading water records a hundred samples on one spot,
  // and a spline through coincident points is a knot), and never a sample
  // that would take the path back down past the entry.
  const maxPts = Math.max(0, Math.floor(c.trailPoints ?? 8));
  const gap = Math.max(0.01, c.minGap ?? 0.15);
  if (maxPts > 0 && samples.length > 1) {
    const stride = Math.max(1, Math.ceil((samples.length - 1) / maxPts));
    let last = pts[0];
    for (let i = 0; i < samples.length - 1; i += stride) {
      const s = samples[i];
      if (s.y < startY) continue;
      if (Math.hypot(s.x - last.x, s.y - last.y) < gap) continue;
      pts.push({ x: s.x, y: s.y });
      last = pts[pts.length - 1];
    }
  }
  const tail = pts[pts.length - 1];
  if (Math.hypot(from.x - tail.x, from.y - tail.y) < gap && pts.length > 1) pts.pop();
  pts.push({ x: from.x, y: from.y });
  return pts;
}

/**
 * The animal and its motion. No scene, no renderer.
 *
 * @param body  a createVisual('ship') — this takes ownership of it.
 */
export function createLevelUpGhost(body, { outline = true, dress = true } = {}) {
  const holder = new THREE.Object3D();
  holder.name = 'levelUpGhost';
  holder.add(body);
  holder.visible = false;

  const anim = createAnimationController(body);
  const bones = bonesByName(body);
  const worn = dress ? dressBody(body) : null;

  // THE LOOK: the seal's own materials, seen through — on COPIES. A model
  // clone shares the template's material by reference (assets.js
  // createVisual), so the player and the menu seal wear this very material;
  // an opacity written onto it faded all three animals, and left the run's
  // seal see-through after the merge. Same recipe as damageGlow.js: clone,
  // then carry onBeforeCompile and its cache key across by reference, because
  // Material.clone() drops them and the seal's mottle lives there. The
  // closure is NOT re-attached — it injects into the copy's fresh shader once
  // at compile, and its uniforms are the shared objects it closed over, so
  // the look controls still reach this body.
  const mats = [];
  const owned = new Map();
  const own = (m) => {
    if (!m) return m;
    let copy = owned.get(m);
    if (!copy) {
      copy = m.clone();
      if (m.onBeforeCompile) {
        copy.onBeforeCompile = m.onBeforeCompile;
        copy.customProgramCacheKey = m.customProgramCacheKey;
      }
      copy.userData.__levelUpGhost = true;
      copy.transparent = true;
      copy.depthWrite = false;
      copy.needsUpdate = true;
      owned.set(m, copy);
      mats.push(copy);
    }
    return copy;
  };
  body.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData?.__isOutline) return;
    o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
    // Over the arena, under nothing: the ghost is the last thing drawn where
    // it is, so it lays over the seal it is landing on rather than z-fighting.
    o.renderOrder = (o.renderOrder ?? 0) + 10;
  });
  const pc = CONFIG.playerOutline ?? {};
  const shells = outline
    ? [
      ...addOutlineShells(body, { color: pc.color ?? 0xffffff, glow: pc.glow ?? 1 }),
      ...addOutlineShells(body, { color: pc.inner?.color ?? 0x000000 }),
    ]
    : [];
  const shellMats = [];
  for (const shell of shells) {
    shell.renderOrder += 10;
    const m = shell.material;
    if (!shellMats.includes(m)) {
      m.transparent = true;
      m.depthWrite = false;
      m.needsUpdate = true;
      shellMats.push(m);
    }
  }
  const outerCount = outline ? shells.length / 2 : 0;
  function fitRim() {
    const c = cfg();
    const rim = Math.max(0, c.outline ?? (pc.thickness ?? 0.03));
    const ink = Math.max(0, c.ink ?? (pc.inner?.thickness ?? 0.012));
    shells.forEach((shell, i) => {
      setOutlineThicknessOn(shell.material, i < outerCount ? rim : ink);
    });
  }
  fitRim();

  const state = {
    phase: 'none', // none | swim
    progress: 0,   // 0..1, handed in — the restore ramp's
    alpha: 0,      // this frame's opacity
    blend: 0,      // this frame's pose blend into the source, 0..1
    speed: 0,      // world units per second along the path, this frame
    animState: 'idle',
    heading: 0,
    x: 0,
    y: 0,
  };

  let curve = null;
  let points = [];
  let from = null;    // {x, y, rot}
  let source = null;  // { mesh, body } — the seal being landed on
  let sourceBones = null;
  let lastU = 0;
  const _p = new THREE.Vector3();
  const _t = new THREE.Vector3();

  function setAlpha(a) {
    state.alpha = a;
    for (const m of mats) m.opacity = a;
    for (const m of shellMats) m.opacity = a;
  }

  const ghost = {
    holder, body, anim, bones, worn, shells, state, materials: mats,
    get phase() { return state.phase; },
    get active() { return state.phase !== 'none'; },
    get points() { return points; },
    get curve() { return curve; },

    /**
     * Start the swim.
     *
     * @param opts.from    {x, y, rot} the held seal — where it is and its heading
     * @param opts.view    {x, y, halfW, halfH} what is on screen
     * @param opts.trail   the recorded trail, oldest first
     * @param opts.source  { mesh, body } — the seal itself; its body's bones are
     *                     what the ghost's are blended into, and its body's
     *                     quaternion (the facing) is copied throughout.
     */
    begin({ from: f, view, trail: samples = [], source: src = null }) {
      if (!levelUpGhostEnabled()) return false;
      from = { x: f.x, y: f.y, rot: f.rot ?? 0 };
      source = src;
      sourceBones = src?.body ? bonesByName(src.body) : null;
      points = ghostPathPoints(from, view, samples);
      curve = new THREE.CatmullRomCurve3(
        points.map((p) => new THREE.Vector3(p.x, p.y, 0)), false, 'centripetal',
      );
      state.phase = 'swim';
      state.progress = 0;
      state.blend = 0;
      state.speed = 0;
      lastU = 0;
      state.x = points[0].x;
      state.y = points[0].y;
      state.heading = from.rot;
      holder.position.set(state.x, state.y, 0);
      holder.rotation.set(0, 0, state.heading);
      holder.visible = true;
      setAlpha(0);
      return true;
    },

    reset() {
      state.phase = 'none';
      state.progress = 0;
      state.blend = 0;
      holder.visible = false;
      setAlpha(0);
      curve = null;
      points = [];
      source = null;
      sourceBones = null;
    },

    /**
     * One frame. `progress` is the restore ramp's 0..1 (levelUpState.restore),
     * `rawDt` the wall clock for the swim clip. Returns the phase; 'none' once
     * it has merged.
     */
    update(rawDt, progress) {
      if (state.phase === 'none') return state.phase;
      const c = cfg();
      const dt = Math.min(0.05, Math.max(0, rawDt));
      const p = Math.max(0, Math.min(1, progress));
      state.progress = p;

      // WHERE. The path is walked by arc length on an eased clock, so the
      // swim decelerates into the trail and settles onto the pose rather than
      // stopping on a number.
      const u = ease(c.ease ?? 'outCubic', p);
      curve.getPointAt(u, _p);
      curve.getTangentAt(u, _t);
      const pathLen = curve.getLength();
      state.speed = dt > 0 ? Math.max(0, (u - lastU) * pathLen / dt) : 0;
      lastU = u;

      // The heading: the path's tangent, blending into the held heading over
      // the last stretch so the nose lands where the real seal's is.
      const hb = smoothstep((p - (c.headingBlendAt ?? 0.6)) / Math.max(0.01, 1 - (c.headingBlendAt ?? 0.6)));
      const tangentRot = headingFromTangent(_t.x, _t.y);
      state.heading = lerpAngle(tangentRot, from.rot, hb);

      // The position: the path, then the exact held point.
      const pb = smoothstep((p - (c.poseBlendAt ?? 0.7)) / Math.max(0.01, 1 - (c.poseBlendAt ?? 0.7)));
      state.blend = pb;
      state.x = _p.x + (from.x - _p.x) * pb;
      state.y = _p.y + (from.y - _p.y) * pb;
      holder.position.set(state.x, state.y, 0);
      holder.rotation.set(0, 0, state.heading);

      // THE FACING is the real seal's throughout — its body quaternion carries
      // the left/right mirror and the crane, and a ghost facing the other way
      // would flip on the merge.
      if (source?.body) {
        body.quaternion.copy(source.body.quaternion);
        body.position.copy(source.body.position);
        body.scale.copy(source.body.scale);
      }

      // THE CLIP: the run's own choice for this speed, in world units per
      // second exactly as the run measures it.
      state.animState = stateForSpeed(state.speed);
      anim?.update(dt, state.animState, false);
      holder.updateMatrixWorld(true);

      // THE POSE: bone for bone into the held seal's, over the last stretch.
      // Same rig, same names — both bodies are createVisual('ship') — so a
      // missing name is a rig that changed underneath us, and is skipped
      // rather than guessed at.
      if (sourceBones && pb > 0) {
        for (const [name, g] of bones) {
          const s = sourceBones.get(name);
          if (!s) continue;
          g.quaternion.slerp(s.quaternion, pb);
          g.position.lerp(s.position, pb);
          g.scale.lerp(s.scale, pb);
        }
        holder.updateMatrixWorld(true);
      }

      // THE ENVELOPE: in over `fadeIn` of the swim, out over the last
      // `fadeOut` — it thins as it merges, so what is left on the last frame
      // is the real seal and nothing on top of it.
      const fi = Math.max(0.01, c.fadeIn ?? 0.15);
      const fo = Math.max(0.01, c.fadeOut ?? 0.25);
      const env = smoothstep(p / fi) * (1 - smoothstep((p - (1 - fo)) / fo));
      setAlpha(Math.max(0, Math.min(1, c.alpha ?? 0.45)) * env);

      if (p >= 1) {
        ghost.reset();
      }
      return state.phase;
    },
  };

  return ghost;
}

// ---------------------------------------------------------------------------
// THE WIRING — the scene, the hold, and the run's seal.
// ---------------------------------------------------------------------------

export const levelUpGhostState = {
  built: false,
  phase: 'none',
  // The player's pose is being held for the cards — see playerPoseHeld.
  hold: false,
};

let scene = null;
let live = null;

/** Once, at boot: which scene to swim in. Builds nothing. */
export function installLevelUpGhost({ scene: s } = {}) {
  scene = s ?? null;
}

/** For a look page's console, nothing else. */
export function levelUpGhostLive() {
  return live;
}

/**
 * Build the ghost. Called at the top of the level-up ramp, next to the menu
 * seal's prepare, so the clone and its shells land in the slow-motion beat
 * and not on the frame the run comes back. A no-op once built, and when the
 * feature is off.
 */
export function prepareLevelUpGhost() {
  if (live) return live;
  if (!levelUpGhostEnabled() || !scene) return null;
  const ghost = createLevelUpGhost(createVisual('ship'));
  scene.add(ghost.holder);
  live = ghost;
  levelUpGhostState.built = true;
  return live;
}

/**
 * The cards are up: hold the player's pose once the salute has let go. Off
 * again on the merge (or a reset).
 */
export function holdPlayerPose(on) {
  levelUpGhostState.hold = !!on;
}

/**
 * Whether main.js should leave the player's mixer and aim rig alone this
 * frame. True from the moment the salute has released until the ghost has
 * merged — the idle used to go on ticking behind the cards, and a pose the
 * ghost is swimming INTO has to stand still to be swum into. The salute keeps
 * the mixer live for as long as it is performing, so the flippers go up over
 * a body that is still breathing and the freeze lands when the reaction is
 * over rather than in the middle of it.
 */
export function playerPoseHeld() {
  return levelUpGhostState.hold && !celebrationState.active;
}

/**
 * The screen is clear: swim in. Builds first if it has to.
 *
 * @param player  the run's seal — mesh, body, and where it is held
 * @param view    world.framedView()
 * @returns true if a ghost is swimming. False means there is nothing to wait
 *          for — the feature is off, or there was no scene to build in.
 */
export function startLevelUpGhost(player, view) {
  if (!levelUpGhostEnabled()) return false;
  if (!live) prepareLevelUpGhost();
  if (!live || !player?.mesh || !view) return false;
  return live.begin({
    from: { x: player.mesh.position.x, y: player.mesh.position.y, rot: player.mesh.rotation.z },
    view,
    trail: trail,
    source: { mesh: player.mesh, body: player.body },
  });
}

/**
 * The run is live: whatever the ghost was doing, it is over. Called from the
 * ramp's `done` — the ramp resets its published progress BEFORE that
 * callback, so the ghost never sees a 1 of its own and would otherwise stand
 * at the entry, invisible, through the whole run and into the next deal.
 * The next level-up begins it fresh.
 */
export function killLevelUpGhost() {
  if (!live) return;
  live.reset();
  levelUpGhostState.phase = 'none';
}

/**
 * One frame, on the wall clock, handed the restore ramp's progress. `live` is
 * whether gameplay is running this frame — a ghost still swimming into a seal
 * that has started moving is killed on the spot rather than followed.
 */
export function updateLevelUpGhost(rawDt, progress, { live: running = false } = {}) {
  if (!live) return;
  if (live.active && (running || !levelUpGhostEnabled())) live.reset();
  if (live.active) live.update(rawDt, progress);
  levelUpGhostState.phase = live.phase;
}

export function resetLevelUpGhost() {
  levelUpGhostState.hold = false;
  clearPlayerTrail();
  if (!live) return;
  live.reset();
  levelUpGhostState.phase = 'none';
}
