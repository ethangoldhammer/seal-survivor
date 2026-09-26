-- ============================================================================
-- SEALITAIRE'S TUNABLES — one row per slider in the in-game tuner.
--
-- This file is BOTH the defaults the table starts from and the panel's row
-- list: table.luau lays the panel out from it (a row artboard per line, a
-- header per `cat`, headers fold), and when you press SAVE in the panel it
-- prints the live values for tools/sealitaire-tune.mjs to write back into
-- the `value =` of each row here, which the watcher then rebuilds with. So:
-- tune live, save, and the numbers are in source. Nothing else regenerates.
--
-- Press T (or click the title) for the panel; click a header to fold it.
-- Keys are the labels; keep them short. `cat` groups rows under a header,
-- in order of first appearance.
--
-- The seal's swim numbers are the game's (CONFIG.player, CONFIG.levelUpSeal
-- .motion, CONFIG.animation) in the game's units, scaled to px inside.
-- ============================================================================

export type Row = { key: string, min: number, max: number, value: number, cat: string }

local rows: { Row } = {
    -- hide
    { key = 'sealLength', min = 0.15, max = 0.7, value = 0.39788, cat = 'hide' },         -- body length, fraction of the screen height (levelUpSeal.freeHeight)
    { key = 'mottleSize', min = 0.01, max = 0.3, value = 0.05, cat = 'hide' },         -- feature size in mesh units (bind pose)
    { key = 'mottleStrength', min = 0, max = 1.5, value = 0.83, cat = 'hide' },
    { key = 'mottleContrast', min = 0.2, max = 6, value = 3.55, cat = 'hide' },
    { key = 'rim', min = 0, max = 2, value = 0.9, cat = 'hide' },
    -- swim
    { key = 'thrust', min = 2, max = 60, value = 6.3784, cat = 'swim' },
    { key = 'friction', min = 0.8, max = 0.995, value = 0.965, cat = 'swim' },         -- per-frame drag at 60fps
    { key = 'maxSpeed', min = 4, max = 80, value = 34, cat = 'swim' },
    { key = 'turnLerp', min = 1, max = 20, value = 2.5337, cat = 'swim' },
    { key = 'steer', min = 0.5, max = 12, value = 11.475, cat = 'swim' },              -- levelUpSeal.pull.steer
    { key = 'arrive', min = 0.1, max = 1.5, value = 0.1, cat = 'swim' },              -- body lengths
    { key = 'steerTight', min = 0.2, max = 3, value = 2.2832, cat = 'swim' },             -- the steer arc must fit this many arrive bands
    { key = 'landEase', min = 0, max = 30, value = 4, cat = 'swim' },                 -- per second the LANDING POINT eases toward where the states put it. 0 is the old behaviour: the point teleports card to card and the swim is a series of darts. Low is fluid and late, high is sharp and steppy
    { key = 'lean', min = 0, max = 0.9, value = 0.4, cat = 'swim' },                  -- how far toward the pointer the body drifts with NO card settled on: 0 sits under the row, 1 would follow the cursor outright and leave hovering a card meaning nothing
    -- blend
    { key = 'blendRate', min = 0.5, max = 8, value = 2.3, cat = 'blend' },
    { key = 'blendTime', min = 0, max = 1.5, value = 1.3883, cat = 'blend' },
    { key = 'turnSettle', min = 1, max = 15, value = 11.71, cat = 'blend' },
    -- clips
    { key = 'moveThreshold', min = 0.2, max = 6, value = 1.5, cat = 'clips' },
    { key = 'boostThreshold', min = 4, max = 40, value = 18.767, cat = 'clips' },
    { key = 'crossfade', min = 0.02, max = 1, value = 0.2, cat = 'clips' },
    { key = 'clipScale', min = 0.2, max = 3, value = 1, cat = 'clips' },
    { key = 'wagAmp', min = 0, max = 0.6, value = 0.12, cat = 'clips' },               -- extra tail wag, radians
    { key = 'wagSpeed', min = 0, max = 10, value = 4.2, cat = 'clips' },
    { key = 'jawOpen', min = 0, max = 1.2, value = 0.5, cat = 'clips' },               -- radians at jaw 1
    { key = 'gazeShare', min = 0, max = 1.5, value = 1.1531, cat = 'clips' },
    -- win: the cascade off the foundations (cascade.luau). C triggers it any time
    { key = 'winGravity', min = 200, max = 4000, value = 1400, cat = 'win' },         -- px/s^2 pulling a thrown card down (x fit)
    { key = 'winLaunch', min = 40, max = 900, value = 260, cat = 'win' },             -- px/s sideways at the throw; the arcs' width
    { key = 'winLift', min = 0, max = 700, value = 190, cat = 'win' },                -- px/s upward at the throw, so a card rises before it falls
    { key = 'winBounce', min = 0, max = 0.95, value = 0.72, cat = 'win' },            -- of the downward speed kept on each hit; under ~0.5 the cards heap rather than cascade
    { key = 'winGap', min = 0.02, max = 0.6, value = 0.13, cat = 'win' },             -- seconds between one card leaving a foundation and the next
    { key = 'winSpin', min = 0, max = 8, value = 1.6, cat = 'win' },                  -- radians/s of tumble at full launch speed
    { key = 'winFloor', min = 0, max = 200, value = 10, cat = 'win' },                -- px above the bottom edge the cards bounce on
    { key = 'winRest', min = 0, max = 300, value = 90, cat = 'win' },                 -- px/s of bounce below which a card stops bouncing and just slides off
    { key = 'winRipple', min = 0, max = 1.5, value = 0.35, cat = 'win' },             -- the ring a bounce pushes into the water; 0 is a silent floor
    -- react: what the seal does after a valid play (react.luau)
    { key = 'reactSpeed', min = 0.3, max = 2.5, value = 1, cat = 'react' },            -- x the choreography's tempo
    { key = 'reactChance', min = 0, max = 1, value = 1, cat = 'react' },              -- how often a play gets a reaction; 1 is every play
    { key = 'clapRaise', min = 0, max = 2, value = 1.4, cat = 'react' },              -- radians the shoulders raise and close for the clap (1.4 meets over the back)
    -- fins: the flippers point at the plays that are on the table (klondike's
    -- M.plays). One flipper per side of the body; a side with nothing to point
    -- at goes back to its swim.
    { key = 'finAim', min = 0, max = 1, value = 0.85, cat = 'fins' },                 -- the weight on the aim: 0 the flippers only ever swim, 1 they point straight at the card
    { key = 'finReach', min = 0, max = 2.6, value = 1.7, cat = 'fins' },              -- radians a flipper may swing off the pose the clip left it in; past this it leans as far as it is allowed rather than folding through the body. The flippers rest pointing out and BACK at about 1.9 rad, and the cards are all ahead of the seal, so a reach under about 1.6 can never actually reach one — it only leans
    { key = 'finEase', min = 1, max = 30, value = 9, cat = 'fins' },                   -- how eagerly the aim arrives and lets go
    -- bite
    { key = 'biteOffset', min = 0, max = 0.3, value = 0.099937, cat = 'bite' },        -- body lengths the mouth goes past the corner
    { key = 'jawClamp', min = 0, max = 0.6, value = 0.08, cat = 'bite' },              -- the jaw's opening on the card
    { key = 'mouthReach', min = 0, max = 0.5, value = 0.26, cat = 'bite' },            -- mesh units from the head bone to the bite point
    { key = 'biteBlend', min = 0, max = 0.4, value = 0.09, cat = 'bite' },            -- seconds the body takes to close the last of the gap onto the corner, instead of covering it in one frame. 0 is the old cut
    { key = 'biteHold', min = 0.02, max = 0.5, value = 0.15, cat = 'bite' },           -- body lengths: close enough, the bite takes
    { key = 'releaseTime', min = 0.2, max = 3, value = 1.6394, cat = 'bite' },
    { key = 'releaseLift', min = 0, max = 2, value = 0.8, cat = 'bite' },              -- scale up toward the viewer at full lift — a REACTION's lift now (react.luau); a plain release no longer rises
    { key = 'releasePush', min = 0, max = 1500, value = 0, cat = 'bite' },             -- px/s away from the card
    -- breath: the seal's own bubbles (bubbles.luau). The ambient column that
    -- rises through the whole scene is `bubbles` further down; these are the
    -- ones the animal makes.
    { key = 'breathRate', min = 0, max = 20, value = 3.5, cat = 'breath' },            -- bubbles/s from the mouth and the nose together, at rest. An open jaw and a moving body raise it
    { key = 'breathSize', min = 0.5, max = 10, value = 2.2, cat = 'breath' },          -- px radius at fit 1 (the ambient column's is `bubbleSize`, 4.5)
    { key = 'burstPlay', min = 0, max = 60, value = 14, cat = 'breath' },              -- bubbles out of the mouth when a reaction starts. The MOVE is already covered by the shed, so this is only the whoop
    { key = 'shedThreshold', min = 0, max = 4, value = 0.45, cat = 'breath' },          -- body lengths/s a part of the seal must beat before it sheds anything at all
    { key = 'shedRef', min = 0.5, max = 10, value = 3, cat = 'breath' },               -- body lengths/s OVER the threshold that counts as flat out: what `shedRate` is the rate at
    { key = 'shedRate', min = 0, max = 30, value = 9, cat = 'breath' },                -- bubbles/s off ONE part of the body going flat out
    { key = 'shedPower', min = 1, max = 3, value = 1.6, cat = 'breath' },              -- above 1 the fastest parts take a sharper share: at 1 a flipper tip at twice the belly's speed sheds twice as much, at 2 four times
    { key = 'shedMax', min = 0, max = 200, value = 70, cat = 'breath' },               -- bubbles/s, the whole animal: the ceiling on a somersault. It scales every part down together, so which parts shed most stays true
    { key = 'shedSize', min = 0.5, max = 12, value = 3, cat = 'breath' },              -- px radius at fit 1: a shed bubble is fatter than a breath, and so rises faster
    { key = 'puffRise', min = 0, max = 90, value = 22, cat = 'breath' },               -- px/s per px of radius the bubble settles to, upward. x its own radius, so the fat ones climb away
    { key = 'puffLife', min = 0.3, max = 6, value = 2, cat = 'breath' },               -- seconds; a shed bubble gets 0.8 of it
    { key = 'puffDrag', min = 0.3, max = 8, value = 2.4, cat = 'breath' },             -- per second: how fast a bubble forgets the speed the body threw it with
    { key = 'puffWobble', min = 0, max = 40, value = 10, cat = 'breath' },             -- px/s of weave on the way up
    -- the deal swipe: the flipper's flick across the deck as a card comes off
    { key = 'swipeArc', min = 0, max = 1.6, value = 0.8, cat = 'fins' },              -- radians either side of the aim the flipper sweeps through. Past about 0.9 the WIND-UP stops growing and only the sweep does: pointing at the deck already has the flipper most of `finReach` from the pose the clip left it in, so the backswing runs into that clamp first
    { key = 'swipeTime', min = 0.15, max = 1.5, value = 0.5, cat = 'fins' },          -- seconds the whole gesture takes: wind up, sweep, settle
    -- stock
    { key = 'stockHover', min = 0, max = 1, value = 0, cat = 'stock' },                -- WHICH HOVER: 0 the PEEK (the top card alone separates up and left off the pile), 1 the RIBBON (the whole deck lifts into a chain on the cursor, wind-up throw and all — kept as a stub). Every stock* row below the peek's three belongs to the ribbon
    { key = 'stockPeekX', min = 0, max = 80, value = 18, cat = 'stock' },             -- PEEK: px the top card slides LEFT off the pile. Left because the waste is the slot to the right — separating toward it would cover the card just drawn
    { key = 'stockPeekY', min = 0, max = 80, value = 14, cat = 'stock' },             -- PEEK: px it slides UP. Capped by stockRise/stockClear like the ribbon, so it can never reach the chrome
    { key = 'stockPeekTilt', min = -0.3, max = 0.3, value = 0.05, cat = 'stock' },      -- PEEK: radians it leans as it goes. Signed — the sign is which way it lies over
    { key = 'stockRise', min = 0, max = 300, value = 129.85, cat = 'stock' },             -- px the top card lifts
    { key = 'stockClear', min = 0, max = 60, value = 8, cat = 'stock' },              -- px kept between the fan's top card and the chrome above it
    { key = 'stockChain', min = 0.05, max = 0.95, value = 0.8, cat = 'stock' },            -- how much of the way back toward its own slot each card sits from the one ABOVE it. It is per CARD, not per deck: 0.8 puts the second card a fifth of the ribbon behind the head at four cards left and at twenty-four, so the top card always stands alone and a draw comes off the top rather than out of the middle. High is a long loose ribbon, low is a deck with one card lifted off it
    { key = 'stockBias', min = 0, max = 140, value = 52, cat = 'stock' },             -- px the ribbon bellies out to the LEFT, and how far left of the column it parks. The waste is the slot to the RIGHT: a fan that cuts straight up across it hides the card just drawn. It buys the head its room to the left as well, so the two cannot disagree
    { key = 'stockSway', min = 0, max = 80, value = 7, cat = 'stock' },               -- px the ribbon weaves, on top of that belly. Subtle: the cursor is what moves this ribbon, and the sway is only the water it hangs in
    { key = 'stockTilt', min = 0, max = 0.6, value = 0.06, cat = 'stock' },            -- radians of weave in the cards' lean. The lean that reads is the chain's own direction, which is not tunable because it is geometry
    { key = 'stockWobble', min = 0, max = 4, value = 0.42, cat = 'stock' },             -- the underwater sway, per second
    { key = 'stockLead', min = 60, max = 800, value = 300, cat = 'stock' },           -- the HEAD's spring: how hard the top card holds the cursor. It is the one card that may not lag, so this stays well above stockFollow
    { key = 'stockFollow', min = 20, max = 500, value = 110, cat = 'stock' },         -- the BODY's spring: how loosely every card under the head trails the one above it. Low is a long lazy ribbon that keeps moving after the hand stops
    { key = 'stockDamp', min = 3, max = 60, value = 18, cat = 'stock' },              -- the ribbon's damping, both ends. What it means depends on the spring it is damping: at 18 the head (stockLead 300) is smooth with a little give and the body (stockFollow 110) is near critical, which is the way round it wants to be — the card on the cursor may breathe, the ribbon under it may not swing. Halve it and the whole chain starts to oscillate, which is a different animal from a fan
    { key = 'stockEase', min = 1, max = 15, value = 3, cat = 'stock' },                -- how fast the fan RISES, and how fast a click drops it
    { key = 'stockSettle', min = 0.5, max = 15, value = 1.5, cat = 'stock' },          -- how fast it eases back down once the pointer leaves — lower than stockEase on purpose: arriving is an answer, leaving is a settle
    { key = 'drawTime', min = 0.12, max = 1.2, value = 0.42, cat = 'stock' },         -- seconds the drawn card takes to turn over and cross into the waste. The flip IS the journey, so this is the whole gesture
    { key = 'drawArc', min = 0, max = 0.6, value = 0.22, cat = 'stock' },             -- how far toward the viewer it comes over the top of that arc
    { key = 'stockDrop', min = 2, max = 30, value = 12, cat = 'stock' },               -- how fast a click drops the fan into the flip
    -- the wind-up: press and hold the deck, and the release throws the card
    { key = 'holdTap', min = 0, max = 0.6, value = 0.22, cat = 'stock' },              -- seconds of holding that still count as a CLICK and wind up nothing. A mouse button is down for about a tenth of a second on every ordinary click, so without this a player who never meant to charge anything gets a throw; the wind-up starts counting after it
    { key = 'holdFull', min = 0.1, max = 2, value = 0.6, cat = 'stock' },             -- seconds of holding the deck that count as a FULL wind-up. Everything below scales with how much of this the hand gave it, and a tap gives none: that is the draw this table always had
    { key = 'holdWind', min = 0, max = 0.8, value = 0.34, cat = 'stock' },            -- how much of the fan's height a full wind-up takes back INTO the deck. The card does not go anywhere while it is wound; the deck pulls it in, and the flight springs out of that
    { key = 'holdFlip', min = 0, max = 4, value = 2, cat = 'stock' },                 -- extra WHOLE turns at a full wind-up. Whole, because a half would land the card on its back
    { key = 'holdArc', min = 0, max = 3, value = 1.5, cat = 'stock' },                -- how much further over the top of its arc a thrown card comes, x drawArc
    { key = 'holdTime', min = 0, max = 1.5, value = 0.5, cat = 'stock' },             -- how much longer a full throw takes than a tap, x drawTime. More turns need more seconds or they are a blur
    { key = 'holdGoo', min = 0, max = 20, value = 6, cat = 'stock' },                 -- droplets a full throw tears off the ribbon as the card leaves, x gooSplash — and they are thrown FREE for longer than a landing's, so they get clear of the deck before its own goo pulls them back in. The pass holds 24 drops at once and the oldest give way, so past about 8 here (x gooSplash) this is churn rather than more water. The landing's own slap is on top of it
    { key = 'stockAura', min = 0.02, max = 2, value = 0.35, cat = 'stock' },           -- seconds the hoverAura bed fades in and out by, on the pointer arriving and leaving
    -- tanks
    { key = 'fishSpin', min = 0, max = 4, value = 1.2, cat = 'tanks' },                -- swirl, radians/s
    { key = 'fishRadius', min = 0.2, max = 1.2, value = 0.67839, cat = 'tanks' },          -- ball radius, tank units
    { key = 'fishSize', min = 0.1, max = 1.2, value = 0.40355, cat = 'tanks' },            -- a sardine's length, tank units; a tanks.csv row scales it by its `size`
    { key = 'fishExcite', min = 0, max = 4, value = 0.72749, cat = 'tanks' },           -- hover: extra spin (x)
    { key = 'fishScatter', min = 0, max = 3, value = 1.1792, cat = 'tanks' },             -- press: how far they fly
    { key = 'fishPadX', min = 0, max = 0.6, value = 0.32467, cat = 'tanks' },             -- world units the RESTING seats keep clear of the card's SIDES, so a body does not sit under the rank. The WALLS are unchanged: jostled, it still goes there. A tanks.csv row's padX overrides it for that card
    { key = 'fishPadY', min = 0, max = 0.6, value = 0.32467, cat = 'tanks' },             -- the same, top and bottom; a row's padY overrides it
    { key = 'pipColGap', min = 0.2, max = 2, value = 1, cat = 'tanks' },            -- the formation's column spread, x the fitted width: 1 is the seats at the padded edge, less pulls the pips in toward the centre line
    { key = 'pipRowGap', min = 0.2, max = 2, value = 1, cat = 'tanks' },            -- the formation's row spread, x the fitted height
    { key = 'pipDrop', min = -0.8, max = 0.8, value = 0, cat = 'tanks' },           -- world units the whole formation is biased DOWN the card; negative lifts it. Clamped to the padded seat box, so it parks against the edge rather than into the wall. A tanks.csv row's `drop` overrides it
    { key = 'pipRotate', min = -1.57, max = 1.57, value = 0, cat = 'tanks' },         -- radians every body is tilted in the card plane, all on the same visual axis whichever way its row faces. A row's `rotate` overrides it
    { key = 'pipRotateVary', min = 0, max = 1.57, value = 0, cat = 'tanks' },         -- radians of extra tilt either side of that, per body, from its own hash: stable frame to frame, not a jitter. A row's `rotateVary` overrides it
    { key = 'pipYaw', min = -1.57, max = 1.57, value = 0, cat = 'tanks' },            -- the second axis: radians every body turns about the card's vertical, positive nose toward the viewer. A row's `yaw` overrides it
    { key = 'pipRoll', min = -3.14, max = 3.14, value = 0, cat = 'tanks' },           -- the third axis: radians every body rolls about its own length, positive belly toward the viewer. A row's `roll` overrides it
    { key = 'pipSway', min = 0, max = 1, value = 1, cat = 'tanks' },                  -- how much of the idle rock and the breathing drift a resting body does; 0 is dead still (a play or a drag still moves it). A row's `sway` overrides it
    { key = 'entranceSpeed', min = 0, max = 8, value = 2.5, cat = 'tanks' },          -- tank units/s a court card's creature swims in at when its face is revealed, from past the right edge; 0 is no entrance
    -- the clips: a species baked with a `clip` (tanks.csv) plays it per body
    { key = 'clipSpeed', min = 0, max = 3, value = 1, cat = 'tanks' },                -- x the clip's own rate; 0 freezes every clip on its frame
    { key = 'clipWeight', min = 0, max = 1, value = 1, cat = 'tanks' },               -- how much of the clip's pose shows; 0 is the rest pose
    -- the swirl: a played card's number becomes a bait ball for a beat
    { key = 'swirlHold', min = 0, max = 3, value = 0.9, cat = 'tanks' },             -- seconds the ball holds after a play
    { key = 'swirlIn', min = 1, max = 30, value = 8, cat = 'tanks' },                -- how fast the number becomes a ball
    { key = 'swirlOut', min = 0.3, max = 10, value = 2, cat = 'tanks' },             -- how fast it settles back into the number
    { key = 'fishSlosh', min = 0, max = 0.005, value = 0.0039888, cat = 'tanks' },        -- drag: velocity kick, tank units per px/s the card's velocity changes by
    { key = 'fishSpring', min = 1, max = 40, value = 35.022, cat = 'tanks' },
    { key = 'fishDamp', min = 0, max = 12, value = 4, cat = 'tanks' },
    { key = 'fishBounce', min = 0, max = 1, value = 0.89772, cat = 'tanks' },            -- velocity kept off a wall (the card's edge)
    { key = 'fishHitSpeed', min = 0, max = 3, value = 0.35, cat = 'tanks' },          -- tank units/s of closing speed below which a touch of the glass is not a knock
    { key = 'fishHitGap', min = 0.02, max = 1, value = 0.12, cat = 'tanks' },         -- s a body waits before it may knock again, so one scraping along the glass does not machine-gun
    { key = 'tankBubbles', min = 0, max = 10, value = 4, cat = 'tanks' },             -- bubbles a hard knock throws; 0 stops them without stopping the sound
    { key = 'tankBubbleSize', min = 0.01, max = 0.3, value = 0.09, cat = 'tanks' },   -- a bubble's diameter, tank units
    { key = 'tankBubbleRise', min = 0, max = 2, value = 0.55, cat = 'tanks' },        -- tank units per second, upward
    { key = 'tankBubbleLife', min = 0.2, max = 4, value = 1.1, cat = 'tanks' },       -- seconds before it is gone
    { key = 'tankBubbleSpread', min = 0, max = 2, value = 0.5, cat = 'tanks' },       -- how fast they scatter off the glass
    { key = 'fishTurn', min = 0.2, max = 12, value = 2, cat = 'tanks' },             -- radians/s a body may turn: rotational drag
    { key = 'fishTurnMax', min = 5, max = 90, value = 60, cat = 'tanks' },           -- degrees: a body never points further than this from its rest facing
    -- the rattle: a dragged card is a loose box
    { key = 'rattleLoosen', min = 1, max = 30, value = 12, cat = 'tanks' },          -- how fast a drag lets the seats go, per second
    { key = 'rattleStill', min = 0, max = 300, value = 40, cat = 'tanks' },          -- px/s: a held card slower than this is still, and reseats
    { key = 'rattleSettle', min = 0.2, max = 10, value = 2.5, cat = 'tanks' },       -- how fast an idle or played card seats them again
    { key = 'rattleFriction', min = 0, max = 10, value = 1.2, cat = 'tanks' },       -- velocity lost per second while loose
    { key = 'rattleGravity', min = 0, max = 8, value = 2.5, cat = 'tanks' },         -- sink while loose, tank units per second^2
    { key = 'rattleTumble', min = 0, max = 1.5, value = 0.5, cat = 'tanks' },        -- roll with speed while loose
    -- toon
    { key = 'celSteps', min = 1, max = 8, value = 3, cat = 'toon' },                  -- bands of light on a body; 1 is flat, 8 is nearly smooth
    { key = 'celSoft', min = 0.01, max = 1, value = 0.18, cat = 'toon' },             -- how soft each band's edge is, as a fraction of one band
    { key = 'celShadow', min = 0, max = 1, value = 0.42, cat = 'toon' },              -- how lit the darkest band is; 0 is black, 1 is no shading at all
    { key = 'celSpec', min = 0, max = 1, value = 0.35, cat = 'toon' },                -- how much of the body the flat highlight covers; 0 removes it
    { key = 'lineWidth', min = 0, max = 0.05, value = 0.01396, cat = 'toon' },          -- outline weight in TANK units, so it is the same on every creature; 0 is no outline and skips the pass
    { key = 'lineR', min = 0, max = 1, value = 0.04, cat = 'toon' },
    { key = 'lineG', min = 0, max = 1, value = 0.09, cat = 'toon' },
    { key = 'lineB', min = 0, max = 1, value = 0.16, cat = 'toon' },
    -- biolum: the glow a tanks.csv row's `bio` turns on, one noise field through the whole tank (fish.wgsl)
    { key = 'bioStrength', min = 0, max = 3, value = 1, cat = 'biolum' },             -- the master: x every card's `bio`
    { key = 'bioScale', min = 0.1, max = 3, value = 2.0216, cat = 'biolum' },            -- feature size, tank units (a sardine is ~0.4 long); smaller is more patches
    { key = 'bioSpeed', min = 0, max = 3, value = 0.36116, cat = 'biolum' },              -- tank units/s the field TRAVELS, so the light crosses the school; 0 stands still (it can still evolve)
    { key = 'bioPan', min = -180, max = 180, value = 0, cat = 'biolum' },             -- degrees, which way it travels: 0 across the card left to right, 90 up it, 180 right to left
    { key = 'bioEvolve', min = 0, max = 3, value = 0.84793, cat = 'biolum' },             -- how fast the field CHANGES in place (its third axis, per second); 0 is a fixed pattern sliding by
    { key = 'bioStretch', min = 0.25, max = 4, value = 1, cat = 'biolum' },           -- patches drawn out along the travel (x); 1 is round, 3 reads as a current, under 1 is across it
    { key = 'bioOctaves', min = 1, max = 4, value = 3, cat = 'biolum' },              -- layers of detail: 1 is big soft shapes, 4 is fine grain riding on them
    { key = 'bioContrast', min = 0.5, max = 4, value = 1, cat = 'biolum' },           -- sharpens the field before the coverage cut; high is hard islands, low is a wash
    { key = 'bioWarp', min = 0, max = 2, value = 0, cat = 'biolum' },                 -- a second field bends the first: ink pulled through water; 0 is off
    { key = 'bioPulse', min = 0, max = 1, value = 0.475, cat = 'biolum' },                -- the whole glow breathes: how deep, 0 steady
    { key = 'bioPulseRate', min = 0, max = 4, value = 0.59824, cat = 'biolum' },          -- breaths per second
    { key = 'bioCoverage', min = 0, max = 1, value = 0.45, cat = 'biolum' },          -- how much of the field lights; 0 is nothing, 1 is everything
    { key = 'bioSoft', min = 0.005, max = 0.5, value = 0.12, cat = 'biolum' },        -- the shoulder on the patch's edge; small is a hard-edged blotch
    -- the dent: a contact squashes the body. The skeleton is untouched — the
    -- warp is after the skin matrix (fish.wgsl) — so a clip plays through it.
    { key = 'dentAmount', min = 0, max = 1, value = 0.45977, cat = 'dent' },            -- compression at 1 tank unit/s of closing speed, capped at 1; 0 is no dent at all
    { key = 'dentSpread', min = 0.05, max = 1, value = 0.32, cat = 'dent' },         -- how much of the body dents, in BODY LENGTHS either side of the contact; past ~0.5 the whole animal squashes
    { key = 'dentFreq', min = 1, max = 20, value = 9, cat = 'dent' },                -- Hz the squash rings back at: low is rubber, high is a flinch
    { key = 'dentDamp', min = 0.05, max = 0.98, value = 0.35, cat = 'dent' },        -- 0 rings for ever, near 1 is one squash and done
    { key = 'dentWave', min = 0, max = 0.3, value = 0.05, cat = 'dent' },            -- the flesh wobble that runs away from the contact, in body lengths; 0 is the dent alone
    { key = 'dentWaveK', min = 0, max = 30, value = 9, cat = 'dent' },               -- its wavenumber, cycles per body length
    { key = 'dentWaveSpeed', min = 0, max = 12, value = 4, cat = 'dent' },           -- how fast it travels, cycles per second; 0 is a standing wave
    -- the rig: a big animal answers a contact with its SKELETON instead of
    -- a vertex squash — the chains of rigs.csv, sprung by bonespring.luau.
    -- A species with no rigs.csv row never reaches any of this.
    { key = 'rigImpulse', min = 0, max = 8, value = 5.9909, cat = 'rig' },              -- how hard a contact shoves the chains, per tank unit/s of closing speed; 0 holds every skeleton still
    { key = 'rigStiff', min = 1, max = 200, value = 1, cat = 'rig' },               -- the spring at a chain's ROOT; high snaps back, low hangs
    { key = 'rigDamp', min = 0.5, max = 30, value = 7, cat = 'rig' },                -- damping at the root; low rings on, high is one swing
    { key = 'rigTipLoose', min = 1, max = 12, value = 10.416, cat = 'rig' },              -- how much softer the TIP of a chain is than its root: what makes the far end trail furthest and the lag read as a wave
    { key = 'rigMaxLag', min = 2, max = 80, value = 67.819, cat = 'rig' },               -- degrees a bone may sit from where the rest pose put it; eased into, never snapped
    { key = 'rigMaxBend', min = 5, max = 120, value = 45, cat = 'rig' },            -- degrees a bone may sit from ITS OWN rest, whatever the bones above it did. rigMaxLag is per joint and COMPOUNDS down a chain — six bones at 28 is 168 — so this is the one that stops a tail folding through the animal
    { key = 'rigSpread', min = 0.05, max = 1.5, value = 0.45, cat = 'rig' },         -- how far along the body a contact is felt, in BODY LENGTHS: small and only the end that was hit swings
    -- knock: the tank-glass knock's pitch and its send bus (baked ladders, knock.luau)
    { key = 'knockPitch', min = 0, max = 2, value = 2, cat = 'knock' },              -- octaves the knock drops per doubling of the body's length (a sardine is the reference); 0 is one pitch for all
    { key = 'hoverPitch', min = 0, max = 2, value = 1, cat = 'knock' },           -- octaves the card-hover blip drops per doubling of the stack's depth; 0 is one pitch for all
    { key = 'hoverRefDepth', min = 1, max = 13, value = 4.1578, cat = 'knock' },       -- the depth that plays the blip unpitched; deeper is lower, shallower is higher
    { key = 'busSend', min = 0, max = 1.5, value = 0, cat = 'knock' },            -- the reverb bus's level under the dry knock; 0 is dry only
    { key = 'busSweep', min = 0, max = 1, value = 0, cat = 'knock' },                -- the bus's low-pass, swept DOWN: 0 open, 1 darkest (a crossfade down four baked cutoffs)
    -- scan: scanlines across the tank windows, in the card's own space (crt.wgsl, cardAt)
    { key = 'tankScan', min = 0, max = 1, value = 0.4, cat = 'scan' },                 -- how dark the lines are; 0 is off. Mean preserving, so it is texture not exposure
    { key = 'tankScanPitch', min = 1, max = 12, value = 3, cat = 'scan' },             -- artboard px from one line to the next (a card is 168 tall)
    { key = 'tankScanScroll', min = -40, max = 40, value = 6, cat = 'scan' },          -- artboard px/s the lines roll down the card; 0 holds them
    { key = 'tankScanBg', min = 0, max = 1, value = 1, cat = 'scan' },                 -- 1 lines the water behind the bodies too, 0 only the bodies
    -- bubbles
    { key = 'bubbleCount', min = 0, max = 80, value = 51.558, cat = 'bubbles' },
    { key = 'bubbleSpeed', min = 10, max = 240, value = 70, cat = 'bubbles' },         -- px/s
    { key = 'bubbleSize', min = 2, max = 30, value = 4.529, cat = 'bubbles' },            -- px radius at size 1
    -- water
    { key = 'waterMode', min = 0, max = 3, value = 3, cat = 'water' },            -- 0 vortex, 1 paint, 2 caustic, 3 marble; W cycles it
    { key = 'twist', min = 0, max = 5, value = 0.62899, cat = 'water' },
    { key = 'waterSpeed', min = 0, max = 3, value = 0.74715, cat = 'water' },
    { key = 'waterBright', min = 0.2, max = 2, value = 1.0412, cat = 'water' },
    { key = 'warp', min = 0, max = 2, value = 1.4174, cat = 'water' },
    -- goo
    { key = 'goo', min = 0, max = 1, value = 1, cat = 'goo' },                         -- the layer's opacity; 0 skips the pass
    { key = 'gooSkirt', min = 0, max = 40, value = 7.1888, cat = 'goo' },              -- px of goo showing around a stack
    { key = 'gooBlend', min = 4, max = 120, value = 75.835, cat = 'goo' },                 -- px apart at which two shapes still fuse
    { key = 'gooWobble', min = 0, max = 30, value = 14.063, cat = 'goo' },             -- px the membrane jiggles
    { key = 'gooSplash', min = 0, max = 3, value = 2.7899, cat = 'goo' },              -- droplets per landing, scale
    -- surface
    { key = 'caustics', min = 0, max = 2, value = 1.1355, cat = 'surface' },              -- the light net on the floor
    { key = 'bubbles', min = 0, max = 2, value = 1, cat = 'surface' },                 -- how many rise
    { key = 'waves', min = 0, max = 2, value = 0.89459, cat = 'surface' },                   -- the swell's height
    { key = 'glint', min = 0, max = 2, value = 0.60825, cat = 'surface' },                   -- the sun on the slopes
    { key = 'rippleRelief', min = 0, max = 3, value = 3, cat = 'surface' },           -- how far a ripple's wave train stands up out of the water
    { key = 'reflect', min = 0, max = 2, value = 1.4859, cat = 'surface' },                -- how much sky a tilted face turns around (Fresnel, so flat water shows almost none)
    { key = 'reflectTilt', min = 1, max = 12, value = 5, cat = 'surface' },           -- slope exaggeration before the Fresnel: real water at this scale is far too flat to catch anything
    -- crt
    -- HOW MUCH OF THE TREATMENT A SMALL CARD CARRIES. Every row below is a
    -- fixed-pixel effect over a card whose size is not fixed; on a phone in
    -- landscape the board lays out at `fit` ~0.55 and the same scanlines,
    -- barrel and fringe sit over a tank forty pixels tall. These two scale
    -- all four CRT rows AND the tank's own scanlines by the card's size, and
    -- only ever downward: at `crtFullFit` and above nothing changes at all.
    { key = 'crtSmall', min = 0, max = 1, value = 0.35, cat = 'crt' },                -- what survives at the smallest card; 1 is no easing at all, 0 is no CRT on a phone
    { key = 'crtSmallFit', min = 0.2, max = 1, value = 0.55, cat = 'crt' },           -- the `fit` at which only `crtSmall` is left (a phone in landscape is about here)
    { key = 'crtFullFit', min = 0.5, max = 1.5, value = 0.9, cat = 'crt' },           -- the `fit` at and above which the look is exactly as tuned
    { key = 'curve', min = 0, max = 0.15, value = 0.012903, cat = 'crt' },
    { key = 'scanlines', min = 0, max = 1, value = 0.18968, cat = 'crt' },
    { key = 'aberration', min = 0, max = 0.02, value = 0, cat = 'crt' },
    { key = 'vignette', min = 0, max = 1, value = 0.83606, cat = 'crt' },
    -- cards
    { key = 'hoverMargin', min = 0, max = 40, value = 11.695, cat = 'cards' },             -- px: a hover is kept this far outside, taken only this/2 inside
    { key = 'hoverFalloff', min = 0, max = 1, value = 0.45, cat = 'cards' },          -- how much of the pop a card loses when taken by its EDGE rather than its centre. 0 is the old hard hitbox: every part of the rect worth the same
    { key = 'hoverGrab', min = 0, max = 20, value = 0, cat = 'cards' },              -- px INSIDE a card's edge the pointer must reach to take the hover; 0 is the frame itself. The release is hoverMargin and stays sticky
    { key = 'hoverSettle', min = 0, max = 0.4, value = 0.09, cat = 'cards' },          -- s a switch or leave must hold before the seal hears of it
    { key = 'cardSpring', min = 60, max = 800, value = 736.39, cat = 'cards' },
    { key = 'dragLag', min = 3, max = 80, value = 11.121, cat = 'cards' },                -- per second the run in hand chases the pointer. High is welded to the cursor, low is carried through water
    { key = 'dragTrail', min = 0, max = 0.9, value = 0.45, cat = 'cards' },           -- how much further behind each card of the run is than the one above it: 0 is a rigid stack, high bends the run through a turn
    { key = 'dragBank', min = 0, max = 0.002, value = 0.0006, cat = 'cards' },        -- radians per px/s of hand speed the card leans into its turn
    { key = 'cardDamp', min = 5, max = 60, value = 19.552, cat = 'cards' },
    -- the hover pop: the run under the pointer rises as a wave (hover.luau); no shear, the card keeps its shape
    { key = 'hoverScale', min = 1, max = 1.2, value = 1.2, cat = 'cards' },            -- how much a popped card grows; small keeps the fan readable
    { key = 'popRise', min = 0, max = 30, value = 17.963, cat = 'cards' },                 -- px a popped card rises up the screen (x fit)
    { key = 'popSpring', min = 40, max = 600, value = 397.95, cat = 'cards' },            -- the pop's stiffness
    { key = 'popDamp', min = 2, max = 40, value = 11, cat = 'cards' },                 -- its damping; under ~2*sqrt(spring) it overshoots, which is the liquid in it
    { key = 'popWave', min = 0, max = 0.15, value = 0.076755, cat = 'cards' },            -- s between one card of the run popping and the next below it: the wave
    { key = 'pressKick', min = 0, max = 12, value = 6.3817, cat = 'cards' },                -- the dip a press gives the card on its way into the hand
    { key = 'sway', min = 0, max = 0.05, value = 0.0053607, cat = 'cards' },
    { key = 'cardRim', min = 0, max = 2, value = 1, cat = 'cards' },                  -- the rim's strength; 0 is a card with no edge at all
    { key = 'cardRimWidth', min = 0, max = 20, value = 0, cat = 'cards' },          -- artboard px of the card's edge the bevel takes; 3.5 is the trim stroke in table-cards.rml (Plate)
    { key = 'cardRimMode', min = 0, max = 6, value = 1, cat = 'cards' },              -- the material: 0 pearl, 1 emissive, 2 metallic, 3 reflective, 4 refractive, 5 holographic, 6 chrome (the trim: brushed metal mirroring the water). R cycles them
    -- rim: the metal itself (crt.wgsl's metallic and chrome materials; cardRimMode picks, R cycles)
    { key = 'metalTint', min = 0, max = 1, value = 0, cat = 'rim' },                  -- 0 chrome grey .. 1 gold
    { key = 'metalBody', min = 0.2, max = 2.5, value = 2.5, cat = 'rim' },              -- the wire's own brightness, before the reflection and the glint
    { key = 'metalGrain', min = 0, max = 1, value = 1, cat = 'rim' },                 -- how much the brushed grain shows; 0 is a smooth polish
    { key = 'metalGrainLines', min = 8, max = 160, value = 64, cat = 'rim' },         -- brush lines round the whole card
    { key = 'metalGlint', min = 0, max = 3, value = 3, cat = 'rim' },                 -- the travelling glint's strength
    { key = 'metalGlintWidth', min = 0, max = 1, value = 0.82511, cat = 'rim' },         -- 0 a tight streak .. 1 a broad sheen
    { key = 'metalMirror', min = 0, max = 2, value = 1.7877, cat = 'rim' },                -- how much of the water the chrome mirrors
    { key = 'metalSeam', min = 0, max = 1, value = 1, cat = 'rim' },               -- the dark seam where the chrome meets the plate; 0 is none
    { key = 'cardShadow', min = 0, max = 1, value = 0, cat = 'cards' },            -- the drop shadow, almost all of it the card's LIFT
    { key = 'tankBg', min = 0, max = 2, value = 0.85131, cat = 'cards' },                   -- scales every tank background at once; the colours themselves are the four `bg<Suit>` rows below (a tanks.csv `bg` cell overrides one card). 1, so a suit row IS the colour: at 2 every channel above 0.5 clamped white and half of each suit slider did nothing
    { key = 'inkGlow', min = 0, max = 1, value = 0, cat = 'cards' },                      -- the master for the light behind a rank, red and white alike. OFF — the markup that draws it is still in cards.rml, turn this up to bring it back
    { key = 'inkPulse', min = 0, max = 3, value = 1.9707, cat = 'cards' },                -- how hard the beat lights the white glow behind a black rank (the glow itself is markup: cards.rml, Corner)
    -- THE SUITS' WATER. One background per suit, which is the level a card's
    -- family is decided at: a tanks.csv `bg` cell is an OVERRIDE for one card
    -- and is blank on all 52, so these four are what the table actually shows.
    -- Live, so dragging one repaints thirteen cards at once — the whole point
    -- of having them here rather than in the row. NAMED FOR THE MARK THAT IS
    -- PRINTED, not for the theme's key: the cards show a Heart, a Diamond, a
    -- Spade and a Club (table-cards.rml), while tanks.csv still keys its rows
    -- `Q star` because that column is the file's own identifier. A slider
    -- called bgStar over a card with a diamond on it is a translation you do
    -- every time you reach for it. `tankBg` above still scales all four.
    { key = 'bgHeartR', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgHeartG', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgHeartB', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgDiamondR', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgDiamondG', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgDiamondB', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgSpadeR', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgSpadeG', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgSpadeB', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgClubR', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgClubG', min = 0, max = 1, value = 1, cat = 'suits' },
    { key = 'bgClubB', min = 0, max = 1, value = 1, cat = 'suits' },
    -- music
    { key = 'musicVolume', min = 0, max = 1, value = 0.5, cat = 'music' },            -- the track itself
    { key = 'sfxVolume', min = 0, max = 1, value = 0.8, cat = 'music' },              -- the card sounds (re-deal, flip, grab, play, invalid, foundation)
    -- THE BANK'S TONE, in Hz. NOT live: Rive's audio is transport and volume
    -- only, so the filter is printed into the files. Moving this and pressing
    -- SAVE re-bakes the bank (tools/sealitaire-tune.mjs watches for it) and
    -- the watcher reloads — about ten seconds, and it restarts the deal. The
    -- script never reads it; the baker does.
    { key = 'sfxLowpass', min = 200, max = 16000, value = 2000, cat = 'music' },
    { key = 'musicRipple', min = 0, max = 3, value = 2.7472, cat = 'music' },            -- a band onset's ripple strength, on the same scale a card play's is (0.35-1.0); 0 plays the track and never shows it
    { key = 'musicSwell', min = 0, max = 0.5, value = 0.44311, cat = 'music' },          -- the track's level added to the water's energy, as a bed
    { key = 'musicWash', min = 0, max = 2, value = 1, cat = 'music' },                  -- the win's ring-out, against the -10dB send the bake put it at; 0 cuts the music dead instead
    { key = 'musicDebug', min = 0, max = 5, value = 0, cat = 'music' },                 -- seconds between the music heartbeat in the console, and >0 runs the seek probe at startup; 0 is off
    -- other
    { key = 'refract', min = 0, max = 40, value = 20.567, cat = 'other' },
    { key = 'turbulence', min = 0, max = 2, value = 0.40498, cat = 'other' },
    { key = 'whitewater', min = 0, max = 2, value = 0.34671, cat = 'other' },
    { key = 'foamFade', min = 0.2, max = 4, value = 2.4882, cat = 'other' },
    -- input
    -- THE TOUCH LIFT. A finger on a phone covers the card it is dragging, so
    -- a touch drag carries the run this fraction of a CARD HEIGHT above the
    -- contact point and you aim with the card rather than with your thumb.
    -- It is written into the run's target, so the card's own spring eases it
    -- up rather than snapping. A mouse drag never uses it: the cursor is a
    -- few pixels and hides nothing.
    { key = 'touchLift', min = 0, max = 1.2, value = 0.6, cat = 'input' },
    -- The pad's cursor, held in a direction: how long before it starts to
    -- repeat, and how fast it goes then. A repeat any quicker than this
    -- crosses the seven columns before the eye has followed it.
    { key = 'padDelay', min = 0.05, max = 0.8, value = 0.32, cat = 'input' },
    { key = 'padRepeat', min = 2, max = 20, value = 9, cat = 'input' },
    -- The stick's deadzone, and the deflection a direction counts at. A stick
    -- resting slightly off centre must not walk the table on its own.
    { key = 'padDead', min = 0.1, max = 0.8, value = 0.45, cat = 'input' },
    -- The cursor's ring: its stroke in CARD px (scaled by `fit` like every
    -- other measured-against-a-card number) and its glow.
    { key = 'padRing', min = 0, max = 10, value = 3.5, cat = 'input' },
    { key = 'padGlow', min = 0, max = 16, value = 6, cat = 'input' },
}

return rows
