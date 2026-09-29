# Polygraph run: hatchet-dev/hatchet workflow-run status derivation

**Target:** `DeriveWorkflowRunStatus` in `internal/statusutils/status.go`
(local clone `C:\Users\jjdub\code\osssm\hatchet`). This is the function that
rolls N individual task statuses up into one overall workflow-run status —
the piece a caller (API, dashboard, SDK) actually trusts to know whether a
workflow succeeded, failed, or is still going. Chosen per the "new +
complex" criterion: hatchet is a much younger, smaller-team project than
Temporal/Airflow, with an actively-evolving status model.
**Scope:** the pure derivation function only — 3 fixed task slots, one
action (`SetTaskStatus(index, status)`), no DB/queue/worker involved (the
function itself has no I/O).

## What was built

- `contract.json` — 2-key state (`derived`, `taskStatuses`), 1 action with a
  full 18-value data domain (3 slots × 6 statuses).
- `traces/` — **19 real windows**, 5 scenario files, captured by calling the
  real `DeriveWorkflowRunStatus` directly (`internal/statusutils/trace_capture_test.go`)
  — pure, synchronous, deterministic, no timing concerns at all.
- `specs/reference.js` + `invariants.mjs` — hand-written positive control.
- `specs_broken/reference.js` — negative control (FAILED-dominance disabled).

## A real bug caught in my own invariant, not the code

First control pass found 1 reachable invariant violation:
`derived-is-a-known-status` fired on `init → EVICTED,EVICTED,EVICTED`. My
invariant's allowed list was `[QUEUED, RUNNING, FAILED, CANCELLED,
COMPLETED]` — missing `EVICTED`. The real code is correct here: when every
task is uniformly `EVICTED`, the `len(uniqueStatuses)==1` pass-through
legitimately returns `EVICTED` as the raw derived status. Fixed the
invariant, not the code.

**Worth carrying forward though:** the ONE current caller
(`internal/services/admin/v1/server.go:552`) immediately calls
`.ToProto()` on the result, which explicitly maps `EVICTED → RUNNING`
(status.go:60-62) — so today this is externally invisible. But it means the
raw `V1RunStatus` returned by `DeriveWorkflowRunStatus` has 6 possible
values while callers likely assume 5 (the "obviously terminal-or-not" set) —
a latent trap for any *future* caller that reads the raw value without
routing it through `ToProto()` first (e.g. writing straight to a DB column,
or an `== V1RunStatusCompleted`-style check). Not a live bug; worth a code
comment on the function.

## Controls (Step 3)

| run | consistent | invariant violations |
|---|---|---|
| positive control (hand spec, after invariant fix) | **19/19** | 0 — exhaustive: 216 states explored = the FULL 6^3 state space, no cap hit |
| negative control (FAILED-dominance disabled) | 18/19 | **1, all-specs** — `init → SetTaskStatus(FAILED)` |

Both replay and the model-checker independently caught the negative
control — `derived` is a fully reachable, mutable state key here (unlike
raft's `startIndex`), so Part 2 has full visibility into this contract's
safety property.

## Step 4 — real generate+replay (opus-4.8, n=5)

**0/19 consistent — every window, every spec.** But before reading that as
"xstate found nothing / hatchet is broken," look at what actually happened:
every one of the 5 independently generated specs computed the **exact
correct** `next.taskStatuses` / `next.derived` values — the fail-dominance
rule, the in-flight-beats-cancelled rule, EVICTED-as-in-flight, even the
uniform-EVICTED pass-through — matching my hand reference line for line in
places, down to reusing the same special-rule names from the contract. Then
**all 5**, independently, appended one extra line:

```js
next.taskStatuses = taskStatuses;
next.derived = derived;
reject(reason);        // <-- this line, in all 5 generations
```

`reject(reason)` in the SAM v2 strict profile means "this proposal is a
no-op, and here's why" — it **discards** everything just written to `next`.
Every generation seems to have read the contract's `specialRules` (each
carrying a human-readable `note` naming *why* a given branch fires) and
concluded that `reject(reason)` was the SAM v2 idiom for "tag this
**successful** transition with an explanatory reason" — a reasonable-sounding
but wrong inference, since the profile has no such "accept with a reason"
primitive, only "reject with a reason." The result: 5/5 specs computed the
right answer and then threw it away on every single call.

**Isolated and proven the same way as the xstate case:** patched *only*
that one `reject(reason);` line out of one generated spec, changed nothing
else — **19/19, 0 invariant violations.**

## Bottom line

- **No defect found in hatchet's `DeriveWorkflowRunStatus`.** Every rule
  (fail-dominance, in-flight-beats-cancelled-and-completed,
  evicted-counts-as-in-flight, all-same pass-through including the EVICTED
  edge case) held exactly as the source implements it, confirmed by an
  exhaustive 216-state model-check and by 5 independent LLM readings that,
  underneath one shared framework misunderstanding, all derived the
  identical correct logic.
- **The one real, actionable finding is about the real code, not a defect**:
  `DeriveWorkflowRunStatus`'s raw return value can be `EVICTED`, which is
  currently laundered to `RUNNING` only because the single existing caller
  happens to call `.ToProto()` right after. Worth a doc comment noting the
  6-value domain so a future caller doesn't get surprised.
- **The generation finding is the strongest "fix polygraph" data point of
  the three targets so far**: this wasn't a partial split (4-of-5, like
  xstate) — it was a clean 5-of-5, and the trigger is structural, not
  incidental. Any contract whose `specialRules` name *every* branch of a
  total function (not just its no-op cases) invites a model to treat
  `reject(reason)` as a general-purpose "explain this branch" call instead
  of "this was declined." Two candidate fixes: (a) the generation prompt
  should say explicitly that `reject()` MUST be the terminal action of that
  branch and MUST NOT be preceded by `next.*` writes, or (b) the SAM v2
  profile could detect this pattern at load time (a `next.*` write followed
  by a `reject()` call in the same execution path is never legitimate) and
  fail loudly instead of silently discarding real work.

## Files

```
polygraph-hatchet/
  contract.json / invariants.mjs
  specs/reference.js              hand-written positive control
  specs_broken/reference.js       negative control (FAILED-dominance disabled)
  specs_patched/spec_0.js         spec_0 with ONLY the trailing reject() removed (19/19 proof)
  traces/                         19 real windows, 5 files
  out_control/findings.md         control replay + invariant check
  out_negcontrol/findings.md      negative-control replay + invariant check
  out_generated/findings.md       real opus-4.8 5-spec generate+replay+check
  out_generated/specs/*.js        the 5 independently generated specs
  out_patched_check/findings.md   proof run: 19/19 after the 1-line patch
hatchet/internal/statusutils/trace_capture_test.go   the instrumentation (local-clone-only)
```
