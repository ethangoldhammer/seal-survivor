// ============================================================================
// SHIP — one command from a dirty working tree to the live site.
//
//   npm run ship -- "what changed"
//
// It runs every test and the production build FIRST, and only commits if all
// of them pass. That ordering is the whole point: a failing tree never becomes
// a commit, so `git log` on SealSurvivor-Main stays a list of states that
// actually worked. Pushing that branch is what triggers the deploy — see
// .github/workflows/deploy.yml — so a bad commit here is a bad public build,
// and the gate has to be in front of the commit rather than after it.
//
// Flags:
//   --dry          run every check and print the plan, commit nothing
//   --yes          skip the confirmation prompt
//   --no-verify    skip tests and build. Loud, and it tells you in the commit
//                  message, because an unverified public deploy should leave
//                  evidence rather than look like every other commit.
//   --branch <b>   ship a branch other than SealSurvivor-Main (no deploy)
//   --file <path>  read the commit message from a file instead of the args
//   --mac          after the push, package the Mac app. See tools/ship-mac.mjs.
//   --phone        after the push, install the SAME build on the paired iPhone.
//
// `npm run ship:all` is both of those: web, Mac and phone from one command, all
// three cut from the commit that just passed every gate.
//
// THE ORDER OF THE THREE IS THE POINT. The push is what deploys the site, so it
// goes first and finishes in two minutes whatever else happens. The Mac build
// is next at about one minute. The phone is LAST because it takes five and
// needs hardware that might be asleep — a napping iPhone must never be the
// reason the site is still on yesterday's build.
//
// EACH IS ALLOWED TO FAIL ON ITS OWN. A Mac build that dies does not stop the
// phone install, and neither can un-deploy the site: by the time either runs,
// the commit is pushed and the deploy is already in flight. What you get back
// is a list of which halves landed, and the single command to retry the one
// that did not.
// ============================================================================

import { execFileSync, execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const PROD_BRANCH = 'SealSurvivor-Main';
const LIVE_URL = 'https://seal-survivor.pages.dev';
const ACTIONS_URL = 'https://github.com/ethangoldhammer/seal-survivor/actions';

// Every gate, in the order they run. Tests before build: they're faster and
// their failures are more specific, so the useful error arrives sooner.
//
// The test list is READ FROM package.json rather than written out here, so a
// new `test:something` script is gating the deploy the moment it exists. A
// hand-maintained copy of this list is a list that will one day be missing the
// suite that would have caught the thing — and keeping the two in sync is
// exactly the chore nobody remembers to do.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const GATES = [
  ...Object.keys(pkg.scripts)
    .filter((name) => name.startsWith('test:'))
    .sort()
    .map((name) => [`tests — ${name.slice(5)}`, `npm run --silent ${name}`]),
  ['production build', 'npm run --silent build'],
];

const argv = process.argv.slice(2);
// Flags that consume the argument after them, so that argument is never
// mistaken for part of the commit message.
const TAKES_VALUE = new Set(['--branch', '--file']);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const DRY = has('--dry');
const YES = has('--yes');
const SKIP = has('--no-verify');
const BRANCH = valueOf('--branch') ?? PROD_BRANCH;
const FILE = valueOf('--file');
const PHONE = has('--phone');
const MAC = has('--mac');

// The message is every bare argument joined — so quoting is optional and
// `npm run ship -- fixed the crab` does what it looks like it does. `--file`
// wins when given: a commit worth more than one line should be written in an
// editor, not escaped through a shell.
const message = FILE
  ? readFileSync(FILE, 'utf8').trim()
  : argv.filter((a, i) => !a.startsWith('--') && !TAKES_VALUE.has(argv[i - 1])).join(' ').trim();

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const say = (s = '') => console.log(s);
const die = (msg, hint) => {
  say(`\n${c.red}✗ ${msg}${c.off}`);
  if (hint) say(`${c.dim}  ${hint}${c.off}`);
  process.exit(1);
};

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// --- preflight --------------------------------------------------------------
say(`${c.bold}ship${c.off} ${c.dim}→ ${BRANCH}${c.off}\n`);

try { git('rev-parse', '--git-dir'); } catch { die('not a git repository'); }

const head = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain');

if (!dirty && !has('--allow-empty')) {
  die('nothing to ship — the working tree is clean',
    `If you want to re-deploy the current commit, use the Actions tab: ${ACTIONS_URL}`);
}
if (!message && !DRY) {
  die('a commit message is required',
    'npm run ship -- "what changed"');
}

// The topic-branch case. Committing onto a branch and then expecting the
// deploy to see it is the easy mistake here, so it's caught before any work.
if (head !== BRANCH) {
  const onBranch = git('rev-parse', head);
  const onProd = git('rev-parse', BRANCH);
  if (onBranch !== onProd) {
    die(`HEAD is on "${head}", which has diverged from ${BRANCH}`,
      `Merge or rebase first — this script will not guess which you meant.`);
  }
  // Same commit, different name: switching is a no-op for the working tree,
  // so the uncommitted work comes along untouched.
  say(`${c.dim}HEAD is on "${head}" at the same commit as ${BRANCH} — switching.${c.off}`);
  if (!DRY) git('checkout', BRANCH);
}

// --- what would land --------------------------------------------------------
const files = dirty.split('\n').filter(Boolean);
say(`${c.bold}${files.length} file(s) would be committed${c.off}`);
for (const f of files.slice(0, 40)) say(`  ${c.dim}${f}${c.off}`);
if (files.length > 40) say(`  ${c.dim}… and ${files.length - 40} more${c.off}`);
say();

// --- gates ------------------------------------------------------------------
if (SKIP) {
  say(`${c.yellow}⚠ --no-verify: skipping every test and the build.${c.off}`);
} else {
  for (const [label, cmd] of GATES) {
    process.stdout.write(`  ${label.padEnd(28)}`);
    const started = Date.now();
    try {
      execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
      say(`${c.green}pass${c.off} ${c.dim}${((Date.now() - started) / 1000).toFixed(1)}s${c.off}`);
    } catch (err) {
      say(`${c.red}FAIL${c.off}`);
      say(`\n${c.dim}${'─'.repeat(70)}${c.off}`);
      say(String(err.stdout ?? '') + String(err.stderr ?? ''));
      die(`${label} failed — nothing was committed`,
        `Fix it and run ship again, or use --no-verify if you know what you're doing.`);
    }
  }
}
say();

if (DRY) {
  if (MAC) {
    say();
    const { shipMac, ShipMacError } = await import('./ship-mac.mjs');
    try { await shipMac({ dry: true }); }
    catch (err) {
      if (!(err instanceof ShipMacError)) throw err;
      die(err.message, err.hint);
    }
  }
  if (PHONE) {
    say();
    const { shipPhone, ShipIosError } = await import('./ship-ios.mjs');
    try { await shipPhone({ dry: true }); }
    catch (err) {
      if (!(err instanceof ShipIosError)) throw err;
      die(err.message, err.hint);
    }
  }
  say(`${c.green}✓ dry run — everything passed, nothing committed.${c.off}`);
  process.exit(0);
}

// --- confirm ----------------------------------------------------------------
const deploys = BRANCH === PROD_BRANCH;
if (!YES) {
  say(`${c.bold}About to:${c.off}`);
  say(`  commit ${files.length} file(s) to ${BRANCH}`);
  say(`  push to origin/${BRANCH}`);
  say(deploys
    ? `  ${c.yellow}which auto-deploys to ${LIVE_URL}${c.off}`
    : `  ${c.dim}(no deploy — only ${PROD_BRANCH} publishes)${c.off}`);
  if (MAC) say(`  ${c.dim}then package the Mac app from that build${c.off}`);
  if (PHONE) say(`  ${c.dim}then install that build on the paired iPhone${c.off}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nGo? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') die('cancelled — nothing was committed');
}

// --- commit, push -----------------------------------------------------------
const body = SKIP
  ? `${message}\n\nShipped with --no-verify: tests and build were NOT run.\n`
  : `${message}\n`;

git('add', '-A');
execFileSync('git', ['commit', '-m', body], { stdio: 'inherit' });
const sha = git('rev-parse', '--short', 'HEAD');
say(`\n${c.green}✓ committed ${sha}${c.off}`);

try {
  execFileSync('git', ['push', 'origin', BRANCH], { stdio: 'inherit' });
} catch {
  die('push failed — the commit is safe locally, nothing deployed',
    `Fix the remote and run: git push origin ${BRANCH}`);
}

say(`\n${c.green}✓ pushed${c.off}`);
if (deploys) {
  say(`  deploy running  ${c.dim}${ACTIONS_URL}${c.off}`);
  say(`  live in ~2 min  ${c.dim}${LIVE_URL}${c.off}`);
}

// --- the other two platforms ------------------------------------------------
//
// Both run AFTER the push, so neither can delay or undo the deploy, and both
// are collected rather than thrown: a failed Mac build must not skip the phone
// install, because the two have nothing to do with each other and finding out
// about only the first one would mean running the whole command again to
// discover the second.
const failed = [];

// The Mac app builds its OWN bundle — dist-desktop, not the dist/ the gates
// produced. See the note in ship-mac.mjs: the two differ on purpose, so there is
// nothing here to reuse and --no-verify changes nothing about this half.
if (MAC) {
  say();
  const { shipMac, ShipMacError } = await import('./ship-mac.mjs');
  try {
    await shipMac();
  } catch (err) {
    if (!(err instanceof ShipMacError)) throw err;
    say(`\n${c.red}✗ mac: ${err.message}${c.off}`);
    if (err.hint) say(`${c.dim}  ${err.hint}${c.off}`);
    failed.push(['mac', 'npm run ship:mac']);
  }
}

// The phone build reuses the dist/ the gates just produced, so the app and the
// site are the same bytes rather than two builds that happen to be adjacent.
// --no-verify skips that build, and then there is nothing to reuse.
if (PHONE) {
  say();
  const { shipPhone, ShipIosError } = await import('./ship-ios.mjs');
  try {
    await shipPhone({ skipBuild: !SKIP });
  } catch (err) {
    if (!(err instanceof ShipIosError)) throw err;
    say(`\n${c.red}✗ phone: ${err.message}${c.off}`);
    if (err.hint) say(`${c.dim}  ${err.hint}${c.off}`);
    failed.push(['phone', 'npm run ship:phone']);
  }
}

if (failed.length) {
  say(`\n${c.dim}The web deploy is unaffected — it was pushed before any of this ran.${c.off}`);
  for (const [what, retry] of failed) {
    say(`${c.dim}  Retry ${what} on its own with: ${retry}${c.off}`);
  }
  process.exit(1);
}
