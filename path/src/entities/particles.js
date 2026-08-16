import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { surfaceHeightAt, waveTimeNow, sea, bounds, WAVE } from '../arena.js';

// One draw call for every particle in the game.
//
// The whole simulation lives in the vertex shader: each point stores an origin,
// a velocity, a drag coefficient and a spawn time, and its position is solved
// analytically from age. The CPU only writes attributes when a burst is emitted,
// so thousands of particles cost almost nothing per frame.

// --- the current ------------------------------------------------------------
// Everything in this game happens underwater, and until now nothing in a burst
// knew that: particles flew ballistic arcs, slowed by drag, in perfectly
// straight lines. Real debris in water doesn't — it gets taken by whatever the
// water is doing. TURBULENCE is one field covering the whole arena that every
// particle is pushed by, so two bursts going off next to each other bend the
// same way and read as being in the same body of water.
//
// The field is the curl of a sum of sines: each component depends only on the
// OTHER axis, which makes it divergence-free by construction. That is what
// separates "liquid" from "wobble" — a divergence-free field can only swirl
// things around, never pile them up or pull them apart, so a cloud of
// particles caught in it shears and folds the way a cloud in water does.
//
// The JS twin of this function is `turbulenceAt` below. The two have to agree
// exactly: the CPU solves bubble positions with it to decide where a bubble
// bursts, and a pop landing off the bubble that made it is exactly the tell
// that they've drifted apart. Same reasoning as the four copies of WAVE.
const TURBULENCE_GLSL = /* glsl */ `
  vec2 turbulenceAt(vec2 p, float t) {
    return vec2(
      sin(p.y + t)        + 0.5 * sin(p.y * 2.13 - t * 1.70 + 1.3),
      sin(p.x * 1.17 - t) + 0.5 * sin(p.x * 2.47 + t * 1.10 + 4.1)
    );
  }
`;

// --- goo --------------------------------------------------------------------
// A second pass over the SAME buffer, for emitters flagged `goo: true`.
// Nothing about the simulation changes: the vertex stage below is shared, and
// the only differences are which particles it keeps, how big it draws them and
// what the fragment stage writes. That matters — the sim here is a closed form
// with no CPU-side positions at all (see the note at the top), and a fluid look
// that needed to know where particles were would have meant giving that up.
//
// Instead the fusion happens in SCREEN SPACE. This material renders the flagged
// particles into a small offscreen target as soft radial DENSITY splats, summed
// additively; systems/post.js then thresholds that field at an isoline. Two
// splats near each other sum above the line in the gap BETWEEN them, so they
// weld into one silhouette with a concave neck instead of overlapping as two
// discs — which is the whole difference between "goopy" and "more sprites".
//
// Colour survives the sum because it is accumulated PREMULTIPLIED by density
// (rgb += colour * density, a += density) and divided back out at the
// threshold. Two kills of different creatures overlapping blend their tints
// across the weld rather than one winning.
const vertexShaderFor = (goo) => /* glsl */ `
  attribute vec3 aVelocity;
  attribute vec3 aColor;
  attribute vec2 aGravity;
  attribute float aStart;
  attribute float aLife;
  attribute float aSize;
  attribute float aDrag;
  attribute float aTurb;    // how hard the current takes this one
  attribute float aClip;    // 1 = die at the water line rather than sail through it
  attribute float aGoo;     // 0 = a sprite; 1..n = which goo GROUP it belongs to

  uniform float uTime;
  uniform float uScale; // device pixels per world unit
  uniform vec3 uTurb;   // x = strength, y = spatial frequency, z = time scale
  ${goo
    ? `uniform float uGooRadius; // splat diameter, x the particle's own size
  uniform float uGroup;     // which group this draw is rendering`
    : 'uniform float uGooHide;   // 1 while the goo pass is drawing them instead'}

  // The water line, transcribed from WAVE in arena.js — see grid.js for the
  // same block and the same warning about decimal points.
  uniform float uSurfaceY;
  uniform float uWaveT;
  uniform float uWaveAmp;
  uniform float uChop;

  varying vec3 vColor;
  varying float vAlpha;

${TURBULENCE_GLSL}

  float surfaceHeightAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)}
      + sin(x * ${WAVE.k3.toFixed(4)} + uWaveT * ${WAVE.w3.toFixed(4)}) * uWaveAmp * ${WAVE.amp3.toFixed(4)} * uChop;
  }

  void main() {
    float age = uTime - aStart;
    float t = age / max(aLife, 0.0001);
    float alive = step(0.0, age) * step(t, 1.0);

    // Closed form of velocity under linear drag, plus gravity.
    float k = max(aDrag, 0.0001);
    vec3 disp = aVelocity * ((1.0 - exp(-k * age)) / k);
    disp.xy += 0.5 * aGravity * age * age;

    vec3 pos = position + disp * alive;

    // Sampled at the BALLISTIC position, not the turbulent one: feeding the
    // displaced position back in would make the field self-advecting, which
    // has no closed form and would drift from the CPU's solve immediately.
    // Ramped by age from zero, or every burst would snap sideways on its first
    // frame — the current takes hold of debris, it doesn't kick it.
    pos.xy += turbulenceAt(pos.xy * uTurb.y, uTime * uTurb.z) * (uTurb.x * aTurb * age) * alive;

    // A bubble that reaches the surface has burst. Killing it HERE rather than
    // only in the CPU tracker is what makes that a guarantee: the tracker has a
    // budget and can be full, and anything it missed used to carry on into the
    // sky. Nothing gets past this.
    alive *= 1.0 - aClip * step(surfaceHeightAt(pos.x), pos.y);

    // The two passes split the buffer between them. The sprite pass drops a goo
    // particle only while the goo pass is actually running (uGooHide): with the
    // effect switched off, nobody would be drawing them and a kill burst would
    // simply be invisible — the failure mode of a look toggle should be the old
    // look, not a missing one.
    // One draw per group, each keeping only its own: two substances that want
    // different surfaces (blood is thick and opaque, foam is thin and glowing)
    // cannot share one threshold, and summing them into one field would weld
    // them to each other as well.
    ${goo
      ? 'alive *= 1.0 - step(0.5, abs(aGoo - uGroup));'
      : 'alive *= 1.0 - step(0.5, aGoo) * uGooHide;'}

    // Park dead points outside the frustum so they never rasterise.
    pos.z -= (1.0 - alive) * 100000.0;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

    float fade = 1.0 - t;
    vColor = aColor;
${goo ? `
    // Density is held flat for most of the life and let go at the end, rather
    // than fading linearly from spawn. A blob whose density falls steadily
    // spends its whole life crossing the isoline, so the mass visibly shrinks
    // from the moment it lands; holding it means the goo sits there and then
    // melts, which is what a liquid does.
    vAlpha = alive * smoothstep(0.0, 0.4, fade);
    gl_PointSize = aSize * uGooRadius * uScale * (0.55 + 0.45 * clamp(fade, 0.0, 1.0)) * alive;
` : `
    vAlpha = alive * clamp(fade, 0.0, 1.0);
    gl_PointSize = aSize * uScale * (0.35 + 0.65 * clamp(fade, 0.0, 1.0)) * alive;
`}
  }
`;

const vertexShader = vertexShaderFor(false);

// The density splat. Cubic falloff — smooth in value AND slope at the rim, so
// the sprite's own square edge never shows up as a straight line in the
// silhouette once the field is thresholded.
const gooFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv) * 4.0; // 1.0 at the sprite's edge
    if (d > 1.0) discard;
    float f = 1.0 - d;
    f = f * f * f;
    float w = f * vAlpha;
    // Premultiplied: the threshold pass divides rgb back out by a.
    gl_FragColor = vec4(vColor * w, w);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv);
    if (d > 0.25) discard;
    float edge = smoothstep(0.25, 0.0, d);
    gl_FragColor = vec4(vColor, vAlpha * edge);
  }
`;

// The CPU twin of TURBULENCE_GLSL. Kept next to it so a change to one is
// visibly a change to the other; the doc comment up there is the contract.
export function turbulenceAt(x, y, t) {
  return [
    Math.sin(y + t) + 0.5 * Math.sin(y * 2.13 - t * 1.70 + 1.3),
    Math.sin(x * 1.17 - t) + 0.5 * Math.sin(x * 2.47 + t * 1.10 + 4.1),
  ];
}

function turbSettings() {
  const tb = CONFIG.fx?.turbulence;
  if (!tb || tb.enabled === false) return null;
  return tb;
}

let points = null;
let material = null;
let geometry = null;
let capacity = 0;
let cursor = 0;
let clock = 0;

// The goo layer. Its own Scene rather than a second object in the game's,
// because post.js has to draw it into a target of its own — and it shares the
// SAME BufferGeometry as the sprite layer, so it costs one extra draw of a
// buffer that is already resident and not one byte more of CPU work.
let gooPoints = null;
let gooMat = null;
let gooRoot = null;
let gooDivisor = 2;
let pixelScale = 40;
// When the last particle of each group dies, keyed by group NAME. Everything
// the goo pass does is skipped outright before that — no target bind, no clear,
// no fullscreen quad — so a group with nothing in flight costs nothing, and a
// run with none of them on screen costs nothing at all.
const gooUntil = new Map();

function gooSettings() {
  const g = CONFIG.fx?.goo;
  if (!g || g.enabled === false || !g.groups) return null;
  return g;
}

// Groups are addressed by NAME everywhere outside this file — an emitter says
// `goo: 'foam'` — and by INDEX inside it, because the flag rides in a float
// attribute. 0 is reserved for "not goo", so the index is the key's position
// plus one. Order is the object's key order, which is also the order they
// composite in: a later group lands on top of an earlier one.
function gooGroupNames() {
  const g = gooSettings();
  return g ? Object.keys(g.groups) : [];
}

// `goo: true` means the first group — the default surface, which is what the
// whole feature was before groups existed. Emitters written against that
// spelling (and any written in another session while this one was in flight)
// keep working without knowing groups happened.
function gooGroupName(def) {
  if (def.goo === true) return gooGroupNames()[0];
  return def.goo;
}

// A group is a DIFF against CONFIG.fx.goo's own keys — see the note there.
// Resolved fresh on every use rather than merged once at boot, because both
// halves are live tuner values.
function gooSurface(name) {
  const g = gooSettings();
  if (!g) return null;
  const { groups, enabled, divisor, ...defaults } = g;
  return { ...defaults, ...(groups[name] ?? {}) };
}

/**
 * The groups with something alive in them right now, in composite order.
 * post.js is the only caller; an empty array is the fast path.
 */
export function activeGooGroups() {
  if (!gooRoot || !gooSettings()) return [];
  const out = [];
  gooGroupNames().forEach((name, i) => {
    if (clock < (gooUntil.get(name) ?? -1)) out.push({ name, index: i + 1, def: gooSurface(name) });
  });
  return out;
}

const attrs = {};

// --- surface pops -----------------------------------------------------------
// The simulation is entirely GPU-side, so nothing on the CPU normally knows
// where a particle IS. Bubbles are the exception: one that reaches the water
// line has to burst there rather than sail on into the sky, and that needs a
// position on this side. Only emitters that ask for it (`surfacePop`, naming
// the burst to fire) are tracked, and the solve below is the same closed form
// the vertex shader uses, so the burst lands exactly where the bubble is drawn.
const tracked = [];
// A ceiling on the bookkeeping, not on the bubbles: past this, extra particles
// simply aren't followed and fade out on their own timer as they always did.
//
// Sized against everything that can be bubbling at once, which since the hulls
// started shedding wakes (systems/boatWake.js) is no longer just the seal: the
// player's breath and wake, plus up to `boats.maxAlive` hulls and a boat boss.
// A hull's bubbles are born a third of a unit under the line and reach it in a
// fraction of their life, so each hull holds far fewer slots than its emission
// rate suggests — but the whole point of a boat wake is the foam, and foam is
// what this list pays for. Overflowing it does not drop bubbles; it drops the
// POPS, which is the effect going quiet exactly when the water is busiest.
const MAX_TRACKED = 384;

// --- uploading only what changed --------------------------------------------
//
// A bare `needsUpdate = true` costs the WHOLE buffer: three's updateBuffer
// falls back to `bufferSubData(0, array)` whenever an attribute carries no
// update ranges. Across these ten attributes at the shipped capacity of 8000
// that is ~530KB re-uploaded in every frame anything was emitted — which, in a
// fight, is every frame. A burst only ever writes a contiguous run of slots,
// so it can say so instead.
//
// EVERY write path in this file has to go through here or clear the ranges
// itself. Ranges and a blanket flag do not mix: if one path adds a range and
// another sets needsUpdate without adding one, the second path's write is
// silently dropped, because the presence of ANY range switches the upload to
// partial for that attribute.

// The whole of one attribute, as a range. See the note in markRange's overflow
// branch for why this is a range and not a cleared list.
function markWhole(attr) {
  attr.addUpdateRange(0, attr.array.length);
  attr.needsUpdate = true;
}

function markRange(start, n) {
  if (n >= capacity) {
    // Wrapped clean past itself, so every slot was touched. Written as an
    // explicit whole-buffer RANGE rather than by clearing the ranges: three
    // merges overlapping ranges before uploading, so this absorbs anything
    // added before or after it in the same frame. Clearing would only win
    // until the next emit added a range, at which point the upload would
    // quietly go back to being partial and this burst would be half-written.
    for (const attr of Object.values(attrs)) markWhole(attr);
    return;
  }
  const end = start + n;
  // The ring buffer wraps, so a run can be one span or two.
  const spans = end <= capacity
    ? [[start, n]]
    : [[start, capacity - start], [0, end - capacity]];
  for (const attr of Object.values(attrs)) {
    const size = attr.itemSize;
    // Ranges are measured in ARRAY ELEMENTS, not in vertices — a vec3 slot
    // three wide starts at index*3. Getting this wrong uploads a third of the
    // burst and leaves the rest as whatever the last owner of those slots put
    // there, which reads as particles spawning at stale positions.
    for (const [s, c] of spans) attr.addUpdateRange(s * size, c * size);
    attr.needsUpdate = true;
  }
}

export function initParticles(scene) {
  disposeParticles(scene);

  capacity = Math.max(64, Math.floor(CONFIG.fx.maxParticles));
  geometry = new THREE.BufferGeometry();

  attrs.position = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  attrs.aVelocity = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  attrs.aColor = new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3);
  attrs.aGravity = new THREE.Float32BufferAttribute(new Float32Array(capacity * 2), 2);
  attrs.aStart = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aLife = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aSize = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aDrag = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aTurb = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aClip = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
  attrs.aGoo = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);

  for (const [name, attr] of Object.entries(attrs)) {
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }

  // Everything starts long dead.
  for (let i = 0; i < capacity; i++) attrs.aStart.array[i] = -1e9;

  material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 40 },
      uTurb: { value: new THREE.Vector3(0, 0.35, 0.6) },
      uSurfaceY: { value: bounds.surfaceY },
      uWaveT: { value: 0 },
      uWaveAmp: { value: sea.amp },
      uChop: { value: sea.chop },
      uGooHide: { value: 0 },
    },
  });

  points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;
  scene.add(points);

  gooMat = new THREE.ShaderMaterial({
    vertexShader: vertexShaderFor(true),
    fragmentShader: gooFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // One/One on BOTH channels, which three's AdditiveBlending is not: that
    // preset multiplies the colour by its own alpha on the way in, and the
    // fragment above has already premultiplied. The alpha channel is the
    // density field itself and has to sum untouched.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    uniforms: {
      uTime: material.uniforms.uTime,
      uScale: { value: 40 },
      uTurb: material.uniforms.uTurb,
      uSurfaceY: material.uniforms.uSurfaceY,
      uWaveT: material.uniforms.uWaveT,
      uWaveAmp: material.uniforms.uWaveAmp,
      uChop: material.uniforms.uChop,
      uGooRadius: { value: 3.2 },
      uGroup: { value: 1 },
    },
  });

  // The shared uniform OBJECTS above are deliberate: the two materials solve
  // the same closed form, and a goo blob drifting on a different current from
  // the spray around it is exactly what a second copy of these values would
  // eventually produce. Only uScale differs (the goo target is smaller).
  gooPoints = new THREE.Points(geometry, gooMat);
  gooPoints.frustumCulled = false;
  gooRoot = new THREE.Scene();
  gooRoot.add(gooPoints);
}

export function disposeParticles(scene) {
  tracked.length = 0;
  gooUntil.clear();
  if (!points) return;
  scene.remove(points);
  geometry.dispose();
  material.dispose();
  gooMat.dispose();
  gooRoot = null;
  gooPoints = null;
  gooMat = null;
  points = null;
  geometry = null;
  material = null;
}

/**
 * The scene and material post.js draws a group with. Whether there is anything
 * to draw is `activeGooGroups()`; this is just the objects.
 */
export function gooLayer() {
  if (!gooRoot) return null;
  return { scene: gooRoot, material: gooMat };
}

// Post owns the goo target's size, and point sizes are in the TARGET's pixels:
// left at the screen's scale, every blob would draw `divisor` times too big and
// the whole field would be one welded slab.
export function setGooDivisor(d) {
  gooDivisor = Math.max(1, d || 1);
}

// Points are sized in pixels, so the world-to-pixel ratio has to follow the
// orthographic camera and the canvas size.
export function updateParticleScale(camera, renderer) {
  if (!material) return;
  // Divided by `zoom`, or a camera punch-in (see world.js) leaves the sprites
  // at their un-zoomed pixel size while everything drawn as geometry around
  // them grows — particles visibly shrinking on the frame the screen punches.
  const viewHeight = (camera.top - camera.bottom) / (camera.zoom || 1);
  if (viewHeight <= 0) return;
  pixelScale = renderer.domElement.height / viewHeight;
  material.uniforms.uScale.value = pixelScale;
  if (gooMat) gooMat.uniforms.uScale.value = pixelScale / gooDivisor;
}

function rand(range, fallback) {
  if (!range) return fallback;
  if (typeof range === 'number') return range;
  return range[0] + Math.random() * (range[1] - range[0]);
}

/**
 * Fire a named burst from CONFIG.emitters.
 * opts: { dirX, dirY, vx, vy, scale, speedMul, glow, color }
 *
 * `color` overrides the emitter's palette for this one burst. It exists for
 * DEATHS and nothing else — see the note at the tint below, and the palette
 * note in CONFIG.emitters for why every other burst is the emitter's colour.
 *
 * `speedMul` scales how hard the burst is thrown, leaving the emitter's spread,
 * size, life and palette alone — `scale` says how MANY, this says how FAST. It
 * exists for the one case a second emitter could not cover: the strike vent
 * fires the mouth's own bubbles as a jet out the back of the seal, and cloning
 * `breathBubbles` with bigger numbers would have meant tuning the seal's breath
 * in two places forever.
 */
export function emit(name, x, y, opts = {}) {
  const def = CONFIG.emitters[name];
  if (!def || !geometry) return;

  const count = Math.max(1, Math.round((def.count ?? 8) * (opts.scale ?? 1)));
  const speedMul = Math.max(0, opts.speedMul ?? 1);
  const colors = def.colors ?? [0xffffff];
  const cone = def.cone ?? 0;
  const inherit = def.inherit ?? 0;
  const baseAngle = Math.atan2(opts.dirY ?? 0, opts.dirX ?? 1);

  const tb = turbSettings();
  const turb = tb ? (def.turbulence ?? 1) : 0;
  // How much the drag of any one particle is allowed to differ from the
  // emitter's figure. Water is not uniform and neither is what's thrown
  // through it: at 0 a burst is a rigid shell of particles all stopping on the
  // same frame, and every value above it spreads that stop out — the light
  // bits stall in the water while the heavy ones punch on through. This is
  // most of what makes a burst read as being IN something rather than as a
  // sprite animation played at a position.
  const dragVary = Math.max(0, tb?.dragVary ?? 0);

  // Bubbles are killed at the water line (see the shader), but only ones that
  // were BORN under it. A puff let out mid-breach started in the air and has no
  // surface left to reach; flagging it would delete it on its first frame.
  const clipsAtSurface = (def.killAtSurface ?? !!def.surfacePop) && y < surfaceHeightAt(x);

  // A goo emitter's particles are drawn by the density pass instead of as
  // sprites — but only while that pass is running. See uGooHide in the shader.
  //
  // An emitter naming a group that does not exist falls back to a SPRITE burst
  // rather than to group 0 or to silence: a typo in a name should cost the look
  // of one emitter, not delete the burst it belongs to.
  const wantsGroup = def.goo && gooSettings() ? gooGroupName(def) : null;
  const gooGroup = wantsGroup ? gooGroupNames().indexOf(wantsGroup) + 1 : 0;
  if (wantsGroup && gooGroup === 0) {
    console.warn(`[particles] emitter "${name}" wants goo group "${def.goo}", which is not in CONFIG.fx.goo.groups`);
  }

  const color = new THREE.Color();

  // A death tint, lifted clear of the water if the creature is a dark one.
  // Resolved ONCE per burst rather than per particle: the lift is a property of
  // the creature, and doing it inside the loop would fight the per-particle
  // brightness scatter below for the same channels. See CONFIG.fx.deathTintMinPeak.
  let tint = null;
  if (opts.color != null) {
    tint = new THREE.Color(opts.color);
    const floor = CONFIG.fx?.deathTintMinPeak ?? 0;
    const peak = Math.max(tint.r, tint.g, tint.b);
    // A creature whose colour is pure black has no hue to preserve, so there is
    // nothing to lift it by — it falls back to the emitter's palette instead of
    // dividing by zero into NaN.
    if (peak <= 0) tint = null;
    else if (peak < floor) tint.multiplyScalar(floor / peak);
  }

  // Where this burst's run of slots begins, for the upload range below.
  const firstIdx = cursor % capacity;

  for (let i = 0; i < count; i++) {
    const idx = cursor % capacity;
    cursor += 1;

    const angle = cone > 0
      ? baseAngle + (Math.random() - 0.5) * cone * 2
      : Math.random() * Math.PI * 2;
    const speed = rand(def.speed, 6) * speedMul;

    const p3 = idx * 3;
    const p2 = idx * 2;

    attrs.position.array[p3] = x;
    attrs.position.array[p3 + 1] = y;
    attrs.position.array[p3 + 2] = 0;

    const vx = Math.cos(angle) * speed + (opts.vx ?? 0) * inherit;
    const vy = Math.sin(angle) * speed + (opts.vy ?? 0) * inherit;
    attrs.aVelocity.array[p3] = vx;
    attrs.aVelocity.array[p3 + 1] = vy;
    attrs.aVelocity.array[p3 + 2] = 0;

    // The emitter's palette — EXCEPT on a death, which is tinted with the
    // creature's own emissive by whoever fired it.
    //
    // This was removed once, on the grounds that a per-creature tint puts a
    // different hue on the screen every second or two across a wave. That is
    // true and it is the point: a kill is the one event where the thing that
    // died is the information, and a fish coming apart in its own colour is
    // what says WHICH fish. The rule the palette note in CONFIG.emitters
    // states — one colour family per emitter, a burst's colour says what KIND
    // of event it was — still holds for every emitter that isn't a death.
    // Deaths are the exception, deliberately, and are never generic: see
    // assetBaseColor, which always answers with a colour rather than falling
    // through to the palette below.
    if (tint) {
      // One hue applied flat to every particle reads as a blob rather than an
      // explosion, so brightness is scattered per particle. That restores the
      // depth the multi-colour palettes give the other emitters while staying
      // unmistakably the one hue.
      color.copy(tint).multiplyScalar(0.65 + Math.random() * 0.7);
    } else {
      color.set(colors[(Math.random() * colors.length) | 0]);
    }
    // Glow overdrive: multiplying color channels past 1.0 here is what
    // actually does something now that particles render to an HDR target —
    // bloom's bright-pass sees the true value, not a pre-clamped 1.0. Each
    // emitter has its own baseline (def.glow), and CONFIG.bloom.particleOverdrive
    // is a global multiplier on top for "way beyond threshold" on demand.
    const glow = (def.glow ?? 1) * (CONFIG.bloom?.particleOverdrive ?? 1) * (opts.glow ?? 1);
    attrs.aColor.array[p3] = color.r * glow;
    attrs.aColor.array[p3 + 1] = color.g * glow;
    attrs.aColor.array[p3 + 2] = color.b * glow;

    attrs.aGravity.array[p2] = def.gravity ? def.gravity[0] : 0;
    attrs.aGravity.array[p2 + 1] = def.gravity ? def.gravity[1] : 0;

    const life = rand(def.life, 0.5);
    // Clamped above zero: a drag of 0 is a particle that never slows, and the
    // closed form divides by it.
    const drag = Math.max(0.05, rand(def.drag, 2) * (1 + (Math.random() * 2 - 1) * dragVary));
    attrs.aStart.array[idx] = clock;
    attrs.aLife.array[idx] = life;
    // Read BACK rather than reusing `clock`. The attribute is a Float32Array
    // and `clock` is a double, so the stored value is a rounded copy of it —
    // and the tracker below compares the two to notice a recycled slot. Kept as
    // the double, that comparison was unequal the instant `clock` stopped being
    // exactly representable, which is a second or so into any real session: the
    // bookkeeping dropped every bubble on the frame after it was emitted and no
    // bubble has burst at the surface since. The bug is invisible in a fresh
    // harness, where clock starts at 0 and every early value is exact.
    const start32 = attrs.aStart.array[idx];
    attrs.aSize.array[idx] = rand(def.size, 0.15);
    attrs.aDrag.array[idx] = drag;
    attrs.aTurb.array[idx] = turb;
    attrs.aClip.array[idx] = clipsAtSurface ? 1 : 0;
    attrs.aGoo.array[idx] = gooGroup;
    // Measured from the LONGEST life this burst rolled, not the emitter's
    // figure: the pass has to still be running on the frame the last blob
    // actually dies, or the goo vanishes a few frames early and reads as a pop.
    if (gooGroup) gooUntil.set(wantsGroup, Math.max(gooUntil.get(wantsGroup) ?? -1, clock + life));

    // The shader kills every flagged particle at the surface no matter what;
    // this list is only about the BURST one leaves behind, which needs a
    // position on the CPU to fire from. Past the cap a bubble still dies at the
    // water line, it just goes quietly.
    if (def.surfacePop && clipsAtSurface && tracked.length < MAX_TRACKED) {
      tracked.push({
        idx,
        start: start32,
        life,
        drag,
        turb,
        x,
        y,
        vx,
        vy,
        gx: attrs.aGravity.array[p2],
        gy: attrs.aGravity.array[p2 + 1],
        pop: def.surfacePop,
      });
    }
  }

  markRange(firstIdx, count);
}

// Solve every tracked bubble's position and burst the ones that have broken
// the surface. Mirrors the vertex shader's closed form exactly — the two
// drifting apart would show up as a pop happening off the bubble.
function updateSurfacePops() {
  if (!tracked.length) return;
  let pops = null;

  for (let i = tracked.length - 1; i >= 0; i--) {
    const p = tracked[i];
    const age = clock - p.start;
    // Slots are a ring buffer, so a busy frame can hand this one to a newer
    // burst. The spawn time is the cheapest thing that says so, and once the
    // slot has been reused the bubble we were following is gone anyway.
    if (age >= p.life || attrs.aStart.array[p.idx] !== p.start) {
      tracked[i] = tracked[tracked.length - 1];
      tracked.pop();
      continue;
    }

    const k = Math.max(p.drag, 0.0001);
    const f = (1 - Math.exp(-k * age)) / k;
    let x = p.x + p.vx * f + 0.5 * p.gx * age * age;
    let y = p.y + p.vy * f + 0.5 * p.gy * age * age;

    // Same push the shader gives it, sampled at the same ballistic position.
    const tb = turbSettings();
    if (tb && p.turb) {
      const freq = tb.frequency ?? 0.35;
      const [tx, ty] = turbulenceAt(x * freq, y * freq, clock * (tb.timeScale ?? 0.6));
      const amt = (tb.strength ?? 0) * p.turb * age;
      x += tx * amt;
      y += ty * amt;
    }

    const surf = surfaceHeightAt(x);
    if (y < surf) continue;

    // Killed outright rather than left to fade: a bubble that has burst is
    // gone, and one still drifting up through its own spray is the tell.
    attrs.aStart.array[p.idx] = -1e9;
    // One slot, one float — aStart is the only attribute this write touches,
    // so it doesn't go through markRange. Still a RANGE rather than a bare flag:
    // an emit earlier in the frame has probably already put ranges on this
    // attribute, and a rangeless write alongside them would be dropped.
    attrs.aStart.addUpdateRange(p.idx, 1);
    attrs.aStart.needsUpdate = true;
    (pops ??= []).push({ x, y: surf, name: p.pop });
    tracked[i] = tracked[tracked.length - 1];
    tracked.pop();
  }

  // Fired after the walk, never during it: emit() writes into the same ring
  // buffer this loop reads, and a burst that recycled a slot mid-walk would be
  // indistinguishable from the bubble that slot used to hold.
  if (!pops) return;
  for (const p of pops) emit(p.name, p.x, p.y, { dirX: 0, dirY: 1 });
}

export function updateParticles(dt) {
  clock += dt;
  if (material) {
    const u = material.uniforms;
    u.uTime.value = clock;

    const tb = turbSettings();
    u.uTurb.value.set(
      tb ? (tb.strength ?? 0) : 0,
      tb?.frequency ?? 0.35,
      tb?.timeScale ?? 0.6,
    );

    // Read rather than pushed in from world.js: the sea state and the wave
    // phase both live in arena.js already, and one more system asking it
    // directly can't fall a frame out of step with the drawn water the way a
    // fourth plumbing route could.
    u.uSurfaceY.value = bounds.surfaceY;
    u.uWaveT.value = waveTimeNow();
    u.uWaveAmp.value = sea.amp;
    u.uChop.value = sea.chop;

    // The sprite pass hides every goo particle whenever the effect is on at
    // all — post.js draws each group in turn. With it off they come straight
    // back as ordinary sprites, which is what makes the toggle safe mid-flight.
    u.uGooHide.value = gooSettings() ? 1 : 0;
  }
  updateSurfacePops();
}

export function resetParticles() {
  if (!geometry) return;
  for (let i = 0; i < capacity; i++) attrs.aStart.array[i] = -1e9;
  // A whole-buffer range, not a cleared list. This runs from the start/restart
  // handler, OUTSIDE the frame loop, and the very next frame emits (the seal
  // starts breathing immediately) — so by upload time this attribute will be
  // carrying that burst's range too. A merged whole-buffer range still uploads
  // everything; a cleared list would have been overruled by it, and the last
  // run's particles would come back to life in the new one.
  markWhole(attrs.aStart);
  cursor = 0;
  tracked.length = 0;
  gooUntil.clear();
}

export function particleCount() {
  return Math.min(cursor, capacity);
}
