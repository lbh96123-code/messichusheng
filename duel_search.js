'use strict';
const assert=require('assert/strict'),T=require('./duel_runtime');
const {C,F,AI}=T,N=T;
const {SearchMemory}=require('./duel_memory');
const heroKeys=new Map(T.scoreModel.AD_HEROES.map(h=>[h.key,'hero:'+h.id]));
const rawHeroKeys=new Map([...heroKeys].map(([a,b])=>[b,a]));
const sigmoid=z=>1/(1+Math.exp(-z));
const identity=(sim,own)=>C.ownKey(own,sim.step);
function noLegalDetails(sim){const seat=sim.order[sim.step],available=[0,0,0];for(let i=0;i<sim.items.length;i++)if(!sim.taken[i]&&sim.items[i].p>=0)available[sim.items[i].kind]++;return {step:sim.step,seat,slots:Array.from(sim.slot).slice(seat*3,seat*3+3),availableByKind:available,remainingTurns:sim.order.length-sim.step,unmapped:sim.items.filter(i=>i.p<0).slice(0,8).map(i=>i.key)};}
class Planner{
  constructor({compact=false,remember=true,diagnostic=null}={}){this.tree=new Map();this.namespace=null;this.compact=compact;this.suspended=null;this.memory=remember?new SearchMemory():null;this.diagnostic=diagnostic;this.profile=null;}
  report(event,details){try{this.diagnostic?.(event,details);}catch(_){} }
  inheritedRows(node,sim,own,K){
    const base=node.rows.slice(0,K);if(!this.memory||K<2)return {rows:base,probes:[]};
    const keys=this.memory.priorities(sim,own,new Set(node.legalKeys)).slice(0,2),probes=[];
    for(const key of keys){const i=sim.items.findIndex(x=>x.key===key);let row=node.rows.find(r=>r.i===i);
      if(!row){row={i,p:node.prior[i],n:0,sum:0,sumSq:0,pending:0};node.rows.push(row);}
      probes.push(row);
    }
    const rows=[...base];for(const row of probes)if(!rows.includes(row)){
      const drop=rows.findLastIndex(r=>!probes.includes(r));if(drop>=0)rows.splice(drop,1);rows.push(row);
    }
    return {rows,probes};
  }
  selectContinuation(node,sim,own,K){
    const inherited=this.inheritedRows(node,sim,own,K);
    // A repeated position gets one compulsory trial of a discovered idea.
    // One-off leaves still start from their current-position network advice.
    const probe=node.n+node.pending>=2?inherited.probes.find(r=>r.n+r.pending<1):null;
    if(probe)return probe;
    let best=-Infinity,edge=null;
    for(const r of inherited.rows){
      const n=r.n+r.pending,mean=r.n?r.sum/r.n:.5,q=node.seat<5?mean:1-mean;
      const v=q+.28*r.p*Math.sqrt(node.n+node.pending+1)/(1+n);if(v>best){best=v;edge=r;}
    }
    return edge;
  }
  rememberTerminal(t){
    if(!this.memory)return;
    const anchor=t.sim.items[t.path[0].edge.i].key,seat=t.q.sim.order[t.q.sim.step],kit=[];
    for(let i=0;i<t.own.length;i++)if(t.own[i]===seat)kit.push(heroKeys.get(t.sim.items[i].key)||t.sim.items[i].key);
    const pairs=T.scoreModel.ADScore.explain(kit).pairs,key=heroKeys.get(anchor)||anchor;
    let plans=t.q.node.memoryPlans;if(!plans)t.q.node.memoryPlans=plans=new Map();
    let companions=plans.get(anchor);if(!companions)plans.set(anchor,companions=new Map());
    for(const p of pairs){if(p.v2<=.05||(p.a!==key&&p.b!==key))continue;
      const other=p.a===key?p.b:p.a,raw=rawHeroKeys.get(other)||other;
      const old=companions.get(raw)||{n:0,sum:0};old.n++;old.sum+=p.v2;companions.set(raw,old);
    }
  }
  rememberRoots(queries){
    if(!this.memory)return;
    for(const q of queries)this.memory.observe(q.sim.step,q.edges.map(r=>({key:q.sim.items[r.i].key,n:r.n,
      win:r.n?(q.left?r.sum/r.n:1-r.sum/r.n):null})),q.node.memoryPlans||new Map());
  }
  check(state){const ns=JSON.stringify([state.pool,state.order]);if(this.namespace===null)this.namespace=ns;assert.equal(ns,this.namespace,'Never reuse a tree across pools/order/model configuration');}
  makeNode(sim,own,rows){const prior=this.compact?new Float64Array(60):null;if(prior)for(const r of rows)prior[r.i]=r.p;return {step:sim.step,seat:sim.order[sim.step],own:Int8Array.from(own),prior,legalKeys:rows.map(r=>sim.items[r.i].key),rows:(this.compact?rows.slice(0,8):rows).map(r=>({...r,n:0,sum:0,sumSq:0,pending:0})),n:0,pending:0};}
  limitNodes(max=30000){if(this.tree.size<=max)return 0;const drop=[...this.tree].filter(([,n])=>!n.candidateKeys&&n.pending===0).sort((a,b)=>b[1].step-a[1].step||a[1].n-b[1].n);let removed=0;for(const [key]of drop){if(this.tree.size<=Math.floor(max*.8))break;this.tree.delete(key);removed++;}return removed;}
  advance(state){this.check(state);this.memory?.advance(state.taken);const sim=AI._simFrom(state),own=C.ownerOf(state,sim,sim.order[sim.step]);let removed=0;for(const [key,node]of this.tree){if(node.step<sim.step||own.some((v,i)=>v>=0&&node.own[i]!==v)){this.tree.delete(key);removed++;}}return {removed,retained:this.tree.size};}
  async priors(entries){
    const profile=this.profile,t0=profile?performance.now():0;
    const buf=C.mkBuf(entries.length);for(let j=0;j<entries.length;j++)C.encodeRange([entries[j].sim],[entries[j].own],entries[j].sim.step,buf,j);
    const t1=profile?performance.now():0;
    const lg=await C.logits(buf,entries.length);
    const t2=profile?performance.now():0;
    for(let j=0;j<entries.length;j++){
      const {sim,own,key}=entries[j],legal=[];for(let i=0;i<60;i++)if(buf.legal[j*60+i])legal.push(i);
      if(!legal.length){const node=this.makeNode(sim,own,[]);node.failure=noLegalDetails(sim);this.tree.set(key,node);continue;}const mx=Math.max(...legal.map(i=>lg[j*60+i]));
      const rows=legal.map(i=>({i,p:Math.exp(lg[j*60+i]-mx)})),z=rows.reduce((a,r)=>a+r.p,0);
      for(const r of rows)r.p/=z;rows.sort((a,b)=>b.p-a.p);
      this.tree.set(key,this.makeNode(sim,own,rows));
    }
    if(profile){profile.encodeMs+=t1-t0;profile.logitsMs+=t2-t1;profile.priorPostMs+=performance.now()-t2;profile.priorBatches++;profile.priorStates+=entries.length;profile.batchSizes[entries.length]=(profile.batchSizes[entries.length]||0)+1;}
  }
  async decide(state,options={}){const r=await this.decideMany([state],options);return {...r.results[0],ms:r.ms,calls:r.calls,nodes:r.nodes,suspendedSteps:r.suspendedSteps,resumedSteps:r.resumedSteps};}
  async prepareConditional(state,options={}){const {EffectPlans}=require('./duel_effect_plans');this.effectPlans=new EffectPlans(this,options);return this.effectPlans.prepare(state,options);}
  async decideConditional(state,move,options={}){assert(this.effectPlans,'Prepare conditional plans first');return this.effectPlans.decide(state,move,options);}
  resetStatistics(){for(const node of this.tree.values()){assert.equal(node.pending,0);node.n=0;for(const edge of node.rows){assert.equal(edge.pending,0);edge.n=0;edge.sum=0;edge.sumSq=0;}}}
  async decideForTurn(state,{samples=64,targetMs=600,maxMs=900,previousMove=null,onProposal=null,cancelled=()=>false,reuseValues=true,strategy='balanced',...options}={}){
    const start=performance.now();assert(maxMs>0&&targetMs<=maxMs&&samples>=8);
    const proposal=this.effectPlans&&previousMove!==null?this.effectPlans.resolve(state,previousMove):null;
    if(proposal?.hit&&onProposal)onProposal(proposal);
    this.advance(state);
    if(!reuseValues)this.resetStatistics();
    const stop=()=>cancelled()||performance.now()-start>=maxMs;
    let result,screen=null;
    if(strategy==='focus4'){
      screen=await this.decide(state,{...options,samples:32,batch:32,cancelled:stop});
      const keys=screen.rows.filter(r=>r.n>0).slice(0,4).map(r=>r.key);
      result=keys.length&&!stop()?await this.decide(state,{...options,samples:64,batch:64,rootKeys:keys,cancelled:stop}):screen;
    }else{assert.equal(strategy,'balanced');result=await this.decide(state,{...options,samples,cancelled:stop});}
    const searched=result.rows.find(r=>r.n>0),chosen=searched?.key??(proposal?.hit?proposal.key:result.rows[0]?.key);
    assert(chosen);const elapsedMs=performance.now()-start;
    return {...result,chosen,proposal,screen,totalNewSamples:result.newSamples+(screen&&screen!==result?screen.newSamples:0),elapsedMs,withinTarget:elapsedMs<=targetMs,withinLimit:elapsedMs<=maxMs,partial:!result.complete,source:searched?'search':proposal?.hit?'conditional-proposal':'network-fallback'};
  }
  async decideMany(states,{samples=128,batch=32,K=8,rootKeys=null,cancelled=()=>false,budgetExpired=()=>false,verifyTerminal=null,onTerminal=null,onWave=null}={}){
    const began=performance.now();assert(states.length&&states.every(s=>s.step===states[0].step));
    const profile=this.diagnostic?{step:states[0].step,roots:states.length,samplesPerRoot:samples,batch,K,nodesBefore:this.tree.size,rootCandidateMs:0,encodeMs:0,logitsMs:0,priorPostMs:0,simulationMs:0,priorBatches:0,priorStates:0,batchSizes:{},cachedLookups:0,uncachedLookups:0,deduplicatedLookups:0,waves:0,completedPaths:0,backpropMs:0,maxWaveMs:0}:null;this.profile=profile;
    let lastWaveLog=began;
    states.forEach(s=>this.check(s));let calls=0;
    const descriptors=states.map(s=>{const sim=AI._simFrom(s),own=C.ownerOf(s,sim,sim.order[sim.step]),key=identity(sim,own);return {sim,own,key};});
    const need=descriptors.filter(d=>!this.tree.get(d.key)?.candidateKeys);
    if(need.length){const rootStart=profile?performance.now():0;const roots=await N.candidates(need.map(d=>states[descriptors.indexOf(d)]),60);calls++;
      if(profile)profile.rootCandidateMs+=performance.now()-rootStart;
      const missing=need.filter(d=>!this.tree.has(d.key));if(missing.length){await this.priors(missing);calls++;}
      for(let j=0;j<need.length;j++){const d=need[j],r=roots[j];let node=this.tree.get(d.key);
        node.candidateKeys=r.rows.slice(0,K).map(x=>x.key);
        if(this.memory&&K>=2){const inherited=this.memory.priorities(d.sim,d.own,new Set(r.rows.map(x=>x.key))).slice(0,2);
          for(const key of inherited)if(!node.candidateKeys.includes(key)){const drop=node.candidateKeys.findLastIndex(k=>!inherited.includes(k));if(drop>=0)node.candidateKeys.splice(drop,1);node.candidateKeys.push(key);}
        }
      }
    }
    const queries=descriptors.map(d=>{
      const node=this.tree.get(d.key),keys=rootKeys?rootKeys.slice():node.candidateKeys.slice(0,K);assert(new Set(keys).size===keys.length&&keys.every(k=>node.candidateKeys.includes(k)));
      const edges=keys.map(k=>{const i=d.sim.items.findIndex(x=>x.key===k);let edge=node.rows.find(r=>r.i===i);if(!edge){assert(node.legalKeys.includes(k));edge={i,p:node.prior[i],n:0,sum:0,sumSq:0,pending:0};node.rows.push(edge);}return edge;});assert(edges.every(Boolean));
      const goal=keys.length?Math.floor(samples/keys.length):0,reused=edges.reduce((a,r)=>a+Math.min(goal,r.n),0);
      return {...d,node,keys,edges,goal,reused,newSamples:0,left:d.sim.order[d.sim.step]<5};
    });
    const signature=JSON.stringify(queries.map(q=>[q.key,q.keys,q.goal]));
    let resume=this.suspended?.signature===signature?this.suspended:null;this.suspended=null;
    if(resume&&!resume.trajectories.every(t=>t.path.every(({node})=>this.tree.get(identity(node,node.own))===node)))resume=null;
    let stopped=false,reason=queries.some(q=>!q.keys.length)?'no-legal-root':null,failure=queries.find(q=>!q.keys.length)?.node.failure||null,resumedSteps=resume?resume.trajectories[0].sim.step-resume.trajectories[0].q.sim.step:0;
    const resultFor=q=>({rows:q.keys.map((key,i)=>({key,n:q.edges[i].n,prior:q.edges[i].p,rolloutStd:q.edges[i].n>1?Math.sqrt(Math.max(0,q.edges[i].sumSq-q.edges[i].sum*q.edges[i].sum/q.edges[i].n)/(q.edges[i].n-1)):null,win:q.edges[i].n?(q.left?q.edges[i].sum/q.edges[i].n:1-q.edges[i].sum/q.edges[i].n):null})).sort((a,b)=>(b.win??-1)-(a.win??-1)),legalCandidates:q.node.legalKeys.length,searchedCandidates:q.keys.length,requestedSamples:q.keys.length*q.goal,reusedSamples:q.reused,newSamples:q.newSamples,complete:!reason&&q.keys.length>0&&q.edges.every(r=>r.n>=q.goal),reason,failure});
    for(;;){
      if(cancelled()){stopped=true;break;}
      if(budgetExpired()){stopped=true;reason='budget';this.suspended=resume;break;}
      const waveStart=profile?performance.now():0;
      const trajectories=resume?resume.trajectories:[];
      if(resume){for(const t of trajectories){t.q=queries.find(q=>q.key===t.q.key);for(const {node,edge}of t.path){node.pending++;edge.pending++;}}resume=null;}
      else for(const q of queries)for(let b=0;b<batch;b++){
        let edge=null;for(const r of q.edges)if(r.n+r.pending<q.goal&&(!edge||r.n+r.pending<edge.n+edge.pending))edge=r;
        if(!edge)break;
        const sim=F.cloneSim(q.sim),own=Int8Array.from(q.own);edge.pending++;q.node.pending++;
        F.applySim(sim,edge.i);own[edge.i]=q.sim.order[q.sim.step];
        trajectories.push({q,sim,own,path:[{node:q.node,edge}]});
      }
      if(profile)profile.simulationMs+=performance.now()-waveStart;
      if(!trajectories.length)break;
      while(!F.simDone(trajectories[0].sim)){
        if(cancelled()){stopped=true;break;}
        if(budgetExpired()){stopped=true;reason='budget';break;}
        const missing=new Map();for(const t of trajectories){t.key=identity(t.sim,t.own);const cached=this.tree.has(t.key);if(profile){if(cached)profile.cachedLookups++;else{profile.uncachedLookups++;if(missing.has(t.key))profile.deduplicatedLookups++;}}if(!cached&&!missing.has(t.key))missing.set(t.key,{sim:t.sim,own:t.own,key:t.key});}
        if(missing.size){await this.priors([...missing.values()]);calls++;}
        const simulationStart=profile?performance.now():0;
        for(const t of trajectories){
          const node=this.tree.get(t.key);let edge=this.selectContinuation(node,t.sim,t.own,K);
          if(!edge){stopped=true;reason='no-legal-continuation';failure=node.failure||noLegalDetails(t.sim);break;}
          edge.pending++;node.pending++;t.path.push({node,edge});const seat=t.sim.order[t.sim.step];F.applySim(t.sim,edge.i);t.own[edge.i]=seat;
        }
        if(profile)profile.simulationMs+=performance.now()-simulationStart;
        if(stopped)break;
      }
      if(stopped){for(const t of trajectories)for(const {node,edge}of t.path){node.pending--;edge.pending--;}if(reason==='budget')this.suspended={signature,trajectories};break;}
      const backpropStart=profile?performance.now():0;
      for(const t of trajectories){
        if(verifyTerminal)verifyTerminal(t.sim,t.own);
        if(onTerminal)onTerminal(t.sim,t.own,{rootKey:t.q.key,candidateKey:t.sim.items[t.path[0].edge.i].key});
        const value=sigmoid(t.sim.z);t.q.newSamples++;
        this.rememberTerminal(t);
        for(const {node,edge}of t.path){node.pending--;node.n++;edge.pending--;edge.n++;edge.sum+=value;edge.sumSq+=value*value;}
      }
      this.rememberRoots(queries);
      if(profile){const now=performance.now();profile.waves++;profile.completedPaths+=trajectories.length;profile.backpropMs+=now-backpropStart;profile.maxWaveMs=Math.max(profile.maxWaveMs,now-waveStart);if(now-lastWaveLog>=1000){lastWaveLog=now;this.report('search-wave',{...profile,nodes:this.tree.size,elapsedMs:now-began});}}
      if(onWave)onWave(queries.map(resultFor));
    }
    const results=queries.map(resultFor);
    if(profile){const elapsedMs=performance.now()-began;this.report('search-profile',{...profile,elapsedMs,nodesAfter:this.tree.size,otherMs:Math.max(0,elapsedMs-profile.rootCandidateMs-profile.encodeMs-profile.logitsMs-profile.priorPostMs-profile.simulationMs-profile.backpropMs),reason:reason||(stopped?'cancelled':'finished'),reusedSamples:queries.reduce((n,q)=>n+q.reused,0),requestedSamples:queries.reduce((n,q)=>n+q.keys.length*q.goal,0),complete:results.every(r=>r.complete),suspendedPaths:this.suspended?.trajectories.length||0,resumedSteps});this.profile=null;}
    return {results,ms:performance.now()-began,calls,nodes:this.tree.size,cancelled:stopped&&reason!=='budget',suspendedSteps:this.suspended?this.suspended.trajectories[0].sim.step-this.suspended.trajectories[0].q.sim.step:0,resumedSteps};
  }
}
module.exports={Planner,T};
