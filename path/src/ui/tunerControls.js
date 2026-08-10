import { CONFIG, getPath, setPath, saveTuningToStorage } from '../config.js';

// The controls a TUNER_SCHEMA group turns into — sliders, toggles, colour
// swatches and dropdowns. Model and texture uploads live in the Look & Sound
// panel (T) instead, one row per asset. Lives apart from tuner.js because the
// schema is now split across two panels: the ` tuner renders the untagged
// groups, the Look & Sound panel (T) renders the ones tagged
// `panel: 'companions'` or `panel: 'enemies'`. Both build their rows from
// here, so a control behaves and persists identically wherever it's shown,
// and one registry backs refreshTunerRows() for both.

const STYLES = `
  /* A group is a header button + a body that hides when collapsed. The header
     keeps the old .sv-t-group look so nothing visually moved; it's a <button>
     now so it's keyboard-reachable and announces its state. */
  .sv-t-groupwrap { border-bottom: 1px solid rgba(255,255,255,0.06); }
  .sv-t-groupwrap:last-child { border-bottom: none; }
  /* Colour comes from the section above via --sv-sec-soft, falling back to the
     original blue where a group has no section (nothing does today, but the
     fallback is what keeps buildTunerGroups usable on its own). */
  .sv-t-group { display: flex; align-items: center; gap: 7px; width: 100%;
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--sv-sec-soft, #7ad7ff); font-weight: 600; font-family: inherit; text-align: left;
    background: none; border: none; padding: 10px 0; margin: 0; cursor: pointer; }
  /* brightness() rather than a second hardcoded colour — the hover has to work
     for whatever hue the section brought with it. */
  .sv-t-group:hover { filter: brightness(1.3); }
  .sv-t-caret { flex-shrink: 0; font-size: 9px; line-height: 1; opacity: 0.75;
    transition: transform 0.12s ease; }
  .sv-t-groupwrap.sv-t-open .sv-t-caret { transform: rotate(90deg); }
  .sv-t-group-name { flex: 1; }
  /* Count of controls inside, so a collapsed header still says how much is
     hiding under it. */
  .sv-t-group-count { flex-shrink: 0; font-weight: 500; letter-spacing: 0.04em;
    color: rgba(232,236,243,0.3); font-variant-numeric: tabular-nums; }
  .sv-t-groupbody { display: none; padding: 2px 0 12px; }
  .sv-t-groupwrap.sv-t-open .sv-t-groupbody { display: block; }
  /* A section is the level above a group: a named run of groups (or of model
     rows) inside one tab. Each carries its own hue in --sv-sec, so the main
     tuner's 46 groups read as seven families you can find by colour before
     you've read a word — the header, the groups under it and the rule down
     their left edge are all the same colour. Uncoloured sections fall back to
     the old white header on blue groups. (No backticks in here: this block
     lives inside a template literal.) */
  .sv-t-section { border-bottom: 1px solid rgba(255,255,255,0.12); }
  .sv-t-section:last-child { border-bottom: none; }
  .sv-t-sectionhead { display: flex; align-items: center; gap: 8px; width: 100%;
    font-size: 12px; letter-spacing: 0.04em; color: var(--sv-sec, #e8ecf3); font-weight: 600;
    font-family: inherit; text-align: left; background: none; border: none;
    padding: 11px 0; margin: 0; cursor: pointer; }
  .sv-t-sectionhead:hover { filter: brightness(1.25); }
  .sv-t-section-name { flex: 1; }
  .sv-t-section-count { flex-shrink: 0; font-size: 10px; font-weight: 500;
    color: rgba(232,236,243,0.3); font-variant-numeric: tabular-nums; }
  .sv-t-sectionbody { display: none; padding: 0 0 10px 10px;
    border-left: 1px solid var(--sv-sec-dim, rgba(255,255,255,0.07)); margin-bottom: 4px; }
  .sv-t-section.sv-t-open .sv-t-sectionbody { display: block; }
  /* Direct child only — a group's own caret lives deeper inside an open
     section, and a descendant selector here would rotate it while its group
     is still shut. */
  .sv-t-section.sv-t-open > .sv-t-sectionhead > .sv-t-caret { transform: rotate(90deg); }
  .sv-t-allbtn { background: none; border: none; padding: 0; cursor: pointer; font-family: inherit;
    font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
    color: rgba(232,236,243,0.4); }
  .sv-t-allbtn:hover { color: #7ad7ff; }
  .sv-t-row { margin-bottom: 10px; }
  .sv-t-head { display: flex; justify-content: space-between; align-items: baseline;
    font-size: 11px; margin-bottom: 3px; }
  .sv-t-name { color: rgba(232,236,243,0.7); }
  .sv-t-val { font-variant-numeric: tabular-nums; color: #e8ecf3; font-weight: 600; }
  /* Scoped to the row rather than to a panel — these same rows render inside
     both .sv-tuner and .sv-tex, and a panel-scoped selector styled them in
     only one of them. */
  .sv-t-row input[type=range] { width: 100%; accent-color: #7ad7ff; height: 16px; margin: 0; }
  .sv-t-row select { width: 100%; background: rgba(255,255,255,0.06); color: #e8ecf3; font-family: inherit;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; padding: 5px 6px; font-size: 11px; }
  .sv-t-toggle { display: flex; align-items: center; gap: 8px; font-size: 11px; color: rgba(232,236,243,0.7); }
  .sv-t-toggle input { accent-color: #7ad7ff; }
  .sv-t-color { display: flex; align-items: center; gap: 8px; }
  .sv-t-color input[type=color] { width: 32px; height: 24px; border: 1px solid rgba(255,255,255,0.2);
    border-radius: 5px; background: none; padding: 0; cursor: pointer; }
  .sv-t-color span.sv-t-name { flex: 1; }
  .sv-t-btn { flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
    color: #e8ecf3; border-radius: 7px; padding: 8px; font-size: 11px; font-weight: 600;
    cursor: pointer; font-family: inherit; }
  .sv-t-btn:hover { border-color: #7ad7ff; color: #7ad7ff; }
  /* A CHOICE is a wrapping row of pills rather than a <select>. Used for the
     beat divisions, where the whole point is comparing options: a dropdown
     hides eleven of its twelve entries behind a click, so auditioning "is this
     better on 1/8 or on a bar" costs two interactions per comparison instead
     of one. Twelve short labels fit in two lines, so all of them stay visible
     and the current one is legible without opening anything. */
  .sv-t-choice { display: flex; flex-wrap: wrap; gap: 4px; }
  .sv-t-chip { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
    color: rgba(232,236,243,0.6); border-radius: 5px; padding: 3px 7px; font-size: 10px;
    font-weight: 600; font-family: inherit; cursor: pointer; line-height: 1.4;
    font-variant-numeric: tabular-nums; }
  .sv-t-chip:hover { border-color: #7ad7ff; color: #7ad7ff; }
  .sv-t-chip.sv-t-on { background: rgba(122,215,255,0.18); border-color: #7ad7ff; color: #cdefff; }
  /* A READOUT is derived text, never an input — what the numbers above it add
     up to. Monospace and tabular so columns of figures line up down the panel
     rather than jittering as values change. */
  .sv-t-readout { font-size: 10px; line-height: 1.55; color: rgba(232,236,243,0.5);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap;
    background: rgba(255,255,255,0.03); border-radius: 6px; padding: 6px 7px;
    border-left: 2px solid rgba(122,215,255,0.35); }
`;

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// One registry for every control in either panel, so refreshTunerRows() after
// a Reset or an import updates all of them — a per-panel registry would leave
// whichever panel didn't trigger the change showing stale values.
const rows = [];

// Which headers are expanded, by key: a group's own name (unique across
// TUNER_SCHEMA), or `section:<name>` for the section level above it — prefixed
// so a section and a group that happen to share a name don't toggle together.
// Kept in its own localStorage key, well away from the tuning snapshot —
// collapsing a header is a view preference, not an edit, and must never end up
// written into imported-tuning.json.
const OPEN_KEY = 'svTunerOpenGroups';
let openGroups = null;

function openSet() {
  if (openGroups) return openGroups;
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
    openGroups = new Set(Array.isArray(saved) ? saved : []);
  } catch {
    openGroups = new Set();
  }
  return openGroups;
}

function persistOpenGroups() {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...openSet()]));
  } catch {
    // Private-mode / quota. The panel still works, it just forgets which
    // sections were open next reload.
  }
}

// Build a run of TUNER_SCHEMA groups (header + controls) into a fragment.
// Every group is a collapsed accordion section by default: the ` panel alone
// carries 40-odd groups, and one flat scroll of every slider meant hunting for
// "Oxygen" by dragging the scrollbar past everything else. Collapsed, the
// headers read as a table of contents you can skim in one screen.
export function buildTunerGroups(groups, onChange) {
  injectStyles();
  const open = openSet();
  const frag = document.createDocumentFragment();
  for (const group of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'sv-t-groupwrap';

    const body = document.createElement('div');
    body.className = 'sv-t-groupbody';
    for (const item of group.items) body.appendChild(buildRow(item, onChange));

    const h = document.createElement('button');
    h.type = 'button';
    h.className = 'sv-t-group';

    const caret = document.createElement('span');
    caret.className = 'sv-t-caret';
    caret.textContent = '▶';
    const name = document.createElement('span');
    name.className = 'sv-t-group-name';
    name.textContent = group.group;
    const count = document.createElement('span');
    count.className = 'sv-t-group-count';
    count.textContent = String(controlCount(group.items));
    h.append(caret, name, count);

    wrap.dataset.openKey = group.group;
    const isOpen = open.has(group.group);
    wrap.classList.toggle('sv-t-open', isOpen);
    h.setAttribute('aria-expanded', String(isOpen));

    h.addEventListener('click', () => {
      const nowOpen = !wrap.classList.contains('sv-t-open');
      wrap.classList.toggle('sv-t-open', nowOpen);
      h.setAttribute('aria-expanded', String(nowOpen));
      if (nowOpen) open.add(group.group);
      else open.delete(group.group);
      persistOpenGroups();
    });

    wrap.append(h, body);
    frag.appendChild(wrap);
  }
  return frag;
}

// One named run of groups (or of anything else — the Models tab fills sections
// with creature rows). Returns the wrapper to append and the body to fill; the
// caller sets the count once it knows how much went in, because a collapsed
// header that doesn't say how much is under it is the thing that makes you
// open all six to find one.
//
// `scope` is the tab the section belongs to. The section names repeat across
// tabs on purpose — "Escorts" means the same thing on Sound as on Companions —
// so without a scope in the key, expanding one would expand its namesakes on
// every other tab, and Expand-all on a 41-sound tab would quietly unfold five
// others you weren't looking at.
export function buildSection(title, scope = '', color = '') {
  injectStyles();
  const open = openSet();
  const key = scope ? `section:${scope}:${title}` : `section:${title}`;

  const wrap = document.createElement('div');
  wrap.className = 'sv-t-section';
  wrap.dataset.openKey = key;
  if (color) {
    // Three steps of the one hue: the header at full strength, the group
    // headers under it a touch softer so the two levels still separate, and the
    // rule down the body's edge faint enough to be a boundary rather than a
    // stripe. Derived here rather than in CSS so there's one place to read the
    // palette from, and no dependency on color-mix().
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    wrap.style.setProperty('--sv-sec', color);
    wrap.style.setProperty('--sv-sec-soft', `rgba(${r},${g},${b},0.82)`);
    wrap.style.setProperty('--sv-sec-dim', `rgba(${r},${g},${b},0.3)`);
  }

  const body = document.createElement('div');
  body.className = 'sv-t-sectionbody';

  const h = document.createElement('button');
  h.type = 'button';
  h.className = 'sv-t-sectionhead';
  const caret = document.createElement('span');
  caret.className = 'sv-t-caret';
  caret.textContent = '▶';
  const name = document.createElement('span');
  name.className = 'sv-t-section-name';
  name.textContent = title;
  const count = document.createElement('span');
  count.className = 'sv-t-section-count';
  h.append(caret, name, count);

  const isOpen = open.has(key);
  wrap.classList.toggle('sv-t-open', isOpen);
  h.setAttribute('aria-expanded', String(isOpen));

  h.addEventListener('click', () => {
    const nowOpen = !wrap.classList.contains('sv-t-open');
    wrap.classList.toggle('sv-t-open', nowOpen);
    h.setAttribute('aria-expanded', String(nowOpen));
    if (nowOpen) open.add(key);
    else open.delete(key);
    persistOpenGroups();
  });

  wrap.append(h, body);
  return { el: wrap, body, setCount: (n) => (count.textContent = String(n)) };
}

// Sort a tab's groups into the sections it declares, in the order it declares
// them, and build the lot. `order` decides what shows and in what sequence;
// anything tagged with a section the tab doesn't list — or tagged with none at
// all — lands in a trailing "More" rather than silently vanishing from the UI,
// which is how a new group ends up with no way to reach it.
// `order` is either plain section names or [name, colour] pairs — the ` panel
// colours its seven families, the Look & Sound tabs so far don't.
export function buildSectionedTunerGroups(groups, order, onChange, scope = '') {
  const OTHER = 'More';
  const colors = new Map(order.map((s) => (Array.isArray(s) ? s : [s, ''])));
  const bySection = new Map([...colors.keys()].map((s) => [s, []]));
  for (const group of groups) {
    const key = bySection.has(group.section) ? group.section : OTHER;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(group);
  }

  const frag = document.createDocumentFragment();
  for (const [title, members] of bySection) {
    if (!members.length) continue;
    const section = buildSection(title, scope, colors.get(title) ?? '');
    section.body.appendChild(buildTunerGroups(members, onChange));
    section.setCount(members.reduce((n, g) => n + controlCount(g.items), 0));
    frag.appendChild(section.el);
  }
  return frag;
}

// A one-click "open everything" escape hatch, for when you'd rather scroll the
// whole panel the way it used to be — or want to scan every value at once.
// Its label tracks the panel, including headers toggled individually, so it
// never claims it will collapse a panel that's already fully collapsed.
export function buildExpandAllToggle(root) {
  injectStyles();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sv-t-allbtn';

  const anyClosed = () => !!root.querySelector('[data-open-key]:not(.sv-t-open)');
  const syncLabel = () => (btn.textContent = anyClosed() ? 'Expand all' : 'Collapse all');

  btn.addEventListener('click', () => {
    setGroupsExpanded(root, anyClosed());
    syncLabel();
  });
  // Headers live inside root, so their clicks bubble here — a manual toggle
  // keeps the label honest without polling.
  root.addEventListener('click', () => queueMicrotask(syncLabel));
  syncLabel();
  return btn;
}

// Open or close every collapsible header in a panel at once — sections and the
// groups inside them — and remember it. Used by the panels' own
// expand/collapse-all buttons. Driven off data-open-key so both levels are
// handled by one loop and neither can be left half-toggled: expanding sections
// but not groups would look like the button did nothing.
export function setGroupsExpanded(root, expanded) {
  const open = openSet();
  for (const wrap of root.querySelectorAll('[data-open-key]')) {
    wrap.classList.toggle('sv-t-open', expanded);
    const h = wrap.querySelector('.sv-t-group, .sv-t-sectionhead');
    h?.setAttribute('aria-expanded', String(expanded));
    const key = wrap.dataset.openKey;
    if (!key) continue;
    if (expanded) open.add(key);
    else open.delete(key);
  }
  persistOpenGroups();
}

// What a collapsed header claims is hiding under it. Readouts are excluded:
// they are derived text, and counting them makes a group of six sliders
// announce itself as eight things to tune.
function controlCount(items) {
  return items.reduce((n, i) => n + (i.type === 'readout' ? 0 : 1), 0);
}

export function buildRow(item, onChange) {
  injectStyles();
  const row = document.createElement('div');
  row.className = 'sv-t-row';

  // Derived text — no path, no input, nothing to persist. `lines()` is called
  // fresh on every refresh, so a readout can report on values that live
  // several groups away (the bloom threshold, the BPM) and still be current.
  if (item.type === 'readout') {
    const head = document.createElement('div');
    head.className = 'sv-t-head';
    const name = document.createElement('span');
    name.className = 'sv-t-name';
    name.textContent = item.label ?? '';
    head.append(name);
    const out = document.createElement('div');
    out.className = 'sv-t-readout';
    row.append(head, out);
    const entry = { item, readout: out };
    rows.push(entry);
    paintReadout(entry);
    return row;
  }

  // Button picker — a wrapping row of pills, all options visible at once.
  // Same config contract as the dropdown below (a list of string `options`);
  // the difference is entirely about how fast you can compare them.
  if (item.type === 'choice') {
    const head = document.createElement('div');
    head.className = 'sv-t-head';
    const name = document.createElement('span');
    name.className = 'sv-t-name';
    name.textContent = item.label ?? item.path.split('.').slice(-1)[0];
    head.append(name);

    const bar = document.createElement('div');
    bar.className = 'sv-t-choice';
    const chips = [];
    const paint = () => {
      const v = getPath(CONFIG, item.path);
      for (const c of chips) c.classList.toggle('sv-t-on', c.dataset.value === String(v));
    };
    for (const opt of item.options) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sv-t-chip';
      chip.dataset.value = opt;
      chip.textContent = opt;
      chip.addEventListener('click', () => {
        setPath(CONFIG, item.path, opt);
        paint();
        onChange?.(item.path);
        // Divisions feed the timing readouts a few rows down, so those have to
        // be repainted here — nothing else is watching this value change.
        refreshReadouts();
        saveTuningToStorage();
      });
      chips.push(chip);
      bar.appendChild(chip);
    }
    paint();
    row.append(head, bar);
    rows.push({ item, chips, paintChoice: paint });
    return row;
  }

  // Dropdown (e.g. the post-processing preset).
  if (item.options) {
    const head = document.createElement('div');
    head.className = 'sv-t-head';
    const name = document.createElement('span');
    name.className = 'sv-t-name';
    name.textContent = item.label ?? item.path.split('.').slice(-1)[0];
    head.append(name);

    const select = document.createElement('select');
    for (const opt of item.options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }
    select.value = getPath(CONFIG, item.path);
    select.addEventListener('change', () => {
      setPath(CONFIG, item.path, select.value);
      onChange?.(item.path);
      refreshReadouts();
      saveTuningToStorage();
    });
    row.append(head, select);
    rows.push({ item, select });
    return row;
  }

  // Colour picker.
  if (item.type === 'color') {
    const row2 = document.createElement('div');
    row2.className = 'sv-t-color';
    const name = document.createElement('span');
    name.className = 'sv-t-name';
    name.textContent = item.label ?? item.path.split('.').slice(-1)[0];
    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = hexToCss(getPath(CONFIG, item.path));
    swatch.addEventListener('input', () => {
      setPath(CONFIG, item.path, cssToHex(swatch.value));
      onChange?.(item.path);
      refreshReadouts();
      saveTuningToStorage();
    });
    row2.append(name, swatch);
    row.append(row2);
    rows.push({ item, swatch });
    return row;
  }

  // Checkbox.
  if (item.type === 'bool') {
    const label = document.createElement('label');
    label.className = 'sv-t-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!getPath(CONFIG, item.path);
    box.addEventListener('change', () => {
      setPath(CONFIG, item.path, box.checked);
      onChange?.(item.path);
      refreshReadouts();
      saveTuningToStorage();
    });
    const span = document.createElement('span');
    span.textContent = item.label ?? item.path.split('.').slice(-1)[0];
    label.append(box, span);
    row.append(label);
    rows.push({ item, box });
    return row;
  }

  const head = document.createElement('div');
  head.className = 'sv-t-head';
  const name = document.createElement('span');
  name.className = 'sv-t-name';
  name.textContent = item.label ?? item.path.split('.').slice(-1)[0];
  const val = document.createElement('span');
  val.className = 'sv-t-val';
  head.append(name, val);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = item.min;
  slider.max = item.max;
  slider.step = item.step;
  slider.value = getPath(CONFIG, item.path);

  const sync = () => {
    const v = Number(slider.value);
    val.textContent = formatValue(v);
    setPath(CONFIG, item.path, v);
  };
  sync();

  slider.addEventListener('input', () => {
    sync();
    onChange?.(item.path);
    refreshReadouts();
    saveTuningToStorage();
  });

  row.append(head, slider);
  rows.push({ item, slider, val });
  return row;
}

// Push CONFIG back onto every control in both panels. Called after anything
// that changes values behind the controls' backs — Reset, import, the P key
// cycling the post preset.
export function refreshTunerRows() {
  for (const r of rows) {
    // Readouts first: they have no `path`, so anything reading one off the
    // item would be walking undefined.
    if (r.readout) { paintReadout(r); continue; }
    if (r.paintChoice) { r.paintChoice(); continue; }
    const v = getPath(CONFIG, r.item.path);
    if (r.select) { r.select.value = v; continue; }
    if (r.box) { r.box.checked = !!v; continue; }
    if (r.swatch) { r.swatch.value = hexToCss(v); continue; }
    r.slider.value = v;
    r.val.textContent = formatValue(v);
  }
}

/**
 * Repaint the derived rows and nothing else.
 *
 * Called from every control's change handler, because a readout summarises
 * values that are NOT the row above it — the bloom check reads three colour
 * swatches, two sliders and CONFIG.bloom, and the timing rows read the BPM
 * from a different section entirely. Cheap enough to run unconditionally: it
 * touches only the handful of readout rows, not the several hundred sliders.
 */
export function refreshReadouts() {
  for (const r of rows) {
    if (r.readout) paintReadout(r);
  }
}

function paintReadout(entry) {
  let lines = [];
  try {
    lines = entry.item.lines?.() ?? [];
  } catch (err) {
    // A readout is a diagnostic. It must never be the thing that takes the
    // panel down — a half-built config during an import would otherwise throw
    // on every frame of the rebuild.
    lines = [`(readout failed: ${err?.message ?? err})`];
  }
  entry.readout.textContent = (Array.isArray(lines) ? lines : [lines]).join('\n');
}

export function formatValue(v) {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) < 1 ? 3 : 2);
}

export function hexToCss(n) {
  return '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
}

export function cssToHex(css) {
  return parseInt(css.slice(1), 16);
}
