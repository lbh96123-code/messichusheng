"use strict";
/* 自动上传日志(v1.21, 托盘可关, 默认开)。
   以前排查问题要一个个找人要日志;现在插件自己在这几个时刻把"上次上传以来"的日志 + 截图 + 轨迹打成 zip 传到服务器,
   服务器存档。**插件里没有任何密码** —— 只有一个上传用的标识, 别人拿到也只能往里传, 读不到任何东西。
   什么时候传:
     · 一局选完(快选完时存了 draft_end 截图), 回到空闲 20 秒后;
     · 选技中持续 3 分钟以上、没到选完就结束了(识别中途出问题的那种), 回到空闲 20 秒后;
     · 连续锁池失败 ≥8 次, 之后 2 分钟没有新的失败(09-13 那种一直锁不上的局 —— 从来没进过选技中, 最需要日志);
     · 托盘"立即上传本次日志";
     · v1.39 启动 30 秒后: 上一次会话的日志末尾没有"退出"(被任务管理器结束/卡死/崩溃), 把那份日志 + 同时段的轨迹补传一次(why=prevcrash)。
       以前卡死那次的日志永远留在用户电脑上 —— 重启后只传新会话(09-23 飞刀卡死排查时一份都拿不到)。
   两次自动上传至少隔 5 分钟;单包 ≤25MB(先放日志, 再按新到旧放轨迹和截图)。 */
const fs = require("fs"), path = require("path"), zlib = require("zlib"), http = require("http");
const HOST = process.env.AD_LOGUP_HOST || "43.130.62.185", PORT = +process.env.AD_LOGUP_PORT || 80, PATHNAME = process.env.AD_LOGUP_PATH || "/ad/logup", KEY = "adlog-7Kq2vXe9LmP4tRz";   // 环境变量只给 test/logup_chunked.js 指向本机
const CAP = 25 * 1024 * 1024, MIN_GAP = 5 * 60e3;

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/* 最小 zip 写入器:文本 deflate, PNG 本身已压缩就直接存(省 CPU) */
function makeZip(entries) {
  const parts = [], central = []; let off = 0;
  const d = new Date(), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), store = /\.png$/i.test(e.name), body = store ? e.data : zlib.deflateRawSync(e.data, { level: 6 }), crc = crc32(e.data), method = store ? 0 : 8;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8); h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(name.length, 26);
    parts.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10); c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

/* 选文件:当前日志一定带;其余 = 上次上传以来改过的轨迹(.jsonl)和截图(.png), 新的优先, 总量不超过 CAP */
function pickFiles(logdir, logfile, since) {
  const out = []; let total = 0;
  try { const b = fs.readFileSync(logfile); out.push({ name: path.basename(logfile), data: b }); total += b.length; } catch (e) { }
  let rest = [];
  try { rest = fs.readdirSync(logdir).filter(f => /\.(png|jsonl)$/i.test(f)).map(f => { const p = path.join(logdir, f), st = fs.statSync(p); return { f, p, st }; })
    .filter(x => x.st.mtimeMs >= since).sort((a, b) => (a.f.endsWith(".jsonl") === b.f.endsWith(".jsonl") ? b.st.mtimeMs - a.st.mtimeMs : a.f.endsWith(".jsonl") ? -1 : 1)); } catch (e) { }
  for (const x of rest) { if (total + x.st.size > CAP) continue; try { const b = fs.readFileSync(x.p); out.push({ name: x.f, data: b }); total += b.length; } catch (e) { } }
  return out;
}

/* v1.38: 截图 PNG(2560×1440 每张 2~4MB)转 JPEG(同分辨率, 质量 85, 约 0.3~0.6MB)。
   09-22 整局包 8MB 左右, 跨境上传常卡住超时(当晚 46b2/8252/baa2 的整局包几乎全失败, 服务器记 499)。
   只在主进程里有 electron;测试环境没有就原样传 PNG。 */
let NI; function nativeImage() { if (NI === undefined) { try { NI = require("electron").nativeImage || null; } catch (e) { NI = null; } } return NI; }
function shrinkSnaps(files) {
  const ni = nativeImage(); if (!ni) return files;
  return files.map(f => { if (!/\.png$/i.test(f.name)) return f;
    try { const img = ni.createFromBuffer(f.data); if (img.isEmpty()) return f; const j = img.toJPEG(85); return j && j.length < f.data.length ? { name: f.name.replace(/\.png$/i, ".jpg"), data: j } : f; }
    catch (e) { return f; } });
}
/* v1.38 分块上传: 每块 512KB, 每块最多试 4 次(间隔 3/10/30 秒)。一块卡住只重传这一块, 不用从头来。
   服务器(logup.py)收齐后拼回 zip, 校验同整包上传。 */
const PART = 512 * 1024, TRIES = [0, 3e3, 10e3, 30e3];
async function postChunked(buf, headers) {
  const parts = Math.max(1, Math.ceil(buf.length / PART)), upid = require("crypto").randomBytes(8).toString("hex"); let last = null;
  for (let i = 0; i < parts; i++) {
    const body = buf.subarray(i * PART, Math.min(buf.length, (i + 1) * PART)); let ok = false;
    for (const wait of TRIES) {
      if (wait) await new Promise(r => setTimeout(r, wait));
      last = await post(body, { ...headers, "x-ad-upid": upid, "x-ad-part": String(i), "x-ad-parts": String(parts) }, 60e3);
      if (last.code === 200) { ok = true; break; }
      if (last.code >= 400 && last.code < 500) return last;   // 被服务器拒(格式/次数), 重试没用
    }
    if (!ok) return { code: last.code, body: `第${i + 1}/${parts}块失败: ${last.body}` };
  }
  return { ...last, parts };
}
function post(buf, headers, timeout) {
  return new Promise(resolve => {
    const req = http.request({ host: HOST, port: PORT, path: PATHNAME, method: "POST", timeout: timeout || 120e3,
      headers: { "content-type": "application/zip", "content-length": buf.length, "x-ad-key": KEY, ...headers } }, res => {
      let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ code: res.statusCode, body: body.slice(0, 200) })); });
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", e => resolve({ code: 0, body: String(e.message || e) }));
    req.end(buf);
  });
}

/* v1.39 找上一次没正常退出的会话: 除本次外最新的 ad_*.log, 48 小时内, 末尾 4KB 没有"退出", 且没补传过(记在 prevcrash_sent.txt) */
function findPrevUnclean(logdir, logfile) {
  let logs = [];
  try { logs = fs.readdirSync(logdir).filter(f => /^ad_\d{8}_\d{6}\.log$/.test(f) && path.join(logdir, f) !== logfile)
    .map(f => ({ f, p: path.join(logdir, f), st: fs.statSync(path.join(logdir, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs); } catch (e) { return null; }
  const x = logs[0]; if (!x || Date.now() - x.st.mtimeMs > 48 * 3600e3) return null;
  let sent = ""; try { sent = fs.readFileSync(path.join(logdir, "prevcrash_sent.txt"), "utf8"); } catch (e) { }
  if (sent.split(/\r?\n/).includes(x.f)) return null;
  let tail = ""; try { const fd = fs.openSync(x.p, "r"), n = Math.min(4096, x.st.size), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, x.st.size - n); fs.closeSync(fd); tail = b.toString("utf8"); } catch (e) { return null; }
  if (/\] stop +退出/.test(tail)) return null;
  return x;
}
function pickPrev(logdir, x) {
  const out = [{ name: x.f, data: fs.readFileSync(x.p) }]; let total = out[0].data.length;
  const m = /^ad_(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)\.log$/.exec(x.f), t0 = m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : x.st.mtimeMs - 6 * 3600e3;
  let rest = [];
  try { rest = fs.readdirSync(logdir).filter(f => /\.jsonl$/i.test(f)).map(f => ({ f, p: path.join(logdir, f), st: fs.statSync(path.join(logdir, f)) }))
    .filter(y => y.st.mtimeMs >= t0 && y.st.mtimeMs <= x.st.mtimeMs + 60e3).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs); } catch (e) { }
  for (const y of rest) { if (total + y.st.size > CAP) continue; try { const b = fs.readFileSync(y.p); out.push({ name: y.f, data: b }); total += b.length; } catch (e) { } }
  return out;
}

/* opts: { logdir, logfile, version, installId, log(tag,msg), flush(), enabled() } */
function create(opts) {
  let since = Date.now() - 60e3, lastAuto = 0, busy = false, activeSince = 0, sawEnd = false, rejects = 0, timer = null, rejectTimer = null;
  const later = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => run(why, false), ms); };
  async function run(why, manual) {
    if (busy) return;
    if (!manual && (!opts.enabled() || Date.now() - lastAuto < MIN_GAP)) return;
    busy = true; opts.flush();
    await new Promise(r => setTimeout(r, 800));   // 等日志落盘(flushLog 是 500ms 攒一批)
    const t0 = Date.now(), files = pickFiles(opts.logdir, opts.logfile, since);
    try {
      const raw = files.reduce((a, f) => a + f.data.length, 0), zip = makeZip(shrinkSnaps(files));
      const r = await postChunked(zip, { "x-ad-ver": opts.version, "x-ad-id": opts.installId, "x-ad-why": why });
      if (r.code === 200) { since = t0; if (!manual) lastAuto = Date.now(); opts.log("upload", `日志已上传(${why}) ${files.length} 个文件 ${(zip.length / 1048576).toFixed(1)}MB(原 ${(raw / 1048576).toFixed(1)}MB, 分${r.parts}块) 用时${((Date.now() - t0) / 1000).toFixed(0)}s`); }
      else opts.log("upload", `日志上传失败(${why}) HTTP ${r.code} ${r.body}`);
    } catch (e) { opts.log("upload", `日志上传出错(${why}) ${e.message || e}`); }
    finally { busy = false; }
  }
  setTimeout(async () => {
    if (!opts.enabled()) return; const x = findPrevUnclean(opts.logdir, opts.logfile); if (!x) return;
    try { fs.appendFileSync(path.join(opts.logdir, "prevcrash_sent.txt"), x.f + "\n"); } catch (e) { }
    opts.log("upload", `上一次会话 ${x.f} 没有正常退出(被结束/卡死/崩溃), 补传那份日志`);
    try { const files = pickPrev(opts.logdir, x), zip = makeZip(files);
      const r = await postChunked(zip, { "x-ad-ver": opts.version, "x-ad-id": opts.installId, "x-ad-why": "prevcrash" });
      opts.log("upload", r.code === 200 ? `上一次会话日志已补传 ${files.length} 个文件 ${(zip.length / 1048576).toFixed(1)}MB` : `上一次会话日志补传失败 HTTP ${r.code} ${r.body}`);
    } catch (e) { opts.log("upload", "上一次会话日志补传出错 " + (e.message || e)); }
  }, opts.prevDelay != null ? opts.prevDelay : 30e3);
  return {
    onPhase(p) {
      if (p === "active") { if (!activeSince) activeSince = Date.now(); rejects = 0; clearTimeout(rejectTimer); return; }
      if (!activeSince) return;
      const dur = Date.now() - activeSince; activeSince = 0;
      if (sawEnd) later(20e3, "draft_end"); else if (dur >= 180e3) later(20e3, "abnormal");
      sawEnd = false;
    },
    onLog(tag, msg) {
      if (tag === "snap" && msg.includes("(draft_end")) sawEnd = true;
      else if (tag === "pool" && msg.startsWith("拒绝(")) { rejects++; clearTimeout(rejectTimer);
        if (rejects >= 8) rejectTimer = setTimeout(() => { rejects = 0; run("nolock", false); }, 120e3); }
    },
    now() { opts.log("upload", "菜单: 立即上传本次日志"); run("manual", true); },
    /* v1.30 识别线程崩溃: 不等"一局结束"(线程死了永远等不到), 立刻传(仍听"自动上传"开关) */
    crash() { if (opts.enabled()) setTimeout(() => run("crash", true), 1500); },
  };
}
module.exports = { create, makeZip, pickFiles, postChunked, shrinkSnaps, findPrevUnclean, pickPrev };
