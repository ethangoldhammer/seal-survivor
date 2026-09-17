import { CONFIG, TUNER_SCHEMA, saveTuningToStorage } from '../config.js';
import { TEXT_ROLES, roleUnit } from '../textRoles.js';
import { fontLabel } from '../fonts.js';
import { buildSectionedTunerGroups, buildExpandAllToggle, buildTunerSearch, refreshTunerRows } from './tunerControls.js';
import { previewToasts, popupPose, previewScreen, previewScreenNames } from './ui.js';
import { isTypingTarget } from './typing.js';
import { CALLOUTS, resolveCalloutText } from '../systems/callouts.js';
import { DEVICES } from '../devices.js';
// The loading screen's tips are the second table with a role over it — read
// live for the same reason the callouts are, and resolved the same way so a
// tip naming a control sets the words rather than a brace.
import { LOAD_TIPS } from '../loadTipTable.js';
import { textForDevice } from '../deviceText.js';
import { fillBindings } from '../systems/bindingText.js';
// The table itself, not uiText(): a role's `sampleFrom` is an id held in data,
// and npm run test:uitext refuses a uiText() call whose id is not a literal.
// Read straight off the table, a missing row is the id — the same fallback.
import { UI_TEXT } from '../uiTextTable.js';
// The longest name the roster can cast, for `{name}` in a specimen.
import { sealNameParts } from '../systems/randomName.js';
import { joinSealName } from '../sealNameTable.js';

// THE TEXT PANEL (Y) — where every piece of type in the game is designed.
//
// It is a third panel rather than another section of the ` tuner for the same
// reason the Look & Sound panel (T) is one: what you need in front of you while
// choosing a font is the TEXT, not a scroll of forty groups about the ocean.
// So this panel opens with a specimen strip — one live line per role, drawn by
// the very rules being edited — and the controls sit underneath it.
//
// The controls themselves are ordinary TUNER_SCHEMA groups tagged
// `panel: 'text'`, built by tunerControls.js, so a row here saves, resets and
// refreshes exactly like a row anywhere else. Nothing about persistence is
// re-implemented in this file.
//
// THE PANEL DOES NOT WEAR THE FONT IT IS SELLING. Its own type is pinned to
// Inter and it lives outside .sv-ui, deliberately: a tool that becomes
// unreadable when you audition Press Start 2P at 2.2× is a tool you can't use
// to get back out again. The specimen strip is the one part that opts in.

const SECTIONS = [
  ['Global', '#7ad7ff'],
  ['Screens', '#ffc46b'],
  // The two lines on the loading screen. Its own section rather than a pair of
  // rows under Screens because it is not one: it is the surface that is up
  // BEFORE any of them, drawn by a module that has no assets, no WebGL and no
  // .sv-ui around it. Keeping it separate is also the reminder that changing
  // these is the one type decision a player sees before the game has loaded.
  ['Loading', '#9fb4ff'],
  ['HUD', '#4fe0c0'],
  ['Upgrade cards', '#c9a6ff'],
  ['Popups', '#ff8fb1'],
  // The match, and the screen before it. Green for the pitch; the warmer one
  // for the select, which is the one screen of the mode that is a menu.
  ['Blubberball', '#7dffb0'],
  ['Team select', '#ffa86b'],
];

const STYLES = `
  .sv-txp { position: fixed; top: 0; right: 0; bottom: 0; width: 320px; z-index: 31;
    background: rgba(10,12,18,0.94); border-left: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(10px); color: #e8ecf3; font-family: 'Inter', system-ui, sans-serif;
    overflow-y: auto; padding: 16px 18px 32px; }
  .sv-txp.sv-hidden { display: none; }
  .sv-txp h2 { font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase;
    font-weight: 600; margin: 0 0 4px; }
  .sv-txp-meta { font-size: 11px; color: rgba(232,236,243,0.4); margin-bottom: 12px; line-height: 1.5; }

  /* THE SPECIMEN. Sits on the page's own dark rather than on the panel's, so
     what you're judging is text on the colour it will actually be read on —
     a role at 0.35 opacity looks fine on a light panel and vanishes over the
     sea. Sticky, so it stays in front of you while you scroll to the group
     that changes it. */
  /* CAPPED, and it has to be. Fifteen roles at their real sizes — a 30px title
     among them — comes to 634px, which in a 720px panel is a specimen sheet
     with a tuner hiding behind it. It scrolls inside itself instead, and
     opening a role's group brings that role's line into view in here. */
  .sv-txp-spec { position: sticky; top: -16px; z-index: 2; margin: 0 -18px 12px;
    padding: 10px 18px 12px; background: linear-gradient(180deg, #05070d, #0a1420);
    border-top: 1px solid rgba(255,255,255,0.06);
    border-bottom: 1px solid rgba(255,255,255,0.12);
    max-height: 38vh; overflow-y: auto; overscroll-behavior: contain; }
  .sv-txp-spec.sv-hidden { display: none; }
  .sv-txp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .sv-txp-toggle { background: none; border: none; padding: 0; cursor: pointer;
    font-family: inherit; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
    font-weight: 600; color: rgba(232,236,243,0.4); }
  .sv-txp-toggle:hover { color: #7ad7ff; }
  /* Every specimen line is a button: clicking one opens that role's group and
     scrolls to it, so "this line is wrong" and "here are its controls" are one
     gesture rather than a hunt down a column of fifteen headers. */
  .sv-txp-line { display: block; width: 100%; text-align: left; background: none;
    border: none; border-radius: 5px; padding: 2px 5px; margin: 0 0 1px; cursor: pointer;
    color: inherit; font: inherit; }
  .sv-txp-line:hover { background: rgba(122,215,255,0.1); }
  .sv-txp-line.sv-txp-on { background: rgba(122,215,255,0.16); }
  /* The popup roles are positioned absolutely in the game and the level strip
     is pinned to the top of the screen — wearing their real classes brings
     that with them, and those lines would stack in the corner instead of
     sitting in the list. Position is the ONE thing the specimen overrides;
     every other declaration is the live rule, untouched.

     THE THREE CALLOUT ROLES WERE MISSING FROM THIS LIST, and had been since
     they were added. ui/callout.js pins .sv-callout at left: 50% and the boost
     line at left: 0, both absolute, so the warning band, the first-run tip and
     the boost line were laid on top of each other in the corner of the strip
     — the exact failure this rule was written to prevent, in the roles it was
     never extended to. It stayed invisible while all three samples were short
     single lines that happened to land in roughly the right place.

     The width goes with the position for the same reason. .sv-callout is
     "width: max-content" up to 88vw, which is a sentence that does not wrap in
     a 320px panel and hangs out of it instead; in the game that box is the
     width of the screen. Capped to the strip so the specimen wraps where the
     panel does, which is also the only way to see that a long tip wraps at
     all. */
  .sv-txp-spec .sv-toast, .sv-txp-spec .sv-chain, .sv-txp-spec .sv-xptop-level,
  .sv-txp-spec .sv-bossbar, .sv-txp-spec .sv-boss-name,
  .sv-txp-spec .sv-callout, .sv-txp-spec .sv-callout-boost {
    position: static; transform: none; inset: auto; }
  .sv-txp-spec .sv-callout, .sv-txp-spec .sv-callout-boost {
    display: block; width: auto; max-width: 100%; text-align: left; }
  /* The two tooltips are boxes that are born at opacity 0 and fade in when
     shown — in here they are always shown, so the fade is overridden along
     with the position. The box keeps its own padding, border and fill: what
     is being judged is type on THAT fill, not on the strip's. */
  .sv-txp-spec .sv-uptip, .sv-txp-spec .sv-card-fx {
    position: static; opacity: 1; transition: none; display: inline-block;
    width: auto; max-width: 100%; text-align: left; }
  /* The button role paints a fill as well as text, so it wants to be a shape
     rather than a run of inline words. */
  .sv-txp-spec .sv-btn { display: inline-block; }
  /* EVERY SAMPLE, whatever its class. The per-class overrides above were
     written one role at a time and missed three roles for months (see the
     callout note); this is the same override for whichever surface a role
     names — a countdown numeral that is absolute at 42% of the screen and
     born at opacity 0, a locked slot that is a flex row with a margin. Two
     classes deep, so it beats any one-class layout rule and loses to nothing
     the role sheet writes (font, colour, shadow are not touched here). The
     replay loop's inline transform and opacity still win over it, as inline
     always does. */
  .sv-txp-spec .sv-txp-sample { position: static; transform: none; inset: auto;
    opacity: 1; animation: none; margin: 0; pointer-events: none;
    /* Wrapped, whatever the role says. The goal card's scorer and the team
       select's names are nowrap in the game — the card is 92vw wide and the
       slot ellipsises — but this strip is 320px, and a thirty-character name
       at 3.6vmin hangs out of the panel with the end of the line unreadable.
       Whether a name FITS its slot is the layout audit's question (npm run
       layout); this strip's is what the letters look like.

       Wrapped at SPACES first — break-word, not anywhere: the two differ only
       on a word that still doesn't fit, and the other offers the browser
       intra-word breaks while it is MEASURING, so the longest name in the
       table came out broken across six lines mid-word ("Congress/man") when
       three at its own spaces was available.

       (No backticks anywhere in this block: it is inside a template literal
       and one would end the string, with the error pointing at a comment.) */
    white-space: normal; max-width: 100%; overflow-wrap: break-word; }
  /* THE ANCESTORS A DESCENDANT SELECTOR NEEDS. A role like
     '.sv-versus-over .sv-btn' or '.sv-ldg-head .sv-title' is only matched with
     its parent present, so the specimen builds one — and the parent brings
     its own layout (the after-match prompt is a centred flex column with a
     radial scrim in ::before). Flattened to an inline nothing, scrim and all,
     so the wrapper exists for the selector and for nothing else. */
  .sv-txp-spec .sv-txp-wrap { display: inline; position: static; transform: none; inset: auto;
    padding: 0; margin: 0; gap: 0; background: none; border: 0; box-shadow: none;
    pointer-events: none; animation: none; opacity: 1; flex: none; width: auto; }
  .sv-txp-spec .sv-txp-wrap::before, .sv-txp-spec .sv-txp-wrap::after { content: none; }
  /* THE GLASS, for a role whose type is black on a frosted pane (the goal
     card, the replay tag). The pane is the real .sv-glass rule from
     versus.js, tinted P1's colour the way glassTint does it; without it the
     specimen is black type on the strip's near-black, and a role you cannot
     see is a role you tune blind. Padded like the card so the type sits off
     the rim as it does in the game. */
  .sv-txp-spec .sv-txp-plate { display: inline-block; max-width: 100%;
    padding: 6px 12px; --sv-glass-radius: 8px; color: #05070a; }
  .sv-txp-spec .sv-txp-plate .sv-txp-sample { display: inline-block; }
  /* The role's name, in the PANEL's font at a fixed size — it has to stay
     legible no matter what the specimen next to it has been set to. */
  .sv-txp-key { display: block; font-family: 'Inter', system-ui, sans-serif;
    font-size: 8.5px; letter-spacing: 0.09em; text-transform: uppercase; font-weight: 600;
    color: rgba(232,236,243,0.3); margin-bottom: 1px; }
  /* The screen picker. Pills rather than a dropdown for the same reason the
     easing rows are pills: the whole point is comparing, and a dropdown hides
     four of its five options behind a click. */
  .sv-txp-screens { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 0; }
  .sv-txp-actions { display: flex; gap: 8px; margin: 10px 0 4px; flex-wrap: wrap; }
  .sv-txp-btn { flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
    color: #e8ecf3; border-radius: 7px; padding: 8px; font-size: 11px; font-weight: 600;
    cursor: pointer; font-family: inherit; white-space: nowrap; }
  .sv-txp-btn:hover { border-color: #7ad7ff; color: #7ad7ff; }
  .sv-txp-expand { display: flex; justify-content: space-between; align-items: center;
    padding-bottom: 2px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .sv-txp-note { font-size: 10px; color: rgba(232,236,243,0.35); margin-top: 14px; line-height: 1.5; }
`;

const SPEC_KEY = 'svTextSpecimen';

let panel = null;
let specEl = null;
let metaEl = null;
// Which group each role's specimen line points at, so a click can open it.
const groupWraps = new Map();

export function initTextPanel(onChange) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  panel = document.createElement('div');
  panel.className = 'sv-txp sv-hidden';

  const header = document.createElement('div');
  header.className = 'sv-txp-head';
  header.innerHTML = '<h2>Text</h2>';
  panel.appendChild(header);

  specEl = document.createElement('div');
  specEl.className = 'sv-txp-spec';

  // The strip can be put away entirely. Remembered, in its own key well away
  // from the tuning snapshot — hiding a preview is a view preference, not an
  // edit, and must never end up written into imported-tuning.json.
  const specToggle = document.createElement('button');
  specToggle.type = 'button';
  specToggle.className = 'sv-txp-toggle';
  const paintToggle = () => {
    const hidden = specEl.classList.contains('sv-hidden');
    specToggle.textContent = hidden ? 'show specimen' : 'hide specimen';
    specToggle.setAttribute('aria-expanded', String(!hidden));
  };
  specEl.classList.toggle('sv-hidden', localStorage.getItem(SPEC_KEY) === 'off');
  specToggle.addEventListener('click', () => {
    const hidden = specEl.classList.toggle('sv-hidden');
    try {
      localStorage.setItem(SPEC_KEY, hidden ? 'off' : 'on');
    } catch {
      // Private mode. The toggle still works, it just forgets next reload.
    }
    paintToggle();
    if (hidden) stopReplay();
    else startReplay();
  });
  paintToggle();
  header.appendChild(specToggle);
  panel.appendChild(specEl);

  metaEl = document.createElement('div');
  metaEl.className = 'sv-txp-meta';
  panel.appendChild(metaEl);

  // WHAT IS BEHIND THE PANEL. Type is judged in place, and the screen you
  // happen to be on when you press Y is otherwise the only one you get — which
  // on boot is the start menu, in front of everything else. `clear` takes the
  // lot down and leaves the specimen on the side doing the work.
  const screens = document.createElement('div');
  screens.className = 'sv-txp-screens';
  const screenChips = [];
  // Read at build, so anything main.js registered before initTextPanel (the
  // Blubberball surfaces) is a chip beside the four ui.js owns.
  for (const name of previewScreenNames()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sv-t-chip';
    chip.textContent = name;
    if (name === 'cards') chip.title = 'Deals a real hand — picking one grants it, same as Shift+L';
    if (name === 'score card') chip.title = 'An invented run. It is made unpostable before it appears.';
    chip.addEventListener('click', () => {
      previewScreen(name);
      for (const c of screenChips) c.classList.toggle('sv-t-on', c === chip);
    });
    screenChips.push(chip);
    screens.appendChild(chip);
  }
  panel.appendChild(screens);

  const actions = document.createElement('div');
  actions.className = 'sv-txp-actions';

  // The one control in here that isn't a value: it fires the popups so their
  // motion can be watched. See previewToasts in ui.js.
  const playBtn = document.createElement('button');
  playBtn.className = 'sv-txp-btn';
  playBtn.textContent = 'Play popups';
  playBtn.title = 'Fire a burst of score popups and a chain banner, using the current motion';
  playBtn.addEventListener('click', () => previewToasts());

  // Restores the fifteen roles ONLY — not the whole config, which is what the
  // tuner's Reset does. Auditioning type means making a mess of it, and the way
  // back should not cost every other value in the game.
  const resetBtn = document.createElement('button');
  resetBtn.className = 'sv-txp-btn';
  resetBtn.textContent = 'Reset text';
  resetBtn.title = 'Put every text role back to the shipped design. Nothing else in the config is touched.';
  resetBtn.addEventListener('click', () => {
    for (const role of TEXT_ROLES) {
      Object.assign(CONFIG.textStyles[role.key], role.style);
    }
    refreshTunerRows();
    onChange?.('textStyles');
    saveTuningToStorage();
    refreshTextPanel();
  });

  actions.append(playBtn, resetBtn);
  panel.appendChild(actions);

  const groupsEl = document.createElement('div');
  const groups = TUNER_SCHEMA.filter((g) => g.panel === 'text');
  groupsEl.appendChild(buildSectionedTunerGroups(groups, SECTIONS, (path) => {
    onChange?.(path);
    // The specimen is styled by the very rules that just changed, so most of it
    // updates itself — but the readouts beside each line (the font's name, the
    // size) are text this file wrote, and they don't.
    paintSpecimen();
  }, 'text'));

  // Built after the groups so it can find the wrappers to point at.
  indexGroups(groupsEl);

  // Fifteen roles x seven or eight properties each: "where is the letter
  // spacing on the chain banner" is two guesses deep without this.
  panel.appendChild(buildTunerSearch(groupsEl, { placeholder: 'Search text controls…' }));

  const expand = document.createElement('div');
  expand.className = 'sv-txp-expand';
  const hint = document.createElement('span');
  hint.className = 'sv-txp-note';
  hint.style.margin = '0';
  hint.textContent = 'Y closes';
  expand.append(hint, buildExpandAllToggle(groupsEl));
  panel.append(expand, groupsEl);

  const note = document.createElement('div');
  note.className = 'sv-txp-note';
  note.textContent = 'Every value here saves to path/src/imported-tuning.json with the rest of the tuning. '
    + 'Fonts off the shelf are downloaded the first time you pick them — pick one with no network and it '
    + 'falls back through its stack. The screen you pick stays up after you close the panel — pick `menu` '
    + 'to put the title back. The Blubberball screens are invented state and touch no match. This panel '
    + 'sits on the same edge as the ` tuner and covers it; press ` to put that one away.';
  panel.appendChild(note);

  document.body.appendChild(panel);

  buildSpecimen();

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'y' && !isTypingTarget(e.target)) {
      e.preventDefault();
      setTextPanelOpen(panel.classList.contains('sv-hidden'));
    }
  });
}

// Map role key -> the group wrapper its controls live in. Matched on the
// group's own name, which is the role's label — the same string textPanelGroups
// puts in the schema, and the same one buildTunerGroups writes into
// dataset.openKey.
function indexGroups(root) {
  const byName = new Map();
  for (const wrap of root.querySelectorAll('.sv-t-groupwrap[data-open-key]')) {
    byName.set(wrap.dataset.openKey, wrap);
  }
  groupWraps.clear();
  for (const role of TEXT_ROLES) {
    const wrap = byName.get(role.label);
    if (wrap) groupWraps.set(role.key, wrap);
  }
  // A role with no group would be a value with no control — worth a line in the
  // console rather than a specimen that silently does nothing when clicked.
  for (const role of TEXT_ROLES) {
    if (!groupWraps.has(role.key)) {
      console.warn(`[text] role "${role.key}" has no tuner group — its specimen line won't open anything`);
    }
  }
}

// ---------------------------------------------------------------------------
// THE THREE ROLES WHOSE WORDS ARE IN A SPREADSHEET
//
// Every other role's specimen is a hand-typed `sample` in textRoles.js, and for
// most of them that is right: there is no table of titles, and "184,200" stands
// in for a score perfectly well.
//
// The callout roles are different, because their lines ARE a table — and the
// hand-typed samples had gone stale in the worst direction. The first-run tip's
// was "Swim up for air": fifteen characters, the SHORTEST row in callouts.csv,
// on a role that also has to render a hundred-and-one-character line about food
// chains that wraps onto three. So the panel showed a comfortable single line
// while the case that actually decides the type — where it breaks, whether the
// wrap is balanced, whether three lines of it still clear the HUD — was
// invisible in the one tool built for looking at it.
//
// THE LONGEST LINE IN THE TABLE, then, and across every device's wording rather
// than this machine's: a specimen is for designing against the worst case, and
// the worst case for a role is the longest string it will ever be asked to set.
// Same reasoning as the layout audit's coach surface, which picks its line the
// same way and for the same reason.
//
// Read live rather than baked in, so writing a longer tip into the CSV changes
// what this panel shows without anybody remembering to update it. textRoles.js
// stays a leaf module with no imports — the substitution belongs here, in the
// tool, not in the list of roles.
// ---------------------------------------------------------------------------

// role key -> which rows it draws. `warn` and `coach` share the band (a tip
// wears both classes), so they are told apart by KIND rather than by anchor;
// the boost line is the one that is told apart by where it sits.
const ROLE_ROWS = {
  warn: (row) => row.kind === 'warn' && row.anchor === 'band',
  coach: (row) => row.kind === 'coach',
  boostWarn: (row) => row.anchor === 'player',
};

// ---------------------------------------------------------------------------
// THE ROLES WHOSE WORDS ARE ONE ROW OF uiText.csv — `sampleFrom` in
// textRoles.js. Same principle as the callouts above, one row instead of the
// longest of many: the line the specimen shows is the line the player reads,
// so a lorem row shows as lorem and the panel says so. `{name}` in either the
// row or a hand-typed sample is a seal's name, and it is the LONGEST name the
// roster can cast, because the worst case is the case that decides the type.
// ---------------------------------------------------------------------------
let longestName = '';

function longestSealName() {
  if (longestName) return longestName;
  const parts = sealNameParts();
  let best = '';
  // Every adjective against every nickname, under the length rule joinSealName
  // enforces — a pair that does not fit collapses to the nickname, so the
  // longest halves are not necessarily the longest name. A few thousand joins,
  // once.
  for (const a of parts?.adjective ?? []) {
    for (const n of parts?.nickname ?? []) {
      const whole = joinSealName(a.text, n.text);
      if (whole.length > best.length) best = whole;
    }
  }
  for (const f of parts?.full ?? []) if (f.text.length > best.length) best = f.text;
  longestName = best || 'Seal';
  return longestName;
}

function fillName(text) {
  return String(text ?? '').split('{name}').join(longestSealName());
}

function sampleFor(role) {
  if (role.sampleFrom) {
    // A missing row shows its id, the way uiText() itself falls back — the
    // specimen then reads as the id, which is the right kind of wrong.
    const row = UI_TEXT[role.sampleFrom];
    return fillName(row ?? role.sampleFrom);
  }
  // THE LOADING TIP, whose table is loadTips.csv rather than callouts.csv. Same
  // rule and the same reason as the three below it — the longest line the role
  // will ever be asked to set, across every device's wording — with one
  // difference: this role has no hand-typed `sample` to fall back to, because
  // a stand-in here would be a line of the game's voice living in a source
  // file. An unparseable table shows the role's own label, which is
  // unmistakably not a tip.
  if (role.key === 'loadTip') {
    return longestOf(LOAD_TIPS, (row, device) => fillBindings(textForDevice(row, device)))
      || role.label;
  }
  const wants = ROLE_ROWS[role.key];
  if (!wants) return fillName(role.sample);
  const best = longestOf([...CALLOUTS.values()].filter(wants), resolveCalloutText);
  // A table that failed to parse falls back to the hand-typed line rather than
  // to an empty specimen — a blank row in here reads as the role being broken,
  // which is a worse lie than a short sample.
  return best || role.sample;
}

// The longest line a set of rows can produce, across every device's wording.
// A specimen is for designing against the worst case, and the worst case for a
// role is the longest string it will ever be asked to set.
function longestOf(rows, resolve) {
  let best = '';
  for (const row of rows) {
    for (const device of DEVICES) {
      const text = resolve(row, device);
      if (text.length > best.length) best = text;
    }
  }
  return best;
}

function buildSpecimen() {
  specEl.replaceChildren();
  for (const role of TEXT_ROLES) {
    const line = document.createElement('button');
    line.type = 'button';
    line.className = 'sv-txp-line';
    line.dataset.role = role.key;

    const key = document.createElement('span');
    key.className = 'sv-txp-key';
    line.appendChild(key);

    // THE SAMPLE WEARS THE ROLE'S OWN CLASSES. That is the whole trick: the
    // rule typography.js writes for `.sv-title` is a plain class selector, so
    // a <span class="sv-title"> in here is styled by exactly the rule the
    // game's title is styled by — not by an approximation of it maintained
    // separately. mountSelector builds whatever the selector needs to match:
    // one element with two classes, or a parent for a descendant selector.
    const { outer, inner: sample } = mountSelector(role.selector);
    sample.classList.add('sv-txp-sample');
    sample.textContent = sampleFor(role);
    // The chain banner's colour is written inline in the game, so the specimen
    // has to write one too or it would be the only line rendering unstyled.
    if (role.inlineColor) sample.dataset.inlineColor = '1';
    if (role.plate === 'glass') {
      const plate = document.createElement('span');
      plate.className = 'sv-glass sv-txp-plate';
      plate.appendChild(outer);
      line.appendChild(plate);
    } else {
      line.appendChild(outer);
    }

    line.addEventListener('click', () => openRole(role.key));
    specEl.appendChild(line);
  }
  paintSpecimen();
}

/**
 * THE ELEMENTS A ROLE'S SELECTOR MATCHES, built. `.sv-title` is one span with
 * one class; `.sv-versus-count.sv-versus-go` is one span with two; and
 * `.sv-ldg-head .sv-title` is a span INSIDE a span, because a descendant
 * selector matches nothing without its ancestor.
 *
 * That last case was the bug: the old specimen stripped the leading dot and
 * used the rest as a class list, so the score card quip's sample wore the
 * classes "sv-ldg-head" and ".sv-title" (dot included) — and was styled by
 * neither rule. Its line on the panel rendered in the panel's own font at
 * the panel's own size for as long as the role existed, with nothing to say
 * so, since a line of Inter looks like a line of Inter.
 *
 * Every ancestor is tagged `.sv-txp-wrap` so the strip can flatten whatever
 * layout its class brings with it — see the note on that rule.
 */
function mountSelector(selector) {
  const compounds = String(selector).trim().split(/\s+/);
  let outer = null;
  let inner = null;
  for (const compound of compounds) {
    const el = document.createElement('span');
    el.className = compound.split('.').filter(Boolean).join(' ');
    if (inner) {
      inner.classList.add('sv-txp-wrap');
      inner.appendChild(el);
    } else {
      outer = el;
    }
    inner = el;
  }
  return { outer, inner };
}

/** The sample element of a role's line — the one wearing the role's class. */
function sampleOf(key) {
  return specEl?.querySelector(`[data-role="${key}"] .sv-txp-sample`) ?? null;
}

// Open a role's group, scroll to it, and flash the specimen line so the two
// ends of the click are visibly connected.
function openRole(key) {
  const wrap = groupWraps.get(key);
  if (!wrap) return;
  wrap.classList.add('sv-t-open');
  wrap.querySelector('.sv-t-group')?.setAttribute('aria-expanded', 'true');
  // The section above it too — a group opened inside a collapsed section is
  // open and still invisible, which reads as the click having done nothing.
  wrap.closest('.sv-t-section')?.classList.add('sv-t-open');
  wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
  for (const line of specEl.querySelectorAll('.sv-txp-line')) {
    line.classList.toggle('sv-txp-on', line.dataset.role === key);
  }
  // Bring the line itself into view INSIDE the strip — scrollIntoView would
  // scroll the panel as well and undo the scroll above, which reads as the
  // click having jumped somewhere at random.
  const line = specEl.querySelector(`[data-role="${key}"]`);
  if (line) specEl.scrollTop = Math.max(0, line.offsetTop - specEl.clientHeight / 2);
}

// The parts of the specimen this file has to write itself: the label above each
// sample, and the inline colour the chain banner would otherwise not have.
function paintSpecimen() {
  if (!specEl) return;
  for (const role of TEXT_ROLES) {
    const line = specEl.querySelector(`[data-role="${role.key}"]`);
    if (!line) continue;
    const s = CONFIG.textStyles?.[role.key] ?? {};
    const font = s.font && s.font !== 'global' ? fontLabel(s.font) : 'global';
    // The unit is the role's — px for most, vmin for the match's screen-sized
    // lines — and the readout says which, or a 26 next to a 24 would look
    // like two sizes of the same thing.
    line.firstChild.textContent = `${role.label} · ${font} · ${s.size}${roleUnit(role)}`;
    if (role.plate === 'glass') {
      // The pane is P1's colour, the way glassTint in versus.js dresses it —
      // the same wash and rim, so what is being judged is black type on the
      // glass the game draws, not on a guess at it.
      const plate = line.querySelector('.sv-txp-plate');
      const n = (CONFIG.versus?.teams?.[0]?.color ?? 0x3ddc63) >>> 0;
      const rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
      plate?.style.setProperty('--sv-team-wash', `rgba(${rgb},0.26)`);
      plate?.style.setProperty('--sv-team-rim', `rgba(${rgb},0.55)`);
    }
    if (role.inlineColor) {
      // THE LIVE COLOUR WHERE THE ROLE NAMES ONE. An inlineColor role is one
      // ui.js paints per element, so its STORED colour is by definition not
      // what is on screen — and a specimen showing a colour the game does not
      // draw is worse than no specimen, because somebody will tune against it.
      // Falls back to the stored value for the roles whose live colour is not a
      // single number (the strike prompt walks a hue wheel). See textRoles.js.
      const sample = sampleOf(role.key);
      if (!sample) continue;
      const live = role.colorFrom
        ? role.colorFrom.split('.').reduce((o, k) => (o == null ? undefined : o[k]), CONFIG)
        : undefined;
      const hex = (((live ?? s.color ?? 0) >>> 0) & 0xffffff).toString(16).padStart(6, '0');
      sample.style.color = `#${hex}`;
    }
  }
  if (metaEl) {
    const t = CONFIG.typography ?? {};
    metaEl.textContent = `${TEXT_ROLES.length} roles · global font ${fontLabel(t.family)} · size ×${t.scale}`
      + `${t.retro ? ' · retro on' : ''}`;
  }
}

// --- the popup specimens actually move -------------------------------------
// A STYLE row shows its result the instant it changes, because the rule it
// edits is the rule the specimen is wearing. A MOTION row has nothing to show
// on a line of text sitting still — which reads as the panel being dead when
// it is the one kind of row that cannot possibly be live.
//
// So every popup line loops its own arrival and departure, through the same
// popupPose() the game's toast loop calls. Position is left alone: these live
// in a list, and a specimen that flew up the strip would collide with its
// neighbours. Scale, opacity, the lift offset and the bloom are the whole of it.
const REPLAY_GAP = 0.35; // a beat of nothing between loops, so each one reads

let replayRaf = 0;
let replayStart = 0;

function replayFrame(now) {
  replayRaf = 0;
  if (!panel || panel.classList.contains('sv-hidden') || specEl.classList.contains('sv-hidden')) return;
  const t = (now - replayStart) / 1000;
  for (const role of TEXT_ROLES) {
    if (!role.motion) continue;
    const sample = sampleOf(role.key);
    if (!sample) continue;
    // Each kind loops on its OWN life, so shortening one popup's time on screen
    // visibly speeds that line up and leaves its neighbours alone.
    //
    // The callout roles have no `life` slider at all — how long a warning holds
    // is a column in callouts.csv, because it is a property of the message
    // rather than of the animation. The specimen loops them on the shared
    // default instead, which is the hold a row with a blank cell gets: the
    // right length to judge an APPEAR and a LEAVE against.
    const life = CONFIG.textMotion?.[role.motion]?.life ?? CONFIG.callouts?.hold ?? 0.85;
    const cycle = life + REPLAY_GAP;
    const pose = popupPose(role.motion, t % cycle, life);
    sample.style.display = 'inline-block';
    sample.style.transform = `translateY(${pose.lift}px) scale(${pose.scale})`;
    sample.style.opacity = `${pose.alpha}`;
    // Same composition as the game (ui/callout.js): a filter on top, so the
    // role's own text-shadow glow is left to the role sheet and the two never
    // fight over one property.
    sample.style.filter = pose.bloom > 0.05
      ? `drop-shadow(0 0 ${pose.bloom.toFixed(1)}px currentColor)` : 'none';
  }
  replayRaf = requestAnimationFrame(replayFrame);
}

function startReplay() {
  if (replayRaf) return;
  replayStart = performance.now();
  replayRaf = requestAnimationFrame(replayFrame);
}

function stopReplay() {
  if (replayRaf) cancelAnimationFrame(replayRaf);
  replayRaf = 0;
  // Left where they can be READ rather than wherever the loop stopped — a
  // panel put away mid-fade would come back with a half-invisible specimen.
  for (const role of TEXT_ROLES) {
    if (!role.motion) continue;
    const sample = sampleOf(role.key);
    if (!sample) continue;
    sample.style.transform = '';
    sample.style.opacity = '';
    // The bloom goes with them, or a panel closed mid-flare comes back with a
    // specimen wearing a halo it is not supposed to have at rest.
    sample.style.filter = '';
  }
}

/** Push CONFIG back onto the panel — after a Reset, an import, or reopening. */
export function refreshTextPanel() {
  refreshTunerRows();
  paintSpecimen();
}

/**
 * The specimen alone. Separate from the above because this is what runs on
 * every input event of a slider drag, and refreshTunerRows walks every control
 * in all three panels — cheap once, sticky sixty times a second.
 */
export function refreshTextSpecimen() {
  paintSpecimen();
}

/**
 * Open or close the panel. Also what the Y key calls, so the replay loop can
 * never be left running behind a closed panel — a rAF loop nobody can see is
 * a frame budget nobody can find.
 */
export function setTextPanelOpen(open) {
  if (!panel) return;
  panel.classList.toggle('sv-hidden', !open);
  if (!open) { stopReplay(); return; }
  refreshTextPanel();
  if (!specEl.classList.contains('sv-hidden')) startReplay();
}

/** The panel element, for tests. Null before initTextPanel runs. */
export function textPanelEl() {
  return panel;
}
