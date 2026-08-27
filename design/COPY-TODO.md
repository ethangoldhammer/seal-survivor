# Copy waiting to be written

Lines Claude staged as lorem ipsum because they needed to exist for a feature
to be testable. Each one is a brief, not a draft — replace the lorem in the
listed file with your own words and delete the entry.

`npm run test:copy` lists everything still outstanding and blocks `npm run
ship` until this is empty.

Rows in a CSV that has a `notes` column carry their brief there instead; this
file is for the ones that don't (and for strings in `.js`).

| where | what the line has to do |
| --- | --- |
| `ui/upgradeTip.js` TIP_COPY.next | Row heading over the measured effect of the stack you would be taking. Read while a level-up card is up, or while hovering a hexagon in the hive. Two words at most — it sits in a 9-character column beside the measurement. |
| `ui/upgradeTip.js` TIP_COPY.total | Row heading over the running total across the stacks already held ("+112% fire rate"). Has to read as "where you are now" against the row above it, which is "what one more buys". Same 9-character column. |
| `ui/upgradeTip.js` TIP_COPY.run | Row heading over what the ability has actually done this run — damage, kills, or times it went off. Same 9-character column. |
| `ui/upgradeTip.js` TIP_COPY.dealt | Unit after a damage figure in that row: "412.1k ___". One word. |
| `ui/upgradeTip.js` TIP_COPY.kills | Unit after a kill count: "380 ___". One word, and it has to work at 1 as well as at 380. |
| `ui/upgradeTip.js` TIP_COPY.fired | Unit after a count of times a damageless ability went off — a beluga bubble, a charm, a freeze, a net haul: "7 ___". One word, same 1-and-many problem. |
| `ui/upgradeTip.js` TIP_COPY.capped | Replaces the whole "next" row on a stack that has hit its maxStacks. Says "there is no next one", not "this is broken". One or two words. |
| `ui/upgradeTip.js` TIP_COPY.quiet | Fills the "this run" row when the ledger has a zero for an ability the player IS holding. It is a real fact and the tip says it out loud rather than hiding the row — so it should read as an honest nothing, not as an error. Two or three words. |
| `ui/ui.js` STRIP_LABEL_BUILD_ONLY | The heading over the rail on the score screen, on a run where no boss died. "Kill shots" is yours and is untouched on every run that HAS them; this is the same rail holding only the hive. Two or three words. **Worth a second look:** now that the hive sits to the right of the last polaroid, "Kill shots" describes only part of the rail even when there are kill shots — you may want to change that one too. |
| `ui/ui.js` HIVE_SLOT_LABEL | The screen reader's name for the hexagon block on the rail, and the button's accessible name. Read aloud in place of a picture, so it has to say what the thing is AND that pressing it opens it. One short phrase. |
| `ui/ui.js` #svHiveViewClose aria-label | Screen-reader name for the X that closes the expanded build. The one beside it says "Close the preview"; this closes the build. |
| `upgrades.csv` biolumShock / biolumVenom / biolumChill / biolumInfection `.name` | The four element cards, which used to be one card ("Glow Up!!") that rolled which element it was offering. Now you pick the element by picking the card, and taking one locks the other three out of the run. The element LABELS are already yours — Voltaic, Venom, Chill, Infected, in `CONFIG.biolum.elements` — and each card's desc is that element's own desc, so this is four card names and nothing else. They sit next to each other in a hand of three, so they want to read as one family with four members. `perLevelName` is on, so the stack number is appended: whatever you write becomes "<name> 2" at two stacks. |
| `config.js` biolum card `name` template | The same four names, as the fallback the CSV overrides. Write the CSV rows and this can become anything non-draft — it is only reached if a row is deleted. |
| `systems/settings.js` SCHEMA.hud.upgradeTips | The pause-menu row: a label, a hint under it, and three option names for off / short / full. Short is the name and what the next stack does; Full adds the running total and what the ability has done this run. Label fits one line at 375px. |
| `systems/settings.js` SCHEMA.hud.boostMeter option `both` | Third option name on the Boost meter row, beside "Ring on the seal" and "Beside the air". Means both drawings at once — the wheel around the seal AND the column beside the air gauge. Sits in the same option pill as the other two, so one or two words. |
| `upgrades.csv` projectileLife.weaponName | The gun's rename while André 3000 is held, in place of "Fin Pebbles". The card no longer pierces anything — it makes every projectile stay in the water longer — so "Piercing Pebbles" is now false and is staged as `[DRAFT] Piercing Pebbles`. Same shape as the others in that column ("Rapid Pebbles", "Swift Pebbles"): one adjective plus "Pebbles". |

## `savedAs` — the desktop save confirmation

`path/src/ui/ui.js`, both `told()` maps in the trophy/sheet rows (search
`savedAs`). Staged as `[DRAFT] Saved`.

The status line after the desktop build's save dialog closes and a file has been
written. It sits beside the existing outcomes for that row:

- `shared` — "Shared"
- `saved` — "Saved to your downloads" (the browser download path)
- `opened` — "Opened — press and hold the picture to save it"

What it has to convey: the picture is on disk, at the place the player just
chose. Distinct from `saved` above, which has to name the downloads folder
because nobody picked it. Roughly one to four words — it replaces a short status
line under a button row on the score card, not a sentence. Seen right after the
save dialog closes.

## Flippers Up! — the two side words

`CONFIG.upgrades.flippersUp.sideNames` in `path/src/config.js`, staged as
`[DRAFT] Left` / `[DRAFT] Right`.

The card feeds one flipper per pick and its title says which: "Flippers Up!
<word>". One word each, sitting immediately after an exclamation mark, on a
card the player is scanning against two others — so it has to read as an
answer to "which one" at a glance rather than as part of the name. Seen on
the level-up card and in the hive tip.

## Flippers Up! — the run summary's section heading

`FIN_PANEL_TITLE` in `path/src/ui/ui.js`, staged as `[DRAFT] Flippers`.

Heads the left/right split under the Weapons table on the end-of-run card,
beside a "12.4k dealt" figure. It sits under a heading already reading
"Weapons", so it has to say that this is that same damage sliced by which
flipper threw it — one or two words, same register as "Weapons" and "What
hurt you". Only shown on runs that took the card.

The two side words themselves are `sideNames` above; the summary reads them
from there, so writing those once covers the card and the summary both.

## Two returning hellos that do not name the dead seal

`returncause` and `returnplain` in `path/src/greetings.csv`, staged as lorem.

Every other `again` line in that file spends `{departed}`, which is exactly the
state greetingTable.js's step 4 warns about: a death filed with no name on
record — an old save, a browser that stored nothing — leaves the returning pool
empty, and the pool falls all the way back to the first-run lines. A player on
their fiftieth run gets "First time, {player}?".

So these two are the ones kept back for that case, and they must NOT name the
seal:

- `returncause` spends `{cause}` and `{player}` only. It is what a player who
  died to something the file has no written line for sees, so it has to work
  for every label in deathCauses.js — "a shark", "the small fry", "running out
  of air", "a lightning strike" all have to read in the same sentence. One
  line, under 115 characters once both chips are spent.
- `returnplain` spends `{player}` alone: no death to refer to at all. This is
  the hello for somebody who restarted mid-run rather than dying, which is
  also the case where "Hello {player}!" is currently being said to a returning
  player. Same length budget.

Both are `when=again`, untagged, and are seen at the top of a run on the coach
band.

## Iron Lung now reads the bar, not the tank

The mechanic changed: the bonus scales with the oxygen the seal is CURRENTLY
holding, so it peaks on a fresh breath and bleeds to nothing by the time you
have to surface. Widening the tank raises that ceiling and buys more seconds
near it, so Deep Lungs is still the pairing.

Two lines that described the old behaviour:

- `ironLungLevel`'s `unlock` in `path/src/statText.csv`, staged as lorem. It
  read "damage with your maximum oxygen", which is now the wrong word. First
  pick of the card reads this, so it has to carry the whole idea in one short
  phrase — 4-7 words, same length as the line it replaces.
- The built-in `desc` on the `ironLung` entry in `path/src/config.js` reads
  "All damage scales with the size of your lungs". NOT staged, because
  `upgrades.csv` overrides it with `{effect}` and nothing renders it today —
  it is the fallback if that row is ever cleared. Left as-is rather than
  half-rewritten; worth a pass when you do the statText line, since the two
  should agree.

`ironLungBonus`'s label ("damage bonus") is unchanged and still reads fine, but
the number behind it is now measured AT A FULL BREATH rather than being a
constant. If the tip should say so, that row's `label` is where.
