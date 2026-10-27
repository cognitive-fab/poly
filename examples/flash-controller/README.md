# Flash controller

A flash controller keeps the state of one block of a flash chip: erased, programming, programmed, verifying, verified, erasing, or bad. A block may be programmed only when it is erased, and a block that fails verification is erased and programmed again, up to a limit of two retries, after which it is bad. The example is a pure state machine: it has no effect, no decision and no model. The host drives a device and tells the machine what the device did; here the device is recorded, so nothing leaves the machine. The spec is `docs/examples/flash-controller.md`.

## What it shows

- **A pure state machine.** Everything the machine knows is in its state, so it can be checked over every state, replayed from its journal, and driven by any device that tells it the truth. There is no handler to certify: the host code in `host/controller.ts` is typed against the generated types.
- **An invariant on the order of operations.** The step property `erased-before-program`: a block is never programmed unless it is erased. `data-written-only-by-program` says the data changes only when a block is programmed, and the invariant `bad-after-limit` says a block is bad only after the retry limit.
- **A retry with a limit.** A failed verification erases the block and programs it again, twice at most; the third failure makes the block `Bad`, a terminal state that rejects every action with the reason `terminal`.
- **A seeded defect.** `flash-controller-defect.poly` removes the erase check from `Program`.

## Run it

From the repository root, after `npm ci` and `npm run build`:

```sh
node packages/poly-check/dist/src/cli.js check examples/flash-controller/flash-controller.poly
node packages/poly-check/dist/src/cli.js check examples/flash-controller/flash-controller-defect.poly
node packages/poly-check/dist/src/cli.js check examples/flash-controller/flash-controller.poly --root examples/flash-controller --host examples/flash-controller/host/tsconfig.json
node --test test/ex-flash-controller.test.mjs
node --test test/after/ex-flash-controller-e2e.test.mjs
```

The tests check each program with its policy beside it, as a project. The policy has one `recalled` item and no obligation, since the machine has no effect for an obligation to govern; its scope is the module's name, which a policy must be (`PL6504`).

## What is checked

| Check | Result |
|---|---|
| Program with its policy | `CLEAN`; `Block` over 76 states, deadlock free; about 1 s |
| Policy | all seven stages `CLEAN`; nothing to govern, so its regions are unreachable and its `never` has nothing to prove |
| Defect copy | `FINDINGS`, exactly `PL3002 STEP_PROPERTY` (`erased-before-program`), a witness of 2 steps: `Program(0)` on the erased block and `Program(0)` again on the block that is now `Programming`; 76 states |
| Host code | compiles under `poly check --host`; a wrong action name is `PL6836` |
| End to end | 7 tests: a block written and verified, a refused `Program` on a programmed block and an `Erase` on an erased one, two failed verifications and a third that passes, the retry limit ending in `Bad`, an erase and a rewrite, and a journal that replays (no divergence) |

## What is not checked

- **The device.** That a real chip erases when told, and programs what it was given, is the device's. The machine is told what the device did, and takes it as true.
- **Wear and timing.** There is no erase count beyond the retry limit and no duration.
- **Domains.** One block, four values (`0..3`), two retries. Nothing was reduced for the check; `CLEAN` is a statement about 76 states, not about a chip's thousands of blocks.
- **Whether `ProgramFailed` leads to `Programmed`.** The machine sends a failed program to verification, which finds it; a controller that retried the program itself would be another machine.

## Conclusion

The invariant is one comparison, and the check finds its absence in two steps. The machine is pure, so the check covers all of it: the whole behaviour is the 76 states, and a device that lies is the only thing it cannot see.

## Glossary

- **Block:** the unit of a flash chip that is erased and programmed together.
- **Erase before program:** a flash cell can be programmed only from the erased state.
- **Retry limit:** the number of times a failed verification is retried before the block is marked bad.
- **Pure state machine:** a machine with no effect and no decision; all its inputs come from the host.
- **Recorded device:** the answers of a device written down in advance, so a run needs no hardware.
