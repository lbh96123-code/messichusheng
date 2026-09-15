const { contextBridge, ipcRenderer } = require("electron");
/* 设置面板 ↔ 主进程:主进程推 "panel"(当前全部状态), 面板发 "set"(改一项) / "act"(按一下的动作) */
contextBridge.exposeInMainWorld("panel", {
  on: (ch, fn) => ipcRenderer.on(ch, (e, m) => fn(m)),
  set: (k, v) => ipcRenderer.send("panel-set", { k, v }),
  act: (name) => ipcRenderer.send("panel-act", { name }),
  ready: () => ipcRenderer.send("panel-ready"),
});
