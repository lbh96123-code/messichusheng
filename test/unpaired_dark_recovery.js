"use strict";
// Actual observation/debounce path: a long dark streak is not permanent proof
// for a skill that was never found on any player's panel.
const assert=require("assert/strict"),R=require("./_env").init();
const key="axe_berserkers_call";
function fixture(paired=false,hero=false,record=null){
  const tr=new R.Tracker(),skill=record?.key||key,cell=record?.cell||0,k=hero?"hero:npc_dota_hero_axe":skill;
  tr.pool={skills:hero?[]:[{key:skill,cell}],heroBoxes:hero?[{hero:"npc_dota_hero_axe",cell}]:[],align:{}};
  tr.refB={[cell]:record?.refMean||100};tr.refS={[cell]:record?.refSat||.8};tr.firstT={[k]:10};tr.lockFrame=1;
  tr.stable[k]=true;tr.darkRun[k]=record?.darkRun||18;tr.frameNo=30;tr.allowBulk=0;
  if(paired)tr.owner[key]=["L",0];
  let stats=record?.stats||{mean:120,max:180,sat:.8};
  const panels=Array.from({length:10},(_,i)=>({side:i<5?"L":"R",idx:i%5,borderBright:i===0?100:10,selfRim:0}));
  const src={boxes:()=>({[cell]:[100,100,64,64]}),cellStats:()=>stats,ico:()=>null,icoH:()=>null,panels:()=>panels};
  const step=()=>{tr.frameNo++;R.setSource(src);try{return tr.observe(null);}finally{R.setSource(null);}};
  return {tr,k,step,stats(v){stats=v;}};
}
const f=fixture();
for(let i=0;i<5;i++){const ob=f.step();assert.equal(ob.rawState[key],"N");assert(ob.pending,"recovery vote requests full observations");assert(ob.taken[key],"a short bright flash must not resurrect an unavailable skill");}
assert.equal(f.step().taken[key],false,"six clear bright observations must retract an unpaired false pick, even after 18 dark frames");
assert(!f.tr.solidDark(key));
for(const row of require("./fixtures/oct15_unpaired_dark.json").cells){
  const real=fixture(false,false,row);
  for(let i=0;i<5;i++){const ob=real.step();assert.equal(ob.rawState[row.key],"N");assert(ob.taken[row.key]);}
  assert(!real.step().taken[row.key],row.key+": historical bright measurements can retract an unpaired lock");
}
const paired=fixture(true);for(let i=0;i<20;i++)assert(paired.step().taken[key],"a confirmed panel pick must survive game card re-illumination");
const h=fixture(false,true);for(let i=0;i<20;i++)assert(h.step().takenHeroes.includes("npc_dota_hero_axe"),"hero anti-retraction behavior unchanged");
const pairing=fixture();for(let i=0;i<5;i++)pairing.step();pairing.tr.owner[key]=["R",4];
for(let i=0;i<10;i++)assert(pairing.step().taken[key],"panel confirmation during recovery protects the genuine pick");
const covered=fixture();for(let i=0;i<5;i++)covered.step();
covered.stats({mean:50,max:90,sat:.8});covered.tr.refMaxAll=0;
for(let i=0;i<10;i++){const ob=covered.step();assert.equal(ob.rawState[key],"O");assert(ob.taken[key],"occluded observations do not confirm retraction");}
covered.stats({mean:120,max:180,sat:.8});assert(!covered.step().taken[key]);
const reset=fixture();for(let i=0;i<5;i++)reset.step();
// A genuinely dark frame interrupts bright confirmation. Keep scene brightness
// stable with a matching low reference, so the unrelated off-screen gate is idle.
reset.tr.refMaxAll=0;reset.tr.refB[0]=100;reset.stats({mean:10,max:20,sat:.1});assert(reset.step().taken[key]);
reset.tr.refMaxAll=0;reset.stats({mean:120,max:180,sat:.8});
for(let i=0;i<5;i++)assert(reset.step().taken[key]);assert(!reset.step().taken[key]);
console.log("PASS actual tracker: unpaired long-dark false picks retract after sustained brightness; short flashes, confirmed picks and heroes stay protected");
