"use strict";
/* 一键更新(v1.32)。以前每出一版都要朋友自己下补丁 zip、关插件、覆盖 resources\app —— 经常有人停在老版本。
   现在设置面板/托盘点「立即更新」:
     1. 拉服务器上的清单 upd/latest.json = { version, electron, files: { 相对路径: { h: sha256, s: 字节 } }, notes, full };
     2. 本地 resources\app 每个文件算 sha256, 和清单不一样(或没有)的才下载 —— 按内容寻址 upd/obj/<sha256>,
        所以不管从哪一版升上来都只下真正变了的文件(一般几百 KB;换模型才几十 MB);
     3. 下完逐个校验 sha256, 全部到齐才开始替换;被替换的旧文件先备份到 %APPDATA%\ADAssistant\update\backup;
     4. 替换:先写 xxx.upd_new 再改名盖过去。Windows 上正在用的 .dll/.node 盖不了但**能改名** →
        旧的改名成 xxx.upd_old_时间戳 挪开再放新的, 下次启动删掉;
     5. package.json 最后换(版本号只有全部换完才变), 中途出错 → 从备份还原已换的文件;
     6. 自动重启插件。
   清单里 electron 版本和本机不一样(要换 exe 本体)→ 不自动更新, 打开完整包下载页。
   安装目录没写权限(装在 Program Files 之类)→ 同样打开下载页。清单/对象都是静态文件, 不依赖游戏服务在不在线。 */
const fs = require("fs"), fsp = fs.promises, path = require("path"), http = require("http"), crypto = require("crypto");
const BASE = "http://43.130.62.185/ad/dl-022c0c58e9cd/";

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
/* "1.31.0" vs "1.32" → -1/0/1 */
function cmpVer(a, b) { const x = String(a).split("."), y = String(b).split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d < 0 ? -1 : 1; } return 0; }
/* 清单里的路径只允许 app 目录内的正常相对路径 */
const safeRel = r => typeof r === "string" && r.length > 0 && !r.includes("\\") && !r.startsWith("/") && !/^[A-Za-z]:/.test(r) && r.split("/").every(p => p && p !== "." && p !== "..");

function get(url, { timeout = 20e3, onData } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout, headers: { "cache-control": "no-cache" } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url.slice(BASE.length) || url}`)); }
      const chunks = []; res.on("data", c => { chunks.push(c); onData && onData(c.length); }); res.on("end", () => resolve(Buffer.concat(chunks))); res.on("error", reject); });
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", reject);
  });
}

/* opts: { appDir, dataDir, version, electron, log(tag,msg), base? } */
function create(opts) {
  const base = opts.base || BASE, appDir = opts.appDir, log = opts.log || (() => { });
  const UPDIR = path.join(opts.dataDir, "update"), STAGE = path.join(UPDIR, "stage"), BACKUP = path.join(UPDIR, "backup"), CLEAN = path.join(UPDIR, "cleanup.json");
  /* state 给设置面板看: phase = idle | checking | latest | available | needFull | downloading | installing | done | error */
  const st = { phase: "idle", current: opts.version, latest: null, notes: [], msg: "", done: 0, total: 0, checkedAt: 0, fullUrl: null };
  let manifest = null, busy = false; const subs = [];
  const emit = () => { for (const f of subs) try { f({ ...st }); } catch (e) { } };
  const set = o => { Object.assign(st, o); emit(); };

  /* 上次更新时挪开的旧 .dll/.node(当时被占用删不掉), 这次启动已经没人用了 */
  function cleanupOld() {
    let list = []; try { list = JSON.parse(fs.readFileSync(CLEAN, "utf8")) || []; } catch (e) { return; }
    const left = []; for (const p of list) { try { fs.unlinkSync(p); } catch (e) { if (e.code !== "ENOENT") left.push(p); } }
    try { if (left.length) fs.writeFileSync(CLEAN, JSON.stringify(left)); else fs.unlinkSync(CLEAN); } catch (e) { }
    try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (e) { }
    log("update", `清理上次更新留下的旧文件 ${list.length - left.length}/${list.length}`);
  }

  /* 本地和清单不一样的文件 */
  async function diffFiles(m) { const need = [];
    for (const [rel, f] of Object.entries(m.files)) {
      if (!safeRel(rel) || !f || !/^[0-9a-f]{64}$/.test(f.h)) throw new Error("清单里有非法条目 " + rel);
      let h = null; try { h = sha256(await fsp.readFile(path.join(appDir, rel))); } catch (e) { }
      if (h !== f.h) need.push({ rel, h: f.h, s: +f.s || 0 }); }
    return need; }

  async function check(quiet) {
    if (busy) return st; busy = true; if (!quiet) set({ phase: "checking", msg: "正在检查…" });
    try {
      const m = JSON.parse((await get(base + "upd/latest.json?t=" + Date.now())).toString("utf8"));
      if (!m || !m.version || !m.files || typeof m.files !== "object") throw new Error("清单格式不对");
      manifest = m; const fullUrl = m.full ? base + m.full : null;
      const newer = cmpVer(m.version, opts.version) > 0;
      const o = { latest: m.version, notes: Array.isArray(m.notes) ? m.notes.slice(0, 20).map(String) : [], checkedAt: Date.now(), fullUrl, repair: false };
      /* 版本号一样但手动点了检查: 顺便核对文件(补丁打在更老的版本上会缺模型之类), 不一致就提供"修复" */
      const bad = !newer && !quiet && cmpVer(m.version, opts.version) === 0 && (!m.electron || m.electron === opts.electron) ? await diffFiles(m) : [];
      if (bad.length) set({ ...o, phase: "available", repair: true, msg: `本地有 ${bad.length} 个文件和 v${m.version} 不一致, 点「立即更新」修复` });
      else if (!newer) set({ ...o, phase: "latest", msg: `已是最新版 v${opts.version}` });
      else if (m.electron && m.electron !== opts.electron) set({ ...o, phase: "needFull", msg: `v${m.version} 换了程序本体, 需要下载完整包重新解压(设置会保留)` });
      else set({ ...o, phase: "available", msg: `有新版本 v${m.version}` });
      log("update", `检查更新: 本机 v${opts.version} 服务器 v${m.version} → ${st.phase}`);
    } catch (e) { log("update", "检查更新失败 " + (e.message || e)); if (!quiet) set({ phase: "error", msg: "检查更新失败: " + (e.message || e) }); }
    finally { busy = false; }
    return st;
  }

  async function apply() {
    if (busy) return st;
    if (!manifest || st.phase !== "available") { await check(false); if (st.phase !== "available") return st; }
    busy = true; const m = manifest;
    const done = [];   // 已替换的 { rel, bak(有旧文件时的备份路径) }, 出错时倒着还原
    try {
      /* 0. 写权限 */
      try { const p = path.join(appDir, ".upd_probe"); fs.writeFileSync(p, "x"); fs.unlinkSync(p); }
      catch (e) { set({ phase: "needFull", msg: `安装目录不能写(${e.code || e.message}), 请手动下载完整包解压到别的文件夹(比如桌面)` }); return st; }
      /* 1. 算出要换哪些 */
      set({ phase: "downloading", msg: "对比本地文件…", done: 0, total: 0 });
      const need = await diffFiles(m);
      need.sort((a, b) => (a.rel === "package.json") - (b.rel === "package.json"));   // 版本号最后换
      const total = need.reduce((a, x) => a + x.s, 0);
      log("update", `v${opts.version} → v${m.version}: 需要换 ${need.length} 个文件 共 ${(total / 1e6).toFixed(2)}MB`);
      /* 2. 下载 + 校验(已经下好的直接用, 断了再点一次能续上) */
      fs.mkdirSync(STAGE, { recursive: true }); let got = 0;
      set({ msg: `下载 ${need.length} 个文件 (${(total / 1e6).toFixed(1)}MB)…`, done: 0, total });
      for (const x of need) {
        const sp = path.join(STAGE, x.h);
        let ok = false; try { ok = sha256(await fsp.readFile(sp)) === x.h; } catch (e) { }
        if (!ok) { let last = 0;
          const buf = await get(base + "upd/obj/" + x.h, { timeout: 60e3, onData: n => { got += n; if (Date.now() - last > 200) { last = Date.now(); set({ done: got }); } } });
          if (sha256(buf) !== x.h) throw new Error("校验失败 " + x.rel);
          await fsp.writeFile(sp, buf); got = got - buf.length + x.s; }
        else got += x.s;
        set({ done: got });
      }
      /* 3. 替换 */
      set({ phase: "installing", msg: "替换文件…" });
      const bakDir = path.join(BACKUP, `v${opts.version}`); fs.rmSync(BACKUP, { recursive: true, force: true });
      let oldList = []; try { oldList = JSON.parse(fs.readFileSync(CLEAN, "utf8")) || []; } catch (e) { }
      const stamp = Date.now().toString(36);
      for (const x of need) {
        const dst = path.join(appDir, ...x.rel.split("/")), tmp = dst + ".upd_new"; let bak = null;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (fs.existsSync(dst)) { bak = path.join(bakDir, ...x.rel.split("/")); fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.copyFileSync(dst, bak); }
        fs.copyFileSync(path.join(STAGE, x.h), tmp);
        try { fs.renameSync(tmp, dst); }
        catch (e) {   // 正在用的 dll/node:改名挪开再放
          if (!bak) throw e; const old = `${dst}.upd_old_${stamp}`; fs.renameSync(dst, old); oldList.push(old); fs.renameSync(tmp, dst);
          log("update", `${x.rel} 被占用, 旧文件挪到 ${path.basename(old)}(下次启动删)`); }
        done.push({ rel: x.rel, bak, dst });
      }
      try { fs.writeFileSync(CLEAN, JSON.stringify(oldList)); } catch (e) { }
      try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (e) { }
      log("update", `已更新到 v${m.version}(换了 ${need.length} 个文件), 备份在 ${bakDir}`);
      set({ phase: "done", msg: `已更新到 v${m.version}, 正在重启插件…`, current: m.version });
      return st;
    } catch (e) {
      /* 还原已换的(新文件删掉/旧文件拷回) */
      let back = 0; for (const d of done.reverse()) { try { if (d.bak) fs.copyFileSync(d.bak, d.dst); else fs.unlinkSync(d.dst); back++; } catch (e2) { } }
      log("update", `更新失败 ${e.stack || e}${done.length ? `, 已还原 ${back}/${done.length} 个文件` : ""}`);
      set({ phase: "error", msg: "更新失败: " + (e.message || e) + (done.length ? `(已还原, 插件仍是 v${opts.version})` : "") + " —— 可以再点一次(已下好的不用重下)" });
      return st;
    } finally { busy = false; }
  }

  return { state: () => ({ ...st }), onChange: f => subs.push(f), check, apply, cleanupOld };
}

module.exports = { create, cmpVer, sha256, safeRel, BASE };
