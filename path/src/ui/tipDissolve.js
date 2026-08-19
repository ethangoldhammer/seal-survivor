import { noiseMaskSet } from './dither.js';

// ---------------------------------------------------------------------------
// HOW A TIP LEAVES: eaten by moving water.
//
// A coach tip now lives NEXT TO the thing it is about (see ui/callout.js), and
// it stays there until that thing is gone — the bubble is popped, the pile is
// cleared, the button has been pressed. So its exit is not a fade any more: it
// is the moment the player's own action removed the subject, and it should read
// as the ocean taking the sentence away rather than as a UI element being
// switched off.
//
// FOUR ALGORITHMS, ONE PER READ, and they are all here rather than one being
// chosen in code because they are a LOOK decision — CONFIG.tutorial.dissipate
// .style picks, and `npm run looks:tip` renders all four side by side at the
// same progress so the choice is made by looking. The set:
//
//   boil     the house dither field, thresholded binary and BOILING — the same
//            organic field the menus reveal through (ui/dither.js). Grainy,
//            reads as the letters breaking into flakes. The only one that
//            costs nothing per frame: the tiles are baked once.
//   warp     turbulence displacement plus a noise cut, both panning upward. The
//            glyphs smear and thin as if seen through water that is moving.
//            The most literally liquid of the four.
//   current  warp, plus a soft gradient wash climbing the line, plus a drift in
//            the same direction. DIRECTIONAL: the water is carrying the words
//            off, bottom edge first. Reads as an event with a cause.
//   ink      no cut at all — the line diffuses. Blur and displacement grow
//            together while the alpha is stretched thin, so it spreads and
//            disperses like ink rather than eroding. The gentlest, and the only
//            one that never shows a hard edge.
//
// TWO NODES, AND THIS FILE OWNS THE INNER ONE. ui/callout.js positions the
// outer box (transform, top/left, the popup curve); everything here writes the
// INNER one — filter, mask, opacity, its own drift transform. That split is not
// tidiness: the callout layer already has one writer per property on purpose
// (see applyBloom's note about text-shadow), and a dissolve sharing `transform`
// or `filter` with the arrival curve is the bug where one of the two silently
// never wins.
//
// t IS PROGRESS, NOT TIME. 0 is the line whole, 1 is nothing left. At exactly 0
// every style clears itself back to plain DOM — a tip sits there unchanged for
// seconds at a time while its subject is alive, and paying for a filter and a
// mask on all of those frames to composite an identity would be the whole cost
// of the feature spent on the part that does not move.
//
// Dependency-free apart from the mask tiles, like ui/dither.js and for the same
// reason: `npm run looks:tip` loads it with no CONFIG and no game under it.
// ---------------------------------------------------------------------------

/** The four, in the order the look page shows them. */
export const TIP_DISSOLVES = ['boil', 'warp', 'current', 'ink'];

// Everything a style may be given. A plain object rather than reaching for
// CONFIG so the look page can drive the same code with sliders of its own —
// the game passes CONFIG.tutorial.dissipate straight in.
export const TIP_DISSOLVE_DEFAULTS = {
  // boil — the baked field. `cell` is the tile's size on screen in multiples of
  // the line's own height, so the grain stays square and scales with the type
  // rather than with how long the sentence happens to be.
  cell: 3,
  boilHz: 11,
  // warp/current/ink — how hard the water pushes, in pixels at full progress.
  warp: 14,
  // How fast the noise field pans, in pixels per second. This is the "moving"
  // in moving liquid noise: without it the erosion is a static stencil being
  // faded, which reads as a dirty texture rather than as water.
  flow: 26,
  // current — how far the line drifts as it goes, in pixels, and which way.
  drift: 18,
  // ink — how far the diffusion spreads, in pixels of blur at full progress.
  spread: 5,
};

// ---------------------------------------------------------------------------
// The SVG filters. One set for the document, built on first use.
//
// A LIVE FILTER, NOT AN ANIMATED ONE: the attributes are written from the frame
// loop while a tip is dissipating, which is a handful of setAttribute calls on
// at most one element for under a second, once per pickup type, on a first run.
// SMIL (<animate>) would be fewer calls and cannot express this — the progress
// is driven by the player collecting something, not by a clock that started
// when the tip appeared.
// ---------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
let defs = null;
const nodes = {};

function el(name, attrs) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Put the filter definitions in the document, once.
 *
 * The host <svg> is 0×0 and absolutely positioned rather than `display: none`:
 * a display-none subtree is allowed not to be rendered at all, and Safari has
 * historically taken that literally enough to leave the filters unresolvable —
 * which shows up as every dissipating tip vanishing instantly instead of
 * dissolving, on one browser, with nothing in the console.
 */
export function initTipDissolve(root = document.body) {
  if (defs) return;
  const svg = el('svg', { width: 0, height: 0, 'aria-hidden': 'true' });
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  defs = el('defs', {});
  svg.appendChild(defs);

  // WARP. The one field does both jobs — it displaces the glyphs and it cuts
  // them — so the smear and the holes are the same body of water rather than
  // two unrelated noises that happen to be on screen together.
  //
  // The filter region is generous in every direction (see the -100%/300% box):
  // displacement pushes pixels outside the element's own rect, and a tight
  // region clips them into a straight edge — the one shape that instantly
  // reads as "a rectangle with an effect in it" instead of as water.
  buildFlowFilter('sv-tip-warp', { cut: true });
  // CURRENT is the same filter under a different id. It needs its own because
  // the two styles pan and displace by different amounts, and one shared filter
  // would mean the look page's two cells fighting over the same attributes.
  buildFlowFilter('sv-tip-current', { cut: true });
  // INK does not cut. The alpha is stretched instead of thresholded, so the
  // line thins everywhere at once and never grows a hole with an edge on it.
  buildFlowFilter('sv-tip-ink', { cut: false, blur: true });

  root.appendChild(svg);
}

function buildFlowFilter(id, { cut, blur = false }) {
  const filter = el('filter', {
    id,
    x: '-60%', y: '-100%', width: '220%', height: '300%',
    // sRGB, not the linearRGB default. The default is correct colour science
    // and wrong here twice over: a threshold placed in linear space moves
    // visually as the text colour changes, and the tip is drawn over a scene
    // that is already tone-mapped, so matching what the eye reads beats
    // matching what the spec prefers.
    'color-interpolation-filters': 'sRGB',
  });

  // fractalNoise, not `turbulence`: turbulence is the absolute value of the
  // same field, which folds it at zero and puts a crease through every blob.
  // Fractal noise has the smooth, signed, cloud-like shape water has.
  const turb = el('feTurbulence', {
    type: 'fractalNoise', baseFrequency: '0.02 0.035', numOctaves: 2, seed: 3, result: 'n0',
  });
  // THE PAN. feTurbulence cannot be moved — it is defined in the filter's own
  // space — so the whole field is generated once and OFFSET, which is what
  // makes it flow rather than boil in place. The region above is padded far
  // enough that the empty band the offset drags in never reaches the type.
  const offset = el('feOffset', { in: 'n0', dx: 0, dy: 0, result: 'flow' });
  const disp = el('feDisplacementMap', {
    in: 'SourceGraphic', in2: 'flow', scale: 0,
    xChannelSelector: 'R', yChannelSelector: 'G', result: 'warped',
  });
  filter.append(turb, offset, disp);

  let head = 'warped';
  if (blur) {
    const gauss = el('feGaussianBlur', { in: head, stdDeviation: 0, result: 'soft' });
    filter.appendChild(gauss);
    nodes[`${id}:blur`] = gauss;
    head = 'soft';
  }

  if (cut) {
    // The field's blue channel becomes an alpha stencil — a channel the
    // displacement above is not using, so the holes are not correlated with
    // the smear and the two do not cancel into a wobble.
    const toAlpha = el('feColorMatrix', {
      in: 'flow', type: 'matrix', result: 'stencil',
      values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0',
    });
    // Slope and intercept together are the threshold AND its softness: a big
    // slope is a hard flake edge, a small one is a feathered one. Both are
    // written per frame from progress.
    const ramp = el('feComponentTransfer', { in: 'stencil', result: 'cut' });
    const func = el('feFuncA', { type: 'linear', slope: 1, intercept: 1 });
    ramp.appendChild(func);
    const comp = el('feComposite', { in: head, in2: 'cut', operator: 'in' });
    filter.append(toAlpha, ramp, comp);
    nodes[`${id}:cut`] = func;
  } else {
    // No stencil: the alpha of the blurred line itself is stretched, which is
    // what makes ink spread instead of erode.
    const ramp = el('feComponentTransfer', { in: head });
    const func = el('feFuncA', { type: 'linear', slope: 1, intercept: 0 });
    ramp.appendChild(func);
    filter.appendChild(ramp);
    nodes[`${id}:cut`] = func;
  }

  nodes[`${id}:offset`] = offset;
  nodes[`${id}:disp`] = disp;
  nodes[`${id}:turb`] = turb;
  defs.appendChild(filter);
  return filter;
}

// ---------------------------------------------------------------------------
// The boil field
// ---------------------------------------------------------------------------

// Its own field rather than one of CONFIG.reveals': those are tuned for a
// full-screen menu and a tip is thirty pixels tall, so the same tile stretched
// over it would be two blobs and a gap. Small, few levels, few phases — this
// is a sub-second effect on a small box and nothing here needs the resolution
// a card does.
const BOIL_FIELD = {
  size: 64, levels: 12, phases: 6, scale: 4, octaves: 2, algo: 'billow', softness: 0.18,
};

let boil = null;
let boilFailed = false;

/**
 * Bake the boil tiles. Tens of milliseconds — see warmReveals in ui.js — so it
 * is called at idle from initCallouts rather than on the frame the first tip
 * needs it.
 *
 * A failure here is not fatal and is not reported: the same canvas that cannot
 * give up pixels is a browser where the whole reveal system already degrades to
 * showing things plainly, and `boil` falls back to a plain alpha ramp below.
 */
export function warmTipDissolve() {
  if (boil || boilFailed) return;
  try {
    boil = noiseMaskSet(BOIL_FIELD);
  } catch {
    boilFailed = true;
  }
}

// ---------------------------------------------------------------------------
// Applying one
// ---------------------------------------------------------------------------

function setMask(style, image, size, position) {
  style.webkitMaskImage = image;
  style.maskImage = image;
  style.webkitMaskSize = size;
  style.maskSize = size;
  style.webkitMaskRepeat = 'repeat';
  style.maskRepeat = 'repeat';
  style.webkitMaskPosition = position;
  style.maskPosition = position;
  style.webkitMaskMode = 'alpha';
  style.maskMode = 'alpha';
}

/**
 * Put `node` `t` of the way through leaving.
 *
 * @param node   the INNER element (see the header) — this function owns its
 *               filter, mask, opacity and transform outright.
 * @param style  one of TIP_DISSOLVES. An unknown name plain-fades, which is the
 *               honest answer for a value typed into the tuner by hand.
 * @param t      0 whole, 1 gone.
 * @param clock  seconds SINCE THIS DISSOLVE STARTED, for the pan.
 *
 *               NOT A FREE-RUNNING CLOCK, and that distinction cost an hour.
 *               The flow is `feOffset` sliding the turbulence result, and that
 *               result only exists inside the filter region — so an offset
 *               bigger than the region's padding drags EMPTY space over the
 *               type, the alpha stencil comes out transparent everywhere, and
 *               `feComposite operator="in"` renders precisely nothing. A tip
 *               drawn with a clock that had been running since the page loaded
 *               was invisible the moment it started to leave, while every
 *               number on the element — opacity 1, a live filter, a sensible
 *               mask — said it was fine.
 *
 *               A dissolve lasts under a second, so its own elapsed time keeps
 *               the pan to a few pixels and is the only clock it needs. See
 *               also the clamp in panFor: no tuning of `flow` and `seconds`
 *               together can push it past the region either.
 */
export function applyTipDissolve(node, style, t, clock = 0, opts = {}) {
  if (!node) return;
  const o = { ...TIP_DISSOLVE_DEFAULTS, ...opts };
  // WHOLE IS FREE. Not an optimisation so much as the definition: a tip that is
  // not leaving should be ordinary text, with no compositing layer, no filter
  // and nothing for a screenshot or a font-smoothing pass to render differently
  // from every other line in the game.
  if (!(t > 0)) {
    clearTipDissolve(node);
    return;
  }
  const p = Math.min(1, t);

  if (style === 'boil') return applyBoil(node, p, clock, o);
  if (style === 'warp') return applyFlow(node, 'sv-tip-warp', p, clock, o, {});
  if (style === 'current') return applyFlow(node, 'sv-tip-current', p, clock, o, { wash: true });
  if (style === 'ink') return applyInk(node, p, clock, o);

  // Unknown style: a plain fade, and no mask or filter to leave behind.
  clearTipDissolve(node);
  node.style.opacity = String(1 - p);
}

function applyBoil(node, p, clock, o) {
  if (!boil) warmTipDissolve();
  if (!boil) {
    // No tiles. A fade is the fallback, not an error — see warmTipDissolve.
    node.style.opacity = String(1 - p);
    return;
  }
  const phase = Math.floor(clock * o.boilHz) % BOIL_FIELD.phases;
  // Level counts DOWN: the set opens the darkest fraction first, so a mask
  // level of `levels` is solid and 0 is nothing.
  //
  // Nearly linear, and that is a correction. It was squared, borrowed from the
  // menu reveals where a soft field genuinely does look finished half way — and
  // on type it is wrong, because a binary mask eating a 20px letterform has
  // destroyed the WORD long before it has cleared half the pixels. Squared, the
  // line was unreadable at a third of the way through and blank at two thirds:
  // a dissolve nobody can watch, on the one surface whose whole job is to be
  // read while it is on screen.
  const level = Math.round(BOIL_FIELD.levels * Math.pow(1 - p, 1.15));
  // The tile is sized off the TYPE, not off the box. offsetHeight is the box,
  // and the box is one line tall for a short tip and three for a long one — so
  // the same field came out as fine grit on one sentence and as three blobs on
  // the next. Font size is the thing the flakes have to be small against.
  const fontPx = parseFloat(getComputedStyle(node).fontSize) || 20;
  const cell = Math.max(10, fontPx * o.cell);
  // The field slides while it eats, which is the whole difference between this
  // and a dither pattern being faded out.
  const dx = -clock * o.flow * 0.6;
  const dy = -clock * o.flow;
  node.style.filter = '';
  node.style.opacity = '1';
  node.style.transform = '';
  setMask(node.style, boil.masks[phase][level], `${cell}px ${cell}px`, `${dx}px ${dy}px`);
}

// How far the field may be slid, given the box it is being slid over.
//
// The filter region is padded by a fraction of the ELEMENT (see buildFlowFilter:
// 100% of its height above and below, 60% of its width each side), so the pan
// has to be measured against that element and not against a constant. The clamp
// is generous — at the shipped numbers it never engages — and exists so that a
// `flow` slider wound to the top cannot blank the tip out. Slowing to a stop at
// the edge is a look; rendering nothing is a bug.
function panFor(node, seconds, o) {
  const h = node.offsetHeight || 24;
  const w = node.offsetWidth || 200;
  const dy = -Math.min(clock01(seconds) * o.flow, h * 0.8);
  const dx = -Math.min(clock01(seconds) * o.flow * 0.35, w * 0.4);
  return { dx, dy };
}

// Guards the one input this module cannot check: a caller handing it a clock
// from somewhere else entirely. Negative or wild values would take the pan the
// wrong way rather than merely too far.
function clock01(seconds) {
  return Math.max(0, seconds);
}

function applyFlow(node, id, p, clock, o, { wash }) {
  initTipDissolve();
  const offset = nodes[`${id}:offset`];
  const disp = nodes[`${id}:disp`];
  const func = nodes[`${id}:cut`];
  if (!offset) {
    node.style.opacity = String(1 - p);
    return;
  }

  // The push grows from nothing, so the first frames of leaving are a ripple
  // rather than a jolt. Squared for the same reason: a linear ramp has already
  // visibly moved the type by the time the alpha has dropped enough to excuse
  // it, and the line reads as sliding.
  disp.setAttribute('scale', String(o.warp * p * p));
  const pan = panFor(node, clock, o);
  offset.setAttribute('dy', String(pan.dy));
  offset.setAttribute('dx', String(pan.dx));

  // THE CUT. The stencil is noise in 0..1; slope stretches it around the
  // threshold and intercept slides the threshold itself. Both move with
  // progress: early on the slope is gentle and the threshold low (a few soft
  // thin patches), and by the end the slope is steep and the threshold past the
  // top of the field (nothing survives).
  // WRITTEN AS A THRESHOLD, then converted, because the obvious form of this is
  // wrong in a way that looks tuned. Slope and intercept picked directly gave a
  // cut that did nothing at all until the last tenth and then took everything:
  // fractalNoise is not spread evenly over 0..1, it clusters hard around 0.5,
  // so an intercept walking linearly across the whole range spends most of its
  // travel outside the range the field actually occupies. Naming the CROSSING
  // POINT and its softness puts the numbers where the pixels are.
  const cutAt = 0.12 + 0.82 * p;      // where the field stops surviving
  const soft = 0.17 - 0.10 * p;       // wide and feathery early, hard flakes late
  const slope = 1 / soft;
  func.setAttribute('slope', String(slope));
  func.setAttribute('intercept', String(-slope * cutAt));

  node.style.filter = `url(#${id})`;
  setMask(node.style, 'none', 'auto', '0 0');
  if (wash) {
    // THE DIRECTION. A gradient climbing the line, so the bottom edge goes
    // first and the last thing left is the top of the letters — which is the
    // shape of something being lifted away by water moving past, rather than of
    // a box being switched off.
    //
    // Rendered as a mask on top of the filter, not folded into it: an feImage
    // gradient inside the filter would be a second thing to keep in step with
    // the element's height, and this composes for free.
    const edge = -45 + p * 125;
    setMask(
      node.style,
      `linear-gradient(to top, rgba(0,0,0,0) ${edge}%, rgba(0,0,0,1) ${edge + 52}%)`,
      '100% 100%', '0 0',
    );
    node.style.webkitMaskRepeat = 'no-repeat';
    node.style.maskRepeat = 'no-repeat';
    node.style.transform = `translateY(${-o.drift * p * p}px)`;
  }
  // A LITTLE alpha, and only at the very end. The CUT is the effect; a global
  // fade over the top of it is what made the first pass read as an ordinary
  // opacity transition with some texture on it. This only reaches below 1 in
  // the last fifth, where it stops the surviving flakes winking out at full
  // brightness with their bloom still at resting size.
  node.style.opacity = String(Math.min(1, 5 * (1 - p)));
}

function applyInk(node, p, clock, o) {
  initTipDissolve();
  const id = 'sv-tip-ink';
  const offset = nodes[`${id}:offset`];
  const disp = nodes[`${id}:disp`];
  const gauss = nodes[`${id}:blur`];
  const func = nodes[`${id}:cut`];
  if (!offset) {
    node.style.opacity = String(1 - p);
    return;
  }
  disp.setAttribute('scale', String(o.warp * 1.4 * p));
  // Ink has no cut, so an over-panned field cannot blank it the way it blanks
  // the other two — but it is clamped through the same helper anyway, because
  // "this one is safe for a different reason" is how the next person reading it
  // ends up removing the clamp from both.
  offset.setAttribute('dy', String(panFor(node, clock * 0.7, o).dy));
  // p^1.3, not p^2. Squared, the blur was still under a pixel at the half way
  // point and the line was simply sitting there sharp — the spread has to be
  // visibly under way while there is still ink to spread.
  gauss.setAttribute('stdDeviation', String(o.spread * Math.pow(p, 1.3)));
  // Alpha stretched, not cut: the slope climbs so what is left of the blurred
  // line keeps some contrast (blur alone goes grey and reads as an
  // out-of-focus screenshot), while the intercept drags the whole thing down.
  //
  // The intercept alone cannot finish the job and that is not a tuning miss: a
  // glyph's core survives several pixels of blur at full alpha, so a stencil
  // that erases the halo leaves the letter shapes crisp and readable at the
  // very end. The tail below is what actually lets go.
  func.setAttribute('slope', String(1 + 3 * p));
  func.setAttribute('intercept', String(-3.2 * p));
  node.style.filter = `url(#${id})`;
  setMask(node.style, 'none', 'auto', '0 0');
  // Spreading, faintly. The scale is small on purpose — ink in water expands a
  // little and disappears a lot, and a big scale-up reads as the text zooming.
  node.style.transform = `scale(${1 + 0.06 * p})`;
  node.style.opacity = String(Math.min(1, 3.2 * (1 - p)));
}

/** Back to ordinary text: no filter, no mask, no compositing layer. */
export function clearTipDissolve(node) {
  if (!node) return;
  const s = node.style;
  s.filter = '';
  s.opacity = '';
  s.transform = '';
  s.webkitMaskImage = '';
  s.maskImage = '';
}
