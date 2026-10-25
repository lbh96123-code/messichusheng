'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib'),net=require('net'),{spawn}=require('child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-detail-upload-')),root=path.join(dir,'receiver');fs.mkdirSync(root);
 const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 process.env.AD_LOGUP_HOST='127.0.0.1';process.env.AD_LOGUP_PORT=String(port);process.env.AD_LOGUP_PATH='/';
 const U=require('../logupload'),conf=path.join(dir,'conf.json');fs.writeFileSync(conf,JSON.stringify({key:'adlog-7Kq2vXe9LmP4tRz'}));
 const server=spawn('python3',[path.join(__dirname,'../../server_logup/logup.py')],{env:{...process.env,LOGUP_CONF:conf,LOGUP_ROOT:root,LOGUP_PORT:String(port)},stdio:['ignore','pipe','pipe']});let stderr='';server.stderr.on('data',b=>stderr+=b);
 try{
  let ready=false;for(let i=0;i<50&&!ready;i++){ready=await new Promise(resolve=>{const c=net.connect(port,'127.0.0.1');c.once('connect',()=>{c.destroy();resolve(true);});c.once('error',()=>resolve(false));});if(!ready)await delay(50);}assert(ready,stderr);
  for(let i=0;i<181;i++)fs.writeFileSync(path.join(dir,`diag_detail_1700000000000.${String(i).padStart(5,'0')}.jsonl.gz`),zlib.gzipSync(JSON.stringify({ts:i,event:'cuda-call',details:{requestId:i,host:{runtimeMs:3}}})+'\n'));
  const batches=[...U.detailBatches(dir,0)];assert.deepEqual(batches.map(b=>b.length),[180,1]);
  for(const files of batches){const r=await U.postChunked(U.makeZip(files),{'x-ad-ver':'test','x-ad-id':'testdetail','x-ad-why':'manual_detail'});assert.equal(r.code,200,r.body);}
  const days=fs.readdirSync(root).filter(f=>/^\d{8}$/.test(f)),archives=days.flatMap(d=>fs.readdirSync(path.join(root,d)).filter(f=>f.endsWith('.zip')));assert.equal(archives.length,2);
  const logfile=path.join(dir,'ad_20261025_120000.log');fs.writeFileSync(logfile,'fixture log\n');let flushes=0;
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Uploader workflow timeout')),10000);const uploader=U.create({logdir:dir,logfile,version:'test',installId:'detailflow',enabled:()=>false,prevDelay:0,flush:async()=>{flushes++;},log:(tag,msg)=>{if(msg.includes('日志已上传(manual)')){clearTimeout(t);resolve();}else if(msg.includes('上传出错')||msg.includes('上传失败')){clearTimeout(t);reject(Error(msg));}}});uploader.now();});
  assert.equal(flushes,1);const after=days.flatMap(d=>fs.readdirSync(path.join(root,d)).filter(f=>f.endsWith('.zip')));assert.equal(after.length,5,'Normal packet plus all two detail packets sent by real uploader');
  console.log('通过：181 个本地压缩段无遗漏分成 180+1 个 JSONL 文件，两包均被现有真实接收服务接收。');
 }finally{server.kill();await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
