# std.channels.slack: provenance

The rules of `std/channels/slack.poly` were taken from Slack's documentation of the method `chat.postMessage` and of the events `channel_archive` and `channel_unarchive`, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `no-post-to-archived` (never) | https://docs.slack.dev/reference/methods/chat.postMessage | The error `is_archived`: the channel has been archived and cannot receive new messages. |
| `Inbound` with `Archived` and `Unarchived` | https://docs.slack.dev/reference/events/channel_archive and https://docs.slack.dev/reference/events/channel_unarchive | "A channel was archived"; "A channel was unarchived". Each is sent to the workspace's connections. |
| `one-message-per-second` (never) | https://docs.slack.dev/reference/methods/chat.postMessage | "It will generally allow an app to post 1 message per second to a specific channel." The error `rate_limited` carries a `Retry-After` header. The module refuses a post asked for while its timer runs with `Rejected("rate-limited")`, before the provider would. |

## Constants

| Constant | Source |
|---|---|
| `1s`, the time between two posts to the channel | the last row above |

## poly's own rules

| Rule in the module | Why |
|---|---|
| `one-send-at-a-time` (never) | Nothing is sent while a send is in flight, so a receipt names the send it settles. |
| `Ack` and the slot (ruled after step 7) | One slot holds a send, then its receipt (`Delivered`, `Rejected` or `Failed`), until the application acknowledges the receipt with `Ack`, which the channel's expansion appends to every handler bound to a receipt (PS15.3). With the receipt counted, every message between the application and its conversation stays within `pending`'s bound. |
| `queued: 0..2`, `queue1`, `queue2` (ruled on step 8) | A reply that answers a waiting message, while the slot is held, waits in the queue, in order, and takes the slot when `Ack` frees it, under the rules as they stand then. A template, or a reply that answers no waiting message, is refused `busy` while the slot is held, and the generated configuration reports that as `PL5407` wherever it is reachable (PS15.5). The invariant `queue-while-held` says a queue exists only while the slot is held. |
| `waiting: 0..2`, refusal `backlog` | At most two messages wait, for an answer or in the queue. A third is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting and queued messages and the held slot (a send or its unacknowledged receipt); its bound is the transit bound of the configuration the channel generates (PS15.5). |
| The errors `not_in_channel`, `channel_not_found` and `rate_limited` after its retries | A failed send, reported to the application as `Failed`. |
| The error `is_archived` (ruled on step 8) | A failed send, and the provider event `Archived` for the channel (PS15.4), so `no-post-to-archived` holds at run time even when the archive event was missed. |

## Not checked

- The workspace-wide limit of several hundred messages per minute.
- Private channels: the archive events read here are documented for public channels.
- Threads, edits, reactions and message formatting.

## Conclusion

Two provider rules are checked: nothing is posted to an archived channel, and a second post waits for the one-second timer after the first. The interval is a constant, recorded here; poly checks that the timer is waited for, not how long it lasts.
