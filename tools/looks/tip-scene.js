// THE WHOLE FEATURE, ON ONE PAGE: a tip standing beside the thing it is about,
// the thing pulsing while it is being talked about, and the sentence dissolving
// once the thing is collected.
//
// WHY IT IS NOT A SCREENSHOT OF THE GAME. Seeing this in the game means
// clearing the tip ledger, starting a run, and swimming into a bubble before
// anything eats you — once per tip, per browser. And the game's own dev server
// is the sole writer of imported-tuning.json, which this must not touch (see
// SERVERS.md). This is a static build of the REAL modules: ui/callout.js draws,
// systems/telegraph.js lights, ui/tipDissolve.js erodes, and CONFIG supplies
// every number.
//
// WHAT IS FAKED, and it is only the two things a look page cannot have: the
// ocean is a gradient with four DOM circles in it, and the coach's state
// machine is replaced by this file's little script (a bubble is "collected" on
// a timer rather than by a seal). Everything between those two — where the
// label lands, when the arrow appears, what the highlight does to a colour, how
// the line leaves — is the shipping code.
//
// NO requestAnimationFrame: the agent's browser pane suspends it. setInterval
// is not throttled the same way. See tools/looks/tip-dissolve.js.
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { CALLOUTS, pushCallout, clearCallout, pinCallout, resetCallouts, updateCallouts } from '../../path/src/systems/callouts.js';
import { initCallouts, updateCalloutUi } from '../../path/src/ui/callout.js';
import { setTelegraph, updateTelegraph, telegraphPulse } from '../../path/src/systems/telegraph.js';
import { TIP_DISSOLVES } from '../../path/src/ui/tipDissolve.js';

// The arena, near enough: the camera the game uses is orthographic and square
// onto the plane, so this is the same projection with round numbers.
const HALF = 20;
const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF * 0.75, -HALF * 0.75, 0.1, 100);
camera.position.set(0, 0, 10);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

const sea = document.getElementById('sea');
const phaseEl = document.getElementById('phase');
initCallouts(document.body);
// TWO THINGS THE GAME'S OWN UI LAYER WOULD HAVE SUPPLIED, and both fail
// silently without a word in the console:
//
//   .sv-hidden is declared by ui/ui.js's stylesheet, which this page has no
//   reason to load — so every "hidden" callout node renders anyway. The arrow
//   is the visible one: hidden, it has never been given a width, so its inline
//   SVG falls back to the 300x150 default and fills a quarter of the screen.
const style = document.createElement('style');
style.textContent = '.sv-hidden { display: none !important; }';
document.head.appendChild(style);

// --- the water --------------------------------------------------------------
// Four bubbles, one of which the tip is about. Four rather than one on purpose:
// a label is only worth anything when there is something to confuse it with.
const SUBJECT = 1;
const orbs = [-9, -1, 5, 12].map((x, i) => {
  const el = document.createElement('div');
  el.className = 'orb';
  sea.appendChild(el);
  return { el, x, y: -14 + i * 3, rise: 1.6 + i * 0.25, base: [0.87, 0.96, 1] };
});

const player = { x: -14, y: -6 };
const seal = document.createElement('div');
seal.className = 'orb';
seal.style.cssText = 'width:26px;height:26px;background:#2b3f52;box-shadow:0 0 18px #12324a';
sea.appendChild(seal);

function toScreen(x, y) {
  const v = new THREE.Vector3(x, y, 0).project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
}

// --- the script -------------------------------------------------------------
// One loop: the tip arrives, rides its bubble, the bubble is taken, the line
// dissolves where it was, a beat of nothing, and round again.
const RIDE = 4.5;      // how long the tip stands there before the orb is taken
const REST = 1.4;      // empty water between loops
const row = CALLOUTS.get('bubbleOrb');
let clock = 0;
let fade = 0;
let phase = 'waiting';

function collectedAt(t) {
  const seconds = CONFIG.tutorial.dissipate.seconds;
  return t > RIDE && t <= RIDE + seconds;
}

function frame(dt) {
  clock += dt;
  const loop = RIDE + CONFIG.tutorial.dissipate.seconds + REST;
  const t = clock % loop;

  // The bubbles rise and wrap, so the label has something that genuinely moves
  // under it — a tip that latched a position at the start looks perfect for
  // about a second, which is the failure this page is meant to make obvious.
  for (const o of orbs) {
    o.y += o.rise * dt;
    if (o.y > 13) o.y = -14;
  }

  const subject = orbs[SUBJECT];
  const live = t <= RIDE;
  const leaving = collectedAt(t);

  if (live && phase !== 'live') {
    resetCallouts();
    pushCallout(row);
    pinCallout(row, true);
    setTelegraph({ material: null }, 'ask');   // 'ask' — this page paints the orb itself
    fade = 0;
    phase = 'live';
  }
  if (leaving && phase === 'live') phase = 'leaving';
  if (!live && !leaving && phase !== 'waiting') {
    clearCallout(row);
    setTelegraph(null);
    phase = 'waiting';
  }
  if (phase === 'leaving') fade = Math.min(1, (t - RIDE) / CONFIG.tutorial.dissipate.seconds);

  //   ...and the SURFACE has to be aged. A callout's arrival curve is driven by
  //   slot.age (see popupPose), so a page that pushes a row and never calls
  //   updateCallouts draws it at age 0 forever — which is alpha 0, an element
  //   that is present, positioned, correct and completely invisible.
  updateCallouts(dt, {}, true);
  updateTelegraph(dt);

  // Paint the water. The subject wears the pulse the real system would be
  // writing into its material (systems/telegraph.js does exactly this multiply
  // on the colour the object already has).
  for (const [i, o] of orbs.entries()) {
    const p = toScreen(o.x, o.y);
    // THE SUBJECT IS GONE ONCE IT IS COLLECTED, which is the entire point of
    // the dissolve: the words are standing in water with nothing in it, holding
    // the place the bubble was for as long as it takes to read them. Leaving
    // the orb on screen through the fade would make this page a demonstration
    // of a tip leaving for no reason.
    if (i === SUBJECT && phase === 'leaving') { o.el.style.display = 'none'; continue; }
    o.el.style.display = '';
    const lit = i === SUBJECT && phase === 'live';
    const mul = lit ? telegraphPulse() : 1;
    const size = 26 * (lit ? 1 + (mul - 1) * 0.06 : 1);
    const [r, g, b] = o.base.map((c) => Math.min(1, c * mul));
    o.el.style.left = `${p.x}px`;
    o.el.style.top = `${p.y}px`;
    o.el.style.width = `${size}px`;
    o.el.style.height = `${size}px`;
    o.el.style.background = `rgb(${(r * 255) | 0} ${(g * 255) | 0} ${(b * 255) | 0} / 0.8)`;
    o.el.style.boxShadow = `0 0 ${12 * mul}px rgba(190,240,255,${0.5 * Math.min(1, mul)})`;
  }
  const sp = toScreen(player.x, player.y);
  seal.style.left = `${sp.x}px`;
  seal.style.top = `${sp.y}px`;

  // ...and the real drawing, handed exactly what main.js hands it.
  updateCalloutUi(dt, {
    camera,
    playerX: player.x,
    playerY: player.y,
    device: 'kbm',
    tipAnchor: phase === 'waiting' ? null : { x: subject.x, y: subject.y },
    tipFade: fade,
  });
  // The anchor deliberately keeps its last value through the dissolve in the
  // game (the words stay where the bubble was). Here the bubble is still
  // drifting, so freeze it the same way the coach does.
  if (phase === 'leaving') subject.y -= subject.rise * dt;

  phaseEl.textContent = phase === 'live'
    ? `riding its bubble — ${(RIDE - t).toFixed(1)}s before it is collected`
    : phase === 'leaving' ? `dissolving (${CONFIG.tutorial.dissipate.style}) — ${(fade * 100) | 0}%`
      : 'empty water';
}

// --- the style picker -------------------------------------------------------
const picker = document.getElementById('style');
for (const name of TIP_DISSOLVES) {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => {
    CONFIG.tutorial.dissipate.style = name;
    for (const other of picker.children) other.dataset.on = other === b ? '1' : '0';
  });
  b.dataset.on = CONFIG.tutorial.dissipate.style === name ? '1' : '0';
  picker.appendChild(b);
}

setInterval(() => frame(1 / 30), 33);
// For a probe that wants a still at a known point in the loop rather than
// wherever the timer has got to.
window.__tipScene = {
  seek: (t) => { clock = t; frame(0.0001); },
  style: (name) => { CONFIG.tutorial.dissipate.style = name; },
};
document.title = 'Tip in the water — ready';
