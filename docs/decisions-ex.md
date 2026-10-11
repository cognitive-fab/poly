# poly v1 · Decisions for the examples

Steps, results and rulings of the examples branch `ex` (E1 the concierge, E2 the inbox assistant), in the order they happen. Each entry names who ruled.

## Set-up (2026-10-08)

- **Worktree.** `poly-ex` on branch `ex`, cut from m4 at fec4337f with `git worktree add ../poly-ex -b ex m4` from the main repository. The handoff (`handoff-v1-examples.md`) is on m4 only, not on main. Branch `v1` has no commit beyond m4 yet, so there is nothing to rebase on.
- **Plan.** `docs/plan-ex.md`, written before any code, reported for the reviewer's ruling. It brings S450 (the thread's principal), S451 to S454 (four core changes the inbox needs), S455 (a Gmail draft token can send) and Q-EX1 to Q-EX5. No example code is written until it is ruled, apart from E2.0, which depends on none of them.

## plan-ex ruled (owner's reviewer, 2026-10-08)

**Where the core changes are built.** S450, S451, S454 and S455's core half change semantics or security, so they are built by the release session on `v1`, after S402 and in this order, with PS and PT text first and tests written from the text alone. `ex` rebases on each as it lands. Nothing on `ex` changes the core.

- **S450, accepted.** A channel may declare `principal from <claims field>`: the thread's principal comes from the verifier adapter's verified claims for the sender, never from message content. Without it the recipient keeps no principal, as now. PS15.0a and PS17.3 are amended. Test: the concierge's reply citing customer A's orders reaches A; the AC22 variant sending them to B is a finding at check and denied at run time.
- **S451, accepted.** Mail is a source owned by its account's principal. A retrieval may add one equality on a key the source declares (message id, thread, correspondent); key values are opaque, compared only for equality, so renaming invariance (PS4.1c, PS4.1f) holds. Test: IAC3, mail of one account never reaches a draft of another.
- **S452, ruled.** poly-io's adapters are certified host code, not semantics. `ex` may add new adapter kinds to poly-io, additive only: new files, a registry entry each, a provenance file, recorded-traffic tests. No change to an existing kind or to the loader. A registry conflict at rebase is resolved by keeping both entries.
- **S453, deferred to after v1.** No new credential kind in v1. SES ships after the release with an `aws_sigv4` kind and its own ruling. Q-EX5 is accepted: Gmail only for the v1 gate.
- **S454, accepted.** An unrouted decision may name a budget; its call reserves its worst-case cost like a tier call (PS18.4, S360, S361 apply unchanged). Test: drafts and titles stop at the monthly cap of IF3.5.
- **S455, accepted, both halves.** On `ex`: two credentials, `gmail.readonly` for polling and `gmail.compose` for drafts, so the polling token cannot send. In the core: an effect target may be written `exact "<url>"`, matched on the whole URL; the inbox's draft effect uses it, so `.../drafts/send` is outside the gate. The release notes say that Google's compose scope permits sending and that the exact target is what prevents it.
- **Q-EX1 to Q-EX4, accepted as recommended:** two routed enum decisions for triage, due dates as buckets; snooze of 1d, 3d and 1w; SES read-only when it comes; the digest a view computed by the page from checked state, local only (Q-I4).
- **Id range S450 to S499, accepted.** The three calls recorded in the plan (the Notice machine, opaque account labels, person-signed approvals only) are accepted.
- **Google OAuth.** Confirm from Google's documentation: refresh tokens of an app in Testing expire after seven days, and `gmail.readonly` and `gmail.compose` are restricted scopes, which may require verification for an app In production. Bring the facts to the owner; the owner sets the Google project and its keys.

**Start now:** recorded traffic, the MIME reader (kept for SES after v1), the synthetic corpus, the Gmail adapter kind (S452), and the concierge parts that do not need S450. Then E1 after S402 and S450 land, E2 after S451, S454 and S455.

## Rebase on v1 (2026-10-08)

The plan's commit was rebased on `v1` at e5ffeee6 (S400 in PS and PT, its tests and its code). Nothing on `ex` touched what S400 changed.

## Start now, part 1: the corpus, the Gmail traffic, the MIME reader and the Gmail source (E2.0, S452)

- **The synthetic corpus** (`test/fixtures/inbox`): eight mails in three accounts (`work`, `home`, `club`), each written for the tests, on domains reserved for examples. Between them they hold what the reader and the triage must meet: a plain request with a due date, a reply in the same thread (quoted-printable with a soft break inside a UTF-8 character), an HTML-only newsletter with a script, a message whose text gives the assistant instructions (IAC4), RFC 2047 names and subjects in UTF-8 and ISO-8859-1, a base64 body, and a multipart message with a PDF attachment. `corpus.json` gives each message's account, ids, labels and `internalDate`.
- **The recorded Gmail traffic** (`test/fixtures/traffic/gmail`): one tape per account, by scenario (a first sync, a poll over two history pages, a quiet poll, and an expired cursor). `scripts/ex-gmail-traffic.mjs` builds them from the corpus, and `test/ex-gmail-traffic.test.mjs` checks the files are what it builds and that every request is a GET under the API's base. Each shape is cited in the tapes' `PROVENANCE.md`, read from the Gmail API reference on 2026-10-08.
- **The MIME reader** (`packages/poly-io/src/mime.ts`, `readMime`): headers unfolded and RFC 2047 decoded; base64 and quoted-printable; multipart by boundary, the plain part of an alternative; RFC 2231 parameters; charsets by `TextDecoder`. Mail is untrusted, so it never throws on content: it reads at most 8 levels and 200 parts, lists attachments without reading them, and names each problem. Kept in poly-io for SES after v1. Its sources are in `packages/poly-io/PROVENANCE.md`.
- **The Gmail source** (`packages/poly-io/src/gmail.ts`, kind `gmail`): the account's items are owned by its principal (S451); an item's id is `<account label>/<message id>`. A first sync reads the profile's `historyId` and lists the inbox once; a poll reads the history from the cursor, page by page; a 404 falls back to a list since the newest message kept. The cursor moves only after every item it covers is kept, and no kept message is fetched again, so a sync cut short is taken again with nothing twice and nothing missed. A sync reports the items not yet announced; the host announces them once it has created their instances, so a crash in between reports them again and the instance ids make that harmless (IT2.3). Every request goes through the host's function for the account, bound by the vault to the read credential, and is a GET under the API's base. A mail store in memory, and one in a directory named by an absolute `file:` path whose files are named by the SHA-256 of their keys.
- **The registry (S452).** Two entries, each additive: `gmail` in poly-core's `SOURCE_ADAPTERS`, which the checker reads for `PL6834`, and in the runtime's `SourceAdapter` kind type. No existing kind and no part of the loader changed. Read as the registry entry S452 allows; a conflict at rebase keeps both entries, as ruled.
- **Decided by the plan's rules.** The first sync reads one page (100 messages): older mail is not the assistant's, and the sync stays bounded. A poll reads at most twenty history pages and keeps its start when it stops early, so the next poll reads the rest. A message's text is kept to 32,768 characters. The key predicate of S451 is not in the adapter yet: `SourceQuery` has no key until S451 lands on `v1`; the store keeps each item's thread and correspondent for it.
- **Tests.** `test/ex-mime.test.mjs` (nine) and `test/ex-gmail-source.test.mjs` (nine) failed first, on the missing exports, and pass. Two seeded defects in the built adapter were each caught: fetching a message already kept (two tests failed) and ignoring an announcement (two tests failed). `test/boundaries.test.mjs`, `test/memory-sources.test.mjs`, `test/memory-runtime.test.mjs` and `test/channels-adapter-pin.test.mjs` pass with the change.
- **The full suite**, on `ex` rebased on `v1` at e1118211, with no other suite on the machine (`.poly/logs/a73d1b3a-2026-10-08T19-49-23-915Z-ex-e20.log`): 2,129 tests, 2,121 passed, 2 failed, 2 skipped and 4 waiting; check-memory passed. One failure was this step's: `tree-guard.test.mjs` found that `scripts/ex-gmail-traffic.mjs` writes files without the tree guard; it now calls `assertNotExperimentTree` before `--write`, and the file passes. The other is `v1`'s, not this branch's: `std-routing.test.mjs`, "the tests' std holds std.routing byte for byte". e1118211 wrote `disclosed` into `std/routing/routing.poly` and not into its copy `test/fixtures/std/routing/routing.poly`. It fails on `v1` as committed; `ex` changes no std file, so it is left to the release session and reported.

## Google OAuth, the facts for the owner (2026-10-08)

Read from Google's documentation, as the ruling asks:

- **Testing expires refresh tokens in seven days.** "A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of 'Testing' is issued a refresh token expiring in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile" (https://developers.google.com/identity/protocols/oauth2). The same page lists other ends of a refresh token: revoked by the user, unused for six months, the user's password changed when Gmail scopes are granted, and a cap of 100 refresh tokens per Google account per client id, beyond which the oldest is invalidated without warning.
- **Both scopes are restricted.** `gmail.readonly` ("View your email messages and settings") and `gmail.compose` ("Manage drafts and send emails") are classed Restricted; `gmail.send` is Sensitive (https://developers.google.com/workspace/gmail/api/auth/scopes). Restricted scopes "require restricted scope OAuth App Verification", and "If you store restricted scope data on servers (or transmit), then you must go through a security assessment" (the same page).
- **Personal use.** Google's verification help says a personal-use app with fewer than 100 users need not be verified, its users clicking through the "unverified app" warning, and that development, testing and staging projects are not subject to verification (https://support.google.com/cloud/answer/13464323).
- **What that means for the inbox, for the owner to decide.** In Testing the assistant would ask for consent every week. In production, unverified, for the owner's own accounts, it shows the warning once per consent and keeps its refresh tokens. The assistant keeps mail on the owner's machine; whether Google reads that as storing on a server is Google's to say, and the owner's to ask.
- **S455 confirmed.** `users.drafts.create` and `users.drafts.send` both accept `gmail.compose`, and `drafts/send` is a path under `drafts` (users.drafts.create and users.drafts.send reference pages).

## The concierge parts that do not need S450: what was found (2026-10-08)

Designing the joined module showed that every path of the concierge goes through the thread's identity, which S450 defines, so nothing of the module is built before S450's PS text lands. Two points for the reviewer, found on the way:

- **Q-EX6, the refund's holder.** `refund` uses `payments … for merchant`, a `Principal` payload field. A `Desk` created on inbound by `starts` gets no data, and a `Principal` has no literal, so the merchant has no source in the thread. M9's fixture took it from a staff member's dispatch. Recommended: the verifier gives it with the thread's claims, as the business number the message reached (K11), in the same claims S450 reads the customer's principal from, so S450's text names both. The alternative is a host dispatch that sets it on each thread.
- **The notice, decided by the plan's rules.** `Desk` cannot name a `Notice` instance: it holds no `Ref` to one, and a thread's application gets none at creation. So the host, which sees each escalation the gate raises, dispatches `Notify` to the staff thread's `Notice` (named with `rt.threadId`), and `Notice` posts through its own channel. The host forwards a fact and holds no rule; the approval stays a person's signed record. The std Slack conversation sends a reply when its slot is free even with no waiting message (`std/channels/slack.poly`, `Reply`), so one notice at a time, each after its receipt, is not refused `busy`.

## Rebase on v1 after m4 moved (2026-10-08)

`ex` was rebased on `v1` at f7ac8662 (V1 to V9, S400 to S402, the grant's replay, and the fast-forward of m4 to `v1`), with no conflict. S450, S451, S454 and S455 have not landed. The std routing copy that failed `std-routing.test.mjs` in the last suite is fixed on `v1`.

## E1.0: the concierge measured, and a gap in the generated configuration (S456, for a ruling)

The joined concierge is drafted in `docs/ex/concierge-draft/` (with its policy, price tables and maps), outside `examples/`, since `test/tv.test.mjs`, `test/validate.test.mjs` and `test/runtime-type.test.mjs` walk every file there and the draft is not yet the example. It has everything that does not need S450: the routed classification over the message body (S402), the refund amount by a typed decision of `{ value: 0..500 }` (AC30), the refund through the Stripe Connect credential with the policy escalating one above 100 by `machine("concierge.Desk").large`, a reply written by an unrouted decision from the message and the outcome, the template once after `window-closed` (AC15), and the staff `Notice`. The merchant comes from `Bind` until Q-EX6 is ruled.

**Measured** (`poly check`, nothing else measuring):

- **The first draft kept the amount in the state** (`amount: 0..500`) and ran out of the default 4 GB heap within a minute. The amount multiplies every state by 501. The draft keeps only `large: bool` (above 100), which is what the policy reads; the amount stays a strict `0..500` in the decision's answer and the refund's payload. Decided by the plan's rules.
- **With that, every machine is CLEAN**, in 4 min 34 s with a 12 GB heap: `Desk` 3,296 states and 3,381,696 transitions agreed by translation validation (the answer `value` explored over 0..500), `Notice` 32, `support.Conversation` 342, `staff.Conversation` 666, `payments.Grant` 13, `triage.Route` 6, `spend.Budget` 96. The generated configurations: `support` 171 global states and 3,506 steps, `staff` 112 and 5,773.
- **The verdict is INCONCLUSIVE, not CLEAN.** In `support`, `free-form-outside-window` is untested (its `while` holds and no send is taken from such a state) and `one-send-at-a-time` is vacuous (its `while` holds in no reachable state); in `staff`, `no-post-to-archived` and `one-send-at-a-time` likewise.

**Why.** PS15.5 gives a channel's generated configuration the inputs `starts`, the conversation's `Inbound` and the provider's receipts. It does not offer the completions of the application's own decisions and effects. A `Desk` that answers through a decision (`classify`, then `reply`) therefore never reaches `Answered` in the configuration, never sends, and leaves every rule of its conversation untested, so the program is at best INCONCLUSIVE (PS5.2a). The M8 concierge did not meet this because its `Desk` echoed each message straight back. Any channel application that thinks before it answers meets it, which is every application v1 is for; AC27 asks for CLEAN.

**A declared configuration does not fit.** A configuration `desk` declaring `Desk` with the completions as inputs (offered in every state, as S61 offers declared inputs) ran out of a 12 GB heap: once with `value: 0..500`, and again with `value: 0..2`, after 3 min 52 s. Declared inputs are offered whether or not anything is pending, and poly-ref keeps every global step, as S207's measurement found.

**S456, proposal (semantics, so for the release session if ruled).** A channel's generated configuration also offers, as inputs of the application, the completions of its pending decisions and effects, each only while its intent is pending, as PS17.3 already does for the flow rule and PS15.5 for an armed timer: a decision's `ok` over every answer and interval of its confidence and margin (PD1.4b) and its `failed`; an effect's `ok` and `failed`. A completion is offered once per pending intent. This is the model of the run (a completion arrives only for an intent in flight), it adds no input that cannot happen, and its size is bounded by the pending intents. Tests: the draft's `support` configuration has `free-form-outside-window` tested; a seeded control that offers no completion leaves it untested; the M8 concierge's counts do not change, since it has no pending completion. **Alternative:** each channel's configuration stays as it is, and the release notes say that an application that answers through a decision is checked INCONCLUSIVE by its channel's rules; AC27 would then not be met as written.

E1 stops here for S456, as the handoff's stop list asks (a needed change in the core). Q-EX6 is still open. What can go on meanwhile on `ex`: the concierge's recorded provider answers and host, which do not depend on the configuration.

## S456 and Q-EX6 ruled (owner's reviewer, 2026-10-08)

- **S456, accepted.** A channel's generated configuration also offers the completions of the application's pending decisions and effects, each only while its intent is pending. The release session builds it on `v1` right after S450; `ex` rebases on it.
- **Q-EX6, ruled.** The refund's merchant comes from the Stripe Connect grant, not program state. The host action `Bind` is removed.
- **Then.** `ex` carries on with the recorded model answers and the host code, and resumes E1 when S450 and S456 land. The concierge's state count and check time are reported when it reaches CLEAN.

## Q-EX6 built in the draft, and what it needs from the core (S457, for the release session)

`Bind` and the `merchant` field are gone from the draft; `refund(amount)` names no holder, and the credential declares none. The checker refuses that program today, twice: `PL1201`, "credential payments is granted by a person (authorization_code) and names no holder", and `PL6822`, "effect refund uses payments, a person's grant, and names no holder" (PT10e, PS16.2). PS16 knows a holder only as a `Principal` payload field (`for p`), or none for `client_credentials`, the service's own grant. So the ruling needs a form PS16 does not have yet.

**S457, proposal (semantics and security, so for the release session).** A credential granted by a person may omit `holder`: it then has one `Grant` instance, as a `client_credentials` credential does (PS16.2), whose holder is whoever completes the consent, recorded in the grant (by keyed digest, as now) and never readable by the program. An effect that `uses` it names no `for`. The grant check (PS16.3) reads that one instance. `rt.requestGrant(c, null)` asks for it. A credential with `holder Principal` keeps today's meaning, so no existing program changes. Tests: the draft's refund passes the check; a refund proposed while the one grant is `Revoked` is `credential-unavailable`; a credential with `holder` and an effect with no `for` stays `PL6822`. Until S457 lands, the draft is `REFUSED` at stage 0.

## E1: the concierge's recorded model answers and host code (2026-10-08)

- **Recorded answers** (`test/fixtures/concierge/answers.json`, with `PROVENANCE.md`): seven synthetic WhatsApp messages and the answers each decision gives them, classify per tier, amount, and a reply per outcome. Each answer sits on the side of a threshold the program, its route or its policy names: the small tier above the route's 0.8 (`status`), below it so the large tier answers (`refund-small`), both below so the route is exhausted (`unsure`); a refund under 100 and one above (`refund-large`); an amount of 650, outside `{ value: 0..500 }`, for AC30 (`refund-outside`); a message that tells the assistant to refund 500 (`injection`); and an amount below the program's 0.8 (`vague-amount`).
- **The recorded providers** (`examples/concierge/host/recorded.mjs`): each decision is answered by the message its materials hold (PS17.2, PS18.2), so no test writes a digest by hand, and a message the fixture lacks fails the call. What was asked is kept by message id, never by text. `provideRecorded` registers the two tiers and the two unrouted decisions.
- **The escalation forwarder** (`examples/concierge/host/notice.mjs`): for each refund intent escalated on a Desk, one `Notify` to the staff thread, naming the intent and how a person approves it, and nothing of the customer; a notice refused while the previous is in flight is sent on a later pass. Decided by the plan's rules: the text names no amount, since the host would have to read it from the proposal, and the person who approves reads the intent with `poly`'s own tools.
- **Where.** The host is in `examples/concierge/host/`, which holds no `.poly` file yet, so the tests that walk `examples/` are unchanged; the module joins it there when it checks CLEAN.
- **Tests.** `test/ex-concierge-host.test.mjs`, four tests, written with the code, since each reads the fixture's shape; two seeded defects were each caught (a forwarder that notices an intent twice, and a tier provider that ignores its tier: one test failed for each).
- **The full suite** (`.poly/logs/cd333e8b-2026-10-09T02-32-43-983Z-ex-e1host.log`, on `v1` at 283c5b2c, nothing else running): 2,153 tests, 2,146 passed, 1 failed, 2 skipped and 4 waiting; check-memory passed. The failure was this branch's, from 6e31841d: `standing.test.mjs`, "the standing rule covers every source in the repository", found the draft's two `.poly` files under `docs/ex`, where no standing directory holds them. A draft is not yet a source, so its files are now `concierge.poly.draft` and `concierge.policy.poly.draft`; they become `.poly` files in `examples/concierge/` when the module checks CLEAN. The test passes again.

## E1: the status path written from S450's text (2026-10-08)

S450's PS and PT text is on `v1` (283c5b2c), its code is not. The draft now has the status path as that text gives it: the channel `support` declares `audience customer` and `principal from principal`; `Got(body) by c: Customer` takes the thread's principal from the verified claims and keeps it as `customer`; a `Status` message retrieves `orders where owner == customer limit 3`, and the decision `answer(question, context)` cites the orders it used and answers the customer who asked. The checker refuses the draft at `principal from` (`PL0001`), as it must until S450's code lands; and the WhatsApp kind's `Sender` claims hold no `Principal` field yet, which PS15.0a's `principal from f` needs. The recorded answers gain the `answer` decision's entries, with the seeded orders, when the module first checks.

## E1: the status path checked, the Desk reduced, and two findings for the release session (2026-10-09)

`ex` was rebased on `v1` at f373e0fe (S450's code, S451, S454, S455, F3, F4 and the work-order key), with no conflict. The WhatsApp kind's `Sender` claims now hold `principal`, so the status path parses. Until S457 the draft is checked as a probe with the credential and its `uses` left out (nothing of the probe is committed; it is made by a script from the draft).

**Measured** (`poly check` with a 12 GB heap, nothing else running):

| Probe | Result |
|---|---|
| The draft with the status path, amount `0..500` | stopped at the one-hour background limit; `Desk` had about 5,300 states by its second pass at 7.5 min, and nothing more was printed |
| The same, amount narrowed to `0..2` | out of memory after 17 min 38 s |
| `Desk` alone, no channels, amount `0..2` | CLEAN in 1 min 32 s: 5,336 states, the flow rule 15,128 |
| The reduced draft, amount `0..2` | 8 min 37 s: `Desk` 686 states and its flow rule 974; `support` 339 global states, 7,006 steps, its flow rule 298,403 global states, CLEAN; `staff` 112 |
| The reduced draft, amount `0..500` | out of memory after 19 min 25 s |

So the cost was in the channel's configuration, whose flow rule follows every pending completion with its taint (PS17.3), not in `Desk` alone.

**The reduction, decided by the plan's rules.** `Desk` no longer keeps the last receipt (`last`, four values), which only gave each receipt handler a write; the handlers write `phase` instead. Every return to `Idle` clears the message and the reply, so an idle `Desk` is one state whatever it answered before. No behaviour changes: no handler read `last`, and an idle `Desk` reads neither field before `Got` writes it again.

**Finding 1, for the release session: `PL6838` on a channel's own conversation.** poly-ref reports `PL6838 FLOW_NOT_FOLLOWED` on `Desk`'s `Reply` and `Template` to `support.Conversation` ("no configuration of the program holds Desk and concierge.support.Conversation"), although the channel's generated configuration holds both and its flow rule followed those messages CLEAN over 298,403 states. `followed` in `packages/poly-ref/src/check.ts` counts declared configurations only, never the configurations a channel generates (PS15.5). S322 asks whether some configuration of the program holds the two; a generated one is one. A defect of poly-ref against S322; `ex` does not change it.

**Finding 2, for a ruling: AC30's domain and the configuration (S458).** With the strict `{ value: 0..500 }` of AC30, the reduced draft does not fit 12 GB; with `0..2` it checks in under nine minutes. The amount is explored over all 501 values, and in the configuration's flow rule each pending `amount` completion is offered with each of them; S456 will offer them in the configuration too. The program reads the value only by comparing it with 100 and passes it on in the refund's payload. **Proposal (semantics, for the release session):** a range-typed value that a machine only compares with constants and passes on in a payload, never storing it or doing arithmetic on it, is explored by the intervals those constants cut, as PT20.3 does for ages, remainders and counters, and as PD1.4b does for `Conf`: here `{0, 100, 101, 500}`. The verdict prints the cuts in its instance. The runtime still refuses any value outside `0..500` (strict, S400), so AC30 holds as written. **Alternative:** the example's domain is cut to what fits, which changes AC30's example and the refunds the concierge can make.

- **The full suite** (`.poly/logs/4a782928-2026-10-09T11-26-53-289Z-ex-status.log`, nothing else running): 2,210 tests and 6 after, 2,204 and 6 passed, no failure, 2 skipped and 4 waiting; check-memory passed.

E1's full check waits for S456, S457 and a ruling on S458; Finding 1 goes to the release session with them.

## Rebase on v1 at c8a03e09, and S458 accepted (owner's reviewer, 2026-10-09)

`ex` was rebased on `v1` at c8a03e09 (S456 with the generated configuration counted for `PL6838`, S457, the S454 embedded form), with no conflict. Ruled with it: S458 is accepted and is built next on `v1`; if `PL6838` still shows on `Desk`'s replies after the rebase, it is reported as a defect; the concierge's full check runs at `0..500` once S458 lands, with its state count and check time reported; E2 starts now; and the concierge's full check joins the serial after-suite group for the v1 gate, so suite load cannot affect it.

## E2.1: the inbox drafted and measured (2026-10-09)

The inbox is drafted in `docs/ex/inbox-draft/` (`inbox.poly.draft`, `inbox.policy.poly.draft`, the concierge's price tables, and maps fitted for `triage` and `kind` with their digests made by `mapDigest`), outside `examples/` and as `.draft` files until it is the example, as the concierge's draft is.

- **The program.** Each account's mail is the source `mail`, owned by the account's principal and keyed by `message`, `thread` and `correspondent` (S451), on the Gmail adapter. `Message`, one per received message, retrieves its own item by key and asks two routed decisions over it, `triage` (six values) and `kind` (eight), both on the cheap tier first (Q-EX1); it ends `Actionable` or `Filed`, or is `Held` when a decision failed, until the host retries it (IAC6). `Todo`, one per thread, reads the thread by key, asks `summary` (a `Content` title) and `when` (a `Due` bucket), and on the owner's request reads the thread again and asks `write`, on the strong tier, which cites the thread (IT4.1, IT4.2). Each of the three is an unrouted decision under the monthly budget (S454). An approved draft is `createDraft` through `gmail_draft` (`gmail.compose`) at the exact drafts URL (S455), to the account itself; the policy escalates every one to the owner (IAC2). `gmail_read` (`gmail.readonly`) is the poller's credential, used by the host through the vault for the Gmail source. Snooze is 24h, 72h or 168h (Q-EX2). The digest is the page's view (Q-EX4).
- **Decided by the plan's rules.** Every retrieval of one source shares the kind `source.mail.retrieve`, so it has one payload and one pair of completions (S41): both machines use `read(owner, k)`, completing `Read(items)` or `ReadFailed()`. A `Todo` reads its thread twice (title, then draft), since an `Items` is passed, not stored (S316). The draft reads the thread only; the earlier mail with the same correspondent (IT4.1's history) needs a second set of items in the same decision, which a second retrieval in another step cannot give; it is left for after v1 and listed as a limit. The `Message` that opens a thread's `Todo` cannot name it, so the host opens it, as the concierge's host forwards an escalation.
- **A defect of the first draft, found by the check.** A failed `triage` held the message while `kind` was still pending, and each retry left one more `kind` behind; poly-ref's flow rule stopped at its bound, `PL3901` ("decision.kind would hold more than 3 pending intents"), with the ten-step witness. A `Message` now waits for both answers before it holds or moves on.
- **Measured** (`poly check` on the module alone, nothing else checking but the concierge's probe): **CLEAN in 14.7 s.** `Message` 20 states, its flow rule 29; `Todo` 94 states, its flow rule 116; each `Grant` 13; each `Route` 6; `monthly.Budget` 96. Three principal representatives and two key representatives with `none` (PS4.1g). The policy is checked with the project, at E2.2.


## E1 after S456 and S457: what the concierge's check shows, and a choice for the reviewer (2026-10-09)

With S456 and S457 on `ex`, the draft is checked with its real credential (S457 lets the refund name no holder) and the amount narrowed to `0..2` until S458 lands (probes made by a script from the draft; nothing of a probe is committed).

| Probe | Result |
|---|---|
| The draft as committed, amount `0..2` | out of memory (12 GB) after 19 min 35 s, before any line of the report: S456's completions in the `support` configuration multiply what fit in 8 min 37 s before it |
| Without the stored reply (`answer`) and so without the template retry after `window-closed`, the order retrieval limited to 2, amount `0..2` | **1 min 58 s**: `Desk` 266 states, its flow rule 266; `support` 14,803 global states and 337,118 steps, its flow rule 16,723; `staff` 112; every machine CLEAN |

- **`PL6838` is gone** from `Desk`'s replies, as S456 meant: the generated configuration now counts. Not a defect.
- **`free-form-outside-window` is tested** in `support` for the first time, through S456's completions and S206's timers: AC15's rule is exercised.
- **The verdict is still INCONCLUSIVE.** Three rules stay untested: `support.one-send-at-a-time` (its `while` holds, and no send is taken from such a state), `staff.one-send-at-a-time` and `staff.no-post-to-archived` (no send at all in `staff`). The concierge never sends twice at once: `Desk` works on one message at a time and refuses another `busy`, and `Notice` waits for each receipt. On `staff`, `Notice` posts only on the host's `Notify`, which the generated configuration does not offer, so it never posts there. By the tested measure ruled at M8 step 10 (PS5.2a), a rule an application never comes near is vacuous and the program at best INCONCLUSIVE; M8 made the one-ticket application INCONCLUSIVE for `one-send-at-a-time` on purpose, as a control.

**Q-EX7, for the reviewer.** AC27 asks for `CLEAN`. Three ways:
1. **The concierge answers every message, as M8's did** (recommended): `Desk` acknowledges a message that arrives while it is busy with a short reply written by the `reply` decision (outcome `Busy`), so two replies can be in flight and `one-send-at-a-time` is exercised; and `Notice` answers each staff message with an acknowledgement, so `staff` sends. Both are behaviour a customer and a member of staff would expect. Cost to be measured; the reduced `Desk` leaves room.
2. **A declared configuration** that offers `Notify` as an input of `Notice`, beside the generated ones, for `staff`; `support` still needs (1).
3. **A ruling on the measure**: a `never` of a std conversation that the application provably never approaches is reported as unexercised but does not cap the verdict. That reverses M8's ruling and is the release session's.

**The template retry.** The probe that fits has none. A reply refused `window-closed` then ends the exchange, and the customer's next message opens the window again. AC15 asks only that the refusal be found at check and enforced at run time, which it is; the template follow-up was this example's own addition (plan 3.1). Proposed: drop it, and keep the stored reply out of the state. If the reviewer wants it kept, it is measured again after (1).

## E2: the inbox in examples/, keys in the Gmail source, and a gap in the core (S459, for a ruling) (2026-10-09)

- **The inbox stays a draft, for a reason in the test harness (for the release session).** Moved to `examples/inbox/`, it made the full suite fail three times (`.poly/logs/6b87142d-2026-10-09T16-23-51-881Z-ex-e2keys.log`: 2,254 tests, 2,245 passed, 3 failed, 2 skipped, 4 waiting; check-memory passed): `packages/poly-lang/test/check.test.ts` checks every file in `examples/` with `checkModule` alone, with no std, no provider profile and no route files, so a module that uses a credential, a route or a channel gets thirteen `PL1001`; and `test/tv.test.mjs` and `test/validate.test.mjs` build each example through `test/helpers.mjs`, which finds provider profiles only in the tests' std, where `google` is not (only `test-oauth` is). No example used a v1 surface before, so nothing met this. The concierge will meet it too (`stripe-connect`, a route, two channels). **Proposal:** the examples' checks resolve `use`, provider profiles and route files as `poly check` does, from `std/` and beside the source; `packages/` is the release session's. Until then both examples stay in `docs/ex/` as `.draft` files. With the inbox back there, the full suite (`.poly/logs/6b87142d-2026-10-09T16-49-20-222Z-ex-e2keys2.log`): 2,248 tests and 6 after, no failure, 2 skipped and 4 waiting; check-memory passed.
- **The Gmail source answers a retrieval by key (S451).** Each item gives `message` (its id) and `thread` (`<label>/<thread id>`); `correspondent` only through a keyed function the host gives (`correspondentKey`), so no address becomes a key and enters the journal (S191); without it a retrieval by correspondent is refused, never ignored. A key the source does not give is refused. `test/ex-gmail-source.test.mjs` gains the test, which fails with the key filter removed from the built adapter.
- **S459, a gap in the core: a handler cannot read the body of a `Content` in its own payload.** Only a channel's send resolves bodies; any other effect's handler is given digests (`packages/poly-runtime/src/capabilities.ts`, `worker.ts`). So `createDraft` cannot get the draft's text to send to Gmail. Nor can it get the reply's recipient, subject and threading headers: the program holds the correspondent only by a keyed key, the compose token cannot read the thread (`users.threads.get` takes no `gmail.compose`), and a recipient written by the model would let a message choose where its reply goes. **Proposal (for the release session):** (a) a handler is given read access to the bodies of the `Content` values of its own payload, and of nothing else, only once the flow check has allowed the intent (PS17.3), each read recorded by digest; (b) a source may give, by key, an envelope item for a thread (the recipient, subject, `In-Reply-To` and `References` of a reply to its newest message), which the program passes to the draft effect as a `Content` tainted by the account, so the recipient comes from the source and never from a decision. Until S459, E2 builds and tests what does not create a draft: IAC1, IAC3, IAC4, IAC5, IAC6, IAC8, IAC7 without a draft, and IAC9's check.


## Q-EX7 and the template retry ruled, S458 landed (owner's reviewer, 2026-10-09)

- **Q-EX7: option 1.** `Desk` acknowledges a message that arrives while it is busy, and `Notice` acknowledges each staff message. M8's rule stays: an unexercised rule keeps the verdict at INCONCLUSIVE.
- **The template retry is dropped for v1.** **Limit, for the release notes:** a free-form WhatsApp reply refused `window-closed` is not sent again as a template; the exchange ends, and the customer's next message opens the window again. AC15 holds as written: the variant that sends after the window gets a witness at check, and the conversation refuses the send at run time.
- **S458 landed** (bd52f07c, recorded at 1f1d17f4); `ex` rebased on `v1` at 1f1d17f4 with no conflict. S459 and the example harness fix are queued on `v1`.

## E1: the concierge CLEAN at 0..500 (2026-10-09)

The draft, as committed with this entry, has the ruled changes: `Desk` keeps no reply and has no template retry; its order retrieval is limited to 2; a message that arrives while it is busy gets an acknowledgement written by the decision `ack`, so two replies can be in flight; the `Desk` is idle again as it sends, and counts its sends in flight (`inflight: 0..3`) so each receipt settles one; `Notice` answers each staff message through the decision `noted`, and sends one notice at a time. The amount stays a strict `0..500`.

**The check** (`poly check` on the module, the policy apart, a 12 GB heap; the inbox's tests ran for about a minute of it, so the time is an upper bound, measured again in the after-suite group): **CLEAN in 6 min 27 s.**

| Machine or configuration | States | Steps or transitions |
|---|---|---|
| `Desk` | 1,826 (flow rule 2,978) | 107,734 transitions agreed by translation validation |
| `Notice` | 28 (flow rule 28) | 504 |
| `support.Conversation` | 342 | 20,178 |
| `staff.Conversation` | 666 | 49,950 |
| `payments.Grant` | 13 | 104 |
| `triage.Route` | 6 | 36 |
| `spend.Budget` | 96 | 2,976 |
| configuration `support` | 26,211 global states (flow rule 34,179) | 650,210 global steps |
| configuration `staff` | 3,620 global states (flow rule 3,620) | 194,795 global steps |

- **S458 at work:** `Amounted.value ∈ 0..500 at {0, 101} cut by {100}`, in the checked instance. `large' = value > 100` is a comparison with a constant, so the field write does not turn the reduction off.
- **No rule is vacuous.** `free-form-outside-window`, `one-send-at-a-time` (both channels) and `no-post-to-archived` are all tested; no `PL6838`.
- **A defect of the draft, found by the check:** `Got` wrote `customer'` before the `require` of its busy branch, `PL2101 WRITE_BEFORE_REQUIRE` (PT4.1); the write moved into each branch after its `require`.
- **Still to run:** the project's check with the policy (polycheck's regions and the decision table), and the after-suite test that runs it apart, once the harness fix lets the concierge move to `examples/concierge/`.

## E2.2: the inbox's first acceptance tests, and three findings (2026-10-09)

`test/ex-inbox-helpers.mjs` admits the draft as a project (its policy signed by a person), loads it over a store file, connects the compose credential's vault with a grant per account, the Gmail source over the recorded tapes, and recorded providers for every decision. `examples/inbox/host/inbox.mjs` is the host: one pass syncs an account, creates one `Message` per item not yet announced (`msg:<label>:<message id>`), and announces the items whose instance exists; `openTodos` opens a thread's `Todo` (`todo:<label>:<thread id>`) once a `Message` of it is actionable.

Found while writing them, each fixed in the draft or the harness:

- **The policy.** Admission found two findings. polycheck's `credential-egress` region reached `decision.triage` with no gate crossed (`PL7001`): each of the five decisions reads the account's mail and sends it to a model provider. The policy now gates them with an obligation that a model is asked only about mail no older than thirty days. And the `never` that a draft is never created without the owner was violated by design (`PL6503`): S149 counts an escalation that a person's approval would allow as an allow, so a `never` cannot say "only with an approval". It is gone. In its place, `createDraft` is labelled `read:private` beside `egress:external`, since it carries the account's mail out: without the escalation, polycheck's region reaches it ungated (`PL7001`), which is IAC2's witness at check.
- **A parameter named after a field hides it.** `Arrived(account, id)` wrote `account' = account` after `require … account == none`, and inside the handler `account` is the parameter: every arrival was refused `arrived`. The parameters are now `owner` and `item` (and `Open(owner, at, answer)`). No diagnostic said so; M8 refused a parameter named after a channel (`PL1002`, review A-F3) but not one named after a field. **For the release session:** a parameter that hides a state field could be `PL1002` too.
- **The read grant is the host's (Q-EX8, for the reviewer).** A credential that no program effect uses gets no vault in the certificate, so `rt.connectVault('gmail_read', …)` is refused ("no credential gmail_read; the certificate binds gmail_draft"). The source's syncs are the adapter's, not an effect's, as a Postgres connection is the host's. So `gmail_read` is no longer declared in the module: the host keeps the read-only grants in a vault of its own (`oauthVault`, `gmail.readonly`, one per account), and the source calls `withToken` through it. The token stays in a vault and never reaches the program, but the runtime's `Grant` machine does not track the read grant, and its revocation is the host's. The alternative is a source that names its credential, which is a change to PS17.0.
- **A defect of S41 with S451, for the release session.** Every retrieval of one source shares the kind `source.<s>.retrieve`, and S41 requires effects of one kind to agree on payload, completions and class; but the retrieval's key and limit are not part of that signature, and the manifest keeps one entry per kind. `Message` retrieved `mail` by `message == k limit 1`, `Todo` by `thread == k limit 5`; the check passed, and at run time both ran as the `Todo`'s, so the first message got its whole thread and the second an empty set (measured: `poly_items` held `[a02, a01]` for the first message's retrieval and `[]` for the second's). The draft now reads threads through a second source, `threads`, over the same mailboxes and adapter. **Proposal:** the retrieval's source, owner predicate, key and limit join the effect's signature, so two that differ are `PL1002`.

**Tests so far.** `test/ex-inbox.test.mjs`: **IAC1** (three accounts, every message once and tagged with its account, across a host crash after a creation and before its announcement; a pass with nothing new makes nothing; act-now and this-week messages actionable, fyi and ignore filed; one `Todo` per thread, the invoice's two messages opening one) and **IAC4** (the message that tells the assistant to forward mail, give a password and pay proposes only its own retrieval and its two decisions). Both failed before the code they test: IAC1 on the host's missing module, then on each defect above; both pass. IAC3, IAC5, IAC6, IAC7 without a draft, IAC8 and IAC9's check come next.

## The findings of E1 and E2.2 ruled (owner's reviewer, 2026-10-09)

- **The retrieval signature (S41 with S451): a defect,** given to the release session. The second source `threads` stays until the fix lands.
- **Q-EX8: the host vault is not accepted for the release.** A grant the runtime cannot revoke is the gap the inbox exists to close. The release session builds **S460, a source that names its credential**. The tests keep the host vault until S460 lands; then the inbox switches to it.
- **A parameter that hides a state field:** given to the release session as `PL1002`.
- **Both policy findings: accepted.** **Limit, after v1:** a policy cannot say "only with an approval": S149 reads an escalation that a person's approval would allow as an allow, so a `never` over an escalated kind is violated by design. The inbox states the draft's gate by its obligation and polycheck's region instead.
- **The template retry:** a limit for the release notes, as recorded above.
- **Memory: one heavy job on the machine at a time, across both sessions.** That covers a full suite and any run with a heap over 4 GB. Before each, this session checks that the release session runs none.
- **Order:** wait for `v1`'s "S459 recorded" commit and a quiet machine; commit the pending work; rebase on that commit, which brings S459 and the harness fix; move the concierge into `examples/`; one full suite after the rebase; record and commit; then the concierge's project check with its policy and the serial after-suite test; then IAC3, IAC5 to IAC8 (IAC7 with drafts, since S459 is in) and IAC9's check.

**What the full suite before this ruling did.** It started at 19:16, after the release session's suite had ended (`.poly/logs/e5d507ae-2026-10-09T19-16-59-850Z-ex-e1clean.log`, partial), and was stopped by Claude Code when the machine ran critically low on memory, with the release session at work beside it. It is not counted.

## Rebase on v1 at 0be8ef61 and bea21103: (a), (c), S460, S461 and the expected line (2026-10-10)

`ex` is rebased on `0be8ef61`, which carries the `Items` type check, the serial after-suite group, (a), S460 and (c). One conflict: `packages/poly-io/src/index.ts`, where S460 exports `credentialHandleOf` from `util.js` beside the Gmail and MIME exports. Both are kept.

- **(a), each machine runs its own retrieval.** The second source `threads` is gone. `Message` reads `mail` by `message == k limit 1`, and `Todo` reads `mail` by `thread == k limit 5`. The host connects one source, and IAC1 and IAC4 pass on it.
- **(c), the shadowing warning.** A parse of both sources, under the rule `poly check` applies, lists no action parameter named after a field of its machine. The inbox's parameters were renamed in E2.2.
- **S460, one account.** `gmailSource` takes `transport`: the runtime's handle for the source's credential. A source built with it has exactly one account, which gives no request of its own, and the adapter records the handle with `builtWith`, as `openSearchSource` does. This is additive under S452. `test/ex-inbox-read-grant.test.mjs` admits the draft with the holder-less `gmail_read` (`gmail.readonly`) named in the mail source, and checks five things:
  - The certificate binds vaults for `gmail_draft` and `gmail_read`.
  - An adapter the host built over its own request function is refused, `PL6408`.
  - The grant is requested by the person's signed grant request (S457, PT10g, holder: the account's principal).
  - Every Gmail request of the sync goes through the vault, which attaches the token, and no token is in the runtime's rows.
  - After `revokeGrant('gmail_read', null, …)`, the next sync fails `credential-unavailable` with no request reaching Gmail, while the account's compose grant stands.

  It passes. The adapter's refusal test adds four cases: two accounts with a handle, an account's own request with a handle, a handle with no `request`, and no request and no handle.
- **A gap in S460, ruled 2026-10-10.** A holder-less source credential has one grant, and a Gmail token reaches one mailbox, so S460 reads one account; IAC1 needs three in one assistant (IF4.1). The reviewer gave the release session S461, a grant per owner of an owned source, which it built on `v1` (`b49fce1c`, recorded in `bea21103`). No proposal from this branch was needed.
- **S461, on the rebase onto `bea21103`.** The draft's `gmail_read` now names `holder Principal`, and the mail source names it. The host's read vault is deleted: both credentials' vaults are the runtime's, and each account has a read grant, `rt.requestGrant('gmail_read', owner)`.
  - `gmailSource` is built with the routing handle `rt.credentialHandle('gmail_read')`, which `connectSource` requires.
  - Each account syncs through its owner's handle, `rt.credentialHandle('gmail_read', owner)`, given as the account's `request`. Every account gives one, or none does (S460).
  - The fake Google answers each Gmail request from the tape of the account whose token the vault attached, so a request under the wrong grant reads the wrong tape and fails.
  - **The S461 test** (in the same file) shows: three distinct read grants; an adapter built with one owner's handle refused (`PL6408`); each account syncing under its own token; after `revokeGrant('gmail_read', <work>, …)`, work's sync failing `credential-unavailable` with nothing sent; home and club still syncing under their own grants; and every compose grant standing.
  - **The S460 test** runs the same draft with `holder Principal` removed (`SOURCE_ONE_GRANT`), on one account.
  - IAC1 and IAC4 pass on the per-owner grants. With the two read-grant tests that is 4 of 4.
  - The adapter's refusal test now covers two accounts with a one-grant handle, a mix of accounts with and without a request, and a request that is not a function. It also accepts two accounts that each give one.
- **The expected line (V10 item 4).** `// expected: CLEAN` is now the first line of `examples/concierge/concierge.poly`, `examples/concierge/concierge.policy.poly`, and the inbox draft's module and policy.
  - **A finding for the release session.** The serial group checks each file of `examples/concierge/` alone. Alone, the policy file is `REFUSED`: `PL1001`, since `payments.refund` and `machine("concierge.Desk")` are names of the module beside it. No expected line can state that verdict. Its line states the ruled meaning (the concierge is `CLEAN` with its policy), so `test/after/serial-sources.test.mjs` will report it as a mismatch. The expected check could read a policy file with its program, or leave policy files out of the per-file comparison.
- **Order.** Then one full suite, counted in the next section.

## The suites after S459 and S461, counted (owner's reviewer, 2026-10-10)

**After the rebase on "S459 recorded".** One full suite, with no other heavy job on the machine (`.poly/logs/21432ef4-2026-10-10T10-40-32-198Z-ex-rebase459.log`): 2,290 tests, 2,283 passed, 1 failed, 2 skipped, 4 waiting; check-memory passed.
- **The one failure.** `test/runtime-type.test.mjs` (S140) refused `Found.items = {"count":0}`. The contract's data domain gives an `Items` field the representative `{ count }`, and the runtime's type check required a `ref` as well. The concierge is the first source with an `Items` action.
- **Ruled a core defect:** the `ref` is an opaque handle, and only the count is in the domain. The fix went to the release session and landed on `v1` (`c0e99891`). The work was committed as a checkpoint (`c87dfbab`, after the rebase), with the rulings not yet recorded.
- **The concierge in that suite**, beside the parallel suite: the toolchain-fault check took 434 s, translation validation 210 s and `validate()` 1.3 s, all passing. That run time is why the concierge moved to the serial after-suite group.

**After the rebase on `bea21103` (S461).** One full suite, with no other heavy job on the machine (`.poly/logs/855ec637-2026-10-10T14-34-53-989Z-ex-s461.log`):

| Run | Tests | Passed | Failed | Skipped | Waiting |
|---|---|---|---|---|---|
| parallel | 2,357 | 2,351 | 0 | 2 | 4 |
| serial after-suite group | 11 | 10 | 1 | 0 | 0 |

check-memory passed. The summary's "failures: 2" counts one of the four waiting tests ("M4c across an archive", waiting on polyrun tombstones at archive, S124) as a failure; the parallel run has none.
- **The concierge in the serial group:** `concierge.poly` checks with no toolchain fault, and its verdict matches its expected line `CLEAN` (74 s). Translation validation agrees (44 s), and strict `validate()` passes (0.6 s).
- **The inbox:** IAC1, IAC4 and both read-grant tests (S460, S461) pass.
- **Counted clean, apart from one known harness finding (ruled).** In the serial group, a policy file checked alone is `REFUSED` (`PL1001`). The group checks each file of `examples/concierge/` alone, and `concierge.policy.poly` names `payments.refund` and `machine("concierge.Desk")`, which are names of the module beside it. No expected line can state `REFUSED`, so `test/after/serial-sources.test.mjs` reports "the verdict is REFUSED, and the file expects CLEAN". The file's line states the ruled meaning, that the concierge is `CLEAN` with its policy. **The fix goes to the release session:** check a policy file with its program, or leave policy files out of the per-file comparison.

**Also ruled on 2026-10-10.** S461 went to the release session directly, so the proposal file written on this branch is removed. Every file of an example states its expected verdict on its first line (V10 item 4): the concierge's two files and the inbox draft's two say `// expected: CLEAN`.

**Next.** The concierge's project check with its policy, a heavy run, after checking that no release-session suite or probe is running. Then IAC3, IAC5 to IAC8 and IAC9's check.

## E1: the concierge's project check with its policy (2026-10-10)

The example's two files, maps and prices as a project, its policy signed by a person, checked by `checkProject` in its own process (8 GB heap; resident 2.1 GB at the end). No release-session suite or probe was running. It took 132 s, and its verdict is **FINDINGS**.

- **The module is CLEAN:**

| Machine | States | Transitions |
|---|---|---|
| Desk | 1,826 | 82,170 |
| Notice | 28 | 420 |
| support.Conversation | 342 | 16,074 |
| staff.Conversation | 666 | 41,958 |
| payments.Grant | 13 | 104 |
| triage.Route | 6 | 36 |
| spend.Budget | 96 | 2,976 |

  The configurations are CLEAN too: support at 26,211 global states, staff at 3,620.
- **The policy.** Five stages are CLEAN: policy-types, policy-lower, consistency, policy-admission and policy-tv. Two stages give findings, the same two the inbox's policy gave in E2.2:
  - `PL7001`, regions: the credential-egress region is reached by `decision.classify` with no gate crossed. A customer's message is sensitive, and a model call is egress. A policy of scope `concierge` that names any of the six decisions would gate it.
  - `PL6503`, never: `large-refund-unreviewed` is violated by an approved large refund (verdict `allow (approved)`). S149 reads an escalation that an approval would allow as an allow. This is the limit ruled on 2026-10-09: a policy cannot say "only with an approval".
- **For a ruling.** The inbox's fix was a gate on its decisions and no `never`. Here that means dropping the `never`, since the obligation already states the review. It also means an obligation over the six decisions whose condition can hold, and the concierge has no rule of its own to put there yet. The inbox's gate was freshness by `effect.items.age`. Most of the concierge's decisions carry no `Items`, so that condition would be unknown for them.

## The concierge's policy ruled, and its project check CLEAN (owner's reviewer, 2026-10-10)

**Ruled.**
- **The never statement is dropped,** as in the inbox. The refund rule's escalation of a refund above 100 to a person stays as the control. The limit (a policy cannot say "only with an approval") is recorded above.
- **Every decision is gated by its audience.** A customer-facing decision (`classify`, `amount`, `answer`, `reply`, `ack`) is denied when any input is above the customer audience, and the staff decision (`noted`) when any input is above the staff audience. No decision is left out.
- **The rule must be able to deny,** shown by a variant in the tests that feeds a staff note into `decision.classify`.

**Built.**
- `examples/concierge/concierge.policy.poly` has two new obligations, `customer-decisions` and `staff-decisions`. Each reads `effect.taint.class`, the join of a decision's inputs (PS17.2), and is `require false else deny` with `on unknown deny`. Every decision of the concierge takes a `Content`, so each is proposed with its taint.
- **What polycheck counts as a gate.** Its regions treat a decision as gated when any rule of the scope names its kind (`mentionedKinds`). The region check alone cannot tell whether the rule can deny, which is why the variant is needed.

**The variant,** `test/fixtures/ex-concierge/staff-classify.poly`.
- It is a module named `concierge`, so the concierge's policy governs it unchanged. Its staff Slack channel (`audience staff`) feeds each message into `decision.classify`.
- It declares the concierge's other decision kinds and the refund effect, so every kind the policy names is one of the program's.
- `test/ex-concierge-policy.test.mjs` passes three tests:
  - **The decision table.** poly-ref's decision table proposes `decision.classify` with each class and with none. `decide` denies the staff rows by `refunds.customer-decisions`, allows the public and customer rows, and denies a row with no taint, which is unknown to the rule. With the two audience obligations taken out, the same staff rows are allowed, so the deny is the rule's.
  - **With the policy:** regions find "credential-egress: every path crosses a gate", and the policy is CLEAN.
  - **Without the two audience obligations:** `PL7001`, region `credential-egress`, with the witness `decision.classify` holding `sensitive` and `egress`.
- **A stated property of the staff rule.** Nothing in this audience is above staff, so `staff-decisions` denies `noted` only when its taint is unknown. It still names the kind, which is what gates it, and it will deny once the audience has a class above staff.

**The project check with the policy.** No release-session run was active, and the check ran in its own process (8 GB heap; resident 1.99 GB at the end). It took 167 s, and the verdict is **CLEAN**.
- **The module:** Desk 1,826 states and 82,170 transitions; Notice 28 and 420; support.Conversation 342 and 16,074; staff.Conversation 666 and 41,958; payments.Grant 13 and 104; triage.Route 6 and 36; spend.Budget 96 and 2,976.
- **The configurations:** support at 26,211 global states, staff at 3,620.
- **The policy:** all seven stages CLEAN. Polyaxion's admission checked the coverage of all six rules (three obligations, each with its `on unknown`). policy-tv found 118 proposals agreeing. Regions report: lethal-trifecta unreachable, credential-egress with every path crossing a gate, source-egress unreachable. The never stage reports "no never statement".

## E2.2: drafts (S459), and IAC2, IAC3, IAC5 to IAC9 (2026-10-10)

**The draft path, built on S459.**
- **The source.** The mail source names `envelope thread`. `gmailSource` keeps each message's reply headers in its mail store beside its text: Reply-To or From, Subject, Message-ID and References. `envelope({ owner, key })` gives the envelope of a reply to the owner's newest item with that key: subject after one `Re: `, In-Reply-To the Message-ID, References the item's own followed by it (RFC 5322 3.6.4). It returns null for no item and refuses a key other than thread or message. A test covers it on the invoice thread, before and after the supplier's second message. The change is additive under S452.
- **The Todo.** `Propose` now retrieves the envelope (`retrieve mail envelope where owner == owner and thread == k`), and its completion `Enveloped(e)` emits `createDraft(account, t, e, body)` with `e` passed unchanged (PS17.3a). With no envelope, the draft stays `Drafted`. `createDraft` names `envelope e`, and `t`, the thread key, gives Gmail's threadId.
- **Measured.** Holding the envelope in a field took Todo from 6,682 states to 48,641 and the module's check to 609 s. Retrieving it when the draft is proposed gives 7,294 states and 83 s to 118 s, and is the newest message's envelope at that moment.
- **The handler,** `examples/inbox/host/drafts.mjs`. It reads its payload's envelope and body through `content.read`, writes one RFC 5322 message (the envelope's headers, the body as base64 UTF-8, a non-ASCII subject as RFC 2047 words), and posts `{ message: { raw, threadId } }` through `api` to the exact drafts URL. It refuses a header value with a line break and a thread key not of the form `<label>/<id>`. It never sends. `test/ex-inbox-host.test.mjs` covers it alone.

**The tests.** The test helpers now share one admission per source and policy within a file, register the handler through the certified handler file, and answer `drafts.create` in the fake Google with the account whose token came with it.

| IAC | Test | Shows |
|---|---|---|
| IAC2 | `ex-inbox-drafts` | A proposed draft is escalated and nothing is created. After the owner's signed approval, one draft is created, for the work account, under its compose token, in thread `19a2f0c4d1e70a01`. Its headers are the source's envelope of the supplier's second message, and its body is the recorded answer. Every Gmail request but drafts.create was a GET. |
| IAC3, run time | `ex-inbox-drafts` | The work draft edited into the home to-do's title (a body with the home account's taint) and proposed: `createDraft` is denied `audience` at the gate, and nothing is created. |
| IAC3, check | `ex-inbox-drafts`, `test/fixtures/ex-inbox/cross-account.poly` | The draft path cut to one machine, reading the thread under a second principal: `FINDINGS`, `PL6831` only, with the witness `Open -> Read -> Written -> Propose -> Enveloped` ("gmail.createDraft sends body, tainted (account, {p2}), to a recipient of class public and principal p1"). The same module reading under its own account is `CLEAN`. The inbox's own Todo with that change ran out of a 4 GB heap, so the fixture keeps only the parts the leak runs through. |
| IAC5 | `ex-inbox-drafts` | An answer citing a message of another thread is refused `uncited` (the citation observation is recorded), the draft is not kept, and the to-do stays `Open`. With the thread cited, the draft is kept. |
| IAC6 | `ex-inbox`, the cap at 0.04 usd | The cap must hold the largest reservation on the budget, the draft's 39,000 micro-usd (`PL6845` otherwise). Each triage or kind is unsure on the small tier and answered on the large one, at full usage, so a decision costs 12,708 and three fit. Of the work account's four messages, one is triaged and three are `Held`. The calls past the cap are denied `budget` at the gate. One budget instance holds the month; at every step spent plus reserved is within the cap, with no overrun; and no reservation is held at the end. The next month, a new budget instance holds a retry, which triages a held message from the source's store. |
| IAC7 | `ex-inbox-drafts` | A canary in the invoice's first message and a canary prefix in every token both vaults' endpoint issues, through a created draft. A scan of every table but the content store, every file of the project and the run, and everything printed, in four encodings, finds none. The content store holds the body, so the run did read it. |
| IAC8 | `ex-inbox-drafts` | After a run of two accounts through a created draft, a signed forget of the work account erases its bodies: the draft written from its thread is among them, and each erased digest reads null. The home to-do's title stays, and the source's work items are gone while the home ones remain. Chains verify. Replay folds every run with no divergence, the work to-do's steps that name the erased draft are marked forgotten, and the home to-do has none. |
| IAC9 | `ex-inbox-drafts` | The admission's check is `CLEAN` with its instance: Message 200 states, Todo 7,294, each Grant 13, each Route 6, monthly.Budget 96, and all seven policy stages `CLEAN`. After the draft path, every run replays with no diagnostic, none not run and no gate decision unreplayed: 65 runs and 369 rows, among them messages, to-dos, both routes' tier choices and the budget. The 3 gate sessions replay their 41 proposals. |

**A defect, for the release session: replay cannot fold a handler that reads an `Items` count.** `Written(text, cites)` first set aside an answer citing nothing with `if cites.count > 0`. The check passed (CLEAN, Todo 7,294 states), and the runtime ran it. Replay then refused the step: `PL9001`, "poly-ref cannot take Written: poly-ref: .count outside a step or reject property". The next step's pre-state was then not the fold. The count check is removed, so an answer citing nothing is kept as a draft: the runtime takes an empty citation as a subset of what was given (PS17.6). **For the release session:** either replay folds `x.count` of an `Items` parameter in a handler, as the checker and the runtime take it, or the checker refuses it. And whether a `cites` decision's empty citation should be `uncited` (IT4.2: each draft cites the messages it rests on).

**Ruled (owner's reviewer, 2026-10-10).** The concierge's policy and its variant test are accepted, the staff rule as stated. Both findings go to the release session: replay will accept a count read in a handler, and an empty required citation list will be refused `uncited`. When they land, this branch rebases, and IAC5 is fully met by the runtime: the to-do gets no `cites.count` check back.

**The combined run.** Every examples test file, one process at a time (`ex-concierge-host`, `ex-concierge-policy`, `ex-gmail-source`, `ex-inbox-drafts`, `ex-inbox-read-grant`, `ex-inbox`, `ex-mime`): 40 tests, 40 passed. `ex-inbox-host`, written during it, passes 3 of 3 on its own.

## IAC3 on the full inbox, with a 12 GB heap (2026-10-10)

As ruled, the full-inbox variant was run once in its own process with a 12 GB heap (`--max-old-space-size=12288`), after checking that nothing else heavy was running. The variant is the inbox draft's Todo with the cut-down fixture's one change: a second principal `other`, set by `Link(p)`, under which `WriteDraft` reads the thread. It ran out of memory after 571 s: the last mark-compact was at 12,269.7 MB of a 12,293.3 MB heap. The unchanged inbox checks in about 2 minutes, with Todo at 7,294 states. A second `Principal` field multiplies the Todo's states by the principals it can hold, and the flow rule follows each body's owners through them.

**So IAC3's evidence at check is the cut-down copy,** `test/fixtures/ex-inbox/cross-account.poly`: `PL6831` with the witness `Open -> Read -> Written -> Propose -> Enveloped`, and `CLEAN` when the thread is read under its own account. **Stated limit:** the full inbox with that change is not checkable within 12 GB. Its last heap figure was 12,269.7 MB at 571 s. At run time, IAC3 is shown on the full inbox: `createDraft` is denied `audience`.

## Rebase on v1 at db7ef72d, citations required, and S462 proposed (2026-10-10)

`ex` is rebased on `db7ef72d`, with no conflict. The rebase brings 58b59cd5 to db7ef72d: replay takes a count read in a handler as the checker admits it, and an empty or missing citation list on a decision with `cites` is refused `uncited` (PS11.4, PS17.6 as amended).

- **IAC3, ruled:** accepted. The check evidence is the cut-down copy, the run-time evidence is the full inbox's `audience` denial, and the 12 GB figure is a stated limit.
- **IAC5, now met by the runtime.** The to-do keeps no `cites.count` check, as ruled. Its test adds the answer citing none back: it is refused `uncited`, the second citation observation, and the draft is not kept.
- **The concierge's recorded `answer`** cites the fixture's ids among the orders it read, or, when none of them was returned, every order it read. A citation is now required, and a provider citing nothing would take the failed path.
- **The refund handler, ruled a fix before AC27.** The program carries only the amount, so the host would choose which charge to refund: the gap S459 closed for the envelope. The refund must carry the order, taken from the customer's own orders as retrieved. The handler refunds only that order's payment, and refuses if the order is not the requesting customer's or the amount exceeds what was paid. That stated limit is dropped once this is in.
- **What the language lacks.** A module cannot take an order's `Key` out of a retrieval: a `Key` enters only as data a host or a completion gives (PS1.4c), and a retrieval's `ok` binds only `r.items`, and `r.envelope` since S459. A handler reads its own payload's `Content` (`content.read`, PS17.4a), but not an `Items`' ids or owners.

**S462, for the release session (ruled 2026-10-10, option 1 of three):** a handler reads its own payload's item set.
- `items.read(ref)` works only on an `Items` in the handler's own payload, and returns the ids, owners and keys of that set only. Each read is recorded by digest, as `content.read` is.
- The refund's order must hold exactly one item. Any other count is refused before the handler runs.
- The handler refuses, with nothing sent, if the item's owner is not the payload's customer, or if the amount exceeds what was paid on that order's charge.
- Tests from the text: a forged or unstored ref, another customer's order, two items, and an amount above what was paid are each refused, and a valid refund is the control.
- **The concierge, once S462 lands:**
  - the refund effect carries `order: Items`, the cited subset of the customer's own retrieved orders, and `customer: Principal`;
  - the handler reads the order with `items.read`, reads the order's charge from Stripe, and refunds that charge.
- The two options not chosen: a retrieval binding the `Key` of its one item, checked for origin at the gate; and host-side records only, which leaves the gap.

**Order.** AC27 waits for S462 and for the release session's suite to end. Then this branch rebases, fixes the refund, checks that nothing heavy is running, runs AC27, and reports its divergences.

## The inbox tests after the rebase, and the recorded answer's citation corrected (owner's reviewer, 2026-10-10)

**Ruled.** When none of the fixture's order ids was returned, the concierge's recorded `answer` cites nothing. The earlier fallback cited every order it read, which made the answer cite items it did not use only to avoid the refusal. Now the answer is refused `uncited` and takes the failed path. The normal case is unchanged: it cites the fixture's ids among the orders it read. `test/ex-concierge-host.test.mjs` expects an empty citation for another customer's orders, and passes 5 of 5.

**The rerun.** The release session's `w9` had ended clean, and nothing heavy was running. Every inbox test file ran one process at a time (`ex-inbox`, `ex-inbox-drafts`, `ex-inbox-read-grant`, `ex-inbox-host`, `ex-gmail-source`, `ex-mime`): **35 tests, 35 passed**, in 806 s.
- **IAC1 to IAC9** all pass on the rebased branch.
- **IAC5** now covers an answer citing none, which the runtime refuses `uncited`.
- **IAC9's figures are unchanged:** Todo 7,294 states; 65 runs and 369 rows replay, and 3 gate sessions with 41 proposals.

**Next.** S462, then AC27.

## S462 in the concierge, and AC27 (2026-10-10)

`ex` is rebased on `8a1488fb` (S462: text `2cba85ef`, tests `46570170`, code `2fd29e66`) with no conflict.

**The refund acts on one order, as ruled.**
- **The path.** The refund branch retrieves the customer's own orders through the one `lookup` (rule (a): a second, differing retrieval of `orders` in the Desk would be `PL1002`), in a new phase `Finding`. `Found` branches on the phase. The `amount` decision now reads the message and the orders and `cites context`, so `Amounted(value, conf, cites)` carries the order the message is about. `refund(amount, customer, order: Items)` declares `one order`. `Items` is passed and never stored, so the cites reach the emit inside `Amounted`.
- **The source** declares `keys { charge }`: the order's own Stripe charge, as the source gave it, is what the handler refunds (S451, PS17.4b). `targets` is now the refunds URL and `https://api.stripe.com/v1/charges/`; the trailing slash admits a charge by its id and not `POST /v1/charges`, which creates one. The checker accepts it.
- **The guard is an `if`, not a `require`, and that departs from the ruling's wording.** `if cites.count == 1` guards the emit, and an answer that cites two orders is answered Unsure with nothing emitted. `test/ex-concierge-refund.test.mjs` shows why: a `require cites.count == 1` checks `CLEAN`, with no `PL3201`, but at run time a rejected completion leaves the Desk in `Extracting` with no reply to the customer. Unguarded, the emit is `PL6847` with the witness `Got -> Found -> Amounted`.
- **The handler** (`examples/concierge/host/refund.mjs`) reads the order with `items.read`. It refuses with no request sent unless the order's owner is the payload's customer. It then reads the charge (one GET) and refuses unless the amount is within `amount - amount_refunded` on a paid charge. Only then does it POST the refund, naming that charge, with the intent's key as Stripe's `Idempotency-Key` so a retried POST is the same refund. A refusal is a permanent error (a 4xx from Stripe too), so the effect fails at once and the customer is told it was declined. **The stated limit is dropped.**
- **"Nothing sent" is literal for the owner refusal only.** The amount refusal sends one read of the charge, and no refund.

**Tests** (`test/ex-concierge-refund.test.mjs`, 11 passing). At check: the guarded path is `CLEAN`, the unguarded one `PL6847`. The handler alone, with a fake `items.read` and `api`:
- the control: a valid refund of 40 on a 45 charge, then the whole 45, then 30 of what is left after an earlier refund;
- another customer's order, or none, refused with no request;
- an amount above what was paid, or above what is left, refused after one GET and no POST;
- a forged or unstored reference (`items.read` refuses it, `PL6406`), two orders, no order, an order with no charge or a malformed one, and an unpaid charge refused with nothing refunded.

At run time over the cut-down path: the control reaches Stripe with the order's charge, in cents, under the connected account, with an idempotency key; an amount of 60 on a 45 charge is declined after one read; an answer citing two orders emits no refund and reads no charge; a message about an order the customer lacks is uncited and answered Unsure; and the `require` variant strands the Desk. AC30 at run time: an amount of 650 is refused as the completion's type (`S140`, audited), nothing goes to Stripe, and the customer is answered Unsure.

**A defect for the release session: a decision with a record result gets no per-field confidence at run time.** PD1.2b and PT28.3a give `r.conf.f` and `r.margin.f` for each field of a record result, and the checker needs them (`r.conf` alone on a record is `PL1001`). The runtime's decision handler computes one scalar `conf` and `margin`, so the concierge's `Amounted(value: r.answer.value, conf: r.conf.value, …)` completes with `conf` undefined, and the step is refused: "Amounted.conf is undefined, outside 0..1000 (S140)". Every amount then took the failed path. It was found by the first run of such a decision. **Worked around, not fixed:** the `amount` decision returns the bare range `0..500`, which has the same strict domain and the same refusal of an answer outside it. PT28.3a's record pattern, `-> { value: 0..500 }`, is therefore not what the example uses, and the project check and every test above run on the range.

**The concierge's project check with its policy.** In its own process (8 GB heap; 2,267 MB resident), after this change: **CLEAN in 91 s**. Desk 2,114 states and 112,042 transitions (it was 1,826 and 82,170), Notice 28, the two conversations 342 and 666, Grant 13, Route 6, Budget 96; the support configuration 29,379 global states (it was 26,211) and staff 3,620. All seven policy stages are `CLEAN`.

**AC27 passes.** `test/after/ex-concierge-e2e.test.mjs`, in the serial after-suite group, drives the concierge end to end over recorded traffic. Two customers on WhatsApp, the staff on Slack, orders in Postgres with their charges, refunds through a Stripe Connect grant requested by a person's signed record, and every model call from `answers.json`:
- **Status:** the question is answered with the customer's own order cited, and sent to that customer (the Postgres retrieval was by `cust-a` only).
- **Refund under the limit:** the 40 on the lamp is unsure on the small tier and answered on the large, the handler reads `ch_ex1001`, and 4,000 cents are refunded under the connected account.
- **Refund over the limit:** 250 on the sofa is escalated with nothing sent to Stripe; the host tells the staff's Slack thread by intent and with nothing of the customer; a person's signed approval releases it, and 25,000 cents are refunded on `ch_ex2001`.
- **Replay:** the program is `CLEAN` with its instance printed (Desk 2,114, Notice 28, the conversations 342 and 666, Grant 13, Route 6, Budget 96). Replay folds **36 runs and 231 rows**, one of them the grant's, with the routes' tier choices among them, and **4 gate sessions with 43 proposals**: **0 divergences**. It took 123 s.

**The inbox after the S462 rebase.** The rebase brought S462's runtime code (keys kept with retrieved items, the items-count check), which the inbox's retrievals and citations run through. Every inbox test file was rerun, one process at a time, with nothing else heavy running: `ex-inbox`, `ex-inbox-drafts`, `ex-inbox-read-grant`, `ex-inbox-host`, `ex-gmail-source` and `ex-mime`. **35 of 35 pass** in 478 s, IAC1 to IAC9 among them. IAC9's figures are unchanged: Todo 7,294 states, 65 runs and 369 rows replayed, 3 gate sessions with 41 proposals.

**The serial group and the runtime type check after the change.** `test/after/*.test.mjs`: 12 tests, 11 passed. The concierge has no toolchain fault (87 s), its translation validation agrees (56 s), and AC27 passes again (121 s). The one failure is the known harness finding: the policy file checked alone is `REFUSED` (`PL1001`), which no expected line can state. `test/runtime-type.test.mjs` passes 6 of 6, with the `Items` and `Principal` of the refund among the actions it reads.

## The merge held, and why a require that rejects a completion checks CLEAN (owner's reviewer, 2026-10-10)

**Ruled.** The merge is held. The release session is fixing per-field confidence; when it lands, this branch rebases, switches the `amount` decision back to PT28.3a's record `{ value: 0..500 }`, and reruns the project check and AC27. **Accepted:**
- `if cites.count == 1` in place of `require`, with the Unsure reply on two orders.
- The owner refusal shown at the handler only, since the retrieval by owner stops it earlier.
- The amount refusal recorded as **no refund is sent**; one read of the charge is expected.

**The question.** The `require` version checked CLEAN, yet at run time a rejected completion leaves the Desk in `Extracting` with no reply. Would a liveness property, "every message the Desk takes is worked through to its end", have found it? The property is `phase != Idle leads to phase == Idle under fair { Classified | Unclassified, Found | LookupFailed, Amounted | Unextracted, Refunded | RefundFailed, Answered | Cited | AnswerFailed }`. Nothing heavy was running.

**The answer: the checker still says CLEAN.**
- **On a copy of the real concierge with the `require` version and the property,** the project check with the policy is CLEAN in 91 s (2,358 MB). Desk has 2,114 states, and the staff configuration 3,620.
- **The support configuration has 32,547 global states,** against 29,379 for the `if` version. Consistent with that, the configuration reaches states the `if` version does not, and reports none of them.
- **The property is not vacuous.** Without `Amounted | Unextracted` in the fair set, the same copy fails `PL3301` on Desk with a lasso. The cut-down refund path gives the same results, and `test/ex-concierge-liveness.test.mjs` keeps both (2 passing).

**Why.** The two models of a rejected completion are not the same:
- **The machine check offers a decision's completions as free inputs** (PS4.4), so the failed completion `Unextracted` is always still there. Under weak fairness of the group `Amounted | Unextracted` the adversary must take one, and does. At run time a decision gives one completion and its intent is consumed, so after a rejected `Amounted` nothing is left to take. That is the difference between the checker's model of a rejected completion and the runtime's.
- **The generated configuration matches the runtime.** PS15.5 (S456) says a completion, whatever its verdict, takes its pending intent off. But that configuration evaluates no liveness property of the application, and it has no finding for a rejected completion as it has for a rejected receipt (`PL5406`). So the stuck state is reachable there and nothing reports it.

**So it is a defect for the release session,** not a missing property in the concierge, and the property is not added to the real concierge: it would pass with the stuck Desk, and so say nothing. **Proposal:** a finding for a rejected completion of the application's own decision or effect in its generated configuration, as `PL5406` is for a receipt, since the intent is consumed and no other completion will come. A handler that can reject a completion's data, as `require cites.count == 1` can, is then a finding, and the `if` guard is the fix.

## Conclusion

The examples branch holds the plan and its ruling, the inbox's synthetic corpus and recorded Gmail traffic, the MIME reader and the Gmail source kind, the concierge in `examples/concierge` (CLEAN at 0..500, checked in the serial after-suite group) with its recorded answers and host code, and the inbox draft on one source with a read grant per account (S460, S461). The suites after S459 and S461 count as clean, apart from one harness finding for the release session. The concierge checks CLEAN with its policy. The inbox meets IAC1 to IAC9 on recorded traffic, IAC5 in full once the release session's citation fix lands.
