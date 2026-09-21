#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:corridor
//
// The dash corridor the lens paints during a wind-up — the cone in post.js,
// fed by the rig in cineCamera.js. Three claims worth failing over:
//
//   FORECAST the cone points at and ends where the dash would LAND.
//            predictDash() in strike.js flies the whole dash — the launch
//            launch, then the per-frame steer toward the stick, throttle,
//            ceiling and drag, through dashSteer(), the very function
//            updatePlayer runs — and main.js hands the camera that chord.
//            The launch heading alone pointed the cone at water the seal
//            never reached, because at 24 rad/s the swing onto the stick is
//            over in a tenth of a second. A separate corridor length number
//            is how the readout went stale before that.
//
//   MOTION   the cone does not snap. Lit, it grows out of the seal from zero;
//            given a new heading it turns onto it over several frames and
//            takes the short way round through 180 degrees, where the old
//            vector-lerp would have collapsed the shape through zero length.
//            Every intermediate frame has to be BETWEEN the two headings.
//
//   LANE     ...and the OTHER corridor — the magnet's — sweeps the line the
//            seal actually flew. `strikeState.dashDir` is written once, at the
//            release, and read every frame by the capsule in chumMagnet.js,
//            by the shove a rammed creature takes, by the boat jostle, by the
//            whale's ram and by the camera's lead. A dash steers up to ninety
//            degrees off its launch, so all of them were describing the line
//            the player let go on rather than the one the seal is on: the food
//            came in from a direction nobody went, and the pile the player
//            curved INTO was out of the lane. updatePlayer keeps it current.
//
//   HANDS    both of them steer, and the steering does not stop dead. The
//            stick steers while it is pushed; the aim steers through the
//            dash's HELD aim, which only a gesture (input.aimMoved) rewrites
//            — a pointer's live heading flips as the seal flies past the
//            cursor, and steering by it turned the seal round with no hand
//            on anything (THE OVERSHOOT below). And the takeover curve
//            hands over the whole turn rate on the dash's LAST frame, after
//            which nothing called dashSteer at all: measured at zero degrees
//            of turn for the seven tenths of a second the momentum takes to
//            bleed off. dashControl.followThrough is the exit from that, and
//            it carries the other two halves of the same handover: the thrust
//            out of a strike (19 u/s^2 against a body doing 34 turns at about
//            22 degrees a second, and the charge bonus is gone because the
//            wind-up just spent the bar) and the speed CEILING, which used to
//            take a fifth of the seal's momentum away in a single frame.
//
//   WIRING   the shader tapers and frays (the uniforms exist and the mask
//            reads them), world.js converts the smoothed world-unit reach to
//            uv with the same divide the focal point uses, and no length
//            slider survives in the tuner. Source-level, because the
//            alternative is a GL context.
//
// Run with:
//   node --import ./tools/vite-loader.mjs tools/strike-corridor-test.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { bounds } from '../path/src/arena.js';
import { predictDash, strikeDirection, dashSteer, steerAuthority, minFire, pipCount,
  strikeState, tryStrike, resetStrike, addCharge, updateStrike, steerFollow } from '../path/src/systems/strike.js';
import { player, initPlayer, resetPlayer, updatePlayer } from '../path/src/entities/player.js';
import { magnetDistance, magnetRadius } from '../path/src/systems/chumMagnet.js';
import * as THREE from 'three';
import { ease } from '../path/src/ease.js';
import { updateCineCamera, resetCineCamera, cineLens } from '../path/src/systems/cineCamera.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../path/src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
// THE CORRIDOR IS OFF IN THE SHIPPED BUILD — systems/strikePath.js draws the
// same forecast as a line out of each seal's head instead, one per seal, where
// a lens has one frame and could only ever light the seal it was framing.
//
// ASSERTED FIRST, THEN TURNED ON FOR THIS FILE. The mechanism is still here
// and still tuned, so these checks still guard real code; what changed is the
// default, and a harness that silently flipped it would be a harness that
// could not tell "switched off" from "broken". So the default is a check of
// its own, and everything after it runs with the lane deliberately lit.
const shippedLensLane = CONFIG.cinecam.lens.path.lensLane;
CONFIG.cinecam.lens.path.lensLane = true;

const DEG = 180 / Math.PI;
const wrapDeg = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const headingOf = () => Math.atan2(cineLens.pathDirY, cineLens.pathDirX) * DEG;
const DT = 1 / 60;

// ---------------------------------------------------------------------------
section('THE SHIPPED DEFAULT — the lens corridor is off');
// ---------------------------------------------------------------------------
check('the corridor is off in the shipped config', shippedLensLane === false,
  String(shippedLensLane));
// `lensLane` AND NOT `enabled`, which is the only reason the change took
// effect at all: imported-tuning.json holds `path.enabled: true`, and a saved
// value outranks a config default — so re-defaulting the old key would have
// changed nothing, on Ethan's machine only, in a way that looks exactly like
// the code not working.
//
// The rename does one better than making the old key inert: config.js no
// longer DECLARES `enabled`, and the tuning loader drops saved values that
// config has stopped declaring (it says so at boot). So the stale `true` is
// not merely outvoted, it is gone.
check('...and the old key it was renamed from is gone, not merely outvoted',
  !('enabled' in CONFIG.cinecam.lens.path) && 'lensLane' in CONFIG.cinecam.lens.path,
  Object.keys(CONFIG.cinecam.lens.path).join(', '));

// ---------------------------------------------------------------------------
section('FORECAST — the cone ends where the dash would, stick and all');
// ---------------------------------------------------------------------------
{
  const dc = CONFIG.strike.dashControl;
  const c = CONFIG.strike.charge;
  const stats = { strikeDashSpeed: 40, strikeDashDuration: 0.25, maxSpeed: 30, thrust: 19, friction: CONFIG.player.friction };
  const unit = (deg) => ({ x: Math.cos(deg / DEG), y: Math.sin(deg / DEG) });
  const wasBreak = dc.breakOut;

  // A dash with no stick is a straight line with the water's drag on it.
  const still = predictDash({ x: 0, y: 0 }, unit(0), 1, stats, 1);
  const flat = 40 * 0.25 * c.reachMulMax;
  check('no stick: straight along the aim', Math.abs(still.dir.x - 1) < 1e-9 && Math.abs(still.dir.y) < 1e-9);
  check('...shorter than speed x duration, because the water drags on it',
    still.reach < flat && still.reach > flat * 0.6, `${still.reach.toFixed(2)} of ${flat.toFixed(2)}`);
  // ...and exactly what the integration says, so this is a measurement of the
  // dash's own drag, not a guess at a fraction.
  {
    let v = 40 * c.reachMulMax / c.reachMulMax, x = 0;
    const dur = 0.25 * c.reachMulMax;
    for (let left = dur; left > 1e-6; left -= 1 / 60) { const dt = Math.min(1 / 60, left); v *= Math.pow(stats.friction, dt * 60); x += v * dt; }
    check('...to the frame', Math.abs(still.reach - x) < 1e-9, `${still.reach.toFixed(4)} vs ${x.toFixed(4)}`);
  }

  // THE HANDS. Swim east, aim north: the stick wins, so the launch is east
  // and the seal keeps steering toward that same rule for the whole flight —
  // so it lands east. It used to launch and land on an angular blend of the
  // two, a heading neither hand had asked for.
  const launch = strikeDirection(unit(0), unit(90));
  const held = predictDash(unit(0), unit(90), 1, stats, 1);
  const landDeg = Math.atan2(held.dir.y, held.dir.x) * DEG;
  check('swim east + aim north launches east — the stick wins', Math.abs(Math.atan2(launch.y, launch.x) * DEG) < 1e-6);
  check('...and LANDS east — the aim never gets a vote while the stick is pushed', Math.abs(landDeg) < 0.5,
    `lands at ${landDeg.toFixed(2)} deg`);
  // No stick: the aim is the whole heading, and the forecast holds it.
  const aimed = predictDash({ x: 0, y: 0 }, unit(90), 1, stats, 1);
  check('no stick + aim north lands north', Math.abs(Math.atan2(aimed.dir.y, aimed.dir.x) * DEG - 90) < 0.5);
  // The turn rate still matters mid-flight: with the launch already ON the
  // stick a straight dash has nothing to turn toward; take the forecast as
  // launched and confirm it holds its line rather than drifting.
  check('a dash on the stick flies straight', Math.abs(Math.hypot(held.x, held.y) - held.reach) < 1e-9);
  // The chord and the endpoint agree.
  check('the chord is the endpoint', Math.abs(Math.hypot(held.x, held.y) - held.reach) < 1e-9
    && Math.abs(held.x / held.reach - held.dir.x) < 1e-9);

  // Aim decides more the less the stick asks for: the same aim with a lighter
  // stick throttles the dash, and the turn rate is the same, so the landing
  // is not further round but it is nearer.
  const light = predictDash({ x: 0.3, y: 0 }, unit(90), 1, stats, 1);
  check('a light stick lands nearer (the throttle)', light.reach < held.reach, `${light.reach.toFixed(2)} < ${held.reach.toFixed(2)}`);

  // Power reaches further, combo reaches further.
  check('more charge lands further', predictDash(unit(0), unit(90), 1, stats, 1).reach > predictDash(unit(0), unit(90), 0, stats, 1).reach);
  check('a live chain lands further', predictDash(unit(0), unit(90), 1, stats, 1.5).reach > held.reach);

  // Break-out: stick straight against the aim launches sideways (90 off both),
  // which is inside the break angle, so it flies; it is the turn that closes
  // the angle. Nothing to fire returns zero.
  const none = predictDash({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, stats, 1);
  check('both hands idle: no dash, zero reach', none.reach === 0 && none.dir.x === 0 && none.dir.y === 0);
  dc.breakOut = wasBreak;

  // THE TAKEOVER. Authority starts at steerFrom and eases in to 1 along the
  // curve; the turn a frame may take scales with it, so at the launch the
  // stick cannot bend the line and by the end it has the whole rate.
  {
    const wasFrom = dc.steerFrom, wasEase = dc.steerEase;
    dc.steerFrom = 0; dc.steerEase = 'inQuad';
    check('authority is steerFrom at the launch', steerAuthority(dc, 0) === 0);
    check('...all of it at the end', steerAuthority(dc, 1) === 1);
    check('...and the curve in between', Math.abs(steerAuthority(dc, 0.5) - ease('inQuad', 0.5)) < 1e-12);
    dc.steerFrom = 0.3;
    check('steerFrom floors it', Math.abs(steerAuthority(dc, 0) - 0.3) < 1e-12 && Math.abs(steerAuthority(dc, 0.5) - (0.3 + 0.7 * 0.25)) < 1e-12);
    dc.steerEase = 'notACurve';
    check('an unknown curve is linear, not a throw', Math.abs(steerAuthority(dc, 0.5) - (0.3 + 0.7 * 0.5)) < 1e-12);
    dc.steerFrom = 0; dc.steerEase = 'inQuad';
    // dashSteer, heading east, hands asking for north (stick north, no aim):
    const step = { heading: 0, speed: 0, breakOut: false };
    const full = CONFIG.strike.dashTurnRate * dc.steerMul * (1 / 60);
    dashSteer(0, 40, 0, 1, 0, 0, 1, 1 / 60, stats, 0, 1, step);
    check('at the launch a frame turns the dash not at all', Math.abs(step.heading) < 1e-12, `${step.heading}`);
    dashSteer(0, 40, 0, 1, 0, 0, 1, 1 / 60, stats, 1, 1, step);
    check('at the end a frame turns it the whole capped step', Math.abs(step.heading - full) < 1e-12);
    dashSteer(0, 40, 0, 1, 0, 0, 1, 1 / 60, stats, 0.5, 1, step);
    check('...and halfway, the curve\'s share of it', Math.abs(step.heading - full * 0.25) < 1e-12);
    dashSteer(0, 40, 0, 1, 0, 0, 1, 1 / 60, stats, undefined, undefined, step);
    check('no progress given means full authority (a dash that is not a strike)', Math.abs(step.heading - full) < 1e-12);
    dc.steerFrom = wasFrom; dc.steerEase = wasEase;
  }

  // BOUGHT. One pip fires (minFire is a pip count now), and buys a straight
  // burst: no steering at or under steerOffPips, all of it from steerFullPips.
  {
    const wasOff = dc.steerOffPips, wasFull = dc.steerFullPips, wasFrom = dc.steerFrom, wasMin = CONFIG.strike.charge.minFirePips;
    CONFIG.strike.charge.minFirePips = 1;
    dc.steerOffPips = 1; dc.steerFullPips = 3; dc.steerFrom = 1;
    const n = pipCount(stats);
    const pip = 1 / n;
    check('one pip is enough to fire', Math.abs(minFire(stats) - pip) < 1e-12, `minFire ${minFire(stats).toFixed(3)} = 1/${n}`);
    check('...and it follows the card that changes the bar', Math.abs(minFire({ strikeChumRefill: 0.1 }) - 0.1) < 1e-12);
    check('a one-pip dash has no steering', steerAuthority(dc, 1, pip, stats) === 0);
    check('...none under it either', steerAuthority(dc, 1, pip * 0.5, stats) === 0);
    check('two pips: halfway there', Math.abs(steerAuthority(dc, 1, 2 * pip, stats) - 0.5) < 1e-12);
    check('three pips and up: all of it', steerAuthority(dc, 1, 3 * pip, stats) === 1 && steerAuthority(dc, 1, 1, stats) === 1);
    // Flown: swim east, aim north. One pip lands on the launch line (45, no
    // steering to bend it — and since the launch IS the stick it lands there
    // anyway); the difference shows with hands that disagree with the launch,
    // so hand the forecast a dash whose aim moved after the launch by testing
    // the step directly instead.
    const step = { heading: 0, speed: 0, breakOut: false };
    dashSteer(0, 40, 0, 1, 0, 0, 1, 1 / 60, stats, 1, pip, step);
    check('a one-pip dash frame turns not at all, hands or no hands', step.heading === 0);
    dashSteer(0, 40, 0, 1, 0, 0, 1, 1 / 60, stats, 1, 1, step);
    check('a full dash frame turns the whole step', step.heading > 0);
    // The one-pip burst still goes somewhere: reachMulMin of the dash.
    const burst = predictDash(unit(0), unit(0), pip, stats, 1);
    check('...and a one-pip burst still travels', burst.reach > 0 && burst.reach < predictDash(unit(0), unit(0), 1, stats, 1).reach,
      `${burst.reach.toFixed(2)} units`);
    dc.steerOffPips = wasOff; dc.steerFullPips = wasFull; dc.steerFrom = wasFrom; CONFIG.strike.charge.minFirePips = wasMin;
  }

  // WIRING. The seal runs the same step, and has no steering of its own left.
  const playerSrc = read('entities/player.js');
  check('player.js steers through dashSteer, with the stick, the HELD aim and the dash\'s progress', /dashSteer\(cur, v, input\.move\.x, input\.move\.y, heldAim\.x, heldAim\.y, combo, dt, s, progress, power, steerStep, follow\)/.test(playerSrc));
  check('...and the held aim comes from holdAim, never input.aim', /const heldAim = holdAim\(st, input\);/.test(playerSrc) && !/dashSteer\([^)]*input\.aim/.test(playerSrc));
  check('...progress read off the strike itself', /1 - st\.dashTimeLeft \/ st\.dashDuration/.test(playerSrc) /* `st` is the seal's strike state — player 1's or player 2's */);
  check('...and the power it was bought with', /const power = strike \? st\.power : 1;/.test(playerSrc) && /dt, s, progress, power, steerStep, follow\)/.test(playerSrc));
  check('no reader of the old bar-fraction gate is left', !/charge\.minFire\b/.test(read('main.js')) && !/charge\.minFire\b/.test(read('systems/strike.js')) && !/charge\.minFire\b/.test(read('systems/strikeRing.js')));
  check('the forecast flies the same takeover', /1 - left \/ duration, t, forecastStep\)/.test(read('systems/strike.js')));
  check('...and keeps no copy of the rule', !/dashTurnRate/.test(playerSrc) && !/breakOutAngle/.test(playerSrc) && !/throttleLerp/.test(playerSrc));
  const main = read('main.js');
  check('main.js imports predictDash', /import \{[^}]*\bpredictDash\b[^}]*\} from '\.\/systems\/strike\.js'/.test(main));
  check('...and hands the camera the forecast chord, direction and reach',
    /dashDir: predictDash\(input\.move, input\.aim, strikeState\.pending, player\.stats, player\.comboSpeedMul, dashPrediction\)\.dir/.test(main)
    && /dashReach: dashPrediction\.reach/.test(main));
  check('...and the schools flee the same forecast', /predictDash\(input\.move, input\.aim, strikeState\.pending, player\.stats, player\.comboSpeedMul, dashPrediction\)\.dir;/.test(main));
  const strike = read('systems/strike.js');
  const release = strike.slice(strike.indexOf('export function tryStrike'));
  check('the release multiplies the same reach curve the forecast flies',
    /lerp\(c\.reachMulMin, c\.reachMulMax, s\.power\)/.test(release) /* `s` is the strike state tryStrike was handed — player 1's or player 2's */);
}

// ---------------------------------------------------------------------------
section('MOTION — grows out, turns, never snaps');
// ---------------------------------------------------------------------------
{
  const VH = CONFIG.arena.viewHeight;
  const half = (z) => ({ w: (bounds.frameWidth / 2) / z, h: (VH / 2) / z });
  const limitsOf = (zoom) => {
    const h = half(zoom);
    return { loX: bounds.left + h.w, hiX: bounds.right - h.w, loY: bounds.bottom + h.h, hiY: bounds.top - h.h };
  };
  const ctx = {
    target: { x: 0, y: -12 },
    velocity: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
    dashDir: { x: 1, y: 0 },
    dashReach: 0,
    chargePower: 0,
    strikeHeld: false, charging: false, boosting: false,
    deathPhase: 'none', deathElapsed: 0,
    halfExtents: half,
    focusLimits: limitsOf,
    clampFocus: (x, y, zoom) => {
      const l = limitsOf(zoom);
      return {
        x: l.loX > l.hiX ? 0 : Math.min(Math.max(x, l.loX), l.hiX),
        y: l.loY > l.hiY ? (bounds.bottom + bounds.top) / 2 : Math.min(Math.max(y, l.loY), l.hiY),
      };
    },
  };
  const wasEnabled = CONFIG.cinecam.enabled;
  const wasPath = CONFIG.cinecam.lens.path.enabled;
  CONFIG.cinecam.enabled = true;
  CONFIG.cinecam.lens.path.enabled = true;
  resetCineCamera();
  for (let i = 0; i < 120; i++) updateCineCamera(DT, ctx);
  check('dark until the button is held', cineLens.pathAmount === 0 && cineLens.pathReach === 0);

  // Light it, aimed east, with a 20-unit reach.
  const setHeading = (deg) => { ctx.dashDir.x = Math.cos(deg / DEG); ctx.dashDir.y = Math.sin(deg / DEG); };
  setHeading(0);
  ctx.dashReach = 20;
  ctx.strikeHeld = true;
  updateCineCamera(DT, ctx);
  check('the first lit frame snaps the heading', Math.abs(wrapDeg(headingOf())) < 1e-6, `${headingOf().toFixed(3)} deg`);
  check('...and starts the reach near zero, to grow out of the seal',
    cineLens.pathReach < 20 * 0.2, `${cineLens.pathReach.toFixed(3)} of 20`);
  // Measured against the CONFIGURED lag (the live tuning wins over the
  // default), five time constants being 99% of the way.
  const growLag = CONFIG.cinecam.lens.path.growLag;
  const growFrames = Math.ceil(5 * growLag / DT);
  const growth = [cineLens.pathReach];
  for (let i = 0; i < growFrames; i++) { updateCineCamera(DT, ctx); growth.push(cineLens.pathReach); }
  check('the reach grows every frame', growth.every((r, i) => i === 0 || r > growth[i - 1]));
  check(`...and is at the dash reach after five grow lags (${(growFrames * DT).toFixed(2)}s)`,
    Math.abs(cineLens.pathReach - 20) < 20 * 0.02, `${cineLens.pathReach.toFixed(3)} with growLag ${growLag}`);

  // A 90 degree nudge: intermediate frames, all between the two headings.
  setHeading(90);
  const turnFrames = Math.ceil(6 * CONFIG.cinecam.lens.path.turnLag / DT);
  const swing = [];
  for (let i = 0; i < turnFrames; i++) { updateCineCamera(DT, ctx); swing.push(wrapDeg(headingOf())); }
  check('a 90 degree aim change does not snap', swing[0] > 1 && swing[0] < 89, `first frame ${swing[0].toFixed(2)} deg`);
  check('every frame is between the old heading and the new',
    swing.every((h, i) => h >= -1e-6 && h <= 90 + 1e-6 && (i === 0 || h >= swing[i - 1] - 1e-9)),
    `min ${Math.min(...swing).toFixed(2)} max ${Math.max(...swing).toFixed(2)}`);
  check('...and it arrives', Math.abs(swing.at(-1) - 90) < 0.5, `${swing.at(-1).toFixed(3)} deg`);
  const lag = CONFIG.cinecam.lens.path.turnLag;
  const framesToMost = swing.findIndex((h) => h > 90 * 0.63);
  check('the turn lag is the stated time constant',
    Math.abs(framesToMost * DT - lag) <= DT * 1.5, `${(framesToMost * DT).toFixed(3)}s vs turnLag ${lag}`);

  // The reversal that broke vector lerps: 170 -> -170 is a 20 degree swing.
  setHeading(170);
  for (let i = 0; i < turnFrames * 2; i++) updateCineCamera(DT, ctx);
  setHeading(-170);
  const rev = [];
  for (let i = 0; i < 60; i++) { updateCineCamera(DT, ctx); rev.push(wrapDeg(headingOf())); }
  check('170 -> -170 goes the short way round',
    rev.every((h) => Math.abs(h) >= 170 - 1e-6), `min |h| ${Math.min(...rev.map(Math.abs)).toFixed(2)}`);
  check('...and the direction never collapses', rev.every(() => Math.hypot(cineLens.pathDirX, cineLens.pathDirY) > 0.999));

  // Idle hands hold the heading rather than pointing the cone at +x.
  ctx.dashDir.x = 0; ctx.dashDir.y = 0;
  for (let i = 0; i < 30; i++) updateCineCamera(DT, ctx);
  check('a zero heading holds the last one', Math.abs(Math.abs(wrapDeg(headingOf())) - 170) < 0.5, `${headingOf().toFixed(2)}`);

  // Reach follows the meter, both ways.
  setHeading(0);
  ctx.dashReach = 35;
  for (let i = 0; i < growFrames; i++) updateCineCamera(DT, ctx);
  check('more charge -> the cone reaches further', Math.abs(cineLens.pathReach - 35) < 0.5, `${cineLens.pathReach.toFixed(2)}`);
  ctx.dashReach = 12;
  updateCineCamera(DT, ctx);
  const midway = cineLens.pathReach;
  for (let i = 0; i < growFrames; i++) updateCineCamera(DT, ctx);
  check('less charge -> it shrinks, smoothly', midway > 12 && midway < 35 && Math.abs(cineLens.pathReach - 12) < 0.5,
    `first frame ${midway.toFixed(2)}, settled ${cineLens.pathReach.toFixed(2)}`);

  // The fray's clock: base speed at an empty meter, base + ramp at a full one,
  // and continuous across a change in speed (no jump on the frame it moves).
  {
    const pc = CONFIG.cinecam.lens.path;
    const wasSpeed = pc.noiseSpeed, wasRamp = pc.noiseSpeedPerPower;
    pc.noiseSpeed = 2; pc.noiseSpeedPerPower = 10;
    ctx.chargePower = 0;
    updateCineCamera(DT, ctx);
    const p0 = cineLens.pathNoisePhase;
    updateCineCamera(DT, ctx);
    const empty = (cineLens.pathNoisePhase - p0) / DT;
    ctx.chargePower = 1;
    updateCineCamera(DT, ctx);
    const full = (cineLens.pathNoisePhase - p0) / DT - empty;
    check('the fray runs at the base speed with an empty meter', Math.abs(empty - 2) < 1e-9, `${empty.toFixed(3)}/s`);
    check('...and base + ramp with a full one', Math.abs(full - 12) < 1e-9, `${full.toFixed(3)}/s`);
    check('...advancing one frame\'s worth on the frame the speed changed, not a jump',
      Math.abs((cineLens.pathNoisePhase - p0) - (2 + 12) * DT) < 1e-9);
    pc.noiseSpeed = wasSpeed; pc.noiseSpeedPerPower = wasRamp;
    ctx.chargePower = 0;
  }

  // Release: the corridor blends out, then the next wind-up grows out fresh.
  ctx.strikeHeld = false;
  for (let i = 0; i < 240; i++) updateCineCamera(DT, ctx);
  check('released: dark again', cineLens.pathAmount < 0.001 && cineLens.pathReach === 0);
  ctx.strikeHeld = true;
  updateCineCamera(DT, ctx);
  check('the next wind-up grows out of the seal again', cineLens.pathReach < 12 * 0.2, `${cineLens.pathReach.toFixed(3)}`);

  CONFIG.cinecam.enabled = wasEnabled;
  CONFIG.cinecam.lens.path.enabled = wasPath;
  resetCineCamera();
}

// ---------------------------------------------------------------------------
section('WIRING — the cone, the fray, the uv conversion');
// ---------------------------------------------------------------------------
{
  const post = read('systems/post.js');
  const mask = post.slice(post.indexOf('float pathMask('), post.indexOf('vec2 curveUv('));
  check('the mask is a cone: width tapers from the seal to the far end',
    /mix\(uPathWidth, uPathWidthFar, t\)/.test(mask));
  check('...rounded at the far end, not cut square', /along > uPathLength/.test(mask) && /length\(vec2\(along - uPathLength, across\)\)/.test(mask));
  check('...and still a disc on the seal, so it cannot pinch shut there', /along < 0\.0/.test(mask) && /length\(vec2\(along, across\)\)/.test(mask));
  check('the edge is broken up by noise in the cone\'s own frame',
    /vnoise\(vec2\(along \* s/.test(mask) && /uPathNoise/.test(mask) && /float tm = uPathNoisePhase;/.test(mask));
  check('...and the shader takes a PHASE, not time x speed, so a ramping speed cannot stutter it',
    !/uPathNoiseSpeed/.test(post) && !/uTime \* uPathNoise/.test(mask));
  for (const u of ['uPathWidthFar', 'uPathNoise', 'uPathNoiseScale', 'uPathNoisePhase']) {
    check(`${u} is declared, initialised and written`,
      new RegExp(`uniform float ${u};`).test(post) && new RegExp(`${u}: \\{ value:`).test(post) && new RegExp(`u\\.${u}\\.value = cineLens\\.`).test(post));
  }
  const world = read('world.js');
  check('world.js converts the world-unit reach to uv with the focal point\'s divide',
    /cineLens\.pathLength = \(cineLens\.pathReach \* camera\.zoom\) \/ \(camera\.top - camera\.bottom\)/.test(world)
    && /\* zoom\) \/ \(camera\.top - camera\.bottom\)/.test(world));
  check('...and carries dashReach into the rig', /cineCtx\.dashReach = signals\?\.dashReach/.test(world));

  // SHAPE — the same dash draws the same cone whatever the frame is doing.
  //
  // The length is a world distance in uv, so it always moved with the zoom;
  // the cross-section and the ripple spacing are authored in uv and did not,
  // which made the cone a long taper on a punched-in frame and a blunt wedge
  // with a few lumps on it on a wide one. A run never showed it — the wind-up
  // punches to one zoom every time — and Blubberball's camera, which fits the
  // ball and every seal into the shot, swings from about half that width to a
  // third over it.
  check('world.js publishes how far off the authored frame this one is',
    /cineLens\.pathScale = camera\.zoom \/ cinePathRefZoom\(\)/.test(world));
  check('...measured against the one state that lights the corridor',
    /states\?\.charging\?\.zoom/.test(read('systems/cineCamera.js')));
  check('post.js scales the cross-section and the feather by it',
    /u\.uPathWidth\.value = cineLens\.pathWidth \* ps/.test(post)
    && /u\.uPathWidthFar\.value = cineLens\.pathWidthFar \* ps/.test(post)
    && /u\.uPathFeather\.value = cineLens\.pathFeather \* ps/.test(post));
  check('...divides the ripple density, so the fray belongs to the water',
    /u\.uPathNoiseScale\.value = cineLens\.pathNoiseScale \/ ps/.test(post));
  check('...and does NOT scale the break-up depth, which the shader already spends as a fraction of the half-width',
    /u\.uPathNoise\.value = cineLens\.pathNoise;/.test(post));
  {
    // The whole conversion, both ends, exactly as world.js and post.js run it.
    const p = CONFIG.cinecam.lens.path;
    const ref = CONFIG.cinecam.states.charging.zoom;
    const reach = 21.5;           // a full-power dash, measured above
    const frameH = CONFIG.arena.viewHeight;
    const cone = (zoom) => {
      const len = (reach * zoom) / frameH;
      const ps = zoom / ref;
      return { taper: (p.widthFar * ps) / len, ripples: len * (p.noiseScale / ps) };
    };
    // A run's wind-up, a match fitted wide, and a match punched all the way in.
    const [run, wide, tight] = [ref, 0.5, 2.0].map(cone);
    check('the cone has the same taper at any zoom',
      Math.abs(run.taper - wide.taper) < 1e-9 && Math.abs(run.taper - tight.taper) < 1e-9,
      `${run.taper.toFixed(3)} at the wind-up, ${wide.taper.toFixed(3)} fitted wide, ${tight.taper.toFixed(3)} punched in`);
    check('...and the same number of ripples along it',
      Math.abs(run.ripples - wide.ripples) < 1e-9 && Math.abs(run.ripples - tight.ripples) < 1e-9,
      `${run.ripples.toFixed(1)} ripples`);
    // ...and what it was: the unscaled cone, for the record.
    const raw = (zoom) => ({ taper: p.widthFar / ((reach * zoom) / frameH), ripples: ((reach * zoom) / frameH) * p.noiseScale });
    check('...where the unscaled cone was a different shape at each',
      Math.abs(raw(ref).taper - raw(0.5).taper) > 0.1,
      `${raw(ref).taper.toFixed(2)} vs ${raw(0.5).taper.toFixed(2)} wide, ${raw(0.5).ripples.toFixed(1)} ripples against ${raw(ref).ripples.toFixed(1)}`);
  }
  const config = read('config.js');
  check('no length slider survives in the tuner', !/cinecam\.lens\.path\.length/.test(config));
  check('the rig reads no length number', !/pathCfg\.length/.test(read('systems/cineCamera.js')));
  for (const k of ['widthFar', 'turnLag', 'growLag', 'noise', 'noiseScale', 'noiseSpeed', 'noiseSpeedPerPower']) {
    check(`cinecam.lens.path.${k} is tunable`, new RegExp(`path: 'cinecam\\.lens\\.path\\.${k}'`).test(config));
  }
  check('the takeover is tunable: floor and curve', /path: 'strike\.dashControl\.steerFrom'/.test(config) && /path: 'strike\.dashControl\.steerEase', type: 'choice', options: EASINGS/.test(config));
}

section('LANE — the magnet corridor follows the dash, not the launch');
{
  // The animation controller has no clips in Node and warns for every state.
  const realWarn = console.warn;
  console.warn = (m, ...r) => {
    if (typeof m === 'string' && m.startsWith('[animation]')) return;
    realWarn(m, ...r);
  };
  const scene = new THREE.Scene();
  const dt = 1 / 60;
  initPlayer(scene);
  resetPlayer();
  resetStrike();
  player.mesh.position.set(0, -8, 0);
  player.velocity.set(0, 0, 0);

  // A full-power release to the RIGHT, with both hands then asking for UP —
  // the ordinary "strike, then curve into the pile beside you".
  addCharge(1, player.stats);
  strikeState.pending = 1;
  strikeState.winding = true;
  // A perfect charge is what arms a chain (see tryStrike); the sweet spot is
  // a tenth of a second wide and not a thing a harness should be timing.
  strikeState.perfect = true;
  tryStrike({ x: 1, y: 0 }, player.stats);
  // The impulse, exactly as main.js applies it on a release.
  const launchSpeed = player.stats.strikeDashSpeed * (player.comboSpeedMul || 1);
  player.velocity.set(strikeState.dashDir.x * launchSpeed, strikeState.dashDir.y * launchSpeed, 0);
  player.dashTimer = strikeState.dashDuration;

  const launch = { x: strikeState.dashDir.x, y: strikeState.dashDir.y };
  const input = { move: new THREE.Vector2(0, 1), aim: new THREE.Vector2(0, 1) };

  // The capsule, spelled out against an arbitrary heading, so the case can ask
  // what the OLD frozen dashDir would have reported without reaching for a
  // second copy of the game.
  function corridorAlong(dir, px, py, ox, oy) {
    const c = CONFIG.pickups.magnet?.striking ?? {};
    const dx = ox - px;
    const dy = oy - py;
    const t = Math.max(-(c.corridorBack ?? 0), Math.min(c.corridorAhead ?? 0, dx * dir.x + dy * dir.y));
    return Math.hypot(dx - dir.x * t, dy - dir.y * t);
  }

  let worstDrift = 0;
  let behindNow = 0;
  let behindFrozen = 0;
  let turned = 0;
  for (let t = 0; t < strikeState.dashDuration; t += dt) {
    if (strikeState.dashTimeLeft > 0) strikeState.dashTimeLeft -= dt;
    else strikeState.active = false;
    updatePlayer(dt, input);
    if (!strikeState.active) break;
    const p = player.mesh.position;
    const heading = Math.atan2(player.velocity.y, player.velocity.x);
    const dd = Math.atan2(strikeState.dashDir.y, strikeState.dashDir.x);
    worstDrift = Math.max(worstDrift, Math.abs(wrapDeg((heading - dd) * DEG)));
    turned = Math.abs(wrapDeg((heading - Math.atan2(launch.y, launch.x)) * DEG));
    // An orb eight units BACK down the line the seal has actually flown —
    // the case the corridor exists for, since the capsule reaches ten units
    // behind and three ahead.
    const ox = p.x - Math.cos(heading) * 8;
    const oy = p.y - Math.sin(heading) * 8;
    behindNow = magnetDistance(p.x, p.y, ox, oy, player.velocity.length());
    behindFrozen = corridorAlong(launch, p.x, p.y, ox, oy);
  }
  console.warn = realWarn;

  // The dash has to have STEERED, or every check below passes for the wrong
  // reason: a dash that never left its launch heading has no staleness in it.
  check('the dash steers well off its launch heading', turned > 45,
    `${turned.toFixed(0)} degrees by the end`);
  check('dashDir tracks the heading the seal is actually on', worstDrift < 1,
    `worst ${worstDrift.toFixed(2)} degrees out`);

  const reach = magnetRadius(player.stats, player.velocity.length());
  check('an orb down the flown lane is dead centre of the corridor',
    behindNow < 0.5, `${behindNow.toFixed(2)} units off the spine, reach ${reach.toFixed(2)}`);
  check('...and the frozen launch heading had it out at the rim',
    behindFrozen > behindNow + 4,
    `${behindFrozen.toFixed(2)} units off a lane the seal left, against ${behindNow.toFixed(2)}`);
}

section('HANDS — both of them steer, and they are handed back rather than cut off');
{
  const realWarn = console.warn;
  console.warn = (m, ...r) => {
    if (typeof m === 'string' && m.startsWith('[animation]')) return;
    realWarn(m, ...r);
  };
  const scene = new THREE.Scene();
  const dt = 1 / 60;
  initPlayer(scene);

  // PINNED IN PLACE, every frame, and every case below relies on it.
  //
  // What is being measured here is the VELOCITY — where it points and how big
  // it is — and the arena is the enemy of that: a seal flying flat out covers
  // forty units in a second, so it reaches the side wall and bounces (which
  // reads as a 16 u/s "speed drop" and a 180-degree "turn"), or it swims up
  // through the waterline and everything after that is a ballistic arc rather
  // than a manoeuvre. Holding the position still leaves the velocity dynamics
  // exactly as they are and takes both of those out.
  const HOME = new THREE.Vector3(0, -12, 0);
  const pin = () => player.mesh.position.copy(HOME);

  // A full-power release to the RIGHT. `hands` is what the player is doing
  // with the two of them for the rest of the flight; `after` swaps in once the
  // dash itself has ended, which is how the follow-through gets measured on
  // its own rather than on whatever the dash had already turned.
  function strike(hands, after = null, seconds = 1.0) {
    resetPlayer();
    resetStrike();
    player.mesh.position.copy(HOME);
    player.velocity.set(0, 0, 0);
    addCharge(1, player.stats);
    strikeState.pending = 1;
    strikeState.winding = true;
    strikeState.perfect = true;
    tryStrike({ x: 1, y: 0 }, player.stats);
    const sp = player.stats.strikeDashSpeed * (player.comboSpeedMul || 1);
    player.velocity.set(strikeState.dashDir.x * sp, strikeState.dashDir.y * sp, 0);
    player.dashTimer = strikeState.dashDuration;

    let atEnd = null;
    let peakSpeed = 0;
    for (let t = 0; t < seconds; t += dt) {
      // BOTH clocks, not just the strike's. `player.dashTimer` is what the
      // steer branch in updatePlayer gates on and it outlives strikeState by a
      // frame or two — measuring from the strike's end alone would credit the
      // follow-through with the tail of the dash itself, which is exactly what
      // it did the first time this was written.
      const over = !strikeState.active && player.dashTimer <= 0 && t > 0.05;
      if (over && atEnd === null) atEnd = Math.atan2(player.velocity.y, player.velocity.x) * DEG;
      const h = (over && after) ? after : hands;
      // updateStrike owns the dash clock AND the follow-through window, so the
      // real tick order is the only one that measures the real thing.
      updateStrike(dt, scene, player.mesh.position, player.stats, [], {});
      updatePlayer(dt, h);
      pin();
      if (strikeState.active) peakSpeed = Math.max(peakSpeed, player.velocity.length());
    }
    return {
      heading: Math.atan2(player.velocity.y, player.velocity.x) * DEG,
      atEnd: atEnd ?? 0,
      peakSpeed,
    };
  }
  const still = new THREE.Vector2(0, 0);
  const up = new THREE.Vector2(0, 1);
  const right = new THREE.Vector2(1, 0);

  // THE MOUSE. `aimMoved` is what input.js raises on a frame the aim device
  // actually GESTURED — the mouse moved, the thumb slid, the right stick is
  // pushed. A gesture toward north mid-dash steers the dash north.
  const mouse = strike({ move: still, aim: up, aimMoved: true });
  check('a moving aim alone steers the dash', Math.abs(wrapDeg(mouse.heading)) > 45,
    `${mouse.heading.toFixed(0)} degrees off a launch at 0`);

  // ...AND AN IDLE ONE DOES NOT. `aimLive` is true for a mouse every frame
  // (the heading is re-derived from the cursor's position), and the dash used
  // to read it: a cursor nobody touched, sitting north of the launch, turned
  // the seal. Now the held aim is seeded on the launch line and only a
  // gesture replaces it, so the same cursor with no hand on it buys nothing.
  const idle = strike({ move: still, aim: up, aimLive: true, aimMoved: false });
  check('an idle aim does not steer the dash', Math.abs(wrapDeg(idle.heading)) < 2,
    `${idle.heading.toFixed(1)} degrees off the launch with the cursor 90 off and no gesture`);

  // THE OVERSHOOT — the bug this whole arrangement exists for. A mouse aims at
  // a POINT: put the cursor 8 units ahead on the launch line and re-derive the
  // aim every frame as cursor-minus-seal, exactly as input.js does. A
  // full-charge dash flies 22 units, so it passes the cursor a fifth of a
  // second in and the aim flips to face backwards. Steering by the live aim
  // turned the seal 92 degrees off its own launch (measured before the fix,
  // no stick held); the held aim ignores the flip because no hand moved.
  {
    const cursor = new THREE.Vector3(HOME.x + 8, HOME.y, 0);
    const liveAim = new THREE.Vector2(1, 0);
    // Drive the seal for real so the position moves: no pin. The arena is
    // wide enough for 8 units to the right of HOME.
    resetPlayer(); resetStrike();
    player.mesh.position.copy(HOME); player.velocity.set(0, 0, 0);
    addCharge(1, player.stats); strikeState.pending = 1; strikeState.winding = true; strikeState.perfect = true;
    tryStrike({ x: 1, y: 0 }, player.stats);
    const sp = player.stats.strikeDashSpeed * (player.comboSpeedMul || 1);
    player.velocity.set(sp, 0, 0); player.dashTimer = strikeState.dashDuration;
    let flipped = false, worst = 0;
    for (let t = 0; t < 1.0; t += dt) {
      liveAim.set(cursor.x - player.mesh.position.x, cursor.y - player.mesh.position.y);
      if (liveAim.lengthSq() > 1e-6) liveAim.normalize();
      if (liveAim.x < 0) flipped = true;
      // aimLive true (a mouse), aimMoved false (nobody touched it).
      updateStrike(dt, scene, player.mesh.position, player.stats, [], {});
      updatePlayer(dt, { move: still, aim: liveAim, aimLive: true, aimMoved: false });
      worst = Math.max(worst, Math.abs(wrapDeg(Math.atan2(player.velocity.y, player.velocity.x) * DEG)));
    }
    check('the dash flies past the cursor (the live aim really flips)', flipped);
    check('...and an untouched mouse past the cursor does not turn the seal', worst < 2,
      `${worst.toFixed(1)} degrees off the launch at worst`);

    // THE FLICK. Same dash, same overshot cursor, and at the moment the aim
    // has flipped the player flicks the mouse UP. What steers is the flick's
    // direction (input.aimGesture), not the cursor's heading — so the seal
    // goes up, and never toward the cursor behind it.
    const upFlick = new THREE.Vector2(0, 1);
    resetPlayer(); resetStrike();
    player.mesh.position.copy(HOME); player.velocity.set(0, 0, 0);
    addCharge(1, player.stats); strikeState.pending = 1; strikeState.winding = true; strikeState.perfect = true;
    tryStrike({ x: 1, y: 0 }, player.stats);
    player.velocity.set(sp, 0, 0); player.dashTimer = strikeState.dashDuration;
    let minX = 1, flickedAt = null;
    for (let t = 0; t < 1.0; t += dt) {
      liveAim.set(cursor.x - player.mesh.position.x, cursor.y - player.mesh.position.y);
      if (liveAim.lengthSq() > 1e-6) liveAim.normalize();
      const past = liveAim.x < 0;
      if (past && flickedAt === null) flickedAt = t;
      // One frame of flick, once the cursor is behind the seal.
      const flicking = past && t - flickedAt < dt * 0.5;
      updateStrike(dt, scene, player.mesh.position, player.stats, [], {});
      updatePlayer(dt, { move: still, aim: liveAim, aimLive: true, aimMoved: flicking, aimGesture: flicking ? upFlick : new THREE.Vector2(0, 0) });
      if (player.velocity.length() > 0.5) minX = Math.min(minX, player.velocity.x / player.velocity.length());
    }
    const endDeg = Math.atan2(player.velocity.y, player.velocity.x) * DEG;
    check('a flick up past the cursor turns the seal up', endDeg > 45 && endDeg < 135, `${endDeg.toFixed(0)} degrees`);
    check('...and never back toward the cursor behind it', minX > -0.1, `heading x component bottomed at ${minX.toFixed(2)}`);
  }

  // A dash that is not steered at all still has to go where it was pointed.
  const straight = strike({ move: right, aim: right, aimMoved: true });
  check('both hands on the launch line leaves it straight',
    Math.abs(wrapDeg(straight.heading)) < 2, `${straight.heading.toFixed(1)} degrees`);

  // THE EXIT. Flown along the launch, then both hands swung ninety degrees on
  // the frame the dash ends — so every degree below is bought by the window.
  const exitHands = [{ move: right, aim: right, aimMoved: true }, { move: up, aim: up, aimMoved: true }];
  const exit = strike(exitHands[0], exitHands[1]);
  const bought = Math.abs(wrapDeg(exit.heading - exit.atEnd));
  // AGAINST THE SAME STRIKE WITH THE WINDOW SHUT, because ordinary swimming is
  // not nothing: thrust alone bends a 34 u/s exit by about twenty degrees over
  // the half second it takes to bleed off, so a bare "did it turn" threshold
  // passes with the feature switched off. What is being measured is the
  // DIFFERENCE the window makes.
  const wasFollow = CONFIG.strike.dashControl.followThrough;
  CONFIG.strike.dashControl.followThrough = 0;
  const shut = strike(exitHands[0], exitHands[1]);
  CONFIG.strike.dashControl.followThrough = wasFollow;
  const withoutIt = Math.abs(wrapDeg(shut.heading - shut.atEnd));
  check('the follow-through still turns the seal after the dash has ended',
    bought > withoutIt * 2.5,
    `${bought.toFixed(0)} degrees bought, against ${withoutIt.toFixed(0)} on thrust alone`);
  check('...and then lets go', steerFollow() === 0,
    `follow ${steerFollow().toFixed(2)} once the window has run out`);
  check('the window is tunable', /path: 'strike\.dashControl\.followThrough'/.test(read('config.js')));

  // A RELEASED STICK IS NOT AN INSTRUCTION. With the stick east and the
  // cursor north the dash goes east (the stick wins); let go of the stick and
  // the held aim — still on the launch line, since the mouse never moved —
  // keeps it east. It used to hand the dash to the cursor on the release,
  // which read as a lurch toward the pointer as a reward for taking a hand off.
  const swimOnlyHeld = strike({ move: right, aim: up, aimLive: true });
  const swimOnlyLet = strike({ move: right, aim: up, aimLive: true },
    { move: still, aim: up, aimLive: true });
  check('the movement stick keeps the dash on the stick',
    Math.abs(wrapDeg(swimOnlyHeld.heading)) < 2,
    `${swimOnlyHeld.heading.toFixed(1)} degrees with the cursor 90 off`);
  check('...and letting the stick go does not hand the dash to the cursor',
    Math.abs(wrapDeg(swimOnlyLet.heading)) < 2,
    `${swimOnlyLet.heading.toFixed(1)} degrees after the stick was released`);
  // ...while a gesture toward the cursor after the release DOES: a hand did
  // something, and the seal goes where it pointed.
  const swimThenAim = strike({ move: right, aim: up, aimLive: true },
    { move: still, aim: up, aimLive: true, aimMoved: true });
  check('...but a gesture toward the cursor after the release turns it',
    Math.abs(wrapDeg(swimThenAim.heading)) > 20,
    `${swimThenAim.heading.toFixed(1)} degrees after the mouse moved`);
  // ...while a standstill strike must still fire: with no movement at all
  // the cursor is the only direction there is.
  {
    const d = strikeDirection({ x: 0, y: 0 }, { x: 0, y: 1 });
    check('a standstill strike still has a heading',
      Math.abs(d.y - 1) < 1e-6 && Math.abs(d.x) < 1e-6);
  }

  // THE CEILING, LET DOWN RATHER THAN DROPPED. The dash ends carrying about
  // 42 u/s into an ordinary ceiling of 34, and the clamp took the difference
  // in one frame — a stumble at the end of every strike that no amount of
  // steering fixes. Measured on the transition frame itself, which is the one
  // a probe that starts counting "after the dash" never sees.
  function worstDropOverTheEnd() {
    resetPlayer();
    resetStrike();
    player.mesh.position.copy(HOME);
    player.velocity.set(0, 0, 0);
    addCharge(1, player.stats);
    strikeState.pending = 1;
    strikeState.winding = true;
    strikeState.perfect = true;
    tryStrike({ x: 1, y: 0 }, player.stats);
    const sp = player.stats.strikeDashSpeed * (player.comboSpeedMul || 1);
    player.velocity.set(strikeState.dashDir.x * sp, strikeState.dashDir.y * sp, 0);
    player.dashTimer = strikeState.dashDuration;
    let prev = player.velocity.length();
    let worst = 0;
    for (let t = 0; t < 1.2; t += dt) {
      updateStrike(dt, scene, player.mesh.position, player.stats, [], {});
      updatePlayer(dt, { move: right, aim: right, aimMoved: true });
      pin();
      const now = player.velocity.length();
      worst = Math.max(worst, prev - now);
      prev = now;
    }
    return worst;
  }
  const smoothed = worstDropOverTheEnd();
  const wasCeil = CONFIG.strike.dashControl.followCeiling;
  CONFIG.strike.dashControl.followCeiling = false;
  const snapped = worstDropOverTheEnd();
  CONFIG.strike.dashControl.followCeiling = wasCeil;
  check('the speed ceiling is let down rather than dropped',
    smoothed < snapped * 0.4,
    `worst one-frame loss ${smoothed.toFixed(2)} u/s, against ${snapped.toFixed(2)} with the snap`);

  // AND THE PUSH. Measured as speed carried a fixed time into the recovery,
  // against the same strike with the multiplier at 1 — the boost is on
  // acceleration, so what it buys is how much of the exit has been rebuilt.
  function speedInto(seconds) {
    resetPlayer();
    resetStrike();
    player.mesh.position.copy(HOME);
    player.velocity.set(0, 0, 0);
    addCharge(1, player.stats);
    strikeState.pending = 1;
    strikeState.winding = true;
    strikeState.perfect = true;
    tryStrike({ x: 1, y: 0 }, player.stats);
    const sp = player.stats.strikeDashSpeed * (player.comboSpeedMul || 1);
    player.velocity.set(strikeState.dashDir.x * sp, strikeState.dashDir.y * sp, 0);
    player.dashTimer = strikeState.dashDuration;
    let over = -1;
    for (let t = 0; t < 2; t += dt) {
      const ended = !strikeState.active && player.dashTimer <= 0 && t > 0.05;
      if (ended && over < 0) over = t;
      updateStrike(dt, scene, player.mesh.position, player.stats, [], {});
      updatePlayer(dt, { move: up, aim: up, aimMoved: true });
      pin();
      if (over >= 0 && t - over >= seconds) break;
    }
    return player.velocity.length();
  }
  // SAMPLED INSIDE THE WINDOW. The boost eases to 1 across `followThrough`, so
  // by half a second out both runs have been on ordinary thrust for a while
  // and have converged on the same terminal speed — a sample taken there says
  // "no difference" about a feature that is working perfectly.
  //
  // ...AND WITH THE EASED CEILING OUT OF THE WAY, which is the other half of
  // the same window. Early in the recovery the seal is riding a ceiling still
  // walking down from dash speed, so BOTH runs are pinned to it and the sample
  // reads "no difference" no matter what the thrust is doing. The two features
  // are independent; measuring one means holding the other still.
  const wasThrust = CONFIG.strike.dashControl.followThrust;
  const wasCeilForThrust = CONFIG.strike.dashControl.followCeiling;
  CONFIG.strike.dashControl.followCeiling = false;
  const within = Math.max(0.05, (CONFIG.strike.dashControl.followThrough ?? 0) * 0.6);
  const pushed = speedInto(within);
  CONFIG.strike.dashControl.followThrust = 1;
  const unpushed = speedInto(within);
  CONFIG.strike.dashControl.followThrust = wasThrust;
  CONFIG.strike.dashControl.followCeiling = wasCeilForThrust;
  check('the thrust out of a strike rebuilds speed faster',
    pushed > unpushed * 1.05,
    `${pushed.toFixed(1)} u/s ${within.toFixed(2)}s out, against ${unpushed.toFixed(1)} at x1`);
  check('both are tunable',
    /path: 'strike\.dashControl\.followThrust'/.test(read('config.js'))
    && /path: 'strike\.dashControl\.followCeiling'/.test(read('config.js')));
  console.warn = realWarn;
}

console.log(failures === 0 ? '\nAll corridor checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
