# PD6: Freshness of claims and narrowing delegation

*Proposal v0.1, 3 October 2026. Not scheduled: for planning after M6. Prompted by H. Ashar, "The Trust Anchor Advantage" (LinkedIn, 1 October 2026).*

## The problem

PD5 brings verified identity into poly as typed claims, and the gate decides what a claimant may do. Ashar's article on EU digital identity wallets names two requirements PD5 does not yet state:

1. **Freshness.** A credential's validity is only as recent as the status the verifier last saw. Cached status may be enough for everyday actions, and a high-value action may need a fresh presentation. The decision depends on how old the evidence is, and PD5 claims do not carry their age.
2. **Narrowing delegation.** A customer signs a scoped mandate for an agent ("reserve a van for Saturday, under $300, at one of two locations"). If that agent hands work to another agent, authority may only narrow along the chain. PD5's lineage records where a chain started; it does not check that each hop's scope is within the one before.

The article's principle is PD5's own: the wallet proves the claim, and policy makes the call. PD6 adds the two inputs the call needs.

## PD6.1 Freshness

- **Claims carry their times.** The verifier adapter adds `verifiedAt` (when the presentation was checked) and `statusAt` (the time of the status information it used) to every claims record. Both are hashed into the `step` event with the claims digest (PD5-A11).
- **Policies read ages.** `age(step.claims)` and `statusAge(step.claims)` are durations computed by the gate at decision time, and recorded in the `verdict` event, so replay is exact (as for singleton reads, S147). Example: `require statusAge(step.claims) <= 10m for class irreversible else escalate "stale-claims"`.
- **Unknown is unknown.** A claims record without times is unknown for any age rule, and `on unknown` decides (PS8.2). It is never treated as fresh.
- **Refresh, bounded.** An escalation `stale-claims` asks the host for a fresh presentation through the adapter. The intent is then proposed again under a new `sseq`, with the same bound as `Recheck`; when the bound is spent the intent is denied with reason `stale-claims`.
- **Checking.** Age rules are checked over a finite domain: each age is abstracted into the intervals cut by the thresholds the policies mention, as decisions are explored by intervals (PD1). The decision-table check (S149) covers them, and a `never` statement can state "no irreversible effect on claims older than the threshold".

## PD6.2 Narrowing delegation

- **A mandate is a claims kind.** `Mandate { delegator: Principal, delegate: AgentKey, scope: Scope, expires: Time }`, verified by the adapter like any other claim, with its parent mandate when it is a sub-delegation.
- **Scope is finite and comparable.** A scope is a conjunction of constraints over finite or ordered domains: a set of allowed actions, a set of allowed values per field, an upper bound per numeric field, an expiry. Subset between two scopes is then decidable.
- **The narrowing rule (K12).** For every hop, `scope(child) ⊆ scope(parent)` and `expires(child) <= expires(parent)`, and the child's delegator is the parent's delegate. A chain that widens anywhere is refused before the module, with reason `mandate-widened`, journaled, state unchanged.
- **Every action, not the first.** The gate checks each proposal against the innermost mandate's scope. The agent acts on behalf of the delegator and is never the delegator: policies read both `step.claims.delegate` and `step.claims.principal`.
- **Revocation.** Revoking a mandate revokes every mandate beneath it. This reuses PD5's revocation and halt (PD5-A12).

## Acceptance criteria (proposed)

- **PD6-A1.** A claims record with `statusAge` above a policy's threshold escalates `stale-claims`; after a fresh presentation the same intent is allowed; a record with no times is unknown and follows `on unknown`.
- **PD6-A2.** Ages are recorded in the `verdict` event, and replay reproduces every decision that depended on one.
- **PD6-A3.** The decision-table check proves a `never` statement over ages, and a seeded policy without the age rule gives a finding with a witness.
- **PD6-A4.** A two-hop chain whose second mandate raises the amount bound, adds an action, or extends the expiry is refused `mandate-widened` before the module.
- **PD6-A5.** An agent within its mandate is allowed; the same agent proposing an action outside the innermost scope is denied, on its tenth action as on its first.
- **PD6-A6.** Revoking a parent mandate stops every action under its sub-mandates, as PD5-A12 does for a revoked credential.

## Not in scope

- The wallet protocols themselves. A verifier adapter for a wallet credential format is host code, like the person-key adapter; poly sees only verified claims.
- Liveness and presence ("is the person at the counter the person on the license"). That is a claim an adapter may supply at some assurance; poly does not judge it.
- Intent beyond scope ("within the mandate but against the customer's true intent"). PD6 makes the mandate checkable; it does not infer intent.

## Open questions

- Whose clock computes ages, and how is that clock trusted and recorded?
- How expressive must a scope be before subset stops being decidable cheaply?
- Should `stale-claims` refresh share `Recheck`'s bound, or have its own?

## Conclusion

PD5 makes identity an input to policy. PD6 makes two more properties of that input checkable: how old the evidence is, and whether delegated authority only narrows. Both reduce to finite, typed data that the gate decides on and the ledger records, so the article's principle holds through every hop: the credential proves the claim, the mandate bounds the agent, and policy makes each call.

## Glossary

- **Freshness:** the age of the evidence behind a claim, as `age` (since verification) and `statusAge` (since the status information used).
- **Mandate:** a verified claim by which a principal authorizes a named agent key to act within a scope until an expiry.
- **Scope:** a finite conjunction of constraints on actions and field values, comparable by subset.
- **Narrowing rule (K12):** each sub-mandate's scope and expiry lie within its parent's.
- **Stale claims:** claims whose age exceeds what a policy requires for the action proposed.
