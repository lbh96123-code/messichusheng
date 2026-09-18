"use strict";
/* 组合版专用线程: 推演里要批量编码几百局 + 过显卡, 放单独线程, 不卡读屏识别和原推演。 */
const { parentPort, workerData } = require("worker_threads");
const C = require("./combo_local.js");
let ready = null, readyB = 0, curJob = 0;
/* v1.30: 预热(开组合版就在后台建会话+逐块显卡测速)、新任务来了取消旧任务(旧任务不再占着显卡跑到超时) */
const ensure = bfix => { if (!ready || readyB !== bfix) { readyB = bfix; ready = C.init(workerData.model, workerData.prefer, bfix); } return ready; };
parentPort.on("message", async m => {
  if (m.type === "warm") {
    try { const q = Date.now(), info = await ensure(m.bfix); parentPort.postMessage({ type: "warm", info, ms: Date.now() - q }); }
    catch (e) { ready = null; parentPort.postMessage({ type: "warm", err: String(e && e.message || e).slice(0, 300) }); }
    return; }
  if (m.type !== "job") return;
  curJob = m.id;
  try {
    const info = await ensure(m.bfix || m.K * m.R);
    const r = await C.decide(m.st, m.cur, m.t0, { K: m.K, R: m.R, seed: m.seed, deadline: Date.now() + m.budget, cancelled: () => curJob !== m.id });
    parentPort.postMessage({ type: "done", id: m.id, r, ep: info.ep + (info.dev != null ? "#" + info.dev : "") });
  } catch (e) { ready = null; parentPort.postMessage({ type: "err", id: m.id, msg: String(e && e.stack || e) }); }
});
