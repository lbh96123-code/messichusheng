import re,glob,sys,collections
L=re.compile(r'^\[(\d\d:\d\d:\d\d\.\d+)\] (\w+)\s+(.*)$')
tot=collections.Counter()
for f in sorted(glob.glob('*/ad_*.log')):
    lines=open(f,encoding='utf-8',errors='replace').read().splitlines()
    # split into games by "pool    锁定"
    fast_taken={}   # key -> time first seen dark via fast
    track_taken={}  # key -> (time, seat)
    rejected=set()
    game=0; hits=[]
    for ln in lines:
        m=L.match(ln)
        if not m: continue
        t,tag,msg=m.groups()
        if tag=='pool' and msg.startswith('锁定') :
            if '同一池子' in msg: pass
        if tag=='pool' and msg.startswith('池子:'):
            game+=1; fast_taken={}; track_taken={}; rejected=set(); continue
        if tag=='fast':
            mm=re.match(r'(\S+) 整格变暗 → 判定',msg)
            if mm: fast_taken.setdefault(mm.group(1),t); rejected.discard(mm.group(1))
        elif tag=='track':
            mm=re.match(r'(技能|英雄) (\S*) → (\S*)',msg)
            if mm:
                k=mm.group(2); seat=mm.group(3)
                if not k: continue
                if '不当落子' in msg or seat=='' :
                    rejected.add(k); track_taken.pop(k,None)
                else:
                    track_taken.setdefault(k,(t,seat)); rejected.discard(k)
        elif tag=='advice':
            mm=re.search(r'前三 (.*?) 候选(\d+)',msg)
            if not mm: continue
            top=[x.strip().split(' 我方')[0] for x in mm.group(1).split('|')]
            tot['advice']+=1
            for name in top:
                src=None
                if name in track_taken: src='归属%s@%s'%(track_taken[name][1],track_taken[name][0])
                elif name in fast_taken and name not in rejected: src='快扫变暗@%s'%fast_taken[name]
                if src:
                    tot['hit']+=1
                    hits.append((t,name,src,msg[:60]))
    print('==',f,'games',game,'hits',len(hits))
    for h in hits: print('   ',*h)
print(tot)
