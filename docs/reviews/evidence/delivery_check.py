# Independent exploration of the Delivery machine (technical spec PT9.8, draft v0.6),
# written from 04-semantics. Two messages M1, M2 from one sender to one receiver.
# The network may lose a request or an ack at most once per message (finite loss),
# the worker may resend while a message is in flight, and the receiver deduplicates.
from collections import deque
from itertools import product
MS=(0,1)
def explore(fifo, keep_dedupe_on_archive, check_fifo_order):
    # state: status(2) req(2) ack(2) lost(2) seen(2) steps(2) archived
    init=(('U','U'),(0,0),(0,0),(0,0),(False,False),(0,0),False)
    def upd(t,i,v): l=list(t); l[i]=v; return tuple(l)
    def step(s,a,m):
        st,req,ack,lost,seen,steps,arc=s
        if a=='Emit':
            if st[m]!='U' or (m==1 and st[0]=='U'): return None
            return (upd(st,m,'P'),req,ack,lost,seen,steps,arc)
        if a=='Send':
            if st[m]!='P' or req[m]>=2: return None
            if fifo and m==1 and st[0]!='A': return None
            return (upd(st,m,'F'),upd(req,m,req[m]+1),ack,lost,seen,steps,arc)
        if a=='Resend':
            if st[m]!='F' or req[m]>=2: return None
            return (st,upd(req,m,req[m]+1),ack,lost,seen,steps,arc)
        if a=='LoseReq':
            if req[m]==0 or lost[m]>=1: return None
            return (st,upd(req,m,req[m]-1),ack,upd(lost,m,1),seen,steps,arc)
        if a=='DeliverReq':
            if req[m]==0: return None
            req2=upd(req,m,req[m]-1); ack2=upd(ack,m,min(ack[m]+1,2))
            if seen[m]: return (st,req2,ack2,lost,seen,steps,arc)
            return (st,req2,ack2,lost,upd(seen,m,True),upd(steps,m,steps[m]+1),arc)
        if a=='LoseAck':
            if ack[m]==0 or lost[m]>=1: return None
            return (st,req,upd(ack,m,ack[m]-1),upd(lost,m,1),seen,steps,arc)
        if a=='DeliverAck':
            if ack[m]==0: return None
            st2=upd(st,m,'A') if st[m]=='F' else st
            return (st2,req,upd(ack,m,ack[m]-1),lost,seen,steps,arc)
        if a=='Archive':
            if arc or steps!=(1,1): return None
            return (st,req,ack,lost,seen if keep_dedupe_on_archive else (False,False),steps,True)
    ACTS=[(a,m) for a in ('Emit','Send','Resend','LoseReq','DeliverReq','LoseAck','DeliverAck') for m in MS]+[('Archive',0)]
    seen_={init:None}; q=deque([init]); edges=[]; bad=None
    def safe(s):
        if max(s[5])>1: return 'at-most-once'
        if check_fifo_order and s[5][1]==1 and s[5][0]==0: return 'fifo-order'
        return None
    while q:
        s=q.popleft()
        if safe(s): bad=(s,safe(s)); break
        for a,m in ACTS:
            t=step(s,a,m)
            if t is None: continue
            edges.append((s,(a,m),t))
            if t not in seen_: seen_[t]=(s,f'{a}(M{m+1})' if a!='Archive' else 'Archive'); q.append(t)
    w=[]
    if bad:
        s=bad[0]
        while seen_[s]: s,l=seen_[s]; w.append(l)
        return len(seen_),bad[1],list(reversed(w)),None
    # liveness: eventually all acked and stepped once, under weak fairness of the groups below
    done=lambda s: s[0]==('A','A') and s[5]==(1,1)
    FAIR=[{('Emit',m)} for m in MS]+[{('Send',m)} for m in MS]+[{('Resend',m)} for m in MS]+ \
         [{('DeliverReq',m)} for m in MS]+[{('DeliverAck',m)} for m in MS]
    nodes=[s for s in seen_ if not done(s)]
    ns=set(nodes)
    adj={s:[t for (x,l,t) in edges if x==s and t in ns] for s in nodes}
    idx={};low={};stk=[];on=set();sccs=[];c=[0]
    import sys; sys.setrecursionlimit(100000)
    def sc(v):
        idx[v]=low[v]=c[0];c[0]+=1;stk.append(v);on.add(v)
        for w_ in adj[v]:
            if w_ not in idx: sc(w_); low[v]=min(low[v],low[w_])
            elif w_ in on: low[v]=min(low[v],idx[w_])
        if low[v]==idx[v]:
            comp=[]
            while True:
                x=stk.pop();on.discard(x);comp.append(x)
                if x==v: break
            sccs.append(comp)
    for v in nodes:
        if v not in idx: sc(v)
    def enabled(s,g): return any(step(s,a,m) is not None for (a,m) in g)
    unfair=[]
    for C in sccs:
        Cs=set(C); inner=[(x,l,t) for (x,l,t) in edges if x in Cs and t in Cs]
        stutter = any(all(step(s,a,m) is None or step(s,a,m) not in ns for (a,m) in ACTS) for s in C)  # quiescent non-done
        if not inner and not stutter: continue
        if all(any(l in g for (_,l,_) in inner) or any(not enabled(s,g) for s in C) for g in FAIR):
            unfair.append(C)
    return len(seen_),None,[],len(unfair)
for name,args in [('in-order worker, dedupe kept on archive',(True,True,True)),
                  ('parallel worker, dedupe kept on archive',(False,True,False)),
                  ('parallel worker, fifo order required',(False,True,True)),
                  ('in-order worker, dedupe cleared on archive',(True,False,True))]:
    n,viol,w,unfair=explore(*args)
    if viol: print(f'{name}: VIOLATED {viol}; witness {w}')
    else: print(f'{name}: {n} states; at-most-once holds; liveness violations: {unfair}')
