from collections import deque
init=('Locked',0)
def step(s,a):
    m,c=s
    if a=='Coin': return ('Unlocked',c+1) if c<3 else None
    if a=='Push': return ('Locked',c) if m=='Unlocked' else None
    if a=='Empty': return (m,0) if m=='Locked' else None
def explore(acts):
    seen={init};q=deque([init]);E=[];par={init:None}
    while q:
        s=q.popleft()
        for a in acts:
            t=step(s,a)
            if t is None: continue
            E.append((s,a,t)); assert not (t[1]==0 and t[0]!='Locked'),('inv',s,a,t)
            if t not in seen: seen.add(t);par[t]=(s,a);q.append(t)
    dead=[s for s in seen if not any(e[0]==s for e in E)]
    return seen,dead,par
for acts in (['Coin','Push'],['Coin','Push','Empty']):
    seen,dead,par=explore(acts)
    w=[]
    if dead:
        s=dead[0]
        while par[s]: s,a=par[s]; w.append(a)
    print(acts,'states',len(seen),'deadlocks',dead,'witness',list(reversed(w)))
