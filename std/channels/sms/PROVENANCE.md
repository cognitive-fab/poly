# std.channels.sms: provenance

The rules of `std/channels/sms.poly` were taken from Twilio's documentation of opt-out keywords and of error 21610, read on 2026-10-05. poly checks the rules this module encodes, and no other (PT21.3). A provider rule that is not listed here is not checked.

## Rules from the provider

| Rule in the module | Source | What the source says |
|---|---|---|
| `no-send-after-opt-out` (never) | https://help.twilio.com/articles/223134027-Twilio-support-for-opt-out-keywords-SMS-STOP-filtering- | The opt-out keywords are "STOP, UNSUBSCRIBE, END, QUIT, STOPALL, REVOKE, OPTOUT, and CANCEL", matched without regard to case; after one, messages to the number are blocked. |
| `no-send-after-opt-out` (never) | https://www.twilio.com/docs/api/errors/21610 | Error 21610: "The person you are trying to message has opted out". The module refuses the send before the provider does. |
| `opt-keyword-never-refused` (reject property) | https://help.twilio.com/articles/223134027-Twilio-support-for-opt-out-keywords-SMS-STOP-filtering- | An opt-out takes effect when the keyword arrives. The module's backlog of waiting messages never refuses an opt-out or opt-in keyword; only its message to the application is dropped when two already wait. |
| `consent-changes-only-by-keyword` (step property) | https://help.twilio.com/articles/223134027-Twilio-support-for-opt-out-keywords-SMS-STOP-filtering- | Consent changes on a keyword from the recipient: an opt-out keyword withdraws it, and "START" or "UNSTOP" gives it back. "HELP" is reserved and changes nothing. |

## Constants

The module has no duration or numeric constant from the provider. The keyword lists are the adapter's: it classifies a message as `Plain`, `OptOut`, `OptIn` or `Help`, and the conversation reads only the class.

## poly's own rules

| Rule in the module | Why |
|---|---|
| `one-send-at-a-time` (never) | One send in flight, so a receipt names the send it settles. |
| `waiting: 0..2`, refusal `backlog` | At most two messages wait for an answer. A third is a rejected step, journaled. |
| `pending: 0..3`, invariant `obligations` | The waiting messages and the send in flight; its bound is the transit bound of the configuration the channel generates (PS15.5). |

## Not checked

- The keyword matching itself (the adapter's, tested with the adapters).
- Advanced Opt-Out custom keywords, and the provider's automatic replies to keywords.
- Carrier filtering, message length and segment rules.

## Conclusion

Two provider rules are checked: nothing is sent to a number that has opted out, and consent changes only on a keyword from the recipient. The keyword lists are recorded here and applied by the adapter.
