# poly · Plan for milestone M3, the first experiment

*Cognitive Fab · September 2026 · plan, written before any M3 code*

This plan prepares milestone M3 of PT18: the experiment of PT13, as amended by `decisions-m3.md` (M3-1 to M3-5). It covers the prerequisites, the task set, the prompt for the independent O1 session, the controls, the runner, the analysis script and the freeze. **No arm runs in this preparation**, and nothing is spent on real agent runs until the frozen set and the budget are approved. The spec issues found while reading continue at S87.

## 1. What was read

`CLAUDE.md`; `decisions-m3.md`; PT13 in full and PT18's M3 row; the closing sections of `plan-m2.md` and `decisions-m2.md` (S86 and the refused exports, both applied in d255ec2 and 77b4060); the three field studies in `conformance/field-studies/` (turnstile, raft, hatchet) with their poly versions in `examples/field-studies/`, and the OMS order (`conformance/field-studies/order`, `examples/oms`). polyrun was read where M3-2 touches it: `kernel.mjs` (`_dispatchInTxn`, the intent loop, the cascade) and `workers.mjs` (`tickEffects`, `mapCompletion`).

Two facts about the polygraph checkout shape step 1. It holds the owner's uncommitted work in fifteen files, `package.json` among them, and `vendor/polygraph` is pinned to commit `583b82c`. The change of M3-2 is therefore made in a separate git worktree of polygraph, on a branch `m3-sendto` cut from `583b82c`, so no uncommitted file is read, staged or overwritten, and the patch-version bump is made on that branch's own `package.json` (S87).

## 2. Order of work

1. **The polyrun change (M3-2)**, in the polygraph worktree:
   - `sendTo { target, action, data }` as a kernel intent. The committing step writes one message row per send, in the same transaction as the step, with the idempotency key `(sender, seq, position)` of PS13.2. A message worker delivers each row by dispatching `action` with `data` to `target`, with that key as the action id, so a redelivered message is deduplicated (PS14). A send to `null` writes nothing. Delivery order is unspecified (PS13.4), and the worker can be driven one message at a time for tests (S89).
   - `{ "$ref": "self" }` in a send's data resolved to the sender's instance id at commit (S58); `{ "$ref": "child", "key": k }` resolved to `<sender>/<k>` at commit, in the post-state and in every outgoing intent (S78).
   - K9: an outside dispatch of an action wired as the completion of a live child is refused before any step, with no journal row, an error naming K9, and an entry in polyrun's audit log (S45, S80, S88).
   - polygraph tests for each, in its own suite; a commit as `kizo-core`; the patch version bumped to 8.3.2 on the branch; nothing published or pushed, and the merge into polygraph's main left to the owner (S87).
   - Re-vendor into `vendor/polygraph` from the branch's commit, with the branch and commit in `PROVENANCE.md`, its table and `test/vendor.test.mjs` updated in the same commit.
   - In poly: the pipeline stops listing "polyrun has no sendTo intent yet" (S58), stage 3 of a sending machine runs polyrun's `check-effects` again, and every multi-machine conformance case (`conformance/m1/sends.poly`, the checkout, `examples/delivery`) runs under polyrun: each configuration's reachable global states are replayed as polyrun runs, driven one message at a time, and must agree with poly-ref's. `createInstance` is not built: no task uses detached children (section 3).
2. **Embedded fixes (M3-3).** `attachFixes` runs for `.ts` modules. Each of the six fixes of S70 is computed on the AST as now, and applied to an embedded module by reprinting the edited node with the embedded printer and splicing it into the file at the node's source span, so the author's formatting and comments outside the node are kept. The preconditions are the same node digests. The random-order test of S70 runs over both surfaces: the fixable source, and its embedded print.
3. **The host adapter (M3-4).** A generator in `experiments/m3/adapter/` reads a `host.map.json`, validates it against the poly module it names (a machine, action, parameter or field that does not exist is a failed build, S90), and emits a TypeScript module that implements the host interface over polyrun's kernel: a method is a dispatch of one action to one instance, a query reads the instance's state through the flat layout, and the network methods of a multi-machine task (S91) drive the message worker. It is tested on the reference machine of each task.
4. **The task set** (section 3): briefs, host interfaces with their mappings, reference machines, O2, O3, the three evolution changes, and a mutant per version.
5. **The O1 prompt** (section 4), and a script that checks what the O1 session returns.
6. **The controls** (section 5), run on every task and every version.
7. **The runner** (section 6), with its dry run on one task.
8. **The analysis script** (section 7), with its synthetic tests.
9. **The freeze** (section 8): digests, budget and cost, recorded here. Then stop.

## 3. The task set

Ten tasks, from PT13's three families. Five involve two or more machines that talk, so the configuration check runs on half the set; none uses detached children, so `createInstance` stays unbuilt (M3-2). The table is as built; section 10 records where it moved from the first draft and why.

| Id | Family | Task | Machines | Modelled on |
|---|---|---|---|---|
| T1 | order and payment | Order lifecycle: draft, items, place, pay, ship, cancel, with the charges and refunds it requests (S95) | 1 | the OMS order |
| T2 | order and payment | Order and inventory: an order reserves stock, the inventory confirms or refuses | 2 | PT7a's checkout |
| T3 | order and payment | Payment with authorisation, capture, refund, and a retry when the provider times out (S95) | 1 | the OMS order's charge |
| T4 | order and payment | Checkout across cart, payment and inventory, each a machine | 3 | PT7a, extended |
| T5 | workflow status | Run status derived from three task slots, with eviction | 1 | hatchet |
| T6 | workflow status | A run with retries and cancellation of its tasks | 1 | hatchet |
| T7 | workflow status | A run and two workers that report task status by message | 3 | hatchet, distributed |
| T8 | leader election | Raft roles and terms for one node | 1 | raft |
| T9 | leader election | An election round among three nodes by vote requests and replies (S98) | 3 | raft |
| T10 | leader election | A lease held by one of two clients, with fencing tokens, expired and revoked | 3 | raft, leases |

Each task follows the template in `experiments/m3/tasks/_template/` (S90 to S92). It has, under `experiments/m3/tasks/<id>/`:

- `brief.md`: the feature in prose, with no reference to poly, states or any design choice beyond the observable behaviour;
- `host.ts`: the host interface, a small TypeScript API, with the network API of S91 when the task is multi-machine;
- `reference/`: the reference machine in poly, checked clean by `poly check`, with its own `host.map.json`, which no arm sees (S90);
- `o2.mjs`: the hidden invariants, as predicates over the host interface's observable state;
- `explore.json` and `o3/`: reference traces, generated from the reference by exploring its host interface through the adapter (every observed state reached by a shortest path, and every call and message tried from it; S97), each a sequence of host calls with the result and the observations expected after each;
- `changes/1..3/`: three evolution changes, each a brief delta with its own reference, O2 and O3 (S92);
- `mutants/`: for each version, one mutated reference with a defect the brief rules out.

## 4. O1, from an independent session (M3-1)

`docs/m3/o1-prompt.md` is the whole of what the O1 session receives, with `brief.md`, `host.ts` and the change briefs of each task, copied into an otherwise empty workspace. The prompt asks for one end-to-end test suite per task and per version, against the host interface only, runnable with `node --test` against any implementation module passed by path. It says what an escaped defect is, and that the suites will be judged by whether they pass on a correct implementation and fail on a wrong one. It names no poly concept. I do not write O1: the owner runs the session and commits its output under `experiments/m3/o1/`. My part is `experiments/m3/controls/o1.mjs`, which runs each suite against the reference (through the adapter) and against the mutant.

## 5. Controls (PT13)

For each task and each version:

1. The reference machine checks clean (`poly check`, every stage run, no finding).
2. The reference replays its own O3 corpus at 100% through the host adapter over polyrun.
3. The mutant fails O3 or O2 on at least one trace.
4. Once O1 exists, the O1 suite passes on the reference and fails on the mutant.

A task whose controls fail is removed before any arm is scored, and this plan records which and why. A version (an evolution change) whose controls fail removes its task, since the evolution measures need all three.

## 6. The runner

`experiments/m3/runner/` runs one arm on one task with a model, a token budget and a wall-time limit, in a fresh workspace under the system temporary directory. Its record of what was built is in section 10. The workspace holds only the brief, the host interface (and for arms 3 and 4 the schema of `host.map.json`, which the agent writes as part of its solution, and the adapter generator, S90), a `package.json`, and the arm's tools: nothing from `experiments/m3/tasks/*/reference`, `o2.mjs`, `o3/` or `experiments/m3/o1/`. The agent is driven through the `claude` CLI in headless mode (`claude -p --output-format stream-json`), with `--allowedTools` per arm: file tools and a shell for all arms, the polygraph CLI for arm 2, the poly CLI for arms 3 and 4. The four arms share one prompt skeleton (`experiments/m3/prompts/skeleton.md`), filled with the arm's language, tool and delivery sections and nothing else; the delivery differs by arm (a TypeScript module, or a poly module and its `host.map.json`). Each evolution change is a further turn of the same session. The runner records the full stream (prompts, tool calls and results, token counts per turn, timings) and the delivered code as a journal, and scores the delivery with O1, O2 and O3 after the run, outside the workspace.

The dry run replaces the CLI with a stub agent that replays a recorded stream, and runs T1 with a small budget through every arm, so the workspace isolation, the budget cut-off, the journal and the scoring are tested without a real run.

## 7. The analysis script

`experiments/m3/analysis/analyse.mjs` reads run records and computes PT13's measures per arm and task: escaped defects per delivered task (O1), tokens per delivered task, wall time, delivery rate, O2 and O3 findings, regressions introduced and caught across the changes, and for arm 3 the diagnostics by code and the share of typed fixes applied unchanged. It runs the fixed tests: per-task means, the Wilcoxon signed-rank test over the ten tasks (exact, two-sided), Holm's correction over the five comparisons at 0.05, and the win, surface and stop rules as PT13 writes them. It is tested on synthetic records built so that each rule's answer is known: a clear win, a null result, a surface decision each way, and a stop.

## 8. The freeze (M3-5)

Everything is committed, and this plan records the SHA-256 of each part: each task's brief, host interface, mapping, reference, O2, O3, changes and mutants; the O1 prompt; the controls; the runner and its prompts; the analysis script. The proposed per-run token budget and wall-time limit, and the estimated cost of 200 runs with their three evolution changes each (800 agent sessions' worth of turns), are computed from the dry-run journals' token counts scaled to the budget, at the published price of the proposed model, and stated with the assumptions. Any change after the freeze is a deviation and is reported.

## 9. Spec issues

- **S87. The polyrun change and the owner's uncommitted work.** The polygraph checkout has uncommitted changes in fifteen files, `package.json` among them, so the patch bump cannot be committed there without staging or overwriting them. *Proposal:* make the change in a git worktree on a branch `m3-sendto` cut from `583b82c`, commit and bump there, vendor from that commit, and leave the merge into the owner's `main` to the owner.
- **S88. The form of K9's refusal.** K9 says an outside dispatch of an action wired as a live child's completion is "refused", and PS7.1 says such a stimulus is not offered. polyrun rejects other refused inputs as journaled steps (a terminal instance, FR-1.2). *Proposal:* the kernel refuses the dispatch before any step, with a `RefusedError` naming K9, and journals nothing: a stimulus that is not offered is no step, so the journal replays as PS7.1 explores. A step the cascade delivers later is journaled as now.
- **S89. How polyrun delivers a message.** PT7a gives the intent and PS13 and PS14 the meaning, not the runtime's mechanism. *Proposal:* a message is an outbox row of kind `sendTo`, written in the step's transaction; a message worker dispatches it with the action id `<sender>:<seq>:<position>`, so a redelivery is deduplicated (PS14.1); rows are picked in no fixed order; a send to an instance that does not exist goes to the dead-letter list with its reason, never silently dropped; and the worker exposes `pendingMessages()` and `deliverMessage(id)` so tests and the M3 adapter can choose the arrival order.
- **S90. How the generated adapter knows the machine behind the host interface.** M3-4 generates the adapter per task, and a method name alone does not say which instance and action it drives. *Proposal:* each task has `host.map.json`, part of the task and shown to arms 3 and 4 with the host interface: for each method, the machine, the instance argument and the action with its parameter mapping; for each query, the instance and the fields it reads. Arms 1 and 2 do not need it and do not see it. It fixes names the poly arms must use, which is information about the interface, not about the reference machine.
- **S91. Arrival order in the host interface of a multi-machine task.** A TypeScript arm that delivers messages synchronously cannot be tested on the arrival orders the configuration check explores, so O1 would see only one order in arms 1 and 2 and the comparison would hide the defect class PT7a targets. *Proposal:* the host interface of a multi-machine task includes a small network API (`inFlight()`, `deliver(i)`, `deliverAll()`), which every arm implements and every oracle may drive. The briefs say messages may arrive in any order.
- **S92. Evolution changes need their own reference, O1, O2 and O3.** PT13 scores regressions by O1 after each change. *Proposal:* each change has its own reference machine, mutant, O2 and O3, and the O1 session writes one suite per version; the controls of section 5 run on every version.
- **S93. PT18 does not yet say what M3-2 moved.** The M3 row says "today's polyrun", and the M5 row still lists "`sendTo` delivery in polyrun", which M3-2 brings forward. *Proposal:* the M3 row names the M3-2 and M3-3 prerequisites, and the M5 row drops `sendTo` delivery.

S87 to S93 are ruled in `decisions-m3.md` (27eedb7), and their spec text is applied (02b629f). They are accepted as proposed, with two changes: in the poly arms the agent writes `host.map.json` as part of its solution and the generator validates it, since providing it would give those arms a design the TypeScript arms make themselves (S90); and the K9 refusal also returns an error naming K9 and writes an audit-log entry (S88). The task template in `experiments/m3/tasks/_template/` carries S90 to S92.

Raised while preparing steps 4 to 8. The owner gave a position on S95, S96, S97 and S99 before the freeze; the text below applies those positions, and S94 and S98 are applied as proposed. All six need a ruling with the freeze.

- **S94. The protocol of a multi-machine task, and the effects of a task, are part of its interface.** O3 and O1 test arrival orders through `inFlight()` and `deliver(id)`, and answers through `pendingEffects()` and `completeEffect(id, outcome)`, so they must recognise a message or an effect in any arm's implementation. *Proposal (applied):* the brief names each message (sender, receiver, name, data) and each effect (kind, data), and O3 and O1 match by those, never by id or position. This tells the TypeScript arms the protocol, which the poly arms must follow too; it is information about the interface, as the host methods are.
- **S95. Effects in the task set.** *Owner's position:* keep effects in at least two tasks, through an effect port in the host interface that every arm uses, unless a blocker makes that impossible. *Applied, no blocker:* T1's charge (`payment.charge`) and T3's authorisation requests (`card.authorize`) are effects, in all four versions of each. Every arm's host interface has the port: `pendingEffects()` lists the effects requested and not answered, and `completeEffect(id, 'ok' | 'failed')` answers one. In the poly arms an effect is an `effect` declaration whose `ok` and `failed` completions are those answers; the adapter lists polyrun's pending outbox rows and runs the answered one through polyrun's own effect worker, with a handler that returns for `ok` and throws a permanent failure for `failed`, so the completion is the engine's. No engine change was needed. The effects stage of `poly check` (polyrun `check-effects`) now runs on T1 and T3, each with a path property bounding the effects. Timers stay out: the host interface would need a clock, and no position asked for them; T3's timeout is still a command.
- **S96. A win needs significance.** *Owner's position, applied:* a win needs both the 30% reduction against arms 1 and 2 and Holm-corrected p < 0.05 in both comparisons. `analyse.mjs` reports the effect and the significance separately and calls a win only when both hold; a synthetic test has a 30% reduction that is not significant and is no win.
- **S97. One trace per transition, every version.** *Owner's position, applied:* O3 has one trace per transition in every version, and every mutant is re-verified against it. A state is keyed on what the interface shows and on the reference's own state, so hidden state cannot merge two states the traces must both reach (without that, T7's retry flag hid a whole branch). The generator forks each step from a snapshot of the store, and the controls replay a snapshotting host's traces as a tree, each shared prefix once; a test shows the tree replay and the per-trace replay find the same failing traces on T1. An arm's TypeScript implementation is replayed trace by trace. The earlier exception (`transitions: false` for five versions) is gone; it had let T7 v3's first mutant through, since that mutant differed only on transitions out of an ended run.
- **S98. T9 covers one election round.** With terms up to 2, three nodes and messages in any order, the configuration has more than 340,000 global states at transit 8 and is still bounded, so `poly check` is INCONCLUSIVE and the reference cannot pass control 1. *Proposal (applied):* T9 is one round (term 1); vote-once and one leader per term are still what it tests, and a crash with recovery (change 3) still exercises persistent votes.
- **S99. Tokens.** *Owner's position, applied:* the runner records input, output, cache-read and cache-write tokens separately for every turn; the primary measure is all tokens processed (their sum), and cost at list price is a secondary measure, computed by `analyse.mjs` from a price table given with `--prices`.

Two further rules from the owner, applied: pilot runs use a practice task outside the ten (`experiments/m3/practice/P1`, book loans, a base version and one change, with its own controls), and the runner refuses a pilot until the owner writes `experiments/m3/PILOT`, as it refuses a run of the ten until `FROZEN`; a pilot on any of the ten would have its results discarded. And the O1 session also writes `o1/LEAKS.md`, flagging every sentence of a brief that names a language, framework, tool or notation, or describes an internal design; `o1-check.mjs` lists the flags for the owner, and a missing `LEAKS.md` fails the check.

## 10. Record

**Step 1 is done.** The polyrun change is polygraph commit `4949de4` on branch `m3-sendto` in the worktree `C:\Users\jjdub\code\polygraph-m3`, version 8.3.2, not pushed and not merged. It adds `sendTo` as a kernel intent (an outbox row keyed `<sender>:<seq>:<position>`, delivered as a dispatch with that key as its action id; an unknown target dead-lettered and journaled on the sender as a rejected `$undeliverable` step), address markers resolved at commit, and the K9 refusal (no journal row, a `RefusedError` naming K9, a row in the new `pr_audit` table). `check-effects` and `check-product` accept `sendTo` as a kernel kind. `polyrun/test/sendto.test.mjs` has eight tests on artefacts poly lowers from its conformance sources; each failed before its change. Two older polyrun tests drove a parent past its live child by an outside dispatch of the child's completion, which K9 now refuses; they wire a different completion. `test:polyrun` passes 100 tests, and polygraph's `npm test` passes.

`vendor/polygraph` is re-vendored from `4949de4`: the same closure, eight files changed, `PROVENANCE.md` names the branch and commit. In poly, a sending machine runs polyrun's `check-effects` at stage 3 and, as a parent with a compose invariant, `check-product` at stage 4; only a detached spawn still keeps a stage poly-ref's alone (S60), since `createInstance` is not built. `test/config-polyrun.test.mjs` replays under polyrun every global step poly-ref explores in every configuration of the conformance and example sources (the checkout and its optimistic variant, the four AC3 seeds, and two configurations added over `sends.poly`'s machines), one message at a time, and requires polyrun's instance states and messages in transit to equal poly-ref's after each step. It fails on the 8.3.1 copy. `examples/delivery` is one service machine that models the network, not a configuration, so it is checked alone as before. poly's `npm test` passes 636 tests.

**Step 2 is done.** `applyFix` takes the file it applies to; for a `.ts` file it edits the embedded module's AST exactly as for a `.poly` file, reprints the changed node with `printNode` (new in `poly-embed`, which reads through the author's arrow parameter and imported names) and splices it in at the node's span, then requires the text to read back as the edited AST. The pipeline attaches fixes to embedded modules, and `poly fix` applies them. Printed as an embedded module, `fixes.poly` is offered the same fifteen fixes by id, and the 120 random orders of S70 give the same counts on both surfaces (1,191 applied, 609 refused `PL0201`), with the author's comments and a line in their own formatting kept. `add-require` and `widen-range` apply on both surfaces, and on an author's module with a parameter named `s`, an aliased import and a one-line handler. PT2.5 and PT12.1 say so. Review finding D7, which kept fixes off the embedded surface, is superseded by M3-3.

**Step 3 is done.** `experiments/m3/adapter/generate.mjs` validates a `host.map.json` against the host interface (read with the TypeScript parser) and the agent's module, standalone or embedded, and writes `host.gen.ts` with the lowered machines beside it; its README lists what a failed build is. The map gained one key, `key` (`$arg:<argument>`), for a method or query on a family of instances a method creates, since an argument alone does not say which machine it names. Every member of `Host` and the network API return a promise, in every arm, because the adapter reads polyrun's store; the template says so. `test/m3-adapter.test.mjs` generates the adapter for the checkout from both surfaces, drives both arrival orders through `deliver`, and breaks the map in fourteen ways, each a failed build naming what it broke with nothing written. Each task's reference goes through the generator in the controls. The generator later gained an instance named by an argument (`"instance": "$arg:<argument>"` with `"machine"`), for tasks with named parts such as T7's workers, and the effect port of S95; its test now breaks the map in eighteen ways.

**poly's checks found two bugs in my own reference designs** while I wrote the tasks, before any arm ran:

- **T2, a waiting list of one (the first draft of change 3).** An order that asked for more units than were available became the inventory's waiting order, and a cancelled pending order withdrew from the list with a `Withdraw` message. The configuration check reported a liveness lasso (PL3301, `settle`): the order's `Withdraw` can overtake its own `Reserve`, so the inventory ignores the withdrawal, then puts the order on the waiting list, and the cancelling order waits for ever. The witness was four steps (`Place`, `Cancel`, `Withdraw`, `Reserve`). Fixing it needs per-order memory at the inventory, so change 3 became a smaller change (reducing a confirmed order).
- **T7, the run that could never hear from its workers.** The first reference recognised a report by comparing its sender with the worker addresses it held. Checked alone, a run's worker addresses are `none`, so no report matches, and a cancelling run waits for ever: the deadlock check reported it (PL3201). The design depended on addresses that only a configuration provides; reports now carry their task number.

Neither bug was in a mutant: both were in the reference designs. A third reference bug was found by the controls, not by poly: in T10 a `Revoked` can overtake the `Granted` it revokes, the client ignored it, and then held an expired lease for ever. The configuration's invariant (one holder with the current token) still held, so `poly check` was CLEAN; T10's O2 predicate that holders agree once nothing is in transit failed on the reference's own O3, in 933 of 56,298 traces. Such a property speaks of quiescence, which a configuration invariant cannot state today. The first fix remembered the last token revoked; the regenerated O3 then failed in 71 of 83,601 traces, where two `Revoked` messages arrive out of order and the older overwrites the newer. The client now remembers the newest token revoked and does not hold a grant of it or an older one, and the brief says so.

**Step 4 is done.** The ten tasks are in `experiments/m3/tasks/T1` to `T10`, each with a base version and three changes, forty versions in all; every version has its brief (a delta for a change), its host interface where it changes, a reference and a mutant in poly with the reference's `host.map.json`, `o2.mjs`, `explore.json` and `o3/traces.json.gz`. Five tasks are multi-machine (T2, T4, T7, T9, T10); each reference has a configuration whose stuck, send-to-none, invariant and, where stated, liveness checks run. Two tasks have effects (T1, T3, S95), whose references run the effects stage of `poly check`. The table in section 3 moved from the first draft where S95 and S98 say. The O3 generator explores a reference through its adapter, forks each step from a snapshot of the store, and keys a state on what the interface shows and on the reference's own state (S97). A TypeScript implementation of T1 written separately for the dry run passes O3 on all four versions, a check of O3 against a second implementation. A practice task, P1 (book loans), is outside the ten for pilot runs.

**Step 5 is done.** `docs/m3/o1-prompt.md` is the whole prompt of the O1 session, which now also writes `o1/LEAKS.md`. `experiments/m3/o1-kit.mjs` assembles its workspace outside the repository: the prompt, and for each task and version the brief as changed so far and the host interface, 81 files; `test/m3-tasks.test.mjs` checks that no kit file names poly, a machine, a reference, a mutant, O2 or O3. `experiments/m3/controls/o1-check.mjs` checks what the session returns (one suite per version, loading `M3_IMPL`, Node built-ins only, at least one test, and `LEAKS.md`) and lists the flags; it repairs nothing.

**Step 6 is done.** `experiments/m3/controls/run.mjs` runs the controls of section 5 per version. On the frozen set, after every change recorded here, controls 1 to 3 pass on all forty versions of T1 to T10 and on both versions of P1: every reference checks clean with every stage run, every reference replays its own O3 with every O2 predicate true, and every mutant fails O3 (and, on 21 versions, O2 too). Control 4 is not run: O1 does not exist until the owner's session writes it, and `o1-check.mjs` and control 4 then run on it. O3 holds 831,517 traces in all, one per transition (S97), from 174 (T1 v0) to 164,502 (T10 v3), 6.4 MB gzipped; a snapshotting host replays them as a tree. Along the way the controls caught four faults of mine besides the reference bugs above, each fixed and re-verified: three O2 predicates that were wrong about states a correct system reaches (T4's declined carts hold their units, T9's crashed node need not have voted, T7's timed-out task may leave its worker busy until the abort arrives), and T7 v3's first mutant, which differed only on transitions the earlier state-only traces skipped. `test/standing.test.mjs` now also runs `poly check` over every source under `experiments/`, and none hits a toolchain code.

**Step 7 is done.** `experiments/m3/runner/` builds a fresh workspace per run under the system temporary directory: the brief, the host interface and a `package.json` for every arm; TypeScript; for arm 2 polygraph at `4949de4` by `git archive`; for arms 3 and 4 poly's built toolchain, its README, technical spec without PT13, semantics, the examples that do not model a task family, the map's schema and the adapter generator, and for arm 4 the embedded declarations and two embedded examples. `agent.mjs` drives `claude -p --bare --output-format stream-json --verbose --permission-mode dontAsk --disable-slash-commands` with the arm's allowed tools, resumes the session for each change, records the four token parts (S99), and stops a turn at the run's token budget or wall time; a stub agent replays a scripted stream. `run.mjs` journals every stream event, snapshots the delivery after every tool result that changed it, copies the delivery out after each turn, and refuses a real run until the owner writes `experiments/m3/FROZEN` (or `PILOT` for the practice task). `score.mjs` scores a run outside its workspace: delivery, admission (`poly check` CLEAN and the adapter builds), O3 and O2 in a child process with a timeout, O1 by test, regressions introduced and caught (a test of an unchanged rule failing at delivery, or failing on a snapshot and passing at delivery), and for the poly arms the diagnostics seen and the fixes offered and applied. `test/m3-runner.test.mjs` runs T1 through every arm with the stub: the workspaces hold no reference, mutant, O2, O3 or O1 file (checked by digest), arm 2's third turn exceeds the budget and its last change is not run, the journal has every prompt, the poly arms' toolchain checks and builds the adapter inside a workspace, every delivery scores with no O3 or O2 failure, and a synthetic O1 shows a regression caught and one introduced.

**Step 8 is done.** `experiments/m3/analysis/analyse.mjs` computes PT13's measures per arm and task, the five escaped-defect comparisons by the exact Wilcoxon signed-rank test with Holm's correction (tokens as a second family), and the win (S96), surface and stop rules; a task with no delivered run for an arm is left out of that comparison and listed. `stats.mjs` is tested on known values, and `test/m3-analysis.test.mjs` on synthetic records whose answer is known: a clear win, a reduction that is not significant, a win denied by tokens, a null result, the surface decision each way, a stop, a left-out task, and the four token parts with their cost.

**Step 9, the freeze.** `experiments/m3/freeze.mjs` writes the SHA-256 of all 450 files of the experiment (364, and since S100 the 86 of the toolchain: poly's package sources without build output, everything under `vendor/` and `package-lock.json`), with the git commit it was taken from (`04c62e8`), to `experiments/m3/freeze.json`, and one digest per part over its files' paths and digests; `--check` lists any file changed since. The parts, by the first 16 hex digits of their digest:

| Part | Digest |
|---|---|
| T1 v0 | `599c12190596ca04` |
| T1 v1 | `6959d7b6c3c7dda1` |
| T1 v2 | `17e5b1ba0c5e28d8` |
| T1 v3 | `ce92c22f83bb4434` |
| T2 v0 | `c7dba7aefe2f06b5` |
| T2 v1 | `0e59606899df8300` |
| T2 v2 | `ed77f9977969a944` |
| T2 v3 | `02919574923855a2` |
| T3 v0 | `eb1e039b19adeeae` |
| T3 v1 | `26998968ae478780` |
| T3 v2 | `8bcd90f31b18b4bf` |
| T3 v3 | `b97c7c2f19da1939` |
| T4 v0 | `425326faee24cb09` |
| T4 v1 | `411ed868022b1f98` |
| T4 v2 | `216228a23473d4a7` |
| T4 v3 | `d8faad9e279d3d93` |
| T5 v0 | `cdfc854429402d05` |
| T5 v1 | `19ae94a5137c422d` |
| T5 v2 | `f591844725f8c57e` |
| T5 v3 | `04b38baf06aa7d4f` |
| T6 v0 | `8cad1868b35d862a` |
| T6 v1 | `27cfc9aba33fe869` |
| T6 v2 | `15b8b64eeca96216` |
| T6 v3 | `39f3aa44e7db7400` |
| T7 v0 | `ec9e505c80805559` |
| T7 v1 | `835d28af88c2659b` |
| T7 v2 | `58e22d61579224c7` |
| T7 v3 | `d1e252f422ab9100` |
| T8 v0 | `12260ffbe085a6c0` |
| T8 v1 | `f7a8097fe177b109` |
| T8 v2 | `7bac9f64b1951d89` |
| T8 v3 | `33380a3713c42740` |
| T9 v0 | `5a6f5fc129e939d7` |
| T9 v1 | `50c2c646e45014f7` |
| T9 v2 | `1abe77d4fb7b16a0` |
| T9 v3 | `6aeafc2e65157c77` |
| T10 v0 | `a370a6769ca34c03` |
| T10 v1 | `1d9dbaf39cde7976` |
| T10 v2 | `69893ae5279363be` |
| T10 v3 | `95561d8f9cf16aa2` |
| P1 v0 | `a32c6f4ee46bc974` |
| P1 v1 | `0c2f87ea81498248` |
| O1 prompt | `7b3997f818de199b` |
| template | `2d43b4899af7aa53` |
| controls | `120afbeace3a1754` |
| adapter | `56bff45dcf872922` |
| runner and prompts | `52262a7c78dda0ee` |
| analysis | `de9bb54faa4c0f16` |
| toolchain (S100) | `246ec34ee8e2dc7f` |

*The proposed budget.* Each run (base brief and three changes, one session) gets **30,000,000 tokens**, counted as all tokens processed (S99), and **3 hours** of wall time, with `--max-budget-usd 60` as the CLI's own cap. The dry run's tokens are scripted, so they say nothing about real use, and the budget cannot be computed from them as section 8 first planned. The figures above are a ceiling for a session that reads its toolchain's manual, writes and tests a small system, and takes three changes; the pilots are there to replace them with measured ones.

*The estimated cost.* Cost = runs × (input × p_in + output × p_out + cache read × p_read + cache write × p_write) / 10^6. Two assumptions must be confirmed before approval: the model, which I propose to be the same for every arm (`claude-opus-5-5`); and its list prices, which I do not have for that model. As an illustration only, at the rates of an Opus-class model at $5 input, $25 output, $0.50 cache read and $6.25 cache write per million tokens, and a token mix typical of agent sessions (90% cache read, 5% cache write, 3% input, 2% output), a run that uses its whole budget costs $13.50 + $9.38 + $4.50 + $15.00 = $42.38, and 200 runs cost **$8,475** at the ceiling, or about $4,240 if runs use half their budget. The O1 session (one session, forty suites) and the pilots add little beside it.

*Pilots.* Before the 200 runs, four pilot runs, one per arm, run on the practice task P1 once the owner writes `experiments/m3/PILOT`. Their tokens and wall time, recorded in four parts, replace the assumptions above, and the budget is set from them before `FROZEN` is written. A pilot on any of the ten tasks would be discarded.

## Conclusion

M3 is prepared in nine steps, and no arm runs before the frozen set and the budget are approved. The polyrun change comes first, made on a branch so the owner's uncommitted work is untouched, and then every multi-machine case runs on polyrun as well as in poly-ref. Ten tasks, five of them multi-machine and none with detached children, each come with a reference, hidden invariants, traces, three changes and a mutant, and every control runs before any arm is scored. O1 comes from a session that sees only the briefs and interfaces. The seven spec issues S87 to S93 are ruled and applied, and all nine steps are done: polyrun delivers messages and refuses K9, the embedded surface has the typed fixes, the adapter is generated from the agent's map, the ten tasks have their references, mutants, O2 and O3 with every control passing, the O1 prompt and its kit are ready, and the runner, the analysis and the freeze are built and tested without spending anything. Writing the tasks, poly's checks found two bugs in my own reference designs, and the controls a third. S94 to S99 need a ruling with the freeze, and the budget and cost need the pilots and the owner's prices. Nothing runs until the owner writes `PILOT`, then `FROZEN`.
