"use strict";
/* 组合评分只是显示层, 它出错不能拖垮识别和推荐。
   往 worker 里注入一个会出错的评分器, 分两种:
     create —— 启动时加载评分模型就抛错(以前整个 worker 起不来);
     score  —— 每一帧评分时抛错(以前整帧的状态和推荐都发不出去)。
   要求:照常锁池、状态照常发出(评分为空数组)、同一个错误只记一次, 不能每帧刷屏。 */
const { Worker } = require("worker_threads"), path = require("path"), assert = require("assert/strict");
const S = require("./synth.js");
const WORKER = path.join(__dirname, "..", "worker.js");
const round = []; for (let i = 0; i < 5; i++) round.push(i, 5 + i);
const ORDER = []; for (let r = 0; r < 5; r++) ORDER.push(...(r % 2 ? round.slice().reverse() : round));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function run(mode) {
  const code = `const Module = require("module"), orig = Module._load;
Module._load = function (req) {
  if (/player_scores(\\.js)?$/.test(req)) return { createPlayerScorer: () => {
    if (${JSON.stringify(mode)} === "create") throw new Error("注入:评分模型加载失败");
    return () => { throw new Error("注入:评分失败"); }; } };
  return orig.apply(this, arguments); };
require(${JSON.stringify(WORKER)});`;
  const w = new Worker(code, { eval: true, env: { ...process.env, AD_THREADS: "0" } });
  let ready = false, locked = false, workerErr = null, states = 0, injected = 0; const other = [];
  w.on("error", e => { workerErr = e; });
  w.on("message", m => {
    if (m.type === "ready") ready = true;
    if (m.type === "log") {
      if (m.tag === "pool" && /锁定/.test(m.msg)) locked = true;
      if (/注入/.test(m.msg)) injected++; else if (m.tag === "error") other.push(m.msg);
    }
    if (m.type === "error" && !/注入/.test(m.msg)) other.push(m.msg);
    if (m.type === "state" && locked && m.board && !m.idle) { states++; assert.ok(Array.isArray(m.playerScores), `${mode}: 评分出错时 playerScores 应为空数组`); }
  });
  for (let t = 0; !ready && !workerErr && t < 200; t++) await sleep(50);
  assert.ok(ready, `${mode}: worker 没有启动${workerErr ? ": " + workerErr.message : ""}`);
  const H = S.pickHeroes(12, 5), sid = x => (x < 5 ? "L" : "R") + (x % 5);
  const taken = new Set(), panels = {}, basics = H.flatMap(h => S.HERO[h].basics); let bi = 0;
  const send = cur => { const img = S.render({ heroes: H, cur: [cur < 5 ? "L" : "R", cur % 5], me: ["R", 2], taken, takenHeroes: new Set(), panels: JSON.parse(JSON.stringify(panels)) });
    const buf = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.length);
    w.postMessage({ type: "frame", w: img.w, h: img.h, buf, full: true, cursor: null }, [buf]); };
  w.postMessage({ type: "display", w: 2560, h: 1440 });
  for (let i = 0; i < 3; i++) { send(0); await sleep(250); }
  for (let i = 0; i < 12; i++) { const x = ORDER[i], k = basics[bi++]; taken.add(k);
    const pn = panels[sid(x)] = panels[sid(x)] || { skills: [] }; pn.skills.push(k);
    for (let f = 0; f < 2; f++) { send(x); await sleep(200); } }
  for (let i = 0; i < 6; i++) { send(ORDER[12]); await sleep(200); }
  await w.terminate();
  assert.ok(locked, `${mode}: 没有锁池`);
  assert.ok(states >= 5, `${mode}: 锁池后只发出 ${states} 次状态(评分出错把主流程拖垮了)`);
  assert.equal(other.length, 0, `${mode}: 出现了评分之外的错误: ${other[0]}`);
  assert.equal(injected, 1, `${mode}: 评分错误应只记 1 次, 实际 ${injected} 次`);
  console.log(`PASS 评分器${mode === "create" ? "加载失败" : "每帧出错"}: 照常锁池, 锁池后发出 ${states} 次状态, 错误只记 1 次`);
}
const MODES = process.env.GUARD_MODE ? [process.env.GUARD_MODE] : ["create", "score"];   // GUARD_MODE=create|score 只跑一种
(async () => { for (const m of MODES) await run(m); process.exit(0); })().catch(e => { console.error("FAIL", e.message); process.exit(1); });
