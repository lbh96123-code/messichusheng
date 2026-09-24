"use strict";
/* 三个档各自反映了多少"人类抓位"信息?
   对随机池子的每一手, 把候选按三种口径排序, 分别和"真实抓位 pos"求 Spearman 相关:
     · 引擎一步加分 Δ
     · 网络 policy(网络档的排序依据)
     · 现役推演胜率(走子到满编 + ADScore 裁判 —— 组合版换的是走子策略, 裁判同一个)
   相关越负 = 越接近人类品味(pos 小 = 人类越早抢)。接近 0 = 这个口径基本不含抓位信息。
   用法: node tools/audit_taken/pickorder_info.js   (NPOOL / NHAND / M / SEED) */
const path = require("path");
const APP = "/home/ec2-user/work/game/ad-draft/app";
const E = require(APP + "/test/_env.js"); E.init();
const R = require(APP + "/recog.js");
const Dr = require(APP + "/engine/server/draft.js"), F = require(APP + "/engine/server/mcts_fast.js");
const AI = require(APP + "/engine/server/ai.js"), P = require(APP + "/engine/server/mcts_policy.js");
const win = F.loadModel(APP + "/engine/public");
const A = win.AD_ABILITIES;
const CAPK = [1,3,1];
const ORDER = []; { const round = []; for (let i = 0; i < 5; i++) round.push(i, 5 + i);
  for (let r = 0; r < 5; r++) ORDER.push(...(r % 2 ? round.slice().reverse() : round)); }
const NETM = require(APP + "/netinfer.js").create(path.join(APP, "data", "netB300"));
function feats(st, cur, tAbs, M) {
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
  const r = NETM.forward(ids, code, dl, legal, Math.max(0, Math.min(49, tAbs)), cur, slot);
  let mx = -Infinity; for (const x of r.logits) if (x > mx) mx = x;
  let Z = 0; const ex = r.logits.map(x => x === -Infinity ? 0 : Math.exp(x - mx)); for (const x of ex) Z += x;
  const out = [];
  for (let i = 0; i < 60; i++) { if (!legal[i]) continue; const it = items[i]; const a = A[it.key] || {};
    if (a.pos == null) continue;                       // 只统计有真实数据的
    const s2 = F.cloneSim(sim); F.applySim(s2, i);
    let sum = 0; for (let j = 0; j < M; j++) sum += P.playoutSoft(s2, 0.05, P.mkRnd(4242 + j * 7919));
    out.push({ key: it.key, dl: dl[i], net: ex[i] / Z, win: sg * sum / M, pos: a.pos, wr: a.wr }); }
  return out;
}
/* Spearman: 先转秩再求 pearson */
const rankOf = a => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  idx.forEach(([, i], k) => r[i] = k + 1); return r; };
const pearson = (xs, ys) => { const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0,syy=0; for (let i=0;i<n;i++){const a=xs[i]-mx,b=ys[i]-my; sxy+=a*b; sxx+=a*a; syy+=b*b;}
  return sxx && syy ? sxy/Math.sqrt(sxx*syy) : null; };
const spear = (xs, ys) => pearson(rankOf(xs), rankOf(ys));
let seed = +(process.env.SEED || 7777);
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const NPOOL = +(process.env.NPOOL || 25), NHAND = +(process.env.NHAND || 6), M = +(process.env.M || 48);
const acc = { dl: [], net: [], win: [], dlw: [], netw: [], winw: [] };
for (let g = 0; g < NPOOL; g++) {
  Dr.setExclusive(win.AD_EXCLUSIVE || []);
  const pool = Dr.buildPool(win.AD_HEROES, rnd);
  const st = Dr.newState(pool); st.taken = []; st.blocked = []; st.order = ORDER.slice(); st.step = 0;
  for (let h = 0; h < NHAND; h++) {
    const cur = ORDER[h];
    st.order = ORDER.slice(h); st.step = 0;
    let arr; try { arr = feats(st, cur, h, M); } catch (e) { break; }
    if (arr.length < 10) break;
    const pos = arr.map(x => x.pos), wr = arr.map(x => x.wr);
    acc.dl.push(spear(arr.map(x => x.dl), pos));
    acc.net.push(spear(arr.map(x => x.net), pos));
    acc.win.push(spear(arr.map(x => x.win), pos));
    acc.dlw.push(spear(arr.map(x => x.dl), wr));
    acc.netw.push(spear(arr.map(x => x.net), wr));
    acc.winw.push(spear(arr.map(x => x.win), wr));
    const best = arr.slice().sort((a, b) => b.net - a.net)[0];
    const seat = st.seats[cur];
    if (pool.ults.includes(best.key)) seat.ult = best.key;
    else if (pool.heroKeys.includes(best.key)) seat.hero = best.key;
    else seat.basics.push(best.key);
    seat.seq.push(best.key); st.taken.push(best.key);
  }
}
const mean = a => { const b = a.filter(x => x != null); return b.reduce((x, y) => x + y, 0) / b.length; };
console.log(`${NPOOL} 个随机池子 × 前 ${NHAND} 手, 每候选走子 ${M} 局。每手内部求 Spearman 秩相关, 再对所有手取平均。\n`);
console.log("口径                        与「真实抓位 pos」    与「真实胜率 wr」");
console.log("                            (负=越接近人类品味)   (正=跟着胜率走)");
const row = (n, a, b) => console.log(`  ${n.padEnd(26)} ${mean(a) >= 0 ? "+" : ""}${mean(a).toFixed(3)}              ${mean(b) >= 0 ? "+" : ""}${mean(b).toFixed(3)}`);
row("引擎一步加分 Δ", acc.dl, acc.dlw);
row("网络 policy(网络档排序)", acc.net, acc.netw);
row("现役推演胜率(裁判=ADScore)", acc.win, acc.winw);
console.log(`\n样本: ${acc.dl.filter(x=>x!=null).length} 手`);
console.log("说明: 组合版换的是走子策略(按网络出手), 裁判仍是同一个 ADScore, 所以「推演胜率」这行同样代表组合版的性质。");
