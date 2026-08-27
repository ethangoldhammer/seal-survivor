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
  /* SEARCH. One box per tuning panel, filtering the accordion in place rather
     than opening a separate results list: the tree IS the map of the panel, and
     a flat list of hits throws away the one thing that tells you what a stray
     slider belongs to. Matching rows stay where they are and everything else
     folds away. */
  .sv-t-searchrow { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
  .sv-t-search { flex: 1; min-width: 0; background: rgba(255,255,255,0.06); color: #e8ecf3;
    font-family: inherit; font-size: 11px; border: 1px solid rgba(255,255,255,0.14);
    border-radius: 6px; padding: 6px 8px; }
  .sv-t-search::placeholder { color: rgba(232,236,243,0.35); }
  .sv-t-search:focus { outline: none; border-color: #7ad7ff; }
  /* Says how many controls survived the query. "none" rather than "0" because a
     zero in a panel full of numbers reads as a value, not as a result count. */
  .sv-t-searchcount { flex-shrink: 0; font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
    color: rgba(232,236,243,0.4); font-variant-numeric: tabular-nums; }
  /* Filtered out. !important because a hidden row's own display comes from
     half a dozen rules across three panels, and this has to beat all of them. */
  .sv-t-miss { display: none !important; }
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

// ---------------------------------------------------------------------------
// SEARCH
//
// Every tuning panel is an accordion of collapsed headers, which is a good way
// to read a panel and a bad way to find one control in it: the ` tuner alone
// carries 46 groups across seven sections, and "where is the bloom knee" costs
// you a guess about which family it was filed under before you can even look.
//
// So the query filters the tree IN PLACE rather than building a list of hits.
// A hit stays exactly where it lives, its section and group open around it, and
// everything that missed folds away — which means the answer to "what does this
// slider belong to" is still on screen next to it. A flat results list would
// throw that away, and the thing you most need when a stray control surfaces is
// the context it came from.
//
// A HEADER THAT MATCHES IS ONE HIT, NOT EVERYTHING UNDER IT. Typing "camera" is
// a request for the camera group, so the group survives whole and FOLDED, one
// click from open, rather than spilling its forty sliders over every other hit.
//
// NOTHING HERE WRITES. Not to CONFIG (it only toggles classes) and not to the
// open-groups store: a search expands headers by class alone, and clearing the
// box re-syncs every header from openSet() — the persisted truth — rather than
// from a snapshot. Collapsing a header is already a view preference kept out of
// the tuning file; a search is not even that much of an edit.

const MISS = 'sv-t-miss';

// What a schema row is searchable by: its label, its config path, and the
// option names of a dropdown or a pill row. The path matters as much as the
// label — half of what you know when you go hunting is `bloom.intensity`, and
// none of that string is rendered anywhere on the row.
function rowSearchText(item) {
  const bits = [item.label, item.path];
  if (item.options) bits.push(...item.options);
  if (item.labels) bits.push(...item.labels);
  return bits.filter(Boolean).join(' ').toLowerCase();
}

// Stamp a hand-built row (a creature, an emitter, an upgrade — anything not
// built from TUNER_SCHEMA) with what it should be findable by. Without it those
// rows fall back to their own rendered text, which is every slider label they
// contain: searching "tint" would then match all 48 model rows at once.
export function setRowSearchText(el, text) {
  el.dataset.search = String(text ?? '').toLowerCase();
  return el;
}

const isContainer = (el) =>
  el.classList?.contains('sv-t-section') || el.classList?.contains('sv-t-groupwrap');

const childByClass = (el, cls) => {
  for (const c of el.children) if (c.classList.contains(cls)) return c;
  return null;
};

function headerOf(wrap) {
  return childByClass(wrap, 'sv-t-sectionhead') ?? childByClass(wrap, 'sv-t-group');
}

function bodyOf(wrap) {
  return childByClass(wrap, 'sv-t-sectionbody') ?? childByClass(wrap, 'sv-t-groupbody');
}

function setMiss(el, miss) {
  el.classList.toggle(MISS, miss);
}

// Open or shut a header WITHOUT touching the persisted open set — see the note
// above. aria-expanded moves with it so the panel stays honest to a screen
// reader while it is filtered.
function setOpenVisual(wrap, open) {
  wrap.classList.toggle('sv-t-open', open);
  headerOf(wrap)?.setAttribute('aria-expanded', String(open));
}

// While a query is live a header counts its HITS rather than its contents —
// "3" under a section that holds 40 is the useful number when you are reading a
// filtered panel. The real count is parked on the element and put back when the
// box is cleared.
function setCount(wrap, n) {
  const el = headerOf(wrap)?.querySelector('.sv-t-section-count, .sv-t-group-count');
  if (!el) return;
  if (n === null) {
    if (el.dataset.fullCount !== undefined) {
      el.textContent = el.dataset.fullCount;
      delete el.dataset.fullCount;
    }
    return;
  }
  if (el.dataset.fullCount === undefined) el.dataset.fullCount = el.textContent;
  el.textContent = String(n);
}

// A leaf's searchable text: its stamp if it has one, otherwise whatever it
// renders. Never cached — a readout's text is regenerated on every refresh.
function leafText(el) {
  const stamped = el.dataset?.search;
  return stamped !== undefined ? stamped : (el.textContent ?? '').toLowerCase();
}

// Returns how many hits are showing under `el`.
function filterNode(el, q) {
  if (isContainer(el)) return filterContainer(el, q);

  // A plain wrapper that happens to hold sections — the Upgrades tab wraps its
  // table in one. Transparent to the walk: it shows if anything inside it does.
  if (el.querySelector?.('.sv-t-section, .sv-t-groupwrap')) {
    let shown = 0;
    for (const child of [...el.children]) shown += filterNode(child, q);
    setMiss(el, shown === 0);
    return shown;
  }

  const hit = leafText(el).includes(q);
  setMiss(el, !hit);
  return hit ? 1 : 0;
}

function filterContainer(wrap, q) {
  const nameEl = headerOf(wrap)?.querySelector('.sv-t-section-name, .sv-t-group-name');
  const body = bodyOf(wrap);

  // A HEADER THAT MATCHES IS ONE HIT, NOT EVERYTHING UNDER IT. The group is the
  // thing you were looking for, so it survives whole and folded exactly as the
  // panel had it — real count, nothing inside hidden, one click from open.
  //
  // Unfolding it instead is what this used to do, and it is worse the moment
  // the panel is real: "shark" matches two skin-preset groups whose names say
  // so, and expanding them put 78 sliders on screen above the one model row
  // that was actually being looked for. A destination and a hit are different
  // things, and only one of them should cost you a screen.
  if ((nameEl?.textContent ?? '').toLowerCase().includes(q)) {
    setMiss(wrap, false);
    if (body) restoreSubtree(body);
    setOpenVisual(wrap, openSet().has(wrap.dataset.openKey));
    setCount(wrap, null);
    return 1;
  }

  let shown = 0;
  if (body) for (const child of [...body.children]) shown += filterNode(child, q);

  setMiss(wrap, shown === 0);
  setOpenVisual(wrap, shown > 0);
  setCount(wrap, shown > 0 ? shown : null);
  return shown;
}

// Put a subtree back the way it was: nothing hidden, every header at whatever
// the persisted open set says, real counts restored. Used both to clear a query
// and to hand back an untouched group that matched on its own name.
function restoreSubtree(root) {
  const open = openSet();
  for (const el of root.querySelectorAll(`.${MISS}`)) el.classList.remove(MISS);
  for (const wrap of root.querySelectorAll('[data-open-key]')) {
    setOpenVisual(wrap, open.has(wrap.dataset.openKey));
    setCount(wrap, null);
  }
}

// Filter one root, or several at once (the Look & Sound panel searches all six
// of its tabs so the hit counts can say which tab to open). Returns the number
// of surviving rows per root, in the order given.
export function applyTunerFilter(roots, query) {
  const list = Array.isArray(roots) ? roots : [roots];
  const q = (query ?? '').trim().toLowerCase();
  return list.map((root) => {
    if (!root) return 0;
    if (!q) { restoreSubtree(root); return 0; }
    let shown = 0;
    // The roots themselves are never hidden — a panel that filters itself out
    // of existence has no box left to clear the query from.
    for (const child of [...root.children]) shown += filterNode(child, q);
    return shown;
  });
}

// The box itself. `onFilter(hits, query)` fires after every keystroke for a
// panel that wants to say more than the count beside the input — the tabbed
// panel puts a per-tab number on its tabs.
//
// The returned element carries `.refilter()` for a panel that rebuilds rows
// underneath a live query (Reset rebuilds the Upgrades tab), because those new
// rows arrive unfiltered.
export function buildTunerSearch(roots, { placeholder = 'Search…', onFilter } = {}) {
  injectStyles();
  const list = Array.isArray(roots) ? roots : [roots];

  const wrap = document.createElement('div');
  wrap.className = 'sv-t-searchrow';

  const input = document.createElement('input');
  // type=search for the browser's own clear affordance; isTypingTarget already
  // treats any INPUT as typing, so the panel hotkeys stay off while it has
  // focus and the ` key can be typed into it.
  input.type = 'search';
  input.className = 'sv-t-search';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = placeholder;

  const count = document.createElement('span');
  count.className = 'sv-t-searchcount';

  const run = () => {
    const q = input.value.trim().toLowerCase();
    const hits = applyTunerFilter(list, q);
    const total = hits.reduce((a, b) => a + b, 0);
    count.textContent = q ? (total ? String(total) : 'none') : '';
    onFilter?.(hits, q);
  };

  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    // Escape empties the box rather than reaching whatever else is listening
    // for it — a filtered panel is a state you need a way out of, and the key
    // you reach for is this one.
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (input.value) e.preventDefault();
      input.value = '';
      run();
    }
  });

  wrap.append(input, count);
  wrap.refilter = run;
  wrap.input = input;
  return wrap;
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
  // What search matches this row on. Stamped here rather than read off the
  // rendered text so the CONFIG PATH is searchable too: half of what you know
  // when you go looking for a control is `bloom.intensity`, and none of that
  // string is on screen. A row with no stamp falls back to its own text, which
  // is what keeps the hand-built rows in the Look & Sound panel findable.
  row.dataset.search = rowSearchText(item);

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
    for (const [i, opt] of item.options.entries()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sv-t-chip';
      chip.dataset.value = opt;
      // A separate LABEL, where the stored value isn't fit to read. The font
      // picker stores a whole CSS stack ("'Baloo 2', system-ui, sans-serif")
      // and has to show "Baloo" — and `chipFont` then draws that pill in the
      // family it selects, which is the difference between a list of names and
      // a specimen sheet you can pick off at a glance.
      chip.textContent = item.labels?.[i] ?? opt;
      if (item.chipFont && opt !== 'global') chip.style.fontFamily = opt;
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
  // A PATH THAT DOES NOT EXIST YET IS NOT A VALUE OF ZERO — and it is not the
  // middle of the slider either, which is what `<input type=range>` clamps an
  // undefined to. Building a row used to write that clamp straight into CONFIG,
  // so merely OPENING the panel invented a number for every path the config
  // did not declare, and the next save wrote it to disk forever.
  //
  // 2026-08-14, live: adding one `shell glow` row put `0.5` — the midpoint of
  // its 0..1 range — onto all seven bioluminescence presets, giving every
  // glowing fish in the game a bright shell nobody had asked for. The presets
  // are DIFFS against `base` (see withoutInheritedPresetKeys), so "absent" is
  // the normal, correct state for most of their keys and every future key
  // would have done the same thing.
  //
  // BUILDING A ROW NOW WRITES NOTHING AT ALL. Not merely for the absent case
  // above: a saved value OUTSIDE this row's min/max was clamped by the input
  // and that clamp was written too, so opening the panel quietly destroyed any
  // value the schema had since narrowed its range around. Rendering is
  // rendering; the first write happens when somebody drags.
  const current = getPath(CONFIG, item.path);
  slider.value = current ?? item.min;

  const sync = (write = true) => {
    const v = Number(slider.value);
    val.textContent = formatValue(v);
    if (write) setPath(CONFIG, item.path, v);
  };
  sync(false);

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
// Paths already reported as dead, so the warning is one line per path per
// session rather than one per row per refresh (refreshTuner runs on every
// run start).
const deadPaths = new Set();

export function refreshTunerRows() {
  for (const r of rows) {
    // Readouts first: they have no `path`, so anything reading one off the
    // item would be walking undefined.
    if (r.readout) { paintReadout(r); continue; }
    if (r.paintChoice) { r.paintChoice(); continue; }
    const v = getPath(CONFIG, r.item.path);
    // A ROW POINTING AT A KEY CONFIG.JS NO LONGER DECLARES MUST NOT TAKE THE
    // GAME DOWN. `getPath` hands back undefined for it, and this function is
    // called from refreshTuner — which startGame calls on every single run —
    // so one stale path used to throw inside formatValue and kill startGame
    // itself: the splash's dismissal never returned, its Rive animation froze
    // mid-frame, and the game never started. A dead SLIDER is a cosmetic
    // problem; a dead startGame is the whole game.
    //
    // Same rule paintReadout above already follows, for the same reason.
    // Reported once rather than silently, because a row that shows a dash
    // forever is its own kind of mystery — the fix is to repoint the path in
    // TUNER_SCHEMA (or restore the key), and you cannot do either without
    // being told which one it is.
    if (v === undefined) {
      if (!deadPaths.has(r.item.path)) {
        deadPaths.add(r.item.path);
        console.warn(`[tuner] "${r.item.path}" no longer exists in CONFIG — that control is inert.`
          + ' Repoint it in TUNER_SCHEMA or restore the key.');
      }
      if (r.val) r.val.textContent = '—';
      if (r.slider) r.slider.disabled = true;
      continue;
    }
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
  // Belt to refreshTunerRows' braces. That skips a dead path before it gets
  // here, but this is exported and called from elsewhere, and the failure mode
  // it used to have was catastrophically out of proportion to its job:
  // formatting a number for a label brought down startGame. A dash is what a
  // control with nothing behind it should read.
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) < 1 ? 3 : 2);
}

export function hexToCss(n) {
  return '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
}

export function cssToHex(css) {
  return parseInt(css.slice(1), 16);
}
