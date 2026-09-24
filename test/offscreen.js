"use strict";
/* 画面不是选技棋盘的那段时间不许记账(v1.37)。
   真机 09-19 23:05:用户在选技中途切回 Dota 大厅打了 4 秒字, 棋盘位置上显示的是大厅背景和黑聊天框,
   60 格"一起变黑" → 旧版整块遮挡守卫只顶 8 帧就放行, 把 20 多件当成"被选走"且配不上归属,
   账从此烂掉(引擎算出"大家还要选 17 手"而"池子里只剩 11 样"), GPU 版推演走到"没得选"崩了 8 次。
   这里用合成帧复现同一件事:正常几帧 → 整屏压暗若干帧(其间真选走 2 件) → 画面回来。
   要求:压暗期间一件都不许记, 画面回来后把真选走的 2 件正确补上。 */
const path = require("path"), fs = require("fs");
const R = require(process.env.RECOG || "../recog.js"), S = require("./synth.js");
const D = path.join(__dirname, "..", "data"); const rd = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
R.init({ lib: { keys: JSON.parse(fs.readFileSync(D + "/lib_keys.json")), q: new Int8Array(rd(D + "/lib_i8.bin")), scale: new Float32Array(rd(D + "/lib_scale.bin")) },
  names: { tpl: JSON.parse(fs.readFileSync(D + "/names.json")), bin: new Uint8Array(fs.readFileSync(D + "/names.bin")) },
  meta: JSON.parse(fs.readFileSync(D + "/meta.json")), layout: JSON.parse(fs.readFileSync(D + "/layout_2560x1440.json")),
  bright: JSON.parse(fs.readFileSync(D + "/lib_bright.json")), heroBright: JSON.parse(fs.readFileSync(D + "/hero_bright.json")) });

const round = []; for (let i = 0; i < 5; i++) round.push(i, 5 + i);
const ORDER = []; for (let r = 0; r < 5; r++) ORDER.push(...(r % 2 ? round.slice().reverse() : round));
const H = S.pickHeroes(12, 7), K = h => S.HERO[h];
/* 大厅画面:棋盘那片位置显示的是别的东西, 整体比选技画面暗得多(真机实测 最亮格 255 → 163) */
const dim = (img, f) => { const o = { w: img.w, h: img.h, data: new Uint8Array(img.data.length) };
  for (let i = 0; i < img.data.length; i += 4) { o.data[i] = img.data[i] * f; o.data[i + 1] = img.data[i + 1] * f; o.data[i + 2] = img.data[i + 2] * f; o.data[i + 3] = 255; }
  return o; };

const t = new R.Tracker(); t.fullOrder = ORDER;
const img0 = S.render({ heroes: H, cur: ["L", 0], me: ["R", 2] });
t.reset(img0);
const nTaken = st => st.skills.filter(x => x.taken).length + st.taken_heroes.length;
const feed = img => t.update(img);

/* 1. 正常选技若干帧:没有人选东西 */
for (let i = 0; i < 4; i++) feed(S.render({ heroes: H, cur: ["L", 0], me: ["R", 2] }));
const base = nTaken(t.state(t.prev));
console.log(`正常帧后 已选走 = ${base}`);

/* 2. 切到大厅:整屏压到 0.55(比真机那次 0.64~0.68 更狠), 连续 12 帧。
      其间队友真选走了 2 件 —— 但画面上看不见, 插件这会儿不该记任何东西 */
const gone = [K(H[0]).basics[0], K(H[1]).basics[0]];
const lobby = { heroes: H, cur: ["L", 1], me: ["R", 2], taken: new Set(gone), panels: { L0: { skills: [gone[0]] }, L1: { skills: [gone[1]] } } };
let maxDuring = base;
for (let i = 0; i < 12; i++) { const st = feed(dim(S.render(lobby), 0.55)); maxDuring = Math.max(maxDuring, nTaken(st)); }
console.log(`大厅那 12 帧里 已选走最多到过 = ${maxDuring} (应当还是 ${base})`);

/* 3. 画面回来:真选走的 2 件应当补上并正确归属 */
let st = null;
for (let i = 0; i < 8; i++) st = feed(S.render(lobby));
const after = nTaken(st);
const owned = Object.keys(t.owner);
console.log(`画面回来后 已选走 = ${after}, 归属: ${owned.map(k => R.cn(k) + "→" + t.owner[k].join("")).join(" ") || "(无)"}`);

let bad = [];
if (maxDuring !== base) bad.push(`大厅期间记了账(${base} → ${maxDuring})`);
if (after !== base + 2) bad.push(`画面回来后应当是 ${base + 2} 件, 实际 ${after}`);
for (const k of gone) if (!owned.includes(k)) bad.push(`${R.cn(k)} 没有被认出/归属`);
console.log(bad.length ? "失败: " + bad.join("; ") : "通过");
process.exit(bad.length ? 1 : 0);
