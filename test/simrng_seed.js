"use strict";
/* v1.39 回归: 插件量级的种子(seedFor 给的 ~1e8, 筛选再 ×31)下, 一批推演局必须各有各的随机数流。
   v1.38 旧写法浮点相乘超过 2^53, 局号被舍入 → 160 局平均只有 5.8 串(旧版必失败)。 */
const C = require("../combo_local.js");
let bad = 0;
const seeds = [6, 123456800, 287654332, 401234578, 536870909 + 11, (536870909 + 8) * 31];
for (const seed of seeds) {
  const firsts = new Set();
  for (let b = 0; b < 1024; b++) firsts.add(C.simRng(seed, b)());
  const ok = firsts.size === 1024;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} 种子 ${seed}: 1024 局里不同随机数流 ${firsts.size}`);
}
/* 同一 (seed, 局号) 必须可复现(单线程/多线程逐位相同靠这个) */
const a = C.simRng(287654332, 17), b = C.simRng(287654332, 17);
for (let i = 0; i < 5; i++) if (a() !== b()) { bad++; console.log("FAIL 同一种子同一局号结果不同"); break; }
if (bad) { console.log(`失败 ${bad} 项`); process.exit(1); }
console.log("全部通过");
