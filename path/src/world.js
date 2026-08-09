import * as THREE from 'three';
import { CONFIG } from './config.js';
import { bounds, updateBounds, surfaceHeightAt, setWaveTime } from './arena.js';
import { createGrid } from './systems/grid.js';
import { createHexTiles } from './systems/hexTiles.js';
import { createWaterMaterial, updateWaterMaterial, setWaterWaveTime } from './systems/water.js';
import { createSkyMaterial, updateSkyMaterial } from './systems/sky.js';
import { createCelestials } from './systems/celestial.js';
import { createClouds } from './systems/clouds.js';
import { createRain } from './systems/weather.js';
import { updateCineCamera, cineLens, cineEnabled } from './systems/cineCamera.js';

// How far below the seabed the frame may travel, in world units, and equally
// how far the seabed strip is extended down to meet it. One constant for both
// because they are the same number seen from two sides: let the camera past
// what the backdrop covers and you see the bare scene background under the
// ocean floor. Only the death dive's framing ever spends it (see focusCamera).
const FLOOR_OVERSCAN = 7;

export function createWorld(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.colors.sky);

  // Asymmetric orthographic frustum: the water line sits at y = 0, and the
  // top/bottom are offset so the surface lands at `surfaceFromTop` of the view.
  const camera = new THREE.OrthographicCamera();
  camera.position.set(0, 0, 40);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Per-material clipping planes, used by exactly one thing: the horizon that
  // cuts the sun and moon off at the water line (see systems/celestial.js).
  // Materials that don't ask for a plane are unaffected.
  renderer.localClippingEnabled = true;
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

  const grid = createGrid(scene);
  const hexTiles = createHexTiles(scene);

  // The sky systems live OUTSIDE the backdrop group on purpose. The backdrop
  // is torn down and rebuilt on every resize, and these three hold things
  // that must not be thrown away with it — a loaded sun texture, a pool of
  // raindrops mid-fall, a scrolling cloud offset. All three size themselves
  // off `bounds` each frame instead, so a resize needs nothing from them.
  const celestials = createCelestials(scene);
  const clouds = createClouds(scene);
  const rain = createRain(scene);

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

    const skyMat = createSkyMaterial();
    skyMat.uniforms.uCenter.value.set(0, bounds.surfaceY + airH / 2);
    skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, airH), skyMat);
    skyMesh.position.set(0, bounds.surfaceY + airH / 2, -6);
    backdrop.add(skyMesh);

    // The fill runs WAVE_HEADROOM above the still-water line and its shader
    // clips itself back down to the wave curve, so the top of the water rides
    // the swell. The headroom is a fixed constant rather than a multiple of
    // waveAmplitude because the amplitude is a live tuner slider and this
    // geometry is only rebuilt on resize — it covers the slider's maximum (2)
    // at the two sine terms' combined 1.5x, with room to spare.
    const WAVE_HEADROOM = 4;
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
    waterMesh.position.set(0, waterCY, -5.4);
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
    seabedMesh = plane(w, 1.2 + skirt, CONFIG.colors.seabed, bounds.bottom + 0.6 - skirt / 2, -4);
    backdrop.add(seabedMesh);

    // Animated water surface.
    const segs = 140;
    const pos = new Float32Array((segs + 1) * 3);
    for (let i = 0; i <= segs; i++) {
      pos[i * 3] = bounds.left + (bounds.width * i) / segs;
      pos[i * 3 + 1] = bounds.surfaceY;
      pos[i * 3 + 2] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    surfaceLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: CONFIG.colors.surface }));
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
    celestials.update(camAnchor.x);
    clouds.update(dt);
    if (seabedMesh) seabedMesh.material.color.set(CONFIG.colors.seabed);
    if (depthLines) depthLines.material.color.set(CONFIG.colors.depthLine);
    if (surfaceLine) surfaceLine.material.color.set(CONFIG.colors.surface);
    if (waterMesh) updateWaterMaterial(waterMesh.material, waterClock);
  }

  function resize() {
    const aspect = window.innerWidth / window.innerHeight;
    updateBounds(aspect);
    camera.left = bounds.left;
    camera.right = bounds.right;
    camera.top = bounds.top;
    camera.bottom = bounds.bottom;
    camera.near = -100;
    camera.far = 200;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    buildBackdrop();
    grid.build();
  }

  function updateSurface(dt) {
    updateColors(dt);
    if (!surfaceLine) return;
    waveT += dt * CONFIG.arena.waveSpeed;
    // After waveT advances and before the line geometry is rewritten from it,
    // so a drop lands on the wave that is about to be drawn — a frame's worth
    // of disagreement is a splash visibly hanging above (or inside) the water.
    rain.update(dt, waveT);
    // The grid clips itself to this same line, so it has to be told where the
    // wave is. Pushed from here rather than pulled in grid.update() because
    // waveT belongs to the surface, not to the grid.
    grid.setWaveTime(waveT);
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

  // Where a focus point is allowed to be: at least a half-frame in from each
  // wall, so the frame never runs past the water plane onto the bare scene
  // background. The floor is the one exception — FLOOR_OVERSCAN of seabed
  // hangs below the arena for the frame to spend, because a body at rest ON
  // the floor would otherwise sit jammed against the bottom edge of the shot.
  //
  // At zoom 1 the frustum is exactly the arena, so both ranges collapse to a
  // single point (the arena's centre) and there is nowhere to pan — which is
  // why the cinematic rig's zoom floor sits above 1. Below zoom 1 they invert,
  // hence the degenerate branch: with the frame wider than the ocean the only
  // sensible answer is dead centre, not whichever bound `clamp` reached first.
  function clampFocus(x, y, zoom, allowFloorOverscan = false) {
    const half = halfExtents(zoom);
    const spend = allowFloorOverscan ? FLOOR_OVERSCAN : 0;
    const loX = bounds.left + half.w, hiX = bounds.right - half.w;
    const loY = bounds.bottom + half.h - spend, hiY = bounds.top - half.h;
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
    chargePower: 0,
    strikeHeld: false,
    charging: false,
    boosting: false,
    deathPhase: 'none',
    deathElapsed: 0,
    clampFocus,
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
    if (cine && cineLens.active) {
      const uv = projectAt(targetPos.x, targetPos.y, camera.zoom, camera.position.x, camera.position.y);
      cineLens.focusX = uv.u;
      cineLens.focusY = uv.v;
    }

    // The framing, banked before the caller shakes the camera on top of it.
    // Everything that parallaxes off the camera reads this instead.
    camAnchor.set(camera.position.x, camera.position.y);
  }

  resize();
  window.addEventListener('resize', resize);

  return { scene, camera, renderer, resize, buildArena: buildBackdrop, updateCamera, punchCamera, focusCamera, updateSurface, updateColors, updateLighting, grid, hexTiles, rain };
}
