#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:hub
//
// The workbench is only worth opening if it lists EVERY tool. A hub that shows
// a hundred and thirty of a hundred and forty scripts is worse than no hub at
// all: the ten it drops look like they do not exist, and nobody goes looking
// for a tool a tool index says is not there.
//
// So the checks here are all about coverage and about the one thing coverage
// cannot fix:
//
//   COVERAGE   every script has a drawer and a description, every page it
//              links to is a file that exists, and every script it names is a
//              script that exists. Adding a tool without describing it fails
//              here rather than showing up as a blank row six weeks later.
//
//   THE GATE   nothing that deploys, publishes or rewrites history may be
//              runnable from a web page. That is a property of the CATALOGUE,
//              not of the button — the button is generated from the risk
//              class, so this is where it has to be checked. A new
//              `deploy:staging` added to package.json and forgotten fails this
//              test on the wrangler in its command line, which is the whole
//              point: the classification cannot be silently outgrown.
//
// The live half boots a real hub on a scratch port and asks it to run things
// it should refuse. A gate that is only asserted against the table, and never
// against the endpoint that reads the table, is a comment.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { commands, pages, GROUP_ORDER, ROOT, blurbFromFile, targetFile } from './hub-catalogue.mjs';
import { MAX_MESSAGE, PROD_BRANCH, SHIP_SCRIPT, checkMessage, shipArgs } from './hub-ship.mjs';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok    ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
};

const CMDS = commands();
const PAGES = pages();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

console.log('\nCOVERAGE — every script is in a drawer, described, and points at a real file');

check('every package.json script is in the catalogue',
  CMDS.length === Object.keys(pkg.scripts).length,
  `${CMDS.length} catalogued vs ${Object.keys(pkg.scripts).length} in package.json`);

const ungrouped = CMDS.filter((c) => !c.group);
check('every script has a group',
  !ungrouped.length,
  `add these to GROUP_BY_NAME in hub-catalogue.mjs: ${ungrouped.map((c) => c.name).join(', ')}`);

const badGroup = CMDS.filter((c) => c.group && !GROUP_ORDER.includes(c.group));
check('every group is in GROUP_ORDER',
  !badGroup.length,
  badGroup.map((c) => `${c.name} -> ${c.group}`).join(', '));

const blank = CMDS.filter((c) => !c.blurb);
check('every script has a description',
  !blank.length,
  `no header comment in the file these run — add one, or a BLURBS entry: ${blank.map((c) => c.name).join(', ')}`);

const shouty = CMDS.filter((c) => c.blurb.length > 300);
check('no description is a runaway paragraph',
  !shouty.length,
  shouty.map((c) => `${c.name} (${c.blurb.length} chars)`).join(', '));

const missingFile = CMDS.filter((c) => c.file && !existsSync(join(ROOT, c.file)));
check('every resolved tool file exists',
  !missingFile.length,
  missingFile.map((c) => `${c.name} -> ${c.file}`).join(', '));

// A script whose command mentions a tools/ file we failed to resolve is a hole
// in targetFile(), and it presents as a missing description rather than an
// error — so it is worth naming directly.
const unresolved = CMDS.filter((c) => !c.file && /tools\//.test(c.command) && !/&&/.test(c.command));
check('every single-command script resolves to its file',
  !unresolved.length,
  unresolved.map((c) => c.name).join(', '));

console.log('\nTHE GATE — nothing that reaches the outside world is runnable from the page');

// The catalogue's own answer.
const runnable = CMDS.filter((c) => c.risk !== 'publish');

// The independent one: what the command line actually does. These two
// disagreeing is the failure this test exists for.
const REACHES_OUT = /wrangler|pages deploy|git push|gh release|npm publish/;
const leaked = runnable.filter((c) => REACHES_OUT.test(c.command)
  // A chained script inherits its links' risk; resolve one level of `npm run`.
  || (c.command.match(/npm run ([\w:]+)/g) ?? []).some((m) => REACHES_OUT.test(pkg.scripts[m.slice(8)] ?? '')));
check('no runnable script deploys or publishes',
  !leaked.length,
  `add to PUBLISH in hub-catalogue.mjs: ${leaked.map((c) => c.name).join(', ')}`);

const shipScript = pkg.scripts.ship ? CMDS.find((c) => c.name === 'ship') : null;
check('ship is publish-classed', !shipScript || shipScript.risk === 'publish');

// The check that PUBLISH being a hand-written set of strings needs. It named
// `ship:ios`, which has never existed, while `ship:phone` and `ship:mac` — the
// two that do — fell through to `check` and rendered with a green one-click
// run button. Nothing caught it: neither is a wrangler or a git push on its
// own command line, so the REACHES_OUT scan above sees nothing either.
const shipLike = CMDS.filter((c) => /^(ship|deploy)(:|$)/.test(c.name));
const unclassed = shipLike.filter((c) => c.risk !== 'publish');
check(`every ship*/deploy* script is publish-classed (${shipLike.length})`,
  !unclassed.length,
  `add to PUBLISH in hub-catalogue.mjs: ${unclassed.map((c) => c.name).join(', ')}`);

console.log('\nTHE SHIP CARD — the one exception, and the terms it pays for it');

check(`${SHIP_SCRIPT} is a real script`, Boolean(pkg.scripts[SHIP_SCRIPT]));
check('the card ships web, Mac and phone together',
  /--phone/.test(pkg.scripts[SHIP_SCRIPT] ?? '') && /--mac/.test(pkg.scripts[SHIP_SCRIPT] ?? ''),
  pkg.scripts[SHIP_SCRIPT]);
// The branch name is written down in two files. They disagreeing means the
// card's "not the branch that deploys" warning is about the wrong branch.
check('the card and ship.mjs agree on which branch deploys',
  readFileSync(join(ROOT, 'tools/ship.mjs'), 'utf8').includes(`PROD_BRANCH = '${PROD_BRANCH}'`));

check('refuses an empty message', Boolean(checkMessage('')));
check('refuses a message of only whitespace', Boolean(checkMessage('   \n ')));
check('refuses a runaway paste', Boolean(checkMessage('x'.repeat(MAX_MESSAGE + 1))));
check('refuses a message that is not a string', Boolean(checkMessage(null)));
check('accepts a real message', checkMessage('fixed the crab') === null);
// A dry run commits nothing, so it may go without one — and ship.mjs agrees:
// its own "a commit message is required" is gated on !DRY.
check('lets a dry run go without a message', checkMessage('', true) === null);

const args = shipArgs('/tmp/msg.txt');
check('ships with --yes, since a spawned run has no stdin to answer the prompt',
  args.includes('--yes') && !args.includes('--dry'));
check('a dry run is --dry and never --yes',
  shipArgs('/tmp/msg.txt', true).includes('--dry') && !shipArgs('/tmp/msg.txt', true).includes('--yes'));
// THE ONE THAT MATTERS. A message passed as a bare argument is a message that
// becomes a flag the moment it starts with a dash, and loses everything after
// the first newline. --file is the path ship.mjs already had for this.
check('the message travels as a file, never as an argument',
  args.includes('--file') && args[args.indexOf('--file') + 1] === '/tmp/msg.txt');
check('nothing it spawns is a shell string', args.every((a) => !/[;&|`$]/.test(a)));
check('--yes skips the prompt and nothing else',
  !shipArgs('/tmp/msg.txt').includes('--no-verify'));

console.log('\nPAGES — every card links to something that is really there');

const badPageFile = PAGES.filter((p) => !existsSync(join(ROOT, p.file)));
check('every page file exists',
  !badPageFile.length,
  badPageFile.map((p) => p.file).join(', '));

const badPageScript = PAGES.filter((p) => p.script && !pkg.scripts[p.script]);
const orphans = PAGES.filter((p) => p.orphan);
if (orphans.length) console.log(`        (${orphans.length} look page(s) with no build script, carded as such: ${orphans.map((p) => p.file.split('/').pop()).join(', ')})`);
check('every page script is a real script',
  !badPageScript.length,
  badPageScript.map((p) => `${p.title} -> ${p.script}`).join(', '));

// THE CHECK THAT WAS MISSING, and the reason the shader lab could not be
// opened from the hub for two days. Every assertion here ran the other way
// round — is everything LISTED real — and passed the whole time, while the
// list named eight of twenty-six look pages. A coverage test that only checks
// its own entries is a test of nothing.
const lookHtml = readdirSync(join(ROOT, 'tools/looks'))
  .filter((f) => f.endsWith('.html'));
const catalogued = new Set(PAGES.map((p) => p.file.split('/').pop()));
const missedLook = lookHtml.filter((f) => !catalogued.has(f));
check('every look page in tools/looks is on a card',
  !missedLook.length,
  `no looks:* script builds these, so nothing can open them: ${missedLook.join(', ')}`);

// Same question at the repo root, where the previews live.
const rootHtml = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const missedRoot = rootHtml.filter((f) => !catalogued.has(f));
check('every page in the repo root is on a card',
  !missedRoot.length,
  `add to FIXED_PAGES in hub-catalogue.mjs: ${missedRoot.join(', ')}`);

// A built page whose link is guessed rather than derived lands on a 404 that
// says "no", which is indistinguishable from a failed build.
const badBuilt = PAGES.filter((p) => p.on === 'built' && !p.orphan && (!p.outDir || !p.path?.endsWith('.html')));
check('every built page carries the dist and the path its link needs',
  !badBuilt.length,
  badBuilt.map((p) => `${p.title}: outDir=${p.outDir} path=${p.path}`).join(', '));

// The link a look server's card offers has to be a path that build really
// emits. Checked against the last build on disk where there is one — a stale
// dist is skipped rather than failed, since not every look page has been built
// on this machine.
const builtOnDisk = PAGES.filter((p) => p.on === 'built' && p.outDir && existsSync(join(ROOT, p.outDir)));
const wrongPath = builtOnDisk.filter((p) => !existsSync(join(ROOT, p.outDir, p.path.slice(1))));
check(`every built page's path matches what vite emitted (${builtOnDisk.length} built)`,
  !wrongPath.length,
  wrongPath.map((p) => `${p.title} -> ${p.outDir}${p.path}`).join(', '));

const badOn = PAGES.filter((p) => !['dev', 'own', 'built'].includes(p.on));
check('every page says which server puts it on an origin', !badOn.length,
  badOn.map((p) => p.title).join(', '));

const noPath = PAGES.filter((p) => (p.on === 'dev' || p.on === 'own') && !p.path);
check('every served page has a path', !noPath.length, noPath.map((p) => p.title).join(', '));

const untitled = PAGES.filter((p) => !p.title || !p.blurb);
check('every page has a title and a description', !untitled.length,
  untitled.map((p) => p.file).join(', '));

// The root pages are the ones that rot: a preview page gets deleted and its
// card becomes a link to a 404 the dev server answers with the game.
const rootPages = PAGES.filter((p) => p.on === 'dev').map((p) => p.file);
const onDisk = readFileSync(join(ROOT, 'package.json')) && rootPages.every((f) => existsSync(join(ROOT, f)));
check('every root page card matches a file in the repo root', onDisk);

console.log('\nTHE PAGE ITSELF');

const html = readFileSync(join(ROOT, 'tools/hub.html'), 'utf8');
// Any absolute URL that is not this machine. `href = 'http://localhost:' + port`
// is the hub doing its job; a font or a CDN script is the workbench failing to
// open on a train.
const external = [...html.matchAll(/https?:\/\/(?!localhost|127\.0\.0\.1)[^\s'"`)]+/g)].map((m) => m[0]);
check('hub.html loads nothing from the internet',
  !external.length,
  `inline these: ${external.join(', ')}`);
check('hub.html asks the API for the catalogue rather than baking one in',
  html.includes('/api/catalogue'));
// The three things that make the ship card safe to have at all. Each is one
// line in the page and each is invisible if it goes: a card that ships on a
// plain click looks exactly like one that does not until the day it does.
check('the ship button is held, not clicked',
  html.includes('pointerdown')
  && !/\$\('#shipgo'\)\s*\.onclick/.test(html)
  && !/go\.addEventListener\('click'/.test(html));
check('letting go early cancels', html.includes('pointerleave'));
check('Enter in the message field cannot ship',
  /#shipmsg'\)\.onkeydown[^]*?preventDefault/.test(html));
check('the ship request carries the header that keeps other tabs out',
  html.includes("'X-Workbench': 'ship'"));

console.log('\nTHE LIVE HUB — the gate, asserted against the endpoint');

// A port nothing else is on. Asked for, not assumed: 5178 is very likely the
// user's real hub, and this test must never talk to it — it can spawn.
const freePort = await new Promise((done) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

const hub = spawn(process.execPath, [join(ROOT, 'tools/hub.mjs')], {
  cwd: ROOT,
  env: { ...process.env, HUB_PORT: String(freePort), PORT: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
hub.stdout.resume();
hub.stderr.resume();

const base = `http://localhost:${freePort}`;
const up = await (async () => {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/api/state`); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
})();

if (!up) {
  failures++;
  console.log('  FAIL  the hub did not come up');
} else {
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  check('serves live state', Array.isArray(state.servers) && typeof state.origins === 'object');
  check('reports its own port', state.port === freePort);

  const cat = await fetch(`${base}/api/catalogue`).then((r) => r.json());
  check('serves the whole catalogue', cat.commands.length === CMDS.length);
  // Not a duplicate of the check above: pages used to be a module constant
  // built at import, so a hub left open never saw a page added after it
  // started. Comparing the endpoint against a list read from disk NOW is what
  // catches that coming back.
  check('serves pages read from disk, not frozen at boot',
    cat.pages.length === PAGES.length,
    `endpoint ${cat.pages.length} vs disk ${PAGES.length}`);

  const page = await fetch(base).then((r) => r.text());
  check('serves the page at /', page.includes('Seal Survivor'));

  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

  const bogus = await post('/api/run', { name: 'rm -rf /' });
  check('refuses anything that is not a script in package.json', bogus.status === 400);

  const injected = await post('/api/run', { name: 'test:hub && echo pwned' });
  check('refuses a script name with a shell operator in it', injected.status === 400);

  const deploy = await post('/api/run', { name: 'deploy' });
  check('refuses to deploy', deploy.status === 403, JSON.stringify(deploy.body));

  const ship = await post('/api/run', { name: 'ship' });
  check('refuses to ship', ship.status === 403);

  // /api/run must go on refusing EVERY publish script, this one included. The
  // ship card is a second endpoint rather than an exception carved into this
  // one, because an exception in a shared gate is a gate that grows holes.
  const shipAll = await post('/api/run', { name: SHIP_SCRIPT });
  check(`refuses to ${SHIP_SCRIPT} from /api/run`, shipAll.status === 403);

  const shipPost = (body, headers) => fetch(`${base}/api/ship`, { method: 'POST', headers, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

  // Nothing below may actually ship, so every case here is one the endpoint
  // must REFUSE. The accepted path is asserted against shipArgs above, where
  // it costs nothing and deploys nothing.
  const noHeader = await shipPost({ message: 'nope' });
  check('refuses a ship request without the workbench header', noHeader.status === 403);

  const otherTab = await shipPost({ message: 'nope' }, { 'X-Workbench': 'ship', Origin: 'http://localhost:5555' });
  check('refuses a ship request from another origin', otherTab.status === 403);

  const noMessage = await shipPost({ message: '  ' }, { 'X-Workbench': 'ship' });
  check('refuses a ship with no commit message', noMessage.status === 400);

  const huge = await shipPost({ message: 'x'.repeat(MAX_MESSAGE + 1) }, { 'X-Workbench': 'ship' });
  check('refuses a runaway message', huge.status === 400);

  // A preflight is what a cross-origin fetch with a custom header sends first.
  // The hub answering it with anything permissive would hand every page on
  // this machine a deploy button.
  const preflight = await fetch(`${base}/api/ship`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5555', 'Access-Control-Request-Method': 'POST' },
  });
  check('answers a CORS preflight with nothing that allows it',
    preflight.status === 404 && !preflight.headers.get('access-control-allow-origin'));

  const kill = await post('/api/stop-server', { pid: 1 });
  check('refuses to signal a process it did not find itself', kill.status === 400);

  // The one thing it SHOULD do. A check that costs nothing and exits fast.
  const ok = await post('/api/run', { name: 'test:animdebug' });
  check('runs a check when asked', typeof ok.body.id === 'number');
  if (typeof ok.body.id === 'number') {
    let log = null;
    for (let i = 0; i < 200; i++) {
      log = await fetch(`${base}/api/log?id=${ok.body.id}&since=0`).then((r) => r.json());
      if (log.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    check('streams the run to completion', log && log.status !== 'running', `status ${log?.status}`);
    check('captures its output', (log?.total ?? 0) > 0, `${log?.total} lines`);
  }
}

// Wait for it to actually go, and escalate if it does not. A test that leaves
// a listening server behind is the exact mess `npm run servers` exists to
// clean up, and an orphan on a random port is one nobody will ever recognise.
await new Promise((done) => {
  const hard = setTimeout(() => { try { hub.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
  hub.on('close', () => { clearTimeout(hard); done(); });
  hub.kill('SIGTERM');
});

console.log(failures ? `\n${failures} FAILED\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
