# std.channels.email: provenance

The rules of `std/channels/email.poly` were taken from RFC 8058 and from Gmail's email sender guidelines, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `no-bulk-after-unsubscribe` (never) | https://www.rfc-editor.org/rfc/rfc8058.html | A one-click unsubscribe is a POST with the body `List-Unsubscribe=One-Click`, announced by the header `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; it unsubscribes the recipient from the list. |
| `no-bulk-after-unsubscribe` (never) | https://support.google.com/a/answer/81126 | Bulk senders must support one-click unsubscribe and honour it. |
| `unsubscribe-holds` (step property) | https://www.rfc-editor.org/rfc/rfc8058.html | An unsubscribe stands; nothing in the protocol subscribes the recipient again. The module has no resubscribe. |
| `no-send-to-suppressed` (never) | https://support.google.com/a/answer/81126 | "Automatically unsubscribe recipients who have multiple bounced messages." |

## Constants

| Constant | Source |
|---|---|
| two bounces suppress the address (`bounces: 0..2`) | "multiple bounced messages" in the last row above; two is the least number that is multiple. poly's choice. |

## poly's own rules

| Rule in the module | Why |
|---|---|
| A reply is allowed after an unsubscribe | A reply answers the correspondent's own message, and is not list mail. Suppression still stops it. |
| `one-send-at-a-time` (never) | One send in flight, so a receipt names the send it settles. |
| `waiting: 0..2`, refusal `backlog` | At most two messages wait for an answer. A third is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting messages and the send in flight; its bound is the transit bound of the configuration the channel generates (PS15.5). |

## Not checked

- The headers themselves: the adapter writes `List-Unsubscribe` and `List-Unsubscribe-Post` on a bulk send, and verifies the one-click POST.
- Authentication (SPF, DKIM, DMARC), spam rates and volume limits.
- Soft bounces: only a permanent failure of a send counts as a bounce.

## Conclusion

Three provider rules are checked: no bulk mail after a one-click unsubscribe, the unsubscribe stands, and nothing is sent to an address after two bounces. The number two is poly's reading of "multiple".
