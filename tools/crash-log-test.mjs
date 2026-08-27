#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:crashlog
//
// systems/crashLog.js — the breadcrumb trail that says what the page was doing
// when it stopped. Driven with a fake storage and a fake event target rather
// than jsdom: nothing in that module touches the DOM, and a harness that
// cannot simulate a process being killed would be testing the wrong thing.
//
// THE THREE READINGS THAT MUST NOT BLUR INTO EACH OTHER:
//
//   CLEAN     the page said goodbye. Every reload and every normal app close
//             lands here, and a version of this that called those crashes
//             would bury the real ones under a report per launch.
//   CUT       the record was left open — nothing ran after the last
//             breadcrumb. This is the WebContent process being killed, which
//             is the failure with NO other trace anywhere on the device.
//   ERROR     something threw. The message is the answer, and the breadcrumb
//             is only the context.
//
// A cut in the BACKGROUND is its own reading, because iOS reclaims a
// backgrounded web view as a matter of routine and that is not a bug.
// ---------------------------------------------------------------------------

import { verdictFor, mark, initCrashLog, crashReports, __resetCrashLog } from '../path/src/systems/crashLog.js';
import { describeReport } from './crash-pull.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// A storage that behaves like localStorage and nothing else — the module is
// only ever allowed to need getItem and setItem.
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map),
  };
}

// A target that records its listeners so the test can fire them, and whose
// setInterval does nothing — the flush timer must never hold the process open.
function fakeTarget(visibility = 'visible') {
  const on = new Map();
  const doc = {
    get visibilityState() { return doc._v; },
    _v: visibility,
    addEventListener: (t, fn) => on.set(`doc:${t}`, fn),
  };
  return {
    document: doc,
    addEventListener: (t, fn) => on.set(t, fn),
    setInterval: () => 0,
    fire: (t, e) => on.get(t)?.(e),
    has: (t) => on.has(t),
  };
}

// ---------------------------------------------------------------------------
section('THE VERDICT');

check('a session that said goodbye is clean',
  verdictFor({ open: false, crumbs: [{ t: 100, tag: 'run:start' }] })?.kind === 'clean');
check('a session left open was cut off',
  verdictFor({ open: true, crumbs: [{ t: 100, tag: 'shot:capture' }] })?.kind === 'cut');
check('...and it names the breadcrumb it never got past',
  verdictFor({ open: true, crumbs: [{ t: 100, tag: 'shot:capture' }] })?.tag === 'shot:capture');
check('a thrown error outranks the open record',
  verdictFor({ open: true, err: { msg: 'boom' }, crumbs: [{ t: 1, tag: 'boot' }] })?.kind === 'error');
check('a cut in the background is not a crash',
  verdictFor({ open: true, hidden: true, crumbs: [{ t: 1, tag: 'app:hidden' }] })?.kind === 'cut-bg');
check('nothing kept is no verdict at all', verdictFor(null) === null);
{
  const v = verdictFor({ open: true, crumbs: [{ t: 12_345, tag: 'x' }] });
  check('how long it had been up is seconds, not milliseconds', v.upSeconds === 12.3, `${v.upSeconds}s`);
}

// ---------------------------------------------------------------------------
section('THE TRAIL');

__resetCrashLog();
const store = fakeStorage();
let target = fakeTarget();
check('a first launch has nothing to report', initCrashLog({ storage: store, target }) === null);
mark('run:start');
mark('boss:defeated', 1);
mark('shot:capture');
{
  const kept = JSON.parse(store.dump()['sv.crash.v1']);
  check('the trail is on disk before anything asks for it',
    kept.crumbs.at(-1)?.tag === 'shot:capture', kept.crumbs.map((c) => c.tag).join(' → '));
  check('...and it is still open, because this session has not ended', kept.open === true);
  check('a breadcrumb can carry a number', kept.crumbs.find((c) => c.tag === 'boss:defeated')?.d === 1);
}

// THE KILL. No pagehide, no error, no anything — the module simply stops
// existing, which is what a WebContent process being killed looks like from
// inside the page. Only the storage survives into the next launch.
__resetCrashLog();
target = fakeTarget();
{
  const prev = initCrashLog({ storage: store, target });
  check('the next launch knows the last one was cut off', prev?.kind === 'cut', prev?.kind);
  check('...and says where it stopped', prev?.tag === 'shot:capture', prev?.tag);
  check('the report is kept, not just printed', crashReports().length === 1);
  check('the new session starts its own clean trail',
    JSON.parse(store.dump()['sv.crash.v1']).crumbs.at(-1)?.tag === 'boot');
}

// ---------------------------------------------------------------------------
section('A THROW, AND A GOODBYE');

mark('run:start');
target.fire('error', { error: new Error('cannot read properties of null') });
{
  const kept = JSON.parse(store.dump()['sv.crash.v1']);
  check('the message is written the moment it lands', kept.err?.msg?.includes('cannot read properties'));
  check('...with the top of the stack beside it', typeof kept.err?.at === 'string' && kept.err.at.length > 0);
}
target.fire('pagehide');
check('a goodbye closes the record', JSON.parse(store.dump()['sv.crash.v1']).open === false);

__resetCrashLog();
{
  const prev = initCrashLog({ storage: store, target: fakeTarget() });
  check('an ending with an error in it reads as an error, not a cut', prev?.kind === 'error', prev?.kind);
  check('both endings are kept, oldest first', crashReports().length === 2);
}

// ---------------------------------------------------------------------------
section('WHAT IT PRINTS');
{
  const line = describeReport(crashReports().at(-1));
  check('the printed report names the ending', /error/.test(line));
  check('...and shows the trail that led to it', /boot → run:start/.test(line), line.split('\n')[2]?.trim());
}

// ---------------------------------------------------------------------------
section('WHEN THERE IS NOWHERE TO WRITE');
__resetCrashLog();
check('no storage is not a crash of its own', initCrashLog({ storage: null, target: fakeTarget() }) === null);
mark('run:start'); // must not throw with no session

console.log(failures ? `\nFAIL — ${failures} check(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
