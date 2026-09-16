// ---------------------------------------------------------------------------
// THE F PANEL, DOCKED — ui/workbench.js
//
//   npm run looks:dock
//
// The real panel, mounted and measured. Everything about docking it is
// GEOMETRY, and geometry is the one thing the jsdom harness beside this
// (tools/workbench-dock-test.mjs) cannot see: jsdom has no layout engine, so
// every rect there is 0x0 and a stylesheet that never matched passes it.
//
// So this page is the half that needs a browser. It stands a marked-up pitch
// behind the panel — a grid with the two goal mouths on it — and asks the
// questions a dock has to answer: how much of the pitch is left, whether the
// left mouth is still clear, whether a card in the one column is still as wide
// as the layout it was written for, and whether the strip's four panes each
// actually fill the cell rather than one of them collapsing to nothing.
//
// IT WRITES NOTHING. No save path, no dev server; serve.mjs never imports
// config.js. See SERVERS.md.
// ---------------------------------------------------------------------------
import { initWorkbench, setWorkbenchVisible, setWorkbenchDocked } from '../../path/src/ui/workbench.js';

// THE MODE IS REMEMBERED, so this page must not inherit it. The first run left
// the panel docked, the second one opened docked, and its "full bleed" block
// measured a dock and failed every line — a page that grades the state it is in
// against the state it assumed. Cleared before the panel is built, and every
// block below SETS the mode it is about to measure rather than toggling into it.
for (const k of ['sv-wb-docked', 'sv-wb-pane', 'sv-wb-width']) {
  try { window.localStorage.removeItem(k); } catch { /* private window */ }
}

const logEl = document.getElementById('log');
const log = (m, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = m; logEl.appendChild(d); };
let fails = 0;
const check = (name, ok, detail = '') => { log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`, ok ? 'ok' : 'bad'); if (!ok) fails++; };

// The two mouths, where wallRocks would put them: hard against each wall at
// midwater. What the dock must not cover is the left one.
for (const side of ['left', 'right']) {
  const m = document.createElement('div');
  m.className = 'mouth';
  m.style[side] = '0px';
  m.style.top = '38%';
  m.style.height = '24%';
  document.body.appendChild(m);
}

initWorkbench();
setWorkbenchVisible(true);

const panel = document.querySelector('.sv-wb');
const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
const shown = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
};
// A settled frame, so a rect is of the laid-out element and not of one the
// browser has not reflowed yet — the same trap fitToStageBar is guarded for.
const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const mode = document.querySelector('.sv-wb-mode');
const tabFor = (pane) => document.querySelector(`.sv-wb-panetabs .sv-wb-tab[data-pane="${pane}"]`);

await settle();

// --- FULL BLEED, WHICH MUST NOT HAVE MOVED --------------------------------
log('');
log('FULL BLEED — the panel as it was');
check('the panel mounted', !!panel);
setWorkbenchDocked(false);
await settle();
{
  const r = panel.getBoundingClientRect();
  check('it still fills the width', Math.round(r.width) === window.innerWidth, `${Math.round(r.width)} of ${window.innerWidth}`);
  check('the rail is up', shown('.sv-wb-rail'));
  check('...and the detail pane', shown('.sv-wb-cols'));
  check('...and the dock, all three at once', shown('.sv-wb-dock'));
  check('the docked strip is not', !shown('.sv-wb-panetabs'));
  check('...nor the width handle', !shown('.sv-wb-grip'));
  check('the dock keeps its own Library/Live tabs', shown('.sv-wb-dock > .sv-wb-tabs'));
}

// --- DOCKED ----------------------------------------------------------------
log('');
log('DOCKED — against the right edge');
// Through the button, because the button is the thing being tested — but from
// a known state, set above.
mode.click();
await settle();
{
  const r = panel.getBoundingClientRect();
  check('it is docked', panel.classList.contains('sv-wb-docked'));
  check('...against the right edge', Math.round(r.right) === window.innerWidth, `right ${Math.round(r.right)} of ${window.innerWidth}`);
  check('...and narrow', r.width < window.innerWidth * 0.5 + 1, `${Math.round(r.width)}px of ${window.innerWidth}`);
  log(`  it leaves ${Math.round(window.innerWidth - r.width)}px of pitch — ${Math.round((1 - r.width / window.innerWidth) * 100)}%`);

  const left = rect('.mouth');
  check('the left goal is clear of it', left.right < r.left, `mouth ends at ${Math.round(left.right)}, panel starts at ${Math.round(r.left)}`);

  check('the strip is up', shown('.sv-wb-panetabs'));
  check('...with four tabs', document.querySelectorAll('.sv-wb-panetabs .sv-wb-tab').length === 4);
  check('...and the width handle', shown('.sv-wb-grip'));
  check('the dock’s inner tabs are hidden, not doubled', !shown('.sv-wb-dock > .sv-wb-tabs'));
  check('one pane at a time: the cards, not the rail', shown('.sv-wb-cols') && !shown('.sv-wb-rail'));
}

// --- THE FOUR PANES ---------------------------------------------------------
// Each one has to FILL the cell. A pane that shows but collapses to nothing is
// the failure this whole layout invites: three elements sharing one grid cell,
// and only `display` between them.
log('');
log('THE FOUR PANES');
const paneOf = { feel: '.sv-wb-rail', tune: '.sv-wb-main', lib: '.sv-wb-dock', live: '.sv-wb-dock' };
for (const pane of ['feel', 'tune', 'lib', 'live']) {
  tabFor(pane).click();
  await settle();
  const p = panel.getBoundingClientRect();
  const r = rect(paneOf[pane]);
  const wide = Math.abs(r.width - p.width) < 2;
  const tall = r.height > p.height * 0.5;
  check(`"${tabFor(pane).textContent}" fills the panel`, wide && tall,
    `${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(p.width)}x${Math.round(p.height)}`);
  check(`...and it is the only one showing`, [...new Set(Object.values(paneOf))].filter((s) => shown(s)).length === 1);
}
// The Library/Live pair share an element, so the strip has to move the dock's
// own switch as well or the tab and the pane say different things.
tabFor('live').click();
await settle();
check('Live really shows the feed, not the library', shown('.sv-wb-feed') && !shown('.sv-wb-liblist'));
tabFor('lib').click();
await settle();
check('...and Library the library', shown('.sv-wb-liblist') && !shown('.sv-wb-feed'));

// --- A CARD IN ONE COLUMN ---------------------------------------------------
log('');
log('THE CARDS IN ONE COLUMN');
tabFor('tune').click();
await settle();
{
  const cards = [...document.querySelectorAll('.sv-wb-card')];
  check('there are cards', cards.length > 0, `${cards.length}`);
  const tops = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)));
  check('...stacked one to a row, not two to a cramped pair', tops.size === cards.length,
    `${cards.length} cards on ${tops.size} rows`);
  const w = cards[0].getBoundingClientRect().width;
  check('...at least as wide as the grid was written for (310px)', w >= 310, `${Math.round(w)}px`);
  // A slider whose label column eats the track is the thing that makes a narrow
  // panel useless, so measure the track rather than trusting the card.
  const track = document.querySelector('.sv-wb-f input[type=range]');
  if (track) {
    const tw = track.getBoundingClientRect().width;
    check('...and a slider still has a usable track', tw >= 120, `${Math.round(tw)}px`);
  }
}

// --- THE HANDLE -------------------------------------------------------------
log('');
log('THE WIDTH HANDLE');
{
  const drag = (x) => {
    const grip = document.querySelector('.sv-wb-grip');
    // setPointerCapture needs a real pointer id; the constructor supplies one.
    const opts = { bubbles: true, pointerId: 1, clientX: x, clientY: 300 };
    grip.dispatchEvent(new PointerEvent('pointerdown', opts));
    grip.dispatchEvent(new PointerEvent('pointermove', opts));
    grip.dispatchEvent(new PointerEvent('pointerup', opts));
  };
  const wide = window.innerWidth - 620;
  drag(wide);
  await settle();
  check('dragging left widens it', Math.round(panel.getBoundingClientRect().width) === 620,
    `${Math.round(panel.getBoundingClientRect().width)}px, asked for 620`);
  // ...and neither end may run away. A dock over most of the window is not a
  // dock, and one narrower than a card is a column of clipped controls.
  drag(10);
  await settle();
  const capped = panel.getBoundingClientRect().width;
  check('...and it cannot take more than half the window', capped <= window.innerWidth * 0.5 + 1,
    `${Math.round(capped)}px of ${window.innerWidth}`);
  drag(window.innerWidth - 20);
  await settle();
  const floor = panel.getBoundingClientRect().width;
  check('...nor squeeze past a card', floor >= 338, `${Math.round(floor)}px`);
  drag(window.innerWidth - 420);
  await settle();
}

// --- AND BACK ---------------------------------------------------------------
log('');
log('BACK TO FULL BLEED');
mode.click();
await settle();
{
  const r = panel.getBoundingClientRect();
  check('the button undocks it', !panel.classList.contains('sv-wb-docked'));
  check('...and it fills the width again', Math.round(r.width) === window.innerWidth, `${Math.round(r.width)}`);
  check('...with all three panes back', shown('.sv-wb-rail') && shown('.sv-wb-cols') && shown('.sv-wb-dock'));
  check('...and the dock’s own tabs back', shown('.sv-wb-dock > .sv-wb-tabs'));
}

// Left docked on the goal, because the point of the page is to look at it that
// way — and the goal is what the dock was asked for.
setWorkbenchDocked(true, 'tune');
await settle();
document.querySelectorAll('.sv-wb-ev').forEach((r) => { if (r.textContent.includes('The goal')) r.click(); });
await settle();

log('');
log(fails ? `${fails} FAILED` : 'all passed', fails ? 'bad' : 'ok');
