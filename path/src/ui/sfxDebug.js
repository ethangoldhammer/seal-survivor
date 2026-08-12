import { watchSfx, gainToDb, isMuted, sfxVoiceLoad } from '../systems/audio.js';
import { isTypingTarget } from './typing.js';

// A live feed of every sound the game tries to make, toggled with 0.
//
// The thing it is actually for is the sounds that DON'T play. A missing sound
// has half a dozen possible causes that all present identically as silence:
// the name is wrong, the throttle ate it, the mute key is on, or the file never
// decoded and the synth fallback is playing something that sounds nothing like
// what you loaded. Every one of those is a separate row here, and none of them
// is visible any other way — playSfx has always just returned.
//
// `cut short` is the odd one out and reads differently: that sound DID play,
// and was faded out early to give its voice slot to something newer. It is not
// a failure, it is the concurrency cap working — but a run of them all naming
// the same sound is how you find the event that is eating the budget.
//
// Repeats collapse rather than scroll. The basic shot fires several times a
// second, so a raw log is a blur of one word; a counter on a held row is
// readable, and the count is itself the information you want during a
// firefight.

const MAX_ROWS = 14;
const HOLD_MS = 2600; // how long a row stays before it fades out of the list

// name+outcome -> row. Rows are held in insertion order, newest first.
let rows = [];
let panel = null;
let body = null;
let head = null;
let visible = false;
let dirty = true;

// Rolling one-second window, for the rate readout. A count of events per second
// is the fastest way to see that something is firing far more often than you
// thought — which is the usual reason a sound is "too loud".
let recent = [];
let dropped = 0;
let played = 0;

const COLOR = {
  sample: 'rgba(122,215,255,0.95)', // played a file
  synth: 'rgba(232,236,243,0.78)', // played the fallback
  note: 'rgba(143,217,168,0.9)', // ambience and other non-one-shots
  gap: 'rgba(255,179,71,0.9)', // throttled
  far: 'rgba(255,179,71,0.9)', // lost its slot to closer sounds
  stolen: 'rgba(198,176,255,0.85)', // cut short to make room — it DID play
  voices: 'rgba(255,179,71,0.9)', // over the concurrency cap
  muted: 'rgba(232,236,243,0.35)',
  off: 'rgba(232,236,243,0.35)',
  unknown: 'rgba(255,128,149,0.95)', // no such sound — always a bug
  missing: 'rgba(255,128,149,0.95)', // named files, none loaded — also a bug
};

const LABEL = {
  gap: 'throttled',
  // Not "no voice": the budget had room for it, it was simply the furthest
  // thing asking. Worth its own word, because the fix is different — a wall of
  // these is the arena being loud a long way off, not the cap being too small.
  far: 'too far',
  stolen: 'cut short',
  voices: 'no voice',
  muted: 'muted',
  off: 'audio off',
  unknown: 'NO SUCH SOUND',
  missing: 'NO FILE LOADED',
};

export function initSfxDebug() {
  panel = document.createElement('div');
  panel.id = 'svSfxDebug';
  // Right-hand side, so it doesn't sit on top of the gamepad panel bottom-left.
  panel.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:30;display:none;'
    + 'padding:9px 11px;border-radius:8px;pointer-events:none;'
    + 'background:rgba(5,6,10,0.82);border:1px solid rgba(232,236,243,0.14);'
    + 'color:rgba(232,236,243,0.86);font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'letter-spacing:0.02em;white-space:pre;min-width:250px;max-width:320px;';

  head = document.createElement('div');
  head.style.cssText =
    'color:rgba(232,236,243,0.45);border-bottom:1px solid rgba(232,236,243,0.12);'
    + 'padding-bottom:5px;margin-bottom:5px;';
  body = document.createElement('div');
  panel.append(head, body);
  document.body.appendChild(panel);

  window.addEventListener('keydown', (e) => {
    if (e.key !== '0' || isTypingTarget(e.target) || e.repeat) return;
    setVisible(!visible);
  });
}

function setVisible(on) {
  visible = on;
  panel.style.display = on ? 'block' : 'none';
  // The tap is only installed while the panel is up. With it off, playSfx does
  // one null check per sound and allocates nothing at all — which is the whole
  // reason a hook like this is allowed to live in that function.
  watchSfx(on ? record : null);
  // Cleared in BOTH directions. Opening on a stale list would be actively
  // misleading — it would read as live traffic — and holding one while hidden
  // serves nobody, so "not visible" and "nothing recorded" mean the same thing.
  rows = [];
  recent = [];
  dropped = 0;
  played = 0;
  dirty = true;
}

function record(name, outcome, detail) {
  const now = performance.now();
  recent.push(now);
  // `stolen` is deliberately in neither tally. The sound it names DID play —
  // it was counted then — and the sound that took its slot is counted on its
  // own row. Adding it to `dropped` would double-count a busy frame and make
  // the headline number mean two different things at once, which is the
  // failure this panel exists to avoid.
  if (outcome === 'gap' || outcome === 'far' || outcome === 'voices'
    || outcome === 'unknown' || outcome === 'missing') dropped++;
  else if (outcome === 'sample' || outcome === 'synth') played++;

  // Held rows are keyed by what makes two events "the same event" to a reader:
  // the sound and what happened to it. A shot that plays and a shot that gets
  // dropped are different lines even though they share a name.
  const key = `${name}|${outcome}`;
  const existing = rows.find((r) => r.key === key);
  if (existing) {
    existing.count++;
    existing.at = now;
    existing.detail = detail ?? existing.detail;
  } else {
    rows.unshift({ key, name, outcome, detail, count: 1, at: now });
    if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  }
  dirty = true;
}

function describe(row) {
  const d = row.detail ?? {};
  // The repetition ducking is shown only while it is actually biting. It is
  // the one thing on this panel that explains a sound getting quieter without
  // anybody touching a slider, so seeing the number is the difference between
  // "the mix is broken" and "that is the crowding control working".
  const duck = d.rep != null && d.rep < 0.99 ? `  rep ${fmtDb(d.rep)}` : '';
  if (row.outcome === 'sample') {
    const take = d.takes > 1 ? `take ${d.take}/${d.takes}` : 'sample';
    return `${take}  ${fmtDb(d.gain)}${duck}`;
  }
  if (row.outcome === 'synth') return `synth  ${fmtDb(d.gain)}${duck}`;
  if (row.outcome === 'note') return d.text ?? '';
  // A throttled sound reports the EVENT that was throttled, not the sound —
  // several events share one sound, and which of them is being swallowed is
  // the thing you need to know to fix it.
  if (row.outcome === 'gap' && d.text) return `throttled (${d.text})`;
  return LABEL[row.outcome] ?? row.outcome;
}

function fmtDb(gain) {
  if (gain == null) return '';
  const db = gainToDb(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
}

// Toggle from outside the keyboard, for the harness and for anything that
// wants to open the feed programmatically.
export function setSfxDebugVisible(on) {
  if (panel) setVisible(!!on);
}

// What the panel is showing, without reading the DOM. Same reasoning as
// ambientState(): the interesting behaviour here is the bookkeeping — what
// collapses into what, what counts as dropped, when a row ages out — and none
// of that should have to be tested through rendered text.
export function sfxDebugState() {
  return {
    visible,
    played,
    dropped,
    voices: sfxVoiceLoad(),
    rate: recent.length,
    rows: rows.map((r) => ({ name: r.name, outcome: r.outcome, count: r.count, detail: r.detail })),
  };
}

/**
 * Called every frame from the game loop, like the gamepad overlay. Returns
 * immediately while hidden, so the cost of having this in the build is one
 * boolean test per frame.
 */
export function updateSfxDebug() {
  if (!visible || !panel) return;
  const now = performance.now();

  // Age out both the rate window and the rows themselves. A row that stops
  // firing fades and leaves rather than sitting there implying it is still
  // going — the list should read as "what is happening", not "what happened".
  while (recent.length && now - recent[0] > 1000) recent.shift();
  const before = rows.length;
  rows = rows.filter((r) => now - r.at < HOLD_MS);
  if (rows.length !== before) dirty = true;

  const rate = recent.length;
  // The voice load belongs on the header rather than in a row, because it is a
  // LEVEL, not an event: "23/24" sitting pinned is the difference between a
  // sound being cut for a good reason and the budget being permanently full,
  // and that is invisible in a list of things that happened.
  const load = sfxVoiceLoad();
  const nextHead = `SFX   ${rate}/s   ${played} played   ${dropped} dropped\n`
    + `voices ${load.active}/${load.cap}${isMuted() ? '   MUTED' : ''}`;
  if (head.textContent !== nextHead) head.textContent = nextHead;

  if (!dirty) return;
  dirty = false;

  body.textContent = '';
  if (!rows.length) {
    const idle = document.createElement('div');
    idle.style.color = 'rgba(232,236,243,0.3)';
    idle.textContent = 'listening...  0 to hide';
    body.appendChild(idle);
    return;
  }

  for (const row of rows) {
    const line = document.createElement('div');
    // Older rows fade rather than vanishing, so the eye can follow a burst
    // down the list instead of things blinking out of it.
    const age = (now - row.at) / HOLD_MS;
    line.style.color = COLOR[row.outcome] ?? COLOR.synth;
    line.style.opacity = String(Math.max(0.25, 1 - age * 0.75));
    const count = row.count > 1 ? ` x${row.count}` : '';
    line.textContent = `${row.name.padEnd(15).slice(0, 15)} ${describe(row)}${count}`;
    body.appendChild(line);
  }
}
