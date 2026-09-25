-- ============================================================================
-- THE MUSIC — the track's baked FFT read back against the playhead, turned
-- into ripple impulses on the water.
--
-- Rive's scripting cannot analyse audio: a script starts a sound and can ask
-- whether it has finished, and for this file's purposes that is all. So the
-- FFT is baked by
-- `npm run sealitaire:music` into music.bin — eight log-spaced bands at 60
-- frames a second, each frame a LEVEL (log magnitude, normalised against the
-- track's own quiet and loud) and a FLUX (how far that band just rose above
-- its own recent mean). This module looks up a frame and decides what rings.
--
-- LEVEL is where the water sits; FLUX is where it gets hit. A ripple fires on
-- a band's flux crossing a threshold — an EDGE, with a refractory period, not
-- every frame the flux happens to be high: an onset is three or four frames
-- wide at 60Hz and counting frames would fire a burst of four identical rings
-- a sixtieth of a second apart, which reads as one loud ring and spends four
-- of the eight slots on it.
--
-- WHERE a band rings is the spectrum laid across the table: band 0 (57 Hz) at
-- the left edge, band 7 (8.4 kHz) at the right, so the water reads as the
-- song's own shape rather than as eight unrelated taps. Each band's row
-- drifts up and down on its own slow cycle so a repeated note does not wear a
-- groove in one spot.
--
-- Everything it emits is scaled by ONE number, `musicRipple` in tuning.luau.
-- At 0 the track still plays and the water never hears it.
-- ============================================================================

-- `k` is the band's own index, 1..bands. The caller needs it to tell a kick
-- from a hi-hat: x is the band laid across the table and is nudged and
-- clamped, so it cannot be read back as the band it came from.
export type Band = { k: number, x: number, y: number, level: number, flux: number }

-- ---------------------------------------------------------------------------
-- THE LOOPS. One bounce, cut into regions, ONE ASSET EACH.
--
-- Ethan hands over a single file with the loops laid end to end and never
-- exports them separately; `npm run sealitaire:loops` measures where they
-- are and `npm run sealitaire:music` cuts them. Nothing is uploaded twice,
-- and the runtime still only ever plays a whole asset from its start, which
-- is the one thing it is known to do well. See THE TRANSPORT below for why
-- that matters more than it sounds.
--
-- `role` and `gate` are integers, not names, because the bake writes integers
-- — a typo in musicLoops.csv fails in `npm run sealitaire:music`, where it
-- can name the row, rather than reaching here as a name that matches nothing.
--
--   role  0 bed     the deal's music. The beds are a LADDER: the one playing
--                   is the LAST unlocked row, so the table's order is the
--                   order the game climbs. A rung takes over at the next
--                   BLOCK — see `blockSeconds`.
--         1 intro   once, when a deal starts
--         2 win     the moment a deal is won. Takes over at the next BAR and
--                   then HOLDS: a win is a state, not a phrase, so it repeats
--                   itself until the next deal instead of handing back.
--
--   gate  0 open          always
--         1 deals         games dealt this session ≥ n
--         2 wins          games won this session ≥ n
--         3 foundations   cards on the foundations right now ≥ n
--         4 score         this deal's score ≥ n
--         5 moves         this deal's moves ≥ n
export type Loop = {
    id: string,
    startSec: number,
    endSec: number,
    role: number,
    gate: number,
    gateN: number,
    washSeconds: number,   -- 0 if this loop has no baked ring-out
    src: AudioSource?,     -- the region's own asset, resolved at load
    wash: AudioSource?,    -- its ring-out, likewise
}

-- What the gates are asked about. The table fills it every frame; the last
-- three are state of the DEAL, not of the session, so a loop gated on one
-- arrives as a game develops and is gone again at the next deal.
export type Progress = {
    deals: number,
    wins: number,
    foundations: number,
    score: number,
    moves: number,
}

export type Music = {
    ready: boolean,
    bands: number,
    frames: number,
    rate: number,          -- analysis frames per second
    duration: number,
    barSeconds: number,    -- the audio bar grid, from the bake; 0 if unknown
    blockSeconds: number,  -- the cell the bounce is built from (4 bars here)
    loops: { Loop },
    hz: { number },        -- each band's centre frequency
    data: buffer?,
    head: number,          -- byte offset of frame 0
    lastFire: { number },  -- playhead seconds each band last rang
    lastAny: number,       -- playhead seconds ANY band last rang
    smooth: { number },    -- each band's level, smoothed, for the continuous term
    energy: number,        -- the whole track's level, smoothed: a bed, not a hit
}

-- ONE SOUND AT A TIME, and the module owns it.
--
-- A module is loaded once per scripting context, so `current` is the one
-- place a sound exists. Every table asks the driver every frame and they all
-- drive the same one; a second table starting a second copy was the whole of
-- an early bug, and the fix is that no table can.
--
-- STOP BEFORE STARTING. Playing again without stopping the last one leaves
-- it in the mix. It is quiet, so the first change sounds fine and the tenth
-- is a wall — the symptom shows up minutes in, nowhere near where you look.
-- `playLoop` is the only thing that starts a sound and it always stops first.
local current: AudioSound? = nil

-- ---------------------------------------------------------------------------
-- THE TRANSPORT
--
-- ONE REGION IS ONE ASSET, and the only things this does to it are `play`,
-- `completed` and `stop`. That is the whole design and it is a deliberate
-- retreat from the previous one.
--
-- This used to play a single bounce of the whole track and hold the playhead
-- inside a region by seeking. It read well and it never worked: the gates,
-- the ladder and the win were all inert in the shipped build because
-- `AudioSound:seek` did not move the playhead, and nothing could tell —
-- a track that ignores every seek plays from end to end and sounds exactly
-- like music. Two rounds of diagnosis went into a primitive that the rest of
-- this project never uses.
--
-- `Audio.play` on a discrete asset is not a guess. The sfx bank runs a
-- hundred of them through it on every deal and has for months; `completed`
-- is what the old single-track loop already restarted on. Everything below
-- is built from those and nothing else.
--
-- THREE THINGS IT DELIBERATELY DOES NOT DEPEND ON, because each one has
-- already cost a day:
--
--   seek          not called anywhere. There is nothing to seek.
--   Audio.time()  not consulted for any decision. A frozen engine clock
--                 wedged the previous transport permanently.
--   sound:time()  not consulted for any decision. The bake lookup uses the
--                 clock below instead, which also means the ripples are
--                 right in headless modes, where the playhead never moves.
--
-- `elapsed` is the clock, and it is the TABLE's: seconds accumulated from the
-- frame's own `dt` since this region started, reset to zero every time one
-- starts. It is what the bar and block quantisation is measured against. It
-- cannot drift across loops because it never survives one, and if it is a
-- few milliseconds out inside a loop then a switch lands a few milliseconds
-- off a bar line, which is the smallest failure available here.
--
-- `sessionDeals` and `sessionWins` live here rather than on the table because
-- the table is rebuilt (a re-deal, a hot reload, a second context) and a
-- session is not. They are the only memory Sealitaire has: the .riv cannot
-- write anything, so this counts up from the moment the tab opened and starts
-- again when it closes. That is the whole scope of "progress" here.
-- ---------------------------------------------------------------------------

-- WHEN A QUEUED CHANGE IS ALLOWED TO LAND. Three, and each one is a
-- different answer to "how late may this be":
--
--   AT_PHRASE  when the region runs out. For a change nothing waits on.
--   AT_BLOCK   the next four-bar cell, the grid the bounce is built on. For
--              an escalation: within ten seconds of the card that earned it,
--              and still on a line the music was written to.
--   AT_BAR     the next bar, 2.55s. For the win, which must be immediate.
local AT_PHRASE, AT_BLOCK, AT_BAR = 0, 1, 2

-- HOW LONG A VOICE MUST HAVE PLAYED before `completed` is believed.
--
-- Two opposite failures meet here and a single rule has to survive both.
--
--   A HANDLE THAT LIES YES. A handle to a sound somebody else stopped
--   answers `completed` having played nothing. At a hundred and twenty
--   advances a second, believing it starts a new voice every frame.
--
--   A VOICE THAT ENDS EARLY. The region stops sounding before its length is
--   up — a voice culled, a decode that gave out, a runtime that will not
--   play a sixty-second asset. Then the clock is the only thing still
--   running and it will not reach the region's length for another half
--   minute, which is half a minute of SILENCE. That is the one that was
--   shipping, and it is worse than the other: the first stutters, this one
--   just stops.
--
-- Half a second separates them. Nothing that has played half a second is a
-- handle answering reflexively, and nothing that ends after half a second
-- should be waited out in silence. The clock still decides the musical
-- moment — `elapsed >= length` is the normal loop point and it is exact —
-- and this only catches a region that stopped when it should not have.
local MIN_PLAY = 0.5

-- Consecutive early ends before this stops believing `completed` at all. A
-- runtime whose handles always answer yes would otherwise restart the region
-- every half second forever, which is a stutter with no way to read it. Said
-- once, and then the clock runs the loop on its own.
local EARLY_LIMIT = 6

local believeCompleted = true   -- until a runtime proves its handles lie
local earlyEnds = 0
local playing = 0        -- index into music.loops, 0 = nothing sounding
local elapsed = 0        -- seconds into that region, from the frame's own dt
local queued = 0         -- what to switch to, 0 = nothing waiting
local queueAt = AT_PHRASE
local sessionDeals = 0
local sessionWins = 0

-- THE RUNG REACHED, and it does not come back down inside a deal.
--
-- Klondike lets you pull the top card back OFF a foundation (klondike.luau's
-- `runFrom` gives one from any non-tableau pile), and `score` drops on a
-- stock recycle. So the numbers the gates read are not monotonic, and a
-- ladder that simply asked "which rung is unlocked right now" would walk
-- back down: undo one card at twenty-six and the loud bed drops to the
-- development four bars later.
--
-- Unlocking is a one-way event within a deal. This is the latch that makes
-- it one, and `noteDeal` is the only thing that lets go of it.
local rungHigh = 0

-- The ring-out voice, so a second win (or a re-deal) can cut a wash that is
-- still going rather than layering a second one over it.
local washSound: AudioSound? = nil
local washVolume = 1.0

-- `musicDebug` in tuning.luau, in seconds; 0 is off. Counted in CALLS rather
-- than against a clock, so an instrument wired to a suspect clock cannot go
-- quiet exactly when the fault is that the clock stopped.
local debugEvery = 0
local beatCalls = 0

-- A HOT RELOAD LEAVES A TRACK NOBODY CAN REACH.
--
-- The CLI's watcher rebuilds in the SAME PROCESS. The scripting context is
-- new — this module is loaded again and `current` above is nil — but the
-- audio engine is not: its clock carries straight on, and so does the sound
-- the previous context started. There is no handle to it anywhere in the
-- script API: no enumerate, no stop-all, and an AudioSound cannot be parked
-- in a view model. Nothing here can stop it. So it must not add to it — a
-- tuning session is a save every few seconds, and that is a track a second.
--
-- The test is the engine's clock against THIS MODULE's: a fresh context
-- starts `sinceLoad` at zero, so an engine that is already minutes old means
-- somebody else's track is playing. A bare `Audio.time() > n` would also
-- refuse on a first run that simply took a while to reach its first frame.
--
-- IT CAN ONLY EVER REFUSE TO START, never stall a transport that is already
-- going, and a frozen engine clock makes `now - sinceLoad` negative, which
-- fails the test and carries on. That is deliberate: this is the only thing
-- left in the file that reads the audio clock, and it is arranged so that
-- the clock being wrong costs a warning rather than the music.
local RELOAD_GAP = 2.0
local orphaned = false
local sinceLoad = 0

local function checkOrphan(): boolean
    if orphaned then
        return true
    end
    if current ~= nil or Audio.time() - sinceLoad <= RELOAD_GAP then
        return false
    end
    orphaned = true
    print(
        `sealitaire: the watcher rebuilt and the track from before is still playing — ` ..
        `the engine survives a reload and the script cannot reach that sound. ` ..
        `Not starting a second one; restart to clear it.`
    )
    return true
end

-- ---------------------------------------------------------------------------
-- WHICH LOOP, AND WHEN
--
-- All four of these are pure and exported. The runtime's audio globals cannot
-- be stood up in a `--test` run, so the only way any of this is checkable is
-- for the decisions to be separable from the playing — the same split
-- `mayStart` above is written for.
-- ---------------------------------------------------------------------------

-- Is this loop available at all, given what has been played?
local function unlocked(loop: Loop, p: Progress): boolean
    local g = loop.gate
    if g == 0 then return true
    elseif g == 1 then return p.deals >= loop.gateN
    elseif g == 2 then return p.wins >= loop.gateN
    elseif g == 3 then return p.foundations >= loop.gateN
    elseif g == 4 then return p.score >= loop.gateN
    elseif g == 5 then return p.moves >= loop.gateN
    end
    -- An unknown gate is LOCKED, not open. A bake this script does not
    -- understand should cost the table a loop, never hand it one the CSV
    -- meant to hold back.
    return false
end

-- THE BED LADDER. The LAST unlocked bed in table order, not the first and not
-- the next one round.
--
-- A rotation was the wrong shape for this. The beds are a progression — the
-- main bed until ten cards are up, then the development, then the loud one at
-- twenty-six — and a progression is a ladder you climb and stay on, not a
-- carousel that keeps coming back to where it started. Rotating would drop
-- the player back to the opening bed every other phrase, which reads as the
-- music having no idea how the game is going.
--
-- LAST rather than best-matching, because "last unlocked" is a rule the CSV's
-- own order expresses: rows are rungs, top to bottom. The baker refuses a
-- table whose rungs do not climb.
local function bedFor(loops: { Loop }, p: Progress): number
    local found = 0
    for i, l in ipairs(loops) do
        if l.role == 0 and unlocked(l, p) then
            found = i
        end
    end
    return found
end

-- The first unlocked loop with a non-bed role. There is normally one intro
-- and one win; several would be alternates, and the first unlocked is the
-- one that is meant to be reachable.
local function roleFor(loops: { Loop }, role: number, p: Progress): number
    for i, l in ipairs(loops) do
        if l.role == role and unlocked(l, p) then
            return i
        end
    end
    return 0
end

-- Did `elapsed` cross a line of this grid between `was` and `now`?
--
-- The grid is counted from the START OF THE REGION, which is now the only
-- thing it can be counted from: each region is its own asset and its own
-- clock starting at zero. That is also the musically correct origin — every
-- region is a whole number of bars cut on a downbeat, so its own bar one is
-- the bounce's bar one as far as anything downstream can tell.
local function crossedBar(was: number, now: number, grid: number): boolean
    if grid <= 0 or was < 0 or now < was then
        return false
    end
    return math.floor(now / grid) > math.floor(was / grid)
end

-- Throw `loop` into its baked ring-out. A second voice, started in the frame
-- the music is cut -- see THE WASH in tools/sealitaire-music.mjs for why this
-- is an asset and not an effect.
--
-- A loop with no wash is not a failure and says nothing: `washSeconds` of 0
-- in the CSV is how you turn one off, and the intro and the win itself have
-- no business ringing out.
local function fireWash(loop: Loop, volume: number)
    local src = loop.wash
    if src == nil then
        return
    end
    -- Cut a wash still ringing from a previous cut before starting another.
    -- Two eight-second tails over each other is not a longer decay, it is a
    -- second reverb, and the second win of a session would be twice as loud
    -- as the first.
    local old = washSound
    if old ~= nil then
        old:stop(0.25)
    end
    local s = Audio.play(src)
    if s ~= nil then
        s.volume = volume
    end
    washSound = s
end

-- THE ONE CALL THAT REACHES THE AUDIO ENGINE, behind a seam.
--
-- `Audio` does not exist in a `--test` run at all. Everything else in this
-- module is arithmetic and can be executed there, and the transport has to
-- be as well — it is the part that was wrong for two days while the pure
-- decisions around it were provably right. So starting a sound goes through
-- here and tests put their own in.
--
-- The seam is deliberately this narrow: one function, taking an asset and
-- returning something with `completed`, `stop` and `volume`. A fake that
-- satisfies it is five lines, which is what keeps the tests honest about
-- what the runtime actually provides.
local function engineStart(src: AudioSource): AudioSound?
    return Audio.play(src)
end
local startSound: (AudioSource) -> any = engineStart

-- Put `i` on. Stops whatever was sounding and starts that region's asset
-- from its own zero, which is the only place an asset can start from and is
-- exactly where every region begins.
local function playLoop(self: Music, i: number, volume: number): boolean
    local l = self.loops[i]
    if l == nil or l.src == nil then
        return false
    end
    -- START FIRST, STOP SECOND. The order is the difference between a
    -- failed start costing a region change and a failed start costing the
    -- music: stopping first and then failing leaves nothing playing and
    -- nothing to recover from, because the driver believes a sound it
    -- already killed is still going. This way a refused voice leaves the
    -- previous region running and the next pass tries again.
    --
    -- The two overlap for the width of one statement, which is far shorter
    -- than a frame and far too short to flange even when it is the same
    -- region starting again.
    local snd = startSound(l.src)
    if snd == nil then
        return false
    end
    local old = current
    if old ~= nil then
        old:stop()
    end
    snd.volume = volume
    current = snd
    playing = i
    elapsed = 0
    queued = 0
    queueAt = AT_PHRASE
    if l.role == 0 then
        rungHigh = i
    end
    return true
end

-- What SHOULD be sounding, given the deal in front of us. Pure apart from
-- the latch it reads.
local function wantFor(self: Music, p: Progress): number
    local cur = self.loops[playing]
    -- A win is a state the deal has ended in. Nothing about the cards pulls
    -- the music back out of it; only the next deal does, through noteDeal.
    if cur ~= nil and cur.role == 2 then
        return playing
    end
    local want = bedFor(self.loops, p)
    -- Latched: the beds are in ladder order, so a lower index is a lower
    -- rung and the deal never goes back down to one.
    if want < rungHigh then
        return rungHigh
    end
    return want
end

-- ---------------------------------------------------------------------------
-- THE DRIVER. One call a frame; it owns everything above.
--
-- Returns the playhead to read the BAKE at -- the region's start in the
-- original bounce plus how far into it we are -- because music.bin is still
-- one analysis of the whole track and the regions are cut from it.
-- ---------------------------------------------------------------------------
local function drive(self: Music, dt: number, volume: number, p: Progress): number
    if not self.ready or #self.loops == 0 then
        return 0
    end
    sinceLoad += dt
    if checkOrphan() then
        return 0
    end

    -- Nothing going yet: the intro if there is one and it is unlocked,
    -- otherwise straight onto the bottom rung. A table with no intro row
    -- must still start playing.
    if current == nil or playing == 0 then
        local i = roleFor(self.loops, 1, p)
        if i == 0 then
            i = bedFor(self.loops, p)
        end
        if i ~= 0 then
            playLoop(self, i, volume)
        end
        local l0 = self.loops[playing]
        return if l0 ~= nil then l0.startSec else 0
    end

    local snd = current
    if snd ~= nil then
        snd.volume = volume
    end
    local was = elapsed
    elapsed += dt
    local cur = self.loops[playing]

    -- THE LADDER, WATCHED EVERY FRAME. Not at the phrase end: `deal` is
    -- twenty-four bars and `drift` is forty, so a rung that only changed
    -- there would arrive up to a minute and a half after the card that
    -- earned it, by which time the player has stopped connecting the two.
    if queued == 0 then
        local want = wantFor(self, p)
        if want ~= 0 and want ~= playing then
            queued = want
            -- A win is heard immediately, at the next BAR. An escalation
            -- waits for the next BLOCK, the cell the bounce is built from.
            queueAt = if self.loops[want].role == 2 then AT_BAR else AT_BLOCK
        end
    end

    -- THE REGION HAS RUN OUT — and the clock says so, not the sound.
    --
    -- There is no loop flag on an AudioSound, so a region repeats by being
    -- played again. The question is what counts as finished, and `completed`
    -- alone is not safe: a handle to a sound somebody else stopped answers
    -- yes having played nothing, and at a hundred and twenty advances a
    -- second one spurious yes becomes a new voice every frame. The old
    -- single-track loop needed a one-second floor under that answer.
    --
    -- Here the region's LENGTH is known exactly — it is a whole number of
    -- bars, cut by the baker and checked by test:sealitaireloops — so the
    -- clock can answer instead, and it answers at the right musical instant
    -- rather than a frame or two after the file ran dry. `completed` is kept
    -- as a backstop for the other direction: an asset SHORTER than its row
    -- claims would otherwise play silence until the clock caught up. It is
    -- only believed near the end, which is the whole of the old guard
    -- expressed as a fact about this region instead of a stopwatch.
    local length = cur.endSec - cur.startSec
    local onTime = elapsed >= length
    local early = not onTime
        and snd ~= nil
        and elapsed >= MIN_PLAY
        and believeCompleted
        and snd:completed()
    if early then
        earlyEnds += 1
        if earlyEnds >= EARLY_LIMIT then
            believeCompleted = false
            print(
                `sealitaire: "{cur.id}" has ended early {earlyEnds} times running — ` ..
                `this runtime's completed() cannot be trusted, so the clock will run the ` ..
                `loop on its own from here. If the voice really is stopping, the region ` ..
                `will now play past its end in silence instead of stuttering.`
            )
        end
    elseif onTime then
        earlyEnds = 0
    end
    if snd == nil or onTime or early then
        -- AN EARLY END IS A DROPPED VOICE, NOT A MUSICAL BOUNDARY. It
        -- resumes the same region and does not consume the queue: a glitch
        -- must not be able to promote the arrangement a rung, or take the
        -- win early, or eat the intro. Only a region that reached its end
        -- gets to decide what comes next.
        local into = playing
        if not early then
            into = if queued ~= 0 then queued else wantFor(self, p)
            if into == 0 then
                into = playing
            end
        end
        if into ~= playing and self.loops[into].role == 2 then
            fireWash(cur, washVolume)
        end
        playLoop(self, into, volume)
        local l = self.loops[playing]
        return if l ~= nil then l.startSec else 0
    end

    -- A queued change that will not wait for the region to finish.
    if queued ~= 0 and queueAt ~= AT_PHRASE then
        local grid = if queueAt == AT_BAR then self.barSeconds else self.blockSeconds
        if crossedBar(was, elapsed, grid) then
            local into = self.loops[queued]
            -- THE WASH GOES WITH THE CUT, not with the new loop. It is the
            -- ring-out of what was playing, so it is `cur`'s, and it starts
            -- in the same frame the music is taken away -- a wash that
            -- arrives after the cut is a reverb with a gap in front of it.
            if into.role == 2 then
                fireWash(cur, washVolume)
            end
            playLoop(self, queued, volume)
            local l = self.loops[playing]
            return if l ~= nil then l.startSec else 0
        end
    end

    if debugEvery > 0 then
        beatCalls += 1
        if beatCalls >= debugEvery * 120 then
            beatCalls = 0
            print(
                `music: loop={cur.id} at={string.format('%.2f', elapsed)}/` ..
                `{string.format('%.2f', cur.endSec - cur.startSec)} rung={rungHigh} ` ..
                `queued={queued}@{queueAt} found={p.foundations} score={p.score} ` ..
                `wants={wantFor(self, p)}`
            )
        end
    end

    return cur.startSec + elapsed
end

-- ---------------------------------------------------------------------------
-- WHAT THE TABLE TELLS US
-- ---------------------------------------------------------------------------

-- The gate inputs. The session's two counters live here; the deal's three are
-- the table's and are passed in. Everything that asks a gate anything goes
-- through this — including the two events below, which is why they take the
-- deal's numbers rather than filling in zeros of their own. An event that
-- invented its own Progress would answer a `score` gate with 0 and a loop
-- gated that way would be unreachable from the one place it is for.
local function progress(foundations: number, score: number, moves: number): Progress
    return {
        deals = sessionDeals,
        wins = sessionWins,
        foundations = foundations,
        score = score,
        moves = moves,
    }
end

-- A deal was dealt. Counts it — `deals` gates are asked about this number —
-- and queues the intro at the next bar.
local function noteDeal(self: Music, foundations: number, score: number, moves: number)
    sessionDeals += 1
    -- A new hand starts at the bottom of the ladder. This is the only thing
    -- that lowers it; see `rungHigh`.
    rungHigh = 0
    -- A fresh deal ends the win state. Cut the ring-out with it: a wash still
    -- hanging over a new hand is the previous game refusing to end.
    local w = washSound
    if w ~= nil then
        w:stop(0.5)
        washSound = nil
    end
    local i = roleFor(self.loops, 1, progress(foundations, score, moves))
    if i ~= 0 then
        queued = i
        queueAt = AT_BAR
    end
end

-- The deal was won. Queues a win loop at the next bar: a win is the one event
-- in this game that should be audible immediately, and waiting out a forty-bar
-- phrase would put the music's response a minute after the cards'.
local function noteWin(self: Music, foundations: number, score: number, moves: number)
    sessionWins += 1
    local i = roleFor(self.loops, 2, progress(foundations, score, moves))
    if i ~= 0 then
        queued = i
        queueAt = AT_BAR
    end
end

-- The two tuning numbers this module reads, in ONE call.
--
-- Not two setters, and that is not tidiness: table.luau is eight thousand
-- lines and sits right on Luau's type-inference complexity ceiling. Two
-- statements here instead of one tipped it over, and the whole file then
-- fails to typecheck with "Code is too complex" pointing at line 2740, which
-- is nowhere near this and has nothing wrong with it.
--
-- `wash` is the ring-out's send level; the frame that fires it is `follow`'s,
-- not the table's, which is why it is parked here at all. `debug` is the
-- heartbeat interval in seconds.
local function setMix(wash: number, debug: number)
    washVolume = wash
    debugEvery = debug
end

-- The region playing right now, for the headless clock. Every mode that has
-- no audio device free-runs its own playhead (see musicClock in table.luau),
-- and without this it would free-run across the whole file and read the bake
-- for regions the table is not in.
local function currentLoop(self: Music): Loop?
    return self.loops[playing]
end

-- HOW OFTEN THE WATER IS ALLOWED TO RING. Three limits, and all three are
-- needed. Measured in the player against this track, an unlimited read of the
-- flux fires 16 times a second through the loud half, which churns the eight
-- slots in half a second and reads as the water simply being agitated:
--
--   FIRE        the flux a band must reach at all. What keeps a soft passage
--               soft: the bands are normalised against the track's OWN quiet,
--               so even a near-silent bar is full of small rises.
--   REFRACTORY  the seconds that band must then wait. Per band, and the low
--               ones wait longest: a bass note's ring is big and wants room,
--               a hi-hat's is small and can come again quickly.
--   GAP         the seconds the TABLE must wait, whichever band wants it, and
--               one band at most per frame. This is the limit that does the
--               work: eight bands each obeying their own refractory still
--               stack up on a loud bar, because nothing was counting them
--               together.
--
-- All three, over this track in the player: 3.5 rings a second, four in a
-- typical second and six in the busiest. The eight slots hold about five at a
-- time and briefly fill; the one that falls off has faded to a hundredth of
-- its strength by then, so nothing visible is lost.
--
-- (Note that the player advances TWICE per displayed frame, so `step` runs at
-- 120Hz over a 60Hz bake. Everything here is in playhead seconds for that
-- reason: a limit counted in frames would be half as long as it reads.)
--
-- When several bands cross in the same frame the LOUDEST goes and the others
-- are simply dropped rather than queued — a queued onset would arrive after
-- the sound that caused it and the water would feel late.
local FIRE = 0.40
local REFRACTORY = { 0.50, 0.46, 0.42, 0.39, 0.35, 0.31, 0.28, 0.25 }
local GAP = 0.22

-- The band's row on the table, as a fraction of the height: a centre it
-- drifts around, how far it drifts, and how fast. Low bands sit deep and
-- wander slowly, high bands ride near the top.
local ROW_MID = { 0.74, 0.70, 0.66, 0.60, 0.54, 0.46, 0.38, 0.30 }
local ROW_SWING = 0.10
local ROW_SPEED = { 0.11, 0.13, 0.17, 0.19, 0.23, 0.29, 0.31, 0.37 }

local function new(): Music
    return {
        ready = false,
        bands = 0, frames = 0, rate = 60, duration = 0,
        barSeconds = 0, blockSeconds = 0, loops = {},
        hz = {}, data = nil, head = 0,
        lastFire = {}, lastAny = -10, smooth = {}, energy = 0,
    }
end

-- The bake's bytes → the fields above. Split out of `load` so the HEADER
-- LAYOUT is testable: `--test` cannot resolve an asset, so a test that went
-- through `load` could only ever build the Music table by hand and would
-- agree with a wrong parser about where the loop table starts.
local function parse(self: Music, data: buffer): boolean
    if buffer.len(data) < 28 or buffer.readstring(data, 0, 4) ~= 'SMUS' then
        print('sealitaire: music.bin is not a bake; no music')
        return false
    end
    if buffer.readu32(data, 4) ~= 3 then
        print('sealitaire: music.bin is a version this script does not read; no music')
        return false
    end
    self.frames = buffer.readu32(data, 8)
    self.rate = buffer.readf32(data, 12)
    self.duration = buffer.readf32(data, 16)
    self.bands = buffer.readu32(data, 20)
    for k = 1, self.bands do
        self.hz[k] = buffer.readf32(data, 24 + (k - 1) * 4)
        self.lastFire[k] = -10
        self.smooth[k] = 0
    end
    self.barSeconds = buffer.readf32(data, 24 + self.bands * 4)
    self.blockSeconds = self.barSeconds * buffer.readu32(data, 28 + self.bands * 4)
    local loopCount = buffer.readu32(data, 32 + self.bands * 4)
    local loopsAt = 36 + self.bands * 4
    -- Checked BEFORE the loop records are read, not after: a short blob read
    -- as a loop table gives plausible floats out of whatever follows, and
    -- those become seek targets.
    local want = loopsAt + loopCount * 36 + self.frames * self.bands * 2
    if buffer.len(data) < want then
        print(`sealitaire: music.bin is short ({buffer.len(data)} of {want} bytes); no music`)
        return false
    end
    self.loops = {}
    for i = 1, loopCount do
        local o = loopsAt + (i - 1) * 36
        -- The id is 16 bytes, NUL-padded. Read to the terminator: reading all
        -- sixteen would carry the padding into every print and comparison.
        local id = ''
        for c = 0, 15 do
            local byte = buffer.readu8(data, o + c)
            if byte == 0 then
                break
            end
            id ..= string.char(byte)
        end
        self.loops[i] = {
            id = id,
            startSec = buffer.readf32(data, o + 16),
            endSec = buffer.readf32(data, o + 20),
            role = buffer.readu8(data, o + 24),
            gate = buffer.readu8(data, o + 25),
            gateN = buffer.readf32(data, o + 28),
            washSeconds = buffer.readf32(data, o + 32),
            src = nil,
            wash = nil,
        }
    end
    self.head = loopsAt + loopCount * 36
    self.data = data
    self.ready = true
    print(
        `sealitaire: music {self.duration}s, {self.frames} frames, {self.bands} bands, ` ..
        `{loopCount} loops on a {self.barSeconds}s bar, {self.blockSeconds}s block`
    )
    return true
end

-- Read music.bin. Returns false (and says why) rather than throwing, so a
-- missing bake costs the table its music and nothing else.
local function load(self: Music, context: Context): boolean
    local blob = context:blob('music')
    if blob == nil then
        print('sealitaire: music.bin missing; no music (run npm run sealitaire:music)')
        return false
    end
    if not parse(self, blob.data) then
        return false
    end
    -- THE ASSETS ARE RESOLVED HERE, ONCE. `context:audio` is a lookup and
    -- doing it at the moment of a win, or of a rung changing, would put it
    -- in the one frame that cannot afford to be wrong. Anything missing is
    -- named: a region without its asset is simply never played, which is a
    -- gap in the ladder and exactly the kind of silence that otherwise gets
    -- blamed on the gates. tools/sealitaire-loops-test.mjs is what keeps it
    -- from happening in the first place.
    local missing = 0
    for _, l in ipairs(self.loops) do
        l.src = context:audio(l.id)
        if l.src == nil then
            missing += 1
            print(`sealitaire: music/{l.id}.flac missing; the "{l.id}" loop can never play`)
        end
        if l.washSeconds > 0 then
            l.wash = context:audio(`wash-{l.id}`)
            if l.wash == nil then
                print(`sealitaire: music/wash-{l.id}.flac missing; "{l.id}" will cut without a ring-out`)
            end
        end
    end
    if missing >= #self.loops then
        print('sealitaire: no music assets resolved at all; no music')
        self.ready = false
        return false
    end
    return true
end

-- Band `k` at playhead `t`, linearly interpolated between the two analysis
-- frames either side. The interpolation matters more than it looks: the bake
-- is 60Hz and so is the display, but they are not in step, and sampling the
-- nearest frame makes a steady note flicker at the beat frequency between
-- them.
local function sample(self: Music, k: number, t: number): (number, number)
    local data = self.data
    if data == nil or self.frames == 0 then
        return 0, 0
    end
    local f = t * self.rate
    if f < 0 then
        f = 0
    end
    local i0 = math.floor(f)
    if i0 >= self.frames - 1 then
        i0 = self.frames - 1
        local at = self.head + (i0 * self.bands + (k - 1)) * 2
        return buffer.readu8(data, at) / 255, buffer.readu8(data, at + 1) / 255
    end
    local frac = f - i0
    local a = self.head + (i0 * self.bands + (k - 1)) * 2
    local b = a + self.bands * 2
    local l0, l1 = buffer.readu8(data, a) / 255, buffer.readu8(data, b) / 255
    local f0, f1 = buffer.readu8(data, a + 1) / 255, buffer.readu8(data, b + 1) / 255
    -- The level lerps; the flux takes the LARGER of the pair. A flux spike is
    -- one or two frames wide and lerping halves the very peaks the impulses
    -- are meant to fire on.
    return l0 + (l1 - l0) * frac, math.max(f0, f1)
end

-- Advance to playhead `t` and return the ripples to push in this frame: each
-- {x, y} in UV, with a strength already scaled by the band's own loudness.
-- `dt` smooths the bed; `t` is the sound's own clock, not the table's.
local function step(self: Music, t: number, dt: number): { Band }
    local out: { Band } = {}
    if not self.ready then
        return out
    end
    local sum = 0
    local smoothK = 1 - math.exp(-6 * dt)
    -- A seek, or the track looping, moves the playhead backwards. The
    -- refractories are kept in PLAYHEAD seconds, so a jump clears them rather
    -- than muting the first half second of every loop.
    if t < self.lastAny then
        self.lastAny = -10
        for k = 1, self.bands do
            self.lastFire[k] = -10
        end
    end
    -- One pass to smooth the bed and find the loudest onset; only that one
    -- rings, and only if the table has waited GAP.
    local best = 0
    local bestFlux = 0
    local bestLevel = 0
    for k = 1, self.bands do
        local level, flux = sample(self, k, t)
        self.smooth[k] += (level - self.smooth[k]) * smoothK
        sum += self.smooth[k]
        if flux >= FIRE and flux > bestFlux and t - self.lastFire[k] >= REFRACTORY[k] then
            best = k
            bestFlux = flux
            bestLevel = level
        end
    end
    self.energy += (sum / self.bands - self.energy) * smoothK
    if best > 0 and t - self.lastAny >= GAP then
        local k = best
        self.lastFire[k] = t
        self.lastAny = t
        -- The spectrum laid across the table: band 1 at the left edge, band 8
        -- at the right. Nudged off its exact column, and its row drifting, so
        -- eight bands do not wear eight bullseyes into the water.
        local x = (k - 0.5) / self.bands + math.sin(t * 0.7 + k * 2.399) * 0.035
        local y = ROW_MID[k] + math.sin(t * ROW_SPEED[k] + k * 1.7) * ROW_SWING
        table.insert(out, {
            k = k,
            x = math.min(0.97, math.max(0.03, x)),
            y = math.min(0.95, math.max(0.05, y)),
            -- Loud bands ring harder, but a quiet one is never silent: a band
            -- can be quiet and still have the sharpest onset in the track.
            level = bestLevel,
            flux = bestFlux * (0.45 + 0.55 * bestLevel),
        })
    end
    return out
end

return {
    new = new,
    load = load,
    parse = parse,
    drive = drive,
    step = step,
    sample = sample,
    -- The decisions, pure and separately testable: `--test` has no audio
    -- device and never will, so anything that matters has to be reachable
    -- without one.
    unlocked = unlocked,
    bedFor = bedFor,
    roleFor = roleFor,
    crossedBar = crossedBar,
    noteDeal = noteDeal,
    noteWin = noteWin,
    progress = progress,
    currentLoop = currentLoop,
    setMix = setMix,
    -- Tests only; production never calls this and `startSound` defaults to
    -- the engine.
    setPlayer = function(fn: ((AudioSource) -> any)?)
        startSound = if fn ~= nil then fn else engineStart
    end,
    isOrphaned = function(): boolean return orphaned end,
    RELOAD_GAP = RELOAD_GAP,
    FIRE = FIRE,
    REFRACTORY = REFRACTORY,
    GAP = GAP,
    -- The transport, for tests and the tuner's readout.
    playingIndex = function(): number return playing end,
    queuedIndex = function(): number return queued end,
    elapsedIn = function(): number return elapsed end,
    resetTransport = function()
        playing, elapsed, queued, queueAt, rungHigh = 0, 0, 0, AT_PHRASE, 0
        believeCompleted, earlyEnds = true, 0
        sessionDeals, sessionWins = 0, 0
        current, washSound = nil, nil
        orphaned, sinceLoad = false, 0
    end,
}
