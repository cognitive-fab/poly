# Configuration semantics (04-semantics PS13) explored for the checkout example of PT7a:
# two orders and one inventory. Messages in transit form a multiset; any one may be
# delivered next (arrival-order nondeterminism). The inventory is safe on its own in
# both versions; the defect is in the protocol between the machines.
from collections import deque
B=4  # declared in-transit bound
def run(optimistic):
    init=(1,('Idle','Idle'),())            # (inv.onHand, order states, messages in transit)
    def order_step(os,i,msg):
        st=os[i]; kind=msg[0]
        if kind=='Place':
            return ('Asked',[('inv','Query',i)]) if st=='Idle' else None
        if kind=='Available':
            if st!='Asked': return None
            if msg[1]==0: return ('Refused',[])
            return (('Done' if optimistic else 'Taking'),[('inv','Take',i)])
        if kind=='Taken':      return ('Done',[]) if st=='Taking' else None
        if kind=='OutOfStock': return ('Refused',[]) if st=='Taking' else None
    def inv_step(n,kind,frm):
        if kind=='Query': return (n,[(('o',frm),'Available',n)])
        if n>0: return (n-1,[(('o',frm),'Taken',None)])
        return (n,[(('o',frm),'OutOfStock',None)])
    def norm(t): return tuple(sorted(t,key=repr))
    def succ(s):
        n,os,tr=s
        for i in range(2):
            r=order_step(os,i,('Place',))
            if r:
                st,out=r; o=list(os); o[i]=st
                yield (f'input   Place@order[{i}]',(n,tuple(o),norm(tr+tuple(out))))
        for j,m in enumerate(tr):
            rest=tr[:j]+tr[j+1:]
            if m[0]=='inv':
                n2,out=inv_step(n,m[1],m[2])
                yield (f'deliver {m[1]}(order[{m[2]}]) -> inv',(n2,os,norm(rest+tuple(out))))
            else:
                i=m[0][1]; r=order_step(os,i,(m[1],m[2]))
                arg='' if m[2] is None else f'({m[2]})'
                if r is None:
                    yield (f'deliver {m[1]}{arg} -> order[{i}] (rejected)',(n,os,rest)); continue
                st,out=r; o=list(os); o[i]=st
                yield (f'deliver {m[1]}{arg} -> order[{i}]',(n,tuple(o),norm(rest+tuple(out))))
    inv=lambda s: sum(o=='Done' for o in s[1]) <= 1   # confirmed orders never exceed the initial stock
    seen={init:None}; q=deque([init]); bad=None; hit=False
    while q:
        s=q.popleft()
        if not inv(s): bad=s; break
        for lab,t in succ(s):
            if len(t[2])>B: hit=True; continue
            if t not in seen: seen[t]=(s,lab); q.append(t)
    w=[]
    if bad:
        s=bad
        while seen[s]: s,lab=seen[s]; w.append(lab)
    stuck=[s for s in seen if not s[2] and any(o in ('Asked','Taking') for o in s[1])]
    return len(seen),bad,list(reversed(w)),hit,stuck
for optimistic in (True,False):
    n,bad,w,hit,stuck=run(optimistic)
    print('optimistic order' if optimistic else 'order waits for Taken',
          '| states explored',n,'| confirmed-within-stock', 'VIOLATED' if bad else 'holds',
          '| bound hit',hit,'| stuck',stuck)
    for x in w: print('   ',x)
