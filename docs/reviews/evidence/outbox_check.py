# Independent BFS of the five-field OutboxIntent machine per 04-semantics, in two variants:
# v0.3 (SettleFailed goes to Dead after the third attempt) and v0.2 (SettleFailed always
# returns to Allowed, the form the formal review found stuck; also AC9's variant).
import sys
VARIANT=sys.argv[1] if len(sys.argv)>1 else 'v0.3'
from collections import deque
TERM={'Done','Denied','Dead'}
init=('Pending',0,0,False,False)  # status, attempts, decisions, executed, approved
def step(s,a):
    st,att,dec,ex,ap=s
    if st in TERM: return None
    def acc(**w):
        d=dict(status=st,attempts=att,decisions=dec,executed=ex,approved=ap); d.update(w)
        return (d['status'],d['attempts'],d['decisions'],d['executed'],d['approved'])
    if a=='Propose':
        if not (st=='Pending' or (st=='Escalated' and ap)): return None
        return acc(status='Proposed',decisions=dec+1)
    if a=='GateAllow': return acc(status='Allowed') if st=='Proposed' else None
    if a=='GateDeny':
        if st!='Proposed' or ex: return None
        return acc(status='Denied')
    if a=='GateEscalate':
        if st!='Proposed' or dec!=1: return None
        return acc(status='Escalated')
    if a=='Approve': return acc(approved=True) if st=='Escalated' else None
    if a=='EscalationTimeout': return acc(status='Denied') if (st=='Escalated' and not ap) else None
    if a=='Start':
        if st!='Allowed' or att>=3: return None
        return acc(status='Running',attempts=att+1,executed=True)
    if a=='HandlerOk': return acc(status='Settled') if st=='Running' else None
    if a=='HandlerFailed':
        if st!='Running': return None
        return acc(status='Allowed' if att<3 else 'Dead')
    if a=='SettleFailed':
        if st!='Settled': return None
        if VARIANT=='v0.2': return acc(status='Allowed')      # v0.2: always back to Allowed
        return acc(status='Allowed' if att<3 else 'Dead')     # v0.3: Dead after the third attempt
    if a=='SettleOk': return acc(status='Done') if st=='Settled' else None
ACTS=['Propose','GateAllow','GateDeny','GateEscalate','Approve','EscalationTimeout','Start','HandlerOk','HandlerFailed','SettleFailed','SettleOk']
seen={init}; q=deque([init]); edges=[]
while q:
    s=q.popleft()
    for a in ACTS:
        t=step(s,a)
        if t is None: continue
        edges.append((s,a,t))
        assert 0<=t[1]<=3 and 0<=t[2]<=2, ('domain',s,a,t)
        st,att,dec,ex,ap=t
        assert (not ex) or (dec<=1 or ap), ('inv',s,a,t)
        if s[0] in ('Allowed','Running','Settled'): assert t[0]!='Proposed'
        if s[3]: assert t[0]!='Denied'
        if t not in seen: seen.add(t); q.append(t)
dead=[s for s in seen if s[0] not in TERM and not any(e[0]==s for e in edges)]
print(VARIANT,'states',len(seen),'accepted steps',len(edges),'deadlocks',sorted(dead))
# liveness: fair SCCs among non-terminal states (weak fairness per group)
G=[{'Propose'},{'GateAllow','GateDeny','GateEscalate'},{'EscalationTimeout'},{'Start'},{'HandlerOk','HandlerFailed'},{'SettleOk','SettleFailed'}]
nodes=[s for s in seen if s[0] not in TERM]
adj={s:[(a,t) for (x,a,t) in edges if x==s and t[0] not in TERM] for s in nodes}
# Tarjan
idx={};low={};stack=[];on=set();sccs=[];c=[0]
import sys; sys.setrecursionlimit(10000)
def sc(v):
    idx[v]=low[v]=c[0];c[0]+=1;stack.append(v);on.add(v)
    for a,w in adj[v]:
        if w not in idx: sc(w); low[v]=min(low[v],low[w])
        elif w in on: low[v]=min(low[v],idx[w])
    if low[v]==idx[v]:
        comp=[]
        while True:
            w=stack.pop();on.discard(w);comp.append(w)
            if w==v: break
        sccs.append(comp)
for v in nodes:
    if v not in idx: sc(v)
def enabled(s,g): return any(step(s,a) is not None for a in g)
bad=[]
for C in sccs:
    Cs=set(C); inner=[(x,a,t) for (x,a,t) in edges if x in Cs and t in Cs]
    # rejected steps are self-loop stutters: every non-terminal state has them, so every SCC can repeat
    ok_fair=all(any(a in g for (_,a,_) in inner) or any(not enabled(s,g) for s in C) for g in G)
    if ok_fair: bad.append(C)
print('fair non-terminal SCCs (liveness violations):',bad)
