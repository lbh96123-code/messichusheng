"use strict";
/* 观测轨迹(2.0 第 1 步) —— 把每一帧**看到了什么**写下来, 而不只是写**判断出了什么**。
   1.x 最大的可测试性缺陷是日志里只有结论:某技能归了谁、某格撤销了。真机打过的对局没法回放,
   所以"新版本在真实数据上不劣于旧版本"根本无法验收。

   轨迹只记追踪层真正用到的四样观测(见 recog.js 的"观测源"):
     · 棋盘 60 格的亮度统计 {均值, 最亮一格, 饱和度} —— 记**原始量**不记三态, 2.0 想换判据时不用重跑像素;
     · 面板 40 个槽的 {均值, 纹理} + 面板边框颜色 —— 同理, "有没有图标"这条判据以后能换;
     · 面板某个槽对池子里每个技能的匹配分(int8) + 全库前三 —— 面板图标是持久的, 只在内容变了时重算;
     · 面板标题英雄名的匹配分。
   有了这四样, 1.x 的归属和 2.0 的估计都能在同一份真机数据上离线跑, 逐项对比。

   格式:JSONL(可 gzip)。第一行是头(池子/参考亮度/棋盘框), 之后每行一帧。 */
const fs = require("fs"), zlib = require("zlib");
const R = require("./recog.js");

const q1 = v => Math.round(v * 10) / 10;
/* 重锁时 worker.js 从旧追踪器搬过来的字段(必须和 worker.js tryLock 里那张表一致) */
const CARRY = ["owner", "heroOf", "suspect", "pend", "unknownBy", "orphan", "forced", "pc", "pcRaw", "pcRun", "pcInit",
  "surSince", "turn", "flaky", "flips", "hold", "nameHero", "nameRun", "stable", "darkRun", "brightRun", "bhist",
  "firstT", "pickT", "frameNo", "meSeat", "meVotes", "meAuto", "curSeat", "nameSize"];
/* 分数行用 int16(1e-4 精度)而不是 int8:阈值(0.3/0.45/0.6…)边上差 0.008 就可能翻判, 回放就不再是**同一件事**了。
   实测 int8 会让 8 条日志的分数差 0.01;换 int16 后逐字相同。 */
const i8 = a => { const b = Buffer.allocUnsafe(a.length * 2);
  for (let i = 0; i < a.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(a[i] * 10000))), i * 2);
  return b.toString("base64"); };
const un8 = s => { const u = Buffer.from(s, "base64"), o = new Float32Array(u.length >> 1);
  for (let i = 0; i < o.length; i++) o[i] = u.readInt16LE(i * 2) / 10000; return o; };

/* ---------- 观测源:一帧的记录 + 供给。记录模式下带着 img, 缺什么就现算现补(并写进记录);
   回放模式下没有 img, 缺什么就记一次"缺口"——缺口数 = 轨迹完整度的直接度量。 ---------- */
class Frame {
  constructor(rec, opt) { this.rec = rec; this.img = (opt && opt.img) || null; this.tr = (opt && opt.tracker) || null;
    this.poolKeys = (opt && opt.poolKeys) || []; this.cache = (opt && opt.cache) || null; this.miss = 0; this.missWhat = []; }
  _gap(what) { this.miss++; if (this.missWhat.length < 8) this.missWhat.push(what); }
  boxes() { const b = {}; for (const c in this.rec.boxes) b[c] = this.rec.boxes[c].slice(); return b; }
  cellStats(cell) { const C = this.rec.cells, i = cell * 3;
    if (!C || C[i] == null) { if (this.img) return R.cellStats(this.img, this.rec.boxes[cell]); this._gap("cell" + cell); return { mean: 0, max: 0, sat: 0 }; }
    return { mean: C[i], max: C[i + 1], sat: C[i + 2] }; }
  slotFilled(slot) { const g = this.rec.slots[slot]; if (!g) { this._gap("slot" + slot); return false; }
    return g[2] ? g[0] >= 30 : (g[0] >= 60 || g[1] >= 10); }
  panels(candKeys) {
    const out = [];
    for (const p of this.rec.panels) { const skills = [], slotBoxes = [];
      for (let j = 0; j < 4; j++) { const slot = p.seat + ":" + j, box = this.rec.boxes4[slot].slice(); box.slot = slot; slotBoxes.push(box);
        if (!this.slotFilled(slot)) { skills.push(null); continue; }
        if (candKeys === false) { skills.push({ key: "?", s: 0 }); continue; }
        const r = this.match(slot, candKeys && candKeys.length ? candKeys : null);
        skills.push(r.s1 >= 0.3 ? { key: r.key, s: r.s1 } : { key: "?", s: r.s1 }); }
      out.push({ side: p.seat[0], idx: +p.seat.slice(1), skills, slotBoxes, filled: skills.filter(Boolean).length,
        borderBright: (p.b[0] + p.b[1] + p.b[2]) / 3, borderRGB: p.b.slice(), faceSat: p.fs, faceTex: p.ft, hasFace: p.fs < 185 && p.ft > 2000, selfRim: p.r || 0 }); }
    return out; }
  /* 某个槽对一批候选的匹配。cands 全在池子里 → 查记录的分数行;cands=null(全库) → 查记录的全库前三。 */
  match(slot, cands) {
    let row = this.rec.scores[slot];
    if (!row && this.img) row = this._score(slot);
    if (!row) { this._gap("score" + slot); return { key: null, s1: -9, key2: null, s2: -9 }; }
    if (!cands) { const g = row.g || []; return { key: g[0] ? g[0][0] : null, s1: g[0] ? g[0][1] : -9, key2: g[1] ? g[1][0] : null, s2: g[1] ? g[1][1] : -9 }; }
    const P = row.pv || (row.pv = un8(row.p)); let b1 = -9, k1 = null, b2 = -9, k2 = null;
    for (const k of cands) { const i = this.poolKeys.indexOf(k); let s;
      if (i >= 0) s = P[i];
      else { const g = (row.g || []).find(x => x[0] === k); if (g) s = g[1]; else { if (this.img) { s = R.matchSkill(this.img, this._box(slot), [k]).s1; this._extra(row, k, s); } else { this._gap("key " + k); continue; } } }
      if (s > b1) { b2 = b1; k2 = k1; b1 = s; k1 = k; } else if (s > b2) { b2 = s; k2 = k; } }
    return { key: k1, s1: b1, key2: k2, s2: b2 }; }
  /* 某个槽对**池子里每件技能**的整行分数(顺序同 head.poolKeys)。2.0 的面板证据按整行累加, 不逐件问。 */
  row(slot) { let r = this.rec.scores[slot]; if (!r && this.img) r = this._score(slot);
    if (!r) { this._gap("row" + slot); return null; }
    return r.pv || (r.pv = un8(r.p)); }
  _box(slot) { const b = this.rec.boxes4[slot].slice(); b.slot = slot; return b; }
  _extra(row, k, s) { row.g = (row.g || []).concat([[k, Math.round(s * 10000) / 10000]]); }
  _score(slot) {                                  // 现算并写进记录(记录模式)
    const box = this._box(slot), prev = R.setSource ? null : null;
    R.setSource(null);
    const v = R.cellVec(this.img, box), pv = this.poolKeys.map(k => R.matchSkill(this.img, box, [k]).s1);
    const g = R.matchSkill(this.img, box, null);
    const g3 = [[g.key, Math.round(g.s1 * 10000) / 10000], [g.key2, Math.round(g.s2 * 10000) / 10000]];
    R.setSource(this);
    /* pv 必须存**量化之后**的值:记录时用原值、回放时用量化值 = 两边看到的不是同一个数,
       阈值边上就会翻判(实测恶劣条件下日志分数差 0.01)。量化一次, 两边都用它。 */
    const enc = i8(pv), row = { p: enc, g: g3, pv: un8(enc) }; this.rec.scores[slot] = row;
    if (this.onScore) this.onScore(slot);      // 告诉记录器这一行是**这一帧新算的** —— 不标的话落盘会写成"接着上一行",
    return row; }                              //   回放就沿用了一行过期的分数(实测恶劣条件下会差 0.01)
  heroName(side, idx, cands, sizeHint) {
    const seat = side + idx, have = this.rec.names[seat];
    /* 缓存只有**完全覆盖**这次问的候选时才能用:少一个候选, 排序后的第一名/领先量就可能不一样。
       (漏了这条覆盖检查时, 恶劣条件下的回放会和线上差 0.01) */
    if (have) { const m = new Set(cands.map(c => c === null ? "__none" : c));
      const f = have.filter(r => m.has(r[1] === null ? "__none" : r[1]));
      if (f.length === cands.length) return f.map(r => [r[0], r[1], r[2] || 29, 0, 0, 0]); }
    if (!this.img) { this._gap("name" + seat); return cands.map(h => [-1, h, 29, 0, 0, 0]); }
    R.setSource(null);
    const r = R.readHeroName(this.img, side, idx, cands, sizeHint, { x: side === "L" ? 50 : 181, y: 7, r: 5 });
    R.setSource(this);
    this.rec.names[seat] = r.map(x => [Math.round(x[0] * 10000) / 10000, x[1], x[2]]);
    return r; }
}

/* ---------- 记录器 ---------- */
class Recorder {
  constructor(file) { this.file = file; this.lines = []; this.n = 0; this.prevBoxes = null; this.slotAge = {}; this.slotSig = {}; this.carry = {}; this.fresh = new Set(); this.t0 = Date.now(); this.bytes = 0; }
  head(tracker, res, order) {
    const pool = { heroes: tracker.pool.poolHeroes.slice(), align: tracker.pool.align,
      skills: tracker.pool.skills.map(s => ({ cell: s.cell, box: s.box, key: s.key, hero: s.hero, ult: !!s.ultslot, unk: !!s.unknown, s1: s.s1, filler: !!s.filler, rescued: !!s.rescued, rowMargin: s.rowMargin })),
      heroCards: tracker.pool.heroBoxes.map(h => ({ cell: h.cell, box: h.box, hero: h.hero })) };
    this.poolKeys = tracker.pool.skills.filter(s => !s.unknown).map(s => s.key);
    /* 重锁(同一池子)时 worker 会把上一段的归属状态带过来 —— 头里一并记下, 否则回放从零开始, 和线上不是同一件事 */
    const carry = {}; for (const f of CARRY) if (tracker[f] !== undefined) carry[f] = tracker[f];
    carry.known = [...(tracker.known || [])];
    const h = { t: "head", v: 1, res, pool, poolKeys: this.poolKeys, refB: tracker.refB, refS: tracker.refS,
      learn: [...(tracker.learn || [])], preTaken: tracker.preTaken || [], boxAdj: tracker.boxAdj || {},
      quality: tracker.quality, order: order || null, lockFrame: tracker.lockFrame || 0, carry, ts: Date.now() };
    this._w(h); return h; }
  /* 在完整识别之前调用:算出这一帧的全部观测, 返回一个"观测源"。之后 tracker.update(img) 走的就是它。 */
  capture(img, tracker) {
    R.setSource(null); this.fresh = new Set();
    const boxes = {}; { const pa = tracker.pool.align, al = R.boxesFor({}, pa.ox, pa.oy, pa.G), A = tracker.boxAdj || {};   // 和 Tracker 每帧用的框一致:锁池时冻结的位置
      for (const c in al.boxes) { const b = al.boxes[c]; boxes[c] = A[c] ? [b[0] + A[c][0], b[1] + A[c][1], b[2] + A[c][2], b[3] + A[c][3]] : b.slice(); } }
    const nC = Object.keys(boxes).length, cells = new Array(nC * 3);
    for (const c in boxes) { const st = R.cellStats(img, boxes[c]); cells[c * 3] = q1(st.mean); cells[c * 3 + 1] = q1(st.max); cells[c * 3 + 2] = Math.round(st.sat * 1000) / 1000; }
    const raw = R.readPanels(img, false), panels = [], slots = {}, boxes4 = {};
    for (const p of raw) { const seat = p.side + p.idx;
      panels.push({ seat, b: p.borderRGB.map(q1), fs: q1(p.faceSat), ft: Math.round(p.faceTex), r: Math.round((p.selfRim || 0) * 1000) / 1000 });   // r = 本人绿框分数(v1.22), 老轨迹没有 → 回放当 0
      for (let j = 0; j < 4; j++) { const b = p.slotBoxes[j], k = seat + ":" + j; boxes4[k] = [b[0], b[1], b[2], b[3]];
        const g = R.slotSignal(img, b); slots[k] = g.tiny ? [q1(g.mean), 0, 1] : [q1(g.mean), q1(g.lap), 0]; } }
    const rec = { t: "f", f: tracker.frameNo + 1, ms: Date.now() - this.t0, cells, panels, slots, boxes4, scores: {}, names: {},
      cursor: tracker.cursor ? tracker.cursor.slice() : null };
    rec.boxes = boxes;
    const src = new Frame(rec, { img, tracker, poolKeys: this.poolKeys }); src.onScore = k => this.fresh.add(k);
    /* 面板图标是持久的 —— 只在某个槽"内容像是变了"时才重算分数行(否则每帧 40 槽 × 全库 = 秒级) */
    for (const k in slots) { const g = slots[k], filled = g[2] ? g[0] >= 30 : (g[0] >= 60 || g[1] >= 10);
      const old = this.slotSig[k], age = (this.slotAge[k] || 0) + 1;
      const changed = !old || old.filled !== filled || Math.abs(old.mean - g[0]) > 8 || age > 60;
      if (!filled) { this.slotAge[k] = age; this.slotSig[k] = { mean: g[0], filled }; continue; }
      if (changed) { src._score(k); this.fresh.add(k); this.slotAge[k] = 0; this.slotSig[k] = { mean: g[0], filled }; }
      else { this.slotAge[k] = age; if (this.carry[k]) rec.scores[k] = this.carry[k]; } }
    R.setSource(src); this.cur = rec; this.src = src; return src; }
  /* 快扫帧(250ms 一张半分辨率):只有"哪些格看着是黑的"。写进轨迹是为了给 2.0 的变点检测四倍的时间分辨率 ——
     完整识别一两秒才一帧, 光靠它, 一格"什么时候被拿走"最多只能定位到一两秒。 */
  scan(darkSet, tracker) { if (!this.poolKeys) return;
    const idx = []; let i = 0;
    for (const s of tracker.pool.skills) { if (darkSet.has(s.key)) idx.push(i); i++; }
    for (const h of tracker.pool.heroBoxes) { if (darkSet.has("hero:" + h.hero)) idx.push(i); i++; }
    const sig = idx.join(","); if (sig === this.lastScan) { this.scanRun = (this.scanRun || 0) + 1; return; }   // 没变化就不写
    this.lastScan = sig; this._w({ t: "s", ms: Date.now() - this.t0, d: idx, run: this.scanRun || 0 }); this.scanRun = 0; }
  /* tracker.update 之后调用:落盘 */
  flush(extra) { const rec = this.cur; if (!rec) return; R.setSource(null);
    if (extra) Object.assign(rec, extra);
    rec.miss = this.src.miss || undefined;
    /* 沿用的分数行不重复写:这一帧没重算的槽只写一个"接着上一行"的标记, 读的时候补回来 */
    const outScores = {};
    for (const k in rec.scores) { const r = rec.scores[k]; this.carry[k] = r;
      outScores[k] = this.fresh.has(k) ? { p: r.p, g: r.g } : { ref: 1 }; }
    rec.scores = outScores;
    /* 棋盘框整局基本不动:和上一帧一样就不重复写 */
    if (this.prevBoxes && JSON.stringify(rec.boxes) === this.prevBoxes) delete rec.boxes; else this.prevBoxes = JSON.stringify(rec.boxes);
    if (this.prevB4 && JSON.stringify(rec.boxes4) === this.prevB4) delete rec.boxes4; else this.prevB4 = JSON.stringify(rec.boxes4);
    this._w(rec); this.cur = null; this.src = null; this.n++;
    this.save(); }   // 每个完整帧就落盘(约 1 秒 4KB):插件崩了 / 被强杀时不至于整局丢掉
  _w(o) { const s = JSON.stringify(o) + "\n"; this.bytes += s.length; this.lines.push(s);
    if (this.lines.length >= 16) this.save(); }
  save() { if (!this.lines.length) return; if (!this.file) { this.lines = []; return; }   // file=null: 只在内存里做观测源, 不写盘
    try { fs.appendFileSync(this.file, this.lines.join("")); this.lines = []; } catch (e) { } }
}

/* ---------- 回放 ---------- */
function read(file) {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const lines = buf.toString("utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const head = lines.find(l => l.t === "head"); const frames = lines.filter(l => l.t === "f"); const scans = lines.filter(l => l.t === "s");
  /* 沿用:没重写的棋盘框 / 分数行, 从前一帧继承 */
  let boxes = null, boxes4 = null; const carry = {};
  for (const f of frames) { if (f.boxes) boxes = f.boxes; else f.boxes = boxes;
    if (f.boxes4) boxes4 = f.boxes4; else f.boxes4 = boxes4;
    for (const k in f.scores) { if (f.scores[k].ref) f.scores[k] = carry[k]; else carry[k] = f.scores[k]; }
    for (const k in carry) if (!f.scores[k]) f.scores[k] = carry[k]; }
  return { head, frames, scans };
}
const source = (rec, poolKeys) => new Frame(rec, { poolKeys });
/* 从轨迹头重建一个追踪器 —— 相当于离线复现当时那一次 reset(), 但完全不碰像素。
   reset() 会设的字段这里逐条设回去;漏一条就会在回放对照里立刻暴露出来。 */
function restore(head) {
  const t = new R.Tracker(); t.ref = { trace: true };
  t.pool = { poolHeroes: head.pool.heroes.slice(), align: head.pool.align,
    skills: head.pool.skills.map(s => ({ cell: s.cell, box: s.box, key: s.key, hero: s.hero, s1: s.s1, rowMargin: s.rowMargin,
      ultslot: s.ult || undefined, unknown: s.unk || undefined, filler: s.filler || undefined, rescued: s.rescued || undefined })),
    heroBoxes: head.pool.heroCards.map(h => ({ cell: h.cell, box: h.box, hero: h.hero })) };
  t.boxAdj = head.boxAdj; t.keys = t.pool.skills.map(s => s.key);
  t.refB = head.refB; t.refS = head.refS; t.learn = new Set(head.learn || []); t.preTaken = head.preTaken || [];
  t.quality = head.quality; t.lockFrame = head.lockFrame || 0;
  /* reset() 里"新局面"那一支:锁池前就纯黑的格子直接记账, 且不允许一次批量认多件 */
  if (t.preTaken.length || (head.quality && head.quality.darkCells <= 8)) {
    t.allowBulk = 0; for (const k of t.preTaken) { t.stable[k] = true; t.darkRun[k] = 2; } }
  t.firstT = {}; for (const k of t.preTaken) t.firstT[k] = 0;
  if (head.carry) { for (const f of CARRY) if (head.carry[f] !== undefined) t[f] = head.carry[f];
    if (head.carry.known) t.known = new Set(head.carry.known);
    if (t.unknownBy) t.unknownBy = t.unknownBy.map(u => { const a = [u[0], u[1]]; if (u.t != null) a.t = u.t; return a; }); }
  if (head.order) { t.fullOrder = head.order; t.orderSeat = n => { const x = head.order[Math.max(0, Math.min(n, head.order.length - 1))]; return [x < 5 ? "L" : "R", x % 5]; }; }
  return t;
}
/* 回放一条轨迹:每帧把观测源装上去, 跑 tracker.update(null)。onFrame(t, rec, state) 可选。 */
function replay(file, onFrame, mkTracker) {
  const { head, frames } = read(file); const t = (mkTracker || restore)(head); let miss = 0;
  for (const f of frames) { const src = new Frame(f, { poolKeys: head.poolKeys });
    R.setSource(src); t.cursor = f.cursor || null;
    let st = null; try { st = t.update(null); } finally { R.setSource(null); }
    miss += src.miss; if (onFrame) onFrame(t, f, st, src); }
  return { head, frames, tracker: t, miss };
}
module.exports = { Recorder, Frame, read, source, restore, replay, i8, un8, CARRY };
