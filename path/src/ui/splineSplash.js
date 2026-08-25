// THE SPLINE NAME SCREEN — an audition, standing in for the Rive card.
//
// Same job, same door: mount over the game, take the player's name, tear
// yourself down when they ask to play. The DIFFERENCE is only what draws the
// picture — a Spline scene instead of a .riv artboard.
//
// ---------------------------------------------------------------------------
// IT IS A DROP-IN, and that is the whole design.
//
// `mountSplineSplash` takes the same options as `mountRiveSplash` and returns
// the same handle, so ui.js chooses between them with one `const mount = ...`
// and nothing downstream — leaveSplash, the gamepad dismiss in updateMenuNav,
// revealSplashOut — knows which one it got. Anything that has to be true of
// the name screen is therefore true of BOTH, which is the only honest way to
// compare them: a treatment that wins because it quietly skipped the buried
// name check has not won anything.
//
// The shared parts are shared by IMPORT, not by copy: playerName.js sanitises
// and stores, randomName.js rolls, nameLedger.js says who is dead, tipJar.js
// is the jar. This file owns the picture and the press, and nothing else.
//
// ---------------------------------------------------------------------------
// THREE THINGS SPLINE HANDS OUT, and this takes whichever you have. The route
// is decided by the shape of the URL — see mountScene.
//
//   a .splinecode URL    the code export. @splinetool/runtime draws it into a
//                        canvas IN THIS DOCUMENT, so the wrapper's own pointer
//                        listeners still fire and the seal underneath keeps
//                        tracking the cursor. Spline's events and states
//                        survive — and so does the scene's HTML content, which
//                        is the thing this file spends the most code on. See
//                        THE PANEL below.
//
//   any other https URL  the public viewer link (my.spline.design/...), in an
//                        iframe. Everything survives, including the panel, and
//                        NOTHING can be done about it from out here: the frame
//                        is cross-origin, so the workbench chrome cannot be
//                        hidden and every pointer event that lands inside it
//                        stops there — `onPointer` goes quiet and the seal
//                        behind stops watching the cursor. Fine for a look,
//                        wrong for a screen.
//
//   a .glb / .gltf path  NOT LOADED HERE. A model belongs in the game's own
//                        three.js scene, where the lights, the outline pass and
//                        post.js can all reach it — that is systems/titleSeal.js
//                        and tools/looks/splash-bust.js, not a DOM overlay. If
//                        the audition ends up wanting the Spline set dressing
//                        lit by the game, that is the route, and this module is
//                        not on it.
//
// The runtime comes from a CDN by dynamic import rather than as a dependency,
// which is the same call tools/looks/splash-bust.js makes and for the same
// reason: it is a megabyte of a second renderer, and while this is an audition
// the game's bundle should not carry it. `npm i @splinetool/runtime` and a
// static import here is the one-line swap if it ships.
//
// ---------------------------------------------------------------------------
// NO COPY IS WRITTEN HERE, deliberately, and it cost nothing.
//
// The Rive card draws its own words. This one has none to draw, so the obvious
// move was a Start button — and a Start button needs a word, which is Ethan's
// and not mine (CLAUDE.md). It turned out not to be needed: the shipped splash
// already starts on a press anywhere that is not the field or the dice, which
// is the only rule that works on a phone. So this does the same, the dice is a
// glyph, and the only text on screen is the player's own name.
//
// If the audition wins, a Start affordance and whatever line sits over the
// field are a copy pass — not a code one.
// ---------------------------------------------------------------------------

import { loadPlayerName, savePlayerName, sanitizeName, MAX_NAME_LEN } from '../systems/playerName.js';
import { randomPlayerName } from '../systems/randomName.js';
import { isNameBuried } from '../systems/nameLedger.js';
import { touchPrimary } from '../devices.js';
import { mountSplashTipJar } from './tipJar.js';
import { parseTipCsv } from '../tipTable.js';
import tipsCsv from '../tips.csv?raw';

const TIP_TIERS = parseTipCsv(tipsCsv);

// PINNED, and pinned to a version this scene was actually opened in. An
// unpinned CDN import is a screen whose look can change overnight because
// somebody else shipped a release, which is the opposite of what an audition is
// for — and the floor matters too: the export is written by whatever Spline is
// today, and an older runtime is free to not understand it.
const RUNTIME_URL = 'https://unpkg.com/@splinetool/runtime@2.0.5/build/runtime.js';

// ---------------------------------------------------------------------------
// THE PANEL — the scene's HTML content, which the code export DOES carry.
//
// The runtime appends it as a sandboxed <iframe> ON document.body — not inside
// the canvas's parent, and so not inside this screen's wrapper. Left alone it
// is three separate bugs at once:
//
//   IT COVERS THE SCREEN   full-bleed, `pointer-events: auto`. Every press
//                          meant for the name field or for "play" lands in the
//                          frame instead, and the game becomes unstartable
//                          with nothing in the console.
//   IT IS A WORKBENCH      a fly-camera HUD, a "Current & cloth" slider stack
//                          and a name lab with a graveyard tab. Ethan's tools
//                          for building the scene, and not a title screen.
//   IT OUTLIVES US         being on document.body, destroy() removing the
//                          wrapper does not remove it. It would sit over the
//                          run.
//
// AND YET IT CANNOT SIMPLY BE DELETED, which is the part that is not obvious:
// its script is not decoration, it is the scene's runtime. It scatters the
// plants (167 objects at load, 251 once it has run), drives the cloth and the
// current, and writes the name into the 3D card. Remove the frame and what is
// left is a bare seal on an empty bed.
//
// So the chrome is hidden and the script is kept, in two separate ways, because
// the two halves fail differently.
//
// THE POINTER IS FIXED FROM A STYLESHEET, not by setting the frame's style.
// The runtime rewrites that element's inline `style` wholesale every time it
// lays the overlay out — pointer-events included — so an assignment here is
// undone within a frame or two, and the window in which it looked fixed is
// exactly long enough to be convincing. A rule in OUR document with
// `!important` cannot be beaten by an inline style, so it survives every
// relayout.
//
// THE CHROME IS HIDDEN BY REWRITING srcdoc. The frame is `srcdoc` with
// `sandbox="allow-scripts allow-forms allow-pointer-lock"` — no
// `allow-same-origin` — so `contentDocument` is null and nothing inside can be
// reached. The attribute is a plain string on our side of that boundary: a
// stylesheet spliced into its <head> and assigned back reloads the document
// with the workbench `display:none` and its script running exactly as before.
//
// AND THE FRAME IS TAKEN FROM THE RUNTIME, not found by looking. It is created
// during load(), appended to the CANVAS'S PARENT, and moved — so a snapshot of
// `body > iframe` taken either side of load() finds the wrong element or none,
// and the tame then silently applies to nothing. `_htmlContentOverlay.iframe`
// is the frame itself. Private, hence the guards: if a Spline release renames
// it the pointer rule still holds (it matches on the frame's own title) and the
// worst case is a visible workbench, which is a thing you can see.
//
// `?splinePanel` skips all of it, which is how the workbench is used from
// inside the game rather than only in Spline.
const PANEL_CHROME = ['#cp', '#fly', '#flyhud', '#seal'];

// Our own marker, so a second tame can tell "already done" from "the runtime
// replaced the document". Checking for `display:none` instead would be a false
// positive on the panel's own CSS, which uses it for the inactive tab.
const PANEL_TAMED = 'sv-panel-tamed';

// ---------------------------------------------------------------------------
// HOW THE 3D CARD LEARNS THE NAME — through the panel, because that is the only
// side of the boundary the scene's text can be written from.
//
// The runtime's Application exposes findObjectByName/getAllObjects and an
// object proxy carrying position, rotation, scale, colour and events. NO TEXT.
// The scene has no variables either, so `setVariable` has nothing to move. From
// out here the "SEAL NAME" card is unreachable, which is why it sat blank.
//
// INSIDE the panel it is one call. Spline injects a `spline` bridge into that
// frame with `updateObject(idOrName, { geometry: { text } })`, which rewrites a
// Text mesh live. The panel's own name lab is what has been driving the card
// all along.
//
// So the same srcdoc rewrite that hides the workbench also plants a listener,
// and the game posts the name in. The alternative — asking Spline for a text
// variable, binding the card to it and re-exporting — changes the file for a
// thing the file can already do, and every future export has to remember it.
//
// GUARDED ON A KEY, not on origin: the frame is sandboxed to an opaque origin,
// so `e.origin` is "null" and worth nothing as a check. Anything without our
// key is somebody else's message — the bridge's own postMessage traffic runs
// through this same channel and must pass straight through untouched.
const NAME_MSG = 'sv:playerName';
const panelBridge = (target) => `<script id="${PANEL_TAMED}-bridge">
window.addEventListener('message', function (e) {
  var d = e && e.data;
  if (!d || d.kind !== ${JSON.stringify(NAME_MSG)}) return;
  try {
    Promise.resolve(window.spline && window.spline.ready).then(function () {
      window.spline.updateObject(${JSON.stringify(target)}, { geometry: { text: String(d.name || '') } });
    });
  } catch (err) { /* the card simply stays as it was */ }
});
<\/script>`;

// The fallback behind the frame's own `load` event — see tamePanel. Long enough
// that an inline document has certainly committed, short enough that nobody
// watches the workbench flash past.
const PANEL_TAME_MS = 250;

// THE POINTER RULE, added once per document. Matched on the frame's `title`,
// which is the only stable thing Spline puts on it — it carries no class, no id
// and a style attribute that is rewritten constantly.
const PANEL_STYLE_ID = 'sv-spline-panel-style';
function installPanelPointerRule() {
  if (document.getElementById(PANEL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PANEL_STYLE_ID;
  style.textContent = 'iframe[title="Spline HTML content"]{pointer-events:none!important}';
  document.head.appendChild(style);
}

// The same dead time the Rive card uses, and for the same reason: the splash
// mounts under whatever gesture brought the player here (a reload, a click on
// the page, a dismissed dialog), and a run that begins before the title has
// been read looks exactly like the splash failing to appear.
const START_DEADTIME_MS = 400;

/** Which of the three routes a source string is on. */
function routeFor(src) {
  if (!src) return 'none';
  if (/\.(glb|gltf)(\?|#|$)/i.test(src)) return 'model';
  if (/\.splinecode(\?|#|$)/i.test(src)) return 'runtime';
  return 'iframe';
}

export function mountSplineSplash({
  parent = document.body,
  // The scene. Required in practice — with nothing here the screen still works
  // (it is a name field over the game's own title shot) but there is nothing
  // to audition, so it says so in the console rather than looking broken.
  src = '',
  onReady,
  onError,
  onDismiss,
  onPointer,
  onGesture,
  exit,
  // KEEP THE WORKBENCH. `?splinePanel` — see THE PANEL at the top. The whole
  // reason it is an option and not a deletion: the sliders in that frame are
  // how the current, the cloth and the plant scatter get tuned, and tuning them
  // against the game's own framing is worth more than tuning them in Spline.
  keepPanel = false,
  // THE VIEW MODEL, SPLINE-SIDE. A scene variable the player's name is written
  // into on every keystroke, so the 3D card can show it the way the artboard's
  // text run does.
  //
  // NOTHING IS BOUND TO IT TODAY. The export carries no variables at all
  // (`getVariables()` is empty), and the runtime's object proxy exposes
  // position, rotation, scale, colour and events — no text. So the 3D "SEAL
  // NAME" card cannot be written to from out here as the scene stands, and the
  // name lives in the DOM field instead.
  //
  // The write is made anyway, and made harmless, because the fix is one step in
  // Spline: add a variable, bind the Text to it, re-export, and the card starts
  // following the field with nothing changing on this side.
  nameVariable = 'playerName',
  // THE 3D CARD, by object id. An id rather than "Text" because the export has
  // 167 objects and more than one of them could be called that — a name that
  // resolves to the wrong mesh writes the player's name onto some other surface
  // and looks like the card not working.
  //
  // Read it off `get_scene` in Spline, or from this page's console:
  // `__splash.spline.getAllObjects().filter(o => o.type === 'Mesh')`.
  nameObject = '',
  // Matches the Rive card's option so the two can be swapped without ui.js
  // deciding anything. Unlike the artboard, a Spline scene mounted here fills
  // the wrapper — so this is what shows through a scene with alpha in it,
  // rather than the letterbox around a `Fit.Contain` artboard.
  background = '#05070d',
} = {}) {
  const route = routeFor(src);

  const wrap = document.createElement('div');
  wrap.className = 'sv-riv sv-spline';
  // Same box, same z, same explicit pointer-events as the Rive card — .sv-ui
  // is pointer-events:none so the 3D scene under it stays clickable, and a
  // splash that inherits that is a splash nothing can be typed into.
  wrap.style.cssText =
    `position:absolute; inset:0; pointer-events:all; z-index:20; background:${background};`;

  // WHERE THE SCENE GOES, under the chrome. Its own element so the canvas or
  // the iframe can be swapped without touching anything that sits over it.
  const sceneLayer = document.createElement('div');
  sceneLayer.style.cssText = 'position:absolute; inset:0; overflow:hidden;';
  wrap.appendChild(sceneLayer);

  // THE FIELD, VISIBLE — and that is the one real departure from the Rive
  // path. There the input is invisible and the artboard draws the text, so the
  // two have to be kept in step; here nothing else is drawing it, so the field
  // IS the display. One element, no mirror, no caret to fake.
  //
  // It is still a real <input> for the reason that has never changed: it is the
  // only thing that raises the on-screen keyboard on a phone, and most of this
  // game is played on one.
  //
  // font-size 16px minimum is not a look — anything smaller and mobile Safari
  // zooms the page when the field takes focus. The size below is well over it.
  const field = document.createElement('div');
  field.style.cssText =
    'position:absolute; left:50%; bottom:14%; transform:translateX(-50%);'
    + ' display:flex; align-items:center; gap:10px; padding:10px 14px;'
    + ' border-radius:14px; background:rgba(4,10,14,.44);'
    + ' border:1px solid rgba(255,255,255,.14); backdrop-filter:blur(6px);'
    + ' max-width:min(560px, 86vw); box-sizing:border-box;';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = MAX_NAME_LEN;
  nameInput.setAttribute('aria-label', 'Your name');
  nameInput.autocomplete = 'off';
  nameInput.autocapitalize = 'off';
  nameInput.spellcheck = false;
  nameInput.setAttribute('autocorrect', 'off');
  // "Go" rather than "return" on the phone keyboard, which is the only label on
  // that key that describes what it does here — Enter starts the run.
  nameInput.setAttribute('enterkeyhint', 'go');
  nameInput.style.cssText =
    'flex:1; min-width:0; border:0; outline:0; background:transparent;'
    + " font-family:var(--sv-font, 'Inter', system-ui, sans-serif);"
    + ' font-size:clamp(20px, 4vw, 34px); font-weight:700; letter-spacing:.01em;'
    + ' color:#eaf7fb; text-align:center; caret-color:#8ff3f8;';
  field.appendChild(nameInput);

  // THE DICE. A glyph and not a word, so this screen still writes no copy —
  // and the same glyph the Rive card's button carries, so a player who has
  // seen one recognises the other.
  const dice = document.createElement('button');
  dice.type = 'button';
  dice.textContent = '🎲';
  dice.setAttribute('aria-label', 'Roll a name');
  dice.style.cssText =
    'flex:0 0 auto; border:0; background:transparent; cursor:pointer;'
    + ' font-size:clamp(18px, 3vw, 26px); line-height:1; padding:4px 6px;'
    + ' opacity:.82; transition:opacity .12s, transform .12s;';
  dice.addEventListener('pointerenter', () => { dice.style.opacity = '1'; dice.style.transform = 'scale(1.12)'; });
  dice.addEventListener('pointerleave', () => { dice.style.opacity = '.82'; dice.style.transform = ''; });
  field.appendChild(dice);

  wrap.appendChild(field);

  // The jar, on the one screen a player is not busy. Same call the Rive card
  // makes, same tiers — it takes its own pointer events and stops them dead,
  // so a tap on it is not also a press on the scene behind it.
  const tipJar = mountSplashTipJar(wrap, { tiers: TIP_TIERS });

  parent.appendChild(wrap);

  let app = null;          // the @splinetool/runtime Application, on that route
  let frame = null;        // the iframe, on the viewer-link one
  // The scene's own HTML content, which the runtime appends beside the canvas —
  // see THE PANEL at the top. Held so destroy() can take it with us.
  let panel = null;
  let panelTamed = false;
  let panelTimer = 0;

  /**
   * Hide the workbench, keep the script. See THE PANEL — the frame is
   * sandboxed without `allow-same-origin`, so its srcdoc string is the only
   * way in, and assigning it back is what reloads the document with the
   * stylesheet applied.
   *
   * SILENT AND SURVIVABLE if the shape ever changes: a Spline release that
   * stops using srcdoc, or a scene whose HTML has no <head>, leaves the panel
   * exactly as it was rather than taking the screen down. The pointer fix
   * below does not depend on any of that — it is our own element's style — so
   * even in that case the game stays startable and the worst outcome is a
   * visible workbench, which is a thing you can see.
   */
  function tamePanel() {
    if (keepPanel) return;

    // FIRST, AND INDEPENDENT OF EVERYTHING BELOW. This is what keeps the name
    // field reachable and the run startable, and it does not need the frame to
    // have been found — it matches whatever the runtime put on the page.
    installPanelPointerRule();

    if (!panel) return;

    // AFTER THE FRAME HAS LOADED ITS FIRST DOCUMENT, and that is the whole
    // subtlety here. Assigning `srcdoc` while the initial about:srcdoc
    // navigation is still in flight does not re-navigate — the attribute ends
    // up carrying our stylesheet while the document on screen is the original
    // one. It looks tamed to every check that reads the attribute, and the
    // workbench is still sitting over the game.
    //
    // So the rewrite waits for `load`, with a timer behind it in case that
    // event fired before we got here (the panel is inline, so it can). The flag
    // is what makes them one shot rather than two, and it is a flag rather than
    // a re-read of srcdoc for the same reason as above: the attribute is not
    // evidence of what is rendered.
    const rewrite = () => {
      if (panelTamed || destroyed || !panel) return;
      const doc = panel.srcdoc;
      if (typeof doc !== 'string' || !doc) return;
      const at = doc.indexOf('</head>');
      if (at < 0) return;
      panelTamed = true;
      const css = `<style id="${PANEL_TAMED}">${PANEL_CHROME.join(',')}{display:none!important}</style>`;
      const bridge = nameObject ? panelBridge(nameObject) : '';
      panel.srcdoc = doc.slice(0, at) + css + bridge + doc.slice(at);
      // AFTER THE RELOAD, not now: the listener we just spliced in does not
      // exist until the frame comes back, and a name posted before then is a
      // message with nobody at the other end. Once is enough — every keystroke
      // after this posts for itself.
      panel.addEventListener('load', () => writeName(nameInput.value), { once: true });
    };
    // THE REWRITE COSTS A FLASH — the panel's document reloads, its script
    // restarts, and for about a second the scene it was driving is not being
    // drawn. In the GAME that is invisible: the wrapper behind it is opaque
    // (splashBackground()) and it happens while the screen is still arriving.
    // On the look page, over a transparent checker, it is a second of nothing —
    // which is worth knowing before reading a blank frame as a broken scene.
    panel.addEventListener('load', rewrite, { once: true });
    panelTimer = setTimeout(rewrite, PANEL_TAME_MS);
  }

  let destroyed = false;
  let loaded = false;
  const mountedAt = performance.now();
  // Whether the press being released began on the splash — a pointerup on its
  // own is not a click, it is also what arrives when a drag that started
  // somewhere else lets go up here.
  let pressBeganHere = false;

  function destroy(reason = 'manual') {
    if (destroyed) return;
    destroyed = true;

    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    clearTimeout(panelTimer);

    // BANKED ON THE WAY OUT, whatever ended the screen — not per keystroke
    // (savePlayerName writes to localStorage and a write per character is what
    // makes typing feel heavy on a slow phone) and not on submit only (that is
    // how a player who typed a name and pressed Enter ends up called Seal).
    savePlayerName(nameInput.value);
    // Off the DOM before the exit animation: the wrapper hangs around for the
    // dissolve, and a focused input inside it keeps the phone keyboard up over
    // the first second of the run.
    nameInput.blur();
    field.remove();
    // Same reason the field goes: the jar is DOM, so it would sit there
    // perfectly crisp while the art it belongs to breaks up.
    tipJar.remove();

    // Both routes keep a renderer and a rAF loop alive in a detached element
    // if they are not told to stop.
    try { app?.dispose?.(); } catch { /* a runtime version without it */ }
    app = null;
    frame?.remove();
    frame = null;
    // ON document.body, not in the wrapper — so this is the only thing that
    // takes it away, and without it the workbench sits over the run.
    panel?.remove();
    panel = null;

    // Off immediately: the wrapper covers the whole screen and an exit
    // animation that took a second would otherwise eat the first second of the
    // run's input.
    wrap.style.pointerEvents = 'none';

    // Before the exit, not after — the run starts NOW and the screen dissolves
    // over a game that is already moving.
    onDismiss?.(reason);

    if (exit) exit(wrap, () => wrap.remove());
    else wrap.remove();
  }

  // BEGIN THE RUN. Two guards, because "anywhere else starts" is a very large
  // button and both of these are ways of pressing it without meaning to: the
  // press must have begun here, and not in the first moments.
  function maybeStart(began) {
    if (destroyed || !began) return;
    if (performance.now() - mountedAt < START_DEADTIME_MS) return;
    destroy('press');
  }

  // THE DICE. Rolls, lands IN THE FIELD — which is what makes it a suggestion
  // rather than a verdict: the name is now theirs to edit, clear or roll again,
  // and it is banked on the way out exactly like a typed one.
  //
  // The current value is passed as `avoid`, because a randomise button that
  // returns the name already on screen reads as a button that did nothing.
  function randomizeName() {
    if (destroyed) return '';
    const name = randomPlayerName(nameInput.value);
    nameInput.value = name;
    return name;
  }

  const onSplashDown = () => { pressBeganHere = true; };

  const onSplashPointer = (e) => {
    // First, and before any branch below can end the screen: audio has to
    // unlock inside a real gesture call stack.
    onGesture?.();
    const began = pressBeganHere;
    pressBeganHere = false;
    // The field and the dice own their own presses. A tap on the field means "I
    // want to type" and must never start the run — it is the one place on this
    // screen where a press does not mean play.
    if (field.contains(e.target)) return;
    maybeStart(began);
  };

  // MOUSE ONLY, and the filter is the important half: forwarding a touchmove
  // would leave a phone convinced it had a mouse for the rest of the run.
  const onSplashMove = (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    onPointer?.(e.clientX, e.clientY);
  };

  const onDice = (e) => {
    // Stops the press reaching the wrapper, where it would also be a start.
    e.stopPropagation();
    onGesture?.();
    randomizeName();
    nameInput.focus();
  };

  // Enter starts the run — what the return key means in a form, and what
  // `enterkeyhint="go"` has already promised the phone keyboard. Not a general
  // keydown: with a text field on screen "any key starts" means the first
  // letter of your own name does.
  const onNameKey = (e) => {
    onGesture?.();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    destroy('enter');
  };

  // Sanitised on the way IN rather than on the way out, so the field shows
  // exactly the characters that will be stored and posted: a player typing
  // something the leaderboard would strip watches it not appear, instead of
  // finding it missing from the board later.
  //
  // Rewritten only when the sanitiser actually changed something — assigning
  // `.value` unconditionally moves the caret to the end, which turns editing
  // the middle of a name into a fight.
  const onNameInput = () => {
    const clean = sanitizeName(nameInput.value);
    if (clean !== nameInput.value) nameInput.value = clean;
    writeName(clean);
  };

  // Push the current text at the scene. A no-op until something is bound to it
  // — see `nameVariable` — and deliberately quiet: this runs on every
  // keystroke, so a scene with no such variable must not be a scene that logs
  // sixty times a second. Whether the binding exists is said once, at load.
  function writeName(value) {
    // THE PANEL FIRST — it is the route that works today. See NAME_MSG.
    if (panel && nameObject && !keepPanel) {
      try { panel.contentWindow?.postMessage({ kind: NAME_MSG, name: value }, '*'); } catch { /* torn down */ }
    }
    // ...and the variable, for the day one is bound. A no-op until then, and
    // deliberately quiet: this runs on every keystroke, so a scene with no such
    // variable must not be a scene that logs sixty times a second.
    if (!app || !nameVariable) return;
    try { app.setVariable?.(nameVariable, value); } catch { /* not bound */ }
  }

  const listeners = [
    [wrap, 'pointermove', onSplashMove],
    [wrap, 'pointerdown', onSplashDown],
    [wrap, 'pointerup', onSplashPointer],
    [dice, 'pointerup', onDice],
    [nameInput, 'input', onNameInput],
    [nameInput, 'keydown', onNameKey],
  ];
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn);

  // A RETURNING PLAYER MAY BE RETURNING AS A DEAD SEAL. The score card names
  // the next one on the way out of a run, but a player who closes the tab on
  // the game-over screen never gets there — and the name still in storage
  // belongs to a seal with a headstone. Rolled fresh here rather than shown and
  // refused later, and SAVED immediately: a player who starts without touching
  // the field would otherwise run under the buried name again.
  const remembered = loadPlayerName();
  if (remembered && isNameBuried(remembered)) savePlayerName(randomPlayerName(remembered));
  nameInput.value = loadPlayerName();

  // Focus so a keyboard player can type without clicking. Not on touch, where
  // it throws the on-screen keyboard up over the art before it has been asked
  // for — the same rule the game-over name field follows.
  if (!touchPrimary()) nameInput.focus();

  /**
   * Put the scene on screen. Returns a one-line description for the console, so
   * a scene that failed to arrive says so rather than looking like a scene that
   * renders nothing.
   */
  async function mountScene() {
    if (route === 'none') {
      return 'no scene — set CONFIG.splineSplash.src, or pass ?splineSrc=';
    }
    if (route === 'model') {
      // Refused rather than half-supported. See the header: a model wants the
      // game's own scene, and loading one into a DOM overlay would be a second
      // renderer drawing an unlit copy of something the game could light.
      throw new Error(
        `${src} is a model, not a scene export — put it through the game's 3D scene `
        + '(systems/titleSeal.js), not this overlay.',
      );
    }

    if (route === 'runtime') {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'display:block; width:100%; height:100%;';
      sceneLayer.appendChild(canvas);
      const mod = await import(/* @vite-ignore */ RUNTIME_URL);
      // Between the await and here the player may already have dismissed this.
      if (destroyed) return 'dismissed during load';

      app = new mod.Application(canvas);
      await app.load(src);
      if (destroyed) return 'dismissed during load';

      // THE FRAME, FROM THE RUNTIME ITSELF — see THE PANEL. Falling back to the
      // title only if that private field ever moves.
      try {
        panel = app._htmlContentOverlay?.iframe ?? null;
      } catch { panel = null; }
      if (!panel) panel = document.querySelector('iframe[title="Spline HTML content"]');
      tamePanel();

      // SAID ONCE, HERE, and not from the keystroke handler. Whether the 3D
      // card can follow the field is a fact about the export, so it belongs in
      // the one line that describes the export.
      let vars = {};
      try { vars = app.getVariables?.() ?? {}; } catch { /* older runtime */ }
      if (!nameObject && nameVariable && !(nameVariable in vars)) {
        console.info(
          `[splineSplash] this export has no "${nameVariable}" variable`
          + `${Object.keys(vars).length ? ` (it has: ${Object.keys(vars).join(', ')})` : ' — it has none at all'}`
          + ', and no nameObject is set, so the 3D card cannot follow the field.',
        );
      }
      writeName(nameInput.value);

      return `spline runtime — ${src}${panel ? (keepPanel ? ' (panel kept)' : ' (panel tamed)') : ''}`;
    }

    // THE VIEWER LINK. Cross-origin, so every pointer event that lands inside
    // it stops there: `onPointer` goes quiet and the seal behind this screen
    // stops watching the cursor. The frame is left INTERACTIVE anyway, because
    // on this route the Spline scene is the thing being auditioned and a scene
    // whose own hover states are dead is not the scene. Use the .splinecode
    // route if both have to be live at once.
    frame = document.createElement('iframe');
    frame.src = src;
    frame.style.cssText = 'width:100%; height:100%; border:0; display:block;';
    frame.setAttribute('allow', 'autoplay; fullscreen');
    sceneLayer.appendChild(frame);
    return `spline embed (iframe) — ${src}`;
  }

  mountScene()
    .then((note) => {
      if (destroyed) return;
      loaded = true;
      console.info(`[splineSplash] ${note}`);
      onReady?.({ route, src, app });
    })
    .catch((err) => {
      console.error('[splineSplash] scene failed —', err);
      onError?.(err);
      // NOT FATAL, and this is the same call the Rive path makes on a bad .riv:
      // a name screen that cannot reach its backdrop is still a name screen,
      // and the game must never be a blank wall with no door. The field is
      // already up and a press still starts the run.
    });

  return {
    destroy,
    randomize: randomizeName,
    get isDestroyed() { return destroyed; },
    // What the Rive handle's `isPlaying` answers for: "is the picture live".
    get isPlaying() { return loaded && !destroyed; },
    // Escape hatch, matching the Rive handle's `.rive` — emitEvent /
    // setVariable from the console, on the runtime route.
    get spline() { return app; },
    get route() { return route; },
  };
}
