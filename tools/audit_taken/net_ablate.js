"use strict";
/* 消融: 网络给「午夜凋零」83.8% 到底是被什么驱动的。
   固定同一个局面, 逐个改输入看概率怎么变。 */
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
const CAPK = [1,3,1];
const WATCH = "午夜凋零";
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
const NETM = require(APP + "/netinfer.js").create(path.join(APP, "data", "netB300"));
/* 返回该局面下网络的原始输入, 供消融改动 */
function inputs(st, cur, tAbs) {
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
  return { sim, items, ids, code, dl, legal, slot, cur, tAbs };
}
function run(I, over = {}) {
  const ids = over.ids || I.ids, code = over.code || I.code, dl = over.dl || I.dl, legal = over.legal || I.legal;
  const t = over.t != null ? over.t : I.tAbs, slot = over.slot || I.slot, cur = over.cur != null ? over.cur : I.cur;
  const r = NETM.forward(ids, code, dl, legal, Math.max(0, Math.min(49, t)), cur, slot);
  let mx = -Infinity; for (const x of r.logits) if (x > mx) mx = x;
  let Z = 0; const ex = r.logits.map(x => x === -Infinity ? 0 : Math.exp(x - mx)); for (const x of ex) Z += x;
  const out = I.items.map((it, i) => ({ n: R.cn(it.key), p: legal[i] ? ex[i] / Z : 0 })).filter(x => x.p > 0);
  out.sort((a, b) => b.p - a.p);
  const w = out.findIndex(x => x.n === WATCH);
  return { top: out[0], watch: w >= 0 ? { rank: w + 1, p: out[w].p } : null, all: out };
}
const { head, frames } = T.read(process.argv[2]);
const TARGET = +process.argv[3], WANT = process.argv[4];
const tr = T.restore(head); tr.fullOrder = FULL_ORDER;
tr.orderSeat = n => { const x = FULL_ORDER[Math.max(0, Math.min(n, FULL_ORDER.length - 1))]; return [x < 5 ? "L" : "R", x % 5]; };
let S = null;
for (const e of frames) { if (e.ms > TARGET) break;
  const src = new T.Frame(e, { poolKeys: head.poolKeys });
  R.setSource(src); tr.cursor = e.cursor || null; try { S = tr.update(null); } finally { R.setSource(null); } }
const nTaken = S.skills.filter(x => x.taken).length + (S.taken_heroes || []).length;
let startIdx = Math.min(nTaken, FULL_ORDER.length - 1);
if (WANT) { while (startIdx < FULL_ORDER.length && ["L1","L2","L3","L4","L5","R1","R2","R3","R4","R5"][FULL_ORDER[startIdx]] !== WANT) startIdx++; }
const { st, cur } = buildState(S, startIdx);
const I = inputs(st, cur, startIdx);
const base = run(I);
console.log(`基准(原样): 第1名 ${base.top.n} ${(100*base.top.p).toFixed(1)}% | ${WATCH} 第${base.watch.rank}名 ${(100*base.watch.p).toFixed(1)}%\n`);

console.log("① 把「一步加分 dl」全置 0(不让网络看引擎的打分):");
{ const r = run(I, { dl: new Array(60).fill(0) });
  console.log(`   第1名 ${r.top.n} ${(100*r.top.p).toFixed(1)}% | ${WATCH} ${r.watch ? "第"+r.watch.rank+"名 "+(100*r.watch.p).toFixed(1)+"%" : "不在"}`); }

console.log("\n② 只改「第几手 t」, 其它不动:");
for (const t of [0, 2, 5, 10, 20, 30, 40, 49]) { const r = run(I, { t });
  console.log(`   t=${String(t).padStart(2)}: 第1名 ${r.top.n.padEnd(10)} ${(100*r.top.p).toFixed(1).padStart(5)}% | ${WATCH} 第${String(r.watch.rank).padStart(2)}名 ${(100*r.watch.p).toFixed(1).padStart(5)}%`); }

console.log("\n③ 只改「座位 seat」, 其它不动:");
for (const c of [0, 1, 2, 3, 4, 5, 9]) { const r = run(I, { cur: c });
  console.log(`   seat=${c}: 第1名 ${r.top.n.padEnd(10)} ${(100*r.top.p).toFixed(1).padStart(5)}% | ${WATCH} 第${String(r.watch.rank).padStart(2)}名 ${(100*r.watch.p).toFixed(1).padStart(5)}%`); }

console.log("\n④ 只改「已有槽位 slot」(假装我已经拿了几件), 其它不动:");
for (const s of [[0,0,0],[0,1,0],[0,2,0],[0,3,0],[1,0,0],[1,3,0],[1,3,1]]) { const r = run(I, { slot: s });
  console.log(`   slot=[英雄${s[0]} 基础${s[1]} 大招${s[2]}]: 第1名 ${r.top.n.padEnd(10)} ${(100*r.top.p).toFixed(1).padStart(5)}% | ${WATCH} 第${String(r.watch.rank).padStart(2)}名 ${(100*r.watch.p).toFixed(1).padStart(5)}%`); }

console.log("\n⑤ 只留下「午夜凋零 + 人类公认的好技能」做二选一(其它全部设为不可选):");
const pairs = ["骨隐步", "混乱之箭", "恶魔掌控", "织网", "黑洞", "智慧之刃"];
for (const pn of pairs) {
  const legal = new Array(60).fill(false);
  I.items.forEach((it, i) => { const n = R.cn(it.key); if (n === WATCH || n === pn) legal[i] = I.legal[i]; });
  if (!legal.some(Boolean)) continue;
  const r = run(I, { legal });
  const a = r.all.find(x => x.n === WATCH), b = r.all.find(x => x.n === pn);
  if (!a || !b) continue;
  const A2 = A[Object.keys(A).find(k => R.cn(k) === pn)] || {};
  console.log(`   ${WATCH} ${(100*a.p).toFixed(1).padStart(5)}%  vs  ${pn.padEnd(8)} ${(100*b.p).toFixed(1).padStart(5)}%   (${pn} 真实抓位 ${A2.pos ? A2.pos.toFixed(1) : "-"})`);
}

console.log("\n⑥ 只动「午夜凋零自己」的 dl, 别的技能不动:");
{ const wi = I.items.findIndex(it => R.cn(it.key) === WATCH);
  const cur0 = I.dl[wi];
  for (const v of [-0.3, -0.1, 0, cur0, 0.1, 0.2, 0.3]) {
    const dl = I.dl.slice(); dl[wi] = v; const r = run(I, { dl });
    const tag = Math.abs(v - cur0) < 1e-9 ? "  ← 真实值" : "";
    console.log(`   dl=${(v>=0?"+":"")+v.toFixed(3)}: ${WATCH} ${(100*r.watch.p).toFixed(1).padStart(5)}% 第${r.watch.rank}名 | 此时第1名 ${r.top.n}${tag}`); } }

console.log("\n⑦ 把「午夜凋零」的技能编号换成别的技能(dl 等其它输入原样不动):");
{ const wi = I.items.findIndex(it => R.cn(it.key) === WATCH);
  const others = I.items.map((it,i)=>({i,n:R.cn(it.key)})).filter(x=>I.legal[x.i] && x.n!==WATCH).slice(0,6);
  for (const o of others) { const ids = I.ids.slice(); ids[wi] = I.ids[o.i];
    const r = run(I, { ids });
    console.log(`   把它的编号换成「${o.n}」: 那个位置拿到 ${(100*r.all[0].p).toFixed(1)}%? 第1名 = ${r.top.n} ${(100*r.top.p).toFixed(1)}%`); } }
