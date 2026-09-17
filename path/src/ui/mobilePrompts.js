// ---------------------------------------------------------------------------
// THE PHONE PROMPTS — the three things a browser on a phone will not tell the
// player, and the game has no other way to say.
//
// Every one of them is a thing the GAME CANNOT FIX FROM INSIDE THE PAGE. That
// is the whole entry test for this file, and it is what keeps it from becoming
// a tips drawer:
//
//   sound       the hardware ring/silent switch. A page has no API for it and
//               no way around it — an unlocked AudioContext on a silenced
//               iPhone reports `running` and plays to nobody. The player has a
//               game that boots, animates, and is completely mute, with every
//               volume slider in Options sitting at full.
//   rotate      which way up the phone is held. Both ways play (see the
//               breakpoints in ui.js and devices.js — portrait is a first-class
//               viewport, not a fallback), so this is a SUGGESTION and never a
//               gate: it is dismissible, it never covers a run it was not asked
//               into, and it takes itself down the moment the phone turns.
//   full screen mobile Safari keeps a bar of its own over the bottom of a
//               sideways page and sizes the viewport around it. See
//               systems/fullscreen.js. There is a button for it now, and the
//               button is a 44px glyph in a corner that nobody looks at.
//
// ---------------------------------------------------------------------------
// WHY A SURFACE OF ITS OWN RATHER THAN A COACH LINE.
//
// callouts.csv teaches the WATER — swim, strike, that orb, this boss — and
// systems/tutorial.js fires those against gameplay conditions, once per device,
// pinned to the object they name. Not one of the three above is about the
// water; they are about the slab of glass the water is on. Routing them through
// the coach would mean inventing gameplay conditions for questions gameplay
// cannot ask, and it would spend the coach's one-shot-per-step ledger — which
// is the tutorial's scarcest resource — on the browser's furniture.
//
// ---------------------------------------------------------------------------
// EVERY CONDITION IS LIVE, AND NOTHING HERE LATCHES.
//
// A prompt is not "shown"; it is the current answer to a question, re-asked on
// every event that could change it — a rotation, a resize, fullscreen going on
// or off, a mouse being plugged into a tablet, the stage changing. There is no
// `visible` flag anywhere in this file, because a flag is the thing that gets
// left behind: the failure this shape is written against is the rotate prompt
// still sitting on a landscape screen, or the fullscreen row still offering a
// display the player already took. Ask the question again and that class of bug
// has nowhere to live.
//
// The ONE piece of state is the dismissal ledger, and it is one-way: an id goes
// in and never comes out. So the worst a stale ledger can do is stay quiet.
//
// ---------------------------------------------------------------------------
// TWO OF THEM TAKE THEMSELVES DOWN. The sound and rotate rows are read in a
// couple of seconds and then they are furniture, and the X is a 44px target
// sitting over the bottom of the water that a player has to notice, aim at and
// mean. So after AUTO_DISMISS_MS of being ON SCREEN they dismiss themselves —
// through the same ledger the X writes to, so "it went away on its own" and "I
// closed it" are the same event and neither comes back.
//
// The clock only runs while the row is actually up, and it is thrown away the
// moment the row goes down for any other reason: a rotate row that was up for
// two seconds before the phone turned was not read, and it gets its full time
// again the next time the phone is upright. The fullscreen row has no timer —
// it is a label on a control the player is being offered, and an offer that
// expires while you are deciding is worse than one you have to close.
//
// ---------------------------------------------------------------------------
// WHERE IT IS NOT. `.sv-center` surfaces — the level-up hand, the pause menu,
// the score card — are full-screen layers at z-index 8, and this sits at 5 with
// the run's own furniture, so it is covered while any of them is up. Same rule
// as the pause and fullscreen buttons, for the same reason: a prompt floating
// over a menu that has its own buttons is a prompt that gets tapped by mistake.
// ---------------------------------------------------------------------------

import { isBrowser } from '../platform.js';
import { fullscreenAvailable, isFullscreen, onFullscreenChange } from '../systems/fullscreen.js';
import { settings, onSettingsChanged } from '../systems/settings.js';
import { uiText } from '../uiTextTable.js';

// WHICH SCREEN THE GAME IS ON, pushed in by main.js (setMobilePromptStage).
//
// Three values, and the split that matters is `run` against the other two: the
// menu is a screen with room for a sentence and no cost to reading it, and a
// run is neither. `splash` is separate from `menu` rather than folded into it
// because the Rive title card is a z-index 20 layer over the whole overlay —
// anything drawn here during it is styled, measured and invisible.
const STAGES = ['splash', 'menu', 'run'];
let stage = 'splash';

// The live surface, or null. One at a time by construction; ui.js mounts it
// once at boot and never takes it down.
let live = null;

const STORAGE_KEY = 'sealSurvivor.phonePrompts.v1';

// IS THERE A THUMB ON THIS SCREEN? Read off `.sv-touch` on the UI root rather
// than by calling touchPrimary() here.
//
// It is the same answer either way in the game — markTouch() in ui.js sets that
// class from exactly that query and keeps it in step — so this is not a second
// source of truth. It is the FIRST one: ui.js's own note on markTouch says the
// class exists precisely because `pointer: coarse` is unfakeable from outside,
// and every layout rule in this game that depends on the player's hand is
// routed through the class so that `npm run layout` can stand in for a device
// it is not running on.
//
// Asking the query directly here would have made this surface the one part of
// the interface that audit can never draw: an iframe inherits `pointer: coarse`
// from the laptop the sweep is running on, so all three rows would answer "no
// thumb" in all 128 tiles and the sweep would report a clean sheet it had never
// looked at. That is the one result this repo treats as worse than a failure.
//
// A mount with no root — a harness handing in a bare div — answers no, which is
// the safe way to be wrong: a prompt that stays quiet.
let uiRootNode = null;
function hasThumb() {
  return !!uiRootNode?.classList?.contains('sv-touch');
}

// ---------------------------------------------------------------------------
// THE THREE. `when` is asked afresh every refresh and may say no forever (a
// desktop) or only for now (a phone already in landscape).
//
// `stages` is which screens the row may appear on at all — NOT a guess at where
// it is useful, but where reading it costs the player nothing. Only `rotate`
// reaches `run`, and that is the whole of the "rotate anywhere" decision: the
// other two are answers to questions you ask on the way in, and a row about the
// browser's chrome arriving over a boss fight is an interruption about nothing.
// ---------------------------------------------------------------------------
// HOW LONG A ROW GETS BEFORE IT CLOSES ITSELF. Long enough to read ninety
// characters twice over on a phone that has just been picked up, and short
// enough that it is gone before it is in the way. Overridable at the mount so
// the harness can assert the behaviour without sitting there for eight seconds.
const AUTO_DISMISS_MS = 8000;

const PROMPTS = [
  {
    id: 'sound',
    line: () => uiText('mobileSoundPrompt'),
    stages: ['menu'],
    // The switch is iOS's, but Android has a silent mode of its own and the
    // sentence is true on both — so this is gated on the HAND rather than on a
    // user-agent sniff, which is the guess platform.js exists to avoid making.
    //
    // NOT WHILE THE PLAYER HAS MUTED IT THEMSELVES. Telling somebody who turned
    // the game's own sound off to go and flip their phone's switch is the game
    // arguing with a choice it was asked to make, and it is the one way this
    // row can be actively wrong rather than merely unneeded.
    when: () => hasThumb() && !settings.audio?.muted,
    autoDismiss: true,
  },
  {
    id: 'rotate',
    line: () => uiText('mobileRotatePrompt'),
    // The one row that may appear over a run — the phone can be turned at any
    // moment, and the answer to "should I turn it back" is worth having then.
    stages: ['menu', 'run'],
    // A SUGGESTION, NEVER A GATE. Portrait is a supported viewport (see the
    // 700px block in ui.js, and `narrowScreen`), so this row has no authority
    // to block anything and does not try to: it says the screen is bigger the
    // other way and gets out of the way when it is.
    when: () => hasThumb() && isPortrait(),
    autoDismiss: true,
  },
  {
    id: 'fullscreen',
    line: () => uiText('mobileFullscreenPrompt'),
    stages: ['menu'],
    // The same three questions the button itself asks (ui/fullscreenButton.js),
    // plus the fourth that only matters here: a player who is ALREADY
    // fullscreen is being offered something they have.
    when: () => hasThumb() && isBrowser() && fullscreenAvailable() && !isFullscreen(),
  },
];

const PROMPT_IDS = new Set(PROMPTS.map((p) => p.id));

// --- the glyphs -------------------------------------------------------------
// One 24px square each, stroked rather than filled so they stay legible at the
// row's opacity over bright water — the same argument the fullscreen button's
// brackets make. `fullscreen` deliberately draws the SAME brackets the button
// does: the row is a label on that control, and a second mark for one control
// is a second thing to learn.
const GLYPHS = {
  sound: '<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z"/><path d="M17 8.5 A5 5 0 0 1 17 15.5"/><path d="M19.5 5.5 A9 9 0 0 1 19.5 18.5"/>',
  rotate: '<rect x="8.5" y="2.5" width="7" height="19" rx="1.6"/><path d="M4.2 15.5 A9 9 0 0 0 8.5 19.4"/><path d="M2.6 12.2 L4.2 15.9 L7.9 14.3"/>',
  fullscreen: '<path d="M3 8 V3 H8"/><path d="M16 3 H21 V8"/><path d="M21 16 V21 H16"/><path d="M8 21 H3 V16"/>',
};

// A style element rather than the inline cssText the fullscreen button uses.
// That button is one node with no states; this is a stack of rows that each
// need a pressed state and a shared entrance, and three copies of the same
// declaration block written into three `style` attributes is three places for
// them to drift apart.
//
// EXPORTED so the harness can assert against the SOURCE rather than against a
// mounted node. Two reasons, and the second is the one that matters: jsdom's
// CSS engine rewrites env() into nonsense on the way into a stylesheet, so a
// check read back off the element fails on styling that is perfectly correct on
// a phone — and this surface is invisible to `npm run layout`, which only ever
// sees a screen with no thumb on it, so the geometry has nowhere else to be
// checked. Same bargain FS_BUTTON_CSS makes next door.
export const PROMPT_CSS = `
  .sv-phone-prompts { position: fixed; z-index: 5;
    left: 50%; transform: translateX(-50%);
    bottom: calc(14px + env(safe-area-inset-bottom, 0px));
    display: flex; flex-direction: column; align-items: stretch; gap: 6px;
    width: min(340px, calc(100vw - 32px));
    /* .sv-ui is pointer-events:none so the overlay does not eat the ocean, and
       that inherits — a row that does not opt back in draws perfectly and
       cannot be pressed. See the same note on .sv-pausebtn. */
    pointer-events: none; }
  .sv-phone-prompt { display: flex; align-items: center; gap: 10px;
    pointer-events: all;
    padding: 9px 10px 9px 11px; border-radius: 10px;
    background: rgba(5, 7, 13, 0.78); border: 1px solid rgba(232, 236, 243, 0.14);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
    color: #e8ecf3; text-align: left;
    -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  .sv-phone-prompt svg { flex: none; display: block; }
  .sv-phone-prompt-text { flex: 1 1 auto; font-size: 13px; line-height: 1.32;
    color: rgba(232, 236, 243, 0.92); }
  /* 44px square, the same floor every other tap target in the game is held to
     (see TAP_MIN in tools/layout/layout-audit.js). The glyph inside is smaller
     than the target on purpose: what has to be 44px is the thing a thumb aims
     at, not the thing an eye reads. */
  .sv-phone-prompt-x { flex: none; width: 44px; height: 44px; margin: -9px -10px -9px 0;
    padding: 0; border: 0; background: none; cursor: pointer;
    pointer-events: all; touch-action: manipulation;
    color: rgba(232, 236, 243, 0.55);
    -webkit-tap-highlight-color: transparent;
    display: flex; align-items: center; justify-content: center; }
  .sv-phone-prompt-x:active { color: #e8ecf3; }
  @media (prefers-reduced-motion: no-preference) {
    .sv-phone-prompt { animation: svPhonePromptIn 0.22s ease both; }
  }
  @keyframes svPhonePromptIn { from { opacity: 0; transform: translateY(6px); } }
`;

/**
 * Is the phone upright? The media query rather than `screen.orientation`, which
 * is absent on older iOS and answers about the DEVICE — a tablet in a stand is
 * `landscape-primary` with a portrait-shaped browser window on it. The shape of
 * the viewport is the thing every layout rule in this game is written against,
 * so it is the thing this asks about too.
 */
function isPortrait() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(orientation: portrait)')?.matches ?? false;
}

// --- the ledger -------------------------------------------------------------
// Wrapped on every path, exactly as tutorial.js's is: localStorage throws
// outright in a private window and on an opaque origin, and a prompt is not
// worth taking the game down for. The failure mode of a swallowed throw is that
// a dismissed row comes back next session, which is the right way to be wrong.

function loadDismissed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    // Filtered against the live list so an id from a hand-edited key cannot
    // silently suppress a prompt added later under the same key.
    return Array.isArray(list) ? list.filter((id) => PROMPT_IDS.has(id)) : [];
  } catch {
    return [];
  }
}

function saveDismissed(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch { /* private window, quota, opaque origin — the row simply returns */ }
}

/**
 * Which screen the game is on. Called from main.js's frame loop, so it is a
 * string compare that returns immediately unless the answer actually moved —
 * a refresh per frame would be a layout read per frame for a surface that
 * changes a handful of times a session.
 *
 * Exported at module scope rather than handed back on the mount handle because
 * main.js does not own the mount: ui.js does, at boot, and main.js should not
 * have to reach through it to say what screen it is on.
 */
export function setMobilePromptStage(next) {
  if (!STAGES.includes(next) || next === stage) return;
  stage = next;
  live?.refresh();
}

/** For the harness, and for a reload of the UI: put the stage back to boot. */
export function resetMobilePromptStage() {
  stage = 'splash';
}

/**
 * Draw the stack into `parent` and hand back a handle.
 *
 * @param opts.parent   the .sv-ui overlay.
 * @param opts.onPress  called on a PRESSED dismissal, for the click sound —
 *                      ui.js owns feedback(), and importing it here would drag
 *                      the audio stack into every harness that mounts this. A
 *                      row closing itself is not a press and makes no sound.
 * @param opts.autoDismissMs  how long a self-closing row stays up. The harness
 *                      turns it down; nothing in the game passes it.
 * @returns {{ el, refresh, remove, shown: () => string[] }}
 */
export function mountMobilePrompts({ parent, onPress = null, autoDismissMs = AUTO_DISMISS_MS } = {}) {
  const doc = parent?.ownerDocument ?? document;
  uiRootNode = parent ?? null;

  // One stylesheet per document, not per mount. A harness that mounts twice
  // would otherwise stack identical rules, and the second copy is invisible
  // right up until one of them is edited.
  if (!doc.getElementById('svPhonePromptCss')) {
    const style = doc.createElement('style');
    style.id = 'svPhonePromptCss';
    style.textContent = PROMPT_CSS;
    (doc.head ?? doc.documentElement).appendChild(style);
  }

  const el = doc.createElement('div');
  el.className = 'sv-phone-prompts';
  el.id = 'svPhonePrompts';

  const dismissed = new Set(loadDismissed());
  // The row nodes, built once and kept — a row that is rebuilt on every refresh
  // restarts its entrance animation every time anything on the page resizes.
  const rows = new Map();
  // id -> the handle of the row's own countdown, while it is running. Not state
  // about what is shown — refresh() still owns that — just the clock, and it
  // exists only for as long as the row it belongs to is on screen.
  const timers = new Map();

  // ONE DISMISSAL PATH for the X and for the clock, so the two cannot drift
  // into meaning different things.
  function dismiss(id) {
    dismissed.add(id);
    saveDismissed(dismissed);
    refresh();
  }

  for (const prompt of PROMPTS) {
    const row = doc.createElement('div');
    row.className = 'sv-phone-prompt';
    row.dataset.prompt = prompt.id;
    row.innerHTML = `
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none"
           stroke="#e8ecf3" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
           style="opacity:0.82;">${GLYPHS[prompt.id]}</svg>
      <div class="sv-phone-prompt-text"></div>
      <button class="sv-phone-prompt-x" type="button">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6 L18 18"/><path d="M18 6 L6 18"/>
        </svg>
      </button>`;

    // READ AT MOUNT, NOT AT MODULE LOAD, and through a thunk per row rather
    // than one shared call reading an id out of the row.
    //
    // THE ID HAS TO BE A LITERAL IN THE SOURCE. `npm run test:uitext` joins the
    // table to the code by reading the ids out of the call sites, and it fails
    // both ways — a read with no row, and a row with no read. An id held in a
    // data table and passed through a variable is invisible to that join, so
    // every one of these lines would report as an unread row and the check
    // would be telling us to delete copy that is on screen.
    //
    // Held in the node rather than re-read on every refresh: the table does not
    // change while the page is open.
    row.querySelector('.sv-phone-prompt-text').textContent = prompt.line();

    const close = row.querySelector('.sv-phone-prompt-x');
    close.setAttribute('aria-label', uiText('mobilePromptDismiss'));
    close.addEventListener('click', () => {
      onPress?.();
      dismiss(prompt.id);
    });

    rows.set(prompt.id, row);
    el.appendChild(row);
  }

  /**
   * Re-ask every question and show exactly the rows whose answer is yes.
   *
   * ONE FUNCTION FOR ALL THREE, and for the stage as well, because they are
   * answered at the same moments: a rotation changes `rotate`, a resize can
   * change which hand is on it, and leaving fullscreen changes both `fullscreen` and
   * how much room there is for any of it. Three refreshers would be three
   * chances to leave one row disagreeing with the screen.
   */
  function refresh() {
    let any = false;
    for (const prompt of PROMPTS) {
      const row = rows.get(prompt.id);
      let show = false;
      try {
        show = !dismissed.has(prompt.id)
          && prompt.stages.includes(stage)
          && prompt.when();
      } catch (err) {
        // A capability check that throws is a prompt we cannot answer for, and
        // the honest answer to that is silence rather than a row about a
        // feature that may not exist. Warned, because it is never expected.
        console.warn(`[phone-prompts] ${prompt.id} —`, err?.message ?? err);
        show = false;
      }
      row.style.display = show ? 'flex' : 'none';
      // `hidden` alongside the style so a screen reader and the pad's own row
      // lists agree with the glass about what exists.
      row.hidden = !show;
      any = any || show;

      // The countdown follows the row rather than the question: it starts when
      // the row appears, and it is torn up — not paused — the moment the row
      // goes away for any other reason, so the next appearance gets the whole
      // of its time rather than the tail of a previous one.
      const timer = timers.get(prompt.id);
      if (show && prompt.autoDismiss && autoDismissMs > 0 && timer === undefined) {
        timers.set(prompt.id, setTimeout(() => {
          timers.delete(prompt.id);
          dismiss(prompt.id);
        }, autoDismissMs));
      } else if (!show && timer !== undefined) {
        clearTimeout(timer);
        timers.delete(prompt.id);
      }
    }
    // The container too, so an empty stack is not a pointer-events target and a
    // 340px-wide invisible box is not sitting over the bottom of the ocean.
    el.style.display = any ? 'flex' : 'none';
    el.hidden = !any;
  }

  // --- everything that can change an answer ---------------------------------
  // Listed rather than polled. Each one of these is a real event the browser
  // fires, and a timer would be a guess at how often the world changes that is
  // simultaneously too slow to feel right and too fast to be free.
  //
  // `resize` AND `orientationchange`, because the pair is not redundant on the
  // device this file is for: iOS fires orientationchange before the viewport
  // has finished changing shape, and some shells fire only one of the two.
  // Asking twice costs a handful of media-query reads.
  const onViewport = () => refresh();
  window.addEventListener('resize', onViewport);
  window.addEventListener('orientationchange', onViewport);
  const stopFullscreen = onFullscreenChange(refresh);
  // Plugging a mouse into a tablet flips the hand, and markTouch() in ui.js
  // rewrites `.sv-touch` when it does. Listened to here as well rather than
  // read off that listener, because a class attribute has no change event and
  // the alternative is a MutationObserver over the busiest node on the page.
  // Both are driven by the same query, so they cannot disagree — the only
  // question is ordering, and a refresh that runs one tick early simply runs
  // again on the next event.
  const hand = window.matchMedia?.('(hover: none) and (pointer: coarse)');
  hand?.addEventListener?.('change', refresh);
  // ...and the portrait query itself, which is the one signal that fires on a
  // rotation that does NOT change the window's pixel count — a browser that
  // reports the same viewport through a flip would otherwise leave the row up.
  const upright = window.matchMedia?.('(orientation: portrait)');
  upright?.addEventListener?.('change', refresh);
  // Muting the game from Options is a direct answer to the sound row's
  // question, and it should take the row down on the press rather than at the
  // next resize.
  const stopSettings = onSettingsChanged((path) => {
    if (path === '*' || path === 'audio.muted') refresh();
  });

  refresh();
  parent?.appendChild(el);

  live = {
    el,
    refresh,
    /** Which rows are up right now, for the harness. */
    shown: () => PROMPTS.filter((p) => !rows.get(p.id).hidden).map((p) => p.id),
    remove: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('orientationchange', onViewport);
      stopFullscreen();
      hand?.removeEventListener?.('change', refresh);
      upright?.removeEventListener?.('change', refresh);
      stopSettings();
      el.remove();
      uiRootNode = null;
      live = null;
    },
  };
  return live;
}
