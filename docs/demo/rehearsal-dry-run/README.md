# Dry run of the rehearsal runbook

These files are the output of the free steps of `docs/demo/rehearsal.md`, run in PowerShell 7 on the owner's machine with Docker Desktop. No key was set and no model was called. The number in each file name is the step of the runbook.

| File | Step | What it shows |
|---|---|---|
| `00-setup.txt` | 0.1 to 0.6 | Branch `demo`, `experiments/` identical to `c862a6f0`, Node 24, Docker, the image, the four trees, no key. The status line lists this folder because its files were being written. |
| `11-checker-poly-kept.txt` | 1.1 | `CLEAN`, `keyed Idempotency-Key within 24h (K17)`. |
| `12-checker-mutation.txt` | 1.2 | `PL4003`, the 3-step witness, `executions of the target: 2`, exit 1. |
| `14-replay-ts-kept.txt` | 1.4 | O2, 10000 refunded of 4000 asked. |
| `15-replay-poly-kept.txt` | 1.5 | O2, 6000 refunded of 4000 asked. |
| `16-illustration-ts-kept-nokey-cups.txt` | 1.6 | O1, 2 refund objects, 8000 refunded of 10000. |
| `17-illustration-poly-kept-nokey-cups.txt` | 1.7 | O3, not admitted, with the build's own `AdmitError`. |
| `18-fallback-recorded.txt` | 1.8 | The recorded results. |
| `22-refusals.txt` | 2.2 | Five refusals of the launcher, each exit 2. |
| `23-stub-room-cap-0.01.txt` | 2.3 | The room on the stub model with a cap of 0.01: a `spend:` line after replies, `status` with spend. Played by a script over HTTP. |
| `23b-stub-room-stops-at-cap-0.0004.txt` | 2.3 | The cap reached: `spend cap reached ... The room has stopped.` and the next message `halted`. |
| `24-live-without-valid-tables.txt` | 2.4 | A live launch on the committed placeholder tables is refused. |
| `26-recorded-room.txt` | 2.7 | The recorded room starts and answers. |
| `31-act3-check.txt` | 3.1 | `17 figures: 17 hold`. |
| `32-act3-live-command.txt` | 3.2 | `PL4003` on `draft-unguarded.poly`, exit 1. |

## What was not run

Step 2.5 (the live launch) was not run: it needs the owner's key and spends money. Its path was checked in a test with a fake meter and in one probe: with valid price tables (synthetic, for the probe only) and no key, a live launch with a cap is refused for the missing key, before any model call.

The presenter's token in the staff panel address is replaced by `<token>` in the files.

## Conclusion

Every free step of the runbook ran as the runbook says, and the screens match the expected text. The one step that spends money was not run.

## Glossary

- **Dry run:** the free steps of the runbook, run with no key and no network except the local container.
- **Stub model:** a local program that answers where the model provider would, at no cost.
- **Cap:** the most a launch may spend, set with `--cap-usd`, at most 10 dollars.

## Windows PowerShell 5.1

`51-windows-powershell-5.1.txt` is a second run of the steps that changed, in Windows PowerShell 5.1 (the owner's window): the setup checks, the replay helper and the four replays, the JSON read of step 1.7 (`Out-String | ConvertFrom-Json`), the figures of Act 3, and the key form of steps 2.5 and 2.6. The key form was run with a dummy value in place of the secure string that the prompt returns. It left the environment variable set, then no variable named `secure`, and no other variable holding the value, and the removal step cleared it.
