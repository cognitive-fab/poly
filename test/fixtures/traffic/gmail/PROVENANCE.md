# Gmail API traffic, recorded for the inbox assistant's tests

The tapes here are built by `scripts/ex-gmail-traffic.mjs` from the synthetic corpus in `test/fixtures/inbox` (plan-ex.md E2.0). No live account was called, and no real mail, name or address is in them: the domains are reserved for examples. Each tape is one account's exchanges, by scenario (`initial`, `poll`, `quiet`, `expired`), each a request (method and URL) and the response (status and JSON body). `test/ex-gmail-traffic.test.mjs` checks that the files are what the corpus builds.

The shapes were read on 2026-10-08 from the Gmail API reference:

| Exchange | Shape | Source |
|---|---|---|
| `GET /gmail/v1/users/me/profile` | `emailAddress`, `messagesTotal`, `threadsTotal`, `historyId` (a string) | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile |
| `GET /gmail/v1/users/me/messages?labelIds=INBOX&maxResults=100[&q=after:<seconds>]` | `messages[]` of `{ id, threadId }` only, `nextPageToken`, `resultSizeEstimate`; `maxResults` defaults to 100, at most 500; `q` is refused under `gmail.metadata` | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list |
| `GET /gmail/v1/users/me/history?startHistoryId=<h>&historyTypes=messageAdded&labelId=INBOX&maxResults=100[&pageToken=<t>]` | `history[]` of records with `id`, `messages`, `messagesAdded[].message`; `nextPageToken`; `historyId`, the mailbox's current record | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list |
| the same, with an expired `startHistoryId` | HTTP 404. The reference: "A historyId is typically valid for at least a week, but in some rare circumstances may be valid for only a few hours", and on 404 the client performs a full synchronization. The body is Google's standard error shape (`error.code`, `error.message`, `error.errors[]`, `error.status`). | the same page |
| `GET /gmail/v1/users/me/messages/<id>?format=raw` | the Message resource: `id`, `threadId`, `labelIds`, `snippet`, `historyId`, `internalDate` (milliseconds, a string), `sizeEstimate`, `raw` (the whole RFC 2822 message, base64url) | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get |

Every one of these methods accepts `gmail.readonly`. The poller's credential holds that scope alone (S455, part a).

## Choices that are the tests' own

- `internalDate` is the message's `Date` header, and `historyId` values are small increasing numbers written as strings.
- `snippet` is empty, since the adapter never reads it.
- The corpus files keep LF, as the repository keeps every text file; the script writes CRLF into `raw`, as RFC 5322 requires.
- The expired scenario's list names only the newest message seen, which the adapter already holds, so a test sees that nothing is fetched twice.

## Not covered

Partial failures of a batch, rate limiting (HTTP 429) and quota errors (403 `rateLimitExceeded`) are not recorded; the adapter treats any answer other than 200 and the history 404 as a failure of the sync, which the host retries on the next poll.
