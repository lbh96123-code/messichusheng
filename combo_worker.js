"use strict";
/* 组合版专用线程: 推演里要批量编码几百局 + 过显卡, 放单独线程, 不卡读屏识别和原推演。 */
const { parentPort, workerData } = require("worker_threads");
const C = require(workerData && workerData.combo ? workerData.combo : "./combo_local.js");
if (workerData.cudaRuntime) C.setCudaRuntime?.(workerData.cudaRuntime);
let FE = null; try { FE = require(require("path").join(__dirname, "engine", "server", "mcts_fast.js")); } catch (e) { FE = null; }   // v1.45 份额模式切换   // workerData.combo: 只给 test/combo_queue.js 注入桩用
let ready = null, readyB = 0;
let duel = null, shareMode = "expect";
function duelController() {
  if (!duel) { const { DuelController } = require(workerData.duel || "./duel_controller.js"); duel = new DuelController({diagnostic:jobDiag?(event,details)=>jobDiag.record(event,details):null}); duel.setShareMode(shareMode); }
  return duel;
}
/* v1.30: 预热(开组合版就在后台建会话+逐块显卡测速)、新任务来了取消旧任务(旧任务不再占着显卡跑到超时) */
/* v1.47 按份额模式换网络: 团队模式(optimalL/R/Both) → workerData.modelTeam(netT300), 路人 → workerData.model(netS300); 文件不在就退回路人版 */
let MODEL = workerData.model;
const ensure = bfix => {
  if (!ready || readyB !== bfix) {
    readyB=bfix;jobDiag?.record('model-init-start',{model:require('path').basename(MODEL||''),bfix,prefer:workerData.prefer});
    ready=C.init(MODEL,workerData.prefer,bfix).then(info=>{
      if(info.cudaFallback){workerData.prefer='';parentPort.postMessage({type:'gpu-backend',info});}
      jobDiag?.record('model-init-end',{ep:info.ep,dev:info.dev,bfix:info.bfix,detail:info.detail});return info;
    },e=>{jobDiag?.record('model-init-error',{stack:String(e?.stack||e)},true);throw e;});
  }
  return ready;
};
function pickModel(shareMode) { const fs0 = require("fs"); const want = (shareMode && shareMode !== "expect" && workerData.modelTeam && fs0.existsSync(workerData.modelTeam)) ? workerData.modelTeam : workerData.model;
  if (want !== MODEL) { MODEL = want; ready = null; readyB = 0; if (duel) duel.reset(); try { parentPort.postMessage({ type: "log", tag: "engine", msg: "组合版网络 → " + require("path").basename(want) }); } catch (e) { } } }
/* v1.43 任务排队(09-28): 以前"新任务一来就取消旧任务", 结果后台两步表把刚发出的决赛顶掉(用户看到"出错, 用网络档"),
   两步补算把推荐理由顶掉(理由行几乎从不出现)。现在分三类:
   · 抢占类 final/refine/job(轮到我的主计算): 取消一切在跑和排队的, 立刻跑;
   · 后台类 screen/plan: 只取消在跑/排队的后台任务, 不打断前台, 前台跑完再跑;
   · 跟随类 fate/planfinal(理由/两步补算): 谁也不取消, 排在后面按序跑, 同类只留最新一个。 */
const PRE = new Set(["final", "refine", "job", "duel"]), BG = new Set(["screen", "plan", "duelbg"]);
let running = null, warming = false, pendingWarm = null, pendingCfg = null, stopping = false, closing = false;
let pendingBenchmark=null, benchmarkActive=null;
const queue = [];
const jobDiag = workerData.diagnosticFile ? require("./crash_diagnostics.js").create(workerData.diagnosticFile, { rotate: true, cap:8*1024*1024, context: () => ({ model: require("path").basename(MODEL || ""), shareMode, warming, stopping, running: running ? { id: running.m.id, type: running.m.type, mode:running.m.mode, step: running.m.st && running.m.st.step, cancel: running.cancel, cancelReason: running.cancelReason, elapsedMs: Date.now()-running.startedAt, initMs: running.initMs } : null, queued: queue.length, native: C.nativeSnapshot?.() }) }) : null;
if (C.setDiagnosticHook) C.setDiagnosticHook((event, details, critical) => jobDiag?.record(event, details, critical));
if (jobDiag) { jobDiag.start();jobDiag.record('diagnostic-config',{schema:2,version:require('./package.json').version,platform:process.platform,arch:process.arch,node:process.versions.node,resourceAllocation:'exact-16-per-template',file:workerData.diagnosticFile,capBytes:8*1024*1024,waveLogIntervalMs:1000}); process.on("uncaughtExceptionMonitor", e => jobDiag.record("uncaught-exception", { stack: String(e && e.stack || e) }, true)); process.on("exit", code => jobDiag.record("worker-exit", { code }, true)); }
const runOne = async m => {
  const performanceProbe=jobDiag?require('./performance_diagnostics').createJobProbe():null;
  const diagnosticBefore=jobDiag?.stats();
  const job = { m, cancel: false, startedAt: Date.now(), queueMs: Date.now()-(m.queuedAt||Date.now()), initMs: 0 }; running = job; jobDiag && jobDiag.record("job-start", { id: m.id, type: m.type, mode: m.mode, step: m.st && m.st.step, budget: m.budget, queueMs: job.queueMs, context: m.context, state: m.st });
  const initialize = async b => { const t=Date.now();const info=await ensure(b);job.initMs+=Date.now()-t;job.nativeBefore=C.nativeSnapshot?.();job.device={ep:info.ep,dev:info.dev,med:info.med,bfix:info.bfix};return info; };
  const respond = msg => { job.result=msg.r;parentPort.postMessage({...msg,cancelReason:job.cancelReason,timing:{queueMs:job.queueMs,initMs:job.initMs,elapsedMs:Date.now()-job.startedAt}}); };
  try {
    const p = m.st && m.st.pool;
    const keys = p && [...(p.heroKeys || []), ...(p.basics || []), ...(p.ults || [])];
    if (!p || p.heroKeys?.length !== 12 || p.basics?.length !== 36 || p.ults?.length !== 12 || new Set(keys).size !== 60) throw new Error("无效技能池：GPU 需要互不重复的 12/36/12，保留基础推荐");
    if (m.type === "duel" || m.type === "duelbg") {
      const info = await initialize(32), controller = duelController();
      const o = { ...m.o, mode: m.mode, cancelled: () => job.cancel, budgetMs: m.budget || (m.type === "duelbg" ? 6000 : 8000) };
      o.onReady = r => { if (!job.cancel) parentPort.postMessage({ type: "duelready", id: m.id, r, ep: info.ep }); };
      let resultLogAt=-Infinity;
      o.onResult = r => { if (!job.cancel) {const now=Date.now();if(now-resultLogAt>=1000||r.complete){resultLogAt=now;jobDiag?.record("search-result",{id:m.id,complete:r.complete,newSamples:r.newSamples,reusedSamples:r.reusedSamples,elapsedMs:r.ms,top:r.rows?.slice(0,8)});}parentPort.postMessage({type:"duelready",id:m.id,r,ep:info.ep});} };
      let progressAt=0;o.onProgress = r => { if(Date.now()-progressAt>=1000){progressAt=Date.now();jobDiag?.record("search-progress",{id:m.id,...r});} };
      const r = m.type === "duelbg" ? (m.o?.continuous ? await controller.maintain(m.st, o) : await controller.background(m.st, o)) : await controller.decide(m.st, o);
      respond({ type: "done", id: m.id, r, cancelled: job.cancel, ep: info.ep + (info.dev != null ? "#" + info.dev : "") });
    } else if (m.type === "job") {
      const info = await initialize(m.bfix || m.K * m.R);
      const r = await C.decide(m.st, m.cur, m.t0, { K: m.K, R: m.R, seed: m.seed, deadline: Date.now() + m.budget, cancelled: () => job.cancel });
      respond({ type: "done", id: m.id, r, cancelled: job.cancel, ep: info.ep + (info.dev != null ? "#" + info.dev : "") });
    } else {
      const info = await initialize(m.bfix);
      const o = { ...m.o, cancelled: () => job.cancel, deadline: m.budget ? Date.now() + m.budget : 0 };
      const r = m.type === "screen" ? await C.screen(m.st, m.me, m.t0, o) : m.type === "final" ? await C.final(m.st, m.me, m.t0, m.keys, o)
        : m.type === "fate" ? await C.fate(m.st, m.me, m.t0, m.alt, m.tgt, o) : m.type === "plan" ? await C.plan(m.st, m.me, m.t0, o) : m.type === "planfinal" ? await C.planFinal(m.st, m.me, m.t0, o) : await C.refine(m.st, m.me, m.t0, o);
      respond({ type: "done", id: m.id, r, cancelled: job.cancel, ep: info.ep + (info.dev != null ? "#" + info.dev : "") });
    }
  } catch (e) { jobDiag && jobDiag.record("job-error", { id: m.id, stack: String(e && e.stack || e) }, true); ready = null; if (duel) duel.reset(); parentPort.postMessage({ type: "err", id: m.id, msg: String(e && e.stack || e) }); }
  const r=job.result,native=C.nativeSnapshot?.(),before=job.nativeBefore;
  const resources=performanceProbe?.finish();
  const diagnosticAfter=jobDiag?.stats();
  const inferenceHistogram=native&&before&&native.inferenceHistogram?native.inferenceHistogram.map((n,i)=>n-(before.inferenceHistogram?.[i]||0)):null;
  if(jobDiag)jobDiag.record('job-performance',{id:m.id,type:m.type,mode:m.mode,step:m.st?.step,shareMode,resources,diagnosticWriteMs:diagnosticAfter.writeMs-diagnosticBefore.writeMs,diagnosticRecords:diagnosticAfter.records-diagnosticBefore.records,diagnosticErrors:diagnosticAfter.errors-diagnosticBefore.errors,inferenceHistogram,histogramUpperMs:native?.histogramUpperMs,inferenceTimingScope:native?.timingScope,inferenceTimingSchema:native?.timingSchema,nativeDiagnosticMs:native&&before?native.diagnosticMs-before.diagnosticMs:null,nonInferenceWallMs:native&&before?Math.max(0,Date.now()-job.startedAt-job.initMs-(native.runMs-before.runMs)):null,nonInferenceScope:'residual wall time, includes CPU work, scheduling and diagnostic writes; not pure CPU time'});
  const budgetMs=m.type==='duel'?(m.budget||8000):null;
  jobDiag && jobDiag.record("job-end", { id: m.id, cancelled: job.cancel, cancelReason:job.cancelReason, device:job.device, queueMs:job.queueMs, initMs:job.initMs, elapsedMs:Date.now()-job.startedAt, computeMs:Date.now()-job.startedAt-job.initMs, budgetMs,searchMs:r?.ms,searchOverrunMs:budgetMs&&r?.ms!=null?Math.max(0,r.ms-budgetMs):null,inferenceCalls:native&&before?native.calls-before.calls:null, inferenceMs:native&&before?native.runMs-before.runMs:null, lifetimeMaxInferenceMs:native?.maxMs, result:r?{reason:r.reason,failure:r.failure,complete:r.complete,partial:r.partial,chosen:r.chosen,topGap:r.rows?.length>=2&&r.rows[0].win!=null&&r.rows[1].win!=null?r.rows[0].win-r.rows[1].win:null,nodes:r.nodes,newSamples:r.newSamples,reusedSamples:r.reusedSamples,requestedSamples:r.requestedSamples,legalCandidates:r.legalCandidates,searchedCandidates:r.searchedCandidates,suspendedSteps:r.suspendedSteps,resumedSteps:r.resumedSteps,calls:r.calls,top:r.rows?.slice(0,8),rounds:r.rounds}:null }); running = null; pump();
};
const applyCfg = m => { if (m.shareMode && FE && FE.setShareMode) FE.setShareMode(m.shareMode); if (m.shareMode) { pickModel(m.shareMode); if (shareMode !== m.shareMode && duel) duel.setShareMode(m.shareMode); shareMode = m.shareMode; } if (m.resetSearch && duel) duel.reset(); jobDiag?.record("config-applied",m); };
const close = async () => { if(closing)return;closing=true;jobDiag?.record("shutdown-drained",{},true);try{await C.dispose?.();jobDiag?.close("shutdown");parentPort.postMessage({type:"shutdown-ready"});parentPort.close();}catch(e){jobDiag?.record("shutdown-error",{stack:String(e?.stack||e)},true);parentPort.postMessage({type:"shutdown-error",msg:String(e)});} };
const pump = () => {
  if (running || warming) return;
  if (stopping) { close();return; }
  if (pendingCfg) { const m=pendingCfg;pendingCfg=null;applyCfg(m); }
  if (pendingBenchmark) {
    const m=pendingBenchmark;pendingBenchmark=null;warming=true;benchmarkActive={cancel:false};
    const job=benchmarkActive;
    require('./gpu_benchmark').compare({model:MODEL,runtime:m.runtime,cancelled:()=>job.cancel||stopping,onProgress:message=>parentPort.postMessage({type:'gpu-benchmark-progress',message})})
      .then(result=>parentPort.postMessage({type:'gpu-benchmark-result',result}),e=>parentPort.postMessage({type:'gpu-benchmark-result',error:String(e.message||e)}))
      .finally(()=>{benchmarkActive=null;warming=false;pump();});return;
  }
  if (pendingWarm) { const m=pendingWarm;pendingWarm=null;warming=true;const q=Date.now();ensure(m.bfix).then(info=>parentPort.postMessage({type:"warm",info,ms:Date.now()-q}),e=>{ready=null;parentPort.postMessage({type:"warm",err:String(e?.message||e).slice(0,300)});}).finally(()=>{warming=false;pump();});return; }
  if (queue.length)runOne(queue.shift());
};
const cancelRunning = (reason, incoming) => { if (!running || running.cancel) return;running.cancel=true;running.cancelReason=reason;jobDiag?.record("job-cancel",{id:running.m.id,reason,incomingId:incoming?.id,incomingType:incoming?.type,elapsedMs:Date.now()-running.startedAt}); };
/* 从队列里撤掉的任务也要回一条"已取消", 主线程那边的 Promise 才能结束(否则 COMBO_CB 里挂着不放, 发起方永远等不到) */
const dropAt = (i,reason="superseded") => { const j = queue.splice(i, 1)[0];jobDiag?.record("job-dropped",{id:j.id,type:j.type,reason,queueMs:Date.now()-(j.queuedAt||Date.now())}); parentPort.postMessage({ type: "done", id: j.id, r: null, cancelled: true, cancelReason:reason, ep: "queue" }); };
const enqueue = m => {
  m.queuedAt=Date.now();jobDiag?.record("job-enqueue",{id:m.id,type:m.type,step:m.st?.step,context:m.context});
  if (PRE.has(m.type)) { cancelRunning("foreground-preempt",m); while (queue.length) dropAt(queue.length - 1); queue.push(m); }
  else if (BG.has(m.type)) { if (running && BG.has(running.m.type)) cancelRunning("background-state-change",m); for (let i = queue.length - 1; i >= 0; i--) if (BG.has(queue[i].type)) dropAt(i); queue.push(m); }
  else { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type === m.type) dropAt(i); queue.push(m); }
  pump();
};
parentPort.on("message", async m => {
  if(m.type==='gpu-benchmark-cancel'){if(benchmarkActive)benchmarkActive.cancel=true;if(pendingBenchmark){pendingBenchmark=null;parentPort.postMessage({type:'gpu-benchmark-result',error:'测速已取消'});}return;}
  if(m.type==='gpu-benchmark'){
    if(stopping||pendingBenchmark||benchmarkActive){parentPort.postMessage({type:'gpu-benchmark-result',error:'计算线程忙，请稍后重试'});return;}
    cancelRunning('gpu-benchmark',m);while(queue.length)dropAt(queue.length-1,'gpu-benchmark');pendingBenchmark=m;pump();return;
  }
  if (m.type === "shutdown") { stopping=true;pendingWarm=null;if(pendingBenchmark){pendingBenchmark=null;parentPort.postMessage({type:'gpu-benchmark-result',error:'插件正在退出，测速已取消'});}cancelRunning("shutdown",m);while(queue.length)dropAt(queue.length-1,"shutdown");jobDiag?.record("shutdown-request",{reason:m.reason},true);pump();return; }
  if(stopping)return;
  if (m.type === "cancel") { cancelRunning(m.reason||"recognition-cancel",m); while (queue.length) dropAt(queue.length - 1,m.reason||"recognition-cancel"); return; }
  if (m.type === "cfg") { pendingCfg={...pendingCfg,...m};pump();return; }
  if (m.type === "warm") {
    pendingWarm=m;pump();
    return; }
  if (PRE.has(m.type) || BG.has(m.type) || m.type === "fate" || m.type === "planfinal") enqueue(m);
});
