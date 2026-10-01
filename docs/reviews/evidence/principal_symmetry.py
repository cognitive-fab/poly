"""PD5 open question 1: how many principal representatives does the checker need?

An independent model of the PD5.1 refund example, sharing no code with the compiler or poly-ref. A refund above a
limit needs an approval. The approval's caller carries claims (kind, assurance, principal); the approver must be a
person with assurance at least 2 who is not the requester. The approver is stored, so the module has two fields of
type Principal (requester, approver).

Property: no refund is emitted after an accepted approval whose principal is the requester.

Principals are explored by representatives p0..p(n-1) for n = 1, 2, 3, 4. Each guard is written as data in a tiny
expression language, so the script can see every operation applied to a principal: equality is inside PD5.1.2b's
rule, and anything else (an order comparison) is reported as outside it and the run is not trusted.

For each n the script prints the reachable states, the states up to renaming of principals (the symmetry orbits),
whether an approval is reachable at all (a CLEAN verdict where no approval is reachable is vacuous), and the
verdict: CLEAN, VIOLATED with a witness, or INCONCLUSIVE when the state bound is hit.

Two mutant controls: one without the self-approval require (must be VIOLATED with a witness), and one that compares
principals by order instead of equality (must be flagged as outside the equality-only rule).

Run: python principal_symmetry.py
"""
from collections import deque
from itertools import permutations, product

LIMIT = 1
AMOUNTS = (1, 2)
KINDS = ('Person', 'Agent', 'Service')
ASSURANCE = (0, 1, 2, 3)
NONE = None
MAX_STATES = 200_000

# Guards are tuples: ('eq'|'ne'|'lt'|'ge', left, right) over terms ('field', f) | ('claim', c) | ('param', p) | ('const', v),
# and ('and', g1, g2). The type of each term says whether it is a principal.
PRINCIPAL_TERMS = {('field', 'requester'), ('field', 'approver'), ('claim', 'principal')}


def term(t, state, caller, params):
    kind, name = t
    if kind == 'field':
        return state[name]
    if kind == 'claim':
        return caller[name]
    if kind == 'param':
        return params[name]
    return name


def holds(g, state, caller, params):
    op = g[0]
    if op == 'and':
        return holds(g[1], state, caller, params) and holds(g[2], state, caller, params)
    a, b = term(g[1], state, caller, params), term(g[2], state, caller, params)
    if op == 'eq':
        return a == b
    if op == 'ne':
        return a != b
    if op == 'ge':
        return a >= b
    if op == 'lt':
        # Principals are opaque; an order exists only on their representatives' names, which is the point of the mutant.
        return str(a) < str(b)
    raise ValueError(op)


def principal_ops(g, out):
    """Every operation the guard applies to a principal: the equality-only check of PD5.1.2b."""
    if g[0] == 'and':
        principal_ops(g[1], out)
        principal_ops(g[2], out)
        return out
    if g[1] in PRINCIPAL_TERMS or g[2] in PRINCIPAL_TERMS:
        out.append(g[0])
    return out


PERSON = ('eq', ('claim', 'kind'), ('const', 'Person'))
ASSURED = ('ge', ('claim', 'assurance'), ('const', 2))
NOT_SELF = ('ne', ('claim', 'principal'), ('field', 'requester'))
ORDERED = ('lt', ('field', 'requester'), ('claim', 'principal'))

MODELS = {
    'reference': ('and', PERSON, ('and', ASSURED, NOT_SELF)),
    'mutant: no self-approval require': ('and', PERSON, ASSURED),
    'mutant: principals compared by order': ('and', PERSON, ('and', ASSURED, ORDERED)),
}


def canonical(state):
    """The state with principals renamed by order of first appearance: one representative per symmetry orbit."""
    names = {}
    out = []
    for k in ('status', 'requester', 'approver', 'selfApproved', 'refundAfterSelf'):
        v = state[k]
        if isinstance(v, str) and v.startswith('p'):
            names.setdefault(v, f'q{len(names)}')
            v = names[v]
        out.append(v)
    return tuple(out)


def successors(state, n, approve_guard):
    principals = [f'p{i}' for i in range(n)]
    out = []
    # Request(amount) by caller: a refund at or below the limit is emitted at once; above it, it awaits an approval.
    if state['status'] == 'Idle':
        for amount, p in product(AMOUNTS, principals):
            t = dict(state, requester=p)
            if amount > LIMIT:
                t['status'] = 'Awaiting'
                emitted = False
            else:
                t['status'] = 'Refunded'
                emitted = True
            if emitted and t['selfApproved']:
                t['refundAfterSelf'] = True
            out.append((f'Request({amount}) by {p}', t))
    # Approve() by caller: every claim value a verifier could assert is offered (PS4.1b applied to claims).
    if state['status'] == 'Awaiting':
        for kind, assurance, p in product(KINDS, ASSURANCE, principals):
            caller = {'kind': kind, 'assurance': assurance, 'principal': p}
            if not holds(approve_guard, state, caller, {}):
                continue
            t = dict(state, status='Refunded', approver=p)
            if p == state['requester']:
                t['selfApproved'] = True
            # The approval emits the refund.
            if t['selfApproved']:
                t['refundAfterSelf'] = True
            out.append((f'Approve by {kind}/{assurance}/{p}', t))
    return out


def explore(n, approve_guard, max_states=MAX_STATES):
    init = {'status': 'Idle', 'requester': NONE, 'approver': NONE, 'selfApproved': False, 'refundAfterSelf': False}
    key = lambda s: tuple(s[k] for k in ('status', 'requester', 'approver', 'selfApproved', 'refundAfterSelf'))
    seen = {key(init): None}
    queue = deque([init])
    approval_reachable = False
    while queue:
        s = queue.popleft()
        if s['refundAfterSelf']:
            path = []
            k = key(s)
            while seen[k] is not None:
                k, label = seen[k]
                path.append(label)
            return {'states': len(seen), 'orbits': len({canonical(dict(zip(('status', 'requester', 'approver', 'selfApproved', 'refundAfterSelf'), x))) for x in seen}), 'approval': True, 'verdict': 'VIOLATED', 'witness': list(reversed(path))}
        for label, t in successors(s, n, approve_guard):
            if label.startswith('Approve'):
                approval_reachable = True
            kt = key(t)
            if kt not in seen:
                if len(seen) >= max_states:
                    return {'states': len(seen), 'orbits': None, 'approval': approval_reachable, 'verdict': 'INCONCLUSIVE', 'witness': None}
                seen[kt] = (key(s), label)
                queue.append(t)
    orbits = len({canonical(dict(zip(('status', 'requester', 'approver', 'selfApproved', 'refundAfterSelf'), x))) for x in seen})
    return {'states': len(seen), 'orbits': orbits, 'approval': approval_reachable, 'verdict': 'CLEAN', 'witness': None, 'symmetric': symmetric(set(seen), n)}


def symmetric(states, n):
    """Whether the reachable set is closed under every renaming of the representatives: what equality-only use
    guarantees, and what the symmetry reduction relies on."""
    names = [f'p{i}' for i in range(n)]
    for perm in permutations(names):
        m = dict(zip(names, perm))
        for st in states:
            if tuple(m.get(v, v) if isinstance(v, str) else v for v in st) not in states:
                return False
    return True


def main():
    principal_fields = 2  # requester, approver
    print(f'Principal fields: {principal_fields}; the conjecture of PD5.1.2b is {principal_fields + 1} representatives.\n')
    for name, guard in MODELS.items():
        ops = principal_ops(guard, [])
        outside = sorted({o for o in ops if o not in ('eq', 'ne')})
        print(f'== {name}')
        print(f'   operations on principals: {sorted(set(ops)) or "none"}')
        if outside:
            print(f'   OUTSIDE THE EQUALITY-ONLY RULE ({", ".join(outside)}): PD5.1.2b would refuse it (PL6702), and symmetry does not hold, so these verdicts are not trusted:')
        rows = []
        for n in (1, 2, 3, 4):
            r = explore(n, guard)
            rows.append((n, r))
            vac = '' if r['approval'] else ' (vacuous: no approval reachable)'
            orbits = '-' if r['orbits'] is None else r['orbits']
            sym = '' if r.get('symmetric', True) else ' (reachable states NOT closed under renaming principals)'
            print(f'   n={n}: states {r["states"]:>4}, orbits {orbits:>3}, verdict {r["verdict"]}{vac}{sym}' + (f', witness {r["witness"]}' if r['witness'] else ''))
        key = lambda r: (r['verdict'], r['approval'])
        stable = next(n for n, r in rows if all(key(x) == key(r) for m, x in rows if m >= n))
        print(f'   smallest n from which the verdict (and its vacuity) no longer changes: {stable}\n')
    # The bound control: a state bound below the reachable states gives INCONCLUSIVE, never CLEAN.
    r = explore(4, MODELS['reference'], max_states=5)
    print(f'== bound control: reference, n=4, at most 5 states: verdict {r["verdict"]}')


if __name__ == '__main__':
    main()
