#!/usr/bin/env node
// ============================================================================
// SHIP:PHONE — the current build, on the iPhone in your pocket, in one step.
//
//   npm run ship:phone                   # build, sync, sign, install, launch
//   npm run ship:all -- "what changed"   # ↑ plus the web deploy, one button
//
// This is the local half of shipping: no App Store, no TestFlight, no review —
// it signs with the Apple Development identity already in the keychain and
// hands the .app straight to a paired device with devicectl.
//
// WHY THE BUILD IS GENERIC AND ONLY THE INSTALL NAMES THE PHONE. xcodebuild
// can target `platform=iOS,id=<udid>` directly, but then a sleeping or
// unplugged phone fails the whole run after the four minutes of compiling.
// Building for `generic/platform=iOS` and installing afterwards means the
// slow part never depends on the cable, and a failed install is a five-second
// retry rather than another full build.
//
// SIGNING. Automatic signing plus the Apple Development certificate is all
// this path needs — no App Store Connect API key. What it does need is the
// phone registered on the developer account, which happens the first time
// Xcode installs to it. If install fails saying the device is not in the
// profile, run `npm run ios` and hit play once; after that this works.
//
// Flags:
//   --dry           preflight and print the plan; build nothing, install nothing
//   --skip-build    reuse the existing dist/ instead of rebuilding it
//   --device <d>    name or udid, when more than one phone is paired
//   --no-launch     install, but do not start the app
//   --debug         Debug configuration (Safari's Web Inspector can attach)
//   --build <n>     override the build number
//   --version <v>   set the marketing version (CFBundleShortVersionString)
//   --testflight    parked — see TESTFLIGHT below
//
// TESTFLIGHT — PARKED, DELIBERATELY. Uploading to App Store Connect needs a
// .p8 API key (Users and Access > Integrations), an ExportOptions.plist with
// method=app-store-connect, destination=upload and
// manageAppVersionAndBuildNumber=false (left at its YES default Xcode
// renumbers the build on the way out), then `xcodebuild archive` and
// `-exportArchive`, both carrying -allowProvisioningUpdates with
// -authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID. It
// is written down here rather than built and left untested until the day
// there is a key to test it with — --testflight says so and stops.
// ============================================================================

import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, access, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'ios/App/App.xcodeproj');
const SCHEME = 'App';
// A fixed derived-data path so the .app is always at a path this script can
// name. Xcode's default lands it in a hashed directory under ~/Library that
// only Xcode knows how to find.
const DERIVED = join(ROOT, 'ios/DerivedData/ship');
const LOG = join(ROOT, 'ios/DerivedData/ship-phone.log');

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const say = (s = '') => console.log(s);

// A failure here is worth more than a stack trace: every one of them has a
// specific fix, and the fix is what gets printed.
export class ShipIosError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

// --- pure helpers (tools/ship-ios-test.mjs covers these) --------------------

export function teamIdFrom(pbxproj) {
  const m = /DEVELOPMENT_TEAM = ([A-Z0-9]+);/.exec(pbxproj);
  if (!m) throw new ShipIosError('no DEVELOPMENT_TEAM in project.pbxproj',
    'Open ios/App/App.xcodeproj once and pick a team under Signing & Capabilities.');
  return m[1];
}

export function bundleIdFrom(pbxproj) {
  const m = /PRODUCT_BUNDLE_IDENTIFIER = ([\w.-]+);/.exec(pbxproj);
  if (!m) throw new ShipIosError('no PRODUCT_BUNDLE_IDENTIFIER in project.pbxproj');
  return m[1];
}

// The build number is not required to install — the phone will take the same
// number twice — but it is what `Settings > Seal Survivor` shows, and derived
// from the commit count it answers "which build is actually on this thing"
// without guessing. --build is there for a rebuild inside one commit.
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

export function buildArgs({ config, build, version }) {
  return [
    'build',
    '-project', PROJECT,
    '-scheme', SCHEME,
    '-configuration', config,
    '-destination', 'generic/platform=iOS',
    '-derivedDataPath', DERIVED,
    '-allowProvisioningUpdates',
    `CURRENT_PROJECT_VERSION=${build}`,
    ...(version ? [`MARKETING_VERSION=${version}`] : []),
  ];
}

export const appPath = (config) => join(DERIVED, `Build/Products/${config}-iphoneos/App.app`);

// devicectl lists every device this Mac has ever paired, most of them asleep
// in a drawer. `connected` is the one fact that decides whether an install can
// work right now, so a disconnected phone is reported as such rather than
// handed to devicectl to fail obscurely after the whole build.
//
// It fails OPEN, and it has to: the first real run of this script installed
// onto a phone devicectl had just described as `tunnelState: disconnected`.
// That field reports the state of a tunnel that is established ON DEMAND, so
// for a phone reachable over the network it reads "disconnected" right up to
// the moment something connects to it. Treated as authority it refuses a
// device that works. So it is used only to RANK candidates when there is more
// than one, never to refuse the only one there is — the install itself is the
// honest test of whether a phone can be reached.

export function pickDevice(devices, wanted) {
  const phones = devices
    .filter((d) => d.hardwareProperties?.platform === 'iOS')
    .map((d) => ({
      id: d.identifier,
      udid: d.hardwareProperties?.udid,
      name: d.deviceProperties?.name ?? '(unnamed)',
      model: d.hardwareProperties?.marketingName ?? '',
      connected: d.connectionProperties?.tunnelState === 'connected',
    }));

  if (!phones.length) {
    throw new ShipIosError('no iOS device is paired with this Mac',
      'Plug the phone in, unlock it, and tap Trust.');
  }
  // An explicit --device is obeyed even if it looks unreachable: the person
  // typing a device name knows which phone they mean better than a cached
  // tunnel state does.
  if (wanted) {
    const w = wanted.toLowerCase();
    const hit = phones.filter((p) => p.name.toLowerCase().includes(w)
      || p.id.toLowerCase() === w || p.udid?.toLowerCase() === w);
    if (!hit.length) {
      throw new ShipIosError(`no paired device matches "${wanted}"`,
        `Paired: ${phones.map((p) => p.name).join(', ')}`);
    }
    if (hit.length > 1) {
      throw new ShipIosError(`"${wanted}" matches ${hit.length} devices`,
        `Matched: ${hit.map((p) => p.name).join(', ')} — pass a udid instead.`);
    }
    return hit[0];
  }
  const live = phones.filter((p) => p.connected);
  if (live.length === 1) return live[0];
  if (live.length > 1) {
    throw new ShipIosError(`${live.length} phones are connected`,
      `Pick one with --device: ${live.map((p) => p.name).join(', ')}`);
  }
  // Nothing claims to be connected — which, per the note above, means very
  // little. One paired phone is still the phone; several is a real question.
  if (phones.length === 1) return { ...phones[0], stale: true };
  throw new ShipIosError(`${phones.length} phones are paired and none reports a connection`,
    `Pick one with --device: ${phones.map((p) => p.name).join(', ')}`);
}

// --- running ----------------------------------------------------------------

// xcodebuild prints thousands of lines and a clean build is minutes of
// silence, so the output goes to a log and only the tail of a FAILING step is
// shown. The dots are there to prove the thing is alive.
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

function listDevices() {
  // devicectl writes its real answer to a file; stdout is a human table.
  const out = join(ROOT, 'ios/DerivedData/devices.json');
  execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], { stdio: 'ignore' });
  return execFileSync('cat', [out], { encoding: 'utf8' });
}

// --- the pipeline -----------------------------------------------------------

export async function shipPhone(opts = {}) {
  const {
    dry = false, skipBuild = false, launch = true, device: wantedDevice = null,
    debug = false, build: buildOverride = null, version = null,
  } = opts;
  const config = debug ? 'Debug' : 'Release';

  say(`${c.bold}ship:phone${c.off} ${c.dim}→ ${config} build to a paired device${c.off}\n`);

  // Preflight. Each of these fails LATER as something unrecognisable — a
  // Command Line Tools xcode-select reads as "does not contain a scheme named
  // App" — so they are checked up front.
  if (process.platform !== 'darwin') throw new ShipIosError('an iOS build needs macOS');
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

  // No signing identity means every build fails at the last step, after all
  // the compiling. It costs 200ms to know that first.
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!/Apple Develop(ment|er)/.test(identities)) {
    throw new ShipIosError('no Apple Development signing identity in the keychain',
      'Xcode > Settings > Accounts, add your Apple ID, then Manage Certificates > +.');
  }

  const pbxproj = await readFile(join(PROJECT, 'project.pbxproj'), 'utf8');
  const teamId = teamIdFrom(pbxproj);
  const bundleId = bundleIdFrom(pbxproj);
  const commitCount = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());
  const build = buildNumber({ commitCount, override: buildOverride });

  await mkdir(dirname(LOG), { recursive: true });
  const phone = pickDevice(JSON.parse(listDevices()).result.devices, wantedDevice);

  say(`  ${'device'.padEnd(16)}${c.bold}${phone.name}${c.off} ${c.dim}${phone.model} · ${phone.id}${c.off}`);
  if (phone.stale) say(`  ${''.padEnd(16)}${c.dim}(no live connection reported — the install will tell us)${c.off}`);
  say(`  ${'app'.padEnd(16)}${c.dim}${bundleId} · team ${teamId}${c.off}`);
  say(`  ${'build number'.padEnd(16)}${c.bold}${build}${c.off}${buildOverride ? `${c.dim} (--build)${c.off}` : ''}`);
  if (version) say(`  ${'version'.padEnd(16)}${c.bold}${version}${c.off}`);
  say();

  if (dry) {
    say(`${c.green}✓ dry run — preflight passed, nothing built or installed.${c.off}`);
    return { build, device: phone, dry: true };
  }

  // A stale .app is worse than none: the install would put the PREVIOUS build
  // on the phone and every log line here would still say it worked.
  await rm(appPath(config), { recursive: true, force: true });

  if (!skipBuild) await step('web build', 'npm', ['run', '--silent', 'build']);
  else {
    try { await access(join(ROOT, 'dist/index.html')); }
    catch { throw new ShipIosError('--skip-build, but dist/ has no index.html', 'Run npm run build first.'); }
    say(`  ${'web build'.padEnd(28)}${c.dim}reusing dist/${c.off}`);
  }

  await step('capacitor sync', 'npx', ['cap', 'sync', 'ios']);
  await step(`xcode build (${config})`, 'xcodebuild', buildArgs({ config, build, version }));

  try { await access(appPath(config)); }
  catch { throw new ShipIosError(`the build produced no app at ${appPath(config)}`, `Full output: ${LOG}`); }

  try {
    await step('install', 'xcrun', ['devicectl', 'device', 'install', 'app', '--device', phone.id, appPath(config)]);
  } catch (err) {
    throw new ShipIosError(`could not install on ${phone.name}`,
      `Unlock the phone, and plug it in if it is not on this network. If it says the device is not in the provisioning profile, run \`npm run ios\` and press play once — that registers it.\n  Full output: ${LOG}`);
  }
  if (launch) {
    await step('launch', 'xcrun', ['devicectl', 'device', 'process', 'launch',
      '--device', phone.id, '--terminate-existing', bundleId]);
  }

  say();
  say(`${c.green}✓ build ${build} is on ${phone.name}${c.off}`);
  if (!launch) say(`  ${c.dim}--no-launch: open it from the home screen${c.off}`);
  return { build, device: phone };
}

// Parked on purpose — see TESTFLIGHT in the header. A stub that stops is
// better than a half-written upload path that looks finished.
export function shipTestflight() {
  throw new ShipIosError('TestFlight uploads are not wired up yet',
    'The recipe is in the header of tools/ship-ios.mjs. It needs an App Store Connect API key first.');
}

// --- CLI --------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  try {
    if (argv.includes('--testflight')) shipTestflight();
    await shipPhone({
      dry: argv.includes('--dry'),
      skipBuild: argv.includes('--skip-build'),
      launch: !argv.includes('--no-launch'),
      debug: argv.includes('--debug'),
      device: valueOf('--device'),
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
