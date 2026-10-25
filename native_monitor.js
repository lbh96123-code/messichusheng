'use strict';
const {performance}=require('perf_hooks');
// Native faults cannot run JS catch handlers. Persist boundaries and retain
// the in-flight operation in heartbeat context, without writing every GPU call.
function create({now=()=>performance.now(),wallNow=()=>Date.now()}={}){
 let hook=null,detailHook=null,lastInferenceLog=-Infinity,next=0;const active=new Map(),waiters=new Set();
 const limits=[1,2,4,8,16,32,64,128,250,Infinity];
 const stats={calls:0,runMs:0,maxMs:0,errors:0,diagnosticMs:0,inferenceHistogram:Array(limits.length).fill(0)};
 const emit=(event,details,critical=false)=>{const t=now();try{hook?.(event,details,critical);}catch(_){}finally{stats.diagnosticMs+=Math.max(0,now()-t);}};
 const emitDetail=(event,details)=>{const t=now();try{detailHook?.(event,details);}catch(_){}finally{stats.diagnosticMs+=Math.max(0,now()-t);}};
 async function call(kind,details,operation){
  const tick=now(),op={id:++next,kind,startedAt:wallNow(),...details};active.set(op.id,{op,tick});
  const logged=kind!=='infer'||tick-lastInferenceLog>=1000;
  if(logged){if(kind==='infer')lastInferenceLog=tick;emit('native-start',op);}
  if(detailHook)emitDetail('native-call-start',op);
  // The synchronous diagnostic hook must not be charged to session.run().
  const operationStart=now();
  try{const result=await operation();const ms=Math.max(0,now()-operationStart);
   if(kind==='infer'){stats.calls++;stats.runMs+=ms;stats.maxMs=Math.max(stats.maxMs,ms);stats.inferenceHistogram[limits.findIndex(limit=>ms<=limit)]++;}
   if(logged||ms>=250)emit('native-end',{...op,ms});
   if(detailHook)emitDetail('native-call',{...op,ms,endedAt:wallNow(),scope:'runtime call wall time, includes transfer, driver and scheduling; not GPU-only'});return result;
  }catch(e){stats.errors++;const error={...op,ms:Math.max(0,now()-operationStart),stack:String(e?.stack||e)};emit('native-error',error,true);if(detailHook)emitDetail('native-call-error',error);throw e;}
  finally{active.delete(op.id);if(!active.size){for(const resolve of waiters)resolve();waiters.clear();}}
 }
 return {call,record:emit,recordDetail:emitDetail,isDetailed:()=>!!detailHook,setDetailHook(fn){detailHook=fn;},waitIdle(){return active.size?new Promise(resolve=>waiters.add(resolve)):Promise.resolve();},setHook(fn){hook=fn;},snapshot(){return {activeCount:active.size,active:[...active.values()].slice(0,8).map(({op,tick})=>({...op,elapsedMs:Math.max(0,now()-tick)})),...stats,inferenceHistogram:[...stats.inferenceHistogram],histogramUpperMs:limits.map(x=>Number.isFinite(x)?x:null),timingScope:'monotonic session.run await; excludes diagnostic hooks; includes runtime/driver/scheduling',timingSchema:2};}};
}
module.exports={create};
