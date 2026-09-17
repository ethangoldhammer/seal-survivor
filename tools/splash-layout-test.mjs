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
  SPLASH_GEOMETRY, fitEntryScale, fitNameScale, geometryFor, entryRects, wordmarkRect, splashFindings,
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
  const g = geometryFor(W, H);
  const scale = fitEntryScale({ W, H, g });
  // The pill is drawn at the NAME's scale now, not the row's — see fitNameScale.
  const pillW = ROW_W * fitNameScale({ W, rowW: ROW_W, scale });
  const found = splashFindings({ W, H, scale, pillW, g, others: domOverCard(W, H, touch), touch })
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
  // RE-READ AFTER THE NAME WAS DECOUPLED FROM THE BUTTONS. The old row here
  // carried a width per device as well, because one scale drove the whole row
  // and the pill's width was what pinned it: 0.602 on an iPhone SE, which is
  // a 48px button. `numEntryScale` answers to the wordmark alone now and the
  // name shrinks on its own (fitNameScale), so the readings are the taller
  // numbers below and the width no longer belongs in this table — it is a
  // function of the OTHER scale and pins nothing here.
  //
  // Measured off the shipping artboard by npm run test:splashhit, which drives
  // a real browser at each size and reads the number back; re-record from its
  // report rather than by hand.
  const MEASURED = [
    // name, W, H, numEntryScale read back
    ['iPhone SE', 375, 667, 0.991],
    ['iPhone 15', 393, 852, 1],
    ['iPhone 15 Pro Max', 430, 932, 1],
    ['iPhone 15 landscape', 852, 393, 0.553],
    ['iPad mini', 744, 1133, 1],
    ['iPad landscape', 1024, 768, 0.924],
    ['Laptop', 1280, 800, 0.881],
    ['Desktop', 1920, 1080, 1],
  ];
  let drift = 0;
  for (const [name, W, H, scale] of MEASURED) {
    // THROUGH geometryFor, because the title's height is no longer a constant:
    // a screen too short to fit a 44px button under a full-size title gives
    // some of it back (fitTitleFrac), and the artboard is laid out at whatever
    // that leaves. Reading the model at the design 0.32 would reproduce the
    // number this row USED to hold — 0.289 on a sideways phone — and agree with
    // a fixture that no longer describes the shipping file.
    const s = fitEntryScale({ W, H, g: geometryFor(W, H) });
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

// 3b. THE JAR AND THE RESERVE MEASURE FROM THE SAME EDGE.
//
//     The artboard reserves 72pt below the Start button and the tip jar lives
//     inside that reserve — 14px up, 44 tall on a thumb, 14 to spare. That only
//     holds while both are measured from the SAME bottom edge, and for a long
//     time they were not: the jar sat `14px + env(safe-area-inset-bottom)` off
//     the viewport (ui/tipJar.js, and it has to — under the home indicator is
//     a link that swipes the player out of the game) while the canvas filled
//     the whole viewport, so the artboard's 72 started 34px lower on a notched
//     iPhone than the jar's 58 did. The Play button landed on the jar by 20px.
//
//     Every check above ran at inset 0 and passed, because at inset 0 there is
//     no bug. So this one sweeps the inset, and it checks its own detector
//     first for the reason the header gives.
//
//     ui/riveSplash.js pads the wrapper by the inset and sizes the canvas to
//     the content box, which is what makes the two edges one edge again — so
//     the fix's half of this is the same `check` as everywhere else, run at the
//     CANVAS height rather than the viewport's.
{
  const INSETS = [20, 21, 34, 48];   // iPad, phone sideways, phone upright, headroom
  const before = failures;

  // The detector half: the arrangement as it was, at each inset.
  let seen = 0; let missed = 0;
  for (const [name, W, H, touch] of DEVICES) {
    for (const inset of INSETS) {
      const g = geometryFor(W, H);
      const scale = fitEntryScale({ W, H, g });
      const pillW = ROW_W * fitNameScale({ W, rowW: ROW_W, scale });
      // The jar lifted by the inset, the artboard still laid out on the full
      // viewport — the two edges that used to disagree.
      const jarH = touch ? 44 : 34;
      const jar = [{ what: 'a.sv-tip-splash', rect: { left: (W - 92) / 2, right: (W + 92) / 2, top: H - 14 - inset - jarH, bottom: H - 14 - inset } }];
      const f = splashFindings({ W, H, scale, pillW, g, others: jar, touch })
        .filter((x) => x.type === 'splash-over-ui');
      if (f.length) seen++; else missed++;
    }
  }
  // Not every row overlaps — a 20pt iPad inset against a 34pt phone one is a
  // different amount of climb, and the SE has no indicator to clear. The claim
  // is that the detector SEES the arrangement, not that every cell of it broke.
  if (seen > 0) ok(`the detector reports the jar on the Start button at ${seen} of ${seen + missed} device x inset pairs when the two measure from different edges`);
  else fail('detector: the old viewport-measured jar was never reported on the Start button');

  // The fix's half: the canvas is the viewport less the inset, and the jar is
  // 14px off the canvas — which is `check` at that height, at every device and
  // every inset, plus a grid of short screens where the reserve is tightest.
  for (const [name, W, H, touch] of DEVICES) {
    for (const inset of INSETS) check(W, H - inset, touch, `${name} less a ${inset}px safe area`);
  }
  for (let W = 320; W <= 1024; W += 16) {
    for (const inset of INSETS) {
      for (let H = 480; H <= 1000; H += 16) check(W, H - inset, true, 'safe-area grid');
      if (failures > before + 12) break;
    }
    if (failures > before + 12) break;
  }
  if (failures === before) ok('with the canvas sized to the safe area, the jar clears the column at every device and inset');
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
