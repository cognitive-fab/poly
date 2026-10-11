# poly v1 · Plan for the examples (E1, E2)

*Cognitive Fab · October 2026 · written before any example code · on branch `ex` in the worktree `poly-ex`, cut from m4 at fec4337f · from `plan-v1.md` (E1 to E3), `proposals/example-inbox.md` (Q-I1 to Q-I5 ruled), `proposals/v1-functional-spec.md` (AC15 to AC30), `decisions-v1.md` (S400 to S402) and `decisions-m8.md` to `decisions-m11.md`*

Status: for the reviewer's ruling. Nothing is built. The worktree exists and holds only this plan and `decisions-ex.md`.

## 1. What this plan covers

Two applications built on poly v1, as the release plan names them:

- **E1, the concierge**, the release example. It joins the four surfaces that today live in four separate fixtures (`conformance/m8/concierge`, `test/fixtures/m9/concierge-refund.poly`, `test/fixtures/m10/concierge-memory.poly`, `test/fixtures/m11/desk.poly`) into one program, and meets AC15, AC18, AC22, AC27 and AC30.
- **E2, the inbox assistant**, the owner's daily tool. It meets IAC1 to IAC9 on recorded traffic.
- **E3, the checked harness**, is out of this plan. Q-V2 recommends it after the release; it enters only if the owner rules it in.

Reading the specs against the code found that neither example can be built as specified on m4 as it stands. E1 needs one ruling on semantics (section 3.6). E2 needs four changes in the core and has one security finding (section 4.3). Each is brought here with a proposal, as the handoff's stop list asks. The rest of the plan is what I build once they are ruled.

## 2. Common rules

- **Layout.** Each example lives in `examples/<name>/`: its modules, policies, price tables and maps, and its host code in `examples/<name>/host/`. Recorded traffic lives in `test/fixtures/traffic/<provider>/` with a `PROVENANCE.md` naming the documentation each shape was read from, as M10 did for OpenSearch. Tests are `test/ex-<name>-*.test.mjs`.
- **Measured files.** `scripts/measure-verdicts.mjs` walks `examples/`, so each new `.poly` file becomes a measured file. These are additions, not changes: the existing 160 stay identical. Each addition is listed with its verdict and counts in `decisions-ex.md`, so the V10 gate can tell an addition from a change.
- **Tests first.** Each acceptance criterion gets a test that fails before the code that meets it. A test that cannot fail first (a control, a confirmation) is labelled so.
- **Recorded traffic only.** No test calls Gmail, AWS, WhatsApp, Slack, Stripe or a model. Model answers come from `recordedProvider`. Test secrets are generated in the test and never written to disk, except a key file outside the repository that the test deletes, as M9 ruled.
- **Synthetic fixtures.** Every mail, order and message in a fixture is written for the test. No real address, name or body. Addresses use reserved domains (`example.com`, `example.net`).
- **Suites.** One suite at a time on the machine: before a full suite I check that no `node --test` runs from `poly-v1`. Targeted tests while building; the full suite with `scripts/suite-summary.mjs` before each commit; the log cited by path.
- **Rebase.** After every commit the release session reports that changes PS or PT text, `ex` rebases on `v1`, and the example tests run again.
- **Spec issues.** The examples take spec issue ids from S450 to S499, after the release's S400 range. They add no diagnostic code: a code is the core's.
- **Records.** `docs/decisions-ex.md`, one entry per step, with polywatch findings marked real or false and why.

## 3. E1: the concierge

### 3.1 The program

One module, `examples/concierge/concierge.poly`, with its policy in `concierge.policy.poly`.

| Declaration | What it is | Surface |
|---|---|---|
| `audience { public < customer < staff }` | the classes | M10 |
| `claims Customer { verified: Verification, principal: Principal }` | the WhatsApp sender's claims | M8, PD5 |
| `claims Staff { role: Role, principal: Principal }` | a member of staff, with a mandate for an agent | M9, PD6 |
| `channel support: whatsapp` | customers; `starts Desk.Start on inbound`; receipts to `Desk` | M8 |
| `channel staff: slack` (or `webhook`, see 3.7) | the escalation notice to staff | M8 |
| `source orders: records` | `adapter "postgres"`, `audience customer owned`, `freshness 1h` | M10 |
| `credential payments: oauth2` | the `stripe-connect` profile, `refunds.write`, holder the merchant | M9 |
| `route triage` and `budget support` | two tiers, `flash` then `opus`, per run and per day caps | M11 |

Machines:

- **`Desk`**, one per WhatsApp thread. On `Got(body)` it asks the routed decision `classify(body: Content) -> Branch` (`Status`, `Refund`, `Other`); this is the routed decision over a body that S402 (V3) allows. On `Status` it retrieves `orders where owner == customer`, asks `answer(question: Content, context: Items) -> Content cites context` (one provider, not routed: PL6839 still refuses a routed `Content` result), and emits `support.reply`. On `Refund` it asks `amount(text: Content) -> { value: 0..500 }` (AC30, PT28.3a), then emits `refund(merchant, amount)` through `payments`. On `SendRejected("window-closed")` it sends the `FollowUp` template.
- **`Notice`**, one per merchant, bound to the staff channel. `Desk` sends it `Escalated(amount)` with no `Content`, so no tainted value crosses outside a configuration (S322) and no application sends on a channel other than its own (no joint configuration, S207).
- The std machines the surfaces bring: `support.Conversation`, `staff.Conversation`, `payments.Grant`, `triage.Route`, `support.Budget`.

Policy, signed by a person key in the tests (S194): a refund up to the limit is allowed within the agent's mandate; above it, escalated. An escalation is approved only by a person's signed record through the approvals folder (S189, PF9.6); a Slack message never approves (AC17).

### 3.2 Adapters and fixtures

All fakes are certified poly-io adapters fed recorded traffic, as M8 to M11's tests do: the WhatsApp Cloud adapter over recorded webhooks; the Slack (or webhook) adapter; `oauthVault` with the `stripe-connect` profile over recorded token and refund responses; `postgresSource` over a query function on seeded rows for two customers; `recordedProvider` for `flash`, `opus` and the two unrouted decisions. The host, `examples/concierge/host/run.ts`, admits, loads, connects each adapter and serves ingress. It holds no rule.

### 3.3 Acceptance criteria and their tests

| AC | Test | Fails first because |
|---|---|---|
| AC15 | a variant whose `Reply` sends whatever the window gets `PL3002` in `support` through `WindowExpired`; at run time a reply after the recorded window closes is rejected `window-closed` and the template follows | the example does not exist |
| AC18 | the canary scan of M9 (tables, project, build, certificate, output; four encodings) over the whole concierge suite, tokens prefixed by a canary generated in the test; its seeded control (a handler that prints the token) is found | as above |
| AC22 | the variant with `where owner == customer` removed gets `PL6831` with its witness; loaded through a witness certificate, its reply is denied `audience` before its handler runs | as above |
| AC27 | end to end over recorded traffic: a status question answered with cited orders, a refund under the limit through the credential, one over it escalated, noticed to staff and approved by a person key; the program `CLEAN` with its instance printed; `poly journal replay` reproduces every post-state, gate decision and tier choice, the grant included once V4 lands | as above; the grant replay waits on V4 |
| AC30 | the refund amount comes only from `amount`; a recorded answer of 650 is rejected at dispatch, journaled, and no refund is proposed | as above |

### 3.4 Steps

1. **E1.0 Measure first.** Check the joined module with poly-ref and record the state counts per machine and per generated configuration, and the flow rule's count. The baseline: `support` 14,482 global states (M8 step 10, with timers), `concierge-memory` 28 states, the help desk's flow rule 29,444. If any count reaches the checker's bound, stop and bring the numbers (as S300 ruled for M10).
2. **E1.1** The tests of 3.3, failing.
3. **E1.2** The module, the policy and the host, until the tests pass.
4. **E1.3** After V3 lands on `ex` by rebase: `classify` over the body, its tier calls proposed with the decision's taint, and a policy denying a tier by `effect.taint.class`.
5. **E1.4** After V4: AC27's grant replay.
6. **E1.5** The full suite, the record, a commit per step.

E1.0 to E1.2 can start before V3, with `classify` stubbed as a routed decision over a typed field; the stub goes when V3 lands.

### 3.5 Measured risks

- **State space.** Four surfaces in one configuration. Mitigation: E1.0 measures before anything else. The `Notice` split keeps each configuration to one channel.
- **The window rule is vacuous** if no path closes the window after a message. M8 step 10 showed it tested in `support`; E1.0 runs the vacuity report again.
- **V3's shape is not yet written.** E1.3 follows its PS text.

### 3.6 For a ruling: the thread's principal (S450)

S314 (M10) left this to the concierge: "a channel thread's principal is a question for the concierge example of the v1 gate". As written, PS15.0a gives a channel's recipient no principal, so an item owned by customer A reaches the WhatsApp reply only by class. Then AC27's reply, citing the customer's own orders, is refused unless the channel's class is `staff` or above, and with that class any customer can read any customer's orders, so AC22's guarantee is empty on the real path. At run time S327 names the sender by the keyed digest of `whatsapp:<address>`, and the orders by the keyed digest of `principal:<p>`, so the two never meet either.

**Proposal.** A channel may declare `principal from <claims field>`: the sender claims' `Principal` (PF11.3) becomes the thread's principal, fixed at the thread's first verified message. PS15.0a and PS17.3 give the conversation's provider effect that principal as its recipient. Ingress records it beside the thread, and S327 taints a received body with that principal as owner. A message whose claims name another principal on an existing thread is refused (a new reserved reason). The verifier adapter maps a verified phone number to the merchant's customer principal (K11). PS text first, then the core: this is the release session's work or an approved change on `ex`, as the reviewer rules.

**Alternative.** The reply carries no owned content: the answer is a typed decision (an order status enum) and the cited text never leaves. AC27's "citing the orders it used" then holds only as citations recorded in the journal, not as text sent.

### 3.7 Decided by the plan's rules, recorded

- **The notice.** The std Slack conversation answers waiting messages (its `Reply` settles one). An unsolicited notice may be refused `busy` or `PL5407`. E1.0 measures it; if it is refused, the notice goes on `std.channels.webhook` to the merchant's Slack incoming webhook, which is a provider send like any other. Either way it is an effect through the gate, never a host post.
- **The provider.** `stripe-connect` from std, not the tests' `test-oauth`, since the release example should run on a shipped profile. Its recorded traffic follows S208 (the platform key, the `Stripe-Account` header).

## 4. E2: the inbox assistant

### 4.1 Where IT1 meets the language

| IT item | As specified | What m4 allows |
|---|---|---|
| IT2.1, IT2.2 | Gmail and SES bodies enter as `Content` tainted by their account | A host can store a body only with `rt.putContent`, which gives it `⊥`. Only `rt.receive` (a channel) and the runtime's retrievals and decisions store a body with a taint. A `⊥` body flows to every account, so IAC3 cannot hold. |
| IT2.4 | an IAM key pair for SES in the vault | `credential` is `oauth2` only, and the vault speaks OAuth 2.0. SQS and S3 need AWS Signature Version 4. |
| IT3.1 | `triage -> { importance, kind, needsReply, due: Date? }`, routed | A routed decision does not return a record (M11 step 5). There is no `Date` type. |
| IT3.3, IT4.1 | title and draft are decisions with a `Content` result; the draft cites | PL6839 refuses a routed `Content` result and `cites` (S402 keeps both refused), so both decisions are unrouted, and only a routed decision has a budget (PS18.4). Drafts and titles would spend outside IF3.5's limit. |
| IT4.1 | `retrieve` over the thread and earlier mail with the same correspondent | A retrieval's only predicate is `owner == p` (`SourceQuery { owner, limit }`). |
| IT5 | one open to-do per thread | a structural fact if each `Todo` instance is keyed by its thread (below) |

### 4.2 For a ruling: four changes in the core (S451 to S454)

- **S451, mail as an owned source read by key.** Proposal: a source declares typed item keys (`keys { message, thread, correspondent }`), and a retrieval may add one equality on a key: `retrieve mail where owner == account and thread == t limit n`. `SourceQuery` gains the key. The Gmail and SES adapters return items owned by the account's principal, so every body a decision reads is tainted `(class, {account})` by the machinery M10 already has. A `Message` instance holds no body: it retrieves its own item by `message == id`. This one change covers IT2.1, IT2.2's taint and IT4.1, and adds no new way for a body to enter. The alternative, a host call that stores a body with a taint it names, would make the host the author of taints, against K14.
- **S452, adapter kinds in poly-io.** `rt.connectSource` takes only an adapter that the certified poly-io made, of kind `postgres` or `opensearch`. The Gmail and SES sources must therefore live in `packages/poly-io/src/sources/`, as M10's two did, with their kinds added to the type and the certificate. Proposal: that counts as adapter code on this branch (S182 puts all network code in poly-io), reviewed like M10's adapters. If the reviewer reads it as core, it is the release session's.
- **S453, AWS credentials.** Proposal: a credential kind `aws_sigv4 { region, service, holder none }` whose vault entry is the key pair the owner sets, and whose `withToken` signs the request (SigV4) inside the adapter, with `targets` bound to the queue's and the bucket prefix's URLs. Grammar, checker (`uses` scopes become IAM actions: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `s3:GetObject`), the vault and a provider profile. Alternative: SES enters v1 later, and E2 ships Gmail only (see Q-EX5).
- **S454, a budget on an unrouted decision.** Proposal: an unrouted decision may name `budget b` and its own `max input tokens` and `max tokens`; its call reserves and settles as a tier's does (PS18.4), with no route machine. Then drafts and titles stay under the monthly cap. Alternative: lift PL6839 for a `Content` result and `cites` on a route, which needs the runtime to keep a tier's answer with its taint and check its citations per tier.

### 4.3 A security finding (S455)

Q-I2 rules "drafts only, no send scope". Two facts make that a promise of the program, not of the token:

1. Google's `gmail.compose` scope, which `drafts.create` needs, also permits `drafts.send` and `messages.send` (Google's scope list: "Manage drafts and send emails"). No Gmail scope creates drafts without the power to send.
2. An effect's `api` is bound to its declared targets by prefix (`withinPrefix`, S151): `/gmail/v1/users/me/drafts` covers `/gmail/v1/users/me/drafts/send`, and `/gmail/v1/users/me/messages` covers `/messages/send`. Targets do not name a method.

So a certified handler for the poll or the draft could send mail, and the gate would not see a send. Proposal, in two parts. (a) On `ex`, no core change: two credentials per account, `gmail_read` (`gmail.readonly`) and `gmail_draft` (`gmail.compose`), so the poller's token cannot send at Google at all; and the draft handler is reviewed and lint-tested to post only to `drafts`. (b) In the core: an exact target form (`targets { egress exact "…" }`, or a method and path), so the gate binds the draft handler to `POST …/drafts` and nothing under it. Until (b), the release notes state that "drafts only" rests on the certified handler, not on the gate.

### 4.4 Choices for a ruling, with a recommendation

- **Q-EX1, triage's shape.** Two routed decisions on the cheap tier: `triage(m: Items) -> Triage` with `{ ActNowReply, ActNow, WeekReply, Week, Fyi, Ignore }` (importance and the need for a reply in one enum), and `kind(m: Items) -> Kind` with IF2.2's eight values. A to-do also gets `due(m: Items) -> Due { None, Today, ThisWeek, Later }` in place of a date: the digest sorts by bucket, and no `Date` type is needed. Recommended. The alternative is a core change that lets a routed decision return a record.
- **Q-EX2, snooze.** `after` takes a constant duration, so a snooze is one of `1d`, `3d`, `1w`, each a timer. Recommended over a host that wakes a to-do at a date, which would put a rule in the host.
- **Q-EX3, SES replies.** Q-I2 rules drafts only for Gmail. SES has no draft. Recommended: SES inboxes are read only in v1 (triage, to-dos and drafts shown on the page, no `ses.send`), so nothing leaves on SES either.
- **Q-EX4, the digest.** A `Digest` machine cannot read other machines' state. Recommended: no `Digest` machine; the page computes the counts from `rt.getState` of the instances, as a view, and holds no rule. The alternative is a `Digest` instance per day that every `Todo` and `Draft` messages, which adds a configuration and taint-free counters.
- **Q-EX5, scope of E2 in v1.** If S453 is not ruled into v1: E2a, Gmail only, for the v1 gate; E2b, SES, after. Recommended, since S453 is the largest of the four.

### 4.5 The program, once ruled

Module `examples/inbox/inbox.poly`, policy `inbox.policy.poly`. Each account is a `Principal`; an account's mail is a source owned by it, so each inbox is its own audience (Q-I3).

| Machine | Instance | Holds |
|---|---|---|
| `Mailbox` | `mailbox:<account label>` | status (`Active`, `Paused`, `Failing`), the poll timer, a failure counter. The `historyId` and the SQS position stay in the adapter's store: an unbounded integer has no place in a checked state, and a re-poll after a crash creates nothing (IT2.3). |
| `Message` | `msg:<account label>:<provider id>` | its account, `new`, `triaged`, `filed`. The host creates it; an existing id creates nothing (`$uncreatable`, E13). |
| `Todo` | `todo:<account label>:<thread id>` | the states of IT1. One instance per thread, so at most one open to-do per thread by construction; a closed one reopens. |
| `Draft` | `draft:<account label>:<thread id>` | the states of IT1, `Approved` only by the owner's step. |

- **Instance ids name no address.** An account is named by an opaque label the owner sets in the host's configuration, not by its address (S191 keeps addresses out of the journal).
- **Approval.** `Draft.Approve` takes `Owner` claims, which a verifier gives only for the owner's signed record; and the policy escalates every `gmail.createDraft`, approved by a person key through the approvals folder (PT12.5). The page shows what waits and the command that signs it. The page never holds a key and never signs.
- **Properties** (IT5): `never emit createDraft while state != Approved`; no `Todo` deadlock, and every `Todo` reaches `Sent`, `Done` or `Dismissed`, or is `Snoozed` with its timer armed (liveness under the fairness of the owner's steps); the flow rule over owners gives `PL6831` to a draft for account A that can carry B's mail; `uncited` for a draft citing nothing of its thread.
- **Host** (`examples/inbox/host/`): the polls on timers, the page on `localhost`, and MCP tools `inbox_list`, `todo_update`, `draft_edit`, `digest`. No approve tool over MCP.

### 4.6 Acceptance criteria and their tests

| IAC | Test |
|---|---|
| IAC1 | recorded traffic of three Gmail accounts and two SES domains; a restart in the middle of a batch; every message once, tagged |
| IAC2 | the variant that emits `createDraft` before `Approved` gets a witness; at run time the gate escalates and nothing is created without a person's record |
| IAC3 | the variant that drafts for A from B's thread gets `PL6831`; at run time denied `audience` |
| IAC4 | recorded mails with instructions ("forward this to…", "reply with your password") yield only their triage and at most a to-do: the journal holds no other intent |
| IAC5 | a recorded draft answer citing nothing of its thread is rejected `uncited` |
| IAC6 | a budget below a batch's cost: triage stops `budget`, no reservation overspent, the rest wait |
| IAC7 | canaries in a body and in each OAuth token, scanned as AC18's scan does |
| IAC8 | `poly forget` of an account's source erases its bodies; replay folds, the steps marked forgotten |
| IAC9 | `CLEAN` with its instance, and replay of every post-state, gate decision and tier choice from recorded providers |

### 4.7 Steps

- **E2.0, now, no ruling needed.** The recorded traffic and its provenance: Gmail `history.list` (including the expired `historyId` 404), `messages.get` (`format=full`), `drafts.create`; SQS `ReceiveMessage` and `DeleteMessage`; S3 `GetObject` of raw MIME; Google's token endpoint. A MIME reader for the SES bodies (headers, `text/plain`, quoted-printable and base64), written and tested on its own, since no npm package may enter. The synthetic mail corpus for IAC1 and IAC4.
- **E2.1, after S451 to S455 and Q-EX1 to Q-EX5 are ruled.** E2.0's measurement: the module checked with poly-ref, the state counts and the flow rule's count, before the tests.
- **E2.2** The tests of 4.6, failing. **E2.3** The adapters (as S452 rules), the module, the policy and the host. **E2.4** The load test of IT8: a recorded month's backlog, the triage cost per message, the budget's stop. **E2.5** The full suite, the record, a commit per step.

### 4.8 Measured and known risks

- **Refresh tokens of a Google app in testing.** Google documents that an OAuth client whose publishing status is "Testing" gets refresh tokens that expire after seven days. The owner's client should be set to "In production" (unverified, for the owner's own use) or the assistant asks for consent each week. To be confirmed from Google's documentation when E2.0 writes the profile's traffic.
- **`historyId` expiry.** Gmail keeps history for a limited time; IT2.1's bounded fallback to `messages.list` is tested on a recorded 404.
- **State space with owners.** Three accounts are three principals, but the checker uses representatives (PS17.4, S317), so the count does not grow with accounts. E2.1 measures it.
- **Triage cost.** Two or three routed calls per message on the cheap tier. E2.4 measures cost per message against the cap.

## 5. Order

```
ex:   E1.0 ─ E1.1 ─ E1.2 ─ (V3) E1.3 ─ (V4) E1.4 ─ E1.5
      E2.0 (now) ─ (rulings S451 to S455, Q-EX1 to Q-EX5) E2.1 ─ E2.2 ─ E2.3 ─ E2.4 ─ E2.5
```

E1.0 waits only on the ruling of S450, since the concierge's flow through the channel depends on it. E2.0 starts at once.

## 6. Questions for the reviewer

1. **S450**, the thread's principal (3.6): the proposal or the alternative, and on which branch.
2. **S451 to S454**, the four core changes (4.2): which enter v1, and whether the release session builds them.
3. **S455**, the send capability of a Gmail draft token (4.3): part (a) on `ex`, and part (b) in the core or as a stated limit.
4. **Q-EX1 to Q-EX5** (4.4).
5. **The spec issue range S450 to S499** for the examples.

## Conclusion

The concierge is close: its four surfaces exist and are tested apart, and joining them needs one ruling on who a WhatsApp thread's recipient is, plus V3 and V4 from the release branch. The inbox assistant is further: as specified it needs mail to enter as owned, keyed source items, an AWS credential, a budget on unrouted decisions and a way around the routed record, and a Gmail draft token can send whatever the program says. Each of those is brought here with a proposal and a smaller alternative. Until they are ruled, the examples branch builds only what depends on none of them: the recorded traffic, the MIME reader and the synthetic corpora.

## Glossary

- **Account label:** the opaque name the owner gives an inbox in the host's configuration, used in instance ids in place of an address.
- **Owned source:** a source whose items each belong to one principal (PS17.2); here, an inbox's mail belongs to its account.
- **Recorded traffic:** provider requests and responses written from the provider's documentation, replayed by fake transports in tests.
- **Thread's principal:** the customer a channel thread speaks for, taken from the verified sender's claims (S450).
- **Unrouted decision:** a decision with one `provider` and no `route`.
