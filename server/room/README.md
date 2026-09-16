# Blubberball rooms

Two people, two machines, one five-letter code, one match.

This is a Cloudflare Worker plus one Durable Object per room code. It is **not**
a game server — it never simulates anything. A match is host-authoritative: one
player's browser runs the real sim, the other sends input and poses from the
snapshots it gets back. This carries the bytes between them and remembers which
two browsers are in the room.

`idFromName(code)` is the entire lookup. The code *is* the object's identity, so
there is no table to keep, no race between two joiners, and nothing to clean up
when a room is over.

Deployed independently of the game, the leaderboard and the playtest collection.

## Cost

Durable Objects are on the **Workers Free plan** — 100,000 requests/day and
13,000 GB-s/day — but **only with the SQLite storage backend**. That is what
`new_sqlite_classes` in `wrangler.toml` buys, and writing `new_classes` there
instead deploys perfectly happily onto a paid-plan-only path. Don't.

Incoming WebSocket messages bill at a 20:1 ratio, so a guest sending input at
30 Hz costs about 1.5 billed requests a second. A five-minute match is on the
order of 500 requests — roughly a hundred matches a day inside the free tier.

## Deploy

Run from `server/room/`.

**1. Log in** (skip if you already did this for the leaderboard).

```bash
npx wrangler login
```

**2. Deploy.** No namespace to create first — the Durable Object migration in
`wrangler.toml` is applied by the deploy itself.

```bash
npx wrangler deploy
```

It prints the worker URL. Put it in `.env.production` as `VITE_ROOM_URL` and
rebuild — Vite inlines it at build time, so a deployed build has to be rebuilt
after changing it.

Leave `VITE_ROOM_URL` unset and online play is simply hidden. That is what you
want for `npm run dev`; to develop against a local room server, run
`npx wrangler dev` here and put its URL in `.env.local`.

## Endpoints

| | |
|---|---|
| `POST /new` | returns `{ code }` for a code nobody is holding |
| `GET /room/<code>?role=host\|guest&name=&build=` | upgrades to a WebSocket |

Text frames are the control plane (JSON); binary frames are the two per-frame
message types (guest input up, host snapshot down) and are relayed without ever
being decoded. See `path/src/systems/online/protocol.js` for the layouts.

## What the tests cover, and what they cannot

`npm run test:room` covers everything in `room-relay.js`: the code alphabet
and normalisation, join validation, the two-member cap, the rejoin grace window,
and that the relay never echoes to the sender. It runs with a fake socket and
touches no network, because it is a ship gate and ship gates run with no TTY and
no network.

`room-worker.js` — the routing, the WebSocket upgrade, and the hibernation
handlers — **cannot be covered by any harness**, for the same reason
`server/playtest/playtest-worker.js` cannot. Verify it by hand.

### Checking the worker by hand

`live-check.mjs` beside this file is the rest of that checklist, automated. It
drives the real worker with two WebSocket clients and covers exactly what the
harness cannot: the routing, the upgrade, the hibernation handlers, and whether
a seat reservation really survives in Durable Object storage.

```bash
npx wrangler dev
```

...and in another shell:

```bash
node server/room/live-check.mjs
```

It is deliberately **not** a `test:*` script. It needs a server on a port, and
ship gates run with no TTY and no network — a gate that quietly depended on one
would pass on your machine and fail in the dark.

### What is left for a person

These need eyes and a real connection, and no script can answer them.

- [ ] A match plays from kickoff to a goal with both tabs agreeing — this is
      Phase 4's whole acceptance criterion, and it is a judgement.
- [ ] Throttled to 150 ms RTT in devtools, the guest is still playable.
- [ ] The host backgrounding its tab stalls the match (expected — rAF throttles)
      and the guest reports it rather than sitting frozen in silence.
- [ ] After a real deploy: read the request count and GB-s off the Cloudflare
      dashboard for a five-minute match and reconcile them with the free-tier
      numbers above, before building anything else on top of this.
