# Assumptions of the writer of `demo-driver-bounds.test.mjs`

The tests in `test/demo-driver-bounds.test.mjs` (commit `fff3f9aa`) were written by a separate writer under rule 7a, from DB6 item 12 and DAC32 of `docs/proposals/demo-refund.md`, before the code. This file records what the writer assumed where the item is silent, and what it read beyond the item. It is taken from the writer's report.

## What the writer read beyond the item

The brief allowed the item, DAC32, `CLAUDE.md`, the five driver test files, `test/fixtures/demo/`, and the public exports of `demo/driver/replay.mjs` and `demo/stand-in/stripe/tls.mjs`. The writer also read these parts of the code:

- In `demo/driver/replay.mjs`: the body of `selfCheck`, its private helper `request`, and the call of `selfCheck` inside `replay()`. It read them to find how the self-check reaches the stand-in, and to make sure that the old tree could not hang the test file.
- In `demo/driver/replay.mjs`: the bodies of `stop()` and `drive()`. It read them only to build the scratch implementation below.
- `demo/stand-in/stripe/server.mjs`, and how the mutant `test/fixtures/demo/mutants/stripe-ignores-key.mjs` uses `demo/stand-in/stripe/stripe.mjs`. It read them to learn the interface of the `stripe` factory that `replay()` takes, which the two `replay({ selfCheckMs })` tests use to make the real stand-in hold its answer.

It also checked its tests against a scratch implementation, in a temporary folder outside the repository: a helper written from item 12 (g), and a copy of `replay.mjs` with the bounds of (b) and (d) and the `cleanup` of (f). Tests 1 to 15 passed against it. It deleted both before it reported. The code of `23848b44` was written afterwards, separately.

The message of `fff3f9aa` says the tests were "written from DB6 item 12 and DAC32 alone". That overstates it; the owner ruled on 2026-11-01 that the message stays as it is and that this file records what was read.

## Assumptions where the item is silent

- **The silent stand-in.** The two `replay({ selfCheckMs })` tests make the real stand-in hold its answer through the public `stripe` option: the factory declares one byte more in `Content-Length` than the body. This depends on the stand-in passing the factory's headers to `writeHead`, which it does at `fff3f9aa`. The tests also set the stand-in server's `keepAliveTimeout` to 0 through the `http.server.request.start` diagnostics channel, since Node would otherwise close the idle connection after 5000 ms, before the default bound of 10000 ms.
- **"After the line of the build's own tests."** The tests read it as "after, in order", not "immediately after".
- **One entry per drive.** The item does not say how many entries one stop gives. The Windows test expects one per drive: the control, then the fault run.
- **A connection closed with an incomplete answer** before the bound is not covered by the item and is not tested.
- **"A whole number above 0."** Only `0`, `-5`, `1.5`, `abc` and `300` are tested. Forms such as `007`, `+5`, `1e3`, an empty value or surrounding spaces are not defined by the item and are not tested.
- **"taskkill could not be run".** No test reaches it without changing `PATH` for the process that runs the driver, so only its line in `format()` is tested, on a synthetic result.
- **No new flag of `demo.mjs replay`.** The item defines no answer to an unknown flag, so this is not tested.
- **Items (c) and (e)** are kept by review of the code, as the item says, and are not tested.
- **The POSIX test** (stopMs is not used on POSIX) is skipped on Windows and has not been run.

## Conclusion

The tests check what DB6 item 12 states, but the writer read more than the item: the self-check's code, `stop()`, `drive()` and the stand-in's server, and it tried its tests against a scratch implementation that it deleted. Where the item is silent, the tests take the readings listed above, and the code of `23848b44` follows the same readings.
