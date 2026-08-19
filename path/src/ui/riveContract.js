// WHAT THE GAME NEEDS seal_survivor.riv TO CONTAIN.
//
// Three names, and every one of them is a handshake with a file this codebase
// does not author. Rename an artboard in the Rive editor, or rebind a property,
// and nothing here stops compiling — the game just quietly comes up with a
// blank splash or a health bar that never moves.
//
// So they live in one dependency-free module, imported by the code that uses
// them AND by the check that scans the shipped .riv for them
// (tools/rive-boss-test.mjs, `npm run test:bossbar`), which fails an export
// that has stopped containing them. That is the only reason this file exists:
// a constant used in one place would be better off inline, but a constant a
// test has to scan a binary for has to be reachable without dragging in the
// config, the runtime, or a canvas.
//
// Deliberately no imports, so the check needs no loader and no build.
//
// THERE IS ONE COPY OF THE FILE, `path/src/ui/seal_survivor.riv`, and Rive
// exports straight over it. There was briefly a second under ~/Documents with
// a sync tool between them; it is gone, because a one-way sync cannot know
// which of two copies is newer and reverted a finished export once. See the
// README.

/** The title-screen artboard. Named explicitly since the file gained a second. */
export const SPLASH_ARTBOARD = 'Splash Screen';

/** The in-game boss health bar. CONFIG.boss.bar.artboard can override it. */
export const BOSS_BAR_ARTBOARD = 'Boss Health';

/** The kill-shot card — the polaroid the run's trophies are printed on. */
export const SNAPSHOT_ARTBOARD = 'Polaroid';

/**
 * The splash's own two properties, and they are the only place in this file
 * where the traffic runs BOTH WAYS.
 *
 *   name   a string the game writes on every keystroke. Rive has no text
 *          input — 2.39's focus system does Tab traversal and nothing else —
 *          so a hidden DOM <input> owns the typing and this property is purely
 *          the display of it. That is also the only way the on-screen keyboard
 *          comes up on a phone; a raw keydown listener never raises it.
 *   start  a TRIGGER the artboard fires and the GAME listens to. Rive's own
 *          Start button decides when a run begins, rather than the splash
 *          being torn down by any stray input the way it used to be.
 *   random a second TRIGGER, fired by the dice button beside the name field.
 *          The game rolls a name out of sealNames.csv, puts it in the hidden
 *          <input> and mirrors it back through `name` — so the artboard needs
 *          to know nothing about the vocabulary, and the player can edit what
 *          lands or press it again.
 *
 * The listen direction is worth stating because it is the less obvious half of
 * the runtime: Rive.advance() calls handleCallbacks() straight after the
 * artboard advances, so a trigger the state machine fires reaches a JS
 * `.on()` callback on that same frame. See ui/riveSplash.js.
 */
export const SPLASH_BINDINGS = {
  name: 'strPlayerName',           // what the player is typing, mirrored in live
  start: 'tStart',                 // Rive -> game: begin the run
  random: 'tRandomizeName',        // Rive -> game: roll me a name
};

/**
 * The splash's STATE MACHINE INPUTS — the dice button's hover and press.
 *
 * These are what the game sets, and the artboard's own state machine decides
 * what they look like: `Random_Hover` and `Random_Click` are its states, not
 * ours, so retiming or redrawing either is an editor change with nothing to do
 * on this side.
 *
 * WHY THE GAME SETS THEM AT ALL. The artboard has hover and click listeners of
 * its own and they never fire — `npm run looks:splash` sweeps all 1920x1080
 * and no listener responds — so the pointer has to be read on our side and
 * handed over. See the note on DICE_HIT in ui/riveSplash.js, which is also the
 * thing to delete the day the listeners work.
 *
 * INPUTS RATHER THAN VIEW-MODEL PROPERTIES, deliberately. The file still has a
 * `bRandomHover` boolean wired to the same animation, and this runtime cannot
 * act on a view-model property from inside a state machine — setting it changes
 * nothing, measured. An input drives the machine today.
 */
export const SPLASH_INPUTS = {
  hover: 'randomHover',  // boolean: the pointer is over the dice
  click: 'randomClick',  // trigger: it was just pressed
};

/**
 * The data-binding properties the boss bar drives, by role. All three sit on
 * one view model, which the splash shares — see ui/bossBarRive.js for what
 * each is measured to mean.
 */
export const BOSS_BAR_BINDINGS = {
  health: 'numBossHealth',   // 0..100, how full the bar is
  size: 'numHealthBarSize',  // 0..100, the bar's length as a % of artboard width
  name: 'strBossName',       // the label under it
};

/**
 * The properties the kill-shot card is drawn from. Unlike the bar's three, the
 * card is almost entirely STRINGS — Rive has no number formatting, so a score
 * with thousands separators and a time as m:ss have to arrive already written.
 * The two numbers the run actually has (level, score) are formatted by the game
 * and sent as text; see systems/bossShot.js for the formatters that own them.
 *
 * `shot` is the exception and the reason this artboard is worth having: an
 * IMAGE property, which the frame grabbed on the kill is decoded into. It is
 * per view-model INSTANCE, which is what lets one parsed file carry a whole
 * run's prints with a different photograph in each — measured, eight for eight,
 * with no bleed between them. The alternative (substituting the image ASSET at
 * load) is per FILE, and would have cost a fresh parse of 1.7MB per print.
 */
export const SNAPSHOT_BINDINGS = {
  shot: 'imgShot',          // the kill shot itself, square, 620x620 in the zone
  name: 'strBossName',      // who was beaten; shrinks to fit, 43 chars verified
  kicker: 'strKicker',      // "cause of death: " — SEE THE TRAILING SPACE BELOW
  level: 'strLevel',        // "LVL 17" — the prefix belongs to the string
  time: 'strTime',          // "4:12" — the game's own m:ss, unpadded minutes
  score: 'strScore',        // STUB — declared, not placed on the card yet
  wordmark: 'strWordmark',  // STUB — declared, not placed on the card yet
  // THE WRITE-ON, and it is a trigger the GAME fires — the opposite direction
  // from the splash's `tStart`, which the artboard fires at us. The card is
  // built, bound and written long before anybody sees it (it is ejected from
  // the bottom of the screen and flown into the middle), so the artboard has
  // no way to know the moment it is actually being looked at. The game does,
  // and this is how it says so.
  //
  // FIRED ONCE PER PRINT, on the frame the flight lands — see
  // playCardWriteOn in ui/snapshotCard.js and the landing in
  // ui/snapshotPrint.js. Deliberately NOT on the score screen's fan: those are
  // the same photographs a second time, and a card that writes itself on again
  // every time it is laid out is an animation about nothing.
  writeOn: 'tWriteOn',
  // THE STAMP — what killed the boss, as the weapon's own name ('Homing
  // Missile', 'Belly Flop'). Written by the game on every card; see
  // systems/boss.js for where the answer is banked, one line before the body
  // is dropped.
  //
  // PENDING (below): it is written before the artboard has anywhere to put it,
  // which is the safe direction. `vmi.string()` returns null for a property the
  // file does not have and the writer skips it, so the game sending this to an
  // older export costs nothing at all — whereas an artboard with the property
  // and no game writing to it shows a stamp reading whatever the editor's
  // default value happens to be, on every print.
  cause: 'strCauseOfDeath',
  // WHOSE RUN IT WAS. The same name the splash's own strPlayerName is bound to
  // — one property per view model, two view models, one answer. It is written
  // ONCE PER PRINT here rather than on every keystroke the way the splash's is:
  // this card is a photograph of a moment, and the name is banked onto the shot
  // when the frame is grabbed (see systems/bossShot.js). A player who renames
  // themselves on the score screen does not retitle the prints they already
  // took.
  player: 'strPlayerName',
};

/**
 * Names the GAME already writes and the FILE is not required to have yet.
 *
 * The rest of this contract is a hard requirement: `npm run test:bossbar`
 * scans the shipped .riv for every name and fails the build on a miss, which
 * is exactly right for a binding that used to work and stopped. It is exactly
 * wrong for one being added, because the two halves land in different commits
 * — the code here, the property in an export from the Rive editor — and
 * whichever arrives first would otherwise redden `npm test` and block a deploy
 * over a feature that is deliberately half-finished and harmless.
 *
 * So a pending name is REPORTED and not failed. The test prints it as pending
 * while it is absent and, the moment an export contains it, tells you to move
 * it out of this list — which is the only thing stopping "pending" from
 * becoming a permanent hole in the check.
 */
export const PENDING_BINDINGS = [];
// EMPTY IS THE NORMAL STATE, and not a sign this can be deleted: a name lives
// here only for as long as it takes an export to catch up with the code, which
// is usually hours. `strCauseOfDeath` was the first and came out on 2026-08-18,
// when the artboard that draws the stamp shipped.

/**
 * THE KICKER CARRIES A TRAILING SPACE, and it is load-bearing. The kicker and
 * the value beside it are separate runs set side by side on the chin, so the
 * gap between them is not padding in the artboard — it is the last character of
 * this string. Write it trimmed and the card reads "cause of death:Homing
 * Missile". The artboard's own default value has the space in it; anything the
 * game sends has to keep it.
 *
 * WHAT IT LABELS CHANGED, and this constant is now only the FALLBACK. It used
 * to read "defeated " and sit beside the run clock; it now introduces the cause
 * of death, and the live value is rolled per print from kickers.csv — "cause of
 * death: ", "kill'd by: ", "taken down by way of: ". This is what a card falls
 * back to when nothing supplied one, which in practice means a preview rather
 * than a kill. See path/src/kickerTable.js, which owns the rotation AND owns
 * adding that trailing space, because a spreadsheet cannot hold one reliably.
 */
export const SNAPSHOT_KICKER = 'cause of death: ';

// WHAT IS DECLARED BUT NOT YET DRAWN. `strScore` and `strWordmark` are bound
// and writable, and land nowhere — the card has no slot for either yet. They
// stay in the contract because they exist on the view model, so deleting one in
// the editor SHOULD fail the check; just don't read a blank card as a broken
// write.
//
// A QR is going on the card too, in that same undecided corner — qr.js already
// encodes one, pure and DOM-free, so it is only ever a placement question. When
// it lands it wants an IMAGE property, `imgQr`, fed exactly like `imgShot`:
// rasterise qrRows() onto a canvas, decodeImage, assign. Add the name here at
// that point and not before — a required name that is not in the file fails
// every export, including the good ones.

/**
 * The view models by name. Not needed to BIND anything — every surface uses
 * autoBind, which hands back the artboard's own default instance without a
 * lookup — but they are the only unambiguous thing to check an export against.
 *
 * WHY THAT MATTERS: the validator below is a scan for name strings in a binary,
 * and TWO of these names now exist twice, once on each view model —
 * `strBossName` and `strPlayerName`. Rename the polaroid's copy of either in
 * the editor and a scan for it still finds the other one, and the check passes
 * on an export that has quietly lost the card's name. The view model names are
 * unique, so they are the part of this contract that can actually fail when
 * something is renamed.
 */
export const VIEW_MODELS = {
  bar: 'ViewModel1',      // shared by the splash and the boss bar
  snapshot: 'PolaroidVM', // the kill-shot card
};

/** Everything a usable export must contain, flat, for a validator to walk. */
export function riveRequirements(bossArtboard = BOSS_BAR_ARTBOARD) {
  return {
    artboards: [SPLASH_ARTBOARD, bossArtboard, SNAPSHOT_ARTBOARD],
    // Deduped: `strBossName` and `strPlayerName` are each on BOTH view models,
    // and a validator that listed one twice would report the same name passing
    // (or failing) twice.
    bindings: [...new Set([
      ...Object.values(SPLASH_BINDINGS),
      ...Object.values(BOSS_BAR_BINDINGS),
      ...Object.values(SNAPSHOT_BINDINGS),
    ])].filter((n) => !PENDING_BINDINGS.includes(n)),
    // Checked, reported, not required — see PENDING_BINDINGS.
    pending: [...PENDING_BINDINGS],
    viewModels: Object.values(VIEW_MODELS),
  };
}
