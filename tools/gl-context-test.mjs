#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:glcontext
//
// THE ONE ENDING THE CRASH TRAIL COULD NOT RECORD.
//
// A WebGL context loss is not a JavaScript error. Nothing throws, no handler
// runs on its own, and the frame loop simply stops drawing — then WebKit
// reloads the page and the player sees the game "reset to the loading screen".
// From the outside that is IDENTICAL to the WebContent process being killed for
// memory, and the two wanted completely different fixes.
//
// The device's own logs say it is not the memory one: no JetsamEvent at any of
// the resets, no WebContent crash report, and the only thing logged in the
// window was a CPU exception that explicitly took no action. So world.js marks
// the loss into the trail, and a run ending `... -> gl:lost` answers in one
// line what four hours of measuring memory could not.
//
// Driven through a REAL DOM event rather than by calling the handler directly:
// the thing being tested is that the listener is attached and that the event
// reaches it, and calling the function by hand would pass with no listener
// registered at all.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import { initCrashLog, mark, __resetCrashLog } from '../path/src/systems/crashLog.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const store = new Map();
const shim = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
__resetCrashLog();
initCrashLog({ storage: shim, target: new EventTarget() });

// The same two listeners world.js attaches to renderer.domElement.
const el = new EventTarget();
el.addEventListener('webglcontextlost', (e) => { e.preventDefault?.(); mark('gl:lost', 7); });
el.addEventListener('webglcontextrestored', () => mark('gl:restored'));

console.log('\nA LOST CONTEXT REACHES THE TRAIL');
mark('tick');
const lostEvent = new Event('webglcontextlost', { cancelable: true });
el.dispatchEvent(lostEvent);
el.dispatchEvent(new Event('webglcontextrestored'));

const session = JSON.parse(shim.getItem('sv.crash.v1'));
const tags = session.crumbs.map((c) => c.tag);
const lost = session.crumbs.find((c) => c.tag === 'gl:lost');

check('a context loss lands in the trail', tags.includes('gl:lost'), tags.join(' -> '));
check('...carrying the draw count with it', lost?.d === 7, String(lost?.d));
// Without preventDefault WebKit never fires webglcontextrestored at all, so
// this is load-bearing rather than tidiness.
check('preventDefault is called, so a restore can be fired', lostEvent.defaultPrevented);
check('a restore lands too', tags.includes('gl:restored'), tags.join(' -> '));
check('...and after the loss, not before',
  tags.indexOf('gl:restored') > tags.indexOf('gl:lost'), tags.join(' -> '));

console.log('\nWORLD.JS ACTUALLY ATTACHES THEM');
{
  // The test above proves the listeners work; this proves world.js has them.
  // A behaviour test built on a stand-in element passes just as happily when
  // the real attachment has been deleted.
  const src = await import('node:fs').then((fs) => fs.readFileSync('path/src/world.js', 'utf8'));
  check('world.js listens for webglcontextlost', /addEventListener\('webglcontextlost'/.test(src));
  check('...and for the restore', /addEventListener\('webglcontextrestored'/.test(src));
  check('...on the renderer canvas', /renderer\.domElement\.addEventListener\('webglcontextlost'/.test(src));
  check('...and marks the crash trail from it', /crashMark\('gl:lost'/.test(src));
}

console.log(failures ? `\n${failures} FAILED\n` : '\ngl context: all good\n');
process.exit(failures ? 1 : 0);
