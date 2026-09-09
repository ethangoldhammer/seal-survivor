# Upgrade pool — the disable / gate list

A running list of cards that should not be in the open pool, and why. Working
notes, not copy.

**The pool respects both levers, and does so now.** `availableUpgrades()` in
`path/src/entities/player.js` drops a card on `enabled === false` and again on
`unlockGranted('upgrade', u.id)`, in that order, before any of the exclusivity
or companion-cap rules run. With a blank ledger the hand is 51 of 59 cards, and
the eight it withholds are exactly the five disabled rows plus the three gated
ones — nothing else. That equality is worth re-checking after any change here;
it is the whole of what this file promises.

## The two levers, and what each one actually does

**Disable** — `enabled` = `FALSE` in `path/src/upgrades.csv`. The card leaves the
roster entirely: never dealt, never counted, and its `apply()` is never run.
This is the lever for a card that is broken, unfinished, or a dead pick at any
tuning. It takes effect immediately, in every build.

**Gate** — a row in `path/src/unlocks.csv` with `kind` = `upgrade` and `target`
= the upgrade's id. The card is withheld until a lifetime stat crosses a count,
then pops as a toast and is dealt from the *next* run on. Three things to know
before adding one:

- `GATE_DEFAULT` in `path/src/systems/unlocks.js` is **true** — a gate bites,
  in every build, including this one. It used to be false, which meant the
  table was written but nothing read it and a gate could be wrong for months
  with nothing to notice. A dev session opts out per page load with `?gate=0`;
  a harness calls `setUnlockGate(false)`, which five of them now do, each with
  a note saying why. `tools/unlock-test.mjs` asserts the value outright, so
  flipping it back is a deliberate edit in two files.
- A gated card is simply **not dealt**. Nothing greyed, nothing explained. If a
  card should read as locked rather than absent, that surface does not exist yet.
- The row's `label` is player-facing copy, so it is Ethan's, and `npm run
  test:copy` holds the ship until it is written. A gate row can be parked with
  `enabled` = `FALSE` in the meantime — that skips validation entirely, which is
  how the stub rows at the bottom of the table sit there quietly.
- Gates are **sticky** and key on the row's own `id`. Renaming a row forgets
  every player who earned it.
- **The ledger persists on the dev server** exactly as it does anywhere else —
  it is localStorage and nothing branches on the build — so a dev session builds
  a real history and the gates open the way a player's would. Two ways out:
  `?unlocks=reset` on the URL, which wipes at import, before the menu builds the
  drawer; and `svUnlocks.reset()` in the console, which wipes mid-session and
  reloads, because the menu, the drawer and the offer pool were all built off
  the ledger it just threw away. `svUnlocks.reset(false)` skips the reload.

The stat has to come from `STATS` in `systems/unlocks.js`. There is no
"times this upgrade was picked" counter, so **a gate cannot depend on another
card** — the club tree can't hide `clubBoom` behind `club` without a new stat.

## Disable

| id | card | status | why |
| --- | --- | --- | --- |
| `scallopSquirter` | Scallop Squirter | **done** | 0.28–0.58x return in every block of the ledger; flagged a dead pick outright |
| `harp` | Harp Seal | **done** | 0.42–0.45x return; the control it does give (14–19 events/stack-min) is Beluga's job, done worse |
| `dumbo` | Dumbo Octopus | **done** | no damage at all, and the weakest control in the log (4.7–7.6 events/stack-min) |
| `sardineSwirl` | Sardine Swirl | candidate | 0.30x share and 0.41x across 8 picks; barely appears at all |
| `overboost` | *(unnamed)* | **done** | already `FALSE` |
| `dolphinPod` | Dolphin Pod | **done** | already `FALSE` |

## Gate

| id | card | status | stat it could ride | why |
| --- | --- | --- | --- | --- |
| `beluga` | Baby Beluga Bubble Blaster | **live — needs the label** | `bubblesPopped` × 50 | far and away the strongest control in the log: 17–67 events per stack-minute, 2–4x anything else |
| `orcaFamily` | Orca Family | **live — needs the label** | `boss.bossOrca` × 1 | gated rather than disabled: the pod was the worst-returning card in the ledger, but beating the orca boss is the reason to have it |
| `maneater` | Maneater | proposed — Ethan | `humansEaten` | works: `recordHumanEaten()` fires on every crew bite whether or not the card is held (`main.js:8263`), so the counter runs before the unlock. The gate and the card's own mechanic read the same number, which is the neat version |
| `vitality` | Healthy Pup! | proposed — Ethan | — | needs a stat picked |
| `octoGrab` | Octopus Grabber | candidate | — | the second-strongest control (11–24 events/stack-min) and zero damage — a pure utility card that flattens crowding |
| `biolumShock` `biolumVenom` `biolumChill` `biolumInfection` | the four elements | candidate | — | already weight 0.2, already a set. One earned per element is the shape they're asking for |
| `laserEyes` | Laser Eyes | **done** | `perk.eyebeam` | the first upgrade gate, and until the switch flipped the only one that was written |

## Retuned instead

Four cards came off the lists above because the honest fix was the number, not
the roster. All of it is in `path/src/weapons.csv`; nothing was typed into a
card description — `{effect}` measures what `apply()` actually moves.

| id | card | was | now |
| --- | --- | --- | --- |
| `seaGarlic` | Sea Garlic | 1,366 dmg/stack-min | tick 4.5 → 12, per stack 1.5 → 4 |
| `starfish` | Surf Ninja | 1,767 | damage 22 → 55, per stack 6 → 15 |
| `calamari` | Calamari Ring | 2,560 | damage 14 → 24, per stack 6 → 11 |
| `oysterBlaster` | Oyster Blaster | 28,197 | bomblet 62 → 30 **and** impact 30 → 15 |
| `musselVolley` | Bearded Barrage | 19,416 | direct 34 → 21, splash 58 → 36 |

The band they are aimed at is the healthy mid-table — the eel at 4,771, the
shrimp ring at 4,625, the razor clams at 4,268 — with the base gun at 13,118.

Two things worth keeping:

- **Calamari could not be tuned at all before this.** `calamari.damage` and
  `calamari.damagePerLevel` were tuner sliders, so both sat in
  `imported-tuning.json`, where a saved value beats a config.js default. They
  are weapons.csv rows now (fenced to those two paths — the reach, the band, the
  swirl and the squid stay on sliders), the sliders are deleted, and the table
  strips the paths out of the snapshot on load and on save. Exactly how
  `starfish`, `musselVolley` and `laserEyes` each arrived.
- **The oyster nerf had to take both halves.** Cutting only the bomblet damage
  put the burst at exactly 5x the pearl's impact and tripped the assertion in
  `tools/ability-smoke.mjs` that keeps the card a bomb rather than a slow
  bullet. Halving the impact alongside it holds the ratio at 10x.

## Accessories

Every one of the **thirteen** accessories now has a live gate, so the drawer
starts completely bare — one tile, the bare seal. Five of them (the hard hat,
the cowboy hat, the witch hat, the shark hood and the neon jellyfish) had their
gate rows written but PARKED with `enabled` = `FALSE` while they waited on a
toast line, and a parked row gates nothing; they are unparked now, with their
labels staged as lorem and the brief in `notes`.

`tools/unlock-test.mjs` asserts the bare drawer AND that the table gates every
key in `CONFIG.accessories.items`. That second half is the one that matters
going forward: an accessory added without a row fails there, loudly, instead of
quietly appearing in a drawer that is meant to start empty.

The counts on those five are still placeholders — 100 sharks, 250 levels, 20
graves, 10 maxed cards, a chain of 25 — set against nothing anybody has played.
Each row's brief says so.

## Adding one

1. **Disable**: set `enabled` to `FALSE` in `upgrades.csv`. That is the whole
   change — no code, no test to update.
2. **Gate**: a row in `unlocks.csv` — `id`, `kind` = `upgrade`, `target` = the
   upgrade id, `stat` from `STATS`, `count`, and a `label` staged as lorem with
   the brief in `notes` opening `NEEDS YOUR WORDS`. If no existing stat fits,
   add the name to `STATS`, write a recorder beside the others in
   `systems/unlocks.js`, and call it at the event in `main.js` through
   `announceUnlocks()` — one line each.
3. Run `npm run test:unlocks` (the wiring and the table) and `npm run
   test:copy` (which will now fail, correctly, until the label is written).
4. Add the row here with the ledger number that justified it.

A harness that is not about gating and touches the offer pool or the accessory
drawer needs `setUnlockGate(false)` at the top, or it starts failing the day
someone adds an unrelated row to the table.

## Open questions

- `vitality` and the remaining candidates need a **stat** chosen from `STATS`.
  Some of the obvious ones (`levelsGained`, `runsPlayed`, `creaturesEaten`) are
  attendance rather than skill.
- **Seven labels are the only thing holding a ship.** `npm run test:copy`
  fails on `orcaFamily`, `beluga` and the five unparked accessory rows, and `ship.mjs`
  builds its gate list from every `test:*` script, so it blocks `npm run ship`
  automatically.
- A disabled card and a gated card look identical to a player today — both are
  just absent. If gating is meant to read as progress, the level-up hand needs a
  locked state.
- Several of the "dead pick" numbers above are from ledger blocks that predate
  the current tuning (the ability names in `playtest/runs.jsonl` have moved).
  Re-run `npm run playtest` after any rebalance before acting on a row here.
