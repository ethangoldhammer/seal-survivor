# Wetris

A Rive CLI project (`~/.rive/bin/rive`): a falling-block stacker on
sealitaire's water. The rules are complete and proved; the sea is sealitaire's
own — vortex, goo, foam, surface and the CRT treatment — and so is the seal,
which holds station beside the well, points a flipper at the live piece,
flicks it for every move and turn, and celebrates a line clear. So is the
tuner: T (or a click on the score) opens sealitaire's panel over the board,
and SAVE writes the knobs back into tuning.luau. The music and the sound bank
have not come across yet.

```bash
npm run wetris          # the live viewer window + the tuning save loop (tools/wetris-tune.mjs)
npm run wetris:verify   # compile + type check + inspect, exit 1 on any problem
npm run wetris:test     # the rules, headless (tests.luau)
npm run wetris:shot     # one frame to build/shot.png
npm run wetris:music    # encode the loop from the lossless bounce (needs lame) + write its exact length
npm run wetris:sfx      # gather sfxEvents.csv's takes from sealitaire's bank + bake the blip bus
npm run test:wetrissfx  # every event's files present, declared, and still sealitaire's bytes
npm run wetris:sync        # copy sealitaire's shared files (water + seal) over these
npm run test:wetrisshared  # fail if any of them has drifted
npm run wetris:ship     # signed .riv -> public/wetris.riv, which turns the Club seal row on
npm run wetris:rev      # build/wetris.rev, the editor's format (needs rive login; uploads nothing)
npm run wetris:push     # send it to its Rive file — add `-- --name="what changed"` to label the revision
npm run wetris:pull     # what changed in the editor since the last push (writes nothing)
npm run wetris:pull:apply  # ...and merge those attribute edits back into the .rml
```

| file | what |
|---|---|
| `scene.rml` | the fill-sized `Wetris` artboard (the ScriptedLayout, with its FocusData — without it no key arrives), and `Readout`: the big score, the level in a gold ring and the lines, bound to the `Board` view model and instanced by the script into the scene (through the CRT). board.luau scales it with the screen, counts the score up, pops it and lights a glow behind it on a clear (harder for a tetris, T-spin, back-to-back or combo), draws the ten-segment level bar under it and throws a ring off the badge on a level-up. No word labels: those are Ethan's to write |
| `wetris.luau` | the rules, pure — Guideline Tetris: the well, the seven pieces, SRS rotation and kicks, the 7-bag on a seeded LCG, levels that come quickly (the goal is 3 lines, then 4, 5 … up to 10) and speed that ramps harder than the guideline (its gravity curve at 1.15 levels per level, the 0.02 s floor near 80 lines), T-spins (three-corner rule, full/mini), back-to-back, combos, soft/hard drop points, hold, top-out. The board owns the clocks: lock delay 0.5 s with a 15-reset limit, soft drop at 20x gravity |
| `board.luau` | everything that moves: layout for any viewport, gravity and lock delay, the piece's glide, keys and touch, and the GPU passes in sealitaire's order (its header lists them) |
| `puddle.luau` | what is in the goo's field: the floor lining, the stack as few boxes as it will go, the piece, the droplets a lock or a clear throws, the foam's impacts and bow waves. Writes goo.wgsl's and foam.wgsl's uniform rows byte for byte |
| `whirl.wgsl` | sealitaire's vortex.wgsl FORKED: the same arithmetic with every constant a slider (tuning.luau's `vortex`, `noise` and water-grade rows, each defaulting to the constant it replaced — at defaults it renders the vortex to within 0.02/255). Forked because vortex.wgsl's uniform block is sealitaire's; goo/foam/surface still read this water's centre, twist and speed from the same rows |
| `goo.wgsl` `foam.wgsl` `surface.wgsl` | **COPIES of sealitaire's**, kept identical by `test:wetrisshared`. Not symlinks: the rive build skips a symlinked shader without a word and the board falls back to flat. Edit them in rive/sealitaire and run `npm run wetris:sync`; if a uniform row moved, board.luau's matching draw function has to move with it |
| `swimmer.luau` | the seal in the well: where it holds station and celebrates, the fin aim at the piece (sealitaire's measured IK), the flick on every input, the pose and the draw. Named `swimmer` because a script called `seal` collides with seal.wgsl and the build parses the shader as Luau |
| `motion.luau` | the seal's states, wetris's own landing points in sealitaire's shape (its header says what each anchor means here) |
| `seal.mesh` `seal.wgsl` `puppet.luau` `react.luau` | **COPIES of sealitaire's**, same rule as the water shaders. seal.mesh needs its `<BlobAsset>` line in scene.rml — a blob is NOT found by the directory scan, whatever sealitaire's asset comment says |
| `tuning.luau` | every slider: key, range, value, category — the defaults AND the panel's rows. SAVE in the panel prints `TUNING-SAVE …`, and tools/wetris-tune.mjs (which `npm run wetris` runs the viewer inside) writes the values back here. Look and feel only: the game's rules stay in wetris.luau |
| `tuner.luau` | the panel: sealitaire's layout, folding headers, scroll, SAVE and RESET, and `T`, the live table board.luau and swimmer.luau both read |
| `tuner.rml` `fonts/Inter.ttf` | **COPIES of sealitaire's** (the row and header parts, and the font they name as `0:400` — which is why Abril is `0:420` here) |
| `ink.luau` | the stack's colours running together, Blubberball's goo-pass idea on the well: each locked cell's clock (following its row down through every clear) and the rows crt.wgsl's `inkAt` reads. A piece lands crisp and ripens over `mixTime`; the mix keeps its saturation so a ripe stack marbles instead of going to mud. The stack is drawn grey into its own canvas and coloured in the shader, so only the hue runs. The same ripeness drives the FUSE: crt.wgsl's `stackAt` draws the stack as one smooth-union SDF, so touching tiles melt together as their colours run (`fuseReach` the threshold in cells, capped at half a cell by its 3x3 window; `fuseAmount` the melt, 0 is the old crisp tiles exactly). The goo SKIRT takes its blocks' colour too: goo.wgsl is shared so it stays teal, and crt.wgsl reads its canvas (binding 6) and dyes it with `skirtAt`, the nearby cells' and piece's colours (`skirtTint`, `skirtReach`) |
| `tiles.luau` | the FREE tiles crt.wgsl draws — the live piece (its cells where they are drawn: glide AND turn, a rotation sweeping about the SRS pivot) and the previews — and which piece cells have open water under them to drip from |
| `drips.luau` | the coloured goo the falling piece sheds, in three stages: it FORMS behind the piece at a point on its contour (undersides mostly, reckoned on screen so a turned piece drips from whatever faces down) and rides with it while it swells out past the edge; it FLIES once formed, with its point's velocity (glide and turn, capped by `dripFling`) and gravity; it LANDS on the pile, clings, sinks in and STAINS the cell (ink.luau). A piece that locks lets go of every drop still forming on it. crt.wgsl draws them behind the tiles as one metaball field, with a GEL term from every tile nearby so the goo bridges onto the piece it leaves and the pile it lands on |
| `sfxEvents.csv` | which take plays for which event — sealitaire's hover blips, flick-plops and seal voices — with a gain, delay, minGap, and three columns of wetris's: `ladder` (p or h: play the take at a rung of its baked pitch ladder, the board picks the rung), `bus` (knock or blip: the reverb bus under it) and `send` (its share of the bus) |
| `sound.luau` | plays an event the way sealitaire's playKnock does: the dry take (already through sealitaire's bank-wide low-pass) at its rung, plus the bus copy at the same rung through the two low-pass cutoffs `busSweep` sits between, at `busSend` x `send` |
| `knock.luau` | **COPY of sealitaire's** (test:wetrisshared): the pitch step and the equal-power crossfade down the bus's cutoff ladder |
| `sfx/` | GENERATED by tools/wetris-sfx.mjs: the takes and ladders the events name, copied out of rive/sealitaire/sfx, and `blipbus-p<k>-c<c>` baked from the first blip-bus take (sealitaire's reverb and cutoffs). Never edit by hand; re-run after changing sfxEvents.csv or re-baking sealitaire's ladders |
| `music/wetris.mp3` `musicLoop.csv` | the loop, GENERATED by tools/wetris-music.mjs from Ethan's lossless Wetris_Loops.wav: 96 kbps CBR joint stereo at 32 kHz (1.4 MB, from a 4.6 MB 320k export), and its exact length from the WAV's frame count (115.2 s) |
| `music.luau` | plays the loop forever with no seam: every repeat SCHEDULED on the audio clock exactly `seconds` after the last, 1.5 s ahead — never restarted on completion, because an MP3 carries encoder priming and padding the decoder does not strip, so a restart puts a gap in every loop. Falls back to restart-on-completion if the engine clock does not move (headless does not). **Never two copies**: the schedule is the module's, not the board's, and the loop sits on a process-wide grid (engine time 2.1 s + k × loop), so a watcher rebuild — whose previous context's copies play on unreachable — joins the grid after them instead of starting a second loop. `wetris:test` covers it |
| `crt.wgsl` | wetris's own compositor (water, then the 2-D scene) with sealitaire's screen treatment, its constants now sliders (`crt`: shadow mask, scanline drift, bright lift, flicker, edge glow) plus a film grain sealitaire does not have. It lays every tile's shadow FIRST, so no tile is ever under a shadow; then the goo, behind the tiles; then the tiles. It DRAWS THE TILES: faux 3-D — a quarter-round bevel with real normals, a side extruded away from the light, a soft shadow, and wet shading (hard highlight, water mirrored in the bevel by Fresnel, a moving film of sheen) — and the drips. Every read inside those loops is textureSampleLevel: they are non-uniform control flow |
| `tests.luau` | proves `wetris.luau` |

`--data=lab=clear` stages a four-line clear (one Space fires it) and
`--data=lab=stack` a ragged half-full well — the way to look at the water
without playing a game to get there:

```bash
~/.rive/bin/rive rive/wetris --data=lab=clear --screenshot=rive/wetris/build/clear.png --advance=20 --key=space --advance=24
```

Keys: arrows move (Up turns), Z/X turn, Space hard-drops, C or Shift holds, N
deals a new game, P pauses. A pad: d-pad or stick left/right walks (repeats),
down soft-drops, up hard-drops, A (south) or X turns clockwise, B counter,
Y or a shoulder holds, Start pauses, Back re-deals. Touch: drag sideways to walk, drag down to soft
drop, flick down to hard drop, tap to turn; a tap on a finished well re-deals.

## The editor round trip

The project is bound to Rive file **2609704 "wetris"** (rive.yaml `push:`), in
the same project as sealitaire and blubberball.

- **Push** is the CLI's own: it diffs the build against the file's live content
  and sends only what changed, as a named revision the editor can restore.
  Ids stay stable across pushes (artboards by name, assets by path), so a
  reference into this file survives a push. The push is authoritative: editor
  edits to pushed content are overwritten — pull them first.
- **Pull** is `rive pull`, wrapped by tools/rive-pull.mjs, because the raw
  command regenerates the markup: it would strip every comment in scene.rml
  and very likely fold the shared tuner.rml into it. The wrapper pulls into
  a throwaway directory instead, diffs it BY ID against the .rml, and
  compares every script and shader byte for byte. `--apply` writes attribute
  edits back in place — comments, order and file split kept — and verifies,
  restoring the tree if the build fails. Elements added or deleted in the
  editor are reported for a person to place: a new shape has no obvious home
  in a hand-organised file.
- What that means in practice: **tweak in the editor** (a colour, a size, a
  font, a position on the Readout; a value in a script), pull:apply, commit.
  **Structural work** — a new artboard, new shapes — happens here, in the
  .rml, and gets pushed. The count-up, pop, glow and level bar are board.luau's,
  not editor timelines.
- `hidden` (and every other flag) is a bitfield the tool deliberately does NOT
  write back — a shape shown or hidden in the editor has to be spelled by hand.
  So does a re-parent: the first pull (2026-09-25) grouped the level badge into
  a Node, and --apply alone would have zeroed its position without the Node.
  Place additions first, then apply.
- The shared copies (tuner.rml, the water shaders, the seal) come back through
  a pull too; test:wetrisshared fails if an editor edit to one of them lands
  here, because the real one is sealitaire's.

Verified at the first push: the export converts back with every element and
id, `wetris:pull` against the live file reports no difference, and a second
push is "already up to date".

## In the game

`path/src/ui/wetrisTable.js` mounts it over the menu the way
`sealitaireTable.js` mounts the card table, and the Seal sports row stays a
greyed stub until `public/wetris.riv` exists. The file must be built with
`--publish` — the web runtime rejects unsigned scripts without a word — and
the mount passes `enableGPUCanvas: true`, without which every pass is dead on
the web and the board draws flat.

## Copy

Every word a player reads is Ethan's. The .riv carries no labels yet; the
game's Back and loading lines are `wetrisBack` / `wetrisLoading` in
`path/src/uiText.csv`, staged as `[DRAFT]` and lorem with their briefs.

## Next

- the music's ripples: whirl.wgsl's eight music ripple slots are still written empty — sealitaire bakes an FFT (music.bin) to drive them
- the seal's bubbles (sealitaire's bubbles.luau)
