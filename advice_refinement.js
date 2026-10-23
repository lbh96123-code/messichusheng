'use strict';
// Publication policy only: search values and their normal ordering are unchanged.
class RefinementGate {
  constructor({onPublish,turnStart=()=>null,now=Date.now,schedule=setTimeout,cancel=clearTimeout,intervalMs=1000,windowMs=4000}) {
    Object.assign(this,{onPublish,turnStart,now,schedule,cancel,intervalMs,windowMs});
    this.baseline=false;this.lastTarget=0;this.lastSamples=0;this.lastAt=-Infinity;this.pending=null;this.timer=null;this.closed=false;
  }
  expired(){const t=this.turnStart();return this.baseline&&t!=null&&this.now()>=t+this.windowMs;}
  publish(r,target,samples){
    this.lastTarget=target;this.lastSamples=samples;this.lastAt=this.now();
    if(r.complete)this.baseline=true;
    this.onPublish(r,{target,samples,turnElapsedMs:this.turnStart()==null?null:this.now()-this.turnStart()});
  }
  offer(r){
    if(this.closed||!r?.rows?.length)return;
    const rows=r.rows.filter(x=>x.n>0&&Number.isFinite(x.win)),samples=rows.reduce((n,x)=>n+x.n,0);
    if(!rows.length)return;
    const target=r.sampleTarget||128;
    // Preserve the original32/64/96 waves and late128 completion, even after t+4.
    if(!this.baseline){if(samples>this.lastSamples||r.complete)this.publish(r,target,samples);return;}
    if(this.expired()){this.clearPending();return;}
    if(!r.complete||target<256||!Number.isInteger(Math.log2(target))||target<=this.lastTarget)return;
    if(!this.pending||target>this.pending.target)this.pending={r,target,samples};
    this.flush();
  }
  flush(){
    if(this.closed||this.expired()){this.clearPending();return;}
    if(!this.pending)return;
    const wait=this.lastAt+this.intervalMs-this.now();
    if(wait>0){if(this.timer==null)this.timer=this.schedule(()=>{this.timer=null;this.flush();},wait);return;}
    const p=this.pending;this.clearPending();this.publish(p.r,p.target,p.samples);
  }
  clearPending(){if(this.timer!=null)this.cancel(this.timer);this.timer=null;this.pending=null;}
  close(){this.closed=true;this.clearPending();}
}
module.exports={RefinementGate};
