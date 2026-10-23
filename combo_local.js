"use strict";
/* v1.29「组合版」本地实现: 推演框架(现役 AI 同款增量打分引擎) + 推演里双方都按网络出手(ONNX, 优先本机显卡 DirectML)。
   每手: 网络概率前 K 个候选, 各推演 R 局到满编, 取行动方平均胜率最高者。所有推演局一起按"手"批量过网络。
   参数 K/R 可调;自动降档: 一手超过预算就把 R 减半(最低 8), R=8 仍超预算 → 本局退回网络档(由调用方处理)。 */
const path = require("path");
const E = path.join(__dirname, "engine", "server");
const AI = require(E + "/ai.js"), F = require(E + "/mcts_fast.js");
const CAPK = [1, 3, 1];
let ort = null, sess = null, EP = null, DEV = null, BFIX = 0, INFO = null, MED = null, FP16 = false;
let sessionModel = null, sessionPreference = null;
let cudaRuntime = null, ortKind = null;
const native = require('./native_monitor').create();
const nativeRun = (session, feeds) => native.call('infer', { batch: feeds.ids.dims[0] }, () => session.run(feeds));
const modelFingerprints=new Map();
function modelFingerprint(model){try{if(!modelFingerprints.has(model)){const fs=require('fs'),bytes=fs.readFileSync(model);modelFingerprints.set(model,{sha256:require('crypto').createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}return modelFingerprints.get(model);}catch(e){return {unavailable:String(e.message||e).slice(0,160)};}}
const nativeCreate = (model, options) => native.call('session-create', { model: path.basename(model), fingerprint:modelFingerprint(model), providers: options.executionProviders, batch: options.freeDimensionOverrides.B,graphOptimizationLevel:options.graphOptimizationLevel,executionMode:options.executionMode,enableMemPattern:options.enableMemPattern,intraOpNumThreads:options.intraOpNumThreads??null,runtimeVersion:(()=>{if(ortKind==='cuda')return '1.23.2 (private Python)';try{return require('onnxruntime-node/package.json').version;}catch(_){return null;}})() }, () => ort.InferenceSession.create(model, options));
const nativeRelease = session => native.call('session-release', {}, () => session.release());
/* v1.30: ① 批大小固定(freeDimensionOverrides B=BFIX): 模型里 20 个 Shape/34 个 Concat 等"现算形状"的节点在建会话时就折叠掉
   (369→209 节点), DirectML 上这些节点落在 CPU, 每次调用中途要显卡↔CPU 来回倒;不够一批的补齐(复制第 0 行, 结果丢掉)。
   ② DirectML 逐块显卡(deviceId 0..3)建会话实测, 选最快的 —— 防 Windows 把插件分到核显。每块的结果都写日志。 */
function dummyBuf(B) { const b = mkBuf(B); for (let i = 0; i < B * 60; i++) { b.ids[i] = (i * 7) % 600; b.legal[i] = 1; b.delta[i] = ((i % 13) - 6) / 10; } b.t.fill(10); return b; }
async function benchSess(s, B) {
  HAS_EXT = (s.inputNames || []).includes("ext");
  const b = dummyBuf(B), f = feedsOf(b, B), beforeFirst=native.snapshot().runMs,t0 = Date.now(); await nativeRun(s, f); const first = Date.now() - t0, firstInferenceMs=native.snapshot().runMs-beforeFirst,a = [],inferenceRuns=[];
  for (let i = 0; i < 5; i++) { const before=native.snapshot().runMs,q = Date.now(); await nativeRun(s, f); a.push(Date.now() - q);inferenceRuns.push(native.snapshot().runMs-before); }
  const runs=[...a];a.sort((x, y) => x - y); return { first, med: a[2],runs,inferenceRuns,firstInferenceMs,mean:a.reduce((n,x)=>n+x,0)/a.length,min:a[0],max:a[a.length-1] };
}
async function init(modelPath, prefer, bfix) {
  await native.waitIdle();
  bfix = bfix || 128;
  if (sess && BFIX === bfix && sessionModel === modelPath && sessionPreference === prefer) return INFO;
  if (sess) { await nativeRelease(sess); sess = null; } FP16 = false;
  const privateCuda = process.platform === 'win32' && prefer === 'cuda';
  const kind = privateCuda ? 'cuda' : 'node';
  if (!ort || ortKind !== kind) { ort = privateCuda ? require('./cuda_bridge').create(cudaRuntime) : require('onnxruntime-node'); ortKind = kind; }
  const T0 = Date.now(), base = { graphOptimizationLevel: "all", freeDimensionOverrides: { B: bfix } }, notes = [];
  if (process.env.AD_COMBO_THREADS) base.intraOpNumThreads = +process.env.AD_COMBO_THREADS;
  if (prefer !== "cpu") {
    const gpu = privateCuda ? 'cuda' : process.platform === "win32" ? "dml" : "cuda";
    let best = null;
    for (let d = 0; d < 4; d++) {
      let s = null; const q = Date.now();
      try { s = await nativeCreate(modelPath, { ...base, executionProviders: [{ name: gpu, deviceId: d }], enableMemPattern: false, executionMode: "sequential" }); }
      catch (e) { if (d === 0) notes.push(`${gpu}显卡0 建不起来: ${String(e && e.message || e).slice(0, 120)}`); break; }
      const tc = Date.now() - q; let b = null;
      try { b = await benchSess(s, bfix); } catch (e) { notes.push(`显卡${d} 试跑出错 ${String(e && e.message || e).slice(0, 80)}`); try { await nativeRelease(s); } catch (e2) { } continue; }
      // Reuse the existing five fixed-input runs; no extra benchmark workload.
      native.record('fixed-input-benchmark',{model:path.basename(modelPath),fingerprint:modelFingerprint(modelPath),ep:gpu,dev:d,batch:bfix,precision:'fp32',firstMs:b.first,runsMs:b.runs,inferenceRunsMs:b.inferenceRuns,firstInferenceMs:b.firstInferenceMs,meanMs:b.mean,minMs:b.min,medianMs:b.med,maxMs:b.max,scope:'startup fixed input; inferenceRunsMs excludes diagnostic hooks; runsMs retains legacy selection timing; includes runtime/driver/scheduling',samples:5});
      notes.push(`显卡${d}: 建会话${tc}ms 首跑${b.first}ms 每次${b.med}ms`);
      if (!best || b.med < best.med) { if (best) try { await nativeRelease(best.s); } catch (e) { } best = { s, d, med: b.med }; } else try { await nativeRelease(s); } catch (e) { }
      if (gpu === "cuda") break;
    }
    if (best) { sess = best.s; EP = gpu; DEV = best.d; MED = best.med; notes.push(`选用显卡${best.d}`);
      /* v1.38 半精度: 同一块显卡再建一个半精度会话测速, 快 10% 以上才换(09-23 4090 CUDA 实测快 1.3~1.7 倍;
         三局约 700 个真实局面出手概率最大差 0.84pp、首选一致 99.6%+, 新流程端到端损失与单精度无差别)。建不起来/出错就留单精度。 */
      const m16 = modelPath.replace(/\.onnx$/, "_fp16.onnx");
      if (m16 !== modelPath && !process.env.AD_NO_FP16 && require("fs").existsSync(m16)) {
        let s16 = null;
        try { s16 = await nativeCreate(m16, { ...base, executionProviders: [{ name: gpu, deviceId: best.d }], enableMemPattern: false, executionMode: "sequential" });
          const b16 = await benchSess(s16, bfix); notes.push(`半精度: 每次${b16.med}ms`);
          native.record('fixed-input-benchmark',{model:path.basename(m16),fingerprint:modelFingerprint(m16),ep:gpu,dev:best.d,batch:bfix,precision:'fp16',firstMs:b16.first,runsMs:b16.runs,inferenceRunsMs:b16.inferenceRuns,firstInferenceMs:b16.firstInferenceMs,meanMs:b16.mean,minMs:b16.min,medianMs:b16.med,maxMs:b16.max,scope:'startup fixed input; inferenceRunsMs excludes diagnostic hooks; runsMs retains legacy selection timing; includes runtime/driver/scheduling',samples:5});
          if (b16.med < best.med * 0.9) { await nativeRelease(sess); sess = s16; MED = b16.med; FP16 = true; notes.push("选用半精度"); s16 = null; }
          else notes.push("半精度不够快, 留单精度");
        } catch (e) { notes.push(`半精度建不起来, 留单精度: ${String(e && e.message || e).slice(0, 100)}`); }
        if (s16) try { await nativeRelease(s16); } catch (e) { }
      }
    }
  }
  if (!sess && privateCuda) {
    const why=notes.join(' | ');const info=await init(modelPath,undefined,bfix);sessionPreference=prefer;
    return INFO={...info,cudaFallback:true,detail:'CUDA 不可用，已恢复原计算路径: '+why+' | '+info.detail};
  }
  if (!sess) { sess = await nativeCreate(modelPath, { ...base, executionProviders: ["cpu"] }); EP = "cpu"; DEV = null;
    const b = await benchSess(sess, bfix); MED = b.med; notes.push(`CPU: 首跑${b.first}ms 每次${b.med}ms`); }
  BFIX = bfix; PAD = null; PBUF = null; HAS_EXT = (sess.inputNames || []).includes("ext");
  if (HAS_EXT) {   /* v1.40 新网络(netC300)多 3 项输入: 需要训练用的两两配合表 pairP.bin(640×640 float32, 下标 = 打分模型 key 顺序, 与 items[i].p 一致) */
    const b = require("fs").readFileSync(path.join(path.dirname(modelPath), "pairP.bin")); PN = Math.round(Math.sqrt(b.length / 4));
    PAIR = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); notes.push(`新输入配合表 ${PN}×${PN}`); }
  INFO = { ep: EP + (FP16 ? "·半精度" : ""), dev: DEV, bfix, med: MED, fp16: FP16, detail: notes.join(" | "), ms: Date.now() - T0 };
  sessionModel = modelPath; sessionPreference = prefer;
  return INFO;
}
function ownerOf(st, sim, cur) {
  const n = sim.items.length, own = new Int8Array(n).fill(-1), byKey = new Map(sim.items.map((x, i) => [x.key, i]));
  st.seats.forEach((s, si) => { for (const k of [s.hero, ...(s.basics || []), s.ult]) { const i = k == null ? undefined : byKey.get(k); if (i !== undefined) own[i] = si; } });
  for (let i = 0; i < n; i++) if (own[i] < 0 && sim.taken[i]) own[i] = cur < 5 ? 5 + cur % 5 : cur % 5;   // 拿走但不知归谁: 当对面的
  return own;
}
/* 把 B 个推演局当前局面编码进网络输入(同一手, 行动座位相同) */
function encode(sims, owns, tAbs, buf) { encodeRange(sims, owns, tAbs, buf, 0); }
function encodeRange(sims, owns, tAbs, buf, base) {
  const B = sims.length, s0 = sims[0], seat = s0.order[s0.step], mySide = seat < 5;
  for (let k = 0; k < B; k++) {
    const b = base + k, sim = sims[k], own = owns[k], o = b * 60;
    for (let i = 0; i < 60; i++) {
      const it = sim.items[i], ow = own[i];
      if (!it) throw new Error("无效技能池：不足 60 项，停止 GPU 编码");
      buf.ids[o + i] = it.p >= 0 ? it.p : 640;
      const rel = ow < 0 ? 0 : ((ow % 5 - seat % 5) + 5) % 5;
      buf.code[o + i] = ow < 0 ? 0 : ((ow < 5) === mySide ? 1 + rel : 6 + rel);
      const lg = !sim.taken[i] && it.p >= 0 && sim.slot[seat * 3 + it.kind] < CAPK[it.kind];
      buf.legal[o + i] = lg ? 1 : 0;
      buf.delta[o + i] = lg ? (mySide ? 1 : -1) * F.deltaOf(sim, i) : 0;
    }
    if (HAS_EXT) extFill(sim, own, seat, buf, b);
    buf.t[b] = tAbs; buf.seat[b] = seat;
    buf.slot[b * 3] = sim.slot[seat * 3]; buf.slot[b * 3 + 1] = sim.slot[seat * 3 + 1]; buf.slot[b * 3 + 2] = sim.slot[seat * 3 + 2];
  }
}
const W_OF = { ids: 60, code: 60, delta: 60, legal: 60, t: 1, seat: 1, slot: 3, ext: 180 };
function feedsOf(b, B) {
  const T = (a, t, d) => { const n = d.reduce((x, y) => x * y, 1); let v = a.subarray(0, n);
    if (v.buffer instanceof SharedArrayBuffer) v = v.slice(); return new ort.Tensor(t, v, d); };
  return { ids: T(b.ids, "int32", [B, 60]), code: T(b.code, "int32", [B, 60]), delta: T(b.delta, "float32", [B, 60]),
    legal: T(b.legal, "float32", [B, 60]), t: T(b.t, "int32", [B]), seat: T(b.seat, "int32", [B]), slot: T(b.slot, "int32", [B, 3]), ...(HAS_EXT ? { ext: T(b.ext, "float32", [B, 60, 3]) } : {}) };
}
/* 每次调用的耗时构成(decide 开头清零): 打包=拷贝补齐+建张量, 运行=sess.run(含上传/下载) */
let PAD = null, PBUF = null; const ST = { calls: 0, build: 0, run: 0, runs: [] };
function statReset() { ST.calls = 0; ST.build = 0; ST.run = 0; ST.runs = []; }
function statOut() { const a = ST.runs.slice().sort((x, y) => x - y);
  return { calls: ST.calls, tBuild: ST.build, tRun: ST.run, first: ST.runs[0] || 0, med: a.length ? a[a.length >> 1] : 0, max: a.length ? a[a.length - 1] : 0 }; }
async function logits(buf, B) {
  if (process.env.AD_COMBO_FAKE) return new Float32Array(B * 60);   // 只测 CPU 部分: 网络输出全 0(=合法里均匀抽)
  const out = new Float32Array(B * 60);
  for (let b0 = 0; b0 < B; b0 += BFIX) {   // 超过一批就分段;不够一批补齐到 BFIX
    const n = Math.min(BFIX, B - b0), q = Date.now();
    if (!PAD) PAD = mkBuf(BFIX);
    for (const k in W_OF) { const w = W_OF[k], src = buf[k], dst = PAD[k];
      dst.set(src.subarray(b0 * w, (b0 + n) * w), 0);
      for (let r = n; r < BFIX; r++) dst.copyWithin(r * w, 0, w); }
    const f = feedsOf(PAD, BFIX), q2 = Date.now(); ST.build += q2 - q;
    const r = await nativeRun(sess, f), dt = Date.now() - q2; ST.run += dt; ST.runs.push(dt); ST.calls++;
    out.set(r.logits.data.subarray(0, n * 60), b0 * 60);
  }
  return out;
}
/* 多线程共享缓冲: 一块 SharedArrayBuffer 切成各输入 + logits */
const LAYOUT = [["ids", Int32Array, 60], ["code", Int32Array, 60], ["delta", Float32Array, 60], ["legal", Float32Array, 60], ["t", Int32Array, 1], ["seat", Int32Array, 1], ["slot", Int32Array, 3], ["logits", Float32Array, 60]];
function mkShared(B) { let n = 0; for (const [, , w] of LAYOUT) n += 4 * B * w; return { sab: new SharedArrayBuffer(n), B }; }
function views(sh) { const out = {}; let off = 0; for (const [k, T, w] of LAYOUT) { out[k] = new T(sh.sab, off, sh.B * w); off += 4 * sh.B * w; } return out; }
const mkBuf = B => ({ ids: new Int32Array(B * 60), code: new Int32Array(B * 60), delta: new Float32Array(B * 60), legal: new Float32Array(B * 60),
  t: new Int32Array(B), seat: new Int32Array(B), slot: new Int32Array(B * 3), ext: new Float32Array(B * 180) });
/* v1.30 硬依赖: 根节点候选里, 座位缺条件件的依赖者概率 ×e^-4(与网络档/现役同一张 hard_deps.json) */
const DEP_NET = Math.exp(-4);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
/* st/cur/t0 同 worker.js buildState 的结果;返回 {rows:[{key, net, win}], ms, K, R, ep} */
async function decide(st, cur, t0, o = {}) {
  const K = o.K || 8, R = o.R || 64, seed = o.seed || 12345, T0 = Date.now(), rnd = rng(seed);
  const sim0 = AI._simFrom(st), own0 = ownerOf(st, sim0, cur);
  if (F.simDone(sim0)) return null;
  statReset(); let steps = 0;
  const root = mkBuf(1); encode([sim0], [own0], t0, root);
  const lg0 = await logits(root, 1);
  let mx = -Infinity; for (let i = 0; i < 60; i++) if (root.legal[i] && lg0[i] > mx) mx = lg0[i];
  let Z = 0; const pr = new Float64Array(60); for (let i = 0; i < 60; i++) if (root.legal[i]) { pr[i] = Math.exp(lg0[i] - mx) * (F.depBlocked && F.depBlocked(sim0, i) ? DEP_NET : 1); Z += pr[i]; }
  const cand = [...Array(60).keys()].filter(i => root.legal[i]).sort((a, b) => pr[b] - pr[a]).slice(0, K);
  const rows = cand.map(i => ({ key: sim0.items[i].key, net: pr[i] / Z, win: null }));
  if (cand.length <= 1 || sim0.step >= sim0.order.length - 1) return { rows, ms: Date.now() - T0, K, R, ep: EP };
  const sims = [], owns = [], ci = [];
  for (let c = 0; c < cand.length; c++) for (let r = 0; r < R; r++) {
    const s = F.cloneSim(sim0); F.applySim(s, cand[c]); const ow = Int8Array.from(own0); ow[cand[c]] = cur; sims.push(s); owns.push(ow); ci.push(c); }
  const B = sims.length, buf = mkBuf(B); let tAbs = t0 + 1, tEnc = 0, tNet = 0, tAp = 0, nPass = 0;
  const stat = () => ({ steps, B, bfix: BFIX, dev: DEV, tEnc, tNet, tAp, nPass, ...statOut() });
  while (!F.simDone(sims[0])) {
    if (o.cancelled && o.cancelled()) return { rows, ms: Date.now() - T0, K, R, ep: EP, cancelled: true, ...stat() };
    if (o.deadline && Date.now() > o.deadline) return { rows, ms: Date.now() - T0, K, R, ep: EP, timeout: true, ...stat() };
    let q = Date.now(); encode(sims, owns, Math.min(49, tAbs), buf); tEnc += Date.now() - q;
    q = Date.now(); const L = await logits(buf, B), seat = sims[0].order[sims[0].step]; tNet += Date.now() - q; q = Date.now();
    for (let b = 0; b < B; b++) {
      const o6 = b * 60; let m2 = -Infinity; for (let i = 0; i < 60; i++) if (buf.legal[o6 + i] && L[o6 + i] > m2) m2 = L[o6 + i];
      let z = 0; for (let i = 0; i < 60; i++) if (buf.legal[o6 + i]) z += Math.exp(L[o6 + i] - m2);
      let u = rnd() * z, pick = -1; for (let i = 0; i < 60; i++) if (buf.legal[o6 + i]) { pick = i; u -= Math.exp(L[o6 + i] - m2); if (u <= 0) break; }
      if (pick < 0) { nPass++; F.passSim(sims[b]); continue; }   // 这个座位没有合法候选了(如只差英雄而英雄格已被拿光): 空过这一手
      F.applySim(sims[b], pick); owns[b][pick] = seat;
    }
    tAp += Date.now() - q; tAbs++; steps++;
  }
  const sum = new Float64Array(cand.length), sg = cur < 5 ? 1 : -1;
  for (let b = 0; b < B; b++) sum[ci[b]] += 1 / (1 + Math.exp(-sg * sims[b].z));
  rows.forEach((r, c) => r.win = sum[c] / R);
  rows.sort((a, b) => b.win - a.win);
  return { rows, ms: Date.now() - T0, K, R, ep: EP, ...stat() };
}
/* 多线程版: 推演局分给 N 个分片线程(combo_sub.js), 本线程只跑网络。N 默认 = CPU 核数 − 2(1~8)。 */
let SUBS = null;
function subs(n) {
  if (SUBS && SUBS.length === n) return SUBS;
  if (SUBS) SUBS.forEach(w => w.terminate());
  const { Worker } = require("worker_threads");
  SUBS = Array.from({ length: n }, () => { const w = new Worker(path.join(__dirname, "combo_sub.js")); w.setMaxListeners(0); return w; });
  return SUBS;
}
const ask = (w, msg) => new Promise((res, rej) => { const f = m => { w.off("message", f); m.type === "err" ? rej(new Error(m.msg)) : res(m); }; w.on("message", f); w.postMessage(msg); });
async function decideMT(st, cur, t0, o = {}) {
  const os = require("os"), NT = Math.max(1, Math.min(8, o.threads || (os.cpus().length - 2)));
  if (NT <= 1) return decide(st, cur, t0, o);
  const K = o.K || 8, R = o.R || 64, seed = o.seed || 12345, T0 = Date.now();
  const sim0 = AI._simFrom(st), own0 = ownerOf(st, sim0, cur);
  if (F.simDone(sim0)) return null;
  const root = mkBuf(1); encode([sim0], [own0], t0, root);
  const lg0 = await logits(root, 1);
  let mx = -Infinity; for (let i = 0; i < 60; i++) if (root.legal[i] && lg0[i] > mx) mx = lg0[i];
  let Z = 0; const pr = new Float64Array(60); for (let i = 0; i < 60; i++) if (root.legal[i]) { pr[i] = Math.exp(lg0[i] - mx) * (F.depBlocked && F.depBlocked(sim0, i) ? DEP_NET : 1); Z += pr[i]; }
  const cand = [...Array(60).keys()].filter(i => root.legal[i]).sort((a, b) => pr[b] - pr[a]).slice(0, K);
  const rows = cand.map(i => ({ key: sim0.items[i].key, net: pr[i] / Z, win: null }));
  if (cand.length <= 1 || sim0.step >= sim0.order.length - 1) return { rows, ms: Date.now() - T0, K, R, ep: EP, threads: NT };
  const B = cand.length * R, sh = mkShared(B), buf = views(sh), W = subs(NT), per = Math.ceil(B / NT);
  const parts = W.map((w, i) => [i * per, Math.min(B, (i + 1) * per)]).filter(([a, b]) => a < b);
  let tEnc = 0, tNet = 0, nPass = 0, q = Date.now();
  let st8 = await Promise.all(parts.map(([b0, b1], i) => ask(W[i], { type: "start", st, cur, cands: cand, R, b0, b1, seed, sab: sh, t0 })));
  tEnc += Date.now() - q; let tAbs = t0 + 1, sums = null;
  while (true) {
    if (o.deadline && Date.now() > o.deadline) return { rows, ms: Date.now() - T0, K, R, ep: EP, threads: NT, timeout: true };
    buf.t.fill(Math.min(49, tAbs)); buf.seat.fill(buf.seat[0]);
    q = Date.now(); const L = await logits(buf, B); buf.logits.set(L); tNet += Date.now() - q;
    tAbs++; q = Date.now();
    st8 = await Promise.all(parts.map((p, i) => ask(W[i], { type: "step", tAbs: Math.min(49, tAbs) })));
    tEnc += Date.now() - q;
    if (st8.every(x => x.done && x.sum)) { sums = new Float64Array(cand.length); st8.forEach(x => x.sum.forEach((v, c) => sums[c] += v)); nPass = st8.reduce((a, x) => a + (x.nPass || 0), 0); break; }
  }
  rows.forEach((r, c) => r.win = sums[c] / R); rows.sort((a, b) => b.win - a.win);
  return { rows, ms: Date.now() - T0, K, R, ep: EP, threads: NT, tEnc, tNet, nPass };
}

/* ===================== v1.38 新方案: 后台筛选 → 轮到时决赛 → 更新一次 =====================
   09-23 三局 150 个决策点验证(耗时按 3060): 现行(网络前 8 × 16 局)平均比"全部候选算足"少 0.32pp;
   后台筛选(全部 × 8 → 前 6 × 32) + 决赛前 5 × 32 → 0.17pp; 再用准确局面全部重算、更新一次 → 0.09pp。
   · 筛选从**当前真实局面**推演: 我前面那几手别人按网络选、但不许拿我正在评估的候选; 轮到我那一步强制拿它, 再推演到底。
   · 同一局面只算一次网络(局面 = 60 件东西各归谁; 起点相同时它完全决定网络输入), 结果与逐局算逐位相同。
   · 复用: 筛选里我之前那几手恰好和真实发生的一样的推演局, 就是准确局面下的有效样本 —— 决赛/更新直接并进来。 */
const CAPK3 = [1, 3, 1];
const ownKey = (own, extra) => Buffer.from(own.buffer, own.byteOffset, own.length).toString("latin1") + (extra == null ? "" : "|" + extra);
/* 一批推演: sim0/own0 = 起点; forceAt = 起点之后第几步轮到我(0 = 起点就是我); cs[b] = 第 b 局强制我拿的候选下标。
   返回每局的胜率(我方视角)和我之前那几步各拿了什么(复用时比对用)。 */
const PROF = { dedup: 0, enc: 0, samp: 0, wait: 0 };
const mix32 = x => { x = (x + 0x9e3779b9) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0; x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0; return ((x ^ (x >>> 16)) >>> 0) || 1; };
/* 第 b 局自己的随机数流(与分几个线程无关 → 单线程/多线程结果逐位相同) */
/* v1.39: 旧写法 (seed>>>0)*0x9e3779b1 + b 是浮点乘法, 插件的种子(英雄池哈希, ~1e8)乘出来 ~1e17 > 2^53, "+ b" 被舍入掉 →
   一批里所有推演局同一串随机数(160 局平均只有 5.8 串), 每个候选实际只推了一两局, 名次等于抽签(09-24 R2 陵卫斗篷/R3 冰霜新星)。
   09-23 验证与回归都用小种子(5/6/7), 所以没发现。改成 32 位整数乘法后再加局号。回归 test/simrng_seed.js */
const simRng = (seed, b) => rng(mix32((Math.imul(seed >>> 0, 0x9e3779b1) + b) >>> 0));
async function rollouts(sim0, own0, me, forceAt, cs, seed, o = {}) {
  const B = cs.length, T0 = Date.now(); if (!B) return { v: new Float64Array(0), pre: new Int16Array(0), steps: 0, calls: 0, tot: 0, uniq: 0, ms: 0 };
  const NT = o.threads | 0;
  if (NT > 1 && B >= 64 && !o.nodedup) return rolloutsMT(sim0, own0, me, forceAt, cs, seed, o, NT);
  /* v1.41 两步计划: o.yb[b] = 这一局"我下次轮到时回手拿"的件(-1 不管); o.crn = 配对随机数(各线的第 r 局共用一串随机数, 比较时噪音互相抵消, 09-25 实测差值标准差 1.27→0.97pp) */
  const CRN = !!o.crn, YB = o.yb || null; let nextDone = false;
  const rngs = new Array(B); { const cnt = new Map(); for (let b = 0; b < B; b++) { let r = b; if (CRN) { const key = cs[b] + "|" + (YB ? YB[b] : -1); r = cnt.get(key) || 0; cnt.set(key, r + 1); } rngs[b] = simRng(seed, r); } }
  const sims = new Array(B), owns = new Array(B);
  for (let b = 0; b < B; b++) { sims[b] = F.cloneSim(sim0); owns[b] = Int8Array.from(own0); }
  const pre = new Int16Array(B * Math.max(1, forceAt)).fill(-1);
  let forced = false, k = 0, steps = 0, tot = 0, uniq = 0, calls0 = ST.calls; const tAbs0 = o.t0 || 0;
  const force = () => { for (let b = 0; b < B; b++) { F.applySim(sims[b], cs[b]); owns[b][cs[b]] = me; } forced = true; };
  if (forceAt === 0) { force(); k = 1; }   // 起点就是我: 强制落子占第 t0 手, 之后从 t0+1 手开始推演(与旧版 decide 一致)
  while (!F.simDone(sims[0])) {
    if (o.cancelled && o.cancelled()) return null;
    if (o.deadline && Date.now() > o.deadline) return { timeout: true };
    if (!forced && k === forceAt) { force(); k++; continue; }
    const seat = sims[0].order[sims[0].step];
    /* 去重: 同一局面只编码、只过网络一次 */
    const qd = Date.now(); const idx = new Map(), rep = [], map = new Int32Array(B);
    for (let b = 0; b < B; b++) { const key = o.nodedup ? b : ownKey(owns[b], forced ? null : cs[b]); let r = idx.get(key);   // nodedup 只给回归测试用
      if (r === undefined) { r = rep.length; idx.set(key, r); rep.push(b); } map[b] = r; }
    const n = rep.length; tot += B; uniq += n; PROF.dedup += Date.now() - qd;
    /* ③ 分块流水: 显卡算第 c 块时, CPU 编码第 c+1 块 / 给第 c-1 块抽样。一次只有一块在显卡上;
       每局的随机数在这一步开头按局号顺序先抽好, 所以结果与不分块逐位相同。 */
    const U = new Float64Array(B); for (let b = 0; b < B; b++) U[b] = rngs[b]();
    const nch = Math.ceil(n / BFIX), byChunk = Array.from({ length: nch }, () => []);
    for (let b = 0; b < B; b++) byChunk[Math.floor(map[b] / BFIX)].push(b);
    if (!PBUF) PBUF = [mkBuf(BFIX), mkBuf(BFIX)];
    const encChunk = c => { const pb = PBUF[c & 1], r0 = c * BFIX, m = Math.min(BFIX, n - r0), q = Date.now();
      encodeRange(rep.slice(r0, r0 + m).map(b => sims[b]), rep.slice(r0, r0 + m).map(b => owns[b]), Math.min(49, tAbs0 + k), pb, 0);
      if (!forced) for (let r = 0; r < m; r++) pb.legal[r * 60 + cs[rep[r0 + r]]] = 0;   // 轮到我之前别人不许拿走我要评估的那件
      for (const key in W_OF) { const w = W_OF[key]; for (let r = m; r < BFIX; r++) pb[key].copyWithin(r * w, 0, w); }   // 不够一批补齐(复制第 0 行, 结果丢掉)
      ST.build += Date.now() - q; PROF.enc += Date.now() - q; return m; };
    const runChunk = c => { const q = Date.now(); ST.calls++;
      if (process.env.AD_COMBO_FAKE) return Promise.resolve({ L: new Float32Array(BFIX * 60), q });
      return nativeRun(sess, feedsOf(PBUF[c & 1], BFIX)).then(r => { const dt = Date.now() - q; ST.run += dt; ST.runs.push(dt); return { L: r.logits.data, q }; }); };
    const sampleChunk = (c, L) => { const qs = Date.now(); try { return sampleChunk0(c, L); } finally { PROF.samp += Date.now() - qs; } };
    const sampleChunk0 = (c, L) => { const pb = PBUF[c & 1], r0 = c * BFIX, m = Math.min(BFIX, n - r0);
      const cum = new Float64Array(m * 60), Z = new Float64Array(m);
      for (let r = 0; r < m; r++) { const o6 = r * 60; let mx = -Infinity; for (let i = 0; i < 60; i++) if (pb.legal[o6 + i] && L[o6 + i] > mx) mx = L[o6 + i];
        let z = 0; for (let i = 0; i < 60; i++) { if (pb.legal[o6 + i]) z += Math.exp(L[o6 + i] - mx); cum[o6 + i] = z; } Z[r] = z; }
      for (const b of byChunk[c]) { const r = map[b] - r0, o6 = r * 60;
        if (!(Z[r] > 0)) { F.passSim(sims[b]); continue; }
        const u = U[b] * Z[r]; let pick = -1; for (let i = 0; i < 60; i++) if (pb.legal[o6 + i] && cum[o6 + i] >= u) { pick = i; break; }
        if (pick < 0) { F.passSim(sims[b]); continue; }
        if (YB && forced && seat === me && !nextDone) { const y = YB[b]; if (y >= 0 && !sims[b].taken[y] && sims[b].items[y].p >= 0 && sims[b].slot[me * 3 + sims[b].items[y].kind] < CAPK[sims[b].items[y].kind]) pick = y; }   // 回手: Y 还在就拿 Y, 不在就按网络
        F.applySim(sims[b], pick); owns[b][pick] = seat; if (!forced && k < forceAt) pre[b * forceAt + k] = pick; } };
    /* 编码 c → 等 c-1 算完 → 发 c → 给 c-1 抽样(此时显卡在算 c) */
    let inflight = null;
    if (process.env.AD_NOPIPE) { for (let c = 0; c < nch; c++) { encChunk(c); const res = await runChunk(c); sampleChunk(c, res.L); } }   // 只给测速对照用: 不分块流水
    else for (let c = 0; c < nch; c++) {
      encChunk(c);
      const qw = Date.now(); const prev = inflight ? await inflight : null; PROF.wait += Date.now() - qw;
      inflight = runChunk(c);
      if (prev) sampleChunk(c - 1, prev.L);
    }
    if (inflight) { const qw = Date.now(); const last = await inflight; PROF.wait += Date.now() - qw; sampleChunk(nch - 1, last.L); }
    if (forced && seat === me) nextDone = true;
    k++; steps++;
  }
  if (process.env.AD_MT_PROF) { console.log(`[单线程] 共${Date.now() - T0}ms = 去重${PROF.dedup} + 编码${PROF.enc} + 抽样落子${PROF.samp} + 等显卡${PROF.wait}`); for (const k in PROF) PROF[k] = 0; }
  const sg = me < 5 ? 1 : -1, v = new Float64Array(B); for (let b = 0; b < B; b++) v[b] = 1 / (1 + Math.exp(-sg * sims[b].z));
  return { v, pre, steps, calls: ST.calls - calls0, tot, uniq, ms: Date.now() - T0, owns: o.wantOwns ? owns : undefined };
}

/* v1.41 两步计划(用户 09-25): "这一手 X + 我下次轮到时回手拿 Y"一起推演。
   修的是推演里"以后的我不补组合另一半"的偏: rollouts 里以后的我按网络选, 而网络在"手里已有一半"的局面上常给另一半 0%(09-24 局第 9 手: 先拿狂战士之血本可第 12 手稳补智慧之刃 53.5%, 推演里的我却去拿棒击大地 → 误判成 44%)。
   plan(): 别人回合(后台)从当前局面算两步表: X = 筛选表前 NX ∪ 一步加分前 NX, 每个 X 配"拿了 X 之后一步加分前 NY"的 Y, 每条线 R 局, 配对随机数, 记下轮到我之前别人拿了什么(前缀)。
   planFinal(): 轮到我: 只留前缀与真实一致的样本, 按均值排前 NTOP 条线, 用准确局面补到 RT 局; 返回各线胜率, 由 worker 与现行结果比大小。
   竞技场 09-25(arena/f/pf4, pf5): 轮到时全算 +0.70pp(308 局 t=2.4); 预处理版 +0.45pp(154 局 t=1.6), 轮到时只多约 34 次网络调用; 改判阈值(防抖)有害, 不设。 */
const gainsFor = (sim, me) => { const BI = new Int32Array(64), BV = new Float64Array(64), so = sim.order, ss = sim.step; sim.order = [me]; sim.step = 0; F.setPolicyFix(true); let n = 0;
  try { n = F.scoreAll(sim, BI, BV); } finally { F.setPolicyFix(false); sim.order = so; sim.step = ss; } const g = new Map(); for (let q = 0; q < n; q++) g.set(BI[q], BV[q]); return g; };
const meanOf = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : -1;
async function plan(st, me, t0, o = {}) {
  const T0 = Date.now(), sim0 = AI._simFrom(st), own0 = ownerOf(st, sim0, me), NX = o.NX || 6, NY = o.NY || 4, R = o.R || 48;
  const forceAt = sim0.order.slice(sim0.step).indexOf(me); if (forceAt < 0) return null;
  if (sim0.order.slice(sim0.step + forceAt + 1).indexOf(me) < 0) return null;   // 没有"下下手"(最后一手)
  const idx = k => sim0.items.findIndex(x => x.key === k), g0 = gainsFor(F.cloneSim(sim0), me);
  const xs = (o.keys || []).map(idx).filter(x => x >= 0 && g0.has(x)).slice(0, NX);
  for (const [x] of [...g0.entries()].sort((a, b) => b[1] - a[1]).slice(0, NX)) if (!xs.includes(x)) xs.push(x);   // 一步加分前 NX 也要: 现行推演系统性低估"组合的前一半"
  const lines = []; for (const x of xs) { const s = F.cloneSim(sim0); F.applySim(s, x); const g1 = gainsFor(s, me);
    for (const [y] of [...g1.entries()].filter(([y]) => y !== x).sort((a, b) => b[1] - a[1]).slice(0, NY)) lines.push({ x, y }); }
  if (!lines.length) return null;
  const cs = [], yb = []; for (const l of lines) for (let r = 0; r < R; r++) { cs.push(l.x); yb.push(l.y); }
  const r = await rollouts(sim0, own0, me, forceAt, cs, o.seed || 5, { ...o, yb: Int16Array.from(yb), crn: true, t0, st }); if (!r || r.timeout) return r;
  const fa = Math.max(1, forceAt);
  lines.forEach((l, q) => { l.S = Array.from(r.v.subarray(q * R, q * R + R)); l.PRE = []; for (let b = q * R; b < q * R + R; b++) l.PRE.push(r.pre.subarray(b * fa, b * fa + forceAt)); });
  LAST.plan = { me, from: t0, slot: t0 + forceAt, forceAt, seats: sim0.order.slice(sim0.step, sim0.step + forceAt), lines };
  const rows = lines.map(l => ({ x: sim0.items[l.x].key, y: sim0.items[l.y].key, win: meanOf(l.S), n: l.S.length })).sort((a, b) => b.win - a.win);
  return { rows, lines: lines.length, forceAt, ms: Date.now() - T0, calls: r.calls, tot: r.tot, uniq: r.uniq };
}
async function planFinal(st, me, t0, o = {}) {
  const T0 = Date.now(), sim0 = AI._simFrom(st), own0 = ownerOf(st, sim0, me), RT = o.RT || 128, NTOP = o.NTOP || 3, MINKEEP = o.minKeep || 4;
  if (sim0.order[sim0.step] !== me) return null;
  const P = LAST.plan;
  if (!P || P.me !== me || P.slot !== t0) return { rows: [], why: !P ? "无两步表" : P.me !== me ? "两步表不是我的" : `两步表是第${P.slot + 1}手的`, from: P ? P.from : -1, ms: Date.now() - T0, reused: 0, fresh: 0, calls: 0 };
  const ok = i => i >= 0 && !sim0.taken[i] && sim0.items[i].p >= 0 && sim0.slot[me * 3 + sim0.items[i].kind] < CAPK3[sim0.items[i].kind];
  const cand = []; let reused = 0;
  for (const l of P.lines) { if (!ok(l.x) || sim0.taken[l.y]) continue;   // X 已被拿走/Y 已没了 → 这条线作废
    const S = []; for (let q = 0; q < l.S.length; q++) { const pr = l.PRE[q]; let m = true; for (let k = 0; k < P.forceAt; k++) if (pr[k] < 0 || own0[pr[k]] !== P.seats[k]) { m = false; break; } if (m) S.push(l.S[q]); }
    reused += S.length; cand.push({ x: l.x, y: l.y, S, est: S.length >= MINKEEP ? meanOf(S) : meanOf(l.S) - 0.02 }); }   // 前缀一致的样本不够就按全部样本估、打个折
  cand.sort((a, b) => b.est - a.est); const top = cand.slice(0, NTOP);
  const cs = [], yb = [], who = []; top.forEach((c, q) => { for (let r = c.S.length; r < RT; r++) { cs.push(c.x); yb.push(c.y); who.push(q); } });
  let calls = 0; if (cs.length) { const r = await rollouts(sim0, own0, me, 0, cs, o.seed || 7, { ...o, yb: Int16Array.from(yb), crn: true, t0, st }); if (!r || r.timeout) return r; who.forEach((q, b) => top[q].S.push(r.v[b])); calls = r.calls; }
  const rows = top.map(c => ({ x: sim0.items[c.x].key, y: sim0.items[c.y].key, win: meanOf(c.S), n: c.S.length })).sort((a, b) => b.win - a.win);
  return { rows, from: P.from, reused, fresh: cs.length, calls, ms: Date.now() - T0 };
}

/* ④ 多线程: 一批推演局按局号均分给 N 个分片线程(combo_sub2.js), 各自去重/编码/抽样落子; 本线程只拼批、跑网络、把结果发回去。
   09-23 实测(4090 + CUDA): 单线程时约 3/4 的时间花在 CPU 编码(每局每步 60 件东西各算一次一步加分)上。 */
let SUB2 = null; const BUSY = { max: 0, sum: 0 };
function subs2(n) {
  if (SUB2 && SUB2.length === n) return SUB2;
  if (SUB2) SUB2.forEach(w => w.w.terminate());
  const { Worker } = require("worker_threads");
  SUB2 = Array.from({ length: n }, () => { const w = new Worker(path.join(__dirname, "combo_sub2.js")); w.setMaxListeners(0); return { w, cap: 0, sab: null }; });
  return SUB2;
}
const ask2 = (s, msg) => new Promise((res, rej) => { const f = m => { s.w.off("message", f); m.type === "err" ? rej(new Error(m.msg)) : res(m); }; s.w.on("message", f); s.w.postMessage(msg); });
async function rolloutsMT(sim0, own0, me, forceAt, cs, seed, o, NT) {
  const B = cs.length, T0 = Date.now(), W = subs2(NT), per = Math.ceil(B / NT), parts = [];
  for (let i = 0; i < NT; i++) { const b0 = i * per, b1 = Math.min(B, b0 + per); if (b0 < b1) parts.push({ s: W[i], b0, b1 }); }
  for (const p of parts) { const need = p.b1 - p.b0; if (p.s.cap < need) { p.s.cap = Math.max(need, 256); p.s.sab = mkShared(p.s.cap); p.s.views = views(p.s.sab); } }
  if (!o.st) throw new Error("多线程推演需要 o.st(起点局面)");   // sim0 不能跨线程传, 各分片用同一个局面自己重建
  let rep = await Promise.all(parts.map(p => ask2(p.s, { type: "start", st: o.st, me, forceAt, cs: cs.slice(p.b0, p.b1), b0: p.b0, seed, t0: o.t0 || 0, sab: p.s.sab })));
  let steps = 0, tot = 0, uniq = 0, calls0 = ST.calls, tW = Date.now() - T0, tC = 0, tN = 0;
  if (!PBUF) PBUF = [mkBuf(BFIX), mkBuf(BFIX)];
  while (!rep[0].done) {
    if (o.cancelled && o.cancelled()) return null;
    if (o.deadline && Date.now() > o.deadline) return { timeout: true };
    const ns = rep.map(r => r.n), N = ns.reduce((a, b) => a + b, 0); tot += rep.reduce((a, r) => a + r.tot, 0); uniq += N;
    /* 把各分片的去重局面按顺序拼成若干块(每块 BFIX 行)过网络, 结果写回各分片的 logits 区 */
    const rows = []; parts.forEach((p, i) => { for (let r = 0; r < ns[i]; r++) rows.push([i, r]); });
    for (let r0 = 0; r0 < N; r0 += BFIX) {
      const m = Math.min(BFIX, N - r0), pb = PBUF[0], q = Date.now();
      for (let r = 0; r < m; r++) { const [i, rr] = rows[r0 + r], v = parts[i].s.views;
        for (const key in W_OF) { const w = W_OF[key]; pb[key].set(v[key].subarray(rr * w, rr * w + w), r * w); } }
      for (const key in W_OF) { const w = W_OF[key]; for (let r = m; r < BFIX; r++) pb[key].copyWithin(r * w, 0, w); }
      ST.build += Date.now() - q; ST.calls++; tC += Date.now() - q;
      let L; if (process.env.AD_COMBO_FAKE) L = new Float32Array(BFIX * 60);
      else { const q2 = Date.now(); L = (await nativeRun(sess, feedsOf(pb, BFIX))).logits.data; const dt = Date.now() - q2; ST.run += dt; ST.runs.push(dt); tN += dt; }
      const q3 = Date.now(); for (let r = 0; r < m; r++) { const [i, rr] = rows[r0 + r]; parts[i].s.views.logits.set(L.subarray(r * 60, r * 60 + 60), rr * 60); } tC += Date.now() - q3;
    }
    const q4 = Date.now(); rep = await Promise.all(parts.map(p => ask2(p.s, { type: "sample" }))); steps++; tW += Date.now() - q4;
    if (process.env.AD_MT_PROF) { BUSY.max += Math.max(...rep.map(r => r.busy || 0)); BUSY.sum += rep.reduce((a, r) => a + (r.busy || 0), 0); }
  }
  const v = new Float64Array(B), pre = new Int16Array(B * Math.max(1, forceAt)).fill(-1), fa = Math.max(1, forceAt);
  parts.forEach((p, i) => { v.set(rep[i].v, p.b0); if (forceAt > 0) pre.set(rep[i].pre, p.b0 * fa); });
  if (process.env.AD_MT_PROF) { console.log(`[多线程 ${parts.length}] 共${Date.now() - T0}ms = 等子线程${tW} + 拼批拷贝${tC} + 显卡${tN} (+其它)  步数${steps} | 子线程实际忙: 最忙那个累计${BUSY.max.toFixed(0)}ms, 全部加起来${BUSY.sum.toFixed(0)}ms`); BUSY.max = 0; BUSY.sum = 0; }
  return { v, pre, steps, calls: ST.calls - calls0, tot, uniq, ms: Date.now() - T0, threads: parts.length };
}
/* v1.40 推荐理由: 假设我改拿 altKey(网络首选), 往后按网络抽样推到"下一次轮到我"为止(最多 maxSteps 手), 共 B 局,
   统计 tgtKey(GPU 首推)在这期间被谁拿走、平均第几手。给界面写"不拿的话会被谁拿走"用。 */
async function fate(st, me, t0, altKey, tgtKey, o = {}) {
  const T0 = Date.now(), sim0 = AI._simFrom(st), own0 = ownerOf(st, sim0, me), idx = k => sim0.items.findIndex(x => x.key === k);
  const ai = idx(altKey), ti = idx(tgtKey); if (ai < 0 || ti < 0 || sim0.order[sim0.step] !== me) return null;
  const B = o.B || 128, sims = [], owns = [];
  for (let b = 0; b < B; b++) { const s = F.cloneSim(sim0), w = Int8Array.from(own0); F.applySim(s, ai); w[ai] = me; sims.push(s); owns.push(w); }
  const rngs = Array.from({ length: B }, (_, b) => simRng(o.seed || 7, b)), took = new Int8Array(B).fill(-1), at = new Int16Array(B);
  if (!PBUF) PBUF = [mkBuf(BFIX), mkBuf(BFIX)];
  let k = 1;
  while (!F.simDone(sims[0]) && sims[0].order[sims[0].step] !== me && k <= (o.maxSteps || 12)) {
    if (o.cancelled && o.cancelled()) return null;
    const seat = sims[0].order[sims[0].step], idxM = new Map(), rep = [], map = new Int32Array(B);
    for (let b = 0; b < B; b++) { const key = ownKey(owns[b]); let r = idxM.get(key); if (r === undefined) { r = rep.length; idxM.set(key, r); rep.push(b); } map[b] = r; }
    const U = new Float64Array(B); for (let b = 0; b < B; b++) U[b] = rngs[b]();
    for (let r0 = 0; r0 < rep.length; r0 += BFIX) {
      const m = Math.min(BFIX, rep.length - r0), pb = PBUF[0];
      encodeRange(rep.slice(r0, r0 + m).map(b => sims[b]), rep.slice(r0, r0 + m).map(b => owns[b]), Math.min(49, t0 + k), pb, 0);
      for (const key in W_OF) { const w = W_OF[key]; for (let r = m; r < BFIX; r++) pb[key].copyWithin(r * w, 0, w); }
      const L = process.env.AD_COMBO_FAKE ? new Float32Array(BFIX * 60) : (await nativeRun(sess, feedsOf(pb, BFIX))).logits.data; ST.calls++;
      for (let b = 0; b < B; b++) { const r = map[b] - r0; if (r < 0 || r >= m) continue; const o6 = r * 60;
        let mx = -Infinity; for (let i = 0; i < 60; i++) if (pb.legal[o6 + i] && L[o6 + i] > mx) mx = L[o6 + i];
        let z = 0; for (let i = 0; i < 60; i++) if (pb.legal[o6 + i]) z += Math.exp(L[o6 + i] - mx);
        if (!(z > 0)) { F.passSim(sims[b]); continue; }
        let u = U[b] * z, pick = -1; for (let i = 0; i < 60; i++) if (pb.legal[o6 + i]) { pick = i; u -= Math.exp(L[o6 + i] - mx); if (u <= 0) break; }
        F.applySim(sims[b], pick); owns[b][pick] = seat; if (pick === ti && took[b] < 0) { took[b] = seat; at[b] = k; } }
    }
    k++;
  }
  const bySeat = {}; let n = 0, sumAt = 0; for (let b = 0; b < B; b++) if (took[b] >= 0) { bySeat[took[b]] = (bySeat[took[b]] || 0) + 1; n++; sumAt += at[b]; }
  return { B, bySeat, taken: n, avgAt: n ? sumAt / n : null, steps: k - 1, ms: Date.now() - T0 };
}
/* 我在起点局面能拿的候选(槽位没满、没被拿走)。hard_deps: 缺条件件的依赖者排到最后(与网络档/现役同一张表) */
function myCands(sim0, me) {
  const out = [], so = sim0.order, ss = sim0.step; sim0.order = [me]; sim0.step = 0;
  for (let i = 0; i < 60; i++) { const it = sim0.items[i]; if (!sim0.taken[i] && it.p >= 0 && sim0.slot[me * 3 + it.kind] < CAPK3[it.kind]) out.push({ i, dep: !!(F.depBlocked && F.depBlocked(sim0, i)) }); }
  sim0.order = so; sim0.step = ss; return out;
}
const LAST = { screen: null, exact: null };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : -1;
function rowsOf(sim0, S, cands) {
  return cands.map(c => ({ key: sim0.items[c.i].key, win: mean(S.get(c.i) || []), n: (S.get(c.i) || []).length, dep: c.dep }))
    .sort((a, b) => (a.dep - b.dep) || (b.win - a.win));
}
/* 后台筛选: st = 当前真实局面(顺序从当前在选的人开始), me = 我; 两轮: 全部 × R1 → 前 N2 × R2 */
async function screen(st, me, t0, o = {}) {
  const T0 = Date.now(), sim0 = AI._simFrom(st), own0 = ownerOf(st, sim0, me);
  /* o.forceAt: 起点之后第几步是要评估的那一手(连选两手时, 第二手不是"下一次轮到我");不给就取下一次轮到我 */
  const forceAt = o.forceAt != null ? o.forceAt : sim0.order.slice(sim0.step).indexOf(me);
  if (forceAt < 0 || sim0.order[sim0.step + forceAt] !== me) return null;
  const cands = myCands(sim0, me); if (!cands.length) return null;
  let round = 0; const S = new Map(), PRE = new Map(); let st8 = { steps: 0, calls: 0, tot: 0, uniq: 0 };
  const add = (cs, r) => { cs.forEach((c, b) => { if (!S.has(c)) { S.set(c, []); PRE.set(c, []); } S.get(c).push(r.v[b]); PRE.get(c).push(r.pre.subarray(b * Math.max(1, forceAt), b * Math.max(1, forceAt) + forceAt)); });
    for (const k of ["steps", "calls", "tot", "uniq"]) st8[k] += r[k]; };
  const run = async (list, R) => { const cs = []; for (const c of list) for (let r = 0; r < R; r++) cs.push(c.i); const r = await rollouts(sim0, own0, me, forceAt, cs, (o.seed || 1) * 31 + (round++), { ...o, t0, st }); if (!r || r.timeout) return r; add(cs, r); return r; };
  let r = await run(cands, o.R1 || 8); if (!r || r.timeout) return r;
  if (o.N2) { const top = rowsOf(sim0, S, cands).slice(0, o.N2).map(x => cands.find(c => sim0.items[c.i].key === x.key)); r = await run(top, o.R2 || 32); if (!r || r.timeout) return r; }
  LAST.screen = { me, forceAt, seats: sim0.order.slice(sim0.step, sim0.step + forceAt), S, PRE, n: cands.length };
  return { rows: rowsOf(sim0, S, cands), forceAt, ms: Date.now() - T0, ...st8 };
}
/* 从上一张筛选表里取出"我之前那几手和真实发生的一样"的推演局 → 准确局面下的有效样本 */
function reuseFor(own0, me, keysIdx) {
  const L = LAST.screen, out = new Map(); if (!L || L.me !== me) return out;
  for (const c of keysIdx) { const vs = L.S.get(c), ps = L.PRE.get(c); if (!vs) continue; const got = [];
    for (let q = 0; q < vs.length; q++) { const pr = ps[q]; let ok = true; for (let k = 0; k < L.forceAt; k++) if (pr[k] < 0 || own0[pr[k]] !== L.seats[k]) { ok = false; break; } if (ok) got.push(vs[q]); }
    if (got.length) out.set(c, got); }
  return out;
}
/* 准确局面的样本池(决赛和更新共用, 局面变了就作废) */
function exactPool(own0, me) { const sig = ownKey(own0, me); if (!LAST.exact || LAST.exact.sig !== sig) LAST.exact = { sig, S: new Map(), reused: new Set(), nReused: 0 }; return LAST.exact; }
function mergeReuse(E, own0, me, idxs) {
  const todo = idxs.filter(c => !E.reused.has(c)); const m = reuseFor(own0, me, todo);
  for (const c of todo) { E.reused.add(c); const g = m.get(c); if (g) { if (!E.S.has(c)) E.S.set(c, []); E.S.get(c).push(...g); E.nReused += g.length; } }
}
/* 决赛: 准确局面(st 的顺序从我开始), keys = 筛选表前几名, 每个补到 R 局(复用来的样本也算) */
async function final(st, me, t0, keys, o = {}) {
  const T0 = Date.now(), sim0 = AI._simFrom(st), own0 = ownerOf(st, sim0, me);
  if (sim0.order[sim0.step] !== me) return null;
  const all = myCands(sim0, me), byKey = new Map(all.map(c => [sim0.items[c.i].key, c]));
  const cands = keys.map(k => byKey.get(k)).filter(Boolean); if (!cands.length) return null;
  const E = exactPool(own0, me); mergeReuse(E, own0, me, cands.map(c => c.i)); const reused = E.nReused;
  const cs = []; for (const c of cands) { const have = (E.S.get(c.i) || []).length; for (let r = have; r < (o.R || 32); r++) cs.push(c.i); }
  const r = await rollouts(sim0, own0, me, 0, cs, o.seed || 2, { ...o, t0, st }); if (!r || r.timeout) return r;
  cs.forEach((c, b) => { if (!E.S.has(c)) E.S.set(c, []); E.S.get(c).push(r.v[b]); });
  return { rows: rowsOf(sim0, E.S, cands), ms: Date.now() - T0, reused, fresh: cs.length, steps: r.steps, calls: r.calls, tot: r.tot, uniq: r.uniq };
}
/* 更新: 准确局面全部候选重算 —— 全部补到 8 局 → 前 6 补到 40 局 → 前 3 补到 72 局(决赛算过的、复用来的都算数) */
async function refine(st, me, t0, o = {}) {
  const T0 = Date.now(), sim0 = AI._simFrom(st), own0 = ownerOf(st, sim0, me);
  if (sim0.order[sim0.step] !== me) return null;
  const cands = myCands(sim0, me); if (!cands.length) return null;
  const E = exactPool(own0, me); mergeReuse(E, own0, me, cands.map(c => c.i));
  let fresh = 0, calls = 0, tot = 0, uniq = 0, round = 0;
  for (const [N, target] of [[cands.length, 8], [6, 40], [3, 72]]) {
    const list = N >= cands.length ? cands : rowsOf(sim0, E.S, cands).slice(0, N).map(x => cands.find(c => sim0.items[c.i].key === x.key));
    const cs = []; for (const c of list) { const have = (E.S.get(c.i) || []).length; for (let r = have; r < target; r++) cs.push(c.i); }
    if (!cs.length) continue;
    const r = await rollouts(sim0, own0, me, 0, cs, (o.seed || 3) * 31 + (round++), { ...o, t0, st }); if (!r || r.timeout) return r;
    cs.forEach((c, b) => { if (!E.S.has(c)) E.S.set(c, []); E.S.get(c).push(r.v[b]); }); fresh += cs.length; calls += r.calls; tot += r.tot; uniq += r.uniq;
  }
  return { rows: rowsOf(sim0, E.S, cands), ms: Date.now() - T0, reused: E.nReused, fresh, calls, tot, uniq };
}

/* v1.40 新网络输入 ext(与训练 azn/env.py Env.extra 逐项等价, 09-24 JS↔Python 最大差 3e-8):
   每件能拿的东西 3 项 = [我的潜在配合, 对面已有的配合, 对面的潜在配合], 配合取 max(P,0), 按槽位。
   潜在配合(座位, 件 i) = max_{j 还没人拿, j≠i, 拿了 i 后还有 j 那类空槽} P[i,j]; 对面已有 = max_{对手有 i 的空槽} Σ_{x∈对手已拿} P[i,x]; 对面潜在 = max_对手 潜在配合 */
let HAS_EXT = false, PAIR = null, PN = 0;
function extFill(sim, own, seat, buf, b) {
  /* 先算一次 MK[i][k] = max_{j 还没人拿, j≠i, j 属第 k 类} max(P[i,j],0) 及次大(同类里 j 的第二名, 给"i 自己也是 k 类且只剩一个空槽"的情形),
     各座位共用; 再按座位槽位取 max。比逐座位逐对扫快 ~5 倍, 结果与逐对扫逐位相同(test/ext_fast.js)。 */
  const o3 = b * 180, CAP3 = [1, 3, 1], it = sim.items, kind = new Int8Array(60), pp = new Int32Array(60);
  for (let i = 0; i < 60; i++) { kind[i] = it[i].kind; pp[i] = it[i].p; }
  const openJ = []; for (let j = 0; j < 60; j++) if (own[j] < 0 && pp[j] >= 0) openJ.push(j);
  const MK = new Float32Array(180);
  for (let i = 0; i < 60; i++) { if (pp[i] < 0 || !buf.legal[b * 60 + i]) continue; const row = pp[i] * PN;
    for (const j of openJ) { if (j === i) continue; const v = PAIR[row + pp[j]]; if (v > 0) { const q = i * 3 + kind[j]; if (v > MK[q]) MK[q] = v; } } }
  const pot = (st, i) => { const ki = kind[i], sl = st * 3; let m = 0;
    for (let k = 0; k < 3; k++) { if (!(sim.slot[sl + k] + (k === ki ? 1 : 0) < CAP3[k])) continue; const v = MK[i * 3 + k]; if (v > m) m = v; } return m; };
  const opp = [], owned = []; for (let st = 0; st < 10; st++) if ((st < 5) !== (seat < 5)) { opp.push(st); const l = []; for (let x = 0; x < 60; x++) if (own[x] === st && pp[x] >= 0) l.push(x); owned.push(l); }
  for (let i = 0; i < 60; i++) { const q = o3 + i * 3; buf.ext[q] = 0; buf.ext[q + 1] = 0; buf.ext[q + 2] = 0;
    if (!buf.legal[b * 60 + i] || pp[i] < 0) continue;
    buf.ext[q] = pot(seat, i); const ki = kind[i], row = pp[i] * PN; let hv = 0, po = 0;
    for (let oi = 0; oi < opp.length; oi++) { const o = opp[oi]; if (!(sim.slot[o * 3 + ki] < CAP3[ki])) continue;
      let h = 0; for (const x of owned[oi]) { const v = PAIR[row + pp[x]]; if (v > 0) h += v; } if (h > hv) hv = h; const p2 = pot(o, i); if (p2 > po) po = p2; }
    buf.ext[q + 1] = hv; buf.ext[q + 2] = po; }
}
async function dispose() {
  await native.waitIdle();
  if(sess){await nativeRelease(sess);sess=null;}INFO=null;BFIX=0;sessionModel=null;
  await Promise.all([...(SUBS||[]),...(SUB2||[]).map(s=>s.w)].map(w=>w.terminate()));SUBS=null;SUB2=null;
}
module.exports = { dispose, setCudaRuntime: dir => { cudaRuntime=dir; }, setDiagnosticHook: native.setHook, nativeSnapshot: native.snapshot, _setPair: (P, n) => { PAIR = P; PN = n; HAS_EXT = true; }, extFill, fate, plan, planFinal, gainsFor, init, decide, decideMT, ownerOf, encodeRange, views, rng, logits, statReset, statOut, rollouts, screen, final, refine, myCands, LAST, info: () => INFO, simRng, ownKey, mkBuf };
