#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE BLUBBERBALL TEAM SELECT, headless. ui/teamSelect.js is a DOM screen
// driven by every pad at once plus the keyboard, and what it writes is
// versusSetup — which input.js, p2Pad and the bot then read. All of that is
// measurable in jsdom with fake Gamepad lists handed to updateTeamSelect.
//
//   JOINING       push right on a pad and its chip is on the right; a second
//                 pad cannot take a side that has a captain.
//   THE KEYBOARD  is left-only, because input.js is player 1's.
//   COLOURS       the captains step round the wheel, and can never land on
//                 the same swatch.
//   START         only when every side with a person is ready; an empty side
//                 is the CPU; the setup written is what the match reads.
//   THE MATCH     p2Pad and player 1's pad pick follow the setup, not the
//                 by-index rule, and a CPU side is the bot.
//   THE CAST      seat 0 wears the name off the splash and has no dice; every
//                 other seat is rolled, re-rollable, and distinct.
//   THE KIT       every seat has a tile saying what it wears, and clicking it
//                 steps the ring — seat 0's being the player's own slot.
//
// jsdom first, then the loader — see the jsdom-harness recipe.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);

await import('./vite-loader.mjs');
const { CONFIG } = await import('../path/src/config.js');
const ts = await import('../path/src/ui/teamSelect.js');
const flag = await import('../path/src/systems/versusFlag.js');
const { p2Pad } = await import('../path/src/systems/versus.js');
const { botWanted } = await import('../path/src/systems/versusBot.js');
const { teamColor } = await import('../path/src/systems/ballLook.js');
const { pollPads } = await import('../path/src/ui/padPoll.js');
const { savePlayerName, playerName } = await import('../path/src/systems/playerName.js');
const roster = await import('../path/src/systems/sealRoster.js');
const cast = await import('../path/src/systems/rosterCast.js');
const acc = await import('../path/src/systems/accessories.js');
const { uiText } = await import('../path/src/uiTextTable.js');
const rules = await import('../path/src/systems/matchRules.js');
const { setUnlockGate } = await import('../path/src/systems/unlocks.js');

// A fake pad in navigator.getGamepads() shape. `press` names buttons held
// this frame; `x`/`y` the left stick.
function pad(index, { a = false, b = false, start = false, x = 0, y = 0, dpad = null } = {}) {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  if (a) buttons[0] = { pressed: true, value: 1 };
  if (b) buttons[1] = { pressed: true, value: 1 };
  if (start) buttons[9] = { pressed: true, value: 1 };
  if (dpad === 'left') buttons[14] = { pressed: true, value: 1 };
  if (dpad === 'right') buttons[15] = { pressed: true, value: 1 };
  if (dpad === 'up') buttons[12] = { pressed: true, value: 1 };
  if (dpad === 'down') buttons[13] = { pressed: true, value: 1 };
  return { index, connected: true, id: `pad ${index}`, mapping: 'standard', axes: [x, y, 0, 0], buttons };
}
// A press is a frame down and a frame up, so the next one is a fresh edge.
function tap(list) { ts.updateTeamSelect(list); ts.updateTeamSelect(list.map((p) => pad(p.index))); }
function key(k) { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }
const devs = () => ts.teamSelectState().devices;
// The screen's own stylesheet, as it was injected — the transform that composes
// the placement, the pick and the beat is in there and nowhere else.
const styleText = () => [...document.head.querySelectorAll('style')].map((n) => n.textContent).join('\n');
const dev = (key) => devs().find((d) => d.key === key);

// ---------------------------------------------------------------------------
section('The poll turns held buttons into presses, once');
{
  const prev = new Map();
  let r = pollPads(prev, [pad(0, { a: true, x: 0.9 })]);
  check('a held A is a press on the first frame', r[0].press.a && r[0].press.right);
  r = pollPads(prev, [pad(0, { a: true, x: 0.9 })]);
  check('...and not on the second', !r[0].press.a && !r[0].press.right);
  r = pollPads(prev, [pad(0, { x: 0.45 })]);
  check('the stick eased back inside the band is still held, not re-pressed', !r[0].press.right);
  r = pollPads(prev, [pad(0, { x: 0.9 })]);
  check('...so pushing it again is not a new press either', !r[0].press.right);
  r = pollPads(prev, [pad(0)]);
  r = pollPads(prev, [pad(0, { x: 0.9 })]);
  check('but released and pushed is', r[0].press.right);
  pollPads(prev, []);
  check('a pad that has gone is dropped from the memory', prev.size === 0);
}

// ---------------------------------------------------------------------------
section('Opening: the keyboard is in the pool, the sides are the CPU\'s, Start is dead');
let started = null; let backs = 0;
const open = () => ts.showTeamSelect({ parent: document.body, onStart: (s) => { started = s; }, onBack: () => { backs++; } });
open();
const root = document.getElementById('svTeamSelect');
check('the screen is mounted and shown', !!root && !root.classList.contains('sv-hidden'));
check('the keyboard is the only device, in the pool', devs().length === 1 && dev('keyboard')?.side === -1);
check('both columns read as the CPU\'s', root.querySelectorAll('.sv-teams-side.sv-teams-cpu').length === 2);
check('Start is disabled with nobody on a side', root.querySelector('#svTeamStart').disabled);
check('each column draws four slots, three of them locked',
  [...root.querySelectorAll('.sv-teams-side')].every((n) => n.querySelectorAll('.sv-teams-slot').length === flag.MAX_PER_SIDE && n.querySelectorAll('.sv-teams-locked').length === flag.MAX_PER_SIDE - 1));
// NOBODY IS ON A COLOUR. The screen used to open with both sides matched to
// the shipped green and red by hue, which made the wheel a thing you could
// ignore — and made the commonest match in the game one whose colours nobody
// chose. An unpicked side's light walks the ring instead, and what it has
// landed on at Start is what that side plays in.
check('neither side opens on a colour', ts.teamSelectState().picks[0] == null && ts.teamSelectState().picks[1] == null,
  JSON.stringify(ts.teamSelectState().picks));
check('...so no swatch is drawn as chosen',
  root.querySelectorAll('.sv-teams-swatch.sv-teams-picked').length === 0,
  `${root.querySelectorAll('.sv-teams-swatch.sv-teams-picked').length} drawn as picked`);
check('no id shows through as a label',
  ![...root.querySelectorAll('.sv-title, .sv-btn, .sv-teams-chip')].some((n) => /^(team|sport|sealSports)/.test(n.textContent.trim())));

// ---------------------------------------------------------------------------
section('A pad arrives on its first press, and that press is spent');
tap([pad(0, { dpad: 'right' })]);
check('pad 1 is now a device in the pool', dev('pad0')?.side === -1, JSON.stringify(dev('pad0')));
tap([pad(0, { dpad: 'right' })]);
check('the next push right walks it onto the right side', dev('pad0')?.side === 1);
check('the right column is no longer the CPU\'s', !root.querySelectorAll('.sv-teams-side')[1].classList.contains('sv-teams-cpu'));

// ---------------------------------------------------------------------------
section('One captain a side, and the keyboard stays left');
tap([pad(0), pad(1, { dpad: 'right' })]);           // pad 2 arrives
tap([pad(0), pad(1, { dpad: 'right' })]);           // and pushes right
check('a second pad cannot take a side with a captain', dev('pad1')?.side === -1);
key('ArrowRight');
check('the keyboard refuses the right side', dev('keyboard')?.side === -1);
key('ArrowLeft');
check('...and takes the left', dev('keyboard')?.side === 0);
tap([pad(0), pad(1, { dpad: 'left' })]);
check('so pad 2 cannot have the left either', dev('pad1')?.side === -1);
check('Start is still dead: nobody is ready', root.querySelector('#svTeamStart').disabled);

// ---------------------------------------------------------------------------
section('Captains pick colours, and never the same one');
{
  const before = ts.teamSelectState().picks;
  tap([pad(0, { dpad: 'down' }), pad(1)]);
  const after = ts.teamSelectState().picks;
  check('down steps the right captain\'s colour', after[1] !== before[1] && after[0] === before[0], `${before} -> ${after}`);
  // Walk the left captain all the way round: it must skip the right's pick.
  const n = CONFIG.versus.wheel.length;
  const landed = new Set();
  for (let i = 0; i < n + 1; i++) { key('ArrowUp'); landed.add(ts.teamSelectState().picks[0]); }
  check('the left captain visits every swatch but the right\'s', landed.size === n - 1 && !landed.has(ts.teamSelectState().picks[1]), `${[...landed].sort((p, q) => p - q)}`);
  const takenSwatch = root.querySelectorAll('.sv-teams-side')[0].querySelector('.sv-teams-swatch.sv-teams-taken');
  check('the other side\'s pick is drawn dimmed on this wheel', !!takenSwatch && Number(takenSwatch.dataset.i) === ts.teamSelectState().picks[1]);
}

// ---------------------------------------------------------------------------
section('Ready, then Start');
key('Enter');
check('Enter readies the keyboard captain', dev('keyboard')?.ready === true);
check('...stamped on the chip', !!root.querySelector('.sv-teams-side[data-side="0"] .sv-teams-stamp'));
key('ArrowUp');
const pickHeld = ts.teamSelectState().picks[0];
key('ArrowUp');
check('a ready captain cannot change colour', ts.teamSelectState().picks[0] === pickHeld);
check('Start is dead while the right captain is not ready', root.querySelector('#svTeamStart').disabled);
tap([pad(0, { start: true }), pad(1)]);
check('...and Start on a pad does nothing then', started === null);
tap([pad(0, { a: true }), pad(1)]);
check('A readies the right captain', dev('pad0')?.ready === true);
check('now Start is live', !root.querySelector('#svTeamStart').disabled);
tap([pad(0), pad(1, { start: true })]);
check('Start on ANY pad starts it', !!started);
check('the screen closed itself', root.classList.contains('sv-hidden'));

// ---------------------------------------------------------------------------
section('What was written is what the match reads');
{
  const t = flag.versusSetup.teams;
  check('left is the keyboard, human', t[0].members[0]?.kind === 'human' && t[0].members[0]?.pad === flag.KEYBOARD);
  check('right is pad 1 (index 0), human', t[1].members[0]?.kind === 'human' && t[1].members[0]?.pad === 0);
  check('the colours are the picks, off the wheel', t[0].color === CONFIG.versus.wheel[ts.teamSelectState().picks[0]] && t[1].color === CONFIG.versus.wheel[ts.teamSelectState().picks[1]]);
  check('teamColor reads the pick over CONFIG', teamColor(0) === t[0].color && teamColor(1) === t[1].color && teamColor(0) !== CONFIG.versus.teams[0].color);
  check('captainPad: left is the keyboard (no pad), right is pad 0', flag.captainPad(0) === null && flag.captainPad(1) === 0);
  // p2Pad follows the setup, NOT "second by index": with pads 0 and 3
  // connected the old rule would hand player 2 pad 3.
  const list = [pad(0), null, null, pad(3)];
  check('p2Pad is the right captain\'s pad, whatever the index order', p2Pad(list)?.index === 0);
  check('...and nothing if that pad has gone', p2Pad([pad(3)]) === null);
  check('a human on the right is not the bot', botWanted(true) === false);
}

// ---------------------------------------------------------------------------
section('An empty side is the CPU, and one person is enough');
started = null;
open();
key('ArrowLeft');
key('Enter');
check('keyboard on the left, ready, nobody on the right: Start is live', !root.querySelector('#svTeamStart').disabled);
root.querySelector('#svTeamStart').click();
check('Start starts it', !!started);
check('the right captain is the CPU', flag.captainIsCpu(1) && flag.captainPad(1) === null);
check('...so the bot wants the side, pad or no pad', botWanted(true) === true && botWanted(false) === true);
check('and p2Pad hands it no pad even with two plugged in', p2Pad([pad(0), pad(1)]) === null);

// ---------------------------------------------------------------------------
// THE CAST. The whole point of showing names on this screen is that the goal
// card will say them, so the two must be the same list — and the name the
// player already chose for themselves on the splash has to be one of them.
// Rolling every seat at kickoff (which is what versus.js used to do) threw
// that away every match and made the goal card the first place any of these
// names had ever appeared.
section('Every seat has a name, and every seat but the player\'s has a dice');
{
  savePlayerName('Fat Tony');
  roster.setRosterSize(3);
  open();
  const slotsOf = (side) => [...root.querySelectorAll(`.sv-teams-side[data-side="${side}"] .sv-teams-slot`)];
  const nameIn = (n) => n.querySelector('.sv-teams-name-text')?.textContent ?? null;
  const left = slotsOf(0);
  const right = slotsOf(1);
  check('the roster row grew real slots out of the locked ones',
    left.filter((n) => !n.classList.contains('sv-teams-locked')).length === 3,
    `${left.filter((n) => n.classList.contains('sv-teams-locked')).length} still locked of ${flag.MAX_PER_SIDE}`);
  check('seat 0 wears the name off the splash', nameIn(left[0]) === playerName(), `${nameIn(left[0])} vs ${playerName()}`);
  check('...and has no dice on it', !left[0].querySelector('.sv-teams-dice'));
  check('every other seat is named', [...left.slice(1, 3), ...right.slice(0, 3)].every((n) => (nameIn(n) ?? '').length > 0));
  check('...and every one of them has a dice',
    [...left.slice(1, 3), ...right.slice(0, 3)].every((n) => !!n.querySelector('.sv-teams-dice')),
    `${root.querySelectorAll('.sv-teams-dice').length} dice for ${roster.rosterSize()} seats`);
  check('no id shows through on the dice\'s label',
    ![...root.querySelectorAll('.sv-teams-dice')].some((n) => /^team/.test(n.title)), root.querySelector('.sv-teams-dice')?.title);
  const before = cast.rosterNames();
  check('no two seals share a name', new Set(before).size === before.length, before.join(', '));
  // THE DICE. Only its own seat moves — a re-roll that recast the side, or the
  // player, would be a button nobody could use twice.
  right[1].querySelector('.sv-teams-dice').click();
  const after = cast.rosterNames();
  const moved = after.map((n, i) => (n === before[i] ? null : i)).filter((i) => i != null);
  check('a dice re-rolls exactly one seat', moved.length === 1, `seats [${moved}] changed`);
  check('...and never the player\'s own', after[0] === playerName());
  check('the screen re-reads it rather than keeping the old string',
    nameIn(slotsOf(1)[1]) === after[moved[0]], nameIn(slotsOf(1)[1]));
  // ...AND THE MATCH READS THE SAME LIST. syncRosterCast is what startVersus
  // calls; it must not re-cast what the screen already settled.
  const again = cast.syncRosterCast();
  check('the match gets the cast the screen showed', again.join('|') === after.join('|'), again.join(', '));
  roster.setRosterSize(1);
  ts.hideTeamSelect();
}

// ---------------------------------------------------------------------------
// WHAT EACH SEAL WEARS. Seat 0's tile is the PLAYER'S slot — the one the main
// menu's drawer writes and localStorage remembers — so the two screens cannot
// disagree about what the player has on. Every other seat has one of its own,
// meaning nothing outside a match.
section('Every seat has a tile saying what it wears, and clicking it changes it');
{
  // The gate off, so the whole wardrobe is available to a harness that has
  // earned nothing. With it on the ring is just the bare seal and every check
  // below would pass vacuously — which is the shape of test this would be
  // easiest to write by accident.
  setUnlockGate(false);
  roster.setRosterSize(2);
  cast.resetRosterCast();
  open();
  // BY SEAT, not by document order — the columns are SIDES, so the tiles come
  // out 0, 2, 1, 3 and an index into the list is a different seat from the one
  // you meant. Each control carries its seat, which is what makes that
  // impossible to get wrong here.
  const kits = () => [...root.querySelectorAll('.sv-teams-kit')];
  const kitAt = (seat) => root.querySelector(`.sv-teams-kit[data-seat="${seat}"]`);
  check('every seat has a tile', kits().length === roster.rosterSize(), `${kits().length} tiles for ${roster.rosterSize()} seats`);
  check('the ring is more than the bare seal, so these clicks mean something',
    acc.accessoryRoster(true).length > 1, `${acc.accessoryRoster(true).length} unlocked`);
  check('a seat nobody has dressed is bare', cast.seatAccessory(1) === '', cast.seatAccessory(1));
  check('...and its tile says so rather than showing nothing',
    (kitAt(1).getAttribute('aria-label') ?? '').length > 0, kitAt(1).getAttribute('aria-label'));
  check('every tile says which seat it belongs to', kits().every((n) => Number.isInteger(Number(n.dataset.seat))));
  check('no id shows through on a tile\'s label',
    !kits().some((n) => /^accessory[A-Z]/.test(n.title)), kits().map((n) => n.title).join(' / '));
  // ONE SEAT MOVES. A tile that stepped the whole side, or the player, would be
  // a control nobody could use twice.
  const before = cast.rosterKit();
  kitAt(1).click();
  const after = cast.rosterKit();
  const moved = after.map((k, i) => (k === before[i] ? null : i)).filter((i) => i != null);
  check('a tile steps exactly its own seat', moved.length === 1 && moved[0] === 1, `seats [${moved}] changed`);
  check('...forward through the ring', after[1] === acc.accessoryRoster(true)[0], after[1]);
  check('the tile re-reads it rather than keeping the old picture',
    kitAt(1).getAttribute('aria-label') !== before[1] && kitAt(1).getAttribute('aria-label').length > 0);
  // ...AND BACK. A ring of a dozen is not eleven clicks away from the one you
  // just passed: shift-click and right-click both step backwards.
  kitAt(1).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  check('shift steps back', cast.seatAccessory(1) === '', cast.seatAccessory(1));
  // SEAT 0 IS THE PLAYER'S OWN SLOT, not a copy of it.
  const slotWas = CONFIG.accessories.equipped;
  kitAt(0).click();
  check('seat 0\'s tile writes the slot the drawer writes',
    CONFIG.accessories.equipped !== slotWas && cast.seatAccessory(0) === acc.wornAccessory(),
    `${slotWas} -> ${CONFIG.accessories.equipped}`);
  check('...and moved nothing else', cast.rosterKit().slice(1).every((k) => k === ''), cast.rosterKit().join(' / '));
  acc.equipAccessory(slotWas);
  setUnlockGate(true);
  roster.setRosterSize(1);
  ts.hideTeamSelect();
}

// ---------------------------------------------------------------------------
// THE WHEEL — two rings, and a pulse on the quarter note of whatever is
// playing. This screen starts the match's own bank at the match's own tempo,
// so the beat the dots flash on is the one the match will be played to.
section('The colour wheel is one circle, and one dot keeps time on it');
{
  open();
  const wheels = [...root.querySelectorAll('.sv-teams-wheel')];
  const swatches = () => [...wheels[0].querySelectorAll('.sv-teams-swatch')];
  check('every colour on the wheel is a swatch',
    swatches().length === CONFIG.versus.wheel.length, `${swatches().length} of ${CONFIG.versus.wheel.length}`);
  // HOW MANY FIT IS MEASURED, not chosen — see the note on CONFIG.versus.wheel.
  // One dot lights at a time and swells while it is lit, and past `wheelMax`
  // the light overlaps its neighbours and reads as a smear across three rather
  // than as a thing keeping time. A list grown past it is caught here rather
  // than shipped crowded.
  check('...and there are no more of them than the ring can hold',
    CONFIG.versus.wheel.length <= (CONFIG.versus.wheelMax ?? 12),
    `${CONFIG.versus.wheel.length} of a measured ${CONFIG.versus.wheelMax ?? 12}`);
  // ...AND A LAP IS A WHOLE NUMBER OF BARS. The light steps once per quarter
  // note, so a count that is not a multiple of the bar puts the light in a
  // different place on every downbeat and the ring drifts against the music.
  check('...and a lap lands back on a downbeat', CONFIG.versus.wheel.length % 4 === 0,
    `${CONFIG.versus.wheel.length} beats a lap, ${CONFIG.versus.wheel.length / 4} bars`);
  // ONE CIRCLE. The placement is in wheel-relative units so the ring scales
  // with the screen; every dot has to be the same distance out or it is rings
  // again.
  {
    const shares = new Set(swatches().map((n) => {
      const m = (n.style.getPropertyValue('--at') || '').match(/calc\(var\(--wheel\) \* ([-\d.]+)\).*calc\(var\(--wheel\) \* ([-\d.]+)\)/);
      return m ? Math.hypot(Number(m[1]), Number(m[2])).toFixed(3) : 'px';
    }));
    check('...laid out on a single circle', shares.size === 1 && !shares.has('px'), `radii ${[...shares].join(', ')}`);
  }
  // THE LIGHT. beatGrid reports nothing running in a harness (there is no audio
  // context), and the wheel has to be dark for that — a screen that kept time
  // to music nobody can hear is worse than one that does nothing.
  ts.updateTeamSelect([]);
  check('with no music playing, no dot is lit',
    swatches().every((n) => Number(n.style.getPropertyValue('--beat')) === 0),
    swatches().map((n) => n.style.getPropertyValue('--beat')).filter((v) => Number(v) > 0).length + ' lit');
  // ...AND ONE AT A TIME WHEN IT IS. Driven through the module's own render
  // rather than by faking a transport: what is checked is that the wheel lights
  // exactly one dot for a given beat and that the dot MOVES with the beat.
  {
    const lit = (beats) => {
      ts.pulseTo({ running: true, beat: 0.353, beats, phase: beats % 1 });
      return swatches().map((n) => Number(n.style.getPropertyValue('--beat'))).map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    };
    const a = lit(0);
    check('one dot is lit, and only one', a.length === 1, `${a.length} lit at beat 0`);
    check('...and the next beat lights the next one round', lit(1)[0] === (a[0] + 1) % swatches().length,
      `${a[0]} then ${lit(1)[0]}`);
    check('...and a lap comes back to where it started',
      lit(swatches().length)[0] === a[0], `${lit(swatches().length)[0]} vs ${a[0]}`);
    // THE COUNT IS DERIVED FROM THE CLOCK, not incremented per crossing: a
    // wheel that stepped on each boundary it noticed would drift by a beat for
    // every frame dropped and never recover. Jumping the clock forward by a
    // hundred beats has to land exactly where counting to a hundred would.
    check('...and a dropped frame does not put it out of step',
      lit(100)[0] === 100 % swatches().length, `${lit(100)[0]} after a jump to beat 100`);
    ts.pulseTo(null);
  }
  ts.hideTeamSelect();
}

// ---------------------------------------------------------------------------
// PRESSING NOTHING IS STILL AN ANSWER — it is just the one the music gave. An
// unpicked side's light walks the ring on the quarter note, and Start takes
// whatever it had landed on.
section('An unpicked side\'s light walks the ring, and Start takes where it stopped');
{
  open();
  // RE-QUERIED EVERY TIME, never held. render() rebuilds the swatches — a
  // click, a roster step, anything — so a node captured before one is detached
  // and will never change again: every check against it reads the state the
  // screen was in before the thing under test happened, and passes or fails on
  // that. (In the game pulse() runs on the next frame and repaints the live
  // ones, which is why nothing is wrong on screen.)
  const wheelAt = (side) => [...root.querySelectorAll('.sv-teams-wheel')][side];
  const swatches = (side) => [...wheelAt(side).querySelectorAll('.sv-teams-swatch')];
  const litOn = (side) => swatches(side)
    .map((n, i) => (Number(n.style.getPropertyValue('--beat')) > 0 ? i : -1)).filter((i) => i >= 0);
  const at = (beats) => { ts.pulseTo({ running: true, beat: 0.353, beats, phase: beats % 1 }); };
  // ONE LIGHT A SIDE, and they are not the same light: given the same beat two
  // sides walking the same way would light the same colour all the way round,
  // which reads as one light drawn twice — and would make the commonest
  // outcome of pressing nothing two teams in the same kit.
  at(0);
  check('each side has a light of its own', litOn(0).length === 1 && litOn(1).length === 1,
    `${litOn(0).length} / ${litOn(1).length}`);
  check('...and they are not on the same colour', litOn(0)[0] !== litOn(1)[0],
    `${litOn(0)[0]} vs ${litOn(1)[0]}`);
  // ...AND THEY MOVE, on the beat, opposite ways round the ring.
  const a0 = litOn(0)[0]; const b0 = litOn(1)[0];
  at(1);
  check('the next beat moves both', litOn(0)[0] !== a0 && litOn(1)[0] !== b0,
    `${a0}->${litOn(0)[0]} and ${b0}->${litOn(1)[0]}`);
  check('...the two of them opposite ways round',
    Math.sign(litOn(0)[0] - a0) !== Math.sign(litOn(1)[0] - b0),
    `${a0}->${litOn(0)[0]} vs ${b0}->${litOn(1)[0]}`);
  // A PICK STOPS THAT SIDE, and only that side.
  swatches(0)[3].click();
  check('clicking a swatch picks it', ts.teamSelectState().picks[0] === 3, `${ts.teamSelectState().picks[0]}`);
  at(2);
  check('...and that side\'s light stops', litOn(0).length === 0, `${litOn(0).length} still lit`);
  check('...while the other side keeps walking', litOn(1).length === 1);
  check('...and the picked swatch is drawn as chosen',
    swatches(0)[3].classList.contains('sv-teams-picked')
    && root.querySelectorAll('.sv-teams-swatch.sv-teams-picked').length === 1);
  // THE OTHER SIDE CANNOT LAND ON IT. The light walks a list that never
  // contained the taken colour, so it cannot pause on a beat it skipped.
  {
    const seen = new Set();
    for (let b = 0; b < CONFIG.versus.wheel.length * 2; b++) { at(b); seen.add(litOn(1)[0]); }
    check('the walking side never lands on the taken colour', !seen.has(3), `visited ${[...seen].sort((p, q) => p - q).join(' ')}`);
    check('...and does visit every other one', seen.size === CONFIG.versus.wheel.length - 1,
      `${seen.size} of ${CONFIG.versus.wheel.length - 1}`);
  }
  // ...AND THE PITCH BEHIND THE SCREEN IS ALREADY WEARING IT. Without this the
  // seals in the water show the CONFIG default — green and red — which is the
  // "defaults to a team colour" this screen no longer does.
  {
    at(7);
    const shown = litOn(1)[0];
    check('an unpicked side tells the match what its light is on',
      flag.versusSetup.teams[1].color === CONFIG.versus.wheel[shown],
      `#${(flag.versusSetup.teams[1].color ?? 0).toString(16)} vs swatch ${shown}`);
    check('...and the picked side tells it the pick',
      flag.versusSetup.teams[0].color === CONFIG.versus.wheel[3],
      `#${(flag.versusSetup.teams[0].color ?? 0).toString(16)}`);
    check('...neither of them the config default',
      flag.versusSetup.teams[0].color !== CONFIG.versus.teams[0].color
      || flag.versusSetup.teams[1].color !== CONFIG.versus.teams[1].color);
  }
  // START TAKES WHERE IT STOPPED.
  at(5);
  const walking = litOn(1)[0];
  ts.writeSetup();
  check('the picked side plays in its pick', flag.versusSetup.teams[0].color === CONFIG.versus.wheel[3],
    `#${(flag.versusSetup.teams[0].color ?? 0).toString(16)}`);
  check('...and the unpicked one in whatever the light landed on',
    flag.versusSetup.teams[1].color === CONFIG.versus.wheel[walking],
    `#${(flag.versusSetup.teams[1].color ?? 0).toString(16)} vs swatch ${walking}`);
  check('...which is never the same colour as the other side',
    flag.versusSetup.teams[0].color !== flag.versusSetup.teams[1].color);
  // versusSetup is LEFT as this section wrote it. A later check reads "the last
  // write" to prove that Escape starts nothing, and emptying it here would hand
  // that check an empty setup to be satisfied by — which it would be, for the
  // wrong reason.
  ts.hideTeamSelect();
}

// ---------------------------------------------------------------------------
// HOW THE MATCH ENDS — first to a number of goals, or a clock. One row, because
// they are one decision: a match is first to N goals OR N minutes long.
section('The match length row sets what the match is played to');
{
  rules.forgetMatchRules();
  open();
  const q = (c) => root.querySelector('.sv-teams-' + c);
  check('it opens on the config default, a first-to', !rules.isTimed() && rules.goalsToWin() === CONFIG.versus.toWin,
    `first to ${rules.goalsToWin()}`);
  // THE BUTTON NAMES THE STATE IT IS IN, not the one it would switch to — a
  // toggle labelled with its own opposite is the oldest way to make somebody
  // press it twice to find out what it does.
  check('...and the button says which kind it is', q('mode').textContent.length > 0 && !/^team/.test(q('mode').textContent),
    q('mode').textContent);
  check('the number on the row is the goals', q('rules-n').textContent === String(rules.goalsToWin()), q('rules-n').textContent);
  q('rules-more').click();
  check('+ steps it up', rules.goalsToWin() === CONFIG.versus.toWin + 1, `${rules.goalsToWin()}`);
  q('rules-less').click(); q('rules-less').click();
  check('...and - steps it down', rules.goalsToWin() === CONFIG.versus.toWin - 1, `${rules.goalsToWin()}`);
  // CLAMPED, AND VISIBLY SO. A control that keeps accepting presses past its
  // own limit is a control that has stopped saying anything.
  for (let i = 0; i < 40; i++) q('rules-more').click();
  check('it stops at the ceiling', rules.goalsToWin() === rules.MAX_GOALS && q('rules-more').disabled,
    `${rules.goalsToWin()}, + ${q('rules-more').disabled ? 'disabled' : 'still live'}`);
  for (let i = 0; i < 40; i++) q('rules-less').click();
  check('...and at the floor', rules.goalsToWin() === rules.MIN_GOALS && q('rules-less').disabled,
    `${rules.goalsToWin()}, - ${q('rules-less').disabled ? 'disabled' : 'still live'}`);
  // TIMED. The same row, the same two buttons, a different number.
  q('mode').click();
  check('the button flips it to a timed match', rules.isTimed());
  check('...and the row now steps the clock', /^\d+:\d\d$/.test(q('rules-n').textContent), q('rules-n').textContent);
  check('...shown as a clock, the way the strip shows it mid-match',
    q('rules-n').textContent === `${Math.floor(rules.matchSeconds() / 60)}:${String(rules.matchSeconds() % 60).padStart(2, '0')}`,
    q('rules-n').textContent);
  const was = rules.matchSeconds();
  q('rules-more').click();
  check('+ adds a step of the clock, not a second', rules.matchSeconds() === was + rules.STEP_SECONDS,
    `${was}s -> ${rules.matchSeconds()}s`);
  for (let i = 0; i < 60; i++) q('rules-less').click();
  check('...and it clamps at the floor too', rules.matchSeconds() === rules.MIN_SECONDS && q('rules-less').disabled,
    `${rules.matchSeconds()}s`);
  // THE OTHER NUMBER SURVIVES THE TRIP. Flipping to timed and back must not
  // throw away the goals somebody set — they are two settings on one row, not
  // one setting that changes meaning.
  const goals = rules.goalsToWin();
  q('mode').click();
  check('flipping back keeps the goals that were set', rules.goalsToWin() === goals, `${rules.goalsToWin()}`);
  // ...AND NONE OF IT IS WRITTEN TO CONFIG. The tuner snapshots whole sections;
  // a setting stored there would ship as next week's default.
  check('nothing was written to CONFIG', CONFIG.versus.toWin === 5 && CONFIG.versus.timed === false
    && CONFIG.versus.matchSeconds === 180,
    `${CONFIG.versus.toWin} / ${CONFIG.versus.timed} / ${CONFIG.versus.matchSeconds}`);
  rules.forgetMatchRules();
  ts.hideTeamSelect();
}

// ---------------------------------------------------------------------------
// THE PILLS CANNOT PUSH THE ROW APART. A slot is a 34px line holding a chip, a
// name, a dice and a hat tile — three of them fixed-width — and the chip was
// the one thing in it that could grow: `white-space: nowrap` with no min-width
// makes a flex item that refuses to shrink below its own text, so the slot's
// content minimum was whatever the longest chip happened to say. Measured in a
// browser at three columns on a 600px window, the captain row spilled 29px past
// its own box and took the hat tile with it.
//
// The GLYPHS are half the fix and the min-width is the other half: a device
// name is a symbol now, and the pill can be ellipsised whatever it holds.
section('Nothing in a slot can outgrow the slot');
{
  open();
  const style = styleText();
  // EVERY block for a selector, not the first one: these rules are declared
  // more than once (a later block adds the slot's padding), and a regex that
  // stopped at the first match would report on whichever happened to be
  // written first rather than on what the element ends up with.
  const declares = (sel, prop) => [...style.matchAll(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`, 'g'))]
    .some((m) => m[1].includes(prop));
  check('a chip can shrink below its own text', declares('.sv-teams-chip', 'min-width: 0'));
  check('...and is ellipsised rather than spilling', declares('.sv-teams-chip', 'text-overflow: ellipsis'));
  check('...inside a slot that clips what it cannot fit',
    declares('.sv-teams-slot', 'min-width: 0') && declares('.sv-teams-slot', 'overflow: hidden'));
  // THE ROWS UNDER THE BOARD WRAP. A label, a pair of steppers and a number is
  // short until the label is a phrase and the window is a phone held sideways —
  // and a row that cannot wrap pushes the panel wider than the screen, which is
  // what took the right-hand team off the edge.
  check('the roster and match-length rows wrap', declares('.sv-teams-roster', 'flex-wrap: wrap'));
  check('...and so does the button row', declares('.sv-teams-foot', 'flex-wrap: wrap'));
  // ...BUT A NAME IS NEVER CUT. The slot ellipsises a device CHIP, whose words
  // are on its title anyway; it must never do that to a seal's name, which is
  // the one thing on this screen that exists to be read. An ellipsis here is
  // also invisible to `npm run layout` — text-overflow: ellipsis is the one
  // truncation that audit reads as deliberate — so this is the only place the
  // rule can be held.
  check('a name wraps rather than being cut with an ellipsis',
    !declares('.sv-teams-name-text', 'text-overflow') && !declares('.sv-teams-name-text', 'white-space: nowrap'));
  // AND THE PANEL IS WIDE ENOUGH THAT IT RARELY HAS TO. The ceiling is measured
  // against the longest name the pool can cast, not chosen: a name of
  // MAX_NAME_LEN characters at 12px is ~215px, and the furniture beside it (a
  // chip, a 44px dice, a 44px hat tile, the gaps and two lots of padding) is
  // ~175px more on a touch viewport — two of those plus the pool column is a
  // shade over 1000px. 720px was the old figure and it cut every long name on
  // every screen wide enough to have shown them.
  {
    const m = /\.sv-teams\s*\{[^}]*width:\s*min\(90vw,\s*(\d+)px\)/.exec(style);
    check('the panel ceiling holds a full-length name in both columns',
      !!m && Number(m[1]) >= 1000, m ? `${m[1]}px` : 'no width ceiling found');
  }
  // A DEVICE IS A SYMBOL, AND ITS NAME IS STILL ETHAN'S. The glyph is what the
  // pill draws; the uiText row is its title and its accessible name, the same
  // bargain the dice and the hat tile already make — so a hover and a screen
  // reader still get the word and the table's rows are still read.
  {
    const kb = [...root.querySelectorAll('.sv-teams-chip')].find((n) => n.title === uiText('teamKeyboard'));
    check('the keyboard chip is a glyph', !!kb && kb.textContent.length <= 2 && kb.textContent !== uiText('teamKeyboard'),
      kb ? `"${kb.textContent}" titled "${kb.title}"` : 'no keyboard chip found');
    check('...and still says its name to a screen reader',
      !!kb && kb.getAttribute('aria-label') === uiText('teamKeyboard'), kb?.getAttribute('aria-label'));
  }
  ts.hideTeamSelect();
}

// ---------------------------------------------------------------------------
section('A readied stick sets the match itself');
// ---------------------------------------------------------------------------
// THE ROWS UNDER THE BOARD WERE POINTER-ONLY. A pad could pick a side, pick a
// colour and press Start, and could not change one thing about the match it was
// starting — how many seals a side, first to N goals or N minutes, or which of
// those two. On the screen in this game most likely to be played from a sofa.
//
// The directions a READIED device pushes are what drives them, and nothing was
// taken away to do it: move() and stepColor() both refuse outright while `ready`
// is set, so all four were dead buttons. The checks below prove both halves —
// that the rows move, and that an UNreadied stick still does what it always did.
{
  open();
  const roster0 = roster.rosterPerSide();
  const goals0 = rules.goalsToWin();
  // Onto a side and readied: the ordinary sequence, before any of this applies.
  // Two rights, because the first press a pad makes is spent on ARRIVING — the
  // browser does not expose a controller until a button on it is pressed, so
  // that frame registers the chip rather than moving it (see updateTeamSelect).
  tap([pad(0, { dpad: 'right' })]);
  tap([pad(0, { dpad: 'right' })]);
  tap([pad(0, { a: true })]);
  check('pad 1 is a ready captain', dev('pad0')?.side === 1 && dev('pad0')?.ready);
  check('...and nothing on the settings rows is lit yet', ts.teamSelectState().settingRow === -1,
    String(ts.teamSelectState().settingRow));

  // THE FIRST PUSH IS THE ASKING, not a change. A stick that silently moved the
  // roster before anything was drawn would be a setting changing with no
  // indication of which one.
  tap([pad(0, { dpad: 'right' })]);
  check('the first push selects rather than steps', ts.teamSelectState().settingRow === 0
    && roster.rosterPerSide() === roster0, `row ${ts.teamSelectState().settingRow}, roster ${roster.rosterPerSide()}`);
  tap([pad(0, { dpad: 'right' })]);
  check('...and the next one grows the roster', roster.rosterPerSide() === roster0 + 1, String(roster.rosterPerSide()));
  tap([pad(0, { dpad: 'left' })]);
  check('...and left shrinks it again', roster.rosterPerSide() === roster0, String(roster.rosterPerSide()));

  // THREE STOPS AND NOT TWO. The kind button is a decision of its own — first to
  // five goals and five minutes are different matches — so folding it into the
  // number beside it would leave the one control a pad could not reach as the
  // one that decides what the number MEANS.
  tap([pad(0, { dpad: 'down' })]);
  check('down walks to the match kind', ts.teamSelectState().settingRow === 1);
  const timed0 = rules.isTimed();
  tap([pad(0, { dpad: 'right' })]);
  check('...which the stick flips', rules.isTimed() === !timed0, String(rules.isTimed()));
  tap([pad(0, { dpad: 'left' })]);
  check('...and flips back', rules.isTimed() === timed0);

  tap([pad(0, { dpad: 'down' })]);
  check('down again walks to the number', ts.teamSelectState().settingRow === 2);
  tap([pad(0, { dpad: 'right' })]);
  check('...which steps whichever number the kind is played to',
    rules.goalsToWin() === goals0 + 1, `${goals0} -> ${rules.goalsToWin()}`);
  // THE RING IS DRAWN, or the mode is invisible and the player is guessing.
  {
    const lit = [...root.querySelectorAll('.sv-nav-sel')];
    check('the row the stick is on carries a cursor',
      lit.length === 1 && lit[0].classList.contains('sv-teams-rules-group'),
      lit.map((n) => n.className).join(' / ') || 'nothing lit');
  }

  // ...AND THE WALK DOES NOT END AT THE ROWS. Back and Start used to answer
  // only to the pad's own B and Start buttons, which meant neither ever lit up:
  // the ring walked three rows and ran out of screen with the two decisions
  // that actually end the thing unmarked, and the only way to learn the pad's
  // Start works here was to press it and find out.
  const litOne = () => {
    const lit = [...root.querySelectorAll('.sv-nav-sel')];
    return lit.length === 1 ? lit[0] : null;
  };
  tap([pad(0, { dpad: 'down' })]);
  check('down again walks onto Back', ts.teamSelectState().settingRow === 3);
  check('...and Back is the thing carrying the ring', litOne()?.id === 'svTeamBack',
    litOne()?.id || litOne()?.className || 'nothing lit');

  // SIDE BY SIDE, SO SIDEWAYS IS HOW YOU GET BETWEEN THEM. The footer is one
  // row on the screen; a cursor that answered up and down there would be moving
  // at right angles to what the player is looking at.
  tap([pad(0, { dpad: 'right' })]);
  check('right walks along the footer to Start', ts.teamSelectState().settingRow === 4);
  check('...and Start carries the ring now', litOne()?.id === 'svTeamStart',
    litOne()?.id || litOne()?.className || 'nothing lit');
  tap([pad(0, { dpad: 'right' })]);
  check('...and the end of the footer holds rather than wrapping', ts.teamSelectState().settingRow === 4);
  tap([pad(0, { dpad: 'down' })]);
  check('...as does the end of the list', ts.teamSelectState().settingRow === 4);
  tap([pad(0, { dpad: 'left' })]);
  check('left walks back to Back', ts.teamSelectState().settingRow === 3);
  tap([pad(0, { dpad: 'left' })]);
  check('...and does not climb out of the footer into the rows above',
    ts.teamSelectState().settingRow === 3, String(ts.teamSelectState().settingRow));
  tap([pad(0, { dpad: 'up' })]);
  check('up is the way back to the rows', ts.teamSelectState().settingRow === 2);

  // UN-READYING HANDS THE STICK BACK. The colour wheel is what up and down mean
  // again, and a ring left on a row nothing can move is a cursor that has gone.
  tap([pad(0, { b: true })]);
  check('B un-readies', !dev('pad0')?.ready);
  check('...and the settings cursor goes with it', ts.teamSelectState().settingRow === -1);
  check('...leaving nothing lit', root.querySelectorAll('.sv-nav-sel').length === 0);
  {
    const before = ts.teamSelectState().picks[1];
    tap([pad(0, { dpad: 'down' })]);
    check('...and down turns the colour wheel again, not the roster',
      ts.teamSelectState().picks[1] !== before && roster.rosterPerSide() === roster0);
  }
  // Put the match back the way this file found it — the sections below read
  // these same numbers.
  rules.setGoalsToWin(goals0);
  rules.setTimed(timed0);
  ts.hideTeamSelect();
}

// ---------------------------------------------------------------------------
section('A is what presses the button the cursor is on');
// ---------------------------------------------------------------------------
// The other half of reaching Back and Start with a stick: having reached one,
// there has to be something that presses it. A is that, and ONLY where the
// cursor is on something pressable — on a row of numbers it still means what it
// has always meant on this screen, and B is the way back out either way.
{
  open();
  tap([pad(0, { dpad: 'left' })]);
  tap([pad(0, { dpad: 'left' })]);
  tap([pad(0, { a: true })]);
  check('pad 1 is a ready captain on the left', dev('pad0')?.side === 0 && dev('pad0')?.ready);
  // Down four times: the asking, then the kind, the number, and Back.
  for (let i = 0; i < 4; i += 1) tap([pad(0, { dpad: 'down' })]);
  check('the cursor is on Back', ts.teamSelectState().settingRow === 3, String(ts.teamSelectState().settingRow));
  const wasBacks = backs;
  tap([pad(0, { a: true })]);
  check('A presses it', backs === wasBacks + 1 && root.classList.contains('sv-hidden'));
  check('...and readying was not toggled instead', true);
}
{
  open();
  tap([pad(0, { dpad: 'left' })]);
  tap([pad(0, { dpad: 'left' })]);
  tap([pad(0, { a: true })]);
  for (let i = 0; i < 5; i += 1) tap([pad(0, { dpad: 'down' })]);
  tap([pad(0, { dpad: 'right' })]);
  check('the cursor walks on to Start', ts.teamSelectState().settingRow === 4, String(ts.teamSelectState().settingRow));
  started = null;
  tap([pad(0, { a: true })]);
  check('A starts the match', !!started && root.classList.contains('sv-hidden'));
  check('...with the side the pad actually took', started?.teams[0].members[0].pad === 0,
    JSON.stringify(started?.teams.map((t) => t.members)));
}

// ---------------------------------------------------------------------------
section('A stop that is switched off is stepped over, not landed on');
// ---------------------------------------------------------------------------
// Start is dead until every side with a person on it has readied, and a cursor
// that can land on a dead button is a cursor that appears to have stopped
// working — the same rule the shared panel cursor follows (ui/panelNav.js).
{
  open();
  // Pad 1 readies on the left; pad 2 walks onto the right and does NOT ready,
  // which is exactly the state where Start is refused.
  tap([pad(0, { dpad: 'left' })]);
  tap([pad(0, { dpad: 'left' })]);
  tap([pad(0, { a: true })]);
  tap([pad(0), pad(1, { dpad: 'right' })]);
  tap([pad(0), pad(1, { dpad: 'right' })]);
  check('one captain is ready and the other is not',
    dev('pad0')?.ready === true && dev('pad1')?.side === 1 && dev('pad1')?.ready === false);
  check('...so Start is refused', !ts.canStart() && root.querySelector('#svTeamStart').disabled);

  // BOTH PADS IN EVERY FRAME, and that is not padding out the call. A pad left
  // out of the list is a pad that has been UNPLUGGED (see updateTeamSelect),
  // and unplugging the unready captain hands its side to the computer — which
  // makes Start pressable again and quietly deletes the state this section is
  // about. Written the short way, all four checks below passed on a screen in
  // the wrong state.
  const both = (p0) => tap([pad(0, p0), pad(1)]);
  for (let i = 0; i < 4; i += 1) both({ dpad: 'down' });
  check('the cursor reaches Back', ts.teamSelectState().settingRow === 3, String(ts.teamSelectState().settingRow));
  both({ dpad: 'down' });
  check('...and holds there rather than walking onto a dead Start',
    ts.teamSelectState().settingRow === 3, String(ts.teamSelectState().settingRow));
  both({ dpad: 'right' });
  check('...and sideways will not reach it either', ts.teamSelectState().settingRow === 3);
  check('nothing is ringed but Back',
    [...root.querySelectorAll('.sv-nav-sel')].every((n) => n.id === 'svTeamBack'));

  // The far captain readies: the stop comes back, and the cursor can walk on.
  tap([pad(0), pad(1, { a: true })]);
  check('the far captain readying makes Start a stop again', ts.canStart());
  both({ dpad: 'right' });
  check('...which the cursor now reaches', ts.teamSelectState().settingRow === 4, String(ts.teamSelectState().settingRow));

  // ...AND IT GOES AWAY AGAIN UNDER THE CURSOR. A ring left on a button that
  // has just been switched off is the same lie in reverse.
  tap([pad(0), pad(1, { b: true })]);
  check('the far captain un-readying takes the cursor off Start',
    ts.teamSelectState().settingRow === 3, String(ts.teamSelectState().settingRow));
  check('...and the ring goes with it',
    [...root.querySelectorAll('.sv-nav-sel')].every((n) => n.id !== 'svTeamStart'));
  ts.hideTeamSelect();
}

// ---------------------------------------------------------------------------
section('Back, B and unplugging');
open();
tap([pad(0, { dpad: 'right' })]);
tap([pad(0, { dpad: 'right' })]);
tap([pad(0, { a: true })]);
check('pad 1 is ready on the right', dev('pad0')?.side === 1 && dev('pad0')?.ready);
tap([pad(0, { b: true })]);
check('B un-readies', dev('pad0')?.ready === false && dev('pad0')?.side === 1);
tap([pad(0, { b: true })]);
check('B again walks back to the pool', dev('pad0')?.side === -1);
ts.updateTeamSelect([]);
check('an unplugged pad leaves the screen', !dev('pad0'));
const backsBeforeEscape = backs;
key('Escape');
check('Escape from the pool is Back', backs === backsBeforeEscape + 1 && root.classList.contains('sv-hidden'));
check('...and nothing was started by it', flag.versusSetup.teams[0].members.length === 1); // still the last write
ts.hideTeamSelect();
check('a closed screen ignores the keyboard', (key('ArrowLeft'), true));
flag.resetVersusSetup();
check('resetVersusSetup empties both sides', flag.versusSetup.teams.every((t) => t.members.length === 0 && t.color === null) && flag.captainPad(0) === undefined);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
