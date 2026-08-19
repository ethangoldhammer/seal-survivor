#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tipjar
//
// The tip jar, on all three screens it appears on, driven through the real
// module in jsdom.
//
// The pause menu's and the score card's copies are already walked by their own
// suites (test:pause, test:scoretabs) — what those cannot reach is the SPLASH
// one, because mounting the real splash means booting Rive's WASM. So this
// tests the piece that sits between them: ui/tipJar.js itself, and in
// particular the one thing about the splash copy that is not obvious.
//
// THE FAILURE THIS EXISTS FOR. The splash wrapper listens for pointerup, and
// on that event it either hands the keyboard to the name field or — on a bad
// export, where the artboard has no `tStart` — STARTS THE RUN. A tip link that
// let the gesture bubble would be a player tapping the jar and watching the
// game begin behind the tab that just opened. It is silent in every other way:
// the link works, the URL is right, the tab opens. Nothing logs.
//
// The second silent one is the href. A `target="_blank"` with no `rel` hands
// the opened page a live `window.opener` back into the game, and a link that
// lost its `https://` is a relative path that navigates the run away.
//
// NOTE the load order: jsdom first, then the module. See the jsdom-harness
// recipe — the other way round fails with an encoding error that has nothing
// to do with anything.
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
globalThis.HTMLElement = dom.window.HTMLElement;

const { tipJarLink, mountSplashTipJar, TIP_JAR_URL } = await import('../path/src/ui/tipJar.js');

section('The link itself');
{
  const a = tipJarLink();
  check('it is an anchor, not a button pretending', a.tagName === 'A', a.tagName);
  // Absolute, and https. A relative href here navigates the RUN to a path on
  // the game's own domain — the tab opens, it is just the wrong page, and
  // "the tip jar opens a 404" is not something a player reports.
  check('the href is absolute and https', /^https:\/\/\S+$/.test(a.getAttribute('href')),
    a.getAttribute('href'));
  check('...and it is the one constant', a.getAttribute('href') === TIP_JAR_URL, TIP_JAR_URL);
  check('it opens away from the run', a.target === '_blank', a.target);
  // noopener is the one that matters: without it the opened page holds a live
  // reference back into the game's window.
  check('...without handing the page an opener', (a.rel || '').includes('noopener'), a.rel);
  check('it says what it is, to a screen reader too',
    !!a.getAttribute('aria-label') && a.textContent.trim().length > 0,
    `${a.getAttribute('aria-label')} / "${a.textContent.trim()}"`);
  check('the styles came with it', !!document.querySelector('style[data-sv-tip]'));

  // Called once, however many links get built — three surfaces, one sheet.
  tipJarLink();
  tipJarLink();
  check('...once, not once per link', document.querySelectorAll('style[data-sv-tip]').length === 1,
    `${document.querySelectorAll('style[data-sv-tip]').length} sheet(s)`);
}

section('The hooks the menus hang sound on');
{
  let hovers = 0;
  let clicks = 0;
  const a = tipJarLink({ onHover: () => hovers++, onClick: () => clicks++ });
  document.body.appendChild(a);
  a.dispatchEvent(new dom.window.Event('pointerenter'));
  // Not `a.click()`: that would follow the href, which jsdom logs a "not
  // implemented" for. The listener is what is under test.
  a.dispatchEvent(new dom.window.Event('click'));
  check('hover reaches the caller', hovers === 1, String(hovers));
  check('click reaches the caller', clicks === 1, String(clicks));
  a.remove();
}

section('THE SPLASH COPY — the gesture stops at the jar');
{
  // The wrapper, as riveSplash.js builds it: one listener for pointerup that
  // in the real thing focuses the name field, and on the fallback path ends
  // the splash entirely.
  const wrap = document.createElement('div');
  document.body.appendChild(wrap);
  let wrapSaw = 0;
  for (const type of ['pointerdown', 'pointerup', 'pointermove']) {
    wrap.addEventListener(type, () => wrapSaw++);
  }

  const jar = mountSplashTipJar(wrap);
  check('the jar is inside the splash wrapper', jar.parentNode === wrap);
  check('...positioned as the splash copy', jar.classList.contains('sv-tip-splash'),
    jar.className);

  for (const type of ['pointerdown', 'pointerup', 'pointermove']) {
    jar.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  }
  check('no pointer event on the jar reaches the splash', wrapSaw === 0,
    `${wrapSaw} of 3 got through`);

  // The wrapper's own listeners must still be live — a swallow implemented as
  // "stop listening" would pass the check above and break the name field.
  wrap.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true }));
  check('...but a tap on the splash itself still does', wrapSaw === 1, String(wrapSaw));
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
