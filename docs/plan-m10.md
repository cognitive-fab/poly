# poly · Plan for milestone M10, memory

*Cognitive Fab · October 2026 · plan, written before any M10 code, while M9 is built · on branch `m4` in the worktree `poly-m4` · from PT27.3's M10 row and PT23 of `proposals/v1-technical-spec.md` (v0.2), PF13 and AC22 to AC24 of `proposals/v1-functional-spec.md`, and the brief `handoff-m10.md` · spec issues S300 to S349, new codes PL6833 to PL6839 (`decisions-m9.md`, how M9 to M11 run)*

This plan covers milestone M10 of the v1 proposal: governed memory and retrieval. Its scope, as PT27.3 sets it:

- `audience`, `source`, `retrieve` and the `Items` type;
- taint as a ghost component, checked by poly-ref;
- citations (`cites`, the reserved reason `uncited`);
- `remember`, `poly memory verify` and `poly forget`;
- source adapters for Postgres and a document index.

The gate is AC22 to AC24, with the flow rule's seeded control giving `PL6831 AUDIENCE_LEAK` with the shortest witness. M10 is built after M9 closes, in its own worktree and session, in parallel with M11. Section 6 lists every change it makes to `04-semantics.md` and to shared packages, so that it can be ruled together with M11's plan.

Nothing is built before the plan is ruled.

## 1. What was read, and what was found before planning

**Documents read:** `handoff-m10.md`; PF13 and AC22 to AC24; PT20.1 (`Content` and taint), PT20.3 (intervals), PT23, PT25.1 (the field `taint`), PT27; `plan-m9.md` and its ruling (S196 the clock, S199 the runtime's own checks, S205 the erasable store); PS1.4a (`Content`), PS4.1c (principal representatives), PS5.4 (path properties) and PS15 (channels).

| Finding | Where | Consequence |
|---|---|---|
| `Content` is explored by representatives `c1 … cn` and `none` (PS4.1f); nothing tracks where a value came from. | poly-ref, `Content` | Taint is a new ghost component beside each `Content` value in the state; its domain decides the state space (S300). |
| A path property reads the emitted intents but not the state (PS5.4); a step property reads both (PS5.2). | PS5 | The flow rule reads the taint of a send's payload and the recipient's class at the send: a step property over the ghost state is enough, and needs no new property kind (S301). |
| The gate already receives `effect.channel.recipient` as a keyed digest (S185) and `recipientClass: external` for every channel recipient (S181). | `channelOf`, PT25.1 | The recipient's class has a home in the proposal. M10 gives it a value from claims or a channel's declared default (S305). |
| M9 makes the content store erasable (S205) and computes ages by the runtime's clock, recorded in the verdict (S196). | `plan-m9.md` | Forgetting reuses the erasable store; freshness reuses the ages (S306, S307). |
| poly-runtime checks the grant and the mandate itself before the policy, and passes the result as a field (S199, E11 not needed). | `decisions-m9.md` | Taint can be enforced the same way, so per-value taint in Polyaxion (E10) is not needed (S302). |
| No model SDK and no database driver may enter poly: the boundary refuses npm packages outside poly-io, and poly-io imports node builtins only. | `scripts/check-boundaries.mjs` | A Postgres source adapter cannot import `pg`. It takes a query function the host supplies at load, as the KMS store takes the owner's wrap function (S308). |

Nothing was measured while planning. The taint domain's cost is measured before S300 is ruled (step 1).

## 2. Engine changes

- **E10 (polyaxion, per-value taint): proposed not needed** (S302). poly-runtime computes the taint check before the policy and passes the field `taint`; settled by test as E10 was for `channel`, fail closed.
- No other engine change. One found while building gets the next free id after M9's, recorded the same day.

## 3. Packages and what changes in each

| Package | Change |
|---|---|
| `poly-lang`, `poly-embed` | `audience { … }`, `source s: kind { adapter, audience, owned, freshness }`, `retrieve s where owner == p limit n`, `cites x` in a decision, `remember memory as <class> about p` in an effect; both surfaces. |
| `poly-core` | The `Audience` enum from `audience`; `Items` as a record type; `PL6831`, `PL6832`, and new codes from `PL6833`; `uncited` among PL1207's reserved reasons. |
| `poly-lower` | Each source's descriptor `sources/<name>.json`, and the flow descriptor `flow.json` (the audience order, each source's class and ownership, each outbound effect's recipient-class source), each with its read-back and broken variants. |
| `poly-ref` | Taint as a ghost component on every `Content` value (S300), the flow rule as a step property over it (S301), the citation check, ages of items by intervals; written from the semantics, sharing no code with the compiler. |
| `poly-runtime` | Taint in the content store's metadata; the flow check before the policy and the field `taint` (S302); citations checked at completion; `remember` into the memory source; `poly forget` over the erasable store; `forgotten` steps in replay. |
| `poly-io` | Source adapters, certified by package and digest: Postgres over a host-supplied query function, and a document index (S308). |
| `poly-check` | Admission binds the source adapters and the flow descriptor; `poly memory verify` and `poly forget`, never over MCP. |
| `std/` | `std.memory`, with the `Remember` machine and its `PROVENANCE.md`. |

## 4. Order of work

Each step ends with the full suite and a commit; every defect gets a test that fails first; the 147 measured files are compared at every step.

1. **Measure taint's cost before the ruling of S300.** Behind a switch that is off: the ghost component on the concierge with a `retrieve` added, its state counts with the switch on and off, brought to the owner with S300.
2. **PS text.** The semantics changes of section 6, written into `04-semantics.md` before any code.
3. **`audience`, `source`, `retrieve`, `Items`** on both surfaces, with `PL6833` to `PL6835`, the descriptors, their read-backs and broken variants.
4. **Taint in poly-ref and the flow rule** (S300, S301); AC22's static half with its seeded control.
5. **Citations** (S304); AC23's first half.
6. **Freshness of items** (S307); AC23's second half.
7. **Source adapters** in poly-io against recorded traffic (S308).
8. **Runtime enforcement**: taint in the content store, the flow check before the policy, the field `taint` (S302); AC22's run-time half.
9. **`remember` and `poly memory verify`** (S309).
10. **`poly forget`** over M9's erasable store, and replay's `forgotten` (S306); AC24.
11. **The M10 record, the review, and the gate** from a clean build on a quiet machine, compared file by file with M9's.

## 5. How each gate item is tested

| Gate item | Test | Fails first because |
|---|---|---|
| AC22 | `test/memory-flow.test.mjs`. The concierge variant with `where owner == customer` removed gets `PL6831` with the shortest witness; the concierge as written is CLEAN. At run time, the same variant's reply to customer B is denied `audience` before the adapter is reached. | No taint, no flow rule. |
| AC23 | `test/memory-cites.test.mjs`. A recorded answer citing an item it was not given is rejected `uncited`, and the decision's `failed` path runs. An item older than its source's `freshness` escalates (or is denied) as the project declares. | No citations, no item ages. |
| AC24 | `test/memory-forget.test.mjs`. After `poly forget`, no body about the subject remains in the content store or the source index, `poly journal verify` passes, and replay reports `forgotten` for each affected step and no divergence. | No forgetting. |
| Read-backs | `test/tv.test.mjs` and `test/toolchain-faults.mjs`: the source and flow descriptors' broken variants (a class lowered, an owned source made unowned, a recipient-class source dropped). | No descriptors. |
| The canary | The standing canary scan of M9 extended with an item body and a query value: neither appears in any record or output. | Not scanned. |

No test reaches a live database or index: every adapter test replays recorded results from documented formats.

## 6. Changes to `04-semantics.md` and shared packages, to rule with M11's plan

- **`04-semantics.md`:** the audience order and `Items` (PS1); taint as a ghost component and its join (a new PS section); the flow rule (PS5, as a step property over taint); `uncited` in PS3.2's reserved reasons (beside `content-missing`); a channel's declared recipient class (PS15, S305); `forgotten` in replay (PS11).
- **`poly-core`:** grammar and checks of section 3; the reserved reason `uncited` in PL1207's list.
- **`poly-ref`:** the ghost component and the flow rule (new files), and the decision completion's `uncited` row.
- **`poly-runtime`:** the content store's metadata (taint, owner), the proposal field `taint`, the decision completion's citation check, replay's `forgotten`.
- **Shared with M11:** the decision clause grammar (M10 adds `cites`, M11 adds `route`), PL1207's reserved reasons (`uncited` here, `route-exhausted` in M11), the decision completion path in poly-runtime, and PT25.1's proposal fields (`taint` here, `route` and `budget` in M11). Proposal: each milestone adds its own clause, reason and field in its own function or file, the decision completion path gains one ordered list of completion checks to which each appends, and M10 merges first if both touch the same lines.

## 7. Spec issues

Numbered S300 to S349. Each has a proposal and waits for the owner's ruling.

- **S300. The taint domain.**
  - *Proposal:* taint is `(class, owners)` with `class` in the declared `Audience` and `owners` a subset of the principal representatives `p1 … pn` already explored (PS4.1c), held beside each `Content` field and message payload. Its join takes the highest class and the union of owners, and it never decreases on a path. The state space grows by at most `|Audience| × 2^n` per `Content` position, bounded by `n`; the measured cost on the concierge (step 1) comes with this issue to the ruling.
  - *Alternative:* owners as a count (0, 1, many) in place of a set. Smaller, and too coarse to tell customer A's items from customer B's, so AC22 could not be proved.
- **S301. The flow rule as a step property.** PT23.3c's three cases, over the taint of the send's payload and the recipient's class and principal at the send, checked in each configuration that includes the sender. A violation is `PL6831` with the shortest witness.
- **S302. Enforcement at run time (E10).** poly-runtime reads the content's taint from the store's metadata and the recipient's class and principal, applies PT23.3c before the policy, and denies `audience` itself; a refusal is final whatever the policy says (as S199). The proposal carries `taint: { class, owners: [principalDigest] }` so policies may add rules. Content with no taint record is refused, fail closed. E10 is settled by test.
- **S303. `Items` and retrieval.** `Items` has `count: 0..n` (`limit n`), `class`, `owners` and `age`, and an opaque reference. `owner == p` is the only predicate the checker reads; other predicates go to the adapter as typed data, and their values are typed parameters of the effect, never free text. New codes: `PL6833 AUDIENCE_UNDECLARED` (a source, channel or `remember` names a class `audience` does not declare), `PL6834 SOURCE_ADAPTER_UNKNOWN` (a source names an adapter poly-io does not make), `PL6835 OWNER_ON_UNOWNED` (`where owner == p` on a source that is not `owned`).
- **S304. Citations.** `cites x` adds `cites: Items` to the answer type; the runtime checks at completion that the cited references are a subset of `x`'s, and rejects otherwise with `uncited`, a reserved reason (PL1207).
- **S305. The recipient's class.** From the step's claims when they carry one; otherwise from the channel's declared default, a new clause `audience c` in a channel (PS15). A channel with no default and no claimed class gives the lowest class, `public`.
- **S306. Forgetting is M9's erasable store** (S205): `poly forget <subject> --by <person>` is signed (a new record kind, `forget`), erases every body whose owner is the subject, calls each source adapter's `forget`, and writes a `forget` ledger event with the subject's digest and the erased digests. Replay reports `forgotten`. Q4: derived items whose taint names the subject among its owners are erased too.
- **S307. Freshness of items** reuses M9's ages (S196): the runtime's clock at the decision, the age recorded in the verdict, intervals cut by the thresholds; a source's `freshness` with `stale escalate` (the default) or `stale deny`.
- **S308. Source adapters.**
  - *Proposal:* both in poly-io, certified like the channel and vault adapters. **Postgres** takes a `query(text, params)` function the host supplies at load, so no driver enters poly; the adapter builds parameterized queries only. **The document index** is an HTTP search API over recorded traffic: the OpenSearch `_search` API, read from its documentation. Each is tested against recorded results, with owners and classes seeded across two customers (K14).
  - *Alternative:* a local file index in place of OpenSearch. Simpler to test, and no deployed index uses it.
- **S309. Remembering.** `remember` writes to the project's `memory` source, a table of the runtime's store holding each item's content digest, origin step, provenance (`observed`, `derived`, `verified`), subject and taint; `PL6832` for a write below its content's taint. `poly memory verify` is a signed record (a new kind, `verify`), never over MCP.
- **S310. What a record may hold.** No item body, query value or credential enters the journal, the ledger or a certificate: an item is a `Content` digest, a query's values are typed parameters checked like any payload, and the canary scan covers bodies and query values.
- **Q3 (v1 spec).** A total order of audiences for v1, as PT23.1a has it; a partial order waits.

## 8. Risks

1. **Taint's state space.** A set of owners per `Content` position can multiply the state space. Step 1 measures it before the ruling; if it does not fit, the owner gets the numbers and the alternative.
2. **Merge with M11.** Both touch the decision clause, the reserved reasons, the completion path and the proposal fields; section 6 lists each, to be ruled with M11's plan.
3. **Recorded traffic only.** A source whose behaviour differs from its documentation is not caught by the tests; K14 states the assumption.

## Conclusion

M10 checks that what an agent retrieves reaches only those allowed to see it: taint is a ghost value the checker follows on every path and the runtime enforces on every send, measured before it is ruled. It reuses M9's erasable store for forgetting and M9's clock for freshness, keeps every item body out of the records, and lists each shared change for a joint ruling with M11.

## Glossary

- **Audience:** a declared, totally ordered class of recipients.
- **Taint:** the audience class and owner set a `Content` value carries, from the items it was derived from.
- **Ghost component:** a value the checker and the runtime track beside the state, which no handler can write.
- **Flow rule:** a send of tainted content is allowed only to a recipient whose class is high enough, or who is its only owner.
- **`Items`:** the typed summary of a retrieval: count, class, owners and age, with an opaque reference.
- **Forgetting:** erasing every body about a subject, keeping only digests, so chains still verify.
