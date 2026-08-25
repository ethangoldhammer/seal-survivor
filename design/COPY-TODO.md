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
| `systems/settings.js` SCHEMA.hud.upgradeTips | The pause-menu row: a label, a hint under it, and three option names for off / short / full. Short is the name and what the next stack does; Full adds the running total and what the ability has done this run. Label fits one line at 375px. |
| `systems/settings.js` SCHEMA.hud.boostMeter option `both` | Third option name on the Boost meter row, beside "Ring on the seal" and "Beside the air". Means both drawings at once — the wheel around the seal AND the column beside the air gauge. Sits in the same option pill as the other two, so one or two words. |
| `upgrades.csv` projectileLife.weaponName | The gun's rename while André 3000 is held, in place of "Fin Pebbles". The card no longer pierces anything — it makes every projectile stay in the water longer — so "Piercing Pebbles" is now false and is staged as `[DRAFT] Piercing Pebbles`. Same shape as the others in that column ("Rapid Pebbles", "Swift Pebbles"): one adjective plus "Pebbles". |
