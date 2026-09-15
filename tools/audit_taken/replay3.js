"use strict";
/* 模拟 worker:全帧(tracker.update) + 快扫(fastPicks) 交错;输出三种"引擎眼里已拿走":tracker-only / 旧 fastPicks 规则 / 新规则(F1+F2) */
const fs=require("fs");
const APP="/home/ec2-user/work/game/ad-draft/app";
const E=require(APP+"/test/_env.js"); E.init();
const R=require(APP+"/recog.js"), T=require(APP+"/trace.js");
const FULL_ORDER=[0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9];
const file=process.argv[2];
const {head,frames,scans}=T.read(file);
const ev=frames.concat(scans).sort((a,b)=>a.ms-b.ms||(a.t==="s"?-1:1));
const order=head.pool.skills.map(s=>s.key).concat(head.pool.heroCards.map(h=>"hero:"+h.hero));
const t=T.restore(head); t.fullOrder=FULL_ORDER; t.orderSeat=n=>{const x=FULL_ORDER[Math.max(0,Math.min(n,FULL_ORDER.length-1))];return [x<5?"L":"R",x%5];};
let fastPrev=null; const fpOld=new Map(), fpNew=new Map(); const out=[]; let now=0; let lastRaw={};
const rawOf=k=>k.startsWith("hero:")?((t.pool.heroBoxes.find(h=>"hero:"+h.hero===k)||{}).state):(lastRaw[k]);
for (const e of ev) { now=e.ms;
  if (e.t==="s") { const dark=new Set(e.d.map(i=>order[i]).filter(Boolean));
    if (!fastPrev) { fastPrev=dark; continue; }
    const added=[...dark].filter(k=>!fastPrev.has(k)), gone=[...fastPrev].filter(k=>!dark.has(k)); fastPrev=dark;
    if (added.length===1 && !gone.length) { const k=added[0]; if (!t.flaky[k] && t.curSeat) { fpOld.set(k,{t:now}); fpNew.set(k,{t:now,n:0}); } }
    continue; }
  const src=new T.Frame(e,{poolKeys:head.poolKeys});
  R.setSource(src); t.cursor=e.cursor||null; let S; try { S=t.update(null); } finally { R.setSource(null); }
  lastRaw=t.prev.rawState||{};
  const base=new Set(S.skills.filter(x=>x.taken).map(x=>x.key).concat(S.taken_heroes.map(h=>"hero:"+h)));
  // F2: 疑似(不当落子)且会闪, 但已连续暗 >=12 帧 → 也算拿走
  const f2=new Set(base); for (const k of Object.keys(t.suspect||{})) { const ft=(t.firstT||{})[k]; if (ft!=null && ft>(t.lockFrame||1) && (t.darkRun[k]||0)>=12) f2.add(k); }
  const old=new Set(base), nw=new Set(f2);
  for (const [k,o] of [...fpOld]) { const conf=base.has(k); if (conf || now-o.t>6000 || ((t.brightRun[k]||0)>=1 && !(t.darkRun[k]>0))) { fpOld.delete(k); continue; } old.add(k); }
  for (const [k,o] of [...fpNew]) { const conf=nw.has(k); if (rawOf(k)==="N") o.n++; if (conf || now-o.t>20000 || o.n>=2) { fpNew.delete(k); continue; } nw.add(k); }
  out.push({ms:now,f:e.f,base:[...base],old:[...old],nw:[...nw]}); }
fs.writeFileSync(file+".replay3.json",JSON.stringify(out));
console.log(file.split("/").slice(-2).join("/"),"frames",out.length);
