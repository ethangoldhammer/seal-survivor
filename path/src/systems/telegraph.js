import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// THE THING BEING TALKED ABOUT, LIT UP.
//
// While a first-run tip is on screen, whatever it is about pulses. Not a ring
// drawn around it, not an outline, not an icon: the object's OWN colour driven
// up and down, so that "this one's a real deal seal meal" and the red lump
// throbbing in the water are the same sentence said twice. On a first run there
// are four kinds of glowing thing on screen at once and the words alone cannot
// say which one they mean.
//
// ONE SUBJECT AT A TIME, and it is always the live tip's — see
// tutorialState.subjectMesh. There is no queue and no stack: two things pulsing
// is two things claiming to be what the sentence is about.
//
// TWO WAYS TO PUSH A GLOW, because the pickups are built two ways and neither
// can be made to do the other's job:
//
//   'ask'    the object ALREADY has a per-frame writer for its brightness — a
//            chum orb's instance colour (setGlow), a chunk's own material
//            (chunkBrightness). Those owners multiply by telegraphMul() where
//            they already write, and nothing here touches the object at all.
//            A second writer on the same colour is the bug where one of the
//            two silently never lands, and it would land on the frames where
//            the two happened to run in the other order.
//   'paint'  the object has a STATIC colour and no writer — the three floating
//            orbs and the attractor. Here the pulse is written directly, onto a
//            material cloned for the purpose, and the original is put back when
//            the tip is done.
//
// WHY THE CLONE. Primitive assets share ONE material across every instance (see
// assets.js), so writing a pulse to a bubble's material pulses every bubble in
// the arena — including the four the tip is not about, which is precisely the
// confusion this system exists to remove.
//
// AND WHY IT IS GUARDED. A clone drops onBeforeCompile outright, so anything
// wearing an injected shader (a bubble shell's fresnel, a bioluminescent skin)
// would lose it and render as a flat blob for as long as it was being
// explained. Those objects fall back to no push at all rather than to a
// silently broken one — see paintable().
//
// The pulse is CONFIG.tutorial.telegraph, and it multiplies the colour the
// object already has rather than replacing it. A chunk goes bright red because
// a chunk IS red; a bubble goes bright white for the same reason. Recolouring
// everything to one "look at me" hue would teach the player that the highlight
// colour means something, which it does not.
// ---------------------------------------------------------------------------

const state = {
  mesh: null,
  mode: 'none',
  clock: 0,
  // The material we swapped in, and the one we took out — both, because
  // restoring means putting the original reference back, not copying values
  // into it. The shared original is still being used by everything else in the
  // water and must never be written to at all.
  painted: null,
  original: null,
  base: null,
};

/** For a harness, and for the tuner's readout. Never written from outside. */
export const telegraphState = state;

function cfg() {
  return CONFIG.tutorial?.telegraph ?? {};
}

/**
 * How bright the subject should be right now, as a multiplier on the colour it
 * already wears. 1 when nothing is being talked about.
 *
 * Starts AND ends at 1 rather than at the peak: a pulse that began at its
 * brightest would flash on the frame the tip appeared, which is a hit-flash —
 * the language the game already uses for damage. What this has to read as is
 * something breathing.
 */
export function telegraphPulse(clock = state.clock) {
  const c = cfg();
  if (c.enabled === false) return 1;
  const peak = c.boost ?? 2.6;
  const hz = c.hz ?? 1.6;
  return 1 + (peak - 1) * (0.5 - 0.5 * Math.cos(clock * hz * Math.PI * 2));
}

/**
 * The multiplier for one object — 1 for everything that is not the subject.
 *
 * Called from inside the pickup loops, so it is on the hot path for every orb
 * in the water: an identity compare and a return, on the frames when nothing is
 * lit at all.
 */
export function telegraphMul(mesh) {
  if (!mesh || state.mesh !== mesh || state.mode !== 'ask') return 1;
  return telegraphPulse();
}

/**
 * Point the light at something, or at nothing.
 *
 * Called every frame from the frame loop with whatever the coach is currently
 * talking about, rather than once at each end — the subject can be swallowed,
 * expire, or be replaced by the next tip's, and a system that had to be told
 * about each of those would leak a lit object the first time somebody added a
 * fourth way for a pickup to leave the water.
 */
export function setTelegraph(mesh, mode = 'ask') {
  const want = mesh ?? null;
  if (state.mesh === want && state.mode === (want ? mode : 'none')) return;
  release();
  state.mesh = want;
  state.mode = want ? mode : 'none';
  state.clock = 0;
  if (want && mode === 'paint') claim(want);
}

/** Between runs, and on the frame the coach goes quiet for good. */
export function clearTelegraph() {
  setTelegraph(null);
}

/**
 * One frame. Real time on purpose: the pulse is a piece of UI wearing an
 * object's clothes, and it should keep breathing at the same rate through a
 * hit-stop like every other callout does.
 */
export function updateTelegraph(dt) {
  if (!state.mesh) return;
  state.clock += dt;
  if (state.mode !== 'paint' || !state.painted || !state.base) return;
  // The one place this system writes anything. `copy` then multiply, never a
  // running multiply on the live colour — that compounds and the orb is white
  // within a second.
  state.painted.color.copy(state.base).multiplyScalar(telegraphPulse());
}

// ---------------------------------------------------------------------------
// The paint path
// ---------------------------------------------------------------------------

// Can this material be cloned and driven without losing what it already does?
//
// Own-property onBeforeCompile is the real test: three defines a no-op on the
// prototype, so `typeof m.onBeforeCompile === 'function'` is true of every
// material in the game and would answer "no" to all of them.
function paintable(material) {
  if (!material?.color) return false;
  if (Object.hasOwn(material, 'onBeforeCompile')) return false;
  // A look texture is registered against the material's own id (see the
  // lookTextures registry) — a clone is a different material wearing a
  // borrowed id, which is a lie about which texture belongs to what.
  if (material.userData?.__lookId != null) return false;
  return true;
}

function claim(mesh) {
  const material = mesh.material;
  if (!paintable(material)) {
    // Nothing to push. The tip still stands beside it and the arrow still
    // finds it; this is a highlight, not the message.
    state.mode = 'none';
    return;
  }
  // A material this object already owns alone (a chunk clones its own at
  // spawn) is written in place. Cloning a clone would be a second copy to keep
  // in step with the first, and the first is the one the object's own systems
  // are reading.
  const own = mesh.userData?.ownMaterial === true;
  state.original = own ? null : material;
  state.painted = own ? material : material.clone();
  state.base = state.painted.color.clone();
  if (!own) mesh.material = state.painted;
}

function release() {
  const mesh = state.mesh;
  if (mesh && state.painted) {
    // Put the colour back before the material goes anywhere. An object we
    // painted in place (a chunk) keeps its own material and would otherwise be
    // left at whatever brightness the pulse happened to be on the frame the
    // tip ended.
    if (state.base) state.painted.color.copy(state.base);
    if (state.original) {
      mesh.material = state.original;
      state.painted.dispose?.();
    }
  }
  state.painted = null;
  state.original = null;
  state.base = null;
  state.mesh = null;
  state.mode = 'none';
  state.clock = 0;
}
