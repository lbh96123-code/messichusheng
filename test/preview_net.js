"use strict";
/* "只看我"模式:对面(R1)正在选、下一手是我(L2) → 应先给我预估;R1 落子后应重算(不是预估了) */
const { Worker } = require("worker_threads"); const S = require("./synth.js");
const w = new Worker(require("path").join(__dirname, "..", "worker.js")); const H = S.pickHeroes(12, 3), K = h => S.HERO[h];
const t1 = new Set([K(H[0]).basics[0]]), t2 = new Set([...t1, K(H[1]).ult]);
const f0 = () => S.render({ heroes: H, cur: ["L", 0], me: ["L", 1] });
const f1 = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 1], taken: t1, panels: { L0: { skills: [K(H[0]).basics[0]] } } });
const f2 = () => S.render({ heroes: H, cur: ["R", 0], me: ["L", 1], taken: t2, panels: { L0: { skills: [K(H[0]).basics[0]] }, R0: { skills: [null, null, null, K(H[1]).ult] } } });
const steps = [["开局 L1 在选", f0], ["开局", f0], ["开局", f0], ["L1 选完, 轮到 R1(对面), 下一手是我 L2", f1], ["同上", f1], ["同上", f1], ["R1 落子", f2], ["同上", f2]];
let i = 0; const send = () => { if (i >= steps.length) return setTimeout(() => process.exit(0), 8000); const [n, mk] = steps[i++]; console.log(`=== ${i}. ${n}`); const img = mk(); const buf = img.data.buffer.slice(0);
  w.postMessage({ type: "frame", w: img.w, h: img.h, buf, bgra: false, full: true, all: false, aimode: "net" }, [buf]); };
w.on("message", m => { if (m.type === "ready") { w.postMessage({ type: "display", w: 2560, h: 1440 }); return send(); }
  if (m.type === "log" && /advice/.test(m.tag)) console.log(`  [${m.tag}] ${m.msg}`);
  if (m.type === "advice" && m.stage === "top") console.log(`  >>> 显示 ${m.side}${m.seat % 5 + 1} pre=${m.pre} 我方 ${(100 * m.base).toFixed(1)}%`);
  if (m.type === "state") setTimeout(send, m.idle ? 50 : 6000); });
