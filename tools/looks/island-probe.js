// TEMPORARY scratch probe — the Blubberball HUD and stats page at real device
// metrics, with the Dynamic Island drawn to scale on top.
//
//   ?mode=hud|stats   which surface
//   ?sim=t,r,b,l      the insets a device would report (env() has no override
//                     that survives a hidden window, so the SHIPPED calc() is
//                     taken off the element and the tokens substituted — the
//                     rule measured is the rule that ships)
//   ?before=1         the rules as they were, for the comparison
import { previewVersusUi } from '../../path/src/systems/versus.js';
import { mountStatsCard } from '../../path/src/ui/statsCard.js';

const qs = new URLSearchParams(location.search);
const mode = qs.get('mode') || 'hud';
const before = qs.get('before') === '1';
const sim = (qs.get('sim') || '').split(',').map(Number);
const simmed = sim.length === 4 && sim.every(Number.isFinite);
const [T, R, B, L] = simmed ? sim : [0, 0, 0, 0];

function paintFurniture() {
  // The pill, where iOS draws it: 125 x 37 at the top centre upright, and
  // rotated onto the leading edge on its side.
  const pill = document.getElementById('pill');
  const portrait = innerHeight >= innerWidth;
  if (portrait && T > 0) {
    Object.assign(pill.style, { width: '125px', height: '37px', borderRadius: '19px',
      left: `${(innerWidth - 125) / 2}px`, top: '11px' });
  } else if (!portrait && L > 0) {
    Object.assign(pill.style, { width: '37px', height: '125px', borderRadius: '19px',
      left: '11px', top: `${(innerHeight - 125) / 2}px` });
  } else {
    pill.style.display = 'none';
  }
  // The shaded margins — what the device keeps.
  const bars = [
    [0, 0, '100%', `${T}px`], [0, `${innerHeight - B}px`, '100%', `${B}px`],
    [0, 0, `${L}px`, '100%'], [`${innerWidth - R}px`, 0, `${R}px`, '100%'],
  ];
  for (const [x, y, w, h] of bars) {
    if (parseFloat(w) <= 0 || parseFloat(h) <= 0) continue;
    const d = document.createElement('div');
    d.className = 'unsafe';
    Object.assign(d.style, { left: typeof x === 'string' ? x : `${x}px`, top: typeof y === 'string' ? y : `${y}px`, width: w, height: h });
    document.body.appendChild(d);
  }
  const label = document.getElementById('label');
  label.textContent = `${innerWidth}x${innerHeight} · ${mode} · ${before ? 'BEFORE' : 'AFTER'}`;
  Object.assign(label.style, { left: `${L + 8}px`, bottom: `${B + 6}px` });
}

// The shipped expressions with the device's numbers put into them.
const sub = (css) => css
  .replace(/env\(safe-area-inset-top,\s*0px\)/g, `${T}px`)
  .replace(/env\(safe-area-inset-right,\s*0px\)/g, `${R}px`)
  .replace(/env\(safe-area-inset-bottom,\s*0px\)/g, `${B}px`)
  .replace(/env\(safe-area-inset-left,\s*0px\)/g, `${L}px`);

function applyStrip() {
  const css = document.createElement('style');
  css.textContent = before
    // What shipped before: no insets anywhere, and the band is the whole glass.
    ? `.sv-versus-band { left: 0 !important; right: 0 !important; }
       .sv-versus-hud { top: 12px !important; }`
    : `.sv-versus-band { left: ${L}px !important; right: ${R}px !important; }
       .sv-versus-hud { top: calc(12px + ${T}px) !important; }`;
  document.head.appendChild(css);
}

async function run() {
  previewVersusUi('match HUD');
  applyStrip();
  const root = document.querySelector('.sv-versus');
  if (mode === 'stats') {
    const card = mountStatsCard({
      parent: root,
      data: {
        teams: [{ name: 'The Dudes', goals: 3, assists: 1, saves: 2, possession: 54 },
                { name: 'Seal Team Six', goals: 2, assists: 0, saves: 3, possession: 46 }],
        scores: [3, 2], colors: [0xff8844, 0x44aaff], accent: 0xffd166,
        seatsPerSide: 2, championName: 'The Dudes', draw: false,
        seats: [
          { name: 'Hank', goals: 2, assists: 0, saves: 1, possession: 30 },
          { name: 'Pip', goals: 1, assists: 1, saves: 1, possession: 24 },
          { name: 'Moss', goals: 1, assists: 0, saves: 2, possession: 25 },
          { name: 'Buoy', goals: 1, assists: 0, saves: 1, possession: 21 },
        ],
      },
    });
    // The play-again prompt UP — Rematch and Main Menu are the whole question.
    setTimeout(() => card?.setOver?.(true, 0), 900);
    for (const node of document.querySelectorAll('.sv-stats-card, .sv-stats-card canvas')) {
      node.style.cssText = before
        ? (node.classList.contains('sv-stats-card')
          ? 'position:absolute; inset:0; display:grid; place-items:center; pointer-events:auto; opacity:1;'
          : 'display:block; width:min(92vw, 900px); height:auto;')
        : sub(node.style.cssText);
    }
  }
  paintFurniture();
  await new Promise((r) => setTimeout(r, 1600));

  const hud = document.querySelector('.sv-versus-hud');
  const r = hud.getBoundingClientRect();
  const pill = { w: 125, h: 37, top: 11, cx: innerWidth / 2 };
  const hits = innerHeight >= innerWidth && T > 0
    && r.top < pill.top + pill.h && r.right > pill.cx - pill.w / 2 && r.left < pill.cx + pill.w / 2;
  const lines = [`strip  top ${r.top.toFixed(0)}  x ${r.left.toFixed(0)}..${r.right.toFixed(0)}`
    + `  ${hits ? 'UNDER THE ISLAND' : 'clear of the island'}`];
  const cv = document.querySelector('.sv-stats-card canvas');
  if (cv) {
    const c = cv.getBoundingClientRect();
    const inside = c.top >= T - 0.5 && c.bottom <= innerHeight - B + 0.5
      && c.left >= L - 0.5 && c.right <= innerWidth - R + 0.5;
    lines.push(`page   ${c.width.toFixed(0)}x${c.height.toFixed(0)}  y ${c.top.toFixed(0)}..${c.bottom.toFixed(0)}`
      + `  ${inside ? 'inside the safe area' : 'OVERFLOWS'}`);
  }
  document.getElementById('out').textContent = lines.join('\n');
  window.__report = lines;
}
run();
