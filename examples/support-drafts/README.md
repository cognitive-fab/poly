# Support drafts

A support owner receives customer messages and keeps private notes about each customer. For one customer, the program reads the customer's messages, has an external model summarize them, has an internal model write a draft reply that cites them, reads the owner's notes and has the internal model brief the owner, and then proposes the draft. Every draft waits for the owner's signed approval. Everything here runs on recorded models and a fake database: no model is called and nothing leaves the machine. The spec is `docs/examples/support-drafts.md`.

## What it shows

- **Taint by audience.** `audience { public < customer < owner }`. A customer's messages are class `customer`, the notes are class `owner`, and a decision's taint is the highest class among its inputs.
- **A decision denied when its inputs are above the audience.** The external model (`summary`) may be given nothing above `customer`; the internal model (`write`, `brief`) nothing above `owner`. The policy denies a summary whose taint is higher, and a `never` statement proves it over every proposal the program can make.
- **Drafts escalated to the owner.** `helpdesk.createDraft` is escalated by the policy; nothing is posted until the owner's signed approval, and then one request is sent, with the intent's idempotency key. An answer that is not a definite refusal leaves the ticket `Uncertain`, and the owner resolves it.
- **Cited drafts.** `write` cites the tickets it was given; an answer that cites nothing is refused.
- **A seeded defect.** `support-drafts-defect.poly` also gives the notes to the external model's `summary`, and `support-drafts-defect.policy.poly` has no `external-model-audience` rule to stop it.

## Run it

From the repository root, after `npm ci` and `npm run build`.

```sh
node packages/poly-check/dist/src/cli.js check examples/support-drafts/support-drafts.poly
node packages/poly-check/dist/src/cli.js check examples/support-drafts/support-drafts-defect.poly
node packages/poly-check/dist/src/cli.js check examples/support-drafts/support-drafts.poly --root examples/support-drafts --host examples/support-drafts/host/tsconfig.json
node --test test/ex-support-drafts.test.mjs
node --test test/after/ex-support-drafts-e2e.test.mjs
```

The first two check each program alone, with no policy, so they report what a program alone shows; the tests check each program with its policy beside it, as a project.

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Ticket` over 1,705 states; about 10 s in the default heap |
| Policy | all seven stages `CLEAN`, including the regions and the `never` |
| Defect copy with its own (weakened) policy | `FINDINGS`, exactly two codes, each with a witness of 1 step: `PL7001` (the credential-egress region is reached at `decision.summary` with no gate crossed) and `PL6503` (the policy allows a proposal its `never` forbids) |
| Defect program with the program's policy | `CLEAN`: the check does not read the flow from the notes to the summary, and the gate denies it at run time |
| Decision table | `decision.summary` with an `owner` taint is denied by `external-model-audience`, allowed with `customer` or `public`, denied with none; `decision.write` and `decision.brief` are allowed up to `owner`; `helpdesk.createDraft` is escalated |
| Host handler | compiles under `poly check --host`; a wrong generated type is `PL6836` |
| End to end | 6 tests: the main path with the escalation and the owner's approval, the defect program refused by the gate (`external-model-audience` denies the summary of the notes, and the provider is never asked about a note), two owners kept apart, an uncertain draft resolved, and a journal that replays (7 runs, 41 rows, 1 gate session, no divergence) |

## What is not checked

- **The flow through the machine.** The finding depends on the policy and not on the program: beside its own policy the defect program checks `CLEAN`. A policy sees a decision's kind and taint, never its provider, so changing which provider a decision uses is invisible to both. The gate at run time is what holds the line, and the end-to-end test shows it. (Language findings 17.)
- **Domains.** Three items per retrieval, one owner per run, two content representatives. Nothing else was reduced; `CLEAN` is a statement about 1,705 states.
- **Which models.** The recorded answers stand in for the external and the internal model; their confidences are the fixture's, with no calibration.
- **The owner.** That the person who approves is the owner is the keyring's, not the program's.

## Conclusion

The audience is held at run time by the gate and proved at check time only through the policy: the check cannot see that the notes reach the summary, and it finds the missing rule. Two lines of policy are all that stand between the notes and an external model, so the example keeps the rule, the `never` that proves it, and the end-to-end test that shows the gate saying no.

## Glossary

- **Audience:** the class of reader a piece of data may reach; `customer` is below `owner`.
- **Taint:** the audience class a decision's inputs carry; a decision's taint is the highest of its inputs'.
- **Escalation:** the gate's decision that a person must approve an intent before it runs.
- **Never statement:** a policy line proved over every proposal the program can make.
- **Region:** a set of effects behind a gate; `PL7001` reports one reached with no gate crossed.
- **Recorded models:** answers written down in advance, so a run needs no provider.
