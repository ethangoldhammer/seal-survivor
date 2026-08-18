#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bossshot
//
// The trophy: the kill shot kept as an image, and the share button on the death
// screen.
//
// Every failure in here is silent, and most of them only show up in front of
// another person — which is the whole point of a share button:
//
//   A BLANK PNG          the renderer runs without preserveDrawingBuffer, so
//                        the grab is only valid in the same task as the draw.
//                        Move it behind a promise or a timer and every trophy
//                        is a transparent rectangle. The cue is one frame wide
//                        and this pins that down.
//   SOMEBODY ELSE'S BOSS a trophy that survives into the next run means the
//                        death screen offers a picture of a fight this player
//                        never had.
//   TWO PICTURES         the cue firing more than once per boss, or surviving
//                        an interrupted shot, quietly replaces the good frame
//                        with a later, worse one.
//   A SILENT SHARE       the sheet being closed, a download happening instead —
//                        three genuinely different outcomes that must not all
//                        report success.
//   POSTING BY ITSELF    nothing here may reach the network on its own. The
//                        share sheet is the OS asking the player where they
//                        want it, and it is only ever opened from a click.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
// Let pending microtasks and zero-delay timers run. Saving a shot renders the
// Rive polaroid first when one is available, so a click handler no longer
// finishes inside the dispatch that triggered it.
const tick = () => new Promise((r) => setTimeout(r, 0));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.File = dom.window.File;
globalThis.Blob = dom.window.Blob;

// A canvas that records what was drawn on it, so the caption can be asserted
// rather than eyeballed. jsdom has no 2D context of its own worth the name.
const drawn = { texts: [], images: 0, fills: 0, strokes: 0 };
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    canvas: this,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, clearRect() {}, save() {}, restore() {},
    fillRect() { drawn.fills++; },
    strokeRect() { drawn.strokes++; },
    drawImage() { drawn.images++; },
    fillText(t) { drawn.texts.push(String(t)); },
    measureText: (t) => ({ width: String(t).length * 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
    set font(v) { this._font = v; }, get font() { return this._font; },
    set letterSpacing(v) { this._ls = v; }, get letterSpacing() { return this._ls; },
    set textAlign(v) { this._ta = v; }, get textAlign() { return this._ta; },
    set textBaseline(v) { this._tb = v; }, get textBaseline() { return this._tb; },
    set strokeStyle(v) { this._ss = v; }, get strokeStyle() { return this._ss; },
    set lineWidth(v) { this._lw = v; }, get lineWidth() { return this._lw; },
  };
};
let toDataURLCalls = 0;
let lastPngWidth = 0;
dom.window.HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
  toDataURLCalls++;
  lastPngWidth = this.width;
  return 'data:image/png;base64,STUBBEDPNG';
};
// ASYNCHRONOUS, like the real one. This used to call back on the spot, and a
// synchronous toBlob is the one condition under which the run sheet's share
// button worked: the code fired toBlob and read the blob on the very next line,
// which is correct only in a harness that answers immediately. In a browser the
// blob is still null there, so navigator.share was never handed a file and
// every "Share all" silently became a download. A stub that is easier to write
// than the thing it stands for is a stub that certifies the bug.
dom.window.HTMLCanvasElement.prototype.toBlob = function toBlob(cb) {
  setTimeout(() => cb(new dom.window.Blob(['png'], { type: 'image/png' })), 0);
};
// jsdom has no object URLs. The real one is what a save on iOS depends on (see
// download in bossShot.js), so it is stubbed rather than left to throw — and
// the href it produces is what the checks below read to tell a blob: save from
// the 2MB data: URL that iOS Safari refuses.
let objectUrls = 0;
dom.window.URL.createObjectURL = (blob) => `blob:http://localhost/${++objectUrls}-${blob?.type ?? ''}`;
dom.window.URL.revokeObjectURL = () => {};
globalThis.URL = dom.window.URL;

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) {
      return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source:
        'export class Rive { constructor(){} on(){} play(){} pause(){} cleanup(){} resizeDrawingSurfaceToCanvas(){} }'
        + ' export const EventType = {}; export const Layout = class {}; export const Fit = {};'
        + ' export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub-asset";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

const { CONFIG } = await import('../path/src/config.js');
const SHOT = await import('../path/src/systems/bossShot.js');
const KILL = await import('../path/src/systems/bossKill.js');

const canvas = document.createElement('canvas');
canvas.width = 2400; canvas.height = 1200;
const meta = { name: 'Grimtide the Tidebreaker', level: 12, score: 45300, time: 754 };
const DT = 1 / 60;

// ---------------------------------------------------------------------------
section('THE CUE — one frame, once per boss');
// ---------------------------------------------------------------------------
KILL.resetBossKill();
SHOT.resetBossShot();
check('no cue while nothing has died', KILL.bossKillShotDue() === false);

KILL.startBossKill();
const K = CONFIG.boss.kill;
// Through the punch and into the hold, counting how many frames raise the cue.
let cues = 0;
let elapsed = 0;
let firstCueAt = null;
let scaleAtCue = 1;
let zoomAtCue = 1;
for (let i = 0; i < 600; i++) {
  KILL.updateBossKill(DT);
  elapsed += DT;
  if (KILL.bossKillShotDue()) {
    cues++;
    if (firstCueAt === null) {
      firstCueAt = elapsed;
      scaleAtCue = KILL.bossKillState.timeScale;
      zoomAtCue = KILL.bossKillState.camZoom;
    }
  }
  if (!KILL.bossKillState.active) break;
}
check('the shot is taken exactly once', cues === 1, `${cues} cue(s)`);
// It has to land inside the HOLD — before it the camera is still travelling,
// after it the restore has started pulling back out.
const holdStart = K.dilateTime;
const holdEnd = K.dilateTime + K.beatTime;
check('...during the hold, not the push or the release',
  firstCueAt > holdStart && firstCueAt < holdEnd,
  `at ${firstCueAt?.toFixed(2)}s, hold is ${holdStart}-${holdEnd.toFixed(2)}s`);
check('...and at the fraction of it the config asks for',
  Math.abs((firstCueAt - holdStart) / K.beatTime - K.snapshot.at) < 0.05,
  `${((firstCueAt - holdStart) / K.beatTime).toFixed(2)} vs ${K.snapshot.at}`);
check('...with the world at its slowest when it is taken',
  Math.abs(scaleAtCue - K.hold) < 1e-6, `x${scaleAtCue.toFixed(3)}`);
check('...and the frame fully pushed in on the seal',
  zoomAtCue > K.cam.zoom - 0.05, `zoom ${zoomAtCue.toFixed(2)} of ${K.cam.zoom}`);

// A shot cut short — a death, a restart — must not leave the cue armed into
// whatever happens next.
KILL.resetBossKill();
KILL.startBossKill();
KILL.updateBossKill(DT); // still in the punch, nowhere near the hold
KILL.resetBossKill();
let leaked = 0;
for (let i = 0; i < 120; i++) if (KILL.bossKillShotDue()) leaked++;
check('an interrupted shot leaves no armed cue behind', leaked === 0, `${leaked}`);

// ---------------------------------------------------------------------------
section('THE PICTURE — what actually gets kept');
// ---------------------------------------------------------------------------
SHOT.resetBossShot();
drawn.texts.length = 0; drawn.images = 0;
const before = toDataURLCalls;
const took = SHOT.captureBossShot(canvas, meta);
check('the frame is captured', took === true);
check('...straight off the canvas, synchronously', toDataURLCalls === before + 1);
// Three times, and each one is a different picture of the same frame:
//   1. the shareable composite at full size, which the caption goes on;
//   2. the cell-sized thumbnail the contact sheet is drawn from (see
//      thumbnail() — the sheet composes synchronously and cannot decode an
//      <img>), taken before the QR is stamped;
//   3. the uncaptioned SQUARE the Rive polaroid puts in its picture zone (see
//      squareCrop, and ui/snapshotCard.js).
// All three have to happen inside this call: the renderer runs without
// preserveDrawingBuffer, so the frame is gone the moment this task yields.
check('...drawing the game frame into it', drawn.images === 3, `${drawn.images} image(s)`);

const shot = SHOT.bossShot();
check('a trophy exists afterwards', !!shot);
check('...carrying the boss it was taken from', shot.name === meta.name, shot.name);
check('...and what the run was at', shot.level === 12 && shot.score === 45300, `L${shot.level} ${shot.score}`);
check('...as a usable image url', String(shot.url).startsWith('data:image/png'), String(shot.url).slice(0, 24));

// THE CAPTION is what makes it legible to someone who was not there.
const caption = drawn.texts.join(' | ');
check('the caption names the boss', caption.includes(meta.name.toUpperCase()), caption);
check('...says what happened to it', caption.includes(CONFIG.boss.kill.snapshot.kicker), caption);
check('...carries the run', caption.includes('Level 12') && caption.includes('45,300 pts'), caption);
check('...shows the time as a clock, not a float', caption.includes('12:34'), caption);
check('...and says which game it is', caption.includes(CONFIG.boss.kill.snapshot.wordmark), caption);

// A LONG NAME must not run off the edge — the roster produces forty-character
// ones, and the fit is a shrink rather than a clip.
drawn.texts.length = 0;
SHOT.captureBossShot(canvas, { ...meta, name: 'Wicked Grimgullet the Chumbucket Rumbler' });
check('a forty-character name still lands whole',
  drawn.texts.some((t) => t === 'WICKED GRIMGULLET THE CHUMBUCKET RUMBLER'),
  drawn.texts.join(' | '));

// The image is scaled to the configured long edge rather than saved at whatever
// the display happened to be.
check('the image is capped at the configured width, not saved at display size',
  lastPngWidth === CONFIG.boss.kill.snapshot.maxWidth && canvas.width > lastPngWidth,
  `${canvas.width} on screen → ${lastPngWidth} saved`);

// ---------------------------------------------------------------------------
section('BETWEEN RUNS — a trophy belongs to the run that earned it');
// ---------------------------------------------------------------------------
check('there is one now', !!SHOT.bossShot());
// THE ROLL. Every boss killed is kept, not just the last — the score screen
// fans all of them out. From a clean roll, because the section above took two
// pictures of its own.
SHOT.resetBossShot();
SHOT.captureBossShot(canvas, meta);
SHOT.captureBossShot(canvas, { ...meta, name: 'Old Bittermouth', level: 19 });
check('a second boss adds a second trophy', SHOT.bossShots().length === 2, `${SHOT.bossShots().length}`);
check('...oldest first', SHOT.bossShots()[0].name === meta.name, SHOT.bossShots()[0].name);
check('...with the latest still the one a bare call means', SHOT.bossShot().name === 'Old Bittermouth');
const keep = CONFIG.boss.kill.snapshot.keep;
for (let i = 0; i < keep + 3; i++) SHOT.captureBossShot(canvas, { ...meta, name: `Boss ${i}` });
check('...and the roll has a depth', SHOT.bossShots().length === keep, `${SHOT.bossShots().length} of ${keep}`);
check('...dropping the oldest, not the newest',
  SHOT.bossShots()[keep - 1].name === `Boss ${keep + 2}`, SHOT.bossShots()[keep - 1].name);
SHOT.resetBossShot();
check('a new run starts with none', SHOT.bossShot() === null && SHOT.bossShots().length === 0);
check('...and sharing nothing is refused rather than guessed at',
  await SHOT.shareBossShot() === 'unavailable');

// ---------------------------------------------------------------------------
section('SHARING — three routes, three honest answers');
// ---------------------------------------------------------------------------
SHOT.captureBossShot(canvas, meta);
await new Promise((r) => setTimeout(r, 10)); // toBlob is a callback

// 1. The device has a share sheet and will take files.
let sharedWith = null;
navigator.canShare = (d) => Array.isArray(d?.files) && d.files.length > 0;
navigator.share = async (d) => { sharedWith = d; };
check('the share sheet is used when the device has one', await SHOT.shareBossShot() === 'shared');
check('...with the image attached as a file, not a link',
  sharedWith?.files?.length === 1 && sharedWith.files[0].type === 'image/png');
check('...named after the boss', /grimtide/.test(sharedWith.files[0].name), sharedWith.files[0].name);
check('...and the text says where to play',
  String(sharedWith.text).includes(CONFIG.boss.kill.snapshot.url), sharedWith.text);
check('...and names the boss the player beat',
  String(sharedWith.title).includes(meta.name), sharedWith.title);

// 2. The player closes the sheet. That is not a failure, and it must NOT fall
//    through to dropping a file in their downloads they never asked for.
let downloads = 0;
let lastDownloadName = '';
const realCreate = document.createElement.bind(document);
// Counts the anchor clicks a save makes, and records the FILENAME — which is
// the only evidence that "Save this one" saved the print the player picked
// rather than whichever one happened to be last.
const countingCreate = (tag) => {
  const e = realCreate(tag);
  if (tag === 'a') {
    const c = e.click.bind(e);
    e.click = () => { downloads++; lastDownloadName = e.download ?? ''; c?.(); };
  }
  return e;
};
document.createElement = countingCreate;
navigator.share = async () => { const err = new Error('closed'); err.name = 'AbortError'; throw err; };
check('closing the sheet reports a cancel', await SHOT.shareBossShot() === 'cancelled');
check('...and does not save anything behind the player\'s back', downloads === 0, `${downloads} download(s)`);

// 3. No share sheet at all — the desktop case. A download, reported as one.
navigator.canShare = undefined;
navigator.share = undefined;
downloads = 0;
check('with no sheet it saves the file instead', await SHOT.shareBossShot() === 'saved');
check('...actually triggering one download', downloads === 1, `${downloads}`);
downloads = 0;
// Awaited: saving now renders the Rive polaroid first when one is available
// (see cardImage in systems/bossShot.js), so the answer arrives a tick later
// even on the path where no card is drawn at all.
check('the Save button does the same on its own', await SHOT.saveBossShot() === 'saved');
check('...once', downloads === 1, `${downloads}`);
document.createElement = realCreate;

// ---------------------------------------------------------------------------
section('ON A PHONE — the sheet, and the save that is not a download');
// ---------------------------------------------------------------------------
// Both of the failures here were reported as "the save and share buttons don't
// work on mobile", and neither of them raised anything. One handed the share
// sheet nothing to share; the other clicked an anchor iOS ignores. What they
// have in common is that the fallback path is silent, so a broken share and a
// working one look identical from the desktop they were written on.

// A device with a share sheet that takes files — a phone.
let phoneShare = null;
navigator.canShare = (d) => Array.isArray(d?.files) && d.files.length > 0;
navigator.share = async (d) => { phoneShare = d; };

// THE RUN SHEET, ON THE FIRST PRESS. Composing it is asynchronous — eight cards
// drawn and read back — and the blob it ends with arrives a tick after the
// canvas does. The version that returned before that tick handed handOver a
// null blob, so this came back 'saved' on a device whose whole point is that it
// can share. It is the FIRST press that matters: a second one finds the sheet
// cached and would have passed all along, which is why this asks once.
const runRecap = { score: 45300, level: 12, kills: 212, time: 754, bosses: 1 };
const firstPress = await SHOT.shareRunSheet(runRecap);
check('the whole run reaches the share sheet on the first press', firstPress === 'shared', firstPress);
check('...with the image actually attached',
  phoneShare?.files?.length === 1 && phoneShare.files[0].type === 'image/png',
  `${phoneShare?.files?.length ?? 0} file(s)`);
check('...named as a run rather than as a boss',
  phoneShare?.files?.[0]?.name === 'seal-survivor-run.png', phoneShare?.files?.[0]?.name);

// THE SAVE ROUTE. On a browser with no share sheet this falls to an anchor, and
// what that anchor is POINTED AT is the whole bug: a data: URL is refused
// outright by Safari and ignored by iOS, so the click did nothing at all and
// this function still reported success.
let lastHref = '';
const hrefCatcher = (tag) => {
  const e = realCreate(tag);
  if (tag === 'a') {
    const c = e.click.bind(e);
    e.click = () => { lastHref = e.getAttribute('href') ?? ''; c?.(); };
  }
  return e;
};
document.createElement = hrefCatcher;
navigator.canShare = undefined;
navigator.share = undefined;
check('saving a print hands the anchor a blob, not two megabytes of base64',
  await SHOT.saveBossShot() === 'saved' && lastHref.startsWith('blob:'), lastHref.slice(0, 24));
lastHref = '';
check('...and so does saving the whole run',
  await SHOT.saveRunSheet(runRecap) === 'saved' && lastHref.startsWith('blob:'), lastHref.slice(0, 24));
document.createElement = realCreate;

// WHICH BUTTONS THE SCORE SCREEN SHOULD OFFER. The answer is asked with a real
// file in it, because navigator.share exists on desktops that will not take
// one — and a save button removed on a machine that cannot share instead is the
// same bug pointed the other way.
navigator.canShare = undefined;
navigator.share = undefined;
check('with no sheet, the score screen keeps its save buttons', SHOT.canShareImages() === false);
navigator.canShare = (d) => Array.isArray(d?.files) && d.files.length > 0;
navigator.share = async () => {};
check('...and drops them where the OS sheet can save the picture itself',
  SHOT.canShareImages() === true);
// A desktop that can share a LINK but not a file must keep them.
navigator.canShare = (d) => !d?.files;
check('...but not merely because the browser can share a link',
  SHOT.canShareImages() === false);
navigator.canShare = undefined;
navigator.share = undefined;

// ---------------------------------------------------------------------------
section('THE SWITCH');
// ---------------------------------------------------------------------------
CONFIG.boss.kill.snapshot.enabled = false;
SHOT.resetBossShot();
check('switched off, no picture is taken', SHOT.captureBossShot(canvas, meta) === false);
check('...and there is nothing to offer', SHOT.bossShot() === null);
KILL.resetBossKill();
KILL.startBossKill();
let cuesOff = 0;
for (let i = 0; i < 600; i++) {
  KILL.updateBossKill(DT);
  if (KILL.bossKillShotDue()) cuesOff++;
  if (!KILL.bossKillState.active) break;
}
check('...and the cue never fires either', cuesOff === 0, `${cuesOff}`);
CONFIG.boss.kill.snapshot.enabled = true;

// ---------------------------------------------------------------------------
section('THE SCORE SCREEN — the whole run, fanned out');
// ---------------------------------------------------------------------------
// The last seam: trophies that exist but are never shown are the same as no
// trophies at all, and a rack left holding the previous run's prints is worse
// than either.
const UI = await import('../path/src/ui/ui.js');
UI.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });
const runState = { score: 45300, kills: 210, level: 12, time: 754 };

SHOT.resetBossShot();
UI.showGameOver(runState, { bosses: 0 });
const trophy = document.getElementById('svTrophy');
const fan = document.getElementById('svFan');
check('a run with no boss kill shows no rack', trophy.classList.contains('sv-hidden'));
check('...and holds no prints to leak into the next one', fan.children.length === 0);

// Three bosses, three prints.
for (const [name, level] of [['Grimtide the Tidebreaker', 8], ['Old Bittermouth', 16], ['Wicked Grimgullet the Chumbucket Rumbler', 24]]) {
  SHOT.captureBossShot(canvas, { ...meta, name, level });
}
UI.showGameOver(runState, { bosses: 3 });
check('a run that beat three shows three prints', !trophy.classList.contains('sv-hidden') && fan.children.length === 3,
  `${fan.children.length} in the rack`);
check('...as the same paper the player watched come out of the camera',
  fan.children[0].querySelector('.sv-print-paper') !== null
  && fan.children[0].querySelector('.sv-print-photo').src.startsWith('data:image/png'));
check('...each one named', fan.children[1].querySelector('.sv-print-name').textContent === 'Old Bittermouth',
  fan.children[1].querySelector('.sv-print-name').textContent);
check('...developed, not still coming out of the camera',
  !fan.children[0].querySelector('.sv-print').classList.contains('sv-print-wet')
  && !fan.children[0].querySelector('.sv-print').classList.contains('sv-print-flight'));
check('...fanned rather than stacked',
  fan.children[0].style.getPropertyValue('--rot') !== fan.children[2].style.getPropertyValue('--rot'),
  `${fan.children[0].style.getPropertyValue('--rot')} .. ${fan.children[2].style.getPropertyValue('--rot')}`);
check('...with the newest kill picked to start with',
  fan.children[2].classList.contains('sv-fan-sel'));

// PICKING ONE is what the two "this one" buttons act on.
fan.children[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
check('picking a print lifts it out of the fan', fan.children[0].classList.contains('sv-fan-sel')
  && !fan.children[2].classList.contains('sv-fan-sel'));

downloads = 0;
navigator.canShare = undefined;
navigator.share = undefined;
document.createElement = countingCreate;
document.getElementById('svTrophySave').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
// The Save handler is async now, so the download lands on a later microtask
// than the click that asked for it.
await tick();
check('...and Save this one saves THAT one', downloads === 1 && lastDownloadName.includes('grimtide'),
  lastDownloadName);

fan.children[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
downloads = 0;
document.getElementById('svTrophySave').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await tick();
check('...and picking another changes which one', downloads === 1 && lastDownloadName.includes('bittermouth'),
  lastDownloadName);

// THE SCORECARD, on screen and in the image, from the same five figures.
const statLine = document.getElementById('svGameOverStats').textContent;
for (const bit of ['45,300', '12:34', '210', '3']) {
  check(`the scorecard carries ${bit}`, statLine.includes(bit), statLine);
}

// ---------------------------------------------------------------------------
section('THE WHOLE RUN — one image, one share');
// ---------------------------------------------------------------------------
drawn.texts.length = 0; drawn.images = 0;
const sheetCanvas = await SHOT.composeRunSheet({ score: 45300, kills: 210, level: 12, time: 754, bosses: 3 });
check('the run composes into one image', !!sheetCanvas);
check('...with every kill in it', drawn.images === 3, `${drawn.images} drawn`);
const sheetText = drawn.texts.join(' | ');
check('...under a scorecard naming the game', sheetText.includes(CONFIG.boss.kill.snapshot.sheet.title), sheetText);
check('...saying how many went down', sheetText.includes('3 BOSSES DEFEATED'), sheetText);
check('...and carrying the run', ['45,300', '12:34', '12', '210'].every((b) => sheetText.includes(b)), sheetText);
const S = CONFIG.boss.kill.snapshot.sheet;
check('...laid out in the grid the config asks for',
  sheetCanvas.width === S.pad * 2 + S.columns * S.cellWidth + (S.columns - 1) * S.gap,
  `${sheetCanvas.width}x${sheetCanvas.height}`);

downloads = 0;
// AWAITED, because the sheet is a spread of Rive cards now: the click handler
// is async, and a check that runs on the next line runs before the download
// it is asserting about. Two ticks — one for the handler, one for the compose
// it awaits — is enough here because nothing in this harness actually renders
// a card (snapshotCardsLive is false without a browser, so the sheet falls
// back to thumbnails and never waits on a frame).
const settleClick = () => new Promise((r) => setTimeout(r, 0));
document.getElementById('svSheetSave').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await settleClick();
check('Save all saves the run, not a single kill',
  downloads === 1 && lastDownloadName === 'seal-survivor-run.png', lastDownloadName);

// A sheet is composed once and kept — a player who shares and then saves must
// not pay for eight downscales twice.
const beforeCompose = toDataURLCalls;
document.getElementById('svSheetSave').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await settleClick();
check('...and is not composed again for the second press', toDataURLCalls === beforeCompose,
  `${toDataURLCalls - beforeCompose} extra encode(s)`);
document.createElement = realCreate;

// And nothing survives into the next run.
SHOT.resetBossShot();
UI.showGameOver(runState, { bosses: 0 });
check('the next run inherits no prints', trophy.classList.contains('sv-hidden') && fan.children.length === 0);
check('...and no run sheet either', await SHOT.saveRunSheet({}) === 'unavailable');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
section('THE MOMENT — long enough for the print to land in');
// ---------------------------------------------------------------------------
// The shot now has a fourth phase: after the beat, the world stays slow while
// the print flies to the corner. The failure it exists to stop is not a crash
// — it is the ocean coming back to full speed with a photograph still sliding
// across the middle of the screen, which reads as a UI bug rather than as a
// flourish.
const P = CONFIG.boss.kill.print;
// writeOnMs is in here for the same reason it is in printPhaseSeconds: the
// print sits still in the middle of the screen while the artboard writes
// itself on, and the world must not come back underneath that. Re-derived from
// CONFIG rather than typed, which is the whole point of the check below — a
// literal here would pass while the two drifted apart.
const flight = (P.ejectMs + Math.max(P.holdMs, P.writeOnMs) + P.parkMs) / 1000;

function runShot() {
  KILL.resetBossKill();
  KILL.startBossKill();
  const seen = [];
  let t = 0;
  let shutterAt = null;
  let fullSpeedAt = null;
  for (let i = 0; i < 2000; i++) {
    const scale = KILL.updateBossKill(DT);
    t += DT;
    if (seen[seen.length - 1] !== KILL.bossKillState.phase && KILL.bossKillState.active) {
      seen.push(KILL.bossKillState.phase);
    }
    if (shutterAt === null && KILL.bossKillShotDue()) shutterAt = t;
    if (shutterAt !== null && fullSpeedAt === null && scale >= 0.999) fullSpeedAt = t;
    if (!KILL.bossKillState.active) break;
  }
  return { phases: seen, total: t, shutterAt, fullSpeedAt };
}

const shotRun = runShot();
check('the shot runs punch → hold → print → restore',
  shotRun.phases.join(' → ') === 'punch → hold → print → restore', shotRun.phases.join(' → '));
check('the print phase is derived from the print, not typed next to it',
  Math.abs(KILL.printPhaseSeconds() - (flight - K.beatTime * (1 - K.snapshot.at))) < 1e-9,
  `${KILL.printPhaseSeconds().toFixed(3)}s`);
check('the world is still slow when the print reaches the corner',
  shotRun.fullSpeedAt - shotRun.shutterAt >= flight - DT,
  `${(shotRun.fullSpeedAt - shotRun.shutterAt).toFixed(2)}s of slow motion for a ${flight.toFixed(2)}s flight`);
check('...and the whole thing still ends',
  shotRun.total < 5 && !KILL.bossKillState.active, `${shotRun.total.toFixed(2)}s`);

// Switched off, the phase must not exist at all — a beat of zero length that
// still costs a frame of state is the sort of thing that survives a retune.
CONFIG.boss.kill.print.enabled = false;
const noPrint = runShot();
check('with the print off there is no print phase',
  !noPrint.phases.includes('print') && KILL.printPhaseSeconds() === 0, noPrint.phases.join(' → '));
check('...and the moment is shorter by exactly the flight it no longer covers',
  shotRun.total - noPrint.total > 0.5, `${shotRun.total.toFixed(2)}s vs ${noPrint.total.toFixed(2)}s`);
CONFIG.boss.kill.print.enabled = true;

// ---------------------------------------------------------------------------
section('THE BODY — still in the water when the shutter goes');
// ---------------------------------------------------------------------------
// The bug this whole change exists to fix: the boss burst on the frame it
// died, a second before the picture was taken, so every trophy was a seal
// celebrating over a cloud of debris with the animal already gone.
const CORPSE = await import('../path/src/systems/bossCorpse.js');

const removed = [];
const fakeScene = { remove: (m) => removed.push(m) };
function deadBoss() {
  return {
    isBoss: true,
    vx: 6, vy: 2,
    radius: 4,
    mesh: { position: { x: 12, y: -6 }, rotation: { z: 0 } },
    visual: null, hitShape: null, anim: null,
  };
}

CORPSE.resetBossCorpses();
const body = deadBoss();
check('a dead boss is claimed rather than burst', CORPSE.holdBossCorpse(body, fakeScene) === true);
check('...and marked, so removeEnemy leaves its visual alone', body.corpseHeld === true);
// Read straight after the claim, because that is when the ragdoll's knock has
// been added and before any of it has been spent — the number the deceleration
// below is measured against.
const shovedAtDeath = { x: body.vx, y: body.vy };
check('the hold outlasts the shutter it exists to survive',
  CORPSE.corpseHoldSeconds() > KILL.snapshotMoment(),
  `${CORPSE.corpseHoldSeconds().toFixed(2)}s hold vs a shutter at ${KILL.snapshotMoment().toFixed(2)}s`);

// Tick it exactly as main.js does — wall clock for the countdown, dilated
// clock for the drift — and ask what is in the water at the shutter.
let corpseT = 0;
let aliveAtShutter = null;
let burstAt = null;
for (let i = 0; i < 600; i++) {
  CORPSE.updateBossCorpses(DT, DT * CONFIG.boss.kill.hold);
  corpseT += DT;
  if (aliveAtShutter === null && corpseT >= KILL.snapshotMoment()) {
    aliveAtShutter = CORPSE.bossCorpseCount();
  }
  if (burstAt === null && CORPSE.bossCorpseCount() === 0) burstAt = corpseT;
  if (burstAt !== null) break;
}
check('the body is whole when the picture is taken', aliveAtShutter === 1, `${aliveAtShutter} in the water`);
check('...and comes apart just after, not during', burstAt > KILL.snapshotMoment(),
  `burst at ${burstAt?.toFixed(2)}s`);
check('...handing the visual back on the way out', removed.length === 1 && body.corpseHeld === false);
// WHAT THE BODY DOES, and it is no longer only drifting.
//
// This used to check that a corpse travels LESS than it would have swum, which
// was the whole of "going limp" when going limp meant losing the drive. It now
// takes the blow that killed it as well (systems/bossRagdoll.js), so it is
// shoved on the killing frame and covers more ground than the live animal
// would have — the old check measured a fact that stopped being true and was
// never quite the claim worth making anyway.
//
// What still has to hold, and is the actual claim: the water is SPENDING the
// body's speed rather than the animal renewing it. A dead boss decelerates from
// whatever it was left with, sinks while it does, and rolls over.
const shoved = { x: body.vx, y: body.vy };
check('the blow shoves the body along itself',
  (body.mesh.position.x - 12) * shoved.x + (body.mesh.position.y + 6) * shoved.y > 0,
  `moved ${(body.mesh.position.x - 12).toFixed(2)}, ${(body.mesh.position.y + 6).toFixed(2)}`);
check('...with the drive going out of it', Math.abs(body.vx) < Math.abs(shovedAtDeath.x),
  `vx ${body.vx.toFixed(2)} from ${shovedAtDeath.x.toFixed(2)} at the moment of the blow`);
check('...the water pulling it down rather than up', body.vy < shovedAtDeath.y,
  `vy ${body.vy.toFixed(2)} from ${shovedAtDeath.y.toFixed(2)}`);
check('...and the body turning over', body.mesh.rotation.z !== 0,
  `roll ${body.mesh.rotation.z.toFixed(3)} rad`);

// A restart in the middle of a hold releases the body WITHOUT exploding it: a
// boss coming apart over the opening frame of the next run is worse than one
// that simply is not there.
removed.length = 0;
const second = deadBoss();
CORPSE.holdBossCorpse(second, fakeScene);
CORPSE.resetBossCorpses();
check('a restart mid-hold releases the body', CORPSE.bossCorpseCount() === 0 && removed.length === 1);
check('...and leaves nothing for the next run to frame', CORPSE.bossCorpseFocus() === null);

// The seam in entities/enemies.js: a held body must not have its visual
// released back to the pool while the corpse is still drawing with it.
const ENEMIES = await import('../path/src/entities/enemies.js');
const pooled = { name: 'megalodon', visible: true, userData: { __rest: {} }, parent: null };
const held = { corpseHeld: true, mesh: {}, visual: pooled, hitShape: null };
ENEMIES.enemies.length = 0;
ENEMIES.enemies.push(held);
ENEMIES.removeEnemy(fakeScene, 0);
check('removeEnemy drops a held boss from the enemy list', ENEMIES.enemies.length === 0);
check('...without releasing the visual the corpse is still drawing with',
  pooled.visible === true, 'the visual was pooled mid-shot');

// ---------------------------------------------------------------------------
section('THE FRAMING — two animals in one picture');
// ---------------------------------------------------------------------------
// The push-in used to be aimed at the seal and zoomed to a fixed 2.2, which
// put a forty-unit boss mostly outside the frame. The fit is the assertion
// that matters: BOTH have to be inside the shot at the instant of the grab.
const half = { w: 46, h: 26 }; // the arena's own half-frame at zoom 1

function frameAtShutter(seal, boss) {
  KILL.resetBossKill();
  KILL.startBossKill();
  for (let i = 0; i < 2000; i++) {
    KILL.setBossKillFraming(seal, boss, half);
    KILL.updateBossKill(DT);
    if (KILL.bossKillShotDue()) {
      return {
        x: KILL.bossKillState.cam.x,
        y: KILL.bossKillState.cam.y,
        zoom: KILL.bossKillState.camZoom,
      };
    }
    if (!KILL.bossKillState.active) break;
  }
  return null;
}

function insideFrame(f, pt, r = 0) {
  return Math.abs(pt.x - f.x) + r <= half.w / f.zoom + 1e-6
    && Math.abs(pt.y - f.y) + r <= half.h / f.zoom + 1e-6;
}

// A boss killed at arm's length, and one killed across the arena.
for (const [label, seal, boss] of [
  ['nose to nose', { x: 0, y: 0 }, { x: 5, y: 1, r: 4 }],
  ['half an arena apart', { x: -18, y: 8 }, { x: 16, y: -9, r: 9 }],
  ['a megalodon underfoot', { x: 6, y: -2 }, { x: -6, y: -6, r: 16 }],
]) {
  const f = frameAtShutter(seal, boss);
  check(`${label}: the seal is in the picture`, insideFrame(f, seal),
    `frame ${f.x.toFixed(1)},${f.y.toFixed(1)} at zoom ${f.zoom.toFixed(2)}`);
  check(`${label}: ...and so is the boss`, insideFrame(f, boss, boss.r),
    `boss ${boss.x},${boss.y} r${boss.r}`);
  check(`${label}: ...the frame never opens past the ordinary view`,
    f.zoom >= K.cam.minZoom - 1e-9, `zoom ${f.zoom.toFixed(2)}`);
  check(`${label}: ...and never pushes further than the shot asked for`,
    f.zoom <= K.cam.zoom + 1e-9, `zoom ${f.zoom.toFixed(2)}`);
}

// The frame leans toward the seal, which is the subject. A midpoint would be a
// picture of a corpse with a seal in the corner.
const lean = frameAtShutter({ x: 0, y: 0 }, { x: 24, y: 0, r: 6 });
check('the frame leans toward the seal rather than splitting the difference',
  lean.x > 0 && lean.x < 12, `focus x ${lean.x.toFixed(1)} between 0 and 24`);

// ...but only while there is room for it. Across a whole arena the lean is
// what pushes the boss out of the picture, so it is given up rather than the
// boss: the widest allowed frame, centred on the pair.
const wall = frameAtShutter({ x: 30, y: 0 }, { x: -20, y: -4, r: 18 });
check('a kill at the far wall gives up the lean rather than the boss',
  Math.abs(wall.x - (30 + (-20 - 18)) / 2) < 0.01, `focus x ${wall.x.toFixed(1)}`);
check('...which is what gets both of them into the picture after all',
  wall.zoom >= K.cam.minZoom
  && insideFrame(wall, { x: 30, y: 0 })
  && insideFrame(wall, { x: -20, y: -4 }, 18),
  `zoom ${wall.zoom.toFixed(2)}`);

// With nothing to frame — the hold switched off, a boss that left no body —
// the shot is exactly what it always was.
KILL.resetBossKill();
KILL.startBossKill();
KILL.setBossKillFraming({ x: 7, y: -3 }, null, half);
KILL.updateBossKill(DT);
check('with no body to frame the shot points at the seal, as it always did',
  KILL.bossKillState.cam.x === 7 && KILL.bossKillState.cam.y === -3);
KILL.resetBossKill();

// ---------------------------------------------------------------------------
section('THE PRINT — the photograph coming out of the camera');
// ---------------------------------------------------------------------------
const PRINT = await import('../path/src/ui/snapshotPrint.js');
const printMeta = { name: 'Grimtide the Tidebreaker', level: 12, time: 754 };

PRINT.resetSnapshotPrints();
const el = PRINT.showSnapshotPrint('data:image/png;base64,STUBBEDPNG', printMeta);
check('a print appears', !!el && PRINT.snapshotPrintCount() === 1);
check('...carrying the picture that was just taken',
  String(el.querySelector('.sv-print-photo').src).startsWith('data:image/png'));
check('...with the boss written on the chin',
  el.querySelector('.sv-print-name').textContent === printMeta.name);
check('...and the run, as a clock rather than a float',
  el.querySelector('.sv-print-stat').textContent === 'LV 12 · 12:34',
  el.querySelector('.sv-print-stat').textContent);
check('...blank at first, so there is something to develop',
  el.classList.contains('sv-print-wet'));
check('...starting below the bottom of the screen', /\+ \d+px\)/.test(el.style.transform),
  el.style.transform);

// The flight, on the wall clock. Two rAFs to start it, then the timers.
await new Promise((r) => setTimeout(r, 40));
check('it ejects into the middle of the frame',
  /translate\(-50%, -50%\)/.test(el.style.transform), el.style.transform);
check('...and develops on the way', el.classList.contains('sv-print-dry'));

await new Promise((r) => setTimeout(r, P.ejectMs + Math.max(P.holdMs, P.writeOnMs) + 60));
const parkedTo = el.style.transform;
const dx = Number(parkedTo.match(/-50% \+ (-?\d+)px/)?.[1]);
const dy = Number(parkedTo.match(/-50% \+ (-?\d+)px/g)?.[1]?.match(/(-?\d+)/)?.[1]);
const scale = Number(parkedTo.match(/scale\(([\d.]+)\)/)?.[1]);
check('...then flies to the top-left corner', dx < 0 && dy < 0, parkedTo);
check('...shrinking on the way', scale > 0 && scale < 1, `scale ${scale}`);
check('...to the corner size the config asks for',
  Math.abs(scale * el.offsetWidth - P.cornerWidth) < 1 || el.offsetWidth === 0,
  `${(scale * (el.offsetWidth || 0)).toFixed(0)}px`);

// THE PILE. Each print lands beside the last rather than on top of it, or the
// corner would show one kill however many the run made.
const second2 = PRINT.showSnapshotPrint('data:image/png;base64,STUBBEDPNG', { ...printMeta, level: 24 });
await new Promise((r) => setTimeout(r, P.ejectMs + Math.max(P.holdMs, P.writeOnMs) + P.parkMs + 80));
check('the next kill lands beside the last, not on top of it',
  PRINT.snapshotPrintCount() === 2 && second2.style.transform !== el.style.transform);

// ...up to a point. A run that somehow went past the cap must not build a wall
// of paper across the top of the screen.
for (let i = 0; i < P.stackMax + 3; i++) {
  PRINT.showSnapshotPrint('data:image/png;base64,STUBBEDPNG', printMeta);
}
await new Promise((r) => setTimeout(r, P.ejectMs + Math.max(P.holdMs, P.writeOnMs) + 120));
check('the pile has a depth', PRINT.snapshotPrintCount() <= P.stackMax,
  `${PRINT.snapshotPrintCount()} of ${P.stackMax}`);

PRINT.resetSnapshotPrints();
check('a new run starts with an empty corner', PRINT.snapshotPrintCount() === 0);

// A restart between the pop and the park: the pending timer must not park a
// print that has already been thrown away, which would leave a permanent gap
// in the next run's pile.
PRINT.showSnapshotPrint('data:image/png;base64,STUBBEDPNG', printMeta);
PRINT.resetSnapshotPrints();
await new Promise((r) => setTimeout(r, P.ejectMs + Math.max(P.holdMs, P.writeOnMs) + 120));
check('a print in flight when the run restarts leaves nothing behind',
  PRINT.snapshotPrintCount() === 0, `${PRINT.snapshotPrintCount()} left`);

CONFIG.boss.kill.print.enabled = false;
check('switched off, no print comes out',
  PRINT.showSnapshotPrint('data:image/png', printMeta) === null);
CONFIG.boss.kill.print.enabled = true;

console.log(failures ? `\n${failures} FAILED` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
