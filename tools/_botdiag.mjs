import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enableVersus } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { resetStrike } from '../path/src/systems/strike.js';
import { initParticles } from '../path/src/entities/particles.js';
import { versusState, ball, startVersus, updateVersus, updateVersusClock, sealAt, sealPos, versusHooks } from '../path/src/systems/versus.js';
import { setRosterSize, rosterSize, teamOfSeat } from '../path/src/systems/sealRoster.js';
import { botBrain } from '../path/src/systems/versusBot.js';
import { ballContactReach } from '../path/src/systems/ballShape.js';
import { spawnXpOrb } from '../path/src/entities/pickups.js';
const scene = new THREE.Scene(); const dt = 1/60;
console.warn = () => {}; console.info = () => {};
let seed = Number(process.argv[3] ?? 0x5ea1b0);
Math.random = () => { seed = (seed*1664525+1013904223)>>>0; return seed/4294967296; };
enableVersus(true); updateBounds(16/9);
initPlayer(scene); initParticles(scene); resetPlayer(); resetStrike();
CONFIG.celebrate.enabled = false;
if (process.env.TWEAK) new Function('CONFIG', process.env.TWEAK)(CONFIG);
const perSide = Number(process.argv[2] ?? 3); setRosterSize(perSide);
versusHooks.onKill = (e) => spawnXpOrb(scene, e.mesh.position, e.xp ?? e.def?.xp ?? 1, 0.8);
startVersus(scene);
const still = { move: new THREE.Vector2(0,0), aim: new THREE.Vector2(1,0), strikeHeld:false, strikeRelease:false };
const N = rosterSize();
const st=[...Array(N)].map(()=>({n:0,inR:0,commit:0,align:0,alignN:0,around:0,guard:0,toTarget:0,tN:0,rel:0,goodSide:0,sideN:0,waitFrames:0,waits:0}));
const waiting=[...Array(N)].fill(0);
for (let t=0;t<180;t+=dt) {
  updateVersus(dt*updateVersusClock(dt), null, still);
  for (let s=1;s<N;s++){
    const q=sealAt(s); const b=botBrain(s); if(!q||!b) continue; const r=st[s]; r.n++;
    const p=sealPos(q);
    if (b.around) r.around++;
    if (b.intent==='guard') r.guard++;
    if (q.input?.strikeRelease) r.rel++;
    if (b.commit) r.commit++;
    const dT = Math.hypot(b.target.x-p.x, b.target.y-p.y); r.toTarget+=dT; r.tN++;
    if (dT < 4 && b.role==='attack' && b.intent!=='support') { r.atSpot=(r.atSpot??0)+1; }
    const ax=ball.x-p.x, ay=ball.y-p.y; const dB=Math.hypot(ax,ay)||1;
    const tx=b.aimAt.x-p.x, ty=b.aimAt.y-p.y; const tl=Math.hypot(tx,ty)||1;
    const al=(ax*tx+ay*ty)/(dB*tl);
    // "good side": the seal is on the far side of the ball from its aim point
    if (b.role==='attack' && (b.intent==='chase'||b.intent==='strike'||b.intent==='guard')) {
      r.sideN++; if (al > 0.7) r.goodSide++;
    }
    const sA = ballContactReach(ball, Math.atan2(-ay,-ax)) + (CONFIG.versus.bot.strikeSlack ?? 4);
    if (dT < 4 && b.role==='attack' && b.intent!=='support') { r.alignAtSpot=(r.alignAtSpot??0)+al; r.aN=(r.aN??0)+1; }
    if (dB < sA) { r.inR++; r.align+=al; r.alignN++;
      if (!b.commit) { waiting[s]+=dt; } else { if (waiting[s]>0) { r.waitFrames+=waiting[s]; r.waits++; waiting[s]=0; } }
    } else waiting[s]=0;
  }
}
const sum=(f)=>st.slice(1).reduce((a,r)=>a+f(r),0), nn=st.slice(1).reduce((a,r)=>a+r.n,0)||1;
console.log(`${perSide}v${perSide} s${process.argv[3]??'d'}: strikes ${sum(r=>r.rel)}  goals ${versusState.scores[0]+versusState.scores[1]}  inRange ${(100*sum(r=>r.inR)/nn).toFixed(1)}%  commit ${(100*sum(r=>r.commit)/nn).toFixed(1)}%  alignInRange ${(sum(r=>r.align)/Math.max(1,sum(r=>r.alignN))).toFixed(2)}  goodSide ${(100*sum(r=>r.goodSide)/Math.max(1,sum(r=>r.sideN))).toFixed(0)}%  around ${(100*sum(r=>r.around)/nn).toFixed(0)}%  guard ${(100*sum(r=>r.guard)/nn).toFixed(0)}%  meanToTarget ${(sum(r=>r.toTarget)/Math.max(1,sum(r=>r.tN))).toFixed(1)}  atSpot ${(100*sum(r=>r.atSpot??0)/nn).toFixed(1)}%  alignAtSpot ${(sum(r=>r.alignAtSpot??0)/Math.max(1,sum(r=>r.aN??0))).toFixed(2)}  dither ${(sum(r=>r.waitFrames)/Math.max(1,sum(r=>r.waits))).toFixed(2)}s x${sum(r=>r.waits)}`);
