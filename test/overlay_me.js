"use strict";
/* 覆盖层:本人座位的三种状态(v1.22)。沿用 overlay_hide.js 的假 DOM/canvas 跑 overlay.html 里的脚本。
   · 还没认出("我" = null):状态行写"我 未确定", 并单独提示一行"还没认出你是几号位 …托盘手动指定";不能因为 me 为空报错
   · 自动认出:状态行写座位, 没有"(手动)", 不再有那行提示
   · 托盘手动指定:座位后面带"(手动)" */
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "overlay.html"), "utf8"), code = html.split("<script>")[1].split("</script>")[0];
const els = {}, el = id => els[id] = els[id] || { id, textContent: "", style: {} };
const ctx = new Proxy({}, { get: (t, k) => k === "measureText" ? () => ({ width: 100 }) : (typeof t[k] !== "undefined" ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const canvas = { getContext: () => ctx, width: 0, height: 0 }; const handlers = {};
const document = { getElementById: id => id === "c" ? canvas : el(id) };
const setTimeout = () => 0, clearTimeout = () => {};
new Function("document", "ad", "addEventListener", "innerWidth", "innerHeight", "setTimeout", "clearTimeout", code)(document, { on: (ch, f) => handlers[ch] = f }, () => {}, 1920, 864, setTimeout, clearTimeout);
handlers.cfg({ scale: 0.75, all: false, paused: false, hidden: false, plname: "1 团队", version: "1.22.0", hotkey: {} });
let ok = true; const check = (what, cond, got) => { console.log(`${cond ? "✓" : "✗"} ${what}${cond ? "" : "\n   实际: " + got}`); ok = ok && cond; };
const base = { type: "state", phase: "active", ms: 20, current: { side: "L", idx: 0 }, taken: 3, poolOk: true, board: true };
let err = null; try { handlers.state({ ...base, me: null, meSource: null }); } catch (e) { err = e; }
const s0 = els.status ? els.status.textContent : "";
check("还没认出:不报错", !err, err && err.message);
check("还没认出:状态行写\"我 未确定\"", /我 未确定/.test(s0), s0);
check("还没认出:提示可以在托盘手动指定", /还没认出你是几号位/.test(s0) && /我是几号位/.test(s0), s0);
handlers.state({ ...base, me: { side: "R", idx: 4 }, meSource: "auto" });
const s1 = els.status.textContent;
check("自动认出:写\"我 R5\", 不带(手动), 提示消失", /我 R5(?!\(手动\))/.test(s1) && !/还没认出/.test(s1), s1);
handlers.state({ ...base, me: { side: "L", idx: 1 }, meSource: "manual" });
const s2 = els.status.textContent;
check("手动指定:写\"我 L2(手动)\"", /我 L2\(手动\)/.test(s2), s2);
console.log(ok ? "通过" : "失败"); process.exit(ok ? 0 : 1);
