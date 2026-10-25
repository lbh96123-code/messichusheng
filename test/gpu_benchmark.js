'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {compare,parity}=require('../gpu_benchmark'),{Tensor}=require('../cuda_bridge');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-gpu-bench-')),model=path.join(dir,'model.onnx');fs.writeFileSync(model,'fixture');
 let sessions=0,created=0,runs=0,released=0,cancel=false;const inputs={};
 const fake=(backend,fail=false)=>({Tensor,InferenceSession:{async create(_,options){
  const B=options.freeDimensionOverrides.B,device=options.executionProviders[0].deviceId;
  if(device>0)throw Error('No more adapters');
  assert.equal(sessions++,0,'Compare releases previous session before starting another');created++;
  return {inputNames:['ids','ext'],async run(feeds){
   runs++;if(fail)throw Error('CUDA provider unavailable');
   const signature=Object.entries(feeds).map(([k,t])=>k+':'+t.type+':'+Buffer.from(t.data.buffer).toString('base64')).join('|');
   if(backend==='dml')inputs[B]=signature;else assert.equal(signature,inputs[B],'Identical DML/CUDA tensors and batch');
   return {logits:{data:Float32Array.from({length:B*60},(_,i)=>(i%60)/10)}};
  },async release(){sessions--;released++;}};
 }}});
 try{
  const diagnostics=[];const r=await compare({model,runtime:dir,loadDml:()=>fake('dml'),loadCuda:()=>fake('cuda'),onDiagnostic:(event,details)=>diagnostics.push({event,details})});
  assert.deepEqual(r.results.map(x=>x.batch),[32,128]);assert(r.results.every(x=>x.validation.passed&&x.validation.top1Agreement===1));
  assert.equal(created,4);assert.equal(released,4);assert.equal(runs,40);assert.equal(sessions,0);assert.equal(r.precision,'FP32');assert.equal(r.modelSha256.length,64);
  assert.equal(diagnostics.length,36,'All nine measured runs for four backend/batch pairs');assert(r.results.every(x=>x.dml.runsMs.length===9&&x.cuda.runsMs.length===9));
  await assert.rejects(compare({model,runtime:dir,loadDml:()=>fake('dml'),loadCuda:()=>fake('cuda',true)}),/CUDA provider unavailable/);assert.equal(sessions,0,'Failed CUDA sessions released');
  await assert.rejects(compare({model,runtime:dir,cancelled:()=>cancel,loadDml:()=>fake('dml'),loadCuda:()=>fake('cuda'),onProgress:()=>{cancel=true;}}),/取消/);assert.equal(sessions,0);
  const a=new Float32Array(60),b=new Float32Array(60);a[20]=10;b[21]=10;
  assert.equal(parity(a,b,1).passed,false);b[22]=NaN;assert.throws(()=>parity(a,b,1),/无效/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 console.log('通过：两批量、相同输入、预热计时、数值校验、取消、失败清理；未运行真实 GPU。');
})().catch(e=>{console.error(e);process.exitCode=1;});
