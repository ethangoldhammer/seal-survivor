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
import { captureBossShot, resetBossShot } from '../../path/src/systems/bossShot.js';
import { initSnapshotCards, snapshotCardsLive } from '../../path/src/ui/snapshotCard.js';

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

// THE ROLL. Three kill shots, captured through the real bossShot.js off a
// hand-painted "frame" — so the fan, the polaroid papers and the preview are
// the shipped ones rather than three coloured rectangles. Without these the
// trophy block stays hidden and half this screen is untestable here.
const BOSSES = [
  { name: 'Grimtide', cause: 'Homing Missile', causeSource: 'missile', level: 9, score: 21400, time: 214, hue: 196 },
  { name: 'The Flensing Knife', cause: 'Fin Pebbles', causeSource: 'gun', level: 18, score: 74800, time: 452, hue: 24 },
  { name: 'Mother Abyss', cause: 'Cold Snap', causeSource: 'clubIce', level: 27, score: 148230, time: 727, hue: 286 },
];

function paintFrame(hue) {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, c.height);
  sky.addColorStop(0, `hsl(${hue} 60% 26%)`);
  sky.addColorStop(1, `hsl(${(hue + 40) % 360} 70% 8%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, c.width, c.height);
  // Something with a silhouette in it, so a crop that lost the subject is
  // visible rather than a slightly different flat colour.
  g.fillStyle = `hsl(${(hue + 180) % 360} 80% 62%)`;
  g.beginPath();
  g.ellipse(700, 430, 320, 130, -0.25, 0, 6.2832);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 40; i++) {
    g.fillRect((i * 173) % c.width, (i * 91) % c.height, 3, 3);
  }
  return c;
}

function seedShots() {
  resetBossShot();
  for (const b of BOSSES) captureBossShot(paintFrame(b.hue), b);
}

function open() {
  seedShots();
  showGameOver(RUN, { bosses: BOSSES.length });
  say(`card open — polaroid: ${snapshotCardsLive() ? 'Rive' : 'coded paper'}`);
}

// THE RIVE POLAROID, PARSED FIRST. main.js does this at boot; without it the
// fan falls back to the coded paper, and the two papers are different objects —
// one is an <img>, the other a live Rive canvas being drawn into inside a card
// that is about to be rotated in 3D. Looking at the coded one here and calling
// it the score screen is how the shipped screen goes unlooked-at.
initSnapshotCards().finally(open);
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
