#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:nametag
//
// THE NAME CARD BESIDE THE SEAL on the main menu (ui/nameTag.js) — what the
// artboard is told, where the box lands, and that Play actually gets rid of it.
//
// The menu itself cannot run here (it wants a GL context and the loaded seal),
// so this drives the module the menu drives, with the numbers the menu hands
// it. What the artboard DRAWS was established in a browser; nothing here can
// re-check that. What is here is every failure that would be silent:
//
//   THE PLACEHOLDER SHIPS     `autoBind` off, or the name written before the
//                             load, and the card draws the editor's own text.
//   A BOX WITH NO SHAPE       the tag is sized off the bust, so a wrong axis
//                             is a card the height of the screen or a sliver.
//   OFF THE PHONE             portrait frames the seal edge to edge; a tag
//                             that does not shrink hangs off the right side.
//   IT NEVER LEAVES           Play starts the fly; a fly that stops short, or
//                             one that keeps the runtime drawing after it is
//                             gone, is an 800x501 artboard rendered behind
//                             the whole run.
//   A LOAD FAILURE SHOWS      the menu must carry on with no card, and every
//                             call on the handle has to stay safe.
//   A SLIDER POINTING NOWHERE  the tuner rows are paths into CONFIG; one that
//                             names a key nobody ships renders a dead row.
//
// NOTE the load order: jsdom first, then the loader hooks, then the modules.
// See the jsdom-harness recipe.
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
globalThis.HTMLElement = dom.window.HTMLElement;
const rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
const drainRaf = () => { const q = rafQueue.splice(0); for (const fn of q) fn(0); };

// ---------------------------------------------------------------------------
// A Rive runtime under our control — the boss-bar stub, cut down to what this
// surface uses. It holds onLoad until released, can be told to fail, and
// records every write.
// ---------------------------------------------------------------------------
const riveLog = { built: [], writes: [], played: 0, paused: 0, resized: 0, cleaned: 0 };
globalThis.__riveLog = riveLog;
globalThis.__riveControl = {
  mode: 'ok', // 'ok' | 'error' | 'no-vm' | 'no-prop'
  pending: [],
  release() { const q = this.pending.splice(0); for (const fire of q) fire(); },
};

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return {
        format: 'module', shortCircuit: true, source: `
const L = globalThis.__riveLog;
const C = globalThis.__riveControl;
function prop(name) {
  let v = 'text';
  return { get value() { return v; }, set value(x) { v = x; L.writes.push([name, x]); } };
}
export class Rive {
  constructor(opts) {
    L.built.push(opts);
    this.opts = opts;
    this.stateMachineNames = ['State Machine 1'];
    const vmi = {
      _s: { strPlayerName: prop('strPlayerName') },
      string(n) { return C.mode === 'no-prop' ? null : (this._s[n] ?? null); },
      number() { return null; },
      trigger() { return null; },
    };
    this.viewModelInstance = C.mode === 'no-vm' ? null : vmi;
    C.pending.push(() => {
      if (C.mode === 'error') opts.onLoadError?.('stubbed failure');
      else opts.onLoad?.();
    });
  }
  resizeDrawingSurfaceToCanvas() { L.resized++; }
  play(name) { L.played++; L.playedName = name; }
  pause() { L.paused++; }
  cleanup() { L.cleaned++; }
}
export const Layout = class { constructor(o) { this.o = o; } };
export const Fit = { Contain: 'contain', Layout: 'layout' };
export const Alignment = { Center: 'center' };
export const RuntimeLoader = { setWasmUrl(u) { L.wasmUrl = u; } };
`,
      };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub-asset";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

const { mountNameTag, NAMETAG_ASPECT } = await import('../path/src/ui/nameTag.js');
const { NAMETAG_ARTBOARD, riveRequirements } = await import('../path/src/ui/riveContract.js');
const { CONFIG } = await import('../path/src/config.js');

const px = (s) => Number.parseFloat(s);
const translateX = (el) => Number.parseFloat(/translate\(([-\d.]+)px/.exec(el.style.transform)?.[1] ?? 'NaN');
const lastWrite = (name) => [...riveLog.writes].reverse().find((w) => w[0] === name)?.[1];
const C = globalThis.__riveControl;

// The numbers the menu hands over on a laptop: a bust 420px tall whose right
// edge is at x 700, bottom at y 640, in a 1280-wide viewport.
const laptop = { x: 700, yBottom: 640, bustHeight: 420, viewportW: 1280, fade: 1 };

// ---------------------------------------------------------------------------
section('THE CONTRACT — the artboard is required of the shipped file');
// ---------------------------------------------------------------------------
check('the config ships the tag on', CONFIG.splashBust?.nametag?.enabled === true);
check(`riveRequirements lists "${NAMETAG_ARTBOARD}"`, riveRequirements().artboards.includes(NAMETAG_ARTBOARD));
{
  const { readFileSync } = await import('node:fs');
  const riv = readFileSync(new URL('../path/src/ui/seal_survivor.riv', import.meta.url)).toString('latin1');
  // The image inside it is named NAMETAG_Small, so a bare includes() would
  // pass on an export that lost the artboard and kept the asset. The artboard
  // name is stored as its own string, so look for it followed by a byte that
  // is not part of a longer name.
  check('the shipped file has the artboard itself, not just its image',
    /NAMETAG(?![_A-Za-z0-9 ])/.test(riv));
}

// ---------------------------------------------------------------------------
section('THE MOUNT — bound, named once, and hidden until it has drawn');
// ---------------------------------------------------------------------------
const parent = document.createElement('div');
document.body.appendChild(parent);
const tag = mountNameTag({ parent, name: 'Ethan', cfg: CONFIG.splashBust.nametag });
check('a handle comes back', !!tag);
check('the element is in the parent', parent.contains(tag.el));
check('...and takes no pointer events', tag.el.style.pointerEvents === 'none');
const built = riveLog.built.at(-1);
check(`it asks for the "${NAMETAG_ARTBOARD}" artboard`, built?.artboard === NAMETAG_ARTBOARD, built?.artboard);
check('autoBind is on (or the name write is a no-op)', built?.autoBind === true);
check('autoplay is off (the state machine is played once bound)', built?.autoplay === false);
check('it is not live while loading', tag.live === false);
check('the name is not written before the load', lastWrite('strPlayerName') === undefined);
tag.place(laptop);
check('placed while loading, it stays invisible', tag.el.style.opacity === '0', tag.el.style.opacity);

C.release();
check('live once loaded', tag.live === true);
check('the name is written exactly once', riveLog.writes.filter((w) => w[0] === 'strPlayerName').length === 1);
check('...and it is the player\'s', lastWrite('strPlayerName') === 'Ethan', String(lastWrite('strPlayerName')));
check('the state machine is played', riveLog.played === 1 && riveLog.playedName === 'State Machine 1');
// THE BACKING STORE IS FIXED, not the CSS box times the DPR. The runtime lays
// the artboard out in canvas.width/height, so setting those once at
// construction is the whole of the sizing — there is no resize handler and the
// 0x0 trap the boss bar guards against cannot happen.
check('the canvas is the configured surface across', tag.canvas.width === CONFIG.splashBust.nametag.surface, String(tag.canvas.width));
check('...and the artboard\'s aspect tall', Math.abs(tag.canvas.height - tag.canvas.width / NAMETAG_ASPECT) <= 1, String(tag.canvas.height));
check('the CSS box is never used to size it', riveLog.resized === 0, String(riveLog.resized));
drainRaf();
check('visible now', tag.el.style.opacity === '1', tag.el.style.opacity);
check('the handle exposes the canvas it draws into', tag.canvas instanceof dom.window.HTMLCanvasElement);

// ---------------------------------------------------------------------------
section('THE BOX — a shape of the bust, to its right');
// ---------------------------------------------------------------------------
tag.place(laptop);
const o = CONFIG.splashBust.nametag;
const wantH = laptop.bustHeight * o.height;
check('the height is a fraction of the bust', Math.abs(px(tag.el.style.height) - wantH) < 0.2, tag.el.style.height);
check('the width follows the artboard\'s aspect',
  Math.abs(px(tag.el.style.width) - wantH * NAMETAG_ASPECT) < 0.2, tag.el.style.width);
check('it starts right of the bust, past the gap',
  Math.abs(px(tag.el.style.left) - (laptop.x + laptop.bustHeight * o.gap)) < 0.2, tag.el.style.left);
check('its centre sits on the bust at `y`',
  Math.abs(px(tag.el.style.top) - (laptop.yBottom - laptop.bustHeight * o.y)) < 0.2, tag.el.style.top);
check('...anchored at that centre', /-50%\)$/.test(tag.el.style.transform), tag.el.style.transform);
check('not flying', translateX(tag.el) === 0);
check('a fade from the menu is its opacity while held', (tag.place({ ...laptop, fade: 0.4 }), tag.el.style.opacity === '0.4'), tag.el.style.opacity);
tag.place(laptop);

// A phone held upright: the bust's right edge is 40px from the screen's.
const phone = { x: 335, yBottom: 500, bustHeight: 300, viewportW: 375, fade: 1 };
tag.place(phone);
const right = px(tag.el.style.left) + px(tag.el.style.width);
check('on a phone it shrinks to stay on screen', right <= phone.viewportW - o.margin + 0.2, `right edge ${right.toFixed(1)} of ${phone.viewportW}`);
check('...keeping its aspect', Math.abs(px(tag.el.style.width) / px(tag.el.style.height) - NAMETAG_ASPECT) < 0.01);
check('...and never goes negative', px(tag.el.style.width) >= 0 && px(tag.el.style.height) >= 0);
tag.place(laptop);

// ---------------------------------------------------------------------------
section('PLAY — off to the right, then off');
// ---------------------------------------------------------------------------
const paused0 = riveLog.paused;
tag.flyOut();
check('the phase is out', tag.phase === 'out');
check('no jump on the frame Play is pressed', translateX(tag.el) === 0, tag.el.style.transform);
tag.update(o.flyTime * 0.5);
const mid = translateX(tag.el);
check('half way through it has moved right', mid > 0, `${mid.toFixed(1)}px`);
check('...but is not yet off screen', px(tag.el.style.left) + mid < laptop.viewportW, `${(px(tag.el.style.left) + mid).toFixed(1)}`);
check('placing while flying is refused (the camera is moving under it)',
  (tag.place({ ...laptop, x: 100 }), Math.abs(px(tag.el.style.left) - (laptop.x + laptop.bustHeight * o.gap)) < 0.2), tag.el.style.left);
check('still drawing mid-fly', riveLog.paused === paused0);
tag.update(o.flyTime * 0.5 + 0.01);
check('gone at the end of flyTime', tag.phase === 'gone');
const end = px(tag.el.style.left) + translateX(tag.el);
check('...fully past the right edge', end >= laptop.viewportW, `${end.toFixed(1)} vs ${laptop.viewportW}`);
check('...hidden', tag.el.style.display === 'none');
check('...and the runtime paused, not left drawing', riveLog.paused === paused0 + 1, String(riveLog.paused));
check('a second flyOut does nothing', (tag.flyOut(), tag.phase === 'gone'));

const cleaned0 = riveLog.cleaned;
tag.dispose();
check('dispose frees the runtime', riveLog.cleaned === cleaned0 + 1);
check('...and removes the element', !parent.contains(tag.el));
check('...and reports not live', tag.live === false);
check('dispose twice is safe', (tag.dispose(), riveLog.cleaned === cleaned0 + 1));

// ---------------------------------------------------------------------------
section('THE MENU\'S SIDE — what mainMenu.js does with the handle');
// ---------------------------------------------------------------------------
// Read out of the source, the way test:menu reads the z-index rule: mounting
// the real menu needs a GL context and the loaded seal.
{
  const { readFileSync } = await import('node:fs');
  const menuSrc = readFileSync(new URL('../path/src/systems/mainMenu.js', import.meta.url), 'utf8');
  check('the menu mounts it with the player\'s name', /mountNameTag\(\{[^}]*name:\s*playerName\(\)/.test(menuSrc));
  check('...into the label layer, which leaves with the menu', /mountNameTag\(\{\s*parent:\s*labelLayer/.test(menuSrc));
  check('release() flies it out', /release\(\)\s*\{[\s\S]*?tag\?\.flyOut\(\)/.test(menuSrc));
  check('tidy() disposes it before the layer is removed',
    /tag\?\.dispose\(\);[\s\S]{0,200}labelLayer\.remove\(\)/.test(menuSrc));
  check('update() ticks it', /tag\?\.update\(dt\)/.test(menuSrc));
  check('it is only placed while held', /tag\.phase === 'held'/.test(menuSrc));
}

// ---------------------------------------------------------------------------
section('FAILURE — the menu carries on with no card');
// ---------------------------------------------------------------------------
for (const mode of ['error', 'no-vm', 'no-prop']) {
  C.mode = mode;
  const p = document.createElement('div');
  document.body.appendChild(p);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  const t = mountNameTag({ parent: p, name: 'Ethan', cfg: CONFIG.splashBust.nametag });
  C.release();
  console.warn = origWarn;
  check(`[${mode}] not live`, t.live === false);
  check(`[${mode}] the element is gone`, !p.contains(t.el));
  check(`[${mode}] it said so once`, warnings.length === 1, warnings.join(' | '));
  let threw = false;
  try { t.place(laptop); t.flyOut(); t.update(1); t.dispose(); } catch (e) { threw = e; }
  check(`[${mode}] every call is still safe`, !threw, threw && threw.message);
}
C.mode = 'ok';

// Disabled in config, and a missing parent: nothing is built at all.
const builtBefore = riveLog.built.length;
check('disabled builds nothing', mountNameTag({ parent, name: 'x', cfg: { enabled: false } }) === null && riveLog.built.length === builtBefore);
check('no parent builds nothing', mountNameTag({ name: 'x' }) === null && riveLog.built.length === builtBefore);
// Torn down mid-load: the late onLoad must not resurrect it.
{
  const p = document.createElement('div');
  document.body.appendChild(p);
  const t = mountNameTag({ parent: p, name: 'Ethan', cfg: CONFIG.splashBust.nametag });
  const cleaned = riveLog.cleaned;
  t.dispose();
  C.release();
  check('disposed before the load: not live afterwards', t.live === false);
  check('...and the late runtime is cleaned up', riveLog.cleaned >= cleaned + 1);
  check('...with no name written into nothing', !p.contains(t.el));
}

// ---------------------------------------------------------------------------
section('THE TUNER — every slider points at something that exists');
// ---------------------------------------------------------------------------
// There is no group for a name ON the seal, and that is deliberate: a mark on
// the animal is a UV-space blend in the shader already injected into its
// material, not offsets on a quad. See design/NAME-ON-THE-SEAL.md — and this
// check is what stops a slider group for it being re-added without one.
{
  const { TUNER_SCHEMA } = await import('../path/src/config.js');
  const group = TUNER_SCHEMA.find((g) => g.group === 'Main menu: name tag');
  check('the tuner has a group for the card', !!group);
  for (const item of group?.items ?? []) {
    const val = item.path.split('.').reduce((o, k) => o?.[k], CONFIG);
    check(`...and ${item.path} exists in CONFIG`, val !== undefined, String(val));
  }
  const stale = (group?.items ?? []).filter((i) => /\.decal\./.test(i.path));
  check('no rows for a decal that is not built', stale.length === 0, stale.map((i) => i.path).join(', '));
  const { readFileSync } = await import('node:fs');
  const menuSrc = readFileSync(new URL('../path/src/systems/mainMenu.js', import.meta.url), 'utf8');
  check('the menu holds no decal either', !/nameDecal|createNameDecal/.test(menuSrc));
  check('...and the note it points at is on disk',
    readFileSync(new URL('../design/NAME-ON-THE-SEAL.md', import.meta.url), 'utf8').length > 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
