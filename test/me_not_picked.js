"use strict";
/* v1.38 回归: 轮到我(高亮在我), 但已选手数被一个没配上面板的暗格多算了 1 手 → 旧版触发"高亮慢一拍"规则, 当成我已选完,
   改去预估我下一轮, 组合版整个回合不启动(09-22 21:26 真机: L4 弹无虚发, 日志"预估 L4(我) 的下一手, 前面还有 6 手(当前 L4 在选)")。
   合成(我=左2, 顺序 L1 R1 L2 …): 左1、右1 各选一件(面板配上), 另有一格棋盘上暗着但哪个面板都没多出图标; 高亮在左2(我)。
   通过条件: 我落子后写出"我的回合小结"; 出现"L2 在选/下一位 (我)", 且没有"预估 L2(我) … (当前 L2 在选)"。 */
const { Worker } = require("worker_threads"); const S = require("./synth.js");
const w = new Worker(require("path").join(__dirname, "..", "worker.js")); const H = S.pickHeroes(12, 5), K = h => S.HERO[h];
const a = K(H[0]).basics[0], b = K(H[1]).basics[0], c = K(H[2]).basics[0];
const f0 = () => S.render({ heroes: H, cur: ["L", 0], me: ["L", 1] });
const f1 = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 1], taken: new Set([a]), panels: { L0: { skills: [a] } } });
const f2 = () => S.render({ heroes: H, cur: ["L", 1], me: ["L", 1], taken: new Set([a, b, c]), panels: { L0: { skills: [a] }, R0: { skills: [b] } } });
const d = K(H[3]).basics[0];
const f3 = () => S.render({ heroes: H, cur: ["R", 1], me: ["L", 1], taken: new Set([a, b, c, d]), panels: { L0: { skills: [a] }, R0: { skills: [b] }, L1: { skills: [d] } } });
const steps = [["帧0 左1在选", f0], ["帧0", f0], ["帧1 右1在选", f1], ["帧1", f1], ...Array(10).fill(["帧2 高亮在我(左2), 多一格没配上的暗格", f2]), ...Array(3).fill(["帧3 我落子, 右2在选", f3])];
let i = 0, inF2 = false; const seen = [], wrong = [];
let summary = ""; const done = () => { const ok = seen.some(s => /^L2 (在选|下一位)/.test(s)) && /我的回合小结/.test(summary); console.log(`回合小结: ${summary || "(没有)"}`);
  console.log(`\n帧2 后推荐: ${seen.join(" / ")}\n误当成我已选完: ${wrong.length} 次  给我(L2)算这一手: ${ok} → ${!wrong.length && ok ? "通过" : "失败"}`); process.exit(!wrong.length && ok ? 0 : 1); };
const send = () => { if (i >= steps.length) return setTimeout(done, 45000); const [n, mk] = steps[i++]; if (n.startsWith("帧2") || n.startsWith("帧3")) inF2 = true; console.log(`=== ${i}. ${n}`); const img = mk(); const buf = img.data.buffer.slice(0);
  w.postMessage({ type: "frame", w: img.w, h: img.h, buf, bgra: false, full: true, all: true, aimode: "mcts" }, [buf]); };
w.on("message", m => { if (m.type === "ready") { w.postMessage({ type: "display", w: 2560, h: 1440 }); return send(); }
  if (m.type === "log" && /advice|state|track|turn|error/.test(m.tag)) console.log(`  [${m.tag}] ${m.msg.slice(0, 150)}`);
  if (m.type === "log" && m.tag === "turn") summary = m.msg;
  if (m.type === "log" && m.tag === "advice" && inF2) { const x = m.msg.match(/^([LR]\d) (在选|下一位|预估) /) || m.msg.match(/^([LR]\d)\(我\) (正在选) /); if (x) seen.push(`${x[1]} ${x[2] === "正在选" ? "在选" : x[2]}`);
    if (/^预估 L2\(我\) 的下一手, 前面还有 \d+ 手\(当前 L2 在选\)/.test(m.msg)) wrong.push(m.msg); }
  if (m.type === "state") setTimeout(send, m.idle ? 50 : 3000); });
