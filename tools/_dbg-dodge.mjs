import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
console.warn = () => {};
const scene = new THREE.Scene();
const dt = 1/60, MID = -20;
function seeded(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let x=Math.imul(a^(a>>>15),1|a);x=(x+Math.imul(x^(x>>>7),61|x))^x;return((x^(x>>>14))>>>0)/4294967296;};}
const type = process.argv[2] ?? 'bossShark';
const c0 = CONFIG.enemies[type].lunge; c0.patterns = { pass: 1 };
const dodgeFor = c0.windup + c0.strikeTime + 0.4;
Math.random = seeded(Number(process.argv[3] ?? 1));
resetEnemies(scene);
const e = spawnNamed(scene, type, 0, { x: -12, y: MID }, { ignoreCaps: true });
const p = new THREE.Vector3(0, MID, 0);
let dodge = null, hold = { x: 0, y: MID }, last = null;
const reach = CONFIG.enemies[type].radius * 0.55 + 0.5;
for (let i = 0; i < 40*60; i++) {
  const t = i*dt;
  if (e.lungeStage === 'wind' && (dodge == null || t - dodge.t0 > dodgeFor + 2)) {
    const lx = hold.x - e.mesh.position.x, ly = hold.y - e.mesh.position.y, len = Math.hypot(lx, ly) || 1;
    let px = -ly/len, py = lx/len; const wantUp = hold.y < MID; if ((py > 0) !== wantUp) { px=-px; py=-py; }
    dodge = { t0: t, px, py }; console.log(`DODGE start t=${t.toFixed(2)} dir=(${px.toFixed(2)},${py.toFixed(2)}) shark=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}) seal=(${hold.x.toFixed(1)},${hold.y.toFixed(1)})`);
  }
  if (dodge && t - dodge.t0 <= dodgeFor) { const s = 9*dt; let nx = hold.x + dodge.px*s, ny = hold.y + dodge.py*s; if (ny > -3 || ny < -36) { dodge.py = -dodge.py; ny = hold.y + dodge.py*s; } if (nx > 38 || nx < -38) { dodge.px = -dodge.px; nx = hold.x + dodge.px*s; } hold = { x: nx, y: ny }; }
  p.set(hold.x, hold.y, 0);
  updateEnemies(dt, scene, p, ()=>{}, ()=>{});
  const d = Math.hypot(p.x-e.mesh.position.x, p.y-e.mesh.position.y);
  if (e.lungeStage !== last) { console.log(`${t.toFixed(2)} -> ${e.lungeStage} d=${d.toFixed(1)} h=${(e.heading*57.3).toFixed(0)} shark=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}) seal=(${p.x.toFixed(1)},${p.y.toFixed(1)}) radius=${e.radius.toFixed(2)}`); last = e.lungeStage; }
  if (e.lungeStage === 'strike' && d <= reach*1.6) console.log(`   HIT t=${t.toFixed(2)} d=${d.toFixed(2)} h=${(e.heading*57.3).toFixed(0)} shark=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}) seal=(${p.x.toFixed(1)},${p.y.toFixed(1)}) sp=${Math.hypot(e.vx,e.vy).toFixed(1)}`);
}
