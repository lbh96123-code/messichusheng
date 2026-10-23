"use strict";
const {performance}=require('perf_hooks');
const bridge=require('./cuda_bridge');
const median=a=>[...a].sort((x,y)=>x-y)[a.length>>1];
function input(B,hasExt){
  const tensor=(type,dims,fill)=>{const A=type==='int32'?Int32Array:Float32Array,a=new A(dims.reduce((n,x)=>n*x,1));for(let i=0;i<a.length;i++)a[i]=fill(i);return new bridge.Tensor(type,a,dims);};
  return {ids:tensor('int32',[B,60],i=>(i%60*7+3)%600),code:tensor('int32',[B,60],i=>i%60<15?i%10+1:0),delta:tensor('float32',[B,60],i=>(i%13-6)/10),legal:tensor('float32',[B,60],i=>i%60>=15?1:0),t:tensor('int32',[B],i=>15+i%10),seat:tensor('int32',[B],i=>i%10),slot:tensor('int32',[B,3],i=>i%3===1?1:0),...(hasExt?{ext:tensor('float32',[B,60,3],i=>(i%17)/100)}:{})};
}
function parity(a,b,B){
  if(a.length!==b.length||a.length!==B*60)throw Error('两种后端输出形状不同');
  let maxProbabilityDelta=0,agree=0;
  for(let r=0;r<B;r++){
    let at=-1,bt=-1;const start=r*60,end=start+60;
    for(let i=start+15;i<end;i++){if(!Number.isFinite(a[i])||!Number.isFinite(b[i]))throw Error('后端输出存在无效数值');if(at<0||a[i]>a[at])at=i;if(bt<0||b[i]>b[bt])bt=i;}
    if(at===bt)agree++;
    let sa=0,sb=0;for(let i=start+15;i<end;i++){sa+=Math.exp(a[i]-a[at]);sb+=Math.exp(b[i]-b[bt]);}
    for(let i=start+15;i<end;i++)maxProbabilityDelta=Math.max(maxProbabilityDelta,Math.abs(Math.exp(a[i]-a[at])/sa-Math.exp(b[i]-b[bt])/sb));
  }
  return {top1Agreement:agree/B,maxProbabilityDelta,passed:maxProbabilityDelta<=0.02&&agree/B>=0.95};
}
async function compare({model,runtime,onProgress=()=>{},cancelled=()=>false,loadDml=()=>require('onnxruntime-node'),loadCuda=()=>bridge.create(runtime)}){
  const results=[];
  const check=()=>{if(cancelled())throw Error('测速已取消');};
  const test=async(ort,provider,B,deviceId)=>{
    check();let session;
    try{
      session=await ort.InferenceSession.create(model,{graphOptimizationLevel:'all',freeDimensionOverrides:{B},executionProviders:[{name:provider,deviceId}],enableMemPattern:false,executionMode:'sequential'});
      const f=input(B,session.inputNames.includes('ext'));
      // Use each runtime's own Tensor constructor; identical underlying input values.
      const feeds=Object.fromEntries(Object.entries(f).map(([k,t])=>[k,new ort.Tensor(t.type,t.data,t.dims)]));
      await session.run(feeds);const timings=[];let output;
      for(let i=0;i<9;i++){check();const start=performance.now();output=await session.run(feeds);timings.push(performance.now()-start);}
      const sorted=[...timings].sort((a,b)=>a-b);
      return {medianMs:median(timings),p90Ms:sorted[Math.ceil(sorted.length*.9)-1],deviceId,output:output.logits.data.slice()};
    }finally{if(session)await session.release();}
  };
  for(const B of [32,128]){
    onProgress('DirectML 测速，批量 '+B+'…');let dml=null;
    for(let deviceId=0;deviceId<4;deviceId++){
      try{const r=await test(loadDml(),'dml',B,deviceId);if(!dml||r.medianMs<dml.medianMs)dml=r;}catch(e){check();if(deviceId===0)throw Error('DirectML 测速失败: '+e.message);break;}
    }
    check();onProgress('CUDA 测速，批量 '+B+'…');const cuda=await test(loadCuda(),'cuda',B,0),validation=parity(dml.output,cuda.output,B);
    delete dml.output;delete cuda.output;
    results.push({batch:B,dml,cuda,speedup:dml.medianMs/cuda.medianMs,validation});
    if(!validation.passed)throw Error('CUDA 与 DirectML 输出偏差过大，保持 DirectML');
  }
  return {model:require('path').basename(model),modelSha256:require('crypto').createHash('sha256').update(require('fs').readFileSync(model)).digest('hex'),precision:'FP32',runs:9,scope:'固定输入模型测速，含数据传输、序列化和进程调用；不代表整轮推演耗时',results,at:Date.now()};
}
module.exports={compare,input,parity};
