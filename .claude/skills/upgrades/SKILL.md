---
name: upgrades
description: Add, change, rebalance or remove a Seal Survivor upgrade. Use whenever the request touches upgrade cards, level-up choices, stat scaling, ability stacking, upgrade rarity/weights, card art, or the juice an upgrade's ability fires. Routes each part of the change to the right layer (upgrades.csv, config.js apply(), systems/, CONFIG.feedback) and verifies with npm run test:upgrades.
---

# Changing an upgrade

An upgrade is spread across four layers on purpose. Most of the mistakes in
this area are edits made in the wrong one — a name changed in `config.js` that
the CSV overwrites at boot, or a new ability with no `CONFIG.feedback` entry
that fires a `console.warn` and no particles for a week before anyone notices.

Work out which layers the request touches before editing anything.

| Layer | File | Holds | Symptom of editing the wrong one |
|---|---|---|---|
| **Content** | `path/src/upgrades.csv` | `name`, `desc`, `maxStacks`, `enabled`, `weight`, `cardArt`, `sfx` | — |
| **Card wording** | `path/src/upgradeText.js` | the `{placeholder}` vocabulary and the English name of every stat | A new stat renders on the card as its raw variable name |
| **Mechanic** | `path/src/config.js` (`CONFIG.upgrades`, ~line 3420) | `apply(s)`, `perLevelName`, `levelDescs` | Editing `name`/`desc`/`maxStacks` here does nothing; the CSV overwrites them at boot |
| **Behavior** | `path/src/systems/<ability>.js` | what the ability does per frame | Stat exists, card is takeable, nothing happens in the water |
| **Juice** | `CONFIG.feedback` + `feedback('event')` call sites | particles, shake, hitstop, glow, ripple, sfx, haptic | Ability works, feels like nothing |

`apply(s)` mutates the stat block seeded in `path/src/stats.js`. Any new field
an upgrade touches must be seeded there first, or the first stack reads
`undefined` and every arithmetic result is `NaN`.

**A new stat needs a label.** `desc` can say `{effect}`, which measures the
upgrade by running its `apply()` and describes what moved — so a stat with no
entry in `STAT_TEXT` (`path/src/upgradeText.js`) renders on the card as its raw
variable name. `npm run test:text` fails on exactly that, and it is the check to
run after adding a field to `stats.js`. Prefer `{effect}` over a hand-typed
number in any new description: a typed "+25%" is a second copy of the
multiplier with nothing holding the two together.

## Order of work

1. **Restate the change as a per-layer list** before editing. Say which of the
   four layers each item lands in, and confirm anything ambiguous. A request
   like "make Shrimp Ring rarer and hit harder" is two layers: `weight` in the
   CSV, damage in `systems/shrimpRing.js` or the stat in `apply()`.
2. **Seed first.** New stat field → `path/src/stats.js`.
3. **Mechanic**, then **behavior**, then **content**, then **juice**.
4. **Run the harness.** `npm run test:upgrades`.
5. **Set the feel last**, once the numbers pass — see *Visuals and feedback*.

## Verifying

```bash
npm run test:upgrades
```

Three sections, exit 1 on any failure:

- **Stat math** — replays every `apply()` up to its stack cap against a
  *synthetic* base (every stat set to 100, so the result is independent of
  `imported-tuning.json`) and diffs it against `tools/upgrade-snapshot.json`.
  Also fails on `NaN`/`Infinity`, on a stat that must stay positive reaching
  zero, on an `apply()` that throws, and on one that changes nothing at all.
- **Table** — `upgrades.csv` against `CONFIG.upgrades`: orphan rows, invalid
  `cardArt`, unparseable weights, enabled cards with a blank name or
  description, and a dealable pool smaller than `CONFIG.upgradeChoices`.
- **Feedback** — every `feedback('x')` fired anywhere in `path/src` has a
  `CONFIG.feedback` entry, and every entry has at least one live channel.

Useful flags (`npm run test:upgrades -- --only shrimpRing`):

- `--only <id>` prints that upgrade's per-stack numbers — the fastest way to
  read a stacking curve without launching the game.
- `--update` accepts the current stat math as the new snapshot. **Read the
  diff first.** A snapshot failure is the harness working; `--update` is the
  approval step, so only run it once the change listed is the change intended.
- `--json` for machine-readable output.

The snapshot is committed. A stat-math failure on a branch that didn't mean to
touch balance usually means a `CONFIG` constant read directly inside an
`apply()` moved — `bounceShot` reads `CONFIG.bounce.maxBouncesPerLevel`, so
tuning that slider legitimately changes its per-stack math.

### What the harness cannot tell you

It does not run the game. It proves the stat block is right and the wiring is
present — never that the ability feels good, targets correctly, or is balanced.
For balance, play a run and use `npm run playtest`, which reads
`playtest/runs.jsonl` and reports whether an ability returns more than the
picks spent on it.

## Running the game — don't

Do not start a dev server to check an upgrade, and do not drive the game in the
Browser pane:

- Any dev server on any port writes `path/src/imported-tuning.json`, which is
  the user's live tuning work.
- The Browser pane suspends `requestAnimationFrame`, so the game loop is frozen
  there and a screenshot proves nothing about gameplay.

The Node harness exists so upgrade changes can be verified without either.

## Visuals and feedback

Set these after the numbers pass, not while chasing them.

**Card art** is the `cardArt` column of `upgrades.csv`. The value must be a key
from `LEVELUP_IMAGE_KEYS` in `config.js` (~line 3536); anything else falls back
to a plain card and the harness fails the row.

**A card's own arrival sound** is the `sfx` column — a key from `CONFIG.sfx`,
played on top of the click when the card is taken. Blank means the shared
`levelUp` feedback, which is right for most of them; set it on the cards worth
hearing arrive. An unknown key falls back to the shared sound and warns.

Both columns are pickers in `npm run csv` — card art as a gallery of the thirty
real hex images, `sfx` as the sound bank with a play button on every sampled
voice — which is faster than typing a key and checking it against a list.

**Juice** is one `feedback('event', { x, y, scale })` call per event, with
everything it does described in `CONFIG.feedback` (~line 1883). Adding a new
one means both halves — a key in the table and a call site. Channels:

| Channel | Effect | Scale |
|---|---|---|
| `emit` | particle preset name | — |
| `shake` | camera impulse, decays | 0.02 tick → 0.7 big kill |
| `hitstop` | freeze, seconds | 0 for anything that repeats; 0.06–0.07 only for real impacts |
| `glow` | bloom pulse | 0.1–1.2 |
| `ripple` | grid displacement | `{ strength, radius }` |
| `sfx` | key in `CONFIG.audio` | needs its own entry there too |
| `haptic` | `[ms]` or `[{ duration, magnitude }]` | — |
| `sfxMinGap` | seconds between repeats of the sound only | set it on anything a volley can fire many times in one frame |

Two rules worth stating because breaking them is subtle:

- **Repeating events need `sfxMinGap`.** A multishot volley lands every pellet
  in one frame; without it the same sound plays six times stacked.
- **A saved `null` in `imported-tuning.json` beats any default in
  `config.js`.** If a new feedback entry does nothing in the user's session,
  check the tuning file before re-reading `config.js` — the harness fails on a
  merged entry with no live channel, which catches exactly this.

Sustained effects (something that trembles for as long as it lasts, rather than
jolting once) use `addSustainedShake()` re-asserted every frame, not `shake`.
