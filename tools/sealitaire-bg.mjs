#!/usr/bin/env node
// ============================================================================
// THE BACKGROUND AUDITION — the table rendered once per candidate palette, so
// four tank colours can be picked by looking at them side by side rather than
// by dragging twelve sliders and trying to remember the last one.
//
// A tank's background is the SUIT's: four `bg<Suit>R/G/B` rows in tuning.luau,
// one triple per suit, and a tanks.csv `bg` cell overrides a single card (all
// 52 are blank). This writes those twelve numbers into a SCRATCH COPY of the
// project and renders it — rive/sealitaire is never touched, so a palette you
// do not keep leaves nothing behind.
//
//   node tools/sealitaire-bg.mjs                        every palette below
//   node tools/sealitaire-bg.mjs paper ink              just these
//   node tools/sealitaire-bg.mjs mine '#FFF1F2' '#FFF8E7' '#EEF4FF' '#EFF7EE'
//                                     fish   star     bubble   shell
//
// Writes rive/sealitaire/build/bg/<name>.png and an index.html beside them.
// Every frame is the SAME DEAL (`--data=lab=deal`, table.luau's LAB_SEED), so
// two palettes differ only in the thing being auditioned. About a second each.
//
// To keep one: put its four hexes into the `bg<Suit>` rows of tuning.luau, or
// drag them in the tuner (press T, the `suits` header) and press SAVE.
// ============================================================================
import { cpSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'rive/sealitaire');
const OUT = join(PROJECT, 'build/bg');
const RIVE = process.env.RIVE_CLI || join(process.env.HOME ?? '', '.rive/bin/rive');

// The suits, in tuning.luau's key order — and what they print as in a corner:
// fish is the Heart, star the Diamond, bubble the Spade, shell the Club.
const SUITS = ['Fish', 'Star', 'Bubble', 'Shell'];

// The candidates. Each is four hexes in that order. Starting points to look
// at, not a recommendation — edit the list, or pass your own four on the
// command line. `white` is what the game ships with.
const PALETTES = {
  white: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF'],
  paper: ['#FFF1F2', '#FFF8E7', '#EEF4FF', '#EFF7EE'],
  tinted: ['#FFD9DD', '#FFEFC4', '#D6E4FF', '#D9EFD9'],
  redblack: ['#FFEAEA', '#FFEAEA', '#ECEFF3', '#ECEFF3'],
  ink: ['#2A1418', '#2A2312', '#101C2E', '#12261A'],
  deep: ['#1C0F1E', '#1E1410', '#081521', '#0B1E14'],
};

const hexTriple = (hex) => {
  const h = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a #RRGGBB colour: ${hex}`);
  return [0, 1, 2].map((k) => parseInt(h.slice(k * 2, k * 2 + 2), 16) / 255);
};

/** tuning.luau with the twelve suit rows set to `hexes`. Pure, and it THROWS
 *  on a row it cannot find rather than rendering the old colour and letting
 *  the picture lie about which palette it is. */
export function applyPalette(text, hexes) {
  let out = text;
  hexes.forEach((hex, i) => {
    hexTriple(hex).forEach((v, k) => {
      const key = `bg${SUITS[i]}${'RGB'[k]}`;
      const re = new RegExp(`(\\{ key = '${key}', min = 0, max = 1, value = )[^,]+`);
      if (!re.test(out)) throw new Error(`tuning.luau has no ${key} row`);
      out = out.replace(re, `$1${v.toFixed(4)}`);
    });
  });
  return out;
}

function render(name, hexes) {
  const dir = mkdtempSync(join(tmpdir(), 'sealitaire-bg-'));
  try {
    cpSync(PROJECT, dir, { recursive: true, filter: (p) => !p.includes('/build') });
    const tp = join(dir, 'tuning.luau');
    writeFileSync(tp, applyPalette(readFileSync(tp, 'utf8'), hexes));
    const shot = join(dir, 'shot.png');
    execFileSync(RIVE, [dir, `--screenshot=${shot}`, '--advance=90', '--data=lab=deal'], { stdio: 'pipe' });
    mkdirSync(OUT, { recursive: true });
    copyFileSync(shot, join(OUT, `${name}.png`));
    console.log(`  ${name}  ${hexes.join(' ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
let jobs;
if (args.length === 5 && args.slice(1).every((a) => a.includes('#') || /^[0-9a-fA-F]{6}$/.test(a))) {
  jobs = [[args[0], args.slice(1)]];
} else if (args.length === 4 && args.every((a) => a.includes('#') || /^[0-9a-fA-F]{6}$/.test(a))) {
  jobs = [['custom', args]];
} else {
  const want = args.length ? args : Object.keys(PALETTES);
  jobs = want.map((n) => {
    if (!PALETTES[n]) throw new Error(`no palette "${n}"; have ${Object.keys(PALETTES).join(' ')}`);
    return [n, PALETTES[n]];
  });
}

console.log(`sealitaire bg: ${jobs.length} palette${jobs.length === 1 ? '' : 's'}, same deal each`);
for (const [name, hexes] of jobs) render(name, hexes);

const swatch = (h) => `<i style="background:${h}"></i>`;
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>sealitaire tank backgrounds</title>
<style>body{margin:0;padding:24px;background:#0d1117;color:#c9d1d9;font:13px/1.5 ui-sans-serif,system-ui}
h1{font-size:15px;font-weight:600;margin:0 0 4px}p{margin:0 0 20px;color:#8b949e}
figure{margin:0 0 28px}img{width:100%;display:block;border-radius:8px}
figcaption{display:flex;gap:8px;align-items:center;padding:8px 2px;font-variant-numeric:tabular-nums}
b{font-weight:600}i{width:15px;height:15px;border-radius:3px;display:inline-block;box-shadow:0 0 0 1px #30363d}
code{color:#8b949e}</style>
<h1>Tank backgrounds, by suit</h1>
<p>fish&nbsp;Heart &middot; star&nbsp;Diamond &middot; bubble&nbsp;Spade &middot; shell&nbsp;Club. Same deal in every frame.</p>
${jobs.map(([n, h]) => `<figure><img src="${n}.png" alt="${n}"><figcaption><b>${n}</b>${h.map(swatch).join('')}<code>${h.join(' ')}</code></figcaption></figure>`).join('\n')}
`);
console.log(`wrote ${join(OUT, 'index.html')}`);
