-- ============================================================================
-- THE MUSIC — the track's baked FFT read back against the playhead, turned
-- into ripple impulses on the water.
--
-- Rive's scripting cannot analyse audio — a script can start a sound, ask it
-- the time and seek it, and that is all it gets. So the FFT is baked by
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
-- THE LOOPS. One bounce, several regions of it, and the table seeks between
-- them — nothing is cut into a file of its own.
--
-- That is possible because `AudioSound:seek` exists. It did not used to, and
-- comments elsewhere in this project still say `Audio.play` is the whole of
-- the audio API; they are out of date. Seeking is what lets a twenty-six-loop
-- bounce ship as one asset and one bake.
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
    wash: AudioSource?,    -- resolved at load; nil if the asset is missing
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

-- ONE TRACK, EVER.
--
-- The sound handle lives in this MODULE, not on the table that asks for it. A
-- module is loaded once per scripting context, so `current` is the one place
-- a sound exists and `keepPlaying` is the only thing that ever starts one —
-- every table, every frame, asks it and gets the same sound back.
--
-- The track is a minute and a game is not, and there is no loop flag on an
-- `AudioSound`, so looping means playing it again. Two things about that, and
-- both of them were wrong before:
--
--   STOP FIRST. Playing again without stopping the finished one leaves it in
--   the mix. It is quiet, so the first loop sounds fine and the tenth is a
--   wall — the symptom is the track "not stopping the old instance", and it
--   only shows up minutes in, which is nowhere near where you look.
--
--   BELIEVE `completed` ONLY ONCE A SECOND. `completed` is a question asked
--   of a handle, and a handle to a sound that has been stopped answers yes
--   having played nothing. With no floor under how often that answer may
--   start a sound, one spurious yes starts a second voice on the next frame,
--   and that one's yes starts a third — at the player's 120 advances a second
--   the track machine-guns, and every copy is still playing. RESTART_GAP is
--   the floor, on the audio engine's own clock, which is the only clock here
--   that is not the thing under suspicion.
local RESTART_GAP = 1.0

local current: AudioSound? = nil
local lastStart = -1000

-- ---------------------------------------------------------------------------
-- THE TRANSPORT. Beside `current` and for the same reason: there is one
-- sound, so there is one playhead, so there is one answer to "which region is
-- playing". A table asks; it does not own any of this.
--
-- `sessionDeals` and `sessionWins` are here rather than on the table because
-- the table is rebuilt (a re-deal, a hot reload, a second context) and a
-- session is not. They are the only memory Sealitaire has: the .riv cannot
-- write anything, so this counts up from the moment the tab opened and starts
-- again when it closes. That is the whole scope of "progress" here.
-- ---------------------------------------------------------------------------
-- WHEN A QUEUED CHANGE IS ALLOWED TO LAND. Three, and each one is a
-- different answer to "how late may this be":
--
--   AT_PHRASE  when the loop runs out. For a change nothing is waiting on.
--   AT_BLOCK   the next four-bar cell, the grid the bounce is built on. For
--              an escalation: within ten seconds of the card that earned it,
--              and still on a line the music was written to.
--   AT_BAR     the next bar, 2.55s. For the win, which must be immediate.
--
-- The grids are the FILE's, counted from its start, so they survive a region
-- change — every region begins on a bar and on a block.
local AT_PHRASE, AT_BLOCK, AT_BAR = 0, 1, 2

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
local playing = 0        -- index into music.loops, 0 = nothing placed yet
local queued = 0         -- what to switch to, 0 = nothing waiting
local queueAt = AT_PHRASE
local lastT = -1         -- last playhead read, for the grid-crossing test
local sessionDeals = 0
local sessionWins = 0
-- The ring-out voice, so a second win (or a re-deal) can cut a wash that is
-- still going rather than layering a second one over it.
local washSound: AudioSound? = nil
local washVolume = 1.0

-- A HOT RELOAD LEAVES A TRACK NOBODY CAN REACH.
--
-- The CLI's watcher rebuilds in the SAME PROCESS. The scripting context is
-- new — this module is loaded again and `current` above is nil — but the
-- audio engine is not: its clock carries straight on, and so does the sound
-- the previous context started. Measured, by printing `Audio.time()` at
-- module load and at every play:
--
--   MUSICMOD loaded engine=0       MUSICPLAY engine=0      first run
--   -- a file changes, the watcher rebuilds --
--   MUSICMOD loaded engine=7.78    MUSICPLAY engine=7.84   a SECOND track
--
-- The first one is still playing and there is no handle to it anywhere in the
-- script API: no enumerate, no stop-all, and an AudioSound cannot be parked
-- in a view model. Nothing this module does can stop it. So it must not add
-- to it — a tuning session is a save every few seconds, and that is a track
-- every few seconds, all of them playing at once.
--
-- The tell is the two clocks DIVERGING, not the engine clock being large. On
-- a fresh process the engine and the table both start at zero and stay within
-- a few hundred milliseconds of each other (the card sounds open the device
-- during the first deal, just before the music loads). After a reload the
-- table restarts at zero while the engine is minutes old. Comparing the two
-- is what makes this safe: a bare `Audio.time() > n` test would also refuse to
-- play on a fresh run that simply took a while to reach its first frame.
local RELOAD_GAP = 2.0
local orphaned = false

-- Whether a previous context's track is still playing and out of reach, and
-- roughly where it is. It started at engine time zero, so the engine's own
-- clock modulo the track length IS its playhead — which is what keeps the
-- ripples in step with the sound that is actually audible.
local function orphanPlayhead(duration: number): number
    if duration <= 0 then
        return 0
    end
    local now = Audio.time()
    return now - math.floor(now / duration) * duration
end

-- Whether the track may be started right now. Pure, and exported, because the
-- rule above is the whole fix and the runtime's audio globals cannot be stood
-- up in a `--test` run — the decision is testable even though the playing is
-- not. `have` is whether a sound exists at all, `completed` what it says of
-- itself, `now` and `last` the engine clock then and at the last start.
local function mayStart(have: boolean, completed: boolean, now: number, last: number): boolean
    if now - last < RESTART_GAP then
        return false
    end
    return not have or completed
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

-- Where to seek when `loop` runs out at playhead `t` and `into` takes over.
--
-- THE OVERSHOOT IS CARRIED, and that is the whole of it. The playhead is read
-- once a frame, so by the time `t >= loop.endSec` is true the sound is
-- already a fraction of a frame past the end. Seeking to `into.startSec`
-- would throw that fraction away and every wrap would push the downbeat a
-- little later, which over a few minutes is a track that has drifted off its
-- own grid. Carrying it — start `t - endSec` INTO the new region — keeps the
-- bar line exactly where it was; what is lost instead is a few milliseconds
-- of audio at the seam, which is a wrap and is where nobody is listening.
--
-- The carry is capped at a bar so a stalled frame (a reload, a long GC) can
-- never skip past the new region's first downbeat.
local function wrapTo(t: number, loop: Loop, into: Loop, barSeconds: number): number
    local over = t - loop.endSec
    if over < 0 then
        over = 0
    end
    local cap = if barSeconds > 0 then barSeconds else 0.25
    if over > cap then
        over = 0
    end
    return into.startSec + over
end

-- Did the playhead cross a line of this grid between `was` and `now`? The
-- grid is the FILE's, counted from its start, which is what makes it usable
-- across a region change: every region begins on a bar, so one grid serves
-- them all. Called with the bar for a win and the block for an escalation.
local function crossedBar(was: number, now: number, grid: number): boolean
    if grid <= 0 or was < 0 or now < was then
        return false
    end
    return math.floor(now / grid) > math.floor(was / grid)
end

-- Start the track if it is not going, restart it if it has run out, and keep
-- its volume current. Returns the one sound, or nil when there is no audio
-- device (every headless mode but --screenshot).
local function keepPlaying(src: AudioSource, volume: number, tableTime: number): AudioSound?
    local now = Audio.time()
    if orphaned then
        return nil
    end
    if current == nil and now - tableTime > RELOAD_GAP then
        -- See RELOAD_GAP. Said once, plainly, because the symptom otherwise
        -- reads as the music having stopped working.
        orphaned = true
        print(
            `sealitaire: the watcher rebuilt and the track from before is still playing — ` ..
            `the engine survives a reload and the script cannot reach that sound. ` ..
            `Not starting a second one; restart to clear it.`
        )
        return nil
    end
    local sound = current
    if mayStart(sound ~= nil, if sound ~= nil then sound:completed() else false, now, lastStart) then
        lastStart = now
        if sound ~= nil then
            sound:stop()
        end
        current = Audio.play(src)
    end
    local c = current
    if c ~= nil then
        c.volume = volume
    end
    return c
end

-- ---------------------------------------------------------------------------
-- STAYING INSIDE THE REGION
--
-- Called once a frame with the sound. Everything above decided WHAT; this is
-- the only thing that touches the playhead.
--
-- A seek is not instant on the engine's side, and the playhead is read once a
-- frame, so the frame after a seek can still report the old time and ask for
-- the same seek again. SEEK_GAP is the floor under that.
--
-- IT IS NOT A TIMER ANY MORE, and that matters. It used to be `Audio.time() -
-- lastSeek < SEEK_GAP`, which makes the whole transport depend on the engine
-- clock advancing. If `Audio.time()` ever sits still — and there is no
-- promise here that it does not, on a runtime where nothing else in this
-- module would notice — then after the very first seek that test is
-- `0 - 0 < 0.05`, true forever, and `follow` returns early on every frame
-- for the rest of the session. The music plays, the water ripples, and not
-- one gate, escalation or win ever fires again. There is no test that can
-- see that, because a test supplies its own clock and always advances it.
--
-- So the throttle is on the thing it is actually waiting for: the PLAYHEAD
-- moving away from where we just put it. That cannot wedge, because if the
-- playhead is not moving there is nothing to be late for.

-- ---------------------------------------------------------------------------
-- DOES SEEK ACTUALLY WORK HERE?
--
-- Everything in this file rests on one assumption: that `sound:seek(x)` moves
-- the playhead. If it does not — a runtime without the binding, or one that
-- accepts the call and ignores it — the bounce plays end to end and the loop
-- table, the gates and the win are all inert. It sounds like music. It is the
-- single failure mode of this design and it is invisible.
--
-- A PROBE HAS TO SEEK SOMEWHERE THE PLAYHEAD WAS NOT GOING ANYWAY, and the
-- first version of this did not. It armed on the first placement, which seeks
-- to the intro's start — ZERO, which is exactly where a sound that has just
-- started already is. It reported DEAD on the first run, and the reading was
-- worthless: a seek to where you already are cannot be told from no seek at
-- all. The intro handing over to the first bed is the same trap, because the
-- regions are contiguous and `wrapTo` carries the overshoot, so that seek
-- also lands where the playhead was going by itself.
--
-- So: arm only on a seek that MOVES the playhead a long way, and then decide
-- between the two hypotheses rather than against a threshold —
--
--   it worked   the playhead is near  target + elapsed
--   it did not  the playhead is near  where-it-was + elapsed
--
-- whichever is closer. That is unambiguous however long the frame took, and
-- a seek with nothing to do can never be mistaken for a broken one.
local PROBE_JUMP = 2.0     -- a seek shorter than this proves nothing
local PROBE_WAIT = 0.4     -- engine seconds to let the playhead settle

local seekWorks = true     -- assumed until measured; the design needs it
local seekTested = false
local probeAimed = -1
local probeFrom = -1
local probeAt = -1
local forceProbe = false

local function armProbe(from: number, to: number, engine: number)
    if seekTested or probeAimed >= 0 or math.abs(to - from) < PROBE_JUMP then
        return
    end
    probeAimed, probeFrom, probeAt = to, from, engine
end

local function readProbe(t: number, engine: number)
    if probeAimed < 0 or engine - probeAt < PROBE_WAIT then
        return
    end
    local elapsed = engine - probeAt
    local aimed, from = probeAimed, probeFrom
    probeAimed = -1
    seekTested = true
    seekWorks = math.abs(t - (aimed + elapsed)) <= math.abs(t - (from + elapsed))
    if seekWorks then
        print(
            `sealitaire: seek works — sent from {string.format('%.2f', from)}s to ` ..
            `{string.format('%.2f', aimed)}s, playhead now {string.format('%.2f', t)}s. ` ..
            `The loop table is live.`
        )
    else
        print(
            `sealitaire: SEEK DOES NOTHING on this runtime. Sent from ` ..
            `{string.format('%.2f', from)}s to {string.format('%.2f', aimed)}s and the ` ..
            `playhead is at {string.format('%.2f', t)}s — it carried straight on. ` ..
            `The bounce plays end to end and musicLoops.csv, the gates and the win ` ..
            `are all inert. The regions have to become their own assets.`
        )
    end
end

-- The definitive version, behind `musicDebug`. Rather than wait for the first
-- long wrap — seventy seconds into this table — jump the playhead somewhere
-- it could not have reached on its own. It costs a fraction of a second of
-- the wrong bar, which is why it is not on by default and is exactly what you
-- want when you are standing in front of it asking the question.
local function forceProbeSeek(self: Music, sound: any, t: number, engine: number)
    if seekTested or probeAimed >= 0 or not forceProbe or self.duration <= 0 then
        return
    end
    local to = if t < self.duration * 0.5 then self.duration * 0.75 else self.duration * 0.25
    armProbe(t, to, engine)
    sound:seek(to)
end

local SEEK_GAP = 0.05
local lastSeek = -1000
local lastSeekTo = -1
local seekWarned = false

-- ---------------------------------------------------------------------------
-- THE HEARTBEAT. `musicDebug` in tuning.luau, in seconds; 0 is off.
--
-- Everything this module decides is decided against numbers nobody can see:
-- the playhead, the foundation count, which rung the ladder is on. When the
-- music does not do what the table expects, every one of those is equally
-- suspect and none of them is visible — and the loudest failure mode of all,
-- a playhead that is not moving, looks exactly like music playing normally.
--
-- `moved` is the one to read first. It is how far the playhead travelled
-- since the last beat, and it should be the beat interval. If it is ~0 the
-- sound is not advancing and nothing below it means anything; if it is the
-- interval but `loop` never changes, the fault is in the gates above.
-- Counted in CALLS, not seconds, for the same reason: an instrument wired to
-- the clock it is there to investigate goes quiet exactly when the fault is
-- that the clock stopped. `engine` is printed instead, so a frozen one is a
-- column that never changes rather than an absence of output.
local debugEvery = 0
local beatCalls = 0
local beatHead = -1



-- Throw `loop` into its baked ring-out. A second voice, started in the same
-- frame the music is cut — see THE WASH in tools/sealitaire-music.mjs for why
-- this is an asset and not an effect.
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

-- `sound` is typed `any` and `engine` is passed in rather than read from
-- `Audio.time()` here. Both are so this function can be RUN in a test: there
-- is no audio device under `--test` and `Audio` does not exist there at all,
-- so a version that reached for either would be the one piece of new
-- machinery in this file that nothing could execute. It takes anything with
-- `time`, `seek` and `completed`, which an `AudioSound` is.
local function follow(self: Music, sound: any, p: Progress, engine: number)
    if sound == nil or not self.ready or #self.loops == 0 then
        return
    end
    local t = sound:time()
    local cur = self.loops[playing]
    readProbe(t, engine)
    if cur ~= nil then
        forceProbeSeek(self, sound, t, engine)
    end
    -- Still sitting where the last seek put it: the engine has not caught up
    -- yet, so every decision below would be made against a stale playhead.
    -- Bounded by the engine clock too, so a runtime that reports the seek
    -- target back verbatim forever cannot stall it either.
    if lastSeekTo >= 0 and math.abs(t - lastSeekTo) < 1e-4 and engine - lastSeek < SEEK_GAP then
        return
    end

    -- Before the seek gate, so a beat is never swallowed by it.
    if debugEvery > 0 then
        beatCalls += 1
        if beatCalls >= debugEvery * 120 then
            local moved = if beatHead < 0 then 0 else t - beatHead
            beatCalls = 0
            beatHead = t
            print(
                `music: head={string.format('%.2f', t)} moved={string.format('%+.2f', moved)} ` ..
                `engine={string.format('%.2f', engine)} ` ..
                `loop={if cur ~= nil then cur.id else '-'} rung={rungHigh} ` ..
                `queued={queued}@{queueAt} found={p.foundations} score={p.score} ` ..
                `seek={if not seekTested then '?' elseif seekWorks then 'ok' else 'DEAD'} ` ..
                `wants={bedFor(self.loops, p)}`
            )
        end
    end

    -- Nothing placed yet. The intro if there is one and it is unlocked,
    -- otherwise straight onto the ladder -- a table with no intro row must
    -- still start playing.
    if cur == nil then
        local i = roleFor(self.loops, 1, p)
        if i == 0 then
            i = bedFor(self.loops, p)
        end
        if i == 0 then
            return
        end
        playing = i
        queued = 0
        queueAt = AT_PHRASE
        if self.loops[i].role == 0 then
            rungHigh = i
        end
        lastSeek = engine
        lastT = self.loops[i].startSec
        lastSeekTo = lastT
        armProbe(t, lastT, engine)
        sound:seek(lastT)
        return
    end

    -- THE LADDER, WATCHED EVERY FRAME. Not at the phrase end: `deal` is
    -- twenty-four bars and `drift` is forty, so a rung that only changed
    -- there would arrive up to a minute and a half after the card that
    -- earned it, by which time the player has stopped connecting the two.
    -- The escalation is noticed here and lands at the next BLOCK.
    --
    -- A win outranks it: role 2 is a state the deal has ended in, and a
    -- foundation count cannot pull the music back out of it.
    if cur.role == 0 and queued == 0 then
        local want = bedFor(self.loops, p)
        -- Latched: the beds are in ladder order, so a lower index is a lower
        -- rung and the deal never goes back to one.
        if want < rungHigh then
            want = rungHigh
        elseif want ~= 0 then
            rungHigh = want
        end
        if want ~= 0 and want ~= playing then
            queued = want
            queueAt = AT_BLOCK
        end
    end

    -- A queued switch that will not wait for the phrase. The win lands on the
    -- next BAR so it is heard as part of the music rather than as an edit; an
    -- escalation lands on the next BLOCK, the cell the bounce is built from.
    if queued ~= 0 and queueAt ~= AT_PHRASE then
        local grid = if queueAt == AT_BAR then self.barSeconds else self.blockSeconds
        if crossedBar(lastT, t, grid) then
            local into = self.loops[queued]
            -- THE WASH GOES WITH THE CUT, not with the new loop. It is the
            -- ring-out of what was playing, so it is `cur`'s, and it has to
            -- start in the same frame the music is taken away -- a wash that
            -- arrives after the cut is a reverb with a gap in front of it.
            if into.role == 2 then
                fireWash(cur, washVolume)
            end
            print(`music: {cur.id} -> {into.id} at {string.format('%.2f', t)} (queued, {if queueAt == AT_BAR then 'bar' else 'block'})`)
            playing = queued
            queued = 0
            queueAt = AT_PHRASE
            lastSeek = engine
            lastT = into.startSec
            lastSeekTo = lastT
            armProbe(t, lastT, engine)
            sound:seek(lastT)
            return
        end
    end

    -- The playhead is BEFORE the region. Not a wrap -- the sound was restarted
    -- under us (a completed track, a re-play) and is back at zero. Put it
    -- back where it was; advancing the ladder here would silently skip a
    -- rung every time the track ran out.
    if t < cur.startSec then
        lastSeek = engine
        lastT = cur.startSec
        lastSeekTo = lastT
        sound:seek(lastT)
        return
    end

    if t < cur.endSec and not sound:completed() then
        lastT = t
        return
    end

    -- The phrase is over. Whatever was queued; otherwise the ladder's rung,
    -- which is usually the loop that just finished and so is a repeat.
    --
    -- A WIN HOLDS. It repeats itself until the next deal rather than handing
    -- back to a bed: the deal is over, and music that wanders back to the
    -- playing bed thirty seconds after a win is the game forgetting.
    local into = queued
    if into == 0 then
        into = if cur.role == 2 then playing else bedFor(self.loops, p)
    end
    if into == 0 then
        into = playing
    end
    local to = wrapTo(t, cur, self.loops[into], self.barSeconds)
    if into ~= playing then
        print(`music: {cur.id} -> {self.loops[into].id} at {string.format('%.2f', t)} (phrase end)`)
    end
    playing = into
    queued = 0
    queueAt = AT_PHRASE
    lastSeek = engine
    lastT = to
    lastSeekTo = to
    armProbe(t, to, engine)
    sound:seek(to)
    -- IF SEEKING DOES NOT WORK, THIS IS THE ONLY THING THAT WILL SAY SO.
    --
    -- A `seek` that is silently a no-op on some runtime is not an error and
    -- not a silence: the track simply plays straight through from end to end
    -- and the loops, the gates and the win all do nothing, which sounds
    -- exactly like music. The tell is that the playhead keeps sailing past
    -- the same region end and every wrap is asked for again. Said once.
    if not seekWarned and math.abs(sound:time() - to) > 1 then
        seekWarned = true
        print(
            `sealitaire: asked the track to seek to {to}s and it is at {sound:time()}s — ` ..
            `if this runtime cannot seek, the loop table does nothing and the bounce ` ..
            `plays end to end.`
        )
    end
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
    -- Any debug at all asks the definitive question; see forceProbeSeek.
    forceProbe = debug > 0
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
    -- THE WASHES ARE RESOLVED HERE, ONCE. `context:audio` is a lookup and
    -- doing it at the moment of a win would put it in the one frame that
    -- cannot afford to be wrong. A missing one is named and costs that loop
    -- its ring-out; the bake and tools/sealitaire-loops-test.mjs are what
    -- keep it from happening.
    for _, l in ipairs(self.loops) do
        if l.washSeconds > 0 then
            l.wash = context:audio(`wash-{l.id}`)
            if l.wash == nil then
                print(`sealitaire: music/wash-{l.id}.flac missing; "{l.id}" will cut without a ring-out`)
            end
        end
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
    keepPlaying = keepPlaying,
    orphanPlayhead = orphanPlayhead,
    isOrphaned = function(): boolean return orphaned end,
    mayStart = mayStart,
    RESTART_GAP = RESTART_GAP,
    follow = follow,
    unlocked = unlocked,
    bedFor = bedFor,
    roleFor = roleFor,
    setMix = setMix,
    -- '?' until a long seek has been measured, then 'ok' or 'dead'. The
    -- verdict decides whether this whole design works, so it is testable.
    seekVerdict = function(): string
        return if not seekTested then '?' elseif seekWorks then 'ok' else 'dead'
    end,
    wrapTo = wrapTo,
    crossedBar = crossedBar,
    noteDeal = noteDeal,
    noteWin = noteWin,
    progress = progress,
    currentLoop = currentLoop,
    -- The transport, for tests and for the tuner's readout. Written only by
    -- `follow` and the two note* events above.
    playingIndex = function(): number return playing end,
    queuedIndex = function(): number return queued end,
    resetTransport = function()
        playing, queued, queueAt, lastT, lastSeek, rungHigh = 0, 0, AT_PHRASE, -1, -1000, 0
        lastSeekTo, seekTested, seekWorks, probeAimed = -1, false, true, -1
        seekWarned = false
        washSound = nil
        sessionDeals, sessionWins = 0, 0
    end,
    step = step,
    sample = sample,
    FIRE = FIRE,
    REFRACTORY = REFRACTORY,
    GAP = GAP,
}
