'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),zlib=require('zlib'),{Worker}=require('worker_threads');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-detail-worker-')),file=path.join(dir,'diag_combo_test.jsonl');
 const w=new Worker(path.resolve(__dirname,'../combo_worker.js'),{workerData:{model:'',prefer:'cpu',combo:path.resolve(__dirname,'_combo_stub.js'),diagnosticFile:file}});
 let id=0;const pending=new Map();w.on('message',m=>{const p=pending.get(m.id);if(p){pending.delete(m.id);p(m);}});
 const send=(type,extra={})=>{const n=++id;return new Promise((resolve,reject)=>{const t=setTimeout(()=>{pending.delete(n);reject(Error('Worker response timeout: '+type));},5000);pending.set(n,m=>{clearTimeout(t);resolve(m);});w.postMessage({type,id:n,...extra});});};
 const state={seats:[],pool:{heroKeys:Array.from({length:12},(_,i)=>'h'+i),basics:Array.from({length:36},(_,i)=>'b'+i),ults:Array.from({length:12},(_,i)=>'u'+i)}};
 try{
  const a=await send('final',{st:state,keys:[],o:{}});assert.equal(a.type,'done');
  await send('detail-flush');
  w.postMessage({type:'detailed-logs',enabled:false});const b=await send('final',{st:state,keys:[],o:{}});assert.equal(b.type,'done');
  w.postMessage({type:'detailed-logs',enabled:true});const c=await send('final',{st:state,keys:[],o:{}});assert.equal(c.type,'done');await send('detail-flush');
  const records=fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl.gz')).flatMap(n=>zlib.gunzipSync(fs.readFileSync(path.join(dir,n))).toString().trim().split('\n').map(JSON.parse));
  assert.equal(records.filter(r=>r.event==='job-start').length,2,'Enabled tasks logged, disabled task omitted');
  assert.deepEqual(records.filter(r=>r.event==='detail-config').map(r=>r.details.enabled),[true,false,true]);assert(records.some(r=>r.event==='detail-log-overhead'));
  const done=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('shutdown timeout')),5000);w.on('message',m=>{if(m.type==='shutdown-ready'){clearTimeout(t);resolve();}});});w.postMessage({type:'shutdown'});await done;
  console.log('通过：真实计算 Worker 默认开启、即时开关、刷新确认、任务行为和退出压缩收尾；计算使用桩。');
 }finally{await w.terminate();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
