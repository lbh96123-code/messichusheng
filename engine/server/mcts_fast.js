"use strict";
/* 增量精确打分引擎 —— 和 public/ad_score.js 逐位等价,但每个候选只花 ~130 次乘法。
 *
 * 线上模型是 PLAIN 单表(K=96, ksplit=48, K2=1),cH/cA 全零 → 跨座位项恒为 0,
 * 配合全部发生在座位内部。于是往座位 s 加一件 p 的 Δlogit 有闭式:
 *
 *   Δw     = W[p]
 *   Δfseat = Σ_{k<48} SA[k]u[k] − Σ_{k≥48} SA[k]u[k]        ← u² 项精确抵消
 *   Δcpair = Σ_{j∈座位} cpair(p, j)
 *   Δcomp  = seg(本队打钱和 + FW[p]) − seg(本队打钱和)
 *   Δctr   = ⟨a_p, uu[敌]⟩ − ⟨A_敌, sax_p/ASD⟩              (左方;右方对称变号)
 *
 * 全场只维护:每座位 SA(96) + 每队打钱和 + 每队 A(15) + 每队 uu(15)。 */
const fs = require("fs"), path = require("path");

function loadModel(pubDir) {
  const win = {}, atobShim = s => Buffer.from(s, "base64").toString("binary");
  for (const f of ["ad_data.js", "ad_model.js", "ad_score.js"])
    new Function("window", "atob", fs.readFileSync(path.join(pubDir, f), "utf8"))(win, atobShim);
  return win;
}
const b64f32 = s => { const bin = Buffer.from(s, "base64"); return new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length)); };

function buildEngine(win) {
  const M = win.AD_MODEL;
  const G = buildEngineInner(win);
  try {
    const dp = JSON.parse(fs.readFileSync(path.join(__dirname, "hard_deps.json"), "utf8"));
    const HID = Object.fromEntries((win.AD_HEROES || []).map(h => [h.key, "hero:" + h.id]));
    const toP = k => G.at(HID[k] || k);
    const DEPP = {}; let n = 0;
    for (const [a, bs] of Object.entries(dp)) { if (a.startsWith("_")) continue; const pa = toP(a); const pb = bs.map(toP).filter(x => x >= 0); if (pa >= 0 && pb.length) { DEPP[pa] = pb; n++; } }
    G.DEPP = n ? DEPP : null; G.DEPN = n;
  } catch (e) { G.DEPP = null; G.DEPN = 0; console.error("hard_deps.json", e.message); }
  return G;
}
function buildEngineInner(win) {
  const M = win.AD_MODEL;
  if (!M.e) throw new Error("只支持 PLAIN 单表模型");
  const K = M.K, KS = M.ksplit == null ? K : M.ksplit, idx = M.index;
  const W = b64f32(M.w), E = b64f32(M.e);
  const FW = M.fw ? b64f32(M.fw) : null, KNOT = M.knot ? b64f32(M.knot) : null, TH = M.th ? b64f32(M.th) : null;
  const AV = M.a ? b64f32(M.a) : null, SAX = M.a ? b64f32(M.sax) : null,
        AMU = M.a ? b64f32(M.axmu) : null, ASD = M.a ? b64f32(M.axsd) : null, NAX = M.nax || 0;
  const CL = M.cp ? M.cl : null, CP = M.cp ? b64f32(M.cp) : null, NCL = M.ncl || 0;
  /* 选手策略用(09-09):每件东西的平均配合 r_a(归因层 ANOVA 的泛用项)+ 打钱权重均值 */
  const RGV = M.rg ? b64f32(M.rg) : null;
  const MEANFW = FW ? Array.from(FW).reduce((a, b) => a + b, 0) / FW.length : 0;
  /* 玩家意见压缩表(09-08):key(a*n+b, a<b) → 压掉的分(负数),和 public/ad_score.js 的 sqOf 同源 */
  let SQ = null;
  if (M.sqk && M.sqv) { const kb = Buffer.from(M.sqk, "base64"), sk = new Int32Array(kb.buffer.slice(kb.byteOffset, kb.byteOffset + kb.length)), sv = b64f32(M.sqv);
    SQ = new Map(); for (let q = 0; q < sk.length; q++) SQ.set(sk[q], sv[q * 2]); }
  /* 小样本正配合收缩(09-09):启动时预算一张 n×n 修正表 CORR[a*n+b] = (g−1)·max(真交互+压缩, 0),
     热路径一次查表。真交互 = 切半内积 + 簇对 − μ − r_a − r_b,和 public/ad_score.js 的 pairFinal 同源。 */
  let CORR = null, CC = null, CORR2 = null, ISC = null;
  if (M.gk && M.rg) { const gb = Buffer.from(M.gk, "base64"), RG = b64f32(M.rg), RMU = M.rmu || 0, nn = M.n;
    CORR = new Float32Array(nn * nn); const ICP = M.cck ? new Float32Array(nn * nn) : null;
    for (let a = 0; a < nn; a++) for (let b = a + 1; b < nn; b++) {
      let s2 = 0; const oa = a * K, ob = b * K;
      for (let t = 0; t < KS; t++) s2 += E[oa + t] * E[ob + t];
      for (let t = KS; t < K; t++) s2 -= E[oa + t] * E[ob + t];
      let cp0 = 0; if (CP) { let x = CL[a], y2 = CL[b]; if (x > y2) { const tt = x; x = y2; y2 = tt; } cp0 = CP[x * NCL - x * (x - 1) / 2 + (y2 - x)]; }
      const sqv = SQ ? (SQ.get(a * nn + b) || 0) : 0;
      const ic = s2 + cp0 - RMU - RG[a] - RG[b] + sqv;
      if (ic > 0) { const g = gb[a * (2 * nn - a - 1) / 2 + (b - a - 1)] / 255; const c = (g - 1) * ic; CORR[a * nn + b] = c; CORR[b * nn + a] = c; if (ICP) ICP[a * nn + b] = ic; }
    }
    /* 条件收缩(09-18):表 cck/ccc/ccg(见 tools/build-cond.py)。座位缺条件件 c 时,(a,x) 的修正用 CORR2=(g_wo−1)·ic;
       放入 c 时 condBack 把座位里以 c 为条件的对补回 CORR。和 public/ad_score.js pairFinal(a,b,seat) 同源。 */
    if (ICP) { const i32 = s0 => { const bb = Buffer.from(s0, "base64"); return new Int32Array(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.length)); };
      const ck = i32(M.cck), cc = i32(M.ccc), cg = b64f32(M.ccg);
      CC = new Int16Array(nn * nn).fill(-1); CORR2 = new Float32Array(nn * nn); ISC = new Uint8Array(nn);
      for (let q = 0; q < ck.length; q++) { const a = Math.floor(ck[q] / nn), x = ck[q] - a * nn, ic = ICP[a * nn + x];
        if (!(ic > 0)) continue; const g0 = gb[a * (2 * nn - a - 1) / 2 + (x - a - 1)] / 255; if (!(cg[q] < g0)) continue;
        CC[a * nn + x] = CC[x * nn + a] = cc[q]; CORR2[a * nn + x] = CORR2[x * nn + a] = (cg[q] - 1) * ic; ISC[cc[q]] = 1; } }
  }
  /* 队伍级配比项(09-08 上线):座位方向向量 U=Σ单位化嵌入 → 8 轴投影 → 队伍 36 项二次型 */
  let EN = null, TQAX = null, TQMUAX = null, TQHMU = null, TQHSD = null, TQG = null, PA = null;
  if (M.tqg) {
    TQAX = b64f32(M.tqax); TQMUAX = b64f32(M.tqmuax);
    TQHMU = b64f32(M.tqhmu); TQHSD = b64f32(M.tqhsd); TQG = b64f32(M.tqg);
    EN = new Float32Array(M.n * K);
    for (let i = 0; i < M.n; i++) { const o = i * K; let nn = 0;
      for (let k = 0; k < K; k++) nn += E[o + k] * E[o + k];
      nn = Math.sqrt(nn); if (nn < 1e-9) nn = 1;
      for (let k = 0; k < K; k++) EN[o + k] = E[o + k] / nn; }
    PA = new Float64Array(M.n * 8);          // PA[p][q] = ⟨EN_p, 轴q⟩,省掉每候选 8×96
    for (let i = 0; i < M.n; i++) for (let q = 0; q < 8; q++) { let a = 0;
      const o = i * K, ob = q * K;
      for (let k = 0; k < K; k++) a += EN[o + k] * TQAX[ob + k];
      PA[i * 8 + q] = a; }
  }
  const at = k => { const v = idx[k]; return v === undefined ? -1 : v; };
  const cpair = (i, j) => { if (!CP || i < 0 || j < 0) return 0;
    let a = CL[i], b = CL[j]; if (a > b) { const t = a; a = b; b = t; }
    return CP[a * NCL - a * (a - 1) / 2 + (b - a)]; };
  const nn_ = M.n;
  /* si(可选):放入前座位已有的下标;给了才做条件收缩 */
  const sqd = (i, j, si) => { if (i < 0 || j < 0) return 0; let v = 0;
    if (SQ) { const t = SQ.get(i < j ? i * nn_ + j : j * nn_ + i); if (t !== undefined) v += t; }
    if (CORR) { const key = i * nn_ + j; v += (CC && si && CC[key] >= 0 && si.indexOf(CC[key]) < 0) ? CORR2[key] : CORR[key]; } return v; };
  /* 放入 p 时:座位里已有的对 (q,r) 若以 p 为条件,修正从 CORR2 回到 CORR */
  const condBack = (p, si) => { if (!ISC || p < 0 || !ISC[p]) return 0; let v = 0;
    for (let q = 0; q < si.length; q++) for (let r = q + 1; r < si.length; r++) { const key = si[q] * nn_ + si[r]; if (CC[key] === p) v += CORR[key] - CORR2[key]; }
    return v; };
  const seg = v => { const B = KNOT.length - 1; let j = 0;
    while (j < B - 1 && v >= KNOT[j + 1]) j++;
    let fr = (v - KNOT[j]) / (KNOT[j + 1] - KNOT[j]);
    fr = fr < 0 ? 0 : fr > 1 ? 1 : fr;
    return TH[j] * (1 - fr) + TH[j + 1] * fr; };
  /* sax_p/ASD 预先除好,省得每次除 */
  const SAXn = SAX ? new Float32Array(SAX.length) : null;
  if (SAX) for (let p = 0; p < M.n; p++) for (let k = 0; k < NAX; k++) SAXn[p * NAX + k] = SAX[p * NAX + k] / ASD[k];
  return { K, KS, W, E, FW, KNOT, TH, AV, SAXn, AMU, ASD, NAX, CP, cpair, sqd, condBack, seg, at, n: M.n,
           EN, TQAX, TQMUAX, TQHMU, TQHSD, TQG, PA, RG: RGV, MEANFW };
}

/* ---- 模拟状态 ---- */
function makeSim(G, items, order) {
  const NS = 10, K = G.K, NAX = G.NAX;
  const s = {
    G, items, order, step: 0, nItems: items.length,
    taken: new Uint8Array(items.length),
    SA: new Float64Array(NS * K),          // 每座位的 Σe
    seatItems: Array.from({ length: NS }, () => []),   // 权重表下标
    slot: new Int8Array(NS * 3),
    gold: new Float64Array(2),
    A: new Float64Array(2 * NAX),          // 每队 Σa
    uu: new Float64Array(2 * NAX),         // 每队轴坐标(已标准化)
    z: 0,
    U: G.TQG ? new Float64Array(NS * K) : null,     // 每座位 Σ单位化嵌入
    Usq: G.TQG ? new Float64Array(NS) : null,       // ‖U‖²
    ac8: G.TQG ? new Float64Array(NS * 8) : null,   // 每座位 8 轴未归一投影
    tq8: G.TQG ? new Float64Array(NS * 8) : null,   // 每座位归一后的 8 轴坐标
    TC:  G.TQG ? new Float64Array(2 * 8) : null,    // 每队 8 轴坐标之和
  };
  for (let t = 0; t < 2; t++) for (let k = 0; k < NAX; k++) s.uu[t * NAX + k] = -G.AMU[k] / G.ASD[k];
  return s;
}
const CAP = [1, 3, 1];
function cloneSim(s) {
  return { G: s.G, items: s.items, order: s.order, step: s.step, nItems: s.nItems,
    taken: s.taken.slice(), SA: s.SA.slice(), seatItems: s.seatItems.map(x => x.slice()),
    slot: s.slot.slice(), gold: s.gold.slice(), A: s.A.slice(), uu: s.uu.slice(), z: s.z,
    U: s.U && s.U.slice(), Usq: s.Usq && s.Usq.slice(), ac8: s.ac8 && s.ac8.slice(),
    tq8: s.tq8 && s.tq8.slice(), TC: s.TC && s.TC.slice() };
}
const simDone = s => s.step >= s.order.length;
const moverSeat = s => s.order[s.step];
const moverSign = s => (s.order[s.step] < 5 ? 1 : -1);

/* 加一件到座位 seat 之后,队伍级配比项的变化(已折算成 z 的符号);d8 非空时回填座位 8 轴增量 */
const _D8 = new Float64Array(8);
function tqDelta(s, p, seat, d8) {
  const G = s.G; if (!G.TQG || p < 0) return 0;
  const K = G.K, EN = G.EN, o = p * K, ub = seat * K;
  let dot = 0;
  for (let k = 0; k < K; k++) dot += s.U[ub + k] * EN[o + k];
  const nu = Math.sqrt(s.Usq[seat] + 2 * dot + 1);      // 单位化嵌入 → ‖EN_p‖²=1
  const t = seat < 5 ? 0 : 1, sb = seat * 8, pb = p * 8;
  let dtq = 0;
  for (let q = 0; q < 8; q++) {
    const nv = nu > 1e-9 ? ((s.ac8[sb + q] + G.PA[pb + q]) / nu - G.TQMUAX[q] - G.TQHMU[q]) / G.TQHSD[q] : 0;
    _D8[q] = nv - s.tq8[sb + q];
  }
  const tb = t * 8; let c = 0;
  for (let a = 0; a < 8; a++) for (let b = a; b < 8; b++) {
    dtq += G.TQG[c++] * (s.TC[tb + a] * _D8[b] + _D8[a] * s.TC[tb + b] + _D8[a] * _D8[b]);
  }
  if (d8) for (let q = 0; q < 8; q++) d8[q] = _D8[q];
  return t === 0 ? dtq : -dtq;
}

/* 往当前行动座位放候选 i 的 Δlogit(左方为正)。不改状态。 */
function deltaOf(s, i) {
  const G = s.G, p = s.items[i].p;
  const seat = s.order[s.step], t = seat < 5 ? 0 : 1, g = t === 0 ? 1 : -1;
  if (p < 0) return 0;
  const K = G.K, KS = G.KS, E = G.E, o = p * K, base = seat * K;
  let d = G.W[p];
  for (let k = 0; k < KS; k++) d += s.SA[base + k] * E[o + k];
  for (let k = KS; k < K; k++) d -= s.SA[base + k] * E[o + k];
  const si = s.seatItems[seat];
  for (let q = 0; q < si.length; q++) d += G.cpair(p, si[q]) + G.sqd(p, si[q], si);
  d += G.condBack(p, si);
  let z = g * d;
  if (G.FW) z += G.seg(s.gold[t] + G.FW[p]) * (t === 0 ? 1 : -1) - G.seg(s.gold[t]) * (t === 0 ? 1 : -1);
  if (G.AV) { const NAX = G.NAX, ao = p * NAX, ub = (1 - t) * NAX, ab = (1 - t) * NAX;
    let mine = 0, theirs = 0;
    for (let k = 0; k < NAX; k++) { mine += G.AV[ao + k] * s.uu[ub + k]; theirs += s.A[ab + k] * G.SAXn[ao + k]; }
    z += (t === 0 ? (mine - theirs) : (theirs - mine)); }
  if (G.TQG) z += tqDelta(s, p, seat, null);
  return z;
}
/* 把一件东西播种进某座位的全部累加量(不碰 taken/slot/step/z)。
   simFrom 之类"从既有局面重建"的场景用它,免得漏掉 tq 那几个累加量。 */
function seedItem(s, seat, p) {
  const G = s.G; if (p < 0) return;
  const K = G.K, o = p * K, base = seat * K, t = seat < 5 ? 0 : 1;
  for (let k = 0; k < K; k++) s.SA[base + k] += G.E[o + k];
  s.seatItems[seat].push(p);
  if (G.FW) s.gold[t] += G.FW[p];
  if (G.AV) { const NAX = G.NAX, ao = p * NAX;
    for (let k = 0; k < NAX; k++) { s.A[t * NAX + k] += G.AV[ao + k]; s.uu[t * NAX + k] += G.SAXn[ao + k]; } }
  if (G.TQG) {
    const EN = G.EN, ub = seat * K;
    let dot = 0; for (let k = 0; k < K; k++) dot += s.U[ub + k] * EN[o + k];
    for (let k = 0; k < K; k++) s.U[ub + k] += EN[o + k];
    s.Usq[seat] += 2 * dot + 1;
    const nu = Math.sqrt(s.Usq[seat]), sb = seat * 8, pb = p * 8, tb = t * 8;
    for (let q = 0; q < 8; q++) {
      s.ac8[sb + q] += G.PA[pb + q];
      const nv = nu > 1e-9 ? (s.ac8[sb + q] / nu - G.TQMUAX[q] - G.TQHMU[q]) / G.TQHSD[q] : 0;
      s.TC[tb + q] += nv - s.tq8[sb + q]; s.tq8[sb + q] = nv;
    }
  }
}
/* 这一手没有任何合法候选(座位该拿的那一类在池子里已经被拿光了,比如只差英雄但英雄格全没了):
   这手空过 —— 局面不变, 只推进 step。批量推演里必须"空过"而不是 break, 否则同一批的各局步数会错开。 */
function passSim(s) { s.step++; }
function applySim(s, i) {
  const p = s.items[i].p, seat = s.order[s.step];
  s.z += deltaOf(s, i);
  s.taken[i] = 1; s.slot[seat * 3 + s.items[i].kind]++;
  seedItem(s, seat, p);
  s.step++;
}
/* 选手策略修正(09-09,行动方视角)。只进 scoreAll(候选筛选 + 走子抽样),不进 deltaOf/applySim,
 * 所以终局 z(裁判)一个数不变。两处修正:
 *   1. 空座位用裸 W 会高估"高单件 + 负配合"型技能(FM 把晚顺位/情境技能拆成这样;W+3·r_a 与实测
 *      纯加性单件相关 0.986,裸 W 只有 0.826)。补上 剩余空槽数 × r_a,当作将来必来的搭档。
 *   2. 阵容构成 seg(队伍打钱和) 在空队伍(和=0)处于"打钱过头"一侧,开局任何负 FW 辅助技能凭空 +0.07。
 *      改成按满编尺度看:缺的位置先按均值补齐,再比"放它" vs "放一件均值货"。
 *   AI_POLICY_FIX=0 关掉(A/B 用)。 */
let POLICY_FIX = process.env.AI_POLICY_FIX !== "0";
/* 硬依赖(09-16):server/hard_deps.json 列出"没有 enabler 就废"的技能。座位里没有任一 enabler 时,
 * 拿 dependent 扣 DEP_PEN(只进 scoreAll,裁判 z 不变)。AI 会先拿月光再拿月蚀,或者不碰月蚀。AI_DEP_PEN=0 关掉。 */
let DEP_PEN = process.env.AI_DEP_PEN == null ? 0.6 : +process.env.AI_DEP_PEN;
const setDepPen = v => { DEP_PEN = +v || 0; };
function depBlocked(s, i) {
  const G = s.G, p = s.items[i].p; if (!G.DEPP || p < 0) return false;
  const en = G.DEPP[p]; if (!en) return false;
  const si = s.seatItems[s.order[s.step]];
  for (let q = 0; q < si.length; q++) if (en.includes(si[q])) return false;
  return true;
}
const setPolicyFix = on => { POLICY_FIX = !!on; };
function policyBonus(s, i) {
  if (!POLICY_FIX) return 0;
  const G = s.G, p = s.items[i].p; if (p < 0) return 0;
  const seat = s.order[s.step], t = seat < 5 ? 0 : 1;
  let b = 0;
  if (DEP_PEN > 0 && depBlocked(s, i)) b -= DEP_PEN;
  if (G.RG) { const left = 4 - s.seatItems[seat].length; if (left > 0) b += left * G.RG[p]; }
  if (G.FW) {
    let m = 0; for (let q = t * 5; q < t * 5 + 5; q++) m += s.seatItems[q].length;
    const fill = (24 - m) * G.MEANFW, g = s.gold[t];
    b += (G.seg(g + fill + G.FW[p]) - G.seg(g + fill + G.MEANFW)) - (G.seg(g + G.FW[p]) - G.seg(g));
  }
  return b;
}
/* 全部合法候选的 Δ(行动方视角为正),写进复用缓冲。= 精确 Δlogit + 策略修正 */
function scoreAll(s, outIdx, outVal) {
  const seat = s.order[s.step], sg = seat < 5 ? 1 : -1; let n = 0;
  for (let i = 0; i < s.nItems; i++) {
    if (s.taken[i]) continue;
    const k = s.items[i].kind;
    if (s.slot[seat * 3 + k] >= CAP[k]) continue;
    outIdx[n] = i; outVal[n] = sg * deltaOf(s, i) + policyBonus(s, i); n++;
  }
  return n;
}

/* 同一套算式,但把 5 个分量分开写出(全部已折算成 z 的符号)。
   deltaOf 是热路径不动它;这里重复一遍数学,靠 test 钉住两者恒等。
   out = [单件强度, 座位内配合, 簇搭配, 阵容构成, 克制, 队伍配比] */
function deltaParts(s, i, out) {
  const G = s.G, p = s.items[i].p;
  const seat = s.order[s.step], t = seat < 5 ? 0 : 1, g = t === 0 ? 1 : -1;
  out[0] = out[1] = out[2] = out[3] = out[4] = out[5] = 0;
  if (p < 0) return out;
  const K = G.K, KS = G.KS, E = G.E, o = p * K, base = seat * K;
  let syn = 0;
  for (let k = 0; k < KS; k++) syn += s.SA[base + k] * E[o + k];
  for (let k = KS; k < K; k++) syn -= s.SA[base + k] * E[o + k];
  let cp = 0; const si = s.seatItems[seat];
  for (let q = 0; q < si.length; q++) cp += G.cpair(p, si[q]) + G.sqd(p, si[q], si);
  cp += G.condBack(p, si);
  out[0] = g * G.W[p]; out[1] = g * syn; out[2] = g * cp;
  if (G.FW) { const sgn = t === 0 ? 1 : -1; out[3] = sgn * (G.seg(s.gold[t] + G.FW[p]) - G.seg(s.gold[t])); }
  if (G.AV) { const NAX = G.NAX, ao = p * NAX, ub = (1 - t) * NAX;
    let mine = 0, theirs = 0;
    for (let k = 0; k < NAX; k++) { mine += G.AV[ao + k] * s.uu[ub + k]; theirs += s.A[ub + k] * G.SAXn[ao + k]; }
    out[4] = t === 0 ? (mine - theirs) : (theirs - mine); }
  if (G.TQG) out[5] = tqDelta(s, p, seat, null);
  return out;
}
/* 按性格权重给全部合法候选打分(行动方视角为正)。裁判不走这条路。 */
const _PT = new Float64Array(6);
function scoreAllBy(s, wts, outIdx, outVal) {
  const seat = s.order[s.step], sg = seat < 5 ? 1 : -1; let n = 0;
  for (let i = 0; i < s.nItems; i++) {
    if (s.taken[i]) continue;
    const k = s.items[i].kind;
    if (s.slot[seat * 3 + k] >= CAP[k]) continue;
    deltaParts(s, i, _PT);
    outIdx[n] = i;
    outVal[n] = sg * (wts[0]*_PT[0] + wts[1]*_PT[1] + wts[2]*_PT[2] + wts[3]*_PT[3] + wts[4]*_PT[4] + (wts[5] === undefined ? _PT[5] : wts[5]*_PT[5]));
    n++;
  }
  return n;
}

module.exports = { loadModel, deltaParts, scoreAllBy, seedItem, buildEngine, makeSim, cloneSim, simDone, moverSeat, moverSign,
                   deltaOf, applySim, passSim, scoreAll, policyBonus, setPolicyFix, setDepPen, depBlocked, CAP };
