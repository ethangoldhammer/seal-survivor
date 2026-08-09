---
name: ship
description: Commit, push and deploy Seal Survivor to the live site in one step. Use whenever the request is to ship, deploy, publish, push live, release, or "put this on the site" — and when asked to check whether it is safe to deploy. Runs every test and the production build before committing, so a failing tree never becomes a public build.
---

# Shipping

`npm run ship -- "what changed"` is the only path to production. It runs the
five test suites and the production build FIRST and commits nothing unless all
six pass, then pushes `SealSurvivor-Main`, which triggers
`.github/workflows/deploy.yml` and lands on https://seal-survivor.pages.dev
about two minutes later.

The ordering is the point: the gate is in front of the commit, not after it,
so `git log` on the production branch stays a list of states that actually
worked.

## Running it

```bash
npm run ship -- "what changed"
```

| flag | what it does |
| --- | --- |
| `--dry` | run every gate, print what would land, commit nothing |
| `--yes` | skip the confirmation prompt |
| `--no-verify` | skip tests and build — records that fact in the commit message |
| `--branch <b>` | ship a different branch (no deploy; only `SealSurvivor-Main` publishes) |

Always offer `--dry` first when the user has not shipped in a while or the
diff is large. It costs ~13 seconds and catches the failure before it is
attached to a commit.

## Before shipping, do these

1. **Read the diff.** `git status --short` and `git diff --stat`. Uncommitted
   work is swept in wholesale by `git add -A` — say what will land, by area,
   and get agreement. This is the step that catches a half-finished system
   riding along with a finished one.
2. **Check for stale local paths.** `.claude/launch.json` accumulates
   `scratch-preview` entries pointing at session temp directories that will
   not exist for anyone else. Drop those hunks rather than committing them.
3. **Never commit `path/src/imported-tuning.json` without saying so.** It is
   real tuning work saved from the live tuner, and whatever is committed is
   what the public build ships with. Confirm the current values are the ones
   that should go out.

## When something fails

The script prints the failing suite's own output and exits before touching
git. Fix the cause; do not reach for `--no-verify` to get past a red test.
`--no-verify` exists for the case where the build is fine and a test harness
is broken, and it stamps the commit message so that decision stays visible.

## What NOT to do

- Do not run `npm run deploy` directly. It uploads a build from the local
  working tree, so it can publish uncommitted code — the deployed site and
  `git log` then disagree, with no way to tell what is live.
- Do not push `SealSurvivor-Main` by hand. That skips every gate.
- Do not start a dev server to "check it first". The dev server writes
  `path/src/imported-tuning.json`, which is shared live tuning work. Verify
  with the Node harnesses (`npm test`) instead.
