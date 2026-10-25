'use strict';
const {parentPort,workerData}=require('worker_threads');
let cancelled=false;
const detail=workerData.detailedLogs!==false&&workerData.detailFile?require('./detail_log').create(workerData.detailFile,{context:()=>({benchmark:true,model:require('path').basename(workerData.model)})}):null;
parentPort.on('message',m=>{if(m.type==='cancel')cancelled=true;});
require('./gpu_benchmark').compare({...workerData,onDiagnostic:detail?(event,details)=>detail.record(event,details):null,cancelled:()=>cancelled,onProgress:message=>parentPort.postMessage({type:'gpu-benchmark-progress',message})})
 .then(async result=>{detail?.record('benchmark-result',result);await detail?.close();parentPort.postMessage({type:'gpu-benchmark-result',result});},async e=>{detail?.record('benchmark-error',{message:String(e.message||e)});await detail?.close();parentPort.postMessage({type:'gpu-benchmark-result',error:String(e.message||e)});})
 .finally(()=>parentPort.close());
