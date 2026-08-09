import * as THREE from 'three';
import { CONFIG } from '../config.js';
import {
  addOutlineShells,
  makeOutlineMaterial,
  setOutlineThicknessOn,
  setSpawnDecorator,
} from '../assets.js';

// Procedural rims around a silhouette, so what matters stays findable in a
// crowded, dark, particle-heavy frame. Inverted-hull shells (assets.js
// addOutlineShells) — one extra draw call per mesh, no post pass, no per-frame
// work — driven live from CONFIG rather than baked into the asset defs,
// because this is a readability control you want to dial in while looking at
// the game.
//
// Two users, deliberately separate:
//
//   the PLAYER   CONFIG.playerOutline — one seal, its own colour. This is the
//                "where am I" rim.
//   CREATURES    CONFIG.creatureOutline — the apex predators and the other
//                large bodies, sharing one threat colour between them, each
//                with its own on/off switch. This is the "what's hunting me"
//                rim.
//
// Both attach to INSTANCES, never to the loaded template. Two reasons, and
// the second one is the expensive one:
//
//   1. the tuner's per-creature tint/glow walk the template's materials
//      (assets.js getAssetMaterials), so a shell living there would be
//      recoloured along with the creature.
//   2. SkeletonUtils.clone gives every SkinnedMesh in a cloned hierarchy its
//      OWN Skeleton object. A shell baked into the template would come out of
//      each clone with a skeleton separate from the creature's, and three
//      dedupes its per-frame skeleton.update() by skeleton object — so every
//      outlined creature would compute its bone matrices and upload its bone
//      texture twice a frame. Binding the shell to the instance's existing
//      skeleton keeps that at once.

const shellColor = new THREE.Color();

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

let playerShells = [];

// Build the shells for a freshly created seal body. Safe to call repeatedly —
// the previous set went away with the body that owned it, and its materials
// are dropped here rather than left to leak on every T-menu size change.
export function attachPlayerOutline(body) {
  for (const shell of playerShells) shell.material?.dispose();
  playerShells = body ? addOutlineShells(body, { color: CONFIG.playerOutline?.color ?? 0xffffff }) : [];
  applyPlayerOutline();
}

// Colour, glow, width and opacity, pushed onto the live materials. Disabling
// hides the shells rather than tearing them down, so the toggle costs nothing
// and can't get out of step with the body currently on screen.
export function applyPlayerOutline() {
  const cfg = CONFIG.playerOutline ?? {};
  for (const shell of playerShells) {
    shell.visible = cfg.enabled !== false;
    if (shell.material) applyLook(shell.material, cfg, accumulatedScale(shell));
  }
}

// ---------------------------------------------------------------------------
// Creatures
// ---------------------------------------------------------------------------

// asset key -> the one material every shell of that species shares. Sharing is
// what makes the tuner controls work on creatures already swimming: there is
// exactly one place to write a colour, a width or a `visible` flag, and every
// instance is looking at it.
const creatureMaterials = new Map();
// asset key -> the object-space scale its instances are built at, measured off
// the first one attached. Needed to keep `thickness` in world units; all
// instances of a key share a scale, so one measurement covers the species.
const creatureScales = new Map();

// Register the spawn hook and push the current look. Must run after
// preloadAssets/restoreUploadedModels (so the templates exist) and after
// applySavedAssetLooks (so size multipliers are known), but BEFORE the first
// createVisual call, or whatever spawned early comes up bare.
export function initCreatureOutlines() {
  setSpawnDecorator(attachCreatureOutline);
  applyCreatureOutlines();
}

// Called for every visual createVisual builds. Attaches shells to the ones
// configured for an outline and leaves everything else untouched.
//
// Deliberately attaches for any species PRESENT in `on`, whether its switch is
// currently true or false: the switch is then a `visible` flag on a material
// that already exists, so flipping it in the tuner shows up on the creatures
// on screen instead of only on things that spawn afterwards. An off species
// costs one node per spawn and no draw call — three skips a mesh whose
// material is invisible when it builds the render list.
function attachCreatureOutline(visual, key) {
  const on = CONFIG.creatureOutline?.on;
  if (!on || !(key in on)) return;

  let material = creatureMaterials.get(key);
  if (!material) {
    material = makeOutlineMaterial({ color: CONFIG.creatureOutline?.color ?? 0xffffff });
    creatureMaterials.set(key, material);
  }

  const shells = addOutlineShells(visual, { material });
  if (!shells.length) return;
  // No size-multiplier term here: createVisual applies it to the instance
  // BEFORE calling this hook, so walking the parent chain has already picked
  // it up. Multiplying it in again would count it twice and halve the rim on
  // a creature scaled to 2x.
  creatureScales.set(key, accumulatedScale(shells[0]));
  applyCreatureOutline(key);
}

// Push CONFIG onto every species' shared material. Cheap enough to fire from a
// slider's every input event — it's a handful of colour writes and one uniform
// per species, no rebuild and no traversal of anything in the scene.
export function applyCreatureOutlines() {
  for (const key of creatureMaterials.keys()) applyCreatureOutline(key);
}

function applyCreatureOutline(key) {
  const cfg = CONFIG.creatureOutline ?? {};
  const material = creatureMaterials.get(key);
  if (!material) return;
  // `visible` on the MATERIAL, not on the shells: the shells are per-instance
  // clones, so there is no single one to flip, but they all point at this.
  material.visible = cfg.on?.[key] === true;
  applyLook(material, cfg, creatureScales.get(key) ?? 1);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

// Colour x glow, opacity, and the world -> object thickness conversion. One
// function so the player's rim and a shark's cannot drift apart in how they
// interpret the same four numbers.
function applyLook(material, cfg, scale) {
  // Glow multiplies the colour past 1.0. That only means anything because the
  // scene renders to an HDR target, so the bloom bright-pass sees the true
  // value instead of a pre-clamped white — the same mechanism the per-asset
  // glow slider uses on unlit materials (assets.js applyColorAndGlow).
  shellColor.set(cfg.color ?? 0xffffff).multiplyScalar(Math.max(0, cfg.glow ?? 1));
  material.color.copy(shellColor);

  const opacity = cfg.opacity ?? 1;
  material.opacity = opacity;
  // `transparent` is the one property here that changes which program three
  // builds, so it's the only one that may set needsUpdate — and only when it
  // actually flips. Setting it unconditionally would recompile the shader on
  // every input event of the opacity slider.
  const wantTransparent = opacity < 1;
  if (material.transparent !== wantTransparent) {
    material.transparent = wantTransparent;
    material.needsUpdate = true;
  }

  // The shader offsets in object space, which the model's fit scale and the
  // T-menu size multiplier then blow up along with everything else — so a raw
  // number would mean a different rim width on every model, and an outline
  // that fattened as you scaled a creature up. Dividing by the scale keeps the
  // config value in WORLD units: the same on-screen width on a dolphin and on
  // a megalodon.
  const thickness = cfg.thickness ?? 0;
  setOutlineThicknessOn(material, scale > 1e-6 ? thickness / scale : thickness);
}

// Walks `.scale` up the parent chain rather than reading matrixWorld, because
// this runs at build time — before the first render updates any matrix, when
// matrixWorld is still identity and would report a scale of 1.
//
// Averages the three components so a non-uniform `scaleXYZ` gives one sensible
// width instead of the shader picking a direction; the shells are a
// readability aid, not a measurement.
function accumulatedScale(obj) {
  let s = 1;
  for (let o = obj; o; o = o.parent) s *= (Math.abs(o.scale.x) + Math.abs(o.scale.y) + Math.abs(o.scale.z)) / 3;
  return s;
}
