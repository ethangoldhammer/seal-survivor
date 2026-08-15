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
// The ink line — a second, thinner set of hulls in flat black, sitting inside
// the glowing ones so the glow shows as a fringe around it. See
// CONFIG.playerOutline.inner.
//
// A SEPARATE ARRAY rather than a flag on the shells, because the difference
// that matters is what writes to them: everything below this line — the
// wind-up throb, the release flare, the damage flash — walks `playerShells`
// and must never reach the ink. The list you are not in is the guarantee.
let playerInnerShells = [];

// Build the shells for a freshly created seal body. Safe to call repeatedly —
// the previous set went away with the body that owned it, and its materials
// are dropped here rather than left to leak on every T-menu size change.
export function attachPlayerOutline(body) {
  for (const shell of playerShells) shell.material?.dispose();
  for (const shell of playerInnerShells) shell.material?.dispose();
  playerShells = body ? addOutlineShells(body, { color: CONFIG.playerOutline?.color ?? 0xffffff }) : [];
  // The glow first, so a bare `find` for an outline in a harness still lands
  // on the rim everything else in this file is about.
  //
  // addOutlineShells skips anything already marked as an outline, so this
  // second pass wraps the SEAL again rather than wrapping the shells that were
  // just built — which is what stops the ink from being an outline of an
  // outline, half of it inside-out.
  playerInnerShells = body
    ? addOutlineShells(body, { color: CONFIG.playerOutline?.inner?.color ?? 0x000000 })
    : [];
  // Explicitly between the glow and the seal. The depth test already sorts
  // these correctly on its own — the thinner hull's back faces are nearer the
  // camera everywhere the two overlap — but leaving the picture to depend on
  // which array happened to be built first is not a thing to leave unwritten.
  // Nudged rather than assigned, so it stays a half step behind whatever the
  // seal's own meshes are ordered at instead of assuming that is zero.
  for (const shell of playerInnerShells) shell.renderOrder += 0.5;
  // A new body comes up at the base look, so the wind-up state has to come up
  // clear with it — a flare left running from the seal that was just replaced
  // would decay onto shells that never saw the strike.
  pulsePhase = 0;
  flare = 0;
  hurt = 0;
  hurtPower = 0;
  boosted = false;
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

  // The ink line rides the rim's own switch as well as its toggle: it is a
  // line drawn INSIDE the glow, and left on by itself it would be a black
  // seal-shaped smudge with nothing behind it.
  const ink = cfg.inner ?? {};
  const inkOn = cfg.enabled !== false && ink.enabled !== false;
  for (const shell of playerInnerShells) {
    shell.visible = inkOn;
    // `glow: 1` explicitly rather than by omission — applyLook would default
    // it, but the reason it is 1 is that the ink must never enter the bloom
    // pass, and that is worth saying at the one place it is decided.
    if (shell.material) {
      applyLook(shell.material, {
        color: ink.color ?? 0x000000,
        thickness: ink.thickness ?? 0.05,
        opacity: ink.opacity ?? 1,
        glow: 1,
      }, accumulatedScale(shell));
    }
  }
}

// ---------------------------------------------------------------------------
// The player's rim, as a state readout
// ---------------------------------------------------------------------------
//
// Two things drive the rim away from its tuned look, and both live here rather
// than in the systems that cause them (strike.js, playerDamageFx.js) because
// the shells and the one function that interprets a look are here — anywhere
// else would need a second copy of applyLook, which is exactly the drift this
// file exists to prevent.
//
//   THE WIND-UP  a strike being charged throbs the rim, and the release blows
//                it out. CONFIG.strike.charge.outline.
//   THE HIT      taking damage flashes it red. CONFIG.playerOutline.hit.
//
// They stack rather than taking turns: being bitten mid-charge is both things
// happening, and a rim that dropped the throb to show the hit would read as
// the charge having been lost.
//
// Everything is ADDED to whatever CONFIG.playerOutline currently says, read
// fresh each frame. That is what lets the rim be dragged around in the tuner
// mid-wind-up and keeps the pulse relative to the tuned look instead of
// stamping over it with numbers of its own.

let pulsePhase = 0; // 0..1 through the current throb
let flare = 0; // the release burst, 1 -> 0 over flareTime
let hurt = 0; // the damage flash, 1 -> 0 over its (strength-scaled) duration
let hurtPower = 0; // how big the hit that lit it was, 0..1 — held for the flash
let boosted = false; // was anything added last frame? (see the idle guard)

// Scratch, reused: this runs every frame of a wind-up and applyLook only ever
// reads it. Allocating a look object per frame would be garbage for nothing.
const chargeLook = { color: 0xffffff, thickness: 0, glow: 1, opacity: 1 };
// Same reasoning, for the tuned-colour -> hit-colour blend.
const hurtColor = new THREE.Color();
const hurtTarget = new THREE.Color();

/**
 * Fire the release flare. Called on the frame a strike actually launches.
 * @param power the banked power it launched with, 0..1 — a flick pops, a full
 *   commitment detonates.
 */
export function flarePlayerOutline(power = 1) {
  flare = Math.max(flare, Math.min(1, Math.max(0, power)));
}

/**
 * Flash the rim red. Called on the frame the player takes a hit worth showing —
 * systems/playerDamageFx.js decides which those are.
 *
 * @param strength 0..1, how much of the health bar the hit cost relative to
 *   CONFIG.fx.playerDamage.flashFraction. Sets how bright and how long, never
 *   how red — see the note on CONFIG.playerOutline.hit.
 */
export function flashPlayerOutlineDamage(strength = 1) {
  const s = Math.min(1, Math.max(0, strength));
  if (!(s > 0)) return;
  // A hit landing inside a flash re-lights it from full. What it must not do
  // is DOWNGRADE one: `hurtPower * hurt` is the strength still burning, so a
  // scratch taken a moment after a maiming re-lights at the maiming's
  // brightness rather than cutting it short at the scratch's.
  hurtPower = Math.max(hurtPower * hurt, s);
  hurt = 1;
}

export function resetPlayerOutlineCharge() {
  pulsePhase = 0;
  flare = 0;
  hurt = 0;
  hurtPower = 0;
  if (boosted) {
    boosted = false;
    applyPlayerOutline();
  }
}

/**
 * Ticks both rim effects and pushes the result onto the shells. Call once a
 * frame, always — the damage flash decays here too, so skipping it while
 * nothing is being charged would leave a hit's red hanging on the rim.
 *
 * @param dt    REAL seconds — the pulse is a readout of the button being held,
 *              and a hit-stop should not stall it. Neither should it stall the
 *              damage flash, which is over inside two hit-stops.
 * @param power banked power of the wind-up in progress, 0..1, or 0 when nothing
 *              is being held.
 */
export function updatePlayerOutline(dt, power) {
  const cfg = CONFIG.playerOutline ?? {};
  const pc = CONFIG.strike?.charge?.outline ?? {};
  const hc = cfg.hit ?? {};
  // Three switches, not one. The rim's own kills everything downstream of it,
  // but the wind-up and the damage flash are separate features with separate
  // reasons to be turned off — folding them together (as this did while the
  // wind-up was the only effect here) would mean switching off the charge
  // throb also silenced every hit the player took.
  const rimOff = cfg.enabled === false;
  const chargeOff = rimOff || pc.enabled === false;
  const hitOff = rimOff || hc.enabled === false;
  const wind = chargeOff ? 0 : Math.min(1, Math.max(0, power || 0));

  if (flare > 0) flare = Math.max(0, flare - dt / Math.max(0.01, pc.flareTime ?? 0.32));
  if (chargeOff) flare = 0;

  // The flash runs SHORTER for a smaller hit as well as dimmer — a graze that
  // lingered as long as a maiming would make every hit read the same size no
  // matter what the brightness said, because duration is the thing you notice
  // when you're looking somewhere else on the screen.
  if (hurt > 0) {
    const span = lerp(hc.minTime ?? 0.18, hc.time ?? 0.45, hurtPower);
    hurt = Math.max(0, hurt - dt / Math.max(0.01, span));
    if (hurt <= 0) hurtPower = 0;
  }
  if (hitOff) {
    hurt = 0;
    hurtPower = 0;
  }

  // Rate climbs with banked power — urgency reads as speed, and it keeps
  // building after the brightness has run out of room to.
  const hz = lerp(pc.hzMin ?? 2.2, pc.hzMax ?? 7.5, wind);
  pulsePhase = (pulsePhase + dt * hz) % 1;

  // A cosine rather than a sine, and the phase is zeroed the moment nothing is
  // held, so every wind-up opens at the BOTTOM of a throb and swells out of it
  // rather than starting halfway up one.
  //
  // What stops the rim JUMPING on the first frame is the other term: the whole
  // boost rides `wind`, and banked power starts at zero and ramps, so the floor
  // ramps in with it. The one case that does pop is resuming a wind-up that was
  // released under `minFire` — power survives that release (see strike.js), so
  // the rim comes back at the brightness that power has already bought. Which
  // is the honest reading: the bank really is that big.
  const wave = 0.5 - 0.5 * Math.cos(pulsePhase * TAU);
  const depth = Math.min(1, Math.max(0, pc.pulseDepth ?? 0.55));
  const throb = wind * (1 - depth + depth * wave);
  // Squared, so the flare falls off its peak fast and then lingers — a linear
  // decay reads as a dimmer switch rather than as something blowing off.
  const burst = flare * flare;
  // Squared for the same reason the flare is: a hit should peak instantly and
  // then let go, and a linear fade reads as the rim being TINTED red rather
  // than as something having just happened to you.
  const sting = hurt * hurt;

  const glowAdd = (pc.glowAdd ?? 5) * throb + (pc.flareGlow ?? 9) * burst
    + (hc.glowAdd ?? 4) * sting * hurtPower;
  const thickAdd = (pc.thicknessAdd ?? 0.06) * throb + (pc.flareThickness ?? 0.14) * burst
    + (hc.thicknessAdd ?? 0.07) * sting * hurtPower;

  // Idle: write the base look back ONCE and then do nothing at all. Without the
  // latch this would push four materials' worth of colour every frame of a run
  // in which nobody is charging anything, and — worse — would fight the tuner,
  // overwriting a slider drag on the very next frame.
  //
  // `hurt` is in the test on its own account, not folded into glowAdd: the
  // colour blend below runs off it, so a flash with both `hit` adds tuned to
  // zero still has to reach the materials or the rim would never turn red.
  if (glowAdd <= 0 && thickAdd <= 0 && hurt <= 0) {
    pulsePhase = 0;
    if (boosted) {
      boosted = false;
      applyPlayerOutline();
    }
    return;
  }
  boosted = true;

  // Full hit colour on the frame of the hit whatever its size, easing back to
  // the tuned rim — see CONFIG.playerOutline.hit. `hurt` rather than `sting`
  // here on purpose: the squared curve is right for a brightness spike and
  // wrong for a hue, which needs to hold long enough to be recognised as red.
  chargeLook.color = cfg.color ?? 0xffffff;
  if (hurt > 0) {
    hurtColor.set(cfg.color ?? 0xffffff);
    hurtTarget.set(hc.color ?? 0xff2a18);
    chargeLook.color = hurtColor.lerp(hurtTarget, hurt);
  }
  chargeLook.opacity = cfg.opacity ?? 1;
  // Glow is the channel that blooms: it multiplies the colour past 1.0 into the
  // HDR bright-pass, so this is a rim that throws light rather than a lighter
  // blue one. Thickness swells alongside it because bloom alone haloes a line
  // that is still the same width, and the wind-up should read as the seal
  // getting BIGGER.
  chargeLook.glow = (cfg.glow ?? 1) + glowAdd;
  chargeLook.thickness = (cfg.thickness ?? 0) + thickAdd;

  for (const shell of playerShells) {
    if (shell.material) applyLook(shell.material, chargeLook, accumulatedScale(shell));
  }
}

const TAU = Math.PI * 2;

function lerp(a, b, t) {
  return a + (b - a) * t;
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
