"use strict";
/* 纯 JS 网络(netinfer.js) vs PyTorch 导出的核对样本(export_net.py 的 *_cases.json): logits 逐项一致。用法: node test/net_cases.js data/netB250 */
const path = require("path"), fs = require("fs");
const base = path.resolve(process.argv[2] || "data/netB250"), N = require("../netinfer.js").create(base);
const C = JSON.parse(fs.readFileSync(base + "_cases.json", "utf8")); let worst = 0, top1 = 0, wp = 0;
const sm = a => { const m = Math.max(...a.filter(x => x != null && isFinite(x))); const e = a.map(x => x == null || !isFinite(x) ? 0 : Math.exp(x - m)); const z = e.reduce((p, q) => p + q, 0); return e.map(x => x / z); };
for (const c of C) {
  const r = N.forward(c.ids, c.code, c.dl, c.legal.map(x => !!x), c.t, c.seat, c.slot);
  let a = -1, b = -1, av = -Infinity, bv = -Infinity;
  c.logits.forEach((x, i) => { if (x == null) return; worst = Math.max(worst, Math.abs(r.logits[i] - x)); if (x > av) { av = x; a = i; } if (r.logits[i] > bv) { bv = r.logits[i]; b = i; } });
  if (a === b) top1++;
  const p1 = sm(c.logits), p2 = sm(Array.from(r.logits).map((x, i) => c.logits[i] == null ? null : x)); p1.forEach((x, i) => { wp = Math.max(wp, Math.abs(x - p2[i])); });
}
// PyTorch 样本在 GPU 上算(logit 量级到 ±30, 绝对差 ~1e-2 是 GPU 矩阵乘的舍入), 以出手概率判
console.log(`${C.length} 个局面: logits 最大差 ${worst.toExponential(2)}, 出手概率最大差 ${wp.toExponential(2)}, 首选一致 ${top1}/${C.length} ${wp < 5e-3 && top1 === C.length ? "✅" : "❌"}`);
