#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:ledger:names
//
// The ledger of the buried — systems/nameLedger.js, the record that makes
// "death is permanent" a rule rather than a suggestion.
//
// FOUR WAYS A PERMADEATH RULE QUIETLY STOPS APPLYING, and all four leave the
// game working perfectly:
//
//   THE SHIFT KEY      "fat tony" is "Fat Tony" to everyone except a string
//                      comparison. A rule you can step around by holding shift
//                      is not a rule, it is a puzzle about how the check was
//                      written.
//   THE RELOAD         the graveyard is session-only on purpose; this must not
//                      be. Somebody who closes the tab has not un-died.
//   THE CAP            an evicting list hands a player's earliest names back
//                      while the table still has unused ones. Nothing is
//                      reported and nothing looks wrong.
//   THE THROW          this is called from the death path. A storage failure
//                      that escapes is a run that ends in an exception instead
//                      of a score, which costs the player the run to enforce a
//                      rule about names.
//
// Run against a jsdom localStorage rather than a stub, because three of the
// four are storage behaviour and a stub would certify whichever answer it was
// written to give.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// `url` set, or localStorage throws on the opaque origin.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const {
  buryName, buryMany, isNameBuried, buriedNames, buriedCount, clearNameLedger, nameKey,
} = await import('../path/src/systems/nameLedger.js');

section('a name dies once');
{
  clearNameLedger();
  check('an empty ledger buries nobody', !isNameBuried('Fat Tony'));
  check('burying reports that it happened', buryName('Fat Tony') === true);
  check('and the name is now buried', isNameBuried('Fat Tony'));
  check('burying twice is a no-op', buryName('Fat Tony') === false);
  check('...and does not double the record', buriedCount() === 1, String(buriedCount()));
}

section('you cannot dodge it with the shift key');
{
  clearNameLedger();
  buryName('Fat Tony');
  for (const dodge of ['fat tony', 'FAT TONY', 'FaT tOnY', '  Fat Tony  ', 'Fat  Tony']) {
    check(`"${dodge}" is the same seal`, isNameBuried(dodge));
  }
  check('but a different name is free', !isNameBuried('Fat Tonya'));
  // The SPELLING is kept, because that is what the stone says and what a list
  // of the dead should read like. Only the comparison is flattened.
  check('the record keeps the spelling that was used',
    buriedNames()[0] === 'Fat Tony', buriedNames()[0]);
  check('and the key is the flattened one', nameKey('  FaT   tOnY ') === 'fat tony',
    nameKey('  FaT   tOnY '));
}

section('blank is not a name');
{
  clearNameLedger();
  check('an empty string is never buried', !isNameBuried(''));
  check('nor is whitespace', !isNameBuried('   '));
  check('nor undefined', !isNameBuried(undefined));
  check('and burying nothing records nothing', buryName('') === false && buriedCount() === 0);
}

section('it survives the tab closing');
{
  clearNameLedger();
  buryName('Fat Tony');
  buryName('Brine');
  // A fresh module instance against the SAME storage is what a reload is. The
  // import cache is keyed on the specifier, so a query string is what forces a
  // second evaluation — the module's own in-memory copy is bypassed and it has
  // to read localStorage the way it would on a new page.
  const reloaded = await import('../path/src/systems/nameLedger.js?reload=1');
  check('a reloaded ledger still knows the dead', reloaded.isNameBuried('Fat Tony'));
  check('...all of them', reloaded.isNameBuried('brine'));
  check('...and nobody else', !reloaded.isNameBuried('Squishy Michelle'));
  check('with the record intact', reloaded.buriedCount() === 2, String(reloaded.buriedCount()));
}

section('the cap is clear of the table');
{
  clearNameLedger();
  // sealNames.csv can build about 5,700 distinct seals (68 adjectives x 84
  // nicknames, less the pairs the field is too short for, plus 28 written-out
  // names). The cap has to sit ABOVE that or a player's earliest names come
  // back into circulation while unused ones are still on the shelf.
  const many = Array.from({ length: 6000 }, (_, i) => `Seal ${i}`);
  buryMany(many);
  check('six thousand dead are all remembered', buriedCount() === 6000, String(buriedCount()));
  check('the first one is still buried', isNameBuried('Seal 0'));
  check('and so is the last', isNameBuried('Seal 5999'));
}

section('a broken record fails open, not shut');
{
  clearNameLedger();
  // Hand-edited, half-written, or from a future version. The rule quietly stops
  // applying, which is right: the alternative is a game that refuses every name
  // the player tries and cannot say why.
  localStorage.setItem('seal-survivor-buried', '{not json');
  const broken = await import('../path/src/systems/nameLedger.js?broken=1');
  check('garbage in storage does not throw', broken.buriedCount() === 0, String(broken.buriedCount()));
  check('and every name is available again', !broken.isNameBuried('Fat Tony'));
  check('burying still works afterwards', broken.buryName('Fat Tony') === true);
}

section('the death path can always finish');
{
  clearNameLedger();
  // Storage that refuses every write — a full quota, or a browser with it
  // switched off. buryName is called while a run is ending; it must not throw.
  const realSet = dom.window.localStorage.setItem.bind(dom.window.localStorage);
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  let threw = null;
  try { buryName('Fat Tony'); } catch (e) { threw = e; }
  check('a storage failure does not take the run down', threw === null, String(threw));
  check('and the rule still holds for this session', isNameBuried('Fat Tony'));
  globalThis.localStorage.setItem = realSet;
}

clearNameLedger();
console.log(failures ? `\nFAILED — ${failures} check(s)\n` : `\nPASS — all checks\n`);
process.exit(failures ? 1 : 0);
