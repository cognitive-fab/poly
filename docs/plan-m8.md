# poly · Plan for milestone M8, channels

*Cognitive Fab · October 2026 · plan, written before any M8 code · on branch `m4` in the worktree `poly-m4` · from PT27.3's M8 row and PT21 of `proposals/v1-technical-spec.md` (v0.2), PF11 and AC14 to AC17 of `proposals/v1-functional-spec.md`, after M6's close (`decisions-m6.md`)*

This plan covers milestone M8 of the v1 proposal. Its first item is moving workflows onto `poly-runtime`, so that every work order crosses the gate (S164). Then come the channel surface and its standard library:

- `Content`;
- the `channel` grammar on both surfaces;
- the five conversation machines and the configurations generated around them;
- ingress, and channel adapters for email, WhatsApp, SMS, Slack and webhook, tested against recorded provider traffic;
- the proposal fields `channel` and `taint` (class only).

The gate is AC14 to AC17. Every conversation machine must be clean, free of deadlock, and prove its `never` statements. AC5's workflow must run on `poly-runtime`, with each work order gated and journaled, and its certificate must no longer list it as `ungated`.

The plan sets out:

- what was found before planning;
- the engine changes, for the owner's list;
- how workflows move under the gate;
- the packages touched and the order of work;
- how each gate item is tested;
- the spec issues found, numbered from S173.

Nothing is built until the owner rules on the plan.

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
| **E10** | polyaxion | Accept the proposal fields of PT25.1 (here `channel`, and `taint` with its class), and per-value taint beside session taint. | PT21.5; AC17 with a policy over `effect.channel` | **Needed in M8.** If polyaxion cannot take it, PT27.2's fallback applies: `poly-runtime` computes the check before the proposal and passes the result as a field, and the certificate lists the check as poly's, not the gate's. |
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
| `poly-runtime` | Work orders (S173); `Content` bodies in the ledger's store; the proposal fields `channel` and `taint`; dispatching inbound messages idempotently by provider message id (PF8.2); binding runtime adapters by name and digest (PT26). |
| `poly-agent` | The workflow tools served over the runtime (S174); the language server and MCP pick up the new constructs through the registry. |
| `poly-io` (new, S182) | Ingress (the webhook endpoint), the runtime adapter interface of PT20.2 for channels, and the five channel adapters. It is the only package allowed a network module. No check package may import it. |
| `std/` (new) | `std.channels.email`, `whatsapp`, `sms`, `slack` and `webhook`, each with a `PROVENANCE.md` naming the provider documentation and the date of each rule (PT20.4). |
| `adapters/claude-code` | `install.json` launches `poly run --mcp` in place of the vendored polyflow server. |
| `scripts/check-boundaries.mjs` | The network rule names the check packages and `poly-io` (S182); the adapter allowlist replaces the polyflow server with `poly run --mcp`. |
| `test/` | One file per gate item (section 6). The fault lists gain the channel descriptor's broken variants. |

## 5. Order of work

Each step ends with a commit. Every defect gets a regression test that fails first. A confirmation test, one that cannot fail first, gets a seeded control that must fail. The split into M8a and M8b is proposed in S187. Without that split, the steps are one milestone.

0. **Rulings.** The owner rules on this plan, S173 to S187, and E10. Nothing is built before.
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
9. **The proposal fields `channel` and `taint`, by class (S181, S185).** Through E10, or through the fallback if it is not vendored.
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
- **S174. Who serves the workflow tools.**
  - *Proposal:* `poly run --mcp` is a new registry command. It loads the project's runtime from `poly.json`: its store, its gate policy and its ledger key. It serves the six workflow tools over stdio, with polyflow's names and schemas, framed by `poly-agent`'s MCP server.
  - One process owns a store at a time, and a second refuses with a clear error.
  - `poly mcp` (the checker's tools) is unchanged.
- **S175. What is left of polyflow.**
  - *Proposal:*
    - `polyflow.workflow.json` stays as the artefact `poly-runtime` reads, with its read-back unchanged.
    - The `workflow` stage stops running polyflow's `certify`, and the certificate drops `ungated: polyflow runtime`.
    - The Claude Code entry launches `poly run --mcp`, and the boundary allowlist changes with it.
    - The vendored polyflow server stays only as AC5's oracle in tests.
    - E9 is withdrawn.
    - `PL6804` stays: the gate checks each order, but only a path property checks their order, so a workflow without one still checks nothing about its sequence.
  - *Alternative:* drop `PL6804` now that polyflow's rule no longer binds.
- **S176. `use`.**
  - *Proposal:* lower `use` in general. Every module a project uses, `std.*` included, is checked together with it. Machine ids are qualified (S28), and a configuration may instantiate a used module's machines.
  - *Alternative:* lower `use std.*` only, and keep `use` between user modules at `PL0901`. That saves little, since the generated configurations need cross-module machines either way.
- **S177. Linking an application instance and its conversation.**
  - *Proposal:*
    - The compiler adds `spawn detached std.channels.<kind>.Conversation as channel:<name> -> Open(app: self)` to the channel's `starts` handler.
    - `self` becomes legal as a whole argument of a detached spawn's creation action, as it is of a `send` (S58 extended).
    - Ingress dispatches `Inbound` to `<app>/channel:<name>`.
  - This replaces PT21.2's "the runtime creates both and gives each the other's `Ref`", which needs E5, with the detached spawn built in M2. The checked configuration is the same pair.
- **S178. Conversation rules as checked properties.**
  - *Proposal:* a machine may declare `never emit k(f: v, …) while P`. It lowers to a step property that reads the step's emitted intents: "no accepted step from a state satisfying `P` emits `k` with those fields". PS5.2 is extended so that a step property may read `emits(k, …)` on its label.
  - poly-ref evaluates it from the semantics. It is checked in every configuration that includes the machine.
- **S179. Reply on rejection (Q1).**
  - *Proposal:* rejection stays message-free (PT6.1). A conversation machine accepts the forbidden send, records the refusal in a counter so that `PL2201` does not fire, and sends `Rejected(reason)` to the application. No new construct, as PT21.3 already states for the final machine.
- **S180. `Content`.**
  - *Proposal:* an opaque type with representatives, as `Principal` (PD5.1.3), and `PL1209` for any other use.
  - Bodies live in the ledger's store by SHA-256 and are written at ingress. A machine holds digests only.
  - PS gains a section on `Content`, written before poly-ref's code, which follows it.
- **S181. The taint class before M10.**
  - *Proposal:* bring the `audience` declaration forward from M10 as a declaration only: a total order of classes (Q3 stays open for M10). A channel declares the class of what it receives.
  - In M8, ingress tags each inbound body with that class, and the proposal's `taint.class` is the class of the bodies an effect carries. Propagation through decisions and retrieval, the ghost component, comes in M10.
  - *Alternative:* leave `taint` out of M8 entirely and add it in M10.
- **S182. Runtime adapters, and where network code lives.**
  - *Proposal:* a new package `poly-io` holds ingress and the channel adapters. It is the only package where network modules are allowed. No check package (`poly-core`, `poly-lang`, `poly-lower`, `poly-ref`, `poly-embed`, `poly-check`, `poly-agent`) may import it.
  - PT20.2's adapters are called runtime adapters, so that they are never confused with S167's host adapters. Each is bound in the certificate by package name, version and digest (PT20.2, PT26).
- **S183. Reference providers (Q5), and recorded traffic.**
  - *Proposal:* the reference adapters are WhatsApp Cloud API, Twilio SMS, the Slack Events API with `chat.postMessage`, email by an inbound-mail webhook with SMTP submission, and a generic webhook signed with HMAC.
  - Recorded traffic is built from each provider's documented payloads, with signatures computed under test secrets in the test. No live account enters the repository or the gate.
  - *Alternative:* the owner names different providers.
- **S184. Keyed send counters.**
  - *Proposal:* M8 has per-period counters as policy `var`s, which exist. Counters keyed by recipient (PT21.6) move to M9, where E11 is needed for grants anyway. AC14 to AC17 do not need them.
- **S185. Policies over the new proposal fields.**
  - *Proposal:* the policy front end types `effect.channel.{name, kind, recipient, recipientClass, messageKind}` and `effect.taint.class`. A policy that reads a field the proposal does not carry gets unknown (PS8.2).
  - With E10 the gate reads these fields. Without E10, the fallback of PT27.2 applies, and the certificate says so.
- **S186. The embedded form of a channel.**
  - *Proposal:* `channel(name, { kind, adapter, thread, inbound, starts, delivered, rejected, failed })`, with the same checks. The language server serves it on both surfaces (S168).
- **S187. Split M8.**
  - *Proposal:* split M8 the way M5 was split:
    - **M8a, the gate's reach:** workflows under the gate (steps 1 and 2), `use`, `Content` and `never` (steps 3 to 5);
    - **M8b, channels:** steps 6 to 10.
  - Each closes with its own review and its own clean gate. M8a's gate is AC5 under the gate and the three language items. M8b's gate is AC14 to AC17 and the conversation machines.
  - *Alternative:* one milestone and one gate at the end.

## 8. Risks

- **M8 is large.** It adds a second runtime path, imports between modules, a new type, a new property form, a new package and five provider integrations. S187 splits it so that the gate's reach is closed before channels depend on it.
- **Provider documentation moves.** A conversation machine encodes the rules as they were read on one date. A rule the provider later changes is a new module version (PF8.7). Since migrations are not lowered yet (PL0901), M8 ships first versions only, and the limit says so.
- **E10 timing.** If polyaxion does not take E10 during M8, the fallback holds, and the certificate names the check as poly's. AC17 does not depend on which one holds.
- **One store, one process.** `poly run --mcp` serialises access to the store. Two agents on one project share one server, not one store across two servers (S174).
- **Recorded traffic is not live traffic.** Adapter tests prove that the adapter handles what the provider documents. K11 states the rest. The live demonstration is reported, not gated.

## 9. Record of M8, as it is built

Empty until the owner rules on this plan.

## Conclusion

M8 first closes the one gap M6 left open: a workflow's work orders will cross the gate and enter the ledger like every other effect, served by poly over the same tools polyflow serves today, with polyflow kept only as the oracle AC5 compares against. Channels then follow PT21 with three changes proposed:

- the application and its conversation are linked by a detached spawn, so E5 is not needed (S177);
- conversation rules become a `never` statement checked as a step property over emitted intents (S178);
- network code is confined to one new package that no check package may import (S182).

Fifteen issues need rulings, S173 to S187, and E10 goes on the engine list. Nothing is built before the rulings.
