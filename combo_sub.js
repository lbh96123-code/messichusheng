"use strict";
/* 组合版多线程分片: 负责一段推演局 [b0,b1) 的 建局 → 编码 → 按网络输出抽样落子。
   和协调线程(combo_local.js)共用 SharedArrayBuffer: 编码写进去, 网络输出(logits)从里面读。 */
const { parentPort } = require("worker_threads");
const path = require("path");
const E = path.join(__dirname, "engine", "server");
const AI = require(E + "/ai.js"), F = require(E + "/mcts_fast.js");
const L = require("./combo_local.js");
let job = null;
parentPort.on("message", m => {
  try {
    if (m.type === "start") {
      const { st, cur, cands, R, b0, b1, seed, sab, t0 } = m;
      const sim0 = AI._simFrom(st), own0 = L.ownerOf(st, sim0, cur);
      const buf = L.views(sab), sims = [], owns = [], ci = [];
      for (let b = b0; b < b1; b++) { const c = Math.floor(b / R), s = F.cloneSim(sim0); F.applySim(s, cands[c]);
        const ow = Int8Array.from(own0); ow[cands[c]] = cur; sims.push(s); owns.push(ow); ci.push(c); }
      job = { sims, owns, ci, b0, b1, buf, rnd: L.rng(seed + b0 * 7919), cur, K: cands.length, nPass: 0 };
      L.encodeRange(sims, owns, t0 + 1, buf, b0);
      return parentPort.postMessage({ type: "ready", done: F.simDone(sims[0]) });
    }
    if (m.type === "step") {
      const j = job, buf = j.buf, seat = j.sims[0].order[j.sims[0].step];
      for (let k = 0; k < j.sims.length; k++) {
        const o6 = (j.b0 + k) * 60; let m2 = -Infinity;
        for (let i = 0; i < 60; i++) if (buf.legal[o6 + i] && buf.logits[o6 + i] > m2) m2 = buf.logits[o6 + i];
        let z = 0; for (let i = 0; i < 60; i++) if (buf.legal[o6 + i]) z += Math.exp(buf.logits[o6 + i] - m2);
        let u = j.rnd() * z, pick = -1;
        for (let i = 0; i < 60; i++) if (buf.legal[o6 + i]) { pick = i; u -= Math.exp(buf.logits[o6 + i] - m2); if (u <= 0) break; }
        if (pick < 0) { j.nPass++; F.passSim(j.sims[k]); continue; }   // 这个座位没有合法候选了: 空过这一手(同 combo_local)
        F.applySim(j.sims[k], pick); j.owns[k][pick] = seat;
      }
      if (F.simDone(j.sims[0])) {
        const sum = new Float64Array(j.K), sg = j.cur < 5 ? 1 : -1;
        for (let k = 0; k < j.sims.length; k++) sum[j.ci[k]] += 1 / (1 + Math.exp(-sg * j.sims[k].z));
        return parentPort.postMessage({ type: "ready", done: true, sum: Array.from(sum), nPass: j.nPass });
      }
      L.encodeRange(j.sims, j.owns, m.tAbs, buf, j.b0);
      return parentPort.postMessage({ type: "ready", done: false });
    }
  } catch (e) { parentPort.postMessage({ type: "err", msg: String(e && e.stack || e) }); }
});
