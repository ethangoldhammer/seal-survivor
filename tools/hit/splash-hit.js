// ---------------------------------------------------------------------------
// npm run test:splashhit — WHERE THE TITLE CARD ACTUALLY RESPONDS.
//
// WHAT THIS ADDS OVER THE CHECKS THAT ALREADY EXIST. `npm run test:splashlayout`
// and `npm run layout` both measure where the dice and the Start button are
// DRAWN: they compute the entry column from the artboard's own numbers through
// ui/splashLayout.js and check it against the wordmark, the DOM over the card
// and the screen's edges. Neither one presses anything. Where the artboard's
// listeners actually respond is a fact about the .riv — its hit shapes, its
// layout, its state machine — and the two agreeing has been an assumption for
// as long as the splash has existed. A button drawn in the right place with its
// listener somewhere else passes every check in the repo and cannot be pressed.
//
// So this walks synthetic pointer events over the real artboard and bisects the
// edges of the live area, which is the hitbox, in CSS pixels. Three passes per
// device:
//
//   HOVER    the dice and Start, mapped by binary search against the artboard's
//            own `bRandomHover` / `bStartHover` booleans, and compared to the
//            drawn rects. Also the measured tap size, which is the one that
//            matters — a 30px button with a 30px hitbox is a miss whatever the
//            design size says.
//   TOUCH    a real touchstart/touchend on the dice, asserted end to end by the
//            name changing. Rive listens for `mousemove`/`touchstart` on the
//            canvas and NOT for pointer events (node_modules/@rive-app/webgl2,
//            registerTouchInteractions), so a probe written with PointerEvent
//            reports every button dead — which is why this one is written twice
//            and says which path drove the artboard.
//   ROTATION how long the hitbox lags the picture after the box changes. Rive
//            reads `event.currentTarget.getBoundingClientRect()` per event but
//            maps it through the artboard's LAST LAYOUT, and that layout is
//            rebuilt by riveSplash's ResizeObserver plus its resettle ladder
//            (0/60/180/400ms). Anything in between is a card that is drawn in
//            one place and pressed in another — which on a phone is not a rare
//            event but the URL bar collapsing.
//
// IT CHECKS ITS OWN DETECTOR FIRST, the same habit as test:copy and
// test:splashlayout: a corner of the screen must read as dead and the drawn
// centre must read as live before any measurement is believed. A hover boolean
// stuck on, an export without the property, or a state machine that is not
// advancing would otherwise produce a clean sweep that means nothing.
//
// WHAT IT FOUND THE DAY IT WAS WRITTEN, because a tool's first answer is the
// best description of what it is for. The hitboxes do not follow
// `numEntryScale`. At scale 1 they are exact — 81x81 over an 80x80 button, on
// the pixel. Below 1 they slide down and to the right by about 40 x (1 - scale)
// pixels, which is half the design button size, while the picture shrinks about
// its own centre:
//
//   scale 1     Desktop             0px off
//   scale 0.74  Laptop             12px off, 59px buttons
//   scale 0.58  iPad landscape     18px off
//   scale 0.42  iPad mini          25px off, 34px buttons
//   scale 0.28  iPhone landscape   30px off, 21px buttons
//   scale 0.20  iPhone SE          NOTHING responds anywhere on the screen
//
// The scale is a function of the name in the pill (the column hugs it) and of
// the screen, so the same phone answers differently to the same tap depending
// on what the dice last rolled — which is what "inconsistent on mobile" is.
// A fix belongs in the .riv: this is the artboard's hit shapes not being laid
// out by the same numbers as its graphics.
//
// A RENDERER THAT WEDGES. Perhaps one device in three stops answering part way
// through — the page goes silent, its own heartbeat with it, and no report ever
// arrives. It has not been traced to a cause. tools/splash-hit-test.mjs drives
// ONE BROWSER PER DEVICE so a wedge costs one device rather than the run, and
// retries it once in a fresh window; a device that is silent twice is reported
// as a finding rather than dropped. `--trace` prints a line per sample through
// the renderer's console, which is where to start if it is ever chased down.
//
// WHY IFRAMES: the same reason as tools/layout/layout-audit.js. The artboard is
// fitted `Layout`, so its geometry is a function of the viewport, and a page
// cannot change its own. A frame's viewport is exactly the box you give it.
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);

// The devices, shared with the Node side — see tools/hit/devices.js for why it
// is a module rather than a list in each of them.
import { VIEWPORTS } from './devices.js';

// Apple's minimum, and the reason a button can look fine and still be missed.
const TAP_MIN = 44;

// HOW FAR THE HITBOX MAY SIT FROM THE PICTURE before it is a finding, in CSS
// pixels. Not zero: the bisection below stops at about a pixel, the artboard
// rounds its own layout, and a hit shape drawn a pixel proud of its glyph is a
// design decision rather than a bug. Anything a thumb could notice is several
// times this.
const EDGE_TOL = 4;

// One sample: dispatch, then let Rive advance. The runtime hit-tests inside its
// own advance and writes the hover boolean there, so a value read on the same
// tick as the event is the PREVIOUS answer — which reads as a hitbox shifted by
// one sample step, i.e. exactly the finding this tool exists to report. Two
// frames at the shimmed 16ms, plus room.
const STEP_MS = 40;

// Long enough for the artboard to load, for the entry fit to settle (it lands a
// beat after the pill's width is first reported) and for the row to stop moving.
// The layout audit uses the same 900 for the same reason.
const SETTLE_MS = 900;

// The bisection depth. Each step halves the interval, so 7 over the ~200px
// opening span lands inside two pixels, which is under EDGE_TOL.
const BISECT = 7;

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** What this frame is doing, for the terminal. See the listener in runParent. */
const say = (label) => { try { parent.postMessage({ kind: 'sv-hit-progress', label }, '*'); } catch { /* nothing to say to */ } };

// ---------------------------------------------------------------------------
// THE PARENT — one tile per device, in sequence.
// ---------------------------------------------------------------------------

// ONE LIVE TILE AT A TIME, and unloaded the moment it has reported. The layout
// audit keeps six because its tiles are stills you go back and look at; these
// are not, and two of them at once wedged the renderer every time — tile one
// finished, tile two mounted its own Rive over the top of a card that was still
// advancing, and the whole page went silent inside a minute with no error to
// show for it. It is also the only way the rotation pass can be trusted: it
// measures how long a resize takes to reach the artboard, and a second artboard
// drawing beside it is exactly the load that would change the answer.

function runParent() {
  // ONE DEVICE, when you are chasing one device. `--only iphone` from the
  // terminal, matched loosely on the name: a sweep is two minutes and a single
  // tile is fifteen seconds, and the difference is whether a fix gets tried
  // three times or once.
  const only = (params.get('only') ?? '').toLowerCase();
  const devices = only ? VIEWPORTS.filter((v) => v.name.toLowerCase().includes(only)) : VIEWPORTS;

  const grid = document.getElementById('grid');
  const summary = document.getElementById('summary');
  const results = [];
  const jobs = [];

  // WHICH PASS EACH TILE IS ON, forwarded to the terminal. A tile is a minute of
  // silence by itself — mount, two bisections, a touch pass, two rotations — so
  // without this a stall names the device and nothing else, and the device is
  // the half you can already guess. The frame cannot post to /report/progress
  // itself: the run token is in the parent's URL and not in the frame's.
  let at = { i: 0, total: devices.length, name: '' };
  // A HEARTBEAT FROM THE PARENT, which is a different fact from the frame's own
  // pings: a tile is a minute of work and the frame can be stuck inside it, but
  // if this keeps arriving the page is alive and its per-tile timeout will fire.
  // Silence on BOTH is the renderer itself gone — a lost GL context, a wedged
  // wasm — and the two failures want different fixes, so the tool has to be able
  // to tell them apart.
  setInterval(() => progress(at.i, at.total, `${at.name} — still working`), 8000);
  window.addEventListener('message', (e) => {
    if (e.data?.kind !== 'sv-hit-progress') return;
    progress(at.i, at.total, `${at.name} — ${e.data.label}`);
  });

  for (const v of devices) {
    // The tile is drawn small and measured full size: the transform is on the
    // wrapper and applies after layout, so nothing inside is ever laid out at
    // anything but the real device width.
    const scale = Math.min(1, 260 / v.w);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.width = `${Math.round(v.w * scale) + 2}px`;
    cell.innerHTML = `<h2>${v.name} · ${v.w}x${v.h}</h2>`;

    const clip = document.createElement('div');
    // Tall enough for the rotation pass, which makes the frame landscape and
    // back inside its own tile.
    clip.style.cssText = `width:${v.w * scale}px; height:${Math.max(v.h, v.w) * scale}px; overflow:hidden; position:relative;`;
    cell.appendChild(clip);

    const list = document.createElement('div');
    list.className = 'findings';
    list.textContent = 'queued';
    cell.appendChild(list);
    grid.appendChild(cell);

    // FORWARDED, or they do nothing at all. `trace` and `name` are read by the
    // FRAME and given to the parent's URL by the terminal, and a parent that
    // keeps them to itself is a --trace that prints nothing and a --name that
    // is silently ignored — both of which look exactly like the flag working
    // and having no effect.
    const carried = ['trace', 'name'].filter((k) => params.get(k)).map((k) => `&${k}=${encodeURIComponent(params.get(k))}`).join('');
    const src = `./splash-hit.html?frame=1&touch=${v.touch ? 1 : 0}${carried}`;
    const mount = () => {
      const frame = document.createElement('iframe');
      frame.width = v.w;
      frame.height = v.h;
      frame.style.cssText = `width:${v.w}px; height:${v.h}px; transform:scale(${scale}); transform-origin:0 0;`;
      clip.innerHTML = '';
      clip.appendChild(frame);
      frame.src = src;
      return frame;
    };
    // Unloading is what frees the GL context; removing the element alone leaves
    // it to the collector, which is far too late — and the collector is not what
    // is standing between this and the next artboard.
    const unload = (frame) => {
      try { frame.src = 'about:blank'; } catch { /* already gone */ }
      frame.remove();
      clip.innerHTML = '<span style="color:#4a5666">measured</span>';
    };
    jobs.push({ v, mount, unload, list });
  }

  (async () => {
    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        summary.textContent = `measuring ${i + 1} / ${jobs.length} — ${job.v.name}`;
        job.list.textContent = 'measuring…';
        at = { i, total: jobs.length, name: job.v.name };
        // BEFORE the tile, not after: this is what the terminal's stall
        // watchdog reads, and a tile that never comes back has to have been
        // named by the ping that went out before it started.
        progress(i, jobs.length, job.v.name);
        const { findings, detail } = await measureOne(job);
        // Before the next one is built, never after: the whole reason this
        // sweep is sequential is that two artboards do not coexist here.
        await new Promise((r) => setTimeout(r, 250));
        results.push({ viewport: job.v.name, w: job.v.w, h: job.v.h, findings, detail });
        job.list.innerHTML = findings.length
          ? findings.map((f) => `<div class="${f.type === 'tap' ? 'tap' : ''}">${escapeHtml(describe(f))}</div>`).join('')
          : '<div class="ok">clean</div>';
      }
      finish(results, summary);
    } catch (err) {
      // A throw in the loop itself is not covered by the per-tile findings, and
      // an unawaited async IIFE rejecting leaves the terminal waiting forever
      // with nothing to show. Report what was measured and say what stopped it.
      console.error(err);
      results.push({
        viewport: '—', w: 0, h: 0,
        findings: [{ type: 'threw', what: String(err?.message ?? err) }],
        detail: null,
      });
      finish(results, summary);
    }
  })();
}

// One tile, with silence treated as a finding of its own: a frame that throws on
// the way up looks exactly like one that passes, if you only count the failures
// that were able to report themselves.
//
// The budget is generous because this tile is not a still — it mounts a 1.7MB
// artboard, bisects four edges twice, presses the dice, and rotates the frame
// through two more settles.
function measureOne(job) {
  return new Promise((done) => {
    const frame = job.mount();
    let settled = false;
    const land = (payload) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      job.unload(frame);
      done(payload);
    };
    const onMessage = (e) => {
      // Keyed on the frame's own window: the message carries no identity of its
      // own that could be trusted, and every tile sends the same shape.
      if (e.source !== frame.contentWindow || e.data?.kind !== 'sv-hit') return;
      land({ findings: e.data.findings ?? [], detail: e.data.detail ?? null });
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(
      () => land({ findings: [{ type: 'threw', what: 'the frame never reported — see the console' }], detail: null }),
      60000,
    );
  });
}

function progress(i, total, label) {
  try {
    fetch(`/report/progress${runQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ i, total, label }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* a page that cannot report progress still measures */ }
}

let finished = false;
function finish(results, summary) {
  if (finished) return;
  finished = true;
  const total = results.reduce((n, r) => n + r.findings.length, 0);
  const bad = results.filter((r) => r.findings.length);
  const lines = [
    total === 0
      ? 'Clean — every button responds where it is drawn, at every viewport.'
      : `${total} finding(s) across ${bad.length} of ${results.length} devices.`,
  ];
  for (const r of bad) {
    lines.push(`\n${r.viewport} ${r.w}x${r.h}`);
    for (const f of r.findings) lines.push(`  ${describe(f)}`);
  }
  summary.textContent = lines.join('\n');

  fetch(`/report/hit.json${runQuery()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results, total }),
  }).catch(() => {});
}

function runQuery() {
  const run = params.get('run');
  return run ? `?run=${encodeURIComponent(run)}` : '';
}

// Shared with the terminal (tools/splash-hit-test.mjs restates it, deliberately
// — see the note there).
function describe(f) {
  if (f.type === 'hit-offset') return `${f.what} — responds ${f.by}px off where it is drawn (hit ${f.hit}, drawn ${f.drawn})`;
  if (f.type === 'hit-missing') return `${f.what} — nothing responded where it is drawn: ${f.by ?? 'and the probe had nothing more to say'}`;
  if (f.type === 'hit-unread') return `${f.what} — ${f.by}`;
  if (f.type === 'hit-unbounded') return `${f.what} — still live ${f.by}px out; the search found no edge`;
  if (f.type === 'tap') return `${f.what} — hitbox ${f.w}x${f.h}, under ${TAP_MIN}`;
  if (f.type === 'touch-dead') return `${f.what} — ${f.by}`;
  if (f.type === 'hit-stale') return `${f.what} — the old hitbox stayed live ${f.by}ms after the box changed`;
  if (f.type === 'hit-late') return `${f.what} — took ${f.by} to respond after the box changed`;
  if (f.type === 'probe-broken') return `the probe itself — ${f.what}`;
  if (f.type === 'threw') return `the tile failed — ${f.what}`;
  return `${f.what} — ${f.type} ${f.by ?? ''}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---------------------------------------------------------------------------
// THE FRAME — mount the real card at this viewport and press it.
// ---------------------------------------------------------------------------

async function runFrame() {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0; background:#05060a; overflow:hidden;';
  const findings = [];
  const detail = {};
  const touch = params.get('touch') === '1';

  try {
    const { mountRiveSplash } = await import('../../path/src/ui/riveSplash.js');
    const { SPLASH_BINDINGS } = await import('../../path/src/ui/riveContract.js');
    const { entryRects } = await import('../../path/src/ui/splashLayout.js');
    const { savePlayerName } = await import('../../path/src/systems/playerName.js');
    const { sealNameParts, joinPlayerName } = await import('../../path/src/systems/randomName.js');

    // PIN THE NAME, AND PIN IT AT THE WIDEST THE ROLLER CAN PRODUCE.
    //
    // The entry column HUGS the name and the whole column scales to fit the
    // screen (fitEntryScale), so the buttons' size — and, as it turns out,
    // their hitboxes' offset — are a function of how long the name in the pill
    // happens to be. A splash left to roll its own would measure a different
    // scale on every run: two consecutive sweeps here reported 28x28 and 40x40
    // buttons on the same phone, which is a tool that cannot be used to decide
    // anything.
    //
    // The WIDEST rather than a middling one, because scale 1 is the case that
    // already works: every finding this tool has to report gets smaller as the
    // pill gets shorter, and a check pinned to the easy case is a green light.
    // Built out of the shipped table rather than typed here — a name is copy,
    // and the longest pair the roller can actually draw is also the worst case
    // it can put on screen.
    //
    // Written to storage on THIS ORIGIN, which is the probe's own port and
    // nothing else's: the game is served from another one, so no real player's
    // saved name is anywhere near this key.
    const parts = sealNameParts();
    const adjectives = (parts?.adjective ?? []).map((a) => a.text);
    const nicknames = (parts?.nickname ?? []).map((n) => n.text);
    let widest = '';
    for (const nick of nicknames) {
      for (const adj of adjectives) {
        const joined = joinPlayerName(adj, nick);
        if (joined.length > widest.length) widest = joined;
      }
    }
    // `--name` overrides it. The scale is a function of the name's length and
    // every number here moves with the scale, so "what does a player with THIS
    // name meet" is a question worth being able to ask directly — including the
    // short-name case, which is the one that works and therefore the one a fix
    // has to keep working.
    const pinned = params.get('name') || widest;
    if (pinned) savePlayerName(pinned);
    detail.name = pinned;

    // THE REAL CARD, the shipping module and the shipping .riv. No nameSwap and
    // no nameScramble: both are dissolves over the pill, and the touch pass
    // reads the name to decide whether the dice was hit — through a reel that
    // is still flipping, every reading is somebody else's.
    let handle = null;
    say('mounting the card');
    await new Promise((ready, failed) => {
      handle = mountRiveSplash({
        parent: document.body,
        onReady: () => ready(),
        onError: (err) => failed(err instanceof Error ? err : new Error(String(err))),
        onDismiss: (why) => { if (why === 'error') failed(new Error('the splash was dismissed before it could be measured')); },
      });
    });
    await settle(SETTLE_MS);

    const canvas = document.querySelector('.sv-riv canvas');
    if (!canvas) throw new Error('the splash mounted without a canvas');
    // THE HANDLE, ON THE WINDOW, for poking at a frame by hand — open
    // ?frame=1&touch=1 and the console has the card, its canvas and the same
    // sampler the sweep uses. Every question this tool answers wrong is a
    // question about one dispatch, and the alternative is another two-minute
    // sweep per guess. Same idea as `window.__skyFx` on the splash probe.
    window.__hit = { handle, canvas };

    // --- the artboard's own numbers, which are where the buttons are DRAWN ---
    const vmi = () => handle.rive?.viewModelInstance;
    //
    // IN THE CANVAS'S BOX, AND THEN IN THE PAGE'S. riveSplash computes the fit
    // from `canvas.clientWidth/clientHeight` and ui/splashLayout.js returns CSS
    // pixels OF THE CANVAS — so a probe that passed window.innerWidth would be
    // comparing a hitbox in page coordinates against a rectangle in canvas
    // coordinates, and would report the canvas's own offset as a hitbox bug.
    // The two are the same number in the game today, which is exactly why the
    // mistake would survive: it only shows up the day something is laid out
    // beside the card.
    const drawnRects = () => {
      let scale = null; let pillW = null;
      try {
        scale = vmi()?.number(SPLASH_BINDINGS.entryScale)?.value ?? null;
        pillW = vmi()?.number(SPLASH_BINDINGS.entryWidth)?.value ?? null;
      } catch { /* reported by the caller */ }
      if (!(scale > 0) || !(pillW > 0)) return null;
      const box = canvas.getBoundingClientRect();
      const r = entryRects(box.width, box.height, scale, pillW);
      const shift = (a) => ({ left: a.left + box.left, right: a.right + box.left, top: a.top + box.top, bottom: a.bottom + box.top });
      return { dice: shift(r.dice), pill: shift(r.pill), start: shift(r.start) };
    };

    const drawn = drawnRects();
    if (!drawn) {
      findings.push({
        type: 'hit-unread',
        what: 'the entry column',
        by: 'the artboard reported no scale or no pill width, so there is nothing to compare a hitbox to',
      });
      return post(findings, detail);
    }

    // --- reading a button's hover state ------------------------------------
    // null means the property is not in this export, which is a finding rather
    // than a false. See SPLASH_BINDINGS: the game reads these too, and a splash
    // whose buttons have lost their hover booleans has lost its cursor with them.
    const readBool = (prop) => {
      try {
        const b = vmi()?.boolean(prop);
        return b ? !!b.value : null;
      } catch { return null; }
    };

    // ONE SAMPLE. Dispatched at whatever is actually on top at that point —
    // document.elementFromPoint, not the canvas — because the tip jar and the
    // build stamp are DOM over the card and a real pointer stops at them. The
    // canvas is what Rive listens on, and an event dispatched on a sibling
    // above it never reaches the canvas, which is exactly what should happen.
    //
    // MouseEvent, not PointerEvent: registerTouchInteractions binds mouseover /
    // mouseout / mousemove / mousedown / mouseup and the touch four. Nothing in
    // the runtime listens for a pointer event.
    // A LINE PER SAMPLE, on request (`--trace`). The one failure this tool has
    // that leaves nothing behind is the renderer going silent mid-sweep, and a
    // silent renderer cannot post a report — so the trace goes out through the
    // console, which the driver forwards to the terminal and the stall printer
    // shows the tail of. Off by default: it is one line per sample and there are
    // a hundred and fifty per device.
    const TRACE = params.get('trace') === '1';
    async function liveAt(x, y, prop) {
      if (TRACE) console.warn(`sample ${prop} ${Math.round(x)},${Math.round(y)}`);
      const cx = Math.max(0, Math.min(window.innerWidth - 1, x));
      const cy = Math.max(0, Math.min(window.innerHeight - 1, y));
      const el = document.elementFromPoint(cx, cy) ?? document.body;
      el.dispatchEvent(new MouseEvent('mousemove', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
      }));
      await settle(STEP_MS);
      return readBool(prop);
    }

    window.__hit.liveAt = liveAt;
    window.__hit.drawn = drawnRects;
    // The pointer has to ENTER the canvas before a hover means anything on some
    // state machines; cheap, and it removes a whole class of first-sample doubt.
    canvas.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));

    say('checking the detector');
    // --- the detector, checked before anything it says is believed ---------
    // A corner of the screen must read dead. A boolean stuck true, a property
    // that always reads true, or a state machine advancing on nothing would
    // otherwise map the whole screen as one enormous button and report a clean
    // sheet at every viewport.
    for (const [what, prop] of [['the dice', SPLASH_BINDINGS.hover], ['the Start button', SPLASH_BINDINGS.startHover]]) {
      const corner = await liveAt(2, 2, prop);
      if (corner === null) {
        findings.push({ type: 'hit-unread', what, by: `this export has no \`${prop}\`, so nothing can say where it responds` });
      } else if (corner === true) {
        findings.push({ type: 'probe-broken', what: `${what} reads as hovered in the corner of the screen — the boolean is stuck, or the state machine is not advancing` });
      }
    }
    if (findings.length) return post(findings, detail);

    // --- pass 1: the hover map ---------------------------------------------
    say('mapping the hover hitboxes');
    const measured = {};
    for (const [what, prop, box] of [
      ['the dice', SPLASH_BINDINGS.hover, drawn.dice],
      ['the Start button', SPLASH_BINDINGS.startHover, drawn.start],
    ]) {
      const rect = await mapHitbox(box, prop, liveAt, findings, what);
      measured[what] = rect;
      if (!rect) continue;
      const by = Math.round(Math.max(
        Math.abs(rect.left - box.left), Math.abs(rect.right - box.right),
        Math.abs(rect.top - box.top), Math.abs(rect.bottom - box.bottom),
      ));
      if (by > EDGE_TOL) {
        findings.push({ type: 'hit-offset', what, by, hit: fmt(rect), drawn: fmt(box) });
      }
      // THE MEASURED SIZE, which is the one a thumb meets. `npm run layout`
      // already reports the DRAWN size against the same 44 — this is the other
      // half of that finding, and the two disagreeing is itself the news.
      const w = rect.right - rect.left;
      const h = rect.bottom - rect.top;
      if (touch && (w < TAP_MIN || h < TAP_MIN)) {
        findings.push({ type: 'tap', what: `${what} (measured hitbox)`, w: Math.round(w), h: Math.round(h) });
      }
    }
    const box = canvas.getBoundingClientRect();
    // THE SCALE IS THE EXPLANATORY VARIABLE. Every number in this report moves
    // with it — the buttons' size, and (see the offsets) how far their hitboxes
    // sit from them — so a report without it is a list of numbers with no way
    // to tell which of them are the same fact.
    try { detail.scale = Math.round((vmi()?.number(SPLASH_BINDINGS.entryScale)?.value ?? 0) * 1000) / 1000; } catch { detail.scale = null; }
    detail.canvas = `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`;
    detail.viewport = `${window.innerWidth}x${window.innerHeight}`;
    detail.drawn = { dice: fmt(drawn.dice), start: fmt(drawn.start) };
    detail.hit = {
      dice: measured['the dice'] ? fmt(measured['the dice']) : null,
      start: measured['the Start button'] ? fmt(measured['the Start button']) : null,
    };

    // --- pass 2: a real touch on the dice -----------------------------------
    say('pressing the dice');
    const diceRect = measured['the dice'] ?? drawn.dice;
    detail.touch = await touchPass(canvas, diceRect, handle, findings);

    // --- pass 3: the hitbox after the box changes ---------------------------
    say('rotating the frame');
    if (measured['the dice']) {
      detail.rotation = await rotationPass({
        diceRect: measured['the dice'], prop: SPLASH_BINDINGS.hover,
        liveAt, drawnRects, findings,
      });
    }

    post(findings, detail);
  } catch (err) {
    console.error(err);
    findings.push({ type: 'threw', what: String(err?.message ?? err) });
    post(findings, detail);
  }
}

/**
 * The live area around a drawn rect, in CSS pixels: seed inside it, then bisect
 * outward along the centre lines to each edge.
 *
 * A SEED SEARCH rather than trusting the centre, because "the centre of where
 * it is drawn is not live" is one of the answers this tool exists to give, and
 * a probe that gave up there could not tell a button that has MOVED from one
 * that has no listener at all. The grid is over the drawn rect grown by half,
 * which finds anything overlapping its own footprint; past that the button is
 * not merely offset, and `hit-missing` is the honest report.
 */
async function mapHitbox(box, prop, liveAt, findings, what) {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const w = box.right - box.left;
  const h = box.bottom - box.top;

  let seed = (await liveAt(cx, cy, prop)) ? { x: cx, y: cy } : null;
  if (!seed) {
    // OUT TO ONE AND A HALF BOXES, not half of one. The whole point of the
    // search is to find a button whose listener has moved, and a grid that only
    // covers the drawn footprint finds an offset of a third of a button by luck
    // and misses one of a whole button entirely — which reads as `hit-missing`,
    // a completely different and much more alarming finding than the truth.
    outer:
    for (const fy of [0, -0.4, 0.4, -0.8, 0.8, -1.5, 1.5]) {
      for (const fx of [0, -0.4, 0.4, -0.8, 0.8, -1.5, 1.5]) {
        const x = cx + fx * w; const y = cy + fy * h;
        if (await liveAt(x, y, prop)) { seed = { x, y }; break outer; }
      }
    }
  }
  if (!seed) {
    // WHERE IT IS INSTEAD, before giving up. "Nothing responded where it is
    // drawn" is half an answer and the wrong half: a button whose listener sits
    // somewhere else entirely and a button with no listener at all are different
    // bugs in different files, and the difference is one coarse pass over the
    // screen. Cheap because it only ever runs on the failure.
    const seen = [];
    for (let y = 8; y < window.innerHeight; y += 90) {
      for (let x = 8; x < window.innerWidth; x += 90) {
        if (await liveAt(x, y, prop)) seen.push(`${Math.round(x)},${Math.round(y)}`);
      }
    }
    const el = document.elementFromPoint(cx, cy);
    findings.push({
      type: 'hit-missing',
      what,
      by: seen.length
        ? `it responds around ${seen.slice(0, 6).join(' / ')}${seen.length > 6 ? ' …' : ''}, not at ${fmt(box)}`
        : `nothing on this screen sets \`${prop}\` — drawn at ${fmt(box)}, and a pointer there lands on <${(el?.tagName ?? 'nothing').toLowerCase()}${el?.className ? ` class="${el.className}"` : ''}>`,
    });
    return null;
  }

  // THE FAR POINT for each ray has to be dead before a bisection between them
  // means anything. It is grown rather than assumed: a hit shape much bigger
  // than its glyph is a real thing to find, and a bisection against a live
  // "outside" point silently returns the midpoint of two live samples, which
  // looks like a perfectly ordinary edge.
  const edge = async (dx, dy) => {
    const span = (dx ? w : h) || 80;
    let out = null;
    for (const mul of [1.5, 3, 6]) {
      const p = { x: seed.x + dx * span * mul, y: seed.y + dy * span * mul };
      if (!(await liveAt(p.x, p.y, prop))) { out = p; break; }
    }
    if (!out) {
      findings.push({ type: 'hit-unbounded', what, by: Math.round((dx ? w : h) * 6) });
      return null;
    }
    let a = { ...seed }; let b = out;
    for (let i = 0; i < BISECT; i++) {
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (await liveAt(m.x, m.y, prop)) a = m; else b = m;
    }
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const left = await edge(-1, 0);
  const right = await edge(1, 0);
  const top = await edge(0, -1);
  const bottom = await edge(0, 1);
  if (!left || !right || !top || !bottom) return null;
  return { left: left.x, right: right.x, top: top.y, bottom: bottom.y };
}

/**
 * A REAL TOUCH ON THE DICE, asserted end to end: the name in the pill changes,
 * which means the artboard's listener fired `tRandomizeName` and the game heard
 * it. Nothing short of that proves a phone can press this button.
 *
 * BOTH EVENT PATHS, separately, because which one a runtime listens for is not
 * a thing to assume — this file's own first draft used PointerEvent and mapped
 * every button as dead. Reporting which path worked is worth as much as the
 * pass itself: a splash that answers a mouse and not a finger is precisely the
 * bug "inconsistent on mobile" describes.
 *
 * UP TO THREE PRESSES per path before calling it dead, because a roll can
 * return the name already in the pill. Three identical rolls out of the table
 * is not a thing that happens; one is.
 */
async function touchPass(canvas, dice, handle, findings) {
  const x = (dice.left + dice.right) / 2;
  const y = (dice.top + dice.bottom) / 2;
  const out = {};

  const pressTouch = async (px, py) => {
    const el = document.elementFromPoint(px, py) ?? canvas;
    const mk = (type) => {
      const t = new Touch({ identifier: 1, target: el, clientX: px, clientY: py });
      return new TouchEvent(type, {
        changedTouches: [t], touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t],
        bubbles: true, cancelable: true, view: window,
      });
    };
    el.dispatchEvent(mk('touchstart'));
    await settle(STEP_MS);
    el.dispatchEvent(mk('touchend'));
    await settle(STEP_MS * 3);
  };

  const pressMouse = async (px, py) => {
    const el = document.elementFromPoint(px, py) ?? canvas;
    const opts = { clientX: px, clientY: py, bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    await settle(STEP_MS);
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    await settle(STEP_MS);
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    await settle(STEP_MS * 3);
  };

  const rolls = async (press, px, py) => {
    for (let i = 0; i < 3; i++) {
      const before = handle.name;
      await press(px, py);
      if (handle.name !== before) return true;
    }
    return false;
  };

  out.touch = await rolls(pressTouch, x, y);
  out.mouse = await rolls(pressMouse, x, y);
  if (!out.touch && !out.mouse) {
    findings.push({ type: 'touch-dead', what: 'the dice', by: 'neither a touch nor a mouse press at the centre of its hitbox rolled a name' });
  } else if (!out.touch) {
    findings.push({ type: 'touch-dead', what: 'the dice', by: 'a mouse press rolls a name and a touch press does not — a finger cannot use this button' });
  }

  // AND THE CONTROL, which is what makes the two lines above mean anything: a
  // press well clear of the button must NOT roll a name. Without it, a splash
  // that rolls on any press anywhere — the fallback dismiss path, a full-bleed
  // listener — reads as a working dice.
  if (out.touch || out.mouse) {
    const offX = Math.min(window.innerWidth - 2, dice.right + (dice.right - dice.left));
    const press = out.touch ? pressTouch : pressMouse;
    out.control = await rolls(press, offX, y);
    if (out.control) {
      findings.push({ type: 'probe-broken', what: 'a press clear of the dice rolls a name too — the roll is not evidence the dice was hit' });
    }
  }
  return out;
}

/**
 * HOW LONG THE HITBOX LAGS THE PICTURE when the box changes — a rotation, a URL
 * bar collapsing, a keyboard opening. All three are the same event to the page
 * and all three happen constantly on a phone.
 *
 * Learn the landscape hitbox first (rotate, settle, map it), then go back to
 * portrait, then rotate again and poll TWO points every step from the moment
 * the box changes:
 *
 *   arrive  the centre of the settled landscape hitbox — how long until the
 *           button can be pressed where it is now drawn;
 *   ghost   the centre of the portrait hitbox, when that point is outside the
 *           landscape one — how long the button keeps answering where it USED
 *           to be, which is the half a player experiences as a mis-press
 *           rather than a dead one.
 *
 * The frame resizes itself: window.frameElement is same-origin here, and a
 * viewport is the one thing a page cannot otherwise change about itself.
 */
async function rotationPass({ diceRect, prop, liveAt, drawnRects, findings }) {
  const fe = window.frameElement;
  if (!fe) return { skipped: 'not in a frame' };
  const W = window.innerWidth; const H = window.innerHeight;
  const out = { from: `${W}x${H}`, to: `${H}x${W}` };

  const setBox = (w, h) => {
    fe.width = w; fe.height = h;
    fe.style.width = `${w}px`; fe.style.height = `${h}px`;
  };

  setBox(H, W);
  await settle(SETTLE_MS);
  const land = await mapHitbox(drawnRects()?.dice ?? diceRect, prop, liveAt, [], 'the dice, rotated');
  setBox(W, H);
  await settle(SETTLE_MS);
  if (!land) {
    // Not a silent dash in the summary line: "the rotation pass could not run"
    // and "the hitbox arrived instantly" print the same way otherwise, and one
    // of those is a measurement and the other is the absence of one.
    findings.push({ type: 'hit-unread', what: 'the dice, after a rotation', by: 'the rotated hitbox could not be mapped, so the lag could not be measured' });
    return { ...out, skipped: 'the rotated hitbox could not be mapped' };
  }

  const arriveAt = { x: (land.left + land.right) / 2, y: (land.top + land.bottom) / 2 };
  const ghostAt = { x: (diceRect.left + diceRect.right) / 2, y: (diceRect.top + diceRect.bottom) / 2 };
  // A ghost point inside the new hitbox proves nothing — it is meant to be live
  // afterwards. Said out loud rather than reported as a clean result.
  const ghostUseful = ghostAt.x < land.left - 4 || ghostAt.x > land.right + 4
    || ghostAt.y < land.top - 4 || ghostAt.y > land.bottom + 4;

  const t0 = performance.now();
  setBox(H, W);
  let arrived = null; let ghostLast = null;
  while (performance.now() - t0 < 1200) {
    if (arrived === null && (await liveAt(arriveAt.x, arriveAt.y, prop))) arrived = performance.now() - t0;
    if (ghostUseful && (await liveAt(ghostAt.x, ghostAt.y, prop))) ghostLast = performance.now() - t0;
    if (arrived !== null && (!ghostUseful || performance.now() - t0 > 700)) break;
  }
  setBox(W, H);
  await settle(200);

  out.arrivedMs = arrived === null ? null : Math.round(arrived);
  out.ghostLastMs = ghostLast === null ? null : Math.round(ghostLast);
  out.ghostChecked = ghostUseful;

  // The ladder in riveSplash tops out at 400ms, so anything past it is not the
  // resettle working — it is the resettle having missed.
  if (arrived === null) {
    findings.push({ type: 'hit-late', what: 'the dice, after a rotation', by: 'longer than 1.2s, or never' });
  } else if (arrived > 500) {
    findings.push({ type: 'hit-late', what: 'the dice, after a rotation', by: `${Math.round(arrived)}ms` });
  }
  if (ghostLast !== null && ghostLast > 120) {
    findings.push({ type: 'hit-stale', what: 'the dice, after a rotation', by: Math.round(ghostLast) });
  }
  return out;
}

const fmt = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right - r.left)}x${Math.round(r.bottom - r.top)}`;

function post(findings, detail) {
  parent.postMessage({ kind: 'sv-hit', findings, detail }, '*');
}

// AT THE BOTTOM, and it has to be: function declarations hoist and `const` does
// not, so dispatching from the top of the file reaches VIEWPORTS and STEP_MS in
// their temporal dead zone — which surfaces as tiles that simply never report.
// The same trap tools/layout/layout-audit.js documents at its own foot.
if (params.get('frame')) runFrame();
else runParent();
