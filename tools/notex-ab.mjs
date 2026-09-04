// ---------------------------------------------------------------------------
// THE NO-TEXTURE A/B — what do the photo textures cost?
//
//   npm run notex            build, then play a run as shipped and a run under
//                            ?notex, and print the two side by side
//   npm run notex -- --no-build --seconds 90 --show --order notex,base
//
// WHAT IT MEASURES. tools/notex/instrument.cjs sits under the game and counts
// at the GL layer: bytes handed to texImage2D (what the textures actually cost
// in memory, not what `npm run tex` predicts from headers), draw calls per
// frame, JS ms per frame, and — where EXT_disjoint_timer_query_webgl2 is on —
// GPU ms per frame. The last one is the answer to the question: a frame that
// no longer samples 232MB of jpeg is cheaper on the GPU whether or not the
// frame RATE moves, and on a display-paced rAF it usually does not.
//
// WHAT IT CANNOT TELL YOU. This is a Mac with unified memory and a desktop GPU;
// the phone that the question is about pages textures it cannot fit and
// throttles when it warms up, and neither of those shows here. Read the GPU-ms
// and upload-MB columns as a lower bound on what a phone would save, then put
// `?notex` on the address bar of the deployed build and feel it.
//
// One run each, sequential. Timings swing with machine load — run it twice
// idle before believing a small difference. Uploads and bytes are exact.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const args = process.argv.slice(2);
const NO_BUILD = args.includes('--no-build');
const passthrough = args.filter((a) => a !== '--no-build');

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], ...opts });
    let out = '';
    child.stdout.on('data', (d) => { const s = d.toString(); out += s; if (!opts.quiet) process.stdout.write(s); });
    child.on('exit', (code) => (code === 0 || opts.tolerate ? res(out) : rej(new Error(`${cmd} exited ${code}`))));
    child.on('error', rej);
  });
}

if (!NO_BUILD) {
  process.stdout.write('building dist-desktop…\n');
  await run('npm', ['run', 'build:desktop'], { quiet: true });
}

const electron = resolve(ROOT, 'node_modules', '.bin', 'electron');
const shots = resolve(ROOT, 'dist-desktop', 'notex-shots');
const out = await run(electron, [resolve(HERE, 'notex', 'drive.js'), '--shots', shots, ...passthrough], { tolerate: true });
const line = out.split('\n').find((l) => l.startsWith('NOTEX_AB '));
if (!line) {
  process.stderr.write('the driver printed no result\n');
  process.exit(1);
}
const report = JSON.parse(line.slice('NOTEX_AB '.length));
if (report.error) {
  process.stderr.write(`${report.error}\n`);
  process.exit(1);
}

const a = report.results.base;
const b = report.results.notex;
for (const r of [a, b]) {
  if (r?.error) process.stdout.write(`\n${r.variant}: ${r.error}\n`);
}
if ((a && a.error) || (b && b.error)) process.exit(1);
if (!a || !b) {
  for (const r of [a, b]) {
    if (!r?.passes?.length) continue;
    const total = r.passes.reduce((t, [, ms]) => t + ms, 0);
    process.stdout.write(`\n  ${r.variant}: ${r.recorded}s recorded, ${r.frame.n} frames, GPU ${r.gpu.p50}ms p50 / ${r.gpu.p95}ms p95, canvas ${r.canvas?.join('x')}${r.died ? ', died' : ''}\n  GPU ms per frame by pass (${total.toFixed(2)}ms total)\n`);
    for (const [key, ms] of r.passes.slice(0, 30)) process.stdout.write(`    ${ms.toFixed(2).padStart(7)}  ${(ms / total * 100).toFixed(0).padStart(3)}%  ${key}\n`);
  }
  process.exit(0);
}

const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? String(v) : v);
const row = (label, va, vb, unit = '') => {
  const d = typeof va === 'number' && typeof vb === 'number' && va !== 0
    ? `${vb - va >= 0 ? '+' : ''}${(((vb - va) / va) * 100).toFixed(0)}%`
    : '';
  process.stdout.write(`  ${label.padEnd(26)}${(fmt(va) + unit).padStart(12)}${(fmt(vb) + unit).padStart(12)}${d.padStart(9)}\n`);
};

process.stdout.write(`\n  ${''.padEnd(26)}${'as shipped'.padStart(12)}${'?notex'.padStart(12)}${'change'.padStart(9)}\n`);
process.stdout.write(`  ${'-'.repeat(59)}\n`);
row('texture uploads', a.uploads.count, b.uploads.count);
row('  of which compressed', a.uploads.compressed, b.uploads.compressed);
row('texture MB uploaded', a.uploads.MB, b.uploads.MB);
row('  uploads during the run', a.uploads.duringRun, b.uploads.duringRun);
row('re-uploaded MB per frame', a.uploads.reuploadMBPerFrame, b.uploads.reuploadMBPerFrame);
row('render targets (MB)', a.uploads.targetMB, b.uploads.targetMB);
row('level-up cards clicked', a.cards, b.cards);
row('boot to run (s)', +(a.bootMs / 1000).toFixed(1), +(b.bootMs / 1000).toFixed(1));
process.stdout.write(`  ${'-'.repeat(59)}\n`);
row('GPU ms/frame p50', a.gpu.p50, b.gpu.p50);
row('GPU ms/frame p95', a.gpu.p95, b.gpu.p95);
row('GPU ms/frame mean', a.gpu.mean, b.gpu.mean);
row('JS ms/frame p50', a.js.p50, b.js.p50);
row('JS ms/frame p95', a.js.p95, b.js.p95);
row('frame ms p50', a.frame.p50, b.frame.p50);
row('frame ms p95', a.frame.p95, b.frame.p95);
row('frame ms p99', a.frame.p99, b.frame.p99);
row('hitches > 33ms', a.hitches, b.hitches);
row('frames recorded', a.frame.n, b.frame.n);
row('seconds recorded', a.recorded, b.recorded);
row('died during recording', a.died ? 'yes' : 'no', b.died ? 'yes' : 'no');
row('draws/frame mean', a.draws.mean, b.draws.mean);
process.stdout.write(`  ${'-'.repeat(59)}\n`);
row('JS heap MB', a.heapMB, b.heapMB);
row('renderer RSS MB', a.memory.after.rendererMB, b.memory.after.rendererMB);
row('GPU process MB', a.memory.after.gpuMB, b.memory.after.gpuMB);
row('GPU process delta MB', a.memory.gpuDeltaMB, b.memory.gpuDeltaMB);
process.stdout.write(`\n  canvas ${a.canvas?.join('x')} · timer queries ${a.ext ? 'on' : 'OFF'} · ${report.seconds}s recorded after ${report.warm}s warm-up\n`);
for (const r of [a, b]) {
  if (r.meta) process.stdout.write(`  ${r.variant} tuner: ${r.meta}\n`);
  for (const l of r.console) process.stdout.write(`  ${r.variant}: ${l}\n`);
  for (const e of r.errors) process.stdout.write(`  ${r.variant} ERROR: ${e}\n`);
}
process.stdout.write(`  shots: ${shots}/base.png, ${shots}/notex.png\n\n`);

// WHERE THE GPU MILLISECONDS GO — per program, per target, per frame.
for (const r of [a, b]) {
  if (!r.passes?.length) continue;
  const total = r.passes.reduce((t, [, ms]) => t + ms, 0);
  process.stdout.write(`  ${r.variant}: GPU ms per frame by pass (${total.toFixed(2)}ms total)\n`);
  for (const [key, ms] of r.passes.slice(0, 24)) {
    process.stdout.write(`    ${ms.toFixed(2).padStart(7)}  ${(ms / total * 100).toFixed(0).padStart(3)}%  ${key}\n`);
  }
  process.stdout.write('\n');
}
