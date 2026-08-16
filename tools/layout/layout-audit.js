// ---------------------------------------------------------------------------
// npm run layout — every UI surface, at every viewport the game is played on.
//
// WHAT THIS IS FOR. The interface is one stylesheet written at desktop size and
// there is no way, from a laptop, to see what a 375px phone does to it. The
// failures are not subtle when you are holding the phone and are invisible when
// you are not: a tutorial line set `white-space: nowrap` at 24px runs off both
// edges of the screen, a row of four buttons wraps into a column that pushes
// the leaderboard off the bottom, a 30px button is a tap target iOS itself
// calls too small. Each of those is a layout question with a numeric answer,
// so this measures them instead of asking somebody to look.
//
// WHY IFRAMES, and this is the whole design. `window.innerWidth`, `vw`, `vh`,
// `dvh` and every media query resolve against the VIEWPORT, and a page cannot
// change its own. An iframe has a viewport of its own, exactly the size you
// give it — so a 375x667 frame is genuinely a 375x667 browser as far as
// everything inside it can tell, and the numbers this reads back are the ones
// the phone would produce. Scaling a desktop render down, which is the obvious
// alternative, measures nothing: every one of these bugs is about how the
// layout RESPONDS to a width, and a transform doesn't change the width.
//
// IT BUILDS THE REAL UI. initUI() from path/src/ui/ui.js, the real stylesheet,
// the real markup, the real callout table — not a copy of the markup in this
// file, which would be a copy that passes after the real one has broken.
//
// A STATIC BUILD, SERVED READ-ONLY, for the reason in tools/looks/serve.mjs:
// the game's dev server is the sole writer of imported-tuning.json and a second
// one on another port flattens whatever tuning is live. Nothing here can write
// it — the server this is served from has no such endpoint.
//
// WHAT IT CANNOT SEE: anything positioned per frame from the seal's projected
// world position — the floating hp/air bars, the score toasts, the small line
// above the boost ring. Those are pinned to a creature in a running game rather
// than laid out by CSS, so a static measurement of them would be a measurement
// of wherever they last happened to be. They are skipped by name (PER_FRAME
// below) rather than silently passing.
// ---------------------------------------------------------------------------

// The devices, and why each one is in the list. Width and height are CSS
// pixels — the numbers a page actually sees, not the marketing resolution.
const VIEWPORTS = [
  { name: 'iPhone SE', w: 375, h: 667, touch: true },
  { name: 'iPhone 15', w: 393, h: 852, touch: true },
  { name: 'iPhone 15 Pro Max', w: 430, h: 932, touch: true },
  // Landscape is not a rotation of the above, it is a different problem: 393px
  // of HEIGHT is less room than any menu in this game was designed for.
  { name: 'iPhone 15 landscape', w: 852, h: 393, touch: true },
  { name: 'iPad mini', w: 744, h: 1133, touch: true },
  { name: 'iPad landscape', w: 1024, h: 768, touch: true },
  { name: 'Laptop', w: 1280, h: 800, touch: false },
  { name: 'Desktop', w: 1920, h: 1080, touch: false },
];

// The surfaces, by the name previewScreen() already knows, plus the two it has
// no word for. `coach` is the first-run tutorial band — the longest line in
// callouts.csv, which is the one that has to fit.
const SURFACES = ['start', 'HUD', 'coach', 'boss', 'cards', 'score card'];

// Apple's Human Interface Guidelines minimum, and the reason a button can look
// fine and still be missed by a thumb.
const TAP_MIN = 44;

// Positioned per frame from a world position; see the header.
const PER_FRAME = [
  '.sv-playerbars', '.sv-toast', '.sv-chain',
  '.sv-callout-boost', '.sv-callout-arrow', '.sv-card-fx',
];

const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// THE PARENT — one iframe per (viewport x surface), and the report.
// ---------------------------------------------------------------------------

// HOW MANY TILES STAY LIVE AT ONCE.
//
// Every frame boots the real UI, and the real UI brings up Rive — which means a
// WebGL context per tile. Browsers cap those at around sixteen and then start
// killing the oldest, so the first attempt at this (all forty-eight frames at
// once, which is the obvious way to write it) hung: two thirds of the tiles lost
// their context before they could measure and simply never reported. The sweep
// is sequential now and old frames are unloaded behind it, which is also the
// only way the numbers can be trusted — forty-eight simultaneous boots on one
// thread is a machine under load, and layout is not what it would be measuring.
const LIVE_TILES = 6;

function runParent() {
  const grid = document.getElementById('grid');
  const summary = document.getElementById('summary');
  const results = [];
  const live = [];

  // Tiles are rendered at a fixed scale so a phone and a desktop sit side by
  // side. The iframe itself is FULL SIZE — the transform is on the wrapper and
  // applies after layout, so nothing inside is ever measured at anything other
  // than the real device width.
  const scaleFor = (v) => Math.min(1, 300 / v.w);
  const jobs = [];

  for (const v of VIEWPORTS) {
    for (const surface of SURFACES) {
      const scale = scaleFor(v);
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.width = `${Math.round(v.w * scale) + 2}px`;
      cell.innerHTML = `<h2>${v.name} · ${v.w}x${v.h} · ${surface}</h2>`;

      const clip = document.createElement('div');
      clip.className = 'clip';
      clip.style.cssText = `width:${v.w * scale}px; height:${v.h * scale}px; overflow:hidden; position:relative;`;
      cell.appendChild(clip);

      const list = document.createElement('div');
      list.className = 'findings';
      list.textContent = 'queued';
      cell.appendChild(list);
      grid.appendChild(cell);

      const src = `./layout-audit.html?frame=1&surface=${encodeURIComponent(surface)}&touch=${v.touch ? 1 : 0}`;
      const mount = () => {
        const frame = document.createElement('iframe');
        frame.width = v.w;
        frame.height = v.h;
        frame.style.cssText = `width:${v.w}px; height:${v.h}px; transform:scale(${scale}); transform-origin:0 0;`;
        clip.innerHTML = '';
        clip.appendChild(frame);
        // Unloading is what actually frees the GL context; removing the element
        // alone leaves it to the collector, which is far too late.
        live.push(() => { frame.src = 'about:blank'; frame.remove(); });
        while (live.length > LIVE_TILES) live.shift()();
        frame.src = src;
        return frame;
      };

      // Clicking a spent tile brings it back, so any one of these can be looked
      // at properly after the sweep has moved on.
      clip.addEventListener('click', () => { if (!clip.firstChild) mount(); });
      jobs.push({ v, surface, mount, list });
    }
  }

  (async () => {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      summary.innerHTML = `measuring ${i + 1} / ${jobs.length} — ${job.v.name} ${job.surface}`;
      job.list.textContent = 'measuring…';
      const findings = await measureOne(job);
      results.push({ viewport: job.v.name, w: job.v.w, h: job.v.h, surface: job.surface, findings });
      job.list.innerHTML = findings.length
        ? findings.map((f) => `<div class="${f.type === 'tap' ? 'tap' : ''}">${escapeHtml(describe(f))}</div>`).join('')
        : '<div class="ok">clean</div>';
    }
    finish(results, summary);
  })();
}

// One tile: mount it, wait for its report, and treat silence as a finding of its
// own — a surface that throws on the way up looks exactly like one that fits, if
// you only count the failures that were able to report themselves.
function measureOne(job) {
  return new Promise((done) => {
    const frame = job.mount();
    let settled = false;
    const settle = (findings) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      done(findings);
    };
    const onMessage = (e) => {
      // Keyed on the frame's own window: the message carries no identity of its
      // own that could be trusted, and every tile sends the same shape.
      if (e.source !== frame.contentWindow || e.data?.kind !== 'sv-layout') return;
      settle(e.data.findings ?? []);
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(
      () => settle([{ type: 'threw', what: 'the frame never reported — see the console' }]),
      15000,
    );
  });
}

let finished = false;
function finish(results, summary, silent = 0) {
  if (finished) return;
  finished = true;

  const total = results.reduce((n, r) => n + r.findings.length, 0);
  const bad = results.filter((r) => r.findings.length);
  const lines = [
    total === 0
      ? '<span class="ok">Clean — every surface fits every viewport.</span>'
      : `<span class="bad">${total} finding(s) across ${bad.length} of ${results.length} surface/viewport pairs.</span>`,
  ];
  if (silent) lines.push(`<span class="bad">${silent} frame(s) never reported.</span>`);
  for (const r of bad) {
    lines.push(`\n<b>${r.viewport} ${r.w}x${r.h} — ${r.surface}</b>`);
    for (const f of r.findings) lines.push(`  ${escapeHtml(describe(f))}`);
  }
  summary.innerHTML = lines.join('\n');

  // Back to the terminal. `npm run layout` prints this and exits non-zero on a
  // finding, so it can be run the way the other checks in this repo are.
  fetch('/report/layout.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results, total, silent }),
  }).catch(() => {});
}

function describe(f) {
  if (f.type === 'tap') return `${f.what} — tap target ${f.w}x${f.h}, under ${TAP_MIN}`;
  if (f.type === 'clipped') return `${f.what} — clipped, content ${f.contentW}px in a ${f.boxW}px box`;
  if (f.type === 'threw') return `surface failed to build — ${f.what}`;
  return `${f.what} — ${f.type} by ${f.by}px`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---------------------------------------------------------------------------
// THE FRAME — build one surface, measure it, report it.
// ---------------------------------------------------------------------------

async function runFrame(surface) {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0; background:#05060a; overflow:hidden;';
  const findings = [];

  try {
    const ui = await import('../../path/src/ui/ui.js');
    const callout = await import('../../path/src/ui/callout.js');
    const callouts = await import('../../path/src/systems/callouts.js');

    const noop = () => {};
    ui.initUI({
      onStart: noop, onRestart: noop, onLevelChoice: noop,
      onResume: noop, onPauseRestart: noop,
    });
    callout.initCallouts(ui.uiRoot());

    // The hand this device is held in. initUI sets .sv-touch from the real
    // media query, and an iframe inherits `pointer: coarse` from the machine
    // the browser is running on rather than from the device it is standing in
    // for — so on a laptop every tile would come up as mouse-driven and the
    // tap-target rules would never be exercised, which is the same as not
    // having them. Overridden here to what this viewport actually is.
    ui.uiRoot()?.classList.toggle('sv-touch', params.get('touch') === '1');

    await buildSurface(surface, ui, callout, callouts);
    // Let the type and the reveal masks land before anything is measured — both
    // settle asynchronously, and a box measured first is a box that is about to
    // change size.
    //
    // A TIMER RATHER THAN requestAnimationFrame, which is what this said first.
    // The Browser pane suspends rAF, so `await nextFrame()` never resolved and
    // the frame hung forever without an error to show for it. A timer does not
    // care whether anything is being painted, and neither does layout —
    // getBoundingClientRect forces it regardless.
    await document.fonts?.ready;
    await settle(120);

    findings.push(...measure());
  } catch (err) {
    console.error(err);
    findings.push({ type: 'threw', what: String(err?.message ?? err) });
  }

  parent.postMessage({ kind: 'sv-layout', findings }, '*');
}

async function buildSurface(surface, ui, callout, callouts) {
  // The numbers are a plausible mid-run: a four-figure score, a level in
  // double digits (which is wider than "1"), and health worth drawing.
  const gameState = { score: 128400, time: 421, level: 14, xp: 60, xpToNext: 100 };
  const player = {
    hp: 62, oxygen: 40,
    stats: { maxHp: 100, maxOxygen: 100 },
    mesh: { position: { x: 0, y: 0, z: 0 } },
  };

  if (surface === 'cards') {
    ui.previewScreen('cards');
    return;
  }
  if (surface === 'score card') {
    ui.previewScreen('score card');
    // The trophy row is hidden unless a boss died this run, and it is the row
    // the share buttons live in — the whole reason this surface is audited. The
    // fan is empty here (the prints are frames grabbed off a live renderer),
    // so what this measures is the button row and the card around it.
    document.getElementById('svTrophy')?.classList.remove('sv-hidden');
    return;
  }
  if (surface === 'start') {
    ui.previewScreen('start');
    return;
  }

  // Everything else is the HUD, with something extra on it.
  ui.previewScreen('HUD');
  // The rapid-fire timer is still passed — it is live during a real run — but
  // nothing draws it any more, so it no longer adds a panel to the corner.
  ui.updateHUD(gameState, player, null, 8.4, null);

  if (surface === 'boss') {
    // A long name on purpose: bossNames.csv builds three-part names, and the
    // bar has to hold the worst of them.
    ui.updateBossBar({ name: 'Wicked Grimgullet the Chumbucket Rumbler', hp: 4200, maxHp: 9000 });
  }

  if (surface === 'coach') {
    // THE LONGEST LINE IN THE TABLE, for this frame's device. Not a made-up
    // string: a hand-typed sample would keep passing after somebody wrote a
    // longer tip into callouts.csv, which is exactly when this needs to fail.
    //
    // CALLOUTS is a Map keyed by id, and the wording is per device — a touch
    // player and a keyboard player are shown different sentences of different
    // lengths, so the worst line is asked for rather than assumed.
    const device = params.get('touch') === '1' ? 'touch' : 'kbm';
    const { calloutText } = await import('../../path/src/calloutTable.js');
    let longest = null;
    let longestLen = 0;
    for (const row of callouts.CALLOUTS.values()) {
      if (row.anchor !== 'band') continue;
      const text = calloutText(row, device) ?? '';
      if (text.length > longestLen) { longestLen = text.length; longest = row; }
    }
    if (longest) {
      callouts.pushCallout(longest);
      // Stepped to the middle of its hold so the arrival curve has finished:
      // at age 0 the band is scaled to nothing, and a box of zero size fits
      // every screen ever made.
      callouts.bandStates.band.age = callouts.holdFor(longest) * 0.5;
      callout.updateCalloutUi(0.016, { device });
    }
  }
}

function settle(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- the measurement --------------------------------------------------------

function measure() {
  const findings = [];
  const W = window.innerWidth;
  const H = window.innerHeight;
  const seen = new Set();

  for (const node of document.querySelectorAll('.sv-ui, .sv-ui *, .sv-callout-layer, .sv-callout-layer *')) {
    if (PER_FRAME.some((sel) => node.closest(sel))) continue;
    // Full-bleed layers (.sv-ui, .sv-center, .sv-toast-layer) are inset:0 by
    // definition and would report themselves as exactly filling the screen,
    // which is not a finding — it is the point of them.
    if (node.classList.contains('sv-ui') || node.classList.contains('sv-center')) continue;

    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

    const what = path(node);
    // One finding per element per type. A deeply nested run of spans that all
    // overflow because their parent does is one bug, and reporting it eleven
    // times buries the ten other bugs on the screen.
    const once = (type, extra) => {
      const key = `${what}|${type}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ type, what, ...extra });
    };

    // Off the edges. Rounded, because sub-pixel layout puts half a pixel of
    // everything past every boundary and none of it is visible.
    //
    // UNLESS IT CAN BE SCROLLED TO. A score card on a phone held sideways is
    // genuinely taller than the screen and is meant to be — the menu scrolls
    // (see the short-screen block in ui.js) and everything in it is one flick
    // away. getBoundingClientRect cannot tell that apart from lost: it reports
    // unclipped positions, so a button below the fold of a scroll box reads as
    // 12px off the bottom of the world. Reporting it would be reporting the fix
    // as the bug, and worse, it would train whoever runs this to ignore the
    // off-bottom line — which is the one that catches the real thing.
    if (!scrollableAncestor(node)) {
      if (r.left < -1) once('off-left', { by: Math.round(-r.left) });
      if (r.right > W + 1) once('off-right', { by: Math.round(r.right - W) });
      if (r.top < -1) once('off-top', { by: Math.round(-r.top) });
      if (r.bottom > H + 1) once('off-bottom', { by: Math.round(r.bottom - H) });
    }

    // Clipped by its own box — the `overflow: hidden` case, where nothing goes
    // off screen and the text is cut off anyway.
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
    if (clips && node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
      once('clipped', { contentW: node.scrollWidth, boxW: node.clientWidth });
    }

    // Tap targets, which only matter where there is a thumb.
    const tappable = node.matches('button, input, [role="button"], .sv-card, .sv-fan-slot');
    if (tappable && params.get('touch') === '1' && (r.width < TAP_MIN || r.height < TAP_MIN)) {
      once('tap', { w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return findings;
}

// AT THE BOTTOM, and it has to be. Function declarations hoist but `const` does
// not, and runParent() reaches LIVE_TILES on its first tick — dispatching from
// the top of the file threw a TDZ ReferenceError out of an async function,
// where it surfaced as forty-eight tiles that simply never reported.
if (params.get('frame')) runFrame(params.get('surface'));
else runParent();

/**
 * Is this element inside something that actually scrolls? Not merely something
 * with `overflow: auto` — a box whose content fits has auto overflow and no
 * scrollbar, and anything hanging out of THAT is as lost as it looks. The
 * overflowing content is the half that makes it reachable.
 */
function scrollableAncestor(node) {
  for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    const scrollsY = (s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1;
    const scrollsX = (s.overflowX === 'auto' || s.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1;
    if (scrollsY || scrollsX) return p;
  }
  return null;
}

// A short, readable identity for an element: what you would type to find it.
function path(node) {
  const tag = node.tagName.toLowerCase();
  if (node.id) return `${tag}#${node.id}`;
  const cls = [...node.classList].filter((c) => c !== 'sv-fade-in').slice(0, 2).join('.');
  const self = cls ? `${tag}.${cls}` : tag;
  const parentId = node.parentElement?.id;
  return parentId ? `#${parentId} > ${self}` : self;
}
