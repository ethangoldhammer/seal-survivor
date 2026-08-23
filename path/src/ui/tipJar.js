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
  /* A COLUMN, so the instruction can be flex:none against a scrolling list and
     stay ON the panel rather than on the end of the tiers. On a phone the old
     layout put 824px of content in an 812px box, and the part that fell below
     the fold was the instruction — the one thing this panel cannot afford to
     lose (see the note on .sv-tip-how).

     572px OF CONTENT, not 560. There is still no box-sizing rule in scope —
     ui.js sets it inside .sv-ui and this sheet is deliberately outside — so
     this is the content width and the padding sits outside it. The extra 12px
     is spent on the description: at the tuned pixel face every one of the four
     wrapped to two lines in the old two-column row, and a row that gives the
     description the full width lands them all on one. */
  .sv-tip-panel { position: relative; display: flex; flex-direction: column;
    width: 572px; max-width: 100%; max-height: 92vh;
    background: #07090d; border: 1px solid rgba(255,255,255,0.14);
    border-radius: 14px; color: #e8ecf3;
    box-shadow: 0 24px 50px rgba(0,0,0,0.62), 0 2px 0 rgba(255,255,255,0.05) inset; }
  /* THE RIGHT GUTTER IS FOR THE CLOSE BUTTON. It is absolutely positioned, and
     on a phone the title wraps to two lines and ran straight under it — the
     cross landed on the word "the". 68px is the 34px button, its 14px offset
     and a gap; the touch rule below widens it for the 44px one. */
  /* THE SCROLLER IS HEAD PLUS TIERS, and the instruction alone is pinned.
     A fixed head looks like the tidier diagram and is the wrong half to keep:
     on a 390x844 phone it is 300px of a 778px panel — a title the player has
     already read, holding the last tier half off the bottom. Letting it go
     costs nothing (the panel does not scroll at all on a desktop) and buys the
     whole list. What must never scroll away is .sv-tip-how, and that is the
     one thing left outside this box. */
  .sv-tip-scroll { flex: 1; min-height: 0; overflow-y: auto;
    overscroll-behavior: contain; }
  .sv-tip-head { padding: 24px 68px 16px 22px; }
  /* font-weight is inert on this panel: the tuned family is a single-weight
     pixel face (--sv-font, see the sheet rule above), so size and colour are
     carrying the hierarchy on their own. Kept for the fallback stack. */
  .sv-tip-title { font-size: 18px; font-weight: 700; letter-spacing: 0.03em;
    line-height: 1.35; margin-bottom: 10px; }
  .sv-tip-blurb { font-size: 12px; line-height: 1.7; letter-spacing: 0.02em;
    color: rgba(232,236,243,0.6); }


  /* --- A RUN OF ONE TAG ----------------------------------------------------
     The tiers are grouped by tag, and the group is a RUN rather than a bucket:
     a new one starts wherever the tag changes going down tips.csv. That is
     what keeps the panel in the table's own order column — bucketing by unique tag
     reorders the rows behind the spreadsheet's back, and the whole point of
     that column is that the person writing the row decides the sequence.
     It also means the trailing $100 SEAL tier sits where the table puts it,
     after the boss, carrying its own chip. */
  .sv-tip-group { border-top: 1px solid rgba(255,255,255,0.08); }
  .sv-tip-ghead { display: flex; align-items: center; padding: 14px 22px 8px; }
  /* The tag, at the size it is typed, in the accent — the only warm thing on
     the panel until something is hovered, because it is the one piece a player
     has to carry off this screen and into Ko-fi's message field. */
  .sv-tip-tag { flex: none; font-size: 11px; letter-spacing: 0.1em;
    color: #ffd9a0; background: rgba(255,190,110,0.14);
    border: 1px solid rgba(255,190,110,0.45); border-radius: 999px;
    padding: 5px 10px; }

  /* EVERY TIER IS A REAL LINK, for the reason the jar itself is one — see the
     header. The panel is a menu of destinations, not a form: the click that
     opens Ko-fi is a click on an <a href>, which is the only kind that
     survives a popup blocker.

     A GRID, NOT A FLEX ROW. The label leads and the price trails, because
     inside a tag group the player is choosing WHAT to buy and not how much to
     spend; the description then spans both columns underneath, which is what
     buys it the full 528px and gets it onto one line. */
  .sv-tip-tier { display: grid; grid-template-columns: 1fr auto;
    column-gap: 14px; row-gap: 4px; align-items: baseline;
    text-decoration: none; color: inherit; cursor: pointer;
    padding: 12px 22px; transition: background 0.15s ease; }
  .sv-tip-tier:hover, .sv-tip-tier:focus-visible {
    background: rgba(255,190,110,0.10); outline: none; }
  .sv-tip-label { font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
    line-height: 1.4; }
  .sv-tip-price { text-align: right; font-size: 16px; font-weight: 700;
    letter-spacing: 0.01em; color: #ffd9a0; font-variant-numeric: tabular-nums; }
  /* SPANS BOTH COLUMNS. letter-spacing off: the pixel face is already a full
     em per glyph, and the extra 0.02em was what pushed the longest of the four
     descriptions over onto a second line. */
  .sv-tip-desc { grid-column: 1 / -1; font-size: 11px; line-height: 1.5;
    letter-spacing: 0; color: rgba(232,236,243,0.55); }

  /* A LAST RUN OF ONE reads as a coda, and gets the brighter number for it.
     Keyed on the SHAPE of the table rather than on any id: a single tier
     after every other group is the table saying "and then there is this",
     whatever it happens to be called. */
  .sv-tip-tier-last { padding-top: 14px; }
  .sv-tip-tier-last .sv-tip-price { font-size: 20px; color: #ffe9c6; }

  /* THE INSTRUCTION IS THE WHOLE MECHANISM. Nothing in the game records what
     was bought — Ko-fi's message field is the record, and this line is what
     makes those messages sortable on the other end. PINNED rather than last in
     the scroll: it is deliberately not small print, and a tip that arrives
     with no name in it is a refund and an apology. */
  .sv-tip-how { flex: none; padding: 14px 22px 18px;
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
  /* The grid row clears the 44px floor on its own (a label line, a
     description line and 24px of padding), so this only guarantees it for
     a one-line tier with no description. */
  .sv-touch .sv-tip-tier { min-height: 44px; }

  @media (max-width: 700px) {
    /* The panel has no padding of its own any more — head, rows and the
       instruction each carry their own — so the narrow screen tightens those
       three instead. 18px leaves 321px of row at 390, which is what the
       descriptions wrap against. */
    .sv-tip-head { padding: 20px 60px 14px 18px; }
    .sv-tip-ghead { padding-left: 18px; padding-right: 18px; }
    .sv-tip-tier { padding-left: 18px; padding-right: 18px; }
    .sv-tip-how { padding: 14px 18px 16px; }
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

  // THE TIERS, CUT INTO RUNS OF ONE TAG.
  //
  // A RUN AND NOT A BUCKET. Grouping by unique tag would gather every SEAL row
  // together wherever they sit in the file, which quietly overrules the `order`
  // column — and that column exists precisely so the person writing the row
  // decides the sequence (see tipTable.js). Cutting a new group each time the
  // tag CHANGES keeps the panel in the table's order no matter what the tags
  // do: today that puts the two cheap SEAL rows first, the BOSS row next, and
  // the $100 SEAL row last, on its own, which is where tips.csv puts it.
  //
  // A tier with no tag joins the run it is next to rather than starting one —
  // `tag` is blank-able, and a headless group in the middle of the panel is a
  // worse answer than an unlabelled row inside a labelled group.
  const runs = [];
  for (const t of tiers) {
    const last = runs[runs.length - 1];
    if (last && (!t.tag || t.tag === last.tag)) last.tiers.push(t);
    else runs.push({ tag: t.tag, tiers: [t] });
  }

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
      <div class="sv-tip-scroll">
      <div class="sv-tip-head">
        <div class="sv-tip-title">Add a name to the pool.</div>
        <div class="sv-tip-blurb">Every seal and every boss in this game is named from a list written by real mammals...contribute to the global mutual fund for true seal survivors and their loved ones.</div>
      </div>
      <div class="sv-tip-tiers">
        ${runs.map((run, r) => `
          <div class="sv-tip-group">
            <div class="sv-tip-ghead"><span class="sv-tip-tag">${esc(run.tag)}</span></div>
            ${run.tiers.map((t) => `
              <a class="sv-tip-tier${
                   r === runs.length - 1 && run.tiers.length === 1 ? ' sv-tip-tier-last' : ''
                 }" href="${esc(TIP_JAR_URL)}" target="_blank"
                 rel="noopener noreferrer" data-tier="${esc(t.id)}">
                <span class="sv-tip-label">${esc(t.label)}</span>
                <span class="sv-tip-price">$${t.price}</span>
                ${t.desc ? `<span class="sv-tip-desc">${esc(t.desc)}</span>` : ''}
              </a>`).join('')}
          </div>`).join('')}
      </div>
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
