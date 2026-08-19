import { CONFIG } from '../config.js';
import { encodeQr } from '../qr.js';
import kickersCsv from '../kickers.csv?raw';
import { parseKickerCsv, pickKicker } from '../kickerTable.js';
// The polaroid. Safe to import from a Node harness — snapshotCard.js pulls the
// Rive runtime in dynamically, inside its init, precisely so that this import
// does not drag a browser-only WASM package into every test that touches a
// kill shot.
import { renderSnapshotCardPng, renderSnapshotCards, snapshotCardsLive, cardTextFor, CARD_ASPECT } from '../ui/snapshotCard.js';

// THE TROPHY — the kill shot, kept.
//
// systems/bossKill.js already stops the world and pushes the frame in on the
// seal for half a second after a boss dies. That moment is the best-looking
// thing the game produces and it was, until now, gone the instant it finished.
// This grabs it: one PNG per boss killed, composited with the boss's name and
// what the run was at when it died, held for the rest of the session and
// offered on the death screen with a share button.
//
// WHY THE GRAB HAS TO HAPPEN WHERE IT DOES. The renderer is built without
// `preserveDrawingBuffer` (see world.js), which is the right default — it lets
// the browser throw the colour buffer away the moment the frame is composited,
// and turning it on costs a full-screen copy on EVERY frame of the game to
// serve about eight frames in a whole run. The consequence is that
// `canvas.toDataURL()` returns a blank image unless it is called in the same
// task as the draw. So main.js calls capture() immediately after post.render(),
// inside the same frame, and this file cannot be driven from anywhere else.
//
// Nothing here is on the hot path. capture() runs at most once per boss.

// Parsed once at module load rather than per kill — the file cannot change
// while the page is up, and parsing a five-row table on the frame a boss dies
// is work for nothing. Same reasoning as QUIPS in ui/ui.js.
const KICKERS = parseKickerCsv(kickersCsv);

// THE ROLL. Every boss killed this run, oldest first — not one slot that each
// kill overwrites, which is what this was until the score screen started
// fanning them all out.
//
// WHAT EACH ONE COSTS. The full-size image is held as a data URL because that
// is what the grab produces synchronously (see below) and what an <img> and a
// download both take without ceremony — about 2MB of string per picture, and
// `keep` is what stops eight of those becoming a memory leak with a lifetime
// of the tab. The `thumb` beside it is a small CANVAS rather than another
// string: the contact sheet is drawn from these, and canvas-to-canvas is
// synchronous where an <img> would have to be decoded first, which would make
// composing the sheet an async operation that can fail halfway.
const shots = [];

function cfg() {
  return CONFIG.boss?.kill?.snapshot ?? {};
}

/** The most recent trophy, or null if no boss has been beaten this run. */
export function bossShot() {
  const last = shots[shots.length - 1];
  return last ? { ...last } : null;
}

/** Every trophy from this run, oldest first. The score screen fans these out. */
export function bossShots() {
  return shots.map((s) => ({ ...s }));
}

/** A new run starts with no trophies — the score screen must not show the last one's. */
export function resetBossShot() {
  shots.length = 0;
  sheet.url = null;
  sheet.blob = null;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Grab the frame that is on screen RIGHT NOW and keep it.
 *
 * @param canvas the renderer's own canvas, mid-frame — see the note above.
 * @param meta   { name, cause, player, level, score, time } for the caption.
 *               `kicker` may be supplied to pin the label; left out, one is
 *               rolled from kickers.csv and kept on the shot.
 */
export function captureBossShot(canvas, meta = {}) {
  if (cfg().enabled === false || !canvas) return false;
  try {
    const made = compose(canvas, meta);
    if (!made) return false;
    const out = made.canvas;
    // THE THUMBNAIL IS TAKEN BEFORE THE CODE IS STAMPED, and that ordering is
    // the whole reason compose hands back a stamp instead of a finished
    // picture. The contact sheet is built from these thumbnails under a header
    // that carries its own code: leave the code on them and a two-boss run
    // ships an image with three QRs in it, two of them shrunk past the point
    // of scanning. A sheet has one code, on the scorecard, and the cells are
    // photographs.
    const thumb = thumbnail(out);
    // THE SQUARE, taken from the RAW frame rather than from the composite —
    // before the caption band, before the code, before anything this file
    // draws. It is what the Rive polaroid puts in its picture zone (see
    // ui/snapshotCard.js), and that artboard draws its own chin: a crop of the
    // captioned image would be a print of a print, with half a boss name
    // burnt into the photograph.
    //
    // Kept as a CANVAS, like the thumbnail beside it, not as a data URL. It is
    // ~1.5MB of bitmap either way, and a canvas can be handed straight to
    // decodeImage without base64ing two megabytes to immediately undo it.
    const square = squareCrop(canvas);
    made.stampQr();
    const shot = {
      url: out.toDataURL('image/png'),
      blob: null,
      thumb,
      square,
      name: meta.name ?? '',
      // Kept ON THE SHOT rather than looked up when a card is built: the score
      // screen's fan re-draws every print minutes after the fact, by which
      // time bossState is about the boss AFTER this one — or about nothing.
      cause: meta.cause ?? '',
      // The SOURCE KEY behind that caption, kept alongside it rather than
      // instead of it. The two answer different questions and both are needed:
      // `cause` is what this weapon was called at the moment of the kill and
      // must never be re-derived (the build goes on changing afterwards), while
      // this is the stable identity the score screen's table matches on to tag
      // the row that landed the final blow. Matching on the display name broke
      // the moment a weapon could be renamed mid-run — which is exactly what
      // weaponName.js does.
      causeSource: meta.causeSource ?? '',
      // WHOSE PRINT IT IS, banked here for the same reason the cause is: the
      // score screen's fan and the contact sheet redraw these cards long
      // afterwards, and a player who renamed themselves in the box on the score
      // screen would otherwise watch the prints they took ten minutes ago
      // retitle themselves. The photograph and the caption are one moment.
      player: meta.player ?? '',
      // THE LABEL ABOVE THE CAUSE, rolled here and kept, for the third time on
      // this object and the third version of the same reason: the fan and the
      // contact sheet redraw these cards, and a caption that re-rolls on every
      // redraw would have a print change its own joke while the player is
      // looking at it. See pickKicker.
      kicker: meta.kicker ?? pickKicker(KICKERS),
      level: meta.level ?? 0,
      score: meta.score ?? 0,
      time: meta.time ?? 0,
      at: Date.now(),
    };
    // The blob is asynchronous and the URL is not, so the image is usable
    // immediately and the share sheet becomes available a beat later. That
    // ordering is deliberate: the score screen is seconds away at the earliest,
    // and an <img> that appears at once matters more than a button that does.
    out.toBlob?.((blob) => { shot.blob = blob; }, 'image/png');
    shots.push(shot);
    // A run cannot produce more than about eight of these, but the cap is what
    // makes that a fact rather than a hope — and the oldest is the right one to
    // drop, because the roll reads as a progression and the last kill is the
    // one the player just made.
    while (shots.length > Math.max(1, cfg().keep ?? 8)) shots.shift();
    // Any sheet composed before this kill is now missing a picture.
    sheet.url = null;
    sheet.blob = null;
    return true;
  } catch (err) {
    // A tainted canvas, a lost context, a browser that refuses toDataURL on a
    // WebGL surface. None of it is worth a broken frame — the trophy is a
    // bonus, and the run carries on without one.
    console.warn(`[bossShot] could not keep the kill shot — ${err}`);
    return false;
  }
}

// The caption. Drawn onto a copy rather than over the live canvas, which would
// be drawing UI into the frame the player is still playing in.
//
// Returns { canvas, stampQr } rather than the canvas: the QR is the last thing
// to go on and the caller decides whether it goes on at all, because the same
// picture is used twice — once as the image somebody shares, once as a cell in
// the contact sheet, and only the first wants a code. The SPACE for it is
// reserved either way, so both readings are laid out identically.
function compose(src, meta) {
  const maxW = Math.max(320, cfg().maxWidth ?? 1600);
  const scale = Math.min(1, maxW / Math.max(1, src.width));
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  if (!(w > 0 && h > 0)) return null;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  if (!g) return null;
  // The game renders on a transparent canvas over a dark page (alpha: true in
  // world.js), so a straight copy onto an empty bitmap keeps that transparency
  // and every share target composites it against something different — usually
  // white. The backdrop is what makes the PNG look like the game rather than
  // like a screenshot of a bug.
  g.fillStyle = cfg().backdrop ?? '#05070d';
  g.fillRect(0, 0, w, h);
  g.drawImage(src, 0, 0, w, h);

  const band = Math.max(64, Math.round(h * (cfg().captionHeight ?? 0.22)));
  const grad = g.createLinearGradient(0, h - band, 0, h);
  grad.addColorStop(0, 'rgba(5,7,13,0)');
  grad.addColorStop(1, 'rgba(5,7,13,0.92)');
  g.fillStyle = grad;
  g.fillRect(0, h - band, w, band);

  const pad = Math.round(w * 0.035);
  const nameSize = Math.max(18, Math.round(h * 0.052));
  const subSize = Math.max(12, Math.round(h * 0.026));
  const family = CONFIG.typography?.family ?? 'system-ui, sans-serif';

  // The code goes in the bottom-right corner, and everything else on this
  // image gets out of its way rather than being drawn over: the boss name is
  // measured against what is LEFT of the width, and the wordmark right-aligns
  // to the code's left edge instead of the frame's.
  const gap = Math.round(pad * 0.5);
  const plan = qrPlan(Math.min(
    qrCfg().maxSize ?? 320,
    w * 0.34, // never a third of the frame, whatever the floor below says
    Math.max(qrCfg().minSize ?? 132, h * (qrCfg().size ?? 0.2)),
  ));
  const claimed = plan ? plan.w + gap : 0;

  g.textBaseline = 'alphabetic';
  g.fillStyle = 'rgba(255,120,120,0.95)';
  g.font = `700 ${subSize}px ${family}`;
  g.letterSpacing = '0.18em'; // ignored where unsupported; harmless
  g.fillText((cfg().kicker ?? 'DEFEATED').toUpperCase(), pad, h - pad - nameSize - subSize * 0.9);

  g.fillStyle = '#ffffff';
  g.font = `700 ${nameSize}px ${family}`;
  g.letterSpacing = '0.02em';
  fitText(g, (meta.name ?? 'A BOSS').toUpperCase(), pad, h - pad - subSize * 1.5,
    w - pad * 2 - claimed, nameSize, family);

  g.fillStyle = 'rgba(232,236,243,0.72)';
  g.font = `600 ${subSize}px ${family}`;
  const bits = [
    `Level ${meta.level ?? 0}`,
    formatTime(meta.time),
    `${Math.floor(meta.score ?? 0).toLocaleString()} pts`,
  ];
  g.fillText(bits.join('  ·  '), pad, h - pad * 0.6);

  // The wordmark, right-aligned on the same line. It is the reason a stranger
  // who sees this image knows what game it is; the code beside it is how they
  // get to it without typing anything.
  const mark = cfg().wordmark ?? 'SEAL SURVIVOR';
  g.textAlign = 'right';
  g.fillStyle = 'rgba(232,236,243,0.5)';
  g.fillText(mark, w - pad - claimed, h - pad * 0.6);
  g.textAlign = 'left';

  return {
    canvas: out,
    stampQr: () => {
      if (plan) drawQrPlan(g, plan, w - pad - plan.w, h - pad * 0.6 - plan.h);
    },
  };
}

// ---------------------------------------------------------------------------
// THE QR — see path/src/qr.js for the encoder, and the note in config.js for
// why the picture carries one at all.
//
// Both images want the same object at different sizes, so the shape is planned
// first (qrPlan) and drawn second (drawQrPlan): a caller has to know how wide
// the code came out BEFORE it draws, because the type on that line moves out
// of its way, and a panel measured after the fact is a wordmark drawn
// underneath a QR code.
// ---------------------------------------------------------------------------
function qrCfg() {
  return cfg().qr ?? {};
}

// One encode, kept. The link does not change between the kill shot and the
// sheet, and it does not change between runs — but it is keyed on the text
// rather than assumed, so a tuner edit to the link is picked up rather than
// cached past.
let cached = { text: null, code: null };

function qrFor(text) {
  if (!text) return null;
  if (cached.text === text) return cached.code;
  let code = null;
  try {
    code = encodeQr(text, qrCfg().level ?? 'M');
    if (!code) console.warn('[bossShot] the share link is too long for a QR code');
  } catch (err) {
    console.warn(`[bossShot] could not encode the QR — ${err}`);
  }
  cached = { text, code };
  return code;
}

/**
 * How big the code wants to be, and everything needed to draw it.
 *
 * @param box the largest square it may occupy, in pixels.
 * @returns { w, h, ... } or null when there is no code to draw — switched off,
 *          no link, or a link too long to encode. Every caller treats null as
 *          "no code" and lays out as if this feature did not exist.
 */
function qrPlan(box) {
  const c = qrCfg();
  if (c.enabled === false) return null;
  const code = qrFor(c.link ?? cfg().url ?? '');
  if (!code) return null;

  const quiet = Math.max(0, Math.round(c.quiet ?? 3));
  const span = code.size + quiet * 2;
  // WHOLE PIXELS PER MODULE. A fractional module size is a code whose squares
  // land on different pixel boundaries across the image — the edges alias, and
  // after a chat app has resized and recompressed the picture the small ones
  // stop resolving. Rounding down here costs at most one module of size and is
  // the difference between a code that scans off a phone screen and one that
  // is a grey square somebody gives up on.
  const unit = Math.max(1, Math.floor(box / span));
  const side = unit * span;
  const caption = c.caption ?? '';
  const capSize = caption ? Math.max(9, Math.round(side * 0.095)) : 0;
  const capBand = capSize ? Math.round(capSize * 1.5) : 0;
  return { code, unit, quiet, side, caption, capSize, capBand, w: side, h: side + capBand };
}

// Draws the plan with its top-left at x, y.
function drawQrPlan(g, plan, x, y) {
  const c = qrCfg();
  const { code, unit, quiet, side } = plan;
  // The panel, including the quiet zone — one light rectangle under
  // everything, because the picture behind it is a dark ocean and a code
  // drawn straight onto it has no white to be dark against.
  g.fillStyle = c.light ?? '#f4f7f8';
  g.fillRect(x, y, plan.w, plan.h);

  g.fillStyle = c.dark ?? '#05070d';
  const x0 = x + quiet * unit;
  const y0 = y + quiet * unit;
  for (let r = 0; r < code.size; r++) {
    // Runs rather than modules: a row of a version-3 code is 29 squares and
    // the dark ones come in twos and threes, so this is a third of the fill
    // calls and — more to the point — no seam between adjacent modules for a
    // JPEG to find.
    let run = 0;
    for (let cIdx = 0; cIdx <= code.size; cIdx++) {
      const dark = cIdx < code.size && code.modules[r * code.size + cIdx];
      if (dark) { run++; continue; }
      if (run) g.fillRect(x0 + (cIdx - run) * unit, y0 + r * unit, run * unit, unit);
      run = 0;
    }
  }

  if (plan.caption) {
    const family = CONFIG.typography?.family ?? 'system-ui, sans-serif';
    g.save?.();
    g.fillStyle = c.dark ?? '#05070d';
    g.font = `700 ${plan.capSize}px ${family}`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.letterSpacing = '0.12em';
    g.fillText(plan.caption, x + plan.w / 2, y + side + plan.capSize);
    g.letterSpacing = '0em';
    g.textAlign = 'left';
    g.restore?.();
  }
}

// THE SQUARE CROP — the frame, uncaptioned, cut to the shape the polaroid's
// picture zone actually is.
//
// The game renders at whatever shape the window is, usually about 16:9, and
// the zone is square: something has to go. A CENTRED crop is the right cut
// rather than a lucky one — systems/bossKill.js pushes the camera in on the
// seal for the whole of the shot this is grabbed from, so the subject is
// already in the middle of the frame. It costs about 44% of the width, which
// is why the bias below exists for the fights where it reads badly.
//
// Sized to the zone rather than to the source: 620 is what the artboard asks
// for, the in-run print never shows it wider than about 530 device pixels, and
// every extra hundred pixels here is another megabyte held per boss, eight
// times over, for the life of the tab.
function squareCrop(src) {
  const size = Math.max(64, Math.round(cfg().squareSize ?? 620));
  const side = Math.min(src.width, src.height);
  if (!(side > 0)) return null;
  // -1 pulls the crop to the top of the frame, 1 to the bottom, 0 is centred.
  const bias = Math.max(-1, Math.min(1, cfg().squareBiasY ?? 0));
  const room = src.height - side;
  const sx = Math.round((src.width - side) / 2);
  const sy = Math.round((room / 2) * (1 + bias));
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const g = out.getContext('2d');
  if (!g) return null;
  // The same backdrop the composite gets, and for the same reason: the game
  // draws on a transparent canvas, and a transparent picture inside a white
  // polaroid is a white square.
  g.fillStyle = cfg().backdrop ?? '#05070d';
  g.fillRect(0, 0, size, size);
  g.drawImage(src, sx, sy, side, side, 0, 0, size, size);
  return out;
}

// A cell-sized copy of the picture, kept for the contact sheet. Drawn once,
// here, rather than eight times when the sheet is composed — and at the size
// the sheet actually wants, so the grid is a straight blit rather than eight
// full-size downscales on the frame the player pressed a button.
function thumbnail(src) {
  const w = Math.max(64, Math.round(sheetCfg().cellWidth ?? 660));
  const h = Math.round((w * src.height) / Math.max(1, src.width));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  if (!g) return null;
  g.drawImage(src, 0, 0, w, h);
  return out;
}

// ---------------------------------------------------------------------------
// THE CONTACT SHEET — the whole run as one image.
//
// A player who beat five bosses has five pictures, and the share sheet takes
// one file at a time on most targets. Posting five separately is not something
// anybody does, so the run composes into a single PNG: the scorecard along the
// top, then every kill shot in a grid under it, oldest first, so the image
// reads as a run rather than as a folder.
//
// Composed on demand and cached, because it is only ever wanted from a button
// press and a run that ends without one being pressed should not have paid for
// it. Invalidated by any new kill.
// ---------------------------------------------------------------------------
const sheet = { url: null, blob: null };

function sheetCfg() {
  return cfg().sheet ?? {};
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Draw every trophy from this run into one image, under a scorecard.
 *
 * @param run { score, kills, level, time, bosses } — the recap. Handed in
 *            rather than read from a game module: this file knows about
 *            pictures, and the run is the caller's fact.
 * @returns a canvas, or null if there is nothing to draw.
 */
export async function composeRunSheet(run = {}) {
  if (!shots.length) return null;
  const c = sheetCfg();
  const cols = Math.max(1, Math.min(shots.length, c.columns ?? 2));
  const rows = Math.ceil(shots.length / cols);
  const cellW = Math.max(64, c.cellWidth ?? 660);

  // THE CELLS ARE POLAROIDS, when Rive can draw them. Every kill shot on the
  // sheet is the same card the player watched come out of the camera and the
  // same card they can share on its own — one look, wherever a kill shot
  // appears, which is the whole reason the artboard exists.
  //
  // Rendered CONCURRENTLY (see renderSnapshotCards): each card has to be given
  // time to write itself on, and eight of those in series is twenty seconds of
  // a share button looking broken.
  //
  // At pixelRatio 1, because this is a file rather than a screen: a 3x phone
  // would otherwise silently triple every cell and compose a sheet too big to
  // send.
  const cards = await renderSnapshotCards(
    shots.map((s) => ({ photo: s.square, meta: cardTextFor(s) })),
    { width: cellW, pixelRatio: 1 },
  );
  const asCards = cards.some(Boolean);

  // A polaroid is taller than the frame inside it, so the row height follows
  // whichever cell is actually being drawn — and the fallback keeps the old
  // thumbnail's shape rather than leaving a card-sized hole.
  const first = shots[0].thumb;
  const cellH = asCards
    ? Math.round(cellW * CARD_ASPECT)
    : (first ? Math.round((cellW * first.height) / Math.max(1, first.width)) : Math.round(cellW * 0.5625));
  const gap = Math.round(c.gap ?? 18);
  const pad = Math.round(c.pad ?? 34);
  const head = Math.round(c.headerHeight ?? 250);
  // Room for the tilt to swing into. A card rotated in place needs its corners
  // to have somewhere to go, and without this the spread clips every one of
  // them against its neighbour.
  const tilt = asCards ? num(c.tilt, 2.4) : 0;
  const swing = tilt ? Math.ceil(cellW * Math.abs(Math.sin(tilt * Math.PI / 180)) * 0.6) : 0;

  const w = pad * 2 + cols * cellW + (cols - 1) * gap + swing * 2;
  const h = pad + head + rows * cellH + (rows - 1) * gap + pad + swing;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  if (!g) return null;

  g.fillStyle = c.backdrop ?? cfg().backdrop ?? '#05070d';
  g.fillRect(0, 0, w, h);
  drawScorecard(g, run, pad, pad, w - pad * 2, head - gap);

  for (let i = 0; i < shots.length; i++) {
    const x = pad + swing + (i % cols) * (cellW + gap);
    const y = pad + head + Math.floor(i / cols) * (cellH + gap);
    const card = asCards ? cards[i] : null;

    if (card) {
      // A SPREAD, NOT A GRID: alternating tilts so the sheet reads as
      // photographs dropped on a table rather than as a contact sheet. Rotated
      // about each card's own centre, so the lean does not walk the card out
      // of its cell.
      const angle = (i % 2 ? tilt : -tilt) * (Math.PI / 180);
      g.save();
      g.translate(x + cellW / 2, y + cellH / 2);
      g.rotate(angle);
      // The card's paper carries its own shadow in the artboard; this is the
      // one it casts on the sheet, which is what separates two overlapping
      // prints.
      g.shadowColor = 'rgba(0,0,0,0.5)';
      g.shadowBlur = Math.round(cellW * 0.035);
      g.shadowOffsetY = Math.round(cellW * 0.012);
      g.drawImage(card, -cellW / 2, -cellH / 2, cellW, cellH);
      g.restore();
      continue;
    }

    const t = shots[i].thumb;
    if (t) g.drawImage(t, x, y, cellW, cellH);
    else {
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(x, y, cellW, cellH);
    }
    // A hairline around each frame, so the grid reads as separate photographs
    // rather than as one image that happens to have seams in it.
    g.strokeStyle = c.frame ?? 'rgba(255,255,255,0.14)';
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
  }
  return out;
}

// THE SCORECARD. The same five figures the score screen shows, drawn into the
// image — an image posted somewhere else has no score screen next to it, and
// without these it is a picture of a fish rather than a result.
//
// THREE BANDS, and they are bands rather than a free arrangement because the
// first version had the title and the numbers sharing a line: the title is set
// large and a long one ran straight into "SCORE". Nothing here is positioned
// relative to anything it could collide with — the top line is the top line,
// the numbers sit on the bottom line, and the space between them is whatever
// the header height leaves over.
function drawScorecard(g, run, x, y, w, h) {
  const family = CONFIG.typography?.family ?? 'system-ui, sans-serif';
  const c = sheetCfg();
  const title = Math.max(20, Math.round(h * 0.26));
  const label = Math.max(11, Math.round(h * 0.075));
  const value = Math.max(16, Math.round(h * 0.19));

  // The code first, because the whole header lays itself out around it: it
  // takes the right-hand end of the band, top to bottom, and the title, the
  // URL and the four figures all get the width that is left.
  const gap = Math.round(c.gap ?? 18);
  const plan = qrPlan(Math.min(qrCfg().maxSize ?? 320, h, w * 0.3));
  const claimed = plan ? plan.w + gap * 2 : 0;
  if (plan) drawQrPlan(g, plan, x + w - plan.w, y + Math.max(0, (h - plan.h) / 2));

  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffffff';
  g.font = `700 ${title}px ${family}`;
  g.fillText(c.title ?? 'SEAL SURVIVOR', x, y + title);

  // Right-aligned on the title's own line, where there is nothing to run into.
  // It stays even with the code beside it: the address in type is what a
  // person reads out loud to somebody in the same room, and it is the only
  // route left if the picture is looked at on the device it was shared from.
  g.textAlign = 'right';
  g.fillStyle = 'rgba(232,236,243,0.5)';
  g.font = `600 ${label}px ${family}`;
  g.fillText(cfg().url ?? 'seal-survivor.pages.dev', x + w - claimed, y + title);
  g.textAlign = 'left';

  const bosses = run.bosses ?? shots.length;
  g.fillStyle = 'rgba(255,120,120,0.95)';
  g.font = `700 ${label}px ${family}`;
  g.fillText(`${bosses} BOSS${bosses === 1 ? '' : 'ES'} DEFEATED`, x, y + title + label * 2);

  // The figures along the bottom of the band, in four even columns across the
  // full width — the numbers are what a stranger reads after the pictures.
  const stats = [
    ['SCORE', Math.floor(run.score ?? 0).toLocaleString()],
    ['TIME', formatTime(run.time)],
    ['LEVEL', String(run.level ?? 0)],
    ['KILLS', String(run.kills ?? 0)],
  ];
  const colW = (w - claimed) / stats.length;
  for (let i = 0; i < stats.length; i++) {
    const cx = x + i * colW;
    g.fillStyle = 'rgba(232,236,243,0.55)';
    g.font = `600 ${label}px ${family}`;
    g.fillText(stats[i][0], cx, y + h - value * 1.25);
    g.fillStyle = '#ffffff';
    g.font = `700 ${value}px ${family}`;
    g.fillText(stats[i][1], cx, y + h);
  }
}

// Boss names run to forty characters ("Wicked Grimgullet the Chumbucket
// Rumbler"), and a name that runs off the edge of the image is worse than a
// small one. Shrinks until it fits, down to a floor.
function fitText(g, text, x, y, maxWidth, size, family) {
  let px = size;
  g.font = `700 ${px}px ${family}`;
  while (g.measureText(text).width > maxWidth && px > 12) {
    px -= 1;
    g.font = `700 ${px}px ${family}`;
  }
  g.fillText(text, x, y);
}

/** A filename with the boss and the date in it, so a folder of these reads. */
function fileName(shot) {
  const slug = (shot?.name || 'boss').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `seal-survivor-${slug || 'boss'}.png`;
}

// Which picture a caller means. Everything below takes an index into the roll,
// and every one of them defaults to the LAST — that keeps the old one-trophy
// callers (and the share button that predates the fan) meaning exactly what
// they used to mean.
function shotAt(index) {
  if (!shots.length) return null;
  if (index == null) return shots[shots.length - 1];
  return shots[Math.max(0, Math.min(shots.length - 1, Math.floor(index)))] ?? null;
}

/**
 * Hand an image to the player. MUST be called from a click — both the share
 * sheet and (on some browsers) the download are gated on a user gesture.
 *
 * Three routes, in order of how good they are, and the first one that exists
 * wins:
 *   1. THE NATIVE SHARE SHEET, with the file attached. This is the one the
 *      request was actually about — it is what puts the image into Messages,
 *      Instagram, Discord, anywhere the device knows about — and it is the only
 *      route that can hand over a FILE rather than a link. Mobile, mostly.
 *   2. A DOWNLOAD, which every desktop browser can do, leaving the player to
 *      post it themselves.
 *   3. Opening it in a tab, if even the download anchor is refused.
 *
 * Nothing here posts anything anywhere. The share sheet is the OS asking the
 * player where they want it; this code never sees an account and never picks a
 * destination.
 *
 * @param index which trophy, oldest first. Omitted means the latest.
 * @returns 'shared' | 'saved' | 'opened' | 'cancelled' | 'unavailable'
 */
export async function shareBossShot(index) {
  const shot = shotAt(index);
  if (!shot?.url) return 'unavailable';
  const title = shot.name ? `I beat ${shot.name}` : 'Seal Survivor';
  const text = shot.name
    ? `${title} at level ${shot.level} in Seal Survivor. ${cfg().url ?? 'https://seal-survivor.pages.dev'}`
    : `Seal Survivor. ${cfg().url ?? 'https://seal-survivor.pages.dev'}`;
  // The polaroid if there is one, the captioned composite if not — same file
  // name and same words either way, because what changed is how the picture
  // looks and not what it is.
  const card = await cardImage(shot);
  return handOver(card?.blob ?? shot.blob, card?.url ?? shot.url, fileName(shot), title, text);
}

/** Straight to disk, no sheet. Also the fallback for share. */
export async function saveBossShot(index) {
  const shot = shotAt(index);
  if (!shot?.url) return 'unavailable';
  const card = await cardImage(shot);
  // The blob as well as the url — see download(). Without it the anchor gets a
  // 2MB data: URL, which is the form Safari refuses outright.
  return download(card?.url ?? shot.url, fileName(shot), card?.blob ?? shot.blob);
}

// ---------------------------------------------------------------------------
// THE POLAROID AS THE SHARED FILE
//
// What leaves the game is the same object the player watched come out of the
// camera: ui/snapshotCard.js draws the Rive artboard off screen at share size
// and hands back a PNG. The captioned composite above is still built and still
// kept — it is the fallback when Rive is not drawing, and it is what the
// contact sheet's cells are made of — but it is not what gets posted.
//
// ONE THING IS MISSING FROM THE CARD AND IT IS DELIBERATE: the QR. The code
// lives on the composite, and the polaroid has no slot for one yet (see the
// note in ui/riveContract.js). Until `imgQr` is placed, a shared kill shot
// carries no code. `shareCard: false` in config puts the captioned composite
// back, code and all, in one value.
// ---------------------------------------------------------------------------

function cardImage(shot) {
  if (!shot) return Promise.resolve(null);
  // Cached ON THE SHOT rather than in a map: it is the same object shotAt
  // hands out every time, it dies with the run, and a player who shares and
  // then saves must not pay for two renders of an identical picture.
  if (shot.card) return Promise.resolve(shot.card);
  if (cfg().shareCard === false || !shot.square || !snapshotCardsLive()) return Promise.resolve(null);
  if (shot.cardPending) return shot.cardPending;

  shot.cardPending = (async () => {
    try {
      const url = await renderSnapshotCardPng({
        photo: shot.square,
        meta: cardTextFor(shot),
        width: Math.max(320, cfg().cardWidth ?? 1600),
      });
      if (!url) {
        // Not an exception — the card module returns null when the artboard
        // failed to bind. Said out loud because the symptom otherwise is a
        // share button that quietly hands over the plain frame instead.
        console.warn('[bossShot] the polaroid drew nothing; sharing the plain frame.');
        return null;
      }
      // The share sheet wants a FILE, which means a blob. Round-tripping the
      // data URL through fetch is a local decode, not a request.
      const blob = await (await fetch(url)).blob();
      shot.card = { url, blob };
      return shot.card;
    } catch (err) {
      console.warn(`[bossShot] could not render the polaroid, sharing the plain frame — ${err}`);
      return null;
    }
  })();
  return shot.cardPending;
}

/**
 * Render every trophy's polaroid NOW, before anybody presses anything.
 *
 * WHY THIS IS NOT LAZY. navigator.share needs transient activation — it has to
 * be called while the click that triggered it is still "recent" — and a render
 * awaited inside the handler can spend that activation before the sheet is
 * ever asked for, which fails as a share that silently turns into a download.
 * The score screen calls this when it appears, seconds before any button can
 * be pressed, so by then cardImage returns a cached picture immediately.
 *
 * Failures are swallowed on purpose: this is a warm-up, and every caller
 * already copes with getting no card.
 */
export async function warmShareCards() {
  // ONE AT A TIME. Each of these builds a Rive instance, decodes a bitmap and
  // reads back a 1600x2000 canvas; eight of them started at once is both a
  // spike on the frame the score screen is arriving on and a real race — the
  // runtime hands back an unbound artboard often enough, under that much
  // concurrent loading, that the cards come out empty. Sequential, they are
  // ~50ms each and the player is still reading the first line of the screen.
  for (const shot of shots) await cardImage(shot);
}

/**
 * The whole run as one image — the scorecard and every kill shot in a grid.
 * Composed on the first press and cached, so a player who shares and then
 * saves does not pay for it twice.
 *
 * @param run the recap, as composeRunSheet takes it.
 */
export async function shareRunSheet(run = {}) {
  if (!await buildSheet(run)) return 'unavailable';
  const bosses = run.bosses ?? shots.length;
  const title = 'My Seal Survivor run';
  const text = `${bosses} boss${bosses === 1 ? '' : 'es'} down, level ${run.level ?? 0},`
    + ` ${Math.floor(run.score ?? 0).toLocaleString()} points in Seal Survivor.`
    + ` ${cfg().url ?? 'https://seal-survivor.pages.dev'}`;
  return handOver(sheet.blob, sheet.url, 'seal-survivor-run.png', title, text);
}

/**
 * The same image, straight to disk.
 *
 * ASYNC now, because the sheet is a spread of Rive cards and every one of them
 * has to finish drawing before it can be composed. The caller has to await it —
 * a bare call returns a Promise, and `told(saveRunSheet())` would report the
 * word "[object Promise]" at the player instead of what happened.
 */
export async function saveRunSheet(run = {}) {
  if (!await buildSheet(run)) return 'unavailable';
  return download(sheet.url, 'seal-survivor-run.png', sheet.blob);
}

// Compose once, keep it. Returns false when there is nothing to compose —
// which is not a failure, it is a run that never met a boss.
//
// THE BLOB IS AWAITED, and that one word is the difference between the share
// sheet opening and not. `canvas.toBlob` is a CALLBACK, so the version of this
// that fired it and returned on the next line handed `sheet.blob` — still null,
// and null for another frame or two — to handOver, which saw no file, skipped
// navigator.share entirely and fell through to the download. On a phone that is
// the whole bug: "Share all" could not open the sheet even once, because the
// picture it was meant to attach did not exist yet on the line that asked for
// it. Nothing about it looked broken, either — the fallback ran, and the
// fallback is silent on iOS (see download).
async function buildSheet(run) {
  // Both halves, not just the url: a sheet cached by an older build could have
  // a url and no blob, and this is exactly the check that would wave it through.
  if (sheet.url && sheet.blob) return true;
  try {
    // Async now that the cells are Rive cards — each one has to be given time
    // to write itself on before it can be read off a canvas. Still composed
    // once and cached, so a player who shares and then saves pays for it once.
    const canvas = await composeRunSheet(run);
    if (!canvas) return false;
    sheet.url = canvas.toDataURL('image/png');
    sheet.blob = await blobOf(canvas);
    return true;
  } catch (err) {
    console.warn(`[bossShot] could not compose the run sheet — ${err}`);
    return false;
  }
}

/** canvas.toBlob as a promise. Resolves null rather than rejecting — every
 *  caller already copes with having no blob, and one that throws here would
 *  take down a share that could still have happened as a download. */
function blobOf(canvas) {
  return new Promise((resolve) => {
    if (!canvas.toBlob) { resolve(null); return; }
    canvas.toBlob((blob) => resolve(blob ?? null), 'image/png');
  });
}

/**
 * Compose the run sheet NOW, before anybody presses anything — the same warm-up
 * warmShareCards does for the single trophies, and for the same reason.
 *
 * navigator.share needs TRANSIENT ACTIVATION: it must be called while the click
 * that triggered it is still recent, and iOS is strict about it. Composing the
 * sheet inside the handler spends that activation — it is eight Rive cards
 * drawn and read back, hundreds of milliseconds across many frames — so by the
 * time share was asked for, the browser had stopped believing a human asked.
 * The failure is a NotAllowedError that lands in the catch below and turns into
 * a silent download.
 *
 * Warmed here instead, seconds earlier, while the player is still reading the
 * top of the score card. Failures are swallowed on purpose: the button still
 * works without this, it just pays for the compose itself.
 */
export async function warmRunSheet(run = {}) {
  try {
    await buildSheet(run);
  } catch { /* the button will try again, and say so if it fails */ }
}

/**
 * Can this device hand a PICTURE to the OS? Not `navigator.share` on its own —
 * that exists on desktop Safari and on Android for sharing a LINK, and refuses
 * a file — so the question is asked with a real file in it, which is the only
 * form of it that answers what we need to know.
 *
 * Exported because the score screen changes shape on the answer: where the OS
 * sheet exists it is also how you save (iOS calls it "Save Image"), so a
 * separate save button there is a second button doing the first one's job. See
 * wireTrophy in ui/ui.js.
 */
export function canShareImages() {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false;
  try {
    const probe = new File([new Blob([''], { type: 'image/png' })], 'probe.png', { type: 'image/png' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

// THE THREE ROUTES, in one place. Both the single trophy and the whole sheet
// take exactly the same path out of the game, and having written it twice once
// already — the second copy is where the AbortError check goes missing — it is
// written here once and handed what to send.
async function handOver(blob, url, name, title, text) {
  const file = blob ? new File([blob], name, { type: 'image/png' }) : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return 'shared';
    } catch (err) {
      // AbortError is the player closing the sheet, which is not a failure and
      // must not fall through to a download they did not ask for.
      if (err?.name === 'AbortError') return 'cancelled';
      console.warn(`[bossShot] share failed, saving instead — ${err}`);
    }
  }
  return download(url, name, blob);
}

/**
 * Straight to the filesystem, where there is one.
 *
 * THE BLOB IS PREFERRED OVER THE DATA URL, which is not a micro-optimisation.
 * A kill shot is a ~1.5MB PNG and its data URL is ~2MB of base64 in an href;
 * Safari refuses to navigate to a data: URL of any size from an anchor at all
 * (it has since 2018, as an anti-phishing measure), and iOS ignores the
 * `download` attribute on one. Put together, the old path did LITERALLY NOTHING
 * on an iPhone: the anchor was created, clicked and removed, no file arrived,
 * no error was raised, and this function returned 'saved'. The button was not
 * broken so much as it was lying.
 *
 * A blob: URL is same-origin and navigable, so the anchor works where anchors
 * work — and where it doesn't, opening it in a tab at least puts the picture
 * on screen where it can be long-pressed and saved, which is how you save an
 * image on a phone anyway.
 */
function download(url, name, blob = null) {
  // The object URL is an UPGRADE on the data URL, not a replacement for it, so
  // failing to mint one falls back to what this always used rather than to
  // nothing. createObjectURL genuinely can refuse — it is absent in a worker,
  // and a Blob built by one realm is not a Blob to another realm's URL, which
  // is exactly what a jsdom harness hands it.
  let href = url;
  let objectUrl = null;
  if (blob) {
    try {
      objectUrl = URL.createObjectURL(blob);
      href = objectUrl;
    } catch (err) {
      console.warn(`[bossShot] no object URL for the save, using the data URL — ${err}`);
    }
  }
  if (!href) return 'unavailable';
  // Revoked on a timer rather than immediately after the click: the download is
  // started by the click but not finished by it, and pulling the URL out from
  // under a 2MB transfer cancels it. A minute is far longer than any local
  // save takes and the page is a score screen, not a long-lived document.
  const release = () => { if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000); };

  try {
    const a = document.createElement('a');
    // `'download' in a` is false on iOS Safari, which is the browser this whole
    // branch exists for. Asked rather than sniffed for a platform, so a browser
    // that gains or loses the attribute is handled by the fact rather than by a
    // user-agent string that will be wrong eventually.
    if ('download' in a) {
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      release();
      return 'saved';
    }
  } catch (err) {
    console.warn(`[bossShot] could not save — ${err}`);
  }

  // No anchor download on this browser. Open the picture instead — a tab with
  // the image in it is something a player can act on; a button that did nothing
  // is not.
  const opened = window.open(href, '_blank');
  release();
  return opened ? 'opened' : 'unavailable';
}
