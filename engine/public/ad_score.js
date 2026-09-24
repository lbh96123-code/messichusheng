/* AD 胜负打分器 —— 纯前端,不需要服务端推理。
 *
 * 输入:seats = 10 个座位,每个座位 5 个 key(1 个 "hero:<id>" + 4 个技能 key,顺序随意)。
 *       前 5 个座位是左方,后 5 个是右方。
 * 输出:logit(反对称,交换左右直接变号)和左方胜率。
 *
 * 模型结构(和训练端 exp_ffm.py 一字不差):
 *   座位内   f = ⟨uA[本体], Σ uH[技能]⟩ + ½(‖Σ uA[技能]‖² − Σ‖uA[技能]‖²)
 *            第一项是"本体×技能",第二项是"技能×技能",用两张不同的向量表 —— 关系分型
 *   跨座位   同队 5 个座位之间的配合,用 rank-1 的 cH/cA
 *   z = Σ_座位 ±( Σw + 座位内 + 跨座位 )
 *
 * 先手截距没有导出:模拟器里没有天辉/夜魇,左右完全对称。
 */
window.ADScore = (function () {
  var M = null, W, uA, uH, cH, cA, K, K2, idx, PLAIN = false;
  var KS, FW = null, KNOT, TH, AV = null, SAX, AMU, ASD, NAX = 0;
  var CL = null, CP = null, NCL = 0;   // 簇对项:每件东西的簇标签 + K(K+1)/2 个系数
  /* 归因层(只改"单件/配合"两栏怎么分账,座位总分逐项恒等) */
  var RG = null, RMU = 0, BREF = 0.234, TP = null;
  /* 玩家意见压缩表(2026-09-08):中×低 / 低×低 顺位格里、玩家有机会凑却不凑的正配合,按 f=残差² 压。
     SQ: key(a*n+b, a<b) → {d: 压掉的分(负数, 直接加进配合项), f: 系数}。负配合分不在表里。这一项改总分。 */
  var SQ = null;
  /* 小样本正配合收缩(2026-09-09):同座位共现 n 少的对,正配合分乘 g=n/(n+60);负的不动。
     GK 是上三角 uint8(g×255),下标 a<b: a*(2n−a−1)/2+(b−a−1)。改总分。 */
  var GK = null;
  /* 条件收缩(2026-09-18):一对配合的证据六成以上来自带某第三件 c 的座位时,座位缺 c 就改用"缺 c 的共现局数"算 g。
     CCM: key(a*n+b, a<b) → {c: 条件件下标, g: g_wo}。只作用于 ic>0 的对。见 tools/build-cond.py。改总分。 */
  var CCM = null;
  var EN = null, TQAX = null, TQMUAX, TQHMU, TQHSD, TQG = null;  // 队伍级配比项

  function b64f32(s) {
    var bin = atob(s), n = bin.length, b = new Uint8Array(n);
    for (var i = 0; i < n; i++) b[i] = bin.charCodeAt(i);
    return new Float32Array(b.buffer);
  }

  function init() {
    if (M) return true;
    if (!window.AD_MODEL) return false;
    M = window.AD_MODEL; K = M.K; K2 = M.K2 || 1; idx = M.index;
    W = b64f32(M.w);
    KS = M.ksplit == null ? K : M.ksplit;   // 前 KS 维配合加分,其余减分
    if (M.e) {                      // 普通 FM / 切半:只有一张嵌入表
      PLAIN = true; uA = uH = b64f32(M.e);
      cH = cA = new Float32Array(M.n * K2);
    } else {                        // 关系分型:本体×技能 和 技能×技能 用不同的表
      uA = b64f32(M.uA); uH = b64f32(M.uH); cH = b64f32(M.cH); cA = b64f32(M.cA);
    }
    /* 队伍构成项:按打钱分总和查 8 段分段线性 */
    if (M.fw) { FW = b64f32(M.fw); KNOT = b64f32(M.knot); TH = b64f32(M.th); }
    /* 跨队克制项:我方每件东西对敌方 NAX 条冻结轴的在意程度 */
    if (M.a) { AV = b64f32(M.a); SAX = b64f32(M.sax); AMU = b64f32(M.axmu);
               ASD = b64f32(M.axsd); NAX = M.nax; }
    /* 簇对项:座位内两两,按各自所属的簇查表。
       切半只能表达"同类扎堆亏"一个方向;实测按类型分 —— 堆治疗/远程核心/控制/物理被动
       是**赚**的(治疗×治疗 +0.054),只有堆力量近战身板才亏(−0.020)。这一项做逐类型修正。 */
    if (M.cp) { CL = M.cl; CP = b64f32(M.cp); NCL = M.ncl; }
    /* 归因数据:rg=每件东西的"泛用配合"强度 r,rmu=全局 μ,tp=紧耦合对的收缩系数 κ 与实测值。
       见 tools/build-attr.py。非 PLAIN 模型(本体/技能分表)不适用,直接不开。 */
    if (M.gk) { var gb = atob(M.gk), gn = gb.length; GK = new Uint8Array(gn); for (var q5 = 0; q5 < gn; q5++) GK[q5] = gb.charCodeAt(q5); }
    if (M.cck && M.ccc && M.ccg) {
      var i32 = function (s0) { var bb = atob(s0), nb = bb.length, ub = new Uint8Array(nb); for (var q6 = 0; q6 < nb; q6++) ub[q6] = bb.charCodeAt(q6); return new Int32Array(ub.buffer); };
      var ck = i32(M.cck), cc = i32(M.ccc), cg = b64f32(M.ccg); CCM = new Map();
      for (var q7 = 0; q7 < ck.length; q7++) CCM.set(ck[q7], { c: cc[q7], g: cg[q7] });
    }
    if (M.sqk && M.sqv) {
      var sb = atob(M.sqk), sn = sb.length, sbuf = new Uint8Array(sn);
      for (var q3 = 0; q3 < sn; q3++) sbuf[q3] = sb.charCodeAt(q3);
      var sk = new Int32Array(sbuf.buffer), sv = b64f32(M.sqv); SQ = new Map();
      for (var q4 = 0; q4 < sk.length; q4++) SQ.set(sk[q4], { d: sv[q4 * 2], f: sv[q4 * 2 + 1] });
    }
    if (M.rg && PLAIN) {
      RG = b64f32(M.rg); RMU = M.rmu || 0; BREF = M.bref || 0.234;
      TP = new Map();
      if (M.tpk && M.tpv) {
        var kb = atob(M.tpk), kn = kb.length, kbuf = new Uint8Array(kn);
        for (var q = 0; q < kn; q++) kbuf[q] = kb.charCodeAt(q);
        var kk2 = new Int32Array(kbuf.buffer), vv2 = b64f32(M.tpv);
        for (var q2 = 0; q2 < kk2.length; q2++)
          TP.set(kk2[q2], { e: vv2[q2 * 2], n: vv2[q2 * 2 + 1] });
      }
    }
    /* 队伍级配比项:座位的 5 件求和后**单位化**(只留定位、不含强度),投到 8 条冻结轴上,
       全队 5 个座位相加,再过一个 36 项二次型。同轴扎堆 7/8 是负系数 ——
       "别在同一条轴上堆人";PC4(近战肉↔远程脆)罚得最狠,PC6(治疗)是唯一不罚的。 */
    if (M.tqg) {
      TQAX = b64f32(M.tqax); TQMUAX = b64f32(M.tqmuax);
      TQHMU = b64f32(M.tqhmu); TQHSD = b64f32(M.tqhsd); TQG = b64f32(M.tqg);
      EN = new Float32Array(M.n * K);                 // 逐件单位化的嵌入(定位方向)
      for (var ii = 0; ii < M.n; ii++) {
        var off = ii * K, nn = 0, kk;
        for (kk = 0; kk < K; kk++) nn += uA[off + kk] * uA[off + kk];
        nn = Math.sqrt(nn); if (nn < 1e-9) nn = 1;
        for (kk = 0; kk < K; kk++) EN[off + kk] = uA[off + kk] / nn;
      }
    }
    return true;
  }

  /* 簇对系数:按 (簇a ≤ 簇b) 在上三角里的下标取值。和训练端 codes=[a*K+b for a in range(K) for b in range(a,K)] 一致 */
  function cpair(i, j) {
    if (!CP || i < 0 || j < 0) return 0;
    var a = CL[i], b = CL[j], t;
    if (a > b) { t = a; a = b; b = t; }
    return CP[a * NCL - a * (a - 1) / 2 + (b - a)];
  }

  /* 两两配合的原始分(和 evaluate 的切半口径一致) */
  function pairRaw(a, b) {
    var s2 = 0, t;
    for (t = 0; t < KS; t++) s2 += uA[a * K + t] * uA[b * K + t];
    for (t = KS; t < K; t++) s2 -= uA[a * K + t] * uA[b * K + t];
    return s2 + cpair(a, b);
  }
  function tpOf(a, b) { return TP ? (TP.get(a < b ? a * M.n + b : b * M.n + a) || null) : null; }
  function sqOf(a, b) { return SQ ? (SQ.get(a < b ? a * M.n + b : b * M.n + a) || null) : null; }
  function gOf(a, b) { if (!GK || a === b || a < 0 || b < 0) return 1; if (a > b) { var t = a; a = b; b = t; }
    return GK[a * (2 * M.n - a - 1) / 2 + (b - a - 1)] / 255; }
  /* 一对的最终配合分 = 真交互(扣泛用) + 压缩 → 正的再乘 g。返回 {v: 最终值, corr: 相对未收缩的差} */
  /* seat(可选):这对所在座位的全部下标;给了才做条件收缩 */
  function pairFinal(a, b, seat) {
    var base = pairRaw(a, b), sq = sqOf(a, b);
    var ic = (RG ? base - RMU - RG[a] - RG[b] : base) + (sq ? sq.d : 0);
    var g = ic > 0 ? gOf(a, b) : 1, cond = null;
    if (ic > 0 && CCM && seat) {
      var t = CCM.get(a < b ? a * M.n + b : b * M.n + a);
      if (t && seat.indexOf(t.c) < 0 && t.g < g) { g = t.g; cond = t.c; }
    }
    return { ic: ic, g: g, cond: cond, corr: (g - 1) * (ic > 0 ? ic : 0) };
  }

  /* 归因:μ+r_a+r_b 这部分跟"搭档是谁"无关(座位里逐项加起来就是每件各自的量),
     算成"单件"比算成"配合"诚实。返回 {shift 总量, per[] 每件分到多少},per 之和恒等于 shift。
     ⚠ 曾经还有一项"紧耦合对乘 κ 收缩",依据的边际残差对高共现的对有系统性低估,已撤。 */
  function attrOf(arr) {
    var m = arr.length, per = new Float64Array(m), shift = 0, i, j;
    if (!RG || m < 2) return { shift: 0, per: per };
    for (i = 0; i < m; i++) { var g = (m - 1) * (RG[arr[i]] + RMU / 2); per[i] += g; shift += g; }
    return { shift: shift, per: per };
  }

  /* 某个 key 在权重表里的下标;认不出来返回 -1(补位技能可能不在表里) */
  var _rev = null;
  function keyOfIdx(p) { if (!_rev) { _rev = []; for (var kk in idx) _rev[idx[kk]] = kk; } return _rev[p] || null; }
  function at(key) { var v = idx[key]; return v === undefined ? -1 : v; }

  /* 单个座位:返回 {w, fseat, sHH, sHA, sAH, sAA} */
  function seatOf(items) {
    var h = -1, ab = [], i, j, k;
    for (i = 0; i < items.length; i++) {
      var p = at(items[i]);
      if (p < 0) continue;
      if (String(items[i]).indexOf('hero:') === 0) { h = p; if (PLAIN) ab.push(p); }
      else ab.push(p);
    }
    var wsum = 0, fseat = 0;
    var aH = new Float64Array(K), SA = new Float64Array(K), sq = 0;
    if (!PLAIN && h >= 0) wsum += W[h];   // 普通 FM 下本体已在 ab 里,别重复加
    for (i = 0; i < ab.length; i++) {
      var o = ab[i] * K; wsum += W[ab[i]];
      for (k = 0; k < K; k++) { aH[k] += uH[o + k]; var v = uA[o + k]; SA[k] += v; sq += v * v; }
    }
    // 关系分型才有"本体 × 技能"这一项;普通 FM 里本体已经算进 ab 了,不能重复计
    if (!PLAIN && h >= 0) { var ho = h * K; for (k = 0; k < K; k++) fseat += uA[ho + k] * aH[k]; }
    /* 切半:前 KS 维加分、后 KS..K 维减分。
       普通 FM 的 e·eᵀ 必定半正定,说不出"同类扎堆反而亏";切半让它可以为负。
       KS===K 时下面这段退化回原来的 ½(‖Σe‖²−Σ‖e‖²)。 */
    var n2 = 0, sq2 = 0;
    for (k = 0; k < KS; k++) n2 += SA[k] * SA[k];
    for (k = KS; k < K; k++) n2 -= SA[k] * SA[k];
    for (i = 0; i < ab.length; i++) {
      var o2 = ab[i] * K;
      for (k = 0; k < KS; k++) { var v2 = uA[o2 + k]; sq2 += v2 * v2; }
      for (k = KS; k < K; k++) { var v3 = uA[o2 + k]; sq2 -= v3 * v3; }
    }
    fseat += .5 * (n2 - sq2);
    if (CP || SQ || GK) {                      // 簇对项 + 压缩项 + 小样本收缩:座位内 C(5,2)=10 对
      var all = ab; if (!PLAIN && h >= 0) { all = ab.slice(); all.push(h); }
      for (i = 0; i < all.length; i++) for (j = i + 1; j < all.length; j++) {
        fseat += cpair(all[i], all[j]);
        var sq0 = sqOf(all[i], all[j]); if (sq0) fseat += sq0.d;
        if (GK && RG) fseat += pairFinal(all[i], all[j], all).corr;
      }
    }
    var sHH = new Float64Array(K2), sHA = new Float64Array(K2),
        sAH = new Float64Array(K2), sAA = new Float64Array(K2);
    if (!PLAIN && h >= 0) for (k = 0; k < K2; k++) { sHH[k] = cH[h*K2+k]; sHA[k] = cA[h*K2+k]; }
    if (!PLAIN) for (i = 0; i < ab.length; i++) {
      var q = ab[i] * K2;
      for (k = 0; k < K2; k++) { sAH[k] += cH[q + k]; sAA[k] += cA[q + k]; }
    }
    var tq = null;
    if (TQG) {
      var all2 = ab; if (!PLAIN && h >= 0) { all2 = ab.slice(); all2.push(h); }
      var u = new Float64Array(K), nu = 0;
      for (i = 0; i < all2.length; i++) { var o3 = all2[i] * K; for (k = 0; k < K; k++) u[k] += EN[o3 + k]; }
      for (k = 0; k < K; k++) nu += u[k] * u[k];
      nu = Math.sqrt(nu);
      tq = new Float64Array(8);
      if (nu > 1e-9) for (var q8 = 0; q8 < 8; q8++) {
        var acc8 = 0, ob = q8 * K;
        for (k = 0; k < K; k++) acc8 += u[k] * TQAX[ob + k];
        tq[q8] = (acc8 / nu - TQMUAX[q8] - TQHMU[q8]) / TQHSD[q8];
      }
    }
    var _all = ab; if (!PLAIN && h >= 0) { _all = ab.slice(); _all.push(h); }
    var _adj = attrOf(_all);
    return { w: wsum, fseat: fseat, wAdj: wsum + _adj.shift, fAdj: fseat - _adj.shift, sHH: sHH, sHA: sHA, sAH: sAH, sAA: sAA, tq: tq };
  }

  var dot = function (a, b) { var s = 0; for (var k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };

  /* seats: 10 × 5 的 key 数组。返回 {logit, prob, seatScore[10], teamScore[2]} */
  function evaluate(seats) {
    if (!init()) return null;
    var S = [], t, k, i;
    for (i = 0; i < 10; i++) S.push(seatOf(seats[i] || []));
    var T = [];                                   // 每队的跨座位累加量
    for (t = 0; t < 2; t++) {
      var THH = new Float64Array(K2), THA = new Float64Array(K2),
          TAH = new Float64Array(K2), TAA = new Float64Array(K2);
      for (i = t * 5; i < t * 5 + 5; i++)
        for (k = 0; k < K2; k++) {
          THH[k] += S[i].sHH[k]; THA[k] += S[i].sHA[k];
          TAH[k] += S[i].sAH[k]; TAA[k] += S[i].sAA[k];
        }
      T.push({ THH: THH, THA: THA, TAH: TAH, TAA: TAA });
    }
    var z = 0, seatScore = [], teamScore = [0, 0];
    for (i = 0; i < 10; i++) {
      t = i < 5 ? 0 : 1;
      var s = S[i], Tt = T[t];
      var cross = .1 * (dot(Tt.THH, Tt.THH) + dot(Tt.TAA, Tt.TAA))
                + .2 * dot(Tt.THA, Tt.TAH)
                - .5 * (dot(s.sHH, s.sHH) + dot(s.sAA, s.sAA))
                - dot(s.sHA, s.sAH);
      var v = s.w + s.fseat + cross;
      seatScore.push({ main: s.w, syn: s.fseat, main2: s.wAdj, syn2: s.fAdj, cross: cross, ctr: 0, total: v });
      teamScore[t] += v;
      z += (t === 0 ? 1 : -1) * v;
    }
    /* ② 队伍构成项:各队打钱分总和 → 8 段分段线性,左减右 */
    var comp = 0, compL = 0, compR = 0, ctrL = 0, ctrR = 0;
    if (FW) {
      var fs = [0, 0];
      for (i = 0; i < 10; i++) {
        var kk = seats[i] || [];
        for (var z2 = 0; z2 < kk.length; z2++) { var pz = at(kk[z2]); if (pz >= 0) fs[i < 5 ? 0 : 1] += FW[pz]; }
      }
      var seg = function (v) {
        var B = KNOT.length - 1, j = 0;
        while (j < B - 1 && v >= KNOT[j + 1]) j++;
        var fr = (v - KNOT[j]) / (KNOT[j + 1] - KNOT[j]);
        fr = fr < 0 ? 0 : fr > 1 ? 1 : fr;
        return TH[j] * (1 - fr) + TH[j + 1] * fr;
      };
      compL = seg(fs[0]); compR = seg(fs[1]);
      comp = compL - compR; z += comp;
      teamScore[0] += compL; teamScore[1] += compR;   // 归到各自那一边,总分才和胜率同源
    }
    /* ③ 跨队克制:⟨Σ我方 a, 敌方轴坐标⟩ − 对称项。写成差的形式,反对称由结构保证 */
    if (AV) {
      var uu = [new Float64Array(NAX), new Float64Array(NAX)];   // 两队的轴坐标
      var aa = [new Float64Array(NAX), new Float64Array(NAX)];   // 两队的克制向量和
      for (i = 0; i < 10; i++) {
        var t2 = i < 5 ? 0 : 1, ks2 = seats[i] || [];
        for (var z3 = 0; z3 < ks2.length; z3++) {
          var pp = at(ks2[z3]); if (pp < 0) continue;
          for (k = 0; k < NAX; k++) { uu[t2][k] += SAX[pp * NAX + k]; aa[t2][k] += AV[pp * NAX + k]; }
        }
      }
      for (t = 0; t < 2; t++) for (k = 0; k < NAX; k++) uu[t][k] = (uu[t][k] - AMU[k]) / ASD[k];
      /* 克制项对每件东西是线性的,所以能精确拆到座位:
         这个座位的克制贡献 = Σ_{件∈座位} ⟨a_件, 敌方轴坐标⟩ */
      for (i = 0; i < 10; i++) {
        var tt = i < 5 ? 0 : 1, kk3 = seats[i] || [], sc3 = 0;
        for (var z4 = 0; z4 < kk3.length; z4++) {
          var p3 = at(kk3[z4]); if (p3 < 0) continue;
          for (k = 0; k < NAX; k++) sc3 += AV[p3 * NAX + k] * uu[1 - tt][k];
        }
        seatScore[i].ctr = sc3;
        seatScore[i].total += sc3;          // 计进座位总分,座位分加起来才等于队伍分
        if (tt === 0) ctrL += sc3; else ctrR += sc3;
      }
      ctr = ctrL - ctrR; z += ctr;
      teamScore[0] += ctrL; teamScore[1] += ctrR;
    }
    /* ⑤ 队伍级配比项:两队各自 5 个座位的 8 轴坐标求和 → 36 项二次型,左减右 */
    var tq = 0, tqL = 0, tqR = 0;
    if (TQG) {
      var TC = [new Float64Array(8), new Float64Array(8)];
      for (i = 0; i < 10; i++) {
        var tqi = S[i].tq; if (!tqi) continue;
        for (k = 0; k < 8; k++) TC[i < 5 ? 0 : 1][k] += tqi[k];
      }
      var c8 = 0;
      for (var a8 = 0; a8 < 8; a8++) for (var b8 = a8; b8 < 8; b8++) {
        tqL += TQG[c8] * TC[0][a8] * TC[0][b8];
        tqR += TQG[c8] * TC[1][a8] * TC[1][b8];
        c8++;
      }
      tq = tqL - tqR; z += tq;
      teamScore[0] += tqL; teamScore[1] += tqR;
    }
    return { logit: z, prob: 1 / (1 + Math.exp(-z)), seats: seatScore, team: teamScore,
             comp: comp, ctr: ctr, compL: compL, compR: compR, ctrL: ctrL, ctrR: ctrR,
             tq: tq, tqL: tqL, tqR: tqR };
  }

  /* 给某个座位挑候选:返回每个候选带来的 Δlogit(对该座位所属方为正=更好)。
     同一个模型顺手就是选技推荐 / AI 对手。 */
  function rank(seats, seatIdx, candidates) {
    if (!init()) return [];
    var sign = seatIdx < 5 ? 1 : -1;
    var base = evaluate(seats);
    if (!base) return [];
    var out = [];
    for (var i = 0; i < candidates.length; i++) {
      var cp = seats.map(function (x) { return x.slice(); });
      cp[seatIdx] = cp[seatIdx].concat([candidates[i]]);
      var r = evaluate(cp);
      out.push({ key: candidates[i], delta: sign * (r.logit - base.logit) });
    }
    out.sort(function (a, b) { return b.delta - a.delta; });
    return out;
  }

  /* 拆解一个座位:5 件东西的单件强度 + C(5,2)=10 对两两配合,逐条列出。
     面板上那个座位总分就是这些数加起来的,点开能自己核对。 */
  function explain(items) {
    if (!init()) return null;
    var ks = [], i, j;
    for (i = 0; i < items.length; i++) if (at(items[i]) >= 0) ks.push(items[i]);
    var main = ks.map(function (k) { return { key: k, w: W[at(k)] }; });
    var pairs = [], seatIdx = ks.map(at);
    for (i = 0; i < ks.length; i++) for (j = i + 1; j < ks.length; j++) {
      var a = at(ks[i]), b = at(ks[j]), s = 0;
      /* 必须和 evaluate 里的切半口径一致:前 KS 维加分、后面减分。
         之前这里是 96 维全加,拆解面板的配合值比座位卡片大了几倍。 */
      for (var t = 0; t < KS; t++) s += uA[a * K + t] * uA[b * K + t];
      for (var t3 = KS; t3 < K; t3++) s -= uA[a * K + t3] * uA[b * K + t3];
      if (!PLAIN && (String(ks[i]).indexOf('hero:') === 0 || String(ks[j]).indexOf('hero:') === 0)) {
        var hh = String(ks[i]).indexOf('hero:') === 0 ? a : b;
        var aa = hh === a ? b : a; s = 0;
        for (var t2 = 0; t2 < K; t2++) s += uA[hh * K + t2] * uH[aa * K + t2];
      }
      var tp = tpOf(a, b), sq = sqOf(a, b);
      var pf = (GK && RG) ? pairFinal(a, b, seatIdx) : null;
      var vv = s + cpair(a, b) + (sq ? sq.d : 0) + (pf ? pf.corr : 0);
      /* v2 = 归因修正后的"真配合":扣掉泛用强度 μ+r_a+r_b。扣掉的不会消失,已折进左边单件栏。 */
      var v2 = RG ? (vv - RMU - RG[a] - RG[b]) : vv;
      pairs.push({ a: ks[i], b: ks[j], v: vv, v2: v2, f: sq ? sq.f : null, raw2: sq ? v2 - sq.d - (pf ? pf.corr : 0) : null,
                   g: (pf && pf.g < 0.999) ? pf.g : null, pre_g: pf ? v2 - pf.corr : null, cond: (pf && pf.cond != null) ? keyOfIdx(pf.cond) : null,
                   emp: tp ? tp.e : null, n: tp ? tp.n : 0,
                   pred: v2 * BREF });          // 模型预示的胜率增量,和 emp 同口径
    }
    pairs.sort(function (x, y) { return y.v2 - x.v2; });
    var idxs = ks.map(at), adj = attrOf(idxs);
    main.forEach(function (mm, t) { mm.w2 = mm.w + adj.per[t]; });
    var ms = main.reduce(function (p, c) { return p + c.w; }, 0);
    var ps = pairs.reduce(function (p, c) { return p + c.v; }, 0);
    var ms2 = main.reduce(function (p, c) { return p + c.w2; }, 0);
    var ps2 = pairs.reduce(function (p, c) { return p + c.v2; }, 0);
    return { main: main, pairs: pairs, mainSum: ms, pairSum: ps,
             mainSum2: ms2, pairSum2: ps2, bref: BREF, total: ms + ps };
  }

  return { evaluate: evaluate, rank: rank, explain: explain, ready: init };
})();
