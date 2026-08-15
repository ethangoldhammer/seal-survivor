import { CONFIG } from '../config.js';
import { stageState, toggleStage, isStaging, fireStagedEvent, stageEvents, onStageChanged, setSandboxUrl } from '../systems/stage.js';
import { resetEnemies } from '../entities/enemies.js';
import { isTextEntry } from './typing.js';

// The Stage bar — F.
//
// Sits along the bottom rather than in a side rail, because the thing it is
// for is watching the middle of the screen. A 300px column beside the effect
// you are judging is 300px of the arena you cannot see it in.
//
// Everything here writes stageState directly. There is no apply step and no
// save: see the note at the top of systems/stage.js about why none of this
// belongs in CONFIG.

const STYLES = `
  /* Centred with auto margins inside a full-width band, NOT with
     left:50% + translateX(-50%). The translate trick looks equivalent and is
     not: a fixed element with left:50% and right:auto gets only the remaining
     50% of the viewport to size itself in, so the bar was capped at half the
     window and wrapped every control onto its own row. On a narrow window that
     made it 729px tall — a control bar taller than the game. */
  .sv-stage { position: fixed; left: 0; right: 0; margin: 0 auto; width: fit-content;
    bottom: 14px; z-index: 32;
    display: none; align-items: center; gap: 9px; flex-wrap: wrap; max-width: min(1180px, 96vw);
    padding: 9px 14px; border-radius: 10px;
    background: rgba(8,10,15,0.93); border: 1px solid rgba(255,255,255,0.14);
    backdrop-filter: blur(10px); color: #e8ecf3;
    font-family: 'Inter', system-ui, sans-serif; font-size: 11px; }
  .sv-stage.sv-stage-on { display: flex; }
  .sv-stage-lab { font-size: 9px; letter-spacing: 0.09em; text-transform: uppercase; font-weight: 600;
    color: rgba(232,236,243,0.42); }
  .sv-stage-sep { width: 1px; height: 20px; background: rgba(255,255,255,0.12); }
  .sv-stage select { background: rgba(255,255,255,0.06); color: #e8ecf3; font-family: inherit; font-size: 11px;
    border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; padding: 4px 6px; max-width: 168px; }
  .sv-stage input[type=range] { width: 74px; accent-color: #7ad7ff; height: 14px; min-width: 0; }
  .sv-stage-val { font-size: 10px; color: rgba(232,236,243,0.62); font-variant-numeric: tabular-nums;
    min-width: 34px; }
  .sv-stage-btn { font-size: 10px; font-weight: 600; padding: 5px 10px; border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: #e8ecf3;
    cursor: pointer; font-family: inherit; }
  .sv-stage-btn:hover { border-color: #7ad7ff; color: #7ad7ff; }
  .sv-stage-btn.sv-stage-fire { border-color: rgba(122,215,255,0.55); color: #7ad7ff;
    background: rgba(122,215,255,0.13); }
  .sv-stage-status { font-size: 10px; color: rgba(232,236,243,0.4); font-variant-numeric: tabular-nums; }
  .sv-stage-status b { color: #ffb347; font-weight: 600; }
  /* Amber rather than red: a stale page is a state, not a fault. */
  .sv-stage-btn.sv-stage-stale { border-color: rgba(255,179,71,0.55); color: #ffb347;
    background: rgba(255,179,71,0.12); }
  .sv-stage-btn.sv-stage-stale:hover { border-color: #ffb347; color: #ffd9a0; }
`;

let panel = null;
let statusEl = null;
let staleEl = null;
let getScene = null;

// --- holding the page still -------------------------------------------------
// Nothing in this app accepts a hot update, so any edit anywhere falls through
// to a full page reload — which throws away the run, the cleared arena and
// every slider position the moment something else in the repo is saved. With
// another agent editing the tree at the same time that is constant.
//
// The latch itself lives in the dev server (see reloadHold in vite.config.js),
// because the browser cannot win this one: Vite awaits its
// `vite:beforeFullReload` listeners through Promise.allSettled, so the usual
// advice — throw from a listener to cancel — is swallowed and the page reloads
// regardless. All this side does is ask, and report what piled up.
//
// import.meta.hot is undefined in a production build and in the test harness,
// so every one of these is a no-op outside `npm run dev`.

function holdReloads(on) {
  import.meta.hot?.send('stage:hold', { hold: !!on });
  if (!on && staleEl) staleEl.style.display = 'none';
}

function bindReloadHold() {
  import.meta.hot?.on('stage:pending', ({ count, files }) => {
    if (!staleEl) return;
    if (!count) { staleEl.style.display = 'none'; return; }
    staleEl.style.display = '';
    staleEl.textContent = `↻ ${count} file${count === 1 ? '' : 's'} changed — reload`;
    // Which files, on hover. Enough to tell "someone else is working" from
    // "that was my own edit and I want it now".
    staleEl.title = `Held while the stage is open:\n${(files ?? []).join('\n')}\n\nClick to reload and lose the staged run.`;
  });
}

/**
 * @param sceneGetter returns the live THREE scene, for Clear. A getter rather
 *                    than the scene itself because this panel is built during
 *                    boot, before the world exists.
 */
export function initStagePanel(sceneGetter) {
  getScene = sceneGetter;

  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  panel = document.createElement('div');
  panel.className = 'sv-stage';

  const label = (text) => {
    const el = document.createElement('span');
    el.className = 'sv-stage-lab';
    el.textContent = text;
    return el;
  };
  const sep = () => {
    const el = document.createElement('div');
    el.className = 'sv-stage-sep';
    return el;
  };

  // --- what to fire ---------------------------------------------------------
  const select = document.createElement('select');
  // Browsers restore form-control values across a navigation, and they do it
  // AFTER load and WITHOUT firing `change` — so the picker would come back
  // showing one event while stageState still held another, and Fire would send
  // the one you couldn't see. Same failure the tuner rows guard against: a
  // control reporting a value that is not the one in effect. Every control on
  // this bar opts out; syncFromState below is the belt to this braces.
  select.autocomplete = 'off';
  for (const name of stageEvents()) {
    const opt = document.createElement('option');
    opt.value = name;
    // What the event actually does, so the list is pickable without knowing
    // all 77 names by heart.
    const def = CONFIG.feedback[name] ?? {};
    const has = [def.sfx ? '♪' : '', def.haptic ? '≈' : '', def.emit ? '✦' : ''].filter(Boolean).join('');
    opt.textContent = has ? `${name}  ${has}` : name;
    select.appendChild(opt);
  }
  select.value = stageState.event;
  select.addEventListener('change', () => {
    stageState.event = select.value;
    refreshStatus();
  });

  const fireBtn = document.createElement('button');
  fireBtn.className = 'sv-stage-btn sv-stage-fire';
  fireBtn.textContent = '▶ Fire';
  fireBtn.title = 'Fire the real feedback() on the seal — sound, rumble, particles, shake, hit-stop and ripple together';
  fireBtn.addEventListener('click', () => {
    if (!fireStagedEvent()) statusEl.innerHTML = `<b>no such event</b> — ${stageState.event}`;
    else refreshStatus();
  });

  panel.append(label('Stage'), select, fireBtn, sep());

  // --- the knobs ------------------------------------------------------------
  const slider = (text, min, max, step, read, write, fmt) => {
    const input = document.createElement('input');
    input.type = 'range';
    input.autocomplete = 'off'; // see the note on the picker
    input.min = min; input.max = max; input.step = step; input.value = read();
    const val = document.createElement('span');
    val.className = 'sv-stage-val';
    const paint = () => { val.textContent = fmt(read()); };
    paint();
    input.addEventListener('input', () => {
      write(Number(input.value));
      paint();
      refreshStatus();
    });
    panel.append(label(text), input, val);
    return { input, paint };
  };

  const time = slider('Time', 0.05, 1, 0.05,
    () => stageState.timeScale, (v) => { stageState.timeScale = v; },
    (v) => `${v.toFixed(2)}x`);
  time.input.title = 'Gameplay speed. 0.15 is about hit-stop speed — the only way to watch a 70ms freeze.';

  const zoom = slider('Zoom', 0.6, 4, 0.1,
    () => stageState.zoom, (v) => { stageState.zoom = v; },
    (v) => `${v.toFixed(1)}x`);
  zoom.input.title = 'Camera zoom while parked on the seal';

  const repeat = slider('Repeat', 0, 2, 0.05,
    () => stageState.repeat, (v) => { stageState.repeat = v; },
    (v) => (v > 0 ? `${v.toFixed(2)}s` : 'off'));
  repeat.input.title = 'Re-fire on an interval, so a burst can be judged while it overlaps itself';

  panel.appendChild(sep());

  const scale = slider('Scale', 0.25, 3, 0.05,
    () => stageState.scale, (v) => { stageState.scale = v; },
    (v) => `${v.toFixed(2)}`);
  scale.input.title = 'The per-instance multiplier gameplay passes for bigger enemies';

  const dist = slider('Away', 0, 40, 1,
    () => stageState.distance, (v) => { stageState.distance = v; },
    (v) => `${v.toFixed(0)}u`);
  dist.input.title = 'World units to the right of the seal to fire at — sound attenuates by distance band';

  panel.appendChild(sep());

  // --- housekeeping ---------------------------------------------------------
  // The seal's health and air, held full. There is no "not playing" state to
  // tune in — the splash drops you straight into a live run — so without this
  // a long session ends in drowning or in something eating you mid-slider.
  const safeWrap = document.createElement('label');
  safeWrap.style.cssText = 'display:flex; align-items:center; gap:5px; cursor:pointer';
  safeWrap.title = 'Hold health and oxygen full. Off to stage an event against a seal that is genuinely hurt — the only way to judge playerHit at low health.';
  const safeBox = document.createElement('input');
  safeBox.type = 'checkbox';
  safeBox.autocomplete = 'off';
  safeBox.checked = stageState.safe;
  safeBox.addEventListener('change', () => {
    stageState.safe = safeBox.checked;
    refreshStatus();
  });
  safeWrap.append(safeBox, label('Safe'));

  // Live run vs world only. Nothing about firing an event needs the run — the
  // particle pool, the grid, audio and haptics are all built before boot, and
  // everything that draws the result sits outside the run gate — so this is a
  // choice about what you want to judge against, not a dependency:
  //
  //   on   the seal swims and shoots, creatures hunt. Judge an effect in the
  //        traffic it will actually appear in.
  //   off  the world holds still. Nothing moves but the water, the sky and the
  //        seal's idle. Judge the effect itself, against a model that stays put.
  const simWrap = document.createElement('label');
  simWrap.style.cssText = 'display:flex; align-items:center; gap:5px; cursor:pointer';
  simWrap.title = 'On: the seal swims and creatures hunt, so an effect is judged in traffic. Off: the world holds still and only the effect moves.';
  const simBox = document.createElement('input');
  simBox.type = 'checkbox';
  simBox.autocomplete = 'off';
  simBox.checked = stageState.sim;
  simBox.addEventListener('change', () => {
    stageState.sim = simBox.checked;
    refreshStatus();
  });
  simWrap.append(simBox, label('Live'));

  const clearBtn = document.createElement('button');
  clearBtn.className = 'sv-stage-btn';
  clearBtn.textContent = 'Clear creatures';
  clearBtn.title = 'Remove everything already in the arena. Spawning is already paused while the stage is open.';
  clearBtn.addEventListener('click', () => {
    const scene = getScene?.();
    if (scene) resetEnemies(scene);
    refreshStatus();
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'sv-stage-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => setStagePanelVisible(false));

  statusEl = document.createElement('span');
  statusEl.className = 'sv-stage-status';

  // Stale-page notice. Hidden until something actually changes underneath us,
  // because a permanent "0 files changed" is noise.
  staleEl = document.createElement('button');
  staleEl.className = 'sv-stage-btn sv-stage-stale';
  staleEl.style.display = 'none';
  staleEl.addEventListener('click', () => window.location.reload());

  panel.append(simWrap, safeWrap, clearBtn, closeBtn, staleEl, statusEl);
  document.body.appendChild(panel);
  refreshStatus();

  // The stage can be closed by something that isn't this panel — starting a
  // run resets it — so the bar follows the system rather than assuming it is
  // the only thing that touches it.
  onStageChanged((on) => {
    panel.classList.toggle('sv-stage-on', on);
    // Re-assert every control from the state on the way in. autocomplete=off
    // should already have stopped the browser restoring stale values, but this
    // is the cheap guarantee: what the bar shows when it opens is what Fire
    // will actually send.
    if (on) {
      select.value = stageState.event;
      simBox.checked = stageState.sim;
      safeBox.checked = stageState.safe;
    }
    holdReloads(on);
    // So the reload button above lands you back HERE rather than in an
    // ordinary run — which would spawn, level and kill you, throwing away the
    // exact setup the reload was meant to preserve.
    setSandboxUrl(on);
    refreshStatus();
  });

  bindReloadHold();

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    // Shift+F is fullscreen (main.js). This handler has to accept 'F' as well
    // as 'f' — caps lock — so the modifier is what separates them, not the case.
    if (e.shiftKey) return;
    // isTextEntry, NOT isTypingTarget: the latter counts a focused range input
    // as typing, so F would stop working the moment you touched any slider on
    // this very panel.
    if (isTextEntry(e.target) || e.repeat) return;
    e.preventDefault();
    setStagePanelVisible(!isStaging());
  });

  // Fire from the keyboard as well, so the effect can be watched instead of
  // the button. Only while the stage is open, so it can't shadow anything.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !isStaging() || isTextEntry(e.target) || e.repeat) return;
    fireStagedEvent();
    refreshStatus();
  });
}

function refreshStatus() {
  if (!statusEl) return;
  const def = CONFIG.feedback[stageState.event];
  if (!def) {
    statusEl.innerHTML = `<b>unknown event</b>`;
    return;
  }
  const channels = [
    def.sfx ? `sound ${def.sfx}` : null,
    def.haptic ? 'rumble' : null,
    def.emit ? `burst ${def.emit}` : null,
    def.shake ? `shake ${def.shake}` : null,
    def.hitstop ? `hit-stop ${def.hitstop}s` : null,
  ].filter(Boolean);
  const safety = stageState.safe ? '' : ' · <b>mortal</b>';
  const world = stageState.sim ? 'spawns paused' : '<b>world held</b>';
  statusEl.innerHTML = `${world}${safety} · ${stageState.fired} fired · ${channels.join(' · ') || 'no channels'}`;
}

export function setStagePanelVisible(on) {
  if (!panel) return;
  if (on !== isStaging()) toggleStage();
  panel.classList.toggle('sv-stage-on', isStaging());
  refreshStatus();
}
