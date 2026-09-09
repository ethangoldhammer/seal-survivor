// ---------------------------------------------------------------------------
// REPLAY LAB — the goal replay's camera pool, live
//
//   npm run looks:replaylab   then open http://localhost:4718/tools/looks/replay-lab.html
//
// The replay is filmed by a pool of virtual cameras and a director that scores
// every one of them each frame and cuts or blends to the best angle on the
// action (systems/replayCams.js). Every one of those shots is a handful of
// numbers in config.js — where it sits round the play, what it frames and how
// much each thing counts, its lens and its slow push-in, which beats it may
// serve and how long it may hold — and until this page there was no way to see
// one without playing a match to a goal and watching six seconds go past.
//
// SO IT STAGES A GOAL. A dash into the ball, the flight, the bang, on a canned
// buffer in the recorder's own frame shape, looped. What films it is the
// SHIPPING path, top to bottom: stageReplay hands the buffer to versus.js, and
// poseReplay poses the ball and both seals, gatherPois reads the points of
// interest off them, updatePool scores the shots and cuts between them, and
// replayRenderCamera hands back the camera and writes the lens for the
// composite. The only thing the lab supplies is what a match would have — the
// recorder, and the phase machine that decides a replay is due.
//
// WHY A PAGE AND NOT THE GAME. There is exactly one dev server in this project
// and it is the sole writer of path/src/imported-tuning.json; a second one is a
// second game quietly flattening real tuning work. This is a static BUILD of
// the shipped modules with no save path into the tuning file anywhere in it —
// `W` writes tools/looks/replay-lab.json, and "write to config.js" splices the
// numbers into the game through applyFeel, which CLEARS the snapshot's copies
// rather than adding to them. See SERVERS.md.
//
// ONLY WHAT YOU MOVED IS WRITTEN. The panel renders every field of every shot
// resolved — `dolly: 0` on a shot that never declared one — and a resolved
// value is not a declared one. Writing them all would bury seven hand-authored
// shots in defaults nobody chose. A row you drag gets a dot beside it and
// joins the write set; nothing else does.
//
// WHAT IT CANNOT DO: add a shot. A new entry in the pool is a hand edit in
// config.js — the splice writes fields into blocks that are already there. Add
// it, reload, and it appears here with the rest.
// ---------------------------------------------------------------------------
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets } from '../../path/src/assets.js';
import { createWorld } from '../../path/src/world.js';
import { createPost } from '../../path/src/systems/post.js';
import { enableVersus } from '../../path/src/systems/versusFlag.js';
import { bounds } from '../../path/src/arena.js';
import { tickGoalGlow } from '../../path/src/systems/wallRocks.js';
import { rockX, mouthY, mouthHalfHeight, installGoalHoles } from '../../path/src/systems/versusGoal.js';
import { buildSealBody, player } from '../../path/src/entities/player.js';
import { initParticles, updateParticles, updateParticleScale } from '../../path/src/entities/particles.js';
import {
  ball, p2, initBallAlone, renderBall, replayState, replayRenderCamera,
  makeReplayFrame, stageReplay, stepStagedReplay, seekStagedReplay,
} from '../../path/src/systems/versus.js';
import { poolState, resetPool } from '../../path/src/systems/replayCams.js';

const q = new URLSearchParams(location.search);
const shotListEl = document.getElementById('shotList');
const shotPanelEl = document.getElementById('shotPanel');
const restEl = document.getElementById('rest');
const valsEl = document.getElementById('vals');
const noteEl = document.getElementById('note');
const beatsEl = document.getElementById('beats');
const cutmarksEl = document.getElementById('cutmarks');
const scrubEl = document.getElementById('scrub');
const clockEl = document.getElementById('clock');
const liveEl = document.getElementById('live');
const b = (id) => document.getElementById(id);

const camsCfg = () => CONFIG.versus.replay.cams;
const shotsOf = () => allShots ?? camsCfg().shots ?? [];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, c, t) => a + (c - a) * t;

let note = '';

// --- the staging ------------------------------------------------------------
// The goal the lab replays, as numbers rather than a recording: where the ball
// was struck from, how long the flight took, which mouth it went into. These
// are the LAB's and are never written anywhere — they describe the test, not
// the game.
const lab = {
  side: -1,        // which mouth: -1 left, +1 right
  range: 42,       // world units from the strike to the mouth
  angle: 16,       // degrees the strike's line sits off the horizontal
  flight: 1.3,     // recorded seconds from the touch to the goal
  approach: 34,    // how fast the striker comes in, u/s
  drift: 6,        // the ball's speed before it is struck
  defender: 12,    // how far off its own line the beaten defender sits
};
const LAB_ROWS = [
  ['range', 'strike from (units)', 12, 90, 1],
  ['angle', 'strike angle (deg)', -60, 60, 1],
  ['flight', 'flight (rec. seconds)', 0.3, 4, 0.05],
  ['approach', 'striker speed u/s', 8, 70, 1],
  ['drift', 'ball drift u/s', 0, 30, 0.5],
  ['defender', 'defender off its line', 2, 40, 1],
];

// --- what "write to config.js" may write ------------------------------------
// Full CONFIG paths, exactly as applyFeel wants them — it walks `shots.3` as
// the fourth element of the shots array, so a per-shot row is a path like any
// other. `moved` is the write set: a row joins it when it is dragged.
const P = 'versus.replay.cams';
const moved = new Set();
let dirty = false;

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
  o[ks[ks.length - 1]] = v;
}

// Every field of a shot the panel offers, with the default the director uses
// when the shot does not declare it — so a slider opens where the shot
// actually behaves rather than at zero. `null` means "the shot's own fov".
const SHOT_ROWS = [
  ['yaw', 'yaw toward goal', -90, 90, 1, 0],
  ['pitch', 'pitch above', -60, 70, 1, 0],
  ['distance', 'distance', 4, 90, 0.5, 30],
  ['dolly', 'dolly per second', -12, 12, 0.25, 0],
  ['fov', 'fov', 12, 80, 0.5, 40],
  ['push', 'pushes in to fov', 12, 80, 0.5, null],
  ['pushTime', 'push over (s)', 0.3, 8, 0.1, 3],
  ['priority', 'priority', -2, 3, 0.05, 0],
];
const HOLD_ROWS = [
  [0, 'hold at least (s)', 0, 4, 0.05, 0.6],
  [1, 'hold at most (s)', 0.2, 8, 0.05, 2.2],
];
const LENS_ROWS = [
  ['defocus', 'defocus', 0, 1, 0.02],
  ['focusRadius', 'sharp radius', 0.03, 0.7, 0.01],
  ['focusFeather', 'feather', 0.02, 1, 0.01],
];
const POIS = ['ball', 'striker', 'strikerFace', 'scorer', 'scorerFace', 'defender', 'mouth', 'impact'];
const BEATS = ['impact', 'wide', 'explosion'];

const POOL_ROWS = [
  ['pool.margin', 'keeps frame within', 0, 2, 0.01],
  ['pool.offBeat', 'cost of a wrong beat', 0, 10, 0.1],
  ['pool.fatigue', 'fatigue per s over', 0, 3, 0.05],
  ['pool.cooldown', 'fresh again after (s)', 0, 8, 0.1],
  ['pool.recentPenalty', 'cost of being recent', 0, 4, 0.05],
  ['pool.cutAngle', 'cut past (deg)', 0, 90, 1],
  ['pool.cutDistance', 'cut past (units)', 0, 80, 1],
  ['pool.blend', 'blend takes (s)', 0.05, 2, 0.05],
  ['pool.edgePenalty', 'cost per target out', 0, 8, 0.1],
  ['pool.lensFade', 'lens eases in (s)', 0.05, 2, 0.05],
];
const SEAM_ROWS = [
  ['noseLength', 'face is this far out', 0.5, 6, 0.1],
  ['mouthInset', 'mouth target inset', 0, 8, 0.25],
  ['wallInset', 'camera inside walls', 0, 10, 0.25],
  ['floorInset', 'camera above sand', 0, 10, 0.25],
  ['nearWall', 'flattens from (units)', 4, 60, 1],
  ['nearWallMin', 'flat by (units)', 0, 30, 0.5],
  ['pitchAtWall', 'pitch kept at wall', 0, 1, 0.02],
  ['pastFace', 'frame may reach past', 0, 10, 0.25],
  ['fovMin', 'never below fov', 6, 40, 0.5],
];
// The replay's own clock — not the pool's, but it decides how long each beat
// lasts and therefore which shots ever get a turn.
const CLOCK_ROWS = [
  ['versus.replay.lead', 'opens before touch (s)', 0.1, 3, 0.05],
  ['versus.replay.impactHold', 'impact beat holds (s)', 0, 2, 0.02],
  ['versus.replay.speed', 'plays back at x', 0.1, 1, 0.01],
  ['versus.replay.maxWall', 'fits in (wall s)', 1, 12, 0.25],
  ['versus.replay.explode', 'explosion holds (s)', 0.2, 5, 0.05],
];

// --- the world --------------------------------------------------------------
//
// THE STAGE IS THE FRAME, and the panel does not sit on top of it. The page's
// first hour was spent looking at empty water: the canvas filled the window,
// the panel floated over its left third, and every shot the pool was framing —
// the ball, the striker, the goal mouth at the far wall — was behind it.
//
// So the world is told the window is the RECTANGLE BESIDE the panel and above
// the timeline. world.resize sizes its frustum, its bounds and its shore off
// window.innerWidth/innerHeight and nothing else, so those are what has to
// move; the real size is read off documentElement, which is not overridden.
// The pool then composes for the aspect you are actually looking at, which is
// the whole point of a page for judging framing.
//
// (A hidden Browser pane reports 0x0 for both — a NaN aspect and a frame that
// clears to white — so both fall back to a 16:9 desk window, the way
// tools/looks/versus-goal.js pins one and for the same reason.)
const PANEL_W = 352;   // the panel's box, plus its gutter
const BELOW_H = 104;   // the timeline and the hint line under the frame
let STAGE_W = 1280 - PANEL_W;
let STAGE_H = 720 - BELOW_H;
for (const [k, get] of [['innerWidth', () => STAGE_W], ['innerHeight', () => STAGE_H]]) {
  try { Object.defineProperty(window, k, { configurable: true, get }); } catch { /* a real browser may refuse */ }
}
function stageSize() {
  const dw = document.documentElement?.clientWidth || 0;
  const dh = document.documentElement?.clientHeight || 0;
  const w = dw > 1 ? dw : 1280;
  const h = dh > 1 ? dh : 720;
  return { w: Math.max(320, w - PANEL_W), h: Math.max(240, h - BELOW_H) };
}

await preloadAssets().catch((e) => { note = `preload: ${e?.message ?? e}`; });

document.getElementById('stage')?.remove();
const container = document.createElement('div');
container.style.cssText = `position:fixed; left:${PANEL_W}px; top:0; z-index:1; overflow:hidden;`;
document.body.insertBefore(container, document.body.firstChild);
const world = createWorld(container);
enableVersus(true);
// BEFORE the resize, and that order is the whole difference between a pitch
// with goals in it and a flat wall. world.resize is what builds the shore, and
// the shore carves its mouths from the holes this installs; startVersus does
// the same two things in the same order for a match. Without it the lab framed
// a plain wall with the pool's seam rules aimed at nothing.
installGoalHoles(true);
const gl = world.renderer;
gl.domElement.style.cssText = 'display:block; width:100%; height:100%;';
const post = createPost(gl);

// BEFORE the first resize, which calls post.resize(): the goo pass sizes
// itself off a particle system that has to exist by then, and a resize with
// none throws from inside three.js on a uniform that was never made.
initParticles(world.scene);
initBallAlone();
buildSealBody(player, world.scene, { name: 'seal' });
buildSealBody(p2, world.scene, { name: 'player2', celebrateTag: 'p2' });

let sizedW = 0;
let sizedH = 0;
function resize() {
  const { w, h } = stageSize();
  if (w === sizedW && h === sizedH) return;
  sizedW = w; sizedH = h;
  STAGE_W = w; STAGE_H = h;
  container.style.width = `${w}px`;
  container.style.height = `${h}px`;
  world.resize();
  // updateStyle false: the canvas fills the container by CSS, and writing its
  // style here would fight that.
  gl.setSize(w, h, false);
  post.resize();
  replayState.aspect = w / h;
}
resize();

// --- the canned goal ---------------------------------------------------------
//
// A buffer in the recorder's frame shape, which is what stageReplay wants: the
// ball, both seals and the soft body's rim, sampled at the rate a match records
// at. The shot is described by where it was struck FROM (a range and an angle
// off the mouth) rather than by two absolute points, so one set of numbers
// stages the same goal at either end of the pitch.
//
// The rim is left flat. A dent is a fifth of a second of the ball's skin and
// nothing in the camera pool can see it; staging one would be detail for its
// own sake.
const REC_HZ = 90;
let staged = { touchT: 0, goalT: 0, span: 1 };

function stageGoal() {
  clearSolo();
  const side = lab.side;
  const lead = CONFIG.versus.replay.lead ?? 0.9;
  const touchT = Math.max(0.2, lead);
  const goalT = touchT + lab.flight;
  const gy = mouthY();
  const gx = rockX(side) - side * 0.5;             // just short of the face
  // The strike's line, pointing at the mouth. `angle` swings it off the
  // horizontal, positive meaning the ball comes down at the goal.
  const a = lab.angle * Math.PI / 180;
  const ux = -side * Math.cos(a);
  const uy = -Math.sin(a);
  const px = clamp(gx - ux * lab.range, bounds.left + 6, bounds.right - 6);
  const py = clamp(gy - uy * lab.range, bounds.bottom + 6, (bounds.top ?? 10) - 4);
  const flightLen = Math.hypot(gx - px, gy - py);
  const flightSpeed = flightLen / Math.max(0.05, lab.flight);
  const contact = (CONFIG.versus.ball.contactRadius ?? 2.2) + (ball.r ?? 2.4);
  const top = (bounds.top ?? 10);

  const frames = [];
  const n = Math.max(4, Math.round(goalT * REC_HZ));
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * goalT;
    const f = makeReplayFrame();
    f.t = t;
    if (t <= touchT) {
      // Before the touch: the ball drifting in toward the point of impact.
      const back = (touchT - t) * lab.drift;
      f.bx = px - ux * back;
      f.by = py - uy * back;
      f.bvx = ux * lab.drift;
      f.bvy = uy * lab.drift;
    } else {
      const u = (t - touchT) / Math.max(1e-6, goalT - touchT);
      // The flight, with a little lift on it so it is an arc rather than a
      // ruled line — the wide shots are framing a curve in play.
      f.bx = lerp(px, gx, u);
      f.by = lerp(py, gy, u) + Math.sin(u * Math.PI) * flightLen * 0.06;
      f.bvx = ux * flightSpeed;
      f.bvy = uy * flightSpeed;
    }
    f.bang = t * 4;
    f.bspin = t > touchT ? 4 : 0.5;
    // THE STRIKER — behind the ball on the strike's own line, arriving on it at
    // the touch and following through after it.
    const toTouch = touchT - t;
    const behind = toTouch > 0 ? contact + toTouch * lab.approach : contact - (t - touchT) * lab.approach * 0.35;
    const s0 = f.seals[0];
    s0.x = clamp(px - ux * behind, bounds.left + 2, bounds.right - 2);
    s0.y = clamp(py - uy * behind, bounds.bottom + 2, top - 1);
    s0.rz = Math.atan2(uy, ux) - Math.PI / 2;
    s0.vis = true;
    // THE DEFENDER — beaten, off its own line, crossing.
    const s1 = f.seals[1];
    s1.x = clamp(gx + side * lab.defender, bounds.left + 2, bounds.right - 2);
    s1.y = clamp(gy + mouthHalfHeight() * 1.2 + Math.sin(t * 1.6) * 4, bounds.bottom + 2, top - 1);
    s1.rz = Math.atan2(-1, side) - Math.PI / 2;
    s1.vis = true;
    frames.push(f);
  }
  staged = { touchT, goalT, span: goalT + (CONFIG.versus.replay.explode ?? 1.3) };
  stageReplay({ frames, touchT, goalT, side, who: 0, scorer: 0, aspect: replayState.aspect });
  cuts.length = 0;
  lastShot = -1;
  paintBeats();
  paintCuts();
}

// --- solo --------------------------------------------------------------------
//
// The pool is handed a one-shot array holding a COPY of the chosen shot with
// its beats opened up, so it plays the whole replay through and there is
// something to judge at every point of the scrub. A copy, rebuilt each frame
// off the live object: the sliders write the real shot, and handing the pool
// the real object with `beats` overwritten would edit the thing being tuned.
//
// THE SWAP STAYS UP for as long as solo does. Putting it back at the end of
// every step looked tidier and quietly broke the feature: the pool is sized on
// its shots, so restoring seven and then swapping back to one reset the
// director twice a frame, and `onShot` never got past a frame. The camera was
// still posed correctly — so the page LOOKED right — while the push-in, the
// dolly, the hold and the fatigue, which are most of what a solo is for, never
// ran at all. Everything outside the step reads the real array through
// shotsOf(), which is what allShots is for.
//
// A swap that changes the pool's size, or the shot being soloed, resets it:
// poolState.shot is an index, and one left pointing at the sixth shot of an
// array that now holds one is the throw that takes the page down.
let allShots = null;
let soloOf = -1;
function applySolo() {
  if (!solo) return;
  const cams = camsCfg();
  const real = allShots ?? cams.shots;
  const src = real[picked];
  if (!src) return;
  allShots = real;
  cams.shots = [{ ...src, beats: null }];
  if (poolState.used.length !== 1 || soloOf !== picked) {
    soloOf = picked;
    resetPool(replayState.aspect);
  }
}
function clearSolo() {
  if (!allShots) return;
  const cams = camsCfg();
  cams.shots = allShots;
  allShots = null;
  soloOf = -1;
  if (poolState.used.length !== cams.shots.length) resetPool(replayState.aspect);
}

// --- the panel --------------------------------------------------------------
let picked = 0;
let solo = false;
const controls = [];   // every live row, for a refresh after defaults or a restage

function addRow(parent, label, min, max, step, read, write, path = null) {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  l.title = path ?? label;
  const r = document.createElement('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step;
  const o = document.createElement('output');
  const fmt = (v) => Number(v).toFixed(step < 1 ? 2 : 0);
  const show = () => {
    const v = read();
    r.value = v;
    o.textContent = fmt(v);
    if (path) row.classList.toggle('moved', moved.has(path));
  };
  r.addEventListener('input', () => {
    const v = Number(r.value);
    write(v);
    o.textContent = fmt(v);
    if (path) { moved.add(path); row.classList.add('moved'); dirty = true; }
  });
  show();
  row.append(l, r, o);
  parent.appendChild(row);
  controls.push({ show });
}

function addToggle(parent, label, read, write, path = null) {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  l.title = path ?? label;
  const c = document.createElement('input');
  c.type = 'checkbox';
  const o = document.createElement('output');
  const show = () => {
    c.checked = !!read();
    o.textContent = c.checked ? 'yes' : 'no';
    if (path) row.classList.toggle('moved', moved.has(path));
  };
  c.addEventListener('change', () => {
    write(c.checked);
    o.textContent = c.checked ? 'yes' : 'no';
    if (path) { moved.add(path); row.classList.add('moved'); dirty = true; }
  });
  show();
  row.append(l, c, o);
  parent.appendChild(row);
  controls.push({ show });
}

function head(parent, text) {
  const h = document.createElement('h2');
  h.textContent = text;
  parent.appendChild(h);
}

function buildShotList() {
  shotListEl.innerHTML = '';
  shotsOf().forEach((s, i) => {
    const btn = document.createElement('button');
    btn.textContent = `${i + 1} ${s.name ?? i}`;
    btn.dataset.shot = String(i);
    btn.addEventListener('click', () => { picked = i; buildPanel(); });
    shotListEl.appendChild(btn);
  });
}

function buildPanel() {
  controls.length = 0;
  shotPanelEl.innerHTML = '';
  const i = picked;
  const shot = shotsOf()[i];
  if (shot) {
    const base = `${P}.shots.${i}`;
    head(shotPanelEl, `${shot.name ?? i} — where it sits`);
    for (const [key, label, min, max, step, dflt] of SHOT_ROWS) {
      addRow(shotPanelEl, label, min, max, step,
        () => shot[key] ?? (dflt === null ? (shot.fov ?? 40) : dflt),
        (v) => { shot[key] = v; },
        `${base}.${key}`);
    }
    head(shotPanelEl, 'how long it may hold');
    for (const [idx, label, min, max, step, dflt] of HOLD_ROWS) {
      addRow(shotPanelEl, label, min, max, step,
        () => (shot.hold ?? [0.6, 2.2])[idx] ?? dflt,
        (v) => { shot.hold = [...(shot.hold ?? [0.6, 2.2])]; shot.hold[idx] = v; },
        `${base}.hold`);
    }
    head(shotPanelEl, 'what it frames');
    for (const name of POIS) {
      addRow(shotPanelEl, name, 0, 2, 0.05,
        () => shot.targets?.[name] ?? 0,
        (v) => { (shot.targets ??= {})[name] = v; },
        `${base}.targets.${name}`);
    }
    head(shotPanelEl, 'the lens');
    for (const [key, label, min, max, step] of LENS_ROWS) {
      addRow(shotPanelEl, label, min, max, step,
        () => shot.lens?.[key] ?? camsCfg().lens?.[key] ?? 0,
        (v) => { (shot.lens ??= {})[key] = v; },
        `${base}.lens.${key}`);
    }
    head(shotPanelEl, 'beats it may serve');
    for (const beat of BEATS) {
      addToggle(shotPanelEl, beat,
        () => !shot.beats || shot.beats.includes(beat),
        (on) => {
          const have = new Set(shot.beats ?? BEATS);
          if (on) have.add(beat); else have.delete(beat);
          shot.beats = BEATS.filter((one) => have.has(one));
        },
        `${base}.beats`);
    }
    head(shotPanelEl, 'how it is entered');
    addToggle(shotPanelEl, 'always a cut', () => shot.cut === true, (v) => { shot.cut = v; }, `${base}.cut`);
    addToggle(shotPanelEl, 'always a blend', () => shot.blend === true, (v) => { shot.blend = v; }, `${base}.blend`);
  }

  restEl.innerHTML = '';
  head(restEl, 'the staged goal (not written)');
  for (const [key, label, min, max, step] of LAB_ROWS) {
    addRow(restEl, label, min, max, step, () => lab[key], (v) => { lab[key] = v; stageGoal(); });
  }
  head(restEl, 'the replay clock');
  for (const [path, label, min, max, step] of CLOCK_ROWS) {
    addRow(restEl, label, min, max, step,
      () => getPath(CONFIG, path) ?? 0,
      (v) => { setPath(CONFIG, path, v); stageGoal(); },
      path);
  }
  head(restEl, 'the director');
  for (const [key, label, min, max, step] of POOL_ROWS) {
    const path = `${P}.${key}`;
    addRow(restEl, label, min, max, step, () => getPath(CONFIG, path) ?? 0, (v) => setPath(CONFIG, path, v), path);
  }
  head(restEl, 'seams and reach');
  for (const [key, label, min, max, step] of SEAM_ROWS) {
    const path = `${P}.${key}`;
    addRow(restEl, label, min, max, step, () => getPath(CONFIG, path) ?? 0, (v) => setPath(CONFIG, path, v), path);
  }
}

function refresh() {
  for (const c of controls) c.show();
}

// --- the timeline ------------------------------------------------------------
// The beat bands under the scrub, so it is plain which stretch of the goal a
// shot is competing for; and a tick for every cut and blend the director makes
// on a pass, which is the one readout that says whether the pool is cutting
// too much.
const cuts = [];
let lastShot = -1;

function paintBeats() {
  const { touchT, goalT, span } = staged;
  const hold = CONFIG.versus.replay.impactHold ?? 0.2;
  const startT = replayState.startT;
  const bands = [
    ['impact', startT, Math.min(goalT, touchT + hold), '#7a4a2a'],
    ['wide', Math.min(goalT, touchT + hold), goalT, '#2a4a6a'],
    ['explosion', goalT, span, '#6a2a3a'],
  ];
  beatsEl.innerHTML = '';
  for (const [name, from, to, color] of bands) {
    if (!(to > from)) continue;
    const el = document.createElement('span');
    el.style.left = `${((from - startT) / Math.max(1e-6, span - startT)) * 100}%`;
    el.style.width = `${((to - from) / Math.max(1e-6, span - startT)) * 100}%`;
    el.style.background = color;
    el.textContent = name;
    beatsEl.appendChild(el);
  }
  scrubEl.min = String(startT);
  scrubEl.max = String(span);
  scrubEl.step = '0.005';
}

function paintCuts() {
  cutmarksEl.innerHTML = '';
  const startT = replayState.startT;
  const { span } = staged;
  for (const c of cuts) {
    const i = document.createElement('i');
    i.style.left = `${((c.at - startT) / Math.max(1e-6, span - startT)) * 100}%`;
    if (!c.cut) i.className = 'blend';
    i.title = `${c.cut ? 'cut' : 'blend'} to ${c.name}`;
    cutmarksEl.appendChild(i);
  }
}

/** Where the scrub sits: recorded time, or past the goal, into the hold. */
function timelineT() {
  return replayState.beat === 'explosion' ? staged.goalT + replayState.hold : replayState.t;
}

// --- the loop ----------------------------------------------------------------
let playing = true;
let looping = true;

function step(rawDt) {
  applySolo();
  if (playing) {
    if (!stepStagedReplay(rawDt)) {
      if (looping) { clearSolo(); stageGoal(); }
      else playing = false;
    }
  } else {
    // Paused still steps the director by a frame, so a scrub shows it choosing.
    seekStagedReplay(timelineT(), rawDt);
  }
  if (poolState.shot !== lastShot && poolState.shot >= 0) {
    lastShot = poolState.shot;
    const was = cuts.length ? cuts[cuts.length - 1].cuts : 0;
    cuts.push({ at: timelineT(), name: poolState.shotName, cut: poolState.cuts > was, cuts: poolState.cuts });
    paintCuts();
  }
}

function render(rawDt) {
  const cam = replayRenderCamera() ?? world.camera;
  updateParticleScale(cam, gl);
  // The ball is a goo group written from here, the way renderVersus writes it
  // in a match: nothing draws it if this is skipped and the frame is a goal
  // with no ball in it.
  renderBall();
  world.updateSurface(rawDt);
  tickGoalGlow(rawDt);
  updateParticles(rawDt);
  post.render(world.scene, cam, rawDt);
}

function readout() {
  const shots = shotsOf();
  const live = poolState.shot;
  const lines = [
    `beat ${replayState.beat}   t ${replayState.t.toFixed(2)} / ${staged.goalT.toFixed(2)}   cuts ${poolState.cuts} blends ${poolState.blends}`,
    `fov ${poolState.cur.fov.toFixed(1)}   dist ${poolState.cur.pos.distanceTo(poolState.cur.at).toFixed(1)}   defocus ${poolState.lens.defocus.toFixed(2)}`,
  ];
  shots.forEach((s, i) => {
    // In solo the pool holds one shot, so only its score is real; the others
    // are last full pass's and would read as a table of stale numbers.
    const sc = solo ? (i === picked ? poolState.scores[0] : null) : poolState.scores[i];
    const mark = (solo ? i === picked : i === live) ? '>' : ' ';
    lines.push(`${mark}${i + 1} ${String(s.name ?? i).padEnd(12)} ${sc == null ? '     —' : sc.toFixed(2).padStart(6)}`);
  });
  valsEl.textContent = lines.join('\n');
  clockEl.textContent = `${timelineT().toFixed(2)}s`;
  liveEl.textContent = solo
    ? `solo: ${shots[picked]?.name ?? picked}`
    : (live >= 0 ? `${poolState.shotName}  ${poolState.onShot.toFixed(2)}s on shot${poolState.blendT < 1 ? '  (blending)' : ''}` : '');
  noteEl.textContent = note + (dirty ? `\n${moved.size} row(s) moved — W saves, "write to config.js" writes` : '');
  for (const btn of shotListEl.children) {
    const i = Number(btn.dataset.shot);
    btn.classList.toggle('on', i === picked);
    btn.classList.toggle('live', !solo && i === live);
  }
  if (document.activeElement !== scrubEl) scrubEl.value = String(timelineT());
}

let lastT = performance.now();
function tick(now) {
  const rawDt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  resize();
  step(rawDt);
  render(rawDt);
  readout();
  requestAnimationFrame(tick);
}

// --- save and write ----------------------------------------------------------

/** The write set as applyFeel wants it: full CONFIG paths to values. */
function preset() {
  clearSolo();
  const out = {};
  for (const path of moved) {
    const v = getPath(CONFIG, path);
    if (v === undefined) continue;
    out[path] = v;
  }
  // DOUBLE UNDERSCORE, because applyFeel roots an un-rooted key under its first
  // root and would otherwise splice `versus.savedAt: '2026-...'` into config.js.
  // Keys starting `__` are skipped there by name.
  out.__savedAt = new Date().toISOString();
  return out;
}

async function writePreset() {
  try {
    const r = await fetch('/preset/replay-lab.json', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    note = r.ok ? `saved tools/looks/replay-lab.json ${new Date().toLocaleTimeString()}` : `save failed: ${r.status}`;
  } catch (err) {
    note = `save failed: ${err.message}`;
  }
}

async function applyToConfig() {
  if (!moved.size) { note = 'nothing moved — drag a row first'; return; }
  try {
    const r = await fetch('/apply/replay-lab', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
    const report = await r.json();
    if (report.error) { note = `apply failed: ${report.error}`; return; }
    const changed = report.changes?.length ?? 0;
    const cleared = report.cleared?.length ?? 0;
    note = (report.wrote ? `wrote config.js: ${changed} value(s)` : 'config.js already matches')
      + (cleared ? `, cleared ${cleared} shadowing tuning value(s)` : '')
      + '\n' + (report.notes ?? []).filter((n) => n.startsWith('!') || n.startsWith('?')).join('\n');
    dirty = false;
  } catch (err) {
    note = `apply failed: ${err.message}`;
  }
}

// config.js as loaded, kept so `defaults` can put everything back — a deep copy,
// because the sliders write into the shot objects in place.
const AS_LOADED = structuredClone({
  cams: camsCfg(),
  replay: Object.fromEntries(CLOCK_ROWS.map(([p]) => [p, getPath(CONFIG, p)])),
});

// The saved preset next, so the page opens on the last session's numbers rather
// than on config.js and quietly discarding them on the first drag.
try {
  const saved = await (await fetch('/preset/replay-lab.json')).json();
  let n = 0;
  for (const [path, v] of Object.entries(saved)) {
    if (!path.startsWith('versus.')) continue;
    setPath(CONFIG, path, v);
    moved.add(path);
    n++;
  }
  if (n) note = `preset loaded from tools/looks/replay-lab.json (${n} values)`;
} catch { /* no server, or nothing saved yet — the normal first run */ }

// --- controls ----------------------------------------------------------------
b('bPlay').addEventListener('click', () => {
  playing = !playing;
  b('bPlay').classList.toggle('on', playing);
  b('bPlay').textContent = playing ? 'pause' : 'play';
});
b('bLoop').addEventListener('click', () => { looping = !looping; b('bLoop').classList.toggle('on', looping); });
b('bSolo').addEventListener('click', () => { solo = !solo; b('bSolo').classList.toggle('on', solo); stageGoal(); });
b('bSide').addEventListener('click', () => {
  lab.side = -lab.side;
  b('bSide').textContent = `goal: ${lab.side < 0 ? 'left' : 'right'}`;
  stageGoal();
});
b('bRestage').addEventListener('click', () => stageGoal());
b('bSave').addEventListener('click', () => writePreset());
b('bApply').addEventListener('click', () => applyToConfig());
b('bDefaults').addEventListener('click', () => {
  clearSolo();
  const back = structuredClone(AS_LOADED.cams);
  const cams = camsCfg();
  for (const k of Object.keys(cams)) delete cams[k];
  for (const [k, v] of Object.entries(back)) cams[k] = v;
  for (const [p, v] of Object.entries(AS_LOADED.replay)) setPath(CONFIG, p, v);
  moved.clear();
  dirty = false;
  note = 'config.js as loaded (tuning included)';
  buildShotList();
  buildPanel();
  stageGoal();
});
scrubEl.addEventListener('input', () => {
  playing = false;
  b('bPlay').classList.remove('on');
  b('bPlay').textContent = 'play';
  seekStagedReplay(Number(scrubEl.value));
});
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key;
  if (e.code === 'Space') { e.preventDefault(); b('bPlay').click(); }
  else if (k === 'r' || k === 'R') stageGoal();
  else if (k === 's' || k === 'S') b('bSolo').click();
  else if (k === 'd' || k === 'D') b('bSide').click();
  else if (k === 'W') writePreset();
  else if (k === '[') { playing = false; seekStagedReplay(timelineT() - 1 / 30); }
  else if (k === ']') { playing = false; seekStagedReplay(timelineT() + 1 / 30); }
  else if (/^[1-9]$/.test(k)) {
    const i = Number(k) - 1;
    if (i < shotsOf().length) { picked = i; buildPanel(); }
  }
});
window.addEventListener('error', (e) => { note = `error: ${e.message}`; });
window.addEventListener('unhandledrejection', (e) => { note = `rejection: ${e.reason?.message ?? e.reason}`; });

b('bPlay').classList.add('on');
b('bPlay').textContent = 'pause';
b('bLoop').classList.add('on');
buildShotList();
buildPanel();
stageGoal();
refresh();
requestAnimationFrame(tick);

// --- the harness's handles ----------------------------------------------------
window.__pool = poolState;
window.__replay = replayState;
window.__world = world;
window.__seals = [player, p2];
window.__ball = ball;
window.__stage = stageGoal;
window.__seek = (t) => { playing = false; seekStagedReplay(t); };
window.__pick = (i) => { picked = i; buildPanel(); };
window.__solo = (on) => { solo = on; b('bSolo').classList.toggle('on', solo); stageGoal(); };
window.__preset = preset;
window.__step = (n = 1) => { for (let i = 0; i < n; i++) { step(1 / 60); render(1 / 60); } readout(); };
async function shoot(name) {
  render(1 / 60);
  const blob = await new Promise((res) => gl.domElement.toBlob(res, 'image/png'));
  await fetch(`/shot/${name}.png`, { method: 'POST', body: blob });
}
window.__shoot = shoot;

// `?shots` posts one frame per shot, each soloed at the middle of a beat it
// serves — the contact sheet of the pool, for reading without a live pane.
if (q.has('shots')) {
  for (let i = 0; i < 200; i++) {
    if (gl.domElement.width >= 8) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  playing = false;
  const all = [...shotsOf()];
  for (let i = 0; i < all.length; i++) {
    picked = i;
    solo = true;
    stageGoal();
    const beat = (all[i].beats ?? BEATS)[0];
    const at = beat === 'impact' ? staged.touchT + 0.05
      : beat === 'wide' ? (staged.touchT + staged.goalT) / 2
        : staged.goalT + 0.3;
    for (let f = 0; f < 30; f++) step(1 / 60);
    seekStagedReplay(at, 1 / 60);
    for (let f = 0; f < 10; f++) step(1 / 60);
    await shoot(`${String(i).padStart(2, '0')}-${all[i].name ?? i}`);
  }
  solo = false;
  clearSolo();
  note = 'shots posted';
}
