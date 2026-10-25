'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),crypto=require('crypto'),{Readable}=require('stream'),{EventEmitter}=require('events');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-offline-range-')),root=path.resolve(__dirname,'..'),payload=Buffer.from('a pinned server package for range tests');
 const offline={url:'http://43.130.62.185/ad/dl-022c0c58e9cd/ad_plugin_cuda_offline_ort1232.zip',name:'offline.zip',bytes:payload.length,sha256:crypto.createHash('sha256').update(payload).digest('hex')};
 let ignoreRange=false,badRange=false,failure=false;const calls=[];
 const transport={get(url,options,cb){const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=e=>req.emit('error',e);calls.push({url,headers:options.headers});setImmediate(()=>{
  if(failure){req.emit('error',Error('server unavailable'));return;}let offset=Number((options.headers.Range||'bytes=0-').match(/\d+/)[0]);if(ignoreRange)offset=0;const res=Readable.from([payload.subarray(offset)]);res.statusCode=offset?206:200;res.headers=offset?{'content-range':`bytes ${badRange?offset+1:offset}-${payload.length-1}/${payload.length}`} : {};cb(res);
 });return req;}};
 const context=vm.createContext({module:{exports:{}},__dirname:root,Buffer,URL,process,setTimeout,clearTimeout,require:n=>n==='http'?transport:n==='./cuda/offline.json'?offline:n.startsWith('./')?require(path.join(root,n)):require(n)});
 vm.runInContext(fs.readFileSync(path.join(root,'cuda_runtime.js'),'utf8'),context);const api=context.module.exports;
 try{const p=path.join(dir,'bundle.part');fs.writeFileSync(p,payload.subarray(0,8));await api.download(offline,p,undefined,()=>{});assert.equal(calls.at(-1).headers.Range,'bytes=8-');assert.deepEqual(fs.readFileSync(p),payload);
  ignoreRange=true;fs.writeFileSync(p,payload.subarray(0,8));await api.download(offline,p,undefined,()=>{});assert.deepEqual(fs.readFileSync(p),payload);ignoreRange=false;
  badRange=true;fs.writeFileSync(p,payload.subarray(0,8));await assert.rejects(api.download(offline,p,undefined,()=>{}),/范围不匹配/);badRange=false;
  failure=true;const count=calls.length;await assert.rejects(api.download(offline,p,undefined,()=>{}),/server unavailable/);assert.equal(calls.length,count+1,'No fallback to an official or TUNA host');assert.equal(fs.statSync(p).size,8,'Retain partial data on failure');
  assert(!api.trusted('https://www.python.org/a'));assert(!api.trusted('https://pypi.tuna.tsinghua.edu.cn/a'));assert(!api.trusted(offline.url+'.evil'));assert(api.trusted(offline.url));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 console.log('PASS offline range: resume, server ignores Range, invalid Range, preserve partial data, server-only whitelist and no external fallback.');
})().catch(e=>{console.error(e);process.exitCode=1;});
