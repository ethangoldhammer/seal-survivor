# Seal Survivor

A survivors game set in a vertical slice of ocean, where every shot kicks you
backward — aiming is how you steer. Three.js + Vite, no other runtime
dependencies.

The playfield is a side-on cross-section: the water surface sits 20% down the
screen, air above it, seabed below. Gameplay is a plain 2D plane, exactly as it
was overhead — only the framing and the model orientation changed. Flip
`CONFIG.view` to `'topDown'` to go back; no asset edits needed.

```bash
npm install
npm run dev
```

## Deploying

The public build is **https://seal-survivor.pages.dev**, on Cloudflare Pages.

**Pushing to `SealSurvivor-Main` deploys it.** There is no separate publish
step: `.github/workflows/deploy.yml` builds on every push and uploads `dist/`,
which takes a minute or two. So the normal loop is edit, check with
`npm run dev`, commit, push.

Deployed builds ship without the authoring UI — no `` ` `` tuner, no T panel, no
G/B overlays, no P/X/N debug keys. Adding `?tune` to the URL brings them all back,
so tuning against the live build still works without a rebuild.

Two escape hatches, for when git isn't the right path:

```bash
npm run deploy          # build + publish to production, no commit
npm run deploy:preview  # same build to preview.seal-survivor.pages.dev
```

`deploy:preview` is the safe one — it publishes to a separate URL and leaves the
live site alone. Plain `npm run deploy` works but leaves the repo out of sync
with what's deployed, so it suits an urgent fix rather than daily use.

### What pushing does NOT cover

**The leaderboard worker deploys separately.** It is its own Cloudflare Worker
and the Pages pipeline never touches it. After changing
`server/leaderboard-worker.js`:

```bash
cd server && npx wrangler deploy
```

**Tuning done on the deployed site never comes back.** Under `?tune`, a
production build saves to that browser's localStorage only — it cannot write to
disk, by design (see the note on the tuning endpoint in `vite.config.js`). Use
the live build to *find* values on a phone or a shared link, then re-enter them
under `npm run dev`, which writes `path/src/imported-tuning.json`, and commit
that like any other change.

**New assets have to be committed.** Everything in `public/` is copied verbatim
into the build, but only if git knows about it. A model or sound added through
the in-game T panel lands on your disk, not in the repo.

### Checking a deploy

The repo's Actions tab shows every run. When one fails, *which step* failed is
the useful signal: `npm ci` or `npm run build` failing is a real code problem,
while a failure only at the wrangler step is almost always the
`CLOUDFLARE_API_TOKEN` secret.

One Cloudflare quirk worth knowing when an asset misbehaves on the deployed
site: a missing file does not 404. Pages falls back to `index.html` and returns
**200 with `content-type: text/html`**, so a bad asset path surfaces as a loader
failing to parse rather than as a missing file. Check the content type, not the
status code. Locally, `python3 -m http.server` inside `dist/` gives an honest
404 for the same miss.

## Tuning the mechanics

Every gameplay number lives in **`path/src/config.js`**. No other file hardcodes
balance. Edit a value, save, and Vite hot-reloads.

For faster iteration, press **`` ` ``** in game to open a tuning panel. Sliders
write straight into the live config, so changes land on the run in progress —
including on a ship that's already picked up upgrades. When something feels
right, hit **Copy values** and paste the result back into `config.js`.

To add a slider for any value, add one line to `TUNER_SCHEMA` at the bottom of
`config.js`:

```js
{ path: 'weapon.pierce', min: 0, max: 8, step: 1 },
```

That's the whole wiring. The panel builds itself from the schema.

## Playtesting: is it actually balanced?

Guessing whether the difficulty ramp is too steep, or whether one upgrade is
carrying every run, is what the balance panel is for. Every run records itself
— damage dealt per ability, damage taken per creature, enemy hp arriving per
second, and how close to death you played — and the recording is turned into
verdicts you can act on.

Press **`B`** in game for the panel: *This run* updates live, *Last run* has the
verdicts for the run that just ended, *All runs* pools everything this browser
has kept. A one-line summary is also logged to the console on every death.

With `npm run dev` running, each finished run is appended to
`playtest/runs.jsonl`. Once a few have piled up:

```bash
npm run playtest
```

```
  min  runs  clear rate      in/min  hp%
    0     6  2.4x #######.....    0.31  86%
    5     6  1.4x ####........    0.94  61%
   10     4  0.6x ##..........    2.20  34%

  ability            damage   share  return  per stack-min  runs
  Sea Garlic          19608    49%   1.64x           1956     5
  Peashooter          13518    34%   0.75x            891     6

!! [4/6 runs] Enemy hp arrives faster than you can clear it from 10:00 on.
```

Two numbers do most of the work:

* **clear rate** — damage you deal per second ÷ enemy hp arriving per second.
  Above 1 you're emptying the arena, below 1 it's filling up regardless of what
  your health bar says. Watch where it crosses.
* **return** — an ability's share of the run's damage ÷ its share of the
  upgrade picks spent on it. 1.0x is pulling its weight; 2.2x or more gets
  flagged as overtuned, 0.45x or less as a dead pick. Measured in
  stack-*minutes*, so a pick taken at minute nine isn't judged as if it had
  been there all run.

`--last N`, `--since <date>`, `--runs` (full per-run reports) and `--json` all
work. Runs recorded under different `spawn.ramp` values are reported separately,
because they aren't the same game.

Where things live: `systems/playtest.js` records, `systems/playtestAnalysis.js`
judges (pure functions, no imports — the panel and the CLI both run it, so they
can't disagree), `ui/playtestOverlay.js` draws. The thresholds every verdict
turns on are the `BALANCE` object at the top of the analysis file — they're
judgement calls, so tune them.

### The food chain

Fish spawn as schools and move by boids rules — cohesion, separation,
alignment — plus a drift toward the player and a panic response to nearby
predators. Sharks roam alone, break off to chase any fish within `preyRadius`,
and eat them on their own; each meal heals a shark and makes it slightly bigger.

That means leaving a school alive feeds the sharks hunting it, so clearing fish
early is a real decision rather than free XP. All of it is tunable from
`CONFIG.enemies.fish.swarm` and `CONFIG.enemies.shark.hunt`, with sliders under
"The school" and "Sharks" in the tuning panel.

Two spawn controls keep this from running away:

- the wave budget counts *creatures*, not spawn events, so a school of 12 costs
  12 — a schooling species can't quietly multiply the spawn rate
- `maxConcurrent` caps any one species (sharks default to 6, so they stay a
  threat rather than a crowd)

### Adding an enemy

Add a key under `CONFIG.enemies` and it starts spawning. Nothing else changes:

```js
sniper: {
  asset: 'enemyShooter',      // which entry in assets.js to draw with
  behavior: 'keepDistance',   // 'chase' | 'keepDistance' | 'orbit'
  keepDistance: 16,
  radius: 0.5, hp: 14, hpPerDifficulty: 3,
  speed: 2.5, contactDamage: 6, xp: 8, spin: 1,
  weight: 0, weightPerDifficulty: 0.04, maxWeight: 0.3,
  minDifficulty: 3,           // stays out of the first minute
  shoot: { interval: 2.4, range: 26, damage: 14, speed: 18, life: 3, radius: 0.15 },
},
```

Spawn odds are weighted: `weight + weightPerDifficulty × difficulty`, clamped by
`maxWeight`. Difficulty rises 1.0 every 20 seconds by default.

Three things can hold a creature back, and they ask different questions:
`minDifficulty` asks how long the run has gone on, `minPlayerLevel` asks how
strong the seal is, and the `bioluminescent` column of `enemies.csv` asks what
time it is. It is the only one of the three that can go back to "not yet",
because morning comes.

Sunset swaps the **cast**, not just the light. `CONFIG.spawn.nightlife` runs two
curves over one ramp: creatures tagged `bioluminescent` fade in as it gets dark,
and everything else drops to `daylight.night` (0.08) of its usual weight. The
spawner draws a fixed budget per tick and normalises over whatever weight it
finds, so suppressing the day roster doesn't empty the night — it makes the same
number of bodies be different bodies. Measured: **~55% of spawns and ~60% of
bodies on screen** glow after dark, against a ceiling of 73% set by the glowing
roster's own `maxConcurrent` (45 + 4 + 2). One curve alone got 13%, which reads
as an unchanged ocean with a few lights in it.

Every apex predator is untagged, so `daylight.night` doubles as "how much of the
shark population survives sunset" — turn it up to keep nights dangerous in the
ordinary way, or tag a predator instead, which is what `abyssShark` is.

To look at the glowing variants without waiting for the spawner to offer them —
the rarest is two per arena behind a level gate — press **`N`** in game. It puts
one of each tagged creature in a row beside the seal and logs the hour, so you
can compare the presets side by side. Judge them after dark: the glow is
additive, so in daylight they read as dark fish.

"What time it is" starts as the player's own: the clock opens at the device's
local time of day (`dayNight.startFromSystemClock`) and then runs forward at
`scale × rate` from there, so a session that starts after dark starts with the
glowing schools already out. Only the opening hour comes from the wall clock —
a game day is minutes long, and pinning it to a real one would stop the sky.

Behaviors are `'chase'`, `'keepDistance'`, `'orbit'`, `'swarm'` and `'hunt'`.
New ones go in the `BEHAVIORS` map in `path/src/entities/enemies.js` — write a
function that sets a desired velocity, reference it by name.

### Adding an upgrade

An upgrade is split in two: what it **does** is code, what it **says** is data.

The behaviour is one entry in `CONFIG.upgrades`. Upgrades are pure functions
over the derived stat block:

```js
{ id: 'wideShot', name: 'Scattergun', desc: '+40% spread',
  apply: (s) => { s.spread *= 1.4; }, maxStacks: 3 },
```

Stats are rebuilt from config and replayed in order every time anything changes,
which is why tuning a base value updates an in-progress run correctly instead of
compounding.

Then add a row to **`path/src/upgrades.csv`** with the same `id`. That file is
the source of truth for the display fields, and it overwrites whatever the
config entry says — the values above are only the fallback for an id the CSV
doesn't mention. See [Editing upgrades](#editing-upgrades).

### Editing upgrades

**`path/src/upgrades.csv`** — one row per upgrade, edited in a spreadsheet, any
text editor, or `npm run csv`. Save the file and reload the page; the values
are live.

`npm run csv` serves a grid of all three tables at
[localhost:5177](http://localhost:5177), with the columns typed: `cardArt` is a
picker showing the thirty real hex images, `enabled` and `bioluminescent` are
dropdowns, `spawnGroup` offers the groups that exist while still letting you
type a new one, and a number the game would reject turns red before you save
rather than warning in the console after. It reads those rules out of
`enemyTable.js` and `config.js` at startup, so it cannot drift into enforcing
something the game does not, and it writes only the cells you changed — an edit
is one line in the diff.

| column | meaning |
| --- | --- |
| `id` | must match an id in `CONFIG.upgrades`. The join key. |
| `name` | card title. Blank keeps the built-in name. |
| `desc` | card body text. Blank keeps the built-in description. |
| `maxStacks` | how many times it can be taken. **Blank means unlimited.** |
| `enabled` | `FALSE` removes it from the offer pool. Blank means enabled. |
| `cardArt` | a level-up image key, or blank for the plain card background. |
| `sfx` | a key from `CONFIG.sfx`, played when this card is **taken**. Blank uses the shared level-up sound. |

#### `{placeholders}` in a description

`desc` is a template. `{effect}` does not hold a copy of the number — it RUNS
the upgrade's own `apply()` and describes what actually moved, so a card and
the code behind it cannot disagree:

```
desc: "{effect}"                 ->  "+25% fire rate"
desc: "Bullets pierce {effect}"  ->  "Bullets pierce +1 enemy"
desc: "Shrimp go round: {effect}" -> "Shrimp go round: +3 orbiting shrimp"
```

Change `s.fireRate *= 0.75` to `0.7` and every card, tooltip and Upgrades-tab
row that quotes it changes too. The last example is the one that shows why this
is measured rather than parsed: Shrimp Ring's first pick opens the ring at
`CONFIG.shrimpRing.baseCount`, and `{effect}` reads the branch that actually
ran rather than the `+1` the other stacks give.

| token | resolves to |
| --- | --- |
| `{effect}` | what this card grants, measured. Stack-aware — the 3rd Coiled Spring quotes the 3rd stack. |
| `{effect:2}` | the same for a specific stack number. |
| `{total}` | everything the stacks you own add up to, including this one. |
| `{name}` | the card name from the `name` column. |
| `{level}` | which stack this card would be. 1 for the first. |
| `{owned}` | how many you already have. |
| `{stacks}` | the `maxStacks` cap, or "unlimited" when blank. |
| `{cfg:weapon.damage}` | any number from `CONFIG`, so a tuned value quotes itself. |

A token that isn't one of these is **left on the card** as literal
`{whoops}` and warns, because a blank where a number should be reads as a
rendering bug while the token spelled out points at the cell with the typo in
it. `npm run csv` shows the resolved line live under the cell as you type it,
at both the first card and the last stack.

Nothing in the game writes back to it, so it's yours to edit freely — the
Upgrades tab of the **T** panel is a read-only view of what the file loaded,
there to confirm an edit landed. Mistakes are loud rather than silent: an id
that matches no upgrade, an unknown `cardArt` key, a non-numeric `maxStacks`
and a duplicated row each log a console warning and fall back to a safe value.

Two things stay in `config.js` because they don't flatten into a row:
`perLevelName` (numbers the card by stack — "Seal Team 1", "Seal Team 2") and
`levelDescs` (a different description at a given stack, used to announce an
evolution).

## Swapping assets

**`path/src/assets.js`** is the registry — one entry per visual thing. Each entry
can carry *both* a 3D model path and a procedural fallback shape. If the model
loads it wins; if it's missing or broken the game logs a warning and uses the
shape. A bad asset never breaks the build.

### Using a 3D model for the ship

Drop a `.glb` or `.gltf` into `public/models/`, then point the entry at it:

```js
ship: {
  model: '/models/seal.fbx',   // .glb, .gltf and .fbx all work
  fit: 2.6,        // longest axis becomes 2.6 world units
  forward: '+Z',   // which MODEL axis points the way it travels
  up: '+Y',        // which MODEL axis is its back/top
  tint: null,      // hex to override the model's own colour
  shape: 'cone', radius: 0.7, height: 1.6, color: 0x7ad7ff,  // fallback
}
```

`forward` and `up` describe the model itself, not the camera. The game maps them
into view space based on `CONFIG.view`, so switching between the side and
top-down views needs no asset edits. The loader recentres the pivot and
auto-scales to `fit`, so model scale and origin in your DCC tool don't matter.

To find a model's axes, load it and see which way it points; the four included
models are `seal.fbx` (+Z), `shark.glb` (+Z), and `fish.glb` (-X), all `up: '+Y'`.

In the side view, creatures are mirrored about their forward axis when heading
left, so they never swim belly-up.

See `public/models/README.md` for the orientation cheat-sheet.

Same pattern for enemies: set `model` on `enemyChaser`, `enemyBrute`, and so on.
Keep enemy models low-poly; hundreds can be on screen at once.

Models render with real lighting (`CONFIG.lighting`), while the built-in neon
shapes are unlit. Set `unlit: false` on an asset entry if you want a procedural
shape lit too.

## Juice

Every impact, kill, pickup, bounce and surface breach runs through one
dispatcher. `CONFIG.feedback` has an entry per event, and each entry names the
particle burst, screen shake, hit-stop, grid ripple, sound and haptic pattern it
fires. Adding a new event means adding a key there and calling
`feedback('name', { x, y })` — gameplay code never touches any of those systems
directly.

- **Warp grid** — a Geometry Wars backdrop. Ripples are pushed into a uniform
  ring buffer and resolved in the vertex shader, plus a constant pull from the
  ship's wake, so nothing is simulated on the CPU.
- **Particles** — one draw call for the whole game. Points store an origin,
  velocity, drag and spawn time; position is solved from age in the shader.
  Named bursts live in `CONFIG.emitters`.
- **Sound** — synthesised from `CONFIG.sfx`, so there are no audio files to
  ship. Set `src` on an entry to point at something in `public/sfx/` and it's
  used instead; if that file is missing the synth takes over, exactly like a
  missing model falls back to a shape.
- **Haptics** — a `vibrate` pattern per event, guarded for browsers that block
  it.

Hit-stop is deliberately rare: it's rate-limited and reserved for big kills and
taking damage, because wiring it to every bullet impact left the game running at
23% slow-motion. Shake is clamped for the same reason.

### Taking damage

The one event that does *not* get called directly is `playerHit`. Damage to the
seal goes through `systems/playerDamageFx.js`, because damage arrives in two
shapes that look identical at the call site: a bullet is one number on one
frame, while contact with a body is a *rate* — `combat.js` hands over
`contactDamage * dt`, so a megalodon's 42/second shows up as 0.7 on a 60fps
frame. Any threshold on a single call is therefore really a question about
framerate, which is how every creature in the game used to be able to eat you in
complete silence.

So damage accumulates instead, and the pile is spent as one hit once it's worth
showing — capped to one hit every `fx.playerDamage.minGap`, so swimming into a
school reads as solid repeated hits rather than forty overlapping copies of the
same sound. Everything downstream is scaled by the **fraction of the health bar
lost**, not by raw damage: max HP moves a long way over a run, and 20 damage at
300 HP is not the emergency the same 20 was on wave one. That one number drives
the shake, the spray, the ripple, the bloom pulse and the volume of the grunt.

The seal's outline flashes red alongside it (`playerOutline.hit`) — full red on
any hit whatever its size, because a rim only part of the way to red just reads
as an off-colour outline, with the *brightness and duration* carrying how much
it cost. `npm run test:damagefx` drives all of it headless, including every
contact rate in the roster at 30, 60 and 144fps.

The damage shake is one of the smallest numbers in `CONFIG.feedback` on purpose:
it gets multiplied by a 0.35–2.0 scale before it lands, and that range only
exists *below* `fx.maxShake`. Anything that hits the ceiling on an ordinary hit
is a constant rattle with the scaling quietly clamped out of it.

## Water

The ocean fill is one shader, not a flat rectangle: a three-stop depth
gradient (`colors.waterShallow` / `waterMid` / `waterDeep`, with
`colors.zoneStops` setting where each blend lands), procedural caustics
(`CONFIG.caustics`), and light beams from the surface (`CONFIG.godrays`). No
textures — caustics are three interfering sine waves, beams are a handful of
soft vertical bands that sway and fade with depth. All of it, plus the sky,
seabed and grid colours, is under **Ocean colors** and **Caustics & light
beams** in the tuning panel, with real colour pickers for anything that's a
colour. Sliders and swatches apply every frame with no rebuild, so dragging
them is instant.

## The full roster

17 enemy types now, grouped by role:

- **Predators** (`behavior: 'hunt'`, eat prey-tagged fish automatically):
  shark, otter, great white, megalodon, mighty megalodon
- **Schooling prey** (`behavior: 'swarm'`, `prey: true`): fish, trout, tang,
  reef fish, school pod (a pre-animated mini-school spawned as one bigger
  unit), and three more split out of one bundled file via `meshIndex`
  (fishPackA/B/C — see below)
- **Seabed dwellers**: walking crab and animated crab (`behavior: 'crawl'`),
  crab claw trap (`behavior: 'trap'` — new)
- **Original abstract shapes**: chaser, shooter

### New behaviors

- **`crawl`** — stays within `crawl.groundHeight` of the seabed regardless of
  where the player is, chases when close, ambles otherwise. Used by the
  walking crab and the animated crab.
- **`trap`** — stationary, bites in a fixed radius on a cooldown when the
  player is close, timed with a one-shot attack animation rather than the
  continuous idle/swim/boost loop. Used by the crab claw.

### Splitting one file into several assets

`lowpoly_fish_pack.glb` bundles three distinct fish in one scene. `meshIndex`
on an ASSETS entry keeps only that one mesh and prunes the rest at load time,
so `fishPackA` / `fishPackB` / `fishPackC` all come from one file:

```js
enemyFishPackA: { model: '/models/fishpack.glb', meshIndex: 0, fit: 1.0, ... },
```

## Animation clip reuse

Several of the new creatures ship exactly one clip covering their whole
motion (the seal, otter, tang, mighty megalodon). Rather than looking robotic
on two of three states, idle/swim/boost all play THAT clip at different
speeds (`CONFIG.animation.states.<state>.clipTimeScale`) — a standard way to
stretch one locomotion cycle across speed tiers.

The walking crab is the clearest case: one 3.3s walk cycle, no mapping, so
idle/swim/boost are the same cycle at 0.45x / 1.0x / 1.4x.

Where a model ships a genuinely distinct clip per state (megalodon's
"Swim"/"Swim Fast", trout's normal/fast), that state plays its own clip at
normal speed instead — the
speed-scaling only kicks in for states that are actually *sharing* one clip,
so an authored sprint animation never gets doubled up with extra speed on
top of already being fast.

## The T menu now saves too

Every control in both T-menu tabs — texture tint, emissive, glow, roughness,
size, variant, and every SFX synthesis parameter — auto-saves to the same
`localStorage` blob the main tuning panel uses, and restores on reload the
same way: applied before you ever touch a slider, not just reflected in the
panel. The one thing that does NOT persist is an uploaded texture *image*
itself — a single image can be hundreds of KB to several MB, and
localStorage's usual 5-10MB quota wouldn't survive more than one or two
across 15 creatures. Everything else on that row (tint, emissive, glow,
roughness, tiling, size, variant) does persist even if the image doesn't.

Resetting from the MAIN tuning panel (the Reset button in the \` panel) also
clears every creature's saved look and every SFX tweak back to shipped
defaults, consistent with everything else Reset touches.

## The T menu: three tabs

Press **T** for a three-tab panel:

- **Creatures** — texture upload, tint, emissive/glow/roughness, a **Size**
  slider (scales future spawns — anything already on screen keeps its
  current size), and a **Variant** button that cycles a few preset
  tint/emissive looks without needing an image at all.
- **Sound** — every entry in `CONFIG.sfx` gets its own row (wave shape,
  frequency range, filter, noise mix, decay, gain, depending on its type),
  generated automatically from config, with a **Test** button that plays it
  immediately — works even before you've started a run, since it unlocks
  audio itself.
- **Particles** — every entry in `CONFIG.emitters` gets its own row: size
  range, life range, speed range, and particle count, each generated
  automatically from config, with a **Test** button that fires the burst at
  the arena's center for a quick look.

## Editing textures

Press **T** in game for the texture panel. Upload an image onto any listed
creature and every instance on screen — already spawned or not — updates
immediately, because all instances of one asset share the same material
object by reference. A colour swatch tints on top (works even without a
custom texture), repeat sliders tile it, and Reset restores the model's
original texture and colour.

This works on procedural shapes too (chaser, shooter) — texture an icosahedron
if you want to see that happen.

## Neon glow (bloom)

`CONFIG.bloom` drives a real screen-space glow, not just bright unlit colours:
bright-pass + ping-pong blur at half resolution, composited additively before
the CRT/VHS filters. It's independent of the screen-filter system — either can
run without the other.

Every collision pushes the glow brighter for an instant via `glow` on each
`CONFIG.feedback` event (same pattern as `shake`), decaying back to the steady
base intensity. Sliders for threshold, amount, spread, and how hard impacts
punch it are under **Glow** in the tuning panel.

Procedural neon shapes (bullets, particles, pickups) are already at full unlit
brightness, so they bloom well by default — that's most of the classic
Geometry Wars look. Creature models are lit and comparatively subtle by
default; push their `Glow` slider in the texture panel (below) if you want
them to blow out too.

## Reskinning without textures

Every row in the texture panel (press **T**) also has **Emissive** /
**Glow** / **Roughness** controls — a flat glowing colour instead of an image.
Glow maps to `emissiveIntensity`; a high value plus the bloom pass above is
what makes something read as "lit from within."

These only appear — and only do anything — for materials that support them.
Loaded `.glb`/`.gltf` models use `MeshStandardMaterial`, which has both; some
`.fbx` exports (the seal, here) load as `MeshPhongMaterial`, which has
emissive but not roughness — the Roughness slider silently no-ops for those
rather than erroring. The procedural neon shapes (already `MeshBasicMaterial`,
fully unlit by construction) don't get these controls at all — there's
nothing to add to something that's already maximally bright.

## Fixed: models were rotating/positioning around the wrong point

Every model's pivot used the bounding-box midpoint ((min+max)/2), not its
actual center of mass — for anything asymmetric (a tail extending further
one way than the head, flippers splayed to one side), those two points can
be meaningfully different, and rotating around the wrong one is visible as
the model orbiting slightly off from where it should. Fixed by computing an
area-weighted centroid across the mesh's real triangles instead — treats
the surface as a uniform-density shell, a standard, cheap stand-in for true
center of mass. Verified on the seal specifically: a sane 24.5% offset from
the old bbox-center pivot (not the 280%+ found and rejected below), no
degenerate geometry, clean result.

While building this, one file (not the seal) turned up a single corrupted
triangle with an area roughly 40x any real face on that mesh, connected to
a vertex sitting dozens of units from the rest of the geometry — the same
"broken export data" pattern already handled at the whole-mesh level
elsewhere in this pipeline, but invisible to that check since this didn't
make the mesh's overall bounding box anomalous, only its area-weighted
average badly distorted. Added a second, per-mesh layer of outlier
rejection for exactly this: any triangle whose area is far beyond that
*specific mesh's own* typical face size (never compared across meshes with
naturally different triangle densities, which produced a real bug of its
own on the first attempt) is excluded from the pivot calculation.

## Fixed: the ship's Size slider silently did nothing

`player.body` (the ship model) is a singleton created once in `initPlayer()`
— unlike an enemy, `startGame()`'s `resetPlayer()` only resets its position
and stats, it never recreates the mesh. That meant the T-menu's Size slider
for "Seal (ship)", added last session, updated the multiplier used for
FUTURE `createVisual('ship')` calls but did nothing at all to the ship
already on screen — the exact same singleton gap already fixed for the
beluga drone and eel companion, just missed for the ship itself. Confirmed
directly: setting the multiplier to 0.05 left the live mesh sitting at
2.600 world units, completely unchanged, until an explicit rebuild was
wired in. If you were dragging that slider trying to make the ship bigger
or easier to see, you'd have gotten zero visual feedback — indistinguishable
from the ship not being there at all. Fixed the same way as the drone/
companion: the ship's body mesh (and its animation controller, tied to the
specific mesh instance) now rebuilds in place the moment its size changes
in the T-menu.

Also ran a from-scratch pipeline test through the exact code path the real
game uses — model load, `initPlayer()`, `resetPlayer()`, the actual
`player.body`/`player.mesh` objects — and confirmed independently of the
above that loading, scaling, and visibility were already all correct: 3
meshes, all visible, exactly 2.6 world units, scale `[1,1,1]`, correct
position. That pipeline was never the problem; the size control silently
not working was.

## Fixed: player/ability meshes were being double-scaled

`belugaDrone`, `eelCompanion`, `seagull`, `starfish`, and `shrimp` were all
missing from the T-menu's editable list entirely — no size/tint/emissive
control over any of them. Separately, `beluga.js` and `shrimpRing.js` were
each applying an extra scale multiplier on top of the model's already-correct
`fit`-scaled size — a leftover from when those used tiny procedural
placeholder shapes; once real models replaced them, that same multiplier
started silently halving (beluga) or further shrinking (shrimp) something
that was already sized correctly. Verified directly: the beluga drone
measured 0.7 world units before the fix against a `fit` target of 1.4 —
exactly half, exactly what a redundant 0.5x multiplier on top of a correct
1.4 would produce.

Fixed both problems together:
- Removed the redundant multipliers. `beluga.js` no longer applies its own
  scale at all — the model's `fit` is the only thing that should determine
  its size. `shrimpRing.js` only applies `CONFIG.shrimpRing.scale` to the
  procedural fallback shape now (which has no `fit` mechanism of its own to
  rely on) — an uploaded model's size comes from `fit` alone.
- Added all five to the T-menu's Creatures tab, so every ability visual now
  gets the same texture/tint/emissive/glow/roughness/size/variant controls
  the creature roster already had.
- The Size slider's range was a real clamp (0.3-3) — widened to 0.02-25, and
  paired with a direct number input next to it for exact values, since a
  single linear slider spanning that range would be too imprecise for fine
  control near 1x.
- `belugaDrone` and `eelCompanion` are singleton meshes created once at boot,
  not repeatedly cloned like an enemy — a size change alone wouldn't have
  shown up until a full reload. Both now rebuild in place (same position,
  same visibility, animation controller re-attached where relevant) the
  moment their size changes in the T-menu.

## Uploaded .glb models are more robust now

three.js's `GLTFLoader` treats a failed texture decode as fatal to the whole
model, not just that one texture — confirmed by reading its source
(`loadTextureImage` re-throws after logging: `console.error(...); throw
error;`). Embedded textures decode via a temporary `blob:` URL internally,
and some environments intercept or rewrite that (seen in practice as
`blob-request://` instead of the normal `blob:`) — nothing this app controls
once that's happening upstream. Rather than depend on it always working,
texture references are now stripped from an uploaded `.glb` before it's ever
parsed — same technique already used to shrink the bundled creature models
for the playtest build, just run client-side here instead of as a build
step. A texture-bearing upload can no longer fail to load at all; it just
comes in untextured, which the Creatures tab's tint/emissive controls can
already compensate for. FBX uploads didn't need this — their texture
failures were already non-fatal warnings, not thrown errors.

## Real models for the eel, seagull, and beluga

All three now use uploaded models instead of the placeholder shapes, with
real animation (beluga and seagull each reuse their one baked clip across
idle/swim/boost via timeScale, same pattern as every other single-clip
creature; the eel uses the first of its two clips — the file ships a base
motion layer and what looks like a separate additive "angle" layer, and the
shared animation controller plays one clip at a time, not blended layers).
These are bundled project assets now, not runtime uploads — no persistence
mechanism needed, they're just always there.

The electric eel also got something it didn't have before: an actual
companion creature. It swims near the ship with a damped-spring follow (it
lags naturally on turns rather than snapping to a fixed offset), and the
chain lightning now originates from ITS position
rather than firing directly out of the ship.

**A second, more serious version of a bug from a few sessions ago:** the
moray eel file has a "Gills" sub-mesh with a bounding box nearly 100x too
big — the same class of broken-export-data issue the otter's eyeball mesh
had, but in the opposite direction. The otter's broken mesh was too SMALL a
vertex count with a huge bogus bbox, so excluding it from sizing (while
still rendering it) was enough — it just ends up far off-screen, harmless.
The eel's outlier is too BIG, so after the same uniform fit-scale gets
applied to the whole model, it would have stayed roughly 100x too large —
the fix from before wasn't good enough here. Detected outliers are now
actually hidden, not just excluded from the sizing math, which handles both
directions the corruption can go.

## Level-up card art

Hex-tile background images ship with the game — see `LEVELUP_IMAGE_KEYS` in
`config.js` for the full list of keys. Assign one to an upgrade with the
`cardArt` column of `path/src/upgrades.csv`, alongside that upgrade's name and
description. Assigned cards get a dark overlay (colour + opacity both tunable
under **Level-up card art** in the tuner) between the image and the text, so it
stays readable regardless of which image is behind it.

## Four new abilities

- **Electric eel** — periodic chain lightning: zaps the nearest enemy, then
  jumps to the nearest *other* enemy within range, up to a max chain length.
  Level scales area (chain jump radius), damage, and max chain.
- **Starfish shuriken** — rapid straight-line throws, no homing or bouncing.
  Level scales fire rate and projectile size.
- **Seagull bomb** — fires straight down, homes specifically onto the
  nearest walking crab (ignores every other enemy type even if closer — the
  animated crab and the crab claw are NOT valid targets), and
  destroys both meshes on impact with a small splash to anything else
  nearby. Level scales fire rate only.
- **Baby beluga** — a drone that orbits the ship and fires bubbles at the
  nearest untrapped enemy; a hit freezes that enemy in place, harmless, for
  a fixed duration. Level scales bubble size (and therefore catch radius).

All four are under their own tuner groups. The eel's chain and the beluga's
trap both needed to sidestep the normal combat pipeline in one way or
another — see the comments in `systems/eel.js` and `systems/beluga.js` for
why (the short version: chain lightning kills enemies from inside a hook
combat.js itself is iterating over, and trapping isn't a damage effect at
all, so neither fits the shared bullet-hits-enemy path everything else uses).

## Uploaded models now actually persist

Previously an uploaded model (e.g. the shrimp ring) lived in memory only —
nothing about it survived a reload, "Copy values" included, since Copy
Values only ever captured `CONFIG`'s small JSON values, not multi-MB binary
model data. Uploads now save to IndexedDB (a real database with a much
larger quota than localStorage, built for exactly this) and restore
automatically on boot. A **Clear** button next to Upload removes the saved
copy if you want to go back to the built-in shape.

## Oxygen

A meter that depletes while underwater and refills quickly at the surface —
breach for a breath before it hits zero, or it starts draining health
instead of dying outright. **Bubble orbs** spawn on their own timer and rise
toward the surface (the only pickup that drifts up rather than down or
sitting still); collecting one restores oxygen instantly. All rates —
deplete, refill, drain damage, bubble frequency and refill amount — are
under **Oxygen** in the tuner.

## Rapid fire pickup

A yellow orb, temporarily doubles fire rate and shot count together (so a
multishot upgrade's shots ALL get doubled too, not replaced) for a set
duration. Collecting another while one's already active just extends the
timer. Under **Rapid fire pickup** in the tuner.

## Crabs and the pickup pile

XP orbs already sink and settle on the seabed if you don't collect them —
leave enough piled up and walking crabs start spawning to investigate, more
crabs the bigger the pile gets. Separately, any crawling crab (spawned this way
or otherwise) goes into a "rush" the moment you get close to the seabed
yourself — wider aggro radius, faster, no longer just idly wandering.
Thresholds, scaling, and the rush trigger height are all under **Crab
spawn** in the tuner.

*(Fixed while building this: the crab pile-spawn — and the older glowing-shark
timer, which has the same shape — used a direct spawn call that doesn't check
population caps the way the normal enemy spawner does. Confirmed with a
simulation: before the fix, a sustained pickup pile spawned 360 crabs over 4
minutes with 134 alive at once; the fix is now built into `spawnNamed` itself,
not just this one call site, so any future direct spawn gets it for free.)*

## HDR bloom overdrive

The scene now renders to an HDR (HalfFloat) target instead of the usual 8-bit
one specifically so glow can be pushed *past* white rather than just clamping
there. Every particle emitter has its own `glow` value in `CONFIG.emitters`,
multiplied by a global `bloom.particleOverdrive` slider (under **Glow** in
the tuner) — crank it for an overwhelming, blown-out look.

## Points, not just kills

Score replaces a plain kill counter. Schooling fish are worth little
individually but pop a bigger bonus when the *whole school* is wiped;
tougher non-schooling creatures (sharks, crabs, everything else) are worth
more per kill. Any kill landed while a strike chain is active gets
multiplied by the chain — a big combo run is worth disproportionately more
than the same kills spread out. All the multipliers are under **Points** in
the tuner.

## High scores and leaderboard

When a run ends you type a name, and the run is posted when you confirm —
nothing is submitted until then, so a run is never recorded under someone
else's name. The name is remembered for next time. The game-over screen shows
the board as it currently stands while you're typing, then re-renders with your
run highlighted once it lands.

The board is **global** when a backend is configured and **local to the
browser** otherwise. Both paths are live on purpose: `npm run dev` has no
worker running, and a run that ends in a network error is worse than one that
ends showing your own scores. Local storage is always written even when the
global post succeeds — it's what the start screen's high score reads from, and
the only record that survives the backend going away.

To make it global, deploy the Cloudflare Worker in `server/` and put its URL in
`.env` as `VITE_LEADERBOARD_URL` — full instructions in
[server/README.md](server/README.md). Vite inlines that at build time, so
changing it means rebuilding.

Each character typed into the name field ticks (`uiType`). It is the quietest
sound in the menu and the only synthesised one, because it fires a dozen times
in two seconds and a repeated identical sample at that rate is a machine gun —
`pitchVary` is what keeps it from becoming one.

Submissions are range-checked, checked for internal consistency, and
rate-limited per IP, and names are stripped of markup and capped at 24
characters. That keeps the board readable; it is not anti-cheat, since the
payload is written by the browser. See `server/README.md` for what that does
and doesn't buy you.

**The name length lives in two places and they must agree**: `MAX_NAME_LEN` in
`path/src/systems/leaderboard.js` and in `server/leaderboard-worker.js`. The
server is the authority and truncates anything longer, so raising only the
client lets players type a name the board then silently cuts. Changing it means
redeploying the worker, not just rebuilding the game.

## The game-over headline

The line above your score is drawn from **`path/src/quips.csv`**, one row per
line, the same spreadsheet-backed shape as `upgrades.csv` and `enemies.csv`:

| column | meaning |
| --- | --- |
| `id` | a short handle. Must be unique; never shown. |
| `text` | the headline itself. |
| `enabled` | `FALSE` takes it out of rotation. Blank means enabled. |
| `weight` | how likely, relative to the other rows. Blank means 1, `0` never. |

It's a table rather than a string because dying is the most-repeated moment in
the game, so it's the line the player reads more often than any other — and
adding one should be a row, not a code change. Use `weight` if you want
"You Died!" to be the common case with the punchier lines kept rare; a joke you
see every third death stops being one.

A quip is content in a file that can be edited by hand, so every failure path —
empty file, deleted column, every row disabled, all weights zero — falls back
to "You Died!" rather than rendering a blank headline. `npm run test:quips`
pins that down.

## Weapons and upgrades

- **Autofire** — a checkbox under Weapons in the tuner. Off by default (hold
  to fire); on, every weapon fires whenever it's off cooldown and you're
  aiming at something, no button held.
- **Homing missiles** — a second weapon, unlocked by the `homingMissile`
  upgrade. Each level adds one more missile per volley. A missile re-aims
  toward the nearest live enemy every frame, turn-rate limited so it curves
  rather than snapping.
- **Bouncing shot** — a third weapon (`bounceShot`), ricochets off the arena
  walls instead of flying past them. Levels raise fire rate, lifespan, and
  max bounces. A shot is destroyed on the wall hit that would exceed its
  bounce budget, not before.
- **Sea garlic** — a constant low-damage aura around the ship
  (`seaGarlic`), radius growing per level. The cloudy look is a procedural
  shader (two layers of scrolling value noise), no texture involved.
- **Shrimp ring** — clones of a model orbiting the ship, dealing small
  contact damage (`shrimpRing`), instance count growing per level. Upload
  your own model from the **Shrimp ring** tuner group; until you do, a
  small procedural shape stands in.

## Strike / boost system

A charge-based dash attack (default: **Space**, or gamepad B/circle) with a
cooldown per charge. Dashing into an enemy deals burst damage; landing
another strike within the chain window (before it expires) continues the
combo and scales damage up further — the chain persists across separate
dashes, not just within one. Blue orbs spawn on their own timer and
instantly restore a charge on pickup. A tougher glowing shark spawns on a
separate 10–15s timer as a marquee target. Every number here — charges,
recharge time, dash speed/duration, damage, chain window, chain damage
multiplier, both spawn timers — is under **Strike / boost** in the tuner.

## Pickups and loot

Every orb heals a small fraction of max HP on top of its XP, and orb size is
tiered by the dropping enemy's radius — a school fish drops a small, dim,
lower-value orb; a shark or squid drops a bigger, brighter, more valuable
one. Tiers and the heal fraction are under **Pickups & loot** in the tuner.

## Lighting

`CONFIG.lighting` — ambient, key light intensity + position, and a sky/sea fill
light — only affects lit models (`unlit: false` shapes, or any loaded .glb/.gltf/
.fbx, which default to real materials). All five values are under **Lighting**
in the tuning panel and apply every frame with no rebuild.

## Model scale and materials

- **Scale**: `fit` on an ASSETS entry sets the model's longest axis in world
  units. `scaleXYZ: [x,y,z]` multiplies on top of that for non-uniform
  squash/stretch without touching the source file.
- **Materials**: `material: { roughness, metalness, emissive, emissiveIntensity }`
  on an entry tunes how a model responds to lighting — lower roughness gives a
  sharper, brighter highlight from the key light.
- **Textures**: `texture: { map: '/textures/foo.png' }` replaces a model's
  baked-in base colour texture. A missing file logs a warning and keeps the
  model's original texture, same fallback pattern as everything else.

## Animation

Rigged creatures use a small state machine — `idle` / `swim` / `boost`, driven
by speed thresholds in `CONFIG.animation` — plus a transient `hit` flinch.

Two independent playback paths per model, chosen automatically:

1. **Real clips.** If `ASSETS.<key>.animations` names a clip that exists in the
   model's file, an `AnimationMixer` crossfades to it on state change.
2. **Procedural fallback.** If not, `ASSETS.<key>.rig` names a bone chain
   (root to tip) that gets driven by a travelling sine wave — amplitude ramps
   toward the tip for a real fish-like undulation, speed and amplitude come
   from `CONFIG.animation.states`, so it tunes exactly like a real clip would.

**The bundled seal has no baked animation clips** — it ships a 41-bone skeleton
with zero keyframe data, confirmed by scanning the FBX for `AnimationStack`
entries (there are none). So it runs entirely on the procedural fallback today,
driven by its actual spine chain (`animT2`–`animT9`) and head (`Animneck`,
`Animhead`). If you swap in a model that does have baked clips, name them in
`animations` and they take over automatically — no code changes.

The wag rotates each bone about its local Y axis, which is a best guess for
"side to side" given this rig's rest pose (forward `+Z`, up `+Y`) — if it reads
as nodding instead of swimming once you see it, change `rig.axis` to `'x'`.
That's the one thing I couldn't verify without a browser to actually look at.

## Saved tuning

Every tuner change auto-saves to the browser's `localStorage`, so adjustments
survive a reload — close the tab, come back tomorrow, your sliders are where
you left them. Three controls at the bottom of the panel:

- **Copy values** — for making a change permanent in `config.js`.
- **Reset** — restores config.js's shipped defaults and clears the save, so
  reloading after Reset won't bring your old numbers back.
- **Clear saved** — forgets what's saved without touching the sliders right
  now, so the *next* reload starts from config.js instead.

Saved tuning is loaded before anything else reads `CONFIG` (world, grid,
camera all included), so a saved arena size or grid spacing applies from the
very first frame, not just once you touch a slider again.

## Screen filters

`CONFIG.post` drives a single full-screen shader with `off`, `crt`, `vhs`, `vga`
and `arcade` presets — curvature, scanlines, aperture mask, chroma split, tape
jitter, colour bleed, posterise, pixelate, noise and vignette. They're all the
same shader with different uniforms, so presets can be mixed rather than being
mutually exclusive. Cycle them with **P**, or pick one in the tuning panel.

## Controls

**`** tuning panel · **P** screen filter · **M** mute

## Layout

```
path/src/
  config.js            all tuning values + tuner schema
  assets.js            asset registry, model loading, procedural fallbacks
  arena.js             ocean bounds, water line, containment helpers
  world.js             camera, lights, water surface, backdrop
  input.js             keyboard / mouse / touch / gamepad
  main.js              game loop and wiring
  entities/
    player.js          movement, derived stats, upgrades
    enemies.js         spawn weighting and behaviors
    projectiles.js     bullets for both factions
    pickups.js         xp orbs
    particles.js       burst effects
  systems/
    combat.js          every hit test involving the player
    predation.js       sharks eating fish, independent of the player
    jaw.js             procedural bite for the rigs that ship no bite clip
    feedback.js        one dispatcher for particles/shake/hitstop/sfx/haptics
    grid.js            the warping backdrop grid
    audio.js           synthesised sfx + haptics
    post.js            CRT / VHS / VGA screen filters
    shaderWarmup.js    compiles every program during load, not mid-fight
    instancedPool.js   one draw per shape for the things there are hundreds of
  ui/
    ui.js              HUD and menus
    loading.js         the boot progress bar
    tuner.js           live tuning panel
public/
  models/              drop .glb / .gltf / .fbx here
  textures/            drop images here
  sfx/                 drop .wav / .mp3 here and name them in CONFIG.sfx
```

## Controls

| | Move | Aim | Fire |
| --- | --- | --- | --- |
| Desktop | WASD / arrows | mouse | hold click |
| Mobile | drag | drag | drag |
| Gamepad | left stick | right stick | RT or A |

## What changed from the original

- Aim was resolved in screen space, which drifted as the ship moved away from
  centre. It now unprojects through the camera against the ship's world
  position.
- The ship cone was rotated to face the camera, so it rendered as a disc and
  never visibly turned. It now points along the aim axis.
- Reset reassigned `scene.children` directly, which leaves stale parent
  references and stranded meshes. Each system owns its own cleanup now.
- Particle materials were allocated per burst and never disposed; they're cached
  by colour.
- Player and enemy bullets were separate systems with duplicated logic — now one
  list with a `faction` field.
- Two enemy types became four, to exercise the data-driven roster.

Bullets and particles allocate per spawn. That's fine at current counts, but if
you push spawn rates hard, object pooling in `projectiles.js` and `particles.js`
is the first optimisation worth making.
