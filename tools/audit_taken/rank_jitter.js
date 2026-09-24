"use strict";
/* 同一个局面, 组合版换随机种子跑几遍, 看名次稳不稳; 再用大样本(R 调大)看"真值"。 */
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
(async () => {
  const { head, frames } = T.read(process.argv[2]);
  const TARGET = +process.argv[3], WANT = process.argv[4];
  const RS = (process.env.RLIST || "16").split(",").map(Number);
  const SEEDS = +(process.env.SEEDS || 5);
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
  const C = require(APP + "/combo_local.js");
  for (const RR of RS) {
    await C.init(path.join(APP, "data", "netB300.onnx"), "cpu", 8 * RR);
    console.log(`\n===== K8 × R${RR}  (插件默认 R16) =====`);
    const tally = {};
    for (let s = 0; s < SEEDS; s++) {
      const r = await C.decide(JSON.parse(JSON.stringify(st)), cur, startIdx, { K: 8, R: RR, seed: 12345 + s * 7919 });
      const rows = r.rows || [];
      rows.forEach((x, i) => { const n = R.cn(x.key); (tally[n] = tally[n] || []).push({ rank: i + 1, win: x.win }); });
      console.log(`  种子${s + 1}: ` + rows.slice(0, 4).map((x, i) => `${i + 1}.${R.cn(x.key)}${(100 * x.win).toFixed(0)}%`).join("  "));
    }
    console.log(`  —— ${SEEDS} 个种子汇总 ——`);
    Object.entries(tally).sort((a, b) => (a[1].reduce((s, x) => s + x.rank, 0) / a[1].length) - (b[1].reduce((s, x) => s + x.rank, 0) / b[1].length))
      .forEach(([n, a]) => { const rk = a.map(x => x.rank), w = a.map(x => 100 * x.win);
        console.log(`    ${n.padEnd(9)} 名次 ${Math.min(...rk)}~${Math.max(...rk)}  胜率 ${Math.min(...w).toFixed(1)}~${Math.max(...w).toFixed(1)}%  (波动 ${(Math.max(...w) - Math.min(...w)).toFixed(1)}pp)`); });
  }
  process.exit(0);
})();
