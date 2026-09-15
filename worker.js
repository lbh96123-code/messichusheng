"use strict";
/* 识别 + 引擎工作线程(v0.5)。
   主线程按 phase 定节拍发帧:idle 1.5s 一张半分辨率;active 250ms 一张半分辨率"扫描帧",需要时(want.full)发一张全分辨率。
   两条通道:
     快通道(扫描帧, 几毫秒) —— 只量 60 格亮度找"谁被选走了"。恰好多黑 1 格 = 有人落子 ⇒ 立刻记账 + 立刻给下一位算胜率(不等高亮移过来)。
                                 多黑 ≥2 格 = 多半是鼠标悬停的提示框盖住了一片 ⇒ 不认, 要一张全图确认。
     慢通道(全分辨率, 数百毫秒) —— 完整识别:对齐、面板技能、英雄名、当前选人/我, 用来纠正快通道的记账。
   开局自动:棋盘出现 → 读池子 → 12 英雄齐就锁定, 不需要按键。中途加入/误按 F10 也能重锁(黑格用库亮度回退)。 */
const { parentPort } = require("worker_threads"); const fs = require("fs"), path = require("path");
const R = require("./recog.js"); const D = path.join(__dirname, "data");
const TR = require("./trace.js");   // 观测轨迹:把每帧**看到了什么**写下来, 真机对局才能离线回放
const V2 = require("./v2.js");      // 2.0 状态估计(证据累加 + 带容量指派), 由内核开关决定用不用
const rd = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };   // 小文件的 Buffer 在共享池里, 必须按 offset 截

R.init({ lib: { keys: JSON.parse(fs.readFileSync(D + "/lib_keys.json")), q: new Int8Array(rd(D + "/lib_i8.bin")), scale: new Float32Array(rd(D + "/lib_scale.bin")) },
  names: { tpl: JSON.parse(fs.readFileSync(D + "/names.json")), bin: new Uint8Array(fs.readFileSync(D + "/names.bin")) },
  meta: JSON.parse(fs.readFileSync(D + "/meta.json")), layout: JSON.parse(fs.readFileSync(D + "/layout_2560x1440.json")),
  bright: JSON.parse(fs.readFileSync(D + "/lib_bright.json")), heroBright: JSON.parse(fs.readFileSync(D + "/hero_bright.json")) });
const E = path.join(__dirname, "engine", "server"); const Dr = require(E + "/draft.js"), AI = require(E + "/ai.js");
const sig = z => 1 / (1 + Math.exp(-z));
const log = (tag, msg) => parentPort.postMessage({ type: "log", tag, msg });
/* 组合评分只是显示层:它加载失败或者某一帧出错, 都不能拖垮识别和推荐。
   · 启动时加载失败 → 换成返回空数组的评分器(以前整个 worker 起不来, 插件直接没用);
   · 某一帧评分出错 → 这一帧评分为空, 状态和推荐照发(以前它和状态在同一个 try 里, 一抛整帧都发不出去)。
   同一类错误只记一次, 不每帧刷屏。回归测试:test/player_scores_guard.js(往 worker 里注入会出错的评分器) */
const scoreErrSeen = new Set();
const logScoreErr = (what, e) => { if (scoreErrSeen.has(what)) return; scoreErrSeen.add(what);
  log("error", `组合评分${what}(不影响识别和推荐): ${String(e && e.stack || e).slice(0, 400)}`); };
let scorePlayers;
try { scorePlayers = require("./player_scores.js").createPlayerScorer(); }
catch (e) { scorePlayers = () => []; logScoreErr("加载失败, 本次运行不显示组合明细", e); }
const safeScore = (panels, layout) => { try { return scorePlayers(panels, layout); } catch (e) { logScoreErr("出错, 出错的帧不显示组合明细", e); return []; } };
let DISP = null;   // 主进程告知的物理分辨率;版式按它缩放
const OMNI_M = +process.env.OMNI_M || 128;   // 每个候选走子取平均的次数, 与 ai.js 保持一致
let POOL = null, seedSeq = 0;                // 引擎线程池:候选独立, 铺满核心 ≈ 线性加速
try { if (process.env.AD_THREADS === "0") throw new Error("AD_THREADS=0 已禁用线程池");
  POOL = require("./pool.js"); const n = POOL.start((tag, msg) => log(tag, msg)); log("engine", `引擎线程池 ${n} 线程(候选并行走子)`); }
catch (e) { POOL = null; log("engine", "线程池不可用, 回退单线程: " + e.message); }
const win = {}; new Function("window", fs.readFileSync(path.join(__dirname, "engine", "public", "ad_data.js"), "utf8"))(win); Dr.setExclusive(win.AD_EXCLUSIVE || []);

const seatIdx = p => (p.side === "L" ? 0 : 5) + p.idx;   // 0-4=L1-L5, 5-9=R1-R5
/* 真实选人顺序,与 engine/server/draft.js 的 draftOrder() 完全一致:
   一轮 10 手 = 左1 右1 左2 右2 … 左5 右5,下一轮整个倒过来,五轮共 50 手。 */
const FULL_ORDER = (() => { const round = []; for (let i = 0; i < 5; i++) { round.push(i); round.push(5 + i); }
  const o = []; for (let r = 0; r < 5; r++) o.push(...(r % 2 ? round.slice().reverse() : round)); return o; })();
/* 已经走了 nPicked 手、当前高亮在 curSeat ⇒ 这是顺序表里的第几手。识别可能多算/少算一两手,取最接近的匹配 */
function orderIndex(curSeat, nPicked) { let best = -1, bd = 1e9;
  for (let i = 0; i < FULL_ORDER.length; i++) if (FULL_ORDER[i] === curSeat) { const d = Math.abs(i - nPicked); if (d < bd) { bd = d; best = i; } }
  return best < 0 ? Math.max(0, Math.min(FULL_ORDER.length - 1, nPicked)) : best; }
/* 把识别出的画面状态 S 翻译成引擎局面。startIdx = 从顺序表的第几手开始算(提前算时 = 下一手)。 */
function buildState(S, startIdx) {
  const pool = { heroKeys: S.pool_heroes.slice(), basics: [], ults: [], filled: [] };
  for (const s of S.skills) { const a = win.AD_ABILITIES[s.key]; if (!a) continue; (s.ultslot || a.ult) ? pool.ults.push(s.key) : pool.basics.push(s.key); }
  const st = Dr.newState(pool); const placed = new Set();
  const unkUsed = new Array(10).fill(0);   // 每个座位拿走的"未知技能"数:引擎里没有这个技能, 但它占掉了那人一个名额
  for (const p of S.panels) { const seat = st.seats[seatIdx(p)];
    if (p.hero) { seat.hero = p.hero; seat.seq.push(p.hero); placed.add(p.hero); }
    for (const s of p.skills || []) { if (!s || s.key === "?") continue;
      if (!win.AD_ABILITIES[s.key]) { unkUsed[seatIdx(p)]++; continue; }
      const isU = pool.ults.includes(s.key);
      if (isU) { if (!seat.ult) { seat.ult = s.key; seat.seq.push(s.key); placed.add(s.key); } } else if (seat.basics.length < 3 && !seat.basics.includes(s.key)) { seat.basics.push(s.key); seat.seq.push(s.key); placed.add(s.key); } } }
  const takenAll = S.skills.filter(s => s.taken).map(s => s.key).concat(S.taken_heroes || []);
  st.taken = [...placed]; st.blocked = Array.from(new Set(takenAll)).filter(k => !placed.has(k));
  /* 剩余顺序 = 顺序表从 startIdx 起,跳过槽位已满的座位(识别漏掉某一手时不至于给谁多排一手);
     若还有座位没排够(识别多算了手数),再按顺序表补一轮。 */
  const left = st.seats.map((s, i) => Math.max(0, 5 - (s.hero ? 1 : 0) - s.basics.length - (s.ult ? 1 : 0) - unkUsed[i])); const order = [];
  for (let pass = 0; pass < 2 && left.some(v => v > 0); pass++)
    for (let j = pass ? 0 : startIdx; j < FULL_ORDER.length; j++) { const x = FULL_ORDER[j]; if (left[x] > 0) { left[x]--; order.push(x); } }
  const cur = order.length ? order[0] : FULL_ORDER[Math.min(startIdx, FULL_ORDER.length - 1)];
  st.order = order; st.step = 0; return { st, cur };
}
/* ---- 状态 ---- */
let phase = "idle", tracker = null, seq = 0, busy = false;
let lastSig = null;        // 上次触发引擎的局面签名(有效座位/已选走/归属)
let lastQuick = null;      // 上次完整识别那一帧的画面签名
let presentRun = 0, absentRun = 0, forceReset = false, retryAt = 0, logIdx = 0, lastCur = "", lastTaken = -1, snapped = 0, frames = 0, heavy = 0, tHeavy = 0, scans = 0, tScan = 0;
let cachedState = null, pendingNext = false, dropRun = 0, rejects = 0;
/* 最近一次锁池尝试检出的格数。游戏里的画面常被粗检当成"像棋盘"(实测 09-11 整局 215 次), 但检出格只有 0~6;
   真选技画面 ≥40。覆盖层只在 near(≥40)时才显示"正在识别池子", 选技以外什么都不画 */
let lastNd = 0, lockSig = null, lockWaitLogged = false, fastPicks = new Map(), lastCal = -999;   // fastPicks:快通道判定、等完整识别确认的落子 → 判定时刻   // lockSig:上一次锁池尝试那帧的 60 格亮度(判"画面停住了没有")
let lastSeat = -1, pickedAtCur = false, lastAdvice = null, curCtx = null;   // 提前算:高亮还在他那儿但已经落子 → 直接给下一位算
let lastS = null, fastDarkPrev = null, sinceFull = 0, wantFull = false, fastCand = null, lastSusp = "";   // fastCand = 上一帧刚变黑、还等第二次确认的那一格
let extraSnaps = 0, endSnapped = false, lastDiff = "";
/* ---- 两个互相独立的开关 ----
   TESTMODE(运行模式) —— 只影响截图和日志;**不改变任何判断**。测试模式下两个内核并行跑, 把分歧记下来。
   CORE(状态估计内核) —— "1x" 或 "v2", 决定谁来判断"被拿走了没有 / 归谁", 也就是谁驱动输出。
   1.x 的 Tracker **始终**在跑:当前选人 / 我是谁 / 棋盘框 / 对齐质量不属于状态估计, 只有它算。 */
let TESTMODE = false, CORE = "1x";
/* ---- 观测轨迹 ---- */
let TRDIR = null, REC = null, trBytes = 0, EST = null, estDiff = "", estMs = 0;
const TR_CAP = +(process.env.AD_TRACE_CAP || 40) * 1024 * 1024;   // 单局上限, 超了就停写(别把用户硬盘写满)
const needV2 = () => CORE === "v2" || TESTMODE;                   // 2.0 要不要跑(驱动输出, 或并行对照)
function trStart(t, img, samePool) {
  const write = TRDIR && process.env.AD_TRACE !== "0";
  const keep = samePool && EST;   // 同一池子重锁(F10 / 画面抖动):2.0 的证据必须带过来, 否则整局的累计全丢
  if (!write && !needV2()) { EST = null; return; }                // 既不写盘也不需要 2.0 → 完全不用记录器
  try { const f = write ? path.join(TRDIR, `trace_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.jsonl`) : null;
    const old = EST; REC = new TR.Recorder(f); const head = REC.head(t, [img.w, img.h], FULL_ORDER); trBytes = 0;
    EST = needV2() ? (keep ? old : new V2.Estimator(head)) : null;
    if (keep && EST) { EST.refB = t.refB; EST.refS = t.refS; log("trace", `同一池子重锁, 2.0 保留已累计的证据(${EST.frames} 帧)`); }
    log("trace", write ? `观测轨迹 → ${path.basename(f)}${EST ? " (2.0 同时在跑)" : ""}` : "观测源已开(只在内存里, 供 2.0 用)");
  } catch (e) { REC = null; EST = null; log("trace", "开轨迹失败 " + e); } }
/* 落盘但**不**收摊:切出去再切回来会走"棋盘回来了, 继续上一局追踪"那条路, 它不经过 tryLock。
   在那里把记录器和 2.0 的证据清掉, 等于后半局既没有轨迹也没有 2.0。只有换局/换池子才真收。 */
function trFlush() { if (REC) { try { REC.save(); } catch (e) { } } }
function trStop() { trFlush(); REC = null; EST = null; }
/* 截图额度按"为什么存"分开算, 免得一类噪声把额度吃光。正式模式沿用原来的两档(各 6 张);
   测试模式下每一类各给 12 张, 且**半分辨率** —— 全分辨率 PNG 编码要 ~1 秒, 会把识别整个卡住,
   半分辨率像素量 1/4, 约 250ms, 而"当时画面长什么样"这件事半分辨率完全够看。 */
const SNAP_QUOTA = {};
function snapshot(img, why, half) {
  const test = TESTMODE && !["pool", "pool_mid", "reject", "manual", "retract", "draft_end"].includes(why);
  if (test) { if ((SNAP_QUOTA[why] = (SNAP_QUOTA[why] || 0) + 1) > 12) return; }
  else if (why === "retract" || why === "draft_end") { if (extraSnaps >= (TESTMODE ? 20 : 6)) return; extraSnaps++; }
  else { if (snapped >= (TESTMODE ? 20 : 6)) return; snapped++; }
  /* PNG 编码 ~1 秒(半分辨率 ~250ms), 在工作线程里做会**把识别整个卡住** ——
     实测测试模式下 27 帧只来得及做 21 次完整识别, 等于测试模式自己干扰了它要测的东西。
     所以这里只做像素拷贝(几毫秒), 把裸缓冲转移给主进程, 由主进程去编码落盘。 */
  try {
    let W = img.w, H = img.h, data;
    if (half || test) { W = img.w >> 1; H = img.h >> 1; data = Buffer.allocUnsafe(W * H * 4);
      for (let j = 0; j < H; j++) { const sr = (j * 2) * img.w * 4, dr = j * W * 4;
        for (let i = 0; i < W; i++) { const s = sr + i * 8, o = dr + i * 4;
          data[o] = img.data[s]; data[o + 1] = img.data[s + 1]; data[o + 2] = img.data[s + 2]; data[o + 3] = 255; } } }
    else data = Buffer.from(img.data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
    parentPort.postMessage({ type: "snapshot", why, raw: buf, w: W, h: H }, [buf]); } catch (e) { log("snap", "失败 " + e); } }
function want(full) { wantFull = wantFull || full; parentPort.postMessage({ type: "want", full: !!full, phase }); }
function poolSummary(t) { const by = {}; let orphan = 0;
  const extra = [];
  for (const s of t.pool.skills) { const tag = R.cn(s.key) + (s.ultslot ? "(大)" : "") + (s.filler ? `*补位(${R.cn(R.OWNER()[s.key] || "")})` : "");
    const h = s.hero; if (!h) { extra.push(tag); continue; } (by[h] = by[h] || []).push(tag); }
  return t.pool.poolHeroes.map(h => `${R.cn(h)}[${(by[h] || []).join("/")}]`).join(" ") + (extra.length ? `  | 其它大招格: ${extra.join(" / ")}` : ""); }
function reject(img, why, snap) { rejects++; const wait = rejects <= 12 ? 1.5 : 5;   // 选技界面是淡入的, 头十几次失败很正常, 一直快速重试;别再指数退避到几十秒
  retryAt = Date.now() + wait * 1000; presentRun = 1;
  log("pool", `拒绝(第 ${rejects} 次): ${why}; ${wait}s 后再试`); if (snap && rejects <= 2) snapshot(img, "reject");
  if (forceReset) { forceReset = false; log("pool", tracker ? "重锁失败, 沿用原池子继续追踪" : "重锁失败"); } return false; }
function tryLock(img, pres) {
  /* 先便宜地对齐(允许参数搜索):检出格不够就别做 60 格 × 513 图标的匹配了 —— 主菜单误判成棋盘时省下 1.5 s CPU */
  const t0 = Date.now(); const al = R.alignBoard(img, true); lastNd = al.nd;
  /* 只是"别在明显不是棋盘的画面上白算 1 秒"的粗筛。真正的关口是下面的 12 英雄 + 行裕度。
     阈值原来是 52, 实测真实选技画面常只检出 37~46 格(边缘格子贴着背景), 导致整局都锁不上 → 降到 40。 */
  if (al.nd < 40) return reject(img, `检出格 ${al.nd} < 40 (亮${pres.bright} 暗${pres.dark} 间隙${pres.gapDark.toFixed(2)}) ${Date.now() - t0}ms`, false);
  /* 棋盘要"停住了"才锁:选技开始时格子是一张张翻出来的, 翻到一半锁池 → 侧着的格子认错(09-11 第 2 局:4 个英雄认错, 行裕度只有 0.003, 靠 F10 才救回来)。
     和上一次尝试比 60 格亮度, 变化超过 25 的格子多于 3 个 = 还在动画, 下一帧再看(鼠标晃过一两格不算) */
  const bsig = R.boardSig(img, al.boxes), prevSig = lockSig; lockSig = bsig;
  if (!prevSig || bsig.filter((v, i) => Math.abs(v - prevSig[i]) > 25).length > 3) { retryAt = 0; presentRun = 2;   // 下一帧(实际 ~0.5 秒后)立刻再比
    if (!prevSig || !lockWaitLogged) log("pool", prevSig ? `棋盘还在变(翻牌动画), 等画面停住再锁` : `看到棋盘, 等下一帧确认画面停住再锁`); lockWaitLogged = !!prevSig; return false; }
  lockWaitLogged = false;
  const t = new R.Tracker(); const q = t.reset(img); const ms = Date.now() - t0;
  t.updateMe(R.readPanels(img, false));   // 锁池这一帧也投一票(本人座位要 3 票才认定)
  const ok = q.heroes === 12 && q.minMargin > 0.04;   // 行裕度:认错那次 0.003, 正确的几次 0.06~0.26
  log("pool", `${ok ? "锁定" : "拒绝"} 亮格${pres.bright} 暗格${pres.dark} 间隙暗${pres.gapDark.toFixed(2)} 检出格${q.nd} 英雄${q.heroes} 最小行裕度${q.minMargin.toFixed(3)} 参考黑格${q.darkCells} 亮度系数${q.ratio.toFixed(2)} 用时${ms}ms`);
  /* 诊断:单看日志就能定位"哪一行、哪一格、框歪没歪"(09-13 那次只能靠截图反推出是格 18 的框被角框撑歪) */
  try { const rows = t.pool.skills.filter(s => !s.ultslot && s.rowMargin != null), w = rows.reduce((a, s) => (!a || s.rowMargin < a.rowMargin ? s : a), null);
    const cells = w ? rows.filter(s => s.hero === w.hero).sort((a, b) => a.cell - b.cell).map(s => `格${s.cell}${R.cn(s.key)}${s.s1.toFixed(2)}`).join("/") : "";
    const dv = t.pool.align.dev || [], dev = dv.slice(0, 8).map(d => `格${d.cell} ${d.raw[2]}×${d.raw[3]}→${d.box[2]}×${d.box[3]}`).join(", ") + (dv.length > 8 ? ` …共 ${dv.length} 格` : "");
    const G = R.GEO() || {}, geo = Object.entries(t.pool.align.geo || {}).map(([r, g]) => g.after == null ? `行${r}:亮格${g.n}未标定` : `行${r}:${g.before.toFixed(2)}→${g.after.toFixed(2)}${g.ok ? "" : "(不采用)"} 高${G[r] ? G[r].H.toFixed(2) : "?"}`).join(" ");
    log("pool", `诊断 最弱行 ${w ? `${R.cn(w.hero)}(次选 ${w.rival ? R.cn(w.rival) : "?"} 裕度${w.rowMargin.toFixed(3)}): ${cells}` : "无"} | 弃用检出框 ${dev || "无"}`);
    log("pool", `诊断 逐行几何(各行图标平均分 标定前→后) ${geo}`); }
  catch (e) { log("error", "锁池诊断日志出错 " + e.message); }
  if (!ok) return reject(img, `英雄 ${q.heroes} 行裕度 ${q.minMargin.toFixed(3)}`, true);
  const old = tracker; rejects = 0;
  if (old && old.pool && old.pool.poolHeroes.slice().sort().join() === t.pool.poolHeroes.slice().sort().join()) {   // 同一局重锁:把已经认出的归属带过来
    t.owner = old.owner; t.heroOf = old.heroOf; t.firstT = old.firstT; t.pickT = old.pickT; t.frameNo = old.frameNo; t.lockFrame = old.lockFrame;   /* 帧号接着走, 否则旧落子的时间比新落子还大, 按时间排座位会乱 */
    /* 归属过程的其余状态也要带上:以前只带了归属结果, "哪些格已处理过"丢了 → 已归属的技能被当成新变暗的格子重走一遍、判成"不当落子";
       面板计数从头数 → 第一帧按"开局已在面板里"重记一遍、回合数被重置 */
    for (const f of ["known", "suspect", "pend", "unknownBy", "orphan", "forced", "pc", "pcRaw", "pcRun", "pcInit", "surSince", "turn", "flaky", "flips", "hold", "nameHero", "nameRun", "icoRef", "heroRef"]) if (old[f] !== undefined) t[f] = old[f]; t.log = old.log.slice(); t.meSeat = old.meSeat; t.meVotes = old.meVotes; t.meAuto = old.meAuto; t.curSeat = old.curSeat; t.stable = old.stable; t.darkRun = old.darkRun; t.brightRun = old.brightRun; t.bhist = old.bhist; t.nameSize = old.nameSize;
    log("pool", `同一池子重锁, 保留归属 ${Object.keys(t.owner).length} 技能 ${Object.keys(t.heroOf).length} 英雄`); }
  else logIdx = 0;
  t.fullOrder = FULL_ORDER; t.orderSeat = n => { const x = FULL_ORDER[Math.max(0, Math.min(n, FULL_ORDER.length - 1))]; return [x < 5 ? "L" : "R", x % 5]; };   // 第 n 手归谁
  tracker = t; phase = "active"; forceReset = false; lastSig = null; lockSig = null; fastPicks.clear(); lastCal = -999; if (!old || !old.pool || old.pool.poolHeroes.slice().sort().join() !== t.pool.poolHeroes.slice().sort().join()) endSnapped = false; lastQuick = null; lastCur = ""; lastTaken = -1; seq++; pendingNext = true;
  lastSeat = -1; pickedAtCur = false; lastAdvice = null; curCtx = null; lastS = null; turnLock = null; fastDarkPrev = null; sinceFull = 0;
  const samePool = !!(old && old.pool && old.pool.poolHeroes.slice().sort().join() === t.pool.poolHeroes.slice().sort().join());
  log("pool", "池子: " + poolSummary(t));
  if (REC) { try { REC.save(); } catch (e) { } REC = null; }   // 只收掉轨迹文件, EST 交给 trStart 决定留不留
  trStart(t, img, samePool);
  snapshot(img, q.darkCells > 3 ? "pool_mid" : "pool"); want(true); return true;
}
function goIdle(why) { trFlush(); if (phase !== "idle") log("phase", "→ idle: " + why); if (POOL) POOL.cancel(); phase = "idle"; lastNd = 0; lockSig = null; lastQuick = null; cachedState = null; lastS = null; fastDarkPrev = null; seq++;
  parentPort.postMessage({ type: "clear" }); want(false); }
/* ---- 出建议 ---- */
/* 同一个决策点("这一局的第 j 手")永远用同一套随机数:同一局面必然算出同一结果, 局面有真变化时结果只随变化本身变。
   实测:同一局面只换随机数, 前三每次都不一样(前几名只差 0.1~1 个百分点, 在模拟噪声以内), 同一套随机数算两遍逐位相同。
   以前每次重算都换一套随机数 —— 任何一次重算(哪怕局面没变)都可能让前三"自己跳"。 */
function seedFor(j) { const key = tracker.pool.poolHeroes.slice().sort().join(",") + "#" + j; let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 536870909) + 1; }
const REFINE_K = 6, REFINE_M = +process.env.REFINE_M || 512;   // 决赛加时:全扫完后前 6 名再各推 512 局(4 倍), 把"谁第一"从抽签变成真分出高下
function advise(S, startIdx, pre, ms, ahead, lockInfo) {
  const effSeat = FULL_ORDER[startIdx], effIsMe = (effSeat < 5 ? "L" : "R") === S.me.side && effSeat % 5 === S.me.idx;
  /* 重算的触发条件 = "第几手" + 已确认被拿走的东西(只看有没有被拿走, 不看归属细节)。
     归属改判之类不触发重算 —— 游戏里局面只会因为有人落子而改变, 其它变化都是识别在修正细节。 */
  const takenKeys = S.skills.filter(x => x.taken).map(x => x.key).concat(S.taken_heroes).sort();
  const plevel = effIsMe ? PLEVEL : 0, personal = plevel > 0, DELTA = PLEVELS[plevel].delta;   // 个人权重只作用于我自己的回合;队友那几手照旧按团队算
  const sigStr = JSON.stringify([startIdx, takenKeys, plevel]);
  if (sigStr === lastSig) {
    /* 同一局面(通常是"提前算"的结果, 现在真轮到他了):沿用结果, 并从这一刻起锁定 */
    if (lockInfo && curCtx) { curCtx.lockInfo = lockInfo; if (lastAdvice && lastAdvice.stage === "done") turnLock = { ...lockInfo, keys: lastAdvice.rows.slice(0, 10).map(r => r.key) }; }
    if (curCtx && curCtx.pre && !pre) { curCtx.pre = false;
      if (lastAdvice) { lastAdvice = { ...lastAdvice, pre: false }; parentPort.postMessage(lastAdvice); } log("advice", `轮到 ${effSeat < 5 ? "左" : "右"}${effSeat % 5 + 1} 了, 提前算好的结果直接用`); } return; }
  lastSig = sigStr; const stamp = ++seq; const ctx = curCtx = { pre, lockInfo }; const { st, cur } = buildState(S, startIdx); const side = cur < 5 ? "L" : "R", sg = side === "L" ? 1 : -1;
  const mySg = S.me.side === "L" ? 1 : -1;   // 数字一律按**我方**视角
  const seed0 = seedFor(startIdx);
  if (lockInfo) log("advice", `${side}${(cur % 5) + 1}${effIsMe ? "(我)" : "(队友)"} 正在选 → 算完即锁定到他落子为止`);
  if (pre === "preview") log("advice", `预估 ${side}${(cur % 5) + 1}${effIsMe ? "(我)" : "(队友)"} 的下一手, 前面还有 ${ahead} 手(当前 ${S.current.side}${S.current.idx + 1} 在选)`);
  else if (pre) log("advice", `${S.current.side === "L" ? "左" : "右"}${S.current.idx + 1} 已经落子 → 提前给下一位 ${side}${(cur % 5) + 1}${effIsMe ? "(我)" : ""} 算${ms != null ? ` (落子后 ${ms}ms)` : ""}`);
  parentPort.postMessage({ type: "computing", side, seat: cur });
  const cellOf = {}; for (const r of tracker.pool.skills) cellOf[r.key] = r.cell; for (const h of tracker.pool.heroBoxes) if (h.hero) cellOf[h.hero] = h.cell;
  const boxes = tracker.boxesNow, tA = Date.now();
  /* 排序:团队优先 = 按正在选的这一方的胜率;
     个人优先 = 先圈出"胜率不低于最好的 −2 个百分点"的候选, 圈内按个人分(我这一手 + 我之后几手给队伍带来的分), 圈外按胜率排在后面 */
  const rankRows = rows => { rows.sort((a, b) => b.pick - a.pick); if (!personal || !rows.length) return rows;
    const best = rows[0].pick, inBand = rows.filter(r => r.pick >= best - DELTA).sort((a, b) => b.m - a.m), out = rows.filter(r => r.pick < best - DELTA);
    inBand.forEach(r => r.band = true);
    /* 个人分标签 = 比"团队最优那一手"多给我自己加多少, 折合胜率百分点(logit×25, 50% 附近 dp/dz≈0.25) */
    const ref = rows[0].m; for (const r of rows) r.pm = 25 * (r.m - ref);
    return inBand.concat(out); };
  const mkRows = (vals, base) => rankRows(Object.entries(vals).map(([k, v]) => ({ key: k, name: R.cn(k), p: sig(mySg * v.z), pick: sig(sg * v.z), d: sig(mySg * v.z) - base, m: v.m, box: boxes[cellOf[k]] || null })));
  /* 只发**最终结果**:全扫(每候选 128 局)→ 前 6 名决赛加时(各 512 局, 同一套随机数)→ 一次性发出。
     过程中旧显示不动, 顶部只标"更新中"。 */
  const publish = (rows, base, info) => { if (stamp !== seq) return;
    const takenNow = lastS ? new Set(lastS.skills.filter(x => x.taken).map(x => x.key).concat(lastS.taken_heroes)) : new Set();
    const shown = rows.filter(r => !takenNow.has(r.key));   // 发出前再过滤此刻已经被拿走的
    lastAdvice = { type: "advice", stamp, side, seat: cur, base, stage: "done", n: rows.length, N: rows.length, rows: shown, my_turn: effIsMe, mine: S.me, pre: ctx.pre, ahead, team: ALL, personal, plevel, plname: PLEVELS[plevel].name, delta: DELTA };
    parentPort.postMessage(lastAdvice);
    if (ctx.lockInfo) turnLock = { ...ctx.lockInfo, keys: shown.slice(0, 10).map(r => r.key) };
    log("advice", `${side}${(cur % 5) + 1} ${ctx.pre === "preview" ? "预估" : ctx.pre ? "下一位" : "在选"} ${effIsMe ? "(我)" : ""}${personal ? ` [${PLEVELS[plevel].name}·让队伍最多少${100 * DELTA}]` : ""} 我方 ${(100 * base).toFixed(1)}% 前三 ${shown.slice(0, 3).map(r => `${r.name} 我方${(100 * r.p).toFixed(1)}%${personal ? ` 个${r.pm >= 0 ? "+" : ""}${r.pm.toFixed(1)}` : ""}`).join(" | ")} 候选${rows.length} ${info} 用时${Date.now() - tA}ms`); };
  let sentDone = false;
  const onBatch = res => { if (stamp !== seq) { if (POOL) POOL.cancel(); return; } if (res.stage !== "done" || sentDone) return; sentDone = true;
    const coarse = mkRows(res.vals, sig(mySg * res.base));
    if (!POOL || coarse.length <= 3) return publish(coarse, sig(mySg * res.base), "");
    const top = coarse.slice(0, REFINE_K).map(r => r.key);
    POOL.omni(st, REFINE_M, seed0, rr => { if (stamp !== seq || rr.stage !== "done") return;
      const base = sig(mySg * rr.base), fine = mkRows(rr.vals, base), fineKeys = new Set(fine.map(r => r.key));
      const rest = coarse.filter(r => !fineKeys.has(r.key)).map(r => ({ ...r, d: r.p - base, band: false }));
      const before = coarse.slice(0, 3).map(r => r.name).join("/"), after = fine.slice(0, 3).map(r => r.name).join("/");
      publish(rankRows(fine.concat(rest)), base, `(决赛加时前 ${REFINE_K}${before !== after ? `: ${before} → ${after}` : ", 名次不变"})`); }, top, personal ? cur : null); };
  if (POOL) POOL.omni(st, OMNI_M, seed0, onBatch, null, personal ? cur : null);
  else AI.omniAsync(st, onBatch, () => stamp === seq).then(r => { if (r && stamp === seq) onBatch(r); }).catch(e => { log("error", "引擎 " + (e && e.stack || e)); parentPort.postMessage({ type: "error", msg: String(e) }); });
}
/* ---- 给谁算(v1.0 用户定的两种模式) ----
   单人模式:永远只算"我的下一手"—— 没轮到我也一直预算并显示(标"预估, 前面还有 k 手"), 每有人落子就更新;
   团队模式:算"我方下一个要选的人"(左边就只看左 1~5), 对面回合直接跳过, 算我方下一位, 对面落子后再微调。
   对面的推荐一律不显示(用户:没必要看对面)。
   锁定:目标座位**真正在选**的那段时间, 只有他自己落子才可能改变局面 —— 这段时间里别的"变化"都是识别抖动,
   建议一旦算好就锁住不动;唯一例外是显示中的推荐里有东西被发现已经被拿走了(那必须更新, 不能推荐已被选的)。 */
let turnLock = null;   // {cur: 当前选人座位, j: 目标下标, keys: 显示中的前十}
function isTarget(seat, S) { const side = seat < 5 ? "L" : "R"; return ALL ? side === S.me.side : (side === S.me.side && seat % 5 === S.me.idx); }
function chooseAdvice(S, startIdx, picked, ms) {
  /* 还没认出本人座位(v1.22):不猜, 不出推荐 —— 状态行提示"未确定你是几号位", 托盘可以手动指定 */
  if (!S.me) { if (lastSig !== null) { seq++; if (POOL) POOL.cancel(); lastSig = null; lastAdvice = null; parentPort.postMessage({ type: "clear" }); } turnLock = null; return; }
  let j = startIdx; while (j < FULL_ORDER.length && !isTarget(FULL_ORDER[j], S)) j++;
  if (j >= FULL_ORDER.length) { if (lastSig !== null) { seq++; if (POOL) POOL.cancel(); lastSig = null; lastAdvice = null; parentPort.postMessage({ type: "clear" }); } return; }
  /* 锁定范围:目标就是下一个要选的人(不管他已经开始选, 还是上家刚落子、高亮还没移过来)。
     这段时间里局面不会再有合法变化(上家已经选完, 目标还没选), 任何变化都是识别抖动 —— 算好就锁住。 */
  const inTurn = j === startIdx, curSeat = seatIdx(S.current);
  if (inTurn && turnLock && turnLock.j === j) {
    const takenNow = new Set(S.skills.filter(x => x.taken).map(x => x.key).concat(S.taken_heroes));
    const gone = turnLock.keys.filter(k => takenNow.has(k));
    if (!gone.length) return;   // 锁住:这回合里别的抖动一律不理
    log("advice", `锁定中的推荐里 ${gone.map(R.cn).join("/")} 已被拿走 → 必须重算`); turnLock = null; lastSig = null;
  }
  if (!inTurn) turnLock = null;
  advise(S, j, j === startIdx ? picked : "preview", ms, j - startIdx, inTurn ? { cur: curSeat, j } : null);
}
/* 该给谁算:当前高亮这位还没落子 → 给他算;已经落子(高亮还没移走但格子已经黑了) → 提前给下一位算。
   nTaken = 已经落子的手数(含刚刚这一手)。返回顺序表下标。 */
function startIdxOf(S, picked, nTaken) { const i0 = orderIndex(seatIdx(S.current), nTaken - (picked ? 1 : 0));
  return Math.min(picked ? i0 + 1 : i0, FULL_ORDER.length - 1); }
/* ---- 快通道:半分辨率扫描帧 ---- */
function fastTick(img) {
  const t0 = Date.now(); const dark = R.fastDark(img, tracker.pool, tracker.boxesNow, tracker.refB); scans++; tScan += Date.now() - t0;
  if (!fastDarkPrev) { fastDarkPrev = dark; want(true); return false; }
  const hk = tracker.hoverKey(tracker.boxesNow); if (hk) { if (fastDarkPrev.has(hk)) dark.add(hk); else dark.delete(hk); }   // 鼠标停着的那格:当作没变
  if (REC && REC.file && trBytes < TR_CAP) { try { REC.scan(dark, tracker); } catch (e) { } }   // 快扫也进轨迹:时间分辨率 4 倍
  const added = [...dark].filter(k => !fastDarkPrev.has(k)), gone = [...fastDarkPrev].filter(k => !dark.has(k));
  fastDarkPrev = dark;
  if (!added.length && !gone.length) { fastCand = null; return false; }
  if (added.length >= 2 || gone.length) { fastCand = null; log("fast", `${added.length} 格变黑 / ${gone.length} 格变亮 → 不当落子(多半是鼠标提示框/拖动), 要全图确认`); want(true); return false; }
  /* 判据是"九宫格全暗"(见 recog.isDarkCell), 鼠标只挡一角是过不了的 —— 所以一帧就能下结论, 不用等第二帧 */
  fastCand = null;
  /* 恰好多黑一格 = 有人落子。立刻记在当前高亮那位头上,并给下一位算;随后的全图识别会纠正细节 */
  const k = added[0]; if (!lastS || !tracker.curSeat) { want(true); return false; }
  if (tracker.flaky[k]) { want(true); return false; }   // 这一格被判定为"会闪的",不能凭一帧就当落子
  const isHero = k.startsWith("hero:"), key = isHero ? k.slice(5) : k;
  const S = JSON.parse(JSON.stringify(lastS));
  /* 这是第几手就归第几手的那个座位 —— 顺序是死的(L1 R1 L2 R2…, 逐轮倒转), 比"当时高亮在谁那儿"可靠:
     完整识别 1~2 秒才一次, 高亮可能已经挪走了。实测有两个英雄被记到同一个 L1, 就是这么来的。 */
  const nBefore = tracker.turn != null ? tracker.turn : S.skills.filter(x => x.taken).length + S.taken_heroes.length;
  const os = FULL_ORDER[Math.min(nBefore, FULL_ORDER.length - 1)], oseat = [os < 5 ? "L" : "R", os % 5];
  const cs = tracker.curSeat, seat = oseat;
  if (cs && (cs[0] !== seat[0] || cs[1] !== seat[1])) log("fast", `注意:高亮在 ${cs[0]}${cs[1] + 1} 但按顺序这是第 ${nBefore + 1} 手 → 归 ${seat[0]}${seat[1] + 1}`);
  const sp = S.panels.find(p => p.side === seat[0] && p.idx === seat[1]);
  if (isHero) { if (!S.taken_heroes.includes(key)) S.taken_heroes.push(key); if (sp && !sp.hero) sp.hero = key; }
  else { const r = S.skills.find(x => x.key === key); if (r) r.taken = true; if (sp && !sp.skills.some(x => x.key === key)) sp.skills.push({ key }); }
  /* 快通道只做**临时推算**(为了抢时间提前开算), 不写任何归属 —— 归属一律等完整识别里"棋盘变暗 + 面板多一个图标"配对确认。
     以前快通道直接写归属, 写错了再靠后面改, 改的时候又可能改错。 */
  log("fast", `${R.cn(key)} 整格变暗 → 判定 ${seat[0]}${seat[1] + 1} 已落子 (扫描 ${Date.now() - t0}ms)`);
  fastPicks.set(k, { t: Date.now(), n: 0 });   // 在完整识别确认/否认之前, 推荐一直把它算作已拿走(见慢通道);n = 之后完整识别清楚看到它亮着的次数
  pickedAtCur = true; lastS = S; lastTaken = S.skills.filter(x => x.taken).length + S.taken_heroes.length + (S.extraPicks || 0);
  chooseAdvice(S, startIdxOf(S, true, lastTaken), true, Date.now() - t0);
  want(true); return true;
}
/* 测试模式下"我关心的点位" —— 每一条都对应真机上出过的一类具体问题。
   把这些时刻的画面存下来, 事后能把"插件当时怎么想的"和"画面当时什么样"对上。
   (每一类各 12 张额度、半分辨率, 见 snapshot) */
const POINTS = [
  [/按图标认/,            "forced",   "面板多出图标但棋盘没看到变暗 → 强认(这一步没有棋盘复核, 错了不会自己撤)"],
  [/棋盘上被选走的格子不够/, "cap",      "手数上限兜底触发 = 面板那边多认了图标"],
  [/按时间顺序改判/,       "heromove", "英雄按时间顺序被改判(前面有一手当时没认上)"],
  [/面板名字改判|让出/,     "heromove", "面板名字把英雄座位改了"],
  [/不当落子/,            "suspect",  "棋盘看着变暗、但没有任何面板多东西"],
  [/补认|按时间配/,        "rescue",   "主线配对失败, 走了兜底"],
];
function flushTrackLog(img) { for (; logIdx < tracker.log.length; logIdx++) { const [t, k, q, how] = tracker.log[logIdx];
  if (img && t === "hero" && how === "retract") snapshot(img, "retract");   // 英雄被撤销是罕见事件, 存下当时的画面以便排查
  if (img && TESTMODE && how !== "retract") for (const [re, why, note] of POINTS)
    if (re.test(how)) { snapshot(img, why); log("point", `[${why}] ${R.cn(k)} → ${q}: ${note}`); break; }
  log("track", how === "retract" ? `撤销 ${t === "hero" ? "英雄" : "技能"} ${R.cn(k)} (原归 ${q}, 格子亮回来了)` : `${t === "hero" ? "英雄" : "技能"} ${R.cn(k)} → ${q} (${how})`); } }
/* 另外三个点位, 不走 tracker.log:
   ① 池外高分 = 池子读错的铁证(面板里只可能出现池子里的技能) —— 轨迹里已经有每个槽的全库前二, 白拿;
   ② 2.0 认为置信度低的归属;
   ③ 每 10 手一张"平时长什么样"的底片, 好和出问题那几张对照。 */
let lastOutPool = "", lastLowConf = "", lastBase = -99;
function testPoints(img, src) {
  try {
    /* 判据必须够硬, 否则报的全是噪声。09-12 真机第一次跑就报了 3 次, 逐一查下来**三次全是假阳性**:
       其中一次全库前二是"冲击波 0.7212 / 弹幕冲击 0.7176" —— 领先只有 0.004, 等于根本没认出来;
       另一次那个槽近乎全黑(选技结束转场)。而 v1.16 那次真的铁证是 0.94/0.95/0.99。
       所以补上最要紧的一条:**全库第一要明显领先它自己的第二名**——认不出来的图标, 前几名总是挤在一起。 */
    const pool = new Set(REC.poolKeys || []), bad = [];
    for (const k in src.rec.scores) { const r = src.rec.scores[k]; if (!r || !r.g || !r.g[0]) continue;
      const g = r.g[0], g2 = r.g[1];
      if (pool.has(g[0]) || g[1] < 0.75) continue;                      // 分数够高(v1.16 的证据是 0.94+)
      if (!g2 || g[1] - g2[1] < 0.15) continue;                         // 且在全库里明显领先第二名 —— 这条才是关键
      const row = src.row(k); let mx = -9; if (row) for (const v of row) if (v > mx) mx = v;
      if (g[1] - mx >= 0.15) bad.push(`${k} 像池外的 ${R.cn(g[0])} ${g[1].toFixed(2)}(领先全库第二 ${(g[1] - g2[1]).toFixed(2)}, 池内最像才 ${mx.toFixed(2)})`); }
    if (bad.length && bad.join() !== lastOutPool) { lastOutPool = bad.join();
      log("point", `[outpool] 面板里出现了池子外的高分匹配 = 池子读错的铁证: ${bad.slice(0, 3).join(" | ")}`); snapshot(img, "outpool"); }
    if (EST) { const st = EST.state();
      const low = Object.keys(st.margin).filter(k => st.margin[k] < 0.15).map(k => `${R.cn(k)}→${st.owner[k]}(${st.margin[k].toFixed(2)})`);
      if (low.length && low.join() !== lastLowConf) { lastLowConf = low.join();
        log("point", `[lowconf] 2.0 说这几件归属没把握: ${low.slice(0, 4).join(" | ")}`); snapshot(img, "lowconf"); } }
    const n = lastTaken | 0; if (n >= lastBase + 10) { lastBase = n; snapshot(img, "base" + n); }
  } catch (e) { log("error", "点位 " + (e && e.message || e)); }
}
/* ---- 主循环 ---- */
let ALL = false, PLEVEL = 0, ME_PICK = null, mePickPool = null, meExpired = null;   // ME_PICK = 托盘手动指定的本人座位("L1".."R5"), 只对指定时那一局有效   // ALL=团队模式(显示我方五人);PLEVEL=个人权重档 0..3(界面上叫 1~4 档), 只影响我自己的回合
/* 个人权重四档 = 每一手最多允许让队伍胜率比最好的低多少(在这个范围里挑个人分最高的)。
   标定(40 个随机局面, test/calib_personal.js):个人收益的大头在前 1~2 个百分点就拿到了(每手 +0.9 折合, 整局队伍约少 ≤1),
   4~5 个百分点起每手代价跳到 0.7~0.8(整局约少 4), 7 以上等于纯贪心到顶(整局约少 5)。 */
const PLEVELS = [{ name: "团队", delta: 0 }, { name: "略偏个人", delta: 0.01 }, { name: "偏个人", delta: 0.025 }, { name: "贪", delta: 0.05 }];
parentPort.on("message", async m => {
  if (m.type === "reset") { log("key", "收到重新识别(F10/菜单): 下一帧重锁池子"); forceReset = true; presentRun = 0; retryAt = 0; want(true); return; }
  if (m.type === "logdir") { TRDIR = m.dir; return; }
  if (m.type === "display") {   // 主进程报物理分辨率 → 按它缩放版式
    DISP = [m.w, m.h]; const r = R.rescale(m.w, m.h);
    log("disp", `屏幕 ${m.w}x${m.h} → 版式比例 ${r.scale.toFixed(4)}${r.sixteenNine ? "" : " ⚠ 非 16:9, 带鱼屏版式未经验证, 可能对不准"}`); return; }
  if (m.type !== "frame" || busy) return; busy = true; frames++; ALL = !!m.all; PLEVEL = Math.max(0, Math.min(3, m.plevel | 0));
  { const pick = /^[LR][1-5]$/.test(m.meSeat || "") ? m.meSeat : null; if (!pick) meExpired = null; ME_PICK = pick && pick !== meExpired ? pick : null; }
  { const t = !!m.test, c = m.core === "v2" ? "v2" : "1x";
    if (t !== TESTMODE || c !== CORE) { const was = needV2(); TESTMODE = t; CORE = c;
      log("cfg", `运行模式=${TESTMODE ? "🔬 测试(点位全截图 + 两版并行对照)" : "正式"} 状态估计内核=${CORE === "v2" ? "2.0(试验)" : "1.x(稳定)"}`);
      /* 本来不需要 2.0、现在需要了 → 只能等下一次锁池才有观测源;反过来留着也无妨 */
      if (!was && needV2() && tracker) log("cfg", "2.0 需要从锁池那一刻开始累计证据 → 按 F10 重新识别池子即可让它接上"); } }
  try {
    const img = { w: m.w, h: m.h, data: new Uint8Array(m.buf) };
    if (tracker) tracker.cursor = m.cursor || null;   // 鼠标位置(全分辨率坐标), 悬停那格当"看不清"
    if (m.bgra) for (let i = 0; i < img.data.length; i += 4) { const t = img.data[i]; img.data[i] = img.data[i + 2]; img.data[i + 2] = t; }
    if (m.snap) snapshot(img, "manual");
    const isFull = !!m.full;
    if (isFull && (!DISP || DISP[0] !== img.w || DISP[1] !== img.h)) {   // 分辨率变了(或主进程没报过)→ 按实际帧重新缩放
      DISP = [img.w, img.h]; const r = R.rescale(img.w, img.h); trStop(); tracker = null; phase = "idle"; 
      log("disp", `按全分辨率帧重设版式 ${img.w}x${img.h} 比例 ${r.scale.toFixed(4)}${r.sixteenNine ? "" : " ⚠ 非 16:9"}`); }
    const pres = R.quickPresence(img);
    /* 锁池前要求严(格子间隙必须暗, 免得在别的界面上乱锁);已经锁上之后只要格子还亮着就认为棋盘还在 ——
       实测有一次格子 59 亮却因 间隙0.37 被判"没有棋盘"而退出追踪(多半是有面板压住了格子之间的缝) */
    const boardLike = phase === "active"
      ? (pres.bright + pres.dark >= 50 && pres.bright >= 8)
      : (pres.bright >= 8 && pres.bright + pres.dark >= 50 && pres.gapDark >= 0.75);
    if (frames % 120 === 1) log("stat", `帧${frames} 完整识别${heavy}次均${heavy ? Math.round(tHeavy / heavy) : 0}ms 快扫${scans}次均${scans ? (tScan / scans).toFixed(1) : 0}ms 阶段${phase} 亮格${pres.bright} 暗格${pres.dark} 间隙${pres.gapDark.toFixed(2)} 帧宽${img.w}`);
    if (!boardLike) { presentRun = 0; absentRun++;
      if (phase === "active" && absentRun >= 4) goIdle(`连续 ${absentRun} 帧没有棋盘(亮${pres.bright} 暗${pres.dark} 间隙${pres.gapDark.toFixed(2)})`);
      lastNd = 0; lockSig = null; parentPort.postMessage({ type: "state", phase, idle: true, pres, board: false }); return; }
    absentRun = 0; presentRun++;
    /* active + 扫描帧:走快通道 */
    if (phase === "active" && tracker && lastS && !isFull) {
      sinceFull++; const hit = fastTick(img);
      if (!hit && sinceFull >= 4 && (pendingNext || sinceFull >= 8)) want(true);   // 有待确认的变化最快 1 秒一张全图, 平时 2 秒一张
        // (实测全分辨率一帧 99ms、扫描帧 22ms —— 全图张数才是 CPU 大头)
      if (cachedState) parentPort.postMessage({ ...cachedState, skipped: true, board: true }); return; }
    if (!isFull) { want(true); parentPort.postMessage({ type: "state", phase, idle: true, pres, board: true, near: lastNd >= 40 }); return; }   // 需要全图才能继续
    /* 新一局:棋盘暗格数比已确认的已选走数少 4 个以上,且连续 2 帧 */
    if (phase === "active" && lastTaken >= 4 && pres.dark <= 2 && pres.dark <= lastTaken - 4) dropRun++; else dropRun = 0;
    if (dropRun >= 3) { log("phase", `棋盘几乎全亮(暗格 ${pres.dark})而记账里已选走 ${lastTaken}, 连续 ${dropRun} 帧 → 新的一局`); trStop(); tracker = null; phase = "idle"; presentRun = 2; retryAt = 0; seq++; dropRun = 0; parentPort.postMessage({ type: "clear" }); }
    if (phase === "idle" || forceReset) {
      if (tracker && !forceReset) {   // 之前那局的棋盘回来了(切屏回来)还是换了一局?比 60 格亮度签名
        const d = R.sigDiff(R.boardSig(img, tracker.boxesNow), tracker.lastBoardSig);
        if (d < 25) { phase = "active"; lastQuick = null; pendingNext = true; tracker.allowBulk = 1;   // 离开期间可能已经选走好几件, 允许一次批量更新
          log("phase", `棋盘回来了(签名差 ${d.toFixed(0)}), 继续上一局追踪`); want(true); }
        else { log("phase", `棋盘变了(签名差 ${d.toFixed(0)}) → 当新一局重锁`); trStop(); tracker = null; presentRun = Math.max(presentRun, 2); retryAt = 0; } }
      if ((phase !== "active" || forceReset) && presentRun >= 1 && Date.now() >= retryAt) tryLock(img, pres);   // 不再要求"看到棋盘第 2 帧":tryLock 里"连续两帧画面一样"本身就证明棋盘真在, 两条叠加会多等一帧
      if (phase !== "active") { parentPort.postMessage({ type: "state", phase, idle: true, pres, waiting: true, board: true, near: lastNd >= 40 }); return; }
    }
    /* 托盘手动指定的本人座位:只对指定时的这一局有效(座位每局都变) —— 换了一局就作废, 通知主进程把菜单改回"自动" */
    { const sig = tracker.pool.poolHeroes.slice().sort().join();
      if (ME_PICK && mePickPool && mePickPool !== sig) { log("me", `换了一局, 手动指定的本人座位 ${ME_PICK} 作废, 恢复自动识别`); meExpired = ME_PICK; ME_PICK = null; parentPort.postMessage({ type: "meManualReset" }); }
      mePickPool = ME_PICK ? (mePickPool || sig) : null;
      const man = ME_PICK ? [ME_PICK[0], +ME_PICK[1] - 1] : null;
      if (String(man) !== String(tracker.meManual)) { log("me", man ? `手动指定本人座位 ${ME_PICK}` : "本人座位改回自动识别"); tracker.meManual = man; tracker.meSeat = man || tracker.meAuto || null; pendingNext = true; } }   // 变了就强制做一次完整识别, 不等画面变化
    /* ---- 慢通道:完整识别 ---- */
    const qs = R.quickSig(img, tracker.boxesNow); const diff = R.sigDiff(qs, lastQuick);
    if (diff < 10 && cachedState && !pendingNext) { parentPort.postMessage({ ...cachedState, skipped: true }); return; }
    lastQuick = qs; tracker.lastBoardSig = qs.slice(0, 60); sinceFull = 0; wantFull = false;
    /* 技能槽贴框标定:面板是平的 UI, 同一侧所有槽偏移一样。标一次平均匹配 0.62→0.84(真实 1080p 截图),
       之前那些"面板图标认不准"(0.2~0.5)基本都是框没贴准。等有人拿到技能后才能标, 之后每 200 帧复标一次 */
    if (tracker && frames - lastCal > 200) { const fl = R.readPanels(img, false).reduce((a, p) => a + p.filled, 0);
      if (fl >= 3) { const adj = R.calibratePanels(img, tracker.pool.skills.filter(x => !x.unknown).map(x => x.key)); lastCal = frames;
        log("cal", `技能槽贴框: 左 ${adj.L.join(",")} 右 ${adj.R.join(",")}`); } }
    const t0 = Date.now(); let S, src = null;
    if (REC && (!REC.file || trBytes < TR_CAP)) {   // 上限只约束写盘;只在内存里跑(给 2.0 当观测源)时不受限
      try { src = REC.capture(img, tracker); S = tracker.update(img); }
      finally { R.setSource(null); }
      /* 2.0:吃同一份观测(与 1.x 逐字相同的那一份), 各自独立地得出结论 */
      estDiff = ""; if (EST && src) { const e0 = Date.now();
        try { EST.observe(src.rec, src);
          if (TESTMODE) { const d = EST.diff(tracker); estDiff = d.join("; ");
            if (d.length && d.join() !== lastDiff) { lastDiff = d.join();
              log("v2", `两版分歧 ${d.length} 处: ${d.slice(0, 4).map(x => x.replace(/[a-z_]+_[a-z_]+/g, m => R.cn(m))).join(" | ")}`);
              snapshot(img, "disagree"); } }
          if (CORE === "v2") S = EST.applyTo(S, { margin: 0 });
        } catch (e) { log("error", "2.0 " + (e && e.stack || e)); }
        estMs = Date.now() - e0; }
      /* 点位检查必须在 flush **之前**:flush 会把"沿用上一帧"的分数行换成一个标记(没有分数本体),
         之后再问就取不到了 —— 池外高分那一条会静悄悄地永远不触发。 */
      if (TESTMODE) testPoints(img, src);
      try { REC.flush({ cur: tracker.curSeat, me: tracker.meSeat, taken: lastTaken, core: CORE, test: TESTMODE }); } catch (e) { }
      trBytes = REC.bytes;
      if (REC.file && trBytes >= TR_CAP) { log("trace", `轨迹到达 ${(TR_CAP / 1048576).toFixed(0)}MB 上限, 停止写盘`); REC.file = null; } }
    else S = tracker.update(img);
    const ms = Date.now() - t0; heavy++; tHeavy += ms;
    if (tracker.meMsg) { log("me", tracker.meMsg); tracker.meMsg = null; }
    /* 快通道判定的落子, 完整识别要连续 2 帧 + 面板配对才确认(1~2 秒)。这段时间里局面如果把它时有时无, 推荐的计算会被打断重来 ——
       09-12 日志:落子后 0.4 秒和 1.7 秒各重来一次, 前半局每手白等 1.5~2 秒。现在:完整识别还看得到它暗着(或已确认)就一直算它已拿走;
       看到它亮回来 / 超过 6 秒没确认就放掉 */
    /* v1.25:以前"看到它亮回来"写成 brightRun>=1 && darkRun==0 —— 落子前它一直亮着(brightRun 早就 >=1), 完整识别只要没判成"被选走"(判"看不清"也算)
       就立刻放掉。真机 09-15 日志:左1 拿月刃, 快扫 0.5 秒就看到变黑, 但那格变黑后颜色反而变浓(棋盘下排的反光), 完整识别连判 12 秒"看不清",
       快通道的判定第一帧就被放掉 → 月刃被推荐给我 20 秒。现在:只有完整识别**清清楚楚看到它亮着('N')连续 2 帧**才放, 否则一直算已拿走, 最长 20 秒 */
    const rawNow = tracker.prev && tracker.prev.rawState || {};
    for (const [k, fp] of [...fastPicks]) { const isH = k.startsWith("hero:"), key = isH ? k.slice(5) : k;
      const confirmed = isH ? S.taken_heroes.includes(key) : S.skills.some(x => x.key === key && x.taken);
      const raw = isH ? ((tracker.pool.heroBoxes.find(h => "hero:" + h.hero === k) || {}).state) : rawNow[k];
      if (raw === "N") fp.n = (fp.n || 0) + 1;
      if (confirmed || Date.now() - fp.t > 20000 || fp.n >= 2) { fastPicks.delete(k); continue; }
      if (isH) S.taken_heroes.push(key); else { const r = S.skills.find(x => x.key === key); if (r) r.taken = true; } }
    pendingNext = !!S.pending;
    flushTrackLog(img);
    if (S.bulkMsg) log("fast", S.bulkMsg);
    if (S.flakyMsg) log("fast", S.flakyMsg);
    const curStr = `${S.current.side}${S.current.idx + 1}`, nTaken = S.skills.filter(s => s.taken).length + S.taken_heroes.length + (S.extraPicks || 0), prevTaken = lastTaken;
    if (nTaken !== lastTaken && lastTaken >= 0) { log("board", `第 ${nTaken} 手 [1.x] ${tracker.snapshotLine()}`);
      if (EST) { const st = EST.state(), seats = [];
        for (const side of ["L", "R"]) for (let i = 0; i < 5; i++) { const q = side + i;
          const h = Object.keys(st.heroOwner).find(x => st.heroOwner[x] === q);
          const sk = Object.keys(st.owner).filter(x => st.owner[x] === q).map(x => R.cn(x) + ((st.margin[x] || 0) < 0.3 ? "?" : ""));
          seats.push(`${side}${i + 1}:${h ? R.cn(h.slice(5)) : "-"}|${sk.join("/") || "-"}`); }
        log("board", `第 ${nTaken} 手 [2.0] ${seats.join("  ")}   (带 ? 的是 2.0 自己说没把握的)`); } }
    if (nTaken >= 45 && !endSnapped) { endSnapped = true; snapshot(img, "draft_end"); }   // 快选完时存一张:这个分辨率下所有"被选走"格子的真实样子
    if (S.suspects && S.suspects.length && S.suspects.join() !== lastSusp) { lastSusp = S.suspects.join(); log("board", `不当落子的暗格: ${S.suspects.map(R.cn).join(", ")}`); }
    if (curStr !== lastCur || nTaken !== lastTaken) { log("state", `当前选人 ${curStr} 我 ${S.me ? S.me.side + (S.me.idx + 1) : "未确定"} 轮到我=${S.my_turn} 已选走 ${nTaken} (技能${nTaken - S.taken_heroes.length}+英雄${S.taken_heroes.length}, 本帧黑格${S.rawDark}${S.occluded ? ` 看不清${S.occluded}` : ""}${S.pending ? " 待确认" : ""}) 对齐nd=${S.align.nd} 识别${ms}ms${EST ? ` (2.0 ${estMs}ms${CORE === "v2" ? " 在驱动" : " 并行对照"}${estDiff ? ", 有分歧" : ""})` : ""} 画面差${diff.toFixed(0)}`); lastCur = curStr; lastTaken = nTaken; }
    const curSeat = seatIdx(S.current);
    if (curSeat !== lastSeat) { pickedAtCur = false; lastSeat = curSeat; }
    else if (prevTaken >= 0 && nTaken > prevTaken) pickedAtCur = true;
    const startIdx = startIdxOf(S, pickedAtCur, nTaken); const effSeat = FULL_ORDER[startIdx];
    if (effSeat === curSeat) pickedAtCur = false;
    const effIsMe = !!S.me && (effSeat < 5 ? "L" : "R") === S.me.side && effSeat % 5 === S.me.idx;
    /* 快通道基准直接取自这一帧的原始黑格(与快扫同一判据):这样"全图识别之后、下一次快扫之前"发生的落子不会被吞掉,
       也不会把正在去抖确认中的格子当成新落子 */
    /* 快通道基准 = 上一张**扫描帧**(同一分辨率同一判据)。以前拿全分辨率的判定当基准, 暗色英雄卡在两种分辨率下判得不一样,
       每张扫描帧都显示"1 格变黑/2 格变亮", 快通道整整半分钟是瞎的(实测 50 多行)。 */
    lastS = S;
    cachedState = { type: "state", playerScores: safeScore(S.panels, R.LAYOUT()), phase, ms, my_turn: S.my_turn, current: S.current, me: S.me, meSource: tracker.meManual ? "manual" : tracker.meAuto ? "auto" : null, align: S.align, taken: nTaken, poolOk: S.pool_heroes.length === 12, pre: pickedAtCur, nextIsMe: pickedAtCur && effIsMe, board: true };
    parentPort.postMessage(cachedState);
    if (S.pool_heroes.length === 12) chooseAdvice(S, startIdx, pickedAtCur, null);
  } catch (e) { log("error", String(e && e.stack || e)); parentPort.postMessage({ type: "error", msg: String(e && e.stack || e) }); }
  finally { busy = false; }
});
parentPort.postMessage({ type: "ready" });
