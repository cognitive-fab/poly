# std.channels.email: provenance

The rules of `std/channels/email.poly` were taken from RFC 8058 and from Gmail's email sender guidelines, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `no-bulk-after-unsubscribe` (never) | https://www.rfc-editor.org/rfc/rfc8058.html | A one-click unsubscribe is a POST with the body `List-Unsubscribe=One-Click`, announced by the header `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; it unsubscribes the recipient from the list. |
| `no-bulk-after-unsubscribe` (never) | https://support.google.com/a/answer/81126 | Bulk senders must support one-click unsubscribe and honour it. |
| `unsubscribe-holds` (step property) | https://www.rfc-editor.org/rfc/rfc8058.html | An unsubscribe stands; nothing in the protocol subscribes the recipient again. The module has no resubscribe. |
| `no-send-to-suppressed` (never) | https://support.google.com/a/answer/81126 | "Automatically unsubscribe recipients who have multiple bounced messages." |
| `Inbound` with the event `Bounce` (ruled on step 8) | https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads/ | A bounce reported after the send was accepted, Mailgun's event `failed` with severity `permanent`, is the provider event `Bounce` on the recipient's thread (PS15.4), so the suppression counts it at run time. A failure of the SMTP submission itself (a 5yz reply) is the send's `failed` completion, `Bounced`. |

## Constants

| Constant | Source |
|---|---|
| two bounces suppress the address (`bounces: 0..2`) | "multiple bounced messages" in the last row above; two is the least number that is multiple. poly's choice. |

## poly's own rules

| Rule in the module | Why |
|---|---|
| A reply is allowed after an unsubscribe | A reply answers the correspondent's own message, and is not list mail. Suppression still stops it. |
| `one-send-at-a-time` (never) | Nothing is sent while a send is in flight, so a receipt names the send it settles. |
| `Ack` and the slot (ruled after step 7) | One slot holds a send, then its receipt (`Delivered`, `Rejected` or `Failed`), until the application acknowledges the receipt with `Ack`, which the channel's expansion appends to every handler bound to a receipt (PS15.3). With the receipt counted, every message between the application and its conversation stays within `pending`'s bound. |
| `queued: 0..2`, `queue1`, `queue2` (ruled on step 8) | A reply that answers a waiting message, while the slot is held, waits in the queue, in order, and takes the slot when `Ack` frees it, under the rules as they stand then. A template, or a reply that answers no waiting message, is refused `busy` while the slot is held, and the generated configuration reports that as `PL5407` wherever it is reachable (PS15.5). The invariant `queue-while-held` says a queue exists only while the slot is held. |
| `waiting: 0..2`, refusal `backlog` | At most two messages wait, for an answer or in the queue. A third is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting and queued messages and the held slot (a send or its unacknowledged receipt); its bound is the transit bound of the configuration the channel generates (PS15.5). |

## Not checked

- The headers themselves: the adapter writes `List-Unsubscribe` and `List-Unsubscribe-Post` on a bulk send, and verifies the one-click POST.
- Authentication (SPF, DKIM, DMARC), spam rates and volume limits.
- Soft bounces: only a permanent failure counts as a bounce, at submission or reported later by Mailgun.

## Conclusion

Three provider rules are checked: no bulk mail after a one-click unsubscribe, the unsubscribe stands, and nothing is sent to an address after two bounces. The number two is poly's reading of "multiple".
