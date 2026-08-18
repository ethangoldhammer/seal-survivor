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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { commands, PAGES, GROUP_ORDER, ROOT, blurbFromFile, targetFile } from './hub-catalogue.mjs';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok    ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
};

const CMDS = commands();
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

console.log('\nPAGES — every card links to something that is really there');

const badPageFile = PAGES.filter((p) => !existsSync(join(ROOT, p.file)));
check('every page file exists',
  !badPageFile.length,
  badPageFile.map((p) => p.file).join(', '));

const badPageScript = PAGES.filter((p) => p.script && !pkg.scripts[p.script]);
check('every page script is a real script',
  !badPageScript.length,
  badPageScript.map((p) => `${p.title} -> ${p.script}`).join(', '));

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
