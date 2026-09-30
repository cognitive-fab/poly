# Configuration liveness (04-semantics PS6.4, PS13, PS14) for the checkout example of PT7a: two orders and
# one inventory, messages in transit as a multiset, any one delivered next. Written from the semantics
# alone (S77), in the manner of config_check.py; it first reproduces that script's results, then checks
#   liveness settle: forall i in order: order[i] is Asked leads to order[i] is Done | Refused
# for the order that waits for Taken. No input is fair (the clause is empty); delivery is weakly fair per
# message value (PS13.2b, PS14.2): a value in transit stays deliverable until it is delivered.
from collections import deque
B = 4  # declared in-transit bound
TERMINAL = ('Done', 'Refused')

def order_step(os, i, msg, optimistic):
    st = os[i]; kind = msg[0]
    if st in TERMINAL: return None                      # PS3.2 row 1: a terminal instance rejects
    if kind == 'Place':
        return ('Asked', [('inv', 'Query', i)]) if st == 'Idle' else None
    if kind == 'Available':
        if st != 'Asked': return None
        if msg[1] == 0: return ('Refused', [])
        return (('Done' if optimistic else 'Taking'), [('inv', 'Take', i)])
    if kind == 'Taken': return ('Done', []) if st == 'Taking' else None
    if kind == 'OutOfStock': return ('Refused', []) if st == 'Taking' else None

def inv_step(n, kind, frm):
    if kind == 'Query': return (n, [(('o', frm), 'Available', n)])
    if n > 0: return (n - 1, [(('o', frm), 'Taken', None)])
    return (n, [(('o', frm), 'OutOfStock', None)])

def norm(t): return tuple(sorted(t, key=repr))

def successors(s, optimistic):
    """Every global step (PS13.3): each input, accepted or rejected (a rejection is a stutter, PS3.3), and
    the delivery of each distinct message value in transit, which consumes it even when rejected."""
    n, os, tr = s
    out = []
    for i in range(2):
        r = order_step(os, i, ('Place',), optimistic)
        if r:
            st, sent = r; o = list(os); o[i] = st
            out.append((('input', i), f'input   Place@order[{i}]', (n, tuple(o), norm(tr + tuple(sent)))))
        else:
            out.append((('input', i), f'input   Place@order[{i}] (rejected)', s))
    seen = set()
    for j, m in enumerate(tr):
        if m in seen: continue
        seen.add(m)
        rest = tr[:j] + tr[j + 1:]
        if m[0] == 'inv':
            n2, sent = inv_step(n, m[1], m[2])
            out.append((('deliver', m), f'deliver {m[1]}(order[{m[2]}]) -> inv', (n2, os, norm(rest + tuple(sent)))))
        else:
            i = m[0][1]; r = order_step(os, i, (m[1], m[2]), optimistic)
            arg = '' if m[2] is None else f'({m[2]})'
            if r is None:
                out.append((('deliver', m), f'deliver {m[1]}{arg} -> order[{i}] (rejected)', (n, os, rest)))
            else:
                st, sent = r; o = list(os); o[i] = st
                out.append((('deliver', m), f'deliver {m[1]}{arg} -> order[{i}]', (n, tuple(o), norm(rest + tuple(sent)))))
    return out

def explore(optimistic):
    init = (1, ('Idle', 'Idle'), ())
    seen = {init: None}; q = deque([init]); edges = {}; hit = False; bad = None
    confirmed_within_stock = lambda s: sum(o == 'Done' for o in s[1]) <= 1
    while q:
        s = q.popleft()
        if bad is None and not confirmed_within_stock(s): bad = s
        edges[s] = []
        for group, label, t in successors(s, optimistic):
            if len(t[2]) > B: hit = True; continue
            edges[s].append((group, label, t))
            if t not in seen: seen[t] = (s, label); q.append(t)
    witness = []
    if bad is not None:
        s = bad
        while seen[s]: s, lab = seen[s]; witness.append(lab)
    return seen, edges, list(reversed(witness)), hit

def sccs(nodes, adj):
    index = {}; low = {}; stack = []; on = set(); out = []; counter = [0]
    for root in nodes:
        if root in index: continue
        work = [(root, iter(adj[root]))]
        index[root] = low[root] = counter[0]; counter[0] += 1; stack.append(root); on.add(root)
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter[0]; counter[0] += 1; stack.append(w); on.add(w)
                    work.append((w, iter(adj[w]))); advanced = True; break
                elif w in on: low[v] = min(low[v], index[w])
            if advanced: continue
            work.pop()
            if work: low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                c = []
                while True:
                    x = stack.pop(); on.discard(x); c.append(x)
                    if x == v: break
                out.append(c)
    return out

def settle_violations(edges, i):
    """PS6.4 for `order[i] is Asked leads to order[i] is Done | Refused`: components of the states reached
    from an Asked state through states where order[i] is not settled, that have an edge and are fair for
    every message value's delivery."""
    settled = lambda s: s[1][i] in TERMINAL
    starts = [s for s in edges if s[1][i] == 'Asked']
    pending = set(starts); q = deque(starts)
    while q:
        s = q.popleft()
        for _, _, t in edges[s]:
            if not settled(t) and t not in pending: pending.add(t); q.append(t)
    adj = {s: [t for _, _, t in edges[s] if t in pending] for s in pending}
    bad = []
    for c in sccs(list(pending), adj):
        cs = set(c)
        inner = [(s, g, t) for s in c for g, _, t in edges[s] if t in cs]
        if not inner: continue
        values = {m for s in c for m in s[2]}
        fair = True
        for m in values:  # one group per message value in transit
            taken = any(g == ('deliver', m) for _, g, _ in inner)
            disabled = any(m not in s[2] for s in c)
            if not (taken or disabled): fair = False; break
        if fair: bad.append(sorted(c))
    return bad

for optimistic in (True, False):
    seen, edges, w, hit = explore(optimistic)
    name = 'optimistic order' if optimistic else 'order waits for Taken'
    print(name, '| states explored', len(seen), '| confirmed-within-stock', 'VIOLATED' if w else 'holds', '| bound hit', hit)
    for x in w: print('   ', x)
    if not optimistic:
        for i in range(2):
            v = settle_violations(edges, i)
            print(f'    settle for order[{i}]:', 'holds' if not v else f'VIOLATED, {len(v)} fair component(s)')
