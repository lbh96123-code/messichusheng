'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm'),crypto=require('crypto');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-bench-diag-')),model=path.join(dir,'fixture.onnx');fs.writeFileSync(model,'fixture-model');
 let runs=0;const rows=[];
 const fake={Tensor:class{constructor(type,data,dims){this.data=data;this.dims=dims;}},InferenceSession:{async create(model,options){
  if(options.executionProviders[0].deviceId!==0)throw Error('No second adapter');
  return {inputNames:[],async run(){runs++;return {};},async release(){}};
 }}};
 const context=vm.createContext({module:{exports:{}},__dirname:path.resolve(__dirname,'..'),Buffer,Float32Array,Float64Array,Int32Array,Int8Array,Uint8Array,SharedArrayBuffer,Date,process:{...process,platform:'win32',env:{AD_NO_FP16:'1'}},require(name){if(name==='onnxruntime-node')return fake;if(name==='./native_monitor')return require('../native_monitor');return require(name);}});
 try{
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../combo_local.js'),'utf8'),context);
  const C=context.module.exports;C.setDiagnosticHook((event,details)=>rows.push({event,details}));
  await C.init(model,'dml',32);assert.equal(runs,6,'One cold + original five warm runs only');
  const bench=rows.find(r=>r.event==='fixed-input-benchmark').details;
  assert.equal(bench.runsMs.length,5);assert.equal(bench.inferenceRunsMs.length,5);assert(bench.inferenceRunsMs.every(n=>Number.isFinite(n)&&n>=0));
  assert.equal(bench.fingerprint.sha256,crypto.createHash('sha256').update('fixture-model').digest('hex'));
  const session=rows.find(r=>r.event==='native-start'&&r.details.kind==='session-create').details;
  assert.equal(session.executionMode,'sequential');assert.equal(session.batch,32);assert.equal(session.fingerprint.sha256,bench.fingerprint.sha256);
  await C.init(model,'dml',32);assert.equal(runs,6,'Reused initialization does not benchmark again');await C.dispose();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 console.log('通过：固定输入测速保留原6次调用、详细样本、模型SHA256、会话配置与初始化复用。');
})().catch(e=>{console.error(e);process.exitCode=1;});
