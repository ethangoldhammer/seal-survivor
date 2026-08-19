// ---------------------------------------------------------------------------
// THE TIP JAR
//
// One link, one look, three surfaces: the splash, the pause menu and the score
// card. It lives in its own module rather than three times in the markup
// because the URL is the kind of thing that gets changed once and missed twice
// — and because two of the three places it appears cannot share a stylesheet.
//
// DELIBERATELY DEPENDENCY-FREE. riveSplash.js is written to know nothing about
// ui.js or the game loop (see its header) so it can be driven from a probe
// page, and a tip jar that imported systems/feedback.js would drag config.js,
// the particle pool and the audio graph in behind it. The click sound is an
// injected callback instead: ui.js and pauseMenu.js already have `feedback`
// and hand it in, the probe page hands in nothing, and nobody has to import
// anything to put a link on a screen.
//
// The styles are injected from here for the same reason. The splash's wrapper
// is mounted into .sv-ui in the real game but into a bare <body> on the probe
// page, so a rule that lived in ui.js's sheet would style the link in the game
// and leave it unstyled everywhere it is looked at on its own.
//
// It is a REAL <a> with a real href, not a button that calls window.open. That
// is what gives it middle-click, "open in new tab", a status-bar preview of
// where it goes, and — the one that actually matters here — a click that
// survives a popup blocker. Most of this game is played on a phone, where
// window.open from a handler several frames removed from the gesture is the
// call that silently does nothing.
// ---------------------------------------------------------------------------

/** Where the money goes. The single place this is written down. */
export const TIP_JAR_URL = 'https://ko-fi.com/hammeredgold';

/** What the link says it is, on hover and to a screen reader. */
export const TIP_JAR_TITLE = 'Support Seal Survivor on Ko-fi';

// The cup, inline rather than an emoji. ☕ is a different drawing on every
// platform and a full-colour one on most, which is exactly what a 12px mark
// beside 11px type cannot be — this one is a stroke in currentColor, so it
// dims and lights with the label it sits next to.
const CUP = `
  <svg class="sv-tip-cup" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z" />
    <path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17" />
    <path d="M8 2.5c0 1.2-1 1.5-1 2.5M12 2.5c0 1.2-1 1.5-1 2.5" class="sv-tip-steam" />
  </svg>`;

const STYLES = `
  /* pointer-events must be explicit: every surface this lands on is inside a
     container that is pointer-events:none so the 3D scene below stays
     clickable. */
  .sv-tip { pointer-events: all; display: inline-flex; align-items: center; gap: 7px;
    text-decoration: none; cursor: pointer; border-radius: 999px;
    padding: 7px 14px; font-size: 12px; font-weight: 600; letter-spacing: 0.05em;
    color: rgba(232,236,243,0.72);
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.16);
    transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease; }
  /* Warm on hover, and only on hover. A tip jar that is the brightest thing on
     the screen is a tip jar that is in the way of the game — it reads as a
     footer until someone looks at it, and then it reads as a button.

     TWO CURSOR CLASSES, because the two menus that hold this each name their
     own: .sv-nav-sel is the score card's (ui.js), .sv-pm-sel is the pause
     menu's (pauseMenu.js). Both are classes rather than :focus-visible for the
     same reason those files give — a stick push produces a programmatic focus,
     and the browser guesses "no ring" for one of those. */
  .sv-tip:hover, .sv-tip:focus-visible, .sv-tip.sv-nav-sel, .sv-tip.sv-pm-sel {
    color: #ffd9a0; background: rgba(255,190,110,0.14); border-color: rgba(255,190,110,0.45); }
  .sv-tip:focus-visible, .sv-tip.sv-nav-sel, .sv-tip.sv-pm-sel {
    outline: 2px solid #fff; outline-offset: 2px; }
  .sv-tip-cup { width: 14px; height: 14px; flex: none; fill: none;
    stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .sv-tip-steam { opacity: 0.55; }
  .sv-tip:hover .sv-tip-steam { opacity: 1; }

  /* THE SPLASH. The artboard is fitted Contain and paints its own opaque
     background, so there is no corner of it that is reliably empty — this sits
     on the wrapper, below the art, where the letterbox is on a wide window and
     over the bottom edge of the card on a tall one. Centred rather than tucked
     right because on a phone the right edge is where a thumb rests.

     The safe-area inset is not decoration: on an iPhone the bottom of the
     viewport is the home indicator, and a link under it is a link that swipes
     the player out of the game instead of opening. */
  .sv-tip-splash { position: absolute; left: 50%; transform: translateX(-50%);
    bottom: calc(14px + env(safe-area-inset-bottom, 0px)); z-index: 2;
    /* Its own dark backing, unlike the two menu copies. Those sit on a
       .sv-menu panel that is already dark; this one has no idea what is behind
       it — the artboard is fitted Contain, so on a wide window it is the art
       and on a tall one it is the wrapper's background, which the game can set
       to transparent to reveal the seal (CONFIG.titleSeal.scrim). A pill that
       is only a 5% white wash is legible over exactly one of those. */
    background: rgba(6,10,18,0.55);
    border-color: rgba(255,255,255,0.2); }

  /* THE PAUSE MENU and THE SCORE CARD both want it as its own line under the
     buttons — quiet, full-width-centred, and unmistakably not one of them. */
  .sv-tip-row { display: flex; justify-content: center; margin-top: 14px; }

  /* Touch targets. Same 44px rule the rest of the UI's controls follow. */
  .sv-touch .sv-tip { min-height: 44px; padding-left: 18px; padding-right: 18px; }
`;

let stylesInjected = false;

function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.dataset.svTip = '';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/**
 * The link itself.
 *
 * @param className  extra classes, for the surface-specific positioning above.
 * @param label      the words. One string everywhere by default, on purpose —
 *                   three different askings read as three different things.
 * @param id         optional element id. The score card's copy takes one so
 *                   the pad-walk test can name it in its trace — a cursor
 *                   stop with no id is a blank in that list, which is what an
 *                   unreachable control looks like too.
 * @param onHover    optional, called on pointerenter. ui.js and pauseMenu.js
 *                   pass feedback('uiHover') so it sounds like every other
 *                   control on the same screen.
 * @param onClick    optional, called on click BEFORE navigation. Must not
 *                   preventDefault — the navigation is the point.
 */
export function tipJarLink({ className = '', label = 'Tip jar', id = '', onHover, onClick } = {}) {
  ensureStyles();

  const a = document.createElement('a');
  if (id) a.id = id;
  a.className = `sv-tip ${className}`.trim();
  a.href = TIP_JAR_URL;
  a.target = '_blank';
  // noopener is the security half (the opened page cannot reach back through
  // window.opener); noreferrer is the half that matters on a game served from
  // its own domain, and costs nothing.
  a.rel = 'noopener noreferrer';
  a.title = TIP_JAR_TITLE;
  a.setAttribute('aria-label', TIP_JAR_TITLE);
  a.innerHTML = `${CUP}<span>${label}</span>`;

  if (onHover) a.addEventListener('pointerenter', onHover);
  if (onClick) a.addEventListener('click', onClick);
  return a;
}

/**
 * The splash's copy, mounted into the splash wrapper.
 *
 * The pointer handlers are the whole reason this is a function rather than a
 * call to tipJarLink with a class: the wrapper listens for pointerup to hand
 * the keyboard to the name field, and on a bad export it listens for it to
 * START THE RUN. Either one landing on a tip click means a player who tapped
 * the jar watches the game begin behind the tab that just opened.
 *
 * Both ends of the gesture are stopped, not just the release. A pointerdown
 * that reaches the wrapper is a pointerdown Rive hit-tests against the
 * artboard, which is how a tap on the jar also presses whatever button of the
 * card happens to be underneath it.
 */
export function mountSplashTipJar(wrap, opts = {}) {
  const a = tipJarLink({ ...opts, className: 'sv-tip-splash' });
  const swallow = (e) => e.stopPropagation();
  for (const type of ['pointerdown', 'pointerup', 'pointermove']) {
    a.addEventListener(type, swallow);
  }
  wrap.appendChild(a);
  return a;
}
