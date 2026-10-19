# Dry run of the rehearsal runbook

This is the second dry run of Step 12, made after the owner's rehearsal findings F1 to F5. The first one is replaced. Every block is the runbook's own, run in Windows PowerShell 5.1 (`powershell.exe`, not Git Bash) by one script, with `openssl` added to the path as step 0.7 says. The room steps are played by `play-room.mjs`, which acts as the guests and prints what each guest's page receives. The first dry run checked only that the room accepted a message, which is why it missed that no answer arrived.

| File | Step | What it shows |
|---|---|---|
| `00-setup.txt` | 0.1 to 0.6 | Branch `demo`, `experiments/` unchanged from `c862a6f0`, Node 24, Docker, the image `step12`, the four trees, no key. The status lists the files of this change, which were not yet committed. |
| `07-openssl.txt` | 0.7 | `openssl.exe` found in the Git folder, `OpenSSL 3.5.4`. |
| `08-warm-up.txt` | 0.8 | The warm-up replay of `poly-kept` with `--listen-timeout 180000`: O2. |
| `11-checker-poly-kept.txt` | 1.1 | `CLEAN`, `keyed Idempotency-Key within 24h (K17)`. |
| `12-checker-mutation.txt` | 1.2 | `PL4003`, the 3-step witness, `executions of the target: 2`, exit 1. |
| `13-replay-ts-kept.txt` | 1.3 | O2, 10000 refunded of 4000 asked. |
| `14-replay-poly-kept.txt` | 1.4 | O2, 6000 refunded of 4000 asked, with `started in <n> ms` on both rows. |
| `15-illustration-ts-kept-nokey-cups.txt` | 1.5 | O1, 2 refund objects, 8000 refunded of 10000. |
| `16-illustration-poly-kept-nokey-cups.txt` | 1.6 | O3, not admitted, with the build's own `AdmitError`. |
| `17-fallback-recorded.txt` | 1.7 | The recorded results. |
| `23-refusals.txt` | 2.3 | Five refusals of the launcher, each exit 2. |
| `24-stub-room-cap-0.01.txt` | 2.4 | The stub room: "where is my order?" is answered on the page (`Your order o-9011 is on file.`), then "hello there"; a `spend:` line follows each reply. |
| `24b-stub-room-stops-at-cap-0.0004.txt` | 2.4 | The cap reached: `spend cap reached ... The room has stopped.`, the page gets `halted`, and the next message is refused with `halted`. |
| `25-recorded-room.txt` | 2.5 | The recorded room with two guests: the five answerable messages are answered on the page; the 250 refund waits for approval; the next message of that guest gets only the acknowledgement; "where is my order?" (not recorded) gets nothing. |
| `26-live-on-placeholder-tables.txt` | 2.6 | A live launch on the committed placeholder tables is refused. |
| `26b-key-form-with-a-dummy.txt` | 2.6, 2.7 | The key form with a dummy secure string: the variable is set, `secure` is gone, no other variable holds the value, and the removal clears it. |
| `31-act3-check.txt` | 3.1 | `17 figures: 17 hold`. |
| `32-act3-live-command.txt` | 3.2 | `PL4003` on `draft-unguarded.poly`, exit 1. |
| `start-times.jsonl` | 0.8 | The raw rows of the start-time measurement; see `../rehearsal-start-times.md`. |

## What was not run

Step 2.6 (the live launch) was not run: it needs the owner's key and spends money. Its path was checked in a test with a fake meter and in a probe: with valid price tables (synthetic, for the probe only) and no key, a live launch with a cap is refused for the missing key, before any model call. The recorded room's approval of the 250 refund was not played.

The presenter's token in the staff panel address is replaced by `<token>` in the files.

## Conclusion

Every free step of the runbook ran in Windows PowerShell 5.1 as the runbook says. Both rooms now answer on the page, and the dry run reads the page, not the HTTP status of the send. The one step that spends money was not run.

## Glossary

- **Dry run:** the free steps of the runbook, run with no key and no network except the local container.
- **Guest:** a browser session of the room; `play-room.mjs` plays one or two.
- **Stub model:** a local program that answers where the model provider would, at no cost.
- **Cap:** the most a launch may spend, set with `--cap-usd`, at most 10 dollars.
