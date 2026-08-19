#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bars
//
// THE TWO GAUGES BESIDE THE SEAL — health and air — driven frame by frame
// through the real ui/ui.js in jsdom.
//
// They used to be two 4px horizontal slivers above the animal's head, written
// straight from hp every frame. Three things were wrong with that and all three
// are what this file guards:
//
//   THEY SNAPPED        a bite arrived as an instant step down. There was
//                       nothing on screen to say how big it had been, because
//                       the whole event was over inside one frame.
//   THE CSS "FIXED" IT  a `transition: width` on the fill looks like smoothing
//                       and is not: the value it is chasing moves every frame,
//                       so the transition restarts every frame and never
//                       arrives. Put one back and this file fails — that is
//                       the single most likely way this regresses, because it
//                       is the one-line version of the feature.
//   THEY WERE MISSED    green, thin, and behind the seal's own furniture.
//
// WHAT A HARNESS CAN AND CANNOT SEE. Everything below is the NUMBERS: what
// fraction each bar is drawing on a given frame, and how that fraction moves.
// jsdom computes the cascade well enough to read a colour and a size off a
// real element, so the shape and colour claims are checked against the live
// stylesheet rather than against a copy of it. What it cannot see is whether
// the result looks good — that is what design/components/hud.html is for.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. The other way round breaks the CJS chain jsdom loads through and
// fails with an error about an encoding fallback. See the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    if (spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} resizeDrawingSurfaceToCanvas(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

const THREE = await import('three');
const ui = await import('../path/src/ui/ui.js');
const { CONFIG } = await import('../path/src/config.js');

// ---------------------------------------------------------------------------
// THE RIG
// ---------------------------------------------------------------------------

const MAX_HP = 100;
const MAX_O2 = 100;
const player = {
  hp: MAX_HP,
  oxygen: MAX_O2,
  stats: { maxHp: MAX_HP, maxOxygen: MAX_O2 },
  mesh: { position: new THREE.Vector3(0, 0, 0) },
};
const gameState = { xp: 0, xpToNext: 100, level: 1, score: 0, time: 0 };

// A real camera, because the anchor claim below is about a PROJECTION and a
// hand-rolled one would only be testing my own arithmetic twice.
const camera = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 100);
camera.position.set(0, 0, 30);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

ui.initUI({
  onStart() {}, onRestart() {}, onLevelChoice() {},
  onResume() {}, onPauseRestart() {}, onSplash() {},
});
ui.showHud();

const $ = (sel) => document.querySelector(sel);
const fillOf = (el) => Number(el.style.getPropertyValue('--sv-fill'));
const hpFill = () => fillOf($('#svHpBar'));
const hpGhost = () => fillOf($('#svHpGhost'));
const o2Fill = () => fillOf($('#svO2Bar'));
const alarm = (id) => Number($(id).style.getPropertyValue('--sv-alarm'));

/** Run `seconds` of frames at `hz`, returning every hp fill along the way. */
function run(seconds, hz = 60, withCamera = true) {
  const dt = 1 / hz;
  const trail = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    ui.updateHUD(gameState, player, null, 0, withCamera ? camera : null, dt);
    trail.push(hpFill());
  }
  return trail;
}

// ---------------------------------------------------------------------------
section('The gauges are built to be drawn, not resized');

const wrap = $('#svHpWrap');
check('health has a track', !!wrap);
const kids = [...wrap.children].map((n) => n.className);
// Both layers are inset:0 absolute, so paint order IS dom order: a trail in
// front of the fill would hide the value it is trailing.
check('the trail is behind the fill', kids[0].includes('ghost') && !kids[1].includes('ghost'), kids.join(' → '));

const wrapStyle = getComputedStyle(wrap);
const w = parseFloat(wrapStyle.width);
const h = parseFloat(wrapStyle.height);
// VERTICAL is the whole point of the shape: a column that drains downwards.
check('the track is a column, not a strip', h > w * 2, `${w}px x ${h}px`);

const barsStyle = getComputedStyle($('.sv-playerbars'));
// Off the LEFT of its anchor, and centred on the seal's own height.
check('the stack hangs off the left of its anchor',
  barsStyle.transform.includes('-100%'), barsStyle.transform || '(none)');

const fillStyle = getComputedStyle($('#svHpBar'));
// THE REGRESSION GUARD NAMED IN THE HEADER. A transition here is the one-line
// version of smoothing, and it is the version that does not work.
// The PROPERTY is 'all' by default and says nothing; the duration is the
// claim. Anything non-zero here is a second curve fighting the one in JS.
const dur = `${fillStyle.transitionDuration || ''} ${fillStyle.transition || ''}`;
check('the fill carries no CSS transition', !/[1-9]/.test(dur), dur.trim() || '(none)');
// scaleY off the bottom edge, so the column empties downwards rather than
// shrinking towards its middle.
check('the fill is scaled from its bottom edge',
  (fillStyle.transformOrigin || '').includes('100%')
  || (fillStyle.transformOrigin || '').includes(`${h}px`), fillStyle.transformOrigin || '(none)');

// RED, and specifically not the old green. Read off the live cascade rather
// than off a copy of the rule, so a colour changed in ui.js is seen here.
const hpPaint = `${fillStyle.background} ${fillStyle.backgroundImage} ${fillStyle.backgroundColor}`;
check('health is red', /#e01023|224, 16, 35|#ff6a5a|255, 106, 90/i.test(hpPaint), hpPaint.slice(0, 90));
check('health is not the old green', !/#4dd0a8|77, 208, 168/i.test(hpPaint));

// ---------------------------------------------------------------------------
section('A bite does not snap — it drains');

run(0.5);                       // settle at full
check('starts full', Math.abs(hpFill() - 1) < 1e-3, `${hpFill()}`);

player.hp = 40;                 // a 60% bite
ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
const firstFrame = hpFill();
// The heart of it: one frame after a 60-point hit the bar must still be
// showing most of the health it had.
check('one frame later the bar has barely moved', firstFrame > 0.9, `${firstFrame.toFixed(3)}`);
check('...but it HAS moved', firstFrame < 1, `${firstFrame.toFixed(3)}`);

const drain = run(0.5);
let monotonic = true;
for (let i = 1; i < drain.length; i++) if (drain[i] > drain[i - 1] + 1e-9) monotonic = false;
check('the drain only ever goes down', monotonic);
// Long enough to see, short enough that the bar is honest by the time the next
// bite lands: a couple of hundred milliseconds of visible movement.
const midway = drain.findIndex((v) => v <= 0.7);
check('it takes more than a couple of frames to get halfway', midway > 3, `frame ${midway}`);

// ---------------------------------------------------------------------------
section('The trail is the size of the bite');

// Half a second after the hit: the fill is nearly there and the trail is still
// most of the way back up at the health the seal HAD.
check('the trail is standing above the fill', hpGhost() > hpFill() + 0.1,
  `trail ${hpGhost().toFixed(3)} vs fill ${hpFill().toFixed(3)}`);

run(0.5);
check('the fill arrives', Math.abs(hpFill() - 0.4) < 0.01, `${hpFill().toFixed(3)} vs 0.400`);
check('...while the trail is still readable a whole second after the hit',
  hpGhost() > hpFill() + 0.05, `trail ${hpGhost().toFixed(3)} vs fill ${hpFill().toFixed(3)}`);
run(3);
check('...but it does catch up eventually',
  Math.abs(hpGhost() - hpFill()) < 0.02, `trail ${hpGhost().toFixed(3)} vs fill ${hpFill().toFixed(3)}`);

// ---------------------------------------------------------------------------
section('A heal lands immediately, and leaves no false trail');

player.hp = 90;
run(0.25);
check('the fill is most of the way up already', hpFill() > 0.8, `${hpFill().toFixed(3)}`);
// A trail ABOVE the fill during a heal reads as damage — the exact opposite of
// what just happened. It must never be more than a hair above.
check('the trail never sits above a rising fill', hpGhost() <= hpFill() + 1e-3,
  `trail ${hpGhost().toFixed(3)} vs fill ${hpFill().toFixed(3)}`);

// ---------------------------------------------------------------------------
section('The same seconds look the same on any monitor');

// The classic bug this rules out: a per-frame lerp written as a fixed fraction
// runs at double speed on a 120Hz screen, making the bar's whole character a
// property of the player's hardware.
const sample = (hz) => {
  ui.resetPlayerBars();
  player.hp = MAX_HP; run(0.3, hz);
  player.hp = 30; run(0.25, hz);
  return hpFill();
};
const at60 = sample(60);
const at144 = sample(144);
const at30 = sample(30);
check('60Hz and 144Hz agree', Math.abs(at60 - at144) < 0.01, `${at60.toFixed(4)} vs ${at144.toFixed(4)}`);
check('30Hz agrees too', Math.abs(at60 - at30) < 0.02, `${at60.toFixed(4)} vs ${at30.toFixed(4)}`);

// ---------------------------------------------------------------------------
section('Low health pulses; full health does not');

ui.resetPlayerBars();
player.hp = MAX_HP; player.oxygen = MAX_O2;
run(0.4);
check('a healthy gauge is not alarming', alarm('#svHpWrap') === 0, `${alarm('#svHpWrap')}`);

player.hp = 15;
run(1.2);
const wave = [];
for (let i = 0; i < 40; i++) { run(1 / 60); wave.push(alarm('#svHpWrap')); }
const lo = Math.min(...wave); const hi = Math.max(...wave);
check('a dying one is', hi > 0.2, `peak ${hi.toFixed(3)}`);
// A static brightness is a state; a moving one is a thing asking to be looked
// at. The difference is the whole reason the wave is written from JS.
check('...and it moves rather than sitting bright', hi - lo > 0.2, `${lo.toFixed(3)}..${hi.toFixed(3)}`);

player.oxygen = 10;
run(1.5);
check('the air gauge alarms on its own', alarm('#svO2Wrap') > 0, `${alarm('#svO2Wrap')}`);
check('...and flips to the alarm colour', $('#svO2Bar').classList.contains('sv-o2-low'));
// AND THAT COLOUR IS NOT HEALTH'S. Two red columns side by side is the state
// this pair cannot be allowed to reach — see the note on .sv-pbar-o2.sv-o2-low.
const o2Paint = getComputedStyle($('#svO2Bar')).backgroundImage || '';
check('...which is amber, not health\'s red', /#ff8a00|255, 138, 0/i.test(o2Paint), o2Paint.slice(0, 90));
check('...so the two columns can still be told apart',
  !/#e01023|224, 16, 35/i.test(o2Paint), o2Paint.slice(0, 90));

// ---------------------------------------------------------------------------
section('The stack rides the seal, on its left');

player.mesh.position.set(0, 0, 0);
ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
const atOrigin = parseFloat($('.sv-playerbars').style.left);
const yAtOrigin = parseFloat($('.sv-playerbars').style.top);
// Screen x for world x=0 is the middle of the window; the anchor must be to
// the LEFT of it by the world offset, not above the animal.
check('the anchor is left of the seal', atOrigin < window.innerWidth / 2,
  `${atOrigin.toFixed(1)}px vs centre ${window.innerWidth / 2}`);
check('...by the world offset it is given', CONFIG.hud.playerBarOffset > 0,
  `playerBarOffset ${CONFIG.hud.playerBarOffset}`);
check('...and level with it, not above', Math.abs(yAtOrigin - window.innerHeight / 2) < 1,
  `${yAtOrigin.toFixed(1)}px vs centre ${window.innerHeight / 2}`);

player.mesh.position.set(6, 4, 0);
ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
const moved = parseFloat($('.sv-playerbars').style.left);
const movedY = parseFloat($('.sv-playerbars').style.top);
check('it follows the seal across the water', moved > atOrigin, `${atOrigin.toFixed(1)} → ${moved.toFixed(1)}`);
check('...and up it', movedY < yAtOrigin, `${yAtOrigin.toFixed(1)} → ${movedY.toFixed(1)}`);

// ---------------------------------------------------------------------------
section('A new run starts where the seal actually is');

// Smoothing carries state across the gap between runs. Without a reseed the
// first seconds of a new run animate up from the last one's dying health —
// a full bar filling in on a seal that has not been touched.
player.hp = 5;
run(2);
check('the bar is showing the old run', hpFill() < 0.1, `${hpFill().toFixed(3)}`);
player.hp = MAX_HP;
ui.showHud();
ui.updateHUD(gameState, player, null, 0, camera, 0);
check('showHud puts it back at full', Math.abs(hpFill() - 1) < 1e-3, `${hpFill().toFixed(3)}`);
check('...with no trail left over', Math.abs(hpGhost() - 1) < 1e-3, `${hpGhost().toFixed(3)}`);
check('...and air with it', Math.abs(o2Fill() - 1) < 1e-3, `${o2Fill().toFixed(3)}`);

// ---------------------------------------------------------------------------
section('A backgrounded tab does not resume with a snap');

player.hp = 20;
ui.updateHUD(gameState, player, null, 0, camera, 45);  // 45 seconds in one frame
check('one enormous frame is still a step, not a jump', hpFill() > 0.4, `${hpFill().toFixed(3)}`);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
