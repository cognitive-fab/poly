# poly v1 · Functional specification: channels, credentials, memory and routing

*Cognitive Fab · October 2026 · proposal v0.2 · specification only, no code · ids `PF11` to `PF14`, continuing [`01-functional-spec.md`](../01-functional-spec.md) · the technical counterpart is [`v1-technical-spec.md`](v1-technical-spec.md)*

## 0. Scope and status

Languages and runtimes have spread when they made one thing easy that developers needed most and kept getting wrong. Java made memory safe by default, PHP made "a request comes in, a page goes out" a single file, and Node made non-blocking I/O the default.

For AI projects in 2026, four needs come up again and again, and each team builds them by hand:

1. **Channels.** Agents talk to people over email, WhatsApp, SMS and Slack.
2. **Delegated credentials.** Agents act in other systems on a person's behalf.
3. **Governed memory.** Agents read business data and remember across sessions.
4. **Routing and budgets.** Agents use a cheap model first, escalate when in doubt, and stay within a cost cap.

This document adds these four surfaces to poly and calls the result v1. It does not change poly's principles:

- the program is the checked model;
- every effect crosses the gate;
- the journal replays exactly;
- no language model sits on a check or decision path (PA0.5).

Each surface follows the pattern that PD1 (typed decisions) and PD5 (verified claims) set:

- the hard, unbounded part stays outside poly, in a host adapter;
- its result enters poly as a finite typed value;
- the checker explores every value that value can take;
- the gate enforces the rest at runtime.

| Id | Surface | What it makes easy | Builds on | Milestone |
|---|---|---|---|---|
| PF11 | Channels | Receiving and sending messages on behalf of a program, under the channel's own rules | PD5 claims, the gate (PT9), PD1 decisions | M8 |
| PF12 | Delegated credentials | Calling another system as a person, without the program or a model ever seeing a secret | PT6.5 capabilities, PD5, PD6.2 mandates | M9 |
| PF13 | Governed memory | Retrieving and remembering facts that carry their source, their age and who may see them | PD5, PD6.1 freshness, Polyaxion taint | M10 |
| PF14 | Routing and budgets | Choosing a model tier by recorded numbers, and never crossing a cost cap | PD1, PD2, PD3 | M11 |

v1 is M0 to M7 of PT18 plus M8 to M11 below. M6 is closed, and M8 comes next, before M7. Each surface is ruled on separately.

## 1. The running example

The four surfaces are specified against one example, the **concierge**: a small business answers its customers on WhatsApp.

1. A customer writes on WhatsApp: "Where is my order, and can I get a refund for the missing item?"
2. A typed decision classifies the message. A small model answers first, and the route escalates to a larger one when the answer's calibrated confidence is low (PF14).
3. The program retrieves that customer's orders, and only that customer's (PF13).
4. A refund under the limit is issued in the payment system through the merchant's delegated credential, within the agent's mandate (PF12).
5. A refund over the limit escalates to a staff member on Slack. The approval itself is signed with a person key (PF9.6).
6. The reply goes back on WhatsApp, inside the conversation window the channel allows, citing the orders it used (PF11, PF13).

Every step is journaled, the whole run replays with no model call, and the program is checked before it runs.

## 2. Users

The users of 01-functional-spec section 3 are unchanged. Two roles gain needs:

| User | New need |
|---|---|
| **Coding agent** | Declare a channel, a credential, a source or a route in a few lines, and get a witness when the program can break a channel rule, leak a fact or exceed a budget. |
| **Operator** | Connect a channel, a vault, a data source and model providers through host adapters, and see per-run cost, every message sent and every credential used in the journal. |
| **End user** (new) | The customer or employee a program talks to or acts for. They need their messages answered under the channel's rules, their consent respected, their data shown only to them, and their authority used only within what they granted. |

## 3. Goals

- **G8.** A channel, a credential, a data source and a model route are each a declaration in poly source. Everything the runtime needs is derived from it.
- **G9.** A rule that a channel, a grant, an audience or a budget imposes is checked before the program runs, with a witness when it can be broken, and enforced by the gate when it runs.
- **G10.** No secret, message body or retrieved text enters machine state, a gate proposal or the ledger. Only digests and typed summaries do.
- **G11.** Every fact a program uses carries its source, its age and its audience, and every reply can name the facts it used.
- **G12.** Every model call is metered, attributed to a run and a scope, and covered by a reservation before it starts, so a cap is never crossed.

## 4. Non-goals

- **N7.** poly is not a messaging product. It has no inbox, no contact management and no content moderation. Voice channels are not in v1.
- **N8.** poly is not an identity provider, an OAuth authorization server or a vault. It specifies what a vault adapter must do and trusts its result (K13).
- **N9.** poly is not a search engine or a vector database. Ranking quality is not checked. What is checked is who may see what, how old it is, and where it flows.
- **N10.** poly is not a model gateway. It hosts no model. Routing is a deterministic function of recorded values.
- **N11.** poly does not judge whether a message, a fact or an answer is true. It checks that the program cannot use them outside their declared limits.

## 5. Functional requirements

### PF11 · Channels

- **PF11.1** A project declares **channels**. A channel has a kind and an adapter. The v1 kinds are `email`, `whatsapp`, `sms`, `slack` and `webhook`. Each kind ships with a **conversation machine** in the standard library that encodes the channel's rules (PF11.6).
- **PF11.2** **Inbound.** Each inbound message becomes one dispatch of a declared action on the instance that the channel's **thread key** routes it to. A message that starts a new thread creates the instance with its creation action. The provider's message id is the `actionId`, so a webhook delivered twice is one step (PF8.2).
- **PF11.3** **Sender.** The channel adapter is a verifier adapter (PD5.1.4). Each inbound message carries **sender claims** of a declared finite type, for example the channel kind, whether the sender is verified by the provider, and the sender's `Principal`. An unverified sender is a claims value that policies decide on, not an error.
- **PF11.4** **Bodies stay out of state.** Message text and attachments are stored in the content store by digest. A machine holds them as `Content`, an opaque type like `Principal`: it can store, pass and compare one, but not read it. To branch on a message, a program passes it to a typed decision (PD1) or a typed extractor, and branches on the finite answer.
- **PF11.5** **Outbound.** Sending a message is an effect of class `irreversible`, with label `egress:external`, and its recipient as target. It crosses the gate like any effect, so a policy can allow it, deny it, or escalate it for a person to approve. The provider's delivery reports (`sent`, `delivered`, `read`, `failed`) arrive as completion actions.
- **PF11.6** **Channel rules are checked machines.** Each conversation machine encodes its channel's rules as the provider states them, and is versioned when the provider changes them. Among the v1 rules:
  - the WhatsApp customer service window: free-form messages only within the window after the customer's last message, templates outside it;
  - consent and opt-out: no message to a recipient after an opt-out (`STOP` for SMS, unsubscribe for email) until they opt in again;
  - one outbound message per approved intent.

  An application sends through its thread's conversation machine. A send the rules forbid is rejected with a named reason (`window-closed`, `opted-out`). The checker explores the application together with the conversation machine, so an application that can reach such a rejection without handling it gets a witness.
- **PF11.7** **Limits.** Policies may cap sends per recipient, per thread and per period, and may forbid sends in quiet hours. Each cap is a finite counter or interval, checked like any policy rule.
- **PF11.8** **People in the loop.** A channel can carry an escalation notice to the person who must decide, for example on Slack. The approval itself is still signed with a person key (PF9.6). A channel message alone never approves an escalation.

### PF12 · Delegated credentials

- **PF12.1** A project declares **credentials**. A credential names:
  - its provider and grant type: authorization code with PKCE on behalf of a person, or client credentials for the service itself;
  - the finite set of **scopes** it may request;
  - its **holder**: the principal whose authority it carries.
- **PF12.2** **Use is declared.** An effect that calls another system declares the credential it uses, the scopes it needs, and the parameter that names the holder. Admission refuses an effect that uses a scope its credential does not declare.
- **PF12.3** **No secret reaches the program.** A token never enters:
  - machine state;
  - the journal or the ledger;
  - a gate proposal;
  - a decision's inputs or a model's context;
  - a handler's return value.

  The handler receives an **authenticated capability**, bound to the provider's base address and to the grant, which attaches the token to each request itself. With the sandbox (PT6.5), the token never enters the handler's process.
- **PF12.4** **Grants are checked machines.** The lifecycle of each grant (requested, granted, refreshing, expired, revoked) is a standard library machine, checked like `OutboxIntent`. A refresh is bounded. An effect whose grant is not `Granted` is denied (`credential-unavailable`) or escalated (`reauthorize`), as policy says.
- **PF12.5** **Consent is a person's act.** Obtaining a grant is a work order to the holder. They receive the authorization link, for example over a channel, and complete the provider's consent screen themselves. The grant is recorded when the provider's callback arrives. No model and no agent completes a consent.
- **PF12.6** **Authority is the intersection.** An effect on behalf of a principal is allowed only when all three hold, checked by the gate on every call:
  - the innermost mandate (PD6.2) covers the action;
  - the holder's grant covers the scopes;
  - the policy allows the effect in the program's state.
- **PF12.7** **Revocation.** A grant is revoked:
  - when the provider reports revocation;
  - when the holder revokes it;
  - when a security signal revokes the holder (PD5.3).

  Intents not yet started are then denied, and no effect starts on a revoked grant after the step that records the revocation.
- **PF12.8** **Records.** The ledger records each credential use by grant id, holder and scopes digest, never by token.

### PF13 · Governed memory and retrieval

- **PF13.1** A project declares **sources**: document collections, record stores and the program's own memory. Every item in a source has:
  - an id and a digest;
  - an origin;
  - an `asOf` time;
  - an **audience**.
- **PF13.2** **Audiences are finite.** A project declares its audience classes and their order, for example `public < customer < staff < finance`. An item may also be **owned**: it is visible to its owner and to the classes above the owner's. A recipient may see an item when their class is high enough, or when they are its owner.
- **PF13.3** **Retrieval returns references.** Retrieval is an effect labelled `read:private` or `read:store`. It returns a set of item references with typed summaries:
  - count;
  - audience;
  - owner;
  - an age interval.

  It does not return the text. Text reaches a model only through a decision that takes the references as input, and the runtime resolves them in the content store.
- **PF13.4** **Facts flow by audience.** A decision's answer carries the most restrictive audience of the items it was given, and their owners, as its **taint**. Any value derived from that answer keeps the taint. An outbound effect whose payload carries a taint is allowed only to recipients who may see it.

  The checker proves this over the declared audience classes. The gate enforces it on every send. A reply built from customer A's orders cannot be sent to customer B, on any path.
- **PF13.5** **Freshness.** Policies read an item's age as they read a claim's age (PD6.1). A decision that would use an item older than its source's freshness bound is escalated or refused, as policy says.
- **PF13.6** **Citations.** A decision whose answer is used in a reply may be required to cite the items it used. The citations must be a subset of the references it was given. An answer citing anything else is rejected at completion with `uncited`.
- **PF13.7** **Remembering.** A program writes to its memory through an effect. Each item it writes has a provenance class:
  - `observed`: from a channel message or a tool result;
  - `derived`: from a decision;
  - `verified`: confirmed by a source or signed by a person.

  Policies may require `verified` items for some uses. Promoting an item from `derived` to `verified` requires a person's signature, as accepting a finding does (PF9.6).
- **PF13.8** **Forgetting.** `forget` removes every body about a subject from the content store and the source index. The ledger keeps only digests, so chain verification still passes. A replay that needs a forgotten body reports `forgotten` for that step, not a divergence.

### PF14 · Routing and budgets

- **PF14.1** A decision (PD1) may declare a **route**: an ordered list of **tiers**, each naming a provider, a price table and a calibration map (PD1.6).
- **PF14.2** **Escalation by recorded numbers.** The route moves to the next tier when:
  - the answer's calibrated confidence is below a threshold;
  - the margin is below a threshold;
  - the provider failed.

  The number of tiers bounds the escalation. A route ends with an answer or with `RouteExhausted`, and the checker proves that every path reaches one of them.
- **PF14.3** **Budgets.** A project declares budgets with caps per run, per scope and per period, in exact cost units. Before each model call, the gate **reserves** its worst-case cost: the call's token limit at the tier's prices. After the call, the reservation is replaced by the cost reported. A call whose reservation does not fit the remaining budget is denied or escalated (`budget`), as policy says. Spent plus reserved never exceeds a cap, under any number of concurrent runs.
- **PF14.4** **Records.** Each `decision` event (PD2) records:
  - the tier;
  - the model;
  - the usage;
  - the cost;
  - the reservation.

  `poly cost` reports cost per run, per scope and per period from the ledger alone.
- **PF14.5** **No model chooses the route.** Routing is a function of recorded values, so replay reproduces every tier choice without calling a model (PA0.5).
- **PF14.6** **Swapping a model.** Replacing a tier's model requires a calibration map fitted for it. Otherwise the change is refused at admission, because the program's thresholds would lose their meaning (PD3.2).
- **PF14.7** **Agent work.** A workflow (PF5) may escalate a work order to a stronger agent in its own machine: on `failed`, it emits the effect kind mapped to the next agent tool. Work orders may carry a budget, metered from the usage the agent reports.

## 6. Acceptance criteria for v1 surfaces

| Id | Criterion |
|---|---|
| AC14 | An inbound message delivered twice with the same provider message id produces one step. A message from an unverified sender reaches the program with `verified` false in its claims. |
| AC15 | In the concierge, a variant that sends a free-form WhatsApp reply after the window has closed gets a witness from `poly check`. At runtime, the conversation machine rejects the send with `window-closed`. |
| AC16 | After an opt-out, no send to that recipient is allowed, on any path and at runtime, until an opt-in. |
| AC17 | An outbound message to an external recipient that a policy escalates is sent only after an approval signed with a person key. A channel message cannot approve it. |
| AC18 | A canary token placed in the vault never appears in state, journal, ledger, content store, gate proposals, decision inputs, logs or handler results, over the full concierge test suite. |
| AC19 | An effect using a scope its credential does not declare is refused at admission. A grant that lacks a needed scope gives `insufficient-scope`. No effect starts on a revoked grant after the step that records the revocation. |
| AC20 | The `Grant` machine is deadlock-free, its refresh is bounded, and it satisfies its liveness property under its stated fairness. |
| AC21 | An action outside the innermost mandate is denied even when the grant covers its scopes, and an action outside the grant is denied even when the mandate covers it. |
| AC22 | A variant of the concierge that can send a reply derived from customer A's orders to customer B gets a witness from `poly check`. The gate denies the send at runtime. |
| AC23 | An answer citing an item it was not given is rejected with `uncited`. An item older than its source's bound escalates as the policy says. |
| AC24 | After `forget`, no body about the subject remains in the content store or index, the ledger verifies, and replay reports `forgotten` for the affected steps. |
| AC25 | A low-confidence answer escalates to the next tier. The route reaches an answer or `RouteExhausted` on every path. Replay reproduces every tier choice from the ledger with no model call. |
| AC26 | With 64 concurrent runs in one scope, spent plus reserved never exceeds the cap. A reported cost above its reservation is recorded as an overrun, and the next calls see the corrected remainder. |
| AC27 | The concierge runs end to end with recorded providers and fake channel, vault and source adapters. It is checked `CLEAN`, and its journal replays every post-state, gate decision and tier choice. |

## 7. Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Providers change channel rules. | A checked rule no longer matches the provider. | Conversation machines are versioned standard library modules with provenance. A rule change is a new version under the version gate (PF8.7). |
| Taint is too coarse. | Useful replies are denied because one cited item was more restricted. | Citations narrow the taint to the items actually used (PF13.6). Denials name the item that caused them. |
| Token usage reported by providers is wrong. | Cost records drift from invoices. | Reservations bound each call before it runs. Overruns are recorded, and `poly cost` can be reconciled against invoices. |
| Adapters become the real attack surface. | A faulty adapter mislabels a sender, an audience or a grant. | The trust boundary is named (K11, K13 to K15). Adapters are small, tested against recorded provider traffic, and listed in the certificate by digest. |
| Scope creep. | v1 never ships. | Four surfaces, one example, fixed acceptance criteria. Voice, more channel kinds and agent-tier routing in polyflow are v2. |

## 8. Conclusion

The four surfaces are what AI projects build by hand today, and where they most often fail: a message sent outside a channel's rules, a token leaked into a prompt, a fact shown to the wrong customer, a bill that crossed its cap. poly v1 makes each one a declaration. The unbounded part (the provider, the vault, the index, the model) stays in a host adapter. What enters the program is finite and typed, so the checker can explore it and the gate can enforce it. The concierge example shows the four together: a customer gets a correct, cited answer on WhatsApp, the refund is made with authority the merchant granted, and the run replays from its journal with no model call.

## Glossary

- **Adapter:** host code that connects poly to an outside system (a channel provider, a vault, a data source, a model provider) and returns typed results.
- **Audience:** the finite class of people allowed to see an item, possibly with an owner.
- **Authenticated capability:** a handler capability that calls one provider with a grant's token attached, without exposing the token.
- **Channel:** a declared way to receive and send messages, with a provider adapter and a conversation machine.
- **Citation:** an item reference that an answer declares it used, drawn from the references it was given.
- **`Content`:** an opaque reference to a body in the content store; it can be stored, passed and compared, never read by a machine.
- **Conversation machine:** a standard library machine that encodes a channel's rules for one thread.
- **Credential:** a declared provider, grant type, scope set and holder through which effects call another system.
- **Grant:** a credential obtained for one holder, with its own checked lifecycle.
- **Reservation:** the worst-case cost of a model call, held against a budget before the call starts.
- **Route:** an ordered list of model tiers for a decision, with escalation rules on recorded numbers.
- **Source:** a declared collection of items, each with an id, digest, origin, `asOf` time and audience.
- **Taint:** the audience and owners carried by a value derived from items, which bounds who may receive it.
- **Thread key:** the template that maps an inbound message to the instance handling its conversation.
- **Tier:** one provider in a route, with its prices and calibration map.
