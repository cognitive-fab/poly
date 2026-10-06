# std.channels.whatsapp: provenance

The rules of `std/channels/whatsapp.poly` were taken from the WhatsApp Cloud API documentation, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `window-opens-on-inbound` (step property) | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages | "When a WhatsApp user messages you or calls you, a 24-hour timer called a customer service window starts." |
| `free-form-outside-window` (never) | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages | "When the window closes, you can only send pre-approved template messages." |
| `message-always-opens-window` (reject property, review B-F3) | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages | "When a WhatsApp user messages you or calls you, a 24-hour timer called a customer service window starts." Every message does, so the module's backlog never refuses one that finds the window closed; only its message to the application is dropped when two already wait. Such a message opens a closed window; an open one it leaves as it is, refused `backlog` (a step that only re-armed the timer would be `PL4002`), so the module's window closes no later than the provider's: a limit on the safe side, which can refuse a free-form reply the provider would take. |
| `Inbound` resets the timer (`cancel w`, then `after 24h`) | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages | "If the user messages or calls you again before the timer expires, the timer resets to 24 hours." |

## Constants

| Constant | Source |
|---|---|
| `24h`, the window's length | the first and third rows above |

## poly's own rules

| Rule in the module | Why |
|---|---|
| `one-send-at-a-time` (never) | Nothing is sent while a send is in flight (`while slot is Sending`), so a receipt names the send it settles. Reworded on step 8 from `while !(slot is Free)`: a queued reply leaves on the step that acknowledges the previous receipt, while the slot still reads `Receipt`. |
| `Ack` and the slot (ruled after step 7) | One slot holds a send, then its receipt (`Delivered`, `Rejected` or `Failed`), until the application acknowledges the receipt with `Ack`, which the channel's expansion appends to every handler bound to a receipt (PS15.3). With the receipt counted, every message between the application and its conversation stays within `pending`'s bound. |
| `queued: 0..2`, `queue1`, `queue2` (ruled on step 8) | A reply that answers a waiting message, while the slot is held, waits in the queue, in order, and takes the slot when `Ack` frees it, under the rules as they stand then. A template, or a reply that answers no waiting message, is refused `busy` while the slot is held, and the generated configuration reports that as `PL5407` wherever it is reachable (PS15.5). The invariant `queue-while-held` says a queue exists only while the slot is held. |
| `queue-shifts-in-order`, `queue-appends-first`, `queue-appends-second` (step properties, review B-F4) | The queue keeps the order the replies were given in: a reply that finds the queue empty is its first, one that finds one reply queued is its second, and the first leaves first. |
| `claims Sender { verified: Verification }` on `Inbound` (plan step 10) | K11, PT21.4: the adapter's sender claims travel in the `Inbound` step's label, and by lineage in every step it causes (AC14). A provider event's are `Verified`. |
| `waiting: 0..2`, refusal `backlog` | At most two customer messages wait, for an answer or in the queue. A third opens a closed window and is not passed to the application (review B-F3); with the window open it is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting and queued messages and the held slot (a send or its unacknowledged receipt); its bound is the transit bound of the configuration the channel generates (PS15.5). |

## Not checked

- **A limit, on the safe side (review B-F3, accepted).** A message that finds the backlog full while the window is open is refused `backlog` and does not reset the module's 24-hour timer, so the module's window can close before WhatsApp's. The module may then refuse a free-form reply WhatsApp would take; it never sends one WhatsApp would refuse.
- A call from the user also opens the window. The module reads messages only.
- Template approval, template categories and pricing are the provider's; the module does not know a template's name or category, only that a message is a template.
- Calls, reactions, read receipts and status webhooks other than delivered and failed.

## Conclusion

Two provider rules are checked: the window opens only on a customer's message, and no free-form message is sent while it is closed. The window's length is a constant, recorded here and not checked, since poly checks no time. The rest is poly's own bounds.
