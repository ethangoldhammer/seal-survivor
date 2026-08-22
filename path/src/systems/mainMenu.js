// ---------------------------------------------------------------------------
// THE MAIN MENU — the seal held up in profile with the game's own hex buttons
// over its crown, and the screen every run now starts from.
//
// WHERE IT SITS IN THE BOOT. The Rive splash is the NAME SCREEN and nothing
// else: you type a name, the artboard fires `tStart`, and what used to be "the
// run begins" is "this screen arrives" (see showStartMenu in ui/ui.js). The
// splash is shown once per page load — coming back here later must never ask
// for the name again — so this is the hub and the card is the front door.
//
// ---------------------------------------------------------------------------
// IT IS IN THE ARENA. NOT A SCREEN IN FRONT OF IT.
//
// The first version of this file built a scene of its own — its own lights, its
// own flat backdrop, its own copy of the seal — and rendered it through the
// game's post stack in place of the world. It looked right, and it could never
// do the one thing this screen is for: Play was a CUT. One frame of a portrait,
// then one frame of an ocean, with nothing carrying the player between them.
//
// So there is no menu scene. The animal is the RUN'S SEAL (entities/player.js),
// standing at the exact spot the run will start it, in the arena, with the
// arena's water and weather and light on it. The menu is three things laid over
// that: a claim on the camera, a pose held on the body, and a row of buttons.
// Every one of them is a WEIGHT that eases to zero, so pressing Play does not
// change what is being drawn — it starts the run underneath and lets the shot
// open out into it. See `release`.
//
// THE ZOOM IS GEOMETRIC, not linear. The menu frames about three units of water
// and the run frames about fifty, so the claim is a factor of fifteen; eased
// linearly, five sixths of that distance is spent in the first third of the
// glide and the shot reads as a slam followed by a drift. `zoom = Z^weight`
// makes every moment of the pull the same proportional rate, which is what a
// dolly looks like.
//
// ---------------------------------------------------------------------------
// WHAT IT BORROWS AND HANDS BACK. Three things, and each fails quietly if the
// hand-back is skipped:
//
//   the body's pose    the bust stands the seal upright and pins its waist.
//                      Written AFTER the mixer and the aim rig every frame (the
//                      pin exists because the rig's tail spring writes the very
//                      bones being held), and SLERPED out by the weight — so
//                      the animal turns into a swimming seal over the same
//                      second the camera pulls back, rather than snapping to a
//                      heading the moment the run owns it again.
//   the rim's width    CONFIG.splashBust.outlinePx is a SCREEN measure and the
//                      run's rim is a world one. Both are computed every frame
//                      and mixed by the weight, so at weight 0 the seal is
//                      wearing exactly the rim the run authored — the one part
//                      of this that cannot be got right by simply stopping.
//   CONFIG.grid        the menu's lattice is denser and paler than the arena's,
//                      the cursor's glow on it is smaller and brighter, a press
//                      shoves it a fraction as hard, and the seal does not dent
//                      it at all — one composition, at a sixth of the cell size
//                      and a fifteenth of the view (CONFIG.splashBust.menu).
//                      grid.js re-reads CONFIG every frame, so the overrides
//                      are pushed and popped AROUND each call rather than
//                      written and left: the tuner can snapshot CONFIG at any
//                      moment, and a menu that had edited it would ship its own
//                      numbers to the arena and to whatever got saved next.
//                      The seal's wake is the exception and goes in by hand
//                      (see wakeFor), because the ARENA's lattice needs it too
//                      and main.js ticks that one before this file is called.
//   the water's light  the caustics are the arena's, at this crop: `punched in`
//                      magnifies the veins into blobs and the depth fade eats
//                      what is left, so both the intensity and the density are
//                      multiplied while the menu holds the frame and eased back
//                      as the shot opens out. See setCausticsPunch in water.js.
//
// The particle system is NOT borrowed any more, and that is the dividend of
// living in the world: the goo a button lets go of is emitted into the same
// buffer the run uses, drawn by the same pass, in the same water.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { setOutlineThicknessOn } from '../assets.js';
import { ease } from '../ease.js';
import { applyPlayerOutline } from './outlines.js';
import { bustAim, bustPlumb, createBustPin, measureBust } from './splashBust.js';
import { cineEnabled, cineMenu } from './cineCamera.js';
import { createHexMenu } from './hexMenu.js';
import { createGrid } from './grid.js';
import { setCausticsPunch } from './water.js';
import { stateForSpeed } from './animation.js';
import { menuInput, touchSlots } from '../input.js';
import { feedback } from './feedback.js';

// The live menu, or null. One at a time by construction — it holds a pose on
// the one seal there is.
let live = null;

/** Is a menu up or gliding out? Anything reading the frame wants this. */
export function mainMenuActive() {
  return !!live;
}

/**
 * Is the menu still HELD — the buttons up, waiting for a press?
 *
 * Deliberately not `mainMenuActive()`. The glide runs over a run that has
 * already begun, and from that moment updatePlayer owns the aim rig and the
 * body; this is what the rest of the frame asks to know whether the menu is
 * still the thing in charge. Same split, for the same reason, as
 * titleSealEngaged.
 */
export function mainMenuEngaged() {
  return !!live && (live.phase === 'in' || live.phase === 'held');
}

/**
 * The aim the RIG should be solving while the menu owns it — the cursor
 * remapped through the bust's own spread (see bustAim), which is not the vector
 * `input.aim` holds. Null when the menu is not engaged, so the caller falls
 * back to the run's aim with `??`.
 */
export function mainMenuAim() {
  return mainMenuEngaged() ? live.aim : null;
}

/** The live menu's handle, or null. */
export function mainMenu() {
  return live?.handle ?? null;
}

/**
 * WHAT THE MENU ASKS OF THE ARENA'S OWN LATTICE — `{ wake, fade }`, or null on
 * every frame there is no menu, which leaves CONFIG in charge.
 *
 * Spread into the view object main.js hands world.grid.update, the same way the
 * camera and the strike meter are handed in, because the arena's grid is ticked
 * well before this file gets the frame: there is nothing here to push CONFIG
 * around, the way the menu's own lattice is driven.
 *
 * TWO THINGS, and both are about the same fact — the menu draws a lattice of
 * its own and the arena's is still there underneath it, six units across
 * against the menu's one.
 *
 *   fade  ONE GRID ON SCREEN, NOT TWO. The arena's cell is bigger than the
 *         whole menu frame at this zoom, so its lines land as a pair of huge
 *         bright strokes across a screen composed on a fine one — two lattices
 *         at different sizes and different colours, which reads as a mistake
 *         because it is one. So the arena's is held down while the menu is up
 *         and brought back as the shot opens out, and the crossfade is what
 *         "the fine grid resolves into the one the run is played on" actually
 *         needs to be. `menu.arenaLattice` is how much of it survives while
 *         the screen is held — 0 by default, which is a clean crossfade.
 *   wake  the seal's dent, tuned for a fifty-unit view: the radius is wider
 *         than this whole frame, so left alone it pulls every node on screen
 *         toward the animal and the backdrop becomes a web. See wakeFor.
 */
export function mainMenuGrid() {
  return live ? live.gridView() : null;
}

/**
 * Put the menu up.
 *
 * The caller is expected to have put the seal where the run will start it
 * (resetPlayer) FIRST: everything below is measured against where it stands,
 * and a seal that moved between here and Play would take the framing with it.
 *
 * @param world  the game's world (world.js) — scene, camera, renderer,
 *               focusCamera, halfExtents, grid. The claim goes through
 *               focusCamera exactly like the death dive's and the boss kill
 *               shot's, so nothing has to remember to release it: a shot that
 *               stops claiming stops being framed.
 * @param seal   entities/player.js's `player`. Its body is posed, its rig is
 *               read, its outline is re-fitted.
 * @param root   the UI layer the labels go into (uiRoot()).
 * @param items  `[{ label, onPress }]`, left to right. WHAT THE BUTTONS DO
 *               belongs to whoever mounts them — this file knows how a button
 *               feels and nothing about what it opens.
 */
export function mountMainMenu({ world, seal, root, items = [] }) {
  if (live) return live.handle;
  const cfg = CONFIG.splashBust ?? {};
  const menuCfg = cfg.menu ?? {};
  const body = seal?.body;
  if (!world || !body) {
    console.warn('[mainMenu] no world or no seal — the menu cannot be put up.');
    return null;
  }

  const camera = world.camera;
  const scene = world.scene;
  const rig = seal.aimRig;
  const pin = createBustPin(body);

  const _z = new THREE.Vector3(0, 0, 1);
  const _focus = { x: 0, y: 0 };
  const _bustQuat = new THREE.Quaternion();
  const _project = new THREE.Vector3();
  // The seal is not swimming, so the lattice's wake has no speed to read.
  const _still = { x: 0, y: 0 };

  // --- settling, so the crop is measured on a pose that has stopped moving ---
  // The rig eases in from zero weight, so on frame one the flippers are still
  // folded and a box measured there is a different animal. Then the plumb is
  // measured (the authored idle curls the spine some twenty degrees off
  // vertical, so a cant applied to the raw model is a cant applied to nothing
  // known) and it settles again, because standing the animal up moves the head,
  // which moves the aim, which moves the head.
  //
  // Run on the SEAL'S OWN controller rather than a private copy: this is the
  // animal that will be on screen, and settling anything else would compose a
  // crop for a pose nobody sees.
  const DT = 1 / 60;
  const aim = new THREE.Vector2(0, 1);
  const wantAim = new THREE.Vector2(0, 1);
  const cursorWorld = new THREE.Vector3();
  const idleState = stateForSpeed(0, false);
  let plumb = 0;

  function poseStep(dt) {
    seal.anim?.update(dt, idleState, false);
    body.quaternion.setFromAxisAngle(_z, plumb + (cfg.lean ?? 0));
    body.updateMatrixWorld(true);
    aim.lerp(wantAim, 1 - Math.exp(-(cfg.aimLerp ?? 7) * dt));
    if (aim.lengthSq() > 1e-8) aim.normalize();
    rig?.update(dt, aim, { engaged: true });
    // ...and the pin LAST, because the rig's tail chain is a spring that writes
    // the very bones being held (see the note in splashBust.js).
    pin?.apply();
    body.updateMatrixWorld(true);
  }

  for (let i = 0; i < 120; i++) poseStep(DT);
  plumb = bustPlumb(pin, rig);
  for (let i = 0; i < 60; i++) poseStep(DT);

  // The crop, measured ONCE on the settled pose. A box re-measured every frame
  // breathes with the clip, and a frame fitted to a breathing box pumps.
  const bust = measureBust(body, pin);

  // --- the buttons ----------------------------------------------------------
  //
  // THE CALLBACK IS DEFERRED BY ONE MICROTASK, and that is not a style choice.
  // A button's own press starts the glide (Play calls startGame), and
  // hexMenu.release fires the callback BEFORE it spends the release: the goo
  // burst and the grid punch come after it. Called straight through, those two
  // would land on a screen that had already handed the frame over.
  //
  // A microtask, not a timeout or a frame: it drains at the end of the same
  // task, so the gesture is still the same gesture — an AudioContext built
  // inside startGame still counts as user-initiated — and nothing renders in
  // between. The press simply finishes before the shot opens out.
  const deferred = items.map((item) => ({
    ...item,
    onPress: item.onPress
      ? (...args) => queueMicrotask(() => item.onPress(...args))
      : null,
  }));
  const menu = createHexMenu(deferred, menuCfg).layout(bust);
  scene.add(menu.mesh);

  // --- the lattice ----------------------------------------------------------
  // A SECOND grid, in the arena, at the menu's own density. The arena's own is
  // two units across and this frame is about six wide — three cells on the
  // whole screen, which is a pair of lines rather than a lattice. This one is
  // the density the screen was composed at, and it fades with everything else,
  // so what is left at the end of the glide is the arena's own: the fine grid
  // resolves into the one the run is played on.
  //
  // The overrides are held for the length of a call and no longer — see the
  // note at the top of the file.
  const gridOverrides = {
    spacing: menuCfg.latticeSpacing ?? CONFIG.grid.spacing,
    color: menuCfg.latticeColor ?? CONFIG.grid.color,
    opacity: menuCfg.latticeOpacity ?? CONFIG.grid.opacity,
  };

  // --- and the rest of what the density change drags with it ----------------
  //
  // THE GRID IS MORE THAN THREE NUMBERS. Everything else CONFIG.grid holds —
  // how hard the seal dents the field, how wide the cursor's glow is, how much
  // a knock shoves — is authored against a fifty-unit view and a two-unit cell.
  // This screen is a six-unit view and a one-unit cell, so the same numbers
  // arrive between six and fifteen times too big and the lattice stops reading
  // as a lattice: the hover glow lights the whole frame at once, a press tears
  // the grid apart, and the seal's own wake drags every node on screen toward
  // one point.
  //
  // The screen's own figures were chosen on the tuning page (`npm run
  // looks:bust`, tools/looks/splash-bust.js, which applies exactly this set)
  // and they SHIP in CONFIG.splashBust.menu. This is where they get applied to
  // the game, which for a while they were not: only the three above crossed
  // over, and the menu was drawing the composed lattice with the arena's
  // physics on top of it.
  //
  // SCALINGS, NOT REPLACEMENTS, wherever the arena has an opinion worth
  // keeping — `touchPunch` and `touchWarpScale` are fractions of the game's own
  // numbers, so retuning the game still moves the menu.
  //
  // Derived on every call rather than captured at mount, for that same reason:
  // a tuner edit to CONFIG.grid.touchGlow has to reach this screen while it is
  // up, or the panel is lying about what it is editing.
  const menuTouch = {};
  const menuTouchRipple = {};
  const menuTouchCharge = {};
  function touchGlowForMenu() {
    const t = CONFIG.grid.touchGlow ?? {};
    const punch = menuCfg.touchPunch ?? 1;
    const warp = menuCfg.touchWarpScale ?? 1;
    // `wave` and `spin` are deliberately left alone: they are shape and time,
    // not amount, and neither has a scale to be wrong about.
    return Object.assign(menuTouch, t, {
      radius: menuCfg.touchRadius ?? t.radius,
      gain: menuCfg.touchGain ?? t.gain,
      alpha: menuCfg.touchAlpha ?? t.alpha,
      push: (t.push ?? 0) * warp,
      swirl: (t.swirl ?? 0) * warp,
      ripple: Object.assign(menuTouchRipple, t.ripple, {
        strength: (t.ripple?.strength ?? 0) * punch,
      }),
      charge: Object.assign(menuTouchCharge, t.charge, {
        pulseStrength: (t.charge?.pulseStrength ?? 0) * punch,
      }),
    });
  }

  /**
   * HOW HARD THE SEAL DENTS THE LATTICE, this frame.
   *
   * Handed to grid.update as `view.wake` rather than pushed through CONFIG,
   * because the ARENA's grid needs it too and that one is ticked by main.js,
   * outside anything this file can push and pop around (see mainMenuWake).
   *
   * Blended by the weight, so the dent is not switched back on: it grows from
   * the screen's `sealWake` to the run's own strength over the same second the
   * camera pulls out, which is the moment it starts being a gameplay read
   * again.
   */
  function wakeFor(w) {
    const held = menuCfg.sealWake ?? 0;
    return CONFIG.grid.wakeStrength + (held - CONFIG.grid.wakeStrength) * w;
  }

  /** Run `fn` with the menu's grid settings in place, then put CONFIG back. */
  function withMenuGrid(fn, fade = 1) {
    const stash = {};
    for (const k of Object.keys(gridOverrides)) {
      stash[k] = CONFIG.grid[k];
      CONFIG.grid[k] = k === 'opacity' ? gridOverrides[k] * fade : gridOverrides[k];
    }
    const stashTouch = CONFIG.grid.touchGlow;
    CONFIG.grid.touchGlow = touchGlowForMenu();
    try {
      return fn();
    } finally {
      for (const k of Object.keys(stash)) CONFIG.grid[k] = stash[k];
      CONFIG.grid.touchGlow = stashTouch;
    }
  }

  const grid = createGrid(scene);
  withMenuGrid(() => grid.build());

  // --- the cells the buttons live in ----------------------------------------
  // THREE CELLS OF THIS LATTICE ARE FURNITURE. Everything else ripples; these
  // do not move at all, because a button whose cell drifts out from under it
  // stops being part of the grid and starts being a tile lying on top of one —
  // which is the entire difference this screen is built on.
  //
  // Pinned by the cell's HOME position, and by wherever the tile currently IS
  // once it has been dragged off it: a pulled button travels over cells that
  // are rippling under the cursor doing the pulling, and a tile sliding across
  // a warped lattice reads as the lattice being made of something softer than
  // the button. Published every frame, so the quiet patch travels with it.
  const _pins = [];
  function menuPins() {
    _pins.length = 0;
    const R = menu.metrics.R;
    const feather = R * (menuCfg.pinFeather ?? 2.2);
    for (const item of menu.items) {
      _pins.push({ x: item.home.x, y: item.home.y, radius: R, feather });
      const moved = Math.hypot(item.world.x - item.home.x, item.world.y - item.home.y);
      if (moved > 1e-3) _pins.push({ x: item.world.x, y: item.world.y, radius: R, feather });
    }
    return _pins;
  }

  // --- the scrim ------------------------------------------------------------
  // THE ONE THING THE ARENA COSTS THIS SCREEN. At fifteen times the run's zoom
  // the frame is a wide flat field of lit water, and everything the menu is
  // made of was composed against a dark card: the buttons are a fresnel film
  // with a core alpha of 0.16, and the rim is one pixel. On a bright ground
  // both simply go.
  //
  // So the water is held down while the menu is up, and let back up as the shot
  // leaves — which is the second half of what this is for. The ocean brightens
  // as the camera pulls out, so the menu going and the arena arriving are one
  // movement instead of two.
  //
  // BEHIND THE LATTICE, IN FRONT OF THE BACKDROP. The arena's grid sits at
  // z -4.5 and its depth lines at -5 (see world.js and grid.js), so -4.6 dims
  // the water and the far markings without touching either lattice — the grid
  // is the part of the arena this screen wants kept.
  //
  // depthTest ON and depthWrite OFF: the seal is opaque and has already written
  // depth by the time this is drawn, so the animal punches its own hole in the
  // scrim rather than being painted over by it — which is what a transparent
  // object with the test switched off would do, whatever its renderOrder says.
  const scrim = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(cfg.scrimColor ?? 0x04080f),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // Never tone-mapped and never lit: this is a piece of ink, not a surface
      // in the water, and either one would make its density a function of the
      // time of day.
      toneMapped: false,
      fog: false,
    }),
  );
  scrim.position.z = -4.6;
  scrim.frustumCulled = false;
  scrim.visible = false;
  scene.add(scrim);

  /**
   * Cover the frame, wherever the camera has got to this frame.
   *
   * NOT `camera.position` — the arena's frustum is ASYMMETRIC (world.js offsets
   * it so the water line lands at a fixed fraction of the view), so the camera
   * sits well below the middle of its own picture and a quad parked on it hangs
   * off the bottom of the screen. three keeps `left/right/top/bottom` as
   * authored and scales the frustum about their centre, so that centre is the
   * frame's middle at any zoom.
   */
  function fitScrim(w) {
    const want = (cfg.scrim ?? 0) * w;
    scrim.visible = want > 0.002;
    if (!scrim.visible) return;
    scrim.material.opacity = want;
    const half = world.halfExtents(camera.zoom);
    // A generous margin, because the camera keeps moving between this and the
    // draw — the focus claim is consumed later in the frame — and an edge of
    // undimmed water sliding in reads as a seam in the picture.
    scrim.scale.set(half.w * 3, half.h * 3, 1);
    scrim.position.x = camera.position.x + (camera.left + camera.right) / 2;
    scrim.position.y = camera.position.y + (camera.top + camera.bottom) / 2;
  }

  // --- the rim --------------------------------------------------------------
  // createBustOutline's walk, plus the one thing a transition needs that it
  // cannot do: the RUN's width, captured before anything is written, so the two
  // can be mixed. `outlinePx` is a screen measure — a line at any window size,
  // which is what a portrait wants — and CONFIG.playerOutline.thickness is a
  // world one. Fading the first out is not the same as fading the second in,
  // and at weight 0 the seal has to be wearing exactly what the run authored.
  const shells = [];
  body.traverse((o) => {
    if (!/__outline/.test(o.name ?? '')) return;
    const u = o.material?.userData?.__outlineThickness;
    if (u) shells.push({ material: o.material, base: u.value, run: u.value });
  });
  const widest = shells.reduce((m, s) => Math.max(m, s.base), 0) || 1;

  /**
   * @param w          1 while the menu is up, 0 once the run owns the frame.
   * @param pxPerUnit  screen pixels per world unit in the frame as it stands.
   */
  function fitRim(w, pxPerUnit) {
    if (!shells.length || !(pxPerUnit > 0)) return;
    const px = cfg.outlinePx ?? 1;
    for (const s of shells) {
      // The widest shell is the one the pixel figure is about; the thinner ink
      // line rides in at its own share of it, so the lit fringe between them
      // keeps its proportion.
      const bustWidth = (s.base / widest) * (px / pxPerUnit);
      setOutlineThicknessOn(s.material, s.run + (bustWidth - s.run) * w);
    }
  }

  // --- the labels -----------------------------------------------------------
  // DOM rather than painted into the shader, so they go through the game's own
  // type: `blobButton` in textRoles.js, compiled by ui/typography.js at boot.
  // The wrapper owns POSITION only — every question about the type is answered
  // by the role's class beside it.
  const labelLayer = document.createElement('div');
  labelLayer.className = 'sv-menu-labels';
  // UNDER EVERY PANEL THIS SCREEN OPENS. These labels belong to the buttons —
  // they are the hexagons' own text, drawn in the DOM only because the type
  // system lives there — so anything the buttons OPEN is in front of them:
  // Options and the Leaderboard are `.sv-center` surfaces at z-index 8 (see
  // ui/ui.js), and at 6 the words "Play" and "Leaderboard" floated over the
  // panel that had just been asked for. Below those, above nothing that is up
  // while the menu is: the HUD is hidden here and the hive is not built yet.
  labelLayer.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:3;';
  (root ?? document.body).appendChild(labelLayer);

  const labels = menu.items.map((item) => {
    const node = document.createElement('div');
    node.className = 'sv-blob-label';
    node.style.cssText = 'position:absolute; transform:translate(-50%,-50%); white-space:nowrap;';
    node.textContent = item.label;
    labelLayer.appendChild(node);
    return node;
  });

  // How much each label has to be shrunk to stay inside its own hexagon, 1 when
  // it already does — see fitLabels. And how wide it wants to be unscaled,
  // measured rather than estimated: the type is whatever the Text panel has the
  // `blobButton` role set to, and a character count is not a width in a face
  // nobody has chosen yet.
  const labelFit = labels.map(() => 1);
  const naturalWidth = labels.map(() => 0);

  function viewport() {
    const el = world.renderer.domElement;
    return [el.clientWidth || window.innerWidth || 1280, el.clientHeight || window.innerHeight || 720];
  }

  /** World units the frame is tall right now, at whatever zoom it is at. */
  function frameHeight() {
    return world.halfExtents(camera.zoom).h * 2;
  }

  function placeLabels(w) {
    const [vw, vh] = viewport();
    menu.items.forEach((item, i) => {
      _project.copy(item.world).project(camera);
      labels[i].style.left = `${((_project.x + 1) / 2) * vw}px`;
      labels[i].style.top = `${((1 - _project.y) / 2) * vh}px`;
      // The label rides the button's own swell, or the type stays put while the
      // thing it names moves under it and the two stop reading as one object.
      const scale = (item.radius / menu.radius) * labelFit[i];
      labels[i].style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      // Gone by the time the camera is a fifth of the way out. The buttons are
      // the one part of this screen with no business in a run, and type
      // shrinking off into the distance reads as debris — so it leaves early,
      // on its own curve, while the shot is still mostly a portrait.
      labels[i].style.opacity = String(Math.max(0, Math.min(1, w * 2.5 - 1.2)));
    });
  }

  /**
   * THE TYPE NEVER LEAVES ITS BUTTON.
   *
   * The labels are DOM at a fixed point size and the buttons are world-space
   * hexagons, so the two scale against each other with the frame: on a phone
   * held upright the row has to fit across 375 pixels, each hexagon lands about
   * a third the width it has on a laptop, and "HOW TO PLAY" at its authored size
   * is then a line of text with a small hexagon behind the middle of it.
   *
   * So a label is shrunk — only ever shrunk, and only when it would overflow —
   * to sit inside the flat band across its own cell. The hexagon is flat-top, so
   * the room at its vertical centre is the full 2r, and 0.78 of that keeps the
   * text off the bevel where the fresnel is brightest.
   *
   * Measured against the HELD framing, not the live one: through the glide the
   * frame opens by a factor of fifteen, and a shrink recomputed against that
   * would walk the type down to nothing on the way out.
   */
  function fitLabels(pxPerUnitHeld) {
    labels.forEach((node, i) => {
      if (!naturalWidth[i]) {
        // Measured with any previous shrink removed, or each pass would measure
        // the last one's output and walk the type down over a few resizes.
        node.style.transform = 'translate(-50%, -50%)';
        naturalWidth[i] = node.scrollWidth;
      }
      const room = menu.radius * 2 * pxPerUnitHeld * 0.78;
      labelFit[i] = naturalWidth[i] > 0 ? Math.min(1, room / naturalWidth[i]) : 1;
    });
  }

  // --- the framing ----------------------------------------------------------
  //
  // Expressed as a POINT AND A ZOOM, because that is the only kind of claim the
  // game's camera takes (world.focusCamera — the same one the death dive and
  // the boss kill shot make) and because it is the only shape that can be
  // blended to nothing. A frustum written directly, the way the look page
  // writes it, has no "half way to the run's framing".
  //
  // Composed when the window changes and then HELD: these numbers are a
  // composition, and re-deriving them per frame from a camera that is mid-glide
  // would be the shot chasing itself.
  const held = { x: 0, y: 0, zoom: 1, pxPerUnit: 1 };

  function composeHeld() {
    const [vw, vh] = viewport();
    const aspect = vw / Math.max(1, vh);

    // What the crop asks for: the measured bust filling `fill` of the height,
    // with `headroom` of air above the crown. The composition is anchored on
    // the space over the head — a portrait is judged there, and the waist lands
    // wherever it lands.
    const bustH = Math.max(0.01, bust.max.y - bust.min.y);
    let wantH = bustH / Math.max(0.05, cfg.fill ?? 1.06);
    let top = bust.max.y + wantH * (cfg.headroom ?? 0.1);
    let bottom = top - wantH;
    // What has to be in the picture, across. The animal to start with; the row
    // of buttons joins it below.
    let contentMinX = bust.min.x;
    let contentMaxX = bust.max.x;

    if (menu.items.length) {
      // ...AND THEN MAKE ROOM FOR THE BUTTONS. The crop composes on the ANIMAL
      // and knows nothing about what is above it, so at the tuned headroom the
      // row sits off the top of the frame — which looks exactly like a menu
      // that failed to render. The frame grows to include it: the top moves up,
      // the bottom stays where the crop wanted it.
      //
      // `radius` is centre to CORNER and the corners of a flat-top cell point
      // sideways, so the height above a centre is the apothem — using the
      // radius would leave 13% of extra sky nobody asked for.
      const rowTop = Math.max(...menu.items.map((i) => i.world.y))
        + menu.radius * 0.866 + menu.metrics.rowStep * 0.5;
      if (rowTop > top) top = rowTop;
      wantH = top - bottom;

      // ...AND ACROSS, WHICH PORTRAIT NEEDS AND LANDSCAPE NEVER DOES. A phone
      // held upright fits the animal into a frame barely two units wide, and
      // the row of buttons is three and a half — so the outer two are not
      // clipped, they are GONE, with the middle one looking like the only
      // button there is.
      //
      // Measured off the buttons, as the union of the ANIMAL and the ROW —
      // which is also what decides where the frame is centred across.
      //
      // THE ROW IS NOT CENTRED ON THE ANIMAL and cannot be. Every button is
      // snapped to a cell of the game's own lattice (hexCellAt), so the row's
      // middle lands wherever the nearest column is — up to half a cell off the
      // bust's own centre line. Centring the frame on the animal and sizing it
      // off the row's WIDTH is the bug that puts the outer button half off the
      // screen: the numbers say it fits, and it fits somewhere else.
      let rowMin = Infinity;
      let rowMax = -Infinity;
      for (const item of menu.items) {
        rowMin = Math.min(rowMin, item.world.x - menu.radius);
        rowMax = Math.max(rowMax, item.world.x + menu.radius);
      }
      contentMinX = Math.min(contentMinX, rowMin);
      contentMaxX = Math.max(contentMaxX, rowMax);

      const needW = (contentMaxX - contentMinX) + menu.radius * 0.8;
      if (needW > wantH * aspect) {
        const grown = needW / aspect;
        // A third of the new height below and two thirds above: the bottom edge
        // is a CROP through the waist and wants to stay near the frame edge,
        // while the space over the crown is what the composition is about.
        bottom -= (grown - wantH) * 0.35;
        wantH = grown;
        top = bottom + wantH;
      }
    }

    // The frame at zoom 1 is the run's own, so the claim is simply the ratio of
    // the two heights. Clamped at 1: a window tall enough that the crop is
    // already wider than the run's framing wants no claim at all, and a zoom
    // below 1 would be the menu pulling BACK from the arena.
    const runH = world.halfExtents(1).h * 2;
    held.zoom = Math.max(1, runH / Math.max(0.01, wantH));
    // The middle of everything that has to be in shot, not the middle of the
    // animal — see above. `offsetX` then moves that composition across the
    // frame, as a fraction of the frame's own width.
    held.x = (contentMinX + contentMaxX) / 2 + (cfg.offsetX ?? 0) * wantH * aspect;
    held.y = (top + bottom) / 2;
    held.pxPerUnit = vh / wantH;
    fitLabels(held.pxPerUnit);
  }
  composeHeld();
  const onResize = () => composeHeld();
  window.addEventListener('resize', onResize);
  // ONE MORE PASS WHEN THE FACE ARRIVES. initTypography loads the family the
  // `blobButton` role names, and a label measured before it lands was measured
  // in the fallback — which is a different width, and the shrink is a ratio
  // against exactly that number.
  document.fonts?.ready?.then(() => {
    naturalWidth.fill(0);
    composeHeld();
  });

  // --- the pointer ----------------------------------------------------------
  // Two questions, deliberately separate, because a phone answers only one of
  // them: where the seal is LOOKING, and which button is under the finger.
  //
  // A touch reports as a pointer, and letting it drive the aim means the animal
  // spends the whole screen staring at wherever the last tap landed — so touch
  // moves nothing. It still picks buttons, which is the half that has to work
  // on the device most of this game is played on.
  let hovered = -1;
  let heldButton = -1;
  let heldAt = 0;
  let padHover = -1;
  // Where the cursor is in NDC, and whether there is one at all — the two
  // things the lattice's glow needs. Kept beside `cursorWorld` rather than
  // derived from it, because the slot the grid reads is in NDC on purpose (it
  // re-unprojects every frame, so a glow stays under the pointer while the
  // camera moves beneath it). See publishCursor.
  const cursorNdc = { x: 0, y: 0 };
  let pointerInside = false;
  // Autopilot until a mouse actually moves. Not decoration: on a phone there is
  // no cursor at all, and without this the seal on the menu is a frozen stare.
  let auto = true;
  let clock = 0;

  /**
   * Where the cursor is, as an aim the rig understands, plus what it is over.
   *
   * The two halves are separately switchable because two callers want one each:
   * a TOUCH picks without looking (see above), and the autopilot looks without
   * picking — a highlight that wandered the row on its own would read as the
   * menu being used by somebody else, and would fire a hover sound doing it.
   */
  function pointTo(clientX, clientY, { look = true, pick = true } = {}) {
    const [vw, vh] = viewport();
    cursorNdc.x = (clientX / vw) * 2 - 1;
    cursorNdc.y = -(clientY / vh) * 2 + 1;
    cursorWorld.set(cursorNdc.x, cursorNdc.y, 0).unproject(camera);
    cursorWorld.z = 0;
    // The body's forward — straight up, plus the measured plumb and the cant.
    if (look) bustAim(rig, cursorWorld, wantAim, Math.PI / 2 + plumb + (cfg.lean ?? 0), cfg.aimSpread);
    if (!pick) return;
    const was = hovered;
    hovered = menu.pick(cursorWorld);
    if (hovered >= 0 && hovered !== was) feedback('uiHover');
  }

  // --- THE CURSOR'S OWN LIGHT ON THE LATTICE --------------------------------
  //
  // The hexes light up around the pointer, and bulge away from it, out to
  // `touchRadius`. That is not written here: it is the game's own halo — the
  // one a finger leaves on the water in a run (CONFIG.grid.touchGlow, drawn by
  // systems/grid.js) — and this screen's scaling of it is already resolved by
  // touchGlowForMenu above. The only thing missing was a POINTER: grid.js
  // reads `touchSlots` from input.js, and those are filled by `touchstart`
  // alone, so on a machine with a mouse the composed glow had nothing to
  // follow and the backdrop simply never answered.
  //
  // So the mouse is PUBLISHED as a finger rather than reimplemented as a
  // second kind of light. Everything in the touchGlow block then reaches both
  // at once: hover and press are one behaviour with a weight (`charge.grow`
  // swells the halo while a button is held — see the view handed to
  // grid.update), the release knock fires when the slot is dropped, and a
  // number retuned for the phone moves the desktop with it.
  //
  // THE LOWEST FREE SLOT, and never one a real finger is holding. A hybrid
  // machine can have both, and stealing slot 0 from a thumb would move that
  // thumb's glow to the mouse pointer mid-touch.
  let mouseSlot = -1;
  const MOUSE_ID = 'menu-mouse';

  function publishCursor() {
    // Not the autopilot. It sweeps the head so the animal is alive on a screen
    // nobody is touching yet — a glow wandering the lattice on its own would
    // read as the menu being used by somebody else, which is the same
    // objection that already keeps the autopilot off the button highlight.
    const live = pointerInside && mainMenuEngaged();
    if (live && mouseSlot < 0) {
      mouseSlot = touchSlots.findIndex((sl) => sl.id === null || sl.id === MOUSE_ID);
    }
    if (mouseSlot < 0) return;
    const slot = touchSlots[mouseSlot];
    // Somebody else took it while the pointer was away — leave it alone.
    if (slot.id !== null && slot.id !== MOUSE_ID) { mouseSlot = -1; return; }
    if (!live) {
      // FREED, not moved off screen: the grid fades the halo out from where the
      // pointer left, exactly as it does when a finger lifts.
      slot.id = null;
      slot.charging = false;
      mouseSlot = -1;
      return;
    }
    slot.id = MOUSE_ID;
    slot.x = cursorNdc.x;
    slot.y = cursorNdc.y;
    // The swell is the PRESS, not the hover — see the charge terms in
    // CONFIG.grid.touchGlow, and the `charging` flag handed to grid.update.
    slot.charging = heldButton >= 0;
  }

  /** Drop the slot for good. Called from tidy, and by a pointer leaving. */
  function dropCursor() {
    pointerInside = false;
    publishCursor();
  }

  function onMove(e) {
    if (!mainMenuEngaged()) return;
    if (e.pointerType && e.pointerType !== 'mouse') return;
    auto = false;
    pointerInside = true;
    pointTo(e.clientX, e.clientY);
  }

  function onDown(e) {
    if (!mainMenuEngaged()) return;
    // A PRESS ON THE WATER, and nothing else. The UI layer over this canvas is
    // pointer-events:none, so anything that lands on a real control — a panel
    // this menu opened, the pause menu's rows, a link — arrives with that
    // element as its target and must not also squash a hexagon behind it. The
    // labels take no events of their own, so a press on one still reads as the
    // canvas, which is what makes a button's own text part of the button.
    if (e.target !== world.renderer.domElement) return;
    const mouse = !e.pointerType || e.pointerType === 'mouse';
    if (mouse) pointerInside = true;
    pointTo(e.clientX, e.clientY, { look: mouse });
    if (hovered < 0) {
      // OPEN WATER. The lattice does not care what was over it — a screen that
      // only answers on three small targets teaches you not to touch it — so a
      // press anywhere puts a knock in the water under the pointer.
      //
      // Softer and tighter than a button's (CONFIG.splashBust.menu.waterPunch
      // / waterRadius, fractions of the button's own impulse), and fired on the
      // PRESS rather than the release: there is nothing to bank out here, so
      // waiting for the lift would put the distortion after the gesture.
      //
      // BOTH lattices take it, exactly as a button's does — the shove is in the
      // water rather than on a layer, so it is still spreading through the
      // arena's grid after the menu's has faded out.
      waterKnock(cursorWorld.x, cursorWorld.y);
      return;
    }
    heldButton = hovered;
    heldAt = performance.now();
    menu.press(heldButton);
    feedback('uiClick');
  }

  /** The lattice's own punch, at a point on open water. */
  function waterKnock(x, y) {
    const strength = (menuCfg.impulseStrength ?? 0.1) * (menuCfg.waterPunch ?? 0.45);
    const radius = (menuCfg.impulseRadius ?? 5) * (menuCfg.waterRadius ?? 0.7);
    if (!(strength > 0)) return;
    withMenuGrid(() => grid.ripple(x, y, strength, radius));
    world.grid?.ripple(x, y, strength, radius);
  }

  function onUp() {
    if (heldButton < 0) return;
    const index = heldButton;
    heldButton = -1;
    // release() is what calls the item's own onPress — including for a press
    // too short to bank an impulse, which returns null and is still a click.
    const shot = menu.release(index);
    // A touch has no hover, so the highlight has to come off with the finger or
    // the button it opened stays lit behind whatever arrives next.
    if (auto) hovered = -1;
    if (!shot) return;
    // THE IMPULSE: the grid's own punch, at the button's own position, so the
    // wave leaves from under the thing that was pressed and the lattice springs
    // back on the game's numbers rather than on any easing written here.
    //
    // BOTH lattices take it — the menu's own and the arena's underneath — so
    // the shove is in the water rather than on a layer, and it is still
    // spreading through the arena's grid after the menu's has faded out.
    withMenuGrid(() => grid.ripple(shot.x, shot.y, shot.strength, shot.radius));
    world.grid?.ripple(shot.x, shot.y, shot.strength, shot.radius);
  }

  // On `window` rather than on the canvas: the UI layer sits over it, and a
  // press that landed on the label of a button would otherwise never arrive.
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  // A pointer that leaves the window mid-press never sends `up`. Without this
  // the button stays held, charging, forever.
  window.addEventListener('pointercancel', onUp);
  // A cursor that leaves the window has no business still lighting the water.
  // `blur` as well as `pointerleave`: alt-tabbing away never fires the latter.
  window.addEventListener('pointerleave', dropCursor);
  window.addEventListener('blur', dropCursor);

  // A slow sweep while nothing is driving the cursor. Two incommensurate rates
  // so the head wanders instead of tracing a loop, and written as a CURSOR
  // rather than as an aim so it goes through exactly the mapping a real pointer
  // does — an autopilot that wrote the aim directly would be the one thing on
  // screen not exercising what ships.
  function autopilot(dt) {
    clock += dt;
    const [vw, vh] = viewport();
    pointTo(
      vw * (0.5 + 0.42 * Math.sin(clock * 0.45)),
      vh * (0.42 + 0.34 * Math.sin(clock * 0.31 + 1.2)),
      { pick: false },
    );
  }

  // --- the pad --------------------------------------------------------------
  // A pad cannot point, so it gets a cursor of its own: left/right walks the
  // row, confirm presses whatever it is on. Held separately from `hovered`
  // because the mouse writes that every frame it moves, and a pad selection a
  // stray mouse pixel could erase is not a selection.
  function updatePad() {
    if (menuInput.x) {
      const from = padHover < 0 ? -1 : padHover;
      padHover = Math.max(0, Math.min(menu.items.length - 1, from + (menuInput.x > 0 ? 1 : -1)));
      hovered = padHover;
      auto = false;
      feedback('uiHover');
    }
    if (menuInput.confirm && hovered >= 0) {
      menu.press(hovered);
      feedback('uiClick');
      // Pressed and released on the same frame, which is a click with no charge
      // banked: the squish and the click's own bits of goo, and no impulse into
      // the lattice. Holding to punch the grid is a gesture only a pointer has.
      menu.release(hovered);
    } else if (menuInput.confirm && padHover < 0) {
      // Nothing selected yet — the first press is the asking.
      padHover = 0;
      hovered = 0;
      auto = false;
    }
  }

  // --- the shot -------------------------------------------------------------
  const state = {
    // 'in' | 'held' | 'out'. `held` is the steady state with the buttons up;
    // `out` is the glide, which keeps running over a run that has already
    // started. There is no 'off' — the menu removes itself at the end of it.
    phase: 'in',
    elapsed: 0,
    weight: 0,
    releaseFrom: 0,
    aim,
    handle: null,
    // What the ARENA's lattice is asked for while this screen is up — see
    // mainMenuGrid, and wakeFor for why the dent is a blend, not a switch.
    // Rebuilt into the same object every frame: this is read once per frame on
    // the hot path and has no business allocating.
    gridView: () => {
      const w = state.weight;
      _gridView.wake = wakeFor(w);
      _gridView.fade = 1 + ((menuCfg.arenaLattice ?? 0) - 1) * w;
      return _gridView;
    },
  };
  const _gridView = { wake: 0, fade: 1 };

  function tidy() {
    // The rig's latch, dropped for good. `release` already dropped it on the
    // frame Play was pressed — this is the path where the menu is thrown away
    // without one, and a latch left held would frame every run on a menu that
    // is not there.
    if (cineEnabled()) cineMenu(false);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('pointerleave', dropCursor);
    window.removeEventListener('blur', dropCursor);
    // The slot back to the pool BEFORE the run starts reading it for fingers.
    // A menu that tore down holding one would leave a permanent glow on the
    // arena's lattice at whatever the last cursor position unprojects to.
    dropCursor();
    labelLayer.remove();
    scene.remove(menu.mesh);
    menu.mesh.geometry.dispose();
    menu.mesh.material.dispose();
    scene.remove(scrim);
    scrim.geometry.dispose();
    scrim.material.dispose();
    grid.dispose();
    // ...and the water back to the arena's own light. The eased value has
    // already reached 1 by the time the weight runs out; this is the belt to
    // that brace, and without it a menu torn down early (a resize mid-glide)
    // would leave the run's ocean lit for a screen that is gone.
    setCausticsPunch(1, 1);
    // The rim back to exactly what CONFIG says, rather than to whatever the
    // last mixed frame left on the shells. fitRim(0) has already put it there;
    // this is the belt to that brace, and it costs one pass over six materials
    // once per run.
    applyPlayerOutline();
    live = null;
  }

  const handle = {
    /** Which phase the shot is in, for the frame loop's own gates. */
    get phase() { return state.phase; },

    /**
     * PLAY. Hands the frame to the run and gets out of the way.
     *
     * Tears nothing down: the caller starts the run on this same tick, and
     * everything this holds is a weight that eases to zero over the next second
     * — the camera opening out, the body turning into a swimming seal, the
     * buttons and the fine lattice fading. `tidy` runs when the weight reaches
     * zero, by which point nothing it removes is visible.
     */
    release() {
      if (state.phase === 'out') return;
      state.phase = 'out';
      state.elapsed = 0;
      state.releaseFrom = state.weight;
      // THE MOMENT THE TRANSITION STARTS, and it is one line: the rig stops
      // being told to hold the menu's framing, so on the next frame its
      // priority list picks up the run's opening shot and blends there from
      // exactly where this one had got to.
      if (cineEnabled()) cineMenu(false);
      // The bones go back to the mixer NOW rather than easing. The pin holds
      // the tail and the hind flippers, and at the moment of release the camera
      // is still on the crop — where all three are off the bottom of the frame.
      pin?.release();
    },

    /**
     * Drop it outright, with no glide. For a route that has no run to open into
     * — a reset, or a second menu being put up over this one.
     */
    dispose() {
      pin?.release();
      fitRim(0, held.pxPerUnit);
      tidy();
    },

    /**
     * One frame, from the game loop, on the REAL delta.
     *
     * Real time and not the gameplay delta because none of this is gameplay:
     * there is no run to dilate while it is held, and the glide deliberately
     * overlaps the first second of one — a hit-stop from the first kill must
     * not stall the camera easing back out.
     *
     * `pad` is false while a panel this menu opened is in front of it: the pad
     * has one confirm button and that panel's own cursor is already spending
     * it, so leaving this on would press the hexagon behind the row the player
     * is actually on. The POINTER needs no such flag — those panels are
     * `pointer-events: all`, and a click on one never reaches the canvas.
     */
    update(dt, { pad = true } = {}) {
      state.elapsed += dt;

      if (state.phase === 'in') {
        const t = Math.min(1, state.elapsed / Math.max(0.01, cfg.inTime ?? 0.9));
        state.weight = ease(cfg.inEase ?? 'outCubic', t);
        if (t >= 1) { state.phase = 'held'; state.elapsed = 0; }
      } else if (state.phase === 'held') {
        state.weight = 1;
      } else {
        const t = Math.min(1, state.elapsed / Math.max(0.01, cfg.outTime ?? 1.1));
        state.weight = state.releaseFrom * (1 - ease(cfg.outEase ?? 'inOutCubic', t));
        if (t >= 1) {
          // Everything is at its run value on this frame anyway — put the rim
          // there exactly rather than a thousandth off it, then let go.
          const h = frameHeight();
          fitRim(0, h > 0 ? viewport()[1] / h : 1);
          tidy();
          return;
        }
      }
      const w = state.weight;

      if (mainMenuEngaged()) {
        if (auto) autopilot(dt);
        if (pad) updatePad();
        aim.lerp(wantAim, 1 - Math.exp(-(cfg.aimLerp ?? 7) * dt));
        if (aim.lengthSq() > 1e-8) aim.normalize();
      }

      // --- the body ---------------------------------------------------------
      // AFTER the mixer and the aim rig, which is why this is called from the
      // end of the frame: both write an absolute pose, and the pin exists
      // because the rig's tail spring writes the very bones being held.
      //
      // SLERPED, not written. While the menu is held `w` is 1 and this is the
      // bust outright; through the glide the run's own heading — which
      // updatePlayer is writing again by then — takes it over smoothly, so the
      // animal turns from standing to swimming over the same second the camera
      // pulls back, instead of snapping on the frame the run begins.
      _bustQuat.setFromAxisAngle(_z, plumb + (cfg.lean ?? 0));
      body.quaternion.slerp(_bustQuat, w);
      if (mainMenuEngaged()) {
        pin?.apply();
        body.updateMatrixWorld(true);
      }

      // --- the frame --------------------------------------------------------
      // THE RIG OWNS IT. `mainMenu` is a state in systems/cineCamera.js like
      // charging or roundStart, and this hands it the two numbers it cannot
      // hold — the measured zoom, and the offset from the seal to the point
      // this composition centres. Everything else about how the frame gets
      // there and back is the rig's: its blend curve, its spring, its clamp.
      //
      // That is the whole reason it lives there rather than here. Dropping the
      // latch on Play does not move the camera; it lets the priority list pick
      // the next state up, which is the run's own opening shot (`roundStart`)
      // and then `base`. Menu -> starting camera -> gameplay, blended twice,
      // with no cut and no second implementation of what a blend is.
      const at = seal.mesh.position;
      if (cineEnabled()) {
        cineMenu(mainMenuEngaged(), {
          zoom: held.zoom,
          offsetX: held.x - at.x,
          offsetY: held.y - at.y,
        });
      } else {
        // NO RIG (CONFIG.cinecam.enabled is off): the fixed frame has no state
        // machine to put this in, so the shot is made the way the death dive
        // and the boss kill shot make theirs — a claim on world.focusCamera,
        // eased by this screen's own weight. Geometric in the zoom, because a
        // factor of fifteen eased linearly spends five sixths of itself in the
        // first third of the move; linear in the point, so at w 0 it is exactly
        // the framing the run would have chosen for itself.
        _focus.x = at.x + (held.x - at.x) * w;
        _focus.y = at.y + (held.y - at.y) * w;
        world.focusCamera(_focus, Math.pow(held.zoom, w), 1);
      }

      // --- everything that fades -------------------------------------------
      // The buttons keep their shape and lose their substance: scaling them out
      // would be a second motion fighting the camera's, which is already moving
      // them away from the lens.
      menu.mesh.material.uniforms.uOpacity.value = (menuCfg.opacity ?? 1) * w;
      menu.mesh.visible = w > 0.01;
      if (heldButton >= 0) menu.hold(heldButton, (performance.now() - heldAt) / 1000);
      menu.update(dt, mainMenuEngaged() ? hovered : -1);
      // The lattice, ticked at the menu's own numbers — and with the seal's
      // wake handed in rather than read from CONFIG, because at this zoom the
      // run's dent is the whole picture (see wakeFor).
      // The cursor, published as a finger before the lattice is ticked — the
      // glow is resolved from NDC every frame (the camera is moving under it
      // through the whole glide), so this has to be current when grid.update
      // reads the slot rather than only when the pointer last moved.
      publishCursor();
      withMenuGrid(() => {
        grid.pin(menuPins());
        // `charging` / `charge` are the strike meter's shape in a run and a
        // BUTTON's here: they are what makes the halo swell and pulse while
        // something is being held down (CONFIG.grid.touchGlow.charge, scaled
        // for this screen by touchPunch). Without them a press is the same
        // light as a hover, and the one gesture the lattice should answer
        // hardest is the one it cannot see.
        grid.update(dt, at, _still, {
          camera,
          wake: wakeFor(w),
          charging: heldButton >= 0,
          charge: heldButton >= 0
            ? Math.min(1, (performance.now() - heldAt) / 1000 / Math.max(0.01, menuCfg.chargeTime ?? 0.9))
            : 0,
        });
      }, w);
      // THE LIGHT IN THE WATER, at this crop. Set here and read by the water
      // material on the NEXT frame's colour pass — one frame of lag on an eased
      // value, which is invisible, and the alternative is threading a menu's
      // number through world.updateSurface. See setCausticsPunch.
      setCausticsPunch(
        1 + ((menuCfg.causticsGain ?? 1) - 1) * w,
        1 + ((menuCfg.causticsScale ?? 1) - 1) * w,
      );
      fitScrim(w);
      placeLabels(w);
      // The rim, mixed against the frame as it stands this frame — the pull-out
      // changes pixels-per-unit continuously, and a rim asked for in pixels has
      // to be re-answered every one of them.
      const h = frameHeight();
      fitRim(w, h > 0 ? viewport()[1] / h : 1);
    },
  };

  state.handle = handle;
  live = state;
  return handle;
}
