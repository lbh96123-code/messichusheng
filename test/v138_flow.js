"use strict";
/* v1.38 回归: GPU版新流程 —— 别人选时后台筛选 → 轮到我决赛 → 显示 → 更新一次 → 我落子后写回合小结。
   合成(我=左2, 顺序 L1 R1 L2 …): 帧0 左1在选(预估我, 发起筛选) → 帧1 左1已选、右1在选(重新筛选) → 帧2 右1已选、轮到我 → 帧3 我已选。
   网络输出换成全 0(AD_COMBO_FAKE, 合法里均匀抽)+ 推演局数缩到最小(AD_COMBO_TIER), 只验证流程/时序, 不验证推荐好坏。
   通过条件: 出现"后台筛选完成"、"决赛算完"、"更新算完", 帧2 之后最后一条推荐带 GPU 胜率, 回合小结里有决赛/更新/显示事件。 */
process.env.AD_COMBO_FAKE = "1"; process.env.AD_COMBO_TIER = "2,3,2"; process.env.AD_COMBO_EP = "cpu";
const { Worker } = require("worker_threads"); const S = require("./synth.js");
const w = new Worker(require("path").join(__dirname, "..", "worker.js")); const H = S.pickHeroes(12, 7), K = h => S.HERO[h];
const a = K(H[0]).basics[0], b = K(H[1]).basics[0], c = K(H[2]).basics[1];
const f0 = () => S.render({ heroes: H, cur: ["L", 0], me: ["L", 1] });
const f1 = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 1], taken: new Set([a]), panels: { L0: { skills: [a] } } });
const f2 = () => S.render({ heroes: H, cur: ["L", 1], me: ["L", 1], taken: new Set([a, b]), panels: { L0: { skills: [a] }, R0: { skills: [b] } } });
const f3 = () => S.render({ heroes: H, cur: ["R", 1], me: ["L", 1], taken: new Set([a, b, c]), panels: { L0: { skills: [a] }, R0: { skills: [b] }, L1: { skills: [c] } } });
const steps = [["帧0 左1在选", f0], ["帧0", f0], ["帧0", f0], ["帧1 右1在选", f1], ["帧1", f1], ["帧1", f1], ["帧2 轮到我", f2], ["帧2", f2], ["帧2", f2], ["帧2", f2], ["帧3 我已选", f3], ["帧3", f3], ["帧3", f3]];
let i = 0, inMine = false; const seen = { screen: 0, final: 0, refine: 0 }; let lastCw = null, summary = "";
const done = () => { const ok = seen.screen > 0 && seen.final > 0 && seen.refine > 0 && lastCw && /GPU决赛算完/.test(summary) && /GPU更新算完/.test(summary) && /显示GPU/.test(summary);
  console.log(`\n后台筛选完成 ${seen.screen} 次  决赛 ${seen.final}  更新 ${seen.refine}  轮到我后推荐带GPU胜率 ${!!lastCw}\n回合小结: ${summary || "(没有)"}\n→ ${ok ? "通过" : "失败"}`); process.exit(ok ? 0 : 1); };
const send = () => { if (i >= steps.length) return setTimeout(done, 20000); const [n, mk] = steps[i++]; if (n.startsWith("帧2")) inMine = true; console.log(`=== ${i}. ${n}`); const img = mk(); const buf = img.data.buffer.slice(0);
  w.postMessage({ type: "frame", w: img.w, h: img.h, buf, bgra: false, full: true, all: false, aimode: "combo", combo: { K: 2, R: 8, sec: 60, refine: true } }, [buf]); };
w.on("message", m => { if (m.type === "ready") { w.postMessage({ type: "display", w: 2560, h: 1440 }); return send(); }
  if (m.type === "log" && /advice|turn|error|engine/.test(m.tag)) console.log(`  [${m.tag}] ${m.msg.slice(0, 200)}`);
  if (m.type === "log" && m.tag === "advice") { if (/^后台筛选完成/.test(m.msg)) seen.screen++; if (/^决赛算完/.test(m.msg)) seen.final++; if (/^更新算完/.test(m.msg)) seen.refine++; }
  if (m.type === "log" && m.tag === "turn") summary = m.msg;
  if (m.type === "advice" && m.stage === "done" && inMine && m.pre !== "preview") lastCw = m.rows[0] && m.rows[0].cw != null;
  if (m.type === "state") setTimeout(send, m.idle ? 50 : 6000); });
