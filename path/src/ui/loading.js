// The loading screen: a seal swimming the length of a progress bar.
//
// This used to be the word "Loading" centred on black, which was honest when
// boot was one `await preloadAssets()` and nothing else. It is not any more —
// the shader warm-up (systems/shaderWarmup.js) deliberately spends seconds
// before the menu so that the run doesn't spend them one stall at a time, and
// a wait you have chosen to make longer is exactly the wait that has to show
// its working.
//
// Two phases, one bar. `setPhase` names what is happening and `setProgress`
// moves the seal; the split between them is the caller's (see boot()), because
// only it knows how the two halves compare in wall-clock time.
//
// No assets and no WebGL: this is on screen before either exists.

const STYLES = `
  .sv-load { position: fixed; inset: 0; z-index: 20; display: flex;
    flex-direction: column; align-items: center; justify-content: center; gap: 18px;
    background: radial-gradient(120% 90% at 50% 40%, #0d2033 0%, #060b14 100%);
    color: rgba(232,236,243,0.55);
    font: 500 11px/1 Inter, system-ui, sans-serif;
    letter-spacing: 0.14em; text-transform: uppercase; }

  /* The lane the seal swims down. Deliberately wide and short — it reads as a
     stretch of water rather than as a widget, which is the only reason a seal
     on top of it makes any sense. */
  .sv-load-lane { position: relative; width: min(340px, 62vw); height: 3px;
    background: rgba(255,255,255,0.09); border-radius: 2px; }
  .sv-load-fill { position: absolute; inset: 0 auto 0 0; width: 0%;
    background: linear-gradient(90deg, rgba(122,215,255,0.25), rgba(122,215,255,0.85));
    border-radius: 2px; transition: width 0.25s ease-out; }

  /* The seal rides the END of the fill. Both animate on the same easing and
     duration, so it stays pinned to the leading edge instead of chasing it. */
  .sv-load-seal { position: absolute; left: 0%; top: 50%; width: 34px; height: 20px;
    margin: -10px 0 0 -17px; transition: left 0.25s ease-out;
    filter: drop-shadow(0 0 6px rgba(122,215,255,0.45)); }
  .sv-load-seal svg { width: 100%; height: 100%; display: block; }

  /* Swimming is all in the tail. The body bobs a little on a longer cycle so
     the two never line up and it doesn't read as one sprite being wobbled. */
  .sv-load-seal { animation: sv-load-bob 1.9s ease-in-out infinite; }
  .sv-load-tail { transform-origin: 26px 10px; animation: sv-load-kick 0.62s ease-in-out infinite; }
  .sv-load-flip { transform-origin: 15px 12px; animation: sv-load-kick 0.62s ease-in-out infinite reverse; }
  @keyframes sv-load-bob { 0%, 100% { margin-top: -10px; } 50% { margin-top: -13px; } }
  @keyframes sv-load-kick { 0%, 100% { transform: rotate(13deg); } 50% { transform: rotate(-13deg); } }

  /* Bubbles trailing off the nose, so the lane reads as water in motion even
     while the bar is between updates and the seal is standing still. */
  .sv-load-bub { position: absolute; top: 50%; width: 3px; height: 3px; border-radius: 50%;
    background: rgba(122,215,255,0.5); animation: sv-load-rise 2.4s linear infinite; }
  @keyframes sv-load-rise {
    0%   { transform: translate(0, 0) scale(0.5); opacity: 0; }
    15%  { opacity: 0.7; }
    100% { transform: translate(26px, -22px) scale(1); opacity: 0; }
  }

  .sv-load-label { min-height: 12px; transition: opacity 0.2s ease; }

  @media (prefers-reduced-motion: reduce) {
    .sv-load-seal, .sv-load-tail, .sv-load-flip, .sv-load-bub { animation: none; }
    .sv-load-fill, .sv-load-seal { transition: none; }
    .sv-load-bub { display: none; }
  }
`;

// Side-on, nose to the right, matching the direction of travel. Drawn rather
// than loaded: the seal model is one of the things still being fetched while
// this is on screen.
const SEAL = `
<svg viewBox="0 0 34 20" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path class="sv-load-tail" d="M24 10c3-1.5 5-3.5 8-4.5-1.5 3-1.5 6 0 9-3-1-5-3-8-4.5z" fill="#9fd8f5"/>
  <ellipse cx="14" cy="10.5" rx="12" ry="6" fill="#cfe9fa"/>
  <path class="sv-load-flip" d="M13 14c2 .5 4 2 5 4-2.5.3-5-.8-6.5-2.5z" fill="#9fd8f5"/>
  <circle cx="4.5" cy="8.5" r="1.1" fill="#0d2033"/>
  <path d="M2 10.5c.9-.6 1.9-.6 2.8 0" stroke="#0d2033" stroke-width="0.7" stroke-linecap="round"/>
</svg>`;

/**
 * Put the loading screen up. Returns the handle boot() drives it with:
 *   setProgress(0..1)  where the seal is
 *   setPhase(text)     what it is waiting on
 *   remove()           take it down
 */
export function showLoading() {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'sv-load';
  root.innerHTML = `
    <div class="sv-load-lane">
      <div class="sv-load-fill"></div>
      <div class="sv-load-bub" style="left:8%; animation-delay:0s"></div>
      <div class="sv-load-bub" style="left:34%; animation-delay:0.8s"></div>
      <div class="sv-load-bub" style="left:66%; animation-delay:1.6s"></div>
      <div class="sv-load-seal">${SEAL}</div>
    </div>
    <div class="sv-load-label">Loading</div>
  `;
  document.body.appendChild(root);

  const fill = root.querySelector('.sv-load-fill');
  const seal = root.querySelector('.sv-load-seal');
  const label = root.querySelector('.sv-load-label');

  return {
    setProgress(p) {
      // Never backwards: the two phases report their own 0..1 and the caller
      // maps them onto shares of the bar, so a rounding wobble at a handover
      // must not send the seal swimming back the way it came.
      const pct = Math.max(0, Math.min(1, p)) * 100;
      fill.style.width = `${pct}%`;
      seal.style.left = `${pct}%`;
    },
    setPhase(text) {
      label.textContent = text;
    },
    remove() {
      root.remove();
      style.remove();
    },
  };
}
