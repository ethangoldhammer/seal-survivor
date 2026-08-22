import { CONFIG } from '../config.js';
import { TEXT_ROLES, CASE_CSS, FONT_GLOBAL } from '../textRoles.js';
import { fontForStack } from '../fonts.js';

// THE GAME'S STYLESHEET FOR TEXT, compiled from CONFIG rather than written out.
//
// Two stylesheets, and the split is the point:
//
//   STATIC   the scanline/chroma overlay and the layout-ish rules that never
//            depend on a tuned value. Injected once.
//   ROLES    one rule per entry in textRoles.js, rebuilt from CONFIG.textStyles
//            every time anything in the Text panel (Y) moves.
//
// WHY COMPILE INSTEAD OF DRIVING CSS VARIABLES. Fifteen roles × ten fields is a
// hundred and fifty custom properties, and half of them (the shadow stack, the
// case, whether a role takes the global family) are not single values a var can
// hold — they are decisions about which declarations exist at all. Rebuilding
// one small <style> is a couple of hundred bytes of text on a slider drag, and
// every rule in it is legible in devtools as the rule it actually is.
//
// The UI is DOM, not WebGL, so it cannot literally be sampled by the post
// shader that treats the gameplay. The retro block below is the stand-in: a
// chroma split, a bloom and a scanline overlay tuned to match that shader, so
// text opts into the same treatment rather than sitting on top of it looking
// conspicuously modern.
//
// That one is GLOBAL and it is a screen the game is watched on. A role can also
// take the stripe on ITSELF — `scan` in textRoles.js, compiled into a mask in
// roleCss below — which is a different claim: not "this picture is on a tube"
// but "these words are lit through a grille". The main menu's buttons are the
// only role that does.

// Selectors that get the global family and the global ink, so text with no role
// of its own (the name field, a leaderboard cell, the pause menu's rows) still
// follows the panel instead of staying on whatever ui.js happened to say.
//
// `.sv-ui *` and not just `.sv-ui`: ui/ui.js sets `font-family` on the
// descendant selector, and an inherited value loses to any rule that matches
// the element directly. That single `*` is why the font picker moved nothing
// for the first several months it existed — the game rendered Inter no matter
// what the config said, because every element under .sv-ui was being told to.
//
// `.sv-txp-spec` is the Text panel's own specimen strip: it lives outside
// .sv-ui, and the whole point of it is to show what these rules do.
const BASE_SCOPE = '.sv-ui, .sv-ui *, .sv-txp-spec, .sv-txp-spec *';

const STATIC_CSS = `
  /* Scale every unclassed UI font size from one root variable. */
  .sv-ui { font-size: calc(1rem * var(--sv-scale)); }

  .sv-retro-overlay {
    position: fixed; inset: 0; pointer-events: none; z-index: 25;
    background: repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,var(--sv-scan)) 0px,
      rgba(0,0,0,var(--sv-scan)) 1px,
      transparent 1px,
      transparent 3px
    );
    mix-blend-mode: multiply;
    animation: sv-flicker 0.15s steps(2) infinite;
  }
  @keyframes sv-flicker {
    0%   { opacity: calc(1 - var(--sv-flicker)); }
    100% { opacity: 1; }
  }
`;

// THE ELEMENTS ARE FOUND BY ID, NEVER HELD IN A MODULE VARIABLE.
//
// They used to be three `let`s assigned once in initTypography, and on the dev
// server that is a silent way to lose the whole system. A hot module replace
// re-executes this file: the new instance comes up with its handles at null
// while the OLD <style> is still sitting in the head holding the CSS from
// before the edit. applyTypography() then ran `if (roleStyle)`, found nothing,
// and returned — so every row in the Text panel wrote CONFIG, saved to disk,
// and changed nothing on screen, with no error anywhere to say why. The same
// re-execution also appended a second static sheet and a second scanline
// overlay each time.
//
// Looked up by id, the DOM is the only state there is. Init is idempotent,
// applyTypography() works even if it somehow runs first, and a replaced module
// re-adopts the elements the old one made instead of orphaning them.
function ensureSheet(id, staticCss = '') {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    if (staticCss) el.textContent = staticCss;
    document.head.appendChild(el);
  }
  return el;
}

export function initTypography() {
  ensureSheet('svTypographyStatic', STATIC_CSS);

  // The role sheet is appended AFTER the static one and after ui/ui.js's — last
  // in the document, so a role rule beats the class rule of the same weight
  // that ui.js wrote. Every panel injected later styles itself under its own
  // class names, so nothing downstream is competing for these selectors.
  ensureSheet('svTypographyRoles').dataset.svText = 'roles';

  if (!document.getElementById('svRetroOverlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'svRetroOverlay';
    overlay.className = 'sv-retro-overlay';
    document.body.appendChild(overlay);
  }

  applyTypography();
}

// --- fonts -----------------------------------------------------------------
// A family off the shelf is fetched the first time something asks for it, not
// at boot: nineteen families is a lot of network for a shelf you pick one thing
// off, and the ones with no `google` entry are already on the machine.
const loadedFonts = new Set();

export function ensureFontLoaded(stack) {
  if (!stack || stack === FONT_GLOBAL || loadedFonts.has(stack)) return;
  loadedFonts.add(stack);
  const font = fontForStack(stack);
  if (!font?.google) return; // a system stack, or something hand-typed
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
  // A font that can't be fetched (offline, blocked) falls back through the rest
  // of its own stack, which is why every entry in fonts.js ends in a real one.
  link.addEventListener('error', () => {
    console.warn(`[typography] couldn't load ${font.label} — falling back through its stack`);
  });
  document.head.appendChild(link);
}

// --- colour ----------------------------------------------------------------
function rgba(hex, alpha) {
  const n = (hex ?? 0) >>> 0;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexCss(hex) {
  return `#${((hex ?? 0) >>> 0).toString(16).padStart(6, '0')}`;
}

// --- the shadow stack ------------------------------------------------------
// Painted front to back, so the order here is the order they stack: the retro
// chroma split on top (it is meant to look like a misconverged tube, which
// means it has to be visible), then the dark shadow that makes the text legible
// over water, then the role's own bloom.
//
// The retro treatment used to be a separate rule that REPLACED text-shadow
// entirely, so switching it on silently deleted every legibility shadow in the
// game and the toasts lost their outline over pale water. Composed rather than
// replaced now — both are terms in one list.
function shadowStack(style, t) {
  const parts = [];
  const chroma = t.retro ? Number(t.retroChromaShift) || 0 : 0;
  const glow = t.retro ? Number(t.retroGlow) || 0 : 0;
  if (chroma > 0) {
    parts.push(`${-chroma}px 0 rgba(255, 60, 60, 0.55)`, `${chroma}px 0 rgba(60, 160, 255, 0.55)`);
  }
  if (glow > 0) {
    parts.push(`0 0 ${(glow * 6).toFixed(1)}px rgba(150, 220, 255, ${(glow * 0.5).toFixed(2)})`);
  }
  const shadow = Number(style.shadow) || 0;
  if (shadow > 0) {
    // A tight offset pass plus a soft halo. The offset one is what separates
    // text from a busy background; the halo is what stops it looking stuck on.
    parts.push(`0 1px ${Math.max(2, shadow * 0.4).toFixed(1)}px rgba(0, 0, 0, 0.9)`);
    parts.push(`0 0 ${shadow.toFixed(1)}px rgba(0, 0, 0, 0.75)`);
  }
  const own = Number(style.glow) || 0;
  // currentColor, so a role's bloom tracks its own colour with nothing to keep
  // in sync — including the chain banner, whose colour is written per frame.
  if (own > 0) parts.push(`0 0 ${own.toFixed(1)}px currentColor`);

  // THE SCAN TREATMENT'S OWN LIGHT — see `scanGlow` in textRoles.js. Only when
  // the mask is actually on, because it exists to survive the mask: it is the
  // part of the word that is still lit in the gaps between the lines.
  //
  // THREE TERMS, NOT ONE, and that is the difference between "glowing" and
  // "bright". A single wide blur at high alpha is a fog the letters sit in; a
  // tight core that keeps its edges, a mid halo, and a wide bloom read as a
  // filament. The alphas fall off faster than the radii grow so the total light
  // stays finite as the slider moves.
  const scanned = (Number(style.scan) || 0) > 0;
  const lit = scanned ? Number(style.scanGlow) || 0 : 0;
  if (lit > 0) {
    parts.push(
      `0 0 ${(lit * 0.25).toFixed(1)}px currentColor`,
      `0 0 ${(lit * 0.7).toFixed(1)}px currentColor`,
      `0 0 ${lit.toFixed(1)}px currentColor`,
    );
  }
  return parts.join(', ');
}

function roleCss(role, t) {
  const s = CONFIG.textStyles?.[role.key];
  if (!s) return '';

  const decls = [];
  const font = s.font && s.font !== FONT_GLOBAL ? s.font : '';
  decls.push(`font-family: ${font || 'var(--sv-font)'}`);
  if (font) ensureFontLoaded(font);

  // --sv-fit is the per-card shrink the upgrade hexes apply on top of
  // everything else (ui.js, fitCardText) — a factor, not a replacement, so a
  // card whose text fits is at exactly the size this row says.
  const fit = role.fit ? ' * var(--sv-fit, 1)' : '';
  // --sv-tipScale is the SMALL-SCREEN shrink for the coaching voice, and it is
  // a variable rather than a media query in this sheet for one reason: these
  // rules are rebuilt live from the Text panel, and a phone rule inside them
  // would have to be re-emitted (and kept in step with the layout audit's own
  // breakpoints) on every keystroke. The breakpoints live with every other
  // viewport rule in ui.js, and the size a role asks for is still the size it
  // gets on a desktop, where the variable is unset and the term is 1.
  const compact = role.compact ? ' * var(--sv-tipScale, 1)' : '';
  decls.push(`font-size: calc(${Number(s.size) || 0}px * var(--sv-scale)${fit}${compact})`);
  decls.push(`font-weight: ${Number(s.weight) || 400}`);
  decls.push(`letter-spacing: ${Number(s.tracking) || 0}em`);
  decls.push(`text-transform: ${CASE_CSS[s.case] ?? 'none'}`);

  // A role whose colour ui.js writes inline per element (the chain banner ramps
  // with the link count) is left alone here: an inline style wins over any rule
  // anyway, and emitting one would be a control that looks live and isn't.
  if (!role.inlineColor) {
    const base = s.useInk ? (CONFIG.typography?.color ?? 0xe8ecf3) : s.color;
    decls.push(`color: ${rgba(base, s.alpha ?? 1)}`);
  }

  const shadow = shadowStack(s, t);
  // `none` explicitly rather than omitted: these rules are rebuilt in place,
  // and a role that had a shadow a moment ago would otherwise keep the one the
  // previous sheet gave it, since nothing has replaced the declaration.
  decls.push(`text-shadow: ${shadow || 'none'}`);

  // THE PER-ROLE SHADOW MASK — see `scan` in textRoles.js. A repeating gradient
  // used as a MASK rather than painted over the top, for two reasons that both
  // decide the look:
  //
  //   it takes the glow with it. The role's bloom is a text-shadow, so it is
  //   part of what the mask cuts — the halo is striped exactly as the letters
  //   are, which is what makes it read as something LIT through a grille
  //   instead of a stripe decal lying on the type.
  //
  //   it needs no backdrop. An overlay would have to `multiply` against what is
  //   behind it, and these labels live in a z-indexed layer of their own over a
  //   canvas — a blend mode there composites against the transparent layer, not
  //   against the water, so it either does nothing or turns the text grey.
  //
  // The gap is dimmed, not cut: a mask alpha of `1 - scan` in the gap means the
  // slider runs from a hint of raster to a hard grille, and at 1 the missing
  // lines take the word with them. Written with the -webkit- prefix beside the
  // standard property, which is still what Safari answers to.
  const scan = Math.max(0, Math.min(1, Number(s.scan) || 0));
  if (scan > 0) {
    // Floored at 2px total: below that the line and the gap land inside one
    // device pixel and the whole role just goes evenly dim, which looks like a
    // mistake in the opacity rather than a raster.
    const gap = Math.max(2, Number(s.scanGap) || 3);
    const line = Math.max(1, Math.round(gap / 3));
    const mask = `repeating-linear-gradient(to bottom, #000 0 ${line}px, `
      + `rgba(0,0,0,${(1 - scan).toFixed(3)}) ${line}px ${gap}px)`;
    decls.push(`-webkit-mask-image: ${mask}`, `mask-image: ${mask}`);
  } else {
    // Same contract as `text-shadow: none` above — the sheet is rebuilt in
    // place, so a role that has just been turned off has to say so.
    decls.push('-webkit-mask-image: none', 'mask-image: none');
  }

  return `${role.selector} { ${decls.join('; ')}; }`;
}

/** The whole role sheet as text. Exported for the harness, which has no DOM. */
export function buildRoleCss() {
  const t = CONFIG.typography ?? {};
  const rules = [
    // The base scope first: every role rule below is the same specificity, so
    // this has to lose to them, and in CSS that means coming first.
    `${BASE_SCOPE} { font-family: var(--sv-font); }`,
    `.sv-ui { color: var(--sv-color); }`,
  ];
  for (const role of TEXT_ROLES) {
    const rule = roleCss(role, t);
    if (rule) rules.push(rule);
  }
  return rules.join('\n');
}

// Called at boot and again whenever anything in the Text panel changes, so
// edits land live rather than needing a reload.
export function applyTypography() {
  const t = CONFIG.typography ?? {};
  const root = document.documentElement.style;
  ensureFontLoaded(t.family);
  root.setProperty('--sv-font', t.family);
  root.setProperty('--sv-scale', String(t.scale));
  root.setProperty('--sv-color', hexCss(t.color));
  root.setProperty('--sv-scan', String(t.retroScanlineOpacity));
  root.setProperty('--sv-flicker', String(t.retroFlicker));

  // ensureSheet, not a held handle and not a null check: a guard here is how
  // this silently did nothing at all after a hot reload. See the comment on
  // ensureSheet. If the sheet has gone missing, the answer is to put it back,
  // not to skip the write and leave the screen showing stale CSS.
  ensureSheet('svTypographyStatic', STATIC_CSS);
  ensureSheet('svTypographyRoles').textContent = buildRoleCss();

  document.body.classList.toggle('sv-retro', !!t.retro);
  const overlay = document.getElementById('svRetroOverlay');
  if (overlay) overlay.style.display = t.retro ? '' : 'none';
}
