"use strict";
const assert=require("assert/strict"),{Planner,T}=require("./duel_search"),D=require("./engine/server/draft");
const clone=s=>JSON.parse(JSON.stringify(s));
const apply=(s,key)=>{const n=clone(s);assert(D.pick(n,key).ok);return n;};
class DuelController {
  constructor({diagnostic=null,remember=true}={}){this.diagnostic=diagnostic;this.remember=remember;this.reset('initialize');}
  report(event,details){try{this.diagnostic?.(event,details);}catch(_){}}
  makePlanner(compact=false){return new Planner({compact,remember:this.remember,diagnostic:this.diagnostic?(event,details)=>this.report(event,details):null});}
  reset(reason='configuration'){this.report('search-reset',{reason,nodes:this.planner?.tree.size||0});this.planner=this.makePlanner();this.mode=null;}
  select(mode,state){
    const namespace=JSON.stringify([state.pool,state.order]);
    if(this.mode!==mode||(this.planner.namespace!==null&&this.planner.namespace!==namespace)){this.report('search-namespace-change',{reason:this.mode!==mode?'mode':JSON.stringify(JSON.parse(this.planner.namespace)[0])!==JSON.stringify(state.pool)?'pool':'order',fromMode:this.mode,toMode:mode,step:state.step,order:state.order});this.reset();this.planner=this.makePlanner(mode==="duel-fast");}
    this.mode=mode;const advanced=this.planner.advance(state);this.report('search-advance',{step:state.step,...advanced});
  }
  async background(state,{mode,targetSeat,budgetMs=6000,cancelled=()=>false}={}){
    this.select(mode,state);const start=performance.now(),stop=()=>cancelled()||performance.now()-start>=budgetMs,p=this.planner;
    const target=state.order.indexOf(targetSeat,state.step),gap=target-state.step;
    if(target<0)return {complete:false,reason:"no-future-turn"};
    if(mode==="duel-fast"&&gap===1)return p.prepareConditional(state,{screenSamples:16,chunkSize:8,budgetMs,cancelled:stop});
    const base=await p.decide(state,{samples:128,cancelled:stop});
    if(!base.complete||stop()||gap===0)return base;
    let paths=base.rows.slice(0,3).map(r=>apply(state,r.key));
    if(gap===2){
      const second=await p.decideMany(paths,{samples:128,cancelled:stop});
      if(stop())return second;
      paths=second.results.flatMap((r,i)=>r.complete?r.rows.slice(0,2).map(row=>apply(paths[i],row.key)):[]).slice(0,3);
    }
    if(gap<=2&&paths.length)return p.decideMany(paths,{samples:128,cancelled:stop});
    let result=base;
    for(let samples=256;samples<=512&&!stop();samples+=128)result=await p.decide(state,{samples,cancelled:stop});
    return result;
  }
  async maintain(state,{mode,targetSeat,cancelled=()=>false,onProgress=()=>{},onReady=()=>{},onResult=()=>{}}={}){
    this.select(mode,state);const p=this.planner,start=performance.now();
    const target=state.order.indexOf(targetSeat,state.step),gap=target-state.step;
    if(target<0)return {complete:false,reason:"no-future-turn"};
    let rounds=0,newSamples=0,pruned=0,rootGoal=128,forecastGoal=128,frontier=[],cursor=0,legalChoices=0,profiledChoices=0;
    const account=r=>{newSamples+=r.newSamples??r.results?.reduce((n,q)=>n+q.newSamples,0)??0;};
    const stop=()=>cancelled();
    // One unknown pick: spend work on our possible next states rather than
    // first completing an opponent's recommendation that we cannot control.
    const root=mode==="duel-fast"&&gap===1?{complete:true,rows:[]}:await p.decide(state,{samples:128,batch:32,cancelled:stop,onWave:rs=>{if(gap===0&&!stop())onResult({...rs[0],sampleTarget:128,ms:performance.now()-start});}});account(root);
    if(root.reason?.startsWith('no-legal'))return root;
    if(root.complete&&!stop()&&gap===0)onReady({...root,chosen:root.rows[0].key});
    if(root.complete&&!stop()&&gap<=2){
      if(mode==="duel-fast"&&gap===1){
        const choices=(await T.candidates([state],60))[0].rows;
        legalChoices=choices.length;frontier=choices.map(r=>({move:r.key,state:apply(state,r.key)}));
      }else{
        frontier=root.rows.slice(0,3).map(r=>({move:r.key,state:apply(state,r.key),score:r.win}));
        if(gap===2){
          const second=await p.decideMany(frontier.map(f=>f.state),{samples:128,batch:32,cancelled:stop});account(second);
          frontier=second.results.flatMap((r,i)=>r.complete?r.rows.slice(0,2).map(row=>({state:apply(frontier[i].state,row.key),score:(frontier[i].score+row.win)/2})):[]).sort((a,b)=>b.score-a.score).slice(0,3);
        }
      }
    }
    if(root.complete&&!stop()&&mode==="duel-fast"&&gap>2){
      let predicted=clone(state);
      while(predicted.step<target&&!stop()){
        const row=(await T.candidates([predicted],1))[0].rows[0];predicted=apply(predicted,row.key);
      }
      if(!stop())frontier=[{state:predicted}];
    }
    while(!stop()){
      // Finite waves yield to actual picks; cached waves never spin forever.
      await new Promise(resolve=>setImmediate(resolve));if(stop())break;
      if(mode==="duel-fast"&&gap===1&&profiledChoices<legalChoices){
        const prepared=await p.prepareConditional(state,{screenSamples:32,chunkSize:4,budgetMs:500,cancelled:stop});
        newSamples+=prepared.newSamples;profiledChoices=prepared.profiledChoices;
        // Representatives affect scheduling only. Their values are never
        // injected into another exact state's search statistics.
        const groups=p.effectPlans.groups,first=groups[0];
        const ordered=first?[first,...groups.filter(g=>g!==first&&!g.protected).sort((a,b)=>b.members.length-a.members.length),...groups.filter(g=>g!==first&&g.protected)]:[];
        const representative=ordered.map(g=>g.members.slice().sort((a,b)=>b.probability-a.probability)[0].move);
        const rank=new Map(representative.map((key,i)=>[key,i]));
        frontier.sort((a,b)=>(rank.get(a.move)??1e6)-(rank.get(b.move)??1e6));
      }
      if(stop())break;
      let result;
      if(frontier.length&&gap>0){
        result=await p.decide(frontier[cursor].state,{samples:forecastGoal,batch:32,cancelled:stop});
        cursor++;
        if(cursor===frontier.length){cursor=0;forecastGoal+=128;}
      }else{rootGoal+=128;result=await p.decide(state,{samples:rootGoal,batch:32,cancelled:stop});}
      account(result);rounds++;pruned+=p.limitNodes();
      if(result.reason?.startsWith('no-legal'))return result;
      if(gap===0&&result.complete&&!stop()&&Number.isInteger(Math.log2(rootGoal)))onResult({...result,sampleTarget:rootGoal,ms:performance.now()-start});
      onProgress({rounds,newSamples,profiledChoices,legalChoices,nodes:p.tree.size,elapsedMs:performance.now()-start});
    }
    return {cancelled:stop(),rounds,newSamples,profiledChoices,legalChoices,pruned,nodes:p.tree.size,elapsedMs:performance.now()-start};
  }
  async decide(state,{mode,previousMove=null,budgetMs=8000,cancelled=()=>false,onResult=()=>{}}={}){
    this.select(mode,state);const p=this.planner,start=performance.now();
    if(previousMove===null&&p.effectPlans?.before){const taken=new Set(p.effectPlans.before.taken);const moves=state.taken.filter(k=>!taken.has(k));if(moves.length===1)previousMove=moves[0];}
    const proposal=p.effectPlans&&previousMove!==null?p.effectPlans.resolve(state,previousMove):null;
    const r=await p.decide(state,{samples:128,batch:32,cancelled,budgetExpired:()=>performance.now()-start>=budgetMs,onWave:rs=>{if(!cancelled())onResult({...rs[0],sampleTarget:128,ms:performance.now()-start});}});
    const chosen=r.rows.find(row=>row.n>0)?.key??r.rows[0]?.key;
    return {...r,chosen,proposal,partial:!r.complete,ms:performance.now()-start};
  }
  setShareMode(mode){this.reset('share-mode: '+mode);T.setShareMode(mode);}
}
module.exports={DuelController};
