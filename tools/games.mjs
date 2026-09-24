// ---------------------------------------------------------------------------
// THE GAMES IN THIS REPO, AS DATA — one row per playable thing, and the one
// place that knows how to open each of them.
//
// There are two (Wordboard was a third until it moved to its own repo,
// ~/Projects/wordboard), and until this file existed only one of them had a
// door. The workbench had a hand-written Sealitaire card with an "open the
// table" button in it, and Blubberball was four presses into the game. That is not a
// hierarchy anybody decided on — it is the order they were written in.
//
// So the card is generated from this table now, the same way the command list
// is generated from package.json. Add a row and the workbench grows a door,
// `tools/game-app.mjs` grows a Dock button, and tools/hub-test.mjs starts
// holding both of them to the same standard.
//
// ---------------------------------------------------------------------------
// THE TWO ARE NOT THE SAME SHAPE, and the table says so rather than
// pretending otherwise:
//
//   A VIEWER GAME (Sealitaire) is a Rive CLI project. `npm run
//   <name>` opens a window and a tuning save loop, it has no port, and the
//   only way to know one is up is to ask the tool that owns the question —
//   `open()` below, which is that tool's own exported check and not a second
//   copy of its pgrep pattern.
//
//   A ROUTE GAME (Blubberball) lives inside Seal Survivor. It has no window of
//   its own; what it has is an address on the dev server, `/?ball`, which the
//   game reads once on the way through the menu (see takeOpeningRoute in
//   path/src/main.js). "Is it open" is "is the game server up", which the
//   socket survey already answers — so this row carries `url` and no `open`.
//
// A row with `editor` set has the three-script Rive round trip — pull, pull &
// apply, push. Blubberball's `rive:*` scripts drive the .riv its CARDS are
// drawn from, which is not this game's door, so it has none and they stay in
// the command list where they were.
// ---------------------------------------------------------------------------

import { join, resolve } from 'node:path';
import { tableOpen } from './sealitaire-tune.mjs';

export const ROOT = resolve(import.meta.dirname, '..');

export const GAMES = [
  {
    key: 'sealitaire',
    label: 'Sealitaire',
    // What the button says it opens, and what the row is called. One word for
    // the surface the game is played on, because "open Sealitaire" and "open
    // the table" are the same press and only one of them tells you what
    // appears.
    door: 'the table',
    blurb: 'Klondike on the ocean — the live viewer window and the tuning save loop.'
      + ' One at a time: the viewer rewrites tuning.luau when you press SAVE, so a second'
      + ' one would overwrite the first one\'s work.',
    script: 'sealitaire',
    project: 'rive/sealitaire',
    tune: 'tools/sealitaire-tune.mjs',
    shot: 'sealitaire:shot',
    log: 'rive/sealitaire/build/app.log',
    editor: 'sealitaire',
    app: 'sealitaire:app',
    open: tableOpen,
  },
  {
    key: 'blubberball',
    label: 'Blubberball',
    door: 'the pitch',
    blurb: 'The ball game, which lives inside Seal Survivor rather than in a window of its'
      + ' own — so its door is an address on the game server. `?ball` opens the team select'
      + ' once, on the way through the menu, and drops itself from the bar.',
    // The server it needs, by the name the socket survey and the hub both use
    // for it. Not a viewer: nothing here starts a second one, because a second
    // dev server is a second writer of imported-tuning.json.
    role: 'dev',
    script: 'ball',
    url: '/?ball',
    // Its Dock bundle prints a dev server's output, which is nothing like what
    // the other two print — but it goes in the same ignored build/ directory
    // the other two use, because "what did the app say just now" should be one
    // place per game and not two.
    log: 'rive/blubberball/build/app.log',
    app: 'ball:app',
  },
];

export const gameBy = (key) => GAMES.find((g) => g.key === key);

/** Every game with the live answer to "is it open", for the workbench. */
export function gameState() {
  return GAMES.map((g) => ({
    key: g.key,
    label: g.label,
    door: g.door,
    blurb: g.blurb,
    script: g.script,
    editor: g.editor ?? '',
    app: g.app,
    role: g.role ?? '',
    url: g.url ?? '',
    // A viewer has no port, so this is the tool's own check; a route game has
    // no pid at all and the hub reads its server off the socket table instead.
    pid: g.open ? g.open() : 0,
  }));
}

/** Where the Dock bundle tees what its session prints. */
export const logPath = (g) => join(ROOT, g.log);
