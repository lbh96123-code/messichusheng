'use strict';
// Actual worker scheduling with anonymous observations from the Oct 15 trace.
// Replace expensive advice computation only; the turn/clear decisions stay real.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..'),realRequire=require('module').createRequire(path.join(root,'worker.js'));
const events=[],calls=[],context=vm.createContext({Buffer,Uint8Array,Int8Array,Float32Array,Float64Array,Int32Array,Uint32Array,Uint16Array,
  console,setTimeout,clearTimeout,setImmediate,clearImmediate,__dirname:root,process:{env:{...process.env,AD_THREADS:'0'}},calls,
  require(name){if(name==='worker_threads')return {parentPort:{on(){},postMessage:m=>events.push(m)}};return realRequire(name);}});
vm.runInContext(fs.readFileSync(path.join(root,'worker.js'),'utf8'),context);
let checks=0,pairChecks=0;
const run=code=>vm.runInContext(code,context),check=(name,f)=>{try{f();checks++;}catch(e){e.message=name+': '+e.message;throw e;}};
run('advise=(S,j)=>calls.push(j);');
context.S=require('./fixtures/oct15_late_count.json').state;
check('reported count50 cannot clear a still-open last turn',()=>{
  run('chooseAdvice(S,49,false,null)');
  assert(!events.some(e=>e.type==='clear'));assert.deepEqual(calls,[49]);
});
// R5 acts twice at 10/11 and 30/31. L1 acts twice at 20/21 and 40/41.
// The same highlight and ±1 global counting noise must not switch those turns.
for(const [seat,first,before] of [[9,9,0],[9,29,2],[0,19,1],[0,39,3]]){
  const point={side:seat<5?'L':'R',idx:seat%5};
  // Single-player mode, then all five same-side observers in team mode.
  for(const observer of [null,0,1,2,3,4]){
    run(`ALL=${observer!==null}`);
    const me=observer===null?point:{side:point.side,idx:observer};
    for(let done=0;done<=2;done++){
      const count=before+done;
      context.pair={current:point,me,panels:[{...point,hero:count?'hero':null,skills:Array.from({length:Math.max(0,count-1)},(_,i)=>({key:'s'+i}))}]};
      for(const drift of [-1,0,1])for(const picked of [false,true]){
        const n=first+done+drift;
        check(`seat${seat} observer${observer} pair${first+1}/${first+2}, own${count}, total${n}, fastPick${picked}`,()=>
          assert.equal(run(`startIdxOf(pair,${picked},${n})`),first+done));
        pairChecks++;
      }
    }
  }
}
run('ALL=false');
// Missing panel evidence retains the existing global-order fallback.
context.pair={current:{side:'R',idx:4},me:{side:'R',idx:4},panels:[]};
assert.equal(run('startIdxOf(pair,false,29)'),29);
// Highlight outside our seat still follows normal observed ordering.
context.pair={current:{side:'L',idx:4},me:{side:'R',idx:4},panels:[]};
assert.equal(run('startIdxOf(pair,false,28)'),28);
// Team mode still uses global ordering for an opponent and falls back when the
// allied panel is missing. Neither case may borrow the observer's own panel.
run('ALL=true');
context.pair={current:{side:'R',idx:4},me:{side:'L',idx:0},panels:[{side:'L',idx:0,hero:'hero',skills:[]}]};
assert.equal(run('startIdxOf(pair,false,31)'),31);
context.pair={current:{side:'R',idx:4},me:{side:'R',idx:0},panels:[]};
assert.equal(run('startIdxOf(pair,false,29)'),29);
// End-to-end scheduling: the observer is R1, but the recommendation is for R5's
// second consecutive pick, even when the global count is one ahead.
context.teamS=structuredClone(context.S);
context.teamS.current={side:'R',idx:4};context.teamS.me={side:'R',idx:0};
context.teamS.panels.forEach(p=>{p.hero=null;p.skills=[];});
const basics=context.teamS.skills.filter(s=>!s.ultslot).slice(0,2);
Object.assign(context.teamS.panels.find(p=>p.side==='R'&&p.idx===4),{hero:context.teamS.pool_heroes[0],skills:basics.map(s=>({key:s.key}))});
events.length=0;calls.length=0;
run('turnLock=null;chooseAdvice(teamS,startIdxOf(teamS,false,31),false,null)');
assert.deepEqual(calls,[30],"team observer must recommend R5's second pick, not R4's next turn");
run('ALL=false');
// The clear path is still necessary when every seat has a legal, unique full roster.
context.full=structuredClone(context.S);
context.full.panels=Array.from({length:10},(_,i)=>({side:i<5?'L':'R',idx:i%5,hero:context.full.pool_heroes[i],
  skills:Array.from({length:4},(_,j)=>({key:`complete_${i}_${j}`}))}));
context.full.skills=context.full.panels.flatMap(p=>p.skills.map((s,j)=>({...s,taken:true,ultslot:j===3})));
context.full.taken_heroes=context.full.pool_heroes.slice(0,10);
events.length=0;calls.length=0;
check('legal complete roster clears without requesting another recommendation',()=>{
  run('chooseAdvice(full,49,false,null)');assert(events.some(e=>e.type==='clear'));assert.equal(calls.length,0);
});
console.log(`PASS: recorded count50 retained, complete legal roster cleared; ${pairChecks} consecutive-turn cases, missing-panel fallback and other-seat ordering`);
// The progress counter may exclude a pending skill, but engine availability
// must still block it; paired fast-path evidence must count immediately.
context.waiting=structuredClone(context.S);
context.waiting.skills.forEach(s=>s.taken=false);context.waiting.taken_heroes=[];
context.waiting.panels.forEach(p=>{p.hero=null;p.skills=[];});
context.waiting.pendingKeys=[context.waiting.skills[0].key];context.waiting.skills[0].taken=true;
assert.equal(run('R.pickedCount(waiting)'),0);
assert(run('buildState(waiting,0).st.blocked.includes(waiting.pendingKeys[0])'));
assert.equal(run('buildState(waiting,0).st.order.length'),50,"a provisional cell does not consume a player's slot");
run('waiting.panels[0].skills.push({key:waiting.pendingKeys[0]})');
assert.equal(run('R.pickedCount(waiting)'),1);
assert(!run('buildState(waiting,0).st.blocked.includes(waiting.pendingKeys[0])'));
assert.equal(run('buildState(waiting,0).st.order.length'),49);
console.log('PASS actual worker: pending skill blocked without consuming a slot; fast-path panel confirmation immediately counts');
