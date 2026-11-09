// Export the particle emitters and goo surfaces to JSON for the UE5 port.
//
//   node --import ./tools/vite-loader.mjs tools/ue5-vfx-export.mjs [outdir]
//
// Writes build/ue5-vfx/ (default):
//   emitters.json     every CONFIG.emitters entry, RESOLVED (saved tuning already applied)
//   goo-groups.json   each goo group merged over the default surface, in composite order
//   sim.json          turbulence + water-line constants and the seal's bubble cadence
//
// Why resolved values and not a copy of config.js: the saved tuning beats the
// config defaults (breathBubbles is count 4 / glow 1.0 in config.js and
// 17 / 1.4 on screen), so anything typed from the source is the wrong look.
// The format is documented in design/ue5/GOO-AND-BUBBLES-UE-PORT.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(root, 'build', 'ue5-vfx'));
fs.mkdirSync(out, { recursive: true });

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
// JSON-safe deep copy: drops functions, keeps numbers/strings/bools/arrays/objects.
function clean(v) {
  if (typeof v === 'function' || v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((x) => clean(x) ?? null);
  if (isPlain(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const c = clean(x); if (c !== undefined) o[k] = c; }
    return o;
  }
  return v;
}
function merge(base, diff) {
  const o = { ...clean(base) };
  for (const [k, v] of Object.entries(diff ?? {})) {
    o[k] = isPlain(v) && isPlain(o[k]) ? merge(o[k], v) : clean(v);
  }
  return o;
}
const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);

// --- goo groups --------------------------------------------------------------
const goo = CONFIG.fx.goo;
const SURFACE_KEYS = ['radius', 'iso', 'soft', 'opacity', 'additive', 'rim', 'rimWidth',
  'spec', 'specPower', 'normal', 'lightX', 'lightY'];
const defaultSurface = Object.fromEntries(SURFACE_KEYS.map((k) => [k, goo[k]]));
const groupNames = Object.keys(goo.groups);
const groups = groupNames.map((name, i) => ({
  name,
  // The shader's aGoo attribute: 1..n by position, which is also composite order.
  index: i + 1,
  ...merge(defaultSurface, goo.groups[name]),
}));

// --- emitters ----------------------------------------------------------------
const emitters = Object.entries(CONFIG.emitters).map(([name, def]) => {
  const d = clean(def);
  const gooGroup = def.goo === true ? 'blood' : (typeof def.goo === 'string' ? def.goo : null);
  const e = {
    name,
    ...d,
    colorsHex: (def.colors ?? [0xffffff]).map(hex),
    // Defaults the emit() code applies when a field is absent.
    turbulence: def.turbulence ?? 1,
    inherit: def.inherit ?? 0,
    cone: def.cone ?? 0,
    glow: def.glow ?? 1,
    gooGroup,
    gooGroupIndex: gooGroup ? groupNames.indexOf(gooGroup) + 1 || null : 0,
    // killAtSurface defaults to "has a surfacePop"; only applies if born under water.
    killsAtSurface: !!(def.killAtSurface ?? !!def.surfacePop),
    popsInto: def.surfacePop ?? null,
  };
  return e;
});

const unknownGroups = emitters.filter((e) => e.gooGroup && e.gooGroupIndex === null).map((e) => `${e.name}:${e.gooGroup}`);
const unknownPops = emitters.filter((e) => e.popsInto && !CONFIG.emitters[e.popsInto]).map((e) => `${e.name}->${e.popsInto}`);

// --- sim constants -----------------------------------------------------------
let wave = null;
let surfaceY = null;
try {
  const arena = await import('../path/src/arena.js');
  wave = clean(arena.WAVE);
  surfaceY = arena.bounds?.surfaceY ?? null;
} catch (err) {
  console.warn('[ue5-vfx] could not load WAVE from arena.js:', err.message);
}
const tb = CONFIG.fx?.turbulence ?? {};
const sim = {
  // pos.xy += turbulenceAt(pos.xy * frequency, time * timeScale) * (strength * emitter.turbulence * age)
  turbulence: {
    enabled: tb.enabled !== false,
    strength: tb.strength ?? 0,
    frequency: tb.frequency ?? 0.35,
    timeScale: tb.timeScale ?? 0.6,
    dragVary: tb.dragVary ?? 0,
    // turbulenceAt(p, t) = ( sin(p.y+t) + 0.5 sin(p.y*2.13 - t*1.70 + 1.3),
    //                        sin(p.x*1.17 - t) + 0.5 sin(p.x*2.47 + t*1.10 + 4.1) )
    formula: 'see particles.js TURBULENCE_GLSL',
  },
  // y = surfaceY + sin(k1 x + w1 T) A + sin(k2 x + w2 T) A amp2 + sin(k3 x + w3 T) A amp3 chop
  water: { wave, surfaceY, waveAmplitude: CONFIG.arena?.waveAmplitude ?? null },
  bloomParticleOverdrive: CONFIG.bloom?.particleOverdrive ?? 1,
  sealBubbles: clean(CONFIG.bubbles),
  bubbleShell: clean(CONFIG.bubbleShell),
  goo: {
    enabled: goo.enabled, divisor: goo.divisor, defaultSurface: clean(defaultSurface),
    groupOrder: groupNames,
  },
  // The spawn maths in entities/particles.js emit(): speed/size/life are [min,max] draws;
  // cone is the full spread angle in radians (6.28 = omnidirectional); inherit is the
  // fraction of the parent's velocity added; aColor = palette colour * glow.
  position: 'p(t) = p0 + v (1 - exp(-drag t)) / drag + 0.5 g t^2 (xy), then + turbulence',
};

const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
write('emitters.json', emitters);
write('goo-groups.json', { defaultSurface: clean(defaultSurface), divisor: goo.divisor, groups });
write('sim.json', sim);

console.log(`[ue5-vfx] ${emitters.length} emitters (${emitters.filter((e) => e.gooGroup).length} goo, ` +
  `${emitters.filter((e) => e.popsInto).length} surface-pop), ${groups.length} goo groups -> ${out}`);
if (unknownGroups.length) console.warn('[ue5-vfx] emitters naming a goo group that does not exist:', unknownGroups.join(', '));
if (unknownPops.length) console.warn('[ue5-vfx] surfacePop naming a missing emitter:', unknownPops.join(', '));
