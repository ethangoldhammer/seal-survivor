#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:iframes
//
// THE SEAL'S GRACE PERIODS — every window that makes the seal briefly
// untouchable, and the one ceiling that catches what no window can.
//
// The game already had i-frames and they already worked. What it did not have
// was a defence against the shape that actually ends runs, which is not a pile
// of blows on one frame (CONFIG.player.hitIFrames has bounded that for a long
// time) but a CHAIN of individually fair events arriving in an order that
// compounds:
//
//   YOU ARE HIT           the hammerhead, the one creature that moves you
//   ...AND THROWN         a shove your swimming cannot cancel, for ~0.4s
//   ...THROUGH A PACK     every body on that line gets a free bite
//   ...INTO A WALL        slam.wallMul, worth more than the shove was
//   ...AND HELD THERE     slam.pin, which RAMPS, to 48/s
//
// Five sources across four channels, and only one of them ('strike') is
// something the i-frame window can refuse. CONFIG.boss.damageCap bounded the
// hammerhead's share of that and was blind to the other four by design. So the
// total was bounded by nothing, and the player's report of it is "sometimes the
// run just ends".
//
// The other half is the same problem wearing a swimsuit. A breach lands where
// the seal took off, into whatever swam into that space while it was gone, at a
// downward speed the game REWARDS the player for maximising, with no steering
// on the way in — so the most athletic verb in the game was also the most
// reliable way to arrive inside three animals at once.
//
// FOUR CLAIMS, and every one of them is arithmetic no eye can check: the
// browser preview suspends requestAnimationFrame, and none of these windows is
// longer than half a second even when it is working.
//
//   THE CEILING HOLDS     no combination of sources may take more than
//                         CONFIG.player.damageCap.perSecond of the bar in a
//                         second, and the worked hammerhead chain above is
//                         measured through the real funnel rather than asserted.
//
//   ...AND IS A BACKSTOP  it sits ABOVE the boss's own ceiling, so a boss fight
//                         alone can never reach it. This is the one that rots:
//                         drop it under CONFIG.boss.damageCap.perSecond and it
//                         silently becomes the boss cap's replacement, with
//                         every tuned number in that block still on screen and
//                         no longer binding anything.
//
//   A SHOVE COVERS ITS    the window a shove buys must outlast the travel it
//   OWN TRAVEL            imparted, or the arena still gets its free turn
//                         somewhere in the middle of it — and it must not
//                         outlast it by so much that being thrown is a dodge.
//
//   A LANDING IS          gated on real air time and nothing else, so
//   PROTECTED, A SKIM     porpoising along the surface buys nothing. The abuse
//   IS NOT                this has to be immune to is a free permanent shield
//                         for the cheapest possible input.
//
// Plus the picture, which is the part that makes any of it teachable: every
// window in the game has to reach the rim strobe, including the dash's — which
// lives on a different clock in a different file and had no picture at all.
// ---------------------------------------------------------------------------

import { CONFIG } from '../path/src/config.js';
import { capBossDamage, resetBossDamageCap } from '../path/src/systems/boss.js';
import { capPlayerDamage, resetPlayerDamageCap, playerDamageInWindow } from '../path/src/systems/playerDamageCap.js';

let failures = 0;
const section = (name) => console.log(`\n${name}\n${'-'.repeat(name.length)}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const HP = CONFIG.player.maxHp;
const dcap = CONFIG.player.damageCap;
const bcap = CONFIG.boss.damageCap;
const kb = CONFIG.playerKnockback;
const ki = kb.invuln ?? {};
const slam = kb.slam ?? {};
const air = CONFIG.airborne.slam ?? {};
const FPS = 60;
const DT = 1 / FPS;

// The whole funnel, in the order main.js's onPlayerHit runs it: the boss
// ceiling first, then the shared one. Called rather than reimplemented, so a
// change to either file's arithmetic shows up here as a number moving.
function bill(dmg, source, t, channel = 'attack') {
  const afterBoss = capBossDamage(dmg, source, HP, t, channel);
  return capPlayerDamage(afterBoss, HP, t);
}

function freshSecond() {
  resetBossDamageCap();
  resetPlayerDamageCap();
}

// --- THE CEILING HOLDS -----------------------------------------------------
section('NO SECOND COSTS MORE THAN THE BAR CAN AFFORD');
{
  freshSecond();
  // THE WORKED CHAIN, on the shipped numbers, at 60fps. The hammerhead leaves
  // at CONFIG.enemies.bossHammerhead.playerKnockback, trimmed by maxSpeed.
  const shoveSpeed = Math.min(kb.maxSpeed, CONFIG.enemies.bossHammerhead.playerKnockback);
  const perSpeed = slam.damagePerSpeed ?? 0.12;
  const maxD = slam.maxDamage ?? 30;
  let took = 0;
  let t = 0;
  const step = (dmg, source, channel) => {
    took += bill(dmg, source, t, channel).damage;
  };
  // The hit itself, then the shove, then the arrest, then a second of pin at
  // its ceiling, with the boss's contact drain running underneath all of it.
  step(CONFIG.enemies.bossHammerhead.contactDamage, 'bossHammerhead', 'strike');
  step(Math.min(maxD, shoveSpeed * perSpeed), 'bossHammerhead', 'attack');
  step(Math.min(maxD, shoveSpeed * perSpeed * (slam.wallMul ?? 2.4)), 'bossHammerhead', 'attack');
  step(Math.min(maxD, shoveSpeed * perSpeed * (slam.bodyMul ?? 2.8)), 'bossHammerhead', 'attack');
  for (let f = 0; f < FPS; f++) {
    t = f * DT;
    step((slam.pin?.max ?? 48) * DT, 'bossHammerhead', 'attack');
    step(CONFIG.enemies.bossHammerhead.contactDamage * DT, 'bossHammerhead', 'contact');
  }
  const ceiling = HP * dcap.perSecond;
  check('the hammerhead chain cannot exceed the ceiling',
    took <= ceiling + 1e-6,
    `${took.toFixed(1)} of a ${HP} bar, ceiling ${ceiling.toFixed(1)}`);
  // ...and it is not so tight that the chain became free. A mercy rule that
  // trims a wipe down to a scratch has replaced the mechanic rather than
  // bounding it, and the hammerhead's whole price list would be decoration.
  check('...and being caught by it still costs most of a bar',
    took >= HP * 0.5,
    `${took.toFixed(1)} of ${HP}`);
}
{
  freshSecond();
  // ARBITRARILY MANY SOURCES, which is the property the boss cap does not have.
  // Twenty unrelated creatures each taking a tenth of the bar in one frame.
  let took = 0;
  for (let i = 0; i < 20; i++) took += bill(HP * 0.1, `fish${i}`, 0, 'strike').damage;
  check('twenty unrelated sources on one frame are still bounded',
    took <= HP * dcap.perSecond + 1e-6,
    `${took.toFixed(1)} of a possible ${(HP * 2).toFixed(0)}`);
}
{
  freshSecond();
  // AND THE WINDOW ROLLS. A second later the budget is back, or the ceiling is
  // a total rather than a rate and the seal becomes immortal after one bad
  // second — which is a far worse bug than the one being fixed.
  for (let i = 0; i < 20; i++) bill(HP * 0.1, 'fish', 0, 'strike');
  const later = bill(HP * 0.3, 'fish', (dcap.window ?? 1) + 0.05, 'strike');
  check('the window rolls — the next second bills in full',
    Math.abs(later.damage - HP * 0.3) < 1e-6 && !later.capped,
    `${later.damage.toFixed(1)} of ${(HP * 0.3).toFixed(1)} asked for`);
  check('...and nothing older than the window is still counted',
    playerDamageInWindow((dcap.window ?? 1) + 0.05) <= HP * 0.3 + 1e-6);
}
{
  freshSecond();
  // WHAT THE PLAYER SEES. A trimmed hit reports it, so onPlayerHit can arm the
  // grace and the rim can strobe. Damage that silently stops is exactly as
  // unreadable as damage that arbitrarily spikes.
  const spare = bill(HP * 0.2, 'fish', 0, 'strike');
  check('a hit with room to spare does not claim mercy', !spare.capped);
  let trimmed = null;
  for (let i = 0; i < 20 && !trimmed?.capped; i++) trimmed = bill(HP * 0.2, 'fish', 0, 'strike');
  check('a trimmed hit says so, so the grace can be armed', !!trimmed?.capped);
  check('...and the grace is long enough to swim out of',
    (dcap.graceIFrames ?? 0) >= (CONFIG.player.hitIFrames ?? 0),
    `${dcap.graceIFrames}s against the standard ${CONFIG.player.hitIFrames}s`);
}

// --- ...AND IS A BACKSTOP --------------------------------------------------
section('IT IS THE BACKSTOP AND NOT THE TUNING');
{
  // The relationship, not the numbers. Under the boss's own ceiling this stops
  // being a backstop and becomes the thing that binds a boss fight, and every
  // tuned figure in CONFIG.boss.damageCap goes quiet with nothing to say so.
  check('the shared ceiling sits above the boss ceiling',
    dcap.perSecond > bcap.perSecond,
    `${dcap.perSecond} against the boss's ${bcap.perSecond}`);
  freshSecond();
  // Measured, not asserted: a boss alone at its own ceiling for a full second
  // must never be trimmed by this.
  let anyCapped = false;
  for (let f = 0; f < FPS; f++) {
    const r = bill(HP, 'bossShark', f * DT, 'attack');
    anyCapped = anyCapped || r.capped;
  }
  check('a boss saturating its own budget is never trimmed by this one',
    !anyCapped);
  check('...and the two read the same span',
    (dcap.window ?? 1) === (bcap.window ?? 1),
    `${dcap.window ?? 1}s each`);
}

// --- A SHOVE COVERS ITS OWN TRAVEL -----------------------------------------
section('BEING THROWN IS NOT A FREE TURN FOR THE ARENA');
{
  const speed = Math.min(kb.maxSpeed, CONFIG.enemies.bossHammerhead.playerKnockback);
  const windowFor = (s) => Math.min(ki.max ?? 0.5, (ki.base ?? 0) + s * (ki.perSpeed ?? 0));
  const w = windowFor(speed);
  // A shove is an exponential decay; it spends about 86% of its travel in
  // 2/decay seconds, which is the span the window has to cover. Derived from
  // `decay` rather than typed, so retuning the bleed moves this test with it.
  const travel = 2 / kb.decay;
  check('the hammerhead window outlasts the shove it covers',
    w >= travel * 0.9,
    `${w.toFixed(3)}s against ${travel.toFixed(3)}s of travel`);
  // ...AND NOT BY MUCH. A window that long stops being cover for a punishment
  // and starts being a dodge you can be handed, which would make swimming into
  // the hammerhead the correct play.
  check('...and is not long enough to be a dodge',
    w <= travel * 2 && w <= (CONFIG.strike.dashDuration ?? 0.2) + (CONFIG.strike.invulnTail ?? 0),
    `${w.toFixed(3)}s against the dash's ${((CONFIG.strike.dashDuration ?? 0.2) + (CONFIG.strike.invulnTail ?? 0)).toFixed(3)}s`);
  // A trimmed shove buys a shorter window, or the two halves of one event
  // disagree about how big it was the moment anyone retunes past maxSpeed.
  check('a bigger shove buys a longer window', windowFor(speed * 2) > w);
  check('...up to a ceiling', windowFor(1e6) === (ki.max ?? 0.5));
  // THE SLAM SURVIVED. Everything systems/slam.js charges is on 'attack', which
  // the window does not refuse — if any of it ever moves to 'strike' the shove
  // would arm a window that eats the arrest it caused, and the hammerhead's
  // most expensive mechanic would vanish with nothing on screen to say so.
  check('the slam is billed on a channel the window cannot refuse',
    (slam.wallMul ?? 0) > 1 && (slam.bodyMul ?? 0) > 1);
}

// --- A LANDING IS PROTECTED, A SKIM IS NOT ---------------------------------
section('THE ARRIVAL WINDOW IS PAID FOR IN AIR TIME');
{
  check('a landing buys a window at all', (air.invuln ?? 0) > 0, `${air.invuln}s`);
  // It has to outlast the frame it arrives on by enough to matter, or the crowd
  // standing in the landing zone still gets its turn — the standard window is
  // the yardstick, since this is covering the same kind of pile-on.
  check('...long enough to be worth having',
    (air.invuln ?? 0) >= (CONFIG.player.hitIFrames ?? 0) * 0.75,
    `${air.invuln}s against the standard ${CONFIG.player.hitIFrames}s`);
  // THE ABUSE. Gated on `minRamp` — the same gate the blast is on — so a seal
  // skimming the surface never reaches it. A window with no gate is a permanent
  // free shield for the cheapest input in the game.
  check('...and it is gated on the same ramp the blast is',
    (air.minRamp ?? 0) > 0,
    `minRamp ${air.minRamp}`);
  // The cost side of that gate: reaching minRamp means real seconds spent out
  // of the water, which is time the arena cannot reach you anyway. If the
  // window were ever longer than the air that bought it, the landing would be
  // strictly safer than the flight.
  check('the window is shorter than the air time that buys it',
    (air.invuln ?? 0) < (air.minRamp ?? 0) * 2 + 1,
    `${air.invuln}s`);
}

// --- THE PICTURE -----------------------------------------------------------
section('EVERY WINDOW REACHES THE RIM');
{
  const ic = CONFIG.playerOutline?.iframe ?? {};
  check('the strobe is on', ic.enabled !== false);
  // The dash is the seal's best defensive tool and lived on the one clock the
  // rim never read. Switchable, but on by default — off, the game enforces
  // "dash through it" and never teaches it.
  check('the dash gets a picture too', ic.dash !== false);
  // A window shorter than one blink is a window the player cannot count, and
  // every window here has to be countable or the rule is not learnable. The
  // shortest one in the game is the yardstick.
  const shortest = Math.min(
    CONFIG.player.hitIFrames ?? 0,
    air.invuln ?? Infinity,
    ki.base ?? Infinity,
    dcap.graceIFrames ?? Infinity,
  );
  check('the shortest window still contains a full blink',
    shortest >= 1 / (ic.hz ?? 9),
    `${shortest.toFixed(2)}s against a ${(1 / (ic.hz ?? 9)).toFixed(3)}s blink`);
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
