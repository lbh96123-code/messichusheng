'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{spawnSync}=require('child_process');
const helper=require('../cuda_offline');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-cuda-offline-')),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),payloads={'python.zip':'python fixture','cuda.whl':'cuda fixture'};
 const manifest={id:'fixed-test',files:Object.entries(payloads).map(([name,data])=>({name,bytes:Buffer.byteLength(data),sha256:hash(data)}))};
 const zip=path.join(dir,'bundle.zip'),script="import zipfile,json,sys\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_STORED) as z:\n for name,data in json.loads(sys.argv[2]).items():z.writestr('compute/downloads/fixed-test/'+name,data)";
 const made=spawnSync('python3',['-c',script,zip,JSON.stringify(payloads)]);assert.equal(made.status,0,made.stderr.toString());
 const offline={name:'offline-components.zip',url:'http://server/offline.zip',bytes:fs.statSync(zip).size,sha256:hash(fs.readFileSync(zip))},hashFile=async p=>hash(await fs.promises.readFile(p));let calls=0;
 const download=async(f,dest,signal,progress)=>{assert.equal(f.url,offline.url);calls++;await fs.promises.copyFile(zip,dest);progress(f.bytes);};
 const options={manifest,offline,hashFile,download};
 try{
  const cache=path.join(dir,'cache');await helper.fetchPackages({...options,cache});assert.equal(calls,1);for(const f of manifest.files)assert.equal(fs.readFileSync(path.join(cache,f.name),'utf8'),payloads[f.name]);assert(!fs.existsSync(path.join(cache,offline.name)),'Delete large outer bundle only after every component is verified');
  await helper.fetchPackages({...options,cache});assert.equal(calls,1,'Complete raw cache bypasses the network');
  const manual=path.join(dir,'manual');fs.mkdirSync(manual);fs.copyFileSync(zip,path.join(manual,offline.name));await helper.fetchPackages({...options,cache:manual});assert.equal(calls,1,'Manually downloaded package installs without network');
  const paused=path.join(dir,'paused');fs.mkdirSync(paused);fs.copyFileSync(zip,path.join(paused,offline.name));const stop=new AbortController();await assert.rejects(helper.fetchPackages({...options,cache:paused,signal:stop.signal,onProgress:p=>{if(p.message.includes('python.zip'))stop.abort();}}));assert(fs.existsSync(path.join(paused,offline.name)));assert(fs.existsSync(path.join(paused,'python.zip')));await helper.fetchPackages({...options,cache:paused});assert.equal(calls,1,'Interrupted extraction resumes from local package');
  await assert.rejects(helper.unpack({...options,archive:zip,cache:path.join(dir,'bad'),offline:{...offline,sha256:'0'.repeat(64)}}),/SHA256/);
  await assert.rejects(helper.unpack({...options,archive:zip,cache:path.join(dir,'bad'),manifest:{...manifest,id:'wrong-id'}}),/文件名/);
  const failed=path.join(dir,'failed');await assert.rejects(helper.fetchPackages({...options,cache:failed,download:async(_,p)=>{fs.writeFileSync(p,fs.readFileSync(zip).subarray(0,20));throw Error('network interrupted');}}),/network interrupted/);assert.equal(fs.statSync(path.join(failed,offline.name+'.part')).size,20,'Failed download preserves partial bundle');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 console.log('PASS offline CUDA: one pinned server bundle, raw cache reuse, manual package, extraction resume, SHA256/path rejection and partial retention.');
})().catch(e=>{console.error(e);process.exitCode=1;});
