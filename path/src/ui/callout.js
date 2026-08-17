import { CONFIG } from '../config.js';
import { activeCallout } from '../systems/callouts.js';
import { popupPose, worldToScreen } from './ui.js';

// ---------------------------------------------------------------------------
// DRAWING THE CALLOUTS: two lines, in two places, and the arrow under them.
//
// THREE NODES FOR THE WHOLE FEATURE, all reused forever. A warning fires
// several times a minute in a bad run and a tip is a once-per-device event, so
// there is never more than one line per surface (systems/callouts.js is the
// reason) and building a node per callout would be churn for nothing.
//
// THE TWO SURFACES ARE DIFFERENT KINDS OF MESSAGE, which is why they are drawn
// differently rather than being one function with a position argument:
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
//
// THE ARROW IS AIMED IN SCREEN SPACE, from the seal's projected position toward
// the target's. Doing it in world space and rotating the result is the obvious
// alternative and it is wrong here: the camera rolls and zooms (see
// cineCamera.js), so a world-space bearing drawn onto a screen-space overlay
// would drift off the thing it is pointing at exactly during a strike, which is
// when the arrow is up. Projecting both ends means the arrow is correct by
// construction whatever the lens is doing.
//
// A TARGET BEHIND THE CAMERA is the one case projection cannot answer — the
// projected point flips to the far side of the screen and the arrow points
// backwards. It cannot happen for either target we have (chum is in the same
// plane as the seal, the surface is straight up from it), so rather than carry
// a guard that is never exercised, the arrow simply holds its last bearing when
// the two projected points land on top of each other.
//
// LAYERED ABOVE THE MENUS, unlike the toast layer. A callout that was up when
// the cards opened has to play out where it can be read, and a band that a menu
// can cover would finish behind it. Safe because nothing here takes
// pointer events — the band cannot swallow a click on a card underneath it.
// ---------------------------------------------------------------------------

const STYLES = `
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

  /* The arrow is drawn as one SVG path so it scales cleanly and takes a glow in
     its own colour the same way the type does. left/top are written per frame;
     the transform carries the aim and the bob. */
  .sv-callout-arrow { position: absolute; left: 0; top: 0; pointer-events: none;
    will-change: transform, opacity; }
`;

let layer = null;
let bandEl = null;
let boostEl = null;
let arrowEl = null;

// The arrow's live bearing, eased toward the one it is asked for. Kept across
// frames — that easing is the whole reason a re-target reads as this arrow
// turning rather than as a different arrow appearing.
let arrowAngle = 0;
let arrowHasAim = false;
let bobClock = 0;

const screenPt = { x: 0, y: 0 };
const targetPt = { x: 0, y: 0 };
const anchorPt = { x: 0, y: 0 };
const orbitPt = { x: 0, y: 0 };

export function initCallouts(root) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  layer = document.createElement('div');
  layer.className = 'sv-callout-layer';

  bandEl = document.createElement('div');
  bandEl.className = 'sv-callout sv-hidden';
  layer.appendChild(bandEl);

  boostEl = document.createElement('div');
  boostEl.className = 'sv-callout-boost sv-hidden';
  layer.appendChild(boostEl);

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
  boostEl.classList.add('sv-hidden');
  arrowEl.classList.add('sv-hidden');
  arrowHasAim = false;
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

  const bandPose = drawBand(band);
  drawOnSeal(onSeal, ctx);

  // The arrow belongs to whichever line asked for one, the band first. Only one
  // exists because only one is ever wanted: two arrows off the same seal
  // pointing two ways is not guidance, it is a decision to make under fire.
  const owner = band?.arrow ? band : (onSeal?.arrow ? onSeal : null);
  drawArrow(dt, owner, owner === band ? bandPose : null, ctx);
}

// Returns the pose it drew with, so the arrow can ride the same fade.
function drawBand(callout) {
  if (!callout) {
    bandEl.classList.add('sv-hidden');
    return null;
  }
  const coach = callout.kind === 'coach';
  const cls = coach ? 'sv-callout sv-callout-coach' : 'sv-callout';
  if (bandEl.className !== cls) bandEl.className = cls;
  if (bandEl.textContent !== callout.text) bandEl.textContent = callout.text;

  // The row's own hold is the life, so the departure curve starts the right
  // distance from the end however long this particular line was given.
  const pose = popupPose(callout.motion, callout.age, callout.hold);
  const y = (CONFIG.callouts?.y ?? 0.26) * window.innerHeight;
  bandEl.style.top = `${y + pose.lift}px`;
  bandEl.style.transform = `translate(-50%, -50%) scale(${pose.scale})`;
  bandEl.style.opacity = `${pose.alpha}`;
  applyBloom(bandEl, pose.bloom);
  bandEl.classList.remove('sv-hidden');
  return pose;
}

// The small line above the boost ring. Positioned from the RING rather than
// from the seal (see CONFIG.callouts.ringGap) so it stays on the instrument it
// is about however that instrument has been scaled or nudged.
function drawOnSeal(callout, ctx) {
  if (!callout || !ctx.camera) {
    boostEl.classList.add('sv-hidden');
    return;
  }
  if (boostEl.textContent !== callout.text) boostEl.textContent = callout.text;

  const ring = CONFIG.strike?.ring ?? {};
  const top = (ctx.playerY ?? 0)
    + (ring.offsetY ?? 0)
    + (ring.radius ?? 1.9) * (ring.scale ?? 1)
    + (CONFIG.callouts?.ringGap ?? 0.55);
  worldToScreen(ctx.camera, (ctx.playerX ?? 0) + (ring.offsetX ?? 0), top, anchorPt);

  const pose = popupPose(callout.motion, callout.age, callout.hold);
  boostEl.style.left = `${anchorPt.x}px`;
  boostEl.style.top = `${anchorPt.y + pose.lift}px`;
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

function drawArrow(dt, callout, bandPose, ctx) {
  const target = callout ? arrowTarget(callout.arrow, ctx, callout.id) : null;
  if (!target || !ctx.camera) {
    arrowEl.classList.add('sv-hidden');
    arrowHasAim = false;
    return;
  }

  const a = CONFIG.callouts?.arrow ?? {};
  worldToScreen(ctx.camera, ctx.playerX ?? 0, ctx.playerY ?? 0, screenPt);
  worldToScreen(ctx.camera, target.x, target.y, targetPt);

  const dx = targetPt.x - screenPt.x;
  const dy = targetPt.y - screenPt.y;
  // Under a pixel apart is the seal sitting on the thing it is being pointed
  // at: there is no bearing to be had, so the arrow keeps the last one rather
  // than snapping to whatever atan2 makes of the noise.
  if (dx * dx + dy * dy > 1) {
    const want = Math.atan2(dy, dx);
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

  const pose = bandPose ?? popupPose(callout.motion, callout.age, callout.hold);
  const bob = Math.sin(bobClock * (a.bobSpeed ?? 2.4) * Math.PI * 2) * (a.bobDistance ?? 9) * 0.5;
  const dist = orbitRadiusPx(ctx) + bob;
  const size = a.size ?? 28;
  const px = screenPt.x + Math.cos(arrowAngle) * dist;
  const py = screenPt.y + Math.sin(arrowAngle) * dist;

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
 * How far off the seal the arrow orbits, IN PIXELS, worked out from a world
 * distance so it clears the seal's own furniture at any zoom and at any setting
 * of that furniture (see CONFIG.callouts.arrow.gap).
 *
 * The conversion is done by projecting a point that far above the seal and
 * measuring, rather than by reaching into the camera for a units-per-pixel
 * factor. That is not the long way round — it is the only way that survives a
 * camera which is not a plain unrotated orthographic one, and this HUD already
 * runs under a lens that zooms and rolls.
 */
function orbitRadiusPx(ctx) {
  const a = CONFIG.callouts?.arrow ?? {};
  const ring = CONFIG.strike?.ring ?? {};
  const furniture = Math.max(
    CONFIG.hud?.playerBarOffset ?? 0,
    (ring.radius ?? 0) * (ring.scale ?? 1),
  );
  const world = furniture + (a.gap ?? 2);
  // Its own scratch point, not the one the aim is using: this runs AFTER the
  // bearing has been taken today, and a shared buffer would make that ordering
  // load-bearing for no reason.
  worldToScreen(ctx.camera, ctx.playerX ?? 0, (ctx.playerY ?? 0) + world, orbitPt);
  const dx = orbitPt.x - screenPt.x;
  const dy = orbitPt.y - screenPt.y;
  // A degenerate projection (a camera looking down the plane) would collapse
  // this to zero and park the arrow inside the seal. The floor is the size of
  // the glyph, so the worst case is an arrow touching the animal rather than
  // one hidden inside it.
  return Math.max(a.size ?? 28, Math.hypot(dx, dy));
}

// Where the row said to point, as a world position — or null, which is both
// "this row has no arrow" and "it has one but there is nothing to aim it at".
// The second case is real: the chum arrow's target can be eaten by a crab
// mid-tip, and an arrow left pointing at where it used to be is worse than no
// arrow at all.
function arrowTarget(kind, ctx, id) {
  if (kind === 'chum') return ctx.nearestChum?.(ctx.playerX ?? 0, ctx.playerY ?? 0) ?? null;
  // THE ONLY ARROW THAT ASKS WHICH ROW IS ASKING, and it has to. There is one
  // tip per pickup type and they all point with `arrow: pickup`, so the target
  // is decided by the ROW'S OWN ID — the id, the step, the callouts row and the
  // orb's name in assets.js are deliberately one string end to end. The
  // alternative, a `pickup:bubbleOrb` arrow value or five arrow targets, would
  // be the same name written twice per row with nothing stopping them
  // disagreeing.
  if (kind === 'pickup') return ctx.nearestPickup?.(ctx.playerX ?? 0, ctx.playerY ?? 0, id) ?? null;
  if (kind === 'surface') {
    // Straight up, at the waterline. Not at the seal's own x offset by
    // anything: "up" is the entire content of this arrow, and aiming it at a
    // point on the surface some distance away would read as pointing at a
    // place rather than in a direction.
    if (ctx.surfaceY == null) return null;
    return { x: ctx.playerX ?? 0, y: ctx.surfaceY };
  }
  if (kind === 'seabed') {
    // Straight down, for the same reason and in the same way. Deliberately NOT
    // the nearest orb on the floor: the tip it serves is about where chum ENDS
    // UP, which is a place the player has to learn is down there at all, and an
    // arrow that swung sideways to whichever piece happened to have landed
    // would be teaching a pickup instead of a direction.
    if (ctx.seabedY == null) return null;
    return { x: ctx.playerX ?? 0, y: ctx.seabedY };
  }
  return null;
}
