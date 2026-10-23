'use strict';
const {parentPort,workerData}=require('worker_threads');
let cancelled=false;
parentPort.on('message',m=>{if(m.type==='cancel')cancelled=true;});
require('./gpu_benchmark').compare({...workerData,cancelled:()=>cancelled,onProgress:message=>parentPort.postMessage({type:'gpu-benchmark-progress',message})})
 .then(result=>parentPort.postMessage({type:'gpu-benchmark-result',result}),e=>parentPort.postMessage({type:'gpu-benchmark-result',error:String(e.message||e)}))
 .finally(()=>parentPort.close());
