-- ============================================================================
-- KLONDIKE — the rules, and nothing else.
--
-- No drawing, no pointer, no springs: a pure module so `rive . --test` can
-- prove the rules without a frame ever rendering (see tests.luau). table.luau
-- owns everything you can see.
--
-- Suits are the seal's world, not a French deck. Two are RED and two are
-- NAVY, which is all solitaire needs of a suit:
--   1 fish    red
--   2 star    red     (starfish)
--   3 bubble  navy
--   4 shell   navy
-- ============================================================================

local M = {}

export type Card = {
    id: number,      -- 1..52, stable for the whole game
    suit: number,    -- 1..4
    rank: number,    -- 1 (ace) .. 13 (king)
    faceUp: boolean,
}

export type Pile = {
    kind: string,    -- 'stock' | 'waste' | 'foundation' | 'tableau'
    index: number,   -- 1-based slot within its kind
    cards: { Card },
}

export type Game = {
    stock: Pile,
    waste: Pile,
    foundations: { Pile },
    tableau: { Pile },
    moves: number,
    score: number,
    seed: number,
    won: boolean,
}

M.RANK_TEXT = { 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K' }

function M.isRed(suit: number): boolean
    return suit <= 2
end

-- A small deterministic generator, so a seed reproduces a deal (and a test can
-- pin one). math.random is seeded per VM and would make deals unrepeatable.
local function lcg(seed: number): () -> number
    local state = seed % 2147483647
    if state <= 0 then
        state += 2147483646
    end
    return function(): number
        state = (state * 48271) % 2147483647
        return state / 2147483647
    end
end

local function pile(kind: string, index: number): Pile
    return { kind = kind, index = index, cards = {} }
end

function M.new(seed: number): Game
    local rnd = lcg(seed)
    local deck: { Card } = {}
    local id = 1
    for suit = 1, 4 do
        for rank = 1, 13 do
            deck[id] = { id = id, suit = suit, rank = rank, faceUp = false }
            id += 1
        end
    end
    -- Fisher-Yates.
    for i = 52, 2, -1 do
        local j = math.floor(rnd() * i) + 1
        deck[i], deck[j] = deck[j], deck[i]
    end

    local game: Game = {
        stock = pile('stock', 1),
        waste = pile('waste', 1),
        foundations = { pile('foundation', 1), pile('foundation', 2), pile('foundation', 3), pile('foundation', 4) },
        tableau = {},
        moves = 0,
        score = 0,
        seed = seed,
        won = false,
    }
    for col = 1, 7 do
        game.tableau[col] = pile('tableau', col)
    end

    local next = 1
    for col = 1, 7 do
        for row = 1, col do
            local card = deck[next]
            next += 1
            card.faceUp = row == col
            table.insert(game.tableau[col].cards, card)
        end
    end
    for k = next, 52 do
        deck[k].faceUp = false
        table.insert(game.stock.cards, deck[k])
    end
    return game
end

function M.top(p: Pile): Card?
    return p.cards[#p.cards]
end

-- Klondike: alternate colour, one rank lower; only a king onto an empty column.
function M.canStackOnTableau(moving: Card, dest: Pile): boolean
    local top = M.top(dest)
    if top == nil then
        return moving.rank == 13
    end
    if not top.faceUp then
        return false
    end
    return top.rank == moving.rank + 1 and M.isRed(top.suit) ~= M.isRed(moving.suit)
end

-- Foundations build up by suit from the ace. A foundation is not tied to a
-- suit until its ace lands.
function M.canStackOnFoundation(moving: Card, dest: Pile): boolean
    local top = M.top(dest)
    if top == nil then
        return moving.rank == 1
    end
    return top.suit == moving.suit and top.rank == moving.rank + 1
end

-- The run a pointer can pick up: from `index` to the end of a tableau column,
-- only if every card in it is face up. Waste and foundations give one card.
function M.runFrom(p: Pile, index: number): { Card }?
    if index < 1 or index > #p.cards then
        return nil
    end
    if p.kind == 'tableau' then
        for k = index, #p.cards do
            if not p.cards[k].faceUp then
                return nil
            end
        end
        local run: { Card } = {}
        for k = index, #p.cards do
            table.insert(run, p.cards[k])
        end
        return run
    end
    if p.kind == 'stock' then
        return nil
    end
    if index ~= #p.cards then
        return nil
    end
    return { p.cards[index] }
end

local function removeRun(p: Pile, count: number)
    for _ = 1, count do
        table.remove(p.cards)
    end
end

-- Flip a column's new top card. Returns true when a card was turned, which is
-- the moment the table wants to celebrate.
local function flipTop(p: Pile): boolean
    local top = M.top(p)
    if top ~= nil and not top.faceUp then
        top.faceUp = true
        return true
    end
    return false
end

export type MoveResult = { ok: boolean, flipped: boolean, toFoundation: boolean }

-- Move the run starting at `index` of `from` onto `to`, if legal.
function M.move(game: Game, from: Pile, index: number, to: Pile): MoveResult
    local result: MoveResult = { ok = false, flipped = false, toFoundation = false }
    if from == to then
        return result
    end
    local run = M.runFrom(from, index)
    if run == nil then
        return result
    end
    if to.kind == 'foundation' then
        if #run ~= 1 or not M.canStackOnFoundation(run[1], to) then
            return result
        end
        result.toFoundation = true
        game.score += 10
    elseif to.kind == 'tableau' then
        if not M.canStackOnTableau(run[1], to) then
            return result
        end
        if from.kind == 'waste' then
            game.score += 5
        elseif from.kind == 'foundation' then
            game.score -= 10
        end
    else
        return result
    end
    removeRun(from, #run)
    for _, c in ipairs(run) do
        table.insert(to.cards, c)
    end
    if from.kind == 'tableau' and flipTop(from) then
        result.flipped = true
        game.score += 5
    end
    game.moves += 1
    result.ok = true
    game.won = M.isWon(game)
    return result
end

-- Where a card would go if it went to a foundation on its own (a double click).
function M.foundationFor(game: Game, card: Card): Pile?
    for _, f in ipairs(game.foundations) do
        if M.canStackOnFoundation(card, f) then
            return f
        end
    end
    return nil
end

-- Draw one card from the stock to the waste; recycle the waste when the stock
-- is empty. Returns 'drew', 'recycled' or 'empty'.
function M.draw(game: Game): string
    if #game.stock.cards > 0 then
        local card = table.remove(game.stock.cards) :: Card
        card.faceUp = true
        table.insert(game.waste.cards, card)
        game.moves += 1
        return 'drew'
    end
    if #game.waste.cards == 0 then
        return 'empty'
    end
    while #game.waste.cards > 0 do
        local card = table.remove(game.waste.cards) :: Card
        card.faceUp = false
        table.insert(game.stock.cards, card)
    end
    game.moves += 1
    -- The classic penalty for going round again.
    game.score = math.max(0, game.score - 20)
    return 'recycled'
end

function M.isWon(game: Game): boolean
    for _, f in ipairs(game.foundations) do
        if #f.cards ~= 13 then
            return false
        end
    end
    return true
end

-- Every pile, in one list, for callers that iterate.
function M.piles(game: Game): { Pile }
    local out: { Pile } = { game.stock, game.waste }
    for _, f in ipairs(game.foundations) do
        table.insert(out, f)
    end
    for _, t in ipairs(game.tableau) do
        table.insert(out, t)
    end
    return out
end

return M
