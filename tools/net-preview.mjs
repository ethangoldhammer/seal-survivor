#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run net:look
//
// A filmstrip of the twine, straight out of the sim, as SVG.
//
// The mesh is FLAT — every node is a 2D point and every strand a straight line
// between two of them — so the whole thing renders with no GL at all, which is
// the only way to look at it in this environment: the browser pane suspends
// requestAnimationFrame, so a page carrying the real net renders one frozen
// frame of a sim that never stepped.
//
// It is a geometry preview, not a look preview. The strands are stroked with
// the same base/hot colours and the same warp mix the fragment shader uses, so
// the heat is honest, but nothing here is additive and nothing blooms — the
// game draws this over water with a bright pass on top of it.
//
//   node --import ./tools/vite-loader.mjs tools/net-preview.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  createBakalarNet, updateBakalarNet, setBakalarNetVisible, seatBakalarNet,
  kickBakalarNet, __netState,
} from '../path/src/systems/bakalarNet.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
// THE NET AT ONE STACK, in the game's own numbers.
//
// Written out rather than read from netGeometry(), and that is not laziness:
// the mouth is the MEASURED width of the built boat, and no boat model loads
// in Node — netGeometry here would answer with the procedural fallback's 3.4
// and draw a picture of a net the game never hangs. These two come off the
// real thing (hull 9.00 wide x netWidthFraction, and CONFIG.bakalar.netDepth),
// so a retune of either wants them re-measured on the look page.
const F = { centerX: 0, top: 0, halfWidth: 8.28 / 2, depth: 14.5 };
// ...and at eight, where the stack has bought depth and nothing else.
const DEEP = 34.8;

createBakalarNet(scene);
setBakalarNetVisible(true);
// RE-READ PER PANEL, never cached. The row count follows the net's depth and a
// change to it REBUILDS the lattice — new geometry, new index buffer, new node
// arrays — so a panel drawn from an index captured at the top of the file
// renders the previous net's strand list against the current net's positions.
// The full-stack panel came out as a short net with two fish floating below it.
const strandIndex = () => scene.children.find((o) => o.isLineSegments).geometry.getIndex().array;

const hex = (n) => '#' + n.toString(16).padStart(6, '0');
function mixHex(a, b, t) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return '#' + ca.lerp(cb, Math.min(1, Math.max(0, t))).getHexString();
}

// One panel: seat, run `pre` seconds, then run `secs` with these loads.
function frame(title, { loads = [], tow = 0, blastAt = null, pre = 2.5, secs = 1.5 }) {
  seatBakalarNet(F.centerX, F.top, F.halfWidth, F.depth);
  const f = { ...F };
  const run = (t) => {
    for (let i = 0; i < Math.round(t / dt); i++) {
      f.centerX += tow * dt;
      const live = loads.map((l) => ({ ...l, x: l.x + (f.centerX - F.centerX) }));
      updateBakalarNet(dt, f, live, live.length);
    }
  };
  run(pre);
  if (blastAt) kickBakalarNet(blastAt.x + (f.centerX - F.centerX), blastAt.y, CONFIG.bakalar.net.blastKick, blastAt.r);
  run(secs);

  const s = __netState();
  const index = strandIndex();
  const c = CONFIG.bakalar.net;
  const hx = (F.halfWidth * 2) / (s.cols - 1);
  const strands = [];
  for (let k = 0; k < index.length; k += 2) {
    const a = index[k], b = index[k + 1];
    const wa = Math.hypot(s.cur[a * 2] - s.rest[a * 2], s.cur[a * 2 + 1] - s.rest[a * 2 + 1]) / hx;
    const wb = Math.hypot(s.cur[b * 2] - s.rest[b * 2], s.cur[b * 2 + 1] - s.rest[b * 2 + 1]) / hx;
    const heat = Math.min(1, ((wa + wb) / 2) * c.warpGain);
    strands.push(
      `<line x1="${(s.cur[a * 2] - f.centerX).toFixed(3)}" y1="${(-s.cur[a * 2 + 1]).toFixed(3)}"`
      + ` x2="${(s.cur[b * 2] - f.centerX).toFixed(3)}" y2="${(-s.cur[b * 2 + 1]).toFixed(3)}"`
      + ` stroke="${mixHex(c.color, c.hotColor, heat)}" stroke-opacity="${(c.opacity * (0.3 + heat * 0.7)).toFixed(3)}"/>`
    );
  }
  const fish = loads.map((l) =>
    `<circle cx="${l.x.toFixed(2)}" cy="${(-l.y).toFixed(2)}" r="${l.mass}" fill="#ffb26b" fill-opacity="0.55"/>`).join('');
  const boom = blastAt
    ? `<circle cx="${blastAt.x}" cy="${-blastAt.y}" r="${blastAt.r}" fill="none" stroke="#ffd27a" stroke-opacity="0.5" stroke-dasharray="0.4 0.4"/>` : '';

  const W = F.halfWidth * 2 + 6, H = DEEP + 5;
  return `<g>
  <text x="0" y="-1.2" fill="#8fb7c9" font-size="1.0" text-anchor="middle" font-family="ui-monospace,monospace">${title}</text>
  <rect x="${-W / 2}" y="-0.6" width="${W}" height="${H}" fill="#08131c"/>
  <line x1="${-W / 2}" y1="0" x2="${W / 2}" y2="0" stroke="#1d4b73" stroke-width="0.12"/>
  <g stroke-width="0.09" stroke-linecap="round">${strands.join('')}</g>
  ${fish}${boom}
</g>`;
}

const panels = [
  frame('hanging empty', {}),
  frame('under tow, 7 u/s', { tow: 7, pre: 4, secs: 0 }),
  frame('two fish caught', { loads: [{ x: -1.6, y: -5, mass: 1.4 }, { x: 2.2, y: -8, mass: 1.9 }] }),
  frame('bomb, 6 frames on', {
    loads: [{ x: -1.6, y: -5, mass: 1.4 }, { x: 2.2, y: -8, mass: 1.9 }],
    blastAt: { x: 0, y: -6.5, r: 5 }, secs: 6 / 60,
  }),
];

// A FIFTH PANEL AT FULL STACK, drawn in its own taller frame. The whole point
// of the change this documents is that levelling buys DEPTH and not width, and
// the only way to see that is to put the two side by side at the same scale.
F.depth = DEEP;
panels.push(frame('eight stacks', { loads: [{ x: -1.2, y: -14, mass: 1.4 }, { x: 1.8, y: -24, mass: 1.9 }] }));

const W = F.halfWidth * 2 + 6;
const H = DEEP + 5;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${panels.length * W * 44}" height="${(H + 2) * 44}" viewBox="0 0 ${panels.length * W} ${H + 2}">
<rect width="100%" height="100%" fill="#040a10"/>
${panels.map((p, i) => `<g transform="translate(${i * W + W / 2}, 2)">${p}</g>`).join('\n')}
</svg>`;

const OUT = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../.net-preview.svg');
fs.writeFileSync(OUT, svg);
console.log(`wrote ${OUT}`);
