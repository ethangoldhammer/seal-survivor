import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { advanceCycles } from './beatSync.js';
import { rollNoteColor } from './noteStorm.js';
import { telegraphMul } from './telegraph.js';

// ---------------------------------------------------------------------------
// THE LEVEL BLOB — the pickup that levels up something you already have.
//
// Every other floating pickup in the game hands you a RESOURCE: a bar, a
// breath, eight seconds of a faster gun. This one reaches into the build and
// adds a stack to a card you already took, which is the only thing in the water
// that changes the run permanently. So it does not look like the others: it is
// not a rock, not a coral and not a bubble, it is a blob of something molten
// that will not settle on a colour.
//
// WHAT IT IS MADE OF, and why each half is here:
//
//   A BLOB, GROWN.   An icosphere pushed around by three beaten sines, rolled
//                    per spawn. It has no flat faces and no axis, which is what
//                    keeps it from reading as another tumbling stone — the two
//                    rock pickups already own that silhouette, and a third
//                    would be a third tint on one shape (see the header of
//                    systems/coralOrb.js, which is the same argument).
//   HOT, NOT LIT.    The brightness is a FACING term: the middle of the
//                    silhouette goes white and the edge keeps the colour, so it
//                    reads as something glowing from the inside rather than as
//                    a ball with a lamp on it. With an orthographic camera the
//                    eye looks straight down view -Z, so "facing" is the
//                    view-space normal's z and costs one abs().
//   BRAIN-CORAL.     The surface is cut by meandering grooves — domain-warped
//                    stripes, which is what makes them wander and fold back
//                    instead of running parallel. They SUBTRACT from the
//                    finished colour, so a channel crossing the hot core reads
//                    as a valley in a glowing mass. Ethan asked for a brain
//                    coral here (2026-08-20) and this is that read without a
//                    175k-triangle photogrammetry scan in the bundle.
//   ON THE BEAT.     The colour changes on the NOTE, quarter notes by default,
//                    through systems/beatSync.js like every other synced effect
//                    — and it pops on the same edge, so the thing you see is
//                    the same event you are hearing.
//
// THE COLOUR ROLL IS NOT A RANDOM HEX. A random hue does not bloom: the bright
// pass thresholds Rec.709 luminance, so a saturated blue and a saturated green
// at the same value are a factor of ten apart and a colour-shifting object
// spends a third of its cycle looking switched off. `rollNoteColor` in
// systems/noteStorm.js already solved exactly this for the music notes and is
// borrowed whole rather than re-derived here — this asset wants the WHOLE
// wheel (a blob that avoided half the spectrum would be a blob with a palette,
// which is not what "shifts colours" means), so it takes the `lum` mode, where
// the hue is exact and the halo strongly coloured and the core goes white
// through the composite's knee. On a thing whose whole read is a white-hot
// centre, that last part is the effect rather than the cost.
//
// Numbers: CONFIG.levelPickup.blob. What it is WORTH is not here — that is
// applyLevelOrb in main.js, and it is a gameplay question.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.levelPickup?.blob ?? {};
}

// ---------------------------------------------------------------------------
// GROWING ONE
// ---------------------------------------------------------------------------

/**
 * A lumpy ball, as one BufferGeometry.
 *
 * `rand` is injected for the same reason the coral's is: the promise of the
 * asset is that no two are the same shape, and the only way to ask whether that
 * is true is to grow several from known seeds and measure them.
 *
 * The displacement is three sines beaten together rather than a real noise
 * field. At this size — one object, a couple of hundred vertices, on screen for
 * fourteen seconds — the difference is invisible, and a sine sum has the one
 * property that matters here: it is continuous over the whole sphere, so the
 * seam an octave-based noise would leave along the icosphere's poles does not
 * exist to be hidden.
 */
export function growBlob(rand = Math.random) {
  const c = cfg();
  const detail = Math.max(1, Math.min(4, Math.round(c.detail ?? 3)));
  // WELDED FIRST, and this is not an optimisation — it is the difference
  // between a blob and a bag of triangles. three's polyhedron geometries are
  // NON-INDEXED: every triangle carries its own three vertices, so
  // computeVertexNormals() below has no shared vertex to average across and
  // hands back FLAT face normals. The whole read here is a facing term off
  // those normals, so an unwelded body comes out visibly faceted with a
  // different brightness per triangle — and nothing warns, because a faceted
  // sphere is a perfectly valid mesh.
  //
  // It also has to happen BEFORE the displacement: welding afterwards would
  // have to match vertices that have already been pushed apart.
  const geo = mergeVertices(new THREE.IcosahedronGeometry(0.5, detail));
  const p = geo.attributes.position;

  // Three frequencies and three phases, rolled once for the whole body — the
  // lumps have to be a property of THIS blob and not of each vertex, or the
  // surface comes out as static rather than as a shape.
  const amp = c.lump ?? 0.3;
  const f = [
    (c.lumpScale ?? 3.1) * (0.7 + rand() * 0.6),
    (c.lumpScale ?? 3.1) * (0.7 + rand() * 0.6) * 1.37,
    (c.lumpScale ?? 3.1) * (0.7 + rand() * 0.6) * 0.71,
  ];
  const ph = [rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2];

  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // SUMMED, not multiplied. A product of three sines is near zero almost
    // everywhere — the three have to peak together to move a vertex at all —
    // so a body displaced by one comes out very nearly a sphere however hard
    // the amplitude is pushed, and the only way to get lobes out of it is to
    // push `lump` past the point where the surface folds through itself. A
    // weighted sum spends its amplitude across the whole body instead, which
    // is what makes this a blob rather than a slightly dented ball.
    const n = (Math.sin(v.x * f[0] + ph[0]) * 0.5
      + Math.sin(v.y * f[1] + ph[1]) * 0.3
      + Math.sin(v.z * f[2] + ph[2]) * 0.2);
    // Along the vertex's own direction, which on a sphere IS the normal — so
    // the body swells and dents instead of shearing.
    const k = 1 + amp * n;
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();

  // Normalised to a known size, exactly as the coral is: the numbers above are
  // about the SHAPE (how deep the lumps are relative to the body), and how big
  // the pickup actually is stays assets.csv's business. Without this a lucky
  // roll is a third bigger than an unlucky one.
  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const biggest = Math.max(size.x, size.y, size.z) || 1;
  const fit = (c.fit ?? 0.8) / biggest;
  geo.scale(fit, fit, fit);
  return geo;
}

// ---------------------------------------------------------------------------
// THE LIGHT
// ---------------------------------------------------------------------------

// NO BACKTICK ANYWHERE IN HERE, comments included — one ends the template
// literal and reports itself as a syntax error somewhere else entirely. And no
// fwidth or dFdx: an injected shader has to compile under GLSL ES 1.00, where
// the derivative extension is not reachable.
const BLOB_FRAGMENT = `
  vec3 levelCol = mix(uLevelA, uLevelB, uLevelMix);
  // THE FACING TERM. The camera is orthographic and unrotated (see
  // createWorld), so the eye direction in view space is a constant and the
  // amount a fragment faces the lens is just its view-space normal's z. 1 in
  // the middle of the silhouette, 0 on the rim.
  float levelFace = abs(normalize(vLevelN).z);
  float levelCore = pow(levelFace, uLevelCore);
  // THE MEANDER — brain-coral grooves, in the blob's OWN space rather than in
  // screen space, so they wrap the body and turn with it instead of being a
  // pattern painted on the glass in front of it.
  //
  // Plain stripes DOMAIN-WARPED by two more sines, which is the whole of what
  // separates a brain coral from a barcode: sin(x) alone is a set of parallel
  // bands, and displacing its argument by a wave in the other two axes makes
  // each band wander, fold back and run alongside its neighbours. uLevelWarp is
  // how far they wander, and it is the one number here worth dragging.
  vec3 levelQ = vLevelP * uLevelChurnScale;
  float levelWander = sin(levelQ.x
    + uLevelWarp * sin(levelQ.y * 0.9 + uLevelTime * 0.35)
    + uLevelWarp * 0.6 * sin(levelQ.z * 1.3 - uLevelTime * 0.22));
  // 1 along the centre of a groove, 0 on the crests between them, then narrowed
  // by a power so the grooves are thin channels rather than half the surface.
  float levelGroove = 1.0 - uLevelChurn * pow(1.0 - abs(levelWander), uLevelGroove);
  // Colour on the body, WHITE in the core, and the rim carrying the colour
  // outward for the bloom to find. The white is added rather than mixed toward:
  // a mix would take the hue out of the middle at full strength and leave a
  // grey disc, where an add leaves a hot centre that is still the note's colour
  // underneath.
  // THE BODY ITSELF RAMPS WITH THE FACING, and this is the part that makes it
  // a sphere rather than a sticker. Without it the only gradient on the object
  // is whatever the core adds, which means the core has to be enormous to be
  // seen — and a core that big pushes the whole disc past the composite's knee,
  // where it is compressed back to a flat pale lozenge. Dimming the body toward
  // the silhouette buys the same read for nothing and leaves the colour
  // saturated everywhere the core is not.
  vec3 levelOut = levelCol * mix(uLevelDim, 1.0, levelFace);
  levelOut += vec3(uLevelWhite) * levelCore;
  levelOut += levelCol * uLevelRim * (1.0 - levelFace);
  // THE GROOVES SUBTRACT, and they are applied to the finished colour rather
  // than to the body alone. That is the difference between a shape and a
  // pattern: a channel cut across the hot core reads as a real valley in a
  // glowing mass, where the same pattern ADDED anywhere becomes a pale swirl
  // that owns the brightest part of the object and turns the blob into a
  // marble. An earlier version added it, and that is exactly what it looked
  // like.
  levelOut *= levelGroove;
  // Times the material's own colour, which is what leaves the coach's highlight
  // a way in — see the telegraph note in updateLevelOrb. It is white at rest,
  // so this multiply is free.
  vec4 diffuseColor = vec4(levelOut * diffuse, opacity);
`;

function makeBlobMaterial() {
  const c = cfg();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  mat.userData.__levelBlob = {
    uLevelA: { value: new THREE.Color(1, 1, 1) },
    uLevelB: { value: new THREE.Color(1, 1, 1) },
    uLevelMix: { value: 0 },
    uLevelTime: { value: 0 },
    uLevelCore: { value: c.corePower ?? 2.6 },
    uLevelWhite: { value: c.core ?? 1.6 },
    uLevelDim: { value: c.dim ?? 0.42 },
    uLevelRim: { value: c.rim ?? 0.9 },
    uLevelChurn: { value: c.churn ?? 0.35 },
    uLevelChurnScale: { value: c.churnScale ?? 7 },
    uLevelWarp: { value: c.warp ?? 1.6 },
    uLevelGroove: { value: c.groove ?? 5 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.__levelBlob);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vLevelN;\nvarying vec3 vLevelP;')
      // `normal` and `normalMatrix` are both in three's own prefix for a
      // non-raw material, but MeshBasicMaterial only runs the normal chunks
      // under USE_ENVMAP or USE_SKINNING — so this reads the attribute
      // directly rather than `objectNormal`, which does not exist here.
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n\tvLevelN = normalize(normalMatrix * normal);\n\tvLevelP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform vec3 uLevelA;\nuniform vec3 uLevelB;\nuniform float uLevelMix;'
        + '\nuniform float uLevelTime;\nuniform float uLevelCore;\nuniform float uLevelWhite;'
        + '\nuniform float uLevelDim;'
        + '\nuniform float uLevelRim;\nuniform float uLevelChurn;\nuniform float uLevelChurnScale;'
        + '\nuniform float uLevelWarp;\nuniform float uLevelGroove;'
        + '\nvarying vec3 vLevelN;\nvarying vec3 vLevelP;')
      // The line that DECLARES diffuseColor, so the tint and the alpha test
      // downstream still run on top of it — the same injection point, and the
      // same reason, as the coral's and the bubble film's.
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', BLOB_FRAGMENT);
  };
  return mat;
}

// ---------------------------------------------------------------------------
// THE COLOUR ON THE NOTE
// ---------------------------------------------------------------------------

/**
 * The next colour, given the one it is leaving.
 *
 * A PLAIN RANDOM HUE IS THE WRONG ROLL, and not for the bloom reason the header
 * covers — that is rollNoteColor's job. It is that two consecutive rolls land
 * near each other about as often as anywhere else, and a "colour change" the
 * player cannot see is a beat where the effect looks broken. So the hue is
 * stepped rather than picked: at least `minStep` of the wheel away, in either
 * direction, which is one line of arithmetic and no rejection loop.
 *
 * Exported for the harness, which asserts the step directly — "does it ever
 * repeat itself" is a question about this function and measuring it through a
 * run would be measuring the run.
 */
export function nextBlobHue(prevHue, rand = Math.random, minStep = 0.18) {
  const step = Math.min(0.49, Math.max(0, minStep));
  // The whole wheel minus the two arcs within `step` of where we are, folded
  // so a roll of 0 lands exactly `step` ahead and a roll of 1 exactly `step`
  // behind.
  const span = 1 - 2 * step;
  return (prevHue + step + rand() * span) % 1;
}

function rollBlobColor(hue) {
  const c = cfg();
  // `hues` is a one-hue arc, which is how rollNoteColor is asked for a
  // SPECIFIC hue rather than a random one — the stepping above owns the
  // randomness, and letting the roll pick again would undo it.
  return rollNoteColor(() => 0, {
    hues: [hue, hue],
    mode: c.colorMode ?? 'lum',
    glow: c.glow ?? 2.4,
    lumTarget: c.lumTarget ?? 1.6,
    saturation: c.saturation ?? 0.95,
  });
}

// ---------------------------------------------------------------------------
// THE PICKUP
// ---------------------------------------------------------------------------

/**
 * One level blob — a Mesh with its own grown geometry and its own material.
 *
 * BOTH are per instance, exactly as the coral's are: the geometry because the
 * shape is the point, and the material because the colour lives in uniforms and
 * a shared one would beat every blob in the water as a single organism. At most
 * one of these is alive at a time, so this is one draw call's worth of state.
 */
export function createLevelOrb(rand = Math.random) {
  const c = cfg();
  const mesh = new THREE.Mesh(growBlob(rand), makeBlobMaterial());
  mesh.name = 'levelOrb';
  const hue = rand();
  const first = rollBlobColor(hue);
  const u = mesh.material.userData.__levelBlob;
  u.uLevelA.value.setRGB(first.r, first.g, first.b);
  u.uLevelB.value.setRGB(first.r, first.g, first.b);
  mesh.userData.levelOrb = {
    hue,
    // Where in the current note we are, 0..1. The wrap is the note edge — see
    // updateLevelOrb, and count the EDGE rather than testing a window, which is
    // the trap this project has been bitten by before.
    cycle: 0,
    lastCycle: 0,
    spin: (rand() < 0.5 ? -1 : 1) * (c.spin ?? 0.7) * (0.7 + rand() * 0.6),
    churnClock: rand() * 40,
    // How far through the pop the last note edge started, 1 fresh and 0 spent.
    pop: 0,
  };
  mesh.rotation.set(rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2);
  return mesh;
}

/**
 * One blob, one frame.
 *
 * `rawDt` for the same reason every other beat-synced effect takes it: the
 * colour is on the musical grid, and a note does not arrive late because the
 * game froze for 60ms on a hit. The TURN takes the dilated `dt`, because that
 * is the object moving in the water and the water is what a hit-stop holds.
 */
export function updateLevelOrb(mesh, dt, rawDt = dt) {
  const state = mesh?.userData?.levelOrb;
  if (!state) return;
  const c = cfg();
  const u = mesh.material?.userData?.__levelBlob;

  mesh.rotation.y += state.spin * dt;
  mesh.rotation.x += state.spin * 0.43 * dt;

  // THE NOTE. `wrap` 1 because nothing reads the count except the wrap test and
  // the blend below, both of which want it inside one cycle.
  state.cycle = advanceCycles(
    state.cycle, c.colorSync ?? '1/4', c.colorFreeRate ?? 2, rawDt, 1,
  );
  // A NEW NOTE IS THE WRAP, an edge and not a window. The obvious version —
  // "is the cycle inside the first few hundredths" — counts one note many times
  // at a high frame rate and no times at all if a frame straddles it.
  if (state.cycle < state.lastCycle) {
    state.hue = nextBlobHue(state.hue, Math.random, c.hueStep ?? 0.18);
    const next = rollBlobColor(state.hue);
    if (u) {
      // The colour it is arriving AT becomes the one it is leaving, so the
      // crossfade below always runs between two real colours rather than
      // snapping to the new one and fading from it.
      u.uLevelA.value.copy(u.uLevelB.value);
      u.uLevelB.value.setRGB(next.r, next.g, next.b);
    }
    state.pop = 1;
  }
  state.lastCycle = state.cycle;

  // THE CROSSFADE, MEASURED IN NOTE and not in seconds. `blendFrac` is how much
  // of the note the change takes, so the whole effect retimes with the tempo
  // for free and a slower loop gets a slower shift rather than a snap followed
  // by a wait.
  const blend = Math.max(0.01, Math.min(1, c.blendFrac ?? 0.35));
  if (u) {
    u.uLevelMix.value = Math.min(1, state.cycle / blend);
    state.churnClock += rawDt * (c.churnRate ?? 1.1);
    u.uLevelTime.value = state.churnClock;
  }

  // THE POP, on the same edge as the colour. Decayed on its own clock rather
  // than read off the cycle, so it stays a short kick at any tempo instead of
  // stretching into a slow breath when the music drops.
  state.pop = Math.max(0, state.pop - rawDt / Math.max(0.01, c.popSeconds ?? 0.18));
  const swell = 1 + (c.pop ?? 0.16) * state.pop * state.pop;
  mesh.scale.setScalar((state.baseScale ?? 1) * swell);

  // The coach's highlight, folded in here because this module is the blob's one
  // colour writer — the 'ask' mode in systems/telegraph.js. 1 whenever the tip
  // on screen is about something else, which is nearly always. It reaches the
  // shader through `diffuse`, which the injection multiplies by.
  mesh.material?.color?.setScalar(telegraphMul(mesh));
}

/**
 * Remember the scale the spawner set, so the pop above is a swell ON it rather
 * than a replacement for it.
 *
 * It is a separate call rather than an argument to createLevelOrb because the
 * asset's size multiplier is applied by the spawner, after the mesh exists —
 * see spawnLevelOrb, and see the note in this project's memory about a
 * setScalar after createVisual losing exactly this.
 */
export function setLevelOrbScale(mesh, scale) {
  const state = mesh?.userData?.levelOrb;
  if (!state) return;
  state.baseScale = scale;
  mesh.scale.setScalar(scale);
}

/**
 * The colour it is wearing RIGHT NOW, as a hex number.
 *
 * For the burst it leaves when it is swallowed. The obvious alternative — an
 * `assetBaseColor('levelOrb')` like every other pickup's — would be a lie about
 * this one specifically: it has no base colour, and a burst in a fixed tint
 * would be the one frame of the whole effect that was not on the beat.
 *
 * The MIXED colour, not the note it is heading for, because the crossfade is
 * genuinely what is on screen for a third of every note.
 */
export function levelOrbColor(mesh) {
  const u = mesh?.material?.userData?.__levelBlob;
  if (!u) return 0xffffff;
  const t = u.uLevelMix.value;
  const a = u.uLevelA.value;
  const b = u.uLevelB.value;
  // Clamped on the way out: the roll normalises to a luminance well above 1, so
  // the channels here run past the top of the byte a hex colour has room for.
  const to255 = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return (to255(a.r + (b.r - a.r) * t) << 16)
    | (to255(a.g + (b.g - a.g) * t) << 8)
    | to255(a.b + (b.b - a.b) * t);
}

/** Give back a blob's geometry and material — both are its own. */
export function disposeLevelOrb(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose?.();
  mesh.material?.dispose?.();
}

// For the harness and the look page. Nothing in Node compiles GLSL, so a
// uniform renamed on one side of the pair and not the other is otherwise
// silently invisible rather than an error.
export const __levelBlobShader = { BLOB_FRAGMENT };
