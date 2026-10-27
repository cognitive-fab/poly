# Example spec: flash-controller

Batch 5, example 2. Written before any test or code (rule 7a). The tests are written by someone who has read only this page, so everything a test needs is on it.

## Purpose

A flash controller keeps the state of one block of a flash chip: erased, programming, programmed, verifying, verified, erasing, or bad. A block may be programmed only when it is erased, and a block that fails verification is erased and programmed again, up to a limit of two retries, after which it is bad. The example is a **pure state machine**: it has no effect, no decision and no model. The host drives a device and tells the machine what the device did. The point of the example is the invariant **a block is never programmed unless it is erased**. The seeded defect is a missing erase check.

## Files

All paths are under `examples/flash-controller/`. The names are fixed.

| File | Content |
|---|---|
| `flash-controller.poly` | module `flash`, first line `// expected: CLEAN` |
| `flash-controller.policy.poly` | module `flash_policy`, policy `flash`, scope `"flash"`, one `recalled` item and no obligation (the machine has nothing to govern) |
| `flash-controller-defect.poly` | the program with the erase check removed, first line `// expected: FINDING PL3002` |
| `flash-controller-defect.policy.poly` | the defect's policy beside it; the same text as the program's |
| `host/controller.ts` | typed host code that drives one block against a device; exports `driveBlock` |
| `host/tsconfig.json` | compiles `host/controller.ts` for `poly check --host`; run with `--root examples/flash-controller` |
| `host/recorded.mjs` | the recorded device: exports `recordedDevice(script)` |
| `README.md` | what it shows, how to run it, what is checked, what is not, a conclusion, a glossary |

Tests: `test/ex-flash-controller.test.mjs` (light) and `test/after/ex-flash-controller-e2e.test.mjs` (admission and a run). The shared helper is `test/ex-kit.mjs`; `admitExample` copies `host/handlers.ts` only when it exists, and this example has none (it has no effect).

## Machine

One `machine Block` in module `flash`, one instance per block. `enum State { Erased, Programming, Programmed, Verifying, Verified, Erasing, Bad }`. State: `state` (`Erased`), `data : 0..3` (0), `retries : 0..2` (0). `terminal state == Bad`.

- `Program(value: 0..3)`: `"not-erased"` unless `Erased`. Goes to `Programming` and records `data`.
- `ProgramDone()` and `ProgramFailed()`: `"not-programming"` unless `Programming`. Both go to `Programmed` (a failed program is found by the verify).
- `Verify()`: `"not-programmed"` unless `Programmed`. Goes to `Verifying`.
- `VerifyPassed()`: `"not-verifying"` unless `Verifying`. Goes to `Verified`.
- `VerifyFailed()`: `"not-verifying"` unless `Verifying`. When `retries < 2`: increments `retries` and goes to `Erasing`; otherwise goes to `Bad`.
- `Erase()`: `"nothing-to-erase"` unless `Programmed` or `Verified`. Goes to `Erasing`.
- `EraseDone()`: `"not-erasing"` unless `Erasing`. Goes to `Erased`.

## Properties

1. **Step property `erased-before-program`**: `action == Program implies pre.state == Erased`. A block is never programmed unless it is erased.
2. **Step property `data-written-only-by-program`**: `action != Program implies post.data == pre.data`.
3. **Invariant `bad-after-limit`**: `state == Bad implies retries == 2`. A block is bad only after the retry limit.

The program and its policy check `CLEAN` over **76 states**, with deadlock freedom (every non-terminal state has an accepting action). The policy has one `recalled` item, "A block is erased before it is programmed.", and no obligation; its stages are `CLEAN`.

## Host code and the recorded device

`host/controller.ts` exports `driveBlock(rt, id, device, value)`, with a type-only import of `Action` from `../.poly/build/flash.Block/types.js`. `device` has `program(value)`, `verify()` and `erase()`, each returning `Promise<'ok' | 'fail'>`. `driveBlock` takes a block through one write: it dispatches `Program` with `value`, then `ProgramDone` or `ProgramFailed` by `device.program`, then `Verify`, then `VerifyPassed` or `VerifyFailed` by `device.verify`; on `VerifyFailed` it asks `device.erase()`, dispatches `EraseDone` when it answers `ok`, and writes again, until the block is `Verified` or `Bad`. It returns the block's final state, read with `rt.getState`. Dispatches are `rt.dispatch<Action>(id, name, data)`; `rt` is the runtime.

`host/recorded.mjs` exports `recordedDevice(script)`, where `script` is `{ program: [...], verify: [...], erase: [...] }`, each a list of `'ok'` or `'fail'` answers taken in order (the last repeating; an empty or missing list answers `'ok'`). It returns `{ calls, device }`: `calls` lists each call as `{ op, value? }`, in order.

## Seeded defect

`flash-controller-defect.poly` is the program with the `"not-erased"` requirement of `Program` removed: a block can be programmed whatever its state. The check rejects it with exactly one code, **`PL3002 STEP_PROPERTY`**, naming `erased-before-program`. The shortest witness has **2 steps**: `Program(0)` on the erased block, and `Program(0)` again on the block that is now `Programming`. The check of the defect copy beside the same policy gives the same finding.

## What the tests must show

Light test:

- the program with its policy is `CLEAN`; the instance is printed (76 states); the policy's stages ran;
- the defect is `FINDINGS` with exactly `PL3002`, `erased-before-program` named, a witness of 2 steps whose steps are both `Program`;
- `poly check --host` is `CLEAN`, and a host file with a wrong action name is `PL6836`;
- `driveBlock` against a fake runtime that records dispatches, with a device that always answers `ok`: dispatches in the order `Program`, `ProgramDone`, `Verify`, `VerifyPassed`;
- `recordedDevice` answers in order, repeats the last, defaults to `ok`, and records calls.

End-to-end test, over the recorded device, nothing on the network (the example has no effect or decision, so nothing but the device is recorded):

- main path: a block is programmed with 2, verified: `Verified`, `data` 2, `retries` 0; the device was asked `program`, `verify` once each;
- refusal: `Program` on a `Programmed` block (and on a `Verified` one) is rejected `not-erased`, and the state is unchanged; `Erase` on an erased block is rejected `nothing-to-erase`;
- retry within the limit: the first two verifies fail and the third passes: `Verified` with `retries` 2, the device erased twice;
- retry limit: every verify fails: after the third failure the block is `Bad` with `retries` 2, and every action is then rejected with the reason `terminal`;
- erase and rewrite: a `Verified` block is erased (`Erase`, `EraseDone`) and programmed with another value;
- the journal replays with no divergence (`replayRuntime`, `replaySessions`).

The example has no escalation to a person; a `Bad` block is the machine's last word.

## Conclusion

The invariant is one comparison, and the check finds its absence in two steps. The machine is pure, so everything it knows is in its state, and the example shows what that buys: the controller can be checked over all 76 states, replayed from its journal, and driven by any device that tells it the truth.

## Glossary

- **Block:** the unit of a flash chip that is erased and programmed together.
- **Erase before program:** a flash cell can be programmed only from the erased state.
- **Retry limit:** the number of times a failed verification is retried before the block is marked bad.
- **Pure state machine:** a machine with no effect and no decision; all its inputs come from the host.
