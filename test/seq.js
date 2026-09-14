"use strict";
/* 离线回放:用合成帧走一遍 worker 状态机(主菜单→开局→选人→误按F10→离开→新一局),打印日志。 node test/seq.js */
const { Worker } = require("worker_threads"); const S = require("./synth.js");
const w = new Worker(require("path").join(__dirname, "..", "worker.js"));
const half = img => { const W = img.w >> 1, H = img.h >> 1, o = { w: W, h: H, data: new Uint8Array(W * H * 4) };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const p = ((2 * j) * img.w + 2 * i) * 4, q = (j * W + i) * 4; o.data[q] = img.data[p]; o.data[q + 1] = img.data[p + 1]; o.data[q + 2] = img.data[p + 2]; o.data[q + 3] = 255; } return o; };
const H1 = S.pickHeroes(12, 3), H2 = S.pickHeroes(12, 11); const K = h => S.HERO[h];
const blank = { w: 1280, h: 720, data: new Uint8Array(1280 * 720 * 4).fill(40) };
const t1 = new Set([K(H1[0]).basics[0], K(H1[1]).ult]), th1 = new Set([H1[2]]);
const t2 = new Set([...t1, K(H1[3]).basics[1], K(H1[4]).basics[2]]), th2 = new Set([H1[2], H1[5]]);
const steps = [
  ["主菜单(半分辨率)", () => blank, { all: true }],
  ["主菜单 再一帧", () => blank, { all: true }],
  ["开局 棋盘出现(半分辨率)", () => half(S.render({ heroes: H1, cur: ["L", 0], me: ["R", 2] })), { all: true }],
  ["开局 全分辨率(等画面停住)", () => S.render({ heroes: H1, cur: ["L", 0], me: ["R", 2] }), { all: true }],
  ["开局 全分辨率 → 应锁定", () => S.render({ heroes: H1, cur: ["L", 0], me: ["R", 2] }), { all: true }],
  ["同一画面 → 应跳过", () => S.render({ heroes: H1, cur: ["L", 0], me: ["R", 2] }), { all: true }],
  ["L1 选了英雄+技能, R1 选了大招, 轮到 R3(我)", () => S.render({ heroes: H1, cur: ["R", 2], me: ["R", 2], taken: t1, takenHeroes: th1, panels: { L0: { skills: [K(H1[0]).basics[0]], face: true }, R0: { skills: [null, null, null, K(H1[1]).ult] } } }), { all: true }],
  ["同画面 → 跳过", () => S.render({ heroes: H1, cur: ["R", 2], me: ["R", 2], taken: t1, takenHeroes: th1, panels: { L0: { skills: [K(H1[0]).basics[0]], face: true }, R0: { skills: [null, null, null, K(H1[1]).ult] } } }), { all: true }],
  ["再选 2 件, 轮到 L2, 同时误按 F10", () => S.render({ heroes: H1, cur: ["L", 1], me: ["R", 2], taken: t2, takenHeroes: th2, panels: { L0: { skills: [K(H1[0]).basics[0]], face: true }, R0: { skills: [null, null, null, K(H1[1]).ult] }, R2: { skills: [K(H1[3]).basics[1]], face: true } } }), { all: true, reset: true }],
  ["鼠标悬停提示框盖住 6 格(瞬态) → 不应算已选走", () => S.render({ heroes: H1, cur: ["L", 1], me: ["R", 2], taken: new Set([...t2, ...S.HERO[H1[6]].basics, ...S.HERO[H1[7]].basics]), takenHeroes: th2, panels: { L0: { skills: [K(H1[0]).basics[0]], face: true }, R0: { skills: [null, null, null, K(H1[1]).ult] }, R2: { skills: [K(H1[3]).basics[1]], face: true } } }), { all: true, once: true }],
  ["同画面(重锁后) → 已选走应仍正确", () => S.render({ heroes: H1, cur: ["L", 1], me: ["R", 2], taken: t2, takenHeroes: th2, panels: { L0: { skills: [K(H1[0]).basics[0]], face: true }, R0: { skills: [null, null, null, K(H1[1]).ult] }, R2: { skills: [K(H1[3]).basics[1]], face: true } } }), { all: true }],
  ["离开选技 1", () => S.render({ heroes: H1, cur: ["L", 1], me: ["R", 2], taken: new Set(Object.values(S.HERO).flatMap(h => h.basics.concat([h.ult]))), takenHeroes: new Set(H1) }), { all: true }],
  ["离开选技 2(全黑屏)", () => ({ w: 2560, h: 1440, data: new Uint8Array(2560 * 1440 * 4).fill(10) }), { all: true }],
  ["离开选技 3", () => ({ w: 2560, h: 1440, data: new Uint8Array(2560 * 1440 * 4).fill(10) }), { all: true }],
  ["离开选技 4 → 应 idle", () => ({ w: 2560, h: 1440, data: new Uint8Array(2560 * 1440 * 4).fill(10) }), { all: true }],
  ["新一局 棋盘(半分辨率)", () => half(S.render({ heroes: H2, cur: ["R", 0], me: ["L", 3] })), { all: false }],
  ["新一局 全分辨率(等画面停住)", () => S.render({ heroes: H2, cur: ["R", 0], me: ["L", 3] }), { all: false }],
  ["新一局 全分辨率 → 应锁定新池子", () => S.render({ heroes: H2, cur: ["R", 0], me: ["L", 3] }), { all: false }],
  ["新一局 轮到我 L4", () => S.render({ heroes: H2, cur: ["L", 3], me: ["L", 3], taken: new Set([K(H2[0]).ult]), panels: { R0: { skills: [null, null, null, K(H2[0]).ult] } } }), { all: false }],
];
let i = 0, pending = null, adviceDone = false;
let rep = 0;
function next() { if (i >= steps.length) { setTimeout(() => process.exit(0), 300); return; }
  const [name, mk, o] = steps[i]; if (rep === 0) { console.log(`\n=== ${i + 1}. ${name}`); if (o.reset) w.postMessage({ type: "reset" }); }
  rep++; if (rep >= (o.once ? 1 : 2)) { rep = 0; i++; }   // 每帧发两次(去抖需要连续两次观察)
  const img = mk(); const buf = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.length);
  pending = setTimeout(() => { console.log("  (超时无 state)"); next(); }, 8000);
  w.postMessage({ type: "frame", w: img.w, h: img.h, buf, bgra: false, full: img.w >= 2000, all: o.all }, [buf]); }
let waitAdvice = null;
w.on("message", m => {
  if (m.type === "ready") return next();
  if (m.type === "log") return console.log(`  [${m.tag}] ${m.msg}`);
  if (m.type === "want") return console.log(`  want full=${m.full} phase=${m.phase}`);
  if (m.type === "snapshot") return console.log(`  snapshot ${m.why} ${((m.png ? m.png.length : m.raw.byteLength) / 1e6).toFixed(1)}MB`);   // v1.20 起 worker 发原始像素(raw), PNG 在主进程编码
  if (m.type === "clear") return console.log("  clear");
  if (m.type === "error") return console.log("  ERROR", m.msg);
  if (m.type === "advice") { if (m.stage === "done") console.log(`  advice ${m.side}${m.seat % 5 + 1} base ${(100 * m.base).toFixed(1)} top3 ${m.rows.slice(0, 3).map(r => r.name + " " + (100 * r.p).toFixed(1) + (r.box ? "" : " 无框")).join(" | ")}`); return; }
  if (m.type === "state") { console.log(`  state ${m.phase}${m.idle ? " idle" : ""}${m.skipped ? " skipped" : ""}${m.waiting ? " waiting" : ""}${m.idle ? "" : ` cur=${m.current.side}${m.current.idx + 1} me=${m.me ? m.me.side + (m.me.idx + 1) + (m.meSource === "manual" ? "(手动)" : "") : "未定"} my=${m.my_turn} taken=${m.taken} ${m.ms}ms`}`);
    clearTimeout(pending); setTimeout(next, m.idle ? 50 : 2500); }   // 给引擎 2.5 s 出 advice
});
