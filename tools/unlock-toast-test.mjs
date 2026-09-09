#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:unlocktoast
//
// THE UNLOCK TOAST — the receipt for a gate popping mid-run. What it can get
// silently wrong: show nothing for a gate with a label, show two at once,
// stall the queue when one is torn down, or print a line of its own rather
// than the row's. jsdom runs no CSS animations, so the queue is advanced here
// by dispatching `animationend` by hand — which is also the one thing that
// advances it in a browser, so the harness drives the same edge the game does.
// ---------------------------------------------------------------------------
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body><div id="hud"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.HTMLElement = dom.window.HTMLElement;

// jsdom BEFORE the loader hooks, per the harness recipe.
await import('./vite-loader.mjs');
const { CONFIG } = await import('../path/src/config.js');
const toast = await import('../path/src/ui/unlockToast.js');
const { mountUnlockToasts, showUnlockToast, clearUnlockToasts, unlockToastState } = toast;
const { unlockGates, unlockProgress } = await import('../path/src/systems/unlocks.js');

const hud = document.getElementById('hud');
// feedback() needs an audio context to make a sound and quietly does not
// without one; what matters here is that the toast asks for the named voice.
const src = readFileSync(resolve(ROOT, 'path/src/ui/unlockToast.js'), 'utf8');

const shown = () => [...hud.querySelectorAll('.sv-unlock')];
const end = (node) => node.dispatchEvent(new dom.window.Event('animationend'));

section('MOUNT');
const layer = mountUnlockToasts(hud);
check('the layer is in the HUD', layer.parentNode === hud && layer.className === 'sv-unlock-layer');
check('mounting twice is one layer', mountUnlockToasts(hud) === layer && hud.querySelectorAll('.sv-unlock-layer').length === 1);
check('nothing shows before anything pops', shown().length === 0);

section('ONE POP');
const glasses = unlockProgress('dealWithIt');
check('the harness has a real gate to show', !!glasses?.label, glasses?.label);
showUnlockToast(glasses);
check('one card on screen', shown().length === 1);
check('it prints the ROW\'s line and nothing else', shown()[0].textContent.trim() === glasses.label);
check('the picture slot is there for the drawer icon', !!shown()[0].querySelector('.sv-unlock-pic'));
check('the timing comes from CONFIG.unlockToast', shown()[0].style.getPropertyValue('--sv-unlock-time') === `${CONFIG.unlockToast.time}s`
  && shown()[0].style.getPropertyValue('--sv-unlock-top') === `${CONFIG.unlockToast.top}vh`);
check('it is voiced through the feedback table, by name', /feedback\('unlock'\)/.test(src));
check('...and that name is a real feedback row', !!CONFIG.feedback?.unlock);

section('THE QUEUE');
const hat = unlockProgress('sailorHat');
const eyes = unlockProgress('laserEyes');
showUnlockToast(hat);
showUnlockToast(eyes);
check('two more pops wait their turn', shown().length === 1 && unlockToastState().queued === 2);
end(shown()[0]);
check('the animation ending brings the next one up', shown().length === 1 && shown()[0].textContent.trim() === hat.label
  && unlockToastState().queued === 1);
end(shown()[0]);
check('...and the next', shown()[0].textContent.trim() === eyes.label && unlockToastState().queued === 0);
end(shown()[0]);
check('the last one leaves and the screen is clear', shown().length === 0 && unlockToastState().showing === null);

section('WHAT IT REFUSES');
check('a gate with no label shows nothing', showUnlockToast({ kind: 'accessory', target: 'accessoryHat', label: '' }) === null && shown().length === 0);
check('null shows nothing', showUnlockToast(null) === null);
CONFIG.unlockToast.enabled = false;
check('switched off in CONFIG, nothing shows', showUnlockToast(glasses) === null && shown().length === 0);
CONFIG.unlockToast.enabled = true;

section('CLEAR');
showUnlockToast(glasses);
showUnlockToast(hat);
clearUnlockToasts();
check('a run ending drops what is up and what is waiting', shown().length === 0 && unlockToastState().queued === 0);
showUnlockToast(eyes);
check('...and the next pop still shows', shown().length === 1);
end(shown()[0]);

section('EVERY GATE CAN BE SHOWN');
for (const g of unlockGates()) {
  const p = unlockProgress(g.id);
  showUnlockToast(p);
  const ok = shown().length === 1 && shown()[0].textContent.trim() === p.label;
  check(`${g.id}`, ok, p.label);
  end(shown()[0]);
}

section('CLOCK');
check('the motion is CSS keyframes — wall clock, not the game\'s', /@keyframes sv-unlock-in/.test(src) && !/requestAnimationFrame|setTimeout/.test(src));

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
