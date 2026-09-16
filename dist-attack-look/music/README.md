# Music loops

15 loops ship here by default — `747_Cocktails_Loop01.mp3` through
`Loop15.mp3` — and `CONFIG.music.defaultSrc` in `path/src/config.js` points
slots 1-15 at them. The music player preloads them on game start
(`preloadDefaultTracks()` in `path/src/systems/music.js`), so the game has
music with nothing else needed.

To swap one out, either drop a replacement file here with the same name, or
use the T-menu's Sound tab in-game (Upload button per slot) to replace it for
the current session only — session uploads aren't saved to disk.

If a default file 404s or fails to decode, that slot is just left empty and
skipped when picking which loop plays for the player's level — same
load-with-fallback pattern as `CONFIG.sfx`'s `src`.

## The three banks

The 15 numbered slots above are the RUN's music, picked by the player's level.
Two more banks live here and are picked by what the game is doing instead:

- `SealSurvivor_Boss_Loop00`–`Loop06` (`CONFIG.music.bossSrc`) — a boss fight.
  The first is an intro, played once per run; the rest rotate.
- `QueenOfRods_170BPM_Loop00`–`Loop07` (`CONFIG.music.versusSrc`) — a game of
  Blubberball. One step per GOAL: whatever is playing repeats until somebody
  scores, then hands over at the end of that pass. 00 through 07, back to 00.

Neither of these two banks can be edited from the T-menu — its rows are the
fifteen run slots — so `config.js` owns them outright and both are stripped
out of `imported-tuning.json` on load and on save. Add a loop by dropping the
file here and adding a line to the array in source; a copy in the snapshot
would replace the whole bank and make that line dead text.

All three play on the same transport, one at a time. The run library and the
boss bank are on a 2.265s bar (105.96bpm); the match bank is at 170bpm, so
`CONFIG.music.versusBpm` and `versusBarSeconds` sit beside it and are read off
whichever file is playing — see `barSeconds()` in `path/src/systems/music.js`.
