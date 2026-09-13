"use strict";
// 当前已归属组合的模型分，不推演未来选择，也不把分数解释成个人胜率。
const path = require("path");
const { loadModel } = require("./engine/server/mcts_fast.js");
function createPlayerScorer() {
  const win = loadModel(path.join(__dirname, "engine", "public"));
  win.ADScore.ready();
  const heroes = new Map(win.AD_HEROES.map(h => [h.key, "hero:" + h.id]));
  const known = k => Object.prototype.hasOwnProperty.call(win.AD_MODEL.index, k);
  return (panels, layout) => {
    const seats = Array.from({ length: 10 }, () => []);
    const rows = seats.map((_, i) => ({ side: i < 5 ? "L" : "R", idx: i % 5, heroKnown: false, skillCount: 0, unknown: 0 }));
    for (const p of panels || []) {
      if (!["L", "R"].includes(p.side) || !Number.isInteger(p.idx) || p.idx < 0 || p.idx > 4) continue;
      const i = (p.side === "L" ? 0 : 5) + p.idx, row = rows[i];
      if (p.hero) {
        const key = heroes.get(p.hero);
        if (key && known(key)) { seats[i].push(key); row.heroKnown = true; } else row.unknown++;
      }
      const seen = new Set();
      for (const s of p.skills || []) {
        if (!s) continue;
        if (!s.key || s.key.startsWith("?") || !known(s.key)) { row.unknown++; continue; }
        if (seen.has(s.key)) continue;
        seen.add(s.key); seats[i].push(s.key); row.skillCount++;
      }
    }
    const score = win.ADScore.evaluate(seats);
    return rows.map((row, i) => {
      const p = layout.panels[row.side], r = layout.res[1] / 1440;
      // 放在面板朝棋盘的一侧，避开英雄、昵称和技能图标。
      const width = 112 * r;
      const box = [row.side === "L" ? p.x0 + 429 * r : p.x0 - width - 10 * r,
        p.y_top + row.idx * p.pitch + 12 * r, width, 176 * r];
      const v = score.seats[i], hasItems = seats[i].length > 0;
      const parts = hasItems ? { main: v.main2, synergy: v.syn2, team: v.cross, counter: v.ctr } : null;
      return { ...row, total: hasItems ? v.total : null, parts, box };
    });
  };
}
module.exports = { createPlayerScorer };
