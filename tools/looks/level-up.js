// ---------------------------------------------------------------------------
// THE LEVEL-UP SCREEN.
//
//   npm run looks:levelup
//   http://localhost:4666/tools/looks/level-up.html
//
// (The path is nested because the build keeps the entry's own directory — the
// flat URL some of the older look pages document in their headers 404s.)
//
// A honeycomb comes on, three cards are thrown into cells of it lowest tier
// first, and each landing pulses the comb in that card's own colour. The whole
// thing is under a second and happens twenty-odd times a run, which makes it
// the hardest kind of thing to tune: you can only see it by earning it, and by
// the time it is on screen you are in a fight.
//
// NO WORLD. The level-up screen is DOM — initUI builds it and showLevelUp deals
// into it — so unlike the other look pages there is no scene here, no renderer
// and no seal. What is on screen is exactly the elements a run puts there.
//
// FOUR THINGS THIS PAGE HAS THAT THE GAME DOES NOT:
//
//   A FIXED SEED        the same hand every time. Math.random is replaced
//                       before each deal, so moving a slider changes the
//                       arrival and nothing else — otherwise every comparison
//                       is against a different hand and no two frames can be
//                       held side by side.
//
//   A CLOCK YOU OWN     Scrub swaps setTimeout for a queue this page drains by
//                       hand and pins every CSS animation's currentTime, then
//                       re-runs the screen from zero up to the moment on the
//                       slider. That is what makes a still of the middle of a
//                       ripple possible; a screenshot of a live arrival is
//                       whatever frame the shutter happened to land on.
//
//   THE KNOBS           CONFIG.upgradeSlam and CONFIG.upgradeComb, live,
//                       without opening the tuner inside a run.
//
//   ITS OWN PRESS       the arrival is skipped by ANY click or key (see
//                       bindSlamSkip in ui/ui.js), and this page is covered in
//                       both. A capture listener registered here — before the
//                       menu's, so it runs first — swallows anything that
//                       started inside the panel. A click on a CARD still
//                       skips, because that is the thing being looked at.
//
// IT WRITES NOTHING. A vite build behind a read-only static server: there is no
// /__tuning endpoint to reach, so nothing here can touch the live tuning. See
// SERVERS.md.
// ---------------------------------------------------------------------------
import { CONFIG } from '../../path/src/config.js';
import { initTypography } from '../../path/src/ui/typography.js';
import { initUI, showLevelUp } from '../../path/src/ui/ui.js';
import { combSize } from '../../path/src/ui/upgradeComb.js';
import { setHiveUpgrades, toggleHive } from '../../path/src/ui/upgradeHive.js';
// THE SEAL UNDER THE HAND — the one part of this screen that is not DOM. It
// draws to a canvas of its own between the comb and the cards, from a scene of
// its own, so this page can host it without growing a world: preload the
// models, push the saved looks (the same four calls the bust page makes, in
// the same order main.js makes them), and hand it the frames. `?seal=0` leaves
// it out, for a look at the comb alone.
import {
  preloadAssets, applySavedAssetLooks, applyNoiseSettings, applyToonSettings,
  applyBiolumSkinSettings,
} from '../../path/src/assets.js';
import {
  installLevelUpSeal, prepareLevelUpSeal, enterLevelUpSeal, leaveLevelUpSeal,
  updateLevelUpSeal, resetLevelUpSeal, levelUpSealState, levelUpSealLive,
} from '../../path/src/systems/levelUpSeal.js';
// THE SEAL MOTION PANEL — where the free swimmer's loops are written. See
// seal-motion-panel.js; it mounts once the seal is built.
import { mountSealMotionPanel } from './seal-motion-panel.js';
import * as motionModule from '../../path/src/systems/levelUpSealMotion.js';
import { EASINGS } from '../../path/src/ease.js';
import { previewCardTip, cardTipShowing, refreshCardTip } from '../../path/src/ui/ui.js';

const panel = document.getElementById('panel');
const readEl = document.getElementById('read');

// --- SIDE BY SIDE -------------------------------------------------------------
// `?compare=1` is not this page: it is two of it, in iframes, running the two
// arrivals against each other on the same seed and rolling together.
//
// TWO DOCUMENTS RATHER THAN TWO COMBS IN ONE. The comb tiles the VIEWPORT and
// the cards are placed against it — there is exactly one of each per document
// by construction, and half a window is a different viewport, which is the
// thing each side has to lay itself out for. Faking it with two containers
// would compare two screens neither of which the game ever draws.
if (new URLSearchParams(location.search).get('compare')) {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;height:100vh;display:flex;flex-direction:column;background:#050d15';
  const bar = document.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:8px 12px;'
    + 'font:12px/1.4 ui-monospace,Menlo,monospace;color:#b9d6ee;border-bottom:1px solid rgba(122,215,255,.2)';
  bar.innerHTML = '<b style="color:#9fdcff;letter-spacing:.12em">SLAM  vs  REEL</b>'
    + '<button id="both" style="font:inherit;color:#dff0ff;background:rgba(122,215,255,.14);'
    + 'border:1px solid rgba(122,215,255,.35);border-radius:5px;padding:3px 10px;cursor:pointer">Roll both</button>'
    + '<span style="color:#7f9ab0">same hand, same seed — click either side to skip it</span>';
  const row = document.createElement('div');
  row.style.cssText = 'flex:1 1 auto;display:flex;min-height:0';
  const frames = ['slam', 'reel'].map((mode) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1 1 0;min-width:0;display:flex;flex-direction:column;border-right:1px solid rgba(122,215,255,.18)';
    const tag = document.createElement('div');
    tag.textContent = mode;
    tag.style.cssText = 'flex:0 0 auto;padding:4px 10px;font:11px/1.4 ui-monospace,Menlo,monospace;'
      + 'letter-spacing:.14em;text-transform:uppercase;color:#ffe08a';
    const f = document.createElement('iframe');
    f.src = `./level-up.html?only=${mode}&bare=1`;
    f.style.cssText = 'flex:1 1 auto;width:100%;border:0;min-height:0';
    wrap.append(tag, f);
    row.appendChild(wrap);
    return f;
  });
  document.body.append(bar, row);
  bar.querySelector('#both').addEventListener('click', () => {
    for (const f of frames) f.contentWindow?.postMessage('roll', '*');
  });
  // Nothing below this runs: the two children are the page.
  throw new Error('compare mode — this document is the frame, not the screen');
}

// --- THE FRAME ----------------------------------------------------------------
// THIS IS THE PAGE NOW: the shipped menu inside a frame at a real device's
// size — phone, iPad, laptop, desktop, either way up — with the panel OUTSIDE
// it driving the seal inside. `?frame=WxH` picks a size (`?portrait=1` still
// means the phone); `?inline=1` is the old page, the screen filling the
// window with the comb's own knobs, for tuning the arrival.
//
// A frame rather than a resized window for the reason the compare mode gives:
// the comb tiles the VIEWPORT and the cards are laid out against it, so a
// device has to be a viewport, and the agent's browser pane cannot even give
// the top document a size. The child is `?bare=1&child=1` — its own panel
// hidden, its motion module and CONFIG handed up through window.__sealLook —
// and the panel here imports nothing from it that it can get from that
// handle: an iframe is its own module graph, and the parent's copy of the
// motion data is not the one the child's puppet reads.
//
// The seal's FEEL — blend time and curve, take rate, the arrival's times and
// curves, the swim's numbers, the head's ease, the exit spin — is
// CONFIG.levelUpSeal, and the card tooltip's place and arrival are
// CONFIG.cardTip; both written live into the child's CONFIG by full path. Save feel keeps it in
// tools/looks/level-up-seal-feel.json, which this page re-applies on load;
// What I changed prints the config.js lines, which is what reaches the game.
const PARAMS = new URLSearchParams(location.search);
if (!PARAMS.get('inline') && !PARAMS.get('child')) {
  const DEVICES = [
    ['SE', 375, 667], ['15', 393, 852], ['15 Max', 430, 932], ['iPad mini', 744, 1133],
    ['15 landscape', 852, 393], ['iPad landscape', 1024, 768], ['Laptop', 1280, 800], ['Desktop', 1920, 1080],
  ];
  const want = PARAMS.get('frame') ?? (PARAMS.get('portrait') ? (PARAMS.get('portrait') === '1' ? '393x852' : PARAMS.get('portrait')) : '1280x800');
  const m = /^(\d+)x(\d+)$/.exec(want);
  const size = m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1280, h: 800 };
  document.body.style.cssText = 'margin:0;height:100vh;overflow:hidden;background:#050d15';
  // The panel stays; everything in it but the heading goes.
  for (const n of [...panel.children]) if (n.tagName !== 'H1') n.remove();
  panel.querySelector('h1').firstChild.textContent = 'Level-up screen, in a frame';
  const bar = document.createElement('div');
  bar.className = 'btns';
  bar.innerHTML = '<button id="pfRoll">Roll</button><button id="pfExit">Exit</button>'
    + '<a href="./level-up.html?inline=1" style="color:#7ad7ff;align-self:center">inline (comb knobs) ↗</a>';
  const sizes = document.createElement('div');
  sizes.className = 'btns';
  for (const [name, w, h] of DEVICES) {
    const b = document.createElement('button');
    b.textContent = `${name} ${w}×${h}`;
    b.setAttribute('aria-pressed', String(w === size.w && h === size.h));
    b.addEventListener('pointerup', () => { location.search = `?frame=${w}x${h}`; });
    sizes.appendChild(b);
  }
  const note = document.createElement('p');
  note.textContent = `${size.w}×${size.h}. The seal plays the set this shape asks for (portrait or landscape) and the panel edits that set. Hover a card in the frame to feel the blend (Live).`;
  panel.append(bar, sizes, note);

  // The frame, scaled to fit beside the panel, at its real CSS size inside.
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:320px;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center';
  const shell = document.createElement('div');
  const f = document.createElement('iframe');
  const only = PARAMS.get('only');
  f.src = `./level-up.html?bare=1&child=1${only ? `&only=${only}` : ''}`;
  f.style.cssText = `width:${size.w}px;height:${size.h}px;border:0;display:block;transform-origin:0 0;`
    + 'background:#000;box-shadow:0 0 0 6px #1b2a38, 0 0 0 7px rgba(122,215,255,.35), 0 20px 60px rgba(0,0,0,.6);border-radius:12px';
  shell.appendChild(f);
  stage.appendChild(shell);
  document.body.appendChild(stage);
  const fit = () => {
    const k = Math.min(1, (window.innerWidth - 320 - 40) / size.w, (window.innerHeight - 40) / size.h);
    f.style.transform = `scale(${k})`;
    shell.style.width = `${size.w * k}px`;
    shell.style.height = `${size.h * k}px`;
  };
  fit();
  window.addEventListener('resize', fit);
  bar.querySelector('#pfRoll').addEventListener('pointerup', () => f.contentWindow?.postMessage('roll', '*'));
  bar.querySelector('#pfExit').addEventListener('pointerup', () => f.contentWindow?.postMessage('exit', '*'));

  // --- THE FEEL: CONFIG in the child, live -----------------------------------
  // [full CONFIG path, min, max, step, label] — or a list of names for a
  // select. A row with null for min is a heading.
  const S = 'levelUpSeal.';
  const FEEL = [
    ['blend', null],
    [S + 'motion.blendTime', 0, 2, 0.02, 'blend: time (s) — 0 = rate'],
    [S + 'motion.blendEase', EASINGS, null, null, 'blend: curve'],
    [S + 'motion.blendRate', 0.5, 12, 0.1, 'blend: rate (/s), when time is 0'],
    [S + 'motion.takeRate', 0.5, 12, 0.1, 'let go on the pick (/s)'],
    [S + 'motion.turnEase', EASINGS, null, null, 'body turn: curve over the swim'],
    [S + 'motion.turnSettle', 0.5, 20, 0.5, 'body turn: settle (/s)'],
    ['arrival', null],
    [S + 'delay', 0, 1, 0.02, 'wait after the cards land (s)'],
    [S + 'inTime', 0.2, 2, 0.05, 'swim up (s)'],
    [S + 'inEase', EASINGS, null, null, 'swim up: curve'],
    [S + 'outTime', 0.1, 1.5, 0.05, 'swim off (s)'],
    [S + 'outEase', EASINGS, null, null, 'swim off: curve'],
    [S + 'freeHeight', 0.1, 0.6, 0.01, 'body length (of height)'],
    ['the swim to a point', null],
    [S + 'pull.speed', 0.1, 4, 0.05, 'speed (× the run)'],
    [S + 'pull.arrive', 0.05, 2, 0.02, 'ease to a stop (lengths)'],
    [S + 'pull.turnWeight', 0, 1, 0.02, 'body turns after the swim'],
    [S + 'pull.steer', 0.5, 20, 0.5, 'retarget: banking turn (/s)'],
    [S + 'clipSpeedLerp', 0, 20, 0.5, 'clip pick: speed smoothing (/s)'],
    ['the head', null],
    [S + 'aimLerp', 1, 20, 0.5, 'look ease (/s)'],
    [S + 'aimSpread', 0, 1, 0.02, 'look spread'],
    [S + 'pointFaceOut', 0, 1, 0.02, 'face out while pointing'],
    [S + 'faceOut', 0, 1, 0.02, 'face out while idle'],
    ['the body after the cursor', null],
    [S + 'followTurn', 0, 0.8, 0.01, 'yaw (rad)'],
    [S + 'followLean', 0, 0.4, 0.01, 'cant (rad)'],
    [S + 'followLerp', 0.5, 12, 0.1, 'ease (/s)'],
    ['bubbles', null],
    [S + 'bubbles.sizeMul', 0.2, 3, 0.05, 'size (× the run\'s)'],
    [S + 'bubbles.breath.moveRate', 0.1, 1, 0.05, 'breath: interval at full speed (×)'],
    [S + 'bubbles.breath.pointRate', 0.1, 1, 0.05, 'breath: interval while pointing (×)'],
    [S + 'bubbles.wake.perSecond', 0, 60, 1, 'wake: bursts/s at top speed'],
    [S + 'bubbles.wake.minSpeed', 0, 10, 0.25, 'wake: from speed (u/s)'],
    [S + 'bubbles.wake.curve', 0.2, 2, 0.05, 'wake: ramp shape'],
    [S + 'bubbles.point.perSecond', 0, 12, 0.25, 'pointing: mouth trickle (bursts/s)'],
    ['the jaw', null],
    [S + 'jaw.openMul', 0, 2, 0.05, 'open angle (× the rig\'s)'],
    [S + 'jaw.biteOnPick', 0, 1, 1, 'bite on the pick (0/1)'],
    [S + 'jaw.openTime', 0.02, 0.6, 0.01, 'bite: open (s)'],
    [S + 'jaw.holdTime', 0, 0.6, 0.01, 'bite: hold (s)'],
    [S + 'jaw.closeTime', 0.02, 0.6, 0.01, 'bite: shut (s)'],
    ['the exit', null],
    [S + 'spinTurns', 0, 4, 0.5, 'barrel roll: turns'],
    [S + 'spinTime', 0.1, 1, 0.05, 'barrel roll: share of the exit'],
    [S + 'spinEase', EASINGS, null, null, 'barrel roll: curve'],
    ['the card tooltip', null],
    ['cardTip.side', ['auto', 'below', 'above', 'left', 'right'], null, null, 'side of the card'],
    ['cardTip.gap', 0, 40, 1, 'gap off the hexagon (px)'],
    ['cardTip.offsetX', -160, 160, 1, 'x (px)'],
    ['cardTip.offsetY', -160, 160, 1, 'y (px)'],
    ['cardTip.fadeIn', 0, 0.8, 0.01, 'in (s)'],
    ['cardTip.fadeOut', 0, 0.8, 0.01, 'out (s)'],
    ['cardTip.ease', ['linear', 'out', 'inOut', 'back'], null, null, 'curve'],
    ['cardTip.rise', 0, 30, 1, 'slides in from (px)'],
    ['cardTip.scaleFrom', 0.5, 1.2, 0.01, 'grows in from (scale)'],
    ['the tooltip, per card (row)', null],
    ...[0, 1, 2].flatMap((i) => [
      [`cardTip.cards.${i}.side`, ['auto', 'below', 'above', 'left', 'right'], null, null, `card ${i + 1}: side`],
      [`cardTip.cards.${i}.x`, -240, 240, 1, `card ${i + 1}: x (px)`],
      [`cardTip.cards.${i}.y`, -240, 240, 1, `card ${i + 1}: y (px)`],
    ]),
    ['the tooltip, per card (stacked, portrait)', null],
    ...[0, 1, 2].flatMap((i) => [
      [`cardTip.portraitCards.${i}.side`, ['auto', 'below', 'above', 'left', 'right'], null, null, `card ${i + 1}: side`],
      [`cardTip.portraitCards.${i}.x`, -240, 240, 1, `card ${i + 1}: x (px)`],
      [`cardTip.portraitCards.${i}.y`, -240, 240, 1, `card ${i + 1}: y (px)`],
    ]),
  ];
  // The roots a feel path may start with — a saved preset from before the
  // tooltip joined carries seal paths with no root, and gets it back.
  const ROOTS = ['levelUpSeal', 'cardTip'];
  const rooted = (path) => (ROOTS.some((r) => path.startsWith(r + '.')) ? path : S + path);
  const feel = document.createElement('div');
  feel.innerHTML = '<hr><h2 style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9fdcff;margin:4px 0 6px">Seal feel</h2>'
    + '<div class="btns"><button id="feelApply">Write to config.js</button><button id="feelSave">Save feel</button><button id="feelChanged">What I changed</button><button id="feelReset">Back to config.js</button></div>'
    + '<div id="feelKnobs"></div><div id="feelRead" style="color:#ffe08a;white-space:pre-wrap;margin-top:6px"></div>';
  panel.appendChild(feel);
  const knobsEl = feel.querySelector('#feelKnobs');
  const readEl2 = feel.querySelector('#feelRead');
  let childCfg = null;   // the child's CONFIG
  let base = null;       // ...the feel's roots as config.js had them, before any preset
  const at = (path) => path.split('.').reduce((o, k) => o?.[k], childCfg);
  const put = (path, v) => {
    const parts = path.split('.');
    let o = childCfg;
    for (const k of parts.slice(0, -1)) o = (o[k] ??= {});
    o[parts[parts.length - 1]] = v;
  };
  const FEEL_PATHS = FEEL.filter((r) => r[1] !== null).map((r) => r[0]);
  // LIVE. The seal reads its numbers every frame; the tooltip is placed once
  // when it goes up, so a tooltip knob re-places the box that is showing.
  let tipHook = null;
  const afterPut = (path) => { if (path.startsWith('cardTip.')) tipHook?.refresh?.(); };
  function buildFeel() {
    knobsEl.innerHTML = '';
    for (const [path, a, b, step, label] of FEEL) {
      if (a === null) {
        const h = document.createElement('h3');
        h.style.cssText = 'font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#7f9ab0;margin:8px 0 2px';
        h.textContent = path;
        knobsEl.appendChild(h);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'row';
      const l = document.createElement('label'); l.textContent = label;
      row.appendChild(l);
      if (Array.isArray(a)) {
        const sel = document.createElement('select');
        sel.style.cssText = 'font:inherit;color:#dff0ff;background:#0b1a27;border:1px solid rgba(122,215,255,0.35);border-radius:4px';
        for (const n of a) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); }
        sel.value = at(path) ?? a[0];
        sel.addEventListener('change', () => { put(path, sel.value); afterPut(path); });
        row.appendChild(sel);
      } else {
        const r = document.createElement('input'); r.type = 'range'; r.min = a; r.max = b; r.step = step;
        r.value = at(path) ?? a;
        const o = document.createElement('output'); o.textContent = Number(r.value).toFixed(2);
        r.addEventListener('input', () => { put(path, Number(r.value)); o.textContent = Number(r.value).toFixed(2); afterPut(path); });
        row.append(r, o);
      }
      knobsEl.appendChild(row);
    }
  }
  function preset() {
    const out = {};
    for (const path of FEEL_PATHS) out[path] = at(path);
    return out;
  }
  function applyPreset(saved) {
    for (const [k, v] of Object.entries(saved)) {
      const path = rooted(k);
      if (FEEL_PATHS.includes(path)) put(path, v);
    }
  }
  function changed() {
    const lines = [];
    for (const path of FEEL_PATHS) {
      const now = at(path);
      const was = path.split('.').reduce((o, k) => o?.[k], base);
      if (now !== was) lines.push(`  ${path}: ${JSON.stringify(now)},`);
    }
    return lines.length ? lines.join('\n') : 'nothing changed from config.js';
  }
  feel.querySelector('#feelSave').addEventListener('pointerup', async () => {
    try {
      const r = await fetch('/preset/level-up-seal-feel.json', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
      readEl2.textContent = r.ok ? `saved tools/looks/level-up-seal-feel.json — reloads keep it\n${changed()}` : `save failed (${r.status})`;
    } catch (err) { readEl2.textContent = `save failed — ${err.message}`; }
  });
  // INTO THE GAME. Save feel keeps the numbers for this page; the game boots
  // config.js, and the tuner's snapshot shadows the whole seal block on top
  // of that. This writes them through both — see tools/apply-level-up-feel.mjs
  // — and reports what moved, or that the game is up and the snapshot could
  // not be cleared.
  feel.querySelector('#feelApply').addEventListener('pointerup', async () => {
    readEl2.textContent = 'writing…';
    try {
      const r = await fetch('/apply/level-up-feel', { method: 'POST', body: JSON.stringify(preset(), null, 2) });
      const rep = await r.json();
      if (rep.error) { readEl2.textContent = `write failed — ${rep.error}`; return; }
      const lines = [rep.wrote ? 'wrote path/src/config.js' : 'config.js already matches', ...rep.notes];
      readEl2.textContent = lines.join('\n');
    } catch (err) { readEl2.textContent = `write failed — ${err.message}`; }
  });
  feel.querySelector('#feelChanged').addEventListener('pointerup', () => {
    const text = changed();
    readEl2.textContent = text;
    navigator.clipboard?.writeText(text).catch(() => {});
  });
  feel.querySelector('#feelReset').addEventListener('pointerup', () => {
    applyPreset(Object.fromEntries(FEEL_PATHS.map((p) => [p, p.split('.').reduce((o, k) => o?.[k], base)])));
    buildFeel();
    readEl2.textContent = 'back to config.js';
  });

  // The panels mount once the frame's seal is built.
  f.addEventListener('load', () => {
    const w = f.contentWindow;
    const tick = setInterval(async () => {
      if (!w.__sealReady?.() || !w.__sealLook) return;
      clearInterval(tick);
      childCfg = w.__sealLook.CONFIG;
      tipHook = w.__sealLook.tip;
      base = JSON.parse(JSON.stringify(Object.fromEntries(ROOTS.map((r) => [r, childCfg[r] ?? {}]))));
      try {
        const saved = await (await fetch('/preset/level-up-seal-feel.json')).json();
        if (Object.keys(saved).length) { applyPreset(saved); readEl2.textContent = 'feel preset loaded from tools/looks/level-up-seal-feel.json'; }
      } catch { /* none saved */ }
      buildFeel();
      mountSealMotionPanel({
        panel, getLive: () => w.__seal(), doc: f.contentDocument, win: w, mod: w.__sealLook.mod,
        getConfig: () => w.__sealLook.CONFIG, tip: w.__sealLook.tip,
        // A tooltip handle dragged in the frame rewrites cardTip.cards — the
        // feel sliders for it re-read the numbers.
        onFeelChanged: () => { buildFeel(); readEl2.textContent = changed(); },
      });
    }, 100);
  });
  throw new Error('frame mode — this document is the frame, not the screen');
}

// Which arrival THIS document is showing. `?only=` is what the compare frames
// pass down; without it the page is whatever CONFIG says and the button flips it.
const ONLY = new URLSearchParams(location.search).get('only');

// --- the clock ---------------------------------------------------------------
// EVERYTHING ON THIS SCREEN IS EITHER A CSS ANIMATION OR A setTimeout. There is
// no rAF loop left to fake — the reel that had one is gone — so holding a
// moment still means owning both of those instead.
const realTimeout = window.setTimeout.bind(window);
const realClear = window.clearTimeout.bind(window);
// ...AND THE CLOCK THE REEL READS. The slam is timers and CSS, so faking those
// was enough — but the reel drives its columns from performance.now() inside a
// rAF loop, and a faked frame that hands it the REAL clock reports no time
// passing at all. Under scrub the columns then sit at their first face forever
// and no card ever lands: three strips visible, nothing lit, and a slider that
// appears to do nothing.
const realNow = performance.now.bind(performance);

let scrubbing = false;
let fakeNow = 0;
let seq = 0;
let pending = [];

performance.now = () => (scrubbing ? fakeNow : realNow());

window.setTimeout = (fn, ms) => {
  if (!scrubbing) return realTimeout(fn, ms);
  const id = ++seq;
  pending.push({ id, fn, at: fakeNow + (Number(ms) || 0) });
  return id;
};
window.clearTimeout = (id) => {
  if (!scrubbing) return realClear(id);
  pending = pending.filter((t) => t.id !== id);
};

// ...AND THE FRAME THE MENU WAITS FOR. showLevelUp measures the hand, waits one
// requestAnimationFrame and only then tiles the comb and throws the cards —
// which is what stops it tiling against a page that has not settled. Fake the
// timers and not that frame, and everything worth scrubbing happens on the real
// clock a moment after the scrub has finished: the slider moves and the screen
// does not, which looks exactly like the scrubber being broken rather than like
// one call escaping it.
const realRaf = window.requestAnimationFrame.bind(window);
const realCancelRaf = window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => {
  if (!scrubbing) return realRaf(cb);
  const id = ++seq;
  pending.push({ id, fn: () => cb(fakeNow), at: fakeNow + 16 });
  return id;
};
window.cancelAnimationFrame = (id) => {
  if (!scrubbing) return realCancelRaf(id);
  pending = pending.filter((t) => t.id !== id);
};

// Fire everything due by now, oldest first. A callback can schedule another —
// a landing does — so this drains until nothing is left rather than walking a
// snapshot of the list.
function drain() {
  for (let guard = 0; guard < 2000; guard++) {
    const due = pending.filter((t) => t.at <= fakeNow).sort((a, b) => a.at - b.at);
    if (!due.length) return;
    const next = due[0];
    pending = pending.filter((t) => t !== next);
    try { next.fn(); } catch { /* the menu's own problem, not the scrubber's */ }
  }
}

/**
 * HOLD THE COMB.
 *
 * The cells are a hundred CSS animations, which run on the browser's own clock
 * and cannot see any of the above. The Web Animations API is the way in: every
 * animation on the page can be paused and its currentTime set by hand.
 *
 * WHEN EACH ONE'S OWN CLOCK STARTED matters, and they are not born together —
 * the comb's arrival starts with the menu, a landing's ripple starts a third of
 * a second later when a card hits. Give them all the same currentTime and the
 * ripples are handed a number past their own end, so the payoff — the one
 * moment on this screen most worth holding still — is the one that never
 * appears.
 */
let born = new WeakMap();
function hold(ms) {
  for (const a of document.getAnimations()) {
    try {
      // STAMPED ON THE NAME AS WELL AS THE OBJECT. Chrome REUSES the same
      // CSSAnimation object when animation-name changes on an element, so a
      // cell that arrived and later pulsed is one object with two lives — and
      // keying the birth time on the object alone hands every ripple the
      // ignition's start, which is most of a second earlier. Every pulse was
      // then given a currentTime past its own end and reported `finished`: the
      // comb sat at rest at every moment of the scrub, and the ripple looked
      // like it had stopped being written.
      const seen = born.get(a);
      if (!seen || seen.name !== a.animationName) born.set(a, { name: a.animationName, at: ms });
      a.pause();
      a.currentTime = Math.max(0, ms - born.get(a).at);
    } catch { /* the element has already gone */ }
  }
}
function release() {
  for (const a of document.getAnimations()) {
    try { a.play(); } catch { /* already gone */ }
  }
}

// --- the deal ----------------------------------------------------------------
// One seed per hand. Which upgrades are offered and what tier each is dealt at
// are both Math.random, so without this the screen is different on every
// re-roll and nothing can be compared with anything.
let seed = 20250826;
const nativeRandom = Math.random;
function seedRandom() {
  let s = seed >>> 0;
  Math.random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

if (ONLY) CONFIG.upgradeArrival = ONLY;
// The button says what the page is actually doing. It used to say what the
// markup said, which in a compare frame is the other one — the two sides ran
// correctly and both claimed to be the slam.
document.getElementById('arrival').textContent = `Arrival: ${CONFIG.upgradeArrival}`;
// Inside a compare frame the panel is in the way of the thing being compared.
if (new URLSearchParams(location.search).get('bare')) {
  panel.classList.add('shut');
  document.getElementById('shut').textContent = '+';
}
// Inside the phone the panel is not even a button: the parent's is the panel.
const CHILD = !!new URLSearchParams(location.search).get('child');
if (CHILD) panel.style.display = 'none';

// A compare frame is driven from its parent, so both sides roll on one press;
// the phone's parent takes a card the way the Exit button here does.
window.addEventListener('message', (e) => {
  if (e.data === 'roll') replay();
  if (e.data === 'exit') {
    const cards = document.querySelectorAll('#svCards .sv-card');
    cards[Math.floor(cards.length / 2)]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
});

// What has been picked so far, so the corner fills up the way it does in a run
// and every flight after the first has a hive that has already made room.
const taken = [];
const WANT_SEAL = new URLSearchParams(location.search).get('seal') !== '0';

initTypography();
initUI({
  onStart() {}, onRestart() {}, onNameSubmit() {},
  // Taking a card drains the comb and flies the card at a hive that is not on
  // this page. Dealt again a beat later so the screen is never left empty.
  // Dealt again once the comb has finished leaving, rather than on a fixed
  // half second — the exit is a thing you tune, and a re-deal that lands in the
  // middle of it makes the exit impossible to watch at exactly the settings you
  // are trying to judge.
  onLevelChoice(choice) {
    // The pick: the seal shoots off the top, exactly as applyLevelChoice sends
    // it in main.js.
    leaveLevelUpSeal();
    // FILED FIRST, FLOWN SECOND, which is the order the game uses and the only
    // one that works: the card's flight ends at its own hexagon in the corner,
    // so the tile has to exist before the flight can be told where to go.
    // Without this the look page had no hive tiles at all, hiveTileRect
    // returned nothing, and the whole flight silently did not run — the card
    // just vanished on click, which reads as the animation being broken rather
    // than as having no destination.
    taken.push(choice);
    setHiveUpgrades(taken);
    const c = CONFIG.upgradeComb ?? {};
    const f = CONFIG.upgradeHive?.fly ?? {};
    const flight = (f.riseSeconds ?? 0.26) + (f.holdSeconds ?? 0.42) + (f.seconds ?? 0.34);
    setTimeout(deal, Math.max(
      ((c.drainTime ?? 0.42) + (c.drainStep ?? 0.09) * 12) * 1000,
      flight * 1000,
    ) + 500);
  },
});

function deal() {
  seedRandom();
  showLevelUp();
  Math.random = nativeRandom;
  // The seal comes up with the cards, as the ramp's callback has it in main.js.
  if (sealReady) enterLevelUpSeal();
  report();
}

// --- the seal ---------------------------------------------------------------
// The page's own frame loop, which the DOM half of this screen never needed.
// Wall dt, capped exactly as the game caps it. Steps through
// window.requestAnimationFrame so the scrubber's queue owns it while scrubbing;
// `window.__sealStep(dt, n)` drives it by hand from the console for a pane that
// throttles rAF (see the note in the html about why there is no shim here).
let sealReady = false;
let sealLast = performance.now();
function sealFrame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - sealLast) / 1000));
  sealLast = now;
  updateLevelUpSeal(dt);
  window.requestAnimationFrame(sealFrame);
}
window.__sealStep = (dt = 1 / 60, n = 1) => {
  for (let i = 0; i < n; i++) updateLevelUpSeal(dt);
  return levelUpSealState.phase;
};
window.__sealReset = () => resetLevelUpSeal();
window.__sealReady = () => sealReady;
window.__seal = () => levelUpSealLive();
if (WANT_SEAL) {
  installLevelUpSeal({});
  preloadAssets().then(() => {
    applySavedAssetLooks();
    applyNoiseSettings();
    applyToonSettings();
    applyBiolumSkinSettings();
    prepareLevelUpSeal();
    sealReady = true;
    // The phone's parent mounts the panel, with this document's own module.
    if (CHILD) window.__sealLook = { mod: motionModule, CONFIG, tip: { show: previewCardTip, showing: cardTipShowing, refresh: refreshCardTip } };
    else mountSealMotionPanel({ panel, getLive: levelUpSealLive, getConfig: () => CONFIG, tip: { show: previewCardTip, showing: cardTipShowing, refresh: refreshCardTip } });
    // If a hand is already on the table, bring the seal up under it now.
    if (document.querySelector('#svCards .sv-card')) enterLevelUpSeal();
    sealLast = performance.now();
    window.requestAnimationFrame(sealFrame);
  }).catch((err) => console.error('[level-up look] the seal could not be built', err));
}

// How long the whole screen takes: the last card landing is not the last thing
// that happens — the comb floods in that card's colour after it, and stopping
// the scrubber at the final landing puts the payoff past the end of the slider.
function screenSeconds() {
  const c = CONFIG.upgradeComb ?? {};
  const n = (CONFIG.upgradeChoices ?? 3) - 1;
  const last = CONFIG.upgradeArrival === 'reel'
    ? (() => { const r = CONFIG.upgradeReel ?? {}; return (r.first ?? 0.62) + n * (r.stagger ?? 0.3); })()
    : (() => { const s = CONFIG.upgradeSlam ?? {}; return (s.first ?? 0.28) + n * (s.stagger ?? 0.18) + (s.time ?? 0.26); })();
  return last + (c.flashTime ?? 0.5) + 0.1;
}

function report() {
  const s = CONFIG.upgradeSlam ?? {};
  const cards = [...document.querySelectorAll('#svCards .sv-card')];
  const ranks = cards.map((c) => Number(c.dataset.rarityRank) || 0);
  const order = ranks
    .map((rank, i) => ({ i, rank }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i));
  const lines = order.map(({ i, rank }, n) => {
    const at = (s.first ?? 0.28) + n * (s.stagger ?? 0.18) + (s.time ?? 0.26);
    return `  #${i + 1} tier ${rank} lands at ${at.toFixed(2)}s${n === order.length - 1 ? '  ← flood' : ''}`;
  });
  readEl.textContent = [
    `dealt tiers  ${ranks.join('  ')}  (left to right)`,
    `${combSize()} cells in the comb`,
    'lands:',
    ...lines,
  ].join('\n');
}

// --- scrubbing ---------------------------------------------------------------
// Re-runs the screen from zero every time rather than stepping the live one
// forward. A comb that has drained has had its cells removed, and a card that
// has landed cannot be un-landed — a scrubber that only goes one way is not a
// scrubber. A second of a paused menu is nothing to redo.
function scrubTo(seconds) {
  scrubbing = true;
  pending = [];
  born = new WeakMap();
  fakeNow = 0;
  deal();
  hold(0);
  for (let t = 0; t <= seconds * 1000; t += 16) {
    fakeNow = t;
    drain();
    hold(t);
  }
  fakeNow = seconds * 1000;
  drain();
  hold(fakeNow);
  report();
}

// --- the knobs ---------------------------------------------------------------
// WHAT THE FILE SAID BEFORE ANY SLIDER MOVED, so "what did I change" is a diff
// rather than a memory. Taken at boot, from the same CONFIG the sliders write.
const BASE = {};
for (const group of ['upgradeSlam', 'upgradeComb', 'upgradeReel', 'levelUpSeal']) {
  // Structured rather than spread: `upgradeSlam.riser` is a nested block, and a
  // shallow copy of it is the LIVE object — so every number inside it would
  // compare equal to itself forever and the readout would quietly omit the
  // whole riser.
  BASE[group] = JSON.parse(JSON.stringify(CONFIG[group]));
}
BASE.upgradeArrival = CONFIG.upgradeArrival;

const KNOBS = [
  ['upgradeHive.fly', 'riseSeconds', 0, 1.5, 0.02, 'pick: rise (s)'],
  ['upgradeHive.fly', 'riseScale', 1, 3, 0.05, 'pick: grows to'],
  ['upgradeHive.fly', 'holdSeconds', 0, 2, 0.02, 'pick: held (s)'],
  ['upgradeSlam', 'first', 0, 1.5, 0.02, 'first card lands (s)'],
  ['upgradeSlam', 'stagger', 0, 0.8, 0.02, 'gap between cards (s)'],
  ['upgradeSlam', 'time', 0.06, 1, 0.02, 'card in the air (s)'],
  ['upgradeSlam', 'from', 1, 9, 0.1, 'falls from size'],
  ['upgradeComb', 'gap', 0, 24, 1, 'cell gap (px)'],
  ['upgradeComb', 'spread', 1, 4, 1, 'columns apart'],
  ['upgradeComb', 'flashTime', 0.05, 2, 0.02, 'flash length (s)'],
  ['upgradeComb', 'flashLift', 0.2, 1, 0.02, 'pulse brightness'],
  ['upgradeComb', 'pop', 0, 1.2, 0.02, 'pulse pop (scale)'],
  ['upgradeComb', 'floodStep', 0, 0.3, 0.005, 'last card: per ring (s)'],
  ['upgradeComb', 'floodTime', 0.1, 3, 0.05, 'last card: ring-down (s)'],
  ['upgradeComb', 'ringStep', 0, 0.3, 0.005, 'stagger: per ring (s)'],
  ['upgradeComb', 'ringFade', 0, 0.5, 0.01, 'each ring dimmer by'],
  ['upgradeComb', 'restAlpha', 0, 1, 0.02, 'cell fill opacity'],
  ['upgradeComb', 'restOpacity', 0, 1, 0.02, 'at rest: layer opacity'],
  ['upgradeComb', 'breatheBy', 0, 0.3, 0.01, 'at rest: breathe by'],
  ['upgradeComb', 'breatheSeconds', 0.5, 12, 0.1, 'at rest: breath (s)'],
  ['upgradeComb', 'drainTime', 0.05, 1.5, 0.02, 'exit: one cell (s)'],
  ['upgradeComb', 'drainStep', 0, 0.3, 0.005, 'exit: per column (s)'],
  // THE SEAL under the hand — CONFIG.levelUpSeal, the swimmer's feel. These
  // are LIVE: they write the number and the seal reads it on its next frame,
  // with no re-deal (a re-deal would send the seal off and back for every
  // notch). The loops themselves are the Seal motion panel below.
  ['levelUpSeal', 'freeHeight', 0.1, 0.6, 0.01, 'seal: body length (of height)', true],
  ['levelUpSeal', 'inTime', 0.2, 2, 0.05, 'seal: swim up (s)', true],
  ['levelUpSeal', 'outTime', 0.1, 1.5, 0.05, 'seal: swim off (s)', true],
  ['levelUpSeal.motion', 'blendRate', 0.5, 12, 0.1, 'seal: hover blend (/s)', true],
  ['levelUpSeal.motion', 'takeRate', 0.5, 12, 0.1, 'seal: loop takes over (/s)', true],
  ['levelUpSeal.pull', 'weight', 0, 1, 0.02, 'pull: amount', true],
  ['levelUpSeal.pull', 'speed', 0.1, 4, 0.05, 'pull: speed (x run)', true],
  ['levelUpSeal.pull', 'standoff', 0, 2, 0.02, 'pull: hold off card (lengths)', true],
  ['levelUpSeal.pull', 'arrive', 0.05, 2, 0.02, 'pull: ease to stop (lengths)', true],
  ['levelUpSeal.pull', 'turnWeight', 0, 1, 0.02, 'pull: turn after swim', true],
  ['levelUpSeal', 'followTurn', 0, 0.8, 0.01, 'cursor: body yaw (rad)', true],
  ['levelUpSeal', 'followLean', 0, 0.4, 0.01, 'cursor: body cant (rad)', true],
  ['levelUpSeal', 'followLerp', 0.5, 12, 0.1, 'cursor: ease (/s)', true],
  ['levelUpSeal', 'pointFaceOut', 0, 1, 0.02, 'head: face out while pointing', true],
  ['levelUpSeal', 'aimLerp', 1, 20, 0.5, 'head: look ease (/s)', true],
  ['levelUpSeal', 'aimSpread', 0, 1, 0.02, 'head: look spread', true],
];
const knobs = document.getElementById('knobs');
// A group may be a dotted path — upgradeHive.fly lives two deep — so the knob
// resolves it rather than assuming one level. Without this the flight's numbers
// could not be reached from here at all.
const at = (path) => path.split('.').reduce((o, k) => o?.[k], CONFIG);

for (const [group, key, min, max, step, label, live] of KNOBS) {
  const row = document.createElement('div');
  row.className = 'row';
  const id = `k-${group.replace(/\./g, '-')}-${key}`;
  const holder = at(group) ?? (at(group.split('.').slice(0, -1).join('.'))[group.split('.').pop()] = {});
  row.innerHTML = `<label for="${id}">${label}</label>`
    + `<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${holder[key] ?? min}" />`
    + `<output>${holder[key] ?? min}</output>`;
  knobs.appendChild(row);
  row.querySelector('input').addEventListener('input', (e) => {
    holder[key] = Number(e.target.value);
    row.querySelector('output').textContent = e.target.value;
    if (live) return; // read on the seal's next frame; nothing to re-run
    syncTime();
    replay();
  });
}

const tEl = document.getElementById('t');
const tOut = document.getElementById('tOut');
function syncTime() {
  tEl.max = screenSeconds().toFixed(2);
  if (Number(tEl.value) > Number(tEl.max)) tEl.value = tEl.max;
  tOut.textContent = Number(tEl.value).toFixed(2);
}
tEl.addEventListener('input', () => {
  tOut.textContent = Number(tEl.value).toFixed(2);
  // SCRUB IS FOR THE SLAM. The reel drives its columns from its own rAF loop
  // and re-fires the comb's animations as it lands each one; holding all of
  // that still needs the page to own three clocks at once, and the version that
  // tried showed the columns in the right place with the pulses missing
  // entirely — a tool that renders a moment the game never has is worse than
  // one that admits it cannot. Live is exact for both.
  if (CONFIG.upgradeArrival === 'reel') {
    readEl.textContent = 'scrub is slam-only — the reel runs its own clock. Use Live.';
    return;
  }
  setMode(true);
  scrubTo(Number(tEl.value));
});

const liveBtn = document.getElementById('live');
const scrubBtn = document.getElementById('scrubMode');
const shutBtn = document.getElementById('shut');
function setMode(scrub) {
  scrubbing = scrub;
  liveBtn.setAttribute('aria-pressed', String(!scrub));
  scrubBtn.setAttribute('aria-pressed', String(scrub));
}
function replay() {
  if (scrubbing) scrubTo(Number(tEl.value));
  else { pending = []; deal(); release(); }
}

// EVERY BUTTON IN THE PANEL, FROM ONE LISTENER ON THE WINDOW — and it has to be
// this way round rather than a handler per button.
//
// The menu skips its arrival on ANY click (see bindSlamSkip in ui/ui.js), which
// is a listener on the window in capture. To stop a click on a slider from
// cutting the arrival short, this page registers first and calls
// stopImmediatePropagation — and that stops the event reaching the button's own
// handler too, because the target's listeners run after the capture phase it
// was killed in. Every control in this panel was dead and looked merely
// unresponsive: the sliders kept working, because they act on `input` rather
// than on `click`, so the panel was half alive and gave no reason to suspect
// the listener.
//
// So the swallow does the work as well. A click OUTSIDE the panel is left
// alone, because skipping the arrival by clicking the screen is the thing being
// looked at.
window.addEventListener('click', (e) => {
  if (!panel.contains(e.target)) return;
  e.stopImmediatePropagation();
  const id = e.target instanceof HTMLElement ? e.target.id : '';
  if (id === 'roll') replay();
  else if (id === 'hand') { seed = (seed + 7919) >>> 0; replay(); }
  else if (id === 'live') { setMode(false); pending = []; deal(); release(); }
  else if (id === 'scrubMode') { setMode(true); scrubTo(Number(tEl.value)); }
  else if (id === 'changed') {
    // THIS PAGE CANNOT SAVE, and that is deliberate — it is a static build
    // behind a server with no tuning endpoint, so it can never write over the
    // live tuning from a stale snapshot (see SERVERS.md). What it can do is
    // tell you exactly what you changed, in the shape config.js wants, so the
    // numbers can go into the file or be typed into the game's own tuner —
    // where they persist.
    const lines = [];
    // DESCENDS ONE LEVEL, because BASE is a shallow copy: a nested block like
    // `upgradeSlam.riser` is the SAME object in both, so an identity compare
    // says nothing changed no matter what was moved inside it. One level is
    // enough for every group here and keeps the readout flat.
    const diff = (group, base, now, prefix) => {
      for (const [k, v] of Object.entries(now)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) { diff(group, base[k] ?? {}, v, `${prefix}${k}.`); continue; }
        if (base[k] !== v) lines.push(`  ${group}.${prefix}${k}: ${JSON.stringify(v)},`);
      }
    };
    for (const group of ['upgradeSlam', 'upgradeComb', 'upgradeReel', 'levelUpSeal']) {
      diff(group, BASE[group], CONFIG[group], '');
    }
    if (CONFIG.upgradeArrival !== BASE.upgradeArrival) {
      lines.push(`  upgradeArrival: ${JSON.stringify(CONFIG.upgradeArrival)},`);
    }
    const text = lines.length ? lines.join('\n') : 'nothing changed yet';
    readEl.textContent = text;
    // Selectable in the panel whatever the clipboard does — a pane or an
    // iframe can refuse the write, and a button that silently does nothing is
    // worse than one that shows you the answer.
    navigator.clipboard?.writeText(text).catch(() => {});
  } else if (id === 'arrival') {
    CONFIG.upgradeArrival = CONFIG.upgradeArrival === 'reel' ? 'slam' : 'reel';
    e.target.textContent = `Arrival: ${CONFIG.upgradeArrival}`;
    syncTime();
    replay();
  } else if (id === 'shut') {
    const shut = panel.classList.toggle('shut');
    shutBtn.textContent = shut ? '+' : '–';
  } else if (id === 'exit') {
    // The real way out: taking a card. There is no other one — the drain is
    // what a pick does, so a button that played it some other way would be
    // showing an animation the game does not have.
    const cards = document.querySelectorAll('#svCards .sv-card');
    cards[Math.floor(cards.length / 2)]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  } else if (id === 'skip') {
    // Not handled here — re-dispatched at the body, where it is outside the
    // panel and reaches the menu's own skip like any click on the screen.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
}, true);
// Keys are only swallowed. Nothing in the panel acts on one, and letting a key
// through while a slider has focus would skip the arrival being tuned.
window.addEventListener('keydown', (e) => {
  if (panel.contains(e.target)) e.stopImmediatePropagation();
}, true);

// A WHEEL OVER A SLIDER IS NOT AN EDIT. Chrome changes a hovered range input's
// value on scroll, and this panel is a stack of them under a page that has
// nowhere to scroll — so passing over it on the way to the cards silently
// retunes the screen, and the next thing you look at is not the thing you set.
// Found by watching a value fall between two screenshots.
panel.addEventListener('wheel', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'range') e.preventDefault();
}, { passive: false });

// A HANDLE FOR THE CONSOLE. This page is where the numbers get argued about,
// and reading them back out of a slider is slower than asking. Nothing in the
// page uses it.
window.CONFIG = CONFIG;

toggleHive(true);
syncTime();
setMode(false);
deal();
