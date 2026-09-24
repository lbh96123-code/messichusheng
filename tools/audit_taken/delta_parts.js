"use strict";
/* 拆开看: 模型给「午夜凋零」的分是怎么来的, 以及它和真实数据(胜率/抓位)对不对得上。 */
const path = require("path");
const APP = "/home/ec2-user/work/game/ad-draft/app";
const E = require(APP + "/test/_env.js"); E.init();
const R = require(APP + "/recog.js"), T = require(APP + "/trace.js");
const Dr = require(APP + "/engine/server/draft.js"), F = require(APP + "/engine/server/mcts_fast.js");
const AI = require(APP + "/engine/server/ai.js");
const win = F.loadModel(APP + "/engine/public");
const A = win.AD_ABILITIES;
const FULL_ORDER = [0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9];
const seatIdx = p => (p.side === "L" ? 0 : 5) + p.idx;
const NAMES = ["L1","L2","L3","L4","L5","R1","R2","R3","R4","R5"];
function buildState(S, startIdx) {
  const pool = { heroKeys: S.pool_heroes.slice(), basics: [], ults: [], filled: [] };
  for (const s of S.skills) { const a = A[s.key]; if (!a) continue; (s.ultslot || a.ult) ? pool.ults.push(s.key) : pool.basics.push(s.key); }
  const st = Dr.newState(pool); const placed = new Set(); const unkUsed = new Array(10).fill(0);
  for (const p of S.panels) { const seat = st.seats[seatIdx(p)];
    if (p.hero) { seat.hero = p.hero; seat.seq.push(p.hero); placed.add(p.hero); }
    for (const s of p.skills || []) { if (!s || s.key === "?") continue;
      if (!A[s.key]) { unkUsed[seatIdx(p)]++; continue; }
      const isU = pool.ults.includes(s.key);
      if (isU) { if (!seat.ult) { seat.ult = s.key; seat.seq.push(s.key); placed.add(s.key); } }
      else if (seat.basics.length < 3 && !seat.basics.includes(s.key)) { seat.basics.push(s.key); seat.seq.push(s.key); placed.add(s.key); } } }
  const takenAll = S.skills.filter(s => s.taken).map(s => s.key).concat(S.taken_heroes || []);
  st.taken = [...placed]; st.blocked = Array.from(new Set(takenAll)).filter(k => !placed.has(k));
  const left = st.seats.map((s, i) => Math.max(0, 5 - (s.hero?1:0) - s.basics.length - (s.ult?1:0) - unkUsed[i])); const order = [];
  for (let pass = 0; pass < 2 && left.some(v => v > 0); pass++)
    for (let j = pass ? 0 : startIdx; j < FULL_ORDER.length; j++) { const x = FULL_ORDER[j]; if (left[x] > 0) { left[x]--; order.push(x); } }
  st.order = order; st.step = 0; return { st, cur: order.length ? order[0] : FULL_ORDER[startIdx] };
}
const { head, frames } = T.read(process.argv[2]);
const TARGET = +process.argv[3], WANT = process.argv[4];
const t = T.restore(head); t.fullOrder = FULL_ORDER;
t.orderSeat = n => { const x = FULL_ORDER[Math.max(0, Math.min(n, FULL_ORDER.length - 1))]; return [x < 5 ? "L" : "R", x % 5]; };
let S = null;
for (const e of frames) { if (e.ms > TARGET) break;
  const src = new T.Frame(e, { poolKeys: head.poolKeys });
  R.setSource(src); t.cursor = e.cursor || null; try { S = t.update(null); } finally { R.setSource(null); } }
const nTaken = S.skills.filter(x => x.taken).length + (S.taken_heroes || []).length;
let startIdx = Math.min(nTaken, FULL_ORDER.length - 1);
if (WANT) { while (startIdx < FULL_ORDER.length && NAMES[FULL_ORDER[startIdx]] !== WANT) startIdx++; }
const { st, cur } = buildState(S, startIdx);
const sim = AI._simFrom(st), sg = cur < 5 ? 1 : -1;
const out = new Float64Array(6);
const rows = [];
for (let i = 0; i < sim.nItems; i++) { if (sim.taken[i]) continue; const it = sim.items[i];
  if (sim.slot[cur * 3 + it.kind] >= [1,3,1][it.kind]) continue;
  F.deltaParts(sim, i, out);
  const a = A[it.key] || {};
  rows.push({ name: R.cn(it.key), kind: it.kind, d: sg * F.deltaOf(sim, i),
    W: sg * out[0], syn: sg * out[1], cp: sg * out[2], gold: out[3], ax: out[4], tq: out[5],
    wr: a.wr, pos: a.pos, picks: a.picks }); }
rows.sort((a, b) => b.d - a.d);
console.log(`${NAMES[cur]} 这一手(已选走 ${nTaken}), 按模型「一步加分」排序。Δ = 单件W + 配合syn + 配对cp + 打钱 + 队伍轴 + 配比\n`);
console.log("排名 技能        Δ总分    单件W    配合syn   配对cp   打钱    队伍轴   配比   | 真实数据 胜率  抓位  被拿次数");
rows.slice(0, 14).forEach((r, i) => {
  const f = v => (v >= 0 ? "+" : "") + v.toFixed(3);
  console.log(`${String(i+1).padStart(3)}. ${r.name.padEnd(10)} ${f(r.d)}  ${f(r.W)}  ${f(r.syn)}  ${f(r.cp)}  ${f(r.gold)}  ${f(r.ax)}  ${f(r.tq)} | ${r.wr ? (100*r.wr).toFixed(1)+"%" : "  -  "} ${r.pos ? r.pos.toFixed(1) : " - "}  ${r.picks || "-"}`);
});
const mp = rows.findIndex(r => r.name === "午夜凋零");
if (mp >= 14) { const r = rows[mp]; const f = v => (v >= 0 ? "+" : "") + v.toFixed(3);
  console.log(`${String(mp+1).padStart(3)}. ${r.name.padEnd(10)} ${f(r.d)}  ${f(r.W)}  ${f(r.syn)}  ${f(r.cp)}  ${f(r.gold)}  ${f(r.ax)}  ${f(r.tq)} | ${(100*r.wr).toFixed(1)}% ${r.pos.toFixed(1)}  ${r.picks}  ←`); }

/* 全库: 模型单件分 W 与真实胜率/抓位的关系 */
console.log("\n\n=== 全库 640 件: 模型的单件分 W vs 真实数据 ===");
const G = sim.G; const all = [];
for (const k in A) { const a = A[k]; const p = G.at(k); if (p == null || p < 0) continue;
  if (a.wr == null || a.pos == null) continue;
  all.push({ name: R.cn(k), W: G.W[p], wr: a.wr, pos: a.pos, picks: a.picks || 0 }); }
all.sort((a, b) => b.W - a.W);
const mi = all.findIndex(x => x.name === "午夜凋零");
console.log(`共 ${all.length} 件有数据。午夜凋零 单件分 W 排第 ${mi + 1} 名 (W=${all[mi].W.toFixed(4)}, 胜率 ${(100*all[mi].wr).toFixed(1)}%, 抓位 ${all[mi].pos.toFixed(1)})`);
console.log("\n模型 W 最高的 10 件:");
all.slice(0, 10).forEach((x, i) => console.log(`  ${i+1}. ${x.name.padEnd(10)} W=${x.W.toFixed(4)}  真实胜率 ${(100*x.wr).toFixed(1)}%  抓位 ${x.pos.toFixed(1)}`));
/* 相关性: W 与 wr、W 与 pos */
const corr = (xs, ys) => { const n = xs.length, mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0,syy=0; for (let i=0;i<n;i++){const a=xs[i]-mx,b=ys[i]-my; sxy+=a*b; sxx+=a*a; syy+=b*b;} return sxy/Math.sqrt(sxx*syy); };
const Ws = all.map(x=>x.W), wrs = all.map(x=>x.wr), poss = all.map(x=>x.pos);
console.log(`\n相关系数: W ↔ 真实胜率 ${corr(Ws,wrs).toFixed(3)} | W ↔ 抓位(越小越早被抢) ${corr(Ws,poss).toFixed(3)}`);
/* 按抓位分档, 看模型 W 的平均水平 */
console.log("\n按真实抓位分档, 模型给的平均单件分:");
const bins = [[0,10],[10,20],[20,30],[30,40],[40,60]];
for (const [lo,hi] of bins) { const g = all.filter(x=>x.pos>=lo&&x.pos<hi); if (!g.length) continue;
  const mW = g.reduce((a,b)=>a+b.W,0)/g.length, mwr = g.reduce((a,b)=>a+b.wr,0)/g.length;
  console.log(`  抓位 ${String(lo).padStart(2)}~${String(hi).padStart(2)}: ${String(g.length).padStart(3)} 件, 平均 W ${mW>=0?"+":""}${mW.toFixed(4)}, 平均真实胜率 ${(100*mwr).toFixed(1)}%`); }
