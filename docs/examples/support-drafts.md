# Example spec: support-drafts

Batch 3, example 2. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

A support owner receives customer messages and keeps private notes about each customer. For one customer, the program reads the customer's messages, has an external model summarize them, has an internal model write a draft reply that cites the messages, reads the owner's notes and has the internal model brief the owner, and then proposes the draft. Every draft waits for the owner's signed approval. The point of the example is the **audience**: a customer's messages are class `customer`, the notes are class `owner`, and the external model may be given nothing above `customer`. The seeded defect sends the notes to the external model's decision and leaves nothing to stop it.

No test calls a model or the network. The models are recorded.

## Files

All paths are under `examples/support-drafts/`. The names are fixed.

| File | Content |
|---|---|
| `support-drafts.poly` | module `drafts`, first line `// expected: CLEAN` |
| `support-drafts.policy.poly` | module `drafts_policy`, policy `drafts`, scope `"drafts"` |
| `support-drafts-defect.poly` | the program that also summarizes the notes, first line `// expected: FINDING PL6503 PL7001` |
| `support-drafts-defect.policy.poly` | the defect's policy: the program's policy without the obligation `external-model-audience` |
| `host/handlers.ts` | the certified handler file; exports `createDraft` |
| `host/tsconfig.json` | compiles `host/handlers.ts` for `poly check --host`; run with `--root examples/support-drafts` |
| `host/recorded.mjs` | exports `loadAnswers(file)`, `recordedDrafts(fixture)` and `provideRecorded(rt, recorded)` |
| `recorded/answers.json` | the recorded customers, tickets, notes and answers |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

Tests: `test/ex-support-drafts.test.mjs` (light) and `test/after/ex-support-drafts-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`. This example's check takes about two minutes, so `examples/support-drafts/` joins the serial group of `test/serial-sources.mjs`. For a source, a retrieval, decisions over `Items` and an escalation, read `test/after/ex-concierge-e2e.test.mjs`, `test/ex-concierge-refund.test.mjs` and `test/memory-helpers.mjs` (`pgOrders`, a fake Postgres whose table and column names the test gives to `postgresSource`).

## Sources and audience

`audience { public < customer < owner }`. Two sources of the adapter `"postgres"`, both owned, freshness 720h:

- `tickets`: audience `customer`. The customer's messages to the owner.
- `notes`: audience `owner`. The owner's private notes.

## Machine

One `machine Ticket` in module `drafts`, one run per customer. `Status { Opening, Reading, Drafting, Noting, Briefing, Ready, Proposed, Created, Uncertain, Failed }`. State: `status` (`Opening`), `owner : Principal` (none), `summed : bool`, `written : bool`, `summary`, `draft`, `brief : Content` (none). `terminal status in { Created, Failed }`.

- `Open(who: Principal)`: `"opened"` unless `Opening`. Records `owner`, goes to `Reading`, emits `read(who: who)`.
- `Read(items: Items)`: `"not-reading"` unless `Reading`. Goes to `Drafting`, issues `decide summary(thread: items)` and `decide write(thread: items)`. `ReadFailed()`: same guard, `Failed`.
- `Summed(text)` and `Unsummed()`: `"not-drafting"` unless `Drafting` and not yet summed. Mark `summed` (and record the summary on `Summed`). When `written` too, go to `Noting` and emit `read_notes(who: owner)`.
- `Written(text, cites: Items)`: `"not-drafting"` unless `Drafting` and not yet written. Marks `written`, records the draft; when `summed` too, goes to `Noting` and emits `read_notes`. `Unwritten()`: same guard, `Failed`.
- `Noted(items: Items)`: `"not-noting"` unless `Noting`. Goes to `Briefing`, issues `decide brief(notes: items)`. `NotesFailed()`: same guard, `Ready`.
- `Briefed(text)` and `Unbriefed()`: `"not-briefing"` unless `Briefing`. Go to `Ready` (recording the brief on `Briefed`).
- `Propose()`: `"not-ready"` unless `Ready`. Goes to `Proposed`, emits `createDraft(who: owner, body: draft)`.
- `Made()`: `"not-proposed"` unless `Proposed`; `Created`. `NotMade()`: same guard, back to `Ready`. `MakeUncertain()`: same guard, `Uncertain`.
- `Resolve(found: bool)`: `"not-uncertain"` unless `Uncertain`. `found` goes to `Created`; otherwise `Ready`.

## Retrievals, decisions and the effect

- `effect read(who: Principal)`: `retrieve tickets where owner == who limit 3`; `ok(r)` to `Read(items: r.items)`, `failed` to `ReadFailed`.
- `effect read_notes(who: Principal)`: `retrieve notes where owner == who limit 3`; `Noted` and `NotesFailed`.
- `decision summary(thread: Items) -> Content`: provider `"small"` (the external model), labels `egress:external, read:private`, timeout 5s; `ok(r)` to `Summed(text: r.answer)`, `failed` to `Unsummed`.
- `decision write(thread: Items) -> Content`: provider `"internal"`, same labels, timeout 20s, `cites thread`; `ok(r)` to `Written(text: r.answer, cites: r.cites)`, `failed` to `Unwritten`.
- `decision brief(notes: Items) -> Content`: provider `"internal"`, same labels, timeout 5s; `Briefed` and `Unbriefed`.
- `effect createDraft(who: Principal, body: Content)`: kind `"helpdesk.createDraft"`, labels `egress:external, read:private`, target the exact URL `https://helpdesk.example/v1/drafts`, `to who`, class `irreversible`, retry `attempts 1, base 200ms, timeout 30s`; `ok` to `Made`, `failed` to `NotMade`, `exhausted` to `MakeUncertain`.

## Host handler

`host/handlers.ts` exports `createDraft(payload, caps, ctx)`, with a type-only import from `../.poly/build/drafts.Ticket/types.js`. It reads the draft's text with `caps.content.read(payload.body)` and posts `{ body: <text> }` through `caps.egress.post` to the helpdesk URL with the header `idempotency-key` set to `ctx.idempotencyKey`. Status 200 or 201 returns `{ ok: true }`; a status from 400 to 499 other than 429 throws an error with `permanent: true`; any other status or a transport error throws an error with `ambiguous: true` (the draft may exist), which, with one attempt, is delivered as exhausted.

## Recorded models

`recorded/answers.json` is `{ "models": { "small": "<id>", "internal": "<id>" }, "customers": { "owner-1": ..., "owner-2": ... }, "tickets": [ { "id", "owner", "asOf", "body" } ], "notes": [ { "id", "owner", "asOf", "body" } ], "answers": { "summary": ..., "write": ..., "brief": ... } }`. `recordedDrafts(fixture)` returns `{ asked, decisions: { summary, write, brief } }`, each `{ provider, model }`. A provider answers from the items it is given (`materials.items`): `summary` and `write` from tickets, `brief` from notes; it records `{ decision, items: [ids] }` in `asked`, never a body. `write` cites the ids it was given. A provider given an item it does not know throws. The fixture holds, for `owner-1`, two tickets ("My invoice shows two charges for March.", "Please confirm you have fixed it.") and one note ("Refund is allowed up to 100 for this customer; be brief."), and for `owner-2` one ticket and one note, so a test can show one owner's items are never given to another's run.

## Policy

Policy `drafts`, scope `"drafts"`:

- `owner-approves-drafts`: for `effect.kind == "helpdesk.createDraft"`, `require false else escalate`, `on unknown escalate`;
- `external-model-audience`: for `effect.kind == "decision.summary"` and `!(effect.taint.class in { "public", "customer" })`, `require false else deny`, `on unknown deny`;
- `internal-model-audience`: for `effect.kind in { "decision.write", "decision.brief" }` and `!(effect.taint.class in { "public", "customer", "owner" })`, deny, `on unknown deny`;
- `never notes-to-external-model "Notes never reach the external model.": allow when effect.kind == "decision.summary" && effect.taint.class == "owner"`.

Each obligation is guarded by `proposal.kind == "effect"`. The decision rules also gate the decisions' region (without a rule that names a decision polycheck reports `PL7001`). The policy is signed as a person signs it.

## Properties

The program has no property of its own beyond deadlock freedom; the example's content is the policy and the flow. The program and its policy check `CLEAN`, `Ticket` over 1,705 states.

## Seeded defect

`support-drafts-defect.poly` is the program whose `Noted` also issues `decide summary(thread: items)`: the owner's notes go to the external model. `support-drafts-defect.policy.poly` is the policy without `external-model-audience`. The check rejects the pair with exactly two codes: **`PL7001`** (the region "credential-egress" is reached with no gate crossed at `decision.summary`, a witness of 1 step) and **`PL6503`** (the policy allows a proposal its `never` statement forbids, a witness of 1 step). Beside the program's own policy the same defect program checks `CLEAN`: the gate denies the notes at run time, which the end-to-end test shows, and nothing at check time reads the flow through the machine. That the finding depends on the policy and not on the program is the example's point and its limit; the README says so.

No flag or configuration is needed: the regions and the never statements run in the default check.

## What the tests must show

Light test:

- the program with its policy is `CLEAN`; the instance is printed (1,705 states);
- the defect with its policy beside it is `FINDINGS` with exactly `PL6503` and `PL7001`, each with a witness of 1 step; the defect program beside the program's own policy (a temporary copy) is `CLEAN`;
- the program's policy through poly-ref's decision table (as `test/ex-concierge-policy.test.mjs` does): `decision.summary` with an `owner` taint is denied by `external-model-audience`, with `customer` or `public` allowed, with no taint denied; `decision.write` and `decision.brief` with `owner` taint allowed; `helpdesk.createDraft` is escalated;
- `poly check --host` is `CLEAN`, and a handler with a wrong field is `PL6836`;
- the handler: 201 ok; 422 permanent; 503 ambiguous and not permanent; header and body as above; a missing throw fails the test;
- the recorded models answer from the items they are given, never record a body, and throw on an unknown item.

End-to-end test, over recorded traffic, nothing on the network (`test/after/`, serial):

- main path: `Open` for `owner-1` reads two tickets, the external `summary` is given only ticket items, `write` cites the two tickets, the notes are read and `brief` is given the note; the ticket reaches `Ready`; `Propose` emits `createDraft`, the gate **escalates** it and nothing is posted; the owner's signed approval (`approvalFor`, `rt.approve`) releases it; one POST with the draft's text and a key; `Created`;
- refusal by the gate: the defect program admitted with the program's own policy (the weakened policy is not admitted, `PL7001`): the extra `summary` over the notes is denied `audience`, so the external provider is never asked about a note, and the ticket still reaches `Ready`;
- isolation: `owner-1`'s run never reads `owner-2`'s tickets or notes (the fake database's queries carry the owner);
- uncertainty: a draft answered 503 ends `Uncertain` with one POST, and `Resolve(found: true)` ends `Created`;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

## Amendments made when the code existed

- **The check needs a large heap.** The 1,705 states take 8 s with `--max-old-space-size=8192` and 112 s in the default heap. `examples/support-drafts/` is in the serial group of `test/serial-sources.mjs`, and the commands in the README give the heap (language findings 16).
- **The independent writer's end-to-end file first dispatched the completions (`Read`, `Noted`, ...) by hand**, which the runtime refuses; it was rewritten to dispatch only `Open`, `Propose` and `Resolve`. Its fake database used column names `ticket_id` and `owner` that `pgOrders` does not answer; the implementer changed them to `order_id` and `customer_id`. A provider's `cites` is an array of ids, not an object with a count. The policy's findings are in the report's own `diagnostics`, not a machine's.
- **The handler checks `payload.body`** for none before reading it, since the generated type is `Content | null`.
- **The refusal test asserts the denial.** The gate denies the extra `decision.summary` over the notes (`wrong-state` from `external-model-audience`), once, as well as the provider never being asked about a note.
- **The policy-dependent finding needs no flag.** The regions and the `never` statements run in the default check (language findings 17).

## Conclusion

The audience is held at run time by the gate and proved at check time only through the policy: the check cannot see that the notes reach the summary, and it finds the missing rule. Two lines of policy are all that stand between the notes and an external model, so the example keeps the rule, the `never` that proves it, and the end-to-end test that shows the gate saying no.

## Glossary

- **Audience:** the class of reader a piece of data may reach; `customer` is below `owner`.
- **Taint:** the audience class a decision's inputs carry; a decision's taint is the highest of its inputs'.
- **Escalation:** the gate's decision that a person must approve an intent before it runs.
- **Never statement:** a policy line proved over every proposal the program can make.
