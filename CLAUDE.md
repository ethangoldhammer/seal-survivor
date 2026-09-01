# Seal Survivor

## Copy is Ethan's, always

Claude does not write player-facing prose for this game. Not upgrade names,
not card descriptions, not epitaphs, quips, greetings, kickers, callouts, tip
labels, boss names, seal names, rarity names, or any UI string a player reads.
The voice of this game is one person's and AI-written copy does not ship in it.

**When a feature needs a string to be testable, stage lorem ipsum.** Never a
plausible-sounding placeholder — plausible copy is exactly what survives a
review and ships by accident. Lorem is unmistakable, and the gate below can
see it.

For a string that isn't prose (a UI label, a button, anything where lorem
would make the thing untestable), stage the real shape with a `[DRAFT]` marker
in it — `[DRAFT] Boost` — which fails the same gate.

**A screen label belongs in a table, not in a `.js` file.** `uiText.csv` is
the home for every string a player reads that no other table already owns — a
row heading in an upgrade tip, an option name in the pause menu, the word
after a kill count. The code asks for it by id (`uiText('finPanelTitle')`) and
a missing row shows the id rather than a blank, so the join cannot fail
quietly; `npm run test:uitext` fails on a read with no row and on a row with
no read. Before this table existed these lines were constants in `ui.js`,
`settings.js`, `upgradeTip.js` and `config.js`, and the editor's "needs your
words" chip — whose whole job is to gather every outstanding line onto one
screen — could not see a single one of them.

**Say what the line is for.** Lorem tells Ethan nothing about what to write.
Put the brief in that row's `notes` column; if the CSV has no `notes` column,
add a line to `design/COPY-TODO.md`. One sentence: what the line has to
convey, how long it can be, when the player sees it.

### The flag

The flag is **derived from the copy, never stored in a column**. A `draft`
column would be a second source of truth that goes stale the moment a line is
rewritten and the TRUE is left behind — and a row that claims to be a draft
after you have written it is exactly as useless as one that doesn't claim it.
Edit out the lorem and the flag is gone, because the flag *was* the lorem.

In the CSV editor (`npm run csv`) a waiting row carries an amber stripe and a
✎ in its id cell, the cell holding the placeholder is tinted amber, the table
picker shows `✎ n` beside any table with lines waiting, and a `✎ n needs your
words` chip in the toolbar filters to just those rows. All of it re-tests as
you type, so the flag clears on the keystroke that finishes the line rather
than at the next save.

### The gate

`npm run test:copy` fails while any lorem or `[DRAFT]` string is in
`path/src`, printing each one with its brief. It checks its own detector
first, so a regex that quietly stopped matching fails loudly instead of
turning the suite into a green light that means nothing.

`tools/ship.mjs` builds its gate list from every `test:*` script in
package.json, so this blocks `npm run ship` automatically — a draft line
cannot reach production, and `--no-verify` is the only way past it, which is a
deliberate decision rather than an oversight.

Green means every player-facing line in the build was written by Ethan.

## The review backlog

The rule above governs NEW copy. The 637 display-text lines that were already
in the game when it was written are a separate problem: git attributes every
commit to Ethan, so nothing records which of them he wrote and which arrived
from a session like this one.

So every one of them carries `review=TRUE` — a stored column in all eleven
copy tables, meaning *not yet signed off*, not *wrong*. Ethan clears a row to blank
once he has read the line and kept it or rewritten it. Over time the column
becomes the record that git could not give us.

The column sits **immediately after the copy it refers to** — `text,review` in
bossNames, `desc,review` in upgrades, `textPad,review` in callouts — not at the
end of the row. On the far side of six columns of numbers it is a flag you have
to go looking for; beside the line, the question it asks is next to the thing
being asked about. `tools/add-review-column.mjs` places it there and can be
re-run safely; it refuses rather than guesses if a table's copy columns ever
stop being adjacent.

This one is stored rather than derived, unlike the lorem flag, and that is the
honest choice: "has a person read this and kept it" is a fact about a person,
with nothing in the text to read it off. Blank is the default so a row Ethan
adds later is his by definition; a row Claude stages arrives as lorem and is
caught by the gate instead.

**It does not gate a ship.** These lines already ship and are already fine. A
gate over 637 rows would only teach the habit of passing `--no-verify`, which
would also disable the lorem gate that does matter.

```bash
npm run copy:review
```

Progress per table, and `npm run copy:review quips` lists one table's
outstanding lines. In the CSV editor the column reads "waiting on you" / "—
(yours)", the picker shows `○ 4/5` beside a table with lines unread, and a
slate chip filters to just those rows — a different colour from the amber
placeholder flag, because an urgent handful and a long calm list should never
look alike.

Claude does not clear these rows, and does not rewrite an existing line to
"improve" it. The backlog is a reading list for Ethan, not a work queue for
Claude.

## Card effect wording

`{effect}` on an upgrade card is half measurement, half English, and the two
live in different files on purpose.

The **number** is measured: `measure()` replays the upgrade's own `apply()` and
reports what actually moved, so a card can never promise a multiplier config.js
stopped delivering. Never type a number into a card description — write
`{effect}` and let it be measured.

Every **word** is `path/src/statText.csv` — one row per stat, with `label`,
`plural`, `unlock` (what the first stack of an ability reads as), and a
`template` column that rewrites a phrase outright when the four standard shapes
are wrong:

| template | renders |
| --- | --- |
| *(blank)* | `+25% fire rate` |
| `{label} up {n%}` | `fire rate up +25%` |
| `{+n} more {noun}` | `+2 more orbiting shrimp` |

`{n} {n%} {+n} {label} {noun} {unit} {from} {to}` all fill from the same
measurement, so an override can restate the number but never invent one. A
blank template, or one that renders empty, falls back to the standard shape.

It is "Effect wording" in the CSV editor. Three columns invert the usual
convention — `lower`, `bare` and `percentOfOne` treat **blank as NO**, because
`parseBool` reads a blank as TRUE and that would flip fireRate's sign on every
card. `npm run test:text` covers the parser and the template tokens.

### What is not covered

`notes` columns, `design/`, `tools/`, comments and commit messages are working
text, not copy — write those normally.
