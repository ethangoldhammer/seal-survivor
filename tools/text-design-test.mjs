#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:text-design
//
// The Text panel (Y) and everything it drives, headless.
//
// FOUR THINGS, each of which fails silently in a browser:
//
//   THE CASCADE      The font picker was dead for months. ui/ui.js set
//                    `font-family` on `.sv-ui *`, and a rule that matches an
//                    element directly beats a value it would have inherited —
//                    so the family the tuner wrote onto `.sv-ui` reached the
//                    container and nothing inside it. The game rendered Inter
//                    whatever the config said, with no error anywhere. The
//                    check here is a real cascade, resolved by jsdom.
//
//   THE ROLE SHEET   Fifteen roles compiled into one stylesheet. A role that
//                    emits no rule is text that quietly keeps the fallback
//                    styling in ui.js and looks *almost* right.
//
//   TWO WRITERS      The chain banner's colour is written inline, per frame.
//                    Emit a `color` for it in the sheet as well and the sheet's
//                    is simply never seen — a control that looks live and is
//                    not, which is the failure textRoles.js's `inlineColor`
//                    flag exists to prevent.
//
//   THE MOTION       Appear and disappear are two windows over one life. The
//                    arithmetic has to hold at the ends (a popup must be born
//                    at its `in` values and die at its `out` values) and in the
//                    middle where the two windows overlap — which is where a
//                    sign error hides, because both ends still look right.
//
// Load order is the jsdom recipe: jsdom, then the vite loader, then the game
// modules. Run WITHOUT --import for that reason.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
// jsdom has no layout, so it implements no scrolling. The panel scrolls a
// group into view when you click its specimen line; unstubbed, that throws
// INSIDE the click handler, where the event dispatcher swallows it — the
// checks after it still pass and the failure is a stack trace in the middle of
// a green run. Stubbed here rather than guarded in the source: every browser
// has this method, and a `?.` in the panel would only hide the next one.
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

// BEFORE our own hooks below. registerHooks runs newest-first and the loader
// claims every `?raw`/`?url` import, so registering it after us would swallow
// the stubs. See the note in tools/vite-loader.mjs.
await import('./vite-loader.mjs');

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    if (spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});

globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { CONFIG, TUNER_SCHEMA, getPath } = await import('../path/src/config.js');
const { TEXT_ROLES } = await import('../path/src/textRoles.js');
const { FONTS } = await import('../path/src/fonts.js');
const { ease } = await import('../path/src/ease.js');
const { PREVIEW_SCREENS } = await import('../path/src/ui/ui.js');
const typography = await import('../path/src/ui/typography.js');
const ui = await import('../path/src/ui/ui.js');
const { chainCss, liveChainCss } = await import('../path/src/systems/chainColor.js');

ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });
typography.initTypography();

// ---------------------------------------------------------------------------
section('The config declares every field every row writes');
// The rule tools/tuner-row-test.mjs guards from the other end: a schema row
// pointing at a path config.js does not declare used to invent a value for it
// the moment the panel was built. Here the same rule is checked as coverage —
// every text row must name a field that already exists.
{
  const textGroups = TUNER_SCHEMA.filter((g) => g.panel === 'text');
  check('the panel has groups at all', textGroups.length > 0, `${textGroups.length} groups`);

  const missing = [];
  for (const g of textGroups) {
    for (const item of g.items) {
      if (item.type === 'readout') continue;
      if (getPath(CONFIG, item.path) === undefined) missing.push(item.path);
    }
  }
  check('every row points at a declared value', missing.length === 0, missing.join(', '));

  // ...and the other direction: a role with no group is a value with no way to
  // reach it, which is how a field ends up tunable only by editing JSON.
  const groupNames = new Set(textGroups.map((g) => g.group));
  const unreachable = TEXT_ROLES.filter((r) => !groupNames.has(r.label)).map((r) => r.key);
  check('every role has a group', unreachable.length === 0, unreachable.join(', '));
}

// ---------------------------------------------------------------------------
section('The cascade actually reaches the text');
// THE BUG THIS FILE WAS WRITTEN FOR. A <div class="sv-title"> inside .sv-ui has
// to end up wearing the family the config names — not the one ui.js's reset
// rule would have pinned it to.
// jsdom resolves the CASCADE but not var() — a computed font-family of
// `var(--sv-font)` means "the rule that won is the one reading the variable",
// which is precisely the question here. The variable's own value is checked
// separately, so between them the whole path is covered: config -> variable,
// and variable -> the element.
{
  CONFIG.typography.family = "'Courier New', monospace";
  typography.applyTypography();

  check('the family reaches the custom property',
    document.documentElement.style.getPropertyValue('--sv-font') === "'Courier New', monospace",
    document.documentElement.style.getPropertyValue('--sv-font'));

  const probe = document.createElement('div');
  probe.className = 'sv-title';
  document.querySelector('.sv-ui').appendChild(probe);
  const family = getComputedStyle(probe).fontFamily;
  // The FAILING VALUE here is the interesting one: `'Inter', system-ui,
  // sans-serif` means ui.js's reset rule won again and the picker is dead.
  check('a role inside .sv-ui takes its family from the variable',
    family === 'var(--sv-font)', `got ${family || '(nothing)'}`);

  // Unclassed text — a plain div with no role — has to follow too, or half the
  // interface would silently stay behind on the old font.
  const plain = document.createElement('div');
  document.querySelector('.sv-ui').appendChild(plain);
  check('...and so does text with no role of its own',
    getComputedStyle(plain).fontFamily === 'var(--sv-font)',
    `got ${getComputedStyle(plain).fontFamily || '(nothing)'}`);

  // A role can opt out of the global and name its own.
  CONFIG.textStyles.score.font = "'Bangers', system-ui, sans-serif";
  typography.applyTypography();
  const toast = document.createElement('div');
  toast.className = 'sv-toast';
  document.querySelector('.sv-ui').appendChild(toast);
  check('a role with its own font overrides the global',
    getComputedStyle(toast).fontFamily.includes('Bangers'),
    `got ${getComputedStyle(toast).fontFamily}`);
  CONFIG.textStyles.score.font = 'global';
  typography.applyTypography();
  check('...and setting it back to global follows the global again',
    getComputedStyle(toast).fontFamily === 'var(--sv-font)',
    `got ${getComputedStyle(toast).fontFamily}`);
}

// ---------------------------------------------------------------------------
section('The role sheet');
{
  const css = typography.buildRoleCss();
  const missing = TEXT_ROLES.filter((r) => !css.includes(`${r.selector} {`)).map((r) => r.key);
  check('every role emits a rule', missing.length === 0, missing.join(', '));

  // The combo popup wears BOTH classes, so its rule has to come after the score
  // popup's or the score's size and colour would win on the element they share.
  const iScore = css.indexOf('.sv-toast {');
  const iCombo = css.indexOf('.sv-toast-combo {');
  check('the combo rule follows the score rule', iScore >= 0 && iCombo > iScore,
    `score at ${iScore}, combo at ${iCombo}`);

  // The base scope has to come FIRST, because it is the same specificity as
  // every role rule — put it last and it would win over all fifteen of them.
  check('the base font rule comes before every role', css.indexOf('.sv-ui *') < iScore);

  // THE PHONE FACTOR, on the coaching voice and on nothing else. A first-run
  // tip shrinks on a small screen (--sv-tipScale, set per breakpoint in
  // ui/ui.js); every other role keeps the size the Text panel says at every
  // width. Both halves are asserted: the term arriving on the wrong roles
  // would quietly shrink the warnings and the score on the screen where they
  // matter most, and there is no width in this harness at which that shows up.
  //
  // Named off the role list rather than hardcoded, so a second `compact` role
  // is covered the day somebody adds one.
  {
    const compact = TEXT_ROLES.filter((r) => r.compact);
    const rule = (r) => css.split('\n').find((l) => l.startsWith(`${r.selector} {`)) ?? '';
    check('the coaching voice is the compact one', compact.some((r) => r.key === 'coach'),
      compact.map((r) => r.key).join(', ') || '(none)');
    check('...and every compact role carries the small-screen factor',
      compact.every((r) => rule(r).includes('var(--sv-tipScale, 1)')),
      compact.map((r) => rule(r)).join(' | '));
    const leaked = TEXT_ROLES.filter((r) => !r.compact && rule(r).includes('--sv-tipScale'));
    check('...and no other role does', leaked.length === 0, leaked.map((r) => r.key).join(', '));
  }

  // TWO WRITERS. The chain banner's colour is inline, per frame.
  const chainRule = css.split('\n').find((l) => l.startsWith('.sv-chain {'));
  check('the chain banner emits no colour of its own',
    !!chainRule && !/(^|;|\s)color:/.test(chainRule), chainRule ?? '(no rule)');
  check('...but every other role does emit one',
    css.split('\n').filter((l) => l.startsWith('.sv-title {') && l.includes('color:')).length === 1);
}

// ---------------------------------------------------------------------------
section('Ink, opacity and the shadow stack');
{
  CONFIG.typography.color = 0x112233;
  CONFIG.textStyles.title.useInk = true;
  CONFIG.textStyles.title.alpha = 0.5;
  CONFIG.textStyles.button.useInk = false;
  CONFIG.textStyles.button.color = 0xff0000;
  CONFIG.textStyles.button.alpha = 1;
  let css = typography.buildRoleCss();
  check('a role on the global ink takes it, with its own alpha',
    css.includes('color: rgba(17, 34, 51, 0.5)'), css.split('\n').find((l) => l.startsWith('.sv-title')));
  check('a role off the ink keeps its own colour',
    css.includes('color: rgb(255, 0, 0)'), css.split('\n').find((l) => l.startsWith('.sv-btn')));

  // The retro treatment used to REPLACE text-shadow, which deleted every
  // legibility shadow in the game the moment it was switched on. Composed now:
  // both have to be terms in the same list.
  CONFIG.typography.retro = true;
  CONFIG.typography.retroChromaShift = 1.5;
  CONFIG.typography.retroGlow = 0;
  CONFIG.textStyles.score.shadow = 8;
  css = typography.buildRoleCss();
  const toastRule = css.split('\n').find((l) => l.startsWith('.sv-toast {'));
  check('retro chroma and the role shadow are in one stack',
    toastRule.includes('-1.5px 0 rgba(255, 60, 60') && toastRule.includes('rgba(0, 0, 0, 0.75)'),
    toastRule);

  CONFIG.typography.retro = false;
  CONFIG.textStyles.score.shadow = 0;
  CONFIG.textStyles.score.glow = 0;
  css = typography.buildRoleCss();
  check('with both off the shadow is explicitly none',
    css.split('\n').find((l) => l.startsWith('.sv-toast {')).includes('text-shadow: none'),
    'a stale shadow would survive the rebuild otherwise');
}

// ---------------------------------------------------------------------------
section('The font shelf');
{
  const dupes = FONTS.map((f) => f.stack).filter((s, i, a) => a.indexOf(s) !== i);
  check('no two families share a stack', dupes.length === 0, dupes.join(' | '));
  // Every stack must end in a generic family, because a Google font that fails
  // to load falls through it — and a stack with nothing behind it falls through
  // to the browser default, which on a pixel-font choice looks like a bug.
  const noFallback = FONTS.filter((f) => !/(sans-serif|serif|monospace)\s*$/.test(f.stack));
  check('every stack ends in a generic family', noFallback.length === 0,
    noFallback.map((f) => f.label).join(', '));
  // The five the picker shipped with are the values already written into
  // imported-tuning.json. Losing one would leave saved tuning pointing at a
  // family the picker can no longer show.
  for (const legacy of ["'Inter', system-ui, sans-serif", "'Courier New', monospace",
    "Georgia, 'Times New Roman', serif", "'Trebuchet MS', sans-serif", 'Impact, sans-serif']) {
    check(`the shelf still carries ${legacy.split(',')[0]}`,
      FONTS.some((f) => f.stack === legacy));
  }
}

// ---------------------------------------------------------------------------
section('Popup motion: the two windows');
// Driven through the real updateToasts, by spawning a popup and stepping the
// clock — the same path a kill takes, minus the camera.
{
  const m = CONFIG.textMotion.score;
  m.life = 1;
  m.rise = 0; m.riseVary = 0; m.gravity = 0; m.scatter = 0;
  m.in = { time: 0.2, ease: 'linear', scale: 2, fade: 0, lift: 20 };
  m.out = { time: 0.4, ease: 'linear', scale: 0.5, fade: 0, lift: -10 };
  typography.applyTypography();

  ui.clearToasts();
  ui.previewToasts();
  const layer = document.getElementById('svToastLayer');
  const node = layer.querySelector('.sv-toast:not(.sv-toast-combo)');
  check('a popup reaches the DOM', !!node);

  const read = () => ({
    scale: Number(/scale\(([-\d.]+)\)/.exec(node.style.transform)?.[1]),
    alpha: Number(node.style.opacity),
    top: Number.parseFloat(node.style.top),
  });

  // One frame in: born at the arrival's values, near enough that the frame
  // itself is the only difference.
  ui.updateToasts(0.001);
  let s = read();
  check('it is born at the arrival size', Math.abs(s.scale - 2) < 0.05, `scale ${s.scale}`);
  check('...and at the arrival opacity', s.alpha < 0.02, `alpha ${s.alpha}`);
  const bornTop = s.top;

  // Halfway through the arrival, on a linear curve: exactly half way there.
  ui.updateToasts(0.099);
  s = read();
  check('halfway through the arrival it is half way there',
    Math.abs(s.scale - 1.5) < 0.06 && Math.abs(s.alpha - 0.5) < 0.06,
    `scale ${s.scale}, alpha ${s.alpha}`);
  check('...and its lift has come half way back',
    Math.abs((s.top - (bornTop - 20)) - 10) < 1.5, `top ${s.top} from ${bornTop}`);

  // Between the two windows: resting. This is the check that catches a
  // departure window that opened early or never closed.
  ui.updateToasts(0.3); // age 0.4 — arrival done, departure starts at 0.6
  s = read();
  check('between the windows it rests at 1', Math.abs(s.scale - 1) < 0.01 && Math.abs(s.alpha - 1) < 0.01,
    `scale ${s.scale}, alpha ${s.alpha}`);

  // Halfway through the departure.
  ui.updateToasts(0.4); // age 0.8, i.e. half of the 0.4s departure
  s = read();
  check('halfway out it is half way to the leave values',
    Math.abs(s.scale - 0.75) < 0.06 && Math.abs(s.alpha - 0.5) < 0.06,
    `scale ${s.scale}, alpha ${s.alpha}`);

  // ...and it is gone at `life`, rather than lingering as a 0-opacity node.
  ui.updateToasts(0.25);
  check('it is removed at the end of its life', !node.isConnected);

  // Shortening the life retires what is already in the air — the control says
  // "time on screen", and a popup older than that has had its time.
  ui.clearToasts();
  ui.previewToasts();
  ui.updateToasts(0.5);
  const alive = layer.querySelectorAll('.sv-toast, .sv-chain').length;
  m.life = 0.2;
  CONFIG.textMotion.combo.life = 0.2;
  CONFIG.textMotion.chain.life = 0.2;
  ui.updateToasts(0.01);
  check('shortening the life retires what is already up',
    layer.querySelectorAll('.sv-toast, .sv-chain').length < alive,
    `${alive} -> ${layer.querySelectorAll('.sv-toast, .sv-chain').length}`);
  ui.clearToasts();
}

// ---------------------------------------------------------------------------
section('Popup motion: the curves are the shared ones');
{
  // A named curve that isn't in ease.js falls back to linear WITH A WARNING —
  // it must never become NaN, which would freeze the popup mid-air with
  // nothing in the console to say why.
  const before = warnings.length;
  check('an unknown curve is linear, not NaN', ease('nonsense', 0.5) === 0.5);
  check('...and it says so once', warnings.length > before);

  // Every curve the panel offers has to be one the loop can resolve. The rows
  // are built from EASINGS, so this is really a check that nothing hardcoded a
  // name alongside it.
  const rows = TUNER_SCHEMA.filter((g) => g.panel === 'text')
    .flatMap((g) => g.items)
    .filter((i) => i.path?.endsWith('.ease'));
  // DERIVED, not a number. Every role that flies (score, combo, chain, and the
  // two callout bands) gets an APPEAR curve and a LEAVE curve, so the count is
  // twice the roles that carry a `motion` — a hardcoded 6 here went stale the
  // first time a role was added, which is the whole failure mode this file
  // exists to catch in the panel.
  const flying = TEXT_ROLES.filter((r) => r.motion);
  check('the panel offers an APPEAR and a LEAVE curve for every popup role',
    rows.length === flying.length * 2, `${rows.length} rows for ${flying.length} roles`);
  const bad = rows.flatMap((r) => r.options).filter((name) => ease(name, 0.25) === 0.25 && name !== 'linear');
  check('every offered curve resolves', bad.length === 0, bad.join(', '));

  // And every default in the config is one of them.
  for (const kind of [...new Set(flying.map((r) => r.motion))]) {
    const m = CONFIG.textMotion[kind];
    for (const phase of ['in', 'out']) {
      check(`${kind}.${phase} names a real curve`,
        rows[0].options.includes(m[phase].ease), m[phase].ease);
    }
  }
}

// ---------------------------------------------------------------------------
section('The chain wheel, and the banner that left it');
{
  // THE WHEEL IS SHARED BY THE TWO SURFACES ON THE SEAL'S OWN METER: the
  // "STRIKE NOW!" prompt riding the boost ring and the ring's combo arc. Both
  // ask systems/chainColor.js rather than mixing a ramp of their own, which is
  // what stops them agreeing at link one and drifting apart by link six.
  //
  // THE BANNER USED TO BE THE THIRD AND IS NOT ANY MORE, and this section is
  // where that is pinned. The wheel holds saturation and lightness constant,
  // which keeps every link equally legible against a flat background — exactly
  // right for a thin band on a lit instrument, and wrong for TYPE over a sea
  // that runs a full day/night cycle. A couple of depths a lap were unreadable
  // and which ones depended on the time of day.
  CONFIG.strike.chainColor.hue = 0;
  CONFIG.strike.chainColor.huePerLink = 0.1;
  CONFIG.strike.chainColor.sat = 1;
  CONFIG.strike.chainColor.light = 0.5;
  CONFIG.textMotion.chain.life = 2;

  // Hue 0.6 at these four numbers is pure blue-violet, rgb(0, 102, 255) — a
  // value that can only come out right if all four are being read. It is what
  // link six USED to paint the banner, and it is the check that the banner has
  // stopped asking: a wheel this saturated is precisely the colour that
  // disappeared into deep water.
  ui.clearToasts();
  ui.previewToasts();
  const banner = document.getElementById('svToastLayer').querySelector('.sv-chain');
  check('the banner is on screen', !!banner);
  check('the banner does NOT take its link\'s place on the wheel',
    banner.style.color.replace(/\s/g, '') !== 'rgb(0,102,255)', `got ${banner.style.color}`);
  // ...it is the one colour CONFIG names, at any depth. Compared through the
  // DOM: an inline `color` is normalised to rgb(), so a hex string comparison
  // can only ever fail.
  const norm = (v) => { const n = document.createElement('i'); n.style.color = v; return n.style.color; };
  const want = `#${((CONFIG.strike.foodChain.color >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  check('...it wears CONFIG.strike.foodChain.color instead',
    banner.style.color === norm(want), `${banner.style.color} vs ${norm(want)}`);

  // THE WHEEL COMES ROUND rather than running out, which is the whole reason
  // it replaced the two-stop gold-to-orange ramp: that one was fully spent by
  // link eight, the depth at which a chain most deserves to look like
  // something. Ten links at 0.1 apiece is a full revolution, so a very deep
  // chain is back where it started instead of stuck on the hot end. Still the
  // arc's and the prompt's rule, which is why it is still checked here.
  check('ten links is one full turn, back to the start',
    chainCss(10) === chainCss(0), `${chainCss(10)} vs ${chainCss(0)}`);
  check('...and a chain that has lapsed reads as no chain at all',
    liveChainCss() === chainCss(0), liveChainCss());

  // Deeper into the chain is further along the ramp. Re-firing re-uses the live
  // node rather than stacking a second banner — the extension path.
  const nodesBefore = document.getElementById('svToastLayer').querySelectorAll('.sv-chain').length;
  ui.previewToasts();
  check('an extension re-uses the one banner',
    document.getElementById('svToastLayer').querySelectorAll('.sv-chain').length === nodesBefore,
    'a second banner would stack on the first');
  ui.clearToasts();
}

// ---------------------------------------------------------------------------
section('The panel');
// Built last, because it reads the schema and the roles that everything above
// has been poking at — and because init binds a key handler to the window.
{
  const changed = [];
  const { initTextPanel, textPanelEl, setTextPanelOpen } = await import('../path/src/ui/textPanel.js');
  // Wired the way main.js wires it — the panel reports a path, and the routing
  // in handleTunerChange turns it into a restyle. Testing the panel with an
  // empty handler would pass while the game showed nothing, which is exactly
  // the failure this section is here to catch.
  initTextPanel((path) => {
    changed.push(path);
    if (path === '*' || path.startsWith('typography') || path.startsWith('textStyles')
        || path.startsWith('textMotion')) typography.applyTypography();
  });
  const panel = textPanelEl();
  check('the panel is built', !!panel);

  // The specimen: one line per role, each wearing the role's own class so it is
  // styled by the live rule rather than by a copy of it.
  const lines = panel.querySelectorAll('.sv-txp-line');
  check('one specimen line per role', lines.length === TEXT_ROLES.length,
    `${lines.length} of ${TEXT_ROLES.length}`);
  const titleSample = panel.querySelector('.sv-txp-spec .sv-title');
  check('a specimen wears the real class', !!titleSample);

  // Clicking a line opens that role's controls — and the SECTION above it,
  // since a group opened inside a collapsed section is open and invisible.
  const chainLine = panel.querySelector('[data-role="chain"]');
  chainLine.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const chainGroup = [...panel.querySelectorAll('.sv-t-groupwrap')]
    .find((w) => w.dataset.openKey === 'Chain banner');
  check('clicking a specimen opens its group', chainGroup?.classList.contains('sv-t-open'));
  check('...and the section it lives in', chainGroup?.closest('.sv-t-section')?.classList.contains('sv-t-open'));

  // The font picker is a row of pills that carry a LABEL separate from the
  // value they store, and each is drawn in the family it selects. Without the
  // label the pill reads as a CSS font stack; without the font it is a list of
  // names you have to audition one at a time.
  const fontChips = [...panel.querySelectorAll('.sv-t-chip')]
    .filter((c) => c.dataset.value?.includes('Bangers'));
  check('the font picker shows a name, not a stack',
    fontChips.length > 0 && fontChips[0].textContent === 'Bangers',
    fontChips[0]?.textContent);
  check('...and draws the pill in that font',
    fontChips[0]?.style.fontFamily.includes('Bangers'), fontChips[0]?.style.fontFamily);

  // DRAGGING A ROW HAS TO CHANGE THE TEXT, ON THE SAME EVENT. Not on mouse-up,
  // not on reopening the panel — on the `input` event, which is what a drag
  // fires continuously. Checked on the real element in .sv-ui as well as on the
  // specimen, because those are two different questions: whether the sheet was
  // rebuilt, and whether the specimen is really wearing it.
  {
    const gameTitle = document.createElement('div');
    gameTitle.className = 'sv-title';
    document.querySelector('.sv-ui').appendChild(gameTitle);
    const specTitle = panel.querySelector('.sv-txp-spec .sv-title');
    const sizeOf = (node) => getComputedStyle(node).fontSize;
    const before = sizeOf(gameTitle);

    const titleGroup = [...panel.querySelectorAll('.sv-t-groupwrap')]
      .find((w) => w.dataset.openKey === 'Menu title');
    const slider = titleGroup.querySelector('input[type=range]'); // size is the first slider
    slider.value = '64';
    slider.dispatchEvent(new dom.window.Event('input'));

    check('a drag writes the value', CONFIG.textStyles.title.size === 64, `${CONFIG.textStyles.title.size}`);
    check('...and restyles the game text on the same event',
      sizeOf(gameTitle) !== before && sizeOf(gameTitle).includes('64px'),
      `${before} -> ${sizeOf(gameTitle)}`);
    check('...and the specimen with it',
      sizeOf(specTitle).includes('64px'), sizeOf(specTitle));
    // The label beside the specimen is text this file writes, not CSS — it has
    // its own way of going stale.
    check('...and the specimen label says the new size',
      panel.querySelector('[data-role="title"]').firstChild.textContent.includes('64px'),
      panel.querySelector('[data-role="title"]').firstChild.textContent);
  }

  // A MOTION row cannot show itself on a line of text sitting still, so the
  // popup specimens replay their own curves. Without this the one kind of row
  // that has nothing static to show reads as the panel being dead.
  {
    setTextPanelOpen(true);
    const sample = panel.querySelector('[data-role="score"]').lastChild;
    // One frame of the replay loop, driven by the rAF shim at the top.
    await new Promise((r) => setTimeout(r, 40));
    check('the score popup specimen is being posed',
      /scale\(/.test(sample.style.transform), sample.style.transform || '(nothing)');

    // ...and it stops when the panel is put away.
    setTextPanelOpen(false);
    await new Promise((r) => setTimeout(r, 40));
    check('the replay stops with the panel closed', sample.style.transform === '',
      sample.style.transform);
    check('...and leaves the specimen readable rather than mid-fade',
      sample.style.opacity === '', sample.style.opacity);
  }

  // THE SCREEN PICKER. Type is judged in place, so the panel can put any real
  // surface behind itself — including none, which is the only way off the start
  // menu without reloading.
  {
    const chip = (name) => [...panel.querySelectorAll('.sv-txp-screens .sv-t-chip')]
      .find((c) => c.textContent === name);
    const shown = (id) => !document.getElementById(id).classList.contains('sv-hidden');
    check('the picker offers every screen',
      panel.querySelectorAll('.sv-txp-screens .sv-t-chip').length === ui.previewScreenNames().length
      && ui.previewScreenNames().length >= PREVIEW_SCREENS.length,
      ui.previewScreenNames().join(', '));

    chip('HUD').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    check('HUD puts the HUD up', shown('svHud'));
    check('...and nothing else with it', !shown('svGameOverMenu') && !shown('svLevelUpMenu'));

    chip('clear').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    check('clear takes the HUD down', !shown('svHud'),
      'this is the only way off a screen without reloading');
    check('...and leaves nothing else up', !shown('svGameOverMenu') && !shown('svLevelUpMenu'));

    // THE SCORE CARD IS ARMED BY DEFAULT. showGameOver exists to take a real
    // run and offer it to the global board; a fabricated 184k with a live name
    // box under it is one click from being up there forever.
    chip('score card').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    check('the score card comes up', shown('svGameOverMenu'));
    check('...with the invented run made unpostable', !shown('svNameRow'),
      'the name row is still live — an invented run can be posted to the real board');

    chip('clear').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  }

  // A ROLE WHOSE SELECTOR HAS TWO PARTS. The quip is `.sv-ldg-head .sv-title`,
  // and the old specimen turned that into a class list — "sv-ldg-head" and
  // ".sv-title", dot included — so its line was styled by neither rule and
  // rendered in the panel's own Inter for as long as the role existed. The
  // specimen has to build the ancestor the selector needs, and then flatten
  // whatever layout that ancestor brings (the after-match prompt is a centred
  // flex column with a scrim in ::before).
  {
    const sampleOf = (key) => panel.querySelector(`[data-role="${key}"] .sv-txp-sample`);
    const quip = sampleOf('quip');
    const quipSize = TEXT_ROLES.find((r) => r.key === 'quip').style.size;
    check('a descendant-selector specimen is styled by its own rule',
      getComputedStyle(quip).fontSize.includes(`${quipSize}px`), getComputedStyle(quip).fontSize);
    check('...inside the ancestor its selector needs',
      quip.parentElement.classList.contains('sv-ldg-head') && quip.parentElement.classList.contains('sv-txp-wrap'),
      quip.parentElement.className);
    // The same claim the after-match button used to carry, on the pair that is
    // still in the markup: `vsReelTag` is `.sv-versus-reel .sv-versus-replay-tag`
    // and `vsReplayTag` is the bare `.sv-versus-replay-tag` under it, so a
    // specimen that took the one-deep rule would read 18px instead.
    const reelTag = sampleOf('vsReelTag');
    check('the reel tag wears its two-deep rule, not the plain replay-tag one',
      getComputedStyle(reelTag).fontSize.includes('1.6vmin'), getComputedStyle(reelTag).fontSize);
    const go = sampleOf('vsGo');
    check('a two-class selector is one element with both classes',
      go.classList.contains('sv-versus-count') && go.classList.contains('sv-versus-go'), go.className);

    // BLACK TYPE ON GLASS. The goal card's roles are #05070a on a frosted pane;
    // on the strip's near-black they are invisible, so the specimen draws the
    // pane — the real .sv-glass from versus.js, in P1's colour.
    const plate = panel.querySelector('[data-role="vsCardName"] .sv-txp-plate');
    check('a glass role\'s specimen sits on a pane', plate?.classList.contains('sv-glass'));
    check('...tinted the team colour', /rgba\(\d+,\d+,\d+,0\.26\)/.test(plate?.style.getPropertyValue('--sv-team-wash') ?? ''),
      plate?.style.getPropertyValue('--sv-team-wash'));

    // THE WORDS ARE THE TABLE'S. A `sampleFrom` role shows its uiText row, and
    // `{name}` is the longest name the roster can cast — the worst case, which
    // is the one that decides the type.
    const { UI_TEXT } = await import('../path/src/uiTextTable.js');
    // vsCardLine is the exemplar for both halves now: it has a sampleFrom AND a
    // {name} to fill. It took over from vsCardWin, which was the winner line on
    // this card until the result moved onto the stats page — an artboard, whose
    // type has no DOM node for a role to measure. See textRoles.js.
    const line = sampleOf('vsCardLine').textContent;
    check('a sampleFrom specimen shows its uiText row', line.startsWith(UI_TEXT.versusAssist.split('{')[0]), line);
    check('...with {name} filled', !line.includes('{name}') && line.length > UI_TEXT.versusAssist.length, line);
    check('...by a name at the field\'s limit', sampleOf('vsCardName').textContent.length >= 12,
      sampleOf('vsCardName').textContent);
    check('the readout says which unit a role is in',
      panel.querySelector('[data-role="vsCount"]').firstChild.textContent.endsWith('vmin'),
      panel.querySelector('[data-role="vsCount"]').firstChild.textContent);
  }

  // A ROLE SIZED TO THE SCREEN. The countdown and the goal card were authored
  // in vmin and stay in it; the prompt's buttons carry a px floor so they
  // stay tap targets on a phone in landscape.
  {
    const css = typography.buildRoleCss();
    const rule = (sel) => css.split('\n').find((l) => l.startsWith(`${sel} {`)) ?? '';
    check('a vmin role emits vmin', /font-size: calc\(26vmin \* var\(--sv-scale\)\)/.test(rule('.sv-versus-count')),
      rule('.sv-versus-count').slice(0, 120));
    check('...and a floored one is max()ed with its px floor',
      /font-size: max\(13px, calc\(1\.6vmin \* var\(--sv-scale\)\)\)/.test(rule('.sv-versus-reel .sv-versus-replay-tag')),
      rule('.sv-versus-reel .sv-versus-replay-tag').slice(0, 140));
    const vminRows = TUNER_SCHEMA.filter((g) => g.panel === 'text')
      .flatMap((g) => g.items).filter((it) => /^textStyles\.vs(Count|Go|Card\w+|Over\w+|ReelTag)\.size$/.test(it.path));
    // SIX, not nine. Three of this group's roles have left the DOM for the
    // stats page — a Rive artboard, whose type is sized by the Theme view
    // model rather than by a tuner row: vsCardWin was the goal card's winner
    // line, and vsOverTitle/vsOverButton were the play-again prompt that got
    // folded into the same page. Their COPY did not move (ui/statsCopy.js
    // still reads all three rows off uiText.csv); only the selectors did.
    // See textRoles.js.
    check('...and its slider is a vmin slider, not a px one',
      vminRows.length === 6 && vminRows.every((it) => it.max <= 40 && it.label.includes('vmin')),
      `${vminRows.length} rows: ${vminRows.map((it) => it.max).join(',')}`);
    check('...that names the floor where there is one',
      vminRows.find((it) => it.path === 'textStyles.vsReelTag.size')?.label.includes('13px'));
  }

  // A SHEET THAT ARRIVES AFTER THE ROLE SHEET. The match HUD and the team
  // select build their <style> on first use — after boot, after the role sheet
  // — and a rule there of the same specificity would beat the role's for the
  // same selector. The panel would write a size, save it, and the match would
  // keep drawing its own. installStyleBelowRoles files a late sheet UNDER the
  // role sheet, so order keeps doing the job it does for ui.js's rules.
  {
    typography.installStyleBelowRoles('svLateTest', '.sv-versus-count { font-size: 999px; }');
    const late = document.getElementById('svLateTest');
    const roles = document.getElementById('svTypographyRoles');
    // DOM ORDER ONLY, not a computed style. A browser cascades stylesheets in
    // document order, which is the whole mechanism; jsdom cascades them in
    // INSERTION order (document.styleSheets is appended to as elements
    // connect), so in here the late sheet wins no matter where it was filed
    // and a computed check would fail against correct code. Proved in a
    // browser instead — see the note on ensureVersusStyle in versus.js.
    check('a late sheet is filed under the role sheet',
      late && roles && !!(late.compareDocumentPosition(roles) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING));
    typography.installStyleBelowRoles('svLateTest', '.sv-versus-count { font-size: 1px; }');
    check('...and installing it twice keeps the first', document.querySelectorAll('#svLateTest').length === 1
      && late.textContent.includes('999px'));
    late.remove();
    // The two sheets the mode builds late go through it — a plain appendChild
    // in either is the bug coming back.
    const { readFileSync: readSrc } = await import('node:fs');
    for (const file of ['../path/src/systems/versus.js', '../path/src/ui/teamSelect.js']) {
      const text = readSrc(new URL(file, import.meta.url), 'utf8');
      check(`${file.split('/').pop()} files its sheet with installStyleBelowRoles`,
        text.includes('installStyleBelowRoles(') && !/document\.head\.appendChild\(style\)/.test(text));
    }
  }

  // EVERY BLUBBERBALL ROLE NAMES A CLASS THE MODE ACTUALLY WRITES. A role is a
  // selector plus a default, and a selector nobody's markup wears is a group of
  // sliders that move nothing — the one thing a tuning panel must never carry.
  {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../path/src/systems/versus.js', import.meta.url), 'utf8')
      + readFileSync(new URL('../path/src/ui/teamSelect.js', import.meta.url), 'utf8');
    const modeRoles = TEXT_ROLES.filter((r) => r.section === 'Blubberball' || r.section === 'Team select');
    check('the match and its team select have roles', modeRoles.length >= 20, `${modeRoles.length}`);
    for (const role of modeRoles) {
      const classes = role.selector.split(/[\s.]+/).filter(Boolean);
      const missing = classes.filter((c) => !src.includes(c));
      check(`${role.key} names classes the mode writes`, missing.length === 0, missing.join(', '));
    }
    // No DIMMING `opacity` left on a roled selector in either sheet — the
    // role's alpha is in its colour, and the two would multiply. `opacity: 0`
    // is allowed: that is the countdown's birth state, which its keyframes
    // animate to 1, not a dimming.
    for (const role of modeRoles) {
      const re = new RegExp(`\\n${role.selector.replace(/[.]/g, '\\.')} \\{[^}]*opacity: (?!0[;\\s])`);
      check(`...and ${role.key}'s fallback rule carries no opacity`, !re.test(src));
    }
  }

  // SCREENS FROM OTHER MODULES. ui.js cannot import the match HUD or the team
  // select (both import from it), so main.js registers them; every registered
  // screen's hide runs on every switch, so nothing survives the next chip.
  {
    const log = [];
    ui.registerPreviewScreen('zz test screen', { show: () => log.push('show'), hide: () => log.push('hide') });
    check('a registered screen is offered', ui.previewScreenNames().includes('zz test screen'));
    ui.previewScreen('zz test screen');
    check('...and put up when picked', log.at(-1) === 'show', log.join(','));
    ui.previewScreen('HUD');
    check('...and taken down by the next pick', log.at(-1) === 'hide', log.join(','));
    ui.previewScreen('clear');
  }

  // A HOT RELOAD MUST NOT KILL THE SYSTEM SILENTLY.
  //
  // The dev server re-executes a module on every save. When this file held its
  // <style> in a module `let`, the fresh instance came up holding null while the
  // old sheet sat in the head with pre-edit CSS — and applyTypography's guard
  // turned that into a no-op. Every row in the panel then wrote CONFIG, saved to
  // disk, and changed nothing on screen, with nothing logged to say why.
  //
  // Simulated the way HMR actually leaves it: the elements stay, a second module
  // instance is imported, and only the new instance is called.
  {
    const before = document.querySelectorAll('#svTypographyRoles').length;
    const reloaded = await import(`../path/src/ui/typography.js?hmr=${Date.now()}`);
    CONFIG.textStyles.title.size = 77;
    reloaded.applyTypography();

    const sheet = document.getElementById('svTypographyRoles');
    check('a re-executed module writes the sheet that is already there',
      sheet.textContent.includes('77px'), 'the fresh instance wrote nothing');
    check('...and does not leave a second one behind',
      document.querySelectorAll('#svTypographyRoles').length === before,
      `${document.querySelectorAll('#svTypographyRoles').length} role sheets`);
    // A DIRECT CHILD, not the first `.sv-title` in the tree. The first one in
    // document order is the score card's, inside .sv-ldg-head, and that one is
    // the QUIP role's by design (its selector is two classes deep so it beats
    // this rule) — measuring it reads 22px and blames the sheet for a size
    // that is correct.
    const plainTitle = document.querySelector('.sv-ui > .sv-title');
    check('...and the element really computes it',
      getComputedStyle(plainTitle).fontSize.includes('77px'),
      getComputedStyle(plainTitle).fontSize);

    // initTypography is idempotent too — the other half of the same fix.
    reloaded.initTypography();
    check('re-initialising adds no duplicate sheets or overlays',
      document.querySelectorAll('#svTypographyStatic').length === 1
      && document.querySelectorAll('#svRetroOverlay').length === 1);

    CONFIG.textStyles.title.size = 30;
    typography.applyTypography();
  }

  // Y toggles. Dispatched on document.body rather than on an input, because
  // isTypingTarget treats a focused control as typing — see the memory on
  // isTextEntry, and pause-menu-test.
  const open = () => !panel.classList.contains('sv-hidden');
  setTextPanelOpen(false);
  document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'y', bubbles: true }));
  check('Y opens the panel', open());
  document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Y', bubbles: true }));
  check('...and closes it again', !open());

  // Reset restores the roles and NOTHING ELSE. Everything above this section
  // has been rewriting textStyles, so there is plenty for it to put back.
  CONFIG.textStyles.title.size = 99;
  CONFIG.arena.width = 12345;
  const resetBtn = [...panel.querySelectorAll('.sv-txp-btn')].find((b) => b.textContent === 'Reset text');
  resetBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  check('Reset text restores a role',
    CONFIG.textStyles.title.size === TEXT_ROLES.find((r) => r.key === 'title').style.size,
    `${CONFIG.textStyles.title.size}`);
  check('...and leaves the rest of the config alone', CONFIG.arena.width === 12345);
  check('...and reports the change', changed.includes('textStyles'));
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
