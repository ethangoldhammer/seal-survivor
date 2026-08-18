# Servers, tabs, and how not to stomp your own work

## Start here: the workbench

```bash
npm run hub
```

**<http://localhost:5178>** — one page listing every tool in the repo: the
servers, the browser pages, and all ~135 npm scripts, each described by the
header comment of the file it runs. Run a check and its output streams into the
page. Leave the tab open; it is the only address here that never moves.

That last part is the point. **The game's port changes every restart**, so the
hub re-resolves every link to it against the live socket table on each poll —
which is a job the dev server cannot do for itself. See `tools/hub.mjs` for
why it is a separate process and not a route on the dev server.

It will not deploy, publish, or ship. Those have a copyable command and no
button, and `npm run test:hub` fails if a new script that reaches the outside
world ever gets one.

Run `npm run servers` for the same picture in the terminal — it reads the live
socket table, works out what each process is, and says which ones are safe to
kill. Everything below is the reasoning behind both.

```bash
npm run servers
```

---

## The short version

Two servers, both in **Chrome**, both left running:

| | what it is | keep open |
|---|---|---|
| `npm run dev` | the game (vite) | **one** — exactly one |
| `npm run csv` | the CSV editor for enemies / upgrades / quips | one |
| `npm run hub` | the workbench — index of every tool | one, always |

Everything else on the list — extra dev servers, `vite preview`, agent
scratchpad servers — is leftovers. `npm run servers -- clean` clears them.

The ports move. Vite takes whatever it can get (`3000`, `54865`, `63641` have
all been the game at different times today), so never bookmark a port for the
game — open the hub and click through, or check the panel. The CSV editor is
fixed at **5177** and the hub at **5178**; those two are safe to bookmark, and
the hub is the better bookmark because it links to everything else.

---

## The one rule that matters: one tuning writer at a time

`vite.config.js` gives every dev server a `/__tuning` endpoint that writes
`path/src/imported-tuning.json`. A page that saves tuning POSTs the **entire
snapshot it booted with** — not a diff. So:

> Any tab that saves tuning overwrites the whole file with the state it had
> when it loaded. A tab from this morning saving at noon silently reverts every
> edit made in between.

That makes stale things dangerous in a way they don't look:

- **An old dev server is not a harmless duplicate.** It's a live tuning writer
  attached to whatever tab is still pointed at it. Kill old ones.
- **Two tabs on the same dev server is the same bug.** The second tab's
  snapshot is stale the moment the first one saves.
- **`tuner.html` counts as a tab.** It's the standalone tuning page (the
  panels with no game behind them) and it writes the same file through the same
  endpoint. Use it *or* the in-game `` ` `` panel, not both at once.

The practical rule: **one game tab, in Chrome, on the dev server the panel
marks `keep`.** If you want the standalone tuner instead, close the game tab
first.

Claude sessions follow the same rule from the other side: no second game tab
opened for testing, and gameplay gets verified with a Node harness rather than
a browser. (The Claude browser pane throttles the game loop anyway, so it
wouldn't prove much.)

---

## What owns the servers right now

A server started by Claude is a child of the Claude desktop app — **quitting
Claude kills it**, and the symptom in Chrome is a tab that just stops loading.
The panel's OWNER column says which. To make one independent, start it yourself
from Terminal:

```bash
cd ~/Projects/seal-survivor && npm run csv
```

For something that survives a reboot, a launchd agent in
`~/Library/LaunchAgents` with `RunAtLoad` + `KeepAlive` is the right tool.

---

## Restarting the CSV editor

It reads the column schema **once, at boot** — the card-art dropdown, the spawn
groups, the enemy columns all come from a snapshot of `enemyTable.js` and
`config.js` taken when the process started. After changing either file,
restart it or the new column simply won't appear.

It's the only writer to those CSVs and it checks mtime before saving, so the
worst case is a refused save, never a silent clobber — as long as nothing else
edits `enemies.csv` / `upgrades.csv` / `quips.csv` behind its back.

---

## The loose pages — none of these need their own server

All of them are served by the **game's dev server**; open them at
`http://localhost:<dev port>/<file>`. They're one-purpose harnesses, kept
because each one isolates something the full game makes hard to see:

| page | what it's for |
|---|---|
| `tuner.html` | tuning panels with no game running — **writes tuning, see above** |
| `model-inspector.html` | load a model, inspect its rig, materials, bounds |
| `biolum-preview.html` | contact sheet of bioluminescent skin variants |
| `boat-preview.html` | boat model + destruction states |
| `orbit-preview.html` | orbit a single asset |
| `perf-probe.html` | isolated perf measurements |
| `rive-test.html` | Rive splash harness |
| `tools/mask-check.html` | dither mask check |
| `tools/atlas-render/*.html` | model atlas renders, grabber audition, rig transfer |
| `design/components/*.html` | static HUD / level-up / splash / game-over mockups |

`tools/sfx-atlas.html` is generated output — regenerate with `npm run sfx:atlas`,
don't hand-edit.

**Agent scratchpad servers** (ports like `8931`) are one-off static servers a
Claude session started to serve a temp page out of `/private/tmp/claude-*`.
Nothing in the repo depends on them; they're always safe to kill.

**`vite preview`** (`4173`, `4174`, …) serves `dist/` as it was at the last
`npm run build`. Useful for the minute after a build, misleading forever after.
Not part of normal work.

**The layout audit** (`npm run layout`, port `4650`) builds `tools/layout/` and
serves it, and **stays up** — open the page, it sweeps 48 tiles of real
interface at real device sizes, prints what does not fit to the terminal, and
keeps serving so you can click any tile to remount and inspect it. It **cannot
write tuning**: a build served read-only, with no `/__tuning` endpoint — the
same reason the look pages are built rather than run on a second dev server.
Safe to kill at any time. `--once` is the check-runner mode: report and exit,
non-zero if anything overflows.

```bash
npm run layout
```

`server/` is not a dev server at all — it's the Cloudflare Worker source for
the leaderboard, deployed with wrangler.

---

## `.claude/launch.json` — where the entries come from

This is the list Claude sessions start servers from, and it accumulates. Two
kinds of rot to know about:

**Dead scratchpads.** Entries like `scratch-preview` / `ink-preview` /
`shader-check` point at `/private/tmp/claude-*/…/scratchpad` directories
belonging to sessions that ended. The directory is gone; the entry isn't.
Harmless, but they're most of the length of the file.

**Hardcoded ports.** `dev-alt` (5199) and `dev-alt2` (5223) pass
`--port … --strictPort`, so they fail outright rather than moving aside when
something already has the port. `autoPort: true` is the form that behaves —
`vite.config.js` honours `PORT` for exactly this reason.

**The CSV editor is an attach entry, on purpose:**

```json
{ "name": "csv-editor", "url": "http://localhost:5177", "port": 5177 }
```

No command, so `preview_start` connects to the running editor instead of
starting a rival. Two reasons it must stay that way: `tools/csv-editor.mjs`
reads `CSV_EDITOR_PORT`, not `PORT`, so `autoPort` does nothing for it — and a
second instance is a second writer to the same three CSVs, which turns the
mtime guard from a safety net into a stream of refused saves.

---

## Panel commands

```bash
npm run servers              # what's up, what's needed, what's stale
npm run servers -- stop 3000 # stop whatever is on that port (or pass a pid)
npm run servers -- clean     # stop everything the panel calls stale
```

`clean` never touches the newest dev server, the CSV editor, or any listener it
doesn't recognise as this repo's.
