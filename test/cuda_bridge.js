'use strict';
const assert=require('assert/strict'),{EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
const {create,Tensor,encode,decode}=require('../cuda_bridge');
const send=(child,m)=>{const b=Buffer.from(JSON.stringify(m)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);const f=Buffer.concat([h,b]);child.stdout.write(f.subarray(0,2));child.stdout.write(f.subarray(2,7));child.stdout.write(f.subarray(7));};
function host({fail=false,timeout=false,requests=[]}={}){
 const child=new EventEmitter();child.pid=123;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>setImmediate(()=>child.emit('exit',1));
 child.stdin=new Writable({write(b,_,cb){const m=JSON.parse(b.subarray(4));setImmediate(()=>{
  requests.push(m);if(timeout)return;
  if(m.op==='init')send(child,{id:m.id,result:{inputs:['ids']}});
  else if(fail)send(child,{id:m.id,error:'GPU failed'});
  else send(child,{id:m.id,result:{logits:m.feeds.ids},...(m.detailedTiming?{timing:{schema:1,pid:123,handleMs:0.01,runtimeMs:0.005}}:{})});
 });cb();},final(cb){setImmediate(()=>child.emit('exit',0));cb();}});
 return child;
}
(async()=>{
 const x=new Tensor('float32',new Float32Array([9,1.5,2.5,9]).subarray(1,3),[1,2]);assert.deepEqual([...decode(encode(x)).data],[1.5,2.5]);
 const session=await create('fake',{spawn:()=>host()}).InferenceSession.create('model',{freeDimensionOverrides:{B:32}});
 const r=await session.run({ids:x});assert.deepEqual([...r.logits.data],[1.5,2.5]);assert.deepEqual(r.logits.dims,[1,2]);await session.release();
 await assert.rejects(session.run({ids:x}),/closed/);
 let detailed=true;const requests=[],traced=await create('fake',{spawn:()=>host({requests}),detailed:()=>detailed}).InferenceSession.create('model',{freeDimensionOverrides:{B:32}});
 const tracedOutput=await traced.run({ids:x});assert.deepEqual([...tracedOutput.logits.data],[1.5,2.5]);
 const timing=traced.lastTiming;assert.equal(timing.host.pid,123);assert.equal(timing.host.runtimeMs,0.005);assert.equal(timing.batch,1);assert.equal(timing.hostPid,123);assert.equal(timing.inputSHA256.length,64);
 for(const key of ['totalMs','inputEncodeMs','inputHashMs','requestJsonMs','responseJsonMs','outputDecodeMs','roundTripMs','unattributedRoundTripMs'])assert(timing[key]>=0,key);
 await traced.run({ids:x});assert.equal(traced.lastTiming.inputSHA256,timing.inputSHA256,'Same input hash despite different request IDs');
 detailed=false;await traced.run({ids:x});assert.equal(traced.lastTiming,null);assert.equal(requests.at(-1).detailedTiming,undefined,'Live off switch stops Python timing');await traced.release();
 const failed=await create('fake',{spawn:()=>host({fail:true})}).InferenceSession.create('model',{freeDimensionOverrides:{B:32}});
 await assert.rejects(failed.run({ids:x}),/GPU failed/);await failed.release();
 await assert.rejects(create('fake',{spawn:()=>host({timeout:true}),timeoutMs:10}).InferenceSession.create('model',{freeDimensionOverrides:{B:32}}),/timeout/);
 console.log('通过：CUDA 桥接张量偏移、分帧响应、错误、超时和进程释放；使用协议桩。');
})().catch(e=>{console.error(e);process.exitCode=1;});
