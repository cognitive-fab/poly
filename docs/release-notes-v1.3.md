# poly v1.3 · Release notes (the refund demo, and the retry-safety rule)

## What v1.3 is

v1.3 adds one rule to the language and its checker, and a demonstration built on it.

The rule is retry safety (S526, PS23). An effect that cannot be undone and may be attempted twice must say how the target is kept from running it twice, or the check reports it. The demonstration is a three-act refund demo: two agents given the same prompt, a live room where an audience attacks a customer-service agent, and a loop in which a mined rule finds a defect in a shipped example. The demo runs against a local stand-in for Stripe at every stage. No real money moves, and no Stripe key exists anywhere.

## What v1.3 contains

### The rule

- **`PL4003 UNGUARDED_RETRY` (PS23.5, PT33).** For every effect of class `irreversible` with two or more attempts, the program must declare a guarantee: `idempotent header "<Name>" window <duration>` (keyed, G2), or `idempotent by nature` for the standard library's own effects (G4, a pinned list). Otherwise the check reports the effect with a witness: a delivery in which the target may execute twice. Admission refuses a build with such a finding unless a person has signed an acceptance (PT12.5).
- **The key.** The runtime attaches the key to every write request of a keyed effect, in a capability the handler cannot bypass. The window must hold the retry horizon (`PL4004 KEY_WINDOW_TOO_SHORT`, PS23.7).
- **`PL6304 EFFECT_WITHOUT_CLASS` (PS23.6).** An effect that reaches outside must declare its class. A classless egress effect is refused.
- **The assumptions, named.** K17 (a target honours the key it is sent) and K18 (an effect declared idempotent by nature is) appear in a certificate exactly when an effect declares them. poly does not verify either. The finding says that a delivery exists in which the target may run twice. It does not say that a provider duplicates.
- **The migration.** The four channel sends and the webhook are at most once in the standard library, `credential.revoke` is idempotent by nature, and `std/PINS.json` pins the digests that may declare it. Two examples and about 45 fixtures were updated for the rule.

### The demo

- **The baseline (`demo/baseline/`).** One prompt, two arms (TypeScript and poly), pre-registered with two amendments, a guard and a hook whose hashes are fixed, an audit of every tool call of every run (`clean`, `attempted`, `escaped`), and records committed verbatim before anything was run against them.
- **The Stripe stand-in and the replay (`demo/stand-in/`, `demo/driver/`, `demo/container/`).** A local server that behaves as Stripe's refund endpoint documents, with a key check of its own, and a driver that applies the first refund request and loses the answer. The run is in a container with no network. The outcomes are O1 (a second refund), O2 (one refund) and O3 (the build could not be driven).
- **The room and the live providers (`demo/host/`, `demo/launch.mjs`).** The concierge of `examples/concierge` as the demo copy (generated, with the diff printed: the budget's caps and the decision timeouts), a room page that signs each message as the WhatsApp Cloud API does, a staff panel, personas with made-up orders, and live model providers on a transport that reaches the provider's host alone. The launcher refuses a live run without a spend cap of 10 dollars or less, reserves the worst case of each request so that the spend never exceeds the cap, stops the room at the cap, prints the spend after each reply, and can write a log. A stub model proves the launcher with no key and no network.
- **The failure lines.** Each failed decision is one line on the terminal with its decision, its tier and its reason, with no key, no body and no customer text: a timeout, an HTTP refusal with the API's own message, an ask that was cut off (with its token count), a value that was refused (with the count of asks), an amount outside its domain.
- **Act 3 (`docs/demo/act3-script.md`, `scripts/act3-check.mjs`).** The loop of mining, refuting, adjudicating and promoting, with 17 figures, each cited in a committed record or produced by one live command, and a check that fails if a figure cannot be reproduced.
- **The runbook (`docs/demo/rehearsal.md`).** Setup, the three acts and the shutdown for Windows PowerShell 5.1, with the dry run of every free step recorded in `docs/demo/rehearsal-dry-run/`.

### Three fixes of the last step

- A usage that is not a whole number of tokens is a `ProviderError` and never zero spend.
- A single ask (the `answer` and `reply` decisions) is refused if the API reports more input tokens than its limit.
- The room page says `Sending...`, gives up on `/api/say` after 10 seconds with a message, stays stopped once the presenter has stopped the room, and treats an abort while the body is read as the timeout.

## The demo's results

### Act 1, the baseline

Both agents got the same prompt: a WhatsApp refund agent that talks to Stripe. The four committed trees were replayed twice. In the first pass all four were O3, because three of them ask for a confirmation and wait for a second message and the fourth misreads the sentence. After one confirmation turn, approved by the owner, the two kept builds (`ts-kept` and `poly-kept`) and one pilot were driven, and each refunded once under the lost answer: the retry carried the same key and the stand-in replayed its first answer (O2). Both kept builds chose an idempotency key; nothing in the prompt asked for one.

**The difference.** In TypeScript the key is a choice that nothing enforces. With the `Idempotency-Key` header removed from `ts-kept`, its own tests still mostly pass (18 of 20), and the build starts. In poly, removing the `idempotent` clause from `poly-kept` is `PL4003` with a witness of three steps (`executions of the target: 2, idempotency key: unchanged, deduplication declared: none`), and the build is not admitted.

**The illustration** (a chosen scenario, not part of the experiment). The experiment's request let Stripe's own rule hide the missing key, because both builds refunded more than asked and a second refund of a charge refunded in full is refused. For a request of one item (CUPS-4, 40.00 of a 100.00 order) the unkeyed TypeScript build refunded twice: two refund objects and 80.00 on a charge of 100.00. The unkeyed poly build was never driven; its admission stopped it (`AdmitError`, `PL4003`).

### Act 2, the live rehearsal

The room ran live over a real model under a spend cap, driven by the owner. Status questions and refusals work; a refund of 450 goes to approval, and after the approval the handler read the charge and refused with no request to the refund endpoint; a request for 5,000 is refused at dispatch (AC30: the completion is outside `0..500`), journaled with rule S140, and the guest hears the `Unsure` reply.

The rehearsal found five failures, each fixed with a test that reproduces it:

1. The decision timeouts of the example (800 ms) could not hold a vote of five asks against a live provider (two round trips). Both tiers timed out while the abandoned calls were still billed. The demo copy sets longer timeouts.
2. A request with `temperature` was refused by the model (`temperature` is deprecated for it). No request holds it now.
3. The amount vote had 80 output tokens an ask and every reply was cut off. It has 200.
4. A reply that begins with prose was not parsed. The prompt now asks for a bare JSON number and a reply that begins with `{`, and the parse accepts a bare number or a string of digits with an optional `.00` and nothing else.
5. A silent failure on the terminal. Every failed decision, and a refused key, is a line now.

Two of the findings were about the demo, not the model: the stub answered instantly and hid the timeouts, and the first dry run checked only that the room accepted a message, not that an answer reached the page.

### Act 3, the loop

The loop found a real defect in a shipped example (`examples/inbox`): a rule mined from a synthetic corpus, `count("gmail.createDraft") <= 1`, was refuted with a ten-step witness, the fix is one declared line and one declared outcome, and the check now finds the same class of defect from the declaration alone. The 17 figures of the script hold. The corpus was a synthetic amplification, and on the recorded run mining proposed nothing; the script says so.

## Known limits

- **The calibration maps are stand-ins.** `demo/concierge/maps/` holds the example's maps, fitted for another model. For a rehearsal the owner relabels them to the models in use and recomputes the digests locally; that is not committed. `docs/demo/calibration-for-release.md` states the two ways to a release: one calibration run with `poly journal fit`, or maps named as stand-ins on the stage.
- **The timeouts are provisional.** The demo copy has classify 20 s and amount, answer and reply 10 s, as ceilings. `launch.mjs --measure-latency` measures a whole call of each tier with the owner's key and a cap, and suggests `max(2, ceil(2 * max / 1000))` seconds. It has not been run live.
- **The out-of-domain reply.** An amount above what the type allows is refused correctly, and the guest hears the `Unsure` reply, not "above what can be refunded". The Desk's failure action carries no reason. Option A of `docs/demo/proposal-out-of-domain-outcome.md` (the runtime names the reason, the program branches, `Outcome` gains `OutOfRange`) is the item for v1.4, with its touch list in `docs/demo/step13-list.md`. The terminal line is exact today: `outside its domain (0 to 500)`.
- **The wrong amount (A1).** All the builds that were driven refunded more than the 40.00 requested, in the control run too: `ts-kept` 100.00, `poly-kept` 60.00, `poly-pilot-3` 100.00. Each set the amount from the order. `poly check` proves that no line is refunded twice (over its finite model). It does not cover how much: in the poly build the amount is computed in a JavaScript handler, outside the machine.
- **The stand-in is not Stripe.** It is read from Stripe's documentation, and K17 (that a provider honours the key) is an assumption that poly lists and does not verify.
- **No journal command in the launcher.** The launcher keeps its run in a temporary folder that it removes at `quit`. The proof that the journal replays with no divergence is the recorded end-to-end test.
- **The room page.** A tab left over from an earlier launch keeps its connection to the host and the browser queues a new `Send` behind it. The page now says it is sending and gives up after 10 seconds; one event stream for each session, and the release of a hidden page's connection, are proposed for later (`docs/demo/rehearsal.md`).
- **A decision that fails sends nothing.** When a decision fails, the program returns to idle and the guest hears nothing, or the acknowledgement of the next message. This is the behaviour of `examples/concierge`, unchanged.
- **The history.** Three commits of a test writer sit in the history against its brief (`b26d1b91`, `fdad87c8`, `75ae0132`). They change one test file.

## Evidence for the release

Run on the commit `8c034a8b` (the last code commit; the working tree was clean, with the committed maps and price tables), one run, each part as the script of `npm test` runs it:

- **`npm test`:** the build and the boundary check passed; then **3,892 tests: 3,886 passed, 0 failed, 2 skipped, 4 to-do**. The to-do include `M4c` (a late duplicate after the receiver is purged), which waits on a polyrun fix (E1). The command exited 0.
- **`test/after`** (the heavy tests, one file at a time): **42 of 42 passed**, among them the recorded end-to-end run of the concierge (AC27), the demo's stub and answer tests, the failures tests and the approval test.
- **The demo's own tests** are in these counts: the driver, the stand-in, the room, the live providers with the spend meter and the stub, the failure lines, the page, the secret scan and the end-to-end run.
- **The flake.** The owner reported four tests that fail only in the full suite, which he attributed to uncommitted changes in his polyx checkout. They did not fail in this run. The 88 tests that use polyx also pass alone, in parallel and one at a time, and so does the heavy inbox-loop test. The checkout's one modified file, `polyx.config.json` (dated 2026-09-23), is not read by poly, which passes its own `--config`; the pin covers the entry file and the version. The four tests were not named, so the cause is not found. Nothing in the checkout was changed.

## Conclusion

v1.3 makes one thing a property the checker demands: an irreversible effect that may be retried must say how the target is kept from running it twice. The demo shows it twice. In Act 1 both agents chose a key, and removing it from the TypeScript build is invisible to its tests and, when the request allows, refunds a customer twice, while removing it from the poly build is a finding with a witness and a build that is not admitted. In Act 2 the same checked program held on live input from a real model: the refusals, the approval and the domain held, and the five failures the rehearsal found were failures of the host and the prompts, each now a line on the terminal and a test. What the checker does not cover is named above: the amount, the calibration and the guest's words when a number is out of range.

## Glossary

- **Retry safety (PS23):** the rule that an irreversible effect with two or more attempts declares a guarantee that the target runs it once.
- **`PL4003`:** the finding for an irreversible effect that may be retried with no such guarantee.
- **Keyed (G2):** the effect sends an idempotency header that the runtime attaches; K17 is the assumption that the target honours it.
- **By nature (G4):** an effect of the standard library that is idempotent in itself; K18 is the assumption.
- **Stand-in:** the local program that plays Stripe in the demo.
- **O1, O2, O3:** the outcomes of a replay: a second refund, one refund, a build that could not be driven.
- **A1:** the observation that the builds refund an amount other than the one asked.
- **AC30:** the criterion that a number outside the strict domain never reaches the handler.
- **S140:** the rule that a completion outside its type is refused before it is a step.
- **Cap:** the most a live or stub launch may spend, set with `--cap-usd`, at most 10 dollars.
- **Demo copy:** the concierge as released with only its budget caps and its decision timeouts changed, generated by a script and checked as itself.
- **Calibration map:** a monotone map from the raw share of votes to a calibrated confidence, fitted for one model of one decision.
