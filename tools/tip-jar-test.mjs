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

// ---------------------------------------------------------------------------
section('WHAT A TIP BUYS — the tiers');
// ---------------------------------------------------------------------------
// The panel quotes prices and hands off to Ko-fi. Nothing in the game takes a
// payment or records one, which is exactly why the two things that CAN go
// wrong here are both about the hand-off:
//
//   A LINK THAT STOPPED BEING ONE. The jar becomes a menu when it is given
//   tiers, and the tiers themselves have to stay real anchors — a click that
//   ends in window.open several frames from the gesture is the call that
//   silently does nothing on the phone most of this game is played on.
//   A PANEL WITH NO INSTRUCTION. Ko-fi's message field IS the record. A tier
//   that opens Ko-fi without telling the player to write their name in the
//   message is a tip that arrives meaning nothing, and a refund.
{
  const { parseTipCsv } = await import('../path/src/tipTable.js');
  const { openTipSheet, closeTipSheet, tipSheetOpen } = await import('../path/src/ui/tipJar.js');
  const { readFileSync } = await import('node:fs');
  const csv = readFileSync(new URL('../path/src/tips.csv', import.meta.url), 'utf8');

  const warnings = [];
  const tiers = parseTipCsv(csv, (m) => warnings.push(m));
  check('tips.csv parses into tiers', tiers.length > 0, `${tiers.length} tier(s)`);
  check('...with nothing to complain about', warnings.length === 0, warnings.join(' | '));
  // Every one of these is a number somebody is agreeing to pay. A blank or a
  // zero on this panel is worse than a missing tier.
  check('every tier quotes a real price',
    tiers.every((t) => Number.isInteger(t.price) && t.price >= 1),
    tiers.map((t) => `$${t.price}`).join(' '));
  check('...and says what it buys', tiers.every((t) => t.label && t.desc));
  check('...and what to write on the tip', tiers.every((t) => t.tag));

  closeTipSheet();
  check('nothing is up to begin with', !tipSheetOpen());
  const sheet = openTipSheet({ tiers });
  check('the panel opens', tipSheetOpen() && !!sheet);

  const rows = [...sheet.querySelectorAll('.sv-tip-tier')];
  check('...with a row per tier', rows.length === tiers.length, `${rows.length}`);
  check('every tier is a real anchor', rows.every((r) => r.tagName === 'A'),
    rows.map((r) => r.tagName).join(' '));
  check('...pointing at the one Ko-fi page',
    rows.every((r) => r.getAttribute('href') === TIP_JAR_URL), TIP_JAR_URL);
  check('...away from the run, with no opener back',
    rows.every((r) => r.target === '_blank' && /noopener/.test(r.rel) && /noreferrer/.test(r.rel)));
  check('...and the price is on the row', rows.every((r, i) =>
    r.querySelector('.sv-tip-price').textContent === `$${tiers[i].price}`),
    rows.map((r) => r.querySelector('.sv-tip-price').textContent).join(' '));

  // THE INSTRUCTION IS THE MECHANISM. Every tag in the table has to appear in
  // it, or a tier is askable for and unsortable on arrival.
  const how = sheet.querySelector('.sv-tip-how').textContent;
  check('the panel says to write the name in the message', /message/i.test(how));
  for (const tag of new Set(tiers.map((t) => t.tag))) {
    check(`...and names the ${tag} tag`, how.includes(tag), how.replace(/\s+/g, ' ').trim());
  }

  // A press on a tier must NOT be swallowed — the navigation is the point.
  let defaulted = true;
  rows[0].addEventListener('click', (e) => { defaulted = !e.defaultPrevented; });
  rows[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  check('a press on a tier is left to navigate', defaulted);

  // The backdrop puts it down; the panel does not. Without the target check a
  // press on a tier closes the sheet on its way out, which on a phone is a
  // panel vanishing behind the tab it just opened for no visible reason.
  sheet.querySelector('.sv-tip-panel')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('a press inside the panel does not close it', tipSheetOpen());
  sheet.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('...but the backdrop does', !tipSheetOpen());

  // AND THE JAR STILL BEHAVES LIKE A LINK. A modified click is somebody who
  // has already decided where they are going; swallowing it to show a menu is
  // the link quietly becoming a button.
  const jar = tipJarLink({ tiers });
  document.body.appendChild(jar);
  const plain = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  jar.dispatchEvent(plain);
  check('a plain click on the jar opens the menu instead of navigating',
    plain.defaultPrevented && tipSheetOpen());
  closeTipSheet();
  const cmd = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
  jar.dispatchEvent(cmd);
  check('...but a cmd-click still goes straight to Ko-fi',
    !cmd.defaultPrevented && !tipSheetOpen());
  jar.remove();

  // THE 44px FLOOR REACHES THE PANEL. Every touch rule in this game keys on
  // `.sv-touch`, which lives on `.sv-ui` — and this sheet is on the body, so
  // the class has to be carried over or the rules match nothing. The close
  // button came up at 34px on a phone, on a modal, with nothing able to say so:
  // the panel is not one of npm run layout's surfaces.
  closeTipSheet();
  const ui = document.createElement('div');
  ui.className = 'sv-ui sv-touch';
  document.body.appendChild(ui);
  const touched = openTipSheet({ tiers });
  check('a touch screen carries its class onto the sheet',
    touched.classList.contains('sv-touch'), touched.className);
  ui.remove();
  closeTipSheet();
  const mouse = openTipSheet({ tiers });
  check('...and a mouse does not', !mouse.classList.contains('sv-touch'), mouse.className);
  closeTipSheet();

  // A jar with no tiers is the jar it always was.
  const bare = tipJarLink();
  const bareClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  bare.dispatchEvent(bareClick);
  check('a jar with no tiers is still a plain link',
    !bareClick.defaultPrevented && !tipSheetOpen());
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
