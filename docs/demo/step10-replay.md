# Step 10: the replay of the four committed trees

This note records the replay of `ts-kept` and `poly-kept` (the result) and of `ts-pilot-2` and `poly-pilot-3` (pilots, reported separately) in the offline container against the Stripe stand-in, as DB6 and DB7 pre-register it. It has two passes. The first pass is kept as it was. The second pass follows the one change of the driver that the owner approved. No committed tree was edited in either.

## What was run

- **The trees.** Each committed tree was laid over the scaffold of its arm (`.harness`, the declared toolchain) in a folder outside the repository, with an offline `npm install --no-package-lock`. `step10-replay/assemble.mjs` does it. For each tree the files of the replay folder (without `node_modules`, `.harness` and `.git`) have the tree digest that the tree's `RECORD.json` records, so the build under test is the committed tree byte for byte.
- **The container.** `demo/container/docker-compose.yml` as committed: no network, a read-only root, a temporary `/tmp`, the build mounted read-only, the two names mapped to the container's loopback.
- **The start.** The command each README gives, run in a fresh copy of the build in `/tmp` (the builds write their state beside themselves, and the mount is read-only): `npm start` for `ts-pilot-2` and `ts-kept`, `npm run keygen && npm run admit && npm start` for `poly-pilot-3`, `node src/main.js` for `poly-kept`. The environment is the driver's synthetic one. The request is the pre-registered one: a customer asks for 40.00 of the 100.00 order `ORD-1001`.
- **The tests.** `npm test`, unmodified, in a fresh copy.

## The pins, and the image

- **What the pre-registration pins.** `PREREGISTRATION.json` (commit `c862a6f0`, 2026-10-16) and the two amendments pin the prompt, the arm texts, the model, the agent, the caps, the tool lists, the hook, the guard, the scaffolds and the reference. They do not pin a replay image digest, the stand-in or the driver. The committed `Dockerfile` pins the base image by digest (`node:24-slim@sha256:a5f4366e…`), and the compose file names the tag `poly-demo-replay:step8`.
- **What changed the stand-in after the image of 2026-10-15.** The image `aa925935066e` was built at 2026-10-15 06:45 (PDT). The stand-in was changed by `7bf769ab` (step 8, 05:44) and `2cb61de5` (step 9, 07:31, the Connect side). The second came after the image. Both are before `c862a6f0`. No commit under `demo/stand-in`, `demo/container` or `demo/demo.mjs`, and none that touches `demo/baseline/orders.json`, is later than it. Under `demo/driver` the only later commit is the driver change of the second pass (below).
- **So nothing pinned has changed, and no deviation is recorded for the image.** The first pass used an image rebuilt from the repository (`f0e7941557dc`, kept as `poly-demo-replay:step8-first-pass`), because the image of 2026-10-15 carried a stand-in older than the committed one. The second pass used an image rebuilt after the driver change (`5f9ae2754821`). The image of 2026-10-15 is kept as `poly-demo-replay:step8-built-2026-10-15`.
- **The one change after `c862a6f0`** is the driver change of the second pass (below), approved by the owner and allowed by DB7 O3. The stand-in was not changed after `c862a6f0`.

## First pass (as it was)

The driver sent one message. The results are in `step10-replay/<run>.json`.

| Tree | Stand-in valid | Control: POSTs, refunds | Customer's reply to the request | O | Its own tests (O4) |
|---|---|---|---|---|---|
| `ts-kept` (result) | yes | 0, 0 | "I can refund $100.00 for the full order ORD-1001 to your original payment method. Reply YES to confirm or NO to cancel." | O3 | passed (20 of 20) |
| `poly-kept` (result) | yes | 0, 0 | "You asked for a refund of $60.00 for BLENDER-1 from order ORD-1001. Reply YES to confirm or NO to cancel." | O3 | passed (21 of 21) |
| `ts-pilot-2` (pilot) | yes | 0, 0 | "ORD-1001 has no item "(THE". Items: BLENDER-1, CUPS-4." | O3 | passed (31 of 31) |
| `poly-pilot-3` (pilot) | yes | 0, 0 | "I can refund $100.00 for ORD-1001 (BLENDER-1, CUPS-4) to the card you paid with. Reply YES to confirm or NO to cancel. This offer is valid for 30 minutes." | O3 | passed (26 of 26) |

All four started, listened and answered. None made a `POST /v1/refunds` in the control, so the control (DB6 item 4) was not met, and the fault was never applied. Three builds answer the request by asking for a confirmation and wait for a second message; `ts-pilot-2` misreads the sentence, since it takes "(the blender arrived broken)" for an item name.

## The rule, and where it is committed

DB7 O3 allows a change to the driver after an O3, with its reason. The owner approved one: after the build's first reply, if that reply contains `YES` (case-sensitive, as a whole word) or `confirm` (case-insensitive), the driver sends exactly one further message, the text `YES`, from the same customer (message id `wamid.DEMO.2`), and sends nothing else, ever. It applies to all four trees alike, and it is not widened to drive `ts-pilot-2`. The fault, the first refund `POST` applied and its answer lost, is injected as before, on the first refund request, which is the first one after the `YES`.

- Spec: `e5a86c62` (DB6 item 8).
- Failing tests, by a separate writer: `d9d2bbae` and the fixes of `a56a6471`.
- Code: `69e8d95f` (`needsConfirmation`, `turns`, the second webhook, `settleAfter`).
- All of it was committed before the second pass was run.

## Second pass

The results are in `step10-replay/second-pass/<run>.json`: the five numbers for the control and for the fault run, the `POST`s with their keys, and the replies. Kept runs first.

| Tree | Turns sent | O (the driver's label) | Own tests (O4) | P |
|---|---|---|---|---|
| `ts-kept` (result) | request, `YES` | O1 (see the note on the label) | passed (20 of 20) | |
| `poly-kept` (result) | request, `YES` | O1 (see the note on the label) | passed (21 of 21) | P2 |
| `ts-pilot-2` (pilot) | request | O3, as in the first pass | passed (31 of 31) | |
| `poly-pilot-3` (pilot) | request, `YES` | O1 (see the note on the label) | passed (26 of 26) | unclassified (pilot) |

The P outcomes are read from the sessions and are the same as in the first pass: `poly-kept` is P2 (its first check of `src/support.poly` was `CLEAN` with `retry-safe stripe.refund … keyed Idempotency-Key within 24h` declared). `poly-pilot-3` is unclassified (pilot): its check sequence was `REFUSED` (`PL0001 SYNTAX`), then out of memory, then `FINDINGS` (`PL4002 EMIT_WITHOUT_STATE_CHANGE` on `RequestAll` and `RequestLine`), then `CLEAN` (158 states) with the same `retry-safe stripe.refund` line. No P1 to P4 row describes it.

### The evidence, tree by tree

Every drive started a fresh process of the build. A refund is counted by the refund objects that the stand-in made. The stand-in's log is the list of `POST /v1/refunds` that it received, with the key each carried and whether it replayed a first response.

| Tree | Control (no fault) | Fault: the first refund `POST` is applied and its answer lost | Refund objects | `amount_refunded` of the charge |
|---|---|---|---|---|
| `ts-kept` | 1 `POST`, key `refund-ORD-1001-b0b658ac-…`, 200 | `POST` 1 key `refund-ORD-1001-f1d90487-…`, applied, connection reset; `POST` 2 the same key, 200, **replayed** | 1 | 10000 of 10000 (full order, asked 4000) |
| `poly-kept` | 1 `POST`, key `0b9be09c…`, 200 | `POST` 1 key `0b9be09c…`, applied, reset; `POST` 2 the same key, 200, **replayed** | 1 | 6000 of 10000 (BLENDER-1, asked 4000) |
| `poly-pilot-3` | 1 `POST`, key `85a4ae5c…`, 200 | `POST` 1 key `85a4ae5c…`, applied, reset; `POST` 2 the same key, 200, **replayed** | 1 | 10000 of 10000 (full order, asked 4000) |
| `ts-pilot-2` | 0 `POST` (its reply: `ORD-1001 has no item "(THE"`) | not run | 0 | 0 |

**Verdict on the recorded timeout.** `ts-kept`, `poly-kept` and `poly-pilot-3` each refund once. The first `POST` was applied and its answer lost; the retry carried the same idempotency key, the stand-in replayed the first response, and one refund object exists. `ts-pilot-2` refunds not at all, because it was never driven past the first reply.

### The note on the label

The driver prints `O1 refunds twice: 1 refund objects, 10000 refunded of 4000 asked` for three trees. The sentence contradicts itself: the count is 1 refund object. The driver's `classify()` returns O1 when a refund object count is two or more, or when `amount_refunded` is above the amount asked (4000). The control, with no fault, already refunded 10000, 6000 and 10000, so the second clause fires without any fault, because those builds read "a refund of 40.00 for order ORD-1001" as the whole order, or as one item, and not as 40.00. By the definitions of DB7 these are **O2** (a refund once, a stable key, the retry replayed), and the evidence above says so. The label was left as the driver printed it, because changing the classifier is a second change of the driver and needs the owner's ruling. A separate finding: all three builds refunded more than the 40.00 asked, in the control as well.

Two other facts in the driver were reported by review and are not changed: `classify()` has no branch for a fault run with a `POST` and no refund object (it would print O2), and `sendWebhook` has no timeout. Neither occurred here.

## Conclusion

The four committed trees were replayed twice. In the first pass all four were O3. In the second pass, after the approved confirmation turn, three of them (`ts-kept` and `poly-kept`, the result, and the pilot `poly-pilot-3`) were driven: under the lost answer each made one `POST`, retried it with the same key, was replayed, and refunded once; `ts-pilot-2` stays O3. The driver labelled the three O1 because of a clause on the amount, and the evidence reads O2. The kept runs are the result, and the pilots are reported as pilots.
