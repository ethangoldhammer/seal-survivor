import { CONFIG } from '../config.js';

// The CINEMATIC CAMERA — an opt-in second camera brain, sitting alongside the
// plain fixed frame that has always shipped. `CONFIG.cinecam.enabled` is the
// only switch: off, world.js takes the original path and not one line of this
// file runs; on, this owns where the frame sits and hands systems/post.js a
// set of lens values to render with.
//
// What it is NOT: a change to the playfield. `bounds` in arena.js is derived
// from arena.viewHeight and the aspect ratio and nothing here touches it —
// the seal swims in exactly the same box, the walls are where they were, and
// every spawn, clamp and bounce lands identically. All that changes is which
// part of that box is on screen and how sharp it is. That is also why the rig
// has to punch IN to work at all: at zoom 1 the frustum already covers the
// whole arena, so there is nowhere to pan to (see clampFocus in world.js,
// whose limits collapse to a point at zoom 1).
//
// Three pieces, in the order they run:
//
//   1. THE STATE MACHINE. Round start, charging, boosting, food chain, and
//      the three beats of a death (the hit, the fall, the floor). Each state
//      is a SPARSE override on the base parameters, resolved to a full bag
//      and then blended from wherever the last one had got to — so a state
//      added to the config picks up every base parameter for free, and a
//      state that overrides nothing is simply the base.
//   2. THE RIG. A damped spring per axis chasing a goal built from the
//      player's position, a velocity lead, an aim bias and a dead zone.
//   3. THE LENS. Not applied here — published on `cineLens` for post.js to
//      read, the same arrangement deathDive.js uses for its push-in. This
//      module has no business knowing what a render target is.
//
// Springs are integrated with substepped semi-implicit Euler rather than
// position Verlet. Verlet on a variable frame delta changes the effective
// damping every time the frame rate moves, which on a spring this stiff is
// the difference between "leads the seal" and "rings like a bell" — and this
// game's delta genuinely does move, because the death dive dilates it. The
// fixed substep below is what makes the feel reproducible instead.

const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 8;

// Everything a state may set, and the only keys that get blended. Split by how
// a state names them: absolutes replace the base value outright, multipliers
// scale it. Zoom, defocus and the rest read better as "this state is at 1.55",
// while stiffness and lead read better as "this state is twice as tight as
// normal" — pinning those to absolute numbers means every base change has to
// be re-typed into all eight states.
const ABSOLUTE_KEYS = ['zoom', 'defocus', 'focusRadius', 'focusFeather', 'flare', 'vignette', 'path'];
const MULTIPLIER_KEYS = {
  stiffMul: 'stiffness',
  dampMul: 'damping',
  lookAheadMul: 'lookAhead',
  aimBiasMul: 'aimBias',
  deadZoneMul: 'deadZone',
  // The zoom spring's own stiffness and damping, separate from the positional
  // ones because the two genuinely want opposite things — most starkly during
  // a dash, where the FRAME is deliberately soft so the seal outruns it
  // (stiffMul 0.55) while the LENS has to snap open. Sharing one number meant
  // the dash's positional lag also made the zoom crawl out over most of a
  // second, which read as a slow release rather than a spring.
  //
  // Because a missing multiplier resolves to 1 rather than to its positional
  // twin, any state that scales stiffMul must scale zoomStiffMul too or its
  // zoom quietly changes speed. They are set in pairs in config.js.
  zoomStiffMul: 'zoomStiffness',
  zoomDampMul: 'zoomDamping',
};
// The resolved bag: what the rig and the lens actually read, and what a blend
// interpolates. `stiffness` and `damping` are scalars applied to both axes on
// top of the per-axis base, so a state can tighten the whole rig with one
// number without losing the X/Y split.
const BLEND_KEYS = [
  'zoom', 'stiffness', 'damping', 'zoomStiffness', 'zoomDamping', 'lookAhead', 'aimBias', 'deadZone',
  'defocus', 'focusRadius', 'focusFeather', 'flare', 'vignette', 'path',
];

// What post.js reads. Published rather than pushed for the same reason
// deathState publishes its camera numbers: the lens belongs to the renderer,
// the decision about the lens belongs here, and neither should import the
// other's internals.
export const cineLens = {
  active: false,
  focusX: 0.5,   // where the sharp region is centred, in uv
  focusY: 0.5,
  defocus: 0,
  focusRadius: 1,
  focusFeather: 1,
  flare: 0,
  vignette: 0,
  droplets: 0,   // 0..1, decays after a breach
  dropAge: 0,    // seconds since the breach that wet the lens

  // The dash corridor: a second, narrower focus claim laid along the line the
  // strike will actually travel, so winding one up lights up where it goes.
  // Additive to the radial focus above rather than replacing it — the seal
  // stays sharp, and the corridor carves a sharp lane out of the soft
  // surroundings instead of moving the sharp region off the player.
  pathAmount: 0,   // 0..1, blended in with the charge state
  pathDirX: 1,     // WORLD-space direction, normalized. See the note in post.js
  pathDirY: 0,     //   on why a world vector is usable directly in the shader.
  pathLength: 0,   // reach, in aspect-corrected uv (1.0 = the frame's height)
  pathWidth: 0,    // half-width of the sharp lane
  pathFeather: 0,
  pathVignette: 0, // extra darkening OUTSIDE the lane
};

const rig = {
  x: 0, y: 0, vx: 0, vy: 0,
  zoom: 1, zoomVel: 0,
  leadX: 0, leadY: 0,
  primed: false, // false until the first frame places the rig without a spring
};

const machine = {
  state: 'base',
  hold: 0,        // countdown for states that expire on their own
  blendT: 0,
  blendDur: 0,
  from: null,     // resolved bag the blend started from
  to: null,       // resolved bag it is heading for
  cur: null,      // what this frame reads
};

// Highest priority first. A death outranks everything, and inside a death the
// later beat outranks the earlier one so the machine can only ever move
// forward through hit -> fall -> floor.
const PRIORITY = ['deathFloor', 'deathFall', 'deathHit', 'foodChain', 'boosting', 'charging', 'roundStart'];

function cfg() {
  return CONFIG.cinecam ?? {};
}

export function cineEnabled() {
  return !!cfg().enabled;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// Smootherstep. One degree gentler than the smoothstep used elsewhere in the
// codebase, and deliberately so: a camera blend is the one curve the eye
// tracks for its whole length, and smoothstep's non-zero second derivative at
// the ends is visible as a faint tick on a slow push.
function ease(t) {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Resolve a state name to a full parameter bag over the base values. */
function resolve(name) {
  const c = cfg();
  const base = c.base ?? {};
  const s = (name === 'base' ? null : c.states?.[name]) ?? {};
  const out = {};
  for (const key of ABSOLUTE_KEYS) out[key] = s[key] ?? base[key] ?? 0;
  for (const [mulKey, outKey] of Object.entries(MULTIPLIER_KEYS)) {
    out[outKey] = s[mulKey] ?? 1;
  }
  return out;
}

function blendBags(from, to, t) {
  const out = {};
  for (const key of BLEND_KEYS) out[key] = lerp(from[key], to[key], t);
  return out;
}

function enter(name) {
  if (machine.state === name) return;
  const c = cfg();
  const incoming = c.states?.[name] ?? {};
  const leaving = c.states?.[machine.state] ?? {};
  // Entering a state is that state's business; LEAVING one is the departing
  // state's, because "how long does the food chain punch take to let go" is a
  // property of the food chain and not of whatever happens to come next.
  const dur = name === 'base'
    ? (leaving.blendOut ?? c.base?.blendOut ?? 0.6)
    : (incoming.blendIn ?? c.base?.blendIn ?? 0.4);

  // Captured before machine.state is reassigned below.
  const wasAt = machine.cur ?? resolve(machine.state);

  machine.to = resolve(name);
  machine.state = name;
  machine.hold = incoming.hold ?? 0;

  // Nothing has been drawn yet — this is the state a run OPENS in, so it is
  // the starting condition rather than something to blend to. Blending here
  // would mean startGame's roundStart pulled the frame out from the base zoom
  // over most of a second and then pushed it back in, a wobble on the first
  // two seconds of every run.
  if (!rig.primed) {
    machine.from = machine.to;
    machine.cur = machine.to;
    machine.blendT = 1;
    machine.blendDur = 0.0001;
    return;
  }

  // Otherwise: from wherever the last blend actually got to, not from the
  // state it was nominally in. Interrupting a push-in halfway should continue
  // from halfway.
  machine.from = wasAt;
  machine.blendDur = Math.max(0.0001, dur);
  machine.blendT = 0;
}

// --- one-shot states -------------------------------------------------------
// Round start and the food chain have no condition to test for — they are
// moments, not modes — so they are pushed in and expire on their own clock.
// Held in their own latch rather than as `machine.state` directly, because a
// death can outrank a live food chain and the food chain still has to be able
// to expire underneath it.
let pulse = { name: null, left: 0 };

export function cineEvent(name) {
  if (!cineEnabled()) return;
  const s = cfg().states?.[name];
  if (!s) return;
  pulse = { name, left: s.hold ?? 1 };
}

/** The lens comes out of the water: bead it up and let it dry. */
export function cineBreach(strength = 1) {
  if (!cineEnabled()) return;
  const d = cfg().lens?.droplets ?? {};
  if (!(d.enabled ?? true)) return;
  cineLens.droplets = Math.min(1, cineLens.droplets + (d.perBreach ?? 1) * strength);
  cineLens.dropAge = 0;
}

export function resetCineCamera() {
  rig.x = 0; rig.y = 0; rig.vx = 0; rig.vy = 0;
  rig.zoom = 1; rig.zoomVel = 0;
  rig.leadX = 0; rig.leadY = 0;
  rig.primed = false;
  machine.state = 'base';
  machine.cur = resolve('base');
  machine.from = machine.cur;
  machine.to = machine.cur;
  machine.blendT = 1;
  machine.blendDur = 0.0001;
  machine.hold = 0;
  pulse = { name: null, left: 0 };
  cineLens.droplets = 0;
  cineLens.dropAge = 0;
  cineLens.active = false;
}

/**
 * Which state should own the frame this instant.
 *
 * @param signals { charging, boosting, deathPhase, deathElapsed }
 */
function pick(signals) {
  const c = cfg();
  const live = {
    deathFloor: signals.deathPhase === 'settle' || signals.deathPhase === 'done',
    deathFall: signals.deathPhase === 'sink' && signals.deathElapsed >= (c.states?.deathHit?.hold ?? 0.5),
    deathHit: signals.deathPhase === 'sink',
    foodChain: pulse.name === 'foodChain' && pulse.left > 0,
    boosting: !!signals.boosting,
    // The BUTTON, not strikeState.charging. Those come apart the moment the
    // bar empties under a held button: `charging` goes false because there is
    // no fuel left to burn, but the player is still holding, still committed,
    // and the wind-up resumes by itself the instant food refills the meter
    // (see strike.js). Letting the lens spring out there would punish holding
    // through an empty bar, which is a real thing to do. The wind-up SHAKE
    // still rides `charging`, because a tremble is powered by the fuel and
    // this is not.
    charging: !!signals.strikeHeld,
    roundStart: pulse.name === 'roundStart' && pulse.left > 0,
  };
  for (const name of PRIORITY) {
    if (live[name] && c.states?.[name]) return name;
  }
  return 'base';
}

function springStep(pos, vel, target, k, ratio, dt) {
  // `ratio` is a damping RATIO, not a coefficient: 1 is critically damped
  // whatever the stiffness, so a state can tighten the spring without
  // accidentally making it ring. Deriving the coefficient from sqrt(k) is the
  // only reason the stiffness sliders are usable at all — with a raw
  // coefficient, every stiffness change needs a matching damping change.
  const c = ratio * 2 * Math.sqrt(Math.max(0.0001, k));
  const a = (target - pos) * k - vel * c;
  return [pos + (vel + a * dt) * dt, vel + a * dt];
}

/**
 * @param dt      real (wall-ish) seconds — see main.js; the camera runs on the
 *                same clock the particles and the water do.
 * @param ctx     {
 *                  target:   { x, y }  the player
 *                  velocity: { x, y }
 *                  aim:      { x, y }  normalized, may be zero-length
 *                  charging, boosting, deathPhase, deathElapsed
 *                  clampFocus(x, y, zoom, allowFloorOverscan) -> { x, y }
 *                  halfExtents(zoom) -> { w, h }  visible half-frame, world units
 *                }
 * @returns { x, y, zoom } the world point to centre and the zoom to do it at.
 */
export function updateCineCamera(dt, ctx) {
  const c = cfg();
  if (!c.enabled) {
    cineLens.active = false;
    return null;
  }
  const base = c.base ?? {};
  if (!machine.cur) resetCineCamera();

  // --- state machine -------------------------------------------------------
  if (pulse.left > 0) {
    pulse.left -= dt;
    if (pulse.left <= 0) pulse = { name: null, left: 0 };
  }
  const want = pick(ctx);
  if (want !== machine.state) enter(want);

  if (machine.blendT < 1) {
    machine.blendT = Math.min(1, machine.blendT + dt / machine.blendDur);
    machine.cur = blendBags(machine.from, machine.to, ease(machine.blendT));
  } else {
    machine.cur = machine.to;
  }
  const p = machine.cur;

  // --- zoom ----------------------------------------------------------------
  // Snapped, not sprung, on the first frame of a run — and BEFORE the framing
  // below, because at zoom 1 the frustum is exactly the arena and clampFocus
  // collapses to a single point. Spring the zoom up from 1 instead and the
  // opening half-second of every run is pinned to the middle of the ocean
  // however far away the seal is, then slides over to find it.
  if (!rig.primed) {
    rig.zoom = clamp(p.zoom, 1.001, base.zoomMax ?? 3);
    rig.zoomVel = 0;
  }

  // Sprung rather than blended straight from the state bag, so the blend curve
  // sets where the zoom is HEADING and the spring decides how it gets there.
  // Without it, a 0.06s blend into the food-chain state is a cut.
  {
    let steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUBSTEP)));
    const h = dt / steps;
    const k = (base.zoomStiffness ?? 26) * p.zoomStiffness;
    // Under 1 this overshoots and settles back — which is the whole ask for
    // the wind-up. It also means the RELEASE springs out past the resting
    // width before coming back to it, because the same under-damped spring is
    // now chasing a target that has jumped wide. The pop out is the pull-in
    // played backwards, and it costs nothing extra.
    const zd = (base.zoomDamping ?? 1) * p.zoomDamping;
    while (steps-- > 0) {
      [rig.zoom, rig.zoomVel] = springStep(rig.zoom, rig.zoomVel, p.zoom, k, zd, h);
    }
    // Kill the velocity into the stop as well as the value, exactly as the
    // positional clamp does — a spring left integrating against a limit it
    // cannot see arrives holding hidden energy and fires on the way back.
    const zc = clamp(rig.zoom, 1.001, base.zoomMax ?? 3);
    if (zc !== rig.zoom) { rig.zoom = zc; rig.zoomVel = 0; }
  }
  const zoom = rig.zoom;

  // --- goal ----------------------------------------------------------------
  const half = ctx.halfExtents(zoom);

  // Velocity lead, smoothed on its own clock. `lookAhead` is in SECONDS —
  // "show me where I'll be a fifth of a second from now" — which is the one
  // framing of it that survives changing the seal's top speed.
  const leadTarget = {
    x: clamp(ctx.velocity.x * base.lookAhead * p.lookAhead, -(base.lookAheadMax ?? 12), base.lookAheadMax ?? 12),
    y: clamp(ctx.velocity.y * base.lookAhead * p.lookAhead, -(base.lookAheadMax ?? 12), base.lookAheadMax ?? 12),
  };
  const leadK = 1 - Math.exp(-dt / Math.max(0.0001, base.lookAheadLag ?? 0.35));
  rig.leadX += (leadTarget.x - rig.leadX) * leadK;
  rig.leadY += (leadTarget.y - rig.leadY) * leadK;

  const aimLen = Math.hypot(ctx.aim.x, ctx.aim.y);
  const aimBias = base.aimBias * p.aimBias;
  const goalX = ctx.target.x + rig.leadX + (aimLen > 0.001 ? (ctx.aim.x / aimLen) * aimBias : 0);
  const goalY = ctx.target.y + rig.leadY + (aimLen > 0.001 ? (ctx.aim.y / aimLen) * aimBias : 0);

  if (!rig.primed) {
    // First frame of a run: place the rig, don't spring to it from wherever
    // the last run left it. A run that opens with the camera sailing in from
    // the previous death is the one thing round start must not do. Clamped
    // here as well as in the spring loop, so frame one is already legal
    // rather than legal by the end of its first substep.
    const at = ctx.clampFocus(goalX, goalY, zoom, false);
    rig.x = at.x; rig.y = at.y; rig.vx = 0; rig.vy = 0;
    rig.primed = true;
  }

  // Dead zone. The spring's target only moves once the goal has left a box
  // around where the frame already is — inside it the camera is genuinely
  // still, which is the whole difference between a soft box and a very loose
  // spring. Expressed as a fraction of the HALF-frame, so it means the same
  // thing at every zoom and every aspect ratio.
  const dzX = (base.deadZone?.x ?? 0.1) * p.deadZone * half.w;
  const dzY = (base.deadZone?.y ?? 0.14) * p.deadZone * half.h;
  let targetX = rig.x;
  let targetY = rig.y;
  if (goalX > rig.x + dzX) targetX = goalX - dzX;
  else if (goalX < rig.x - dzX) targetX = goalX + dzX;
  if (goalY > rig.y + dzY) targetY = goalY - dzY;
  else if (goalY < rig.y - dzY) targetY = goalY + dzY;

  // --- spring --------------------------------------------------------------
  const allowFloor = machine.state.startsWith('death');
  let steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUBSTEP)));
  const h = dt / steps;
  const kx = (base.stiffness?.x ?? 55) * p.stiffness;
  const ky = (base.stiffness?.y ?? 38) * p.stiffness;
  const damp = (base.damping ?? 0.9) * p.damping;
  while (steps-- > 0) {
    [rig.x, rig.vx] = springStep(rig.x, rig.vx, targetX, kx, damp, h);
    [rig.y, rig.vy] = springStep(rig.y, rig.vy, targetY, ky, damp, h);
    // Clamped inside the loop, and the velocity into the wall killed with it.
    // Clamping only the output lets the spring keep integrating against a
    // limit it cannot see, and it arrives at the edge of the arena holding a
    // large hidden velocity — which then fires the frame across the screen
    // the moment the seal turns around.
    const lim = ctx.clampFocus(rig.x, rig.y, zoom, allowFloor);
    if (lim.x !== rig.x) { rig.x = lim.x; rig.vx = 0; }
    if (lim.y !== rig.y) { rig.y = lim.y; rig.vy = 0; }
  }

  // --- lens ----------------------------------------------------------------
  const lensCfg = c.lens ?? {};
  const drops = lensCfg.droplets ?? {};
  if (cineLens.droplets > 0) {
    cineLens.dropAge += dt;
    // Linear rather than exponential: drops evaporate, they don't decay, and
    // an exponential leaves a last few hanging on the glass for ever.
    cineLens.droplets = Math.max(0, cineLens.droplets - dt / Math.max(0.05, drops.life ?? 3.2));
  }

  // focusX/focusY are NOT set here. The tilt-shift focal point has to be where
  // the seal lands on screen after world.js has applied the death dive's focus
  // claim over the top of this rig, and that hasn't happened yet — world.js
  // projects and writes them the moment it has the final frame.
  cineLens.active = true;
  cineLens.defocus = (lensCfg.tiltShift?.enabled ?? true) ? p.defocus * (lensCfg.tiltShift?.strength ?? 1) : 0;
  cineLens.focusRadius = p.focusRadius;
  cineLens.focusFeather = Math.max(0.01, p.focusFeather);
  cineLens.flare = (lensCfg.flare?.enabled ?? true) ? p.flare * (lensCfg.flare?.strength ?? 1) : 0;
  cineLens.vignette = p.vignette;

  // --- the dash corridor ---------------------------------------------------
  // `p.path` rides the state blend, so this fades in and out on exactly the
  // same curve as the pull-in rather than needing a timer of its own.
  const pathCfg = lensCfg.path ?? {};
  const amount = (pathCfg.enabled ?? true) ? p.path : 0;
  cineLens.pathAmount = amount;
  if (amount > 0.001) {
    // Where the strike will actually GO, which is the movement stick and only
    // falls back to aim from a standstill — the same rule tryStrike uses in
    // main.js. Pointing this at the cursor instead would light up a path the
    // dash isn't going to take, which is worse than not drawing one.
    const dx = ctx.dashDir?.x ?? 0;
    const dy = ctx.dashDir?.y ?? 0;
    const len = Math.hypot(dx, dy);
    if (len > 0.001) {
      cineLens.pathDirX = dx / len;
      cineLens.pathDirY = dy / len;
    }
    // Reach grows with banked power, because the dash's reach does too — so
    // the corridor is a live readout of how far this strike will carry, not
    // just decoration.
    const power = clamp(ctx.chargePower ?? 0, 0, 1);
    cineLens.pathLength = ((pathCfg.length ?? 0.3) + (pathCfg.lengthPerPower ?? 0.35) * power) * amount;
    cineLens.pathWidth = pathCfg.width ?? 0.1;
    cineLens.pathFeather = Math.max(0.01, pathCfg.feather ?? 0.18);
    cineLens.pathVignette = (pathCfg.vignette ?? 0.45) * amount;
  } else {
    cineLens.pathLength = 0;
    cineLens.pathVignette = 0;
  }

  return { x: rig.x, y: rig.y, zoom };
}

/** For the tuner readout and for tests — what the machine is actually doing. */
export function cineDebug() {
  return {
    state: machine.state,
    blend: machine.blendT,
    zoom: rig.zoom,
    x: rig.x,
    y: rig.y,
    droplets: cineLens.droplets,
  };
}
