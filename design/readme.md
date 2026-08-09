# Seal Survivor — UI design bundle

The game's four UI screens, extracted as standalone previews so they can be
edited visually in Claude Design and folded back into the game afterwards.

## What's here

| Path | Mirrors |
| --- | --- |
| `styles.css` | The `STYLES` template literal in `path/src/ui/ui.js`, verbatim |
| `components/splash.html` | `#svStartMenu` |
| `components/hud.html` | `#svHud`, `.sv-playerbars`, `.sv-toast-layer` |
| `components/levelup.html` | `#svLevelUpMenu` + the cards built by `showLevelUp()` |
| `components/gameover.html` | `#svGameOverMenu` + leaderboard rows |
| `assets/*.webp` | The hex card art, unpacked from `path/src/ui/levelUpImages.js` |

## The round trip

`styles.css` is the surface that travels. It is the game's real stylesheet, so
edits made to it in Claude Design port straight back into the `STYLES` literal
in `ui.js` — same selectors, same order.

Each preview also has a small `<style>` block at the top marked
**"Preview scaffolding only"**. That block exists because the game paints this
UI over a live WebGL ocean: the panels are translucent, and their contrast only
reads correctly against a backdrop. It is *not* part of the game and must not
be carried back into `ui.js`.

Markup changes (new elements, reordered blocks) don't port automatically —
`ui.js` builds this DOM in JS, so those need a matching edit to the
`root.innerHTML` template and, for the cards, to `showLevelUp()`.

## Things the previews fake

- **Player bars.** In game these are positioned every frame from the seal's
  projected world position (`updateHUD`). The HUD preview places three copies
  by hand to show the idle / hurt / low-oxygen states side by side.
- **Score toasts.** Driven by the game loop, not CSS animation, so they pause
  with the game. The preview shows three frozen mid-flight.
- **High score label.** `display:none` until the player has a score on record;
  shown in the splash preview so the state is designable.
- **Card art and overlay.** Which image lands on which upgrade is
  `CONFIG.levelUpCards.assignments`, set through the in-game `` ` `` tuner. The
  overlay tint is `overlayColor` / `overlayOpacity` (currently black at 0.55).
  The preview hardcodes three representative pairings.
- **Fonts.** `styles.css` pulls Inter from Google Fonts via `@import`. If the
  Design pane blocks that, previews fall back to `system-ui` and metrics will
  drift slightly from the real game.
