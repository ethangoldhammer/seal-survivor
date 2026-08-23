import * as THREE from 'three';
import { CONFIG } from '../config.js';

// THE NET ITSELF — the twine, not the light.
//
// The tractor beam (systems/bakalar.js) is the SUCTION drawn: a cone of light
// with bands travelling up it, and every falloff in it is a curve the haul
// also obeys. It says what the boat is DOING. What it never said is that there
// is a physical thing in the water, because a cone of light has no weight and
// nothing you drop into it moves it.
//
// This is that thing. A lattice of nodes hanging off the hull, simulated with
// Verlet on the CPU, drawn as additive lines in the same idiom as the backdrop
// grid (systems/grid.js): a cool base colour that heats toward `hotColor`
// wherever the mesh is displaced from where it wants to be. That shared idiom
// is the point — the arena is already a reactive lattice, and the net reads as
// a piece of the same material pulled out of the backdrop and hung off a boat.
//
// Two differences from the backdrop grid, both deliberate:
//
//   TIGHTER. The backdrop is 2.6 world units between nodes and exists to be
//   ignored. This is roughly a fifth of that, because a net has to read as a
//   net at the scale of the fish it is holding — at backdrop spacing a mackerel
//   fits through one cell and the whole thing looks like a window frame.
//
//   DIAMOND, not square. The drawn twine is the two DIAGONAL families of the
//   node lattice, so the mesh is diamond-celled the way real trawl netting is,
//   with the perimeter drawn as its ropes: headline along the top, footrope
//   along the bottom, side ropes down the edges. A square weave here read as
//   graph paper, which is the backdrop's job and not this one.
//
// And unlike the backdrop grid, this one is NOT a vertex shader. The backdrop
// is thousands of nodes displaced by a closed-form sum of ripples, which is
// exactly what a GPU is for and exactly what a CPU is not. This is ~150 nodes
// that have to be shoved around by things whose positions the GPU does not
// know — the catch inside the net, and a bomb going off in it — and which have
// to STAY shoved and spring back on their own. That is a simulation, not a
// function of time, so it lives here and uploads its positions each frame.
//
// (No backtick anywhere below, comments included: it would end the template
// literal and report the error at a line of prose. See the same note in
// systems/bakalar.js.)

// ---------------------------------------------------------------------------
// THE LOOK
//
// Same contract as the backdrop lattice: additive lines, a base colour, and a
// hot colour that the WARP (how far a node has been dragged from rest) mixes
// toward. Warp is computed on the CPU alongside the sim and handed over as a
// per-vertex attribute, because the shader has no idea where rest was.
//
// Additive and depthWrite:false for the same reason the beam is: the net is
// full of fish by design and must never occlude its own catch.
const NET_VERT = `
  attribute float aWarp;
  varying float vWarp;
  void main() {
    vWarp = aWarp;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NET_FRAG = `
  uniform vec3  uColor;
  uniform vec3  uHotColor;
  uniform float uOpacity;
  uniform float uWarpGain;
  varying float vWarp;

  void main() {
    float heat = clamp(vWarp * uWarpGain, 0.0, 1.0);
    vec3 color = mix(uColor, uHotColor, heat);
    // The same 0.3 floor the backdrop grid uses: a line at rest is faint but
    // present, and the warp is what lights it. Without the floor the net
    // disappears entirely whenever it happens to be hanging still.
    float alpha = uOpacity * (0.3 + heat * 0.7);
    gl_FragColor = vec4(color * (1.0 + heat), alpha);
  }
`;

let mesh = null;
let material = null;

// Node state, all flat Float32Arrays indexed n*2 (x) / n*2+1 (y). Verlet, so
// velocity is implicit in (cur - prev) and an impulse is applied by moving
// `prev` rather than by carrying a separate velocity array.
let cols = 0;
let rows = 0;
let cur = null;
let prev = null;
let rest = null;
let warp = null;
let pinned = null; // Uint8Array — the headline, which the hull owns outright

// Springs, as flat index triples into the node arrays: [a, b, restScale].
// restScale is the spring's length as a multiple of the lattice's ACROSS
// spacing, so a net that grows with level rebuilds nothing — every rest length
// is recomputed from the current spacing each frame.
let springs = null;
let springStiff = null;

// Impulses waiting to be applied on the next step. A bomb going off between
// two frames must not be dropped, and applying it immediately from inside
// whatever system noticed would push nodes that this frame has not integrated.
const kicks = [];

// Where the headline was last frame, so the net can work out how fast it is
// being towed. Derived rather than passed in: the boat's speed is a config
// number and the net's own centre trails it, so a hull that ever accelerates,
// reverses or is nudged by anything else would tow a net that had been told a
// constant. NaN until the first step after a seat.
let lastCenterX = NaN;

const REST_EPS = 1e-5;

function idx(i, j) { return j * cols + i; }

/**
 * Build (or rebuild) the lattice. Called when the node counts change, which is
 * a tuner move — the net's WIDTH and DEPTH change every level and every frame
 * of a sailing, and neither of those rebuilds anything: they only change where
 * `rest` is, which is recomputed per frame.
 */
// ROWS FOLLOW DEPTH, and the cell count across does not.
//
// Both were fixed numbers, and that was fine while the net grew in both
// directions. It does not any more — levelling buys DEPTH only (see
// netGeometry in systems/bakalar.js) — so a lattice with a fixed row count
// stretches its cells taller and taller as the stack goes up: at eight stacks
// the net is 8 units wide and 35 deep, and fifteen rows makes every diamond
// three and a half times taller than it is broad.
//
// That is not just ugly. The weave SHEARS: the diagonal springs are the mesh,
// and at that aspect they run almost vertically, so there is nothing left
// resisting a sideways fold. The net pinched to a point at its waist — a
// hourglass with the twine crossing through itself, which reads as a physics
// blow-up rather than as a stretched grid.
//
// So the row count is derived from the depth to keep the cells roughly square,
// and `maxRows` caps what that can cost. Recomputed only when the geometry
// changes, which is a level-up or a tuner move, not a frame.
let wantedRows = 12;
function rowsFor(halfWidth, depth) {
  const c = CONFIG.bakalar.net;
  const across = (halfWidth * 2) / Math.max(1, Math.round(c.cols) - 1);
  const cell = Math.max(0.05, across * (c.cellAspect ?? 1));
  return Math.max(4, Math.min(Math.round(c.maxRows), Math.round(depth / cell) + 1));
}

function build(scene) {
  disposeBakalarNet(scene);

  const c = CONFIG.bakalar.net;
  cols = Math.max(3, Math.round(c.cols));
  rows = Math.max(4, Math.min(Math.round(c.maxRows), wantedRows));
  const n = cols * rows;

  cur = new Float32Array(n * 2);
  prev = new Float32Array(n * 2);
  rest = new Float32Array(n * 2);
  warp = new Float32Array(n);
  pinned = new Uint8Array(n);
  for (let i = 0; i < cols; i++) pinned[idx(i, 0)] = 1;

  // --- the twine ----------------------------------------------------------
  // Drawn segments are the two diagonal families, which is what makes the
  // cells diamonds. Every drawn segment is also a spring: the picture and the
  // simulation are the same mesh, so twine cannot stretch in a way the eye
  // does not see.
  const lines = [];
  const sp = [];
  const st = [];
  const spring = (a, b, scale, stiff) => { sp.push(a, b, scale); st.push(stiff); };

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = idx(i, j), b = idx(i + 1, j + 1);
      const p = idx(i + 1, j), q = idx(i, j + 1);
      lines.push(a, b, p, q);
      // The diagonal's rest length is measured in ACROSS spacings, and the
      // lattice is not square — depth spacing and width spacing are unrelated
      // numbers that both move with level. So the scale carries only the
      // horizontal half and the vertical half is added at solve time; see
      // solve(). Stored as 1 here and read as "one cell diagonal".
      spring(a, b, 1, c.twineStiffness);
      spring(p, q, 1, c.twineStiffness);
    }
  }

  // --- the ropes ----------------------------------------------------------
  // A real net's perimeter is heavier line than its mesh, and it is what keeps
  // the whole thing a rectangle instead of a bag. Stiffer springs AND drawn,
  // so the silhouette stays readable while the middle bellies out.
  //
  // The top row is pinned anyway, so its rope is decoration; the other three
  // are load-bearing in both senses.
  for (let i = 0; i < cols - 1; i++) {
    const top = [idx(i, 0), idx(i + 1, 0)];
    const bot = [idx(i, rows - 1), idx(i + 1, rows - 1)];
    lines.push(top[0], top[1], bot[0], bot[1]);
    spring(top[0], top[1], 0, c.ropeStiffness);   // 0 = horizontal-only
    spring(bot[0], bot[1], 0, c.ropeStiffness);
  }
  for (let j = 0; j < rows - 1; j++) {
    const left = [idx(0, j), idx(0, j + 1)];
    const right = [idx(cols - 1, j), idx(cols - 1, j + 1)];
    lines.push(left[0], left[1], right[0], right[1]);
    spring(left[0], left[1], -1, c.ropeStiffness);  // -1 = vertical-only
    spring(right[0], right[1], -1, c.ropeStiffness);
  }

  // --- the bind -----------------------------------------------------------
  // NOT DRAWN, and the net falls apart without it. A lattice sprung only on
  // its diagonals splits into two checkerboard sub-lattices that share no
  // constraint at all: they interpenetrate, drift through each other, and the
  // "net" becomes two independent meshes flickering past one another. These
  // weak axis springs are the only thing coupling them.
  //
  // Weak on purpose — stiff enough to couple, soft enough that the diamonds
  // can still open and close, which is the motion that reads as netting.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (i < cols - 1) spring(idx(i, j), idx(i + 1, j), 0, c.bindStiffness);
      if (j < rows - 1) spring(idx(i, j), idx(i, j + 1), -1, c.bindStiffness);
    }
  }

  springs = new Float32Array(sp);
  springStiff = new Float32Array(st);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geometry.setAttribute('aWarp', new THREE.BufferAttribute(warp, 1));
  geometry.setIndex(lines);
  geometry.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
  geometry.getAttribute('aWarp').setUsage(THREE.DynamicDrawUsage);
  // The nodes move every frame and the mesh carries no transform, so there is
  // no bounding sphere worth maintaining.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  material = new THREE.ShaderMaterial({
    vertexShader: NET_VERT,
    fragmentShader: NET_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(c.color) },
      uHotColor: { value: new THREE.Color(c.hotColor) },
      uOpacity: { value: c.opacity },
      uWarpGain: { value: c.warpGain },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  mesh = new THREE.LineSegments(geometry, material);
  // IN FRONT OF THE CATCH, not behind it. The beam sits at -0.15 because it is
  // light being added to the water the fish are in; the twine is a physical
  // thing between the camera and them, and a net drawn behind its own catch
  // reads as a backdrop the fish are swimming past. Additive hairlines over a
  // creature are exactly what netting looks like.
  //
  // Far enough forward to clear the play plane's depth lanes — enemies are
  // placed at +/- depthSpread x radius around z 0 (see spawnEnemy) — and there
  // is nothing else out here to sort against.
  mesh.position.z = 1.8;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
}

export function createBakalarNet(scene) {
  build(scene);
  return mesh;
}

export function disposeBakalarNet(scene) {
  if (!mesh) return;
  scene?.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  mesh = null;
  material = null;
}

export function setBakalarNetVisible(v) {
  if (mesh) mesh.visible = !!v;
  if (!v) kicks.length = 0;
}

/**
 * Snap every node onto its rest position with zero velocity. Called when the
 * boat launches: the net arrives from offscreen already hanging, rather than
 * unfolding out of wherever the last sailing left it.
 */
function reseat(centerX, top, halfWidth, depth) {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const n = idx(i, j);
      const x = centerX + (i / (cols - 1) - 0.5) * halfWidth * 2;
      const y = top - (j / (rows - 1)) * depth;
      cur[n * 2] = prev[n * 2] = rest[n * 2] = x;
      cur[n * 2 + 1] = prev[n * 2 + 1] = rest[n * 2 + 1] = y;
      warp[n] = 0;
    }
  }
}

export function seatBakalarNet(centerX, top, halfWidth, depth) {
  if (!cur) return;
  // The weave first: a boat launching at a new stack has a deeper net than the
  // last one, and seating the OLD row count onto it would hang a stretched
  // lattice for the one frame before update() notices and rebuilds.
  const want = rowsFor(halfWidth, depth);
  if (want !== rows) { wantedRows = want; build(mesh?.parent); if (mesh) mesh.visible = true; }
  reseat(centerX, top, halfWidth, depth);
  kicks.length = 0;
  // Cleared, not set: a seat is a teleport, and the difference between where
  // the net was and where it now is would read as a tow at several hundred
  // units a second and blow the mesh across the arena on the first frame.
  lastCenterX = NaN;
}

/**
 * PUNCH THE NET. An outward impulse from (x, y) — the bomb going off inside
 * it, and the jolt of something big being caught.
 *
 * Queued rather than applied, so a caller anywhere in the frame order gets the
 * same result. Impulses move `prev` against the motion, which in Verlet is
 * exactly a velocity change and is the only way to add energy without also
 * teleporting the mesh.
 */
export function kickBakalarNet(x, y, strength, radius) {
  if (!cur || strength <= 0 || radius <= 0) return;
  kicks.push(x, y, strength, radius);
}

function applyKicks() {
  for (let k = 0; k < kicks.length; k += 4) {
    const kx = kicks[k], ky = kicks[k + 1], ks = kicks[k + 2], kr = kicks[k + 3];
    const r2 = kr * kr;
    for (let n = 0; n < cols * rows; n++) {
      if (pinned[n]) continue;
      const dx = cur[n * 2] - kx;
      const dy = cur[n * 2 + 1] - ky;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || REST_EPS;
      // Squared falloff: a hot core rather than a flat disc, same shape the
      // finger glow uses on the backdrop grid.
      const f = (1 - d / kr) ** 2 * ks;
      prev[n * 2] -= (dx / d) * f;
      prev[n * 2 + 1] -= (dy / d) * f;
    }
  }
  kicks.length = 0;
}

// One relaxation pass over every spring. `hx` and `hy` are the lattice's
// across- and down- spacings; a spring's rest length is built from them by its
// scale code (see build): 0 = one across, -1 = one down, 1 = the cell diagonal.
function solve(hx, hy, iterations) {
  const diag = Math.hypot(hx, hy);
  const slack = CONFIG.bakalar.net.slack;
  for (let pass = 0; pass < iterations; pass++) {
    for (let s = 0, k = 0; s < springs.length; s += 3, k++) {
      const a = springs[s], b = springs[s + 1], code = springs[s + 2];
      const target = (code === 1 ? diag : code === 0 ? hx : hy) * slack;
      const ax = a * 2, ay = ax + 1, bx = b * 2, by = bx + 1;
      const dx = cur[bx] - cur[ax];
      const dy = cur[by] - cur[ay];
      const d = Math.hypot(dx, dy) || REST_EPS;
      // ASYMMETRIC, and the asymmetry is the whole character of the material.
      // Pulled taut a strand is a string and holds hard; pushed together it
      // barely resists, because twine has no spine.
      //
      // Barely, not NOT AT ALL — and the gap between those two is the single
      // easiest way to ruin this. A symmetric spring lattice inflates itself
      // to full extension and stays there, at which point every strand is
      // already at its slack limit and no local load can stretch one further:
      // the net becomes a rigid shell that a shark dents by a tenth of a unit.
      // See CONFIG.bakalar.net.compression for the measurements.
      const corr = ((d - target) / d) * springStiff[k] * 0.5
        * (d > target ? 1 : CONFIG.bakalar.net.compression);
      const cx = dx * corr, cy = dy * corr;
      const pa = pinned[a], pb = pinned[b];
      // A spring with one pinned end applies its whole correction to the free
      // one — halving it there would let the headline stretch by the half it
      // never gave back.
      if (!pa) { cur[ax] += pb ? cx * 2 : cx; cur[ay] += pb ? cy * 2 : cy; }
      if (!pb) { cur[bx] -= pa ? cx * 2 : cx; cur[by] -= pa ? cy * 2 : cy; }
    }
  }
}

/**
 * Step the net for one frame.
 *
 * @param dt        seconds
 * @param frame     { centerX, top, halfWidth, depth } — where the net hangs
 *                  this frame, in world units, from the boat.
 * @param loads     [{ x, y, mass }] — everything inside the net that has
 *                  weight. bakalar.js hands over its catch; `mass` is a radius
 *                  in world units, so a shark bellies the mesh out and a
 *                  sardine barely dimples it.
 * @param loadCount how many of `loads` are live this frame. The caller pools
 *                  its entries and keeps the high-water mark, so the array is
 *                  longer than the catch and the tail is stale.
 */
export function updateBakalarNet(dt, frame, loads, loadCount = loads?.length ?? 0) {
  if (!mesh || !mesh.visible || dt <= 0) return;
  const c = CONFIG.bakalar.net;

  // A change in the WEAVE is the only thing that rebuilds — the column count
  // (a tuner move) or the row count (which follows the net's depth, so a
  // level-up). Checked here rather than in the tuner because the net is a
  // singleton and this is the one place guaranteed to run while it is on
  // screen. Width and depth alone rebuild nothing: they only move `rest`.
  wantedRows = rowsFor(frame.halfWidth, frame.depth);
  if (Math.round(c.cols) !== cols || wantedRows !== rows) {
    build(mesh.parent);
    if (!mesh) return;
    mesh.visible = true;
    reseat(frame.centerX, frame.top, frame.halfWidth, frame.depth);
  }

  const hx = (frame.halfWidth * 2) / (cols - 1);
  const hy = frame.depth / (rows - 1);
  const n = cols * rows;

  // --- rest, and the headline ---------------------------------------------
  // Rest is where the net would hang if nothing were in it, and it moves with
  // the boat every frame. The top row is written straight onto it: the hull
  // owns the headline, so it does not integrate and cannot lag.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = idx(i, j);
      rest[k * 2] = frame.centerX + (i / (cols - 1) - 0.5) * frame.halfWidth * 2;
      rest[k * 2 + 1] = frame.top - (j / (rows - 1)) * frame.depth;
      if (pinned[k]) {
        cur[k * 2] = prev[k * 2] = rest[k * 2];
        cur[k * 2 + 1] = prev[k * 2 + 1] = rest[k * 2 + 1];
      }
    }
  }

  applyKicks();

  // --- integrate ----------------------------------------------------------
  // Verlet with a fixed dt rather than the frame's. The constraint solver
  // below is iterative, so its effective stiffness depends on how far a node
  // moved before it ran — feed it a variable step and the net is limp on a
  // slow frame and rigid on a fast one, which is a look that changes with the
  // machine. Substepping keeps the sim honest and costs a loop over ~150
  // nodes, which is nothing.
  const STEP = 1 / 120;
  let remaining = Math.min(dt, 0.1); // a tab-out must not run a thousand steps
  const damp = Math.max(0, 1 - c.drag * STEP);
  const gravity = c.gravity * STEP * STEP;
  const iterations = Math.max(1, Math.round(c.iterations));

  // THE TOW. Water pushing back on the mesh, against the direction the hull is
  // dragging it — which is what makes the net stream out behind the boat
  // rather than hang under it like a curtain on a rail.
  //
  // A force, not a lag: leaving it to drag alone gets you a trail worth a
  // sixth of a unit on an eleven-unit net, because at a constant tow speed
  // drag has nothing to bite on but the tiny velocity error the constraints
  // leave behind. The flow is a real load and it scales with how fast the boat
  // is going, so a slow trawl hangs and a fast one streams.
  const hullVel = Number.isFinite(lastCenterX) ? (frame.centerX - lastCenterX) / dt : 0;
  lastCenterX = frame.centerX;
  const flow = -hullVel * c.flow * STEP * STEP;

  while (remaining > 0) {
    const h = Math.min(STEP, remaining);
    remaining -= h;

    for (let k = 0; k < n; k++) {
      if (pinned[k]) continue;
      const px = k * 2, py = px + 1;
      const vx = (cur[px] - prev[px]) * damp;
      const vy = (cur[py] - prev[py]) * damp;
      prev[px] = cur[px];
      prev[py] = cur[py];
      cur[px] += vx + flow;
      cur[py] += vy - gravity;

      // THE PULL HOME. A weak spring toward the shape the net hangs in,
      // standing in for the water flowing through a net under tow.
      //
      // WEAK IS LOAD-BEARING. This started at four per second and made the
      // whole simulation pointless: it removed 98% of any displacement every
      // second, so a shark bellied the mesh by nine hundredths of a unit and
      // the net may as well have been the static quad it replaced. What holds
      // the cells open is the compression term in solve(), which is local and
      // does not fight a pocket; this only stops slow drift, and every value
      // above about one takes the spring out of the spring net.
      const ease = Math.min(1, c.tension * h);
      cur[px] += (rest[px] - cur[px]) * ease;
      cur[py] += (rest[py] - cur[py]) * ease;
    }

    // --- the catch, bellying the mesh out --------------------------------
    // Each load shoves nearby nodes AWAY from itself, which is a pocket, plus
    // a share of its weight straight down, which is what makes the pocket hang
    // under the fish instead of forming a neat halo around it.
    if (loadCount > 0 && c.catchPush > 0) {
      const step2 = h * h;
      for (let li = 0; li < loadCount; li++) {
        const load = loads[li];
        const reach = Math.max(0.2, load.mass * c.catchReach);
        const r2 = reach * reach;
        const push = c.catchPush * load.mass * step2;
        const sag = c.catchSag * load.mass * step2;
        for (let k = 0; k < n; k++) {
          if (pinned[k]) continue;
          const px = k * 2, py = px + 1;
          const dx = cur[px] - load.x;
          const dy = cur[py] - load.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const d = Math.sqrt(d2) || REST_EPS;
          const f = 1 - d / reach;
          cur[px] += (dx / d) * f * push;
          cur[py] += (dy / d) * f * push - f * sag;
        }
      }
    }

    solve(hx, hy, iterations);

    // The net cannot rise above its own headline — a pocket springing back
    // hard enough to throw twine over the gunwale reads as a glitch, not as
    // energy. Applied after the solver so nothing can put it back.
    for (let k = 0; k < n; k++) {
      if (pinned[k]) continue;
      if (cur[k * 2 + 1] > frame.top) cur[k * 2 + 1] = frame.top;
    }
  }

  // --- upload -------------------------------------------------------------
  // Warp is distance from rest, normalised against the across-spacing, so the
  // heat means "displaced by this fraction of a cell" at every net size rather
  // than being a raw world distance that goes cold as the net grows.
  const pos = mesh.geometry.getAttribute('position');
  const arr = pos.array;
  const inv = 1 / Math.max(REST_EPS, hx);
  for (let k = 0; k < n; k++) {
    const px = k * 2, py = px + 1;
    arr[k * 3] = cur[px];
    arr[k * 3 + 1] = cur[py];
    arr[k * 3 + 2] = 0;
    warp[k] = Math.hypot(cur[px] - rest[px], cur[py] - rest[py]) * inv;
  }
  pos.needsUpdate = true;
  mesh.geometry.getAttribute('aWarp').needsUpdate = true;

  const u = material.uniforms;
  u.uColor.value.set(c.color);
  u.uHotColor.value.set(c.hotColor);
  u.uOpacity.value = c.opacity;
  u.uWarpGain.value = c.warpGain;
}

// Exported for tools/ability-smoke.mjs, same contract as the beam's: nothing
// in Node compiles GLSL, so the realistic failure — a uniform renamed on one
// side of the pair and not the other, which renders a silently black net — is
// only reachable by handing the harness both halves.
export const __netShader = { NET_VERT, NET_FRAG };

// Exported for tools/bakalar-net-test.mjs: the sim is the interesting half and
// it is entirely headless, so it can be stepped and measured without a GL
// context. Returns a live view, not a copy.
export const __netState = () => ({ cols, rows, cur, rest, prev, pinned, springs });
