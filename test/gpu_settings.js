'use strict';
const assert=require('assert/strict'),runtime=require('../cuda_runtime'),{create}=require('../gpu_settings');
(async()=>{
 const original={install:runtime.install,installed:runtime.installed};let calls=0,installed=false,save=0,started=0,cancelled=0,allowed=true;
 runtime.installed=()=>installed;runtime.install=async()=>{calls++;installed=true;};
 const result={results:[32,128].map(batch=>({batch,dml:{medianMs:10},cuda:{medianMs:5},validation:{passed:true}}))};
 try{
  const settings={};const g=create({dataDir:'/fake',platform:'win32',settings,save:()=>save++,canTest:()=>allowed,sendBenchmark:()=>started++,cancelBenchmark:()=>cancelled++});
  assert.equal(calls,0,'Opening settings never downloads');assert.equal(g.active,'dml');assert.equal(g.select('cuda'),false);
  await g.start();assert.equal(calls,1);assert.equal(started,1);assert.equal(g.snapshot().phase,'testing');
  await g.start();assert.equal(calls,1,'Repeated clicks do not start another install');
  g.finish({result});assert.equal(settings.gpuBackend,undefined,'Benchmark never automatically switches');assert.equal(g.select('cuda'),true);assert.equal(g.active,'dml','Selection waits for restart');
  const reboot=create({dataDir:'/fake',platform:'win32',settings,save:()=>save++,sendBenchmark:()=>{},cancelBenchmark:()=>{}});assert.equal(reboot.active,'cuda');
  reboot.reportBackend({cudaFallback:true,detail:'CUDA failed; using DML'});assert.equal(reboot.active,'dml');assert.equal(settings.gpuBackend,'dml');
  await g.start();g.cancel();g.cancel();assert.equal(cancelled,1);g.finish({result});assert.equal(g.snapshot().phase,'error');assert.match(g.snapshot().message,/取消/);
  allowed=false;await g.start();assert.equal(calls,2,'Active draft blocks installation and benchmark');
  assert(save>=3);assert.equal(g.select('dml'),true);
 }finally{Object.assign(runtime,original);}
 console.log('通过：确认前不安装、默认 DML、选技禁测、双击去重、取消、选择持久化及 CUDA 失败恢复。');
})().catch(e=>{console.error(e);process.exitCode=1;});
