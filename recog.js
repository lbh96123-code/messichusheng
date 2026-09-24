"use strict";
/* AD 选技读屏识别(纯 JS,Node 与浏览器通用)。移植自 plugin/state.py + tracker.py,算法逐条对应。
   图像统一为 {w,h,data:RGBA Uint8}。库数据(lib.bin/names.bin/meta.json/layout)由 init() 传入。 */
const T = 64;
let LIB = null;   // {keys, q:Int8Array(n*12288), scale:Float32Array(n), D}  —— int8 量化(见 tools/quantize_lib.py),25MB → 6.3MB
let NAMES = null; // {tpl:{heroKey:[{size,w,h,off}]}, bin:Uint8Array}
let META = null;  // {heroes:[{key,basics,ult}], cn:{hero,ab}}
let LAYOUT = null, LAYOUT0 = null, SC = 1;   // SC = 屏幕/设计(2560×1440)的比例;LAYOUT0 保留设计坐标(英雄名模板是按设计尺寸渲染的)
let BRIGHT = {};   // {key: 库图标(6% 内边距裁剪)的平均亮度},参考帧格子已变黑时的回退基准
let HBRIGHT = {};  // {heroKey: 英雄卡(横版原画中间正方形)平均亮度},同上用于英雄卡
let OWNER = {}, HERO_SKILLS = {}, HAS_ULT = {}, KIDX = {};
/* ---- 观测源(2.0 第 1 步) ----
   追踪层真正从画面里读的东西只有四样:棋盘每格的亮度统计、面板(有没有图标 + 边框)、面板某个槽的图标匹配、面板标题里的英雄名。
   把这四样收口成一个可替换的"源":
     · SRC = null   —— 线上, 直接读像素(守卫落空, 零开销、零行为改变);
     · 记录源       —— 一边读像素一边把读到的**观测**写进轨迹(worker 用);
     · 回放源       —— 从轨迹里取, 完全不碰像素(离线对比 1.x / 2.0 用)。
   这就是"日志里只有结论、没有观测"这个可测试性缺陷的根治点。 */
let SRC = null;
const setSource = s => { SRC = s; };
function init(o) {
  LIB = o.lib; LIB.D = LIB.q.length / LIB.keys.length; NAMES = o.names; META = o.meta; LAYOUT = o.layout; LAYOUT0 = JSON.parse(JSON.stringify(o.layout)); SC = 1; BRIGHT = o.bright || {}; HBRIGHT = o.heroBright || {};
  LIB.keys.forEach((k, i) => KIDX[k] = i);
  for (const h of META.heroes) { HERO_SKILLS[h.key] = h.basics.concat(h.ult ? [h.ult] : []); HAS_ULT[h.key] = !!h.ult;
    for (const a of h.basics) OWNER[a] = h.key; if (h.ult) OWNER[h.ult] = h.key; }
}
const cn = k => (k && k[0] === '?' ? '未知技能' : (META.cn.hero[k] || META.cn.ab[k] || k));
const sc = px => Math.round(px * 1.28 * SC);
/* 版式模板按 2560×1440 标定。别的分辨率按宽度等比缩放(16:9 才准);
   英雄名是位图模板不能缩放 —— 改成把标题区按设计尺寸重采样再匹配, 见 readHeroName。 */
function rescale(W, H) {
  /* 一律按**高度**定比例(游戏 UI 竖直方向等比), 水平方向:棋盘居中对齐, 左/右面板各自贴边。
     16:9 时这与"按宽度等比缩放"完全等价;带鱼屏(如 2560×1080)则是正确的模型 —— 但没有带鱼屏截图验证过,
     真要用请截一张开局图重新标定。 */
  const [W0, H0] = LAYOUT0.res, r = H / H0, ok = Math.abs(W / H - W0 / H0) < 0.02;
  SC = r; LAYOUT = JSON.parse(JSON.stringify(LAYOUT0)); LAYOUT.res = [W, H];
  const mapx = x => W / 2 + (x - W0 / 2) * r;
  for (const c of LAYOUT.board) { c.cx = mapx(c.cx); c.cy *= r; c.w *= r; }
  for (const side of ["L", "R"]) { const P = LAYOUT.panels[side];
    P.x0 = side === "L" ? Math.round(P.x0 * r) : Math.round(W - (W0 - P.x0) * r);
    P.y_top = Math.round(P.y_top * r); P.pitch = Math.round(P.pitch * r);
    P.slots = P.slots.map(([x, y, w]) => [Math.round(x * r), Math.round(y * r), Math.round(w * r)]);
    P.hero = P.hero.map(v => Math.round(v * r)); }
  TILE_PARAMS = null; GEO = null; PW = Math.round(419 * r); EB = Math.max(2, Math.round(6 * r)); SLOT_ADJ = { L: [0, 0, 0], R: [0, 0, 0] };
  return { scale: r, sixteenNine: ok };
}
let PW = 419, EB = 6;   // 面板宽 / 边框条宽(按分辨率缩放)
/* 技能槽的框和真实图标差一两像素、且普遍偏小(实测左侧 -2,0 右侧 -1,+1, 两侧都要放大 4):
   不校准平均匹配只有 0.62, 校准后 0.92 —— 之前那些"认不准"(0.2~0.5)基本都是这个造成的。
   面板是平的 UI, 同一侧所有槽偏移一样, 标定一次用一整局。 */
let SLOT_ADJ = { L: [0, 0, 0], R: [0, 0, 0] };
function slotBox(P, px0, py0, sx, sy, sw, side) { const a = SLOT_ADJ[side]; return [px0 + sx + a[0], py0 + sy + a[1], sw + a[2], sw + a[2]]; }
/* 用面板里已经认出的图标把偏移标定出来:在 ±3 像素 / 三种大小里找总分最高的一组 */
function calibratePanels(img, cands) {
  for (const side of ['L', 'R']) { const P = LAYOUT.panels[side], cells = [];
    for (let i = 0; i < 5; i++) { const px0 = P.x0, py0 = P.y_top + P.pitch * i;
      for (const [sx, sy, sw] of P.slots) { const b = [px0 + sx, py0 + sy, sw, sw];
        if (!slotFilled(img, b)) continue;
        const r = matchSkill(img, b, cands); cells.push({ px0, py0, sx, sy, sw, key: r.key, s: r.s1 }); } }
    /* 只拿认得最准的几个槽来标定, 而且只比它自己那一件 —— 全部槽 × 全部候选要 7 秒, 这样 0.3 秒 */
    const use = cells.filter(c => c.key && c.s > 0.35).sort((x, y) => y.s - x.s).slice(0, 5);
    if (use.length < 2) continue;
    let best = -9, bo = SLOT_ADJ[side];
    /* 粗搜一遍再在最优点附近细搜:范围比原来宽(尺寸原来只能往大调 0~6, 实测真值常在 8 上,
       而棋盘那边量出来"图标比框小"也是常事, 所以两头都得留), 次数反而比原来少 */
    const tryAdj = (dx, dy, ds) => { let sum = 0; for (const c of use) sum += matchSkill(img, [c.px0 + c.sx + dx, c.py0 + c.sy + dy, c.sw + ds, c.sw + ds], [c.key]).s1;
      if (sum > best) { best = sum; bo = [dx, dy, ds]; } };
    for (let dx = -4; dx <= 4; dx += 2) for (let dy = -4; dy <= 4; dy += 2) for (const ds of [-4, 0, 4, 8, 12]) tryAdj(dx, dy, ds);
    const c0 = bo.slice();
    for (let dx = c0[0] - 1; dx <= c0[0] + 1; dx++) for (let dy = c0[1] - 1; dy <= c0[1] + 1; dy++) for (const ds of [c0[2] - 2, c0[2], c0[2] + 2]) tryAdj(dx, dy, ds);
    SLOT_ADJ[side] = bo; }
  return SLOT_ADJ;
}
/* ---- 像素工具 ---- */
function cropResize(img, x, y, w, h, tw, th) {   // 面积平均缩放 → Float32 RGB
  const out = new Float32Array(tw * th * 3), d = img.data, W = img.w;
  for (let j = 0; j < th; j++) { const y0 = y + Math.floor(j * h / th), y1 = Math.max(y0 + 1, y + Math.floor((j + 1) * h / th));
    for (let i = 0; i < tw; i++) { const x0 = x + Math.floor(i * w / tw), x1 = Math.max(x0 + 1, x + Math.floor((i + 1) * w / tw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const p = (yy * W + xx) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2]; n++; }
      const o = (j * tw + i) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; } }
  return out;
}
function normVec(v) {   // 每通道去均值 + 整体单位化(与 python norm 一致)
  const n = v.length / 3; let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < n; i++) { mr += v[i * 3]; mg += v[i * 3 + 1]; mb += v[i * 3 + 2]; } mr /= n; mg /= n; mb /= n;
  let ss = 0; for (let i = 0; i < n; i++) { v[i * 3] -= mr; v[i * 3 + 1] -= mg; v[i * 3 + 2] -= mb; ss += v[i * 3] ** 2 + v[i * 3 + 1] ** 2 + v[i * 3 + 2] ** 2; }
  const inv = 1 / (Math.sqrt(ss) + 1e-6); for (let i = 0; i < v.length; i++) v[i] *= inv; return v;
}
const cellVec = (img, b) => { const m = Math.floor(Math.min(b[2], b[3]) * 0.06); return normVec(cropResize(img, b[0] + m, b[1] + m, b[2] - 2 * m, b[3] - 2 * m, T, T)); };
function scoreAll(vec) { const n = LIB.keys.length, out = new Float32Array(n), Q = LIB.q, SC2 = LIB.scale, D = LIB.D;
  for (let k = 0; k < n; k++) { let s = 0; const o = k * D; for (let i = 0; i < D; i++) s += Q[o + i] * vec[i]; out[k] = s * SC2[k]; } return out; }
const dot1 = (vec, i) => { const Q = LIB.q, D = LIB.D, o = i * D; let s = 0; for (let t = 0; t < D; t++) s += Q[o + t] * vec[t]; return s * LIB.scale[i]; };
function regionStats(img, x, y, w, h) {   // 均值(灰)/饱和度均值/拉普拉斯方差
  const d = img.data, W = img.w; let sum = 0, sat = 0, n = 0; const g = new Float64Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const p = ((y + j) * W + x + i) * 4, r = d[p], gg = d[p + 1], b = d[p + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b); sat += mx ? 255 * (mx - mn) / mx : 0; const gr = 0.299 * r + 0.587 * gg + 0.114 * b; g[j * w + i] = gr; sum += (r + gg + b) / 3; n++; }
  let ls = 0, ls2 = 0, ln = 0;
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) { const v = g[(j - 1) * w + i] + g[(j + 1) * w + i] + g[j * w + i - 1] + g[j * w + i + 1] - 4 * g[j * w + i]; ls += v; ls2 += v * v; ln++; }
  const lm = ls / ln; return { mean: sum / n, sat: sat / n, lap: ls2 / ln - lm * lm };
}
function meanBGR(img, x, y, w, h) { const d = img.data, W = img.w; let r = 0, g = 0, b = 0, n = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const p = ((y + j) * W + x + i) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2]; n++; } return [r / n, g / n, b / n]; }
/* ---- 格子粗检(HSV 阈值 + 闭/开运算 + 连通域) ---- */
function morph(mask, w, h, r, isMax) { const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = isMax ? 0 : 255; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= w) continue; const m = mask[y * w + xx]; v = isMax ? (m > v ? m : v) : (m < v ? m : v); } tmp[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = isMax ? 0 : 255; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; const m = tmp[yy * w + x]; v = isMax ? (m > v ? m : v) : (m < v ? m : v); } out[y * w + x] = v; }
  return out; }
let TILE_PARAMS = null;   // 上一次成功的 (ts,tv,ko),后续帧先试它
let LAST_SEARCH = 0;   // 上次做 27 组参数网格搜索的时间;没有棋盘时每帧都搜是 v0.1 风扇狂转的主因之一
function findTiles(img, region, lo = 55, hi = 130, allowSearch = true) {
  /* 在 1/2 分辨率上做阈值+形态学+连通域(像素量 1/4,半径减半),框再放大回原图坐标 */
  const [X0, Y0, X1, Y1] = region, w = (X1 - X0) >> 1, h = (Y1 - Y0) >> 1, d = img.data, W = img.w;
  const S = new Uint8Array(w * h), V = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const p = ((Y0 + 2 * j + dy) * W + X0 + 2 * i + dx) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2]; }
    r >>= 2; g >>= 2; b >>= 2; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); V[j * w + i] = mx; S[j * w + i] = mx ? Math.round(255 * (mx - mn) / mx) : 0; }
  const run = (ts, tv, ko) => {
    let m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) m[i] = (S[i] > ts || V[i] > tv) ? 255 : 0;
    const r1 = 2, r2 = Math.max(1, Math.round((ko - 1) / 4));
    m = morph(morph(m, w, h, r1, true), w, h, r1, false); m = morph(morph(m, w, h, r2, false), w, h, r2, true);
    const out = [], seen = new Uint8Array(w * h), st = new Int32Array(w * h);
    for (let s0 = 0; s0 < w * h; s0++) { if (!m[s0] || seen[s0]) continue; let sp = 0; st[sp++] = s0; seen[s0] = 1; let bx0 = w, by0 = h, bx1 = 0, by1 = 0, a = 0;
      while (sp) { const q = st[--sp], qx = q % w, qy = (q / w) | 0; a++; if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
        if (qx + 1 < w) { const ni = q + 1; if (m[ni] && !seen[ni]) { seen[ni] = 1; st[sp++] = ni; } }
        if (qx > 0) { const ni = q - 1; if (m[ni] && !seen[ni]) { seen[ni] = 1; st[sp++] = ni; } }
        if (qy + 1 < h) { const ni = q + w; if (m[ni] && !seen[ni]) { seen[ni] = 1; st[sp++] = ni; } }
        if (qy > 0) { const ni = q - w; if (m[ni] && !seen[ni]) { seen[ni] = 1; st[sp++] = ni; } } }
      const bw = (bx1 - bx0 + 1) * 2, bh = (by1 - by0 + 1) * 2;
      if (bw >= lo && bw <= hi && bh >= lo && bh <= hi && a * 4 > 0.55 * bw * bh && bw / bh >= 0.8 && bw / bh <= 1.25) out.push([bx0 * 2 + X0, by0 * 2 + Y0, bw, bh]); }
    return out; };
  let cachedOut = null;
  if (TILE_PARAMS) { cachedOut = run(...TILE_PARAMS); if (cachedOut.length >= 52 && cachedOut.length <= 62) return cachedOut; }
  if (cachedOut && (!allowSearch || Date.now() - LAST_SEARCH < 3000)) return cachedOut;   // 不许搜/刚搜过:就用缓存参数的结果
  LAST_SEARCH = Date.now();
  let best = null, bp = null;
  for (const ts of [50, 70, 90]) for (const tv of [100, 130, 160]) for (const ko of [15, 21, 27]) { const out = run(ts, tv, ko);
    if (!best || Math.abs(out.length - 60) < Math.abs(best.length - 60)) { best = out; bp = [ts, tv, ko]; } }
  TILE_PARAMS = bp; return best;
}
/* 每行格子的默认几何(宽/高 相对版式格宽), 标定之前用。取自 18 张 2560 + 1 张 1080p 真实开局帧:
   3D 透视让下半区的格子明显扁(行 2/3 高只有 0.81), 所以不能用正方形补。行 4 在 09-12 前后变过(游戏更新), 所以还要按图标标定。 */
const ROW_WH = [[0.97, 0.99], [0.99, 0.98], [0.97, 0.82], [0.96, 0.82], [0.96, 0.86], [0.95, 0.86], [0.96, 0.92], [0.95, 0.91]];
const HERO_ADJ = [0.05, 0.025, 0, 0];   // 英雄卡比同行技能格宽 ~5%、高 ~2.5%(167 张英雄卡的中位数)。图标库里没有英雄头像, 英雄卡没法按图标标定
let GEO = null;   // 逐行几何(按图标标定): { [row]: {W, H, DX, DY} }, W/H 相对版式格宽, DX/DY 是相对整体偏移的像素。rescale 时清空
const rowDefault = r => { const d = ROW_WH[r] || [1, 1]; return { W: d[0], H: d[1], DX: 0, DY: 0 }; };
const cellBox = (c, p, ox, oy) => { const a = c.role === "hero" ? HERO_ADJ : [0, 0, 0, 0], bw = c.w * (p.W + a[0]), bh = c.w * (p.H + a[1]), cx = c.cx + ox + p.DX + a[2], cy = c.cy + oy + p.DY + a[3];
  return [Math.round(cx - bw / 2), Math.round(cy - bh / 2), Math.round(bw), Math.round(bh)]; };
/* 棋盘对齐。**检出的框只用来求整体偏移, 不当比对框。**
   以前检出一块就拿它的外接矩形去比对图标, 只要这块连上了旁边的东西, 框就跟着歪。实测:
     · 1080p "终极技能"行和上方文字标签连成一块, 74×90(格子 62×62)→ 匹配 0.12(v1.10 的"最长边 >1.3 倍不用"补丁);
     · 2560(4K 缩到 2560 同样)"标准技能"区左上/右上的黄色 L 形角框和格 13/格 18 连成一块:72×78 / 84×78, 中心偏 10px ——
       17 张历史开局帧里 15/13 张中招, 1.3 倍补丁拦不住。09-13 那局格 18 是育母蜘蛛"麻痹之咬", 歪框上 0.14(正位 0.64),
       那一行被祈求者(720 种排列)以 0.027 反超, 连续 13 次拒绝、三次重启都锁不上;
     · 行 4 大半格子的检出框被撑高到 0.91, 真实只有 0.82~0.86 —— 按检出框比对, 这几格一直只有 0.4~0.6(正位 0.7~0.9)。
   "每行取检出框中位数"也试过:多数格子一起被撑歪时中位数照样歪(1080p 大招行 5 格因此变成"未知")。
   所以现在:检出只给整体偏移(全体检出框中心的中位数, 个别歪框改变不了);每行的宽/高/偏移按图标标定(calibrateGeometry), 没标定前用默认表。
   dev = 检出框和最终框差得多的格子(尺寸差 >8% 或中心差 >5px), 只用于日志和测试。 */
function detectBoard(img, allowSearch) {
  const det = findTiles(img, [Math.round(img.w * 0.28), sc(140), Math.round(img.w * 0.72), sc(900)], Math.round(55 * SC), Math.round(130 * SC), allowSearch), cells = LAYOUT.board, raw = {}, rawD = {}, dx = [], dy = [];
  for (const [x, y, w, h] of det) { const cx = x + w / 2, cy = y + h / 2; let j = -1, bd = 1e9;
    cells.forEach((c, i) => { const dd = Math.abs(c.cx - cx) + Math.abs(c.cy - cy); if (dd < bd) { bd = dd; j = i; } });
    if (j < 0 || Math.abs(cells[j].cx - cx) >= 30 * SC || Math.abs(cells[j].cy - cy) >= 30 * SC || (raw[j] && rawD[j] <= bd)) continue;
    raw[j] = [x, y, w, h]; rawD[j] = bd; }
  const med = a => { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q); return s[(s.length / 2) | 0]; };
  for (const j in raw) { const [x, y, w, h] = raw[j]; dx.push(x + w / 2 - cells[j].cx); dy.push(y + h / 2 - cells[j].cy); }
  return { raw, ox: med(dx), oy: med(dy), nd: det.length };
}
/* geo:用哪套逐行几何。锁池后追踪要传**这次锁池时的那套**(pool.align.G) —— 全局 GEO 会被之后的重锁尝试改掉(重锁失败时沿用原池子继续追踪,
   框要和原池子的 boxAdj 对得上)。不传 = 当前全局 GEO(没标定过就是默认表)。 */
function boxesFor(raw, ox, oy, geo = GEO) { const cells = LAYOUT.board, boxes = {}, dev = [];
  cells.forEach((c, j) => { const b = boxes[j] = cellBox(c, (geo && geo[c.row]) || rowDefault(c.row), ox, oy), d = raw[j];
    if (d && (Math.abs(d[2] - b[2]) > 0.08 * c.w || Math.abs(d[3] - b[3]) > 0.08 * c.w ||
      Math.hypot(d[0] + d[2] / 2 - b[0] - b[2] / 2, d[1] + d[3] / 2 - b[1] - b[3] / 2) > 5 * SC)) dev.push({ cell: j, raw: d, box: b }); });
  return { boxes, dev }; }
function alignBoard(img, allowSearch = true, geo = GEO) { const d = detectBoard(img, allowSearch), { boxes, dev } = boxesFor(d.raw, d.ox, d.oy, geo);
  return { boxes, ox: d.ox, oy: d.oy, nd: d.nd, raw: d.raw, detected: new Set(Object.keys(d.raw).map(Number)), dev }; }
/* 按图标标定逐行几何(锁池时调用, 结果存进 GEO, 之后每帧对齐都用它)。
   同一行的亮格(均值 ≥60)共用一组 {宽, 高, 左右, 上下}, 目标 = 这几格"各自最像的图标"分数的平均, 逐个参数网格搜两轮。
   · 不认标签:每格只在它当前全库前 8 名里取最高 —— 不预设是谁的技能, 也就不会朝认错的技能去贴(refineBoxes 的锚点问题);
   · 整行投票:几格一起定一组参数, 个别格子认错、被遮挡带不偏;不足 3 个亮格的行不标定, 沿用上次/默认;
   · 标定后平均分 <0.55 的行不采用(淡入动画、非棋盘画面)。
   开销:每次评估只做候选点积(0.13ms/候选 vs 全库 8ms), 8 行合计 ~1s。 */
function calibrateGeometry(img, al) {
  const cells = LAYOUT.board, geo = {}, info = {};
  for (const r of new Set(cells.map(c => c.row))) { const p0 = (GEO && GEO[r]) || rowDefault(r);
    const js = cells.map((c, j) => j).filter(j => cells[j].row === r && cells[j].role !== "hero" && cellStats(img, al.boxes[j]).mean >= 60);
    if (js.length < 3) { geo[r] = p0; info[r] = { n: js.length }; continue; }
    const cand = {}; for (const j of js) { const s = scoreAll(cellVec(img, al.boxes[j])); cand[j] = Array.from(s.keys()).sort((a, b) => s[b] - s[a]).slice(0, 8); }
    const f = p => { let t = 0; for (const j of js) { const v = cellVec(img, cellBox(cells[j], p, al.ox, al.oy)); let m = -9; for (const i of cand[j]) { const x = dot1(v, i); if (x > m) m = x; } t += m; } return t / js.length; };
    let p = { ...p0 }, best = f(p); const f0 = best;
    const axes = [["H", 0.03, 4, 0.7, 1.1], ["DY", 2 * SC, 4, -10 * SC, 10 * SC], ["W", 0.03, 2, 0.85, 1.1], ["DX", 2 * SC, 3, -10 * SC, 10 * SC]];
    for (let pass = 0; pass < 2; pass++) for (const [k, st, n, lo, hi] of axes) { const base = p[k];
      for (let i = -n; i <= n; i++) { const v = base + i * st; if (!i || v < lo || v > hi) continue; const q = { ...p, [k]: v }, s = f(q); if (s > best + 1e-4) { best = s; p = q; } } }
    const ok = best >= 0.55; geo[r] = ok ? p : p0; info[r] = { n: js.length, before: f0, after: best, ok }; }
  GEO = geo; return info;
}
/* ---- 廉价检测(每帧都跑,不做对齐/匹配) ---- */
const cellBright = (img, b) => { const m = Math.floor(b[2] * 0.2); const [r, g, bb] = meanBGR(img, b[0] + m, b[1] + m, b[2] - 2 * m, b[3] - 2 * m); return (r + g + bb) / 3; };
/* 把格子内圈切成九宫格,返回 {mean, max=最亮的那一格}。
   关键区别:**被选走的格子是整块均匀变暗**,九格全暗;而鼠标/提示框只挡住一部分,剩下的格子还是亮的 →
   只看平均值会被挡一半的格子骗过去,看"最亮的那一格"就骗不过去。 */
function cellStats(img, b) {
  if (SRC && SRC.cellStats && b && b.cell != null) return SRC.cellStats(b.cell);
  const m = Math.floor(b[2] * 0.2), x = b[0] + m, y = b[1] + m, w = b[2] - 2 * m, h = b[3] - 2 * m;
  if (w < 3 || h < 3) { const v = cellBright(img, b); return { mean: v, max: v, sat: 0 }; }
  const d = img.data, W = img.w; let sum = 0, n = 0, mx = 0, sat = 0, ns = 0;
  for (let by = 0; by < 3; by++) for (let bx = 0; bx < 3; bx++) {
    const x0 = x + Math.floor(bx * w / 3), x1 = x + Math.floor((bx + 1) * w / 3), y0 = y + Math.floor(by * h / 3), y1 = y + Math.floor((by + 1) * h / 3);
    let s = 0, c = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const p = (yy * W + xx) * 4, r = d[p], g = d[p + 1], bl = d[p + 2]; s += (r + g + bl) / 3; c++;
      const hi = r > g ? (r > bl ? r : bl) : (g > bl ? g : bl), lo = r < g ? (r < bl ? r : bl) : (g < bl ? g : bl); if (hi >= 20) { sat += (hi - lo) / hi; ns++; } }
    if (!c) continue; const v = s / c; if (v > mx) mx = v; sum += s; n += c; }
  return { mean: n ? sum / n : 0, max: mx, sat: ns ? sat / ns : 0 };
}
/* 面板槽里到底有没有图标 —— 以前只看"九宫格里最亮的一格 <24 就算空"。
   问题:空槽底板本身带渐变和高光, 画面一亮(转场/技能特效/翻牌动画)就会亮到 30~45,
   整排空槽被当成图标、再硬配成池子里的技能(实测 720 个真空槽里误判 102 个, 分数能到 0.56),
   这就是日志里"右边 4 个面板凭空各多 4 个图标、一口气记了 16 手"的根。
   空底板是**平的**, 图标有细节, 所以改成看纹理(拉普拉斯标准差):
     · 门槛取 10 —— 图库 513 个图标换算到游戏里(实测游戏里的纹理是图库的 1.35~1.58 倍, 取 1.35 保守)最低就是 10, 一个不漏;
     · 真空槽误收从 102 降到 11, 剩下的集中在一帧转场画面, 另有"手数不能多于棋盘暗格数+1"兜底。
   很亮的槽(均值 60+, 空槽实测最高才 45)不用看纹理 —— 免得大片纯色的图标(如风暴之拳)被当成空的。 */
function slotFilled(img, b) { if (SRC && SRC.slotFilled && b && b.slot) return SRC.slotFilled(b.slot);
  const g = slotSignal(img, b); return g.tiny ? g.mean >= 30 : (g.mean >= 60 || g.lap >= 10); }
/* 判据背后的两个原始量:均值(亮度)与拉普拉斯标准差(纹理)。分出来是为了能**记录观测**而不只是记录结论 ——
   2.0 想换一条判据(比如"跟这个槽自己空着时的样子比")时, 拿的是同一批原始量, 不用重跑像素。 */
function slotSignal(img, b) {
  const m = Math.floor(b[2] * 0.2), x = b[0] + m, y = b[1] + m, w = b[2] - 2 * m, h = b[3] - 2 * m;
  if (w < 5 || h < 5) return { mean: cellBright(img, b), lap: 0, tiny: true };
  const d = img.data, W = img.w, g = new Float64Array(w * h); let sum = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const p = ((y + j) * W + x + i) * 4, r = d[p], gg = d[p + 1], bl = d[p + 2];
    g[j * w + i] = 0.299 * r + 0.587 * gg + 0.114 * bl; sum += (r + gg + bl) / 3; }
  const mean = sum / (w * h);
  let ls = 0, ls2 = 0, ln = 0;
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const v = g[(j - 1) * w + i] + g[(j + 1) * w + i] + g[j * w + i - 1] + g[j * w + i + 1] - 4 * g[j * w + i]; ls += v; ls2 += v * v; ln++; }
  return { mean, lap: ln ? Math.sqrt(Math.max(0, ls2 / ln - (ls / ln) ** 2)) : 0, tiny: false };
}
/* 判格子状态 —— **跟它自己开局时的样子比**, 三选一(用户的思路:被选走后的样子是固定的):
     'N' 没变:亮度还在参考的 0.6 倍以上
     'T' 被选走:技能 = 同一张图去色压暗(实测 风暴之拳 亮度 0.14×、饱和度 0.27→0.12);英雄卡 = 直接变黑(斯温卡 0.08×)。
         要求整格均匀(九宫格最亮一格也暗), 技能格还要求"颜色被抽掉"(饱和度掉到参考的 0.65 以下;参考本来就灰的图标不看这条)
     'O' 看不清:两头都不像 —— 半透明技能介绍框(实测只暗到 0.62~0.9 倍、颜色还在)、鼠标挡一角、转场动画……
         **维持原判, 不改任何状态**。以前遮挡只能靠"同一帧多黑好几格"去猜, 现在遮挡本身就被认成"看不清"。 */
function cellState(img, box, ref, refSat, isHero) {
  const st = cellStats(img, box), r = st.mean / Math.max(ref, 8), mr = st.max / Math.max(ref, 8);
  if (st.mean < 10 && st.max < 20) return 'T';                                          // 纯黑:只会是被选走(英雄卡)
  /* 带反光的"被选走":棋盘是 3D 的, 左下角那几格(实测 09-11 1080p 截图 格 44/52 英雄卡、37/45/53 技能)选走后是一块**有高光的光面黑**,
     平均亮度 35~67 —— 影魔原画本来就暗(~46), 选走后反而更"亮", 按亮度永远判成"没变", 整局一直推荐已被选走的影魔。
     能认出它的只有**颜色没了**:饱和度 0.03~0.12(影魔原画 0.54、英雄原画实测最灰的也有 0.18);纹理不行(高光边缘本身就是纹理, 实测 6.1→5.7 没降)。
     半透明介绍框底下颜色还在(实测只暗到 0.62~0.9×、颜色保留), 白字会把最亮一格顶上去 —— 所以要"颜色掉到参考的 35% 以下 + 不亮 + 没有亮块"。 */
  if (refSat >= (isHero ? 0.15 : 0.25) && st.sat < 0.15 && st.sat < (isHero ? 0.5 : 0.35) * refSat && st.mean < 120 && st.max < 150 && r < 1.8) return 'T';
  /* 英雄卡"近乎全黑":1080p 下选走的卡不像 1440p 那样纯黑(斯温卡 4/8), 实测 亮 10~24 / 最亮一格 14~35 / 饱和 0.09~0.21。
     原画暗的英雄(参考亮度 ~50)按比例 r<0.22 过不了。英雄原画实测最暗的也有 31/51 且颜色很浓(潮汐猎人 饱和 0.91) */
  if (isHero && st.mean < 26 && st.max < 40 && st.sat < 0.25) return 'T';
  if (r >= 0.6) return 'N';
  if (isHero) return (r < 0.22 && mr < 0.4) ? 'T' : 'O';
  const desat = refSat < 0.2 || st.sat < 0.65 * refSat;
  /* 很暗且均匀(平均 <0.2×、最亮一格 <0.3×)直接算选走:这么暗时饱和度只剩噪声 —— 锚击/恐怖波动本身是淡色图标(饱和 0.24~0.26),
     选走后 1080p 实测 0.14×/0.18× 但饱和还读 0.19~0.20, 过不了"颜色掉到 0.65×"那条, 一直"看不清"。锚击因此开局没记上, 引出莉娜/复仇之魂对调。
     介绍框底下只暗到 0.62~0.9×, 鼠标只挡一角(最亮一格还亮), 都进不了这条 */
  return ((r < 0.32 && mr < 0.5 && desat) || (r < 0.2 && mr < 0.3)) ? 'T' : 'O';
}
/* 快通道(1/8 小图)只看亮度+均匀度:小图上颜色会被平均掉, 饱和度不可靠;完整识别那一路会用上饱和度复核 */
const isDarkCell = (img, box, ref) => { const st = cellStats(img, box); const r = st.mean / Math.max(ref, 8), mr = st.max / Math.max(ref, 8);
  return (st.mean < 10 && st.max < 20) || (r < 0.32 && mr < 0.5); };
/* 棋盘在不在:按版式格子中心 40% 区域取亮度(容忍 ±20px 位移),格子间隙应是暗背景。img 可以是缩小图(按宽度比例缩放坐标)。
   返回 {bright:亮格数(>30), dark:暗格数, gapDark:间隙暗的比例, k:缩放}。有棋盘判据:bright>=8 且 gapDark>=0.75;新一局靠暗格数骤降/棋盘签名变化判,不靠绝对亮格数(有的图标本身就暗)。 */
/* v1.37:本帧最亮格低于「这局见过的最亮」这个比例 → 判定画面已经不是选技棋盘(见 observe) */
const OFF_RATIO = +process.env.AD_OFF_RATIO || 0.72;
function quickPresence(img) {
  const k = img.w / LAYOUT.res[0]; let bright = 0, dark = 0, gapOk = 0, gapN = 0;
  for (const c of LAYOUT.board) { const w = c.w * k, x = Math.round((c.cx - c.w * 0.2) * k), y = Math.round((c.cy - c.w * 0.2) * k), s = Math.max(2, Math.round(w * 0.4));
    if (x < 0 || y < 0 || x + s >= img.w || y + s >= img.h) continue;
    const [r, g, b] = meanBGR(img, x, y, s, s); const v = (r + g + b) / 3; if (v > 30) bright++; else dark++;
    if (c.col > 0) { const gx = Math.round((c.cx - c.w / 2 - 12 * SC) * k), gy = Math.round((c.cy - c.w * 0.2) * k), gw = Math.max(1, Math.round(EB * k));   // 左边间隙
      if (gx >= 0 && gy + s < img.h) { const [r2, g2, b2] = meanBGR(img, gx, gy, gw, s); gapN++; if ((r2 + g2 + b2) / 3 < 70) gapOk++; } } }
  return { bright, dark, gapDark: gapN ? gapOk / gapN : 0, k };
}
/* 帧签名:60 格亮度 + 10 面板边框亮度 + 40 面板槽亮度。两帧签名接近 → 画面对我们关心的部分没变,跳过重识别 */
function quickSig(img, boxes) {
  const out = new Float32Array(60 + 10 + 40); let n = 0;
  LAYOUT.board.forEach((c, j) => { const b = boxes && boxes[j] ? boxes[j] : [Math.round(c.cx - c.w / 2), Math.round(c.cy - c.w / 2), Math.round(c.w), Math.round(c.w)]; out[n++] = cellBright(img, b); });
  for (const side of ['L', 'R']) { const P = LAYOUT.panels[side];
    for (let i = 0; i < 5; i++) { const px0 = P.x0, py0 = P.y_top + P.pitch * i, pw = PW, ph = P.pitch;
      const t = meanBGR(img, px0, py0, pw, EB), l = meanBGR(img, px0, py0, EB, ph); out[n++] = (t[0] + t[1] + t[2] + l[0] + l[1] + l[2]) / 6;
      for (const [sx, sy, sw] of P.slots) { const m = meanBGR(img, px0 + sx, py0 + sy, sw, sw); out[n++] = (m[0] + m[1] + m[2]) / 3; } } }
  return out;
}
const boardSig = (img, boxes) => quickSig(img, boxes).slice(0, 60);
/* 快通道:只量 60 格亮度判"谁被选走了"。img 可以是半分辨率(按宽度比例缩放 boxes),refB 是开局参考亮度(亮度与缩放无关)。
   返回 {dark:Set(已黑的 key/hero:英雄), n} —— 不做对齐、不做图标匹配,一帧几毫秒。 */
function fastDark(img, pool, boxes, refB) {
  const k = img.w / LAYOUT.res[0], dark = new Set();
  const at = (b, ref) => { const x = Math.round(b[0] * k), y = Math.round(b[1] * k), w = Math.round(b[2] * k), h = Math.round(b[3] * k);
    if (x < 0 || y < 0 || x + w >= img.w || y + h >= img.h || w < 6 || h < 6) return false; return isDarkCell(img, [x, y, w, h], ref); };
  for (const r of pool.skills) if (at(boxes[r.cell], refB[r.cell])) dark.add(r.key);
  for (const hb of pool.heroBoxes) if (at(boxes[hb.cell], refB[hb.cell])) dark.add('hero:' + hb.hero);
  return dark;
}
function sigDiff(a, b) { if (!a || !b || a.length !== b.length) return 999; let m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; }
/* ---- 池子:按行认英雄 ---- */
function permutations(m, n) { const out = []; const rec = (cur, used) => { if (cur.length === n) { out.push(cur.slice()); return; } for (let i = 0; i < m; i++) if (!used[i]) { used[i] = 1; cur.push(i); rec(cur, used); cur.pop(); used[i] = 0; } }; rec([], new Array(m).fill(0)); return out; }
const PERM = {};
/* 已知技能不足 3 个的英雄(比如新版本加了技能而我们数据里没有的水晶室女),那一行第 3 格记为"未知技能",
   给一个中性分 UNK —— 介于"认对"(~0.7)和"认错"(~0.1~0.3)之间。
   以前是硬凑满 3 个(把大招塞进普通技能格, 相关系数 -0.26), 结果和另一个认错的英雄同分, 两台机器各认各的。 */
const UNK = 0.35, ULT_MIN = 0.25;
function readPool(img) {
  const al0 = alignBoard(img), geo = calibrateGeometry(img, al0), { boxes, dev } = boxesFor(al0.raw, al0.ox, al0.oy), { ox, oy, nd } = al0, cells = LAYOUT.board, S = {};
  cells.forEach((c, j) => { S[j] = scoreAll(cellVec(img, boxes[j])); });
  /* 认英雄用的分数 V:**全黑的格子(已被选走)不参与认英雄。** 黑格上的匹配分是噪声, 以前靠它碰巧站对边 ——
     09-13 那局行 4 左格 29 火焰风暴亮着 0.87(剃刀的技能只有 0.43), 格 30/31 全黑(亮度 14/8), 框改对之后剃刀靠两个黑格的噪声以 0.017 反超孽主。
     黑格对每个英雄都记 UNK(和"只认得 2 个技能"的未知格同一口径), 只留 1% 原分数给同一英雄内部决定这格记成哪个技能。 */
  const V = {}; cells.forEach((c, j) => { V[j] = isBlack(cellStats(img, boxes[j])) ? S[j].map(v => UNK + 0.01 * v) : S[j]; });
  const groups = {};
  cells.forEach((c, j) => { if (c.role === 'skill') { const g = c.row + (c.col < 4 ? 'L' : 'R'); (groups[g] = groups[g] || []).push(j); } });
  const rowres = [];
  for (const g in groups) { const js = groups[g], cand = [];
    for (const h in HERO_SKILLS) {
      /* 行里只能是普通技能 —— 以前把大招也放进候选排列里, 等于允许"大招出现在普通技能格" */
      const sk = HERO_SKILLS[h].filter(k => k in KIDX && k !== (HAS_ULT[h] ? HERO_SKILLS[h][HERO_SKILLS[h].length - 1] : null));
      if (sk.length < 2) continue;
      let bt = -9, bks = null;
      if (sk.length >= 3) { const perms = PERM[sk.length] = PERM[sk.length] || permutations(sk.length, 3);
        for (const p of perms) { let t = 0; for (let i = 0; i < 3; i++) t += V[js[i]][KIDX[sk[p[i]]]]; if (t > bt) { bt = t; bks = p.map(i => sk[i]); } } }
      else {   // 只认得 2 个:枚举哪一格是未知 × 两个技能的摆法
        for (let u = 0; u < 3; u++) { const o = [0, 1, 2].filter(i => i !== u);
          for (const [a, b] of [[0, 1], [1, 0]]) { const t = V[js[o[0]]][KIDX[sk[a]]] + V[js[o[1]]][KIDX[sk[b]]] + UNK;
            if (t > bt) { bt = t; bks = []; bks[o[0]] = sk[a]; bks[o[1]] = sk[b]; bks[u] = null; } } } }
      cand.push([bt, h, bks]); }
    cand.sort((a, b) => b[0] - a[0]); rowres.push({ js, best: cand[0], second: cand[1] }); }
  rowres.sort((a, b) => b.best[0] - a.best[0]);
  const poolHeroes = [], skills = [], used = new Set();
  for (const r of rowres) { const [t, h, ks] = r.best; if (used.has(h)) continue; used.add(h); poolHeroes.push(h);
    r.js.forEach((j, i) => skills.push(ks[i] ? { cell: j, box: boxes[j], key: ks[i], hero: h, s1: S[j][KIDX[ks[i]]], rowScore: t / 3, rowMargin: (t - r.second[0]) / 3, rival: r.second[1] }
                                             : { cell: j, box: boxes[j], key: '?unk:' + j, hero: h, unknown: true, s1: UNK, rowScore: t / 3, rowMargin: (t - r.second[0]) / 3, rival: r.second[1] })); }
  const ultIds = cells.map((c, j) => c.role === 'ult' ? j : -1).filter(j => j >= 0), takenKeys = new Set(skills.map(r => r.key)), pairs = [];
  for (const j of ultIds) for (const h of poolHeroes) { const opts = HAS_ULT[h] ? [HERO_SKILLS[h][HERO_SKILLS[h].length - 1]] : HERO_SKILLS[h].filter(k => !takenKeys.has(k));
    for (const k of opts) if (k in KIDX) pairs.push([S[j][KIDX[k]], j, h, k]); }
  pairs.sort((a, b) => b[0] - a[0]); const dj = new Set(), dh = new Set();
  for (const [sc1, j, h, k] of pairs) { if (dj.has(j) || dh.has(h) || sc1 < ULT_MIN) continue; dj.add(j); dh.add(h); skills.push({ cell: j, box: boxes[j], key: k, hero: h, s1: sc1, ultslot: true }); }
  /* 剩下的大招格, 按排除法配给剩下的"有大招"的英雄:12 个大招格就是池子里 12 个英雄的大招(除非某英雄在 AD 里没有大招, 那时格子是别人的技能补位)。
     09-11 1080p 那局虚空假面/影魔/魅惑魔女三个大招格分数都 <0.25 没配上, 其中一格还被当成狙击手"暗杀"补位 ——
     结果时间结界/不可侵犯被拿走时引擎不知道是什么。现在:分数再低, 只要不明显更像别的图标(全库最像的领先不到 0.3), 就按排除法配上。 */
  const gbest0 = j => { const a = S[j]; let bv = -9; for (let i = 0; i < a.length; i++) if (a[i] > bv) bv = a[i]; return bv; };
  for (const [sc1, j, h, k] of pairs) { if (dj.has(j) || dh.has(h) || !HAS_ULT[h] || sc1 < 0.05 || gbest0(j) - sc1 >= 0.3) continue;
    dj.add(j); dh.add(h); skills.push({ cell: j, box: boxes[j], key: k, hero: h, s1: sc1, ultslot: true, byElim: true }); }
  /* 棋盘上每一格都要跟踪明暗(有人拿走"未知技能"也是一手, 漏数会把选人顺序整体带歪), 认不出的格子记占位符 */
  for (const j of ultIds) if (!dj.has(j)) skills.push({ cell: j, box: boxes[j], key: '?unk:' + j, hero: null, unknown: true, s1: 0, ultslot: true });
  /* **以图标为准**:技能不够的英雄会由别的英雄的技能补位(实测水晶室女第 3 格 = 天穹守望者的"磁场" 0.78,
     大招区两个空位 = 敌法师"法力虚空" 0.92 / 克林克兹"骨隐步" 0.71)。所以每格都拿全库最像的那张图标来核:
       · 占位的"未知"格:全库最像的 ≥ FILL_MIN 就认它;
       · 已按英雄配上的格:全库最像的明显更好(高出 FILL_GAP 且本身 ≥ FILL_ABS)才改判 ——
         分数接近时仍信"同一行属同一英雄"的约束, 它能纠正相似图标的误认。 */
  /* FILL_LEAD:要**覆盖行约束**的改判, 全库第一还必须明显领先它自己的第二名。
     没有这一条时的真机事故(09-12, 两台机器同一局):同一格 x 机贴框贴到 72×62 认出 超负荷 0.84,
     y 机贴到 84×78(把边框裁了进来)→ 全库第一翻成 真空 0.73, 改判覆盖了行约束 —— 两人池子不同,
     推荐随之全不一样。而那个 0.73 在全库里只领先第二名 0.088, 根本就是"没认出来"。
     真机 14 次改判实测分得很开:合法补位(原本是未知格)领先 0.408~0.590, 覆盖 OMG 变体的 0.207/0.293,
     而五次错误改判全在 0.012~0.088。门槛取 0.15。
     只卡"覆盖"这一支 —— 原本就是未知格的补位没有竞争对手, 不受这条约束。 */
  const FILL_MIN = 0.55, FILL_GAP = 0.2, FILL_ABS = 0.6, FILL_LEAD = 0.15, usedKeys = new Set(skills.filter(r => !r.unknown).map(r => r.key));
  const gbest = j => { const a = S[j]; let bi = 0, bv = -9, sv = -9; for (let i = 0; i < a.length; i++) { if (a[i] > bv) { sv = bv; bv = a[i]; bi = i; } else if (a[i] > sv) sv = a[i]; } return [LIB.keys[bi], bv, sv]; };
  for (const r of skills) { const [gk, gv, gv2] = gbest(r.cell); if (usedKeys.has(gk) && gk !== r.key) continue;
    if (r.unknown ? gv >= FILL_MIN : (gk !== r.key && gv >= FILL_ABS && gv - r.s1 >= FILL_GAP && gv - gv2 >= FILL_LEAD)) {
      if (!r.unknown) usedKeys.delete(r.key);
      r.was = r.unknown ? '未知' : r.key; r.key = gk; r.s1 = gv; r.unknown = false; r.filler = true; usedKeys.add(gk); } }
  const heroBoxes = cells.map((c, j) => c.role === 'hero' ? { cell: j, box: boxes[j] } : null).filter(Boolean);
  // 英雄卡身份:同一行技能是谁的
  for (const hb of heroBoxes) { const c = cells[hb.cell]; const side = c.col < 4 ? 'L' : 'R'; const r = skills.find(s => !s.ultslot && cells[s.cell].row === c.row && ((cells[s.cell].col < 4 ? 'L' : 'R') === side)); hb.hero = r ? r.hero : null; }
  return { poolHeroes, skills, heroBoxes, align: { ox, oy, nd, dev, geo, G: GEO } };   // G:这次锁池用的逐行几何, 追踪时每帧对齐用它
}
/* 锁池时把每个格子的框"贴"到图标上:棋盘是 3D 梯形, 格子不是正方形, 各行大小/位置都不同,
   固定版式框会连边框和背景一起裁进来 —— 实测平均匹配 0.77, 逐格贴准后 0.88(最差的 0.15→0.64)。
   棋盘整局不动, 所以只在锁池时算一次, 之后每帧按相同的偏移量用。
   办法:拿这一格已经认出的图标当模板, 先粗搜(±4 像素 / 三种大小), 再在最好那点附近细搜 ±1。 */
function refineBoxes(img, pool) {
  const adj = {};
  for (const r of pool.skills) { if (r.unknown || !(r.key in KIDX) || r.s1 >= 0.85) continue; const b = r.box;   // 本来就贴得准的跳过
    let best = -9, bo = [0, 0, 0, 0];
    const tryBox = (dx, dy, dw, dh) => { const v = matchSkill(img, [b[0] + dx, b[1] + dy, b[2] + dw, b[3] + dh], [r.key]).s1;
      if (v > best) { best = v; bo = [dx, dy, dw, dh]; } };
    for (let dx = -4; dx <= 4; dx += 4) for (let dy = -4; dy <= 4; dy += 4) for (const d of [0, 4]) tryBox(dx, dy, d, d);
    const c = bo.slice();
    for (let dx = c[0] - 2; dx <= c[0] + 2; dx += 2) for (let dy = c[1] - 2; dy <= c[1] + 2; dy += 2)
      for (const dw of [c[2] - 2, c[2], c[2] + 2]) for (const dh of [c[3] - 2, c[3], c[3] + 2]) tryBox(dx, dy, dw, dh);
    if (best > r.s1) { adj[r.cell] = bo; r.box = [b[0] + bo[0], b[1] + bo[1], b[2] + bo[2], b[3] + bo[3]]; r.s1 = best; } }
  /* 认不出的格子也要贴一次 —— 原来直接跳过(r.unknown continue), 而"认不出"往往**恰恰就是框没贴准造成的**,
     等于自己把自己锁死。09-12 那局第 12 个大招格(别的英雄补位的 灵魂形态)原框只匹配到 0.47,
     差 0.08 没过补位门槛被留成"未知"; 框挪 2 像素、缩 2 像素之后是 0.76, 第二名只有 0.16。
     做法:拿它在全库里最像的那张当锚点搜几何(不认标签的自由搜索实测更差, 见 docs/recognition.md),
     搜完还要求 ① 最像的没换人 ② 分数够高 ③ 领先第二名够多 ④ 不跟已认出的格子重复, 才认。 */
  for (const r of pool.skills) { if (!r.unknown) continue; const b = r.box;
    /* 太暗的格子不猜 —— 锁池时就已经很暗的多半是开局前被拿走 / 被挡住的, 看不清就没法认,
       猜错比留"未知"更糟(实测两个均值只有 9 和 14 的黑格会被硬认出 0.59/0.60 的假答案;
       认对的那两个均值是 103 和 198)。门槛沿用别处"亮度 <60 算暗格"的口径。 */
    if (cellStats(img, b).mean < 60) continue;
    const g0 = matchSkill(img, b, null); if (!g0.key) continue;
    let best = g0.s1, bo = [0, 0, 0, 0];
    const tryBox = (dx, dy, d) => { const v = matchSkill(img, [b[0] + dx, b[1] + dy, b[2] + d, b[3] + d], [g0.key]).s1;
      if (v > best) { best = v; bo = [dx, dy, d, d]; } };
    for (let dx = -6; dx <= 6; dx += 3) for (let dy = -6; dy <= 6; dy += 3) for (const d of [-6, -3, 0, 3]) tryBox(dx, dy, d);
    const c0 = bo.slice();
    for (let dx = c0[0] - 2; dx <= c0[0] + 2; dx++) for (let dy = c0[1] - 2; dy <= c0[1] + 2; dy++)
      for (const d of [c0[2] - 2, c0[2], c0[2] + 2]) tryBox(dx, dy, d);
    if (best < 0.55) continue;
    const nb = [b[0] + bo[0], b[1] + bo[1], b[2] + bo[2], b[3] + bo[3]], g = matchSkill(img, nb, null);
    if (g.key !== g0.key || g.s1 < 0.55 || g.s1 - g.s2 < 0.15) continue;
    if (pool.skills.some(x => x !== r && !x.unknown && x.key === g.key)) continue;
    adj[r.cell] = bo; r.box = nb; r.key = g.key; r.s1 = g.s1; r.unknown = false; r.rescued = true; }
  /* 英雄卡没有模板可对, 借同一行技能格的偏移(同一行透视一样) */
  const rows = {}; for (const r of pool.skills) if (adj[r.cell]) { const row = LAYOUT.board[r.cell].row; (rows[row] = rows[row] || []).push(adj[r.cell]); }
  const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  for (const hb of pool.heroBoxes) { const row = LAYOUT.board[hb.cell].row, g = rows[row]; if (!g || !g.length) continue;
    const o = [0, 1, 2, 3].map(i => med(g.map(v => v[i]))); adj[hb.cell] = o;
    hb.box = [hb.box[0] + o[0], hb.box[1] + o[1], hb.box[2] + o[2], hb.box[3] + o[3]]; }
  return adj;
}
/* ===== v1.26:"图标还在不在" + 同局自标定 =====
   现行 cellState 全是"和这格锁池时的亮度比"—— 受分辨率/画质/反光/图标本身明暗影响, 每台机器阈值都不一样(1080p 补丁打不完;
   焦渴这种暗红图标基准亮度只有 52, 选走后 32, 比值 0.6 判"没变", 4 分钟一直被推荐)。
   iconScore:这格现在还像不像它自己锁池时认出的那个图标(去均值单位化的模板匹配, 与亮度/缩放/反光无关)。
   真机 1378 格实测:选走后中位数 0.02~0.06(1080p 与 2K 一样), 没选走 1.00;判据只用相对值(除以锁池时的分数)。 */
/* 只比格子里"覆盖层画不到"的那块:真机 09-15 1080p 截图证实插件自己画的推荐框/底部标签条/左上角序号**会进截屏**
   (setContentProtection 在那台机器上没生效), 底部标签条高 23px 占了 61px 格子的 38%。所以掩掉:外圈 8%、底部 40%、左上角 30%×30%。
   锁池时的参考分也按同一掩码算(见 Tracker.observe 里的 icoRef), 只用比值, 掩码本身不影响判据 */
const ICO_MASK = (() => { const m = new Uint8Array(T * T); for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) { const fy = j / T, fx = i / T;
  m[j * T + i] = (fy >= 0.08 && fy < 0.60 && fx >= 0.08 && fx < 0.92 && !(fy < 0.30 && fx < 0.30)) ? 1 : 0; } return m; })();
/* 掩码归一化向量(技能格和英雄卡共用):英雄卡没有图标库, 和它自己锁池时的向量比(selfScore) */
function maskedVec(img, box) { const v = cropResize(img, box[0], box[1], box[2], box[3], T, T); let n = 0, mr = 0, mg = 0, mb = 0;
  for (let p = 0; p < T * T; p++) if (ICO_MASK[p]) { mr += v[p * 3]; mg += v[p * 3 + 1]; mb += v[p * 3 + 2]; n++; } mr /= n; mg /= n; mb /= n;
  let ss = 0; for (let p = 0; p < T * T; p++) { if (ICO_MASK[p]) { v[p * 3] -= mr; v[p * 3 + 1] -= mg; v[p * 3 + 2] -= mb; ss += v[p * 3] ** 2 + v[p * 3 + 1] ** 2 + v[p * 3 + 2] ** 2; } else v[p * 3] = v[p * 3 + 1] = v[p * 3 + 2] = 0; }
  const inv = 1 / (Math.sqrt(ss) + 1e-6); for (let t = 0; t < v.length; t++) v[t] *= inv; return v; }
const selfScore = (a, b) => { let s = 0; for (let t = 0; t < a.length; t++) s += a[t] * b[t]; return s; };
/* 英雄卡判定:sc = 现在的卡面和锁池时自己的相关性(没参考时为 null → 原样) */
function heroVerdict(base, st, ref, sc) {
  if (base === 'T' || sc == null) return base;
  const r = st.mean / Math.max(ref, 8), mr = st.max / Math.max(ref, 8), notLit = r < 0.9 && mr < 1.3;
  if (sc < 0.35 && notLit && (base === 'O' || r < 0.75)) return 'T';
  if (sc > 0.8 && base === 'O' && r >= 0.32) return 'N';
  return base;
}
function iconScore(img, box, key) { const idx = KIDX[key]; if (idx == null || !box) return null;
  const v = cropResize(img, box[0], box[1], box[2], box[3], T, T); let n = 0, mr = 0, mg = 0, mb = 0;
  for (let p = 0; p < T * T; p++) if (ICO_MASK[p]) { mr += v[p * 3]; mg += v[p * 3 + 1]; mb += v[p * 3 + 2]; n++; } mr /= n; mg /= n; mb /= n;
  let ss = 0; for (let p = 0; p < T * T; p++) { if (ICO_MASK[p]) { v[p * 3] -= mr; v[p * 3 + 1] -= mg; v[p * 3 + 2] -= mb; ss += v[p * 3] ** 2 + v[p * 3 + 1] ** 2 + v[p * 3 + 2] ** 2; } else v[p * 3] = v[p * 3 + 1] = v[p * 3 + 2] = 0; }
  const inv = 1 / (Math.sqrt(ss) + 1e-6); for (let t = 0; t < v.length; t++) v[t] *= inv;
  return dot1(v, idx); }
/* 综合判定(纯函数, 便于离线验证):base = cellState 的亮度判定;icoR = 现在的图标分 / 锁池时的图标分;
   slabs = 同一排里**已确认**选走的格子此刻的亮度(同排光照一样, 选走后的那块黑板长得一样 —— 这台机器自己的样本, 不需要任何人调阈值)。
   · 图标没了 + 没有被点亮(不是提示框的白字) + (亮度判"看不清" / 长得像同排已选走的格子 / 颜色也淡了) → 选走
   · 图标清清楚楚还在 + 亮度判"看不清" → 没变(提示框半透明盖着) */
function skillVerdict(base, st, ref, icoR, slabs) {
  if (base === 'T' || icoR == null) return base;
  const r = st.mean / Math.max(ref, 8), mr = st.max / Math.max(ref, 8);
  const notLit = r < 0.9 && mr < 1.3;
  const slabLike = (slabs || []).some(s => Math.abs(s.mean - st.mean) <= 8 && Math.abs(s.max - st.max) <= 10);
  if (icoR < 0.35 && notLit && (base === 'O' || slabLike || st.sat < 0.35 || r < 0.75)) return 'T';   // r<0.75:焦渴那种暗图标, 选走后亮度比 0.6、颜色还在, 只有图标没了这一条证据
  if (icoR < 0.55 && base === 'O' && r < 0.4 && notLit) return 'T';   // "鬼影":选走后还残留一点淡淡的图案(冰火交加/飘忽不定), 很暗 + 图案只剩一半像
  if (icoR > 0.7 && base === 'O' && r >= 0.32) return 'N';
  return base;
}
function takenFlags(imgNow, refB, pool, boxesNow, refS) {
  const out = {}, S = refS || {};
  for (const r of pool.skills) out[r.key] = cellState(imgNow, boxesNow[r.cell], refB[r.cell], S[r.cell] || 0, false);
  for (const hb of pool.heroBoxes) hb.state = cellState(imgNow, boxesNow[hb.cell], refB[hb.cell], S[hb.cell] || 0, true);
  return out;
}
/* 参考亮度表(每格"没被选走时应有多亮")。
   新局面(暗格 ≤8, 选技刚开始/准备阶段):
     · 纯黑(平均<30 且 最亮一格<48)= 开局前就被选走了(实测:斯温卡 4/8, 被选技能 19~27/36~42)→ 直接记已选走;
     · 其余暗格 = 原画本来就暗 或 被提示框挡着(实测:潮汐猎人卡 31/51, 美杜莎卡 51/73)→ 用它**自己**的亮度当基准,
       以后看到它变亮就往上学。以前是换成"图标库估计亮度", 但库里的图比游戏卡面亮, 暗色原画因此被当成"已选走" ——
       美杜莎被凭空记成已选(再被名字匹配塞给 1 楼)、潮汐猎人来回"选走/亮回来"导致建议跳, 都是这个原因。
   中途加入(暗格 >8):那些多半是真被选走的, 仍按图标库估计亮度判。 */
const isBlack = st => st.mean < 30 && st.max < 48;
function refBrightness(imgRef, pool) {
  const refB = {}, ratios = [], hratios = [], stats = {}; let darkCells = 0;
  const all = pool.skills.map(r => [r.key, r.cell, false]).concat(pool.heroBoxes.map(h => ['hero:' + h.hero, h.cell, true]));
  const gone = {};
  for (const [k, cell, isHero] of all) { const st = cellStats(imgRef, (pool.skills.find(r => r.cell === cell) || pool.heroBoxes.find(h => h.cell === cell)).box);
    stats[cell] = st; refB[cell] = st.mean;
    /* 英雄卡没了颜色(饱和度 <0.08;英雄原画实测最灰的也有 0.18)= 开局前就被选走、且是带反光的那种(不黑, 亮度 60+) */
    gone[cell] = isBlack(st) || (isHero && st.sat < 0.08 && st.mean < 120 && st.max < 150);
    if (st.mean < 60 || gone[cell]) darkCells++; }
  for (const r of pool.skills) if (refB[r.cell] >= 60 && BRIGHT[r.key]) ratios.push(refB[r.cell] / BRIGHT[r.key]);
  for (const hb of pool.heroBoxes) if (refB[hb.cell] >= 60 && HBRIGHT[hb.hero]) hratios.push(refB[hb.cell] / HBRIGHT[hb.hero]);
  const med = a => { if (!a.length) return null; const x = a.slice().sort((p, q) => p - q); return x[(x.length / 2) | 0]; };
  const ratio = med(ratios) || 1.0, hratio = med(hratios) || ratio, darkKeys = [], preTaken = [], learn = [];
  const libEst = (k, isHero) => Math.max(60, isHero ? (HBRIGHT[k.slice(5)] || 90) * hratio : (BRIGHT[k] || 90) * ratio);
  const fresh = darkCells <= 8;
  const refS = {}; for (const [, cell] of all) refS[cell] = stats[cell].sat;
  for (const [k, cell, isHero] of all) { if (refB[cell] >= 60 && !gone[cell]) continue; darkKeys.push(k);
    /* 看着已经被选走的格子:没有"没选走时"的样子可比, 饱和度基准填一个典型原画的值, 让 cellState 的"颜色没了"那条能成立 */
    if (gone[cell] && isHero) refS[cell] = Math.max(refS[cell], 0.4);
    if (!fresh) { refB[cell] = libEst(k, isHero); continue; }                          // 中途加入:暗格多半真被选了
    if (gone[cell]) { preTaken.push(k); refB[cell] = libEst(k, isHero); }              // 纯黑/无色反光:开局前就被选走
    else { refB[cell] = Math.max(12, refB[cell]); learn.push(cell); } }               // 暗色原画/被挡:用自己当基准, 以后往上学
  return { refB, refS, ratio, darkCells, darkKeys, preTaken, learn, fresh };
}
/* ---- 面板 ---- */
function matchSkill(img, box, cands) {
  if (SRC && SRC.match && box && box.slot) return SRC.match(box.slot, cands);
  const v = cellVec(img, box); let b1 = -9, k1 = null, b2 = -9, k2 = null;
  /* 只对候选算点积。原来不管候选多少都先 scoreAll 全部 513 个(每个 12288 维),面板 40 个槽位就是 2.5 亿次乘法 —— 白烧 */
  const list = cands ? cands.map(k => KIDX[k]).filter(i => i != null) : null;
  if (list) { for (const i of list) { const s = dot1(v, i);
      if (s > b1) { b2 = b1; k2 = k1; b1 = s; k1 = LIB.keys[i]; } else if (s > b2) { b2 = s; k2 = LIB.keys[i]; } }
    return { key: k1, s1: b1, key2: k2, s2: b2 }; }
  const s = scoreAll(v);
  for (let i = 0; i < LIB.keys.length; i++) { if (s[i] > b1) { b2 = b1; k2 = k1; b1 = s[i]; k1 = LIB.keys[i]; } else if (s[i] > b2) { b2 = s[i]; k2 = LIB.keys[i]; } }
  return { key: k1, s1: b1, key2: k2, s2: b2 };
}
/* 本人面板的亮绿框(v1.22)。游戏给本人面板画一圈亮绿线, 最清楚的是**英雄头像那一侧**的竖边(L 面板左边、R 面板右边)。
   以前的"我"量的是上下两条 + 技能那一侧, 那三条边上根本没有这条线 —— 10 个面板绿度最高只有 6~11, 从来没过 25 的门槛,
   于是一直拿锁池第一帧"最绿"的面板当自己:2560 碰巧常对;1080p 每次都落到 R2(09-14 那局本人是 R5, 整局推荐都给了别人)。
   量法:面板这条边左右各 6px(按比例)的每一列, 数有多少比例的行是亮绿(G>100 且比 R、B 都高 50 以上), 取最高三列的平均。
   本人是一条贴边、上下连续的竖线;85 张真实截图(1080p / 2560 / 4K / 半分辨率)本人 0.49~0.82,
   非本人最高 0.29(绿头发的琼英碧灵头像:一片散开的绿, 没有贴边的陡边)。是比例, 和分辨率无关。 */
function rimScore(img, edgeX, y0, h) { const W = Math.max(2, Math.round(6 * SC)), d = img.data, IW = img.w, cols = [];
  for (let dx = -W; dx <= W; dx++) { const X = edgeX + dx; if (X < 0 || X >= IW) { cols.push(0); continue; } let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++) { const k = (y * IW + X) * 4, g = d[k + 1]; if (g > 100 && g - Math.max(d[k], d[k + 2]) > 50) n++; }
    cols.push(n / h); }
  cols.sort((a, b) => b - a); return (cols[0] + cols[1] + cols[2]) / 3; }
function readPanels(img, candKeys) {
  if (SRC && SRC.panels) return SRC.panels(candKeys);
  const panels = [];
  for (const side of ['L', 'R']) { const P = LAYOUT.panels[side];
    for (let i = 0; i < 5; i++) { const px0 = P.x0, py0 = P.y_top + P.pitch * i, pw = PW, ph = P.pitch;
      /* 边框亮度只量上/下两条 + 技能那一侧的竖条;英雄原画那一侧(L 面板左边、R 面板右边)会被原画本身顶亮,不能算 */
      const top = meanBGR(img, px0, py0, pw, EB), bot = meanBGR(img, px0, py0 + ph - EB, pw, EB), sid = side === 'L' ? meanBGR(img, px0 + pw - EB, py0, EB, ph) : meanBGR(img, px0, py0, EB, ph);
      const bm = [0, 1, 2].map(c => (top[c] * pw * EB + bot[c] * pw * EB + sid[c] * EB * ph) / (2 * pw * EB + EB * ph));
      const skills = [];
      const boxes4 = [];
      /* 空槽 = 近乎纯黑:内圈九宫格最亮一格 <24(实测 1080p/1440p 空槽 0~13, 高亮面板的空槽也 ≤13;最暗的图标"感染"最亮一格也有 36)。
         以前按整格平均 <40 判空 —— 暗色图标(红色恶魔脸之类)平均只有 28~43, 被当成空槽:面板"没多东西" → 棋盘那格被判"不当落子"(09-11 日志 魔王降临/混沌之军/狂怒…) */
      for (const [sx, sy, sw] of P.slots) { const b = slotBox(P, px0, py0, sx, sy, sw, side); b.slot = side + i + ":" + boxes4.length; boxes4.push(b); if (!slotFilled(img, b)) { skills.push(null); continue; }
        if (candKeys === false) { skills.push({ key: '?', s: 0 }); continue; }   // 只数格子, 不认图标
        const r = candKeys && candKeys.length ? matchSkill(img, b, candKeys) : matchSkill(img, b, null); skills.push(r.s1 >= 0.3 ? { key: r.key, s: r.s1 } : { key: '?', s: r.s1 }); }
      const [ax0, ay0, ax1, ay1] = (side === 'L' ? [10, 100, 130, 215] : [290, 100, 410, 215]).map(v => Math.round(v * SC)); const st = regionStats(img, px0 + ax0, py0 + ay0, ax1 - ax0, ay1 - ay0);
      const selfRim = rimScore(img, side === 'R' ? px0 + pw : px0, py0, ph);
      panels.push({ side, idx: i, skills, slotBoxes: boxes4, filled: skills.filter(Boolean).length, borderBright: (bm[0] + bm[1] + bm[2]) / 3, borderRGB: bm, faceSat: st.sat, faceTex: st.lap, hasFace: st.sat < 185 && st.lap > 2000, selfRim }); } }
  return panels;
}
function readHeroName(img, side, idx, cands, sizeHint, anchor) {
  if (SRC && SRC.heroName) return SRC.heroName(side, idx, cands, sizeHint);   // anchor = {x, y, r}:只在上次找到的位置附近 ±r 找(L 面板按左边缘、R 面板按右边缘对齐), 快几十倍   // 归一化相关(TM_CCOEFF_NORMED)滑窗;积分图求窗口均值/能量,只剩 num 逐像素
  const P = LAYOUT.panels[side], px0 = P.x0, py0 = P.y_top + P.pitch * idx; const [tx0, ty0, tx1, ty1] = side === 'L' ? [60, 0, 330, 50] : [130, 0, 410, 50];
  /* 名字模板是按设计分辨率渲染的位图 —— 把标题区按设计尺寸重采样(SC≠1 时相当于缩回 1440p 再匹配) */
  const rw = tx1 - tx0, rh = ty1 - ty0, G = new Float32Array(rw * rh), d = img.data, W = img.w;
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    const sx = px0 + Math.round((tx0 + i) * SC), sy = py0 + Math.round((ty0 + j) * SC);
    if (sx < 0 || sy < 0 || sx >= W || sy >= img.h) { G[j * rw + i] = 0; continue; }
    const p = (sy * W + sx) * 4; G[j * rw + i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; }
  const IW = rw + 1, I1 = new Float64Array(IW * (rh + 1)), I2 = new Float64Array(IW * (rh + 1));   // 积分图
  for (let j = 1; j <= rh; j++) { let r1 = 0, r2 = 0; for (let i = 1; i <= rw; i++) { const g = G[(j - 1) * rw + i - 1]; r1 += g; r2 += g * g; I1[j * IW + i] = I1[(j - 1) * IW + i] + r1; I2[j * IW + i] = I2[(j - 1) * IW + i] + r2; } }
  const box = (I, x, y, w, h) => I[(y + h) * IW + x + w] - I[y * IW + x + w] - I[(y + h) * IW + x] + I[y * IW + x];
  const out = [];
  for (const h of cands) { let tpls = NAMES.tpl[h === null ? '__none' : h] || []; if (sizeHint) { const f = tpls.filter(t => Math.abs(t.size - sizeHint) <= 1); if (f.length) tpls = f; } let best = -1, bestSize = 0, bx = 0, by = 0, bw = 0;
    for (const t of tpls) { if (t.h > rh || t.w > rw) continue; const n = t.w * t.h, tv = new Float32Array(n); let tm = 0; for (let i = 0; i < n; i++) { tv[i] = NAMES.bin[t.off + i]; tm += tv[i]; } tm /= n; let tn = 0; for (let i = 0; i < n; i++) { tv[i] -= tm; tn += tv[i] * tv[i]; } tn = Math.sqrt(tn) + 1e-6;
      let ya = 0, yb = rh - t.h, xa = 0, xb = rw - t.w;
      if (anchor) { const ax = side === 'L' ? anchor.x : anchor.x - t.w; ya = Math.max(0, anchor.y - anchor.r); yb = Math.min(yb, anchor.y + anchor.r); xa = Math.max(0, ax - anchor.r); xb = Math.min(xb, ax + anchor.r); }
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const s1 = box(I1, x, y, t.w, t.h), s2 = box(I2, x, y, t.w, t.h); const den = s2 - s1 * s1 / n; if (den < 1e-3) continue;
        let num = 0; for (let j = 0; j < t.h; j++) { const gr = (y + j) * rw + x, tr = j * t.w; for (let i = 0; i < t.w; i++) num += G[gr + i] * tv[tr + i]; }   // Σ g·(t-tm) = Σ (g-m)(t-tm) 因 Σ(t-tm)=0
        const c = num / (Math.sqrt(den) * tn + 1e-6); if (c > best) { best = c; bestSize = t.size; bx = x; by = y; bw = t.w; } } }
    out.push([best, h, bestSize, bx, by, bw]); }
  return out.sort((a, b) => b[0] - a[0]);
}
/* ---- 逐帧追踪 ---- */
/* 本人座位投票(见 Tracker.updateMe):绿框分数门槛、领先第二名多少、看最近几次识别、要几票 */
const ME_RIM_MIN = 0.42, ME_RIM_GAP = 0.25, ME_WIN = 6, ME_NEED = 3;
class Tracker {
  constructor() { this.ref = null; this.pool = null; this.prev = null; this.owner = {}; this.heroOf = {}; this.log = []; this.quality = null;
    this.bhist = {}; this.curSeat = null; this.curCand = null; this.curCandRun = 0; this.darkRun = {}; this.brightRun = {}; this.stable = {}; this.nameSize = 0; this.nameTried = {}; this.frameNo = 0; this.allowBulk = 1; this.bulkLog = null; this.hold = {}; this.flips = {}; this.flaky = {}; this.flakyLog = null;
    this.meSeat = null; this.meAuto = null; this.meManual = null; this.meVotes = []; this.meMsg = null; }
  /* 用这一帧当开局参考:读池子 + 参考亮度。返回质量 {nd, heroes, minMargin, darkCells, ratio};调用方据此决定接不接受 */
  reset(img) { this.ref = img; this.pool = readPool(img); this.boxAdj = refineBoxes(img, this.pool); this.keys = this.pool.skills.map(r => r.key); this.owner = {}; this.heroOf = {}; this.prev = null; this.log = [];
    this.bhist = {}; this.curSeat = null; this.curCand = null; this.curCandRun = 0; this.darkRun = {}; this.brightRun = {}; this.stable = {}; this.nameTried = {}; this.allowBulk = 1; this.bulkLog = null; this.hold = {}; this.flips = {}; this.flaky = {}; this.flakyLog = null;
    const rb = refBrightness(img, this.pool); this.refB = rb.refB; this.refS = rb.refS; this.learn = new Set(rb.learn); this.preTaken = rb.preTaken;
    /* 新局面:只有纯黑格算开局前已被选走(直接记账), 其余暗格不算;不允许"一次多出好几件" */
    if (rb.fresh) { this.allowBulk = 0; for (const k of rb.preTaken) { this.stable[k] = true; this.darkRun[k] = 2; } }
    this.firstT = {}; for (const k of rb.preTaken) this.firstT[k] = 0;   // 锁池前就被选走的:时间记 0(英雄按时间排座位时它们排最前)
    const margins = this.pool.skills.filter(r => !r.ultslot && r.rowMargin != null).map(r => r.rowMargin); const minMargin = margins.length ? Math.min(...margins) : 0;
    this.quality = { nd: this.pool.align.nd, heroes: this.pool.poolHeroes.length, minMargin, darkCells: rb.darkCells, ratio: rb.ratio }; return this.quality; }
  /* 本人座位(v1.22)。每次完整识别投一票:只有一个面板的头像侧绿框明显(≥ME_RIM_MIN 且比第二名高 ≥ME_RIM_GAP)才投给它, 否则弃权。
     最近 ME_WIN 次里同一座位 ≥ME_NEED 票、且别的座位都不到 2 票 → 认定(或改判)。认定之前 me = null:不猜, 不给推荐。
     绿框轮到自己时也还在(10 张"当前选人 = 本人"的真实截图 0.49~0.82);翻牌动画、选完转场那几帧看不到 —— 这些帧弃权, 已认定的座位不变。
     托盘手动指定(meManual)永远优先。
     以前:门槛过不去就拿锁池第一帧"最绿"的面板并一直沿用, 猜错了界面上完全看不出来。 */
  updateMe(panels) {
    const rk = panels.map(p => [p.selfRim || 0, p.side, p.idx]).sort((a, b) => b[0] - a[0]), top = rk[0], second = rk[1] || [0];
    const vote = top && top[0] >= ME_RIM_MIN && top[0] - second[0] >= ME_RIM_GAP ? top[1] + top[2] : null;
    this.meVotes = (this.meVotes || []).concat([vote]).slice(-ME_WIN);
    const cnt = {}; for (const v of this.meVotes) if (v) cnt[v] = (cnt[v] || 0) + 1;
    const cur = this.meAuto ? this.meAuto[0] + this.meAuto[1] : null, nm = k => k[0] + (+k.slice(1) + 1);
    for (const k in cnt) if (k !== cur && cnt[k] >= ME_NEED && !Object.keys(cnt).some(o => o !== k && cnt[o] >= 2)) {
      this.meMsg = (this.meMsg ? this.meMsg + "; " : "") + (cur ? `本人座位改判 ${nm(cur)} → ${nm(k)}` : `认出本人座位 ${nm(k)}`) + ` (最近 ${this.meVotes.length} 次识别里 ${cnt[k]} 次绿框在这里)`;
      this.meAuto = [k[0], +k.slice(1)]; break; }
    this.meSeat = this.meManual || this.meAuto || null; }
  /* 当前选人:边框亮度取最近 3 次识别的峰值(真正的高亮框会呼吸闪动,静态亮边框不会),换人要连续 2 次确认 */
  pickCurrent(panels) { const pid = p => p.side + p.idx; let best = null, bs = -1;
    for (const p of panels) { let h = this.bhist[pid(p)] = (this.bhist[pid(p)] || []).concat([p.borderBright]).slice(-3);
      /* 当前选人的边框连续 2 帧掉到峰值 7 成以下 = 高亮撤了(轮到别人),忘掉它的峰值,别再靠旧峰值霸着 */
      if (this.curSeat && p.side === this.curSeat[0] && p.idx === this.curSeat[1] && h.length >= 2 && h[h.length - 1] < 0.7 * Math.max(...h) && h[h.length - 2] < 0.7 * Math.max(...h)) h = this.bhist[pid(p)] = [p.borderBright];
      const sc = Math.max(...h) + 0.01 * p.borderBright; if (sc > bs) { bs = sc; best = p; } }
    const c = [best.side, best.idx];
    if (!this.curSeat) { this.curSeat = c; return c; }
    if (c[0] === this.curSeat[0] && c[1] === this.curSeat[1]) { this.curCand = null; this.curCandRun = 0; return this.curSeat; }
    if (this.curCand && c[0] === this.curCand[0] && c[1] === this.curCand[1]) this.curCandRun++; else { this.curCand = c; this.curCandRun = 1; }
    if (this.curCandRun >= 2) { this.curSeat = c; this.curCand = null; this.curCandRun = 0; }
    return this.curSeat; }
  observe(img) { let boxes;
    if (SRC && SRC.boxes) boxes = SRC.boxes();                                   // 回放:棋盘框在轨迹头里(锁池后整局不动)
    /* 锁池后**冻结**棋盘位置:选技过程中棋盘不会动, 每帧重新检出反而会漂 —— 09-12 那局选完时只剩 28 格检出, 整体偏移算成 y+8,
       没被选走的 12 个亮格按本帧偏移只有 2 格还认得出, 按锁池时的偏移 12 格全对(分数和锁池时一样)。顺便省掉每帧的格子粗检。 */
    else { boxes = boxesFor({}, this.pool.align.ox, this.pool.align.oy, this.pool.align.G).boxes; const A = this.boxAdj || {};
      for (const c in A) if (boxes[c]) boxes[c] = [boxes[c][0] + A[c][0], boxes[c][1] + A[c][1], boxes[c][2] + A[c][2], boxes[c][3] + A[c][3]]; }   // 锁池时贴准的偏移, 每帧照用
    for (const c in boxes) if (boxes[c]) boxes[c].cell = +c;                     // 打标签:cellStats 换成从观测源取时按它寻址
    this.boxesNow = boxes;
    /* 锁池时暗着(被挡/原画暗)的格子:一旦看到它更亮, 就把基准往上调 —— 提示框移开后就能学到真实亮度 */
    if (this.learn && this.learn.size) for (const cell of this.learn) { const st = cellStats(img, boxes[cell]);
      if (st.mean > this.refB[cell]) { this.refB[cell] = st.mean; this.refS[cell] = Math.max(this.refS[cell] || 0, st.sat); } }
    const rawTaken = takenFlags(img, this.refB, this.pool, boxes, this.refS);   // 每格 'T' 被选走 / 'N' 没变 / 'O' 看不清
    /* 鼠标正停在上面的格子:游戏会弹介绍框、被选走的卡还会把原画亮出来 —— 一律"看不清", 不改任何状态 */
    const hk = this.hoverKey(boxes); if (hk) { if (hk.startsWith('hero:')) { const hb = this.pool.heroBoxes.find(h => 'hero:' + h.hero === hk); if (hb) hb.state = 'O'; } else rawTaken[hk] = 'O'; }
    /* v1.26:图标匹配 + 同排已确认选走格子的亮度样本(见 skillVerdict)。回放老轨迹没有图标分 → 原样 */
    const slabNow = {};
    for (const r of this.pool.skills) { const k = r.key; if (!boxes[r.cell]) continue;
      const confirmed = this.owner[k] || (this.stable[k] && (this.darkRun[k] || 0) >= 12); if (!confirmed) continue;
      const row = (LAYOUT.board[r.cell] || {}).row; if (row == null) continue;
      const st = cellStats(img, boxes[r.cell]); (slabNow[row] = slabNow[row] || []).push({ mean: st.mean, max: st.max }); }
    this.slabs = slabNow; this.icoFix = this.icoFix || {}; this.icoRef = this.icoRef || {};
    /* 鼠标停在某格上时游戏会弹技能介绍框(1080p 实测在光标右侧 ~350px、上下各 ~220px), 框底下的格子图标被文字盖住 → 这一片不用图标规则 */
    const c = this.cursor, tip = (hk && c) ? [c[0] - 560 * SC, c[1] - 320 * SC, c[0] + 560 * SC, c[1] + 280 * SC] : null;
    const inTip = b => tip && b[0] < tip[2] && b[0] + b[2] > tip[0] && b[1] < tip[3] && b[1] + b[3] > tip[1];
    for (const r of this.pool.skills) { const k = r.key, b = boxes[r.cell]; if (!b || r.unk || !k || k[0] === '?' || k === hk || inTip(b)) continue;
      const base = rawTaken[k];
      const ico = SRC ? (SRC.ico ? SRC.ico(r.cell, k) : null) : iconScore(img, b, k); if (ico == null) continue;
      /* 参考分:第一次清清楚楚看到它亮着(亮度判"没变")时记下, 之后只看比值 */
      if (this.icoRef[k] == null) { if (base === 'N' && ico > 0.15) this.icoRef[k] = ico; continue; }
      if (base === 'T') continue;
      const st = cellStats(img, b), row = (LAYOUT.board[r.cell] || {}).row;
      const v = skillVerdict(base, st, this.refB[r.cell], ico / Math.max(this.icoRef[k], 0.2), slabNow[row] || []);
      if (v !== base) { rawTaken[k] = v; this.icoFix[k] = (this.icoFix[k] || 0) + 1; } }
    /* v1.27:英雄卡 —— 和自己锁池时(第一次清楚看到亮着时)的卡面比。录轨迹时把分数写进记录, 回放读记录 */
    this.heroRef = this.heroRef || {}; const live = !SRC || SRC.img != null;
    for (const hb of this.pool.heroBoxes) { const b = boxes[hb.cell], hk2 = 'hero:' + hb.hero; if (!b || !hb.hero || hk2 === hk || inTip(b)) continue;
      const base = hb.state; let sc = null;
      if (live) { const v = maskedVec(img, b);
        if (!this.heroRef[hb.cell]) { if (base === 'N') this.heroRef[hb.cell] = v; continue; }
        sc = selfScore(v, this.heroRef[hb.cell]); if (SRC && SRC.rec) { SRC.rec.icoH = SRC.rec.icoH || {}; SRC.rec.icoH[hb.cell] = Math.round(sc * 1000) / 1000; } }
      else { sc = SRC.icoH ? SRC.icoH(hb.cell) : null; if (sc == null) continue; }
      if (base === 'T') continue;
      const v2 = heroVerdict(base, cellStats(img, b), this.refB[hb.cell], sc);
      if (v2 !== base) { hb.state = v2; this.icoFix[hk2] = (this.icoFix[hk2] || 0) + 1; } }
    /* 铁律:一手只选走一件。所以"这一帧新变黑的格子 ≥2 个"必定不是选人 —— 是半透明的提示框/弹窗盖住了一片,
       整批丢弃(实测有一次盖黑 30 格, 被当成 12 件已选走, 还连累"新的一局"误判)。
       只有刚锁定池子/刚从后台回来那几帧允许批量(那时确实可能一次看到很多件已被选走)。 */
    const rawList = [];
    for (const r of this.pool.skills) rawList.push([r.key, rawTaken[r.key]]);
    for (const hb of this.pool.heroBoxes) rawList.push(['hero:' + hb.hero, hb.state]);
    /* v1.37 画面根本不是选技棋盘(切回 Dota 大厅打字/看记分板/选完转场)。
       09-19 23:05 那局:用户切到大厅聊天 4 秒, 棋盘位置上显示的是大厅背景和黑聊天框, 60 格"一起变黑" ——
       旧版的整块遮挡守卫只顶 8 帧就放行, 于是把 20 多件当成"被选走"且配不上归属, 账从此烂掉(还要选 17 手 vs 池里剩 11 样),
       GPU 版推演走到"没得选"崩了 8 次。
       判据用**相对**基准而不是写死的亮度(各人显示器/游戏亮度不同):选技画面里总有没被选走的技能图标是高光的,
       所以"本帧最亮的那一格" 和 "这一局见过的最亮" 比。实测(两人同一局的轨迹):
         正常选技帧 = 1.00(最亮格恒 255) | 切大厅 11 秒 = 0.64~0.68 | 选完转场 = 0.31~0.65 | 偶发单帧闪动 = 0.78。
       取 0.72:大厅和转场都拦住, 单帧闪动不误杀。这一帧整个当"看不清", 一个字都不改 —— 看不见的时候不记账。 */
    const cellMax = b => (SRC ? (SRC.cellStats ? SRC.cellStats(b.cell).max : 0) : cellStats(img, b).max);
    let maxNow = 0;
    for (const r of this.pool.skills) { const b = boxes[r.cell]; if (b) { const m = cellMax(b); if (m > maxNow) maxNow = m; } }
    for (const hb of this.pool.heroBoxes) { const b = boxes[hb.cell]; if (b) { const m = cellMax(b); if (m > maxNow) maxNow = m; } }
    this.refMaxAll = Math.max(this.refMaxAll || 0, maxNow);
    const dim = this.refMaxAll > 0 ? maxNow / this.refMaxAll : 1;
    if (dim < OFF_RATIO) { this.offRun = (this.offRun || 0) + 1;
      if (this.offRun === 1) this.offLog = `画面不是选技棋盘了(最亮格只有平时的 ${(100 * dim).toFixed(0)}%) → 这段时间一律当看不见, 不记账`;
      for (const e of rawList) e[1] = 'O'; }
    else { if (this.offRun) this.offLog = `选技画面回来了(暗了 ${this.offRun} 帧)`; this.offRun = 0; }
    /* 同一帧里 ≥2 个格子"新变黑" = 多半是遮挡(一手只选一件)。以前的做法是整批丢弃并把计数清零 ——
       结果真被选走的格子只要跟一个闪烁格同帧出现, 就会被一直拖着永远认不上(实测食人魔魔法师整局没被认出, 最后一轮还在推荐它);
       而"同一批连续 N 次都黑就接受"又把停着看技能介绍时框底下的 8 格一次收了进来(已选数 6→14, 40 秒后才撤销)。
       现在:这种格子逐个标记"要等更久"(连续 5 次都暗才认), 各算各的, 互不牵连;不再有"整批接受"。
       只有刚锁池/刚从后台回来那一帧(allowBulk)允许一次认很多(那时确实可能已经被选了好几件)。 */
    const fresh = rawList.filter(([k, d]) => d === 'T' && !this.stable[k] && !this.darkRun[k]);
    /* v1.26:同一帧 ≥10 格一起"新变黑"只可能是整块被盖住(菜单/计分板/转场;真机 09-15 08:59 有 25 格一起暗了 3 分钟),
       这些格子当"看不清"处理, 什么都不改 —— 以前 5 帧后就当选走, 然后一批"不当落子"。落子一次只有一格, 撞上 9 个闪烁格的概率可以不计 */
    this.occlRun = (fresh.length >= 10 && !this.allowBulk) ? (this.occlRun || 0) + 1 : 0;
    if (this.occlRun >= 1 && this.occlRun <= 8) { for (const e of rawList) if (fresh.some(f => f[0] === e[0])) e[1] = 'O'; fresh.length = 0;
      if (this.occlRun === 1) this.bulkLog = `≥10 格同时变黑 → 整块被盖住, 这些格子先当看不清(最多 8 帧)`; }
    /* 超过 8 帧还这样 = 真的一起黑了(从后台切回来、中途才打开插件) → 放行, 走原来的"连续 5 次才认" */
    let bulk = false; this.hold = this.hold || {};
    if (fresh.length >= 2 && !this.allowBulk) { bulk = true; for (const [k] of fresh) this.hold[k] = true;
      this.bulkLog = `${fresh.length} 格同时变黑 → 当遮挡嫌疑, 这几格要连续 5 次都暗才认`; }
    for (const [k, d] of rawList) if (d === 'N') delete this.hold[k];
    if (this.allowBulk > 0) this.allowBulk--;
    const rawMap = Object.fromEntries(rawList);
    /* 已选走去抖:连续 N 次都黑才算,连续 N 次都亮才撤。
       N 平时是 2;某个格子一旦被发现"翻来覆去地闪"(实测赛前准备阶段有格子每半秒明暗一次),
       就把它标成 flaky 并把 N 提到 6 —— 真选走了会一直黑,闪的那种撑不过 6 次。 */
    const taken = {}; let pending = bulk;
    const step = (k, st3) => {
      if (st3 === 'O') return !!this.stable[k];   // 看不清(被挡):什么都不改, 连计数都不动
      /* 确认被选走、并且**连续暗满 12 次**完整识别(十几秒)就锁定, 以后看到它"亮了"也不撤 —— 游戏里被选走的东西不会回来。
         按"连续暗了多久"而不是"确认了多久":误判(暗图标/遮挡)通常暗几帧就亮回来, 那种要照常撤销。
         09-11 那局:左2 第一手拿了美杜莎(认对了), 两分钟后左2 自己回合用鼠标在这张卡上晃, 卡面短暂"亮回来" → 被撤销、
         还把美杜莎推荐给左2, 随后美杜莎被当成右1 选的, 两人英雄对调。撤销只该用来纠正刚认错的(提示框瞬间盖黑之类), 那都在几秒内 */
      if (this.stable[k] && (this.darkRun[k] || 0) >= 12) { if (st3 === 'T') this.darkRun[k]++; return true; }
      const d = st3 === 'T';
      this.darkRun[k] = d ? (this.darkRun[k] || 0) + 1 : 0; this.brightRun[k] = d ? 0 : (this.brightRun[k] || 0) + 1;
      this.firstT = this.firstT || {}; if (d && this.darkRun[k] === 1 && !this.stable[k]) this.firstT[k] = this.frameNo;   // 这一格开始变暗的时刻(英雄按时间顺序排座位用)
      /* 认"被选走"要连续 need 次;**撤销要连续 6 次清清楚楚"没变"**(看不清的帧不算)——
         游戏里被选走的东西永远不会回来, 所以撤销只可能是我们之前认错了, 必须证据确凿才撤(以前 2 次就撤, 撤了又认、认了又撤就是抖动) */
      const need = this.flaky[k] ? 6 : (this.hold && this.hold[k]) ? 5 : 2, was = !!this.stable[k];
      if (this.darkRun[k] >= need) this.stable[k] = true; if (this.brightRun[k] >= 6) this.stable[k] = false;
      if (was !== !!this.stable[k]) { this.flips[k] = (this.flips[k] || 0) + 1;
        if (this.flips[k] >= 3 && !this.flaky[k]) { this.flaky[k] = true; this.flakyLog = (this.flakyLog || []).concat([k]);
          this.stable[k] = false; this.darkRun[k] = 0; } }   // 判定为闪烁的一刻先当"没被选走"(真选走了会一直黑, 6 次后自然认回来)
      /* 还在确认中(暗了但还没认 / 亮了但还没撤)就要求下一帧必须完整识别 —— 否则画面一模一样时会被"画面未变"跳过,
         要连续 5 次才认的格子计数会永远卡在 2 */
      if ((d && !this.stable[k]) || (!d && this.stable[k])) pending = true;
      return !!this.stable[k]; };
    for (const r of this.pool.skills) taken[r.key] = step(r.key, rawMap[r.key]);
    for (const hb of this.pool.heroBoxes) hb.takenStable = step('hero:' + hb.hero, rawMap['hero:' + hb.hero]);
    const takenHeroes = this.pool.heroBoxes.filter(h => h.takenStable).map(h => h.hero); const takenKeys = Object.keys(taken).filter(k => taken[k]);
    const panels = readPanels(img, false);
    this.updateMe(panels);
    const cur = this.pickCurrent(panels);
    /* pending = 还有待确认的变化(已选走去抖中 / 换人待二次确认)。worker 据此强制下一帧做完整识别,
       否则画面一模一样时会被"画面未变"跳过,二次确认永远等不到。 */
    const bulkMsg = this.bulkLog; this.bulkLog = null;
    const offMsg = this.offLog; this.offLog = null;
    const flakyMsg = this.flakyLog && this.flakyLog.length ? `${this.flakyLog.map(k => cn(k.replace(/^hero:/, ''))).join("/")} 这几格明暗来回跳(不是选人), 以后要连续 6 次才认` : null; this.flakyLog = null;
    const nO = rawList.filter(([, d]) => d === 'O').length;
    return { taken, takenHeroes, panels, rawState: Object.fromEntries(rawList), current: cur.slice(), me: this.meSeat ? this.meSeat.slice() : null, pending: pending || this.curCandRun > 0, bulkMsg, flakyMsg, occluded: nO, offScreen: this.offRun || 0, offMsg, rawDark: rawList.filter(([, d]) => d === 'T').length };
  }
  /* ================= 归属:配对式(v1.5) =================
     每落一手, 画面上**同时**有两个变化:① 棋盘某格变成"被选走"的样子 ② 某个人的面板多了东西。
     技能:面板技能槽"有没有图标"极其干净(实测空槽 0~20, 有图标 78~155, 正在选的人面板变亮时空槽也只有 7~12),
          所以 "这一格变暗 + 那个面板多了一个图标" = 那个人选了这件。图标只在"刚变暗的那一两件"里核对, 不用在 47 个里挑。
          · 棋盘变暗、但没有任何面板多东西(实测"感染":本来就很暗的图标)→ 不算落子;
          · 面板多了、棋盘没看到(实测蓝胖的卡整局没认上)→ 在还没被选的东西里认, 高分才收, 否则记"他选了一件没认出的";
          · 正在选的人自己的面板多出来、棋盘没变 → 可能是悬停预览, 等他回合结束还在才算。
     英雄:面板上没有可靠信号(实测标题一高亮就变白、头像是半透明的), 按回合填空:40 手技能每一手都被面板精确锚定"这是谁的第几手",
          英雄只落在两个锚点之间的空当里;再加硬约束:一个人只能有一个英雄。
     以前是"按计数推"——错一手后面全错(09-10 那局日志:英雄 10 个对 1~3 个, 选完时插件眼里左方 67~70%, 真实 19%)。 */
  attribute(img, ob, pq, same) {
    const F = this.frameNo, seatKey = q => q[0] + q[1], ORDER = this.fullOrder || [];
    this.pc = this.pc || {}; this.pcRaw = this.pcRaw || {}; this.pcRun = this.pcRun || {}; this.incs = this.incs || [];
    this.known = this.known || new Set(); this.suspect = this.suspect || {}; this.pend = this.pend || {}; this.orphan = this.orphan || {};
    if (this.turn == null) this.turn = 0;
    const cur = ob.current;
    /* A. 面板格子数去抖(同一个数连续 2 帧才算)。
       判据是 **"面板图标数 − 已经记在他名下的件数" = 多出来的几个**, 而不是"图标数增加了没有":
       有人会拖动自己的技能换位置 —— 拖起来那一格会空一下、放下又回来;按"增加"算会把放下当成一次新落子(然后认错一件或计数多一手),
       按"多出来"算:放下后图标数 = 已记件数, 什么都不会发生。图标数暂时比已记件数少(正在拖)也不处理。 */
    const first = !this.pcInit;
    for (const p of ob.panels) { const k = seatKey([p.side, p.idx]);
      if (first) { this.pc[k] = p.filled; continue; }
      if (p.filled === this.pcRaw[k]) this.pcRun[k] = (this.pcRun[k] || 0) + 1; else { this.pcRaw[k] = p.filled; this.pcRun[k] = 1; }
      if (this.pcRun[k] >= 2) this.pc[k] = p.filled; }
    const hasHero = q => Object.values(this.heroOf).some(o => same(o, q));
    const attributed = q => Object.values(this.owner).filter(o => same(o, q)).length + (this.unknownBy || []).filter(o => same(o, q)).length;
    const surplus = q => Math.max(0, (this.pc[seatKey(q)] || 0) - attributed(q));
    /* noBack:晚认出来的旧落子(面板图标晚到、事后按图标补认)只能让回合往前走, 不能往回拉 ——
       压力测试:第 38 手时才补认出第 34 手的技能, 回合被拉回到 34, 接下来两个英雄"附近的人都有英雄了"直接丢了座位 */
    const anchor = (q, noBack) => { const s = (q[0] === 'L' ? 0 : 5) + q[1]; let best = -1, bd = 1e9;
      for (let i = 0; i < ORDER.length; i++) if (ORDER[i] === s) { const d = Math.abs(i - this.turn); if (d < bd) { bd = d; best = i; } }
      if (best >= 0 && !(noBack && best + 1 < this.turn)) this.turn = best + 1; };
    const seatAt = i => { const x = ORDER[Math.max(0, Math.min(i, ORDER.length - 1))]; return x == null ? cur : [x < 5 ? 'L' : 'R', x % 5]; };
    const seats = ob.panels.map(p => [p.side, p.idx]);
    /* 开局第一帧:已经在面板里的技能按图标一次配完(中途才打开插件的情况);回合数 = 面板里的图标总数 + 已经变黑的英雄卡数 */
    const skillsTaken = Object.keys(ob.taken).filter(k => ob.taken[k]);
    if (first) { this.pcInit = true;
      const cands = skillsTaken.filter(k => k[0] !== '?');
      for (const p of ob.panels) if (p.filled) { const pp = readPanels(img, cands).find(x => x.side === p.side && x.idx === p.idx);
        for (const sl of pp.skills) if (sl && sl.key !== '?' && sl.s >= 0.45 && !this.known.has(sl.key)) { this.owner[sl.key] = [p.side, p.idx]; this.known.add(sl.key); this.pickT = this.pickT || {}; this.pickT[sl.key] = 0; this.log.push(['skill', sl.key, pq([p.side, p.idx]), `开局已在面板里 ${sl.s.toFixed(2)}`]); } }
      this.turn = ob.panels.reduce((a, p) => a + p.filled, 0) + ob.takenHeroes.length; }
    /* 多出来的状态从哪一帧开始(C 步要等它持续一阵子) */
    this.surSince = this.surSince || {};
    for (const q of seats) { const k = seatKey(q); if (surplus(q) > 0) { if (this.surSince[k] == null) this.surSince[k] = F; } else delete this.surSince[k]; }
    /* B. 棋盘上新变成"被选走"的技能:到"图标比已记件数多"的面板里找它, 以图标为准配对 */
    const newSk = skillsTaken.filter(k => !this.known.has(k));
    /* 某人面板里"这几件里最像的那格有多像"—— 只看他**还没解释的**格子:更像他已记下那几件的格子跳过。
       以前把他已有的格子也算进去:压力测试里 灵能之刃 对右5 已有的"粘性燃油"那格 0.48, 就被配给了右5, 之后连锁错 5 手 */
    const openScore = (q, keys) => { const pp = readPanels(img, keys).find(x => x.side === q[0] && x.idx === q[1]), mine = Object.keys(this.owner).filter(x => same(this.owner[x], q));
      let m = -1; for (let j = 0; j < 4; j++) { const x = pp.skills[j]; if (!x || x.s <= m) continue; if (mine.length && matchSkill(img, pp.slotBoxes[j], mine).s1 >= x.s) continue; m = x.s; } return m; };
    const newHero = ob.takenHeroes.filter(h => !this.known.has('hero:' + h));
    for (const k of newSk) {
      const open = seats.filter(q => surplus(q) > 0);
      let best = null, bs = -9;
      if (k[0] === '?') { best = open.sort((x, y) => (this.surSince[seatKey(y)] || 0) - (this.surSince[seatKey(x)] || 0))[0] || null; bs = best ? 0.5 : -9; }   // 认不出图标的格子:配最近多出来的那个面板
      else for (const q of open) { const sc = openScore(q, [k]); if (sc > bs) { bs = sc; best = q; } }
      /* 只有一个面板多出来、棋盘也只有这一格刚变暗:时间上的巧合本身就是证据, 图标只要不明显矛盾(≥0.2)就配;有多个候选才要 ≥0.45 挑最像的。
         "巧合"必须是真的同时:那个面板多出来的时刻不能早于这格变暗前 1 帧 —— 早就多出来的是更早那一手留下的
         (整局压力测试:右1 的图标晚 5 帧才出现, 恰好这时左3 落子, 左3 的技能被 0.32 配给了右1, 后面连锁错) */
      const tk = (this.firstT || {})[k], fresh = best && tk != null && (this.surSince[seatKey(best)] != null ? this.surSince[seatKey(best)] : F) >= tk - 1;
      const need = (open.length === 1 && newSk.length === 1 && fresh) ? 0.2 : 0.45;
      /* 那个面板多出来的图标, 如果另一格还没配上的暗格(不当落子的 / 同样在等配对的)更像, 就不是这一手的 —— 先等等。
         (压力测试:右4 晚到的"死亡契约"图标刚好在右3 落子时出现, 右3 的"深海重击"以 0.29 被配给了右4, 而那个图标对死亡契约是 0.8) */
      if (best && bs >= need) { const rivals = Object.keys(this.suspect).concat(Object.keys(this.pend), newSk).filter(x => x !== k && x[0] !== '?' && !this.owner[x]);
        if (rivals.length && openScore(best, rivals) > bs) best = null; }
      if (best && bs >= need) { this.owner[k] = best.slice(); this.known.add(k); delete this.pend[k]; anchor(best);
        this.log.push(['skill', k, pq(best), `配对:棋盘变暗 + 他面板里多出这个图标(吻合 ${bs.toFixed(2)})`]); continue; }
      this.pend[k] = (this.pend[k] || 0) + 1;
      if (this.pend[k] >= 4) { this.suspect[k] = true; this.known.add(k); delete this.pend[k];
        this.log.push(['note', k, '', `棋盘上看着像被选走, 但 4 帧里没有哪个面板多出它${best ? `(最像的面板吻合只有 ${bs.toFixed(2)})` : ''} → 不当落子`]); } }
    /* 门槛只有 0.3 的补认要多一道保险:这一格在全库里明显更像另一件(高出 0.1)就不认 —— 那多半是一件真没认出的补位技能, 不是这格暗格。
       0.1 的依据:真实 1080p 截图里认不准的面板图标, 真答案离全库第一最多差 0.04;而整局压力测试里错配的那次, 真图标高出 0.19 */
    const looksElse = (box, key, s) => { const g = matchSkill(img, box, null); return g.key !== key && g.s1 >= s + 0.1; };
    /* 反过来:这一格在全库 500 多张图里最像的就是它 → 分数低一点(≥0.2)也认。压力测试里认不准的面板图标 0.28、而且就是全库第一, 卡在 0.3 门槛外 */
    const topIs = (box, key) => matchSkill(img, box, null).key === key;
    /* C. 面板多出来、但棋盘上一直没有对应的变暗(持续 ≥4 帧):在还没归属的技能里认(≥0.6 且领先 0.1), 否则记"他选了一件没认出的"。
       正在选的人自己的面板先不管 —— 多出来的可能是悬停预览, 等他回合过去还在才算。 */
    for (const q of seats) { const k = seatKey(q), n = surplus(q); if (!n || F - (this.surSince[k] || F) < 4 || same(cur, q)) continue;
      const pool = this.pool.skills.filter(r => !r.unknown && !this.owner[r.key]).map(r => r.key);
      const pp = readPanels(img, pool).find(x => x.side === q[0] && x.idx === q[1]);
      const mine = new Set(Object.keys(this.owner).filter(x => same(this.owner[x], q)));
      const cands = []; for (let j = 0; j < 4; j++) { if (!pp.skills[j]) continue; const r = matchSkill(img, pp.slotBoxes[j], pool);
        const rMine = mine.size ? matchSkill(img, pp.slotBoxes[j], [...mine]) : { s1: -1 };
        if (rMine.s1 >= r.s1) continue;                                // 这一格是他本来就有的那件(换了位置而已)
        if (r.s1 >= 0.6 && r.s1 - r.s2 >= 0.1) { cands.push({ key: r.key, s: r.s1, gap: r.s1 - r.s2 }); continue; }
        /* 认不准时, 先看"棋盘上已经变暗、但当时没配上面板"的那几格(不当落子的暗格):候选只有两三个, 吻合 ≥0.3 就认 ——
           09-11 那局左1 的锚击就是这样:面板图标在 1080p 只认到 0.47, 被记成"没认出";棋盘那格晚了几秒才确认变暗, 又被判"不当落子" */
        const susp = Object.keys(this.suspect).filter(x => x[0] !== '?' && !this.owner[x]);
        if (susp.length) { const rs = matchSkill(img, pp.slotBoxes[j], susp);
          const okS = (rs.s1 >= 0.3 && !looksElse(pp.slotBoxes[j], rs.key, rs.s1)) || (rs.s1 >= 0.2 && topIs(pp.slotBoxes[j], rs.key));
          if (okS && !cands.some(c => c.key === rs.key)) cands.push({ key: rs.key, s: rs.s1, gap: rs.s1 - rs.s2, susp: true }); } }
      cands.sort((x, y) => y.s - x.s);
      /* 数目上限:每落一手棋盘上必有一格变暗, 所以记下的手数不能明显多于棋盘上被选走的格子数(最多多 1 手, 容忍一格没看出变暗)。
         09-12 日志:右边 4 个面板同一刻被认成各多 4 个图标(棋盘上一个暗格都没有), 一口气记了 16 手"没认出", 接着误判成新的一局 */
      const recorded = () => Object.keys(this.owner).length + (this.unknownBy || []).length + Object.keys(this.heroOf).length + Object.keys(this.orphan || {}).filter(x => x.startsWith('hero:')).length;
      for (let m = 0; m < n; m++) { const c = cands[m];
        if (!(c && c.susp) && recorded() >= (ob.rawDark || 0) + 1) { if (!this.capLogged) this.log.push(['note', '', pq(q), `面板多出图标, 但棋盘上被选走的格子不够(${ob.rawDark}) → 不当落子`]); this.capLogged = true; break; }
        if (c && !this.owner[c.key]) { this.owner[c.key] = q.slice(); this.known.add(c.key); delete this.pend[c.key]; delete this.suspect[c.key];
          if (!c.susp) { this.forced = this.forced || {}; this.forced[c.key] = true; this.pickT = this.pickT || {}; this.pickT[c.key] = this.surSince[k] != null ? this.surSince[k] : F; }   // 棋盘确认过变暗的不算"强认", 格子亮回来照常撤销
          this.log.push(['skill', c.key, pq(q), c.susp ? `面板多出图标 = 棋盘上那格没配上的暗格(吻合 ${c.s.toFixed(2)})` : `面板多出图标但棋盘没看到变暗 → 按图标认 ${c.s.toFixed(2)}(领先 ${c.gap.toFixed(2)})`]); }
        else { const u = q.slice(); u.t = this.surSince[k] != null ? this.surSince[k] : F; (this.unknownBy = this.unknownBy || []).push(u); this.log.push(['note', '', pq(q), '面板多出一个图标, 认不出是哪件(计数照记)']); }
        anchor(q, true); } }
    /* C2. 反方向补认:面板那件先被记成"没认出"(占位), 棋盘那格晚几秒才确认变暗、因为已经没有面板多东西而被判"不当落子"。
       两边其实是同一手 —— 到有占位的面板里找这格的图标(≥0.3, 挑最像的), 找到就把占位换成它。 */
    if ((this.unknownBy || []).length) for (const k of Object.keys(this.suspect)) { if (k[0] === '?' || this.owner[k]) continue;
      const holders = seats.filter(q => this.unknownBy.some(u => same(u, q))); let best = null, bs = -9; const P = readPanels(img, [k]);
      for (const q of holders) { const pp = P.find(x => x.side === q[0] && x.idx === q[1]), mine = Object.keys(this.owner).filter(x => same(this.owner[x], q));
        for (let j = 0; j < 4; j++) { const x = pp.skills[j]; if (!x || x.s + 0.1 <= bs) continue;
          if (mine.length && matchSkill(img, pp.slotBoxes[j], mine).s1 >= x.s) continue;   // 这一格更像他已经记下的那件, 不是占位那件
          if (looksElse(pp.slotBoxes[j], k, x.s)) continue;
          const eff = topIs(pp.slotBoxes[j], k) ? x.s + 0.1 : x.s;   // 全库第一就是它:0.2 也够
          if (eff > bs) { bs = eff; best = q; } } }
      if (best && bs >= 0.3) { this.unknownBy.splice(this.unknownBy.findIndex(u => same(u, best)), 1); this.owner[k] = best.slice(); delete this.suspect[k];
        this.log.push(['skill', k, pq(best), `补认:他面板之前"没认出"的那件 = 棋盘上这格(吻合 ${bs.toFixed(2)})`]); } }
    /* C3. 图标实在认不出时按时间配:只剩一格没配上的暗格 + 只剩一个"没认出"占位, 两者出现时间相差 ≤6 帧 → 就是同一手
       (压力测试:面板图标糊到 0.27、全库第一是别的图标 0.28, 按图标怎么都配不上;但时间上就是同一手)。图标明显像别的(高出 0.2)就不配 */
    { const sus = Object.keys(this.suspect).filter(k => k[0] !== '?' && !this.owner[k] && this.solidDark(k)), ub = this.unknownBy || [];
      if (sus.length === 1 && ub.length === 1 && ub[0].t != null && Math.abs(ub[0].t - this.firstT[sus[0]]) <= 6) { const k = sus[0], q = ub[0];
        const pp = readPanels(img, [k]).find(x => x.side === q[0] && x.idx === q[1]), mine = Object.keys(this.owner).filter(x => same(this.owner[x], q));
        let ok = false, sc = 0; for (let j = 0; j < 4; j++) { const x = pp.skills[j]; if (!x) continue;
          if (mine.length && matchSkill(img, pp.slotBoxes[j], mine).s1 >= x.s) continue;
          const g = matchSkill(img, pp.slotBoxes[j], null); if (g.key !== k && g.s1 >= x.s + 0.2) continue; ok = true; sc = Math.max(sc, x.s); }
        if (ok) { this.unknownBy.splice(0, 1); this.owner[k] = [q[0], q[1]]; delete this.suspect[k];
          this.log.push(['skill', k, pq(q), `按时间配:只剩这一格暗格和他那一个"没认出", 时间相差 ${Math.abs(q.t - this.firstT[k])} 帧(图标吻合 ${sc.toFixed(2)})`]); } } }
    /* D. 英雄:按回合填空 —— 当前回合是 turn(被技能配对不断重新锚定);该座位已有英雄就试前后一手 */
    for (const h of newHero) { let q = null;
      for (const d of [0, 1, -1, 2]) { const c = seatAt(this.turn + d); if (!hasHero(c)) { q = c; if (d) this.turn += d; break; } }
      this.known.add('hero:' + h);
      if (!q) { this.orphan['hero:' + h] = true; this.log.push(['hero', h, '', '附近几手的人都已有英雄, 只记"被拿走"']); continue; }
      this.heroOf[h] = q; this.turn++;
      this.log.push(['hero', h, pq(q), `按回合填空(第 ${this.turn} 手, 高亮在 ${pq(cur)}${same(cur, q) ? ' 一致' : ''})`]); }
    /* D2. 按时间顺序复核英雄座位。D 是"当时的回合数"填空, 一旦前面有一手当时没认上(09-11:左1 第 1 手的锚击判"看不清"),
       紧接着秒选的英雄就会被填到前一个人头上, 而且以后永不回头 —— 莉娜被记给左1、复仇之魂又被挤到右1, 就是这样来的。
       这里每帧把所有落子按"格子开始变暗的时刻"排好, 重走一遍顺序表:认出主人的技能重新锚定位置, 还没配上的暗格占一手, 英雄落在空当里。
       与当前座位不同就改判。只用**已确认**的落子(配上主人的技能 + "没认出"占位):还在等面板配对的暗格不算 ——
       它可能被判"不当落子"又被补认, 算进来英雄会来回改判。
       不做的情况:中途加入(有不知道时间的落子);英雄和别的落子同一帧变暗(分不出先后, 维持原判)。 */
    { const T0 = this.firstT || {}, PT = this.pickT || {}, z = t => (t != null && t <= (this.lockFrame || 1) ? 0 : t);   // 锁池后第一帧就已经暗着的 = 锁池前的落子, 记 0
      const tOf = k => z(T0[k] != null ? T0[k] : PT[k]); const ev = []; let ok = true;
      for (const k of Object.keys(this.owner)) { const t = tOf(k); if (t == null) { ok = false; break; } ev.push({ t, seat: this.owner[k] }); }
      for (const u of this.unknownBy || []) { if (u.t == null) { ok = false; break; } ev.push({ t: z(u.t), seat: u }); }
      /* 追踪中亲眼看到变暗、但一直没配上面板的暗格:多半是一手真落子(只是看不见面板图标), 占一手但不知道是谁 ——
         不占的话后面的英雄全部错一位(压力测试:面板图标暗到认不出的那一手之后, 4 个英雄全错)。
         等配对中的(pend)不算:它 4 帧内就会变成已配对或不当落子, 算进来英雄会来回改判 */
      for (const k of Object.keys(this.suspect)) { if (this.owner[k] || k[0] === '?') continue; if (this.solidDark(k)) ev.push({ t: T0[k], seat: null }); }
      const namedH = new Set(Object.values(this.nameHero || {}));
      for (const h of Object.keys(this.heroOf)) { const t = z(T0['hero:' + h] != null ? T0['hero:' + h] : PT['hero:' + h]); if (t == null) { ok = false; break; }
        ev.push(namedH.has(h) ? { t, seat: this.heroOf[h] } : { t, hero: h }); }   // 面板名字确认过的:座位已知, 当锚点
      /* 当时"附近几手的人都已有英雄"只记了被拿走的英雄, 也放进来排:排得出座位就补上 */
      const orph = Object.keys(this.orphan || {}).filter(k => k.startsWith('hero:')).map(k => k.slice(5));
      for (const h of orph) { const t = z(T0['hero:' + h]); if (t != null) ev.push({ t, hero: h, orphan: true }); }
      if (ok && (Object.keys(this.heroOf).length || orph.length)) {
        ev.sort((a, b) => a.t - b.t || (a.hero ? 1 : 0) - (b.hero ? 1 : 0));
        const sIdx = q => (q[0] === 'L' ? 0 : 5) + q[1], walk = {}, has = new Set();
        /* 时间 0 = 锁池前就有的落子(晚锁池/中途加入):先后不知道, 不排, 只占手数 —— 与 D 开局时"已有几手"的算法一致;
           锁池前就有的英雄保持原座位并占住那个座位 */
        let p = ev.filter(e => e.t === 0).length;
        for (const e of ev) if (e.t === 0 && e.hero && this.heroOf[e.hero]) { walk[e.hero] = this.heroOf[e.hero]; has.add(sIdx(this.heroOf[e.hero])); }
        for (const h of namedH) if (this.heroOf[h]) has.add(sIdx(this.heroOf[h]));   // 名字确认过的座位已有英雄, 别人排不进去
        for (const e of ev) { if (e.t === 0) continue;
          if (e.hero) { let pick = -1; for (const d of [0, 1, -1, 2]) { const i = p + d; if (i >= 0 && i < ORDER.length && !has.has(ORDER[i])) { pick = i; break; } }
            if (pick >= 0) { has.add(ORDER[pick]); walk[e.hero] = seatAt(pick); p = pick + 1; } else p++; }
          else if (e.seat) { const s = sIdx(e.seat); let best = -1, bd = 1e9; for (let i = 0; i < ORDER.length; i++) if (ORDER[i] === s && Math.abs(i - p) < bd) { bd = Math.abs(i - p); best = i; } p = best >= 0 ? best + 1 : p + 1; }
          else p++; }
        const next = {}, moved = [];
        for (const h of Object.keys(this.heroOf).concat(orph)) { const q = walk[h], o = this.heroOf[h], th = z(T0['hero:' + h]), solo = ev.filter(e => e.t === th).length === 1;
          if (q && (!o || !same(q, o)) && solo && th !== 0) { next[h] = q; moved.push(h); } else if (o) next[h] = o; }   // 同一帧还有别的落子:先后分不出, 不改
        /* 改完必须一人一个英雄;有冲突(某个英雄没处可去还占着座位)就这一帧整体不改 */
        const seatsTaken = Object.values(next).map(q => q[0] + q[1]);
        if (moved.length && new Set(seatsTaken).size === seatsTaken.length)
          for (const h of moved) { const o = this.heroOf[h]; this.heroOf[h] = next[h]; delete this.orphan['hero:' + h];
            this.log.push(['hero', h, pq(next[h]), o ? `按时间顺序改判(原 ${pq(o)}):前面有一手当时没认上, 现在补上了` : '按时间顺序补上座位(当时附近的人都已有英雄, 只记了被拿走)']); } } }
    /* F. 面板英雄名 —— 英雄的第二个信号(技能有"棋盘变暗 + 面板多图标"两个信号互相核对, 英雄以前只有"棋盘卡变暗"一个, 归给谁全靠推算第几手)。
       每个人面板顶上的标题从"无英雄"变成英雄名:只在本局 12 个英雄 + "无英雄"里认, 实测 2560/1080 共 20 个面板认对 19 个,
       认错那个(1080 高亮面板)分数只有 0.17。连续两次读到同一个名字(分数 ≥0.40、领先 ≥0.10)才算确认;
       确认后以名字为准:推算错了的座位改过来, 棋盘卡没看出变暗的也补上, 之后不撤销、不按时间顺序挪。
       每帧读 3 个面板(正在选的人、上一手的人、再轮一个), 已确认的不再读;名字位置固定, 只在左边缘 x≈50 / 右边缘 x≈181、y≈7 附近 ±5 找 */
    if (!process.env.AD_NONAME) { this.nameRun = this.nameRun || {}; this.nameHero = this.nameHero || {}; this.nameRR = this.nameRR || 0;
      const named = new Set(Object.values(this.nameHero)), want = [];
      const addS = q => { if (q && !this.nameHero[seatKey(q)] && !want.some(x => same(x, q))) want.push(q); };
      addS(cur); addS(seatAt(this.turn - 1)); for (let n = 0; n < 10 && want.length < 3; n++) addS(seats[(this.nameRR++) % 10]);
      const cands = this.pool.poolHeroes.filter(h => !named.has(h)).concat([null]);
      for (const q of want) { const k = seatKey(q), r = readHeroName(img, q[0], q[1], cands, 29, { x: q[0] === 'L' ? 50 : 181, y: 7, r: 5 });
        const [sc, h] = r[0], lead = sc - (r[1] ? r[1][0] : -1);
        /* 棋盘上这张卡已经暗了(被拿走)→ 0.40 就信;卡还亮着 → 名字要 ≥0.50, 或 ≥0.40 且领先第二名 ≥0.15 才信。
           实测:候选里恰好没有真答案时(池子读漏), "蝙蝠骑士"会被认成字形相近的"混沌骑士" 0.44;认对的名字 0.46~0.62 */
        const cardDark = h && ob.takenHeroes.includes(h);
        const okName = h && (cardDark ? (sc >= 0.40 && lead >= 0.10) : ((sc >= 0.50 && lead >= 0.10) || (sc >= 0.40 && lead >= 0.15)));   // 卡还亮着:分数够高, 或者领先得够多(认错那次领先只有 0.10)
        if (okName) { const e = this.nameRun[k]; this.nameRun[k] = e && e.h === h ? { h, n: e.n + 1, t: e.t } : { h, n: 1, t: F }; } else delete this.nameRun[k];
        if (!(this.nameRun[k] && this.nameRun[k].n >= 2)) continue;
        const nh = this.nameRun[k].h, t0 = this.nameRun[k].t; this.nameHero[k] = nh; delete this.nameRun[k];
        const o = this.heroOf[nh];
        for (const x of Object.keys(this.heroOf)) if (x !== nh && same(this.heroOf[x], q)) { delete this.heroOf[x]; this.orphan['hero:' + x] = true;   // 这个座位原来按推算放的别的英雄:让出来, 交给按时间顺序重排
          this.log.push(['hero', x, '', `让出 ${pq(q)}:面板名字显示 ${pq(q)} 是 ${cn(nh)}`]); }
        this.heroOf[nh] = q.slice(); this.known.add('hero:' + nh); delete this.orphan['hero:' + nh];
        if (!(this.firstT || {})['hero:' + nh]) { this.pickT = this.pickT || {}; this.pickT['hero:' + nh] = t0; }   // 棋盘卡没看出变暗:用第一次读到名字的时刻当落子时刻
        this.log.push(['hero', nh, pq(q), o ? (same(o, q) ? `面板名字确认(${sc.toFixed(2)})` : `面板名字改判(原 ${pq(o)}, ${sc.toFixed(2)})`) : `面板名字认出(棋盘卡没看出变暗, ${sc.toFixed(2)})`]); } }
    /* E. 撤销:确认过的技能连续 6 次清清楚楚"没变"才撤(被选走的东西不会回来, 撤只可能是之前认错) */
    for (const k of Object.keys(this.owner)) if (!ob.taken[k] && !(this.forced && this.forced[k])) { this.log.push(['skill', k, pq(this.owner[k]), 'retract']); delete this.owner[k]; this.known.delete(k); }
    for (const h of Object.keys(this.heroOf)) if (!ob.takenHeroes.includes(h) && !Object.values(this.nameHero || {}).includes(h)) { this.log.push(['hero', h, pq(this.heroOf[h]), 'retract']); delete this.heroOf[h]; this.known.delete('hero:' + h); }
    for (const k of Object.keys(this.suspect)) if (!ob.taken[k]) { delete this.suspect[k]; this.known.delete(k); }
  }
  update(img) {
    if (!this.ref) this.reset(img); this.frameNo++;
    const ob = this.observe(img), pid = p => p.side + (p.idx + 1), pq = q => q[0] + (q[1] + 1), same = (a, b) => a[0] === b[0] && a[1] === b[1];
    this.attribute(img, ob, pq, same);
    this.prev = ob; return this.state(ob);
  }
  /* 给引擎的局面:**只算配对确认过的**。光棋盘变暗、还在等面板配对的不算(一两帧内就会配上);被判"不是落子"的暗图标不算;
     认不出图标的那一手占住那个人的名额(占位 key '?pick', 引擎不评它但会扣掉那个座位一个空槽)。 */
  state(ob) {
    const pk = this.pickedKeys(); const unk = this.unknownBy || [];
    const panels = ob.panels.map(p => { const q = [p.side, p.idx]; let hero = null; for (const h in this.heroOf) if (this.heroOf[h][0] === q[0] && this.heroOf[h][1] === q[1]) hero = h;
      const sk = Object.keys(this.owner).filter(k => this.owner[k][0] === q[0] && this.owner[k][1] === q[1]).map(k => ({ key: k }));
      for (const u of unk) if (u[0] === q[0] && u[1] === q[1]) sk.push({ key: '?pick' });
      return { side: p.side, idx: p.idx, hero, skills: sk, filled: p.filled }; });
    const takenHeroes = Object.keys(this.heroOf).concat(Object.keys(this.orphan || {}).filter(k => k.startsWith('hero:')).map(k => k.slice(5)));
    return { pool_heroes: this.pool.poolHeroes, skills: this.pool.skills.map(r => ({ key: r.key, taken: pk.has(r.key), ultslot: !!r.ultslot })), taken_heroes: takenHeroes, panels,
      extraPicks: unk.length, pendingPair: Object.keys(this.pend || {}).length, suspects: Object.keys(this.suspect || {}), turn: this.turn,
      current: { side: ob.current[0], idx: ob.current[1] }, me: ob.me ? { side: ob.me[0], idx: ob.me[1] } : null, my_turn: !!ob.me && ob.current[0] === ob.me[0] && ob.current[1] === ob.me[1], boxes: this.boxesNow, align: this.pool.align,
      pending: ob.pending || Object.keys(this.pend || {}).length > 0 || Object.keys(this.surSince || {}).length > 0, bulkMsg: ob.bulkMsg, flakyMsg: ob.flakyMsg, occluded: ob.occluded, offScreen: ob.offScreen, offMsg: ob.offMsg, rawDark: ob.rawDark }; }
  /* 引擎看到的"已被拿走" = 配对确认的 + 正在等面板配对的(一两帧内就会确认, 先算上免得局面来回变);被判"不是落子"的不算 */
  /* 另外:追踪中亲眼看到从亮变暗、但没配上面板的暗格(不当落子)也算"已被拿走"—— 棋盘"被选走"的判定现在很可靠(遮挡会判"看不清"),
     不算进去引擎就可能推荐一件已经没了的技能。锁池时就暗着的(例如本来就很暗的"感染")照旧不算。 */
  /* 鼠标所在的那一格(框四周各放宽 15%);cursor 由 worker 每帧给出, 全分辨率坐标 */
  hoverKey(boxes) { const c = this.cursor; if (!c || !boxes) return null; const inside = b => { const m = b[2] * 0.15; return c[0] >= b[0] - m && c[0] <= b[0] + b[2] + m && c[1] >= b[1] - m && c[1] <= b[1] + b[3] + m; };
    for (const r of this.pool.skills) if (boxes[r.cell] && inside(boxes[r.cell])) return r.key;
    for (const hb of this.pool.heroBoxes) if (boxes[hb.cell] && inside(boxes[hb.cell])) return 'hero:' + hb.hero;
    return null; }
  pickedKeys() { return new Set(Object.keys(this.owner).concat(Object.keys(this.pend || {}), Object.keys(this.suspect || {}).filter(k => this.solidDark(k)))); }
  /* "实打实被选走了":追踪中看到它从亮变暗(不是锁池时就暗着的), 之后**连续 6 次**都是"被选走"的样子, 而且不是会闪的格子。
     赛前准备阶段有格子每半秒明暗一次、鼠标提示框会瞬间盖黑一片 —— 这些连续暗不到 6 次, 不会被当成落子 */
  solidDark(k) { const t = (this.firstT || {})[k]; return t != null && t > (this.lockFrame || 1) && ((this.darkRun[k] || 0) >= 6 && !this.flaky[k] || (this.darkRun[k] || 0) >= 12); }
  /* v1.25:被标成"会闪"的格子以前永远进不了这里 —— 真机 09-14 日志:粘性炸弹赛前闪过几次被标 flaky, 之后真被选走(没配上面板 → 不当落子),
     连续暗了 60 多帧引擎还当它可选, 78 秒里一直可能被推荐。会闪的格子撑不过 12 次连续暗(完整识别十几秒), 暗满 12 次就是真被拿走 */
  /* 当前完整认定(每确认一手写一行日志, 事后能逐手对照真实阵容) */
  snapshotLine() { const seats = []; for (const side of ['L', 'R']) for (let i = 0; i < 5; i++) { const q = [side, i];
      const h = Object.keys(this.heroOf).find(x => this.heroOf[x][0] === side && this.heroOf[x][1] === i);
      const sk = Object.keys(this.owner).filter(k => this.owner[k][0] === side && this.owner[k][1] === i).map(cn);
      const u = (this.unknownBy || []).filter(x => x[0] === side && x[1] === i).length; for (let j = 0; j < u; j++) sk.push('(没认出)');
      seats.push(`${side}${i + 1}:${h ? cn(h) : '-'}|${sk.join('/') || '-'}`); }
    return seats.join('  '); }
}
module.exports = { GEO: () => GEO, boxesFor, setSource, cellState, iconScore, skillVerdict, maskedVec, selfScore, heroVerdict, slotFilled, slotSignal, cellVec, _scoreCell: (img, b) => scoreAll(cellVec(img, b)), init, rescale, SCALE: () => SC, readPool, alignBoard, takenFlags, refBrightness, readPanels, matchSkill, calibratePanels, readHeroName, quickPresence, quickSig, boardSig, fastDark, sigDiff, cellBright, cellStats, isDarkCell, Tracker, cn, OWNER: () => OWNER, LAYOUT: () => LAYOUT };
