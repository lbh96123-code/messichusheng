import json,glob,os,collections
META=json.load(open('/home/ec2-user/work/game/ad-draft/app/data/meta.json'))
CN=lambda k: META['cn']['hero'].get(k) or META['cn']['ab'].get(k) or k
def cls(mean,mx,sat,ref,refS,isHero):
    r=mean/max(ref,8); mr=mx/max(ref,8)
    if mean<10 and mx<20: return 'T'
    if refS>=(0.15 if isHero else 0.25) and sat<0.15 and sat<(0.5 if isHero else 0.35)*refS and mean<120 and mx<150 and r<1.8: return 'T'
    if isHero and mean<26 and mx<40 and sat<0.25: return 'T'
    if r>=0.6: return 'N'
    if isHero: return 'T' if (r<0.22 and mr<0.4) else 'O'
    desat=refS<0.2 or sat<0.65*refS
    return 'T' if ((r<0.32 and mr<0.5 and desat) or (r<0.2 and mr<0.3)) else 'O'
tot=collections.Counter()
for tr in sorted(glob.glob('*/trace_*.jsonl')):
    recs=[json.loads(l) for l in open(tr)]; head=recs[0]; fs=[r for r in recs if r['t']=='f']; end=fs[-1]['ms']
    rp=json.load(open(tr+'.replay3.json'))
    key2cell={s['key']:s['cell'] for s in head['pool']['skills']}
    for h in head['pool']['heroCards']: key2cell['hero:'+h['hero']]=h['cell']
    truth={}
    for k,c in key2cell.items():
        isH=k.startswith('hero:'); seq=[]
        for r in fs:
            i=c*3; seq.append((r['ms'],cls(r['cells'][i],r['cells'][i+1],r['cells'][i+2],head['refB'].get(str(c),0),head['refS'].get(str(c),0),isH)))
        # truth start: first T of final stretch; but also include preceding dim-O run (dark by luminance) as taken
        last=None; run=0
        for i,(ms,s) in enumerate(seq):
            if s=='O': continue
            if s=='T': run=0
            else:
                run+=1
                if run>=2: last=i
        start=0 if last is None else last+1
        seg=[x for x in seq[start:] if x[1]!='O']
        if not seg or seg[-1][1]!='T' or sum(1 for _,s in seg if s=='T')/len(seg)<0.8: continue
        # walk back from first T over O frames whose luminance says dark
        i0=next(i for i in range(start,len(seq)) if seq[i][1]=='T')
        j=i0
        while j-1>=start and seq[j-1][1]=='O':
            r=fs[j-1]; m,mx=r['cells'][c*3],r['cells'][c*3+1]; ref=max(head['refB'].get(str(c),0),8)
            if m/ref<0.32 and mx/ref<0.5: j-=1
            else: break
        t0=seq[j][0]
        if t0<3000: continue
        truth[k]=t0
    res={}
    for variant in ('base','old','nw'):
        gap=0; per={}
        for k,t0 in truth.items():
            g=0; cur=None
            for fr in rp:
                if fr['ms']<t0: continue
                tk=k in fr[variant]
                if not tk and cur is None: cur=fr['ms']
                if tk and cur is not None: g+=fr['ms']-cur; cur=None
            if cur is not None: g+=end-cur
            if g>2500: per[k]=g
            gap+=g
        res[variant]=(gap,per)
    name=os.path.dirname(tr)[:6]+'/'+os.path.basename(tr)[6:20]
    print(f"== {name} 真拿走{len(truth)}件 | 引擎漏算秒数: tracker仅 {res['base'][0]/1000:6.1f}s({len(res['base'][1])}件>2.5s)  旧worker {res['old'][0]/1000:6.1f}s({len(res['old'][1])})  新规则 {res['nw'][0]/1000:6.1f}s({len(res['nw'][1])})")
    worst=sorted(res['nw'][1].items(),key=lambda x:-x[1])[:4]
    if worst: print('     新规则仍漏:',', '.join(f"{CN(k.replace('hero:',''))} {g/1000:.0f}s" for k,g in worst))
    for v in res: tot[v]+=res[v][0]/1000; tot[v+'_n']+=len(res[v][1])
print('TOTAL',dict(tot))
