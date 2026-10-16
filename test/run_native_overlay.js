"use strict";
// A GUI process can exit cleanly before its async test finishes. Require the
// completed report as well as exit code zero, so an early quit cannot pass CI.
const fs=require("fs"),path=require("path"),assert=require("assert/strict"),{spawnSync}=require("child_process");
const root=path.resolve(__dirname,".."),output=path.join(root,"dist/validation/native-overlay-smoke.json");
fs.rmSync(output,{force:true});
const child=spawnSync(require("electron"),[path.join(root,"test_native_overlay.js")],{cwd:root,stdio:"inherit",timeout:150000});
if(child.error)throw child.error;
assert.equal(child.status,0,"native Electron validation must exit successfully: "+child.signal);
assert(fs.existsSync(output),"native Electron exited without finishing the validation report");
const result=JSON.parse(fs.readFileSync(output,"utf8"));
assert.equal(result.success,true);assert.equal(result.platform,process.platform);
assert.equal(result.cycles,100);assert(result.rendererRebuilds>=2,"crash and hang recovery must both finish");
assert.equal(result.idleResourceSamples.length,5);
console.log("PASS completed native validation report",output);
