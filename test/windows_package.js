"use strict";
// Cross-platform structural/resource checks, not execution of the Windows EXE.
const fs=require("fs"),path=require("path"),assert=require("assert/strict"),crypto=require("crypto"),vm=require("vm");
const root=path.resolve(__dirname,".."),bundle=path.resolve(process.argv[2]||path.join(root,"dist/ADAssistant-win32-x64"));
const app=path.join(bundle,"resources/app"),exe=fs.readFileSync(path.join(bundle,"ADAssistant.exe"));
assert.equal(exe.toString("ascii",0,2),"MZ");const pe=exe.readUInt32LE(0x3c);
assert.equal(exe.toString("ascii",pe,pe+4),"PE\0\0");assert.equal(exe.readUInt16LE(pe+4),0x8664,"Windows x64 executable");
const required=["main.js","worker.js","recog.js","v2.js","overlay.html","overlay_state.js","preload.js","frames.js",
  "draft_lifecycle.js","draft_scene.js","draft_checkpoint.js","player_scores.js","trace.js","worker_lifecycle.js",
  "data/lib_i8.bin","data/lib_scale.bin","data/lib_keys.json","data/meta.json","data/layout_2560x1440.json",
  "data/names.json","data/names.bin","data/draft_scene.json","data/netS_f21_60.bin","data/netS_f21_60.json","data/netS_f21_60.onnx","data/pairP.bin",
  "engine/public/ad_model.js","engine/public/ad_score.js","engine/public/ad_data.js","engine/public/ad_trio.js"];
const hash=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
for(const name of required){assert(fs.existsSync(path.join(app,name)),"missing packaged resource "+name);
  assert.equal(hash(path.join(app,name)),hash(path.join(root,name)),"stale packaged resource "+name);}
assert(!fs.existsSync(path.join(app,"test")));assert(!fs.existsSync(path.join(app,"tools")));
for(const f of fs.readdirSync(app).filter(f=>f.endsWith(".js")))new vm.Script(fs.readFileSync(path.join(app,f),"utf8"),{filename:f});
assert(fs.existsSync(path.join(app,"node_modules/pngjs/package.json")),"production PNG decoder must be packaged");
const fixture=require("./fixtures/oct15_score_comparison.json"),layout=require("../data/layout_2560x1440.json");
const original=require("../player_scores").createPlayerScorer(),packed=require(path.join(app,"player_scores.js")).createPlayerScorer();
assert.deepEqual(packed(fixture.panels,layout),original(fixture.panels,layout),"packaged CPU scoring must match source");
const hasOrt=fs.existsSync(path.join(app,"node_modules/onnxruntime-node/package.json"));
const result={success:true,executable:"Windows x64 PE",resourceHashes:required.length,sourceAndPackagedScoresEqual:true,
  hasOnnxRuntime:hasOrt,warnings:hasOrt?[]:["onnxruntime-node is absent: GPU/DirectML search modes are not a verified full-release capability"],
  notValidated:["Windows EXE startup","Windows display and capture APIs","GPU/DirectML inference"]};
fs.mkdirSync(path.join(root,"dist/validation"),{recursive:true});fs.writeFileSync(path.join(root,"dist/validation/windows-package.json"),JSON.stringify(result,null,2));
console.log("PASS Windows bundle structure/resources/CPU score",JSON.stringify(result));
