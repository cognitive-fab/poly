# std.channels.webhook: provenance

The rules of `std/channels/webhook.poly` were taken from the Standard Webhooks specification, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `no-delivery-while-disabled` (never) | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md | "In some cases, webhook delivery may fail consistently over a long period of time. In that scenario it is important to both: notify the consumers using other channels (e.g. email), and is recommended to disable future delivery to the endpoint." |
| `disabled-only-after-failures` (step property) | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md | The same passage: the endpoint is disabled because its deliveries fail consistently, and for no other reason. |
| `Sent` and `Undelivered` | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md | "A webhook delivery is considered successful if it was responded to with a `2xx` status code (status codes 200-299), and it is considered a failure in any other scenario." |
| `retry` on the effect `send` | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md | "retry delivery following a retry schedule spanning multiple days, with an exponential backoff." Its example schedule has ten attempts, the first retry after 5 seconds. "A recommended request timeout value for webhooks is somewhere between 15 and 30s." |

## Constants

| Constant | Source |
|---|---|
| `attempts 10` | the ten attempts of the example schedule |
| `5s`, the base of the backoff | the first retry of the example schedule; polyrun's backoff doubles it, which approximates the schedule and does not reproduce it |
| `15s`, the timeout of an attempt | the low end of the recommended 15 to 30 seconds |
| three failed deliveries in a row disable the endpoint (`failures: 0..3`) | "fail consistently" is not a number in the source; three is poly's choice, each failure already after its ten attempts |

## poly's own rules

| Rule in the module | Why |
|---|---|
| `Enable` | An operator enables the endpoint again; the source says to notify the consumer, and leaves re-enabling to the provider. |
| invariant `disabled-at-three` | The endpoint is disabled exactly when three deliveries in a row have failed. |
| `one-send-at-a-time` (never) | Nothing is sent while the slot holds a send or its receipt, so a receipt names the send it settles. |
| `Ack` and the slot (ruled after step 7) | One slot holds a send, then its receipt (`Delivered`, `Rejected` or `Failed`), until the application acknowledges the receipt with `Ack`, which the channel's expansion appends to every handler bound to a receipt (PS15.3). A reply or a template while the slot is held is a rejected step, `busy`, journaled. With the receipt counted, every message between the application and its conversation stays within `pending`'s bound. |
| `waiting: 0..2`, refusal `backlog` | At most two inbound webhooks wait for an answer. A third is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting webhooks and the held slot (a send or its unacknowledged receipt); its bound is the transit bound of the configuration the channel generates (PS15.5). |

## Not checked

- Signatures: the adapter verifies `webhook-id`, `webhook-timestamp` and `webhook-signature` (HMAC-SHA256 over the id, the timestamp and the body) on an inbound webhook and writes them on an outbound one.
- Jitter on retries, and the notice to the consumer through another channel when the endpoint is disabled.

## Conclusion

Two provider rules are checked: nothing is delivered to a disabled endpoint, and an endpoint is disabled only after consistent failure. The retry bound and the failure count are constants, recorded here with what in the source they come from and where poly chose.
