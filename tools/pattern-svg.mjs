#!/usr/bin/env node
// ---------------------------------------------------------------------------
// node --import ./tools/vite-loader.mjs tools/pattern-svg.mjs [outDir]
//
// The game's two line lattices as plain SVG — strokes only, transparent
// ground — so they can be used as art outside the renderer:
//
//   hex-lattice.svg          the backdrop grid (systems/grid.js) over the
//                            whole arena frame, at CONFIG.grid.spacing
//   hex-lattice-tile.svg     one seamless period of the same lattice
//                            (2 columns wide, 1 row tall) for tiling
//   constellations-rest.svg  the night sky's links + fractals as drawn with no
//                            food chain live
//   constellations-full.svg  every link the deepest chain would light
//   constellations-fractal.svg  the branches alone
//
// Positions come from the same modules the game draws with (hexLattice.js,
// buildConstellationField), with saved tuning merged, so what comes out is
// the shipped pattern rather than a lookalike.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import { hexMetrics, hexCorners, hexCellsIn } from '../path/src/systems/hexLattice.js';
import { buildConstellationField } from '../path/src/systems/constellations.js';
import { chainReachAt } from '../path/src/systems/constellationReach.js';

const outDir = process.argv[2] ?? 'design/patterns';
fs.mkdirSync(outDir, { recursive: true });

const PX = 40;          // px per world unit
const STROKE = 2;       // px
const COLOR = '#ffffff';

// world rect -> svg, y flipped
function svgDoc(rect, body, { w, h } = {}) {
  const W = w ?? Math.round((rect.right - rect.left) * PX);
  const H = h ?? Math.round((rect.top - rect.bottom) * PX);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<g fill="none" stroke="${COLOR}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">
${body}
</g>
</svg>
`;
}

const f = (n) => Number(n.toFixed(2));

// Unique edges of the lattice covering `rect`, as one path. Shared edges are
// drawn once, which matters for any consumer that lowers the stroke alpha.
function hexEdgesPath(rect, m, sx, sy) {
  const seen = new Set();
  const key = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  let d = '';
  for (const cell of hexCellsIn(rect, m, 0)) {
    const c = hexCorners(cell.x, cell.y, m.R);
    for (let k = 0; k < 6; k++) {
      const a = c[k], b = c[(k + 1) % 6];
      const ka = key(a), kb = key(b);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(ek)) continue;
      seen.add(ek);
      d += `M${f((a[0] - rect.left) * sx)} ${f((rect.top - a[1]) * sy)}L${f((b[0] - rect.left) * sx)} ${f((rect.top - b[1]) * sy)}`;
    }
  }
  return `<path d="${d}"/>`;
}

const written = [];
function write(name, svg) {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, svg);
  written.push(`${p}  (${(svg.length / 1024).toFixed(0)} KB)`);
}

// --- the hex lattice -------------------------------------------------------
const spacing = Math.max(0.5, CONFIG.grid.spacing);
const m = hexMetrics(spacing);

{
  const rect = { left: bounds.left, right: bounds.right, bottom: bounds.bottom, top: bounds.top };
  write('hex-lattice.svg', svgDoc(rect, hexEdgesPath(rect, m, PX, PX)));
}

{
  // One period: 2 columns (3R) by 1 row (√3 R). Rendered as an integer-pixel
  // box so it tiles exactly; the sub-percent stretch is invisible.
  const wUnits = 2 * m.colStep;
  const hUnits = m.rowStep;
  const H = 512;
  const W = Math.round(H * wUnits / hUnits);
  const rect = { left: 0, right: wUnits, bottom: 0, top: hUnits };
  const body = hexEdgesPath(rect, m, W / wUnits, H / hUnits);
  write('hex-lattice-tile.svg', svgDoc(rect, body, { w: W, h: H }));
}

// --- the night sky ---------------------------------------------------------
const cfg = CONFIG.constellations;
const field = buildConstellationField(cfg, bounds);
const rect = field.rect;
const rest = chainReachAt(0, cfg);

const edgePath = (edges) => {
  let d = '';
  for (const e of edges) {
    d += `M${f((e.x1 - rect.left) * PX)} ${f((rect.top - e.y1) * PX)}L${f((e.x2 - rect.left) * PX)} ${f((rect.top - e.y2) * PX)}`;
  }
  return `<path d="${d}"/>`;
};
const span = (e) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
const links = field.edges.filter((e) => e.gen === 0);
const fractal = field.edges.filter((e) => e.gen > 0);
const resting = links.filter((e) => span(e) <= rest.radius && (e.rank ?? 0) < rest.links);

write('constellations-rest.svg', svgDoc(rect, edgePath([...resting, ...fractal])));
write('constellations-full.svg', svgDoc(rect, edgePath(field.edges)));
write('constellations-fractal.svg', svgDoc(rect, edgePath(fractal)));

console.log(`hex spacing ${spacing} (R ${m.R.toFixed(3)}), sky rect ${JSON.stringify(rect)}`);
console.log(`stars ${field.counts.stars}, links ${links.length} (resting ${resting.length}), branches ${fractal.length}`);
for (const w of written) console.log(w);
