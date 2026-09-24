"use strict";
/* 全局扫描: 哪些技能被网络(policy)系统性地捧高 / 压低, 相对引擎的一步加分 Δ。
   随机生成 N 个池子, 每个池子走前若干手, 记录每件技能 "网络名次" 与 "引擎Δ名次" 的差。 */
const path = require("path");
const APP = "/home/ec2-user/work/game/ad-draft/app";
const E = require(APP + "/test/_env.js"); E.init();
const R = require(APP + "/recog.js");
const Dr = require(APP + "/engine/server/draft.js"), F = require(APP + "/engine/server/mcts_fast.js");
const AI = require(APP + "/engine/server/ai.js");
const win = F.loadModel(APP + "/engine/public");
const A = win.AD_ABILITIES;
const CAPK = [1,3,1];
const ORDER = []; { const round = []; for (let i = 0; i < 5; i++) round.push(i, 5 + i);
  for (let r = 0; r < 5; r++) ORDER.push(...(r % 2 ? round.slice().reverse() : round)); }
const NETM = require(APP + "/netinfer.js").create(path.join(APP, "data", "netB300"));
function netProbs(st, cur, tAbs) {
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
  items.forEach((it, i) => { if (legal[i]) out.push({ key: it.key, p: ex[i] / Z, dl: dl[i] }); });
  return out;
}
let seed = +(process.env.SEED || 20260920);
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const NPOOL = +(process.env.NPOOL || 40), NHAND = +(process.env.NHAND || 8);
const stat = {};   // key → {nNet, nDl, n}
for (let g = 0; g < NPOOL; g++) {
  Dr.setExclusive(win.AD_EXCLUSIVE || []);
  /* FORCE_HERO=英雄key 时, 只保留含该英雄的池子(小众英雄在随机池里样本太少) */
  let pool = Dr.buildPool(win.AD_HEROES, rnd);
  if (process.env.FORCE_HERO) { let tries = 0;
    while (!pool.heroKeys.includes(process.env.FORCE_HERO) && tries++ < 400) pool = Dr.buildPool(win.AD_HEROES, rnd);
    if (!pool.heroKeys.includes(process.env.FORCE_HERO)) continue; }
  const st = Dr.newState(pool); st.taken = []; st.blocked = []; st.order = ORDER.slice(); st.step = 0;
  for (let h = 0; h < NHAND; h++) {
    const cur = st.order[h] != null ? st.order[h] : 0;
    st.order = ORDER.slice(h); st.step = 0;
    let arr; try { arr = netProbs(st, cur, h); } catch (e) { break; }
    if (arr.length < 5) break;
    const byNet = arr.slice().sort((a, b) => b.p - a.p);
    const byDl = arr.slice().sort((a, b) => b.dl - a.dl);
    const rkNet = {}, rkDl = {};
    byNet.forEach((x, i) => rkNet[x.key] = i + 1);
    byDl.forEach((x, i) => rkDl[x.key] = i + 1);
    for (const x of arr) { const s = stat[x.key] = stat[x.key] || { nNet: 0, nDl: 0, n: 0 };
      s.nNet += rkNet[x.key]; s.nDl += rkDl[x.key]; s.n++; }
    /* 让网络自己选一手走下去 */
    const pick = byNet[0]; const seat = st.seats[cur];
    const a = A[pick.key];
    if (a) { if (pool.ults.includes(pick.key)) seat.ult = pick.key; else if (pool.heroKeys.includes(pick.key)) seat.hero = pick.key; else seat.basics.push(pick.key); seat.seq.push(pick.key); st.taken.push(pick.key); }
    else break;
  }
}
const rows = [];
for (const k in stat) { const s = stat[k]; if (s.n < (+process.env.MINN || 8)) continue;
  const a = A[k] || {};
  rows.push({ n: R.cn(k), net: s.nNet / s.n, dl: s.nDl / s.n, gap: s.nDl / s.n - s.nNet / s.n, cnt: s.n, wr: a.wr, pos: a.pos }); }
rows.sort((a, b) => b.gap - a.gap);
console.log(`${NPOOL} 个随机池子 × 前 ${NHAND} 手, 共 ${rows.length} 件技能有足够样本。`);
console.log("gap = 引擎Δ名次 − 网络名次, 越大 = 网络越把它往前捧\n");
console.log("被网络捧得最高的 12 件:");
console.log("  技能        网络平均名次  引擎Δ平均名次   gap   | 真实胜率 抓位");
rows.slice(0, 12).forEach(r => console.log(`  ${r.n.padEnd(10)} ${r.net.toFixed(1).padStart(8)} ${r.dl.toFixed(1).padStart(11)} ${r.gap.toFixed(1).padStart(8)}  | ${r.wr ? (100*r.wr).toFixed(1)+"%" : "  -  "} ${r.pos ? r.pos.toFixed(1) : " - "}`));
console.log("\n被网络压得最低的 6 件:");
rows.slice(-6).forEach(r => console.log(`  ${r.n.padEnd(10)} ${r.net.toFixed(1).padStart(8)} ${r.dl.toFixed(1).padStart(11)} ${r.gap.toFixed(1).padStart(8)}  | ${r.wr ? (100*r.wr).toFixed(1)+"%" : "  -  "} ${r.pos ? r.pos.toFixed(1) : " - "}`));
const mp = rows.findIndex(r => r.n === "午夜凋零");
if (mp >= 0) { const r = rows[mp];
  console.log(`\n午夜凋零: 排在"被捧"榜第 ${mp + 1} / ${rows.length} 名 (网络平均第 ${r.net.toFixed(1)}, 引擎Δ平均第 ${r.dl.toFixed(1)}, gap ${r.gap.toFixed(1)}, 样本 ${r.cnt})`); }
/* 相关性: 被捧程度 vs 真实抓位 */
const g = rows.filter(r => r.pos != null);
const corr = (xs, ys) => { const n = xs.length, mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0,syy=0; for (let i=0;i<n;i++){const a=xs[i]-mx,b=ys[i]-my; sxy+=a*b; sxx+=a*a; syy+=b*b;} return sxy/Math.sqrt(sxx*syy); };
console.log(`\n"被网络捧的程度" 与 真实抓位 的相关: ${corr(g.map(x=>x.gap), g.map(x=>x.pos)).toFixed(3)}  (正 = 越冷门越被捧)`);
console.log(`"被网络捧的程度" 与 真实胜率 的相关: ${corr(g.map(x=>x.gap), g.map(x=>x.wr)).toFixed(3)}`);
