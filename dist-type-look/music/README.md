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
