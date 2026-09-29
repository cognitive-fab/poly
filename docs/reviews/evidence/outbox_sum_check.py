# Independent exploration of the v0.4 OutboxIntent (sum-type state) per 04-semantics.
from collections import deque
TERM={'Done','Denied','Dead'}
init=('Pending',)
def step(s,a):
    tag=s[0]
    if tag in TERM: return None
    if a=='Propose':
        if tag=='Pending': return ('Proposed',1)
        if tag=='Escalated' and s[1]: return ('Proposed',2)
        return None
    if a=='GateAllow':    return ('Allowed',0) if tag=='Proposed' else None
    if a=='GateDeny':     return ('Denied',) if tag=='Proposed' else None
    if a=='GateEscalate': return ('Escalated',False) if (tag=='Proposed' and s[1]==1) else None
    if a=='Approve':      return ('Escalated',True) if (tag=='Escalated' and not s[1]) else None
    if a=='EscalationTimeout': return ('Denied',) if (tag=='Escalated' and not s[1]) else None
    if a=='Start':        return ('Running',s[1]+1) if tag=='Allowed' else None
    if a=='HandlerOk':    return ('Settled',s[1]) if tag=='Running' else None
    if a=='HandlerFailed':
        if tag!='Running': return None
        return ('Allowed',s[1]) if s[1]<3 else ('Dead',)
    if a=='SettleFailed':
        if tag!='Settled': return None
        return ('Allowed',s[1]) if s[1]<3 else ('Dead',)
    if a=='SettleOk':     return ('Done',) if tag=='Settled' else None
ACTS=['Propose','GateAllow','GateDeny','GateEscalate','Approve','EscalationTimeout','Start','HandlerOk','HandlerFailed','SettleFailed','SettleOk']
seen={init}; q=deque([init]); edges=[]
while q:
    s=q.popleft()
    for a in ACTS:
        t=step(s,a)
        if t is None: continue
        edges.append((s,a,t))
        if t[0]=='Allowed': assert 0<=t[1]<=2
        if t[0] in ('Running','Settled'): assert 1<=t[1]<=3
        if s[0] in ('Allowed','Running','Settled'): assert t[0]!='Proposed'
        if t not in seen: seen.add(t); q.append(t)
dead=[s for s in seen if s[0] not in TERM and not any(e[0]==s for e in edges)]
G=[{'Propose'},{'GateAllow','GateDeny','GateEscalate'},{'EscalationTimeout'},{'Start'},{'HandlerOk','HandlerFailed'},{'SettleOk','SettleFailed'}]
nodes=[s for s in seen if s[0] not in TERM]
adj={s:[t for (x,a,t) in edges if x==s and t[0] not in TERM] for s in nodes}
idx={};low={};st=[];on=set();sccs=[];c=[0]
def sc(v):
    idx[v]=low[v]=c[0];c[0]+=1;st.append(v);on.add(v)
    for w in adj[v]:
        if w not in idx: sc(w); low[v]=min(low[v],low[w])
        elif w in on: low[v]=min(low[v],idx[w])
    if low[v]==idx[v]:
        comp=[]
        while True:
            w=st.pop();on.discard(w);comp.append(w)
            if w==v: break
        sccs.append(comp)
for v in nodes:
    if v not in idx: sc(v)
en=lambda s,g: any(step(s,a) is not None for a in g)
bad=[C for C in sccs if all(any(a in g for (x,a,t) in edges if x in C and t in C) or any(not en(s,g) for s in C) for g in G)]
print('representable 17; reachable',len(seen),'edges',len(edges),'deadlocks',dead,'liveness violations',bad)
