"use strict";
/* v1.39 回归: 启动时找"上一次没正常退出的会话"日志(被任务管理器结束/卡死/崩溃)补传 */
const fs = require("fs"), path = require("path"), os = require("os"), L = require("../logupload.js");
const d = fs.mkdtempSync(path.join(os.tmpdir(), "adprev-")); let bad = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
/* 文件名里的时刻按"现在往前 ageMin 分钟"生成(补传按文件名推会话开始时刻) */
const nm = (pre, ageMin, ext) => { const t = new Date(Date.now() - ageMin * 60e3), z = n => String(n).padStart(2, "0");
  return `${pre}${t.getFullYear()}${z(t.getMonth() + 1)}${z(t.getDate())}_${z(t.getHours())}${z(t.getMinutes())}${z(t.getSeconds())}${ext}`; };
const w = (f, s, ageMin) => { const p = path.join(d, f); fs.writeFileSync(p, s); const t = new Date(Date.now() - ageMin * 60e3); fs.utimesSync(p, t, t); return p; };
const CUR = nm("ad_", 0, ".log"), PREV = nm("ad_", 60, ".log"), OLDOK = nm("ad_", 180, ".log");
const cur = w(CUR, "[12:00:00.000] start   v1.39.0\n", 0);
w(OLDOK, "[10:00:00.000] start   v1.39.0\n[10:30:00.000] stop    退出\n", 90);
ok(L.findPrevUnclean(d, cur) === null, "上一次正常退出 → 不补传");
w(PREV, "[11:00:00.000] start   v1.39.0\n[11:20:00.000] advice  预估 ...\n", 30);
w("trace_20260924030500.jsonl", "{}\n", 35); w("trace_20260923010000.jsonl", "{}\n", 2000);
const x = L.findPrevUnclean(d, cur); ok(x && x.f === PREV, "上一次没写退出 → 找到 " + (x && x.f));
const files = L.pickPrev(d, x); ok(files.length === 2 && files[1].name === "trace_20260924030500.jsonl", "只带同时段的轨迹: " + files.map(f => f.name).join(","));
fs.writeFileSync(path.join(d, "prevcrash_sent.txt"), PREV + "\n");
ok(L.findPrevUnclean(d, cur) === null, "补传过的不再传");
const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "adprev-")); const c2 = path.join(d2, "ad_20260924_120000.log"); fs.writeFileSync(c2, "");
const p3 = path.join(d2, "ad_20260920_110000.log"); fs.writeFileSync(p3, "x\n"); const t = new Date(Date.now() - 72 * 3600e3); fs.utimesSync(p3, t, t);
ok(L.findPrevUnclean(d2, c2) === null, "超过 48 小时的不补传");
if (bad) { console.log(`失败 ${bad} 项`); process.exit(1); } console.log("全部通过");
