"use strict";
// The main process owns installation and settings; inference stays in the GPU queue.
const runtime=require('./cuda_runtime');
const fs=require('fs'),path=require('path');
const successful=r=>r&&r.results?.length===2&&r.results.every(x=>[32,128].includes(x.batch)&&x.validation?.passed&&x.dml?.medianMs>0&&x.cuda?.medianMs>0);
function create({dataDir,settings,save,onChange=()=>{},sendBenchmark,cancelBenchmark,canTest=()=>true,platform=process.platform}){
  let dir=runtime.runtimeDir(settings.cudaBaseDir||dataDir);const activeDir=dir;
  let state={phase:'idle',message:'',result:successful(settings.gpuBenchmark)?settings.gpuBenchmark:null},abort=null;
  let active=settings.gpuBackend==='cuda'&&runtime.installed(dir)&&state.result?'cuda':'dml';
  const publish=()=>onChange();
  const snapshot=()=>({...state,dir,activeDir,baseDir:settings.cudaBaseDir||dataDir,restartRequired:dir!==activeDir||(settings.gpuBackend==='cuda'?'cuda':'dml')!==active,downloadBytes:runtime.bytes,supported:platform==='win32',installed:runtime.installed(dir),selected:settings.gpuBackend==='cuda'?'cuda':'dml',active});
  const busy=()=>['installing','testing','cancelling'].includes(state.phase);
  const finish=m=>{
    if(!['testing','cancelling'].includes(state.phase))return;
    const cancelled=abort?.signal.aborted;abort=null;
    if(m.error||cancelled||!successful(m.result)){state={...state,phase:'error',message:cancelled?'测试已取消':m.error||'测速结果不完整，请重试'};}
    else{settings.gpuBenchmark=m.result;save();state={phase:'done',message:'对比完成，请选择计算后端；切换后重启生效。',result:m.result};}
    publish();
  };
  return {snapshot,busy,get dir(){return activeDir;},get active(){return active;},
    setDirectory(base){
      if(busy()||!canTest())return false;
      if(typeof base!=='string'||!path.isAbsolute(base)){state={...state,message:'请选择绝对路径的组件目录'};publish();return false;}
      try{fs.mkdirSync(base,{recursive:true});const probe=path.join(base,'.ad_cuda_write_'+process.pid+'_'+Date.now());const fd=fs.openSync(probe,'wx');fs.closeSync(fd);fs.unlinkSync(probe);
        settings.cudaBaseDir=base;dir=runtime.runtimeDir(base);save();state={...state,phase:'idle',message:'CUDA 组件目录已设置；新下载写入此目录。已有组件保持原位。路径改变后请应用并重启。'};publish();return true;
      }catch(e){state={...state,message:'该目录不可写，请选择 D 盘等可写目录：'+e.message};publish();return false;}
    },
    reportBackend(info){if(info?.cudaFallback){active='dml';settings.gpuBackend='dml';save();state={...state,message:info.detail};publish();}},
    async start(){
      if(busy())return;
      if(platform!=='win32'||!canTest()){state={...state,phase:'error',message:platform!=='win32'?'仅支持 Windows NVIDIA 显卡':'请在选技结束、计算线程可用时测速'};publish();return;}
      abort=new AbortController();state={...state,phase:'installing',message:'准备安装 CUDA 组件…'};publish();
      try{
        await runtime.install(dir,{signal:abort.signal,onProgress:p=>{state={...state,...p};publish();}});
        abort.signal.throwIfAborted();if(!canTest())throw Error('已开始选技，请结束后再测速');
        state={...state,phase:'testing',message:'等待当前推理结束，开始对比测速…'};publish();sendBenchmark(dir);
      }catch(e){const message=abort?.signal.aborted?'测试已取消':String(e.message||e);abort=null;state={...state,phase:'error',message};publish();}
    },
    cancel(){if(!busy()||state.phase==='cancelling')return;abort?.abort();if(state.phase==='testing'){state={...state,phase:'cancelling',message:'正在等待本次推理结束…'};cancelBenchmark();publish();}},
    progress(message){if(state.phase==='testing'){state={...state,message};publish();}},
    finish,
    select(value){
      if(busy()||!['dml','cuda'].includes(value))return false;
      if(value==='cuda'&&(!runtime.installed(dir)||!successful(state.result))){state={...state,message:'请先通过 CUDA / DirectML 对比测速'};publish();return false;}
      settings.gpuBackend=value;save();publish();return true;
    }
  };
}
module.exports={create};
