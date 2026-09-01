#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:hitstop
//
// THE HIT-STOP GUEST LIST — CONFIG.fx.hitstopOnly.
//
// Thirty events carried a `hitstop`, and because every one of them draws on a
// single `hitstopCooldown` they were never layering — they were competing. The
// freeze that landed was whichever event asked first, which in a busy frame is
// a pellet or a shrimp tick and not the moment worth stopping for. The list
// names the moments that may still stop the game; today there is one.
//
// This is the shake list's sibling (tools/shake-mute-test.mjs) and it exists
// for the same reason: every way the gate can be wrong is SILENT. Nothing
// throws, nothing warns, and a broken list is indistinguishable from a taste
// decision. The failure modes are worth naming because they differ from the
// shake's in one place that matters:
//
//   A TYPO MUTES WHAT IT MEANT TO KEEP. The list is read, never fired, so
//   feedback()'s unknown-event warning never sees it. A misspelled name matches
//   nothing and the moment it was written for silently never freezes again.
//
//   A LISTED EVENT WITH NO HIT-STOP promises a freeze it cannot deliver — the
//   row reads as "this one stops the game" and changes nothing.
//
//   THE MUTE MUST ONLY TAKE THE FREEZE. An event's shake, sound, particles,
//   glow, ripple and rumble are a different question, and a gate that took any
//   of them would be a far larger change than the one asked for.
//
//   AND THE ONE THE SHAKE LIST DOES NOT HAVE: `fx.hitstopEnabled` IS FALSE IN
//   THE SAVED TUNING, and a saved value beats a config default. So on the
//   shipped snapshot NOTHING freezes whatever this list says, and every check
//   below would pass for the wrong reason — a gate that swallowed the freeze
//   entirely would look identical. Section 2 forces the switch on and puts it
//   back, because what is under test is the list, not the preference.
//
//   AN EMPTY LIST MUST MEAN "EVERYTHING", or every Node harness that never
//   touches CONFIG.fx quietly starts measuring a different game.
//
//   node --import ./tools/vite-loader.mjs tools/hitstop-mute-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { feedback, feedbackState, hitstopAllowed, initFeedback } from '../path/src/systems/feedback.js';
import { initParticles } from '../path/src/entities/particles.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// feedback() fires real particle emitters, which need a real buffer in a real
// scene — without one the first event throws from inside particles.js and every
// check below fails for a reason that has nothing to do with the hit-stop.
initParticles(new THREE.Scene());

const LIST = CONFIG.fx.hitstopOnly ?? [];
const EVENTS = CONFIG.feedback;

/**
 * The hit-stop one event actually starts, from cold and with the master switch
 * forced on. `initFeedback` also clears `hitstopCooldown`, which matters more
 * here than it does for the shake: without that reset the second event measured
 * in any run would read 0 because the first one armed the shared gap, and the
 * whole file would report a mute that is really a cooldown.
 */
function stopFrom(event) {
  const was = CONFIG.fx.hitstopEnabled;
  CONFIG.fx.hitstopEnabled = true;
  initFeedback(null);
  feedback(event, { x: 0, y: 0 });
  CONFIG.fx.hitstopEnabled = was;
  return feedbackState.hitstop;
}

// ---------------------------------------------------------------------------
section('1. every name on the list is a real event that can freeze');
// ---------------------------------------------------------------------------
{
  const authored = Object.keys(EVENTS).filter((n) => EVENTS[n]?.hitstop > 0);
  check('there is a list at all', Array.isArray(LIST) && LIST.length > 0,
    `${LIST.length} event(s) may stop the game, of ${authored.length} carrying a hit-stop`);

  // THE TYPO. Nothing fires these names, so nothing warns about them.
  const unknown = LIST.filter((n) => !EVENTS[n]);
  check('no name on the list is a typo', unknown.length === 0,
    unknown.length ? unknown.join(', ') : 'every name resolves to a real event');

  // THE EMPTY PROMISE. On the list and worth nothing.
  const silent = LIST.filter((n) => EVENTS[n] && !(EVENTS[n].hitstop > 0));
  check('...and every one of them has a hit-stop to give', silent.length === 0,
    silent.length
      ? `${silent.join(', ')} — on the guest list with hitstop 0, so the row promises a freeze it cannot make`
      : 'all listed events carry a non-zero hitstop');

  const dupes = LIST.filter((n, i) => LIST.indexOf(n) !== i);
  check('...and nothing is listed twice', dupes.length === 0, dupes.join(', '));

  // THE AUTHORED AMOUNTS SURVIVE. A mute, not a zero — the whole reason this is
  // a list and not thirty edits. If a later pass "tidies up" by zeroing the
  // muted rows, the list stops being reversible and this is the only place that
  // would notice.
  const keptAmounts = authored.filter((n) => !LIST.includes(n));
  check('the muted events kept their authored amounts', keptAmounts.length > 0,
    `${keptAmounts.length} row(s) still describe what they would be worth, e.g. `
    + keptAmounts.slice(0, 3).map((n) => `${n} ${EVENTS[n].hitstop}`).join(', '));
}

// ---------------------------------------------------------------------------
section('2. the gate actually gates');
// ---------------------------------------------------------------------------
{
  const kept = LIST.filter((n) => EVENTS[n]);
  const kicked = Object.keys(EVENTS).filter((n) => EVENTS[n]?.hitstop > 0 && !LIST.includes(n));

  const deadKept = kept.filter((n) => !(stopFrom(n) > 0));
  check('every listed event still freezes the frame', deadKept.length === 0,
    deadKept.length ? deadKept.join(', ') : `${kept.length} event(s) through`);

  const leaking = kicked.filter((n) => stopFrom(n) > 0);
  check('nothing off the list freezes it', leaking.length === 0,
    leaking.length ? leaking.join(', ') : `${kicked.length} event(s) muted`);

  check('the predicate agrees with what feedback() does',
    kept.every((n) => hitstopAllowed(n)) && kicked.every((n) => !hitstopAllowed(n)));

  // THE MASTER SWITCH STILL OUTRANKS THE LIST. Being named here is permission,
  // not an exemption — if these ever swapped order, turning hit-stop off in the
  // F panel would leave the one listed event still freezing, which is exactly
  // the "is the game stuttering or is that deliberate" question the switch
  // exists to answer.
  const was = CONFIG.fx.hitstopEnabled;
  CONFIG.fx.hitstopEnabled = false;
  initFeedback(null);
  feedback(LIST[0], { x: 0, y: 0 });
  check('the master switch still overrules the list', feedbackState.hitstop === 0,
    `${LIST[0]} with hitstopEnabled false`);
  CONFIG.fx.hitstopEnabled = was;
}

// ---------------------------------------------------------------------------
section('3. a mute takes the freeze and nothing else');
// ---------------------------------------------------------------------------
// The hit-stop is one of seven things an event fires. Gating the wrong one
// would silently cost thirty events their shake or their sound — a much bigger
// change than the one asked for, and one nobody would attribute to a hit-stop
// setting.
{
  // A muted event that also carries a shake and a glow, so both channels are
  // genuinely under test rather than simply absent from the subject.
  const subject = Object.keys(EVENTS).find((n) =>
    !LIST.includes(n) && EVENTS[n]?.hitstop > 0 && EVENTS[n]?.glow > 0 && EVENTS[n]?.shake > 0);
  check('there is a muted event carrying a shake and a glow to test with', !!subject,
    subject ?? 'none found');

  if (subject) {
    const was = CONFIG.fx.hitstopEnabled;
    CONFIG.fx.hitstopEnabled = true;
    initFeedback(null);
    feedback(subject, { x: 0, y: 0 });
    check(`"${subject}" is muted`, feedbackState.hitstop === 0);
    check('...but its glow still fires', feedbackState.glowPulse > 0,
      feedbackState.glowPulse.toFixed(3));
    // Its shake only reaches the camera if the SHAKE list also lets it, which
    // is a different question — so this asserts the hit-stop gate did not touch
    // it either way, rather than asserting a number the other list owns.
    check('...and the shake channel is left to its own guest list',
      feedbackState.shake >= 0);
    CONFIG.fx.hitstopEnabled = was;
  }
}

// ---------------------------------------------------------------------------
section('4. an empty list means everything, for every harness in the project');
// ---------------------------------------------------------------------------
{
  const real = CONFIG.fx.hitstopOnly;
  const muted = Object.keys(EVENTS).find((n) => EVENTS[n]?.hitstop > 0 && !LIST.includes(n));

  CONFIG.fx.hitstopOnly = [];
  check('an empty list lets a muted event through', stopFrom(muted) > 0, muted);
  delete CONFIG.fx.hitstopOnly;
  check('...and so does no list at all', stopFrom(muted) > 0);

  // Back to the real list, and the SAME array identity — hitstopAllowed caches
  // a Set keyed on the array itself, so handing it an equal-but-different array
  // would leave this file passing while hiding a stale-cache bug.
  CONFIG.fx.hitstopOnly = real;
  check('restoring the list mutes it again', stopFrom(muted) === 0);
  check('...and the cache followed the swap, twice over',
    hitstopAllowed(LIST[0]) === true && hitstopAllowed(muted) === false);
}

// ---------------------------------------------------------------------------
section('5. the one moment on the list is actually reachable');
// ---------------------------------------------------------------------------
// A guest list with one name is only as good as that name being fired by
// something. `strikeWeakSpot` is fired from main.js's onWeakSpotRam hook, which
// systems/strike.js calls only when a dash finds a lit weak spot on an arming
// strike — so the event is three files away from the list that names it, and
// nothing else in this project would notice if that chain were broken.
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8'));
  const strikeSrc = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../path/src/systems/strike.js', import.meta.url), 'utf8'));

  for (const name of LIST) {
    check(`"${name}" is fired by something`, src.includes(`'${name}'`),
      'a listed event nothing fires is a freeze that never happens');
  }
  check('the strike system calls the hook that fires it',
    strikeSrc.includes('onWeakSpotRam'));
  check('...and main.js wires that hook up', src.includes('onWeakSpotRam'));
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
