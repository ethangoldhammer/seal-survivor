# Servers, tabs, and how not to stomp your own work

Run `npm run servers` any time you're not sure what's up. It reads the live
socket table, works out what each process is, and says which ones are safe to
kill. Everything below is the reasoning behind that panel.

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

Everything else on the list — extra dev servers, `vite preview`, agent
scratchpad servers — is leftovers. `npm run servers -- clean` clears them.

The ports move. Vite takes whatever it can get (`3000`, `54865`, `63641` have
all been the game at different times today), so never bookmark a port for the
game — check the panel. The CSV editor is fixed at **5177** and is safe to
bookmark.

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

`server/` is not a dev server at all — it's the Cloudflare Worker source for
the leaderboard, deployed with wrangler.

---

## Panel commands

```bash
npm run servers              # what's up, what's needed, what's stale
npm run servers -- stop 3000 # stop whatever is on that port (or pass a pid)
npm run servers -- clean     # stop everything the panel calls stale
```

`clean` never touches the newest dev server, the CSV editor, or any listener it
doesn't recognise as this repo's.
