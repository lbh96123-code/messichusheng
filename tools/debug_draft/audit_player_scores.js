"use strict";
// Recompute one captured roster through the actual scorer and versioned assets.
// Client versions come from logs; historical assets are the repository versions,
// not a claim that the unrecorded installed binaries were hash-verified.
const fs=require("fs"),path=require("path"),Module=require("module"),cp=require("child_process"),crypto=require("crypto");
const root=path.resolve(__dirname,"../.."),layout=require("../../data/layout_2560x1440.json");
const fast=require("../../engine/server/mcts_fast");
function source(ref,file){return ref?cp.execFileSync("git",["show",`${ref}:${file}`],{cwd:root,encoding:"utf8",maxBuffer:64*1024*1024}):fs.readFileSync(path.join(root,file),"utf8");}
function createScorer(ref){
  const files=["ad_data.js","ad_model.js","ad_trio.js","ad_score.js"];
  const assets=files.map(f=>source(ref,"engine/public/"+f));
  const fingerprint=crypto.createHash("sha256").update(JSON.stringify(assets)).digest("hex");
  const filename=path.join(root,"player_scores.js"),m=new Module(filename,module),realRequire=Module.createRequire(filename);
  m.filename=filename;m.paths=Module._nodeModulePaths(root);
  m.require=name=>name==="./engine/server/mcts_fast.js"?{...fast,loadModel(){
    const win={};for(const code of assets)new Function("window","atob",code)(win,s=>Buffer.from(s,"base64").toString("binary"));return win;
  }}:realRequire(name);
  m._compile(source(ref,"player_scores.js"),filename);
  return {score:m.exports.createPlayerScorer(),fingerprint};
}
const card=row=>({seat:row.side+(row.idx+1),total:row.total,display:row.total==null?null:(Math.round(row.total*100)/100).toFixed(2),parts:row.parts,pos:row.pos});
function audit(fixture,normalize=false){
  const cache=new Map();
  const evaluate=(ref,mode)=>{
    if(!cache.has(ref))cache.set(ref,createScorer(ref));
    const {score,fingerprint}=cache.get(ref);score.setShareMode(mode);
    return {ref:ref||"working",mode,fingerprint,rows:score(fixture.panels,layout).map(card)};
  };
  const clients=fixture.clients.map(c=>({client:c.client,version:c.version,
    ...evaluate(normalize?fixture.commonRef:c.scoreRef,normalize?fixture.commonMode:c.mode)}));
  const variants={};for(const ref of [...new Set(fixture.clients.map(c=>c.scoreRef))])
    for(const mode of ["expect","optimalBoth"])variants[ref+"/"+mode]=evaluate(ref,mode).rows;
  const display=rows=>JSON.stringify(rows.map(r=>[r.seat,r.display]));
  const differingSeats=clients[0].rows.filter((r,i)=>clients.some(c=>c.rows[i].display!==r.display)).map(r=>r.seat);
  return {normalize,equal:clients.every(c=>display(c.rows)===display(clients[0].rows)),differingSeats,clients,variants};
}
if(require.main===module){
  const file=process.argv.slice(2).find(x=>!x.startsWith("--"))||path.join(root,"test/fixtures/oct15_score_comparison.json");
  const result=audit(JSON.parse(fs.readFileSync(file)),process.argv.includes("--normalize"));
  console.log(JSON.stringify(result,null,2));
  if(process.argv.includes("--assert-equal")&&!result.equal)process.exitCode=1;
}
module.exports={audit,createScorer};
