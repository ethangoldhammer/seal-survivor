#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:comb
//
// THE LEVEL-UP SCREEN AS A HONEYCOMB — ui/upgradeComb.js.
//
// The claim this whole file rests on is that the three cards are CELLS of the
// lattice rather than three hexagons lying on top of a pattern. That is exactly
// the kind of claim a screenshot cannot settle: a few pixels out looks like
// nothing, and looks like sloppy drawing rather than like arithmetic.
//
// SEVEN THINGS THAT RENDER PLAUSIBLY AND ARE WRONG:
//
//   A LATTICE OF SQUARES     a cell is a square box with a hexagon clipped
//                            inside it, and that hexagon is neither centred in
//                            the box nor the size of it. Step the tiling by the
//                            BOX and the comb is loose in x and overlapping in
//                            y by a few per cent — every cell individually
//                            fine, the field subtly wrong.
//
//   A ROW THAT IS NOT LEVEL  adjacent columns of a flat-top lattice are half a
//                            hexagon apart in y. Put three cards in adjacent
//                            columns and the middle one is raised above its
//                            neighbours — which is not three equal options.
//
//   CELLS UNDER THE CARDS    the tiling has to leave the cards' own cells
//                            empty. A cell built underneath a card is invisible
//                            until the card is transparent for a frame, and
//                            then it is a hexagon inside a hexagon.
//
//   AN ORIGIN OF ITS OWN     the lattice is stepped off a MEASURED card. Derive
//                            it from the viewport instead and it agrees on a
//                            desktop and drifts on every screen whose card size
//                            the stylesheet clamps.
//
//   A FLASH THAT STICKS      the flash keyframe ends on the resting fill, and
//                            the delay is a custom property. Hold the first
//                            keyframe through the delay instead and every cell
//                            sits tinted until its turn, so the "ripple" is a
//                            fully lit screen with a wave of rest crossing it.
//
//   AN ANIMATION THAT WON'T  re-adding a class does not restart a CSS
//   RESTART                  animation. Two landings in a row on one cell have
//                            to alternate between two class names or the second
//                            ripple does not happen at all.
//
//   A COMB LEFT BEHIND       the menu is rebuilt on every level-up and two land
//                            in one wave often enough. A comb nobody cleared is
//                            a hundred divs per level for the rest of the run.
//
// Geometry only needs the module; the DOM half runs under jsdom, WITHOUT
// --import, following the loader recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');
globalThis.fetch = async () => ({ ok: false, status: 404 });
console.warn = () => {};

const { CONFIG } = await import('../path/src/config.js');
const comb = await import('../path/src/ui/upgradeComb.js');
const { HEX_GEOMETRY: ART } = await import('../path/src/ui/upgradeHive.js');

const BOX = 210;
const hexW = BOX * ART.w;
const hexH = BOX * ART.h;

// ---------------------------------------------------------------------------
section('Where the cards sit');

{
  const row = comb.cardCells(3, BOX, false);
  const ys = row.spots.map((p) => p.y);
  check('three cards sit at the same height', new Set(ys.map((y) => y.toFixed(4))).size === 1,
    ys.map((y) => y.toFixed(1)).join(', '));

  // ...and they are on the lattice, not merely evenly spaced: the gap between
  // one card's column and the next has to be a whole number of column steps.
  const stepX = hexW * 0.75 + CONFIG.upgradeComb.gap;
  const gaps = row.spots.slice(1).map((p, i) => (p.x - row.spots[i].x) / stepX);
  check('each card is a whole number of columns from the last',
    gaps.every((g) => Math.abs(g - Math.round(g)) < 1e-9), gaps.map((g) => g.toFixed(3)).join(', '));
  check('...and that number is the configured spread',
    gaps.every((g) => Math.round(g) === CONFIG.upgradeComb.spread), `${CONFIG.upgradeComb.spread}`);
  check('the cards know which cells they are in',
    row.spots.every((p) => Number.isInteger(p.col) && Number.isInteger(p.row)),
    row.spots.map((p) => `${p.col},${p.row}`).join(' '));

  // AT SPREAD 1 THE ROW IS NOT LEVEL, and that is the thing spread 2 exists to
  // avoid. Asserted rather than assumed: if adjacent columns ever stopped being
  // half a hexagon apart, spread 2 would be solving a problem that no longer
  // exists and nothing would say so.
  const tight = comb.cardCells(3, BOX, false, { ...cfgOf(), spread: 1 });
  check('adjacent columns really do stagger', new Set(tight.spots.map((p) => p.y.toFixed(4))).size > 1,
    tight.spots.map((p) => p.y.toFixed(1)).join(', '));

  const col = comb.cardCells(3, BOX, true);
  check('stacked is one column', new Set(col.spots.map((p) => p.x)).size === 1);
  const stepY = hexH + CONFIG.upgradeComb.gap;
  const drops = col.spots.slice(1).map((p, i) => p.y - col.spots[i].y);
  check('...one full hexagon apart', drops.every((d) => Math.abs(d - stepY) < 1e-9),
    drops.map((d) => d.toFixed(1)).join(', '));
  check('stacked is narrower than the row', col.width < row.width,
    `${col.width.toFixed(0)}px vs ${row.width.toFixed(0)}px`);
}

function cfgOf() {
  const c = CONFIG.upgradeComb;
  return { ...c, neon: c.neon };
}

// ---------------------------------------------------------------------------
section('Fitting the hand to the window');

{
  const CH = 90; // the headline and its line under it
  const row = comb.cardCells(3, BOX, false);

  // A desktop: the row fits at full size and nothing shrinks.
  const desk = comb.fitCards(3, BOX, 1920, 1080, CH);
  check('a wide window keeps the full-size row', !desk.stacked && desk.box === BOX,
    `${desk.box}px ${desk.stacked ? 'stacked' : 'row'}`);

  // A tall phone: too narrow for the row, deep enough for the column.
  const phone = comb.fitCards(3, BOX, 375, 812, CH);
  check('a tall narrow window stacks', phone.stacked, `${phone.box}px`);
  check('...and the stack actually fits it',
    comb.cardCells(3, phone.box, true).height <= 812 - CH + 1,
    `${comb.cardCells(3, phone.box, true).height.toFixed(0)}px of ${812 - CH}px`);

  // THE WINDOW THAT FITS NEITHER — too narrow for a row of three cells and too
  // short for a column of them. The flex row this replaced used to wrap here; a
  // lattice cannot, so the cards have to get smaller instead. Left unsolved,
  // the third card runs off the bottom of the screen and the player is offered
  // a choice they cannot see.
  const awkward = comb.fitCards(3, BOX, 713, 458, CH);
  check('an awkward window shrinks the cards', awkward.box < BOX, `${awkward.box}px`);
  const got = comb.cardCells(3, awkward.box, awkward.stacked);
  check('...until the hand genuinely fits', got.width <= 713 * 0.94 + 1 && got.height <= 458 - CH + 1,
    `${got.width.toFixed(0)}x${got.height.toFixed(0)} in ${Math.round(713 * 0.94)}x${458 - CH}`);
  check('...and never smaller than it has to be',
    comb.cardCells(3, awkward.box + 6, awkward.stacked).width > 713 * 0.94
      || comb.cardCells(3, awkward.box + 6, awkward.stacked).height > 458 - CH,
    `${awkward.box}px is the largest that fits`);

  // A landscape phone: short, so whatever it picks has to clear the height.
  const flat = comb.fitCards(3, BOX, 852, 393, CH);
  const flatGot = comb.cardCells(3, flat.box, flat.stacked);
  check('a short wide window fits too',
    flatGot.width <= 852 * 0.94 + 1 && flatGot.height <= 393 - CH + 1,
    `${flat.box}px ${flat.stacked ? 'stacked' : 'row'} — ${flatGot.width.toFixed(0)}x${flatGot.height.toFixed(0)}`);

  check('it never grows past what the stylesheet asked for',
    comb.fitCards(3, BOX, 5120, 2880, CH).box === BOX);
  // Unused, but it keeps the row's own numbers honest above.
  check('a full-size row is wider than a full-size stack', row.width > row.height);
}

// ---------------------------------------------------------------------------
section('The tiling');

const mount = document.createElement('div');
document.body.appendChild(mount);
// jsdom has no layout, so the viewport is whatever it says it is — which is
// fine here, because buildComb is handed the anchor rather than measuring one.
const VW = dom.window.innerWidth;
const VH = dom.window.innerHeight;

{
  const laid = comb.cardCells(3, BOX, false);
  const anchor = { box: BOX, left: 120, top: 200, col: laid.spots[0].col, row: laid.spots[0].row };
  const n = comb.buildComb(mount, anchor, laid.spots);
  check('cells were built', n > 0, `${n} cells`);
  check('...and they are in the mount', mount.childElementCount === n);

  const cells = [...mount.children].map((el) => ({
    left: parseFloat(el.style.left), top: parseFloat(el.style.top),
    w: parseFloat(el.style.width),
  }));
  check('every cell is a card-sized box', cells.every((c) => c.w === BOX));

  // THE HEXAGON CENTRES, not the box corners. Anything that steps by the box is
  // wrong here by a few per cent, in both axes, and looks almost right.
  const cx = (c) => c.left + BOX * ART.cx;
  const cy = (c) => c.top + BOX * ART.cy;
  const stepX = hexW * 0.75 + CONFIG.upgradeComb.gap;
  const stepY = hexH + CONFIG.upgradeComb.gap;

  // Every centre must land on the lattice the anchor defines.
  const ax = anchor.left + BOX * ART.cx - anchor.col * stepX;
  const ay = anchor.top + BOX * ART.cy - anchor.row * stepY - (anchor.col % 2 ? stepY / 2 : 0);
  let offLattice = 0;
  for (const c of cells) {
    const q = (cx(c) - ax) / stepX;
    if (Math.abs(q - Math.round(q)) > 1e-6) { offLattice++; continue; }
    const r = (cy(c) - ay - (Math.round(q) % 2 ? stepY / 2 : 0)) / stepY;
    if (Math.abs(r - Math.round(r)) > 1e-6) offLattice++;
  }
  check('every cell is on the cards’ own lattice', offLattice === 0, `${offLattice} adrift`);

  // The cards' cells are HOLES. Measured as "no cell shares a card's centre",
  // which is the thing that would actually be visible.
  const cardCx = anchor.left + BOX * ART.cx;
  const cardCy = anchor.top + BOX * ART.cy;
  const under = cells.filter((c) => Math.abs(cx(c) - cardCx) < 1 && Math.abs(cy(c) - cardCy) < 1);
  check('no cell is built under a card', under.length === 0, `${under.length} underneath`);

  // It has to actually cover the screen, or the comb is a patch in the middle.
  const minX = Math.min(...cells.map(cx)), maxX = Math.max(...cells.map(cx));
  const minY = Math.min(...cells.map(cy)), maxY = Math.max(...cells.map(cy));
  check('the comb reaches past every edge',
    minX <= 0 && maxX >= VW && minY <= 0 && maxY >= VH,
    `x ${minX.toFixed(0)}..${maxX.toFixed(0)} of ${VW}, y ${minY.toFixed(0)}..${maxY.toFixed(0)} of ${VH}`);

  check('the scrim colour reached the layer',
    /rgba\(9, ?14, ?22/.test(mount.style.getPropertyValue('--sv-comb-rest')),
    mount.style.getPropertyValue('--sv-comb-rest'));
}

// ---------------------------------------------------------------------------
section('The waves');

{
  const cells = [...mount.children];
  const from = { x: 200, y: 300 };
  const seconds = comb.rippleComb(from, '#ff5ec4');
  check('the ripple reports how long it runs for', seconds > CONFIG.upgradeComb.flashTime,
    `${seconds.toFixed(2)}s`);
  check('every cell got a delay', cells.every((c) => c.style.getPropertyValue('--sv-comb-at')));
  // The LIFTED tint, not the raw tier colour — see flashTint. Asserted against
  // the function rather than against a literal, so the two cannot disagree
  // about what bright enough means.
  const want = comb.flashTint('#ff5ec4');
  check('every cell got the tint, lifted to flash brightness',
    cells.every((c) => c.style.getPropertyValue('--sv-comb-tint') === want), want);
  // ...and the FLASH is the other way round: holding its first keyframe would
  // light the whole comb at once and send a wave of REST across it.
  check('a flash does not hold its tint through the delay',
    cells.every((c) => c.style.animationFillMode === 'forwards'),
    cells[0].style.animationFillMode);
  check('the flash is the animation running',
    cells.every((c) => /^sv-comb-flash(-2)?$/.test(c.style.animationName)),
    cells[0].style.animationName);

  // A RING, not a wash: the delay has to grow with distance from the origin.
  const cx = (c) => parseFloat(c.style.left) + BOX * ART.cx;
  const cy = (c) => parseFloat(c.style.top) + BOX * ART.cy;
  const at = (c) => parseFloat(c.style.getPropertyValue('--sv-comb-at'));
  const near = cells.reduce((a, b) => (Math.hypot(cx(a) - from.x, cy(a) - from.y) < Math.hypot(cx(b) - from.x, cy(b) - from.y) ? a : b));
  const far = cells.reduce((a, b) => (Math.hypot(cx(a) - from.x, cy(a) - from.y) > Math.hypot(cx(b) - from.x, cy(b) - from.y) ? a : b));
  check('near cells fire before far ones', at(near) < at(far), `${at(near)}s vs ${at(far)}s`);

  // --- QUANTISED, NOT SMOOTH ------------------------------------------------
  // The whole character of the pulse. Paced by PIXELS every cell fires at a
  // slightly different moment and the comb fades like an airbrush; paced by
  // RINGS, every hexagon the same number of steps out fires on the same frame
  // and the wave leaves as hard hexagonal shells. It is the difference between
  // a gradient and a chipped look, and a still cannot tell them apart.
  {
    const origin = { x: cx(cells[0]), y: cy(cells[0]), q: 0, r: 0 };
    comb.rippleComb(origin, '#ffcc33');
    const delays = [...new Set(cells.map((c) => at(c).toFixed(4)))].sort();
    const rings = [...new Set(cells.map((c) => comb.hexRings(
      { q: Number(c.dataset ? 0 : 0), r: 0 }, { q: 0, r: 0 },
    )))];
    check('cells share delays rather than each having their own',
      delays.length < cells.length / 2,
      `${delays.length} distinct delays across ${cells.length} cells`);
    // ...and those delays are whole multiples of one step.
    const stepS = CONFIG.upgradeComb.ringStep;
    check('every delay is a whole number of ring steps',
      cells.every((c) => Math.abs(at(c) / stepS - Math.round(at(c) / stepS)) < 1e-6),
      `step ${stepS}s`);
    // The brightness steps too — same reason.
    const hits = [...new Set(cells.map((c) => c.style.getPropertyValue('--sv-comb-hit')))];
    check('brightness steps per ring as well', hits.length > 1 && hits.length < cells.length / 2,
      `${hits.length} distinct levels`);
    check('the ring the card is in is at full brightness',
      hits.includes('1.000'), hits.slice(0, 4).join(' '));
    void rings;
  }

  // THE ORIGIN IS A CELL. A pulse told only where it is on screen has to fall
  // back to the nearest cell rather than producing NaN rings — which is what a
  // missing q/r did, and it renders as the pulse simply never happening.
  {
    comb.rippleComb({ x: cx(cells[3]), y: cy(cells[3]) }, '#ffcc33');
    check('an origin with no lattice cell still pulses',
      cells.every((c) => Number.isFinite(at(c))), `${at(cells[0])}`);
  }


  // THE NAME HAS TO CHANGE, and this is the check that was missing when it
  // shipped broken: alternating a CLASS restarts nothing, because changing an
  // animation's delay or duration updates it in place. Only a new
  // animation-name re-fires it. The first ripple of a hand played, every one
  // after it silently did not, and the screen simply read as the later cards
  // being the undramatic ones.
  const firstName = cells[0].style.animationName;
  comb.rippleComb({ x: 400, y: 300 }, '#b6ff3c');
  const secondName = cells[0].style.animationName;
  check('a second ripple changes the animation name, so it restarts',
    secondName !== firstName, `${firstName} -> ${secondName}`);
  check('...and both names are the same keyframe, twinned',
    [firstName, secondName].sort().join(' ') === 'sv-comb-flash sv-comb-flash-2',
    `${firstName} / ${secondName}`);
  // A third goes back to the first name — which is fine, because by then the
  // second is what is running.
  comb.rippleComb({ x: 200, y: 300 }, '#b6ff3c');
  check('a third ripple changes it again', cells[0].style.animationName !== secondName,
    `${secondName} -> ${cells[0].style.animationName}`);

  // THE LAST CARD IS SLOWER, not faster. It ran at a sixth of a ripple's
  // stagger once, which crossed the comb so fast it read as RUSHED rather than
  // as the biggest thing the screen does — it should ease into the final state,
  // not snap to it.
  const rip = comb.rippleComb(from, '#fff');
  const flood = comb.floodComb(from, '#fff');
  check('the last card takes longer than a ripple', flood > rip,
    `${flood.toFixed(2)}s vs ${rip.toFixed(2)}s`);
  check('...and still leaves from the card that earned it',
    cells.some((c) => at(c) > 0.001), 'all delays zero would be a wash, not a wave');

  // --- THE TWO SPRINGS, SEPARATELY -------------------------------------------
  // A pulse is a colour and a movement. Either can be turned off without
  // touching the other, and both are the same one number the keyframe
  // multiplies — so `off` is 0 rather than a second code path that has to be
  // kept in step with the first.
  const popOn = [...new Set(cells.map((c) => c.style.getPropertyValue('--sv-comb-pop')))];
  check('the pop is one amplitude, the same for every cell', popOn.length === 1,
    popOn.join(' '));
  check('...anchored on each cell rather than aimed away from the card',
    cells.every((c) => !c.style.getPropertyValue('--sv-comb-px')
      && !c.style.getPropertyValue('--sv-comb-py')),
    'a per-cell direction shears the grid as the wave passes');

  const wasScale = CONFIG.upgradeComb.springScale;
  const wasColor = CONFIG.upgradeComb.springColor;
  CONFIG.upgradeComb.springScale = false;
  comb.rippleComb(from, '#fff');
  check('movement off leaves a pulse that is only colour',
    cells.every((c) => c.style.getPropertyValue('--sv-comb-pop') === '0')
      && cells.some((c) => c.style.getPropertyValue('--sv-comb-hit') !== '0'));
  CONFIG.upgradeComb.springScale = true;
  CONFIG.upgradeComb.springColor = false;
  comb.rippleComb(from, '#fff');
  check('colour off leaves a pulse that is only movement',
    cells.every((c) => c.style.getPropertyValue('--sv-comb-hit') === '0')
      && cells.every((c) => c.style.getPropertyValue('--sv-comb-pop') !== '0'));
  CONFIG.upgradeComb.springScale = wasScale;
  CONFIG.upgradeComb.springColor = wasColor;

  // THE COMB HAS NO ENTRANCE OF ITS OWN. Cells are invisible until a pulse
  // reaches them and hold the last frame of it afterwards, so the honeycomb
  // assembles out of the hits the cards make and then stays. That is what the
  // fill mode below buys — with `both` a cell would hold the FIRST frame during
  // its delay, lighting the whole comb at once and sending a wave of rest
  // across it.
  check('every wave holds its last frame, so revealed cells stay',
    cells.every((c) => c.style.animationFillMode === 'forwards'),
    cells[0].style.animationFillMode);

  // --- THE WAY OUT ----------------------------------------------------------
  // Rings from the cell of the card that was taken, thrown off along the axis.
  // Two questions with two answers: WHEN a cell leaves is how many rings it is
  // from the choice, so the comb comes apart outward from what the player just
  // did; WHERE it goes is the sweep's direction, so the lattice still exits
  // through the far edge together. Swept by column instead, the exit is a wipe
  // with no relationship to the pick.
  const pickCell = { q: 0, r: 0, x: cx(cells[0]), y: cy(cells[0]) };
  comb.drainComb(pickCell, '#ffcc33');
  const outDelays = [...new Set(cells.map((c) => at(c).toFixed(4)))];
  check('the exit is quantised into rings too',
    outDelays.length > 1 && outDelays.length < cells.length / 2,
    `${outDelays.length} distinct delays across ${cells.length} cells`);
  check('...on its own stagger, not the entrance\'s',
    cells.every((c) => Math.abs(at(c) / CONFIG.upgradeComb.drainStep
      - Math.round(at(c) / CONFIG.upgradeComb.drainStep)) < 1e-6)
    && CONFIG.upgradeComb.drainStep !== CONFIG.upgradeComb.combStep,
    `exit ${CONFIG.upgradeComb.drainStep}s vs entrance ${CONFIG.upgradeComb.combStep}s`);
  // IT DOES NOT TRAVEL. Cells used to be thrown off screen along an axis as
  // well as shrinking — a ring says "outward from the card you took" and a
  // throw says "that way", and together they say neither.
  check('...shrinking where it stands rather than being thrown',
    !mount.style.getPropertyValue('--sv-comb-oy')
      && !mount.style.getPropertyValue('--sv-comb-ox'),
    'a throw direction competes with the ring');
  check('...carrying the quantised gradient with it',
    [...new Set(cells.map((c) => c.style.getPropertyValue('--sv-comb-hit')))].length > 1,
    'a flat exit has one brightness');
  check('...on its own keyframe',
    cells.every((c) => /^sv-comb-out(-2)?$/.test(c.style.animationName)),
    cells[0].style.animationName);
  // THE EXIT IS THE ONE WAVE THAT IS NOT A REVEAL. Pinning the cells visible
  // here would leave the whole lattice on screen after the comb had left.
  check('...and does not pin the cells visible',
    cells.every((c) => c.style.opacity !== '1'),
    `first cell inline opacity "${cells[0].style.opacity}"`);
}

// ---------------------------------------------------------------------------
section('Pointing at a card');

{
  const mount2 = document.querySelector('div');
  const cells = [...document.querySelectorAll('.sv-comb-cell')];
  const at = (c) => parseFloat(c.style.getPropertyValue('--sv-comb-at'));
  const from = { q: 0, r: 0, x: 0, y: 0 };

  const fired = comb.hoverComb('a', from, '#ffcc33');
  check('a hover pulses the comb', fired === true);
  // COLOUR ONLY. Its keyframe has no transform in it at all — one that
  // mentioned transform would own it for the whole animation, so even a scale
  // of 1 snaps the lattice back from wherever the last wave left it, on every
  // mouse move.
  check('...on the colour-only keyframe, so the grid does not move',
    cells.every((c) => /^sv-comb-tint(-2)?$/.test(c.style.animationName)),
    cells[0].style.animationName);
  // ...AND IT MUST NOT UN-REVEAL THE GRID. A cell is revealed by holding the
  // last frame of the wave that reached it; starting a new animation on that
  // cell RELEASES whatever the old one's fill was holding, so a keyframe that
  // does not mention opacity hands the cell back its resting style — which is
  // invisible. Leaving it out cleared the entire comb on the first mouse move.
  //
  // Asserted against the SOURCE, not the document. jsdom runs no animations, so
  // a computed opacity proves nothing — and this file never calls initUI, so
  // the stylesheet those rules live in is not in the document at all. Reading
  // ui.js is the only place the claim can actually be checked.
  const uiSrc = await (await import('node:fs/promises')).readFile('path/src/ui/ui.js', 'utf8');
  const tintFrames = /@keyframes sv-comb-tint \{([\s\S]*?)\n  \}/.exec(uiSrc)?.[1] ?? '';
  // ...AND THE REVEAL IS AN INLINE WRITE, so it survives everything the fill
  // does not: a keyframe that omits opacity, a rebuild, a superseded
  // animation, a document the browser considers hidden and never advances.
  check('a hover leaves the cells revealed on their own style',
    cells.every((c) => c.style.opacity === '1'),
    `first cell inline opacity "${cells[0].style.opacity}"`);
  check('...and pins opacity, so hovering does not clear the grid',
    (tintFrames.match(/opacity:\s*1/g) ?? []).length >= 2,
    tintFrames.trim().slice(0, 60));
  // ON ITS OWN STEP, quantised into rings like every other wave. NOT asserted
  // to be faster or steeper than a landing: those are taste, they live in the
  // tuner, and a test that pins them fails the day somebody tunes them — which
  // is what happened the first time this was written. What has to hold is that
  // the hover reads its OWN numbers and steps in whole rings.
  check('...on its own step, in whole rings',
    cells.every((c) => Math.abs(at(c) / CONFIG.upgradeComb.hoverStep
      - Math.round(at(c) / CONFIG.upgradeComb.hoverStep)) < 1e-6),
    `${CONFIG.upgradeComb.hoverStep}s per ring`);
  const dim = [...new Set(cells.map((c) => c.style.getPropertyValue('--sv-comb-hit')))];
  check('...with brightness stepping per ring too', dim.length > 1,
    `${dim.length} levels`);

  // THROTTLED PER CARD. A pointer crossing a hexagon's corner enters and leaves
  // several times in a few frames, and each one is a full pass over every cell.
  check('a second hover on the same card is refused',
    comb.hoverComb('a', from, '#ffcc33') === false);
  check('...but another card still answers',
    comb.hoverComb('b', from, '#ffcc33') === true);

  const was = CONFIG.upgradeComb.hoverEnabled;
  CONFIG.upgradeComb.hoverEnabled = false;
  check('and it can be switched off', comb.hoverComb('c', from, '#ffcc33') === false);
  CONFIG.upgradeComb.hoverEnabled = was;
  void mount2;
}

// ---------------------------------------------------------------------------
section('A flash bright enough to be one');

{
  // The floor tier's colour is a near-grey, chosen to sit still on a card for
  // as long as the menu is up. Thrown across a dark comb for a fifth of a
  // second it does not read at all — which would make the commonest landing in
  // the game the one with no payoff.
  const lift = CONFIG.upgradeComb.flashLift;
  const lightness = (s) => Number(/\s([\d.]+)%\)$/.exec(s)?.[1]);
  const hue = (s) => Number(/^hsl\((\d+)/.exec(s)?.[1]);
  const sat = (s) => Number(/\s([\d.]+)%\s/.exec(s)?.[1]);

  const grey = comb.flashTint('#b8c2cc');
  check('a near-grey tier still flashes', lightness(grey) >= lift * 100 - 0.5, grey);
  check('...without inventing a colour it does not have', sat(grey) < 25, grey);

  const gold = comb.flashTint('#ffcc33');
  check('a gold tier keeps its hue', Math.abs(hue(gold) - 45) < 6, gold);
  check('...and is not dulled to reach the floor', lightness(gold) >= 60, gold);

  const dark = comb.flashTint('#0d2b1a');
  check('a dark tier is lifted, not left invisible', lightness(dark) >= lift * 100 - 0.5, dark);
  check('...keeping its own hue', Math.abs(hue(dark) - 145) < 20, dark);

  check('something that is not a colour passes through untouched',
    comb.flashTint(null) === null && comb.flashTint('nonsense') === 'nonsense');
}

// ---------------------------------------------------------------------------
section('The skip is a decision, not a glance');

{
  // The D-pad is a button like any other to the Gamepad API, so "any button
  // down" counts nudging a direction. Looking along the hand is not asking to
  // cut its arrival short, and a player stepping through the cards would skip
  // the animation on their first step every single time.
  const { menuInput } = await import('../path/src/input.js');
  check('the pad exposes a press with directions excluded',
    'actionPress' in menuInput,
    'anyPress alone counts a dpad nudge');
}

// ---------------------------------------------------------------------------
section('Clearing up');

{
  check('there is a comb to clear', comb.combSize() > 0);
  comb.clearComb();
  check('every cell is gone', comb.combSize() === 0 && mount.childElementCount === 0,
    `${mount.childElementCount} left in the DOM`);

  // A second build does not stack on the first — this is the two-level-ups-in-
  // one-wave case, which is where a comb gets left behind.
  const laid = comb.cardCells(3, BOX, false);
  const anchor = { box: BOX, left: 120, top: 200, col: laid.spots[0].col, row: laid.spots[0].row };
  const a = comb.buildComb(mount, anchor, laid.spots);
  const b = comb.buildComb(mount, anchor, laid.spots);
  check('rebuilding replaces rather than adds', a === b && mount.childElementCount === b,
    `${a} then ${b}, ${mount.childElementCount} in the DOM`);
  comb.clearComb();
}

// ---------------------------------------------------------------------------
section('The cues');

{
  // Every moment this screen spends has to be a declared feedback event, or it
  // is a raw playSfx that the event audit cannot see and the tuner cannot
  // reach. Checked against CONFIG rather than against a list in here.
  for (const name of ['combIgnite', 'cardLand', 'combFlood', 'combDrain']) {
    check(`${name} is a feedback event`, Boolean(CONFIG.feedback[name]));
  }
  for (const name of ['combIgnite', 'combFlood', 'combDrain']) {
    const voice = CONFIG.sfx[name];
    check(`${name} has a voice`, Boolean(voice));
    // Synth or sample, but it has to be ONE of them: an entry that is neither
    // is a red row in the debug tap and silence in the game.
    check(`...that can actually sound`,
      Boolean(voice?.srcs?.length || voice?.src || voice?.type === 'blip' || voice?.type === 'noise' || voice?.type === 'boom'),
      voice?.type ?? 'no type');
  }
  // The one that deliberately has no voice of its own.
  check('cardLand stays silent, riding the pop and the sting',
    CONFIG.feedback.cardLand.sfx === null);
  // And none of the four throws particles at the world origin.
  check('none of them emit into the world',
    ['combIgnite', 'cardLand', 'combFlood', 'combDrain'].every((n) => !CONFIG.feedback[n].emit));
}

// ---------------------------------------------------------------------------
section('The dither is gone');

{
  const r = CONFIG.reveals ?? {};
  check('reveals.upgrades no longer exists', r.upgrades === undefined);
  // ...and the other three still do. Killing the shared vocabulary for every
  // surface was a different decision from killing it for this one.
  check('the splash still dissolves', Boolean(r.splash));
  check('the score card still dissolves', Boolean(r.scoreCard));
  check('the pause menu still dissolves', Boolean(r.pause));
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
