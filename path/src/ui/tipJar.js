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

  /* --- WHAT A TIP BUYS ------------------------------------------------------
     A sheet over whatever screen the jar was pressed on, rather than a panel
     inside it. The jar is on three surfaces — the splash, the pause menu and
     the score card — and two of them cannot share a stylesheet with the third;
     a panel that lived in any one of their layouts would be a second layout to
     keep alive in the other two. Over the top, it is the same object
     everywhere, and it is the only thing on the screen while it is up. */
  .sv-tip-sheet { position: fixed; inset: 0; z-index: 30; display: flex;
    align-items: center; justify-content: center; padding: 4vh 4vw;
    background: rgba(3,6,10,0.93); pointer-events: all;
    /* THE FONT HAS TO BE ASKED FOR. The sheet is mounted on the BODY so it can
       sit over every surface the jar appears on — which puts it outside
       .sv-ui, and ui/typography.js scopes the family to .sv-ui and its descendants.
       Left alone the panel came up in the browser's default mono while the
       card behind it was in the tuned pixel face, which reads as a dialog from
       a different program. --sv-font is written to the document element, so it
       is reachable from here; the fallback is ui.js's own. */
    font-family: var(--sv-font, 'Inter', system-ui, sans-serif); }
  .sv-tip-panel { position: relative; width: 560px; max-width: 100%;
    max-height: 92vh; overflow-y: auto; overscroll-behavior: contain;
    background: #07090d; border: 1px solid rgba(255,255,255,0.14);
    border-radius: 14px; padding: 26px 26px 20px; color: #e8ecf3;
    box-shadow: 0 24px 50px rgba(0,0,0,0.62), 0 2px 0 rgba(255,255,255,0.05) inset; }
  .sv-tip-title { font-size: 18px; font-weight: 700; letter-spacing: 0.03em;
    line-height: 1.35; margin-bottom: 10px; }
  .sv-tip-blurb { font-size: 12px; line-height: 1.7; letter-spacing: 0.02em;
    color: rgba(232,236,243,0.6); margin-bottom: 18px; }
  .sv-tip-tiers { display: flex; flex-direction: column; gap: 8px; }
  /* EVERY TIER IS A REAL LINK, for the reason the jar itself is one — see the
     header. The panel is a menu of destinations, not a form: the click that
     opens Ko-fi is a click on an <a href>, which is the only kind that
     survives a popup blocker on the phone most of this game is played on. */
  .sv-tip-tier { display: flex; align-items: center; gap: 14px;
    text-decoration: none; color: inherit; cursor: pointer;
    padding: 12px 14px; border-radius: 10px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.10);
    transition: background 0.15s ease, border-color 0.15s ease; }
  .sv-tip-tier:hover, .sv-tip-tier:focus-visible {
    background: rgba(255,190,110,0.12); border-color: rgba(255,190,110,0.45);
    outline: none; }
  .sv-tip-price { flex: none; min-width: 4ch; font-size: 20px; font-weight: 700;
    letter-spacing: 0.01em; color: #ffd9a0; font-variant-numeric: tabular-nums; }
  .sv-tip-what { min-width: 0; flex: 1; text-align: left; }
  /* BOTH ARE BLOCKS. As inline spans the description ran on from the label as
     one sentence — "Name a seal One name of your choosing" — and the margin
     that was supposed to separate them did nothing, because vertical margins
     do not apply to an inline box. */
  .sv-tip-label { display: block; font-size: 13px; font-weight: 600;
    letter-spacing: 0.02em; line-height: 1.4; }
  .sv-tip-desc { display: block; font-size: 11px; line-height: 1.5;
    letter-spacing: 0.02em; color: rgba(232,236,243,0.55); margin-top: 4px; }
  .sv-tip-go { flex: none; font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: rgba(232,236,243,0.4); white-space: nowrap; }
  .sv-tip-tier:hover .sv-tip-go, .sv-tip-tier:focus-visible .sv-tip-go { color: #ffd9a0; }
  /* THE INSTRUCTION IS THE WHOLE MECHANISM. Nothing in the game records what
     was bought — Ko-fi's message field is the record, and this line is what
     makes those messages sortable on the other end. It is deliberately the
     last thing in the panel and deliberately not small print: a tip that
     arrives with no name in it is a refund and an apology. */
  .sv-tip-how { margin-top: 18px; padding-top: 14px;
    border-top: 1px solid rgba(255,255,255,0.08);
    font-size: 11px; line-height: 1.7; letter-spacing: 0.02em;
    color: rgba(232,236,243,0.55); }
  .sv-tip-how b { color: #ffd9a0; font-weight: 700; }
  .sv-tip-close { position: absolute; top: 12px; right: 14px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18);
    color: #e8ecf3; font: inherit; width: 34px; height: 34px;
    border-radius: 50%; cursor: pointer; }
  .sv-tip-close:hover { background: rgba(255,255,255,0.16); }
  .sv-tip-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .sv-touch .sv-tip-close { width: 44px; height: 44px; }
  .sv-touch .sv-tip-tier { min-height: 60px; }

  @media (max-width: 700px) {
    .sv-tip-panel { padding: 20px 16px 16px; }
    /* The price and the label stay on one line; the "Ko-fi" chevron is the
       one thing that can go, and it is the one thing the whole row already
       says by being a link. */
    .sv-tip-go { display: none; }
  }
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
export function tipJarLink({ className = '', label = 'Tip jar', id = '', onHover, onClick, tiers } = {}) {
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

  // THE JAR BECOMES A MENU when it is given tiers, and STAYS A REAL LINK.
  //
  // Only a plain left click is taken. A middle click, a cmd/ctrl click, a
  // shift click, "open in new tab" from the context menu — none of those reach
  // a click handler the same way, and the ones that do are exactly the
  // gestures a person uses when they have already decided where they are
  // going. Swallowing those to show them a menu would be the link quietly
  // becoming a button, which is the thing the header of this file is about.
  if (tiers?.length) {
    a.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openTipSheet({ tiers, onHover, onClick });
    });
  }
  return a;
}

const CLOSE = `
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;

/** Escapes a cell on its way into the panel. Every one of these comes out of
 *  tips.csv, which is ours — but it is a spreadsheet, and a spreadsheet is
 *  exactly the kind of file that one day contains an ampersand. */
function esc(str) {
  return String(str).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

/** The sheet, while it is up. One at a time, held here so a second press
 *  re-uses it rather than stacking a second scrim over the first. */
let sheet = null;

/** True while the tier panel is up — the screen underneath must not act. */
export function tipSheetOpen() {
  return !!sheet;
}

/** Put it away. Safe to call when nothing is open, which is what makes it
 *  usable from a screen's own tear-down without a guard at every call site. */
export function closeTipSheet() {
  sheet?.remove();
  sheet = null;
}

/**
 * WHAT A TIP BUYS — the tiers, over whatever screen the jar was pressed on.
 *
 * NOTHING HERE TAKES A PAYMENT OR RECORDS ONE. The panel quotes prices and
 * hands off to Ko-fi, which is the only place a number is ever actually agreed
 * to; the game has no idea whether anybody paid and deliberately does not try
 * to find out. What arrives on the other end is a Ko-fi message with a name in
 * it, and the row goes into sealNames.csv or bossNames.csv by hand — which is
 * the same review a name in this game needs anyway, whoever sent it.
 *
 * That is why the panel's last line is an instruction rather than a form. A
 * form would imply the game is listening.
 *
 * @param tiers    rows from tipTable.js. An empty list means no panel at all —
 *                 the caller falls back to letting the jar's own href run.
 * @param onHover  optional, called on pointerenter of a tier, for the blip.
 * @param onClick  optional, called when a tier is pressed, BEFORE navigation.
 */
export function openTipSheet({ tiers = [], onHover, onClick } = {}) {
  ensureStyles();
  closeTipSheet();
  if (!tiers.length) return null;

  // The tags actually in use, said in the order the tiers are in. Built from
  // the rows rather than written out, so a new kind of name is askable for by
  // adding a row — see the note on `tag` in tipTable.js.
  const tags = [...new Set(tiers.map((t) => t.tag).filter(Boolean))];

  sheet = document.createElement('div');
  sheet.className = 'sv-tip-sheet';
  // THE TOUCH CLASS HAS TO BE CARRIED OVER. Every 44px rule in this game keys
  // on `.sv-touch`, which initUI puts on `.sv-ui` from the real media query —
  // and this sheet is mounted on the BODY so it can sit over every surface the
  // jar appears on, which puts it outside that ancestor. Left alone the close
  // button came up at 34px on a phone: under the minimum, on a modal, with
  // nothing able to report it (the panel is not one of the audit's surfaces).
  // Copied rather than re-read from a media query, because `pointer: coarse`
  // answers about the machine rather than the device being stood in for — see
  // the note in tools/layout/layout-audit.js.
  if (document.querySelector('.sv-ui.sv-touch')) sheet.classList.add('sv-touch');
  sheet.innerHTML = `
    <div class="sv-tip-panel" role="dialog" aria-modal="true" aria-label="What a tip buys">
      <div class="sv-tip-title">Put a name in the water</div>
      <div class="sv-tip-blurb">Every seal and every boss in this game is named
        from a list. You can be on it.</div>
      <div class="sv-tip-tiers">
        ${tiers.map((t) => `
          <a class="sv-tip-tier" href="${esc(TIP_JAR_URL)}" target="_blank"
             rel="noopener noreferrer" data-tier="${esc(t.id)}">
            <span class="sv-tip-price">$${t.price}</span>
            <span class="sv-tip-what">
              <span class="sv-tip-label">${esc(t.label)}</span>
              ${t.desc ? `<span class="sv-tip-desc">${esc(t.desc)}</span>` : ''}
            </span>
            <span class="sv-tip-go">Ko-fi &rsaquo;</span>
          </a>`).join('')}
      </div>
      <div class="sv-tip-how">
        Tip the amount on Ko-fi and <b>write the name in the message</b>${
          tags.length ? `, starting with <b>${tags.map(esc).join('</b> or <b>')}</b>` : ''
        }. That message is the whole record — a tip with no name in it is just a
        tip, and I will have no idea what you wanted.
      </div>
      <button type="button" class="sv-tip-close" aria-label="Close">${CLOSE}</button>
    </div>`;

  // THE BACKDROP CLOSES IT, the panel does not. Without the target check a
  // press anywhere inside — including on a tier — closes the sheet on its way
  // through, which on a phone is a link that opens Ko-fi and a panel that
  // vanishes behind it for no reason the player can see.
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeTipSheet();
  });
  // AND NOTHING REACHES THE SCREEN UNDERNEATH. Two of the three surfaces this
  // can open over listen for a pointer on their own background — the splash
  // starts the run on one, and the score card used to turn the card over — so
  // the whole gesture is stopped here rather than only the click.
  for (const type of ['pointerdown', 'pointerup', 'pointermove']) {
    sheet.addEventListener(type, (e) => e.stopPropagation());
  }

  sheet.querySelector('.sv-tip-close').addEventListener('click', closeTipSheet);
  for (const tier of sheet.querySelectorAll('.sv-tip-tier')) {
    if (onHover) tier.addEventListener('pointerenter', onHover);
    // NOT preventDefault, and never: the navigation is the point, and it has
    // to ride this exact click. The sheet is left up on purpose — Ko-fi opens
    // in a tab of its own, and coming back to a screen that has forgotten what
    // you were doing is worse than coming back to the list you left.
    if (onClick) tier.addEventListener('click', onClick);
  }

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    closeTipSheet();
    window.removeEventListener('keydown', onKey, true);
  };
  // Capture, so Escape puts the sheet down before the screen underneath reads
  // it as "close the pause menu" and leaves the scrim over a running game.
  window.addEventListener('keydown', onKey, true);

  document.body.appendChild(sheet);
  sheet.querySelector('.sv-tip-close').focus({ preventScroll: true });
  return sheet;
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
