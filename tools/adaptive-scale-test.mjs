#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ADAPTIVE RESOLUTION (systems/adaptiveScale.js) — npm run test:autoscale
//
// A feedback loop with three thresholds and two streak counters, controlling
// the single most visible knob in the game. Every failure mode here is one
// that looks like a bug in something else:
//
//   OSCILLATION      raising the resolution is what makes the machine slow
//                    again, so a symmetric controller pumps forever and the
//                    player watches the game breathe in and out.
//   OVERREACTION     one boss arriving is a 300ms frame. Judged on a MEAN it
//                    drops the whole game's resolution; judged on the SHARE of
//                    frames over budget it does not.
//   MENU FRAMES      a loading screen renders 400ms frames the GPU had nothing
//                    to do with. Counted, the game starts every run cut to the
//                    floor for no reason.
//   HANDING OUT FREE PIXELS  the controller must never raise the scale above
//                    1, or it overrides the player's own Resolution setting
//                    with pixels their panel may not have.
// ---------------------------------------------------------------------------
import { CONFIG } from '../path/src/config.js';
import { createAdaptiveScale } from '../path/src/systems/adaptiveScale.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const cfg = CONFIG.render.adaptive;
const SLOW = cfg.targetMs + 10;   // comfortably over budget
const FAST = cfg.targetMs - 6;    // comfortably under

/** Feed n frames of a given duration; returns how many times it moved. */
function feed(a, n, ms, live = true) {
  let moved = 0;
  for (let i = 0; i < n; i++) if (a.tick(ms, live)) moved++;
  return moved;
}

// ---------------------------------------------------------------------------
section('It cuts when the machine cannot hold the frame rate');
{
  const a = createAdaptiveScale();
  feed(a, 60, SLOW);
  check('it does not act before it has seen a full window', a.value === 1,
    `${a.value.toFixed(2)}x after 60 frames`);
  feed(a, 240, SLOW);
  check('sustained slow frames cut the resolution', a.value < 1, `${a.value.toFixed(2)}x`);
  feed(a, 3000, SLOW);
  check('and it never goes below the floor', a.value >= cfg.floor - 1e-9,
    `${a.value.toFixed(2)}x, floor ${cfg.floor}`);
  // Exactly the number of steps between 1.0 and the floor, and not one more:
  // a drop clamped by the floor must not be counted as a drop, or `maxDrops`
  // measures attempts rather than changes.
  const steps = Math.round((1 - cfg.floor) / cfg.step);
  check('it counts steps taken, not attempts made', a.drops === steps,
    `${a.drops} drops for ${steps} steps from 1.0 to ${cfg.floor}`);
}

// ---------------------------------------------------------------------------
section('It never hands out pixels the player did not ask for');
{
  const a = createAdaptiveScale();
  feed(a, 3000, FAST);
  check('a machine that is coping is left exactly alone', a.value === 1,
    `${a.value.toFixed(2)}x after 3000 fast frames`);
  check('and nothing was reapplied', a.drops === 0, `${a.drops} drops`);
}

// ---------------------------------------------------------------------------
section('One stall is not a reason to cut');
{
  // A boss arriving. 119 clean frames and one 300ms frame, over and over: the
  // MEAN of that window is over any sensible budget, the SHARE is under 1%.
  const a = createAdaptiveScale();
  for (let round = 0; round < 40; round++) {
    feed(a, 119, FAST);
    a.tick(300, true);
  }
  check('a single stall per window never cuts the resolution', a.value === 1,
    `${a.value.toFixed(2)}x over 40 windows with a 300ms spike in each`);
}

// ---------------------------------------------------------------------------
section('Frames the GPU had nothing to do with are ignored');
{
  const a = createAdaptiveScale();
  // A loading screen: very slow frames, but not a live run.
  feed(a, 600, 400, false);
  check('menu and loading frames do not cut anything', a.value === 1,
    `${a.value.toFixed(2)}x after 600 slow menu frames`);

  // And a tab returning from the background, which IS live but is a gap.
  feed(a, 600, 5000, true);
  check('a backgrounded tab returning is not a slow frame', a.value === 1,
    `${a.value.toFixed(2)}x`);
}

// ---------------------------------------------------------------------------
section('It settles instead of oscillating');
{
  // The realistic loop: the machine is slow at full resolution and fine below
  // it. A symmetric controller pumps between the two forever; this one must
  // come to rest. Frame time is modelled as proportional to pixel count, which
  // is the whole premise of cutting resolution in the first place.
  const a = createAdaptiveScale();
  const trace = [];
  for (let i = 0; i < 6000; i++) {
    // 22ms at 1.0, scaling with the pixel area the scale implies.
    const ms = 6 + 16 * a.value;
    a.tick(ms, true);
    if (i % 500 === 0) trace.push(a.value.toFixed(1));
  }
  const settled = a.value;
  const last2000 = [];
  for (let i = 0; i < 2000; i++) { a.tick(6 + 16 * a.value, true); last2000.push(a.value); }
  const moved = last2000.filter((v) => v !== settled).length;
  // AND IT MUST NOT OVERSHOOT. 0.7 puts this machine at 17.2ms, inside the
  // 18ms budget, so a controller that lands on the 0.6 floor has taken pixels
  // it did not need — which is what happens when the window is not cleared
  // after a cut. See `settle`.
  check('it comes to rest at a scale the machine can hold',
    settled < 1 && settled >= cfg.floor, `settled at ${settled.toFixed(2)}x  [${trace.join(' ')}]`);
  check('and takes no more than it needed', settled > cfg.floor,
    `settled ${settled.toFixed(2)}x, floor ${cfg.floor} — 0.7 is inside budget here`);
  check('and stays there rather than pumping',
    moved === 0, `${moved} of 2000 later frames moved it`);
  check('the frame time it settled at is inside budget',
    6 + 16 * settled <= cfg.targetMs + 0.01, `${(6 + 16 * settled).toFixed(1)}ms vs ${cfg.targetMs}ms budget`);
}

// ---------------------------------------------------------------------------
section('A new run starts where the last one settled, and can still climb back');
// It used to go back to 1.0, and on the machine this feature exists for that
// meant re-proving the same verdict every run: eleven of twelve recorded phone
// runs ended at the 0.6 floor, and every one opened at 1.0 and walked down to
// it. At the shipped pixelRatio of 3 that walk is 3.16 megapixels against the
// 1.14 it settles on, with post.js's render targets at 47MB instead of 17MB —
// most of a minute of the worst frames in the run, on the device being killed
// for memory, once per run.
{
  const a = createAdaptiveScale();
  feed(a, 3000, SLOW);
  const cut = a.value;
  a.reset();
  check('the scale carries into the next run', a.value === cut, `${a.value.toFixed(2)}x`);
  check('and the drop count does not', a.drops === 0);

  // THE HALF THAT KEEPS IT HONEST. Carrying the scale without clearing `drops`
  // would be a verdict rather than a starting point — maxDrops gates recovery,
  // so a machine that had spent its round trips could never climb back and the
  // first bad minute of a session would set the resolution for all of it. A
  // phone that has cooled between runs has to be able to get its pixels back.
  feed(a, 6000, FAST);
  check('...so a machine that is now coping recovers', a.value > cut,
    `${cut.toFixed(2)}x -> ${a.value.toFixed(2)}x`);
}

// ---------------------------------------------------------------------------
section('Turned off');
{
  const was = cfg.enabled;
  cfg.enabled = false;
  const a = createAdaptiveScale();
  feed(a, 3000, SLOW);
  check('it does nothing at all', a.value === 1, `${a.value.toFixed(2)}x`);
  cfg.enabled = was;
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
