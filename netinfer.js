"use strict";
/* 自博弈训练出的选技网络(v1.28「网络档」)的纯 JS 推理 —— 不依赖任何原生库, CPU 单线程一次约百毫秒。
   结构 = research 端 net.py: 60 件东西各一个 token + 1 个局面 token, 4 层 Transformer(d=192, 4 头, 先归一化, GELU)。
   输入(全部是"行动方视角"):
     ids[60]    每件东西的打分模型下标(12 英雄 + 36 普通 + 12 大招 的顺序;缺的填 N=640)
     code[60]   0 没人拿; 1..5 我方(1=自己, 其余按座位相对偏移); 6..10 敌方(按座位相对偏移)
     dl[60]     这件放进行动方座位的一步 Δlogit(行动方视角, 不合法填 0)
     legal[60]  能不能拿
     t          顺序表第几手(0..49);  seat 行动座位(0..9);  slot[3] 行动座位已有 英雄/普通/大招 数
   输出 {logits[60](不合法 = -Infinity), v(行动方视角终局 logit 估计, 精度有限, 只作参考)} */
const fs = require("fs");
function load(prefix) {
  const meta = JSON.parse(fs.readFileSync(prefix + ".json", "utf8"));
  const b = fs.readFileSync(prefix + ".bin"); const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const T = {}; for (const [k, [off, shape]] of Object.entries(meta.tensors)) T[k] = { a: all.subarray(off / 4, off / 4 + shape.reduce((x, y) => x * y, 1)), shape };
  return { T, d: meta.d, L: meta.L, H: meta.H };
}
/* erf: Abramowitz–Stegun 7.1.26 精度 1.5e-7, GELU 足够 */
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
const gelu = x => 0.5 * x * (1 + erf(x / Math.SQRT2));
function linear(W, bias, x, n, din, dout, out) {           // x [n,din] -> out [n,dout]
  for (let i = 0; i < n; i++) { const xo = i * din, oo = i * dout;
    for (let r = 0; r < dout; r++) { let s = bias ? bias[r] : 0; const wo = r * din; for (let c = 0; c < din; c++) s += W[wo + c] * x[xo + c]; out[oo + r] = s; } }
  return out;
}
function layerNorm(g, b, x, n, d, out) {
  for (let i = 0; i < n; i++) { const o = i * d; let m = 0, v = 0; for (let k = 0; k < d; k++) m += x[o + k]; m /= d;
    for (let k = 0; k < d; k++) { const z = x[o + k] - m; v += z * z; } const inv = 1 / Math.sqrt(v / d + 1e-5);
    for (let k = 0; k < d; k++) out[o + k] = (x[o + k] - m) * inv * g[k] + b[k]; }
  return out;
}
function create(prefix) {
  const N = load(prefix), T = N.T, d = N.d, H = N.H, dh = d / H, L = N.L, S = 61;
  const nfeat = T["feat"].shape[1], KIDX = new Int8Array(60); for (let i = 0; i < 60; i++) KIDX[i] = i < 12 ? 0 : i < 48 ? 1 : 2;
  const h = new Float32Array(S * d), a = new Float32Array(S * d), qkv = new Float32Array(S * 3 * d), att = new Float32Array(S * d),
        ao = new Float32Array(S * d), f1 = new Float32Array(S * 4 * d), f2 = new Float32Array(S * d), sc = new Float32Array(S), tmp = new Float32Array(d);
  function forward(ids, code, dl, legal, t, seat, slot) {
    const E = (name, i) => T[name].a.subarray(i * d, i * d + d);
    // 局面 token
    linear(T["slot.weight"].a, T["slot.bias"].a, Float32Array.from(slot), 1, 3, d, tmp);
    const st = E("step.weight", t), se = E("seat.weight", seat);
    for (let k = 0; k < d; k++) h[k] = T["cls"].a[k] + st[k] + se[k] + tmp[k];
    // 60 个物件 token
    const featA = T["feat"].a, fw = T["fin.weight"].a, fb = T["fin.bias"].a, dxw = T["dx.weight"].a, dxb = T["dx.bias"].a;
    for (let i = 0; i < 60; i++) {
      const o = (i + 1) * d, id = ids[i], fo = id * nfeat, ie = E("idemb.weight", id), ow = E("own.weight", code[i]), kd = E("kind.weight", KIDX[i]);
      const x0 = dl[i] * 4, x1 = legal[i] ? 1 : 0;
      for (let r = 0; r < d; r++) { let s = fb[r]; const wo = r * nfeat; for (let c = 0; c < nfeat; c++) s += fw[wo + c] * featA[fo + c];
        h[o + r] = s + ie[r] + ow[r] + kd[r] + dxw[r * 2] * x0 + dxw[r * 2 + 1] * x1 + dxb[r]; }
    }
    for (let l = 0; l < L; l++) {
      const p = `tf.layers.${l}.`;
      layerNorm(T[p + "norm1.weight"].a, T[p + "norm1.bias"].a, h, S, d, a);
      linear(T[p + "self_attn.in_proj_weight"].a, T[p + "self_attn.in_proj_bias"].a, a, S, d, 3 * d, qkv);
      att.fill(0); const scale = 1 / Math.sqrt(dh);
      for (let hd = 0; hd < H; hd++) { const b0 = hd * dh;
        for (let i = 0; i < S; i++) { const qo = i * 3 * d + b0; let mx = -Infinity;
          for (let j = 0; j < S; j++) { const ko = j * 3 * d + d + b0; let s = 0; for (let k = 0; k < dh; k++) s += qkv[qo + k] * qkv[ko + k]; s *= scale; sc[j] = s; if (s > mx) mx = s; }
          let Z = 0; for (let j = 0; j < S; j++) { sc[j] = Math.exp(sc[j] - mx); Z += sc[j]; }
          const oo = i * d + b0;
          for (let j = 0; j < S; j++) { const w = sc[j] / Z, vo = j * 3 * d + 2 * d + b0; for (let k = 0; k < dh; k++) att[oo + k] += w * qkv[vo + k]; } } }
      linear(T[p + "self_attn.out_proj.weight"].a, T[p + "self_attn.out_proj.bias"].a, att, S, d, d, ao);
      for (let i = 0; i < S * d; i++) h[i] += ao[i];
      layerNorm(T[p + "norm2.weight"].a, T[p + "norm2.bias"].a, h, S, d, a);
      linear(T[p + "linear1.weight"].a, T[p + "linear1.bias"].a, a, S, d, 4 * d, f1);
      for (let i = 0; i < f1.length; i++) f1[i] = gelu(f1[i]);
      linear(T[p + "linear2.weight"].a, T[p + "linear2.bias"].a, f1, S, 4 * d, d, f2);
      for (let i = 0; i < S * d; i++) h[i] += f2[i];
    }
    layerNorm(T["ln.weight"].a, T["ln.bias"].a, h, S, d, a);
    const logits = new Float64Array(60), pw = T["pi.weight"].a, pb = T["pi.bias"].a[0];
    for (let i = 0; i < 60; i++) { if (!legal[i]) { logits[i] = -Infinity; continue; } let s = pb; const o = (i + 1) * d; for (let k = 0; k < d; k++) s += pw[k] * a[o + k]; logits[i] = s; }
    const v0 = new Float32Array(d); linear(T["v.0.weight"].a, T["v.0.bias"].a, a.subarray(0, d), 1, d, d, v0);
    let v = T["v.2.bias"].a[0]; for (let k = 0; k < d; k++) v += T["v.2.weight"].a[k] * gelu(v0[k]);
    return { logits, v };
  }
  return { forward };
}
module.exports = { create };
