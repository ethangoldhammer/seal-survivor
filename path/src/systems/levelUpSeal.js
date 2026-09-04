import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ease } from '../ease.js';
import { createVisual, addOutlineShells, setOutlineThicknessOn } from '../assets.js';
import { createAnimationController, stateForSpeed } from './animation.js';
import { createAimRig } from './aimRig.js';
import { createBustPin, measureBust, bustPlumb, bustAim } from './splashBust.js';
import { createEyePair, createEyeLights, updateEyeLights } from './eyeLights.js';
import { accessoryTurn, dressBody } from './accessories.js';
import { CARD_FOCUS_EVENT } from '../ui/cardFocus.js';

// ---------------------------------------------------------------------------
// THE SEAL UNDER THE HAND.
//
// While the upgrade cards are up, the main menu's bust swims up from below
// them, plants itself under the row, and watches whichever card the player is
// pointing at. The moment one is taken it shoots off the top of the screen.
//
// IT IS A SECOND SEAL, ON A CANVAS OF ITS OWN. The obvious animal — the run's
// (entities/player.js), which the main menu reuses so well — is mid-arena,
// saluting its level (systems/celebrate.js), and the cards sit on a honeycomb
// that is a near-opaque scrim over the whole fight (CONFIG.upgradeComb:
// restAlpha 0.9 at a layer opacity of 0.75). Anything drawn into the game's
// canvas is behind that scrim, and the game's canvas is behind the cards too.
// So this is a throwaway seal — the same model, rig, pin, rim and eyes the
// menu poses, built once and kept — in a scene of its own, drawn by a second
// renderer into a transparent canvas that sits between the comb and the cards
// (ui/ui.js, `.sv-levelup-seal`). A second GL context is the honest price of
// being on top of a DOM layer; the canvas is a column and not the viewport,
// so the fill it costs is the animal's.
//
// WHAT IT REUSES, which is nearly everything and on purpose:
//
//   the pose        systems/splashBust.js — the waist pin, the plumb, the aim
//                   remapped through the bust's spread. The pin is applied
//                   with a WEIGHT here (the one thing added to that file), so
//                   the animal can arrive swimming and plant over a few frames
//                   rather than its tail going straight on one.
//   the look        systems/aimRig.js — the run's own head and flipper IK. A
//                   card's centre is handed to bustAim exactly as the menu
//                   hands it the cursor, and the rig's new `finGate` picks
//                   which ONE flipper joins the head in pointing at it.
//   the swim        the run's, on the way in and out: heading up, the swim or
//                   boost clip picked from the actual speed (stateForSpeed),
//                   fins at the rig's idle weight, the waist free — and the
//                   strike's barrel roll on the exit (CONFIG.strike.roll's
//                   shape, this file's turns).
//   the hat         systems/accessories.js dressBody — the slot's accessory,
//                   placed on this body at the same angle as the player's,
//                   without touching the one-slot record that belongs to the
//                   player's.
//   the eyes        systems/eyeLights.js, as a pair of its own.
//
// EVERYTHING IS IN SCREEN PIXELS. The puppet's world is the viewport: x is the
// CSS pixel from the left, y is MINUS the CSS pixel from the top (three's y is
// up), and the camera is an orthographic window onto that. A card's
// getBoundingClientRect is therefore a world position with a sign flip and
// nothing else, which is what makes "look at that card" a one-liner. The bust
// is measured once at unit scale and scaled to a fraction of the viewport
// height every frame, so a resize re-composes it for free.
//
// TWO HALVES, and the split is what makes it testable: createLevelUpPuppet is
// the animal and its motion — no DOM, no renderer, driven by a frame it is
// handed — and the module-level functions below are the canvas, the rects and
// the wiring. tools/level-up-seal-test.mjs drives the first half on the real
// furseal.glb.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.levelUpSeal ?? {};
}

/** The toggle. Read live — the tuner can flip it between two hands. */
export function levelUpSealEnabled() {
  return cfg().enabled !== false;
}

const _z = new THREE.Vector3(0, 0, 1);
const _y = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3();

// Everything on the parent chain, averaged per node — the same measure
// outlines.js uses to turn a world thickness into an object-space one, so a
// rim asked for in pixels is that many pixels whatever the holder's scale is.
function accumulatedScale(o) {
  let s = 1;
  for (let n = o; n; n = n.parent) {
    s *= (Math.abs(n.scale.x) + Math.abs(n.scale.y) + Math.abs(n.scale.z)) / 3;
  }
  return s;
}

/**
 * The animal and its motion. No DOM, no renderer.
 *
 * @param body   a createVisual('ship') — this takes ownership of it.
 * @param eyes   build the eye lights (their halo is a canvas texture, which a
 *               Node harness has no 2D context for).
 * @param outline  add the rim shells.
 * @param dress  put the equipped accessory on it.
 */
export function createLevelUpPuppet(body, { eyes = true, outline = true, dress = true } = {}) {
  const holder = new THREE.Object3D();
  holder.add(body);

  const anim = createAnimationController(body);
  const rig = createAimRig(body);
  const pin = createBustPin(body);

  // THE RIM. Two shells, as the player's has (systems/outlines.js
  // attachPlayerOutline) — the lit fringe and the ink line inside it — but NOT
  // through that function, which holds the player's shells in a module-level
  // list and would drop them to take these. Thickness is set by fitRim below,
  // in pixels, once the holder's scale is known.
  const pc = CONFIG.playerOutline ?? {};
  const rimShells = outline ? addOutlineShells(body, { color: pc.color ?? 0xffffff, glow: pc.glow ?? 1 }) : [];
  const inkShells = outline ? addOutlineShells(body, { color: pc.inner?.color ?? 0x000000 }) : [];
  for (const shell of inkShells) shell.renderOrder += 0.5;

  let pair = null;
  let eyeGroup = null;
  if (eyes) {
    pair = createEyePair('eyes');
    eyeGroup = createEyeLights(pair);
  }

  // --- the frame it is composed against, in CSS pixels ----------------------
  const frame = {
    w: 1280, h: 720,
    crownLine: 480,       // the y the crown wants to sit on
    centreX: 640,         // where the bust's centre line is
    idle: { x: 640, y: 300 }, // where to look when nothing is pointed at
  };

  const state = {
    phase: 'none', // none | wait | in | held | out
    t: 0,
    crownY: 0,     // where the crown IS, this frame, in CSS px from the top
    fromY: 0,
    toY: 0,
    // THE PLANT, 0..1 — 0 is the run's swimmer (heading up, waist free, fins
    // at the rig's idle), 1 is the bust (plumb, cant, waist pinned). The pin
    // weight, the body's pose and the fins' engagement all read this one
    // number, so the animal turns from one into the other as a whole.
    plant: 1,
    pinWeight: 1,
    roll: 0,       // the exit's barrel roll, radians about the spine
    speed: 0,      // this frame's vertical speed, in model units per second
    animState: 'idle',
    finGate: null, // what the rig was handed this frame — [left, right]
    reenter: false,
    look: null,    // {x, y} in CSS px, or null for the idle look
    scale: 1,      // px per instance unit, this frame
  };

  const aim = new THREE.Vector2(0, 1);
  const wantAim = new THREE.Vector2(0, 1);
  const _turnQ = new THREE.Quaternion();
  const _plumbQ = new THREE.Quaternion();
  const _leanQ = new THREE.Quaternion();
  const _bustQ = new THREE.Quaternion();
  const _swimQ = new THREE.Quaternion();
  const _rollQ = new THREE.Quaternion();
  let plumb = 0;
  let turn = 0;
  let lastRimScale = -1;

  // `q = Rz(lean) * Ry(turn) * Rz(plumb)`, in that order, for the reason the
  // main menu gives at length: the plumb is a correction measured in profile,
  // about the animal's own lateral axis, and has to turn WITH the animal; the
  // cant is a screen-plane thing and must not.
  function bustPose(out) {
    _leanQ.setFromAxisAngle(_z, cfg().lean ?? 0.05);
    _turnQ.setFromAxisAngle(_y, turn);
    _plumbQ.setFromAxisAngle(_z, plumb);
    return out.copy(_leanQ).multiply(_turnQ).multiply(_plumbQ);
  }

  // THE SWIMMER'S POSE is the run's: a seal swimming straight up is a body on
  // heading +Y, which is exactly the orientation createVisual leaves it in
  // (poseBody in entities/player.js would write rotation.z = 0 for it), plus
  // the accessory's turn. No plumb — that is a correction for STANDING the
  // idle clip's curl up, and a swimmer is not standing.
  function swimPose(out) {
    return out.setFromAxisAngle(_y, turn);
  }

  // --- settle, plumb, measure — once, at build ------------------------------
  // The same sequence mountMainMenu runs, for the same reasons: the rig eases
  // in from zero weight so the first frames are a different animal; the plumb
  // is measured on a settled pose; and standing it up moves the head, which
  // moves the aim, which moves the head, so it settles again. At turn 0, which
  // is the WIDER silhouette, so the box holds every turn a hat can ask for.
  const DT = 1 / 60;
  function settleStep(dt) {
    anim?.update(dt, 'idle', false);
    bustPose(holder.quaternion);
    holder.updateMatrixWorld(true);
    rig?.update(dt, aim, { engaged: true });
    pin?.apply(1);
    holder.updateMatrixWorld(true);
  }
  for (let i = 0; i < 120; i++) settleStep(DT);
  plumb = bustPlumb(pin, rig);
  for (let i = 0; i < 60; i++) settleStep(DT);
  // The box, at unit scale, in the holder's frame (the holder is at the
  // origin, unscaled, for this measurement and only this one).
  const bust = measureBust(body, pin);
  if (bust.isEmpty()) bust.setFromObject(body);
  const bustH = Math.max(1e-3, bust.max.y - bust.min.y);
  const bustW = Math.max(1e-3, bust.max.x - bust.min.x);
  const bustCx = (bust.min.x + bust.max.x) / 2;

  // WHICH FLIPPER IS ON WHICH SIDE OF THE SCREEN, measured on the settled
  // profile rather than assumed from the names: `left`/`right` are the
  // animal's own sides, and which of them faces screen-left depends on how
  // the model was authored and which way the accessory turned it. The one
  // whose shoulder sits further left on screen is the screen-left fin.
  const fins = rig?.fins ?? [];
  const _shoulder = new THREE.Vector3();
  const finScreenX = fins.map((f) => {
    f.bones?.[0]?.getWorldPosition(_shoulder);
    return _shoulder.x;
  });
  const screenLeftFin = finScreenX.length
    ? finScreenX.indexOf(Math.min(...finScreenX))
    : -1;

  // The hat goes on AFTER the settle: its placement reads the bone's world
  // matrix, and the animal has to be standing for that to be the right one.
  const worn = dress ? dressBody(body) : null;
  turn = accessoryTurn();

  // --- the rim, in pixels -----------------------------------------------------
  function fitRim() {
    const c = cfg();
    const rimPx = Math.max(0, c.outlinePx ?? 2);
    const inkPx = Math.max(0, c.inkPx ?? 1);
    for (const shell of rimShells) {
      const s = accumulatedScale(shell);
      shell.visible = rimPx > 0;
      setOutlineThicknessOn(shell.material, s > 1e-6 ? rimPx / s : rimPx);
    }
    for (const shell of inkShells) {
      const s = accumulatedScale(shell);
      shell.visible = inkPx > 0;
      setOutlineThicknessOn(shell.material, s > 1e-6 ? inkPx / s : inkPx);
    }
  }

  /** The bust's height on screen this frame, in px. */
  function heightPx() {
    return Math.max(24, (cfg().height ?? 0.34) * frame.h);
  }

  // Where the crown line actually is, after the short-screen clamp: the bust
  // may come up BEHIND the cards (it draws under the stage) rather than stay
  // off the bottom when the row runs low.
  function crownTarget() {
    const minVisible = Math.max(0, Math.min(1, cfg().minVisible ?? 0.45));
    return Math.min(frame.crownLine, frame.h - minVisible * heightPx());
  }

  function belowScreen() {
    return frame.h + 0.05 * heightPx();
  }

  function aboveScreen() {
    return -(heightPx() * 1.1);
  }

  /**
   * THE FLIPPER THAT POINTS. A gate per fin for the rig, from CONFIG.fin and
   * where the card is: the pointing fin gets 1, the rest get `finIdle`.
   * Null (no gate at all — both fins at the rig's own weights) for `both`.
   */
  function finGateFor(lookX) {
    const c = cfg();
    const which = c.fin ?? 'near';
    if (!fins.length || which === 'both') return null;
    const idle = Math.max(0, Math.min(1, c.finIdle ?? 0));
    const gate = fins.map(() => idle);
    if (which === 'none') return gate;
    let pick = -1;
    if (which === 'left' || which === 'right') {
      pick = fins.findIndex((f) => f.name === which);
    } else if (screenLeftFin >= 0) {
      // The seal's centre line on screen, and which side of it the card is.
      const centre = holder.position.x + bustCx * state.scale;
      const cardLeft = lookX < centre;
      const other = fins.length > 1 ? (screenLeftFin === 0 ? 1 : 0) : screenLeftFin;
      pick = (which === 'far') === cardLeft ? other : screenLeftFin;
    }
    if (pick >= 0) gate[pick] = 1;
    return gate;
  }

  const puppet = {
    holder, body, rig, anim, pin, eyeGroup, pair, worn,
    bust, bustH, bustW, screenLeftFin,
    state, frame, aim,
    get phase() { return state.phase; },
    get active() { return state.phase !== 'none'; },

    /** Tell it the viewport and the row. Every field optional. */
    setFrame(f) {
      Object.assign(frame, f);
      if (f?.idle) frame.idle = { ...f.idle };
    },

    /** Point it at a screen position ({x, y} in CSS px), or null for idle. */
    look(at) {
      state.look = at ? { x: at.x, y: at.y } : null;
    },

    /** The cards are up: come up from below. */
    enter() {
      if (!levelUpSealEnabled()) return;
      if (state.phase === 'out') {
        // Mid-exit — a second card in the same batch. Finish leaving, then
        // come back from below; a seal that reversed halfway up the screen
        // would read as a seal that changed its mind.
        state.reenter = true;
        return;
      }
      if (state.phase !== 'none') return;
      state.phase = 'wait';
      state.t = 0;
      state.crownY = belowScreen();
      state.plant = cfg().swimRig === false ? 1 : 0;
      state.pinWeight = state.plant;
      state.roll = 0;
      state.reenter = false;
    },

    /** A card was taken: off the top, fast. */
    leave() {
      state.reenter = false;
      if (state.phase === 'none' || state.phase === 'out') return;
      state.phase = 'out';
      state.t = 0;
      state.fromY = state.crownY;
      state.toY = aboveScreen();
      state.roll = 0;
    },

    reset() {
      state.phase = 'none';
      state.t = 0;
      state.reenter = false;
      state.look = null;
      state.plant = 1;
      state.pinWeight = 1;
      state.roll = 0;
      state.finGate = null;
      body.quaternion.identity();
    },

    /**
     * One frame, on the WALL clock (this is a screen element, not a body in
     * the dilated water). Returns the phase.
     */
    update(rawDt) {
      if (state.phase === 'none') return state.phase;
      const c = cfg();
      const dt = Math.min(0.05, Math.max(0, rawDt));
      state.t += dt;
      const swimming = c.swimRig !== false;

      // --- where the crown is ---------------------------------------------
      const line = crownTarget();
      const wasY = state.crownY;
      let wantPlant = 1;
      switch (state.phase) {
        case 'wait': {
          state.crownY = belowScreen();
          wantPlant = swimming ? 0 : 1;
          if (state.t >= (c.delay ?? 0.1)) {
            state.phase = 'in';
            state.t = 0;
            state.fromY = state.crownY;
          }
          break;
        }
        case 'in': {
          const T = Math.max(0.05, c.inTime ?? 0.75);
          const k = ease(c.inEase ?? 'outCubic', Math.min(1, state.t / T));
          state.crownY = state.fromY + (line - state.fromY) * k;
          // A swimmer until `plantAt` of the rise, then it starts standing up,
          // so it is the bust by the time it stops rather than stopping and
          // then stiffening.
          wantPlant = !swimming || k >= (c.plantAt ?? 0.6) ? 1 : 0;
          if (state.t >= T) {
            state.phase = 'held';
            state.t = 0;
            state.crownY = line;
          }
          break;
        }
        case 'held': {
          // Follows the row if it moves (a resize, the tooltip pushing the
          // layout) — eased, so a jump in the DOM is a glide here.
          state.crownY += (line - state.crownY) * (1 - Math.exp(-8 * dt));
          break;
        }
        case 'out': {
          const T = Math.max(0.05, c.outTime ?? 0.45);
          const k = ease(c.outEase ?? 'inCubic', Math.min(1, state.t / T));
          state.crownY = state.fromY + (state.toY - state.fromY) * k;
          wantPlant = swimming ? 0 : 1;
          // THE STRIKE'S BARREL ROLL: whole turns about the spine over the
          // first `spinTime` of the exit, on the same smoothstep-shaped curve
          // the strike's roll runs (entities/player.js, `rollAngle`).
          if (c.spin !== false && (c.spinTurns ?? 2) > 0) {
            const spinT = Math.max(0.01, Math.min(1, c.spinTime ?? 1)) * T;
            const st = ease(c.spinEase ?? 'inOutCubic', Math.min(1, state.t / spinT));
            state.roll = (c.spinTurns ?? 2) * Math.PI * 2 * st;
          } else {
            state.roll = 0;
          }
          if (state.t >= T) {
            state.phase = 'none';
            state.t = 0;
            state.roll = 0;
            body.quaternion.identity();
            if (state.reenter) {
              state.reenter = false;
              puppet.enter();
            }
            return state.phase;
          }
          break;
        }
        default: break;
      }
      const blend = 1 - Math.exp(-(c.pinLerp ?? 6) * dt);
      state.plant += (wantPlant - state.plant) * blend;
      if (Math.abs(state.plant - wantPlant) < 0.002) state.plant = wantPlant;
      state.pinWeight = state.plant;

      // --- scale and place -----------------------------------------------
      const s = heightPx() / bustH;
      state.scale = s;
      holder.scale.setScalar(s);
      holder.position.x = frame.centreX + (c.offsetX ?? 0) * frame.w - bustCx * s;
      holder.position.y = -state.crownY - bust.max.y * s;
      if (Math.abs(s - lastRimScale) > 1e-6) {
        lastRimScale = s;
        fitRim();
      }
      // The speed the clip is picked from, in the model's own units — px per
      // second over px per unit — so the run's thresholds (CONFIG.animation
      // moveThreshold / boostThreshold) mean here what they mean there.
      state.speed = dt > 0 ? Math.abs(state.crownY - wasY) / dt / s : 0;

      // --- the look ----------------------------------------------------------
      const pointing = !!state.look;
      const at = state.look ?? frame.idle;
      _look.set(at.x, -at.y, 0);
      const forward = Math.PI / 2 + (c.lean ?? 0.05) * state.plant;
      bustAim(rig, _look, wantAim, forward, c.aimSpread ?? 0.7);
      aim.lerp(wantAim, 1 - Math.exp(-(c.aimLerp ?? 7) * dt));
      if (aim.lengthSq() > 1e-8) aim.normalize();

      // --- the body, in the order the game does it: clip, rig, pin ---------
      // The clip is the run's choice for this speed while swimming and the
      // idle once planted — a planted animal moving with the row must not
      // start paddling.
      state.animState = state.plant >= 0.999 ? 'idle' : stateForSpeed(state.speed);
      anim?.update(dt, state.animState, false);
      // The pose: the swimmer's heading blended into the bust by the plant.
      holder.quaternion.copy(swimPose(_swimQ)).slerp(bustPose(_bustQ), state.plant);
      // ...and the roll on the BODY, about its own long axis, as the run
      // composes it (player.body.quaternion carries the roll, player.mesh the
      // heading).
      body.quaternion.copy(_rollQ.setFromAxisAngle(_y, state.roll));
      holder.updateMatrixWorld(true);

      // THE RIG. Planted and pointing: engaged, the head and the chosen fin
      // on the card. Planted and idle: the head on the row, the fins to the
      // clip. Swimming: the run's own idle weights, no gate — the seal you
      // play as, going somewhere.
      const planted = state.plant > 0.5;
      let gate = null;
      if (planted) gate = pointing ? finGateFor(at.x) : fins.map(() => 0);
      state.finGate = gate;
      const faceOut = pointing
        ? Math.abs(Math.sin(turn))
        : Math.max(Math.abs(Math.sin(turn)), (c.faceOut ?? 0) * state.plant);
      rig?.update(dt, aim, { engaged: planted && pointing, finGate: gate, faceOut });
      pin?.apply(state.pinWeight);
      holder.updateMatrixWorld(true);

      if (pair) {
        updateEyeLights(dt, rig, { lit: 1, charge: 0, pair });
        // The beads and halos are sized in the run's world units (a radius of
        // 0.08, on an animal 2.6 long) and this world is pixels — so they come
        // out a tenth of a pixel across. Scaled back up by the px-per-unit.
        for (const eye of pair.eyes) {
          eye.bead.scale.multiplyScalar(s);
          eye.halo.scale.multiplyScalar(s);
        }
      }
      return state.phase;
    },
  };

  return puppet;
}

// ---------------------------------------------------------------------------
// THE CANVAS, THE RECTS AND THE WIRING — browser only from here down.
// ---------------------------------------------------------------------------

export const levelUpSealState = {
  built: false,
  phase: 'none',
};

let worldRenderer = null;
let live = null;
let lastPixelRatio = 0;

/** The live canvas, scene and puppet — for a look page's console, nothing else. */
export function levelUpSealLive() {
  return live;
}

/** Once, at boot: which renderer to match. Builds nothing. */
export function installLevelUpSeal({ renderer } = {}) {
  worldRenderer = renderer ?? null;
}

function onCardFocus(e) {
  lookLevelUpSeal(e?.detail?.card ?? null);
}

/**
 * Build the seal, its scene and its canvas. Called at the top of the level-up
 * ramp so the one-time cost (a settle-and-measure on the CPU, a compile on the
 * GPU) lands in the slow-motion beat and not on the frame the cards arrive.
 * A no-op once built, and when the feature is off.
 */
export function prepareLevelUpSeal() {
  if (live) return live;
  if (!levelUpSealEnabled()) return null;
  if (typeof document === 'undefined') return null;
  const menu = document.getElementById('svLevelUpMenu');
  if (!menu) return null;

  const canvas = document.createElement('canvas');
  canvas.className = 'sv-levelup-seal';
  canvas.style.display = 'none';
  // AFTER the comb and BEFORE the stage — see the CSS note in ui/ui.js.
  const comb = document.getElementById('svComb');
  if (comb && comb.parentNode === menu) menu.insertBefore(canvas, comb.nextSibling);
  else menu.insertBefore(canvas, menu.firstChild);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  } catch (err) {
    console.warn('[levelUpSeal] no second GL context — the seal stays off.', err);
    canvas.remove();
    return null;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = true;
  // LINEAR OUT, NO TONE MAPPING — and this is the whole difference between the
  // menu's seal and a white one. The game never draws a material to the
  // screen: post.js renders the scene into a half-float target (no output
  // encoding, no tone mapping — three applies both only on the default
  // framebuffer) and its final pass is a raw ShaderMaterial that writes those
  // linear values to the screen as they are. Every look in this game was
  // authored against that. A renderer left at its sRGB default encodes the
  // same seal a stop and a half brighter: measured on the level-up look page,
  // the run's slate-grey animal came out near-white until this was set.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  lastPixelRatio = pixelRatio();
  renderer.setPixelRatio(lastPixelRatio);

  const scene = new THREE.Scene();
  // The game's own three lights — the seal's surface is a mottle lit by these
  // (CONFIG.sealShader), so a portrait lit any other way is a different animal.
  const L = CONFIG.lighting ?? {};
  scene.add(new THREE.AmbientLight(0xffffff, L.ambient ?? 0.85));
  const key = new THREE.DirectionalLight(0xffffff, L.keyIntensity ?? 1.25);
  key.position.fromArray(L.keyPosition ?? [4, 8, 14]);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, L.hemiIntensity ?? 0.4));

  const body = createVisual('ship');
  const puppet = createLevelUpPuppet(body);
  scene.add(puppet.holder);
  if (puppet.eyeGroup) scene.add(puppet.eyeGroup);

  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -5000, 5000);
  camera.position.set(0, 0, 0);

  live = { canvas, renderer, scene, camera, puppet, col: { left: 0, w: 0, h: 0 } };
  levelUpSealState.built = true;
  document.addEventListener(CARD_FOCUS_EVENT, onCardFocus);

  // Warm the programs now, with the scene target bound as it will be when it
  // draws (the default framebuffer — this renderer never uses another).
  renderer.compileAsync?.(scene, camera)?.catch?.(() => {});
  return live;
}

function pixelRatio() {
  const pr = worldRenderer?.getPixelRatio?.() ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  return Math.max(0.5, Math.min(2, pr || 1));
}

/** The cards are up — swim up under them. Builds first if it has to. */
export function enterLevelUpSeal() {
  if (!levelUpSealEnabled()) return;
  if (!live) prepareLevelUpSeal();
  live?.puppet.enter();
}

/** A card was taken — off the top. */
export function leaveLevelUpSeal() {
  live?.puppet.leave();
}

/**
 * Point the seal at a card (a .sv-card element), or at nothing.
 * Also reachable through the CARD_FOCUS_EVENT ui.js announces.
 */
export function lookLevelUpSeal(card) {
  if (!live) return;
  if (!card?.getBoundingClientRect) {
    live.puppet.look(null);
    return;
  }
  const r = card.getBoundingClientRect();
  if (!(r.width > 0)) {
    live.puppet.look(null);
    return;
  }
  live.puppet.look({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
}

export function resetLevelUpSeal() {
  if (!live) return;
  live.puppet.reset();
  live.canvas.style.display = 'none';
  levelUpSealState.phase = 'none';
}

// Where the row is, this frame. The cards' container rather than the stage:
// the stage carries the title above the cards, and the crown wants the cards.
function readFrame(frame) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cards = document.getElementById('svCards');
  const r = cards?.getBoundingClientRect();
  const c = cfg();
  const have = r && r.height > 0;
  return {
    w, h,
    crownLine: have ? r.bottom + (c.gap ?? 28) : frame.crownLine,
    centreX: w / 2,
    idle: have ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : frame.idle,
  };
}

/**
 * One frame, on the wall clock. Sizes and places the canvas, steps the puppet,
 * draws. Nothing at all while the seal is off screen.
 */
export function updateLevelUpSeal(rawDt) {
  if (!live) return;
  const { puppet, canvas, renderer, camera, scene, col } = live;
  if (!levelUpSealEnabled() && puppet.active) puppet.reset();
  levelUpSealState.phase = puppet.phase;
  if (!puppet.active) {
    if (canvas.style.display !== 'none') canvas.style.display = 'none';
    return;
  }

  const frame = readFrame(puppet.frame);
  puppet.setFrame(frame);
  puppet.update(rawDt);
  if (!puppet.active) {
    canvas.style.display = 'none';
    return;
  }

  // The column: the bust's width times a margin for the flippers, centred on
  // the animal, the full height of the viewport so the exit has somewhere to
  // go. Resized only when it changes — setSize is not free.
  const c = cfg();
  const s = puppet.state.scale;
  const colW = Math.max(1, Math.min(frame.w, Math.round(puppet.bustW * s * (c.column ?? 2.4))));
  const centre = frame.centreX + (c.offsetX ?? 0) * frame.w;
  const left = Math.round(Math.max(0, Math.min(frame.w - colW, centre - colW / 2)));
  const h = Math.max(1, Math.round(frame.h));
  const pr = pixelRatio();
  if (pr !== lastPixelRatio) {
    lastPixelRatio = pr;
    renderer.setPixelRatio(pr);
    col.w = 0; // force the resize below
  }
  if (colW !== col.w || h !== col.h) {
    col.w = colW;
    col.h = h;
    renderer.setSize(colW, h, true);
  }
  if (left !== col.left) {
    col.left = left;
    canvas.style.left = `${left}px`;
  }
  if (canvas.style.display !== 'block') canvas.style.display = 'block';

  camera.left = left;
  camera.right = left + colW;
  camera.top = 0;
  camera.bottom = -h;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}
