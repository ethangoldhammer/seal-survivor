import * as playtest from '../systems/playtest.js';
import { analyzeRun, analyzeRuns, formatRunReport, formatAggregateReport, formatClock } from '../systems/playtestAnalysis.js';
import { isTypingTarget } from './typing.js';

// ---------------------------------------------------------------------------
// THE BALANCE PANEL — press B.
//
// Three views of the same recorded data:
//   THIS RUN     what's happening right now, updated live while you play
//   LAST RUN     the run that just ended, with its verdicts
//   ALL RUNS     everything this browser has kept, pooled — the only view
//                that can actually settle an argument, since one run's death
//                time says more about how you dodged than about the numbers
//
// The report text itself comes from playtestAnalysis.js, which the Node CLI
// also uses; this file is presentation only. If a verdict looks wrong, the
// fix belongs in the analysis, not here.
// ---------------------------------------------------------------------------

let panel = null;
let body = null;
let tabsEl = null;
let visible = false;
let view = 'live'; // 'live' | 'last' | 'all'
let liveTimer = null;

const TABS = [
  ['live', 'This run'],
  ['last', 'Last run'],
  ['all', 'All runs'],
];

const LEVEL_COLOR = {
  bad: '#ff6b6b',
  warn: '#ffc861',
  ok: '#7ee081',
  info: 'rgba(232,236,243,0.55)',
};

export function initPlaytestOverlay() {
  panel = document.createElement('div');
  panel.id = 'svPlaytest';
  panel.style.cssText =
    'position:fixed;right:12px;top:12px;bottom:12px;width:min(560px,46vw);z-index:31;display:none;' +
    'flex-direction:column;border-radius:10px;overflow:hidden;' +
    'background:rgba(5,6,10,0.94);border:1px solid rgba(232,236,243,0.16);' +
    'color:rgba(232,236,243,0.88);font:500 11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;';

  const head = document.createElement('div');
  head.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:8px 10px;flex:0 0 auto;' +
    'border-bottom:1px solid rgba(232,236,243,0.12);background:rgba(232,236,243,0.04);';
  const title = document.createElement('div');
  title.textContent = 'BALANCE';
  title.style.cssText = 'letter-spacing:0.14em;font-size:10px;opacity:0.65;margin-right:auto;';
  head.appendChild(title);

  tabsEl = document.createElement('div');
  tabsEl.style.cssText = 'display:flex;gap:4px;';
  for (const [id, label] of TABS) {
    const b = button(label, () => { view = id; render(); });
    b.dataset.tab = id;
    tabsEl.appendChild(b);
  }
  head.appendChild(tabsEl);
  panel.appendChild(head);

  body = document.createElement('div');
  body.style.cssText = 'flex:1 1 auto;overflow:auto;padding:10px 12px;white-space:pre-wrap;';
  panel.appendChild(body);

  const foot = document.createElement('div');
  foot.style.cssText =
    'display:flex;gap:6px;padding:8px 10px;flex:0 0 auto;' +
    'border-top:1px solid rgba(232,236,243,0.12);background:rgba(232,236,243,0.04);';
  foot.appendChild(button('Copy report', copyReport));
  foot.appendChild(button('Download .jsonl', () => {
    const n = playtest.downloadStoredRuns();
    flash(`saved ${n} run${n === 1 ? '' : 's'}`);
  }));
  foot.appendChild(button('Clear stored', () => {
    // Only ever the browser's own copy. Anything already written to
    // playtest/runs.jsonl on disk is the durable record and is not touched —
    // clearing here must never be able to destroy a session's history.
    playtest.clearStoredRuns();
    flash('browser copy cleared (disk log untouched)');
    render();
  }));
  panel.appendChild(foot);

  document.body.appendChild(panel);

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) || e.repeat) return;
    if (e.key.toLowerCase() !== 'b') return;
    toggle();
  });
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'padding:4px 8px;border-radius:5px;cursor:pointer;' +
    'background:rgba(232,236,243,0.08);border:1px solid rgba(232,236,243,0.16);' +
    'color:inherit;font:inherit;font-size:10px;letter-spacing:0.04em;';
  b.addEventListener('click', onClick);
  return b;
}

function toggle() {
  visible = !visible;
  panel.style.display = visible ? 'flex' : 'none';
  if (visible) {
    render();
    // A live view that doesn't move is just a screenshot. Two updates a second
    // is enough to watch a clear rate fall, and cheap: it re-derives one
    // bucket, not the run.
    liveTimer = setInterval(() => { if (view === 'live') render(); }, 500);
  } else if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

function flash(msg) {
  const note = document.createElement('div');
  note.textContent = msg;
  note.style.cssText = 'margin-top:8px;opacity:0.6;';
  body.appendChild(note);
  setTimeout(() => note.remove(), 2500);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function render() {
  if (!panel) return;
  for (const b of tabsEl.children) {
    const on = b.dataset.tab === view;
    b.style.background = on ? 'rgba(232,236,243,0.2)' : 'rgba(232,236,243,0.08)';
  }
  body.textContent = '';
  if (view === 'live') renderLive();
  else if (view === 'last') renderLast();
  else renderAll();
}

function renderLive() {
  const run = playtest.currentRun();
  if (!run) {
    body.appendChild(text('No run in progress. Start one — this view updates as you play.', 'info'));
    return;
  }
  const snap = playtest.liveSnapshot();
  if (snap) {
    // The two numbers worth watching in real time. Clear rate is the whole
    // scaling question in one figure: below 1 you are no longer killing what
    // arrives, whatever the health bar says.
    body.appendChild(text(
      `${formatClock(snap.t)}   ${Math.round(snap.dps)} dps out   ${Math.round(snap.pressure)} hp/s arriving   `
      + `clear ${snap.clearRatio.toFixed(1)}x   ${Math.round(snap.incomingDps)} dps in   ${Math.round(snap.alive)} alive`,
      snap.clearRatio < 1 ? 'bad' : 'ok',
    ));
  }
  // Analysing the run in progress is safe: closed buckets only, so the report
  // lags by up to 30s and never divides by a fragment of a window.
  if (run.buckets.length === 0) {
    body.appendChild(text('\nFirst 30-second window still filling…', 'info'));
    return;
  }
  body.appendChild(report(analyzeRun(run)));
}

function renderLast() {
  const run = playtest.lastFinishedRun();
  if (!run) {
    body.appendChild(text('No finished run yet this session.', 'info'));
    return;
  }
  body.appendChild(report(analyzeRun(run)));
}

function renderAll() {
  const runs = playtest.loadStoredRuns();
  if (!runs.length) {
    body.appendChild(text('Nothing recorded in this browser yet.', 'info'));
    return;
  }
  const agg = analyzeRuns(runs);
  body.appendChild(text(formatAggregateReport(agg)));
  body.appendChild(text('\nRun `npm run playtest` for the same read across every run ever written to disk.', 'info'));
}

function report(a) {
  const wrap = document.createElement('div');
  wrap.appendChild(text(formatRunReport(a)));
  return wrap;
}

function text(content, level = null) {
  const d = document.createElement('div');
  d.textContent = content;
  if (level) d.style.color = LEVEL_COLOR[level];
  return d;
}

function copyReport() {
  const runs = playtest.loadStoredRuns();
  const run = playtest.currentRun() ?? playtest.lastFinishedRun();
  let out = '';
  if (view === 'all' && runs.length) out = formatAggregateReport(analyzeRuns(runs));
  else if (run && run.buckets.length) out = formatRunReport(analyzeRun(run));
  if (!out) { flash('nothing to copy yet'); return; }
  navigator.clipboard?.writeText(out).then(
    () => flash('copied'),
    () => flash('clipboard blocked — use Download instead'),
  );
}

/**
 * Called when a run ends. Deliberately does NOT open the panel: the game-over
 * screen wants the keyboard for name entry, and stealing focus to show a table
 * of numbers at the exact moment a run ends is the wrong trade. It prints the
 * verdict to the console and leaves the panel a keypress away.
 */
export function showPlaytestReport(run) {
  if (!run || !run.buckets.length) return;
  const a = analyzeRun(run);
  const style = a.verdict.level === 'bad' ? 'color:#ff6b6b' : a.verdict.level === 'warn' ? 'color:#ffc861' : 'color:#7ee081';
  console.groupCollapsed(`%c[playtest] ${formatClock(a.duration)} — ${a.verdict.text} (press B)`, style);
  console.log(formatRunReport(a));
  console.groupEnd();
  if (visible) render();
}
