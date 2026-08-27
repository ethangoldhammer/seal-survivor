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

// A compare frame is driven from its parent, so both sides roll on one press.
window.addEventListener('message', (e) => { if (e.data === 'roll') replay(); });

// What has been picked so far, so the corner fills up the way it does in a run
// and every flight after the first has a hive that has already made room.
const taken = [];

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
  report();
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
for (const group of ['upgradeSlam', 'upgradeComb', 'upgradeReel']) {
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
];
const knobs = document.getElementById('knobs');
// A group may be a dotted path — upgradeHive.fly lives two deep — so the knob
// resolves it rather than assuming one level. Without this the flight's numbers
// could not be reached from here at all.
const at = (path) => path.split('.').reduce((o, k) => o?.[k], CONFIG);

for (const [group, key, min, max, step, label] of KNOBS) {
  const row = document.createElement('div');
  row.className = 'row';
  const id = `k-${group.replace(/\./g, '-')}-${key}`;
  row.innerHTML = `<label for="${id}">${label}</label>`
    + `<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${at(group)[key]}" />`
    + `<output>${at(group)[key]}</output>`;
  knobs.appendChild(row);
  row.querySelector('input').addEventListener('input', (e) => {
    at(group)[key] = Number(e.target.value);
    row.querySelector('output').textContent = e.target.value;
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
    for (const group of ['upgradeSlam', 'upgradeComb', 'upgradeReel']) {
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
