// ============================================================================
// THE ONE PUBLISH BUTTON.
//
// Every other publish script in this repo is terminal-only, and that rule is
// load-bearing: see the RISK note in hub-catalogue.mjs. A page you leave open
// in a background tab all day must not be one stray click from the live site.
//
// `ship:all` is the deliberate exception, and this file is the exception's
// terms. It is not exempt from the rule — it pays for the button:
//
//   IT CANNOT FIRE WITHOUT A MESSAGE.  A commit message is typed prose. A
//   click is not, and no amount of confirmation dialog turns one into the
//   other. The field being empty is what makes an accidental ship impossible
//   in the first place, before any of the rest of this matters.
//
//   IT CANNOT FIRE FROM A CLICK.  The button is held, not clicked — see
//   hub.html. A stray click is a click; nobody holds a mouse button for a
//   second and a quarter over a red control by accident.
//
//   IT CANNOT FIRE FROM ANOTHER TAB.  The endpoint wants a header a
//   cross-origin fetch cannot send without a preflight the hub refuses. Some
//   other page on localhost must not be able to deploy this game.
//
//   IT STILL RUNS EVERY GATE.  `--yes` skips the terminal's confirm prompt —
//   it has to, there is no stdin on a spawned run — and NOTHING else. Tests
//   and the production build run exactly as they do from a terminal, in front
//   of the commit, which is the part of ship.mjs that actually protects the
//   live site.
//
// THE MESSAGE GOES IN A FILE, NOT AN ARGUMENT. Text off a form is arbitrary:
// one starting with `--` becomes a flag, one with a newline in it loses
// everything after the first line, and one with a quote in it is a bug waiting
// for a shell. ship.mjs already reads `--file` for exactly this reason (a
// commit worth more than one line should not be escaped through a shell), so
// the safe path is the one that was already there.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Web, Mac and phone from one commit. The hub offers THIS one rather than
// bare `ship` because the three are cut from the same passing tree — shipping
// the site now and the phone later is how the two drift apart.
export const SHIP_SCRIPT = 'ship:all';

// Kept in step with ship.mjs by the test, not by hope.
export const PROD_BRANCH = 'SealSurvivor-Main';

// Not a limit anyone will reach by writing. It is here so a runaway paste
// cannot become a commit message, and so the field has a number to enforce.
export const MAX_MESSAGE = 4000;

// Returns a reason to refuse, or null. A dry run needs no message: it commits
// nothing, and ship.mjs itself only requires one when it is about to.
export function checkMessage(message, dry = false) {
  if (typeof message !== 'string') return 'a commit message is required';
  const text = message.trim();
  if (!text && !dry) return 'a commit message is required — say what changed';
  if (message.length > MAX_MESSAGE) return `that message is ${message.length} characters; the limit is ${MAX_MESSAGE}`;
  return null;
}

// The argv for `npm run`. Never a shell string, and the message never appears
// here at all — only the path of the file holding it.
export function shipArgs(file, dry = false) {
  return ['run', SHIP_SCRIPT, '--', ...(dry ? ['--dry'] : ['--yes']), '--file', file];
}

// Its own directory, so the cleanup is one rm of something we made and can
// never be a path that was already there.
export function writeMessage(message) {
  const dir = mkdtempSync(join(tmpdir(), 'seal-ship-'));
  const file = join(dir, 'message.txt');
  writeFileSync(file, String(message), 'utf8');
  return { file, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } } };
}

// ---------------------------------------------------------------------------
// WHAT WOULD LAND — the half of ship.mjs's preflight that the card can show
// before you commit to anything.
//
// A ship button with no idea whether the tree is dirty is a button that fails
// two minutes in with "nothing to ship". Both of ship.mjs's early exits are
// visible here instead: a clean tree, and a HEAD that is not the branch that
// deploys.
//
// Cached for a second, because /api/state is polled every two by every open
// tab and this is two `git` processes each time.
// ---------------------------------------------------------------------------
let memo = { at: 0, value: null };

export function shipState(root, now = Date.now()) {
  if (memo.value && now - memo.at < 1000) return memo.value;
  let value;
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const dirty = git('status', '--porcelain');
    value = {
      branch,
      // Only this branch publishes. Off it, ship.mjs either switches (same
      // commit) or refuses (diverged) — either way nothing deploys today.
      deploys: branch === PROD_BRANCH,
      prod: PROD_BRANCH,
      files: dirty ? dirty.split('\n').filter(Boolean).length : 0,
      error: '',
    };
  } catch (err) {
    value = { branch: '', deploys: false, prod: PROD_BRANCH, files: 0, error: err.message };
  }
  memo = { at: now, value };
  return value;
}
