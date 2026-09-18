"use strict";
/* v1.29「组合版」本地实现: 推演框架(现役 AI 同款增量打分引擎) + 推演里双方都按网络出手(ONNX, 优先本机显卡 DirectML)。
   每手: 网络概率前 K 个候选, 各推演 R 局到满编, 取行动方平均胜率最高者。所有推演局一起按"手"批量过网络。
   参数 K/R 可调;自动降档: 一手超过预算就把 R 减半(最低 8), R=8 仍超预算 → 本局退回网络档(由调用方处理)。 */
const path = require("path");
const E = path.join(__dirname, "engine", "server");
const AI = require(E + "/ai.js"), F = require(E + "/mcts_fast.js");
const CAPK = [1, 3, 1];
let ort = null, sess = null, EP = null, DEV = null, BFIX = 0, INFO = null;
/* v1.30: ① 批大小固定(freeDimensionOverrides B=BFIX): 模型里 20 个 Shape/34 个 Concat 等"现算形状"的节点在建会话时就折叠掉
   (369→209 节点), DirectML 上这些节点落在 CPU, 每次调用中途要显卡↔CPU 来回倒;不够一批的补齐(复制第 0 行, 结果丢掉)。
   ② DirectML 逐块显卡(deviceId 0..3)建会话实测, 选最快的 —— 防 Windows 把插件分到核显。每块的结果都写日志。 */
function dummyBuf(B) { const b = mkBuf(B); for (let i = 0; i < B * 60; i++) { b.ids[i] = (i * 7) % 600; b.legal[i] = 1; b.delta[i] = ((i % 13) - 6) / 10; } b.t.fill(10); return b; }
async function benchSess(s, B) {
  const b = dummyBuf(B), f = feedsOf(b, B), t0 = Date.now(); await s.run(f); const first = Date.now() - t0, a = [];
  for (let i = 0; i < 5; i++) { const q = Date.now(); await s.run(f); a.push(Date.now() - q); }
  a.sort((x, y) => x - y); return { first, med: a[2] };
}
async function init(modelPath, prefer, bfix) {
  bfix = bfix || 128;
  if (sess && BFIX === bfix) return INFO;
  if (sess) { try { await sess.release(); } catch (e) { } sess = null; }
  ort = ort || require("onnxruntime-node");
  const T0 = Date.now(), base = { graphOptimizationLevel: "all", freeDimensionOverrides: { B: bfix } }, notes = [];
  if (process.env.AD_COMBO_THREADS) base.intraOpNumThreads = +process.env.AD_COMBO_THREADS;
  if (prefer !== "cpu") {
    const gpu = process.platform === "win32" ? "dml" : "cuda";
    let best = null;
    for (let d = 0; d < 4; d++) {
      let s = null; const q = Date.now();
      try { s = await ort.InferenceSession.create(modelPath, { ...base, executionProviders: [{ name: gpu, deviceId: d }], enableMemPattern: false, executionMode: "sequential" }); }
      catch (e) { if (d === 0) notes.push(`${gpu}显卡0 建不起来: ${String(e && e.message || e).slice(0, 120)}`); break; }
      const tc = Date.now() - q; let b = null;
      try { b = await benchSess(s, bfix); } catch (e) { notes.push(`显卡${d} 试跑出错 ${String(e && e.message || e).slice(0, 80)}`); try { await s.release(); } catch (e2) { } continue; }
      notes.push(`显卡${d}: 建会话${tc}ms 首跑${b.first}ms 每次${b.med}ms`);
      if (!best || b.med < best.med) { if (best) try { await best.s.release(); } catch (e) { } best = { s, d, med: b.med }; } else try { await s.release(); } catch (e) { }
      if (gpu === "cuda") break;
    }
    if (best) { sess = best.s; EP = gpu; DEV = best.d; notes.push(`选用显卡${best.d}`); }
  }
  if (!sess) { sess = await ort.InferenceSession.create(modelPath, { ...base, executionProviders: ["cpu"] }); EP = "cpu"; DEV = null;
    const b = await benchSess(sess, bfix); notes.push(`CPU: 首跑${b.first}ms 每次${b.med}ms`); }
  BFIX = bfix; PAD = null;
  INFO = { ep: EP, dev: DEV, bfix, detail: notes.join(" | "), ms: Date.now() - T0 };
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
      buf.ids[o + i] = it.p >= 0 ? it.p : 640;
      const rel = ow < 0 ? 0 : ((ow % 5 - seat % 5) + 5) % 5;
      buf.code[o + i] = ow < 0 ? 0 : ((ow < 5) === mySide ? 1 + rel : 6 + rel);
      const lg = !sim.taken[i] && it.p >= 0 && sim.slot[seat * 3 + it.kind] < CAPK[it.kind];
      buf.legal[o + i] = lg ? 1 : 0;
      buf.delta[o + i] = lg ? (mySide ? 1 : -1) * F.deltaOf(sim, i) : 0;
    }
    buf.t[b] = tAbs; buf.seat[b] = seat;
    buf.slot[b * 3] = sim.slot[seat * 3]; buf.slot[b * 3 + 1] = sim.slot[seat * 3 + 1]; buf.slot[b * 3 + 2] = sim.slot[seat * 3 + 2];
  }
}
const W_OF = { ids: 60, code: 60, delta: 60, legal: 60, t: 1, seat: 1, slot: 3 };
function feedsOf(b, B) {
  const T = (a, t, d) => { const n = d.reduce((x, y) => x * y, 1); let v = a.subarray(0, n);
    if (v.buffer instanceof SharedArrayBuffer) v = v.slice(); return new ort.Tensor(t, v, d); };
  return { ids: T(b.ids, "int32", [B, 60]), code: T(b.code, "int32", [B, 60]), delta: T(b.delta, "float32", [B, 60]),
    legal: T(b.legal, "float32", [B, 60]), t: T(b.t, "int32", [B]), seat: T(b.seat, "int32", [B]), slot: T(b.slot, "int32", [B, 3]) };
}
/* 每次调用的耗时构成(decide 开头清零): 打包=拷贝补齐+建张量, 运行=sess.run(含上传/下载) */
let PAD = null; const ST = { calls: 0, build: 0, run: 0, runs: [] };
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
    const r = await sess.run(f), dt = Date.now() - q2; ST.run += dt; ST.runs.push(dt); ST.calls++;
    out.set(r.logits.data.subarray(0, n * 60), b0 * 60);
  }
  return out;
}
/* 多线程共享缓冲: 一块 SharedArrayBuffer 切成各输入 + logits */
const LAYOUT = [["ids", Int32Array, 60], ["code", Int32Array, 60], ["delta", Float32Array, 60], ["legal", Float32Array, 60], ["t", Int32Array, 1], ["seat", Int32Array, 1], ["slot", Int32Array, 3], ["logits", Float32Array, 60]];
function mkShared(B) { let n = 0; for (const [, , w] of LAYOUT) n += 4 * B * w; return { sab: new SharedArrayBuffer(n), B }; }
function views(sh) { const out = {}; let off = 0; for (const [k, T, w] of LAYOUT) { out[k] = new T(sh.sab, off, sh.B * w); off += 4 * sh.B * w; } return out; }
const mkBuf = B => ({ ids: new Int32Array(B * 60), code: new Int32Array(B * 60), delta: new Float32Array(B * 60), legal: new Float32Array(B * 60),
  t: new Int32Array(B), seat: new Int32Array(B), slot: new Int32Array(B * 3) });
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
  let Z = 0; const pr = new Float64Array(60); for (let i = 0; i < 60; i++) if (root.legal[i]) { pr[i] = Math.exp(lg0[i] - mx); Z += pr[i]; }
  const cand = [...Array(60).keys()].filter(i => root.legal[i]).sort((a, b) => pr[b] - pr[a]).slice(0, K);
  const rows = cand.map(i => ({ key: sim0.items[i].key, net: pr[i] / Z, win: null }));
  if (cand.length <= 1 || sim0.step >= sim0.order.length - 1) return { rows, ms: Date.now() - T0, K, R, ep: EP };
  const sims = [], owns = [], ci = [];
  for (let c = 0; c < cand.length; c++) for (let r = 0; r < R; r++) {
    const s = F.cloneSim(sim0); F.applySim(s, cand[c]); const ow = Int8Array.from(own0); ow[cand[c]] = cur; sims.push(s); owns.push(ow); ci.push(c); }
  const B = sims.length, buf = mkBuf(B); let tAbs = t0 + 1, tEnc = 0, tNet = 0, tAp = 0;
  const stat = () => ({ steps, B, bfix: BFIX, dev: DEV, tEnc, tNet, tAp, ...statOut() });
  while (!F.simDone(sims[0])) {
    if (o.cancelled && o.cancelled()) return { rows, ms: Date.now() - T0, K, R, ep: EP, cancelled: true, ...stat() };
    if (o.deadline && Date.now() > o.deadline) return { rows, ms: Date.now() - T0, K, R, ep: EP, timeout: true, ...stat() };
    let q = Date.now(); encode(sims, owns, Math.min(49, tAbs), buf); tEnc += Date.now() - q;
    q = Date.now(); const L = await logits(buf, B), seat = sims[0].order[sims[0].step]; tNet += Date.now() - q; q = Date.now();
    for (let b = 0; b < B; b++) {
      const o6 = b * 60; let m2 = -Infinity; for (let i = 0; i < 60; i++) if (buf.legal[o6 + i] && L[o6 + i] > m2) m2 = L[o6 + i];
      let z = 0; for (let i = 0; i < 60; i++) if (buf.legal[o6 + i]) z += Math.exp(L[o6 + i] - m2);
      let u = rnd() * z, pick = -1; for (let i = 0; i < 60; i++) if (buf.legal[o6 + i]) { pick = i; u -= Math.exp(L[o6 + i] - m2); if (u <= 0) break; }
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
  let Z = 0; const pr = new Float64Array(60); for (let i = 0; i < 60; i++) if (root.legal[i]) { pr[i] = Math.exp(lg0[i] - mx); Z += pr[i]; }
  const cand = [...Array(60).keys()].filter(i => root.legal[i]).sort((a, b) => pr[b] - pr[a]).slice(0, K);
  const rows = cand.map(i => ({ key: sim0.items[i].key, net: pr[i] / Z, win: null }));
  if (cand.length <= 1 || sim0.step >= sim0.order.length - 1) return { rows, ms: Date.now() - T0, K, R, ep: EP, threads: NT };
  const B = cand.length * R, sh = mkShared(B), buf = views(sh), W = subs(NT), per = Math.ceil(B / NT);
  const parts = W.map((w, i) => [i * per, Math.min(B, (i + 1) * per)]).filter(([a, b]) => a < b);
  let tEnc = 0, tNet = 0, q = Date.now();
  let st8 = await Promise.all(parts.map(([b0, b1], i) => ask(W[i], { type: "start", st, cur, cands: cand, R, b0, b1, seed, sab: sh, t0 })));
  tEnc += Date.now() - q; let tAbs = t0 + 1, sums = null;
  while (true) {
    if (o.deadline && Date.now() > o.deadline) return { rows, ms: Date.now() - T0, K, R, ep: EP, threads: NT, timeout: true };
    buf.t.fill(Math.min(49, tAbs)); buf.seat.fill(buf.seat[0]);
    q = Date.now(); const L = await logits(buf, B); buf.logits.set(L); tNet += Date.now() - q;
    tAbs++; q = Date.now();
    st8 = await Promise.all(parts.map((p, i) => ask(W[i], { type: "step", tAbs: Math.min(49, tAbs) })));
    tEnc += Date.now() - q;
    if (st8.every(x => x.done && x.sum)) { sums = new Float64Array(cand.length); st8.forEach(x => x.sum.forEach((v, c) => sums[c] += v)); break; }
  }
  rows.forEach((r, c) => r.win = sums[c] / R); rows.sort((a, b) => b.win - a.win);
  return { rows, ms: Date.now() - T0, K, R, ep: EP, threads: NT, tEnc, tNet };
}
module.exports = { init, decide, decideMT, ownerOf, encodeRange, views, rng, logits, statReset, statOut };
