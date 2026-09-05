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
    transform: translateX(-50%); white-space: nowrap;
    font: 500 13px/1.4 Inter, system-ui, sans-serif; letter-spacing: 0.02em;
    color: rgba(122,215,255, 0.72); text-align: center;
    /* Fades in rather than appearing with the bar. The first moments of the
       screen are identical to a normal boot on purpose — this arrives a beat
       later, the way a line of explanation does. */
    opacity: 0; animation: sv-load-cap-in 420ms ease-out 260ms forwards; }

  @keyframes sv-load-cap-in { to { opacity: 1; } }

  @media (prefers-reduced-motion: reduce) {
    /* No fade: the caption is information, and the one thing reduced motion
       must never do is withhold it. */
    .sv-load-cap { opacity: 1; animation: none; }
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
 * @param resuming  true when this boot is going straight back into a run the
 *   process was killed underneath (see systems/runSnapshot.js). Adds one line
 *   under the bar and changes nothing else — see .sv-load-cap for why the
 *   composition deliberately stays identical.
 */
export function showLoading({ resuming = false } = {}) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

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
      window.removeEventListener('resize', resize);
      root.remove();
      style.remove();
    },
  };
}
