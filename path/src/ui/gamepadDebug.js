import { inputStatus } from '../input.js';
import { hapticsAvailable, hapticStatus, testHaptic } from '../systems/haptics.js';
import { CONFIG } from '../config.js';
// Don't hijack G/H while a text field has focus.
import { isTypingTarget } from './typing.js';

// Hold G for a live readout of whatever the Gamepad API is telling us.
//
// "The controller does nothing" has three completely different causes that all
// look the same from the couch: the browser never handed us a pad, it handed us
// the wrong one of several, or it handed us a pad whose axes sit somewhere other
// than 0-3. This panel separates them in about two seconds — push a stick and
// watch which row moves.

let panel = null;
let visible = false;

const BAR_WIDTH = 68;

export function initGamepadDebug() {
  panel = document.createElement('div');
  panel.id = 'svGamepadDebug';
  panel.style.cssText =
    'position:fixed;left:12px;bottom:12px;z-index:30;display:none;' +
    'padding:10px 12px;border-radius:8px;pointer-events:none;' +
    'background:rgba(5,6,10,0.82);border:1px solid rgba(232,236,243,0.14);' +
    'color:rgba(232,236,243,0.86);font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'letter-spacing:0.02em;white-space:pre;min-width:210px;';
  document.body.appendChild(panel);

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) || e.repeat) return;
    const k = e.key.toLowerCase();
    // H fires one deliberate buzz. Tuning rumble by feel needs a trigger that
    // doesn't depend on any event's own pattern being set — otherwise "I feel
    // nothing" can't be separated from "that event has no haptic authored".
    if (k === 'h') testHaptic();
    if (k !== 'g') return;
    visible = true;
    panel.style.display = 'block';
  });
  window.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() !== 'g') return;
    visible = false;
    panel.style.display = 'none';
  });
  // Releasing G outside the window would otherwise leave the panel stuck on.
  window.addEventListener('blur', () => {
    visible = false;
    if (panel) panel.style.display = 'none';
  });
}

// Signed bar, centre-anchored, so a stick at rest reads as visibly centred
// rather than as an empty bar you can't distinguish from a dead axis.
function axisBar(v) {
  const half = BAR_WIDTH / 2;
  const filled = Math.round(Math.abs(v) * half);
  const left = v < 0 ? '#'.repeat(filled).padStart(half, '·') : '·'.repeat(half);
  const right = v > 0 ? '#'.repeat(filled).padEnd(half, '·') : '·'.repeat(half);
  return `${left}|${right}`;
}

const AXIS_LABELS = ['LX', 'LY', 'RX', 'RY'];

export function updateGamepadDebug() {
  if (!visible || !panel) return;

  if (inputStatus.gamepadBlocked) {
    panel.textContent =
      'GAMEPAD\n\nBlocked by permissions policy.\nThis page is framed — open the\ngame in its own browser tab.';
    return;
  }

  if (inputStatus.padIndex < 0) {
    panel.textContent =
      'GAMEPAD\n\nNo pad visible.\n\nBrowsers hide a controller until\nyou press one of its buttons —\npress any button now.\n' +
      (inputStatus.gamepadName ? `\nLast seen: ${inputStatus.gamepadName}` : '');
    return;
  }

  const lines = [
    'GAMEPAD',
    '',
    trim(inputStatus.gamepadName, 30),
    `slot ${inputStatus.padIndex}  ·  ${inputStatus.padMapping}` +
      (inputStatus.padCount > 1 ? `  ·  ${inputStatus.padCount} connected` : ''),
    '',
  ];

  inputStatus.axes.forEach((v, i) => {
    const label = (AXIS_LABELS[i] ?? `a${i}`).padEnd(3);
    lines.push(`${label}${axisBar(v)} ${v.toFixed(2).padStart(5)}`);
  });

  const pressed = inputStatus.buttons
    .map((v, i) => (v > 0.5 ? i : -1))
    .filter((i) => i >= 0);
  lines.push('');
  lines.push(`buttons  ${pressed.length ? pressed.join(' ') : '—'}`);
  lines.push('expects  0 fire  ·  4 5 6 7 boost');
  // "I don't feel any rumble" has two answers — the pad can't, or it's switched
  // off — and they need different fixes.
  const rumble = !CONFIG.haptics.enabled
    ? 'off in tuning'
    : hapticsAvailable()
      ? `yes  ·  x${(CONFIG.haptics.intensity ?? 1).toFixed(2)}`
      : 'PAD HAS NONE';
  lines.push(`rumble   ${rumble}`);
  // The count is the part that matters: "available" only says the pad CAN
  // rumble. If this stays at 0 while you're taking hits, no event is reaching
  // the actuator and the fault is in config, not the hardware.
  lines.push(`sent     ${hapticStatus.sent}  ·  last ${hapticStatus.lastMagnitude.toFixed(2)}`);
  if (hapticStatus.lastError) lines.push(`error    ${trim(hapticStatus.lastError, 28)}`);
  lines.push('press H  test buzz');

  panel.textContent = lines.join('\n');
}

function trim(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
