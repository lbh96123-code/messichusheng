"use strict";
const assert=require("assert/strict"),{Worker}=require("worker_threads"),path=require("path"),fs=require('fs'),os=require('os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-duel-queue-')),diagnosticFile=path.join(dir,'diag.jsonl');
const w=new Worker(path.resolve(__dirname,"../combo_worker.js"),{workerData:{model:"",prefer:"cpu",diagnosticFile,combo:path.resolve(__dirname,"_combo_stub.js"),duel:path.resolve(__dirname,"_duel_stub.js")}});
const pending=new Map();let id=0;
w.on("message",m=>{if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
const st={pool:{heroKeys:Array.from({length:12},(_,i)=>"h"+i),basics:Array.from({length:36},(_,i)=>"b"+i),ults:Array.from({length:12},(_,i)=>"u"+i)}};
function send(type,extra={}){const key=++id;const p=new Promise(resolve=>pending.set(key,resolve));w.postMessage({id:key,type,st,mode:"duel-fast",bfix:128,budget:900,o:{},...extra});return p;}
(async()=>{
 let a=send("duelbg"),b=send("duel");let [x,y]=await Promise.all([a,b]);assert(x.cancelled);assert(!y.cancelled);
 a=send("duel");b=send("duelbg");[x,y]=await Promise.all([a,b]);assert(!x.cancelled);assert(!y.cancelled);
 a=send("duel");b=send("duelbg");w.postMessage({type:"cancel"});[x,y]=await Promise.all([a,b]);assert(x.cancelled&&y.cancelled);
 a=send('duelbg',{budget:0,o:{continuous:true}}); await new Promise(resolve=>setTimeout(resolve,160)); b=send('duel'); [x,y]=await Promise.all([a,b]); assert(x.cancelled&&x.r.rounds>=10&&!y.cancelled);
 const logs=fs.readFileSync(diagnosticFile,'utf8').trim().split('\n').map(JSON.parse);
 for(const event of ['diagnostic-config','job-enqueue','job-start','model-init-end','job-cancel','job-dropped','job-end'])assert(logs.some(r=>r.event===event),event);
 assert.equal(logs.find(r=>r.event==='diagnostic-config').details.schema,2);
 const ends=logs.filter(r=>r.event==='job-end');assert(ends.some(r=>r.details.cancelled&&r.details.cancelReason));
 assert(ends.every(r=>r.details.queueMs>=0&&r.details.initMs>=0&&r.details.computeMs>=0));
 console.log('通过：双方推演排队/抢占/取消，详细任务日志、初始化、取消原因与耗时落盘。');
 await w.terminate();
 fs.rmSync(dir,{recursive:true,force:true});
})().catch(async e=>{console.error(e);await w.terminate();fs.rmSync(dir,{recursive:true,force:true});process.exitCode=1;});
