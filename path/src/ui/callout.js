import { CONFIG } from '../config.js';
import { activeCallout } from '../systems/callouts.js';
import { liveChainCss } from '../systems/chainColor.js';
import { popupPose, worldToScreen } from './ui.js';
import { applyTipDissolve, clearTipDissolve, initTipDissolve, warmTipDissolve } from './tipDissolve.js';

// ---------------------------------------------------------------------------
// DRAWING THE CALLOUTS: two lines, in two places, and the arrow under them.
//
// THREE NODES FOR THE WHOLE FEATURE, all reused forever. A warning fires
// several times a minute in a bad run and a tip is a once-per-device event, so
// there is never more than one line per surface (systems/callouts.js is the
// reason) and building a node per callout would be churn for nothing.
//
// THE THREE SURFACES ARE DIFFERENT KINDS OF MESSAGE, which is why they are
// drawn differently rather than being one function with a position argument:
//
//   BAND    fixed to the screen, big, red or blue. An emergency, or the one
//           thing a first-run player needs to be told. Read instead of the
//           fight, for a moment.
//   PLAYER  small, warm, riding just above the boost ring on the seal. A gauge
//           reading, put where the gauge is. Read WITHOUT leaving the fight —
//           which is why it earns its size in bloom rather than in points: at
//           twelve pixels over a lit instrument, a halo swelling and dying is
//           the only thing that catches the eye without becoming another
//           object on screen to parse.
//   WORLD   a first-run tip, standing in the water beside the thing it is
//           about and following it. A LABEL: the sentence and its subject are
//           one look, so nothing has to be matched up. It holds its place for
//           as long as the thing is there and then dissolves (ui/tipDissolve
//           .js) — the departure is the player having collected the thing,
//           which is why it is an event and not a fade on a timer. And it is
//           a label on the WATER, not on the glass: when the subject leaves
//           the frame the words stop following and simply stay where they
//           were standing. See the park in drawWorld.
//
// A WORLD TIP IS TWO NODES, and the split is a rule about writers. The outer
// box carries the position and the arrival curve; the inner one is owned
// outright by the dissolve. Both writing `transform` — the pose scale and the
// drift of the water — is the bug where one of the two silently never lands.
//
// THE ARROW HUGS ITS SUBJECT. It has been two other things before this one: a
// long pointer from the seal toward something out in the water, and then — once
// the words moved out of the middle of the screen and onto the thing itself —
// the same long pointer kept only for a subject off the edge of the frame.
// Both were about DIRECTION, and direction is what a first-run tip least needs:
// the sentence already says what the thing does, and the only question left is
// WHICH of the four similar orbs on screen it is talking about.
//
// So the arrow is a MARK now. It sits a couple of dozen pixels off the subject
// with its nose in it, on the side the sentence is on, so the words, the glyph
// and the thing are one line of reading. It is drawn only while the subject is
// on the glass — an arrow at the border pointing at water nobody can see is the
// long-range pointer again, and the tip's words holding their place is the
// whole of the answer in that case (see drawWorld).
//
// THE ARROW IS PLACED IN SCREEN SPACE, off the subject's projected position and
// along the direction of the tip's own box. Doing it in world space and
// rotating the result is the obvious alternative and it is wrong here: the
// camera rolls and zooms (see cineCamera.js), so a world-space offset drawn
// onto a screen-space overlay would slide off the thing it is marking exactly
// during a strike. Both ends are projected, so the mark is correct by
// construction whatever the lens is doing.
//
// LAYERED ABOVE THE MENUS, unlike the toast layer. A callout that was up when
// the cards opened has to play out where it can be read, and a band that a menu
// can cover would finish behind it. Safe because nothing here takes
// pointer events — the band cannot swallow a click on a card underneath it.
//
// THAT IS ABOUT THE WARNINGS, AND ONLY THEM. "Warning!" over the upgrade cards
// is the point; a first-run tip over them is a sentence the player has to read
// past to make a choice. The coach does not reach this file while a menu is
// open at all — systems/tutorial.js is handed `live` false whenever the game is
// paused, so the row is cleared upstream and there is nothing here to draw. No
// branch below tests for a menu, deliberately: whether a tip exists is the
// coach's question, and answering it twice is how the two end up disagreeing.
//
// ...AND THEREFORE IT MUST NOT LAND ON THE HUD. Being on top of everything is
// what makes a callout readable and it is also what makes it dangerous: the
// band is a fixed fraction down the screen (CONFIG.callouts.y), which was
// picked on a desktop where a quarter of the height clears the boss bar
// comfortably. On a phone held sideways a quarter of 375px is 97px, and the
// print pile, the boss bar and the level label are all up there. The line
// lands on top of the score, or the boss's health, at exactly the moment both
// of those matter. See keepOffChrome — the position in CONFIG is a PREFERENCE
// now, and the clear space wins when they disagree.
// ---------------------------------------------------------------------------

const STYLES = `
  /* Above the HUD, BELOW THE MENUS (.sv-center is 8 — see the ladder note in
     ui/ui.js). A coach line is the run talking; the cards are the run asking,
     and a tip that was still up when the level-up menu opened used to finish
     its hold on top of them. Do not raise this past 7. */
  .sv-callout-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 6; }

  /* Type here is the FALLBACK, same as the rest of ui.js: every font value is
     re-stated by ui/typography.js from the Warning band, First-run tip and
     Boost warning roles. Position, centring and the will-change hint are real. */
  /* WRAPS, and this is the whole of the mobile tutorial fix.
     This was "white-space: nowrap" — no backticks in here, the whole block is
     a template literal and one would end it — which is right for "Warning!"
     and wrong for
     every coach line in callouts.csv: at 24px with 0.1em of tracking, "Keep
     going — jump clean out of the water" is 437px of unbreakable text centred
     on a 375px screen, so 31px of it hung off each edge — the FIRST and LAST
     words of the one sentence teaching a new player what to do. It cost nothing
     on a desktop, which is why it survived.
     max-width earns the wrap: without it the line grows to the layer and never
     breaks. min() rather than a plain vw so a phrase that fits stays on one
     line on a wide screen — this only ever wraps when it has to.

     "width: max-content" is what makes that max-width mean anything, and it is
     not decoration. This box is absolutely positioned at left: 50%, so the room
     available to it is the half of the screen to its right — 187px on a phone —
     and a shrink-to-fit box takes that as its width no matter what max-width
     says. The line fitted, and wrapped into THREE ragged lines inside half the
     screen while the other half sat empty. max-content sizes it to the sentence
     first; max-width then clamps that to the screen, and the wrap happens at
     the width the text can actually have. The centring is done by the transform
     (translate -50%), not by the box, so widening it moves nothing.
     line-height is stated here because a two-line band needs one and the role
     sheet (ui/typography.js) does not write it; balance splits the two lines
     evenly instead of leaving one word alone on the second. */
  .sv-callout { position: absolute; left: 50%; text-align: center;
    white-space: normal; width: max-content; max-width: min(720px, 88vw); line-height: 1.25;
    text-wrap: balance; overflow-wrap: break-word;
    font-size: 24px; font-weight: 800; letter-spacing: 0.1em; color: #ff5566;
    text-shadow: 0 2px 6px rgba(0,0,0,0.95), 0 0 18px currentColor;
    pointer-events: none; will-change: transform, opacity, filter; }
  .sv-callout-coach { color: #9fe3ff; font-size: 20px; font-weight: 700; letter-spacing: 0.04em; }
  /* left is written per frame from the seal's projected position, so unlike the
     band this one is NOT pinned to the middle of the screen. */
  .sv-callout-boost { position: absolute; left: 0; white-space: nowrap; text-align: center;
    font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: #ffc65a;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9), 0 0 8px currentColor;
    pointer-events: none; will-change: transform, opacity, filter; }
  /* "STRIKE NOW!" — the same node, wearing the FOOD CHAIN's type instead of the
     gauge's. No colour here: it is written inline off the live chain's place on
     the hue wheel, which is why the Strike prompt role is marked inlineColor
     and ui/typography.js emits no colour for it. No backticks in this block —
     the whole thing is a template literal and one would end it. */
  .sv-callout-strike { font-size: 14px; font-weight: 900; letter-spacing: 0.14em;
    text-transform: uppercase; }

  /* THE WORLD TIP. Narrower than the band on purpose: it stands beside an
     object rather than across the screen, so it wraps into a short block that
     can sit in a gap in the water instead of a wide line that will always be
     over something. The type is the coach role either way — same voice, same
     size; only the place changed. */
  /* THE ONE PLACE THE TIP'S OWN SIZE IS WRITTEN, unlike every other line in
     this file: the world tip has no text role of its own (it shares the coach
     VOICE, but the role sheet's selector is .sv-callout-coach and this node
     does not wear that class), so what is here is real and not a fallback.
     It carries --sv-tipScale by hand for that reason, so it shrinks in a hand
     exactly as the band's coach lines do — without it, this node was the only
     piece of tutorial text on the screen still at its desktop size on a phone.
     NOT --sv-scale, deliberately: this size has never been under the Text
     panel's global multiplier, and quietly putting it there would resize every
     world tip on a desktop as a side effect of a phone fix.
     The max-width goes the other way on a small screen — see the note by the
     breakpoint in ui.js: at this size the constraint is the number of
     CHARACTERS per line, and a narrow column of a wide pixel font is a stack
     of two-word lines. */
  .sv-callout-world { position: absolute; left: 0; top: 0; text-align: center;
    white-space: normal; width: max-content; max-width: min(340px, 62vw); line-height: 1.25;
    text-wrap: balance; overflow-wrap: break-word;
    font-size: calc(20px * var(--sv-tipScale, 1));
    font-weight: 700; letter-spacing: 0.04em; color: #9fe3ff;
    text-shadow: 0 2px 6px rgba(0,0,0,0.95), 0 0 18px currentColor;
    pointer-events: none; will-change: transform, opacity, filter; }
  /* The node the dissolve owns. It is display:block because a filter and a mask
     on an inline box are applied per LINE BOX — a two-line tip would dissolve
     as two independent strips with a seam between them. (No backticks in this
     comment: the whole block is a template literal and one would end it.) */
  .sv-callout-ink { display: block; }

  /* The arrow is drawn as one SVG path so it scales cleanly and takes a glow in
     its own colour the same way the type does. left/top are written per frame;
     the transform carries the aim and the bob. */
  .sv-callout-arrow { position: absolute; left: 0; top: 0; pointer-events: none;
    will-change: transform, opacity; }
`;

let layer = null;
let bandEl = null;
let bandInkEl = null;
let boostEl = null;
let worldEl = null;
let worldInkEl = null;
let arrowEl = null;

// The arrow's live bearing, eased toward the one it is asked for. Kept across
// frames — that easing is the whole reason a re-target reads as this arrow
// turning rather than as a different arrow appearing.
let arrowAngle = 0;
let arrowHasAim = false;
let bobClock = 0;

// WHERE THE WORLD TIP LAST STOOD WITH BOTH FEET ON THE GLASS, and the words it
// stood there for. The tip follows its subject only while it fits on the
// screen; once the subject leaves, this is what it holds. See drawWorld.
let worldPark = null;
let worldParkFor = '';

const targetPt = { x: 0, y: 0 };
const anchorPt = { x: 0, y: 0 };
// The centre of the world tip's box as it was last drawn, in screen pixels.
// The arrow reads it to work out which SIDE of the subject the sentence is on,
// so the glyph parks between the two rather than anywhere else on the ring.
const labelPt = { x: 0, y: 0 };

export function initCallouts(root) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  layer = document.createElement('div');
  layer.className = 'sv-callout-layer';

  bandEl = document.createElement('div');
  bandEl.className = 'sv-callout sv-hidden';
  // The band's words live in an inner node for the same reason the world tip's
  // do: a COACH line on the band dissolves as well (the control tips are
  // tutorial text too), and the dissolve must not share `filter` or `transform`
  // with the arrival curve. A warning uses the same node and simply never has a
  // dissolve applied to it.
  bandInkEl = document.createElement('span');
  bandInkEl.className = 'sv-callout-ink';
  bandEl.appendChild(bandInkEl);
  layer.appendChild(bandEl);

  boostEl = document.createElement('div');
  boostEl.className = 'sv-callout-boost sv-hidden';
  layer.appendChild(boostEl);

  worldEl = document.createElement('div');
  worldEl.className = 'sv-callout-world sv-hidden';
  worldInkEl = document.createElement('span');
  worldInkEl.className = 'sv-callout-ink';
  worldEl.appendChild(worldInkEl);
  layer.appendChild(worldEl);

  // The filter definitions now, the mask tiles at idle. Splitting them is the
  // same reasoning warmReveals carries: the <defs> are a few elements and the
  // tiles are tens of milliseconds of canvas work, and the second one must not
  // land on the frame a tip appears.
  initTipDissolve(root);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warmTipDissolve, { timeout: 4000 });
  else setTimeout(warmTipDissolve, 400);

  arrowEl = document.createElement('div');
  arrowEl.className = 'sv-callout-arrow sv-hidden';
  // viewBox rather than a fixed size: the width and height are written per
  // frame from CONFIG, and the path inside has to follow them.
  arrowEl.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path d="M12 1 L22 15 L14 15 L14 23 L10 23 L10 15 L2 15 Z" fill="currentColor" />
  </svg>`;
  layer.appendChild(arrowEl);

  // Appended last so it sits over the menus. See the header.
  root.appendChild(layer);
}

/** Between runs: nothing left on screen, and no stale bearing to swing from. */
export function clearCalloutUi() {
  if (!bandEl) return;
  bandEl.classList.add('sv-hidden');
  clearTipDissolve(bandInkEl);
  boostEl.classList.add('sv-hidden');
  worldEl.classList.add('sv-hidden');
  // The dissolve is cleared as well as hidden. A hidden node keeps whatever
  // filter and mask it had, and the next tip would arrive already half eaten
  // for one frame before the first update wrote over it.
  clearTipDissolve(worldInkEl);
  arrowEl.classList.add('sv-hidden');
  arrowHasAim = false;
  worldPark = null;
  worldParkFor = '';
}

/**
 * One frame of both lines and the arrow.
 *
 * `ctx` is what the drawing needs, handed in by the frame loop:
 *   camera, playerX, playerY   where the seal is
 *   nearestChum(x, y)          the nearest bite, for an `arrow: chum` row.
 *                              A FUNCTION and not a position, because finding
 *                              it walks every orb in the water and the arrow is
 *                              up for a few seconds once per device — asked for
 *                              every frame of every run it would be a scan of
 *                              a hundred and forty pickups to answer a question
 *                              nobody is asking.
 *   nearestPickup(x, y, kind)  the nearest pickup OF ONE KIND, for an
 *                              `arrow: pickup` row. `kind` is the row's own id
 *                              — see arrowTarget. A function for the same
 *                              reason nearestChum is.
 *   surfaceY    the waterline above the seal, for an `arrow: surface` row
 *   seabedY     the floor below it, for an `arrow: seabed` row
 *   device      what the player is holding, which decides the WORDING of a row
 *               that has more than one — see calloutTable.js
 *   tokens      what to call the hardware, for a line that names a control —
 *               `{bumper}` and friends. See inputTokens in input.js.
 *
 * Driven on REAL time, like the toasts: a callout fired by the kill that
 * triggered a level-up should finish rather than hang frozen over the cards
 * until the player picks.
 */
export function updateCalloutUi(dt, ctx = {}) {
  if (!bandEl) return;
  bobClock += dt;

  const band = activeCallout('band', ctx.device, ctx.tokens);
  const onSeal = activeCallout('player', ctx.device, ctx.tokens);
  const world = activeCallout('world', ctx.device, ctx.tokens);

  // `bandFade` and not `tipFade`: the band is shared. The coach owns it for a
  // control tip and the hello at the top of a run owns it for the first couple
  // of seconds (systems/greeting.js), and each has its own dissolve — main.js
  // hands over whichever belongs to the line that is actually up. The world
  // surface has only ever had one owner, so it still reads `tipFade`.
  drawBand(band, ctx.bandFade ?? ctx.tipFade);
  drawOnSeal(onSeal, ctx);
  const worldPose = drawWorld(world, ctx);

  // The arrow belongs to the world tip and to nothing else now — see the note
  // in the header. It is drawn only when the label it would duplicate is off
  // the edge of the frame.
  drawArrow(dt, world, worldPose, ctx);
}

// ---------------------------------------------------------------------------
// KEEPING OUT OF THE HUD
// ---------------------------------------------------------------------------

/**
 * The furniture a callout may not cover, as selectors.
 *
 * FIXED CHROME ONLY, and the omissions are the design.
 *
 * THE HEALTH AND AIR GAUGES ARE HERE IN ONE PLACEMENT AND NOT THE OTHER, which
 * is the whole rule in one line. Beside the seal (settings.hud.barPlacement
 * 'seal') they RIDE THE ANIMAL, so a band that avoided them would slide up and
 * down the screen as it swam — a worse read than a moment of overlap, and the
 * kind of motion nobody can trace back to a rule. In the corner placement, which
 * is the default, the same element is a fixed column up the right-hand side of
 * the glass and is exactly what this list is for. Hence the class, not the
 * container: `.sv-playerbars-corner` names the mode that holds still.
 * Same reasoning keeps the on-seal callout itself out. The toast layer is out
 * for a related reason — toasts come and go in under a second, and a band that
 * flinched every time one arrived would never be still.
 *
 * `.sv-print` is each individual polaroid rather than `.sv-print-layer` or
 * `.sv-print-pile`, both of which are `inset: 0` and would report the whole
 * screen as occupied.
 */
const CHROME = ['.sv-bossbar', '.sv-xptop', '.sv-xptop-level', '.sv-hud-corner',
  '.sv-playerbars-corner', '.sv-print'];

// Rects, gathered fresh. Deliberately not cached: this runs only on the frames
// a callout is actually on screen — a few seconds per run — and everything it
// measures moves. The boss bar arrives mid-fight and animates its own width,
// prints fly in and park, and the whole HUD reflows on a rotate. A cache would
// be right about the common case and wrong about every case that matters.
function chromeRects(layer) {
  const root = layer?.ownerDocument ?? document;
  const out = [];
  for (const node of root.querySelectorAll(CHROME.join(','))) {
    // Hidden furniture is not furniture. The boss bar exists in the DOM for
    // the whole run and is only on screen during a fight.
    if (node.classList.contains('sv-hidden')) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push(r);
  }
  return out;
}

/**
 * Move `top` until a box of `height` centred on the screen's width does not sit
 * on any of the chrome it overlaps horizontally. Returns the new top.
 *
 * PUSHES AWAY FROM WHICHEVER SIDE THE FURNITURE IS ON — down past a boss bar,
 * up above a score corner — rather than always downward, because the two live
 * at opposite ends of the screen and on a phone the corner is at the BOTTOM.
 * A one-directional nudge would clear the bar by shoving the line onto the
 * score.
 *
 * Iterated a few times because clearing one piece can push into another (the
 * boss bar down onto a print), and capped rather than looped to convergence: a
 * screen with no clear space at all would spin forever, and the honest answer
 * there is "the best position found", not a hang.
 */
function keepOffChrome(top, height, width, centreX, rects, gap) {
  const H = window.innerHeight;
  // Both surfaces are centred on their own anchor (translateX(-50%)), but not
  // on the SAME anchor: the band is centred on the screen and the on-seal line
  // on the animal. Passed in rather than assumed, because assuming the screen
  // would have the seal's line testing a column of chrome it is nowhere near —
  // and clearing furniture it was never going to touch.
  const left = centreX - width / 2;
  const right = left + width;
  let y = top;

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const r of rects) {
      // Only what is actually in the line's way. A score panel in the corner of
      // a wide screen shares no columns with a centred band and is none of its
      // business.
      if (r.right <= left || r.left >= right) continue;
      if (r.bottom <= y || r.top >= y + height) continue;
      // Whichever way is nearer out. Measured against the OVERLAP rather than
      // against screen halves, so a tall print down the side of a short screen
      // is escaped by the shorter move instead of by a rule about where things
      // usually are.
      const down = r.bottom + gap;
      const up = r.top - gap - height;
      y = (Math.abs(down - y) <= Math.abs(up - y)) ? down : up;
      moved = true;
    }
    if (!moved) break;
  }

  // Never off the screen itself. A band pushed above the top edge by a piece of
  // chrome it could not clear is a line nobody reads at all, which is strictly
  // worse than the overlap it was avoiding.
  return Math.max(gap, Math.min(y, H - height - gap));
}

// ---------------------------------------------------------------------------
// THE WORLD TIP
// ---------------------------------------------------------------------------

/**
 * The label beside the thing. Returns the pose it drew with, or null, so the
 * arrow can ride the same arrival curve.
 *
 * `ctx.tipAnchor` is a WORLD position handed in by the frame loop — the live
 * position of whatever systems/tutorial.js locked onto, or the last place it
 * was if it has since been collected. There is deliberately no fallback: a tip
 * on this surface with no anchor is a bug in the coach, and drawing it in the
 * middle of the screen would hide that bug behind something that looks fine.
 */
function drawWorld(callout, ctx) {
  if (!callout || !ctx.camera || !ctx.tipAnchor) {
    if (worldEl && !worldEl.classList.contains('sv-hidden')) {
      worldEl.classList.add('sv-hidden');
      clearTipDissolve(worldInkEl);
    }
    // A parked position belongs to ONE sentence. Left behind, the next tip
    // would open in the last one's spot — beside nothing — and only slide onto
    // its own subject if that subject happened to be on screen.
    worldPark = null;
    worldParkFor = '';
    return null;
  }
  if (worldInkEl.textContent !== callout.text) worldInkEl.textContent = callout.text;
  if (worldParkFor !== callout.text) {
    worldPark = null;
    worldParkFor = callout.text;
  }

  worldToScreen(ctx.camera, ctx.tipAnchor.x, ctx.tipAnchor.y, anchorPt);

  const w = CONFIG.callouts?.world ?? {};
  const gap = w.gap ?? 46;
  const box = worldEl.offsetWidth;
  const h = worldEl.offsetHeight;
  const uiGap = CONFIG.callouts?.uiGap ?? 10;

  // ABOVE THE THING BY DEFAULT, BELOW IT NEAR THE TOP OF THE SCREEN. Not a
  // preference — a subject in the top eighth of the frame has no room above it,
  // and a label clamped to the ceiling sits ON its own subject, which is the
  // one place it must never be. Bubbles rise, so this flip is the common case
  // rather than an edge one.
  const wantAbove = anchorPt.y - gap - h > uiGap;
  const wantTop = wantAbove ? anchorPt.y - gap - h : anchorPt.y + gap;
  const wantLeft = anchorPt.x - box / 2;

  // IT FOLLOWS ITS SUBJECT WHILE BOTH FIT, AND THEN IT STAYS PUT.
  //
  // This used to be a clamp: the box was pushed back inside the frame every
  // frame, so a player swimming away from the thing dragged the sentence with
  // them and it lived out its stay pinned to the edge of the screen, sliding
  // up and down the border as the camera moved. That reads as a piece of UI
  // that has attached itself to you — the opposite of a label standing beside
  // something in the water — and it is at its worst on a phone, where the
  // border is a thumb's width from the middle.
  //
  // So the clamp is now a PARK. While the whole box is on the glass it rides
  // its subject as before; the first frame it would not fit, it freezes where
  // it last stood and holds there. Swim back and it picks its subject up again.
  //
  // The tip is allowed to leave the screen with the thing it is about — that
  // is what the words following the object MEANS — and the one case that would
  // be a bug is the sentence vanishing the instant somebody swims off, which
  // is exactly what parking prevents: the last position is always a position
  // that fitted.
  const maxLeft = Math.max(uiGap, window.innerWidth - box - uiGap);
  const maxTop = Math.max(uiGap, window.innerHeight - h - uiGap);
  const fits = wantLeft >= uiGap && wantLeft <= maxLeft && wantTop >= uiGap && wantTop <= maxTop;

  let left;
  let top;
  let above;
  if (fits) {
    left = wantLeft;
    top = wantTop;
    above = wantAbove;
    worldPark = { left, top, above };
  } else if (worldPark) {
    ({ left, top, above } = worldPark);
  } else {
    // NEVER STOOD ANYWHERE YET — the tip opened on a subject already off the
    // edge. Clamped once, and parked at that, so it is readable from its first
    // frame and still never slides.
    left = clamp(wantLeft, uiGap, maxLeft);
    top = clamp(wantTop, uiGap, maxTop);
    above = wantAbove;
    worldPark = { left, top, above };
  }
  // The HUD is still checked every frame, parked or not: the boss bar arrives
  // mid-fight, and a sentence standing still under one is no more readable for
  // having held its ground.
  const y = keepOffChrome(top, h, box, left + box / 2, chromeRects(worldEl), uiGap);
  labelPt.x = left + box / 2;
  labelPt.y = y + h / 2;

  // Infinity, for the reason spelled out in drawBand: a pinned tip has no life,
  // so the motion block's departure window must never open. Its exit is the
  // dissolve below.
  const pose = popupPose(callout.motion, callout.age, Infinity);
  worldEl.style.left = `${left}px`;
  worldEl.style.top = `${y + pose.lift}px`;
  // No -50% here, unlike the band: the left edge is already the resolved one,
  // and centring on top of it would move the box away from the position the
  // park and the chrome pass between them just settled on.
  worldEl.style.transform = `scale(${pose.scale})`;
  // `above` and not `wantAbove`: a parked tip grows out of the side it was
  // actually standing on, not the side its subject is on now that the subject
  // is somewhere off the screen.
  worldEl.style.transformOrigin = above ? 'center bottom' : 'center top';
  worldEl.style.opacity = `${pose.alpha}`;
  applyBloom(worldEl, pose.bloom);
  worldEl.classList.remove('sv-hidden');

  // AND THE DISSOLVE, on the inner node. `tipFade` is 0 for the whole time the
  // tip is simply standing there, and applyTipDissolve short-circuits on that —
  // so the ordinary case costs one comparison and leaves plain text behind.
  dissolve(worldInkEl, ctx.tipFade);
  return pose;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Returns the pose it drew with. Nothing rides it any more — the arrow belongs
// to the world tip now — but the value is what makes the function testable
// without a screen, and it is how the band's own curve is asserted.
//
// `fade` is how far through leaving a COACH line is, and is ignored for a
// warning. Both surfaces take it from the same place (tutorialState.fade), so
// the two can never disagree about whether a tip is on its way out.
function drawBand(callout, fade) {
  if (!callout) {
    bandEl.classList.add('sv-hidden');
    clearTipDissolve(bandInkEl);
    return null;
  }
  const coach = callout.kind === 'coach';
  const cls = coach ? 'sv-callout sv-callout-coach' : 'sv-callout';
  if (bandEl.className !== cls) bandEl.className = cls;
  if (bandInkEl.textContent !== callout.text) bandInkEl.textContent = callout.text;

  // A WARNING'S LIFE IS ITS ROW'S HOLD, so the departure curve starts the right
  // distance from the end however long that line was given.
  //
  // A TIP HAS NO LIFE AT ALL, and this is the whole bug that made the first
  // version of the dissolve look like the text was simply being hidden. Every
  // coach line is now PINNED until the coach lets go of it (see pinCallout),
  // so its age runs past its hold — and the motion block's out window,
  // measured backwards from the end of life, therefore opened while the line
  // was still meant to be readable and took the alpha to zero. The tip was
  // then invisible for the rest of its stay, and the dissolve that followed
  // played out perfectly on an element nobody could see.
  //
  // The exit of a tip is the DISSOLVE, and nothing else: Infinity keeps the
  // out window permanently shut (ease() clamps, so its terms stay identities)
  // and `tipFade` does all of the leaving.
  const pose = popupPose(callout.motion, callout.age, coach ? Infinity : callout.hold);
  const y = (CONFIG.callouts?.y ?? 0.26) * window.innerHeight;

  // WHERE IT WANTS TO BE, then where it may be. offsetWidth/offsetHeight and
  // not getBoundingClientRect: the box is scaled by the arrival curve, and a
  // measured rect would be a fraction of its size on the frame it appears —
  // so the line would clear the boss bar comfortably at scale 0.2 and then
  // grow straight back into it.
  const h = bandEl.offsetHeight;
  const w = bandEl.offsetWidth;
  const gap = CONFIG.callouts?.uiGap ?? 10;
  // `lift` is part of the arrival, not part of where it lives, so it is added
  // AFTER the clamp: folding it in would let a line drift back onto the HUD
  // for the few frames the curve is lifting it.
  const top = keepOffChrome(y - h / 2, h, w, window.innerWidth / 2, chromeRects(bandEl), gap);
  bandEl.style.top = `${top + h / 2 + pose.lift}px`;
  bandEl.style.transform = `translate(-50%, -50%) scale(${pose.scale})`;
  bandEl.style.opacity = `${pose.alpha}`;
  applyBloom(bandEl, pose.bloom);
  bandEl.classList.remove('sv-hidden');
  // The control tips dissolve like every other piece of tutorial text. A
  // warning never does — an alarm that eroded into the water would be reading
  // the room exactly backwards.
  dissolve(bandInkEl, coach ? fade : 0);
  return pose;
}

/**
 * Put one node `fade` of the way through leaving.
 *
 * THE CLOCK IS THE DISSOLVE'S OWN ELAPSED TIME, not a clock this file keeps.
 * That was the whole of the bug where a dissipating tip was simply invisible:
 * the flow is an offset applied to a noise field that only exists inside the
 * filter's region, so a clock running since the page loaded slides the field
 * clean out of that region within a minute and the tip composites to nothing.
 * Progress times the tuned length is bounded by construction, and it is also
 * the honest reading — the water moves while the sentence is leaving, and there
 * is nothing to animate before that.
 *
 * Style and numbers are read per frame rather than latched, so the pill in the
 * Text panel changes the next tip without a reload.
 */
function dissolve(node, fade) {
  const d = CONFIG.tutorial?.dissipate ?? {};
  const t = fade ?? 0;
  applyTipDissolve(node, d.style ?? 'current', t, t * (d.seconds ?? 0.7), d);
}

// The small line above the boost ring. Positioned from the RING rather than
// from the seal (see CONFIG.callouts.ringGap) so it stays on the instrument it
// is about however that instrument has been scaled or nudged.
function drawOnSeal(callout, ctx) {
  if (!callout || !ctx.camera) {
    boostEl.classList.add('sv-hidden');
    return;
  }
  // WHICH OF THE RING'S TWO LINES THIS IS. They share the node — one slot, one
  // element, the same reason the band's coach tip does — and the strike prompt
  // stacks a second class on top, exactly as `sv-callout-coach` does over
  // `sv-callout`. `motion` and not the id: systems/callouts.js already decided
  // which voice the row speaks in, and asking again here is how the type and
  // the timing curve end up disagreeing about what kind of line this is.
  const chainVoice = callout.motion === 'strikeNow';
  const cls = chainVoice ? 'sv-callout-boost sv-callout-strike' : 'sv-callout-boost';
  if (boostEl.className !== cls) boostEl.className = cls;
  // THE LIVE CHAIN'S OWN COLOUR, per frame, off the same wheel as the FOOD
  // CHAIN! banner and the ring's combo arc — so the prompt tells you which
  // link you are about to add before it has told you anything else. Cleared
  // again on the gauge's line, or "Boost Empty!" would inherit whatever hue
  // the last chain died on and the role's own gold would never be seen.
  boostEl.style.color = chainVoice ? liveChainCss() : '';
  if (boostEl.textContent !== callout.text) boostEl.textContent = callout.text;

  const ring = CONFIG.strike?.ring ?? {};
  const top = (ctx.playerY ?? 0)
    + (ring.offsetY ?? 0)
    + (ring.radius ?? 1.9) * (ring.scale ?? 1)
    + (CONFIG.callouts?.ringGap ?? 0.55);
  worldToScreen(ctx.camera, (ctx.playerX ?? 0) + (ring.offsetX ?? 0), top, anchorPt);

  const pose = popupPose(callout.motion, callout.age, callout.hold);
  // KEPT OFF THE HUD TOO, and it needs it more than the band does: this line
  // rides the seal, so it goes wherever the animal goes — and a seal at the
  // surface puts it straight through the boss bar, during a boss fight, which
  // is the only time both are on screen.
  //
  // Clamped in the axis it hangs in. The box hangs UPWARD off the anchor
  // (translate -100%), so its top is anchor - height, and what is clamped is
  // that top edge; the left is left alone, because this line's whole job is to
  // be above the ring and a horizontal nudge would take it off the instrument
  // it is reporting on.
  const bh = boostEl.offsetHeight;
  const bw = boostEl.offsetWidth;
  const bgap = CONFIG.callouts?.uiGap ?? 10;
  const btop = keepOffChrome(anchorPt.y - bh, bh, bw, anchorPt.x, chromeRects(boostEl), bgap);
  boostEl.style.left = `${anchorPt.x}px`;
  boostEl.style.top = `${btop + bh + pose.lift}px`;
  // translate(-50%,-100%) rather than -50%: the anchor is the point the line
  // must sit ABOVE, so the box hangs upward off it. Centring it on the anchor
  // would put half the text through the top of the ring.
  boostEl.style.transform = `translate(-50%, -100%) scale(${pose.scale})`;
  boostEl.style.opacity = `${pose.alpha}`;
  applyBloom(boostEl, pose.bloom);
  boostEl.classList.remove('sv-hidden');
}

// The halo the motion block asks for, on top of whatever the text role's own
// glow already draws. A filter rather than another text-shadow term: the role
// sheet owns `text-shadow` outright (ui/typography.js rebuilds it whenever the
// Text panel moves), and a second writer on that property is the bug where one
// of them silently never wins.
function applyBloom(node, px) {
  node.style.filter = px > 0.05 ? `drop-shadow(0 0 ${px.toFixed(1)}px currentColor)` : 'none';
}

function drawArrow(dt, callout, worldPose, ctx) {
  const target = callout && ctx.tipAnchor ? ctx.tipAnchor : null;
  if (!target || !ctx.camera || !worldPose || !subjectInFrame(ctx, target)) {
    arrowEl.classList.add('sv-hidden');
    arrowHasAim = false;
    return;
  }

  const a = CONFIG.callouts?.arrow ?? {};
  worldToScreen(ctx.camera, target.x, target.y, targetPt);

  // WHICH SIDE THE WORDS ARE ON. The arrow stands between the sentence and its
  // subject — that is what makes the two read as one object rather than as a
  // label and a separate mark that happen to be near each other — so the whole
  // of its placement is this one direction, taken from the box the tip was
  // drawn in on this same frame.
  const dx = labelPt.x - targetPt.x;
  const dy = labelPt.y - targetPt.y;
  // Under a pixel apart is a label sitting exactly on top of its subject, which
  // the world tip's own gap makes very nearly impossible; there is no side to
  // be had, so the arrow keeps the one it had rather than snapping to whatever
  // atan2 makes of the noise. With no previous aim at all it points DOWN at the
  // thing, which is where a tip stands by default.
  if (dx * dx + dy * dy > 1 || !arrowHasAim) {
    // The aim points FROM the arrow INTO the subject, so it is the way back
    // down the side vector.
    const want = (dx * dx + dy * dy > 1) ? Math.atan2(-dy, -dx) : Math.PI / 2;
    if (!arrowHasAim) {
      arrowAngle = want;
      arrowHasAim = true;
    } else {
      // Shortest way round, or an arrow crossing from just under -π to just
      // over +π takes the long way and spins a full turn on screen.
      let delta = want - arrowAngle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      arrowAngle += delta * (1 - Math.exp(-(a.turnRate ?? 9) * dt));
    }
  }

  const pose = worldPose;
  // The bob runs along the aim, so the glyph nudges at the thing and backs off
  // again rather than sliding around it.
  const bob = Math.sin(bobClock * (a.bobSpeed ?? 2.4) * Math.PI * 2) * (a.bobDistance ?? 9) * 0.5;
  const dist = Math.max(1, (a.hug ?? 26) + bob);
  const size = a.size ?? 28;
  // Backwards along the aim from the subject, so the glyph's CENTRE is `hug`
  // pixels off the thing on the side the sentence is on — which puts its nose
  // about half a glyph nearer than that and its tail still short of the words.
  // Centre and not nose because the box is what is positioned, and a nose
  // offset would have to be re-derived every time the size slider moved.
  const px = targetPt.x - Math.cos(arrowAngle) * dist;
  const py = targetPt.y - Math.sin(arrowAngle) * dist;

  arrowEl.style.width = `${size}px`;
  arrowEl.style.height = `${size}px`;
  arrowEl.style.left = `${px - size / 2}px`;
  arrowEl.style.top = `${py - size / 2}px`;
  // The glyph points UP at rest, so the bearing is rotated a quarter turn to
  // put its nose along the aim.
  arrowEl.style.transform = `rotate(${arrowAngle + Math.PI / 2}rad) scale(${pose.scale})`;
  arrowEl.style.color = `#${((a.color ?? 0x9fe3ff) >>> 0).toString(16).padStart(6, '0')}`;
  arrowEl.style.filter = (a.glow ?? 0) > 0 ? `drop-shadow(0 0 ${a.glow}px currentColor)` : 'none';
  // Rides the line's own fade, so the pair arrive and leave together instead of
  // the arrow outliving the sentence that explains it.
  arrowEl.style.opacity = `${pose.alpha * (a.alpha ?? 0.9)}`;
  arrowEl.classList.remove('sv-hidden');
}

/**
 * Is the subject somewhere the arrow can hug it?
 *
 * The arrow marks the THING, from a few pixels off it, so the only question is
 * whether the thing is on the glass at all. A subject that has left the frame
 * gets no arrow: the glyph would sit against the border pointing at water the
 * player cannot see, which is the long-range pointer this used to be and the
 * one behaviour it is not for. The tip's own words hold their place in that
 * case (see drawWorld) and that is the whole of the answer.
 *
 * Half a glyph of margin so the mark is never drawn hanging over the edge.
 *
 * A DEGENERATE PROJECTION answers "on screen" and draws an arrow beside a
 * label that is also in the middle of the screen — wrong, but wrong in one
 * place, which beats a mark parked at the border pointing nowhere.
 */
function subjectInFrame(ctx, target) {
  worldToScreen(ctx.camera, target.x, target.y, targetPt);
  const m = (CONFIG.callouts?.arrow?.size ?? 28) / 2;
  return targetPt.x >= m && targetPt.x <= window.innerWidth - m
    && targetPt.y >= m && targetPt.y <= window.innerHeight - m;
}
