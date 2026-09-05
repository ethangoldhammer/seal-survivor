import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
console.warn = () => {};
const scene = new THREE.Scene();
const dt = 1/60, MID = -20;
function seeded(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let x=Math.imul(a^(a>>>15),1|a);x=(x+Math.imul(x^(x>>>7),61|x))^x;return((x^(x>>>14))>>>0)/4294967296;};}
const type = process.argv[2] ?? 'shark';
const c0 = CONFIG.enemies[type].lunge; c0.patterns = { pass: 1 };
for (const seed of [1,2,3,4,5]) {
  Math.random = seeded(seed);
  resetEnemies(scene);
  const e = spawnNamed(scene, type, 0, { x: -12, y: MID }, { ignoreCaps: true });
  const p = new THREE.Vector3(0, MID, 0);
  let across = null, hold = { x: 0, y: MID }, last = null;
  const reach = e.radius * 0.55 + 0.5;
  let windD = null, windPos = null, hitFrames = 0, minD = Infinity;
  for (let i = 0; i < 40*60; i++) {
    const t = i*dt;
    const telling = e.lungeStage === 'wind' || e.lungeStage === 'strike' || e.lungeStage === 'reaim';
    if (telling) {
      const hx=Math.cos(e.heading), hy=Math.sin(e.heading); let px=-hy, py=hx;
      if (across == null) across = (hold.y + py*6 > -4 || hold.y + py*6 < -36) ? -1 : 1;
      px*=across; py*=across; let ny = hold.y + py*9*dt;
      if (ny > -3 || ny < -37) { across=-across; px=-px; py=-py; ny = hold.y + py*9*dt; }
      hold = { x: Math.max(-38, Math.min(38, hold.x + px*9*dt)), y: ny };
    }
    p.set(hold.x, hold.y, 0);
    updateEnemies(dt, scene, p, ()=>{}, ()=>{});
    const d = Math.hypot(p.x-e.mesh.position.x, p.y-e.mesh.position.y);
    if (e.lungeStage !== last) {
      if (e.lungeStage === 'wind') { windD = d; windPos = `shark=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}) seal=(${p.x.toFixed(1)},${p.y.toFixed(1)}) h=${(e.heading*57.3).toFixed(0)}`; hitFrames = 0; minD = Infinity; }
      if (last === 'strike' && e.lungeStage === 'rest') console.log(`seed ${seed} t=${t.toFixed(1)} windD=${windD?.toFixed(1)} ${windPos} -> closest ${minD.toFixed(2)} reach ${reach.toFixed(2)} hits=${hitFrames} sealEnd=(${p.x.toFixed(1)},${p.y.toFixed(1)}) sharkEnd=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)})`);
      last = e.lungeStage;
    }
    if (e.lungeStage === 'strike') { minD = Math.min(minD, d); if (d <= reach) hitFrames++; }
  }
}
