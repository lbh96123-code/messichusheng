"use strict";
/* 回放到某一刻, 把那一手**所有候选**的完整排名算出来(日志里只记前三)。
   用法: node tools/audit_taken/rank_at.js <trace.jsonl> <相对 head.ts 的毫秒> [只看某个座位 L1/R3...] */
const APP = "/home/ec2-user/work/game/ad-draft/app";
const E = require(APP + "/test/_env.js"); E.init();
const R = require(APP + "/recog.js"), T = require(APP + "/trace.js");
const Dr = require(APP + "/engine/server/draft.js"), F = require(APP + "/engine/server/mcts_fast.js");
const AI = require(APP + "/engine/server/ai.js"), P = require(APP + "/engine/server/mcts_policy.js");
const win = F.loadModel(APP + "/engine/public");
const FULL_ORDER = [0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9];
const seatIdx = p => (p.side === "L" ? 0 : 5) + p.idx;
const NAMES = ["L1","L2","L3","L4","L5","R1","R2","R3","R4","R5"];
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
console.log(`回放到 ${new Date(head.ts + used.ms + 8*3600e3).toISOString().slice(11,19)} (帧${used.f}) 已选走 ${nTaken} → 算的是 ${NAMES[cur]} 这一手`);
const seat = st.seats[cur];
console.log(`${NAMES[cur]} 手上: 英雄 ${seat.hero ? R.cn(seat.hero) : "无"} | ${(seat.basics||[]).map(R.cn).join("/") || "无基础技能"} | 大招 ${seat.ult ? R.cn(seat.ult) : "无"}`);
/* 一步加分(纯 Δ) + 走子到满编取平均(AI 真正的口径) */
const sim = AI._simFrom(st);
const BI = new Int32Array(700), BV = new Float64Array(700);
const n = F.scoreAll(sim, BI, BV);
const sg = cur < 5 ? 1 : -1;
const rows = [];
for (let c = 0; c < n; c++) { const i = BI[c], key = sim.items[i].key;
  const s2 = F.cloneSim(sim); F.applySim(s2, i);
  let sum = 0; const M = +process.env.M || 128;
  for (let j = 0; j < M; j++) sum += P.playoutSoft(s2, 0.05, P.mkRnd(12345 + j * 7919));
  rows.push({ key, name: R.cn(key), d1: sg * BV[c], win: 1 / (1 + Math.exp(-sg * sum / M)) }); }
rows.sort((a, b) => b.win - a.win);
console.log(`\n候选 ${rows.length} 个, 走子取平均(M=${+process.env.M || 128})后的完整排名:`);
rows.forEach((r, i) => { const mark = /灵魂之链|血肉傀儡/.test(r.name) ? "  ←" : "";
  if (i < 12 || mark) console.log(`  ${String(i+1).padStart(2)}. ${r.name.padEnd(8)} 胜率 ${(100*r.win).toFixed(1)}%  一步加分 ${r.d1>=0?"+":""}${r.d1.toFixed(3)}${mark}`); });
