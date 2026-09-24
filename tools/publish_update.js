"use strict";
/* 生成一键更新用的清单 + 对象(v1.32 起)。
   用法: node tools/publish_update.js <发布版 resources/app 目录> <输出目录> [--full ADAssistant_win64_vX.zip] [--notes 说明.txt]
   输出: <输出目录>/latest.json + <输出目录>/obj/<sha256>(已有的不重写, 老版本的对象留着不删也没关系)
   上传: 输出目录整个同步到腾讯云 /usr/share/nginx/html/ad-dl/upd/ (nginx: /ad/dl-022c0c58e9cd/upd/...)
   **先传 obj/ 再传 latest.json** —— 清单先到的话, 有人正好点更新会 404。 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const full = opt("--full"), notesFile = opt("--notes");
const [src, out] = args;
if (!src || !out) { console.error("用法: node tools/publish_update.js <resources/app> <输出目录> [--full zip名] [--notes 文件]"); process.exit(1); }
const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
const electron = (pkg.devDependencies && pkg.devDependencies.electron) || JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).devDependencies.electron;
const files = {}; let total = 0, fresh = 0;
fs.mkdirSync(path.join(out, "obj"), { recursive: true });
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const p = path.join(dir, e.name), r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(p, r);
    else if (e.isFile()) { if (/\.upd_(new|old_)/.test(e.name)) continue;
      const b = fs.readFileSync(p), h = crypto.createHash("sha256").update(b).digest("hex"); files[r] = { h, s: b.length }; total += b.length;
      const o = path.join(out, "obj", h); if (!fs.existsSync(o)) { fs.writeFileSync(o, b); fresh++; } }
  }
})(src, "");
const notes = notesFile ? fs.readFileSync(notesFile, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
const m = { version: pkg.version, electron: String(electron).replace(/^[^\d]*/, ""), date: new Date().toISOString(), full, notes, files };
fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(m));
console.log(`v${m.version} electron ${m.electron}: ${Object.keys(files).length} 个文件 ${(total / 1e6).toFixed(1)}MB, 新对象 ${fresh} 个 → ${out}`);
