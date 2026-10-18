# Step 10: the replay of the four committed trees, first pass

This note records the replay of `ts-pilot-2`, `poly-pilot-3`, `ts-kept` and `poly-kept` in the offline container against the Stripe stand-in, as DB6 and DB7 pre-register it. The kept runs are the result. The pilots are reported separately as pilots. No committed tree was edited, and the driver and the stand-in were not changed.

## What was run

- **The trees.** Each committed tree was laid over the scaffold of its arm (`.harness`, the declared toolchain) in a folder outside the repository, with an offline `npm install --no-package-lock`. `step10-replay/assemble.mjs` does it. For each tree the files of the replay folder (without `node_modules`, `.harness` and `.git`) have the tree digest that the tree's `RECORD.json` records, so the build under test is the committed tree byte for byte.
- **The container.** `demo/container/docker-compose.yml` as committed: no network, a read-only root, a temporary `/tmp`, the build mounted read-only, the two names mapped to the container's loopback. The image was rebuilt from the repository (`poly-demo-replay:step8`, id `f0e7941557dc`, from the pinned `node:24-slim`), because the stand-in changed after the image of 2026-10-15 was made (step 9, Connect side). The old image is kept as `poly-demo-replay:step8-built-2026-10-15`.
- **The start.** The command each README gives, run in a fresh copy of the build in `/tmp` (the builds write their state beside themselves, and the mount is read-only): `npm start` for `ts-pilot-2` and `ts-kept`, `npm run keygen && npm run admit && npm start` for `poly-pilot-3`, `node src/main.js` for `poly-kept`. The environment is the driver's synthetic one. The request is the pre-registered one: a customer asks for 40.00 of the 100.00 order `ORD-1001`.
- **The tests.** `npm test`, unmodified, in a fresh copy.

The results are in `step10-replay/<run>.json`, as the driver prints them with `--json`.

## Outcomes

| Tree | Stand-in valid | Control: POSTs, refunds | Customer's reply to the request | O | Its own tests (O4) |
|---|---|---|---|---|---|
| `ts-kept` (result) | yes | 0, 0 | "I can refund $100.00 for the full order ORD-1001 to your original payment method. Reply YES to confirm or NO to cancel." | O3 | passed (20 of 20) |
| `poly-kept` (result) | yes | 0, 0 | "You asked for a refund of $60.00 for BLENDER-1 from order ORD-1001. Reply YES to confirm or NO to cancel." | O3 | passed (21 of 21) |
| `ts-pilot-2` (pilot) | yes | 0, 0 | "ORD-1001 has no item "(THE". Items: BLENDER-1, CUPS-4." | O3 | passed (31 of 31) |
| `poly-pilot-3` (pilot) | yes | 0, 0 | "I can refund $100.00 for ORD-1001 (BLENDER-1, CUPS-4) to the card you paid with. Reply YES to confirm or NO to cancel. This offer is valid for 30 minutes." | O3 | passed (26 of 26) |

All four started, listened and answered. None made a `POST /v1/refunds` in the control, so the control (DB6 item 4) was not met for any of them, and the fault was never applied: no Stripe request reached the stand-in from any tree. For the recorded timeout the verdict of each tree is therefore the same: no refund was made, once or twice, and no verdict on a lost answer can be read from this run. The builds' own code is not evidence here; this note makes no claim about it.

## The poly outcomes (P1 to P4)

Read from the sessions, for the program `src/support.poly` of each tree:

- **`poly-kept`: P2.** Its first check was `CLEAN`, with the guarantee already declared: `retry-safe stripe.refund irreversible, attempts 3, keyed Idempotency-Key within 24h (K17)`.
- **`poly-pilot-3`: none of P1 to P4 as they are written.** Its first check was `REFUSED` (`PL0001 SYNTAX`). A later check ran out of memory (the price ranges made the explored instance too large), a later one gave `FINDINGS` (`PL4002 EMIT_WITHOUT_STATE_CHANGE`), and the last gave `CLEAN` with the same `retry-safe stripe.refund` line. It reached `CLEAN`, so it is not P3, and no person's acceptance was involved, so it is not P4. The first check was neither `FINDINGS PL4003` nor `CLEAN`, so it is not P1 or P2. The table has no row for it.

## Why all four are O3, and what DB7 allows

The driver sends one message and then reads the stand-in. Three builds answer that message by asking for a confirmation (`Reply YES to confirm`) and wait for a second message before they issue the refund. The fourth, `ts-pilot-2`, misreads the sentence, since it takes "(the blender arrived broken)" for an item name. DB6 item 4 calls a build that does not make the one `POST` "could not be driven", and DB7 O3 says that the only change allowed afterwards is to the driver or the stand-in, never to the build, and that each such change is listed with its reason.

No change was made. The one that would let three of the four be driven is a second turn in the driver: when the customer-visible reply asks for a confirmation, answer `YES` once, then read the numbers as before. It needs spec text, failing tests and a listing here. It would not change `ts-pilot-2`, whose reply names no confirmation; that tree stays O3 for the request as it is pre-registered. Whether to make it is the owner's decision.

## Conclusion

The four committed trees were replayed as pre-registered and every one is O3: each started, passed its own tests, and answered the request, and none issued a refund, because three ask for a confirmation the driver does not give and one misreads the request. No tree was exposed to the recorded timeout, so no double-refund verdict exists yet. The kept runs `ts-kept` and `poly-kept` are the result, and `ts-pilot-2` and `poly-pilot-3` are reported as pilots. A driver change is allowed by DB7 and waits for the owner.
