"use strict";
const fs=require("fs");
const APP="/home/ec2-user/work/game/ad-draft/app";
const E=require(APP+"/test/_env.js"); E.init();
const R=require(APP+"/recog.js"), T=require(APP+"/trace.js");
const META=JSON.parse(fs.readFileSync(APP+"/data/meta.json"));
const FULL_ORDER=[0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9];
const [file,...names]=process.argv.slice(2);
const {head,frames}=T.read(file);
const keys=head.poolKeys.filter(k=>names.includes(R.cn(k))).concat(head.pool.heroCards.map(h=>"hero:"+h.hero).filter(k=>names.includes(R.cn(k.slice(5)))));
console.log("keys",keys);
const t=T.restore(head); t.fullOrder=FULL_ORDER; t.orderSeat=n=>{const x=FULL_ORDER[Math.max(0,Math.min(n,FULL_ORDER.length-1))];return [x<5?"L":"R",x%5];};
console.log("lockFrame",t.lockFrame);
const prevLine={};
for (const f of frames) { const src=new T.Frame(f,{poolKeys:head.poolKeys});
  R.setSource(src); t.cursor=f.cursor||null; let S; try { S=t.update(null); } finally { R.setSource(null); }
  for (const k of keys) { const isH=k.startsWith("hero:"); const raw=isH?(t.pool.heroBoxes.find(h=>"hero:"+h.hero===k)||{}).state:(t.prev.rawState||{})[k];
    const taken=isH?S.taken_heroes.includes(k.slice(5)):S.skills.some(x=>x.key===k&&x.taken);
    const line=`raw=${raw} stable=${!!t.stable[k]} dark=${t.darkRun[k]||0} bright=${t.brightRun[k]||0} firstT=${(t.firstT||{})[k]} flaky=${!!t.flaky[k]} hold=${!!(t.hold||{})[k]} pend=${(t.pend||{})[k]||0} susp=${!!(t.suspect||{})[k]} owner=${(t.owner[k]||[]).join("")} orphan=${!!(t.orphan||{})[k]} known=${t.known.has(k)} TAKEN=${taken} turn=${t.turn}`;
    if (line!==prevLine[k]) { console.log(`f${f.f} +${(f.ms/1000).toFixed(1)}s ${R.cn(k.replace("hero:",""))}: ${line}`); prevLine[k]=line; } }
  for (const [kind,k,q,how] of t.log) if (keys.includes(k)||keys.includes("hero:"+k)) console.log(`      log f${f.f} ${kind} ${R.cn(k)} ${q} ${how}`);
  t.log.length=0; }
