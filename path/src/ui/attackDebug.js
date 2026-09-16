import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { isTypingTarget } from './typing.js';
import { bossArchetypes, bossPerkList, bossState, forceBoss } from '../systems/boss.js';
import { enemies, holdSpawns } from '../entities/enemies.js';
import { player } from '../entities/player.js';
import {
  setAttackTrace, attackTraceReport, attackTraceLive, resetAttackTrace, attackStudy,
} from '../systems/attackTrace.js';
import {
  showAttackOverlay, hideAttackOverlay, attackOverlayOn, updateAttackOverlay,
  setAttackOverlayWeight, attackOverlayWeight,
} from '../systems/attackOverlay.js';

// ---------------------------------------------------------------------------
// THE ATTACK PANEL — press V.
// ---------------------------------------------------------------------------
// The sandbox for one question: does the boss's attack actually reach you?
//
// It is a key beside C's chain debug rather than a tab in the ` tuner, and for
// the same reason that one is: the thing being diagnosed is a decision an
// animal takes over half a second while you are dodging it, and anything you
// have to pause to read is a description of a frame. The panel floats over a
// live fight and every number in it is this frame's.
//
// FOUR BLOCKS, top to bottom, and they answer four different questions.
//
//   THE STAGE       put a body and a perk in the water now. The same door
//                   ui/upgradeDebug.js opens (forceBoss), duplicated here on
//                   purpose and in four lines: the loop being worked is
//                   "spawn, watch two lunges, nudge a number, spawn again",
//                   and a loop that crosses two panels is a loop nobody runs.
//                   `solo` holds the spawner so the fight is the boss alone —
//                   the crowd gate only ever closes when other apex bodies are
//                   in the water, so it is a different fight with six sharks
//                   in it.
//
//   WHAT IT IS DOING RIGHT NOW. The stage of the lunge machine, the gate that
//                   is currently shut and how long it has been shut, and the
//                   three distances the decision is made against. The overlay
//                   (systems/attackOverlay.js) draws the same numbers on the
//                   floor under the animal, which is the half you read while
//                   you are swimming.
//
//   THE LEDGER      the whole fight: wind-ups, commits, what each run's
//                   CLOSEST APPROACH was, bites fired against bites billed —
//                   and, for every gate, the share of the fight it held things
//                   up for. "78% `cone`" is an answer; "it doesn't commit" is
//                   not.
//
//   THE NUMBERS     sliders over exactly the rows behaviour.csv owns for the
//                   selected body, plus the shared lungeRules, the bite and the
//                   hostile-shot block. They write CONFIG live and NOTHING
//                   ELSE — see the note on `slider` below for why that is the
//                   whole design rather than a missing feature.
//
// DEV ONLY, wired behind DEV_UI in main.js beside the rest of the panels.
// ---------------------------------------------------------------------------

const ROLL = '(roll)';
const NONE = '(none)';

const C = {
  dim: 'rgba(232,236,243,0.45)',
  text: 'rgba(232,236,243,0.88)',
  ok: '#7ee081',
  warn: '#ffc861',
  bad: '#ff8f76',
  off: 'rgba(232,236,243,0.3)',
};

// What each gate MEANS, in one line, beside its share of the fight. A dwell
// figure with no explanation is a word and a percentage.
const GATE_WHY = {
  minRange: 'you are inside its floor — there is no wind-up left to give',
  crowd: 'the feeding ring has not given this body its turn',
  turning: 'mid come-about — it turns, then it gathers',
  range: 'too far to open a run',
  pitch: 'the line to you is too steep off horizontal',
  cone: 'you are outside the cone it may commit through',
  budget: 'the wind-up cannot turn that far — windup x turnRate is the real cone',
  open: 'clear to commit',
};

let panel = null;
let visible = false;
let bodyEl = null;
let world = () => null;

let bossPick = ROLL;
let perkPick = ROLL;
let status = '';
// Whether the overlay draws rings on ordinary lunging wildlife as well as on
// the boss. Off by default: six sharks' worth of range, floor, bite and cone is
// a picture nobody can read, and the boss is what the panel is for.
let wildlife = false;
function showWildlife() { return wildlife; }
// Which creature the live readout and the sliders are pointed at. The boss when
// there is one; otherwise the first lunging body in the water, so the panel is
// still useful against wildlife with no boss up.
let subject = null;

function subjectNow() {
  if (bossState.enemy && bossState.enemy.hp > 0) return bossState.enemy;
  return enemies.find((e) => e.def?.lunge) ?? null;
}

function el(tag, css, text) {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text != null) n.textContent = text;
  return n;
}

function button(label, onClick, on = false) {
  const b = el('button',
    'padding:3px 8px;border-radius:5px;cursor:pointer;font:inherit;'
    + `border:1px solid rgba(232,236,243,${on ? 0.5 : 0.2});`
    + `background:rgba(232,236,243,${on ? 0.16 : 0.05});color:${on ? C.text : C.dim};`,
    label);
  b.type = 'button';
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); render(); });
  return b;
}

function chips(label, options, current, pick) {
  const wrap = el('div', 'display:flex;gap:4px;align-items:flex-start;');
  wrap.appendChild(el('div', `color:${C.dim};flex:0 0 42px;padding-top:3px;`, label));
  const bar = el('div', 'display:flex;gap:3px;flex-wrap:wrap;flex:1 1 auto;');
  for (const o of options) bar.appendChild(button(o, () => pick(o), o === current));
  wrap.appendChild(bar);
  return wrap;
}

/**
 * WHICH NUMBERS GET A SLIDER, for a given body.
 *
 * Exported so tools/attack-panel-test.mjs can hold the whole list against
 * behaviour.csv. Every path here MUST be one that table owns: a slider over a
 * path it does not own writes CONFIG live, looks like it worked, and then
 * produces a Copy-rows line that behaviour.csv silently refuses (see the root
 * and forbid checks in pathTable.js). The drag would work and the paste would
 * do nothing, which is the worst pair of behaviours available.
 */
export function sliderRows(key = null) {
  const rows = [];
  if (key && CONFIG.enemies?.[key]?.lunge) {
    // Per-species, and only the eight columns behaviour.csv carries for a lunge
    // block. `damageMul` is deliberately absent: only the four boss rows have
    // it, so a slider for it would be dead on every other body.
    rows.push(
      [`enemies.${key}.lunge.range`, 'range', 4, 40],
      [`enemies.${key}.lunge.minRange`, 'minRange', 1, 20],
      [`enemies.${key}.lunge.windup`, 'windup', 0.1, 3],
      [`enemies.${key}.lunge.windSpeedMul`, 'windSpeedMul', 0, 1],
      [`enemies.${key}.lunge.speedMul`, 'speedMul', 1, 8],
      [`enemies.${key}.lunge.strikeTime`, 'strikeTime', 0.1, 3],
      [`enemies.${key}.lunge.strikeTurnRate`, 'strikeTurnRate', 0, 4],
      [`enemies.${key}.lunge.cooldown`, 'cooldown', 0.2, 15],
    );
  }
  rows.push(
    // FIRST, because it is the one number the measurements argue about — see
    // CONFIG.lungeRules.lead. It ships at 0 (aim at where you are, which is
    // every lunge the game has ever had); drag it up and the wind-up visibly
    // aims ahead of you.
    ['lungeRules.lead', 'lead the seal', 0, 1],
    ['lungeRules.commitCone', 'commitCone', 0.2, 3.14],
    ['lungeRules.maxPitch', 'maxPitch', 0.1, 1.57],
    ['lungeRules.reaimCone', 'reaimCone', 0.1, 3.14],
    ['lungeRules.reaimMax', 'reaimMax', 0.2, 3],
    ['lungeRules.strikeBiteMul', 'strikeBiteMul', 1, 6],
    // THE ONE THAT DECIDES WHETHER A BITE LANDS, first of the pair. See
    // CONFIG.bite.mouthReach — it is the narrow gate, and the overlay draws it.
    ['bite.mouthReach', 'bite.mouthReach', 0.1, 2],
    ['bite.playerReach', 'bite.playerReach', 0.5, 3],
    ['bite.lead', 'bite.lead', 0.5, 6],
    ['enemyShot.reachMul', 'shot reachMul', 1, 6],
    ['enemyShot.hp', 'shot hp', 0, 80],
    ['enemyShot.hpPerDifficulty', 'shot hp/diff', 0, 10],
    ['enemyShot.hpPerDamage', 'shot hp/damage', 0, 3],
    ['boats.guns.range', 'deck gun range', 5, 60],
  );
  return rows;
}

/** What the panel is showing, for a harness. */
export function attackDebugState() {
  return {
    visible,
    status,
    bossPick,
    perkPick,
    wildlife,
    touched: [...touched.keys()],
    rows: sliderRows(subject?.type ?? null).map(([p]) => p),
  };
}

// ---------------------------------------------------------------------------
// THE SLIDER, and why it is thirty lines here rather than ui/tunerControls.js's.
// ---------------------------------------------------------------------------
// buildRow calls saveTuningToStorage() on every drag, which writes
// path/src/imported-tuning.json. Every path this panel touches is owned by
// behaviour.csv, and a CSV-owned path is stripped from that snapshot on the way
// in AND on the way out (see pathTable.js) — so a shared row would spend a file
// write per frame of a drag to persist nothing.
//
// That is not a reason to add persistence. It is the design: these numbers are
// judged over a whole fight and against each other, which is exactly what makes
// them a file rather than a slider in the first place. So the loop this panel
// supports is "drag it, watch two more lunges, and when it is right put the
// number in behaviour.csv with `npm run csv`" — and Copy rows at the bottom
// hands you those lines already written.
//
// A live edit therefore lasts until the page reloads, and the panel says so.
function slider(path, label, min, max, step = null) {
  const cur = read(path);
  if (typeof cur !== 'number') return null;
  // What this path held when the panel first rendered it — captured here rather
  // than at drag time, or Revert would put back the value you were unhappy with
  // instead of the one the page booted with.
  if (!original.has(path)) original.set(path, cur);
  const row = el('div', 'display:flex;gap:6px;align-items:center;padding:1px 0;');
  const name = el('div', `color:${C.dim};flex:0 0 132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`, label);
  name.title = path;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step ?? (max - min) / 200);
  input.value = String(cur);
  input.style.cssText = 'flex:1 1 auto;min-width:0;';
  const out = el('div', `flex:0 0 48px;text-align:right;color:${C.text};`, fmt(cur));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    write(path, v);
    out.textContent = fmt(v);
    touched.set(path, v);
  });
  row.append(name, input, out);
  return row;
}

// Every path this session has moved, so Copy rows can write exactly those and
// not a dump of everything on screen.
const touched = new Map();
// ...and what each one held before anything moved it, so Revert has somewhere
// to put things back to.
const original = new Map();

function fmt(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function read(path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), CONFIG);
}

function write(path, value) {
  const keys = path.split('.');
  let cur = CONFIG;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') return;
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

export function initAttackDebug(getWorld = null) {
  if (typeof getWorld === 'function') world = getWorld;

  panel = el('div',
    // RIGHT-HAND SIDE, because the upgrade panel (U) is pinned left and the two
    // are opened together constantly: grant the seal something that shoots
    // shots down, then watch the volley clear.
    'position:fixed;right:12px;top:12px;bottom:12px;width:min(430px,40vw);z-index:32;display:none;'
    + 'flex-direction:column;border-radius:10px;overflow:hidden;'
    + 'background:rgba(5,6,10,0.94);border:1px solid rgba(232,236,243,0.16);'
    + `color:${C.text};font:500 11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;`);
  bodyEl = el('div', 'flex:1 1 auto;min-height:0;overflow-y:auto;padding:9px 11px;'
    + 'display:flex;flex-direction:column;gap:7px;');
  panel.appendChild(bodyEl);
  document.body.appendChild(panel);

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) || e.repeat) return;
    if (e.key?.toLowerCase() !== 'v' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    setAttackDebugVisible(!visible);
  });
}

export function attackDebugOpen() {
  return visible;
}

export function setAttackDebugVisible(next) {
  visible = !!next;
  if (!panel) return visible;
  panel.style.display = visible ? 'flex' : 'none';
  setAttackTrace(visible);
  const scene = world()?.scene ?? null;
  if (visible && scene) showAttackOverlay(scene);
  else { hideAttackOverlay(); clearTags(); }
  if (visible) render();
  return visible;
}

/**
 * One frame. Called from main.js after the enemy pass, so the overlay draws
 * where the bodies ended up and the readout is this frame's rather than last
 * frame's — a gate that flips for one frame is exactly the kind this exists to
 * catch.
 *
 * The DOM is rebuilt at a fraction of the frame rate. Sixty rebuilds a second
 * of forty rows is real work for a readout nobody can read that fast, and it
 * also makes a slider undraggable — the row it lives in would be replaced under
 * the cursor.
 */
let sinceRender = 0;
export function updateAttackDebug(dt) {
  if (!visible) return;
  if (!attackOverlayOn()) {
    const scene = world()?.scene ?? null;
    if (scene) showAttackOverlay(scene);
  }
  // THE OVERLAY IS EVERY FRAME, the panel is not. What you read while swimming
  // is the rings under the animal, and a ring redrawn five times a second
  // visibly lags the body it is around.
  updateAttackOverlay({ showWildlife: showWildlife(), showShots: true });
  drawTags();
  // SOLO, renewed per frame rather than set once: the spawn hold is a countdown
  // (see holdSpawns) and a single call would run out a second later and look
  // like the switch had turned itself off. A tenth of a second is long enough
  // to survive a frame and short enough that closing the panel hands the water
  // straight back.
  if (attackStudy.soloBoss) holdSpawns(0.25);
  sinceRender += dt;
  if (sinceRender < 0.2) return;
  sinceRender = 0;
  const next = subjectNow();
  if (next !== subject) { subject = next; }
  render();
}

// ---------------------------------------------------------------------------
// THE NUMBERS, ON THE ANIMAL.
// ---------------------------------------------------------------------------
// The panel is 430 pixels of readout on the far side of the screen, and every
// question it answers is about a body you are currently dodging. Reading it
// means looking away from the thing it describes — which is exactly the frame
// you needed to be watching, and is why the first version of this was used
// once and then ignored.
//
// So the three figures that change fastest are pinned to the body itself: what
// stage it is in and how long is left, how far away it is against the window it
// may commit from, and whether you are inside the bite. Everything slower — the
// ledger, the gate shares, the sliders — stays in the panel, where looking away
// costs nothing because none of it moves in a tenth of a second.
//
// DOM RATHER THAN A CANVAS TEXTURE. A sprite would have to be re-rasterised
// every time a digit changes, which is every frame; it would be blurry at any
// distance the camera is not sitting at; and tools/dom-stub.mjs has no 2D
// context, so building one would make every harness that ticks this throw from
// inside three.js. A projected div is crisp at any zoom, costs a style write,
// and degrades to nothing when there is no camera — which is the harness case.
let tagLayer = null;
const tags = [];
const _tagPos = new THREE.Vector3();

function tagLayerEl() {
  if (tagLayer) return tagLayer;
  tagLayer = el('div',
    // UNDER the panel (z 32) and over the game. `pointer-events:none` through
    // the whole layer: these sit on top of the water the player is aiming at.
    'position:fixed;inset:0;pointer-events:none;z-index:31;'
    + `font:700 12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:${C.text};`);
  document.body.appendChild(tagLayer);
  return tagLayer;
}

function takeTag(i) {
  const layer = tagLayerEl();
  let t = tags[i];
  if (!t) {
    t = el('div',
      'position:absolute;transform:translate(-50%,-100%);white-space:pre;'
      + 'padding:3px 7px;border-radius:6px;background:rgba(4,6,11,0.82);'
      + 'border:1px solid rgba(232,236,243,0.22);text-shadow:0 1px 2px rgba(0,0,0,0.9);');
    tags.push(t);
    layer.appendChild(t);
  }
  return t;
}

function hideTags(from = 0) {
  for (let i = from; i < tags.length; i++) tags[i].style.display = 'none';
}

/** Drop the layer entirely. Called when the panel closes. */
function clearTags() {
  for (const t of tags) t.remove?.();
  tags.length = 0;
  tagLayer?.remove?.();
  tagLayer = null;
}

function drawTags() {
  const camera = world()?.camera ?? null;
  // No camera is the harness case and every look page: draw nothing rather than
  // guessing a projection, and leave the layer unbuilt so nothing is allocated.
  if (!camera || typeof camera.projectionMatrix === 'undefined') { hideTags(); return; }
  const pr = player.stats?.hitRadius ?? 0.5;
  let n = 0;
  for (const e of enemies) {
    if (!e.def?.lunge) continue;
    if (!wildlife && !e.isBoss) continue;
    const reach = (e.radius ?? 1) * (CONFIG.bite?.mouthReach ?? 0.55) + pr;
    const gap = distanceToSeal(e);
    const c = e.def.lunge;
    const stage = e.lungeStage ?? 'cruise';
    // Anchored ABOVE the body by its own radius, so a megalodon's tag does not
    // sit inside its head and a barracuda's is not a screen away from it.
    _tagPos.set(e.mesh.position.x, e.mesh.position.y + (e.radius ?? 1) * 1.4, e.mesh.position.z);
    _tagPos.project(camera);
    // Behind the camera, or off the picture: z past 1 is behind the near plane
    // and would otherwise be drawn mirrored at the wrong end of the screen.
    if (_tagPos.z > 1 || Math.abs(_tagPos.x) > 1.4 || Math.abs(_tagPos.y) > 1.4) continue;
    const t = takeTag(n);
    n += 1;
    t.style.display = 'block';
    t.style.left = `${(_tagPos.x * 0.5 + 0.5) * window.innerWidth}px`;
    t.style.top = `${(-_tagPos.y * 0.5 + 0.5) * window.innerHeight}px`;
    const live = attackTraceLive(e) ?? {};
    const inWindow = gap >= (c.minRange ?? 6) && gap <= (c.range ?? 12);
    // THE COLOUR IS THE STAGE, and it is the fastest thing to read: white while
    // it is running at you, amber while it is gathering, dim otherwise.
    const tone = stage === 'strike' ? '#ffffff' : stage === 'wind' ? C.warn : C.dim;
    t.style.color = tone;
    t.style.borderColor = stage === 'strike' ? 'rgba(255,255,255,0.7)'
      : stage === 'wind' ? 'rgba(255,200,97,0.6)' : 'rgba(232,236,243,0.22)';
    const clock = (e.lungeClock ?? 0).toFixed(2);
    t.textContent = `${stage.toUpperCase()} ${clock}s\n`
      + `gap ${gap.toFixed(1)} / ${(c.minRange ?? 6).toFixed(0)}-${(c.range ?? 12).toFixed(0)}${inWindow ? ' ok' : ''}\n`
      + `bite ${reach.toFixed(1)} ${gap <= reach ? 'IN REACH' : `+${(gap - reach).toFixed(1)}`}`
      + (live.gate && live.gate !== 'open' ? `\n${live.gate} ${live.heldFor?.toFixed(1) ?? 0}s` : '');
  }
  hideTags(n);
}

function line(label, value, color = C.text) {
  const row = el('div', 'display:flex;gap:8px;');
  row.append(
    el('div', `color:${C.dim};flex:0 0 118px;`, label),
    el('div', `color:${color};flex:1 1 auto;`, value),
  );
  return row;
}

function heading(text) {
  return el('div', `color:${C.dim};letter-spacing:0.14em;font-size:9px;margin-top:4px;`, text);
}

function render() {
  if (!panel || !visible) return;
  bodyEl.textContent = '';

  // --- the stage -----------------------------------------------------------
  bodyEl.appendChild(heading('STAGE'));
  const bodies = [ROLL, ...bossArchetypes().map((b) => b.id)];
  const perks = [ROLL, NONE, ...bossPerkList().map((p) => p.id)];
  bodyEl.appendChild(chips('body', bodies, bossPick, (v) => { bossPick = v; }));
  bodyEl.appendChild(chips('perk', perks, perkPick, (v) => { perkPick = v; }));

  const stageRow = el('div', 'display:flex;gap:4px;flex-wrap:wrap;');
  stageRow.append(
    button('Spawn', () => {
      const w = world();
      if (!w?.scene) { status = 'no scene'; return; }
      const e = forceBoss(w.scene, w.gameState, {
        boss: bossPick === ROLL ? null : bossPick,
        perk: perkPick === ROLL ? undefined : (perkPick === NONE ? null : perkPick),
      });
      resetAttackTrace();
      status = e ? `${bossState.archetype?.id ?? '?'} · ${bossState.perk?.id ?? 'no perk'}` : 'nothing spawned';
    }),
    button('solo', () => { attackStudy.soloBoss = !attackStudy.soloBoss; }, attackStudy.soloBoss),
    button('no damage', () => { attackStudy.noDamage = !attackStudy.noDamage; }, attackStudy.noDamage),
    // TWO WAYS TO SEE THE NEXT RUN, and the difference between them is the
    // whole diagnosis. `Ready now` zeroes the cooldown and lets the gate decide
    // — if nothing happens, the gate is the bug. `Force run` skips the gate
    // outright and puts the body into a wind-up, which is how you judge the RUN
    // itself (its reach, its turn, whether the bite lands) without waiting on
    // a gate you already know is shut.
    button('Ready now', () => {
      const e = subjectNow();
      if (!e?.def?.lunge) { status = 'this body has no lunge block — nothing to ready'; return; }
      e.lungeStage = 'cruise';
      e.lungeClock = 0;
      e.lungeVeer = null;
      status = 'cooldown cleared — the gate decides';
    }),
    button('Force run', () => {
      const e = subjectNow();
      if (!e?.def?.lunge) { status = 'this body has no lunge block — nothing to force'; return; }
      e.lungeStage = 'wind';
      e.lungeClock = e.def.lunge?.windup ?? 0.45;
      e.lungeStageTime = e.lungeClock;
      status = 'wind-up forced — the gate was skipped';
    }),
    button('wildlife rings', () => { wildlife = !wildlife; }, wildlife),
    // HOW HEAVY THE DRAWING IS. Not a taste knob: how much weight a diagnostic
    // needs to be readable depends on the display, the bloom and how fast the
    // thing being watched is moving, and nobody can judge that for somebody
    // else. Cycled rather than dragged so it can be changed mid-fight without
    // hunting for a slider.
    button(`weight x${attackOverlayWeight().toFixed(1)}`, () => {
      const steps = [0.6, 1, 1.5, 2.2, 3];
      const i = steps.findIndex((v) => v > attackOverlayWeight() + 0.01);
      setAttackOverlayWeight(steps[i === -1 ? 0 : i]);
    }),
    button('Clear log', () => { resetAttackTrace(); status = 'ledger cleared'; }),
  );
  bodyEl.appendChild(stageRow);
  if (status) bodyEl.appendChild(el('div', `color:${C.dim};`, status));

  // --- what it is doing right now ------------------------------------------
  const e = subject;
  bodyEl.appendChild(heading('RIGHT NOW'));
  if (!e) {
    bodyEl.appendChild(el('div', `color:${C.dim};`, 'nothing in the water to read'));
  } else if (!e.def?.lunge) {
    // The crab, the squid, the boats and the man o' war are real bosses with no
    // lunge at all — their attacks are elsewhere. Saying so beats an empty
    // block that reads as the panel being broken.
    bodyEl.appendChild(line('body', `${e.type}${e.isBoss ? ' (boss)' : ''}`));
    bodyEl.appendChild(el('div', `color:${C.dim};`,
      'this body carries no lunge block — its attack is its perk, its claw or its guns. '
      + 'The shot counters below still apply.'));
  } else {
    const live = attackTraceLive(e) ?? {};
    const c = e.def.lunge ?? {};
    const pp = player.mesh?.position ?? null;
    const dist = distanceToSeal(e);
    const reach = biteReach(e);
    const gate = live.gate ?? '—';
    bodyEl.appendChild(line('body', `${e.type}${e.isBoss ? ' (boss)' : ''}`));
    bodyEl.appendChild(line('stage', `${e.lungeStage ?? '—'}  ${(e.lungeClock ?? 0).toFixed(2)}s left`,
      e.lungeStage === 'strike' ? C.warn : C.text));
    // A gate only exists while the body is in the cruise branch asking for one.
    // Winding up, mid-run and cooling down are not refusals and must not be
    // rendered as the last one — see the clear in noteLungeStage.
    if (live.gate == null) {
      bodyEl.appendChild(line('gate', 'mid-cycle — not asking for a run', C.dim));
    } else {
      bodyEl.appendChild(line('gate', `${gate}  (${(live.heldFor ?? 0).toFixed(1)}s)`,
        gate === 'open' ? C.ok : C.bad));
      if (GATE_WHY[gate]) bodyEl.appendChild(el('div', `color:${C.dim};padding-left:126px;`, GATE_WHY[gate]));
    }
    bodyEl.appendChild(line('gap to seal', `${dist.toFixed(1)}u`
      + `   window ${(c.minRange ?? 6).toFixed(0)}–${(c.range ?? 12).toFixed(0)}u`,
      dist >= (c.minRange ?? 6) && dist <= (c.range ?? 12) ? C.ok : C.bad));
    bodyEl.appendChild(line('bite reach', `${reach.toFixed(2)}u`
      + `   ${dist <= reach ? 'you are inside it' : `${(dist - reach).toFixed(1)}u short`}`,
      dist <= reach ? C.ok : C.dim));
    // THE TWO CEILINGS ON THE CONE, side by side, because one of them is nearly
    // always the real one and it is not the one in the CSV. See lungeLineGate.
    const budget = (e.turnRate ?? e.def.turnRate ?? 3) * (c.windup ?? 0.45) * 0.8;
    const cone = c.commitCone ?? CONFIG.lungeRules?.commitCone ?? 1.75;
    bodyEl.appendChild(line('cone',
      `${deg(Math.min(cone, budget))}°   tuned ${deg(cone)}°, turn budget ${deg(budget)}°`,
      budget < cone ? C.warn : C.text));
    if (Number.isFinite(live.runMin)) {
      bodyEl.appendChild(line('run closest', `${live.runMin.toFixed(1)}u`, live.runMin <= reach ? C.ok : C.bad));
    }
    if (pp) bodyEl.appendChild(line('seal', `${pp.x.toFixed(0)}, ${pp.y.toFixed(0)}`, C.dim));
  }

  // --- the ledger ----------------------------------------------------------
  // FOCUSED ON THE SUBJECT. With escorts up — and a boss fight usually has them
  // — an unfocused table is six bodies' gates averaged together, and the five
  // that are not the boss outvote it. The shot counters below stay the fight's:
  // a shot has nothing to attribute to once it has left the muzzle.
  const rep = attackTraceReport(e ?? null);
  bodyEl.appendChild(heading(
    `${e ? `${e.type.toUpperCase()} — ` : ''}${rep.clock.toFixed(0)}s OF FIGHT`));
  const t = rep.tally;
  bodyEl.appendChild(line('runs', `${t.winds} wind-ups → ${t.commits} committed`
    + (t.reaimAborts ? `, ${t.reaimAborts} dropped mid-plan` : '')));
  bodyEl.appendChild(line('bites', `${t.bitesFired} snapped → ${t.bitesBilled} billed`,
    t.bitesFired > 0 && t.bitesBilled === 0 ? C.bad : C.text));
  if (t.shotsFired) {
    bodyEl.appendChild(line('shots', `${t.shotsFired} fired → ${t.shotsHitPlayer} hit you, `
      + `${t.shotsKilled} shot down, ${t.shotsLeft} left the arena, ${t.shotsExpired} ran out of fuse`,
      t.shotsExpired > t.shotsHitPlayer ? C.bad : C.text));
  }
  if (attackStudy.noDamage) {
    bodyEl.appendChild(el('div', `color:${C.warn};`,
      'no damage is on — a billed bite is counted, the seal just does not wear it'));
  }

  bodyEl.appendChild(heading('WHAT HELD IT UP'));
  if (!rep.gates.length) {
    bodyEl.appendChild(el('div', `color:${C.dim};`, 'nothing recorded yet'));
  } else {
    for (const g of rep.gates) {
      const row = el('div', 'display:flex;gap:8px;align-items:baseline;');
      row.append(
        el('div', `flex:0 0 66px;color:${g.gate === 'open' ? C.ok : C.text};`, g.gate),
        el('div', `flex:0 0 42px;text-align:right;color:${C.text};`, `${Math.round(g.share * 100)}%`),
        el('div', `flex:1 1 auto;color:${C.dim};font-size:10px;`, GATE_WHY[g.gate] ?? ''),
      );
      bodyEl.appendChild(row);
    }
  }

  bodyEl.appendChild(heading('LOG'));
  // `flex:0 0 auto` is not decoration. The body is a scrolling flex COLUMN, so
  // every child is shrinkable by default — and this is the only child with an
  // internal overflow, so it is the only one with somewhere to shrink TO. With
  // twenty rows above it the flex solver crushed it to zero height and the log
  // rendered as a heading with nothing under it, which reads exactly like the
  // ledger not recording anything.
  const log = el('div', 'flex:0 0 auto;font-size:10px;line-height:1.5;max-height:170px;overflow:auto;');
  for (const ev of rep.events.slice(-24).reverse()) {
    const row = el('div', `color:${ev.kind === 'bite' ? C.warn : ev.kind === 'run' ? C.text : C.dim};`);
    row.textContent = `${ev.t.toFixed(1)}s  ${ev.text}${ev.extra ? `  ${brief(ev.extra)}` : ''}`;
    log.appendChild(row);
  }
  bodyEl.appendChild(log);

  // --- the numbers ---------------------------------------------------------
  bodyEl.appendChild(heading('NUMBERS — LIVE ONLY, NOT SAVED'));
  const rows = sliderRows(e?.type);
  for (const [path, label, min, max] of rows) {
    const s = slider(path, label, min, max);
    if (s) bodyEl.appendChild(s);
  }

  const foot = el('div', 'display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;');
  foot.append(
    button(`Copy ${touched.size} row${touched.size === 1 ? '' : 's'}`, () => {
      if (!touched.size) { status = 'nothing moved yet'; return; }
      // The lines as behaviour.csv wants them, so the edit is a paste rather
      // than a transcription. Value only — the min, max and notes columns are
      // the existing row's and must not be clobbered by a number typed here.
      const text = [...touched].map(([p, v]) => `${p},${Number(v.toFixed(4))}`).join('\n');
      navigator.clipboard?.writeText(text);
      status = `copied ${touched.size} — paste the value into behaviour.csv with npm run csv`;
    }),
    button('Revert', () => {
      // NOT a reload: the panel cannot know what config.js declared, only what
      // it found when the slider was built. Which is enough — it is the value
      // the fight started with, and that is what "put it back" means here.
      for (const [p, v] of original) write(p, v);
      touched.clear();
      status = 'live edits reverted to what the page booted with';
    }),
  );
  bodyEl.appendChild(foot);
  bodyEl.appendChild(el('div', `color:${C.dim};font-size:10px;`,
    'Every row here is owned by behaviour.csv, which is stripped from the tuning '
    + 'snapshot both ways — so a drag lasts until the page reloads and is never saved. '
    + 'Settle on a number, copy the rows, paste into behaviour.csv.'));
}

function deg(rad) {
  return Math.round((rad * 180) / Math.PI);
}

function brief(extra) {
  return Object.entries(extra)
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => `${k} ${typeof v === 'number' ? fmt(v) : v}`)
    .join(' · ');
}

function distanceToSeal(e) {
  const p = player.mesh?.position;
  if (!p) return Infinity;
  return Math.hypot(e.mesh.position.x - p.x, e.mesh.position.y - p.y);
}

// The same expression onPlayerBite measures with, and it has to stay the same
// expression: a panel that drew its own idea of the reach would be the one
// instrument in the game capable of certifying a bug as fixed while it is not.
function biteReach(e) {
  const pr = player.stats?.hitRadius ?? 0.5;
  return (e.radius ?? 1) * (CONFIG.bite?.mouthReach ?? 0.55) + pr;
}
