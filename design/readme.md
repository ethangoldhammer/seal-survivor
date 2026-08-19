# Seal Survivor — UI design bundle

The game's UI screens, extracted as standalone previews so they can be
edited visually in Claude Design and folded back into the game afterwards.

## What's here

| Path | Mirrors |
| --- | --- |
| `styles.css` | The `STYLES` template literal in `path/src/ui/ui.js`, verbatim |
| `components/splash.html` | `#svStartMenu` |
| `components/hud.html` | `#svHud`, `.sv-playerbars`, `.sv-toast-layer` |
| `components/levelup.html` | `#svLevelUpMenu` + the cards built by `showLevelUp()` |
| `components/gameover.html` | `#svGameOverMenu`, front face — `showGameOver()` + `renderBoard()` |
| `components/gameover-back.html` | The same card turned over — `renderRunDetail()` |
| `assets/*.webp` | The hex card art, unpacked from `path/src/ui/levelUpImages.js` |

## The round trip

`styles.css` is the surface that travels. It is the game's real stylesheet, so
edits made to it in Claude Design port straight back into the `STYLES` literal
in `ui.js` — same selectors, same order, same comments.

It is a **snapshot**, and `ui.js` is the original. Re-export before editing:

```
sed -n '104,1320p' path/src/ui/ui.js
```

(the body of the literal — everything between the opening backtick on the
`const STYLES =` line and the closing one) under the four-line header comment
at the top of `styles.css`. Those line numbers move — find the literal, don't
trust them. Porting from a stale copy does not merge, it *replaces*, so
anything added to `ui.js` since the snapshot is deleted by the port.

Each preview also has a small `<style>` block at the top marked
**"Preview scaffolding only"**. That block exists because the game paints this
UI over a live WebGL ocean: the panels are translucent, and their contrast only
reads correctly against a backdrop. It is *not* part of the game and must not
be carried back into `ui.js`.

Markup changes (new elements, reordered blocks) don't port automatically —
`ui.js` builds this DOM in JS, so those need a matching edit to `initUI`'s
`root.innerHTML` and to whichever function fills that block: `showLevelUp()`
for the cards, `showGameOver()` for the scorecard, `renderBoard()` for the
leaderboard, `renderRunDetail()` for the back of the card.

## Type on the role selectors is the fallback layer

`path/src/textRoles.js` names 21 selectors as **text roles**, and for those,
`font-size`, weight, colour and `text-shadow` in `styles.css` are **re-stated
at runtime** by `ui/typography.js` from `CONFIG.textStyles`, in a sheet
appended after this one:

```
.sv-title  .sv-sub  .sv-btn  .sv-hint  .sv-blob-label  .sv-lb-row  .sv-status
.sv-label  .sv-value  .sv-xptop-level  .sv-boss-name  .sv-card-name
.sv-card-desc  .sv-toast  .sv-toast-combo  .sv-chain  .sv-proc  .sv-callout
.sv-callout-coach  .sv-callout-boost  .sv-callout-strike
```

The family is not set anywhere in this file — `--sv-font` is only what the game
uses for the few frames before that module has run.

So type edits made on those selectors are edits to the fallback, not to what
ships: the shipping values live in the in-game Text panel (the `` ` `` tuner).
Everything else in the file ports normally, including type on any selector not
on that list, and including layout and geometry on the ones that are.

## Things the previews fake

- **Player bars.** In game these are positioned every frame from the seal's
  projected world position (`updateHUD`), and their fills are `--sv-fill`
  fractions written per frame. The HUD preview places three copies by hand to
  show the idle / hurt / low-oxygen states side by side.
- **Score toasts.** Driven by the game loop, not CSS animation, so they pause
  with the game. The preview shows three frozen mid-flight.
- **High score label.** `display:none` until the player has a score on record;
  shown in the splash preview so the state is designable.
- **Card art and overlay.** Which image lands on which upgrade is the `cardArt`
  column of `upgrades.csv`. The overlay tint is `overlayColor` /
  `overlayOpacity` (currently black at 0.55). The preview hardcodes three
  representative pairings.
- **Rarity and the deal.** `applyRarityStyle()` writes `--sv-ring`,
  `--sv-ring-w` and the two blur sizes per card from `rarities.csv` and
  `CONFIG.rarityCard`; `igniteCards()` then lights the slots one at a time,
  lowest tier first. The preview writes those properties by hand for three
  tiers and switches the ignition keyframe off, so every card sits at its
  resting bloom.
- **The card's height.** Both faces are `position:absolute; inset:0`, so the
  card has no height of its own — `sizeCard()` measures the taller face and
  writes it every time the screen opens. The two game-over previews set a
  height in their scaffolding block instead. Without one, both faces collapse
  to zero and the screen renders as nothing.
- **Which way up the card is.** `ui/cardFlip.js` writes `--sv-flip` (the
  angle), `--sv-grazing` and `--sv-sheen` while it turns, and moves `.sv-hidden`
  between the two faces. `gameover-back.html` parks `--sv-flip` at 180deg,
  which is the pose the flip lands on.
- **The kill-shot rack.** `.sv-trophy` carries `.sv-hidden` in game unless a
  boss actually went down; the previews show it so the button row is
  designable. The prints inside it are canvases built by `ui/snapshotPrint.js`,
  which has its own stylesheet — `.sv-fan` is left empty here.
- **Fonts.** `styles.css` pulls Inter from Google Fonts via `@import`. If the
  Design pane blocks that, previews fall back to `system-ui` and metrics will
  drift slightly from the real game. See also the section above: the family the
  game actually uses is written by `ui/typography.js`, not by this file.

## Styled here, but not previewed

`styles.css` is the whole stylesheet, so it carries rules for surfaces this
bundle has no preview for. Editing them is possible; seeing them is not.

- The boss banner (`.sv-bossbar`) and the upgrade hive (`.sv-hive-*`).
- The main menu's own leaderboard panel (`#svBoardPanel`, which re-uses
  `.sv-leaderboard` and `#svBoardList`).
- The corner placement for the player bars (`.sv-playerbars-corner`, the
  `settings.hud.barPlacement === 'corner'` option) and the `.sv-hud-barcorner`
  shift it makes to the score corner.
- The whole small-screen block at the bottom of the file — every rule under
  `@media (max-width: 700px)` and friends. `npm run layout` is what exercises
  those.
- Tap-target sizing, which rides the `.sv-touch` class rather than a media
  query, because it is a question about the player's hand and not their screen.

## Not in this bundle at all

These carry their own stylesheets and never touch `STYLES`: the pause and
settings menu (`ui/pauseMenu.js`), the kill-shot polaroids
(`ui/snapshotPrint.js`), the tip jar link (`ui/tipJar.js`), the `` ` `` tuner and
the Text panel (`ui/tuner.js`, `ui/textPanel.js`), and the loading screen
(`ui/loading.js`).
