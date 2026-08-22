#!/usr/bin/env node
// ============================================================================
// SHIP:IOS — from source to a TestFlight build without opening Xcode.
//
//   npm run ship:ios                    # build, sync, archive, upload
//   npm run ship:all -- "what changed"  # the web deploy AND this, one button
//
// The web half of shipping (tools/ship.mjs) has been one command for a while;
// this is the other half. Everything Xcode does between "I have a dist/" and
// "there is a build in TestFlight" is here: the Capacitor sync, the archive,
// the signing, and the upload.
//
// AUTHENTICATION. Signing and uploading both need an App Store Connect API
// key — a .p8 downloadable exactly once from App Store Connect > Users and
// Access > Integrations. Put the file in ~/.appstoreconnect/private_keys/ and
// its two identifiers in .env (which is gitignored):
//
//   ASC_KEY_ID=XXXXXXXXXX
//   ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
//
// With that key and -allowProvisioningUpdates, xcodebuild creates and renews
// the distribution certificate and provisioning profile on its own, which is
// the only reason this can run unattended at all.
//
// BUILD NUMBERS. App Store Connect rejects an upload whose build number was
// already used, so CFBundleVersion cannot stay at the 1 in project.pbxproj.
// It is derived from `git rev-list --count HEAD` instead: monotonic (ship
// always commits before it gets here), and it maps a TestFlight build back to
// the exact commit that produced it. Re-uploading the SAME commit — a first
// attempt that failed at Apple's end — is the one case that collides, and
// --build <n> is the way out of it.
//
// Flags:
//   --dry          preflight and print the plan; archive nothing, upload nothing
//   --yes          skip the confirmation prompt
//   --skip-build   reuse the existing dist/ instead of rebuilding it
//   --no-upload    archive and export a signed .ipa to ios/App/output, but
//                  do not send it to Apple
//   --build <n>    override the build number
//   --version <v>  set the marketing version (CFBundleShortVersionString)
// ============================================================================

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'ios/App/App.xcodeproj');
const SCHEME = 'App';
const ARCHIVE = join(ROOT, 'ios/App/build/App.xcarchive');
const EXPORT_DIR = join(ROOT, 'ios/App/output');
const BUILD_DIR = join(ROOT, 'ios/App/build');
const LOG = join(BUILD_DIR, 'ship-ios.log');
const TESTFLIGHT_URL = 'https://appstoreconnect.apple.com/apps';

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const say = (s = '') => console.log(s);

// A failure here is worth more than a stack trace: every one of them has a
// specific fix, and the fix is what gets printed.
export class ShipIosError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

// --- pure helpers (tools/ship-ios-test.mjs covers these) --------------------

// Same shape as the loader in playtest-pull.mjs: .env is a convenience, the
// real environment always wins so CI can pass the values in without a file.
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    // The trailing \s* in a /(.*)\s*$/ never matches — the greedy .* has
    // already eaten the spaces — so the value is trimmed explicitly. A key id
    // with a stray space pasted onto the end authenticates as a different key
    // and Apple's answer to that is a 401 with no mention of whitespace.
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

// Apple's own tools look in these four directories, so a key already dropped
// where `xcrun altool` or fastlane would find it is found here too.
export const KEY_DIRS = (home) => [
  join(home, '.appstoreconnect/private_keys'),
  join(home, '.private_keys'),
  join(home, 'private_keys'),
  './private_keys',
];

export function resolveAuthKey(env, home, exists) {
  const keyId = env.ASC_KEY_ID?.trim();
  const issuerId = env.ASC_ISSUER_ID?.trim();
  if (!keyId || !issuerId) {
    throw new ShipIosError(
      'no App Store Connect API key configured',
      'Add ASC_KEY_ID and ASC_ISSUER_ID to .env — see the header of tools/ship-ios.mjs.');
  }
  const candidates = env.ASC_KEY_PATH
    ? [resolve(env.ASC_KEY_PATH)]
    : KEY_DIRS(home).map((d) => resolve(d, `AuthKey_${keyId}.p8`));
  const keyPath = candidates.find(exists);
  if (!keyPath) {
    throw new ShipIosError(
      `AuthKey_${keyId}.p8 not found`,
      `Looked in:\n    ${candidates.join('\n    ')}\n  App Store Connect lets you download a key ONCE. If this one is lost, revoke it and make another.`);
  }
  return { keyId, issuerId, keyPath };
}

export function teamIdFrom(pbxproj) {
  const m = /DEVELOPMENT_TEAM = ([A-Z0-9]+);/.exec(pbxproj);
  if (!m) throw new ShipIosError('no DEVELOPMENT_TEAM in project.pbxproj',
    'Open ios/App/App.xcodeproj once and pick a team under Signing & Capabilities.');
  return m[1];
}

// manageAppVersionAndBuildNumber MUST be false. Left at its YES default, Xcode
// renumbers the build on the way out and the number this script chose — the
// one printed to the terminal and tied to the commit — is not the number that
// reaches TestFlight.
export function exportOptionsPlist({ teamId, destination }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>${destination}</string>
	<key>teamID</key>
	<string>${teamId}</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>uploadSymbols</key>
	<true/>
	<key>stripSwiftSymbols</key>
	<true/>
</dict>
</plist>
`;
}

export function buildNumber({ commitCount, override }) {
  if (override != null && override !== '') {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 1) {
      throw new ShipIosError(`--build ${override} is not a positive integer`);
    }
    return String(n);
  }
  return String(commitCount);
}

export function archiveArgs({ build, version, auth }) {
  return [
    'archive',
    '-project', PROJECT,
    '-scheme', SCHEME,
    '-configuration', 'Release',
    '-destination', 'generic/platform=iOS',
    '-archivePath', ARCHIVE,
    '-allowProvisioningUpdates',
    '-authenticationKeyPath', auth.keyPath,
    '-authenticationKeyID', auth.keyId,
    '-authenticationKeyIssuerID', auth.issuerId,
    `CURRENT_PROJECT_VERSION=${build}`,
    ...(version ? [`MARKETING_VERSION=${version}`] : []),
  ];
}

// With destination=upload no .ipa is written anywhere — the export IS the
// upload. -exportPath is still required by xcodebuild, and receives the
// distribution logs.
export function exportArgs({ plistPath, auth }) {
  return [
    '-exportArchive',
    '-archivePath', ARCHIVE,
    '-exportOptionsPlist', plistPath,
    '-exportPath', EXPORT_DIR,
    '-allowProvisioningUpdates',
    '-authenticationKeyPath', auth.keyPath,
    '-authenticationKeyID', auth.keyId,
    '-authenticationKeyIssuerID', auth.issuerId,
  ];
}

// --- running ----------------------------------------------------------------

// xcodebuild prints thousands of lines and an archive is minutes of silence,
// so the output goes to a log and only the tail of a FAILING step is shown.
// The dots are there to prove the thing is alive.
async function step(label, cmd, args) {
  process.stdout.write(`  ${label.padEnd(28)}`);
  const started = Date.now();
  const log = createWriteStream(LOG, { flags: 'a' });
  log.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (buf) => { log.write(buf); tail = (tail + buf).slice(-20000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const tick = setInterval(() => process.stdout.write('.'), 15000);
  const code = await new Promise((res, rej) => {
    child.on('error', (err) => rej(new ShipIosError(`could not run ${cmd}: ${err.message}`)));
    child.on('close', res);
  });
  clearInterval(tick);
  log.end();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (code !== 0) {
    say(`${c.red}FAIL${c.off}`);
    say(`\n${c.dim}${'─'.repeat(70)}${c.off}`);
    say(tail.split('\n').slice(-40).join('\n'));
    say(`${c.dim}${'─'.repeat(70)}${c.off}`);
    throw new ShipIosError(`${label} failed (exit ${code})`, `Full output: ${LOG}`);
  }
  say(`${c.green}ok${c.off} ${c.dim}${secs}s${c.off}`);
}

const exists = (p) => { try { execFileSync('test', ['-e', p]); return true; } catch { return false; } };

async function loadEnv() {
  let fromFile = {};
  try { fromFile = parseEnvFile(await readFile(join(ROOT, '.env'), 'utf8')); } catch { /* shell had better have them */ }
  return { ...fromFile, ...process.env };
}

// --- the pipeline -----------------------------------------------------------

export async function shipIos(opts = {}) {
  const { dry = false, yes = false, skipBuild = false, upload = true, build: buildOverride = null, version = null } = opts;

  say(`${c.bold}ship:ios${c.off} ${c.dim}→ ${upload ? 'TestFlight' : 'ios/App/output'}${c.off}\n`);

  // Preflight. Each of these fails LATER as something unrecognisable — a
  // missing SDK reads as a scheme error, a Command Line Tools xcode-select as
  // "does not contain a scheme named App" — so they are checked up front.
  if (process.platform !== 'darwin') {
    throw new ShipIosError('an iOS build needs macOS');
  }
  try {
    const dev = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
    if (!dev.includes('Xcode.app')) {
      throw new ShipIosError(`xcode-select points at ${dev}, not a full Xcode`,
        'sudo xcode-select -s /Applications/Xcode.app');
    }
  } catch (err) {
    if (err instanceof ShipIosError) throw err;
    throw new ShipIosError('xcodebuild is not available', 'Install Xcode from the App Store.');
  }

  const env = await loadEnv();
  const auth = resolveAuthKey(env, homedir(), exists);
  const teamId = teamIdFrom(await readFile(join(PROJECT, 'project.pbxproj'), 'utf8'));

  const commitCount = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());
  const build = buildNumber({ commitCount, override: buildOverride });

  say(`  ${'team'.padEnd(16)}${c.dim}${teamId}${c.off}`);
  say(`  ${'key'.padEnd(16)}${c.dim}${auth.keyId}  ${auth.keyPath}${c.off}`);
  say(`  ${'build number'.padEnd(16)}${c.bold}${build}${c.off}${buildOverride ? c.dim + ' (--build)' : ''}${c.off}`);
  if (version) say(`  ${'version'.padEnd(16)}${c.bold}${version}${c.off}`);
  say();

  if (dry) {
    say(`${c.green}✓ dry run — preflight passed, nothing archived or uploaded.${c.off}`);
    return { build, dry: true };
  }

  if (upload && !yes) {
    say(`${c.bold}About to:${c.off}`);
    say(`  archive ${SCHEME} as build ${build}`);
    say(`  ${c.yellow}upload it to TestFlight — an uploaded build can be expired, never deleted${c.off}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('\nGo? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') throw new ShipIosError('cancelled — nothing was archived');
  }

  await mkdir(BUILD_DIR, { recursive: true });

  // A stale archive is worse than no archive: -exportArchive would happily
  // upload the previous run's binary under this run's build number.
  await rm(ARCHIVE, { recursive: true, force: true });
  await rm(EXPORT_DIR, { recursive: true, force: true });

  if (!skipBuild) await step('web build', 'npm', ['run', '--silent', 'build']);
  else {
    try { await access(join(ROOT, 'dist/index.html')); }
    catch { throw new ShipIosError('--skip-build, but dist/ has no index.html', 'Run npm run build first.'); }
    say(`  ${'web build'.padEnd(28)}${c.dim}reusing dist/${c.off}`);
  }

  await step('capacitor sync', 'npx', ['cap', 'sync', 'ios']);
  await step('archive', 'xcodebuild', archiveArgs({ build, version, auth }));

  const plistPath = join(BUILD_DIR, `ExportOptions-${upload ? 'upload' : 'export'}.plist`);
  await writeFile(plistPath, exportOptionsPlist({ teamId, destination: upload ? 'upload' : 'export' }));
  await step(upload ? 'sign + upload' : 'sign + export', 'xcodebuild', exportArgs({ plistPath, auth }));

  say();
  if (upload) {
    say(`${c.green}✓ build ${build} uploaded${c.off}`);
    say(`  ${c.dim}TestFlight processing takes 5–15 min: ${TESTFLIGHT_URL}${c.off}`);
  } else {
    say(`${c.green}✓ build ${build} exported${c.off} ${c.dim}${EXPORT_DIR}${c.off}`);
  }
  return { build, uploaded: upload };
}

// --- CLI --------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  try {
    await shipIos({
      dry: argv.includes('--dry'),
      yes: argv.includes('--yes'),
      skipBuild: argv.includes('--skip-build'),
      upload: !argv.includes('--no-upload'),
      build: valueOf('--build'),
      version: valueOf('--version'),
    });
  } catch (err) {
    if (!(err instanceof ShipIosError)) throw err;
    say(`\n${c.red}✗ ${err.message}${c.off}`);
    if (err.hint) say(`${c.dim}  ${err.hint}${c.off}`);
    process.exit(1);
  }
}
