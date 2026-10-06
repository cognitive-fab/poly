# std.channels.slack: provenance

The rules of `std/channels/slack.poly` were taken from Slack's documentation of the method `chat.postMessage` and of the events `channel_archive` and `channel_unarchive`, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `no-post-to-archived` (never) | https://docs.slack.dev/reference/methods/chat.postMessage | The error `is_archived`: the channel has been archived and cannot receive new messages. |
| `Inbound` with `Archived` and `Unarchived` | https://docs.slack.dev/reference/events/channel_archive and https://docs.slack.dev/reference/events/channel_unarchive | "A channel was archived"; "A channel was unarchived". Each is sent to the workspace's connections. |
| `one-message-per-second` (never) | https://docs.slack.dev/reference/methods/chat.postMessage | "It will generally allow an app to post 1 message per second to a specific channel." The error `rate_limited` carries a `Retry-After` header. |

## Constants

| Constant | Source |
|---|---|
| `1s`, the time between two posts to the channel | the last row above |

## poly's own rules

| Rule in the module | Why |
|---|---|
| `one-send-at-a-time` (never) | One send in flight, so a receipt names the send it settles. |
| `waiting: 0..2`, refusal `backlog` | At most two messages wait for an answer. A third is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting messages and the send in flight; its bound is the transit bound of the configuration the channel generates (PS15.5). |
| The errors `not_in_channel`, `channel_not_found` and `rate_limited` after its retries | A failed send, reported to the application as `Failed`. |

## Not checked

- The workspace-wide limit of several hundred messages per minute.
- Private channels: the archive events read here are documented for public channels.
- Threads, edits, reactions and message formatting.

## Conclusion

Two provider rules are checked: nothing is posted to an archived channel, and a second post waits for the one-second timer after the first. The interval is a constant, recorded here; poly checks that the timer is waited for, not how long it lasts.
