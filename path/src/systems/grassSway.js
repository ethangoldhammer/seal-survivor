import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { advanceCycles } from './beatSync.js';

// Seabed grass bending in the current, done entirely in the vertex shader.
// Nothing here touches the CPU per frame except one uniform write for the
// clock, so a field of grass costs the same whether there are two clumps or
// two hundred — which is the only reason scattering it is affordable at all.
//
// WHY uv.y IS THE MASK
//
// The bend has to be zero at the root and full at the tip, so it needs a
// per-vertex "how far up my own blade am I" number. Two candidates, and the
// obvious one is wrong:
//
//   - Object-space Y is per-CLUMP, not per-blade. The clump is 3.96 units tall
//     but its blades run from 0.3 to 3.4, so a short blade's tip sits at the
//     same height as a tall blade's middle. Masking on height bends every
//     blade by a different fraction of its own length: the short ones barely
//     move while the tall ones whip.
//   - uv.y is per-BLADE and already normalised. Every card in the source is
//     unwrapped root-at-0, tip-at-1 (measured: uv.y spans exactly 0..1 on all
//     18 meshes, correlating 0.876–1.000 with local Y). It is exactly the
//     parameter this needs, it costs nothing, and it is already in the file.
//
// So tools/optimize-grass.mjs remaps u into its atlas slot and leaves v
// untouched. If anyone re-atlases this asset vertically, the sway dies — and
// it dies quietly, as grass that bends from the wrong place rather than as an
// error. That is the one thing to keep in mind when touching that script.
//
// WHY THE PUSH IS IN OBJECT SPACE
//
// assets.js seats every model inside an orientation group (see
// orientationQuaternion), so the asset's own axes are not the world's. Bending
// `transformed` in object space, before that group's rotation, means the grass
// leans along its own ground plane no matter how the entry is oriented or
// which way CONFIG.view has the camera pointing. Bending in world space would
// make the blades shear sideways out of the seabed the moment the view changed.
//
// The wave phase, by contrast, IS read from world position — that is what
// stops every clump in the field from pulsing in unison, and it wants to be a
// property of where the clump stands, not of its local mesh.

const GLSL_SWAY = `
uniform float uSwayCycle;        // main sway position, in cycles
uniform float uSwayFlutterCycle; // tip chatter position, in cycles
uniform float uSwayAmplitude;
uniform float uSwayStiffness;
uniform float uSwayWavelength;
uniform vec2  uSwayDir;
uniform float uSwayFlutter;
uniform float uSwayBend;
uniform float uSwayHeight;  // subject height, in the space transformed arrives in
uniform float uSwayUseUv;   // 1 = mask on uv.y, 0 = on height (see attachGrassSway)
uniform float uShoveStiffness;
#ifdef USE_INSTANCING
  // Per-plant push from a body swimming past, as a signed fraction of the
  // plant's own height along world +X. Written once a frame by updateShove;
  // see the note there for why one axis is the whole of it.
  attribute float aShove;
#endif
`;

// Injected after <begin_vertex>, where `transformed` is the raw object-space
// position. Same insertion point the noise shader and the outline shells use,
// for the same reason: it is the last moment the vertex is still the modeller's.
//
// The reasoning lives out here rather than inside the template on purpose. That
// string is shipped verbatim to every driver's GLSL compiler, so prose in it is
// bytes on the wire and a portability risk besides — the GLSL ES source
// character set does not promise to accept the em dashes and curly quotes this
// file is otherwise written with. Comments inside the shader stay short and
// ASCII; the "why" stays here.
//
//   swayT   root-to-tip parameter, 0 at the base and 1 at the tip. TWO sources,
//           and which one is right is a fact about the model, not a preference
//           — see attachGrassSway's `mask` option.
//
//           uv.y is the grass clump's, for the reason at the top of the file.
//           The guard is USE_MAP, not USE_UV: since r152 three gives each map
//           its own varying, and vMapUv is declared under USE_MAP while USE_UV
//           governs the unrelated vUv. Guarding on the wrong one still compiles
//           and quietly takes the other branch, which is the worst of both
//           outcomes. <uv_vertex> assigns it well before <begin_vertex>, so it
//           is live here, and mapTransform is identity absent
//           KHR_texture_transform — so this is the raw v.
//
//           Object-space height is the SeaFlora bed's. Those props are one
//           plant per file with the base already at y=0, so height IS the
//           blade parameter and there is no mixed-height clump to get it
//           wrong. Their UVs cannot be used: split-seabed.mjs crops each prop
//           to its own patch of the shared watercolour sheet, and while that
//           leaves v spanning roughly 0..1 it does not promise which end is
//           the root — measured, broadleaf_b correlates -0.80 with its own
//           height and the two corals only 0.77-0.80, so uv.y there would bend
//           a leaf from the tip and no error would say so.
//
//           Selected by UNIFORM rather than by #define, because
//           customProgramCacheKey below pins every sway material to one cached
//           program and that is only sound while the injected source is
//           byte-identical for all of them. A #define here would hand the
//           second material the first one's compiled shader.
//
//   swayDir the current, in the space the push is applied in. Under
//           USE_INSTANCING that is NOT the world: seabedScatter gives every
//           plant a random yaw on its instance matrix, which would rotate an
//           object-space push into a different world direction per plant and
//           turn one current into a field of plants each leaning its own way.
//           Carrying the world direction back through the instance's basis
//           (its transpose, which for a rotation is its inverse) makes the
//           whole bed lean together again. The PHASE stays world — a gust
//           crossing the bed is a place, not an orientation.
//
//   mask    pow() concentrates the bend toward the tip. 1.0 hinges the whole
//           blade at the root and reads like a wiper; higher values keep the
//           lower third planted and let the top curl, which is what a stem in
//           a current actually does.
//
//   bladeY  height of THIS vertex above the seabed, which is a real length only
//           because optimize-grass.mjs reseats the clump to put the blade bases
//           at y=0.
//
//   phase   read from WORLD position, so the current crosses the field as a
//           travelling gust instead of every clump breathing together. Two
//           components at deliberately incommensurate rates: a slow body sway
//           the clump shares, plus a faster flutter weighted to the tips. One
//           sine alone reads as a metronome no matter how it is tuned.
//
//   push    scaled by bladeY, which does two things at once. It makes amplitude
//           a fraction of blade length rather than raw model units, so it means
//           the same thing at any fit value (assets.js puts fit on the node's
//           scale, not the geometry). And it scales each blade by ITS OWN
//           length rather than the clump's: this stand mixes blades from 0.3 to
//           3.4 units tall, and a shared scale gives the short ones the same
//           absolute push as the tall ones, which on a 0.3-unit blade is most
//           of its own height. They thrash while the tall ones lean.
//
//   the drop  a blade pushed sideways without it gets LONGER, and the grass
//           reads as rubber. Dropping the tip by d*d/2h holds the arc length
//           roughly constant: measured, that is +0.002% stretch against +0.66%
//           uncorrected (tools/grass-sway-test.mjs). Bounded already, since
//           push is masked by the same swayT that appears in the denominator,
//           but clamped anyway so no tuner value can invert a blade through its
//           own root.
const GLSL_SWAY_BODY = `
{
  // height within the subject; also the fallback when there are no UVs at all
  float swayH = clamp(transformed.y / max(uSwayHeight, 0.0001), 0.0, 1.0);
  float swayT = swayH;
  #ifdef USE_MAP
    swayT = mix(swayH, clamp(vMapUv.y, 0.0, 1.0), uSwayUseUv);
  #endif

  float mask = pow(swayT, uSwayStiffness);
  float bladeY = transformed.y;

  vec2 swayDir = uSwayDir;
  vec4 swayLocal = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    // world = modelMatrix * instanceMatrix * transformed, the order three uses
    // in <worldpos_vertex> and <project_vertex>.
    swayLocal = instanceMatrix * swayLocal;
    // basis columns, normalised so a per-instance scale cannot bias the turn
    vec3 axisX = normalize(instanceMatrix[0].xyz + vec3(0.0001, 0.0, 0.0));
    vec3 axisZ = normalize(instanceMatrix[2].xyz + vec3(0.0, 0.0, 0.0001));
    vec3 wantWorld = vec3(uSwayDir.x, 0.0, uSwayDir.y);
    vec2 dirLocal = vec2(dot(wantWorld, axisX), dot(wantWorld, axisZ));
    float dirLen = length(dirLocal);
    // degenerate basis (a zeroed instance matrix) falls back rather than NaNs
    swayDir = mix(uSwayDir, dirLocal / max(dirLen, 0.0001), step(0.0001, dirLen));
  #endif

  vec3 swayWorld = (modelMatrix * swayLocal).xyz;
  // uSwayCycle and uSwayFlutterCycle arrive as POSITIONS (in cycles), not as
  // a clock and a rate, which is what lets the same shader run at 1.1 rad/s
  // or at one sway per two bars — see systems/beatSync.js. The spatial term
  // is untouched: a gust crossing the field is a distance, not a tempo.
  float phase = dot(swayWorld.xz, uSwayDir) * uSwayWavelength + uSwayCycle * 6.2831853;

  float body = sin(phase);
  float flutter = sin(phase * 2.7 + uSwayFlutterCycle * 6.2831853) * uSwayFlutter * swayT;

  vec2 push = swayDir * (body * uSwayAmplitude + flutter) * mask * bladeY;

  // THE SHOVE — a body swimming past, on its own mask so it can bend lower
  // down the stem than the current does. Same two scalings as the sway and for
  // the same reasons: masked root-to-tip so the base stays planted, and scaled
  // by bladeY so it means a fraction of each plant's own height rather than a
  // number of world units that would flatten a seedling and barely move a
  // frond. Folded into the same push vector as the sway, before the
  // arc-length correction, so a shoved plant keeps its length exactly as a
  // swaying one does.
  #ifdef USE_INSTANCING
    // world +X carried into this instance's space — the same transpose the
    // sway direction takes, and here it is just the x components of the two
    // normalised basis columns.
    vec2 shoveDir = vec2(axisX.x, axisZ.x);
    push += shoveDir * (aShove * pow(swayT, uShoveStiffness) * bladeY);
  #endif

  transformed.xz += push;

  // hold arc length: drop the tip to pay for moving it sideways
  float d = length(push);
  float h = max(bladeY, 0.0001);
  transformed.y -= min(d * d / (2.0 * h), bladeY) * uSwayBend;
}
`;

// Every material carrying the sway, so a tuner move can push new values without
// recompiling anything.
const attached = new Set();

/**
 * Inject the sway into one material. Idempotent — calling it twice on the same
 * material no-ops rather than stacking a second copy of the displacement.
 *
 * `height` is the subject's height IN THE SPACE `transformed` arrives in, which
 * is the raw model space for anything drawn as a loaded model and is NOT that
 * for the instanced bed — seabedScatter bakes fit, the orientation group and
 * the size multiplier into its geometry, so it re-measures and calls
 * setGrassSwayHeight afterwards. Passing the wrong one does not error; it
 * scales the root-to-tip mask, so the plant bends from part-way up itself.
 *
 * @param {object} [opts]
 * @param {'uv'|'height'} [opts.mask]  which root-to-tip parameter to bend on.
 *   'uv' for a model whose v really does run root-to-tip (grass.glb); 'height'
 *   for one plant per file with its base at y=0 (the SeaFlora bed). See the
 *   swayT note above — the wrong one is a silent, plausible-looking bend.
 * @param {number} [opts.scale]  per-subject multiplier on amplitude and
 *   flutter, so one current can move kelp and coral by different amounts
 *   without a second copy of CONFIG.grass.sway's nine numbers.
 */
export function attachGrassSway(material, height = 1, opts = {}) {
  if (!material || material.userData.__swayAttached) return material;
  material.userData.__swayAttached = true;
  material.userData.__swayScale = opts.scale ?? 1;

  const u = {
    uSwayCycle: { value: 0 },
    uSwayFlutterCycle: { value: 0 },
    uSwayAmplitude: { value: 0.09 },
    uSwayStiffness: { value: 1.8 },
    uSwayWavelength: { value: 0.35 },
    uSwayDir: { value: new THREE.Vector2(1, 0) },
    uSwayFlutter: { value: 0.025 },
    uSwayBend: { value: 1 },
    uSwayHeight: { value: height },
    uSwayUseUv: { value: opts.mask === 'height' ? 0 : 1 },
    uShoveStiffness: { value: 1.2 },
  };
  material.userData.__swayUniforms = u;

  // Chained, not assigned: an outline shell arrives with its own rim push on
  // onBeforeCompile and that has to keep running, or the border detaches from
  // the blade it is supposed to be tracing. Same contract as dissolve.js.
  const previous = material.onBeforeCompile;
  // three keys compiled programs partly by the SOURCE of onBeforeCompile, which
  // is identical for every material wearing this wrapper. A constant tag lets
  // the second clump reuse the first's program instead of compiling its own.
  material.customProgramCacheKey = () => 'grassSway';
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLSL_SWAY)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GLSL_SWAY_BODY);
  };
  material.needsUpdate = true;
  attached.add(material);
  return material;
}

/**
 * Advance the sway clock. Wall-clock dt, like the sky and the weather in
 * main.js: the current belongs to the world, not to the run, and grass that
 * freezes behind the upgrade screen or crawls through a hit-stop reads as a
 * bug rather than as drama.
 */
export function updateGrassSway(rawDt, shoveAt = null) {
  // ABOVE the early return, and that is the whole reason it is here rather
  // than after it. The shove is a different force with its own switch, and
  // hanging it off the current's `enabled` would mean a saved tuning that
  // turned the ambient sway off — as one does at the time of writing —
  // silently took the player's wake with it.
  updateShove(rawDt, shoveAt);
  if (CONFIG.grass?.sway?.enabled === false) return;
  const cfg = CONFIG.grass?.sway ?? {};
  // Advanced ONCE, then broadcast. Every clump answers to the same config, so
  // there is nothing per-material to track — the thing that makes a field look
  // like a field rather than like one plant repeated is the spatial term in the
  // shader (see uSwayWavelength), not a per-clump clock.
  //
  // Both rates are authored in radians/sec, so they divide by 2π to become the
  // cycles/sec the free path wants. Wrap 1: each cycle is read by a single
  // sin(), so a full turn is the whole period.
  swayCycle = advanceCycles(swayCycle, cfg.speedSync, (cfg.speed ?? 1.1) / TWO_PI, rawDt, 1);
  flutterCycle = advanceCycles(
    flutterCycle, cfg.flutterSync, (cfg.flutterSpeed ?? 3.7) / TWO_PI, rawDt, 1);
  for (const m of attached) {
    const u = m.userData.__swayUniforms;
    if (!u) continue;
    u.uSwayCycle.value = swayCycle;
    u.uSwayFlutterCycle.value = flutterCycle;
  }
}

const TWO_PI = Math.PI * 2;
let swayCycle = 0;
let flutterCycle = 0;

// ---------------------------------------------------------------------------
// THE SHOVE — plants pushed aside by a body swimming through them
// ---------------------------------------------------------------------------
//
// WHY THIS HALF IS ON THE CPU while the current is entirely in the shader.
//
// The current is a FIELD: every plant's bend is a function of where it stands
// and what time it is, so the shader can work it out from scratch every frame
// and there is nothing to remember. A shove is not. "Settle back" means the
// plant's bend depends on where it was a moment ago, and a vertex shader has no
// yesterday — it would have to be handed one, which is what this is.
//
// So each plant carries one number, `aShove`, and one hidden one, its velocity.
// A spring pulls the number toward whatever the seal's proximity currently
// asks for; when the seal leaves, the ask drops to zero and the spring is what
// makes the plant swing back and overshoot rather than snap upright. That
// asymmetry — shoved as fast as the seal moves, recovering at its own pace — is
// the whole read, and no stateless falloff can produce it.
//
// The cost is one float per plant per frame. At the shipped count that is 82
// multiply-adds and fifteen buffer uploads of under 400 bytes between them,
// which is why the "no per-plant CPU work" rule the bed was built on can bend
// here: the rule exists to keep DRAW CALLS down, and this adds none.
//
// ONE AXIS, and that is a decision rather than a shortcut. The plants push in
// the horizontal plane, and this game is a side view: a push along world Z
// moves a plant directly toward or away from the camera, where it reads as
// nothing at all. So the shove is a signed amount along world +X, and the
// shader carries that one direction back through each plant's random yaw the
// same way the current's direction is carried.

/** Every InstancedMesh being shoved, with the per-plant state behind it. */
const shoved = new Set();

/**
 * Register one instanced draw for the shove.
 *
 * `plants` is one entry per instance, in the SAME ORDER as setMatrixAt was
 * called — the attribute is indexed by instance id and nothing checks that for
 * you, so a mismatch here shoves the wrong plants and looks like a tuning
 * problem rather than an off-by-one.
 *
 * @param {THREE.InstancedMesh} mesh
 * @param {{x: number, y0: number, y1: number}[]} plants  each plant's world x,
 *   and the bottom and top of its stem — a SEGMENT rather than a point,
 *   because a bed scaled 0.4x to 2.1x has plants five units tall standing next
 *   to plants one unit tall, and measuring both from their roots means a seal
 *   swimming past the top of a kelp frond touching nothing.
 */
export function registerShovedInstances(mesh, plants) {
  if (!mesh?.isInstancedMesh || !plants?.length) return;
  const n = Math.min(mesh.count, plants.length);
  const shove = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  // Written every frame it moves, so three should not try to be clever about
  // re-uploading it.
  shove.setUsage(THREE.DynamicDrawUsage);
  mesh.geometry.setAttribute('aShove', shove);

  const state = {
    mesh,
    shove,
    x: new Float32Array(n),
    y0: new Float32Array(n),
    y1: new Float32Array(n),
    vel: new Float32Array(n),
    // Starts awake so the first frame writes a real value rather than leaving
    // whatever the buffer was allocated with.
    resting: false,
  };
  for (let i = 0; i < n; i++) {
    state.x[i] = plants[i].x;
    state.y0[i] = plants[i].y0;
    state.y1[i] = plants[i].y1;
  }
  shoved.add(state);
}

/** Drop every registered draw. The bed is rebuilt on resize and on a tuner move. */
export function clearShovedInstances() {
  shoved.clear();
}

/** How many draws are being shoved. For tests and the tuner readout. */
export function shovedInstanceCount() {
  return shoved.size;
}

/**
 * Advance every plant's shove by one frame.
 *
 * @param {number} dt      seconds. Clamped below, because a spring integrated
 *   over a tab-switch's worth of dt does not lag, it explodes.
 * @param {{x: number, y: number}|null} at  where the body is, in world units.
 *   Null settles the whole bed, which is what a missing player should do rather
 *   than freezing it mid-bend.
 */
function updateShove(dt, at) {
  if (!shoved.size) return;
  const cfg = CONFIG.grass?.shove ?? {};
  const off = cfg.enabled === false || !at;
  const radius = Math.max(0.001, cfg.radius ?? 4);
  const feather = Math.max(0.01, cfg.feather ?? 1);
  // `enabled` folds into strength rather than skipping the loop, for the same
  // reason the sway folds it into amplitude: switching it off should let the
  // bed stand up, not freeze it in whatever shape the seal last left.
  const strength = off ? 0 : (cfg.strength ?? 0.35);
  const rate = Math.max(0, cfg.springRate ?? 90);
  // Under 1 the plant overshoots on its way back, which is the flick that makes
  // it read as a plant rather than as a slider being dragged.
  const damping = 2 * Math.sqrt(rate) * (cfg.springDamping ?? 0.55);
  // The direction goes smoothly through zero as the seal crosses a plant
  // instead of flipping sign in one frame — softened over a fraction of the
  // radius, so a plant the seal passes directly over is handed off from one
  // side to the other rather than snapping across.
  const softening = radius * (cfg.crossoverSoftening ?? 0.15);

  // A spring is only stable while the step is small against its own period, and
  // dt here is the WALL clock: an alt-tab, a long GC or the first frame after a
  // model load all hand it a step that would throw every plant off the map.
  //
  // BOTH GUARDS, because each one alone fails. Clamping without substepping
  // runs a slow frame in slow motion. Substepping under a cap on the step COUNT
  // is worse than either — it looks like it is doing the right thing while
  // quietly making each step enormous, which is how a 2.5s stall put a plant
  // 2.1e8 units sideways in the harness before this line said so.
  //
  // So: clamp the total first (a 2.5s gap is not a slow frame, it is a stall,
  // and the bed would have settled during it anyway), then size the step off
  // the spring's OWN period rather than a fixed 1/60, so a stiff tuning value
  // cannot outrun the integrator either. At the shipped rate this is exactly
  // one step per frame and costs nothing.
  const dtClamped = Math.min(dt, 0.25);
  const omega = Math.sqrt(rate) || 1;
  const maxStep = Math.min(1 / 60, 1 / (4 * omega));
  const steps = Math.max(1, Math.min(32, Math.ceil(dtClamped / maxStep)));
  const h = dtClamped / steps;

  const sx = at ? at.x : 0;
  const sy = at ? at.y : 0;

  for (const st of shoved) {
    // A bed that is already upright with nothing pushing it has nothing to
    // integrate. Tracked per DRAW rather than per plant because waking is
    // all-or-nothing per buffer — there is no such thing as a partial upload.
    // No distance rejection above this: every draw is one variant scattered
    // wall to wall, so a bounds test would reject nothing and cost a branch.
    if (st.resting && strength === 0) continue;

    const arr = st.shove.array;
    let awake = false;
    for (let i = 0; i < arr.length; i++) {
      let target = 0;
      if (strength !== 0) {
        // Closest point on this plant's stem to the source. Clamping the
        // source's height into the stem's span is what makes a tall frond
        // respond to a seal swimming past its middle.
        const py = Math.min(Math.max(sy, st.y0[i]), st.y1[i]);
        const dx = st.x[i] - sx;
        const dy = py - sy;
        const d = Math.hypot(dx, dy);
        if (d < radius) {
          // Feathered edge: smoothstep in, so the plant at the rim eases into
          // the push instead of stepping into it, and `feather` biases where
          // that ramp does its work.
          const u = 1 - d / radius;
          const f = Math.pow(u * u * (3 - 2 * u), feather);
          // Away from the source, horizontally. A plant the seal is directly
          // above has dx ~ 0 and is barely pushed sideways at all, which is
          // right: it is being passed over, not shouldered.
          const dirX = Math.max(-1, Math.min(1, dx / Math.max(d, softening)));
          target = dirX * f * strength;
        }
      }

      let cur = arr[i];
      let v = st.vel[i];
      for (let s = 0; s < steps; s++) {
        // Semi-implicit Euler: velocity first, then position with the NEW
        // velocity. Explicit Euler here adds energy every step and a bed left
        // alone slowly shakes itself apart.
        v += ((target - cur) * rate - v * damping) * h;
        cur += v * h;
      }
      arr[i] = cur;
      st.vel[i] = v;
      // At rest means BOTH: a plant crossing zero at speed is not finished, and
      // testing position alone parks it mid-swing the moment it passes upright.
      if (Math.abs(cur) > 1e-4 || Math.abs(v) > 1e-4 || target !== 0) awake = true;
    }

    st.shove.needsUpdate = true;
    st.resting = !awake;
    // The frame it settles still uploads — that is the one that writes the
    // zeroes. Stopping a frame earlier leaves every plant a hair off upright.
  }
}

/**
 * Push CONFIG.grass.sway onto every attached material. Pure uniform writes, no
 * recompile, so this is safe to call from a slider's input event.
 */
export function applyGrassSettings() {
  const cfg = CONFIG.grass?.sway ?? {};
  const dir = cfg.direction ?? 0;
  for (const m of attached) {
    const u = m.userData.__swayUniforms;
    if (!u) continue;
    // Per-subject softening. Applied here rather than in the shader so it stays
    // a property of the PLANT — a coral head and a kelp frond in the same
    // current move by different amounts — while everything about the current
    // itself is still one config block that a slider moves for the whole bed.
    const scale = m.userData.__swayScale ?? 1;
    // `enabled` folds into amplitude rather than branching in the shader — one
    // less thing for the vertex to test, and the toggle settles the grass
    // instead of snapping it straight.
    u.uSwayAmplitude.value = cfg.enabled === false ? 0 : (cfg.amplitude ?? 0.09) * scale;
    u.uSwayStiffness.value = cfg.stiffness ?? 1.8;
    u.uSwayWavelength.value = cfg.wavelength ?? 0.35;
    u.uSwayDir.value.set(Math.cos(dir), Math.sin(dir));
    u.uSwayFlutter.value = cfg.enabled === false ? 0 : (cfg.flutter ?? 0.025) * scale;
    u.uSwayBend.value = cfg.bend ?? 1;
    // The shove's own mask exponent. NOT scaled by `scale` and NOT zeroed by
    // the sway's `enabled`: this is the shape of a different force, and the
    // shove's own strength and switch live on the CPU side (see updateShove),
    // where zeroing them lets a bent plant settle instead of snapping straight.
    u.uShoveStiffness.value = CONFIG.grass?.shove?.stiffness ?? 1.2;
    // `speed` and `flutterSpeed` are NOT written here any more: they are rates,
    // and the shader is handed positions. updateGrassSway owns both.
  }
}

/**
 * Correct the height the root-to-tip mask normalises against, once the caller
 * knows the space its geometry actually ended up in.
 *
 * systems/seabedScatter.js is the reason this exists: it collapses
 * createVisual's whole assembly into one geometry and reseats the base at y=0,
 * so the height assets.js measured off the raw model is in the wrong units by
 * whatever fit and the size multiplier came to. Wrong here is not an error and
 * not invisible either — the mask saturates part-way up the plant and the top
 * third bends as one rigid piece.
 */
export function setGrassSwayHeight(material, height) {
  const u = material?.userData?.__swayUniforms;
  if (!u || !(height > 0)) return;
  u.uSwayHeight.value = height;
}

export function grassSwayMaterialCount() {
  return attached.size;
}
