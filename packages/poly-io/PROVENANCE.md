# poly-io: provenance of the adapters

Each runtime channel adapter (S182, S183) was written from its provider's documentation, read on 2026-10-05. The recorded traffic in `test/fixtures/traffic` is built from the payloads the same pages document; no live account was used. A provider behaviour not listed here is not handled.

## WhatsApp Cloud API (`whatsapp`)

| What the adapter does | Source |
|---|---|
| Checks `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the raw body under the app secret | https://developers.facebook.com/docs/graph-api/webhooks/getting-started |
| Answers the verification GET with `hub.challenge` when `hub.mode` is `subscribe` and `hub.verify_token` matches | the same page |
| Reads messages from `entry[].changes[].value.messages` and receipts from `.statuses` (`sent`, `delivered`, `read`, `failed`), of a change whose `value.metadata.phone_number_id` is the channel's number; one app secret signs every number's notifications, so another number's change is skipped (review C-F5, M8b) | https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples |
| Sends `POST https://graph.facebook.com/<version>/<phone number id>/messages` with a bearer token, a text or a template body; the provider id is `messages[0].id` | https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages |

## Twilio SMS (`sms`)

| What the adapter does | Source |
|---|---|
| Checks `X-Twilio-Signature`: base64 of HMAC-SHA1 under the auth token over the URL and the POST parameters sorted by name, each name followed by its value | https://www.twilio.com/docs/usage/webhooks/webhooks-security |
| Reads `MessageSid`, `AccountSid`, `From`, `Body` of an inbound message | https://www.twilio.com/docs/messaging/guides/webhook-request |
| Reads `MessageSid`, `MessageStatus` and `ErrorCode` of a status callback; `delivered`, `undelivered` and `failed` are final | https://www.twilio.com/docs/messaging/guides/track-outbound-message-status |
| Sends `POST https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json` with `To`, `From`, `Body`, basic authentication; the provider id is `sid`; error 21610 (opted out) is permanent | https://www.twilio.com/docs/messaging/api/message-resource |
| Classifies a message whose whole text is a keyword: opt-out `STOP`, `UNSUBSCRIBE`, `END`, `QUIT`, `STOPALL`, `REVOKE`, `OPTOUT`, `CANCEL`; opt-in `START`, `UNSTOP`; `HELP`; without regard to case | https://help.twilio.com/articles/223134027-Twilio-support-for-opt-out-keywords-SMS-STOP-filtering- |

## Email (`email`)

| What the adapter does | Source |
|---|---|
| Reads a Mailgun route POST: `sender`, `Message-Id`, `body-plain`; the message id is `mail:` and the `Message-Id`, which the mail's sender writes, so it can never take the id of an unsubscribe or a Mailgun event (review C-F3, M8b) | https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http/ |
| Checks `signature`, hex HMAC-SHA256 under the webhook signing key over `timestamp` followed by `token`; refuses an old timestamp; names the token as the webhook's nonce, which ingress takes once in the store (the token cache the page recommends) and keeps until the timestamp leaves the tolerance, by our clock (review C-F7, M8b) | https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks/ |
| Reads an event webhook, `{ signature, event-data }`: `failed` with severity `permanent` is the provider event `Bounce` on the recipient's thread (PS15.4); `delivered` and a temporary `failed` are receipts, recorded only | https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads/ |
| Writes `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on bulk mail, and takes the one-click POST `List-Unsubscribe=One-Click`, as `multipart/form-data` (which the RFC says the POST SHOULD be) or urlencoded (review C-F4, M8b). The URL carries the recipient, the time it was issued and a token over both, so each mail's unsubscribe is its own message (review C-F3, M8b) | https://www.rfc-editor.org/rfc/rfc8058.html |
| Submits by SMTP: EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA with dot-stuffing and `<CRLF>.<CRLF>`, QUIT; a 5yz reply is permanent, a 4yz one transient. A 5yz reply to `RCPT TO` rejects the recipient, and is also the provider event `Bounce` (review B-F5, M8b). A bare CR or LF in the body becomes CRLF before dot-stuffing (2.3.8, review C-F2). A recipient is one address, and no command line holds CR or LF (review C-F1) | https://www.rfc-editor.org/rfc/rfc5321.html |

## Slack (`slack`)

| What the adapter does | Source |
|---|---|
| Checks `X-Slack-Signature: v0=<hex>`, HMAC-SHA256 under the signing secret over `v0:<timestamp>:<body>`, and refuses a timestamp more than five minutes from now | https://docs.slack.dev/authentication/verifying-requests-from-slack |
| Refuses an `event_callback` whose `team_id` is not the configured workspace's: an app's one signing secret signs every workspace it is installed in (review C-F5, M8b) | https://docs.slack.dev/apis/events-api/ |
| Answers `url_verification` with its `challenge`; reads `event_callback` with `event_id` and `event` | https://docs.slack.dev/apis/events-api/ |
| Reads `channel_archive` and `channel_unarchive` | https://docs.slack.dev/reference/events/channel_archive and https://docs.slack.dev/reference/events/channel_unarchive |
| Sends `POST https://slack.com/api/chat.postMessage` with a bearer token; the provider id is the channel and `ts`; `is_archived`, `not_in_channel` and `channel_not_found` are permanent, `rate_limited` is not; `is_archived` also reports the provider event `Archived` for the channel (PS15.4) | https://docs.slack.dev/reference/methods/chat.postMessage |

## Standard Webhooks (`webhook`)

| What the adapter does | Source |
|---|---|
| Checks `webhook-id`, `webhook-timestamp` and `webhook-signature`, a space separated list of `v1,<base64>` HMAC-SHA256 over `<id>.<timestamp>.<body>` under the key of `whsec_<base64>`; refuses a timestamp outside the tolerance. The key is strict base64 of 24 to 64 bytes, or the adapter is not made (review C-F6, M8b) | https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md |
| Signs a delivery the same way; a 2xx answer is a success and any other a failure | the same page |

## Choices that are poly's own

- **Sender claims (K11).** WhatsApp, Slack and a signed webhook source authenticate the sender, so the claim is verified. An SMS number and an email address from a route webhook are not authenticated, so the claim is unverified. A one-click unsubscribe carries a token only the adapter can make, so its claim is verified.
- **Certified (plan step 10, S182).** The certificate binds each channel's adapter by this package's name, version and digest; the runtime takes only an adapter this package made (`madeHere`), as it loaded it.
- **The sender.** Each adapter names the identity it sends as (`sender`): the WhatsApp phone number id, the Twilio number, the mail domain, a digest of the Slack bot token, the webhook endpoint. The runtime refuses two channels that send as one sender, so state a provider keeps per sender and address is one thread's.
- **Twilio 21610.** A send refused because the recipient opted out is the provider event `Reported` for that number (PS15.4). Its id is the send's idempotency key, so a second opt-out reported after an opt-in is a step of its own (review D-F9, M8b); the same holds for Slack's `is_archived`.
- **No empty secret (review C-F6, M8b).** An adapter is not made with an empty secret, token, key or name: a signature under an empty secret proves nothing.
- **Frozen (review D-F1, M8b).** An adapter is frozen when it is made, so its `verify`, `send` and `kind` cannot be changed after the runtime certified it by identity.
- **Idempotency.** The email Message-ID and the webhook-id of a delivery come from the outbox's idempotency key, so a retried send carries the same id.
- **Mailgun as the inbound mail provider.** S183 names an inbound-mail webhook; Mailgun's route webhook was chosen because it is signed.

## Seeded mutants

`ADAPTER_FAULTS` names two broken checks an adapter takes from its configuration, for the tests only: a signature comparison that always matches (`signature-always-matches`) and a timestamp check that never refuses (`timestamp-never-stale`). `test/channels-adapters.test.mjs` shows each lets a forged or stale webhook through every adapter that checks one.

## Not handled

- Media, locations, reactions and interactive replies beyond keeping their object as the body (WhatsApp); MMS media (Twilio); attachments and multipart route posts (Mailgun); threads and edits (Slack).
- An address with a quoted local part, a comment or a display name: the adapter takes one plain `local@domain` and refuses the rest as a recipient.
- Twilio requests with a JSON body (`bodySHA256`).
- A bounce mailed back as a DSN (Mailgun's event webhook reports it instead), and DKIM signing, which the relay does.

## Conclusion

Every rule the adapters apply to a provider's traffic is listed here with its source, and the tests replay that traffic from the documented payloads, forged variants included. What is not listed is not handled.
