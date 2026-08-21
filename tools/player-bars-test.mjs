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

// THE SHIPPED DEFAULT IS THE CORNER. Everything from here down to the corner
// section is about the OTHER placement — the one that rides the animal — so it
// is pinned explicitly rather than inherited. Asserting the default here as
// well means a flip of that default fails on this one line, with the reason
// written next to it, instead of as a scatter of confusing geometry failures
// three sections later.
const S = await import('../path/src/systems/settings.js');
check('the shipped default is the corner', S.barPlacement() === 'corner', S.barPlacement());
S.setSetting('hud.barPlacement', 'seal');

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

// ---------------------------------------------------------------------------
section('The glow: critical on the way down, a real refill on the way up');

const glow = (id) => Number($(id).style.getPropertyValue('--sv-glow'));

// A STRUCTURAL CHECK, because this one broke in a way no value assertion could
// see. box-shadow is a single property, so a rule that restates it replaces the
// whole list — the corner placement's rim deleted the halo, in the placement
// that SHIPS, and every number in this file still read exactly right because
// the JS was writing --sv-glow perfectly into a shadow nothing was drawing.
// The rule is: any rule that puts a box-shadow on a bar track must end in the
// shared halo.
const sheetText = [...document.querySelectorAll('style')].map((n) => n.textContent).join('\n');
const wrapRules = sheetText.match(/[^{}]*\.sv-pbar-wrap[^{]*\{[^}]*\}/g) ?? [];
const shadowRules = wrapRules.filter((r) => /box-shadow\s*:/.test(r));
check('more than one rule paints the track', shadowRules.length >= 2, `${shadowRules.length} rule(s)`);
check('...and every one of them keeps the halo',
  shadowRules.length >= 2 && shadowRules.every((r) => /var\(--sv-halo\)/.test(r)),
  shadowRules.filter((r) => !/var\(--sv-halo\)/.test(r)).map((r) => r.slice(0, 60)).join(' | ') || 'all kept');

// Back to a clean, full seal.
player.stats.maxHp = MAX_HP; player.stats.maxOxygen = MAX_O2;
player.hp = MAX_HP; player.oxygen = MAX_O2;
ui.showHud();
run(1);
check('a full gauge does not glow', glow('#svHpWrap') < 0.001, glow('#svHpWrap').toFixed(3));

// THE TWO STAGES ARE DIFFERENT WARNINGS. The breathing alarm starts at a third
// of the bar; the glow starts at a seventh. If one threshold drove both, the
// loud one would be on for most of any bad fight and would stop meaning
// anything — so "low" must be able to be true while "critical" is false.
player.hp = MAX_HP * 0.28;
run(1.5);
check('low health breathes...', alarm('#svHpWrap') > 0.01, alarm('#svHpWrap').toFixed(3));
check('...but does not burn', glow('#svHpWrap') < 0.001, glow('#svHpWrap').toFixed(3));

player.hp = MAX_HP * 0.06;
run(1.5);
check('critical health burns', glow('#svHpWrap') > 0.5, glow('#svHpWrap').toFixed(3));

// A HEAL BIG ENOUGH TO CHANGE WHAT YOU DO NEXT. Measured as the gap the bar
// still has to travel, which on the frame the heal lands IS its size.
player.hp = MAX_HP;      // full heal from near death
ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
check('a big heal surges on the frame it lands', glow('#svHpWrap') > 0.99, glow('#svHpWrap').toFixed(3));
run(2.5);
check('...and fades once the bar has caught up', glow('#svHpWrap') < 0.05, glow('#svHpWrap').toFixed(3));

// ...AND ONE THAT DOES NOT. 8% of the bar, which is under the 15% the surge
// asks for: a run holding regeneration must not strobe.
player.hp = MAX_HP * 0.5;
run(2);
player.hp = MAX_HP * 0.58;
ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
check('a small heal does not', glow('#svHpWrap') < 0.001, glow('#svHpWrap').toFixed(3));

// A TRICKLE IS NOT A HEAL, however far it eventually travels. This is the case
// a running total of gains gets wrong: 40% of the bar arrives here, in 2% steps
// the chase keeps up with, and none of it is an event.
player.hp = MAX_HP * 0.4;
run(2);
let peak = 0;
for (let i = 0; i < 120; i++) {
  player.hp = Math.min(MAX_HP, player.hp + MAX_HP * 0.004);  // ~24% of the bar per second
  ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
  peak = Math.max(peak, glow('#svHpWrap'));
}
check('a slow trickle never surges, however far it climbs', peak < 0.001, `peak ${peak.toFixed(3)}`);

// ---------------------------------------------------------------------------
section('Air glows whenever it is coming back');

player.hp = MAX_HP;
player.oxygen = MAX_O2 * 0.5;
run(2);
check('air merely sitting still does not glow', glow('#svO2Wrap') < 0.001, glow('#svO2Wrap').toFixed(3));

// A BUBBLE — one instant jump.
player.oxygen = MAX_O2 * 0.72;
ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
check('a popped bubble glows', glow('#svO2Wrap') > 0.99, glow('#svO2Wrap').toFixed(3));

// A BREACH — a climb held for as long as the seal stays up, at the rate
// entities/player.js refills it. THE POINT OF THIS ONE is that it is nearly
// slow enough for the chase to keep up with: the gap it opens is about 0.02 of
// the bar, so any surge written as a threshold would be one retune of
// oxygenRefillRate away from missing a breach entirely.
player.oxygen = MAX_O2 * 0.2;
run(2);
const perFrame = MAX_O2 * (CONFIG.oxygen.refillRateSurface ?? 35) / MAX_O2 / 60;
let low = 1;
for (let i = 0; i < 90; i++) {
  player.oxygen = Math.min(MAX_O2, player.oxygen + perFrame);
  ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
  low = Math.min(low, glow('#svO2Wrap'));
}
check('a breach glows for the WHOLE refill, not just its first frame',
  low > 0.99, `dimmest frame ${low.toFixed(3)}`);
check('...and the tank really did fill', o2Fill() > 0.6, o2Fill().toFixed(3));

run(2.5);
check('...then fades once the seal is under again', glow('#svO2Wrap') < 0.05, glow('#svO2Wrap').toFixed(3));

// Draining is not filling, however fast it goes.
// The settle is longer than it looks like it needs to be, and it is load-
// bearing: TOPPING THE TANK UP TO 90% IS ITSELF A REFILL, so the setup line
// legitimately lights the gauge and the drain below would be measuring that
// glow decaying rather than anything the drain did. Three seconds at
// surgeFall 2.4 leaves about 0.07% of it.
player.oxygen = MAX_O2 * 0.9;
run(3);
peak = 0;
for (let i = 0; i < 60; i++) {
  player.oxygen -= MAX_O2 * 0.008;
  ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
  peak = Math.max(peak, glow('#svO2Wrap'));
}
check('air draining never surges', peak < 0.001, `peak ${peak.toFixed(3)}`);

// THE HALO WEARS THE GAUGE'S OWN COLOUR, and follows the amber the fill flips
// to — a drowning seal rimmed in the blue that means "fine" is worse than no
// rim at all.
player.oxygen = MAX_O2 * 0.1;
run(1);
check('a drowning tank glows', glow('#svO2Wrap') > 0.3, glow('#svO2Wrap').toFixed(3));
check('...in amber, not in the blue that means fine',
  $('#svO2Wrap').classList.contains('sv-o2-low'));
const o2Halo = getComputedStyle($('#svO2Wrap')).getPropertyValue('--sv-glow-rgb').trim();
const hpHalo = getComputedStyle($('#svHpWrap')).getPropertyValue('--sv-glow-rgb').trim();
check('...and the two gauges halo in different hues', o2Halo !== hpHalo, `air ${o2Halo} / health ${hpHalo}`);

// A NEW RUN DOES NOT OPEN BLAZING. The detector remembers last frame's value,
// and a reseed from a dying run's 5% to a fresh 100% is the biggest "heal" the
// bar will ever see.
player.hp = MAX_HP * 0.05;
player.oxygen = MAX_O2 * 0.05;
run(2);
player.hp = MAX_HP;
player.oxygen = MAX_O2;
ui.showHud();
ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
check('a new run does not open glowing', glow('#svHpWrap') < 0.001 && glow('#svO2Wrap') < 0.001,
  `hp ${glow('#svHpWrap').toFixed(3)} air ${glow('#svO2Wrap').toFixed(3)}`);

// ---------------------------------------------------------------------------
section('The other placement: pinned to the corner');

// settings.hud.barPlacement. Driven through setSetting rather than by poking
// the object, so this exercises the coercion the menu's own button goes
// through — a placement that survived a nudge but not a reload would pass a
// test written the other way.

player.hp = MAX_HP;
player.oxygen = MAX_O2;
ui.showHud();

S.setSetting('hud.barPlacement', 'corner');
check('the setting takes the corner', S.barPlacement() === 'corner', S.barPlacement());
// A value localStorage should never hold, to prove the fallback is the DEFAULT
// and not null — a choice that coerced to null used to reach the DOM as the
// class name "null", which matches no rule and silently draws nothing.
S.setSetting('hud.barPlacement', 'somewhere-else');
check('rubbish falls back to the default, not to null', S.barPlacement() === 'corner', String(S.settings.hud.barPlacement));
// ...and a reset lands on the corner too, which is the path a player takes out
// of the opt-out and the one place a wrong default is silent.
S.setSetting('hud.barPlacement', 'seal');
S.resetSettings('hud');
check('resetting the section restores the corner', S.barPlacement() === 'corner', S.barPlacement());

const bars = $('.sv-playerbars');
run(0.5);
check('the stack wears the corner class', bars.classList.contains('sv-playerbars-corner'));
check('the HUD is told, so the score can step aside',
  $('#svHud').classList.contains('sv-hud-barcorner'));

// THE INLINE ANCHOR. The seal placement writes left/top in pixels every frame,
// and an inline style beats every rule in the sheet — left behind, it would
// pin the corner stack to wherever the animal last was and no amount of
// `position: fixed; right: 14px` could move it.
check('the per-frame anchor is cleared', !bars.style.left && !bars.style.top,
  `left="${bars.style.left}" top="${bars.style.top}"`);

const cornerStyle = getComputedStyle(bars);
check('it is fixed to the viewport, not to the HUD', cornerStyle.position === 'fixed', cornerStyle.position);
check('...at the bottom right', /bottom/.test(cornerStyle.cssText || '') || cornerStyle.right !== 'auto',
  `right=${cornerStyle.right} bottom=${cornerStyle.bottom}`);

// ---------------------------------------------------------------------------
section('A bigger seal gets a longer column');

const growOf = (name) => Number(bars.style.getPropertyValue(name));
check('an untouched run is at its own baseline', Math.abs(growOf('--sv-hp-grow') - 1) < 0.02,
  growOf('--sv-hp-grow').toFixed(3));

// Deep Lungs and every +max-health card. The FRACTION does not move — a full
// seal is full at either maximum — so growth is the only thing on screen that
// can say the upgrade landed.
const beforeFill = hpFill();
player.stats.maxHp = MAX_HP * 2;
player.hp = player.stats.maxHp;
player.stats.maxOxygen = MAX_O2 * 1.5;
player.oxygen = player.stats.maxOxygen;
run(1.5);
check('the health column has doubled', Math.abs(growOf('--sv-hp-grow') - 2) < 0.05, growOf('--sv-hp-grow').toFixed(3));
check('the air column follows its own maximum', Math.abs(growOf('--sv-o2-grow') - 1.5) < 0.05, growOf('--sv-o2-grow').toFixed(3));
check('...while the fill is unchanged, because the seal is still full',
  Math.abs(hpFill() - beforeFill) < 0.02, `${beforeFill.toFixed(3)} → ${hpFill().toFixed(3)}`);

// Growth is a moment worth watching, so it is chased at the fill's own rise
// rate rather than stamped. One frame must not cover the whole distance.
player.stats.maxHp = MAX_HP * 3;
ui.updateHUD(gameState, player, null, 0, camera, 1 / 60);
const oneFrame = growOf('--sv-hp-grow');
check('the track lengthens over frames, it does not jump', oneFrame > 2 && oneFrame < 2.6, oneFrame.toFixed(3));

// THE CEILING HAS TO OUTLAST THE RUN, and this is a check on the STYLESHEET
// rather than on a frame because the clamp lives in CSS on purpose (see
// .sv-playerbars-corner — the limit is "how much screen is there").
//
// It matters because every run's maximum climbs a little now whether or not it
// ever takes a health card (CONFIG.player.hpPerLevel compounds per level), so
// the free growth eats into headroom that used to belong entirely to the
// health cards. A run reaches the mid-twenties in fifteen minutes
// (tools/xp-economy-test.mjs).
//
// TWO-SIDED ON PURPOSE, because both ways of getting this wrong are silent. A
// ceiling shorter than the free growth is the instrument going quiet for every
// run, and a clamped bar looks exactly like a bar. A free growth that fills
// most of the ceiling on its own is the other failure: the column is then
// nearly full before any card is taken, which is the upgrade this placement
// exists to show becoming invisible. A third of the range is the line — the
// baseline may spend up to that, and the rest stays the cards'. The shipped
// pair sits at 24% of it and the short-screen one at 27%, since a shorter
// screen has a shallower ceiling; the line is drawn past both so it is a guard
// against the curve being opened up rather than a restatement of today's.
//
// Every declared pair is checked, not just the shipped one: the short-screen
// override has its own base AND its own ceiling, and it is the one that gets
// forgotten.
const RUN_END_LEVEL = 26;
const runGrowth = Math.pow(1 + (CONFIG.player.hpPerLevel ?? 0), RUN_END_LEVEL - 1);
const trackPairs = [...sheetText.matchAll(/--sv-track:\s*([\d.]+)vh;\s*--sv-track-max:\s*([\d.]+)vh/g)]
  .map((m) => ({ base: Number(m[1]), max: Number(m[2]) }));
check('levelling alone grows the bar', runGrowth > 1.1,
  `x${runGrowth.toFixed(2)} by level ${RUN_END_LEVEL}`);
check('every track declares a ceiling', trackPairs.length >= 2, `${trackPairs.length} pair(s)`);
check('...and none of them stops growing before the run does',
  trackPairs.length >= 2 && trackPairs.every((t) => t.max / t.base >= runGrowth),
  trackPairs.map((t) => `${t.base}→${t.max}vh (x${(t.max / t.base).toFixed(2)})`).join(', '));
check('...while the free growth leaves the cards most of the track',
  trackPairs.every((t) => (runGrowth - 1) <= (t.max / t.base - 1) / 3),
  trackPairs.map((t) => `${((runGrowth - 1) / (t.max / t.base - 1) * 100).toFixed(0)}%`).join(' / ') + ' of the range');

// ---------------------------------------------------------------------------
section('Death and the next run');

// hidePlayerBars writes opacity:0 inline. The seal placement scrubs that out
// on its next frame (it rewrites opacity from the idle test every frame); the
// corner placement never fades, so nothing else would put it back and the
// instrument would be missing for the rest of the session.
ui.hidePlayerBars();
check('death fades the gauges', bars.style.opacity === '0', bars.style.opacity);
ui.showHud();
check('the next run brings them back', bars.style.opacity === '1', bars.style.opacity);

// And the baseline is per RUN: a seal that ended the last run at triple health
// must not open the next one claiming to be three times as long.
player.stats.maxHp = MAX_HP;
player.hp = MAX_HP;
player.stats.maxOxygen = MAX_O2;
player.oxygen = MAX_O2;
run(1.5);
check('a new run re-measures its own baseline', Math.abs(growOf('--sv-hp-grow') - 1) < 0.05, growOf('--sv-hp-grow').toFixed(3));

// ---------------------------------------------------------------------------
section('...and back to the seal, which is now the opt-out');

S.setSetting('hud.barPlacement', 'seal');
run(0.5);
check('the corner class is gone', !bars.classList.contains('sv-playerbars-corner'));
check('the HUD flag is gone with it', !$('#svHud').classList.contains('sv-hud-barcorner'));
check('the per-frame anchor is writing again', !!bars.style.left && !!bars.style.top,
  `left="${bars.style.left}" top="${bars.style.top}"`);

// ---------------------------------------------------------------------------
// THE THIRD COLUMN — the boost fuel, when the player has asked for it here
// instead of around the seal (settings.hud.boostMeter).
//
// The pips are NOT a second model. systems/strikeRing.js owns the springs, the
// stagger queue and the pops whichever view is on; this column reads them
// through pipAnim(). So the claims worth pinning are the ones that would break
// if that ever stopped being true — a column that fills instantly is a column
// that grew its own arithmetic — plus the one that says the two views can
// never both be drawn.
// ---------------------------------------------------------------------------
section('The boost fuel, as a column');

const RING = await import('../path/src/systems/strikeRing.js');
const STRIKE = await import('../path/src/systems/strike.js');
const CFG = (await import('../path/src/config.js')).CONFIG;

// The ring's mesh has to exist before its uniforms can be read, and it is the
// real one: a stand-in would be testing the stand-in.
const ringMesh = RING.createStrikeRing();
const U = ringMesh.material.uniforms;
const strike = { charge: 0, pending: 0, flash: 0, chainTimer: 0, perfectFlash: 0 };

/** Frames of BOTH models, in the order main.js runs them. */
function runFuel(seconds, hz = 60) {
  const dt = 1 / hz;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    ui.updateHUD(gameState, player, strike, 0, camera, dt);
    RING.updateStrikeRing(dt, player.mesh.position, strike, true, player.stats);
  }
}
const pipEls = () => [...document.querySelectorAll('#svBoostPips .sv-boost-pip')];
const pipFills = () => [...document.querySelectorAll('#svBoostPips .sv-boost-fill')]
  .map((f) => Number(f.style.getPropertyValue('--sv-pip')));
const litPips = () => pipFills().filter((v) => v > 0.9).length;

// THE SHIPPED DEFAULT IS THE COLUMN, asserted on its own line for the same
// reason the placement's is above: a flip of the default should fail here,
// with the reason beside it, rather than as a scatter of geometry failures
// below. It HAS flipped once — the wheel shipped first — so this line is
// load-bearing rather than ceremonial.
check('the shipped default is the column', S.boostMeter() === 'bar', S.boostMeter());

// THE OPT-OUT FIRST, because the two claims that matter are a pair and the
// wheel is the half that is easy to leave broken now that nobody sees it by
// default: with the ring chosen, the wheel draws the fuel and the column is
// not on screen at all.
S.setSetting('hud.boostMeter', 'ring');
strike.charge = 1;
runFuel(0.6);
check('choosing the ring puts the fuel back on the wheel', U.uFuel.value === 1);
check('...and the column is not on screen',
  getComputedStyle($('#svBoostWrap')).display === 'none',
  getComputedStyle($('#svBoostWrap')).display);

// The switch, from a paused menu — which is the path that has no frame to
// apply it on, so the settings handler is what makes it visible.
S.setSetting('hud.boostMeter', 'bar');
ui.applyBoostMeter();
check('switching hands the fuel to the column',
  $('.sv-playerbars').classList.contains('sv-playerbars-boost'));

// EMPTY FIRST, and the reset matters: the wheel has been full for the frames
// above, so a column built now would start life full and the stagger below
// would have nothing to catch up to.
RING.resetStrikeRing();
strike.charge = 0;
runFuel(0.4);
check('the column is drawn once the setting asks for it',
  getComputedStyle($('#svBoostWrap')).display !== 'none');
check('...and the wheel has gone quiet', U.uFuel.value === 0);
const pips = STRIKE.pipCount(player.stats);
check('one cell per pip', pipEls().length === pips, `${pipEls().length} of ${pips}`);
check('it starts empty', litPips() === 0, `${litPips()} lit`);

// THE STAGGER, which is the whole reason the column reads the ring's arrays
// rather than the bar value. A whole meter swallowed on ONE frame arrives one
// pip at a time; a column that did its own arithmetic would be full on the
// next frame and this is the check that would catch it.
strike.charge = 1;
runFuel(1 / 60);
check('a whole bar swallowed at once does not arrive at once', litPips() < pips,
  `${litPips()} of ${pips} lit on the first frame`);
runFuel(0.08);
// COUNTED AS STARTED, not as finished: a pip is released on its own spring and
// takes a moment to climb, so waiting for 0.9 measures the spring rather than
// the queue. What the stagger claims is that at 80ms SOME of the bar is on its
// way and the rest has not been released at all.
const moving = pipFills().filter((v) => v > 0.02).length;
check('a pip is on its way at 80ms', moving > 0, `${moving} of ${pips} moving`);
check('...and the rest are still queued', moving < pips, `${moving} of ${pips}`);
runFuel(0.5);
const late = litPips();
check('the pips land one at a time', moving < late, `${moving} moving at 80ms, ${late} full at 600ms`);
check('...and they all get there', late === pips, `${late} of ${pips}`);

// THE DRAIN IS NOT ALLOWED TO LAG. Holding burns fuel and the release spends
// it, and both are things the player DID — a queue on the way down reads as
// input lag. Snap, on the frame it happens.
strike.charge = 0;
strike.flash = CFG.strike.charge.flashTime;
runFuel(1 / 60);
check('spending the bar empties the column on the same frame', litPips() === 0, `${litPips()} still lit`);
check('...and the spend flashes it white',
  Number($('#svBoostWrap').style.getPropertyValue('--sv-spend')) > 0.5,
  $('#svBoostWrap').style.getPropertyValue('--sv-spend'));

// THE SAME REGRESSION GUARD THE TWO GAUGES CARRY. The spring is already the
// animation; a CSS transition chasing it is a second curve that never arrives.
const pipStyle = getComputedStyle($('#svBoostPips .sv-boost-fill'));
const pipDur = `${pipStyle.transitionDuration || ''} ${pipStyle.transition || ''}`;
check('the pip fill carries no CSS transition', !/[1-9]/.test(pipDur), pipDur.trim() || '(none)');
check('the pip fill is scaled from its bottom edge',
  (pipStyle.transformOrigin || '').includes('100%')
  || /\d/.test(pipStyle.transformOrigin || ''), pipStyle.transformOrigin || '(none)');

// THE COLOURS QUOTE THE WHEEL. Same ramp the shader walks, so switching styles
// changes the shape of the meter and not what it is saying — and the last pip
// keeps its own hue, which is what makes "one from full" readable in both.
const lastCol = document.querySelector('#svBoostPips .sv-boost-pip:last-child .sv-boost-fill')
  .style.getPropertyValue('--sv-pip-col');
const wantLast = `#${(CFG.strike.ring.lastPipColor ?? CFG.strike.ring.readyColor).toString(16).padStart(6, '0')}`;
check('the last pip wears the last-pip colour', lastCol.toLowerCase() === wantLast.toLowerCase(),
  `${lastCol} vs ${wantLast}`);

// A LINK RE-SEGMENTS THE BAR, and in the corner placement that has somewhere to
// go: the track grows with the pip COUNT, so the extra segment reads as extra
// rather than as every segment getting thinner.
S.setSetting('hud.barPlacement', 'corner');
const before = pipEls().length;
player.stats.strikeChumRefill = CFG.strike.charge.chumRefill / 2;
runFuel(1.2);
check('a link cuts the column into more pips', pipEls().length > before,
  `${before} → ${pipEls().length}`);
check('...and the track grows with them',
  Number($('.sv-playerbars').style.getPropertyValue('--sv-boost-grow')) > 1.2,
  $('.sv-playerbars').style.getPropertyValue('--sv-boost-grow'));

// ---------------------------------------------------------------------------
// THE GRAIN — one field of noise across all three gauges.
//
// What is checkable here is the WIRING, which is most of what can go wrong:
// that the field reaches the DOM at all, that all three tracks are reading one
// set of numbers rather than three, that it moves, and that switching it off
// leaves a plain bar rather than a black one. What it LOOKS like is
// npm run looks:gauges.
// ---------------------------------------------------------------------------
section('The grain in the gauges');

// READ OFF THE UI ROOT, not off the bar stack and not off the HUD: the field is
// worn by every meter on screen — the two gauges, the boost column, the level
// strip and the boss bar — and the boss bar is deliberately outside .sv-hud, so
// the root is the only ancestor all five inherit from.
const hud = ui.uiRoot();
const grainOf = (prop) => hud.style.getPropertyValue(prop);
CFG.hud.meterNoise.enabled = true;
// One phase is baked per frame on purpose (a whole set at once is a visible
// hitch on the first frame of a run), so this runs enough frames to be past
// the first of them.
runFuel(0.3);

const overlays = [...ui.uiRoot().querySelectorAll('.sv-meter-grain')];
// Five meters: health, air, the boost column, the level strip, the boss bar.
check('every meter carries a grain layer', overlays.length === 5, `${overlays.length} of 5`);
// ONE SET OF VARIABLES ON THE STACK, inherited. Three gauges wearing one field
// is the whole point, and three separate writes are three chances to disagree.
check('...and they all read one shared field',
  overlays.every((o) => !o.style.getPropertyValue('--sv-grain-img')),
  'no overlay carries its own tile');
check('the field reached the DOM', grainOf('--sv-grain-img').startsWith('url(data:image'),
  grainOf('--sv-grain-img').slice(0, 26));
check('...at the tuned size', grainOf('--sv-grain-size') === `${CFG.hud.meterNoise.tilePx}px`,
  grainOf('--sv-grain-size'));
check('...and the tuned depth',
  Math.abs(Number(grainOf('--sv-grain-depth')) - CFG.hud.meterNoise.depth) < 1e-6,
  grainOf('--sv-grain-depth'));

// IT MULTIPLIES. Any other blend can invent a colour the gauge is not wearing,
// and this one can only ever take light away — which is what makes a full-depth
// grain safe on a gauge whose colour IS its meaning.
const blend = getComputedStyle(overlays[0]).mixBlendMode;
check('the grain can only take light away', blend === 'multiply', blend || '(none)');

// MOVEMENT. Drift is the field sliding; the offset is written in pixels here
// and handed to the ring in ring radii, off one clock, so the two views of the
// boost meter cannot be at two phases of one field.
CFG.hud.meterNoise.driftY = -0.5;
// parseFloat, not Number: these are CSS LENGTHS and carry their unit, which
// is exactly what makes them usable in the sheet without a calc().
const before0 = parseFloat(grainOf('--sv-grain-y'));
runFuel(0.25);
const after0 = parseFloat(grainOf('--sv-grain-y'));
check('the field drifts', Math.abs(after0 - before0) > 0.5, `${before0} → ${after0}`);

// --- THE BOIL IS ON THE BEAT ------------------------------------------------
// The field takes ONE PHASE STEP per cycle of `boilSync`, off the same musical
// transport every synced shader in the game reads. What makes this worth a
// harness rather than an eyeball is that being slightly off the grid looks
// completely fine — that is the entire complaint systems/beatSync.js opens
// with — so "it churns" is not evidence of anything.
const BEAT = await import('../path/src/systems/beatSync.js');
const NOISE = await import('../path/src/systems/meterNoise.js');

// The harness has to carry the beat clock itself, exactly as main.js does
// ahead of every synced FX. Without this the transport sits at 0 and a
// quantised boil is frozen — which is correct behaviour and a useless test.
function runBeat(seconds, hz = 60) {
  const dt = 1 / hz;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    BEAT.updateBeatSync(dt);
    ui.updateHUD(gameState, player, strike, 0, camera, dt);
    // The ring too, in main.js's order — the offset claim at the end of this
    // section is about the two views agreeing, and a harness that only ran one
    // of them would be comparing a live number against a stale one.
    RING.updateStrikeRing(dt, player.mesh.position, strike, true, player.stats);
  }
}
const phaseNow = () => NOISE.meterNoiseFrame().phase;
const phases = CFG.hud.meterNoise.phases;

/**
 * Sit on a step boundary before timing anything.
 *
 * A quantised phase is derived ABSOLUTELY from the transport, so "run 0.4 of a
 * step and expect no change" is only true if you did not start 0.7 of the way
 * through one. Without this the checks below pass or fail on where the clock
 * happened to be when the file got here, which is the definition of a flake.
 */
function alignToStep(hz = 60) {
  const from = phaseNow();
  for (let i = 0; i < hz * 8; i++) {
    runBeat(1 / hz, hz);
    if (phaseNow() !== from) return true;
  }
  return false;
}

/**
 * How many times the field actually stepped across `seconds`.
 *
 * ONE FRAME IS SPENT FIRST, and it is not a fudge. A quantised cycle is
 * re-derived from the transport absolutely, so the frame after the division
 * changes lands wherever the NEW grid says it should be — one instantaneous
 * step, which is correct behaviour for a clock that is locked to the music
 * rather than integrated. Counting it would make every rate here read one
 * step fast.
 */
function countSteps(seconds, hz = 60) {
  const dt = 1 / hz;
  runBeat(dt, hz);
  let last = phaseNow();
  let steps = 0;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    runBeat(dt, hz);
    const now = phaseNow();
    if (now !== last) steps++;
    last = now;
  }
  return steps;
}

CFG.hud.meterNoise.boilSync = '1/8';
const eighth = BEAT.divisionSeconds('1/8');
check('an eighth is a real duration', eighth > 0.05 && eighth < 2, `${eighth.toFixed(3)}s`);
// Long enough for every phase to be baked, so the modulo below is over the
// whole set rather than over however much of it existed.
runBeat(1.5);

check('the clock reaches a step at all', alignToStep());
const p0 = phaseNow();
runBeat(eighth * 0.4);
check('the grain holds between steps', phaseNow() === p0, `phase ${p0} → ${phaseNow()}`);
runBeat(eighth * 0.75);
const p1 = phaseNow();
check('...and steps once an eighth goes by', (p1 - p0 + phases) % phases === 1,
  `phase ${p0} → ${p1}`);
// AND THE TILE ON THE STACK IS THE ONE THE FIELD SAYS IS CURRENT. The phase
// index stepping is the model; what the player sees is the data URI in
// --sv-grain-img, written only on the frames the phase actually moves.
//
// Checked as an EQUALITY rather than as "the tile changed", which cannot work
// here: jsdom's toDataURL is stubbed to one empty string (see the rig at the
// top of this file), so every phase bakes to a tile that compares equal and a
// difference test would fail on a perfectly working cache. What is provable
// without a real canvas is that the two agree — a cache that never invalidated
// would drift from the phase within one step and be caught on the next line.
alignToStep();
check('the tile on the stack is the current phase',
  grainOf('--sv-grain-img') === NOISE.meterNoiseFrame().tile,
  `phase ${phaseNow()}`);

// ...and the loop closes on the grid: a whole set of steps comes back round.
alignToStep();
const p1b = phaseNow();
runBeat(eighth * phases);
check('the loop closes on the beat', phaseNow() === p1b, `phase ${p1b} → ${phaseNow()}`);

// A slower division is genuinely slower, and this is the check that says the
// picker is wired to the grid rather than to a name. COUNTED over a window
// rather than watched across one boundary: where the transport happens to be
// is not something a test gets to assume, and a rate is what the setting
// actually means.
const WINDOW = 4;
CFG.hud.meterNoise.boilSync = '1/8';
const fast = countSteps(WINDOW);
CFG.hud.meterNoise.boilSync = '1 bar';
const bar = BEAT.divisionSeconds('1 bar');
const slow = countSteps(WINDOW);
check('an eighth-note boil steps once per eighth',
  Math.abs(fast - WINDOW / eighth) <= 1, `${fast} steps in ${WINDOW}s, expected ~${(WINDOW / eighth).toFixed(1)}`);
check('...and a bar-long one steps once per bar',
  Math.abs(slow - WINDOW / bar) <= 1, `${slow} steps in ${WINDOW}s, expected ~${(WINDOW / bar).toFixed(1)}`);

// ...and 'free' goes back to the rate in seconds, which is how this shipped
// before any of it was on a grid.
CFG.hud.meterNoise.boilSync = 'free';
const wasBoil = CFG.hud.meterNoise.boil;
CFG.hud.meterNoise.boil = 1;
const p3 = phaseNow();
runBeat(1 / phases + 1 / 30);
check('free runs on its own rate again', phaseNow() !== p3, `phase ${p3} → ${phaseNow()}`);
CFG.hud.meterNoise.boilSync = '1/8';
CFG.hud.meterNoise.boil = wasBoil;

// ONE FIELD, ONE PHASE, TWO VIEWS. The gauges read the offset in pixels and
// the ring reads it in ring radii, off one clock — so the only way to prove
// they cannot come apart is to read both after the same frame.
runBeat(1 / 60);
const inTiles = NOISE.meterNoiseOffset();
const uni = ringMesh.material.uniforms;
const cssY = parseFloat(grainOf('--sv-grain-y')) / CFG.hud.meterNoise.tilePx;
check('the ring and the gauges are at one offset',
  Math.abs(uni.uNoiseOffset.value.y - inTiles.y) < 1e-6 && Math.abs(cssY - inTiles.y) < 1e-3,
  `ring ${uni.uNoiseOffset.value.y.toFixed(4)} · css ${cssY.toFixed(4)} · clock ${inTiles.y.toFixed(4)}`);

// ...and off is OFF, which has to be a plain bar and never a black one.
CFG.hud.meterNoise.enabled = false;
runFuel(1 / 60);
check('switching it off leaves a plain bar', Number(grainOf('--sv-grain-depth')) === 0,
  grainOf('--sv-grain-depth'));
CFG.hud.meterNoise.enabled = true;

// ...and back to what ships, so nothing after this inherits a changed run.
delete player.stats.strikeChumRefill;
S.setSetting('hud.boostMeter', 'bar');
S.setSetting('hud.barPlacement', 'seal');
RING.resetStrikeRing();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
