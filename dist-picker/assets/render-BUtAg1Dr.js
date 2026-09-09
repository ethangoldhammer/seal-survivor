import"./GLTFLoader-CiexUnNn.js";import{m as l,s as c}from"./iconRender-CtZlBcj4.js";const d=e=>{document.getElementById("log").textContent+=`
`+e},r=l();document.body.appendChild(r.domElement);const s=new URLSearchParams(location.search).get("list")??"list.json";let o;try{const e=await fetch("/"+s);if(!e.ok)throw new Error(`${e.status} — ${s} is generated; run the tool that writes it`);o=await e.json()}catch(e){throw document.getElementById("log").textContent=`CANNOT LOAD /${s}

${e.message}

  upgrade icons:  node --import ./tools/vite-loader.mjs tools/upgrade-icons.mjs
                  then open render.html?list=icons.json
                  (or pick the angles by eye: picker.html)

  model atlas:    node --import ./tools/vite-loader.mjs tools/atlas-data.mjs --out <dir>
                  then copy <dir>/list.json next to this page`,e}window.__total=o.length;window.__done=0;window.__fails=[];document.getElementById("log").textContent=`rendering ${o.length} models`;let n=0;for(const e of o){const i=e.kind??"render";if(i!=="render"&&i!=="scene"){n++,window.__done++;continue}try{const{blob:t,log:a}=await c(r,e);await fetch("/shot/"+e.key+".png",{method:"POST",body:t}),d(a)}catch(t){window.__fails.push(e.key+": "+(t?.message??t)),d(`FAIL ${e.key}: ${t?.message??t}`)}window.__done++}window.__skipped=n;window.__finished=!0;d(`
DONE ${window.__done-n}/${o.length-n} rendered`+(n?`, ${n} not renders (drawn or none)`:"")+`, ${window.__fails.length} failed`);
