"use strict";
/* v1.35 回归:团队模式下, 顺序里下一个我方座位在识别里已经选满(5 件)→ 旧版 buildState 跳过他后真正算的是对面下一位(还标成"队友")。
   合成: 我 L1, 团队模式, R1 在选;L2 面板已有英雄 + 3 小技能 + 大招(选满)。顺序 L1 R1 L2 R2 L3 …
   通过条件: 所有推荐日志的目标都是 L 座位, 且出现给 L3 的推荐。 */
const { Worker } = require("worker_threads"); const S = require("./synth.js");
const w = new Worker(require("path").join(__dirname, "..", "worker.js")); const H = S.pickHeroes(12, 3), K = h => S.HERO[h];
const a = K(H[0]), l1 = K(H[1]).basics[0];
const taken = new Set([l1, ...a.basics, a.ult]), P = { L0: { skills: [l1] }, L1: { skills: [...a.basics, a.ult] } };
const f0 = () => S.render({ heroes: H, cur: ["L", 0], me: ["L", 0] });
const f1 = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 0], taken, takenHeroes: new Set([H[5]]), panels: P, names: { L1: H[5] } });
const steps = [["开局", f0], ["开局", f0], ["L2 已选满, R1 在选", f1], ...Array(9).fill(["同上", f1])];
let i = 0; const seen = [];
const done = () => { const bad = seen.filter(s => s[0] === "R"), okL3 = seen.includes("L3");
  console.log(`\n推荐目标: ${seen.join(" ")}\n给对面算: ${bad.length} 次  给 L3 算: ${okL3} → ${!bad.length && okL3 ? "通过" : "失败"}`); process.exit(!bad.length && okL3 ? 0 : 1); };
const send = () => { if (i >= steps.length) return setTimeout(done, 20000); const [n, mk] = steps[i++]; console.log(`=== ${i}. ${n}`); const img = mk(); const buf = img.data.buffer.slice(0);
  w.postMessage({ type: "frame", w: img.w, h: img.h, buf, bgra: false, full: true, all: true, aimode: "mcts" }, [buf]); };
w.on("message", m => { if (m.type === "ready") { w.postMessage({ type: "display", w: 2560, h: 1440 }); return send(); }
  if (m.type === "log" && /advice|track|state/.test(m.tag)) console.log(`  [${m.tag}] ${m.msg.slice(0, 170)}`);
  if (m.type === "log" && m.tag === "advice") { const x = m.msg.match(/^([LR]\d) (在选|下一位|预估) /); if (x) seen.push(x[1]); }
  if (m.type === "state") setTimeout(send, m.idle ? 50 : 3000); });
