// The loading screen: bubbles vortexing around a thin bar.
//
// This used to be the word "Loading" centred on black, which was honest when
// boot was one `await preloadAssets()` and nothing else. It is not any more —
// the shader warm-up (systems/shaderWarmup.js) deliberately spends seconds
// before the menu so that the run doesn't spend them one stall at a time, and
// a wait you have chosen to make longer is exactly the wait that has to show
// its working.
//
// The bar is drawn INSIDE the canvas rather than as DOM, and that is the whole
// design. Bubbles wrap around the bar, which means half of every orbit passes
// behind it — and "behind" only exists if one surface owns the draw order.
// Back half, bar, front half, in that order. As DOM this would need the bar
// split into two stacked copies with the bubbles sorted into layers between
// them, which is the same painter's algorithm with worse seams.
//
// No assets and no WebGL: this is on screen before either exists. Everything
// here is 2D canvas and arithmetic, so it starts on the first frame of boot,
// before three.js has parsed a single model.

import { uiText } from '../uiTextTable.js';
import { LOAD_TIPS, tipsForDevice, tipOrder } from '../loadTipTable.js';
import { textForDevice } from '../deviceText.js';
import { fillBindings, checkBindingText } from '../systems/bindingText.js';
import { defaultDevice } from '../devices.js';

// LAYOUT ONLY, AND THAT IS A CONTRACT. Everything about the TYPE on this
// screen — family, size, weight, tracking, case, colour, shadow, glow — is the
// `loadTip` and `loadCaption` rows of textRoles.js, designed in the Text panel
// (Y) like every other voice in the game. This sheet owns where the lines sit,
// how wide they may be, what height is reserved for them and how they arrive.
//
// The two must stay DISJOINT. This sheet is filed under the role sheet (see
// installStyleBelowRoles in ui/typography.js, and the insert in showLoading
// below), so a `font-size` left in here would be the same specificity and
// EARLIER — which means the panel would look like it worked, save the value,
// and change nothing. That is the exact failure the role system's own header
// describes for the font picker.
const STYLES = `
  .sv-load { position: fixed; inset: 0; z-index: 20; display: flex;
    align-items: center; justify-content: center;
    background: radial-gradient(120% 90% at 50% 40%, #0d2033 0%, #060b14 100%); }

  /* The lane is only a positioning box now — nothing is drawn in DOM. Taller
     than the bar it contains, because the vortex needs room above and below to
     be a vortex rather than a row of dots. */
  .sv-load-lane { position: relative; width: min(340px, 62vw); height: 48px; }
  .sv-load-lane canvas { display: block; width: 100%; height: 100%; }

  /* THE RESUME CAPTION — the only difference between coming back to a run and
     starting the game, and the reason it exists at all.
     
     A WebContent kill reloads the page, so the wait a resumed player sits
     through is the SAME wait as a cold boot: the same bar, the same seconds,
     the same vortex. Without a word on it, the safety net's best case still
     reads as the app restarting itself — the run does come back, but only
     after the player has already concluded it didn't.
     
     Stacked UNDER the lane and absolutely positioned, so the bar stays exactly
     where it is on both screens. A caption that pushed the vortex up would
     make the two screens different compositions, and the point is that this is
     the same screen with something to say. */
  .sv-load-cap { position: absolute; left: 50%; top: calc(100% + 14px);
    transform: translateX(-50%); line-height: 1.4; text-align: center;
    /* NOT nowrap any more. It was safe while this was 13px of Inter and is a
       clipped line the moment the panel is set to a display face at 1.15 —
       the caption would run off both edges of a phone with nothing to say it
       had. Bounded and centred instead, so a longer line wraps under itself.
       Top-anchored, so the wrap grows DOWNWARD away from the bar. */
    width: max-content; max-width: min(30rem, 84vw);
    /* Fades in rather than appearing with the bar. The first moments of the
       screen are identical to a normal boot on purpose — this arrives a beat
       later, the way a line of explanation does. */
    opacity: 0; animation: sv-load-cap-in 420ms ease-out 260ms forwards; }

  @keyframes sv-load-cap-in { to { opacity: 1; } }

  /* THE QUICK TIPS — loadTips.csv, rotating above the bar.
  
     ABOVE, and the caption is below, because the two are different registers
     and the bar must not move between them. The caption is status ("your run
     is coming back"); a tip is the thing you are meant to READ, so it takes
     the position the eye lands on first and the caption keeps the footnote
     slot it already had. Stacking both underneath would either collide on a
     resume or push the vortex off centre on every boot, and the whole point of
     the caption's own note above is that the two screens are one composition.
  
     Absolutely positioned, out of flow, for that same reason: a tip that wraps
     to two lines on a phone must not shift the bar a pixel. */
  .sv-load-tip { position: absolute; left: 50%; bottom: calc(100% + 24px);
    transform: translateX(-50%); width: min(30rem, 84vw); text-align: center;
    line-height: 1.5;
    /* BOTTOM-ANCHORED, which is what makes the height safe to leave free. The
       box grows UPWARD as a tip wraps, so the last line always sits the same
       distance above the bar and a three-line tip in a display face pushes
       into empty screen rather than into the vortex. The min-height is in em,
       so it tracks whatever size the panel is set to: it reserves two lines'
       worth, which stops a one-line tip following a two-line one from jumping
       the block mid-rotation. */
    min-height: 2.8em; display: flex; align-items: flex-end;
    justify-content: center; pointer-events: none; }

  /* The fade is on an inner node rather than on the box, so the reserved
     height above stays reserved while the words are invisible. */
  .sv-load-tip-line { opacity: 0; transform: translateY(4px);
    transition: opacity 420ms ease-out, transform 420ms ease-out; }
  .sv-load-tip-line.is-up { opacity: 1; transform: none; }

  @media (prefers-reduced-motion: reduce) {
    /* No fade: the caption is information, and the one thing reduced motion
       must never do is withhold it. */
    .sv-load-cap { opacity: 1; animation: none; }
    /* The tips still ROTATE under reduced motion — they are information too,
       and withholding three of four lines would be the same mistake. What goes
       is the movement between them: they cut. */
    .sv-load-tip-line { transition: none; transform: none; }
    .sv-load-tip-line.is-up { transform: none; }
  }
`;

// --- the scene, in CSS pixels ----------------------------------------------
// The bar is a horizontal axis through the middle of the canvas; every bubble
// orbits that axis. Depth is cos(theta), so a bubble is in front at theta 0 and
// behind at theta PI, passing edge-on through the bar's own line at the
// quarter turns. That is what reads as "wrapping".
const LANE_H = 48;
const BAR_H = 2;

const COUNT = 46;
const ORBIT_MAX = 16;   // the widest spiral, far from the leading edge
const ORBIT_MIN = 3.5;  // the throat, at the leading edge
const PINCH = 110;      // px over which an approaching bubble is drawn inwards

// Angular speed is SWIRL / orbit — a real vortex spins faster the tighter it
// gets, and a constant rate reads as a carousel instead. At ORBIT_MAX that is
// about 0.6 revolutions a second and at ORBIT_MIN about 2.5, so the pinch
// buys the acceleration for free rather than needing its own curve.
const SWIRL = 58;
const DRIFT = 26;       // px/s along the bar

const AXIS_Y = LANE_H / 2;

const ACCENT = '122,215,255';

// A frame this long means the main thread was busy — the shader warm-up
// compiles in synchronous batches and this animation shares its thread. Clamp
// so the vortex jumps a little rather than integrating one 400ms step into a
// full extra revolution.
const MAX_DT = 0.05;

// --- the quick tips ---------------------------------------------------------
// Milliseconds, and local to this file rather than in CONFIG on purpose: the
// loading screen is gone before the tuner (`) exists, so a slider here would
// be a control that can never be pointed at the thing it controls.
//
// FIRST_MS is the one that is not a taste call. A warm reload can finish boot
// in a few hundred milliseconds, and a tip that appeared for 200ms of that is
// a flash of half-read type — worse than no tip, because the player knows
// they missed something. Wait past the length of a boot that needs no tips.
const TIP_FIRST_MS = 800;
// How long a tip stands, fully up. Four seconds reads ~50 characters at an
// unhurried pace with a second left over to look away, which is the length
// these lines are written to.
const TIP_HOLD_MS = 5000;
// The crossfade, and it MUST match the transition on .sv-load-tip-line — the
// next tip's words are written into the node at the end of this gap, and
// writing them while the old ones are still fading would swap the text
// mid-fade and read as a glitch rather than as a change.
const TIP_FADE_MS = 420;

// CHECKED AT BOOT, OUT LOUD, the way callouts.csv is (checkCalloutBindings at
// the foot of systems/callouts.js). A tip whose pad wording still says "press
// E" is invisible to whoever wrote it — they are on a laptop, where it reads
// perfectly — and the first person to find out is somebody holding a
// controller who cannot do the thing the screen just told them to do.
checkBindingText('loadTips', LOAD_TIPS);

/**
 * Put the rotating tips above the bar and start them turning.
 *
 * Returns a stop() the screen's own remove() calls. Driven by timers rather
 * than by the rAF loop above, and that is not an accident: the loop does not
 * run at all under reduced motion (see `reduced`), and the tips have to rotate
 * there too — they are words, not motion.
 *
 * @param lane   the positioning box the bar lives in; the tips hang above it
 * @param device which of DEVICES to word the tips for. Defaults to the guess,
 *   which is the right answer here: nothing has been pressed yet at boot, so
 *   there is no evidence to wait for. Injectable for the look page and tests.
 * @param rows   the table to rotate, defaulting to loadTips.csv. The look page
 *   pins one line with it so a screenshot is the same picture twice, and the
 *   test drives the degenerate tables — one row, none at all — that an author
 *   passes through while they are writing and that the shipping file will
 *   never be in.
 * @param random injectable so a test can pin the rotation order
 */
function startTips(lane, { device = defaultDevice(), rows = LOAD_TIPS, random = Math.random } = {}) {
  const pool = tipsForDevice(rows, device);
  // No rows for this device is a perfectly good state — the screen it replaces
  // is the screen the game shipped with. Nothing is added to the DOM, so there
  // is no empty box holding space above the bar either.
  if (!pool.length) return () => {};

  const box = document.createElement('div');
  box.className = 'sv-load-tip';
  const line = document.createElement('span');
  line.className = 'sv-load-tip-line';
  box.appendChild(line);
  lane.appendChild(box);

  // The bag: every tip once, shuffled, before any of them comes round again.
  // See tipOrder for why this is not a roll per slot.
  let bag = [];
  let last = null;
  function nextTip() {
    if (!bag.length) {
      bag = tipOrder(pool, random);
      // A reshuffle that opens on the tip still fading out is the one repeat
      // the bag exists to prevent, and it is the likeliest one — it happens
      // whenever the boot outlasts the table. Only worth doing if there is
      // something else to lead with.
      if (bag.length > 1 && bag[0] === last) bag.push(bag.shift());
    }
    last = bag.shift();
    return last;
  }

  let timer = 0;
  function show() {
    // Resolved here rather than at parse: `{clap}` is whatever clap is bound
    // to right now, and the bindings are read from the player's settings.
    line.textContent = fillBindings(textForDevice(nextTip(), device));
    line.classList.add('is-up');
    timer = setTimeout(hide, TIP_HOLD_MS);
  }
  function hide() {
    // One tip left in the whole table has nothing to turn to, so it stays up
    // rather than blinking itself out and back in on the same words.
    if (pool.length < 2) return;
    line.classList.remove('is-up');
    timer = setTimeout(show, TIP_FADE_MS);
  }
  timer = setTimeout(show, TIP_FIRST_MS);

  return () => { clearTimeout(timer); box.remove(); };
}

function makeBubble(width, seeded) {
  return {
    // `seeded` spreads the first population across the lane; recycled bubbles
    // always re-enter from the left, which is the direction of travel.
    x: seeded ? Math.random() * width : -8 - Math.random() * 40,
    theta: Math.random() * Math.PI * 2,
    orbit0: ORBIT_MIN + Math.random() * (ORBIT_MAX - ORBIT_MIN),
    r: 0.9 + Math.random() * 2.2,
    drift: DRIFT * (0.65 + Math.random() * 0.8),
  };
}

/**
 * Put the loading screen up. Returns the handle boot() drives it with:
 *   setProgress(0..1)  how far along the bar the fill has reached
 *   remove()           take it down
 *
 * @param tips  options handed to startTips — `device` and `random`, both for
 *   the look page and the tests. A real boot passes nothing.
 * @param resuming  true when this boot is going straight back into a run the
 *   process was killed underneath (see systems/runSnapshot.js). Adds one line
 *   under the bar and changes nothing else — see .sv-load-cap for why the
 *   composition deliberately stays identical.
 */
export function showLoading({ resuming = false, tips = {} } = {}) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  // FILED UNDER THE ROLE SHEET. Same rule and the same reason as
  // installStyleBelowRoles in ui/typography.js: this sheet is built after
  // initTypography has run, so appending it would put a rule of equal
  // specificity LATER in the document than the Text panel's, and the panel
  // would silently lose every fight over these two selectors. Done by hand
  // rather than through that helper because the helper is keyed on an id and
  // shares one sheet between callers — the look page mounts two of these
  // screens at once, and remove() on the first would take the second's styles
  // with it.
  const roleSheet = document.getElementById('svTypographyRoles');
  if (roleSheet) document.head.insertBefore(style, roleSheet);
  else document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'sv-load';
  root.innerHTML = `<div class="sv-load-lane"><canvas></canvas>${
    resuming ? `<div class="sv-load-cap">${uiText('loadResuming')}</div>` : ''
  }</div>`;
  document.body.appendChild(root);

  const lane = root.querySelector('.sv-load-lane');
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

  // Above the bar, on their own clock. See startTips.
  const stopTips = startTips(lane, tips);

  let width = 1;
  let bubbles = [];

  // `target` is what the caller asked for; `shown` is where the fill actually
  // is. Separating them is what lets the bar ease without a CSS transition,
  // and the easing below is exponential rather than a fixed step so it settles
  // at the same rate however long the frame took.
  let target = 0;
  let shown = 0;
  let last = performance.now();
  let raf = 0;

  function drawBubble(b, edgeX) {
    // Distance behind the leading edge decides how far in the spiral has been
    // drawn. Ahead of the edge there is nothing pulling it in, so it opens
    // back out — a bubble that slipped past the drain.
    const behind = edgeX - b.x;
    const pinch = behind > 0 ? Math.min(1, behind / PINCH) : 1;
    const orbit = ORBIT_MIN + (b.orbit0 - ORBIT_MIN) * pinch;

    const z = Math.cos(b.theta);
    const y = AXIS_Y + Math.sin(b.theta) * orbit;

    // Depth: nearer is bigger and brighter. The back half stays visible on
    // purpose — a bubble that vanished behind the bar would read as being
    // clipped by it rather than as passing behind it.
    const near = z * 0.5 + 0.5;
    const scale = 0.75 + near * 0.35;
    let alpha = 0.30 + near * 0.55;

    // The unfilled stretch is water the load has not reached. Dimmer, not
    // absent: the vortex has to still be visible at 0% or the first second of
    // the screen is an empty box. 0.35 was that box — at zero progress EVERY
    // bubble is ahead of the edge, so the dim applied to all of them at once
    // and the screen opened on a faint smear.
    if (b.x > edgeX) alpha *= 0.55;

    // Fade in on entry and out at the far end, so recycling never pops.
    alpha *= Math.min(1, Math.max(0, (b.x + 8) / 26));
    alpha *= Math.min(1, Math.max(0, (width + 10 - b.x) / 30));
    if (alpha <= 0.01) return;

    const r = b.r * scale;
    ctx.beginPath();
    ctx.arc(b.x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${ACCENT},${alpha * 0.28})`;
    ctx.fill();
    // The rim is what makes it a bubble rather than a dot. Sub-pixel line
    // widths are fine here — the canvas is drawn at device resolution.
    ctx.lineWidth = Math.min(1, r * 0.5);
    ctx.strokeStyle = `rgba(${ACCENT},${alpha * 0.85})`;
    ctx.stroke();
  }

  function render() {
    const edgeX = shown * width;

    ctx.clearRect(0, 0, width, LANE_H);

    // Painter's order. This is the whole reason the bar is in here.
    for (const b of bubbles) if (Math.cos(b.theta) <= 0) drawBubble(b, edgeX);

    const barY = AXIS_Y - BAR_H / 2;
    ctx.fillStyle = `rgba(255,255,255,0.09)`;
    ctx.fillRect(0, barY, width, BAR_H);

    if (edgeX > 0) {
      const grad = ctx.createLinearGradient(0, 0, edgeX, 0);
      grad.addColorStop(0, `rgba(${ACCENT},0.25)`);
      grad.addColorStop(1, `rgba(${ACCENT},0.85)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, barY, edgeX, BAR_H);

      // A bloom at the throat — the point the bubbles are being drawn towards
      // needs to look like it is doing the drawing.
      const glow = ctx.createRadialGradient(edgeX, AXIS_Y, 0, edgeX, AXIS_Y, 9);
      glow.addColorStop(0, `rgba(${ACCENT},0.55)`);
      glow.addColorStop(1, `rgba(${ACCENT},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(edgeX - 9, AXIS_Y - 9, 18, 18);
    }

    for (const b of bubbles) if (Math.cos(b.theta) > 0) drawBubble(b, edgeX);
  }

  function step(dt) {
    // Never backwards: the two phases of boot report their own 0..1 and the
    // caller maps them onto shares of the bar, so a rounding wobble at a
    // handover must not send the fill back the way it came.
    shown += (target - shown) * (1 - Math.exp(-6 * dt));

    const edgeX = shown * width;
    for (const b of bubbles) {
      const behind = edgeX - b.x;
      const pinch = behind > 0 ? Math.min(1, behind / PINCH) : 1;
      const orbit = ORBIT_MIN + (b.orbit0 - ORBIT_MIN) * pinch;
      // Every bubble turns the SAME way. Half of them counter-rotating reads as
      // turbulence, not as a vortex — the eye needs a shared direction to see
      // one body of water rotating. The variety comes from the vortex law
      // instead: a tight orbit is a fast one, so the inner bubbles whip past
      // the outer ones and the differential does what the randomness was for.
      b.theta += (SWIRL / orbit) * dt;
      b.x += b.drift * dt;
      if (b.x > width + 12) Object.assign(b, makeBubble(width, false));
    }
  }

  function frame(now) {
    const dt = Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
    last = now;
    step(dt);
    render();
    raf = requestAnimationFrame(frame);
  }

  // Defined last and called last: it redraws, and everything a redraw reads is
  // declared above. Setting canvas.width also CLEARS the canvas and resets the
  // context transform, so the redraw is not optional under reduced motion —
  // without it a resize leaves an empty box until the caller next reports.
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const prev = width;
    width = Math.max(1, lane.clientWidth);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(LANE_H * dpr);
    // Draw in CSS pixels and let the transform handle the backing store, so
    // every size above is a number you can reason about against the layout.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!bubbles.length || prev <= 1) {
      // Either the first population, or the lane had no width to seed into and
      // every bubble is stacked at x=0. The second case is the one that bites:
      // this runs at boot, and a lane measured before layout settles seeds all
      // 46 into one pixel, where they stay — they only ever drift RIGHT, so
      // nothing brings them back and the left of the bar is bare until they
      // have crossed the whole lane.
      bubbles = Array.from({ length: COUNT }, () => makeBubble(width, true));
    } else if (width !== prev) {
      // Carry the population across proportionally rather than re-seeding, so
      // a window resize slides the vortex to the new width instead of blinking
      // a fresh set of bubbles into existence.
      const k = width / prev;
      for (const b of bubbles) b.x *= k;
    }
    render();
  }
  resize();
  window.addEventListener('resize', resize);

  if (!reduced) raf = requestAnimationFrame(frame);

  return {
    setProgress(p) {
      target = Math.max(0, Math.min(1, p));
      // Under reduced motion nothing is driving the canvas, so the only thing
      // that ever moves the bar is the caller telling it to.
      if (reduced) { shown = target; render(); }
    },
    remove() {
      cancelAnimationFrame(raf);
      // Before the root goes: a pending rotation left running would fire into
      // a detached node forever, which costs nothing visible and is exactly
      // the kind of leak that only shows up on the machine that reloads the
      // game two hundred times a day.
      stopTips();
      window.removeEventListener('resize', resize);
      root.remove();
      style.remove();
    },
  };
}
