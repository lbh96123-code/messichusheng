"use strict";
/* 常驻真机基准(2.0 第 0 步)。
   把 realframes/ 里的真实截图跑成一张**成绩单**, 和上一次的成绩单逐项对照, 有变化就列出来。
   没有人工标注, 所以判据全部取"结构上必然成立"的那种:
     · 池子:12 个英雄、行裕度、认不出的格数、补位/救回的格数;
     · 池外高分:面板里只可能出现池子里的技能 —— 出现了池外的高分匹配, 就是**池子读错的铁证**;
     · 面板空槽:锁池帧上"有图标的槽数"必须等于棋盘上已变暗的技能格数(± 容忍), 多出来的就是假图标;
     · 三态:同一局的两帧(池子英雄集合相同)互为参考, 数 T/N/O 并列出判"被选走"的键。
   用法:  node test/baseline.js            跑一遍并与 test/baseline.json 对照
          node test/baseline.js --accept   把这次的结果存成新基准
          node test/baseline.js --only xxx 只跑名字含 xxx 的帧 */
const fs = require("fs"), path = require("path");
const E = require("./_env.js"), R = E.init();
const OUT = path.join(__dirname, "baseline.json");
const args = process.argv.slice(2), ACCEPT = args.includes("--accept");
const ONLY = (args.indexOf("--only") >= 0) ? args[args.indexOf("--only") + 1] : null;
const r2 = v => Math.round(v * 100) / 100;
const pq = q => q[0] + (q[1] + 1);

function measure(fr) {
  const img = E.load(fr.path); R.rescale(img.w, img.h);
  const t = new R.Tracker(); const q = t.reset(img);
  const rec = { res: [img.w, img.h],
    lock: { nd: q.nd, heroes: q.heroes, margin: r2(q.minMargin), dark: q.darkCells, ratio: r2(q.ratio),
            ok: q.heroes === 12 && q.minMargin > 0.04 },   // 线上 tryLock 的接受条件
    heroes: t.pool.poolHeroes.slice().sort() };
  /* 池子逐格 */
  rec.cells = t.pool.skills.slice().sort((a, b) => a.cell - b.cell).map(s => ({
    c: s.cell, k: s.key, s: r2(s.s1),
    f: [s.ultslot && "大", s.unknown && "未知", s.filler && "补位", s.rescued && "救回", s.byElim && "排除法"].filter(Boolean).join("+") || "" }));
  rec.unknown = rec.cells.filter(c => c.k[0] === "?").length;
  rec.rescued = rec.cells.filter(c => c.f.includes("救回")).length;
  rec.filler = rec.cells.filter(c => c.f.includes("补位")).length;
  /* 面板:先按池子候选认, 再看全库 —— 全库最像的不在池子里且明显更像 = 池子读错 */
  const poolKeys = t.pool.skills.filter(s => !s.unknown).map(s => s.key), inPool = new Set(poolKeys);
  R.calibratePanels(img, poolKeys);
  const panels = R.readPanels(img, false);
  /* 本人座位(v1.22):这一帧头像侧绿框投出的一票("R4" = 右5, 下标从 0 起);null = 没有明显的绿框 */
  { const tm = new R.Tracker(); tm.updateMe(panels); rec.me = tm.meVotes[0] || null; rec.meRim = panels.map(p => r2(p.selfRim || 0)); }
  rec.slotAdj = JSON.parse(JSON.stringify(R.LAYOUT() && { L: 0, R: 0 })) && undefined;
  rec.panels = []; rec.outOfPool = []; const sVals = [];
  for (const p of panels) { const seat = pq([p.side, p.idx]), slots = [];
    for (let j = 0; j < 4; j++) { if (!p.skills[j]) { slots.push(null); continue; }
      const b = p.slotBoxes[j], ip = R.matchSkill(img, b, poolKeys), g = R.matchSkill(img, b, null);
      sVals.push(ip.s1);
      slots.push({ k: ip.key, s: r2(ip.s1), g: g.key, gs: r2(g.s1) });
      if (!inPool.has(g.key) && g.s1 >= 0.6 && g.s1 - ip.s1 >= 0.1) rec.outOfPool.push({ seat, j, g: g.key, gs: r2(g.s1), p: ip.key, ps: r2(ip.s1) }); }
    rec.panels.push({ seat, filled: p.filled, slots }); }
  sVals.sort((a, b) => a - b);
  rec.slotScore = { n: sVals.length, med: sVals.length ? r2(sVals[sVals.length >> 1]) : null, lo: sVals.length ? r2(sVals[0]) : null };
  /* 计数等式:面板里有图标的槽数 vs 棋盘上"看着已被选走"的技能格数 */
  const preTaken = (t.preTaken || []).filter(k => !k.startsWith("hero:")).length;
  rec.count = { slots: sVals.length, boardTakenSkills: preTaken, heroCardsDark: (t.preTaken || []).filter(k => k.startsWith("hero:")).length };
  /* 面板英雄名 */
  rec.names = [];
  for (const p of panels) { const cands = t.pool.poolHeroes.concat([null]);
    const r = R.readHeroName(img, p.side, p.idx, cands, 29, { x: p.side === "L" ? 50 : 181, y: 7, r: 5 });
    rec.names.push({ seat: pq([p.side, p.idx]), h: r[0][1], s: r2(r[0][0]), lead: r2(r[0][0] - (r[1] ? r[1][0] : -1)) }); }
  return { rec, t, img };
}

/* ---- 跑 ---- */
const all = E.frames().filter(f => !ONLY || f.name.includes(ONLY));
const cur = { v: 1, frames: {}, pairs: {} };
const keep = [];                                   // 用于配对的锁池状态(只留 pool/refB, 不留图)
for (const fr of all) {
  const t0 = Date.now(); let m;
  try { m = measure(fr); } catch (e) { cur.frames[fr.name] = { error: String(e.message || e) }; console.log(`${fr.name}  ✗ ${e.message}`); continue; }
  cur.frames[fr.name] = m.rec;
  console.log(`${fr.name}  ${m.rec.res.join("x")} ${m.rec.lock.ok ? "锁池✓" : "不锁×"} 英雄${m.rec.lock.heroes} 裕度${m.rec.lock.margin} 未知${m.rec.unknown} 补位${m.rec.filler} 救回${m.rec.rescued} | 面板槽${m.rec.count.slots} 中位${m.rec.slotScore.med} 池外高分${m.rec.outOfPool.length} | ${Date.now() - t0}ms`);
  keep.push({ name: fr.name, path: fr.path, heroes: m.rec.heroes.join(","), t: m.t, res: m.rec.res });
  m.img = null; m.t.ref = null;                    // 丢掉参考帧的像素, 只留 pool/refB/refS
}
/* ---- 配对:谁和谁是同一局 ----
   判据是结构性的, 不靠文件名也不靠人工标注:拿 A 的池子去看 B, 那些判"没变"的格子应该**还是同一张图标**。
   同一局 → 吻合率很高;不同局 → 棋盘内容不一样, 吻合率立刻塌掉。顺便这个吻合率本身就是一条回归指标。 */
const AGREE_MIN = 0.8;
const refs = keep.filter(k => cur.frames[k.name].lock.ok);
for (const b of keep) {
  const cands = refs.filter(a => a.name !== b.name && a.res[0] === b.res[0] && a.res[1] === b.res[1]);
  if (!cands.length) continue;
  const img = E.load(b.path); R.rescale(img.w, img.h);
  for (const a of cands) {
    const pa = a.t.pool.align, { boxes } = R.boxesFor({}, pa.ox, pa.oy, pa.G), A = a.t.boxAdj || {};   // 和线上追踪一样:用 A 锁池时冻结的位置和几何, boxAdj 是相对它算的
    for (const c in A) if (boxes[c]) boxes[c] = [boxes[c][0] + A[c][0], boxes[c][1] + A[c][1], boxes[c][2] + A[c][2], boxes[c][3] + A[c][3]];
    const raw = R.takenFlags(img, a.t.refB, a.t.pool, boxes, a.t.refS);
    const cnt = { T: 0, N: 0, O: 0 }, tk = []; let agN = 0, agOk = 0;
    for (const s of a.t.pool.skills) { const st = raw[s.key]; cnt[st]++; if (st === "T") tk.push(s.key);
      if (st === "N" && !s.unknown) { agN++; if (R.matchSkill(img, boxes[s.cell], [s.key]).s1 >= 0.5) agOk++; } }
    for (const hb of a.t.pool.heroBoxes) { cnt[hb.state]++; if (hb.state === "T") tk.push("hero:" + hb.hero); }
    const agree = agN ? agOk / agN : 0;
    if (agree < AGREE_MIN || agN < 6) { if (process.env.PAIRDBG) console.log(`  (不配对 ${a.name} → ${b.name}: 吻合${(100*agree).toFixed(0)}% N=${agN} T=${cnt.T} O=${cnt.O})`); continue; }
    cur.pairs[`${a.name} → ${b.name}`] = { agree: r2(agree), T: cnt.T, N: cnt.N, O: cnt.O, taken: tk.sort() };
    console.log(`配对 ${a.name} → ${b.name}: 吻合${(100 * agree).toFixed(0)}% 被选走${cnt.T} 没变${cnt.N} 看不清${cnt.O}`); }
}

/* ---- 汇总:一眼能看的几个总数 ---- */
{ const F = Object.values(cur.frames).filter(f => !f.error), ok = F.filter(f => f.lock.ok);
  const sum = (a, g) => a.reduce((x, f) => x + g(f), 0);
  cur.summary = { frames: F.length, lockOk: ok.length,
    unknown: sum(ok, f => f.unknown), filler: sum(ok, f => f.filler), rescued: sum(ok, f => f.rescued),
    outOfPool: sum(ok, f => f.outOfPool.length), slots: sum(ok, f => f.count.slots),
    /* 锁池帧上的计数等式:有图标的槽数 应 = 棋盘上已变暗的技能格数。差额就是"面板假图标 或 棋盘漏看" */
    countGap: ok.map(f => f.count.slots - f.count.boardTakenSkills).filter(v => v !== 0).length,
    names: sum(ok, f => f.names.filter(n => n.h && n.s >= 0.4).length), pairs: Object.keys(cur.pairs).length };
  console.log("\n---- 汇总(只算线上会接受锁池的帧) ----");
  console.log(`  帧 ${cur.summary.frames} (可锁 ${cur.summary.lockOk}) | 未知格 ${cur.summary.unknown} 补位 ${cur.summary.filler} 救回 ${cur.summary.rescued}`);
  console.log(`  面板有图标槽 ${cur.summary.slots} | 池外高分(池子读错的铁证) ${cur.summary.outOfPool} | 计数等式不成立的帧 ${cur.summary.countGap}`);
  console.log(`  认出英雄名 ${cur.summary.names} | 同局配对 ${cur.summary.pairs}`); }

/* ---- 对照 ---- */
function diff(oldV, newV, prefix, out) {
  if (JSON.stringify(oldV) === JSON.stringify(newV)) return;
  const isObj = v => v && typeof v === "object";
  if (!isObj(oldV) || !isObj(newV) || Array.isArray(oldV) !== Array.isArray(newV)) { out.push(`${prefix}: ${JSON.stringify(oldV)} → ${JSON.stringify(newV)}`); return; }
  const keys = [...new Set([...Object.keys(oldV), ...Object.keys(newV)])];
  if (Array.isArray(oldV) && oldV.length !== newV.length) { out.push(`${prefix}: ${oldV.length} 项 → ${newV.length} 项`); return; }
  for (const k of keys) diff(oldV[k], newV[k], `${prefix}.${k}`, out);
}
if (ACCEPT || !fs.existsSync(OUT)) { fs.writeFileSync(OUT, JSON.stringify(cur, null, 1));
  console.log(`\n${fs.existsSync(OUT) ? "已写入" : "首次建立"}基准 ${OUT} (${all.length} 帧)`); process.exit(0); }
const prev = JSON.parse(fs.readFileSync(OUT)), out = [];
for (const n of new Set([...Object.keys(prev.frames), ...Object.keys(cur.frames)])) {
  if (ONLY && !n.includes(ONLY)) continue;
  if (!prev.frames[n]) { out.push(`＋ 新帧 ${n}`); continue; }
  if (!cur.frames[n]) { out.push(`－ 少了帧 ${n}`); continue; }
  diff(prev.frames[n], cur.frames[n], n, out); }
diff(prev.summary, cur.summary, "汇总", out);
for (const n of new Set([...Object.keys(prev.pairs || {}), ...Object.keys(cur.pairs)])) {
  if (ONLY) continue;
  diff((prev.pairs || {})[n], cur.pairs[n], "配对 " + n, out); }
console.log("\n================ 与上次基准的差异 ================");
if (!out.length) console.log("没有任何变化。");
else { out.slice(0, 200).forEach(l => console.log("  " + l)); if (out.length > 200) console.log(`  …还有 ${out.length - 200} 条`); }
console.log(`共 ${out.length} 处变化。确认无误后:  node test/baseline.js --accept`);
process.exit(out.length ? 1 : 0);
