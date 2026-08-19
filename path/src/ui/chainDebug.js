import { CONFIG } from '../config.js';
import { strikeState, liveChain, sweetOffset, sweetHalfWidth, inSweetSpot, strikeLoaded, linkPips } from '../systems/strike.js';
import { chumSweep } from '../systems/chumMagnet.js';
import { chainTrace, chainTraceText, setChainTrace, chainTraceOn, clearChainTrace, formatChainEntry } from '../systems/chainTrace.js';
import { liveChainCss } from '../systems/chainColor.js';

// ---------------------------------------------------------------------------
// THE FOOD CHAIN, ON SCREEN, WHILE YOU PLAY. Toggled with C.
//
// Two halves, and they answer different questions.
//
//   THE LIVE STRIP is the state RIGHT NOW, per frame: where the wind-up is
//   against its sweet spot in milliseconds, whether a chain is armed, how long
//   the window has left. Its job is to make the tenth of a second the mechanic
//   turns on into something you can WATCH — the offset counts down through
//   zero, and the row goes green for exactly as long as a release would score.
//
//   THE LOG is what already happened, newest at the bottom, one line per
//   decision the mechanic took and the reason it took it. Its job is the
//   question a live readout cannot answer: "that one didn't chain — why not."
//
// WHY BOTH. Every failure of this mechanic looks the same from the seat, which
// is nothing happening; four different causes produce it and each wants a
// different fix. The live strip tells you whether your TIMING is the problem,
// and the log tells you what the problem was when it wasn't.
//
// PLAIN TEXT, MONOSPACE, NO STYLING TO SPEAK OF. It is a diagnostic, it is read
// while something else is happening, and every pixel of design on it is a pixel
// competing with the game it is describing. It is also the exact text
// `npm run chain:trace` prints, so a screenshot and a harness run can be put
// side by side — which is the whole reason formatChainEntry lives in the model.
// ---------------------------------------------------------------------------

const STYLES = `
  .sv-chaindbg { position: absolute; left: 10px; top: 10px; z-index: 40;
    font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #cfe6ff; background: rgba(6, 10, 18, 0.82);
    border: 1px solid rgba(120, 180, 255, 0.25); border-radius: 6px;
    padding: 8px 10px; pointer-events: none; white-space: pre; min-width: 340px; }
  .sv-chaindbg-live { margin-bottom: 6px; padding-bottom: 6px;
    border-bottom: 1px solid rgba(120, 180, 255, 0.18); }
  .sv-chaindbg-sweet { color: #7cff9a; }
  .sv-chaindbg-off { color: #ff8f7a; }
  .sv-chaindbg-dim { color: #7f92a8; }
`;

let root = null;
let liveEl = null;
let logEl = null;

export function initChainDebug(parent) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  root = document.createElement('div');
  root.className = 'sv-chaindbg sv-hidden';
  liveEl = document.createElement('div');
  liveEl.className = 'sv-chaindbg-live';
  logEl = document.createElement('div');
  root.appendChild(liveEl);
  root.appendChild(logEl);
  parent.appendChild(root);
}

/** Is the overlay up? The trace records only while it is. */
export function chainDebugOpen() {
  return !!root && !root.classList.contains('sv-hidden');
}

/**
 * Toggle it. Turning it ON clears the log rather than resuming an old one: the
 * entries are timestamped from the trace's own clock, and a log that spans a
 * gap where nothing was recorded reads as a chain that mysteriously stopped.
 */
export function toggleChainDebug() {
  if (!root) return false;
  const open = !chainDebugOpen();
  root.classList.toggle('sv-hidden', !open);
  clearChainTrace();
  setChainTrace(open);
  if (open) {
    console.log('[chain] trace on — C again to close, Shift+C to dump the log to this console');
  }
  return open;
}

/** The log as text, for pasting somewhere it can be read properly. */
export function dumpChainTrace() {
  const text = chainTraceText();
  console.log(`[chain] trace\n${text}`);
  return text;
}

function ms(v) {
  if (!Number.isFinite(v)) return '  --  ';
  return `${v >= 0 ? '+' : ''}${Math.round(v * 1000)}ms`;
}

/**
 * One frame of the readout. Called from the frame loop on REAL time, like the
 * callouts: a diagnostic that froze behind the upgrade cards would be blank at
 * the moment you most want to read what just happened.
 */
export function updateChainDebug(stats) {
  if (!chainDebugOpen()) return;

  const half = sweetHalfWidth(stats);
  const off = sweetOffset();
  const sweet = inSweetSpot(stats);
  const chain = liveChain();
  const win = strikeState.chainTimer;
  const winMax = Math.max(0.05, CONFIG.strike.chainWindow ?? 2.2);

  // THE WINDOW AS A BAR, because "1.4s left of 2.2" is a number you have to do
  // arithmetic on and a row of blocks is a thing you glance at.
  const cells = 14;
  const lit = Math.round(cells * Math.max(0, Math.min(1, win / winMax)));
  const bar = `${'#'.repeat(lit)}${'.'.repeat(cells - lit)}`;

  const cls = sweet ? 'sv-chaindbg-sweet' : (strikeState.pending > 0 ? 'sv-chaindbg-off' : 'sv-chaindbg-dim');
  const verdict = sweet ? 'RELEASE NOW' : (strikeLoaded() ? 'too late' : (strikeState.pending > 0 ? 'still winding' : '—'));

  liveEl.className = `sv-chaindbg-live ${cls}`;
  liveEl.textContent = [
    `beat   ${ms(off)}  (window +/-${Math.round(half * 1000)}ms)   ${verdict}`,
    `chain  x${chain}${chain > 0 ? '' : ' '}   armed ${strikeState.armed ? 'YES' : 'no '}   window [${bar}] ${win.toFixed(2)}s`,
    `food   ${strikeState.pipsSinceStrike} eaten since the strike (need ${linkPips(stats)})   sweep ${chumSweep() ? 'ON ' : 'off'}`,
  ].join('\n');
  // The chain's own colour on the readout too, so the wheel on screen and the
  // number here are visibly the same chain rather than two things that happen
  // to agree.
  liveEl.style.color = chain > 0 ? liveChainCss() : '';

  const rows = chainTrace().slice(-12);
  logEl.textContent = rows.length
    ? rows.map(formatChainEntry).join('\n')
    : '(strike, then eat something)';
}
