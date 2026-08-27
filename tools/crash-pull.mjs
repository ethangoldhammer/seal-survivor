#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run crash [-- --device <name|udid>] [--json]
//
// What the phone's last few sessions ended as. systems/crashLog.js keeps a
// breadcrumb trail in localStorage and copies it to Documents/crash.json on
// the next launch; this pulls that file over the cable and prints it.
//
// WHY THE CABLE AND NOT THE CONSOLE. A WebContent process that is killed takes
// the console with it, and Safari's inspector has to be attached BEFORE the
// thing you are trying to see. The file is written after the fact, on the next
// launch, so the sequence is: it crashes, you relaunch the app once, you run
// this.
//
// A report reads:
//   cut      the process went away — nothing ran after the last breadcrumb
//   cut-bg   the same, but the app was in the background (iOS reclaiming it)
//   error    something threw or rejected; the message and top frames are on it
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const BUNDLE = 'com.ethangoldhammer.sealsurvivor';
const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

/**
 * The one line a report is worth. Pure, so tools/crash-log-test.mjs can check
 * the formatting without a phone in the room.
 */
export function describeReport(r) {
  const when = r.at ? new Date(r.at).toLocaleString() : 'unknown time';
  const head = `${r.kind === 'error' ? 'error' : r.kind} · ${r.tag ?? 'no breadcrumb'} · ${r.upSeconds}s in`;
  const err = r.err ? `\n    ${r.err.how}: ${r.err.msg}${r.err.at ? `\n    ${r.err.at}` : ''}` : '';
  const trail = (r.crumbs ?? []).map((x) => x.tag).join(' → ');
  return `${head}\n    ${when} · build ${r.build}\n    ${trail}${err}`;
}

function deviceId() {
  const named = arg('device');
  if (named) return named;
  const out = execFileSync('xcrun', ['devicectl', 'list', 'devices'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => /available|connected/i.test(l) && /[0-9A-F-]{36}/.test(l));
  const id = line?.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/)?.[0];
  if (!id) throw new Error('no paired device — plug the phone in, or pass --device');
  return id;
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sv-crash-'));
  const dest = join(dir, 'crash.json');
  try {
    execFileSync('xcrun', [
      'devicectl', 'device', 'copy', 'from',
      '--device', deviceId(),
      '--domain-type', 'appDataContainer',
      '--domain-identifier', BUNDLE,
      '--user', 'mobile',
      '--source', 'Documents/crash.json',
      '--destination', dest,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    console.log(`${c.yellow}no crash.json on the device${c.off}`);
    console.log(`${c.dim}Either nothing has crashed since the build with systems/crashLog.js in it,`);
    console.log(`or the app has not been launched AGAIN since it did — the file is written on`);
    console.log(`the launch after the crash, not on the crash.${c.off}`);
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }

  const doc = JSON.parse(readFileSync(dest, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  const reports = doc.reports ?? [];
  console.log(`${c.bold}crash log${c.off} ${c.dim}· build ${doc.build} · ${reports.length} report(s)${c.off}\n`);
  for (const r of reports) {
    const tint = r.kind === 'error' ? c.red : r.kind === 'cut' ? c.yellow : c.dim;
    console.log(`  ${tint}${describeReport(r)}${c.off}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
