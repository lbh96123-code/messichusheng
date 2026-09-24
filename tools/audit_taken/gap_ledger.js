"use strict";
/* 逐帧算"引擎眼里还要选的手数" vs "池子里还剩能选的样数", 看缺口什么时候出现 */
const APP = "/home/ec2-user/work/game/ad-draft/app";
const E = require(APP + "/test/_env.js"); E.init();
const R = require(APP + "/recog.js"), T = require(APP + "/trace.js");
const Dr = require(APP + "/engine/server/draft.js"), F = require(APP + "/engine/server/mcts_fast.js");
const AI = require(APP + "/engine/server/ai.js");
const win = F.loadModel(APP + "/engine/public");
const FULL_ORDER = [0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9,9,4,8,3,7,2,6,1,5,0,0,5,1,6,2,7,3,8,4,9];
const seatIdx = p => (p.side === "L" ? 0 : 5) + p.idx;
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
  st.order = order; st.step = 0; return { st, placedN: placed.size };
}
const { head, frames } = T.read(process.argv[2]);
const t = T.restore(head); t.fullOrder = FULL_ORDER;
t.orderSeat = n => { const x = FULL_ORDER[Math.max(0, Math.min(n, FULL_ORDER.length - 1))]; return [x < 5 ? "L" : "R", x % 5]; };
const rows = [];
for (const e of frames) {
  const src = new T.Frame(e, { poolKeys: head.poolKeys });
  let S; R.setSource(src); t.cursor = e.cursor || null; try { S = t.update(null); } finally { R.setSource(null); }
  const nTaken = S.skills.filter(x => x.taken).length + (S.taken_heroes || []).length;
  if (!nTaken) continue;
  const { st, placedN } = buildState(S, Math.min(nTaken, FULL_ORDER.length - 1));
  const sim = AI._simFrom(st); let free = 0; for (let i = 0; i < sim.nItems; i++) if (!sim.taken[i]) free++;
  rows.push({ ms: e.ms, taken: nTaken, placed: placedN, blocked: st.blocked.length, need: st.order.length, free, gap: st.order.length - free });
}
const hhmm = ms => new Date(head.ts + ms + 8 * 3600e3).toISOString().slice(11, 19);
console.log("时刻      已选走 归到人头 不知归谁 | 还要选 池里剩 缺口");
let firstBad = null;
for (const r of rows) { if (r.gap > 0 && !firstBad) firstBad = r; }
for (let i = 0; i < rows.length; i += Math.max(1, Math.floor(rows.length / 18))) { const r = rows[i];
  console.log(`${hhmm(r.ms)}  ${String(r.taken).padStart(5)} ${String(r.placed).padStart(7)} ${String(r.blocked).padStart(8)} | ${String(r.need).padStart(5)} ${String(r.free).padStart(6)} ${r.gap > 0 ? "  +" + r.gap + " ←没得选" : "  " + r.gap}`); }
if (firstBad) console.log(`\n缺口首次出现: ${hhmm(firstBad.ms)} (已选走 ${firstBad.taken} 件时, 不知归谁 ${firstBad.blocked} 件)`);
console.log(`全局: 不知归谁的最多 ${Math.max(...rows.map(r => r.blocked))} 件; 有缺口的帧 ${rows.filter(r => r.gap > 0).length}/${rows.length}`);
