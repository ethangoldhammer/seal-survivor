import * as THREE from 'three';
import { CONFIG } from './config.js';
import { bounds, updateBounds, surfaceHeightAt } from './arena.js';
import { createGrid } from './systems/grid.js';
import { createHexTiles } from './systems/hexTiles.js';
import { createWaterMaterial, updateWaterMaterial } from './systems/water.js';

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

  // Sky, seabed and the depth-line grid keep their materials across rebuilds
  // so colour changes can update them in place every frame with no rebuild —
  // only their geometry (size/position) needs to change on resize.
  let skyMesh = null, seabedMesh = null, depthLines = null, waterMesh = null;
  let waterClock = 0;

  let surfaceLine = null;
  let waveT = 0;

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

    skyMesh = plane(w, airH, CONFIG.colors.sky, bounds.surfaceY + airH / 2, -6);
    backdrop.add(skyMesh);

    const waterMat = createWaterMaterial();
    waterMat.uniforms.uCenter.value.set(0, bounds.surfaceY - seaH / 2);
    waterMat.uniforms.uSurfaceY.value = bounds.surfaceY;
    waterMat.uniforms.uBottomY.value = bounds.bottom;
    waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, seaH), waterMat);
    waterMesh.position.set(0, bounds.surfaceY - seaH / 2, -6);
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
    if (scene.background) scene.background.set(CONFIG.colors.sky);
    if (skyMesh) skyMesh.material.color.set(CONFIG.colors.sky);
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
    // The grid clips itself to this same line, so it has to be told where the
    // wave is. Pushed from here rather than pulled in grid.update() because
    // waveT belongs to the surface, not to the grid.
    grid.setWaveTime(waveT);
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
    const z = camera.zoom;
    // Zooming an orthographic frustum scales it about the CAMERA's origin, and
    // this one is asymmetric (the water line sits at a fixed fraction of the
    // screen), so the centre of the view is not the camera's position — it's
    // offset by half the frustum, shrunk by the zoom. Ignoring that put the
    // seal a third of a screen off centre, worse the further it zoomed in.
    const midX = (camera.left + camera.right) / (2 * z);
    const midY = (camera.top + camera.bottom) / (2 * z);
    // Never past the edges of the ocean: the water plane stops at the arena
    // bounds and a frame that runs past it shows the raw background instead.
    // The floor is the one exception — FLOOR_OVERSCAN of seabed hangs below
    // the arena for the frame to spend, because a body at rest ON the floor
    // would otherwise sit jammed against the bottom edge of the shot.
    const wantX = clamp(focus.x - midX, bounds.left * (1 - 1 / z), bounds.right * (1 - 1 / z));
    const wantY = clamp(
      focus.y - midY,
      bounds.bottom * (1 - 1 / z) - FLOOR_OVERSCAN,
      bounds.top * (1 - 1 / z),
    );
    camera.position.x += (wantX - camera.position.x) * focus.weight;
    camera.position.y += (wantY - camera.position.y) * focus.weight;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function updateCamera(targetPos, dt) {
    // Ahead of the follow gate, not inside it: the punch is independent of
    // whether the camera tracks the player, and `followPlayer` is off in the
    // saved tuning — behind the early return it would simply never run.
    updatePunch(dt, focus?.zoom ?? 1);

    if (CONFIG.camera.followPlayer) {
      const t = 1 - Math.pow(1 - CONFIG.camera.followLerp, dt * 60);
      camera.position.x += (targetPos.x - camera.position.x) * t;
    } else {
      camera.position.x = 0;
      camera.position.y = 0;
    }

    // Last, and from whatever the rules above left behind, so the push blends
    // out of the normal framing instead of fighting it.
    applyFocus();
    focus = null;
  }

  resize();
  window.addEventListener('resize', resize);

  return { scene, camera, renderer, resize, buildArena: buildBackdrop, updateCamera, punchCamera, focusCamera, updateSurface, updateColors, updateLighting, grid, hexTiles };
}
