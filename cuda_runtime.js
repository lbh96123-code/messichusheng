"use strict";
const fs=require('fs'),path=require('path'),https=require('https'),crypto=require('crypto');
const {spawn,execFile}=require('child_process');
const {pipeline}=require('stream/promises');
const manifest=require('./cuda/manifest.json');
const bytes=manifest.files.reduce((n,f)=>n+f.bytes,0);
const marker=JSON.stringify({id:manifest.id,manifest:crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')});
const runtimeDir=dataDir=>path.join(dataDir,'compute',manifest.id);
function installed(dir){try{return fs.readFileSync(path.join(dir,'ready.json'),'utf8')===marker&&fs.existsSync(path.join(dir,'python','python.exe'))&&fs.existsSync(path.join(dir,'python','site-packages','onnxruntime','__init__.py'));}catch(_){return false;}}
function trusted(url){const u=new URL(url);return u.protocol==='https:'&&['www.python.org','files.pythonhosted.org'].includes(u.hostname);}
async function download(file,dest,signal,progress,redirect=0){
  if(!trusted(file.url)||redirect>4)throw Error('下载来源不在白名单');
  await new Promise((resolve,reject)=>{
    const req=https.get(file.url,{signal},res=>{
      if([301,302,307,308].includes(res.statusCode)){res.resume();download({...file,url:new URL(res.headers.location,file.url).href},dest,signal,progress,redirect+1).then(resolve,reject);return;}
      if(res.statusCode!==200){res.resume();reject(Error('下载失败 HTTP '+res.statusCode));return;}
      let count=0;const hash=crypto.createHash('sha256');
      res.on('data',b=>{count+=b.length;hash.update(b);progress(count);if(count>file.bytes)res.destroy(Error('下载大小超出清单'));});
      pipeline(res,fs.createWriteStream(dest,{flags:'wx'})).then(()=>{if(count!==file.bytes||hash.digest('hex')!==file.sha256)throw Error('组件校验失败: '+file.name);resolve();}).catch(reject);
    });
    req.setTimeout(60000,()=>req.destroy(Error('下载连接超时，请重试')));req.on('error',reject);
  });
}
function run(exe,args,signal,timeout=600000){return new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{windowsHide:true,signal});let err='';
  child.stdout.on('data',()=>{});child.stderr.on('data',b=>{err=(err+b).slice(-2000);});
  const timer=setTimeout(()=>child.kill(),timeout);
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('解压组件失败 '+err.slice(-600)));});
});}
async function install(dir,{signal,onProgress=()=>{},platform=process.platform}={}){
  if(platform!=='win32'||process.arch!=='x64')throw Error('CUDA 测试目前支持 Windows 64 位 NVIDIA 显卡');
  if(installed(dir))return dir;
  onProgress({message:'检测 NVIDIA 显卡及驱动…',downloaded:0,total:bytes});
  await new Promise((resolve,reject)=>execFile('nvidia-smi.exe',['--query-gpu=name,driver_version','--format=csv,noheader'],{windowsHide:true,timeout:10000,signal},(e,out)=>{
    if(e||!out.trim())reject(Error('未检测到可用 NVIDIA 驱动，请先安装或更新显卡驱动；DirectML 可继续使用'));else resolve();
  }));
  fs.mkdirSync(path.dirname(dir),{recursive:true});
  const disk=await fs.promises.statfs(path.dirname(dir));
  if(Number(disk.bavail)*Number(disk.bsize)<7*1024**3)throw Error('安装磁盘至少需要 7 GB 可用空间（含临时下载）');
  const stage=dir+'.installing';
  await fs.promises.rm(stage,{recursive:true,force:true});await fs.promises.mkdir(stage,{recursive:true});
  let completed=0,last=0;
  try{
    for(const f of manifest.files){signal?.throwIfAborted();onProgress({message:'下载 '+f.name,downloaded:completed,total:bytes});
      await download(f,path.join(stage,f.name),signal,n=>{const now=Date.now();if(now-last>750){last=now;onProgress({message:'下载 '+f.name,downloaded:completed+n,total:bytes});}});completed+=f.bytes;
    }
    onProgress({message:'校验完成，解压到插件专用目录…',downloaded:bytes,total:bytes});
    const py=path.join(stage,'python');await fs.promises.mkdir(py);
    // The archive has a pinned hash from python.org. Pass paths as environment data,
    // never interpolate a userData path into PowerShell source.
    await new Promise((resolve,reject)=>{
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:AD_CUDA_ZIP -DestinationPath $env:AD_CUDA_PY -Force'],{windowsHide:true,signal,env:{...process.env,AD_CUDA_ZIP:path.join(stage,manifest.files[0].name),AD_CUDA_PY:py}});
      let err='';child.stdout.on('data',()=>{});child.stderr.on('data',b=>err=(err+b).slice(-1000));child.on('error',reject);child.on('exit',c=>c===0?resolve():reject(Error('解压 Python 失败: '+err)));
    });
    await fs.promises.writeFile(path.join(py,'python312._pth'),'python312.zip\n.\nsite-packages\nimport site\n');
    await run(path.join(py,'python.exe'),['-I',path.join(__dirname,'cuda','install.py'),path.join(py,'site-packages'),...manifest.files.filter(f=>f.kind==='wheel').map(f=>path.join(stage,f.name))],signal);
    for(const f of manifest.files)await fs.promises.unlink(path.join(stage,f.name));
    signal?.throwIfAborted();await fs.promises.writeFile(path.join(stage,'ready.json'),marker);
    await fs.promises.rm(dir,{recursive:true,force:true});await fs.promises.rename(stage,dir);return dir;
  }catch(e){await fs.promises.rm(stage,{recursive:true,force:true});throw e;}
}
module.exports={runtimeDir,installed,install,bytes,download,trusted};
