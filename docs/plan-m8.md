# poly · Plan for milestone M8, channels

*Cognitive Fab · October 2026 · plan, written before any M8 code · on branch `m4` in the worktree `poly-m4` · from PT27.3's M8 row and PT21 of `proposals/v1-technical-spec.md` (v0.2), PF11 and AC14 to AC17 of `proposals/v1-functional-spec.md`, after M6's close (`decisions-m6.md`)*

This plan covers milestone M8 of the v1 proposal. Its first item is moving workflows onto `poly-runtime`, so that every work order crosses the gate (S164). Then come the channel surface and its standard library:

- `Content`;
- the `channel` grammar on both surfaces;
- the five conversation machines and the configurations generated around them;
- ingress, and channel adapters for email, WhatsApp, SMS, Slack and webhook, tested against recorded provider traffic;
- the proposal field `channel` (taint waits for M10, S181).

The gate is AC14 to AC17. Every conversation machine must be clean, free of deadlock, and prove its `never` statements. AC5's workflow must run on `poly-runtime`, with each work order gated and journaled, and its certificate must no longer list it as `ungated`.

The plan sets out:

- what was found before planning;
- the engine changes, for the owner's list;
- how workflows move under the gate;
- the packages touched and the order of work;
- how each gate item is tested;
- the spec issues found, numbered from S173.

The owner ruled on S173 to S187 and E10 on 2026-10-05. Each ruling is under its issue in section 7 and is recorded in `decisions-m8.md`. M8a may start.

## 1. What was read, and what was found before planning

**Documents read:**

- `CLAUDE.md`;
- the v1 proposal at v0.2: PF11, AC14 to AC17, PT20, PT21, PT25, PT26 and PT27;
- PT6, PT7a, PT9, PT10 and PT18 of `03-technical-spec.md`;
- PS1.6, PS2, PS5 and PS8 of `04-semantics.md`;
- `decisions-m5.md` (E5, S149, S153) and `decisions-m6.md`.

**Code read:**

- the checker's handling of `use` and `self`;
- `poly-runtime`'s handler registration and its worker;
- the certificate's limits;
- the workflow stage;
- the boundary check.

| Finding | Where | Consequence |
|---|---|---|
| `use` is parsed but not lowered. A module that uses another is `PL0901`. A configuration that instantiates another module's machine is `PL0901` too. | `poly-core/src/check/check.ts` (the `Use` declaration; configuration instances) | A channel names a standard library module (`use std.channels.whatsapp`), and its generated configuration mixes the application's machine with the library's. M8 lowers `use` first (S176). |
| `poly-runtime` executes an effect only through a handler that is an export of a certified handler file (S142). The only exceptions are kinds the runtime handles itself: `decision.*` through a provider, and `outcome.*`. | `poly-runtime/src/runtime.ts`, `handle` | A workflow's effects are performed by an agent outside the runtime, which reports the result over MCP. There is no handler file for them, so a work order needs its own runtime-handled path (S173). |
| A workflow's lowering, its descriptor and its admission are polyflow's. The `workflow` stage runs the vendored polyflow `certify`. The certificate adds one `ungated: polyflow runtime` limit per workflow. The Claude Code `install.json` launches the vendored polyflow server, and the boundary check allows exactly that launch (review D-F4). | `poly-check/src/pipeline.ts` `workflowStage`; `admit.ts`; `adapters/claude-code/install.json`; `scripts/check-boundaries.mjs` | Moving workflows changes the stage, the certificate, the adapter entry and the boundary allowlist together (S175). |
| The boundary check refuses `node:http`, `node:https`, `node:net` and `node:tls` in every package, not only on the check path. | `scripts/check-boundaries.mjs`, `violationsOf` | Ingress (a webhook endpoint) and the channel adapters cannot live in any existing package as the rule stands (S182). |
| "Adapter" already names a host adapter: configuration only, under `adapters/` (S167). PT20.2's adapters are runtime code: channel, vault, source and provider. | S167; PT20.2 | One word with two meanings. The plan calls PT20.2's kind **runtime adapters** (S182). |
| `self` is legal only as a whole argument of a `send` (S58). | `check.ts`, the `self` check | A conversation machine needs its application's address. PT21.2 has the runtime create both instances "and give each the other's `Ref`". That is creation at given initial values, which waits on E5 (S153). S177 proposes linking them by a detached spawn instead, with no engine change. |
| Detached children exist (S60, M2). They are actors at `<parent>/<k>`, checked with their parent as a configuration. | PT6.4 | The conversation can be a detached child of the application instance, created in the `starts` step (S177). |
| Machines have no `never` statement. `never` exists only in policies (S149 amended). A step property reads `s, a, d, s'`, not the step's emitted intents (PS5.2). A path property reads the emitted intents but not the state (PS5.4). | `poly-lang/src/parser.ts`; PS5 | PT21.3's `never emit send(kind: FreeForm) while window is Closed` reads both, so none of the five property kinds can state it today (S178). |
| A rejected step emits nothing and sends nothing (PT6.1). | PT6.1, PT21.3 | PT21.3's sketch sends `Rejected` and rejects in one step, which is invalid. The spec already names the final form: accept the step, record the refusal, send `Rejected` (Q1, S179). |
| The ledger keeps bodies by digest. | `poly-runtime/src/journal.ts`, `ledger-store.ts` | `Content` can reference bodies in that store rather than a new one (S180). |
| Audience classes are declared by `audience` in M10 (PT23.1). M8 must carry `taint` with its class only. | PT23, PT27.3 | M8 needs some domain for that class before M10 (S181). |
| The proposal fields of PT25.1 need polyaxion to accept them (E10). Counters keyed by recipient (PT21.6) need E11 or the fallback of PT27.2. | PT27.2 | E10 is needed in M8. E11 is not, if keyed counters move to M9 with the grants that need it anyway (S184). |
| A provider's rules (WhatsApp's window, opt-out keywords, template rules) are taken from its documentation when the module is written, and recorded with their source and date. | PT21.3, PT20.4 | Writing each conversation machine starts by reading its provider's current documentation, which is outside the repository (risk 2). |

Nothing was measured while planning.

## 2. Engine changes, for the owner's list

| Id | Engine | Change | Needed for | Status in this plan |
|---|---|---|---|---|
| **E10** | polyaxion | Accept the proposal fields of PT25.1 (in M8 the `channel` field only; taint waits for M10, S181). Per-value taint waits for M10 too. | PT21.5; AC17 with a policy over `effect.channel` | **Needed in M8.** If polyaxion cannot take it, PT27.2's fallback applies: `poly-runtime` computes the check before the proposal and passes the result as a field, and the certificate lists the check as poly's, not the gate's. |
| **E11** | polyaxion | Expose consult-by-message as a declared input source. | PT21.6 keyed counters, PT22.4, PT24.3 | **Not needed in M8** under S184. Needed in M9. |
| E5 | polyrun | Create an instance at given initial values. | S141, S153; PT21.2 as written | Still on the list. **Not needed by M8** under S177. |
| E9 | polyflow | Verify poly's certificate in the descriptor's `certified` field. | S164 under polyflow | **Withdrawn, if S175 is accepted.** Once workflows run on `poly-runtime`, polyflow admits nothing of poly's. |
| E12 | polyflow | The `customer-brief` example writes free text into `DENIED`'s `reason`. | AC5's comparison | Unchanged. The deny-path difference stays named in the test. |

No other engine change was found while planning. One found while building gets the next id, E13, and is recorded the same day.

## 3. Workflows under the gate (S164, the first item)

Today a workflow is checked and lowered by poly and run by polyflow. After M8 it runs on `poly-runtime`:

- **Work orders are gated.** The workflow's machine emits an effect. The outbox worker proposes it to the gate (PT9.1), as it does for every effect.
  - **Allow:** the runtime issues a work order to the agent, with the tool, target and reason from the workflow's mapping.
  - **Deny:** the effect fails and its `failed` completion is delivered. No order is issued.
  - **Escalate:** the intent waits for a person's signed approval (PT12.5), as any escalated effect does, and only then is the order issued.
- **The agent's report is the handler's result.** `workflow_report(order, ok, result)` settles the intent: `ok` or `failed`, with the result as data, journaled and bound into the ledger (S173).
- **A run is an instance.** The run key comes from the key template, as now, and names the instance. Starting a run creates the instance with the input action. Starting it again with the same key attaches to the same instance.
- **The tools are polyflow's, served by poly.** `poly run --mcp` loads the project's runtime and serves the same six tools with the same schemas: `workflow_list`, `workflow_start`, `workflow_report`, `workflow_state`, `workflow_signal` and `workflow_journal`. An agent configured for polyflow needs only a new launch entry (S174).
- **The descriptor stays, and polyflow leaves the run path.**
  - `poly-runtime` reads the same `polyflow.workflow.json`, so its read-back and the faults `workflow-tool`, `workflow-key` and `drop-timer-target` stay as they are.
  - The `workflow` stage no longer runs polyflow's `certify`. The workflow's machine is already checked by poly's own stages.
  - The certificate drops `ungated: polyflow runtime` and lists the workflow's effect kinds among the gated ones.
  - The vendored polyflow server stays only as AC5's oracle in the tests (S175).

AC5's gate item after the move:

- the three scripts run on `poly-runtime` (approve, deny, empty brief) give the same work orders and states as polyflow's hand-written workflow run on the vendored server, step for step, with E12's difference named;
- each work order has its `verdict` event in the ledger before it is issued;
- a policy that denies `brief.post` means no order for it is issued;
- a policy that escalates it issues the order only after a signed approval;
- the certificate has no `ungated` limit.

## 4. Packages and what changes in each

| Package | Change |
|---|---|
| `poly-lang` | `channel` on the standalone surface; `never emit … while …` in machines (S178); `Content` as a type name. |
| `poly-embed` | The embedded forms: `channel(name, { kind, adapter, thread, inbound, starts, delivered, rejected, failed })` and the `never` form. |
| `poly-core` | `use` lowered (S176); `Content` (`PL1209`); `PL6811`, `PL6812`; `self` in a detached spawn's creation arguments (S177); the generated configuration of each channel. |
| `poly-lower` | The channel descriptor `channels/<name>.json`; the rewrite of `emit c.reply(…)` into a `send` to the conversation; the generated spawn in the `starts` handler (S177). |
| `poly-ref` | Written from the semantics, sharing no code with the compiler: `Content` representatives, the extended step property (S178), and the read-back of the channel descriptor. Each read-back gets its broken variants in the list of toolchain faults. |
| `poly-check` | The workflow stage without polyflow (S175); the certificate's limits; `poly run` in the command registry (S174). |
| `poly-runtime` | Work orders (S173); `Content` bodies in the ledger's store; the proposal field `channel`; dispatching inbound messages idempotently by provider message id (PF8.2); binding runtime adapters by name and digest (PT26). |
| `poly-agent` | The workflow tools served over the runtime (S174); the language server and MCP pick up the new constructs through the registry. |
| `poly-io` (new, S182) | Ingress (the webhook endpoint), the runtime adapter interface of PT20.2 for channels, and the five channel adapters. It is the only package allowed a network module. No check package may import it. |
| `std/` (new) | `std.channels.email`, `whatsapp`, `sms`, `slack` and `webhook`, each with a `PROVENANCE.md` naming the provider documentation and the date of each rule (PT20.4). |
| `adapters/claude-code` | `install.json` launches `poly run --mcp` in place of the vendored polyflow server. |
| `scripts/check-boundaries.mjs` | The network rule names the check packages and `poly-io` (S182); the adapter allowlist replaces the polyflow server with `poly run --mcp`. |
| `test/` | One file per gate item (section 6). The fault lists gain the channel descriptor's broken variants. |

## 5. Order of work

Each step ends with a commit. Every defect gets a regression test that fails first. A confirmation test, one that cannot fail first, gets a seeded control that must fail. The split into M8a and M8b is proposed in S187. Without that split, the steps are one milestone.

0. **Rulings.** Given on 2026-10-05 (section 7).
1. **Work orders on `poly-runtime` (S173).** The runtime-handled path for a workflow's effect kinds: gate, order, report, settle, all journaled. Tested with a scripted agent through the runtime API.
2. **`poly run --mcp` and AC5 under the gate (S174, S175).**
   - The six tools are served over the runtime.
   - The `workflow` stage and the certificate change, and so do the adapter's `install.json` and the boundary allowlist.
   - PT10 and PT18 are revised to say that workflows are gated.
   - AC5's three scripts are compared with polyflow's run; the deny and escalate policies are applied.
3. **`use` (S176).** Imports between modules, a project's modules checked together, qualified machine ids, and configurations across modules.
4. **`Content` (S180).** The type, `PL1209`, representatives in the checker and in poly-ref, and bodies in the runtime's store.
5. **`never emit … while` in machines (S178).** The grammar, the lowering to a step property over the step's emitted intents, and poly-ref's evaluation. Seeded controls for each.
6. **The `channel` front end and lowering.**
   - Both surfaces; `PL6811` and `PL6812`.
   - The descriptor, its read-back and its broken variants.
   - The send rewrite, the generated spawn (S177) and the generated configuration.
7. **The five conversation machines.** Each starts from its provider's documentation, read that day and recorded in `PROVENANCE.md`. Each must be clean, free of deadlock, and prove its `never` statements. A seeded mutant of each rule must give a finding.
8. **`poly-io`: ingress and the channel adapters (S182, S183).** `verify`, `send` and `receipts` for each adapter, against recorded provider traffic, forged webhooks included (K11).
9. **The proposal field `channel` (S181, S185).** Through E10, or through the fallback if it is not vendored.
10. **AC14 to AC17**, end to end, on a small concierge that uses only the channel surface.
11. **The M8 record**, the code review, and the gate from a clean build.

## 6. How each gate item is tested

Each test is written first and fails on the tree before its step.

| Gate item | Test | Fails first because |
|---|---|---|
| AC5 under the gate | `test/workflow-runtime.test.mjs`. AC5's three scripts are run through `poly run --mcp` and compared step by step with polyflow's hand-written workflow on the vendored server, with E12's difference named. Each order has a `verdict` event before it is issued. A denying policy issues no order. An escalating policy issues the order only after a signed approval. The certificate lists no `ungated` limit. | Workflows run only on polyflow. |
| AC14 | `test/channels-ingress.test.mjs`. A recorded WhatsApp webhook delivered twice with one provider message id makes one step. A recorded message from an unverified sender reaches the application with `verified` false in its claims. A forged signature is refused at ingress and logged, and nothing is dispatched. | No ingress. |
| AC15 | `test/channels-whatsapp.test.mjs`. The concierge variant that sends a free-form reply after the window has closed gets a witness from `poly check`. At runtime, with a recorded clock past the window, the conversation refuses the send and the application receives `Rejected("window-closed")`. | No conversation machine. |
| AC16 | The same file. After an opt-out, no send to that recipient is reachable in the configuration until an opt-in: the `never` statement is proved, and its seeded mutant gives a witness. At runtime, sends after an opt-out are refused. | No `never` in machines; no channel. |
| AC17 | `test/channels-escalation.test.mjs`. A policy over `effect.channel` escalates a reply to an external recipient. It is sent only after an approval signed with a person key. A recorded Slack reply to the escalation notice does not approve it. | No `channel` proposal field. |
| The conversation machines | `test/std-channels.test.mjs`. Each of the five is `CLEAN`, free of deadlock, and proves each `never` statement. Each rule's seeded mutant gives a finding with a witness. Each `PROVENANCE.md` names a source and a date for every rule. | No standard library. |
| `use`, `Content`, `never` | One test file each. `use` across modules and a configuration across modules. `PL1209` on every use of `Content` other than storing, passing and equality. The `never` lowering checked against poly-ref's evaluation on every step of a finite instance. | Not lowered or absent. |
| Read-backs | `test/tv.test.mjs` and `test/toolchain-faults.mjs`. The channel descriptor's broken variants are caught: a mapping to the wrong action, a thread key with a field dropped, a library digest changed. | No descriptor. |
| Boundaries | `test/boundaries.test.mjs`. Network modules are refused in every package except `poly-io`. `poly-io` imported by a check package is refused. The adapter allowlist launches `poly run --mcp`, not the polyflow server. | The rules as they stand. |

No test calls a provider or a model. Every adapter test uses recorded traffic, and every decision uses `recordedProvider` (PT26). A live run on a real WhatsApp number is the owner's demonstration, reported and not gated, as M6's agent runs were.

## 7. Spec issues

Numbered from S173. Each has a proposal and waits for the owner's ruling.

- **S173. How a work order runs on `poly-runtime`.**
  - *Proposal:*
    - A workflow's mapped effect kinds are handled by the runtime itself, as `decision.*` and `outcome.*` already are. A certified handler is not required for them, and registering one is refused.
    - The gate decides before the order exists.
    - The agent's report settles the intent: ok or failed, with its data bound by digest. A report for an order not issued, or issued and already settled, is refused and audited.
    - A work order not reported within the effect's declared timeout follows the effect's retry and `exhausted` rules (PT6.1).
  - *Alternative:* a generic "remote handler" for any effect kind. That is wider than S164 needs.
  - *Ruling (2026-10-05):* Accepted, with two additions. (1) PF8.5a holds: once the gate allows a work order, a retry re-issues the same order id and is never proposed again; a report against a superseded attempt is refused and audited, so an agent is never credited twice. (2) A work order's completion actions are delivered by the runtime only (K9): `workflow_signal` cannot dispatch them, and an attempt is refused and audited.
- **S174. Who serves the workflow tools.**
  - *Proposal:* `poly run --mcp` is a new registry command. It loads the project's runtime from `poly.json`: its store, its gate policy and its ledger key. It serves the six workflow tools over stdio, with polyflow's names and schemas, framed by `poly-agent`'s MCP server.
  - One process owns a store at a time, and a second refuses with a clear error.
  - `poly mcp` (the checker's tools) is unchanged.
  - *Ruling (2026-10-05):* Accepted, with conditions. `poly run --mcp` takes the ledger key only from the configured signer, never from a tool argument or the environment. It serves no approve or accept tool (PT12.5). It never logs or records the environment.
- **S175. What is left of polyflow.**
  - *Proposal:*
    - `polyflow.workflow.json` stays as the artefact `poly-runtime` reads, with its read-back unchanged.
    - The `workflow` stage stops running polyflow's `certify`, and the certificate drops `ungated: polyflow runtime`.
    - The Claude Code entry launches `poly run --mcp`, and the boundary allowlist changes with it.
    - The vendored polyflow server stays only as AC5's oracle in tests.
    - E9 is withdrawn.
    - `PL6804` stays: the gate checks each order, but only a path property checks their order, so a workflow without one still checks nothing about its sequence.
  - *Alternative:* drop `PL6804` now that polyflow's rule no longer binds.
  - *Ruling (2026-10-05):* Accepted. `PL6804` stays, for the reason given. E9 is withdrawn.
- **S176. `use`.**
  - *Proposal:* lower `use` in general. Every module a project uses, `std.*` included, is checked together with it. Machine ids are qualified (S28), and a configuration may instantiate a used module's machines.
  - *Alternative:* lower `use std.*` only, and keep `use` between user modules at `PL0901`. That saves little, since the generated configurations need cross-module machines either way.
  - *Ruling (2026-10-05):* Accepted, in general: a project's own modules plus `std.*`. Imports across projects stay out of v1 (PT1.3). After the change, every conformance case, example and evidence script is checked again and must give the same verdicts and state counts.
- **S177. Linking an application instance and its conversation.**
  - *Proposal:*
    - The compiler adds `spawn detached std.channels.<kind>.Conversation as channel:<name> -> Open(app: self)` to the channel's `starts` handler.
    - `self` becomes legal as a whole argument of a detached spawn's creation action, as it is of a `send` (S58 extended).
    - Ingress dispatches `Inbound` to `<app>/channel:<name>`.
  - This replaces PT21.2's "the runtime creates both and gives each the other's `Ref`", which needs E5, with the detached spawn built in M2. The checked configuration is the same pair.
  - *Ruling (2026-10-05):* Accepted. The child key is fixed by the compiler, never built from an ingress string. If `channel:<name>` is not a key the checker already accepts, use a form it does accept and say which.
- **S178. Conversation rules as checked properties.**
  - *Proposal:* a machine may declare `never emit k(f: v, …) while P`. It lowers to a step property that reads the step's emitted intents: "no accepted step from a state satisfying `P` emits `k` with those fields". PS5.2 is extended so that a step property may read `emits(k, …)` on its label.
  - poly-ref evaluates it from the semantics. It is checked in every configuration that includes the machine.
  - *Ruling (2026-10-05):* Accepted, semantics first: the PS5.2 extension is written into `04-semantics.md` and ruled before any code. Each `never` statement has a seeded control that must fail, and translation validation covers the lowering.
- **S179. Reply on rejection (Q1).**
  - *Proposal:* rejection stays message-free (PT6.1). A conversation machine accepts the forbidden send, records the refusal in a counter so that `PL2201` does not fire, and sends `Rejected(reason)` to the application. No new construct, as PT21.3 already states for the final machine.
  - *Ruling (2026-10-05):* Accepted. Q1 is closed.
- **S180. `Content`.**
  - *Proposal:* an opaque type with representatives, as `Principal` (PD5.1.3), and `PL1209` for any other use.
  - Bodies live in the ledger's store by SHA-256 and are written at ingress. A machine holds digests only.
  - PS gains a section on `Content`, written before poly-ref's code, which follows it.
  - *Ruling (2026-10-05):* Accepted, with the PS section written and ruled before poly-ref's code.
- **S181. The taint class before M10.**
  - *Proposal:* bring the `audience` declaration forward from M10 as a declaration only: a total order of classes (Q3 stays open for M10). A channel declares the class of what it receives.
  - In M8, ingress tags each inbound body with that class, and the proposal's `taint.class` is the class of the bodies an effect carries. Propagation through decisions and retrieval, the ghost component, comes in M10.
  - *Alternative:* leave `taint` out of M8 entirely and add it in M10.
  - *Ruling (2026-10-05):* The alternative is taken: no taint in M8. Taint and audiences arrive together in M10. In M8 the proposal carries the `channel` field only, and AC14 to AC17 need no taint.
- **S182. Runtime adapters, and where network code lives.**
  - *Proposal:* a new package `poly-io` holds ingress and the channel adapters. It is the only package where network modules are allowed. No check package (`poly-core`, `poly-lang`, `poly-lower`, `poly-ref`, `poly-embed`, `poly-check`, `poly-agent`) may import it.
  - PT20.2's adapters are called runtime adapters, so that they are never confused with S167's host adapters. Each is bound in the certificate by package name, version and digest (PT20.2, PT26).
  - *Ruling (2026-10-05):* Accepted. In addition, `poly-io` imports no check package; it may import `poly-runtime`'s runtime adapter interface only. The boundary check enforces both directions.
- **S183. Reference providers (Q5), and recorded traffic.**
  - *Proposal:* the reference adapters are WhatsApp Cloud API, Twilio SMS, the Slack Events API with `chat.postMessage`, email by an inbound-mail webhook with SMTP submission, and a generic webhook signed with HMAC.
  - Recorded traffic is built from each provider's documented payloads, with signatures computed under test secrets in the test. No live account enters the repository or the gate.
  - *Alternative:* the owner names different providers.
  - *Ruling (2026-10-05):* Accepted, with this provider list. Only recorded traffic enters the tests; test secrets are generated inside each test and never written to disk. A live run on a real account is the owner's demonstration. No test or gate sends a real message.
- **S184. Keyed send counters.**
  - *Proposal:* M8 has per-period counters as policy `var`s, which exist. Counters keyed by recipient (PT21.6) move to M9, where E11 is needed for grants anyway. AC14 to AC17 do not need them.
  - *Ruling (2026-10-05):* Accepted. E11 is not needed in M8.
- **S185. Policies over the new proposal fields.**
  - *Proposal:* the policy front end types `effect.channel.{name, kind, recipient, recipientClass, messageKind}` and `effect.taint.class`. A policy that reads a field the proposal does not carry gets unknown (PS8.2).
  - With E10 the gate reads these fields. Without E10, the fallback of PT27.2 applies, and the certificate says so.
  - *Ruling (2026-10-05):* Accepted without `effect.taint` (S181): the policy front end types `effect.channel.*` only in M8.
- **S186. The embedded form of a channel.**
  - *Proposal:* `channel(name, { kind, adapter, thread, inbound, starts, delivered, rejected, failed })`, with the same checks. The language server serves it on both surfaces (S168).
  - *Ruling (2026-10-05):* Accepted.
- **S187. Split M8.**
  - *Proposal:* split M8 the way M5 was split:
    - **M8a, the gate's reach:** workflows under the gate (steps 1 and 2), `use`, `Content` and `never` (steps 3 to 5);
    - **M8b, channels:** steps 6 to 10.
  - Each closes with its own review and its own clean gate. M8a's gate is AC5 under the gate and the three language items. M8b's gate is AC14 to AC17 and the conversation machines.
  - *Alternative:* one milestone and one gate at the end.
  - *Ruling (2026-10-05):* Accepted. M8a closes (review, record, and a clean gate on a quiet machine, compared file by file with M6's closing gate) before M8b starts.

### Raised while building

- **S188. The runtime's configuration in `poly.json` (raised at M8a step 2).** S174 has `poly run --mcp` load the project's runtime from `poly.json`: its store, its gate policy and its ledger key. `poly.json` has no field for any of them, and PT1.2's rule (M1-6) is that a field the build needs is raised before it is used.
  - *Proposal:* a `run` field, `{ "certificate": ".poly/certificate.json", "store": ".poly/run/store.sqlite", "trust": { "<keyId>": "file:<public key>" }, "ledger": { "keyId": "…", "signer": "file:<private key outside version control>" } }`. `certificate` and `store` have those defaults. `trust` names the admission keys whose signatures the runtime accepts, as public keys only; a private key there is refused. `ledger` is optional; its signer is `file:` only, never `env:` and never a tool argument (S174). The gate policy is the certificate's, as now. Unknown fields stay refused.
  - Until it is ruled, `poly run --mcp`, its entry in the Claude Code `install.json` and the boundary allowlist that names it wait. The six tools are built and served by `serveWorkflows` over a loaded runtime, and the tests launch them that way.
- **S189. A person's approval for a running `poly run --mcp` (raised at M8a step 2).** An escalated work order waits for a signed approval, which `rt.approve` takes in the process that owns the store. `poly run --mcp` owns it, serves no approve tool (S174), and refuses a second process on its store, so `poly approve`'s record has no way in.
  - *Proposal:* the server watches an approvals folder, `.poly/approvals/` by default (`run.approvals`). `poly approve … --out .poly/approvals/<name>.json` writes the signed record there, as today; the server applies each new record through `rt.approve`, which verifies it against the certified keyring, and moves it to `applied/` or to `refused/` with the reason. Nothing crosses MCP, and an agent that writes a file there without a person's key gets a refusal.
  - *Alternative:* `poly approve --apply` opens the store itself, which needs a second writer on the store and so breaks S174's one process per store.

- **S190. Enums across modules (raised at the S176 ruling; resolve before M8b's step 6).** S176 lets a message to another module's machine carry only values whose types need no module. M8b needs more: PT21.3's conversation takes `name: Template`, and channel kinds are enums, both declared in a std module.
  - *Proposal:* a payload-free enum declared in a used module may be named as `m.E` and its members as `m.E.C` (or by the member alone where the expected type fixes the enum), in fields, parameters and message arguments, with the same check domains. Records, unions with payloads and maps of another module's types stay `PL0901`.

### S176 in detail, for ruling before step 3's code (ruled: `decisions-m8.md`)

S176 lowers `use` in general, within a project plus `std.*`. Rule 7a puts any change to `04-semantics.md` before its code, and `use` changes what a machine's name means, so the semantics text and the choices below are proposed first.

- **Semantics (proposed PS1.0, before PS1.1).** "A **program** is a finite set of modules. A machine is named by its module and its name, `m.M`, and two machines are the same only when both are. `use m` makes the machines of module `m` nameable in a module as `m.M`; it adds no behaviour, no state and no message. PS1.6 to PS13 read `M` as the qualified name throughout." No other PS text changes: a `Ref<m.M>` in a machine checked alone still ranges over `none` and symbolic addresses, and a configuration's instances may now be of machines of several modules.
- **What `use` names.** `use m` (a module) and `use m.M` (one machine) both admit the qualified name `m.M` and nothing else; there is no unqualified alias. A qualified name of a module that is not used is `PL1001`, as an unknown name is now. `use` of the module itself is refused (`PL1201`).
- **Where a qualified machine may appear.** `Ref<m.M>`, `spawn detached m.M`, a send to such an address, and a configuration's instance `x: m.M`. An **attached** spawn of another module's machine stays `PL0901`: an attached child is checked as one cascade with its parent (PT7), and the joint machine across modules is not built here.
- **Types across modules.** A message to another module's machine may carry only values whose types need no module: booleans, ranges, `int`, checked strings, `Principal` and addresses. An argument of a type the receiver's module declares (an enum, a record, a union) is `PL0901` with the reason, until types cross modules. M8b's conversation machines need no more.
- **Resolution.** A used module is found among the project's modules (poly.json's `modules`), or, for a file checked outside a project, among the `.poly` files of its directory; `std.*` is found under the repository's `std/` (empty until M8b). A module not found is `PL1001` at the `use`. Cycles are allowed: the modules of a program are checked together, each once.
- **Checking.** Each module is still checked, lowered and reported on its own, with its own build directories and digests. A module that uses others is typed against their declarations, and its configurations are composed from the machines of every module they name. poly-ref, which shares no code with the compiler, receives the ASTs of all the modules a configuration names (types only from `@poly/core`, as now).
- **The runtime.** Unchanged in kind: machine ids are already `m.M` (S28), and a certificate already lists the machines of every module of a project.
- **The regression check (ruled).** After the change, every conformance case, example and evidence script is checked again, and each verdict and state count is compared with the one recorded before (`scripts/measure-verdicts.mjs`, 143 files, and `test/evidence.test.mjs`). Any difference goes to the owner before the commit.

### S180 in detail, for ruling before step 4's code

S180 is ruled with the PS section written and ruled before poly-ref's code. The text proposed, and the choices under it:

- **Proposed PS1.4a, after PS1.4.** "**Content.** `Content` is an opaque reference to a body, identified by the SHA-256 digest of its bytes, or `none`. A module may store a `Content`, pass it, and compare two with `==` and `!=`; no other operation reads it (`PL1209 CONTENT_NOT_OPAQUE`): not an order, arithmetic, a comparison with a string, a map key, a field of a record, a `match`, or a check domain. Its type has no finite domain of its own; check explores it by representatives, as PS4.1c explores `Principal`."
- **Proposed PS4.1d, after PS4.1c (written as PS4.1f: PS4.1d was taken).** "**Content (S180).** *Lemma (renaming invariance):* in a module where `Content` is opaque, for every bijection `π` on bodies, `(s, l, s') ∈ R_M` iff `(π s, π l, π s') ∈ R_M`, since no handler, guard or property can tell two bodies apart except by equality. So PS4.1b extends to `Content`: every path of **run**, whatever bodies it carries, is the renaming of a path of **check** over a finite set of representatives, `none` and `c1 … cn`, where `n` is the number of `Content` positions in the state plus the most `Content` values one label carries, and never fewer than 2. The verdict prints `n` in its instance. `Principal` and `Content` are counted separately: a body is never a principal."
- **Run.** A `Content` value is the digest string `sha256:<hex>`; the runtime's content store (the ledger's bodies by digest) holds its body. A dispatch whose `Content` names no body in the store is outside its type and refused before any step (PS3.2, S140), as an address naming no instance is. M8a writes bodies into the store through the runtime API; ingress writes them in M8b.
- **What M8a does not do.** No taint (S181), no channel, no decision over `Content`: a typed decision or extractor that reads a body is PD1's and comes with the channels. A `Content` in an effect's payload is an address-like value the handler receives as its digest, and may resolve through the store; whether a handler may read bodies at all is a capability question for M8b.
- **Codes.** `PL1209 CONTENT_NOT_OPAQUE`, as PT27.1 lists it, in the `PL12xx` range beside `PL1206`.

## 7a. Rules for the whole milestone

- **Gates.** Every gate in M8 runs from a clean build on a quiet machine, checked and recorded first. Per-file timings are compared with the previous closing gate.
- **Semantics first.** Any change to `04-semantics.md` (S178, S180) is written and ruled before the code that follows it.
- **Fail first.** Every defect gets a regression test that fails first; a confirmation test gets a seeded control that must fail.
- **No live secrets.** No provider account, secret, API key or real message enters the repository, the tests or the gate. No code reads, logs or records the environment.
- **Records.** Each ruling and each engine item found while building (from E13) is recorded in `decisions-m8.md` the day it is made.

## 8. Risks

- **M8 is large.** It adds a second runtime path, imports between modules, a new type, a new property form, a new package and five provider integrations. S187 splits it so that the gate's reach is closed before channels depend on it.
- **Provider documentation moves.** A conversation machine encodes the rules as they were read on one date. A rule the provider later changes is a new module version (PF8.7). Since migrations are not lowered yet (PL0901), M8 ships first versions only, and the limit says so.
- **E10 timing.** If polyaxion does not take E10 during M8, the fallback holds, and the certificate names the check as poly's. AC17 does not depend on which one holds.
- **One store, one process.** `poly run --mcp` serialises access to the store. Two agents on one project share one server, not one store across two servers (S174).
- **Recorded traffic is not live traffic.** Adapter tests prove that the adapter handles what the provider documents. K11 states the rest. The live demonstration is reported, not gated.

## 9. Record of M8, as it is built

**M8a step 1, work orders on `poly-runtime` (S173).**

- **Found first:** `poly-runtime` could not load a build with a workflow at all. The certificate lists each descriptor among its artefacts, and the runtime never read it, so the load was refused with "certified but missing". Every test of `test/workflow-orders.test.mjs` failed first on that.
- **Built:**
  - The load reads each certified descriptor once, checks it with the other artefacts, and refuses a workflow that maps a kind its machine does not emit.
  - A workflow's mapped kinds are work orders. When the gate allows one, the worker takes `Start` and issues the order instead of running a handler. The order (tool, target, reason, arguments) is observed on the run by digest, after the `verdict` event, and its deadline is the effect's declared timeout.
  - `rt.workOrders(run?)` lists the open orders. `rt.reportWorkOrder(id, { attempt, ok, result | error, permanent })` settles one: an ok report goes through the gate's settle and the success completion, as a handler's result does; a failed one retries, or delivers the exhausted completion at the bound.
  - Registering a handler for a work-order kind is refused.
- **The two additions of the ruling:**
  - PF8.5a: a lapsed order is recovered as a lost attempt and re-issued at the next attempt, with no second proposal (as first built, under the same order id; amended below). A report of an unknown order, of a superseded or lapsed attempt, or of an attempt already reported is refused and audited (rule `S173`).
  - K9: an outside dispatch of a work order's completion action is refused and audited (rule `K9`).
- **Controls.** Six seeded mutants of the built runtime were each caught by the test file: the K9 refusal removed, a superseded attempt taken, a lapsed attempt taken, a handler allowed for a work order, an order issued with no deadline, and a retry proposed again. The lapsed-attempt mutant was not caught by the first version of the tests, so a test for it was added before the commit.
- **Accepted, and S173 amended (`decisions-m8.md`).** Each issued attempt now has its own order id, derived from the intent and the attempt number (`<intent>#<attempt>`, opaque to agents); the gate's decision stays the intent's, once. A report names only the order id, as polyflow's `workflow_report` does, so a report of a replaced attempt is refused and audited by its order id. Tested: a late report carrying the old attempt's order id is refused while the new attempt is open, the new attempt's report is accepted, and the gate is proposed exactly once across both attempts. Two more seeded faults are caught: one order id reused across attempts, and a replaced attempt's report taken.
- **Polywatch on step 1.** The open orders listed a Running intent before its order was issued, so a report could land between `Start` and the issue. Now an order exists only once its issue is in the ledger: it is listed, and its report taken, only then. Tested by a crash in that window, and a seeded fault that takes an order before its issue is caught.
- **Not yet:** the MCP tools, run keys, the certificate's wording and the `workflow` stage are step 2. Until then the certificate still says `ungated: polyflow runtime`, though a build loaded in `poly-runtime` gates its work orders.

**M8a step 2, part one: the tools over the runtime, and S175 (`test/workflow-runtime.test.mjs`).**

- **Runs.** `rt.startWorkflow` derives the run key from the input by the key template and its patterns, as polyflow does; a key the caller passes is ignored, with a note, and a second start attaches with no new step. `rt.workflowList`, `rt.workflowView` and `rt.advance` (every due step taken before a view) serve the tools.
- **The six tools** are polyflow's, with polyflow's names and input schemas (compared against the vendored server's `tools/list`), served over a loaded runtime by `poly-agent`'s `serveWorkflows`. There is no approve or accept tool. `workflow_report` names only `order_id`; a refused report answers with the reason, and changes nothing.
- **AC5 under the gate.** The three scripts (approve, deny, empty brief) give the same catalogue entry, work orders and states through poly-runtime as polyflow's hand-written workflow on the vendored server, step for step, with E12's difference named. In the ledger every issued order follows the gate's allow of its intent. A policy that denies `post_brief` issues no order for it, and the run ends `failed`; one that escalates it issues no order while the escalation waits. A signal of a work order's completion is refused (K9).
- **S175.** The `workflow` stage and `poly-check`'s dependency on polyflow's server are gone; a workflow's machine is checked by poly's own stages, and `conformance/m6/long.poly`, which polyflow's bound refused, is now `CLEAN` by the effects stage over every path. The certificate lists each workflow as `{ runtime: "poly-runtime", gated: true }`, with no `ungated` limit, and a certificate that lists one as run by polyflow is refused at load. PT10 and PT18 say so.
- **Controls.** Five seeded mutants of the built packages, each run against the test file: no advance before a view, a refused report shown as a view, the caller's key taken, and an approve tool served were caught. The fifth, a second start creating the run again, gave the same behaviour, because polyrun's create of an existing id takes no step: an equivalent mutant. The test now also checks that attaching takes no step.
- **Waiting on S188 and S189:** `poly run --mcp` itself, its `install.json` entry and the boundary allowlist, and a person's approval reaching a running server.

**Polywatch on part one (304b88a).** A call that threw was answered as a view with `isError` false; it now gets `isError`, as polyflow's server answers it, while a refusal the tool returns stays a view, as polyflow's schema has it. Load now refuses a certificate whose workflow entry names the descriptor of another workflow. A third claim, that the read tools should take due steps, was not taken: reads stay pure, as polyflow keeps them, and an order past its deadline is never shown as open.

**M8a step 2, part two: S188 and S189, as ruled (`test/run-config.test.mjs`, `test/run-approvals.test.mjs`).**

- **S188.** `poly.json` has a `run` field: the certificate, the store, trust as admission public keys (`file:` only), an optional ledger signer and the approvals folder. Its schema is published at `schemas/manifest/run.json` and is the one the parser enforces; an unknown field under `run` is refused. `loadRun` reads it: a trust file that holds a private key is refused; a signer that is not `file:` is refused when `poly.json` is parsed, one whose path resolves inside the project (relative or absolute) is refused at load, and one that is not a key is refused, each naming the path and never the contents. The test of the signer inside the project was written first. In the end-to-end test the signer's contents appear neither in the server's output nor in the ledger. One process owns a store, by a lock file naming its process id; a second is refused while the first lives.
- **S189.** `rt.takeApprovals(dir)` takes each `*.json` record in file-name order and applies it through `rt.approve`, which verifies it against the certified keyring and the open escalation it names (the escalation's verdict event, which carries the intent and the gate's sequence). Refusals carry a reason: `not-a-record`, `wrong-key` (an agent's key, or one the keyring does not hold), `unmatched`, `replayed` (the same record again, under any file name) and `expired` (after the escalation timed out). Every outcome is a `verdict` event on the runtime's own `runtime:approvals` run, with the record kept by digest; the file is moved to `applied/`, or to `refused/` with `<file>.reason.txt`. The tests for replay, expired, unmatched and wrong-key came first. A further test takes the journaled records again, in journal order, on a runtime in the same state, and gets the same outcomes.
- **The command.** `poly run --mcp [--project <dir>]` is a registry command (no MCP tool, no language-server command), with published schemas. It loads the run, serves the six tools, and once a second, in the same queue as the calls, takes due steps, applies the approvals folder and signs the ledger's heads. End to end, a person's approval written by `poly approve --out approvals/001.json` reaches the running server, and the escalated order is issued.
- **The adapter.** The Claude Code `install.json` launches `poly run --mcp --project ${PROJECT}` for the workflows, and the boundary check allows exactly that launch, with no environment; the polyflow server's launch is refused. The install test admits its project with a `run` field and drives AC5's script through the entry as printed.
- **The stale store lock (ruled after step 2).** The OS lock decides: an exclusive SQLite lock on `<store>.lock.db`, held for the server's life and released by the OS when its process ends, so a reused process id cannot fool it. The lock file records the owner's process id and start time, for the error text and the journal only. A stale lock is taken over and journaled on `runtime:store` with the old id and start time. Tests first: a live lock held by a child process is refused, naming its id; a child killed with its lock file left behind is taken over and journaled; a lock file naming the test's own live process with another start time is taken over. The live-lock test passed before the change, since the old lock already refused a live id; the stale and reused-id tests failed. Seeded faults: a live lock taken over (caught by the live-lock test), and a decision from the lock file (caught by the reused-id test). **Limit:** the store must be on a local disk; OS file locks are unreliable on network shares.
- **Controls.** Seven seeded faults, each caught: the single-use check skipped (as ruled), the expiry not named, records taken out of file-name order, a refusal not journaled, a signer inside the project taken, a private key taken as trust, and no store lock.

**Polywatch on the store lock (4cdd00e).** A lock file that could not be written, an approvals path that is a file, and a failing takeover entry each left the OS lock held; a load that failed after finding a stale lock lost the stale owner's record. Each is fixed; two have tests that failed first, and the takeover entry is covered by construction.

**M8a step 3, `use` (S176, PS1.0; `test/use.test.mjs`).**

- **Built.** The checker, the lowering, poly-ref and the runtime spell a machine of another module `m.M` and one of the module's own `M`, so a configuration composes machines of several modules with one spelling for each. `poly check` finds used modules with `packages/poly-check/src/uses.ts`: the project's modules, or a lone file's directory read as a search path (a file is read only when its header names a module `use` asks for), and `std/` for `std.*`. Two files of one used module are `PL1002`, naming both; a module not found or not parsing is `PL1001` at the `use`.
- **Tests.** `conformance/m8/use/workers.poly` and `dispatch.poly` are `conformance/m2/detached.poly` split in two modules that use each other: the same verdicts and state counts as the original (Worker 9 states and 45 transitions, Dispatcher 3 and 6, the configuration 5 and 8), and the configuration's property broken gives a finding. An unused `use` added to four files changes no verdict, diagnostic or count. A directory with an unrelated broken file, a file that uses a missing module, and a file with no header gives the same result as a clean one. Qualified names only, a module not used, a module that uses itself, an attached spawn across modules, and a type the receiver's module declares are each refused. At run time a message crosses modules (`ledger.poly`, `teller.poly`), and an address naming no instance of the other module's machine is refused (S140). Five seeded faults are caught: a duplicate module resolved by picking one, a declared type carried across modules, poly-ref spelling another module's machine by its last name, every file of a directory read with its errors reported, and an attached spawn across modules allowed.
- **The regression check (ruled).** The 143 conformance cases and examples measured again (`docs/m8/verdicts-after-s176.json`) are identical to the record before S176 (`docs/m8/verdicts-before-s176.json`) in verdict, diagnostic codes, and every machine's and configuration's state and transition counts: 143 of 143, no difference. The four new files are the step's own. `test/evidence.test.mjs` passes 10 of 10, as before.

**M8a step 4, `Content` (S180, PS1.4a, PS4.1f; `test/content.test.mjs`).**

- **Semantics first.** PS1.4a, the `content-missing` row of PS3.2 beside `claims-unverified`, and PS4.1f were committed before any code (45c1fa9).
- **Built.** The checker types `Content` as opaque: stored, passed, compared with `==` and `!=`, and nothing else. An order, arithmetic, a comparison with a string, a map key, a record or payload field, a check domain and a digest written in source are each `PL1209 CONTENT_NOT_OPAQUE`; `content-missing` joins PL1207's reserved reasons, and `$content` PL1208's reserved names. A decision over a Content is `PL0901` until the channels. Check explores a Content by `none` and `n` representatives, `n` the Content positions of the state plus the most Content values of one label, never fewer than 2, counted apart from principals; the instance prints the count. The lowering and poly-ref compute `n` each on its own and write the representative `ci` as the digest `sha256:` followed by `i` in 64 hex digits, so every value of the contract's domain is in the runtime's type (S140). At run time `rt.putContent` stores a body under its digest and `rt.contentBody` reads it back; a Content naming no body is marked under `$content` by the runtime (at dispatch, at creation and on an effect's completion), and the module's first acceptor rejects the step `content-missing`, journaled, the state unchanged. A caller that supplies `$content` is refused (S155). Translation validation probes the row in every reachable state, and the deliberately broken lowering `skip-content` is caught by it (`test/toolchain-faults.mjs`). `conformance/m0/errors/PL1209-content-literal.poly` is PL1209's error source. Out of M8a, as ruled: taint, channels, and any decision that reads a body.
- **Tests first.** `conformance/m8/content/notes.poly` (a stored body compared with a second) is CLEAN with 2 representatives; with a property that fails only when the two differ, check finds it. Each PL1209 case, PL1207 on `content-missing`, the runtime row by dispatch and by an effect's completion, and the S155 refusals at dispatch and creation.
- **The four seeded faults of the ruling, each caught by the test file:** a digest literal accepted; arithmetic or ordering on Content accepted; a missing body reaching the module; one representative used where two Content values are compared (in poly-ref and the lowering together).
- **Polywatch.** The lowering decided by the name `Content`, so a module that declares its own `enum Content` got a `content-missing` row and a `$content` key; it now decides by the resolved type. Creation did not refuse a caller's `$content`; it now does, as dispatch does. Both tests failed first.
- **The regression check.** The 147 files of `docs/m8/verdicts-after-s176.json`, measured again, are identical in verdict, diagnostic codes and every state and transition count: 147 of 147. The three new files are the step's own (`notes.poly` and `fetch.poly` CLEAN, the PL1209 error source REFUSED). The whole suite: 1534 tests, 1528 pass, 4 todo, 1 skipped, and 1 failure, `test/m3-isolation.test.mjs` failing to delete its temporary folder (EPERM on Windows under the parallel run); that file alone passes 5 of 5. `test/evidence.test.mjs` passes 10 of 10. The first run of the suite found three defects of this step, each fixed before the record: `skip-content` missing from poly-lower's list of faults, no error source for PL1209, and representatives spelled `c1`, outside the runtime's digest type (S140).
- **The row order, ruled after the commit (`decisions-m8.md`).** PS3.2 placed the `content-missing` row before `a ∉ dom(H)`, so poly-ref rejected an unhandled action carrying a missing body while polyrun answered `unhandled`. The unhandled row now comes first, and the claims row moved with it, though it could never apply to an unhandled action. Tests first: poly-ref answers `Peek` of `conformance/m8/content/unhandled.poly` `unhandled` with a missing body (failed first), the runtime does too, and translation validation now probes the content row on actions with no handler. Under the extended probe, poly-ref's old order gave `PL2501` before the change. The broken lowering `content-before-unhandled` is caught; it was caught by the old validation too, through the ordinary transition comparison.
- **Polywatch on the row order.** The lowered content row stood only in each action's own acceptor, which sam-pattern runs after the first acceptor's guards, so a missing body in a state where a guard fires was rejected with the guard's reason; PS3.2 puts the content row before `h_a` and its guards. `conformance/m8/content/guarded.poly` gave `PL2501` first. The row is now in the first acceptor, after the claims row and before the guards, and repeated in the action's acceptor as the claims row is.
- **A test defect.** The `m3-isolation` failure above was reproduced (a child process's working folder cannot be deleted on Windows) and fixed with bounded retries; the test fails only if the folder is still there afterwards.


## Conclusion

M8 first closes the one gap M6 left open: a workflow's work orders will cross the gate and enter the ledger like every other effect, served by poly over the same tools polyflow serves today, with polyflow kept only as the oracle AC5 compares against. Channels then follow PT21 with three changes proposed:

- the application and its conversation are linked by a detached spawn, so E5 is not needed (S177);
- conversation rules become a `never` statement checked as a step property over emitted intents (S178);
- network code is confined to one new package that no check package may import (S182).

The fifteen issues, S173 to S187, are ruled, and E10 is on the engine list for the `channel` field.
