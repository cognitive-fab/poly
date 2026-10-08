# M10 decisions

Rulings on `plan-m10.md`, in the order they are made. Each entry names who ruled. M10 runs as `decisions-m9.md` sets ("how M9 to M11 run"): a ruled plan runs to its end, stopping only for semantics, security, verdict or engine changes.

## plan-m10.md ruled, jointly with plan-m11.md (owner, 2026-10-07)

The plan is accepted. M10 starts when M9 closes, in its own worktree and session, in parallel with M11.

- **S300, the taint domain: accepted as proposed**, `(class, owners)` with owners a subset of the explored principal representatives. The alternative (a count of owners) cannot prove AC22 and is refused. Step 1 measures the cost on the concierge. If the taint space does not fit the checker's bounds, M10 stops and brings the numbers; it is not reduced silently.
- **S301, the flow rule as a step property: accepted.**
- **S302, enforcement at run time: accepted, fail closed.** The runtime's `audience` refusal is final, content with no taint record is refused, and E10 is settled by test.
- **S303, `Items` and retrieval: accepted**, with `PL6833` to `PL6835`.
- **S304, citations: accepted.**
- **S305, the recipient's class: accepted.** A recipient with no claimed class and no channel default is `public`, the most restricted reader, so it fails closed.
- **S306, forgetting: accepted.** The subject may be a principal or a whole source (for example one mail account), so the inbox assistant's `poly forget --account` is the same mechanism.
- **S307, freshness: accepted.**
- **S308, source adapters: accepted as proposed** (Postgres through a host-supplied query function, OpenSearch over recorded traffic). The Gmail and SES sources of the inbox assistant are not M10 scope: they are built with that example, on the same pattern.
- **S309, remembering, and S310, what a record may hold: accepted.**
- **Q3: a total order of audiences for v1: accepted.**
- **Shared changes with M11 (section 6): accepted.** Each milestone adds its own clause, reserved reason and proposal field in its own function or file; the decision completion path keeps one ordered list of checks that each appends to; where both touch the same lines, M10 merges first and M11 rebases.

## Step 0: generated host types and edit-and-check, before the memory plan (owner, 2026-10-07)

Q9 (decisions-m9.md) placed generated host types (PT28.1) and `poly_edit_check` (PT28.4) at the start of M10, and `plan-m10.md` did not list them. Asked, the owner ruled: build both as M10 step 0, then go on with the memory plan. New codes come from PL6833 to PL6839 and spec issues from S300 to S349; `poly_edit_check` never admits, signs or runs anything (PT28.4d).

Spec issues S300 to S310 are the plan's, so step 0's are numbered from S311. Each is decided by the plan's rules and recorded with its reason:

- **S311, the declarations' form.** PT28.1 does not fix how a type is written. A small integer range is the union of its literals, so a host that passes 7 to a `0..5` parameter fails to compile, and a widened parameter is visible to the read-back; above 64 values it is `number`, to keep the file readable. The state is the flat form of PS9.1b, since that is what `rt.dispatch` and `rt.getState` return. poly-ref writes the file it expects from its own model and compares the two, which is the standing rule's read-back for a text artefact.
- **S312, the host check.** PT28.1d leaves its code to the ruling: it is `PL6836 HOST_TYPE_ERROR`, a finding. PL6833 to PL6835 stay with S303, as planned. The compiler is the `typescript` package, the one npm package outside poly the boundary already allows, loaded in process, since a check package may not start a subprocess. A host check that cannot run is listed as not run and the verdict is at best `INCONCLUSIVE` (no silent clean).
- **S313, edit-and-check.** PT28.4a's "optional configuration" is read as the project whose `poly.json` names the program the module is checked with. PT28.4c says a "refused or failing" edit leaves the project unchanged: an edit is written only when its verdict is not `REFUSED`, `ERROR` or `NONDETERMINISM`, so an agent can keep an edit that leaves a finding to fix next, and never one that does not check.

The PT text is PT10h, written first.

### Step 0, built

- **Host types.** `packages/poly-lower/src/host-types.ts` writes `types.d.ts` for every machine; poly-ref's `hostDeclarations` writes the declarations it expects from its own model, and translation validation compares them line for line, with the first line's digest against the contract's `machineVersion`. `types.d.ts` is in `CERTIFIED_ARTEFACTS`. The broken lowering `types-widen-param` is in the explicit list, caught on the router of `conformance/m4`.
- **Typed dispatch.** `rt.dispatch<Action>(id, action, data)` takes its arguments as one tuple per action of `Action`, so the data must be the named action's; with no type argument it is untyped as before, and every existing call compiles unchanged.
- **The host check.** `poly check --host <tsconfig>` (`packages/poly-check/src/host.ts`) compiles host code in process with the `typescript` package; each error is `PL6836 HOST_TYPE_ERROR` at its file, line and column. One that cannot run is listed as not run, and the verdict is `INCONCLUSIVE`.
- **Edit and check.** `edit-check` (`poly_edit_check` over MCP, and through the language server) checks the edited text in memory with `checkFile`'s `text` option, writes its build and its full report under `.poly/edit-check/`, and writes the module only with `apply` and a verdict that is not `REFUSED`, `ERROR` or `NONDETERMINISM`. It calls the check alone.
- **Tests first.** `test/host-types.test.mjs`, eight tests, failed before the code (no `types.d.ts`, no `host` option, no `edit-check`); they pass. One test first passed a wrong datum: a single generic with a defaulted action parameter let `{ text: 7 }` match another action's empty data, so the dispatch takes one argument tuple per action instead.
- **The environment.** This worktree had no `poly` command under `node_modules/.bin`, which the install test launches; the three shims were copied from the main checkout's. They are not in the repository.
- **Checked.** The 159 measured files are identical to the measurement at the M9 close (e62b7a5). The full suite: 1,939 tests, 1,931 pass, 2 failed, 2 skipped and 4 waiting; check-memory passed (`.poly/logs/5ef9666-2026-10-08T00-48-27-776Z-step0.log`). Both failures were the missing `poly` command above; after the shims both files pass (13 tests), and the after run passes (1 test).

## Step 1 waits for step 4, by the plan's rules

Step 1 measures taint's cost on the concierge with a `retrieve` added, and the concierge cannot have one until `retrieve` exists (step 3) and poly-ref carries taints (step 4). So the measurement is taken when step 4 is built, on the concierge of `test/fixtures/m10/concierge-memory.poly`, and recorded there; if the taint space does not fit the checker's bounds, M10 stops there with the numbers, as ruled on S300. The PS text (step 2) comes first, as the plan orders.

## Step 2: PS17 written into the semantics before the code

PS1.4b (audiences and `Items`), PS15.0a (a channel's recipients), PS17 (memory), PS11.3a (forgotten steps) and `uncited` among PS3.2's reserved reasons. Section 6 of the plan lists these changes, ruled with M11's plan. The text settles six points the plan left open, each by the plan's rules and recorded here for the owner's reading:

- **S314, the recipient's principal.** S301 names "the recipient's class and principal at the send" and S305 gives the class, not the principal. An effect names its recipient with `to p`, a `Principal` parameter, as `uses c … for p` names a credential's holder (PT10e). A channel's recipient has no principal a module names, so an owned item reaches a channel only by class (PS15.0a); a channel thread's principal is a question for the concierge example of the v1 gate, not for M10. An effect may also declare `audience c`, its recipients' default class, beside a channel's (S305).
- **S315, pending taints.** The taint of a completion's data must come from the intent it completes, or a correct concierge would be reported leaking (a completion offered with any taint) or a stale completion would carry an earlier customer's taint. Each instance keeps, as ghost state, the multiset of the taints of its retrievals' and decisions' intents not yet completed, and a completion takes one. A machine that would hold more than 3 of one kind is a bound hit, never `CLEAN`.
- **S316, `Items` is passed, not stored.** A module reads `x.count` and passes an `Items` to a decision or an effect; it is no field, record field, payload or map value. This keeps the state's shape and every existing count, and nothing in AC22 to AC24 needs one stored.
- **S317, one more principal representative** when a program declares an owned source, with the lemma in PS17.4: the owner a violation names keeps a representative of its own, distinct from the recipient's.
- **S318, a decision's answer may be a `Content`**, as PT23.1's `r.text` needs; until now PL0901 refused a decision over a `Content`, a limit of M8a that M10 lifts.
- **S319, taint per value in the check, per body at run time.** The checker carries a taint with each occurrence of a value; the runtime keeps a body's taint in the content store by digest, joined over every time it was stored. The runtime's taint is never less than the check's, so it refuses every send the flow rule refuses and may refuse more (fail closed): two customers whose messages happen to have the same bytes share a body. The flow rule is explored apart from the machine's own graph, so the ghost changes no verdict and no state count of any file.

## Conclusion

M10 is ruled. Its one measured risk, the taint state space, is measured first and brought to the owner if it does not fit.
