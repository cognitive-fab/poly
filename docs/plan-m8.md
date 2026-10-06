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

### S178 in detail, for ruling before step 5's code

S178 is ruled with the PS5.2 extension written and ruled before any code. The text proposed, and the choices under it:

- **Proposed PS5.2, replacing it.** "**PS5.2** A **step property** is a predicate `Q(s, a, d, s', E)`, where `E` is the intent sequence of the step's verdict `accepted(E)` (PS3.2). It holds iff `Q` holds for every **accepted** transition from a state in `Reach(I)`. `Q` reads `d` only where `action == A` narrows the action, with the names of PS2.2 (S19). `Q` reads `E` only through `emits(k, f1: v1, …, fn: vn)`, `n ≥ 0`, which is true iff some intent of `E` is an effect of kind `k` (an `emit`, PS2.2) whose payload field `fi` equals `vi` for every `i`. Each `vi` is a constant of its field's type: an enum constructor, an integer, a boolean, or `none`; `emits` reads no field, parameter or body. A rejected step emits nothing (PS3.2), so reading only accepted steps misses no intent."
- **Proposed PS5.2a, after PS5.2.** "**`never emit` (S178).** `never n: emit k(f1: v1, …) while P` declares the step property `n: P(s) implies !emits(k, f1: v1, …)`, where `P` is a predicate on the pre-state alone: it names fields, and neither `post.`, a parameter nor `action`. It holds iff no accepted step from a reachable state that satisfies `P` emits an effect of kind `k` with those field values. Without `while P`, `P` is `true`. `k` must be an effect kind the machine declares and each `fi` a payload field of `k` (`PL1001`); a value outside its field's type is `PL1201`. A violation is a finding whose witness is the path to the pre-state and the step that emits. By PS4.4, `I` over-approximates every environment the machine runs in, a configuration included, so a `never` that holds on `I` holds for every instance of the machine in every configuration. A witness that uses a completion or a message nothing sent is marked `environment: unconstrained` (PS4.4); the configuration check evaluates the machine's `never` statements on that instance's global steps, which confirms such a witness or rules it out. A machine's `never` is not a policy's `never` (S149): the policy's is proved over the gate's decision table, and the machine's over `R_M`, before any gate."
- **Choices under it, for ruling.**
  - **The pre-state.** `while P` reads `s`, as S178 proposed ("from a state satisfying `P`"). A step that opens the window and sends is allowed by `while window is Closed`; a step that sends from a closed window is not, whatever it writes. Reading `s'` instead would allow a step that sends and opens the window at once.
  - **A name.** `never n:` takes a name, as every other property does, so a finding and a witness name it. PT21.3's sketch has none.
  - **Effects only.** `emits` names effect kinds of `emit`; a `send`, a timer, a spawn or a signal is not matched. PT21.3's `send` is an effect kind named `send`, not the `send` statement.
  - **Constants only.** A field is compared with a constant. Comparing it with a field or parameter (`to: owner`) is left out; a `Content` field compares only with `none`, as PS1.4a allows.
  - **Lowering.** The lowered step property needs the step's intents. The property module would call the effects mapper on the step, an artefact translation validation already compares (PS9.2); the form is PT's, after the ruling. Translation validation compares the lowered `never` with PS5.2a on every reachable step, and the seeded controls are a `never` dropped, its `while` inverted, and a field filter dropped.
- **Codes.** None new: `PL1001` and `PL1201` for the statement's names and values, and `PL3002 STEP_PROPERTY` for a violation, as for any step property.

### M8b step 1 (plan step 6), the channel, in detail: PS text for ruling before any code

M8b's steps are the plan's steps 6 to 10 (S187); its step 1 is the `channel` front end and lowering. A channel adds no transition rule: its meaning is a program written with constructs that already have one (detached spawn, `send`, configurations). The proposed text says so, and fixes the expansion that both the lowering and poly-ref follow.

- **Proposed PS15, after PS14.** "**PS15 Channels (M8b).** A channel adds no step, verdict or property of its own. `channel c: k { … }` in module `m` means the program obtained by the expansion below, and every other section reads the expanded program. `k` names the module `std.channels.k`, which declares the machine `Conversation`, its peer machine `Peer` (an interface: its actions are the messages the conversation sends to the application, and it has no state and no handler), and the conversation's actions `Open(app: Ref<Peer>)`, `Inbound(…)`, `Reply(…)` and `Template(…)`.
  - **PS15.1 The conversation of a channel.** The channel instantiates `Conversation` as the machine `m.c.Conversation`: its peer type becomes `Ref<A>`, `A` being the application machine whose action `inbound` names, and each message it sends its peer under a name `N` is renamed to the action the channel maps `N` to (`inbound`, `delivered`, `rejected`, `failed`), and its provider effect takes the kind `channel.c.send`. The instance has the conversation's states, handlers and properties unchanged; parameters are matched by name, and a mapped action whose parameters differ is refused (`PL1201`).
  - **PS15.2 The link.** The handler of the action `starts` names gains, as its last statement, `spawn detached m.c.Conversation as c -> Open(app: self)`: the child key is the channel's name, fixed by the compiler (S177), so the conversation of the application instance at address `p` is at `p/c`. `self` is legal as a whole argument of a detached spawn's creation action, as it is of a `send` (S58, S177). A key `c` used otherwise in `A` is `PL1002`.
  - **PS15.3 The rewrite.** In `A`'s handlers, `emit c.reply(args)` is `send c <- Reply(args)` and `emit c.template(args)` is `send c <- Template(args)`, `c` reading the address of the child spawned under that key (PS7.5). Only the conversation emits the provider effect `channel.c.send`.
  - **PS15.4 Inbound.** A message from the provider is the action `Inbound` of the conversation at `p/c`, where `p` is the application instance its thread key names (PT21.1b). When no instance has that key, the application instance is created first with `starts`, whose step spawns the conversation; `Inbound` is then delivered to it. The conversation sends the message to its peer, which the renaming of PS15.1 makes the application's `inbound` action.
  - **PS15.5 The checked configuration.** Each channel gives the configuration `c` (PS13): the instance `app: A`, created by `starts`, with its conversation as the detached child `c`; the inputs are `A`'s `starts`, the conversation's `Inbound`, and the completions the conversation's provider effect is wired to (the provider's receipts); the transit bound is the conversation's declared `pending` bound, and the instance bound two. The conversation's `never` statements are checked on it alone (PS5.2a) and in this configuration; an application that leaves a message unhandled gets `PL5102` or `PL5402` with its witness, as any configuration does."
- **Choices under it, for ruling.**
  1. **A peer interface in the std module.** `Peer` is how a generic conversation names the application without knowing it; PS15.1's renaming binds it. The alternative, generating a conversation per application with names spliced into its source, gives the same machine but no single source to review.
  2. **The child key is the channel's name** (`c`, address `p/c`). `channel:<name>` is not a key the checker accepts (a key is an identifier, S49), as S177 allowed for; the channel's name is unique in the module, and a clash is `PL1002`.
  3. **Inbound goes to the conversation**, as S177 and PT21.4 say, so its rules see every message first (the window opens on `Inbound`).
  4. **The configuration is generated per channel**, named after it, and is checked with the module like a declared one; its instance bound counts the conversation.
- **What is PT's, not PS's.** The surface (PT21.1), the descriptor `channels/<name>.json` with its read-back and broken variants, `PL6811 CHANNEL_KIND_UNKNOWN` and `PL6812 THREAD_KEY_INVALID`, and the embedded form (S186). The std conversation machines are step 2 (plan step 7); step 1 is tested with a minimal `std.channels.test` kind written for the tests, under the test-only `std` option, since `std/` does not exist yet.

### E13 in detail: `createInstance` in polyrun (approved; the owner makes the change and the re-vendor)

What poly needs from the kernel for a detached spawn (S60, S78) and a channel's thread (PS15.2, PS15.4). poly already lowers the intent; today polyrun 8.3.2 refuses it as an undeclared kind and poisons the creation.

1. **The operation.** `createInstance(machine, id, data)`: create the instance `id` of the registered machine `machine`, in its initial state, and take its creation action `data = { action, data }` when one is given. From a step, it is the intent `{ kind: 'createInstance', machineId, childKey, creation?: { action, data } }` of the effects mapper, and `id` is `<parent>/<childKey>`; address markers in `creation.data` are resolved at commit, as `resolveAddresses` already does (`{ $ref: 'self' }` is the parent's id).
2. **Atomic with the step that emits it.** The parent's step and the new instance commit in one transaction, as `spawnChild` does: the parent's journal row first, then the child's row 0 `$create` and its creation action's row. A crash leaves both or neither.
3. **Refusal of an existing id.** When an instance `id` exists, nothing is created and the parent's step stands: the refusal is journaled on the parent's run as a rejected row `$uncreatable` that changes nothing, with the reason `instance '<id>' exists` and an action id that dedupes a repeat, as `$undeliverable` is for a send (S89). This is S83's rule, `PL5101` in a configuration.
4. **No poisoning.** A creation that cannot be taken (no such machine, no such creation action) is refused the same way, journaled on the parent's run with its reason, and poisons neither instance. A creation action the child's module rejects leaves the child in its initial state with its rejected row, as `create` does today; the parent's step stands.
5. **The order of PS15.4, as reworded.** `create(application, { action: starts })` commits, in one transaction: the application's `$create`, its `starts` step, and, from that step's intent, the conversation's `$create` and its `Open` step, in that order, and the step events are emitted in that order. poly-runtime then delivers `Inbound` to the conversation in a transaction of its own. A rejected `starts` emits no intent, so no conversation is created, and poly-runtime refuses the message `thread-not-started`.
6. **The version.** polygraph **8.4.0** (a new intent kind, nothing removed), re-vendored by hash and commit in `vendor/polygraph/PROVENANCE.md`. poly-runtime's `kernelCreatesInstances` reads the vendored version and turns on at 8.4.0; until then `rt.inbound` refuses a creation `creation-unavailable` before the kernel. The two tests waiting on E13 in `test/channels.test.mjs` then run, and the `creation-unavailable` test skips itself.

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


**M8a step 5, `never emit … while` (S178, PS5.2, PS5.2a; `test/never.test.mjs`).**

- **Semantics first.** PS5.2 (a step property reads the step's intents through `emits`) and PS5.2a (`never`) were committed before any code (f5df1f1), with the five choices as ruled, and the out-of-scope kinds written into PS5.2.
- **Built.** The parser reads `never n: emit k(f: v, …) while P` as a machine item and `emits(k, f: v, …)` as an expression; the formatter and the embedded surface (`never(…)`, `emits(…)`) print and read both back to the same digest. The checker refuses `emits` on anything but an effect, naming what it is (a timer, a spawned child, an action a send or timer delivers), a field that is not the payload's, a value that is not a constant of the field's type, `emits` outside a step property, and a `while` that reads `pre.`, `post.`, a parameter, `action` or `emits`; a never shares the properties' names. The lowering puts each never into `transitionInvariants` as `P(pre) implies !emits(…)`; a step property reads the step's intents through `__emits`, over a copy of the effects mapper embedded in `invariants.mjs`, generated as `effects.cjs` is but with no fault. poly-ref builds each never as the step property PS5.2a defines and evaluates `emits` over the step's intents; translation validation compares the lowered never on every reachable step. A never's witness is marked `environment: unconstrained` when it takes a completion no earlier step asked for or a message nothing sent (PS4.4). Each configuration checks the never statements of its instances' machines on their global steps (`PL3002`, named `<instance>.<never>`); a machine's unconstrained finding is ruled out, listed under `ruledOut` and not counted, when every configuration that includes the machine checked it to the end and found no violation.
- **Tests first.** All nine tests of `test/never.test.mjs` failed before the code. Choice 1 both ways on `conformance/m8/never/window.poly`: from an open window, a step that writes the window open and sends is allowed (`Reply`), and so is one that closes it and sends (`Close`); from a closed window, a step that opens it and sends (`Inbound` with a send added) is a finding. The field filter (a templated send while closed is allowed, a free-form one is a finding), `never` without `while`, and the same rule as a step property that reads `emits`. `PL1001` for `emits` and for `never` on a send, a timer key, a timer's action and a spawn, each; `PL1001` for a field that is not the payload's, `PL1201` for a value outside its type and for each forbidden read in `while`, `PL1002` for a never named like a property. Unconstrained witnesses: alone, `Chat` of `chat-ruled-out.poly` sends at once on `Reply`, a message only `App` sends, and the witness is marked; in that file's configuration nothing closes the window once it opens, so the configuration rules the witness out and the file is CLEAN; in `chat-confirmed.poly` the configuration offers `Expired`, finds `Reply` arriving at a closed window, and confirms it (FINDINGS, with `chat.free-when-closed` in the configuration).
- **Seeded faults, each caught by translation validation with `PL2501` on `window.poly`:** `drop-never` (missing from the lowered property module), `invert-never-while`, `drop-never-filter`, and `never-post-state` (while evaluated on the post-state: `Close` sends and closes, which the lowered property then refuses).
- **The regression check.** The 147 measured files are identical in verdict, diagnostic codes and every state and transition count; the eight new files since S176 are steps 4's and 5's own (`window.poly` and `chat-ruled-out.poly` CLEAN, `chat-confirmed.poly` FINDINGS by design). The full suite: 1,553 tests, 1,547 pass, 1 skipped, 4 waiting, and 1 failure, the m3-environment crash counted under load (`decisions-m8.md`).

### The code review of M8a

Four reviewers read `d9ad88c..6e0920f` in four parts (A: work orders, the workflow tools, `poly run --mcp`, approvals and the store lock; B: `use`; C: `Content`; D: `never`), and each reproduced every finding with a script under `.poly/review-m8a-a` to `review-m8a-d`. They found 22. Each is fixed, with a test in `test/review-m8a-a.test.mjs` to `review-m8a-d.test.mjs` that failed on the tree before its fix; B-F6 after the owner's ruling.

| Finding | What was wrong | Fix |
|---|---|---|
| A-F1 | a signer inside the project, named by its 8.3 short path, passed S188's check | paths compared through `realpathSync.native`, which expands short names |
| A-F2 | one approvals entry that could not be read (a dangling junction, a file denied by an ACL) stopped every pass, with nothing journaled, and `poly run --mcp` could not start | the entry is refused `not-a-record` and journaled, the pass goes on; an entry that cannot be moved is journaled once and passed over |
| A-F3 | a second runtime that named the owned store another way (its short name, a hard link) took a lock of its own and wrote to its own log | the store is opened and locked by its one real path; a store file with a second name is refused |
| B-F1 | a used module the checker refuses was composed into a configuration that read CLEAN | its errors refuse the check that uses it, each at its own line |
| B-F2 | module `b`'s spawn of `b.c.X` looked up machine `X` of module `c` | the spawner's module is stripped only when a machine's name remains |
| B-F3 | two files declaring the checked module were not refused when another module used it | `PL1002`, naming both files |
| B-F4 | a field whose enum another module declares was compared in the view module's namespace | read with `is` in its own module's types, then, once S190 was ruled, typed `m.E`, with `==`, `!=` and `match` |
| B-F5 | a dotted module's machine could not name its group of detached instances | the whole member chain names the group, in the checker and in poly-ref |
| B-F6 | `use m.M` made every machine of `m` nameable | as ruled, `use m.M` admits `m.M` only; two `use` clauses admit both, and `m`'s own machines still name each other |
| C-F1 | a `map` of `Content` in a record field or a union payload escaped `PL1209`, and check counted too few representatives (CLEAN on a machine with a reachable violation) | `PL1209` through maps too |
| C-F2 | an effect handler's reply could forge `$content` (and `$claims`, `$lineage`) on its completion | the reserved keys are dropped from a reply |
| C-F3 | translation validation probed the content row only with `none`, which the runtime never marks | the probe's data names a body; the broken lowering `content-row-on-none` is in the explicit list and caught |
| C-F4 | creation data outside its type was journaled as a step | refused before any step (S140), as at dispatch |
| C-F5 | `match`, `is`, a bool position and a Content mixed with a string were `PL1201` | `PL1209`, as PS1.4a names |
| C-F6 | two bodies with lone surrogates shared a digest | such a body is refused |
| D-F1 | an unconstrained witness ruled out by a configuration hid a constrained one (a silent clean) | the never's finding is a constrained witness where one exists; only a finding with no constrained witness can be ruled out |
| D-F2 | `emits` on an effect matched every effect of its kind | `PL1201` when two effects share the kind |
| D-F3 | a timer cancelled before it fired still counted as asking for its completion | a cancel withdraws its timer |
| D-F4 | an action that both an effect and a timer complete had one asker, the last declared | every asker counts |
| D-F5 | a message sent through a `let`, map or record was not seen as sent | any send of the action by a machine that can hold its address is a message |
| D-F6 | poly-ref read a filter constant named like a field as the field, and `T.C` was refused | a constant is read with no state; `T.C` is a constant |
| D-F7 | two findings ruled out left the stage FINDINGS with none listed | the stage's verdict over what is left |

**Ruled after the review (`decisions-m8.md`).** B-F6: `use m.M` admits `m.M` only, and PT's as-built text says so. D-F2: `k` is the effect's name (PT2.2), and PS5.2 now says so; the refusal of a name whose kind is shared stays, and is a limit.

### The M8a record

| Step | What | Commits |
|---|---|---|
| 1 | Work orders on `poly-runtime` under the gate (S173, amended: an order id per attempt) | ffcceba, f847f4e |
| 2 | The six workflow tools over the runtime (S175); `poly run --mcp`, `poly.json`'s `run` field and the approvals folder (S188, S189); the store lock | 1bace30, 304b88a, df2f79d, 03bd9cf, 4cdd00e |
| 3 | `use` within a project and `std/` (S176, PS1.0) | 85402e5, ef6f1ad, 2b86562 |
| 4 | `Content` (S180, PS1.4a, PS4.1f), the row order of PS3.2 as ruled, and m3-isolation's folder deletion | 45c1fa9, 239b9e3, 52179de, b8f02ff, 1916c0e, eee2a8c |
| 5 | `never emit … while` (S178, PS5.2, PS5.2a) | 6d815b1, f5df1f1, 6e0920f |
| Review | 22 findings, all fixed; B-F6 and PS5.2's wording after the owner's ruling | ac28361, d923503, and the commit of the rulings |

**The closing gate, from a clean build.** It ran at d923503 from 11:27 to 11:40 on 5 October 2026, after `npm run clean`, as `npm test` (build, boundary check, the suite, then `test/after/`). Before it started no simulation and no other test run was on the machine: the process list held language servers, MCP servers and idle sessions only. A watcher listed every minute, 14 times, each node or python process that was a test run or a simulation and did not descend from the gate: it found none, apart from the idle TypeScript language servers of an editor open on another folder, matched by that folder's name.

| Gate | Commit | Tests (suite and `test/after/`) | Passed | Failed | Skipped | Waiting | Total |
|---|---|---|---|---|---|---|---|
| **M8a closing, from a clean build** | d923503 | 1,584 | 1,579 | 0 | 1 | 4 | 13 min 24 s |

The skipped test is S152's OpenShell enforcement (no gateway configured). The four waiting are E1's, E2's and E5's (two), as in every earlier gate.

**Compared file by file with M6's closing gate.** The suite took 619 s against 727 s, `test/after/` 161 s against 209 s, and the summed time of every file 5,047 s over 130 files against 5,933 s over 119. Of the 119 files in both, 101 were faster, and none was slower by more than 20% and 5 s. The eleven new files are M8a's own; the slowest are `workflow-runtime` 60 s and `run-config` 49 s. The ten slowest files: `m3-runner` 384 s, `m4f-recheck` 332 s, `m3-freeze-eol` 325 s, `standing` 318 s, `outbox-intent` 313 s, `m3-tasks` 277 s, `m3-o1r` 185 s, `account-independence` 160 s, `m3-cleanup` 155 s, `check-memory` 154 s.

**The two M3 failures under load, counted to the close (`decisions-m8.md`).** Six full runs: the m3-environment crash (0xC0000409) twice, the dry run's `ENOTEMPTY` in the frozen runner once, both in runs during M8a's building and neither in the closing gate.

**Limits, stated.**
- `emits` cannot tell apart two effects of one kind (`PL1201`), since an intent, a witness and the journal carry the kind and not the name.
- A configuration rules out only a never finding with no constrained witness; one whose machine no configuration includes stays a finding, marked `environment: unconstrained`.
- The store must be on a local disk, and has one name: a store file with a hard link is refused.
- Taint, channels and any decision that reads a body are M8b's or later (S180, S181).

**M8b step 1 (plan step 6), the channel (PS15; `test/channels.test.mjs`).**

- **Semantics first.** PS15 was written into `04-semantics.md` with the five conditions of the ruling (c77875f) before any code. Two precisions were made while building and are recorded in `decisions-m8.md` for the owner's notice: `c` names the conversation's address in every handler of the application, and a `thread-not-started` refusal follows a journaled creation.
- **Built.** The parser, the formatter and the embedded surface read and print `channel c: k { adapter, thread, starts A.S [on inbound], P -> A.X … }` to the same digest. The compiler expands a channel in `poly-core` (`expandChannels`); poly-ref expands it on its own from PS15 (`packages/poly-ref/src/channels.ts`) and is given the source as written. The pipeline checks and lowers the expanded program, reports the conversation as `c.Conversation` and the configuration under the channel's name, writes `.poly/build/channels/<c>.json`, and admission certifies it. An interface machine (`Peer`: actions only) has no step to lower or explore, and the report says so. `rt.inbound` routes a message by its thread key, refuses `unknown-thread` and `thread-not-started` on `runtime:ingress`, and delivers to the conversation with the action id `<channel>:<messageId>`.
- **Tests first.** All nine tests of `test/channels.test.mjs` failed before the code: the expansion and its descriptor, `PL6813`, `PL6814`, `PL6815`, `PL6811`, `PL6812`, the key clash `PL1002`, `PL1001` for a `never` on `c.reply`, a declared configuration that gains the conversation, and three run-time cases. A tenth checks both surfaces. The run-time creation path waits on **E13**: polyrun 8.3.2 has no `createInstance`, so the kernel cannot spawn the conversation; that test is a todo naming E13, and the refusals run today.
- **Seeded faults, each caught by translation validation with `PL2501`:** `channel-drop-spawn` (the starts step's `createInstance` missing), `channel-swap-rename` (two renamed sends of the conversation swapped), `channel-inbound-to-app` (the descriptor routes inbound to the application). The test kind `std.channels.test` lives under `test/fixtures/std`, found only through the test-only std option.
- **The regression check.** The 147 measured files are identical in verdict, diagnostic codes and every state and transition count. A first run found a defect of this step, fixed before the record: poly-ref was given the program without the checked module itself, so a configuration across modules (`conformance/m8/use/dispatch.poly`) could not find a receiver. The full suite: 1,612 tests, 1,605 pass, 1 skipped, 5 waiting (E13's creation path among them), and 1 failure, `test/m3-environment.test.mjs` hitting `ENOTEMPTY` on the frozen runner's shared run-0 workspace (the dry run's failure under load, from another file); that file alone passes 5 of 5. The count of those failures closed with M8a; this one is noted for the owner.

**M8b step 2 (plan step 7), the five conversation machines (`std/channels`; `test/std-channels.test.mjs`).**

- **From the providers' documentation.** Each module was written from its provider's documentation, read on 2026-10-05, and its `PROVENANCE.md` gives every rule with its source and the words it rests on, every constant with where it comes from, poly's own rules apart, and what is not checked. `whatsapp`: the customer service window opens only on a customer's message (`window-opens-on-inbound`), resets on the next, lasts `24h`, and no free-form message goes out while it is closed (`free-form-outside-window`). `sms`: nothing is sent after an opt-out keyword (`no-send-after-opt-out`), consent changes only on a keyword (`consent-changes-only-by-keyword`), and the backlog never refuses an opt-out or opt-in keyword (`opt-keyword-never-refused`); the keyword lists are the adapter's. `email`: no bulk mail after a one-click unsubscribe (`no-bulk-after-unsubscribe`, RFC 8058 and Gmail's guidelines), the unsubscribe stands (`unsubscribe-holds`), and nothing is sent after two bounces (`no-send-to-suppressed`). `slack`: nothing is posted to an archived channel (`no-post-to-archived`), and a post waits for the one-second timer after the last (`one-message-per-second`). `webhook` (Standard Webhooks): nothing is delivered to a disabled endpoint (`no-delivery-while-disabled`), which is disabled only after three failed deliveries in a row (`disabled-only-after-failures`), each after the retry bound `attempts 10, base 5s, timeout 15s`.
- **One shape for all five.** A conversation is a `service` (a thread never ends), accepts a send its rules forbid and sends `Rejected(reason)` (Q1, S179), keeps one send in flight (`one-send-at-a-time`), and lets at most two messages wait for an answer, refusing a third `backlog`. `pending: 0..3` counts the waiting messages and the send in flight, an invariant (`obligations`) says so, and its bound is the transit bound of the generated configuration (PS15.5).
- **Tests first.** All 31 tests of the first version of `test/std-channels.test.mjs` failed before any module existed. The file now has 38: per kind, the module is `CLEAN` with every stage run and nothing vacuous or not run, in canonical form, and free of deadlock under PS5.6 when read without `service`; each of the seventeen rules' seeded mutants gives `PL3002` (`PL3003` for the reject property) naming the rule, with a witness; `PROVENANCE.md` has a source for every provider rule and lists every constant; an application bound through a channel checks `CLEAN` in its generated configuration; and the same application is admitted and loaded from `std/` with no test option, its descriptor recording the library's digest, its first message refused `creation-unavailable` until E13. The last records a limit: an application that answers every message is `INCONCLUSIVE` with `PL5301` (below, and in `decisions-m8.md` for a ruling). `test/embed.test.mjs` now reads `std/` too, and each module prints and reads back on both surfaces; the standing rule (`test/standing.test.mjs`) covers `std/`, whose modules show no toolchain fault.
- **Found by review, fixed before the record.** In the first `sms`, the backlog's `require` preceded the keyword: a STOP arriving while two messages waited was refused, consent stayed true, and a later send reached the number with no finding, since the never reads consent and consent was wrong. A keyword now changes consent before the backlog is consulted, and the reject property `opt-keyword-never-refused` states it; its mutant is the defect itself. The first full run also found the standing rule's source list missing `std/`.
- **The regression check.** The 147 measured files are identical in verdict, diagnostic codes and every state and transition count. No package source changed in this step. The full suite: 1,658 tests (1,657 and the one after the M3 runs), 1,651 pass, no failure, 1 skipped and 6 waiting (E1 and E13 among them). The first full run, before the review fix, had one failure, the standing rule without `std/`.

**Step 7 follow-up: receipts acknowledged (PS15.3 extended; option (b) as ruled).**

- **Semantics first.** PS15.0 names the receipts and the action `Ack()`; PS15.3 appends `send c <- Ack()` to each handler of the application bound to a receipt. Committed alone (72d4bda) before the code.
- **Tests first.** The INCONCLUSIVE test is replaced by one per kind: an application that answers every message is `CLEAN` in its generated configuration, with no `PL5301`. `test/channels.test.mjs` checks the three generated acknowledgements in the lowered application, that `Ack` cannot be bound, and that a kind with no `Ack()` is `PL6811`. The fault `channel-drop-ack` joined the explicit list. All failed before the code: 26 failures across the four files, the fault's among them.
- **Built.** `expandChannels` and poly-ref's `readChannels` each append the acknowledgement; poly-lower's `channel-drop-ack` drops it, and `channel-drop-spawn` now drops only the spawn. The five modules hold one slot (`Free`, `Sending`, `Receipt`) freed by `Ack`; `pending` counts the waiting messages and the held slot, and the invariant `obligations` says so. `Rejected` carries only the providers' reasons; Slack's timer refusal is `rate-limited`. The test kind `std.channels.test` gained `Ack` the same way.
- **The regression check.** The 147 measured files are identical in verdict, diagnostic codes and every state and transition count. The full suite: 1,664 tests (1,663 and the one after the M3 runs), 1,657 pass, no failure, 1 skipped and 6 waiting (E1 and E13 among them). `check-memory` passed in this run.

**Plan step 8, `poly-io`: ingress and the channel adapters (S182, S183; `test/channels-adapters.test.mjs`).**

- **Tests first.** The 23 adapter and ingress tests and the boundary test for S182 failed before the code (no package, and the boundary check allowed what S182 refuses).
- **Built.** `@poly/runtime/adapters` (types only) and `rt.ingressRecord`; `packages/poly-io` with the five adapters, SMTP submission, ingress, and the network transports and endpoint, the only network code in poly. The boundary check refuses a network module outside `poly-io`, anything but node builtins and the adapter types inside it, and `@poly/io` in any check package.
- **Recorded traffic.** `test/fixtures/traffic` holds the providers' documented payloads. Every signature is computed in the test under a secret generated there and never written to disk; every send goes to a recorded transport; no test opens a socket. Forged webhooks are refused for each provider: another secret, a changed body, a missing signature, a stale timestamp, another account or source. `packages/poly-io/PROVENANCE.md` names each rule's source, read on 2026-10-05.
- **On the runtime.** A forged WhatsApp webhook leaves one `verify` refusal on `runtime:ingress`; a real one is stored, its claims recorded, and routed by `rt.inbound`, refused `creation-unavailable` until E13.
- **Found by review, fixed with a test that failed first.** SMTP added a blank line before the end-of-data indicator when the message ended with CRLF; the webhook adapter posted to the send's recipient and never to its configured endpoint (it now delivers to the endpoint, for its own source only); the boundary check missed `node:http2`; and the ingress endpoint dropped the path of its public base, which the provider signs (Twilio). The adapter file now has 26 tests.
- **The regression check.** The 147 measured files are identical in verdict, diagnostic codes and every state and transition count. The full suite before the review fixes: 1,688 tests (1,687 and the one after the M3 runs), 1,681 pass, no failure, 1 skipped and 6 waiting; `check-memory` passed. After the review fixes: 1,692 tests, 1,685 pass, no failure, 1 skipped and 6 waiting; `check-memory` passed.

## Conclusion

M8 first closes the one gap M6 left open: a workflow's work orders will cross the gate and enter the ledger like every other effect, served by poly over the same tools polyflow serves today, with polyflow kept only as the oracle AC5 compares against. Channels then follow PT21 with three changes proposed:

- the application and its conversation are linked by a detached spawn, so E5 is not needed (S177);
- conversation rules become a `never` statement checked as a step property over emitted intents (S178);
- network code is confined to one new package that no check package may import (S182).

The fifteen issues, S173 to S187, are ruled, and E10 is on the engine list for the `channel` field.
