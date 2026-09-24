const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("ad", { on: (ch, fn) => ipcRenderer.on(ch, (e, m) => fn(m)),
  /* v1.39 覆盖层报平安: 主进程 10 秒收不到就认为覆盖层卡死, 自动重建(09-23 飞刀"推荐面板卡在屏幕上关不掉") */
  ping: n => ipcRenderer.send("ov-ping", n) });
