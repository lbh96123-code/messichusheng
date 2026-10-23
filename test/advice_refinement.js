'use strict';
const assert=require('assert/strict'),{RefinementGate}=require('../advice_refinement');
function harness(start=0){
 let now=0,turn=start,id=0;const timers=new Map(),shown=[];
 const gate=new RefinementGate({onPublish:(r,u)=>shown.push({r,u,at:now}),turnStart:()=>turn,now:()=>now,schedule:(f,ms)=>{timers.set(++id,{at:now+ms,f});return id;},cancel:i=>timers.delete(i)});
 return {gate,shown,turn:x=>turn=x,time:t=>{now=t;for(;;){const next=[...timers].filter(([,v])=>v.at<=now).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);next[1].f();}}};
}
const result=(target,{complete=true,samples=target,key='best'}={})=>({sampleTarget:target,complete,requestedSamples:target,rows:Array.from({length:8},(_,i)=>({key:i?'other'+i:key,n:samples/8,win:.6-i*.01}))});
const h=harness();h.time(200);h.gate.offer(result(128,{complete:false,samples:32}));h.time(700);h.gate.offer(result(128));
h.time(1100);h.gate.offer(result(256,{key:'new-best'}));assert.equal(h.shown.length,2,'fast refinement is coalesced without clearing prior advice');
h.time(1300);h.gate.offer(result(384));h.time(1700);assert.equal(h.shown.at(-1).u.target,256,'384 is not a displayed tier');assert.equal(h.shown.at(-1).r.rows[0].key,'new-best','normal result ordering is preserved');
h.time(2100);h.gate.offer(result(512));h.time(2700);assert.equal(h.shown.at(-1).u.target,512);
h.time(3999);h.gate.offer(result(1024));assert.equal(h.shown.at(-1).u.target,1024);h.time(4000);h.gate.offer(result(2048));assert.equal(h.shown.at(-1).u.target,1024,'t+4 is an inclusive freeze boundary');
const pending=harness();pending.time(3100);pending.gate.offer(result(128));pending.time(3500);pending.gate.offer(result(256));pending.time(4100);assert.equal(pending.shown.length,1,'a queued update may not cross the freeze deadline');
const late=harness();late.time(4200);late.gate.offer(result(128,{complete:false,samples:64}));late.time(5000);late.gate.offer(result(128));assert.equal(late.shown.length,2,'late baseline keeps the existing partial and complete-result path');late.time(6000);late.gate.offer(result(256));assert.equal(late.shown.length,2,'late baseline completion does not reopen refinement');
const equal=harness();equal.time(4100);equal.gate.offer(result(128,{complete:false,samples:128}));equal.time(4200);equal.gate.offer(result(128));assert(equal.gate.baseline,'completion at unchanged sample count must still be published');
const preview=harness(null);preview.time(10000);preview.gate.offer(result(128));preview.time(11000);preview.gate.offer(result(256));preview.turn(12000);preview.time(15000);preview.gate.offer(result(512));preview.time(16000);preview.gate.offer(result(1024));assert.equal(preview.shown.at(-1).u.target,512,'preview/job start must not start the four-second turn clock');
const cancel=harness();cancel.gate.offer(result(128));cancel.time(100);cancel.gate.offer(result(256));cancel.gate.close();cancel.time(2000);assert.equal(cancel.shown.length,1,'state replacement cancels pending publication');
const fresh=harness(5000);fresh.time(5100);fresh.gate.offer(result(128));assert.equal(fresh.shown.length,1,'the next turn has its own clock and baseline');
console.log('PASS exponential result tiers, coalescing, exact t+4 freeze, late baseline, preview clock and stale-update cancellation');
