"use strict";
/* 回放 09-19 那局轨迹到崩溃时刻, 用真实局面查"引擎为什么会走到没得选" */
const APP = "/home/ec2-user/work/game/ad-draft/app";
const E = require(APP + "/test/_env.js"); E.init();
const R = require(APP + "/recog.js"), T = require(APP + "/trace.js");
const Dr = require(APP + "/engine/server/draft.js");
const F = require(APP + "/engine/server/mcts_fast.js");
const win = F.loadModel(APP + "/engine/public");
const FULL_ORDER = [0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9];
const seatIdx = p => (p.side === "L" ? 0 : 5) + p.idx;
const TARGET = +process.argv[3] || 241312;

/* 与 worker.js buildState 逐行等价 */
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
  const left = st.seats.map((s, i) => Math.max(0, 5 - (s.hero ? 1 : 0) - s.basics.length - (s.ult ? 1 : 0) - unkUsed[i])); const order = [];
  for (let pass = 0; pass < 2 && left.some(v => v > 0); pass++)
    for (let j = pass ? 0 : startIdx; j < FULL_ORDER.length; j++) { const x = FULL_ORDER[j]; if (left[x] > 0) { left[x]--; order.push(x); } }
  const cur = order.length ? order[0] : FULL_ORDER[Math.min(startIdx, FULL_ORDER.length - 1)];
  st.order = order; st.step = 0; return { st, cur, unkUsed, pool };
}

const { head, frames, scans } = T.read(process.argv[2]);
const t = T.restore(head); t.fullOrder = FULL_ORDER;
t.orderSeat = n => { const x = FULL_ORDER[Math.max(0, Math.min(n, FULL_ORDER.length - 1))]; return [x < 5 ? "L" : "R", x % 5]; };
let S = null, used = null;
for (const e of frames) { if (e.ms > TARGET) break;
  const src = new T.Frame(e, { poolKeys: head.poolKeys });
  R.setSource(src); t.cursor = e.cursor || null; try { S = t.update(null); used = e; } finally { R.setSource(null); } }
console.log(`回放到 ms=${used.ms} (帧 ${used.f}), 目标 ${TARGET}`);

const nTaken = S.skills.filter(x => x.taken).length + (S.taken_heroes || []).length;
const startIdx = Math.min(nTaken, FULL_ORDER.length - 1);
const { st, cur, unkUsed, pool } = buildState(S, startIdx);
console.log(`池子: 英雄 ${pool.heroKeys.length} 基础 ${pool.basics.length} 大招 ${pool.ults.length} (共 ${pool.heroKeys.length + pool.basics.length + pool.ults.length} 格)`);
console.log(`识别: 已选走 ${nTaken} | 归到人头上(placed) ${st.taken.length} | 拿走但不知归谁(blocked) ${st.blocked.length}`);
console.log(`剩余顺序 order 长度 ${st.order.length}, 第一手 = 座位 ${cur}`);
const names = ["L1","L2","L3","L4","L5","R1","R2","R3","R4","R5"];
st.seats.forEach((s, i) => { const need = 5 - (s.hero?1:0) - s.basics.length - (s.ult?1:0) - unkUsed[i];
  if (need > 0) console.log(`  ${names[i]}: 英雄${s.hero?"有":"无"} 基础${s.basics.length}/3 大招${s.ult?"有":"无"} 认不出的${unkUsed[i]} → 还要选 ${need} 手`); });

/* 池子里还剩多少可选(未被 taken/blocked), 按类型分 */
const sim = require(APP + "/engine/server/ai.js")._simFrom(st);
let free = [0,0,0];
for (let i = 0; i < sim.nItems; i++) if (!sim.taken[i]) free[sim.items[i].kind]++;
console.log(`池子里还能选的: 英雄 ${free[0]} 基础 ${free[1]} 大招 ${free[2]} = 共 ${free[0]+free[1]+free[2]} 样`);
console.log(`但所有人加起来还要选 ${st.order.length} 手 → ${st.order.length > free[0]+free[1]+free[2] ? "**供不应求, 必然有人没得选**" : "数量上够"}`);

/* 贪心走一遍, 找第一个没得选的手 */
const CAP = [1,3,1]; let s2 = sim, bad = [];
for (let step = 0; step < st.order.length; step++) {
  const seat = s2.order[s2.step]; let n = 0, pick = -1;
  for (let i = 0; i < s2.nItems; i++) if (!s2.taken[i] && s2.slot[seat*3 + s2.items[i].kind] < CAP[s2.items[i].kind]) { n++; if (pick < 0) pick = i; }
  if (!n) { const need = [0,1,2].filter(k => s2.slot[seat*3+k] < CAP[k]);
    bad.push(`第 ${step+1} 手 ${names[seat]} 没得选(他还缺 ${need.map(k=>["英雄","基础","大招"][k]).join("/")}, 池子里这几类都空了)`);
    s2.step++; continue; }
  F.applySim(s2, pick);
}
console.log(bad.length ? "\n没得选的手:\n  " + bad.join("\n  ") : "\n贪心走完全程, 没有无解的手");
