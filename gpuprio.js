"use strict";
/* v1.33 组合版抢显卡: 提高本进程在显卡上的调度优先级(D3DKMTSetProcessSchedulingPriorityClass, OBS 同款做法)。
   起因: 825204e14c87(RTX 3060 + 4K) 开插件预热时每次调网络 16ms, 进游戏后 ~1000ms —— 游戏把显卡吃满、又是前台,
   Windows 把后台的插件排在后面。组合版(DirectML)跑在主进程里, 提的就是它;覆盖层是 Chromium 的 GPU 进程画的, 不受影响。
   档位: 0 空闲 1 较低 2 普通 3 较高 4 高 5 实时。实时要管理员(OBS: "GPU priority setup failed (not admin?)"),
   所以依次试 5→4→3, 设上哪档算哪档, 读回来写日志。用 PowerShell 调 gdi32(免原生模块), 只在启动时跑一次。 */
const NAMES = ["空闲", "较低", "普通", "较高", "高", "实时"];
function raise(pid, log, done) {
  if (process.platform !== "win32") return done && done(null);
  const ps = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class GP{[DllImport("gdi32.dll")]public static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr h,int c);[DllImport("gdi32.dll")]public static extern int D3DKMTGetProcessSchedulingPriorityClass(IntPtr h,out int c);}'
$adm=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$h=[System.Diagnostics.Process]::GetProcessById(${pid | 0}).Handle
$o=0;[void][GP]::D3DKMTGetProcessSchedulingPriorityClass($h,[ref]$o);"before $o"
foreach($c in 5,4,3){$r=[GP]::D3DKMTSetProcessSchedulingPriorityClass($h,$c);"try $c "+('{0:X8}' -f $r);if($r -eq 0){break}}
$o=0;[void][GP]::D3DKMTGetProcessSchedulingPriorityClass($h,[ref]$o);"after $o admin $adm"`;
  require("child_process").execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000, windowsHide: true }, (err, out) => {
    const s = String(out || ""), m = /after (\d) admin (\w+)/.exec(s), b = /before (\d)/.exec(s);
    const tries = (s.match(/try \d [0-9A-F]{8}/g) || []).join(", ");
    if (!m) { log("gpu", "显卡优先级设置失败 " + String(err && err.message || s).slice(0, 200)); return done && done(null); }
    const lv = +m[1], admin = m[2] === "True";
    log("gpu", `显卡优先级: ${NAMES[+(b && b[1])] || "?"} → ${NAMES[lv] || lv}(${tries}; 管理员=${admin ? "是" : "否"})`);
    done && done({ level: lv, name: NAMES[lv] || String(lv), admin });
  });
}
module.exports = { raise, NAMES };
