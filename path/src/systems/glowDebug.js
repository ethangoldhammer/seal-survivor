// ============================================================================
// GLOW DEBUG — answering "is this thing actually pulsing?" without a renderer.
//
// The bioluminescent skin has three clocks running at all times (drift, breath,
// flicker; see systems/biolumSkin.js) and they are provably advancing. What is
// NOT guaranteed is that any of that reaches a pixel, and the reason is one
// number nobody thinks about while tuning a pulse:
//
//   THE COMPOSITE CLIPS AT 1.0.
//
// The pattern is ADDED to the frame — `gl_FragColor.rgb += ramp * (mask *
// strength * breathe)` — and the breath is a multiplier around 1:
//
//   breathe = 1 + pulseAmp * sin(cycle * 2pi)
//
// So the lit core swings between strength*(1-pulseAmp) and strength*(1+pulseAmp),
// and if the BOTTOM of that swing is already above 1.0 then every frame of the
// cycle resolves to white. The clock runs, the uniform changes, the fish is a
// flat white shape the entire time. Turning `pulseAmp` UP in that state makes
// it worse, not better, because it pushes the peak further into the clip while
// the trough stays above it — which is exactly the move anyone would try first.
//
// Bloom does not rescue this. The bright pass reads the same clipped composite;
// see the note about the HalfFloat target in biolumSkin.js, which is about the
// bright pass having headroom, not about the composite having any.
//
// The presets were tuned by eye against bloom and every one of them landed
// above the clip — the lanternfish ran 3.20..4.80, so its whole breath and the
// top three quarters of its pattern were one flat white. They have since been
// rescaled by a single factor (relative brightness preserved) so each core sits
// near 1.0 and the cycle crosses it. `npm run test:glowphase` asserts that on
// the values as they LOAD, config.js and the saved snapshot merged, which is
// the only version that can be checked against what is on screen.
// ============================================================================

/**
 * A per-instance variant that forces a creature's existing breath into the
 * visible range, for the Alt+N lineup in main.js.
 *
 * It changes only how BRIGHT the glow is, never how fast the clock runs — the
 * point is to see the pulse that was already there, not to install a different
 * one. Applied through setBiolumSkinVariant, which stamps the per-instance
 * material and so never reaches CONFIG, the shared preset, or the tuning
 * snapshot on disk.
 */
const PULSE_DEMO = {
  pulseAmp: 0.8, // dark trough, clipped peak: the whole cycle is legible
  pulseSync: 'free', // off the beat grid, so it isn't quantised to something fast
  pulseSpeed: 2.1, // radians/sec -> a ~3s breath, slow enough to watch
  flickerAmp: 0, // the stutter would chop up the thing being demonstrated
};

// Where the demos aim the un-breathed core. At 1.0 the cycle runs 0.2..1.8
// against `pulseAmp` above: a trough that goes properly dark and a peak that
// still clips, so the breath is legible at both ends.
const DEMO_CEILING = 1.0;

/**
 * The `strength` that puts a given creature's core at `ceiling`.
 *
 * DERIVED, not hardcoded, and that is the whole point of it existing. The
 * first version of these demos carried `strength: 0.45`, picked by hand when
 * the shared `glow` happened to be 2. `glow` later moved to 1.35 and the demo
 * quietly stopped clearing the clip on the dimmer palettes — a button that
 * claims to prove the pulse works and shows the same flat shape as before is
 * worse than no button, because it gets read as evidence.
 *
 * Depends on the palette as well as `glow`: a preset whose brightest channel
 * is 0.66 (the crab) needs half again the strength of one at 1.0 to land in
 * the same place.
 */
export function strengthForCeiling(cfg = {}, ceiling = DEMO_CEILING) {
  const glow = cfg.glow ?? 1;
  const top = Math.max(
    peakChannel(cfg.colorA ?? 0), peakChannel(cfg.colorB ?? 0), peakChannel(cfg.colorC ?? 0));
  const denom = glow * top;
  return denom > 0 ? ceiling / denom : ceiling;
}

/** The Alt+N variant for one creature, sized against its own palette. */
export function pulseDemoFor(cfg) {
  return { ...PULSE_DEMO, strength: strengthForCeiling(cfg) };
}

/**
 * A per-instance variant that makes the PAN legible in seconds instead of in
 * minutes, for Alt+Shift+N.
 *
 * Unlike PULSE_DEMO this one is not honest about rate, and that is the point:
 * `flow` is authored so a pattern crawls, and a crawl is correct in the game
 * and useless as a test. This answers "is drift wired up on this creature",
 * not "what does it look like". Both the console line and the test say so,
 * because a debug view that silently exaggerates is how a rate gets retuned
 * against a lie.
 *
 * The strength drop is shared with PULSE_DEMO and is what actually lets the
 * pattern be seen at all — see glowContrast.
 */
const PAN_DEMO = {
  flow: 2.5, // ~8x the authored crawl — a feature every 0.4s
  pulseAmp: 0, // hold the brightness still so the only motion is the pattern
  flickerAmp: 0,
};

/**
 * The Alt+Shift+N variant for one creature, sized against its own palette.
 *
 * Aimed BELOW the clip rather than at it, unlike the pulse demo. That one
 * wants its peak to clip — a breath reads as swelling into white and back —
 * but this one holds the brightness still, so anything at or above 1.0 is a
 * flat shape for the whole demo and there is no texture left to watch travel.
 */
export function panDemoFor(cfg) {
  return { ...PAN_DEMO, strength: strengthForCeiling(cfg, DEMO_CEILING * 0.85) };
}

// The one pattern that does NOT translate through the noise field. It has a
// wave travelling head-to-tail off uBioCycle instead, so it is the most
// animated of the set and the least affected by `flow` — see the `pulse`
// branch in FRAG_BODY. tools/glow-phase-test.mjs re-derives this list from the
// shader source, so a branch that gains or loses `drift` fails there rather
// than quietly making this comment wrong.
export const PATTERNS_WITHOUT_DRIFT = ['pulse'];

// Patterns that sample the noise field at a multiple of the base frequency.
// It matters for the pan: `speckle` is bioVoronoi(bp * 4.0 + drift), so its
// features are a quarter the size and the same `flow` moves the pattern across
// the BODY four times slower, even though features turn over just as fast.
const FREQUENCY_MULTIPLE = { speckle: 4 };

const peakChannel = (hex) => Math.max((hex >> 16) & 255, (hex >> 8) & 255, hex & 255) / 255;

/**
 * Where a resolved glow config's breath sits relative to the clip point.
 *
 * `cfg` is a RESOLVED settings object — base, preset and variant already
 * layered, which is what biolumSkin caches on each material as
 * `__bioSkinResolved`. Passing a raw preset would miss the base underneath it
 * and quietly measure the wrong creature.
 *
 * The mask and the ramp are both <= 1, so this measures the brightest the
 * pattern gets anywhere on the body — the core. Dimmer regions cross the clip
 * sooner, which is why a fish whose core is pinned can still show a breath in
 * its penumbra and read as "faintly doing something".
 */
export function glowHeadroom(cfg = {}) {
  const strength = (cfg.strength ?? 1.6) * (cfg.glow ?? 1);
  const amp = cfg.pulseAmp ?? 0;
  const top = Math.max(
    peakChannel(cfg.colorA ?? 0), peakChannel(cfg.colorB ?? 0), peakChannel(cfg.colorC ?? 0));
  const lo = strength * (1 - amp) * top;
  const hi = strength * (1 + amp) * top;
  // `clipped` is the failure: the whole cycle above white. `lo < 1 <= hi` is
  // the good case — a breath that crosses the clip reads as the core swelling
  // and shrinking, which is the effect people think they are tuning.
  return { lo, hi, clipped: lo >= 1, crosses: lo < 1 && hi >= 1 };
}

/**
 * How much of the pattern's SHAPE survives the clip.
 *
 * The breath is not the only casualty of an over-bright core. `bioMaskV` is the
 * pattern itself, 0..1 across the body, and the add is `mask * strength`. So
 * every part of the body where `mask > 1/strength` resolves to the same white
 * regardless of what the mask says there — the blotches, the speckles, the net
 * all flatten into one silhouette with a soft edge.
 *
 * That is why a pattern can be provably panning and still look static: what is
 * moving is the boundary of a white blob, not a texture. Returns the fraction
 * of the mask's range that still carries visible detail.
 */
export function glowContrast(cfg = {}) {
  const strength = (cfg.strength ?? 1.6) * (cfg.glow ?? 1);
  const top = Math.max(
    peakChannel(cfg.colorA ?? 0), peakChannel(cfg.colorB ?? 0), peakChannel(cfg.colorC ?? 0));
  const ceiling = strength * top;
  return ceiling <= 0 ? 1 : Math.min(1, 1 / ceiling);
}

/**
 * How fast the pattern travels, in the two units that mean something.
 *
 * `flow` is a rate through the NOISE FIELD, applied after the division by
 * `scale` (`bp = vBioPos / uBioScale`, then `noise(bp + drift)`). Features in
 * that field are about one unit across, so:
 *
 *   featureSeconds  how long until a given blotch is replaced by its
 *                   neighbour. This is what "the pattern is alive" means.
 *   bodySeconds     how long a feature takes to travel the length of the
 *                   animal. This is what "panning" means, and it is the one
 *                   that surprises people: it scales with `scale`, so a
 *                   fine-grained pattern crawls across the body far slower
 *                   than its own churn suggests.
 */
export function patternPan(cfg = {}) {
  const flow = cfg.flow ?? 0;
  const pans = !PATTERNS_WITHOUT_DRIFT.includes(cfg.pattern);
  if (!pans || flow <= 0) {
    return { pans, featureSeconds: Infinity, bodySeconds: Infinity };
  }
  const freq = FREQUENCY_MULTIPLE[cfg.pattern] ?? 1;
  // Body units per second: one field unit is `scale / freq` of the body, and
  // the body is normalised to 1 along its longest side (see aBioPos).
  const bodyPerSecond = flow * ((cfg.scale ?? 0.25) / freq);
  return {
    pans,
    featureSeconds: 1 / flow,
    bodySeconds: bodyPerSecond > 0 ? 1 / bodyPerSecond : Infinity,
  };
}

/** The first resolved glow config on an object tree, or null. */
export function resolvedGlow(root) {
  let found = null;
  root?.traverse?.((o) => {
    if (found || !o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m?.userData?.__bioSkinResolved) { found = m.userData.__bioSkinResolved; break; }
    }
  });
  return found;
}

/**
 * A console-shaped readout of everything driving one creature's glow, read
 * back off the material rather than re-derived from config — after base,
 * preset and variant have layered, the material's copy is the only one that is
 * definitely what the shader sees.
 */
export function describeGlow(root) {
  const cfg = resolvedGlow(root);
  if (!cfg) return '    (no glow material on this one)';
  const { lo, hi, clipped } = glowHeadroom(cfg);
  const pan = patternPan(cfg);
  const contrast = glowContrast(cfg);
  const rate = (sync, free, unit) => (sync && sync !== 'free' ? sync : `${free ?? 0}${unit} free`);
  const secs = (s) => (Number.isFinite(s) ? `${s.toFixed(1)}s` : 'never');
  return `    pattern ${cfg.pattern} at scale ${cfg.scale ?? 0.25}\n`
    + `    pan     ${pan.pans ? `drift ${cfg.flow ?? 0}/s — a feature turns over every ${secs(pan.featureSeconds)}, crosses the body in ${secs(pan.bodySeconds)}`
      : `this pattern does not drift; it travels on the breath clock instead`}\n`
    + `    breath  amp ${cfg.pulseAmp ?? 0} @ ${rate(cfg.pulseSync, cfg.pulseSpeed, ' rad/s')}`
    + `, spread ${cfg.phaseSpread ?? 1} over ${cfg.phaseSteps ?? 0} slots\n`
    + `    flicker amp ${cfg.flickerAmp ?? 0} @ ${rate(cfg.flickerSync, cfg.flickerRate, '/s')}\n`
    + `    core swings ${lo.toFixed(2)}..${hi.toFixed(2)}, composite clips at 1.00`
    + (clipped
      ? ' — BOTH ENDS WHITE, the breath cannot show in the core.'
      : ' — crosses the clip, visible')
    + `\n    pattern detail: the bottom ${(contrast * 100).toFixed(0)}% of the mask is below the clip`
    + (contrast < 0.5
      ? ` — the other ${(100 - contrast * 100).toFixed(0)}% is one flat white shape, so what pans is its edge, not a texture. Lower strength or glow.`
      : ' — the shape reads, so the pan reads with it');
}
