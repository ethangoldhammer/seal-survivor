// THE SEAL'S TWO GAUGES, MOVING — the real ui/ui.js, the real stylesheet, the
// real smoothing, over a stand-in ocean.
//
// WHY THIS EXISTS. tools/player-bars-test.mjs proves the NUMBERS: that a bite
// takes four tenths of a second to drain, that no frame of it moves the bar
// more than a few percent, that the trail lags and catches up. What it cannot
// answer is the question the change was actually about — whether the movement
// READS. A fill that arrives smoothly and a fill that arrives smoothly but is
// too dark to see are the same numbers.
//
// So the page does two things a harness can't:
//
//   THE STRIP    one scripted bite, sampled at ten moments and laid out left to
//                right. Every cell is a CLONE of the live stack, so it is not a
//                drawing of the animation — it IS the animation, stopped. A bar
//                that skipped to its value would show as two cells and eight
//                copies of the second one.
//   THE WATER    the same gauges pinned to a moving animal by the real
//                projection, so the placement can be judged where it lives:
//                beside a seal, over a dark ocean, at the size it ships at.
//
// NO requestAnimationFrame: the agent's browser pane suspends it, and a page
// that never advances looks exactly like a bar that never moves — the one
// failure this is here to catch. setInterval is not throttled the same way.
// See tools/looks/tip-scene.js, which learned this first.
//
// The dt is FIXED at a 60th rather than measured off the wall clock: the strip
// is a claim about what happens 100ms after a hit, and a cell sampled on a
// janky interval would be a claim about something else.
import * as THREE from 'three';
import { initUI, showHud, updateHUD, resetPlayerBars } from '../../path/src/ui/ui.js';
import { CONFIG } from '../../path/src/config.js';

const MAX_HP = 100;
const MAX_O2 = 100;
const DT = 1 / 60;

// The arena's camera, near enough: the game's is orthographic and square onto
// the plane, so this is the same projection with round numbers. It matters
// because the gauges' anchor is a PROJECTED world point — CONFIG.hud
// .playerBarOffset to the seal's left — and a page that positioned them in
// pixels would not be testing the thing that actually places them.
const HALF = 20;
const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF * 0.5, -HALF * 0.5, 0.1, 100);
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

const player = {
  hp: MAX_HP,
  oxygen: MAX_O2,
  stats: { maxHp: MAX_HP, maxOxygen: MAX_O2 },
  mesh: { position: new THREE.Vector3(0, 0, 0) },
};
const gameState = { xp: 40, xpToNext: 100, level: 7, score: 12480, time: 204 };

initUI({
  onStart() {}, onRestart() {}, onLevelChoice() {},
  onResume() {}, onPauseRestart() {}, onSplash() {},
});
showHud();
resetPlayerBars();

// Everything in the HUD except the gauges is somebody else's page. Hidden
// rather than not built, because the gauges are children of #svHud and only
// exist if the HUD does.
const hide = document.createElement('style');
hide.textContent = `
  .sv-hud > *:not(.sv-playerbars) { display: none !important; }
  .sv-toast-layer, .sv-bossbar, .sv-transition { display: none !important; }
  /* initUI builds every menu up front, and the start panel is not hidden until
     something asks for a screen. Nothing here ever will. */
  #svStartMenu, #svLevelUpMenu, #svGameOverMenu, #svLeaderboard, .sv-riv { display: none !important; }
`;
document.head.appendChild(hide);

const sea = document.getElementById('sea');
const strip = document.getElementById('strip');
const phase = document.getElementById('phase');

// The animal. A dark ellipse: what is being judged here is a pair of bars
// beside a body, and a body is all that has to be there.
const seal = document.createElement('div');
seal.className = 'seal';
sea.appendChild(seal);

function toScreen(x, y) {
  const v = new THREE.Vector3(x, y, 0).project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
}

// ---------------------------------------------------------------------------
// THE STRIP — one bite, sampled.
// ---------------------------------------------------------------------------

// Seconds after the hit. Dense at the front because that is where a snap would
// hide: the difference between smoothing and not smoothing is entirely inside
// the first fifth of a second.
const SAMPLES = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.5];

// THE LIVE STACK, held once.
//
// NOT re-queried per cell, and this cost an hour: #film sits before the HUD in
// the body, so the moment the first clone lands in the strip it becomes the
// FIRST .sv-playerbars in document order — and every later cell cloned that
// frozen first cell instead of the moving original. The strip came out as ten
// identical pictures, which is indistinguishable from the exact bug this page
// exists to catch. Scoped to .sv-hud as well, so a clone can never match it.
const liveBars = document.querySelector('.sv-hud .sv-playerbars');

/**
 * A cell: the live stack, cloned. Position and opacity come off it because in
 * the strip it is a specimen rather than something pinned to an animal — every
 * other thing about it, including the two custom properties that ARE the
 * frame, comes along in the clone.
 */
function cell(label) {
  const shot = liveBars.cloneNode(true);
  shot.style.position = 'static';
  shot.style.transform = 'none';
  shot.style.opacity = '1';
  shot.style.left = '';
  shot.style.top = '';

  const box = document.createElement('div');
  box.className = 'cell';
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = label;
  box.appendChild(shot);
  box.appendChild(cap);
  strip.appendChild(box);
}

function buildStrip() {
  strip.innerHTML = '';
  // A settled, undamaged seal to start from, so the first cell is the "before"
  // rather than whatever the last build left behind.
  resetPlayerBars();
  player.hp = MAX_HP; player.oxygen = MAX_O2;
  for (let i = 0; i < 60; i++) updateHUD(gameState, player, null, 0, null, DT);
  cell('before');

  // A 65-point bite, all at once — the worst case for a bar that used to snap.
  player.hp = 35;
  let t = 0;
  let next = 0;
  while (next < SAMPLES.length) {
    if (t >= SAMPLES[next] - 1e-9) {
      cell(SAMPLES[next] === 0 ? 'hit' : `+${Math.round(SAMPLES[next] * 1000)}ms`);
      next++;
      continue;
    }
    updateHUD(gameState, player, null, 0, null, DT);
    t += DT;
  }

  // And the other half of the story: air running out slowly, which is the case
  // the alarm colour and the pulse are for.
  const gap = document.createElement('div');
  gap.className = 'gap';
  strip.appendChild(gap);
  resetPlayerBars();
  player.hp = MAX_HP; player.oxygen = MAX_O2;
  for (const air of [70, 40, 22, 12, 4]) {
    player.oxygen = air;
    for (let i = 0; i < 120; i++) updateHUD(gameState, player, null, 0, null, DT);
    cell(`air ${air}%`);
  }
}

// ---------------------------------------------------------------------------
// THE WATER — the same gauges, live, on a swimming animal.
// ---------------------------------------------------------------------------

// A run on a loop: cruise, take two bites, surface and refill. Written as a
// list of (at, do) rather than a state machine because the only thing it has to
// be is legible when somebody reads it to work out what they just watched.
const SCRIPT = [
  { at: 1.2, hp: 62, say: 'bitten — 38 off' },
  { at: 2.6, hp: 28, say: 'bitten again' },
  { at: 4.6, hp: 90, say: 'healed' },
  { at: 6.0, o2: 18, say: 'air running out' },
  { at: 8.0, o2: 100, say: 'surfaced' },
  { at: 9.5, hp: 100, say: 'cruising' },
];
let clock = 0;
let step = 0;

function tick() {
  clock += DT;
  if (clock > 11) { clock = 0; step = 0; resetPlayerBars(); player.hp = MAX_HP; player.oxygen = MAX_O2; }
  while (step < SCRIPT.length && clock >= SCRIPT[step].at) {
    const s = SCRIPT[step++];
    if (s.hp != null) player.hp = s.hp;
    if (s.o2 != null) player.oxygen = s.o2;
    phase.textContent = s.say;
  }
  // Air always leaking, so the second gauge is never a still picture.
  player.oxygen = Math.max(0, player.oxygen - 2.2 * DT);

  player.mesh.position.x = Math.sin(clock * 0.55) * 9;
  player.mesh.position.y = Math.sin(clock * 0.9) * 2.6;
  const p = toScreen(player.mesh.position.x, player.mesh.position.y);
  seal.style.left = `${p.x}px`;
  seal.style.top = `${p.y}px`;

  updateHUD(gameState, player, null, 0, camera, DT);
}

buildStrip();
document.getElementById('rebuild').addEventListener('click', buildStrip);
setInterval(tick, 1000 / 60);

document.getElementById('facts').textContent =
  `offset ${CONFIG.hud.playerBarOffset} world units to the seal's left · dt fixed at 1/60`;
