#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:readout
//
// THE ONLY PLACE THE GAME EVER WRITES DOWN HOW MUCH A HIT COST.
//
// Every other channel that fires when the seal is bitten is analogue — the rim
// goes red, the eyes go red, the camera shakes, the animal flinches, the mix
// thumps. All of it says SOMETHING BIT YOU and none of it says how much. The
// amount lived in exactly one place, the health bar, which is at the edge of
// the screen and is the one thing a player cannot look at during the two
// seconds it matters. A kill has had a number floating off it since the first
// build; being killed never has.
//
// Four claims, and each of them is a way the readout can be present, look
// correct in a screenshot, and still say nothing useful:
//
//   IT PRINTS THE BANKED HIT   not this frame's slice of a contact rate.
//                              systems/playerDamageFx.js accumulates a drain
//                              into something worth showing; printing the raw
//                              argument would put "-0.7" on screen sixty times
//                              a second while a shark eats you, which is a
//                              readout that is technically correct and
//                              actively worse than nothing.
//
//   A PILE-ON IS ONE NUMBER    the failure this exists to explain is several
//   THAT CLIMBS                sources landing inside a second (see
//                              CONFIG.player.damageCap). Five separate numbers
//                              stacking up the screen is exactly as unreadable
//                              as the nothing it replaced, so the live line
//                              takes the new total and re-pops. The re-pop is
//                              load-bearing: a total that changed without the
//                              line moving is the readout going quiet at the
//                              moment things got worse.
//
//   ...AND A SEPARATE MISTAKE  or the number is a run total, which is the
//   IS A SEPARATE NUMBER       health bar with extra steps. `mergeGap` is the
//                              line between one beating and two.
//
//   IT IS WHERE THE PLAYER     pinned to the seal and CLEAR of the three other
//   IS ALREADY LOOKING         lines that share that anchor — the upgrade
//                              receipt, the FOOD CHAIN banner and the STRIKE
//                              NOW! prompt. A number that has to be found
//                              before it can be read is a number nobody reads
//                              in a fight, and one drawn on top of another line
//                              is worse than one that is merely elsewhere.
//
// Plus the wiring, because every claim above is vacuous if main.js never calls
// it, and the type, because a role nothing renders is a Text panel row that
// silently controls nothing.
//
// NOTE the load order: jsdom FIRST, then the vite loader hooks, then the game
// modules. See the jsdom-harness recipe — the other way round fails with an
// error about an encoding fallback that has nothing to do with anything.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
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
const { playerDamageFx, resetPlayerDamageFx, updatePlayerDamageFx } =
  await import('../path/src/systems/playerDamageFx.js');

const R = CONFIG.fx.playerDamage.readout;
const PD = CONFIG.fx.playerDamage;
const MAX_HP = 115;

const camera = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 100);
camera.position.set(0, 0, 30);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

ui.initUI({
  onStart() {}, onRestart() {}, onLevelChoice() {},
  onResume() {}, onPauseRestart() {}, onSplash() {},
});
ui.showHud();

const lines = () => [...document.querySelectorAll('.sv-dmg')];
const only = () => lines()[0] ?? null;
// The number as printed, sign and all — parsed back out so the tests read the
// same thing a player does rather than an internal total.
const printed = () => {
  const n = only();
  return n ? Number(n.textContent.replace(/[^\d.]/g, '')) : NaN;
};
const hit = (amount) => ui.spawnDamageReadout(camera, 0, 0, amount, MAX_HP);
const idle = (seconds, hz = 60) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / hz) ui.updateToasts(1 / hz, null, null);
};
const clear = () => {
  ui.clearToasts();
  ui.resetDamageReadout();
};

// ---------------------------------------------------------------------------
section('IT PRINTS A NUMBER, AND THE NUMBER IS THE HIT');
{
  clear();
  hit(24);
  check('a hit puts a line on the layer', lines().length === 1, `${lines().length}`);
  check('...printing the amount', printed() === 24, only()?.textContent);
  // The sign is the whole label. Every other number that flies off the seal is
  // a gain and carries a '+', so this reads as the same channel running the
  // other way with no word of its own to learn — which is also why there is no
  // copy in this feature at all.
  check('...as a loss, not a gain', only()?.textContent.startsWith('-'), only()?.textContent);
  check('...with no words in it', !/[a-z]/i.test(only()?.textContent ?? 'x'), only()?.textContent);
}
{
  clear();
  // WHAT IT MUST NOT PRINT. A contact drain reaches the funnel as
  // `contactDamage * dt` — sub-1 slices, sixty a second. playerDamageFx banks
  // those and returns a size only on the frames it decides to show one, and
  // THAT is the figure this takes. Driven through the real accumulator rather
  // than asserted, because the bug is in the wiring, not in the arithmetic.
  resetPlayerDamageFx();
  const rate = 42; // the megalodon's contact damage, per second
  let printedCount = 0;
  let biggest = 0;
  for (let f = 0; f < 60; f++) {
    updatePlayerDamageFx(1 / 60);
    const shown = playerDamageFx(rate / 60, MAX_HP, { x: 0, y: 0 });
    if (shown > 0) { printedCount++; biggest = Math.max(biggest, shown); }
  }
  check('a second of being chewed is a handful of numbers, not sixty',
    printedCount > 0 && printedCount <= Math.ceil(1 / (PD.minGap ?? 0.16)),
    `${printedCount} in a second`);
  check('...and each is a readable size, not a frame-slice',
    biggest > rate / 60 * 2, `biggest ${biggest.toFixed(2)} vs a ${(rate / 60).toFixed(2)} slice`);
}

// ---------------------------------------------------------------------------
section('A PILE-ON IS ONE NUMBER THAT CLIMBS');
{
  clear();
  hit(10);
  const first = only();
  hit(15);
  hit(20);
  check('three hits in a burst are still one line', lines().length === 1, `${lines().length}`);
  check('...the same one, not a replacement', only() === first);
  check('...showing the total', printed() === 45, only()?.textContent);
  // THE RE-POP IS THE FEEDBACK. A proc receipt throttles its re-arrival because
  // the same card firing twice is not news; here the new damage IS the news, so
  // a total that changed without the line moving would be the readout going
  // quiet exactly as things got worse.
  idle(0.3);
  const aged = only().__ageProbe;
  hit(5);
  check('...and every hit replays the arrival',
    printed() === 50 && aged !== 0, `now ${only()?.textContent}`);
}
{
  clear();
  hit(10);
  // Past the merge window, so this is a different mistake and gets its own
  // number. Without this the line is a running total for the whole run, which
  // is the health bar with extra steps.
  idle((R.mergeGap ?? 0.9) + 0.1);
  hit(7);
  check('a hit after the quiet gap starts a fresh number',
    printed() === 7, only()?.textContent);
  // ...AND THE OLD ONE IS GONE. `life` is longer than `mergeGap`, so without a
  // retirement the new line is built on top of a still-live one — same anchor,
  // same offset, two numbers in one place. That is the failure the pin offset
  // exists to avoid for the other three lines on this anchor, arriving from
  // inside the feature itself.
  check('...and the one it replaces is off the screen', lines().length === 1,
    `${lines().length} on the layer`);
  check('...and it is worth having a gap at all', (R.mergeGap ?? 0) > 0, `${R.mergeGap}s`);
}
{
  clear();
  hit(10);
  // ...and a line that has expired cannot be merged into, whatever the gap
  // says. `mergeGap` longer than the motion's `life` would otherwise reach for
  // a node that is no longer on the layer.
  idle((CONFIG.textMotion.dmg?.life ?? 1.9) + 0.2);
  check('the line does eventually leave', lines().length === 0, `${lines().length}`);
  hit(3);
  check('...and the next hit builds a new one', printed() === 3, only()?.textContent);
}

// ---------------------------------------------------------------------------
section('IT IS WHERE THE PLAYER IS ALREADY LOOKING');
{
  clear();
  hit(20);
  check('the line follows the seal rather than the water it was bitten in',
    R.pin !== false, `pin ${R.pin}`);
  // CLEAR OF THE OTHER THREE. That anchor already carries the upgrade receipt,
  // the chain banner and the STRIKE NOW! prompt. Drawn on top of one of them
  // this is worse than being elsewhere — two lines in one place is neither
  // line. The direction matters as much as the distance: damage belongs ABOVE
  // the stack, because it is the one that means the run is in trouble.
  check('...and clear of the three lines that share that anchor',
    Math.abs(R.pinOffset ?? 0) >= 20, `${R.pinOffset}px`);
  check('...above them, not below', (R.pinOffset ?? 0) < 0, `${R.pinOffset}px`);
}
{
  clear();
  // THE COLOUR RAMP runs from the role's own colour to `colorHot`, so a big hit
  // does not look like a graze. Read off the rendered element, because the
  // failure worth catching is the inline write not happening at all.
  hit(MAX_HP * 0.01);
  const cold = only().style.color;
  clear();
  hit(MAX_HP * (R.hotAt ?? 0.25));
  const hot = only().style.color;
  check('a big hit is a different colour from a graze', cold !== hot, `${cold} vs ${hot}`);
  check('...and both are actually written to the element', !!cold && !!hot);
  // The bottom of the ramp is the ROLE's colour, so dragging the type's colour
  // in the Text panel moves it. Pinned to a constant here instead, the panel
  // would appear to do nothing to every hit but the biggest.
  const roleHex = `#${(CONFIG.textStyles?.dmg?.color ?? 0).toString(16).padStart(6, '0')}`;
  clear();
  hit(0.001);
  const dm = /rgb\((\d+), (\d+), (\d+)\)/.exec(only().style.color);
  const asHex = dm ? `#${[dm[1], dm[2], dm[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}` : '';
  check('the coldest hit is the Text panel role\'s own colour',
    asHex === roleHex, `${asHex} vs ${roleHex}`);
}

// ---------------------------------------------------------------------------
section('THE TYPE AND THE MOTION ARE DESIGNABLE');
{
  const roles = fs.readFileSync(path.join(HERE, '../path/src/textRoles.js'), 'utf8');
  check('there is a Text panel role for it', /selector: '\.sv-dmg'/.test(roles));
  check('...pointing at the motion block', /key: 'dmg'[\s\S]{0,400}motion: 'dmg'/.test(roles));
  check('...and the motion block exists', !!CONFIG.textMotion.dmg);
  // Longer than the upgrade receipt's, which is the longest of the others. This
  // is the only place the amount exists and a merged line has to survive the
  // whole burst it is totalling.
  check('...and holds longer than an upgrade receipt',
    (CONFIG.textMotion.dmg.life ?? 0) > (CONFIG.textMotion.proc.life ?? 0),
    `${CONFIG.textMotion.dmg.life}s vs ${CONFIG.textMotion.proc.life}s`);
  // It arrives into a red rim, a shaking camera and a flinching animal. A
  // receipt's pop disappears into that.
  check('...and arrives harder than one',
    (CONFIG.textMotion.dmg.in?.scale ?? 0) > (CONFIG.textMotion.proc.in?.scale ?? 0),
    `${CONFIG.textMotion.dmg.in?.scale} vs ${CONFIG.textMotion.proc.in?.scale}`);
  const css = fs.readFileSync(path.join(HERE, '../path/src/ui/ui.js'), 'utf8');
  check('the class is in the shipped stylesheet', /\.sv-dmg \{/.test(css));
  // No colour in the CSS: it is written inline per hit, and a rule here would
  // be a second answer that wins on the frames before the ramp runs.
  const rule = /\.sv-dmg \{[^}]*\}/.exec(css)?.[0] ?? '';
  check('...with no colour in it, because the ramp owns that',
    !/(^|[^-])color:/.test(rule));
}

// ---------------------------------------------------------------------------
section('WIRING — main.js actually calls it');
{
  const main = fs.readFileSync(path.join(HERE, '../path/src/main.js'), 'utf8');
  check('main.js imports the readout', /spawnDamageReadout/.test(main));
  // THE BANKED FIGURE, not the raw argument. This is the claim the whole first
  // section is about, checked at the one place it can actually go wrong.
  check('...and hands it the banked hit, not the frame-slice',
    /spawnDamageReadout\(\s*[\s\S]{0,200}?\bshown,/.test(main), 'shown');
  check('...against the CURRENT bar, so the ramp means the same thing all run',
    /spawnDamageReadout\(\s*[\s\S]{0,240}?player\.stats\.maxHp/.test(main));
  check('a fresh run clears the running total', /resetDamageReadout\(\)/.test(main));
}

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll damage-readout checks passed.\n');
process.exit(failures ? 1 : 0);
