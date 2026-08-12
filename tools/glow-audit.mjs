#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run glow
//
// Is any glow setting blowing out? Answers it for every biolumSkin preset at
// once, which the tuner's per-preset readout cannot: "is this one bright" is a
// different question from "which of these eleven is the problem".
//
// TWO THRESHOLDS, AND THEY ARE NOT THE SAME THING — this is the whole point of
// the tool, because the tuner readout only reports the first:
//
//   BLOOM (CONFIG.bloom.threshold, on Rec.709 luminance)
//     Clearing it is the GOAL. Below it a glow is just a coloured patch; above
//     it the bright pass picks the pixel up and spreads a halo. Wanting to be
//     over this is why the overdrive sliders exist.
//
//   CLIP (1.0, per channel, at the final composite)
//     Clearing it is the FAILURE. systems/post.js renders the scene to a
//     HalfFloat target, so values over 1 survive the bright pass on purpose —
//     but the composite ends `gl_FragColor = vec4(color, 1.0)` with no
//     tonemapping and no clamp, into an 8-bit framebuffer. Every channel over
//     1 is truncated there, INDEPENDENTLY.
//
// Independent per-channel truncation is what makes this visual rather than
// numeric: a warm (3.0, 2.2, 1.0) does not become "a brighter warm", it
// becomes (1,1,1) — flat white with the hue gone. A cold (0.2, 0.9, 3.0)
// clips to (0.2, 0.9, 1.0) and stays blue. So warm presets lose their colour
// long before cold ones do at the same luminance, and the number to watch is
// the per-channel peak, not the average.
//
// What this measures is the CEILING: a fully-lit pixel at the top of the
// breath, where the noise mask reaches 1. Most of a lit patch sits below it.
// That is the right number anyway — clipping is decided by the brightest
// pixels, not the mean.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';

const bloom = CONFIG.bloom ?? {};
// The soft shoulder from systems/post.js, reimplemented exactly so this tool
// reports what the screen will actually show rather than the raw value.
// Normalised on the PEAK channel and applied as one uniform scale, so hue and
// saturation come through untouched.
const KNEE = Math.min(0.99, Math.max(0, bloom.knee ?? 0));
function shoulder([r, g, b]) {
  if (KNEE <= 0) return [r, g, b];
  const peak = Math.max(r, g, b);
  if (peak <= KNEE) return [r, g, b];
  const range = Math.max(1e-4, 1 - KNEE);
  const rolled = KNEE + range * (1 - Math.exp(-(peak - KNEE) / range));
  const k = rolled / peak;
  return [r * k, g * k, b * k];
}
const THR = bloom.threshold ?? 0.55;
const CLIP = 1.0;
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

const base = CONFIG.biolumSkin?.base ?? {};
const presets = CONFIG.biolumSkin?.presets ?? {};
const resolve = (name) => ({ ...base, ...(presets[name] ?? {}) });

// Which asset wears each preset, so a row names something you can find.
const wearers = new Map();
for (const [key, def] of Object.entries(ASSETS)) {
  if (!def.biolumSkin) continue;
  if (!wearers.has(def.biolumSkin)) wearers.set(def.biolumSkin, []);
  wearers.get(def.biolumSkin).push(key);
}

console.log(`\nbloom: ${bloom.enabled === false ? 'OFF' : 'on'} · threshold ${THR.toFixed(2)} `
  + `· intensity ${(bloom.intensity ?? 0).toFixed(2)}`);
console.log(KNEE > 0
  ? `soft shoulder: ON at knee ${KNEE.toFixed(2)} — identity below it, asymptotic to 1 above`
  : 'soft shoulder: OFF (bloom.knee = 0) — hard clip at 1.00 per channel\n');

const rows = [];
for (const name of Object.keys(presets)) {
  const cfg = resolve(name);
  // What the body pattern adds at its brightest: strength x glow, at the top
  // of the breath. Matches the shader's `bioRamp(...) * (mask * strength * breathe)`
  // with mask = 1 and breathe at its peak.
  const gain = (cfg.strength ?? 1.6) * (cfg.glow ?? 1) * (1 + (cfg.pulseAmp ?? 0));
  const luminous = (cfg.luminous ?? base.luminous ?? true) !== false;

  for (const [stop, hex] of [['A', cfg.colorA], ['B', cfg.colorB], ['C', cfg.colorC]]) {
    if (hex == null) continue;
    const [r, g, b] = rgb(hex).map((c) => c * gain);
    rows.push({ preset: name, part: `body ${stop}`, r, g, b, luminous });
  }

  // The eyes are a separate lamp — outside the pattern and NOT scaled by
  // `strength`, so a preset with no body glow can still have hot eyes.
  //
  // Only counted where something can actually light up. `eyeStrength` lives on
  // every preset, but the shader multiplies it by the baked `aEyeGlow`
  // attribute, which is 0 everywhere unless the ASSET declares `eyeStalks` —
  // today just the two crabs. Four other presets currently carry
  // eyeStrength 3 and light nothing at all; reporting those as blown out would
  // send you tuning a number that has no pixels behind it.
  const eyeS = cfg.eyeStrength ?? 0;
  const hasStalks = (wearers.get(name) ?? []).some((k) => ASSETS[k]?.eyeStalks);
  if (eyeS > 0 && hasStalks) {
    const [r, g, b] = rgb(cfg.eyeColor ?? 0xffd166).map((c) => c * eyeS * (1 + (cfg.eyePulse ?? 0)));
    rows.push({ preset: name, part: 'eyes', r, g, b, luminous });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('preset', 14)}${pad('part', 9)}${pad('raw peak', 10)}${pad('on screen', 22)}verdict`);
console.log('-'.repeat(92));

let blown = 0;
let dark = 0;
let saved = 0;
for (const row of rows.sort((a, b) => lum(b.r, b.g, b.b) - lum(a.r, a.g, a.b))) {
  const raw = [row.r, row.g, row.b];
  const shown = shoulder(raw);
  const L = lum(...shown);
  const rawClip = raw.filter((c) => c > CLIP).length;
  const clipped = shown.filter((c) => c > CLIP + 1e-6).length;
  let verdict;
  if (clipped === 3) { verdict = 'BLOWN OUT — all 3 channels clip, renders flat white'; blown++; }
  else if (clipped > 0) { verdict = `${clipped}/3 channels clip — hue shifts toward white`; blown++; }
  else if (rawClip > 0) { verdict = `held — would have clipped ${rawClip}/3 raw`; saved++; }
  else if (L >= THR) verdict = 'blooms, no clipping — this is the target';
  else { verdict = `below bloom threshold (${THR.toFixed(2)}) — no halo`; dark++; }
  console.log(`${pad(row.preset, 14)}${pad(row.part, 9)}`
    + `${pad(Math.max(...raw).toFixed(2), 10)}`
    + `${pad(shown.map((c) => c.toFixed(2)).join(' '), 22)}${verdict}`);
}

console.log(`\n${rows.length} ramp stops · ${blown} clipping · ${saved} held by the shoulder · ${dark} below the bloom threshold`);
if (blown) {
  console.log('\nTo pull one back, in order of how little else it disturbs:');
  console.log('  1. lower that preset\'s `glow` (a plain multiplier on strength)');
  console.log('  2. darken the offending colour stop — a warm stop clips first, see the header');
  console.log('  3. lower `strength`, which moves every stop of that preset together');
  console.log('\nRaising CONFIG.bloom.threshold does NOT help: it gates which pixels get a');
  console.log('halo, not how bright they are, so a clipped pixel stays clipped and merely');
  console.log('stops blooming — the worst of both.');
}
for (const [name, keys] of wearers) {
  if (!presets[name]) console.log(`\n[warn] ${keys.join(', ')} wear "${name}", which is not a preset.`);
}
const idle = Object.keys(presets).filter((n) => (resolve(n).eyeStrength ?? 0) > 0
  && !(wearers.get(n) ?? []).some((k) => ASSETS[k]?.eyeStalks));
if (idle.length) {
  console.log(`\nnot counted: ${idle.join(', ')} carry an eyeStrength but no asset wearing them`);
  console.log('declares `eyeStalks`, so there is nothing for it to light. Harmless, but the');
  console.log('slider will look broken to whoever drags it next.');
}
console.log();
