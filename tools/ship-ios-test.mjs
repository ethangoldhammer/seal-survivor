// ============================================================================
// SHIP:PHONE TEST — the parts of the device install that can be wrong without
// an error, checked without a four-minute Xcode build.
//
// 1. DEVICE PICKING. devicectl lists every phone this Mac has ever paired, so
//    "the phone" is a choice, and getting it wrong installs onto a device in a
//    drawer and reports success. The two failure directions matter equally:
//    refusing a phone that IS reachable (an unfamiliar tunnelState string) is
//    as bad as picking one that isn't.
//
// 2. THE BUILD ARGUMENTS. A missing CURRENT_PROJECT_VERSION is not an error —
//    it just means every build on the phone claims to be build 1, and no way
//    to tell which one is installed. A simulator destination sneaking in
//    produces an .app that cannot be installed on hardware at all.
//
// 3. THE APP PATH. It is assembled from the configuration name, so Debug and
//    Release must not resolve to the same place — that is how a --debug run
//    silently installs the Release build from an hour ago.
//
// Run: npm run test:shipios
// ============================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  teamIdFrom, bundleIdFrom, buildNumber, buildArgs, appPath,
  pickDevice, shipTestflight, ShipIosError,
} from './ship-ios.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!cond) failed++;
};
const throws = (fn, match, msg) => {
  try { fn(); ok(false, `${msg} — did not throw`); }
  catch (err) {
    ok(err instanceof ShipIosError && err.message.includes(match), `${msg} — "${err.message}"`);
  }
};

const phone = (name, tunnelState, extra = {}) => ({
  identifier: extra.id ?? `id-${name}`,
  deviceProperties: { name },
  hardwareProperties: { platform: 'iOS', marketingName: 'iPhone 17 Pro', udid: extra.udid ?? `udid-${name}` },
  connectionProperties: { tunnelState, pairingState: 'paired' },
});

console.log('\nproject facts');
const pbxproj = await readFile(join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
ok(/^[A-Z0-9]{10}$/.test(teamIdFrom(pbxproj)), `team read out of the real project: ${teamIdFrom(pbxproj)}`);
ok(bundleIdFrom(pbxproj).includes('.'), `bundle id read out of the real project: ${bundleIdFrom(pbxproj)}`);
throws(() => teamIdFrom('nothing here'), 'no DEVELOPMENT_TEAM', 'an unsigned project is named, not guessed');
throws(() => bundleIdFrom('nothing here'), 'no PRODUCT_BUNDLE_IDENTIFIER', 'a project with no bundle id is named');

console.log('\nbuild number');
ok(buildNumber({ commitCount: 412 }) === '412', 'defaults to the commit count');
ok(buildNumber({ commitCount: 412, override: '900' }) === '900', '--build wins for a second run on one commit');
ok(buildNumber({ commitCount: 412, override: null }) === '412', 'a null override is not an override');
throws(() => buildNumber({ commitCount: 1, override: '1.2' }), 'not a positive integer', 'a non-integer --build is refused');

console.log('\nxcodebuild arguments');
const args = buildArgs({ config: 'Release', build: '412', version: null });
ok(args.includes('CURRENT_PROJECT_VERSION=412'), 'carries the build number, so the phone can be identified');
ok(!args.some((a) => a.startsWith('MARKETING_VERSION=')), 'no --version leaves the marketing version alone');
ok(buildArgs({ config: 'Release', build: '1', version: '1.1' }).includes('MARKETING_VERSION=1.1'), '--version sets it');
ok(args[args.indexOf('-destination') + 1] === 'generic/platform=iOS', 'builds for hardware, never a simulator');
ok(args.includes('-allowProvisioningUpdates'), 'lets xcodebuild renew the development profile');
ok(args.includes('-derivedDataPath'), 'pins derived data, so the .app is at a path this script can find');
ok(args[args.indexOf('-configuration') + 1] === 'Release', 'Release by default');
ok(buildArgs({ config: 'Debug', build: '1' })[args.indexOf('-configuration') + 1] === 'Debug', '--debug switches configuration');

console.log('\napp path');
ok(appPath('Release').endsWith('Release-iphoneos/App.app'), 'Release resolves to the device product');
ok(appPath('Debug') !== appPath('Release'), 'Debug and Release cannot alias, so --debug installs what it built');

console.log('\ndevice picking');
ok(pickDevice([phone('Ethan’s iPhone', 'connected')]).name.includes('iPhone'), 'one connected phone needs no flag');
ok(pickDevice([phone('mine', 'connected'), phone('drawer', 'disconnected')]).name === 'mine',
  'the connected one wins over the paired-but-away one');
ok(pickDevice([phone('mine', 'some-new-apple-state')]).name === 'mine',
  'an unrecognised tunnelState is treated as reachable, not refused');
// The first real run installed onto a phone reporting `disconnected` — the
// tunnel is raised on demand. A gate that believed that field refused a phone
// that worked, so one paired device is used whatever the field says.
ok(pickDevice([phone('drawer', 'disconnected')]).name === 'drawer',
  'the only paired phone is used even when it reports no connection');
ok(pickDevice([phone('drawer', 'disconnected')]).stale === true,
  '...and is flagged, so the run says the install is the real test');
ok(pickDevice([phone('mine', 'connected')]).stale !== true, 'a connected phone carries no such caveat');
throws(() => pickDevice([phone('a', 'disconnected'), phone('b', 'disconnected')]), 'none reports a connection',
  'several paired and none live is a question, not a guess');
throws(() => pickDevice([]), 'no iOS device is paired', 'no devices at all is its own message');
throws(() => pickDevice([phone('a', 'connected'), phone('b', 'connected')]), '2 phones are connected',
  'two live phones ask which, rather than guessing');
ok(pickDevice([phone('a', 'connected'), phone('b', 'connected')], 'b').name === 'b', '--device by name');
ok(pickDevice([phone('a', 'connected')], 'udid-a').name === 'a', '--device by udid');
ok(pickDevice([phone('drawer', 'disconnected')], 'drawer').name === 'drawer',
  'an explicit --device is obeyed even when it looks unreachable');
throws(() => pickDevice([phone('a', 'connected')], 'nope'), 'no paired device matches', 'a typo in --device is named');
throws(() => pickDevice([phone('iPhone one', 'connected'), phone('iPhone two', 'connected')], 'iPhone'),
  'matches 2 devices', 'an ambiguous --device asks for a udid');
ok(pickDevice([phone('mine', 'connected'), { identifier: 'watch', hardwareProperties: { platform: 'watchOS' }, deviceProperties: { name: 'Watch' }, connectionProperties: { tunnelState: 'connected' } }]).name === 'mine',
  'a paired Watch is not a candidate');

console.log('\nTestFlight is parked');
throws(shipTestflight, 'not wired up yet', 'the App Store path stops instead of half-working');

console.log(failed ? `\n${failed} FAILED\n` : '\nall good\n');
process.exit(failed ? 1 : 0);
