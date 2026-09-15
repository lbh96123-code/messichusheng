"use strict";
/* 推荐框配色(v1.23):默认 = 朋友 09-15 那套(红/黄/紫/浅蓝);cfg.look 改了立刻按新色画;画到第几名/后面写不写胜率;坏配置回默认。 */
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "overlay.html"), "utf8"), code = html.split("<script>")[1].split("</script>")[0];
const F = require("../frames.js");
const els = {}, el = id => els[id] = els[id] || { id, textContent: "", style: {} };
let strokes = [], texts = [];
const ctx = new Proxy({}, { get: (t, k) => k === "measureText" ? () => ({ width: 100 }) : k === "strokeRect" ? () => { strokes.push(t.strokeStyle); } : k === "fillText" ? (s) => { texts.push([s, t.fillStyle]); } : k === "clearRect" ? () => { strokes = []; texts = []; } : (typeof t[k] !== "undefined" ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const canvas = { getContext: () => ctx, width: 0, height: 0 }; const handlers = {};
const document = { getElementById: id => id === "c" ? canvas : el(id) };
new Function("document", "ad", "addEventListener", "innerWidth", "innerHeight", "setTimeout", "clearTimeout", code)(document, { on: (ch, f) => handlers[ch] = f }, () => {}, 1920, 864, () => 1, () => {});
const rows = Array.from({ length: 12 }, (_, i) => ({ key: "k" + i, name: "技" + i, p: 0.6 - i * 0.01, d: 0.05 - i * 0.01, box: [100 + i * 70, 100, 60, 60] }));
const adv = { type: "advice", side: "R", seat: 7, my_turn: true, base: 0.55, rows };
const active = { type: "state", phase: "active", ms: 20, current: { side: "L", idx: 0 }, me: { side: "R", idx: 2 }, taken: 3, poolOk: true, board: true };
let ok = true; const check = (what, cond) => { console.log(`${cond ? "✓" : "✗"} ${what}`); ok = ok && cond; };
const cfg = (o) => handlers.cfg({ scale: 1, all: false, paused: false, hidden: false, plname: "1 团队", version: "1.23.0", hotkey: {}, ...o });
const frameColors = () => strokes.filter(c => c !== "#000" && c !== "#ffcc33");   // 去掉黑底边和顶部横条
const rateColors = () => texts.filter(([s]) => /^\d+\.\d [+-]?\d/.test(s)).map(([, c]) => c);   // 每格底部的胜率条

cfg({}); handlers.state(active); handlers.advice(adv);
let fc = frameColors();
check("没给 look: 默认配色 = 朋友那套 红/黄/紫", fc[0] === "#ff4d4f" && fc[1] === "#ffd038" && fc[2] === "#c263ff");
check("默认 4~8 名浅蓝框(5 个), 第 9 名起不画框", fc.filter(c => c === "#80d5fb").length === 5 && fc.length === 8);
check("9 名以后只写胜率(灰), 12 条胜率都在", rateColors().length === 12 && rateColors()[11] === "#c9d1d9");
check("徽章 1/2/3 用各自的颜色", texts.some(([s, c]) => s === "1" && c === "#ff4d4f") && texts.some(([s, c]) => s === "3" && c === "#c263ff"));

cfg({ look: { c1: "#00ff00", c2: "#0000ff", c3: "#ff00ff", mid: "#ffffff", midN: 10, thick: 1.5, showRest: false } });
fc = frameColors();
check("面板改色后立刻按新色画(第一名绿)", fc[0] === "#00ff00" && fc[1] === "#0000ff" && fc[2] === "#ff00ff");
check("画到第 10 名: 白色中框 7 个", fc.filter(c => c === "#ffffff").length === 7);
check("关掉'后面只写胜率': 第 11 名起什么都不画", rateColors().length === 10);

cfg({ look: { c1: "red", midN: 99, thick: "x", showRest: "no" } });
fc = frameColors();
check("坏配置(非 #rrggbb / 超范围)逐项回默认", fc[0] === "#ff4d4f" && fc.filter(c => c === "#80d5fb").length === 7 && rateColors().length === 12);
check("norm 的边界: midN 夹在 3~10, thick 夹在 0.5~2", F.norm({ midN: 1 }).midN === 3 && F.norm({ midN: 99 }).midN === 10 && F.norm({ thick: 9 }).thick === 2 && F.norm({ thick: 0.1 }).thick === 0.5);
cfg({ live: { on: true, mode: "screen", msg: "没找到 Dota 2 窗口" } }); handlers.state(active);
check("直播模式开着: 状态行写捕获状态", /📺 直播模式: 没找到 Dota 2 窗口/.test(els.status.textContent));
cfg({ live: { on: false } }); handlers.state(active);
check("直播模式关: 状态行不提", !/直播模式/.test(els.status.textContent));
console.log(ok ? "通过" : "失败"); process.exit(ok ? 0 : 1);
