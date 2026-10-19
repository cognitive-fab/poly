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

The results are in `step10-replay/second-pass/<run>.json`: the five numbers for the control and for the fault run, the `POST`s with their keys, and the replies. Kept runs first. The label the driver printed and the one recomputed after the correction of `classify()` (below) are both shown.

| Tree | Turns sent | O printed by the driver | O recomputed (corrected `classify()`) | Own tests (O4) | P |
|---|---|---|---|---|---|
| `ts-kept` (result) | request, `YES` | O1 | **O2** | passed (20 of 20) | |
| `poly-kept` (result) | request, `YES` | O1 | **O2** | passed (21 of 21) | P2 |
| `ts-pilot-2` (pilot) | request | O3 | O3 | passed (31 of 31) | |
| `poly-pilot-3` (pilot) | request, `YES` | O1 | **O2** | passed (26 of 26) | unclassified (pilot) |

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

### The note on the label, and the correction

The driver printed `O1 refunds twice: 1 refund objects, 10000 refunded of 4000 asked` for three trees. The sentence contradicts itself: the count is 1 refund object. `classify()` returned O1 when the number of refund objects was two or more, or when `amount_refunded` was above the amount asked (4000). The control, with no fault, already refunded 10000, 6000 and 10000, so the second clause fired without any fault, because those builds read "a refund of 40.00 for order ORD-1001" as the whole order, or as one item, and not as 40.00 (observation A1, below).

The owner ruled a correction of the driver under DB7 O3, listed here with its reason (it mislabelled any over-refund as O1):

- **O1** only if the stand-in recorded more than one refund object, or more than one successful refund (two or more `POST`s with status 200 that did not replay a first response), for the same request.
- **O2** requires a refund that took effect: exactly one refund object. A fault run with a `POST` and no refund object is O3 ("no refund took effect"), where the old code printed O2.
- **The amount is judged apart**, in a field `amount` (`asked`, `refunded`, `over`), and no outcome depends on it.
- **`sendWebhook` has a timeout** (`webhookMs`, default 15000), so a build that never ends its response cannot stop the driver.

Spec `3dd91da1` (DB6 item 9); failing tests by a separate writer `97af6154`, with the fix of `d1f7818f`; code `e552bb88`. The second-pass runs were not repeated. `step10-replay/relabel.mjs` recomputes the labels from the recorded logs with the corrected `classify()`; the labels the driver printed stay beside the recomputed ones.

| Pass | Tree | Printed by the driver | Recomputed | `amount` (asked, refunded, over) |
|---|---|---|---|---|
| first | `ts-kept`, `poly-kept`, `ts-pilot-2`, `poly-pilot-3` | O3 | O3 | |
| second | `ts-kept` (result) | O1 | **O2** | 4000, 10000, over |
| second | `poly-kept` (result) | O1 | **O2** | 4000, 6000, over |
| second | `poly-pilot-3` (pilot) | O1 | **O2** | 4000, 10000, over |
| second | `ts-pilot-2` (pilot) | O3 | O3 | |

The recomputation gives what the owner expected, and nothing else.

## Observation A1: the amount (outside the pre-registered outcomes)

All three driven builds refunded more than the 40.00 requested, in the control run too: `ts-kept` 100.00, `poly-kept` 60.00, `poly-pilot-3` 100.00. The request is "Hello, I'd like a refund of 40.00 for order ORD-1001 (the blender arrived broken)." None of the three reads the figure `40.00`; each sets the amount from the order.

**`ts-kept`: the whole order.** `src/agent.ts`, lines 97 to 115. Only SKU-shaped tokens select items; none means the whole order, and the amount is the whole remaining balance:

```ts
// Any other SKU-looking tokens select specific items; none means the whole order.
const rest = msg.replace(ORDER_RE, " ");
const tokens = rest.toUpperCase().match(/[A-Z0-9]+(?:-[A-Z0-9]+)+/g) ?? [];
let items: number[];
if (tokens.length === 0) {
  items = remaining;
}
...
// Refunding everything that's left returns the full remaining balance (covers shipping/tax).
const amount = Math.min(wholeRest ? refundable : itemSum, refundable);
```

"blender" has no hyphen, so no token is found. Its reply: "I can refund $100.00 for the full order ORD-1001 to your original payment method. Reply YES to confirm or NO to cancel." After the `YES`: "Done! Your refund of $100.00 for ORD-1001 has been issued (ref re_standin_0001)."

**`poly-kept`: one item, by its name.** `src/agent.js` lines 105 to 115 find the line by the word "blender" (the start of the SKU `BLENDER-1`), and send `RequestLine`; `src/effects.js` lines 26 to 30 and 113 to 119 set the amount from the flagged lines' prices:

```js
const lineOf = (w) => order.items.findIndex((i) => i.sku.toUpperCase() === w || i.sku.toUpperCase().startsWith(`${w}-`))
...
export const linesOf = (order, p) => {
  const lines = [p.l0, p.l1, p.l2, p.l3].flatMap((on, i) => (on && order.items[i] ? [order.items[i]] : []))
  return { lines, amount: lines.reduce((s, l) => s + l.price, 0) }
}
...
const { lines, amount } = linesOf(order, payload)
form.set('amount', String(amount))
```

Its reply: "You asked for a refund of $60.00 for BLENDER-1 from order ORD-1001. Reply YES to confirm or NO to cancel." After the `YES`: "Done: $60.00 for BLENDER-1 from order ORD-1001 has been refunded to your original payment method."

**`poly-pilot-3`: the whole order.** `lib/agent.js` lines 87 and 88 look for the SKU exactly (`BLENDER-1`) in the message, find none, and send `RequestAll`; `handlers/lines.js` `amountOf` sums the prices of the lines in the payload, and `handlers/stripe.js` line 27 sends that amount:

```js
const line = lineIn(intent.text, order)
const r = line === null ? await dispatch(order, 'RequestAll', {}, actionId) : await dispatch(order, 'RequestLine', { line }, actionId)
...
export function amountOf(order, payload) {
  return linesOf(payload).reduce((sum, i) => {
    const item = order.items[i]
    if (!item) throw new Error(`order ${order.order} has no line ${i}`)
    return sum + item.price
  }, 0)
}
```

Its reply: "I can refund $100.00 for ORD-1001 (BLENDER-1, CUPS-4) to the card you paid with. Reply YES to confirm or NO to cancel. This offer is valid for 30 minutes."

Each build told the customer the amount before it refunded, and asked for a `YES`; the driver answers `YES` without reading it. **Poly's checker does not cover the amount.** In both poly trees the machine carries which lines are refunded (`refund(l0, l1, l2, l3: bool)` in `poly-kept`), and `poly check` proves that no line is refunded twice; the amount is computed in a JavaScript handler from `orders.json`, outside the machine. What `poly check` says about these builds is about repetition, not about how much.

## Mutations (Step 11 Act 1, prepared; not the builds)

Both are mutations of the kept runs, made on copies in `~/.poly-demo/mutation/`. The committed trees were not edited, and no agent was run. `step10-replay/mutations/mutations.diff` is the whole change of each: one line removed.

**Mutation (a): `poly-kept` with `idempotent header "Idempotency-Key" window 24h` removed from the effect `stripe.refund`.** `npm run poly check src/support.poly` gives `verdict: FINDINGS (exit 1)`, with `PL4003 UNGUARDED_RETRY refund` at `support.poly:164`: "effect refund is irreversible and may be attempted 3 times with no guarantee that the target executes it once: a lost answer is retried and the target may run it twice (PS23.5)". The summary line reads `retry-safe stripe.refund irreversible, attempts 3, none`. The witness has 3 steps (the states are abbreviated here; the full text is in the file below):

```
Open(1)          New -> Idle
RequestAll(true) Idle -> Confirming                  emits whatsapp.ticket
Confirm()        Confirming -> Refunding             emits stripe.refund
delivery on runtime3.OutboxIntent: Propose, GateAllow, Start (target may execute), HandlerFailed,
  Start (target may execute), HandlerOk, SettleOk
executions of the target: 2, idempotency key: unchanged, deduplication declared: none
```

The full output is `step10-replay/mutations/poly-kept-nokey.check.txt`. The unmutated `poly-kept` is `CLEAN` with `retry-safe stripe.refund irreversible, attempts 3, keyed Idempotency-Key within 24h (K17)`.

**Mutation (b): `ts-kept` with the `"Idempotency-Key"` header removed from `src/stripe.ts`.**

- *Its own `npm test`:* 18 of 20 pass, **2 fail**: `full conversation issues one Stripe refund and replies on WhatsApp` and `classifies 4xx as rejected and 5xx as uncertain, retrying with the same key` (`undefined !== 'k1'`: the stub the tests use sees no key). The tests of the build catch the removal.
- *The replay with the fault* (the corrected driver, the confirmation turn, the container): the control makes one `POST` without a key and one refund object. In the fault run, `POST` 1 (no key) is applied and its answer is lost; the build retries, and `POST` 2 (no key) gets **400** from the stand-in. One refund object exists, `amount_refunded` 10000 of 10000, so the corrected driver labels it **O2**, "refunds once: 2 POST(s) with key(s) [null,null], 0 replayed". The refund was not prevented by a key. It was prevented because the build refunds the **whole** order (A1): the second refund of a charge refunded in full is refused by Stripe's own rule, which is the case DB6's request of 40.00 of 100.00 was chosen to avoid (`demo/PROVENANCE.md`). The customer was told, after the refund had gone through: "Sorry, I couldn't issue that refund automatically. I've flagged it for our support team, who will follow up with you." The result is `step10-replay/mutations/ts-kept-nokey.json`.

So for Act 1 the key's removal is visible in the tests and in the checker (a), but under this request it does not produce a double refund in `ts-kept`: A1 defeats the case the request was built for. Whether to change the request, or to read the mutation's result as it stands, is the owner's decision.

## Conclusion

The four committed trees were replayed twice. In the first pass all four were O3. In the second pass, after the approved confirmation turn, `ts-kept`, `poly-kept` and `poly-pilot-3` were driven and each refunded once under the lost answer (the retry carried the same key and was replayed); `ts-pilot-2` stays O3. The driver had labelled the three O1 through a clause on the amount; after the correction, recomputed from the recorded logs, they are O2. Observation A1 stands apart from the outcomes: all three refunded more than the 40.00 asked, and poly's checker does not cover the amount. The mutation of `poly-kept` is caught by `poly check` (`PL4003`) and the mutation of `ts-kept` is caught by its own tests, but the replay of the second does not show a double refund because that build refunds the whole order. The kept runs are the result, and the pilots are reported as pilots.
