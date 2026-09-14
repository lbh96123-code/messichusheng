"use strict";
/* 自动上传日志(v1.21, 托盘可关, 默认开)。
   以前排查问题要一个个找人要日志;现在插件自己在这几个时刻把"上次上传以来"的日志 + 截图 + 轨迹打成 zip 传到服务器,
   服务器存档。**插件里没有任何密码** —— 只有一个上传用的标识, 别人拿到也只能往里传, 读不到任何东西。
   什么时候传:
     · 一局选完(快选完时存了 draft_end 截图), 回到空闲 20 秒后;
     · 选技中持续 3 分钟以上、没到选完就结束了(识别中途出问题的那种), 回到空闲 20 秒后;
     · 连续锁池失败 ≥8 次, 之后 2 分钟没有新的失败(09-13 那种一直锁不上的局 —— 从来没进过选技中, 最需要日志);
     · 托盘"立即上传本次日志"。
   两次自动上传至少隔 5 分钟;单包 ≤25MB(先放日志, 再按新到旧放轨迹和截图)。 */
const fs = require("fs"), path = require("path"), zlib = require("zlib"), http = require("http");
const HOST = "43.130.62.185", PATHNAME = "/ad/logup", KEY = "adlog-7Kq2vXe9LmP4tRz";
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

function post(buf, headers) {
  return new Promise(resolve => {
    const req = http.request({ host: HOST, port: 80, path: PATHNAME, method: "POST", timeout: 120e3,
      headers: { "content-type": "application/zip", "content-length": buf.length, "x-ad-key": KEY, ...headers } }, res => {
      let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ code: res.statusCode, body: body.slice(0, 200) })); });
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", e => resolve({ code: 0, body: String(e.message || e) }));
    req.end(buf);
  });
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
      const zip = makeZip(files);
      const r = await post(zip, { "x-ad-ver": opts.version, "x-ad-id": opts.installId, "x-ad-why": why });
      if (r.code === 200) { since = t0; if (!manual) lastAuto = Date.now(); opts.log("upload", `日志已上传(${why}) ${files.length} 个文件 ${(zip.length / 1048576).toFixed(1)}MB`); }
      else opts.log("upload", `日志上传失败(${why}) HTTP ${r.code} ${r.body}`);
    } catch (e) { opts.log("upload", `日志上传出错(${why}) ${e.message || e}`); }
    finally { busy = false; }
  }
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
  };
}
module.exports = { create, makeZip, pickFiles };
