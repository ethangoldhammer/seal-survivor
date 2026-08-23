import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { hexMetrics, hexCenter, hexCellAt } from './hexLattice.js';

// THE SPLASH MENU — hex buttons sitting in the game's own lattice.
//
// ON THE STANDING LATTICE, NOT ON A NEW ONE. Every position here comes out of
// systems/hexLattice.js — the same `hexMetrics` / `hexCenter` / `hexCorners`
// the arena backdrop is drawn from (systems/grid.js) — which is the entire
// reason that module exists: hex art lines up with the grid because both read
// the same numbers, not because two files happen to agree. A button is a whole
// CELL of that lattice, addressed by (col, row), so it cannot be a pixel out.
//
// FLAT-TOP, because the lattice is. That is not a style choice available here:
// the level-up card art is cut for it (ART_HEX) and a pointy-top button would
// be the one hexagon in the game facing a different way.
//
// THE SURFACE IS THE TRAP BUBBLE'S (CONFIG.bubbleShell): a fresnel film, nearly
// clear facing you and bright along the silhouette, with a tight highlight on
// top. What makes that possible on a flat shape is the BEVEL — see the shader,
// where the distance to the hex's own edge stands in for a surface turning away
// from the viewer. Without it every pixel of a flat hex faces the lens dead-on,
// the fresnel term is a constant, and the button is a coloured sticker.
//
// WHAT IT KEEPS FROM THE BLOBS IT REPLACES: the squish (a damped wobble in the
// shape itself, not on the mesh) and the substance that comes out of it — real
// goo through the game's density pass and real bubbles, on hover and on press.

const MAX_CELLS = 6;

const vertexShader = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #define MAX_CELLS ${MAX_CELLS}
  uniform vec2 uCenter[MAX_CELLS];
  uniform float uRadius[MAX_CELLS];  // centre to corner
  uniform vec2 uSquash[MAX_CELLS];
  // The axis the squash acts along, as a unit vector. A press squashes a tile
  // between the pointer and its own centre, which is a direction — scaling x
  // and y alone can only ever squash toward the screen's own axes, and a pull
  // from the corner would flatten a hex sideways while the cursor is diagonal.
  uniform vec2 uAxis[MAX_CELLS];
  // 0 = a crisp cell of the lattice, 1 = a drop of goo. See the note by uMelt's
  // use below: it is a corner ROUNDING, not a blend between two shapes.
  uniform float uMelt[MAX_CELLS];
  // 0..1 of "is this button here yet" — the flicker-on. Multiplies the alpha of
  // whichever cell is nearest, so a button that has not arrived contributes
  // nothing while the ones beside it are already lit.
  uniform float uOn[MAX_CELLS];
  uniform float uHot[MAX_CELLS];
  uniform int uCount;
  uniform float uBevel;      // how far in from the edge the bevel reaches
  uniform float uPower;      // fresnel tightness
  uniform float uBias;       // how much of the middle the band is cut back from
  uniform float uCoreAlpha;
  uniform float uRimAlpha;
  uniform float uRimBoost;
  uniform float uSheen;
  uniform float uSpecPower;
  uniform float uNormal;
  uniform float uOpacity;
  uniform vec2 uLight;
  uniform vec3 uColor;
  uniform vec3 uHotColor;
  varying vec2 vLocal;

  // Signed distance to a FLAT-TOP hexagon — negative inside. iq's hexagon,
  // whose parameter is the apothem (centre to a flat side) and whose flats are
  // top and bottom, which is this project's orientation exactly: hexCorners
  // starts at the right-hand POINT, so the flats are horizontal.
  float sdHex(vec2 p, float apothem) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * apothem, k.z * apothem), apothem);
    return length(p) * sign(p.y);
  }

  // The whole row as one distance: the nearest cell wins. A plain min, not a
  // smooth one — these are tiles in a lattice and they are meant to meet at an
  // edge, not to fuse. (The blob version of this menu did fuse, which is what a
  // metaball is for and what a grid is not.)
  float field(vec2 p, out int which) {
    float d = 1e9;
    which = 0;
    for (int i = 0; i < MAX_CELLS; i++) {
      if (i >= uCount) break;
      // Into the squash's own frame, scaled there, and left there: the SDF
      // below is symmetric under the rotation that would bring it back, and a
      // hexagon is not — rotating the sample point would spin the tile off the
      // lattice every time it was pressed.
      vec2 d0 = p - uCenter[i];
      vec2 ax = uAxis[i];
      vec2 local = vec2(dot(d0, ax), dot(d0, vec2(-ax.y, ax.x)));
      local /= max(uSquash[i], vec2(0.05));
      vec2 q = ax * local.x + vec2(-ax.y, ax.x) * local.y;
      // MELTING, done the way a distance field lets you: shrink the hexagon by
      // k and then subtract k from its distance, which rounds every corner by
      // exactly k while leaving the flats where they were. At k = 0 it is the
      // lattice cell; as k approaches the apothem the six corners have eaten
      // the whole outline and what is left is a drop.
      //
      // Not a mix() between a hexagon and a circle, which is the obvious way
      // and is wrong: interpolating two distance fields moves the edge along
      // the shortest path between them, so the flats bow outward halfway
      // through and the shape passes through a bulging cushion that is neither.
      // Rounding stays a true distance field the whole way, so the bevel, the
      // fresnel and the anti-aliasing all keep working while it happens.
      float apo = uRadius[i] * 0.866025404;
      float k = apo * clamp(uMelt[i], 0.0, 0.98);
      float di = sdHex(q, apo - k) - k;
      if (di < d) { d = di; which = i; }
    }
    return d;
  }

  void main() {
    int which;
    float d = field(vLocal, which);
    // Anti-aliased edge without derivatives: GLSL ES 1.00 has no fwidth here,
    // and the field is in world units, so a fixed fraction of the bevel is a
    // stable soft edge at any zoom.
    float aa = uBevel * 0.35;
    float a = 1.0 - smoothstep(-aa, aa, d);
    if (a <= 0.002) discard;

    // THE BEVEL. the bevel term runs 0 at the outline to 1 once we are a bevel's width
    // inside, and its square root is the height of a rolled-over lip — which is
    // what turns a flat tile into something with a rim the fresnel can find.
    float edge = clamp(-d / max(uBevel, 1e-4), 0.0, 1.0);
    float h = sqrt(edge);

    // Which way the lip leans: the gradient of the distance field, by central
    // difference. Two extra evaluations of a cheap function, and unlike an
    // analytic normal it needs no special case at the corners.
    int ignore;
    float e = uBevel * 0.5;
    vec2 g = vec2(
      field(vLocal + vec2(e, 0.0), ignore) - field(vLocal - vec2(e, 0.0), ignore),
      field(vLocal + vec2(0.0, e), ignore) - field(vLocal - vec2(0.0, e), ignore)
    );
    vec3 n = normalize(vec3(normalize(g + 1e-6) * (1.0 - h) * uNormal, h + 0.08));

    // Same two-part curve as the bubble film's (SHELL_FRAGMENT in assets.js),
    // and it has to be, because uPower arrives from CONFIG.bubbleShell: the
    // tiles deliberately wear whatever the trap bubble wears. When that block
    // dropped to a wide soft band, a tile reading only the power would have
    // gone milky right across its face.
    float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), uPower);
    fres = clamp((fres - uBias) / max(1.0 - uBias, 1e-4), 0.0, 1.0);
    vec3 l = normalize(vec3(uLight, 0.8));
    float spec = pow(max(dot(n, l), 0.0), uSpecPower) * uSheen;

    float hot = 0.0;
    float on = 1.0;
    for (int i = 0; i < MAX_CELLS; i++) { if (i == which) { hot = uHot[i]; on = uOn[i]; } }
    if (on <= 0.001) discard;
    vec3 col = mix(uColor, uHotColor, hot);

    // THE HIGHLIGHT IS THE LIGHT'S COLOUR, NOT THE FILM'S — which is the one
    // line that decides whether this reads as a bubble or as a blue tile with a
    // bright patch. A specular is a reflection of the source; tinting it by the
    // surface is what a DIFFUSE term does. It used to be inside the same
    // multiply as the rim, so the sheen came out the colour of the water and
    // the tile had no glass in it anywhere.
    //
    // It also costs nothing and buys the bloom. The bright pass thresholds
    // LUMINANCE, where blue is worth about 7% — so a cold rim at three times
    // its own colour still sits under the line and the button never flares. A
    // white highlight crosses it on its own.
    vec3 lit = col * (1.0 + fres * uRimBoost) + vec3(spec * 3.0);

    // ...AND IT IS A SURFACE, SO IT IS ALSO OPACITY. The film is 84% clear
    // facing you, so brightening a colour nobody can see through was most of
    // why the buttons read as weak: the highlight was there and the thing
    // carrying it was not. A real bubble's catchlight is the one patch of it
    // you cannot see through.
    float alpha = mix(uCoreAlpha, uRimAlpha, fres) + spec;
    gl_FragColor = vec4(lit, a * clamp(alpha, 0.0, 1.0) * uOpacity * on);
  }
`;

// THE LATTICE ITSELF IS NOT DRAWN HERE. It is systems/grid.js — the game's own
// grid, ripples and all — mounted by whoever puts this menu up, with
// CONFIG.grid.spacing set to the same figure the buttons are laid out on. That
// is the only arrangement in which a button can be punched and have the grid
// under it answer: the ripple, its decay and its spring-back are that system's,
// and a second lattice drawn here would be a picture of a grid that nothing can
// disturb.

// THE SAME SHAPE, WRITTEN AS DENSITY. A second material over the same quad,
// sharing the same uniform objects as the one above — so the melt, the squash,
// the pull and the swell are the same numbers and the two can never disagree
// about where the tile is.
//
// What it writes is what a goo particle writes: premultiplied colour in rgb and
// density in alpha, blended additively, so post.js's density pass sums it with
// the droplets and thresholds the lot. That threshold is what fuses them — a
// droplet leaving the tile pulls a neck out of its edge instead of flying off
// in front of it, because as far as the isoline is concerned there was never a
// button and a particle, only a field.
//
// A BAND, NOT A BODY. The density peaks at the outline and falls away on both
// sides, so the goo pass paints a rim around the tile and leaves its middle to
// the fresnel shell — the button keeps its own surface and gains a coat of the
// stuff it is throwing. `gooFill` opens the interior up if you want the tile to
// disappear into the goo entirely, which is the other honest answer to "make it
// blob with the particles" and a different-looking screen.
const densityShader = /* glsl */ `
  #define MAX_CELLS ${MAX_CELLS}
  uniform vec2 uCenter[MAX_CELLS];
  uniform float uRadius[MAX_CELLS];
  uniform vec2 uSquash[MAX_CELLS];
  uniform vec2 uAxis[MAX_CELLS];
  uniform float uMelt[MAX_CELLS];
  uniform float uOn[MAX_CELLS];
  uniform int uCount;
  uniform float uIso;     // the isoline the goo pass will threshold at
  uniform float uBridge;  // how far outside the outline the field still reaches
  uniform float uFill;    // how much density the interior carries, 0..1
  uniform vec3 uColor;
  varying vec2 vLocal;

  float sdHex(vec2 p, float apothem) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * apothem, k.z * apothem), apothem);
    return length(p) * sign(p.y);
  }

  void main() {
    float d = 1e9;
    for (int i = 0; i < MAX_CELLS; i++) {
      if (i >= uCount) break;
      // A button still flickering on is not yet made of anything: its density
      // has to arrive with it, or the goo rim is on screen before the tile is.
      if (uOn[i] <= 0.001) continue;
      vec2 d0 = vLocal - uCenter[i];
      vec2 ax = uAxis[i];
      vec2 local = vec2(dot(d0, ax), dot(d0, vec2(-ax.y, ax.x)));
      local /= max(uSquash[i], vec2(0.05));
      vec2 q = ax * local.x + vec2(-ax.y, ax.x) * local.y;
      float apo = uRadius[i] * 0.866025404;
      float k = apo * clamp(uMelt[i], 0.0, 0.98);
      d = min(d, sdHex(q, apo - k) - k);
    }

    // Exactly the isoline AT the outline, decaying outside so a droplet's own
    // field can sum with it and cross the line between them — which is the
    // neck. Inside, a floor rather than a plateau: the goo pass only paints
    // where density is over the line, so uFill is literally how much of the
    // tile it swallows.
    float outside = uIso * exp(-max(d, 0.0) / max(uBridge, 1e-4));
    float inside = uIso * uFill * clamp(-d / max(uBridge, 1e-4), 0.0, 1.0);
    float dens = max(outside, inside);
    if (dens <= 0.001) discard;
    gl_FragColor = vec4(uColor * dens, dens);
  }
`;

// --- THE ARRANGEMENTS -------------------------------------------------------
//
// Every shape below answers the same question in the same units: given the
// anchor cell the crop asked for, WHICH CELLS does this arrangement use. They
// return `{ col, y }` — a column and a height in ROWSTEPS above the origin
// row — and never a row index, because a row index is not a height on this
// lattice. Odd columns are pushed down half a row, so `row + 1` moves a cell
// a whole step while `col + 1` moves it half a step sideways-and-down, and any
// shape written in row indices has to carry a parity correction at every
// branch. Written in heights they are all one line of arithmetic, and
// `rowAtY` puts the parity back exactly once.
//
// A HEIGHT IN HALVES IS THE WHOLE ALPHABET. The only vertical distances this
// lattice can express are multiples of half a rowStep, and which half a given
// column can reach is decided by its parity — so a shape asking for `y0 + 0.5`
// from a column of the wrong parity is asking for a cell that does not exist,
// and `rowAtY` rounds it to the nearest one that does rather than inventing it.

/** The row index that puts column `col`'s centre at `y` rowSteps up. */
function rowAtY(col, y) {
  return Math.round(y - ((col & 1) ? 0.5 : 0));
}

/** The height of a cell's centre, in rowSteps — the inverse of the above. */
function yOfCell(col, row) {
  return row + ((col & 1) ? 0.5 : 0);
}

/**
 * A TRIANGLE OF CELLS, rows of 1, 2, 3... from the apex.
 *
 * `up` puts the apex at the top and widens downward (▲); false puts it at the
 * bottom (▽). Row j holds j + 1 cells, two columns apart so they share a
 * parity and therefore a height — one column apart is the zigzag the shipped
 * row already avoids for the same reason — and each row sits HALF a rowStep
 * from the last, because a column shifted by one is exactly half a row down.
 * That half-step is what makes the apex touch both cells beneath it instead of
 * floating above the gap between them.
 *
 * The last row is truncated for a count that is not triangular: 3 is the row
 * the screen was composed for (1 + 2), 6 is the next whole one, and 4 or 5
 * simply leave the bottom row short rather than refusing to lay out.
 */
function triangleCells(anchor, n, up) {
  const y0 = yOfCell(anchor.col, anchor.row);
  const out = [];
  for (let j = 0; out.length < n; j++) {
    const y = y0 + (up ? -j : j) / 2;
    for (let i = 0; i <= j && out.length < n; i++) {
      out.push({ col: anchor.col - j + 2 * i, y });
    }
  }
  return out;
}

/**
 * THE TIGHT TRIAD — three cells that all touch, which is as close as three
 * flat-top hexagons can get. Two stacked in one column and one nested in the
 * notch beside them, so the triangle points sideways (`dir` says which way).
 *
 * It is the only arrangement here with no gap in it: the triangle above has
 * its base cells two columns apart, which leaves a cell-shaped hole under the
 * apex. Both are honest hex triangles and they read completely differently —
 * this one is a piece of honeycomb, that one is a constellation.
 *
 * Three only. A fourth cell has nowhere to go that keeps every one of them
 * touching, so anything else falls back to the open triangle.
 */
function trefoilCells(anchor, n, dir) {
  if (n !== 3) return triangleCells(anchor, n, false);
  const y0 = yOfCell(anchor.col, anchor.row);
  return [
    { col: anchor.col, y: y0 },
    { col: anchor.col + dir, y: y0 + 0.5 },
    { col: anchor.col, y: y0 + 1 },
  ];
}

/**
 * THE DIAMOND — four cells, and the only arrangement here that is a COMPASS
 * rather than a list: Play at the top, Options and Leaderboard on the two
 * sides, the tip jar at the bottom. Four flat-top hexagons packed into a
 * rhombus, which is a 2x2 block of the honeycomb and has no hole in it.
 *
 * IT IS THE OPEN TRIANGLE WITH ITS HOLE FILLED. The apex-down triangle's two
 * upper cells are two columns apart, which leaves exactly one cell-shaped gap
 * under them; the fourth button goes in it. That is why the figure did not
 * have to be designed against the lattice — it was already the shape the
 * lattice left over.
 *
 * The order it returns is the order it was ASKED for, top / left / right /
 * bottom, and not the lowest-first rule the other shapes share. On a list, the
 * first item wants to be nearest the thumb; on a compass, it wants to be the
 * one at the top, and which item is where is the whole point of a compass.
 */
function diamondCells(anchor, n) {
  const y0 = yOfCell(anchor.col, anchor.row);
  const c = anchor.col;
  return [
    { col: c, y: y0 + 1 },      // Play
    { col: c - 1, y: y0 + 0.5 }, // Options
    { col: c + 1, y: y0 + 0.5 }, // Leaderboard
    { col: c, y: y0 },           // the tip jar
  ].slice(0, n);
}

/**
 * Cells for an arrangement, IN ITEM ORDER.
 *
 * THE LISTS SHARE ONE ORDERING RULE — LOWEST FIRST, then left to right. The
 * first item is Play and on all of them the lowest cell is nearest both the
 * seal's crown and the thumb; it reproduces the shipped row (one height, so
 * purely left to right) and the column (bottom up) exactly, which is why it
 * can be the only rule those shapes need.
 *
 * THE DIAMOND IS NOT A LIST and orders itself — see the note on it above.
 */
function cellsFor(shape, anchor, n, step) {
  const y0 = yOfCell(anchor.col, anchor.row);
  let cells;
  switch (shape) {
    case 'stack':
      cells = Array.from({ length: n }, (_, i) => ({ col: anchor.col, y: y0 + i }));
      break;
    case 'triUp':
      cells = triangleCells(anchor, n, true);
      break;
    case 'triDown':
      cells = triangleCells(anchor, n, false);
      break;
    case 'trefoil':
      cells = trefoilCells(anchor, n, 1);
      break;
    case 'trefoilLeft':
      cells = trefoilCells(anchor, n, -1);
      break;
    case 'diamond':
      cells = diamondCells(anchor, n);
      break;
    default: {
      // The row, centred on the anchor: three buttons at a step of 2 are
      // columns -2, 0, +2 relative to it.
      const first = anchor.col - Math.round(((n - 1) * step) / 2);
      cells = Array.from({ length: n }, (_, i) => ({ col: first + i * step, y: y0 }));
      break;
    }
  }
  // NOTHING SITS BELOW THE ANCHOR. `rise` means "this far above the crown",
  // and an arrangement whose lowest cell is not its anchor breaks that promise
  // silently: the apex-up triangle's base row is a flipped parity, so it can
  // only reach half-steps, and it comes out half a rowStep INTO the headroom
  // the crop was composed with. Lifted by whole rows, which is the only shift
  // that leaves parity — and therefore the figure's shape — untouched.
  const lift = Math.max(0, Math.ceil(y0 - Math.min(...cells.map((c) => c.y))));
  const placed = cells.map((c) => {
    const y = c.y + lift;
    return { col: c.col, row: rowAtY(c.col, y), y };
  });
  // The lists are sorted into their one rule; the diamond already knows where
  // each of its four buttons goes and sorting it would throw that away.
  if (shape !== 'diamond') placed.sort((a, b) => (a.y - b.y) || (a.col - b.col));
  return placed;
}

/**
 * HOW BIG THE TYPE IN A CELL CAN BE — one scale for every label, from whichever
 * of them needs the tightest fit.
 *
 * Here rather than beside the DOM in mainMenu because it is entirely about the
 * SHAPE OF A HEXAGON, which is this file's subject, and because separated from
 * the elements it can be measured. It takes sizes and returns a number; it
 * touches nothing.
 *
 * A HEXAGON IS ONLY ITS FULL WIDTH ALONG ONE LINE, and fitting to 2R as if it
 * were a box is the mistake this exists to not make. A flat-top cell is 2R
 * across at its vertical centre and narrows from there — the slanted edges give
 * up 1/√3 of horizontal room per unit of height — so a block of type `h` tall
 * and centred has only `2R − h/√3` to sit in. One line gets away with the box
 * assumption; two lines are twice as tall, hang out past the pointed ends, and
 * read as type that has escaped its button.
 *
 * Solved rather than iterated, because the room depends on the scale and the
 * scale depends on the room:
 *
 *   s·w ≤ fill·(2R − s·h/√3)   →   s ≤ fill·2R / (w + fill·h/√3)
 *
 * ONE SCALE FOR ALL OF THEM. Fitted per label, a four-letter word would put
 * four characters across a whole cell and stand at twice the height of a
 * seven-letter one beside it — a fault, not emphasis. Emphasis is `emphasis`,
 * per label, and it is inside the minimum so an emphasised label still has to
 * fit at its own size.
 *
 * @param sizes  one `{ w, h, emphasis }` per label, in px at the type's
 *               authored size. `emphasis` defaults to 1.
 * @param cellPx the cell's full point-to-point width in px (2R).
 * @param opts   `fill` across, `fillTall` down the apothem, `grow` as the cap
 *               on scaling UP — a very wide screen can otherwise blow the
 *               role's size past anything it was ever looked at.
 * @returns the common scale. 1 when there is nothing to measure.
 */
export function fitScale(sizes, cellPx, { fill = 0.85, fillTall = 0.68, grow = 3 } = {}) {
  if (!sizes?.length || !(cellPx > 0)) return 1;
  // Down, it is the APOTHEM: a flat-top cell is 13% shorter than it is wide,
  // and a two-line label is the first thing this menu has ever had that runs
  // out of height before it runs out of width.
  const roomH = cellPx * 0.866 * fillTall;
  let scale = Infinity;
  for (const s of sizes) {
    const e = s.emphasis ?? 1;
    const w = (s.w ?? 0) * e;
    const h = (s.h ?? 0) * e;
    if (w > 0) scale = Math.min(scale, (fill * cellPx) / (w + (fill * h) / Math.sqrt(3)));
    if (h > 0) scale = Math.min(scale, roomH / h);
  }
  return Number.isFinite(scale) ? Math.min(scale, grow) : 1;
}

/**
 * The row of buttons. `items` is one entry per cell — `label`, and `onPress`
 * for what it does, which is the caller's business and not this file's.
 */
export function createHexMenu(items, cfg = CONFIG.splashBust?.menu ?? {}) {
  const count = Math.min(items.length, MAX_CELLS);
  const m = hexMetrics(cfg.latticeSpacing ?? CONFIG.grid?.spacing ?? 2);
  // A hair inside the cell, so the lattice line it sits on still reads around
  // it. At 1.0 the button's edge lands exactly on the grid line and the two
  // annihilate into a slightly thicker line.
  const radius = m.R * (cfg.cellFill ?? 0.94);

  const shell = CONFIG.bubbleShell ?? {};
  const shade = (key, fallback) => cfg[key] ?? shell[key] ?? fallback;

  const uniforms = {
    uCenter: { value: Array.from({ length: MAX_CELLS }, () => new THREE.Vector2()) },
    uRadius: { value: new Array(MAX_CELLS).fill(0) },
    uSquash: { value: Array.from({ length: MAX_CELLS }, () => new THREE.Vector2(1, 1)) },
    uAxis: { value: Array.from({ length: MAX_CELLS }, () => new THREE.Vector2(1, 0)) },
    uMelt: { value: new Array(MAX_CELLS).fill(0) },
    uOn: { value: new Array(MAX_CELLS).fill(0) },
    uHot: { value: new Array(MAX_CELLS).fill(0) },
    uCount: { value: count },
    uBevel: { value: radius * (cfg.bevel ?? 0.32) },
    uPower: { value: shade('power', 2.6) },
    uBias: { value: shade('bias', 0) },
    uCoreAlpha: { value: shade('coreAlpha', 0.16) },
    uRimAlpha: { value: shade('rimAlpha', 0.85) },
    uRimBoost: { value: shade('rimBoost', 1.05) },
    uSheen: { value: shade('sheen', 0.15) },
    uSpecPower: { value: cfg.specPower ?? 16 },
    uNormal: { value: cfg.normal ?? 1.6 },
    uOpacity: { value: cfg.opacity ?? 1 },
    // Where the catchlight sits, in the tile's own frame — up and to the left
    // by default, which is where every lit thing in this game is lit from.
    // A knob rather than a constant because it is the first thing you move once
    // the highlight is white enough to see.
    uLight: { value: new THREE.Vector2(cfg.lightX ?? -0.5, cfg.lightY ?? 0.8) },
    uColor: { value: new THREE.Color(cfg.color ?? 0x2f6f96) },
    uHotColor: { value: new THREE.Color(cfg.hot ?? 0x9fe8ff) },
  };

  /**
   * THE FILM, RE-READ EVERY FRAME.
   *
   * Everything above is seeded once at construction, which is fine for a screen
   * nobody is editing and useless for one somebody is: these are the numbers
   * the Main-menu group in the tuner drives, and a panel whose sliders move
   * nothing until the menu is next mounted is a panel that lies about what it
   * is editing. Same reasoning, and the same wording, as touchGlowForMenu in
   * systems/mainMenu.js.
   *
   * Ten scalar writes and two colour sets on a single-draw material — this is
   * cheaper than the branch that would decide whether to do it.
   *
   * WHAT IS NOT HERE, on purpose: `latticeSpacing`, `colStep` and `cellFill`.
   * Those are the LAYOUT — the quad's size, the cell centres and the row's own
   * width are all derived from them, and the crop the whole screen is composed
   * on is measured against the result (see composeHeld in mainMenu.js). Moving
   * one live would need the menu rebuilt and the shot re-framed, so they stay
   * mount-time and a change to them lands on the next visit to the screen.
   * `bevel` IS live, because it is a fraction of a radius that has not moved.
   */
  function refreshFilm() {
    uniforms.uBevel.value = radius * (cfg.bevel ?? 0.32);
    uniforms.uPower.value = shade('power', 2.6);
    uniforms.uBias.value = shade('bias', 0);
    uniforms.uCoreAlpha.value = shade('coreAlpha', 0.16);
    uniforms.uRimAlpha.value = shade('rimAlpha', 0.85);
    uniforms.uRimBoost.value = shade('rimBoost', 1.05);
    uniforms.uSheen.value = shade('sheen', 0.15);
    uniforms.uSpecPower.value = cfg.specPower ?? 16;
    uniforms.uNormal.value = cfg.normal ?? 1.6;
    uniforms.uOpacity.value = cfg.opacity ?? 1;
    uniforms.uLight.value.set(cfg.lightX ?? -0.5, cfg.lightY ?? 0.8);
    uniforms.uColor.value.set(cfg.color ?? 0x2f6f96);
    uniforms.uHotColor.value.set(cfg.hot ?? 0x9fe8ff);
    // The goo twin's colour follows the hot colour the same way it does at
    // build time, or retuning the tile leaves the rim it squirts behind.
    gooUniforms.uColor.value.set(cfg.gooColor ?? cfg.hot ?? 0x9fe8ff);
    // Mirrors of the construction values, not new arithmetic — the goo group's
    // isoline is what the density pass will threshold at, and a rim written
    // against a different one would be painted at a different width from the
    // droplets it is meant to fuse with.
    gooUniforms.uIso.value = (CONFIG.fx?.goo?.groups?.[cfg.source ?? 'aura']?.iso) ?? 0.32;
    gooUniforms.uBridge.value = cfg.gooBridge ?? 0.35;
    gooUniforms.uFill.value = cfg.gooFill ?? 0;
  }

  // One quad over the whole row, sized off the lattice rather than guessed:
  // the cells are `colStep * step` apart and a cell is `width` across.
  const step = cfg.colStep ?? 2;
  const spanX = m.colStep * step * (count - 1) + m.width;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(spanX + m.width, m.height * 2),
    new THREE.ShaderMaterial({
      vertexShader, fragmentShader, uniforms,
      transparent: true, depthWrite: false, depthTest: false,
      blending: cfg.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }),
  );
  mesh.renderOrder = 100;
  mesh.frustumCulled = false;

  // The density twin. Its own Scene, because post.js renders whatever it is
  // handed straight into the density target — handing it a mesh that is also a
  // child of the main scene would draw the tile into the picture twice.
  const gooUniforms = {
    // The SAME objects, not copies: three uploads whichever material is being
    // drawn, and both read the values the update loop writes once.
    uCenter: uniforms.uCenter,
    uRadius: uniforms.uRadius,
    uSquash: uniforms.uSquash,
    uAxis: uniforms.uAxis,
    uMelt: uniforms.uMelt,
    uOn: uniforms.uOn,
    uCount: uniforms.uCount,
    uIso: { value: (CONFIG.fx?.goo?.groups?.[cfg.source ?? 'aura']?.iso) ?? 0.32 },
    uBridge: { value: cfg.gooBridge ?? 0.35 },
    uFill: { value: cfg.gooFill ?? 0 },
    uColor: { value: new THREE.Color(cfg.gooColor ?? cfg.hot ?? 0x9fe8ff) },
  };
  const gooMesh = new THREE.Mesh(mesh.geometry, new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: densityShader,
    uniforms: gooUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  gooMesh.frustumCulled = false;
  const gooScene = new THREE.Scene();
  gooScene.add(gooMesh);

  /**
   * Re-cut the plane to cover wherever layout() actually put the cells, with a
   * full cell of margin on every side — the bevel, the rim and the goo all
   * bleed outside a tile's own hexagon, and a quad cut to the centres' box
   * alone shears that bleed off in a straight line.
   *
   * `vLocal` is `position.xy`, so the plane's size changes the AREA the shader
   * covers and nothing about the mapping — the cell centres it reads are world
   * units either way. That is what makes this safe to redo on a resize.
   *
   * Both meshes share the one geometry, so both are reassigned and the old one
   * is disposed: a rotation every few seconds would otherwise leak a buffer per
   * turn.
   */
  function resizeQuad(centres) {
    const xs = centres.map((c) => c.x);
    const ys = centres.map((c) => c.y);
    const w = (Math.max(...xs) - Math.min(...xs)) + m.width * 2;
    const h = (Math.max(...ys) - Math.min(...ys)) + m.height * 2;
    const p = mesh.geometry.parameters;
    if (p && Math.abs(p.width - w) < 1e-4 && Math.abs(p.height - h) < 1e-4) return;
    const next = new THREE.PlaneGeometry(w, h);
    mesh.geometry.dispose();
    mesh.geometry = next;
    gooMesh.geometry = next;
  }

  const state = items.slice(0, count).map((item, i) => ({
    label: item.label ?? String(item),
    // The label broken over more than one line, when the caller says so. It is
    // the SAME string — a place to break, not different words — and it is here
    // rather than in the label because everything that is not the type reads
    // `label` and would have to strip a newline out of it (press and release
    // both return it, and the sound bus keys off it).
    lines: Array.isArray(item.lines) && item.lines.length ? item.lines.slice() : null,
    // The primary button. A fact about the menu rather than about index 0, so
    // a menu that reorders does not emphasise whatever lands first. What it
    // buys is in mainMenu (bigger, heavier, a louder hover) and one thing
    // here: the tile under it lights harder.
    lead: !!item.lead,
    onPress: item.onPress ?? null,
    index: i,
    hover: 0,
    // Seconds since this button began arriving. See the flicker in update().
    intro: 0,
    squish: -1,
    // 0..1 of a press being HELD. Named for what the game calls the same thing
    // on the seal (CONFIG.strike.charge) because it is the same gesture: hold
    // to build, release to spend.
    charge: 0,
    drip: 0,
    // THE SLINGSHOT. `offset` is how far the tile has been dragged out of its
    // cell and `vel` is what carries it home — a damped spring, the same shape
    // as the one systems/boneSpring.js runs on the tail (an impulse goes
    // straight into the velocity and the spring does the rest), written out
    // here because that module speaks only in quaternions along a bone chain.
    offset: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    // Where the pointer had it while the press was live, in world units.
    pull: { x: 0, y: 0 },
    pulled: false,
    cell: { col: 0, row: 0 },
    local: { x: 0, y: 0 },
    home: { x: 0, y: 0 },
    world: new THREE.Vector3(),
    radius,
  }));

  const _at = { x: 0, y: 0 };

  return {
    mesh,
    // Hand this to post.js's registerGooField to make the buttons part of the
    // goo. Nothing else should add it to a scene — see the note above.
    gooField: gooScene,
    items: state,
    metrics: m,
    radius,
    // Which arrangement is currently laid out — written by layout(), read by
    // whoever mounted the menu so a resize can tell a reshape from a reframe.
    shape: 'row',

    /**
     * Does this viewport want a portrait arrangement rather than the row?
     * Measured on the WINDOW and not on the frame, because the frame is
     * composed from what this returns — asking the other way round is a loop.
     *
     * The threshold is an aspect, not a width. A phone held upright is ~0.46
     * and a laptop is ~1.7, so anything under about three-quarters is a screen
     * with height to spare and no width, which is exactly the trade every
     * portrait arrangement makes.
     *
     * WHY THE ROW CANNOT BE RESCUED BY FRAMING, since "just zoom out" is the
     * obvious answer and it is wrong. At 375x812 every unit of width the
     * buttons need costs 2.2 units of HEIGHT. Three cells in a row span ~4.6
     * units across, which forces a frame ~10 tall around a bust that is 1.6 —
     * the animal the screen is built around ends up a sixth of it. Shrinking
     * the lattice instead puts "LEADERBOARD" inside 58px of hexagon. Every
     * arrangement `portraitShape` can name is under 3 units wide, which is the
     * entire point of having them.
     */
    wantsShape() {
      if (typeof cfg.shape === 'string') return cfg.shape;
      const w = globalThis.innerWidth ?? 0;
      const h = globalThis.innerHeight ?? 0;
      if (!w || !h) return 'row';
      return w / h < (cfg.portraitBelowAspect ?? 0.75)
        ? (cfg.portraitShape ?? 'triDown')
        : 'row';
    },

    /**
     * SNAP THE ARRANGEMENT TO REAL CELLS. The wanted position — above the
     * crown of the measured bust — is only a hint: it is turned into a lattice
     * cell with hexCellAt and every button is then addressed as (col, row), so
     * the buttons land on the grid rather than near it.
     *
     * WHICH cells is `cellsFor` above, one arrangement per shape, and which
     * shape is `wantsShape` unless the caller names one — the look page does,
     * which is the only way to see them side by side.
     */
    layout(box, opts = {}) {
      const wantX = (box.min.x + box.max.x) / 2 + (cfg.offsetX ?? 0);
      const wantY = box.max.y + (cfg.rise ?? 0.62);
      const anchor = hexCellAt(wantX, wantY, m);
      // A null here means the wanted point was not a number, which in practice
      // means the box it came from is empty — a model that failed to load, and
      // a measureBust over nothing. Worth saying out loud: the raw failure is
      // "Cannot read properties of null (reading 'col')" three frames later,
      // which sends you looking at the lattice instead of at the network tab.
      if (!anchor) {
        console.warn('[hexMenu] no lattice cell for the wanted position — is the bust box empty?');
        return this;
      }
      this.shape = opts.shape ?? this.wantsShape();
      const cells = cellsFor(this.shape, anchor, count, step);
      const centres = cells.map((c) => hexCenter(c.col, c.row, m));
      // THE QUAD IS SIZED FROM THE CENTRES, not from the row's arithmetic. The
      // construction-time `spanX` assumes one row and would leave a triangle's
      // upper cells outside the plane the shader draws on — which does not
      // error, it just clips the buttons off at the quad's edge and looks like
      // the lattice ate them.
      resizeQuad(centres);
      const midX = (Math.min(...centres.map((c) => c.x)) + Math.max(...centres.map((c) => c.x))) / 2;
      const midY = (Math.min(...centres.map((c) => c.y)) + Math.max(...centres.map((c) => c.y))) / 2;
      mesh.position.set(midX, midY, cfg.z ?? 1);
      gooMesh.position.copy(mesh.position);
      for (let i = 0; i < count; i++) {
        state[i].cell = { col: cells[i].col, row: cells[i].row };
        // Two frames for the same point: `local` is the quad's own space, which
        // is what the shader wants, and `home` is the world, which is what the
        // hit test and the emitters want. The offset is added to both every
        // frame — keeping the rest position apart from the live one is what
        // lets a tile be dragged and still know where it belongs.
        state[i].local = { x: centres[i].x - midX, y: centres[i].y - midY };
        state[i].home = { x: centres[i].x, y: centres[i].y };
        uniforms.uCenter.value[i].set(state[i].local.x, state[i].local.y);
        state[i].world.set(centres[i].x, centres[i].y, mesh.position.z);
      }
      return this;
    },

    /**
     * Which button a world point is in. The hex's own inradius, not a circle
     * around it: the corners of a flat-top hex are 15% further out than its
     * flats, and a circular test either loses the corners or claims the gaps
     * between cells.
     */
    pick(point) {
      for (const s of state) {
        const dx = Math.abs(point.x - s.world.x);
        const dy = Math.abs(point.y - s.world.y);
        const R = s.radius;
        if (dx > R || dy > R * 0.866) continue;
        // The three half-plane tests a flat-top hexagon is the intersection of.
        if (dy <= R * 0.866 && dx * 0.866 + dy * 0.5 <= R * 0.866) return s.index;
      }
      return -1;
    },

    /**
     * FULL SQUISH, and the substance that comes with it. Goo particles are only
     * drawn while post.js is compositing (the density pass lives inside it), so
     * anywhere that is bypassed the bubbles arrive and the goo silently does
     * not — worth knowing before calling the burst broken.
     */
    press(index) {
      const s = state[index];
      if (!s) return null;
      s.squish = 0;
      s.charge = 0;
      _at.x = s.world.x;
      _at.y = s.world.y;
      // The click's own burst — bits, thrown small and close. What a HELD press
      // adds is in release() below, and it is a different event rather than a
      // bigger version of this one.
      emit(cfg.clickGoo ?? 'menuGooBurst', _at.x, _at.y, { scale: cfg.clickScale ?? 0.6 });
      emit(cfg.clickBubbles ?? 'menuBubbleBurst', _at.x, _at.y, { scale: cfg.clickScale ?? 0.6 });
      return s.label;
    },

    /**
     * Hold. `held` is seconds since the press landed; `cursor` is where the
     * pointer is now, in world units, which is what makes a held press a PULL.
     */
    hold(index, held, cursor = null) {
      const s = state[index];
      if (!s) return 0;
      s.charge = Math.min(1, held / Math.max(0.05, cfg.chargeTime ?? 0.9));
      if (cursor) {
        // A fraction of the drag, capped: the tile follows the pointer without
        // ever leaving the neighbourhood of its own cell, so the grid it
        // belongs to still reads while it is being stretched out of it.
        const dx = cursor.x - s.world.x;
        const dy = cursor.y - s.world.y;
        const gain = cfg.pullGain ?? 0.55;
        const max = cfg.pullMax ?? 0.6;
        const len = Math.hypot(dx, dy) * gain;
        const k = len > max ? max / Math.max(len, 1e-6) : 1 / Math.max(1, 1);
        s.pull.x = dx * gain * (len > max ? max / len : 1);
        s.pull.y = dy * gain * (len > max ? max / len : 1);
        s.pulled = true;
      }
      return s.charge;
    },

    /**
     * LET GO. Returns what the release is worth, for the caller to spend on the
     * world: `{ label, index, x, y, charge, strength, radius }`, or null for a
     * release with nothing banked.
     *
     * THE IMPULSE IS NOT FIRED HERE, and that is deliberate. What a charged
     * press disturbs is the LATTICE, which belongs to systems/grid.js and is
     * mounted by the caller — a menu that reached into the grid itself would be
     * a menu that cannot be put on a screen which has no grid.
     */
    release(index) {
      const s = state[index];
      if (!s) return null;
      const charge = s.charge;
      s.charge = 0;
      s.squish = 0;
      s.onPress?.(s.label, index, charge);
      if (charge < (cfg.chargeMin ?? 0.15)) return null;
      // Scaled by the charge SQUARED for the goo: a half-held press should read
      // as most of the way to nothing, not as half a spray.
      emit(cfg.burstGoo ?? 'menuGooBurst', s.world.x, s.world.y, { scale: 0.6 + charge * charge * 1.6 });
      emit(cfg.burstBubbles ?? 'menuBubbleBurst', s.world.x, s.world.y, { scale: 0.6 + charge * charge * 1.6 });
      // THE SLINGSHOT. Let go and the tile is thrown the way a pulled thing is:
      // back through its own cell and out the other side, with the spring
      // catching it. The velocity is the pull REVERSED, which is the whole
      // gesture — pull back to shoot forward.
      const pullX = s.pull.x;
      const pullY = s.pull.y;
      const sling = cfg.slingGain ?? 6;
      s.vel.x = -pullX * sling;
      s.vel.y = -pullY * sling;
      s.pulled = false;
      s.pull.x = 0;
      s.pull.y = 0;

      return {
        label: s.label,
        index,
        x: s.world.x,
        y: s.world.y,
        // Where it was dragged to, and how far — the caller spends this on the
        // lattice so the grid is punched from where the tile actually was.
        pullX,
        pullY,
        pull: Math.hypot(pullX, pullY),
        charge,
        // Linear in the charge, unlike the goo: this is a shove into a spring,
        // and the grid's own decay is what shapes how it reads.
        strength: (cfg.impulseStrength ?? 2.6) * charge,
        radius: (cfg.impulseRadius ?? 5) * (0.6 + 0.4 * charge),
      };
    },

    /**
     * @param cursor  where the pointer is, in world units, or null. It does two
     *   things: the goo leaves from the side of the tile the pointer is on
     *   rather than from a random point on the rim, and a held press pulls the
     *   tile toward it (see hold()). Both are the same idea — the force has a
     *   place it is coming from, and everything the tile does should agree
     *   about where that is.
     */
    /**
     * 0..1 of a button's arrival. The DOM labels ride this, so the type
     * flickers on with its tile instead of sitting there waiting for it.
     */
    onLevel(index) {
      return uniforms.uOn.value[index] ?? 1;
    },

    /** Play the arrival again — the screen coming up, or coming back. */
    replayIntro() {
      for (const s of state) s.intro = 0;
      return this;
    },

    update(dt, hovered = -1, cursor = null) {
      refreshFilm();
      const t = 1 - Math.exp(-(cfg.easeRate ?? 9) * dt);
      const grow = cfg.hoverScale ?? 1.06;

      for (const s of state) {
        // --- arriving --------------------------------------------------------
        // A stutter that settles: while the button is coming on it is either
        // fully there or not there at all, `introBlinks` times, with the gaps
        // shortening — then it holds. Blinking rather than fading because a
        // fade reads as a slow machine and a flicker reads as a light finding
        // itself, and the second one is what a title card wants.
        //
        // Driven off the index, not off Math.random: the screen comes up the
        // same way every load, which is the difference between a flourish and
        // a fault.
        const step = cfg.introStep ?? 0.18;
        const span = cfg.introTime ?? 0.75;
        const blinks = Math.max(1, Math.round(cfg.introBlinks ?? 4));
        s.intro += dt;
        const local = s.intro - s.index * step;
        let on = 1;
        if (local <= 0) {
          on = 0;
        } else if (local < span) {
          // Each blink is shorter than the last, so the gaps close up into a
          // steady light instead of ending on an arbitrary frame.
          const p = local / span;
          const phase = Math.floor(blinks * p * p);
          on = phase % 2 === 0 ? 0.35 + 0.65 * p : 1;
        }
        uniforms.uOn.value[s.index] = on;

        s.hover += ((s.index === hovered ? 1 : 0) - s.hover) * t;

        // A damped wobble read with COSINE, so the flattening lands on the
        // frame of the press rather than a quarter-cycle later.
        let sx = 1;
        let sy = 1;
        if (s.squish >= 0) {
          s.squish += dt;
          const env = Math.exp(-(cfg.squishDecay ?? 5.5) * s.squish);
          const wob = Math.cos(s.squish * (cfg.squishHz ?? 6.5) * Math.PI * 2) * env;
          const amp = cfg.squishAmount ?? 0.34;
          sx = 1 + amp * wob;
          sy = 1 - amp * wob * 0.86;
          if (env < 0.01) s.squish = -1;
        }
        const idle = (cfg.hoverWobble ?? 0.03) * s.hover
          * Math.sin(performance.now() / 1000 * (cfg.hoverHz ?? 1.7) * Math.PI * 2 + s.index);

        // --- the pull, and the spring that ends it --------------------------
        // While the press is live the offset is DRIVEN — the tile is being held
        // out of its cell and a spring fighting the hand would only make the
        // drag feel soft. The spring takes over at release, from wherever the
        // hand left it and with the sling velocity already in `vel`.
        if (s.pulled) {
          s.offset.x += (s.pull.x - s.offset.x) * (1 - Math.exp(-(cfg.pullLerp ?? 22) * dt));
          s.offset.y += (s.pull.y - s.offset.y) * (1 - Math.exp(-(cfg.pullLerp ?? 22) * dt));
          s.vel.x = 0;
          s.vel.y = 0;
        } else if (s.offset.x || s.offset.y || s.vel.x || s.vel.y) {
          // A damped spring toward the cell, integrated semi-implicitly: the
          // velocity is updated first and the position uses the NEW velocity,
          // which is what keeps a stiff spring stable at 60fps instead of
          // walking itself apart the first time someone drags a long way.
          const k = cfg.springK ?? 140;
          const c = cfg.springDamp ?? 11;
          s.vel.x += (-k * s.offset.x - c * s.vel.x) * dt;
          s.vel.y += (-k * s.offset.y - c * s.vel.y) * dt;
          s.offset.x += s.vel.x * dt;
          s.offset.y += s.vel.y * dt;
          if (Math.abs(s.offset.x) < 1e-4 && Math.abs(s.offset.y) < 1e-4
            && Math.abs(s.vel.x) < 1e-3 && Math.abs(s.vel.y) < 1e-3) {
            s.offset.x = 0; s.offset.y = 0; s.vel.x = 0; s.vel.y = 0;
          }
        }
        uniforms.uCenter.value[s.index].set(s.local.x + s.offset.x, s.local.y + s.offset.y);
        s.world.set(s.home.x + s.offset.x, s.home.y + s.offset.y, mesh.position.z);

        // --- squash and stretch, along the force's own axis ------------------
        // A pulled tile stretches ALONG the pull and pinches across it, which is
        // the whole reason the shader takes an axis: the force comes from where
        // the pointer is, and a squash that could only act on x and y would
        // flatten a diagonal drag sideways.
        const off = Math.hypot(s.offset.x, s.offset.y);
        if (off > 1e-4) {
          uniforms.uAxis.value[s.index].set(s.offset.x / off, s.offset.y / off);
          const stretch = Math.min(cfg.stretchMax ?? 0.5, off * (cfg.stretchGain ?? 0.9));
          sx *= 1 + stretch;
          sy *= 1 - stretch * 0.55;
        } else {
          uniforms.uAxis.value[s.index].set(1, 0);
        }
        uniforms.uSquash.value[s.index].set(sx + idle, sy - idle);

        // HOW MUCH OF A HEX IT STILL IS. The tile softens toward the stuff it
        // is about to spit: a little under the pointer, more as a press charges,
        // and most of all in the moment it is squished — which is exactly when
        // the goo is leaving, so the shape and the substance agree about what
        // just happened. It re-forms into its cell as everything decays, so the
        // grid is never left with a puddle sitting in it.
        const squishNow = s.squish >= 0 ? Math.exp(-(cfg.squishDecay ?? 5.5) * s.squish) : 0;
        const pullMelt = Math.min(1, off / Math.max(1e-4, cfg.pullMax ?? 0.6));
        uniforms.uMelt.value[s.index] = Math.min(cfg.meltMax ?? 0.85, Math.max(
          s.hover * (cfg.meltHover ?? 0.12),
          s.charge * (cfg.meltCharge ?? 0.45),
          squishNow * (cfg.meltSquish ?? 0.7),
          pullMelt * (cfg.meltPull ?? 0.5),
        ));

        // A TILE THAT OUTGROWS ITS CELL HAS LEFT THE GRID. So size is barely a
        // channel here: the hover is a BRIGHTEN (see uHot below), the charge
        // leans on it a little, and the squish does the rest.
        s.radius = radius * (1 + (grow - 1) * s.hover) * (1 + ((cfg.chargeGrow ?? 1.06) - 1) * s.charge);
        uniforms.uRadius.value[s.index] = s.radius;
        // Three claims on the same channel, and the loudest wins rather than
        // summing — a charged press on a hovered tile is one event, and adding
        // them would blow the tint past its own hot colour.
        uniforms.uHot.value[s.index] = Math.max(
          s.hover * (cfg.hoverHot ?? 0.35) * (s.lead ? (cfg.label?.leadHot ?? 1) : 1),
          s.charge * (cfg.chargeHot ?? 1),
          s.squish >= 0 ? Math.exp(-3 * s.squish) : 0,
        );

        // THE CHARGE ALONE. Hovering used to dribble too, which meant the
        // screen was leaking goo the whole time a cursor was anywhere near it —
        // a menu should not look like it is melting until you press it. So the
        // leak is the wind-up's own tell, and nothing else emits.
        const leak = s.charge * (cfg.chargeLeak ?? 2.5);
        if (leak > 0.2) {
          s.drip -= dt * leak;
          if (s.drip <= 0) {
            s.drip = 1 / Math.max(0.1, cfg.dripRate ?? 5.5);
            // Along the hex's own EDGE rather than on a circle around it, or a
            // third of the dribbles start in the air outside the tile.
            // TOWARD THE POINTER, not anywhere. The goo is being squeezed out
            // by something, and that something has a position — a dribble
            // leaving the far side of a tile the cursor is pressing reads as
            // the tile leaking rather than as the press doing it. Spread around
            // that direction so it is a spurt and not a jet.
            const toward = cursor
              ? Math.atan2(cursor.y - s.world.y, cursor.x - s.world.x)
              : Math.random() * Math.PI * 2;
            const a = toward + (Math.random() - 0.5) * (cfg.dripSpread ?? 1.6);
            const rEdge = s.radius * 0.866 / Math.max(0.5, Math.cos(((a % (Math.PI / 3)) - Math.PI / 6)));
            _at.x = s.world.x + Math.cos(a) * rEdge * 0.95;
            _at.y = s.world.y + Math.sin(a) * rEdge * 0.95;
            emit(cfg.dripGoo ?? 'menuGoo', _at.x, _at.y, { dirX: Math.cos(a), dirY: Math.sin(a) });
            if (Math.sin(a) > -0.2) {
              emit(cfg.dripBubbles ?? 'menuBubbles', _at.x, _at.y, { dirX: Math.cos(a), dirY: Math.abs(Math.sin(a)) });
            }
          }
        }
      }
    },
  };
}
