// Screenshot one Sealitaire artboard on its own — a rank card, or one of the
// Pip / Corner / Plate components — so a layout can be checked without
// dealing a game.
//
//   node tools/sealitaire-card.mjs 8            build/card-8.png   (star suit)
//   node tools/sealitaire-card.mjs Q bubble     build/card-Q.png
//   node tools/sealitaire-card.mjs Pip fish     build/card-Pip.png
//
// `rive --screenshot` renders only rive.yaml's `main`, so this copies the
// project to a scratch dir with `main` pointed at the wanted artboard. The
// real project directory is never touched.
import { cpSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [what = 'A', suit = 'star'] = process.argv.slice(2);
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const artboard = RANKS.includes(what.toUpperCase()) ? `Card ${what.toUpperCase()}` : what;
const src = join(process.cwd(), 'rive/sealitaire');
const dir = mkdtempSync(join(tmpdir(), 'sealitaire-card-'));
try {
    cpSync(src, dir, { recursive: true, filter: (p) => !p.includes('/build') });
    writeFileSync(join(dir, 'rive.yaml'), `name: sealitaire\nmain: ${artboard}\n`);
    const out = join(dir, 'shot.png');
    const data = ['fish', 'star', 'bubble', 'shell'].flatMap((s) => [`--data=${s}=${s === suit ? 1 : 0}`]);
    // The ink too, or every suit prints in the instance's default red and a
    // black suit's mark is a lie in the only picture anyone checks it in.
    // Same two colours as table.luau's RED / BLACK, and the same isRed rule:
    // fish and star are the red suits.
    data.push(`--data=ink=${['fish', 'star'].includes(suit) ? 'FFF03E30' : 'FF080A0E'}`);
    execFileSync(join(process.env.HOME, '.rive/bin/rive'),
        [dir, `--screenshot=${out}`, '--advance=5', `--data=rank=${what.toUpperCase()}`, ...data], { stdio: 'inherit' });
    const dest = join(src, 'build', `card-${what.replace(/\s+/g, '')}.png`);
    copyFileSync(out, dest);
    console.log(`wrote ${dest}`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
