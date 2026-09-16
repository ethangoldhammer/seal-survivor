#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:attackpanel
//
// The attack panel (V), driven through its own buttons and sliders against a
// DOM stub.
//
// WHAT IS WORTH TESTING HERE is not the panel's layout. It is the two promises
// the panel makes about the game, because a diagnostic that breaks either of
// them is worse than no diagnostic:
//
//   IT MEASURES WITH THE GAME'S OWN EXPRESSIONS. The bite ring it draws and the
//   number it prints have to be the reach onPlayerBite actually gates on. A
//   panel with its own idea of the reach is the one instrument in the game
//   capable of certifying a bug as fixed while it is not.
//
//   EVERY SLIDER LANDS SOMEWHERE. A drag writes CONFIG live and then hands you
//   a behaviour.csv line to paste. If that path is not one behaviour.csv OWNS,
//   the drag works, the paste is accepted by the spreadsheet, and the table
//   silently refuses the row on the next boot (see the roots and forbid checks
//   in pathTable.js) — so the number goes back to whatever it was and nothing
//   anywhere says so. Every path the panel can offer is held against the real
//   table here.
//
// It also holds the switches: closing the panel must leave nothing behind, and
// in particular must not leave the seal invincible.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// --- a DOM just rich enough for one panel ----------------------------------
// Same stub shape as tools/upgrade-debug-test.mjs: every listener kept, every
// child remembered, and `textContent = ''` clearing children the way a real
// node does — without that the panel's rebuild appends instead of replacing and
// the second render finds two of every row.
function makeEl() {
  return {
    style: {},
    dataset: {},
    children: [],
    listeners: {},
    _text: '',
    value: '',
    title: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); if (v === '') this.children.length = 0; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    insertBefore(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener() {},
    click() { for (const fn of this.listeners.click ?? []) fn({ preventDefault() {} }); },
    focus() {}, blur() {}, select() {},
  };
}
const stubCreate = globalThis.document.createElement.bind(globalThis.document);
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? stubCreate(tag) : makeEl()),
  createElementNS: makeEl,
  body: makeEl(),
};

const keyHandlers = [];
globalThis.window.addEventListener = (type, fn) => { if (type === 'keydown') keyHandlers.push(fn); };
globalThis.window.removeEventListener = () => {};
const pressKey = (key, target = null) => {
  for (const fn of keyHandlers) fn({ key, target, repeat: false, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false });
};

function walk(node, fn) {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}
function findAll(pred) {
  const out = [];
  walk(document.body, (n) => { if (pred(n)) out.push(n); });
  return out;
}
function buttonNamed(label) {
  return findAll((n) => n.listeners?.click?.length && n.textContent === label)[0] ?? null;
}
function sliderFor(path) {
  // The slider row carries its path as the label's `title`, which is also what
  // makes it hoverable in the panel — one fact, one place.
  const row = findAll((n) => n.children?.some?.((c) => c.title === path))[0] ?? null;
  return row?.children?.find?.((c) => c.listeners?.input?.length) ?? null;
}
function drag(path, value) {
  const s = sliderFor(path);
  if (!s) return false;
  s.value = String(value);
  for (const fn of s.listeners.input ?? []) fn({});
  return true;
}

const { readFileSync } = await import('node:fs');
const THREE = await import('three');
const { CONFIG } = await import('../path/src/config.js');
const { player, initPlayer, resetPlayer } = await import('../path/src/entities/player.js');
const { enemies, spawnNamed, resetEnemies, updateEnemies } = await import('../path/src/entities/enemies.js');
const { attackStudy, setAttackTrace, attackTraceOn, tickAttackTrace } = await import('../path/src/systems/attackTrace.js');
const { attackOverlayOn, updateAttackOverlay } = await import('../path/src/systems/attackOverlay.js');
const {
  initAttackDebug, setAttackDebugVisible, updateAttackDebug, attackDebugState, sliderRows,
} = await import('../path/src/ui/attackDebug.js');

const scene = new THREE.Scene();
initPlayer(scene);
resetPlayer();
initAttackDebug(() => ({ scene, gameState: { level: 5, difficulty: 3, time: 60 } }));

// ---------------------------------------------------------------------------
section('THE KEY, AND WHAT OPENING IT TURNS ON');
// ---------------------------------------------------------------------------
check('starts closed', attackDebugState().visible === false);
check('...and the trace is off with it', attackTraceOn() === false);
pressKey('v');
check('V opens it', attackDebugState().visible === true);
check('...and starts recording', attackTraceOn() === true);
check('...and puts the overlay in the scene', attackOverlayOn() === true);
pressKey('v', { tagName: 'INPUT' });
check('V inside a text field is ignored', attackDebugState().visible === true,
  'typing a name on the game-over screen must not open panels');
pressKey('v');
check('V closes it', attackDebugState().visible === false);
check('...and stops recording', attackTraceOn() === false);
check('...and takes the overlay back out', attackOverlayOn() === false);

// ---------------------------------------------------------------------------
section('THE SWITCHES LEAVE NOTHING BEHIND');
// ---------------------------------------------------------------------------
setAttackDebugVisible(true);
buttonNamed('no damage').click();
buttonNamed('solo').click();
check('the two study switches are on', attackStudy.noDamage && attackStudy.soloBoss);
setAttackDebugVisible(false);
check('closing the panel clears them — nothing is left invincible',
  !attackStudy.noDamage && !attackStudy.soloBoss);

// ---------------------------------------------------------------------------
section('EVERY SLIDER IS A ROW behaviour.csv OWNS');
// ---------------------------------------------------------------------------
// The check that matters. A slider over a path the table does not own drags
// fine, pastes fine and is silently refused on the next boot.
{
  const csv = readFileSync(new URL('../path/src/behaviour.csv', import.meta.url), 'utf8');
  const owned = new Set(csv.split('\n').slice(1).map((l) => l.split(',')[0].trim()).filter(Boolean));
  // Every lunging body, not just the one in the water: the panel builds its
  // per-species block from whatever the subject is, so a species with a lunge
  // block and no CSV rows would only fail when that boss happened to spawn.
  const lungers = Object.entries(CONFIG.enemies).filter(([, d]) => d.lunge).map(([k]) => k);
  const missing = [];
  for (const key of [null, ...lungers]) {
    for (const [path] of sliderRows(key)) {
      if (!owned.has(path)) missing.push(path);
    }
  }
  check('every path the panel can offer has a behaviour.csv row',
    missing.length === 0,
    missing.length ? `no row for: ${[...new Set(missing)].join(', ')}`
      : `${lungers.length} bodies checked, all rows present`);
}

// ---------------------------------------------------------------------------
section('A DRAG WRITES THE GAME, AND WRITES NOTHING ELSE');
// ---------------------------------------------------------------------------
setAttackDebugVisible(true);
{
  const before = CONFIG.lungeRules.commitCone;
  const moved = drag('lungeRules.commitCone', 2.4);
  check('the slider is on screen and takes a drag', moved);
  check('...and the drag reaches CONFIG immediately',
    Math.abs(CONFIG.lungeRules.commitCone - 2.4) < 1e-9,
    `${before} → ${CONFIG.lungeRules.commitCone}`);
  check('...and the panel remembers that it moved',
    attackDebugState().touched.includes('lungeRules.commitCone'));
  buttonNamed('Revert').click();
  check('Revert puts it back to what the page booted with',
    Math.abs(CONFIG.lungeRules.commitCone - before) < 1e-9,
    `${CONFIG.lungeRules.commitCone}`);
  check('...and forgets the edit', attackDebugState().touched.length === 0);

  // NOT saveTuningToStorage. Every path here is stripped from that snapshot
  // both ways, so a save would be a file write per frame of a drag to persist
  // nothing — and it would race whatever the ` tuner is doing.
  //
  // COMMENTS ARE STRIPPED FIRST. The panel's own notes EXPLAIN why it does not
  // call saveTuningToStorage and name the file it would have come from, so a
  // plain substring search over the source matches the explanation and reports
  // the opposite of the truth. Which it did.
  const src = readFileSync(new URL('../path/src/ui/attackDebug.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('the panel never calls the tuning save', !/saveTuningToStorage/.test(src));
  check('...and never imports the shared tuner row, which does',
    !/from '[^']*tunerControls/.test(src));
}

// ---------------------------------------------------------------------------
section('IT MEASURES WITH THE GAME\'S OWN EXPRESSION');
// ---------------------------------------------------------------------------
// Three files compute the bite reach — main.js gates damage on it, the overlay
// draws it, the panel prints it — and the whole value of the panel rests on all
// three being the same expression. Held on the source rather than on a value:
// two different expressions can agree on today's numbers and part company the
// moment a radius or a multiplier moves, which is exactly when you are looking.
{
  const reach = /\(e\.radius \?\? 1\) \* \(CONFIG\.bite\?\.mouthReach \?\? 0\.55\)/;
  const main = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  const overlay = readFileSync(new URL('../path/src/systems/attackOverlay.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../path/src/ui/attackDebug.js', import.meta.url), 'utf8');
  check('main.js gates the bite on it', reach.test(main));
  check('the overlay draws the same expression', reach.test(overlay));
  check('the panel prints the same expression', reach.test(panel));
  check('...and all three add the seal\'s own hit radius',
    /mouthReach \?\? 0\.55\)\s*\n?\s*\+ \(?player\.stats\??\.?\??hitRadius|mouthReach \?\? 0\.55\) \+ pr/.test(main + overlay + panel));
}

// ---------------------------------------------------------------------------
section('THE OVERLAY IS MADE OF REAL GEOMETRY, POINTING THE RIGHT WAY');
// ---------------------------------------------------------------------------
// It was made of lines, and `LineBasicMaterial.linewidth` is ignored by every
// WebGL2 core profile — so every shape was one physical pixel wide however far
// away the camera was, which over a moving fight is invisible. Every test in
// this file passed the whole time it was invisible, which is the point: "can
// you see it" is not a thing a DOM harness can ask.
//
// What a harness CAN hold is the geometry, and the three ways these shapes go
// wrong are all measurable without a pixel: a ring that is a disc, a cone
// pointing the wrong way, and a bar that extends backwards out of the animal.
// `npm run looks:attack` is the eyeball check on top of this.
{
  const { attackOverlayStats, setAttackOverlayWeight } = await import('../path/src/systems/attackOverlay.js');
  const bounds = (g) => {
    g.computeBoundingBox();
    return g.boundingBox;
  };
  const radii = (g) => {
    const pos = g.attributes.position;
    let min = Infinity; let max = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      if (r < min) min = r;
      if (r > max) max = r;
    }
    return { min, max };
  };

  // A ring is an ANNULUS of unit outer radius — not a disc, which is what a
  // CircleGeometry would give and what would cover the animal it describes.
  const ringG = new THREE.RingGeometry(1 - 0.08, 1, 72);
  const rr = radii(ringG);
  check('a ring is a hole with a wall, not a filled disc',
    rr.min > 0.9 && Math.abs(rr.max - 1) < 1e-6,
    `inner ${rr.min.toFixed(3)}, outer ${rr.max.toFixed(3)}`);

  // The cone wedge opens symmetrically about +X, because every caller rotates
  // it by the body's heading and heading 0 is +X. Off by thetaStart and it
  // points off the animal's flank while reading as plausible.
  const half = 0.6;
  const wedgeG = new THREE.CircleGeometry(1, 16, -half, half * 2);
  const wb = bounds(wedgeG);
  check('the cone opens about +X, symmetrically',
    wb.max.x > 0.8 && Math.abs(wb.max.y + wb.min.y) < 1e-6 && wb.max.y > 0,
    `x to ${wb.max.x.toFixed(2)}, y ${wb.min.y.toFixed(2)}..${wb.max.y.toFixed(2)}`);
  check('...and no wider than the half-angle it was asked for',
    Math.abs(Math.atan2(wb.max.y, 0.0001) ) > 0 && wb.max.y <= Math.sin(half) + 1e-6,
    `${(Math.asin(Math.min(1, wb.max.y)) * 180 / Math.PI).toFixed(0)} deg against ${(half * 180 / Math.PI).toFixed(0)}`);

  // The bar runs FORWARD from the origin. Centred instead — PlaneGeometry's
  // default — half the committed run would be drawn out of the boss's tail.
  const barG = new THREE.PlaneGeometry(1, 1);
  barG.translate(0.5, 0, 0);
  const bb = bounds(barG);
  check('the run bar starts at the body and runs forward',
    Math.abs(bb.min.x) < 1e-6 && Math.abs(bb.max.x - 1) < 1e-6,
    `x ${bb.min.x.toFixed(2)}..${bb.max.x.toFixed(2)}`);

  // ...and the live overlay actually emits those, for a real body.
  resetEnemies(scene);
  setAttackDebugVisible(true);
  const e = spawnNamed(scene, 'bossShark', 3, { x: -14, y: -20 }, { ignoreCaps: true });
  e.isBoss = true;
  const pos = new THREE.Vector3(0, -20, 0);
  for (let i = 0; i < 240; i++) {
    tickAttackTrace(1 / 60);
    updateEnemies(1 / 60, scene, pos, () => {}, () => {});
  }
  updateAttackOverlay({ showWildlife: true });
  const st = attackOverlayStats();
  check('a body in the water draws its window, its floor and its bite',
    st.rings >= 4, `${st.rings} rings`);
  check('...and the geometry cache stays small',
    st.geometries > 0 && st.geometries < 40, `${st.geometries} cached`);

  // THE WEIGHT REACHES THE DRAWING. A slider that rebuilt nothing would be a
  // control that visibly does nothing, which is worse than not having one.
  const beforeMats = attackOverlayStats().materials;
  setAttackOverlayWeight(3);
  updateAttackOverlay({ showWildlife: true });
  check('turning the weight up changes what is drawn',
    attackOverlayStats().materials > beforeMats,
    `${beforeMats} materials at x1, ${attackOverlayStats().materials} after x3`);
  setAttackOverlayWeight(1);
  setAttackDebugVisible(false);
}

// ---------------------------------------------------------------------------
section('THE LOG CANNOT BE CRUSHED TO NOTHING');
// ---------------------------------------------------------------------------
// A layout guard, and the only one in this file, because this failure is
// invisible to everything else here: the DOM is correct, every row is present
// and every string is right — the container is simply zero pixels tall.
//
// The panel body is a scrolling flex COLUMN, so every child is shrinkable by
// default, and the log is the only child with an internal overflow and so the
// only one with anywhere to shrink to. With the slider block below it the flex
// solver took it to zero and the log rendered as a heading with nothing under
// it, which reads exactly like the ledger having recorded nothing.
{
  const src = readFileSync(new URL('../path/src/ui/attackDebug.js', import.meta.url), 'utf8');
  check('the log container refuses to shrink',
    /const log = el\('div', 'flex:0 0 auto;/.test(src),
    'a scrolling flex column crushes the one child that can scroll internally');
}

// ---------------------------------------------------------------------------
section('AND IT SURVIVES A LIVE FIGHT');
// ---------------------------------------------------------------------------
// The panel renders off live creature state and the overlay walks the enemy
// list every frame. Both are driven here against a real spawn, because the
// failure they are prone to is a null read on a body mid-teardown and that is
// not visible from any static check.
{
  resetEnemies(scene);
  setAttackTrace(false);
  setAttackDebugVisible(true);
  const e = spawnNamed(scene, 'bossShark', 3, { x: -16, y: -20 }, { ignoreCaps: true });
  e.isBoss = true;
  const pos = new THREE.Vector3(0, -20, 0);
  let threw = null;
  try {
    for (let i = 0; i < 600; i++) {
      tickAttackTrace(1 / 60);
      updateEnemies(1 / 60, scene, pos, () => {}, () => {});
      updateAttackDebug(1 / 60);
      if (i === 300) {
        // Mid-fight teardown, which is the case that breaks a panel holding a
        // reference: the subject stops existing between one render and the next.
        resetEnemies(scene);
      }
    }
  } catch (err) {
    threw = err;
  }
  check('ten seconds of fight, a mid-fight teardown and 600 renders, no throw',
    threw == null, threw ? String(threw.message ?? threw) : 'clean');
  check('...and the overlay draws with nothing in the water',
    (() => { try { updateAttackOverlay(); return true; } catch { return false; } })());
  setAttackDebugVisible(false);
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
