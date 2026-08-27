#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run steam:status
//
// CAN THIS MACHINE TALK TO STEAM RIGHT NOW — and if not, which of the several
// quite different reasons is it?
//
// Worth its own tool because "achievements aren't firing" has at least five
// causes that all present identically as nothing happening, and electron/steam.js
// deliberately swallows every one of them so that a run is never interrupted by
// a Steamworks problem. This is where they become visible again.
//
//   npm run steam:status                 with whatever is in the environment
//   SEAL_STEAM_APP_ID=480 npm run steam:status   against Valve's public test app
//
// 480 is Spacewar. It is the standard way to exercise Steamworks before a real
// app id exists, and it needs the Steam client running and logged in.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

console.log('\nSTEAM STATUS\n');

const id = process.env.SEAL_STEAM_APP_ID;
console.log(`  app id      ${id || '(unset — Steamworks stays switched off)'}`);

const installed = existsSync(join(ROOT, 'node_modules/steamworks.js'));
console.log(`  module      ${installed ? 'steamworks.js installed' : 'steamworks.js NOT installed'}`);

if (!installed) {
  console.log('\n  Nothing else can be checked without it. `npm i` should bring it in.\n');
  process.exit(1);
}

// The native binary is per platform+arch. A missing one throws at import rather
// than at call, which is exactly the failure electron/steam.js turns into a
// silent "unavailable" — so it is named here instead.
let api = null;
try {
  const mod = await import('steamworks.js');
  api = mod.default ?? mod;
  console.log('  binary      loaded for this platform');
} catch (err) {
  console.log(`  binary      FAILED — ${err?.message ?? err}`);
  console.log('\n  The prebuilt native module does not match this platform or arch.\n');
  process.exit(1);
}

if (!id) {
  console.log('\n  Set SEAL_STEAM_APP_ID to try an actual connection.');
  console.log('  SEAL_STEAM_APP_ID=480 npm run steam:status\n');
  process.exit(0);
}

// init() throws when the client is not running, rather than returning false.
try {
  const client = api.init(Number.parseInt(id, 10));
  console.log(`  client      connected as ${client.localplayer.getName()}`);
  console.log(`  steam id    ${client.localplayer.getSteamId().steamId64}`);
  console.log('\n  Steamworks is live. Achievements would fire.\n');
} catch (err) {
  console.log(`  client      NOT connected — ${err?.message ?? err}`);
  console.log('\n  Usually this just means the Steam client is not running or not');
  console.log('  logged in. The game treats it as normal and plays on.\n');
  process.exit(1);
}
