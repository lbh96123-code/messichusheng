"use strict";
const fs=require("fs"),path=require("path");
const {performance}=require('perf_hooks');
function create(file,{context=()=>({}),intervalMs=10000,cap=2*1024*1024,rotate=false}={}){
 let bytes=0,timer=null,last=Date.now(),closed=false;try{bytes=fs.statSync(file).size;}catch(_){}
 const totals={records:0,writeMs:0,maxWriteMs:0,errors:0};
 function record(event,details={},critical=false){
  if(closed)return;
  if(bytes>cap+(critical?65536:0)){
   if(!rotate)return;
   try{const prev=file.replace(/\.jsonl$/,'.previous.jsonl');try{fs.unlinkSync(prev);}catch(_){}fs.renameSync(file,prev);bytes=0;}catch(_){return;}
  }
  const began=performance.now();
  try{const m=process.memoryUsage(),row={ts:Date.now(),event,pid:process.pid,details,context:context(),memory:{rss:m.rss,heapUsed:m.heapUsed,external:m.external,arrayBuffers:m.arrayBuffers}};
   let s=JSON.stringify(row);if(s.length>12000)s=JSON.stringify({ts:row.ts,event,pid:row.pid,truncated:true,details:String(JSON.stringify(details)).slice(0,3000)});
   const b=Buffer.from(s+"\n");fs.appendFileSync(file,b);bytes+=b.length;totals.records++;
  }catch(_){totals.errors++;}finally{const ms=performance.now()-began;totals.writeMs+=ms;totals.maxWriteMs=Math.max(totals.maxWriteMs,ms);} // Diagnostics must not cause a crash of their own.
 }
 function start(){if(timer)return;record("session-start");timer=setInterval(()=>{const now=Date.now();record("checkpoint",{eventLoopDelayMs:Math.max(0,now-last-intervalMs)});last=now;},intervalMs);timer.unref?.();}
 function close(reason){record("normal-exit",{reason},true);closed=true;if(timer)clearInterval(timer);timer=null;}
 return {record,start,close,stats:()=>({...totals,fileBytes:bytes})};
}
function install({app,process:proc=process,crashReporter,file,context,log,flush,onFault}){
 const d=create(file,{context,rotate:true});
 const fault=(event,details)=>{d.record(event,details,true);try{log("crash",event+" "+JSON.stringify(details));flush();onFault?.();}catch(_){};};
 proc.on("uncaughtExceptionMonitor",e=>fault("uncaught-exception",{stack:String(e?.stack||e)}));
 proc.on("unhandledRejection",e=>fault("unhandled-rejection",{stack:String(e?.stack||e)}));
 proc.on("exit",code=>d.record("process-exit",{code},true));
 app.on("child-process-gone",(_,details)=>details.reason==="clean-exit"?d.record("child-process-exit",details):fault("child-process-gone",details));
 app.on("web-contents-created",(_,wc)=>{
  wc.on("render-process-gone",(_,details)=>details.reason==="clean-exit"?d.record("render-process-exit",{id:wc.id,...details}):fault("render-process-gone",{id:wc.id,...details}));
  wc.on("unresponsive",()=>fault("renderer-unresponsive",{id:wc.id}));
 });
 app.on("before-quit",()=>d.close("before-quit"));
 try{crashReporter.start({uploadToServer:false,globalExtra:{diagnosticVersion:require('./package.json').version}});d.record("native-crash-reporter",{directory:app.getPath("crashDumps"),uploadToServer:false});}catch(e){d.record("native-crash-reporter-error",{message:String(e?.message||e)},true);}
 d.start();return d;
}
module.exports={create,install};
