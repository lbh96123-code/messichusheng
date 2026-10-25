'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib'),crypto=require('crypto');
const {create}=require('../detail_log'),{detailBatches}=require('../logupload');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-detail-'));
 try{
  const file=path.join(dir,'diag_detail_1700000000000.jsonl'),logger=create(file,{context:()=>({job:19,model:'netS_f21_60.onnx',shareMode:'optimalBoth'})});
  const calls=44000;
  for(let i=0;i<calls;i++){
   logger.record('native-call-start',{id:i,kind:'infer',batch:32,startedAt:1700000000000+i*6});
   logger.record('native-call',{id:i,kind:'infer',batch:32,ms:5.9});
   logger.record('cuda-call',{schema:1,sessionId:'123456',requestId:i,inputSHA256:crypto.createHash('sha256').update(String(i)).digest('hex'),batch:32,inputShapes:{ids:[32,60],ext:[32,60,3]},inputEncodeMs:0.12,inputHashMs:0.05,requestJsonMs:0.1,responseJsonMs:0.02,roundTripMs:5.6,outputDecodeMs:0.03,totalMs:5.9,unattributedRoundTripMs:0.7,host:{schema:1,pid:123,payloadReadMs:0.01,requestJsonMs:0.15,inputDecodeMs:0.1,runtimeMs:4.1,outputEncodeMs:0.12,handleMs:4.5},scope:'runtime includes H2D, GPU work, D2H and driver scheduling; residual not pure IPC'});
   if(i%128===127)await logger.flush();
  }
  await logger.close();const s=logger.stats();assert.equal(s.dropped,0);assert.equal(s.evictedRecords,0);assert.equal(s.errors,0);assert.equal(s.records,calls*3);
  const batches=[...detailBatches(dir,0)];let count=0,next=0;
  for(const batch of batches){assert(batch.length<=180);assert(batch.reduce((n,f)=>n+f.data.length,0)<=16*1024*1024);for(const f of batch){assert(/^[A-Za-z0-9_.-]{1,80}\.jsonl$/.test(f.name));for(const line of f.data.toString().trim().split('\n')){const r=JSON.parse(line);if(r.event==='cuda-call')assert.equal(r.details.requestId,next++);count++;}}}
  assert.equal(count,calls*3);assert.equal(next,calls);assert(s.compressedBytes<s.rawBytes/3);
  const file2=path.join(dir,'diag_detail_rotation.jsonl'),rotation=create(file2,{maxBytes:1100});
  for(let i=0;i<20;i++){rotation.record('event',{i,random:crypto.randomBytes(64).toString('hex')});await rotation.flush();}await rotation.close();assert(rotation.stats().evictedRecords>0);assert(rotation.stats().retainedBytes<=1100);assert(rotation.stats().compressedBytes>1100);
  const overload=create(path.join(dir,'diag_detail_overload.jsonl'),{maxPendingBytes:100});overload.record('large',{text:'x'.repeat(200)});await overload.close();assert.equal(overload.stats().dropped,1);
  const badPath=path.join(dir,'not-a-directory');fs.writeFileSync(badPath,'x');const broken=create(path.join(badPath,'diag_detail_bad.jsonl'));broken.record('test',{});await broken.close();assert(broken.stats().errors>0,'Disk failure is reported without breaking inference');
  const rows=[...detailBatches(dir,0)].flat();assert(rows.length>0);
  console.log(JSON.stringify({passed:true,syntheticCalls:calls,records:s.records,rawMB:s.rawBytes/1048576,compressedMB:s.compressedBytes/1048576,recordMs:s.recordMs,compressedUploadBatches:batches.length,scope:'synthetic timings with varying SHA256; compression ratio is an estimate, not Windows logging overhead'}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
