# Sealitaire

A Rive CLI project (`~/.rive/bin/rive`, 1.0.4+): Klondike on the ocean, built
to try the GPU canvas, WGSL and a skinned 3-D mesh natively in Rive.

```bash
npm run sealitaire            # the live viewer window + the tuning save loop
npm run sealitaire:verify     # compile + inspect, exit 1 on any problem
npm run sealitaire:test       # klondike rules, headless (tests.luau)
npm run sealitaire:shot       # one frame to build/shot.png
npm run sealitaire:card 8 star  # one rank artboard alone, build/card-8.png (also Pip / Corner / Plate); sets the suit's ink, so a black suit prints black
npm run sealitaire:svg art/suits.svg -- --names=a,b --size=15 --set  # one-shot: SVG paths -> <PointsPath> to paste into table-cards.rml
npm run sealitaire:mesh       # rebake seal.mesh from public/models/furseal.glb; `-- --list` names its clips, `-- --idle=bark --swim=run --boost=roll` fills the three roles from other clips
npm run sealitaire:music "/path/track.mp3"  # bake the track's FFT into music.bin (+ copy it in)
npm run sealitaire:fish       # rebake fish.mesh (the tank pack) from tanks.csv — the ship bake
npm run sealitaire:pool       # the LAB bake: tanks.csv + pool.csv, so the tuner's card rows can step through every creature
npm run sealitaire:clips      # every clip in every model the two tables name — what a row's `clip` cell picks from
npm run sealitaire:fbx -- seagull beluga   # an .fbx in public/models -> .glb beside it (rig + clips), so the pack can bake it
npm run test:sealitairefish   # the pack on disk: format, joints, weights, and that every clip moves its creature
npm run sealitaire:sheet      # every species in fish.mesh on the table, one frame each, to build/sheet/index.html
npm run sealitaire:sfx -- --write   # rebake the sound bank from sfxPacks.csv (the `--` matters: without it npm eats --write and nothing is written)
npm run sealitaire:audition   # step through the card sounds (or `survivor` for public/sfx); J/K/L do it in the game
npm run sealitaire:sfx:fx     # bake processed takes (phaser, lowpass, telephone) from sfxFx.csv into the bank
npm run sealitaire:sfx:fx knock   # THE KNOCK BANK: every flick-plop at five pitches + the reverb bus at four cutoffs (see "The knock")
npm run sealitaire:rev        # + build/sealitaire.rev, the editor's format
npm run sealitaire:push       # send it up to the Rive editor
npm run sealitaire:pull <f.rev>  # diff an editor export back against the .rml
npm run sealitaire:app        # (re)make the Dock button in ~/Applications
```

| file | what |
|---|---|
| `scene.rml` | the artboards (screen, the four chrome blocks, card back), view models, assets |
| `table-cards.rml` | **the name has to sort after `scene.rml`** — a markup file ahead of the one holding the ScriptedLayout kills every Luau script on the WEB runtime, silently, and only when a shader is in the build (`npm run test:rmlorder` guards it; the file's own header has the detail). The card faces: `Corner` (the rank glyph **and the suit under it**), `Plate` (the deep-water face, hidden on a tank card's ink instance), and `Card A` … `Card K`, each ONE corner (top-left; there is no turned bottom-right copy) and a plate and NOTHING else. `[FPO] Pip` is the old generated suit mark — placed on no card, flagged so it never can be. Ids are `2:*`. Hand-edit or design in the editor — nothing regenerates it |
| `images/` | the suit art the pips reference (`starfish.webp` is a 160px trim of `public/sprites/starfish-2.webp`) |
| `art/` | the vector sources art was imported FROM. `suits.svg` is the four card suits (Noun Project, by Musmellow) — the vertices in table-cards.rml are the live copy, this is only the provenance |
| `table.luau` | everything that moves: springs, pointer, GPU passes, compositing |
| `klondike.luau` | the rules, pure; `tests.luau` proves them |
| `pad.luau` | the gamepad: where the cursor can be on the table and what a direction does to it, and the device half (button edges, stick deadzone). Pure, like the two above, and proved the same way |
| `layout.luau` | where everything goes at any viewport, pure: card size, the grid, the fan, the chrome's anchors, the panel. `tests.luau` proves it |
| `tools/sealitaire-bg.mjs` | `npm run sealitaire:bg` — the tank backgrounds auditioned four at a time, one render per candidate palette into `build/bg/`. See "The suits" |
| `puppet.luau` | the seal's motion, ported from the game's level-up seal: state blender, the run's pull physics, the idle/swim/boost clip controller |
| `react.luau` | what the seal does after a valid play: spin, barrel roll, flip, clap, and the file's own bark/roll/ball clips — pure choreography as a function of seconds (see "The reactions") |
| `motion.luau` | the seal's states — idle, card, drag, bite, release, win — (landing point, heading, roll, look, jaw, and `behind`, which side of the cards it swims on), the shape of `levelUpSealMotion.json` |
| `vortex.wgsl` | the water, full-screen, reacts to card plays — mode 0, the default |
| `paint.wgsl` `caustic.wgsl` `marble.wgsl` | the water's other modes (1, 2, 3): the Balatro-style paint swirl, a cellular caustic net, triple-warped ink. Same uniform layout as vortex.wgsl, same ripples/energy/pointer, so any of them can be the table's water; `waterMode` in tuning.luau picks one and W cycles them live |
| `goo.wgsl` | the goo: one signed-distance field of every stack, card in flight and droplet, smooth-unioned so shapes fuse and drops snap free; half-size, premultiplied, composited over the water by crt.wgsl |
| `surface.wgsl` | the water as a lit 3-D sheet over vortex + goo: a height field (swell, ripples, the hand, the seal's wake, the goo's silhouette) refracts what is under it with dispersion, turns sky around on its tilted faces (Fresnel), lays caustics, raises bubbles the goo pops; its output is what crt.wgsl samples as water |
| `foam.wgsl` | the whitewater, simulated: a persistent half-size buffer (two canvases, ping-pong) carried by the vortex's flow and fed by card-shaped impacts, moving cards and the seal; R foam, G trapped air; surface.wgsl draws it |
| `puddle.luau` | what is in the goo's field each frame: stack and flier boxes from the card views, droplets thrown by landings and shed by a drag, pulled home and absorbed |
| `seal.wgsl` | the fur seal, skinned in the vertex shader, toon-lit; also which side of the cards each vertex goes on (below) |
| `crt.wgsl` | Balatro-style CRT, and the compositor: water, cards, and the seal on both sides of them (below) — and each tank card's whole face keyed through a slot mask to its tank tile, with the card's ink (a second atlas, plate hidden) printed over the creatures. Also **the card rim** (below) |
| `sfxPacks.csv` | the bank's sources: one row per pack directory or single file (a Survivor sound is `public/sfx/Whatever.mp3,why it is in`), baked by `npm run sealitaire:sfx -- --write` into `sfx/` as trimmed, levelled 32k mono FLAC with ids slugged from the filename, an index in `sfx.csv` and the SFX BANK block in scene.rml. Bake the recorded set, never an ad-hoc list: ids are positional and the guard refuses a renumbering |
| `sfxEvents.csv` | which sound plays for which event: `takes` are bank ids (`|` between, one picked at random), `gain`, `delay`, `minGap`. The code names the event (`playSfx(self, 'flip')`); Ethan casts here. A row with no takes is a stub. `sfxFx.csv` names processed variants of a take (a phaser on the deck's fan), baked by `npm run sealitaire:sfx:fx` since an AudioSound has no DSP of its own |
| `pool.csv` | every creature a card MAY be given, over and above what tanks.csv uses; `npm run sealitaire:pool` bakes both into fish.mesh so the panel's model row can walk the whole roster live. The ship bake (`sealitaire:fish`) leaves it out |
| `tanks.csv` | which cards are tanks and what swims in them: every 2–10 holds as many bodies as its rank (the count IS the number — there are no pips), every A one apex predator, every J/Q/K one creature from the roster, a species per suit. `model` is a `public/models/*.glb` name, `count`/`size`/`back`/`belly`/`bg` are read live by the script; a new `model` needs `npm run sealitaire:fish`. `flip` turns a creature the baker guessed backwards. **`bg` is the tank's background** — see "The suits". `yaw`/`roll`/`sway`/`loop` are the body's other two axes, its idle motion and whether a lone creature swims the oval; `clip` names a skeletal animation (a rebake); `bio`/`bioColor` the glow — all below |
| `baitball.luau` | the bodies inside a tank card: a small sim per card — a spring to a seat (the pip formation for a school, a loop in the card plane for a lone creature), and the card's edges as WALLS (the camera frustum at each body's own depth; nose and tail both kept inside). A click is a jolt; a drag lets the box LOOSE so they rattle, sink and bounce, then reseat when idle; only a card landing in a valid spot swirls the number into a bait ball for a beat. Every rate is a `tanks` row in the tuner |
| `fish.wgsl` | every tank body, instanced, one draw per species, into one atlas tile per tank; countershaded from the row's `back`/`belly`, then CEL shaded (`vs`/`fs`) with an inverted-hull OUTLINE (`vsLine`/`fsLine`) — both under `toon` in the tuner |
| `fish.mesh` | the tank pack, baked by `tools/sealitaire-fish.mjs` from `tanks.csv`: every species in one frame (head at -z, length 1) at rest pose, plus — for a row with a `clip` — that clip as a bone palette (see "The clips"); do not hand-edit |
| `seal.mesh` | baked by `tools/sealitaire-mesh.mjs` — mesh, rig, and the water_idle/swim/sliding clips sampled at 30fps; do not hand-edit |
| `tuning.luau` | every slider: key, range, value — the defaults AND the panel's rows |
| `tuner.rml` | the panel's two parts (a row, a header); the script lays them out from tuning.luau's `cat`s, headers fold |
| `music.luau` | the track's baked FFT read back against the playhead, and the rules for what rings: which band, how often, where on the table |
| `music.bin` `music.mp3` | the analysis and the track, baked by `npm run sealitaire:music`; do not hand-edit the .bin |

## Every size of screen

The artboard is fill-sized, so **the size `resize` hands the script is the
window's own** — 1600x1000 on the desktop, 390x844 on a phone — and one
artboard unit is one CSS px there. There is no fixed table: `layout.luau`
turns that size into every number the table used to hold as a constant, and
`self.L` is what the script reads for every position, every hit test and every
uniform that is in artboard px.

**Two scales come out of it and they are not the same.**

`L.fit` is the CARD's. A card artboard is 120x168 whatever the screen is;
`fit` is what puts it on screen at `L.cw` x `L.ch`, folded into `cardMatrix`
and nowhere else, so the window, the rim, the ink atlas and the mask can never
disagree about where a card's rectangle is. Everything else that was measured
against a card rides the same number: the rim's width, the ink glow's radius,
the goo's skirt and blend and dome, a droplet's size and speed and the travel
between two of them (`puddle.luau`'s `g.px`), the hover margin, the lift under
a dragged card, the shadow's feather and the glow ring's stroke.

`L.ui` is the CHROME's, and it barely moves — a 13px label is read at arm's
length on a phone and on a monitor alike. It is clamped to 0.8..1.25 and then
to `w / 620`, which is the top strip's own width: the readouts out to 420 and
the deal button's 200 off the right edge. Sized against the TITLE instead the
clock sat under the button, because the two clear each other by six pixels of
height and nothing else.

**The reference is exact.** At 1600x1000 every number comes out at the value
that was hand-tuned into `table.luau` before it moved — card 120x168, gap 24,
left 308, rows at 208 and 430, fan 34 and 14, `ui` 1 — and `sealitaire:test`
asserts it to a billionth of a pixel. The vertical proportions in layout.luau
are written as fractions of a card's HEIGHT that sum to 1000/168, which is the
identity that makes that true; nudge one and the test fails rather than the
desktop quietly drifting.

Three things that are not just "scale everything":

- **The chrome's strip comes off the height first.** `TOP_PAD` (124/168 of a
  card) is not spare room, it is where the HUD stands, and the readouts reach
  126 — they have always overlapped the deck's top corner by those two pixels.
  So the strip is taken in CHROME units before the card is sized out of what
  is left. Read as a fraction of the card instead, a 390-tall landscape phone
  put the whole deck behind the clock.
- **A column squeezes rather than running off the bottom.** `LAYOUT.fanFor`
  gives a pile the layout's fan until it cannot fit `colSpan`, then shrinks
  BOTH steps together — squeezing the face-up step alone would open the buried
  cards as the visible ones closed — with a floor of 26/168 of a card, which
  is the last step that still shows the whole rank. A full run built on column
  seven used to walk past the bottom edge on the desktop too.
- **Spare height becomes fan, not margin.** Where the width is what limits the
  card (any portrait screen) there is height over; 70% of it goes into the fan
  step, because more of every buried card showing is the thing a small screen
  is short of. What the fan cannot use falls to the bottom, where the seal is.
- **A SHORT screen gets a tighter budget.** Everything above is the desktop's,
  and most of it is air: 124 card-px of chrome strip, 54 of row gap, a 322
  column reserve, a 164 foot. On a 1000px screen that air is what makes the
  table read as a table; on a 390px-tall **landscape** phone the same
  fractions are 64% of the screen, and the card they left was 40px wide —
  *smaller than the same phone gave in portrait*, which is where the width is
  the limit and 440px of height sat spare. Landscape is klondike's worst case
  and it was being handed the most generous spacing on the table. So the
  strip, the seam and the column reserve blend to a tight set between 820px
  and 470px of height (`TIGHT_AT`/`LOOSE_AT`), and the column gap and the side
  padding blend to a tight set between 760px and 430px of **width**. A phone
  on its side gets a **1.4x** card, a portrait one **1.15x**, and 1600x1000 is
  untouched to a billionth of a pixel because both blends are 0 there.

  **The wall is `fanFor`'s floor, and it is arithmetic rather than taste.** A
  column of nineteen — six face-down and a full K-to-A run on it, rare but
  legal — squeezes no further than `FAN_MIN` a card, so it always occupies
  3.24 card heights from its own top edge. With the two rows above it that is
  `chrome + seam + 4.24 * ch <= h`, which caps a 390px-tall screen at about a
  56px card whatever else is trimmed. `COL_BUDGET_TIGHT` is set right at that
  cap; nudge it down and `tests.luau` fails rather than a long column quietly
  walking off the bottom where it cannot be picked up. Going further means
  giving something up — the rank on a buried card (`FAN_MIN`), or the promise
  that a nineteen-card column stays on screen.

  **Portrait has almost nothing left.** Seven columns across 390px is a hard
  55.7px ceiling with zero gap and zero margin, and the tight gap already
  reaches 51.3. The only way past it is a layout that stops showing seven
  columns at once.

- **The seal is sized against the board, not the desktop's stack.** `sealRef`
  reads `topPadCards + board`, which IS `STACK` wherever the budget is loose.
  Off the constant instead it grew by the same 1.4 the landscape card did, and
  half a 390px screen is a seal.

The card also has a ceiling, 180px: the tank atlas is 8x7 tiles of `cw` x `ch`
DEVICE pixels, so a card that grew with a very tall viewport would quietly
allocate a texture measured in tens of megabytes.

`resize` rebuilds the GPU canvases only when the pixel size actually changed —
a live window drag calls it every frame — and `applyLayout` does the rest:
the paths AND THE PAINTS. A stroke's thickness and a feather's radius are in
path units and these paths are drawn at scale 1, so nothing scales them for
us; a 5px glow ring and a 16px shadow feather around a 45px card are a smear
with the card lost inside it.

Checking it is `--viewport`:

```bash
$HOME/.rive/bin/rive rive/sealitaire --screenshot=/tmp/p.png --viewport=390x844 --advance=120
```

and a hit test is a `--pointer=click@x,y` with `--data-dump-filter=moves`:
pointer coordinates are SCREEN space and go through the barrel curve, so the
raw point for a table point is the inverse of `throughCurve`, which near an
edge is several pixels out.

## The chrome

Three small artboards, instanced and placed by `drawChrome` — the wordmark
and the readouts along the FOOT, bottom-left, the deal button top-right (the
status line that used to sit bottom-left is gone; its two lorem lines with
it) —
from `L.title`, `L.stats`, `L.status` and `L.button`. It used to be ONE
artboard the size of the table with every label hand-placed in 1600x1000
space and drawn at (0,0) — which is exactly as responsive as a printed page:
on a phone the deal button sat 1480px to the right of a 390px screen and the
status line 956px down an 844px one, and both were simply gone.

Text is markup-only, so the fix cannot be "let the script place the words". It
is to cut the page into the pieces that each belong to an edge and let the
script place THOSE. The split is by anchor, not by tidiness, and every
position inside one of the four is relative to its own (0,0); none of them
mentions the size of the screen. `BUTTON` in table.luau is gone — `L.button`
is the artboard's rectangle and the hit test both, so they cannot drift.

## The tuner, on a small screen

`L.tuner` sizes and places the panel: right-anchored, scaled down to 0.7, one
column where two will not fit. 1724px of sliders do not fit a phone in any
number of columns, so **the panel scrolls**, and rows outside the band between
its top and the SAVE/RESET foot are clipped out of both the drawing and the
hit test — the panel has no clip of its own, and half a slider floating over
the table reads as a bug rather than as a list that is scrolled.

The scroll lives in a **gutter** down the panel's left, 22px at full size and
never under 16. Every other pixel of the panel is a slider, a header or a
readout, so a drag anywhere else is already an edit; a strip that is
deliberately nothing is the only place a scroll can live without taking a
gesture away from the thing the panel is for. Its thumb shows how much of the
list is up. The columns still start exactly where they did.

The rows are 380x16 artboards drawn at `L.tuner.scale`, so `x0`/`x1` — the
knob's track — stay in ROW units, and a pointer is divided by that scale
before it is read against them.

## The card lab

The tuner IS the lab. Rive has no editor surface for the GPU canvas or a
WGSL pass, and a script cannot write a file, so the only place a card's
creature can be designed against the real shading, outline, glass and rim is
the viewer window, and the only way out is the console — which is the loop
the T panel already closed for the sliders. The lab adds a SUBJECT to it.

**Click a face-up card with the panel open and it is the subject.** The
panel's first category reads `card Q star` and holds that card's tanks.csv
row: `model` (a discrete row that steps through `self.pool`, every species in
fish.mesh but the bubble, by name), `count`, `size` (to 10), and the three
colours as `backR/G/B`, `bellyR/G/B`, `bgR/G/B`, then the layout: `colGap`,
`rowGap`, `padX`, `padY`, `drop`, the three axes `rotate`/`yaw`/`roll` with
`rotateVary`, `sway`, `loop`, and the glow `bio`/`bioR/G/B`. Those four read the tuner's global (`~0.325`, the tilde says
inherited) until dragged, and then hold this card's own number in its
tanks.csv cell; RESET blanks it again. Every drag applies on the next frame
through the same TankRec the tank reads — a species swap regrows that
species' instance buffer (`recapSpecies`) and never shrinks one. The drag on
the card still happens: how the bodies rattle is part of what is being
looked at.

**SUIT** (the third foot button) copies the subject's model, size and colours
onto every number card of its suit, because the 2-10 are one school that
differs only by count. On an ace or a court card it does nothing but say so.

**SAVE** prints `TUNING-SAVE` as before and then one `TANKS-SAVE` line per
card the panel changed (`card=Q:star`, a colon because the line is split on
spaces). `tools/sealitaire-tune.mjs` rewrites those cells of that row and no
other byte of tanks.csv — `flip`, `notes`, the other rows' quoting all pass
through; `npm run test:sealitairetune` holds it to that, and holds the
tool's field list to the file's header: for a while `drop`, `rotate` and
`rotateVary` had sliders whose SAVE landed nowhere, because the list was
typed by hand and never checked. **RESET** puts every
touched card back to its row as loaded.

Two things about the pack: the model row can only offer what fish.mesh
holds, so bake the pool first (`npm run sealitaire:pool`, ~11MB for 45
species) and bake lean again before a ship (`sealitaire:fish`, what tanks.csv
uses). And the CLI applies `--data` AFTER `init`, so anything read from the
view model for a headless run has to be read in `resize`'s load path, which
is where `lab` is read.

**The contact sheet** is for picking by eye rather than by name: `npm run
sealitaire:sheet` renders the whole scene once per species with
`--data=lab=<species>` — table.luau reads that as "this species on every
card" and deals `LAB_SEED`, so every frame shows the same seven faces, the
2-10 as a school of it and the court as one — crops each to the tableau's
band, and writes `build/sheet/index.html`. About a second a species.

Two ways the panel's rows draw nothing: an artboard instance that is not
`advance`d never resolves its bindings and draws BLANK, taking its space in
the layout and answering hits (the card rows did exactly that until they
joined the advance loop); and the foot's buttons are hit-tested at 100px
each, not the column's width, because at the column's width SAVE was the
first match for every press on the foot and RESET was unreachable.

## The win: the cascade

The foundations empty themselves down the screen the way Windows Solitaire
taught everybody — a card at a time, thrown sideways, falling and BOUNCING
off the bottom until it walks off the edge. `cascade.luau` is the physics and
the schedule, pure; table.luau owns the clock and writes each card's position
straight onto its view (a bounce chased by the card spring is a smear, so the
spring's target follows the card rather than the other way round).

**C runs it whenever you like.** A look that can only be seen by winning
cannot be tuned, so with nothing on the foundations C builds what a win would
have left — thirteen of each suit on their own pile — and throws that. It is
not a stand-in: the same 52 cards in the same four stacks through the same
code, and the log says `(a rehearsal: the game is not won)` so the two are
never confused. Press it again to restart; a deal (N) ends one mid-air.

Every number is a tuner row under `win`, and the ones that change what it IS
rather than how fast: `winBounce` (of the downward speed kept on each hit —
under about 0.5 the cards heap instead of cascading), `winGap` (seconds
between cards, the whole rhythm), `winLaunch` (how wide the arcs open).
`winRipple` rings the water where a card lands and the landing is heard.

Three things it gets right that are easy to miss. It launches on the CLOCK,
so a long frame owes two cards and launches two rather than quietly
stretching the cascade. A card that settles is marked RESTING and stops
answering gravity — without that it fell a frame's worth, tripped the floor,
was clamped back and counted another bounce, sixty a second, and one test
card reported 242. And every number comes from the card's own hash rather
than `math.random`, so the same trigger gives the same cascade twice, which
is the difference between tuning a look and chasing one.

Headless: `--key=c` (CLI 1.1.0+) fires it through the real dispatch path —
`rive rive/sealitaire --advance=30 --key=c --advance=130 --screenshot=...`.

## The reactions

A valid play is answered. `tryMove` bumps `reactSeq` and picks a variant
(`react.luau`'s roster, never the last one, `reactChance` of the time); the
puppet sees the new number, swims to the STAGE — the open water between the
lowest card on the table and the foot strip, biased toward the middle and
toward where the animal already is, measured every frame in `updateSwim` —
and once it is within 1.2 bodies of it (or has waited 0.9s) runs the
choreography from 0 at `reactSpeed`. The hand outranks it: a drag or a bite
while one is pending or playing wins, and the reaction is simply dropped.

`REACT.pose(name, t)` is the whole of a reaction: DELTAS the puppet adds to
its blended pose — heading, roll, a new `pitch` (a somersault about the
body's sideways axis, the same axis the release's nod uses in `sealModel`),
a lift toward the viewer, `clap` 0..1, and for the clip variants a baked
clip's weight and time. Two things it gets right on purpose:

- **A turn is not enveloped.** Spin, barrel and flip ease to one whole turn,
  which is the identity, so the pose blends out by ARRIVING — an enveloped
  rotation would unwind the turn it just made. `tests.luau` holds every
  variant to ending where it began.
- **The clip variants take their weight OFF the speed set.** bark, roll and
  ball are baked beside the swim clips (`tools/sealitaire-mesh.mjs` bakes all
  six; `seal.mesh` is 890KB now) and play a window of the clip on the
  reaction's own clock; while one plays the idle/swim/boost weights scale by
  `1 - clipW`, so it is the pose rather than half of one.

**The clap** is posed on the rig: the shoulders swing about their local Z
(mirrored) and up about X, and at `clapRaise` 1.4 radians of each the
flippers meet over the back — measured with a probe on seal.mesh's bind
matrices (the notes in the session: X alone meets under the belly, Z alone
behind the tail; the ZX pair is the only one that lands above the back where
the camera can see it). Three closes in 1.4s, on a small lift.

## Which side of the cards the seal is on

**The seal is ON the table, not under the glass.** It draws OVER the cards,
and that is the default for every state in `motion.luau`. It used to be the
other way round — the whole animal lived in a canvas below the cards, and the
only thing that ever came up over them was the head, during a bite — which
made the biggest, most expensive thing on screen the one thing the cards
could hide.

A state that wants the cards in front of it says so: `behind = 1` on that row
in `motion.luau`. That is the hook for a special event — the seal sliding
under a spread, the cards closing over it — and nothing uses it today.
`puppet.luau` blends it by state weight like everything else in the file, and
`seal.wgsl` reads it at a threshold, so the animal changes sides at the
halfway point of a crossfade rather than ghosting through the cards at half
alpha. There is no way to fade a z-order, and a pop is the honest version.

**The mesh is drawn into two canvases**, `sealUnderCanvas` and
`sealOverCanvas`, and `crt.wgsl` composites one below the cards and one above
them. `seal.wgsl`'s only branch is which of the two a fragment belongs to, and
every fragment that is not this pass's is discarded — so away from a bite one
canvas holds the whole animal and the other holds nothing, and `drawSeal`
clears the empty one instead of spending a second full pass over 28 bones'
worth of mesh on discards.

**A bite splits the animal across both — but only at the mouth.** A card in
the jaws has to be INSIDE it: the upper head in front of the card and the
lower jaw behind it. So `split` (0..1, `puppet.luau`, up while the mouth is
clamped) overrides `behind`, and exactly ONE LIP crosses to the far side of
the cards while the rest of the seal stays where it was — from behind, the
upper head (`head_07` and the two eye bones) comes up; from in front, the
lower jaw (`mouth_08`) goes down. It crosses progressively as `split` rises,
the vertices furthest from the seam first, so the mouth opens around the card
rather than the animal popping in two.

The two lips are read as separate bone-weight sums, **not as complements of
each other**, and that is the whole point. In front of the cards the
complement of the head is the entire torso, flippers and tail, so sending
"everything that is not the head" under the cards puts the seal back behind
every pile it is swimming across — which is what a press or a drag does to
it, and a press or a drag is most of the time a hand is on the table.

One consequence worth knowing: the HUD is drawn into the same scene canvas as
the cards, so the seal now passes over the readouts as well. The script keeps
the top strip clear of cards and the seal's landing points sit under the row,
so it does not happen in ordinary play — but if it ever needs to stop, the
HUD has to move out of that canvas, not the seal.

## The hover

Hover a card and the RUN under it — that card and every face-up card below
it, what a drag would take — pops: the hovered card first, each card below
it `popWave` seconds later, so a springy wave runs down the chain and
settles; leave, and the same wave lets them down. `hover.luau` is the whole
of it, pure: each view carries a `Pop` (0 rest, 1 up) chasing an ARMED goal
through an underdamped spring (`popSpring`, `popDamp` — the overshoot is the
liquid), and arming is the only thing staggered. The table reads the pop as
scale (`hoverScale`, small: the fan has to stay legible), a rise up the
screen (`popRise`) and shadow. NEVER a shear: the old hover tilted the card
toward the pointer, which skewed the face, and that is gone. A press dips
the card (`pressKick`) on its way into the hand, which is the click.

The rise is `popRise()` and it lives in the CARD MATRIX and in the CRT's
card-table entry, not in `v.y`. The hit test and the goo see the card where
it rests, so a hover cannot chase itself off the pointer — and the CRT keys
the tank window and the rim off that entry, so it has to rise with the
face: for one build it did not, and every hovered card was two cards, the
face lifting off its own window.

## The deck's fan

**Two hovers, and `stockHover` picks one.** 0 is THE PEEK, which is what the
deck ships with; 1 is THE RIBBON, kept as a stub so the two can be looked at
side by side on the same build rather than across a revert. Everything from
"A chain pinned at both ends" down to the wind-up belongs to the ribbon and
none of it runs in peek mode.

**The peek.** The top card separates from the pile — `stockPeekX` left,
`stockPeekY` up, leaning `stockPeekTilt` as it goes — far enough to read as
lifted off it and no further. Everything under it stays a pile: no chain, no
weave, no head on the cursor. LEFT is the whole point of the direction. The
waste is the slot to the RIGHT, so a card separating toward it would cover
the card just drawn with the card about to be, which is the one thing the
move must not do; up-and-left uncovers both.

Two things the peek has to do for itself. It writes the BODY's targets back
onto their slots every frame, because `relayout` runs on events and not on
frames — without it, flipping `stockHover` while the fan is up leaves
twenty-three cards hanging in the water until the next deal. And `fanBox`
shrinks to the peek's own reach: that box is the DRAW's region as well as the
hover's, so keeping the ribbon's would have fanned the deck, and drawn from
it, out of empty water most of a card away. Mind the units in there — x is in
edge terms and y in centre terms, because `overStock` grows the box by half a
card in y and by nothing in x. Spelled as centres, the 60px of the deck
outside the peek's slide stopped being clickable.

**Shared by both.** The **ceiling** is `LAYOUT.fanRoom` — the strip between
the window's top edge and the deck's own, less `stockClear` of air, capped by
the tuner's `stockRise`; the peek's slide is capped by it too, and by the
window's left edge, so a narrow screen slides it less rather than off the
side. So are `stockFan` itself, the two rates below, the hitbox, and both
sounds.

Hover the stock in ribbon mode and it lifts into a ribbon: the top card
pinned to the cursor, the rest weaving up to it, a click dropping the lot as
the top card flips away.

**A chain pinned at both ends.** The bottom card holds the slot it was dealt
into, lean included; the top card is ON the cursor, not near it; and the
gradient between them is everything the ribbon does. `stockChain` is that
gradient and it is per CARD — each one sits that fraction of the way from the
card above it back toward its own slot — so the shape is the same with four
cards left as with twenty-four. Spread as a fraction of the DECK (the old
`(ki-1)/(n-1)`) packed the top five cards into the last 8% of the ribbon, one
on top of another under the pointer, and that is what made a draw look like it
came out of the middle of the deck rather than off the top of it.

Each card reaches for **where the card above it actually is**, not for the
head, so every link adds its own spring's lag and the ribbon bends through a
turn instead of swinging as one board — updateDrag's trail, built out of the
card springs already running. Its lean is the chain's own direction (a card
points at the one it is following, faded out as the link closes up, because
two cards a quarter of a pixel apart have an angle between them and it is
noise); the head has nothing above it, so it banks into its own travel
instead. The weave (`stockSway`, `stockTilt`) is weighted to peak just under
the head and to reach zero at both ends: it may move the cards the ribbon is
carrying, never the deck it comes off or the card the pointer is holding.

**The head's box is `fanBox`.** The deck is the table's top left corner, so
the head is free to pull up under the chrome and out to the left as far as the
window will take a whole card — it stops at the column's right edge only
because the waste is the next slot over. `overStock` is that box, and a click
inside it draws: the draw used to be the deck's SLOT alone, which was true
while the ribbon never left the column and became a fan you could pull at but
not take the moment it did.

**Staying is a bigger place than drawing** (`nearStock`). The only edges that
mean anything to a deck in the corner are the two the table is on — the right,
where the waste starts, and the bottom, where the tableau does. Off the left
or the top there is nothing to hand the pointer to, so the hover runs all the
way out to both window edges: the head stops at its box and the ribbon simply
stays up behind an overshooting hand, instead of being dropped by the corner
it was being pulled toward.

**The ribbon leans left** (`stockBias`). The waste is the slot immediately to
the right of the deck, so a fan that rises straight up crosses the card that
was just drawn. The bias is one number spent three ways: the head's box
reaches that much further left, the ribbon's body bows that far out (shaped by
`loose`, so the belly is in the middle and neither end moves), and a fan with
no pointer to follow parks up and to the left rather than straight up.

**The head is over everything** (z 4000), and the card in flight is over the
head (4200). The body of the ribbon keeps 300+: above the waste, under the
foundations, which is the right order for a pile. The flight needs saying
because `relayout` puts the drawn card at the waste's 200+ the instant it
leaves, which is UNDER the fan still collapsing behind it — the card the
player clicked spent the first tenth of its flight inside the deck. Both
numbers are written at the two places that use them rather than named at the
top of the file, because the main chunk is at Luau's 200-local ceiling (see
**The two ceilings** below).

**The ribbon has its own springs.** Every other card on this felt wants to be
in its slot NOW, which is what `cardSpring` (736) is for; a fan hung off a
moving cursor under that spring is a rigid arm, and the weave has to do all
the work of looking alive. So a fanned stock card asks for its own spring
instead — `stockLead` for the head, `stockFollow` for the body, blended in by
the fan's own height so a deck at rest still snaps — and the cursor's movement
is then what drives the chain, with the weave left to be the water it hangs
in. `v.fanK`/`v.fanD` carry the ask; `relayout` clears them, so a card that
has left the stock cannot keep them.

## The wind-up

**Press, and the deck draws the card BACK; release, and it throws it.** The
draw used to be the press, which is the right shape for a button and the wrong
one for a card being pulled off a deck: the whole gesture was over before the
hand had finished making it. `stockHold` is how long the deck has been held,
`holdTap` is how much of that is still just a CLICK and is worth nothing,
`holdFull` is what a full wind-up costs, and everything the release does
scales with the fraction of the rest the hand gave — turns (`holdFlip`), arc
(`holdArc`), seconds in the air (`holdTime`), water (`holdGoo`), the ripple and
the sound. **A tap measures zero and lands exactly where it always did**, so
nothing has to be learned to keep playing the way you were.

While it is wound, `holdWind` takes that fraction off the fan's height: the
card does not go anywhere, the deck pulls it in, and the flight springs out of
that. Sliding off the deck DROPS the wind-up rather than firing it — that is
how every button on every screen is taken back, and a charge that went off in
the tableau because the hand drifted would be the one thing here that could
not be undone.

The turns are odd half-turns, always: `flip` is the turn's progress, the face
swaps every half of one, and an even count would land the card on its own
back. `holdFlip` is counted in WHOLE turns for that reason, and the count is
FLOORED — rounded, the first extra turn arrived at a quarter of a wind-up,
which is an ordinary mouse click, and every click off the deck flipped twice.
A turn is paid for in full or it does not happen. The deadzone is the other
half of that: without it a click measures 0.15 of a charge it never asked for,
and gets the arc and the airtime of one. The landing writes
`flip = 1` outright — pi and three pi draw the same card, but the ease that
takes over afterwards would read 3 as a card three half-turns from home and
spin it back.

The goo is two halves: a burst thrown off the card as it leaves the ribbon
(`PUDDLE.splash`, with a longer `free` than a landing's so the drops get clear
of the deck before its own goo pulls them back in) and the landing's own slap
on the waste, which `PUDDLE.advance` fires when the card settles. The pass
holds 24 drops at once and the oldest give way, so `holdGoo` past about 8 x
`gooSplash` is churn rather than more water.

The pad plays the same gesture: `Pad.south` starts the wind-up, and because
`PAD.read` reports edges and only presses, what ends it is `advance` watching
`pad.state.south` go back up.

## The two ceilings

table.luau is at BOTH of Luau's per-module limits, and neither one tells you
what it is when you cross it.

**Type inference.** "Code is too complex to typecheck", pointing at the most
expensive expression in the file — which is almost never the code that tipped
it over. The remedy is the one written over `copyTank`: a big record is built
as a literal of its REQUIRED fields and a run of assignments for the optional
ones, each checked on its own against the field it lands in. `loadTankTable`'s
twenty-five-field row is the other one that had to be split this way.

**Registers.** "Out of local registers when trying to allocate X: exceeded
limit 200" — the MAIN CHUNK's own locals, so every top-level `local function`
and every named constant at file scope costs one. This one is worse than the
type error: `--verify` still says `0 errors` and the table simply never runs.
Grep the build output for `registers`, not just for `error`.

Only chrome that is **actually above the deck** may lower that ceiling. The
floor used to be the bottom edge of any chrome rectangle overlapping the
deck's column, which was true while the whole HUD was a strip along the top
and stopped being true the moment the wordmark and the readouts moved to the
foot: the readouts still overlap the deck's column and are 836px below it on
the desktop, so their bottom edge as a ceiling put the ceiling under the floor
and the room at zero. The fan did not shrink — it stopped rising at all, at
every viewport at once, with the hover blip still firing over a deck that
never moved. It is `LAYOUT`'s arithmetic now rather than a local in
table.luau, which is what lets `sealitaire:test` hold it at four viewports; a
rectangle straddling the deck's top edge reads as covering it completely, so
the answer is no room rather than negative room.

**Leaving is not arriving played backwards.** Two things make the drop a
glide. The ribbon's HEAD — the point the top card is pinned to — is the cursor
while the deck is hovered and is then simply LEFT WHERE IT WAS, not reverted;
it is only parked back at the column's centre once the fan is already down,
where moving it cannot be seen. Reverting it on the frame the pointer left
yanked the whole ribbon sideways and 34px UPWARD before it fell, under a card
spring of 736 that chases a moved target almost instantly — the fan lurched
up, then dropped. The ease was never what was wrong: the thing it eased toward
teleported. And the fall has its own rate, `stockSettle`, slower than
`stockEase` on purpose — but only for the fall the POINTER caused. A click's
drop (`stockPulse`) keeps `stockEase`, because the top card is flipping away
over it and that one has to be quick.

**Two sounds, and they are different kinds of thing.** `hover` is the EDGE —
one blip as the ribbon goes up, over before it is, choked by `chokeHover` on
the way down. `hoverAura` is the STATE: a quiet bed held for exactly as long
as the pointer is on the deck, faded in and out over `stockAura` seconds on
the table's clock. Both key off `fanWanted` (the pointer and no card in hand)
and NOT off the fan's height, because a click takes the height to zero and it
climbs back with the pointer never having moved — an edge read off the height
fires the blip twice per click, and a bed read off it cuts out mid-hold.

The aura loops by **relay**: `AudioSound` has no loop flag, so `updateAura`
watches the voice and starts another on the frame it completes, the same thing
music.luau does with the track. That leaves up to one frame of silence at the
seam, which a sustained take of a second or more carries and a short one turns
into a pulse. One take is picked as the bed comes off silence and held for the
whole hover — re-rolling at the seam is a swap, not a loop. It is a **stub**
until `hoverAura` in sfxEvents.csv is cast: no takes is silence, not a
warning, and the row's `gain` is where "quiet" is decided.

## Playing it with a pad

A CURSOR, NOT A FLYING POINTER. A thumbstick aimed at a 45px card on a phone
is the part of a pad port that always feels bad — the stick has to be slow
enough to land on a card and fast enough to cross the table, and no speed is
both. There are thirteen places a card can be, so the cursor simply stands in
one of them.

| | |
|---|---|
| d-pad / left stick | move. Up and down walk INSIDE a tableau column first and only step off from its ends |
| south | the thing under the cursor: draw from the deck, take the run, put the run down |
| east | put a held run back where it came from |
| north | send the card under the cursor up, the pad's spelling of the double-click |
| shoulders | jump to the next pile worth being on: a source with nothing in hand, a legal landing with a run in it |
| start / back | new deal / the tuner |

**The grid is the table's own.** `layout.luau` already puts the top row and
the tableau on one seven-column grid — stock at 1, waste at 2, the
foundations at 4..7 — so a cursor is a `(row, col)` on that grid and carries
no coordinate of its own. Column 3 of the top row is the gap layout leaves,
and the walk SKIPS it rather than stopping on a hole. Left and right wrap
(a row is at most seven stops and a held direction that dead-ends leaves you
pressing the other way); up and down do not, because the two rows are the
table's spatial map and pressing up at the top means up.

**Depth shares up and down, and that is the interesting part.** Which card of
a column you take is the whole of the choice, so up climbs the run and only
leaves the column from its shallowest takeable card. What it walks between is
`PAD.band`, which is `K.runFrom`'s answer read as a range — so the pad can
never pick up something a click could not, and the deck is `0, 0` because you
do not pick a card off it, you draw one. Arriving at a pile ALWAYS takes its
bottom card; an index is not a height, and carrying the depth across piles
looks like the cursor jumping about rather than like holding a line.

**The cursor writes `self.pointer` and `self.hoverRaw` every frame, and that
is the whole trick.** Those are the two fields the rest of table.luau already
watches, so the seal's gaze follows the cursor, the hover pop runs down the
run it is standing on, the glow lights, the water's eye drifts toward it and
the deck fans when the cursor arrives there — none of which knows a pad
exists. A second path for any of that is a second thing to keep in step, and
the one that is not the mouse's is the one that quietly stops firing. The
grab and the release are literally the click's: `grabRun` and `releaseDrag`
are shared, and the two callers differ only in where the cards go while they
are in the air (the pointer's, or the cursor's pile).

**A held direction sends nothing.** A pad event carries the device's whole
state and arrives on a CHANGE, so a d-pad held down is one event; what repeats
it is `Pad.step` on the table's clock, `padDelay` then `padRepeat`. The same
"whole state, not the change" is why the button edges are a diff against the
last event rather than a read of `changeKind`/`changeIndex` — which is also
what lets `gamepadConnected` come through the same function, so a pad plugged
in with a button already held records it instead of firing it.

Two smaller ones. A stick at 45 degrees crosses both rails and would step
sideways AND out of the column on one tick, so **the larger deflection wins**
(the d-pad is exempt: two of its buttons at once is a deliberate diagonal). And
an **unknown mapping reports nothing** rather than guessing — the named fields
are false throughout when the embedder could not normalise the device, and
acting on whichever slot lined up would be worse than doing nothing.

Headlessly it is `--gamepad`, which goes through the runtime's own dispatch:

```bash
$HOME/.rive/bin/rive rive/sealitaire --screenshot=/tmp/p.png --advance=30 \
    --gamepad=button@dpadUp:down --advance=3 --gamepad=button@dpadUp:up \
    --gamepad=button@south:down --advance=3 --gamepad=button@south:up \
    --advance=20 --data-dump
```

and `build/sealitaire.data.json` has `moves` and `score` in it, which is how
you tell a press that did something from one that did not. **Build the flags
as a shell ARRAY**: zsh does not word-split an unquoted `$VAR`, so a
`--gamepad` sequence built up in a string arrives as one mangled argument and
the run passes having done almost nothing.

## Playing it with a finger

Nothing in a `PointerEvent` says whether it came from a mouse or a thumb, and
it has to be known, because a finger covers the card it is dragging. What
tells them apart is the FREE MOVE: a mouse reports where it is on the way to a
click and a finger never does, so **a press landing somewhere the pointer has
never been reported is a touch**. It is sticky, so a second click in the same
spot does not flip it, and a free move puts it back to mouse — which is also
what puts the pad's cursor away, so the three devices hand over between
themselves without a setting.

**The lift.** A touch drag carries the run `touchLift` of a card HEIGHT above
the contact point, so you aim with the card rather than with your thumb. It
rides in the grab OFFSET rather than being added at the draw, which means the
drop reads off the lifted card too — `pileUnder` is handed the head's own
position, so the pile you are over is the one the card is over. The card's own
spring eases it up; nothing snaps.

**One gesture at a time.** A pointer event carries the id of the pointer that
made it, and on a phone that is a finger. A second thumb landing mid-drag
arrives as an ordinary `pointerDown`, and `self.drag` is one slot: the new
press overwrites it and the run already in the air is never released — it
hangs at z 5000 over the table until the next deal. So a gesture CLAIMS an id
and events from any other are dropped, without `event:hit()`, so they go on to
whatever is behind rather than being eaten.

The claim is released **only while a gesture is actually in flight**, and the
three things that can be are named rather than trusted to the id. An `up` that
never arrives is not a rare case on a touchscreen — a finger can leave the
glass outside the window, or the page can lose the pointer to the system — and
an id claimed on a gesture that has quietly ended would leave the table deaf to
every finger but that one, for good.

**There is no `pointerExit` when a finger leaves the glass.** The pointer does
not travel out of the window, it stops existing. So a touch `pointerUp` ends
the hover itself; without it the card a tap lit up stays lit, with the seal
staring at it, until something else is touched.

What a finger does NOT get is the deck's fan, which is a hover, and the tuner,
which is a panel of 11px sliders. The fan's absence costs nothing — a tap on
the deck draws — and the panel is a desktop tool.

## Two ceilings in table.luau, and the errors they throw

This file is 6,000 lines and sits close to two of Luau's limits. Both fail in a
place that has nothing to do with the code that spent the budget, so they are
worth recognising on sight.

**"Code is too complex to typecheck"** is the per-file INFERENCE budget, and
the line it names is the most expensive expression in the file rather than the
one that tipped it — for years that was a whole-record `TankRec` literal, now
hoisted into `copyTank` to buy the room the cursor needed. If it comes back,
look for what was ADDED, not at whatever line it points at. A named record
(`pad: PAD.State`) costs one field where a dozen loose ones cost a dozen, which
is why `goo`, `music`, `puppet` and `bub` are carried that way too.

**"Out of local registers"** is the main chunk's 200 registers, one per
top-level `local function`, and unlike the other it fails at LOAD rather than
at build — `--verify` says `0 errors` and the table simply never runs. It
names whichever function was being allocated when the count ran out. A table of
functions (`local Pad = {}`, then `function Pad.step(...)`) costs one register
for any number of them. A `do` block is the other lever: a block's locals are
released at its `end`, so a function with private data beside it — `suitBg`
with its key list and its buffer — declares the name outside and everything
else inside, and costs ONE register rather than three. It is worth reaching
for both whenever a change adds more than a name or two at file scope: the
file sits ON this ceiling, and three new ones is what broke it last.

## The card's edge

A card has no cream plate showing round it and no drop shadow worth the name.
What separates it from the water is a **rim**: a bevel a few artboard px wide
inside the card's outline, shaded per-pixel in `crt.wgsl` by one of seven
materials — `pearl`, `emissive`, `metallic`, `reflective`, `refractive`,
`holographic`, `chrome`. **R** cycles them live; `cardRimMode` in tuning.luau
is the saved one, `cardRimWidth` the band, `cardRim` the strength (0 is a card
with no edge at all).

`chrome` is the one the trim ships in. Ethan drew the trim in the editor as a
7px stroke on the Plate's outline clipped to the Face — the 3.5px band inside
the edge, grey, in `table-cards.rml` — and that grey is the no-GPU fallback:
the shader's band is the same signed distance at `cardRimWidth` 3.5, so it
lands on the markup's stroke to the pixel. The material is a half-round wire
with a brushed grain: it mirrors the water (`surface.wgsl`'s picture, smeared
along the grain, tinted by the metal) so the caustics and sky arrive on the
edge, carries one anisotropic glint that travels the perimeter and flares with
the table's energy, and ends in a dark seam where it meets the plate.

Its geometry is the **same rounded-rect signed distance the tank window is
keyed by**, so the two can never drift apart: the window is `d <= 0`, the rim
is the band just inside it. The bevel is a true quarter-round — the normal
rolls from pointing straight out of the outline to straight at the viewer over
the band's width — and it is turned back into screen space by the card's own
`(cos, sin)`, so a tilted card's highlight tilts with it.

**The metal is tunable** — `rim` in the tuner: tint (grey to gold), body,
grain strength and line count, glint strength and width, mirror, seam. Both
metal modes read the same rows (uniform rows 6 and 7). This is the ONLY
place to tune it: the Rive editor has no WGSL, so nothing of the rim exists
there, and a push shows the markup's grey stroke and nothing else.

The mode is per **entry**, not global. `table.luau` writes the tuner's number
into every card today; a rim per suit, per rank or per "this card is hot" is a
change to what that loop writes and to nothing else.

The card table the CRT reads now holds **every card on screen**, not only the
tanks — a face-down card in a fan gets its edge shaded like any other, and
`hasTank` is what separates a card with a window from one without. The entry
index is what the mask paints, so it is also the z-order key, and the mask is
one draw per card instead of two.

**The mask must be read with a NEAREST sampler.** It is an index, not a
picture: filtered, its red blends across a card's outline, the entry comes back
wrong, the window misses by a pixel or two and whatever the plate is shows
through the seam. In cream that was a hard white line drawn around every card
in the game, and it looked exactly like a deliberate border. Group 0's eight
slots are spoken for, so the nearest sampler rides in group 1 beside the ink
atlas.

Two more things that make a material read wrong rather than not at all. A hue
wedge (`clamp(abs(k-3)-1)`) bands hard at the primaries, so a holographic rim
built on one is a painted rainbow stripe, not foil — the cosine ramp has no
edges in it, and mixing white under it is what makes it metal. And hue must
travel ROUND the edge, not across the band: the band is a few px wide on
screen, and a full sweep over that width is four stripes.

## The suits

A card is **red or black**, and both say so twice.

**The background is the SUIT's.** Four colours, one per suit, as twelve
tuner rows under the `suits` header — `bgHeartR/G/B`, `bgDiamondR/G/B`,
`bgSpadeR/G/B`, `bgClubR/G/B`, named for the mark the card PRINTS rather than
for the theme's key (tanks.csv still reads `Q star`; the panel's card header
reads `card Q diamonds`). They are resolved in `drawFish` EVERY FRAME
rather than baked into the record at load, so dragging one repaints thirteen
cards while you watch; baking it at parse time is the version where a drag
does nothing until the next reload. `tankBg` still scales all four, and sits
at 1 so a suit row IS the colour it shows — at 2 every channel above 0.5
clamped to white and half of each slider did nothing.

A tanks.csv `bg` cell OVERRIDES one card, for the one that wants its own
water; it is blank on all 52, so the four rows are what the table shows.
`TankRec.bg` is `{ number }?` and nil means "the suit's": `colourOf` seeds a
card its own copy the first time a bg row is DRAGGED (the same bargain
`drop` and `colGap` make), `subjectGet` reads without seeding — a panel that
merely displayed a card must not hand it a cell it never asked for — and the
panel prints an un-owned bg with the same `~` a layout row gets. SAVE writes
the cell blank unless the card owns one, so auditioning a suit cannot freeze
a copy of it into 52 rows.

Before this it was per CARD and the fallback was two constants, warm for a
red suit and cold for a black one, which could not tell Heart from Diamond at
all — and setting the table's colour meant editing 52 rows.

**To audition four of them:** `npm run sealitaire:bg` renders the table once
per candidate palette into `build/bg/`, with an index.html, editing only a
SCRATCH COPY of the project so a palette you do not keep leaves nothing
behind. Every frame is the same deal (`--data=lab=deal`), so two palettes
differ only in the thing being looked at. `sealitaire:bg mine '#FFF1F2'
'#FFF8E7' '#EEF4FF' '#EFF7EE'` renders one of your own, fish/star/bubble/shell
in that order. Keep one by putting its hexes in the `bg<Suit>` rows, or drag
them in the tuner and press SAVE.

It works at all because the tank atlas is now cleared to **nothing** and the
background is composited in `crt.wgsl`, one colour per card table entry. One
clear serves all 56 tiles, so a clear colour can never be per card. Both
atlases are treated as premultiplied there: `f.rgb + bg * (1 - f.a)`, not
`f.rgb * f.a + …`, which looks identical on a body and loses a quarter of the
colour on every antialiased edge of one.

**The mark.** The suit prints as a vector under the rank in `Corner`: four
nodes bound to the same `fish`/`star`/`bubble`/`shell` flags table.luau already
sets per card, so exactly one is opaque, and a fill bound to `ink` like the
rank's, so the mark is red or black without the table knowing a mark exists. It
went in via `npm run sealitaire:svg`, which rewrites an SVG's cubics into Rive's
POLAR form (`inRotation`/`inDistance` on the on-curve vertex, not the two
off-curve points an SVG `C` writes). That importer is one-shot: the vertices in
table-cards.rml are the source now, and `art/suits.svg` is kept only as provenance.

Because the mark lives in `Corner`, it lands in the ink atlas with the rank and
`inkGlow` haloes it for free — which is the whole reason it is legible on a dark
tank, since unlike the rank it carries no glow copies of its own. Give it some
if the editor ever wants them; the rank's three are the pattern.

Placement was MEASURED off a render, not guessed: at fontSize 41 the rank's ink
runs to y=43 in card space, so the mark sits at `Suit_ROOT` (11.5, 49.5) at 15px
— a 4px gap under the glyph. Its x centres it under the DIGIT ranks, which are
eight of the thirteen; `A J Q K` sit a little wider and `10` overflows the
30px corner on its own, as it always has.

**The rank is lit.** `RED` is red and `BLACK` is near-black — and neither is
legible on a dark tank unaided, so neither is asked to be. `crt.wgsl`'s
`inkGlow` feathers a halo out of the ink atlas and tints it by the suit: red
behind a red rank, **white behind a black one, pulsing on the beat**. Before
this the black suits printed PALE, which made a deck of two near-identical
light inks.

`inkGlow` (strength) and `inkGlowSize` (artboard px) are in the tuner. Three
things about how it is built:

- It is computed **once per pixel**, in `fs()`, not inside `layer()`. `layer()`
  runs three times for the chromatic split, and a fourteen-tap blur three times
  over is forty-two samples a pixel to fringe something too soft and wide for
  the fringe to show.
- The taps walk a **golden-angle spiral** over the disc, `sqrt(i/n)` for even
  coverage by area. Eight fixed directions at two radii put eight spokes in the
  halo and read as a star stamped behind the rank rather than as light.
- The `Plate`'s Inner Border follows `plate`, so it is hidden on the ink-only
  instance. The ink atlas holds the RANK and nothing else — left in, the glow
  would feather out of the card's whole outline instead.

**The beat** is `self.beat` in table.luau: an onset ENVELOPE, kicked by a band
firing in music.luau and decaying at `BEAT_DECAY`. It is a kick and a decay,
not a level read every frame — a level is loud for as long as the note is and
reads as a slow swell, which is the opposite of a beat. Low bands count for
most of it (a kick is the beat, a hi-hat is ornament), and it is kicked before
the `musicRipple` gain gate, so at `musicRipple` 0 the water stays still and
the cards keep hearing the track. Measured over this track: 2.8 fires a second
once it is going, the envelope swinging 0.16 to 1.0. The first few seconds are
the track's own quiet intro — a screenshot at `--advance=90` sits in it and
shows only the floor, which is not the glow failing.

## Where the meshes sit in a card

Nothing about a body's placement is in the Rive file. `fish.mesh` is one frame
per species at rest, head at -z and length 1 (`npm run sealitaire:fish`, baked
from tanks.csv); everything about WHERE a body is comes from `baitball.luau`,
which fills a per-instance model matrix that `fish.wgsl` reads. So:

- **`FORMATION`** — the seat grid per count, as (column, row) in [-1, 1]. A 7
  is seven of these. This is the layout to edit to change what a number looks
  like.
- **`seat()`** — where body *i* wants to be right now: the formation seat, the
  tilted ring it slides onto while `excite` is up after a play, or, for a lone
  creature, a loop in the card plane.
- **`wall()`** — the hard limit. The card's four edges are the camera frustum
  at the body's own depth, and both nose and tail are kept inside.
- **`tanks.csv`** `size` scales one species; the tuner's `fishSize`,
  `fishRadius`, `fishSpin`, `fishScatter` shape the whole set, and
  `pipColGap` / `pipRowGap` scale the formation's column and row spread
  (1 is the padded seat edge; more reaches toward the walls). A tanks.csv
  row's `colGap`/`rowGap`/`padX`/`padY` override the four globals for that
  card; blank means the global.
- **A court card's creature holds still.** `holds` in the inputs (rank 11+
  from the tanks.csv row) makes a lone body sit centred and broadside with no
  loop and no drift; a press or a drag still moves it. An ace's predator
  still loops — unless its row's `loop` says `0` (the four aces do now: the
  sharks and the orca hang in the glass rather than circling it). `loop=1`
  on a court card makes it circle instead. Blank is the rank's default.
- **A court card's creature ENTERS.** On the frame its face first shows it is
  put past the right edge of the glass, nose in, and pushed toward its seat
  (`entranceSpeed`, tank units/s; 0 is no entrance); `enter` on the body
  holds that one wall open until nose and tail are both inside. A school does
  not — the number has to be there on sight.

**Six sliders bias the whole formation** (globals under `tanks`, each
overridable per card by a tanks.csv column of the shorter name):

| tuner | row | what |
|---|---|---|
| `pipDrop` | `drop` | world units the formation is biased DOWN the card; negative lifts it. Fourteen number cards carried one from when drop clamped PER SEAT and squashed a number rather than moving it — the fix turned each into a number shoved against the bottom edge with a gap above, which is what "the layouts lost their symmetry" was. Those were cleared. A drop on a 2-10 is a real choice now that it moves the formation as one; `npm run test:sealitairetune` lists the cards carrying one so a stale value cannot hide, and `rowGap` is what TIGHTENS a number |
| `pipRotate` | `rotate` | radians every body leans IN THE CARD PLANE, all on one visual axis |
| `pipRotateVary` | `rotateVary` | radians of extra lean either side of that, per body |
| `pipYaw` | `yaw` | radians every body turns about the card's VERTICAL, positive nose toward the viewer |
| `pipRoll` | `roll` | radians every body rolls about its OWN LENGTH, positive belly toward the viewer |
| `pipSway` | `sway` | 0..1 of the idle rock and breathing drift; 0 sits dead still (a play or a drag still throws it) |

Those are the three axes of a body — lean, yaw, roll — and they are three
different kinds of number on purpose. Lean and yaw are rotations of the
REST HEADING (the vector the nose eases back to), so they go through the
turn cone and the wall test like any heading and a yawed snout is still
kept inside the glass; roll is added to the model matrix's Z rotation in
`write`, beside the idle wobble, because a heading vector has no roll in
it. Yaw, like the lean, is on the visual axis rather than the body's — the
z it produces carries no row sign — so a row facing left and a row facing
right turn their noses toward the glass TOGETHER. A yawed body reaches
toward the camera, where the frustum is narrowest, so a lone body's seat is
not "z = 0, centred": `fitBox` takes its rest heading and length and
returns the box its CENTRE may sit in with both ends clear of every wall —
the seat offsets toward the back, or is centred when nothing fits. Before
that the spring pulled a big yawed orca back to z = 0 and the front wall
reflected it out again, every frame, for ever. The same box runs after the
wall passes for every body: an axis with no room parks at the midpoint with
its velocity zeroed, because a reflection only means something when there
is somewhere to reflect to. Three more rules keep a body BIGGER than the
tank from fighting it, each found on a yawed orca at size 3 after a drag:
the seat is clamped every frame into the box the body's ACTUAL heading fits
(the rest heading's box is not where a turned body can go); the walls are
measured at a depth inside the tank whatever depth an end is at (past the
front glass the frustum is a few hundredths wide — a wall nothing can
satisfy); a HOLDING body never turns its nose to follow a shove, and a
looping one's turn cone is narrowed until its ends fit the room, because a
long body that pitches puts its ends through the walls and the walls put
them back, for ever. `sway` is what "kill the
animation loop" on a shark means: the rock is `sin(spinPhase*6) * 0.12 *
(0.6*sway + excite)`, so a card at 0 is still shaken by a play. The sharks,
the hammerhead, the orcas and the turtle sit at 0 in tanks.csv; the
crab keeps its rock.

**Row -1 is the card's BOTTOM.** `seat` multiplies `FORMATION`'s row
straight by the fitted span and world +y is up, so a negative row is low on
the card. The seven had its odd pip at -0.5 and so printed upside down: the
double gap — the one gap a seven has that is twice the others, which is the
shape of a seven — sat at the TOP, with the rows reading 0.656, 0.000,
-0.328, -0.656 from the top down. It is at 0.5 now, the eight's upper pip
with the lower one taken away, and the double gap falls between the middle
and bottom rows where the eye expects it. Every other odd count puts its extra
pip dead centre (3, 5 and 9 are all `{0, 0}`), which is why the seven was the
only one that could be wrong this way. "the seven puts its double gap at the
bottom" in `tests.luau` holds it there.

**The grid is the SCHOOL's, never a body's own.** A school's bodies are
scattered ±15% in length round the row's `size` (`LEN_MIN`/`LEN_VARY`), so the
number reads as a shoal rather than a stamp — but the formation used to be
fitted from *each* body's length, and a short fish then sat further out than
the long one beside it. No column was straight and no row was level: 4px of a
120px card at size 1, 13px on a big one, and the drop made it worse, because
its room was per body too, so every fish fell its own distance and the rows
sheared apart (six fish came to rest with the top row 0.155 apart, a tenth of
the card's height). `schoolHalf()` is the one length the resting grid may
know — half the LONGEST body the school can hold, so the grid is a grid and
the longest nose still clears the rank. Only the WALLS are a body's own.
"the number is a grid, whichever fish is the long one" in `tests.luau` asserts
both halves of that: the rest positions MIRROR about the centre line, and two
seeds — two different deals of lengths — settle to the same number to the
pixel.

Three things they get right that the obvious version does not. `pipDrop` is
**clamped to the padded seat box** rather than added raw — past the edge the
seat spring just holds every body against the wall, so every value above the
one that first reached it looks identical. World +y is the card's TOP (the
tank camera's up is +y and the tile is written y-up), so a positive drop is a
negative y. And the lean **rotates the facing VECTOR**, it is not added to an
angle: a body facing -x then comes out on the same visual axis as one facing
+x, so a row of fish pointing opposite ways still all lean the same way, which
is the only thing a uniform rotation can usefully mean here.

`rotateVary` reads the body's own hash, not the clock, so it is a stable
scatter rather than a per-frame jitter. Both feed `restHeading`, which returns
a VECTOR now; `clampCone` takes the full rest vector to match, since the turn
cone has to be measured around the leaned facing rather than around +x.

The per-card overrides read the cell's PRESENCE, not `or`: these are signed,
and a row meaning 0 would otherwise fall straight back to the tuner's number.

**The seats and the walls are separate, on purpose.** The rank prints in the
card's two far corners, and a body resting under it hides the thing the card
is for — but a body *shoved* there is the whole point of shoving it. So
`seatHalf()` pulls the RESTING seats in by `fishPadX`/`fishPadY` (world units; the card is
2·dist·tanHalf ≈ 2.59 tall for 168 artboard px, so 0.18 is about 12px of card)
and `halfAt()` — the wall — is untouched. A press, a drag or a play still
throws a fish right into the corner, and it swims back out from under the
number on its own.

Both axes are measured the same way now: the seat edge, less half a body, so
the NOSE is what clears the number rather than the centre. The row span used
to be a flat `0.9` — a number that happened to fit one camera and ignored both
the body's length and any padding.

## The knock

A body hitting the glass sounds the size of the body, and sits on a send
bus with a reverb and a low-pass that sweeps down. Rive's `AudioSound` is
transport and volume — no pitch, no filter, no send — so all three are
PRINTED: `npm run sealitaire:sfx:fx knock` bakes every `tankWall` take at
five pitch steps (`<take>-p-2` … `-p2`, six semitones a step, an octave each
way, resampled so a low plop is also a long one) and a BUS copy per step at
four low-pass cutoffs (`knockbus-p<k>-c<c>`, reverb then 24dB/oct at 12000,
3000, 1000, 400 Hz), into its own `SFX KNOCK` block in scene.rml.

`knock.luau` is the arithmetic, pure and tested: `step(len, ref, octaves)`
turns the knocking body's length (the hit carries it) into a rung —
inversely proportional, `knockPitch` octaves per doubling of size against a
size-1 body (`T.fishSize`), so a sardine ticks and an orca thuds — and
`sweep(s)` turns `busSweep` 0..1 into the two cutoff rungs it sits between
with equal-power weights. `playKnock` in table.luau then plays at most three
voices: the dry rung, and the two bus rungs at `busSend`. That IS the send
bus and that IS the sweep — coarse, and the only version this runtime can
play. `knockPitch`, `busSend`, `busSweep` are under `knock` in the tuner.
The bake's ladder (the `KNOCK` table in the FX tool) is mirrored in
knock.luau's `STEPS`/`CUTOFFS`; `test:sealitairesfx` holds the files and
`sealitaire:test` the arithmetic. A card whose row names its own `knock`
event plays that through `playSfx` as before, unpitched.

## The clips

A row's `clip` cell names one of its model's animations — a case-insensitive
substring of the name, `Dance`, `swim`, `Turtle_idle` (`npm run
sealitaire:clips` lists them) — and `npm run sealitaire:fish` bakes that clip
into the pack as a **bone palette**: 30fps samples of every joint's matrix,
which `table.luau` uploads once per species as an `rgba32float` texture
(three texels a bone, the rows of its 3x4; a row per frame) and `fish.wgsl`
skins from in the vertex shader, per instance, at that body's own phase. A
school of one species swims out of step. Blank is the rest pose, which is a
one-bone identity palette and the same shader path — a still creature costs
one texel read and no branch. `clipSpeed` and `clipWeight` in the tuner scale
the rate and the pose for every clip at once.

Three things about how it is built:

- **The GPU API has no storage buffers and no per-instance uniforms** —
  `GPUBuffer` is vertex, index or uniform, and a bind group is a uniform plus
  textures. A texture is the only thing big enough for a palette AND readable
  per instance, so that is what it is; `GPUTexture:upload` is the one CPU
  → texture path, and `textureLoad` in a vertex stage works (the binding map
  derives visibility from the shader).
- **The palette is RELATIVE to the rest pose.** The vertices in the pack are
  already posed at rest and in the canonical frame (centred, long axis z,
  head at -z, length 1), so each bone's matrix is `C · G_f · G_rest⁻¹ · C⁻¹`:
  it moves a REST-POSED canonical vertex to its posed canonical position.
  Exact where rest is bind (every model here); for a vertex split across
  joints it is the ordinary delta-skinning approximation. It is what lets a
  skinned and an unskinned species share one vertex layout — an unskinned
  vertex is joint 0, weight 1, and joint 0 is always the identity.
- **Rigid parts animate too.** cutesquid and jellyfish have no skin; their
  clips move mesh NODES. Each animated mesh node gets a bone of its own
  (its rest is its world matrix) and rides the same palette. A rig past 255
  joints (the jellies, the anglerfish) bakes at rest and says so.

`npm run test:sealitairefish` skins every clipped species on the CPU the
way the shader does and checks the body MOVES between frames and stays its
own size — a baker that wrote identity palettes, or a relative-palette bug
that blew a body up, fails there rather than rendering something plausible.
No row in tanks.csv names a clip yet; the crab's `Dance` was the proof
(`4 shell` `clip=Dance`, then look).

The seal's clips are the other baker: `npm run sealitaire:mesh -- --list`
names furseal.glb's eleven, and `--idle=bark --swim=run --boost=roll` fills
the three roles puppet.luau plays from any of them.

The four creatures that only existed as `.fbx` (seagull, beluga, moray,
trout) are in the pool now via `npm run sealitaire:fbx -- <name>`: mesh, rig
and clips, UVs flipped to glTF's frame (the trap in `build-anglerfish.mjs`),
maps stripped, morph-target tracks dropped (the moray's clip carried three).
Nothing is welded, so the beluga and the moray are heavy in the LAB bake;
they are pool rows, not tank rows.

## The dent

A body that hits the glass squashes. It is flesh, and it is deliberately not
pose: `fish.wgsl` skins the vertex exactly as it always did and then warps the
POSED vertex in the body's own space, so the bone palette, the joint weights
and the clip's phase are never touched — a swimming creature keeps swimming
through its own dent, no joint can come apart, and a dent of zero is the
exact identity and an early out. The alternative, writing squash into the
bone matrices, is the version that breaks skeletons: the baked palette is
relative to rest (see the clips), so a scale spliced into it compounds with
the pose rather than sitting beside it.

**The split is: baitball.luau owns every number that moves, fish.wgsl owns
the shape.** Per body the sim latches the contact's direction and where along
the length it landed, and rings a spring back to nothing; the shader is a
pure function of those three plus the four numbers under `dent` in the tuner.

Five things it gets right that the obvious version does not.

- **The dent is driven by the CONTACT, not by the knock.** `wall()` already
  returns the closing speed and which wall, and `update` already keeps the
  hardest per body per frame — but the knock that comes out of it is
  throttled by `hitSpeed` and `hitGap` so a body scraping along the glass
  does not machine-gun. A touch too quiet to hear should still squash, and a
  second bounce inside the gap should still squash. Same contact, two gates.
  `a touch too quiet to knock still dents the body` holds it.
- **It is latched in the BODY's frame.** Expressed in tank space instead, the
  squash would rotate across the animal as it turned and a still fish would
  shimmer. That frame is `write()`'s — `yawPitchOf`, `rollOf` and
  `toBodyLocal` are functions precisely so the frame the squash is in and the
  frame the mesh is in cannot drift apart; if they ever did, the dent would
  land on the wrong side of the animal and nothing would error. `the dent is
  latched in the body's own frame` takes the direction back out through the
  model matrix's own axis columns, on the latch frame, and demands the wall's
  normal again.
- **The volume goes back in ACROSS the hit, but not evenly.** Spreading it
  over both cross axes — the textbook `1/sqrt(s)` on each — stretches an
  elongated body along its own length, and a fish that gets longer when you
  hit it reads as taffy. The share that runs down the body is tied to how
  axial the hit was: broadside bulges sideways and keeps its length, nose-on
  has nothing but the cross-section to bulge into. Either way the three
  factors multiply to 1, so a dent is never just a body that got smaller.
- **The outline dents too.** `vsLine` is the same mesh drawn again as an
  inverted hull off the same instance buffer; warping the body and not the
  line pushes the creature straight through its own outline.
- **The spring is analytic, not Euler.** Semi-implicit Euler on a spring is
  stable only while `omega * dt < 2`, which a 12Hz ring passes on the first
  slow frame — and the thing that would find it is a body exploding on a
  hitch rather than a test. It also ends at EXACTLY zero rather than merely
  small, because zero is the shader's early out.

The normal takes the reciprocal of the same scaling plus the wave's slope; it
drops the gradient of the falloff itself, which is second order for any
spread worth using and the alternative is finite-differencing the whole warp
three more times. Without any of it the cel terminator stays pinned while the
body moves under it, and the squash reads as the texture sliding.

The instance record grew a tenth column for it (stride 144 → 160, slot 13);
the dent's place and age ride in `anim`'s two spare slots, which is why it
cost one column rather than two.

`dentAmount` 0 is off, everywhere, at no cost. The seal is the other skinned
thing here and could take the same treatment — `seal.wgsl`, driven by a
uniform rather than per instance — and does not have it yet. **Bodies still
only collide with WALLS**: fish pass through each other. Pairwise at sixteen
bodies is 120 tests and cheap, but it fights the pip formation, which IS the
card's rank — bodies shoving each other off their seats makes a 7 harder to
count, so it is a decision rather than an omission.

## The rigs

`rigs.csv` names the species whose SKELETON survives the bake. A species with
a row keeps its joints and weights, every bone's parent and rest head, and
the chains a contact may shove; one without is flattened onto a single
identity bone exactly as before. Seven are in: greatwhite, megalodon,
mightymeg, hammerhead, dolphin and the two orcas — 246 bones in 30 chains,
96 of them sprung.

**The chains were not invented here.** They are copied verbatim out of the
`springChains` in `path/src/assets.js`, which drive
`path/src/systems/boneSpring.js` on these same `.glb` files in the game
proper, already measured and already tuned. `role` is what a chain is for
and what its looseness keys on: a `tail` is the body's own run of spine, a
`fin` is a control surface that should lag rather than stream.

Three things about getting them across.

- **The names have had their dots stripped.** `path/src/assets.js` carries
  the spellings GLTFLoader produced, and the raw node in greatwhite.glb is
  `Bone.003_Armature_5` where assets.js says `Bone003_Armature_5`. Matched
  raw, greatwhite resolved 0 of 11 bones and megalodon 2 of 16 — and the
  game's own lookup DROPS a name that misses rather than failing, which is
  how the orca cow lost her whole dorsal on half of all boss arrivals. The
  baker matches on the stripped spelling, so either form works, and it
  THROWS on a miss.
- **A rig no longer needs a clip.** `skinned` was `wantClip && !tooManyBones`,
  so a rigged model with no `clip` cell had its joints and weights thrown
  away at bake time — and no row in tanks.csv names a clip, so until now
  every vertex of every species in the pack was joint 0, weight 1. It is
  `(wantClip || wantRig)` now, and a rig without a clip gets a REST palette:
  one frame of identities, one per bone, which skins to exactly the pose the
  vertices are already in. The cards look the same to the pixel — that is
  the check, and greatwhite passes it.
- **The pack is TNK3.** Two new blocks between the indices and the palette —
  bones (parent slot, rest head in canonical space) and chains (role, count,
  slots) — and sixteen more bytes per species record. The loader still
  accepts a TNK2 pack, so a bake from before rigs.csv is not a broken game.
  `npm run test:sealitairefish` checks what a solver would trip over: a
  parent that is not above its child (a cycle that would hang the
  composition), a slot outside the palette, a chain of one bone, and a rest
  head that has landed off the body — which is what a canonicalisation that
  missed the rig looks like, and it would still render a perfectly good
  creature.

**What drives them** is `bonespring.luau`, a port of the solver in
`path/src/systems/boneSpring.js`, and `tankrig.luau`, the glue. Each bone's
DIRECTION is handed to a spring that chases where the rest pose put it, so
the chain declines to keep up; the contact that dents a sardine is injected
straight into the spring velocities, and the spring carries the shove down
the body and settles it. Bones solve root to tip and each measures its
target AFTER its parent has moved, which turns the lag into a travelling
wave — and that wave is the entire reason to use a skeleton here. A vertex
warp has no per-joint state, so its tail can only move while the dent that
made it is still moving; a tail that keeps swinging after the head has
stopped is a thing only this can do.

The reaction rides to the GPU as a **bend palette**: the same shape of
texture as the clip palette, but a row per INSTANCE rather than per frame,
identity everywhere nothing has been hit. `fish.wgsl` multiplies it onto
each joint's clip matrix inside the same weighted loop the pose uses —
`Bend_k · Skin_k` — so the rig's own weights do the blending and the
skeleton cannot come apart. `npm run sealitaire:test` holds that: each
bone's bend must carry the NEXT bone's head to exactly where its own tip
went, and nothing in a render would say otherwise if it did not, because
the skin stretches between the pieces and reads as bad weighting.

**What makes a contact at all is narrower than it looks**, and it is the
first thing to check when the tanks seem dead. Measured over 600 frames:

| | contacts | peak dent |
|---|---|---|
| a card sitting there, one body or five | **0** | 0.000 |
| a card PLAYED | **0** | 0.000 |
| a press | 7 | 0.438 |
| a drag | 246 | 1.025 |

`fishPadX`/`padY` hold the resting seats well inside the walls on purpose
(see the seats-and-walls note above) and the swirl's ring is fitted inside
them too, so neither an idle card nor a played one ever puts a body on the
glass. **A press and a drag are the only two things that deform anything.**
A test holds those three numbers, because "I see nothing" and "it is broken"
look identical from the outside and this is the difference.

That is a design question rather than a bug: if a played card should slam
its school into the glass, the swirl needs to reach past the seat box, or a
play needs to scatter the way a press does.

**Two bugs shook the big animals apart**, and both only appear under a
SUSTAINED contact — a body held against the glass by its own seat spring,
which is most of what happens in a corner. Neither shows in a single bounce,
which is why they survived the first pass.

- **Relative caps compound.** `rigMaxLag` is measured against the PARENT's
  carried rest, which is what makes the wave — every bone allowed to be a
  little behind the one above it. But six bones at 28° each is 168°: under a
  steady shove every joint saturates and the tail folds through the animal.
  A scrape drove a six-bone tip to a full 90° from rest. `rigMaxBend` caps
  the angle from a bone's OWN rest as well, whatever its parents did, and is
  what stops the fold.
- **An impulse is a change of velocity, not a force.** Handed one on every
  frame of a contact, the chain takes energy in faster than the damping
  gives it out: the measured tip velocity climbed past 54 and kept going,
  which is the buzzing. Two answers, and both are wanted. baitball shoves
  the skeleton on the EDGE of a contact only — a 240-frame scrape is one
  shove now, and a test says so — and the solver carries a rate ceiling off
  its own natural frequency as a backstop for any caller that does it
  anyway. The DENT deliberately keeps taking every frame: it is a spring on
  a scalar that saturates, and a body leaning on the glass should stay
  squashed.

The edge needs its own reference (`kickRef`), held for as long as the
contact lasts. Comparing against `dkick` to decide whether a later, harder
knock deserves a fresh shove does not work — `dkick` is cleared at the top
of every frame, so that test is `speed > 0` and fires on all of them. It
read as fixed and measured 232 kicks in 240 frames.

Five more things cost a while each, and all five were silent.

- **The instance cannot ask which instance it is.** `@builtin(instance_index)`
  is refused outright by the Metal backend — "attribute 'instance_id' is not
  supported for target MSL version" — which is a compile error and no
  picture at all. The row rides in a column of the instance record instead
  (`rig.x`, slot 16). Packing it into the whole number of `anim.x` would
  have been free, since the pose already read the phase through `fract`, but
  `anim.x` MEANS the clip phase and there is a test that says so.
- **The pose weight was fading the bend.** `skinOf` blended its whole result
  toward the identity by `anim.y`, which is the clip's weight — and since no
  species names a clip that weight is 0 on every body in the game, so the
  entire reaction was multiplied away. The fade now happens per joint,
  around the clip only.
- **The upload was inside the outline pass**, which is where the instance
  buffers go up — and that pass is skipped entirely when `lineWidth` is 0,
  which is the default. The solver ran perfectly and the texture never
  reached the GPU. It goes up on its own now, before either pass.
- **Luau has a type-inference budget, and it is per module.** The glue
  inlined into table.luau pushed the file over it, and the error is not
  "this function is too big" — it is `Code is too complex to typecheck`
  pointing at an unrelated table constructor three hundred lines away, then
  a cascade of `Internal error: Lambda has non-function type`. `tankrig.luau`
  exists for that reason.
- **A chain ending on a LEAF needs a tip length.** The last bone has no next
  bone to point at, so it takes a real child of its own if the rig gives it
  one and otherwise carries straight on at the previous bone's length.
  Without the fallback its direction is zero-length, the solver skips it,
  and the chain springs with a dead final bone — which reads as bad tuning.

The numbers are under `rig` in the tuner: `rigImpulse` (0 holds every
skeleton still), `rigStiff` and `rigDamp` at a chain's root, `rigTipLoose`
for how much softer the tip is, `rigMaxLag` for how far a bone may leave its
rest, and `rigSpread` for how far along the body a contact is felt. They are
first guesses off a held shove rather than a real bounce and want a pass.

A sleeping chain costs one compare and uploads nothing, so a table of
sardines never touches any of this. **The schools keep the vertex dent**,
which is the right split: a sardine is four pixels of body and a bend in it
is a bend nobody can see. The seal is still the other skinned thing here and
still has neither.

## The glow

`bio` on a tanks.csv row (0 is off, the default) lights that card's bodies
with a **noise field in TANK space**: `fish.wgsl` samples Perlin fbm at the
fragment's position after the model matrix, not on the body, so one field
runs through every body in the tank and a school lights in a wave that
crosses from fish to fish rather than each carrying a private pattern. It
travels at `bioSpeed` tank units a second along `bioPan` (degrees: 0 across
the card, 90 up it), and separately EVOLVES — changes in place, by walking
the noise's third axis at `bioEvolve` — so a still field can still live, and
a fast one can be a fixed pattern sliding by. `bioStretch` draws the patches
out along the travel so a pan reads as a current; `bioOctaves` is how much
fine grain rides on the big shapes (the fbm is normalised, so coverage means
the same at every count); `bioContrast` sharpens the field before the cut;
`bioWarp` bends it with a second field; `bioPulse`/`bioPulseRate` breathe
the whole glow. `bioColor` tints it per card; `bioStrength` is the master,
`bioScale` the feature size, `bioCoverage` how much of the field lights,
`bioSoft` the shoulder — all under `biolum` in the tuner, and `bio`/`bioR/G/B`
are rows of the card lab. Six of them go PER CARD as well — `bioSpeed`,
`bioScale`, `bioContrast`, `bioCoverage`, `bioPan`, `bioEvolve` — as
tanks.csv columns and lab rows that read the global until dragged (the
`yaw`/`roll` pattern, LAYOUT_ROWS); they ride the instance buffer, so two
cards on one screen can run two different currents. Stretch, octaves, warp,
pulse and softness stay global. The atlas is
8-bit, so it clamps rather than blooms: a saturated colour at an honest
strength. A card at 0 never evaluates the noise.

## The tank's scanlines

`tankScan` (under `scan` in the tuner) draws scanlines across every tank
window — in the CARD's space, off `lp` in `crt.wgsl`'s `cardAt`, so they lie
across the window like the lines of a small screen set into the plate and
turn with the card, unlike the CRT's own lines which are the screen's. Mean
preserving (a line's dark and bright sum to nothing), so the slider is
texture, not exposure. `tankScanPitch` in artboard px, `tankScanScroll` rolls
them, `tankScanBg` decides whether the water behind the bodies takes them.

**A WGSL error renders nothing and reports nothing.** `rive --verify` and the
build check the markup and the Luau; a shader that fails to compile draws a
flat artboard and no line reaches any log. The tank scanlines' uniform row
was first named `i`, and that alone blanked the whole screen. A frame that
goes dark after a shader edit is a compile error until proven otherwise —
bisect the edit, and name fields by meaning.

## A phone held sideways

Two things the table does differently when the card gets small, both of them
about a screen nobody testing this is holding.

**Fullscreen.** Mobile Safari keeps a bar over the bottom of the page and
sizes the page around it, so the board lays out correctly into a viewport
shorter than the glass and the foot strip sits under browser furniture —
landscape worst, where the columns are already squeezing to fit. The web
mount draws the game's own fullscreen button (`systems/fullscreen.js`, the
same prefix dance and the same capability check, reused rather than copied)
in the corner opposite Back. It is a BUTTON and not an automatic request:
fullscreen needs a user gesture, and a refusal on load is invisible. Closing
the table gives the screen back, or the player lands in the menu with no
browser chrome and nothing to say why.

**The CRT eases off.** `crtSmall`, `crtSmallFit` and `crtFullFit` under `crt`
scale all four CRT rows AND the tank's own scanlines by `LAYOUT.crtEase` —
1 at `crtFullFit` and above, `crtSmall` at `crtSmallFit` and below, and never
above 1, so a look tuned on the desktop is exactly what ships there. It is
keyed to `fit`, the CARD's scale, not to a device or a viewport width,
because every one of those effects is fixed-PIXEL over a card that is not a
fixed size: at 1600x1000 a card is 120px wide and a 3px line is texture on
it, while a phone in landscape lays the same seven columns out at `fit` 0.47
and the tank inside the card is forty pixels tall. Keying it to the card also
means a narrow desktop window tells the whole truth, so it tunes without a
phone in your hand. `sealitaire:test` holds it at thirteen viewports.

**Back works during the download.** The mount's handle used to be published
on the last line of `showSealitaire`, after the 22MB .riv had arrived, and
`hideSealitaire` returns early without it — so for the seconds a phone spends
fetching, Back handed the menu back UNDERNEATH a full-screen opaque layer and
the menu's own close did nothing. The handle goes up before the download now,
with the runtime added to it after, and the teardown copes with the half that
may be missing. `npm run test:sealitairechrome` is the guard; it never awaits
the mount, which is the only reason it can check any of this without a WebGL
runtime.

## Sixteen vertex attributes, and not one more

WebGL2 guarantees `MAX_VERTEX_ATTRIBS` **16**, and WebKit ships exactly the
guarantee — so `fish.wgsl`'s VSIn may declare locations 0..15 and no more.
It had seventeen for a while, and the seventeenth cost the site every fish:

```
Ore GL shader compile error: 'location' : Attribute location out of range
skip make bindGroup (unresolved dep) / pipeline dropped pass draws
```

The shader module fails, the bind group cannot resolve, every pass the
pipeline wants is dropped: blank striped cards on sealsurvivor.com and
dropped frames on a play. **Nothing here could see it.** The native viewer
has far more slots, so `npm run sealitaire:shot` rendered all 52 cards
perfectly, and the web runtime said only "unresolved dep, churn" until it
was bumped past 2.42.0. Keep that bump: the older runtime cannot tell you
what is wrong.

The bend row (`tankrig.luau`'s palette row, one float) rides in
`bioField2.z` for this reason, where the instance record was already sending
a zero — it is not an attribute of its own and must not become one again.
`npm run test:sealitaireattrs` is the gate: it counts the locations, checks
they run 0..n-1 with no gap, checks the pipeline's `vertexLayout` names the
same slots as the shader (two lists in two files that disagree silently),
and checks no instance attribute reads past baitball's record.

## The tank's toon look

Every creature is cel shaded and outlined, and all of it is on sliders under
`toon` in the tuner (T): `celSteps`, `celSoft`, `celShadow`, `celSpec`, then
`lineWidth` and `lineR/G/B`.

The CEL ramp quantises lambert into `celSteps` bands, softening each edge by
`celSoft` **as a fraction of one band** — so changing the number of bands does
not re-soften everything. That softening is the difference between cel shading
and posterising: a hard `floor()` aliases badly on a curved body at this size,
and the terminator crawls a pixel at a time as a fish turns. The highlight is a
band too, not a falloff, because cel art puts a flat shape of light on a thing.

The OUTLINE is an inverted hull — the same mesh and the same instance buffer
drawn again through `vsLine`/`fsLine` with **front faces culled**, so what
survives is the inside of a shell pushed out along the normals. It is drawn
first and the bodies cover all of it but the rim. `lineWidth` is in TANK units
and the push happens in WORLD space, after the model matrix, so the line is the
same weight on a sardine and on the octopus; pushing in local space would scale
it with the body. `lineWidth` 0 skips the pass entirely. Bubbles opt out (the
emissive flag) — a few pixels of flat white does not want a line around most of
it.

Two things that will bite:

- The pipeline selects an entry point with `vertex = { module = shader,
  entryPoint = 'vsLine' }`. A bare `vertex = shader` takes the FIRST `@vertex`
  in the file, so a wrong spelling does not error — it silently draws the body
  again with front faces culled, which reads as a broken outline rather than as
  a typo.
- **The tank sheet is drawn larger than it is shown.** A card is 120x168, so a
  sardine is about thirty pixels and an outline at any believable weight is
  under one — the look has no room to exist at native size. The atlas takes the
  largest multiple (3, 2, else 1) that keeps it inside `ATLAS_MAX`. The cost is
  quadratic and two textures are held at that size, colour and depth32float, so
  the cap is not decoration: doubling a retina-scale sheet would be 38MB a side
  for a sheet of playing cards.

## The music

The track plays and the water hears it. Rive's scripting has no FFT and no tap
on the audio engine — a script can start a sound and ask it the time, and that
is the whole API — so `npm run sealitaire:music <track.mp3>` does the analysis
once, offline, into `music.bin`: eight log-spaced bands (40 Hz to 12 kHz) at 60
frames a second, each frame a LEVEL (dB, normalised against the track's own
quiet and loud percentiles) and a FLUX (how far that band just rose above its
own recent mean). Log in both axes, because both are how hearing works: linear
bands put five of the eight in the hiss, and a linear level leaves a quiet
passage flat at zero.

At runtime `music.luau` looks up the frame at the playhead and fires at most
one ripple a frame — the loudest band that has crossed the threshold and served
both its own refractory and the table's 0.22s gap. The gap is the limit that
does the work: eight bands each obeying their own refractory still stack up on
a loud bar, because nothing was counting them together. Measured over this
track in the player: 3.5 rings a second, six in the busiest second, about five
of the eight slots in use at a time.

The spectrum is laid **across the table**: band 1 (57 Hz) at the left edge,
band 8 (8.4 kHz) at the right, each band's row drifting on its own slow cycle.

Three sliders, under `music` in the tuner: `musicVolume`, `musicRipple` (a
band onset's ripple strength, on the same scale a card play's is — 0 plays the
track and never shows it) and `musicSwell` (the track's level added to the
water's energy as a BED; the music never spikes the energy the way a play does,
or the water would sit at its ceiling and stop answering the cards). **M**
mutes the sound without muting the water, which is how the ripples get tuned.

### A ripple is geometry, not a ring

The vortex underneath draws a ripple's four numbers as **light**. `surface.wgsl`
draws the same four as **shape**, and everything that makes it read as water
falls out of that rather than being painted on:

- The height profile is a spreading circular wave — the crest falls as
  `1/sqrt(radius)` because the same push of water goes round an ever bigger
  circle, and the envelope is asymmetric (tight ahead of the front, 3.5× as
  long behind) with the wavelength stretching down the tail, so one lobe
  becomes a train.
- The normal taken off that height field is what **refracts** what is under
  the water, and the three channels are sampled a fraction apart along the
  slope — red bends least. Without the fringe a displaced image just reads as
  being out of focus; the fringe is the cue that says *lens*.
- **Fresnel** does the rest. Water is 2% reflective head-on and a mirror at a
  glance, and the camera looks straight down — so the flat table shows what is
  beneath it and only a tilted face turns any sky around. No term anywhere says
  "ring": the ring is simply the only geometry on the table with a slope.

`reflectTilt` exaggerates the slope before the Fresnel is taken off it, and it
is not optional. Real relief at this scale leaves every normal within a couple
of degrees of straight up, where `(1-cos)^5` is nothing and the picture is
correct and completely flat.

Three sliders under `surface`: `rippleRelief`, `reflect`, `reflectTilt`.

The ripples live in a ring of **their own**: slots 8..15 of the shaders'
sixteen, with slots 0..7 still the card plays. Two rings rather than one list
so the music, ringing a couple of times a second, can never push out the ring a
play just made. The shaders read the two differently — `ringGrow` / `ringWidth`
/ `ringFade`, one copy per water mode — because at a play's size the music's
rings overlap into an even wash and the water just looks generally busy.

**One track, ever.** The sound handle lives in `music.luau` at module scope,
not on the table — every table, every frame, calls `keepPlaying` and gets the
same sound back. There is no loop flag on an `AudioSound`, so looping is
playing it again, and that has to *stop the finished one first* (an unstopped
voice stays in the mix — the tenth loop is a wall) and has to refuse to believe
`completed` more than once a second (a handle to a stopped sound reports having
played nothing, and with no floor that one answer starts a voice every advance).
`MUSIC.mayStart` is that rule, pure and covered by `sealitaire:test`, because
the audio globals cannot be stood up in a `--test` run.

The playhead is the sound's own while it moves, and the table's clock when it
has not moved for a quarter second. That fallback is not a nicety: every
headless mode that builds a player runs miniaudio with `noDevice`, so
`sound:time()` sits at 0 for the whole run, and a `--screenshot` check of the
ripples would photograph frame zero of the track forever and look plausible.

Two things about nested artboards that render plausibly wrong: an artboard's
`originX/originY="0.5"` moves its LOCAL (0,0) to its centre — content must sit
at (0,0), not at (w/2, h/2), or every placement lands a half-size off. And a
non-stateful `NestedArtboard` with the same `viewModelId` as its host reads the
host's instance with no `dataBindPathIds` at all, which is what lets one Pip
artboard serve every card the script instances.

The panel is drawn **over the finished screen**, not into the table: after the
CRT pass has been laid down as an image. So nothing the CRT composites lands
on top of it — it used to go into the scene canvas with the cards, which put
it UNDER every tank window, and a panel opened over the tableau had cards
printed through it — and none of the CRT's own treatment lands on it either,
which matters just as much for reading 93 rows of 11px numbers through a
barrel curve, scanlines and a chromatic split.

The cost is that the tuner is the one surface NOT on the curved screen, so it
is hit-tested in RAW pointer coordinates while everything else goes through
`throughCurve`. That is why `pointerDown` carries two points; near the corners
they are tens of pixels apart. The panel is tested first and swallows the
pointer, so a press or a drag inside it never reaches the cards beneath.

Live tuning: press T (or click the title) to open the panel, click a header to fold its category, drag the gutter down its left to scroll, N deals again, C runs the win cascade, W cycles the water mode, R cycles the card rim's material, M mutes the music, drag knobs, press SAVE. The
script prints `TUNING-SAVE k=v ...`; `npm run sealitaire` (the tune tool
wrapping the watcher) writes those into tuning.luau and the watcher rebuilds
with them as the new defaults. From a headless run, paste the line into
`node tools/sealitaire-tune.mjs save k=v ...`.

Headless checks that drive it: `--pointer=move@x,y`, `--pointer=click@x,y`,
`'--pointer=drag@x,y>x2,y2:12'`, then `--advance=N` and `--screenshot`. Pointer
coordinates are SCREEN space; the script maps them through the CRT curve.

Copy: every player-facing label is `[DRAFT]` or lorem until Ethan writes it
(see `design/COPY-TODO.md`, "Sealitaire status lines").

Art is his too: a suit mark, a glyph, any symbol drawn from primitives to
stand in for real art is FPO — it carries `[FPO]` in its name and goes on no
card. The number on a card is not a symbol at all: it is how many bodies swim
in the face.

## The editor round trip

The same pipeline `rive/blubberball` runs, pointed here — the `.rml` is the
source of truth and the editor is a place to look at it and nudge things, not
a second copy of it.

```bash
npm run sealitaire:rev        # build + build/sealitaire.rev
npm run sealitaire:push       # build + upload; records push.fileId in rive.yaml
npm run sealitaire:pull             # download the linked file, report what differs
npm run sealitaire:pull:apply       # the same, then write the changes back
npm run sealitaire:pull <file.rev>  # diff a .rev you already have instead
```

With no path, pull **downloads the linked file itself** — `rive pull`, since
CLI 1.1.0, which takes `push.fileId` out of rive.yaml and writes the remote
out as a project. The editor app does not have to be running, nothing has to
be saved by hand, and there is no MCP session to negotiate (it replaces one:
the tool used to ask the editor's own endpoint for a `.rev`, which needed the
right tab open).

**`rive pull` on its own would overwrite this project**, which is what it is
for — "the remote wins", scripts, shaders and assets included. So the tool
never points it here. It seeds a THROWAWAY directory with nothing but
rive.yaml, pulls into that, diffs, and deletes it. An empty seed matters: the
CLI reports its writes against what is already in the directory, so a copy of
the project would hide every real difference behind "already matched".

`pull:apply` exists because the workbench runs scripts by name. In a terminal
`npm run sealitaire:pull -- --apply` is the same thing — and the `--`
matters: without it npm keeps `--apply` for itself and the tool runs a
report, prints "run again with --apply" and exits 1, which reads exactly
like the flag was never typed.

In `npm run hub`: pull and pull & apply are ordinary buttons in the command
list. **Push is a held button in the Ship card**, beside `hold to ship` — it
replaces the editor's copy with ours, so an unpulled nudge there is gone
after it, and a publish does not get a plain click. It is the second and last
exception to "publish scripts are terminal-only"; `hub-ship.mjs` has the
terms, and the price is the hold alone rather than ship's typed message,
because every push names a revision the editor can restore.

For a while it was worse than either: `sealitaire:push` sat in the Publish
DRAWER with its risk class still `check`, and those are different things —
the drawer is where a script is listed, the class is whether `/api/run` will
spawn it. So it had an ordinary Run button and one press sent the project up.
Both Rive pushes are publish-classed now and `npm run test:hub` checks
`/api/run` refuses them.

Both `--rev` and `push` need `rive login`; without a session the CLI says so
and exits, so a missing login can never look like a successful build. The
first push creates the file and writes `push.fileId` into `rive.yaml` beside
the `projectId` already there; every push after that replaces its content and
adds a named entry to the revision history.

Coming back is a DIFF, not a copy. `rive create --from-rev` round-trips
losslessly but writes a FRESH project — comments stripped, elements reordered,
defaults elided — so `tools/rive-pull.mjs` indexes both sides by the ids `rive`
stamps on every element and reports only the attributes somebody actually
changed. `--apply` writes those back into the tag they came from and re-verifies.

**It compares the FILES too**, and that is the part worth reading first. The
element diff is by id over the .rml, and a script's body is not markup — so a
project three days and a whole feature ahead of its pushed copy reported
"nothing changed in the editor", which is true and useless. Every `.luau`,
`.wgsl`, `.csv`, `.mesh` and `.bin` is compared byte for byte now: here-only
or differing is an UNPUSHED change, remote-only is the editor's. A blob comes
back under its ASSET name (`<BlobAsset file="sfx.csv" name="sfxBank">` is
`sfxBank.bin` in a pulled project), so the six blobs are folded onto our names
first — without that each one reads as a here-only file beside a remote-only
twin and the real answer drowns.
Elements ADDED or REMOVED in the editor are reported and never applied: there
is no honest way to guess where a new shape belongs in a file organised by hand.

**A change that points at something this project does not have is held back
too**, and that one is not a nicety. An id attribute — `fontAssetId`, a
style, an artboard ref — only means anything beside the element it names.
Ethan restyled the deal button in the editor with a font he added there, and
the pull brought the REFERENCE down while the `<FontAsset>` and the .ttf,
both additions, stayed behind: `fontAssetId="1:9409" matches no id in this
file`, the build dead, and the error a hundred lines from anything about a
pull. Those changes are now reported with the asset they need
(`needs FontAsset "Anton SC" 1:9409, file "Anton SC.ttf"`) and left alone.
Anton SC is in `fonts/` now, declared under the id the editor gave it so the
two sides agree.

**An asset's NAME follows its file, never the export.** `file` is skipped
already (it is our path on disk), so a `name` applied on its own splits the
pair — and the generated blocks make that likely rather than exotic: the sfx
bank and its processed takes number their `<AudioAsset>` lines POSITIONALLY,
so after a rebake `0:1400` means a different sound here than in a file pushed
before it. Ethan's pull copied four remote names onto four unrelated local
sounds, leaving `file="sfx/seal-07-distant.flac" name="hg-cards-034-phaser"`
and a bank `npm run test:sealitairesfx` could no longer resolve. Where our
name is the file's stem, the change is now ignored.

**And a merge that does not compile is undone.** The verify ran after the
write, so a bad merge exited loudly with the damage already on disk — which
is how that dangling font outlived the pull that made it. Every file the
apply touches is snapshotted and put back if the verify fails.
Two things that look like additions are folded out before the lists print:
the push renumbers every `ScriptInputArtboard` on the way up (paired back by
type and name), and the shaders the build scans in from `.wgsl` files have no
markup here but are `ShaderAsset`s there. What remains in the lists is real —
or the push is stale, which the pull cannot tell from a drawing: push, reload
the editor tab, pull again.

One thing to know before pushing this project in particular: the editor has no
WGSL passes, no `.mesh` and no script runtime, so what lands there is the
artboards, the shapes and the bindings — the water, the seal, the tanks and the
goo are all `table.luau` and the shaders, and none of it renders in the editor.
The round trip is for the card faces and the layout, which is exactly what
`table-cards.rml` is for.

## Two buttons

`npm run sealitaire` is the command; there are two ways to click it instead.

**The Dock.** `npm run sealitaire:app` writes `~/Applications/Sealitaire.app` —
the same table with no terminal in front of it, icon cut from
`build/shot.png`, output teed to `build/app.log`. Drag it to the Dock once.
**Re-run it after moving the repo or changing node**: every path in it is
baked in at generation time, because a GUI-launched script gets a minimal PATH
and would not otherwise find node at all. `tools/mac-bundle.mjs` writes the
bundle and its header has the rest — including the one that costs an afternoon,
that an unsigned bundle silently does not launch and `open` still exits 0.

The generator is `tools/game-app.mjs`, which is not Sealitaire's: it takes a
game key and writes that game's button. Blubberball has one too
(`ball:app`), off the same roster the workbench draws
its card from — `tools/games.mjs`.

**The workbench.** `npm run hub` has a Games section above Servers, with a row
per game: open the table, watch its output, close it, or regenerate the Dock
button. It was Sealitaire's own section until the other two games got doors.

**Only one viewer runs at a time,** and the check is in
`tools/sealitaire-tune.mjs` rather than in either button, because every way of
starting the table goes through it. A second viewer is a second writer of
`tuning.luau` — press SAVE in one and it rewrites the file from the values
ITS window is holding, so the second save wins over work that was only ever on
screen in the window that lost. The tool exits **3** when it finds one already
open; the Dock app turns that into a dialog, the workbench card greys its own
button and shows the pid, and a terminal prints why.

The pattern it greps for is anchored to the start of the command line. Without
the `^`, `pgrep -f` also matches any process that merely MENTIONS the project
path — a grep, an editor, another agent session — and the button refuses to
open with nothing running at all.
