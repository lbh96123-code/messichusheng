'use strict';
// Immutable gzip chunks: upload never reads a half-written gzip member.
const fs=require('fs'),path=require('path'),zlib=require('zlib'),{performance}=require('perf_hooks');
const gzip=b=>new Promise((resolve,reject)=>zlib.gzip(b,{level:1},(e,r)=>e?reject(e):resolve(r)));
function create(file,{context=()=>({}),intervalMs=2000,maxPendingBytes=2*1024*1024,maxBytes=16*1024*1024}={}){
 file=file.replace(/\.jsonl$/,`_${process.pid}_${require('worker_threads').threadId}.jsonl`);
 let lines=[],pendingBytes=0,chain=Promise.resolve(),closed=false,part=0;const retained=[];
 const stats={schema:1,records:0,dropped:0,errors:0,rawBytes:0,compressedBytes:0,retainedBytes:0,evictedRecords:0,recordMs:0,compressionWallMs:0,writeWallMs:0,limitReached:false};
 const status=file.replace(/\.jsonl$/,'.status.jsonl');
 function saveStatus(){try{fs.writeFileSync(status,JSON.stringify({ts:Date.now(),event:'detail-log-status',details:{...stats,maxBytes,maxPendingBytes,parts:part}})+'\n');}catch(_){stats.errors++;}}
 function flush(){
  if(!lines.length)return chain;
  const batch=lines;lines=[]; // pendingBytes includes queued/in-flight batches.
  const raw=Buffer.from(batch.join(''));stats.rawBytes+=raw.length;
  chain=chain.then(async()=>{
   if(stats.limitReached){stats.dropped+=batch.length;return;}
   const t=performance.now(),body=await gzip(raw);stats.compressionWallMs+=performance.now()-t;
   if(body.length>maxBytes){stats.limitReached=true;stats.dropped+=batch.length;return;}
   while(stats.retainedBytes+body.length>maxBytes&&retained.length){const old=retained[0];await fs.promises.unlink(old.file);retained.shift();stats.retainedBytes-=old.bytes;stats.evictedRecords+=old.records;}
   const target=file.replace(/\.jsonl$/,'.'+String(++part).padStart(5,'0')+'.jsonl.gz'),tmp=target+'.tmp',w=performance.now();
   try{await fs.promises.writeFile(tmp,body);await fs.promises.rename(tmp,target);stats.compressedBytes+=body.length;stats.retainedBytes+=body.length;retained.push({file:target,bytes:body.length,records:batch.length});}
   finally{stats.writeWallMs+=performance.now()-w;}
  }).catch(()=>{stats.errors++;stats.dropped+=batch.length;}).finally(()=>{pendingBytes-=raw.length;saveStatus();});
  return chain;
 }
 function record(event,details={}){
  if(closed)return;const start=performance.now();
  try{
   if(stats.limitReached||pendingBytes>=maxPendingBytes){stats.dropped++;return;}
   const line=JSON.stringify({ts:Date.now(),event,pid:process.pid,details,context:context()})+'\n',bytes=Buffer.byteLength(line);
   if(pendingBytes+bytes>maxPendingBytes){stats.dropped++;return;}
   lines.push(line);pendingBytes+=bytes;stats.records++;
   if(lines.length>=512)flush();
  }catch(_){stats.errors++;}finally{stats.recordMs+=performance.now()-start;}
 }
 try{fs.mkdirSync(path.dirname(file),{recursive:true});}catch(_){stats.errors++;}saveStatus();
 const timer=setInterval(()=>{flush();saveStatus();},intervalMs);timer.unref?.();
 return {record,flush,stats:()=>({...stats,pendingBytes}),async close(){closed=true;clearInterval(timer);await flush();saveStatus();}};
}
module.exports={create};
