"use strict";
/* 棋盘对齐回归(v1.21)。三件事:
   1. 具体事故帧:
      · fixtures/reject_brood_2560_0913.png —— 格 18 框被黄色角框撑成 84×78, 育母蜘蛛那行被祈求者以 0.027 反超, 13 次拒绝。
        要求:能锁池、池里有育母蜘蛛没有祈求者、那一行裕度 ≥0.1、格 18 认成 麻痹之咬 且 ≥0.5。
      · fixtures/bracket_2560_0912.png —— 同样的歪框, 格 18 干扰者"动能力场"只剩 0.11, 靠另两格才没出事。要求格 18 ≥0.5。
   2. 按分辨率统计"检出框被弃用"的格子:同一格在一半以上帧里被弃用 = 那里有固定的界面装饰(信息, 不算失败)。
   3. 弃用得对不对:被弃用的检出框, 用全库最像的分数和最终框比(亮格, 均值 ≥60, 不含英雄卡)——
      "最终框明显更好"(>0.05)的要多于"检出框明显更好"的, 且平均分差(最终−检出)>0;否则说明逐行几何算错了, 而不是检出框歪了。
   另有 1080p 开局帧:大招两行不许出现未知格(按检出框中位数算几何的那一版在这里坏过)。
   用法: node test/box_align.js */
const E = require("./_env.js"), R = E.init(), path = require("path");
let fail = 0; const ok = (c, msg) => { console.log(`${c ? "  ✓" : "  ✗"} ${msg}`); if (!c) fail++; };

console.log("== 1. 事故帧");
{ const img = E.load(path.join(__dirname, "fixtures", "reject_brood_2560_0913.png")); R.rescale(img.w, img.h);
  const t = new R.Tracker(), q = t.reset(img), P = t.pool;
  const row = P.skills.filter(s => !s.ultslot && s.hero === "npc_dota_hero_broodmother"), c18 = P.skills.find(s => s.cell === 18);
  ok(q.heroes === 12 && q.minMargin > 0.04, `09-13 能锁池 (英雄 ${q.heroes}, 最小行裕度 ${q.minMargin.toFixed(3)})`);
  ok(P.poolHeroes.includes("npc_dota_hero_broodmother") && !P.poolHeroes.includes("npc_dota_hero_invoker"), "09-13 池里有育母蜘蛛, 没有祈求者");
  ok(row.length === 3 && row[0].rowMargin >= 0.1, `09-13 育母蜘蛛那行裕度 ≥0.1 (${row.length ? row[0].rowMargin.toFixed(3) : "没认出"})`);
  ok(c18 && c18.key === "broodmother_incapacitating_bite" && c18.s1 >= 0.5, `09-13 格 18 = 麻痹之咬 ≥0.5 (${c18 && c18.key} ${c18 && c18.s1.toFixed(2)})`);
  /* 行 4 左:孽主, 格 29 火焰风暴亮着(0.87), 格 30/31 已被选走全黑(亮度 14/8)。黑格上的分数是噪声 ——
     框改对之后, 剃刀靠两个黑格上的噪声以 0.017 反超(剃刀在亮格上只有 0.43)。认英雄只能看亮格。 */
  ok(P.poolHeroes.includes("npc_dota_hero_abyssal_underlord") && !P.poolHeroes.includes("npc_dota_hero_razor"), "09-13 行 4 左是孽主, 不是剃刀(黑格不参与认英雄)"); }
{ const img = E.load(path.join(__dirname, "fixtures", "bracket_2560_0912.png")); R.rescale(img.w, img.h);
  const t = new R.Tracker(), q = t.reset(img), c18 = t.pool.skills.find(s => s.cell === 18);
  ok(q.heroes === 12 && q.minMargin > 0.04, `09-12 能锁池 (最小行裕度 ${q.minMargin.toFixed(3)})`);
  ok(c18 && c18.key === "disruptor_kinetic_field" && c18.s1 >= 0.5, `09-12 格 18 = 动能力场 ≥0.5 (${c18 && c18.key} ${c18 && c18.s1.toFixed(2)})`); }
/* 1080p 开局帧:"终极技能"行的检出框和文字标签连成一块。按检出框中位数算几何的那一版把这行 5 格弄成了"未知"(改前 0) */
{ const img = E.load(path.join(__dirname, "fixtures", "start_1080p_0911.png")); R.rescale(img.w, img.h);
  const t = new R.Tracker(), q = t.reset(img), L = R.LAYOUT(), unk = t.pool.skills.filter(s => L.board[s.cell].row <= 1 && s.unknown).map(s => s.cell);
  ok(q.heroes === 12 && q.minMargin > 0.04, `1080p 开局能锁池 (最小行裕度 ${q.minMargin.toFixed(3)})`);
  ok(unk.length === 0, `1080p 大招两行没有未知格 (${unk.length ? "未知: 格" + unk.join(",") : "0"})`); }

console.log("== 2/3. 全部真实帧:弃用的检出框(先锁池一次让逐行几何标定生效;英雄卡不算 —— 图标库没有英雄头像, 分数没意义)");
const byRes = {}; let nBright = 0, rawBetter = 0, finalBetter = 0, diffSum = 0; const worse = [];
for (const fr of E.frames()) {
  const img = E.load(fr.path); R.rescale(img.w, img.h); if (R.alignBoard(img, true).nd < 40) continue;
  R.readPool(img); const al = R.alignBoard(img, false), L = R.LAYOUT();
  const res = img.w + "x" + img.h, B = byRes[res] = byRes[res] || { frames: 0, cells: {} }; B.frames++;
  for (const d of al.dev) { B.cells[d.cell] = (B.cells[d.cell] || 0) + 1;
    if (L.board[d.cell].role === "hero" || R.cellStats(img, d.box).mean < 60) continue; nBright++;
    const sr = R.matchSkill(img, d.raw, null).s1, sb = R.matchSkill(img, d.box, null).s1;
    diffSum += sb - sr; if (sb - sr > 0.05) finalBetter++;
    if (sr - sb > 0.05) { rawBetter++; worse.push(`${fr.name} 格${d.cell} 检出${d.raw[2]}×${d.raw[3]} ${sr.toFixed(2)} > 最终${d.box[2]}×${d.box[3]} ${sb.toFixed(2)}`); } }
}
for (const res in byRes) { const B = byRes[res], sys = Object.entries(B.cells).filter(([, n]) => n * 2 >= B.frames).map(([c, n]) => `格${c}(${n}/${B.frames})`);
  console.log(`  ${res}: ${B.frames} 帧, 固定位置被弃用的格子: ${sys.join(" ") || "无"}`); }
worse.slice(0, 10).forEach(l => console.log("    检出框更好: " + l));
/* 两个方向都数:只数"检出框更好"会冤枉标定 —— 同一行里个别格子偏好小一点的框(逐格残差, 锁池后 refineBoxes 再贴), 但整行多数格子是标定框好得多 */
const meanDiff = nBright ? diffSum / nBright : 0;
ok(finalBetter > rawBetter && meanDiff > 0, `亮格里被弃用的检出框 ${nBright} 个: 最终框明显更好 ${finalBetter} 个, 检出框明显更好 ${rawBetter} 个, 平均分差(最终−检出) ${meanDiff >= 0 ? "+" : ""}${meanDiff.toFixed(3)}`);

console.log(fail ? `\n失败 ${fail} 项` : "\n全部通过");
process.exit(fail ? 1 : 0);
