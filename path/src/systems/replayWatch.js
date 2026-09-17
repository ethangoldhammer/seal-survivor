import * as THREE from 'three';

// ============================================================================
// REPLAY WATCH — a temporary diagnostic for the seabed, the plant bed and the
// gravestones flickering during a Blubberball goal replay.
//
// THIS IS NOT A FEATURE. It exists to name one bug and then be deleted.
//
// WHY IT EXISTS. The lower band of the frame is reported as flickering, black
// and back, only while a goal replay is filming — which is the only time the
// game is drawn through a PERSPECTIVE camera (systems/replayCams.js) instead of
// the run's orthographic one. Every candidate cause paints the same picture and
// each one is a different fix:
//
//   something is toggling an object off        -> a `visible` write somewhere
//   something is being culled                  -> a stale bounding sphere
//   a shader is recompiling mid-shot           -> material.version ticks
//   an occluder is appearing in front          -> pixels change, nothing else
//   two surfaces are fighting over depth       -> pixels churn, nothing else
//
// The first three are visible in the scene graph. The last two are only visible
// in the PIXELS, and the difference between them is whether the churn is
// scattered (depth fighting) or solid (an occluder). So this measures both, and
// prints which one it saw.
//
// ALREADY RULED OUT, so nobody re-runs them: the shipping camera pool over a
// staged goal in tools/looks/replay-lab.js, 313 frames, no change on any stone;
// and the deep shell floor (world.js `shellFloor`, which is the one thing in
// the scene that becomes visible only during a replay) toggled on and off under
// a floor-grazing camera with no difference to the picture at all.
//
// ---------------------------------------------------------------------------
// WHAT IT WATCHES
//
// THE SUSPECTS, by name, because a group is the unit a bug of the first three
// kinds acts on: the gravestones, the plant bed, the backdrop and whatever the
// scene has that is only drawn during a replay.
//
// THE FRAME, as a coarse grid of tiles. A mean over the whole picture hides a
// flicker in the bottom third — the average barely moves while a quarter of the
// screen is doing something violent, which is exactly the shape of this bug.
// Per tile it is the mean AND the churn against the previous frame, so the line
// that gets printed can say WHERE on the screen and HOW.
// ============================================================================

/** Frames kept for the dump. Ten seconds at 60 — longer than any replay. */
const HISTORY = 600;

/** The tile grid. Coarse on purpose: this is "which part of the screen", not
 *  an image diff. 8x5 is about the aspect and small enough that the readback
 *  below is one call rather than forty. */
const COLS = 8;
const ROWS = 5;

/** Mean luminance a tile may move in one frame before it counts. A replay
 *  pushes in continuously and the water moves, so this has to clear ordinary
 *  motion; a band going black clears it several times over. */
const TILE_JUMP = 14;

/** Per-pixel churn, as a percentage of the tile, above which the tile is
 *  "fizzing" rather than "changing". Depth fighting scatters — lots of pixels
 *  flipping hard with the tile's own mean barely moving — and that signature is
 *  the difference between a z-fight and something being drawn over the top. */
const CHURN_PCT = 8;

/** Read the frame at a fraction of its real size. The readback is the cost and
 *  it scales with area; a quarter in each axis is a sixteenth of the pixels and
 *  still far finer than the tile grid it feeds. */
const SCALE = 0.25;

const _size = new THREE.Vector2();

let history = [];
let events = [];
let lastTiles = null;
let lastPix = null;
let lastSuspects = null;
let armed = false;
let readW = 0;
let readH = 0;

/** The groups worth naming. Looked up by name each time a replay starts rather
 *  than held, because a restart rebuilds several of them and a held reference
 *  would quietly be watching an object that is no longer in the scene — which
 *  reports "nothing changed" forever. */
const SUSPECTS = ['gravesites', 'seabedBed', 'backdrop'];

function visibleUp(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function snapshotObject(object) {
  let matV = 0;
  let meshes = 0;
  let kids = 0;
  object.traverse((o) => {
    kids += 1;
    const m = o.material;
    if (!m) return;
    meshes += 1;
    for (const mat of Array.isArray(m) ? m : [m]) matV += mat.version ?? 0;
  });
  return { vis: visibleUp(object), inScene: !!object.parent, kids, meshes, matV };
}

/**
 * Everything in the scene that is INVISIBLE most of the time and visible now.
 *
 * The deep shell is the known one (world.js flips it for replay cameras), but
 * the point of finding these by sweep rather than by name is that a second one
 * nobody remembered is exactly the shape of this bug — something that only ever
 * draws during a replay, which is the only condition the bug has.
 */
function replayOnlyMeshes(scene) {
  const out = [];
  scene.traverse((o) => {
    if (o.isMesh && o.userData.__replayOnly) out.push(o.name || o.uuid.slice(0, 6));
  });
  return out;
}

/**
 * The frame, as tiles.
 *
 * ON THE LINE AFTER THE DRAW. The renderer runs without
 * `preserveDrawingBuffer` (see world.js), so the colour buffer is the browser's
 * again the moment this task yields: a read from a timer or a promise comes
 * back blank and would report the whole screen as black on every frame — a
 * diagnostic that agrees with whatever you already suspected. Same constraint
 * the boss kill shot works under in main.js.
 */
function readTiles(renderer) {
  const gl = renderer.getContext();
  const target = renderer.getRenderTarget();
  if (target) renderer.setRenderTarget(null);
  try {
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(COLS * 4, Math.floor(_size.x * SCALE));
    const h = Math.max(ROWS * 4, Math.floor(_size.y * SCALE));
    // One readback of the whole (downscaled) frame rather than one per tile:
    // the pipeline stall is per CALL, so forty small reads cost forty stalls.
    // The full buffer is read and binned here instead.
    const buf = new Uint8Array(_size.x * _size.y * 4);
    gl.readPixels(0, 0, _size.x, _size.y, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    readW = _size.x; readH = _size.y;
    const lum = new Float32Array(_size.x * _size.y);
    for (let i = 0; i < lum.length; i += 1) {
      lum[i] = buf[i * 4] * 0.2126 + buf[i * 4 + 1] * 0.7152 + buf[i * 4 + 2] * 0.0722;
    }
    const tiles = new Float32Array(COLS * ROWS);
    const counts = new Uint32Array(COLS * ROWS);
    for (let y = 0; y < _size.y; y += 1) {
      // readPixels is bottom-up and the grid is quoted top-down, so row 0 of
      // the grid is the TOP of the screen — which is what somebody reading the
      // console will assume it means.
      const r = Math.min(ROWS - 1, Math.floor(((_size.y - 1 - y) / _size.y) * ROWS));
      for (let x = 0; x < _size.x; x += 1) {
        const c = Math.min(COLS - 1, Math.floor((x / _size.x) * COLS));
        const t = r * COLS + c;
        tiles[t] += lum[y * _size.x + x];
        counts[t] += 1;
      }
    }
    for (let t = 0; t < tiles.length; t += 1) tiles[t] = counts[t] ? tiles[t] / counts[t] : 0;
    return { tiles, lum, w, h };
  } catch {
    // A lost context, or a buffer the driver will not hand back. A diagnostic
    // is never the thing that takes a run down.
    return null;
  } finally {
    if (target) renderer.setRenderTarget(target);
  }
}

/** What fraction of a tile's pixels moved hard between two frames. This is the
 *  z-fight detector: fighting flips many pixels while leaving the tile's mean
 *  almost where it was, and nothing else in the game does that. */
function tileChurn(a, b, tile) {
  const r = Math.floor(tile / COLS);
  const c = tile % COLS;
  const y0 = Math.floor(((ROWS - 1 - r) / ROWS) * readH);
  const y1 = Math.floor(((ROWS - r) / ROWS) * readH);
  const x0 = Math.floor((c / COLS) * readW);
  const x1 = Math.floor(((c + 1) / COLS) * readW);
  let moved = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = y * readW + x;
      if (Math.abs(a[i] - b[i]) > 18) moved += 1;
      n += 1;
    }
  }
  return n ? (100 * moved) / n : 0;
}

/** Where a tile is, in words, because "tile 27" is not something anybody can
 *  act on and "bottom band, left of centre" is. */
function tileName(t) {
  const r = Math.floor(t / COLS);
  const c = t % COLS;
  const band = ['top', 'upper', 'middle', 'lower', 'bottom'][r] ?? `row ${r}`;
  const side = c < COLS / 3 ? 'left' : c >= (2 * COLS) / 3 ? 'right' : 'centre';
  return `${band} ${side}`;
}

/**
 * One frame. Call AFTER the composite.
 *
 * @param {object} o
 *   renderer, scene   world.renderer, world.scene
 *   camera            the camera the frame was DRAWN with — the replay's
 *                     perspective shot, not world.camera
 *   shot              the live shot's name
 *   active            false outside a replay: resets and costs nothing
 */
export function watchReplay({ renderer, scene, camera, shot = '', active = false }) {
  if (!active || !renderer || !scene || !camera) {
    if (armed) { armed = false; lastTiles = null; lastPix = null; lastSuspects = null; }
    return;
  }
  if (!armed) {
    armed = true;
    lastTiles = null; lastPix = null; lastSuspects = null;
    const only = replayOnlyMeshes(scene);
    console.log('[replayWatch] replay started — %s%s',
      SUSPECTS.filter((n) => scene.getObjectByName(n)).join(', ') || 'no named suspects in scene',
      only.length ? ` | replay-only meshes: ${only.join(', ')}` : '');
  }

  const suspects = {};
  for (const name of SUSPECTS) {
    const o = scene.getObjectByName(name);
    suspects[name] = o ? snapshotObject(o) : null;
  }

  const read = readTiles(renderer);
  const frame = {
    t: +performance.now().toFixed(0),
    shot,
    cam: `${camera.isPerspectiveCamera ? 'persp' : 'ortho'} ${camera.position.x.toFixed(1)},${camera.position.y.toFixed(1)},${camera.position.z.toFixed(1)}`
      + ` ${camera.isPerspectiveCamera ? `fov ${camera.fov.toFixed(1)}` : `zoom ${(camera.zoom ?? 1).toFixed(2)}`}`,
    suspects,
    tiles: read ? Array.from(read.tiles, (v) => +v.toFixed(1)) : null,
  };
  history.push(frame);
  if (history.length > HISTORY) history.shift();

  if (lastSuspects) {
    for (const name of SUSPECTS) {
      const a = lastSuspects[name];
      const b = suspects[name];
      if (!a || !b) continue;
      const why = [];
      if (a.vis !== b.vis) why.push(`visible ${a.vis} -> ${b.vis}`);
      if (a.inScene !== b.inScene) why.push(`in scene ${a.inScene} -> ${b.inScene}`);
      if (a.kids !== b.kids) why.push(`objects ${a.kids} -> ${b.kids}`);
      if (a.matV !== b.matV) why.push(`material recompiled (${a.matV} -> ${b.matV})`);
      if (!why.length) continue;
      const line = { at: frame.t, what: name, why, shot: frame.shot, cam: frame.cam };
      events.push(line);
      console.warn('[replayWatch] %s — %s  [shot %s, cam %s]', name, why.join('; '), frame.shot, frame.cam);
    }
  }

  if (read && lastTiles && lastPix) {
    // A CUT IS NOT A FLICKER, and without this the console is nothing else.
    // The pool cuts between shots several times in a replay and a cut changes
    // the entire picture at once — which is every tile firing on one frame,
    // correctly, and drowning the two or three tiles that are the bug. So a
    // frame where most of the screen moved is reported as the cut it is and
    // its tiles are not filed individually.
    let moved = 0;
    for (let t = 0; t < read.tiles.length; t += 1) {
      if (Math.abs(read.tiles[t] - lastTiles[t]) > TILE_JUMP) moved += 1;
    }
    if (moved > read.tiles.length / 2) {
      console.log('[replayWatch] cut to %s — whole frame changed, not filed', frame.shot);
      lastSuspects = suspects;
      lastTiles = read.tiles; lastPix = read.lum;
      return;
    }
    for (let t = 0; t < read.tiles.length; t += 1) {
      const d = read.tiles[t] - lastTiles[t];
      const churn = tileChurn(lastPix, read.lum, t);
      const jumped = Math.abs(d) > TILE_JUMP;
      const fizzing = churn > CHURN_PCT && Math.abs(d) < TILE_JUMP;
      if (!jumped && !fizzing) continue;
      // The two signatures are different bugs and the words say which:
      // something drawn over the top moves the mean, depth fighting does not.
      const kind = jumped
        ? `went ${d < 0 ? 'DARK' : 'BRIGHT'} by ${Math.abs(d).toFixed(0)} (something is being drawn over it)`
        : `fizzing — ${churn.toFixed(0)}% of pixels flipped with the mean holding (two surfaces fighting over depth)`;
      const line = { at: frame.t, what: tileName(t), why: [kind], shot: frame.shot, cam: frame.cam };
      events.push(line);
      console.warn('[replayWatch] %s — %s  [shot %s, cam %s]', tileName(t), kind, frame.shot, frame.cam);
    }
  }

  lastSuspects = suspects;
  if (read) { lastTiles = read.tiles; lastPix = read.lum; }
}

/** The dump. `window.__replayWatch()` in the console. */
export function dumpReplayWatch() {
  console.log('[replayWatch] %d event(s), %d frame(s) held', events.length, history.length);
  if (events.length) {
    console.table(events.map((e) => ({ at: e.at, what: e.what, why: e.why.join('; '), shot: e.shot, cam: e.cam })));
  } else {
    console.log('[replayWatch] nothing moved — neither the scene graph nor the pixels changed enough to call it');
  }
  return { events, frames: history };
}

export function resetReplayWatch() {
  history = []; events = []; lastTiles = null; lastPix = null; lastSuspects = null; armed = false;
  console.log('[replayWatch] cleared');
}

if (typeof window !== 'undefined') {
  window.__replayWatch = dumpReplayWatch;
  window.__replayWatchReset = resetReplayWatch;
}
