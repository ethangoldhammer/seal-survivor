#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:shake
//
// THE SHAKE GUEST LIST — CONFIG.fx.shakeOnly.
//
// A hundred and sixteen events carried a shake, which is the same as none of
// them carrying one: a shake says "this one mattered", and it cannot say that
// while a bullet, a pickup and a garlic tick are all saying it too. The list
// names the moments that still get the camera.
//
// Every way it can be wrong is SILENT, which is the whole reason this file
// exists — nothing throws, nothing warns, and a broken list looks exactly like
// a taste decision from the outside:
//
//   A TYPO MUTES WHAT IT MEANT TO KEEP. `feedback()` warns loudly about an
//   unknown event name, but this list is never fired — it is only read. A name
//   misspelled here matches nothing, so the event it was written for stays
//   muted forever and the list still looks like it says otherwise.
//
//   A LISTED EVENT WITH NO SHAKE is a row that promises the camera and cannot
//   deliver. `bossDeath` is the live example: it is the biggest moment in a
//   fight and carries no shake at all, so putting it on the list would have
//   read as "boss kills shake" while changing nothing.
//
//   THE MUTE MUST ONLY TAKE THE CAMERA. The shake is one of six things an
//   event fires, and gating the wrong one would silently cost a hundred events
//   their sound or their hit-stop — a far bigger change than the one asked for,
//   and one nobody would attribute to a camera setting.
//
//   AN EMPTY LIST MUST MEAN "EVERYTHING", or every Node harness in this project
//   that never touches CONFIG.fx quietly starts measuring a different game.
//
//   node --import ./tools/vite-loader.mjs tools/shake-mute-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { feedback, feedbackState, shakeAllowed, initFeedback } from '../path/src/systems/feedback.js';
import { initParticles } from '../path/src/entities/particles.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// feedback() fires real particle emitters, which need a real buffer in a real
// scene — without one the first event throws from inside particles.js and every
// check below fails for a reason that has nothing to do with the shake.
initParticles(new THREE.Scene());

const LIST = CONFIG.fx.shakeOnly ?? [];
const EVENTS = CONFIG.feedback;

/** The shake one event actually contributes, from cold. */
function shakeFrom(event) {
  initFeedback(null);
  feedback(event, { x: 0, y: 0 });
  return feedbackState.shake;
}

// ---------------------------------------------------------------------------
section('1. every name on the list is a real event that can shake');
// ---------------------------------------------------------------------------
{
  check('there is a list at all', Array.isArray(LIST) && LIST.length > 0,
    `${LIST.length} event(s) keep the camera of ${Object.keys(EVENTS).length} total`);

  // THE TYPO. Nothing fires these names, so nothing warns about them — the
  // event they were written for simply never shakes again.
  const unknown = LIST.filter((n) => !EVENTS[n]);
  check('no name on the list is a typo', unknown.length === 0,
    unknown.length ? unknown.join(', ') : 'every name resolves to a real event');

  // THE EMPTY PROMISE. On the list and worth nothing, which reads in a diff as
  // "this moment shakes" and is not true.
  const silent = LIST.filter((n) => EVENTS[n] && !(EVENTS[n].shake > 0));
  check('...and every one of them has a shake to give', silent.length === 0,
    silent.length
      ? `${silent.join(', ')} — on the guest list with shake 0, so the row promises a camera move it cannot make`
      : 'all listed events carry a non-zero shake');

  const dupes = LIST.filter((n, i) => LIST.indexOf(n) !== i);
  check('...and nothing is listed twice', dupes.length === 0, dupes.join(', '));
}

// ---------------------------------------------------------------------------
section('2. the gate actually gates');
// ---------------------------------------------------------------------------
{
  // Measured through the real feedback() rather than by asking shakeAllowed,
  // which would only prove the predicate agrees with itself.
  const kept = LIST.filter((n) => EVENTS[n]);
  const kicked = Object.keys(EVENTS).filter((n) => EVENTS[n]?.shake > 0 && !LIST.includes(n));

  const deadKept = kept.filter((n) => !(shakeFrom(n) > 0));
  check('every listed event still moves the camera', deadKept.length === 0,
    deadKept.length ? deadKept.join(', ') : `${kept.length} event(s) through`);

  const leaking = kicked.filter((n) => shakeFrom(n) > 0);
  check('nothing off the list moves it', leaking.length === 0,
    leaking.length ? leaking.join(', ') : `${kicked.length} event(s) muted`);

  check('the predicate agrees with what feedback() does',
    kept.every((n) => shakeAllowed(n)) && kicked.every((n) => !shakeAllowed(n)));
}

// ---------------------------------------------------------------------------
section('3. a mute takes the camera and nothing else');
// ---------------------------------------------------------------------------
// The shake is one of six things an event fires. Gating any of the others would
// be a far larger change than the one asked for, and one nobody would think to
// blame on a camera setting.
{
  // A muted event that carries a hit-stop and a glow as well, so both channels
  // are actually under test rather than being absent from the subject.
  const subject = Object.keys(EVENTS).find((n) =>
    !LIST.includes(n) && EVENTS[n]?.shake > 0 && EVENTS[n]?.glow > 0);
  check('there is a muted event carrying a glow to test with', !!subject, subject ?? 'none found');

  if (subject) {
    initFeedback(null);
    feedback(subject, { x: 0, y: 0 });
    check(`"${subject}" is muted`, feedbackState.shake === 0);
    check('...but its glow still fires', feedbackState.glowPulse > 0,
      feedbackState.glowPulse.toFixed(3));
  }

  const stopper = Object.keys(EVENTS).find((n) =>
    !LIST.includes(n) && EVENTS[n]?.shake > 0 && EVENTS[n]?.hitstop > 0);
  if (stopper) {
    // HIT-STOP IS OFF IN THE SAVED TUNING, and a saved value beats a config
    // default — so read as-is this check passes for the wrong reason on the
    // shipped snapshot and would keep passing if the mute swallowed the freeze
    // as well. Forced on for this one assertion and put back after, because
    // what is under test is the gate, not the preference.
    //
    // AND THE FREEZE NOW HAS A GUEST LIST OF ITS OWN (CONFIG.fx.hitstopOnly,
    // covered by tools/hitstop-mute-test.mjs), which almost certainly does not
    // name this subject — so the second gate is emptied here too. Otherwise
    // this check reads "the shake mute took the hit-stop" when what really
    // happened is the hit-stop list correctly declined it, and the two mutes
    // become impossible to tell apart from a failure message.
    const was = CONFIG.fx.hitstopEnabled;
    const wasOnly = CONFIG.fx.hitstopOnly;
    CONFIG.fx.hitstopEnabled = true;
    CONFIG.fx.hitstopOnly = [];
    initFeedback(null);
    feedback(stopper, { x: 0, y: 0 });
    check(`"${stopper}" keeps its hit-stop while shake-muted`, feedbackState.hitstop > 0,
      `${feedbackState.hitstop.toFixed(3)}s, shake ${feedbackState.shake}`);
    CONFIG.fx.hitstopEnabled = was;
    CONFIG.fx.hitstopOnly = wasOnly;
  }
}

// ---------------------------------------------------------------------------
section('4. an empty list means everything, for every harness in the project');
// ---------------------------------------------------------------------------
// Half the harnesses here never touch CONFIG.fx. If an absent list meant
// "nothing shakes" they would all quietly start measuring a different game, and
// so would anyone who deletes the list to get the old behaviour back.
{
  const real = CONFIG.fx.shakeOnly;
  const muted = Object.keys(EVENTS).find((n) => EVENTS[n]?.shake > 0 && !LIST.includes(n));

  CONFIG.fx.shakeOnly = [];
  check('an empty list lets a muted event through', shakeFrom(muted) > 0, muted);
  delete CONFIG.fx.shakeOnly;
  check('...and so does no list at all', shakeFrom(muted) > 0);

  // Back to the real list, and the SAME array identity — shakeAllowed caches a
  // Set keyed on the array itself, so handing it an equal-but-different array
  // would leave this file passing while hiding a stale-cache bug.
  CONFIG.fx.shakeOnly = real;
  check('restoring the list mutes it again', shakeFrom(muted) === 0);
  check('...and the cache followed the swap, twice over',
    shakeAllowed(LIST[0]) === true && shakeAllowed(muted) === false);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
