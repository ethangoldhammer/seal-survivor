// ============================================================================
// SHIP:IOS TEST — the parts of the iOS deploy that can be wrong without an
// error, checked without a ten-minute archive.
//
// 1. EXPORT OPTIONS. Two keys in that plist decide whether the upload does
//    what the terminal said it did: `destination` (upload vs a silent local
//    export that reaches nobody) and `manageAppVersionAndBuildNumber` (left
//    at its YES default, Xcode renumbers the build on the way out and the
//    number tied to the commit is not the number in TestFlight).
//
// 2. THE ARGUMENT LISTS. -allowProvisioningUpdates without the three
//    authentication flags fails only when a certificate happens to have
//    expired — months after the change that dropped it. Same for
//    CURRENT_PROJECT_VERSION: forget it and every upload is build 1, which
//    App Store Connect rejects as a duplicate.
//
// 3. THE KEY LOOKUP. A missing .p8 has to be a named failure with the paths
//    it searched, not an xcodebuild error 250 pages into a log.
//
// Run: npm run test:shipios
// ============================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  parseEnvFile, resolveAuthKey, teamIdFrom, exportOptionsPlist,
  buildNumber, archiveArgs, exportArgs, ShipIosError, KEY_DIRS,
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
    ok(err instanceof ShipIosError && err.message.includes(match),
      `${msg} — "${err.message}"`);
  }
};

const AUTH = { keyPath: '/keys/AuthKey_ABC1234567.p8', keyId: 'ABC1234567', issuerId: 'iss-uuid' };

console.log('\nexport options');
const upload = exportOptionsPlist({ teamId: '2YN6CC34J3', destination: 'upload' });
ok(/<key>destination<\/key>\s*<string>upload<\/string>/.test(upload), 'destination=upload reaches Apple');
ok(/<key>manageAppVersionAndBuildNumber<\/key>\s*<false\/>/.test(upload),
  'manageAppVersionAndBuildNumber is false, so Xcode keeps our build number');
ok(upload.includes('<string>app-store-connect</string>'), 'method is app-store-connect');
ok(upload.includes('<string>2YN6CC34J3</string>'), 'the team id is carried through');
ok(exportOptionsPlist({ teamId: 'X', destination: 'export' }).includes('<string>export</string>'),
  '--no-upload writes an .ipa locally instead');

console.log('\nteam id');
const pbxproj = await readFile(join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
ok(/^[A-Z0-9]{10}$/.test(teamIdFrom(pbxproj)), `read out of the real project: ${teamIdFrom(pbxproj)}`);
throws(() => teamIdFrom('nothing here'), 'no DEVELOPMENT_TEAM', 'an unsigned project is named, not guessed');

console.log('\nbuild number');
ok(buildNumber({ commitCount: 412 }) === '412', 'defaults to the commit count');
ok(buildNumber({ commitCount: 412, override: '900' }) === '900', '--build wins for a re-upload');
ok(buildNumber({ commitCount: 412, override: null }) === '412', 'a null override is not an override');
throws(() => buildNumber({ commitCount: 1, override: '1.2' }), 'not a positive integer', 'a non-integer --build is refused');

console.log('\nxcodebuild arguments');
const arch = archiveArgs({ build: '412', version: null, auth: AUTH });
ok(arch.includes('CURRENT_PROJECT_VERSION=412'), 'the archive carries the build number');
ok(!arch.some((a) => a.startsWith('MARKETING_VERSION=')), 'no --version leaves the marketing version alone');
ok(archiveArgs({ build: '412', version: '1.1', auth: AUTH }).includes('MARKETING_VERSION=1.1'),
  '--version sets the marketing version');
ok(arch.includes('-destination') && arch[arch.indexOf('-destination') + 1] === 'generic/platform=iOS',
  'archives for a device, not a simulator');

for (const [label, args] of [['archive', arch], ['export', exportArgs({ plistPath: '/tmp/e.plist', auth: AUTH })]]) {
  const authed = ['-authenticationKeyPath', '-authenticationKeyID', '-authenticationKeyIssuerID'].every((f) => args.includes(f));
  ok(args.includes('-allowProvisioningUpdates') && authed,
    `${label}: -allowProvisioningUpdates comes with all three key flags`);
}

console.log('\n.env parsing');
const env = parseEnvFile('# a comment\nASC_KEY_ID = ABC1234567 \nASC_ISSUER_ID="iss-uuid"\nnot a line\n');
ok(env.ASC_KEY_ID === 'ABC1234567', 'whitespace around the value is trimmed');
ok(env.ASC_ISSUER_ID === 'iss-uuid', 'quotes are stripped');
ok(!('# a comment' in env), 'comments are skipped');

console.log('\nkey lookup');
const found = resolveAuthKey({ ASC_KEY_ID: 'ABC1234567', ASC_ISSUER_ID: 'iss' }, '/home/x',
  (p) => p === '/home/x/.appstoreconnect/private_keys/AuthKey_ABC1234567.p8');
ok(found.keyPath.endsWith('AuthKey_ABC1234567.p8'), 'finds the key where App Store Connect keys live');
ok(KEY_DIRS('/home/x').length === 4, 'searches all four directories Apple\'s own tools use');
ok(resolveAuthKey({ ASC_KEY_ID: 'K', ASC_ISSUER_ID: 'i', ASC_KEY_PATH: '/custom/k.p8' }, '/home/x', () => true).keyPath === '/custom/k.p8',
  'ASC_KEY_PATH overrides the search');
throws(() => resolveAuthKey({}, '/home/x', () => true), 'no App Store Connect API key', 'missing identifiers are named');
throws(() => resolveAuthKey({ ASC_KEY_ID: 'K', ASC_ISSUER_ID: 'i' }, '/home/x', () => false), 'not found',
  'a missing .p8 is named, with the paths it looked in');

console.log(failed ? `\n${failed} FAILED\n` : '\nall good\n');
process.exit(failed ? 1 : 0);
