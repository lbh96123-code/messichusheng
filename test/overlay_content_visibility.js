"use strict";
const assert=require("assert/strict"),fs=require("fs"),path=require("path");
require("../frames.js");
const code=fs.readFileSync(path.resolve(__dirname,"../overlay.html"),"utf8").split("<script>")[1].split("</script>")[0];
let texts=[];const handlers={},els={};
const canvas=new Proxy({clearRect:()=>texts=[],measureText:()=>({width:100}),fillText:t=>texts.push(t)},{get:(o,k)=>o[k]||(()=>{})});
const doc={getElementById:id=>id==="c"?{getContext:()=>canvas}:(els[id]||={style:{},textContent:""})};
new Function("document","ad","addEventListener","innerWidth","innerHeight","setTimeout","clearTimeout","requestAnimationFrame","setInterval",code)(
  doc,{on:(ch,f)=>handlers[ch]=f},()=>{},2560,1296,()=>1,()=>{},()=>{},()=>{});
const state={phase:"active",current:{side:"R",idx:4},me:{side:"R",idx:4},
  playerScores:[{box:[0,100,120,176],total:7,skillCount:3,heroKnown:true}]};
const advice={side:"R",seat:9,base:.5,rows:[{name:"锚击",p:.6,d:.1,box:[100,100,50,50]}]};
const cards=()=>texts.includes("组合明细"),recommendation=()=>texts.some(t=>t.includes("推荐:"));
handlers.cfg({scale:1,phase:"active",hidden:false});handlers.state(state);
assert(!cards(),"no recommendation yet: no independent score cards");
handlers.advice(advice);assert(cards()&&recommendation());
handlers.computing({});assert(cards()&&recommendation(),"keep both while refining a displayed recommendation");
handlers.clear();assert(!cards()&&!recommendation(),"clear must hide cards together with recommendation");
handlers.state(state);assert(!cards(),"late state cannot revive cards after clear");
handlers.advice(advice);assert(cards()&&recommendation(),"fresh recommendation restores both");
for(const stage of ["review","strategy","full"]) {
  handlers.state({...state,draftStage:stage,advicePaused:true,notice:"复核或选技结束"});
  assert(!cards()&&!recommendation(),stage+": no cards while recommendation is paused");
  handlers.advice(advice);assert(!cards()&&!recommendation(),stage+": ignore late advice");
  handlers.state({...state,draftStage:"drafting",advicePaused:false});assert(!cards(),"wait for fresh advice");
  handlers.advice(advice);assert(cards()&&recommendation());
}
handlers.state({phase:"idle",idle:true});assert(!cards()&&!recommendation());
handlers.advice(advice);handlers.computing({});
handlers.state(state);assert(!cards(),"new draft cannot reuse old-match advice");
handlers.advice(advice);assert(cards()&&recommendation());
handlers.cfg({scale:1,phase:"active",hidden:true});assert(!cards()&&!recommendation());
handlers.cfg({scale:1,phase:"active",hidden:false});assert(cards()&&recommendation());
handlers.cfg({scale:1,phase:"active",hidden:false,showPlayerScores:false});assert(!cards()&&recommendation(),"score preference remains optional");
handlers.cfg({scale:1,phase:"idle",hidden:false});assert(!cards()&&!recommendation());
console.log("PASS unified cards/advice visibility: pending, computing, clear, review/strategy/full, late messages, recovery, next draft, F6 and score preference");
