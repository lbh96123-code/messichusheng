"use strict";
/* 逐手对比两个档: 网络档(按"网络想出哪一手"排序) vs 现役推演(按走子胜率排序), 看分歧有多大。
   用法: node tools/audit_taken/net_vs_mcts.js <trace.jsonl>   环境变量 WATCH=技能中文名 盯住某一件 */
const path = require("path");
const APP = "/home/ec2-user/work/game/ad-draft/app";
const E = require(APP + "/test/_env.js"); E.init();
const R = require(APP + "/recog.js"), T = require(APP + "/trace.js");
const Dr = require(APP + "/engine/server/draft.js"), F = require(APP + "/engine/server/mcts_fast.js");
const AI = require(APP + "/engine/server/ai.js"), P = require(APP + "/engine/server/mcts_policy.js");
const win = F.loadModel(APP + "/engine/public");
const FULL_ORDER = [0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9];
const seatIdx = p => (p.side === "L" ? 0 : 5) + p.idx;
const NAMES = ["L1","L2","L3","L4","L5","R1","R2","R3","R4","R5"];
const CAPK = [1,3,1];
const WATCH = process.env.WATCH || "午夜凋零";
function buildState(S, startIdx) {
  const pool = { heroKeys: S.pool_heroes.slice(), basics: [], ults: [], filled: [] };
  for (const s of S.skills) { const a = win.AD_ABILITIES[s.key]; if (!a) continue; (s.ultslot || a.ult) ? pool.ults.push(s.key) : pool.basics.push(s.key); }
  const st = Dr.newState(pool); const placed = new Set(); const unkUsed = new Array(10).fill(0);
  for (const p of S.panels) { const seat = st.seats[seatIdx(p)];
    if (p.hero) { seat.hero = p.hero; seat.seq.push(p.hero); placed.add(p.hero); }
    for (const s of p.skills || []) { if (!s || s.key === "?") continue;
      if (!win.AD_ABILITIES[s.key]) { unkUsed[seatIdx(p)]++; continue; }
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
const NETM = require(APP + "/netinfer.js").create(path.join(APP, "data", "netB300"));
function netProbs(st, cur, t) {
  const sim = AI._simFrom(st), items = sim.items;
  const ids = new Array(60), code = new Array(60), dl = new Array(60), legal = new Array(60);
  const byKey = new Map(items.map((x, i) => [x.key, i])), seatOf = new Array(items.length).fill(-1);
  st.seats.forEach((s, si) => { for (const k of [s.hero, ...(s.basics || []), s.ult]) { const i = k == null ? undefined : byKey.get(k); if (i !== undefined) seatOf[i] = si; } });
  const mySide = cur < 5;
  for (let i = 0; i < 60; i++) { const it = items[i]; ids[i] = it.p >= 0 ? it.p : 640;
    let o = seatOf[i]; if (o < 0 && sim.taken[i]) o = mySide ? 5 + cur % 5 : cur % 5;
    const rel = o < 0 ? 0 : ((o % 5 - cur % 5) + 5) % 5;
    code[i] = o < 0 ? 0 : ((o < 5) === mySide ? 1 + rel : 6 + rel);
    legal[i] = !sim.taken[i] && it.p >= 0 && sim.slot[cur * 3 + it.kind] < CAPK[it.kind]; dl[i] = 0; }
  const saveStep = sim.step, saveOrder = sim.order; sim.order = [cur]; sim.step = 0;
  const sg = cur < 5 ? 1 : -1;
  for (let i = 0; i < 60; i++) if (legal[i]) dl[i] = sg * F.deltaOf(sim, i);
  sim.order = saveOrder; sim.step = saveStep;
  const slot = [sim.slot[cur*3], sim.slot[cur*3+1], sim.slot[cur*3+2]];
  const r = NETM.forward(ids, code, dl, legal, Math.max(0, Math.min(49, t)), cur, slot);
  let mx = -Infinity; for (const x of r.logits) if (x > mx) mx = x;
  let Z = 0; const ex = r.logits.map(x => x === -Infinity ? 0 : Math.exp(x - mx)); for (const x of ex) Z += x;
  const out = {}; items.forEach((it, i) => { if (legal[i]) out[it.key] = ex[i] / Z; }); return out;
}
/* 现役推演胜率(和插件格子上显示的胜率同口径) */
function mctsWin(st, cur) {
  const sim = AI._simFrom(st), sg = cur < 5 ? 1 : -1;
  const BI = new Int32Array(700), BV = new Float64Array(700), n = F.scoreAll(sim, BI, BV);
  const out = {};
  for (let c = 0; c < n; c++) { const i = BI[c]; const s2 = F.cloneSim(sim); F.applySim(s2, i);
    let sum = 0; const M = 64; for (let j = 0; j < M; j++) sum += P.playoutSoft(s2, 0.05, P.mkRnd(999 + j * 7919));
    out[sim.items[i].key] = 1 / (1 + Math.exp(-sg * sum / M)); }
  return out;
}
const { head, frames } = T.read(process.argv[2]);
const t = T.restore(head); t.fullOrder = FULL_ORDER;
t.orderSeat = n => { const x = FULL_ORDER[Math.max(0, Math.min(n, FULL_ORDER.length - 1))]; return [x < 5 ? "L" : "R", x % 5]; };
console.log("每一手: 网络最想出的是谁 / 它在推演胜率里排第几; 以及「" + WATCH + "」的两个名次\n");
console.log("已选走  网络第1名            网络%   它的推演胜率排名 |  " + WATCH + ": 网络名次  推演名次");
let S = null, lastN = -1;
for (const e of frames) {
  const src = new T.Frame(e, { poolKeys: head.poolKeys });
  R.setSource(src); t.cursor = e.cursor || null; try { S = t.update(null); } finally { R.setSource(null); }
  const nTaken = S.skills.filter(x => x.taken).length + (S.taken_heroes || []).length;
  if (nTaken === lastN || nTaken > 24) continue; lastN = nTaken;
  const startIdx = Math.min(nTaken, FULL_ORDER.length - 1);
  const { st, cur } = buildState(S, startIdx);
  if (!st.order.length) continue;
  let NP, MW; try { NP = netProbs(st, cur, startIdx); MW = mctsWin(st, cur); } catch (err) { continue; }
  const net = Object.entries(NP).map(([k, v]) => ({ k, n: R.cn(k), v })).sort((a, b) => b.v - a.v);
  const mw = Object.entries(MW).map(([k, v]) => ({ k, n: R.cn(k), v })).sort((a, b) => b.v - a.v);
  if (!net.length) continue;
  const top = net[0], topMctsRank = mw.findIndex(x => x.k === top.k) + 1;
  const wNet = net.findIndex(x => x.n === WATCH) + 1, wM = mw.findIndex(x => x.n === WATCH) + 1;
  console.log(`  ${String(nTaken).padStart(3)}   ${top.n.padEnd(12)} ${(100*top.v).toFixed(1).padStart(6)}%   第 ${String(topMctsRank).padStart(2)} 名 / ${mw.length}      |   ${wNet ? "第"+wNet : "—"}      ${wM ? "第"+wM : "—"}`);
}
