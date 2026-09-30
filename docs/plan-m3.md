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
   - K9: an outside dispatch of an action wired as the completion of a live child is refused (S45, S80), in the form S88 proposes.
   - polygraph tests for each, in its own suite; a commit as `kizo-core`; the patch version bumped to 8.3.2 on the branch; nothing published or pushed.
   - Re-vendor into `vendor/polygraph` from the branch's commit, with `PROVENANCE.md`'s table and `test/vendor.test.mjs` updated in the same commit.
   - In poly: the pipeline stops listing "polyrun has no sendTo intent yet" (S58), stage 3 of a sending machine runs polyrun's `check-effects` again, and every multi-machine conformance case (`conformance/m1/sends.poly`, the checkout, `examples/delivery`) runs under polyrun: each configuration's reachable global states are replayed as polyrun runs, driven one message at a time, and must agree with poly-ref's. `createInstance` is not built: no task uses detached children (section 3).
2. **Embedded fixes (M3-3).** `attachFixes` runs for `.ts` modules. Each of the six fixes of S70 is computed on the AST as now, and applied to an embedded module by reprinting the edited node with the embedded printer and splicing it into the file at the node's source span, so the author's formatting and comments outside the node are kept. The preconditions are the same node digests. The random-order test of S70 runs over both surfaces: the fixable source, and its embedded print.
3. **The host adapter (M3-4).** A generator in `experiments/m3/adapter/` reads a task's host-interface mapping (S90) and emits a TypeScript module that implements the host interface over polyrun's kernel: a method is a dispatch of one action to one instance, a query reads the instance's state through the flat layout, and the network methods of a multi-machine task (S91) drive the message worker. It is tested on the reference machine of each task.
4. **The task set** (section 3): briefs, host interfaces with their mappings, reference machines, O2, O3, the three evolution changes, and a mutant per version.
5. **The O1 prompt** (section 4), and a script that checks what the O1 session returns.
6. **The controls** (section 5), run on every task and every version.
7. **The runner** (section 6), with its dry run on one task.
8. **The analysis script** (section 7), with its synthetic tests.
9. **The freeze** (section 8): digests, budget and cost, recorded here. Then stop.

## 3. The task set

Ten tasks, from PT13's three families. Five involve two or more machines that talk, so the configuration check runs on half the set; none uses detached children, so `createInstance` stays unbuilt (M3-2).

| Id | Family | Task | Machines | Modelled on |
|---|---|---|---|---|
| T1 | order and payment | Order lifecycle: draft, items, place, pay, ship, cancel, with a charge effect | 1 | the OMS order |
| T2 | order and payment | Order and inventory: an order reserves stock, the inventory confirms or refuses | 2 | PT7a's checkout |
| T3 | order and payment | Payment with authorisation, capture, refund and a retry timer | 1 | the OMS order's charge |
| T4 | order and payment | Checkout across cart, payment and inventory, each a machine | 3 | PT7a, extended |
| T5 | workflow status | Run status derived from three task slots, with eviction | 1 | hatchet |
| T6 | workflow status | A run with retries and cancellation of its tasks | 1 | hatchet |
| T7 | workflow status | A run and two workers that report task status by message | 3 | hatchet, distributed |
| T8 | leader election | Raft roles and terms for one node | 1 | raft |
| T9 | leader election | An election among three nodes by vote requests and replies | 3 | raft |
| T10 | leader election | A leader lease held by one of several clients, renewed and revoked | 3 | raft, leases |

Each task has, under `experiments/m3/tasks/<id>/`:

- `brief.md`: the feature in prose, with no reference to poly, states or any design choice beyond the observable behaviour;
- `host.ts`: the host interface, a small TypeScript API; and `host.map.json`, its mapping to machines and actions (S90);
- `reference/`: the reference machine in poly, checked clean by `poly check`;
- `o2.mjs`: the hidden invariants, as predicates over the host interface's observable state;
- `o3/`: reference traces, generated from the reference machine by poly-ref (every reachable state reached by a shortest path, and every transition), each a sequence of host calls with the observations expected after each;
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

`experiments/m3/runner/` runs one arm on one task with a model, a token budget and a wall-time limit, in a fresh workspace under the system temporary directory. The workspace holds only the brief, the host interface (and for arms 3 and 4 its mapping and the adapter), a `package.json`, and the arm's tools: nothing from `experiments/m3/tasks/*/reference`, `o2.mjs`, `o3/` or `experiments/m3/o1/`. The agent is driven through the `claude` CLI in headless mode (`claude -p --output-format stream-json`), with `--allowedTools` per arm: file tools and a shell for all arms, the polygraph CLI for arm 2, the poly CLI for arms 3 and 4. The four arms share one prompt skeleton (`experiments/m3/prompts/skeleton.md`), filled with the arm's language section and tool section and nothing else. Each evolution change is a further turn of the same session. The runner records the full stream (prompts, tool calls and results, token counts per turn, timings) and the delivered code as a journal, and scores the delivery with O1, O2 and O3 after the run, outside the workspace.

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

## Conclusion

M3 is prepared in nine steps, and no arm runs before the frozen set and the budget are approved. The polyrun change comes first, made on a branch so the owner's uncommitted work is untouched, and then every multi-machine case runs on polyrun as well as in poly-ref. Ten tasks, five of them multi-machine and none with detached children, each come with a reference, hidden invariants, traces, three changes and a mutant, and every control runs before any arm is scored. O1 comes from a session that sees only the briefs and interfaces. Seven spec issues (S87 to S93) need a ruling; S87, S88 and S89 come before step 1, and S90 and S91 before the task set.
