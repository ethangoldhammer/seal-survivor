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
  .sv-t-group { display: flex; align-items: center; gap: 7px; width: 100%;
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: #7ad7ff; font-weight: 600; font-family: inherit; text-align: left;
    background: none; border: none; padding: 10px 0; margin: 0; cursor: pointer; }
  .sv-t-group:hover { color: #b6e8ff; }
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

// Which group headers are expanded, by group name (names are unique across
// TUNER_SCHEMA). Kept in its own localStorage key, well away from the tuning
// snapshot — collapsing a header is a view preference, not an edit, and must
// never end up written into imported-tuning.json.
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
    count.textContent = String(group.items.length);
    h.append(caret, name, count);

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

// A one-click "open everything" escape hatch, for when you'd rather scroll the
// whole panel the way it used to be — or want to scan every value at once.
// Its label tracks the panel, including headers toggled individually, so it
// never claims it will collapse a panel that's already fully collapsed.
export function buildExpandAllToggle(root) {
  injectStyles();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sv-t-allbtn';

  const anyClosed = () => !!root.querySelector('.sv-t-groupwrap:not(.sv-t-open)');
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

// Open or close every group in a panel at once, and remember it. Used by the
// panels' own expand/collapse-all buttons.
export function setGroupsExpanded(root, expanded) {
  const open = openSet();
  for (const wrap of root.querySelectorAll('.sv-t-groupwrap')) {
    wrap.classList.toggle('sv-t-open', expanded);
    const h = wrap.querySelector('.sv-t-group');
    const label = wrap.querySelector('.sv-t-group-name')?.textContent;
    h?.setAttribute('aria-expanded', String(expanded));
    if (!label) continue;
    if (expanded) open.add(label);
    else open.delete(label);
  }
  persistOpenGroups();
}

export function buildRow(item, onChange) {
  injectStyles();
  const row = document.createElement('div');
  row.className = 'sv-t-row';

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
    const v = getPath(CONFIG, r.item.path);
    if (r.select) { r.select.value = v; continue; }
    if (r.box) { r.box.checked = !!v; continue; }
    if (r.swatch) { r.swatch.value = hexToCss(v); continue; }
    r.slider.value = v;
    r.val.textContent = formatValue(v);
  }
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
