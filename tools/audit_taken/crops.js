"use strict";
const fs=require("fs"),path=require("path"),{PNG}=require("/home/ec2-user/work/game/ad-draft/app/node_modules/pngjs");
const E=require("/home/ec2-user/work/game/ad-draft/app/test/_env.js"); const R=E.init();
const D="/tmp/claude-1000/-home-ec2-user-work/236a882f-30dc-47eb-9a6d-7b315584a127/scratchpad/logup/";
const META=JSON.parse(fs.readFileSync("/home/ec2-user/work/game/ad-draft/app/data/meta.json")); const cn=k=>META.cn.ab[k]||k;
const want=JSON.parse(process.argv[2]);   // [{dir,pool,meas,names:[...]}]
const S=3, tiles=[];
for (const w of want) { const img0=E.load(D+w.dir+"/"+w.pool); R.rescale(img0.w,img0.h); const t=new R.Tracker(); t.reset(img0); const img=E.load(D+w.dir+"/"+w.meas);
  for (const r of t.pool.skills) { if (!w.names.includes(cn(r.key))) continue; const b=r.box; const tile={w:b[2],h:b[3],px:[]};
    for (let y=0;y<b[3];y++) for (let x=0;x<b[2];x++) { const p=((b[1]+y)*img.w+b[0]+x)*4; tile.px.push(img.data[p],img.data[p+1],img.data[p+2]); }
    const p0=[]; for (let y=0;y<b[3];y++) for (let x=0;x<b[2];x++) { const p=((b[1]+y)*img0.w+b[0]+x)*4; p0.push(img0.data[p],img0.data[p+1],img0.data[p+2]); }
    tiles.push({tile,ref:{w:b[2],h:b[3],px:p0},label:w.dir.slice(0,6)+" "+cn(r.key)}); } }
const TW=70*S, TH=70*S; const cols=4; const rows=Math.ceil(tiles.length/cols);
const out=new PNG({width:cols*TW*2,height:rows*TH}); out.data.fill(40);
tiles.forEach((tl,i)=>{ const cx=(i%cols)*TW*2, cy=Math.floor(i/cols)*TH;
  for (const [k,src] of [[0,tl.ref],[1,tl.tile]]) for (let y=0;y<src.h*S;y++) for (let x=0;x<src.w*S;x++) { const q=((Math.floor(y/S))*src.w+Math.floor(x/S))*3; const o=((cy+y)*out.width+cx+k*TW+x)*4; out.data[o]=src.px[q]; out.data[o+1]=src.px[q+1]; out.data[o+2]=src.px[q+2]; out.data[o+3]=255; } });
fs.writeFileSync(D+"crops.png",PNG.sync.write(out)); console.log(tiles.map((t,i)=>i+":"+t.label).join(" | "));
