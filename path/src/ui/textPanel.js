import { CONFIG, TUNER_SCHEMA, saveTuningToStorage } from '../config.js';
import { TEXT_ROLES } from '../textRoles.js';
import { fontLabel } from '../fonts.js';
import { buildSectionedTunerGroups, buildExpandAllToggle, buildTunerSearch, refreshTunerRows } from './tunerControls.js';
import { previewToasts, popupPose, previewScreen, PREVIEW_SCREENS } from './ui.js';
import { isTypingTarget } from './typing.js';
import { CALLOUTS, resolveCalloutText } from '../systems/callouts.js';
import { DEVICES } from '../devices.js';

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
  ['HUD', '#4fe0c0'],
  ['Upgrade cards', '#c9a6ff'],
  ['Popups', '#ff8fb1'],
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
  /* The button role paints a fill as well as text, so it wants to be a shape
     rather than a run of inline words. */
  .sv-txp-spec .sv-btn { display: inline-block; }
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
  for (const name of PREVIEW_SCREENS) {
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
    + 'falls back through its stack. The screen you pick stays up after you close the panel — press `start` '
    + 'to put the menu back. This panel sits on the same edge as the ` tuner and covers it; press ` to put '
    + 'that one away.';
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

function sampleFor(role) {
  const wants = ROLE_ROWS[role.key];
  if (!wants) return role.sample;
  let best = '';
  for (const row of CALLOUTS.values()) {
    if (!wants(row)) continue;
    for (const device of DEVICES) {
      // Resolved, so a line naming a control sets the words the player
      // would actually read rather than a brace and a token name.
      const text = resolveCalloutText(row, device);
      if (text.length > best.length) best = text;
    }
  }
  // A table that failed to parse falls back to the hand-typed line rather than
  // to an empty specimen — a blank row in here reads as the role being broken,
  // which is a worse lie than a short sample.
  return best || role.sample;
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

    // THE SAMPLE WEARS THE ROLE'S OWN CLASS. That is the whole trick: the rule
    // typography.js writes for `.sv-title` is a plain class selector, so a
    // <span class="sv-title"> in here is styled by exactly the rule the game's
    // title is styled by — not by an approximation of it maintained separately.
    const sample = document.createElement('span');
    sample.className = role.selector.replace(/^\./, '');
    sample.textContent = sampleFor(role);
    // The chain banner's colour is written inline in the game, so the specimen
    // has to write one too or it would be the only line rendering unstyled.
    if (role.inlineColor) sample.dataset.inlineColor = '1';
    line.appendChild(sample);

    line.addEventListener('click', () => openRole(role.key));
    specEl.appendChild(line);
  }
  paintSpecimen();
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
    line.firstChild.textContent = `${role.label} · ${font} · ${s.size}px`;
    if (role.inlineColor) {
      // THE LIVE COLOUR WHERE THE ROLE NAMES ONE. An inlineColor role is one
      // ui.js paints per element, so its STORED colour is by definition not
      // what is on screen — and a specimen showing a colour the game does not
      // draw is worse than no specimen, because somebody will tune against it.
      // Falls back to the stored value for the roles whose live colour is not a
      // single number (the strike prompt walks a hue wheel). See textRoles.js.
      const sample = line.lastChild;
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
    const line = specEl.querySelector(`[data-role="${role.key}"]`);
    const sample = line?.lastChild;
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
    const sample = specEl.querySelector(`[data-role="${role.key}"]`)?.lastChild;
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
