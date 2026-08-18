#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:salute
//
// THE LEVEL-UP SALUTE — the beat the cards are held back for, the snap zoom
// that fills it, and the pose the seal strikes in it. See CONFIG.levelUp
// .salute, systems/levelUpTime.js and startSalute() in main.js.
//
// What this exists to catch, none of which is visible by looking at the code:
//
//   * THE CARDS ACTUALLY WAIT. Three tunable times decide when the menu
//     arrives and they are summed in one place (cardsArriveAt). A camera push
//     and a pose timed against a beat that never got longer is the shape this
//     feature fails in — it looks implemented and lands on top of the menu.
//   * THE SNAP IS A SNAP. A zoom that eases in over a third of a second is
//     the slow push the death dive already does, and reads as the opposite
//     feeling. Measured as travel time, not as a config read.
//   * THE PUSH SURVIVES THE PHASE CHANGES UNDER IT. `clock` restarts twice
//     during one level — at the bottom of the ramp and again on the pick — so
//     an envelope driven off it snaps back to a full close-up the instant the
//     player chooses a card. That is exactly what a fast picker would see and
//     nothing else in the suite would.
//   * THE CLAIM IS RELEASED. world.focusCamera's zoom applies at ANY weight,
//     so a claim left standing at weight 0 pins the cinematic rig's zoom out
//     of the frame for as long as the menu is up.
//   * THE POSE IS THE RIGHT POSE, ON THE RIGHT CLOCK. It rolls from the
//     salute's own roster (a somersault is not what a level is worth), peaks
//     before the cards, and keeps the escorts out — they are frozen for all of
//     this and would otherwise clap seconds late.
// ---------------------------------------------------------------------------

import { CONFIG } from '../path/src/config.js';
import {
  levelUpState, startLevelUpTime, updateLevelUpTime, endLevelUpTime,
  resetLevelUpTime, cardsArriveAt, saluteBeat,
} from '../path/src/systems/levelUpTime.js';
import { celebrationState, playCelebration, resetCelebration, CELEBRATION_VARIANTS } from '../path/src/systems/celebrate.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const FRAME = 1 / 120; // finer than a real frame, so a 0.06s attack has resolution

/**
 * Run a level-up forward and record the camera every frame.
 *
 * @param until   wall seconds to run for.
 * @param pickAt  wall seconds at which the player takes a card, or null.
 * @returns { readyAt, samples: [{ t, zoom, weight }] }
 */
function runLevel({ until = 3, pickAt = null } = {}) {
  resetLevelUpTime();
  const samples = [];
  let readyAt = null;
  let t = 0;
  startLevelUpTime(() => { readyAt = t; });
  samples.push({ t, zoom: levelUpState.camZoom, weight: levelUpState.camWeight });
  let picked = false;
  while (t < until) {
    updateLevelUpTime(FRAME);
    t += FRAME;
    if (pickAt != null && !picked && t >= pickAt) { picked = true; endLevelUpTime(); }
    samples.push({ t, zoom: levelUpState.camZoom, weight: levelUpState.camWeight });
  }
  return { readyAt, samples };
}

const s = CONFIG.levelUp.salute;
const cards = cardsArriveAt();

console.log('\nthe beat');
check('the salute is on', s.enabled !== false);
check(
  'the cards wait for dilate + menuDelay + beat',
  Math.abs(cards - (CONFIG.levelUp.dilateTime + CONFIG.levelUp.menuDelay + s.beat)) < 1e-9,
  `${cards.toFixed(3)}s`,
);
check('the beat is the half second that was asked for', saluteBeat() >= 0.4, `${saluteBeat()}s`);

{
  const { readyAt } = runLevel({ until: 2 });
  check('the cards arrive on that beat and not before', readyAt != null && Math.abs(readyAt - cards) <= FRAME * 1.5,
    `readyAt=${readyAt?.toFixed(3)}s vs cards=${cards.toFixed(3)}s`);
  // The regression this whole block exists for: the old timing, with the beat
  // added, must be strictly LATER than the old timing without it.
  const wasBefore = CONFIG.levelUp.dilateTime + CONFIG.levelUp.menuDelay;
  check('that is later than the menu used to arrive', readyAt > wasBefore + 0.4,
    `${readyAt.toFixed(3)}s vs the old ${wasBefore.toFixed(3)}s`);
}

// Switched off, the ramp is exactly what it always was — the salute is an
// addition to this sequence, not a rewrite of it.
{
  const was = s.enabled;
  s.enabled = false;
  const { readyAt, samples } = runLevel({ until: 2 });
  check('switched off, the cards arrive on the original beat',
    Math.abs(readyAt - (CONFIG.levelUp.dilateTime + CONFIG.levelUp.menuDelay)) <= FRAME * 1.5,
    `${readyAt.toFixed(3)}s`);
  check('switched off, nothing ever claims the frame',
    samples.every((p) => p.weight === 0 && p.zoom === 1));
  s.enabled = was;
  resetLevelUpTime();
}

console.log('\nthe snap');
{
  const { samples } = runLevel({ until: 3 });
  const peak = Math.max(...samples.map((p) => p.zoom));
  check('the frame really pushes in', peak > 1.5, `peak zoom ${peak.toFixed(2)}x`);
  check('it pushes in to what the config asks for', Math.abs(peak - s.zoom) < 0.02,
    `${peak.toFixed(3)}x vs ${s.zoom}x`);

  // TRAVEL TIME, not a config read: from the first frame that has moved at all
  // to the first that is within 5% of the target.
  const target = 1 + (s.zoom - 1) * 0.95;
  const arrived = samples.find((p) => p.zoom >= target);
  check('it lands in a handful of frames', arrived && arrived.t <= 0.12,
    `${arrived ? arrived.t.toFixed(3) : '-'}s to 95%`);
  check('it is a snap, not the death dive\'s slow push', arrived && arrived.t < 0.2);

  // Still tight on the seal as the cards land, opening out underneath them.
  const atCards = samples.find((p) => p.t >= cards);
  check('the frame is still in on the seal as the cards arrive', atCards.weight > 0.9,
    `weight ${atCards.weight.toFixed(2)}`);
  const after = samples.find((p) => p.t >= cards + s.release + FRAME);
  check('and fully released once the cards are up', after.weight === 0 && after.zoom === 1,
    `weight ${after.weight}, zoom ${after.zoom}`);

  // A claim left standing at weight 0 still writes a zoom — see the header.
  check('the claim is dropped rather than held at zero',
    samples.slice(-20).every((p) => p.weight === 0 && p.zoom === 1));
}

console.log('\nthe push under a fast pick');
{
  // A card taken partway through the release restarts `clock` in
  // levelUpTime.js. The envelope must not notice.
  const pickAt = cards + s.release * 0.4;
  const { samples } = runLevel({ until: 3, pickAt });
  const from = samples.filter((p) => p.t >= cards);
  let rose = null;
  for (let i = 1; i < from.length; i++) {
    if (from[i].weight > from[i - 1].weight + 1e-6) { rose = from[i].t; break; }
  }
  check('the close-up never comes back after the cards', rose == null,
    rose == null ? '' : `weight rose again at ${rose.toFixed(3)}s`);
  const after = samples.find((p) => p.t >= cards + s.release + 0.05);
  check('it is fully out even though the pick restarted the ramp', after.weight === 0);
}

console.log('\nthe pose');
{
  const roster = Object.keys(s.poses ?? {});
  check('the salute has a roster', roster.length > 0, roster.join(', '));
  check('every name in it is a pose the seal knows',
    roster.every((n) => CELEBRATION_VARIANTS.includes(n)),
    roster.filter((n) => !CELEBRATION_VARIANTS.includes(n)).join(', ') || 'all resolve');
  check('a somersault is not on it', !roster.includes('flip'));

  // main.js's startSalute, reproduced — the timing is the thing under test and
  // it is derived, so a copy of the numbers here would prove nothing.
  const peak = Math.max(0.05, cardsArriveAt() - (s.poseLead ?? 0.12));
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    resetCelebration();
    const v = playCelebration({
      weights: s.poses, peakAt: peak, hold: s.poseHold, release: s.poseRelease, escorts: false,
    });
    seen.add(v);
  }
  check('it only ever rolls poses from its own roster',
    [...seen].every((v) => roster.includes(v)), [...seen].join(', '));
  check('and rolls more than one of them over a run\'s worth of levels', seen.size > 1);

  resetCelebration();
  playCelebration({ weights: s.poses, peakAt: peak, hold: s.poseHold, release: s.poseRelease, escorts: false });
  check('full extension lands before the cards do', celebrationState.peakAt < cards,
    `peak ${celebrationState.peakAt.toFixed(3)}s vs cards ${cards.toFixed(3)}s`);
  check('but late enough that the pose is still up as they land', celebrationState.peakAt > cards - 0.4,
    `${(cards - celebrationState.peakAt).toFixed(3)}s of lead`);
  check('the squad sits it out', celebrationState.escorts === false);
  check('the performance carries its own release, not the boss kill\'s',
    Math.abs(celebrationState.release - s.poseRelease) < 1e-9,
    `${celebrationState.release}s`);
  // duration and envelope() must be computed from the SAME release or the pose
  // is still at full weight on the frame it is torn down.
  check('and its duration is built from that release',
    Math.abs(celebrationState.duration - (celebrationState.peakAt + s.poseHold + s.poseRelease)) < 1e-9,
    `${celebrationState.duration.toFixed(3)}s`);
  // Unknown names are dropped rather than started — a celebration with no pose
  // behind it runs its whole clock posing nothing, which looks like the
  // feature being off.
  resetCelebration();
  check('a typo in the roster starts nothing',
    playCelebration({ weights: { notAPose: 1 } }) === null && celebrationState.active === false);
  resetCelebration();
}

resetLevelUpTime();
console.log(`\n${failures === 0 ? 'all good' : `${failures} failure(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
