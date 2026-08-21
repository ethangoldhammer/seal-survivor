import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { makeOrganicRing, placeOrganicRing, updateOrganicRing, disposeOrganicRing } from './organicRing.js';
import { beatsNow, beatsPerBar, divisionBeats } from './beatSync.js';
import { telegraphMul } from './telegraph.js';

// ---------------------------------------------------------------------------
// THE ATTRACTIVE CLAM — what the trawler drops, and what drags every settled
// scrap of chum on the seabed across the arena and into the seal's mouth.
//
// IT IS GRABBED, not merely dropped: it sinks into the water and waits, and
// the pull does not start until the seal swims into it (see updateBoats). The
// waves below are what makes that a choice the player can see — an uncollected
// clam pulsing on the far side of the arena is an invitation, and after the
// grab the same train follows the seal and shows the field working.
//
// It was a 0.4-unit sphere. The single most powerful pickup in the game, the
// one that empties the whole floor at once, was rendered as the same primitive
// ball as everything else with a different tint on it — so the moment it
// arrived read as "an orb appeared" and the moment it started working read as
// nothing at all. The chum simply began moving.
//
// WHAT IT IS NOW, and each part is doing a job:
//
//   THE MANTLE   a gooey white oval. Not a sphere and not a shell: this thing
//                is soft, and the whole look language of this game's liquids —
//                the blood, the foam, the metaball pass in post.js — is bulbous
//                lobes with surface tension. The wobble is a vertex shader (see
//                GOO_VERTEX) rather than an animated mesh, so one draw call
//                gets a body that is never the same shape twice.
//   THE FLESH    a pink clam bit at the centre, visible THROUGH the mantle,
//                which is why the mantle is translucent. It is the part that
//                looks alive, and it is what the eye lands on.
//   THE WAVES    rings of pink and purple leaving the clam ON THE BEAT. This is
//                the part that actually solves the problem: an attractor field
//                is invisible, so the pickup has to say out loud that it is
//                pulling, and a pulse on the grid says it in the same language
//                every other synced effect in the game speaks (systems/
//                beatSync.js). At `1/4` the clam pumps once a beat and the chum
//                crossing the floor beneath it reads as being pumped.
//
// THE WAVES ARE ORGANIC RINGS (systems/organicRing.js), not a bespoke shader.
// That is deliberate: they are the same soft-edged lobed circle every threat
// tell in the game draws, so a pulse leaving the clam belongs to the same
// world as a boss wind-up rather than being a second circle dialect nobody
// else speaks. What is NOT borrowed is the threat palette — these are pink and
// purple because the clam is, and a wave the colour of a boss tell would be a
// lie about what is happening.
//
// EVERY NUMBER IS IN CONFIG.attractorOrb.look. Nothing here is a literal you
// have to come back and find.
// ---------------------------------------------------------------------------

function look() {
  return CONFIG.attractorOrb?.look ?? {};
}

// ---------------------------------------------------------------------------
// THE GOO. A low-frequency displacement along the normal, three sines beaten
// against each other on the three axes — the cheapest thing that does not read
// as a sphere breathing. Each axis runs at its own rate so the product never
// repeats inside a run.
//
// Injected rather than written as a whole ShaderMaterial so the body keeps
// MeshBasicMaterial's tint, opacity and fog exactly as every other primitive
// asset in the game has them. NO BACKTICK ANYWHERE IN HERE, comments included —
// one ends the template literal and reports itself as a syntax error somewhere
// else entirely.
//
// GLSL ES 1.00: no derivatives, no dynamic loops. This is reachable from a
// WebGL1 context and has to stay that way.
// ---------------------------------------------------------------------------
const GOO_VERTEX = `
  vec3 gooP = position * uGooFreq;
  float goo =
      sin(gooP.x + uGooTime * 1.30)
    * sin(gooP.y * 1.13 - uGooTime * 1.70)
    * sin(gooP.z * 0.87 + uGooTime * 1.10);
  // A second, slower and much broader term. Without it the surface is an even
  // ripple over the whole body, which reads as a texture rather than as mass
  // moving around inside a skin.
  goo += 0.6 * sin(gooP.y * 0.41 + uGooTime * 0.55);
  transformed += normal * goo * uGooAmp;
`;

// The pair the jelly term needs: the view-space normal and the direction back
// to the eye. Injected AFTER <project_vertex>, which is where `mvPosition` is
// defined — it is a local of that chunk's scope, not a varying, so this cannot
// be hoisted up beside the displacement above.
const GOO_VIEW = `
  vGooN = normalize(normalMatrix * normal);
  vGooV = normalize(-mvPosition.xyz);
`;

// ---------------------------------------------------------------------------
// THE JELLY. The same idea as the bubble's film (makeShellMaterial in
// assets.js) and for the same reason, but the opposite way round in one
// respect: a bubble is a shell of nothing, so it is CLEAR facing you; the
// mantle is a body of jelly, so facing you is where it is thinnest and the
// silhouette is where you are looking through the most of it.
//
// Without this the mantle was a flat white shape at a flat 55% — the same veil
// over the flesh as over open water — and the clam read as a white egg with a
// pink decal on it. One dot product buys the whole difference: the middle goes
// nearly clear, so the flesh is plainly INSIDE something, and the edge thickens
// into a rim that says where the body ends.
//
// NO BACKTICK IN HERE. See the note on GOO_VERTEX.
// ---------------------------------------------------------------------------
const JELLY_FRAGMENT = `
  float jellyFace = 1.0 - abs(dot(normalize(vGooN), normalize(vGooV)));
  float jellyRim = pow(clamp(jellyFace, 0.0, 1.0), uJellyPower);
  vec4 diffuseColor = vec4(
    diffuse * (1.0 + jellyRim * uJellyBoost),
    clamp(opacity * mix(uJellyCore, 1.0, jellyRim), 0.0, 1.0)
  );
`;

/**
 * Wrap a material so its geometry wobbles like something soft.
 *
 * Owns its uniforms on `userData.__goo` for the same reason the bubble film
 * does: onBeforeCompile does not run until the first render, so a write before
 * that would be dropped on the floor.
 */
function makeGooMaterial(opts) {
  const L = look();
  const mat = new THREE.MeshBasicMaterial({
    color: opts.color,
    transparent: opts.jelly || (opts.opacity != null && opts.opacity < 1),
    opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite !== false,
    side: opts.side ?? THREE.FrontSide,
  });
  mat.userData.__goo = {
    uGooTime: { value: 0 },
    uGooAmp: { value: opts.amp ?? 0.06 },
    uGooFreq: { value: opts.freq ?? 3.2 },
    uJellyPower: { value: L.jellyPower ?? 1.4 },
    uJellyCore: { value: L.jellyCore ?? 0.16 },
    uJellyBoost: { value: L.jellyBoost ?? 0.5 },
  };
  const jelly = !!opts.jelly;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.__goo);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nuniform float uGooTime;\nuniform float uGooAmp;\nuniform float uGooFreq;'
        + '\nvarying vec3 vGooN;\nvarying vec3 vGooV;')
      // AFTER <begin_vertex>, which is where `transformed` is declared, and
      // BEFORE <project_vertex>, which consumes it. Anywhere else and the
      // displacement is either undefined or already spent.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GOO_VERTEX)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + GOO_VIEW);
    // The varying is declared in BOTH stages whether or not the jelly term is
    // used, because a varying written in the vertex shader and never declared
    // in the fragment shader is a link error on some drivers and silently fine
    // on others — which is the worst of the two, since it ships.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vGooN;\nvarying vec3 vGooV;\nuniform float uJellyPower;'
        + '\nuniform float uJellyCore;\nuniform float uJellyBoost;');
    if (jelly) {
      shader.fragmentShader = shader.fragmentShader
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', JELLY_FRAGMENT);
    }
  };
  return mat;
}

// ---------------------------------------------------------------------------
// THE BODY
// ---------------------------------------------------------------------------

/**
 * Build one clam. Returns a Group at the origin, scaled to 1 — the caller
 * places it and sizes it (see spawnAttractorOrb in systems/boats.js).
 *
 * Materials are built PER CLAM rather than shared through the asset cache. The
 * wobble clock, the beat phase and the flesh's pulse all live in uniforms, and
 * a shared material would give every clam in the water one heartbeat. There is
 * normally exactly one alive, so the cost is a material, once, per trawler.
 */
export function createAttractiveClam() {
  const L = look();
  const group = new THREE.Group();
  group.name = 'attractiveClam';

  // --- the mantle -----------------------------------------------------------
  // An oval, not a sphere: `elongate` under 1 makes it wider than it is tall,
  // which is what makes it read as a bivalve lying in the water rather than as
  // a ball with something inside it.
  const bodyGeo = new THREE.SphereGeometry(1, L.segments ?? 40, L.segments ?? 40);
  bodyGeo.scale(1, L.elongate ?? 0.72, 0.9);
  const bodyMat = makeGooMaterial({
    color: L.mantleColor ?? 0xfdf4ff,
    // Translucent because the flesh has to be visible through it. This is the
    // ceiling the jelly ramp works under, not a flat veil — see JELLY_FRAGMENT.
    opacity: L.mantleOpacity ?? 0.72,
    amp: L.mantleGoo ?? 0.075,
    freq: L.mantleGooFreq ?? 3.0,
    // Thin facing you, dense at the silhouette. Without this the mantle is a
    // flat white shape and the clam is an egg with a decal on it.
    jelly: true,
    // Both walls of the jelly, and no depth write, so the flesh inside is not
    // z-rejected by the front face wrapped around it. Same reasoning as the
    // bubble film's.
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.renderOrder = 2;
  group.add(body);

  // --- the flesh ------------------------------------------------------------
  // TWO LOBES, not one blob, and this is what makes it a clam. A single ball in
  // the middle of the mantle is an egg yolk; a pair of soft masses meeting
  // along a line is a bivalve, and the mouth between them is the read even when
  // the whole thing is thirty pixels across.
  //
  // They are separate meshes rather than one merged geometry so the pump can
  // move them APART on the beat — the clam gapes, which is the second half of
  // what makes it look alive.
  const flesh = new THREE.Group();
  const r = L.fleshSize ?? 0.5;
  const fleshMat = makeGooMaterial({
    color: L.fleshColor ?? 0xff5fa8,
    opacity: 1,
    amp: L.fleshGoo ?? 0.1,
    // Low, deliberately. At the frequency the mantle uses, a body this small
    // gets four or five lobes across it and comes out as a faceted diamond
    // rather than as something soft — the goo has to be BROAD relative to what
    // it is displacing.
    freq: L.fleshGooFreq ?? 2.2,
  });
  const lobes = [];
  for (const sign of [1, -1]) {
    const geo = new THREE.SphereGeometry(r, 22, 16);
    // Wide, shallow and slightly tapered toward the hinge — a half-shell of
    // meat rather than a squashed ball.
    geo.scale(1.2, 0.5, 0.62);
    const lobe = new THREE.Mesh(geo, fleshMat);
    lobe.position.set(0, sign * r * (L.gape ?? 0.3), 0.1);
    lobes.push(lobe);
    flesh.add(lobe);
  }
  flesh.renderOrder = 1;
  group.add(flesh);

  // The crease — the dark line where the two lobes meet, drawn between them so
  // the gape opens ONTO it. Without it the pair reads as two blobs touching;
  // with it they read as one animal with a mouth.
  const creaseGeo = new THREE.SphereGeometry(r, 20, 10);
  // Narrower than the lobes, so the seam ends inside the flesh rather than
  // cutting all the way through it — a line that reaches the silhouette reads
  // as the animal being sliced in half.
  creaseGeo.scale(1.02, (L.creaseThickness ?? 0.07) / r, 0.5);
  const creaseMat = makeGooMaterial({
    color: L.creaseColor ?? 0x6d0f3d,
    opacity: 1,
    amp: (L.fleshGoo ?? 0.1) * 0.5,
    freq: L.fleshGooFreq ?? 2.2,
  });
  const crease = new THREE.Mesh(creaseGeo, creaseMat);
  // In FRONT of the lobes, so the seam is not swallowed by whichever lobe the
  // depth test happened to prefer this frame.
  crease.position.z = 0.42;
  crease.renderOrder = 0;
  group.add(crease);

  group.userData.clam = {
    body,
    flesh,
    lobes,
    crease,
    // The ring pool. Rings are made on demand and RETURNED rather than
    // disposed: at one wave a beat a clam that lived its full nine seconds
    // would otherwise build and drop about twenty ShaderMaterials, each of
    // which is a shader program lookup.
    waves: [],
    free: [],
    age: 0,
    // Which wave index has already been fired. Compared against the transport,
    // so the count is derived from the beat clock rather than integrated from
    // dt — a dropped frame skips a wave rather than sliding the whole train
    // permanently off the grid.
    lastWave: -1,
  };
  return group;
}

// A ring, from the pool or new.
function takeWave(state, scene) {
  const L = look();
  const mesh = state.free.pop() ?? makeOrganicRing({
    // No threat type: these are not a tell and must not wear the tell palette.
    color: L.waveColorNear ?? 0xff5fd2,
    thickness: L.waveThickness ?? 0.1,
    // Softer and lumpier than a boss ring. A wave of goo leaving a clam has no
    // business having a crisp edge.
    wobble: L.waveWobble ?? 0.9,
    glow: L.waveGlow ?? 2.4,
    // UNDER the creatures, like the rest of the seabed dressing: this is a
    // field in the water, not a readout laid over the fight.
    renderOrder: -2,
  });
  mesh.visible = true;
  scene.add(mesh);
  state.waves.push({ mesh, t: 0 });
  return mesh;
}

/**
 * One clam, one frame.
 *
 * `rawDt` on purpose, and it matters: this is a musical effect, and a wave
 * train that stutters because the game froze for 60ms on a hit is a wave train
 * that is no longer on the beat. Same reasoning as every other beat-synced FX.
 *
 * `scene` is where the waves are parented — NOT the clam group, because a wave
 * has to keep expanding in world space while the clam that made it drifts
 * upward out from under it.
 */
export function updateAttractiveClam(group, dt, scene, rawDt = dt) {
  const state = group?.userData?.clam;
  if (!state) return;
  const L = look();
  state.age += rawDt;

  // THE COACH'S HIGHLIGHT, folded in here rather than written by
  // systems/telegraph.js. This module is the clam's one colour writer — a
  // second one would win on some frames and lose on others depending on which
  // system ran first, and the symptom would be a highlight that flickers. This
  // is the 'ask' mode telegraph.js documents, and it is 1 whenever the coach is
  // talking about something else, which is nearly always.
  const lit = telegraphMul(group);
  paint(state.body, L.mantleColor ?? 0xfdf4ff, lit);
  // The lobes share one material, so painting either one paints both.
  paint(state.lobes[0], L.fleshColor ?? 0xff5fa8, lit);
  paint(state.crease, L.creaseColor ?? 0xb01e63, lit);

  // --- the wobble clocks ----------------------------------------------------
  // One shared age, three different rates, so the mantle and the flesh inside
  // it are never in phase — a body and its contents moving as one is the thing
  // that reads as a solid object.
  setGooTime(state.body, state.age * (L.mantleGooRate ?? 1));
  setGooTime(state.lobes[0], state.age * (L.fleshGooRate ?? 1.6));
  setGooTime(state.crease, state.age * (L.fleshGooRate ?? 1.6));

  // --- the pump -------------------------------------------------------------
  // THE FLESH BREATHES ON THE GRID. Derived from the transport rather than
  // integrated, for the same reason the wave index is: a pulse that drifts is
  // worse than no pulse, because it reads as almost-but-not-quite in time.
  const division = L.waveSync ?? '1/4';
  const beats = Math.max(0.0001, divisionBeats(division) || beatsPerBar());
  const cycles = beatsNow() / beats;
  const phase = cycles - Math.floor(cycles);
  // A heartbeat, not a sine: fast out, slow back. `pump ** 3` is what puts the
  // energy at the top of the cycle where the wave leaves.
  const pump = Math.pow(1 - phase, 3);
  const swell = 1 + (L.pumpDepth ?? 0.22) * pump;
  state.flesh.scale.setScalar(swell);
  state.crease.scale.setScalar(swell * 1.02);
  // AND IT GAPES. The lobes part on the beat and close between beats, which is
  // the half of the pulse that says the wave came from something alive rather
  // than from a light being turned up.
  const gape = (L.fleshSize ?? 0.5) * ((L.gape ?? 0.3) + (L.gapeDepth ?? 0.34) * pump);
  for (let i = 0; i < state.lobes.length; i++) {
    state.lobes[i].position.y = (i === 0 ? 1 : -1) * gape;
  }
  // The mantle answers a beat late and much softer — jelly does not move when
  // the thing inside it does.
  state.body.scale.setScalar(1 + (L.pumpDepth ?? 0.22) * 0.35 * Math.pow(1 - phase, 6));

  // --- the waves ------------------------------------------------------------
  const index = Math.floor(cycles);
  if (index !== state.lastWave) {
    // `!==`, not `>`: the transport SNAPS when the music starts (see the
    // fallback clock in beatSync.js), and that snap can move the index
    // backwards. Firing on any change means one wave at the join instead of a
    // clam that goes silent for however many bars the jump was worth.
    state.lastWave = index;
    if (scene) takeWave(state, scene);
  }

  const travel = Math.max(0.01, L.waveTravel ?? 1.1);
  const maxR = L.waveRadius ?? 7;
  const near = new THREE.Color(L.waveColorNear ?? 0xff5fd2);
  const far = new THREE.Color(L.waveColorFar ?? 0x8a3cff);
  for (let i = state.waves.length - 1; i >= 0; i--) {
    const w = state.waves[i];
    w.t += rawDt / travel;
    if (w.t >= 1) {
      w.mesh.parent?.remove(w.mesh);
      state.free.push(w.mesh);
      state.waves.splice(i, 1);
      continue;
    }
    // Eased out, so a wave leaves fast and settles — a linear expansion reads
    // as a circle being drawn rather than as something travelling through
    // water.
    const e = 1 - Math.pow(1 - w.t, 2.2);
    placeOrganicRing(w.mesh, group.position.x, group.position.y, 0.35 + maxR * e, group.position.z - 0.01);
    // PINK AT THE CLAM, PURPLE AT THE EDGE. The colour is what carries the
    // distance: a wave that only faded would be the same event at every radius.
    const col = near.clone().lerp(far, e);
    // Thickness and glow are pushed every frame, not only at creation, because
    // rings are POOLED: one made before a slider moved would keep the old
    // number for as long as the clam lived, so half the train would answer the
    // control and half would not.
    updateOrganicRing(w.mesh, rawDt, {
      opacity: (L.waveOpacity ?? 0.95) * Math.pow(1 - w.t, 1.6),
      color: col,
      thickness: L.waveThickness ?? 0.13,
      glow: L.waveGlow ?? 3.0,
    });
    // No setter for this one on organicRing's side — it is a creation-time
    // option there because every other caller sets it once. Written straight in
    // for the same pooling reason as the two above.
    const uw = w.mesh.material?.uniforms?.uWobble;
    if (uw) uw.value = L.waveWobble ?? 0.9;
  }
}

// Its own material, per clam, so this cannot reach any other object — see the
// note in createAttractiveClam about why the materials are not shared.
const _paintTmp = new THREE.Color();
function paint(mesh, hex, mul) {
  const c = mesh?.material?.color;
  if (!c) return;
  c.copy(_paintTmp.set(hex)).multiplyScalar(mul);
}

function setGooTime(mesh, t) {
  const u = mesh?.material?.userData?.__goo;
  if (u) u.uGooTime.value = t;
}

/** Give back everything a clam is holding. Called when the orb expires. */
export function disposeAttractiveClam(group) {
  const state = group?.userData?.clam;
  if (!state) return;
  for (const w of state.waves) disposeOrganicRing(w.mesh);
  for (const m of state.free) disposeOrganicRing(m);
  state.waves.length = 0;
  state.free.length = 0;
  for (const m of [state.body, state.crease, ...state.lobes]) {
    m.geometry?.dispose?.();
    m.material?.dispose?.();
  }
}

// For the harness and the look page — the injected GLSL is otherwise
// unreachable from Node, and the realistic failure (a uniform named on one side
// and not the other) is silently invisible rather than an error. Same escape
// hatch organicRing.js and marks.js already keep.
export const __clamShader = { GOO_VERTEX, GOO_VIEW, JELLY_FRAGMENT };
