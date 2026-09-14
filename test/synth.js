"use strict";
/* 合成 2560×1440 选技画面(用库图标按版式贴出来),用于离线验证识别/追踪/自动开局逻辑。
   用法(作为模块): const S = require('./synth'); const img = S.render({ heroes, taken:Set, takenHeroes:Set, cur:['L',0], me:['R',2], panels:{L0:{skills:[...],face:true}} })
   不是真实画面:颜色/边框/字体都是近似,只验证逻辑链,不验证对真实截图的鲁棒性。 */
const fs = require("fs"), path = require("path"), { PNG } = require("pngjs");
const ROOT = path.join(__dirname, "..", ".."), D = path.join(__dirname, "..", "data");
const LAYOUT = JSON.parse(fs.readFileSync(D + "/layout_2560x1440.json")), META = JSON.parse(fs.readFileSync(D + "/meta.json"));
/* 面板标题的英雄名:用插件自己的名字模板(Noto 渲染的位图, 30 号字)画上去, 位置 = 实测真实画面(左面板左边缘 x≈50、右面板右边缘 x≈181、y≈7, 相对标题区) */
const NAMES_TPL = JSON.parse(fs.readFileSync(D + "/names.json")), NAMES_BIN = new Uint8Array(fs.readFileSync(D + "/names.bin"));
function drawName(img, side, px0, py0, hero, color) { const tpls = NAMES_TPL[hero === null ? "__none" : hero] || []; const t = tpls.find(x => x.size === 30) || tpls[tpls.length - 1]; if (!t) return;
  const x0 = px0 + (side === "L" ? 60 + 50 : 130 + 181 - t.w), y0 = py0 + 7;
  for (let j = 0; j < t.h; j++) for (let i = 0; i < t.w; i++) { const a = NAMES_BIN[t.off + j * t.w + i] / 255, o = ((y0 + j) * img.w + x0 + i) * 4; if (a < 0.05) continue;
    for (let c = 0; c < 3; c++) img.data[o + c] = Math.round(img.data[o + c] * (1 - a) + color[c] * a); }
  /* 加噪声:真实画面里名字的匹配分只有 0.4~0.6(背景原画/半透明/字体微差), 不加的话合成画面是 1.00, 测不出问题 */
  let sd = (px0 * 31 + py0 * 17) | 0; const rnd = () => (sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let j = -4; j < t.h + 4; j++) for (let i = -6; i < t.w + 6; i++) { const o = ((y0 + j) * img.w + x0 + i) * 4, n = (rnd() - 0.5) * NAME_NOISE;
    for (let c = 0; c < 3; c++) img.data[o + c] = Math.max(0, Math.min(255, img.data[o + c] + n)); } }
const NAME_NOISE = +(process.env.NAME_NOISE || 280);   // 280:合成画面名字分数 ≈ 真实截图(无英雄 0.48~0.65, 英雄名 0.46~0.62)
const ICON = path.join(ROOT, "plugin", "icons");
const cache = {};
function loadPng(f) { if (cache[f]) return cache[f]; const p = PNG.sync.read(fs.readFileSync(f)); return cache[f] = { w: p.width, h: p.height, data: p.data }; }
/* mode: 数字 = 整体乘(模拟半透明遮挡, 颜色保留);"taken" = 游戏里技能被选走的样子(去色 + 压到 0.14×);"hero-taken" = 英雄卡被选走(0.08×, 近乎全黑) */
function blit(img, src, x, y, w, h, mul = 1, sx0 = 0, sy0 = 0, sw = null, sh = null) {   // 面积平均缩放贴图
  sw = sw || src.w; sh = sh || src.h;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x0 = sx0 + Math.floor(i * sw / w), x1 = Math.max(x0 + 1, sx0 + Math.floor((i + 1) * sw / w)), y0 = sy0 + Math.floor(j * sh / h), y1 = Math.max(y0 + 1, sy0 + Math.floor((j + 1) * sh / h));
    let r = 0, g = 0, b = 0, n = 0; for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const p = (yy * src.w + xx) * 4; r += src.data[p]; g += src.data[p + 1]; b += src.data[p + 2]; n++; }
    const o = ((y + j) * img.w + x + i) * 4; r /= n; g /= n; b /= n;
    if (mul === "taken") { const L = (0.299 * r + 0.587 * g + 0.114 * b) * 0.14; r = L * 0.95; g = L; b = L * 1.05; }
    else if (mul === "hero-taken") { r *= 0.08; g *= 0.08; b *= 0.08; }
    else { r *= mul; g *= mul; b *= mul; }
    img.data[o] = Math.min(255, r); img.data[o + 1] = Math.min(255, g); img.data[o + 2] = Math.min(255, b); img.data[o + 3] = 255; } }
function fill(img, x, y, w, h, rgb) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = ((y + j) * img.w + x + i) * 4; img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255; } }
function noise(img, x, y, w, h, seed) { let s = seed || 7; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = ((y + j) * img.w + x + i) * 4; const v = 60 + 120 * rnd(); img.data[o] = v; img.data[o + 1] = v * 0.9; img.data[o + 2] = v * 0.8; img.data[o + 3] = 255; } }
const HERO = Object.fromEntries(META.heroes.map(h => [h.key, h]));
function pickHeroes(n, seed) { const ks = META.heroes.filter(h => h.basics.length === 3 && h.ult && fs.existsSync(`${ICON}/full/${h.ult}.png`) && h.basics.every(b => fs.existsSync(`${ICON}/full/${b}.png`))).map(h => h.key);
  /* 候选不够就立刻报错。以前这里没有检查:找不到图标时 ks 为空, ks[s % 0] 恒为 undefined,
     while 永远凑不满 n 个 —— 同步死循环, 连一行输出都没有, 看起来像是被测的代码卡死了。
     图标按仓库外的相对路径 ../../plugin/icons 找, 仓库不在 ad-draft/app 这个位置时就会中招
     (09-13 审 PR 时在错放层级的 worktree 里实际卡过, 差点把一个没问题的 PR 判成"让 worker 卡死") */
  if (ks.length < n) throw new Error(`合成测试找不到足够的图标:要 ${n} 个英雄, 在 ${ICON} 只找到 ${ks.length} 个。` +
    `图标按仓库外的相对路径 ../../plugin/icons 查找, 请确认仓库位于 ad-draft/app 且 plugin/icons 存在`);
  let s = seed || 1; const out = []; while (out.length < n) { s = (s * 1103515245 + 12345) & 0x7fffffff; const k = ks[s % ks.length]; if (!out.includes(k)) out.push(k); } return out; }
/* cells: 行 0-1 大招(12 格, 按 heroes 顺序), 行 2-7: col0 英雄卡 A, col1-3 A 的三技能, col4-6 B 的三技能, col7 英雄卡 B; A=heroes[2*(r-2)], B=heroes[2*(r-2)+1] */
function cellKey(heroes, c) { if (c.role === "ult") return { key: HERO[heroes[c.row * 6 + c.col]].ult, hero: heroes[c.row * 6 + c.col] };
  const h = heroes[2 * (c.row - 2) + (c.col < 4 ? 0 : 1)]; if (c.role === "hero") return { key: null, hero: h }; return { key: HERO[h].basics[c.col < 4 ? c.col - 1 : c.col - 4], hero: h }; }
function render(o) {
  const img = { w: 2560, h: 1440, data: new Uint8Array(2560 * 1440 * 4) }; fill(img, 0, 0, 2560, 1440, [18, 20, 24]);
  const dx = o.dx || 0, dy = o.dy || 0; let taken = o.taken || new Set(), takenHeroes = o.takenHeroes || new Set();
  /* o.picks = [["L0", key], ["R1", "hero:npc_..."], ...]:按真实游戏的样子 —— 棋盘上那格变成选走, 他面板多一个图标(英雄不画面板) */
  if (o.picks) { taken = new Set(taken); takenHeroes = new Set(takenHeroes); o.panels = JSON.parse(JSON.stringify(o.panels || {}));
    for (const [sid, k] of o.picks) { if (k.startsWith("hero:")) { takenHeroes.add(k.slice(5)); continue; } taken.add(k);
      const pn = o.panels[sid] = o.panels[sid] || { skills: [] }; pn.skills = pn.skills || []; const isU = META.heroes.some(h => h.ult === k); if (isU) pn.skills[3] = k; else { let j = 0; while (pn.skills[j]) j++; if (j < 3) pn.skills[j] = k; } } }
  const cover = o.cover || {};   // {cellKey: 遮住的比例} 模拟鼠标/提示框盖住格子一部分
  for (const c of LAYOUT.board) { const { key, hero } = cellKey(o.heroes, c); const w = Math.round(c.w), x = Math.round(c.cx - w / 2) + dx, y = Math.round(c.cy - w / 2) + dy;
    const dark = key ? taken.has(key) : takenHeroes.has(hero); const mul = dark ? (o.darkMul != null ? o.darkMul : (key ? "taken" : "hero-taken")) : 1;
    if (key) blit(img, loadPng(`${ICON}/full/${key}.png`), x, y, w, w, mul);
    else { const src = loadPng(`${ICON}/heroes_land/${hero}.png`); blit(img, src, x, y, w, w, mul, 28, 0, 72, 72); }
    const cv = key && cover[key]; if (cv) fill(img, x, y + Math.round(w * (1 - cv)), w, Math.round(w * cv), [12, 12, 14]); }
  for (const side of ["L", "R"]) { const P = LAYOUT.panels[side];
    for (let i = 0; i < 5; i++) { const px0 = P.x0 + dx, py0 = P.y_top + P.pitch * i + dy, pw = 419, ph = P.pitch; const id = side + i;
      const isCur = o.cur && o.cur[0] === side && o.cur[1] === i, isMe = o.me && o.me[0] === side && o.me[1] === i;
      const col = isCur ? [210, 200, 170] : [70, 70, 75]; fill(img, px0, py0, pw, ph, col); fill(img, px0 + 6, py0 + 6, pw - 12, ph - 12, [30, 32, 38]);
      /* 本人绿框:真实游戏里是英雄头像那一侧的一条亮绿竖线(L 面板左边、R 面板右边), 轮到自己选时也在(v1.22 按真实截图改) */
      if (isMe) fill(img, side === "L" ? px0 : px0 + pw - 6, py0, 6, ph, [40, 200, 40]);
      /* 空技能槽:真实游戏里近乎纯黑(09-11 实测 1080p/1440p 整格平均 2~6, 高亮面板 15~18, 最亮一格 ≤13), 不是面板底色 */
      for (const [sx, sy, sw] of P.slots) { const x0 = Math.max(px0 + sx, px0 + 6), x1 = Math.min(px0 + sx + sw, px0 + pw - 6); fill(img, x0, py0 + sy, x1 - x0, sw, isCur ? [14, 14, 16] : [4, 4, 5]); }   // 不压到面板边框(高亮检测量的是边框)
      const pan = (o.panels || {})[id] || {};
      (pan.skills || []).forEach((k, j) => { if (!k) return; const [sx, sy, sw] = P.slots[j]; blit(img, loadPng(`${ICON}/full/${k}.png`), px0 + sx, py0 + sy, sw, sw); });
      if (o.names !== undefined) drawName(img, side, px0, py0, (o.names || {})[id] || null, side === "L" ? [110, 230, 110] : [230, 90, 80]);   // o.names = {L0: heroKey}, 没有的画"无英雄"
      if (pan.face) { const [ax0, ay0, ax1, ay1] = side === "L" ? [10, 100, 130, 215] : [290, 100, 410, 215]; noise(img, px0 + ax0, py0 + ay0, ax1 - ax0, ay1 - ay0, i * 31 + (side === "L" ? 1 : 2)); } } }
  return img;
}
function save(img, f) { const p = new PNG({ width: img.w, height: img.h }); p.data = Buffer.from(img.data.buffer); fs.writeFileSync(f, PNG.sync.write(p)); }
module.exports = { render, save, pickHeroes, cellKey, HERO, LAYOUT };
if (require.main === module) { const heroes = pickHeroes(12, 3); const img = render({ heroes, cur: ["L", 0], me: ["R", 2] }); save(img, process.argv[2] || "/tmp/synth.png"); console.log(heroes.join(" ")); }
