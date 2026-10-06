# M10 planning brief: Memory

M10 is planned while M9 is built, and built in parallel with M11 once M9 closes (`decisions-m9.md`, "how M9 to M11 run"). The first deliverable is `docs/plan-m10.md`, for the owner's ruling. No code before the plan is ruled.

## 1. Scope

As `docs/proposals/v1-technical-spec.md` sets it (PT23): `audience`, `source`, `retrieve`, `Items`; taint as a ghost component in poly-ref; citations; `remember`; `poly memory verify`; `poly forget`; source adapters for Postgres and a document index. Gate: AC22 to AC24, and the flow rule's seeded control gives `PL6831` with the shortest witness.

## 2. What the plan must settle

- **Taint in poly-ref (PT23.3).** How the ghost component is added to the state without blowing up the state space: its domain, and the measured cost on the concierge. The checker and poly-ref must agree on the flow rule by translation validation.
- **E10 for taint.** M8 settled E10 for the `channel` field only. State whether per-value taint needs polyaxion, or whether poly-runtime computes it and passes a field, as for `channel` (PT27.2's fallback). Settle it by test, fail closed.
- **Forgetting (PT23.6) and S205.** `poly forget` and the erasable content store of M9 (S205, which absorbs S191) are one mechanism. The plan reuses M9's store, or says why not.
- **Freshness (PT23.4)** reuses M9's ages (S196): the runtime's clock, recorded in the verdict, never read on replay.
- **Source adapters** live in `poly-io` and are certified like the channel and vault adapters, tested against recorded traffic, with no live database in a test.
- **What a record may hold.** Retrieved content is `Content` by digest. No item body, query text or credential enters the journal, the ledger or a certificate.

## 3. Numbering and shared files

Spec issues S300 to S349. New codes from PL6833 to PL6839, beside the ones PT27.1 already assigns (PL6831, PL6832). List every change to `04-semantics.md` and to shared packages (`poly-core`, `poly-ref`, `poly-runtime`) in the plan, so it can be ruled together with M11's.

## 4. How it runs

As `decisions-m9.md` sets: a ruled plan runs to its end, stopping only for semantics, security, verdict or engine changes. Rulings in `docs/decisions-m10.md`. Commits as `kizo-core`, never pushed.

## Conclusion

M10 gives poly governed memory: what an agent retrieves, who may see it, where it came from, and how it is forgotten, all checked. Its plan must show taint can be checked at a measured cost, and reuse M9's store and clock rather than build new ones.
