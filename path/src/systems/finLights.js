import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { FLIPPER_SIDES } from '../flipperSide.js';
import { finElements, activeElement, elementColor, elementGlow, levelOf } from './elements.js';

// ============================================================================
// FIN LIGHTS — the colour a flipper wears once Flippers Up! has lit it.
//
// WHY THE FIN AND NOT THE SEAL. The run's Glow Up! element is painted on the
// whole animal (updateElementSkin -> setNoiseGlow), which is exactly right for
// a thing the whole animal is carrying. A flipper's element is not: the two fins
// can hold different ones, and the entire point of the card is that you can tell
// which fin is about to throw what. A body-wide wash cannot say that, and there
// is only one of it.
//
// WHY A LIGHT AND NOT A SKIN TINT. The seal is one skinned mesh with one
// material, so painting one flipper means a per-vertex mask weighted off the fin
// bones and a second branch inside the shader that already owns the animal's
// shading — where a GLSL error renders NOTHING AT ALL and no Node harness can
// see it. A lamp held at the muzzle costs two meshes, is unmistakable at a
// glance, and sits exactly where the pebble is about to leave from.
//
// ITS OWN MATERIALS, DELIBERATELY. Every primitive asset in the game shares one
// material (see getMaterial in assets.js), so two lamps built through
// createVisual could never be two colours — colouring one would colour both, and
// the whole read would collapse to whichever fin was updated last.
//
// THE MIX IS NOISE. With a Glow Up! element underneath, a fin holds two colours
// at once: its own and the run's. Alternating them on a clean sine reads as a
// pair of blinking indicator lamps; a value-noise wander between them reads as
// two things actually mingling in the water, which is what they are. The two
// fins run the same field at different offsets, so they drift in and out of
// agreement rather than strobing together.
// ============================================================================

const lights = new Map(); // side -> { mesh, mat }
let geo = null;
let clock = 0;

function cfg() {
  return CONFIG.finLights ?? {};
}

// Value noise over one dimension, smoothstepped between integer samples. The
// same shape the band shader uses in two, for the same reason: a sine is a
// pattern the eye locks onto, and this is not.
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}
function noise1(t) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

function lampFor(scene, side) {
  let l = lights.get(side);
  if (l) return l;
  if (!geo) geo = new THREE.SphereGeometry(1, 10, 8);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    // Additive, and depth-write off with it: this is light in water rather than
    // a bead stuck to the flipper, and a lamp that z-rejected the fin it is
    // sitting on would punch a hole in the animal.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  mesh.renderOrder = 3;
  scene.add(mesh);
  l = { mesh, mat };
  lights.set(side, l);
  return l;
}

/**
 * Put a lamp on every lit flipper. Call once a frame with the player's aim rig;
 * `rig.muzzles` is index-aligned to FLIPPER_SIDES (see the fin defs in
 * assets.js, which test:flippers holds to that order).
 *
 * `rawDt` rather than gameplay dt: the light keeps wandering through hitstop and
 * through the cards, the same way the seal's own breath does. A lamp that froze
 * with the water would read as the effect having crashed.
 */
export function updateFinLights(scene, rig, rawDt = 0) {
  const c = cfg();
  if (!scene) return;
  if (c.enabled === false || !rig?.muzzles?.length) {
    for (const l of lights.values()) l.mesh.visible = false;
    return;
  }

  clock += rawDt * (c.mixSpeed ?? 0.55);
  const fins = finElements();
  const run = activeElement();
  const runLit = run && levelOf(run) > 0;
  // ONE number for how much of any element is showing at this hour, shared with
  // the seal's skin and the pellet's tint so the animal, its lamps and its
  // ammunition are lit to the same degree at every time of day.
  const glow = elementGlow();

  for (let i = 0; i < FLIPPER_SIDES.length; i++) {
    const side = FLIPPER_SIDES[i];
    const id = fins[side];
    const lv = id ? levelOf(id) : 0;
    const muzzle = rig.muzzles[i];
    if (!id || lv <= 0 || !muzzle) {
      const existing = lights.get(side);
      if (existing) existing.mesh.visible = false;
      continue;
    }

    const l = lampFor(scene, side);
    l.mesh.visible = true;
    l.mesh.position.copy(muzzle);

    // A HALF-OFFSET BETWEEN THE FINS, so the two lamps sample the same wander at
    // different points and are never in lockstep. `i * 0.5` and not a random
    // phase: the offset has to survive a reset, or the pair would agree on some
    // runs and not others for no reason the player could see.
    let col = elementColor(id);
    if (runLit && run !== id) {
      const n = noise1(clock + i * 0.5);
      // Pushed off the middle so each colour gets a real turn at being ITSELF
      // rather than the pair spending most of the time as a muddy average.
      const t = Math.max(0, Math.min(1, (n - 0.5) * (c.mixContrast ?? 2.6) + 0.5));
      col = new THREE.Color(elementColor(id)).lerp(new THREE.Color(elementColor(run)), t).getHex();
    }
    l.mat.color.set(col);

    // Size and brightness both climb with the fin's own level, so a deepened
    // flipper is visibly the deeper one of the pair.
    const size = (c.size ?? 0.26) * (1 + (c.sizePerLevel ?? 0.22) * (lv - 1));
    l.mesh.scale.setScalar(size);
    l.mat.opacity = Math.max(0, Math.min(1, (c.opacity ?? 0.85) * glow));
  }
}

/**
 * The colour one fin is showing RIGHT NOW, or null for a fin with nothing on it.
 *
 * Read by the muzzle flash, so the burst leaving a flipper is the colour the
 * flipper is currently wearing rather than the element's flat hue. That is what
 * makes the alternation legible: with a Glow Up! underneath, consecutive shots
 * off the same fin come out at different points of the wander, so the flashes
 * drift between the two colours instead of every one of them being the average.
 *
 * The LAST value written by updateFinLights rather than a fresh sample — the
 * lamp and the flash have to be the same colour on the same frame, and
 * recomputing here would put them a wander-step apart.
 */
export function finLightColor(side) {
  const l = lights.get(side);
  return l && l.mesh.visible ? l.mat.color.getHex() : null;
}

/** Drop the lamps. For a run reset and a model swap. */
export function resetFinLights(scene) {
  for (const l of lights.values()) {
    scene?.remove(l.mesh);
    l.mat.dispose();
  }
  lights.clear();
  clock = 0;
}
