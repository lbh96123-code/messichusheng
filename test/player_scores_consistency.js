"use strict";
const assert=require("assert/strict"),{audit,createScorer}=require("../tools/debug_draft/audit_player_scores");
const fixture=require("./fixtures/oct15_score_comparison.json"),layout=require("../data/layout_2560x1440.json");
const before=audit(fixture),common=audit(fixture,true);
assert(!before.equal);assert(before.differingSeats.length>0);
assert.deepEqual(before.clients[1].rows,before.clients[2].rows,"same version, mode and roster agree across clients");
assert(common.equal);assert.equal(common.differingSeats.length,0);
const natural=before.variants[fixture.commonRef+"/expect"],optimal=before.variants[fixture.commonRef+"/optimalBoth"];
assert(natural.some((r,i)=>r.display!==optimal[i].display),"share mode alone reproduces a visible card difference");
for(let i=0;i<10;i++)for(const part of ["main","synergy","team","counter"])
  assert.equal(natural[i].parts[part],optimal[i].parts[part],"share switch does not change the other score components");
const {score}=createScorer(fixture.commonRef);score.setShareMode(fixture.commonMode);
const original=score(fixture.panels,layout);
const reversed=score(fixture.panels.slice().reverse().map(p=>({...p,skills:p.skills.slice().reverse()})),layout);
for(let i=0;i<10;i++)assert(Math.abs(original[i].total-reversed[i].total)<1e-12,"input ordering must not visibly alter a seat's score");
assert.deepEqual(original,score(fixture.panels,layout),"repeated scoring has no random seed or player identity dependence");
console.log("PASS real Oct15 roster: logged versions/modes reproduce differences; common settings agree; independent clients, repeats, ordering and score components verified");
