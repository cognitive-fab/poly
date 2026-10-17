# std.channels.webhook: provenance

The rules of `std/channels/webhook.poly` were taken from the Standard Webhooks specification, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `no-delivery-while-disabled` (never) | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md | "In some cases, webhook delivery may fail consistently over a long period of time. In that scenario it is important to both: notify the consumers using other channels (e.g. email), and is recommended to disable future delivery to the endpoint." |
| `disabled-only-after-failures` (step property) | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md | The same passage: the endpoint is disabled because its deliveries fail consistently, and for no other reason. |
| `Sent` and `Undelivered`, the send's completions, which reach the conversation at run time (PS15.4) | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md | "A webhook delivery is considered successful if it was responded to with a `2xx` status code (status codes 200-299), and it is considered a failure in any other scenario." |
| `retry` on the effect `send` | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md | "retry delivery following a retry schedule spanning multiple days, with an exponential backoff." Its example schedule has ten attempts, the first retry after 5 seconds. "A recommended request timeout value for webhooks is somewhere between 15 and 30s." The module does not follow the schedule since 221b5840 (Q1): a delivery is sent once, because a repeated delivery may reach the receiver twice and the module does not say that the receiver deduplicates on the webhook-id. The schedule stays here as the provider's rule, not checked, for a later release that keys the delivery. |

## Constants

| Constant | Source |
|---|---|
| `500ms` and `30s`, the base and the timeout in `retry { attempts 1, base 500ms, timeout 30s }` | poly's own (221b5840, PS23.4 G1): the send is at most once, so no retry follows a lost answer and the base is never waited. Both are the runtime's defaults, written out, so only the bound changed. |
| three failed deliveries in a row disable the endpoint (`failures: 0..3`) | "fail consistently" is not a number in the source; three is poly's choice, each failure already after its single attempt (221b5840) |

## poly's own rules

| Rule in the module | Why |
|---|---|
| `Enable` | An operator enables the endpoint again; the source says to notify the consumer, and leaves re-enabling to the provider. |
| invariant `disabled-at-three` | The endpoint is disabled exactly when three deliveries in a row have failed. |
| `one-send-at-a-time` (never) | Nothing is sent while a send is in flight (`while slot is Sending`), so a receipt names the send it settles. Reworded on step 8 from `while !(slot is Free)`: a queued reply leaves on the step that acknowledges the previous receipt, while the slot still reads `Receipt`. |
| `Ack` and the slot (ruled after step 7) | One slot holds a send, then its receipt (`Delivered`, `Rejected` or `Failed`), until the application acknowledges the receipt with `Ack`, which the channel's expansion appends to every handler bound to a receipt (PS15.3). With the receipt counted, every message between the application and its conversation stays within `pending`'s bound. |
| `queued: 0..2`, `queue1`, `queue2` (ruled on step 8) | A reply that answers a waiting message, while the slot is held, waits in the queue, in order, and takes the slot when `Ack` frees it, under the rules as they stand then. A template, or a reply that answers no waiting message, is refused `busy` while the slot is held, and the generated configuration reports that as `PL5407` wherever it is reachable (PS15.5). The invariant `queue-while-held` says a queue exists only while the slot is held. |
| `queue-shifts-in-order`, `queue-appends-first`, `queue-appends-second` (step properties, review B-F4) | The queue keeps the order the replies were given in: a reply that finds the queue empty is its first, one that finds one reply queued is its second, and the first leaves first. |
| `claims Sender { verified: Verification }` on `Inbound` (plan step 10) | K11, PT21.4: the adapter's sender claims travel in the `Inbound` step's label, and by lineage in every step it causes (AC14). A provider event's are `Verified`. |
| `waiting: 0..2`, refusal `backlog` | At most two inbound webhooks wait, for an answer or in the queue. A third is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting and queued webhooks and the held slot (a send or its unacknowledged receipt); its bound is the transit bound of the configuration the channel generates (PS15.5). |

## Not checked

- Signatures: the adapter verifies `webhook-id`, `webhook-timestamp` and `webhook-signature` (HMAC-SHA256 over the id, the timestamp and the body) on an inbound webhook and writes them on an outbound one.
- Jitter on retries, and the notice to the consumer through another channel when the endpoint is disabled.

## Conclusion

Two provider rules are checked: nothing is delivered to a disabled endpoint, and an endpoint is disabled only after consistent failure. The retry bound and the failure count are constants, recorded here with what in the source they come from and where poly chose.
