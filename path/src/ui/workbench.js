import { CONFIG, saveTuningToStorage } from '../config.js';
import { feedback } from '../systems/feedback.js';
import { emit } from '../entities/particles.js';
import { describeHaptic, previewHaptic } from '../systems/haptics.js';
import {
  playSfx, unlockAudio, gainToDb, dbToGain, DB_FLOOR, watchSfx, sfxVoiceLoad,
  busReduction, sampleCount, reloadSample, getAudioContext, isMuted,
} from '../systems/audio.js';
import { uploadAsset } from '../systems/assetUpload.js';
import { stageState, onStageChanged } from '../systems/stage.js';

// THE FEEL WORKBENCH — F.
//
// One surface for what an event does, because an event is one thing and the
// game's panels had it in three. `kill` used to be tuned in the Sound tab (its
// voice), the Haptics tab (its rumble) and — for seven events out of seventy-
// seven — the ` tuner (shake, hit-stop, ripple). The other seventy had no UI
// for half of what they do at all. feedback() fires all of it in one call, so
// the thing you are actually judging was never in one place.
//
// WHY EVENTS AND NOT SOUNDS. CONFIG.sfx is a list of voices; CONFIG.feedback is
// a list of moments. You tune moments. The catch is that several moments share
// one voice — chumEaten borrows bite, and there are seven such — so editing a
// level here can be heard somewhere you weren't looking. That is not hidden:
// every shared voice says who else hears it, and the picker will fork one.
//
// The layout is a rail, a detail pane and a dock, and the reason is width. The
// old Sound tab put 67 voices and up to nine sliders each into a 300px column,
// which is why its stylesheet carries a min-width:0 hack to stop the readouts
// falling off the right edge. This is a workbench; it gets the screen.
//
// The stage bar (ui/stage.js) is deliberately NOT absorbed into this. It is
// fixed to the bottom and floats over whatever is up, because parking the
// camera and firing an event are useful from the game as well as from here.

const RAIL_SECTIONS = [
  ['Your weapon', ['shoot', 'hit', 'bulletHit', 'kill', 'bigKill', 'bounce', 'missileLaunch', 'missileImpact']],
  ['The seal', ['playerHit', 'playerDeath', 'boost', 'bite', 'breach', 'splash', 'seabedThud', 'seabedImpact', 'breathIn', 'bubblePop', 'oxygenWarn']],
  ['Strike & food chain', ['strike', 'strikeChain', 'strikeBurst', 'strikeRam', 'strikeMark', 'foodChain']],
  ['Pickups & progression', ['pickup', 'chumSlurp', 'chumEaten', 'chumHoover', 'levelUp']],
  ['Escorts', ['sealRam', 'sealLunge', 'sealShot', 'eelBolt', 'eelChain', 'belugaTrap', 'dumboCharm', 'octoGrab', 'octoPop', 'orcaStrike']],
  ['Auras & orbits', ['garlicTick', 'shrimpHit', 'calamariPulse']],
  ['Thrown & launched', ['seagullDive', 'scallopLaunch', 'scallopJet', 'pearlShot', 'pearlBurst', 'bakalarHaul', 'bakalarBombDrop', 'bakalarBombBlast']],
  ['Boats', ['debrisBreak', 'boatExplosion', 'crewEaten', 'crewHit']],
];

const STYLES = `
  .sv-wb { position: fixed; inset: 0 0 96px 0; z-index: 31; display: none;
    grid-template-columns: 248px 1fr 272px;
    background: rgba(6,7,11,0.96); backdrop-filter: blur(12px); color: #e8ecf3;
    font-family: 'Inter', system-ui, sans-serif; font-size: 12px; }
  .sv-wb.sv-wb-on { display: grid; }
  .sv-wb-rail { border-right: 1px solid rgba(255,255,255,0.09); overflow-y: auto; }
  .sv-wb-main { display: flex; flex-direction: column; overflow: hidden; }
  .sv-wb-dock { border-left: 1px solid rgba(255,255,255,0.09); display: flex; flex-direction: column; overflow: hidden; }

  .sv-wb h2 { font-size: 11px; letter-spacing: 0.11em; text-transform: uppercase; font-weight: 600; margin: 0; }
  .sv-wb-railhead { padding: 12px 13px 10px; border-bottom: 1px solid rgba(255,255,255,0.08);
    position: sticky; top: 0; background: rgba(8,9,14,0.98); z-index: 2; }
  .sv-wb-search { width: 100%; margin-top: 8px; background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; color: #e8ecf3;
    font: inherit; font-size: 11px; padding: 5px 8px; }
  .sv-wb-meta { font-size: 10px; color: rgba(232,236,243,0.4); margin-top: 6px; font-variant-numeric: tabular-nums; }
  .sv-wb-sec { font-size: 9px; letter-spacing: 0.09em; text-transform: uppercase;
    color: rgba(232,236,243,0.36); padding: 12px 13px 4px; font-weight: 600; }
  .sv-wb-ev { display: flex; align-items: center; gap: 7px; padding: 5px 13px; cursor: pointer;
    font-size: 11.5px; border-left: 2px solid transparent; }
  .sv-wb-ev:hover { background: rgba(255,255,255,0.04); }
  .sv-wb-ev.sv-wb-on-row { background: rgba(122,215,255,0.1); border-left-color: #7ad7ff; color: #bfe9ff; }
  .sv-wb-ev .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-wb-dots { display: flex; gap: 2.5px; flex-shrink: 0; }
  .sv-wb-dot { width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,0.13); }
  .sv-wb-dot.s { background: #ffb347; } .sv-wb-dot.h { background: #7ad7ff; } .sv-wb-dot.i { background: #ff8fb1; }

  .sv-wb-head { padding: 13px 18px 11px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
  .sv-wb-title { display: flex; align-items: baseline; gap: 10px; }
  .sv-wb-title h1 { font-size: 18px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  .sv-wb-via { font-size: 10.5px; color: rgba(232,236,243,0.4);
    font-family: ui-monospace, Menlo, monospace; }
  .sv-wb-chips { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
  .sv-wb-chip { font-size: 9px; padding: 2.5px 7px; border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.15); color: rgba(232,236,243,0.6); }
  .sv-wb-chip.warn { border-color: rgba(255,179,71,0.5); color: #ffb347; background: rgba(255,179,71,0.07); }
  .sv-wb-chip.link { border-color: rgba(122,215,255,0.4); color: #7ad7ff; }
  .sv-wb-chip.bad { border-color: rgba(255,128,149,0.5); color: #ff8095; background: rgba(255,128,149,0.07); }

  /* auto-fit, not a fixed pair: the detail pane is whatever is left after the
     rail and the dock, which on a laptop is under 420px — and two hard columns
     there clipped the Rumble card off the right edge entirely. It collapses to
     one column rather than shrinking past legibility. */
  .sv-wb-cols { flex: 1; overflow-y: auto; padding: 13px 18px 24px;
    display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
    gap: 13px; align-content: start; }
  .sv-wb-card { border: 1px solid rgba(255,255,255,0.09); border-radius: 9px; padding: 11px 12px;
    background: rgba(255,255,255,0.015); }
  .sv-wb-card.wide { grid-column: 1 / -1; }
  .sv-wb-card h3 { font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase;
    margin: 0 0 2px; font-weight: 600; }
  .sv-wb-card .sub { font-size: 10px; color: rgba(232,236,243,0.38); margin-bottom: 9px; line-height: 1.4; }
  .sv-wb-snd h3 { color: #ffb347; } .sv-wb-hap h3 { color: #7ad7ff; } .sv-wb-imp h3 { color: #ff8fb1; }

  .sv-wb-f { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
  .sv-wb-f label { font-size: 10px; color: rgba(232,236,243,0.52); width: 76px; flex-shrink: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-wb-f input[type=range] { flex: 1; min-width: 0; height: 14px; }
  .sv-wb-snd input[type=range] { accent-color: #ffb347; }
  .sv-wb-hap input[type=range] { accent-color: #7ad7ff; }
  .sv-wb-imp input[type=range] { accent-color: #ff8fb1; }
  .sv-wb-num { width: 56px; flex-shrink: 0; background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.13); border-radius: 5px; color: #e8ecf3;
    font: inherit; font-size: 10px; padding: 2px 5px; text-align: right; font-variant-numeric: tabular-nums; }
  .sv-wb-f.dead { opacity: 0.32; }
  .sv-wb-f.dead .sv-wb-num { text-decoration: line-through; }
  .sv-wb-btn { font-size: 10px; font-weight: 600; padding: 4px 9px; border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: #e8ecf3;
    cursor: pointer; font-family: inherit; }
  .sv-wb-btn:hover { border-color: #7ad7ff; color: #7ad7ff; }
  .sv-wb-sel { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
    border-radius: 5px; color: #e8ecf3; font: inherit; font-size: 10px; padding: 3px 6px; }
  .sv-wb-scope { margin-top: 8px; border: 1px solid rgba(255,179,71,0.35);
    background: rgba(255,179,71,0.06); border-radius: 7px; padding: 7px 9px;
    font-size: 10px; color: #ffc98a; line-height: 1.45; }
  .sv-wb-scope b { color: #ffe0b8; }
  .sv-wb-none { font-size: 10px; color: rgba(232,236,243,0.4); line-height: 1.5; margin-top: 4px; }

  .sv-wb-takes { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .sv-wb-take { display: flex; align-items: center; gap: 6px; font-size: 10px; }
  .sv-wb-take .fn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: rgba(232,236,243,0.62); font-family: ui-monospace, Menlo, monospace; font-size: 9.5px; }
  .sv-wb-take .sv-wb-btn { padding: 1px 6px; }
  .sv-wb-drop { margin-top: 8px; border: 1px dashed rgba(255,255,255,0.18); border-radius: 7px;
    padding: 8px; text-align: center; font-size: 10px; color: rgba(232,236,243,0.4); }
  .sv-wb-drop.over { border-color: #7ad7ff; color: #7ad7ff; background: rgba(122,215,255,0.08); }

  .sv-wb-tabs { display: grid; grid-template-columns: 1fr 1fr; flex-shrink: 0;
    border-bottom: 1px solid rgba(255,255,255,0.09); }
  .sv-wb-tab { padding: 9px 4px; font-size: 9.5px; font-weight: 600; text-align: center; cursor: pointer;
    color: rgba(232,236,243,0.5); letter-spacing: 0.08em; text-transform: uppercase;
    border-bottom: 2px solid transparent; }
  .sv-wb-tab.on { color: #7ad7ff; border-bottom-color: #7ad7ff; background: rgba(122,215,255,0.07); }
  .sv-wb-pane { display: none; flex: 1; min-height: 0; flex-direction: column; }
  .sv-wb-pane.on { display: flex; }

  .sv-wb-libhead { padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
  .sv-wb-pills { display: flex; gap: 5px; margin-top: 7px; }
  .sv-wb-pill { font-size: 9px; padding: 3px 8px; border-radius: 20px; cursor: pointer;
    border: 1px solid rgba(255,255,255,0.14); color: rgba(232,236,243,0.55); }
  .sv-wb-pill.on { border-color: #7ad7ff; color: #7ad7ff; background: rgba(122,215,255,0.1); }
  .sv-wb-pill.orphan.on { border-color: #ffb347; color: #ffb347; background: rgba(255,179,71,0.1); }
  .sv-wb-liblist { flex: 1; overflow-y: auto; }
  .sv-wb-lib { padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.045); }
  .sv-wb-lib:hover { background: rgba(255,255,255,0.035); }
  .sv-wb-lib.inset { background: rgba(122,215,255,0.07); }
  .sv-wb-lib .top { display: flex; align-items: center; gap: 6px; }
  .sv-wb-lib .fn { flex: 1; min-width: 0; font-family: ui-monospace, Menlo, monospace; font-size: 9.5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(232,236,243,0.8); }
  .sv-wb-lib .kb { font-size: 9px; color: rgba(232,236,243,0.3); flex-shrink: 0; }
  .sv-wb-lib .used { font-size: 9px; margin-top: 3px; color: rgba(232,236,243,0.4); line-height: 1.35; }
  .sv-wb-lib .used b { color: rgba(122,215,255,0.85); font-weight: 500; }
  .sv-wb-lib .used.none { color: #ffb347; }
  .sv-wb-lib .used.other { color: rgba(150,255,190,0.85); }
  .sv-wb-libfoot { border-top: 1px solid rgba(255,255,255,0.08); padding: 8px 12px;
    font-size: 9.5px; color: rgba(232,236,243,0.4); line-height: 1.5; flex-shrink: 0; }
  .sv-wb-libfoot b { color: #ffb347; font-weight: 600; }
  .sv-wb-danger { border-color: rgba(255,128,149,0.5); color: #ff8095;
    background: rgba(255,128,149,0.08); margin-top: 6px; width: 100%; }

  .sv-wb-stats { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
  .sv-wb-stat { display: flex; justify-content: space-between; font-size: 10px; margin-top: 4px;
    font-variant-numeric: tabular-nums; color: rgba(232,236,243,0.55); }
  .sv-wb-stat b { font-weight: 600; color: #e8ecf3; }
  .sv-wb-feed { flex: 1; overflow-y: auto; padding: 7px 12px 12px;
    font: 500 10.5px/1.55 ui-monospace, Menlo, monospace; }
  .sv-wb-fr { display: flex; gap: 6px; }
  .sv-wb-fr .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-wb-hint { position: fixed; right: 14px; bottom: 100px; z-index: 33; font-size: 10px;
    color: rgba(232,236,243,0.35); font-family: 'Inter', system-ui, sans-serif; pointer-events: none; }
  .sv-wb-hint.sv-wb-off { display: none; }
`;

const FEED_COLOR = {
  sample: 'rgba(122,215,255,0.95)', synth: 'rgba(232,236,243,0.78)',
  note: 'rgba(143,217,168,0.9)', gap: 'rgba(255,179,71,0.9)', far: 'rgba(255,179,71,0.9)',
  stolen: 'rgba(198,176,255,0.85)', voices: 'rgba(255,179,71,0.9)',
  muted: 'rgba(232,236,243,0.35)', off: 'rgba(232,236,243,0.35)',
  unknown: 'rgba(255,128,149,0.95)', missing: 'rgba(255,128,149,0.95)',
};

let panel = null;
let visible = false;
let current = 'kill';
let libFilter = 'all';
let library = [];        // { file, src, kb } straight off disk
let libraryError = '';
let feedRows = [];
const els = {};

// ---------------------------------------------------------------------------

const voiceOf = (event) => CONFIG.feedback[event]?.sfx ?? null;
const srcsOf = (def) => (Array.isArray(def?.srcs) && def.srcs.length
  ? def.srcs.filter(Boolean)
  : (def?.src ? [def.src] : []));

/** Every event that plays a given voice — the sharing this panel refuses to hide. */
function eventsUsingVoice(voice) {
  return Object.keys(CONFIG.feedback).filter((e) => CONFIG.feedback[e].sfx === voice);
}

/** Every voice that references a file. Recomputed live, so an assignment shows at once. */
function voicesUsingFile(src) {
  const out = [];
  for (const [id, def] of Object.entries(CONFIG.sfx)) if (srcsOf(def).includes(src)) out.push(id);
  return out;
}

/**
 * Who else claims this file, outside CONFIG.sfx entirely.
 *
 * The ambient bed holds eight of these and the music slots hold more, and
 * neither goes through a voice. Counting only voice references reports them as
 * unused — and "unused" here is a delete button, so getting this wrong is not
 * cosmetic.
 */
function nonVoiceUsersOfFile(src) {
  const out = [];
  if ((CONFIG.ambient?.srcs ?? []).includes(src)) out.push('ambient bed');
  if ((CONFIG.music?.defaultSrc ?? []).includes(src)) out.push('music slot');
  return out;
}

const changed = () => saveTuningToStorage();

// ---------------------------------------------------------------------------
// controls

function slider(host, label, { min = 0, max = 1, step = 0.01, dp = 2, get, set, dead = false, title = '' }) {
  const row = document.createElement('div');
  row.className = 'sv-wb-f' + (dead ? ' dead' : '');
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.title = dead ? 'Ignored — a loaded sample replaces the synth entirely' : (title || label);
  const input = document.createElement('input');
  input.type = 'range';
  input.autocomplete = 'off';
  input.min = min; input.max = max; input.step = step;
  input.value = get();
  input.disabled = dead;
  const num = document.createElement('input');
  num.className = 'sv-wb-num';
  num.autocomplete = 'off';
  num.value = Number(get()).toFixed(dp);
  const push = (v) => { set(Number(v)); changed(); };
  input.addEventListener('input', () => { num.value = Number(input.value).toFixed(dp); push(input.value); });
  // Typed entry as well as the track. A slider is for feel; a number is for
  // "the same as that other one", and half of tuning is the second thing.
  num.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, Number(num.value) || 0));
    num.value = v.toFixed(dp);
    input.value = v;
    push(v);
  });
  row.append(lab, input, num);
  host.appendChild(row);
  return row;
}

// Levels are stored linear and shown in dB, for the reason the old Sound tab
// gives: a linear track wastes almost all its travel, and several samples in
// the bank are authored 20dB below the rest.
function dbSlider(host, label, { get, set }) {
  const row = document.createElement('div');
  row.className = 'sv-wb-f';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.title = `${label} — in dB. 0 is unity; the stored value is a linear multiplier.`;
  const input = document.createElement('input');
  input.type = 'range';
  input.autocomplete = 'off';
  input.min = DB_FLOOR; input.max = 24; input.step = 0.5;
  const num = document.createElement('input');
  num.className = 'sv-wb-num';
  num.autocomplete = 'off';
  const show = () => {
    const g = get();
    const db = Math.min(24, gainToDb(g));
    input.value = db;
    num.value = g > 0 ? `${db >= 0 ? '+' : ''}${db.toFixed(1)}` : 'off';
    num.title = `x${Number(g).toFixed(3)}`;
  };
  show();
  input.addEventListener('input', () => { set(dbToGain(Number(input.value))); show(); changed(); });
  num.addEventListener('change', () => {
    const db = Number(String(num.value).replace('+', ''));
    if (Number.isFinite(db)) { set(dbToGain(Math.min(24, Math.max(DB_FLOOR, db)))); changed(); }
    show();
  });
  row.append(lab, input, num);
  host.appendChild(row);
}

function card(host, cls, title, sub) {
  const el = document.createElement('div');
  el.className = `sv-wb-card ${cls}`;
  el.innerHTML = `<h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}`;
  host.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// the rail

function railRow(id) {
  const def = CONFIG.feedback[id];
  const el = document.createElement('div');
  el.className = 'sv-wb-ev' + (id === current ? ' sv-wb-on-row' : '');
  const dots = document.createElement('div');
  dots.className = 'sv-wb-dots';
  const has = [!!def.sfx, !!def.haptic, !!(def.shake || def.glow || def.emit || def.ripple)];
  ['s', 'h', 'i'].forEach((k, i) => {
    const d = document.createElement('div');
    d.className = 'sv-wb-dot' + (has[i] ? ` ${k}` : '');
    dots.appendChild(d);
  });
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = id;
  el.append(dots, nm);
  el.addEventListener('click', () => { current = id; render(); });
  return el;
}

function renderRail() {
  const list = els.list;
  const filter = els.search.value.trim().toLowerCase();
  list.replaceChildren();

  const g = document.createElement('div');
  g.className = 'sv-wb-ev' + (current === '*global' ? ' sv-wb-on-row' : '');
  g.innerHTML = '<span class="nm" style="font-weight:600">⚙ Global shaping</span>';
  g.addEventListener('click', () => { current = '*global'; render(); });
  list.appendChild(g);

  const all = Object.keys(CONFIG.feedback);
  const placed = new Set(RAIL_SECTIONS.flatMap(([, ids]) => ids).filter((id) => CONFIG.feedback[id]));
  const groups = RAIL_SECTIONS
    .map(([t, ids]) => [t, ids.filter((id) => CONFIG.feedback[id])])
    .concat([['Everything else', all.filter((id) => !placed.has(id))]]);

  let shown = 0;
  for (const [title, ids] of groups) {
    const hits = ids.filter((id) => id.toLowerCase().includes(filter));
    if (!hits.length) continue;
    const h = document.createElement('div');
    h.className = 'sv-wb-sec';
    h.textContent = title;
    list.appendChild(h);
    for (const id of hits) { list.appendChild(railRow(id)); shown++; }
  }

  els.meta.textContent = `${shown} of ${all.length} · `
    + `${all.filter((e) => CONFIG.feedback[e].sfx).length} with sound · `
    + `${all.filter((e) => CONFIG.feedback[e].haptic).length} with rumble`;
}

// ---------------------------------------------------------------------------
// the detail pane

function render() {
  if (!panel) return;
  renderRail();
  // The library is part of the detail view, not a fixed sidebar: its + buttons
  // assign to THIS event's voice, and its rows say which voices use each file.
  // Leaving it out of the re-render was not a stale-label bug, it was a wrong-
  // target bug — the buttons stayed bound to whichever event was selected when
  // the panel opened, so a sample you added to `kill` landed silently on
  // whatever had been showing an hour ago.
  renderLibrary();
  if (current === '*global') return renderGlobal();

  const event = current;
  const def = CONFIG.feedback[event];
  if (!def) { current = 'kill'; return render(); }
  const voice = def.sfx;
  const vdef = voice ? CONFIG.sfx[voice] : null;
  const srcs = srcsOf(vdef);
  const sampled = srcs.length > 0;
  // A loaded sample replaces the synth outright (see playSfx), so a voice that
  // has both is showing synth controls that do nothing at all. 24 of 62 voices
  // are in that state.
  const deadSynth = sampled && !!vdef?.type;

  els.name.textContent = event;
  els.via.textContent = `CONFIG.feedback.${event}${voice ? `  →  CONFIG.sfx.${voice}` : ''}`;

  els.chips.replaceChildren();
  const chip = (text, cls = '') => {
    const c = document.createElement('span');
    c.className = `sv-wb-chip ${cls}`;
    c.textContent = text;
    els.chips.appendChild(c);
  };
  if (!voice) chip('silent — no voice', 'warn');
  else chip(sampled ? `${srcs.length} take${srcs.length > 1 ? 's' : ''}` : `synth · ${vdef?.type ?? '?'}`);
  if (deadSynth) chip(`sample wins — ${vdef.type} params are dead`, 'bad');
  const shared = voice ? eventsUsingVoice(voice).filter((e) => e !== event) : [];
  if (shared.length) chip(`voice shared with ${shared.join(', ')}`, 'link');
  if (!def.haptic) chip('no rumble authored', 'warn');
  if (def.sfxMinGap) chip(`throttled — ${(def.sfxMinGap * 1000).toFixed(0)} ms min gap`);

  const cols = els.cols;
  cols.replaceChildren();

  // --- SOUND ---------------------------------------------------------------
  const snd = card(cols, 'sv-wb-snd', 'Sound', voice
    ? (sampled
      ? 'Sampled. playSfx picks a different take each time and never repeats one twice running.'
      : 'Synthesised — this voice has no files, so the fields below are the whole sound.')
    : 'This event makes no sound at all.');

  const pick = document.createElement('div');
  pick.className = 'sv-wb-f';
  const pickLab = document.createElement('label');
  pickLab.textContent = 'plays voice';
  const pickSel = document.createElement('select');
  pickSel.className = 'sv-wb-sel';
  pickSel.autocomplete = 'off';
  pickSel.style.flex = '1';
  for (const id of ['— silent —', ...Object.keys(CONFIG.sfx).sort()]) {
    const o = document.createElement('option');
    o.value = id; o.textContent = id;
    pickSel.appendChild(o);
  }
  pickSel.value = voice ?? '— silent —';
  pickSel.addEventListener('change', () => {
    def.sfx = pickSel.value === '— silent —' ? null : pickSel.value;
    changed();
    render();
  });
  const fork = document.createElement('button');
  fork.className = 'sv-wb-btn';
  fork.textContent = 'Fork';
  fork.title = 'Copy this voice to a new entry named after the event, so changes stop being heard elsewhere';
  fork.addEventListener('click', () => {
    if (!vdef) return;
    // Named after the EVENT, because the reason to fork is always "this moment
    // should stop sounding like that one".
    let name = event;
    while (CONFIG.sfx[name]) name += '2';
    CONFIG.sfx[name] = JSON.parse(JSON.stringify(vdef));
    def.sfx = name;
    changed();
    render();
  });
  const test = document.createElement('button');
  test.className = 'sv-wb-btn';
  test.textContent = '▶';
  test.title = 'Play this voice alone';
  test.addEventListener('click', () => { unlockAudio(); if (voice) playSfx(voice, 1); });
  pick.append(pickLab, pickSel, fork, test);
  snd.appendChild(pick);

  if (shared.length) {
    const warn = document.createElement('div');
    warn.className = 'sv-wb-scope';
    warn.innerHTML = `Takes and levels here belong to the voice <b>${voice}</b>, not to this event — `
      + `<b>${shared.join(', ')}</b> ${shared.length > 1 ? 'hear' : 'hears'} every change too. Fork to break the tie.`;
    snd.appendChild(warn);
  }

  if (vdef) {
    dbSlider(snd, 'gain', { get: () => vdef.gain ?? 0.2, set: (v) => { vdef.gain = v; } });
    slider(snd, 'pitch var', { max: 0.5, get: () => vdef.pitchVary ?? 0, set: (v) => { vdef.pitchVary = v; } });
    if (vdef.filter != null) {
      slider(snd, 'filter', { min: 80, max: 6000, step: 20, dp: 0, get: () => vdef.filter, set: (v) => { vdef.filter = v; } });
      slider(snd, 'filter var', { max: 0.6, get: () => vdef.filterVary ?? 0, set: (v) => { vdef.filterVary = v; } });
    }
    if (vdef.freq) {
      slider(snd, 'freq lo', { min: 20, max: 2000, step: 5, dp: 0, dead: deadSynth, get: () => vdef.freq[0], set: (v) => { vdef.freq = [v, vdef.freq[1]]; } });
      slider(snd, 'freq hi', { min: 20, max: 2000, step: 5, dp: 0, dead: deadSynth, get: () => vdef.freq[1], set: (v) => { vdef.freq = [vdef.freq[0], v]; } });
    }
    if (vdef.decay != null) slider(snd, 'decay', { max: 1.5, dead: deadSynth, get: () => vdef.decay, set: (v) => { vdef.decay = v; } });
    if (vdef.noise != null) slider(snd, 'noise mix', { dead: deadSynth, get: () => vdef.noise, set: (v) => { vdef.noise = v; } });
    if (vdef.detune != null) slider(snd, 'detune', { max: 80, step: 1, dp: 0, dead: deadSynth, get: () => vdef.detune, set: (v) => { vdef.detune = v; } });

    const takes = document.createElement('div');
    takes.className = 'sv-wb-takes';
    srcs.forEach((src) => {
      const row = document.createElement('div');
      row.className = 'sv-wb-take';
      const fn = document.createElement('span');
      fn.className = 'fn';
      fn.textContent = src.split('/').pop();
      fn.title = src;
      const play = document.createElement('button');
      play.className = 'sv-wb-btn';
      play.textContent = '▶';
      play.title = 'Play just this take';
      play.addEventListener('click', () => auditionFile(src, vdef.gain ?? 0.3));
      const del = document.createElement('button');
      del.className = 'sv-wb-btn';
      del.textContent = '×';
      del.title = 'Take this file out of the set — the file stays in the library';
      del.addEventListener('click', async () => {
        vdef.srcs = srcs.filter((s) => s !== src);
        vdef.src = null;
        changed();
        await reloadSample(voice);
        render();
      });
      row.append(fn, play, del);
      takes.appendChild(row);
    });
    snd.appendChild(takes);

    // Adding a take, all three ways it can happen. Drag-and-drop alone was not
    // enough: it is invisible unless you already know it is there, and it
    // cannot be reached from a file dialog at all.
    const addFiles = async (files) => {
      drop.textContent = 'uploading…';
      for (const file of files) {
        const src = await uploadAsset('sfx', file);
        if (!src) { drop.textContent = `${file.name} — no dev server, not saved`; continue; }
        if (!Array.isArray(vdef.srcs)) vdef.srcs = vdef.src ? [vdef.src] : [];
        if (!vdef.srcs.includes(src)) vdef.srcs.push(src);
        vdef.src = null;
      }
      changed();
      await reloadSample(voice);
      await loadLibrary();
      render();
    };

    const pickRow = document.createElement('div');
    pickRow.className = 'sv-wb-f';
    const pickLabel = document.createElement('label');
    pickLabel.textContent = 'add takes';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      if (files.length) await addFiles(files);
    });
    const upBtn = document.createElement('button');
    upBtn.className = 'sv-wb-btn';
    upBtn.textContent = 'Upload…';
    upBtn.title = 'Choose audio files — saved into public/sfx and added to this voice';
    upBtn.addEventListener('click', () => fileInput.click());
    const libHint = document.createElement('span');
    libHint.style.cssText = 'font-size:10px;color:rgba(232,236,243,0.38)';
    libHint.textContent = 'or + one from the Library →';
    pickRow.append(pickLabel, upBtn, fileInput, libHint);
    snd.appendChild(pickRow);

    const drop = document.createElement('div');
    drop.className = 'sv-wb-drop';
    drop.textContent = sampled
      ? '…or drop files here to add takes'
      : '…or drop files here to replace the synth';
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      await addFiles([...(e.dataTransfer?.files ?? [])]);
    });
    snd.appendChild(drop);
  }

  // --- RUMBLE --------------------------------------------------------------
  const pulses = describeHaptic(def.haptic);
  const hap = card(cols, 'sv-wb-hap', 'Rumble', pulses.length
    ? `Envelope is what the mixer sums — flat while it holds, then the ${CONFIG.haptics.mixing?.release ?? 70} ms release tail that lets repeats fuse into a bed.`
    : 'Nothing authored. Moving anything here seeds a pattern.');

  if (pulses.length) hap.appendChild(pulseSvg(pulses));

  // Writing any field converts the event to explicit pulses, carrying the
  // resolved values across — so a legacy millisecond pattern keeps its exact
  // feel at the moment you start editing it instead of snapping to a default.
  const toExplicit = () => {
    const p = describeHaptic(def.haptic);
    if (!p.length) return [{ duration: 30, magnitude: 0.5, delay: 0 }];
    // `gap`, never `delay`: delay is absolute, and writing it back re-adds the
    // previous pulse's duration on every edit, walking the tail later each time.
    return p.map((q) => ({ duration: q.duration, magnitude: q.resolved, delay: q.gap }));
  };
  const writePulse = (i, field, v) => {
    const next = toExplicit();
    while (next.length <= i) next.push({ duration: 0, magnitude: 0.3, delay: 0 });
    next[i][field] = v;
    if (i === 1 && field === 'duration' && v <= 0) next.length = 1;
    def.haptic = next;
    changed();
  };
  const p0 = () => describeHaptic(def.haptic)[0] ?? { duration: 30, resolved: 0.5 };
  const p1 = () => describeHaptic(def.haptic)[1] ?? { duration: 0, resolved: 0 };

  slider(hap, 'duration', { max: 200, step: 1, dp: 0, get: () => p0().duration, set: (v) => writePulse(0, 'duration', v) });
  slider(hap, 'strength', { get: () => p0().resolved, set: (v) => writePulse(0, 'magnitude', v) });
  slider(hap, 'tail ms', { max: 200, step: 1, dp: 0, get: () => p1().duration, set: (v) => writePulse(1, 'duration', v) });
  slider(hap, 'tail str', { get: () => p1().resolved, set: (v) => writePulse(1, 'magnitude', v) });

  const hapRow = document.createElement('div');
  hapRow.className = 'sv-wb-f';
  const hapLab = document.createElement('label');
  hapLab.textContent = 'enabled';
  const hapBox = document.createElement('input');
  hapBox.type = 'checkbox';
  hapBox.autocomplete = 'off';
  hapBox.checked = pulses.length > 0;
  hapBox.addEventListener('change', () => {
    def.haptic = hapBox.checked ? [{ duration: 30, magnitude: 0.5, delay: 0 }] : null;
    changed();
    render();
  });
  const hapTest = document.createElement('button');
  hapTest.className = 'sv-wb-btn';
  hapTest.textContent = '▶ feel it';
  hapTest.addEventListener('click', () => previewHaptic(def.haptic));
  hapRow.append(hapLab, hapBox, hapTest);
  hap.appendChild(hapRow);

  // --- IMPACT --------------------------------------------------------------
  const imp = card(cols, 'sv-wb-imp wide', 'Impact',
    'The rest of what feedback() fires. Only 7 of the 77 events expose any of this today, scattered through the ` tuner by topic.');
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:0 20px';
  const L = document.createElement('div');
  const R = document.createElement('div');
  grid.append(L, R);
  slider(L, 'shake', { max: 2, get: () => def.shake ?? 0, set: (v) => { def.shake = v; } });
  slider(L, 'hit-stop', { max: 0.2, step: 0.005, dp: 3, get: () => def.hitstop ?? 0, set: (v) => { def.hitstop = v; } });
  slider(L, 'glow', { max: 2, step: 0.05, get: () => def.glow ?? 0, set: (v) => { def.glow = v; } });
  slider(R, 'ripple hit', { max: 10, step: 0.1, dp: 1, get: () => def.ripple?.strength ?? 0, set: (v) => { (def.ripple ??= { strength: 0, radius: 4 }).strength = v; } });
  slider(R, 'ripple size', { max: 30, step: 1, dp: 0, get: () => def.ripple?.radius ?? 0, set: (v) => { (def.ripple ??= { strength: 0, radius: 4 }).radius = v; } });
  slider(R, 'min gap', { max: 0.5, get: () => def.sfxMinGap ?? 0, set: (v) => { def.sfxMinGap = v; } });
  imp.appendChild(grid);

  const emRow = document.createElement('div');
  emRow.className = 'sv-wb-f';
  const emLab = document.createElement('label');
  emLab.textContent = 'particles';
  const emSel = document.createElement('select');
  emSel.className = 'sv-wb-sel';
  emSel.autocomplete = 'off';
  emSel.style.flex = '1';
  for (const id of ['— none —', ...Object.keys(CONFIG.emitters).sort()]) {
    const o = document.createElement('option');
    o.value = id; o.textContent = id;
    emSel.appendChild(o);
  }
  emSel.value = def.emit ?? '— none —';
  emSel.addEventListener('change', () => {
    def.emit = emSel.value === '— none —' ? null : emSel.value;
    changed();
    render();
  });
  const emTest = document.createElement('button');
  emTest.className = 'sv-wb-btn';
  emTest.textContent = '▶ burst';
  emTest.title = 'Throw this burst on the seal';
  emTest.addEventListener('click', () => { if (def.emit) emit(def.emit, 0, 0); });
  emRow.append(emLab, emSel, emTest);
  imp.appendChild(emRow);

  const fireRow = document.createElement('div');
  fireRow.className = 'sv-wb-f';
  const fireLab = document.createElement('label');
  fireLab.textContent = 'all together';
  const fireBtn = document.createElement('button');
  fireBtn.className = 'sv-wb-btn';
  fireBtn.textContent = '▶ Fire the whole event';
  fireBtn.title = 'The real feedback() — sound, rumble, particles, shake, hit-stop and ripple at once. F closes this panel; the stage bar keeps firing.';
  fireBtn.addEventListener('click', () => {
    unlockAudio();
    stageState.event = event;
    feedback(event, { x: 0, y: 0, scale: stageState.scale });
  });
  fireRow.append(fireLab, fireBtn);
  imp.appendChild(fireRow);

  // --- BURST ---------------------------------------------------------------
  const edef = def.emit ? CONFIG.emitters[def.emit] : null;
  if (edef) {
    const par = card(cols, 'sv-wb-imp wide', `Burst · ${def.emit}`,
      'What the particles do. The six under the divider have no control anywhere else in the game.');
    const users = Object.keys(CONFIG.feedback).filter((e) => CONFIG.feedback[e].emit === def.emit && e !== event);
    if (users.length) {
      const w = document.createElement('div');
      w.className = 'sv-wb-scope';
      w.innerHTML = `Shared burst — <b>${users.join(', ')}</b> throw the same particles. Pick another emitter above to give this event its own.`;
      par.appendChild(w);
    }
    const g2 = document.createElement('div');
    g2.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:0 20px';
    const A = document.createElement('div');
    const B = document.createElement('div');
    g2.append(A, B);
    slider(A, 'count', { max: 200, step: 1, dp: 0, get: () => edef.count, set: (v) => { edef.count = Math.round(v); } });
    pairSlider(A, 'size', edef.size, 3, 0.01, 2);
    pairSlider(A, 'life', edef.life, 3, 0.01, 2);
    pairSlider(B, 'speed', edef.speed, 40, 0.5, 1);
    slider(B, 'cone', { max: 6.3, step: 0.05, get: () => edef.cone ?? 0, set: (v) => { edef.cone = v; } });
    slider(B, 'glow', { max: 4, step: 0.1, dp: 1, get: () => edef.glow ?? 0, set: (v) => { edef.glow = v; } });
    par.appendChild(g2);
    const div = document.createElement('div');
    div.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08); margin:8px 0 2px';
    par.appendChild(div);
    const g3 = document.createElement('div');
    g3.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:0 20px';
    const C = document.createElement('div');
    const D = document.createElement('div');
    g3.append(C, D);
    slider(C, 'drag', { max: 8, step: 0.1, dp: 1, get: () => edef.drag ?? 0, set: (v) => { edef.drag = v; } });
    slider(C, 'inherit', { step: 0.05, get: () => edef.inherit ?? 0, set: (v) => { edef.inherit = v; } });
    slider(D, 'gravity', { min: -6, max: 6, step: 0.1, dp: 1, get: () => (edef.gravity ?? [0, 0])[1], set: (v) => { edef.gravity = [(edef.gravity ?? [0, 0])[0], v]; } });
    par.appendChild(g3);

    // Reach under linear drag — the same closed form particles.js integrates.
    // speed x life is the no-drag answer and is wildly wrong for anything that
    // slows: bigExplosion reads 73 units that way and travels 18.
    const k = Math.max(0.05, edef.drag ?? 0.05);
    const reach = edef.speed[1] * (1 - Math.exp(-k * edef.life[1])) / k;
    const note = document.createElement('div');
    note.className = 'sv-wb-none';
    note.textContent = `Reaches about ${reach.toFixed(1)} world units. The seal is 4.2 across.`;
    par.appendChild(note);

    const colours = document.createElement('div');
    colours.className = 'sv-wb-f';
    colours.innerHTML = '<label>colours</label>';
    (edef.colors ?? []).forEach((c, i) => {
      const sw = document.createElement('input');
      sw.type = 'color';
      sw.autocomplete = 'off';
      sw.value = `#${c.toString(16).padStart(6, '0')}`;
      sw.style.cssText = 'width:30px;height:22px;padding:0;border:1px solid rgba(255,255,255,0.2);border-radius:5px;background:none;cursor:pointer';
      sw.addEventListener('input', () => { edef.colors[i] = parseInt(sw.value.slice(1), 16); changed(); });
      colours.appendChild(sw);
    });
    par.appendChild(colours);
  }
}

function pairSlider(host, label, pair, max, step, dp) {
  const row = document.createElement('div');
  row.className = 'sv-wb-f';
  const lab = document.createElement('label');
  lab.textContent = label;
  const lo = document.createElement('input');
  const hi = document.createElement('input');
  const num = document.createElement('input');
  num.className = 'sv-wb-num';
  num.readOnly = true;
  const paint = () => { num.value = `${Number(pair[0]).toFixed(dp)}–${Number(pair[1]).toFixed(dp)}`; };
  for (const [input, idx] of [[lo, 0], [hi, 1]]) {
    input.type = 'range';
    input.autocomplete = 'off';
    input.min = 0; input.max = max; input.step = step;
    input.value = pair[idx];
    input.addEventListener('input', () => { pair[idx] = Number(input.value); paint(); changed(); });
  }
  paint();
  row.append(lab, lo, hi, num);
  host.appendChild(row);
}

function pulseSvg(pulses) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 46');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'width:100%;height:46px;margin:2px 0 4px';
  const base = document.createElementNS(ns, 'line');
  base.setAttribute('x1', 0); base.setAttribute('x2', 300);
  base.setAttribute('y1', 42); base.setAttribute('y2', 42);
  base.setAttribute('stroke', 'rgba(255,255,255,0.14)');
  svg.appendChild(base);
  const release = CONFIG.haptics.mixing?.release ?? 70;
  const span = Math.max(120, pulses.reduce((m, p) => Math.max(m, p.delay + p.duration + release), 0));
  for (const p of pulses) {
    const x = (p.delay / span) * 300;
    const w = (p.duration / span) * 300;
    const rel = (release / span) * 300;
    const y = 42 - p.resolved * 34;
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', `${x},42 ${x},${y} ${x + w},${y} ${x + w + rel},42`);
    poly.setAttribute('fill', 'rgba(122,215,255,0.28)');
    poly.setAttribute('stroke', '#7ad7ff');
    svg.appendChild(poly);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// global shaping

function renderGlobal() {
  els.name.textContent = 'Global shaping';
  els.via.textContent = 'scales all 77 events';
  els.chips.replaceChildren();
  const cols = els.cols;
  cols.replaceChildren();

  const fx = CONFIG.fx;
  const cam = card(cols, 'sv-wb-imp', 'Camera & time',
    'How every shake decays, and how often hit-stop is allowed to land at all.');
  slider(cam, 'max shake', { max: 1, get: () => fx.maxShake, set: (v) => { fx.maxShake = v; } });
  slider(cam, 'shake decay', { max: 0.005, step: 0.0001, dp: 4, get: () => fx.shakeDecay, set: (v) => { fx.shakeDecay = v; } });
  slider(cam, 'hitstop scale', { max: 1, get: () => fx.hitstopScale, set: (v) => { fx.hitstopScale = v; } });
  slider(cam, 'hitstop gap', { max: 2, step: 0.05, get: () => fx.hitstopCooldown, set: (v) => { fx.hitstopCooldown = v; } });
  const camNote = document.createElement('div');
  camNote.className = 'sv-wb-none';
  camNote.textContent = `The gap is why most events' hit-stop never lands: one every ${fx.hitstopCooldown}s, whoever asks first.`;
  cam.appendChild(camNote);

  const h = CONFIG.haptics;
  const hap = card(cols, 'sv-wb-hap', 'Rumble mix',
    'How overlapping rumbles sum, and the release tail that decides whether repeats fuse into a bed.');
  slider(hap, 'strength', { max: 2, step: 0.05, get: () => h.intensity ?? 1, set: (v) => { h.intensity = v; } });
  slider(hap, 'low motor', { step: 0.05, get: () => h.strongRatio ?? 1, set: (v) => { h.strongRatio = v; } });
  slider(hap, 'high motor', { step: 0.05, get: () => h.weakRatio ?? 0.45, set: (v) => { h.weakRatio = v; } });
  slider(hap, 'release', { max: 400, step: 5, dp: 0, get: () => (h.mixing ??= {}).release ?? 70, set: (v) => { (h.mixing ??= {}).release = v; } });
  slider(hap, 'auto full at', { min: 5, max: 150, step: 5, dp: 0, get: () => h.fullAtMs ?? 45, set: (v) => { h.fullAtMs = v; } });
  slider(hap, 'auto curve', { min: 0.2, max: 2, step: 0.05, get: () => h.curve ?? 0.6, set: (v) => { h.curve = v; } });

  const bus = (CONFIG.audio.bus ??= {});
  const au = card(cols, 'sv-wb-snd', 'Sound bus',
    'Filter, reverb and the ceiling every voice runs through. Full controls stay on the T panel.');
  slider(au, 'cutoff', { min: 20, max: 20000, step: 10, dp: 0, get: () => bus.filterHz ?? 20000, set: (v) => { bus.filterHz = v; } });
  slider(au, 'reverb mix', { get: () => bus.reverbMix ?? 0, set: (v) => { bus.reverbMix = v; } });
  slider(au, 'ceiling', { min: 0.1, get: () => (bus.comp ??= {}).ceiling ?? 0.95, set: (v) => { (bus.comp ??= {}).ceiling = v; } });

  const rep = (CONFIG.audio.repetition ??= {});
  const cr = card(cols, 'sv-wb-snd', 'Crowding',
    'Each rapid repeat of one sound plays quieter than the last. This is what keeps a wall of hits reading as a wall rather than as static.');
  slider(cr, 'recovery', { min: 0.05, max: 2, step: 0.05, get: () => rep.recovery ?? 0.5, set: (v) => { rep.recovery = v; } });
  slider(cr, 'strength', { max: 2, step: 0.05, get: () => rep.strength ?? 0.35, set: (v) => { rep.strength = v; } });
  slider(cr, 'gap jitter', { max: 0.9, get: () => CONFIG.audio.sfxGapJitter ?? 0.35, set: (v) => { CONFIG.audio.sfxGapJitter = v; } });
}

// ---------------------------------------------------------------------------
// the library

async function loadLibrary() {
  try {
    const res = await fetch('/__sfx-list');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    library = data.files ?? [];
    libraryError = '';
  } catch (err) {
    // Expected in a production build, which has no dev server to ask.
    library = [];
    libraryError = 'No dev server — the file list is only available under npm run dev.';
  }
}

async function auditionFile(src, gain) {
  unlockAudio();
  try {
    const ctx = getAudioContext();
    const buf = await ctx.decodeAudioData(await (await fetch(src)).arrayBuffer());
    const node = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = gain ?? 0.3;
    node.buffer = buf;
    node.connect(g).connect(ctx.destination);
    node.start();
  } catch (err) {
    console.warn(`[workbench] could not audition ${src} —`, err?.message ?? err);
  }
}

function renderLibrary() {
  const list = els.liblist;
  if (!list) return;
  const q = els.libsearch.value.trim().toLowerCase();
  const voice = voiceOf(current);
  const vdef = voice ? CONFIG.sfx[voice] : null;
  const mine = new Set(srcsOf(vdef));
  list.replaceChildren();

  let shown = 0;
  for (const f of library) {
    const voices = voicesUsingFile(f.src);
    const others = nonVoiceUsersOfFile(f.src);
    const unused = !voices.length && !others.length;
    if (libFilter === 'unused' && !unused) continue;
    if (libFilter === 'here' && !mine.has(f.src)) continue;
    if (q && !f.file.toLowerCase().includes(q)) continue;
    shown++;

    const row = document.createElement('div');
    row.className = 'sv-wb-lib' + (mine.has(f.src) ? ' inset' : '');
    const top = document.createElement('div');
    top.className = 'top';
    const fn = document.createElement('span');
    fn.className = 'fn';
    fn.textContent = f.file;
    fn.title = f.src;
    const kb = document.createElement('span');
    kb.className = 'kb';
    kb.textContent = `${f.kb}k`;
    const play = document.createElement('button');
    play.className = 'sv-wb-btn';
    play.textContent = '▶';
    play.addEventListener('click', () => auditionFile(f.src, vdef?.gain ?? 0.3));
    const add = document.createElement('button');
    add.className = 'sv-wb-btn';
    add.textContent = mine.has(f.src) ? '−' : '+';
    add.disabled = !vdef;
    add.title = !vdef ? 'This event has no voice to add a take to'
      : mine.has(f.src) ? `Remove this take from ${voice}` : `Add as a take of ${voice}`;
    add.addEventListener('click', async () => {
      if (!vdef) return;
      const srcs = srcsOf(vdef);
      // Deduped on the way in. `mine` is a snapshot taken when this row was
      // built, so two clicks landing before the re-render both read "not in
      // the set" and both append — which is how one file ended up in a voice
      // twice, doubling its odds in pickSample for no visible reason.
      vdef.srcs = srcs.includes(f.src)
        ? srcs.filter((s) => s !== f.src)
        : [...srcs, f.src];
      vdef.src = null;
      changed();
      await reloadSample(voice);
      render();
    });
    top.append(fn, kb, play, add);
    row.appendChild(top);

    const used = document.createElement('div');
    if (unused) { used.className = 'used none'; used.textContent = 'unused — ships, plays never'; }
    else if (others.length && !voices.length) { used.className = 'used other'; used.textContent = others.join(', '); }
    else {
      used.className = 'used';
      used.innerHTML = voices.map((v) => `<b>${v}</b>`).join(', ')
        + (others.length ? ` · ${others.join(', ')}` : '');
    }
    row.appendChild(used);
    list.appendChild(row);
  }

  const orphans = library.filter((f) => !voicesUsingFile(f.src).length && !nonVoiceUsersOfFile(f.src).length);
  const kb = orphans.reduce((n, f) => n + f.kb, 0);
  const foot = els.libfoot;
  foot.replaceChildren();
  const line = document.createElement('div');
  line.innerHTML = libraryError
    ? libraryError
    : `${shown} of ${library.length} files · <b>${orphans.length} unused, ${kb} kb</b> shipping for nothing.`;
  foot.appendChild(line);
  els.pillUnused.textContent = `Unused ${orphans.length}`;
  if (!orphans.length || libraryError) return;

  const del = document.createElement('button');
  del.className = 'sv-wb-btn sv-wb-danger';
  del.textContent = `Delete ${orphans.length} unused (${kb} kb)`;
  del.addEventListener('click', () => {
    // Two steps, and the confirm NAMES them. A numbered take reading as an
    // orphan is far more likely to be a set that lost a member than junk.
    del.remove();
    const box = document.createElement('div');
    box.className = 'sv-wb-scope';
    box.innerHTML = `<b>Delete these ${orphans.length} files from public/sfx?</b> This removes them from disk and cannot be undone.`
      + `<div style="max-height:110px;overflow-y:auto;margin:6px 0;font-family:ui-monospace,Menlo,monospace;font-size:9px">`
      + orphans.map((f) => f.file).join('<br>') + '</div>';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px';
    const yes = document.createElement('button');
    yes.className = 'sv-wb-btn sv-wb-danger';
    yes.style.marginTop = '0';
    yes.textContent = 'Delete';
    yes.addEventListener('click', async () => {
      yes.textContent = 'deleting…';
      try {
        // Recomputed HERE rather than trusting the captured list — an
        // assignment made while the confirm was open must not be deleted.
        const still = library
          .filter((f) => !voicesUsingFile(f.src).length && !nonVoiceUsersOfFile(f.src).length)
          .map((f) => f.file);
        await fetch('/__sfx-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: still }),
        });
      } catch (err) {
        console.warn('[workbench] delete failed —', err?.message ?? err);
      }
      await loadLibrary();
      renderLibrary();
    });
    const no = document.createElement('button');
    no.className = 'sv-wb-btn';
    no.style.marginTop = '0';
    no.textContent = 'Cancel';
    no.addEventListener('click', () => renderLibrary());
    row.append(yes, no);
    box.appendChild(row);
    foot.appendChild(box);
  });
  foot.appendChild(del);
}

// ---------------------------------------------------------------------------
// the live feed — the same watchSfx tap the 0 overlay uses, docked beside the
// row being edited so a burst and its drops are readable in one place.

function noteFeed(name, outcome, detail) {
  const key = `${name}|${outcome}`;
  const found = feedRows.find((r) => r.key === key);
  if (found) { found.count++; found.at = performance.now(); found.detail = detail ?? found.detail; }
  else {
    feedRows.unshift({ key, name, outcome, detail, count: 1, at: performance.now() });
    if (feedRows.length > 16) feedRows.length = 16;
  }
}

function renderFeed() {
  if (!visible || !els.feed) return;
  const load = sfxVoiceLoad();
  els.statVoices.textContent = `${load.active} / ${load.cap}`;
  const red = busReduction();
  els.statBus.textContent = red < -0.1 ? `${red.toFixed(1)} dB` : 'idle';
  els.statMuted.textContent = isMuted() ? 'MUTED' : 'live';

  const now = performance.now();
  feedRows = feedRows.filter((r) => now - r.at < 2600);
  els.feed.replaceChildren();
  if (!feedRows.length) {
    const idle = document.createElement('div');
    idle.style.color = 'rgba(232,236,243,0.3)';
    idle.textContent = 'listening…';
    els.feed.appendChild(idle);
    return;
  }
  for (const r of feedRows) {
    const line = document.createElement('div');
    line.className = 'sv-wb-fr';
    line.style.color = FEED_COLOR[r.outcome] ?? FEED_COLOR.synth;
    line.style.opacity = String(Math.max(0.3, 1 - ((now - r.at) / 2600) * 0.7));
    line.innerHTML = `<span class="n">${r.name}</span><span>${r.outcome}${r.count > 1 ? ` x${r.count}` : ''}</span>`;
    els.feed.appendChild(line);
  }
}

// ---------------------------------------------------------------------------

export function initWorkbench() {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  panel = document.createElement('div');
  panel.className = 'sv-wb';

  // rail
  const rail = document.createElement('div');
  rail.className = 'sv-wb-rail';
  const railhead = document.createElement('div');
  railhead.className = 'sv-wb-railhead';
  railhead.innerHTML = '<h2>Feel</h2>';
  els.search = document.createElement('input');
  els.search.className = 'sv-wb-search';
  els.search.autocomplete = 'off';
  els.search.placeholder = 'filter events…';
  els.search.addEventListener('input', renderRail);
  els.meta = document.createElement('div');
  els.meta.className = 'sv-wb-meta';
  railhead.append(els.search, els.meta);
  els.list = document.createElement('div');
  rail.append(railhead, els.list);

  // main
  const main = document.createElement('div');
  main.className = 'sv-wb-main';
  const head = document.createElement('div');
  head.className = 'sv-wb-head';
  const title = document.createElement('div');
  title.className = 'sv-wb-title';
  els.name = document.createElement('h1');
  els.via = document.createElement('span');
  els.via.className = 'sv-wb-via';
  title.append(els.name, els.via);
  els.chips = document.createElement('div');
  els.chips.className = 'sv-wb-chips';
  head.append(title, els.chips);
  els.cols = document.createElement('div');
  els.cols.className = 'sv-wb-cols';
  main.append(head, els.cols);

  // dock
  const dock = document.createElement('div');
  dock.className = 'sv-wb-dock';
  const tabs = document.createElement('div');
  tabs.className = 'sv-wb-tabs';
  const paneLib = document.createElement('div');
  paneLib.className = 'sv-wb-pane on';
  const paneLive = document.createElement('div');
  paneLive.className = 'sv-wb-pane';
  for (const [key, label, pane] of [['lib', 'Library', paneLib], ['live', 'Live', paneLive]]) {
    const tab = document.createElement('div');
    tab.className = 'sv-wb-tab' + (key === 'lib' ? ' on' : '');
    tab.textContent = label;
    tab.addEventListener('click', () => {
      for (const t of tabs.children) t.classList.toggle('on', t === tab);
      paneLib.classList.toggle('on', pane === paneLib);
      paneLive.classList.toggle('on', pane === paneLive);
    });
    tabs.appendChild(tab);
  }

  const libhead = document.createElement('div');
  libhead.className = 'sv-wb-libhead';
  els.libsearch = document.createElement('input');
  els.libsearch.className = 'sv-wb-search';
  els.libsearch.autocomplete = 'off';
  els.libsearch.style.marginTop = '0';
  els.libsearch.placeholder = 'filter files…';
  els.libsearch.addEventListener('input', renderLibrary);
  const pills = document.createElement('div');
  pills.className = 'sv-wb-pills';
  const mkPill = (key, text, cls = '') => {
    const p = document.createElement('span');
    p.className = `sv-wb-pill ${cls}` + (libFilter === key ? ' on' : '');
    p.textContent = text;
    p.addEventListener('click', () => {
      libFilter = key;
      for (const x of pills.children) x.classList.toggle('on', x === p);
      renderLibrary();
    });
    pills.appendChild(p);
    return p;
  };
  mkPill('all', 'All');
  mkPill('here', 'In this event');
  els.pillUnused = mkPill('unused', 'Unused', 'orphan');
  libhead.append(els.libsearch, pills);
  els.liblist = document.createElement('div');
  els.liblist.className = 'sv-wb-liblist';
  els.libfoot = document.createElement('div');
  els.libfoot.className = 'sv-wb-libfoot';
  paneLib.append(libhead, els.liblist, els.libfoot);

  const stats = document.createElement('div');
  stats.className = 'sv-wb-stats';
  const mkStat = (label) => {
    const row = document.createElement('div');
    row.className = 'sv-wb-stat';
    const b = document.createElement('b');
    row.innerHTML = `<span>${label}</span>`;
    row.appendChild(b);
    stats.appendChild(row);
    return b;
  };
  els.statVoices = mkStat('voices');
  els.statBus = mkStat('bus reduction');
  els.statMuted = mkStat('audio');
  els.feed = document.createElement('div');
  els.feed.className = 'sv-wb-feed';
  paneLive.append(stats, els.feed);

  dock.append(tabs, paneLib, paneLive);
  panel.append(rail, main, dock);
  document.body.appendChild(panel);

  els.hint = document.createElement('div');
  els.hint.className = 'sv-wb-hint sv-wb-off';
  els.hint.textContent = 'F closes · the stage bar below keeps working';
  document.body.appendChild(els.hint);

  // ONE KEY, ONE SURFACE. F already opens the stage bar, and the two are the
  // same job seen from two distances — the bar is how you fire an event, this
  // is what the event is made of. Binding a second key would mean a workbench
  // with no way to test and a test rig with nothing to edit, which is the
  // split this panel exists to end. So the workbench simply follows the stage:
  // F opens both, F closes both, and the bar keeps floating over the bottom
  // where it can still be reached with the panel shut.
  onStageChanged((on) => setWorkbenchVisible(on));

  // The bar rewraps as the window changes, and the gap under the panel has to
  // follow it or the library's delete button ends up behind it again.
  window.addEventListener('resize', () => { if (visible) fitToStageBar(); });
}

// Leave exactly enough room for the stage bar, which wraps to two or three
// rows depending on the window. Two things this got wrong on the first try,
// both worth keeping guarded:
//
//   MEASURED TOO EARLY  the bar is shown in the same tick this runs, and
//                       reading it before the browser has settled the wrap
//                       returned 732px — a bar twenty rows tall — which put
//                       the whole workbench off the top of the screen. Deferred
//                       a frame, so the measurement is of the laid-out bar.
//   TRUSTED BLINDLY     a measurement that absurd should never have been
//                       usable. Clamped to a range a control bar can actually
//                       occupy, so the worst case is a slightly wrong margin
//                       rather than a panel nobody can see.
function fitToStageBar() {
  requestAnimationFrame(() => {
    if (!visible || !panel) return;
    const bar = document.querySelector('.sv-stage');
    const raw = bar ? bar.getBoundingClientRect().height : 0;
    const h = Math.min(260, Math.max(72, Math.round(raw)));
    panel.style.bottom = `${h + 22}px`;
  });
}

export function setWorkbenchVisible(on) {
  if (!panel) return;
  visible = !!on;
  panel.classList.toggle('sv-wb-on', visible);
  els.hint.classList.toggle('sv-wb-off', !visible);
  // The tap is only installed while the panel is up, so playSfx costs one null
  // check per sound the rest of the time.
  watchSfx(visible ? noteFeed : null);
  feedRows = [];
  if (visible) {
    fitToStageBar();
    loadLibrary().then(() => { renderLibrary(); });
    render();
  }
}

export function isWorkbenchOpen() {
  return visible;
}

/** Called every frame from the loop; returns immediately while hidden. */
export function updateWorkbench() {
  if (!visible) return;
  renderFeed();
}
