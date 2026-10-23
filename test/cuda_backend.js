'use strict';
const assert=require('assert/strict'),vm=require('vm'),fs=require('fs'),path=require('path'),os=require('os');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-cuda-backend-')),model=path.join(dir,'m.onnx');fs.writeFileSync(model,'fixture');
 const created=[],released=[];let failCuda=false;
 const runtime=name=>({Tensor:class{constructor(type,data,dims){Object.assign(this,{type,data,dims});}},InferenceSession:{async create(_,options){
  const provider=options.executionProviders[0];const ep=provider.name||provider;
  created.push({name,ep,device:provider.deviceId});
  if(name==='cuda'&&failCuda)throw Error('Missing CUDA DLL');
  if(provider.deviceId>0)throw Error('No adapter');
  return {inputNames:[],async run(){return {};},async release(){released.push(name);}};
 }}});
 const context=vm.createContext({module:{exports:{}},__dirname:root,Buffer,Float32Array,Float64Array,Int32Array,Int8Array,Uint8Array,SharedArrayBuffer,Date,process:{...process,platform:'win32',env:{AD_NO_FP16:'1'}},require(name){
  if(name==='onnxruntime-node')return runtime('node');if(name==='./cuda_bridge')return {create:runtimePath=>{assert.equal(runtimePath,'private-cuda');return runtime('cuda');}};
  if(name.startsWith('./'))return require(path.join(root,name));return require(name);
 }});
 try{
  vm.runInContext(fs.readFileSync(path.join(root,'combo_local.js'),'utf8'),context);const C=context.module.exports;C.setCudaRuntime('private-cuda');
  const dml=await C.init(model,undefined,32);assert.equal(dml.ep,'dml');assert(created.every(x=>x.name==='node'));const before=created.length;
  const cuda=await C.init(model,'cuda',32);assert.equal(cuda.ep,'cuda');assert.equal(created[before].name,'cuda');assert(released.includes('node'));
  await C.init(model,undefined,32);assert.equal(created.at(-1).name,'node');assert(released.includes('cuda'),'Switch drains and releases CUDA');
  failCuda=true;const fallback=await C.init(model,'cuda',128);assert.equal(fallback.ep,'dml');assert.equal(fallback.cudaFallback,true);assert.match(fallback.detail,/Missing CUDA DLL/);
  assert(!created.some(x=>x.name==='cuda'&&x.ep==='cpu'),'Never benchmarks CPU through the CUDA bridge');
  const n=created.length;await C.init(model,'cuda',128);assert.equal(created.length,n,'Remember fallback for same session');await C.dispose();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 console.log('通过：实际会话代码的 DML 原路径、CUDA 私有运行时、切回释放、失败恢复与复用；使用后端桩。');
})().catch(e=>{console.error(e);process.exitCode=1;});
