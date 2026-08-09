import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { weatherState } from './weather.js';

// The clock, and the one place that turns a time of day into numbers the rest
// of the game can use. Nothing else works out what time it is: the sky
// gradient, the sun and moon, the caustics and the light beams all read the
// two objects exported here, so they cannot disagree about whether it's dawn.
//
//   dayState — where the bodies are. Positions in world units, elevations as
//              -1..1, and how close each is to touching the water line.
//   skyLight — the LIGHT BUS. How bright the world is, what colour that light
//              is, and where it's coming from. This is the interface: a new
//              consumer reads it and needs to know nothing about orbits or
//              keyframes, and a new light source (a lightning flash, say) can
//              push into it without every consumer learning about lightning.
//
// The orbit is one ellipse with the sun and moon on opposite points of it, so
// exactly one of them is above the horizon at any moment — the alternation is
// geometry rather than a rule anything has to enforce.

const TAU = Math.PI * 2;

export const dayState = {
  hours: 7.5, // 0..24
  days: 0, // whole days elapsed since the clock started
  phase: 'morning', // night | dawn | morning | day | dusk — for anything that wants a name
  rising: true, // is the sun on the way up? elevation alone can't tell you
  sun: { x: 0, y: 0, elevation: 0, size: 1, above: true, horizonMix: 0 },
  moon: { x: 0, y: 0, elevation: 0, size: 1, above: false, horizonMix: 0 },
};

export const skyLight = {
  // 0..1 master brightness, storm dimming already folded in. This is what
  // scales the caustics and the beams.
  intensity: 1,
  // Same number WITHOUT the weather dimming — the celestial bodies use this,
  // because a storm puts cloud between you and the sun, it doesn't turn the
  // sun down.
  clear: 1,
  color: new THREE.Color(0xffffff), // colour of whatever is doing the lighting
  zenith: new THREE.Color(), // sky gradient, top of frame
  horizon: new THREE.Color(), // sky gradient, at the water line
  x: 0, // world position of the dominant body — what the beams lean away from
  y: 0,
  elevation: 0, // -1..1, of the dominant body
  night: 0, // 0 by day, 1 in full dark. Drives the stars.
  isMoon: false,
};

// Scratch, so a per-frame update allocates nothing.
const cA = new THREE.Color();
const cB = new THREE.Color();

let clock = CONFIG.dayNight?.startHour ?? 7.5;
let started = false;

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Reset to `startHour`. Called once at boot, and per run only if
// `restartAtMorning` is on — the default is that the clock keeps running
// across runs, so the FIRST run of a session opens in the morning and later
// ones inherit whatever time the last death happened at.
export function resetDayCycle(force = false) {
  if (!started || force || CONFIG.dayNight?.restartAtMorning) {
    clock = CONFIG.dayNight?.startHour ?? 7.5;
    dayState.days = 0;
  }
  started = true;
  // Publish immediately so the first frame of a run is already lit correctly
  // rather than spending a frame at whatever the last one ended on.
  updateDayCycle(0);
}

/**
 * Push the clock forward by hand, in the same unit the clock already runs on:
 * REAL seconds of normal passage. `advanceClock(1)` is worth exactly one
 * second of standing still, which at the default scale is one in-game minute.
 *
 * Expressed that way on purpose. The alternative — "add N in-game minutes" —
 * would silently stop meaning anything the moment `scale` is tuned, and the
 * whole point of a bonus this small is that it stays proportional to how fast
 * the day already runs.
 *
 * Ignored while the clock is frozen for tuning: a scrubbed sunset that creeps
 * forward every time something eats is not a frozen clock.
 */
export function advanceClock(seconds) {
  const cfg = CONFIG.dayNight;
  if (!cfg?.enabled || cfg.paused || !(seconds > 0)) return;
  clock += (seconds * cfg.scale) / 3600;
  while (clock >= 24) { clock -= 24; dayState.days += 1; }
  dayState.hours = clock;
}

// The two keyframes bracketing `hour`, and how far between them we are. The
// list wraps: past the last entry it interpolates back round to the first,
// crossing midnight, which is why the table only needs the hours where the
// sky changes character.
function skyKeys(hour) {
  const keys = CONFIG.dayNight.sky;
  if (!keys?.length) return null;
  if (keys.length === 1) return { a: keys[0], b: keys[0], t: 0 };

  let i = 0;
  while (i < keys.length - 1 && hour >= keys[i + 1].hour) i++;

  const a = keys[i];
  // Past the last keyframe we're heading back to the first one, a whole day
  // later — hence the +24 rather than a plain subtraction, which would give a
  // negative span and snap the sky inside out at 22:00.
  const wrapped = i === keys.length - 1;
  const b = wrapped ? keys[0] : keys[i + 1];
  const span = (wrapped ? b.hour + 24 : b.hour) - a.hour;
  const t = span > 0.0001 ? clamp01((hour - a.hour) / span) : 0;
  return { a, b, t };
}

// Where a body sits on the shared ellipse. `phase` is 0 at sunrise, so the
// sun gets 0 and the moon gets half a turn — polar opposites, by construction.
function place(body, angle, size, horizonRange) {
  const airH = Math.max(1, bounds.top - bounds.surfaceY);
  const orbit = CONFIG.dayNight.orbit;
  const rx = (bounds.width / 2) * orbit.radiusX;
  const ry = airH * orbit.radiusY;
  const horizonY = bounds.surfaceY + orbit.centerY;

  // -cos so the body rises on the LEFT and sets on the right, matching the
  // way the sky keyframes are written (dawn colours before noon colours).
  body.x = -Math.cos(angle) * rx;
  body.y = horizonY + Math.sin(angle) * ry;
  body.elevation = Math.sin(angle);
  body.size = size;
  body.above = body.y > horizonY;

  // How much of the disc is straddling the water line. Peaks at 1 when the
  // centre is exactly on it and falls off over `horizonRange` disc radii —
  // this is what the extra sunset flare rides.
  const reach = Math.max(0.001, (size * 0.5) * (horizonRange ?? 1.5));
  body.horizonMix = clamp01(1 - Math.abs(body.y - horizonY) / reach);
  return body;
}

// Elevation alone can't tell dawn from dusk — the sun is at the same height
// twice a day — so the half of the arc it's on decides, and the same split
// separates 'morning' from the afternoon.
function phaseName(sunElevation, rising) {
  if (Math.abs(sunElevation) <= 0.08) return rising ? 'dawn' : 'dusk';
  if (sunElevation < 0) return 'night';
  if (sunElevation > 0.45) return 'day';
  return rising ? 'morning' : 'evening';
}

/**
 * Advance the clock and republish both objects. Fed REAL seconds — the day
 * carries on through a hit-stop and through the death dive's slow motion,
 * because those dilate the GAME's clock and this is the world's.
 */
export function updateDayCycle(dt) {
  const cfg = CONFIG.dayNight;

  if (!cfg?.enabled) {
    // Hand back a flat, neutral bus so every consumer keeps working with the
    // system switched off — the caustics fall back to their own intensity,
    // the sky falls back to CONFIG.colors.sky, and nothing has to branch.
    skyLight.intensity = 1;
    skyLight.clear = 1;
    skyLight.night = 0;
    skyLight.color.set(0xffffff);
    skyLight.zenith.set(CONFIG.colors.sky);
    skyLight.horizon.set(CONFIG.colors.sky);
    dayState.sun.above = true;
    dayState.moon.above = false;
    return;
  }

  if (cfg.paused) {
    clock = cfg.scrubHour ?? clock;
  } else {
    clock += (dt * cfg.scale) / 3600; // scaled seconds -> hours
    while (clock >= 24) { clock -= 24; dayState.days += 1; }
    while (clock < 0) { clock += 24; dayState.days -= 1; }
  }
  dayState.hours = clock;

  // --- the bodies -----------------------------------------------------------
  const angle = ((clock - cfg.orbit.riseHour) / 24) * TAU;
  place(dayState.sun, angle, cfg.sun.size, cfg.sun.horizonRange);
  place(dayState.moon, angle + Math.PI, cfg.moon.size, cfg.moon.horizonRange);
  // cos is positive on the rising half of the ellipse and negative on the
  // falling half — the sun's x velocity, in effect.
  dayState.rising = Math.cos(angle) > 0;
  dayState.phase = phaseName(dayState.sun.elevation, dayState.rising);

  // --- the sky palette ------------------------------------------------------
  const k = skyKeys(clock);
  if (k) {
    skyLight.zenith.set(k.a.zenith).lerp(cB.set(k.b.zenith), k.t);
    skyLight.horizon.set(k.a.horizon).lerp(cB.set(k.b.horizon), k.t);
    skyLight.clear = clamp01(lerp(k.a.light ?? 1, k.b.light ?? 1, k.t));
  }

  // --- the light bus --------------------------------------------------------
  // Which body is lighting the scene, and how completely. Crossfaded over a
  // narrow band around the horizon rather than switched, so the moment of
  // handover at sunrise isn't a visible step in the caustics.
  const sunWeight = clamp01((dayState.sun.elevation + 0.12) / 0.24);
  skyLight.isMoon = sunWeight < 0.5;
  const lead = skyLight.isMoon ? dayState.moon : dayState.sun;
  skyLight.x = lead.x;
  skyLight.y = lead.y;
  skyLight.elevation = lead.elevation;
  skyLight.color.copy(cA.set(cfg.moon.color)).lerp(cB.set(cfg.sun.color), sunWeight);

  // Full dark only once the sun is properly down, so the stars arrive after
  // the last of the sunset rather than on top of it.
  skyLight.night = clamp01(-dayState.sun.elevation / 0.35);

  // Weather is the last word on brightness: a storm puts cloud between the
  // sky and the sea, which is a different thing from the sun being low, so it
  // multiplies in here rather than being baked into the keyframes.
  const storm = CONFIG.weather?.enabled ? (weatherState.intensity ?? 0) : 0;
  skyLight.intensity = skyLight.clear * (1 - storm * (CONFIG.weather?.dim ?? 0));
}

// Where the horizon actually is, in world units. One definition, shared by the
// clipping plane and the orbit, so a sun clipped at the water line and a sun
// POSITIONED against the water line can't end up half a unit apart.
export function horizonY() {
  return bounds.surfaceY + (CONFIG.dayNight?.orbit?.centerY ?? 0);
}
