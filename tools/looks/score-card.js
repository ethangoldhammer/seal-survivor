// ---------------------------------------------------------------------------
// THE SCORE CARD, on its own.
//
//   npm run looks:score       then open http://localhost:4664/score-card.html
//
// The game-over card is the one screen that cannot be looked at from inside the
// game without dying first, and the two things that go wrong with it — a
// leaderboard too wide for the card, and a board that vanishes when the card is
// turned over and back — are both LAYOUT, which jsdom cannot see and a Node
// harness cannot measure. So the real ui.js is mounted here against a seeded
// local board and a recorded run, and the card is flipped by hand.
//
// IT WRITES NOTHING to the tuning: a vite build behind the read-only look
// server, with no /__tuning endpoint to reach. See SERVERS.md. It DOES write
// the local leaderboard key in this origin's localStorage — which is
// localhost:4664, not the game's origin, so the player's own board is untouched.
// ---------------------------------------------------------------------------
import { initTypography } from '../../path/src/ui/typography.js';
import { initUI, showGameOver, showLeaderboard, hideLeaderboard } from '../../path/src/ui/ui.js';

const say = (t) => { document.getElementById('say').textContent = t; };

// A board deep enough to scroll, with names at the cap so the row's own
// ellipsis is under test rather than a set of four-letter placeholders.
const NAMES = [
  'BARNACLEBILL', 'THE FLENSING KNIFE', 'ORCA', 'PUP', 'SEALTEAMSIX',
  'A VERY LONG NAME INDEED OK', 'CHUM', 'KELPIE', 'FLIPPERS MCGEE', 'BRINE',
  'SALT', 'ABYSSAL', 'GULLET', 'MOLLUSC', 'THE DEEP', 'SPRAT', 'HERRING',
];
const board = Array.from({ length: 40 }, (_, i) => ({
  name: NAMES[i % NAMES.length],
  score: 240000 - i * 5137,
  level: 40 - Math.floor(i / 2),
  time: 900 - i * 17,
  date: Date.now() - i * 86400000,
}));
localStorage.setItem('seal-survivor-leaderboard-v1', JSON.stringify(board));

initTypography();
initUI({
  onStart: () => {}, onRestart: () => open(), onLevelChoice: () => {},
  onResume: () => {}, onPauseRestart: () => {}, onSplash: () => {}, onMenu: () => {},
});

// The title screen is built by initUI as well and would sit behind the card.
document.getElementById('svStartMenu')?.classList.add('sv-hidden');

const RUN = {
  score: 148230,
  time: 727,
  level: 27,
  kills: 1184,
  deathCauses: new Set(['shark']),
  deathSource: { kind: 'enemy', type: 'shark' },
};

function open() {
  showGameOver(RUN, { bosses: 3 });
  say('card open');
}
open();

document.getElementById('btnShow').addEventListener('click', open);
document.getElementById('btnFlip').addEventListener('click', () => {
  document.getElementById(
    document.getElementById('svFaceFront').classList.contains('sv-hidden')
      ? 'svTurnBack' : 'svTurnOver',
  ).click();
});
document.getElementById('btnMeasure').addEventListener('click', () => say(measure()));
// The SAME board on the main menu's own surface — renderBoard paints both, so a
// column added for the card has to be looked at here too.
document.getElementById('btnBoard').addEventListener('click', () => {
  if (document.getElementById('svBoardPanel')?.classList.contains('sv-hidden') !== false) {
    document.getElementById('svGameOverMenu').classList.add('sv-hidden');
    showLeaderboard();
  } else {
    hideLeaderboard();
    document.getElementById('svGameOverMenu').classList.remove('sv-hidden');
  }
});

/**
 * What the page exists to report: is anything on the card wider than the card,
 * and is the board still on the screen after a turn?
 *
 * Read from the Browser pane through javascript_tool as well as from the
 * button — hence the global.
 */
function measure() {
  const card = document.getElementById('svCard');
  const lb = document.getElementById('svLeaderboard');
  const front = document.getElementById('svFaceFront');
  const cardBox = card.getBoundingClientRect();
  const lbBox = lb.getBoundingClientRect();
  const rows = [...lb.querySelectorAll('.sv-lb-row')];
  const widest = rows.reduce((m, r) => Math.max(m, r.scrollWidth), 0);
  return JSON.stringify({
    face: front.classList.contains('sv-hidden') ? 'back' : 'front',
    card: { w: Math.round(cardBox.width), h: Math.round(cardBox.height) },
    inlineH: card.style.height,
    board: {
      rows: rows.length,
      w: Math.round(lbBox.width), h: Math.round(lbBox.height),
      scrollH: lb.scrollHeight,
      widestRow: widest,
      overflows: widest > Math.ceil(lbBox.width),
      visible: lbBox.width > 0 && lbBox.height > 0,
    },
  }, null, 1);
}
window.__measure = measure;
window.__flip = () => document.getElementById(
  document.getElementById('svFaceFront').classList.contains('sv-hidden') ? 'svTurnBack' : 'svTurnOver',
).click();
