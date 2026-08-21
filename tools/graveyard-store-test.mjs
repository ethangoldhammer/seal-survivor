#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:yard
//
// THE GRAVEYARD ACROSS SESSIONS — systems/graveyardStore.js.
//
// A handful of stones so that opening the game shows evidence of the last few
// times you played. Not a ledger: systems/nameLedger.js is the permanent record
// and a different kind of thing entirely.
//
// THE FAILURE THIS EXISTS FOR is invisible on the machine that writes it. The
// arena is as wide as the WINDOW — bounds.right is viewHeight x aspect x
// widthScale — so a stored world x is not a position, it is a position on one
// screen. Measured: 16:9 spans -92.4 to 92.4 and an iPhone in portrait spans
// -24.0 to 24.0. Save a grave at x=60 on a laptop, open the game on a phone,
// and the stone is two and a half arena-widths outside the world. Nothing
// throws, nothing logs, the yard is just not there — and "my graveyard is gone,
// but only on my phone" is not a bug report anybody files usefully.
//
// The other three, all quiet:
//
//   THE RE-ENACTED DEATH  a restored grave filed as 'pending' drops out of the
//                         sky over the opening frames of a new run, three at
//                         once, months after the deaths happened.
//   THE PHANTOM CARD      a grave's onEtched is what puts a SCORE CARD up. A
//                         restored one has no card to release, and handing it a
//                         live callback would show one over a fresh run.
//   THE BOOT THAT THREW   read on the boot path, written while a run is ending.
//                         Neither may fail over decoration.
// ---------------------------------------------------------------------------
import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.addEventListener = () => {};

const { registerHooks } = await import('node:module');
await import('./vite-loader.mjs');

const { bounds, updateBounds } = await import('../path/src/arena.js');
const store = await import('../path/src/systems/graveyardStore.js');

// The four screens the layout audit measures, as aspect ratios.
const SCREENS = [
  ['desktop 16:9', 16 / 9],
  ['laptop 16:10', 1.6],
  ['iPad 4:3', 4 / 3],
  ['iPhone portrait', 393 / 852],
];

section('A stone comes back where it was, on any screen');
{
  store.clearGraveyardStore();
  updateBounds(16 / 9);
  const wide = bounds.right;
  // Saved on a desktop, three-quarters of the way to the right-hand wall.
  const saved = wide * 0.75;
  store.saveGraveyard([{ x: saved, z: -3.2, name: 'FAT TONY', cause: 'a shark', lead: 'eaten by', stone: 'headstone' }]);
  check('saved on a 16:9 desktop', Math.abs(saved) > 60, `x = ${saved.toFixed(1)}`);

  for (const [label, aspect] of SCREENS) {
    updateBounds(aspect);
    const [g] = store.loadGraveyard();
    const frac = g.x / bounds.right;
    check(`${label}: comes back at the same fraction of the arena`,
      Math.abs(frac - 0.75) < 0.01, `x = ${g.x.toFixed(1)} of ${bounds.right.toFixed(1)} (${frac.toFixed(3)})`);
    check(`${label}: ...and is inside the world`,
      g.x > bounds.left && g.x < bounds.right, `${g.x.toFixed(1)} in ${bounds.left.toFixed(1)}..${bounds.right.toFixed(1)}`);
  }
}

section('The rest of the inscription survives');
{
  updateBounds(16 / 9);
  const [g] = store.loadGraveyard();
  check('the name', g.name === 'FAT TONY', g.name);
  check('the cause', g.cause === 'a shark', g.cause);
  // Stored rather than re-rolled: a stone is carved and then it is carved, and
  // a headstone that reworded itself between sessions would be the one thing on
  // the seabed that changes its mind.
  check('and the lead it was actually carved with', g.lead === 'eaten by', g.lead);
  check('y is NOT stored — it is re-measured against the live seabed',
    !('y' in g), Object.keys(g).join(', '));
}

section('It forgets, which is the point');
{
  store.clearGraveyardStore();
  updateBounds(16 / 9);
  const many = Array.from({ length: 40 }, (_, i) => ({
    x: i, z: -3.2, name: `SEAL ${i}`, cause: 'a crab', lead: 'clawed by', stone: 'headstone',
  }));
  store.saveGraveyard(many);
  const back = store.loadGraveyard();
  check('a long yard is capped on disk', back.length <= 12, `${back.length} stored`);
  check('and it keeps the most recent', back[back.length - 1].name === 'SEAL 39',
    back[back.length - 1].name);
}

section('It never takes the game down');
{
  store.clearGraveyardStore();
  check('nothing stored is an empty yard, not a throw', store.loadGraveyard().length === 0);

  localStorage.setItem('seal-survivor-graveyard', '{not json');
  check('garbage reads as empty', store.loadGraveyard().length === 0);

  localStorage.setItem('seal-survivor-graveyard', JSON.stringify({ v: 99, graves: [{ fx: 0.5, name: 'X' }] }));
  check('a future version is discarded rather than half-read', store.loadGraveyard().length === 0);

  localStorage.setItem('seal-survivor-graveyard',
    JSON.stringify({ v: 1, graves: [{ fx: 'lots', name: 'NAN' }, { fx: 0.2, name: '' }, { fx: 0.3, name: 'OK' }] }));
  const mixed = store.loadGraveyard();
  check('rows with no name are dropped', mixed.every((g) => g.name), mixed.map((g) => g.name).join(', '));
  check('and a non-numeric position never becomes NaN',
    mixed.every((g) => Number.isFinite(g.x)), mixed.map((g) => g.x).join(', '));

  // Written while a run is ending. Storage that refuses must not throw.
  const real = dom.window.localStorage.setItem.bind(dom.window.localStorage);
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  let threw = null;
  try { store.saveGraveyard([{ x: 0, name: 'FULL' }]); } catch (e) { threw = e; }
  check('a full disk does not take the death down', threw === null, String(threw));
  globalThis.localStorage.setItem = real;
}

store.clearGraveyardStore();
console.log(failures ? `\nFAILED — ${failures} check(s)\n` : '\nPASS — all checks\n');
process.exit(failures ? 1 : 0);
