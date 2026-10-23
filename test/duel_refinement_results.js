'use strict';
process.env.AD_COMBO_FAKE='1';
const assert=require('assert/strict'),D=require('../engine/server/draft'),{DuelController}=require('../duel_controller');
const input=require('../../research/rubick_full_draft_20261008/input.json');
(async()=>{
 const state=D.newState(input.pool);state.order=input.order;while(state.step<41)assert(D.pick(state,D.autoPick(state,()=>0)).ok);
 const emitted=[],c=new DuelController();let stopped=false;
 await c.maintain(state,{mode:'duel',targetSeat:state.order[state.step],cancelled:()=>stopped,onResult:r=>{if(r.complete){emitted.push(r);if(r.sampleTarget===512)stopped=true;}}});
 assert.deepEqual(emitted.map(r=>r.sampleTarget),[128,256,512]);
 for(const r of emitted){assert(r.complete);assert(r.rows.every(row=>row.n>=Math.floor(r.sampleTarget/r.rows.length)));}
 const future=new DuelController();let cancel=false,published=0;
 await future.maintain(state,{mode:'duel',targetSeat:state.order[state.step+1],cancelled:()=>cancel,onResult:()=>published++,onProgress:()=>cancel=true});
 assert.equal(published,0,'hypothetical future-state values must not update the current recommendation');
 console.log('PASS completed128/256/512 emitted from current root only;384 and hypothetical-state results stay internal');
})().catch(e=>{console.error(e);process.exitCode=1;});
