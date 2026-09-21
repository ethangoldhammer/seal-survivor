import * as THREE from 'three';
import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// WHERE THIS DASH WOULD GO — one line per seal, out of its head, along the
// flight a release right now would actually fly.
//
// IT REPLACES THE LENS CORRIDOR, which answered the same question by DARKENING
// everything that was not the answer (cineCamera.js's `corridor`, post.js's
// pathMask). That reads well in a single-player run, where the one seal being
// framed is the only thing on screen worth looking at. In a match it is the
// wrong instrument twice over: the frame holds two captains, a ball and up to
// six other seals, and dimming all of it to point at one of them takes the
// match away to show you your own wind-up. And it could only ever say ONE
// thing, because a lens has one frame — so a four-a-side match had three
// players winding up into a shot that had no way to draw any of them.
//
// A LINE IS PER-SEAL AND ADDS RATHER THAN SUBTRACTS. Eight of them can be on
// screen at once without the picture going anywhere.
//
// THE FORECAST'S OWN SAMPLES, not a start and an end. predictDash flies the
// dash exactly as updatePlayer will run it — impulse, thrust, steer, ceiling,
// drag — and now records every step (strike.js, `out.path`) rather than only
// where it finished.
//
// THAT PATH IS STRAIGHT TODAY. dashSteer is handed the launch line as its
// target and the flight starts on it, so there is nothing to turn toward; what
// the samples carry is the SPACING, which is not even — the seal decelerates
// the whole way. Drawing from them puts the taper and the fade where the seal
// will actually be at that moment instead of at an even fraction of the
// distance, and means this follows for free if the forecast ever gains a real
// curve. Do not "simplify" this back to two points: that is the same picture
// only while the dash has no steering in it.
//
// A RIBBON AND NOT THREE.Line. `linewidth` is ignored by every WebGL renderer
// on every platform that matters, so a Line is one physical pixel — invisible
// on a phone and thinner as the camera pulls out. Two vertices per sample, a
// fixed WORLD half-width, so the line is the same thickness on the water at
// every zoom the match camera reaches.
// ---------------------------------------------------------------------------

// The forecast steps at 1/60 for the dash's duration, which is
// `strikeDashDuration` x `reachMulMax` — 0.22 x 2.2 at the shipped tuning, so
// about thirty. This is the ceiling for a stat-boosted duration, and the
// geometry is allocated once at it rather than grown: a resize mid-match means
// a new buffer the renderer has to upload on the frame somebody is striking.
const MAX_POINTS = 96;

// Seats, and therefore lines. MAX_PER_SIDE x 2 — read from the roster's own
// limit rather than typed, so a match that grows a side grows its lines.
const MAX_LINES = 8;

const lines = [];
let root = null;

function cfg() {
  return CONFIG.strike?.predict ?? {};
}

/**
 * One line's geometry and the mesh around it.
 *
 * DYNAMIC DRAW AND A DRAW RANGE, never a rebuild. Every frame rewrites the
 * positions in place and moves the range; allocating a geometry per frame for
 * eight seals is the kind of garbage that shows up as a stutter a few seconds
 * later rather than as a frame cost you can see.
 */
function makeLine() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2 * 3), 3));
  // Down the line, 0 at the head and 1 at the far end, so the shader-free
  // material can still fade the tip out through vertex colours.
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2 * 3), 3));
  const index = [];
  for (let i = 0; i < MAX_POINTS - 1; i += 1) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  geo.setIndex(index);
  geo.setDrawRange(0, 0);
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // ADDITIVE AND DEPTH-TEST OFF, the same call aimIndicator.js makes: a
    // trajectory a passing shark can hide is not doing its job, and the line
    // is drawn over water that is already dark.
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.visible = false;
  return { mesh, geo, mat };
}

/** Hand every line a scene. Safe to call again — a second call is a no-op. */
export function initStrikePaths(scene) {
  if (root === scene) return;
  root = scene;
  for (const l of lines) l.mesh.parent?.remove(l.mesh);
  lines.length = 0;
  for (let i = 0; i < MAX_LINES; i += 1) {
    const l = makeLine();
    scene.add(l.mesh);
    lines.push(l);
  }
}

/** Every line dark. A match ending, a kickoff, a run reset. */
export function resetStrikePaths() {
  for (const l of lines) { l.mesh.visible = false; l.geo.setDrawRange(0, 0); }
}

/** Nothing to draw for this seat this frame. */
export function hideStrikePath(seat) {
  const l = lines[seat];
  if (l) { l.mesh.visible = false; l.geo.setDrawRange(0, 0); }
}

const _c = new THREE.Color();

/**
 * DRAW SEAT `seat`'s FORECAST.
 *
 * @param seat   which line to use — one per seal, so two winding up at once
 *               are two lines rather than one that flickers between them.
 * @param ox,oy  the head, in world units. See the note in the caller on why
 *               this is the snout anchor and not the body's centre.
 * @param path   flat x,y pairs RELATIVE to the seal, oldest first, as
 *               predictDash records them.
 * @param power  0..1, the banked charge. Drives the alpha, so a line that has
 *               only just started winding up is faint and a full one is not —
 *               which is the charge meter said a second way, in the place the
 *               player is already looking.
 * @param color  0xRRGGBB. The team's, in a match.
 */
export function drawStrikePath(seat, ox, oy, path, power, color) {
  const l = lines[seat];
  const c = cfg();
  if (!l || c.enabled === false) return false;
  const n = Math.min(MAX_POINTS, (path?.length ?? 0) >> 1);
  // TWO POINTS IS THE MINIMUM FOR A DIRECTION. One is a degenerate ribbon,
  // which renders as nothing but still costs an upload.
  if (n < 2) { hideStrikePath(seat); return false; }

  const pos = l.geo.attributes.position.array;
  const col = l.geo.attributes.color.array;
  const half = (c.width ?? 0.35) * 0.5;
  const alpha = Math.max(0, Math.min(1, power)) * (c.alpha ?? 1);
  _c.set(color ?? c.color ?? 0x8fd8ff);

  for (let i = 0; i < n; i += 1) {
    const x = path[i * 2];
    const y = path[i * 2 + 1];
    // The direction AT this sample, from its neighbours — a forward
    // difference at the ends and a central one between, so the ribbon does not
    // pinch on the last segment.
    const px = path[Math.max(0, i - 1) * 2];
    const py = path[Math.max(0, i - 1) * 2 + 1];
    const nx = path[Math.min(n - 1, i + 1) * 2];
    const ny = path[Math.min(n - 1, i + 1) * 2 + 1];
    let dx = nx - px;
    let dy = ny - py;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
    // The normal in the plane. The line lies on the water's plane like
    // everything else in this game, so this is a rotation and not a cross
    // product against a camera that may be anywhere.
    const ux = -dy * half;
    const uy = dx * half;

    const t = i / (n - 1);
    // TAPERED AND FADED TOWARD THE TIP. The far end of a forecast is the least
    // certain part of it — it is the most integration steps away from anything
    // the player has actually done — so it should not be drawn as confidently
    // as the near end. A line of even weight claims the landing point is as
    // sure as the launch.
    const taper = 1 - t * (c.taper ?? 0.7);
    const fade = alpha * (1 - t * (c.fade ?? 0.65));
    const a = i * 6;
    pos[a] = ox + x + ux * taper;
    pos[a + 1] = oy + y + uy * taper;
    pos[a + 2] = 0;
    pos[a + 3] = ox + x - ux * taper;
    pos[a + 4] = oy + y - uy * taper;
    pos[a + 5] = 0;
    // The fade rides the vertex colour rather than the material's opacity,
    // because opacity is one number for the whole mesh and this has to vary
    // down the line. Additive blending makes a dark vertex a transparent one.
    col[a] = _c.r * fade; col[a + 1] = _c.g * fade; col[a + 2] = _c.b * fade;
    col[a + 3] = _c.r * fade; col[a + 4] = _c.g * fade; col[a + 5] = _c.b * fade;
  }

  l.geo.attributes.position.needsUpdate = true;
  l.geo.attributes.color.needsUpdate = true;
  l.geo.setDrawRange(0, (n - 1) * 6);
  l.mesh.visible = alpha > 0.001;
  return l.mesh.visible;
}

/** How many lines are lit right now. For the harness. */
export function litStrikePaths() {
  let n = 0;
  for (const l of lines) if (l.mesh.visible) n += 1;
  return n;
}

/** The geometry a seat is drawing, for the harness to measure. */
export function strikePathPoints(seat) {
  const l = lines[seat];
  if (!l || !l.mesh.visible) return [];
  const pos = l.geo.attributes.position.array;
  const n = l.geo.drawRange.count / 6 + 1;
  const out = [];
  // The CENTRE line, which is what the forecast actually said — the two
  // vertices either side of it are the ribbon's width.
  for (let i = 0; i < n; i += 1) {
    out.push((pos[i * 6] + pos[i * 6 + 3]) / 2, (pos[i * 6 + 1] + pos[i * 6 + 4]) / 2);
  }
  return out;
}
