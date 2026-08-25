#!/usr/bin/env node
// ============================================================================
// SERVERS — what is listening, what it is for, and what is safe to kill.
//
//   npm run servers              show the panel
//   npm run servers -- stop 3000 stop whatever is listening on that port
//   npm run servers -- clean     stop everything the panel calls stale
//
// The problem this solves is not "I forgot which port". It is that a second
// `npm run dev` is not a harmless duplicate: every dev server carries the
// tuning writer from vite.config.js, so a tab left open on an old one still
// POSTs to /__tuning and overwrites path/src/imported-tuning.json with the
// snapshot it booted with. A dev server from yesterday is a loaded gun aimed
// at today's tuning, and nothing about it looks wrong from the outside.
//
// So the panel is not a port list. It sorts by what each process can DESTROY:
// the newest dev server is yours, every older one is a stomp waiting to fire,
// and the rest are noise you can clear without thinking about it.
//
// Nothing here is hardcoded to a port. Vite honours PORT and otherwise takes
// whatever it can get, so ports are discovered, never assumed — the panel
// reads the live socket table and works out what each process is from its own
// command line.
// ============================================================================

import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};

// ---------------------------------------------------------------------------
// THE ROLES
//
// `need` is the honest answer to "should this be running right now": one means
// exactly one, none means only while you are actively using it. That column is
// the whole point — a panel that only says what IS running cannot tell you
// what is MISSING, and a dead CSV editor looks identical to one you never
// started.
// ---------------------------------------------------------------------------
export const ROLES = {
  dev: {
    need: 'one',
    label: 'game — vite dev',
    start: 'npm run dev',
    why: 'The game. Writes imported-tuning.json, so a second one can flatten your tuning.',
  },
  csv: {
    need: 'one',
    label: 'CSV editor',
    start: 'npm run csv',
    why: 'enemies / upgrades / quips tables. Sole writer, checks mtime before saving.',
  },
  preview: {
    need: 'none',
    label: 'built bundle — vite preview',
    start: 'npm run preview',
    why: 'Serves dist/ as last built. Only useful right after a build; goes stale silently.',
  },
  hub: {
    need: 'one',
    label: 'workbench hub',
    start: 'npm run hub',
    why: 'The index of every tool in the repo, on a port that never moves. Read-only.',
  },
  looks: {
    need: 'none',
    label: 'look page — static server',
    start: 'npm run looks:<name>',
    why: 'Serves one built look page read-only. Never imports config.js, so it cannot touch tuning.',
  },
  atlas: {
    need: 'none',
    label: 'atlas renderer',
    start: 'node tools/atlas-render/server.mjs',
    why: 'Renders model portraits in a real browser. Read-only; only writes into its own shots dir.',
  },
  pick: {
    need: 'none',
    label: 'design picker — port 4601',
    start: 'npm run pick',
    why: 'Angles for model shots that go in documents: http://localhost:4601/picker.html?list=design-icons.json — writes the chosen angles and PNGs under design/, never the game.',
  },
  scratch: {
    need: 'none',
    label: 'agent scratchpad',
    start: '—',
    why: 'A Claude session served a temp page. Nothing in the repo depends on it.',
  },
  other: {
    need: 'none',
    label: 'unrecognised node server',
    start: '—',
    why: 'Not something this repo starts. Left alone by `clean`.',
  },
};

// ---------------------------------------------------------------------------
// DISCOVERY
// ---------------------------------------------------------------------------

// Every listening TCP socket owned by a node process, as { pid, ports }.
//
// The `-a` is load-bearing: lsof ORs its selection flags by default, so
// `-iTCP -c node` means "every TCP socket OR every node process" and quietly
// hands back the user's Python servers alongside ours. With -a it is an AND,
// which is the only reading under which `clean` is safe to run.
function listeners() {
  const byPid = new Map();
  for (const line of sh('lsof -a -nP -iTCP -sTCP:LISTEN -c node').split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const pid = Number(cols[1]);
    const port = Number(cols[8].split(':').pop());
    if (!pid || !port) continue;
    if (!byPid.has(pid)) byPid.set(pid, new Set());
    byPid.get(pid).add(port); // v4 and v6 on the same port are one server
  }
  return byPid;
}

// pid -> { ppid, elapsed, command }. One ps call, not one per process.
function processTable(pids) {
  const out = new Map();
  if (!pids.length) return out;
  for (const line of sh(`ps -o pid=,ppid=,etime=,command= -p ${pids.join(',')}`).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), elapsed: m[3], command: m[4] });
  }
  return out;
}

function cwdOf(pid) {
  const m = /^n(.*)$/m.exec(sh(`lsof -a -p ${pid} -d cwd -Fn`));
  return m ? m[1] : '';
}

function commandOf(pid) {
  return sh(`ps -o command= -p ${pid}`).trim();
}

// Who will kill this when they exit. A server parented to the Claude app dies
// with the app, which is the difference between "always there" and "there
// until I quit Claude" — and you cannot see it from the port.
function ownerOf(pid, table) {
  let cur = table.get(pid)?.ppid;
  for (let i = 0; i < 12 && cur && cur > 1; i++) {
    const cmd = commandOf(cur);
    if (/Claude\.app|Claude Helper/.test(cmd)) return 'Claude app';
    if (/iTerm|Terminal\.app|Warp|Ghostty|Alacritty|kitty/.test(cmd)) return 'terminal';
    if (/Code Helper|Visual Studio Code|WindowSurf|Cursor/.test(cmd)) return 'editor';
    cur = Number(sh(`ps -o ppid= -p ${cur}`).trim());
  }
  return cur === 1 ? 'launchd' : 'unknown';
}

function classify(proc) {
  const text = `${proc.command} ${proc.parentCommand}`;
  if (/csv-editor\.mjs/.test(text)) return 'csv';
  if (/hub\.mjs/.test(text)) return 'hub';
  if (/looks[/\\]serve\.mjs/.test(text)) return 'looks';
  // Before the atlas rule, and it has to be: the design picker IS an atlas
  // server, started by design-pick.mjs, so the only thing telling the two
  // apart is the parent's command line (or the port it was told to take).
  if (/design-pick\.mjs/.test(text) || /--port\s+4601/.test(text)) return 'pick';
  if (/atlas-render[/\\]server\.mjs/.test(text)) return 'atlas';
  if (/vite\s+preview/.test(text)) return 'preview';
  if (/[/\s]vite($|\s)/.test(text)) return 'dev';
  if (/claude-\d+|scratchpad/.test(`${proc.cwd} ${text}`)) return 'scratch';
  return 'other';
}

// Older-first ordering, from `ps` elapsed time (`[[dd-]hh:]mm:ss`).
function ageSeconds(elapsed = '') {
  const [days, rest] = elapsed.includes('-') ? elapsed.split('-') : ['0', elapsed];
  const parts = rest.split(':').map(Number).reverse(); // ss, mm, hh
  return Number(days) * 86400 + (parts[0] || 0) + (parts[1] || 0) * 60 + (parts[2] || 0) * 3600;
}

function humanAge(seconds) {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function survey() {
  const sockets = listeners();
  const pids = [...sockets.keys()];
  const table = processTable(pids);

  const found = pids.map((pid) => {
    const info = table.get(pid) || { ppid: 0, elapsed: '0:00', command: '' };
    const proc = {
      pid,
      ports: [...sockets.get(pid)].sort((a, b) => a - b),
      command: info.command,
      parentCommand: info.ppid ? commandOf(info.ppid) : '',
      cwd: cwdOf(pid),
      age: ageSeconds(info.elapsed),
    };
    proc.role = classify(proc);
    proc.mine = proc.cwd.startsWith(ROOT) || proc.command.includes(ROOT) || proc.role === 'scratch';
    proc.owner = ownerOf(pid, table);
    return proc;
  }).filter((p) => p.mine);

  // Newest wins. For the roles that want exactly one instance, the one you
  // most recently started is the one you are actually looking at.
  const newestOf = (role) => found
    .filter((p) => p.role === role)
    .sort((a, b) => a.age - b.age)[0];

  const keepers = new Set([newestOf('dev')?.pid, newestOf('csv')?.pid, newestOf('hub')?.pid].filter(Boolean));

  for (const p of found) {
    if (keepers.has(p.pid)) { p.verdict = 'keep'; p.note = 'this is the one you are using'; }
    else if (p.role === 'dev') { p.verdict = 'stomp'; p.note = 'older dev server — a tab on it can overwrite your tuning'; }
    else if (p.role === 'csv') { p.verdict = 'stale'; p.note = 'duplicate CSV editor'; }
    else if (p.role === 'hub') { p.verdict = 'stale'; p.note = 'duplicate hub'; }
    else if (p.role === 'preview') { p.verdict = 'stale'; p.note = 'serving a build from ' + humanAge(p.age) + ' ago'; }
    // `idle`, NOT `stale`, and the distinction is the whole reason this verdict
    // exists. A look server is read-only and harmless, but it is also the thing
    // you are looking at right now — comparing two looks side by side means
    // several of these are up ON PURPOSE. Calling them stale put a server the
    // user was actively using in front of `clean`, which is the one mistake
    // this panel is supposed to prevent, not commit.
    //
    // Past a few hours it is leftovers again, so it ages into `stale` and
    // becomes fair game. Nothing here can ever mark the newest one for death.
    else if (p.role === 'looks' || p.role === 'atlas' || p.role === 'pick') {
      const old = p.age > 4 * 3600;
      p.verdict = old ? 'stale' : 'idle';
      p.note = old
        ? 'read-only render server, forgotten ' + humanAge(p.age) + ' ago'
        : 'read-only render server, up ' + humanAge(p.age) + ' — kill it by hand when you are done';
    }
    else if (p.role === 'scratch') { p.verdict = 'stale'; p.note = 'left behind by an agent session'; }
    else { p.verdict = 'unknown'; p.note = 'not started by this repo'; }
  }

  return found.sort((a, b) => a.age - b.age);
}

// ---------------------------------------------------------------------------
// THE PANEL
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' };

const MARK = {
  keep: `${C.green}●${C.off} keep `,
  idle: `${C.dim}◍${C.off} idle `,
  stomp: `${C.red}▲${C.off} STOMP`,
  stale: `${C.yellow}○${C.off} stale`,
  unknown: `${C.dim}?${C.off}     `,
};

function panel() {
  const found = survey();
  const pad = (s, n) => String(s).padEnd(n);

  console.log(`\n${C.bold}  SEAL SURVIVOR — SERVERS${C.off}\n`);
  console.log(`  ${C.dim}${pad('', 7)}${pad('PORT', 8)}${pad('WHAT', 30)}${pad('PID', 8)}${pad('UP', 7)}${pad('OWNER', 12)}${C.off}`);

  if (!found.length) console.log(`  ${C.dim}nothing running${C.off}`);
  for (const p of found) {
    console.log(`  ${MARK[p.verdict]} ${pad(p.ports.join(','), 8)}${pad(ROLES[p.role].label, 30)}${pad(p.pid, 8)}${pad(humanAge(p.age), 7)}${pad(p.owner, 12)}`);
    console.log(`  ${C.dim}${' '.repeat(6)}${p.note}${C.off}`);
  }

  // What SHOULD be up, including the ones that are not.
  console.log(`\n${C.bold}  WHAT YOU NEED${C.off}\n`);
  for (const role of ['dev', 'csv', 'hub', 'pick', 'preview']) {
    // `idle` counts as up. Only dev/csv/hub are ever marked `keep` (they are
    // the roles that want exactly one), so a running picker would otherwise be
    // reported as not running by the very panel that is listing it.
    const up = found.some((p) => p.role === role && (p.verdict === 'keep' || p.verdict === 'idle'));
    const want = ROLES[role].need === 'one';
    // An optional role that is down still shows how to start it. Without this
    // the line read "not running (fine)" and stopped — true, and useless: the
    // one thing you want from a panel listing a tool you are not running is
    // the command that runs it.
    const state = up ? `${C.green}running${C.off}`
      : want ? `${C.red}NOT RUNNING${C.off}  →  ${ROLES[role].start}`
      : `${C.dim}not running (fine)${C.off}  →  ${ROLES[role].start}`;
    console.log(`  ${pad(ROLES[role].label, 30)}${state}`);
    console.log(`  ${C.dim}${ROLES[role].why}${C.off}\n`);
  }

  const dirty = found.filter((p) => p.verdict === 'stomp' || p.verdict === 'stale');
  if (dirty.length) {
    const stomps = dirty.filter((p) => p.verdict === 'stomp').length;
    console.log(`  ${dirty.length} to clear${stomps ? `, ${C.red}${stomps} of them able to overwrite your tuning${C.off}` : ''}`);
    console.log(`  ${C.bold}npm run servers -- clean${C.off}${C.dim}   (or: npm run servers -- stop <port>)${C.off}\n`);
  } else {
    console.log(`  ${C.green}Nothing stale.${C.off}\n`);
  }

  // A server parented to the Claude app dies when Claude quits. Worth saying
  // out loud, because the symptom is a Chrome tab that just stops loading.
  const fragile = found.filter((p) => p.verdict === 'keep' && p.owner === 'Claude app');
  if (fragile.length) {
    console.log(`  ${C.yellow}Note:${C.off} ${fragile.map((p) => ROLES[p.role].label).join(' and ')} ${fragile.length > 1 ? 'are' : 'is'} owned by the Claude app —`);
    console.log(`  quitting Claude kills ${fragile.length > 1 ? 'them' : 'it'}. Start from a terminal to keep ${fragile.length > 1 ? 'them' : 'it'} up.\n`);
  }
}

export function stop(pid, label) {
  try { process.kill(pid, 'SIGTERM'); console.log(`  stopped ${label} (pid ${pid})`); }
  catch (err) { console.log(`  could not stop pid ${pid} — ${err.message}`); }
}

function clean() {
  // `other` is never touched: something is listening that this repo did not
  // start, and guessing at it is how you kill someone's unrelated work.
  const doomed = survey().filter((p) => p.verdict === 'stomp' || p.verdict === 'stale');
  if (!doomed.length) { console.log('\n  Nothing stale.\n'); return; }
  console.log('');
  for (const p of doomed) stop(p.pid, `${ROLES[p.role].label} on ${p.ports.join(',')}`);
  console.log('');
}

// The panel is the CLI, but survey()/stop() are also the hub's eyes and hands
// (tools/hub.mjs) — so this only runs when the file was invoked directly. An
// import must not print a panel, and must never be able to kill anything as a
// side effect of being read.
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'clean') clean();
  else if (cmd === 'stop' && arg) {
    const target = survey().find((p) => p.ports.includes(Number(arg)) || p.pid === Number(arg));
    if (!target) console.log(`\n  nothing of ours on ${arg}\n`);
    else { console.log(''); stop(target.pid, ROLES[target.role].label); console.log(''); }
  } else panel();
}
