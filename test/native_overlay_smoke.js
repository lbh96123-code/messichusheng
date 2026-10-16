"use strict";
// Optional GUI integration test. Uses real Electron windows, renderer, preload,
// IPC and the production overlay controller; never starts capture/upload/update.
// macOS results do not establish Windows/Dota exclusive-fullscreen stacking.
const {app,BrowserWindow,ipcMain,screen}=require("electron");
const assert=require("assert/strict"),fs=require("fs"),os=require("os"),path=require("path"),vm=require("vm");
const root=path.resolve(__dirname,".."),temporary=fs.mkdtempSync(path.join(os.tmpdir(),"ad-overlay-check-"));
app.setPath("userData",temporary);app.setName("AD overlay verification");
// Match the production tray app: rebuilding its sole window must not quit it.
app.on("window-all-closed",()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const output=process.argv.find(x=>x.startsWith("--out="))?.slice(6)||path.join(root,"dist/validation/native-overlay-smoke.json");
const cycles=+(process.argv.find(x=>x.startsWith("--cycles="))?.slice(9)||100);
const timers=[],records=[],logs=[];let ctx;
async function until(test,label,timeout=6000){
  const start=Date.now();while(Date.now()-start<timeout){if(await test())return;await sleep(30);}throw Error("Timed out: "+label);
}
function run(code){return vm.runInContext(code,ctx);}
const state={phase:"active",idle:false,board:true,taken:3,current:{side:"R",idx:4},me:{side:"R",idx:4},
  playerScores:[{box:[20,130,112,176],total:.75,heroKnown:true,skillCount:2,parts:{main:.4,synergy:.3,team:0,counter:.05,share:0}}]};
const advice={side:"R",seat:9,base:.5,rows:[{key:"axe_berserkers_call",name:"test ability",p:.6,d:.1,box:[300,150,60,60]}]};
function send(ch,m){ctx.overlayState.accept(ch,m);const w=ctx.overlay;if(w&&!w.isDestroyed())w.webContents.send(ch,m);}
function sync(){run("setVisible(phase==='active')");ctx.sendCfg();}
function fill(){send("state",state);send("advice",advice);}
async function view(){return ctx.overlay.webContents.executeJavaScript(`(()=>{
  const count=(x,y,w,h)=>{const d=ctx.getImageData(Math.floor(x/scale),Math.floor(y/scale),Math.ceil(w/scale),Math.ceil(h/scale)).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;};
  return {visible:presentationVisible,painted:renderHealth.advicePainted,cardPixels:count(20,130,112,176),recommendPixels:count(300,150,60,60),
    allPixels:count(0,0,cv.width*scale,cv.height*scale),status:status.textContent,toast:toast.style.display,draws:renderHealth.draws,error:renderHealth.error};
})()`);}
async function shown(label){await until(async()=>{const s=await view();assert(!s.error,s.error);return s.painted&&s.cardPixels>0&&s.recommendPixels>0;},label);}
async function blank(label){await until(async()=>{const s=await view();return s.allPixels===0&&s.status===""&&s.toast!=="block";},label);}
async function loaded(){await until(async()=>{const w=ctx.overlay;if(!w||w.isDestroyed()||w.webContents.isLoadingMainFrame())return false;
  try{return await w.webContents.executeJavaScript("typeof renderHealth!=='undefined'&&typeof presentationVisible!=='undefined'");}catch{return false;}
},"overlay page load");await sleep(60);}
function resources(){const rows=app.getAppMetrics();return {time:Date.now(),windows:BrowserWindow.getAllWindows().length,
  cpuPercent:rows.reduce((n,r)=>n+r.cpu.percentCPUUsage,0),workingSetMB:rows.reduce((n,r)=>n+r.memory.workingSetSize/1024,0),
  processes:rows.map(r=>({pid:r.pid,type:r.type,cpu:r.cpu.percentCPUUsage,workingSetMB:r.memory.workingSetSize/1024}))};}
async function main(){
  await app.whenReady();
  assert.equal(path.resolve(app.getAppPath()),root,"launch through the root test_native_overlay.js entry so production relative loadFile paths resolve correctly");
  const source=fs.readFileSync(path.join(root,"main.js"),"utf8");
  ctx=vm.createContext({BrowserWindow,screen,ipcMain,path,__dirname:root,overlay:null,phase:"idle",cfg:{hidden:false,paused:false,showPlayerScores:true},
    liveWaiting:false,recognitionNotice:false,visibilityNoticeUntil:0,Date,
    setTimeout:(f,ms)=>{const t=setTimeout(f,ms);timers.push(t);return t;},setInterval:(f,ms)=>{const t=setInterval(f,ms);timers.push(t);return t;},
    log:(tag,msg)=>logs.push({tag,msg}),flushLog(){},uploader:{crash(){}},crashDiag:{record:(event,data)=>records.push({event,data})},
    overlayState:require("../overlay_state").create(),send,sendCfg(){send("cfg",{...ctx.cfg,scale:ctx.testScale||1,phase:ctx.phase,version:"native-test"});}});
  vm.runInContext(source.slice(source.indexOf("function createOverlay()"),source.indexOf("const send =")),ctx);
  vm.runInContext(source.slice(source.indexOf("function overlayWanted()"),source.indexOf("/* ---- 截屏 ----")),ctx);
  run("createOverlay()");await loaded();await blank("idle startup is transparent");
  const first=ctx.overlay;
  assert(first.isVisible(),"idle native window must remain mapped");assert(first.isAlwaysOnTop());assert(!first.isFocusable());
  assert.equal(first.webContents.getBackgroundThrottling(),false);
  ctx.phase="active";sync();fill();await shown("first draft");
  for(const scale of [1,1.25,1.5,2]){ctx.testScale=scale;sync();fill();await shown("canvas scale "+scale);}
  ctx.testScale=1;
  for(let i=0;i<cycles;i++){
    ctx.phase="idle";sync();send("state",{phase:"idle",idle:true});send("advice",advice);await blank("between matches");
    ctx.phase="active";sync();fill();await shown("next match");
    ctx.cfg.paused=true;sync();await blank("pause");ctx.cfg.paused=false;
    ctx.liveWaiting=true;sync();await blank("capture waiting");ctx.liveWaiting=false;
    ctx.cfg.hidden=true;sync();await blank("hidden");ctx.cfg.hidden=false;sync();fill();await shown("resume");
    assert.equal(ctx.overlay,first);assert.equal(BrowserWindow.getAllWindows().length,1);assert(first.isVisible());
    if((i+1)%25===0)console.log("PASS native cross-match cycles",i+1);
  }
  // Exercise the actual renderer toast timeout, rather than a virtual clock.
  ctx.cfg.hidden=true;ctx.visibilityNoticeUntil=Date.now()+2200;sync();
  await until(async()=>(await view()).toast==="block","F6 toast");await sleep(2300);ctx.visibilityNoticeUntil=0;sync();await blank("F6 timeout");
  ctx.cfg.hidden=false;sync();fill();await shown("F6 restore");
  // A renderer process exit must rebuild through the production event handler.
  let previous=ctx.overlay;previous.webContents.forcefullyCrashRenderer();
  await until(()=>ctx.overlay!==previous,"renderer crash rebuild");await loaded();fill();await shown("after renderer crash");
  assert(previous.isDestroyed());
  // Then really hang the renderer and let the 10s heartbeat watchdog detect it.
  previous=ctx.overlay;ctx.overlay.webContents.executeJavaScript("for(;;){}").catch(()=>{});
  await until(()=>ctx.overlay!==previous,"heartbeat/unresponsive rebuild",22000);await loaded();fill();await shown("after hung renderer");
  assert(previous.isDestroyed());
  ctx.phase="idle";sync();send("state",{phase:"idle",idle:true});await blank("final idle");
  resources();const idle=[];for(let i=0;i<5;i++){await sleep(1000);idle.push(resources());}
  assert(idle.every(s=>s.windows===1));assert(records.some(r=>r.event==="overlay-visibility"&&r.data.visible===false&&r.data.nativeVisible===true));
  const result={success:true,platform:process.platform,arch:process.arch,electron:process.versions.electron,cycles,canvasScales:[1,1.25,1.5,2],
    primaryDisplay:screen.getPrimaryDisplay().size,primaryScale:screen.getPrimaryDisplay().scaleFactor,
    rendererRebuilds:logs.filter(r=>r.msg.startsWith("重建覆盖层(")).length,idleResourceSamples:idle,
    passed:["native window residency","real renderer/preload/IPC","cards and recommendations share visibility","late advice rejected during idle",
      "pause/capture waiting/F6 timeout and restore","renderer crash and hang recovery","single surviving native window"],
    notValidated:["Windows exclusive-fullscreen stacking","Windows DPI/HDR/game renderer","actual Dota capture or DirectML","long-duration resource soak"]};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
  console.log("PASS real Electron overlay",JSON.stringify({platform:result.platform,electron:result.electron,cycles,rebuilds:result.rendererRebuilds,
    idleCpu:idle.map(s=>+s.cpuPercent.toFixed(2)),idleMemoryMB:idle.map(s=>+s.workingSetMB.toFixed(1)),output}));
}
const deadline=setTimeout(()=>{console.error("FAIL native overlay deadline");app.exit(1);},120000);
main().then(()=>{clearTimeout(deadline);for(const t of timers)clearInterval(t);for(const w of BrowserWindow.getAllWindows())w.destroy();app.quit();})
  .catch(e=>{console.error("FAIL",e.stack);fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify({success:false,platform:process.platform,electron:process.versions.electron,error:String(e.stack)},null,2));app.exit(1);});
process.on("exit",()=>{try{fs.rmSync(temporary,{recursive:true,force:true});}catch{}});
