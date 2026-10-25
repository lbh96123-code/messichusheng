'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{pipeline}=require('stream/promises');
async function validFile(file,meta,hashFile){try{return (await fs.promises.stat(file)).size===meta.bytes&&await hashFile(file)===meta.sha256;}catch(_){return false;}}
async function unpack({archive,cache,manifest,offline,hashFile,signal,onProgress=()=>{}}){
 if(!await validFile(archive,offline,hashFile))throw Error('离线包 SHA256 校验失败');
 const input=await fs.promises.open(archive,'r');let position=0,completed=0;
 const read=async(n,at)=>{const b=Buffer.alloc(n);let count=0;while(count<n){const r=await input.read(b,count,n-count,at+count);if(!r.bytesRead)throw Error('离线包被截断');count+=r.bytesRead;}return b;};
 try{for(const file of manifest.files){
  signal?.throwIfAborted();const header=await read(30,position);
  if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(8)!==0||(header.readUInt16LE(6)&9)||header.readUInt32LE(18)!==file.bytes||header.readUInt32LE(22)!==file.bytes)throw Error('离线包结构与固定清单不匹配');
  const nameBytes=header.readUInt16LE(26),extraBytes=header.readUInt16LE(28),name=(await read(nameBytes,position+30)).toString('utf8');
  if(name!=='compute/downloads/'+manifest.id+'/'+file.name)throw Error('离线包包含不符合清单的文件名');
  const start=position+30+nameBytes+extraBytes,end=start+file.bytes-1;if(end>=offline.bytes)throw Error('离线包文件边界无效');
  const dest=path.join(cache,file.name);
  if(!await validFile(dest,file,hashFile)){
   const temp=dest+'.unpack.tmp',h=crypto.createHash('sha256'),source=fs.createReadStream(archive,{start,end});source.on('data',b=>h.update(b));
   await pipeline(source,fs.createWriteStream(temp),{signal});if(h.digest('hex')!==file.sha256){await fs.promises.unlink(temp);throw Error('离线组件校验失败：'+file.name);}
   try{await fs.promises.unlink(dest);}catch(e){if(e.code!=='ENOENT')throw e;}await fs.promises.rename(temp,dest);
  }
  try{await fs.promises.unlink(dest+'.part');}catch(e){if(e.code!=='ENOENT')throw e;}
  position=end+1;completed+=file.bytes;onProgress({message:'解包并校验 '+file.name,downloaded:completed,total:manifest.files.reduce((a,f)=>a+f.bytes,0)});
 }
 const central=await read(4,position);if(central.readUInt32LE(0)!==0x02014b50)throw Error('离线包目录结构无效');
 }finally{await input.close();}
}
async function fetchPackages({manifest,offline,cache,download,hashFile,signal,onProgress=()=>{}}){
 await fs.promises.mkdir(cache,{recursive:true});let complete=true;
 for(const f of manifest.files){signal?.throwIfAborted();if(!await validFile(path.join(cache,f.name),f,hashFile)){complete=false;break;}}
 if(complete){onProgress({message:'已有离线组件全部校验通过，无需下载',downloaded:offline.bytes,total:offline.bytes});return;}
 const archive=path.join(cache,offline.name),part=archive+'.part';
 if(!await validFile(archive,offline,hashFile)){
  let last=0;await download(offline,part,signal,n=>{const now=Date.now();if(now-last>500||n===offline.bytes){last=now;onProgress({message:'从插件服务器下载 CUDA 离线包（支持断点续传）',downloaded:n,total:offline.bytes});}});
  try{await fs.promises.unlink(archive);}catch(e){if(e.code!=='ENOENT')throw e;}await fs.promises.rename(part,archive);
 }
 onProgress({message:'正在校验并解包 CUDA 离线组件…',downloaded:offline.bytes,total:offline.bytes});
 await unpack({archive,cache,manifest,offline,hashFile,signal,onProgress});await fs.promises.unlink(archive);
}
module.exports={fetchPackages,unpack,validFile};
