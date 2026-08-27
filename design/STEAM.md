# Shipping Seal Survivor on Steam

What the desktop build is, what still needs a human, and the exact strings
Steamworks needs. Working notes — not player-facing text.

## The commands

```bash
npm run desktop        # build dist-desktop and run the shell
npm run desktop:test   # build, then the shell and save suites
npm run pack:desktop   # electron-builder, into release/
npm run audit:offline  # every host the game could reach at runtime
npm run steam:status   # can this machine talk to Steam right now
```

`desktop:*` and `audit:*` are deliberately **not** named `test:*`. `tools/ship.mjs`
builds its gate list from every `test:*` script, so those names would block the
**web** deploy whenever `dist-desktop/` did not happen to exist.

## Why Electron rather than Tauri

Tauri uses the OS webview, which on Linux means WebKitGTK — the weakest WebGL
implementation of the three, and the Steam Deck is a Linux target. This game's
rendering leans on custom GLSL injection, a bloom composite, a metaball goo pass
and instanced quads. Electron ships its own Chromium, so what is tested is what
runs, on all three platforms. The bundle-size cost is irrelevant next to ~100MB
of models and audio.

Neither wrapper gets the **Steam overlay** — it hooks the process doing the GPU
work, and the webview renders in a separate sandboxed process. Achievements,
stats and Cloud are API calls and work fine; Shift-Tab, F12 screenshots and
overlay purchases do not. Plenty of web games ship this way. Do not advertise
overlay features.

## The depot is a directory, not an installer

`electron-builder.yml` targets `dir` on every platform, and that is the most
important decision in it. SteamPipe uploads a tree of files and Steam installs
them itself. An NSIS installer or DMG in a depot ships the player an installer
to run inside a game they already installed.

Depot layout after `npm run pack:desktop`:

```
release/mac-arm64/Seal Survivor.app     → macOS depot
release/mac/Seal Survivor.app           → macOS x64 depot
release/win-unpacked/                   → Windows depot
release/linux-unpacked/                 → Linux depot (Steam Deck)
```

`dist-desktop` is copied in as `Resources/dist`, because `electron/serve.js`
reads `process.resourcesPath/dist` when packaged. Those two must agree; they are
the only place the packaged and unpackaged paths differ.

It is `extraResources` rather than asar contents on purpose: ~100MB of already
compressed models and audio gains nothing from being archived, and Steam
delta-patches individual files between builds. In an asar, changing one model
re-downloads the whole blob.

`node_modules/steamworks.js` is `asarUnpack`ed because a `.node` binary cannot be
dlopen'd from inside an archive.

## Steam Cloud

The save is a single JSON file. `electron/save.js` owns it; `path/src` knows
nothing about it and still just uses `localStorage` (the preload hydrates and
snapshots across, which works because localStorage is per-origin and shared
between isolated worlds).

The directory comes from package.json's **`name`** field, not `productName` —
verified against a packaged build, and worth knowing because they differ here:

| platform | path |
| --- | --- |
| Windows | `%APPDATA%\seal-survivor\save.json` |
| macOS | `~/Library/Application Support/seal-survivor/save.json` |
| Linux | `~/.config/seal-survivor/save.json` |

Configure Cloud with root `WinAppData` / `MacAppSupport` / `LinuxHome`,
subdirectory `seal-survivor` (Linux: `.config/seal-survivor`), pattern
`save.json`.

Seven keys travel: player name, settings, tutorial progress, last run, the
buried-name ledger, the graveyard and the local leaderboard. Three are
deliberately excluded — the tuning snapshot (163KB of authoring state the game
seeds into localStorage itself), the playtest client id (syncing it would fuse
two machines into one analytics client) and the crash beacon (a fact about one
machine's last boot). Adding a key to `SAVED_KEYS` in `electron/save.js` is the
whole job of making something survive a reinstall.

## Achievements

`electron/steam.js` exposes the mechanism — `unlockAchievement(apiName)`, reachable
from the game as `window.sealDesktop.steam.achieve(name)`. **There is no roster,
on purpose.** An achievement's name and description are player-facing copy and
its condition is game design; both are Ethan's. The API names come from the
Steamworks partner site and must match exactly.

Steamworks stays switched off unless `SEAL_STEAM_APP_ID` is set. 480 (Spacewar,
Valve's public test app) is **not** a default — defaulting to it would mean a
build that reports achievements to somebody else's app whenever the real id went
missing. Opt in explicitly:

```bash
SEAL_STEAM_APP_ID=480 npm run steam:status
```

Every Steamworks failure is swallowed into "unavailable" so a run is never
interrupted by it, which means they all look identical from inside the game.
`npm run steam:status` is where they become distinguishable again.

## Still needs a human

**A Steamworks app id.** Everything above is inert without one.

**macOS signing and notarization.** `pack:desktop` currently signs with a local
*Apple Development* certificate and skips notarization. That launches on this
Mac and on no one else's — Gatekeeper refuses it, silently for the developer and
totally for everybody else. A macOS depot needs a Developer ID Application
certificate, notarization, and a stapled ticket. Needs an Apple Developer
account and credentials.

**Windows signing.** Not strictly required by Steam, but unsigned binaries draw
SmartScreen warnings.

**An app icon.** electron-builder is using the default Electron icon. It wants
`build/icon.icns` and `build/icon.ico`; `npm run icons:app` already generates
the iOS set from the splash art and is the obvious place to extend.

**A decision on phoning home.** The build still posts runs to `VITE_PLAYTEST_URL`
and scores to `VITE_LEADERBOARD_URL`. If a Steam build keeps either, the store
page needs a privacy disclosure. Both fail soft already.

**The share URL.** `config.js` and `systems/bossShot.js` put
`https://seal-survivor.pages.dev` in share text. A Steam build should say the
store page.

## Known dead weight in the desktop bundle

`dist-desktop/_headers` (a Cloudflare Pages directive) and `dist-desktop/spline/`
(the Spline name kit, unreachable now that the splash is aliased out) are copied
in from `public/`. About 32KB, harmless, worth excluding if the desktop build
ever gets its own `publicDir` filter.
