"use strict";
/* v1.38 GPU版多线程分片(新流程 rollouts 用): 负责一批推演局里 [b0, b0+n) 这一段 —— 建局 → 去重编码 → 按网络输出抽样落子。
   与协调线程(combo_local.js rolloutsMT)共用一块 SharedArrayBuffer: 去重后的局面编码写进去, 网络输出(logits)从里面读。
   每局用自己的随机数流(局号决定), 所以分几个线程结果都一样。 */
const { parentPort } = require("worker_threads");
const path = require("path");
const E = path.join(__dirname, "engine", "server");
const AI = require(E + "/ai.js"), F = require(E + "/mcts_fast.js");
const L = require("./combo_local.js");
let J = null;
function force() { for (let b = 0; b < J.sims.length; b++) { F.applySim(J.sims[b], J.cs[b]); J.owns[b][J.cs[b]] = J.me; } J.forced = true; }
function encodeStep() {
  while (true) {
    if (F.simDone(J.sims[0])) { const sg = J.me < 5 ? 1 : -1, v = new Float64Array(J.sims.length);
      for (let b = 0; b < v.length; b++) v[b] = 1 / (1 + Math.exp(-sg * J.sims[b].z));
      return { type: "ready", done: true, v, pre: J.pre }; }
    if (!J.forced && J.k === J.forceAt) { force(); J.k++; continue; }
    break;
  }
  const n = J.sims.length, idx = new Map(), rep = [], map = new Int32Array(n);
  for (let b = 0; b < n; b++) { const key = L.ownKey(J.owns[b], J.forced ? null : J.cs[b]); let r = idx.get(key);
    if (r === undefined) { r = rep.length; idx.set(key, r); rep.push(b); } map[b] = r; }
  /* 先编码进本线程自己的普通内存, 最后整段拷进共享区: 直接在 SharedArrayBuffer 上逐格写慢得多(09-23 实测同样的活慢约 3 倍) */
  if (!J.lb || J.lbCap < rep.length) { J.lb = L.mkBuf(Math.max(rep.length, 256)); J.lbCap = Math.max(rep.length, 256); }
  L.encodeRange(rep.map(b => J.sims[b]), rep.map(b => J.owns[b]), Math.min(49, J.t0 + J.k), J.lb, 0);
  if (!J.forced) for (let r = 0; r < rep.length; r++) J.lb.legal[r * 60 + J.cs[rep[r]]] = 0;   // 轮到我之前别人不许拿走我要评估的那件
  for (const [key, w] of [["ids", 60], ["code", 60], ["delta", 60], ["legal", 60], ["t", 1], ["seat", 1], ["slot", 3]]) J.buf[key].set(J.lb[key].subarray(0, rep.length * w), 0);
  J.map = map; J.nrep = rep.length; J.seat = J.sims[0].order[J.sims[0].step];
  return { type: "ready", done: false, n: rep.length, tot: n };
}
function sampleStep() {
  const lg = J.lb.legal, lo = Float32Array.from(J.buf.logits.subarray(0, J.nrep * 60)), n = J.sims.length, fa = Math.max(1, J.forceAt), cum = new Float64Array(J.nrep * 60), Z = new Float64Array(J.nrep).fill(-1);
  for (let b = 0; b < n; b++) {
    const u0 = J.rngs[b](), r = J.map[b], o6 = r * 60;
    if (Z[r] < 0) { let mx = -Infinity; for (let i = 0; i < 60; i++) if (lg[o6 + i] && lo[o6 + i] > mx) mx = lo[o6 + i];
      let z = 0; for (let i = 0; i < 60; i++) { if (lg[o6 + i]) z += Math.exp(lo[o6 + i] - mx); cum[o6 + i] = z; } Z[r] = z; }
    if (!(Z[r] > 0)) { F.passSim(J.sims[b]); continue; }
    const u = u0 * Z[r]; let pick = -1; for (let i = 0; i < 60; i++) if (lg[o6 + i] && cum[o6 + i] >= u) { pick = i; break; }
    if (pick < 0) { F.passSim(J.sims[b]); continue; }
    F.applySim(J.sims[b], pick); J.owns[b][pick] = J.seat; if (!J.forced && J.k < J.forceAt) J.pre[b * fa + J.k] = pick;
  }
  J.k++;
}
parentPort.on("message", m => {
  try {
    if (m.type === "start") {
      const sim0 = AI._simFrom(m.st), own0 = L.ownerOf(m.st, sim0, m.me), n = m.cs.length;
      J = { sims: [], owns: [], cs: m.cs, me: m.me, forceAt: m.forceAt, forced: false, k: 0, t0: m.t0, buf: L.views(m.sab),
            rngs: m.cs.map((_, q) => L.simRng(m.seed, m.b0 + q)), pre: new Int16Array(n * Math.max(1, m.forceAt)).fill(-1) };
      for (let b = 0; b < n; b++) { J.sims.push(F.cloneSim(sim0)); J.owns.push(Int8Array.from(own0)); }
      if (m.forceAt === 0) { force(); J.k = 1; }
      return parentPort.postMessage(encodeStep());
    }
    if (m.type === "sample") { const q = process.hrtime.bigint(); sampleStep(); const r = encodeStep(); r.busy = Number(process.hrtime.bigint() - q) / 1e6; return parentPort.postMessage(r); }
  } catch (e) { parentPort.postMessage({ type: "err", msg: String(e && e.stack || e) }); }
});
