"use strict";
// CUDA lives in a separate process: its newer ORT DLLs cannot replace/load beside DML's.
const { spawn } = require('child_process');
const path = require('path');
const {performance}=require('perf_hooks'),crypto=require('crypto');
class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
const arrays = {float32: Float32Array, int32: Int32Array, int64: BigInt64Array};
function encode(t) { return {type:t.type,dims:t.dims,data:Buffer.from(t.data.buffer,t.data.byteOffset,t.data.byteLength).toString('base64')}; }
function decode(t) { const b=Buffer.from(t.data,'base64'), A=arrays[t.type]; if(!A)throw Error('Unsupported CUDA output '+t.type);return new Tensor(t.type,new A(b.buffer.slice(b.byteOffset,b.byteOffset+b.length)),t.dims); }
function create(runtime, options={}) {
  return {Tensor,InferenceSession:{async create(model, config) {
    const child=(options.spawn||spawn)(path.join(runtime,'python','python.exe'),['-I','-u',path.join(__dirname,'cuda','host.py')],{windowsHide:true,cwd:runtime,env:{...process.env,PYTHONPATH:'',PYTHONHOME:''}});
    let buffer=Buffer.alloc(0), seq=0, closed=false, stderr='',lastTiming=null; const pending=new Map();
    const sessionId=crypto.randomBytes(6).toString('hex');
    const fail=e=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();};
    child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-3000);});
    child.on('error',fail); child.on('exit',(code)=>fail(Error('CUDA process exited '+code+': '+stderr.slice(-800))));
    child.stdin.on('error',fail);
    child.stdout.on('data',data=>{buffer=Buffer.concat([buffer,data]);try{while(buffer.length>=4){const n=buffer.readUInt32LE(0);if(n>32*1024*1024)throw Error('CUDA frame too large');if(buffer.length<n+4)break;const began=performance.now(),m=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);if(p.timing){p.timing.responseJsonMs=performance.now()-began;p.timing.responseBytes=n;p.timing.roundTripMs=performance.now()-p.start;p.timing.host=m.timing||null;}m.error?p.reject(Error(m.error)):p.resolve(m.result);}}}catch(e){fail(e);child.kill();}});
    const request=(m,timing)=>new Promise((resolve,reject)=>{if(closed)return reject(Error('CUDA process closed'));const id=++seq,start=performance.now();const timer=setTimeout(()=>{fail(Error('CUDA response timeout'));child.kill();},options.timeoutMs||120000);pending.set(id,{resolve,reject,timer,timing,start});const b=Buffer.from(JSON.stringify({...m,id,...(timing?{detailedTiming:true}:{})})),h=Buffer.alloc(4);h.writeUInt32LE(b.length);if(timing){timing.requestId=id;timing.requestBytes=b.length;timing.requestJsonMs=performance.now()-start;const hashStart=performance.now();timing.inputSHA256=crypto.createHash('sha256').update(JSON.stringify(m.feeds)).digest('hex');timing.inputHashMs=performance.now()-hashStart;}child.stdin.write(Buffer.concat([h,b]));});
    try {
      const r=await request({op:'init',model,batch:config.freeDimensionOverrides.B});
      return {inputNames:r.inputs,get lastTiming(){return lastTiming;},async run(feeds){
        const enabled=typeof options.detailed==='function'?options.detailed():options.detailed,started=performance.now();
        const timing=enabled?{schema:1,sessionId,hostPid:child.pid||null,startedAt:Date.now(),batch:feeds.ids?.dims?.[0],inputShapes:Object.fromEntries(Object.entries(feeds).map(([k,t])=>[k,t.dims]))}:null;
        const begin=performance.now(),encoded=Object.fromEntries(Object.entries(feeds).map(([k,t])=>[k,encode(t)]));if(timing)timing.inputEncodeMs=performance.now()-begin;
        const raw=await request({op:'run',feeds:encoded},timing),decodeStart=performance.now(),result=Object.fromEntries(Object.entries(raw).map(([k,t])=>[k,decode(t)]));
        if(timing){timing.outputDecodeMs=performance.now()-decodeStart;timing.totalMs=performance.now()-started;timing.unattributedRoundTripMs=timing.host?Math.max(0,timing.roundTripMs-timing.requestJsonMs-timing.inputHashMs-timing.responseJsonMs-timing.host.handleMs):null;timing.scope='host.runtimeMs includes H2D, GPU work, D2H and runtime/driver waits; residual includes pipes, scheduling, frame assembly, host response JSON/write; not pure GPU or pure IPC';}
        lastTiming=timing;return result;
      },async release(){if(!closed){child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}}};
    }catch(e){child.kill();throw e;}
  }}};
}
module.exports={create,Tensor,encode,decode};
