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

// ---------------------------------------------------------------------------
// THE FLIPS — `npm run flip`, a different question from the one above.
//
// The sweep in the rest of this file builds every surface FRESH at each size,
// which is the question "does this fit". It cannot ask the other one: does a
// surface that is ALREADY UP survive the screen changing under it. Those are
// not the same check, and the gap between them is where a whole class of bug
// lives — a layout decision taken once at build time and then latched, so the
// hive stays in its portrait arrangement on a phone that has been turned over,
// or the boss bar keeps a drop measured against a corner that is no longer
// there. Every one of those passes the fit sweep at both sizes, because at both
// sizes a fresh build is correct.
//
// IT IS A ROUND TRIP, A TO B AND BACK TO A, and that shape is the whole reason
// this can be an automatic check at all. The obvious build — flip to B and
// compare against a fresh build at B — cannot work here: the tiles deal a real
// hand of upgrades, roll real seal names and cast a real roster, so two
// independent mounts of the same surface are two different screens and every
// comparison between them is noise. One frame, turned and turned back, has the
// same content in it both times, so ANY difference is the surface failing to
// come back — which is precisely the thing being looked for, with nothing else
// able to produce it.
//
// It measures at B as well, with the same rules the fit sweep uses. That half
// is not redundant: a surface can survive the round trip perfectly and still be
// broken while it is over there.
//
// THE PAIRS ARE CROSSINGS, not a product of the list above. Each one steps over
// a breakpoint the code actually branches on, because a flip that changes
// nothing tests nothing:
//   rotation      393x852 <-> 852x393. The phone turning over. Crosses the
//                 700px width rule AND the 560px height rule at once, in
//                 opposite directions — see narrowScreen/shortScreen.
//   tablet        744x1133 <-> 1024x768. The same turn on a screen that is on
//                 the desktop side of the width rule in both orientations, so
//                 the only thing that moves is the aspect.
//   window drag   1920x1080 <-> 375x667. Not a device: a desktop window pulled
//                 narrow, which crosses the phone breakpoint on a machine that
//                 never fires orientationchange. Several surfaces listen only
//                 for that event, and this is the pair that finds them.
const FLIP_PAIRS = [
  { name: 'rotation', touch: true, a: { w: 393, h: 852 }, b: { w: 852, h: 393 } },
  { name: 'tablet', touch: true, a: { w: 744, h: 1133 }, b: { w: 1024, h: 768 } },
  { name: 'window drag', touch: false, a: { w: 1920, h: 1080 }, b: { w: 375, h: 667 } },
];

// How far two rectangles may differ across a round trip before it counts.
// A whole pixel rather than zero: sub-pixel layout rounds differently when a
// box is laid out at one width and then again at another, and a half-pixel
// shift is not a surface that failed to come back.
const FLIP_SLOP = 1;

// The surfaces, by the name previewScreen() already knows, plus the two it has
// no word for. `coach` is the first-run tutorial band — the longest line in
// callouts.csv, which is the one that has to fit. There is no 'start' any more:
// the DOM start menu was deleted (everything it explained is taught by the
// coach, in the water), so there is no such screen to measure.
// 'HUD' is now the SHIPPED placement — the corner gauges at the maximum a run
// opens with. 'HUD grown' is the same screen several health upgrades later,
// which is the frame that can run off the top and the only one the CSS ceiling
// has to catch. Both are needed: the growth is the feature, so the short
// version cannot stand in for the long one or the other way round.
// 'settings' and 'paused' are the SAME PANEL on its two routes, and they are
// both here because the routes differ in the one row that broke: the footer is
// two buttons from the main menu and FOUR during a run — Resume, Restart run,
// Main menu, Defaults — and it has broken twice, once by running off the side
// of the panel and once by squeezing three of them to a third of their labels
// and wrapping the text inside them. A surface list holding only one of these
// two routes would have measured the one that fits.
// 'splash' is the title card — the Rive artboard with the dice, the name pill
// and the Start button. Those three are DRAWN, not DOM, so the sweep below
// cannot see them; measureSplash() computes where they are from what the
// artboard reports (its scale and the pill's width) and the geometry in
// ui/splashLayout.js, and checks them against the wordmark and the DOM over
// the card. It is here because the dice sat on the SURVIVOR on every wide
// screen for as long as nothing measured it.
// THE BALL GAME'S FOUR, added when its type became designable in the Text
// panel (Y). They are here because they are the surfaces in the game with the
// least DOM and the most vmin: the goal card, the countdown numeral and the
// after-match prompt are all sized as a share of the screen, and a share of a
// 375px phone held upright is a different design from a share of a 1920 desktop.
//
// 'goal card' carries the score strip as well — previewVersusUi paints the
// strip on every branch — so the two meters, the clock and the card are one
// tile rather than two.
// 'match over' is the prompt over the highlight reel, and it is the one tile
// here with tap targets in it: Rematch and Main Menu are sized in vmin with a
// px floor precisely so a phone in landscape (where a match is most likely to
// be played two-up on one screen) keeps them at 44px, and nothing measured
// that floor until this line existed.
// 'match HUD' is the kickoff: the countdown numeral and, under it, the card
// naming the two sides. It was missing from this list while the numeral was
// the only thing on that screen — one glyph in the middle cannot overflow
// anything — and a team name can be 34 characters of nowrap type in a column
// that has to clear both the strip above it and the numeral. It is measured on
// the surface it is measured on for a reason: previewVersusUi is the only way
// to see that card without playing a match to a whistle.
// 'team select' is the screen before the match — two columns of seal slots, a
// colour wheel each, and two settings rows. It stacks under 3:4 on purpose
// (see the media query in ui/teamSelect.js), and that rule is exactly the kind
// that is written once and never measured again.
// 'room lobby' is the screen before the team select on the online route: two
// player rows, a five-letter code sized in vmin, and a text field sized in ch.
// Worth measuring for two reasons the other screens do not have — the code is
// the one piece of type on any screen that a person reads OUT LOUD off a phone
// held at arm's length, so it is deliberately large and can collide; and the
// entry field is the only text input in the game, which is the control a
// software keyboard shoves the viewport around for.
// 'seal sports' and 'leaderboard' are the two plain panels off the main menu —
// a column of buttons each, which is exactly why neither was here: there is
// nothing in either one that looks capable of overflowing. What they DO have is
// tap targets, and the whole argument for the touch half of this audit is that
// a 38px button is invisible to every other check in the repo. They are also
// the two screens the shared panel cursor (ui/panelNav.js) was written for, so
// a stop that stops being a stop — a button that is disabled, or hidden — now
// has a tile it shows up on.
//
// 'phone prompts' is the stack of three rows that tell a phone in a browser
// about its own ring switch, which way up it is held, and the strip of screen
// the browser's bottom bar is sitting on (ui/mobilePrompts.js). It is here for
// the reason the two plain panels above are: there is nothing in three rows of
// text that looks capable of overflowing, and every one of them is prose from a
// spreadsheet in a 340px box with a 44px target in it — which is exactly the
// shape that does. It is also a surface that only exists where there is a
// thumb, so it is drawn on the five touch tiles and correctly absent from the
// other three.
const SURFACES = ['splash', 'HUD', 'HUD grown', 'coach', 'boss', 'cards', 'score card', 'settings', 'paused',
  'match HUD', 'goal card', 'match over', 'team select', 'room lobby', 'seal sports', 'leaderboard',
  'phone prompts'];

// THE FURNITURE A CALLOUT MAY NOT COVER. The same list ui/callout.js clears
// itself of, restated here ON PURPOSE rather than imported: this is the check,
// and a check that reads its expectation out of the code it is checking passes
// by construction. Delete a selector from CHROME in callout.js and the band
// starts landing on that element — which is exactly the regression this exists
// to catch, and importing the list would hide it.
const CALLOUT_CHROME = [
  '.sv-bossbar', '.sv-xptop', '.sv-xptop-level', '.sv-hud-corner',
  // The gauges, in the placement that holds still. Restated here with the same
  // deliberate duplication as the rest of this list — see the note above.
  '.sv-playerbars-corner', '.sv-print',
];
// ...and the callouts themselves, which is what must stay off it.
const CALLOUT_LINES = ['.sv-callout', '.sv-callout-boost'];

// A BACKDROP IS ALLOWED TO RUN OFF THE SCREEN.
//
// The level-up comb (ui/upgradeComb.js) tiles a ring of cells past every edge
// on purpose — CONFIG.upgradeComb.over — so the lattice is never seen to end,
// and its layer clips them. Every check below fires on it, at every viewport,
// and every one of those findings is the design working. Left in, they are
// eight noisy tiles that train whoever runs this to scroll past the `cards`
// surface, which is the surface most likely to break.
//
// NAMED, NOT DETECTED. "Is this element meant to overhang" is not a question a
// rectangle can answer, and a rule that guessed — anything full-bleed, anything
// behind a menu — would eventually excuse a real one. Adding a name here is a
// decision, and it should stay one.
//
// The cards themselves are NOT in this list, deliberately: a card off the
// bottom of an iPhone SE is a choice the player cannot see, and that is exactly
// what this tool is for.
const FULL_BLEED = ['.sv-comb'];

// Apple's Human Interface Guidelines minimum, and the reason a button can look
// fine and still be missed by a thumb.
const TAP_MIN = 44;

// Positioned per frame from a world position; see the header.
const PER_FRAME = [
  // ...but ONLY in the placement that is positioned per frame. With
  // settings.hud.barPlacement on 'corner' the same element is ordinary fixed
  // chrome pinned to the bottom right, and it is then exactly the kind of
  // thing this tool exists to measure: it has a length that GROWS with the
  // seal's maximum health, and the corner it is pinned to is the one the score
  // and the clock move into on a phone. Excluding it by bare class name would
  // have made the one placement that can genuinely collide the one placement
  // nothing checked.
  '.sv-playerbars:not(.sv-playerbars-corner)', '.sv-toast', '.sv-chain',
  '.sv-callout-boost', '.sv-callout-arrow', '.sv-card-fx',
];

const params = new URLSearchParams(location.search);

// WHICH RUN THIS PAGE BELONGS TO. The terminal puts it in the URL and drops any
// post that does not carry it back, so a tab left open from an earlier run
// cannot report into a later one — see the note beside RUN in
// tools/layout-audit.mjs. A page opened by hand with no `run` sends nothing and
// is refused, which is the honest outcome: the terminal it would be reporting
// to is not listening for it.
function runQuery() {
  const run = params.get('run');
  return run ? `?run=${encodeURIComponent(run)}` : '';
}

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

// WHICH SWEEP THIS PAGE IS. `?mode=flip` is `npm run flip`; anything else is
// the fit sweep this file was written for. One page rather than two because
// every part below the job list is shared — the tile scaffolding, the frame
// protocol, the stall watchdog, the report — and a second copy of all of that
// is a second copy that stops agreeing with the first.
const MODE = params.get('mode') === 'flip' ? 'flip' : 'fit';

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

  // ONE TILE LIST, TWO SHAPES. A fit tile is a viewport and a surface; a flip
  // tile is a PAIR and a surface, mounted at the pair's `a` and driven to `b`
  // and back by the frame. Everything downstream — the scaffolding, the
  // measuring, the report — takes the same `{ v, surface, mount, list }` and
  // does not need to know which sweep it is in.
  //
  // The tile is scaled off the WIDER of the two, so a rotation tile does not
  // change size on the page halfway through and make the sweep look broken.
  const tiles = MODE === 'flip'
    ? FLIP_PAIRS.flatMap((pair) => SURFACES.map((surface) => ({
      surface,
      v: { name: `${pair.name} ${pair.a.w}x${pair.a.h} ↔ ${pair.b.w}x${pair.b.h}`,
        w: pair.a.w, h: pair.a.h, touch: pair.touch },
      flipTo: pair.b,
      box: { w: Math.max(pair.a.w, pair.b.w), h: Math.max(pair.a.h, pair.b.h) },
    })))
    : VIEWPORTS.flatMap((v) => SURFACES.map((surface) => ({ surface, v, flipTo: null, box: v })));

  for (const tile of tiles) {
    {
      const { v, surface, flipTo, box } = tile;
      const scale = scaleFor(box);
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.width = `${Math.round(box.w * scale) + 2}px`;
      cell.innerHTML = `<h2>${v.name} · ${surface}</h2>`;

      const clip = document.createElement('div');
      clip.className = 'clip';
      clip.style.cssText = `width:${box.w * scale}px; height:${box.h * scale}px; overflow:hidden; position:relative;`;
      cell.appendChild(clip);

      const list = document.createElement('div');
      list.className = 'findings';
      list.textContent = 'queued';
      cell.appendChild(list);
      grid.appendChild(cell);

      const src = `./layout-audit.html?frame=1&surface=${encodeURIComponent(surface)}&touch=${v.touch ? 1 : 0}`
        + (flipTo ? `&flipTo=${flipTo.w}x${flipTo.h}` : '');
      // THE IFRAME IS THE VIEWPORT, so changing its width and height is how a
      // flip is performed — there is no other way to move `window.innerWidth`
      // inside a frame from outside it. The frame ASKS for the resize (see the
      // handshake in runFrame) rather than the parent driving it on a timer,
      // because only the frame knows when it has finished settling at the size
      // it is already at.
      const sizeTo = (frame, w, h) => {
        frame.width = w;
        frame.height = h;
        frame.style.width = `${w}px`;
        frame.style.height = `${h}px`;
      };
      const mount = () => {
        const frame = document.createElement('iframe');
        sizeTo(frame, v.w, v.h);
        frame.style.transform = `scale(${scale})`;
        frame.style.transformOrigin = '0 0';
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
      jobs.push({ v, surface, mount, list, sizeTo });
    }
  }

  (async () => {
    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        summary.innerHTML = `measuring ${i + 1} / ${jobs.length} — ${job.v.name} ${job.surface}`;
        job.list.textContent = 'measuring…';
        // BEFORE the tile, not after: this is what the terminal's stall
        // watchdog reads, and a tile that never comes back has to be named by
        // the ping that went out before it started.
        progress(i, jobs.length, `${job.v.name} ${job.surface}`);
        const findings = await measureOne(job);
        results.push({ viewport: job.v.name, w: job.v.w, h: job.v.h, surface: job.surface, findings });
        job.list.innerHTML = findings.length
          ? findings.map((f) => `<div class="${f.type === 'tap' ? 'tap' : ''}">${escapeHtml(describe(f))}</div>`).join('')
          : '<div class="ok">clean</div>';
      }
      finish(results, summary);
    } catch (err) {
      // A THROW IN THE SWEEP MUST STILL REPORT. Every per-tile failure already
      // becomes a finding, but the loop itself is not covered by that — and an
      // exception here rejects an async IIFE nobody awaits, so it lands in the
      // console and the terminal waits forever with no report and no reason.
      // That is the exact silence this whole repair is about, so it gets an
      // answer of its own: post what was measured, and say what stopped it.
      console.error(err);
      results.push({
        viewport: '—', w: 0, h: 0, surface: 'the sweep itself',
        findings: [{ type: 'threw', what: String(err?.message ?? err) }],
      });
      finish(results, summary);
    }
  })();
}

// A LINE TO THE TERMINAL WHILE THE SWEEP IS STILL RUNNING.
//
// The report only exists at the end, and the end is two minutes away — so
// without this the tool is silent for its whole run and indistinguishable from
// one that has hung. It is also what the terminal's stall watchdog counts
// against: no ping for long enough and the run is abandoned with the tile it
// was on named, rather than blocking until somebody kills it.
//
// keepalive, because a ping issued from a page that is about to unload a frame
// is exactly the ping most worth not losing. Failures are swallowed: this is
// telemetry for a human watching, and a page that cannot reach the server must
// still finish measuring.
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
      if (e.source !== frame.contentWindow) return;
      // THE FLIP HANDSHAKE. Only the parent can change a frame's viewport, and
      // only the frame knows when it is ready to be changed — so the frame asks
      // and the parent answers. Each leg of the round trip is one of these.
      if (e.data?.kind === 'sv-flip-resize') {
        job.sizeTo(frame, e.data.w, e.data.h);
        // A frame that is still turning is a frame that is still measuring, so
        // the watchdog is pushed out by the same amount the trip will take.
        // Without this a slow surface reports nothing and looks like a hang.
        bump();
        frame.contentWindow?.postMessage({ kind: 'sv-flip-resized' }, '*');
        return;
      }
      if (e.data?.kind !== 'sv-layout') return;
      settle(e.data.findings ?? []);
    };
    window.addEventListener('message', onMessage);
    // A TIMER THAT CAN BE PUSHED OUT, rather than one absolute deadline. A flip
    // tile builds once and then measures three times with a settle between each,
    // which does not fit in the budget a single build was given — and the honest
    // fix is to extend it per leg rather than to raise it for every tile and
    // make a genuine hang take three times as long to be called.
    let timer = null;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => settle([{ type: 'threw', what: 'the frame never reported — see the console' }]),
        15000,
      );
    };
    bump();
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
      ? (MODE === 'flip'
        ? '<span class="ok">Clean — every surface survives the screen changing under it.</span>'
        : '<span class="ok">Clean — every surface fits every viewport.</span>')
      : `<span class="bad">${total} finding(s) across ${bad.length} of ${results.length} surface/viewport pairs.</span>`,
  ];
  if (silent) lines.push(`<span class="bad">${silent} frame(s) never reported.</span>`);
  for (const r of bad) {
    lines.push(`\n<b>${r.viewport}${MODE === 'flip' ? '' : ` ${r.w}x${r.h}`} — ${r.surface}</b>`);
    for (const f of r.findings) lines.push(`  ${escapeHtml(describe(f))}`);
  }
  summary.innerHTML = lines.join('\n');

  // Back to the terminal. `npm run layout` prints this and exits non-zero on a
  // finding, so it can be run the way the other checks in this repo are.
  fetch(`/report/layout.json${runQuery()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results, total, silent }),
  }).catch(() => {});
}

function describe(f) {
  // THE LEG IT WAS FOUND ON. A flip tile measures the fit rules on the far side
  // of the turn, and a finding with no leg on it reads as a finding at the size
  // the tile is named for — which is the size it came BACK to.
  const leg = f.leg === 'over' ? 'after the flip: ' : '';
  if (f.type === 'stuck') {
    return `${f.what} did not come back — was ${f.was}, now ${f.now} (${f.by}px)`
      + (f.of > 1 ? `, and ${f.of - 1} more element(s) with it` : '');
  }
  if (f.type === 'stuck-count') {
    return `${f.n} element(s) appeared or vanished across the flip and stayed that way — ${f.what}`;
  }
  if (f.type === 'stuck-blind') {
    return `${f.what} had almost nothing to compare — ${f.n} visible element(s) of ${f.of}.`
      + ' A clean sheet from this tile would mean nothing.';
  }
  if (leg) return leg + describe({ ...f, leg: null });
  if (f.type === 'tap') return `${f.what} — tap target ${f.w}x${f.h}, under ${TAP_MIN}`;
  if (f.type === 'empty') return `${f.what} built nothing this sweep can see — ${f.n} element(s) measured`;
  if (f.type === 'clipped') return `${f.what} — clipped, content ${f.contentW}px in a ${f.boxW}px box`;
  if (f.type === 'threw') return `surface failed to build — ${f.what}`;
  if (f.type === 'callout-over-ui') return `${f.what} — sitting on ${f.over}, ${f.by}px of overlap`;
  if (f.type === 'out-of-panel') return `${f.what} — ${f.by}px outside the menu panel it belongs to`;
  if (f.type === 'splash-over-wordmark') return `${f.what} — sitting on the wordmark, ${f.by}px of overlap`;
  if (f.type === 'splash-over-ui') return `${f.what} — sitting on ${f.over}, ${f.by}px of overlap`;
  if (f.type === 'splash-unread') return `${f.what} — ${f.by}`;
  if (f.type === 'clipped-below') return `${f.what} — cut off at the bottom, content ${f.contentH}px in a ${f.boxH}px box`;
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

  // PIN THE DICE BEFORE ANYTHING IS BUILT.
  //
  // The `cards` surface deals a REAL hand — previewScreen says so, and that is
  // the right design, because a mocked-up card is a card that passes after the
  // real one has broken. But a real hand is three upgrades drawn at random out
  // of about a hundred, and their descriptions are not the same length, so the
  // width of `.sv-card-content` is different on every run. Five consecutive
  // sweeps gave PASS, PASS, PASS, `content 101px in a 91px box`, and `content
  // 115px in a 113px box`, and the temptation on seeing that is to go looking
  // for a timing bug, because those are the numbers a race produces.
  //
  // A tool that answers differently to the same question cannot be used to
  // decide anything, so the randomness is removed rather than tolerated.
  //
  // SEEDED PER TILE, NOT GLOBALLY FIXED. One seed for the whole sweep would
  // make the tool deterministic and nearly blind: the same three upgrades, at
  // all eight viewports, forever, with the other ninety-seven never once
  // rendered. Seeding from the surface AND the viewport gives a different hand
  // per device and the same hand every run — reproducible, and still sampling.
  //
  // It is a SAMPLE and should be read as one. This does not prove every upgrade
  // fits; it proves these do, and it does so the same way twice.
  seedRandom(`${surface}|${params.get('touch')}|${window.innerWidth}x${window.innerHeight}`);

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

    // THE TYPE THE GAME ACTUALLY SHIPS. Every rule in ui.js is sized in px
    // against a font the player can change: `family` and `scale` live in the
    // tuning file, and the shipped one is a pixel face at most of an em per
    // glyph — words half again as wide as the Inter the stylesheet was written
    // against. main.js calls this at boot; nothing here did, so every tile was
    // measured in the FALLBACK font and every surface that fits in Inter and
    // not in the real face passed. That is exactly how a pause footer that ran
    // off the side of its own panel got past this tool.
    (await import('../../path/src/ui/typography.js')).initTypography();

    // The hand this device is held in. initUI sets .sv-touch from the real
    // media query, and an iframe inherits `pointer: coarse` from the machine
    // the browser is running on rather than from the device it is standing in
    // for — so on a laptop every tile would come up as mouse-driven and the
    // tap-target rules would never be exercised, which is the same as not
    // having them. Overridden here to what this viewport actually is.
    ui.uiRoot()?.classList.toggle('sv-touch', params.get('touch') === '1');

    // A SURFACE MAY HAND BACK A CLEANUP, and it is run after the measuring
    // rather than at the end of the build. Three tiles seed localStorage (a
    // long name, a full board, a cleared prompt ledger) and then put it back,
    // because every tile shares one origin and a seed left behind is read by
    // the next tile that mounts. Undoing it INSIDE the build was fine while a
    // tile was a still — and became a bug the moment `npm run flip` started
    // turning the screen under a live surface: the board re-paints on the
    // resize, reads the storage that has already been rolled back, and comes
    // back with sixty elements in the wrong place. The tool reported that as
    // the game latching, which is the worst kind of finding — a real-looking
    // bug that only the harness can produce.
    //
    // Deferred to the end of the frame is just as safe: the next tile is a new
    // iframe and this one is torn down behind it.
    const cleanup = await buildSurface(surface, ui, callout, callouts);
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
    await settleAnimations();
    await settle(120);

    const flipTo = parseSize(params.get('flipTo'));
    if (flipTo) {
      // THE ROUND TRIP. Everything measured here is measured in ONE frame with
      // ONE set of contents, which is what lets a difference mean something —
      // see the note over FLIP_PAIRS.
      const here = { w: window.innerWidth, h: window.innerHeight };
      const before = signature();

      await flipTo_(flipTo.w, flipTo.h);
      // The fit rules, over there. Not redundant with the fit sweep: this is
      // the surface as it ARRIVED at that size rather than as it was built
      // there, and the two are only the same if nothing latched.
      for (const f of measure()) findings.push({ ...f, leg: 'over' });

      await flipTo_(here.w, here.h);
      findings.push(...stuck(before, signature()));
    } else {
      findings.push(...measure());
      if (surface === 'splash') findings.push(...(await measureSplash()));
    }
    cleanup?.();
  } catch (err) {
    console.error(err);
    findings.push({ type: 'threw', what: String(err?.message ?? err) });
  }

  parent.postMessage({ kind: 'sv-layout', findings }, '*');
}

// The title card's handle, for measureSplash. Module-level because the frame
// builds one surface and then measures it, and the handle is the only way to
// reach the artboard's numbers.
let splashHandle = null;

async function buildSurface(surface, ui, callout, callouts) {
  if (surface === 'splash') {
    // THE REAL CARD, the shipping module and the shipping .riv, mounted the
    // way ui.js mounts it: inside the UI root so the tip jar and the build
    // stamp it carries are swept by measure() like any other chrome. Nothing
    // presses anything — the sweep is a still.
    const { mountRiveSplash } = await import('../../path/src/ui/riveSplash.js');
    await new Promise((ready, failed) => {
      splashHandle = mountRiveSplash({
        parent: ui.uiRoot(),
        onReady: () => ready(),
        onError: (err) => failed(err instanceof Error ? err : new Error(String(err))),
        onDismiss: (why) => { if (why === 'error') failed(new Error('splash dismissed before it was measured')); },
      });
    });
    // The entry fit lands a settle (120ms) after the artboard first reports
    // the pill's width, and Rive re-lays the row out on the frame after the
    // scale is written. Long enough for both, and for the measurement below
    // to read a row that has stopped moving.
    await settle(900);
    return;
  }

  // The numbers are a plausible mid-run: a four-figure score, a level in
  // double digits (which is wider than "1"), and health worth drawing.
  const gameState = { score: 128400, time: 421, level: 14, xp: 60, xpToNext: 100 };
  const player = {
    hp: 62, oxygen: 40,
    stats: { maxHp: 100, maxOxygen: 100 },
    mesh: { position: { x: 0, y: 0, z: 0 } },
  };

  // THE BALL GAME. Driven through versus.js's own preview rather than through
  // previewScreen: those chips are REGISTERED by main.js at boot (ui.js cannot
  // import the match HUD, which imports ui.js), and this harness never runs
  // main.js. Calling the module directly is the same code the chip calls, one
  // link earlier in the chain.
  //
  // previewVersusUi refuses over a live match and writes nothing into
  // versusState — see its header. There is no match here, and the audit has no
  // state to protect, but it is the reason this is safe to call at all.
  if (surface === 'match HUD' || surface === 'goal card' || surface === 'match over') {
    const versus = await import('../../path/src/systems/versus.js');
    versus.previewVersusUi(surface);
    return;
  }
  // THE TWO PLAIN PANELS. Through their own entry points rather than by
  // un-hiding the markup: both are built lazily on the first show, so a panel
  // that was only revealed would be a panel that does not exist yet.
  if (surface === 'seal sports') {
    ui.showSealSports({ onBall() {}, onBallOnline() {} });
    return;
  }
  if (surface === 'leaderboard') {
    // A BOARD WITH ROWS IN IT. The panel paints from this device's own list,
    // which in a fresh audit profile is empty — and an empty table is not the
    // row that can overflow. Seeded with the longest name the field accepts
    // (MAX_NAME_LEN) against a six-figure score, which is the widest row the
    // board can ever be asked to draw.
    //
    // This writes localStorage on the AUDIT's origin, which is this static
    // server and nothing else — see the note at the top of tools/layout-audit.mjs
    // about why there is no writer of the game's own state anywhere in here.
    //
    // AND THE ROWS ARE SWEPT AGAIN AFTERWARDS, for the reason the name above is
    // put back: the tiles share one origin, so a board left in storage is a
    // board the score card tile then draws as well.
    const board = await import('../../path/src/systems/leaderboard.js');
    const { MAX_NAME_LEN } = await import('../../path/src/systems/playerName.js');
    const restore = snapshotStorage();
    const name = 'W'.repeat(MAX_NAME_LEN);
    for (let i = 0; i < 8; i++) {
      board.submitScoreLocal({
        name: i ? `${name.slice(0, MAX_NAME_LEN - 1)}${i}` : name,
        score: 128400 - i * 9137, kills: 412 - i * 17, level: 24 - i, time: 900 - i * 40,
        date: Date.now(),
      });
    }
    // Painted from the list as it is NOW — showLeaderboard reads it
    // synchronously — so the sweep below cannot empty the table it just drew.
    ui.showLeaderboard();
    await settle(60);
    // HANDED BACK rather than called: a flip re-paints the board, and a board
    // whose rows were already put back re-paints as empty. See the cleanup note
    // in runFrame.
    return restore;
  }
  if (surface === 'phone prompts') {
    // THE HUD UNDER THEM, because that is where they sit in the game: the stack
    // is z-index 5, over the run's own furniture and under every menu, so a
    // tile with nothing behind it would not be measuring the screen the rows
    // are actually on.
    ui.showHud();
    // The rows are mounted at initUI and are silent until the game says which
    // screen it is on. `menu` is the stage all three can appear on — and the
    // call is what re-asks the questions, which matters here: `.sv-touch` was
    // written onto the root AFTER initUI (see runFrame), so the mount's own
    // first pass answered for the laptop rather than for this tile's device.
    const prompts = await import('../../path/src/ui/mobilePrompts.js');
    prompts.resetMobilePromptStage();
    prompts.setMobilePromptStage('menu');
    // A DISMISSED ROW IS A ROW THIS TILE CANNOT MEASURE, and the ledger is in
    // localStorage on an origin every tile shares — so one sweep that somehow
    // wrote it would blind every later tile, with a clean sheet to show for it.
    // Cleared rather than trusted; the restore is for the same reason the
    // leaderboard's is.
    const restore = snapshotStorage();
    try { localStorage.removeItem('sealSurvivor.phonePrompts.v1'); } catch { /* no storage */ }
    prompts.setMobilePromptStage('run');
    prompts.setMobilePromptStage('menu');
    await settle(60);
    // Deferred like the other two: a flip re-asks every row's question, and a
    // ledger already put back could answer "dismissed" on the way home.
    return restore;
  }
  if (surface === 'team select') {
    // The screen alone. `onStart`/`onBack` are what the Text panel's own chip
    // passes — nothing to walk into from here, so both simply close it — and
    // neither is pressed: the sweep is a still.
    //
    // MEASURED ON THE LONGEST NAME THE SCREEN CAN BE ASKED TO DRAW. Seat 0 is
    // the player's own, off the splash, and it is the captain's row — the
    // biggest type in the column. Every other seat is cast at random from
    // sealNames.csv, so a sweep that took what it was given would measure a
    // different width on every run and would usually measure a short one. This
    // is the row that decided the panel's width ceiling (see ui/teamSelect.js),
    // and it is the row that comes back cut if anybody narrows it again.
    //
    // THE WRITE IS ROLLED BACK THE MOMENT THE SCREEN IS BUILT, and that is not
    // tidiness. Every tile is its own iframe but they all share ONE ORIGIN, so
    // localStorage is shared: a name left in the key is read by every tile that
    // mounts afterwards, and the upgrade cards expand {player} into their
    // descriptions. Measured with this left in, a thirty-two character name
    // overflowed a card on the Desktop tile — a finding invented entirely by
    // the harness, on a surface this branch has nothing to do with.
    //
    // savePlayerName caches in memory as well as writing, so the screen keeps
    // the long name after the storage is put back. `restore` is a snapshot of
    // the whole of localStorage rather than one key, so it cannot drift out of
    // step with whatever that key is called this month.
    const { savePlayerName, MAX_NAME_LEN } = await import('../../path/src/systems/playerName.js');
    const restore = snapshotStorage();
    savePlayerName('W'.repeat(MAX_NAME_LEN));
    const teams = await import('../../path/src/ui/teamSelect.js');
    // Built synchronously, so the roster has read the name before this line.
    teams.showTeamSelect({ parent: ui.uiRoot(), onStart() {}, onBack() {} });
    // Deferred for the same reason the board's is — see runFrame.
    return restore;
  }

  if (surface === 'room lobby') {
    // MEASURED IN ITS FULLEST STATE, which is the room with both players in it
    // — the pick screen is two buttons and could never overflow anything. The
    // members are written straight onto the exported roomState rather than
    // faked through a socket: this audit has no server, and roomState is the
    // object the screen renders from either way.
    const net = await import('../../path/src/systems/online/room.js');
    const lobby = await import('../../path/src/ui/roomLobby.js');
    lobby.showRoomLobby({ parent: ui.uiRoot(), onBack() {}, onHosting() {}, onGuestStart() {} });
    net.roomState.code = 'QRSTV';
    net.roomState.role = 'host';
    net.roomState.status = 'live';
    net.roomState.rtt = 42;
    net.roomState.members = [
      { role: 'host', name: '', ready: true, present: true },
      { role: 'guest', name: '', ready: false, present: true },
    ];
    lobby.showRoomLobbyRoom();
    return;
  }

  if (surface === 'settings' || surface === 'paused') {
    // Through the real entry point rather than by un-hiding the markup: the
    // body is rebuilt on the way in (buildBody reads the live settings) and a
    // panel that was only revealed would be measured with whatever rows it was
    // born with. `standalone` is the route — see the flag's note in pauseMenu.
    const pause = await import('../../path/src/ui/pauseMenu.js');
    pause.showPauseMenu({ standalone: surface === 'settings' });
    return;
  }
  if (surface === 'cards') {
    // A REROLL IN THE BANK FIRST, or the button under the hand is not on this
    // tile at all — the row is hidden on a run that has never beaten a boss
    // (see updateRerollButton in ui/ui.js), which is the correct default and
    // would leave the one control on this screen that is not a hexagon
    // unmeasured at every viewport. Written straight onto the real player
    // object rather than through previewScreen, because previewScreen is also
    // the Text panel's preview inside a LIVE run and must not hand out
    // rerolls there.
    const { player: realPlayer } = await import('../../path/src/entities/player.js');
    realPlayer.rerolls = 2;
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
  if (surface === 'HUD grown') {
    ui.previewScreen('HUD');
    // Pinned explicitly even though it is the default, so this tile keeps
    // measuring what its name says if the default is ever flipped back.
    //
    // Written onto the live settings object rather than through setSetting,
    // which would persist it: this harness measures, it does not have opinions
    // to save, and the key it would write is the one holding the real player's
    // choices on any origin it happens to share.
    const settings = await import('../../path/src/systems/settings.js');
    settings.settings.hud.barPlacement = 'corner';
    // AND THE THIRD COLUMN, because the worst case for this corner is the
    // widest the corner ever gets. settings.hud.boostMeter === 'bar' stands
    // the strike fuel beside the air as a pip column instead of drawing it
    // around the seal — so the stack the score and the clock step inboard of
    // on a phone is three tracks wide, not two, and the pip count (and with it
    // the column's length) climbs as links land.
    //
    // Pinned even though it is the default, exactly as barPlacement is above:
    // this tile keeps measuring what its name says if the default is ever
    // flipped back, rather than quietly going back to measuring two columns.
    settings.settings.hud.boostMeter = 'bar';
    // Half a mouthful's refill is double the pips: the longest fuel column a
    // run can actually produce, against the same ceiling the other two use.
    player.stats.strikeChumRefill = (await import('../../path/src/config.js'))
      .CONFIG.strike.charge.chumRefill / 2;

    // THE WORST CASE, which is a seal that has been buying health all run. The
    // corner columns are as long as the maximum they draw, so the frame that
    // can run off the top of the screen is not the opening one — it is this
    // one, three doublings later, and the CSS ceiling is what has to catch it.
    // The baseline is taken from the FIRST frame, so the order matters: one
    // call at the run's own maximum, then the upgrades.
    ui.updateHUD(gameState, player, null, 8.4, null, 1 / 60);
    player.stats.maxHp = 300;
    player.stats.maxOxygen = 260;
    // Long enough for the chase to arrive; dt is clamped to 0.1 inside updateHUD
    // however big a number is handed to it, so this is 8 seconds of settling.
    for (let i = 0; i < 80; i++) ui.updateHUD(gameState, player, null, 8.4, null, 0.1);
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
    // THE WORST CASE IS NOT A TIP ON AN EMPTY SCREEN. It is a tip during a boss
    // fight, with the run's prints already in the corner — every piece of top
    // chrome the band has to clear, all up at once. Built before the line so
    // the band is measured against a screen that is genuinely occupied; an
    // empty HUD would let a broken position pass on every viewport.
    ui.updateBossBar({ name: 'Wicked Grimgullet the Chumbucket Rumbler', hp: 4200, maxHp: 9000 });
    const print = await import('../../path/src/ui/snapshotPrint.js');
    print.initSnapshotPrints();
    // The parked pile, not a print in flight: a flying one is mid-transition
    // and its rect is wherever the animation happens to be, which is the same
    // unmeasurable thing PER_FRAME exists to keep out of this tool. Two of
    // them, because the corner fans and the second sits lower than the first.
    //
    // A REAL PICTURE, not an empty src. A broken <img> lays out its ALT TEXT
    // inside the frame and computes `overflow-x: clip`, which is a clipped
    // element by every rule below — 8 findings, one per viewport, describing
    // a caption that no player will ever see: in a run the print carries a
    // data URL grabbed off the renderer and the alt is never drawn. A 1x1 GIF
    // stretched to the frame is the same LAYOUT as a real print and none of
    // that. See the note at the head of this file about measuring the thing
    // the game builds rather than the stand-in.
    // A square crop rather than a data URL: the print is the Rive artboard now
    // and the coded paper that drew a plain <img> is gone, so `square` is what
    // decides whether there is a print at all. A bare canvas is enough — the
    // audit measures where the paper SITS, never what is drawn on it.
    //
    // Null when the artboard has not loaded, which on a page that never called
    // initSnapshotCards is always. Skipped rather than crashed: this pass is
    // about the corner the pile parks in, and it has nothing to measure.
    for (let i = 0; i < 2; i++) {
      const paper = print.buildPrintPaper(
        { name: 'Grimgullet', level: 14, time: 421, square: document.createElement('canvas') }, 132);
      if (!paper) break;
      paper.style.cssText = 'position:absolute; left:16px; '
        + `top:${40 + i * 18}px; width:132px;`;
      ui.uiRoot().appendChild(paper);
    }

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

/**
 * EVERY TILE SHARES ONE localStorage, because every tile is an iframe of the
 * same origin. A branch above that seeds a name or a board to measure the
 * widest row it can be asked to draw would otherwise be seeding it for every
 * surface that mounts afterwards — which is a finding the harness invented.
 *
 * Returns a function that puts the whole of it back. The whole of it rather
 * than one key: the key a module stores under is that module's business and is
 * not the harness's to know.
 */
function snapshotStorage() {
  let before = null;
  try { before = { ...localStorage }; } catch { /* no storage here; nothing to restore */ }
  return () => {
    if (!before) return;
    try {
      localStorage.clear();
      for (const [k, v] of Object.entries(before)) localStorage.setItem(k, v);
    } catch { /* as above */ }
  };
}

function settle(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Replace Math.random for the life of this frame with a deterministic stream.
 *
 * Global, and that is deliberate: the point is that everything this tile builds
 * is reproducible, and a generator passed politely to the one caller we know
 * about would leave every other roll — a rarity, a variant, a name — free to
 * move the numbers. mulberry32 off an FNV-1a of the tile's identity; no quality
 * is being asked of it beyond "the same every time and not obviously patterned".
 */
function seedRandom(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * WAIT FOR THE ANIMATIONS, NOT FOR A NUMBER OF MILLISECONDS.
 *
 * `settle(120)` was a guess at how long the entrance transitions take, and a
 * guess is fine right up until the sweep gets faster. Driving the page through
 * Electron instead of a person's browser cut a two-minute run to fifty seconds,
 * which moved every measurement earlier into the reveal — and a card caught
 * mid-transition is measured at the size the transition is passing THROUGH.
 * `getBoundingClientRect` returns the transformed box, so a panel two thirds of
 * the way through a scale-in reports every button inside it a fraction small,
 * and the score card's action bar came out at 43-point-something against a
 * 44px floor it was in fact honouring exactly.
 *
 * That produced the worst kind of finding: `tap target 86x44, under 44`, a
 * sentence that contradicts itself, on a run that passed clean the time before.
 * Nobody can act on an audit that answers differently to the same question, and
 * the first four such findings teach whoever reads it to skip that section.
 *
 * FINITE ONES ONLY, and this is the part that has to be right. The interface is
 * full of animations that never end — the boost core's pulse, the shimmer on a
 * legendary card — and `animation.finished` on an infinite animation is a
 * promise that never settles. Awaiting them all would hang every tile forever,
 * which is the failure this whole repair exists to remove, reintroduced one
 * layer down.
 *
 * SEVERAL PASSES, because a reveal is staggered: the rows of a menu are one
 * animation each, started as the one before it ends, so a single wait returns
 * while the later half has not begun. And a cap over the whole thing, because
 * "wait until the page stops moving" is not something a page is obliged to
 * agree to.
 */
async function settleAnimations(capMs = 1200) {
  if (!document.getAnimations) return;
  const deadline = Date.now() + capMs;
  for (let pass = 0; pass < 8; pass++) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    const running = document.getAnimations().filter((a) => {
      if (a.playState !== 'running') return false;
      const t = a.effect?.getComputedTiming?.();
      // An iteration count of Infinity is the loop; a non-finite endTime is the
      // same thing said another way, and both have to be excluded by hand
      // because neither one is visible from `playState`.
      return t && t.iterations !== Infinity && Number.isFinite(Number(t.endTime));
    });
    if (!running.length) return;
    // allSettled rather than all: an animation cancelled while we wait — which
    // is what a reveal does to the one it replaces — rejects its `finished`,
    // and that is a normal thing to have happened rather than an error.
    await Promise.race([
      Promise.allSettled(running.map((a) => a.finished)),
      settle(left),
    ]);
  }
}

// ---------------------------------------------------------------------------
// THE FLIP — turning the screen under a surface that is already up.
// ---------------------------------------------------------------------------

/** `852x393` from the URL, or null. */
function parseSize(raw) {
  const m = /^(\d+)x(\d+)$/.exec(String(raw ?? ''));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/**
 * Ask the parent to resize this frame, and come back when the surface has
 * finished reacting to it.
 *
 * THE FRAME CANNOT DO THIS ITSELF. `window.resizeTo` does nothing to an iframe
 * and there is no other way to move `innerWidth` from the inside, so the tile's
 * geometry belongs to the parent and this is a request. The underscore is the
 * ugly half of naming a local after the URL parameter it acts on; it is called
 * twice and from one place.
 *
 * THREE WAITS AFTERWARDS, and each one covers something the other two do not.
 * `resize` tells us the viewport has actually changed (a resize that is refused
 * or coalesced would otherwise be waited on forever, so the ack is raced against
 * a timeout). settleAnimations covers a surface that RE-REVEALS on a
 * breakpoint change — several do, and a signature taken mid-reveal is a
 * signature of a transform the layout is only passing through. The flat settle
 * at the end covers the relayouts that are queued to a timer rather than run
 * inline (`queueRelayout` in ui.js is one), which is exactly the class of code
 * this whole check exists to exercise.
 */
function flipTo_(w, h) {
  return new Promise((done) => {
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onAck);
      window.removeEventListener('resize', onResize);
      await settleAnimations();
      await settle(200);
      done();
    };
    // The viewport really changing is the signal worth waiting on; the parent's
    // ack only says the request was received.
    const onResize = () => finish();
    const onAck = (e) => { if (e.data?.kind === 'sv-flip-resized') setTimeout(finish, 250); };
    window.addEventListener('resize', onResize);
    window.addEventListener('message', onAck);
    parent.postMessage({ kind: 'sv-flip-resize', w, h }, '*');
    // A flip that never arrives must not hang the tile — see the stall note in
    // tools/layout-audit.mjs. Reporting a surface as clean because nothing
    // happened to it would be worse, so this is deliberately longer than any
    // honest resize and shorter than the parent's own watchdog.
    setTimeout(finish, 3000);
  });
}

/**
 * Where everything on this surface is, right now.
 *
 * THE SAME FILTER `measure()` USES, and that is not laziness — it is the
 * argument. Anything measure() refuses to judge (positioned per frame, a
 * deliberately full-bleed backdrop, an invisible node) is also something whose
 * position across a round trip means nothing, and including it here would put
 * findings in this check that the fit sweep has already decided are not
 * findings anywhere else.
 *
 * Rectangles rather than computed styles. A layout that failed to come back
 * shows up as a box in the wrong place or of the wrong size — which is the
 * thing a player sees — and a style diff would flag a hundred properties that
 * happen to be written differently without moving anything.
 */
function signature() {
  const out = new Map();
  for (const node of document.querySelectorAll(ROOTS)) {
    if (PER_FRAME.some((sel) => node.closest(sel))) continue;
    if (FULL_BLEED.some((sel) => node.closest(sel))) continue;
    if (node.classList.contains('sv-ui') || node.classList.contains('sv-center')) continue;
    const style = getComputedStyle(node);
    const hidden = style.visibility === 'hidden' || Number(style.opacity) === 0 || style.display === 'none';
    const r = node.getBoundingClientRect();
    // KEYED ON THE PATH PLUS AN ORDINAL, because `path()` is a readable identity
    // and not a unique one — a row of cards is eight elements with the same
    // name. Without the ordinal, eight boxes would collapse into one entry and
    // seven of them would be unwatched.
    const name = path(node);
    let n = 0;
    while (out.has(`${name}#${n}`)) n++;
    out.set(`${name}#${n}`, hidden || r.width < 1 || r.height < 1
      ? null
      : [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
  }
  return out;
}

/**
 * What did not come back. One finding per element, and the first few only.
 *
 * A SURFACE THAT LATCHES USUALLY LATCHES WHOLESALE — a container keeps its
 * portrait arrangement and every one of its forty children is then in the wrong
 * place. All forty are the same bug, and printing forty lines buries whatever
 * else the sweep found. The count is carried on the finding so the size of it
 * is still visible.
 */
function stuck(before, after) {
  // A CHECK THAT MEASURED NOTHING MUST NOT REPORT CLEAN, which is the same
  // argument the `empty` finding makes for the fit sweep and is not a
  // hypothetical here. The first version of this comparison was verified by
  // deliberately corrupting one entry, and it reported clean — the entry picked
  // happened to be one of the ~180 hidden nodes on that surface, which compare
  // null-to-null and are skipped. A real emptying of the signature (a selector
  // that stops matching, a filter that widens) would look exactly like the
  // clean sheet this whole sweep is trying to earn.
  //
  // Counted on the VISIBLE entries, because those are the only ones a
  // difference can be found in.
  const visible = [...before.values()].filter(Boolean).length;
  if (visible < MIN_NODES) {
    return [{ type: 'stuck-blind', what: 'the round trip', n: visible, of: before.size }];
  }

  const moved = [];
  const gone = [];
  for (const [key, a] of before) {
    const b = after.get(key);
    if (b === undefined) { gone.push(key); continue; }
    if (a === null && b === null) continue;
    if (a === null || b === null) { gone.push(key); continue; }
    const by = Math.max(...a.map((n, i) => Math.abs(n - b[i])));
    if (by > FLIP_SLOP) moved.push({ key, by, a, b });
  }
  // Elements that only exist AFTER the trip are the same bug seen from the
  // other side — a row that appeared on the way over and never left.
  for (const key of after.keys()) if (!before.has(key)) gone.push(key);

  const findings = [];
  moved.sort((x, y) => y.by - x.by);
  for (const m of moved.slice(0, 6)) {
    findings.push({
      type: 'stuck', what: m.key.replace(/#\d+$/, ''), by: m.by,
      was: m.a.join(','), now: m.b.join(','), of: moved.length,
    });
  }
  if (gone.length) {
    findings.push({
      type: 'stuck-count', what: gone.slice(0, 4).map((k) => k.replace(/#\d+$/, '')).join(', '),
      n: gone.length,
    });
  }
  return findings;
}

// --- the measurement --------------------------------------------------------

// WHAT THE SWEEP CAN SEE. Everything under the UI root, the callout layer —
// and the ball game's HUD, which is a sibling of .sv-ui on the body rather
// than a child of it (it has to sit under the menus at z-index 7; see the
// .sv-versus block in systems/versus.js).
//
// THAT OMISSION IS WHY THE COUNT BELOW EXISTS. The two match surfaces were
// added to SURFACES, built correctly, screenshotted correctly — and reported
// clean at all eight viewports, because not one of their elements was inside
// a root this list named. A surface that measures nothing passes, and a pass
// is exactly what it should never have been able to produce.
const ROOTS = '.sv-ui, .sv-ui *, .sv-callout-layer, .sv-callout-layer *, .sv-versus, .sv-versus *';

// The fewest elements a real surface can be. Every one of them mounts a panel
// or a strip with several nodes in it; a tile that measures fewer than this
// has built nothing, and is reporting on an empty screen.
const MIN_NODES = 3;

function measure() {
  const findings = [];
  const W = window.innerWidth;
  const H = window.innerHeight;
  const seen = new Set();
  let measured = 0;

  for (const node of document.querySelectorAll(ROOTS)) {
    if (PER_FRAME.some((sel) => node.closest(sel))) continue;
    if (FULL_BLEED.some((sel) => node.closest(sel))) continue;
    // Full-bleed layers (.sv-ui, .sv-center, .sv-toast-layer) are inset:0 by
    // definition and would report themselves as exactly filling the screen,
    // which is not a finding — it is the point of them.
    if (node.classList.contains('sv-ui') || node.classList.contains('sv-center')) continue;

    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

    measured++;
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
    // ...UNLESS THE TRUNCATION WAS ASKED FOR. `text-overflow: ellipsis` is a
    // declaration that this text is expected to be too long and that cutting it
    // with a visible "…" is the intended answer — a boss name across a 132px
    // print in the corner, which is never going to fit and is not meant to.
    // Reporting those is reporting a fix as a bug, and it is the same mistake
    // the scrolled-out check above exists to avoid.
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
    const truncatesOnPurpose = style.textOverflow === 'ellipsis';
    if (clips && !truncatesOnPurpose && node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
      once('clipped', { contentW: node.scrollWidth, boxW: node.clientWidth });
    }
    // ...AND THE SAME QUESTION DOWNWARDS, which this could not ask. Every check
    // here was about width, so a box that cuts the bottom off its own contents
    // reported clean: the upgrade cards shave the last line of twenty of their
    // hundred-odd texts, and nothing said so. Only where the overflow is
    // HIDDEN — a box with `auto` or `scroll` is taller than its contents on
    // purpose and everything in it is one flick away, which is the same
    // distinction scrollableAncestor draws above.
    const hidesY = style.overflowY === 'hidden' || style.overflowY === 'clip';
    if (hidesY && node.scrollHeight > node.clientHeight + 1 && node.clientHeight > 0) {
      once('clipped-below', { contentH: node.scrollHeight, boxH: node.clientHeight });
    }

    // OUT OF ITS OWN PANEL, which is the failure this could not see. Every
    // check above asks whether an element fits the SCREEN, and a button that
    // has slid out of the menu it belongs to fits the screen perfectly — it is
    // just sitting on the panel's edge with the water behind it. That is what
    // "Defaults" was doing in the pause footer: a row of flex:1 buttons cannot
    // shrink below its own words, so the last one hung off the side.
    //
    // Against the menu's BORDER box rather than its padding box, deliberately:
    // .sv-pm-body is inset -2px on purpose so its scrollbar clears the rows,
    // and a padding-box rule would report that as a bug on every tile.
    const panel = node.parentElement?.closest('.sv-menu');
    if (panel && !scrollableAncestor(node)) {
      const p = panel.getBoundingClientRect();
      const by = Math.round(Math.max(r.right - p.right, p.left - r.left, r.bottom - p.bottom, p.top - r.top));
      if (by > 1) once('out-of-panel', { by });
    }

    // Tap targets, which only matter where there is a thumb.
    const tappable = node.matches('button, input, [role="button"], .sv-card, .sv-fan-slot');
    if (tappable && params.get('touch') === '1' && (r.width < TAP_MIN || r.height < TAP_MIN)) {
      once('tap', { w: Math.round(r.width), h: Math.round(r.height) });
    }
  }

  // NOTHING TO MEASURE IS A FAILURE, NOT A PASS — see the note on ROOTS.
  if (measured < MIN_NODES) findings.push({ type: 'empty', what: 'the surface', n: measured });

  findings.push(...measureCalloutOverlap());
  return findings;
}

// THE DICE, THE PILL AND THE START BUTTON, which are not in the DOM.
//
// The splash is a Rive artboard fitted `Layout`, so artboard units are CSS
// pixels and the column's position is a closed form of three numbers: the
// canvas size, the scale the game wrote to `numEntryScale`, and the pill's
// width the artboard laid out and bound back through `numEntryWidth`. The
// closed form is ui/splashLayout.js — the same one the game fits with — and
// what this adds over `npm run test:splashlayout` is the REAL pill width from
// the real layout engine at this viewport, rather than an estimate, and the
// real tip jar and build stamp rects rather than restated ones.
//
// A number that cannot be read is a finding, not a pass: an export that lost
// `numEntryWidth` would otherwise measure a column of nothing.
async function measureSplash() {
  const out = [];
  const { splashFindings } = await import('../../path/src/ui/splashLayout.js');
  const { SPLASH_BINDINGS } = await import('../../path/src/ui/riveContract.js');
  const vmi = splashHandle?.rive?.viewModelInstance;
  let scale = null; let pillW = null;
  try {
    scale = vmi?.number(SPLASH_BINDINGS.entryScale)?.value ?? null;
    pillW = vmi?.number(SPLASH_BINDINGS.entryWidth)?.value ?? null;
  } catch { /* reported below */ }
  if (!(scale > 0) || !(pillW > 0)) {
    out.push({ type: 'splash-unread', what: 'splash entry column', by: `the artboard reported scale ${scale} and pill width ${pillW}; nothing could be measured` });
    return out;
  }
  const others = [];
  for (const sel of ['.sv-tip-splash', '.sv-build-stamp']) {
    for (const node of document.querySelectorAll(sel)) {
      const r = node.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      others.push({ what: path(node), rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
    }
  }
  out.push(...splashFindings({
    W: window.innerWidth, H: window.innerHeight, scale, pillW, others,
    touch: params.get('touch') === '1', tapMin: TAP_MIN,
  }));
  return out;
}

// A CALLOUT SITTING ON THE HUD.
//
// Not part of the sweep above, and it could not be: that walks one element at a
// time asking whether it fits the screen, and this is a question about a PAIR —
// two boxes that each fit perfectly and are in the same place. It is also the
// one kind of finding here that a screenshot makes obvious and a rectangle does
// not, which is why it took a rule rather than an eye to catch.
//
// Measured in screen space with getBoundingClientRect, so it accounts for the
// arrival scale, the lift, and every transform between the layer and the line.
function measureCalloutOverlap() {
  const out = [];
  const chrome = [];
  for (const node of document.querySelectorAll(CALLOUT_CHROME.join(','))) {
    if (node.classList.contains('sv-hidden')) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    chrome.push({ what: path(node), r });
  }

  for (const node of document.querySelectorAll(CALLOUT_LINES.join(','))) {
    if (node.classList.contains('sv-hidden')) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    for (const c of chrome) {
      // A pixel of tolerance, for the same reason the edge checks round: two
      // boxes that share a boundary are adjacent, not overlapping, and
      // sub-pixel layout puts half a pixel of everything past every edge.
      const ox = Math.min(r.right, c.r.right) - Math.max(r.left, c.r.left);
      const oy = Math.min(r.bottom, c.r.bottom) - Math.max(r.top, c.r.top);
      if (ox > 1 && oy > 1) {
        out.push({
          type: 'callout-over-ui',
          what: path(node),
          over: c.what,
          by: `${Math.round(ox)}x${Math.round(oy)}`,
        });
      }
    }
  }
  return out;
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
