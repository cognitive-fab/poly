# std.channels.whatsapp: provenance

The rules of `std/channels/whatsapp.poly` were taken from the WhatsApp Cloud API documentation, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `window-opens-on-inbound` (step property) | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages | "When a WhatsApp user messages you or calls you, a 24-hour timer called a customer service window starts." |
| `free-form-outside-window` (never) | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages | "When the window closes, you can only send pre-approved template messages." |
| `Inbound` resets the timer (`cancel w`, then `after 24h`) | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages | "If the user messages or calls you again before the timer expires, the timer resets to 24 hours." |

## Constants

| Constant | Source |
|---|---|
| `24h`, the window's length | the first and third rows above |

## poly's own rules

| Rule in the module | Why |
|---|---|
| `one-send-at-a-time` (never) | One send in flight, so a receipt (`Sent`, `SendFailed`) names the send it settles. |
| `waiting: 0..2`, refusal `backlog` | At most two customer messages wait for an answer. A third is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting messages and the send in flight; its bound is the transit bound of the configuration the channel generates (PS15.5). |

## Not checked

- A call from the user also opens the window. The module reads messages only.
- Template approval, template categories and pricing are the provider's; the module does not know a template's name or category, only that a message is a template.
- Calls, reactions, read receipts and status webhooks other than delivered and failed.

## Conclusion

Two provider rules are checked: the window opens only on a customer's message, and no free-form message is sent while it is closed. The window's length is a constant, recorded here and not checked, since poly checks no time. The rest is poly's own bounds.
