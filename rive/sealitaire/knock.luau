-- ============================================================================
-- THE KNOCK — which rung of the baked knock bank a body's knock plays, pure.
--
-- Rive's AudioSound is transport and volume: no pitch, no filter, no send. So
-- tools/sealitaire-sfx-fx.mjs (`knock`) prints a LADDER — every flick-plop at
-- five pitch steps, and a reverb "bus" copy per step at four low-pass
-- cutoffs — and this module is the arithmetic that picks from it:
--
--   step(len, ref, octaves)  the pitch step for a body `len` long against a
--                            reference length, `octaves` per doubling of
--                            size (inverse: bigger is lower); -STEPS..STEPS
--   sweep(s)                 the two neighbouring cutoff rungs a sweep 0..1
--                            (0 open, 1 darkest) sits between, and their
--                            equal-power weights
--
-- STEPS and CUTOFFS mirror the baker's KNOCK table. tests.luau holds this
-- file's numbers; tools/sealitaire-sfx-test.mjs holds the files.
-- ============================================================================

local M = {}

M.STEPS = 2          -- k = -2..2, six semitones each: an octave each way
M.CUTOFFS = 4        -- rungs of the bus's low-pass ladder, c = 0 open .. 3 darkest

function M.step(len: number, ref: number, octaves: number): number
    if len <= 0 or ref <= 0 or octaves <= 0 then
        return 0
    end
    -- Inversely proportional: pitch ratio = (ref / len) ^ octaves, in
    -- octaves that is octaves * log2(ref / len); two steps to the octave.
    local oct = octaves * math.log(ref / len, 2)
    local k = math.floor(oct * 2 + 0.5)
    return math.max(-M.STEPS, math.min(M.STEPS, k))
end

function M.sweep(s: number): (number, number, number, number)
    local t = math.max(0, math.min(1, s)) * (M.CUTOFFS - 1)
    local lo = math.floor(t)
    if lo >= M.CUTOFFS - 1 then
        return M.CUTOFFS - 1, M.CUTOFFS - 1, 1, 0
    end
    local f = t - lo
    -- Equal power: the two rungs sum to one loudness through the crossfade.
    return lo, lo + 1, math.cos(f * math.pi / 2), math.sin(f * math.pi / 2)
end

return M
