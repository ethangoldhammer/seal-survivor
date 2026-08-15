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
const drawn = { texts: [], images: 0, fills: 0 };
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    canvas: this,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, clearRect() {}, save() {}, restore() {},
    fillRect() { drawn.fills++; },
    drawImage() { drawn.images++; },
    fillText(t) { drawn.texts.push(String(t)); },
    measureText: (t) => ({ width: String(t).length * 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
    set font(v) { this._font = v; }, get font() { return this._font; },
    set letterSpacing(v) { this._ls = v; }, get letterSpacing() { return this._ls; },
    set textAlign(v) { this._ta = v; }, get textAlign() { return this._ta; },
    set textBaseline(v) { this._tb = v; }, get textBaseline() { return this._tb; },
  };
};
let toDataURLCalls = 0;
let lastPngWidth = 0;
dom.window.HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
  toDataURLCalls++;
  lastPngWidth = this.width;
  return 'data:image/png;base64,STUBBEDPNG';
};
dom.window.HTMLCanvasElement.prototype.toBlob = function toBlob(cb) {
  cb(new dom.window.Blob(['png'], { type: 'image/png' }));
};

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
check('...drawing the game frame into it', drawn.images === 1, `${drawn.images} image(s)`);

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
SHOT.resetBossShot();
check('a new run starts with none', SHOT.bossShot() === null);
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
const realCreate = document.createElement.bind(document);
document.createElement = (tag) => {
  const e = realCreate(tag);
  if (tag === 'a') { const c = e.click.bind(e); e.click = () => { downloads++; c?.(); }; }
  return e;
};
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
check('the Save button does the same on its own', SHOT.saveBossShot() === 'saved');
check('...once', downloads === 1, `${downloads}`);
document.createElement = realCreate;

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
section('THE DEATH SCREEN — where the player is actually offered it');
// ---------------------------------------------------------------------------
// The last seam: a trophy that exists but is never shown is the same as no
// trophy at all, and an <img> left holding the previous run's picture is worse
// than either.
const UI = await import('../path/src/ui/ui.js');
UI.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });
const runState = { score: 45300, kills: 210, level: 12, time: 754 };

SHOT.resetBossShot();
UI.showGameOver(runState);
const trophy = document.getElementById('svTrophy');
check('a run with no boss kill shows no trophy', trophy.classList.contains('sv-hidden'));
check('...and holds no image to leak into the next one',
  !document.getElementById('svTrophyImg').getAttribute('src'));

SHOT.captureBossShot(canvas, meta);
UI.showGameOver(runState);
check('a run that beat one shows it', !trophy.classList.contains('sv-hidden'));
check('...with the picture in it',
  String(document.getElementById('svTrophyImg').src).startsWith('data:image/png'));
check('...and a share button to press', !!document.getElementById('svTrophyShare'));
check('...and a save button beside it', !!document.getElementById('svTrophySave'));

// And it does not survive into the next run.
SHOT.resetBossShot();
UI.showGameOver(runState);
check('the next run does not inherit it', trophy.classList.contains('sv-hidden'));
check('...with the stale src dropped, not merely hidden',
  !document.getElementById('svTrophyImg').getAttribute('src'));

console.log(failures ? `\n${failures} FAILED` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
