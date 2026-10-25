'use strict';
const os=require('os'),path=require('path');
const {monitorEventLoopDelay,performance}=require('perf_hooks');
// Process CPU is explicitly process-wide: Node workers share a process.
function createJobProbe({cpu=process.cpuUsage,clock=()=>performance.now(),loopFactory=monitorEventLoopDelay}={}){
 let loop;try{loop=loopFactory({resolution:20});loop.enable();}catch(_){}
 const start=clock(),before=cpu();
 return {finish(){const used=cpu(before),elapsedMs=Math.max(0,clock()-start);let eventLoop=null;
  if(loop){loop.disable();eventLoop={resolutionMs:20,samples:Number(loop.count||0),meanMs:Number.isFinite(loop.mean)?loop.mean/1e6:null,maxMs:Number.isFinite(loop.max)?loop.max/1e6:null,p99Ms:Number(loop.count||0)>0?loop.percentile(99)/1e6:null};}
  return {elapsedMs,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,cpuScope:'whole process, includes other workers',eventLoop};
 }};
}
const GPU_FIELDS=['index','name','driver_version','pstate','utilization.gpu','utilization.memory','memory.used','memory.total','temperature.gpu','power.draw','power.limit','clocks.current.graphics','clocks.current.memory'];
function parseGpu(stdout){return String(stdout).trim().split(/\r?\n/).filter(Boolean).map(line=>{
 const values=line.split(',').map(s=>s.trim());if(values.length!==GPU_FIELDS.length)throw Error('Unexpected NVIDIA telemetry columns');
 return Object.fromEntries(GPU_FIELDS.map((name,i)=>[name,/^(?:N\/A|\[.*\]|Not Supported)$/i.test(values[i])?null:values[i]]));
});}
function createHardwareSampler({record,active=()=>true,platform=process.platform,execFile=require('child_process').execFile,intervalMs=15000,env=process.env}={}){
 let timer=null,busy=false,closed=false,failures=0,child=null;
 const safe=(event,details)=>{try{record(event,details);}catch(_){}};
 function sample(){
  if(closed||busy||!active()||failures>=3)return;
  busy=true;const startedAt=Date.now(),start=performance.now();
  const executable=platform==='win32'?path.join(env.SystemRoot||'C:\\Windows','System32','nvidia-smi.exe'):'nvidia-smi';
  try{child=execFile(executable,['--query-gpu='+GPU_FIELDS.join(','),'--format=csv,noheader,nounits'],{windowsHide:true,timeout:3000,maxBuffer:32768},(err,out)=>{
   busy=false;child=null;if(closed)return;
   if(err){failures++;safe('gpu-telemetry-unavailable',{attempt:failures,code:err.code||null,message:String(err.message||err).slice(0,240),disabled:failures>=3});return;}
   try{const gpus=parseGpu(out);failures=0;safe('gpu-telemetry',{startedAt,queryMs:performance.now()-start,intervalMs,scope:'whole NVIDIA adapter, includes game and other apps; not plugin-only',units:'memory MiB, temperature C, power W, clocks MHz, utilization percent',gpus});}
   catch(e){failures++;safe('gpu-telemetry-unavailable',{attempt:failures,message:e.message,disabled:failures>=3});}
  });}catch(e){busy=false;failures++;safe('gpu-telemetry-unavailable',{attempt:failures,message:String(e.message||e).slice(0,240),disabled:failures>=3});}
 }
 function start(){if(timer||closed)return;const cpus=os.cpus();safe('machine-performance-info',{diagnosticRevision:'20261022',platform,release:os.release(),arch:os.arch(),cpuModel:cpus[0]?.model,logicalCPUs:cpus.length,totalMemoryBytes:os.totalmem(),freeMemoryBytes:os.freemem(),node:process.versions.node,electron:process.versions.electron||null,telemetryIntervalMs:intervalMs});
  if(platform!=='win32'){safe('gpu-telemetry-unavailable',{reason:'automatic telemetry enabled on Windows only'});return;}
  sample();timer=setInterval(sample,intervalMs);timer.unref?.();
 }
 function stop(){closed=true;if(timer)clearInterval(timer);timer=null;try{child?.kill();}catch(_){}child=null;}
 function setIntervalMs(ms){intervalMs=Math.max(1000,Number(ms)||15000);if(timer){clearInterval(timer);timer=setInterval(sample,intervalMs);timer.unref?.();}safe('gpu-telemetry-interval',{intervalMs});}
 return {start,sample,stop,setIntervalMs};
}
module.exports={createJobProbe,createHardwareSampler,parseGpu,GPU_FIELDS};
