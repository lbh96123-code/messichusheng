"use strict";
/* AD 选技助手 v0.2 主进程:托盘 + 截屏 + 覆盖窗 + 日志。识别/引擎都在 worker.js 线程里。
   v0.2 相对 v0.1:去掉 forward:true(它在 Windows 上装全局底层鼠标钩子,主线程一忙全系统鼠标就卡);
   没看到棋盘时只截半分辨率小图、1.5 s 一帧、覆盖窗隐藏;开局自动锁池子不用按 F10;日志落盘。 */
const { app, BrowserWindow, screen, desktopCapturer, Tray, Menu, globalShortcut, nativeImage, shell, ipcMain, session } = require("electron");
const path = require("path"), fs = require("fs"); const { Worker } = require("worker_threads");
const VERSION = require("./package.json").version;
let overlay = null, tray = null, worker = null, timer = null, snapOnce = false, uploader = null, panelWin = null;
const ADFrames = require("./frames.js");   // 推荐框配色/范围/粗细(和覆盖层、设置面板共用)
const HOTKEY = { "隐藏/显示": "F6", "切换显示模式": "F8", "暂停/继续": "F9", "重新识别": "F10", "团队/个人优先": "F7" };   // 实际注册成功的键(可能退让到 Alt+F8 等)
/* 两个**互相独立**的开关:
     test —— 运行模式。只管截图和日志的详细程度, 不改变任何判断逻辑。任何版本都能切。
     core —— 状态估计内核, "1x"(稳定) 或 "v2"(试验)。只管谁来判断"被拿走了没有 / 归谁"。
   两者不耦合:测试模式不会替你换内核, 换内核也不会替你改截图策略。 */
const cfg = { all: false, paused: false, plevel: 0, hidden: false, showPlayerScores: true, test: false, core: "1x", meSeat: "auto" };   // meSeat = "auto" 或手动指定的 "L1".."R5"(只对当前这一局有效)
let meShown = null;   // 最近一次状态里的本人座位(托盘菜单上显示)   // plevel 0..3 = 界面上的 1~4 档;hidden = 一键隐藏(只藏显示, 识别/计算照常跑)
const PLN = ["1 团队", "2 略偏个人", "3 偏个人", "4 贪"]; let needFull = true, phase = "idle", lastStatus = "", boardSeen = false, capN = 0, capMs = 0, capMsFull = 0, capFull = 0;
/* ---- 日志:%APPDATA%/ADAssistant/logs/ad_YYYYMMDD_HHMMSS.log,截图也放这里 ---- */
const LOGDIR = path.join(app.getPath("userData"), "logs"); fs.mkdirSync(LOGDIR, { recursive: true });
const stamp = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
const LOGFILE = path.join(LOGDIR, `ad_${stamp(new Date())}.log`); let logBuf = [], logTimer = null;
function log(tag, msg) { const d = new Date(); const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  logBuf.push(`[${t}] ${tag.padEnd(7)} ${msg}\n`); if (!logTimer) logTimer = setTimeout(flushLog, 500); if (uploader) uploader.onLog(tag, msg); }
function flushLog() { logTimer = null; if (!logBuf.length) return; const s = logBuf.join(""); logBuf = []; try { fs.appendFileSync(LOGFILE, s); } catch (e) { } }
function pruneLogs() { try { const now = Date.now(); const fsz = fs.readdirSync(LOGDIR).map(f => ({ f, p: path.join(LOGDIR, f), st: fs.statSync(path.join(LOGDIR, f)) }));
  for (const x of fsz) if ((x.f.endsWith(".log") || x.f.endsWith(".jsonl")) && now - x.st.mtimeMs > 7 * 86400e3) fs.unlinkSync(x.p);
  const pngs = fsz.filter(x => x.f.endsWith(".png")).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs); for (const x of pngs.slice(12)) fs.unlinkSync(x.p); } catch (e) { } }
/* ---- 设置落盘(userData/settings.json):目前只有"自动上传日志"开关和随机安装号 —— 朋友关掉以后重启不能又自己打开 ---- */
const SETFILE = path.join(app.getPath("userData"), "settings.json"); let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETFILE, "utf8")) || {}; } catch (e) { }
if (!settings.installId) settings.installId = require("crypto").randomBytes(6).toString("hex");
if (settings.uploadLogs === undefined) settings.uploadLogs = true;
settings.look = ADFrames.norm(settings.look);   // v1.23:推荐框的颜色等, 缺的补默认、坏的丢掉
if (settings.allowCapture === undefined) settings.allowCapture = false;   // v1.24 直播模式:让直播/录屏软件能抓到覆盖层
const saveSettings = () => { try { fs.writeFileSync(SETFILE, JSON.stringify(settings, null, 1)); } catch (e) { } }; saveSettings();
uploader = require("./logupload.js").create({ logdir: LOGDIR, logfile: LOGFILE, version: VERSION, installId: settings.installId, log, flush: () => flushLog(), enabled: () => settings.uploadLogs });
/* ---- 托盘图标 ---- */
function makeTrayIcon() { const { PNG } = require("pngjs"); const p = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i = (y * 16 + x) * 4; const on = (x > 1 && x < 14 && y > 1 && y < 14); p.data[i] = on ? 0xff : 0; p.data[i + 1] = on ? 0xd7 : 0; p.data[i + 2] = on ? 0x6a : 0; p.data[i + 3] = on ? 255 : 0; }
  return nativeImage.createFromBuffer(PNG.sync.write(p)); }
/* ---- 覆盖窗:透明、置顶、穿透。**常驻显示,不隐藏** ——
   隐藏后再 show 抢不回独占全屏游戏之上(用户实测:切出去再回来插件就"消失"了)。
   不需要显示时画空内容即可,一个全透明窗口几乎不花钱。 */
function createOverlay() {
  const d = screen.getPrimaryDisplay(); const b = d.bounds;
  /* 覆盖上方 90%：第五位玩家旁的竖向评分明细底部约在 89%。 */
  const ovH = Math.round(b.height * 0.9);
  overlay = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: ovH, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, resizable: false, focusable: false, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  overlay.setAlwaysOnTop(true, "screen-saver"); overlay.setIgnoreMouseEvents(true); overlay.setContentProtection(true);   // 不出现在截屏里(直播模式下窗口捕获接通后才放开);不要 forward:true
  overlay.loadFile("overlay.html"); overlay.webContents.on("did-finish-load", () => { overlay.showInactive(); sendCfg(); });
  /* 游戏切换独占全屏/别的置顶窗口出现后,置顶属性可能被顶掉,定期重申一次 */
  setInterval(() => { if (overlay && !overlay.isDestroyed()) { if (!overlay.isVisible()) overlay.showInactive(); overlay.setAlwaysOnTop(true, "screen-saver"); } }, 5000);
}
const send = (ch, m) => { if (overlay && !overlay.isDestroyed()) overlay.webContents.send(ch, m); };
/* scale = 识别坐标(≤2560 宽) → 覆盖窗 DIP 坐标 的比例 */
function sendCfg() { const cs = capSize(); send("cfg", { scale: cs.w / cs.dipW, all: cfg.all, paused: cfg.paused, hidden: cfg.hidden, showPlayerScores: cfg.showPlayerScores, plevel: cfg.plevel, plname: PLN[cfg.plevel], version: VERSION, phase, hotkey: HOTKEY, test: cfg.test, core: cfg.core, meSeat: cfg.meSeat, look: settings.look, live: liveInfo() }); sendPanel(); }
function setVisible(v) { if (!overlay || overlay.isDestroyed()) return; if (!overlay.isVisible()) overlay.showInactive();
  if (v) overlay.setAlwaysOnTop(true, "screen-saver"); else send("clear", {}); }
/* ---- 截屏 ----
   首选:常驻屏幕视频流(隐藏窗口里的 getDisplayMedia,和 OBS/Discord 一样),取一帧只是一次 GPU 缩放 + 像素读回。
   回退:老的 desktopCapturer.getSources(),每次都要重新枚举屏幕并整屏拷贝,实测一次 ~235ms —— 这是 v0.5 吃 CPU 的元凶。
   扫描帧 1/4 分辨率(只用来量 60 格明暗),需要完整识别时才要全分辨率。 */
let capWin = null, capReady = false, capDead = false, capSeq = 0; const capWait = new Map();
function createCapture() {
  capWin = new BrowserWindow({ show: false, width: 200, height: 120, webPreferences: { preload: path.join(__dirname, "cap_preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  capWin.loadFile("capture.html");
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const d = screen.getPrimaryDisplay();
    try {
      /* 直播模式:抓**游戏窗口**而不是整个屏幕 —— 窗口捕获只拿那个窗口自己的画面, 盖在上面的覆盖层不会进来,
         这样覆盖层才能放开防捕获(让直播软件抓到)而不污染自己的识别。找不到游戏窗口就先抓屏幕、覆盖层继续防捕获, 每 5 秒再找。 */
      if (settings.allowCapture && !liveBlocked) { const w = await findGameWindow();
        if (w) { setCapMode("window", `已捕获游戏窗口「${w.name}」, 覆盖层可被直播/录屏软件抓到`); log("cap", `视频流选定窗口: ${w.name} (${w.id})`); return callback({ video: w }); }
        setCapMode("screen", "没找到 Dota 2 窗口, 先抓屏幕(覆盖层暂时仍不可被抓到), 进游戏后自动切换"); }
      else setCapMode("screen", liveBlocked ? liveMsg : "");
      const src = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
      const s = src.find(x => String(x.display_id) === String(d.id)) || src[0]; log("cap", `视频流选定屏幕: ${s ? s.name : "无"}`); callback(s ? { video: s } : {});
    } catch (e) { log("cap", "选源失败 " + e); callback({}); }
  }, { useSystemPicker: false });
  ipcMain.on("cap-ready", (e, m) => { capReady = true; capDead = false; capRestartAt = 0; log("cap", `${capMode === "window" ? "窗口" : "屏幕"}视频流已就绪 ${m.w}x${m.h}(常驻流模式)`); });
  ipcMain.on("cap-frame", (e, m) => { const w = capWait.get(m.id); if (w) { capWait.delete(m.id); w({ w: m.w, h: m.h, buf: m.buf, bgra: false }); } });
  ipcMain.on("cap-fail", (e, m) => { const w = m.id != null && capWait.get(m.id); if (w) { capWait.delete(m.id); w(null); }
    if (m.id == null && capRestartAt && Date.now() - capRestartAt < 3000) return;   // 重开流时旧页面的收尾消息, 不算流坏
    if (!capDead) { capDead = true; capReady = false; log("cap", `视频流不可用(${m.msg}),回退到 desktopCapturer 逐帧截屏`); } });
  armCapTimeout();
}
function armCapTimeout() { setTimeout(() => { if (!capReady && !capDead) { capDead = true; log("cap", "视频流 8 秒未就绪,回退到 desktopCapturer 逐帧截屏"); } }, 8000); }
/* ---- 直播模式(v1.24) ----
   覆盖窗的防捕获(setContentProtection)是 Windows 的 SetWindowDisplayAffinity, 对**所有**捕获一视同仁:直播软件抓不到, 插件自己也抓不到。
   要让直播软件抓到, 就得放开它;放开后插件自己的截屏就会看见自己画的框(胜率条压在格子底部、徽章压在角上), 识别会被污染。
   出路:直播模式下插件自己改抓**游戏窗口**(窗口捕获只拿那个窗口自己的画面), 接通后再放开防捕获。
   独占全屏的游戏窗口捕获拿到的是黑屏 → 连续 40 帧近黑就退回屏幕捕获 + 重新防捕获, 提示改无边框窗口。 */
let capMode = "screen", liveMsg = "", liveBlocked = false, capRestartAt = 0, livePoll = null, blackRun = 0;
function liveInfo() { return { on: !!settings.allowCapture, mode: capMode, msg: liveMsg }; }
function setCapMode(mode, msg) { const changed = mode !== capMode || msg !== liveMsg; capMode = mode; liveMsg = msg;
  if (overlay && !overlay.isDestroyed()) overlay.setContentProtection(!(settings.allowCapture && mode === "window"));
  if (changed) { log("live", `捕获源=${mode} 防捕获=${!(settings.allowCapture && mode === "window") ? "开" : "关"} ${msg}`); sendCfg(); } }
async function findGameWindow() {
  const src = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
  const own = /AD 选技助手|ADAssistant|^cap$/;
  return src.find(x => /^dota\s*2$/i.test(x.name.trim()) && !own.test(x.name)) || src.find(x => /dota\s*2/i.test(x.name) && !own.test(x.name)) || null; }
function restartCapture(why) { if (!capWin || capWin.isDestroyed()) return; log("cap", `重开视频流: ${why}`);
  for (const [id, w] of capWait) { capWait.delete(id); w(null); }
  capReady = false; capDead = false; capRestartAt = Date.now(); blackRun = 0; capWin.webContents.reload(); armCapTimeout(); }
function applyLive(why, restart = true) { liveBlocked = false; blackRun = 0;
  if (livePoll) { clearInterval(livePoll); livePoll = null; }
  if (settings.allowCapture) {
    /* 还没进游戏时找不到窗口:每 5 秒再找, 找到就重开流切到窗口捕获 */
    livePoll = setInterval(async () => { if (!settings.allowCapture || liveBlocked || capMode === "window") return;
      try { const w = await findGameWindow(); if (w) restartCapture("直播模式找到了游戏窗口"); } catch (e) { } }, 5000);
  }
  if (restart) restartCapture(why); if (!settings.allowCapture) setCapMode("screen", ""); }
/* 窗口捕获拿到黑屏(独占全屏)的看门狗:只看扫描帧, 每 64 个像素采一个 */
function liveBlackCheck(f) { if (capMode !== "window" || !f || liveBlocked) return; const u8 = new Uint8Array(f.buf); let sum = 0, n = 0;
  for (let i = 0; i < u8.length; i += 256) { sum += u8[i] + u8[i + 1] + u8[i + 2]; n++; }
  if (sum / (3 * n) < 3) { if (++blackRun >= 40) { liveBlocked = true; log("live", "窗口捕获连续 40 帧黑屏(独占全屏?), 退回屏幕捕获并重新防捕获");
      restartCapture("窗口捕获黑屏"); setCapMode("screen", "窗口捕获拿到的是黑屏(游戏是独占全屏?), 已退回屏幕捕获、覆盖层重新不可被抓到。把游戏改成无边框窗口, 再关开一次直播模式"); } }
  else blackRun = 0; }
function grabStream(tw, th) {   // 从常驻流取一帧;1.5 秒没回来就判定流坏了
  return new Promise(resolve => { const id = ++capSeq; capWait.set(id, resolve);
    setTimeout(() => { if (capWait.delete(id)) { if (!capDead) { capDead = true; capReady = false; log("cap", "取帧超时,回退到 desktopCapturer 逐帧截屏"); } resolve(null); } }, 1500);
    capWin.webContents.send("cap-grab", { id, w: tw, h: th }); });
}
/* 扫描帧的缩小倍数:选技中只用来量 60 格明暗 → 1/8 就够(2560×1440 → 320×180, 一帧 230KB);
   空闲时还要靠"格子间隙是不是暗的"判断有没有棋盘, 1px 宽的间隙条在 1/8 下糊成一团 → 用 1/4。 */
const scanDiv = () => (phase === "active" ? 8 : 4);
/* 识别用的"全分辨率"最多 2560 宽:版式和英雄名模板都是按 1440p 标定的, 4K 屏先在 GPU 上缩到 2560 再识别 ——
   实测朋友 4K 截图缩到 2560 后逐格匹配分更高(编织者 0.48→0.76), 锁池 3.2s→1.8s, 一帧读回 33MB→15MB。 */
function capSize() { const d = screen.getPrimaryDisplay(); const W = Math.round(d.bounds.width * d.scaleFactor), H = Math.round(d.bounds.height * d.scaleFactor);
  const w = Math.min(W, 2560); return { w, h: Math.round(H * w / W), W, H, dipW: d.bounds.width }; }
async function grab(full) {
  const cs = capSize(), W0 = cs.w, H0 = cs.h;
  const n = scanDiv();
  if (capReady && !capDead) { const f = await grabStream(full ? W0 : Math.round(W0 / n), full ? H0 : Math.round(H0 / n)); if (f) return f; }
  return grabLegacy(full);
}
async function grabLegacy(full) {
  const d = screen.getPrimaryDisplay(); const { w: W, h: H } = capSize();
  const n = scanDiv(); const tw = full ? W : Math.round(W / n), th = full ? H : Math.round(H / n);
  let s = null;
  if (settings.allowCapture && !liveBlocked) {   // 直播模式:逐帧路也抓游戏窗口(要给所有窗口出缩略图, 慢, 但这条路本来就是兜底)
    const ws = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: tw, height: th }, fetchWindowIcons: false });
    s = ws.find(x => /^dota\s*2$/i.test(x.name.trim())) || ws.find(x => /dota\s*2/i.test(x.name)) || null;
    if (s && capMode !== "window") setCapMode("window", `已捕获游戏窗口「${s.name}」(逐帧截屏), 覆盖层可被直播/录屏软件抓到`);
    if (!s && capMode !== "screen") setCapMode("screen", "没找到 Dota 2 窗口, 先抓屏幕(覆盖层暂时仍不可被抓到)"); }
  if (!s) { const src = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: tw, height: th }, fetchWindowIcons: false });
    s = src.find(x => String(x.display_id) === String(d.id)) || src[0]; } if (!s) return null;
  const img = s.thumbnail; const sz = img.getSize(); const buf = img.toBitmap();   // Windows/Linux: BGRA
  return { w: sz.width, h: sz.height, buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), bgra: true };
}
function startWorker() {
  worker = new Worker(path.join(__dirname, "worker.js"));
  worker.postMessage({ type: "logdir", dir: LOGDIR });   // 观测轨迹和日志/截图放一起
  { const cs = capSize(); worker.postMessage({ type: "display", w: cs.w, h: cs.h }); }
  worker.on("message", m => {
    if (m.type === "log") return log(m.tag, m.msg);
    if (m.type === "meManualReset") { cfg.meSeat = "auto"; sync(); return; }   // 换了一局, 手动指定的座位作废
    if (m.type === "want") { if (m.full) needFull = true; if (m.phase && m.phase !== phase) { phase = m.phase; uploader.onPhase(phase); log("cap", phase === "active" ? "选技中: 每 250ms 一张半分辨率扫描帧, 需要时补全分辨率" : "空闲: 每 1.5s 一张半分辨率"); setVisible(phase === "active"); sendCfg(); } return; }
    /* 截图由工作线程送来**裸像素**(它只做一次拷贝就转移过来), PNG 编码放在这里做 ——
       编码要几百毫秒, 放在工作线程会卡住识别, 放这里最多让截屏拍子晚一拍。 */
    if (m.type === "snapshot") { const f = path.join(LOGDIR, `snap_${stamp(new Date())}_${m.why}.png`);
      setImmediate(() => { try { const { PNG } = require("pngjs");
        const p = new PNG({ width: m.w, height: m.h, deflateLevel: 1 }); p.data = Buffer.from(m.raw);
        fs.writeFileSync(f, PNG.sync.write(p, { deflateLevel: 1 })); log("snap", `已存 ${path.basename(f)} (${m.why}, ${m.w}x${m.h})`);
      } catch (e) { log("snap", "存失败 " + e); } }); return; }
    if (m.type === "state") { if (m.phase && m.phase !== phase) { phase = m.phase; uploader.onPhase(phase); setVisible(phase === "active"); sendCfg(); }
      if (!m.idle) { const ms = m.me ? `${m.me.side === "L" ? "左" : "右"}${m.me.idx + 1}` : null; if (ms !== meShown) { meShown = ms; tray && tray.setContextMenu(buildMenu()); } }
      if (!!m.board !== boardSeen) boardSeen = !!m.board;
      const st = m.idle ? `idle 亮${m.pres && m.pres.bright} 暗${m.pres && m.pres.dark}` : `active 当前${m.current.side}${m.current.idx + 1} 我${m.me ? m.me.side + (m.me.idx + 1) + (m.meSource === "manual" ? "(手动)" : "") : "未确定"}`; if (st !== lastStatus) { lastStatus = st; tray && tray.setToolTip(`AD 选技助手 v${VERSION}${cfg.hidden ? " · 已隐藏" : ""} · ${st}`); sendPanel(); } }
    if (m.type === "advice" || m.type === "state" || m.type === "clear" || m.type === "error" || m.type === "computing") send(m.type, m);
    if (m.type === "error") log("error", m.msg);
  });
  worker.on("error", e => { log("error", "worker " + e); send("error", { msg: String(e) }); });
  worker.on("exit", c => log("error", "worker 退出 " + c));
}
let inflight = false, sameRun = 0, lastHash = 0;
const frameHash = buf => { const u8 = new Uint8Array(buf); let h = 0; for (let i = 0; i < u8.length; i += 997) h = (h * 31 + u8[i]) | 0; return h; };
async function loop() {
  if (cfg.paused || inflight) return; inflight = true;
  const full = needFull; needFull = false;
  try { const t0 = Date.now(); const f = await grab(full); const dt = Date.now() - t0; capN++;
    if (full) { capFull++; capMsFull += dt; } else capMs += dt;
    if (capN % 240 === 0) log("cap", `近 ${capN} 次截屏(${capReady && !capDead ? "常驻流" : "逐帧"}): 扫描帧 ${capN - capFull} 次均 ${(capMs / Math.max(1, capN - capFull)).toFixed(0)}ms, 全分辨率 ${capFull} 次均 ${(capMsFull / Math.max(1, capFull)).toFixed(0)}ms`);
    if (f && !full) liveBlackCheck(f);
    if (f && capReady && !capDead) {   // 流冻结(隐藏窗口被系统暂停)不会报错, 只会一直给同一帧 → 靠"画面一动不动"识破
      const h = frameHash(f.buf); if (h === lastHash) sameRun++; else { sameRun = 0; lastHash = h; }
      if (sameRun >= 60 && phase === "active") { capDead = true; capReady = false; sameRun = 0; log("cap", "视频流连续 60 帧一模一样, 判定已冻结, 回退到逐帧截屏"); } }
    /* 鼠标位置(换算到识别用的全分辨率坐标):鼠标悬停的那一格游戏会弹介绍框/变样子, 识别端把它当"看不清" */
    let cursor = null; try { const cp = screen.getCursorScreenPoint(), d = screen.getPrimaryDisplay(), cs = capSize();
      cursor = [(cp.x - d.bounds.x) * cs.w / d.bounds.width, (cp.y - d.bounds.y) * cs.h / d.bounds.height]; } catch (e) { }
    if (f && worker) { const snap = snapOnce; snapOnce = false; worker.postMessage({ type: "frame", ...f, full, all: cfg.all, plevel: cfg.plevel, meSeat: cfg.meSeat, snap, cursor, test: cfg.test, core: cfg.core }, [f.buf]); } }
  catch (e) { needFull = needFull || full; log("error", "截屏 " + e); send("error", { msg: String(e) }); }
  finally { inflight = false; }
}
/* 选技中 500ms 一拍(足够在半秒内抓到"前一位落子");看到棋盘还没锁上 700ms;空闲 2s 一拍。
   注意:一次 desktopCapturer 截屏在实测机器上要 ~200ms, 拍子再密就是让截屏管线满负荷空转(用户实测 CPU 10%)。 */
function schedule() { if (timer) clearInterval(timer); let cur = null;
  const tick = () => { const fast = capReady && !capDead;   // 常驻流取一帧只有几毫秒, 可以拍得密;逐帧截屏一次 ~235ms, 必须拍慢
    const want = phase === "active" ? (fast ? 250 : 600) : (boardSeen ? (fast ? 500 : 800) : 2000);
    if (want !== cur) { cur = want; clearInterval(timer); timer = setInterval(() => { loop(); tick(); }, want); } };
  tick(); }
/* ---- 设置面板(v1.23):双击托盘图标打开。所有开关一屏全在, 颜色改了游戏里立刻变。
   置顶显示, 这样无边框窗口化的游戏上面也能看到;独占全屏的游戏会被切出去, 这是系统行为, 和托盘菜单一样。 ---- */
function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return; }
  panelWin = new BrowserWindow({ width: 560, height: 720, title: `AD 选技助手 v${VERSION} · 设置`, alwaysOnTop: true, autoHideMenuBar: true, resizable: true, minimizable: true, maximizable: false, backgroundColor: "#1b1f27", show: false,
    webPreferences: { preload: path.join(__dirname, "settings_preload.js"), contextIsolation: true, nodeIntegration: false } });
  panelWin.loadFile("settings.html"); panelWin.once("ready-to-show", () => panelWin.show());
  panelWin.on("closed", () => { panelWin = null; }); log("panel", "打开设置面板");
}
function sendPanel() { if (!panelWin || panelWin.isDestroyed()) return;
  panelWin.webContents.send("panel", { all: cfg.all, paused: cfg.paused, hidden: cfg.hidden, showPlayerScores: cfg.showPlayerScores, plevel: cfg.plevel, plname: PLN[cfg.plevel], version: VERSION, phase, hotkey: HOTKEY,
    test: cfg.test, core: cfg.core, meSeat: cfg.meSeat, look: settings.look, uploadLogs: settings.uploadLogs, allowCapture: settings.allowCapture, live: liveInfo(), meShown, status: lastStatus }); }
ipcMain.on("panel-ready", () => sendPanel());
ipcMain.on("panel-set", (e, m) => { if (!m || typeof m !== "object") return; const { k, v } = m;
  if (["all", "paused", "hidden", "showPlayerScores", "test"].includes(k)) cfg[k] = !!v;
  else if (k === "plevel") cfg.plevel = Math.min(3, Math.max(0, Math.round(+v) || 0));
  else if (k === "core") cfg.core = v === "v2" ? "v2" : "1x";
  else if (k === "meSeat") cfg.meSeat = /^[LR][1-5]$/.test(String(v)) ? String(v) : "auto";
  else if (k === "uploadLogs") { settings.uploadLogs = !!v; saveSettings(); }
  else if (k === "look") { settings.look = ADFrames.norm(v); saveSettings(); }
  else if (k === "allowCapture") { settings.allowCapture = !!v; saveSettings(); applyLive(`面板${v ? "开" : "关"}直播模式`); }
  else return;
  log("panel", `设置面板改 ${k}=${k === "look" ? JSON.stringify(settings.look) : v}`); sync();
  if (k === "hidden") tray.setToolTip(`AD 选技助手 v${VERSION}${cfg.hidden ? " · 已隐藏" : ""} · ${lastStatus}`); });
ipcMain.on("panel-act", (e, m) => { const name = m && m.name;
  if (name === "reset") { log("key", "面板: 重新识别"); worker && worker.postMessage({ type: "reset" }); }
  else if (name === "snap") { snapOnce = true; log("key", "面板: 保存截图"); }
  else if (name === "logs") shell.openPath(LOGDIR);
  else if (name === "upload") uploader.now();
  else if (name === "quit") app.quit(); });
const kk = what => HOTKEY[what] ? ` (${HOTKEY[what]})` : " (快捷键被占用)";
function buildMenu() { return Menu.buildFromTemplate([
  { label: `AD 选技助手 v${VERSION}`, enabled: false },
  { label: "⚙ 设置面板(颜色/模式/座位…, 双击托盘图标也能打开)", click: () => openPanel() },
  { label: (cfg.hidden ? "👁 恢复显示" : "🙈 隐藏显示(识别照常运行)") + kk("隐藏/显示"), click: () => toggleHidden() },
  { label: (cfg.all ? "● 团队模式(我方五人)" : "● 单人模式(只看我)") + " — 点击切换" + kk("切换显示模式"), click: () => { cfg.all = !cfg.all; sync(); } },
  { label: "显示双方组合明细", type: "checkbox", checked: cfg.showPlayerScores, click: () => { cfg.showPlayerScores = !cfg.showPlayerScores; sync(); } },
  { label: "📺 直播模式(让直播/录屏软件能抓到覆盖层)", type: "checkbox", checked: settings.allowCapture, click: () => { settings.allowCapture = !settings.allowCapture; saveSettings(); applyLive(`托盘${settings.allowCapture ? "开" : "关"}直播模式`); sync(); } },
  { label: `我是几号位: ${cfg.meSeat === "auto" ? `自动识别(${meShown || "还没认出"})` : `手动 ${cfg.meSeat[0] === "L" ? "左" : "右"}${cfg.meSeat[1]}`}`, submenu: [
    { label: "自动识别(推荐:看游戏给自己面板画的绿框)", type: "radio", checked: cfg.meSeat === "auto", click: () => { cfg.meSeat = "auto"; sync(); } },
    { label: "手动指定只对当前这一局有效, 新的一局自动恢复", enabled: false },
    ...["L1", "L2", "L3", "L4", "L5", "R1", "R2", "R3", "R4", "R5"].map(q => ({ label: `${q[0] === "L" ? "左" : "右"}${q[1]}`, type: "radio", checked: cfg.meSeat === q, click: () => { cfg.meSeat = q; sync(); } }))] },
  { label: "个人权重(只影响你自己的回合)" + kk("团队/个人优先"), enabled: false },
  ...PLN.map((n, i) => ({ label: n + ["  (现在的算法)", "  (每手最多让队伍少 1 个百分点)", "  (最多少 2.5 个百分点)", "  (最多少 5 个百分点)"][i], type: "radio", checked: cfg.plevel === i, click: () => { cfg.plevel = i; sync(); } })),
  { label: (cfg.paused ? "▶ 继续" : "⏸ 暂停") + kk("暂停/继续"), click: () => { cfg.paused = !cfg.paused; sync(); } },
  { label: "重新识别池子(一般不需要)" + kk("重新识别"), click: () => { log("key", "菜单: 重新识别"); worker && worker.postMessage({ type: "reset" }); } },
  { type: "separator" },
  { label: "运行模式(只影响截图和日志, 不改判断)", enabled: false },
  { label: "正式模式  (截图只在关键时刻)", type: "radio", checked: !cfg.test, click: () => { cfg.test = false; sync(); } },
  { label: "🔬 测试模式  (关心的点位全部自动截图 + 细日志)", type: "radio", checked: cfg.test, click: () => { cfg.test = true; sync(); } },
  { type: "separator" },
  { label: "状态估计内核(判断被拿走了没有 / 归谁)", enabled: false },
  { label: "1.x  稳定(一直在用的)", type: "radio", checked: cfg.core !== "v2", click: () => { cfg.core = "1x"; sync(); } },
  { label: "2.0  试验(证据累加, 从不硬提交)", type: "radio", checked: cfg.core === "v2", click: () => { cfg.core = "v2"; sync(); } },
  { type: "separator" },
  { label: "保存当前截图(排障用)", click: () => { snapOnce = true; log("key", "菜单: 保存截图"); } },
  { label: "打开日志文件夹", click: () => shell.openPath(LOGDIR) },
  { label: "打完一局自动上传日志(帮作者排查问题)", type: "checkbox", checked: settings.uploadLogs, click: () => { settings.uploadLogs = !settings.uploadLogs; saveSettings(); sync(); } },
  { label: "立即上传本次日志", click: () => uploader.now() },
  { type: "separator" }, { label: "退出", click: () => app.quit() }]); }
function sync() { tray.setContextMenu(buildMenu()); sendCfg(); log("cfg", `all=${cfg.all} paused=${cfg.paused} hidden=${cfg.hidden} showPlayerScores=${cfg.showPlayerScores} 个人权重=${PLN[cfg.plevel]} 模式=${cfg.test ? "测试" : "正式"} 内核=${cfg.core} 自动上传日志=${settings.uploadLogs ? "开" : "关"} 本人座位=${cfg.meSeat} 安装号=${settings.installId} 配色=${settings.look.c1}/${settings.look.c2}/${settings.look.c3}/${settings.look.mid} 画到${settings.look.midN} 粗细${settings.look.thick} 直播模式=${settings.allowCapture ? "开" : "关"}(源=${capMode})`); }
/* 一键隐藏:覆盖层什么都不画(切换那一下闪 2 秒提示, 确认按键生效), 截屏/识别/引擎照常跑 —— 再按一次立刻显示最新结果,
   可以反复开关确认插件一直在正常工作 */
function toggleHidden() { cfg.hidden = !cfg.hidden; sync(); tray.setToolTip(`AD 选技助手 v${VERSION}${cfg.hidden ? " · 已隐藏" : ""} · ${lastStatus}`); }
app.whenReady().then(() => {
  pruneLogs(); const d = screen.getPrimaryDisplay();
  log("start", `v${VERSION} electron ${process.versions.electron} ${process.platform} ${process.arch} 主屏 ${d.bounds.width}x${d.bounds.height} 缩放 ${d.scaleFactor} 物理 ${Math.round(d.bounds.width * d.scaleFactor)}x${Math.round(d.bounds.height * d.scaleFactor)} 日志 ${LOGFILE}`);
  if (Math.round(d.bounds.height * d.scaleFactor) !== 1440) log("warn", "主屏不是 1440p, 版式按高度等比缩放(16:9 可用, 带鱼屏未验证)");
  tray = new Tray(makeTrayIcon()); tray.setToolTip(`AD 选技助手 v${VERSION}`); tray.setContextMenu(buildMenu());
  tray.on("double-click", () => openPanel());
  createOverlay(); createCapture(); startWorker(); schedule();
  if (settings.allowCapture) { log("live", "启动时直播模式已开"); applyLive("启动时直播模式已开", false); }
  /* F8/F9/F10 常被别的常驻程序(截图工具/WeGame 之类)全局占用 —— 用户实测三个全注册失败。
     依次退让到 Alt+ / Ctrl+Alt+ 组合,注册成功的那个写进日志和托盘菜单。 */
  const reg = (list, fn, what) => { for (const k of list) { let ok = false; try { ok = globalShortcut.register(k, fn); } catch (e) { ok = false; }
      if (ok) { HOTKEY[what] = k; log("key", `${what} 注册成功: ${k}`); return k; } log("key", `${what} 注册 ${k} 失败(被别的程序占用)`); }
    HOTKEY[what] = null; log("key", `${what} 全部候选键都被占用, 只能用托盘菜单`); return null; };
  reg(["F6", "Alt+F6", "CommandOrControl+Alt+F6"], () => toggleHidden(), "隐藏/显示");
  reg(["F8", "Alt+F8", "CommandOrControl+Alt+F8"], () => { cfg.all = !cfg.all; sync(); }, "切换显示模式");
  reg(["F9", "Alt+F9", "CommandOrControl+Alt+F9"], () => { cfg.paused = !cfg.paused; sync(); }, "暂停/继续");
  reg(["F7", "Alt+F7", "CommandOrControl+Alt+F7"], () => { cfg.plevel = (cfg.plevel + 1) % 4; sync(); }, "团队/个人优先");
  reg(["F10", "Alt+F10", "CommandOrControl+Alt+F10"], () => { log("key", "重新识别"); worker && worker.postMessage({ type: "reset" }); }, "重新识别");
  reg(["F11", "Alt+F11", "CommandOrControl+Alt+F11"], () => { cfg.test = !cfg.test; sync(); }, "正式/测试模式");
  reg(["F12", "Alt+F12", "CommandOrControl+Alt+F12"], () => { cfg.core = cfg.core === "v2" ? "1x" : "v2"; sync(); }, "切换内核");
  tray.setContextMenu(buildMenu());
  setInterval(flushLog, 2000);
});
app.on("window-all-closed", () => {});
app.on("before-quit", () => { log("stop", "退出"); flushLog(); });
process.on("uncaughtException", e => { log("error", "主进程 " + (e && e.stack || e)); flushLog(); });
