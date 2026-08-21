// ============================================================================
// THE PLAYER'S NAME — one value, one place, and the {player} token that spends
// it.
//
// This used to live in systems/leaderboard.js, which was right when the name
// was a leaderboard concern: you typed it into the game-over card and it went
// on the board. It is not that any more. The name is read by callouts.csv,
// quips.csv and upgrades.csv, and a board module those three had to import to
// find out what to call somebody would be the widest dependency in the text
// layer to reach one string. So the name moved out and the leaderboard became
// what it always should have been — one CONSUMER of it.
//
// The storage key did NOT change with it. `seal-survivor-player-name` is what
// every existing player's name is already filed under, and a rename here would
// silently forget every one of them.
//
// TWO ACCESSORS, AND THE DIFFERENCE IS LOAD-BEARING:
//
//   loadPlayerName()  what the player actually typed, or '' if they never did.
//                     For the INPUT FIELD, which must come up blank rather
//                     than pre-filled with a name nobody chose — a field
//                     already containing "Seal" reads as their name being
//                     taken, and the leaderboard would fill with defaults from
//                     players who simply did not clear the box.
//   playerName()      what TEXT should call them, never blank. This is the one
//                     the token spends, because "Nice try, " is not a sentence
//                     and "{player}" on the band is a bug report.
//
// SANITISING IS THE SERVER'S RULE, NOT OURS. sanitizeName mirrors cleanName in
// server/leaderboard-worker.js so that what you see in the field is what lands
// on the board — a name silently rewritten server-side reads as the game
// eating your input. It also strips the characters that would be dangerous on
// the way back out, since these strings reach innerHTML.
// ============================================================================

const NAME_KEY = 'seal-survivor-player-name';

// Must match MAX_NAME_LEN in server/leaderboard-worker.js — the server is the
// authority and truncates anything longer, so raising it here alone would let
// players type a name the board then silently cuts.
//
// 32, up from 24. The number is the FIELD's limit as much as the board's: it
// is only worth what the input can show at once, because a name whose tail
// scrolls out of the box while you type it reads as the field being broken.
// See .sv-name-input in ui/ui.js, which is sized against this — raising this
// alone would give players room they cannot see themselves using.
export const MAX_NAME_LEN = 32;

/**
 * What to call a player who has not told us. Deliberately not "ANON" or
 * "Player": those are what a FORM calls an empty field, and this string is
 * spoken by the game — it lands mid-sentence in a callout and on the game-over
 * headline. "Seal" is what the player is, so a line written for a name that
 * was never typed still reads as though it meant to say that.
 *
 * Not in CONFIG and not a setting: it is a word in the game's voice, which
 * makes it the same kind of thing as the rows in quips.csv rather than a knob.
 */
export const DEFAULT_PLAYER_NAME = 'Seal';

// The live value, so the token costs nothing to spend. It has to be cached:
// a callout expands its tokens on EVERY FRAME the line is up (see
// activeCallout), and a localStorage read per frame to answer a question whose
// answer changes about once a month would be absurd.
//
// `undefined` means "not read yet" — distinct from '', which is the real
// answer for a player who has never typed one.
let cached;

// See the catch in savePlayerName — storage that is gone stays gone, so the
// complaint is worth making exactly once.
let warnedNoStorage = false;

function read() {
  if (cached !== undefined) return cached;
  try {
    cached = sanitizeName(localStorage.getItem(NAME_KEY) ?? '');
  } catch {
    // Private window, opaque origin. The name is simply not remembered, which
    // is the right way to be wrong about something nobody has to be told.
    cached = '';
  }
  return cached;
}

/** What the player typed, or '' if they never did. For the input field. */
export function loadPlayerName() {
  return read();
}

/**
 * What text should call them. Never blank — see the note at the top of the
 * file about why this is a separate question from the one above.
 *
 * TRIMMED, and that is the second half of why these are two functions rather
 * than one. sanitizeName keeps a TRAILING space on purpose (see its note: it
 * is how somebody is mid-word, and eating it makes the field fight the
 * typist), which is right for a text box and wrong for a sentence — a quip
 * written "{player}, watch out!" would read "Ethan , watch out!" for anybody
 * whose finger was on the space bar when they submitted. The field keeps the
 * space; the token never sees it.
 */
export function playerName() {
  return read().trim() || DEFAULT_PLAYER_NAME;
}

/** Has the player actually chosen a name, as opposed to being called Seal? */
export function hasPlayerName() {
  return read().length > 0;
}

/**
 * Remember a name. Returns the sanitised value, which is what actually got
 * stored and what the caller should use — the leaderboard posts this rather
 * than the raw field, so the board and the game agree about the spelling.
 *
 * A blank is NOT stored and does not clear an existing name: every caller
 * today is a field that can be empty for reasons other than intent (a form
 * shown before it is filled in, a submit on an untouched box), and forgetting
 * somebody's name because a widget was momentarily empty is not a thing this
 * should be able to do. Clearing is `clearPlayerName`, which nothing calls yet
 * and which the splash's own field will want the day it grows a reset.
 */
export function savePlayerName(name) {
  const clean = sanitizeName(name);
  if (!clean) return '';
  cached = clean;
  try {
    localStorage.setItem(NAME_KEY, clean);
  } catch (err) {
    // Stored in memory even when the write fails, so the token is right for
    // the rest of the session. Only the remembering is lost.
    //
    // Once, not per save. Storage does not come back — a private window is a
    // private window for the whole session — so the second warning carries no
    // information the first one didn't, and a player who submits five runs
    // would get five identical lines in a console they might be using to
    // report something else.
    if (!warnedNoStorage) {
      warnedNoStorage = true;
      console.warn('[playerName] could not save the name —', err?.message ?? err);
    }
  }
  return clean;
}

/** Forget it. The cache goes with the key, or the token would keep saying it. */
export function clearPlayerName() {
  cached = '';
  try {
    localStorage.removeItem(NAME_KEY);
  } catch { /* nothing to do, and nothing worth taking a run down for */ }
}

/**
 * The CHARACTER half of the rule, with no length limit applied.
 *
 * Split out of sanitizeName because the two halves fail differently and one
 * caller has to tell them apart. sealNameTable.js loads a table of names the
 * game might roll into this field, and a row that is merely too long is a file
 * error worth refusing loudly — while sanitizeName, which is right for a field
 * somebody is typing into, would silently hand back the first 24 characters of
 * it and leave the table looking fine.
 *
 * `trimStart` only, not `trim`: a trailing space is how somebody is mid-word,
 * and eating it while they type would make the field fight the typist. The
 * server trims both ends when the score is posted.
 */
export function stripName(raw) {
  return String(raw ?? '')
    .replace(/[<>&"'\\]/g, '')
    .replace(/\s+/g, ' ')
    .trimStart();
}

/**
 * Mirrors cleanName in server/leaderboard-worker.js. See the note at the top.
 * The character rules above, plus the length the board will accept.
 */
export function sanitizeName(raw) {
  return stripName(raw).slice(0, MAX_NAME_LEN);
}

// ---------------------------------------------------------------------------
// THE TOKEN
// ---------------------------------------------------------------------------

/**
 * `{player}` -> whatever they are called.
 *
 * THE DOOR FOR ANY TEXT TABLE. Three surfaces spend this token today and they
 * reach it three different ways, because each already had a token pass of its
 * own and each has its own rule about an unknown one:
 *
 *   callouts.csv   through fillBindings in systems/callouts.js, which resolves
 *                  {strike} and {bumper} in the same sweep.
 *   upgrades.csv   through expandDesc in upgradeText.js, which measures
 *                  {effect} from the card's own apply().
 *   quips.csv      through THIS function, called at the render site — quips
 *                  have no tokens of their own and needed no machinery to gain
 *                  one.
 *   greetings.csv  through fillBindings as well, because the hello at the top
 *                  of a run is handed to the band as a callout row (see
 *                  systems/greeting.js). It is the table the token was really
 *                  written for: every line in it says the player's name.
 *
 * A fourth table is the quips line: import this and call it. What must not
 * happen is a fourth place that reads the name and formats it itself, which is
 * how "Seal" and "ANON" end up being two different answers to one question on
 * two screens.
 */
export function expandPlayer(text) {
  if (!text || !text.includes('{')) return text ?? '';
  return String(text).replace(/\{player\}/g, playerName());
}
