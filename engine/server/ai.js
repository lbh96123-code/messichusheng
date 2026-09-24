"use strict";
/* 选技 AI:走子到满编 + 取平均(MCTS)。
 *   每手:增量引擎给全部候选算 Δlogit → 取前 K → 每个候选把余下的手用 softmax(T) 双方走完 →
 *   在**完整阵容**上评分 → N 次取平均(所有候选共用同一批随机数)→ 三轮淘汰省算力。
 *   "拿了 A 之后 B 还在不在"没有专门代码,是模拟的副产品。
 *
 *   实测(research/mcts/, 每组换边对局):
 *     打旧版一步封锁 99.25% 胜场 / +1.556 logit(400 局)
 *     旧版一步封锁打贪心      68% 胜场 / +0.355 logit  ← 新版是它的 4.4 倍
 *   温度扫描 T=.02/.05/.15/.40 → +0.96/+1.15/+0.79/+0.46,T=0.05 最优(强+略抖)。
 *   候选放宽反而更差(优胜者诅咒):K=40 比 K=10 差 0.33 logit。
 *
 *   ⚠ 一手要 ~220 ms。node 是单线程,同步跑会卡住所有房间,所以 chooseAsync 每 ~12 ms
 *   让出一次事件循环;调用方 await 完必须重新校验 token(局面可能已经变了)。 */
const path = require("path");
const D = require("./draft");
const F = require("./mcts_fast.js");
const P = require("./mcts_policy.js");

const K_TOP = +process.env.AI_K || 10, N_SIM = +process.env.AI_N || 128, TEMP = +process.env.AI_T || 0.05;
const SLICE_MS = +process.env.AI_SLICE_MS || 12;

let G = null, win = null, items4pool = new WeakMap(), ORD = null;
function boot() {
  if (G) return true;
  try {
    win = F.loadModel(path.join(__dirname, "..", "public"));
    G = F.buildEngine(win); ORD = D.draftOrder();
    return true;
  } catch (e) { console.error("ai.boot", e); return false; }
}
const heroSkey = k => { const h = win.AD_HEROES.find(x => x.key === k); return h ? "hero:" + h.id : k; };
/* 池子固定,items 表可以缓存 */
function itemsOf(pool) {
  let it = items4pool.get(pool);
  if (it) return it;
  it = [];
  pool.heroKeys.forEach(k => { const s = heroSkey(k); it.push({ key: k, skey: s, kind: 0, p: G.at(s) }); });
  pool.basics.forEach(k => it.push({ key: k, skey: k, kind: 1, p: G.at(k) }));
  pool.ults.forEach(k => it.push({ key: k, skey: k, kind: 2, p: G.at(k) }));
  items4pool.set(pool, it);
  return it;
}
/* 把 draft.js 的房间状态搬进增量引擎(累加量与顺序无关,基准 z 用官方打分补一次) */
function simFrom(st) {
  /* st.order:可选的自定义顺序(读屏插件按空槽数生成剩余顺序);st.blocked:已选走但不知归谁的东西,只从池子里封掉 */
  const items = itemsOf(st.pool), s = F.makeSim(G, items, st.order || ORD);
  const byKey = new Map(items.map((x, i) => [x.key, i]));
  for (const k of st.blocked || []) { const i = byKey.get(k); if (i !== undefined) s.taken[i] = 1; }
  const seatKeys = [];
  st.seats.forEach((seat, si) => {
    const ks = []; if (seat.hero) ks.push(seat.hero);
    (seat.basics || []).forEach(x => ks.push(x)); if (seat.ult) ks.push(seat.ult);
    seatKeys.push(ks.map(k => items[byKey.get(k)].skey));
    for (const k of ks) {
      const i = byKey.get(k); if (i === undefined) continue;
      const p = items[i].p; s.taken[i] = 1; s.slot[si * 3 + items[i].kind]++;
      F.seedItem(s, si, p);
    }
  });
  s.step = st.step;
  s.z = win.ADScore.evaluate(seatKeys).logit;
  return s;
}
const yieldNow = () => new Promise(r => setImmediate(r));
let SEQ = 0;
/* 与 research/mcts 离线验证版同一套调度(三轮淘汰 + 共用随机数),只是插了让出点 */
async function mctsAsync(sim) {
  const BI = new Int32Array(700), BV = new Float64Array(700);
  const cands = P.topK(sim, K_TOP, BI, BV);
  if (!cands.length) return -1;
  if (cands.length === 1) return cands[0].i;
  const sg = F.moverSign(sim), seed0 = (SEQ++) * 104729 + 1;
  let live = cands.map(c => { const t = F.cloneSim(sim); F.applySim(t, c.i); return { i: c.i, st: t, sum: 0, n: 0 }; });
  let budget = N_SIM, done = 0, t0 = Date.now();
  for (let r = 0; r < 3; r++) {
    const per = Math.max(8, Math.round(budget * (r === 2 ? 1 : 0.4)));
    for (let j = 0; j < per; j++) {
      const sd = seed0 + (done + j) * 7919;
      for (const c of live) { c.sum += sg * P.playoutSoft(c.st, TEMP, P.mkRnd(sd)); c.n++; }
      if (Date.now() - t0 >= SLICE_MS) { await yieldNow(); t0 = Date.now(); }
    }
    done += per;
    if (r < 2 && live.length > 2) {
      live.sort((a, b) => b.sum / b.n - a.sum / a.n);
      live = live.slice(0, Math.max(2, Math.ceil(live.length / 2)));
      budget = Math.max(8, budget - per);
    }
  }
  live.sort((a, b) => b.sum / b.n - a.sum / a.n);
  return live[0].i;
}
/* 出错就退回一步封锁,再退回随机合法,别把整局卡死 */
async function chooseAsync(st) {
  try {
    if (boot()) {
      const sim = simFrom(st);
      if (!F.simDone(sim)) {
        const i = await mctsAsync(sim);
        if (i >= 0) return itemsOf(st.pool)[i].key;
      }
    }
  } catch (e) { console.error("ai.chooseAsync", e); }
  return choose(st);
}
/* 全知模式:两级出数。
 *   第一级 = AI 自己的候选(一步加分前 K_TOP=10),每个 OMNI_M=128 次走子取平均 —— 和 AI 一手同量级(~0.4 s),算完立刻推;
 *   第二级 = 其余合法候选按一步加分从高到低分块补算,每块推一次,前端边收边更新前三。
 *   顺带评当前局面本身(同一批随机数直接走完)当基线。z 是左方视角 logit 均值。
 *   alive() 返回 false 就中止(人已经落子/重置了,算了也白算);每 ~12 ms 让出一次事件循环。
 *   为什么比 AI 一手贵:AI 只评 10 个候选还三轮淘汰(≈800 次走子);全扫是 ~55 个候选 × 128 次(≈7000 次),差 9 倍。 */
const OMNI_M = +process.env.OMNI_M || 128, OMNI_CHUNK = +process.env.OMNI_CHUNK || 6;
const OMNI_SWEEP = process.env.OMNI_SWEEP !== "0";     // =0 只算 AI 那 10 个,不扫其余
async function omniAsync(st, onBatch, alive) {
  if (!boot()) return null;
  const sim = simFrom(st);
  if (F.simDone(sim)) return null;
  const items = itemsOf(st.pool);
  const BI = new Int32Array(700), BV = new Float64Array(700);
  const n = F.scoreAll(sim, BI, BV);
  if (!n) return null;
  const order = Array.from({ length: n }, (_, c) => c).sort((a, b) => BV[b] - BV[a]);   // 一步加分高的先算
  const cands = order.map(c => ({ key: items[BI[c]].key, i: BI[c], d1: BV[c], z: null }));
  const seed0 = (SEQ++) * 104729 + 1;
  let t0 = Date.now();
  const tick = async () => { if (Date.now() - t0 >= SLICE_MS) { await yieldNow(); t0 = Date.now(); return !alive || alive(); } return true; };
  /* 一个局面走 OMNI_M 次取均值 */
  const evalSim = async s => { let sum = 0;
    for (let j = 0; j < OMNI_M; j++) { sum += P.playoutSoft(s, TEMP, P.mkRnd(seed0 + j * 7919)); if (!(await tick())) return null; }
    return sum / OMNI_M; };
  const base = await evalSim(sim); if (base == null) return null;
  const doneCount = () => cands.filter(c => c.z != null).length;
  const pack = stage => ({ stage, n: doneCount(), N: cands.length, M: OMNI_M, K: Math.min(K_TOP, n), base,
    vals: Object.fromEntries(cands.filter(c => c.z != null).map(c => [c.key, { z: c.z, d1: c.d1 }])) });
  const evalCand = async c => { const t = F.cloneSim(sim); F.applySim(t, c.i); const z = await evalSim(t); if (z == null) return false; c.z = z; return true; };
  /* 第一级:AI 的候选 */
  for (const c of cands.slice(0, K_TOP)) if (!(await evalCand(c))) return null;
  if (alive && !alive()) return null;
  if (onBatch) onBatch(pack(OMNI_SWEEP && n > K_TOP ? "top" : "done"));
  if (!OMNI_SWEEP) return pack("done");
  /* 第二级:其余候选分块补 */
  for (let k = K_TOP; k < n; k += OMNI_CHUNK) {
    for (const c of cands.slice(k, k + OMNI_CHUNK)) if (!(await evalCand(c))) return null;
    if (alive && !alive()) return null;
    if (onBatch) onBatch(pack(k + OMNI_CHUNK < n ? "sweep" : "done"));
  }
  return pack("done");
}
/* 顶栏实时胜率(以前在浏览器里用公开权重算,现在搬到服务端)。
   口径和旧前端 rollout 一致:从 st 这个局面起,双方每手都挑纯 Δlogit 最大的(不带 policyBonus),
   一路贪心选到满编,返回左方最终胜率。增量引擎一次 < 5 ms,同步跑即可。 */
function greedyProb(st) {
  if (!boot()) return null;
  const s = simFrom(st);
  while (!F.simDone(s)) {
    const seat = s.order[s.step], sg = seat < 5 ? 1 : -1;
    let b = -1, bv = -Infinity;
    for (let i = 0; i < s.nItems; i++) {
      if (s.taken[i] || s.slot[seat * 3 + s.items[i].kind] >= F.CAP[s.items[i].kind]) continue;
      const v = sg * F.deltaOf(s, i);
      if (v > bv) { bv = v; b = i; }
    }
    if (b < 0) break;
    F.applySim(s, b);
  }
  return 1 / (1 + Math.exp(-s.z));
}
function choose(st) {
  try {
    if (boot()) { const sim = simFrom(st);
      if (!F.simDone(sim)) { const i = P.denial(sim, K_TOP); if (i >= 0) return itemsOf(st.pool)[i].key; } }
  } catch (e) { console.error("ai.choose", e); }
  return D.autoPick(st);
}
module.exports = { choose, chooseAsync, omniAsync, greedyProb, NAME: "AI · 走子取平均", _simFrom: st => (boot(), simFrom(st)) };  // _simFrom 仅供自测
