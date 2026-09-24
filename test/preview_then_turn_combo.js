"use strict";
/* v1.34 回归:组合版档位下, "预估"算好之后局面(已拿走的东西)没变就轮到我 → 必须补算组合版, 不能沿用预估的网络档结果。
   复现 09-18 日志: 高亮滞后时上家落子被算成"前面还有 1 手"的预估, 高亮移到我时局面签名相同 → "提前算好的结果直接用", 组合版从不启动。
   合成: 帧A = R1 在选、下一手是我 L2(预估);帧B = 已拿走不变, 高亮直接到 L2(真轮到我)。
   通过条件: 帧B 之后出现"组合版算完", 且最后一条推荐带组合胜率(cw)。 */
const { Worker } = require("worker_threads"); const S = require("./synth.js");
const w = new Worker(require("path").join(__dirname, "..", "worker.js")); const H = S.pickHeroes(12, 3), K = h => S.HERO[h];
const t1 = new Set([K(H[0]).basics[0]]), P = { L0: { skills: [K(H[0]).basics[0]] } };
const fA = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 1], taken: t1, panels: P });
const fB = () => S.render({ heroes: H, cur: ["L", 1], me: ["L", 1], taken: t1, panels: P });
const steps = [["开局", () => S.render({ heroes: H, cur: ["L", 0], me: ["L", 1] })], ["开局", () => S.render({ heroes: H, cur: ["L", 0], me: ["L", 1] })],
  ["A: R1 在选(预估我)", fA], ["A", fA], ["B: 已拿走不变, 轮到我", fB], ["B", fB]];
let i = 0, phaseB = false, comboAfterB = false, lastCw = null, reused = false;
const done = () => { const ok = comboAfterB && lastCw; console.log(`\n组合版在轮到我后启动: ${comboAfterB}  沿用预估: ${reused}  最后推荐带组合胜率: ${!!lastCw}  → ${ok ? "通过" : "失败"}`); process.exit(ok ? 0 : 1); };
const send = () => { if (i >= steps.length) return setTimeout(done, 90000); const [n, mk] = steps[i++]; if (n.startsWith("B")) phaseB = true; console.log(`=== ${i}. ${n}`); const img = mk(); const buf = img.data.buffer.slice(0);
  w.postMessage({ type: "frame", w: img.w, h: img.h, buf, bgra: false, full: true, all: false, aimode: "combo", combo: { K: 2, R: 8, sec: 60 } }, [buf]); };
w.on("message", m => { if (m.type === "ready") { w.postMessage({ type: "display", w: 2560, h: 1440 }); return send(); }
  if (m.type === "log" && m.tag === "turn") console.log(`  [turn] ${m.msg}`);
  if (m.type === "log" && /advice/.test(m.tag)) { console.log(`  [${m.tag}] ${m.msg.slice(0, 160)}`); if (phaseB && /组合版算完|决赛算完/.test(m.msg)) comboAfterB = true; /* v1.38: 有后台筛选表时走"决赛"路径 */ if (phaseB && /提前算好的结果直接用/.test(m.msg)) reused = true; }
  if (m.type === "advice" && m.stage === "done" && phaseB && m.pre !== "preview") lastCw = m.rows[0] && m.rows[0].cw != null;
  if (m.type === "state") setTimeout(send, m.idle ? 50 : 15000); });
