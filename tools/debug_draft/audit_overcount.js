"use strict";
// Replay captured observations through the actual tracker and explain count overflow.
// --assert-valid rejects overflow or missing observations. Temporary availability
// is reported separately from completed progress; --timeline adds ownership hashes.
const path=require("path");
const {createHash}=require("crypto");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mapHash=value=>hash(Object.entries(value||{}).sort(([a],[b])=>a.localeCompare(b)));
if(process.env.OVERCOUNT_RECOG_REF){
  const Module=require("module"),filename=path.resolve(__dirname,"../../recog.js"),historical=new Module(filename,module);
  historical.filename=filename;historical.paths=Module._nodeModulePaths(path.dirname(filename));
  historical._compile(require("child_process").execFileSync("git",["show",`${process.env.OVERCOUNT_RECOG_REF}:recog.js`],{cwd:path.dirname(filename),encoding:"utf8"}),filename);
  require.cache[filename]=historical;
}
const R=require("../../test/_env").init(),TR=require("../../trace");
const files=process.argv.slice(2).filter(x=>!x.startsWith("--"));
if(!files.length)throw Error("Usage: node tools/debug_draft/audit_overcount.js TRACE... [--assert-valid] [--timeline]");
let invalid=false;
for(const file of files){
  const {head}=TR.read(file);R.rescale(...head.res);
  let peak=0,overFrames=0,first=null,availabilityPeak=0,availabilityOverFrames=0,stalePendingFrames=0;
  const suspectKeys=new Set(),timeline=[];
  const result=TR.replay(file,(tr,f,S,src)=>{
    const total=R.pickedCount(S);peak=Math.max(peak,total);
    const known=new Set(S.panels.flatMap(p=>p.skills.filter(s=>s.key!=="?pick").map(s=>s.key)));
    const unavailable=new Set(S.skills.filter(s=>s.taken).map(s=>s.key));
    const unknownSlots=S.panels.flatMap(p=>p.skills).filter(s=>s.key==="?pick").length;
    // Report the old availability-based count as well: excluding provisional
    // candidates from progress does not mean their visual classification healed.
    const availability=unavailable.size+new Set(S.taken_heroes).size+Math.max(0,unknownSlots-[...unavailable].filter(k=>!known.has(k)).length);
    availabilityPeak=Math.max(availabilityPeak,availability);if(availability>50)availabilityOverFrames++;
    if(Object.keys(tr.pend||{}).some(k=>!tr.prev.taken[k]&&!tr.owner[k]))stalePendingFrames++;
    if(process.argv.includes("--timeline"))timeline.push({frame:tr.frameNo,ms:f.ms,total,availability,
      pending:Object.keys(tr.pend||{}).filter(k=>!tr.owner[k]).sort(),owner:mapHash(tr.owner),heroes:mapHash(tr.heroOf),
      unknown:hash(tr.unknownBy||[]),orphanHeroes:Object.keys(tr.orphan||{}).filter(k=>k.startsWith("hero:")).sort()});
    if(total<=50)return;
    overFrames++;
    const unassigned=S.skills.filter(s=>s.taken&&!known.has(s.key)).map(s=>{
      suspectKeys.add(s.key);const r=tr.pool.skills.find(x=>x.key===s.key);
      return {key:s.key,paired:!!tr.owner[s.key],pending:!!tr.pend[s.key],suspect:!!tr.suspect[s.key],
        solidDark:tr.solidDark(s.key),darkRun:tr.darkRun[s.key]||0,firstT:tr.firstT[s.key],lockFrame:tr.lockFrame,
        raw:tr.prev.rawState?.[s.key],cell:r.cell,refMean:tr.refB[r.cell],refSat:tr.refS[r.cell],stats:src.cellStats(r.cell)};
    });
    if(!first)first={ms:f.ms,frame:tr.frameNo,total,selectedSkills:S.skills.filter(s=>s.taken).length,
      selectedHeroes:S.taken_heroes.length,pairedSkills:known.size,pairedHeroes:Object.keys(tr.heroOf).length,
      unknownSlots,
      extraPicks:S.extraPicks,unassigned,orphanHeroes:Object.keys(tr.orphan).filter(k=>k.startsWith("hero:")),
      openPanels:S.panels.filter(p=>!p.hero||p.skills.length<4).map(p=>({seat:p.side+(p.idx+1),hero:!!p.hero,skills:p.skills.length}))};
  });
  console.log(JSON.stringify({trace:path.basename(file),frames:result.frames.length,miss:result.miss,peak,overFrames,availabilityPeak,availabilityOverFrames,stalePendingFrames,
    first,unassignedAcrossOverflow:[...suspectKeys],finalPairedSkills:Object.keys(result.tracker.owner).length,finalPairedHeroes:Object.keys(result.tracker.heroOf).length,
    finalOwner:result.tracker.owner,finalHeroes:result.tracker.heroOf,...(process.argv.includes("--timeline")?{timeline}:{})},null,2));
  invalid ||= overFrames>0||result.miss>0;
}
if(process.argv.includes("--assert-valid")&&invalid)process.exitCode=1;
