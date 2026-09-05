import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
console.warn = () => {};
const scene = new THREE.Scene();
const dt = 1/60, MID = -20;
function seeded(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let x=Math.imul(a^(a>>>15),1|a);x=(x+Math.imul(x^(x>>>7),61|x))^x;return((x^(x>>>14))>>>0)/4294967296;};}
const wrap=(a)=>{while(a>Math.PI)a-=2*Math.PI;while(a<-Math.PI)a+=2*Math.PI;return a;};
function trace(type, seconds, playerMove, every=30) {
  Math.random = seeded(1);
  resetEnemies(scene);
  const e = spawnNamed(scene, type, 0, { x: -12, y: MID }, { ignoreCaps: true });
  const p = new THREE.Vector3();
  const rows = [];
  for (let i = 0; i < seconds*60; i++) {
    const at = playerMove(i*dt, e); p.set(at.x, at.y, 0);
    updateEnemies(dt, scene, p, ()=>{}, ()=>{});
    const dx = p.x-e.mesh.position.x, dy = p.y-e.mesh.position.y;
    const d = Math.hypot(dx,dy);
    if (i % every === 0 || e.lungeStage==='wind' && rows[rows.length-1]?.stage!=='wind') rows.push({ t:(i*dt).toFixed(1), stage:e.lungeStage, d:d.toFixed(1), pitch:(Math.abs(Math.atan2(dy,Math.abs(dx)))*57.3).toFixed(0), off:(Math.abs(wrap(Math.atan2(dy,dx)-e.heading))*57.3).toFixed(0), h:(e.heading*57.3).toFixed(0), sp:Math.hypot(e.vx,e.vy).toFixed(1), so:e.standoffDist?.toFixed(1), x:e.mesh.position.x.toFixed(1), y:e.mesh.position.y.toFixed(1), crowd: e.crowdView?.inCrowd, feeding: e.feeding, turnT: e.__turnT?.toFixed(2) });
  }
  return rows;
}
console.log('--- bossShark, still seal');
console.table(trace('bossShark', 14, () => ({x:0,y:MID}), 60));
console.log('--- shark, dodging seal');
{
  let dodge = null; let hold = { x: 0, y: MID };
  const rows = trace('shark', 30, (t, e) => {
    const winding = e.lungeStage === 'wind';
    if (winding && (dodge == null || t - dodge.t0 > 3)) {
      const lx = hold.x - e.mesh.position.x, ly = hold.y - e.mesh.position.y; const len = Math.hypot(lx, ly) || 1;
      let px = -ly / len, py = lx / len; if (py < 0) { px = -px; py = -py; }
      dodge = { t0: t, from: { ...hold }, px, py };
    }
    if (!dodge) return hold;
    const d = Math.min(1.5, t - dodge.t0) * 9;
    hold = { x: dodge.from.x + dodge.px * d, y: Math.min(-3, dodge.from.y + dodge.py * d) };
    return hold;
  }, 15);
  console.table(rows.filter((r) => r.stage === 'wind' || r.stage === 'strike' || r.stage === 'reaim').slice(0, 40));
}
