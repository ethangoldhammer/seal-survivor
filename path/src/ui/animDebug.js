import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { player } from '../entities/player.js';
import { LOCOMOTION_STATES, ONESHOT_STATES, trackCoverage } from '../systems/animation.js';
import { celebrationState, celebrationSpin, snapshotMoment } from '../systems/celebrate.js';
import { sealTeamAnimDebug } from '../systems/sealTeam.js';
import { isTypingTarget } from './typing.js';

// ---------------------------------------------------------------------------
// THE STATE MACHINE, LIVE — press J.
//
// systems/animation.js is a real state machine with no face. It decides, every
// frame and silently, which of five locomotion states the creature is in,
// whether a one-shot has taken the pose away from them and how much of its
// budget is left, whether the clip is running backwards, and whether it has
// been stretched to the music. All of that is invisible from outside, so the
// only way to answer "why is the seal doing that" has been to add a console
// log to a file every creature in the game shares.
//
// So this reads the machine out rather than driving it. Nothing here can pose
// a bone or fire a state — it is a window, not a controller — which is the
// point: a debug panel that can also change the thing it measures gives you
// two explanations for every surprise.
//
// THE FOURTH BLOCK IS THE ONE THAT EARNED THIS PANEL. "Bone ownership" answers
// whether the clip will put a bone back after something else poses it, and it
// is the question behind the worst class of bug this rig produces — a pose
// that never releases, drifting a little further out every time it plays. It
// cost a long afternoon to find by measurement (see systems/celebrate.js); it
// is two columns here, and it is wrong-looking at a glance.
//
// DEV ONLY, wired behind DEV_UI in main.js with the rest of the panels.
//
// It takes the LEFT edge, opposite the ` tuner, so the panel you actually want
// open beside it — the one with the celebration odds and the animation lengths
// on it — is never covered. It does overlap the U panel, which is fine: you
// use that one to spawn a boss and then close it.
// ---------------------------------------------------------------------------

const C = {
  dim: 'rgba(232,236,243,0.45)',
  text: 'rgba(232,236,243,0.88)',
  ok: '#7ee081',
  warn: '#ffc861',
  bad: '#ff8fb1',
  off: 'rgba(232,236,243,0.22)',
  accent: '#7ad7ff',
};

let panel = null;
let visible = false;
let raf = 0;
const el = {};
// Bone ownership is a property of the MODEL, not of the frame, so it is read
// once per body rather than 60 times a second. Keyed on the instance because
// rebuildShipBody swaps the whole seal on a size change.
let coverageFor = null;
let coverage = null;

function box(parent, title) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:7px 10px;border-bottom:1px solid rgba(232,236,243,0.1);';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = `color:${C.dim};letter-spacing:0.14em;font-size:9px;margin-bottom:5px;`;
  wrap.appendChild(h);
  const body = document.createElement('div');
  wrap.appendChild(body);
  parent.appendChild(wrap);
  return body;
}

function chipRow(parent) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
  parent.appendChild(row);
  return row;
}

function chip(parent, label) {
  const c = document.createElement('span');
  c.textContent = label;
  c.style.cssText = 'padding:2px 6px;border-radius:4px;font-size:10px;'
    + `border:1px solid rgba(232,236,243,0.14);color:${C.off};`;
  parent.appendChild(c);
  return c;
}

function line(parent) {
  const d = document.createElement('div');
  d.style.cssText = `color:${C.text};font-size:10px;line-height:1.6;`;
  parent.appendChild(d);
  return d;
}

export function initAnimDebug() {
  panel = document.createElement('div');
  panel.id = 'svAnimDebug';
  panel.style.cssText =
    'position:fixed;left:12px;top:12px;width:min(360px,34vw);max-height:calc(100vh - 24px);'
    + 'z-index:33;display:none;flex-direction:column;border-radius:10px;overflow:auto;'
    + 'background:rgba(5,6,10,0.94);border:1px solid rgba(232,236,243,0.16);'
    + `color:${C.text};font:500 11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;`;

  const head = document.createElement('div');
  head.textContent = 'ANIMATION STATE MACHINE';
  head.style.cssText = 'padding:8px 10px;border-bottom:1px solid rgba(232,236,243,0.12);'
    + `background:rgba(232,236,243,0.04);letter-spacing:0.14em;font-size:10px;color:${C.accent};`;
  panel.appendChild(head);

  // --- locomotion + one-shot -------------------------------------------
  const machine = box(panel, 'PLAYER — LOCOMOTION');
  el.locoChips = {};
  const lr = chipRow(machine);
  for (const s of LOCOMOTION_STATES) el.locoChips[s] = chip(lr, s);
  el.locoNote = line(machine);
  // The surface-rest ramp. Worth its own line because `surfaceIdle` is the one
  // state you cannot reach by holding a direction — it needs the seal parked at
  // the waterline for CONFIG.surfaceRest.settleTime, and without a readout
  // "why isn't it relaxing" has no answer short of a console log.
  el.restNote = line(machine);

  const shot = box(panel, 'ONE-SHOT IN FLIGHT');
  el.shotChips = {};
  const sr = chipRow(shot);
  for (const s of ONESHOT_STATES) el.shotChips[s] = chip(sr, s);
  el.shotNote = line(shot);

  // --- the celebration --------------------------------------------------
  const celeb = box(panel, 'VICTORY LAP');
  el.celebNote = line(celeb);
  // The timeline is the whole reason this block is here: it shows the pose's
  // peak against the frame the trophy is actually taken on, which is the one
  // relationship that decides whether a celebration is ever SEEN in a picture.
  el.celebBar = document.createElement('div');
  el.celebBar.style.cssText = 'position:relative;height:16px;margin:5px 0 3px;border-radius:3px;'
    + 'background:rgba(232,236,243,0.07);overflow:hidden;';
  el.celebFill = document.createElement('div');
  el.celebFill.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:0;background:${C.accent};opacity:0.32;`;
  el.celebPeak = document.createElement('div');
  el.celebPeak.style.cssText = `position:absolute;top:0;bottom:0;width:2px;background:${C.ok};`;
  el.celebShutter = document.createElement('div');
  el.celebShutter.style.cssText = `position:absolute;top:0;bottom:0;width:2px;background:${C.warn};`;
  el.celebBar.append(el.celebFill, el.celebPeak, el.celebShutter);
  celeb.appendChild(el.celebBar);
  el.celebLegend = line(celeb);
  el.celebLegend.innerHTML =
    `<span style="color:${C.ok}">|</span> peak &nbsp; `
    + `<span style="color:${C.warn}">|</span> trophy frame`;

  // --- clip coverage ----------------------------------------------------
  const cov = box(panel, 'CLIP COVERAGE — PLAYER MODEL');
  el.covChips = {};
  const cr = chipRow(cov);
  for (const s of [...LOCOMOTION_STATES, ...ONESHOT_STATES]) el.covChips[s] = chip(cr, s);
  el.covNote = line(cov);

  // --- bone ownership ---------------------------------------------------
  const bones = box(panel, 'BONE OWNERSHIP — WILL THE CLIP PUT IT BACK?');
  el.boneNote = line(bones);
  el.boneList = document.createElement('div');
  el.boneList.style.cssText = 'font-size:10px;line-height:1.5;margin-top:4px;';
  bones.appendChild(el.boneList);

  // --- escorts ----------------------------------------------------------
  const team = box(panel, 'SEAL TEAM');
  el.teamNote = line(team);

  document.body.appendChild(panel);

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target) || e.repeat) return;
    if (e.key?.toLowerCase() !== 'j') return;
    visible = !visible;
    panel.style.display = visible ? 'flex' : 'none';
    // The loop only runs while the panel is up — this reads the whole skeleton
    // and has no business costing anything in a run nobody is debugging.
    if (visible) tick();
    else cancelAnimationFrame(raf);
  });
}

function setChip(c, on, colour = C.ok) {
  c.style.color = on ? colour : C.off;
  c.style.borderColor = on ? colour : 'rgba(232,236,243,0.14)';
  c.style.background = on ? 'rgba(232,236,243,0.06)' : 'transparent';
}

function renderBones(body) {
  if (coverageFor !== body) {
    coverageFor = body;
    coverage = body ? trackCoverage(body) : null;
    el.boneList.innerHTML = '';
    if (!coverage || coverage.size === 0) {
      el.boneList.textContent = '(no clips on this model — nothing is owned)';
      return;
    }
    // The at-risk ones first and named; a full skeleton is 28 rows of mostly
    // "fine", and the whole value here is the short list of exceptions.
    const risky = [...coverage.entries()].filter(([, v]) => !v.owned);
    for (const [name, v] of risky) {
      const worst = Object.entries(v.keys).sort((a, b) => a[1] - b[1])[0];
      const why = worst
        ? (worst[1] === 0 ? `unkeyed in ${worst[0]}` : `constant in ${worst[0]}`)
        : 'no locomotion clips';
      const d = document.createElement('div');
      d.innerHTML = `<span style="color:${C.bad}">✕</span> `
        + `<span style="color:${C.text}">${name}</span> `
        + `<span style="color:${C.dim}">${why}</span>`;
      el.boneList.appendChild(d);
    }
    const okCount = coverage.size - risky.length;
    const foot = document.createElement('div');
    foot.style.cssText = `color:${C.dim};margin-top:4px;`;
    foot.textContent = `${okCount} of ${coverage.size} bones are mixer-owned and release on their own.`;
    el.boneList.appendChild(foot);
  }
}

function tick() {
  raf = requestAnimationFrame(tick);
  const anim = player.anim;
  const body = player.body;

  if (!anim) {
    el.locoNote.textContent = 'no animation controller on the player';
    return;
  }
  const s = anim.debugState();

  for (const st of LOCOMOTION_STATES) setChip(el.locoChips[st], st === s.locomotion, C.accent);
  const dir = s.playbackDir < 0 ? 'REVERSED' : 'forward';
  const beat = s.beatSyncBeats > 0 ? `, beat-synced to ${s.beatSyncBeats} beats` : '';
  const clip = s.clipLength > 0 ? ` — clip ${s.clipTime.toFixed(2)}/${s.clipLength.toFixed(2)}s` : '';
  el.locoNote.innerHTML = `<span style="color:${C.dim}">showing</span> ${s.showing ?? '—'} `
    + `<span style="color:${C.dim}">(${dir}${beat})</span>${clip}`;

  // Why the seal is (or is not) relaxing at the surface — the three conditions
  // spelled out, so a failing one names itself instead of leaving you guessing.
  {
    const c = CONFIG.surfaceRest ?? {};
    const speed = player.velocity?.length?.() ?? 0;
    const nearSurface = (player.mesh?.position.y ?? -99) > bounds.surfaceY - (c.band ?? 1.3);
    const settled = speed < (c.speed ?? 2.4);
    const rest = player.surfaceRest ?? 0;
    const bar = '█'.repeat(Math.round(rest * 10)).padEnd(10, '·');
    const tick = (ok, label) => `<span style="color:${ok ? C.ok : C.off}">${ok ? '✓' : '✗'} ${label}</span>`;
    el.restNote.innerHTML = `<span style="color:${C.dim}">surface rest</span> `
      + `<span style="color:${rest > 0.5 ? C.ok : C.dim}">${bar}</span> ${(rest * 100).toFixed(0)}%  `
      + `${tick(nearSurface, 'at surface')} ${tick(settled, `slow (${speed.toFixed(1)})`)} `
      + `${tick(player.surfaceRestTimer >= (c.settleTime ?? 0.7), `held ${(player.surfaceRestTimer ?? 0).toFixed(1)}s`)}`;
  }

  for (const st of ONESHOT_STATES) {
    setChip(el.shotChips[st], s.oneShot?.state === st, C.warn);
  }
  el.shotNote.innerHTML = s.oneShot
    ? `<span style="color:${C.warn}">${s.oneShot.state}</span> holding the pose — `
      + `${s.oneShot.timeLeft.toFixed(2)}s left, priority ${s.oneShot.priority}`
    : `<span style="color:${C.dim}">none — locomotion owns the pose</span>`
      + (s.hitTimer > 0 ? `  <span style="color:${C.warn}">flinch ${s.hitTimer.toFixed(2)}s</span>` : '');

  // --- the celebration ---
  const shutter = snapshotMoment();
  const dur = celebrationState.duration || (shutter + 0.85);
  const pct = (t) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
  el.celebPeak.style.left = pct(celebrationState.peakAt || shutter);
  el.celebShutter.style.left = pct(shutter);
  if (celebrationState.active) {
    el.celebFill.style.width = pct(celebrationState.clock);
    const spin = celebrationSpin();
    el.celebNote.innerHTML = `<span style="color:${C.ok}">${celebrationState.variant}</span> — `
      + `${celebrationState.clock.toFixed(2)}s of ${dur.toFixed(2)}s (wall)`
      + (spin ? `, spun ${(spin * 180 / Math.PI).toFixed(0)}°` : '');
  } else {
    el.celebFill.style.width = '0';
    el.celebNote.innerHTML = `<span style="color:${C.dim}">idle — fires on a boss kill `
      + `(${Math.round((celebrationState.seq)) || 0} so far this session)</span>`;
  }

  // --- clip coverage (static per model, but cheap and it can be rebuilt) ---
  const cc = anim.clipCoverage ?? {};
  for (const st of [...LOCOMOTION_STATES, ...ONESHOT_STATES]) {
    setChip(el.covChips[st], cc[st] === true, C.ok);
  }
  const missing = Object.entries(cc).filter(([, v]) => !v).map(([k]) => k);
  el.covNote.innerHTML = missing.length
    ? `<span style="color:${C.dim}">no clip for: ${missing.join(', ')} — `
      + `${anim.hasRealClips ? 'falls back to the rig or does nothing' : 'procedural only'}</span>`
    : `<span style="color:${C.ok}">every state has its own authored clip</span>`;

  renderBones(body);
  el.boneNote.innerHTML = `<span style="color:${C.dim}">a bone is owned only if EVERY locomotion `
    + `clip drives it with more than one keyframe — a constant track is as stranded as no track`
    + `</span>`;

  const team = sealTeamAnimDebug();
  el.teamNote.innerHTML = team.count === 0
    ? `<span style="color:${C.dim}">no escorts (Seal Team not picked)</span>`
    : `${team.count} escort${team.count === 1 ? '' : 's'} — `
      + `<span style="color:${C.ok}">${team.celebrating}</span> mid-clap, `
      + `<span style="color:${C.warn}">${team.armed}</span> waiting their turn`;
}
