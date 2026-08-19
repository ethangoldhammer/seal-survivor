// Four dissolves, side by side, at the same progress.
//
// WHY A PAGE AND NOT A SCREENSHOT OF THE GAME: a tip only dissipates when its
// subject is collected, on a first run, once per device — so seeing one in the
// game means resetting the ledger and swimming into a bubble, and seeing the
// NEXT one means doing it again. Here all four are on screen at five progress
// values at once, over the same water, in the same type.
//
// It loads the real ui/tipDissolve.js and nothing else: no CONFIG, no three, no
// game. See tools/looks/serve.mjs — this is a static build and cannot reach the
// tuning file.
//
// NO requestAnimationFrame ANYWHERE, including the playing row. The agent's
// browser pane suspends rAF outright, so a page written that way comes up
// looking finished with none of the animation having run. setInterval is not
// throttled the same way and this page has nothing that needs frame accuracy.
import {
  TIP_DISSOLVES, TIP_DISSOLVE_DEFAULTS, applyTipDissolve, initTipDissolve, warmTipDissolve,
} from '../../path/src/ui/tipDissolve.js';

// The longest real coach line in callouts.csv, near enough — the choice has to
// survive a two-line tip, not a two-word one.
const LINE = 'Pop an air bubble. Free refill, no breach required.';

// Progress values. Not evenly spaced: everything interesting in a dissolve
// happens in the second half, and four cells of "still basically whole" would
// waste the sheet.
const STOPS = [0, 0.3, 0.55, 0.75, 0.9];

const WHAT = {
  boil: 'baked dither field, boiling — the house menu grain',
  warp: 'turbulence smear + noise cut, panning up',
  current: 'warp + a wash climbing the line, drifting with it',
  ink: 'no cut — blur and alpha spread it into the water',
};

const opts = { ...TIP_DISSOLVE_DEFAULTS };

initTipDissolve();
warmTipDissolve();

const sheet = document.getElementById('sheet');
const cells = [];

function tipNode() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  const ink = document.createElement('span');
  ink.className = 'tip-ink';
  ink.textContent = LINE;
  tip.appendChild(ink);
  return { tip, ink };
}

for (const style of TIP_DISSOLVES) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<div class="rowhead"><h2>${style}</h2><span>${WHAT[style]}</span></div>`;
  const grid = document.createElement('div');
  grid.className = 'cells';
  for (const t of STOPS) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const label = document.createElement('div');
    label.className = 't';
    label.textContent = t === 0 ? 'whole' : `t ${t}`;
    const { tip, ink } = tipNode();
    cell.append(label, tip);
    grid.appendChild(cell);
    // Each still is sampled at ITS OWN point in the flow, because the pan is
    // what makes these liquid — five cells all at clock 0 would be five frames
    // of the same static field, which is the one thing this page must not
    // misrepresent. Progress times the fall time is exactly what the game
    // hands in at that progress.
    cells.push({ ink, style, t, live: false });
  }
  row.appendChild(grid);
  sheet.appendChild(row);
}

// --- the playing row --------------------------------------------------------
const live = document.createElement('div');
live.className = 'row';
live.innerHTML = '<div class="rowhead"><h2>playing</h2><span>all four on a loop, '
  + '1.1s each with a beat of whole line between</span></div>';
const liveGrid = document.createElement('div');
liveGrid.className = 'cells';
liveGrid.style.gridTemplateColumns = `repeat(${TIP_DISSOLVES.length}, 1fr)`;
for (const style of TIP_DISSOLVES) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const label = document.createElement('div');
  label.className = 't';
  label.textContent = style;
  const { tip, ink } = tipNode();
  cell.append(label, tip);
  liveGrid.appendChild(cell);
  cells.push({ ink, style, live: true });
}
live.appendChild(liveGrid);
sheet.appendChild(live);

// --- controls ---------------------------------------------------------------
const controls = document.getElementById('controls');
const KNOBS = [
  ['warp', 0, 40, 1, 'push (px)'],
  ['flow', 0, 80, 1, 'flow (px/s)'],
  ['spread', 0, 16, 0.5, 'ink spread (px)'],
  ['cell', 1, 8, 0.25, 'boil grain (× line height)'],
  ['boilHz', 1, 24, 1, 'boil rate (Hz)'],
];
for (const [key, min, max, step, label] of KNOBS) {
  const wrap = document.createElement('label');
  wrap.innerHTML = `${label} <input type="range" min="${min}" max="${max}" step="${step}"
    value="${opts[key]}"><output>${opts[key]}</output>`;
  const input = wrap.querySelector('input');
  const out = wrap.querySelector('output');
  input.addEventListener('input', () => {
    opts[key] = Number(input.value);
    out.textContent = input.value;
    paint();
  });
  controls.appendChild(wrap);
}
const dump = document.createElement('button');
dump.textContent = 'log these numbers';
dump.addEventListener('click', () => console.log(JSON.stringify(opts, null, 2)));
controls.appendChild(dump);

// --- painting ---------------------------------------------------------------
// One clock for the whole page, advanced by a timer. The loop is 1.6s: 1.1s of
// dissolve and half a second whole, so the eye gets to see the line arrive at
// the start of each cycle rather than only ever seeing it mid-departure.
let clock = 0;
const LOOP = 1.6;
const FALL = 1.1;

function paint() {
  const phase = clock % LOOP;
  const t = phase < FALL ? phase / FALL : 0;
  for (const c of cells) {
    // THE CLOCK IS TIME SINCE THIS DISSOLVE STARTED, in both rows — see the
    // note on applyTipDissolve. Handing it the page's own ever-growing clock is
    // what made a tip that had been on screen a minute vanish outright instead
    // of dissolving: the noise field slides out of the filter region and the
    // cut then composites against nothing.
    if (c.live) applyTipDissolve(c.ink, c.style, t, t * FALL, opts);
    else applyTipDissolve(c.ink, c.style, c.t, c.t * FALL, opts);
  }
}

paint();
setInterval(() => { clock += 1 / 30; paint(); }, 33);

// For a probe that wants to hold the sheet at a known progress rather than
// wherever the loop happens to be.
window.__tipLook = {
  freeze: (t = null) => {
    for (const c of cells) {
      if (!c.live) continue;
      applyTipDissolve(c.ink, c.style, t ?? 0, 0.9, opts);
    }
  },
  opts,
};

document.title = 'Tip dissolve — ready';
