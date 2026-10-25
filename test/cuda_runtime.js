'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),crypto=require('crypto'),{Readable}=require('stream'),{EventEmitter}=require('events'),{spawnSync}=require('child_process');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ad-cuda-install-'));let payload=Buffer.from('verified archive'),redirect=false;
 const https={get(url,options,cb){const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=e=>req.emit('error',e);setImmediate(()=>{const res=Readable.from([payload]);res.statusCode=redirect?302:200;res.headers=redirect?{location:'https://untrusted.example/payload'}:{};cb(res);});return req;}};
 const context=vm.createContext({module:{exports:{}},__dirname:root,Buffer,URL,process,setTimeout,clearTimeout,require(name){if(name==='https'||name==='http')return https;if(name.startsWith('./'))return require(path.join(root,name));return require(name);}});
 vm.runInContext(fs.readFileSync(path.join(root,'cuda_runtime.js'),'utf8'),context);const r=context.module.exports;
 try{
  const file={name:'x.zip',url:r.offline.url,bytes:payload.length,sha256:crypto.createHash('sha256').update(payload).digest('hex')};
  await r.download(file,path.join(dir,'ok.zip'),undefined,()=>{});assert.equal(fs.readFileSync(path.join(dir,'ok.zip')).toString(),payload.toString());
  await assert.rejects(r.download({...file,sha256:'0'.repeat(64)},path.join(dir,'bad.zip'),undefined,()=>{}),/校验失败/);
  payload=Buffer.from('larger than expected size');await assert.rejects(r.download(file,path.join(dir,'large.zip'),undefined,()=>{}),/超出清单/);
  redirect=true;await assert.rejects(r.download(file,path.join(dir,'redirect.zip'),undefined,()=>{}),/白名单/);
  assert(!r.trusted('http://www.python.org/a'));assert(!r.trusted('https://www.python.org.evil/a'));
  const script=String.raw`import importlib.util, pathlib, zipfile, sys
p=pathlib.Path(sys.argv[1]); spec=importlib.util.spec_from_file_location('cuda_install',sys.argv[2]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with zipfile.ZipFile(p/'good.whl','w') as z:
 z.writestr('pkg/__init__.py','ok');z.writestr('pkg.data/','');z.writestr('pkg.data/scripts/tool','skip');z.writestr('pkg.data/purelib/other.py','ok')
m.extract(p/'good.whl',p/'out');assert (p/'out/pkg/__init__.py').read_text()=='ok';assert (p/'out/other.py').read_text()=='ok';assert not (p/'out/pkg.data').exists()
for i,name in enumerate(['../outside.py','C:/outside.py','..\\outside.py']):
 with zipfile.ZipFile(p/('bad%d.whl'%i),'w') as z:z.writestr(name,'bad')
 try:m.extract(p/('bad%d.whl'%i),p/'out')
 except ValueError:pass
 else:raise AssertionError('Unsafe archive accepted')
`;
  const check=spawnSync('python3',['-c',script,dir,path.join(root,'cuda','install.py')],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 console.log('通过：下载大小与 SHA256、来源及重定向白名单、真实解压和路径越界拒绝；未下载 CUDA 大文件。');
})().catch(e=>{console.error(e);process.exitCode=1;});
