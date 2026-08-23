#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:hexmenu
//
// THE ARRANGEMENTS THE BUTTONS CAN TAKE — the row on a wide screen and the
// portrait figures on a tall one (systems/hexMenu.js, `cellsFor`).
//
// It measures the REAL createHexMenu. No GL context is needed to lay a menu
// out: the shader materials are built without one and the cell centres come
// out of systems/hexLattice.js, so everything below is the code the game runs,
// not a re-derivation of it. That distinction matters here more than usual —
// the whole point of the lattice module is that two files agreeing by
// coincidence is the bug, and a test that recomputed `hexCenter` itself would
// be exactly that coincidence.
//
// WHAT IT IS ACTUALLY GUARDING. Every failure below renders something: a
// figure half a row off its lattice is a menu with a visible kink in it, a
// figure whose cells overlap is two buttons sharing a hit test, and an item
// order that is not lowest-first puts Play at the top of the screen on a
// phone. None of them throw, and all of them survive a glance at a laptop —
// the row is what a laptop shows and the row is the one shape none of this
// can break.
// ---------------------------------------------------------------------------
import { createHexMenu, fitScale } from '../path/src/systems/hexMenu.js';
import { hexCellAt, hexCenter, hexMetrics } from '../path/src/systems/hexLattice.js';
import { CONFIG } from '../path/src/config.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// THE SHIPPED FOUR, in main.js's own order. The order matters more than the
// labels here: the diamond is addressed by POSITION — Play on top, Options
// left, Leaderboard right, the tip jar below — and the only thing that ties an
// item to a position is its index in this list.
const ITEMS = [
  { label: 'Play' }, { label: 'Options' }, { label: 'Leaderboard' }, { label: 'Tip jar' },
];
// The three-cell figures were the menu before the tip jar joined it and are
// still the right answer for three buttons, so they are measured with three.
const THREE = ITEMS.slice(0, 3);
// A stand-in for the measured bust: the numbers do not matter, only that the
// box is real, because everything here is relative to the anchor cell it snaps
// to. Deliberately off-centre so a shape that is accidentally centred on the
// ORIGIN rather than on the anchor shows up.
const BOX = { min: { x: -0.83, y: -1.6 }, max: { x: 0.71, y: 0.04 } };

// Which arrangement is measured with how many buttons. The count is part of
// the figure: a diamond is four cells and a triangle is three, and laying one
// out with the other's count does not fail — it runs short or long, which is
// exactly the kind of silent wrong shape this file exists to catch.
const COUNT = {
  row: ITEMS, stack: ITEMS, diamond: ITEMS,
  triDown: THREE, triUp: THREE, trefoil: THREE, trefoilLeft: THREE,
};
const PORTRAIT = ['diamond', 'stack', 'triDown', 'triUp', 'trefoil', 'trefoilLeft'];
const ALL = ['row', ...PORTRAIT];

const cfg = CONFIG.splashBust.menu;
const m = hexMetrics(cfg.latticeSpacing ?? 1);

/** Lay one arrangement out and report where its cells actually landed. */
function laid(shape, items = COUNT[shape] ?? ITEMS) {
  const menu = createHexMenu(items, cfg);
  menu.layout(BOX, { shape });
  return {
    menu,
    shape: menu.shape,
    cells: menu.items.map((i) => ({ ...i.cell })),
    at: menu.items.map((i) => ({ x: i.world.x, y: i.world.y })),
    radius: menu.radius,
  };
}

// --- on the lattice, or it is not a hex menu -------------------------------
section('Every cell is a real cell of the game\'s own lattice');
for (const shape of ALL) {
  const L = laid(shape);
  const off = L.cells.map((c, i) => {
    const want = hexCenter(c.col, c.row, m);
    return Math.hypot(want.x - L.at[i].x, want.y - L.at[i].y);
  });
  check(`${shape} sits on hexCenter`, Math.max(...off) < 1e-9,
    `worst ${Math.max(...off).toExponential(1)} world units off`);
  check(`${shape} is the shape that was asked for`, L.shape === shape, L.shape);
}

// --- three buttons, three places -------------------------------------------
section('No two buttons share a cell, and none of them overlap');
for (const shape of ALL) {
  const L = laid(shape);
  const want = (COUNT[shape] ?? ITEMS).length;
  const keys = new Set(L.cells.map((c) => `${c.col},${c.row}`));
  check(`${shape} uses ${want} distinct cells`, keys.size === want, [...keys].join(' '));
  // Two cells of one lattice can be adjacent (centres a rowStep apart) but
  // never closer. Anything under that is two hexagons in the same space, which
  // the shader draws as one lumpy tile and `pick` resolves by whichever it
  // tested first.
  let worst = Infinity;
  for (let i = 0; i < L.at.length; i++) {
    for (let j = i + 1; j < L.at.length; j++) {
      worst = Math.min(worst, Math.hypot(L.at[i].x - L.at[j].x, L.at[i].y - L.at[j].y));
    }
  }
  check(`${shape} keeps a whole cell between centres`, worst >= m.rowStep - 1e-9,
    `closest pair ${worst.toFixed(3)} vs a rowStep of ${m.rowStep.toFixed(3)}`);
}

// --- the item order --------------------------------------------------------
section('Play is the lowest button, on every arrangement that is a list');
// The ordering rule the LISTS share, and the reason it can be one rule: on a
// phone the lowest cell is nearest both the seal's crown and the thumb. It has
// to hold for the ROW too, where it degenerates into left-to-right — which is
// the shipped order, and the check that this did not quietly change. The
// diamond is not a list and is checked by position, below.
for (const shape of ALL.filter((s) => s !== 'diamond')) {
  const L = laid(shape);
  const lowest = Math.min(...L.at.map((p) => p.y));
  check(`${shape} puts Play at the bottom`, L.at[0].y <= lowest + 1e-9,
    `Play at y ${L.at[0].y.toFixed(2)}, lowest ${lowest.toFixed(2)}`);
}
{
  const L = laid('row');
  check('the row still reads left to right',
    L.at[0].x < L.at[1].x && L.at[1].x < L.at[2].x,
    L.at.map((p) => p.x.toFixed(2)).join(' < '));
}

// --- nothing hangs below the anchor ----------------------------------------
section('`rise` means the same thing on every arrangement');
// The apex-up triangle is the one that catches this: its base row is a flipped
// column parity, so the only heights it can reach are half-steps, and the
// natural one is half a rowStep BELOW the cell the crop asked for — straight
// into the headroom over the crown.
// The anchor's own height, from the same two numbers layout() snaps: the
// middle of the bust plus `rise`. NOT read off one of the arrangements — a row
// of four lands half a rowStep high, because an even count at a step of two
// puts every column on the opposite parity to the anchor, and measuring the
// invariant against a shape that is subject to it proves nothing.
const anchorCell = hexCellAt(
  (BOX.min.x + BOX.max.x) / 2 + (cfg.offsetX ?? 0),
  BOX.max.y + (cfg.rise ?? 0.62),
  m,
);
const anchorY = hexCenter(anchorCell.col, anchorCell.row, m).y;
for (const shape of ALL) {
  const L = laid(shape);
  const lowest = Math.min(...L.at.map((p) => p.y));
  check(`${shape} starts at or above the anchor`, lowest >= anchorY - 1e-9,
    `lowest ${lowest.toFixed(2)} vs anchor ${anchorY.toFixed(2)}`);
}

// --- the diamond, which is the shipped one ---------------------------------
section('The diamond is a compass, and the compass points where it was told');
{
  const L = laid('diamond');
  const [play, options, board, jar] = L.at;
  check('Play is on top', play.y > options.y && play.y > board.y && play.y > jar.y,
    L.at.map((p) => p.y.toFixed(2)).join(' '));
  check('the tip jar is at the bottom', jar.y < options.y && jar.y < board.y && jar.y < play.y,
    `${jar.y.toFixed(2)} under ${options.y.toFixed(2)}`);
  check('Options is on the left and Leaderboard on the right',
    options.x < board.x, `${options.x.toFixed(2)} < ${board.x.toFixed(2)}`);
  check('the two sides are level with each other',
    Math.abs(options.y - board.y) < 1e-9, `${options.y} vs ${board.y}`);
  check('Play and the jar share the middle column',
    Math.abs(play.x - jar.x) < 1e-9 && Math.abs(play.x - (options.x + board.x) / 2) < 1e-9,
    `${play.x.toFixed(2)} / ${jar.x.toFixed(2)}`);
  // A rhombus of the honeycomb has no hole: top and bottom touch each other
  // THROUGH the middle of the figure, and each side cell touches both. That
  // contact is the difference between a diamond and four scattered tiles.
  const near = (a, b) => Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - m.rowStep) < 1e-9;
  check('every side cell touches both Play and the jar',
    [options, board].every((s) => near(s, play) && near(s, jar)));
  check('...and Play touches the jar through the middle', near(play, jar),
    Math.hypot(play.x - jar.x, play.y - jar.y).toFixed(3));
}

// --- the triangles are triangles -------------------------------------------
section('The triangles touch the way a honeycomb does');
// The apex of an open triangle is adjacent to BOTH cells of its base — that
// contact is what makes the figure read as one shape rather than as three
// tiles that happen to be near each other. The base pair is deliberately two
// columns apart, which leaves a cell-shaped hole under the apex; a "triangle"
// whose apex has drifted out of contact looks like a rendering fault.
const adjacent = (a, b) => Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - m.rowStep) < 1e-9;
for (const shape of ['triDown', 'triUp']) {
  const L = laid(shape);
  const apex = shape === 'triDown' ? L.at[0] : L.at[2];
  const base = shape === 'triDown' ? [L.at[1], L.at[2]] : [L.at[0], L.at[1]];
  check(`${shape}'s apex touches both base cells`,
    base.every((b) => adjacent(apex, b)),
    base.map((b) => Math.hypot(apex.x - b.x, apex.y - b.y).toFixed(3)).join(' / '));
  check(`${shape}'s base is a cell apart`,
    Math.abs(Math.hypot(base[0].x - base[1].x, base[0].y - base[1].y) - m.colStep * 2) < 1e-9,
    `${Math.hypot(base[0].x - base[1].x, base[0].y - base[1].y).toFixed(3)}`);
}
// The trefoil is the other kind: nothing missing, because with three flat-top
// hexagons all touching there is nowhere for a hole to be.
for (const shape of ['trefoil', 'trefoilLeft']) {
  const L = laid(shape);
  const pairs = [[0, 1], [1, 2], [0, 2]];
  check(`${shape} has all three cells touching`,
    pairs.every(([i, j]) => adjacent(L.at[i], L.at[j])),
    pairs.map(([i, j]) => Math.hypot(L.at[i].x - L.at[j].x, L.at[i].y - L.at[j].y).toFixed(3)).join(' '));
}
{
  const a = laid('trefoil');
  const b = laid('trefoilLeft');
  check('trefoilLeft is the mirror of trefoil',
    a.at.every((p, i) => Math.abs(p.y - b.at[i].y) < 1e-9)
      && Math.sign(a.at[1].x - a.at[0].x) === -Math.sign(b.at[1].x - b.at[0].x),
    `${(a.at[1].x - a.at[0].x).toFixed(2)} vs ${(b.at[1].x - b.at[0].x).toFixed(2)}`);
}

// --- the reason any of this exists -----------------------------------------
section('Every portrait arrangement fits a phone the row cannot');
// The number that forces the whole feature. At 375x812 the aspect is 0.46, so
// a unit of WIDTH costs 2.2 units of height: the frame the crop composes is
// sized off the wider of the animal and the buttons, and the row is nearly
// three times the animal's width. Asserted as a ratio against the row rather
// than as a world-unit threshold, because `latticeSpacing` is tunable and a
// hardcoded 3.0 here would fail the day someone moved it.
const spanOf = (L) => (Math.max(...L.at.map((p) => p.x)) - Math.min(...L.at.map((p) => p.x)))
  + L.radius * 2;
const rowSpan = spanOf(laid('row'));  // four across
const bustSpan = BOX.max.x - BOX.min.x;
check('the row really is the wide one', rowSpan > bustSpan * 2.5,
  `${rowSpan.toFixed(2)} across against a bust of ${bustSpan.toFixed(2)}`);
for (const shape of PORTRAIT) {
  const span = spanOf(laid(shape));
  check(`${shape} is under two thirds of the row`, span < rowSpan * 0.67,
    `${span.toFixed(2)} vs ${rowSpan.toFixed(2)}`);
}

// --- which one a screen gets -----------------------------------------------
section('The viewport picks the arrangement');
const menu = createHexMenu(ITEMS, cfg);
const withWindow = (w, h, fn) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'innerWidth');
  const prevW = globalThis.innerWidth;
  const prevH = globalThis.innerHeight;
  globalThis.innerWidth = w;
  globalThis.innerHeight = h;
  try { return fn(); } finally {
    if (had) { globalThis.innerWidth = prevW; globalThis.innerHeight = prevH; }
    else { delete globalThis.innerWidth; delete globalThis.innerHeight; }
  }
};
check('a laptop gets the row', withWindow(1512, 900, () => menu.wantsShape()) === 'row');
check('a phone upright gets the portrait shape',
  withWindow(375, 812, () => menu.wantsShape()) === (cfg.portraitShape ?? 'triDown'),
  withWindow(375, 812, () => menu.wantsShape()));
check('a phone on its side gets the row',
  withWindow(812, 375, () => menu.wantsShape()) === 'row');
// A tablet upright is 0.75 exactly at 768x1024 — the threshold itself, which
// is the one aspect where an off-by-one in the comparison shows.
check('a tablet upright gets the row', withWindow(768, 1024, () => menu.wantsShape()) === 'row',
  withWindow(768, 1024, () => menu.wantsShape()));
// A window that has not been measured yet — the first layout can run before
// anything has laid out, and `row` is the safe answer because it is the one
// the frame is composed for.
check('an unmeasured window falls back to the row',
  withWindow(0, 0, () => menu.wantsShape()) === 'row');
check('the shipped default is the diamond', cfg.portraitShape === 'diamond',
  cfg.portraitShape);
// THE FOURTH BUTTON IS FREE, and that is the argument for the diamond over a
// row: the row grows by a whole cell per item and the diamond fills a gap it
// already had. Measured rather than asserted from the arithmetic, because the
// arithmetic is the thing that would be wrong.
{
  const three = spanOf(laid('diamond', THREE));
  const four = spanOf(laid('diamond', ITEMS));
  check('the diamond is no wider with four buttons than with three',
    four <= three + 1e-9, `${four.toFixed(2)} vs ${three.toFixed(2)}`);
  const rowThree = spanOf(laid('row', THREE));
  check('a row of four, by contrast, grows by a full cell',
    rowSpan > rowThree + m.colStep * 1.9, `${rowSpan.toFixed(2)} vs ${rowThree.toFixed(2)}`);
}
check('nothing is pinned in the shipped config', cfg.shape == null, String(cfg.shape));

// --- the type in the cells -------------------------------------------------
section('The labels are fitted to a hexagon, not to a box');
// `fitScale` takes px and returns a number, so it can be measured here with no
// DOM at all — which is the whole reason it lives in hexMenu rather than beside
// the elements it ends up on. The sizes below are the shipped labels as Press
// Start 2P actually measures them at the role's size: one em per glyph, so the
// width IS the letter count, and this is the face the game ships.
const CELL = 328;                       // a cell on a phone, point to point, px
const L = cfg.label ?? {};
const one = (w) => [{ w, h: 16 }];      // one line
const two = (w) => [{ w, h: 32 }];      // two lines of the same face
{
  // The claim, stated as the thing that would otherwise be wrong: a two-line
  // label must be fitted NARROWER than a one-line label of the same width,
  // because the hexagon has given up 1/√3 of its width at that height.
  const tall = fitScale(two(104), CELL, L);
  const flat = fitScale(one(104), CELL, L);
  check('two lines are fitted tighter than one of the same width', tall < flat,
    `${tall.toFixed(3)} vs ${flat.toFixed(3)}`);
  // ...and by how much: the room at height h is 2R − h/√3, so the ratio is
  // exactly the ratio of those two rooms. A fit that ignored the taper would
  // return the SAME number for both, which is the bug in one line.
  const want = (104 + (L.fill ?? 0.8) * 16 / Math.sqrt(3))
    / (104 + (L.fill ?? 0.8) * 32 / Math.sqrt(3));
  check('...by exactly the room the slanted edges take back',
    Math.abs(tall / flat - want) < 1e-9, `${(tall / flat).toFixed(4)} vs ${want.toFixed(4)}`);
}
{
  // The fitted block has to actually FIT, which is the only thing a player
  // sees. Checked against the room at the block's own height, not against 2R.
  for (const [name, sizes] of [['OPTIONS', one(121)], ['LEADER/BOARD', two(104)]]) {
    const s = fitScale(sizes, CELL, L);
    const w = sizes[0].w * s;
    const h = sizes[0].h * s;
    const room = CELL - h / Math.sqrt(3);
    check(`${name} sits inside the cell at its own height`, w <= room + 1e-9,
      `${w.toFixed(0)}px of ${room.toFixed(0)}px`);
    check(`${name} uses most of that room`, w > room * 0.7,
      `${(w / room).toFixed(2)} of it`);
  }
}
{
  // One scale for every label, and the tightest label sets it. The failure this
  // catches is a per-label fit, which renders "PLAY" at twice the height of
  // "OPTIONS" beside it and looks like a bug rather than like emphasis.
  const together = fitScale([{ w: 69, h: 16 }, { w: 121, h: 16 }], CELL, L);
  const alone = fitScale([{ w: 121, h: 16 }], CELL, L);
  check('the widest label sets the scale for all of them',
    Math.abs(together - alone) < 1e-9, `${together.toFixed(3)} vs ${alone.toFixed(3)}`);
  // The lead is bigger, and it is bigger by paying for itself: emphasis is
  // inside the minimum, so an emphasised label that could not fit pulls
  // everything down rather than overflowing on its own.
  const emph = fitScale([{ w: 121, h: 16, emphasis: 2.5 }], CELL, L);
  check('an emphasised label still has to fit', emph * 2.5 <= alone + 1e-9,
    `${(emph * 2.5).toFixed(3)} vs ${alone.toFixed(3)}`);
}
check('the growth cap is the last word',
  fitScale([{ w: 1, h: 1 }], CELL, L) === (L.grow ?? 3), String(L.grow));
check('nothing to measure is a scale of 1', fitScale([], CELL, L) === 1);
check('a zero-width cell does not divide by it', fitScale(one(121), 0, L) === 1);
check('the lead is bigger than the rest', (L.leadScale ?? 1) > 1, String(L.leadScale));
check('...and glows harder on hover', (L.leadHoverGlow ?? 0) > (L.hoverGlow ?? 0),
  `${L.leadHoverGlow} vs ${L.hoverGlow}`);
check('...and lights its own tile harder', (L.leadHot ?? 1) > 1, String(L.leadHot));

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
