# Poly stack primitive inventory (read from source, September 2026)

All paths are relative to `$HOME/mnt/code/` on the user's device. Everything was read-only. Excerpts are trimmed. Some em-dash characters in source prose were turned into colons to match house style. Anything marked "inferred" is my reading, not a quote.

---

## 1. SAM v2 (sam-lib, sam-fsm)

**Purpose:** a TLA+-style step (Action, Model with Acceptors then Reactors, then Next-Action and/or Render), with an opt-in strict profile that makes a spec mechanically checkable. Sources: `sam/sam-lib/README.md`, `sam/sam-lib/docs/MIGRATION.md`, `sam/sam-lib/lib/sam-strict.js`, `sam/sam-fsm/README.md`.

**Core constructs (v1 and v2):**
- **action → intent.** Actions are wrapped as intents at setup. They can be labeled (`['LABEL', fn]`) and gated by `allowedActions` / `allow` / `clearAllowedActions`. Component options are `ignoreOutdatedProposals`, `debounce` and `retry: {delay, max}`.
- **proposal → acceptors → reactors → NAPs → render.** The API is `addAcceptors`, `addReactors`, `addNAPs` ("When a predicate returns `true`, rendering is suspended until the next action completes"), `setRender`, `addHandler`, `step`, `doNotRender`.
- **safety conditions** `{expression, name}`. They are checked after each step, and the model rolls back to the last snapshot when time travel is on.
- **time travel:** `addTimeTraveler`, `travel`, `hasNext`, `next`, `last`.
- **model checker:** `checker({instance, intents, reset, liveness, safety, options:{depthMax, noDuplicateAction, doNotStartWith, format}}, success, err)`.

**Strict profile (`createInstance({ strict: true })`), per MIGRATION.md:**
1. **Named intents with payload schemas.** Schema fields are `{ type, required, nullable }`. `type` is one of `string|number|boolean|object|array|function`, or an array of these for union types (v2.2).
2. **Sealed `modelShape`** (SAM's VARIABLES). Keys can be flagged `derived: true` or `internal: true`. Writing an undeclared key throws `SamShapeError`. The `getState()` / `setState()` round trip is total.
3. **First-class `reject(reason)`.** Each step is classified as `mutated | rejected | identity-by-mutation | unhandled` through `lastStep()`.
4. **Acceptors keyed per action** (the switch monolith cannot be written).
5. **Per-intent `domain`** (SAM's CONSTANTS). An array entry is spread as arguments. A function entry is a generator.
6. **`validate()`**, which throws `SamValidationError` in strict mode.

v2.1 adds prime semantics: `model` is the pre-state, writes go to `next`, and `unchanged(...)` gives the frame. A missing frame raises `SamFrameError`.

```js
acceptors: {
  ElectionTimeout: model => (proposal, { reject, next, unchanged }) => {
    if (model.role === 'leader') return reject('leaders do not time out')
    next.role = 'candidate'
    next.term = model.term + 1
    unchanged('votedFor', 'log')
  }
}
```

v2.2 rule: calling "reject() after next-state writes throws" `SamFrameError` (`rejectAfterWrite`). One acceptor rejecting after a different acceptor wrote is still legal as a "cross-cutting veto".

**Tooling surface:**

| accessor | returns |
|---|---|
| `manifest()` | `{ intents:{name:{schema,domain}}, acceptors:{keyed, broadcast}, modelShape }` (plus `acceptors.frames` in 2.1) |
| `namedIntents()` | the named intent functions |
| `getState()` / `setState()` | a snapshot over the declared shape |
| `lastStep()` | `{ intent, mutations, writes, rejections, classification }` plus the `primed`/`unchanged` sets |
| `validate()` | the list of undeclared obligations |
| `stepListener` | a per-step callback |

**sam-fsm:**
- `fsm({pc0, actions, states, deterministic, enforceAllowedActions, pc, componentName, blockUnexpectedActions, composite, transitions})`.
- `states.X = { transitions:[...], naps, guards:[{action, condition}] }`.
- v2 adds `modelShape` (`pc`, `pc_1` internal), `namedActions()` and `rejectUnexpectedActions: true`. With the last, an invalid transition is rejected as `unexpected action X for state: Y`.

**Limits:** the checker is exhaustive only over declared domains. The default mode only warns.

---

## 2. polygraph family: polygraph, polygen, polyrun, polyvers, polynv

**Purpose:** "Five engines around one artifact family." Polygraph audits, polygen authors, polyrun executes, polyvers evolves and polynv elicits (`polygraph/docs/ARCHITECTURE.md`).

### Design-time artefacts
These are listed in the ARCHITECTURE.md table "The artifact family".

- **`contract.json`** (`templates/contract.schema.json`):
  - Required keys: `stateKeys` and `actions`.
  - Optional keys: `lang`, `initState`, `terminalStates`, `specialRules`, `dataDomain` (ACTION → field → [values]) and `invariants` (a path).
  - "The FIRST key is treated as the primary control state."

  ```json
  { "stateKeys":[{"name":"state","type":"'LOCKED' | 'UNLOCKED'"},{"name":"coins","type":"number"}],
    "initState":{"state":"LOCKED","coins":0},
    "actions":{"COIN":{"dataFields":{}},"PUSH":{"dataFields":{}}},
    "terminalStates":[],
    "specialRules":[{"name":"push-while-locked-is-noop","whenState":"LOCKED","whenAction":"PUSH","note":"..."}] }
  ```

- **`next.cjs`**: a SAM v2 strict module. Its exports are `module.exports = { instance, init, actions, getState, setState }` (`examples/polyrun-oms/machines/order/next.cjs`, line 273). `init = () => setState(INITIAL_STATE)`. `componentActions` entries are `{action, schema, domain}`.

- **`invariants.mjs`**:
  - `stateInvariants:[{name, pred(state)}]`.
  - `transitionInvariants:[{name, pred(pre,action,data,post)}]`.
  - Since 8.0, `rejectionInvariants`: `pred(state, action, data, v)`, where `v` carries `{rejected, reason}` (README.md lines 737-747). They need `step()` verdicts from the SAM adapter (`scripts/check.mjs:219`).

  ```js
  export const rejectionInvariants = [{ name: 'push-locked-must-reject',
    pred: (state, action, data, v) => !(action === 'PUSH' && state.state === 'LOCKED')
      || (v && v.rejected && v.reason === 'push-while-locked-is-noop') }];
  ```

- **Traces `*.ndjson`**: one `{pre, action, data, post}` window per line. They call this "the universal currency". State equality is `stable()` in `scripts/load-spec.mjs`.

- **`effects.cjs`**: a pure function `effects(pre, action, data, post, stepKind) → EffectIntent[]`.
  - Built-in kinds: `timer {key, fireIn|fireInMs|fireAt, action, data}`, `cancelTimer {key}`, `spawnChild {machineId, childKey, initData, onComplete, onParentTerminal}`, `signalChild {childKey, action, data}`.
  - Everything else must be a manifest kind.

- **`effects.manifest.json`**: `{effects:{<kind>:{payloadSchema, onSuccess:{action}, onFailure:{action}, onExhausted:{action,data}, retry:{maxAttempts, baseMs, timeoutMs}}}}` (`examples/polyrun-oms/effects.manifest.json`).

- **`effect-invariants.mjs`**: `effectInvariants:[{name, pred(path)}]`, with `path.count(kind)` and `path.states` (`examples/polyrun-oms/effect-invariants.mjs`).

- **`invariants.compose.mjs`**: `{stateInvariants:[{name,pred(joint)}], transitionInvariants:[{name,pred(preJoint, stimulus, postJoint)}]}`. Here `stimulus = {target, action, data, cascade}` (`docs/composition-semantics.md` §5).

- **`migrate.cjs`**: pure `module.exports.migrate = function migrate(oldState)`. It is scaffolded with `HOLE()` throws for keys that need a human decision (`examples/polyvers-oms/order-v2/migrate.cjs`).

- **`compat-report.{json,md}`**: keys are `tool, milestone, changeId, oldVersion, newVersion, lanes, diffs, corpus, adequacy, intentProvenance, gates[{gate, ok, summary, failures}], deferred, verdict` (`examples/polyvers-oms/reports/2c284a8cc5c1/compat-report.json`).

- **`intent-ledger.json`**:
  - Top level: `format: "polynv-ledger/1"`, `records`, `grade`.
  - A record has `{id, source, target, question, evidence, status, assign, versions[...]}`.
  - The grade has `{total, dropped, equivalent, harnessKilled, distinct, killed, survivors}` (`examples/polynv-oms/order/intent-ledger.json`).
  - Dispositions are `confirm|reject|abandon|defer|modify` (`polynv/README.md`).

### Design-time checks and verdicts
- **Replay**: specs are scored against traces. Findings are triaged as spec-error, code-finding or contract-error. Positive and negative controls run first.
- **Model check**: BFS over declared domains. A determinism double-pass comes for free.
- **polygen pipeline**: six gated stages (contract, module, invariants, model-check, self-repair capped at `--repair-max`, corpus). Every stage boundary requires strict `validate()` to pass (`docs/polygen.md`).
- **polyvers lanes and gates** (`polyvers/README.md`):

| lane | gates |
|---|---|
| semantic | load · shape-roundtrip · invariants-pointwise · semantic-model-check |
| shape | load · migrate · shape-roundtrip |
| migration | load · migrate · shape-roundtrip |
| vocabulary | load · vocabulary · stimuli |
| intent | load · invariant-diff · invariants-pointwise · semantic-model-check |
| composition | NOT RUN rows pointing at `check-effects` / `matrix` / `product` |

  - Corpus tiers are `--snapshots` (fleet) and `--synthesize` (weakest). An empty corpus is refused.
  - Doctrine: "deprecate, don't delete". Renaming a reject reason is a break.
- **polynv**: harvest, questions, record, grade (mutation kill ratio), drift, report (CONVERGED / PARTIAL). The mutation families are the "classic relation four" plus the verdict family (`silence`, `reason-swap`) and the schema family (`schema-weaken`).
- **Doctrines** (ARCHITECTURE.md): no silent-clean paths; observable rejection; controls before trust; ground truth is executed code; defect → gate.

### Run-time primitives (polyrun; `docs/polyrun-spec.md`)
- **Vocabulary:** machine (`machineId` plus content-hash `machineVersion`), instance, action, step (`accepted | rejected | unhandled`), journal, effect intent, effect mapper, completion, timer, dedupe key (`actionId`).
- **Instance lifecycle:**
  - `create(machineId, instanceId?, initData?)`. Status is `active | terminal | poisoned`.
  - A terminal instance rejects with `rejected(terminal)`.
  - "Poisoning is the only state the kernel may enter that the model checker has not seen."
- **Dispatch:**
  - `dispatch(instanceId, action, data, actionId)` returns `{seq, stepKind, rejectReason?, state}`.
  - Snapshot, journal, outbox, timers and dedupe commit in one transaction.
  - "Rejection is a result, not an error."
- **Effects:**
  - `idempotencyKey = hash(instanceId, seq, intentName, ordinal)`.
  - "at-least-once execution, exactly-once emission".
  - Exhausted intents go to the DLQ (`dead`), and the manifest's `onExhausted` action is dispatched.
  - Completions use `actionId` `{idempotencyKey}:done`.
- **Timers:**
  - `actionId = timer:{key}:{seq-at-creation}`.
  - "Staleness is handled by the machine, not the scheduler."
- **Signals and queries:** a signal is simply `dispatch`. Queries are `getState`, `getStateAt(instanceId, seq)` and `list(machineId, filter, status)`.
- **Children:**
  - `childInstanceId = hash(parentId, childKey, seq)`.
  - A child reaching terminal dispatches the parent's completion action. A terminal parent dispatches `onParentTerminal` into each child.
- **Store** (§5.2 Postgres DDL; SQLite also supported): tables `pr_instance`, `pr_journal` (PK `(instance_id, seq)`, `UNIQUE(instance_id, action_id)`), `pr_outbox` (`intent_id` = idempotency key, status `pending|inflight|done|dead`, lease `claimed_until`) and `pr_timer`.
- **Deploy gate** (FR-6.2): strict validate, `setState` round trip over live snapshots, model check seeded with live snapshots, and migrate when the shape changed.
- **Library API:** `createRuntime({store, machines:[{machineId, module, contract, effects:{mapper, manifest}, migrate}], handlers})`, then `rt.create`, `rt.dispatch`, `rt.getState`, `rt.startWorkers({effectConcurrency, timerPollMs})`.

### Composition semantics (`docs/composition-semantics.md`)
- **Reduction:** cascades are atomic in one transaction, and per-instance dispatch has a single writer. So "Every execution of a parent and its children is observationally equal to a sequence of atomic cascade closures, one per top-level stimulus".
- **Joint state:** `{parent:{machineId,state,status}, children:{[childKey]:{machineId,state,status,onComplete,onParentTerminal}}}`.
- **Stimulus alphabet:** each machine's declared domain, minus completion actions owned by the cascade while the wiring child is active.
- **Cascade depth:** `MAX_CASCADE_DEPTH` is 8.
- **Built-in doctrine findings:** poison class, unhandled cascade delivery, unnamed rejects, `childkey-collision`.

### CLI and plugin surface
- **Scripts:** `scripts/verify.mjs`, `scripts/polygen.mjs`, `scripts/validate_corpus.mjs`, plus a `--tla` TLC tier.
- **polyrun:** `deploy | check-effects | check-product | simulate | audit | archive | export-traces | migrate | dlq-ls | dlq-retry | dlq-discard` (from `polyrun/bin/polyrun.mjs`).
- **polyvers:** `classify | check | migrate scaffold | matrix | product`.
- **polynv:** `harvest | questions | record | grade | drift | report`.
- **Claude Code plugin commands:** `/polygraph:verify`, `:polygen`, `:polyvers`, `:polynv`, `:workflow`. The skills include `capture-ready`.

**Limits (stated):** "a consistency check, not a proof". Domain representativeness is unmeasured. Grandchildren and joint mid-flight seeding are open.

---

## 3. polyflow (and its Temporal platform)

**Purpose:** "A workflow engine for AI agents". The agent runs an admitted state machine, one work order at a time, over MCP (`polyflow/README.md`).

**Design-time: the workflow directory (six files).**

```
polyflow.workflow.json   name, area, tools{effect kind -> agent tool}, key{template,fields}
contract.json            states, actions, finite data domain
machine.cjs              SAM v2 strict-profile module
effects.cjs              pure mapper: transition -> work orders
effects.manifest.json    completion actions + retry policy per kind
effect-invariants.mjs    what may be EMITTED, on every reachable path
```

Descriptor excerpt (`workflows/customer-brief/polyflow.workflow.json`):

```json
{ "name":"customer-brief","area":"openworker/cowork","inputAction":"START",
  "tools":{"post_brief":{"tool":"slack_send","target":"#cs","why":"publish the approved brief"}},
  "key":{"template":"{date}","fields":{"date":{"pattern":"^\\d{4}-\\d{2}-\\d{2}$"}}} }
```

**Admission check (the "emission checker").**
- "Startup enumerates every reachable emission path over the contract's declared domain". A workflow that fails is "not registered".
- It runs polyrun's `checkEffects` (`src/polyrun.mjs:51`).
- Effect invariants look like `{name, pred:(path)=>...}`, and `path` offers `emitted`, `actionBefore(action,i)`, `count(kind)` and `actions[]`.

**Run-time.**
- **Work orders:** an effect is "a work order handed back". The agent claims it, runs it under its own permissions and reports back.
- **Leases:** lease expiry re-offers the order with the same intent id.
- **Store:** SQLite.
- **Run identity:** derived as `agent | instance | workflow | key` (`src/library.mjs` `deriveKey`), so start and attach are one call.
- **Areas:** "agent area" (owns the library) and "instance area" (owns runs and journals).

**MCP tools:** `workflow_list`, `workflow_start`, `workflow_report`, `workflow_state`, `workflow_signal`, `workflow_journal`.

**Limits (stated in "Not built yet"):** promotion (mining workflows from journals), polyvers wiring, audit wiring, signed journals.

### polyflow/platform (Temporal)
Sources: `platform/README.md` and `docs/platform/guide/02-reference-manual.md`.

- **Levels:**
  - **G0 Observe:** a hash-chained, signed decision ledger.
  - **G1 Guard:** sequence rules, budgets, rate limits, the trifecta and approvals bound to one effect. A denial carries a witness.
  - **G2 Govern:** a certified SAM machine hosted in the workflow.
  - **G3 Certify:** `polyflow admit` issues a certificate, and `PolyflowGateWorkflow` vets a new version against the fleet.
- **Policy JSON:**
  - Shape: `{policy, version, effects:{<activityType>:{kind, class, labels}}, routes, unlabelled:"report|deny|escalate", rules:[...], escalation:{role, timeoutMs}}`.
  - `class` is one of `none | reversible | compensable | irreversible`.
  - `labels` is a subset of `reads-private | reads-untrusted | egress`.
  - Rule types: `requires-prior`, `implies-prior`, `at-most`, `never-after`, `trifecta`, `budget`, `rate`.
  - Rule outcomes: `deny | escalate`.
  - The witness is `{ rules:[{id,type,fix}], candidate, counters, sequence, allowedNow }`.
- **Ledger event:** `{ v:1, run:{ns,wf,run}, seq, kind, at, body, prev, hash }`.
  - Kinds: `admission | proposal | verdict | effect | observation | closure`.
  - Verdict outcomes: `allowed | denied | escalated | accepted | rejected`.
  - Signed heads look like `{run, seq, hash, keyId, alg, sig}`. Only digests are stored, never argument or result bodies.
- **Certificate:** `{ v, subject, artefacts, guarantees, checks, domains, boundAccepted, toolchain, issuedAt, buildId, signatures, digest }`.
- **`observations.json`:** Jev "noul" questions with `assertAt` / `refuteAt` bands and a calibration floor (n ≥ 60, precision ≥ 0.9).
- **CLI:** `polyflow verify | export | keygen | policy | admit | vet`. The verify verdicts are `closed-and-signed | open-and-signed | consistent-unsigned`. The vet decision per run is `auto-upgrade | migrate | pin`.
- **Gateway:** the six tools plus `workflow_claim`. Instance ids take the form `polyflow/<machine>/<key>`.
- **Packages:** kernel (Apache-2.0: RFC 8785 canonical JSON, ledger, rule kernel, SAM host), temporal, cli, gateway, service, verify, plus Python ports and a LangGraph binding.

---

## 4. polycrew

**Purpose:** "Several agents, and the people among them, working one run at the same time." It is polyflow used as a library, plus a shared broker (`polycrew/README.md`).

- **Tools:** the six polyflow tools plus **`workflow_next`** ("open orders you may take, across every run in the crew") and **`workflow_claim`**.
- **Claims are leases:**
  - `POLYCREW_LEASE_MS` defaults to 5 minutes, and re-claiming renews.
  - "Only the holder may report", otherwise the report is refused with `not-your-order`.
  - A refused claim returns `claimed:false` plus the holder: "an answer, not an error".
- **Reports are never lost:** if the broker died, the report is recorded rather than refused. `POLYCREW_EFFECT_LEASE_MS` governs this.
- **Broker:** elected over loopback, with orders in SQLite (`src/store-broker.mjs`) and attribution joined on read (`src/attribution.mjs`).
- **Workflow:** "five files", admitted by polyflow's gate, which is never forked.
- **Limits:** "There is no authentication." Child workflows are not built yet.
- **Draft:** `POLYAXION-INTEGRATION.md` (order = scope, one receipt chain per run, reconciliation). This is a draft, so I read headings only.

---

## 5. polyaxion

**Purpose:** "The constraint plane for AI agents." Obligations are kept outside the context window and enforced by a deterministic guarded merge (`polyaxion/README.md`, `spec/`).

### Design-time: the `polyaxion.policy.json` file (`spec/02-obligation-model.md`)
- **Document:** `{ "polyaxion":"2", id, version, scope, description, vars:{name:{type, domain, initial}}, obligations:[...] }`.
- **Obligation common fields:** `id, kind, text, severity (deny|warn|escalate), scope, hint, tags, source, examples:{deny:[...], allow:[...]}`.
- **Kinds:** `rule`, `machine`, `invariant`, `recalled`, `native`.
  - **rule:** `when` + `require` over `action`, `state`, `patch`, `history`, `run`.
    - Closed history predicates are lifted into counters and model-checked.
    - Open ones must declare `"coverage":"runtime-only"`.
  - **machine:** `states`, `initial`, `vars`, `transitions`, `guards`, `discharge`, `regions`.
    - Transitions are `{from, when, to, set, gate, phase}`. `phase` is `gate` or `settle`, and only settle transitions can read `observed.ok|effects|output`.
    - Guards are `{in, when, reason, region}`.
    - Vars can be `saturate: true`.
  - **invariant:** a predicate over declared `vars` after a patch.
  - **recalled:** "durable text, not gated". It is compiled into `unenforced[]`.
  - **native:** a hand-written polysec triple embedded verbatim.
- **Escalation:** `severity:"escalate"` applies to rules only. It is lifted by re-proposing with `approved:{by, ref}`, and `ref` must match a recorded escalation, otherwise `wrong-participant:polyaxion:approval-unmatched`.
- **PX:** a total, three-valued (Kleene) expression language: "an unknown value never satisfies a requirement".
- **Label catalogue fields on actions:** `action.effects` (closed vocabulary `read:repo read:private read:store write:store write:repo egress:public egress:external exec admin read:web write:workspace`), `action.reversibility`, `action.sensitive`, `action.untrusted`.

```json
{ "id":"tests-before-deploy","kind":"machine","text":"After changing source, run the tests before deploying.",
  "machine":{"states":["clean","dirty","tested"],"initial":"clean",
    "transitions":[{"from":"*","when":"action.kind == 'fs.write' && glob(action.path ?? '', 'src/**')","to":"dirty"},
                   {"from":"dirty","when":"action.kind == 'process.run' && action.target == 'test'","to":"tested"}],
    "guards":[{"in":["dirty"],"when":"action.kind == 'custom.deploy'","reason":"untested-changes"}],
    "end":["clean","tested"]}}
```

### Compilation and admission (`spec/03-compilation.md`)
- **Output:** a policy compiles to the polysec triple `next.cjs + contract.json + security.json` (plus `invariants.mjs`).
- **`security.json` fields:** `projection/protected/adversarial`, `forbiddenRegions[{name, kind: safety|ordering, predicate}]`, `gates[]` (emitted as `GATE__<machine>__<transition>`), `tools`, `capabilitySet`, `unenforced[]`, `polyaxion{authoringDigest, obligations[{id,kind,coverage}]}`.
- **Composite per scope:** keys are prefixed with the policy id.
- **Admission:** runs polysec `harden`. It must be `fullyMediated` for machines with regions or gates.
- **Mandate m2:** "lawfully dischargeable".
- **Coverage grade:** `checked | runtime-only`.
- **Policy replacement:** classified by polyvers lanes as `compatible | migration-needed | breaking`. `breaking` is refused while sessions are live.

### Run-time: the gate (`spec/04-gate.md`)
- **Σ:** the per-session state, kept in SQLite.
- **Two-phase mediation:**
  - Gate: a tool call becomes `PROPOSE×n`, and the first reject commits nothing.
  - Settle: after the tool runs, `SETTLE {observed}` is applied ("taint only ever grows").
  - `PATCH` and `END` are also gate calls.
- **Decision:** `{ok:true, actions, post, record?:'degraded'} | {ok:false, reason, region?, actions, post, class?:'unavailable'}`. The reason has the form `'<misfire>:<obligation>[:<detail>]'`.
- **Misfire classes:** `no-procedure`, `wrong-participant`, `bad-execution`, `wrong-state` (including `indeterminate` and `undischarged`).
- **Verdict words:** allow / deny / escalate.
- **Closed scopes:** a scope with no policy is closed (`no-procedure:polyaxion:no-policy-in-scope`) unless it is listed in `open_scopes`.
- **Consultation order:** native kernels first, then the composite.
- **Witness:** the obligation text, the failing expression, bindings, the matched sequence, the machine trail and a hint.

### Evidence (`spec/05-evidence.md`)
- **Window:** `{ session, ts, pre, action:[..], data:{tool,args}, post, decision:'allow'|'reject'|'settle', reason?, region?, note?, class?, spilled? }`. Settle notes are `recall`, `compaction`, `end-check`, `begin`.
- **Receipt:** `{ v:1, session, window, policy, verdict, provenAt, prev, seq, alg:'ed25519', key, sig }`. The END window carries `discharge:{<machine>:{state, discharged}}`.
- **The four checks:** signature, chain, binding, replay (plus windows). Currency is reported separately. There is no UPDATE or DELETE on `px_window`.

### Verbs, CLI and MCP
- **Verbs:** `declare`, `merge`, `recall`, `journal` (`read|sign|verify|replay|export`).
- **CLI:** `install --claude-code [--strict]`, `lint`, `serve|daemon`, `merge`, `recall`, `journal`, `compile`, `import`, `status`, `bench`.
- **MCP tools:** `polyaxion_merge`, `polyaxion_recall`, `polyaxion_journal`. `polyaxion_declare` is only available with `--admin`.
- **Mounts:** Claude Code hooks, `wrapMcp`, Agent SDK `handleHook`, Vercel `wrapVercel`, NAT.

**Terminology note:** "mandate" in polyaxion names the polysec mandate spec items m1-m4 (discharge), not an obligation kind. I found no "red lines" term in the polyaxion spec.

---

## 6. polycheck

**Purpose:** "A least-privilege linter for Claude Code agent policies." It is static, with an opt-in runtime guard (`polycheck/README.md`).

**Design-time artefacts.**
- **`data/regions.json`:** `{version, regions:[{name, kind: safety|ordering, requires:[flags], gloss}]}`. The regions are `lethal-trifecta` (untrusted ∧ sensitive ∧ egress), `credential-egress` (sensitive ∧ egress), `source-egress` (proprietary ∧ egress) and others.
- **`data/claude-code.labels.json`:** keys `effects, tools, mcp, bashPatterns, bashArbitraryExecution, defaultUngated, sensitivePaths, proprietaryPaths, proprietaryExemplars`. The effect universe is `{untrusted, sensitive, egress, proprietary}`. The labeler is "a NAMED TRUST OBLIGATION, not a proved thing".
- **Mandate file** (`--mandate`): `{id, gloss, root, outputs:[paths]}` or `{"mandates":[...]}`. Semantics: `effective = settings ∩ mandate`, `surplus = settings \ mandate`.

**Verdicts:**
- `PROOF` (exit 0).
- `WITNESS` / BYPASS (exit 1), with the call sequence and a fix.
- `INCONCLUSIVE` (exit 2): "A coverage gap is never painted green".
- `SHELL-EQUIVALENT`.

**CLI:** `polycheck [path] --tidy --write --verbose --json --md --mermaid --mandate --labels --regions --no-assume-defaults --emit-automode`.

**Run-time guard:** `polycheck guard init|status|off`, a PreToolUse hook. "The guard's decision space is `ask` / `deny` / passthrough. It never emits `allow`." Two bases: `capability` (default) and `observed`.

**Stated limits:** the auto-mode classifier is not counted as a gate; `ask` is weaker than proof; subagent taint is not propagated; the mandate is trusted input.

---

## 7. polyx and polyx-lens

**Purpose:** "Mine the rules an agent's own history supports, and serve them back with abstention" (`polyx/README.md`). polyx-lens reads logs against the rules an agent was given, with "No mining, no model call" (`polyx-lens/README.md`).

### Canonical record (`docs/polyx-technical-spec.md` §3)
- **Structure:** `Interaction{id, corpus, actor{agentId, teamId, operatorId}, events[], outcome}`.
- **Event:** `{seq, at, episode, kind, type, slots, result?:'ok'|'failed'|'refused', raw}`.
- **EventKind:** `customer_intent | customer_utterance | agent_utterance | action | system | unknown`. Unknown events are "counted, never dropped".

### Alphabet (`alphabets/alphabet.<corpus>.yaml`)
- **Top level:** `corpus`, `version`, `event_types[{id:'action:issue_refund', match, consequence: none|reversible|compensable|irreversible, slots}]`, `outcomes`, `redaction`.
- **Declared slot roles:** `identity: [slot]`, declared and never inferred. `state: [slot]` is only allowed on `system` events that also declare identity, and it bumps the version (`docs/polyx-eligibility-spec.md` EF1).
- **Target state:** `target.<k>` is the latest identity-bound report in the contact. Otherwise it is unknown.

### Rules (§7)
- **Rule object:** `Rule{id, family: obligation|recommendation, pattern, bindings, conditions, window: episode|interaction, support{holds,of}, counterexamples, provenance, status, corpusSupport, scope, predicates{js}, alphabetVersion}`.
- **Obligation patterns** (Declare lineage): `no-X-without-prior-Y`, `X-implies-prior-Y`, `at-most-one-X`, `exactly-one-Y-per-X`, `no-X-without-prior-Y-same-S`, `no-X-unless-state`.
- **Recommendation patterns:** antecedent → action, with agreement plus outcome-conditioned precision.
- **Provenance lattice:** `agent → team → operator → borrowed → neither`, evaluated broadest first. "Warrant" (mined-here vs asserted) is designed but "Not built".
- **Identity:** `id = hash(family, pattern, bindings, conditions, window)`.
- **Statuses:**
  - Human-set: `proposed | real | not_real | narrowed | retired`.
  - Recomputed each run: `refused | suppressed | contradicted`.
- **Adjudication:** one rule per screen (`polyx review`). `narrowed` means re-mined under the scope condition the reviewer names.

### Advisor (§8)
- **Three-valued logic:** "Closed-world assumption is prohibited."
- **Contract:** `POST /advise {operator, agent, episode, facts, considering, contact.events, consideringSlots}` returns `{verdict: recommend|warn|abstain, actions, warnings, abstention:{reason: uncovered|unknown_fact, missing}, coverage}`.
- **Eligibility:** the result can also be `cleared`. It serves only `real` rules.

### Observation predicates (Jev; `docs/polyx-jev-integration-spec.md`)
- **Declaration:** `alphabets/predicates.<corpus>.yaml`, with facts namespaced `obs.<name>`.
- **Bands:** `p ≥ assertAt` gives true, `p ≤ refuteAt` gives false, and anything in between emits nothing. `refuteAt < 0` means assert-only.
- **Quadrant:** a required field, one of `text-unknown` (Q2), `text-closed` (Q1), `sequence-closed` (Q3, a warning) or `sequence-unknown` (Q4, rejected at load) (`docs/polyx-jev-implementation-plan.md`).

### Interfaces
- **polyx CLI:** `audit`, `alphabet show`, `mine`, `review`, `evaluate`, `predicates`, `annotate`, `coverage`.
- **Claude Code integration:** a PreToolUse hook example.
- **polyx-lens:** `contracts/claude-code.yaml` has 28 clauses, of which 13 are checkable (`expressible:false` marks the rest).

---

## 8. polyness

**Purpose:** "Find the work you already repeat, and run it as a checked workflow" (`polyness/README.md`).

- **Four verbs:** `audit`, `replay`, `propose`, `suggest` (an MCP tool, `workflow_suggest`).
- **Episodes:** "a session is not a task" (`src/episodes.mjs`).
- **Corrections:** "what counts as a verification HERE" (`src/corrections.mjs`).
- **Rule patterns and provenance:** the four patterns (`src/rules.mjs`). Provenance is `own · borrowed · neither`.
- **Proposals** (`proposals/verified-push/`): the same six files as a polyflow workflow. "polygen authors the machine; polyflow's gate admits it or refuses it."
- **Stated principles:** "Silence is an answer." Every number is traceable via `--show`.
- **Enforcement:** through polyflow's `adapters/claude-code/gate.mjs` PreToolUse gate.

---

## 9. Polytrion (engine at `polysim/`; platform at `polysim-cloud/`)

**Purpose:** a "deterministic discrete-event simulation runtime for fleets of verified SAM v2 machines" (`polysim/docs/polysim-architecture.md`). `polysim/CLAUDE.md` gives the platform the name polytrion.

### Layers (§3)
- **L1 machines:** unchanged polyrun artefacts.
- **L2 kernel:** a virtual clock with ticks and a microstep. The calendar is ordered by `(time, microstep, priority, sourceKey, sourceSeq)`. Timers are calendar entries. Effects complete through responders.
- **L3 world:** `topology.json`, `world.cjs` / `responders.mjs` (`(intent, ctx) → [{action, data, delay}]`), and `drivers.mjs` (`(streams, scenario, horizon) → timed dispatches`).
- **L4:** probes (pure folds over the journal), invariant monitors (a violation is "a finding, never a statistic") and faithfulness checks.
- **L5:** replications, CRN by default, CIs, warm-up and a sim-report (`.json` and `.md`) with the schema id `polysim.sim-report/1`.

### `topology.json` (`polysim/worlds/reed-frost/topology.json`)
- Keys: `tickMs`, `zeno{policy, measure, justification}`, `epoch`, `machinesDir`, `nodes{<id>:{machine, init, tags}}`, and routes.
- Worlds hold `topology.json`, `responders.mjs`, `drivers.mjs`, `probes.mjs`, `conservation.mjs`, `experiment.mjs` and tests (`polysim/worlds/reed-frost/`, `polysim/worlds/pyramid/`).

### Identity, twin and refusals
- **Run identity** (`polysim/src/replication.mjs:136`): `wv:<worldVersion>/sc:<scenarioHash>/s:<seed>/r:<runIndex>`.
- **`twin.json`** (`polysim/src/twin.mjs`, FR-8):
  - snapshot import from `polyrun archive`;
  - faithfulness;
  - KS distribution validation;
  - calibration to `calibration.json` with a `STALE-CALIBRATION` banner.
  - The mode "never actuates".
  - I found no `twin.json` instance in the worlds I checked.
- **Experiment refusal codes** (`polysim/src/experiment.mjs`): `EMPTY_ENSEMBLE, ZERO_INVARIANTS, ZERO_REPLICATIONS_POST_DELETION, UNSCORABLE_METRIC, MISSING_WARMUP_DECLARATION, UNKNOWN_WARMUP_POLICY, WORLD_VERSION_DIVERGED, CRN_AUDIT_FAILED, UNDERPOWERED, MONITOR_FINDING`.
- **Kernel refusal codes** (`polysim/src/kernel.mjs`, `KernelError`): `UNDECLARED_STREAM, UNWIRED_OUTCOME, UNCOVERED_KIND, DRIVER_NOT_MONOTONE, DUPLICATE_SPAWN, MISSING_MACHINE, UNKNOWN_NODE, UNRESOLVED_ROUTE_TARGET, BAD_DELAY, BAD_TICK_MS, NO_SETSTATE`, among others.

### CLI (FR-10, `polysim/bin/polysim.mjs`)
`validate | run | replay | experiment | select | faithfulness | calibrate | export-traces | export-witness | report`.

### Principles (`polysim-cloud/docs/polysim-modeling-principles.md`)
- **P-1.1:** "Responders draw, machines decide, the kernel schedules."
- **P-1.2:** "Machines own structure, scenarios own rates, drivers own draws."
- **P-1.3:** Parameters that arms vary ride on actions, never in node init.

### Polytrion platform (`polysim-cloud/`)
- **World kinds:** process, calculation, mechanism.
- **Mechanism catalogue**, schema id `polysim-catalog/1` (`polysim-cloud/docs/polytrion-certified-catalogue-spec.md` §3.1):
  - Fields: `states, channels(ctmc|transfer), parameters, definitions, rate` (a nine-operator language), `protocols, sampling, oracles, coupling, disclosures, hashing, contentHash`.
  - The certificate records 12 properties.
  - The conformance kit has tiers L0 to L4.
- **MCP:** 19 tools. "A refusal comes back as a finished result, not an error."
- **Engine boundary:** the engine is consumed only as a pinned tarball.

---

## 10. polygents

**Purpose:** "Agents that give a verdict with evidence. A polygent holds a declared mandate, lets any model interpret an artifact onto it, and lets the Poly engines judge" (`polygents/README.md`, `polygents/docs/README.md`).

**Module contract** (`polygents/src/polygent.mjs`):
- **Declaration:** `POLYGENT { name, artifactKind, kinds, checks:{local, hosted}, artifactSchema }`.
- **Six functions:**
  - `identity(artifact)`
  - `acquire(args, {root, mandate})`
  - `mandateOf(dir, doc)`
  - `plan({...})`
  - `executors({...})`, returning `{ interpret({kind}), check({index, where, check, run}) }`
  - `describe(finding)`
- **Runner:** `runPolygent` runs the module through the certified `workflows/polygent-run` machine (a polyflow six-file workflow) and seals the result.

**Mandate** (`.polygent/<name>/polygent.json`):

```json
{ "schema":"polygent.mandate/1","name":"formulator",
  "checks":{"local":["C1","C2","C3","C5"],"hosted":[]},
  "shell":{"adapter":"ollama","model":"env:POLYGENT_MODEL","n":3,"retries":2},
  "contract":{"precisionFloor":0.75,"minLabels":30,"window":"P90D","mode":"advisory","graceDays":7} }
```

**Ledger:**
- `.polygent/ledger/chain.ndjson` rows are `{at, body, hash, kind, mandateHash, prevHash, runId, seq}`.
- `seal.json` is `{schema:"polygent.seal/1", head, rows, sealedAt, by}`.
- Run id format: `pg:<name>/m:<mandate>/a:<artifact>/i:/e:`.

**Verdicts and exit codes** (`polygents/src/codes.mjs`): `CLEAN | FINDINGS | REFUSED | UNDERPOWERED | INCONCLUSIVE`, with exits 0, 1, 2, 2, 2. `NONDETERMINISM` is 3, ERROR is 4 and USAGE is 64.

**Checks by polygent:**
- **Formulator:** C1 to C5 (C6 is hosted).
- **Reviewer:**
  - R1 `SPEC_DIVERGENCE`
  - R2 `INVARIANT_REACHABLE`
  - R3 mandate drift
- **Guard:**
  - G1 `POLICY_BYPASS` / `SHELL_GRANT`
  - G2 `MANDATE_SURPLUS`

**Gate** (`polygents/docs/gate-spec.md`):
- **Decisions:** `permit (pass|block) | escalate | hold | refuse`, with exits `0 | 1 | 10 | 11 | 12`.
- **Decision table:** 15 rows, including refuse codes `LEDGER_QUARANTINED, NO_SEALED_RUN, ARTIFACT_CHANGED, NONDETERMINISM, RULE_DECAYED, VERDICT_UNREADABLE`.
- **Standing:** comes from `contractStatus`, with modes advisory and required.
- **Findings:** a finding is "standing" unless a person has rejected it. Dispositions are `accepted | undispositioned | deferred | rejected`.
- "An agent cannot move a decision toward pass."

**CLI:** `polygent check | formulate-check | review | gate | disposition | ledger | replay | certify | contract | interview | describe`.

**MCP:** `polygent_<name>` tools (for example `polygent_reviewer`).

---

## Cross-component table

| primitive | component | phase | artefact / format |
|---|---|---|---|
| named intent + schema + domain | SAM v2 | design | `actions:{Name:{action,schema,domain}}` |
| sealed model shape | SAM v2 | design | `modelShape` |
| acceptor with `reject`/`next`/`unchanged` | SAM v2 | run | keyed `acceptors` |
| step classification | SAM v2 | run | `lastStep()` |
| NAP / allowedActions / fsm guards | SAM v2, sam-fsm | run | `addNAPs`, `states.X.guards` |
| contract | polygraph | design | `contract.json` |
| machine module | polygraph | design | `next.cjs` / `machine.cjs` |
| state/transition/rejection invariants | polygraph | design | `invariants.mjs` |
| trace window | polygraph, polyrun, polyflow, Polytrion | both | `{pre,action,data,post}` ndjson |
| effect mapper + manifest | polyrun, polyflow | design | `effects.cjs`, `effects.manifest.json` |
| emission invariants / admission | polyrun, polyflow, polycrew | design | `effect-invariants.mjs`, `check-effects` |
| cross-machine invariants | polyrun | design | `invariants.compose.mjs`, `check-product` |
| migration | polyvers | design | `migrate.cjs` |
| compat verdict | polyvers | design | `compat-report.json` |
| intent ledger + adequacy grade | polynv | design | `intent-ledger.json` (`polynv-ledger/1`) |
| one-txn dispatch, dedupe, outbox, timers, DLQ | polyrun | run | `pr_instance/pr_journal/pr_outbox/pr_timer` |
| idempotency key | polyrun | run | `hash(instanceId,seq,intentName,ordinal)` |
| child spawn/signal/completion | polyrun | run | `spawnChild`, `signalChild` intents |
| work order + lease | polyflow, polycrew | run | `workflow_report`, `workflow_claim` |
| derived run key | polyflow | run | `polyflow.workflow.json.key` |
| workflow descriptor | polyflow | design | `polyflow.workflow.json` |
| G1 policy + rule kinds | polyflow platform | both | policy JSON |
| hash-chained signed ledger | polyflow platform | run | ledger event `{v,run,seq,kind,body,prev,hash}` |
| machine certificate | polyflow platform | design | certificate JSON |
| obligation policy | polyaxion | design | `polyaxion.policy.json` |
| PX three-valued expressions | polyaxion | both | inline strings |
| policy triple | polyaxion/polysec | design | `next.cjs`, `contract.json`, `security.json` |
| guarded merge (PROPOSE/SETTLE/PATCH/END) | polyaxion | run | Decision object |
| witness | polyaxion, polycheck, polyflow | run | witness object |
| receipt (ed25519) | polyaxion | run | receipt JSON, `px_window` |
| recall | polyaxion | run | `polyaxion_recall` |
| forbidden regions | polycheck, polyaxion | design | `regions.json`, `security.json.forbiddenRegions` |
| effect labels | polycheck, polyaxion | design | `claude-code.labels.json`, label catalogue |
| task mandate (outputs) | polycheck | design | mandate JSON |
| PROOF/WITNESS/INCONCLUSIVE | polycheck | design | exit 0/1/2 |
| runtime guard (ask/deny only) | polycheck | run | PreToolUse hook |
| canonical record + alphabet | polyx-lens | design | `alphabet.<corpus>.yaml` |
| mined rule + lifecycle | polyx | design | Rule object |
| advisor (recommend/warn/abstain) | polyx | run | `POST /advise` |
| observation predicate bands + quadrant | polyx | design | `predicates.<corpus>.yaml` |
| episodes, proposals | polyness | design | `proposals/<name>/` six files |
| world topology/responders/drivers | Polytrion | design | `topology.json`, `responders.mjs`, `drivers.mjs` |
| run identity | Polytrion | run | `wv:/sc:/s:/r:` |
| refusal codes | Polytrion | run | `REFUSAL`, `KernelError` codes |
| twin contract | Polytrion | run | `twin.json`, `calibration.json` |
| mechanism catalogue | Polytrion platform | design | catalogue JSON (schema id `polysim-catalog/1`) |
| polygent module contract | polygents | design | `POLYGENT` + 6 functions |
| polygent mandate | polygents | design | `polygent.mandate/1` |
| sealed verdict ledger | polygents | run | `chain.ndjson`, `polygent.seal/1` |
| force gate | polygents | run | permit/escalate/hold/refuse, exits 0/1/10/11/12 |

**Things I did not find or did not read in full:**
- No "red lines" term in polyaxion.
- No `twin.json` instance in the worlds I checked.
- polysec's `harden` / `fullyMediated` internals (under `polyaxion/packages/polysec`) and polycrew's `POLYAXION-INTEGRATION.md` body were read by headings only.
