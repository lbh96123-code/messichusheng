'use strict';
const assert=require('assert/strict'),{EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
const {create,Tensor,encode,decode}=require('../cuda_bridge');
const send=(child,m)=>{const b=Buffer.from(JSON.stringify(m)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);const f=Buffer.concat([h,b]);child.stdout.write(f.subarray(0,2));child.stdout.write(f.subarray(2,7));child.stdout.write(f.subarray(7));};
function host({fail=false,timeout=false}={}){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>setImmediate(()=>child.emit('exit',1));
 child.stdin=new Writable({write(b,_,cb){const m=JSON.parse(b.subarray(4));setImmediate(()=>{
  if(timeout)return;
  if(m.op==='init')send(child,{id:m.id,result:{inputs:['ids']}});
  else if(fail)send(child,{id:m.id,error:'GPU failed'});
  else send(child,{id:m.id,result:{logits:m.feeds.ids}});
 });cb();},final(cb){setImmediate(()=>child.emit('exit',0));cb();}});
 return child;
}
(async()=>{
 const x=new Tensor('float32',new Float32Array([9,1.5,2.5,9]).subarray(1,3),[1,2]);assert.deepEqual([...decode(encode(x)).data],[1.5,2.5]);
 const session=await create('fake',{spawn:()=>host()}).InferenceSession.create('model',{freeDimensionOverrides:{B:32}});
 const r=await session.run({ids:x});assert.deepEqual([...r.logits.data],[1.5,2.5]);assert.deepEqual(r.logits.dims,[1,2]);await session.release();
 await assert.rejects(session.run({ids:x}),/closed/);
 const failed=await create('fake',{spawn:()=>host({fail:true})}).InferenceSession.create('model',{freeDimensionOverrides:{B:32}});
 await assert.rejects(failed.run({ids:x}),/GPU failed/);await failed.release();
 await assert.rejects(create('fake',{spawn:()=>host({timeout:true}),timeoutMs:10}).InferenceSession.create('model',{freeDimensionOverrides:{B:32}}),/timeout/);
 console.log('通过：CUDA 桥接张量偏移、分帧响应、错误、超时和进程释放；使用协议桩。');
})().catch(e=>{console.error(e);process.exitCode=1;});
