#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:accessorydrawer
//
// THE DRAWER AND THE SEAL-POKE — what a player uses to change what the seal is
// wearing, and the two ways it can be silently wrong.
//
// A STUB IS STILL WIRED TO SOMETHING REAL. ui/accessoryDrawer.js is deliberately
// unfinished (see its header), but the parts it does own are the parts a stub
// gets wrong: it writes a shared slot, it reads a roster that a locked item has
// to fall out of, and its drop lands on a moving target. None of those fail
// loudly. A tile that equips nothing looks exactly like a tile you missed.
//
//   THE SLOT       the drawer must go through equipAccessory rather than
//                  writing CONFIG itself — that function owns the two rules
//                  (must exist, must be unlocked) and a second writer is a
//                  second place to forget them.
//   THE ROSTER     a locked accessory is out of the drawer and out of the
//                  menu's cycle, but still available to the tools.
//   THE DROP       a drag that lets go over open water must NOT equip, and a
//                  tap must, and both are the same pointer sequence separated
//                  only by distance.
//   THE MOUNT      the drawer and the seal-cycle are two lines in
//                  systems/mainMenu.js that nothing else references. That file
//                  cannot run headless — GL, a loaded seal, a post stack — so
//                  they are checked at the SOURCE level, which catches deletion
//                  and not misplacement. Stated rather than dressed up, same as
//                  tools/build-stamp-test.mjs does for the same file.
//
// The copy is NOT checked here beyond "the drawer asks the table for it":
// npm run test:copy and npm run test:uitext own that, and the five lines are
// lorem on purpose until Ethan writes them.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// jsdom BEFORE the loader hooks, per the harness recipe — importing the vite
// loader first breaks the CJS chain jsdom itself loads through.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;

await import('./vite-loader.mjs');
const { CONFIG } = await import('../path/src/config.js');
const {
  equipAccessory, cycleAccessory, accessoryRoster, accessoryUnlocked, accessoryTurn,
} = await import('../path/src/systems/accessories.js');
const { mountAccessoryDrawer } = await import('../path/src/ui/accessoryDrawer.js');

// The seal, as far as this test is concerned: a circle in the middle of a
// notional 800x600 window. The real one comes from the menu's own projection of
// the measured bust — see sealScreen in systems/mainMenu.js.
const SEAL = { x: 400, y: 240, r: 90 };
const parent = document.createElement('div');
document.body.appendChild(parent);

let equipped = [];
const drawer = mountAccessoryDrawer({
  parent,
  sealRect: () => SEAL,
  onEquip: (key) => equipped.push(key),
});

const tiles = () => [...parent.querySelectorAll('.sv-acc-tile')].filter((t) => !t.classList.contains('sv-acc-ghost'));
const tileFor = (key) => tiles().find((t) => t.dataset.key === key);

/** A press-move-release on a tile, in client pixels. */
function drag(tile, toX, toY) {
  const id = 7;
  tile.dispatchEvent(new dom.window.MouseEvent('pointerdown', {
    bubbles: true, clientX: 0, clientY: 0,
  }));
  // jsdom's MouseEvent has no pointerId; the drawer only reads it for capture,
  // which jsdom does not implement either. Both are set here so the code under
  // test takes exactly the branches it takes in a browser.
  // ON THE WINDOW, which is where the drawer listens once a drag is under way —
  // a pointer that has left the tile is the whole point of a drag, and the
  // events then land on whatever is under it. Dispatching these on the tile
  // would test a path the browser never takes.
  const move = new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: toX, clientY: toY });
  Object.defineProperty(move, 'pointerId', { value: id });
  dom.window.dispatchEvent(move);
  const up = new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: toX, clientY: toY });
  Object.defineProperty(up, 'pointerId', { value: id });
  dom.window.dispatchEvent(up);
}

/** A press and release that never moves — a tap. */
function tap(tile) {
  tile.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }));
}

// ---------------------------------------------------------------------------
section('THE TILES');
// ---------------------------------------------------------------------------
const roster = accessoryRoster(true);
check('one tile per unlocked accessory, plus the bare seal',
  tiles().length === roster.length + 1, `${tiles().length} tiles, ${roster.length} unlocked`);
check('the bare seal is a tile of its own, not an absence', !!tileFor(''));
check('...and it is FIRST — taking a hat off has to be something you can point at',
  tiles()[0].dataset.key === '');
// The names come from uiText.csv, which is the whole reason the drawer has no
// strings of its own. Lorem today, and that is the gate doing its job.
check('the names come from the table rather than from this file',
  tiles().every((t) => (t.querySelector('.sv-acc-name')?.textContent ?? '').length > 0));

// ---------------------------------------------------------------------------
section('EQUIPPING');
// ---------------------------------------------------------------------------
equipAccessory('');
equipped = [];
tap(tileFor('accessoryHat'));
check('a tap equips', CONFIG.accessories.equipped === 'accessoryHat', CONFIG.accessories.equipped);
check('...and says so', equipped.at(-1) === 'accessoryHat');
check('the tile marks itself', tileFor('accessoryHat').classList.contains('on'));
check('...and only it does — ONE SLOT',
  tiles().filter((t) => t.classList.contains('on')).length === 1);

equipped = [];
drag(tileFor('accessoryGlasses'), SEAL.x, SEAL.y);
check('a drag ONTO the seal equips', CONFIG.accessories.equipped === 'accessoryGlasses',
  CONFIG.accessories.equipped);
check('...and the hat came off with it', !tileFor('accessoryHat').classList.contains('on'));

// THE ONE THAT MATTERS. A drag released over open water is a cancelled gesture,
// and a drawer that equipped anyway would make the drop target a lie — you
// could never put something back.
equipped = [];
drag(tileFor('accessoryHat'), 40, 560);
check('a drag released OFF the seal equips nothing',
  CONFIG.accessories.equipped === 'accessoryGlasses' && equipped.length === 0,
  `${CONFIG.accessories.equipped}, ${equipped.length} events`);

drag(tileFor(''), SEAL.x + 20, SEAL.y - 10);
check('dragging the bare tile onto the seal takes everything off',
  CONFIG.accessories.equipped === '');

// The ghost has to go, however the drag ended. One left behind is a tile
// following the pointer around the menu forever.
check('no ghost survives a drop', document.querySelectorAll('.sv-acc-ghost').length === 0);

// ---------------------------------------------------------------------------
section('LOCKED');
// ---------------------------------------------------------------------------
CONFIG.accessories.items.accessoryGlasses.unlocked = false;
drawer.rebuild();
check('a locked accessory has no tile', !tileFor('accessoryGlasses'),
  tiles().map((t) => t.dataset.key || '(bare)').join(', '));
check('...and equipAccessory refuses it anyway — the drawer is not the guard',
  equipAccessory('accessoryGlasses') !== 'accessoryGlasses');
check('...and the menu\'s cycle steps over it',
  !new Set([cycleAccessory(1), cycleAccessory(1), cycleAccessory(1)]).has('accessoryGlasses'));
check('accessoryUnlocked agrees', !accessoryUnlocked('accessoryGlasses'));
// THE TWO RULES HAVE TO BE ONE RULE. The drawer builds its tiles from the
// roster and the click goes through equipAccessory, so a roster that counts an
// accessory as available while the equip counts it as locked is a tile that
// does nothing — indistinguishable from a tile you missed. It read `!!unlocked`
// in one and `!== false` in the other for a while, which meant exactly that for
// any accessory imported without the field. ABSENT MEANS AVAILABLE: locking has
// to be something a file says, not something it forgets.
delete CONFIG.accessories.items.accessoryGlasses.unlocked;
drawer.rebuild();
check('an accessory with NO unlocked field gets a tile', !!tileFor('accessoryGlasses'));
check('...and the tile actually equips it', (tap(tileFor('accessoryGlasses')),
  CONFIG.accessories.equipped === 'accessoryGlasses'), CONFIG.accessories.equipped);
CONFIG.accessories.items.accessoryGlasses.unlocked = true;
CONFIG.accessories.items.accessoryGlasses.unlocked = true;
drawer.rebuild();
check('unlocking brings the tile back', !!tileFor('accessoryGlasses'));

// ---------------------------------------------------------------------------
section('THE TURN FOLLOWS THE SLOT');
// ---------------------------------------------------------------------------
// Equipping is what rolls how the animal stands, so the drawer and the seal-poke
// have to move it too — not just the tuner. A drawer that changed the slot
// without the pose would leave the glasses on a seal still in profile, which is
// the one arrangement they were placed to avoid.
tap(tileFor('accessoryGlasses'));
check('a tile equips AND turns the animal',
  Math.abs(accessoryTurn() + Math.PI / 2) < 0.01, `${(accessoryTurn() * 180 / Math.PI).toFixed(0)}deg`);
tap(tileFor(''));
check('the bare tile stands it back up', accessoryTurn() === 0);
cycleAccessory(1);
check('...and so does the menu\'s cycle',
  accessoryTurn() === 0 || CONFIG.accessories.items[CONFIG.accessories.equipped]
    ?.showTurns?.includes(accessoryTurn()),
  `${CONFIG.accessories.equipped || '(bare)'} at ${(accessoryTurn() * 180 / Math.PI).toFixed(0)}deg`);

// The menu composes it INSIDE the cant rather than beside it. Source-level, for
// the reason the mounts below are: a canted seal turned about the screen's
// vertical instead of its own spine walks its head out of the frame, and that
// is a multiplication order, not a value.
const menuTurn = await readFile(join(ROOT, 'path/src/systems/mainMenu.js'), 'utf8');
check('the menu reads the accessory\'s turn', menuTurn.includes('accessoryTurn()'));
// The PLUMB is composed after the turn — in the animal's frame — and the
// authored cant before it. The other order is a plumb measured in profile
// applied to a turned animal, which is a sideways lean; see the note by
// `_plumbQuat` in mainMenu.js.
check('...composes the plumb AFTER the turn, in the animal\'s frame',
  /setFromAxisAngle\(_z, cfg\.lean \?\? 0\)\s*\n?\s*\.multiply\(_turnQuat\.setFromAxisAngle\(_y, turn\)\)\s*\n?\s*\.multiply\(_plumbQuat\.setFromAxisAngle\(_z, plumb\)\)/.test(menuTurn));
check('...and eases rather than snapping', menuTurn.includes('turnLerp'));
// AND THE HEAD LEANS OUT WITH IT. The turn alone gives a seal facing the camera
// with its face pointed at the sky — see the faceOut block in aimRig.js. The
// menu publishes it, main.js carries it down through updateAimRig (entities/
// does not import from systems/), and it fades with the shot rather than with
// the turn alone, or a head would still be craning at the lens while the animal
// swims away.
check('the menu publishes how far the head should lean out', menuTurn.includes('mainMenuFaceOut'));
check('...derived from the turn, not a second setting', /Math\.abs\(Math\.sin\(turn\)\)/.test(menuTurn));
check('...and faded with the shot', /state\.faceOut = Math\.abs\(Math\.sin\(turn\)\) \* w/.test(menuTurn));
const mainSrc = await readFile(join(ROOT, 'path/src/main.js'), 'utf8');
check('main.js hands it to the rig', /updateAimRig\((.|\n)*?mainMenuFaceOut\(\)/.test(mainSrc));

// ---------------------------------------------------------------------------
section('THE FADE, AND LEAVING');
// ---------------------------------------------------------------------------
// The drawer is the buttons' companion: it goes with them, on their curve, and
// it leaves when the menu does. A drawer that outlived the menu would be a row
// of tiles over a run.
drawer.setWeight(0);
check('weight 0 hides it', parent.querySelector('.sv-acc-drawer').style.opacity === '0');
drawer.destroy();
check('destroy takes the drawer', !parent.querySelector('.sv-acc-drawer'));
check('...and the drop target with it', !parent.querySelector('.sv-acc-target'));

// ---------------------------------------------------------------------------
section('THE MOUNT IN THE MENU');
// ---------------------------------------------------------------------------
// systems/mainMenu.js cannot run headless, so this catches DELETION and not
// misplacement — the same weaker check, stated the same way, that
// tools/build-stamp-test.mjs makes about the same file.
const menuSrc = await readFile(join(ROOT, 'path/src/systems/mainMenu.js'), 'utf8');
check('the menu mounts the drawer', menuSrc.includes('mountAccessoryDrawer({'));
check('...hands it the seal\'s own screen circle', /sealRect:\s*sealScreen/.test(menuSrc));
check('...fades it with the buttons', /drawer\?\.setWeight\(labelFade\(w\)\)/.test(menuSrc));
check('...and destroys it on the way out', menuSrc.includes('drawer?.destroy()'));
check('a press on the seal cycles what it wears', menuSrc.includes('cycleAccessory(1)'));
// The cycle has to be reached from the OPEN-WATER branch, before the knock —
// checked positionally because "the call is in the file" would pass with it
// sitting in a function nothing runs.
const openWater = menuSrc.indexOf('if (hovered < 0) {');
check('...on the branch where nothing else was pressed',
  openWater > -1 && menuSrc.indexOf('cycleAccessory(1)') > openWater
  && menuSrc.indexOf('cycleAccessory(1)') < menuSrc.indexOf('OPEN WATER.'));

console.log(failures === 0 ? '\nall good\n' : `\n${failures} failing\n`);
process.exit(failures === 0 ? 0 : 1);
