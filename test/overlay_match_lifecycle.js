"use strict";
// Exercise the real main visibility function and real renderer together. Electron window
// calls are recorded, not a simulation/proof of Windows exclusive-fullscreen stacking.
const assert = require("assert/strict"), fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.resolve(__dirname, "..");
const source = process.env.OVERLAY_MAIN_REF
  ? require("child_process").execFileSync("git", ["show", `${process.env.OVERLAY_MAIN_REF}:main.js`], {cwd:root,encoding:"utf8"})
  : fs.readFileSync(path.join(root, "main.js"), "utf8");
const script = fs.readFileSync(path.join(root, "overlay.html"), "utf8").split("<script>")[1].split("</script>")[0];
require("../frames.js");
const handlers = {}, els = {}, intervals = [], calls = [], records = [];
let texts = [], now = 100000, visible = false;
const canvas = new Proxy({clearRect(){texts=[];}, measureText:()=>({width:100}), fillText:t=>texts.push(t)}, {get:(o,k)=>o[k]||(()=>{})});
const doc = {getElementById:id=>id==="c"?{getContext:()=>canvas}:(els[id]||={style:{},textContent:""})};
new Function("document","ad","addEventListener","innerWidth","innerHeight","setTimeout","clearTimeout","requestAnimationFrame","setInterval",script)(
  doc,{on:(ch,f)=>handlers[ch]=f,ping(){}},()=>{},2560,1296,()=>1,()=>{},()=>{},f=>intervals.push(f));
const ctx = vm.createContext({
  cfg:{hidden:false,paused:false}, phase:"active", liveWaiting:false, recognitionNotice:false, visibilityNoticeUntil:0, ovPingAt:now, ovContentVisible:null,
  Date:{now:()=>now}, crashDiag:{record:(event,data)=>records.push({event,...data})},
  overlay:{isDestroyed:()=>false,isVisible:()=>visible,showInactive(){visible=true;calls.push("show");},hide(){visible=false;calls.push("hide");},
    setAlwaysOnTop(){calls.push("top");},webContents:{setBackgroundThrottling:v=>calls.push(`throttle:${v}`)}},
  send(ch,m){handlers[ch]?.(m);}
});
vm.runInContext(source.slice(source.indexOf("function overlayWanted()"),source.indexOf("/* ---- 截屏 ----")),ctx);
const sync = () => {vm.runInContext("setVisible(phase === 'active')",ctx);handlers.cfg({scale:1,...ctx.cfg,phase:ctx.phase});};
const state = {phase:"active",board:true,taken:3,current:{side:"R",idx:4},me:{side:"R",idx:4},
  playerScores:[{box:[0,100,120,176],total:7,skillCount:3,heroKnown:true}]};
const advice = {side:"R",seat:9,base:.5,rows:[{name:"锚击",p:.6,d:.1,box:[100,100,50,50]}]};
const fill = () => {handlers.state(state);handlers.advice(advice);};
const blank = label => {intervals[0]();assert.equal(texts.length,0,label+": canvas");assert.equal(els.status.textContent,"",label+": status");assert.notEqual(els.toast.style.display,"block",label+": toast");};
sync();fill();assert(texts.includes("组合明细"));
// C06: 22:46:16 idle -> 23:22:05 active -> 23:22:28 advicePainted, before restart.
ctx.phase="idle";sync();
assert(!calls.includes("hide"),"between matches must clear pixels without hiding the native window");
blank("ended match before idle state arrives");fill();blank("late old-match messages");
ctx.phase="active";sync();fill();assert(texts.includes("组合明细"));assert(texts.some(t=>t.includes("锚击")));
assert.equal(calls.filter(x=>x==="show").length,1,"next match reuses continuously visible native window");
console.log("PASS cross-match: same native window, no hide/show cycle, idle pixels blank even with late state/advice");
for(let i=0;i<100;i++) {
  ctx.cfg.paused=true;sync();fill();blank("pause");
  ctx.cfg.paused=false;ctx.liveWaiting=true;sync();fill();blank("capture waiting");
  ctx.liveWaiting=false;ctx.cfg.hidden=true;ctx.visibilityNoticeUntil=now+2200;sync();
  assert.equal(els.status.textContent,"");assert.match(els.toast.textContent,/已隐藏/);
  now+=2300;sync();fill();blank("F6 toast expired");
  ctx.cfg.hidden=false;ctx.visibilityNoticeUntil=now+2200;sync();fill();
  assert(texts.includes("组合明细"));
  ctx.phase="idle";ctx.recognitionNotice=true;ctx.visibilityNoticeUntil=0;sync();
  handlers.state({phase:"idle",idle:true,board:true,near:true,waiting:true});
  assert.match(els.status.textContent,/正在识别池子/);
  ctx.recognitionNotice=false;sync();blank("idle recognition ended");
  ctx.phase="active";sync();fill();
}
assert(!calls.includes("hide"));assert(!calls.includes("throttle:true"),"transparent overlay must keep its repaint/health timers alive");
assert.equal(calls.filter(x=>x==="show").length,1);
console.log("PASS 100 cycles: pause/resume, capture reconnect, F6/toast expiry, recognition notice, new-match display");
assert(records.some(r=>r.visible===false&&r.nativeVisible===true),"diagnostics distinguish content visibility from native visibility");
console.log("PASS diagnostic content/native visibility separation (Windows visual stacking still requires a Windows game)");

// A resident window must also be recoverable while logically hidden: a hung renderer
// can otherwise leave its last score cards stuck over gameplay forever.
const nativeWindows=[],nativeIntervals=[],nativeTimers=[],ipc={};
class NativeWindow {
  constructor() {
    this.dead=false;this.visible=false;this.events={};this.wcEvents={};nativeWindows.push(this);
    this.webContents={on:(ch,f)=>this.wcEvents[ch]=f,send(){},forcefullyCrashRenderer(){},setBackgroundThrottling(){}};
  }
  loadFile(){} on(ch,f){this.events[ch]=f;} isDestroyed(){return this.dead;} isVisible(){return this.visible;}
  showInactive(){this.visible=true;} hide(){throw Error("resident overlay was hidden");} destroy(){this.dead=true;}
  setAlwaysOnTop(){} setIgnoreMouseEvents(){} setContentProtection(){}
}
const nativeCtx=vm.createContext({BrowserWindow:NativeWindow,screen:{getPrimaryDisplay:()=>({bounds:{x:0,y:0,width:2560,height:1440}})},
  path,__dirname:root,overlay:null,phase:"idle",cfg:{hidden:false,paused:false},liveWaiting:false,
  recognitionNotice:false,visibilityNoticeUntil:0,Date:{now:()=>now},
  setTimeout:f=>nativeTimers.push(f),setInterval:(f,ms)=>nativeIntervals.push({f,ms}),
  ipcMain:{on:(ch,f)=>ipc[ch]=f},log(){},flushLog(){},uploader:{crash(){}},
  sendCfg(){},send(){},overlayState:{replay(){}},crashDiag:{record(){}}});
vm.runInContext(source.slice(source.indexOf("function createOverlay()"),source.indexOf("const send =")),nativeCtx);
vm.runInContext(source.slice(source.indexOf("function overlayWanted()"),source.indexOf("/* ---- 截屏 ----")),nativeCtx);
const runNative=s=>vm.runInContext(s,nativeCtx);
const load=()=>nativeWindows.at(-1).wcEvents["did-finish-load"]();
runNative("createOverlay()");load();assert(nativeWindows[0].visible,"initial idle window is shown with blank contents");
nativeWindows[0].events.unresponsive();now+=3100;nativeTimers.shift()();
assert(nativeWindows[0].dead);assert.equal(nativeWindows.length,2);load();
now+=11000;nativeIntervals.find(t=>t.ms===2000).f();
assert(nativeWindows[1].dead);assert.equal(nativeWindows.length,3);load();
ipc["ov-ping"]({sender:nativeWindows[2].webContents},{frames:1,error:"simulated canvas failure"});
assert(nativeWindows[2].dead);assert.equal(nativeWindows.length,4);load();
// A message from a destroyed renderer cannot reset current health or rebuild it.
ipc["ov-ping"]({sender:nativeWindows[0].webContents},{error:"late old failure"});
assert.equal(nativeWindows.length,4);
nativeCtx.phase="active";runNative("setVisible(true)");assert(nativeWindows[3].visible);
assert.equal(runNative("ovContentVisible"),true);
console.log("PASS real create/rebuild paths: idle startup, unresponsive/heartbeat/canvas recovery while blank, stale renderer IPC ignored");
