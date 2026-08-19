# Global leaderboard

The board that the game posts to when you share a build. Without it, scores
stay in each player's `localStorage` and everyone sees only their own — which
is still the behaviour during `npm run dev`, deliberately, so there's no worker
to run while working on the game.

One Cloudflare Worker (`leaderboard-worker.js`) plus one KV namespace. It's
deployed independently of the game, so the game can move hosts without the
board moving with it, and the free tier covers it comfortably (100k reads and
1k writes per day — a write only happens when a run ends).

## Deploy

You need a Cloudflare account; everything below is free tier. Run from
`server/`.

**1. Log in.** Opens a browser to authorise.

```bash
npx wrangler login
```

**2. Create the KV namespace.**

```bash
npx wrangler kv namespace create LEADERBOARD
```

It prints an `id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

**3. Deploy.**

```bash
npx wrangler deploy
```

It prints a URL like `https://seal-survivor-leaderboard.you.workers.dev`.

**4. Point the game at it.** In the repo root, copy `.env.example` to `.env`
and set `VITE_LEADERBOARD_URL` to that URL (no trailing `/scores` — the client
appends the path).

```bash
cp .env.example .env
```

**5. Rebuild.** Vite inlines the URL at build time, so an already-built `dist/`
won't pick it up until you rebuild.

```bash
npm run build
```

Deploy `dist/` wherever you host it. Any origin can reach the worker, so the
same board serves every copy of the game.

## API

`GET /scores` → `{ list: [...] }` — the top 100, highest first.

`POST /scores` with `{ name, score, kills, level, time }` →
`{ list, rank, madeList }`.

Entries are `{ name, score, kills, level, time, date }`. The board keeps the
top 100 and returns all of them; `date` is set from the server's clock, not the
client's.

## What the checks do and don't do

Submissions are validated for range and internal consistency (a score that
implies no kills, or more kills than the elapsed time could produce, is
rejected) and rate-limited to 10 posts per minute per IP. Names are stripped of
markup characters and capped at 12 characters.

That keeps the board readable. It is **not** anti-cheat: the payload is written
by the browser, so anyone willing to open devtools can post a plausible-looking
score, and no client-side check can change that. Making it real would mean the
server simulating or verifying the run, which is a much larger piece of work
than this game warrants.

## Operating it

Live logs:

```bash
npx wrangler tail
```

Wipe the board (there's no admin endpoint — deliberately, since an endpoint
that can erase it is a bigger liability than an occasional CLI call):

```bash
npx wrangler kv key delete --binding=LEADERBOARD board:v1 --remote
```
