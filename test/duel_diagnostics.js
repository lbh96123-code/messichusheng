'use strict';
process.env.AD_COMBO_FAKE='1';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const D=require('../engine/server/draft'),{DuelController}=require('../duel_controller'),{Planner}=require('../duel_search');
const input=require('../../research/rubick_full_draft_20261008/input.json');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-duel-diag-')),file=path.join(dir,'diag.jsonl');
 const log=require('../crash_diagnostics').create(file,{rotate:true,context:()=>({shareMode:'optimalBoth',job:1})});
 try{
  const state=D.newState(input.pool);state.order=input.order;while(state.step<41)assert(D.pick(state,D.autoPick(state,()=>0)).ok);
  const baseline=new DuelController();baseline.setShareMode('optimalBoth');
  const expected=await baseline.decide(state,{mode:'duel',budgetMs:60000});
  const controller=new DuelController({diagnostic:(event,details)=>log.record(event,details)});controller.setShareMode('optimalBoth');
  const actual=await controller.decide(state,{mode:'duel',budgetMs:60000});
  assert.deepEqual(actual.rows,expected.rows);assert.equal(actual.chosen,expected.chosen);
  const cached=await controller.decide(state,{mode:'duel',budgetMs:60000});assert.equal(cached.newSamples,0);assert.equal(cached.reusedSamples,actual.requestedSamples);
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse),profiles=rows.filter(r=>r.event==='search-profile').map(r=>r.details);
  assert.equal(profiles.length,2);const [first,reused]=profiles;
  assert.equal(first.completedPaths,actual.newSamples);assert.equal(first.waves,4);assert(first.priorBatches>0&&first.priorStates>=first.priorBatches);
  assert.equal(Object.values(first.batchSizes).reduce((a,n)=>a+n,0),first.priorBatches);
  for(const key of ['encodeMs','logitsMs','priorPostMs','rootCandidateMs','simulationMs','backpropMs','otherMs','elapsedMs'])assert(Number.isFinite(first[key])&&first[key]>=0,key);
  assert(Math.abs(first.elapsedMs-first.encodeMs-first.logitsMs-first.priorPostMs-first.rootCandidateMs-first.simulationMs-first.backpropMs-first.otherMs)<1e-6);
  assert.equal(reused.completedPaths,0);assert.equal(reused.priorBatches,0);assert.equal(reused.reusedSamples,actual.requestedSamples);
  // Broken diagnostic consumers must not change selection or crash a search.
  const broken=new DuelController({diagnostic:()=>{throw Error('disk unavailable');}});broken.setShareMode('optimalBoth');
  assert.deepEqual((await broken.decide(state,{mode:'duel',budgetMs:60000})).rows,expected.rows);
  const stopped=[],p=new Planner({diagnostic:(event,details)=>{if(event==='search-profile')stopped.push(details);}});let checks=0;
  await p.decide(state,{budgetExpired:()=>++checks>2});assert.equal(stopped.at(-1).reason,'budget');assert(stopped.at(-1).suspendedPaths>0);
  await p.decide(state,{cancelled:()=>true});assert.equal(stopped.at(-1).reason,'cancelled');assert.equal(p.suspended,null);
  assert([...p.tree.values()].every(n=>n.pending===0&&n.rows.every(e=>e.pending===0)));
  console.log('通过：详细日志开关的候选/估值完全一致、分项耗时闭合、批次计数、复用、预算暂停、取消与日志故障隔离。');
 }finally{log.close('test');fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
