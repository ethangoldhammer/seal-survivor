import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
console.warn = () => {};
const scene = new THREE.Scene();
const dt = 1/60, MID = -20;
function seeded(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let x=Math.imul(a^(a>>>15),1|a);x=(x+Math.imul(x^(x>>>7),61|x))^x;return((x^(x>>>14))>>>0)/4294967296;};}
for (const [type, pat] of [['hammerhead', { double: 1 }], ['bossShark', { pass: 1 }]]) {
  CONFIG.enemies[type].lunge.patterns = pat;
  Math.random = seeded(1);
  resetEnemies(scene);
  const e = spawnNamed(scene, type, 0, { x: -12, y: MID }, { ignoreCaps: true });
  const p = new THREE.Vector3(0, MID, 0);
  let last = null; const out = [];
  for (let i = 0; i < 40*60; i++) {
    updateEnemies(dt, scene, p, ()=>{}, ()=>{});
    if (e.lungeStage !== last) { out.push(`${(i*dt).toFixed(2)} ${e.lungeStage} clock=${e.lungeClock?.toFixed(2)} step=${e.lungeStep} plan=${e.lungePlan?.map(s=>s.stage).join('>')} d=${Math.hypot(p.x-e.mesh.position.x,p.y-e.mesh.position.y).toFixed(1)} hunting=${e.hunting} chum=${!!e.chumTarget}`); last = e.lungeStage; }
  }
  console.log('---', type, JSON.stringify(pat)); console.log(out.join('\n'));
}
