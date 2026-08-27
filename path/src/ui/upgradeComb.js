// THE COMB — the level-up screen IS a honeycomb, and the choices are three of
// its cells.
//
// What used to be here was a rounded black panel with three hexagons on it,
// dithering in through a noise field. The panel is gone. The screen is now one
// lattice running edge to edge, the cards sit in it rather than on it, and the
// empty cells are the instrument: they light as the hand arrives and they carry
// the payoff when a reel stops.
//
// ONE HEX VOCABULARY. The geometry comes from upgradeHive.js's own constants —
// the same numbers the corner tiles pack on and the same numbers the card's
// clip-path is cut from. A second copy of "how big is a hexagon" that has to
// agree with the first forever is how the hive and the snapshot nearly drifted
// apart (see the note on packMetrics), and there is no reason for this file to
// own its own.
//
// THE CELLS ARE THE SCRIM. There is no panel behind them any more, so the comb
// is what dims the fight — a dark fill per cell at CONFIG.upgradeComb.rest,
// with the gaps between hexagons left open. The water carries on moving in the
// slivers, which is the whole reason it reads as a lattice laid over the game
// rather than a window cut out of a sheet.
//
// SIX THINGS THAT LOOK RIGHT AND ARE NOT:
//
//   A LATTICE OF SQUARES     a cell is a SQUARE box with a hexagon clipped
//                            inside it, and the hexagon is neither centred in
//                            that box nor the size of it (see ART). Tile on the
//                            box and the comb is loose in x and overlapping in
//                            y, by a few per cent — which reads as sloppy
//                            drawing rather than as wrong arithmetic.
//
//   AN ORIGIN OF ITS OWN     the tiling is derived from where a CARD actually
//                            landed, measured. Compute the lattice from the
//                            viewport centre instead and it agrees with the
//                            cards on a desktop and drifts on every screen
//                            whose card size the CSS clamps — the cards stop
//                            being cells and start being things lying on top.
//
//   A RIPPLE ON TIMERS       a hundred setTimeouts per landing, three landings
//                            a level-up, twenty level-ups a run. The delay is a
//                            CSS custom property per cell and the wave is one
//                            class on the container: one pass of style writes,
//                            no timers, and the compositor does the rest.
//
//   AN ANIMATION THAT WON'T   re-adding the same class does not restart a CSS
//   RESTART                   animation, and the usual fix — clearing it and
//                             reading offsetWidth — is a forced layout per cell
//                             per ripple. Two identical keyframes under two
//                             class names, alternated, restart it for free.
//
//   A FLASH THAT STICKS       the flash keyframe has to END on the resting
//                             fill, not begin on it. With fill-mode holding the
//                             first frame through the delay, every cell sits
//                             tinted until its turn comes and the "ripple" is a
//                             screen that is already fully lit.
//
//   A COMB LEFT BEHIND        the menu is torn down and rebuilt on every
//                             level-up, and two of them land in one wave often
//                             enough. Cells are cheap but they are not free,
//                             and a comb nobody cleared is a hundred divs per
//                             level for the rest of the run.
import { CONFIG } from '../config.js';
import { HEX_GEOMETRY as ART } from './upgradeHive.js';

/**
 * A TIER COLOUR, BRIGHT ENOUGH TO BE A FLASH.
 *
 * A tier's colour is chosen to sit still on a hexagon for as long as the menu is
 * up — so the floor tier's is a near-grey, and thrown across a dark comb for a
 * fifth of a second it is invisible. That made the commonest landing in the
 * game the one with no payoff at all, which is the opposite of the ladder the
 * colours exist to draw.
 *
 * THE HUE IS KEPT AND THE LIGHTNESS IS LIFTED. Never the saturation: the floor
 * tier has none, and pushing it up would invent a colour the ladder does not
 * have — the same mistake as flooring saturation on a near-black hide. A grey
 * tier flashes white, a blue one flashes blue, and gold stays gold.
 */
export function flashTint(hex, floor = cfg().flashLift) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return `hsl(${h.toFixed(0)} ${(sat * 100).toFixed(0)}% ${(Math.max(l, floor) * 100).toFixed(0)}%)`;
}

// A packed 0xRRGGBB and an alpha, the way every other colour-plus-opacity pair
// in the UI is stored — see levelUpCards.overlayColor.
function rgba(color, alpha) {
  const n = color >>> 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function cfg() {
  const c = CONFIG.upgradeComb ?? {};
  return {
    enabled: c.enabled !== false,
    hoverEnabled: c.hoverEnabled !== false,
    gap: c.gap ?? 6,
    // HOW HARD A PULSE POPS EACH CELL, as a scale rather than a distance.
    //
    // It used to be a px shove along the line out from the card, which meant
    // every cell travelled in a different direction and the grid sheared as the
    // wave went through it. Scaling from each hexagon's own centre instead
    // reads as the whole lattice coming straight out at the camera, uniformly,
    // wherever a cell happens to sit.
    pop: Math.max(0, c.pop ?? 0.24),
    // THE TWO SPRINGS, SEPARATELY. A pulse is a colour and a movement and they
    // do not have to arrive together — either can be turned off without
    // touching the other, and both off is a wave that does nothing.
    springColor: c.springColor !== false,
    springScale: c.springScale !== false,
    flashLift: Math.min(1, Math.max(0, c.flashLift ?? 0.62)),
    rest: rgba(c.restColor ?? 0x090e16, c.restAlpha ?? 0.9),
    edge: rgba(c.edgeColor ?? 0x7ad7ff, c.edgeAlpha ?? 0.1),
    spread: Math.max(1, Math.round(c.spread ?? 2)),
    over: Math.max(0, Math.round(c.over ?? 1)),
    ringStep: Math.max(0, c.ringStep ?? 0.045),
    // POINTING AT A CARD. The same wave at a fraction of the size — a card you
    // are considering answers, and it must not answer as loudly as one landing:
    // the pulse a hand makes arriving is the event, and a hover that matched it
    // would spend that currency on moving the mouse.
    hoverStep: Math.max(0, c.hoverStep ?? 0.022),
    hoverTime: Math.max(0.05, c.hoverTime ?? 0.42),
    // Steeper than a landing's, so the answer stays local — a few rings around
    // the card rather than a wave across the screen.
    hoverFade: Math.max(0, c.hoverFade ?? 0.3),
    hoverGap: Math.max(0, c.hoverGap ?? 0.18),
    // THE LAST CARD'S FLOOD HAS ITS OWN PAIR. It is the best card in the hand
    // landing and the biggest thing this screen does, and it was running at a
    // sixth of a ripple's stagger — which crossed the comb so fast it read as
    // rushed rather than as big. Slower and longer than a ripple now: it should
    // ease into the final state, not snap to it.
    floodStep: Math.max(0, c.floodStep ?? 0.075),
    floodTime: Math.max(0.05, c.floodTime ?? 1.35),
    // THE WAY OUT HAS ITS OWN PAIR. It shared the entrance's stagger and throw
    // distance until someone tried to tune it and found there was nothing to
    // turn: an exit wants to be quicker and to go further than an arrival —
    // coming in is an invitation and leaving is a dismissal — and one number
    // serving both means every change to one silently retunes the other.
    drainStep: Math.max(0, c.drainStep ?? 0.09),
    // How much dimmer each ring out is, as a step rather than a falloff. 0 is a
    // flat flood.
    ringFade: Math.max(0, c.ringFade ?? 0.13),
    flashTime: Math.max(0.05, c.flashTime ?? 0.5),
    drainTime: Math.max(0.05, c.drainTime ?? 0.3),
    neon: c.neon ?? ['#7ad7ff', '#ff5ec4', '#b6ff3c', '#ffcc33'],
    maxCells: Math.max(1, Math.round(c.maxCells ?? 400)),
  };
}

/**
 * HOW MANY HEXAGONS APART TWO CELLS ARE — the ring number, not the distance.
 *
 * This is what makes a pulse read as CHIPPED rather than smooth. A wave paced
 * by pixels crosses every cell at a slightly different moment, so the comb
 * fades like an airbrush; paced by rings, every hexagon the same number of
 * steps out fires on the SAME frame, and the pulse leaves the card as a series
 * of hard hexagonal shells.
 *
 * Offset coordinates ("odd-q": odd columns pushed down half a cell, which is
 * how buildComb lays them) converted to cube, where the distance is just half
 * the Manhattan sum. Doing it in offset coordinates directly is possible and is
 * a well-known source of rings that are correct in one direction and one cell
 * out in the other.
 */
export function hexRings(a, b) {
  const ax = a.q;
  const az = a.r - (a.q - (a.q & 1)) / 2;
  const bx = b.q;
  const bz = b.r - (b.q - (b.q & 1)) / 2;
  return (Math.abs(ax - bx) + Math.abs(ax + az - bx - bz) + Math.abs(az - bz)) / 2;
}

// The cells on screen right now, each with the centre of its HEXAGON (not of
// its box) and the lattice cell it occupies.
let host = null;
let cells = [];
let flip = false;

/**
 * WHERE THE CARDS SIT IN THE LATTICE, as offsets from the group's own top-left.
 *
 * Pure, and exported for the harness: "are the three cards actually on one
 * lattice" is the claim this whole file rests on, and it is the kind of thing
 * that looks fine in a screenshot while being a few pixels out.
 *
 * @param n       how many cards.
 * @param box     the square card box, in px.
 * @param stacked one column instead of one row — a portrait phone, where three
 *                card-sized cells across is wider than the screen.
 * @returns { spots: [{x, y}], width, height } in box-corner coordinates.
 */
export function cardCells(n, box, stacked = false, c = cfg()) {
  const hexW = box * ART.w;
  const hexH = box * ART.h;
  const stepX = hexW * 0.75 + c.gap;
  const stepY = hexH + c.gap;

  const spots = [];
  for (let i = 0; i < n; i++) {
    if (stacked) {
      spots.push({ col: 0, row: i });
    } else {
      // Alternating columns, so all three sit at the SAME height. Adjacent
      // columns of a flat-top lattice are half a hexagon apart in y, which
      // would put the middle card higher than its neighbours — and a choice
      // where one option is raised above the others is not three equal
      // options. The columns it skips are the ones the neon runs through.
      const col = i * c.spread;
      spots.push({ col, row: 0 });
    }
  }
  const out = spots.map(({ col, row }) => ({
    col,
    row,
    x: col * stepX,
    y: row * stepY + (col % 2 ? stepY / 2 : 0),
  }));
  // Pulled back to a top-left of zero, so these are offsets inside the group's
  // own box and the group can be centred by the flex layout above it like any
  // other block. Which lattice cell each one IS travels with it — buildComb
  // needs those to leave the cards' own cells empty, and deriving them a second
  // time from the pixel offsets is a rounding error waiting to happen.
  const minY = Math.min(...out.map((p) => p.y));
  for (const p of out) p.y -= minY;
  return {
    spots: out,
    width: Math.max(...out.map((p) => p.x)) + box,
    height: Math.max(...out.map((p) => p.y)) + box,
  };
}

/**
 * HOW BIG THE CARDS CAN BE, AND WHICH WAY THEY GO.
 *
 * Three card-sized cells across is wider than the old flex row was — the comb
 * puts an empty column between each pair, which is where the neon runs — so
 * there are windows that fit neither: too narrow for the row AND too short for
 * the column. The flex row used to wrap in that case; a lattice cannot wrap, so
 * the cards get smaller instead.
 *
 * Solved rather than searched. Both footprints are linear in the box with a
 * fixed-gap intercept, so the largest box that fits either way is one division
 * each, and the better of the two wins. `natural` is the ceiling: this only
 * ever shrinks the size the stylesheet asked for.
 *
 * Pure, and exported, because "does the hand fit on that screen" is a question
 * npm run layout asks at eight sizes and a person asks at one.
 */
export function fitCards(n, natural, vw, vh, chrome = 0, c = cfg()) {
  const across = Math.max(0, n - 1) * c.spread;
  const down = Math.max(0, n - 1);
  // width  = box * (across * ART.w * 0.75 + 1) + across * gap
  // height = box * (down * ART.h + 1) + down * gap   (stacked)
  const rowA = across * ART.w * 0.75 + 1;
  const rowB = across * c.gap;
  const colC = down * ART.h + 1;
  const colD = down * c.gap;

  const wide = vw * 0.94;
  const tall = Math.max(0, vh - chrome);
  // A row is one box tall and a column is one box wide, so each is bounded on
  // both axes — a row that fits the width and not the height is no more use
  // than one that fits neither.
  const rowBox = Math.min(natural, (wide - rowB) / rowA, tall);
  const colBox = Math.min(natural, wide, (tall - colD) / colC);
  const stacked = colBox > rowBox;
  return { box: Math.max(24, Math.floor(stacked ? colBox : rowBox)), stacked };
}

/**
 * Tile the viewport, skipping the cells the cards are in.
 *
 * @param mount   the layer the cells go in — full-bleed, behind the cards.
 * @param anchor  a rect of one card's BOX, in viewport coordinates, and which
 *                lattice cell it is. Everything is stepped off this, so the
 *                comb and the cards can never be on different lattices.
 */
export function buildComb(mount, { box, left, top, col, row }, taken = [], { revealed = false } = {}) {
  clearComb();
  const c = cfg();
  if (!c.enabled) return 0;

  host = mount;
  // The look, on the layer rather than on each cell: custom properties inherit,
  // so four hundred cells and both keyframes read one pair of writes. Set here
  // rather than left to the stylesheet's fallbacks, or the two colours in
  // CONFIG are numbers nothing reads — which is exactly what they were when
  // this first went up, and it looked completely fine, because the fallback is
  // what the design wanted anyway.
  mount.style.setProperty('--sv-comb-rest', c.rest);
  mount.style.setProperty('--sv-comb-edge', c.edge);

  const hexW = box * ART.w;
  const hexH = box * ART.h;
  const stepX = hexW * 0.75 + c.gap;
  const stepY = hexH + c.gap;

  // The anchor's own hexagon centre, and from it the lattice's origin — the
  // centre of the cell at (0, 0).
  const ax = left + box * ART.cx - col * stepX;
  const ay = top + box * ART.cy - row * stepY - (col % 2 ? stepY / 2 : 0);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // How far out the tiling has to run to cover the screen from wherever the
  // anchor happens to be, plus a ring of cells past every edge so the comb is
  // never seen to end.
  const c0 = Math.floor((0 - ax) / stepX) - c.over;
  const c1 = Math.ceil((vw - ax) / stepX) + c.over;
  const r0 = Math.floor((0 - ay) / stepY) - c.over - 1;
  const r1 = Math.ceil((vh - ay) / stepY) + c.over;

  const skip = new Set(taken.map(({ col: q, row: r }) => `${q},${r}`));
  const frag = document.createDocumentFragment();
  for (let q = c0; q <= c1 && cells.length < c.maxCells; q++) {
    for (let r = r0; r <= r1 && cells.length < c.maxCells; r++) {
      if (skip.has(`${q},${r}`)) continue;
      const cx = ax + q * stepX;
      const cy = ay + r * stepY + (q % 2 ? stepY / 2 : 0);
      const el = document.createElement('i');
      el.className = 'sv-comb-cell';
      // A cell is invisible until a pulse reaches it. `revealed` is for a
      // REBUILD of a comb that is already up — the pulses that would have lit
      // these cells have already happened, to the cells they are replacing, so
      // without this a relayout mid-menu hands the player an empty screen that
      // nothing is ever going to light again. Inline, so the first wave's
      // animation still overrides it.
      if (revealed) el.style.opacity = '1';
      el.style.left = `${cx - box * ART.cx}px`;
      el.style.top = `${cy - box * ART.cy}px`;
      el.style.width = `${box}px`;
      el.style.height = `${box}px`;
      frag.appendChild(el);
      // q,r as well as x,y. Every wave steps in LATTICE units now — rings out
      // from a cell, columns across the comb — and a pixel distance cannot say
      // which ring a hexagon is in. Keeping both means neither has to be
      // re-derived from the other, which is where a rounding error would turn
      // a clean ring into a ragged one.
      cells.push({ el, x: cx, y: cy, q, r });
    }
  }
  mount.appendChild(frag);
  return cells.length;
}

// --- the waves ---------------------------------------------------------------
// All three are the same move: give every cell a delay from a point, then start
// one animation. What differs is the keyframe and what the delay is measured
// against.

/**
 * Run one wave over every cell.
 *
 * TWO SHAPES, and which one a moment wants is the whole difference between the
 * comb arriving and the comb reacting:
 *
 *   RADIAL   delay is the distance from a point. This is the gradient pulse —
 *            a ring travelling out from the cell a card just landed in, the
 *            colour thinning as it goes because the cells further out are
 *            further through their own fade by the time you look. It only
 *            reads as a pulse because it has an origin.
 *
 *   ALONG AN AXIS   delay is the distance across the screen in ONE direction:
 *            down the screen when the hand is a column, across it when the hand
 *            is a row. A honeycomb assembling has to have a direction — a comb
 *            that arrives from its own middle reads as a shockwave, which is
 *            what the payoff is, and spending it on the opening leaves the
 *            landings with nothing left to say.
 *
 * @param axis  'radial', or 'x' / 'y' for a sweep. `from` is the origin in the
 *              radial case and is ignored otherwise.
 */
function wave({ anim, seconds, tint, from, pop = 0, step: perStep = null, reveals = true, cfgOverride = null }) {
  if (!cells.length) return 0;
  const c = cfgOverride ?? cfg();
  // ALTERNATING THE ANIMATION'S NAME IS WHAT RESTARTS IT. Writing the same name
  // over a wave that is still running updates it in place — a new delay on an
  // animation already half way through — so the second ripple of a hand never
  // fires at all. Every keyframe has an identical `-2` twin in the stylesheet
  // for exactly this, and nothing else uses them.
  flip = !flip;
  const name = flip ? anim : `${anim}-2`;

  // EVERY WAVE IS RINGS OUT FROM A CELL, counted in hexagons rather than
  // pixels. Every cell the same number of rings out fires on the same frame, so
  // a wave leaves as hard shells — paced by distance instead, each cell fires a
  // moment apart and the comb fades like an airbrush. That is the difference
  // between a chipped look and a smooth one.
  //
  // There used to be a second mode here, a stagger along an axis, for a comb
  // that swept in column by column before the cards arrived. The comb has no
  // entrance of its own any more: it is revealed BY the pulses, so rings are
  // the only shape a wave comes in.
  const origin = Number.isFinite(from?.q) && Number.isFinite(from?.r) ? from : nearestCell(from);

  // THE INNERMOST RING THAT ACTUALLY HAS CELLS IN IT. A card sits in a HOLE —
  // buildComb leaves its cell empty — so ring zero never contains anything, and
  // the first ring that does was starting one step late and one step dim.
  const floorStep = Math.min(...cells.map((k) => hexRings(k, origin)));

  let last = 0;
  for (const cell of cells) {
    const step = hexRings(cell, origin) - floorStep;
    const gapS = perStep ?? c.ringStep;
    const at = step * gapS;
    last = Math.max(last, at);

    // HOW HARD THIS CELL POPS. Every cell scales from its OWN centre by the
    // same amount, so the lattice comes straight out at the camera uniformly
    // rather than shearing outward from the card. A ring further out is not
    // popped less — only lit less; the movement is the wave passing through,
    // and a wave does not get smaller because it has travelled.
    //
    // ZERO IS THE OFF SWITCH, and it is the same number the toggle writes: the
    // keyframe multiplies every swing by this, so 0 leaves a pulse that is
    // purely a colour.
    cell.el.style.setProperty('--sv-comb-pop', c.springScale ? String(pop) : '0');

    // ...AND HOW HARD IT IS LIT. Each ring out is a fixed step dimmer, not a
    // continuous falloff — same reason the timing is quantised. `ringFade` at 0
    // makes every ring equally bright, which reads as a flat flood.
    //
    // With the colour spring off, `hit` goes to 0 — the keyframe mixes the tint
    // in by that fraction, so 0% of it is the resting fill and the pulse is
    // purely a movement. One number, both meanings, no second code path.
    if (tint) {
      cell.el.style.setProperty('--sv-comb-tint', tint);
      cell.el.style.setProperty('--sv-comb-hit',
        c.springColor ? Math.max(0, 1 - step * c.ringFade).toFixed(3) : '0');
    }

    cell.el.style.setProperty('--sv-comb-at', `${at.toFixed(3)}s`);
    cell.el.style.setProperty('--sv-comb-len', `${seconds}s`);
    // FILL FORWARDS ON EVERYTHING, and it is doing two jobs now.
    //
    // Before its turn a cell shows its own resting style — which is INVISIBLE,
    // because the comb has no entrance: a cell is revealed by the first pulse
    // that reaches it and holds the animation's last frame afterwards, so it
    // stays. Holding the FIRST frame instead would light every cell at once and
    // send a wave of rest across a comb that was already fully on screen.
    cell.el.style.animationFillMode = 'forwards';
    cell.el.style.animationName = name;

    // REVEALED BY A REAL WRITE, not by an animation's fill.
    //
    // A cell's resting style is invisible, and it was being kept on screen by
    // `forwards` holding the last frame of whatever wave reached it. That works
    // and it is far too easy to lose: a later keyframe that does not mention
    // opacity releases it (the hover did exactly that), a rebuild replaces the
    // element, a superseded animation can be dropped by the engine, and a
    // document the browser considers hidden never advances the timeline at all
    // — in every one of those the grid silently empties, and the fill is the
    // last place anyone thinks to look.
    //
    // An inline opacity is none of those things. The animation still overrides
    // it while it runs, because a running animation outranks an inline style;
    // when it ends, or never starts, or is thrown away, this is what the cell
    // falls back to.
    // The exit CLEARS it rather than skipping it: a cell still pinned visible
    // would be left on screen by the same lost fill this is insuring against —
    // the failure inverted, and a comb that never goes away is worse than one
    // that never arrives. Cleared, the cell falls back to its resting style,
    // which is invisible, exactly where the exit is taking it anyway.
    cell.el.style.opacity = reveals ? '1' : '';
  }
  return last + seconds;
}

// The cell whose hexagon centre is closest to a point. Only used for a caller
// that knows where something is on screen but not which cell it is in — a
// `from` with no q/r would otherwise make every ring NaN, every delay NaN, and
// a pulse that simply never happens, with nothing thrown.
function nearestCell(at) {
  const x = at?.x ?? 0;
  const y = at?.y ?? 0;
  let best = cells[0];
  let bestD = Infinity;
  for (const cell of cells) {
    const d = (cell.x - x) ** 2 + (cell.y - y) ** 2;
    if (d < bestD) { bestD = d; best = cell; }
  }
  return best;
}

/**
 * POINTING AT A CARD — the same rings, small.
 *
 * A card being considered answers from its own cell, in its own tier colour,
 * with a steeper falloff so the reply stays within a few rings.
 *
 * COLOUR AND NOTHING ELSE — the grid does not move. A landing is the lattice
 * being struck; a hover is it being lit. Popping the cells as well would spend
 * the arrival's currency on moving the mouse, and worse, would reset the grid's
 * geometry every time the pointer crossed a card.
 *
 * THROTTLED, and it has to be: a pointer crossing a hexagon's corner enters and
 * leaves several times in a few frames, and every one of those is a full pass
 * over every cell in the comb. `hoverGap` is the floor on how often one card
 * may answer — per card, so moving ALONG the hand still pulses each one.
 *
 * @returns false if it was too soon, so a caller can tell "throttled" from
 *          "there was no comb".
 */
const hoverAt = new Map();
export function hoverComb(key, from, tint) {
  const c = cfg();
  if (!c.hoverEnabled || !cells.length) return false;
  const now = performance.now() / 1000;
  if (now - (hoverAt.get(key) ?? -Infinity) < c.hoverGap) return false;
  hoverAt.set(key, now);
  // COLOUR ONLY. `sv-comb-tint` has no transform in it at all — a keyframe that
  // mentions transform owns it for the whole animation, so even a scale of 1
  // would snap the lattice back from wherever the last wave left it, on every
  // mouse move. A hover is allowed to tint the grid and nothing else.
  wave({
    anim: 'sv-comb-tint', seconds: c.hoverTime, from, step: c.hoverStep,
    tint: flashTint(tint, c.flashLift),
    cfgOverride: { ...c, ringFade: c.hoverFade },
  });
  return true;
}

/** A card landing: a ring in that card's own tier colour, out from its cell. */
export function rippleComb(from, tint) {
  const c = cfg();
  return wave({
    anim: 'sv-comb-flash', seconds: c.flashTime, from,
    tint: flashTint(tint, c.flashLift), pop: c.pop,
  });
}

/**
 * THE LAST REEL — the best card in the hand — taking the whole screen.
 *
 * The same wave several times faster rather than a genuinely simultaneous
 * flash. All-at-once loses the origin, and the origin is the point: the colour
 * still has to come FROM the card that earned it, it just crosses the comb
 * quickly enough to read as the screen going that colour rather than as a ring.
 */
export function floodComb(from, tint) {
  const c = cfg();
  // THE LAST CARD, ON ITS OWN CLOCK. This is the best card in the hand landing
  // and the biggest thing the screen does, and it used to run at a sixth of a
  // ripple's stagger — which crossed the comb so fast it read as RUSHED rather
  // than as big. Its own step and its own length now, both slower, so it eases
  // into the final state instead of snapping to it.
  const slow = { ...c, ringFade: c.ringFade * 0.6 };
  return wave({
    anim: 'sv-comb-flash', seconds: c.floodTime, from, step: c.floodStep,
    tint: flashTint(tint, c.flashLift), pop: c.pop * 1.3, cfgOverride: slow,
  });
}

/**
 * The middle of a hexagon drawn in `rect`.
 *
 * Every wave is a distance from a point, and that point is the shape the player
 * sees — which is neither the centre of the card's box nor a corner of it. One
 * export so no caller re-derives it from the clip-path's numbers.
 */
export function hexCentreOf(rect) {
  return {
    x: rect.left + rect.width * ART.cx,
    y: rect.top + rect.height * ART.cy,
  };
}

/**
 * The comb leaving — a flash travelling through it, and each cell springing off
 * screen behind that flash.
 *
 * ONE ANIMATION, NOT TWO. The wave and the exit are the same keyframe: a cell
 * lights, then goes. Staggered along the axis, that reads as a pulse crossing
 * the comb with the lattice peeling away behind it — which is the thing being
 * asked for, and it needs no second pass and no timer between them.
 *
 * OUT THROUGH THE FAR EDGE. The comb keeps travelling the way it came in rather
 * than reversing, so a level-up is one continuous move across the screen that
 * happens to stop in the middle for as long as you are choosing.
 */
export function drainComb(from, tint) {
  const c = cfg();
  // RINGS FROM THE CARD YOU TOOK, thrown off along the axis.
  //
  // Two different questions, and they get two different answers: WHEN a cell
  // leaves is how many rings it is from the choice — so the comb comes apart
  // outward from the card that ended the menu, quantised into shells exactly
  // like a landing's pulse — and WHERE it goes is the sweep's own direction, so
  // the whole lattice still exits through the far edge together.
  //
  // Swept by column instead, the exit was a wipe with no relationship to what
  // the player just did.
  return wave({
    anim: 'sv-comb-out', seconds: c.drainTime, axis: 'radial', from,
    // The one wave that is NOT a reveal: this is the comb leaving, and pinning
    // the cells visible would leave the whole lattice on screen after it.
    reveals: false,
    step: c.drainStep, tint: tint ? flashTint(tint, c.flashLift) : null,
  });
}

/** One of the arcade colours, by index. The buildup's palette. */
export function neonAt(i) {
  const n = cfg().neon;
  return n[((i % n.length) + n.length) % n.length];
}

export function clearComb() {
  // The inline reveals go with the cells, but the host may be reused — a stale
  // opacity on it would build the next comb dimmed.
  // The throttle is per hand, not per run: a card in the same cell next
  // level-up is a different card, and it should answer the first time it is
  // pointed at rather than inheriting the last one's cooldown.
  hoverAt.clear();
  if (host) host.textContent = '';
  cells = [];
  host = null;
}

/** How many cells are up. Exported for the harness and the look page. */
export function combSize() {
  return cells.length;
}
