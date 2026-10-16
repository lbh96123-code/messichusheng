"use strict";
const assert=require("assert/strict"),R=require("./_env").init();
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1],pq=q=>q.join("");
const panels=Array.from({length:10},(_,i)=>({side:i<5?"L":"R",idx:i%5,filled:0}));
const heroes=Array.from({length:10},(_,i)=>"hero"+i);
function tracker(){
  const t=new R.Tracker();t.pool={poolHeroes:[...heroes,"extraHero"],skills:[{key:"waiting"}]};
  t.fullOrder=[0,5,1,6,2,7,3,8,4,9];t.pcInit=true;t.frameNo=20;t.known=new Set();t.pend={waiting:2};
  return t;
}
function ob(taken={},takenHeroes=[]){return {current:["L",0],panels,taken,takenHeroes,rawDark:0};}
let checks=0;
function check(name,fn){try{fn();checks++;}catch(e){e.message=name+": "+e.message;throw e;}}
check("pending cells stay unavailable without advancing completed progress",()=>{
  const t=tracker(),s=t.state(ob({waiting:true}));
  assert.equal(R.pickedCount(s),0);assert(s.skills[0].taken);assert.deepEqual(s.pendingKeys,["waiting"]);
  t.owner.waiting=["L",0];const paired=t.state(ob({waiting:true}));
  assert.equal(R.pickedCount(paired),1);assert.deepEqual(paired.pendingKeys,[]);
});
check("unknown panel slots count independently of pending candidates",()=>{
  const t=tracker();t.unknownBy=[["L",0]];
  const s=t.state(ob({waiting:true}));assert.equal(R.pickedCount(s),1);
  s.panels[0].skills.push({key:"waiting"});
  assert.equal(R.pickedCount(s),2,"fast-path panel confirmation wins over stale pending metadata");
});
check("legacy observations and real invalid counts are not capped",()=>{
  assert.equal(R.pickedCount(require("./fixtures/draft_overcount.json")),52);
  assert.equal(R.pickedCount({skills:[{key:"pending",taken:true}],pendingKeys:["pending"],taken_heroes:[]}),0);
});
const prev=process.env.AD_NONAME;process.env.AD_NONAME="1";
try{
  check("confirmed retraction removes a pending entry instead of leaving it indefinitely",()=>{
    const t=tracker();t.attribute(null,ob({waiting:false}),pq,same);
    assert(!t.pend.waiting);assert(!t.state(ob()).skills[0].taken);
  });
  check("short brightness debounce does not prematurely unblock a pending skill",()=>{
    const t=tracker();t.attribute(null,ob({waiting:true}),pq,same);
    assert.equal(t.pend.waiting,3);assert(t.state(ob()).skills[0].taken);assert.equal(R.pickedCount(t.state(ob())),0);
  });
  for(const midJoin of [false,true])check("ten occupied hero seats reject an eleventh dark card; midJoin="+midJoin,()=>{
    const t=tracker();t.pend={};t.joinedMidDraft=midJoin;t.nameHero={};
    heroes.forEach((h,i)=>{t.heroOf[h]=[panels[i].side,panels[i].idx];t.known.add("hero:"+h);if(i<9)t.nameHero[pq(t.heroOf[h])]=h;});
    const turn=t.turn=49;t.attribute(null,ob({},[...heroes,"extraHero"]),pq,same);
    assert.equal(Object.keys(t.heroOf).length,10);assert(!t.orphan["hero:extraHero"]);
    assert.equal(t.turn,turn);assert.equal(t.state(ob()).taken_heroes.length,10);
  });
  check("a rejected card is retried after an incorrect occupied hero retracts",()=>{
    const t=tracker();t.pend={};t.turn=49;
    heroes.forEach((h,i)=>{t.heroOf[h]=[panels[i].side,panels[i].idx];t.known.add("hero:"+h);});
    const seen=[...heroes.slice(0,9),"extraHero"];
    t.attribute(null,ob({},seen),pq,same);assert(!t.heroOf.hero9);assert(!t.known.has("hero:extraHero"));
    t.attribute(null,ob({},seen),pq,same);assert.deepEqual(t.heroOf.extraHero,["R",4]);
    assert.equal(t.state(ob()).taken_heroes.length,10);
  });
  check("nearby seats being full does not discard a hero when a distant seat is vacant",()=>{
    const t=tracker();t.pend={};t.turn=0;
    heroes.slice(0,9).forEach((h,i)=>{t.heroOf[h]=[panels[i].side,panels[i].idx];t.known.add("hero:"+h);});
    t.attribute(null,ob({},heroes),pq,same);
    assert(t.orphan["hero:hero9"]);assert.equal(t.state(ob()).taken_heroes.length,10);
  });
  check("mid-draft joins still retain existing unseated heroes",()=>{
    const t=tracker();t.pend={};t.joinedMidDraft=true;
    t.attribute(null,ob({},[heroes[0]]),pq,same);
    assert(t.orphan["hero:hero0"]);assert.equal(t.state(ob()).taken_heroes.length,1);
  });
}finally{if(prev===undefined)delete process.env.AD_NONAME;else process.env.AD_NONAME=prev;}
check("panel names can still replace a guessed hero after all ten seats fill",()=>{
  const t=tracker();t.pend={};t.turn=49;t.nameHero={};t.nameRun={R4:{h:"extraHero",n:1,t:19}};
  heroes.forEach((h,i)=>{t.heroOf[h]=[panels[i].side,panels[i].idx];t.known.add("hero:"+h);if(i<9)t.nameHero[pq(t.heroOf[h])]=h;});
  R.setSource({heroName:()=>[[.9,"extraHero"],[.1,null]]});
  try{t.attribute(null,ob({},[...heroes,"extraHero"]),pq,same);}finally{R.setSource(null);}
  assert.deepEqual(t.heroOf.extraHero,["R",4]);assert(!t.heroOf.hero9);assert(!t.orphan["hero:hero9"]);
  assert.equal(t.state(ob()).taken_heroes.length,10);
});
check("2.0 projection replaces 1.x pending metadata as well as its ownership",()=>{
  const {Estimator}=require("../v2");
  const e=new Estimator({pool:{skills:[{key:"waiting",cell:0}],heroCards:[]},refB:[100],refS:[.5]});
  e.acc[0].W=99;
  const t=tracker(),s=t.state(ob({waiting:true}));
  e.applyTo(s,{margin:.1});assert(s.skills[0].taken);assert(s.panels.every(p=>p.skills.length===0));
  assert.deepEqual(s.pendingKeys,[]);assert.equal(s.pendingPair,0);
  assert.equal(R.pickedCount(s),1,"2.0's accepted unassigned cell must not be excluded by stale 1.x metadata");
});
console.log(`PASS ${checks} pending progress/retraction and hero seat-capacity cases`);
