"use strict";
/* 选走前后各特征的可分性:在一张"锁池"截图上建基准, 在同一局后面的截图上量每格特征, 真值来自日志里的 track 时间 */
const fs=require("fs"), path=require("path");
const APP="/home/ec2-user/work/game/ad-draft/app";
const E=require(APP+"/test/_env.js"); const R=E.init();
const META=JSON.parse(fs.readFileSync(APP+"/data/meta.json"));
const cn=k=>META.cn.hero[k]||META.cn.ab[k]||k;
const tsOf=f=>{const m=f.match(/(\d{8})_(\d{6})/); return m? m[1]+m[2] : null;};
const secs=s=>+s.slice(8,10)*3600+ +s.slice(10,12)*60+ +s.slice(12,14);
function truthFromLog(log, ts){ const first={}; const day=path.basename(log).match(/(\d{8})/)[1];
  /* 只取包含截图时刻的那一局(上一条"池子:"到下一条"池子:"之间)的落子时间 */
  const lines=fs.readFileSync(log,"utf8").split("\n"); let lo=-1, hi=1e9;
  for (const ln of lines) { const m=ln.match(/^\[(\d\d):(\d\d):(\d\d)\.\d+\] pool\s+池子:/); if(!m) continue; const t=+m[1]*3600+ +m[2]*60+ +m[3];
    if (t<=ts+1) lo=Math.max(lo,t); else hi=Math.min(hi,t); }
  for (const ln of lines) { const m=ln.match(/^\[(\d\d):(\d\d):(\d\d)\.\d+\] track\s+(技能|英雄) (\S+) → (\S+)/); if(!m) continue;
    const t=+m[1]*3600+ +m[2]*60+ +m[3]; if (t<lo-1||t>hi) continue; const name=m[5]; if (first[name]==null) first[name]=t; }
  return {first,day}; }
const rows=[];
function run(poolPng, measPng, log, tag){
  const ts0=secs(tsOf(measPng)); const {first,day}=truthFromLog(log,ts0);
  const img0=E.load(poolPng); R.rescale(img0.w,img0.h); const t=new R.Tracker(); const q=t.reset(img0);
  if (q.heroes!==12) { console.error("lock fail",poolPng,q.heroes); return; }
  const img=E.load(measPng); const ts=secs(tsOf(measPng));
  const items=t.pool.skills.map(s=>({key:s.key,cell:s.cell,box:s.box,hero:false})).concat(t.pool.heroBoxes.map(h=>({key:h.hero,cell:h.cell,box:h.box,hero:true})));
  const s1lock={}, hv={}; for (const it of items) { if (it.hero) { hv[it.key]=R.maskedVec(img0,it.box); s1lock[it.key]=1; } else s1lock[it.key]=(R.iconScore(img0,it.box,it.key) ?? -9); }
  for (const it of items) { const name=cn(it.key); const ft=first[name];
    let label=null; if (ft!=null) { if (ft<ts-3) label="taken"; else if (ft>ts+3) label="free"; }
    if (!label) continue;
    const st=R.cellStats(img,it.box), ref=t.refB[it.cell], refS=t.refS[it.cell]||0;
    const s1=it.hero?R.selfScore(R.maskedVec(img,it.box),hv[it.key]):(R.iconScore(img,it.box,it.key) ?? -9);
    const verdict=R.cellState(img,it.box,ref,refS,it.hero);
    rows.push({tag,res:img.w,cell:it.cell,name,hero:it.hero,label,r:st.mean/Math.max(ref,8),mr:st.max/Math.max(ref,8),sat:st.sat,refS,s1,s1lock:s1lock[it.key],verdict,mean:st.mean,max:st.max,ref,row:(R.LAYOUT().board[it.cell]||{}).row}); }
  /* 新判定:无样本 / 有同排样本(样本 = 这张图上已被亮度规则判 T 且真值为 taken 的格子, 模拟"已确认"的) */
  const mine=rows.filter(x=>x.tag===tag && x.res===img.w && !x.hero);
  for (const x of rows.filter(x=>x.tag===tag && x.res===img.w && x.hero && x.v2==null)) { const st={mean:x.mean,max:x.max,sat:x.sat}; x.v2=x.v3=R.heroVerdict(x.verdict,st,x.ref,x.s1); }
  const slabs={}; for (const x of mine) if (x.verdict==='T' && x.label==='taken') (slabs[x.row]=slabs[x.row]||[]).push({mean:x.mean,max:x.max});
  for (const x of mine) { if (x.v2!=null) continue; const icoR=x.s1lock>0.15? x.s1/Math.max(x.s1lock,0.2) : null; const st={mean:x.mean,max:x.max,sat:x.sat};
    x.v2=R.skillVerdict(x.verdict,st,x.ref,icoR,[]); x.v3=R.skillVerdict(x.verdict,st,x.ref,icoR,slabs[x.row]||[]); }
  console.error(tag, path.basename(measPng), "rows", rows.length);
}
const D="/tmp/claude-1000/-home-ec2-user-work/236a882f-30dc-47eb-9a6d-7b315584a127/scratchpad/logup";
for (const d of fs.readdirSync(D)) { const p=path.join(D,d); if(!fs.statSync(p).isDirectory()) continue;
  const pngs=fs.readdirSync(p).filter(f=>f.endsWith(".png")).sort(); const log=fs.readdirSync(p).find(f=>f.startsWith("ad_")); if(!log||!pngs.length) continue;
  const pool=pngs.find(f=>/_pool(_mid)?\.png$/.test(f)); if(!pool) continue;
  for (const m of pngs) run(path.join(p,pool),path.join(p,m),path.join(p,log),d.slice(0,6)); }
/* 2560 真机:realframes 里 log 与截图按时间配对 */
const RF=path.join(APP,"..","realframes"); const logs=[]; for (const dir of [RF,path.join(RF,"v116")]) for (const f of fs.readdirSync(dir)) if (f.startsWith("ad_")&&f.endsWith(".log")) logs.push(path.join(dir,f));
for (const dir of [RF,path.join(RF,"v116")]) { const pngs=fs.readdirSync(dir).filter(f=>/^snap_\d{8}_\d{6}_/.test(f)).sort();
  const pools=pngs.filter(f=>/_pool(_mid)?\.png$/.test(f));
  for (const m of pngs) { const ts=tsOf(m); const log=logs.filter(l=>{const t=path.basename(l).match(/ad_(\d{8}_\d{6})/); return t && t[1].replace("_","")<=ts && t[1].slice(0,8)===ts.slice(0,8);}).sort().pop(); if(!log) continue;
    const pool=pools.filter(f=>tsOf(f)<=ts && tsOf(f).slice(0,8)===ts.slice(0,8)).sort().pop(); if(!pool) continue;
    try { run(path.join(dir,pool),path.join(dir,m),log,"2560"); } catch(e){ console.error("ERR",m,e.message); } } }
fs.writeFileSync(D+"/feat.json",JSON.stringify(rows)); console.log("rows",rows.length);
