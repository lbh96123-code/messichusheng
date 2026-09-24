"use strict";
/* v1.40 回归: 新网络输入 ext 的插件实现(extFill 快速版)与训练端 azn/env.py Env.extra 逐位一致; 顺带和逐对扫的慢版比速度。
   test/ext_cases.json = GPU 机 dump_ext.py 从训练环境导出的 88 个局面(模型下标 ids / owner / slot / legal / ext)。 */
const fs = require("fs"), path = require("path"), C = require("../combo_local.js");
const buf = fs.readFileSync(path.join(__dirname, "..", "data", "pairP.bin")), PN = Math.round(Math.sqrt(buf.length / 4)), P = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
C._setPair(P, PN);
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "ext_cases.json")));
function slow(sim, own, seat, legal) {   // 逐对扫(09-24 第一版), 作对照
  const CAP3 = [1, 3, 1], pv = (i, j) => { const v = P[sim.items[i].p * PN + sim.items[j].p]; return v > 0 ? v : 0; }, out = new Float32Array(180);
  const pot = (st, i) => { const ki = sim.items[i].kind; let m = 0; for (let j = 0; j < 60; j++) { if (own[j] >= 0 || j === i) continue; const kj = sim.items[j].kind; if (!(sim.slot[st * 3 + kj] + (kj === ki ? 1 : 0) < CAP3[kj])) continue; const v = pv(i, j); if (v > m) m = v; } return m; };
  for (let i = 0; i < 60; i++) { if (!legal[i]) continue; out[i * 3] = pot(seat, i); const ki = sim.items[i].kind; let hv = 0, po = 0;
    for (let o = 0; o < 10; o++) { if ((o < 5) === (seat < 5) || !(sim.slot[o * 3 + ki] < CAP3[ki])) continue; let h = 0; for (let x = 0; x < 60; x++) if (own[x] === o) h += pv(i, x); if (h > hv) hv = h; const p2 = pot(o, i); if (p2 > po) po = p2; }
    out[i * 3 + 1] = hv; out[i * 3 + 2] = po; }
  return out;
}
let mx = 0, mxs = 0, tF = 0, tS = 0; const REP = 50;
for (const c of cases) {
  const sim = { items: c.ids.map((p, i) => ({ p, kind: i < 12 ? 0 : i < 48 ? 1 : 2 })), slot: Int32Array.from(c.slot.flat()) }, own = Int8Array.from(c.owner), b = C.mkBuf(1);
  for (let i = 0; i < 60; i++) b.legal[i] = c.legal[i];
  let q = process.hrtime.bigint(); for (let r = 0; r < REP; r++) C.extFill(sim, own, c.mover, b, 0); tF += Number(process.hrtime.bigint() - q);
  let s; q = process.hrtime.bigint(); for (let r = 0; r < REP; r++) s = slow(sim, own, c.mover, c.legal); tS += Number(process.hrtime.bigint() - q);
  for (let i = 0; i < 60; i++) for (let k = 0; k < 3; k++) { mx = Math.max(mx, Math.abs(b.ext[i * 3 + k] - c.ext[i][k])); mxs = Math.max(mxs, Math.abs(b.ext[i * 3 + k] - s[i * 3 + k])); }
}
const ok = mx < 1e-6 && mxs === 0;
console.log(`${cases.length} 个局面: 快速版 vs 训练端 最大差 ${mx.toExponential(2)}, 快速版 vs 逐对扫 最大差 ${mxs} | 每局面 快速版 ${(tF / cases.length / REP / 1e3).toFixed(1)}µs 逐对扫 ${(tS / cases.length / REP / 1e3).toFixed(1)}µs → ${ok ? "通过" : "失败"}`);
process.exit(ok ? 0 : 1);
