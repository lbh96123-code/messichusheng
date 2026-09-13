"use strict";
const assert = require('assert/strict'), path = require('path');
const { createPlayerScorer } = require('../player_scores');
const win = require('../engine/server/mcts_fast').loadModel(path.resolve(__dirname, '../engine/public'));
const layout = require('../data/layout_2560x1440.json'), score = createPlayerScorer();
const h = win.AD_HEROES.find(h => Object.hasOwn(win.AD_MODEL.index, 'hero:' + h.id));
const skills = Object.keys(win.AD_MODEL.index).filter(k => !k.startsWith('hero:')).slice(0, 4);
const panels = [{side:'L',idx:0,hero:h.key,skills:skills.map(key=>({key}))}];
let rows = score(panels,layout);
const seats = Array.from({length:10},()=>[]);seats[0]=['hero:'+h.id,...skills];
assert.equal(rows.length,10);
assert.equal(rows[0].total,win.ADScore.evaluate(seats).seats[0].total);
const expected=win.ADScore.evaluate(seats).seats[0];
assert.deepEqual(rows[0].parts,{main:expected.main2,synergy:expected.syn2,team:expected.cross,counter:expected.ctr});
assert.ok(Math.abs(Object.values(rows[0].parts).reduce((a,b)=>a+b,0)-rows[0].total)<1e-10);
assert.equal(rows[9].parts,null);
assert.equal(rows[0].heroKnown,true);assert.equal(rows[0].skillCount,4);
assert.equal(rows[9].total,null);
const moved = score([{...panels[0],side:'R',idx:4}],layout);
assert.equal(moved[0].total,null);assert.equal(moved[9].skillCount,4);
const partial = score([{side:'L',idx:0,hero:'unrecognized',skills:[{key:skills[0]},{key:skills[0]},{key:'?pick'},{key:'not-in-model'},null]}],layout)[0];
assert.equal(partial.skillCount,1);assert.equal(partial.unknown,3);assert.equal(partial.heroKnown,false);assert.ok(Number.isFinite(partial.total));
assert.equal(score([{side:'L',idx:0,skills:[{key:'?pick'}]}],layout)[0].total,null);
assert.ok(score([],layout).every(p=>p.total===null));
const R=require('../recog');
R.init({lib:{keys:[],q:new Int8Array(),scale:new Float32Array()},meta:{heroes:[]},layout});
for(const [w,hgt] of [[2560,1440],[1920,1080],[2560,1080]]){
 R.rescale(w,hgt);const ls=R.LAYOUT();
 for(const p of score(panels,ls)){
  assert.ok(p.box[0]>=0&&p.box[0]+p.box[2]<=w);
  assert.ok(p.box[1]+p.box[3]<=hgt*.9,'fifth player must fit overlay');
  const panel=ls.panels[p.side], rowTop=panel.y_top+p.idx*panel.pitch;
  assert.ok(p.box[1]>=rowTop && p.box[1]+p.box[3]<=rowTop+panel.pitch);
  if(p.side==='L')assert.ok(p.box[0]>=panel.x0+419*hgt/1440,'left panel: scores on right');
  else assert.ok(p.box[0]+p.box[2]<=panel.x0,'right panel: scores on left');
 }
}
console.log('PASS player scores: exact model mapping, ten seats, reassignment, unknowns, duplicates, reset, 3 layouts');
