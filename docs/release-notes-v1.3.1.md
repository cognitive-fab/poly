# poly v1.3.1: the refund demo after the peer reviews

v1.3.1 changes the program of the demo. A review of the v1.3 pages asked whether an agent's re-planning can create a second refund for the same order. It can, and the concierge of v1.3.0 did. This release fixes it, says what the fix covers and what it does not, and adds what the review asked for: a lint and a mutation for Act 1, a sixth attack for Act 2, and state diagrams of the checked machines. `v1.3.0` is not moved.

## The finding

The refund is keyed. The key is the intent id (`sha(instance, seq, kind, ordinal)`), so every retry of one intent carries one key, and the check proves that (`PL4003`, `PL4004`, K17). But the key says nothing about the order, and a second request is a second intent with a second key. In v1.3.0 the Desk was `Idle` after a refund, with no memory of it, and formed the new intent. The same happened after an ambiguous end: the refund effect declared no `exhausted` completion, so every attempt lost was delivered as `failed`, the guest was told `Declined`, and the guest asked again. PS23.3 and PT33.11 (S527) say that the rule does not see this. The concierge did not guard against it, and no property said it should.

The room reproduces it with no fault. On the demo copy of the tag `v1.3.0`, two requests for 40 from a guest whose order was paid 120.00 leave two refund objects at the Stripe mock-up and 80.00 refunded, and the guest is told `on its way` twice. The same for the chairs of the recorded guest. The script and the output are `docs/demo/ledger/` (`repro-v1.3.0.mjs`, `repro-v1.3.0.out.txt`). The handler's only bound was the charge, so a second refund is accepted while the two together stay within it (40 and 40 on 120.00).

## The fix (DF19, DF20)

**A refund ledger in the Desk, per Desk.** `Ledger { None, Unknown, Issued }` and the state field `refund`. `Amounted` emits the refund only when the ledger is `None`, and sets it to `Unknown` in the same step. `Refunded` makes it `Issued`. `RefundFailed`, a definite refusal (a permanent error of the handler, a gate denial, an escalation that nobody approved), clears it and the guest is told `Declined`. The new completion `exhausted -> RefundUnknown()` is an ambiguous end: the guest is told that the refund is being checked (`Checking`), never `Declined`, and the ledger stays `Unknown`. A request on a thread whose ledger is not `None` emits nothing and the guest hears `Checking` or `Already`.

**The ledger is per Desk, that is per customer thread, and not per order.** `Items` is opaque (PS1.4b): a Desk cannot store, compare or read the identity of the order it cites. So a thread with a refund issued or unknown refuses a refund for any order, until a person resolves it. A guest with two orders cannot refund the second in the same thread. Per-order identity needs a readable key of a cited item, a conceptual data layer: it is a v2.0 proposal.

**The path property.** `never no-reissue: emit refund while refund != None`. It is not vacuous, because the guard is in `Amounted`, which the Desk reaches with the ledger not `None`; a guard in `Classified` would have left the property with no state to speak of, and the check says so (`vacuous:`, verdict `INCONCLUSIVE`). On v1.3.0 with a ghost field the check answers `PL3002` with a witness of 10 steps: `Got`, `Classified(Refund)`, `Found`, `Amounted` (the first `payments.refund`), `Refunded()`, `Answered` (the Desk is `Idle` again), then `Got`, `Classified(Refund)`, `Found`, `Amounted` and a second `payments.refund` (`docs/demo/ledger/v1.3.0-witness.check.txt`). A variant of the fixed Desk that keeps the ledger and does not consult it gives the same path.

**What that witness is.** It is a witness of the checker's model, in which a retrieval can give none (`Found({count:0})`) and the amount can cite one (`Amounted(..., {count:1})`). PS17.6 refuses that pair at run time, and the witness of v1.3.0 has it too. So the witness shows that the text of the Desk allows the path. The imprecision is proposal 14 of `docs/proposals/v2.0.md`. The evidence that two requests really refund twice, and that the fix stops it, is the room: on v1.3.0 two refunds, on v1.3.1 one refund and the reply `Already`, with the stand-in seeing no request (`test/after/demo-ledger-e2e.test.mjs`).

**A 409 is retried.** The handler read every 4xx but 429 as a permanent refusal. A 409 on a keyed request can mean that the first request with that key is still executing, so a permanent error would have cleared the ledger and opened a second intent while the first runs. 409 and 429 are plain errors now, retried with the same key (DF20).

## Resolve, and rehearsing it (DF21, DF22)

`Resolve(done) by op: Operator` moves `Unknown` to `Issued` (`done`) or to `None`. It sends no reply. No message from WhatsApp or Slack can dispatch it: only the host can, with a person's signed invocation record (S107), verified by the person-key adapter and reduced to the claims `Operator`, which has the principal alone. The checks of kind, attestation and assurance are the adapter's (K11). The adapter's four fields in the claims would have nearly doubled the transitions of the Desk (939,206 against 484,008) and more than doubled the check (16 minutes 35 seconds against 7 minutes 7 seconds) for no stronger claim. The step is journaled like any step, with its claims.

At the presenter's prompt: `resolve <desk> done` and `resolve <desk> not-done`, after reading `status`, which lists under `unknown` the guests whose Desk has a refund of unknown outcome, and shows the Stripe mock-up's refunds. The line it prints is `resolved: desk guest-01 is issued, signed by the presenter key key-presenter`.

To rehearse an unknown refund the Stripe mock-up has two faults for the recorded and stub rooms, `--stand-in-fault lost-all` (every refund request is applied once and its answer is lost: the key holds, one refund object exists, and the program cannot know) and `--stand-in-fault down` (every request is answered 503 and applies nothing). The show uses neither, and the launcher refuses the flag with `--live`.

## Act 1 part 4, Act 2's sixth attack, the diagrams (DF23, DF24, DF25)

**Part 4: what a lint sees.** `demo/lint/refund-key.mjs` reads the TypeScript of a build and checks that a POST to `/v1/refunds` carries an `Idempotency-Key`. It catches `ts-kept-nokey` (mutation (b)) with its line, `src/stripe.ts:46`. It says clean on a fixture that keys every call with a fresh key and keeps no memory of earlier refunds, which refunds twice when asked twice. Mutation (c) is the kept poly build with `RefundUnknown` going to `Idle` where it goes to `Review`: the shipped properties stay `CLEAN` on it (161 states), and the property `no-reissue` gives four findings with witnesses of 6 steps. The property is not one line: a ghost field, three updates, four `never`, 8 lines. The line for the stage is that the key is a local fact, which a lint can see, and a second request for the same order is a path fact, which only the check over the machine sees, once the property is written. It does not show that poly finds the double refund unaided, and `ts-kept` keeps a ledger in code that prevents it. The records are `docs/demo/part4/`.

**The sixth attack.** `refund 40` twice. The first refund is below the gate's threshold of 100, so it is allowed with no approval and sent; the second is refused by the program, not by the handler: the ledger is `Issued`, the guest hears `Already`, and the stand-in sees no request. The runbook has the steps (2.5, 2.7) and DS2 the row.

**Diagrams.** `docs/demo/diagrams/` holds Mermaid state diagrams of the Ticket of `poly-kept` (226 states) and of the Desk (5762 states), drawn from the reachable graph that `poly-ref` explores, projected onto `phase` (and `refund` for the Desk). They are projections of the checked model, not the model, and a test regenerates them byte for byte.

## What it costs

The Desk grows from 2114 to 5762 states, the `support` configuration from 29,379 to 81,443 global states, and the check of the example takes about 5 to 7 minutes on the reference machine, where v1.3.0 took about 4. It needs a heap of 8 GB. The first run of the room scenarios under Node's default heap (4288 MB) ran out of memory. So the launcher starts itself again with 8 GB when it has less, and the serial suite takes its heap from an env-file, because the test runner does not forward `--max-old-space-size` to the test files (measured: 4288 MB with the flag, 8384 MB with `NODE_OPTIONS` from an env-file). The runbook says to start the launcher once, early.

## Found while testing, and not changed

- **A text that two customers receive is refused for the second.** The taint of a body is kept by its digest and joined with the owners of every customer it was made for (PS17.4, S319), so the second send of the same text finds a body with two owners and is denied `audience`. The room scenarios found it with the same `Already` text for three guests; the recorded replies now name the thing each message is about. The hazard is general: a live model may write the same sentence for two guests, and the stub model always does (`Thank you for your message. A member of staff will follow up.`). It is a decision for the runtime, not for this release.
- **After an escalation nobody approves, the guest hears nothing.** The escalation times out after 24 hours and the Desk answers `Declined`, but the guest's last message is then 24 hours old, WhatsApp's window has closed, and the send is refused (`SendRejected`, AC15). The ledger is clear. It is the behaviour of v1.3.0, now visible in a test.
- **The Docker replay test can answer O3 under load.** `(c3)` of `test/demo-driver-hygiene.test.mjs` answered O3 (the build did not start in time) in the full run while the machine was busy, and passes alone, 15 of 15. It stops `npm test` before the serial part, so this release's suite was run in two parts (see the evidence). The robustness of the test is proposal 15 of `docs/proposals/v2.0.md`.
- **Refund attacks one guest at a time.** A text sent to two customers is refused for the second, so the runbook says to use a different guest for each refund attack, and that with the stub model only the first guest to ask is answered (`docs/demo/rehearsal.md`, step 2.6). Taint per recipient is proposal 12.
- **An unapproved escalation leaves the guest without a reply** (above). A reply after it is proposal 13.
- **The check of the Desk needs a heap of 8 GB and takes longer** (5 to 7 minutes where v1.3.0 took about 4). Start the launcher early and leave it running; the launcher gives itself the heap.
- **The wording of `Checking` and `Already` is the model's in a live room.** The reply decision is told the outcome by name. The recorded replies and the runbook give the text for the recorded room; a live model writes its own.
- **The handler's bound is code.** A repeat of the same amount on a charge that cannot take it is still refused by the handler. That is not a checked property, and the ledger does not depend on it.
- **`Resolve` trusts the adapter.** The program checks that a person signed; the adapter's cryptography is K11, which poly does not check.
- **The checks of kind, attestation and assurance left the program,** for the cost above. The claims type is the principal.

## Evidence for the release

The commits are `8345829a` (the specification) to the one that carries these notes, on the branch `demo`. Nothing is pushed, and `v1.3.1` is not tagged.

- **The fast part of `npm test`** ran 3,963 tests: 3,956 pass, 1 fails, 2 are skipped and 4 are to-do (`M4c` and its siblings, waiting on E1). The one failure is `(c3)` of `test/demo-driver-hygiene.test.mjs`, a replay in Docker that answered O3 (the build did not start in time) while the machine ran other work; the file passes on its own, 15 of 15. The run before it had failed on two things that were real and are fixed: `test/m4f-recheck.test.mjs` ran out of memory at the default heap, and `test/home-guard.test.mjs` pins the text of the test command.
- **The serial part (`test/after`)** ran 62 tests: 61 passed and 1 failed. The failure was `AC27` (`test/after/ex-concierge-e2e.test.mjs`): its check that the staff are told nothing of the customer matched `/250/` in a random intent id (`3250265d...`). It is fixed the way the demo's own test does it, and the file passes (1 of 1). Among the 61 are the two checks of the example and its variant (`ex-concierge-ledger`: CLEAN, 5762 and 81,443 states; the witness of 10 steps), the nine room scenarios (`demo-ledger-e2e`), both assemblies of `demo-resolve-e2e`, the six diagram tests of the Desk, and the heavy files that existed in v1.3.0 with their instance pins moved to 5762.
- **What was not done.** `npm test` did not exit 0 in a single run: the fast part stops the command at its one failure, so the serial part was run with the command the script uses, and the two files that failed were run again alone. A single clean run would need the flake of `(c3)` not to happen.
- **The new tests** are the DF20 table (`ex-concierge-refund`, 8), `demo-resolve` (24), `demo-stand-in-faults` (11), `demo-lint` (8), `demo-mutation-c` (7), `demo-diagrams` (6), the heap tests in `demo-launch` (6) and the heavy files above.
- **The checks of the programs** are in the records: `docs/demo/part4/` (poly-kept 226 states; mutation (c) 161 states CLEAN and four witnesses of 6 steps with the property), and the example (Desk 5762 states, CLEAN, `no-reissue` not vacuous).

## The process

The specification came first and alone (`8345829a`, amended in `4fae4d07`, `eb68ade3`, `b842ee82`, `40e23c2a` and `57331668` when reading the tests or running the code showed a gap). The failing tests were written by separate writers who had read only the specification, and were sent back until each could fail for its stated reason. The writers' defects, and the hand corrections made afterwards, are in the messages of the commits: the vacuous tests (one that passed on the code it was meant to test, one that documented the absence of a feature), a test that asserted the current behaviour, three `require` calls in an ES module, a wrong join order that put a guest on the wrong customer, a list sliced by an index of the unfiltered log, a window of 24 hours not known to the writer, and the pins of the older tests. The runs found three things the specification could not have: the heap, the identical reply text, and the baseline's pinned reference (the sentence added to PT33.11 changed the digest of the poly arm's scaffold, DB16.3, so it was taken out again; the limit is stated in the proposal, the example's README and these notes).

## The proposals for v2.0

Every proposal that this work raised is in `docs/proposals/v2.0.md`, fifteen of them, each with its problem, evidence, sketch, what it touches and its open questions. Per-order identity (a conceptual data layer) is the first; the model imprecision of the witnesses, taint per recipient, a reply after an unapproved escalation and the robustness of the Docker replay test come from this release.

## Conclusion

v1.3.0 proved that a retried refund executes once. It did not prove that a refund asked for twice executes once, and the concierge executed it twice. v1.3.1 says what the check sees and what it does not: the key is a line, the ledger is a state and the property `no-reissue` is a path, and the shipped properties of a program do not notice a regression until someone writes the one that does. The fix is per thread, not per order; the cost is a larger check and a larger heap; and a person ends an unknown refund with a signed step that the presenter can show.

## Glossary

- **Ledger:** the Desk's record of its refunds on a thread: `None`, `Unknown`, `Issued`.
- **Unknown:** a refund whose outcome the program does not know: in flight, waiting for a person's approval, or ended with no answer.
- **Resolve:** the step in which a person, with a signed record, says whether an unknown refund exists.
- **Path property:** a property of the sequences of steps of a machine, here `no-reissue`.
- **Projection:** the checked states drawn as the value of one or two fields.
- **Lint:** a static rule over the text of a program.
- **Mutation (c):** the kept poly build with `RefundUnknown` going to `Idle` in place of `Review`.
- **K11, K17:** the kernel assumptions that the adapter's cryptography is right and that the provider honours the key; printed with the verdict, not proved.
