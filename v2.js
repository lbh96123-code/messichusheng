"use strict";
/* ================= 2.0 状态估计 =================
   1.x 每帧问"这格被拿走了吗 / 这槽有图标吗", 下硬判断, 再用计数器去抖。硬判断 → 判错要撤回 →
   撤回会误触发 → 加防护 → 防护挡住正当撤回。归属层因此堆到 9 步。

   2.0 换问题形式, 拆成两个各自干净的估计问题:

   问题 A —— 每件东西**什么时候**被拿走。
     "被拿走"是单调阶跃函数(拿走了不会回来), 要估的只有一个跳变点 → 变点检测。
     每格一个累加器: ℓ_t = log P(这一帧的样子 | 已拿走) − log P(… | 没拿走), 逐帧累加。
     浮窗/鼠标/翻牌动画只让那几帧的 ℓ 接近 0, 被序列里其它帧压过去 ——
     **不需要三态、去抖计数、闪烁标记、12 帧锁定、撤回逻辑**, 它们都是在用局部规则模拟"这一帧证据不够强"。

   问题 B —— 每件东西**归谁**。
     约束是每个座位恰好 1 英雄 + 4 技能。面板证据累成费用矩阵, 解一次带容量的指派(最小费用流)。
     用的是**集合**不是槽位, 所以玩家拖动图标天然无影响。

   关键性质:**从不硬提交**。证据只累加, 每次查询拿当前全部证据重解。
   第 20 秒的面板证据可以直接改掉第 3 秒的结论 —— 不需要撤回, 因为从来没提交过。 */

/* ---------- 似然:参数与出处 ----------
   中心值由真机截图标出(见 docs/design-2.0.md 的标定一节):用"面板里出现了这件技能"当独立标签源
   (与棋盘像素无关), 中位数/MAD 稳健估计, 抗住了标签源自身的漏标。
     亮度比 r  = 本帧均值 / 锁池时均值      正例 0.129 (MAD .033) | 负例 0.988 (MAD .043)
     最亮比 mr = 本帧最亮一格 / 锁池时均值  正例 0.217 (MAD .072) | 负例 1.325 (MAD .234)
     饱和比 ds = 本帧饱和度 / 锁池时饱和度  正例 0.319 (MAD .210) | 负例 1.005 (MAD .020)
   尺度**不**用 MAD:MAD 量的是干净变化, 而我们要的是"这个特征在没人落子的情况下还能动多远"。
   这一项静态截图里没有样本(遮挡/悬停/反光只存在于连续帧里), 所以取 1.x 代码里记录下来的真机实测:
     半透明说明浮窗底下 r 只掉到 0.62~0.9、颜色还在   → 亮着的那一类, r 的尺度要盖住 0.38
     被选走的格子实测 r = 0.08~0.28、ds = 0.05~0.5   → 拿走的那一类, 尺度 ~0.15
   用柯西核而不是高斯:尾巴重 = 任何一帧的荒谬观测都只值有限的分数, 不会一帧定生死。 */
const LK = {
  r:  { t: 0.129, st: 0.15, n: 0.988, sn: 0.38 },
  mr: { t: 0.217, st: 0.22, n: 1.325, sn: 0.55 },
  ds: { t: 0.319, st: 0.30, n: 1.005, sn: 0.45 },
};
/* 一帧最多值多少分。这是 2.0 唯一的"去抖"参数 —— 它替掉了 1.x 的 need=2/5/6/12 四个计数门槛。
   3.0 意味着两帧一致证据就到 log-odds 6(p>0.997), 一帧荒谬观测最多把结论推回一帧的量。 */
const LMAX = +(process.env.V2_LMAX || 3.0);
/* 变点先验写成**风险率**(每一帧这一件被选走的概率), 而不是"每帧一个等权候选点"。
   这条很要紧:等权写法下, 就算每帧都毫无信息(ℓ=0), 候选点个数也随帧数线性增长 ——
   等得够久, 任何一格都会被判成"已经被拿走"。实测就是这么翻的车:被浮窗压暗 3 帧、每帧证据只有 0.1,
   后验照样冲到 0.89。风险率写法下同样的三帧只到 0.017。
   h 的量级:一局约 50 手 / 72 件 / 一两百帧完整识别 → 每件每帧约 0.003~0.005。 */
const HAZ = +(process.env.V2_HAZ || 0.005);
const HOVER_W = +(process.env.V2_HOVER || 0.15);
/* "这一帧整体变暗了多少"的下限与最小样本数(见 observe 里的说明):
   下限有出处 —— 真机实测半透明说明框底下亮度只掉到 0.62~0.9, 所以整体变暗最多解释到 0.6。 */
const GFLOOR = +(process.env.V2_GFLOOR || 0.6), GMIN_N = +(process.env.V2_GMIN || 8);   // 鼠标压着的那一格:两种假设都能解释它的样子, 证据打折(条件化, 不是特例补丁)
const cau = (x, m, s) => -Math.log1p(((x - m) / s) ** 2);
function llr(f) {                                   // f = {r, mr, ds}
  let z = 0;
  for (const k of ["r", "mr", "ds"]) { const p = LK[k]; z += cau(f[k], p.t, p.st) - cau(f[k], p.n, p.sn); }
  return Math.max(-LMAX, Math.min(LMAX, z));
}

/* ---------- 带容量的指派(最小费用流) ----------
   源 →(容量 cap[s]) 座位 →(1) 件 →(1) 汇, 求最大总证据。规模 72 件 × 10 座位, 一次几十微秒。
   写成 SPFA 增广的最小费用最大流:节点 = 1 源 + 10 座位 + n 件 + 1 汇。 */
function assign(W, caps, n, nSeat) {
  const N = 2 + nSeat + n, S = 0, T = N - 1, seat0 = 1, item0 = 1 + nSeat;
  const to = [], nx = [], cap = [], cost = [], head = new Array(N).fill(-1);
  const add = (u, v, c, w) => { to.push(v); cap.push(c); cost.push(w); nx.push(head[u]); head[u] = to.length - 1;
    to.push(u); cap.push(0); cost.push(-w); nx.push(head[v]); head[v] = to.length - 1; };
  for (let s = 0; s < nSeat; s++) add(S, seat0 + s, caps[s], 0);
  for (let i = 0; i < n; i++) add(item0 + i, T, 1, 0);
  for (let s = 0; s < nSeat; s++) for (let i = 0; i < n; i++) { const w = W[i][s]; if (w > -1e8) add(seat0 + s, item0 + i, 1, -w); }
  let flow = 0, tot = 0;
  const dist = new Float64Array(N), inq = new Uint8Array(N), pre = new Int32Array(N);
  for (;;) {
    dist.fill(Infinity); dist[S] = 0; pre.fill(-1); inq.fill(0);
    const q = [S]; inq[S] = 1;
    while (q.length) { const u = q.shift(); inq[u] = 0;
      for (let e = head[u]; e >= 0; e = nx[e]) { if (cap[e] <= 0) continue; const v = to[e];
        if (dist[u] + cost[e] < dist[v] - 1e-12) { dist[v] = dist[u] + cost[e]; pre[v] = e; if (!inq[v]) { inq[v] = 1; q.push(v); } } } }
    /* 只有"再增广会变差"才停。**不能**把"收益恰好为 0"也当成停 ——
       一件完全没有面板证据的东西整行都是 0, 那一步的收益就是 0, 于是它永远留在原地不被分配。
       09-12 真机 x844 那局就是这么丢的:右1 连英雄都没分到, 6 件技能全是"无归属"。
       每个座位的容量本来就是硬上限(1 英雄 + 4 技能), 满了自然停, 不需要靠收益为正来兜底。 */
    if (!isFinite(dist[T]) || dist[T] > 1e-9) break;
    let f = Infinity; for (let v = T; v !== S; v = to[pre[v] ^ 1]) f = Math.min(f, cap[pre[v]]);
    for (let v = T; v !== S; v = to[pre[v] ^ 1]) { cap[pre[v]] -= f; cap[pre[v] ^ 1] += f; }
    flow += f; tot += f * dist[T];
  }
  const owner = new Int32Array(n).fill(-1);
  for (let s = 0; s < nSeat; s++) for (let e = head[seat0 + s]; e >= 0; e = nx[e]) { const v = to[e];
    if (v >= item0 && v < item0 + n && cap[e] === 0 && cost[e] <= 0) owner[v - item0] = s; }
  return { owner, score: -tot, flow };
}

const SEATS = 10, sIdx = q => (q[0] === "L" ? 0 : 5) + q[1], sName = i => (i < 5 ? "L" : "R") + (i % 5);

class Estimator {
  /* head = 轨迹头(池子 / 参考亮度 / 顺序表) */
  constructor(head) {
    this.head = head; this.order = head.order || null;
    this.items = [];                                  // 每件:技能格 或 英雄卡
    for (const s of head.pool.skills) this.items.push({ key: s.key, cell: s.cell, hero: s.hero, ult: !!s.ult, unk: !!s.unk, kind: "skill" });
    for (const h of head.pool.heroCards) this.items.push({ key: "hero:" + h.hero, cell: h.cell, hero: h.hero, kind: "hero" });
    this.n = this.items.length; this.idxOf = {}; this.items.forEach((x, i) => this.idxOf[x.key] = i);
    this.refB = head.refB; this.refS = head.refS;
    /* 问题 A 的状态:每件一个累加器。W = Σ_k exp(Σ_{t≥k} ℓ_t)(见下 observe 的递推), cusum/at = 跳变点估计 */
    this.acc = this.items.map(() => ({ W: 0, cus: 0, at: null, best: -Infinity, last: 0, seen: 0 }));
    /* 问题 B 的状态:证据只加不减 */
    this.ev = this.items.map(() => new Float64Array(SEATS));   // 面板图标证据(按"已被拿走"的后验加权)
    this.evW = new Float64Array(this.n);                       // 每件累计的权重(= 归一化分母)
    this.evN = 0;
    this.nameEv = {};                                          // 英雄名证据 {hero: Float64Array(SEATS)}
    this.nameHit = {};                                         // 同上, 记"读到几次"(连续两次才算数, 与 1.x 一致)
    this.poolKeys = head.poolKeys || []; this.nPool = this.poolKeys.length;
    this.poolItem = this.poolKeys.map(k => this.idxOf[k] != null ? this.idxOf[k] : -1);   // 分数行的第 q 列 → 第几件
    this.frames = 0; this.lastState = null;
  }
  /* ---- 问题 A:一帧观测 → 累加 ---- */
  _stepA(i, f, hover, damp) {
    const a = this.acc[i]; let l = llr(f); if (hover) l *= HOVER_W; if (damp && l > 0) l *= damp;
    a.last = l; a.seen++;
    /* 后验几率的闭式递推(几何先验 τ~Geom(h)):  U ← e^ℓ · (U + h) / (1 − h),  p = U/(1+U)。
       一行递推就是问题 A 的全部状态 —— 没有去抖计数、没有闪烁标记、没有 12 帧锁定、没有撤回。 */
    a.W = Math.min(1e12, Math.exp(l) * (a.W + HAZ) / (1 - HAZ));
    /* 跳变点:CUSUM。best_T = max(best_{T-1}, 0) + ℓ_T;从 0 重启的那一帧就是跳变点估计。 */
    if (a.cus <= 0) { a.cus = l; a.at = this.frames; } else a.cus += l;
    if (a.cus > a.best) { a.best = a.cus; a.bestAt = a.at; }
    if (a.cus < -LMAX * 4) a.cus = -LMAX * 4;                  // 别让"没拿走"的证据积到天上去, 否则真拿走时反应慢
  }
  pTaken(i) { const a = this.acc[i], p = a.W / (1 + a.W); const it = this.items[i];
    /* 英雄卡棋盘上可能整局都没看出变暗(原画本来就暗 / 被挡)。这时"面板标题读到了他的名字"本身
       就是他已经被选走的充分证据 —— 名字只会在选完之后才出现。1.x 里这是 F 步的一个分支。 */
    if (it.kind === "hero" && this.nameHit[it.hero]) { let m = 0; for (const v of this.nameHit[it.hero]) if (v > m) m = v;
      if (m >= 2) return Math.max(p, 0.99); }
    return p; }

  /* ---- 一帧 ---- */
  observe(fr, src) {
    this.frames++;
    const hoverCell = this._hoverCell(fr);
    /* 先把这一帧的**整体明暗**量出来:取所有"还没被拿走"的格子的亮度比中位数。
       半透明浮窗 / 转场 / 技能特效会把一大片一起压暗 —— 那时中位数自己就掉下去了, 每格除以它之后 ≈1, 谁都拿不到证据;
       真有人落子时只有一格掉, 中位数不动, 那一格照样拿满分。
       这是"跟它自己开局时比"这条原则的推广:再跟**这一帧的整体**比一次。
       它替掉的是 1.x 那条硬规则"同一帧 ≥2 格新变黑 = 当遮挡, 这几格要连续 5 次才认"——
       不用数几格、不用设 5 这个数, 共因被直接解释掉了。 */
    const rr = [], mm = [], dd = [];
    for (let i = 0; i < this.n; i++) { if (this.pTaken(i) > 0.1) continue; const it = this.items[i];
      const st = src.cellStats(it.cell), ref = Math.max(this.refB[it.cell], 8), rs = Math.max(this.refS[it.cell] || 0, 0.05);
      rr.push(st.mean / ref); mm.push(st.max / ref); dd.push(st.sat / rs); }
    /* 下限 0.6 很要紧, 不是随手设的:
       ① 它有出处 —— 真机实测半透明说明框底下亮度只掉到 0.62~0.9, 所以"整体变暗"这个解释最多解释到 0.6;
       ② 没有它会形成**正反馈**。分母取的是"还没被拿走的格子", 2.0 一旦错退一格, 那格就进了分母把中位数拉黑,
          于是更多格子看起来"没被拿走"—— 退得越多退得越快。
          09-12 真机第一局就栽在这里:选技结束画面淡出时, 全盘中位掉到 0.13, 2.0 把已经学对的 50 件退到只剩 23 件。
       同理样本数门槛从 6 提到 8, 取样范围从 p≤0.3 收紧到 p≤0.1 —— 只有**确信没被拿走**的格子才有资格当基准。 */
    const med = a => { if (a.length < GMIN_N) return 1; const v = a.slice().sort((x, y) => x - y); return Math.max(GFLOOR, Math.min(1.2, v[v.length >> 1])); };
    const gr = med(rr), gm = med(mm), gd = med(dd);
    this.glob = [gr, gm, gd];
    /* 共因:一手只选走一件。所以"这一帧刚开始变暗的格子有好几个"更可能是**一个共同原因**
       (半透明说明框 / 转场 / 技能特效 盖住了一片), 而不是同时落了好几手。
       写成模型而不是规则:这一帧里"刚开始变暗"的件数 k 越多, 每一件拿到的证据就按 1/k 打折 ——
       k=1(真落子)满分, k=30(浮窗盖一片)每件只值 1/30。
       但遮挡是短暂的、落子是永久的:已经连续暗了 DFREE 帧以上的格子不再受这条约束
       (从后台切回来 / 晚锁池时确实可能一次看到好几件已被选走)。
       1.x 用四个门槛(need=2 / hold=5 / flaky=6 / 锁定=12)分散实现同一件事;这里是一个机制。 */
    const feat = new Array(this.n);
    for (let i = 0; i < this.n; i++) { const it = this.items[i];
      const st = src.cellStats(it.cell), ref = Math.max(this.refB[it.cell], 8), rs = Math.max(this.refS[it.cell] || 0, 0.05);
      feat[i] = { r: st.mean / ref / gr, mr: st.max / ref / gm, ds: st.sat / rs / gd }; }
    const DFREE = +(process.env.V2_DFREE || 4);
    let k = 0; const onset = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) { const a = this.acc[i], raw = llr(feat[i]);
      a.run = raw > 0.5 ? (a.run || 0) + 1 : 0;
      if (a.run > 0 && a.run <= DFREE && this.pTaken(i) < 0.5) { onset[i] = 1; k++; } }
    const damp = k > 1 ? 1 / k : 1;
    for (let i = 0; i < this.n; i++) this._stepA(i, feat[i], hoverCell === this.items[i].cell, onset[i] ? damp : 1);
    /* ---- 问题 B 的证据:面板 ----
       面板图标是持久的(选到手就一直在那一格), 所以不必抓住"图标出现的那一帧" —— 任何时候重看一遍都算数,
       漏看过、当时认错过、被挡过, 下一帧都能自己纠回来。
       用**集合**不用槽位:某座位任意一个槽像某件技能, 就算这件技能在这个座位的证据。玩家拖动换位置天然无影响
       —— 1.x 里"数图标总数而不是看第几个槽"那个专门的绕法在这里不需要存在。 */
    const panels = src.panels(false); let any = false;
    for (const p of panels) { const s = sIdx([p.side, p.idx]);
      if (hoverCell === -1 - s) continue;                  // 鼠标压着的面板这一轮不算(拖动/悬停都在这时候)
      let best = null;
      for (let j = 0; j < 4; j++) { if (!p.skills[j]) continue;
        const row = src.row(p.side + p.idx + ":" + j); if (!row) continue;
        if (!best) best = new Float64Array(this.nPool).fill(-9);
        for (let q = 0; q < this.nPool; q++) if (row[q] > best[q]) best[q] = row[q]; }
      if (!best) continue; any = true;
      /* 按"这件已经被拿走"的后验加权累计, 而不是每帧都记。
         一件技能在被人选走之前根本不可能出现在任何面板里 —— 那些帧的分数是纯噪声, 全算进平均会把信号稀释掉。
         实测:不加权时一件技能的十个座位证据是 0.33/0.33/0.31/0.29(完全分不开), 加权后立刻拉开。
         用后验加权而不是"等 p>0.5 再开始记", 是为了保住"从不硬提交"——证据本身也是软的。 */
      for (let q = 0; q < this.nPool; q++) { const i = this.poolItem[q]; if (i < 0) continue;
        const w = this.pTaken(i); if (w < 1e-3) continue;
        this.ev[i][s] += w * best[q]; if (s === 0) this.evW[i] += w; } }
    if (any) this.evN++;
    /* 这一帧面板里有图标的槽数 —— 每个有图标的槽 = 有人选走了一件技能。
       这是"已跳变的件数 = 已完成的手数"那条等式里**可靠的那一侧**:面板是持久的、不会被棋盘那边的遮挡影响。
       (真机 17 帧实测:面板槽数与棋盘"看着已选走"的技能格数, 13 帧精确相等。)
       注意**不**用高亮推手数 —— worker.js 里已经写明高亮不可靠, 实测两个英雄被记到同一个座位就是信它信出来的。 */
    let fl = 0; for (const p of panels) fl += p.filled;
    this.slotsNow = Math.max(this.slotsNow || 0, fl);   // 单调:面板图标只会多不会少(拖动时会瞬间少一个)
    /* ---- 英雄名证据 ----
       英雄卡在**面板上不存在**(面板只放技能), 所以英雄唯一的第二信号就是面板标题里的名字。
       只给"这一格的第一名、分够高、领先够多"记分 —— 把每个候选的分都累加是纯噪声(所有人都在涨)。
       门槛沿用 1.x 实测出来的那一组:≥0.40 且领先 ≥0.10(认错的那次分只有 0.17、领先 0.10)。 */
    for (const seat in fr.names || {}) { const arr = fr.names[seat], s = sIdx([seat[0], +seat.slice(1)]);
      if (!arr.length) continue; const [sc, h] = arr[0], lead = sc - (arr[1] ? arr[1][0] : -1);
      if (!h || sc < 0.40 || lead < 0.10) continue;
      (this.nameEv[h] = this.nameEv[h] || new Float64Array(SEATS))[s] += sc;
      (this.nameHit[h] = this.nameHit[h] || new Int32Array(SEATS))[s]++; }
    this.lastState = null;
  }
  _hoverCell(fr) { const c = fr.cursor; if (!c) return null;
    for (const it of this.items) { const b = fr.boxes[it.cell]; if (!b) continue; const m = b[2] * 0.15;
      if (c[0] >= b[0] - m && c[0] <= b[0] + b[2] + m && c[1] >= b[1] - m && c[1] <= b[1] + b[3] + m) return it.cell; }
    for (const k in fr.boxes4) { const b = fr.boxes4[k]; if (c[0] >= b[0] && c[0] <= b[0] + b[2] && c[1] >= b[1] && c[1] <= b[1] + b[3]) return -1 - sIdx([k[0], +k[1]]); }
    return null; }

  /* ---- 查询:拿当前全部证据重解一次 ---- */
  state(opt) {
    if (this.lastState && !(opt && opt.force)) return this.lastState;
    const TH = (opt && opt.pmin) || 0.5;
    const taken = [], pt = [];
    for (let i = 0; i < this.n; i++) { const p = this.pTaken(i); pt.push(p); if (p >= TH) taken.push(i); }
    /* 手数上限:被判定拿走的**技能**不能明显多于面板里有图标的槽数。
       面板图标会晚 0~5 帧才画出来(真机实测), 所以留 SLACK 的余量 —— 刚落的那一手照样能立刻算数。
       这条把"半透明浮窗一帧盖黑一片"整类错误卡死:棋盘那边可以一下子看着暗 30 格, 但面板不会凭空多 30 个图标。
       1.x 用的是"同一帧 ≥2 格新变黑就当遮挡 + 手数 ≤ 暗格数 + 1"两条规则, 这里是同一条约束的正面写法。 */
    const SLACK = +(process.env.V2_SLACK || 3);
    const cap = (this.slotsNow || 0) + SLACK;
    const skIdx = taken.filter(i => this.items[i].kind === "skill").sort((a, b) => pt[b] - pt[a]);
    if (skIdx.length > cap) { const keep = new Set(skIdx.slice(0, cap));
      for (let j = taken.length - 1; j >= 0; j--) { const i = taken[j];
        if (this.items[i].kind === "skill" && !keep.has(i)) taken.splice(j, 1); } }
    /* 指派:只对"已判定被拿走"的件求解。费用 = 面板证据(技能) / 名字证据(英雄) / 顺序证据(两者都有) */
    const idx = taken, m = idx.length;
    const caps = new Array(SEATS).fill(0);
    for (let s = 0; s < SEATS; s++) caps[s] = 5;                      // 每座位 1 英雄 + 4 技能 = 5 件
    const W = [], NEG = -1e9;
    /* 顺序证据:第 j 件被拿走的应属于顺序表第 j 位。用变点时刻排序得到 j。 */
    const rank = idx.map(i => ({ i, t: this.acc[i].bestAt != null ? this.acc[i].bestAt : 1e9 })).sort((a, b) => a.t - b.t);
    const orderSeat = {}; if (this.order) rank.forEach((x, j) => { const o = this.order[Math.min(j, this.order.length - 1)]; orderSeat[x.i] = o; });
    const W_ORDER = +(process.env.V2_WORDER || 0.25), W_ORDER_H = +(process.env.V2_WORDERH || 2.0);
    for (const i of idx) { const row = new Array(SEATS).fill(0), it = this.items[i];
      for (let s = 0; s < SEATS; s++) {
        let v = 0;
        if (it.kind === "skill") v = this.evW[i] > 1e-6 ? this.ev[i][s] / this.evW[i] : 0;
        else { const ne = this.nameEv[it.hero], nh = this.nameHit[it.hero];
          /* 名字读到 ≥2 次 = 确认(与 1.x 的 F 步同口径), 直接给一个压倒性的分 */
          v = nh && nh[s] >= 2 ? 5 + ne[s] / nh[s] : (ne ? ne[s] * 0.1 : 0); }
        /* 顺序证据:第 j 件被拿走的属于顺序表第 j 位。对技能它只是辅助(面板才是主信号),
           对英雄它是**主信号** —— 面板上根本没有英雄卡, 1.x 也是"按回合填空"。 */
        if (orderSeat[i] === s) v += it.kind === "hero" ? W_ORDER_H : W_ORDER;
        row[s] = v; }
      W.push(row); }
    /* 英雄和技能的容量要分开:一个座位只能有 1 个英雄。做法:英雄单独解一次(容量 1), 技能解一次(容量 4)。 */
    const pick = kind => { const sel = idx.map((i, j) => [i, j]).filter(([i]) => this.items[i].kind === kind);
      if (!sel.length) return { owner: {}, margin: {} };
      const sub = sel.map(([, j]) => W[j]), cap = new Array(SEATS).fill(kind === "hero" ? 1 : 4);
      const r = assign(sub, cap, sub.length, SEATS);
      /* 置信度 = 最优解 与 "禁止这一件去它现在那个座位" 的次优解之差。低置信度的不进入个人权重计算。 */
      const owner = {}, margin = {};
      for (let a = 0; a < sel.length; a++) { const s = r.owner[a]; if (s < 0) continue;
        owner[this.items[sel[a][0]].key] = sName(s);
        const save = sub[a][s]; sub[a] = sub[a].slice(); sub[a][s] = NEG;
        const r2 = assign(sub, cap, sub.length, SEATS); sub[a] = sub[a].slice(); sub[a][s] = save;
        margin[this.items[sel[a][0]].key] = Math.round((r.score - r2.score) * 1000) / 1000; }
      return { owner, margin }; };
    const sk = pick("skill"), hr = pick("hero");
    const out = { owner: sk.owner, margin: sk.margin, heroOwner: hr.owner, heroMargin: hr.margin,
      taken: idx.map(i => this.items[i].key), p: {}, at: {} };
    for (let i = 0; i < this.n; i++) { out.p[this.items[i].key] = Math.round(pt[i] * 1000) / 1000;
      if (pt[i] >= TH) out.at[this.items[i].key] = this.acc[i].bestAt; }
    return (this.lastState = out);
  }
}
/* 把 2.0 的估计填进 1.x 的局面结构(worker/引擎/覆盖层都按这个结构消费)。
   只覆盖**状态估计**那三样:哪些东西被拿走了、每件归谁、每个座位的英雄;
   当前选人 / 我是谁 / 棋盘框 / 对齐质量这些不属于状态估计, 仍然用 1.x 那一路算出来的。 */
Estimator.prototype.applyTo = function (S, opt) {
  const st = this.state(), MIN = (opt && opt.margin) || 0;   // state() 每帧算一次就缓存(observe 时作废), 别重复求解
  const takenSet = new Set(st.taken);
  /* **先全部算好, 最后一次性写进 S**。中途抛异常不能留下一个改了一半的局面 ——
     那会让引擎拿到"技能标了已拿走、但面板还是空的"这种自相矛盾的东西。 */
  const bySeat = {}; for (const p of S.panels) bySeat[p.side + p.idx] = { hero: null, skills: [] };
  for (const k in st.owner) { const b = bySeat[st.owner[k]]; if (b && (st.margin[k] || 0) >= MIN) b.skills.push({ key: k }); }
  for (const k in st.heroOwner) { const b = bySeat[st.heroOwner[k]]; if (b) b.hero = k.slice(5); }
  /* 占位:面板里有图标的槽数是可靠的(每个有图标的槽 = 他选走了一件技能)。
     2.0 认出来的比这个少时(证据还不够, 或者置信度没过门槛), 差额用 ?pick 补上 ——
     不补的话引擎会以为那个人还能多选几手。 */
  let extra = 0;
  for (const p of S.panels) { const b = bySeat[p.side + p.idx];
    const need = Math.max(0, (p.filled || 0) - b.skills.length);
    for (let i = 0; i < need; i++) { b.skills.push({ key: "?pick" }); extra++; } }
  /* pending = "还有东西没拿准, 下一帧必须做完整识别"。1.x 用去抖计数, 2.0 直接用后验:
     有任何一件卡在中间地带(0.2~0.8), 就说明证据还不够。 */
  let pending = false;
  for (let i = 0; i < this.n; i++) { const p = this.pTaken(i); if (p > 0.2 && p < 0.8) { pending = true; break; } }
  // ---- 到这里为止没碰过 S ----
  for (const r of S.skills) r.taken = takenSet.has(r.key);
  S.taken_heroes = this.items.filter(x => x.kind === "hero" && takenSet.has(x.key)).map(x => x.hero);
  for (const p of S.panels) { const b = bySeat[p.side + p.idx]; p.hero = b.hero; p.skills = b.skills; }
  S.extraPicks = extra; S.pending = pending;
  // 1.x's provisional queue does not qualify 2.0's independent estimates.
  S.pendingKeys = []; S.pendingPair = 0;
  S.suspects = st.taken.filter(k => !k.startsWith("hero:") && !st.owner[k]);
  S.turn = st.taken.length;
  S.v2 = { p: st.p, margin: st.margin, lowConf: Object.keys(st.margin).filter(k => st.margin[k] < 0.3) };
  return S;
};
/* 和 1.x 的结论比一比, 返回分歧(测试模式下用来自动截图 + 记日志) */
Estimator.prototype.diff = function (tracker) {
  const st = this.state(), out = [];
  const q2 = q => q ? q[0] + q[1] : null;
  const t1 = new Set(tracker.pickedKeys()), t2 = new Set(st.taken);
  for (const k of t2) if (!k.startsWith("hero:") && !t1.has(k)) out.push(`只有2.0认为${k}被拿走`);
  for (const k of t1) if (!t2.has(k)) out.push(`只有1.x认为${k}被拿走`);
  for (const k in st.owner) { const a = q2(tracker.owner[k]); if (a && a !== st.owner[k]) out.push(`${k}: 1.x=${a} 2.0=${st.owner[k]}(置信${(st.margin[k] || 0).toFixed(2)})`); }
  for (const k in st.heroOwner) { const h = k.slice(5), a = q2(tracker.heroOf[h]); if (a && a !== st.heroOwner[k]) out.push(`英雄${h}: 1.x=${a} 2.0=${st.heroOwner[k]}`); }
  return out;
};
module.exports = { Estimator, llr, assign, LK, LMAX, HAZ };
