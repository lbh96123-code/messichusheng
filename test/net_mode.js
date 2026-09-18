"use strict";
/* v1.28 网络档: 插件里的 netProbs(从 worker.js 原样抽出) 在真实对局局面上 == PyTorch 原版网络
   用法: node test/net_mode.js game.json 手数 期望JSON(前五) */
const fs = require("fs"), path = require("path");
const APP = path.join(__dirname, ".."), E = path.join(APP, "engine", "server"), D = path.join(APP, "data");
const AI = require(E + "/ai.js"), Dr = require(E + "/draft.js");
const win = {}; new Function("window", fs.readFileSync(path.join(APP, "engine/public/ad_data.js"), "utf8"))(win); Dr.setExclusive(win.AD_EXCLUSIVE || []);
const log = (t, m) => { if (process.env.V) console.log(t, m); };
const src = fs.readFileSync(path.join(APP, "worker.js"), "utf8");
const body = src.slice(src.indexOf("let NETM = null;"), src.indexOf("function arriveNote("));
const netProbs = new Function("require", "path", "D", "E", "AI", "log", body + "; return netProbs;")(require, path, D, E, AI, log);
const [gamef, stepS, expectS, metaf] = process.argv.slice(2);
const G = JSON.parse(fs.readFileSync(gamef, "utf8")), meta = JSON.parse(fs.readFileSync(metaf, "utf8"));
const H2K = Object.fromEntries(win.AD_HEROES.map(h => ["hero:" + h.id, h.key]));
const keyOf = i => H2K[meta.keys[i]] || meta.keys[i];
const ks = G.ids.map(keyOf), inv = {}; for (const [n, p] of Object.entries(G.name2pos)) inv[ks[p]] = n;
const pool = { heroKeys: ks.slice(0, 12), basics: ks.slice(12, 48), ults: ks.slice(48), filled: [] };
const st = Dr.newState(pool), step = +stepS, ORDER = Dr.draftOrder();
for (let t = 0; t < step; t++) { const seat = st.seats[ORDER[t]], p = G.name2pos[G.picks[t]], k = ks[p];
  if (p < 12) seat.hero = k; else if (p < 48) seat.basics.push(k); else seat.ult = k; seat.seq.push(k); st.taken.push(k); }
const left = st.seats.map(s => 5 - (s.hero ? 1 : 0) - s.basics.length - (s.ult ? 1 : 0)); const order = [];
for (let j = step; j < 50; j++) { const x = ORDER[j]; if (left[x] > 0) { left[x]--; order.push(x); } }
st.order = order; st.step = 0;
const t0 = Date.now(), P = netProbs(st, ORDER[step], step), ms = Date.now() - t0;
const top = Object.entries(P).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, p]) => [inv[k], +p.toFixed(4)]);
const exp = JSON.parse(expectS); let ok = true;
exp.forEach(([n, p], i) => { if (!top[i] || top[i][0] !== n || Math.abs(top[i][1] - p) > 0.01) ok = false; });
console.log(`${ok ? "✓" : "✗"} 第${step + 1}手 插件网络档 ${JSON.stringify(top)} 用时${ms}ms\n  原版 ${JSON.stringify(exp)}`);
process.exit(ok ? 0 : 1);
