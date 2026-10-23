'use strict';
const assert=require('assert/strict'),fs=require('fs');
const source=fs.readFileSync(require.resolve('../worker'),'utf8');
const code=source.slice(source.indexOf('function turnTick('),source.indexOf('/* ---- 快通道:',source.indexOf('function turnTick(')));
let time=100;
const make=new Function('Date',`
const targetTurnStarts=new Map(),FULL_ORDER=[0,5,1,6,2,7,3,8,4,9],myEv=new Map();let myTurn=null;
const seatIdx=p=>(p.side==='L'?0:5)+p.idx;
const panelCount=(s,i)=>s.panels.find(p=>seatIdx(p)===i)?.count??null;
const seatPicksBefore=(seat,i)=>FULL_ORDER.slice(0,i).filter(x=>x===seat).length;
const orderIndex=(seat,i)=>FULL_ORDER.indexOf(seat,i),log=()=>{},AIModes={isGpu:()=>true},AIMODE='duel';
${code}
return {tick:turnTick,starts:targetTurnStarts};`);
const h=make({now:()=>time});
const state={me:{side:'L',idx:0},current:{side:'L',idx:1},my_turn:false,panels:[{side:'L',idx:1,count:0},{side:'R',idx:1,count:0}]};
h.tick(state,2,2);assert.equal(h.starts.get(2),100,'team-view teammate gets its own t0');
time=2100;h.tick(state,2,2);assert.equal(h.starts.get(2),100,'repeated frames do not restart the clock');
h.tick(state,3,3);assert(!h.starts.has(3),'anticipating the next turn does not start its deadline');
time=3000;h.tick({...state,current:{side:'R',idx:1}},3,3);assert.equal(h.starts.get(3),3000);
const afterPick=make({now:()=>4000});afterPick.tick({...state,panels:[{side:'L',idx:1,count:1}]},2,3);assert(!afterPick.starts.has(2),'stale highlight after a pick is not a new turn');
console.log('PASS per-position turn clock, teammate timing, precomputation and stale-highlight handling');
