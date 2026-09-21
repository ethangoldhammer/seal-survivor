#!/usr/bin/env node
// ============================================================================
// IS THE RIVE CLI SIGNED IN? Exit 0 if so, 1 with the fix if not.
//
// `rive push` builds the whole project (19MB, half a second) and THEN finds
// out its session is gone — the token refresh comes back HTTP 400 and the
// last line of a green-looking build is "refresh failed (HTTP 400)". From a
// terminal that is puzzling; from the workbench's push button, where the
// output is a drawer you read after the fact, it looks like a push that
// worked. So the push scripts run this first, and the first line of the
// output is the one that matters.
//
// `rive login` is interactive (it opens a browser), so this cannot fix it,
// only say so. `rive whoami` is the check the CLI itself offers.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const RIVE = process.env.RIVE_CLI || join(process.env.HOME ?? '', '.rive/bin/rive');

let who = '';
try { who = execFileSync(RIVE, ['whoami'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (err) { who = `${err.stdout ?? ''}${err.stderr ?? ''}`; }

if (/not logged in/i.test(who) || !who.trim()) {
  console.error('rive-auth: the Rive CLI is not signed in, so a push would build and then fail at "refresh".');
  console.error('           run this in a terminal (it opens a browser), then push again:');
  console.error('             ~/.rive/bin/rive login');
  process.exit(1);
}
console.log(`rive-auth: signed in — ${who.trim().split('\n')[0]}`);
