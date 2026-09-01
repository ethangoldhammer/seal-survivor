#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:grab
//
// THE TWO THINGS THAT KEEP THE SEAL'S HEALTH BAR HONEST, and they are the same
// change looked at from two ends.
//
//   THE I-FRAME WINDOW  (CONFIG.player.hitIFrames)
//     A discrete blow refuses every other discrete blow for a fraction of a
//     second. It exists because the crab layer moved its ENTIRE damage budget
//     into the pinch — a crab you are merely intersecting now costs nothing —
//     and nine crabs on a chum pile shut their claws inside a few frames of
//     each other. Without the window that is half the bar between two frames
//     with one flash to show for it. With it, one is paid.
//
//     Both halves are worth failing over. A window that stopped REFUSING is
//     the pile-on back; a window that started refusing DRAINS is every beam,
//     aura and body in the game quietly doing a fraction of its damage, which
//     is the failure that looks like a balance change and is a bug.
//
//   THE GRAB  (systems/bossGrab.js)
//     A boss lands a clean bite and takes the seal with it. It is the one
//     attack in the game that takes the controls away, and systems/control.js
//     spends a page on why that normally deletes a fight — so every bound on
//     it is load-bearing and every one of them is checked here: it is earned
//     by the narrow bite gate, it is short, it is rare, it cannot double-bill
//     through the body it has you inside, and it ends by throwing you clear
//     with i-frames rather than handing you to the next attack.
//
// Driven rather than computed wherever it can be. `capBossDamage` arithmetic
// is a function of its arguments and is checked in tools/boss-damage-test.mjs;
// what THIS file has to say is that the machinery is connected — that a grab
// actually moves the seal, actually holds it, and actually lets go.
//
//   node --import ./tools/vite-loader.mjs tools/boss-grab-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { updateBounds, bounds } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer, updatePlayer } from '../path/src/entities/player.js';
import { enemies, spawnNamed, resetEnemies } from '../path/src/entities/enemies.js';
import {
  tryBossGrab, updateBossGrab, resetBossGrab, playerGrabbed, grabbedBy,
} from '../path/src/systems/bossGrab.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const note = (t) => console.log(`        ${t}`);

updateBounds(16 / 9);
initPlayer(scene);
const noInput = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) };

// A recording onPlayerHit, the same shape main.js's has. Every point of damage
// this file measures goes through one of these.
function ledger() {
  const l = { total: 0, hits: [], byChannel: {} };
  l.onPlayerHit = (dmg, dir, source = '?', channel = 'attack') => {
    l.total += dmg;
    l.hits.push({ dmg, source, channel });
    l.byChannel[channel] = (l.byChannel[channel] ?? 0) + dmg;
  };
  return l;
}

// ===========================================================================
section('THE I-FRAME WINDOW REFUSES BURSTS AND NOTHING ELSE');
// ===========================================================================
//
// main.js owns the rule and this file cannot import it (main.js builds a whole
// game at import time), so the gate is re-stated here in the four lines it is
// written in over there and then EXERCISED. That is a duplication with a job:
// what is being tested is the arithmetic of the window — how many of N blows
// inside it are paid — and a re-statement that drifted from the original would
// show up as this file asserting a number the game does not produce, which is
// exactly what tools/crab-claw-test.mjs's `pinchReach` note is about.
{
  const W = CONFIG.player.hitIFrames ?? 0;
  check('there is a window at all', W > 0, `${W}s`);
  check('...and it is shorter than the crab\'s own tell', W < CONFIG.crabClaw.windup,
    `${W}s against a ${CONFIG.crabClaw.windup}s rear-up — a swarm taking turns still gets paid for each turn`);

  // The gate, as onPlayerHit spells it.
  const gate = (l, dmg, channel) => {
    if (channel === 'strike') {
      if (player.invuln > 0) return;
      player.invuln = Math.max(W, player.stats?.invulnAfterHit ?? 0);
    }
    l.onPlayerHit(dmg, null, 'crab', channel);
  };

  // NINE CLAWS ON ONE FRAME. The literal shape of the bug: a swarm converging
  // on a chum pile, every one of them connecting inside the same frame.
  resetPlayer();
  player.invuln = 0;
  let l = ledger();
  for (let i = 0; i < 9; i++) gate(l, 20, 'strike');
  check('nine claws on one frame bill once', l.hits.length === 1,
    `${l.hits.length} of 9 paid, ${l.total} damage`);

  // ...AND THE REST OF THE SWARM STILL GETS ITS TURN. A window that never
  // reopened would be immunity rather than i-frames.
  resetPlayer();
  player.invuln = 0;
  l = ledger();
  const SECONDS = 3;
  for (let f = 0; f < SECONDS / dt; f++) {
    gate(l, 20, 'strike');            // something is always swinging
    if (player.invuln > 0) player.invuln -= dt;
  }
  const expected = Math.floor(SECONDS / W);
  check('a swarm that keeps swinging keeps getting paid',
    Math.abs(l.hits.length - expected) <= 1,
    `${l.hits.length} pinches in ${SECONDS}s, one per ${W}s window`);

  // A DRAIN IS NOT A BURST. Beams, auras and bodies all arrive as `damage * dt`
  // on the channels they have always used, and refusing those in windows would
  // read as the damage being broken.
  resetPlayer();
  player.invuln = 0;
  l = ledger();
  for (let f = 0; f < 1 / dt; f++) {
    gate(l, 30 * dt, 'contact');
    gate(l, 30 * dt, 'attack');
    if (player.invuln > 0) player.invuln -= dt;
  }
  check('a per-second drain is untouched by the window',
    Math.abs((l.byChannel.contact ?? 0) - 30) < 1e-6
    && Math.abs((l.byChannel.attack ?? 0) - 30) < 1e-6,
    `${(l.byChannel.contact ?? 0).toFixed(1)} contact and ${(l.byChannel.attack ?? 0).toFixed(1)} aimed, of 30 each`);

  // ...and a drain does not ARM the window either, or a beam burning through
  // the seal would make it immune to everything else in the game.
  resetPlayer();
  player.invuln = 0;
  l = ledger();
  gate(l, 5, 'contact');
  gate(l, 20, 'strike');
  check('a drain does not arm the window', l.hits.length === 2,
    'a body touching you cannot make a pinch free');
}

// ===========================================================================
section('EVERY BURST IN THE GAME ASKS FOR THE WINDOW');
// ===========================================================================
//
// The window is opt-in by channel, which is right — a source added tomorrow
// gets the old behaviour rather than a silent i-frame nobody chose. The cost of
// opt-in is that a call site can forget, and a burst that forgot is invisible:
// it works, it just cannot be throttled. So the four that must have it are
// named, and their call sites are read out of the source rather than trusted.
{
  const src = (p) => new URL(p, import.meta.url);
  const read = async (p) => (await import('node:fs')).readFileSync(src(p), 'utf8');
  const combat = await read('../path/src/systems/combat.js');
  const main = await read('../path/src/main.js');

  check('the crab\'s pinch is on the window',
    /justPinched[\s\S]{0,2000}?'strike'/.test(combat), 'systems/combat.js');
  check('a trap\'s snap is on the window',
    /behavior === 'trap'[\s\S]{0,1500}?'strike'/.test(combat), 'systems/combat.js');
  check('an enemy shot is on the window',
    /enemy shot'[^)]*'strike'/.test(combat), 'systems/combat.js');
  check('a clean bite is on the window',
    /function onPlayerBite[\s\S]{0,3000}?e\.type, 'strike'\)/.test(main), 'main.js');
  check('a pack hunter\'s contact bite is on the window',
    /contactBite[\s\S]{0,2000}?'strike'/.test(combat), 'systems/combat.js');

  // AND THE WINDOW REPORTS BACK. `contactBite` is the one source that has to
  // know whether its blow landed — a refused bite must not spend the animal's
  // clock, or a whole pack goes into lockstep and bills what one of them does
  // (see tools/contact-bite-test.mjs). onPlayerHit returning nothing would
  // reintroduce that silently, because `undefined > 0` is simply false and the
  // clock would then never be spent at all.
  check('onPlayerHit reports what it billed',
    /if \(player\.invuln > 0\) return 0;/.test(main) && /^  return dmg;$/m.test(main),
    'main.js');
}

// ===========================================================================
section('A GRAB IS EARNED, AND ONLY THREE ARCHETYPES MAY');
// ===========================================================================
{
  const grabbers = Object.entries(CONFIG.enemies).filter(([, d]) => d.grab);
  check('exactly the three chasing bodies that hold',
    grabbers.length === 3
      && ['bossShark', 'bossOrca', 'bossMosasaur'].every((k) => CONFIG.enemies[k]?.grab),
    grabbers.map(([k]) => k).join(', '));
  check('the hammerhead throws rather than holds', !CONFIG.enemies.bossHammerhead?.grab,
    'its archetype is hitting you SOMEWHERE ELSE — a hold is the opposite verb');
  // A grabber must be able to bite, because the bite gate IS the grab gate.
  for (const [k, d] of grabbers) {
    check(`${k}: has a bite to earn it with`, (d.biteDamage ?? 0) > 0,
      `biteDamage ${d.biteDamage}`);
  }
  // No wildlife may. A shark that could pin the player for two seconds every
  // nine, six at a time, is not the same mechanic at all.
  const wild = Object.entries(CONFIG.enemies).filter(([k, d]) => d.grab && !k.startsWith('boss'));
  check('nothing in the wildlife may hold you', wild.length === 0,
    wild.length ? wild.map(([k]) => k).join(', ') : 'the grab is a boss verb');
}

// ===========================================================================
section('THE SEAL IS TAKEN, CARRIED AND LET GO');
// ===========================================================================
//
// Driven end to end: a real boss, a real player, and the frame order main.js
// uses (updatePlayer, then updateBossGrab having the last word).
function grabRun(key, { seconds = 4, steer = null } = {}) {
  resetEnemies(scene);
  resetBossGrab();
  resetPlayer();
  player.mesh.position.set(0, bounds.surfaceY - 20, 0);
  player.velocity.set(0, 0, 0);

  const e = spawnNamed(scene, key, 0, { x: 6, y: bounds.surfaceY - 20 }, { ignoreCaps: true });
  if (!e) throw new Error(`could not spawn ${key}`);
  // Arrival invulnerability is a real gate on the grab and is not what this is
  // measuring; the fight proper is what is under test.
  e.invuln = 0;
  // Driven by hand rather than by updateEnemies, so the boss's path is a known
  // straight line and the seal's displacement is attributable to being carried
  // rather than to a cruise that happened to go that way.
  e.heading = 0;

  const l = ledger();
  const input = { move: new THREE.Vector2(steer?.x ?? 0, steer?.y ?? 0), aim: new THREE.Vector2(1, 0) };
  const took = tryBossGrab(e);
  let released = null;

  const frames = [];
  for (let f = 0; f < seconds / dt; f++) {
    e.mesh.position.x += 8 * dt;   // the boss swims on, in a straight line
    updatePlayer(dt, input);
    updateBossGrab(dt, { onPlayerHit: l.onPlayerHit });
    frames.push({
      t: f * dt,
      held: playerGrabbed(),
      gap: Math.hypot(player.mesh.position.x - e.mesh.position.x,
        player.mesh.position.y - e.mesh.position.y),
      x: player.mesh.position.x,
    });
    // THE FRAME THE GRIP OPENS, sampled here rather than read off the player at
    // the end of the run — both the grace and the shove decay, and by the time
    // this loop stops there is nothing left of either. A check that read them
    // afterwards would be testing the decay rate, which is not the claim.
    if (!released && frames.length > 1 && !frames[frames.length - 1].held
      && frames[frames.length - 2].held) {
      released = {
        invuln: player.invuln,
        throw: Math.hypot(player.knockX, player.knockY),
        snare: player.snareTimer,
      };
    }
  }
  return { e, l, took, frames, released };
}

for (const key of ['bossShark', 'bossOrca', 'bossMosasaur']) {
  const { e, l, took, frames, released } = grabRun(key);
  check(`${key}: a clean bite takes hold`, took && frames[0].held, 'grabbed on the frame the jaws shut');

  // HELD FOR AS LONG AS IT SAYS, and no longer. Both directions: a grab that
  // ended early is a moment nobody sees, and one that never ended is the fight
  // deleted, which is the thing systems/control.js exists to refuse.
  const heldFor = frames.filter((f) => f.held).length * dt;
  const want = CONFIG.bossGrab.hold;
  check(`${key}: held for the length it was authored at`,
    Math.abs(heldFor - want) < 0.1, `${heldFor.toFixed(2)}s against ${want}s`);

  // CARRIED, not left behind. The seal has to end up somewhere it could not
  // have swum to — the boss travelled 8 u/s for the whole hold with the stick
  // at neutral, so any displacement at all is the drag.
  const carried = frames.find((f) => f.t > want * 0.8 && f.held);
  check(`${key}: and dragged along with it`, carried && carried.x > 8,
    carried ? `${carried.x.toFixed(1)} units downrange from a standing start` : 'never held that long');

  // IN THE MOUTH, which is the read. Measured as the gap to the body's origin
  // against the reach the bite itself is billed at — if the seal drifts wider
  // than that it is being towed on a string rather than carried.
  const reach = (e.radius ?? 2) * (CONFIG.bite.mouthReach ?? 0.55) + player.stats.hitRadius;
  const worst = Math.max(...frames.filter((f) => f.held && f.t > 0.3).map((f) => f.gap));
  check(`${key}: kept inside the jaws for the whole carry`, worst <= reach * 1.2,
    `worst gap ${worst.toFixed(1)}u against a ${reach.toFixed(1)}u bite`);

  // CHEWED, in crunches rather than as a drain — see `crushEvery`.
  const crunches = l.hits.filter((h) => h.source === 'boss:grab');
  const wantCrunches = Math.floor(want / CONFIG.bossGrab.crushEvery);
  check(`${key}: chews on the way round`,
    Math.abs(crunches.length - wantCrunches) <= 1 && l.total > 0,
    `${crunches.length} crunches worth ${l.total.toFixed(0)}, one per ${CONFIG.bossGrab.crushEvery}s`);

  // ...AND NOT ON THE i-FRAME CHANNEL. A crunch is the grab continuing, not a
  // new blow: routed through the window, a grab landing a fraction of a second
  // after a crab's pinch would do nothing at all for its first tick.
  check(`${key}: the chewing is not billed as a fresh blow`,
    crunches.every((h) => h.channel !== 'strike'), 'crunches ride the aimed channel');

  // THROWN CLEAR, with i-frames. The frame the grip opens is the frame the
  // player is moving fast and cannot be immediately re-taken.
  check(`${key}: let go with i-frames and a shove`,
    released != null
      && released.invuln >= CONFIG.bossGrab.releaseGrace - dt
      && released.throw >= CONFIG.bossGrab.throwSpeed * 0.5,
    released ? `${released.invuln.toFixed(2)}s of grace, thrown at ${released.throw.toFixed(0)} u/s`
      : 'never let go');

  // ...AND THE HOLD ENDS WITH IT. `snarePlayer` cannot be talked down, so the
  // release has to cut the timer itself — a seal thrown clear at speed and then
  // left limp for the length of the grab it just escaped is a release in name
  // only, and it is the one bug in this file that would feel like the throw
  // being weak rather than like the snare being wrong.
  check(`${key}: and gets its swimming back`,
    released != null && released.snare <= 0.3 + 1e-6,
    released ? `${released.snare.toFixed(2)}s of hold left, thawing` : 'never let go');

  // AND IT CANNOT IMMEDIATELY RETAKE. The cooldown is what makes this a handful
  // of moments in a fight rather than its rhythm.
  check(`${key}: cannot take hold again straight away`, !tryBossGrab(e),
    `${e.grabCooldown.toFixed(1)}s of dead time left`);
}

// ===========================================================================
section('IT CANNOT BE STARTED BY ANYTHING THAT IS NOT A CLEAN BITE');
// ===========================================================================
{
  resetEnemies(scene); resetBossGrab(); resetPlayer();
  const wild = spawnNamed(scene, 'shark', 0, { x: 2, y: bounds.surfaceY - 20 }, { ignoreCaps: true });
  wild.invuln = 0;
  check('a wildlife shark cannot hold you', !tryBossGrab(wild),
    'it bites, and that is all a shark gets');

  resetEnemies(scene); resetBossGrab(); resetPlayer();
  const boss = spawnNamed(scene, 'bossShark', 0, { x: 6, y: bounds.surfaceY - 20 }, { ignoreCaps: true });
  boss.invuln = 0;
  boss.trapTimer = 1;
  check('a held boss cannot hold you', !tryBossGrab(boss), 'trapped and inert');
  boss.trapTimer = 0;
  boss.charmTimer = 1;
  check('a charmed boss cannot hold you', !tryBossGrab(boss), 'fighting for the other side');
  boss.charmTimer = 0;
  boss.invuln = 1;
  check('a boss still arriving cannot hold you', !tryBossGrab(boss),
    'the entrance is not a punishment for watching it');
  boss.invuln = 0;

  // ONE AT A TIME. A second grab landing mid-grab would leave the first one's
  // enemy marked `grabbing` forever, which is a boss that permanently stops
  // dealing contact damage.
  check('and one takes', tryBossGrab(boss));
  check('a second grab is refused while one is live', !tryBossGrab(boss),
    'nothing else can take a seal that is already in a mouth');
  resetBossGrab();
}

// ===========================================================================
section('A BOSS THAT DIES MID-GRAB LETS GO');
// ===========================================================================
{
  resetEnemies(scene); resetBossGrab(); resetPlayer();
  player.mesh.position.set(0, bounds.surfaceY - 20, 0);
  const boss = spawnNamed(scene, 'bossShark', 0, { x: 6, y: bounds.surfaceY - 20 }, { ignoreCaps: true });
  boss.invuln = 0;
  tryBossGrab(boss);
  for (let f = 0; f < 30; f++) {
    updatePlayer(dt, noInput);
    updateBossGrab(dt, {});
  }
  check('held to start with', playerGrabbed() && grabbedBy() === boss);
  // Removed the way every death, despawn and clear-out removes one.
  enemies.length = 0;
  updateBossGrab(dt, {});
  check('a boss taken out of the water lets go', !playerGrabbed(),
    'membership is the test — removeEnemy sets no flag this file could read');
  check('...and the corpse is not left marked as holding you', !boss.grabbing,
    'a stale flag is a boss that never deals contact damage again');
  // Torn up rather than finished: there is nothing to be thrown by.
  note('no throw and no i-frames on this path — the grip did not open, its owner stopped existing');
}

// ===========================================================================
section('A NEW RUN DOES NOT START IN A MOUTH');
// ===========================================================================
{
  resetEnemies(scene); resetBossGrab(); resetPlayer();
  const boss = spawnNamed(scene, 'bossOrca', 0, { x: 6, y: bounds.surfaceY - 20 }, { ignoreCaps: true });
  boss.invuln = 0;
  tryBossGrab(boss);
  check('held', playerGrabbed());
  resetBossGrab();
  check('a reset clears the hold', !playerGrabbed() && !boss.grabbing,
    'resetBossGrab runs beside resetBoss on every new run');
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
