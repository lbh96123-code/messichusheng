"use strict";
/* 本人座位(v1.22)回归。三部分:
   A. 真实截图:头像侧绿框能不能认出本人。
      标签只用有独立证据的:me_r5_1080_0914 = 用户确认(朋友 09-14 16:14 那局坐右5, 旧插件整局认成右2);
      其余 2560 帧 = 当时插件日志里的"我"(旧判据)与新判据一致, 两个独立方法互证。
      同一局的几帧必须给出同一个座位;任何一帧都不许出现两个强绿框。
   B. 投票逻辑(假面板):没证据不猜、票数不够不认、转场看不到绿框不丢、单帧噪声不改、分不清弃权、换座位要够票、手动优先、老轨迹没有字段。
   C. 真 worker 跑合成局:没有绿框 → 状态里"我"为空、不出推荐;出现绿框 → 自动认出并开始推荐;托盘手动指定立刻生效;改回自动恢复。
   用法: node test/me_seat.js */
const E = require("./_env.js"), R = E.init(), path = require("path"), { Worker } = require("worker_threads");
const S = require("./synth.js");
let fail = 0; const ok = (c, msg) => { console.log(`${c ? "  ✓" : "  ✗"} ${msg}`); if (!c) fail++; };
const nm = k => k ? k[0] + (+k.slice(1) + 1) : null;   // "R4" → "R5"
const voteOf = panels => { const t = new R.Tracker(); t.updateMe(panels); return nm(t.meVotes[0]); };

console.log("== A. 真实截图");
const TRUTH = {
  me_r5_1080_0914: "R5",                                                     // 用户确认
  snap_20260910_222103_pool: "L4", snap_20260910_225153_pool: "L4", snap_20260911_205753_pool_mid: "L4",   // 旧插件日志一致
  snap_20260912_020657_pool: "L1", snap_20260912_020752_pool: "L1",
  snap_20260912_152126_pool_mid: "L1", snap_20260912_152752_draft_end: "L1" };
const SAME_GAME = [["start_1080p_0911", "sheen_1080p_0911"], ["snap_20260911_232539_pool", "snap_20260911_232604_pool"],
  ["snap_20260912_152126_pool_mid", "屏幕截图 2026-09-12 152305", "屏幕截图 2026-09-12 152730", "屏幕截图 2026-09-12 152855"]];
const got = {}; let selfMin = 9, otherMax = 0, doubles = [];
for (const fr of E.frames()) {
  const img = E.load(fr.path); R.rescale(img.w, img.h); const P = R.readPanels(img, false);
  const v = voteOf(P), sc = P.map(p => p.selfRim).sort((a, b) => b - a); got[fr.name] = v;
  if (v) { selfMin = Math.min(selfMin, sc[0]); otherMax = Math.max(otherMax, sc[1]); } else otherMax = Math.max(otherMax, sc[0] < 0.42 ? sc[0] : 0);
  if (sc[1] >= 0.42) doubles.push(`${fr.name}(${sc[0].toFixed(2)}/${sc[1].toFixed(2)})`);
  if (TRUTH[fr.name]) ok(v === TRUTH[fr.name], `${fr.name}: ${v || "认不出"} (应为 ${TRUTH[fr.name]}, 最高 ${sc[0].toFixed(2)} 第二 ${sc[1].toFixed(2)})`);
}
ok(Object.keys(TRUTH).every(n => n in got), `标签帧都在测试集里 (缺: ${Object.keys(TRUTH).filter(n => !(n in got)).join(", ") || "无"})`);
for (const g of SAME_GAME) { const vs = g.map(n => got[n]).filter(Boolean); ok(vs.length >= 2 && vs.every(x => x === vs[0]), `同一局一致: ${g.map(n => `${n}=${got[n]}`).join(" ")}`); }
ok(doubles.length === 0, `没有一帧同时出现两个强绿框 (${doubles.join(", ") || "无"})`);
console.log(`  本人分数最低 ${selfMin.toFixed(2)} | 非本人最高 ${otherMax.toFixed(2)} | 门槛 0.42, 领先 0.25`);

console.log("== B. 投票逻辑");
const fake = m => ["L0", "L1", "L2", "L3", "L4", "R0", "R1", "R2", "R3", "R4"].map(k => ({ side: k[0], idx: +k[1], selfRim: m[k] || 0 }));
{ const t = new R.Tracker();
  for (let i = 0; i < 4; i++) t.updateMe(fake({})); ok(t.meSeat === null, "一直没有绿框 → 不猜(meSeat=null)");
  t.updateMe(fake({ R4: 0.8 })); t.updateMe(fake({ R4: 0.8 })); ok(t.meSeat === null, "只有 2 票 → 还不认定");
  t.updateMe(fake({ R4: 0.8 })); ok(String(t.meSeat) === "R,4" && /认出本人座位 R5/.test(t.meMsg || ""), `第 3 票 → 认定右5 (${t.meMsg})`); t.meMsg = null;
  for (let i = 0; i < 8; i++) t.updateMe(fake({})); ok(String(t.meSeat) === "R,4" && !t.meMsg, "翻牌动画 / 选完转场看不到绿框 8 次 → 仍是右5");
  t.updateMe(fake({ L2: 0.8 })); ok(String(t.meSeat) === "R,4", "单帧别处出现绿框 → 不改");
  t.updateMe(fake({ R4: 0.6, L2: 0.5 })); ok(t.meVotes[t.meVotes.length - 1] === null, "两个都绿(领先不到 0.25)→ 这帧弃权");
  t.updateMe(fake({ R4: 0.3 })); ok(t.meVotes[t.meVotes.length - 1] === null, "绿框分数 0.3(像绿头发头像)→ 弃权");
  t.meManual = ["L", 1]; t.updateMe(fake({})); ok(String(t.meSeat) === "L,1", "手动指定左2 → 立刻生效, 盖过自动");
  t.meManual = null; t.updateMe(fake({})); ok(String(t.meSeat) === "R,4", "取消手动 → 回到自动认定的右5"); }
{ const t = new R.Tracker();
  for (let i = 0; i < 3; i++) t.updateMe(fake({ R4: 0.8 })); t.meMsg = null;
  for (let i = 0; i < 3; i++) t.updateMe(fake({ R1: 0.8 })); ok(String(t.meSeat) === "R,4", "右2 刚有 3 票、右5 窗口里还有 3 票 → 不改(要确实换了)");
  for (let i = 0; i < 3; i++) t.updateMe(fake({ R1: 0.8 })); ok(String(t.meSeat) === "R,1" && /改判 R5 → R2/.test(t.meMsg || ""), `窗口里全是右2 → 改判 (${t.meMsg})`); }
{ const t = new R.Tracker(); for (let i = 0; i < 6; i++) t.updateMe(fake({}).map(p => { delete p.selfRim; return p; }));
  ok(t.meSeat === null, "老轨迹回放(面板没有 selfRim 字段)→ null, 不报错"); }

console.log("== C. worker 合成局");
const round = []; for (let i = 0; i < 5; i++) round.push(i, 5 + i);
const ORDER = []; for (let r = 0; r < 5; r++) ORDER.push(...(r % 2 ? round.slice().reverse() : round));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const w = new Worker(path.join(__dirname, "..", "worker.js"), { env: { ...process.env, AD_THREADS: "0" } });
  let ready = false, locked = false; const logs = [], states = [], advices = [];
  w.on("message", m => { if (m.type === "ready") ready = true;
    if (m.type === "log") { logs.push(`[${m.tag}] ${m.msg}`); if (m.tag === "pool" && /锁定/.test(m.msg)) locked = true; }
    if (m.type === "state" && !m.idle && !m.skipped) states.push(m);
    if (m.type === "advice" && m.stage === "done") advices.push(m); });
  for (let t = 0; !ready && t < 200; t++) await sleep(50);
  const H = S.pickHeroes(12, 7), sid = x => (x < 5 ? "L" : "R") + (x % 5), taken = new Set(), panels = {}, basics = H.flatMap(h => S.HERO[h].basics); let bi = 0, pick = 0;
  const send = (cur, me, meSeat) => { const img = S.render({ heroes: H, cur: [cur < 5 ? "L" : "R", cur % 5], me, taken, takenHeroes: new Set(), panels: JSON.parse(JSON.stringify(panels)) });
    const buf = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.length);
    w.postMessage({ type: "frame", w: img.w, h: img.h, buf, full: true, cursor: null, meSeat: meSeat || "auto" }, [buf]); };
  const step = async (me, meSeat, frames = 2) => { const x = ORDER[pick++], k = basics[bi++]; taken.add(k);
    const pn = panels[sid(x)] = panels[sid(x)] || { skills: [] }; pn.skills.push(k);
    for (let f = 0; f < frames; f++) { send(ORDER[pick], me, meSeat); await sleep(250); } };
  w.postMessage({ type: "display", w: 2560, h: 1440 });
  // 1) 没有绿框
  for (let i = 0; i < 3; i++) { send(0, undefined); await sleep(300); }
  for (let i = 0; i < 4; i++) await step(undefined);
  await sleep(1500);
  const s1 = states.slice(), myAdv = () => logs.filter(l => /^\[advice\].*\(我\)/.test(l)).length, a1 = myAdv();
  ok(locked, "锁池了");
  ok(s1.length > 0 && s1.every(s => s.me === null), `没有绿框时状态里"我"一直为空 (${s1.length} 次状态)`);
  ok(a1 === 0, `没有绿框时不出推荐 (标"(我)"的推荐日志 ${a1} 条)`);
  // 2) 出现绿框(右3)
  for (let i = 0; i < 5; i++) await step(["R", 2]);
  await sleep(3000);
  const last = states[states.length - 1];
  ok(last && last.me && last.me.side === "R" && last.me.idx === 2 && last.meSource === "auto", `出现绿框后自动认出右3 (最后状态 me=${last && JSON.stringify(last.me)} ${last && last.meSource})`);
  ok(logs.some(l => /\[me\] 认出本人座位 R3/.test(l)), "日志里有 [me] 认出本人座位 R3");
  ok(myAdv() > a1, `认出之后开始给我出推荐 (标"(我)"的推荐日志 ${myAdv() - a1} 条;引擎线程设为 0, 只看有没有开算)`);
  // 3) 托盘手动指定左2
  for (let i = 0; i < 2; i++) await step(["R", 2], "L2", 2);
  await sleep(1500);
  const man = states[states.length - 1];
  ok(man && man.me && man.me.side === "L" && man.me.idx === 1 && man.meSource === "manual", `手动指定左2 生效 (me=${man && JSON.stringify(man.me)} ${man && man.meSource})`);
  ok(logs.some(l => /\[me\] 手动指定本人座位 L2/.test(l)), "日志里有 [me] 手动指定本人座位 L2");
  // 4) 改回自动
  for (let i = 0; i < 2; i++) await step(["R", 2], "auto", 2);
  await sleep(1500);
  const back = states[states.length - 1];
  ok(back && back.me && back.me.side === "R" && back.me.idx === 2 && back.meSource === "auto", `改回自动 → 右3 (me=${back && JSON.stringify(back.me)} ${back && back.meSource})`);
  // 5) 手动指定之后换了一局 → 手动作废(座位每局都变), 通知主进程把菜单改回"自动", 新局不再按手动座位
  for (let i = 0; i < 2; i++) await step(["R", 2], "L2", 2);
  await sleep(1000);
  let resets = 0, resetAt = -1; w.on("message", m => { if (m.type === "meManualReset") { resets++; if (resetAt < 0) resetAt = states.length; } });
  const H2 = S.pickHeroes(12, 13);
  const send2 = (cur, me, meSeat) => { const img = S.render({ heroes: H2, cur: ["L", cur], me, taken: new Set(), takenHeroes: new Set(), panels: {} });
    const buf = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.length);
    w.postMessage({ type: "frame", w: img.w, h: img.h, buf, full: true, cursor: null, meSeat }, [buf]); };
  for (let i = 0; i < 16; i++) { send2(i % 3, ["L", 3], "L2"); await sleep(350); }   // 主进程还没收到通知时, 仍按老的手动值发
  await sleep(1500);
  /* 只看 worker 判定"换了一局"之后的状态:它要连续几帧看到棋盘全亮才换局, 那几帧还是旧局(手动座位照旧有效) */
  const after = resetAt >= 0 ? states.slice(resetAt) : [];
  ok(logs.some(l => /\[me\] 换了一局, 手动指定的本人座位 L2 作废/.test(l)), "换了一局:日志里有 [me] 手动指定作废");
  ok(resets >= 1, `换了一局:通知主进程把菜单改回自动 (${resets} 次)`);
  ok(after.length > 0 && after.every(s => s.meSource !== "manual"), `新局的状态不再是手动座位 (${after.length} 次状态, 最后 me=${after.length ? JSON.stringify(after[after.length - 1].me) : "-"})`);
  await w.terminate();
  if (fail) { console.log("\n最近日志:"); logs.slice(-25).forEach(l => console.log("   " + l)); }
  console.log(fail ? `\n失败 ${fail} 项` : "\n全部通过");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
