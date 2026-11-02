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

## The vault adapter (`oauthVault`, M9 step 7)

Written from the RFCs, and built and tested against the generic provider `test-oauth` with recorded traffic only (`test/fixtures/traffic/oauth`, `google`, `stripe`); the provider profiles' own sources are in `std/credentials/providers/PROVENANCE.md`.

| What the adapter does | Source |
|---|---|
| Sends the authorization request with `response_type=code`, `client_id`, `redirect_uri`, `scope` and `state` | https://www.rfc-editor.org/rfc/rfc6749#section-4.1.1 |
| Adds `code_challenge`, the base64url SHA-256 of a 32-byte random verifier, with `code_challenge_method=S256`, and sends the verifier with the code | https://www.rfc-editor.org/rfc/rfc7636#section-4.2 |
| Exchanges the code with `grant_type=authorization_code`, `code` and `redirect_uri`, authenticating a confidential client with HTTP Basic | https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3 and section 2.3.1 |
| Reads `scope` from the token response, or takes the scopes requested when it has none | https://www.rfc-editor.org/rfc/rfc6749#section-5.1 |
| Refreshes with `grant_type=refresh_token`; keeps the old refresh token when none is returned; reads `invalid_grant` as an expired grant | https://www.rfc-editor.org/rfc/rfc6749#section-6 and section 5.2 |
| Revokes the refresh token with `token_type_hint=refresh_token` | https://www.rfc-editor.org/rfc/rfc7009#section-2.1 |
| Uses the state once, and keeps it ten minutes (poly's own bound) | https://www.rfc-editor.org/rfc/rfc6749#section-10.12 (the state against cross-site request forgery) |

## The Gmail source (`gmail`, the examples branch, S452)

Written from the Gmail API reference, read on 2026-10-08, and tested against recorded traffic only (`test/fixtures/traffic/gmail`, built from the synthetic corpus in `test/fixtures/inbox`). Each item is one message of the inbox, owned by its account's principal (S451); its id is `<account label>/<message id>`, so no id names an address.

| What the adapter does | Source |
|---|---|
| A first sync reads `GET users/me/profile` for its `historyId`, then lists `GET users/me/messages?labelIds=INBOX&maxResults=100` once, so the first sync is bounded | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile and https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list |
| A poll reads `GET users/me/history?startHistoryId=<h>&historyTypes=messageAdded&labelId=INBOX&maxResults=100`, page by page through `nextPageToken`, at most twenty pages, and takes each `messagesAdded[].message.id` once | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list |
| Reads a 404 on the history as an expired cursor ("typically valid for at least a week, but in some rare circumstances ... only a few hours"), and syncs again by a list with `q=after:<seconds>` since the newest message kept | the same page |
| Fetches each message with `GET users/me/messages/<id>?format=raw` and reads `raw`, the whole message in base64url, with the MIME reader below; `internalDate` is the item's `asOf` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get |
| Moves the cursor only after every message it covers is kept, and fetches no message it holds, so a sync cut short is taken again on the next with nothing twice and nothing missed (IT2.3) | poly's own rule |
| Sends only GETs under `https://gmail.googleapis.com/gmail/v1/users/me/`, through the runtime's handles for the source's read credential: its one grant (S460, one account), or each account's own grant through its owner's handle (S461); for a source that names no credential, through the host's request function for each account (`gmail.readonly`, which every method above accepts); it sets no credential header of its own | S455, part a |

**Poly's own bounds.** A message's text is kept to 32,768 characters by default and marked `[truncated]` beyond. A mail store keeps each record under the SHA-256 of its key, so no file name holds an id.

**Not handled.** Labels other than `INBOX`, messages removed from the inbox after they were kept (`messageDeleted`, `labelRemoved`), rate limits (429, 403 `rateLimitExceeded`), which fail the sync for the host to retry, and Gmail's batch endpoint.

## The MIME reader (`readMime`)

Mail is untrusted input, so the reader never throws on a message's content and names what it could not take as written (`problems`).

| What the reader does | Source |
|---|---|
| Unfolds headers, a run of folding white space read as one space | https://www.rfc-editor.org/rfc/rfc5322#section-2.2.3 |
| Decodes encoded words, B and Q, dropping the white space between two adjacent ones | https://www.rfc-editor.org/rfc/rfc2047#section-4 and section 6.2 |
| Reads a message with no `Content-Type` as `text/plain` in US-ASCII | https://www.rfc-editor.org/rfc/rfc2045#section-5.2 |
| Decodes `base64` and `quoted-printable`, a `=` at a line's end being a soft break | https://www.rfc-editor.org/rfc/rfc2045#section-6.7 and section 6.8 |
| Splits a multipart body on its boundary, the preamble and epilogue left out; takes the plain part of a `multipart/alternative` | https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1 and section 5.1.4 |
| Reads a parameter in RFC 2231's `name*=charset''value` form | https://www.rfc-editor.org/rfc/rfc2231#section-4 |
| Decodes a charset by the WHATWG Encoding Standard's labels (`TextDecoder`); an unknown one is read as UTF-8 and named | https://encoding.spec.whatwg.org/#names-and-labels |

**Poly's own bounds.** At most 8 levels of multipart and 200 parts are read. An attachment is listed by name, type and decoded size, never read. HTML is used only when a message has no plain text: its script, style and head are dropped, block ends become line ends, tags are removed and entities decoded.

## MCP client (`mcp.ts`)

The Model Context Protocol specification revision 2025-11-25, read on 2026-10-27. The client asks for 2025-11-25 and also speaks 2024-11-05, 2025-03-26 and 2025-06-18 (version negotiation, below). The revision of 2026-07-28 drops `initialize` and the session; a server that speaks only it is not handled.

| What the client does | Source |
|---|---|
| POSTs each JSON-RPC message to the one endpoint with `Accept: application/json, text/event-stream`; takes a JSON answer or an SSE stream, and reads from a stream the event whose JSON-RPC id is the request's | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (Streamable HTTP, sending messages) |
| Sends `initialize` with `protocolVersion` 2025-11-25, then the `notifications/initialized` notification, which the server answers 202 | https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle |
| Keeps the `MCP-Session-Id` of the `initialize` answer (visible ASCII only) and sends it on every later request; sends `MCP-Protocol-Version` with the negotiated version on every later request | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (session management, protocol version header) |
| Continues with the version the server answers when the client speaks it too, and stops otherwise | https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle (version negotiation) |
| `MCP-Protocol-Version` exists from 2025-06-18 on; a server that receives none assumes 2025-03-26 | https://modelcontextprotocol.io/specification/2025-06-18/changelog, and the transports page above (protocol version header) |
| `tools/list` and `tools/call` with `name` and `arguments`; a result with `isError` is a failure of the tool, and its `text` parts are joined | https://modelcontextprotocol.io/specification/2025-11-25/server/tools |

**Poly's own bounds.** No GET stream, no resumption, no `DELETE`, no pagination of `tools/list`. A 404 for an expired session is a permanent failure, not a new `initialize`. One request is one attempt and nothing retries. A 401 or 403 is permanent, a transport error or a 5xx is a failure with no answer, and any other non-2xx status is permanent. The client sends no credential and refuses a configuration that holds one (PT10g, PL6825): a header named like a credential, a user or password in the URL, a key or token parameter, or a value with the shape of a token. The shapes are copied from `poly-check` because this package imports no check package (S182), and a test keeps them in step.

**The review of 2026-11-02 (rule 7a).** A review of the client found five defects, numbered here as the review numbers them. The rules below are the specification of their fixes, written before any test or code.

1. **A credential under any header name (PT10g, PL6825).** A header name is not evidence: `x-trace: Bearer abc` carries a credential as surely as `Authorization` does. The client refuses, when it is made, every header value and every part of the URL that holds a credential, whatever its name:
   - a value that matches one of the token shapes (`TOKEN_SHAPES`), refused with a message that says `token-shaped`, as today;
   - a value that starts with an HTTP authentication scheme, then whitespace, then any other character. The schemes are those of the IANA HTTP Authentication Scheme Registry (`Basic`, `Bearer`, `Concealed`, `Digest`, `DPoP`, `GNAP`, `HOBA`, `Mutual`, `Negotiate`, `OAuth`, `PrivateToken`, `SCRAM-SHA-1`, `SCRAM-SHA-256`, `vapid`) and four in common use outside it (`ApiKey`, `AWS4-HMAC-SHA256`, `NTLM`, `Token`), matched without regard to case, after leading whitespace. The refusal message says `authentication scheme`. A scheme name alone (`Bearer`), or one inside a longer word (`Bearerish x`), is not refused.
   - The parts of the URL are checked decoded: the host, each path segment, each query name and value, and the fragment, as well as the URL as written. A part whose percent-encoding is malformed is refused, with a message that says `malformed`.
   - The host is read as it is written in the URL, then decoded, and never as a URL parser returns it: the parser lowercases it, and the token shapes are case-sensitive. A second review of 2026-11-02 found `https://%41KIAIOSFODNN7EXAMPLE.example.test/mcp` accepted, because the parsed host read `akiaiosfodnn7example`.
   - The checks that exist stay, with their messages and in their order: a credential-named header or query parameter is refused by its name first, then a user or password in the URL, then the scheme (`https`). A value such as `x-trace: abc` is still accepted.
   - This shape is poly-io's own and is not one of `TOKEN_SHAPES`, which stay the seven `PL6825` reads. `PL6825` does not read the scheme shape either; whether it should is the owner's question, outside this fix.
2. **No session after a failed `initialize`.** `sessionId` is set only by an `initialize` that succeeds. After any `initialize` that fails, including one whose `notifications/initialized` is refused or gets no answer, `sessionId` is `null`, and `listTools` and `callTool` are refused without a request. The `notifications/initialized` request itself carries the session id of the `initialize` answer, as before.
3. **A result with no content is no answer.** A `tools/call` result whose `content` is not an array (a result of `{}`, or one with `content` missing, `null` or an object) is a failure with no answer: `ok: false`, `answered: false`, `permanent: false`. The server answered, but whether the tool ran is not known, so the attempt is spent as for a transport error. This holds whatever `isError` says. A `content` of `[]` is a result, with empty text. A JSON-RPC message that holds neither a result nor an error stays what it is today, a failure that was answered.
4. **408 and 429 are permanent, by design.** Every effect has one attempt and no retry (P1 item 5), so a status that invites a retry changes nothing. A 408 or a 429, to `initialize` or to `tools/call`, is a permanent failure that names the status (`ok: false`, `permanent: true`, and for a call `answered: true`), and the client sends no second request.
5. **What was checked is what is used.** The configuration is copied when the client is made. Every request goes to the URL the client was made with, `client.url` is that URL, and changing the caller's object afterwards changes neither the URL nor the headers.

**Version negotiation (rule 7a).** A live probe on 2026-11-02, of the Lab's Hello server through the owner's gateway (Direct URL): `initialize` with `protocolVersion` 2025-11-25 was answered with `protocolVersion` `"2024-11-05"`, as an SSE event, with an `mcp-session-id` header. The gateway passed the answer through unchanged. The client refused it, and the specification says a client that also speaks the server's version continues with it.

A second probe the same day, through the same gateway:

- `initialize` with 2025-11-25 or with 2025-06-18 is answered with `"2024-11-05"`, as an SSE event, with an `mcp-session-id` header.
- After that, a request whose `MCP-Protocol-Version` is 2025-06-18 is refused with the JSON-RPC error -32022 `Unsupported protocol version`. The server accepts only 2024-11-05 or 2026-07-28 there. So the header carries the negotiated version even for 2024-11-05, which the specification gave no header.
- Its answers say `content-encoding: gzip` and are not compressed. Node's `fetch` fails on them with `Z_DATA_ERROR` unless the request sends `accept-encoding: identity`.

The rules:

1. `initialize` asks for 2025-11-25, the latest version the client speaks.
2. The client speaks four versions: 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25. An answer that names one of them is accepted, and that version is the negotiated one. An answer that names any other version, or none, is a permanent failure whose error names the version answered, and it leaves no session (item 2 of the review above).
3. The client exposes the negotiated version as `client.protocolVersion`: `null` before `initialize` and after an `initialize` that fails.
4. Every request after `initialize` (`notifications/initialized`, `tools/list`, `tools/call`) carries `MCP-Protocol-Version` with the negotiated version, whichever of the four it is, and never the version `initialize` asked for when the two differ. `initialize` itself carries none. This replaces the first reading of this rule, which sent no header for 2024-11-05 and 2025-03-26: the second probe shows a server that wants it. A server that refuses the header (the probe's -32022, which the specification answers with HTTP 400) is a permanent failure, as any 4xx is.
5. The transport stays Streamable HTTP whatever the version, with the session id, the JSON answer and the single-event SSE answer as above. The probe shows the Lab's server answering a POST that way while it names 2024-11-05, whose own transport was HTTP with SSE. The tool results are read the same way; `structuredContent`, which older versions do not have, is simply absent.
6. Every request, `initialize` included, carries `accept-encoding: identity`, and it replaces an `accept-encoding` the configuration gives whatever the letter case of its name. The body of an answer is read as it arrives and is never decoded by its `content-encoding`: an answer labelled `gzip` whose body is plain JSON or SSE is read as that JSON or SSE.

## Conclusion

Every rule the adapters apply to a provider's traffic is listed here with its source, and the tests replay that traffic from the documented payloads, forged variants included. What is not listed is not handled.
