# Step 13: the list

Step 13 runs the full suite. This list holds what is to be done before it or with it. Each item says where it is and what a fix must show. Rule 7a applies to each: spec, failing tests by a separate writer, then code.

## From the live rehearsal

1. **Null token usage is metered as zero** (polywatch finding 1, `mvfyi7za`). In `demo/host/live-providers.mjs`, `ask()` reads the usage with `Number(body.usage?.input_tokens)`, and `Number(null)`, `Number('')`, `Number(false)` and `Number([])` are 0, so a 200 response with a null usage is accepted as 0 tokens. The meter is safe (it charges the reserved worst case when the usage is not a whole number), but the provider reports zero to the runtime. A fix reads the usage as numbers only and throws `the model provider reported no token usage` for anything else. It must show the refusal for `null`, an empty string, `false`, an array and a missing field.
2. **No input-share check on the single asks** (polywatch finding 3). `text()` (the `answer` and `reply` decisions) never compares the input tokens that the API counts with `limits.maxInputTokens`, as `vote()` does for its first ask. A fix adds the check, with the same message form. It must show a refusal when the API reports more input tokens than the limit, and the single ask not retried.
3. **The room page's "Sending..." state**, and the rest of the page fix proposed in `docs/demo/rehearsal.md` under "The room page, for v1.3": a timeout on `/api/say` with a message, the state of the event stream, one stream for each session, and the release of a hidden page's connection. A fix needs a fast test of the pure parts and a heavy test with six held connections.

## From the launcher

4. **The DF6 test of the placeholder tables reads the owner's local files.** `test/demo-launch.test.mjs` asserts that a live launch is refused on `demo/concierge/prices`, and `test/demo-concierge-copy.test.mjs` compares `demo/concierge/maps` and `prices` with the example's. Both fail on a machine where the owner has real tables, as the live rehearsal needs. A fix makes them read a fresh copy in a temporary folder, not `demo/concierge/`.
5. **The test writers' own commits.** Three commits of a test writer sit in the history against the brief: `b26d1b91` (named "Spec:" and changing a test), `fdad87c8` and `75ae0132`. They only change `test/after/demo-failures.test.mjs`. The owner may keep them or squash them before the release.

## Decisions waiting for the owner

6. **The out-of-domain outcome**: decided for v1.3 as option C (no change: the guest hears the `Unsure` reply, and the terminal line says `outside its domain (0 to 500)`). **Option A is the v1.4 item.** Its touch list, from `docs/demo/proposal-out-of-domain-outcome.md`: the runtime gives the failed hook the reason `outside-type` for a refusal under S140 (`poly-runtime`, its tests, and the documentation of the reason in PS and PT); the Desk's `Unextracted` takes a `reason` and a handler branches on it; `Outcome` gains `OutOfRange`; `examples/concierge/concierge.poly` changes and the demo copy is generated again; the Desk instance (2114 states today) grows and the check runs again (91 to 176 s), so the certificate and the verdict baseline are produced again; the recorded fixture gets `replies.OutOfRange` for `refund-outside`; the end-to-end test, `demo-room-answers`, the runbook table of step 2.5 and the row of DS2 that says the Desk replies that it is unsure change; the policy and the budget do not.
7. **The calibration maps** (`docs/demo/calibration-for-release.md`): one calibration run and `poly journal fit`, or named stand-ins.
8. **The timeouts of the demo copy** are provisional ceilings (classify 20 s, amount, answer and reply 10 s). Run `--measure-latency` and set them from the report.
9. **The amount vote's output limit** is 200 tokens an ask by the host's default. Check the counts in the log of the next live run (`reply cut off at <n> tokens` should not appear).

## The suite

10. **Run the full suite** (`npm test`) with the owner's tables restored to the committed ones, or after item 4, and report the counts. The full suite has not been run since the first part of Step 12.

## Conclusion

Three items come from polywatch and the live run (null usage, the single asks' input share, the page's sending state). Two are about tests that depend on the owner's machine and on the history. Four are the owner's decisions. The suite runs last.

## Glossary

- **Rule 7a:** spec text first, then failing tests by a separate writer, then the code.
- **Single ask:** a decision that asks the model once (`answer`, `reply`), as against a vote of five asks.
- **Input share:** the part of the input limit that one ask of a vote may use.
- **Provisional ceiling:** a timeout set high until a measurement replaces it.
