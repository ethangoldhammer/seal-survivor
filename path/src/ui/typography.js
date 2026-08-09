import { CONFIG } from '../config.js';

// The UI is DOM, not WebGL, so it can't literally be sampled by the post
// shader that treats the gameplay. Instead this drives CSS custom properties
// that every UI rule reads from, plus a scanline/chroma/flicker overlay tuned
// to match that shader's look — so text opts into the same retro treatment
// rather than sitting on top of it looking conspicuously modern.

const RETRO_CSS = `
  .sv-ui, .sv-tex, .sv-t {
    font-family: var(--sv-font);
    font-weight: var(--sv-weight);
    letter-spacing: var(--sv-tracking);
    color: var(--sv-color);
  }
  /* Scale every UI font size from one root variable. */
  .sv-ui { font-size: calc(1rem * var(--sv-scale)); }
  .sv-title { font-size: calc(30px * var(--sv-scale)); }
  .sv-sub { font-size: calc(13px * var(--sv-scale)); }
  .sv-label { font-size: calc(10px * var(--sv-scale)); }
  .sv-value { font-size: calc(20px * var(--sv-scale)); }
  .sv-btn { font-size: calc(14px * var(--sv-scale)); }
  /* Level-up cards carry a second factor on top of the global scale: --sv-fit
     is set per card so the text shrinks to fit the hex without breaking words
     (ui.js, fitCardText). */
  .sv-card-desc { font-size: calc(13px * var(--sv-scale) * var(--sv-fit, 1)); }
  .sv-card-name { font-size: calc(15px * var(--sv-scale) * var(--sv-fit, 1)); }
  .sv-hint { font-size: calc(11px * var(--sv-scale)); }

  /* Retro treatment: chromatic split via layered text-shadow, a soft glow,
     and a scanline overlay drawn over the whole UI layer. */
  .sv-retro .sv-title,
  .sv-retro .sv-sub,
  .sv-retro .sv-value,
  .sv-retro .sv-label,
  .sv-retro .sv-btn,
  .sv-retro .sv-card-name,
  .sv-retro .sv-card-desc,
  .sv-retro .sv-hint {
    text-shadow:
      calc(var(--sv-chroma) * -1px) 0 rgba(255, 60, 60, 0.55),
      var(--sv-chroma) 0 rgba(60, 160, 255, 0.55),
      0 0 calc(var(--sv-glow) * 6px) rgba(150, 220, 255, calc(var(--sv-glow) * 0.5));
  }
  .sv-retro-overlay {
    position: fixed; inset: 0; pointer-events: none; z-index: 25;
    background: repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,var(--sv-scan)) 0px,
      rgba(0,0,0,var(--sv-scan)) 1px,
      transparent 1px,
      transparent 3px
    );
    mix-blend-mode: multiply;
    animation: sv-flicker 0.15s steps(2) infinite;
  }
  @keyframes sv-flicker {
    0%   { opacity: calc(1 - var(--sv-flicker)); }
    100% { opacity: 1; }
  }
`;

let overlay = null;

export function initTypography() {
  const style = document.createElement('style');
  style.textContent = RETRO_CSS;
  document.head.appendChild(style);

  overlay = document.createElement('div');
  overlay.className = 'sv-retro-overlay';
  document.body.appendChild(overlay);

  applyTypography();
}

// Called at boot and again whenever a typography value changes in the tuner,
// so edits land live rather than needing a reload.
export function applyTypography() {
  const t = CONFIG.typography;
  const root = document.documentElement.style;
  root.setProperty('--sv-font', t.family);
  root.setProperty('--sv-weight', String(t.weight));
  root.setProperty('--sv-tracking', `${t.letterSpacing}em`);
  root.setProperty('--sv-scale', String(t.scale));
  root.setProperty('--sv-color', `#${(t.color >>> 0).toString(16).padStart(6, '0')}`);
  root.setProperty('--sv-chroma', String(t.retroChromaShift));
  root.setProperty('--sv-glow', String(t.retroGlow));
  root.setProperty('--sv-scan', String(t.retroScanlineOpacity));
  root.setProperty('--sv-flicker', String(t.retroFlicker));

  document.body.classList.toggle('sv-retro', !!t.retro);
  if (overlay) overlay.style.display = t.retro ? '' : 'none';
}
