# poly v1 · Technical specification: channels, credentials, memory and routing

*Cognitive Fab · October 2026 · proposal v0.1 · specification only, no code · ids `PT20` to `PT27`, continuing [`03-technical-spec.md`](../03-technical-spec.md) · requirements in [`v1-functional-spec.md`](v1-functional-spec.md) (`PF11` to `PF14`)*

This document fixes the syntax, lowering, runtime behaviour, formats, codes and milestones of the four v1 surfaces. Every construct lowers to constructs that already exist:

- machines, effects and configurations;
- policies, the gate (PT9), the ledger (PT16) and decisions (PD1, PD2).

Most of the standard library added here is written in poly and checked like any program. The new runtime code is in host adapters and in a few gate inputs.

Codes, kernel assumptions and engine change ids are provisional until ruled. Code ranges follow PT12.2.

## PT20. Shared mechanisms

Four mechanisms serve more than one surface. They are specified once here.

### PT20.1 The `Content` type

- **PT20.1a** `Content` is an opaque reference to a body in the content store (PT16), identified by its SHA-256 digest. A machine may:
  - store one in a field;
  - pass one as an argument;
  - compare two for equality.

  Any other use is `PL1209 CONTENT_NOT_OPAQUE`, by the same rule as `Principal` (PD5.1.2b).
- **PT20.1b** The checker explores `Content` with representatives, as it explores `Principal`. The renaming lemma of PD5.1.3a extends to `Content`, because no handler can tell two bodies apart except by equality. The verdict prints the number of representatives in its instance.
- **PT20.1c** `Content` carries a **taint** (PT23.3): an audience class and a set of owners. Taint is a ghost component. The checker tracks it on every path, and the runtime tracks it in the content store's metadata. It is never written by a handler.

### PT20.2 Adapters

An adapter is host code with a declared interface, registered with the runtime by name (PT26). Each adapter is listed in the certificate by package name, version and digest. There are four kinds:

| Kind | Interface | Trust |
|---|---|---|
| channel | `verify(webhook) → { message, claims } \| refusal`; `send(intent) → providerId`; `receipts() → stream` | K11 (sender claims are verifier output) |
| vault | `put(grantId, tokenSet)`; `withToken(grantId, request) → response`; `revoke(grantId)` | K13 |
| source | `retrieve(query) → ItemRef[]`; `resolve(ref) → body`; `forget(subject)` | K14 |
| provider | `call(decision, refs, limits) → { answer, usage }` | K15 for usage; answers are typed by PD1 |

An adapter never receives a policy, a snapshot or a ledger key. It receives only what one call needs.

### PT20.3 Interval abstraction for ordered quantities

Ages (PD6.1), budget remainders (PT24) and send counters (PT21.6) are explored by the intervals cut by the thresholds the program and its policies mention, as PD1 does for `Conf`. The checker computes the cuts from the source. A threshold added to a policy changes the cuts, and the new cuts appear in the verdict's instance.

### PT20.4 Standard library modules

The v1 standard library is a set of poly modules under `std/`, versioned and admitted like user modules, with `PROVENANCE.md` naming the provider documentation each rule encodes:

- `std.channels.email`, `std.channels.whatsapp`, `std.channels.sms`, `std.channels.slack`, `std.channels.webhook`;
- `std.credentials.Grant`;
- `std.memory.Remember`;
- `std.routing.Route` and `std.routing.Budget`.

A program that uses one is checked together with it. A new version of a library module passes the version gate (PF8.7) before deployment.

## PT21. Channels

### PT21.1 Syntax

```poly
module concierge
use std.channels.whatsapp

claims Sender {
  verified: bool
  principal: Principal
}

channel support: whatsapp {
  adapter "wa-cloud"
  thread "{from}"
  inbound -> Ticket.Message(body: Content) by sender: Sender
  starts Ticket.Open
  delivered -> Ticket.Delivered()
  rejected  -> Ticket.SendRejected(reason: string check { "window-closed", "opted-out", "rate" })
  failed    -> Ticket.SendFailed()
}

machine Ticket {
  state { status: Status = New  customer: Who = Unknown  draft: Draft = None }
  …
  on Answered(text: Content) {
    require customer is Known else reject "no-customer"
    draft' = Ready { text: text }
    emit support.reply(to: customer.p, body: text)
  }
  on SendRejected(reason) {
    match reason {
      "window-closed" => emit support.template(to: customer.p, name: FollowUp)
      _               => status' = Closed
    }
  }
}
```

- **PT21.1a** A `channel` declaration is top level in a module. Its kind names a standard library module (`std.channels.<kind>`), which provides the conversation machine and the effects `reply` and `template`.
- **PT21.1b** `thread` is a key template over the adapter's message fields, with the same grammar and checks as a workflow key (PT10). Each thread is one instance of the application machine.
- **PT21.1c** `inbound` names the application action that receives each message. Its parameters are drawn from the adapter's typed fields. A field the adapter does not declare is `PL1001 UNKNOWN_NAME`.
- **PT21.1d** `starts` names the creation action for a new thread.
- **PT21.1e** `delivered`, `rejected` and `failed` name completion actions. They follow the completion rules of PT6.1, and `PL6101` and `PL6102` apply unchanged.

### PT21.2 Lowering

A channel lowers to three things:

1. **A channel descriptor** `channels/<name>.json`:
   - the adapter name;
   - the thread template;
   - the inbound and completion mappings;
   - the library module's version and digest.
2. **A detached conversation instance per thread**, of `std.channels.<kind>.Conversation`. The runtime creates it beside the application instance when a thread starts, and gives each one the other's `Ref`.
3. **A rewrite of each send.** `emit support.reply(to, body)` lowers to `send conv <- Reply(to, body)`, where `conv` is the conversation's address.

The conversation is the only machine that emits the provider effect `channel.<name>.send`. It reports back to the application by `send`:

- `Delivered()` on a delivery receipt;
- `Rejected(reason)` when its rules forbid the send;
- `Failed()` when the provider fails or the gate denies.

Because the application and its conversation talk only by messages, the checker explores them as a configuration (PT7a). The configuration is generated: one application instance, one conversation, and every inbound action and receipt the environment may inject. Its transit bound is the declared `pending` bound of the conversation. An application that leaves a `Rejected` unhandled gets the existing `PL5102` or `PL5402` finding with a witness.

### PT21.3 The WhatsApp conversation machine

```poly
module std.channels.whatsapp

type Window = | Closed | Open

service machine Conversation {
  state { window: Window = Closed  consent: bool = true  inflight: 0..1 = 0  app: Ref<App> }
  action Inbound(body: Content)   action WindowExpired()
  action Reply(to: Principal, body: Content)   action Template(to: Principal, name: Template)
  action OptOut()   action OptIn()
  action SendOk()   action SendFailed()

  on Inbound(body) {
    window' = Open
    after 24h -> WindowExpired() as w
    send app <- Message(body: body)
  }
  on WindowExpired { window' = Closed }
  on Reply(to, body) {
    require consent    else { send app <- Rejected(reason: "opted-out");     reject "opted-out" }
    require window is Open else { send app <- Rejected(reason: "window-closed"); reject "window-closed" }
    require inflight == 0 else reject "busy"
    inflight' = 1
    emit send(to: to, body: body, kind: FreeForm)
  }
  …
  never emit send(kind: FreeForm) while window is Closed
  never emit send while !consent
}
```

The sketch shows the shape, not the final text. Two points need ruling:

- A `reject` that also sends is not valid today, because a rejected step emits nothing (PT6.1). The final machine accepts the step, records the refusal, and sends `Rejected`. It writes a counter so that `PL2201 SILENT_NOOP` does not fire. Q1 asks whether a reply on rejection should become a construct.
- The window length, the opt-out keywords and any template category rules are taken from the provider's documentation at the time the module is written. Each is recorded in `PROVENANCE.md` with its source and date. They are not restated in this specification.

The `never` statements are checked by the decision-table check (S149) and by the configuration exploration. They are part of the library module's admission, so every program that uses the channel inherits them.

### PT21.4 Inbound processing

1. The runtime's ingress receives the provider's webhook and passes it to the adapter's `verify`. A refusal is logged as an ingress refusal with the provider id and reason, and nothing is dispatched.
2. The body and attachments are written to the content store. The message becomes `Content` digests.
3. The thread key is computed from the adapter's typed fields. A missing instance is created with the `starts` action, and its conversation with it.
4. `Inbound(body)` is dispatched to the conversation with `actionId = "<channel>:<providerMessageId>"`. Dispatch is idempotent on it (PF8.2), so a redelivered webhook is one step.
5. The sender claims travel in the step label (PD5.1.2c). A malformed claims record gives the reserved rejection `claims-unverified`.

### PT21.5 Outbound processing and the gate

The provider effect `channel.<name>.send` has class `irreversible`, label `egress:external`, and its recipient as target. The gate proposal (PT9.1) gains the fields in PT25.1: the channel, the recipient principal, the message kind, and the body's taint.

A policy can, for example, escalate free-form replies that carry staff-level facts:

```poly
obligation review-sensitive "A person reviews replies built from staff-only facts." rule {
  when effect.channel == "support" && effect.taint.class >= staff
  require false else escalate
}
```

An escalation can be announced to the approver over another channel, for example `slack`. That is an ordinary effect of the escalation's own work order. Approval still goes through `poly approve` with a person key (PT12.5). A Slack reply does not reach `poly approve`.

### PT21.6 Limits

Send counters per recipient, thread and period are policy `vars` over integer ranges, explored by intervals (PT20.3):

```poly
var sentToday: 0..20 = 0
obligation daily-cap "No more than five messages to one recipient per day." rule {
  when effect.channel == "support"
  require sentToday < 5 else deny
}
```

Counters keyed by recipient live in a separate machine that the policy consults by message, as PT9.6a requires for state across sessions.

## PT22. Delegated credentials

### PT22.1 Syntax

```poly
credential payments: oauth2 {
  provider "stripe-connect"
  grant authorization_code pkce
  scopes { refunds.write, charges.read }
  holder Principal
}

effect refund(merchant: Principal, charge: ChargeRef, amount: int check 0..500) {
  kind "payments.refund"
  labels { egress:external }
  targets { egress: "https://api.stripe.com/v1/refunds" }
  uses payments { refunds.write } for merchant
  class irreversible
  ok -> Refunded()  failed -> RefundFailed()  exhausted -> RefundFailed()
}
```

- **PT22.1a** `grant` is `authorization_code pkce` or `client_credentials`. Client credentials have the service as holder, and `for` is omitted.
- **PT22.1b** `scopes` is a finite set of provider scope names. `uses c { s… }` must name a subset of it, otherwise `PL6811 SCOPE_NOT_DECLARED`.
- **PT22.1c** `for p` names a `Principal` parameter of the effect. An effect with `uses` on a delegated credential and no `for` is `PL6812 HOLDER_NOT_NAMED`.
- **PT22.1d** An effect whose targets lie outside the provider's declared base addresses is `PL6813 TARGET_OUTSIDE_PROVIDER`. Each provider's base addresses are part of the adapter's declaration.

### PT22.2 The `Grant` machine

```poly
module std.credentials

type GrantState =
  | Requested
  | Granted    { scopes: ScopeSet }
  | Refreshing { attempt: 1..3, scopes: ScopeSet }
  | Expired | Revoked

service machine Grant {
  state { g: GrantState = Requested }
  terminal g is Revoked
  action Callback(scopes: ScopeSet)   action TokenExpiring()   action RefreshOk()
  action RefreshFailed()   action Revoke()   action Reauthorize()
  …
}
```

- **PT22.2a** There is one `Grant` instance per (credential, holder). Its address is derived from both, so the gate can consult it by message (PT9.6a).
- **PT22.2b** `ScopeSet` is the finite power set of the credential's declared scopes. The checker explores it, and a grant with fewer scopes than requested is a reachable state.
- **PT22.2c** The machine is checked under the same gate as `OutboxIntent` (M4b): its invariants, deadlock freedom, and the liveness property "a refresh ends in `Granted` or `Expired`" under its stated fairness (AC20).
- **PT22.2d** Tokens are not state. The vault adapter holds them under the grant id. The machine holds only the lifecycle and the scope set.

### PT22.3 Obtaining a grant

`poly grant request <credential> --for <principal>` starts a work order. It has three steps:

1. The runtime asks the vault adapter for an authorization URL with PKCE parameters. The URL contains no token.
2. The work order delivers the URL to the holder, through a channel or the operator's console. The holder completes the provider's consent screen.
3. The provider's callback reaches the runtime's ingress. The vault adapter exchanges the code, stores the token set, and returns only the granted scopes. The runtime dispatches `Callback(scopes)` to the `Grant` instance.

The command is not exposed over MCP, like `poly approve` (PT14). An agent cannot start a grant for a person.

### PT22.4 The gate decision for a delegated effect

For an effect with `uses c { s } for p`, the gate checks, in order. The first failure decides:

1. **The grant** at `Grant(c, p)`:
   - `Granted { scopes }` with `s ⊆ scopes`: continue;
   - `s` not a subset: deny `insufficient-scope`;
   - any other state: deny `credential-unavailable`, or escalate `reauthorize` if the policy says so.
2. **The mandate.** If the step's claims carry a mandate (PD6.2), the effect must be within the innermost mandate's scope, otherwise deny `outside-mandate`. Policies read `step.claims.delegate` and `step.claims.principal` as PD6 states.
3. **The policy** obligations in scope, as today.

The grant state is read by message and recorded in the `verdict` event with its `sseq`, so replay reproduces the decision (PS11).

### PT22.5 The authenticated capability

The handler for an effect with `uses` receives `api`, which replaces `egress` for that effect:

```ts
rt.handle('payments.refund', async (payload, { api }, ctx) =>
  api.post('/v1/refunds', { charge: payload.charge, amount: payload.amount },
           { idempotencyKey: ctx.idempotencyKey }))
```

- `api` is bound to the provider's base address, the effect's declared targets and the grant id. It calls the vault adapter's `withToken(grantId, request)`, so the token is attached inside the adapter.
- With `handlers: { isolation: "openshell" }`, the vault adapter runs outside the sandbox as an egress proxy. The handler's process never holds the token.
- The handler lint (PT6.5) gains two rules:
  - an import of the vault adapter's module from a handler is `PL6401`;
  - reading a response header the provider uses to return tokens (`set-cookie`, `authorization`) is `PL6814 TOKEN_READ_IN_HANDLER`.

### PT22.6 Revocation

`Revoke()` reaches the `Grant` instance from three sources:

- the provider's revocation webhook, through the vault adapter;
- `poly grant revoke`, signed with a person key;
- a PD5.3 security signal on the holder, through the mode machine.

On `Revoke()`, the runtime calls the vault adapter's `revoke(grantId)` as an effect of the `Grant` machine. From the step that records `Revoked`, every proposal using the grant is denied `credential-unavailable` (AC19). An intent already `Running` finishes, because the provider has already accepted its request. The runtime cannot recall it, and the ledger records it as started before revocation.

### PT22.7 The canary test

AC18 is tested by a canary. The test vault issues tokens with a fixed unique prefix. After the concierge suite runs, a scan of every output must find no occurrence of the prefix, in any encoding the scan knows (plain, base64, URL-encoded). The outputs scanned are:

- state snapshots, the journal and the ledger;
- the content store and gate proposals;
- decision inputs and handler results;
- logs and certificates.

## PT23. Governed memory and retrieval

### PT23.1 Syntax

```poly
audience { public < customer < staff < finance }

source orders: records {
  adapter "pg-orders"
  audience customer owned
  freshness 1h
}

source help: documents {
  adapter "kb"
  audience public
  freshness 30d
}

effect lookupOrders(customer: Principal) {
  retrieve orders where owner == customer limit 5
  ok(r) -> Found(items: r.items)
}

decision answer(question: Content, context: Items) -> Reply {
  route triage
  cites context
  ok(r) -> Answered(text: r.text, cites: r.cites)
  failed -> AnswerFailed()
}
```

- **PT23.1a** `audience` declares a finite total order of classes. A partial order is Q3.
- **PT23.1b** `owned` means each item has an owner principal, supplied by the source adapter. A recipient may see an owned item if they are its owner or if their class is above the item's class.
- **PT23.1c** `retrieve s where … limit n` is the body of a retrieval effect. It lowers to an effect of kind `source.<s>.retrieve`, labelled `read:private` for owned or non-public sources and `read:store` otherwise. Its query is passed to the adapter as typed data. `owner == p` is the only predicate the checker interprets. Other predicates are passed through and not checked.
- **PT23.1d** `Items` is a record type with finite fields: `count: 0..n`, `class: Audience`, `owners: OwnerSet`, `age: AgeInterval`, and an opaque reference to the set. `OwnerSet` holds at most `n` principals, explored by representatives.

### PT23.2 Citations

`cites context` makes the decision's answer type include `cites: Items`, a subset of `context`. The provider adapter returns item ids. The runtime checks at completion that they are a subset of the references passed. If not, the completion is rejected with the reserved reason `uncited`, and the decision's `failed` path runs. `uncited` joins the reserved reasons of PL1207.

### PT23.3 Taint

- **PT23.3a** The taint of an `Items` value is `(class, owners)`. The taint of a decision's `Content` output is the taint of its cited items when it cites, and otherwise the join over all items it was given. Joining takes the highest class and the union of owners.
- **PT23.3b** Taint propagates through `Content` equality, storage and passing (PT20.1c). It never decreases on a path. That is Polyaxion's rule that taint only grows, applied per value.
- **PT23.3c** **The flow rule.** An outbound effect carrying `Content` with taint `(c, O)` to recipient `r` is allowed only if one of these holds:
  - `class(r) ≥ c` and `O` is empty;
  - `class(r) > c`;
  - `O = { r }`.

  The recipient's class comes from the step's claims or from the channel's declared default.
- **PT23.3d** **Checking.** The flow rule is a path property over the configuration, with taint as a ghost component. A path that sends tainted content to a recipient outside its audience is `PL6821 AUDIENCE_LEAK`, with the shortest witness. AC22's variant is the seeded control: the concierge with `where owner == customer` removed.
- **PT23.3e** **Enforcement.** The gate receives the content's taint from the content store's metadata and the recipient's class and principal, and applies PT23.3c. A violation is denied `audience`.

### PT23.4 Freshness

Each item reference carries its `asOf`. The `Items` summary carries the age interval of its oldest item (PT20.3). Policies read `age(items)` as PD6.1 reads `age(claims)`, and the gate records the computed age in the `verdict` event. A decision whose context is older than its source's `freshness` gets the rule the project declares: `stale escalate` (the default) or `stale deny`.

### PT23.5 Remembering

```poly
effect note(subject: Principal, fact: Content) {
  remember memory as derived about subject
}
```

- **PT23.5a** `remember` writes an item to the project's `memory` source. It records the item's origin step, its provenance class (`observed`, `derived` or `verified`), its subject as owner, and the taint of the `Content` written. An item cannot be written with a lower class than its content's taint (`PL6822 TAINT_DOWNGRADE`).
- **PT23.5b** `poly memory verify <item> --by <person>` promotes an item to `verified`, signed with a person key. It is not exposed over MCP.
- **PT23.5c** Policies may require `verified` provenance for a use, for example `require items.provenance == verified else escalate`.

### PT23.6 Forgetting

`poly forget <subject> --by <person>` is a signed command. It works in three steps:

1. It calls each source adapter's `forget(subject)` and removes the content store bodies whose owner is the subject.
2. It writes a `forget` ledger event with the subject's digest and the list of removed body digests.
3. Chains stay valid, because the ledger holds only digests.

`poly journal replay` resolves bodies through the content store. A step that needs a removed body is reported `forgotten`, with the `forget` event that removed it, and the replay continues from the step's recorded post-state digest. A `forgotten` step is not counted as a divergence and is listed in the replay report.

## PT24. Routing and budgets

### PT24.1 Syntax

```poly
route triage {
  tier small provider "flash" prices "prices/flash.json" calibration "maps/flash.json" max tokens 4000
  tier large provider "opus"  prices "prices/opus.json"  calibration "maps/opus.json"  max tokens 8000
  escalate when conf < 0.80 or margin < 0.10 or failed
  budget support
}

budget support {
  cap usd 0.50 per run
  cap usd 20.00 per day per scope
  on exhausted escalate
}
```

- **PT24.1a** Money is written in decimal and lowered to integer micro-units, so arithmetic is exact. Price tables are JSON files with one entry per token class. Their digests enter the certificate, and a price change is a new version.
- **PT24.1b** `conf` and `margin` are the calibrated values of PD1.6, read through the tier's map. A tier without a calibration map is `PL6831 TIER_WITHOUT_CALIBRATION` when the route's `escalate` reads `conf` or `margin`.
- **PT24.1c** A decision names its route with `route r`. A decision without a route uses its single `provider` as today (PD1).

### PT24.2 The `Route` machine

A route lowers to an instance of `std.routing.Route`, attached to the decision's intent. Its states are:

- `Trying { tier: 0..T-1 }`;
- `Answered { tier }`;
- `Exhausted`.

An answer that meets the thresholds moves to `Answered`, and the decision's `ok` completion receives it. An answer below them, or a failure, moves to the next tier. After the last tier the route is `Exhausted`, and the decision's `failed` path runs with reason `route-exhausted`.

The checker proves that every path reaches `Answered` or `Exhausted` (a liveness property under the fairness of provider completion, PS6) and explores the confidence intervals the thresholds cut (PT20.3). Each tier's call is a separate intent, so each one crosses the gate and is journaled on its own.

### PT24.3 The `Budget` machine and reservations

One `Budget` instance exists per (budget, scope, period) and per run for per-run caps. Its address is derived from those, and it is consulted by message (PT9.6a). It holds `spent` and `reserved`, in micro-units.

1. **Reserve.** Before a tier's call, the gate sends `Reserve(r)`, where `r` is the tier's `max tokens` at its highest price. The machine accepts it if `spent + reserved + r ≤ cap`, otherwise it rejects with `budget`, and the gate denies or escalates as `on exhausted` says.
2. **Settle.** After the call, `Settle(r, actual)` replaces the reservation with the actual cost computed from the provider's usage report and the price table.
3. **Overrun.** If `actual > r`, the overrun is recorded in a `budget` field of the `verdict` event and in the machine's `overruns` counter. The next reservation sees the corrected `spent`.

The invariant `spent + reserved ≤ cap + overrun` is checked over the intervals the caps cut. Since the provider adapter passes `max tokens` as the provider's own output limit, an overrun means the provider reported more than it was asked to allow (K15). AC26 injects one.

### PT24.4 Records and `poly cost`

The `decision` event of PD2 gains:

- `tier` and `model`;
- `usage`, in token counts by class;
- `cost`, in micro-units;
- `reservation`;
- the price table digest.

`poly cost [--run r] [--scope s] [--period p]` sums them from the ledger, so it needs no provider call. Because each record carries its price table digest, a cost can be recomputed under any table version.

### PT24.5 Swapping a tier's model

The certificate records each tier's provider, model id and calibration map digest. `poly deploy` refuses a version where a tier's model changed and its map did not, with `PL6832 MODEL_WITHOUT_REFITTED_MAP`. This is PD3.2's rule, applied per tier.

### PT24.6 Work orders

Workflows (PT10) need no new construct for agent tiers. A machine escalates by emitting the effect kind mapped to a stronger agent's tool when a work order fails. A work order may name a budget with `budget b`. The agent reports usage in `workflow_report`, and the runtime settles it against a reservation made at claim time. Self-reported usage is weaker evidence than a provider's report, and the certificate lists such budgets as `self-reported`.

## PT25. Gate, ledger and kernel assumptions

### PT25.1 Gate proposal fields

The proposal of PT9.1 gains optional fields. A policy that reads a field the proposal does not carry gets unknown, and `on unknown` decides (PS8.2).

| Field | Present for | Content |
|---|---|---|
| `channel` | channel sends | `{ name, kind, recipient: principalDigest, recipientClass, messageKind }` |
| `credential` | effects with `uses` | `{ name, holder: principalDigest, scopes, grantState, grantSseq }` |
| `taint` | effects carrying `Content` | `{ class, owners: [principalDigest] }` |
| `items` | decisions with context | `{ count, class, ageMs, provenance }` |
| `route` | decision calls | `{ route, tier, reservation }` |
| `budget` | decision calls | `{ budget, scope, remainingInterval }` |

No field carries a body, a token or a price table, only digests and typed summaries (G10).

### PT25.2 Ledger

New event kinds:

- **`grant`**: a `Grant` lifecycle step, with the grant id and scope digest;
- **`forget`**: PT23.6;
- **`ingress`**: an inbound webhook accepted or refused, with the provider message id and the content digests.

The `decision` event gains the fields of PT24.4. All other kinds are unchanged, and verification runs the same four checks.

### PT25.3 Kernel assumptions

| Id | Assumption | Evidence or test |
|---|---|---|
| K11 (extended) | Sender claims from a channel adapter have been verified by it (provider signature on the webhook, verified number or workspace user). | Adapter tests against recorded provider traffic, including forged webhooks. |
| K13 | The vault adapter attaches the token of the grant named, never another, and never returns a token. The provider enforces the scopes it granted. | The canary test (PT22.7); adapter tests with two grants. |
| K14 | A source adapter returns items with their true owner, class and `asOf`, and `forget` removes every body it holds about the subject. | Adapter tests with seeded items across owners; a post-forget scan. |
| K15 | A provider's usage report is the usage it will bill, and it does not exceed the output limit it was given without reporting so. | Reconciliation of `poly cost` against invoices, reported as a measure, not assumed. |

## PT26. Host runtime API additions

```ts
const rt = await load('./.poly/build', {
  certificate: './.poly/certificate.json',
  store: 'postgres://…',
  gate: { policy: 'concierge', mode: 'in-process' },
  ledger: { keyId: 'ops-2026', signer: kms('…') },
  ingress: { port: 8443 },
  adapters: {
    'wa-cloud':      whatsappCloud({ credential: 'wa-business' }),   // a credential name, never a value
    'stripe-connect': vault.oauth({ store: kmsWrapped('…') }),
    'pg-orders':     pgSource({ table: 'orders', owner: 'customer_id' }),
    'flash':         recordedProvider('./fixtures/flash'),          // tests: no model call
    'opus':          recordedProvider('./fixtures/opus'),
  },
})
```

- Adapters are named in source and bound here. A source name with no bound adapter refuses the load, and the certificate's adapter digests must match.
- Adapter configuration names credentials, never values. The runtime refuses an adapter configuration that contains a string matching a known token format (`PL6815 SECRET_IN_CONFIG`, at load).
- `recordedProvider` replays answers and usage from fixtures. Every test of M8 to M11 uses it, so no test calls a model (PA0.5).

## PT27. Codes, engine changes and plan

### PT27.1 New codes

| Code | Meaning | Section |
|---|---|---|
| `PL1209 CONTENT_NOT_OPAQUE` | `Content` used other than by storage, passing or equality. | PT20.1 |
| `PL6801 CHANNEL_KIND_UNKNOWN` | A channel kind with no standard library module. | PT21.1a |
| `PL6802 THREAD_KEY_INVALID` | A thread template over fields the adapter does not declare. | PT21.1b |
| `PL6811 SCOPE_NOT_DECLARED` | `uses` names a scope its credential does not declare. | PT22.1b |
| `PL6812 HOLDER_NOT_NAMED` | A delegated credential used with no `for`. | PT22.1c |
| `PL6813 TARGET_OUTSIDE_PROVIDER` | Targets outside the provider's base addresses. | PT22.1d |
| `PL6814 TOKEN_READ_IN_HANDLER` | A handler reads a token-bearing header. | PT22.5 |
| `PL6815 SECRET_IN_CONFIG` | A token-shaped string in adapter configuration. | PT26 |
| `PL6821 AUDIENCE_LEAK` | Tainted content can reach a recipient outside its audience. | PT23.3d |
| `PL6822 TAINT_DOWNGRADE` | A memory item written below its content's taint. | PT23.5a |
| `PL6831 TIER_WITHOUT_CALIBRATION` | A route reads `conf` or `margin` on a tier with no map. | PT24.1b |
| `PL6832 MODEL_WITHOUT_REFITTED_MAP` | A tier's model changed without a new map. | PT24.5 |

New reserved reject reasons (PL1207): `uncited`, `route-exhausted`. New gate deny reasons: `insufficient-scope`, `credential-unavailable`, `outside-mandate`, `audience`, `budget`, `stale-items`.

### PT27.2 Engine changes

| Id | Engine | Change | Needed for |
|---|---|---|---|
| E10 | polyaxion | Accept the proposal fields of PT25.1, and per-value taint as an input beside session taint. | PT21.5, PT23.3e |
| E11 | polyaxion | Expose the consult-by-message pattern of PT9.6a as a declared input source, so `Grant`, `Budget` and counter machines are read with their `sseq`. | PT22.4, PT24.3, PT21.6 |

No change to polyrun, polygraph, polyflow or polycheck is needed. If polyaxion cannot take E10 or E11, poly-runtime computes the same checks before the proposal and passes the result as a field, and the certificate lists the check as poly's rather than the gate's.

### PT27.3 Milestones

PT18 gains four milestones after M7. Each needs the previous one closed.

| Milestone | Scope | Gate |
|---|---|---|
| **M8 · Channels** | `Content`; `channel` grammar on both surfaces; the five conversation machines; ingress; channel adapters for email, WhatsApp, SMS, Slack and webhook, each tested against recorded provider traffic; generated configurations; proposal fields `channel` and `taint` (class only) | AC14 to AC17. Every conversation machine is clean, deadlock-free, and proves its `never` statements. |
| **M9 · Credentials** | PD6 ruled in (freshness and mandates, K12); `credential` and `uses`; `Grant`; vault adapters (a development keychain and a KMS-wrapped store); the authenticated capability; the lint rules; `poly grant` | AC18 to AC21. The canary scan is part of the gate's standing tests. |
| **M10 · Memory** | `audience`, `source`, `retrieve`, `Items`; taint as a ghost component in poly-ref; citations; `remember`; `poly memory verify`; `poly forget`; source adapters for Postgres and a document index | AC22 to AC24. The flow rule's seeded control gives `PL6821` with the shortest witness. |
| **M11 · Routing and budgets** | `route`, `budget`; `Route` and `Budget`; reservations; `poly cost`; tier swap rule | AC25 and AC26, with all provider calls recorded. |
| **v1 release** | The concierge example, both surfaces | AC27. The full gate runs from a clean build. |

M8 can start after M6. M8 does not need M7, and M7 does not need M8. The order of M7 and M8 is the owner's call (Q6).

### PT27.4 Limits

- **Channels.** poly checks the rules its conversation machines encode. A provider rule that is not encoded is not checked. Each module's `PROVENANCE.md` lists what is.
- **Credentials.** poly does not verify the provider's OAuth implementation or the vault's storage. They are behind K13. An effect already running when its grant is revoked completes.
- **Memory.** Ranking, relevance and the truth of items are not checked. The flow rule holds for what the source adapter labels (K14). A body is only as forgotten as every adapter that held it.
- **Routing.** Calibration holds on the traffic the map was fitted on (PD1.6). Cost is exact for the reported usage, and reported usage is K15.

### PT27.5 Open questions

1. **Q1.** Should a step be able to reply on rejection (send a message and reject in one step), or should rejection stay message-free and conversation machines accept and record refusals?
2. **Q2.** Should a channel-verified approval at a stated assurance be accepted for classes below `irreversible`, or does every approval need a person key (PF9.6)?
3. **Q3.** Is a total order of audiences enough for v1, or do projects need a partial order (for example `finance` and `legal` incomparable)?
4. **Q4.** Should `forget` also cover derived memory items whose taint names the subject as an owner, or only items whose subject is the owner?
5. **Q5.** Which providers ship as reference adapters, and which are left to users through the adapter interface?
6. **Q6.** M7 (feedback) and M8 (channels) are independent. Which comes first?
7. **Q7.** Should the concierge tasks become the harder tasks of the second, pre-registered experiment proposed after M3?

## Conclusion

The four v1 surfaces add little to poly's core. They add one opaque type (`Content`), one ghost component (taint), five kinds of declaration and a standard library of machines written in poly. Everything else lowers to what already exists:

- channels become configurations of an application and its conversation machine;
- credentials become a checked `Grant` machine that the gate consults;
- memory becomes typed item references whose taint the checker follows on every path;
- routing becomes a `Route` and a `Budget` machine whose reservations make a cap a checked invariant.

The trust boundary moves outward by three named assumptions (K13 to K15). It covers adapters that are small, tested against recorded traffic, and bound into the certificate by digest. The concierge example is the release gate. It shows a program that talks to customers, acts on a merchant's authority, uses only facts each customer may see, stays within its budget, and replays from its journal with no model call.

## Glossary

- **Authenticated capability (`api`):** the handler capability that calls a provider with a grant's token attached by the vault adapter.
- **`Budget` machine:** the standard library machine that holds spent and reserved cost for one cap and accepts or rejects reservations.
- **Channel descriptor:** the lowered file that binds a channel to its adapter, thread key and actions.
- **Conversation machine:** the detached standard library machine, one per thread, that encodes a channel's rules and alone emits the provider send.
- **Ghost component:** a value the checker and runtime track beside the state, which no handler can write.
- **`Grant` machine:** the standard library machine for one credential held by one principal.
- **Ingress:** the runtime's endpoint for provider webhooks and OAuth callbacks.
- **`Items`:** the typed summary of a retrieval result: count, class, owners and age interval, with an opaque reference.
- **Micro-unit:** one millionth of a currency unit, the integer unit of all costs.
- **Overrun:** a settled cost above its reservation, recorded and carried into the next reservation.
- **Price table:** a versioned JSON file of per-token prices for one tier, bound by digest.
- **Recorded provider:** a provider adapter that replays answers and usage from fixtures, used by every test.
- **Reservation:** the worst-case cost of a call, held against a budget before the call.
- **Route machine:** the standard library machine that tries tiers in order and ends answered or exhausted.
- **Taint:** the audience class and owner set carried by `Content` derived from items.
- **Thread:** one conversation on a channel, mapped to one application instance by the thread key.
