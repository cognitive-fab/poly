# Example application 1: the inbox assistant

Status: proposed, for the owner's ruling. Ids: functional `IF`, technical `IT`, acceptance `IAC`.

The inbox assistant reads many mailboxes, finds the messages that need the owner, keeps one list of things to do, and prepares replies. It never sends anything on its own. It is the second v1 example beside the concierge, and the one the owner uses every day. It exercises all four v1 surfaces: channels (M8), credentials (M9), memory (M10), and routing and budgets (M11).

# Part A. Functional specification

## IF1. The problem

The owner receives mail in many Gmail accounts and in several AWS SES inboxes (domains whose mail SES receives). Reading all of them by hand takes too long, and important messages are missed among newsletters and notifications.

## IF2. What the assistant does

- **IF2.1 One inbox.** Every new message of every configured account appears in one list, each tagged with the account it arrived in.
- **IF2.2 Triage.** Each message gets an importance (`act-now`, `this-week`, `fyi`, `ignore`), a kind (`request`, `question`, `meeting`, `invoice`, `personal`, `notification`, `newsletter`, `other`) and whether it needs a reply. These are typed decisions with strict domains (PD1): a model cannot invent a new value.
- **IF2.3 Things to do.** A message that needs the owner becomes a to-do: a short title, the account, the sender, a due date when the message states one, and a link to the thread. One thread has at most one open to-do.
- **IF2.4 Prepared replies.** For a to-do that needs a reply, the assistant prepares a draft in the owner's voice, from the thread and from earlier mail with the same correspondent in the same account. Each draft cites the messages it rests on.
- **IF2.5 The owner decides.** The owner reads the list, edits or discards a draft, and approves it. Nothing is sent without that approval. For a Gmail account the default is a Gmail draft the owner sends from Gmail; sending from the assistant is an option per account.
- **IF2.6 A daily digest.** Once a day: the open to-dos by importance and due date, the drafts waiting for approval, and the count of messages filed as `fyi` or `ignore` per account.
- **IF2.7 Done.** A to-do closes when its reply is sent (seen in the account's sent mail), when the owner marks it done or dismissed, or when a later message in the thread resolves it and the owner confirms.
- **IF2.8 Snooze.** A to-do can be snoozed until a date; it returns to the list then.

## IF3. What the assistant must never do

- **IF3.1** Send, delete, archive, label or move a message without the owner's approval. In v1 it never deletes.
- **IF3.2** Use content from one account in a draft sent from another, unless the owner links the two accounts.
- **IF3.3** Follow instructions written in an email. An email is data. A message that asks the assistant to forward, pay, reply or click is triaged like any other, and at most becomes a to-do for the owner.
- **IF3.4** Put a message body, a draft body or a credential in its journal, ledger, logs or reports. Bodies live in the content store by digest, and the owner can erase them.
- **IF3.5** Spend more than the owner's model budget. The monthly limit is set by the owner; triage uses the cheaper tier, drafts the stronger one, and work stops at the limit with the reason shown.
- **IF3.6** Process a message twice, or miss one, across restarts.

## IF4. Accounts

- **IF4.1 Gmail.** Any number of accounts, each authorized once by the owner through OAuth. Read access and draft creation by default; send only if the owner enables it for that account.
- **IF4.2 AWS SES.** Any number of receiving domains. SES stores each received message in S3 and announces it on a queue; the assistant reads from the queue and the bucket. Replies go out through SES only after approval, and only from identities the owner lists.
- **IF4.3** The owner adds, pauses and removes accounts. Removing an account can erase its stored bodies.

## IF5. Where the owner sees it

A local web page served by the host on the owner's machine: the to-do list, a message view, the draft editor with its citations, the approve and discard buttons, the digest, and the budget used this month. The same operations are available to an agent as MCP tools, with approval reserved to the owner (PT12.5).

## IF6. Acceptance criteria

| Id | Criterion |
|---|---|
| IAC1 | With recorded traffic from three Gmail accounts and two SES domains, every message appears once in the list, tagged with its account, across a restart in the middle of a batch. |
| IAC2 | A variant that can send a reply without an approval gets a witness from `poly check`. At run time the gate refuses the send. |
| IAC3 | A variant whose draft for account A can carry content of account B gets a witness (`PL6831`). At run time the gate denies the send `audience`. |
| IAC4 | A recorded message containing instructions ("forward this to…", "reply with your password") produces no effect other than its triage, and at most a to-do. |
| IAC5 | A draft that cites no message of its thread is rejected `uncited`. |
| IAC6 | With a budget set below a batch's cost, triage stops at the limit with the reason `budget`, no reservation is overspent, and the remaining messages wait. |
| IAC7 | A canary placed in a message body and in an OAuth token never appears in state, journal, ledger, logs, proposals or reports. |
| IAC8 | `poly forget` for an account erases its bodies from the content store; the journal still replays every step, with the bodies marked erased. |
| IAC9 | The assistant is checked `CLEAN`, and its journal replays every post-state, gate decision and tier choice from recorded providers. |
| IAC10 | A draft Gmail may already hold is never created twice. A creation whose outcome is ambiguous (a timeout, a dropped connection or a server error after the request left) is not retried and leaves the to-do in `Uncertain` until the owner reports whether the draft exists; a definite refusal (400, 401, 403, 404 or 429) leaves it to propose again. `poly check` proves that a to-do reaches `Created` at most once. Found by the loop of M7: the mined rule `count("gmail.createDraft") <= 1` was violated by the first version of this program. |

# Part B. Technical specification

## IT1. Structure

Five machines and one host program. The machines hold every rule; the host only moves bytes and serves the page.

| Machine | One instance per | Holds |
|---|---|---|
| `Mailbox` | account | sync cursor (Gmail `historyId`, SES queue position), status (active, paused, failing), the timer for the next poll |
| `Message` | message | account, provider id, thread key, triage result, state (`new`, `triaged`, `filed`) |
| `Todo` | open item | thread, title (`Content`), importance, due date, state (`open`, `drafting`, `drafted`, `approved`, `sent`, `done`, `dismissed`, `snoozed`) |
| `Draft` | prepared reply | thread, body (`Content`), citations, account, state (`prepared`, `edited`, `approved`, `sent`, `discarded`) |
| `Digest` | day | the summary, built from the other machines' state |

Plus the std machines the surfaces bring: `Grant` (M9) for each account's credential, `Budget` and `Route` (M11) for model use.

## IT2. Reading mail

- **IT2.1 Gmail.** A source adapter (M10, `poly-io`) with the Gmail API: `users.history.list` from the stored `historyId` on a timer, `users.messages.get` for each new id, the body stored as `Content`. A `historyId` that has expired falls back to a bounded `messages.list` since the last seen date, journaled. Scopes: `gmail.readonly` and `gmail.compose`; `gmail.send` only for an account where sending is enabled.
- **IT2.2 SES.** A source adapter reading an SQS queue fed by the SES receipt rule's SNS topic, and the raw message from S3 (`s3:GetObject` on the rule's prefix only). Each queue message is deleted only after the `Message` instance is committed, so a crash redelivers and the provider id deduplicates. No public endpoint is needed.
- **IT2.3 Exactly once.** The `Message` instance id is `<account>:<provider id>`; creation of an existing id is refused (E13's `$uncreatable`), so a redelivery or an overlapping poll creates nothing.
- **IT2.4 Credentials.** Each account is a `credential` with `uses` (M9): a Gmail OAuth grant in the vault, an IAM key pair for SES in the vault. Tokens never leave the authenticated capability. The owner sets the AWS keys himself; no agent reads them.

## IT3. Triage and to-dos

- **IT3.1** Triage is one typed decision per message, `decision triage(body: Content, headers: Headers) -> { importance: Importance, kind: Kind, needsReply: bool, due: Date? }`, all strict domains. The route sends it to the cheap tier; a low-confidence result (calibrated, PT24.1b) is retried once on the stronger tier.
- **IT3.2** A `Message` triaged `act-now` or `this-week` with `needsReply` or kind `request` creates or updates the thread's `Todo`. `fyi` and `ignore` file the message and create nothing.
- **IT3.3** The to-do title is a decision result of type `Content` (a short summary), never read by a machine (PT20.1).

## IT4. Drafts

- **IT4.1** A draft is a decision `decision draft(thread: Items, history: Items) -> { body: Content, cites: Cite[] }`, on the strong tier. `Items` come from `retrieve` (M10) over the thread and earlier mail with the same correspondent, restricted to the draft's account (IT5).
- **IT4.2** A draft with no citation into its thread is rejected `uncited` (PT23.2).
- **IT4.3** For Gmail, an approved draft becomes the effect `gmail.createDraft`, gated, so the owner sends it from Gmail. Where sending is enabled, `gmail.send` follows a second approval. For SES, the approved draft becomes `ses.send` from an identity on the account's list.

- **IT4.4** **Creating a draft once (M7, S526).** Gmail drafts carry no idempotency key, so a second post of a draft whose first post may have succeeded leaves two drafts. `gmail.createDraft` is attempted once (`retry { attempts 1 }`), and the handler classifies the answer: 200 is `ok`; 400, 401, 403, 404 and 429 are **permanent** (a definite refusal, delivered as `failed -> NotCreated()`, from which the to-do may propose again); 408, any other status, and any transport error or timeout are **ambiguous** (delivered as `exhausted -> DraftUncertain()`). `DraftUncertain` takes the to-do from `Proposed` to `Uncertain`, which no automatic step leaves. The owner looks in Gmail and reports it: `DraftFound` (the draft exists) takes `Uncertain` to `Created`, and `DraftMissing` takes it to `Drafted`. The classification is a function of the status (`classifyDraftStatus`) and is tested for every status class.

## IT5. Rules, as properties the checker proves

| Rule | Form |
|---|---|
| No send without approval | `never emit send while draft.state != approved` (PS5.2), and the gate escalates every send to the owner (PT12.5) |
| No cross-account content | every `Content` carries its account as taint (M10); `PL6831` if a draft for account A can carry account B's taint; the gate's `audience` check at run time |
| Email is data | no machine reads `Content`; effects come only from typed decisions and owner actions; no handler can be reached from a message body |
| One open to-do per thread | an invariant over `Todo` instances keyed by thread |
| At most one draft created per to-do | the `Created` completion is reached at most once; `Uncertain` is left only by the owner (IT4.4, IAC10) |
| Every draft cited | reject `uncited` (PT23.2) |
| Budget never overspent | `Budget` reservations (PT24.3): reserved before each model call, settled after |
| Nothing processed twice | instance ids by provider id; creation of an existing id refused |
| A to-do always ends | every `Todo` reaches `sent`, `done` or `dismissed`, or is `snoozed` with a timer armed (no deadlock, PS5.6) |

## IT6. Records and erasure

Bodies, drafts and titles are `Content` in the erasable content store (S205). The journal holds digests, ids and decisions. Addresses move to the erasable store with S191. `poly forget --account` erases an account's bodies and addresses; replay marks them erased and still reproduces every post-state.

## IT7. Host

A TypeScript host on the owner's machine: it loads the admitted assistant, runs the adapters' polls, serves the local page on `localhost`, and exposes MCP tools (`inbox_list`, `todo_update`, `draft_edit`, `digest`). `draft_approve` and `send_approve` are never served over MCP: approval is the owner's (PT12.5). The host holds no rule; it calls `rt.dispatch` and renders state.

## IT8. Testing

- Recorded traffic only: Gmail API responses and SES (SQS, S3) payloads built from the providers' documentation, plus anonymized samples the owner chooses. No test reads a live mailbox or spends on a model; model calls are replayed from records (M11).
- A seeded fault for each rule of IT5, each caught by `poly check` or by the gate.
- A load test: a recorded backlog the size of a busy month, to measure the cost of triage per message and confirm the budget stops it cleanly.

## IT9. Open questions for the owner

1. **Q-I1.** Ruled (owner, 2026-10-06): the inbox assistant stands beside the concierge. The concierge stays the v1 release example (AC27); the inbox assistant is the second v1 example, with its own gate (IAC1 to IAC9).
2. **Q-I2.** Ruled (owner, 2026-10-08): drafts only for v1. The assistant writes Gmail drafts; the owner sends them from Gmail. No send scope is requested.
3. **Q-I3.** Ruled (owner, 2026-10-08): no linked accounts in v1. Each inbox is its own audience, and a draft uses only mail from its own account.
4. **Q-I4.** Ruled (owner, 2026-10-08): the digest is shown on the local page only; nothing is mailed.
5. **Q-I5.** Ruled (owner, 2026-10-08): polling through the history API for v1. Push through Pub/Sub is left for later.

## Conclusion

The inbox assistant is a daily tool that needs exactly what poly v1 provides: many accounts behind credentials, untrusted content that must never drive an effect, content that must not cross between accounts, model calls under a budget, and the owner's approval before anything leaves. Each of those is a property the checker proves, not a convention the code follows. It shows what poly is for on a problem the owner has today.

## Glossary

- **Account:** one Gmail mailbox or one SES receiving domain, with its own credential.
- **Digest:** the daily summary of open to-dos, waiting drafts and filed messages.
- **Draft:** a prepared reply, with citations, that the owner edits and approves.
- **Taint:** the account a piece of content came from, carried with it (M10).
- **To-do:** an item for the owner, one per thread at most, created from a message that needs action.
- **Triage:** the typed decision that sets a message's importance, kind and whether it needs a reply.
