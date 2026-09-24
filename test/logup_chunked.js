"use strict";
/* v1.38 回归: 分块上传。起本机 logup.py(临时目录), 用 logupload.postChunked 传一个 ~2.3MB 的 zip(5 块), 第 2 块第一次故意失败(服务器没起前)——
   这里简化为: 正常 5 块全部成功 → 服务器存档 1 个 zip 且内容逐字节相同; 再传一个坏块数(parts=99)应被 400 拒绝。 */
const { spawn } = require("child_process"), fs = require("fs"), path = require("path"), os = require("os");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "lu-")), ROOT = path.join(T, "root"); fs.mkdirSync(ROOT);
fs.writeFileSync(path.join(T, "conf.json"), JSON.stringify({ key: "adlog-7Kq2vXe9LmP4tRz" }));
const PORT = 18130 + Math.floor(Math.random() * 500);
process.env.AD_LOGUP_HOST = "127.0.0.1"; process.env.AD_LOGUP_PORT = String(PORT); process.env.AD_LOGUP_PATH = "/";
const U = require("../logupload.js");
const srv = spawn("python3", [path.join(__dirname, "..", "..", "server_logup", "logup.py")], { env: { ...process.env, LOGUP_CONF: path.join(T, "conf.json"), LOGUP_ROOT: ROOT, LOGUP_PORT: String(PORT) }, stdio: "inherit" });
const rnd = n => require("crypto").randomBytes(n);
(async () => {
  await new Promise(r => setTimeout(r, 800));
  const zip = U.makeZip([{ name: "ad_20260923_101010.log", data: Buffer.from("hello 日志\n".repeat(1000)) }, { name: "snap_20260923_101010_draft_end.png", data: rnd(2.3 * 1024 * 1024 | 0) }]);
  const r = await U.postChunked(zip, { "x-ad-ver": "test", "x-ad-id": "testid", "x-ad-why": "manual" });
  const day = fs.readdirSync(ROOT).filter(x => /^\d{8}$/.test(x)); const got = day.length ? fs.readdirSync(path.join(ROOT, day[0])) : [];
  const same = got.length === 1 && Buffer.compare(fs.readFileSync(path.join(ROOT, day[0], got[0])), zip) === 0;
  const left = fs.readdirSync(path.join(ROOT, ".parts")).length;
  console.log(`分块上传: HTTP ${r.code} 分${r.parts}块  存档 ${got.length} 个  逐字节一致 ${same}  暂存残留 ${left}`);
  const bad = await (new Promise(res => { const req = require("http").request({ host: "127.0.0.1", port: PORT, path: "/", method: "POST", headers: { "x-ad-key": "adlog-7Kq2vXe9LmP4tRz", "x-ad-upid": "0123456789abcdef", "x-ad-part": "0", "x-ad-parts": "99", "content-length": 3 } }, rs => res(rs.statusCode)); req.end("abc"); }));
  console.log(`块数超限被拒: HTTP ${bad}`);
  const ok = r.code === 200 && r.parts === 5 && same && left === 0 && bad === 400;
  console.log(ok ? "通过" : "失败"); srv.kill(); fs.rmSync(T, { recursive: true, force: true }); process.exit(ok ? 0 : 1);
})();
