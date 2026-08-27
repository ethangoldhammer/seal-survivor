#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:damagefx
//
// What happens when the SEAL gets hurt. Three systems, one event:
//
//   THE GATE   systems/playerDamageFx.js — turns damage numbers into hits worth
//              showing, and sizes them by the fraction of the health bar lost.
//   THE RIM    systems/outlines.js — the player's outline flashes red.
//   THE FRAME  systems/feedback.js — the shake, the spray, the ripple, the grunt.
//
// This exists because of a bug none of the three could see on its own. Contact
// damage reaches the game as `contactDamage * dt` — a per-frame SLICE of a rate
// — and main.js gated the hit feedback on `dmg > 1`, a threshold above every
// contact rate in the game at any framerate it runs at. Every creature in the
// roster could eat you in total silence. The regression test for that is the
// CONTACT section below, and it is driven at three different framerates,
// because a framerate-dependent gate is exactly the shape of the original bug.
//
// Everything expected is computed from CONFIG rather than hardcoded: saved
// tuning wins over the config defaults (imported-tuning.json is merged at
// import), so a hardcoded 0.07 here would be a test of the tuning file.
//
// What it cannot tell you: whether a hit FEELS like a hit. That is a controller
// in your hands.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  attachPlayerOutline,
  applyPlayerOutline,
  updatePlayerOutline,
  resetPlayerOutlineCharge,
} from '../path/src/systems/outlines.js';
import {
  playerDamageFx,
  updatePlayerDamageFx,
  resetPlayerDamageFx,
} from '../path/src/systems/playerDamageFx.js';
import { initFeedback, feedbackState, updateFeedback } from '../path/src/systems/feedback.js';
import { initParticles, resetParticles, particleCount } from '../path/src/entities/particles.js';
import { watchSfx } from '../path/src/systems/audio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, '../path/src/main.js');
const COMBAT = path.join(HERE, '../path/src/systems/combat.js');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const PD = CONFIG.fx.playerDamage;
const HIT = CONFIG.playerOutline.hit;
const MAX_HP = CONFIG.player.maxHp;
const AT = { x: 0, y: 0 };

// There is no WebAudio in Node, so the sound is counted rather than heard.
// watchSfx is the same tap the Sound tab's debug overlay uses, and it sits
// inside playSfx — so it reports every call that reached the mixer, with the
// outcome. Headless every outcome is 'off' (no AudioContext), which is fine:
// the question here is whether the event fired at all, and the throttled ones
// ('gap') report separately and are excluded.
const sounds = [];
watchSfx((name, outcome) => { if (name === 'playerHit' && outcome !== 'gap') sounds.push(name); });

initParticles(new THREE.Scene());
initFeedback(null);

// A stand-in for the seal's body, same as the charge-FX harness uses.
const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
attachPlayerOutline(body);
const shellMat = body.children.find((o) => o.userData.__isOutline)?.material;

// The rim's own colour, as the shader sees it: colour x glow, so `r` alone is
// not a hue reading. Redness is the RATIO of red to the other two channels,
// which is scale-free and therefore survives the glow blowout riding on top.
const redness = () => shellMat.color.r / Math.max(1e-6, (shellMat.color.g + shellMat.color.b) / 2);
const glowOf = () => Math.max(shellMat.color.r, shellMat.color.g, shellMat.color.b);
const thickOf = () => shellMat.userData.__outlineThickness.value;

function reset() {
  resetPlayerDamageFx();
  resetPlayerOutlineCharge();
  applyPlayerOutline();
  feedbackState.shake = 0;
  feedbackState.glowPulse = 0;
  feedbackState.hitstop = 0;
  resetParticles();
  sounds.length = 0;
}

reset();
const BASE_RED = redness();
const BASE_GLOW = glowOf();
const BASE_THICK = thickOf();

// One frame of the game as far as this feature is concerned: the throttle runs
// down, the rim decays, shake decays. Nothing here is on gameplay time.
function frame(dt = 1 / 60) {
  updatePlayerDamageFx(dt);
  updatePlayerOutline(dt, 0);
  updateFeedback(dt);
}

// Deal `dps` damage per second for `seconds`, the way combat.js does it — a
// slice per frame — and report what the player would have seen.
function chew(dps, seconds, dt = 1 / 60, maxHp = MAX_HP) {
  reset();
  let shown = 0;
  let peakShake = 0;
  for (let t = 0; t < seconds; t += dt) {
    if (playerDamageFx(dps * dt, maxHp, AT) > 0) shown++;
    frame(dt);
    peakShake = Math.max(peakShake, feedbackState.shake);
  }
  return { shown, sounds: sounds.length, particles: particleCount(), peakShake };
}

// ===========================================================================
// THE GATE — a lump of damage
// ===========================================================================

section('LUMPS — one hit, one of everything');
{
  reset();
  const spent = playerDamageFx(20, MAX_HP, AT);
  check('a bullet fires on the frame it lands, with nothing banked first',
    spent === 20, `returned ${spent}`);
  check('...and it makes a sound', sounds.length === 1, `${sounds.length} sounds`);
  check('...and throws the playerHit burst', particleCount() > 0, `${particleCount()} particles`);
  check('...and shakes the camera', feedbackState.shake > 0, feedbackState.shake.toFixed(4));
  // The flash is STATE, not a write: it reaches the material on the rim's next
  // tick, which in the game is the same frame. A zero-length tick is the
  // honest way to ask "what would the shell look like now".
  updatePlayerOutline(0, 0);
  check('...and turns the rim red', redness() > BASE_RED * 1.5,
    `${BASE_RED.toFixed(2)} -> ${redness().toFixed(2)}`);
}

section('LUMPS — size is read as a FRACTION of the bar, not as raw damage');
{
  const shakeFor = (dmg, maxHp) => {
    reset();
    playerDamageFx(dmg, maxHp, AT);
    return feedbackState.shake;
  };
  const graze = shakeFor(MAX_HP * 0.02, MAX_HP);
  const bite = shakeFor(MAX_HP * 0.12, MAX_HP);
  const maul = shakeFor(MAX_HP * 0.4, MAX_HP);
  check('a bigger share of the bar shakes harder', maul > bite && bite > graze,
    [graze, bite, maul].map((v) => v.toFixed(4)).join(' -> '));

  // The whole reason the scale is a fraction: the same 20 damage matters less
  // once Blubber has tripled the bar, and the feedback has to agree.
  const early = shakeFor(20, MAX_HP);
  const late = shakeFor(20, MAX_HP * 3);
  check('the same damage against a bigger bar is a smaller hit', late < early * 0.9,
    `${early.toFixed(4)} at ${MAX_HP}hp vs ${late.toFixed(4)} at ${MAX_HP * 3}hp`);

  // ...and the range only exists below the ceiling. This is the check that
  // fails if `feedback.playerHit.shake` is ever nudged back up: at maxShake
  // every hit in the game clamps to the same number and the scaling above is
  // real but invisible.
  const pinned = shakeFor(MAX_HP, MAX_HP);
  check('even the biggest single hit stays under the global shake ceiling',
    pinned < CONFIG.fx.maxShake - 1e-6,
    `${pinned.toFixed(4)} vs maxShake ${CONFIG.fx.maxShake}`);
  check('...and it is meaningfully bigger than a graze', pinned > graze * 2,
    `${graze.toFixed(4)} -> ${pinned.toFixed(4)}`);
  check('the shake is subtle in absolute terms', pinned < 0.35, pinned.toFixed(4));
}

// ===========================================================================
// THE GATE — contact damage. The bug this whole file exists for.
// ===========================================================================

section('CONTACT — a body chewing on you is not silent');
// Read off the LIVE roster rather than by re-parsing enemies.csv: config.js
// already applies the table at import, so this is the number combat.js will
// actually multiply by dt — CSV, saved tuning and all.
const CONTACT_RATES = Object.entries(CONFIG.enemies)
  .map(([type, def]) => ({ type, dps: Number(def.contactDamage) }))
  .filter((r) => r.dps > 0);

check('the roster has contact-damage creatures to test with', CONTACT_RATES.length > 0,
  `${CONTACT_RATES.length} of them`);
{
  // The original bug, stated as the roster states it. The smallest nibbler in
  // the game has to be audible inside a second of contact.
  const weakest = Math.min(...CONTACT_RATES.map((r) => r.dps));
  const strongest = Math.max(...CONTACT_RATES.map((r) => r.dps));
  const nibble = chew(weakest, 1);
  const maul = chew(strongest, 1);
  check(`the weakest contact damage in the roster (${weakest}/s) is heard inside a second`,
    nibble.sounds > 0, `${nibble.sounds} sounds, ${nibble.particles} particles`);
  check(`the strongest (${strongest}/s) is heard more often than the weakest`,
    maul.sounds > nibble.sounds, `${nibble.sounds} vs ${maul.sounds} per second`);
  check('...and hits harder when it does', maul.peakShake > nibble.peakShake,
    `${nibble.peakShake.toFixed(4)} vs ${maul.peakShake.toFixed(4)}`);

  // Every single creature, so a rate added to the CSV below the audible floor
  // is caught by this file and not by a player wondering why nothing happened.
  const silent = CONTACT_RATES.filter((r) => chew(r.dps, 1).sounds === 0);
  check('EVERY contact-damage creature in the roster is audible within a second',
    silent.length === 0, silent.map((r) => `${r.type} @${r.dps}/s`).join(', ') || 'all of them');
}

{
  // The shape of the original failure: a threshold on one call is a question
  // about framerate. Same rate, same wall-clock second, three framerates —
  // what the player hears must not depend on which machine they are on.
  const rate = 24; // the shark's
  const at30 = chew(rate, 1, 1 / 30);
  const at60 = chew(rate, 1, 1 / 60);
  const at144 = chew(rate, 1, 1 / 144);
  const counts = [at30.sounds, at60.sounds, at144.sounds];
  check('the same contact rate sounds the same at 30, 60 and 144fps',
    Math.max(...counts) - Math.min(...counts) <= 1, counts.join(' / '));
  check('...and none of those framerates is silent', Math.min(...counts) > 0);

  // The old gate, spelled out so the regression can't come back quietly.
  check('a per-frame contact slice is far below the `dmg > 1` gate that used to be here',
    rate / 60 < 1, `${(rate / 60).toFixed(2)} damage on a 60fps frame`);
}

section('CONTACT — but it does not machine-gun');
{
  const worst = Math.max(...CONTACT_RATES.map((r) => r.dps));
  const heavy = chew(worst, 1);
  const ceiling = Math.ceil(1 / PD.minGap) + 1;
  check('the hungriest creature in the game is capped by minGap, not fired per frame',
    heavy.sounds <= ceiling, `${heavy.sounds} sounds/sec, ceiling ${ceiling}`);

  // Six fish on one frame is one hit, not six. The first one through opens it
  // (the throttle never delays an impact) and the other five are banked, so
  // the frame makes exactly one sound and none of the damage is lost — the
  // rest arrives as one heavier hit at the next window.
  reset();
  let fired = 0;
  for (let i = 0; i < 6; i++) if (playerDamageFx(MAX_HP * 0.05, MAX_HP, AT) > 0) fired++;
  const openingShake = feedbackState.shake;
  check('six things landing on the same frame make one hit, not six', fired === 1, `${fired}`);
  check('...and one sound, not six', sounds.length === 1, `${sounds.length}`);
  for (let t = 0; t < PD.minGap + 1 / 60; t += 1 / 60) frame();
  const banked = playerDamageFx(0.0001, MAX_HP, AT);
  check('...and the five it banked are not lost', banked > MAX_HP * 0.24,
    `${banked.toFixed(1)} damage of the ${(MAX_HP * 0.25).toFixed(1)} banked`);
  check('...landing as a heavier hit than the one that opened the burst',
    feedbackState.shake > openingShake,
    `${openingShake.toFixed(4)} -> ${feedbackState.shake.toFixed(4)}`);
}

{
  // Banked, not dropped. Sub-threshold contact that stops before it fires must
  // still be there when the next hit lands, or a fish grazing you forever costs
  // health that nothing on screen ever accounts for.
  reset();
  const crumb = PD.minFraction * MAX_HP * 0.4;
  check('a crumb on its own shows nothing', playerDamageFx(crumb, MAX_HP, AT) === 0);
  check('nor does a second one', playerDamageFx(crumb, MAX_HP, AT) === 0);
  const spent = playerDamageFx(crumb, MAX_HP, AT);
  check('but three of them clear the floor together, worth all three',
    spent > crumb * 2.9, `${spent.toFixed(3)} vs ${(crumb * 3).toFixed(3)}`);
}

{
  // The throttle must never DELAY the first hit after a quiet moment.
  reset();
  playerDamageFx(MAX_HP * 0.2, MAX_HP, AT);
  const blocked = playerDamageFx(MAX_HP * 0.2, MAX_HP, AT);
  check('a second hit inside the gap is banked, not shown', blocked === 0);
  for (let t = 0; t < PD.minGap + 1 / 60; t += 1 / 60) frame();
  const after = playerDamageFx(0.0001, MAX_HP, AT);
  check('and lands the moment the gap expires, carrying what it banked',
    after > MAX_HP * 0.19, `${after.toFixed(2)} damage`);
}

// ===========================================================================
// THE RIM
// ===========================================================================

section('RIM — the flash');
{
  reset();
  playerDamageFx(MAX_HP * PD.flashFraction, MAX_HP, AT);
  updatePlayerOutline(0, 0);
  const peakRed = redness();
  check('a full-strength hit turns the rim red', peakRed > BASE_RED * 2,
    `${BASE_RED.toFixed(2)} -> ${peakRed.toFixed(2)}`);
  check('...and blows the glow out past the tuned rim', glowOf() > BASE_GLOW * 1.05,
    `${BASE_GLOW.toFixed(2)} -> ${glowOf().toFixed(2)}`);
  check('...and widens it', thickOf() > BASE_THICK, `${BASE_THICK} -> ${thickOf()}`);

  // ...and gets all the way back, not to "close enough": a rim left a few
  // percent warm never recovers, and every hit after it starts from pink.
  let t = 0;
  while (t < HIT.time + 0.2 && redness() > BASE_RED + 1e-9) {
    updatePlayerOutline(1 / 120, 0);
    t += 1 / 120;
  }
  check('the flash is over inside its configured time', t <= HIT.time + 1 / 60, `${t.toFixed(3)}s`);
  check('and lands exactly back on the tuned colour', Math.abs(redness() - BASE_RED) < 1e-9);
  check('...and the tuned glow', Math.abs(glowOf() - BASE_GLOW) < 1e-9);
  check('...and the tuned thickness', Math.abs(thickOf() - BASE_THICK) < 1e-12);
}

{
  // A graze has to be RED — the size shows in the blowout and the duration, not
  // in how far towards red the hue got. A rim 20% of the way to red just reads
  // as an off-colour outline.
  const flashOf = (fraction) => {
    reset();
    playerDamageFx(MAX_HP * fraction, MAX_HP, AT);
    updatePlayerOutline(0, 0);
    const red = redness();
    const glow = glowOf();
    let t = 0;
    while (t < HIT.time + 0.2 && redness() > BASE_RED + 1e-9) {
      updatePlayerOutline(1 / 240, 0);
      t += 1 / 240;
    }
    return { red, glow, life: t };
  };
  const graze = flashOf(PD.minFraction * 1.2);
  const full = flashOf(PD.flashFraction);
  check('even the smallest hit goes fully red', Math.abs(graze.red - full.red) < 0.02,
    `${graze.red.toFixed(2)} vs ${full.red.toFixed(2)}`);
  check('a bigger hit blows out brighter', full.glow > graze.glow * 1.05,
    `${graze.glow.toFixed(2)} -> ${full.glow.toFixed(2)}`);
  // HOW MUCH LONGER IS THE CONFIG'S TO SAY, not this file's. The flash is a lerp
  // between `minTime` and `time`, so the widest spread that can ever exist is
  // their ratio — 0.24/0.18, about 1.33x, as shipped. The old assertion asked
  // for 1.5x, which those two numbers make arithmetically unreachable: it was
  // calibrated against an earlier pair and turned into a demand that the flash
  // outrun its own configuration.
  //
  // Derived from the config instead, which is strictly the stronger test. It
  // still fails if a big hit stops lasting longer than a graze, AND it now also
  // fails if the effect stops spanning the range it was given — a collapse the
  // fixed 1.5x could not have seen, because any tuning that narrowed minTime
  // and time together would sail through it.
  const spreadCeiling = HIT.time / HIT.minTime;
  const spread = graze.life > 0 ? full.life / graze.life : Infinity;
  check('...and burns longer', full.life > graze.life * 1.1,
    `${graze.life.toFixed(3)}s -> ${full.life.toFixed(3)}s`);
  check('...spanning the range minTime..time allows', spread >= spreadCeiling * 0.9,
    `${spread.toFixed(2)}x of a possible ${spreadCeiling.toFixed(2)}x`);
  check('a graze still lasts at least minTime', graze.life >= HIT.minTime - 1 / 120,
    `${graze.life.toFixed(3)}s vs ${HIT.minTime}s`);
}

{
  // A scratch taken during a maiming must not cut the maiming's flash short.
  reset();
  playerDamageFx(MAX_HP * PD.flashFraction, MAX_HP, AT);
  for (let i = 0; i < 6; i++) frame();
  const midGlow = glowOf();
  resetPlayerDamageFx(); // clear the throttle so the scratch is allowed through
  playerDamageFx(MAX_HP * PD.minFraction * 1.2, MAX_HP, AT);
  updatePlayerOutline(0, 0);
  check('a scratch mid-flash re-lights the rim rather than downgrading it',
    glowOf() >= midGlow, `${midGlow.toFixed(2)} -> ${glowOf().toFixed(2)}`);
}

section('RIM — the switches, and not fighting the tuner');
{
  reset();
  shellMat.color.setRGB(0.123, 0.456, 0.789);
  for (let i = 0; i < 30; i++) updatePlayerOutline(1 / 60, 0);
  check('an idle frame still writes nothing to the shell',
    Math.abs(shellMat.color.r - 0.123) < 1e-6, `${shellMat.color.r}`);
  applyPlayerOutline();
}

{
  const wasHit = HIT.enabled;
  const wasCharge = CONFIG.strike.charge.outline.enabled;
  try {
    HIT.enabled = false;
    reset();
    playerDamageFx(MAX_HP * 0.5, MAX_HP, AT);
    for (let i = 0; i < 5; i++) frame();
    check('hit.enabled = false leaves the rim alone',
      Math.abs(redness() - BASE_RED) < 1e-9, `${redness().toFixed(3)}`);
    HIT.enabled = wasHit;

    // The two rim effects are separate features. Switching off the strike
    // wind-up must not take the damage flash with it — they shared one `off`
    // flag before this feature existed.
    CONFIG.strike.charge.outline.enabled = false;
    reset();
    playerDamageFx(MAX_HP * 0.5, MAX_HP, AT);
    updatePlayerOutline(0, 0);
    check('turning the charge throb off does NOT turn the damage flash off',
      redness() > BASE_RED * 2, `${redness().toFixed(2)}`);
  } finally {
    HIT.enabled = wasHit;
    CONFIG.strike.charge.outline.enabled = wasCharge;
    reset();
  }
}

{
  const wasOutline = CONFIG.playerOutline.enabled;
  try {
    CONFIG.playerOutline.enabled = false;
    applyPlayerOutline();
    reset();
    playerDamageFx(MAX_HP * 0.5, MAX_HP, AT);
    for (let i = 0; i < 5; i++) frame();
    check('a rim switched off entirely stays switched off',
      body.children.find((o) => o.userData.__isOutline).visible === false);
  } finally {
    CONFIG.playerOutline.enabled = wasOutline;
    applyPlayerOutline();
    reset();
  }
}

// ===========================================================================
// THE SOUND BANK
// ===========================================================================

section('SFX — the files behind the event');
{
  const def = CONFIG.sfx.playerHit;
  const srcs = def.srcs ?? (def.src ? [def.src] : []);
  check('the playerHit event names a sound that exists in the table', !!def);
  check('...backed by real recordings, not just the synth fallback', srcs.length > 0,
    `${srcs.length} takes`);
  // A named file that isn't on disk does NOT fail loudly: audio.js falls back
  // to the synthesised boom, so the sound still plays and just isn't the one
  // anybody chose. A typo here is only ever found by ear, or by this check.
  const missing = srcs.filter((s) => !fs.existsSync(path.join(HERE, '../public', s)));
  check('every take is actually on disk', missing.length === 0, missing.join(', ') || 'all present');
}

// ===========================================================================
// WIRING — the game actually goes through this door
// ===========================================================================

section('WIRING — main.js and combat.js');
const main = fs.readFileSync(MAIN, 'utf8');
const combat = fs.readFileSync(COMBAT, 'utf8');

check('main.js imports the damage FX system',
  /import \{[^}]*\bplayerDamageFx\b[^}]*\} from '\.\/systems\/playerDamageFx\.js'/.test(main));
check('the combat hook routes player damage through it, sized against the CURRENT bar',
  /playerDamageFx\(dmg, player\.stats\.maxHp, player\.mesh\.position\)/.test(main));
check('...and the flinch rides the hit that was shown, not the frame-slice that tripped it',
  /const shown = playerDamageFx\(/.test(main) && /if \(shown > 0\) \{/.test(main));
check('lightning goes through the same door',
  (main.match(/playerDamageFx\(/g) ?? []).length >= 2);
check('the throttle is ticked every frame on the RAW clock',
  /updatePlayerDamageFx\(rawDt\)/.test(main));
check('a fresh run clears the accumulator', /resetPlayerDamageFx\(\)/.test(main));
check('nothing fires the playerHit event behind the system\'s back',
  !/feedback\('playerHit'/.test(main));
check('the old framerate-dependent gate is gone', !/if \(dmg > 1\)/.test(main));
// The claim, not the expression. Contact damage is a RATE and has to arrive as
// `something * dt` — that is what makes playerDamageFx's banking the right
// shape for it, and a burst arriving here instead would be a hit the flinch and
// the grunt never see. It used to be pinned to the literal `contactDamage) * dt`
// and broke the day a `contactMul` was multiplied in between the two halves (a
// crab charges nothing for being touched — see systems/combat.js), which is a
// test failing on the shape of an expression rather than on what it does.
check('combat.js still hands over contact damage as a per-frame rate',
  /contactDamage\)[^;\n]*\* dt/.test(combat));

console.log(failures === 0 ? '\nAll damage-FX checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
