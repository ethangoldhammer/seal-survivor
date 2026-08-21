// ---------------------------------------------------------------------------
// THE BUST — an alternate splash screen, live and cursor-driven.
//
//   npm run looks:bust        then open http://localhost:4660/splash-bust.html
//
// A SCAFFOLD, not a screen the game can reach yet. The seal is upright and in
// profile, cropped at the waist, filling the frame; everything from the waist
// down is pinned to the pose the model was authored in; the neck and the front
// flippers point at the pointer. The backdrop is a flat neutral blue, standing
// in for whatever the title card is eventually composited over.
//
// EVERY MOVING PART IS THE SHIPPING CODE. systems/aimRig.js does the neck and
// flipper IK (and the peek toward the viewer when the cursor goes somewhere a
// neck cannot follow), systems/animation.js runs `water_idle` over the top so
// the chest still breathes, systems/eyeLights.js puts the eye in the socket,
// systems/outlines.js draws the rim and systems/post.js composites. What is
// specific to this treatment is systems/splashBust.js: the pin and the crop.
//
// A SPLINE SCENE CAN GO BEHIND IT — see mountSpline below for the three ways in
// and, more importantly, for which one costs what.
//
// IT WRITES NOTHING. A vite build behind a read-only static server — there is
// no /__tuning endpoint to reach, so nothing here can touch the live tuning.
// See SERVERS.md.
//
// WHY IT IS A LOOK PAGE AND NOT THE GAME. The splash artboard is opaque, so a
// title treatment rendered behind it cannot be seen at all (systems/titleSeal.js
// says the same thing at more length), and the game's dev server is the sole
// writer of imported-tuning.json. This runs the real modules with neither
// problem.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../../path/src/config.js';
import {
  preloadAssets, createVisual, applySavedAssetLooks, applyNoiseSettings, applyToonSettings,
  applyBiolumSkinSettings,
} from '../../path/src/assets.js';
import { createAnimationController } from '../../path/src/systems/animation.js';
import { createAimRig } from '../../path/src/systems/aimRig.js';
import { createEyeLights, updateEyeLights } from '../../path/src/systems/eyeLights.js';
import { attachPlayerOutline, applyPlayerOutline, updatePlayerOutline } from '../../path/src/systems/outlines.js';
import { createPost } from '../../path/src/systems/post.js';
import { createBustPin, measureBust, fitBustCamera, bustAim, bustPlumb, createBustOutline } from '../../path/src/systems/splashBust.js';
import { createHexMenu } from '../../path/src/systems/hexMenu.js';
import { createGrid } from '../../path/src/systems/grid.js';
import { touchSlots } from '../../path/src/input.js';
import { initTypography } from '../../path/src/ui/typography.js';
import { initParticles, updateParticles, updateParticleScale, emit } from '../../path/src/entities/particles.js';

const cfg = CONFIG.splashBust;

// --- the lock ---------------------------------------------------------------
//
// THE KNOBS ARE IN MEMORY AND A RELOAD THROWS THEM AWAY. That is deliberate —
// this page has no route to imported-tuning.json and must not grow one — but it
// also means an afternoon of nudging the rim is gone the moment the tab
// refreshes, and the keys are live on `window`, so a stray keystroke moves a
// value with nothing to say it did.
//
// So: `w` writes the numbers this page owns to tools/looks/splash-bust.json,
// beside the page where a rebuild cannot delete it and a diff will show it, and
// they are read back here on every boot. `l` locks the keys so nothing moves by
// accident. Neither touches the game — pasting the file into config.js is what
// makes a value the default, and that stays a decision rather than a side
// effect of having looked at something.
//
// The fields are listed rather than serialising the whole block: `menu` carries
// derived state and CONFIG.splashBust will grow keys that are not this page's
// to own.
const LOCKABLE = ['fill', 'headroom', 'offsetX', 'lean', 'outlinePx', 'outlineColor', 'outlineInk', 'aimSpread', 'aimLerp'];
const LOCKABLE_MENU = [
  'latticeSpacing', 'colStep', 'cellFill', 'bevel', 'latticeColor', 'latticeOpacity',
  'rise', 'offsetX', 'color', 'hot', 'normal', 'coreAlpha', 'power', 'rimAlpha', 'rimBoost', 'sheen',
  'hoverScale', 'hoverHot', 'chargeTime', 'chargeMin', 'chargeHot', 'chargeGrow',
  'impulseStrength', 'impulseRadius', 'clickScale', 'squishAmount', 'squishHz', 'squishDecay', 'dripRate',
];

let locked = false;
let savedNote = '';

// Applied BEFORE the rig, the crop or the menu are built: every one of them
// reads these numbers once, at construction.
try {
  const saved = await (await fetch('/preset/splash-bust.json')).json();
  for (const k of LOCKABLE) if (saved[k] !== undefined) cfg[k] = saved[k];
  for (const k of LOCKABLE_MENU) if (saved.menu?.[k] !== undefined) cfg.menu[k] = saved.menu[k];
  if (Object.keys(saved).length) { locked = true; savedNote = 'preset loaded — keys LOCKED (l to unlock)'; }
} catch {
  // No server, or nothing saved. Both are the normal case on a first run.
}
const q = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const stateEl = document.getElementById('state');
const valsEl = document.getElementById('vals');
const splineEl = document.getElementById('spline');
const splineNote = document.getElementById('splineNote');
const lockEl = document.getElementById('lock');

// ---------------------------------------------------------------------------
// THE SPLINE SCENE — `?spline=<what you were given>`, or paste it here once.
//
// Three things Spline hands out, and this takes whichever you have:
//
//   a .glb / .gltf FILE         drop it in public/models/ and pass
//                               `?spline=/models/yours.glb`. It is loaded into
//                               THIS scene: the game's lights, the outline
//                               pass, bloom and the vignette all reach it, and
//                               it depth-sorts against the seal. Spline's own
//                               interactivity does not survive the export —
//                               geometry and materials do.
//   a .splinecode URL           from Spline's code export. Loaded by
//                               @splinetool/runtime into its own canvas behind
//                               this one, keeping Spline's events and states.
//   any other https:// URL      the public viewer link (my.spline.design/...).
//                               Mounted as an iframe behind this one.
//
// THE LAST TWO ARE LAYERS, NOT SCENES. They bring their own WebGL context,
// their own copy of three and their own loop, so nothing in them can pass in
// front of a flipper and nothing in this file can light them. They also cost
// the game's composite: post.js's final pass writes `vec4(color, 1.0)` — fully
// opaque — so leaving it on would paint over the layer entirely. With a layer
// mounted this page renders straight to the screen instead, and the seal loses
// bloom and the vignette until the two are reconciled. `?post` forces the
// composite back on, which is worth doing once to see exactly what it hides.
//
// The .glb route has none of that problem, which is why it is the one to reach
// for if the Spline content has to share the frame rather than sit behind it.
const SPLINE_DEFAULT = '';
const splineSrc = q.get('spline') ?? SPLINE_DEFAULT;
const splineIsModel = /\.(glb|gltf)(\?|#|$)/i.test(splineSrc);
// A layer is anything that is not loaded into our own scene.
const layered = !!splineSrc && !splineIsModel;
const wantPost = !layered || q.has('post');

// --- the frame --------------------------------------------------------------
// `alpha` unconditionally: it can only be asked for at construction, and a
// layer mounted below needs the seal's canvas to have somewhere to be
// transparent. With no layer the background below is opaque and it changes
// nothing.
const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const post = createPost(renderer);

const scene = new THREE.Scene();
// NOT converted — three does it. `new THREE.Color(hex)` already stores the
// value in the working (linear) space, and a background Color rendered into a
// render target is read back in that same space, so a convertSRGBToLinear()
// here converts a second time and the "neutral blue" arrives as near-black. The
// game sets its own sky exactly like this (createWorld in world.js).
scene.background = layered ? null : new THREE.Color(cfg.backdrop);

// The game's own three lights, read out of CONFIG rather than invented here —
// the seal's whole surface is a procedural mottle lit by these (CONFIG.sealShader),
// so a portrait lit any other way would be judging a different animal.
scene.add(new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient));
const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
key.position.fromArray(CONFIG.lighting.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity));

const camera = new THREE.OrthographicCamera();
camera.position.set(0, 0, 40);

// --- the spline layer -------------------------------------------------------
//
// MOUNTED BEFORE THE MODELS LOAD. preloadAssets pulls every model in the game
// and takes several seconds; a splash whose backdrop only appears after that is
// a splash that shows a flat colour for the part the player actually waits
// through. Same reasoning as the title card's push-in starting while the .riv
// is still parsing.
/**
 * Mount whatever `?spline` pointed at. Returns a one-line description for the
 * readout, so a scene that failed to arrive says so on screen instead of
 * looking like a scene that renders nothing.
 */
async function mountSpline(src) {
  if (!src) return '';

  // A MODEL, into this scene. No layer, no second context, no compromise on
  // the composite — from here on it is ordinary three.js content.
  if (splineIsModel) {
    const gltf = await new GLTFLoader().loadAsync(src);
    // Behind the seal in depth as well as in intent: the bust sits at z 0 with
    // its flank to the lens, so a backdrop belongs on the far side of it.
    gltf.scene.position.z = -2;
    scene.add(gltf.scene);
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(gltf.scene).getSize(size);
    // Printed, and compared against the frame in the readout, because it is the
    // number that decides whether anything is visible at all: this frame is
    // about 3.4 world units tall, and a scene authored at Spline's default
    // scale can arrive hundreds of units across — which renders as one flat
    // surface filling everything, or as nothing whatsoever.
    return `spline model — ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} units`;
  }

  // A LAYER, and now the pointer has to be given to one of them.
  if (/\.splinecode(\?|#|$)/i.test(src)) {
    // The runtime shares this document, so both can hear the same mouse: the
    // canvas stops hit-testing, Spline's canvas underneath receives the events,
    // and this page's listener is on `window`, which fires either way.
    stage.style.pointerEvents = 'none';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    splineEl.appendChild(canvas);
    // From a CDN rather than as a dependency: this is a scaffold, and
    // @splinetool/runtime is a megabyte of another renderer that the game has
    // no use for. `npm i @splinetool/runtime` and a static import here works
    // identically if it needs to run offline — pin the version either way.
    const url = 'https://unpkg.com/@splinetool/runtime/build/runtime.js';
    const mod = await import(/* @vite-ignore */ url);
    const app = new mod.Application(canvas);
    await app.load(src);
    window.spline = app; // emitEvent / setVariable, from the console
    return `spline runtime — ${src}`;
  }

  // AN IFRAME CANNOT SHARE THE POINTER. Events that land inside a cross-origin
  // frame stop there — they do not reach this document — so one of the two has
  // to be inert. The default is the embed: on a title screen the animal
  // following your cursor is the feature and the card behind it is scenery.
  // `?splineInput` flips it when the Spline scene is the interactive one, and
  // then the seal stops tracking anywhere the embed is under the cursor, which
  // is everywhere. Use the .splinecode route if you need both.
  const frame = document.createElement('iframe');
  frame.src = src;
  const inert = !q.has('splineInput');
  frame.style.cssText = `width:100%;height:100%;border:0;display:block;pointer-events:${inert ? 'none' : 'auto'};`;
  if (!inert) stage.style.pointerEvents = 'none';
  frame.setAttribute('allow', 'autoplay; fullscreen');
  splineEl.appendChild(frame);
  return `spline embed (iframe${inert ? ', inert — the seal keeps the cursor' : ', interactive — the seal cannot see the cursor'}) — ${src}`;
}

let splineState = splineSrc ? 'loading…' : '';
if (splineSrc) {
  // Awaited at the top level so the layer is up before the first frame — but
  // never fatal: a splash that cannot reach its backdrop should still be a
  // splash, and the reason belongs on screen.
  try {
    splineState = await mountSpline(splineSrc);
  } catch (err) {
    splineState = `spline FAILED — ${err?.message ?? err}`;
    console.error('[splash-bust] spline layer', err);
  }
}

await preloadAssets();

// THE SEAL'S OWN SURFACE, at the numbers the game actually runs.
//
// attachNoiseShader seeds its uniforms with build-time defaults when the
// material is made (during the preload above), and applyNoiseSettings is what
// pushes CONFIG.sealShader — including everything restored from saved tuning —
// over the top. main.js does it here for exactly the same reason, at the same
// point in the same order (after the preload, before the first createVisual).
//
// Without it this page was judging a DIFFERENT ANIMAL: the defaults are a soft
// blue-grey mottle at ten times the feature size the seal is tuned to, so a
// portrait composed on them was a fine-speckled seal in the run and a blotchy
// one on the title card. It is a portrait — the surface is most of what there
// is to look at.
//
// AND THE SAME IS TRUE OF EVERY OTHER LAYER OF THE SKIN. The noise is one of
// four shaders that attach at material-build time with their own defaults, and
// for a long time it was the only one pushed here — which left the toon
// terraces and the saved per-asset looks on whatever the constructors seeded,
// a flatter and paler animal than the run's. main.js runs all of these, in this
// order, at this point in its boot.
applySavedAssetLooks();
applyNoiseSettings();
applyToonSettings();
applyBiolumSkinSettings();

// --- the animal -------------------------------------------------------------
// A holder carrying the cant and the model under it carrying nothing. UPRIGHT
// IS THE DEFAULT: createVisual leaves a side-view creature nose-up with its
// flank to the lens (orientationQuaternion in assets.js), which is already a
// seal standing in profile — the game's faceMotion is what normally spins that
// to a heading, and a portrait simply never does.
const holder = new THREE.Object3D();
scene.add(holder);
const body = createVisual('ship');
holder.add(body);

const anim = createAnimationController(body);
const rig = createAimRig(body);
const pin = createBustPin(body);
attachPlayerOutline(body);
applyPlayerOutline();
// AFTER the shells exist — it reads their authored widths and scales from
// those, so building it earlier would find nothing and silently do nothing.
const rim = createBustOutline(body);
scene.add(createEyeLights());

const DT = 1 / 60;
// The seal's position for the grid's wake, and a velocity of zero: it is not
// swimming, and a wake that grows with speed would be reading a number this
// screen never sets.
const PLAYER_STILL = { x: 0, y: 0 };
const aim = new THREE.Vector2(0, 1);
const wantAim = new THREE.Vector2(0, 1);
const cursorWorld = new THREE.Vector3(0, 0, 0);
let pinned = true;
let auto = !q.has('cursor'); // autopilot until the pointer is actually moved

// How far off vertical the authored pose leaves the animal, measured once
// below. `lean` is a cant on top of it.
let plumb = 0;

/** One frame, in the order the game does it: clip, rig, pin, then the reads. */
function step(dt) {
  // The mixer first — the rig measures everything against "the pose the
  // animation wrote this frame", and the pin has to land on top of both.
  anim?.update(dt, 'idle', false);
  holder.rotation.z = plumb + cfg.lean;
  holder.updateMatrixWorld(true);

  aim.lerp(wantAim, 1 - Math.exp(-(cfg.aimLerp ?? 7) * dt));
  if (aim.lengthSq() > 1e-8) aim.normalize();
  rig?.update(dt, aim, { engaged: true });

  // ...and the pin LAST, because the aim rig's tail chain is a spring that
  // writes the very bones being held (see the note in splashBust.js).
  if (pinned) pin?.apply();
  holder.updateMatrixWorld(true);

  updateEyeLights(dt, rig, { lit: 1, charge: 0 });
  updatePlayerOutline(dt, 0);
}

// Settle before measuring anything: the rig eases in from zero weight, so the
// flippers are still folded on frame one and a pose measured there is a
// different animal.
for (let i = 0; i < 120; i++) step(DT);
// Stand it up, then settle again — the plumb moves the head, which moves the
// aim, which moves the head. One pass of that is enough; the correction it
// converges on is a fraction of a degree.
plumb = bustPlumb(pin, rig);
for (let i = 0; i < 60; i++) step(DT);

// Where the grid's wake sits — the animal's own middle, so the lattice dents
// around the seal the way it does around the player in a run.
const bustCentre = { x: 0, y: 0 };

// --- the crop ---------------------------------------------------------------
// Measured ONCE, on the settled pose. A box re-measured every frame breathes
// with the clip and the frame pumps with it.
const bust = measureBust(body, pin);
bustCentre.x = (bust.min.x + bust.max.x) / 2;
bustCentre.y = (bust.min.y + bust.max.y) / 2;

// --- the menu ---------------------------------------------------------------
// Three blobs over the crown. The labels are DOM rather than drawn into the
// canvas: this is a scaffold for a screen whose type will come from the game's
// own (ui/typography.js), and painting placeholder text into a shader is how a
// placeholder becomes permanent.
const menu = createHexMenu([
  { label: 'Play', onPress: () => (pressed = 'Play — begins the run') },
  { label: 'Options', onPress: () => (pressed = 'Options — the settings menu') },
  // TWO LINES, because one does not fit a cell. The break is in the label
  // rather than left to the browser: `Leader Boards` wrapped on width would
  // break differently the moment the type scale moves, and a title screen that
  // reflows its own buttons when someone drags a slider is not a design.
  { label: 'Leader\nBoards', onPress: () => (pressed = 'Leaderboards — the run table') },
]).layout(bust);
scene.add(menu.mesh);
// THE THREE CELLS THE BUTTONS LIVE IN DO NOT MOVE. Everything else on the
// lattice ripples; these are furniture. Pinned by the cell's HOME position and
// not by the button's live one — a tile can be dragged out of its cell and
// slung back, and the cell it belongs to should sit still the whole time.
//
// Held solid to the cell's own corner radius, easing back to normal a cell and
// a half out, so the lines that cross the boundary bend rather than tear.
const _pins = [];
function pinMenuCells() {
  _pins.length = 0;
  const R = menu.metrics.R;
  const feather = R * (cfg.menu.pinFeather ?? 2.2);
  for (const i of menu.items) {
    // The cell it belongs to, always — that hole in the lattice is the button's
    // address and it should sit still whether the button is home or not.
    _pins.push({ x: i.home.x, y: i.home.y, radius: R, feather });
    // ...and wherever it currently IS, once it has been dragged off. A pulled
    // tile travels over cells that are rippling under the cursor that is
    // pulling it, and a button sliding across a warped lattice reads as the
    // lattice being made of something softer than the button. Published every
    // frame, so the quiet patch travels with it.
    const moved = Math.hypot(i.world.x - i.home.x, i.world.y - i.home.y);
    if (moved > 1e-3) _pins.push({ x: i.world.x, y: i.world.y, radius: R, feather });
  }
  grid.pin(_pins);
}

// --- the lattice: THE GAME'S OWN GRID ---------------------------------------
//
// systems/grid.js, not a copy of it. That system already carries the thing a
// title screen wants from a grid — `ripple(x, y, strength, radius)` punches it
// and the shader decays the wave out and springs the lines back, on
// CONFIG.grid's own rippleDecay / rippleFreq / rippleWavelength / warpGain. A
// lattice drawn here would be a picture of a grid that nothing could disturb.
//
// TWO SETTINGS ARE OVERRIDDEN IN MEMORY, and only here. This page is a static
// build with no /__tuning endpoint behind it, so nothing it writes to CONFIG can
// reach the tuning file (see SERVERS.md) — but they are still the game's values
// and the reasons matter:
//
//   spacing        the arena is 80 units across and this crop is about six, so
//                  the shipped 2 puts three and a half cells on the whole
//                  screen and one button would be a third of it. The menu's own
//                  `latticeSpacing` is the splash's density, and the grid is set
//                  to the same figure so the buttons land on the drawn cells
//                  rather than near them.
//   clipAtSurface  the grid stops at the water line, and this bust is held well
//                  above it — left on, there is no lattice here at all.
CONFIG.grid.spacing = cfg.menu.latticeSpacing ?? CONFIG.grid.spacing;
CONFIG.grid.clipAtSurface = false;
CONFIG.grid.color = cfg.menu.latticeColor ?? CONFIG.grid.color;
CONFIG.grid.opacity = cfg.menu.latticeOpacity ?? CONFIG.grid.opacity;
// ...and the touch glow's own knocks, scaled DOWN for this screen. Those
// numbers are tuned against the arena's 2-unit lattice and a camera two hundred
// units wide; at this crop the same ripple covers twice as many cells and each
// one is a tenth of the screen, so the shipped strengths tear the grid apart on
// a press. Scaled rather than replaced, so retuning the game still moves this.
// THE SEAL DOES NOT DENT THE LATTICE HERE. In a run the wake is a gameplay
// read — the grid bulges around the player so you can find yourself in a
// crowded frame — and slot 0 of the wake list follows the ship every frame
// whether anyone asked for it or not. On a title card there is nothing to find:
// the animal is the subject, it fills the frame, and a permanent dent travelling
// with it just makes the grid look broken behind it. Zeroed rather than moved
// off screen, because the position is still what the grid is handed.
CONFIG.grid.wakeStrength = cfg.menu.sealWake ?? 0;

const touch = CONFIG.grid.touchGlow;
const punch = cfg.menu.touchPunch ?? 0.15;
touch.ripple = { ...touch.ripple, strength: (touch.ripple?.strength ?? 0) * punch };
touch.charge = { ...touch.charge, pulseStrength: (touch.charge?.pulseStrength ?? 0) * punch };
// THE HOVER GLOW'S SIZE AND ITS SHOVE, both scaled for this crop.
//
// The shipped radius is 4.5 WORLD units — a fingertip against an eighty-unit
// arena. This frame is about three and a half units tall, so the same halo is
// bigger than the picture: every cell on screen lights at once and it reads as
// the backdrop changing colour rather than as a glow following the cursor.
//
// `push` and `swirl` are the warp — the lattice bulging away from the finger
// and shearing around it — and they are in the same position: at this cell size
// they turn the neighbourhood into a blob. Scaled, not zeroed, because the
// movement is most of what makes the glow feel like it is touching something.
// `wave` and `spin` are left alone: they are shape and time, not amount.
touch.radius = cfg.menu.touchRadius ?? touch.radius;
// ...and how bright it is. The lattice is drawn at a sixth of the arena's
// opacity here (it is the floor of the picture, not part of it), and the glow
// is added on top of THAT — so the game's gain, which is plenty against a lit
// ocean, arrives as almost nothing. Raised for this screen rather than the
// lattice being brightened, which would light every cell instead of these ones.
touch.gain = cfg.menu.touchGain ?? touch.gain;
touch.alpha = cfg.menu.touchAlpha ?? touch.alpha;
const warpScale = cfg.menu.touchWarpScale ?? 1;
touch.push = (touch.push ?? 0) * warpScale;
touch.swirl = (touch.swirl ?? 0) * warpScale;
const grid = createGrid(scene);
grid.build();
// THE REAL PARTICLE SYSTEM, because the blobs squirt real goo. `emit` is a
// no-op until this has run — the buffers it fills are allocated here — so a
// menu built without it presses silently and looks like a dead button.
initParticles(scene);
// THE BUTTONS JOIN THE GOO. Their density twin is splatted into the same field
// the droplets are, so the threshold that finds the isoline fuses them — see
// registerGooField in systems/post.js. Only meaningful while the composite is
// running: with post bypassed (a Spline layer behind) the density pass never
// runs and the buttons simply keep their own surface.
post.registerGooField(menu.gooField, cfg.menu.source ?? 'aura');
let hovered = -1;
let pressed = '';

// THE GAME'S OWN TYPE. initTypography compiles CONFIG.textStyles into a
// stylesheet and loads whatever family the Text panel is set to, so the labels
// below are styled by the same role system every other string in the game goes
// through — `blobButton` in textRoles.js, which is also why they show up in the
// typography tool (npm run looks:type) to be laid out there rather than here.
initTypography();

const labels = menu.items.map((item) => {
  const el = document.createElement('div');
  // Two classes: the role's selector, which owns the TYPE, and the page's own,
  // which owns only where the thing sits. Keeping those apart is what stops a
  // scaffold's positioning hack from quietly becoming part of the design.
  el.className = 'sv-blob-label blob-label';
  el.textContent = item.label;
  document.body.appendChild(el);
  return el;
});

/** Where a blob's centre lands on screen, in CSS pixels. */
function placeLabels() {
  const [w, h] = viewport();
  menu.items.forEach((item, i) => {
    _project.copy(item.world).project(camera);
    labels[i].style.left = `${((_project.x + 1) / 2) * w}px`;
    labels[i].style.top = `${((1 - _project.y) / 2) * h}px`;
    // The label rides the blob's own swell, or the type stays put while the
    // thing it names grows under it and the two stop looking like one object.
    labels[i].style.transform = `translate(-50%, -50%) scale(${(item.radius / menu.radius).toFixed(3)})`;
    // The type arrives with its tile rather than before it — the flicker is the
    // button coming on, and a label already sitting there waiting undoes it.
    labels[i].style.opacity = menu.onLevel(i).toFixed(2);
    fitLabel(labels[i], item);
  });
}
const _project = new THREE.Vector3();

/**
 * SHRINK A LABEL UNTIL IT IS INSIDE ITS TILE, via the same `--sv-fit` the
 * upgrade cards use (fitCardText in ui/ui.js, and `fit: true` on the role).
 *
 * A hexagon is a narrow thing to put a word in: at the flats it is only 87% of
 * its width, and a label sized for PLAY leaves LEADER BOARDS hanging over both
 * edges. Measured against the cell rather than assumed, so it keeps holding
 * when the type scale is dragged in the typography tool.
 *
 * Measured ONCE per label and cached: this runs every frame, and reading
 * scrollWidth forces a layout — sixty of those a second for a string that never
 * changes is the kind of thing that quietly costs a title screen its framerate.
 */
const _fitted = new WeakMap();
function fitLabel(el, item) {
  const [w] = viewport();
  const pxPerUnit = w / (camera.right - camera.left);
  // The width available inside the hex at the label's own height — the flats,
  // not the points, minus a little air.
  const inner = menu.radius * 0.866 * 2 * pxPerUnit * (cfg.menu.labelFit ?? 0.82);
  const key = _fitted.get(el);
  if (key && key.inner === inner) return;
  el.style.setProperty('--sv-fit', '1');
  const natural = el.scrollWidth || 1;
  el.style.setProperty('--sv-fit', String(Math.min(1, inner / natural)));
  _fitted.set(el, { inner });
}

// CENTRING, and it has to be done in this order.
//
// The row cannot be centred by asking: it is snapped to lattice cells, so its
// middle lands wherever the nearest column happens to be — up to half a column
// off the animal it was composed against. Moving the row to fix that would take
// the buttons off the grid, which is the one thing they are.
//
// So the seal moves instead. The holder is ours (unlike the run's player, which
// resetPlayer would put straight back), the bust box was measured with it at
// zero, and shifting it by the difference puts the animal exactly under the row
// — after which the camera can centre on the pair of them and everything on
// screen shares one centre line.
const rowCentre = (menu.items[0].home.x + menu.items[menu.items.length - 1].home.x) / 2;
const bustCentreX = (bust.min.x + bust.max.x) / 2;
holder.position.x = rowCentre - bustCentreX;
bust.min.x += holder.position.x;
bust.max.x += holder.position.x;
bustCentre.x = rowCentre;
menu.items.forEach((i) => { /* the cells never moved; only the animal did */ });

function frame() {
  // innerWidth/innerHeight read 0 in a browser pane that has not been forced to
  // lay out yet, and a zero here is not a visible failure — it is a camera
  // fitted to a frame with no aspect, which renders something plausible and
  // wrong. Fall back to a normal window rather than trusting the zero.
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 720;
  // updateStyle LEFT ON. A canvas is a replaced element, so `position: fixed;
  // inset: 0` does not stretch it — with `width: auto` the intrinsic buffer
  // size wins, and a 2560-wide buffer then lays out 2560 CSS pixels wide inside
  // a 1280 pixel window, showing the top-left quarter of the render at double
  // size. It looks exactly like a camera zoomed too far in, which is the wrong
  // thing to go and fix.
  renderer.setSize(w, h);
  post.resize();
  fitBustCamera(camera, bust, w / h, cfg);

  // ...AND THEN MAKE ROOM FOR THE MENU. fitBustCamera composes on the animal
  // and knows nothing about what is above it, so at the shipped headroom the
  // blobs sit off the top of the frame — which looks exactly like a menu that
  // failed to render. Rather than asking whoever tunes `fill` to keep a second
  // number in their head, the frame GROWS to include the row: the top moves up
  // to clear it, the bottom stays where the crop wanted it, and the width
  // follows the aspect. The cost is that the animal is slightly smaller than
  // `fill` asked for whenever the menu is the taller thing, which is the honest
  // trade — the alternative is holding the size and cropping the buttons.
  // The flat top of the hex plus half a cell of air. `radius` is centre to
  // CORNER and the corners point sideways on a flat-top cell, so the height
  // above centre is the apothem — using the radius here would leave a visible
  // 13% of extra sky that nobody asked for.
  const needTop = menu.items[0].world.y + menu.radius * 0.866 + menu.metrics.rowStep * 0.5;
  if (needTop > camera.top) {
    const height = needTop - camera.bottom;
    const mid = (camera.left + camera.right) / 2;
    camera.top = needTop;
    camera.left = mid - (height * (w / h)) / 2;
    camera.right = mid + (height * (w / h)) / 2;
    camera.updateProjectionMatrix();
  }
  // The rim is asked for in screen pixels, so it is re-fitted with the frame:
  // the same world thickness is a different line on a different window.
  rim.fit((h * renderer.getPixelRatio()) / (camera.top - camera.bottom), cfg.outlinePx);
  // The cells never move with the frame, but the pin list is cheap and this is
  // the one place that runs after every layout — including the first.
  pinMenuCells();
}
frame();
window.addEventListener('resize', frame);

// --- the cursor -------------------------------------------------------------
// The pointer as a world point on the z=0 plane, then the direction from the
// HEAD to it — the same kind of vector `input.aim` hands the rig in a run, so
// the cone gate means the same thing here as it does there.
// The frame the camera was actually fitted to, which is NOT window.innerWidth:
// in the agent's browser pane that reads 0 until something forces layout, and a
// zero here does not throw — it puts the pointer somewhere out past the horizon
// and every "cursor over there" shot comes back as the same pose. The canvas
// carries the size frame() gave it, fallback included, so asking IT is the one
// question that cannot disagree with the projection.
function viewport() {
  const el = renderer.domElement;
  return [el.clientWidth || window.innerWidth || 1280, el.clientHeight || window.innerHeight || 720];
}

// The pointer in NDC as well as in the water. The grid's touch glow keeps its
// fingers in NDC and unprojects them itself, every frame — because in a run the
// camera moves and a world position cached at touchdown would slide out from
// under the finger. Feeding it world coordinates would work on this screen and
// break on the one that matters.
const cursorNdc = { x: 0, y: 0 };

function pointTo(clientX, clientY) {
  const [w, h] = viewport();
  cursorNdc.x = (clientX / w) * 2 - 1;
  cursorNdc.y = -(clientY / h) * 2 + 1;
  cursorWorld.set((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1, 0).unproject(camera);
  cursorWorld.z = 0;
  // The body's forward, which is straight up plus whatever the plumb and the
  // cant left it at — the angle every offset below is measured from.
  bustAim(rig, cursorWorld, wantAim, Math.PI / 2 + plumb + cfg.lean, cfg.aimSpread);
  // The same world point the seal is looking at is the one the buttons are
  // tested against — one projection, so the blob that lights up is always the
  // one under the cursor the animal is watching.
  hovered = menu.pick(cursorWorld);
}
// Which button is being held, and since when. A press that wanders off its
// button keeps its charge: letting go somewhere else is a cancel in most UIs,
// but this one is a wind-up you can feel building, and dropping it because the
// mouse drifted two pixels would read as the machine losing the input.
// A PRESS ANYWHERE, not only on a button. The first cut started a charge only
// when the pointer was over a hex, so pressing the water did nothing at all —
// which reads as the screen being dead rather than as a rule nobody stated.
// Empty water charges too; what it spends the charge on is the grid.
// Is there a pointer over the page at all? The glow needs somewhere to be, and
// a slot left live after the cursor has gone leaves a halo sitting in the water
// with nothing over it.
// Seconds until the next dribble from a press with no button under it.
let waterDrip = 0;
let pointerInside = false;
let pressing = false;
let pressIndex = -1; // the button under the press, or -1 for open water
const pressWorld = { x: 0, y: 0 };
// Seconds of holding, accumulated from the FRAME DELTA rather than read off
// performance.now(). A wall clock is the obvious way to time a press and it is
// wrong twice over: it charges while the tab is asleep, and it cannot be driven
// by anything that steps frames by hand — the whole charge was invisible to a
// probe stepping sixty frames in a millisecond, which reads as the feature
// being dead. Everything else in the game times off dt for the same reason.
let heldTime = 0;

/** 0..1 of the current press. */
function pressCharge() {
  return pressing ? Math.min(1, heldTime / Math.max(0.05, cfg.menu.chargeTime ?? 0.9)) : 0;
}

/**
 * THE POINTER AS A FINGER ON THE GRID.
 *
 * systems/grid.js already has everything a charged press wants from a backdrop
 * — a glow that grows with the wind-up, a knock when the touch lands, pulses
 * that come faster as the meter fills, another knock when it lifts — and all of
 * it is driven by `touchSlots` from input.js plus `charging`/`charge` on the
 * view. So the mouse is published as slot 0 rather than reimplemented: this
 * screen gets the game's own behaviour, and anything tuned in CONFIG.grid's
 * touchGlow block moves both at once.
 */
function feedTouch() {
  const slot = touchSlots[0];
  if (!slot) return;
  // LIVE WHENEVER THE POINTER IS OVER THE PAGE, not only while it is pressed.
  // The glow, its radius and its colour are CONFIG.grid.touchGlow's — the same
  // halo a finger leaves on the water in a run — and the charge terms in that
  // block (`grow`, `power`) are what make it swell while a press is held. So
  // hover and press are one behaviour with a weight, and the only thing this
  // has to decide is whether there is a pointer at all.
  slot.id = pointerInside ? 'splash-mouse' : null;
  slot.x = cursorNdc.x;
  slot.y = cursorNdc.y;
  // `charging` stays gated on the press: it is what tells the grid to pulse.
  slot.charging = pressing;
}

window.addEventListener('pointerdown', (e) => {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  pointTo(e.clientX, e.clientY);
  pressing = true;
  heldTime = 0;
  pressIndex = hovered;
  pressWorld.x = cursorWorld.x;
  pressWorld.y = cursorWorld.y;
  // A button squished bits out of itself; open water has nothing to squish.
  if (pressIndex >= 0) menu.press(pressIndex);
});

window.addEventListener('pointerup', (e) => {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  if (!pressing) return;
  const charge = pressCharge();
  const min = cfg.menu.chargeMin ?? 0.15;

  if (pressIndex >= 0) {
    const shot = menu.release(pressIndex);
    if (shot) {
      // The pull counts as well as the charge: a tile dragged a long way and
      // let go is a bigger event than one pressed in place, and the lattice
      // should hear the difference.
      const pullMul = 1 + (shot.pull / Math.max(0.05, cfg.menu.pullMax ?? 0.6)) * (cfg.menu.pullPunch ?? 1);
      // THE IMPULSE. The grid's own punch, at the button's own position — so
      // the wave leaves from under the thing that was pressed and the lattice
      // springs back on the game's numbers rather than on any easing here.
      grid.ripple(shot.x + shot.pullX, shot.y + shot.pullY, shot.strength * pullMul, shot.radius);
      pressed = `${shot.label} — charged ${(shot.charge * 100).toFixed(0)}%, pulled ${shot.pull.toFixed(2)}, `
        + `grid punched at ${(shot.strength * pullMul).toFixed(2)}`;
    } else {
      pressed = `${menu.items[pressIndex].label} — click`;
    }
  } else if (charge >= min) {
    // Open water. Same impulse, at the cursor — the lattice does not care what
    // was over it, and a title screen that only answers on three small targets
    // teaches you not to touch it.
    const strength = (cfg.menu.impulseStrength ?? 2.6) * charge;
    grid.ripple(pressWorld.x, pressWorld.y, strength, (cfg.menu.impulseRadius ?? 5) * (0.6 + 0.4 * charge));
    // ...and the same spray a button throws, from the water itself.
    emit(cfg.menu.burstGoo ?? 'menuGooBurst', cursorWorld.x, cursorWorld.y, { scale: 0.6 + charge * charge * 1.6 });
    emit(cfg.menu.burstBubbles ?? 'menuBubbleBurst', cursorWorld.x, cursorWorld.y, { scale: 0.6 + charge * charge * 1.6 });
    pressed = `water — charged ${(charge * 100).toFixed(0)}%, grid punched at ${strength.toFixed(2)}`;
  } else {
    pressed = 'water — click (nothing banked)';
  }

  pressing = false;
  pressIndex = -1;
  // Published one more time before the slot is dropped, so the grid sees the
  // LIFT and fires its own release knock (CONFIG.grid.touchGlow.ripple.liftScale)
  // rather than the glow simply vanishing.
  feedTouch();
});
window.addEventListener('pointerleave', () => { pointerInside = false; });
window.addEventListener('blur', () => { pointerInside = false; });

window.addEventListener('pointermove', (e) => {
  // Mouse only. A phone reports a touch as a pointer and the seal would spend
  // the splash staring at wherever the last tap landed.
  if (e.pointerType && e.pointerType !== 'mouse') return;
  auto = false;
  pointerInside = true;
  pointTo(e.clientX, e.clientY);
});

// AUTOPILOT — a slow sweep, on until the pointer moves. Not decoration: in the
// agent's browser pane there is no cursor to move, so without this every
// screenshot of this page would be the same frozen stare.
let clock = 0;
function autopilot(dt) {
  clock += dt;
  // Two incommensurate rates, so the head wanders instead of tracing a loop.
  // Written as a cursor rather than as an aim, so it goes through exactly the
  // mapping a real pointer does — an autopilot that wrote the aim directly
  // would be the one thing on the page not testing what ships.
  const [w, h] = viewport();
  pointerInside = true; // the autopilot IS a pointer as far as the glow cares
  pointTo(w * (0.5 + 0.42 * Math.sin(clock * 0.45)), h * (0.42 + 0.34 * Math.sin(clock * 0.31 + 1.2)));
}

// --- the knobs --------------------------------------------------------------
// Page-local, and they write CONFIG in memory only — this page has no save
// path at all, so the numbers below are read off the screen and typed into
// config.js by hand. That is deliberate: a look page that could write tuning is
// a look page that can lose someone's work.
const nudge = {
  '[': () => (cfg.fill = Math.max(0.2, cfg.fill - 0.02)),
  ']': () => (cfg.fill += 0.02),
  '-': () => (cfg.headroom -= 0.01),
  '=': () => (cfg.headroom += 0.01),
  ArrowLeft: () => (cfg.offsetX -= 0.01),
  ArrowRight: () => (cfg.offsetX += 0.01),
  ',': () => (cfg.lean -= 0.01),
  '.': () => (cfg.lean += 0.01),
  ';': () => (cfg.outlinePx = Math.max(0, cfg.outlinePx - 1)),
  "'": () => (cfg.outlinePx += 1),
  // The grid punch, live — it is the one number here whose right value is a
  // feel rather than a measurement, so it gets keys as well as a config entry.
  g: () => (cfg.menu.impulseStrength = Math.max(0, +(cfg.menu.impulseStrength - 0.02).toFixed(3))),
  h: () => (cfg.menu.impulseStrength = +(cfg.menu.impulseStrength + 0.02).toFixed(3)),
  '9': () => (cfg.aimSpread = Math.max(0, cfg.aimSpread - 0.05)),
  '0': () => (cfg.aimSpread = Math.min(1, cfg.aimSpread + 0.05)),
};
/** The numbers this page owns, as they stand. */
function preset() {
  const out = { menu: {} };
  for (const k of LOCKABLE) out[k] = cfg[k];
  for (const k of LOCKABLE_MENU) out.menu[k] = cfg.menu[k];
  return out;
}

async function writePreset() {
  const body = JSON.stringify(preset(), null, 2);
  try {
    const r = await fetch('/preset/splash-bust.json', { method: 'POST', body });
    savedNote = r.ok ? 'saved to tools/looks/splash-bust.json — reloads keep it' : `save failed (${r.status})`;
  } catch (err) {
    savedNote = `save failed — ${err.message}`;
  }
  locked = true;
  // Also on the console, because a file on disk is the record and a paste is
  // what actually reaches the game.
  console.log('[splash-bust] CONFIG.splashBust:\n' + body);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'l') { locked = !locked; savedNote = locked ? 'keys LOCKED' : 'keys unlocked'; return; }
  // SHIFT+W, not w. Every other key here nudges a number that a reload undoes;
  // this one writes a file into the repo, and the browser pane has delivered
  // enough stray keystrokes this session to save my own probe values three
  // times. A destructive key wants a modifier.
  if (e.key === 'W') { writePreset(); return; }
  // Every nudge below is gated, which is the point of the lock: the handlers
  // are on `window` and a stray keystroke is otherwise a silent edit.
  if (locked) return;
  if (nudge[e.key]) { nudge[e.key](); frame(); e.preventDefault(); return; }
  if (e.key === 'p') { pinned = !pinned; if (!pinned) pin?.release(); }
  if (e.key === 'a') auto = !auto;
  if (e.key === 's') shoot(`bust-${Date.now()}`);
});

/**
 * Post the current frame to the look server's drop box, so it can be read off
 * disk. The pane's own screenshot is the other way to see this page; this one
 * survives a pane that is 0x0 until something forces layout.
 */
function shoot(name) {
  stage.toBlob((blob) => fetch(`/shot/${name}.png`, { method: 'POST', body: blob }), 'image/png');
}

// Handles for poking at the page from a console — and from the agent's
// javascript_tool, which is the only way to steer it in a browser pane that has
// no cursor to move. Nothing in the page reads these back.
window.bust = {
  scene, camera, renderer, post, body, rig, pin, rim, menu, cfg, step, shoot, frame,
  aim: wantAim, box: () => bust,
  // ONE WHOLE FRAME, on demand. The pane throttles the loop to about a frame a
  // second (it reports document.hidden), so anything with a decay measured in
  // fractions of a second — the squish, a burst of goo — is over before the
  // next real tick. Driving this from the console steps the same code the loop
  // does, which is the only way to catch one of those mid-flight.
  frameOnce: (dt = 1 / 60, hoveredIndex = hovered) => frameBody(dt, hoveredIndex),
  grid,
  press: (i) => menu.press(i),
};

// --- the loop ---------------------------------------------------------------

/**
 * ONE FRAME, in the order the game does it. Split out from the loop because the
 * agent's browser pane throttles it to about a frame a second (it reports
 * document.hidden), so anything with a decay measured in fractions of a second
 * — the squish, a burst, a charge being held — is over before the next real
 * tick. Everything that advances state lives here and nowhere else, or a probe
 * driving this by hand quietly skips whichever step stayed behind in the loop.
 */
function frameBody(dt, hoveredIndex) {
  if (pressing) {
    heldTime += dt;
    if (pressIndex >= 0) {
      menu.hold(pressIndex, heldTime, cursorWorld);
    } else {
      // OPEN WATER CHARGES TOO, and it should look like it. A press with
      // nothing under it has no tile to leak from, so the goo comes off the
      // cursor itself — the same emitter at the same rate, thrown outward from
      // the point being pressed.
      waterDrip -= dt * pressCharge() * (cfg.menu.chargeLeak ?? 2.5);
      if (waterDrip <= 0) {
        waterDrip = 1 / Math.max(0.1, cfg.menu.dripRate ?? 5.5);
        const a = Math.random() * Math.PI * 2;
        emit(cfg.menu.dripGoo ?? 'menuGoo', cursorWorld.x, cursorWorld.y, { dirX: Math.cos(a), dirY: Math.sin(a) });
        if (Math.sin(a) > -0.2) {
          emit(cfg.menu.dripBubbles ?? 'menuBubbles', cursorWorld.x, cursorWorld.y, { dirX: Math.cos(a), dirY: Math.abs(Math.sin(a)) });
        }
      }
    }
  }
  step(dt);
  menu.update(dt, hoveredIndex, cursorWorld);
  // The grid, ticked like the game ticks it: the bust is what it takes for the
  // wake, the camera is what the touch glow resolves fingers through, and
  // `charging`/`charge` are what make the wind-up pulse.
  feedTouch();
  // The pins move with the buttons now, so this is per-frame rather than
  // per-layout: six vec4 writes, against a lattice of a hundred thousand
  // vertices that would otherwise ripple out from under a tile mid-drag.
  pinMenuCells();
  const charge = pressCharge();
  grid.update(dt, bustCentre, PLAYER_STILL, { camera, charging: pressing, charge });
  updateParticles(dt);
  // Sprites are sized in SCREEN pixels, so they have to be told what the frame
  // is worth in world units — without this every bubble comes out at the size
  // the last page to touch the material left it at.
  updateParticleScale(camera, renderer);
  placeLabels();
  // Straight to the screen whenever something is layered behind: post.js's
  // final pass is opaque and would hide it. See the note at the top.
  if (wantPost) post.render(scene, camera, dt);
  else renderer.render(scene, camera);
}

let last = performance.now();
function tick(now) {
  // Real elapsed time, clamped: the shimmed rAF above is a setTimeout, and a
  // pane that has been asleep hands back a delta of several seconds, which
  // would teleport the eased aim rather than sweep it.
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (auto) autopilot(dt);
  frameBody(dt, hovered);

  splineNote.textContent = splineState
    ? `${splineState}`
      + (splineIsModel ? `  ·  frame is ${(camera.top - camera.bottom).toFixed(1)} units tall` : '')
      + (wantPost ? '' : '  ·  composite OFF so the layer shows through — and the menu goo with it, bubbles only')
    : '';
  lockEl.textContent = `${locked ? '● LOCKED' : '○ live'}${savedNote ? ` — ${savedNote}` : ''}`;
  lockEl.style.color = locked ? '#7fe6a0' : '#ffc65a';
  stateEl.innerHTML = pinned
    ? `waist <b>pinned</b> at <b>${cfg.pinFrom}</b> — tail and hind flippers held, chest still breathing`
    : `waist <b>free</b> — the clip has the whole body back`;
  valsEl.textContent =
    `fill ${cfg.fill.toFixed(2)}   headroom ${cfg.headroom.toFixed(2)}   `
    + `offsetX ${cfg.offsetX.toFixed(2)}   lean ${cfg.lean.toFixed(2)}\n`
    + `outlinePx ${cfg.outlinePx.toFixed(1)}   aimSpread ${cfg.aimSpread.toFixed(2)}   `
    + `punch ${cfg.menu.impulseStrength.toFixed(2)}   `
    + `plumb ${plumb.toFixed(2)} rad (measured)\n`
    + `menu ${hovered >= 0 ? menu.items[hovered].label : '—'}   `
    + `cells ${menu.items.map((i) => `${i.cell.col},${i.cell.row}`).join('  ')}`
    + `${pressing ? `   charging ${(pressCharge() * 100).toFixed(0)}% ${pressIndex >= 0 ? 'on ' + menu.items[pressIndex].label : 'in open water'}` : ''}`
    + `${pressed ? `   ${pressed}` : ''}\n`
    + `bust ${(bust.max.y - bust.min.y).toFixed(2)} x ${(bust.max.x - bust.min.x).toFixed(2)} world units   `
    + `aim ${aim.x.toFixed(2)}, ${aim.y.toFixed(2)}   glance ${(rig?.glance ?? 0).toFixed(2)}`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// A contact sheet on demand: `?shots` settles a handful of aim directions and
// posts each as a PNG, which is how these frames get looked at without a live
// cursor. It leaves the page running afterwards.
if (q.has('shots')) {
  // CURSOR POSITIONS, not aim vectors — the whole question this page answers is
  // what the head does when the pointer is over there, and a shot that wrote
  // the aim directly would skip the mapping (`aimSpread`) that decides it.
  const spots = [
    ['top-left', 0.12, 0.08],
    ['top-right', 0.9, 0.1],
    ['mid-right', 0.95, 0.5],
    ['bottom-right', 0.88, 0.92],
  ];
  auto = false;
  const [w, h] = viewport();
  for (const [name, fx, fy] of spots) {
    pointTo(w * fx, h * fy);
    aim.copy(wantAim);
    for (let i = 0; i < 90; i++) step(DT);
    if (wantPost) post.render(scene, camera, DT); else renderer.render(scene, camera);
    shoot(`cursor-${name}`);
    await new Promise((r) => setTimeout(r, 120));
  }
  stateEl.textContent = 'shots posted';
}
