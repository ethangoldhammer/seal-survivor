#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:splashlayout — the dice, the name pill and the Start button on
// the title card never sit on the wordmark, on the tip jar, or off the screen,
// at ANY viewport.
//
// WHAT WENT WRONG. The entry column's size was capped at 42% of the screen's
// height as a stand-in for "stay under the wordmark". The wordmark is not 42%
// of anything: it is a 1920x360 artboard fitted CONTAIN into the top 32% of
// the screen, so on a wide screen the width binds and the title ends lower
// than the fraction assumed. A laptop at 1280x800, an iPad held sideways and a
// phone held sideways all drew the dice on the SURVIVOR — and nothing in the
// repo could see it, because the buttons are Rive, not DOM, and the layout
// audit only measures DOM.
//
// WHAT THIS CHECKS. ui/splashLayout.js is now the one copy of the artboard's
// geometry and of the fit rule. This sweeps that rule over every viewport the
// layout audit knows and a dense grid around them (320..2560 wide, 300..1600
// tall), with the pill at the widest it can be — MAX_NAME_LEN characters —
// and asserts the column clears the wordmark, the tip jar and the screen's
// edges at the scale the game would write. In Node, in a second, inside
// `npm test` and so inside the ship gate.
//
// IT CHECKS ITS OWN DETECTOR FIRST. A rule that stopped matching would turn
// this into a green light that means nothing (see test:copy for the same
// habit), so the first assertion is that the OLD fit — 42% of the height — is
// reported as an overlap at the sizes it broke on.
//
// AND IT IS PINNED TO THE REAL RUNTIME. The scales below were read back from
// the shipping artboard in Electron (tools/looks/splash-probe.html, re-read
// 2026-09-11 after the title was pinned to the horizon — see splashLayout.js —
// which moved both the wordmark's anchor and the fit's own constants): the
// game's own `numEntryScale` at eight device sizes.
// The model here must reproduce them, or the model and the artboard have
// drifted — a redesign in the Rive editor is the usual reason, and the fix is
// to re-measure SPLASH_GEOMETRY, not to loosen the pin.
//
// WHAT IT CANNOT SEE: the artboard itself. If the wordmark is redrawn or the
// entry strip is moved in the editor, the constants in splashLayout.js are
// stale and this passes on the old design. `npm run layout` (surface
// `splash`) reads the pill width the real artboard lays out, which catches
// half of that; the wordmark's ink box has to be re-scanned by hand — the
// recipe is in splashLayout.js.
// ---------------------------------------------------------------------------
import {
  SPLASH_GEOMETRY, fitEntryScale, entryRects, wordmarkRect, splashFindings,
  estimateRowWidth, entryColumnHeight, horizonY,
} from '../path/src/ui/splashLayout.js';
import { MAX_NAME_LEN } from '../path/src/systems/playerName.js';

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

// The same list tools/layout/layout-audit.js sweeps, restated rather than
// imported — that file is a browser module and this one is Node.
const DEVICES = [
  ['iPhone SE', 375, 667, true],
  ['iPhone 15', 393, 852, true],
  ['iPhone 15 Pro Max', 430, 932, true],
  ['iPhone 15 landscape', 852, 393, true],
  ['iPad mini', 744, 1133, true],
  ['iPad landscape', 1024, 768, true],
  ['Laptop', 1280, 800, false],
  ['Desktop', 1920, 1080, false],
];

// THE DOM OVER THE CARD, as the game places it (ui/tipJar.js .sv-tip-splash,
// ui/buildStamp.js): the jar is centred 14px off the bottom, 34px tall with
// a mouse and 44 with a thumb; the stamp is a 10px line in the bottom-right
// corner. Both are inside the strip's 72px reserve, which is what the reserve
// is for.
function domOverCard(W, H, touch) {
  const jarH = touch ? 44 : 34;
  const jarW = 92;
  return [
    { what: 'a.sv-tip-splash', rect: { left: (W - jarW) / 2, right: (W + jarW) / 2, top: H - 14 - jarH, bottom: H - 14 } },
    { what: 'div.sv-build-stamp', rect: { left: W - 12 - 21, right: W - 12, top: H - 10 - 10, bottom: H - 10 } },
  ];
}

// The widest pill the game can produce: the longest name the field accepts,
// at the per-character estimate the first frame uses (which over-estimates the
// measured face by a third, so a pass here is a pass with room).
const ROW_W = estimateRowWidth('x'.repeat(MAX_NAME_LEN));

function check(W, H, touch, label) {
  const scale = fitEntryScale({ W, H, rowW: ROW_W });
  const pillW = Math.min(ROW_W * scale, W - 48);
  const found = splashFindings({ W, H, scale, pillW, others: domOverCard(W, H, touch), touch })
    // Tap size is a trade-off the layout audit reports per device; here the
    // question is only whether anything is ON anything.
    .filter((f) => f.type !== 'tap');
  if (found.length) {
    fail(`${label} ${W}x${H} at scale ${scale.toFixed(3)}: ${found.map((f) => `${f.what} ${f.type} ${f.over ?? ''} ${f.by}`).join('; ')}`);
  }
  return scale;
}

console.log('splash layout — the entry column never sits on the wordmark');

// 1. THE DETECTOR SEES THE BUG IT WAS WRITTEN FOR. The old rule, at the sizes
//    that were photographed overlapping, must be reported.
{
  // With the pill as it was photographed — the artboard's own placeholder,
  // 824.6 wide at scale 1 — because a pill wide enough to bind the fit by
  // width would have shrunk the column past the bug by accident.
  const PHOTOGRAPHED_ROW_W = 824.6;
  const old = (W, H) => Math.max(0.3, Math.min(1, (W - 48) / PHOTOGRAPHED_ROW_W, (H * 0.42) / entryColumnHeight()));
  let seen = 0;
  for (const [name, W, H] of DEVICES) {
    if (!['iPhone 15 landscape', 'Laptop', 'iPad landscape'].includes(name)) continue;
    const s = old(W, H);
    const f = splashFindings({ W, H, scale: s, pillW: PHOTOGRAPHED_ROW_W * s });
    if (f.some((x) => x.type === 'splash-over-wordmark' && x.what === 'splash dice')) seen++;
    else fail(`detector: the old 42% rule at ${name} should read as the dice on the wordmark`);
  }
  if (seen === 3) ok('the detector reports the old 42%-of-height rule as an overlap on the three sizes it broke');
  // ...and a column that is simply too big.
  const f = splashFindings({ W: 852, H: 393, scale: 1, pillW: 500 });
  if (f.some((x) => x.type === 'splash-over-wordmark')) ok('a full-size column on a sideways phone is reported');
  else fail('detector: a full-size column on a sideways phone was not reported');
}

// 2. THE GEOMETRY IS THE ARTBOARD'S. Pinned to the runtime — see the header.
{
  const MEASURED = [
    // name, W, H, numEntryWidth read back, numEntryScale read back
    ['iPhone SE', 375, 667, 327.000, 0.60214],
    ['iPhone 15', 393, 852, 345.000, 0.63528],
    ['iPhone 15 Pro Max', 430, 932, 382.000, 0.70341],
    ['iPhone 15 landscape', 852, 393, 156.917, 0.28895],
    ['iPad mini', 744, 1133, 543.066, 1],
    ['iPad landscape', 1024, 768, 501.677, 0.92379],
    ['Laptop', 1280, 800, 478.256, 0.88066],
    ['Desktop', 1920, 1080, 543.066, 1],
  ];
  let drift = 0;
  for (const [name, W, H, width, scale] of MEASURED) {
    // The pill hugs whatever name the dice rolled, so the widths above are one
    // run's name at eight sizes — width/scale is the same 543.07 in every row,
    // and a row where it is not is a reading taken before the resize settled.
    const rowW = width / scale;
    const s = fitEntryScale({ W, H, rowW });
    if (Math.abs(s - scale) > 0.003) { drift++; fail(`${name}: model fits ${s.toFixed(4)}, the artboard was read at ${scale}`); }
  }
  if (!drift) ok('the fit reproduces numEntryScale as read back from the shipping artboard at 8 device sizes');
}

// 2b. THE TITLE IS PINNED TO THE HORIZON, which is the whole point of the
//     32%-tall slot and the bottom alignment (see splashLayout.js). The claim
//     is not "the wordmark is somewhere sensible" — it is that the waterline
//     crosses the SAME LINE of the artwork on every screen there is. So the
//     gap from the horizon to the ink, divided by the fit scale, has to be one
//     constant; anything else means the anchor has come loose again.
//
//     It was not a constant before: the wordmark was centred in a 57% slot, and
//     the ink ended 270px below the waterline at 1920x1080, 179 at 1280x800 and
//     34 on a phone — the fin drifting from mid-SURVIVOR to above the S.
{
  const g = SPLASH_GEOMETRY;
  const EXPECT = g.wordmark.ink.bottom - g.wordmark.height;   // 268 units of art below the waterline
  let worst = 0; let worstAt = '';
  for (let W = 320; W <= 2560; W += 8) {
    for (let H = 300; H <= 1600; H += 8) {
      const wm = wordmarkRect(W, H);
      const off = (wm.bottom - horizonY(H)) / wm.scale;
      const d = Math.abs(off - EXPECT);
      if (d > worst) { worst = d; worstAt = `${W}x${H} (${off.toFixed(2)})`; }
    }
  }
  if (worst < 1e-6) ok(`the waterline crosses the wordmark ${EXPECT} art-units above its ink's bottom edge at every viewport`);
  else fail(`the title has come off the horizon: ${worstAt} against ${EXPECT}, off by ${worst.toFixed(2)}`);
  // And the horizon is the slot's own bottom edge, not a second number that
  // has to be kept in step with it by hand.
  const wm = wordmarkRect(1920, 1080);
  if (Math.abs((wm.bottom - g.wordmark.ink.bottom * wm.scale) + g.wordmark.height * wm.scale - horizonY(1080)) < 1e-6) {
    ok('the wordmark artboard\'s bottom edge IS the waterline');
  } else fail('the wordmark box no longer ends on the horizon');
}

// 3. EVERY DEVICE, AND EVERYTHING AROUND THEM.
{
  const before = failures;
  for (const [name, W, H, touch] of DEVICES) check(W, H, touch, name);
  if (failures === before) ok('clear on all 8 named devices');
  let n = 0;
  for (let W = 320; W <= 2560; W += 16) {
    for (let H = 300; H <= 1600; H += 16) {
      check(W, H, true, 'grid');
      n++;
      if (failures > before + 12) break;
    }
    if (failures > before + 12) break;
  }
  if (failures === before) ok(`clear on a ${n}-viewport grid, 320..2560 by 300..1600`);
  else console.error('  (stopped after a dozen — the rest would be the same story)');
}

// 4. THE COLUMN IS WHERE THE DISSOLVE THINKS IT IS. entryRects is what the
//    name-swap reads for the pill; a column that is 324 tall at scale 1 and
//    sits 72 off the bottom is the artboard's design.
{
  const r = entryRects(1920, 1080, 1, 824.6);
  const g = SPLASH_GEOMETRY;
  const okBottom = Math.abs(r.start.bottom - (1080 - g.strip.bottom)) < 0.01;
  const okTop = Math.abs(r.dice.top - (1080 - g.strip.bottom - g.strip.height)) < 0.01;
  const okPill = Math.abs(r.pill.top - (r.dice.bottom + g.column.gap)) < 0.01 && Math.abs(r.pill.bottom - r.pill.top - g.column.pill) < 0.01;
  if (okBottom && okTop && okPill) ok('the column is 324 tall at scale 1, sat 72 off the bottom, pill 96 down from its top');
  else fail(`column geometry drifted: ${JSON.stringify(r)}`);
}

if (failures) {
  console.error(`\n${failures} failure(s). The rule lives in path/src/ui/splashLayout.js.`);
  process.exit(1);
}
console.log('\nsplash layout: pass');
