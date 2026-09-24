"use strict";
/* v1.35 回归:高亮慢一拍 —— 识别第一次看到高亮移到左2 时, 左2 这一手已经算进已选手数(他已经选完了)。
   旧版把他当"还在选", 接着给他算下一手(09-18 日志: 左2 刚选完又被推荐大招, 其实该算左1/左3)。
   合成(团队模式, 我=左1, 顺序 L1 R1 L2 R2 L3…): 帧0 左1在选 → 帧1 右1在选(左1已选) → 帧2 高亮在左2, 但左1/右1/左2 三手都已选。
   通过条件: 帧2 之后的推荐目标是 L3, 没有 "L2 在选"。 */
const { Worker } = require("worker_threads"); const S = require("./synth.js");
const w = new Worker(require("path").join(__dirname, "..", "worker.js")); const H = S.pickHeroes(12, 3), K = h => S.HERO[h];
const a = K(H[0]).basics[0], b = K(H[1]).basics[0], c = K(H[2]).basics[0];
const f0 = () => S.render({ heroes: H, cur: ["L", 0], me: ["L", 0] });
const f1 = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 0], taken: new Set([a]), panels: { L0: { skills: [a] } } });
const f2 = () => S.render({ heroes: H, cur: ["L", 1], me: ["L", 0], taken: new Set([a, b, c]), panels: { L0: { skills: [a] }, R0: { skills: [b] }, L1: { skills: [c] } } });
const half = img => { const W = img.w >> 1, Hh = img.h >> 1, o = { w: W, h: Hh, data: new Uint8Array(W * Hh * 4) };
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) { const p = ((2 * j) * img.w + 2 * i) * 4, q = (j * W + i) * 4; o.data[q] = img.data[p]; o.data[q + 1] = img.data[p + 1]; o.data[q + 2] = img.data[p + 2]; o.data[q + 3] = 255; } return o; };
/* 快扫帧(半分辨率)里右1、左2 相继落子, 高亮在截图里还停在右1;下一张完整识别才看到高亮在左2 —— 这时左2 这一手已经算进已选手数 */
const g1 = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 0], taken: new Set([a, b]), panels: { L0: { skills: [a] }, R0: { skills: [b] } } });
const g2 = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 0], taken: new Set([a, b, c]), panels: { L0: { skills: [a] }, R0: { skills: [b] }, L1: { skills: [c] } } });
const steps = [["帧0 左1在选", f0], ["帧0", f0], ["帧1 右1在选", f1], ["帧1", f1], ["帧1", f1], ["快扫", () => half(f1())], ["快扫", () => half(f1())],
  ["快扫: 右1 落子", () => half(g1())], ["快扫", () => half(g1())], ["快扫: 左2 落子(高亮还在右1)", () => half(g2())], ["快扫", () => half(g2())],
  ["帧2 完整识别: 高亮在左2 但他已选完", f2], ...Array(5).fill(["帧2", f2])];
let i = 0, inF2 = false; const seen = [];
const done = () => { const bad = seen.filter(s => s === "L2 在选" || s === "L2 下一位"), ok = seen.some(s => s.startsWith("L3"));
  console.log(`\n帧2 后推荐: ${seen.join(" / ")}\n给已选完的左2 算: ${bad.length} 次  给 L3 算: ${ok} → ${!bad.length && ok ? "通过" : "失败"}`); process.exit(!bad.length && ok ? 0 : 1); };
const send = () => { if (i >= steps.length) return setTimeout(done, 15000); const [n, mk] = steps[i++]; if (n.startsWith("帧2")) inF2 = true; console.log(`=== ${i}. ${n}`); const img = mk(); const buf = img.data.buffer.slice(0);
  w.postMessage({ type: "frame", w: img.w, h: img.h, buf, bgra: false, full: img.w >= 2000, all: true, aimode: "mcts" }, [buf]); };
w.on("message", m => { if (m.type === "ready") { w.postMessage({ type: "display", w: 2560, h: 1440 }); return send(); }
  if (m.type === "log" && /advice|state/.test(m.tag)) console.log(`  [${m.tag}] ${m.msg.slice(0, 150)}`);
  if (m.type === "log" && m.tag === "advice" && inF2) { const x = m.msg.match(/^([LR]\d) (在选|下一位|预估) /) || m.msg.match(/^预估 ([LR]\d)/); if (x) seen.push(x[2] ? `${x[1]} ${x[2]}` : `${x[1]} 预估`); }
  if (m.type === "log" && /fast/.test(m.tag)) console.log(`  [fast] ${m.msg.slice(0, 150)}`);
  if (m.type === "state") setTimeout(send, m.idle ? 50 : (m.skipped ? 200 : 3000)); });
