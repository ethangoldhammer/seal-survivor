#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run audio
//
// THE AUDIO DEVICE IDS, because the recorder needs one and nothing on the Mac
// will show you it.
//
// `screencapture -G` takes a CoreAudio device UID. Every audio UI on the
// machine — System Settings, the menu bar, Audio MIDI Setup — shows you the
// NAME, so the name is what you try first, and the failure is total and
// unhelpful:
//
//   screencapture: Capture audio device BlackHole 2ch not found.
//
// No file, no recording, and nothing to suggest the argument was the wrong
// KIND of string rather than the wrong device.
//
// Only devices with INPUT channels are listed, because those are the only ones
// -G can record from. A loopback like BlackHole shows up here precisely
// because it presents its output back as an input — that is the whole trick,
// and it is why the game's sound can be captured at all.
//
//   node tools/audio-devices.mjs
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SWIFT = join(import.meta.dirname, 'audio-devices.swift');
const run = spawnSync('swift', [SWIFT], { encoding: 'utf8' });

if (run.status !== 0) {
  // Swift is part of the Xcode command line tools. Without them the UIDs are
  // simply not reachable from a script, so say so rather than printing names
  // that cannot be passed to -G.
  console.error('Could not read the audio devices — this needs the Xcode command line tools.');
  console.error(run.stderr?.trim().split('\n').slice(0, 3).join('\n') ?? '');
  console.error('\n  xcode-select --install\n');
  process.exit(1);
}

const rows = JSON.parse(run.stdout).filter((d) => d.inputs > 0);
if (!rows.length) {
  console.log('No input devices. Nothing can be recorded — install BlackHole for the game\'s own sound.');
  process.exit(0);
}

const width = Math.max(...rows.map((r) => r.uid.length));
console.log('\n  Devices a take can record from — pass the id, not the name.\n');
for (const r of rows) {
  console.log(`  ${String(r.inputs).padStart(2)}ch  ${r.uid.padEnd(width)}  ${r.name}`);
}
console.log(`\n  npm run desktop -- --capture=1280x720 --record --audio=<id>`);
console.log('  --audio with no id means BlackHole, which is the usual answer.\n');
