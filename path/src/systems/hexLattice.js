// The hex lattice, kept in one place so anything that wants to sit ON the hex
// grid derives its positions from the same numbers the grid draws with. That
// is the whole point of this module: hex art lines up with the backdrop
// because both read `hexMetrics()`, not because two files happen to agree.
//
// Orientation is FLAT-TOP, matching the level-up card art (design/assets/*.webp)
// — see ART_HEX below.

const SQRT3 = Math.sqrt(3);

// `spacing` is the same tuner value the square grid uses, mapped so the two
// patterns read as the same density: a flat-top hex whose flat-to-flat height
// equals `spacing` puts its horizontal rows exactly where the square grid's
// rows were, so toggling between them is a fair A/B instead of a size change.
export function hexMetrics(spacing) {
  const R = Math.max(0.05, spacing) / SQRT3; // centre -> corner
  return {
    R,
    width: 2 * R,        // point to point, horizontally
    height: SQRT3 * R,   // flat to flat, vertically (== spacing)
    colStep: 1.5 * R,    // horizontal distance between column centres
    rowStep: SQRT3 * R,  // vertical distance between centres in one column
  };
}

// Centre of the cell at (col, row). Odd columns are pushed down half a row —
// the standard flat-top offset layout.
export function hexCenter(col, row, m) {
  return {
    x: col * m.colStep,
    y: row * m.rowStep + (col & 1 ? m.rowStep / 2 : 0),
  };
}

// The 6 corners of a flat-top hex, starting at the right-hand point and going
// counter-clockwise.
export function hexCorners(cx, cy, R) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k;
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return pts;
}

// Which cell a world point falls in. A 3x3 block of candidates around the
// arithmetic guess is always enough — the answer is the nearest centre, and no
// centre outside that block can be nearer than the ones inside it.
export function hexCellAt(x, y, m) {
  const guess = Math.round(x / m.colStep);
  let best = null;
  let bestD = Infinity;
  for (let col = guess - 1; col <= guess + 1; col++) {
    const shift = col & 1 ? m.rowStep / 2 : 0;
    const rowGuess = Math.round((y - shift) / m.rowStep);
    for (let row = rowGuess - 1; row <= rowGuess + 1; row++) {
      const c = hexCenter(col, row, m);
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bestD) { bestD = d; best = { col, row }; }
    }
  }
  return best;
}

// The six cells touching (col, row), found by distance rather than by a
// per-parity neighbour table — the 3x3 block always contains all six, and
// taking the six nearest of it cannot pick the wrong ones.
export function hexRing(col, row, m) {
  const centre = hexCenter(col, row, m);
  const near = [];
  for (let c = col - 1; c <= col + 1; c++) {
    for (let r = row - 1; r <= row + 1; r++) {
      if (c === col && r === row) continue;
      const p = hexCenter(c, r, m);
      near.push({ col: c, row: r, d: (p.x - centre.x) ** 2 + (p.y - centre.y) ** 2 });
    }
  }
  near.sort((a, b) => a.d - b.d);
  return near.slice(0, 6);
}

// Where the drawn hexagon actually sits inside a design/assets/*.webp tile, as
// fractions of the (square) canvas. These are the same numbers the level-up
// card's clip-path uses — measured off the art itself, see the note above
// `.sv-card` in design/styles.css. The art is NOT a perfectly regular hexagon,
// which is exactly why the tile layer has to read these rather than assume:
// the corners are slightly inset from where a regular hex of that flat edge
// would put them.
export const ART_HEX = {
  leftX: 0.057,   // left point
  rightX: 0.939,  // right point
  topY: 0.127,    // top flat edge
  bottomY: 0.896, // bottom flat edge
};

// How to place one of those tiles so its drawn hexagon lands exactly on a
// lattice cell: scale the plane so the art's hex spans the cell, then shift it
// so the art's hex CENTRE (which is a hair off the canvas centre) lands on the
// cell centre. Both axes are solved independently, so the drawn edges sit on
// the drawn grid lines on all six sides — at the cost of stretching the art by
// the ~0.7% it is off regular, which is well under a pixel at play size.
export function hexTileTransform(m) {
  const artW = ART_HEX.rightX - ART_HEX.leftX;
  const artH = ART_HEX.bottomY - ART_HEX.topY;
  const planeW = m.width / artW;
  const planeH = m.height / artH;
  // Art hex centre in UV, converted to a world offset from the plane's centre.
  // v runs top-down while world y runs bottom-up, hence the flip on y.
  const cu = (ART_HEX.leftX + ART_HEX.rightX) / 2;
  const cv = (ART_HEX.topY + ART_HEX.bottomY) / 2;
  return {
    planeW,
    planeH,
    // Add these to a cell centre to get where the plane's centre goes.
    offsetX: -(cu - 0.5) * planeW,
    offsetY: -(0.5 - cv) * planeH,
  };
}

// Every cell whose centre could put any part of its hex inside `rect`, plus
// `margin` world units of overscan so a warped edge never reveals the end of
// the lattice.
export function hexCellsIn(rect, m, margin = 0) {
  const left = rect.left - margin - m.width;
  const right = rect.right + margin + m.width;
  const bottom = rect.bottom - margin - m.height;
  const top = rect.top + margin + m.height;

  const cells = [];
  const colMin = Math.floor(left / m.colStep);
  const colMax = Math.ceil(right / m.colStep);
  for (let col = colMin; col <= colMax; col++) {
    const shift = col & 1 ? m.rowStep / 2 : 0;
    const rowMin = Math.floor((bottom - shift) / m.rowStep);
    const rowMax = Math.ceil((top - shift) / m.rowStep);
    for (let row = rowMin; row <= rowMax; row++) {
      const c = hexCenter(col, row, m);
      cells.push({ col, row, x: c.x, y: c.y });
    }
  }
  return cells;
}
