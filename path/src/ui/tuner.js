import { CONFIG, TUNER_SCHEMA, DEFAULTS, saveTuningToStorage, loadTuningFromStorage, clearSavedTuning, importTuning, setTuningSaveErrorHandler, resetConfigToDefaults } from '../config.js';
import { buildSectionedTunerGroups, buildExpandAllToggle, buildTunerSearch, refreshTunerRows } from './tunerControls.js';
import { refreshUpgradeTable, refreshTexturePanelRows } from './textures.js';
import { isTypingTarget } from './typing.js';

// The ` panel: everything in TUNER_SCHEMA that ISN'T tagged for another panel.
//
// Groups tagged `panel: 'companions'` or `panel: 'enemies'` render in the Look
// & Sound panel (T) instead, next to the models and upgrade table they belong
// with — this panel was one flat scroll of 43 groups, and finding e.g. Seal
// Team in it meant knowing it sat between HUD and Music.
//
// The controls themselves come from tunerControls.js, shared with that panel,
// so a slider works and saves the same way wherever it's shown.

// The panel's seven families, in the order they appear, each with the hue its
// headers and its left rule take. Colour is doing real work here rather than
// decorating: 46 group headers in one column all read as one list, and the
// question you arrive with is almost always "which family" — audio, the world,
// the camera — before it is "which group". The hues are spread far enough
// apart to survive being seen one at a time, in a strip 300px wide, and are
// bright enough on the near-black panel to keep the headers legible.
const SECTIONS = [
  ['Gameplay',              '#7ad7ff'],
  ['The ocean',             '#4fe0c0'],
  ['Camera',                '#c9a6ff'],
  ['Creature rigging',      '#a6e05a'],
  ['Look & FX',             '#ff8fb1'],
  ['Interface & controls',  '#ffc46b'],
  ['Audio',                 '#ee87e0'],
];

const STYLES = `
  .sv-tuner { position: fixed; top: 0; right: 0; bottom: 0; width: 300px; z-index: 30;
    background: rgba(10,12,18,0.94); border-left: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(10px); color: #e8ecf3; font-family: 'Inter', system-ui, sans-serif;
    overflow-y: auto; padding: 16px 18px 32px; }
  .sv-tuner.sv-hidden { display: none; }
  .sv-tuner h2 { font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase;
    font-weight: 600; margin: 0 0 4px; }
  .sv-tuner .sv-t-meta { font-size: 11px; color: rgba(232,236,243,0.4); margin-bottom: 14px;
    font-variant-numeric: tabular-nums; }
  .sv-t-expand-row { display: flex; justify-content: flex-end; padding-bottom: 2px;
    border-bottom: 1px solid rgba(255,255,255,0.08); }
  .sv-t-actions { display: flex; gap: 8px; margin-top: 22px; flex-wrap: wrap; }
  .sv-t-note { font-size: 10px; color: rgba(232,236,243,0.35); margin-top: 10px; line-height: 1.5; }
  .sv-t-elsewhere { font-size: 10px; color: rgba(232,236,243,0.35); margin: 18px 0 0;
    padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); line-height: 1.5; }
`;

let panel = null;
let metaEl = null;

export function initTuner(onChange) {
  const restored = loadTuningFromStorage();

  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  panel = document.createElement('div');
  panel.className = 'sv-tuner sv-hidden';

  const header = document.createElement('div');
  header.innerHTML = `<h2>Tuning</h2>`;
  panel.appendChild(header);

  metaEl = document.createElement('div');
  metaEl.className = 'sv-t-meta';
  metaEl.textContent = '—';
  panel.appendChild(metaEl);

  // Groups collapse individually; this opens or closes the lot. Filled before
  // the toggle is built — the toggle reads the container to label itself, and
  // an empty one looks fully expanded.
  const groupsEl = document.createElement('div');
  groupsEl.appendChild(buildSectionedTunerGroups(
    TUNER_SCHEMA.filter((g) => !g.panel), SECTIONS, onChange, 'tuner',
  ));

  // Above the expand/collapse row, because it is the faster of the two ways
  // through 46 groups and the one you reach for first. Seven sections deep,
  // "which family is the bloom knee filed under" is a guess you shouldn't have
  // to make — type it and the group opens around it, still in its family.
  const search = buildTunerSearch(groupsEl, { placeholder: 'Search sliders and paths…' });
  panel.appendChild(search);

  const expandAll = document.createElement('div');
  expandAll.className = 'sv-t-expand-row';
  expandAll.appendChild(buildExpandAllToggle(groupsEl));
  panel.append(expandAll, groupsEl);

  const actions = document.createElement('div');
  actions.className = 'sv-t-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'sv-t-btn';
  copyBtn.textContent = 'Copy values';
  copyBtn.addEventListener('click', async () => {
    // Dump everything DEFAULTS covers — i.e. every section the tuner can
    // actually change — rather than a hardcoded handful. This used to list
    // only arena/camera/player/weapon/spawn/enemies, which silently omitted
    // every section added since (bloom, fins, oxygen, garlic, shrimpRing,
    // strike, the four abilities, points, crabSpawn, sfx, emitters,
    // levelUpCards, ...), so copying your tuning quietly lost most of it.
    const snapshot = {};
    for (const key of Object.keys(DEFAULTS)) snapshot[key] = CONFIG[key];
    const dump = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(dump);
      copyBtn.textContent = 'Copied';
    } catch {
      console.log(dump);
      copyBtn.textContent = 'Logged to console';
    }
    setTimeout(() => (copyBtn.textContent = 'Copy values'), 1400);
  });

  const resetBtn = document.createElement('button');
  resetBtn.className = 'sv-t-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.addEventListener('click', () => {
    resetConfigToDefaults();
    refreshTuner();
    // The Upgrades table lives in the other panel and reads CONFIG.upgrades
    // once, at build time — without this it kept showing the names and stack
    // caps that were just reset away.
    refreshUpgradeTable();
    // Same reasoning as the line above, for the Sound, Haptics and Particles
    // tabs — they build their own controls outside TUNER_SCHEMA, so
    // refreshTuner() above does not reach them.
    refreshTexturePanelRows();
    onChange?.('*');
    clearSavedTuning();
    setStatus('Reset to the saved baseline in imported-tuning.json.');
  });
  resetBtn.title = 'Snap every value back to what imported-tuning.json holds on disk';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'sv-t-btn';
  clearBtn.textContent = 'Clear cache';
  clearBtn.title = "Forget this browser's copy only — imported-tuning.json on disk is untouched";
  clearBtn.addEventListener('click', () => {
    clearSavedTuning();
    setStatus("Browser copy cleared. Disk tuning is untouched.");
  });

  // Export / import — localStorage is per-browser and per-origin, so it does
  // NOT follow you to another machine or to the desktop app. A JSON file is
  // the thing that actually moves your tuning between them.
  const exportBtn = document.createElement('button');
  exportBtn.className = 'sv-t-btn';
  exportBtn.textContent = 'Export file';
  exportBtn.title = 'Download every tuned value as JSON — use this to carry tuning to another machine or to Claude Desktop';
  exportBtn.addEventListener('click', () => {
    const snapshot = {};
    for (const key of Object.keys(DEFAULTS)) snapshot[key] = CONFIG[key];
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `seal-survivor-tuning-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Exported. Import this file wherever you continue.');
  });

  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.style.display = 'none';
  const importBtn = document.createElement('button');
  importBtn.className = 'sv-t-btn';
  importBtn.textContent = 'Import file';
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      // Same deep-merge path a saved snapshot takes, so an older exported
      // file can't delete config keys added since it was written.
      importTuning(parsed);
      refreshTuner();
      refreshUpgradeTable();
      refreshTexturePanelRows();
      onChange?.('*');
      saveTuningToStorage();
      setStatus(`Imported ${file.name}.`);
    } catch (err) {
      setStatus(`Couldn't read ${file.name} — not a valid tuning file.`);
      console.warn('[tuner] import failed —', err?.message ?? err);
    }
  });

  actions.append(copyBtn, resetBtn, clearBtn, exportBtn, importBtn, importInput);
  panel.appendChild(actions);

  const note = document.createElement('div');
  note.className = 'sv-t-note';
  note.id = 'svTunerNote';
  note.textContent = restored
    ? 'Restored newer tuning from this browser cache — it will be written back to imported-tuning.json on your next edit.'
    : 'Changes auto-save to path/src/imported-tuning.json. They persist across reloads and travel with the repo.';
  panel.appendChild(note);

  // A failed disk write used to be a console warning nobody would see, while
  // the tuning quietly went nowhere. Now it says so, in the panel, in red.
  setTuningSaveErrorHandler((msg) => {
    note.style.color = '#ff8080';
    note.textContent = `NOT saving to disk (${msg}). Values are cached in this browser only — start the dev server (npm run dev) to make them permanent.`;
  });

  // Says where the groups that used to be in this scroll went, so "I can't
  // find the Seal Team sliders any more" doesn't just become a different
  // version of the problem this split was meant to solve.
  const elsewhere = document.createElement('div');
  elsewhere.className = 'sv-t-elsewhere';
  elsewhere.textContent = 'Companions (seal team, beluga, eel, shrimp, garlic, starfish, seagull, strike) and enemies (schools, sharks, spawn rates, boats, crabs, difficulty) are in the Look & Sound panel — press T. So are the procedural skins: every glow and shell pattern is on that panel’s Models tab now, with the tints and textures they stand in for.';
  panel.appendChild(elsewhere);

  document.body.appendChild(panel);

  window.addEventListener('keydown', (e) => {
    if ((e.key === '`' || e.key === '~') && !isTypingTarget(e.target)) {
      e.preventDefault();
      panel.classList.toggle('sv-hidden');
    }
  });
}

function setStatus(text) {
  const note = document.getElementById('svTunerNote');
  if (note) note.textContent = text;
}

export function refreshTuner() {
  refreshTunerRows();
}

export function setTunerMeta(text) {
  if (metaEl) metaEl.textContent = text;
}
