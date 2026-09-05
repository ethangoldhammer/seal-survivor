import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
console.warn = () => {};
const scene = new THREE.Scene();
const dt = 1/60, MID = -20;
function seeded(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let x=Math.imul(a^(a>>>15),1|a);x=(x+Math.imul(x^(x>>>7),61|x))^x;return((x^(x>>>14))>>>0)/4294967296;};}
const type = process.argv[2] ?? 'shark'; const seed = Number(process.argv[3] ?? 1);
const c0 = CONFIG.enemies[type].lunge; c0.patterns = { pass: 1 };
Math.random = seeded(seed);
resetEnemies(scene);
const e = spawnNamed(scene, type, 0, { x: -12, y: MID }, { ignoreCaps: true });
const p = new THREE.Vector3(0, MID, 0);
let juke = null, hold = { x: 0, y: MID }, last = null; const react = 0.12;
const reach = e.radius * 0.55 + 0.5;
for (let i = 0; i < 40*60; i++) {
  const t = i*dt;
  const running = e.lungeStage === 'strike';
  if (running && (juke == null || t - juke.t0 > c0.strikeTime + 3)) juke = { t0: t, px: 0, py: 0, armed: false };
  if (juke && !juke.armed && t - juke.t0 >= react) { const hx=Math.cos(e.heading), hy=Math.sin(e.heading); let px=-hy, py=hx; const far=c0.strikeTime*9+2; const endY=hold.y+py*far; if (endY > -4 || endY < -36) { px=-px; py=-py; } juke.px=px; juke.py=py; juke.armed=true; console.log(`JUKE t=${t.toFixed(2)} dir=(${px.toFixed(2)},${py.toFixed(2)}) h=${(e.heading*57.3).toFixed(0)} shark=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}) seal=(${hold.x.toFixed(1)},${hold.y.toFixed(1)})`); }
  if (juke?.armed && t - juke.t0 <= react + c0.strikeTime + 0.4) hold = { x: hold.x + juke.px*9*dt, y: Math.max(-37, Math.min(-3, hold.y + juke.py*9*dt)) };
  p.set(hold.x, hold.y, 0);
  updateEnemies(dt, scene, p, ()=>{}, ()=>{});
  const d = Math.hypot(p.x-e.mesh.position.x, p.y-e.mesh.position.y);
  if (e.lungeStage !== last) { console.log(`${t.toFixed(2)} -> ${e.lungeStage} d=${d.toFixed(1)} h=${(e.heading*57.3).toFixed(0)} shark=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}) seal=(${p.x.toFixed(1)},${p.y.toFixed(1)})`); last = e.lungeStage; }
  if (e.lungeStage === 'strike' && (i % 6 === 0 || d <= reach)) console.log(`   ${d <= reach ? 'HIT' : '   '} t=${t.toFixed(2)} d=${d.toFixed(2)} h=${(e.heading*57.3).toFixed(0)} shark=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}) seal=(${p.x.toFixed(1)},${p.y.toFixed(1)}) sp=${Math.hypot(e.vx,e.vy).toFixed(1)} reach=${reach.toFixed(2)}`);
}
