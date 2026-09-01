# Copy waiting to be written

Lines Claude staged as lorem ipsum because they needed to exist for a feature
to be testable. Each one is a brief, not a draft — replace the lorem in the
listed file with your own words and delete the entry.

`npm run test:copy` lists everything still outstanding and blocks `npm run
ship` until this is empty.

Rows in a CSV that has a `notes` column carry their brief there instead, and
that is now most of them — the screen labels that used to be string constants
in `ui.js`, `settings.js`, `upgradeTip.js` and `config.js` are rows in
`path/src/uiText.csv`, so their briefs are in that table's `notes` column and
the CSV editor's "needs your words" chip can find them. What is left here is
the handful that still has nowhere else to live.

| where | what the line has to do |
| --- | --- |
| `upgrades.csv` biolumShock / biolumVenom / biolumChill / biolumInfection `.name` | The four element cards, which used to be one card ("Glow Up!!") that rolled which element it was offering. Now you pick the element by picking the card, and taking one locks the other three out of the run. The element LABELS are already yours — Voltaic, Venom, Chill, Infected, in `CONFIG.biolum.elements` — and each card's desc is that element's own desc, so this is four card names and nothing else. They sit next to each other in a hand of three, so they want to read as one family with four members. `perLevelName` is on, so the stack number is appended: whatever you write becomes "<name> 2" at two stacks. |
| `upgrades.csv` projectileLife.weaponName | The gun's rename while André 3000 is held, in place of "Fin Pebbles". The card no longer pierces anything — it makes every projectile stay in the water longer — so "Piercing Pebbles" is now false and is staged as `[DRAFT] Piercing Pebbles`. Same shape as the others in that column ("Rapid Pebbles", "Swift Pebbles"): one adjective plus "Pebbles". |

## Moved into `path/src/uiText.csv`

The upgrade tip's row headings and units, the score screen's build-rail
heading and its two screen-reader names, the desktop save confirmation
(`savedAs`), the pause menu's clap action, boost-meter and upgrade-tip rows,
and the two words Flippers Up! names a fin with — all of them were string
constants in four `.js` files, which meant the only place they could be
written was a source file and the CSV editor could not see a single one.

They are rows in `path/src/uiText.csv` now, each with its brief in that row's
`notes` cell. Open them the way every other line is opened:

```bash
npm run csv
```

Pick **Screen text** in the table list, or hit the `✎ needs your words` chip
to filter to every outstanding line across all eleven tables at once.

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

## Bubble Jet Stream — the card, and the words {effect} uses

A new upgrade. A held stream that snakes out of the seal's mouth — a spline
that lags behind your aim and carries a travelling wave, so a hard turn throws
an S down its length. It spools up, holds for about a second, vents, and does
it again; every stack lengthens the hold and shortens the gap, so by the cap it
is barely off. There is a synth bed underneath that ramps up and holds with it.

The reference is Raiden III's plasma beam: a thick, bright, wobbling line that
whips rather than points.

`upgrades.csv`, row `bubbleJet` — both staged as lorem:

- `name`. The card title. Two or three words. It is filed with Laser Eyes and
  Electric Eel, so it wants to sit alongside those rather than under them.
- `desc`. Flavour and then `{effect}` — the numbers are measured, so the prose
  half is one short clause. The thing worth saying is that it is HELD: every
  other weapon the seal owns fires and resolves, and this one stays on.

`statText.csv`, six rows staged with `[DRAFT]` markers rather than lorem, so
the phrase stays readable while it is wrong. Each row's `notes` column carries
its own brief; the short version:

- `bubbleJetLevel` — `label` and `unlock`. The unlock is what the FIRST stack
  reads as, so it has to announce a new weapon rather than a number going up.
- `jetHold` and `jetCool` — the pair that is actually the card. How long the
  stream is open, and how long the seal spends venting. They want to read as
  two halves of one idea, and `jetCool` is a lower-is-better row.
- `jetDamage` — per TICK of contact, ten times a second per body. The label
  should not imply a single hit.
- `jetReach`, `jetWidth` — length, and thickness (which is also its hit
  radius, so a fatter stream genuinely touches more).

The `bubbleJet` entry in `path/src/config.js` no longer states a `name` or a
`desc` at all. It used to carry a lorem pair as the fallback if the row were
ever cleared, which meant one line lived in two files and only one of them
ever rendered. A deleted row now surfaces as the id, loudly — see
`applyUpgradeTable` in `upgradeTable.js`. Nothing is owed here.

Nothing here has a hive icon yet, so the tile falls back to a monogram. That is
`tools/atlas-render/icons.json` and a separate job.

## Boss names for the four attractor perks

`path/src/bossNames.csv` — eight staged rows, a prefix and an epithet for each
of `saddle`, `ring`, `echo` and `release`. The brief for each is in that row's
own `notes`; the short version is that all four are a boss that opens a
chaotic FIELD around itself rather than firing something at you, so the
vocabulary wants to be about weather and water rather than about weapons:

- `saddle` — a butterfly-shaped field whose two lobes swap through the middle,
  where the boss is standing. The danger is the crossover.
- `ring` — a spinning ring with a hollow middle and a fast rim, worn by the
  animal. Safe in the hole or outside it, nowhere in between.
- `echo` — hands your own shots back as pairs that drift apart and arrive from
  two sides at once.
- `release` — draws its attack in the water first, then fires down the drawn
  line very fast. The drawing is the tell.

Each perk needs at least one part so the naming guarantee has something to
land on (`tools/boss-test.mjs` checks exactly that); more than one in a slot is
better, and a `solo` nickname row works too.

## What the gun is called on a fin-laser run

`path/src/upgrades.csv`, the new `weaponNameLaser` column — nine staged rows,
sitting beside the `weaponName` each one already has, plus a tenth card
(`homingShot`) that needs BOTH sides. The column exists
because a run now rolls its starting weapon (`CONFIG.loadout`), and the five
gun cards plus the four Glow Up!s all rename the gun while they are held.

`weaponName` on those rows is the PEBBLE name and stays exactly as it is. This
is the same card's rename when the seal is throwing light instead:

| id | on pebbles | needs |
| --- | --- | --- |
| `rapidFire` | Rapid Pebbles | its laser twin |
| `heavyRounds` | Giant Pebbles | " |
| `multishot` | Cloned Pebbles | " |
| `projectileLife` | Piercing Pebbles *(itself a draft)* | " |
| `velocity` | Swift Pebbles | " |
| `biolumShock` / `Venom` / `Chill` / `Infection` | `{element} Pebbles` | " — keep the `{element}` token, it fills from the run's own element label |
| `homingShot` | *(lorem — this one is owed too)* | **both columns.** The laser side is written — "Homing Lasers" — and the pebble side is staged. It is the odd one out because the row carried no weapon name at all until recently: the card is "Homing Pebbles", but what the LEDGER calls the gun while you hold it has never been written. |

A WHOLE NAME, not an adjective — nothing derives one column from the other, on
purpose: the word that differs between "Cloned Pebbles" and its laser
equivalent is not reliably the noun, and a rule that swapped one word would be
inventing half of every name.

Where it is read: the run summary's damage ledger and the boss kill polaroid —
"cause of death: <this>". It is the one place in the game that says out loud
what the run's build actually was, so it wants to sound like a weapon somebody
built rather than a category. Most recent pick wins when several are held.

An unwritten row falls back to the pebble name, so a laser run is captioned
with a name that is at least a name while these are outstanding. The base name
with no cards held is `CONFIG.loadout.types.<id>.label` — "Fin Pebbles" and
"Fin Lasers", both already your words.

## What one orca is called

`path/src/statText.csv`, the new `orcaCount` row — `[DRAFT] orca` in `label`,
`[DRAFT] orcas` in `plural`.

The Orca Family card buys a whale per stack now (three stacks, one each), so
the pod's size is worth a readout row for the first time — it used to be 3 at
every level. The number is measured; this is the noun it lands on:

> +1 more **orca**

Lowercase, no article, mid-sentence after a number — the same shape as
`escort`/`escorts` on the Seal Team row two screens down, which is the closest
existing line. "orca" is only the placeholder's shape: whale, pod member, or
anything else that reads as one animal out of three all fit.

Where it is read: the HOVER TIP's count line, beside the damage and cadence
rows, for the whole run.

### The card face is a different row, and it is already yours

What the card itself says on a second or third pick is measured off the
`orcaLevel` row, not this one, and today it renders:

> Boaterhaters: +1 orca family level

against Seal Team's "+1 escort seal". The difference is entirely in that row's
`label` (`orca family`) and `kind` (`level`) — a `label` of `orca` on `kind`
`count` would read "+1 orca". I have left it alone: it is your line and it was
correct before this change. Mentioning it because the card is the place the new
whale is most worth saying out loud.

### Two lines the same change has made slightly untrue

Neither is staged — both are yours already and I have not touched them:

- `statText.csv`, `orcaLevel` `unlock` — "orca buddies that hate yachts". That
  is what the FIRST stack reads as, and the first stack is now one orca.
- `upgrades.csv`, `orcaFamily` `desc` — "Boaterhaters: {effect}" is fine as it
  stands. The fallback desc in `config.js` still says "Three orcas hunt enemy
  boats", which is true of a completed family and not of a first pick; it is
  only ever shown if the CSV row goes missing.

## Mussel Barrage's level-1 card says a number that is now wrong

`config.js`, the `musselVolley` entry's `levelDescs[1]`:

> Full-charge strike fires 8 homing mussels at once

That 8 was already stale — `weapons.csv` had the level-1 barrage at 10 — and
the barrage now opens at **3 shells** and climbs to **10** across its five
stacks (3, 5, 7, 8, 10). It is your line, so I have not rewritten it.

The fix that would keep it from going stale again is to delete the override and
let the card fall through to `upgrades.csv`'s `{effect}`, which is measured off
`musselCount` and cannot drift. If the first-pick card is worth its own sentence
anyway, what it has to convey is: a barrage only happens on a FULL charge, and
it is a small handful of homing shells now that grows with stacks. One line,
card width, shown on the level-up screen the first time the card is offered.

## Zappy Club — a new club rider, seven lines waiting

The fourth club variant: every club hit throws a chain of lightning into the
crowd behind whatever it landed on. Mechanically it is the same `arcChain()`
Voltaic fires, handed the club's numbers — but it does **not** roll a chance
the way Voltaic does (a melee weapon that sometimes did its thing is one the
player cannot learn), it fires from *inside* a crowd rather than at the edge of
one, and its packet is a share of the swing, so the Driftwood level, a `damage`
roll and the Bouncer all move it. It rides the swing, the carom and the throw,
exactly as Boom Boom Club and Cold Snap do.

"Zappy Club" is a working name used in the code comments only — nothing the
player sees says it.

### `upgrades.csv`, row `clubZap`

- **`name`** — currently `Lorem Ipsum`. The card's title, sitting beside
  "Boom Boom Club", "Iced Out in the Club" and "Cold Snap". Card width, so
  roughly under 22 characters. The `desc` is `{effect}` and is measured, so
  the name carries all of the character.

### `config.js`, the `clubZap` upgrade entry

- **`levelDescs[1]`** — the first pick. What it has to convey: club hits now
  chain lightning to the fish behind what you hit. One line, card width, shown
  the first time the card is offered.
- **`levelDescs[2]`** — the second pick, which is where the rest of the club
  line puts its "another club on the ring around you — unless *this* is what
  your fins are holding" line. Same shape, same slot, same job.
- The `name` and `desc` are NOT here any more — they are `upgrades.csv`'s
  ("Electric Club") and are stated in one place only. `levelDescs` above is
  the exception because no table owns it: those two lines are read straight
  out of `config.js` and are the last of this card's copy still outstanding.

### `statText.csv`, four rows

These are UI labels rather than prose, so they are staged as `[DRAFT]` rather
than lorem — the real shape, marked so the gate can see it.

- **`clubZapLevel`** — `label` (`[DRAFT] club arc`) and `unlock` (lorem). The
  label is what the card says on a stack: "+1 *club arc*". The `unlock` is what
  the FIRST stack reads as instead, in the shape of `clubIceLevel`'s "chill
  your opps".
- **`clubZapDamage`** — `group` (`[DRAFT] zappy club`, the heading over this
  card's rows in the tip panel — it should be the card's name) and `label`
  (`[DRAFT] arc damage`). What the first body down the chain takes.
- **`clubZapArcs`** — `group`, `label` and `plural` (`[DRAFT] bodies hit`). How
  many bodies one chain may reach.
- **`clubZapRange`** — `group` and `label` (`[DRAFT] arc reach`). How far each
  hop looks for its next body, in metres.

Each row's `notes` column says what the number actually is, which is the part
worth reading before naming it.
