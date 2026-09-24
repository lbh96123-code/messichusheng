"use strict";
/* jEEp(R3) 拿灵魂之链那一手, 他插件上真正显示的那档(组合版/GPU版)的排名。
   这里没显卡, 用 CPU 跑同一份 netB300.onnx —— 同网络、同推演、同种子, 数值一致, 只是慢。 */
const path = require("path");
const APP = "/home/ec2-user/work/game/ad-draft/app";
const E = require(APP + "/test/_env.js"); E.init();
const R = require(APP + "/recog.js"), T = require(APP + "/trace.js");
const Dr = require(APP + "/engine/server/draft.js"), F = require(APP + "/engine/server/mcts_fast.js");
const AI = require(APP + "/engine/server/ai.js");
const win = F.loadModel(APP + "/engine/public");
const FULL_ORDER = [0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9];
const seatIdx = p => (p.side === "L" ? 0 : 5) + p.idx;
const NAMES = ["L1","L2","L3","L4","L5","R1","R2","R3","R4","R5"];
const CAPK = [1,3,1];
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
/* 网络档出手概率(照抄 worker.js netProbs), 插件"还没轮到你"时按这个排序 */
function netProbs(st, cur, t) {
  const M = require(APP + "/netinfer.js").create(path.join(APP, "data", "netB300"));
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
  const r = M.forward(ids, code, dl, legal, Math.max(0, Math.min(49, t)), cur, slot);
  let mx = -Infinity; for (const x of r.logits) if (x > mx) mx = x;
  let Z = 0; const ex = r.logits.map(x => x === -Infinity ? 0 : Math.exp(x - mx)); for (const x of ex) Z += x;
  const out = {}; items.forEach((it, i) => { if (legal[i]) out[it.key] = ex[i] / Z; }); return out;
}
(async () => {
  const { head, frames } = T.read(process.argv[2]);
  const TARGET = +process.argv[3], WANT = process.argv[4];
  const t = T.restore(head); t.fullOrder = FULL_ORDER;
  t.orderSeat = n => { const x = FULL_ORDER[Math.max(0, Math.min(n, FULL_ORDER.length - 1))]; return [x < 5 ? "L" : "R", x % 5]; };
  let S = null, used = null;
  for (const e of frames) { if (e.ms > TARGET) break;
    const src = new T.Frame(e, { poolKeys: head.poolKeys });
    R.setSource(src); t.cursor = e.cursor || null; try { S = t.update(null); used = e; } finally { R.setSource(null); } }
  const nTaken = S.skills.filter(x => x.taken).length + (S.taken_heroes || []).length;
  let startIdx = Math.min(nTaken, FULL_ORDER.length - 1);
  if (WANT) { while (startIdx < FULL_ORDER.length && NAMES[FULL_ORDER[startIdx]] !== WANT) startIdx++; }
  const { st, cur } = buildState(S, startIdx);
  const seat = st.seats[cur];
  console.log(`${new Date(head.ts + used.ms + 8*3600e3).toISOString().slice(11,19)} 已选走 ${nTaken} → ${NAMES[cur]}(jEEp) 这一手`);
  console.log(`他手上: ${seat.hero ? R.cn(seat.hero) : "还没英雄"} | ${(seat.basics||[]).map(R.cn).join("/") || "无"} | 大招 ${seat.ult ? R.cn(seat.ult) : "无"}\n`);

  const NP = netProbs(st, cur, startIdx);
  const net = Object.entries(NP).map(([k, v]) => ({ name: R.cn(k), v })).sort((a, b) => b.v - a.v);
  console.log("【网络档】还没轮到他时, 插件按这个排序(网络觉得该出哪一手):");
  net.slice(0, 6).forEach((x, i) => console.log(`  ${i+1}. ${x.name.padEnd(9)} ${(100*x.v).toFixed(1)}%`));
  for (const kw of ["灵魂之链", "血肉傀儡"]) { const i = net.findIndex(x => x.name === kw);
    if (i >= 6) console.log(`  ${i+1}. ${kw.padEnd(9)} ${(100*net[i].v).toFixed(1)}%  ←`); }

  const C = require(APP + "/combo_local.js");
  const t0 = Date.now();
  await C.init(path.join(APP, "data", "netB300.onnx"), "cpu", 8 * 16);
  const r = await C.decide(JSON.parse(JSON.stringify(st)), cur, startIdx, { K: 8, R: 16, seed: 12345 });
  console.log(`\n【组合版/GPU版】K${r.K}×R${r.R}, 轮到他自己时插件显示的就是这张表 (CPU 跑了 ${((Date.now()-t0)/1000).toFixed(1)}s):`);
  (r.rows || []).forEach((x, i) => console.log(`  ${i+1}. ${R.cn(x.key).padEnd(9)} 胜率 ${(100*x.win).toFixed(1)}%   网络出手概率 ${(100*x.net).toFixed(1)}%`));
  process.exit(0);
})();
