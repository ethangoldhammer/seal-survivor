#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run look:hive -- [out.html]
//
// A LOOK PAGE FOR THE HEX HIVE — every layout crossed with every style, built
// by the REAL ui.js and the REAL upgradeHive.js under jsdom and written out as
// a static page.
//
// Why not just run the game: any page served off a dev server can write
// path/src/imported-tuning.json, and an agent opening the game to take a
// screenshot is how a session's tuning gets flattened. This imports the same
// modules, takes the same CSS, and touches nothing.
//
// What it CANNOT show is the firing pulse — the animations need a live browser.
// The page includes a button that adds the class, so opening it in the Browser
// pane makes the four pulses watchable without the game running.
//
// Load order is the jsdom recipe: jsdom, then the vite loader, then the game
// modules. Run WITHOUT --import.
// ---------------------------------------------------------------------------

import { writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const args = process.argv.slice(2);
// The whole sheet is ~26MB of inlined icon PNGs, which is fine to open and too
// heavy to screenshot — the Browser pane comes back blank on it. `--stacks`
// emits only the stack sweep, which is one icon repeated and a few hundred KB.
const STACKS_ONLY = args.includes('--stacks') || args.includes('--closeups');
// Only the 150px close-ups. The Browser pane comes back BLANK on a page with a
// few hundred inlined icons in it — not an error, not a timeout, a black frame
// — so the sheet that gets screenshotted has to be the small one.
const CLOSEUPS_ONLY = args.includes('--closeups');
const OUT = args.find((a) => !a.startsWith('--')) ?? 'hive-look.html';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url') || spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');
globalThis.fetch = async () => ({ ok: false, status: 404 });
console.warn = () => {};

const { CONFIG } = await import('../path/src/config.js');
const hive = await import('../path/src/ui/upgradeHive.js');
const ui = await import('../path/src/ui/ui.js');
ui.initUI({ onStart() {}, onRestart() {}, onLevelChoice() {}, onResume() {}, onPauseRestart() {} });

// The CSS ui.js injected — taken rather than copied, so this page cannot drift
// from what the game actually renders.
const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');

// A build worth looking at: a real spread of families so every pulse and every
// tier is represented, and enough of it to see a layout under load.
const BUILDS = {
  'early — 5 picks': [
    ['shrimpRing', 'common'], ['club', 'uncommon'], ['seaGarlic', 'common'],
    ['rapidFire', 'common'], ['vitality', 'rare'],
  ],
  'mid — 12 picks': [
    ['shrimpRing', 'rare'], ['shrimpRing', 'common'], ['club', 'uncommon'],
    ['seaGarlic', 'common'], ['harp', 'epic'], ['dumbo', 'common'],
    ['beluga', 'uncommon'], ['maneater', 'legendary'], ['strikeShrapnel', 'rare'],
    ['oysterBlaster', 'common'], ['homingMissile', 'common'], ['laserEyes', 'uncommon'],
  ],
  // EVERY UPGRADE AT ONCE, generated rather than typed.
  //
  // The three builds above are the arrangements a player will actually be
  // looking at, and they are what the LAYOUTS are judged on. This one is a
  // different question: does the ART hold up as a set — can you tell forty
  // -seven marks apart, is any one of them the same shape as its neighbour, is
  // there a family that all reads as one blob. That question cannot be asked of
  // a twelve-pick sample, and it changes every time an icon is re-rendered, so
  // the list has to come off CONFIG rather than being a list someone maintains.
  //
  // Rarities are cycled so every tier's rim is on the page at once; they carry
  // no meaning here beyond that.
  'the whole roster — every upgrade': null,   // filled in below, needs CONFIG
  'late — 22 picks': [
    ['shrimpRing', 'legendary'], ['shrimpRing', 'common'], ['shrimpRing', 'common'],
    ['club', 'epic'], ['clubBoom', 'rare'], ['clubIce', 'common'], ['clubThrow', 'uncommon'],
    ['seaGarlic', 'rare'], ['harp', 'epic'], ['dumbo', 'common'], ['beluga', 'uncommon'],
    ['octoGrab', 'rare'], ['bakalar', 'common'], ['orcaFamily', 'legendary'],
    ['maneater', 'epic'], ['ironLung', 'rare'], ['electricEel', 'common'],
    ['seagullBomb', 'uncommon'], ['sealTeam', 'rare'], ['scallopSquirter', 'common'],
    ['calamari', 'uncommon'], ['oysterBlaster', 'common'],
  ],
};

const TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
BUILDS['the whole roster — every upgrade'] = CONFIG.upgrades
  .filter((u) => u.enabled !== false)
  .map((u, i) => [u.id, TIERS[i % TIERS.length]]);

// THE LAYERING SHOT. A hive at a late-run size with the level-up menu over the
// top of it — the one arrangement that shows whether the z-order is right, and
// the arrangement that was wrong until the ladder was made explicit.
let layerShot = '';
{
  hive.setHiveLayout('cluster');
  hive.setHiveStyle('ink');
  hive.setHiveUpgrades(Object.values(BUILDS)[2].map(([id, rarity]) => ({ id, rarity })));
  const menu = document.getElementById('svLevelUpMenu');
  menu.classList.remove('sv-hidden');
  layerShot = `${document.querySelector('.sv-hive').outerHTML}
    <div class="sv-center" style="position:absolute;inset:0">
      <div class="sv-menu"><div class="sv-title">Level up</div>
      <div class="sv-sub">the menu has to win — the hive is a readout, not a prompt</div></div>
    </div>`;
  menu.classList.add('sv-hidden');
}

// THE REFERENCE SHEET: every tile with the card's name under it.
//
// The roster hive answers "do these read as a set". It cannot answer "which one
// is Big Willy Style", because a hive is deliberately just marks — and that is
// the question you have while you are deciding whether a mark is the right one.
// So the same tiles are also laid out flat and labelled, built by the real
// buildTile through setHiveUpgrades so what is captioned is exactly what the
// hive shows, not a second rendering of the same data.
const roster = [];
{
  hive.setHiveLayout('rows');
  hive.setHiveStyle('ink');
  hive.setHiveUpgrades(BUILDS['the whole roster — every upgrade']
    .map(([id, rarity]) => ({ id, rarity })));
  for (const tile of document.querySelectorAll('.sv-hive-tile')) {
    const def = CONFIG.upgrades.find((u) => u.id === tile.dataset.upgrade);
    roster.push({
      html: tile.outerHTML,
      id: tile.dataset.upgrade,
      name: def?.name ?? tile.dataset.upgrade,
      // Named so a monogram on this sheet reads as "nothing was made for this
      // one" rather than as a render that came out looking like two letters.
      mark: tile.querySelector('.sv-hive-icon') ? 'icon' : 'monogram',
    });
  }
}

// THE STACK SHEET — the same tile at every depth, under every treatment.
//
// A stack used to be a digit in the corner of one hexagon, which is the least
// readable thing in the readout and also the fact a build is mostly made OF.
// These are the four answers, and they are on one sheet because the question
// only has an answer in comparison: each of them looks fine alone.
//
// The counts run past what the layers draw on purpose. `maxLayers` caps the
// pile so a nine-stack does not become a bar chart, and the last two columns
// are where that cap has to still read as "deeper than the one before it".
const STACK_VARIANTS = [
  ['pip', 'pip — no pile, the number alone (what this replaced)', { mode: 'pip' }],
  ['slab', 'slab — hexagons behind, straight down, base pinned to the cell', { mode: 'slab', rise: true }],
  ['deck', 'deck — the same pile drifting sideways as it deepens', { mode: 'deck', rise: true }],
  ['riser', 'riser — one extruded body; the height IS the count', { mode: 'riser', rise: true }],
  ['sink', 'slab, rise off — the pile builds DOWN from the cell instead', { mode: 'slab', rise: false }],
];
const STACK_COUNTS = [1, 2, 3, 4, 6, 9];

const applyStack = (over) => {
  CONFIG.upgradeHive.stack = { ...CONFIG.upgradeHive.stack, ...over };
  hive.setHiveStack(CONFIG.upgradeHive.stack.mode);
};

const stackSweep = [];
const stackBuilds = [];
const stackCloseups = [];
{
  hive.setHiveLayout('cluster');
  hive.setHiveStyle('ink');
  // A build whose stacks are the point: three abilities carried deep, the rest
  // singles, which is what a real late run looks like and what the piles have
  // to stay legible inside.
  const stacked = [
    ...Array(6).fill(['shrimpRing', 'legendary']),
    ...Array(4).fill(['club', 'epic']),
    ...Array(3).fill(['seaGarlic', 'rare']),
    ['harp', 'epic'], ['dumbo', 'common'], ['beluga', 'uncommon'],
    ['octoGrab', 'rare'], ['orcaFamily', 'legendary'], ['maneater', 'epic'],
    ['laserEyes', 'uncommon'], ['electricEel', 'common'], ['ironLung', 'rare'],
  ].map(([id, rarity]) => ({ id, rarity }));

  for (const [key, label, over] of STACK_VARIANTS) {
    applyStack(over);
    const row = [];
    for (const count of STACK_COUNTS) {
      hive.setHiveUpgrades(Array(count).fill({ id: 'shrimpRing', rarity: 'epic' }));
      const node = document.querySelector('.sv-hive');
      row.push({ count, html: node.outerHTML });
    }
    stackSweep.push({ key, label, row });

    hive.setHiveUpgrades(stacked);
    const node = document.querySelector('.sv-hive');
    stackBuilds.push({
      key,
      html: node.outerHTML,
      size: `${Math.round(parseFloat(node.querySelector('.sv-hive-host').style.width))}`
          + `x${Math.round(parseFloat(node.querySelector('.sv-hive-host').style.height))}`,
    });
  }
  // THE CLOSE-UP — A MAGNIFICATION, NOT A BIGGER TILE.
  //
  // Every judgement about the STROKE is a judgement about two or three pixels,
  // and a 52px tile on a screen cannot answer whether a plate is outlined all
  // the way round or only along its bottom flat. Turning `size` up does not
  // answer it either: `step` is in px, so a 400px hexagon with a 7px pile under
  // it is a DIFFERENT PICTURE — the plates go from a third of the tile to a
  // sliver, and the thing being judged is not the thing that ships.
  //
  // So the shipped tile is rendered at its shipped size and the whole subtree
  // is scaled with a transform. Backgrounds and clip paths re-rasterise at the
  // new scale, so what this shows is the real geometry, magnified.
  for (const [key, , over] of STACK_VARIANTS) {
    applyStack(over);
    for (const count of [2, 3, 5]) {
      hive.setHiveUpgrades(Array(count).fill({ id: 'shrimpRing', rarity: 'epic' }));
      stackCloseups.push({ key, count, html: document.querySelector('.sv-hive').outerHTML });
    }
  }

  // Back to the shipped values, so every other sample on this page is the game.
  applyStack({ mode: 'slab', rise: true });
}

const shots = [];
for (const [buildName, picks] of (STACKS_ONLY ? [] : Object.entries(BUILDS))) {
  const list = picks.map(([id, rarity]) => ({ id, rarity }));
  for (const layout of ['cluster', 'rows', 'arc']) {
    for (const style of ['ink', 'rarity', 'art']) {
      hive.setHiveLayout(layout);
      hive.setHiveStyle(style);
      hive.setHiveUpgrades(list);
      const node = document.querySelector('.sv-hive');
      shots.push({
        build: buildName, layout, style,
        html: node.outerHTML,
        size: `${Math.round(parseFloat(node.querySelector('.sv-hive-host').style.width))}` +
              `x${Math.round(parseFloat(node.querySelector('.sv-hive-host').style.height))}`,
      });
    }
  }
}

// The hive is `position: fixed` in the game. Here each sample is boxed, so it
// is un-fixed for the page only — the tiles inside keep every rule that matters.
const page = `<!doctype html>
<meta charset="utf-8">
<title>hex hive — layouts and styles</title>
<style>
${css}
  body { margin: 0; background: #071119; color: #cfe4ee;
    font: 12px ui-monospace, monospace; padding: 20px; }
  h1 { font: 600 15px system-ui; letter-spacing: .1em; text-transform: uppercase;
    color: #8fc0d6; margin: 0 0 4px; }
  h2 { font: 600 12px system-ui; letter-spacing: .1em; text-transform: uppercase;
    color: #7fa8bb; margin: 26px 0 10px; border-top: 1px solid #163040; padding-top: 12px; }
  .grid { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .cell { background: linear-gradient(170deg, #0e2a3a, #061119); border: 1px solid #163040;
    padding: 10px; border-radius: 4px; }
  .cap { font-size: 10px; color: #6f97aa; margin-bottom: 8px; letter-spacing: .06em; }
  /* un-fix for the sheet only */
  .cell .sv-hive { position: relative !important; left: auto !important; right: auto !important;
    top: auto !important; bottom: auto !important; }
  button { background: #17455c; color: #dff0f8; border: 1px solid #2b6d8d;
    font: 600 11px system-ui; padding: 6px 12px; border-radius: 3px; cursor: pointer; }
  /* the labelled reference sheet */
  .ref { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px 4px; }
  .ref .r { text-align: center; }
  .ref .r .sv-hive-tile { position: relative !important; left: auto !important; top: auto !important;
    margin: 0 auto; }
  .ref .n { font-size: 9px; color: #86adbf; line-height: 1.25; margin-top: 3px;
    overflow-wrap: anywhere; }
  .ref .r[data-mark="monogram"] .n { color: #d8a05a; }
  /* the stack sweep: every cell the same box, so height differences are the
     only thing moving between them */
  .stackcell { width: 96px; height: 118px; display: flex; flex-direction: column; }
  .stackcell .sv-hive { align-self: center; margin-top: auto; }
  /* the close-up: the shipped tile, magnified — see the note in the generator */
  .zoomcell { width: 250px; height: 270px; overflow: hidden; }
  .zoom { transform: scale(3.6); transform-origin: 0 0; width: 70px; }
</style>
<h1>Hex hive &mdash; ${STACKS_ONLY ? 'how a stack grows' : 'every layout against every style'}</h1>
${STACKS_ONLY ? '' : `<h2>the layer order</h2>
<div class="cap">A 22-pick hive with a menu over it. The hive is z-index 1, menus are 4, toasts 6 &mdash; it used to be 3 against menus with no z-index at all, so it painted on top of the level-up cards.</div>
<div class="grid"><div class="cell" style="position:relative;width:520px;height:330px;overflow:hidden">${layerShot}</div></div>
<div class="cap">Built by the real ui.js and upgradeHive.js. Every mark is a baked PNG from the icon pipeline &mdash; a photograph of the asset the ability spawns, or a composed gameplay moment for the ones that spawn nothing. Letters are the fallback for an upgrade with no icon yet.</div>
<p><button onclick="fireAll()">fire everything &mdash; watch the four pulses</button></p>`}
<h2>stacks &mdash; a second pick of the same card</h2>
${CLOSEUPS_ONLY ? '' : `<div class="cap">One Shrimp Ring tile at 1, 2, 3, 4, 6 and 9 picks, under each treatment. The pile is capped at ${CONFIG.upgradeHive.stack.maxLayers} layers and each layer adds ${CONFIG.upgradeHive.stack.falloff} of the one under it &mdash; so the last two columns are where a cap has to still read as deeper.</div>
${stackSweep.map((v) => `
<div class="cap" style="margin-top:14px;color:#9fd0e4">${v.label}</div>
<div class="grid">
${v.row.map((c) => `  <div class="cell stackcell"><div class="cap">&times;${c.count}</div>${c.html}</div>`).join('')}
</div>`).join('')}
`}
<div class="cap" style="margin-top:22px">Close-up &mdash; the SHIPPED 52px tile magnified 3.6&times;, not a bigger tile: <code>step</code> is in px, so a 400px hexagon with a 7px pile under it is a different picture from the one that ships. Whether a plate is outlined all the way round or only along its bottom flat is a question about two pixels.</div>
<div class="grid">
${stackCloseups.map((c) => `  <div class="cell zoomcell"><div class="cap">${c.key} &middot; &times;${c.count}</div><div class="zoom">${c.html}</div></div>`).join('')}
</div>
${CLOSEUPS_ONLY ? '' : `<div class="cap" style="margin-top:20px">The same treatments under a real late build &mdash; 6 Shrimp Rings, 4 Clubs, 3 Garlic and nine singles, cluster/ink. This is the one that decides it: a pile that reads beautifully alone can turn a packed corner to mush.</div>
<div class="grid">
${stackBuilds.map((b) => `  <div class="cell"><div class="cap">${b.key} &middot; ${b.size}px</div>${b.html}</div>`).join('')}
</div>`}

${STACKS_ONLY ? '' : `<h2>every upgrade, named</h2>
<div class="cap">All ${roster.length} enabled upgrades, built by the real buildTile. ${roster.filter((r) => r.mark === 'icon').length} carry a rendered mark; ${roster.filter((r) => r.mark === 'monogram').length} fall back to a monogram &mdash; those are shown in amber, and each one is an icon nobody has made yet.</div>
<div class="ref">
${roster.map((r) => `  <div class="r" data-mark="${r.mark}">${r.html}<div class="n">${r.name}</div></div>`).join('\n')}
</div>`}

${Object.keys(BUILDS).map((b) => `
<h2>${b}</h2>
<div class="grid">
${shots.filter((s) => s.build === b).map((s) => `
  <div class="cell">
    <div class="cap">${s.layout} &middot; ${s.style} &middot; ${s.size}px</div>
    ${s.html}
  </div>`).join('')}
</div>`).join('')}
<script>
// Staggered, because the whole question is whether a corner full of tiles going
// off at once reads as information or as noise.
function fireAll() {
  const tiles = [...document.querySelectorAll('.sv-hive-tile')];
  tiles.forEach((t, i) => setTimeout(() => {
    t.classList.remove('sv-hive-firing');
    void t.offsetWidth;
    t.classList.add('sv-hive-firing');
  }, (i % 22) * 90));
}
setTimeout(fireAll, 400);
setInterval(fireAll, 4200);
</script>
`;

await writeFile(OUT, page);
console.log(`wrote ${OUT} — ${shots.length} samples, ${(Buffer.byteLength(page) / 1024).toFixed(0)}KB`);
