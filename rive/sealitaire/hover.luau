-- ============================================================================
-- THE HOVER POP — a stack rising under the pointer as a wave, pure.
--
-- Hover a card and the RUN under it (that card and every face-up card below
-- it in the column: what a drag would pick up) pops: the hovered card first,
-- each card below it a beat later, so a springy wave runs down the chain and
-- settles. Leave, and the same wave lets them down. A press dips the top
-- card for a frame on its way into the hand, which is what a click feels
-- like.
--
-- Each card view carries a `Pop`: `pop` is 0 at rest and 1 fully popped
-- (the table turns that into scale, a rise up the screen and shadow — never
-- a shear; the card keeps its shape), `vpop` its velocity, and the ARMING:
-- `goal` is where it is going, `prev` where it was going, `arm` the time
-- the new goal takes over. Between arming and `arm` the card keeps chasing
-- `prev`, which is the whole of the wave — nothing is animated but the
-- moment each card is told.
--
-- The spring is UNDERDAMPED on purpose: the overshoot is the liquid in it.
-- `popSpring`/`popDamp` in tuning.luau; `popWave` is the beat per card.
-- ============================================================================

export type Pop = { pop: number, vpop: number, goal: number, prev: number, arm: number }

local M = {}

function M.new(): Pop
    return { pop = 0, vpop = 0, goal = 0, prev = 0, arm = 0 }
end

-- Tell a chain of pops where to go: card k hears it `wave` seconds after
-- card k-1. A card already heading there is left alone, so re-arming the
-- same run every frame does not restart the wave.
function M.arm(chain: { Pop }, goal: number, now: number, wave: number)
    for k, p in ipairs(chain) do
        if p.goal ~= goal then
            p.prev = M.target(p, now)
            p.goal = goal
            p.arm = now + (k - 1) * wave
        end
    end
end

-- Where this pop is heading right now.
function M.target(p: Pop, now: number): number
    return if now >= p.arm then p.goal else p.prev
end

-- One frame of the spring.
function M.step(p: Pop, now: number, dt: number, k: number, d: number)
    local a = k * (M.target(p, now) - p.pop) - d * p.vpop
    p.vpop += a * dt
    p.pop += p.vpop * dt
end

-- A press: the card dips on its way into the hand.
function M.kick(p: Pop, amount: number)
    p.vpop -= amount
end

return M
