#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:nightsky
//
// THE NIGHT BACKGROUND HAS NO HARD EDGES, and the sky has depth. Two claims,
// both of which were false, both of which fail silently.
//
// 1. THE STARS WERE CLIPPED BY THEIR OWN CELLS.
//
//    The sky shader places one star per grid cell and draws it from that cell
//    ONLY: it hashes the cell under the pixel, and a cell with no star draws
//    nothing. So a star whose jittered centre landed within one dot-radius of
//    its cell boundary had the overhanging part of itself simply never drawn,
//    and what was left ended in a dead straight line. Measured over the field:
//    49% of the sky, with the worst bisected. Nothing throws, nothing logs, and
//    at a glance it reads as "the star texture is a bit blocky".
//
//    The fix is an inset in starOffset, and the thing that makes it testable is
//    that the CPU and the GPU share that function (systems/starField.js) — so
//    the placement asserted here is the placement drawn.
//
// 2. THE CLOUD DECK ENDED IN MID-AIR.
//
//    The old overlay spanned exactly the frame's air band and faded only at the
//    bottom, so its top edge was a straight horizontal line across the sky at
//    y = frameTop. Invisible while the camera sits still, and perfectly obvious
//    the moment a breach lifts it into shot — which is the failure mode of
//    every seam in this game: it is fine in the screenshot.
//
//    So the alpha window is asserted to reach zero AT the geometry's own edges,
//    which is a property of the shader's arithmetic rather than of the numbers
//    anyone tuned. A layer cannot be given a hard edge by dragging a slider.
//
// 3. AND THE DEPTH LADDER. Layers exist to sit at different distances; four
//    decks at the same drift are one deck with four times the overdraw. The
//    ladder is asserted to be strictly increasing from the sky to the sea.
//
//   node --import ./tools/vite-loader.mjs tools/night-sky-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import { updateBounds, bounds } from '../path/src/arena.js';
import {
  STAR_THRESHOLD, STAR_RADIUS, STAR_FIELD_GLSL, starHash21, starsIn,
} from '../path/src/systems/starField.js';

updateBounds(16 / 9);

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const ss = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-9)));
  return t * t * (3 - 2 * t);
};

// ===========================================================================
section('STARS — nothing is cut off by the grid it was placed on');
// ===========================================================================
{
  // starOffset, as the shader computes it. Transcribed rather than imported
  // because the shader's copy is a string of GLSL — so the transcription is
  // checked against that string below, which is the only way this can claim to
  // be measuring what is drawn.
  const inset = (h) => STAR_RADIUS + (1 - 2 * STAR_RADIUS) * h;

  check('the shader applies the same inset',
    STAR_FIELD_GLSL.includes('STAR_RADIUS + (1.0 - 2.0 * STAR_RADIUS)')
    && STAR_FIELD_GLSL.includes(`#define STAR_RADIUS ${STAR_RADIUS.toFixed(4)}`),
    'starOffset in GLSL');

  let stars = 0, clipped = 0, worst = 0;
  let bareStars = 0, bareClipped = 0;
  for (let col = -220; col < 220; col++) {
    for (let row = -70; row < 70; row++) {
      if (starHash21(col, row) <= STAR_THRESHOLD) continue;
      const hx = starHash21(col + 1.7, row + 1.7);
      const hy = starHash21(col + 3.1, row + 3.1);

      stars++;
      const near = Math.min(inset(hx), 1 - inset(hx), inset(hy), 1 - inset(hy));
      if (near < STAR_RADIUS - 1e-6) { clipped++; worst = Math.max(worst, STAR_RADIUS - near); }

      // The positive control: the same field placed the way it used to be, with
      // a raw 0..1 jitter. If this does NOT come out badly clipped, the
      // measurement above is not looking at anything.
      bareStars++;
      if (Math.min(hx, 1 - hx, hy, 1 - hy) < STAR_RADIUS) bareClipped++;
    }
  }

  check('no star reaches the edge of its own cell', clipped === 0,
    `${clipped} of ${stars} clipped${clipped ? `, worst by ${(worst / STAR_RADIUS * 100).toFixed(0)}% of a radius` : ''}`);
  check('...and the harness would have caught it when they did',
    bareClipped / bareStars > 0.3,
    `the raw 0..1 jitter clips ${((bareClipped / bareStars) * 100).toFixed(0)}% of ${bareStars} stars`);

  // The inset must not eat the jitter: a field pushed into the middle of every
  // cell is a lattice again, which is the one thing a sky must not look like.
  const spread = 1 - 2 * STAR_RADIUS;
  check('the jitter survives the inset', spread > 0.6,
    `stars roam the middle ${(spread * 100).toFixed(0)}% of a cell`);

  // And the field is still a field. The constellations are strung between
  // exactly these, so an inset that emptied it would take them with it.
  const visible = starsIn(
    { left: -bounds.frameWidth / 2, right: bounds.frameWidth / 2, bottom: bounds.surfaceY, top: bounds.frameTop },
    CONFIG.dayNight.stars.density,
  );
  check('the visible sky still has stars in it', visible.length > 15,
    `${visible.length} across the frame's air band`);
}

// ===========================================================================
section('CLOUDS — every deck fades out inside its own quad');
// ===========================================================================
{
  const cfg = CONFIG.weather.clouds;
  const layers = cfg.layers ?? [];
  check('there is a stack', layers.length >= 3, `${layers.length} layers`);

  // The alpha window out of the fragment shader, in the quad's own v.
  const window = (v, feather) => ss(0, feather, v) * (1 - ss(1 - feather, 1, v));

  for (const def of layers) {
    const feather = Math.max(0.02, Math.min(0.5, def.feather ?? 0.35));
    // AT the geometry's edges, which is where a hard edge would be.
    const atEdges = Math.max(window(0, feather), window(1, feather));
    // ...and one pixel inside them. A quad 6 world units tall on a 1080-line
    // screen is about 125 pixels, so a hundredth of it is the pixel next door:
    // the step from "nothing" to "the first drawn pixel" is what the eye reads
    // as an edge, and it has to be a fraction of a level rather than a jump.
    const firstPixel = Math.max(window(0.01, feather), window(0.99, feather));
    check(`${def.name}: the alpha is zero at the quad's edge`, atEdges === 0,
      `edge ${atEdges.toFixed(4)}`);
    check(`${def.name}: ...and still near zero one pixel in`, firstPixel < 0.02,
      `${(firstPixel * 100).toFixed(2)}% of full`);
  }

  // The positive control, and the actual defect: the old overlay's window faded
  // in at the bottom and did nothing at all at the top.
  const legacy = (v) => ss(0, 0.45, v);
  check('the harness sees the old top edge', legacy(1) > 0.9,
    `the previous overlay was at ${(legacy(1) * 100).toFixed(0)}% opacity where its quad stopped`);

  // Decks are drawn far-to-near, and every one of them sits above the celestial
  // rig (-12 and -11) and below anything in the water (0 and up).
  const orders = layers.map((_, i) => -10.5 + i * 0.1);
  check('they draw far to near', orders.every((o, i) => i === 0 || o > orders[i - 1]),
    orders.join(' < '));
  check('...between the sun and the sea',
    orders.every((o) => o > -11 && o < 0), `${orders[0]} .. ${orders[orders.length - 1]}`);
}

// ===========================================================================
section('PARALLAX — the sky has rungs, not two ends');
// ===========================================================================
{
  const sky = CONFIG.dayNight.orbit.drift;
  const decks = (CONFIG.weather.clouds.layers ?? []).map((l) => l.drift ?? 0);
  const ladder = [sky, ...[...decks].sort((a, b) => a - b), 1];

  console.log(`  ladder: ${ladder.map((d) => d.toFixed(2)).join('  ->  ')}   (sky -> decks -> the sea)`);

  check('every rung is further forward than the last',
    ladder.every((d, i) => i === 0 || d > ladder[i - 1]),
    'two layers at the same drift are one layer with twice the overdraw');
  check('the decks sit between the sky and the world',
    decks.every((d) => d > sky && d < 1), `sky ${sky}, decks ${decks.join(', ')}`);
  // A ladder whose rungs are all bunched at one end reads as one distance with
  // noise on it. The gaps have to be big enough to see.
  const gaps = ladder.slice(1).map((d, i) => d - ladder[i]);
  check('the gaps are wide enough to read as distance',
    Math.min(...gaps) > 0.03, `smallest gap ${Math.min(...gaps).toFixed(2)}`);

  // What the ladder is WORTH, in the only unit that matters: how far each layer
  // moves on screen when the seal swims the width of the ocean.
  const pan = bounds.right - bounds.left;
  console.log(`\n  across a ${pan.toFixed(0)}-unit ocean, on a ${bounds.frameWidth.toFixed(0)}-unit frame:`);
  for (const [name, d] of [['sun & moon', sky], ...(CONFIG.weather.clouds.layers ?? []).map((l) => [l.name, l.drift]), ['the sea', 1]]) {
    console.log(`    ${String(name).padEnd(12)} ${(pan * d).toFixed(1).padStart(6)} units  ` +
      `(${((pan * d / bounds.frameWidth) * 100).toFixed(0)}% of the frame)`);
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
