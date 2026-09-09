#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run imitate:train [--epochs N] [--hidden N] [--dry] [--force] [--no-mask] [file.jsonl]
//
// Fit the versus bot's policy to what a player did. Reads every batch in
// playtest/imitation.jsonl (posted by the game while a versus match is
// played — systems/imitation.js), trains a small dense network to map the
// seal's view of the game to the stick, the aim and the strike, and writes
// path/src/versusPolicy.json, which systems/versusBot.js runs as player 2
// when CONFIG.versus.bot.brain is 'policy' or 'auto'.
//
// PLAIN JAVASCRIPT, NO DEPENDENCIES. The network is two tanh layers and a
// linear head, trained by minibatch Adam on a loss that is squared error on
// the four stick/aim outputs (through tanh) and binary cross-entropy on the
// strike (through a sigmoid). The forward pass is the game's own
// mlpForward, so the file it writes is exactly what the bot evaluates. A
// tenth of the rows are held out and the report is on those, which is the
// only number that says anything: training loss falls whatever you do.
//
// It will not overwrite a better policy with a worse one: the held-out
// strike accuracy and stick agreement have to clear the floors below, or
// the run reports and leaves the JSON alone (--force writes anyway).
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mlpForward, maskedInput, prepareModel, FEATURE_NAMES, N_FEATURES, N_ACTIONS, IMITATION_VERSION } from '../path/src/systems/imitation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
export const DEFAULT_SRC = join(PROJECT, 'playtest/imitation.jsonl');
export const POLICY_OUT = join(PROJECT, 'path/src/versusPolicy.json');

// Floors a policy has to clear on the held-out tenth before it ships.
export const FLOORS = { strikeAccuracy: 0.8, stickAgreement: 0.6 };

// INPUTS THE POLICY IS NOT SHOWN — see maskedInput in imitation.js for why
// `pending` is here. `myVx`/`myVy` are here for the same reason one step
// removed: a seal's velocity is the stick it was pushed with a moment ago,
// so a network shown it learns "moving → keep moving, still → stay still"
// (81% of the human's rows with a still seal have a centred stick) and a bot
// that starts a kickoff still never leaves the line. `charge` is the same
// trap with a longer fuse: 38% of the rows are a full meter and the player
// strikes on 2% of those — a full meter means "has not struck since the
// whistle", which is history, not a decision — so a bot born full never
// strikes, and never striking keeps it full. Masked, the strike is read off
// the geometry and the runtime's own `me.charge > 0.02` gate is what stops
// an empty one. Recorded in the model so the game masks the same ones.
//
// NONE OF THIS SHOWS IN THE HELD-OUT SCORE. Every leak makes the held-out
// number BETTER (96.8% strike accuracy with them all in, 86% with them
// out), because the row after a held row is the easiest row there is. The
// only test that means anything is the closed loop — the shipped policy
// driving a seal in versus-bot-test.mjs — and that is where the floors
// that matter live.
export const MASK = ['pending', 'myVx', 'myVy', 'charge'];

// A SEAL THAT HAS NOT MOVED FOR THIS LONG IS NOBODY. Player 1 is always
// recorded — the keyboard counts as a human — so a match played on one pad
// as player 2 files a second seal that sat at its spawn for the whole game,
// stick centred, doing nothing. A tenth of the rows were that. A person
// thinking pauses for a second or two; three seconds of a centred stick and
// no strike is an empty chair, and the rows are dropped.
export const IDLE_RUN = 60; // ticks at 20Hz

/** Whether a row is a centred stick and no strike. */
function stillRow(r) {
  return Math.hypot(r[N_FEATURES], r[N_FEATURES + 1]) < 0.05 && r[N_FEATURES + 4] < 0.5;
}

/**
 * Drop the long runs of stillness from a batch's rows, in order. Returns
 * the rows kept and how many went.
 */
export function dropIdleRuns(rows, minRun = IDLE_RUN) {
  const keep = [];
  let run = [];
  const flush = () => { if (run.length < minRun) keep.push(...run); run = []; };
  for (const r of rows) {
    if (stillRow(r)) run.push(r);
    else { flush(); keep.push(r); }
  }
  flush();
  return { rows: keep, dropped: rows.length - keep.length };
}

/** Rows out of the JSONL: every batch's rows, of the current version and width, less the empty chairs. */
export async function loadRows(path = DEFAULT_SRC, { idle = true } = {}) {
  const text = await readFile(path, 'utf8');
  const rows = [];
  let skipped = 0;
  let idleDropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let doc;
    try { doc = JSON.parse(line); } catch { skipped++; continue; }
    if (doc.version !== IMITATION_VERSION || !Array.isArray(doc.rows)) { skipped++; continue; }
    const good = [];
    for (const r of doc.rows) {
      if (r.length === N_FEATURES + N_ACTIONS) good.push(r);
      else skipped++;
    }
    if (idle) {
      const d = dropIdleRuns(good);
      idleDropped += d.dropped;
      rows.push(...d.rows);
    } else rows.push(...good);
  }
  return { rows, skipped, idleDropped };
}

// --- the network ----------------------------------------------------------------

function makeLayer(nIn, nOut, act, rng) {
  const scale = Math.sqrt(2 / (nIn + nOut));
  const w = new Float64Array(nIn * nOut);
  for (let i = 0; i < w.length; i++) w[i] = (rng() * 2 - 1) * scale * 1.7;
  return { w, b: new Float64Array(nOut), act, nIn, nOut };
}

function forwardTrace(layers, x) {
  const acts = [x];
  let a = x;
  for (const L of layers) {
    const y = new Float64Array(L.nOut);
    for (let o = 0; o < L.nOut; o++) {
      let s = L.b[o];
      const row = o * L.nIn;
      for (let i = 0; i < L.nIn; i++) s += L.w[row + i] * a[i];
      y[o] = L.act === 'tanh' ? Math.tanh(s) : s;
    }
    acts.push(y);
    a = y;
  }
  return acts;
}

// The loss's gradient at the head: squared error through tanh on the first
// four outputs, cross-entropy through a sigmoid on the strike. Both reduce
// to (prediction - target) times the squash's slope, which is the whole
// reason the head is linear and the squashes live outside it.
function headGradient(y, target, out) {
  let loss = 0;
  for (let k = 0; k < 4; k++) {
    const p = Math.tanh(y[k]);
    const e = p - target[k];
    loss += e * e;
    out[k] = 2 * e * (1 - p * p);
  }
  const p = 1 / (1 + Math.exp(-y[4]));
  const t = target[4];
  loss += -(t * Math.log(p + 1e-9) + (1 - t) * Math.log(1 - p + 1e-9));
  out[4] = p - t;
  return loss;
}

/**
 * Train on `rows` ([...features, ...actions]). Returns { model, report }.
 * `model` is in the game's JSON shape (plain arrays), ready to write.
 */
export function train(rows, { epochs = 40, hidden = 32, lr = 0.003, batch = 64, seed = 7, holdout = 0.1, log = null, mask = MASK } = {}) {
  // The masked columns are zeroed in the DATA, so the network never sees
  // them; the model carries the names so the game zeroes the same ones.
  const maskIdx = (mask ?? []).map((n) => FEATURE_NAMES.indexOf(n)).filter((i) => i >= 0);
  if (maskIdx.length) rows = rows.map((r) => { const c = r.slice(); for (const i of maskIdx) c[i] = 0; return c; });
  let s = seed >>> 0 || 1;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  // Shuffle once, split.
  const idx = rows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const nHold = Math.max(1, Math.floor(idx.length * holdout));
  const hold = idx.slice(0, nHold);
  const trainIdx = idx.slice(nHold);
  if (trainIdx.length < 8) throw new Error(`only ${rows.length} rows — play a match first`);

  const layers = [
    makeLayer(N_FEATURES, hidden, 'tanh', rng),
    makeLayer(hidden, hidden, 'tanh', rng),
    makeLayer(hidden, N_ACTIONS, 'linear', rng),
  ];
  // Adam state.
  const mW = layers.map((L) => new Float64Array(L.w.length));
  const vW = layers.map((L) => new Float64Array(L.w.length));
  const mB = layers.map((L) => new Float64Array(L.nOut));
  const vB = layers.map((L) => new Float64Array(L.nOut));
  const gW = layers.map((L) => new Float64Array(L.w.length));
  const gB = layers.map((L) => new Float64Array(L.nOut));
  const b1 = 0.9; const b2 = 0.999; const eps = 1e-8;
  let step = 0;

  const x = new Float64Array(N_FEATURES);
  const t = new Float64Array(N_ACTIONS);
  const dHead = new Float64Array(N_ACTIONS);
  let lastLoss = 0;
  for (let ep = 0; ep < epochs; ep++) {
    // Reshuffle the training slice each epoch.
    for (let i = trainIdx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [trainIdx[i], trainIdx[j]] = [trainIdx[j], trainIdx[i]]; }
    let epLoss = 0;
    for (let start = 0; start < trainIdx.length; start += batch) {
      const end = Math.min(trainIdx.length, start + batch);
      for (const g of gW) g.fill(0);
      for (const g of gB) g.fill(0);
      for (let n = start; n < end; n++) {
        const row = rows[trainIdx[n]];
        for (let i = 0; i < N_FEATURES; i++) x[i] = row[i];
        for (let i = 0; i < N_ACTIONS; i++) t[i] = row[N_FEATURES + i];
        const acts = forwardTrace(layers, x);
        epLoss += headGradient(acts[acts.length - 1], t, dHead);
        // Backprop.
        let delta = dHead;
        for (let l = layers.length - 1; l >= 0; l--) {
          const L = layers[l];
          const aIn = acts[l];
          const next = new Float64Array(L.nIn);
          for (let o = 0; o < L.nOut; o++) {
            const d = delta[o];
            gB[l][o] += d;
            const row = o * L.nIn;
            for (let i = 0; i < L.nIn; i++) {
              gW[l][row + i] += d * aIn[i];
              next[i] += d * L.w[row + i];
            }
          }
          if (l > 0) {
            // Through the previous layer's tanh.
            const aPrev = acts[l];
            for (let i = 0; i < L.nIn; i++) next[i] *= (1 - aPrev[i] * aPrev[i]);
          }
          delta = next;
        }
      }
      // Adam step on the batch mean.
      step++;
      const inv = 1 / (end - start);
      const c1 = 1 - Math.pow(b1, step);
      const c2 = 1 - Math.pow(b2, step);
      for (let l = 0; l < layers.length; l++) {
        const L = layers[l];
        for (let i = 0; i < L.w.length; i++) {
          const g = gW[l][i] * inv;
          mW[l][i] = b1 * mW[l][i] + (1 - b1) * g;
          vW[l][i] = b2 * vW[l][i] + (1 - b2) * g * g;
          L.w[i] -= lr * (mW[l][i] / c1) / (Math.sqrt(vW[l][i] / c2) + eps);
        }
        for (let o = 0; o < L.nOut; o++) {
          const g = gB[l][o] * inv;
          mB[l][o] = b1 * mB[l][o] + (1 - b1) * g;
          vB[l][o] = b2 * vB[l][o] + (1 - b2) * g * g;
          L.b[o] -= lr * (mB[l][o] / c1) / (Math.sqrt(vB[l][o] / c2) + eps);
        }
      }
    }
    lastLoss = epLoss / trainIdx.length;
    if (log && (ep % 10 === 0 || ep === epochs - 1)) log(`  epoch ${ep + 1}/${epochs}  loss ${lastLoss.toFixed(4)}`);
  }

  const model = {
    trained: true,
    version: IMITATION_VERSION,
    inputs: N_FEATURES,
    hidden,
    rows: rows.length,
    epochs,
    trainedAt: new Date().toISOString(),
    mask: mask ?? [],
    layers: layers.map((L) => ({ w: Array.from(L.w, (v) => +v.toFixed(5)), b: Array.from(L.b, (v) => +v.toFixed(5)), act: L.act })),
  };
  const report = evaluate(model, hold.map((i) => rows[i]));
  report.trainLoss = lastLoss;
  report.trainRows = trainIdx.length;
  report.holdRows = hold.length;
  return { model, report };
}

/**
 * How a policy does on rows it did not train on: strike accuracy (held or
 * not, at 0.5) and stick agreement (mean cosine between the predicted and
 * the played stick, over rows where the player pushed the stick at all).
 */
export function evaluate(model, rows) {
  let strikeRight = 0;
  let cos = 0;
  let cosN = 0;
  let stickErr = 0;
  const x = new Float32Array(N_FEATURES);
  prepareModel(model);
  for (const row of rows) {
    for (let i = 0; i < N_FEATURES; i++) x[i] = row[i];
    const y = mlpForward(model, maskedInput(model, x));
    const mx = Math.tanh(y[0]); const my = Math.tanh(y[1]);
    const tx = row[N_FEATURES]; const ty = row[N_FEATURES + 1];
    const held = (1 / (1 + Math.exp(-y[4]))) > 0.5 ? 1 : 0;
    if (held === (row[N_FEATURES + 4] > 0.5 ? 1 : 0)) strikeRight++;
    stickErr += (mx - tx) ** 2 + (my - ty) ** 2;
    const tl = Math.hypot(tx, ty);
    const pl = Math.hypot(mx, my);
    if (tl > 0.2 && pl > 1e-6) { cos += (mx * tx + my * ty) / (tl * pl); cosN++; }
  }
  const n = Math.max(1, rows.length);
  return {
    strikeAccuracy: strikeRight / n,
    stickAgreement: cosN ? cos / cosN : 0,
    stickMse: stickErr / n,
    rows: rows.length,
  };
}

export function clearsFloors(report) {
  return report.strikeAccuracy >= FLOORS.strikeAccuracy && report.stickAgreement >= FLOORS.stickAgreement;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? Number(process.argv[i + 1]) : dflt; };
  const dry = process.argv.includes('--dry');
  const force = process.argv.includes('--force');
  const src = process.argv.find((a) => a.endsWith('.jsonl')) ?? DEFAULT_SRC;
  const epochs = arg('--epochs', 40);
  const hidden = arg('--hidden', 32);
  let loaded;
  try { loaded = await loadRows(src); } catch (err) {
    console.log(`no rows at ${src} (${err.message}) — play a versus match on the dev server first`);
    process.exit(1);
  }
  console.log(`${loaded.rows.length} rows from ${src}${loaded.skipped ? ` (${loaded.skipped} skipped)` : ''}${loaded.idleDropped ? ` (${loaded.idleDropped} idle rows dropped)` : ''}`);
  const mask = process.argv.includes('--no-mask') ? [] : MASK;
  const { model, report } = train(loaded.rows, { epochs, hidden, mask, log: console.log });
  console.log(`held out ${report.holdRows}: strike accuracy ${(report.strikeAccuracy * 100).toFixed(1)}%  stick agreement ${report.stickAgreement.toFixed(3)}  stick mse ${report.stickMse.toFixed(3)}`);
  const ok = clearsFloors(report);
  if (!ok) console.log(`below the floors (strike ≥ ${FLOORS.strikeAccuracy}, stick ≥ ${FLOORS.stickAgreement})${force ? ' — writing anyway (--force)' : ' — not written; play more, or --force'}`);
  if (dry) { console.log('(dry run — nothing written)'); process.exit(0); }
  if (ok || force) {
    await writeFile(POLICY_OUT, JSON.stringify(model) + '\n');
    console.log(`wrote path/src/versusPolicy.json (${model.rows} rows, ${hidden} hidden) — the bot plays it when CONFIG.versus.bot.brain is 'policy' or 'auto'`);
  }
  process.exit(ok || force ? 0 : 2);
}
