#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:accessorysave
//
// What the accessory lab's save button does to config.js and to the tuning
// snapshot — tools/apply-accessories.mjs.
//
// A tool that EDITS THE SOURCE FILE the game boots from has one failure that
// outranks every other: leaving config.js unparseable. The shader lab's splicer
// did exactly that once (a value span that ran into the closing brace, so a
// replace-the-last-field-and-add-after-it produced `wet: 1.2 wetSteps: 3`), and
// the tests it had covered those two operations separately. This shares that
// splicer, so the shape is covered there — what is covered HERE is everything
// this file adds on top of it:
//
//   NESTING     `accessories.items.<key>` is two levels down, and `items` is a
//               common enough name that the wrong block is a real outcome. The
//               fixture puts a decoy `items: {` in a neighbouring root.
//   SCOPE       only the fields the lab says moved, and only for the accessory
//               it names — a save on the glasses must not touch the hat.
//   PROSE       every number in that block has a paragraph above it arguing for
//               it. The splice has to leave the words standing and SAY that they
//               are now stale.
//   THE CLEAR   saved tuning outranks config.js, so a write that does not also
//               delete from imported-tuning.json is a button that does nothing
//               visible. It has to take exactly its own leaves and leave a file
//               full of somebody else's tuning alone.
//
// Everything runs against fixtures in a temp directory — nothing here can reach
// the real config.js or the real snapshot.
// ---------------------------------------------------------------------------
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'accessory-apply-test-'));

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const CONFIG_FIXTURE = join(dir, 'config.js');
const TUNING_FIXTURE = join(dir, 'imported-tuning.json');

// The module under test, with its two file paths pointed at the fixtures and
// the dev-server guard stubbed out. The guard would otherwise refuse every
// write below whenever the game happens to be up, which would turn this file
// into a test that passes by not running; it has its own reason to exist and is
// not what is under test here.
const src = await readFile(resolve(HERE, 'apply-accessories.mjs'), 'utf8');
const mod = join(dir, 'apply.mjs');
await writeFile(mod, src
  .replace(/const CONFIG_JS = .*;/, `const CONFIG_JS = ${JSON.stringify(CONFIG_FIXTURE)};`)
  .replace(/const TUNING = .*;/, `const TUNING = ${JSON.stringify(TUNING_FIXTURE)};`)
  .replace("'./apply-shaders.mjs'", JSON.stringify('file://' + resolve(HERE, 'apply-shaders.mjs')))
  .replace('const guard = devServerBlocking;', 'const guard = async () => false;'));
const { applyPlacements, writeItems } = await import('file://' + mod);

// config.js as it actually reads: prose above the numbers, two items inside
// `items`, and — the trap — a DECOY `items: {` in a neighbouring root that a
// plain textual search would find first if it started from the top of the file.
const CONFIG = `export const CONFIG = {
  // A neighbour that also has an \`items\` of its own. This one is the reason
  // the splice looks for a DIRECT CHILD of accessories rather than the first
  // match in the file.
  shop: {
    items: {
      accessoryGlasses: { price: 500 },
    },
  },

  // WHAT THE SEAL WEARS. This paragraph is the thing the splice must not eat.
  accessories: {
    enabled: true,
    boneAlign: {
      head_07: [-0.0233, -1.5708, 0],
    },
    equipped: 'accessoryGlasses',
    items: {
      accessoryHat: {
        unlocked: true,
        bone: 'head_07',
        snout: 0.09, lift: 0.6, depth: 0,
        pitch: 1.5708, yaw: 0, roll: 0,
        size: 0.5,
      },
      accessoryGlasses: {
        unlocked: true,
        bone: 'head_07',
        // A QUARTER TURN OFF ANATOMICAL, ON PURPOSE — this comment argues for
        // the exact numbers on the line below it.
        snout: 0.21, lift: 0.119, depth: 0.297,
        pitch: 0, yaw: 1.5708, roll: 0,
        size: 0.78,
      },
    },
  },
};
`;

/** Read the fixture back the way the game would: as a module. */
async function parsed() {
  const text = await readFile(CONFIG_FIXTURE, 'utf8');
  const m = await import('data:text/javascript,' + encodeURIComponent(text));
  return m.CONFIG;
}

// ---------------------------------------------------------------------------
section('THE SPLICE');
// ---------------------------------------------------------------------------
await writeFile(CONFIG_FIXTURE, CONFIG);
await writeFile(TUNING_FIXTURE, '{}\n');

let notes = [];
let out = await writeItems({
  accessoryGlasses: { snout: 0.4, size: 0.9 },
}, { dry: false }, notes);

let cfg = await parsed();
check('config.js still parses', !!cfg);
check('the moved fields landed',
  cfg.accessories.items.accessoryGlasses.snout === 0.4
  && cfg.accessories.items.accessoryGlasses.size === 0.9,
  `snout ${cfg.accessories.items.accessoryGlasses.snout}, size ${cfg.accessories.items.accessoryGlasses.size}`);
check('the fields that did NOT move are untouched',
  cfg.accessories.items.accessoryGlasses.lift === 0.119
  && cfg.accessories.items.accessoryGlasses.yaw === 1.5708);
check('the OTHER accessory is untouched — a save names one subject',
  cfg.accessories.items.accessoryHat.lift === 0.6 && cfg.accessories.items.accessoryHat.size === 0.5);
check('the neighbouring root with its own `items` is untouched',
  cfg.shop.items.accessoryGlasses.price === 500);
check('the container fields survive', cfg.accessories.enabled === true
  && cfg.accessories.boneAlign.head_07[1] === -1.5708);
check('it reports the leaf paths it wrote',
  out.written.join(',') === 'accessories.items.accessoryGlasses.snout,accessories.items.accessoryGlasses.size',
  out.written.join(', '));

// THE PROSE. Every number in this block has a paragraph arguing for it, and
// this tool cannot rewrite prose — so the least it can do is not delete it, and
// say that it is now wrong.
const after = await readFile(CONFIG_FIXTURE, 'utf8');
check('the paragraph above the block is still there',
  after.includes('WHAT THE SEAL WEARS. This paragraph is the thing the splice must not eat.'));
check('...and so is the one arguing for the number that just changed',
  after.includes('A QUARTER TURN OFF ANATOMICAL, ON PURPOSE'));
check('and it SAYS the comment is now stale',
  notes.some((n) => n.startsWith('!') && n.includes('accessoryGlasses.snout')),
  notes.filter((n) => n.startsWith('!')).join(' | ') || 'nothing said');

// ---------------------------------------------------------------------------
section('FIELDS IT REFUSES');
// ---------------------------------------------------------------------------
await writeFile(CONFIG_FIXTURE, CONFIG);
notes = [];
out = await writeItems({
  accessoryGlasses: { snout: 0.5, nonsense: 42, equipped: '', unlocked: false, __proto__: 'no' },
}, { dry: false }, notes);
cfg = await parsed();
check('a field outside the whitelist is dropped, not written',
  !('nonsense' in cfg.accessories.items.accessoryGlasses),
  Object.keys(cfg.accessories.items.accessoryGlasses).join(', '));
// WHAT THE SEAL IS WEARING IS NOT A PLACEMENT. `equipped` is the live slot the
// menu moves every time somebody pokes the animal; splicing it would make one
// session's fiddling everybody's default.
check('`equipped` is refused — it is state, not placement',
  cfg.accessories.equipped === 'accessoryGlasses', String(cfg.accessories.equipped));
check('...and so is `unlocked`', cfg.accessories.items.accessoryGlasses.unlocked === true);
check('...and the legitimate one beside it still lands',
  cfg.accessories.items.accessoryGlasses.snout === 0.5);

// An accessory config.js does not declare. Adding the block would be inventing
// two thirds of a feature — an ASSETS entry and a tuner group are the other two
// — and leaving the third to fail at boot.
notes = [];
out = await writeItems({ accessoryScarf: { snout: 0.1 } }, { dry: false }, notes);
check('an accessory with no block is refused, loudly',
  out.written.length === 0 && notes.some((n) => n.includes('accessoryScarf')),
  notes.join(' | ') || 'said nothing');

// ---------------------------------------------------------------------------
section('--DRY');
// ---------------------------------------------------------------------------
await writeFile(CONFIG_FIXTURE, CONFIG);
notes = [];
out = await writeItems({ accessoryGlasses: { snout: 0.99 } }, { dry: true }, notes);
check('--dry writes nothing', (await readFile(CONFIG_FIXTURE, 'utf8')) === CONFIG);
check('...but still reports what it would have done', out.written.length === 1);

// ---------------------------------------------------------------------------
section('THE SNAPSHOT CLEAR');
// ---------------------------------------------------------------------------
// SAVED TUNING OUTRANKS CONFIG.JS. Without this half, a save writes the right
// number into the right place and the game boots the old one — the shader lab's
// hardest-won lesson, and the reason it is tested rather than trusted.
//
// A file full of somebody's real tuning, so an over-broad delete is visible:
// `enabled` is a switch the player flicked in the tuner and nobody asked this
// tool about it.
await writeFile(CONFIG_FIXTURE, CONFIG);
await writeFile(TUNING_FIXTURE, JSON.stringify({
  _savedAt: 'yesterday',
  accessories: {
    enabled: false,
    items: {
      accessoryGlasses: { snout: 0.9, lift: 0.5, size: 1.2 },
      accessoryHat: { lift: 0.44 },
    },
  },
  bloom: { intensity: 0.8 },
}, null, 2) + '\n');

const report = await applyPlacements({
  items: { accessoryGlasses: { snout: 0.4, size: 0.9 } },
}, { dry: false });
const snap = JSON.parse(await readFile(TUNING_FIXTURE, 'utf8'));

check('the shadowing leaves are gone', report.dropped.length === 2, report.dropped.join(', '));
check('...exactly those two',
  snap.accessories?.items?.accessoryGlasses?.snout === undefined
  && snap.accessories?.items?.accessoryGlasses?.size === undefined);
check('a leaf on the SAME accessory that nobody asked about survives',
  snap.accessories?.items?.accessoryGlasses?.lift === 0.5,
  JSON.stringify(snap.accessories?.items?.accessoryGlasses));
check('the other accessory\'s tuning survives',
  snap.accessories?.items?.accessoryHat?.lift === 0.44);
check('`enabled` survives — that is a switch the player flicked, not a placement',
  snap.accessories?.enabled === false);
check('the rest of the snapshot is untouched',
  snap.bloom?.intensity === 0.8 && snap._savedAt === 'yesterday');

// And an item emptied by the clear is dropped rather than left as `{}`, which
// in a diff reads as a change nobody made.
await writeFile(CONFIG_FIXTURE, CONFIG);
await writeFile(TUNING_FIXTURE, JSON.stringify({
  accessories: { items: { accessoryGlasses: { snout: 0.9 } } },
}, null, 2) + '\n');
await applyPlacements({ items: { accessoryGlasses: { snout: 0.4 } } }, { dry: false });
const snap2 = JSON.parse(await readFile(TUNING_FIXTURE, 'utf8'));
check('an emptied accessory is dropped, not left as {}',
  !('accessories' in snap2), JSON.stringify(snap2));

await rm(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall good\n' : `\n${failures} failing\n`);
process.exit(failures === 0 ? 0 : 1);
