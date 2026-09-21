#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run jetsam [-- --from <dir>] [--json] [--all]
//
// WHAT THE PHONE THOUGHT THIS PROCESS WAS USING, at the moment it killed it.
//
// Every instrument in this repo measures the small end. systems/memoryCensus.js
// walks the scene and reports ~390MB, reading after reading, session after
// session, in a run AND in a match — while the device jetsams the web view at
// something nearer 1.8GB. Roughly four fifths of the footprint is invisible to
// anything the page can ask about: the GPU's own copy of every texture, the
// JavaScriptCore heap (`performance.memory` does not exist in WebKit, so
// heapUsed() reads 0 on the device), and WebKit's own layers and buffers.
//
// iOS writes that number down. When the kernel kills a process for memory it
// files a JetsamEvent report naming EVERY process, its resident pages, and its
// lifetime high-water mark — so the question "where did the other 1.4GB go"
// has an answer on the phone already, and it does not need another counter in
// the game to find it.
//
// `npm run crash` is the game's account of the kill; this is the system's.
// Read them together: the crash trail says what the frame was carrying, this
// says what the process weighed and which of the two — the web content or the
// app — the kernel actually came for.
//
// HOW THE FILES GET HERE. They are on the device, not on this Mac, and there
// is no devicectl verb for them (it can only reach the app's own container,
// which is what crash-pull uses). Two routes, and this looks in both:
//
//   1. Xcode -> Window -> Devices and Simulators -> the device -> View Device
//      Logs. Opening that pane syncs the device's reports into
//      ~/Library/Logs/CrashReporter/MobileDevice/<device>/ and leaves them
//      there. Once per session of hunting, then this is free.
//   2. On the phone: Settings -> Privacy & Security -> Analytics &
//      Improvements -> Analytics Data, scroll to JetsamEvent-*, share it to
//      the Mac. Point this at wherever it landed with --from.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };

// The two processes this is ever about. The web view runs the game in its own
// process with its own limit — the app being nowhere near ITS ceiling is the
// normal and misleading case, and the reason both are called out by name.
const WEB = /web ?content|webkit/i;
// THE NATIVE SHELL IS CALLED `App`, exactly that, because that is what the
// Capacitor target's executable is named — the bundle id never reaches this
// report. Matching on 'sealsurvivor' found NOTHING in a real report on 9/18
// and silently dropped the app's own row while printing the web view's; the
// only reason it was noticed is that our coalition had a row the eye could
// not account for. Anchored, or it matches AppleAccountD and half of iOS.
const APP = /sealsurvivor|seal survivor|^App$/i;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}
const wants = (name) => process.argv.includes(`--${name}`);

/**
 * A JetsamEvent report's body.
 *
 * Pure, and exported for the test: this is the only part of the file whose
 * answer can be WRONG rather than merely absent, because `rpages` is a page
 * count and reporting it as bytes would be off by four or five orders of
 * magnitude in the confident direction.
 *
 * Two layouts in the wild. Some reports are one JSON document; the newer .ips
 * shape is a header line of JSON followed by the body, and a parser that knows
 * only one of them reports "no reports found" on a directory full of them.
 */
export function parseReport(text) {
  const whole = tryJSON(text);
  if (whole?.processes) return whole;
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const head = tryJSON(text.slice(0, nl));
  const body = tryJSON(text.slice(nl + 1));
  if (!body?.processes) return null;
  return { ...body, timestamp: body.timestamp ?? head?.timestamp };
}

function tryJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * One report as a block of text. Pure — see parseReport.
 *
 * SORTED BY FOOTPRINT AND CUT TO THE TOP FEW, because a report names every
 * process on the phone and forty rows of daemons bury the two that matter.
 */
export function describeJetsam(r, { top = 8 } = {}) {
  const page = r.memoryStatus?.pageSize || 16384;
  const mb = (pages) => Math.round((pages || 0) * page / 1048576);
  const procs = [...(r.processes ?? [])]
    .map((p) => ({
      name: p.name ?? '?',
      mb: mb(p.rpages),
      // The HIGH-WATER MARK, which is the more useful of the two: a process
      // killed on a spike is already shedding by the time its pages are
      // counted, so `rpages` can read well under what actually tipped it.
      peakMB: mb(p.lifetimeMax),
      reason: p.reason ?? '',
      state: (p.states ?? []).join('+'),
    }))
    .sort((a, b) => b.mb - a.mb);

  const when = r.timestamp ? String(r.timestamp).replace(/\s*[+-]\d{4}$/, '') : 'unknown time';
  const head = `${when}${r.os_version ? ` · ${r.os_version}` : ''}`
    + `${r.largestProcess ? ` · largest: ${r.largestProcess}` : ''}`;

  const rows = [];
  for (const p of procs.slice(0, top)) {
    const ours = WEB.test(p.name) || APP.test(p.name);
    const colour = WEB.test(p.name) ? c.red : APP.test(p.name) ? c.yellow : c.dim;
    rows.push(`    ${colour}${ours ? '>' : ' '} ${String(p.mb).padStart(5)}MB`
      + `${p.peakMB && p.peakMB !== p.mb ? ` (peak ${p.peakMB}MB)` : ''}`
      + `  ${p.name}${p.reason ? ` — ${p.reason}` : ''}${p.state ? ` [${p.state}]` : ''}${c.off}`);
  }
  // ...and our two even when they did not make the cut, or a report where the
  // web view was NOT the biggest process silently says nothing about it, which
  // is exactly the report worth reading.
  for (const p of procs.slice(top)) {
    if (WEB.test(p.name) || APP.test(p.name)) {
      rows.push(`    ${c.dim}  ${String(p.mb).padStart(5)}MB  ${p.name} (rank ${procs.indexOf(p) + 1})${c.off}`);
    }
  }
  // THE COALITION, which is the only honest total for this app. The kernel
  // bills the web view, the GPU process, the networking process and the native
  // shell separately and they are four rows scattered through five hundred —
  // but they are ONE app's memory, and the web view's 783MB alone understates
  // what the game costs the phone. Our coalition is whichever one holds a
  // process this file recognises.
  const all = r.processes ?? [];
  const ourCoalition = all.find((p) => APP.test(p.name ?? ''))?.coalition
    ?? all.find((p) => WEB.test(p.name ?? ''))?.coalition;
  if (ourCoalition !== undefined) {
    const mine = all.filter((p) => p.coalition === ourCoalition);
    const total = mine.reduce((n, p) => n + mb(p.rpages), 0);
    const peak = mine.reduce((n, p) => n + mb(p.lifetimeMax), 0);
    rows.push(`    ${c.bold}  ${String(total).padStart(5)}MB (peak ${peak}MB)  = this app, all ${mine.length} processes${c.off}`);
  }

  const pages = r.memoryStatus?.memoryPages ?? {};
  const free = pages.free !== undefined ? `  free ${mb(pages.free)}MB` : '';
  const wired = pages.wired !== undefined ? `  wired ${mb(pages.wired)}MB` : '';
  return `${head}\n${rows.join('\n')}\n    ${c.dim}page ${page}B${free}${wired}${c.off}`;
}

/**
 * HOW STALE THE FOLDER IS. Pure, and exported for the test.
 *
 * THIS TOOL DOES NOT TALK TO THE PHONE. It reads a folder that Xcode fills,
 * and Xcode fills it only while its Devices and Simulators pane is open. So
 * `1 of 1 report(s)` over a folder last written an hour ago is not the
 * statement it looks like: the kill you are asking about may simply not have
 * been collected. That absence is the tool's most consequential output — it is
 * what says "not a memory kill" — and it must never be read off a stale folder.
 *
 * `syncedAt` is the newest mtime of ANY file in the synced directories, not
 * just the JetsamEvent ones: a folder full of fresh SiriSearchFeedback and no
 * fresh jetsam is a real answer, and a folder with nothing fresh at all is no
 * answer. Returns null when nothing is known.
 */
export function syncLine(syncedAt, now = Date.now(), newestKill = null) {
  if (!syncedAt) return null;
  const mins = Math.round((now - syncedAt) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)}h ago`;
  const when = new Date(syncedAt).toLocaleTimeString();
  let line = `last synced ${when} (${ago})`;
  // The one comparison that matters, when the caller can make it.
  if (newestKill && newestKill > syncedAt) {
    line += ` — NEWER THAN THIS SYNC: the ${new Date(newestKill).toLocaleTimeString()} kill`
      + ' has not been collected. Its absence here means nothing.';
  }
  return line;
}

function candidates() {
  const from = arg('from');
  if (from) return [{ dir: from, synced: true }];
  const home = homedir();
  const out = [];
  // TWO SYNC ROOTS, and which one a Mac uses is a matter of its Xcode version:
  // the CrashReporter path is the old one and is EMPTY on this machine, while
  // Xcode 26 syncs to DeviceLogs/<device>/Other Logs. Looking in only the first
  // is how this tool printed "no JetsamEvent reports on this Mac" over a folder
  // that had one, which reads as "it was never a memory kill" and is the single
  // most misleading thing it could say.
  const roots = [
    join(home, 'Library/Logs/CrashReporter/MobileDevice'),
    join(home, 'Library/Developer/Xcode/DeviceLogs'),
  ];
  for (const synced of roots) {
    if (!existsSync(synced)) continue;
    for (const e of readdirSync(synced, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dev = join(synced, e.name);
      out.push({ dir: dev, synced: true });
      // Xcode files everything that is not an app crash one level down.
      const other = join(dev, 'Other Logs');
      if (existsSync(other)) out.push({ dir: other, synced: true });
    }
  }
  // Where a report shared off the phone lands. NOT a sync directory: its mtime
  // moves every time anything is downloaded and says nothing about the phone.
  for (const d of ['Downloads', 'Desktop']) {
    const p = join(home, d);
    if (existsSync(p)) out.push({ dir: p, synced: false });
  }
  return out;
}

let syncedAt = 0;

function findFiles() {
  const hits = [];
  for (const { dir, synced } of candidates()) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let at;
      try {
        at = statSync(full).mtimeMs;
      } catch {
        continue; // vanished between listing and stat
      }
      // EVERY REPORT, not just the jetsam ones — see syncLine. The freshest
      // .ips in the folder is the evidence that the sync reached a given
      // moment at all, and a folder of fresh SiriSearchFeedback with no fresh
      // jetsam is a real answer.
      //
      // `.ips` ONLY, and only in a directory Xcode actually fills. `.DS_Store`
      // sits in that folder and Finder touches it merely for being looked at —
      // it read 37 minutes NEWER than the last real sync on the first run of
      // this code, which is a Finder artifact certifying that the phone had
      // been asked. That is the precise lie this whole function exists to stop.
      if (synced && at > syncedAt && /\.ips$/i.test(name)) syncedAt = at;
      if (/^JetsamEvent/i.test(name)) hits.push({ full, name, at });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

function main() {
  const files = findFiles();
  if (!files.length) {
    console.log(`\n${c.bold}no JetsamEvent reports on this Mac${c.off}\n`);
    console.log('They live on the phone. Either:\n');
    console.log(`  ${c.bold}1.${c.off} Xcode -> Window -> Devices and Simulators -> your device`);
    console.log('     -> View Device Logs. Opening it syncs them to');
    console.log(`     ${c.dim}~/Library/Logs/CrashReporter/MobileDevice/<device>/${c.off}, then re-run this.\n`);
    console.log(`  ${c.bold}2.${c.off} On the phone: Settings -> Privacy & Security -> Analytics &`);
    console.log('     Improvements -> Analytics Data -> JetsamEvent-* -> share it over,');
    console.log(`     then ${c.bold}npm run jetsam -- --from ~/Downloads${c.off}\n`);
    const fresh = syncLine(syncedAt);
    if (fresh) console.log(`${c.yellow}${fresh}${c.off}\n`);
    console.log(`${c.dim}A kill with no report means the process was not killed for memory —${c.off}`);
    console.log(`${c.dim}check \`npm run crash\` for an 'error' verdict instead.${c.off}\n`);
    return;
  }

  const kept = wants('all') ? files : files.slice(-6);
  const parsed = [];
  for (const f of kept) {
    const r = parseReport(readFileSync(f.full, 'utf8'));
    if (r) parsed.push({ file: f, report: r });
  }

  if (wants('json')) {
    console.log(JSON.stringify({ count: parsed.length, reports: parsed.map((p) => p.report) }, null, 2));
    return;
  }

  if (!parsed.length) {
    console.log(`\n${c.red}found ${files.length} JetsamEvent file(s) and could not parse any of them.${c.off}`);
    console.log(`${c.dim}The report layout has changed; parseReport in this file needs a look.${c.off}\n`);
    return;
  }

  console.log(`\n${c.bold}jetsam${c.off} ${c.dim}· ${parsed.length} of ${files.length} report(s)`
    + `${wants('all') ? '' : ' (newest 6 — pass --all for the rest)'}${c.off}\n`);
  for (const { file, report } of parsed) {
    console.log(`  ${c.dim}${file.name}${c.off}`);
    console.log(`  ${describeJetsam(report)}\n`);
  }
  console.log(`${c.dim}'>' marks this game's two processes. The web view has its own limit and`);
  console.log(`is the one that dies; the app being far under ITS ceiling is expected.${c.off}`);
  // THE DATE ON THE EVIDENCE, last so it is the line still on screen. This
  // tool reads a folder; Xcode fills it. Reading "no report for that kill"
  // off a folder that was last written before the kill is the one mistake
  // here that sends somebody down a week of the wrong hunt.
  const fresh = syncLine(syncedAt);
  if (fresh) console.log(`\n${c.yellow}${fresh}${c.off}`);
  console.log(`${c.dim}Xcode -> Window -> Devices and Simulators -> View Device Logs syncs;`);
  console.log(`this command only reads what that pane already brought over.${c.off}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('jetsam-pull.mjs')) main();
