#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:corridor
//
// The dash corridor the lens paints during a wind-up — the cone in post.js,
// fed by the rig in cineCamera.js. Three claims worth failing over:
//
//   FORECAST the cone points at and ends where the dash would LAND.
//            predictDash() in strike.js flies the whole dash — the halfway
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
import { predictDash, strikeDirection, dashSteer, steerAuthority, minFire, pipCount } from '../path/src/systems/strike.js';
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
const DEG = 180 / Math.PI;
const wrapDeg = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const headingOf = () => Math.atan2(cineLens.pathDirY, cineLens.pathDirX) * DEG;
const DT = 1 / 60;

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

  // THE BALANCE. Swim east, aim north: the launch is the blend (45 deg at
  // aimBlend 0.5), and the seal keeps steering toward that SAME blend for the
  // whole flight — so it lands on it. It used to steer onto the raw stick and
  // land at 0.7 deg, with the aim's half erased in two frames.
  const wasBlend = CONFIG.strike.aimBlend;
  CONFIG.strike.aimBlend = 0.5;
  const launch = strikeDirection(unit(0), unit(90));
  const held = predictDash(unit(0), unit(90), 1, stats, 1);
  const landDeg = Math.atan2(held.dir.y, held.dir.x) * DEG;
  check('swim east + aim north launches at 45', Math.abs(Math.atan2(launch.y, launch.x) * DEG - 45) < 1e-6);
  check('...and LANDS at 45 — the split survives the flight', Math.abs(landDeg - 45) < 0.5,
    `lands at ${landDeg.toFixed(2)} deg`);
  // The slider is the lever, end to end.
  CONFIG.strike.aimBlend = 0.25;
  const quarter = predictDash(unit(0), unit(90), 1, stats, 1);
  CONFIG.strike.aimBlend = 0.8;
  const most = predictDash(unit(0), unit(90), 1, stats, 1);
  const deg = (p) => Math.atan2(p.dir.y, p.dir.x) * DEG;
  check('aimBlend 0.25 lands at 22.5', Math.abs(deg(quarter) - 22.5) < 0.5, `${deg(quarter).toFixed(2)}`);
  check('aimBlend 0.8 lands at 72', Math.abs(deg(most) - 72) < 0.5, `${deg(most).toFixed(2)}`);
  CONFIG.strike.aimBlend = wasBlend;
  // The turn rate still matters mid-flight: with the launch already ON the
  // blend a straight dash has nothing to turn toward, so measure a dash that
  // starts off it — a stick let go halfway is not the case; take the forecast
  // as launched and confirm it holds its line rather than drifting.
  check('a dash on the blend flies straight', Math.abs(Math.hypot(held.x, held.y) - held.reach) < 1e-9);
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
    // steering to bend it — and since the launch IS the blend it lands there
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
  check('player.js steers through dashSteer, with both hands and the dash\'s progress', /dashSteer\(cur, v, input\.move\.x, input\.move\.y, input\.aim\.x, input\.aim\.y, combo, dt, s, progress, power, steerStep\)/.test(playerSrc));
  check('...progress read off the strike itself', /1 - strikeState\.dashTimeLeft \/ strikeState\.dashDuration/.test(playerSrc));
  check('...and the power it was bought with', /const power = strike \? strikeState\.power : 1;/.test(playerSrc) && /dt, s, progress, power, steerStep\)/.test(playerSrc));
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
    /lerp\(c\.reachMulMin, c\.reachMulMax, strikeState\.power\)/.test(release));
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
  const config = read('config.js');
  check('no length slider survives in the tuner', !/cinecam\.lens\.path\.length/.test(config));
  check('the rig reads no length number', !/pathCfg\.length/.test(read('systems/cineCamera.js')));
  for (const k of ['widthFar', 'turnLag', 'growLag', 'noise', 'noiseScale', 'noiseSpeed', 'noiseSpeedPerPower']) {
    check(`cinecam.lens.path.${k} is tunable`, new RegExp(`path: 'cinecam\\.lens\\.path\\.${k}'`).test(config));
  }
  check('the takeover is tunable: floor and curve', /path: 'strike\.dashControl\.steerFrom'/.test(config) && /path: 'strike\.dashControl\.steerEase', type: 'choice', options: EASINGS/.test(config));
}

console.log(failures === 0 ? '\nAll corridor checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
