import { CONFIG } from '../config.js';
import { player, addUpgrade, recomputeStats } from '../entities/player.js';
import { rarities, baseRarity, rarityById } from '../systems/rarity.js';
import { activeElement } from '../systems/elements.js';
import { expandDesc } from '../upgradeText.js';
import * as playtest from '../systems/playtest.js';
import { isTypingTarget } from './typing.js';
import { bossArchetypes, bossPerkList, bossState, forceBoss, previewBossNames } from '../systems/boss.js';
import { STORM_PERKS } from '../systems/bossPerks.js';
import { enemies, resetEnemies, spawnNamed } from '../entities/enemies.js';
import {
  attractorStormList, startAttractorStorm, stopAttractorStorm, activeAttractorStorm,
} from '../systems/attractorStorm.js';
import { bounds, clampBelowSurface } from '../arena.js';

// ---------------------------------------------------------------------------
// THE UPGRADE PANEL — press U.
//
// Hands the seal any upgrade in the table, right now, without waiting for the
// level-up screen to offer it. The reason this needs to exist is the offer
// itself: a card is three draws out of forty weighted rows, so trying the sixth
// stack of one specific ability means playing until the deal happens to hand it
// to you six times. That is not a way to look at an ability, and it is much
// worse for the ones you most want to look at — anything gated behind
// `enabled: FALSE` in upgrades.csv cannot be dealt AT ALL, so a half-built
// upgrade currently has no way to be seen in the water at all before it ships.
//
// It goes through the same door the real pick does — commitElement, then
// addUpgrade with a tier, then recomputeStats — rather than writing stats
// directly. Anything that writes `player.stats` itself is testing a stat block
// that the game will overwrite on the next level-up: recomputeStats() rebuilds
// from base and replays `player.upgrades` every time, so a hand-poked number
// survives until the next card and then silently vanishes. Going through
// addUpgrade means what you are looking at is what a real run would produce.
//
// WHAT THE PANEL LETS YOU CHOOSE that the game rolls for you:
//
//   RARITY    the tier a card was dealt at rides along with the pick forever
//             (see recomputeStats), and statMul makes the same upgrade a
//             different upgrade at the top of the ladder. Picking the tier is
//             the difference between "try Multishot" and "try the Multishot
//             someone will actually complain about".
//   ELEMENT   Glow Up! rolls one element per run and never re-rolls. Without a
//             picker, seeing infection means restarting runs until the roll
//             gives it to you.
//
// REMOVING. Click a held row's minus to hand one stack back. This rolls the
// STAT BLOCK back exactly — it is the same replay-from-base — but it does not
// promise to unwind everything an ability has already put in the water: a
// companion that has spawned stays until whatever owns it syncs its count from
// stats. Numbers are trustworthy immediately; bodies may take a beat.
//
// DEV ONLY. Wired behind DEV_UI in main.js next to the rest of the panels, so
// no player build has a key that grants upgrades.
// ---------------------------------------------------------------------------

const ALL = '(all)';
const ROLL = '(roll)';
// Distinct from ROLL on purpose. The perk-less boss is a real, shipping state —
// it is what every run's FIRST boss is — and without a chip for it the one
// combination you cannot check by hand is the one every player sees first.
const NONE = '(none)';

let panel = null;
let listEl = null;
let headEl = null;
let footEl = null;
let statusEl = null;
let rarityRow = null;
let elementRow = null;
let familyRow = null;
let bossRow = null;
let perkRow = null;
let stormRow = null;
let stormNoteEl = null;
let namesEl = null;
let visible = false;

// What the next grant will be. `rarity` starts at the floor tier so a plain
// click gives you the card as it is most often dealt, not as it is best.
let rarity = null;
let family = ALL;
// What is typed in the search box. Held here rather than read off the input at
// filter time, so the one caller that clears it (the × and Escape) has a single
// thing to set — and so the filter can be exercised without a DOM.
let search = '';
let status = '';

// What the next FORCED BOSS will be. `ROLL` leaves it to the game — the bag
// for the archetype, the weighted table for the perk — and NONE is the
// perk-less boss every run's first one is, which is otherwise unreachable on
// demand. Both start at ROLL so the button with no other clicks gives you what
// a real run gives you.
let bossPick = ROLL;
let perkPick = ROLL;
let rolledNames = [];

// What the next CREATURE spawn will be. A key from enemies.csv and how many of
// it. `fish` and 1 because that is the cheapest thing to put in the water and
// the one you want when you are checking that the door works at all.
let creaturePick = 'fish';
let creatureCount = 1;
let creatureSelect = null;
let countRow = null;

// Which of the six candidate attacks the Stage button will put in the water.
// The first row of attractorStorms.csv, so the button does something the first
// time it is pressed rather than asking for a chip first.
let stormPick = attractorStormList()[0]?.id ?? '';

// Set by main.js — the run clock, for the playtest record. Passed in rather
// than imported because `gameState` is a local in main.js, and a panel reaching
// into the game loop's own state would be a worse dependency than a getter.
let runTime = () => 0;

// The scene and the run state, for the boss spawner below. Passed in for the
// same reason `runTime` is: both are locals in main.js, and a panel reaching
// into the game loop's own state would be a worse dependency than a getter.
// Returns null until main.js wires it, which is what the button checks.
let world = () => null;

const C = {
  dim: 'rgba(232,236,243,0.45)',
  text: 'rgba(232,236,243,0.88)',
  ok: '#7ee081',
  warn: '#ffc861',
  off: 'rgba(232,236,243,0.3)',
};

export function initUpgradeDebug(getTime = null, getWorld = null) {
  if (typeof getTime === 'function') runTime = getTime;
  if (typeof getWorld === 'function') world = getWorld;
  rarity = baseRarity();

  panel = document.createElement('div');
  panel.id = 'svUpgradeDebug';
  // Left-hand side: the sound feed and the balance panel both live on the
  // right, and this is the one panel you want open AT THE SAME TIME as the
  // balance panel — grant an ability, watch its damage share move.
  panel.style.cssText =
    'position:fixed;left:12px;top:12px;bottom:12px;width:min(430px,40vw);z-index:32;display:none;'
    + 'flex-direction:column;border-radius:10px;overflow:hidden;'
    + 'background:rgba(5,6,10,0.94);border:1px solid rgba(232,236,243,0.16);'
    + `color:${C.text};font:500 11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;`;

  headEl = document.createElement('div');
  headEl.style.cssText =
    'padding:8px 10px;flex:0 0 auto;border-bottom:1px solid rgba(232,236,243,0.12);'
    + 'background:rgba(232,236,243,0.04);';
  panel.appendChild(headEl);

  // THE SEARCH BOX IS PINNED, above the scrolling block below it. It is the
  // fastest way to the one row you came for, so it must never be the thing
  // that has scrolled off — and it is the only control here that answers a
  // question about the LIST rather than about the water.
  const find = document.createElement('div');
  find.style.cssText = 'padding:7px 10px 0;flex:0 0 auto;';
  find.appendChild(searchControl());
  panel.appendChild(find);

  // THE CONTROL STACK SCROLLS, AND SHRINKS BEFORE THE LIST DOES.
  //
  // It was `flex:0 0 auto` while it held three chip rows, and every block
  // added since — boss, creature, attractor storm — pushed the upgrade list
  // and the footer down past the panel's own bottom edge, where `overflow:
  // hidden` swallowed them. Nothing looked broken from in here: the panel was
  // exactly as tall as it had been asked to be, and the half of it you wanted
  // was underneath the screen.
  //
  // So: `0 1 auto` to let it give ground, `min-height:0` because a flex item
  // will otherwise refuse to shrink below its content no matter what its
  // shrink factor says, and a 60% cap so that a tall window spends its extra
  // room on upgrades rather than on more debug furniture. The list's own
  // `min-height` outranks all of it — on a short window the stack scrolls
  // internally rather than eating the thing the panel is named after.
  const controls = document.createElement('div');
  controls.style.cssText =
    'padding:7px 10px;flex:0 1 auto;min-height:0;max-height:60%;overflow-y:auto;'
    + 'display:flex;flex-direction:column;gap:5px;'
    + 'border-bottom:1px solid rgba(232,236,243,0.12);';
  // All three rows are filled in by render() rather than here, because all
  // three carry a selection: a chip built once keeps the highlight it was born
  // with, and the row would go on showing the family you picked first.
  rarityRow = row('tier');
  elementRow = row('glow');
  familyRow = row('show');
  controls.append(rarityRow.wrap, elementRow.wrap, familyRow.wrap);
  controls.appendChild(bossControls());
  controls.appendChild(creatureControls());
  controls.appendChild(stormControls());
  panel.appendChild(controls);

  // `1 1 0` rather than `1 1 auto`: fifty-six rows of content as a flex basis
  // makes the list the biggest item in the box and the shrink maths then hands
  // the controls almost nothing. Basis zero asks for the leftovers instead,
  // and the min-height is the floor under that — when the leftovers run out
  // the violation is redistributed back to the stack above, which is the one
  // that can afford to scroll.
  listEl = document.createElement('div');
  listEl.style.cssText = 'flex:1 1 0;min-height:110px;overflow:auto;padding:4px 6px;';
  panel.appendChild(listEl);

  footEl = document.createElement('div');
  footEl.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:7px 10px;flex:0 0 auto;'
    + 'border-top:1px solid rgba(232,236,243,0.12);background:rgba(232,236,243,0.04);';
  const clear = button('Clear all', () => {
    const n = player.upgrades.length;
    player.upgrades.length = 0;
    recomputeStats();
    status = `cleared ${n} pick${n === 1 ? '' : 's'}`;
    render();
  });
  statusEl = document.createElement('div');
  statusEl.dataset.status = '1';
  // The line that answers "what did that do" after a click, so it gets the
  // width: ellipsis rather than wrap, because a long stat diff pushing the
  // buttons around would move the thing you are about to click again.
  statusEl.style.cssText =
    `flex:1 1 auto;color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
  footEl.append(clear, statusEl);
  panel.appendChild(footEl);

  document.body.appendChild(panel);

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) || e.repeat) return;
    if (e.key?.toLowerCase() !== 'u') return;
    setVisible(!visible);
  });
}

// ---------------------------------------------------------------------------
// THE BOSS BLOCK
// ---------------------------------------------------------------------------
// The same problem the rest of this panel solves, one layer up. A boss is
// eight to twelve LEVELS apart, its archetype is drawn from a bag, its perk is
// rolled, and its NAME is assembled from three tables that narrow on each
// other — bossNames.csv rows can be tagged for one archetype, for one perk, or
// for neither. So "do all the combinations read right" is a question you
// cannot currently answer without playing for an hour and getting lucky.
//
// Two buttons, and the cheap one matters more. SPAWN puts the combination in
// the water through the real arrival. ROLL NAMES prints a dozen names for the
// selected combination without spawning anything — which is the actual
// question most of the time, and reading twelve at once beats twelve fights.
function bossControls() {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;gap:5px;margin-top:3px;padding-top:6px;'
    + 'border-top:1px solid rgba(232,236,243,0.12);';

  const heading = document.createElement('div');
  heading.style.cssText = `color:${C.dim};letter-spacing:0.14em;font-size:9px;`;
  heading.textContent = 'BOSS — SPAWN ANY COMBINATION';
  wrap.appendChild(heading);

  bossRow = row('body');
  perkRow = row('perk');
  wrap.append(bossRow.wrap, perkRow.wrap);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;';
  buttons.append(
    button('Spawn boss', () => {
      const w = world();
      if (!w?.scene) { status = 'no scene — boss spawning is not wired'; render(); return; }
      const e = forceBoss(w.scene, w.gameState, {
        boss: bossPick === ROLL ? null : bossPick,
        // Three states, not two: ROLL leaves it to the weighted table, NONE
        // forces the perk-less boss, and a named perk forces that one. `null`
        // is the wire value for NONE, so ROLL has to become `undefined`.
        perk: perkPick === ROLL ? undefined : (perkPick === NONE ? null : perkPick),
      });
      status = e
        ? `spawned ${bossState.archetype?.id ?? '?'}${bossState.perk ? ` · ${bossState.perk.id}` : ' · no perk'} — "${bossState.name}"`
        : 'could not spawn a boss';
      // The name it actually got goes to the top of the list, so the thing in
      // the water and the thing you are reading are the same string.
      if (e) rolledNames = [bossState.name, ...rolledNames].slice(0, 12);
      render();
    }),
    button('Roll 12 names', () => {
      rolledNames = previewBossNames(12, {
        boss: bossPick === ROLL ? null : bossPick,
        perk: perkPick === ROLL || perkPick === NONE ? null : perkPick,
      });
      // ROLL is deliberately treated as "no perk" for the preview rather than
      // as "roll a perk per name": a list where each line came from a different
      // perk is unreadable as an answer to "does THIS combination read right".
      status = `rolled 12 · ${bossPick === ROLL ? 'any body' : bossPick} · ${perkPick === ROLL || perkPick === NONE ? 'no perk' : perkPick}`;
      render();
    }),
  );
  wrap.appendChild(buttons);

  namesEl = document.createElement('div');
  // Monospace column, dim, scrollable and capped — twelve names is enough to
  // judge a combination and short enough not to push the upgrade list off
  // screen, which is the panel's actual job.
  namesEl.style.cssText =
    `color:${C.dim};font-size:10px;line-height:1.5;max-height:150px;overflow:auto;`
    + 'white-space:pre;';
  wrap.appendChild(namesEl);

  return wrap;
}

// ---------------------------------------------------------------------------
// THE CREATURE BLOCK
// ---------------------------------------------------------------------------
// The same problem again, one layer DOWN. Which creature is in the water is a
// weighted roll gated by minDifficulty, minPlayerLevel, the day/night swap and
// two headcount caps, so "what does a megalodon look like next to the seal"
// costs eight minutes of run and a bit of luck — and the things you most want
// to compare (a shark against a great white, a school against one fish) are
// specifically the ones the spawner will not hand you together.
//
// It goes through spawnNamed at the run's CURRENT difficulty, so what arrives
// carries the hp, the speed and the size ramp of the minute you are standing
// in rather than a minute-one body wearing a late-run name. `ignoreCaps`,
// because refusing a shark when there are already six is the debug door
// declining to be a debug door — the caps are the thing you are trying to see
// past. maxAlive still binds (it is a memory bound, see spawnNamed).
//
// A SELECT RATHER THAN CHIPS, unlike every other row here: the roster is
// thirty-five bodies against the boss table's eight, and that many chips would
// push the upgrade list — the panel's actual job — off the bottom of the
// screen.
function creatureControls() {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;gap:5px;margin-top:3px;padding-top:6px;'
    + 'border-top:1px solid rgba(232,236,243,0.12);';

  const heading = document.createElement('div');
  heading.style.cssText = `color:${C.dim};letter-spacing:0.14em;font-size:9px;`;
  heading.textContent = 'CREATURE — SPAWN ANY ROSTER BODY';
  wrap.appendChild(heading);

  const bodyRow = row('body');
  creatureSelect = document.createElement('select');
  // autocomplete=off for the reason the stage bar's picker has it: a reload
  // otherwise restores the browser's idea of the selection while the module's
  // own state says something else, and the button then spawns the other one.
  creatureSelect.autocomplete = 'off';
  creatureSelect.style.cssText =
    'background:rgba(232,236,243,0.08);border:1px solid rgba(232,236,243,0.16);'
    + 'border-radius:5px;color:inherit;font:inherit;font-size:10px;padding:2px 5px;max-width:210px;';
  creatureSelect.addEventListener('change', () => {
    creaturePick = creatureSelect.value;
    render();
  });
  bodyRow.body.appendChild(creatureSelect);

  countRow = row('many');
  wrap.append(bodyRow.wrap, countRow.wrap);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;';
  buttons.append(
    button('Spawn creature', () => {
      const made = spawnCreature(creaturePick, creatureCount);
      status = made == null
        ? 'no scene — creature spawning is not wired'
        : (made
          ? `spawned ${made} × ${creaturePick} · ${enemies.length} in the water`
          : `nothing spawned — the arena is at spawn.maxAlive (${CONFIG.spawn.maxAlive})`);
      render();
    }),
    // Here as well as on the stage bar, because this is the panel you spawn
    // FROM: a comparison is set up by clearing the water and putting two
    // bodies in it, and reaching for another panel to do half of that is how
    // you end up judging a shark against yesterday's leftovers.
    button('Clear creatures', () => {
      const w = world();
      if (!w?.scene) { status = 'no scene — nothing to clear'; render(); return; }
      const n = enemies.length;
      resetEnemies(w.scene);
      status = `cleared ${n} creature${n === 1 ? '' : 's'}`;
      render();
    }),
  );
  wrap.appendChild(buttons);

  return wrap;
}

// ---------------------------------------------------------------------------
// THE ATTRACTOR STORM BLOCK
// ---------------------------------------------------------------------------
// Six candidate bullet-hell attacks built on the strange attractors the bait
// balls already swim — see systems/attractorStorm.js and attractorStorms.csv.
//
// A DIFFERENT PROBLEM FROM THE THREE BLOCKS ABOVE, and the reason this is a
// panel rather than a perk. Those three exist because the game rolls something
// and you want a specific outcome. Nothing rolls these at all: they are six
// designs and only one of them (or none) is going to be committed to a boss,
// and the only way to choose is to be in the water while one is happening.
// Putting them in the perk table to try them would mean shipping all six into
// the rotation to find out which one is worth shipping.
//
// ANCHORED ON THE BOSS IF THERE IS ONE, in the middle of the water if not. A
// storm is a boss attack and reads differently when it has a body at its
// centre — the saddle study in particular is a shape you are meant to want to
// swim into — but requiring a boss to be alive would make trying one a
// two-step job every time, and the first thing you want is just to see it.
function stormControls() {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;gap:5px;margin-top:3px;padding-top:6px;'
    + 'border-top:1px solid rgba(232,236,243,0.12);';

  const heading = document.createElement('div');
  heading.style.cssText = `color:${C.dim};letter-spacing:0.14em;font-size:9px;`;
  heading.textContent = 'ATTRACTOR STORM — STAGE A CANDIDATE ATTACK';
  wrap.appendChild(heading);

  stormRow = row('study');
  wrap.appendChild(stormRow.wrap);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;';
  buttons.append(
    button('Stage storm', () => {
      const w = world();
      if (!w?.scene) { status = 'no scene — storms are not wired'; render(); return; }
      // ON THE LIVE BOSS IF THERE IS ONE, and RIDING it — not merely centred
      // where it happens to be standing. Four of the six ship as perks and the
      // whole of what makes them a boss's attack rather than scenery is that
      // the field goes where the animal goes, so staging one any other way
      // would be judging a different thing from the one that ships.
      //
      // `bossState.enemy` is cleared the frame a boss dies, and the storm drops
      // the body itself the frame its hp reaches zero, so neither can be left
      // holding a creature on its way back to the pool.
      const boss = bossState.enemy ?? null;
      const staged = startAttractorStorm(w.scene, stormPick, null, { follow: boss });
      status = staged
        ? `staged ${staged.id} · ${staged.shape}/${staged.plane} · ${boss ? 'riding the boss' : 'mid-water'}`
        : `no study called ${stormPick}`;
      render();
    }),
    button('Stop storm', () => {
      const w = world();
      const was = activeAttractorStorm();
      stopAttractorStorm(w?.scene ?? null);
      // Cubes already in the air are NOT deleted — see steerCube. Said out
      // loud here because a Stop button that leaves things on screen looks
      // broken unless you know it is deliberate.
      status = was ? `stopped ${was} — cubes in the air fly on` : 'no storm staged';
      render();
    }),
  );
  wrap.appendChild(buttons);

  stormNoteEl = document.createElement('div');
  stormNoteEl.dataset.stormNote = '1';
  stormNoteEl.style.cssText = `color:${C.dim};font-size:10px;line-height:1.5;`;
  wrap.appendChild(stormNoteEl);

  return wrap;
}

// Every creature the ordinary spawner can send. Derived by SUBTRACTING the boss
// table rather than by listing the roster, so a new row in enemies.csv turns up
// here with nothing edited and a new boss stops appearing here for free — the
// block above already spawns bosses, and through the arrival ceremony, which is
// the only way a boss should ever enter the water.
function rosterKeys() {
  const bossBodies = new Set(bossArchetypes().map((b) => b.enemy));
  return Object.keys(CONFIG.enemies).filter((k) => !bossBodies.has(k));
}

/**
 * Put `count` of `key` in the water beside the seal.
 *
 * Exported for the same reason grantUpgrade is: the panel is buttons around
 * this function, and this is the half worth calling from the console.
 *
 * Returns how many actually arrived, or null if the scene is not wired yet.
 */
export function spawnCreature(key, count = 1) {
  const w = world();
  if (!w?.scene) return null;
  const origin = player.mesh?.position;
  if (!origin) return null;

  const made = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    const e = spawnNamed(w.scene, key, w.gameState?.difficulty ?? 0,
      { x: origin.x, y: origin.y }, { ignoreCaps: true });
    // maxAlive is the one limit spawnNamed still enforces here, so a null part
    // way through a batch means the arena is full, not that the key is wrong.
    if (!e) break;
    made.push(e);
  }
  if (!made.length) return 0;

  // LAID OUT AFTER THE FACT, because the spacing has to come from the body and
  // the body's size is not known until it exists: `radius` is the authored
  // radius times whatever assets.csv scaled the model by, so a megalodon needs
  // five times the gap a sardine does and neither number is in enemies.csv.
  //
  // Capped so the row fits the arena. Twelve sharks at their own spacing is 85
  // units of lineup in an 80-unit ocean, and the ones off the end would be
  // dragged back in by the wall clamp on the first frame into a heap — which
  // looks like the spawner is broken rather than like the row is too long.
  const radius = made[0].radius ?? 1;
  const spacing = Math.min(
    Math.max(2.5, radius * 2.4),
    (bounds.width - radius * 2) / Math.max(1, made.length - 1),
  );
  made.forEach((e, i) => {
    const x = origin.x + (i - (made.length - 1) / 2) * spacing;
    e.mesh.position.x = Math.max(bounds.left + e.radius, Math.min(bounds.right - e.radius, x));
    // Seabed dwellers go on the sand, at the height the crawl update rests
    // them at — `bounds.bottom + radius`, which for a crab is a resting height
    // and not a body size (see the note on chumRadius in enemyTable.js). A
    // crab handed three units of water instead falls out of the sky.
    //
    // Everything else is put clear of the seal rather than on top of it: a big
    // body spawned at the player's own position starts the fight already
    // touching, and contact damage is per second. Clamped under the surface,
    // because the seal is often at it and a shark is not an air-breather.
    e.mesh.position.y = (e.def?.floorSpawn || e.def?.behavior === 'crawl')
      ? bounds.bottom + e.radius
      : origin.y + 3 + radius;
    clampBelowSurface(e.mesh.position, e.radius);
    // `entering` suppresses the side walls for a creature walking on from off
    // screen; one placed deliberately inside the arena has already arrived.
    e.entering = false;
  });
  return made.length;
}

// A labelled row of chips. `content` lets the family row build its own buttons
// before the row exists; tier and element are filled in by render(), because
// both depend on state that changes while the panel is open.
function row(label, content = null) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:wrap;';
  const tag = document.createElement('div');
  tag.style.cssText = `color:${C.dim};letter-spacing:0.1em;font-size:9px;width:34px;flex:0 0 auto;`;
  tag.textContent = label.toUpperCase();
  wrap.appendChild(tag);
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
  if (content) body.append(...content);
  wrap.appendChild(body);
  return { wrap, body };
}

// ---------------------------------------------------------------------------
// THE SEARCH BOX
// ---------------------------------------------------------------------------
// Six family chips over fifty-six upgrades is a coarse instrument: `aoe` alone
// is nine rows, and the question is almost always "where is THAT one".
//
// BUILT ONCE, HERE, AND NEVER REBUILT — unlike every chip row above it, which
// render() throws away and remakes because each carries a selection a rebuilt
// chip would lose. An <input> is the opposite case: rebuilding one mid-keystroke
// drops the focus and the caret, so the field would accept exactly one letter
// and then go dead. That is why this hangs off the panel's construction and
// render() only ever re-runs the filter.
//
// IT MATCHES THE ID AS WELL AS THE NAME, and that is not a nicety — it is the
// only thing that finds a card that has not been written yet. A staged upgrade
// arrives as lorem (see CLAUDE.md), so its NAME is deliberately not the thing
// you would type; `bubbleJet` is. Family and description are in the haystack
// too, so "bubble" finds the jet through its description and "orbit" finds
// everything that circles the seal without anyone having to tag them.
function searchControl() {
  const r = row('find');
  const input = document.createElement('input');
  input.type = 'search';
  input.dataset.search = '1';
  input.placeholder = 'name, id, family, description';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText =
    'flex:1 1 auto;min-width:0;background:rgba(232,236,243,0.06);font:inherit;'
    + `color:${C.text};border:1px solid rgba(232,236,243,0.16);border-radius:4px;`
    + 'padding:2px 6px;outline:none;';
  input.addEventListener('input', () => { search = input.value; render(); });
  // ESCAPE CLEARS THE FIELD RATHER THAN CLOSING ANYTHING. It reaches this
  // handler at all only because the global pause key guards on isTextEntry,
  // which a text input satisfies — so Escape is genuinely free here, and
  // clearing is what a filtered list wants it for. The `u` toggle is guarded on
  // isTypingTarget for the same reason, which is why typing a name with a `u`
  // in it does not shut the panel.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !input.value) return;
    e.stopPropagation();
    search = '';
    input.value = '';
    render();
  });
  const clear = document.createElement('button');
  clear.textContent = '×';
  clear.title = 'Clear the search (Escape)';
  clear.style.cssText =
    'padding:1px 6px;border-radius:4px;cursor:pointer;font:inherit;background:transparent;'
    + `color:${C.dim};border:1px solid rgba(232,236,243,0.16);`;
  clear.addEventListener('click', () => {
    search = '';
    input.value = '';
    input.focus();
    render();
  });
  // The row's body is a wrapping flex box built for chips; the field wants the
  // width, so it gets a nowrap line of its own inside it.
  const line = document.createElement('div');
  line.style.cssText = 'display:flex;gap:4px;flex:1 1 auto;min-width:0;';
  line.append(input, clear);
  r.body.style.cssText = 'display:flex;flex:1 1 auto;min-width:0;';
  r.body.appendChild(line);
  return r.wrap;
}

// Does `def` match what is typed? Every term has to hit SOMETHING — so "aoe
// laser" narrows rather than widening, which is the behaviour of every search
// box a person has ever used and the opposite of a naive `includes` on the
// whole string.
function matchesSearch(def) {
  if (!search.trim()) return true;
  const hay = `${def.id ?? ''} ${def.name ?? ''} ${def.family ?? ''} ${def.desc ?? ''}`.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

// Derived from the table rather than listed here: `family` decides which damage
// bucket an upgrade pays into (see rarity.js), and a hardcoded list would
// quietly drop a new family instead of showing it.
function familyChips() {
  const families = [ALL, ...new Set(CONFIG.upgrades.map((u) => u.family).filter(Boolean))];
  return families.map((f) => chip(f, () => family === f, () => { family = f; render(); }));
}

function chip(label, isOn, onClick, color = null) {
  const b = document.createElement('button');
  b.textContent = label;
  b.dataset.chip = label;
  b.addEventListener('click', onClick);
  b.style.cssText =
    'padding:2px 7px;border-radius:4px;cursor:pointer;font:inherit;font-size:10px;'
    + 'letter-spacing:0.03em;background:transparent;color:inherit;'
    + 'border:1px solid rgba(232,236,243,0.16);';
  // Painted here rather than on a class, so a tier chip can carry the tier's
  // own colour out of rarities.csv — the same reason the cards do it inline.
  const on = isOn();
  b.dataset.on = on ? '1' : '';
  if (on) {
    const hex = color ?? 'rgba(232,236,243,0.9)';
    b.style.borderColor = hex;
    b.style.color = hex;
    b.style.background = 'rgba(232,236,243,0.1)';
  } else if (color) {
    b.style.color = `${color}`;
    b.style.opacity = '0.5';
  }
  return b;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  b.style.cssText =
    'padding:4px 8px;border-radius:5px;cursor:pointer;'
    + 'background:rgba(232,236,243,0.08);border:1px solid rgba(232,236,243,0.16);'
    + 'color:inherit;font:inherit;font-size:10px;letter-spacing:0.04em;';
  return b;
}

function setVisible(on) {
  visible = on;
  panel.style.display = on ? 'flex' : 'none';
  // Rendered on open rather than every frame. Nothing here moves on its own —
  // the only things that change the list are this panel's own buttons and a
  // level-up, and reopening after a level-up re-reads the counts.
  if (on) render();
}

// ---------------------------------------------------------------------------
// GRANTING
// ---------------------------------------------------------------------------


function owned(id) {
  return player.upgrades.filter((p) => p.id === id).length;
}

function atCap(def) {
  return def.maxStacks != null && owned(def.id) >= def.maxStacks;
}

/**
 * Hand the seal one stack of `id`.
 *
 * Exported because it is useful from the console too, and because it is the
 * half worth testing — the panel is buttons around this function.
 *
 * The cap is respected. An upgrade past its maxStacks is a state no run can
 * reach, so a bug found there is a bug nobody can hit, and the apply() chains
 * that step a level counter (`bounceLevel`, `garlicLevel`) read off tables
 * sized to the cap — walking past the end tells you nothing true.
 */
export function grantUpgrade(id, { rarity: tier = null } = {}) {
  const def = CONFIG.upgrades.find((u) => u.id === id);
  if (!def) {
    console.warn(`[upgrades] no upgrade called '${id}'`);
    return null;
  }
  if (atCap(def)) return null;

  // THE ELEMENT NEEDS NO DOOR ANY MORE. It used to be rolled and committed
  // here, before the stat block was rebuilt, because it lived in
  // systems/elements.js and a recompute could not produce it. There are four
  // cards now — one per element — and each writes `biolumElement` in its own
  // apply(), so granting the card grants the element by the same route a real
  // pick takes. Asking for a specific one means granting that card.

  const before = { ...player.stats };
  addUpgrade(def.id, tier ?? baseRarity());

  // Recorded so THIS RUN's balance panel attributes the ability's damage
  // instead of filing it under an upgrade the player never took. The run is
  // also stamped: a run with granted upgrades is not a playtest, and the
  // stored .jsonl is pooled across sessions, so it has to be possible to tell
  // the two apart later rather than wondering why one run had everything.
  if (playtest.isRecording()) {
    playtest.recordUpgrade(def.id, runTime());
    const run = playtest.currentRun();
    if (run) run.debugGranted = true;
  }

  return { def, before, after: { ...player.stats } };
}

/** Hand one stack back. Returns false if none was held. */
export function revokeUpgrade(id) {
  // The LAST one taken, so removing a stack from a ladder undoes the most
  // recent rung rather than the tier the first pick arrived at.
  let i = -1;
  for (let n = 0; n < player.upgrades.length; n++) if (player.upgrades[n].id === id) i = n;
  if (i < 0) return false;
  player.upgrades.splice(i, 1);
  recomputeStats();
  return true;
}

// What actually moved. Only the numbers, and only the ones that changed — a
// dump of the whole stat block is forty lines nobody reads, and the question
// being asked at the moment you click a card is "what did that do".
function diff(before, after) {
  const out = [];
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (typeof b !== 'number' || typeof a !== 'number' || a === b) continue;
    out.push(`${key} ${fmt(a)}→${fmt(b)}`);
  }
  return out;
}

function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 1 ? 3 : 2);
}

// ---------------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------------

function render() {
  if (!panel) return;

  const held = player.upgrades.length;
  headEl.textContent = '';
  const title = document.createElement('div');
  title.style.cssText = 'letter-spacing:0.14em;font-size:10px;opacity:0.65;';
  title.textContent = 'UPGRADES — GRANT ANY';
  const sub = document.createElement('div');
  sub.style.cssText = `color:${C.dim};margin-top:2px;`;
  const glow = activeElement();
  // How many rows the two filters are hiding. Without it a narrowed list looks
  // exactly like a short table, and the family chip is easy to leave set and
  // then forget about — which is the actual way this panel misleads people.
  const showing = CONFIG.upgrades
    .filter((u) => family === ALL || u.family === family)
    .filter(matchesSearch).length;
  const narrowed = showing !== CONFIG.upgrades.length;
  sub.textContent = `level ${player.level}  ·  ${held} pick${held === 1 ? '' : 's'} held`
    + (glow ? `  ·  glow: ${glow}` : '')
    + (narrowed ? `  ·  ${showing} of ${CONFIG.upgrades.length} shown` : '');
  headEl.append(title, sub);

  // TIER. Every row of rarities.csv, in ladder order, in its own colour.
  rarityRow.body.textContent = '';
  for (const tier of rarities()) {
    const hex = `#${((tier.color ?? 0xffffff) >>> 0).toString(16).padStart(6, '0')}`;
    rarityRow.body.appendChild(
      chip(tier.id, () => rarity === tier.id, () => { rarity = tier.id; render(); }, hex),
    );
  }

  // GLOW. A READOUT NOW, NOT A PICKER. It steered a roll, and there is no roll
  // — the four elements are four upgrades in the list above, so asking for one
  // means granting that card the same way you grant any other. What is left
  // worth saying is which one the run is carrying, because the other three are
  // out of the pool from that moment (see `exclusive` in config.js).
  elementRow.body.textContent = '';
  {
    const held = activeElement();
    const line = document.createElement('div');
    line.style.cssText = `color:${held ? '#eaf6ff' : C.dim};font-size:10px;`;
    line.textContent = held
      ? `${held} — the other three are out of the pool`
      : 'none yet — grant one of the four cards above';
    elementRow.body.appendChild(line);
  }

  familyRow.body.textContent = '';
  familyRow.body.append(...familyChips());

  // BOSS. Both rows are built from the tables rather than listed here, so a new
  // row in bosses.csv or bossPerks.csv turns up as a chip with nothing edited.
  bossRow.body.textContent = '';
  for (const id of [ROLL, ...bossArchetypes().map((b) => b.id)]) {
    bossRow.body.appendChild(chip(id, () => bossPick === id, () => { bossPick = id; render(); }));
  }
  perkRow.body.textContent = '';
  for (const id of [ROLL, NONE, ...bossPerkList().map((p) => p.id)]) {
    perkRow.body.appendChild(chip(id, () => perkPick === id, () => { perkPick = id; render(); }));
  }
  namesEl.textContent = rolledNames.join('\n');

  // STORM. Chips from the table for the same reason the boss ones are, and the
  // note under them is the row's own `notes` cell — six designs is more than
  // anybody holds in their head between sessions, and the difference between
  // them is the thing being judged.
  stormRow.body.textContent = '';
  const storms = attractorStormList();
  for (const s of storms) {
    stormRow.body.appendChild(chip(s.id, () => stormPick === s.id, () => {
      stormPick = s.id;
      render();
    }));
  }
  const live = activeAttractorStorm();
  const picked = storms.find((s) => s.id === stormPick);
  // Says whether this study SHIPS as something, which is the first thing you
  // want to know about it. Four are perks and roll onto ordinary bosses like
  // the beam and the aura do; the two Thomas ones are being kept back for a
  // boss of their own and reach the water only through this button.
  const where = picked && STORM_PERKS.has(picked.id)
    ? 'boss perk · also in the perk row above'
    : 'panel only — no boss rolls this';
  stormNoteEl.textContent = picked
    ? `${live === picked.id ? '▶ live · ' : ''}${where} · ${picked.notes ?? ''}`
    : 'attractorStorms.csv has no usable rows';

  // CREATURE. Rebuilt from the roster for the same reason the boss chips are,
  // and the selection is re-asserted afterwards: rebuilding the options drops
  // the browser's idea of which one is chosen, and a picker showing one body
  // while the button spawns another is worse than no picker.
  creatureSelect.textContent = '';
  for (const key of rosterKeys()) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.dataset.creature = key;
    opt.textContent = key;
    creatureSelect.appendChild(opt);
  }
  creatureSelect.value = creaturePick;
  countRow.body.textContent = '';
  // A school arrives 4-9 strong (see the group blocks in config.js), so the
  // counts step across that: one body to look at, three to read a shape, and
  // six or twelve for what a school actually feels like coming at you.
  for (const n of [1, 3, 6, 12]) {
    countRow.body.appendChild(
      chip(String(n), () => creatureCount === n, () => { creatureCount = n; render(); }),
    );
  }

  // THE LIST. Table order, not alphabetical: upgrades.csv is the order the
  // designer put them in, and a list that reorders itself is one you have to
  // re-read every time.
  listEl.textContent = '';
  // The chip and the box compose. Both are narrowing, so a search that finds
  // nothing while a family is selected is usually the family, not the term —
  // which is what the empty state below says rather than leaving you to guess.
  const byFamily = CONFIG.upgrades.filter((u) => family === ALL || u.family === family);
  const rows = byFamily.filter(matchesSearch);
  for (const def of rows) listEl.appendChild(upgradeRow(def));
  // AN EMPTY LIST HAS TO SAY SO. A blank panel reads as broken, and the one
  // thing it must never do is let a typo look like an upgrade that is missing
  // from the table.
  if (!rows.length) {
    const none = document.createElement('div');
    none.dataset.empty = '1';
    none.style.cssText = `color:${C.dim};padding:10px 6px;`;
    none.textContent = search.trim()
      ? `nothing matches "${search.trim()}"`
        + (family === ALL ? '' : ` in ${family} — ${byFamily.length} row${byFamily.length === 1 ? '' : 's'} here, ${CONFIG.upgrades.length} in the table`)
      : 'no upgrades in this family';
    listEl.appendChild(none);
  }

  statusEl.textContent = status;
  statusEl.title = status;
}

function upgradeRow(def) {
  const have = owned(def.id);
  const capped = atCap(def);

  const wrap = document.createElement('div');
  wrap.dataset.upgrade = def.id;
  wrap.style.cssText =
    'display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:6px;'
    + `background:${have ? 'rgba(126,224,129,0.07)' : 'transparent'};`
    + 'border-bottom:1px solid rgba(232,236,243,0.06);';

  const text = document.createElement('div');
  text.style.cssText = 'flex:1 1 auto;min-width:0;';

  const name = document.createElement('div');
  name.style.cssText = `color:${have ? C.ok : C.text};`;
  const cap = def.maxStacks != null ? `/${def.maxStacks}` : '';
  name.textContent = `${def.name}${have || def.maxStacks != null ? `  ${have}${cap}` : ''}`;
  // `enabled: FALSE` upgrades are the ones this panel is most for — they cannot
  // be dealt at all — so they are listed and grantable, and merely marked.
  if (def.enabled === false) {
    const off = document.createElement('span');
    off.style.cssText = `color:${C.warn};font-size:9px;margin-left:6px;letter-spacing:0.08em;`;
    off.textContent = 'NOT DEALT';
    name.appendChild(off);
  }

  const desc = document.createElement('div');
  desc.style.cssText = `color:${C.dim};font-size:10px;`;
  // The description for the stack this click would GRANT, not for the first
  // one — the same expandDesc the card uses, with the same `owned`, so what the
  // panel promises and what the card promises can't drift.
  desc.textContent = expandDesc(def.levelDescs?.[have + 1] ?? def.desc, def, { owned: have });

  const id = document.createElement('div');
  id.style.cssText = `color:${C.off};font-size:9px;`;
  id.textContent = `${def.id}${def.family ? ` · ${def.family}` : ''}`;

  text.append(name, desc, id);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:4px;flex:0 0 auto;';
  const minus = button('−', () => {
    if (revokeUpgrade(def.id)) {
      status = `−1 ${def.name} (now ${owned(def.id)})`;
      render();
    }
  });
  minus.style.padding = '2px 8px';
  minus.style.visibility = have ? 'visible' : 'hidden';
  const plus = button(capped ? 'max' : '+1', () => {
    const result = grantUpgrade(def.id, { rarity });
    if (!result) return;
    const moved = diff(result.before, result.after);
    status = `+1 ${def.name} [${rarityById(rarity)?.name ?? rarity}] — `
      + (moved.length ? moved.join('  ') : 'no stat change (ability state)');
    render();
  });
  plus.style.padding = '2px 8px';
  if (capped) {
    plus.disabled = true;
    plus.style.opacity = '0.35';
    plus.style.cursor = 'default';
  }
  buttons.append(minus, plus);

  wrap.append(text, buttons);
  return wrap;
}

// ---------------------------------------------------------------------------
// For the harness, and for anything that wants the panel open without a
// keyboard. Same reasoning as sfxDebugState(): the behaviour worth testing is
// the granting, and none of it should have to be read back out of the DOM.
// ---------------------------------------------------------------------------

export function setUpgradeDebugVisible(on) {
  if (panel) setVisible(!!on);
}

export function upgradeDebugState() {
  return {
    visible,
    rarity,
    // The element the RUN is carrying, read off the stat block rather than a
    // picker's state — there is nothing to pick any more, and a panel reporting
    // its own dead field would be reporting a choice nobody can make.
    element: activeElement(),
    family,
    search,
    status,
    creature: creaturePick,
    count: creatureCount,
    held: player.upgrades.map((p) => ({ id: p.id, rarity: p.rarity })),
  };
}

/** Panel state the keyboard also drives, so a test can set it without a click. */
export function setUpgradeDebugChoice({
  rarity: tier, family: fam, creature, count, search: term,
} = {}) {
  if (tier !== undefined) rarity = tier;
  if (fam !== undefined) family = fam;
  // The field is NOT written back from here. This seam sets what the panel
  // filters on; the input's own value is the person's, and a setter that
  // stamped over it would make the box and the list disagree the moment a test
  // ran alongside one. The harness drives the real listener separately.
  if (term !== undefined) search = term;
  if (creature !== undefined) creaturePick = creature;
  if (count !== undefined) creatureCount = count;
  if (visible) render();
}
