#!/usr/bin/env node
// ============================================================================
// WHAT A PLAYER ACTUALLY SEES — the artboards rendered with the REAL copy.
//
// The .riv holds lorem on purpose: uiText.csv owns every word and
// ui/statsCopy.js writes them in at runtime (see the header there). That rule
// is what keeps the copy gate able to see this screen at all — and its cost is
// that nothing you can open, neither the editor nor `rive --screenshot`, ever
// shows the page as a player meets it. You look at lorem and take the rest on
// faith.
//
// This closes that. It pushes the CSV's words in through `--data`, exactly the
// way the game pushes them, and renders. Nothing is written to the .rml, so the
// artboard stays clean and every gate stays green.
//
// IT CALLS statsCopy.js RATHER THAN PARSING IT. `statsLabels()` is imported
// and invoked — the same function ui/statsCard.js calls — so a preview cannot
// drift from what the game does.
// A tool that re-derived the mapping would be a second answer to "which row
// goes in which slot", and the one that goes stale is always the one you were
// looking at.
//
// THE SCENES ARE STATES, NOT PAGES. Half this screen is invisible at rest — the
// record badge is gated on `isRecord`, the players tab on `showPlayers`, the
// prompt on `overShown`. A single render
// shows one of them and silently omits the rest, which is exactly the confusion
// this exists to end. So it renders a named scene per state and writes them
// together.
//
//   npm run rive:preview                 every scene as a still
//   npm run rive:preview -- record       just that one
//   npm run rive:preview -- --list       the scene names
//
//   npm run rive:live                    THE CLI'S OWN VIEWER, live, with the
//   npm run rive:live -- record          real copy in it — rebuilds as you edit
//                                        the .rml, and takes the mouse
//
// The live window is the same scene table, so what you tune in it and what a
// still shows cannot come apart. Without the `--data` this mode sends, that
// window is the one place the artboard is honest about holding lorem — which
// is true and useless when what you are judging is the layout of real words.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statsLabels } from '../path/src/ui/statsCopy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'rive/blubberball');
const OUT = join(PROJECT, 'build/preview');
const RIVE = process.env.RIVE_CLI || join(process.env.HOME ?? '', '.rive/bin/rive');

// A match worth looking at: a 5-3 win with a real spread of tallies, so no
// number on the page is the zero that hides a broken bind.
const MATCH = {
  leftName: "Tony's Terrors", rightName: 'The Phat Nine',
  leftScore: 5, rightScore: 3,
  leftGoals: 5, leftAssists: 3, leftSaves: 2,
  rightGoals: 3, rightAssists: 2, rightSaves: 4,
  leftPossession: 57, rightPossession: 43,
  leftColor: 'FF4D4D', rightColor: '3FD8A0', accent: 'FF4D4D',
  seatsPerSide: 2,
};

// Four seats, so the players tab shows two a side rather than a column of
// placeholder. Seats 1-4 are the left column, 5-8 the right — see statsCard.js.
const SEATS = {
  'player1/name': 'Phat Tony', 'player1/goals': 3, 'player1/assists': 1, 'player1/saves': 2,
  'player2/name': 'Slippy Sue', 'player2/goals': 2, 'player2/assists': 2, 'player2/saves': 0,
  'player5/name': 'Big Mo', 'player5/goals': 2, 'player5/assists': 0, 'player5/saves': 4,
  'player6/name': 'Quick Nel', 'player6/goals': 1, 'player6/assists': 2, 'player6/saves': 1,
};

/** Every label the game would write, from the CSV, as --data pairs. */
const LABELS = { ...statsLabels() };

const SCENES = {
  team: {
    artboard: 'Stats Page',
    what: 'the team tab as a match leaves it — no record badge',
    data: { ...MATCH, ...LABELS },
  },
  winner: {
    artboard: 'Stats Page',
    what: "the winner's stamp, beside the side that won — gated on hasWinner",
    data: { ...MATCH, ...LABELS, hasWinner: true, winnerX: 190 },
  },
  // THE OTHER SIDE, because the stamp is ONE node at a bound x and 710 is the
  // only thing that puts it on the right-hand column. A still of the left one
  // alone would prove nothing about the number that moves it.
  winnerRight: {
    artboard: 'Stats Page',
    what: 'the same stamp on the right column — winnerX is what moves it',
    data: { ...MATCH, ...LABELS, leftScore: 2, rightScore: 3,
            hasWinner: true, winnerX: 710 },
  },
  // A DRAW IS A SCENE AND NOT A STATE: the page marks a level match by the
  // stamp being ABSENT, so this still is the one that shows what that looks
  // like — and it is worth having precisely because there is nothing to point
  // at in it.
  draw: {
    artboard: 'Stats Page',
    what: 'a timed match that ran out level — no stamp, and that is the mark',
    data: { ...MATCH, ...LABELS, leftScore: 3, rightScore: 3 },
  },
  record: {
    artboard: 'Stats Page',
    what: 'the record badge, which is off on an ordinary match',
    data: { ...MATCH, ...LABELS, isRecord: true },
  },
  players: {
    artboard: 'Stats Page',
    what: 'the players tab, two a side',
    data: { ...MATCH, ...LABELS, ...SEATS, showPlayers: true },
  },
  prompt: {
    artboard: 'Stats Page',
    what: 'the play-again prompt, Rematch lit',
    data: { ...MATCH, ...LABELS, overShown: true, overCursor: 0 },
  },
  seat: {
    artboard: 'Seat Card',
    what: 'a team-select seat, hovered and ready',
    // The seat card's three strings are the TEAM SELECT's, not this page's —
    // they are still lorem in the CSV sense because ui/teamSelect.js has not
    // been moved onto this artboard yet. Shown with stand-ins that are
    // obviously stand-ins rather than invented copy.
    data: { seatName: 'Phat Tony', teamColor: 'FF4D4D', hover: true, ready: true },
  },
  goal: {
    artboard: 'Goal Card',
    what: 'the card after a goal',
    data: { scorerName: 'Phat Tony', goalColor: 'FF4D4D', goalClock: '1:52' },
  },
};

const args = process.argv.slice(2);
const watch = args.includes('--watch');
if (args.includes('--list')) {
  for (const [name, s] of Object.entries(SCENES)) console.log(`  ${name.padEnd(10)} ${s.what}`);
  process.exit(0);
}
const want = args.filter((a) => !a.startsWith('--'));
const picked = want.length ? want : Object.keys(SCENES);

if (watch && picked.length !== 1) {
  // One window, one scene. The viewer shows a single artboard in a single
  // state, so a list here would silently be a choice of the first.
  console.error(`rive-preview: --watch takes exactly one scene (got ${picked.length || 'none'})`);
  console.error(`              try: npm run rive:live -- ${Object.keys(SCENES)[0]}`);
  console.error(`              or:  npm run rive:preview -- --list`);
  process.exit(2);
}

const unknown = picked.filter((n) => !SCENES[n]);
if (unknown.length) {
  console.error(`rive-preview: no such scene: ${unknown.join(', ')}`);
  console.error(`              try: ${Object.keys(SCENES).join(', ')}`);
  process.exit(2);
}

// ------------------------------------------------------------------ the window

if (watch) {
  const scene = SCENES[picked[0]];
  const argv = [PROJECT, `--artboard=${scene.artboard}`];
  for (const [k, v] of Object.entries(scene.data)) argv.push(`--data=${k}=${v}`);
  console.log(`  ${picked[0]} — ${scene.what}`);
  console.log('  the viewer rebuilds as you save a .rml. ctrl-c to stop.\n');
  // stdio inherited so the CLI's own rebuild log goes straight to this
  // terminal and ctrl-c reaches it; this process just waits on the window.
  const run = spawnSync(RIVE, argv, { stdio: 'inherit' });
  process.exit(run.status ?? 0);
}

// Wiped rather than overwritten, so a scene that stops rendering leaves a hole
// rather than yesterday's picture of itself.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const name of picked) {
  const scene = SCENES[name];
  const out = join(OUT, `${name}.png`);
  const argv = [PROJECT, `--screenshot=${out}`, `--artboard=${scene.artboard}`];
  // Passed as argv entries, never through a shell: a team name with an
  // apostrophe in it is ordinary and would not survive quoting.
  for (const [k, v] of Object.entries(scene.data)) argv.push(`--data=${k}=${v}`);
  // The CLI's own build chatter is not what anybody ran this for; the scene
  // list below is. `--data` drops still come through, which is the one line
  // from it that matters.
  argv.push('--advance=60', '--quiet');

  // BOTH STREAMS, and that is load-bearing: the CLI puts the dropped-`--data`
  // line on STDERR, so a run that read only stdout saw an empty log, found no
  // drops, and reported every scene fine — the exact silent pass this tool
  // exists to prevent, in the tool itself.
  const run = spawnSync(RIVE, argv, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (run.error || run.status !== 0) {
    failed++;
    console.error(`  FAIL ${name} — ${run.stdout ?? ''}${run.stderr ?? run.error?.message ?? ''}`);
    continue;
  }
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  // A `--data` path that matches nothing is DROPPED and the build still
  // succeeds — so the render looks plausible and one slot silently kept its
  // lorem. An error here rather than a line scrolling past.
  const dropped = [...log.matchAll(/--data (\S+): no property at this path/g)].map((m) => m[1]);
  if (dropped.length) {
    failed++;
    console.error(`  FAIL ${name} — these went nowhere: ${dropped.join(', ')}`);
    continue;
  }
  console.log(`  ok   ${name.padEnd(10)} ${relative(ROOT, out)}  — ${scene.what}`);
}

// A CONTACT SHEET, because a folder of files is a folder of files. The states
// only mean anything beside each other: the record badge against an ordinary
// match, a win against a draw. Written every run so it can never list a scene that
// is no longer there.
const sheet = `<!doctype html><meta charset="utf-8"><title>Blubberball preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px; background: #0b0f13; color: #cfd8e3;
         font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 15px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
       color: #6b7a8a; margin: 0 0 6px; }
  p.sub { margin: 0 0 26px; color: #55636f; }
  .grid { display: grid; gap: 26px; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); }
  figure { margin: 0; background: #11171d; border: 1px solid #1d2731; border-radius: 10px; overflow: hidden; }
  img { display: block; width: 100%; height: auto; background: #0e1419; }
  figcaption { padding: 10px 14px 12px; border-top: 1px solid #1d2731; }
  b { color: #e8eef5; font-weight: 600; }
  span { display: block; color: #6b7a8a; font-size: 13px; }
</style>
<h1>Blubberball \u2014 what a player sees</h1>
<p class="sub">Rendered with the words from uiText.csv. The artboards themselves still hold lorem.</p>
<div class="grid">
${picked.filter((n) => SCENES[n]).map((n) => `  <figure>
    <img src="${n}.png" alt="${n}">
    <figcaption><b>${n}</b><span>${SCENES[n].what}</span></figcaption>
  </figure>`).join('\n')}
</div>
`;
writeFileSync(join(OUT, 'index.html'), sheet);

console.log(failed ? `\n${failed} scene(s) failed\n` : `\n${picked.length} scene(s) in ${relative(ROOT, OUT)}\n`);
process.exit(failed ? 1 : 0);
