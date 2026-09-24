"use strict";
/* 一键更新(updater.js)端到端: 本地起一个静态服务器当腾讯云, tools/publish_update.js 生成清单, 装一个"旧版"目录再更新。
   覆盖: 只下变了的文件 / 校验失败不动本地 / Windows 被占用文件改名挪开 + 下次启动清理 / 替换到一半出错整体还原 /
         electron 版本不同 → 要完整包 / 清单里 ../ 路径拒绝 / 已是最新。  node test/updater.js */
const fs = require("fs"), path = require("path"), http = require("http"), assert = require("assert"), { execFileSync } = require("child_process");
const U = require("../updater.js");
const T = path.join(__dirname, "_upd_tmp"); fs.rmSync(T, { recursive: true, force: true });
const W = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const R = p => fs.readFileSync(p, "utf8");
const ELECTRON = "31.7.7";
function mkApp(dir, ver, extra) { W(`${dir}/package.json`, JSON.stringify({ version: ver, devDependencies: { electron: ELECTRON } }));
  W(`${dir}/main.js`, "old main"); W(`${dir}/data/big.bin`, Buffer.alloc(200000, 7)); W(`${dir}/node_modules/x/bin/lock.node`, "old native"); if (extra) extra(dir); }
mkApp(`${T}/rel`, "1.33.0", d => { W(`${d}/main.js`, "new main"); W(`${d}/node_modules/x/bin/lock.node`, "new native"); W(`${d}/新文件/说明.txt`, "中文路径"); });
execFileSync("node", [path.join(__dirname, "..", "tools", "publish_update.js"), `${T}/rel`, `${T}/srv/upd`, "--full", "ADAssistant_win64_v1.33.zip"], { stdio: "inherit" });
const man = JSON.parse(R(`${T}/srv/upd/latest.json`));
assert.strictEqual(man.version, "1.33.0"); assert.strictEqual(man.electron, ELECTRON); assert.strictEqual(Object.keys(man.files).length, 5);

let hits = [];
const srv = http.createServer((q, s) => { const u = decodeURIComponent(q.url.split("?")[0]); hits.push(u);
  const p = path.join(T, "srv", u); if (!p.startsWith(path.join(T, "srv")) || !fs.existsSync(p)) { s.writeHead(404); return s.end(); } s.writeHead(200); s.end(fs.readFileSync(p)); });
(async () => {
  await new Promise(r => srv.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${srv.address().port}/`;
  const logs = []; const mk = (dir, ver, el = ELECTRON) => U.create({ appDir: dir, dataDir: `${dir}_data`, version: ver, electron: el, base, log: (t, m) => logs.push(m) });
  const same = (a, b) => { for (const r of Object.keys(man.files)) assert.strictEqual(fs.readFileSync(path.join(a, r)).toString("hex"), fs.readFileSync(path.join(b, r)).toString("hex"), r); };

  assert.strictEqual(U.cmpVer("1.31.0", "1.32"), -1); assert.strictEqual(U.cmpVer("1.32.0", "1.32"), 0); assert.strictEqual(U.cmpVer("1.10.0", "1.9.9"), 1);

  /* 1. 正常更新: 只下 4 个变了的(main.js / lock.node / 新文件 / package.json), big.bin 不下; Windows 占用的 lock.node 走改名 */
  mkApp(`${T}/a`, "1.32.0"); let u = mk(`${T}/a`, "1.32.0");
  const origRename = fs.renameSync; let lockedHit = 0;
  fs.renameSync = (a, b) => { if (String(b).endsWith("lock.node") && String(a).endsWith(".upd_new") && fs.existsSync(b) && R(b) === "old native") { lockedHit++; const e = new Error("EPERM"); e.code = "EPERM"; throw e; } return origRename(a, b); };
  assert.strictEqual((await u.check(false)).phase, "available");
  hits = []; let s = await u.apply(); fs.renameSync = origRename;
  assert.strictEqual(s.phase, "done", s.msg); same(`${T}/a`, `${T}/rel`);
  const objs = hits.filter(h => h.includes("/obj/")); assert.strictEqual(objs.length, 4, objs.join());   // main.js, lock.node, 新文件, package.json
  assert.ok(!objs.includes("/upd/obj/" + man.files["data/big.bin"].h), "没变的文件不该下");
  assert.strictEqual(lockedHit, 1); const olds = fs.readdirSync(`${T}/a/node_modules/x/bin`).filter(f => f.includes(".upd_old_")); assert.strictEqual(olds.length, 1);
  assert.strictEqual(R(`${T}/a_data/update/backup/v1.32.0/main.js`), "old main");
  assert.ok(!fs.readdirSync(`${T}/a`).some(f => f.includes(".upd_")));
  mk(`${T}/a`, "1.33.0").cleanupOld(); assert.strictEqual(fs.readdirSync(`${T}/a/node_modules/x/bin`).filter(f => f.includes(".upd_old_")).length, 0, "下次启动应清掉旧文件");
  assert.strictEqual((await mk(`${T}/a`, "1.33.0").check(false)).phase, "latest");
  console.log("✓ 正常更新: 只下变了的 4 个, 占用文件改名挪开, 下次启动清理, 装完是最新");

  /* 2. 对象被篡改 → 校验失败, 本地一个字节不动 */
  mkApp(`${T}/b`, "1.32.0"); const objMain = `${T}/srv/upd/obj/${man.files["main.js"].h}`, good = fs.readFileSync(objMain); fs.writeFileSync(objMain, "tampered");
  u = mk(`${T}/b`, "1.32.0"); s = await u.apply(); fs.writeFileSync(objMain, good);
  assert.strictEqual(s.phase, "error"); assert.ok(/校验失败/.test(s.msg), s.msg); assert.strictEqual(R(`${T}/b/main.js`), "old main"); assert.ok(/1\.32\.0/.test(R(`${T}/b/package.json`)));
  s = await u.apply(); assert.strictEqual(s.phase, "done", "修好后再点一次能装上"); same(`${T}/b`, `${T}/rel`);
  console.log("✓ 下载内容不对: 不动本地, 修好再点一次就好");

  /* 3. 替换到一半出错 → 已替换的全部还原 */
  mkApp(`${T}/c`, "1.32.0"); u = mk(`${T}/c`, "1.32.0"); const origCopy = fs.copyFileSync; let n = 0;
  fs.copyFileSync = (a, b, f) => { if (String(b).endsWith(".upd_new") && ++n === 3) throw Object.assign(new Error("磁盘满"), { code: "ENOSPC" }); return origCopy(a, b, f); };
  s = await u.apply(); fs.copyFileSync = origCopy;
  assert.strictEqual(s.phase, "error"); assert.ok(/已还原/.test(s.msg), s.msg);
  assert.strictEqual(R(`${T}/c/main.js`), "old main"); assert.strictEqual(R(`${T}/c/node_modules/x/bin/lock.node`), "old native"); assert.ok(!fs.existsSync(`${T}/c/新文件/说明.txt`)); assert.ok(/1\.32\.0/.test(R(`${T}/c/package.json`)));
  console.log("✓ 替换到一半出错: 全部还原, 仍是旧版");

  /* 4. electron 不同 → 要完整包, 不动本地 */
  mkApp(`${T}/d`, "1.32.0"); u = mk(`${T}/d`, "1.32.0", "30.0.0"); s = await u.check(false);
  assert.strictEqual(s.phase, "needFull"); assert.strictEqual(s.fullUrl, base + "ADAssistant_win64_v1.33.zip");
  s = await u.apply(); assert.strictEqual(s.phase, "needFull"); assert.strictEqual(R(`${T}/d/main.js`), "old main");
  console.log("✓ 程序本体变了: 提示下载完整包, 不自动装");

  /* 5. 清单里带 ../ → 拒绝 */
  const bad = { ...man, files: { ...man.files, "../evil.txt": man.files["main.js"] } }; fs.writeFileSync(`${T}/srv/upd/latest.json`, JSON.stringify(bad));
  mkApp(`${T}/e`, "1.32.0"); s = await mk(`${T}/e`, "1.32.0").apply(); assert.strictEqual(s.phase, "error"); assert.ok(!fs.existsSync(`${T}/evil.txt`));
  fs.writeFileSync(`${T}/srv/upd/latest.json`, JSON.stringify(man));
  for (const r of ["a/b", "新文件/说明.txt"]) assert.ok(U.safeRel(r)); for (const r of ["../x", "/etc/x", "a/../b", "C:/x", "a\\b", "a//b", ""]) assert.ok(!U.safeRel(r), r);
  console.log("✓ 非法路径拒绝");

  /* 6. 版本号一样但缺文件(补丁打在老底子上): 自动检查不打扰, 手动检查提示修复, 点了补齐 */
  mkApp(`${T}/f`, "1.33.0", d => { W(`${d}/main.js`, "new main"); W(`${d}/新文件/说明.txt`, "中文路径"); fs.writeFileSync(`${d}/package.json`, R(`${T}/rel/package.json`)); });
  u = mk(`${T}/f`, "1.33.0"); assert.strictEqual((await u.check(true)).phase, "latest");
  s = await u.check(false); assert.strictEqual(s.phase, "available"); assert.ok(s.repair && /1 个文件/.test(s.msg), s.msg);
  s = await u.apply(); assert.strictEqual(s.phase, "done"); same(`${T}/f`, `${T}/rel`);
  console.log("✓ 同版本缺文件: 手动检查提示修复并补齐, 自动检查不打扰");

  /* 7. 服务器不通 → 报错不崩 */
  srv.close(); s = await mk(`${T}/e`, "1.32.0").check(false); assert.strictEqual(s.phase, "error");
  console.log("✓ 服务器不通: 报错不崩");
  fs.rmSync(T, { recursive: true, force: true }); console.log("updater 全部通过");
})().catch(e => { console.error(e); process.exit(1); });
