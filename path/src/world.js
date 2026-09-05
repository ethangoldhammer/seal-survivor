import * as THREE from 'three';
import { CONFIG } from './config.js';
import { resolutionScale } from './systems/settings.js';
import { createAdaptiveScale } from './systems/adaptiveScale.js';
import { bounds, updateBounds, surfaceHeightAt, setWaveTime, setSeaState, maxWaveExcursion, SEABED_HEIGHT, SEABED_Z, WATER_FILL_Z, FLOOR_OVERSCAN } from './arena.js';
import { createGrid } from './systems/grid.js';
import { createConstellations } from './systems/constellations.js';
import { createWaterMaterial, updateWaterMaterial, setWaterWaveTime, liveCaustics } from './systems/water.js';
// The seal's wet film is lit by the water's caustics, so it has to be told what
// they are doing — see setNoiseWetEnv and CONFIG.sealShader.wetCaustics.
import { setNoiseWetEnv } from './systems/noiseShader.js';
import { createSkyMaterial, updateSkyMaterial, skyPlaneMetrics } from './systems/sky.js';
import { createCelestials } from './systems/celestial.js';
import { createClouds } from './systems/clouds.js';
import { createRain, weatherState } from './systems/weather.js';
import { createLightning } from './systems/lightning.js';
import { createHorizonGlow } from './systems/horizon.js';
import { createWallRocks, shoreOverscan } from './systems/wallRocks.js';
import { refreshFlash, skyLight } from './systems/daylight.js';
import { updateCineCamera, cineLens, cineSubject, cineEnabled } from './systems/cineCamera.js';
import { mark as crashMark } from './systems/crashLog.js';

// FLOOR_OVERSCAN moved to arena.js — updateBounds clamps the field-of-view
// setting against it and cannot import this file. Only the death dive's framing
// ever spends it here (see focusCamera); the seabed skirt is what pays for it.

// Vertices per world unit along the drawn water line, taken from what the
// frame used to get (140 across 92.4 units) so a default-width arena builds
// the same curve it always did.
const SURFACE_SEGMENTS_PER_UNIT = 140 / 92.4;

export function createWorld(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.colors.sky);

  // Asymmetric orthographic frustum: the water line sits at y = 0, and the
  // top/bottom are offset so the surface lands at `surfaceFromTop` of the view.
  const camera = new THREE.OrthographicCamera();
  camera.position.set(0, 0, 40);

  const adaptive = createAdaptiveScale();
  // NO MSAA, AND IT IS NOT A QUALITY CUT — it is the removal of something that
  // has never been doing anything.
  //
  // `antialias` is an attribute of the DEFAULT drawing buffer and of nothing
  // else. The game does not draw the water into that buffer: post.js renders
  // the whole scene into `sceneTarget` (which is not multisampled and never
  // was), and the only thing that ever reaches the default framebuffer is the
  // composite — one fullscreen triangle with no interior edges for a sampler
  // to find. So every creature silhouette in this game has been resolved by
  // the composite's own filtering for as long as post has existed, and asking
  // for MSAA bought exactly zero pixels of it.
  //
  // What it cost is the reason to stop: the driver allocates a multisampled
  // colour buffer at the full size of the canvas and resolves it every frame.
  // On a phone reporting devicePixelRatio 3 that is a 3.2-megapixel buffer at
  // four samples, on a WebContent process the phone is already willing to kill
  // for memory (see CONFIG.render.pixelRatio), plus a resolve's worth of
  // bandwidth per frame spent on a triangle.
  //
  // WHAT IS GIVEN UP, honestly: the passthrough path in post.render — bloom
  // off AND the screen filter off AND nothing else claiming the pipeline —
  // renders the scene straight to the default buffer, and that path did have
  // real MSAA. It is also the path somebody is on because they are running the
  // game as cheaply as it goes, which is not where four samples per pixel
  // belong. The attribute cannot be changed after the context is created, so
  // this is one answer or the other and it cannot be the picture's.
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);

  // How many real pixels a screen pixel is worth — see CONFIG.render. A CAP on
  // the display's own ratio rather than a multiplier of it, so raising it can
  // never ask a 1x display for pixels it doesn't have.
  //
  // Floored well below 1 rather than at it: undersampling is a legitimate
  // setting on a machine that cannot hold the frame rate any other way, and
  // this is the knob that buys the most. Zero would be a black screen.
  // The player's Resolution setting scales the AUTHORED cap rather than
  // replacing it: authoring decides the game never asks a display for more
  // than 2x, and a player on a machine that cannot hold the frame rate can ask
  // for less than that — but not for more, which would be a request for pixels
  // the panel may not have.
  //
  // AND a third term the player never sets: the adaptive controller, which is
  // how a machine that cannot hold the frame rate stops being asked to. It
  // only ever scales DOWN from what the two authored terms already agreed on,
  // so it can take pixels away and can never hand back more than the player
  // asked for. See systems/adaptiveScale.js for why pixels are the thing to
  // give back on the machines the production runs actually come from.
  function renderScale() {
    const cap = (CONFIG.render?.pixelRatio ?? 2) * resolutionScale() * adaptive.value;
    return Math.max(0.25, Math.min(window.devicePixelRatio || 1, cap));
  }

  /**
   * One frame's unclamped wall time. Reapplies the scale only on the frames
   * the controller actually moved it — setPixelRatio reallocates post.js's
   * render targets, so calling it every frame would cost more than it saves.
   */
  function tickAdaptiveScale(frameMs, live) {
    if (adaptive.tick(frameMs, live)) applyRenderScale();
  }

  /** What the adaptive term settled on, for the readout and the run record. */
  function adaptiveScale() {
    return adaptive.value;
  }

  /** A new run starts at the resolution the player asked for. */
  function resetAdaptiveScale() {
    adaptive.reset();
    applyRenderScale();
  }

  // setPixelRatio re-runs setSize against the size three already has, with
  // updateStyle off — so the canvas keeps its CSS size and only the drawing
  // buffer changes, which is exactly the trade. post.js sizes its targets off
  // domElement.width every frame and picks the new buffer up on the next one;
  // the particle point scale reads domElement.height for the same reason. So
  // nothing else has to be told.
  function applyRenderScale() {
    renderer.setPixelRatio(renderScale());
  }
  applyRenderScale();
  // Per-material clipping planes, used by exactly one thing: the horizon that
  // cuts the sun and moon off at the water line (see systems/celestial.js).
  // Materials that don't ask for a plane are unaffected.
  renderer.localClippingEnabled = true;

  // three zeroes renderer.info at the top of EVERY render() call, and post.js
  // makes a dozen of them per frame — the scene, a bright pass, the blur
  // ping-pong, the composite. So `info.render.calls` read after a frame reports
  // whatever the LAST pass drew, which is the fullscreen composite triangle:
  // one. The readout said "1 draws" all through a fight with 195 creatures in
  // the water, which is not a number that is slightly off, it is a different
  // number entirely.
  //
  // Off, so the counts accumulate across every pass of a frame. main.js reads
  // them at the top of the next frame and resets by hand — see the note there.
  renderer.info.autoReset = false;
  // THE GPU DYING IS INVISIBLE FROM EVERYWHERE ELSE, and it is the one ending
  // this game had no way to record.
  //
  // A WebGL context loss is not a JavaScript error: nothing throws, no handler
  // runs, and the frame loop simply stops drawing. On the phone WebKit then
  // reloads the page, and what the player sees is the game "resetting to the
  // loading screen" — identical, from the outside, to the process being killed
  // for memory. The two were indistinguishable in the crash trail, and the
  // device's own logs say it is NOT the memory one: no JetsamEvent at any of
  // the resets, no WebContent crash report, and a CPU exception at 54% average
  // that took no action.
  //
  // So the trail records it. A run that ends `... -> gl:lost` is a GPU fault
  // and a run that ends `... -> tick` is not, which is the whole question.
  //
  // `preventDefault` is what allows a restore to be attempted at all — without
  // it WebKit will not fire webglcontextrestored — but nothing here tries to
  // rebuild the scene, because a half-restored renderer that draws nothing is
  // worse than a reload. The mark is the point.
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    try { crashMark('gl:lost', renderer.info?.render?.calls ?? ''); } catch { /* never block the handler */ }
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    try { crashMark('gl:restored'); } catch { /* as above */ }
  });

  container.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient);
  const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
  key.position.fromArray(CONFIG.lighting.keyPosition);
  const hemi = new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity);
  scene.add(ambient, key, hemi);

  function updateLighting() {
    ambient.intensity = CONFIG.lighting.ambient;
    key.intensity = CONFIG.lighting.keyIntensity;
    key.position.fromArray(CONFIG.lighting.keyPosition);
    hemi.intensity = CONFIG.lighting.hemiIntensity;
  }

  const backdrop = new THREE.Group();
  scene.add(backdrop);

  const warpGrid = createGrid(scene);
  const constellations = createConstellations(scene);
  // Outside the backdrop group: it owns its own rebuild off `bounds`, same as
  // the grid, and disposeBackdrop would take its merged geometry with it.
  const wallRocks = createWallRocks(scene);

  // ONE PUNCH, BOTH BACKDROPS. Everything juicy in the game already rings the
  // grid — kills, chain reactions, trawlers going up, a finger landing on the
  // glass — through `world.grid.ripple`. The night sky is the same machine
  // pointed at the air (see systems/constellations.js) and it wants the same
  // events, so the ripple is teed here rather than at the call sites: a second
  // set of them would start out identical and drift the first time one of them
  // was edited and the other wasn't.
  //
  // Nothing outside this file knows there are two. `world.grid` is still the
  // grid — same object, same methods — with one function in front of it.
  const grid = {
    ...warpGrid,
    ripple(x, y, strength, radius) {
      warpGrid.ripple(x, y, strength, radius);
      constellations.ripple(x, y, strength, radius);
    },
  };

  // The sky systems live OUTSIDE the backdrop group on purpose. The backdrop
  // is torn down and rebuilt on every resize, and these three hold things
  // that must not be thrown away with it — a loaded sun texture, a pool of
  // raindrops mid-fall, a scrolling cloud offset. All three size themselves
  // off `bounds` each frame instead, so a resize needs nothing from them.
  const celestials = createCelestials(scene);
  const clouds = createClouds(scene);
  const rain = createRain(scene);
  const lightning = createLightning(scene);
  const horizonGlow = createHorizonGlow(scene);

  // Sky, seabed and the depth-line grid keep their materials across rebuilds
  // so colour changes can update them in place every frame with no rebuild —
  // only their geometry (size/position) needs to change on resize.
  let skyMesh = null, seabedMesh = null, depthLines = null, waterMesh = null;
  let waterClock = 0;

  let surfaceLine = null;
  let waveT = 0;

  // Where the camera was FRAMED, as opposed to where it ended up: the caller
  // adds shake straight onto camera.position after updateCamera returns, and
  // anything that parallaxes off the camera has to ignore that jitter or it
  // shakes in antiphase. Written at the end of updateCamera; read by the
  // celestial layer.
  const camAnchor = new THREE.Vector2(0, 0);

  function disposeBackdrop() {
    for (const child of [...backdrop.children]) {
      backdrop.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    surfaceLine = null;
    skyMesh = null;
    seabedMesh = null;
    depthLines = null;
    waterMesh = null;
  }

  function plane(width, height, color, y, z, opacity = 1) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity })
    );
    m.position.set(0, y, z);
    return m;
  }

  function buildBackdrop() {
    disposeBackdrop();
    const w = bounds.width * 1.2; // overscan so nothing pops at the edges
    const airH = bounds.top - bounds.surfaceY;
    const seaH = bounds.surfaceY - bounds.bottom;

    // The sky plane covers the ARENA's air, all the way to the jump ceiling,
    // plus overscan. The ceiling is exactly as high as the camera can pan, so
    // sized flush the plane's top edge sits precisely on the frame's — and a
    // camera shake or a punch at the top of a breach would show the scene
    // background above it. The GRADIENT inside it is a different measurement
    // and reads the frame; see uAirH.
    const sky = skyPlaneMetrics(bounds);
    const skyMat = createSkyMaterial();
    skyMat.uniforms.uCenter.value.set(0, sky.centerY);
    skyMat.uniforms.uSurfaceY.value = bounds.surfaceY;
    skyMat.uniforms.uAirH.value = sky.gradientAirH;
    skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, sky.height), skyMat);
    skyMesh.position.set(0, sky.centerY, -6);
    backdrop.add(skyMesh);

    // The fill runs WAVE_HEADROOM above the still-water line and its shader
    // clips itself back down to the wave curve, so the top of the water rides
    // the swell. Enough to contain the wave at its worst: the calm amplitude multiplied
    // by everything a full storm can do to it, with every term of the formula
    // in phase. Asked of arena.js rather than guessed at, because the guess
    // (a fixed 4, sized for the amplitude slider alone) stops being right the
    // moment the weather can multiply that amplitude — and the fill clips
    // itself to the wave, so a crest past the top of the geometry is a hard
    // horizontal cut across the sea. Safe to fix at build time: every path
    // that changes these numbers goes through world.resize().
    const stormAmp = CONFIG.arena.waveAmplitude * Math.max(1, CONFIG.weather?.sea?.amp ?? 1);
    const WAVE_HEADROOM = maxWaveExcursion(stormAmp, 1) + 1.5;
    const waterH = seaH + WAVE_HEADROOM;
    const waterCY = bounds.surfaceY + WAVE_HEADROOM / 2 - seaH / 2;
    const waterMat = createWaterMaterial();
    waterMat.uniforms.uCenter.value.set(0, waterCY);
    waterMat.uniforms.uSurfaceY.value = bounds.surfaceY;
    waterMat.uniforms.uBottomY.value = bounds.bottom;
    waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, waterH), waterMat);
    // Out of the sky plane's z (-6): the crests now reach into the band of sky
    // just above the still line, and coplanar they would fight over it. -5.4
    // also clears the sun and moon at -5.5, which clip themselves off at the
    // FLAT water line — so a crest standing above that line correctly cuts into
    // the bottom of a setting disc instead of being drawn behind it.
    waterMesh.position.set(0, waterCY, WATER_FILL_Z);
    backdrop.add(waterMesh);

    // Horizontal depth lines give a sense of scale and vertical motion.
    if (CONFIG.arena.showDepthLines) {
      const pts = [];
      const step = Math.max(1, CONFIG.arena.depthLineSpacing);
      for (let y = bounds.surfaceY - step; y > bounds.bottom; y -= step) {
        pts.push(new THREE.Vector3(bounds.left, y, 0), new THREE.Vector3(bounds.right, y, 0));
      }
      if (pts.length) {
        depthLines = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: CONFIG.colors.depthLine, transparent: true, opacity: 0.5 })
        );
        depthLines.position.z = -5;
        backdrop.add(depthLines);
      }
    }

    // The strip is 1.2 of visible seabed inside the arena, plus a skirt of the
    // same colour hanging BELOW it. Same reasoning as the `w` overscan above,
    // for the other axis: the death dive's camera is allowed to drop a little
    // past the floor so a body lying on it isn't pinned to the bottom edge of
    // the frame (see focusCamera), and without the skirt that reveals the bare
    // scene background under the seabed.
    // Two units deeper than the camera is ever allowed to go, so the bottom
    // edge of the frame lands on seabed rather than on the seam.
    const skirt = FLOOR_OVERSCAN + 2;
    seabedMesh = plane(w, SEABED_HEIGHT + skirt, CONFIG.colors.seabed, bounds.bottom + SEABED_HEIGHT / 2 - skirt / 2, SEABED_Z);
    backdrop.add(seabedMesh);

    // Animated water surface. The segment COUNT follows the width rather than
    // being fixed at the 140 that used to span the frame: the chop term of the
    // wave has a ~10-unit wavelength, and across a widened arena a fixed count
    // stretched each segment until the drawn line was sampling it about seven
    // times a cycle. The line then facets — and, worse, visibly separates from
    // the water fill beside it, which evaluates the same wave per PIXEL in
    // GLSL and does not coarsen with the arena.
    const segs = Math.max(140, Math.ceil(bounds.width * SURFACE_SEGMENTS_PER_UNIT));
    const pos = new Float32Array((segs + 1) * 3);
    for (let i = 0; i <= segs; i++) {
      pos[i * 3] = bounds.left + (bounds.width * i) / segs;
      pos[i * 3 + 1] = bounds.surfaceY;
      pos[i * 3 + 2] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // Transparent so the stroke can dissolve into the glow band at twilight —
    // see updateColors. Opaque, there is nothing to hand the seam over to.
    //
    // depthWrite OFF, and that is the half that makes the dissolve work. The
    // fog band sits behind this at z=-3.2 and draws AFTER it (renderOrder 1 vs
    // 0, and renderOrder is compared before depth in three's transparent sort),
    // so a line writing depth punches its own width straight through the fog:
    // fading the stroke out then uncovered the raw seam instead of handing it
    // over, which is the exact opposite of what lineTwilightFade is for.
    surfaceLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: CONFIG.colors.surface, transparent: true, depthWrite: false,
    }));
    surfaceLine.position.z = -3;
    backdrop.add(surfaceLine);
  }

  // Colour and shader-uniform updates only — no geometry rebuild, so this can
  // run every frame and tuner sliders apply with zero lag.
  function updateColors(dt) {
    updateLighting();
    waterClock += dt;
    // The sky owns the background colour now: nothing should ever be visible
    // past the sky plane, but where the frame does run off its edge the seam
    // has to be the colour of the band it meets, not a fixed midnight blue.
    if (skyMesh) {
      const horizon = updateSkyMaterial(skyMesh.material, waterClock);
      if (scene.background) scene.background.copy(horizon);
    } else if (scene.background) {
      scene.background.set(CONFIG.colors.sky);
    }
    // Parallaxed against the FRAMED camera position, which updateCamera
    // records below — never against camera.position itself, which by the time
    // this runs also carries the frame's shake. One frame behind, like the
    // grid and the hex tiles, and at a fifteenth of the camera's speed that
    // is not a thing anyone can see.
    // waveT, because the halos dissolve into the water line per pixel. Safe to
    // read here: updateSurface advances it before it calls this, so this is the
    // curve being drawn on this frame rather than the previous one's.
    //
    // The FRAME goes with it — the sun and moon are fitted into the shot, and
    // the shot is an asymmetric frustum at a zoom that moves (viewCentre is 15
    // units below the camera at the default framing, so "the camera's y" is not
    // the middle of what you can see). Built from the same banked anchor as the
    // drift above, so both are measured against the framing rather than against
    // the shake.
    celestials.update(camAnchor.x, waveT, framedView(), dt);
    // No parallax on this one, and that is not an oversight. The sky plane's
    // own star field is painted from vWorldPos on a mesh that never moves, so
    // it is welded to the world; the constellations are drawn between those
    // exact stars, and a layer that drifted against them at even a fifteenth
    // of the camera's speed would visibly walk off its own field. It gets the
    // camera only so a finger on the glass can be resolved into the sky.
    constellations.update(dt, { camera });
    // The cloud decks parallax off the same banked anchor the sun and moon do
    // — each layer at its own rate, which is the whole reason there are
    // several of them. See CONFIG.weather.clouds.layers.
    clouds.update(dt, camAnchor.x);
    if (seabedMesh) seabedMesh.material.color.set(CONFIG.colors.seabed);
    if (depthLines) depthLines.material.color.set(CONFIG.colors.depthLine);
    if (surfaceLine) {
      const hg = CONFIG.horizonGlow;
      const tw = CONFIG.dayNight?.enabled ? skyLight.twilight : 0;
      // Past 1 on purpose: the bright-pass is what gives the stroke a halo,
      // and a line clamped to its own colour is the flat 1px rule this was
      // meant to stop being.
      surfaceLine.material.color.set(CONFIG.colors.surface)
        .multiplyScalar(hg?.enabled ? (hg.lineGain ?? 1) : 1);
      // ...and it steps aside as the sun crosses it. The hard edge is the
      // thing that wants softening at sunset, so the glow band takes the seam
      // over and the stroke comes back afterwards.
      // A global dial for how present the hard stroke is, on top of the
      // twilight dissolve — at low lineOpacity the seam is carried entirely
      // by the fog band and there is no hard edge in the frame at all.
      const base = hg?.enabled ? (hg.lineOpacity ?? 1) : 1;
      surfaceLine.material.opacity = base * (1 - tw * (hg?.enabled ? (hg.lineTwilightFade ?? 0) : 0));
    }
    if (waterMesh) {
      updateWaterMaterial(waterMesh.material, waterClock);
      // AFTER, never before: updateWaterMaterial is what resolves `liveCaustics`
      // for this frame, and reading it first would light every wet animal with
      // the previous frame's ocean. One frame is invisible on the tint and
      // obvious on the phase — the veins on the seal would lag the veins in the
      // water by a frame, which is the one artefact this whole layer cannot
      // survive.
      setNoiseWetEnv(liveCaustics);
    }
  }

  // The arena the backdrop, grid, stars and shore were last built for. Empty
  // rather than null so the first resize() — the one that builds the world at
  // startup — can never match it, whatever the window happens to be.
  let arenaSig = '';
  function arenaSignature() {
    // The ARENA only. frameWidth is deliberately absent: it is the one number
    // a window resize is allowed to move without anything being rebuilt, which
    // is the whole point of the split below.
    // frameTop is in here and frameWidth is not, and the asymmetry is exact:
    // the sky plane's gradient is normalised against frameTop (skyPlaneMetrics)
    // so a field-of-view change really does need a rebuild, while frameWidth
    // reaches nothing in the backdrop and moves on every single window resize —
    // including it would defeat the whole point of the cheap path below.
    return `${bounds.left},${bounds.right},${bounds.top},${bounds.bottom},${bounds.surfaceY}`
      + `,${bounds.frameTop}`
      + `,${CONFIG.arena.waveAmplitude},${CONFIG.weather?.sea?.amp ?? 1}`
      + `,${CONFIG.arena.showDepthLines},${CONFIG.arena.depthLineSpacing}`;
  }

  /** The frustum IS the frame, and the frame is the only thing a window owns. */
  function applyFrustum() {
    // They are the same rectangle at arena.widthScale / airScale 1; above that
    // the walls and the ceiling sit outside the frustum and the gap is what
    // the camera is free to pan across (see clampFocus). The floor is shared —
    // it is both.
    camera.right = bounds.frameWidth / 2;
    camera.left = -camera.right;
    camera.top = bounds.frameTop;
    // frameBottom, NOT bounds.bottom. They are the same line at the default
    // field of view and only the fov setting pulls them apart — but reading the
    // floor here would mean a widened view grew upward only, sliding the water
    // line down the screen instead of showing more of the water.
    camera.bottom = bounds.frameBottom;
    camera.near = -100;
    camera.far = 200;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    // After setSize, which resets the drawing buffer to the new CSS size at
    // the ratio three is holding. Re-asserted rather than left alone because
    // dragging a window between displays changes devicePixelRatio, and the cap
    // has to be re-applied to a ratio that moved.
    applyRenderScale();
  }

  /**
   * THE FULL REBUILD. Every path that can move the walls comes through here —
   * startup, and the `arena` branch of onTuningChanged in main.js, which is how
   * the tuner applies a change to viewHeight, widthScale, the wave amplitude
   * the water plane is sized for, or the depth-line spacing.
   */
  function resize() {
    updateBounds(window.innerWidth / window.innerHeight);
    applyFrustum();
    arenaSig = arenaSignature();
    buildBackdrop();
    grid.build();
    // Both are generated across the arena's own bounds, so a resize is a
    // rebuild — same as the grid, and for the same reason.
    constellations.build();
    wallRocks.build();
  }

  /**
   * THE WINDOW-RESIZE PATH, which is now a much smaller thing than a resize.
   *
   * Since the walls stopped being a function of the window's aspect (see
   * updateBounds in arena.js), everything in the backdrop group is invariant
   * under a window resize: the planes are `bounds.width * 1.2` wide and hung
   * off frameTop, and the grid, the star field and the shore all walk the
   * arena's own extents. Only the frustum and the drawing buffer actually move.
   *
   * It used to be the opposite, and violently. An orientation flip moved the
   * walls by 4.7x, so the game disposed and regenerated the entire backdrop, a
   * full-width grid, the constellation field and every shore boulder — mid-run,
   * on a phone, on precisely the frame a player is least able to absorb a
   * hitch. Worse than the cost: the seabed plant bed lives in world.scene
   * rather than the backdrop group (see scatterSeabed in main.js) and is NOT
   * re-seated by this path, so a flip that narrowed the arena left plants
   * standing outside the new walls.
   *
   * MEASURED AFTER updateBounds, not before, and that ordering is the whole
   * correctness of it. The signature is read off `bounds`, which is stale until
   * updateBounds has run — and there is still one case where a window really
   * does move the walls: a frame wider than the arena pushes them out to meet
   * it (the ultrawide clamp in updateBounds), so a drag onto a very wide
   * display has to fall through to the full rebuild. Checking first would miss
   * it and leave the shore drawn inside the shot.
   */
  function onWindowResize() {
    updateBounds(window.innerWidth / window.innerHeight);
    if (arenaSignature() !== arenaSig) { resize(); return; }
    applyFrustum();
  }

  // Set by main.js: what a flash SOUNDS like and what a strike DOES are
  // gameplay, and world.js only owns where and when it is drawn.
  let onLightning = null;
  function setLightningHandler(fn) { onLightning = fn; }

  function updateSurface(dt) {
    // THE SEA STATE, before anything at all. Four separate transcriptions of
    // the wave read this — the JS one in arena.js and the GLSL copies in the
    // water fill, the grid and the horizon fog — so it is published once, here,
    // and every one of them reads the same numbers on the same frame. A fill
    // clipped to a different wave than the line drawn on it is a visible tear.
    const seaCfg = CONFIG.weather?.sea;
    const swell = (CONFIG.weather?.enabled && seaCfg?.enabled !== false)
      ? (weatherState.swell ?? 0)
      : 0;
    setSeaState(
      CONFIG.arena.waveAmplitude * (1 + swell * ((seaCfg?.amp ?? 1) - 1)),
      swell * (seaCfg?.chop ?? 0),
    );

    // The wave next, because three things below solve against it and all of
    // them have to use the curve this frame draws rather than the last one's.
    // A rough sea runs faster as well as higher — the same swell drives both,
    // and speeding up a phase accumulator is smooth, so this can ride a live
    // value without the surface ever jumping.
    waveT += dt * CONFIG.arena.waveSpeed * (1 + swell * ((seaCfg?.speed ?? 1) - 1));

    // Lightning BEFORE the paint. It is what RAISES the flash, and everything
    // that renders the flash — the sky gradient, the caustics, the beams —
    // reads it off the light bus during updateColors just below. Run after,
    // and the bolt is drawn a full frame before the sky it lit up.
    lightning.update(dt, waveT, onLightning);
    refreshFlash();

    // Same waveT as the fill's clip and the drawn line below, so all three
    // sit on one curve. Before updateColors, which reads the twilight the
    // glow is about to be drawn at.
    horizonGlow.update(dt, waveT);

    updateColors(dt);
    if (!surfaceLine) return;
    // Before the line geometry is rewritten from the same waveT, so a drop
    // lands on the wave that is about to be drawn — a frame's worth of
    // disagreement is a splash visibly hanging above (or inside) the water.
    rain.update(dt, waveT);
    // The grid clips itself to this same line, so it has to be told where the
    // wave is. Pushed from here rather than pulled in grid.update() because
    // waveT belongs to the surface, not to the grid.
    grid.setWaveTime(waveT);
    // Same push, same reason: the night sky hazes out at the water line, and
    // it has to fade against the curve this frame draws rather than the last
    // one's or the seam crawls.
    constellations.setWaveTime(waveT);
    // Same reasoning for the fill, which clips itself to the wave: it has to be
    // cut on the curve this frame draws, not the previous one.
    if (waterMesh) setWaterWaveTime(waterMesh.material, waveT);
    // And for everyone who isn't a shader — bubbles bursting at the water line
    // read the curve straight out of arena.js.
    setWaveTime(waveT);
    const attr = surfaceLine.geometry.attributes.position;
    for (let i = 0; i < attr.count; i++) {
      attr.setY(i, surfaceHeightAt(attr.getX(i), waveT));
    }
    attr.needsUpdate = true;
  }

  // --- camera punch ---------------------------------------------------------
  // A hit of zoom that lands instantly and eases back out — the lens leaning
  // in, as opposed to `shake`, which rattles the camera without changing what
  // is in frame. Kept as a separate channel for that reason: a food chain
  // extending wants weight, not noise.
  let punch = 0;

  function punchCamera(amount) {
    const cfg = CONFIG.camera.punch;
    if (!cfg?.enabled || !(amount > 0)) return;
    // Instant attack (no ramp toward a target) is the whole point — a punch
    // that eases IN reads as a slow push, which is the opposite feeling.
    punch = Math.min(cfg.max ?? 0.14, punch + amount);
  }

  function updatePunch(dt, pushZoom) {
    if (punch > 0) {
      punch *= Math.exp(-(CONFIG.camera.punch?.decay ?? 7) * dt);
      if (punch < 0.0005) punch = 0;
    }
    // Written every frame rather than only while punching, so switching the
    // effect off mid-punch (or a leftover zoom from the previous run) snaps
    // back to 1 instead of sticking wherever it was.
    //
    // The death dive's push multiplies IN rather than replacing: a kill
    // landing on the frame you die should still register as a punch on top of
    // the push, the same way it would at any other moment.
    const zoom = (1 + punch) * pushZoom;
    if (camera.zoom !== zoom) {
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
    }
  }

  // --- focus framing --------------------------------------------------------
  // A claim on the frame: put THIS point in the middle of it, at this zoom,
  // this much of the way from wherever the camera would otherwise have been.
  // Claimed per frame like the sustained shake channel, so nothing has to
  // remember to release it — the death dive is the only caller (see
  // systems/deathDive.js), and when it stops claiming, the frame comes back on
  // its own.
  //
  // `weight` is what makes it a push rather than a cut: at 0 the camera sits
  // exactly where the normal rules put it, at 1 the point is dead centre, and
  // easing between them slides the frame across.
  let focus = null;

  function focusCamera(pos, zoom = 1, weight = 1) {
    focus = { x: pos.x, y: pos.y, zoom: Math.max(0.05, zoom), weight: Math.max(0, Math.min(1, weight)) };
  }

  function applyFocus() {
    if (!focus) return;
    const c = viewCentre();
    const at = clampFocus(focus.x, focus.y, camera.zoom, true);
    camera.position.x += (at.x - c.x - camera.position.x) * focus.weight;
    camera.position.y += (at.y - c.y - camera.position.y) * focus.weight;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // --- frustum geometry ------------------------------------------------------
  // Everything that wants to talk about the frame in world terms goes through
  // these: applyFocus above, and the cinematic rig, which thinks entirely in
  // FOCUS POINTS ("centre this bit of ocean") and knows nothing about an
  // asymmetric orthographic frustum or where the seabed strip runs out.
  //
  // The important fact, and the one the previous version of applyFocus had
  // backwards: three scales an orthographic frustum about its own CENTRE, not
  // about the camera's origin. See OrthographicCamera.updateProjectionMatrix —
  // it takes cx = (left + right) / 2 and builds the zoomed frustum as
  // cx ± (right - left) / (2 * zoom). So the middle of the view sits at the
  // camera's position plus cx, at EVERY zoom; the offset does not shrink as
  // you zoom in. Dividing it by the zoom (as this file used to) puts the
  // subject progressively further off centre the harder the shot pushes in,
  // and it was also why the frame could sail below the seabed on a deep death.

  function viewCentre() {
    return {
      x: (camera.left + camera.right) / 2,
      y: (camera.top + camera.bottom) / 2,
    };
  }

  function halfExtents(zoom) {
    return {
      w: (camera.right - camera.left) / (2 * zoom),
      h: (camera.top - camera.bottom) / (2 * zoom),
    };
  }

  // What is on screen right now, in world units, as a centre and two half
  // extents. The two facts it exists to fold together: the frustum's centre is
  // NOT the camera's position (it sits `viewCentre` below it, which at the
  // default framing is fifteen units), and the zoom shrinks the extents about
  // that centre rather than about the camera. Anything asking "would this be
  // cropped?" needs both, and getting either wrong is an answer that is right
  // at zoom 1 and quietly wrong everywhere else.
  //
  // Measured from the BANKED framing (camAnchor), not camera.position, for the
  // reason camAnchor exists at all: by the time this is read the caller has
  // shaken the camera, and a frame that jittered would push the sky around in
  // antiphase to every explosion.
  function framedView() {
    const c = viewCentre();
    const half = halfExtents(camera.zoom);
    return { x: camAnchor.x + c.x, y: camAnchor.y + c.y, halfW: half.w, halfH: half.h };
  }

  // SIDEWAYS OVERSCAN — how far past a wall the frame is allowed to drift.
  // The frame used to stop with its edge exactly on bounds.left / bounds.right,
  // which meant the seal could still swim a half-body further than the camera
  // could follow, and the shot pinned it against the edge of the screen to do
  // it. A little give either side lets the frame keep the seal off the bezel
  // right up to the wall.
  //
  // What it may spend is not a written number: it is the depth of the drawn
  // rock face at its THINNEST point, measured off the built geometry by
  // wallRocks (see measureCover there). Drift only into rock and the frame can
  // never show open water outside the shore, at any height — which is the
  // whole constraint. It has to be measured because the wall is a lumpy stack
  // of boulders whose depth falls out of a seed, a size range and a taper: a
  // number typed here is right until the next time any of the three moves.
  // `camera.edgeDrift` is the ceiling on it, so the tuner can ask for less
  // than the rock allows but never for more.
  //
  // Zero when the shore is off or hasn't been built: with nothing drawn out
  // there, there is nothing to hide behind and the frame stops on the wall
  // exactly as it always did.
  // Deferred to wallRocks (see shoreOverscan there) rather than computed here,
  // because the SPAWNER needs the same answer: it is the line past which
  // nothing can be on screen, and a creature entering from just outside a
  // frame that could actually reach a little further is pop-in with extra
  // steps. One function, two readers, no chance of the two disagreeing.
  function sideOverscan() {
    return shoreOverscan();
  }

  // Where a focus point is allowed to be: a half-frame in from each wall, less
  // whatever overscan that edge has to spend, so the frame never runs past the
  // scenery onto the bare background. The floor is the largest of them —
  // FLOOR_OVERSCAN of seabed hangs below the arena, because a body at rest ON
  // the floor would otherwise sit jammed against the bottom edge of the shot.
  //
  // At zoom 1 the frustum is exactly the arena, so both ranges collapse to a
  // single point (the arena's centre) and there is nowhere to pan — which is
  // why the cinematic rig's zoom floor sits above 1. Below zoom 1 they invert,
  // hence the degenerate branch: with the frame wider than the ocean the only
  // sensible answer is dead centre, not whichever bound `clamp` reached first.
  //
  // Split out from clampFocus so the cinematic rig can EASE into these rather
  // than be cut off at them: a spring that is hard-clamped arrives at the wall
  // still travelling, and the frame stops dead. The rig softens its own target
  // against the same four numbers — see softLimit in cineCamera.js — and the
  // clamp below stays as the backstop it always was.
  function focusLimits(zoom, allowFloorOverscan = false) {
    const half = halfExtents(zoom);
    const spend = allowFloorOverscan ? FLOOR_OVERSCAN : 0;
    const side = sideOverscan();
    return {
      loX: bounds.left + half.w - side,
      hiX: bounds.right - half.w + side,
      loY: bounds.bottom + half.h - spend,
      hiY: bounds.top - half.h,
    };
  }

  function clampFocus(x, y, zoom, allowFloorOverscan = false) {
    const { loX, hiX, loY, hiY } = focusLimits(zoom, allowFloorOverscan);
    return {
      x: loX > hiX ? (bounds.left + bounds.right) / 2 : clamp(x, loX, hiX),
      y: loY > hiY ? (bounds.bottom + bounds.top) / 2 : clamp(y, loY, hiY),
    };
  }

  // World point -> screen uv, for the tilt-shift focal point. By hand rather
  // than through Vector3.project because the projection matrix on the camera
  // is one frame stale by the time the lens is published, and because this
  // needs no matrix work for what is two multiplies.
  function projectAt(x, y, zoom, camX, camY) {
    const c = viewCentre();
    return {
      u: 0.5 + ((x - camX - c.x) * zoom) / (camera.right - camera.left),
      v: 0.5 + ((y - camY - c.y) * zoom) / (camera.top - camera.bottom),
    };
  }

  const cineCtx = {
    target: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
    dashDir: { x: 0, y: 0 },
    dashReach: 0,
    chargePower: 0,
    strikeHeld: false,
    charging: false,
    boosting: false,
    deathPhase: 'none',
    deathElapsed: 0,
    clampFocus,
    focusLimits,
    halfExtents,
  };

  function updateCamera(targetPos, dt, signals) {
    // Ahead of the follow gate, not inside it: the punch is independent of
    // whether the camera tracks the player, and `followPlayer` is off in the
    // saved tuning — behind the early return it would simply never run.
    //
    // The cinematic rig's zoom multiplies into the same chain rather than
    // replacing it: a food-chain punch or a death push-in has to keep landing
    // on top of the rig's framing, exactly as it does on the fixed frame.
    let cine = null;
    if (cineEnabled()) {
      cineCtx.target.x = targetPos.x;
      cineCtx.target.y = targetPos.y;
      cineCtx.velocity.x = signals?.velocity?.x ?? 0;
      cineCtx.velocity.y = signals?.velocity?.y ?? 0;
      cineCtx.aim.x = signals?.aim?.x ?? 0;
      cineCtx.aim.y = signals?.aim?.y ?? 0;
      cineCtx.dashDir.x = signals?.dashDir?.x ?? 0;
      cineCtx.dashDir.y = signals?.dashDir?.y ?? 0;
      cineCtx.dashReach = signals?.dashReach ?? 0;
      cineCtx.chargePower = signals?.chargePower ?? 0;
      cineCtx.strikeHeld = !!signals?.strikeHeld;
      cineCtx.charging = !!signals?.charging;
      cineCtx.boosting = !!signals?.boosting;
      cineCtx.deathPhase = signals?.deathPhase ?? 'none';
      cineCtx.deathElapsed = signals?.deathElapsed ?? 0;
      cine = updateCineCamera(dt, cineCtx);
    }

    // The rig's zoom hands over to the death dive on the same ramp its
    // FRAMING does. `focus.weight` is already "how much of the shot the dive
    // owns", so fading the rig's contribution out against it means the two
    // push-ins can't compound: on the seabed the dive lands on exactly the
    // 1.8 it is tuned for, not on 1.8 times whatever the floor-hit state
    // asked for. The first beat still punches at full strength, because
    // weight is ~0 for the tenth of a second that beat lasts.
    //
    // Only the ZOOM hands over. The rig keeps the lens for the whole
    // sequence — the dive has no opinion about focus falloff or flares.
    const cineZoom = cine ? 1 + (cine.zoom - 1) * (1 - (focus?.weight ?? 0)) : 1;
    updatePunch(dt, (focus?.zoom ?? 1) * cineZoom);

    if (cine) {
      // Converted at the zoom the camera ENDED UP at, not the one the rig
      // asked for. This frustum is asymmetric, so half of it is a function of
      // the zoom — offset by the rig's zoom while the punch has pushed the
      // real one higher and the seal drifts off the centre the spring just
      // worked out, by more the harder the punch lands.
      //
      // Re-clamped at that final zoom too. Zooming IN only widens the range
      // of legal focus points, so the punch alone could never invalidate what
      // the rig already clamped — but the death handover above zooms the rig
      // back OUT, which narrows it, and a focus point the rig settled on at
      // 1.35 can be outside the arena by the time it reaches 1.1.
      const at = clampFocus(cine.x, cine.y, camera.zoom, focus != null);
      const c = viewCentre();
      camera.position.x = at.x - c.x;
      camera.position.y = at.y - c.y;
    } else if (CONFIG.camera.followPlayer) {
      const t = 1 - Math.pow(1 - CONFIG.camera.followLerp, dt * 60);
      camera.position.x += (targetPos.x - camera.position.x) * t;
    } else if (bounds.width > camera.right - camera.left) {
      // A widened arena (arena.widthScale > 1) with neither the rig nor
      // followPlayer running. Pinned at 0 the camera would let the seal swim
      // straight off the side of the screen and fight a wall it cannot see,
      // so it has to track — clamped, so the frame still never runs past the
      // water plane onto the bare scene background.
      const t = 1 - Math.pow(1 - CONFIG.camera.followLerp, dt * 60);
      const at = clampFocus(targetPos.x, targetPos.y, camera.zoom);
      camera.position.x += (at.x - viewCentre().x - camera.position.x) * t;
      camera.position.y = 0;
    } else {
      camera.position.x = 0;
      camera.position.y = 0;
    }

    // Last, and from whatever the rules above left behind, so the push blends
    // out of the normal framing instead of fighting it. With the rig running
    // this is what lets the death dive take the shot over from it: at
    // camWeight 0 the rig's framing stands, at 1 the dive owns it outright,
    // and the ramp between them is the handover.
    applyFocus();
    focus = null;

    // The tilt-shift focal point has to be where the seal ACTUALLY ended up,
    // after the focus claim and before the shake — a focus point computed
    // before applyFocus drifts off the seal for the whole death sequence.
    //
    // ...and it is the seal in every state but one. `cineSubject` is the boss
    // reveal saying the shot is of something else; without it the sharp disc
    // stays on a player who is by then at the edge of frame, and the animal the
    // whole shot exists for is the blurred thing next to it.
    if (cine && cineLens.active) {
      const on = cineSubject.active ? cineSubject : targetPos;
      const uv = projectAt(on.x, on.y, camera.zoom, camera.position.x, camera.position.y);
      cineLens.focusX = uv.u;
      cineLens.focusY = uv.v;
      // The corridor's reach is smoothed by the rig in WORLD units and turned
      // into uv here, at the zoom the camera ended up at, with the same
      // divide projectAt uses for the focal point — so the far end of the
      // cone lands on the world point the dash would reach, punch and all.
      cineLens.pathLength = (cineLens.pathReach * camera.zoom) / (camera.top - camera.bottom);
    }

    // The framing, banked before the caller shakes the camera on top of it.
    // Everything that parallaxes off the camera reads this instead.
    camAnchor.set(camera.position.x, camera.position.y);
  }

  resize();
  window.addEventListener('resize', onWindowResize);

  // `halfExtents` goes out for the same reason the cinematic rig is handed it:
  // anything that has to decide whether two things FIT in the shot needs the
  // frame in world units, and that is a fact about this asymmetric frustum
  // that nothing outside this file can work out for itself. See applyFraming
  // in systems/bossKill.js, which frames the seal and the boss it just killed.
  return { scene, camera, renderer, resize, applyRenderScale, tickAdaptiveScale, adaptiveScale, resetAdaptiveScale, buildArena: buildBackdrop, updateCamera, punchCamera, focusCamera, halfExtents, framedView, updateSurface, updateColors, updateLighting, grid, constellations, wallRocks, rain, lightning, setLightningHandler };
}
