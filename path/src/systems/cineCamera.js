import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { fovScale } from './settings.js';

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
//   1. THE STATE MACHINE. Round start, charging, boosting, and the three
//      beats of a death (the hit, the fall, the floor). Each state
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
//
// `offsetX`/`offsetY` are the newest of these and the only ones that move the
// frame off its SUBJECT. Every other state here is a way of looking at the
// seal; the main menu is a way of looking at the seal AND the row of buttons
// over its crown, which means the point being centred is not the animal. Held
// as a blended absolute rather than applied by the caller so it comes and goes
// on the same curve as everything else — a frame that slid back onto the seal
// on its own timer while the zoom was still opening would be two moves.
const ABSOLUTE_KEYS = ['zoom', 'offsetX', 'offsetY', 'defocus', 'focusRadius', 'focusFeather', 'flare', 'vignette', 'path'];
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
  'zoom', 'offsetX', 'offsetY', 'stiffness', 'damping', 'zoomStiffness', 'zoomDamping',
  'lookAhead', 'aimBias', 'deadZone',
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
// The food chain is deliberately absent: it is the one moment frequent enough
// that owning the frame made the rig pop between a push-in and base for most
// of a run. It keeps world.punchCamera's kick and nothing here (see main.js).
// `bossReveal` sits directly under the death beats: it is the one state that
// looks at something OTHER than the seal, and the only thing that may cut it
// short is the player dying during it.
const PRIORITY = ['mainMenu', 'deathFloor', 'deathFall', 'deathHit', 'bossReveal', 'boosting', 'charging', 'roundStart'];

function cfg() {
  return CONFIG.cinecam ?? {};
}

export function cineEnabled() {
  return !!cfg().enabled;
}

// ---------------------------------------------------------------------------
// THE ASPECT TERM — how a zoom somebody typed on a 16:9 screen is read on a
// screen that is not 16:9.
//
// Now that the arena no longer resizes itself to the window (see updateBounds
// in arena.js), the window's shape has to be answered somewhere, and this is
// the honest place: every authored zoom in config.js means "show this much
// ocean", and it was written down as a multiplier because the frame it was
// multiplying was always the same shape. It no longer is.
//
// So the rule is stated the way it was always meant: THE CAMERA SHOWS A
// CONSTANT WIDTH OF OCEAN. `frameWidth / referenceFrameWidth` is exactly the
// correction that holds `frameWidth / zoom` fixed, and it is 1.0 at the
// reference aspect — so a 16:9 screen, which is every screen the game was
// tuned on and every aspect the harnesses in tools/ pass to updateBounds, gets
// the number that was typed and not a hair more.
//
// WHAT IT CAN AND CANNOT DO, because the asymmetry is the whole story and it
// is easy to expect the wrong thing here. Zoom only ever punches IN — at 1 the
// frustum already IS the frame, and there is no such thing as zooming out past
// the display. So:
//
//   · A WIDE window (ultrawide, landscape phone) is corrected properly. It
//     would otherwise show more and more ocean for free, which on a 2.2 phone
//     was 93 units against the authored 75.
//   · A NARROW window (any phone in portrait) asks for a zoom below 1, gets
//     clamped at 1, and keeps the ~24 units its frustum can hold. It recovers
//     the 24% the base zoom of 1.24 was taking, and that is the end of what is
//     available: a portrait frustum is 24 units wide because it is 24 units
//     wide. Closing the rest would mean punching landscape down to a keyhole,
//     which is not a fix, it is the same unfairness pointed the other way.
//
// The narrow case is therefore a VIEW difference and not a rules difference,
// which is the distinction the arena change exists to draw. A portrait player
// swims in the same ocean, hits the same walls at the same coordinates, and
// meets creatures that spawned the same distance out — they just see less of
// it at once, and the rig's lookAhead is what buys that back.
//
// `maxPunch` caps the wide end. Without it a 32:9 display would be handed a
// 2.4x punch-in and play the whole game through a slot, which is a worse
// answer than letting it see a little extra ocean.
export function cineAspectZoom() {
  const h = CONFIG.arena?.viewHeight || 1;
  const ref = h * (CONFIG.arena?.referenceAspect || 16 / 9);
  // THE PLAYER'S FIELD OF VIEW DIVIDED BACK OUT, or it cancels itself exactly.
  // This function's whole job is to hold `frameWidth / zoom` constant, and the
  // fov setting is a deliberate change to `frameWidth` — so left in, the
  // correction would punch in by precisely what the player just widened and the
  // slider would do nothing at any aspect. The aspect term must see the frame
  // the window alone implies, which is what dividing by fov recovers.
  const live = bounds.frameWidth / (fovScale() || 1);
  if (!(ref > 0) || !(live > 0)) return 1;
  // Floored at nothing on the low side on purpose: the spring's own 1.001
  // clamp is what stops a narrow screen, and it is the single place that limit
  // belongs. A second floor here would be a number to keep in step with it.
  return Math.min(live / ref, cfg().base?.maxPunch ?? 1.6);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// THE SOFT WALL. Where clamp() is a cliff, this is a ramp: outside the last
// `ease` units of the legal range the value is folded onto an exponential that
// approaches the limit and never reaches it.
//
// It exists because the rig used to meet the edge of the arena as a clamp on
// its POSITION, with the target left pointing at a seal thirty units past the
// wall. The spring therefore drove into the limit at full speed and was
// truncated there: measured, the frame was still crossing 0.74 world units on
// the frame before it stopped, and then it stopped. The ocean halting on a
// frame boundary is most visible on a fast run at a wall, which is exactly
// when the frame is moving quickest.
//
// Two things fix it, and they are different sizes. Softening the spring's
// TARGET at all is most of it — a spring easing into a stationary target
// decelerates on its own curve, and that alone takes the last step down to
// about 0.14. The RAMP is the rest: over the last `ease` units the target
// itself slows down, so the frame is already crawling when it arrives (0.09).
// Both are measured in npm run test:width.
//
// Continuous in value AND slope at the seam (at v = hi - e the exponent is 0,
// so the curve passes through hi - e with gradient 1), so there is no tick
// where the easing starts. `ease` is capped at half the range because the two
// ramps must not overlap: at exactly half they meet at the midpoint, which is
// the degenerate-but-legal case of a pan range barely wider than the frame.
function softLimit(v, lo, hi, ease) {
  if (!(hi > lo)) return (lo + hi) / 2;
  const e = Math.min(ease, (hi - lo) / 2);
  if (!(e > 0)) return clamp(v, lo, hi);
  if (v > hi - e) return hi - e * Math.exp(-(v - (hi - e)) / e);
  if (v < lo + e) return lo + e * Math.exp(-((lo + e) - v) / e);
  return v;
}

// Smootherstep. One degree gentler than the smoothstep used elsewhere in the
// codebase, and deliberately so: a camera blend is the one curve the eye
// tracks for its whole length, and smoothstep's non-zero second derivative at
// the ends is visible as a faint tick on a slow push.
function ease(t) {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// ---------------------------------------------------------------------------
// THE MAIN MENU'S FRAMING, which is the one state the config cannot hold.
//
// Every other state is a set of numbers somebody typed: "the charge sits at
// 1.62". The menu's framing is MEASURED at runtime — it is whatever zoom makes
// the seal's own measured bust fill the frame on this window, and whatever
// offset puts the row of buttons above its crown (see systems/mainMenu.js).
// So the state's shape lives in config.js like all the others, and these three
// numbers are written over the top of it while the screen is up.
//
// A LATCH, not a pulse. The menu is a mode — it is up until somebody presses
// something — where roundStart is a moment that expires on its own clock. That is also why it is first in PRIORITY: nothing else in the list
// can be happening while the game has not started.
const menuState = { held: false, zoom: 0, offsetX: 0, offsetY: 0 };

/**
 * Hold (or drop) the menu's framing, and tell the rig what it is.
 *
 * Dropping it is what makes the transition into a run one movement: the frame
 * does not cut, it blends to whatever the priority list turns up next — which
 * on Play is `roundStart`, the run's own opening shot, and then `base`. Menu →
 * starting camera → gameplay, all on the rig's own curves.
 *
 * @param framing { zoom, offsetX, offsetY } — offsets are WORLD units from the
 *                seal, because that is what the goal below is built from.
 */
export function cineMenu(held, framing = null) {
  menuState.held = !!held;
  if (framing) {
    // DIVIDED BACK OUT OF THE ASPECT TERM, because this number arrives already
    // correct for this window and everything downstream is about to multiply
    // by it again. mainMenu.js measures the bust against the REAL frame, so
    // what it hands over is a finished zoom, where every other state in the
    // config is a zoom written for a 16:9 screen. Stored in that same authored
    // space and multiplied back at the point of use, the two are commensurable
    // — which is what the menu → roundStart blend needs, since it interpolates
    // between this bag and one that was typed. Without it the menu's framing
    // is squared on any window that isn't 16:9, and the seal fills the screen
    // on a laptop while a phone looks at one whisker.
    const af = cineAspectZoom();
    if (framing.zoom != null) menuState.zoom = framing.zoom / (af || 1);
    menuState.offsetX = framing.offsetX ?? menuState.offsetX;
    menuState.offsetY = framing.offsetY ?? menuState.offsetY;
  }
}

/** Is the rig currently holding the menu's framing? */
export function cineMenuHeld() {
  return menuState.held;
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
  // The measured half of the menu's framing, over the authored half. Applied
  // here rather than by mutating the config block, because CONFIG is what the
  // tuner snapshots and saves — a screen that wrote its own runtime numbers
  // into it would ship one window's zoom to every player.
  if (name === 'mainMenu' && menuState.zoom > 0) {
    out.zoom = menuState.zoom;
    out.offsetX = menuState.offsetX;
    out.offsetY = menuState.offsetY;
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
  // state's, because "how long does the dash take to let go" is a property of
  // the dash and not of whatever happens to come next.
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
// Round start has no condition to test for — it is a moment, not a mode — so
// it is pushed in and expires on its own clock. Held in its own latch rather
// than as `machine.state` directly, because a death can outrank a live pulse
// and the pulse still has to be able to expire underneath it.
//
// One caller, now that the food chain no longer takes the frame; the mechanism
// stays because a moment that fires ONCE is exactly what it is for, and that is
// the line the food chain crossed.
let pulse = { name: null, left: 0 };

export function cineEvent(name) {
  if (!cineEnabled()) return;
  const s = cfg().states?.[name];
  if (!s) return;
  pulse = { name, left: s.hold ?? 1 };
}

// ---------------------------------------------------------------------------
// THE REVEAL — the one shot that is not of the seal
// ---------------------------------------------------------------------------
// Every state above is a way of LOOKING at the player: the goal below is built
// from ctx.target, and what a state changes is the zoom, the lens and how
// tightly the rig chases. A boss arriving is the one moment the game has
// something else to say, so this is the one state that also moves the subject.
//
// It is a function rather than a point, and that is load-bearing: the boss is
// still swimming while the frame travels to it, and a point captured on the
// frame the reveal fired would have the camera pan to where it used to be —
// arriving, with great ceremony, at empty water a body-length behind it.
//
// A LATCH, like the main menu's framing, and not a pulse like roundStart —
// which is what it was first, and the reason it changed is worth keeping. The
// shot plays over the boss's arrival ceremony, and this file runs on the WALL
// clock while that ceremony runs on the game's (see the dt note on
// updateCineCamera). The two come apart the moment anything stops the run: an
// xp spill can open a level-up card in the middle of an arrival, and a shot
// counting down on its own would end there, over a health bar frozen half
// full. Held until the thing it is a shot OF says it is done, it cannot.
//
// Three ways it ends, so a forgotten release cannot strand the camera on a
// fight nobody is having: the caller drops it (cineRevealDone, which boss.js
// does when the ceremony lands, when the boss dies, when the fight is switched
// off and on a run reset), the subject stops existing (see revealPoint), or the
// rig is reset.
let reveal = { held: false, at: null };

// WHERE THE SHARP BIT OF THE PICTURE GOES, published for world.js the same way
// the rest of the lens is. The tilt-shift focal point is projected from the
// camera's SUBJECT, and for every other state in this file that is the seal —
// which is why world.js has always projected the player and never had to ask.
// A shot of a boss with the sharp disc still parked on a seal at the edge of
// frame is the whole reveal thrown away, so the one state that moves the
// subject has to say so.
export const cineSubject = { active: false, x: 0, y: 0 };

/**
 * Look at something else. Held until cineRevealDone.
 *
 * @param at  () => ({ x, y }) — read every frame, see above. A subject that
 *            returns null (the boss died mid-shot, or was cleaned up) ends the
 *            reveal on that frame rather than freezing the frame on a hole in
 *            the water.
 */
export function cineReveal(at) {
  if (!cineEnabled()) return;
  if (!cfg().states?.bossReveal || typeof at !== 'function') return;
  reveal = { held: true, at };
}

/** Let go — the ceremony landed, or the subject is gone. */
export function cineRevealDone() {
  reveal = { held: false, at: null };
}

/** Is the frame currently off the seal? For the tuner readout and the tests. */
export function cineRevealing() {
  return reveal.held && !!reveal.at;
}

// Where the reveal is pointing this frame, or null if there is nothing to
// point at. Resolved once per frame and reused, because the subject is a
// callback into another module and the goal reads it in two places.
function revealPoint() {
  if (!cineRevealing()) return null;
  const p = reveal.at();
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    cineRevealDone();
    return null;
  }
  return p;
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
  reveal = { held: false, at: null };
  // NOT the menu latch. A reset is "this run is starting from nothing", and the
  // one route that resets the rig while a menu is up is the menu's own Play —
  // where dropping the latch here would cut the frame to the opening shot on
  // the press. main.js skips the reset entirely in that case; this is the
  // second lock on the same door.
  cineLens.droplets = 0;
  cineLens.dropAge = 0;
  cineLens.active = false;
  cineSubject.active = false;
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
    // The latch, not a pulse — the menu is a mode. See cineMenu.
    mainMenu: menuState.held,
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
    bossReveal: cineRevealing(),
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
 *                  focusLimits(zoom, allowFloorOverscan) -> { loX, hiX, loY, hiY }
 *                    optional; the same box clampFocus enforces, handed over
 *                    open so the rig can ease into it rather than be cut off
 *                    at it. Without it the rig falls back to the hard clamp.
 *                  halfExtents(zoom) -> { w, h }  visible half-frame, world units
 *                }
 * @returns { x, y, zoom } the world point to centre and the zoom to do it at.
 */
export function updateCineCamera(dt, ctx) {
  const c = cfg();
  if (!c.enabled) {
    cineLens.active = false;
    cineSubject.active = false;
    return null;
  }
  const base = c.base ?? {};
  if (!machine.cur) resetCineCamera();

  // --- state machine -------------------------------------------------------
  if (pulse.left > 0) {
    pulse.left -= dt;
    if (pulse.left <= 0) pulse = { name: null, left: 0 };
  }
  // Resolved BEFORE pick(), because a subject that has gone (a boss killed
  // during its own reveal, an enemy list cleared by a reset) ends the reveal
  // inside revealPoint — and the state machine has to see that on this frame
  // rather than hold a shot of empty water for one more.
  const subject = revealPoint();
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
  // The ceiling, and why it is not simply `zoomMax`. That number is a guard on
  // the SPRING — it stops a stiff chase from running away — and the main menu
  // asks for about fifteen, which is a composition rather than an overshoot.
  // A state that names a zoom is allowed to have it; anything the spring adds
  // on top of that is still capped.
  //
  // APPLIED HERE, at the point of use, rather than inside resolve(). The bags
  // are resolved once on entering a state and then blended for up to a second,
  // so a factor folded into them would be frozen at whatever the window was
  // when the state began — and an orientation flip mid-run is precisely a
  // window changing shape underneath a live blend. Read fresh every frame, the
  // blend stays in authored space and the aspect is answered last, which also
  // means a resize moves the frame on the zoom spring rather than cutting.
  const af = cineAspectZoom();
  const pz = p.zoom * af;
  // FLOORED AT THE SAME 1.001 THE CLAMPS BELOW USE, because the aspect term can
  // otherwise invert the two limits. On a portrait phone `af` is about 0.26, so
  // a zoomMax of 3.55 scales to a CEILING of 0.92 — under the floor. Any aspect
  // below ~0.5 gets there.
  //
  // Latent rather than live, and worth being exact about: clamp() tests the
  // floor FIRST, and in this regime the spring is always pulling rig.zoom
  // downward (the target is 0.32), so every value reaching the clamp is below
  // 1.001 and is caught by that branch on the way past. The `v > hi` branch
  // that would return 0.92 is unreachable today. It is one comparison order
  // away from not being — and what it returns is a zoom below 1, which asks
  // the frustum to show more than the frame it was built from: bare scene
  // background past the walls, on exactly the devices this change is for.
  //
  // So this is a guard, not a fix for an observed symptom. It costs nothing and
  // it means the two limits can never cross, which is the property worth having
  // rather than the argument about which branch happens to fire first.
  const zoomCeil = Math.max(1.001, (base.zoomMax ?? 3) * af, pz, (machine.from?.zoom ?? 0) * af);
  if (!rig.primed) {
    rig.zoom = clamp(pz, 1.001, zoomCeil);
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
      [rig.zoom, rig.zoomVel] = springStep(rig.zoom, rig.zoomVel, pz, k, zd, h);
    }
    // Kill the velocity into the stop as well as the value, exactly as the
    // positional clamp does — a spring left integrating against a limit it
    // cannot see arrives holding hidden energy and fires on the way back.
    const zc = clamp(rig.zoom, 1.001, zoomCeil);
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
  // WHAT THE FRAME IS OF. The seal, except for the one state that is a shot of
  // something else — and only while that state actually owns the frame. On the
  // way back out the machine has already returned to `base`, so the goal is
  // the player again and the same spring that carried the frame over carries
  // it home: the pan back is the pan out played in reverse, for free.
  //
  // The lead and the aim bias are deliberately NOT re-pointed at the subject.
  // Both describe the player's swimming and the player's aim, and neither
  // means anything about a boss; the reveal state zeroes them in config.js in
  // any case, and this is the second lock on that door.
  const onSubject = subject && machine.state === 'bossReveal';
  cineSubject.active = !!onSubject;
  if (onSubject) {
    cineSubject.x = subject.x;
    cineSubject.y = subject.y;
  }
  const goalX = onSubject
    ? subject.x + p.offsetX
    : ctx.target.x + rig.leadX + p.offsetX
      + (aimLen > 0.001 ? (ctx.aim.x / aimLen) * aimBias : 0);
  const goalY = onSubject
    ? subject.y + p.offsetY
    : ctx.target.y + rig.leadY + p.offsetY
      + (aimLen > 0.001 ? (ctx.aim.y / aimLen) * aimBias : 0);

  // How far the frame may travel past the arena's walls, and over how much of
  // its last approach it eases in. `edgeEase` is a fraction of the HALF-frame
  // — the same currency as the dead zone below, and for the same reason: it
  // then means the same thing at every zoom and every aspect ratio. A state
  // that pushes in gets a proportionally shorter ramp, which is right, because
  // the tighter frame has less travel left to spend on easing.
  //
  // `focusLimits` is optional so a caller that predates it (and the tests that
  // drive this rig with a hand-built ctx) still gets the old hard-clamped
  // behaviour rather than a crash.
  const allowFloor = machine.state.startsWith('death');
  const edge = base.edgeEase ?? 0.3;
  const easeX = edge * half.w;
  const easeY = edge * half.h;
  const limits = ctx.focusLimits ? ctx.focusLimits(zoom, allowFloor) : null;

  if (!rig.primed) {
    // First frame of a run: place the rig, don't spring to it from wherever
    // the last run left it. A run that opens with the camera sailing in from
    // the previous death is the one thing round start must not do. Placed at
    // the SOFTENED goal, not the raw one, so frame one is already where the
    // spring would have settled — priming to the hard limit and easing off it
    // afterwards is a lurch on the opening frame.
    const at = limits
      ? ctx.clampFocus(
          softLimit(goalX, limits.loX, limits.hiX, easeX),
          softLimit(goalY, limits.loY, limits.hiY, easeY),
          zoom, false,
        )
      : ctx.clampFocus(goalX, goalY, zoom, false);
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

  // Soften the target against the arena BEFORE the spring sees it. This is the
  // easing: the spring is then chasing something already legal, so it
  // decelerates on its own curve instead of being cut off by the clamp below,
  // and it settles rather than arriving with velocity to kill.
  //
  // On the TARGET and not on the output, on purpose. Compressing the spring's
  // position each substep would leave it pulling toward a goal it can never
  // reach, banking force against a limit it cannot see — which is the same
  // stored-energy bug the clamp below describes, dressed up as a fix for it.
  if (limits) {
    targetX = softLimit(targetX, limits.loX, limits.hiX, easeX);
    targetY = softLimit(targetY, limits.loY, limits.hiY, easeY);
  }

  // --- spring --------------------------------------------------------------
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
    // Where the strike will actually GO — the halfway point between the swim
    // and the aim, handed in by main.js from strikeDirection(), the same
    // function the release itself calls. Pointing this at the cursor (or at
    // the movement stick) instead would light up a path the dash isn't going
    // to take, which is worse than not drawing one.
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
    revealing: cineRevealing(),
  };
}
