# Decisions: M5

*Cognitive Fab · October 2026 · rulings on the M5 plan (`docs/plan-m5.md` on `m4`, 4569a06)*

## Rulings on the M5 plan (S144 to S157)

The plan is accepted with the rulings below. The outage test (section 6) and PD5-A1 to PD5-A12 (section 7) are accepted as written. E5 (polyrun: start an instance at given initial values) goes on the owner's list. E6 is not needed.

| Issue | Ruling |
|---|---|
| **S144** Split M5 | **Accepted.** M5a, governance (steps 0 to 10), and M5b, identity and the carried host items (steps 11 to 18). Each has its own gate, code review and close. PT18's M5 row is split in this commit. PD5 enters 04-semantics only in M5b. |
| **S145** BUSL engine | **Not vendored into this repository.** poly's licence is the owner's decision and does not block M5a. Until it is made, Polyaxion, polyman and polysec-core are an optional peer dependency, resolved in tests from the sibling checkout at c37c60e, each package pinned by hash in `PROVENANCE.md` and checked by `test/vendor.test.mjs` exactly as a vendored engine would be. A check that needs them is listed as not run where they are absent. The engines are still never forked. |
| **S146** Gate sessions | **Accepted.** One session per trust scope per runtime, keyed `scope:<name>`. The gate host serialises each session and assigns `sseq` on every proposal and settle; each `verdict` and settle event carries `sseq` and Polyaxion's `state_before` digest. Session replay re-applies a session's events in `sseq` order on a fresh store. The bench reports per-session throughput, since a scope is the unit of serialisation. |
| **S147** Reading another machine | **Accepted, with two additions.** (1) A `machine("m.M")` read that can never be known (a non-singleton other than the emitter) is a checker finding, not a silent `unknown`: a rule that can never fire is the policy form of a vacuous property (S113). (2) **No allow outlives the state it read.** The `verdict` event records each read singleton's `seq`. Before a handler runs, the host compares them with the singletons' current `seq`; if any has advanced, the allow is not acted on and the intent is proposed again under a new `sseq`. This is what makes PD5-A12 ("no refund handler runs after the revocation") hold for intents allowed before the halt. |
| **S148** Minimal conflicting subset | **Accepted.** Minimal by PS8.6's deletion order (not minimum), with the cost reported; per mode value for PD4.4a and PD4.4b. |
| **S149** Halt check | **Accepted.** The decision-table check in poly-ref is a check on the check path, so it gets controls like any other: a seeded policy without the halt rule must give a finding with a witness, and a deliberately broken table evaluator must be caught. A rule over an open domain is reported `runtime-only`, never clean. PD5.3.3a cites the decision-table check. |
| **S150** Signed record | **Accepted, with one addition.** The `people` and `agents` keyrings are part of what admission certifies: a keyring change needs re-admission, and `load` refuses a keyring that differs from the certificate's. `at` is recorded, not trusted. |
| **S151** Capabilities | **Accepted, with one addition.** Redirects are not followed by the transport on its own: each hop is checked against the declared prefix, and a hop outside it throws before the request and is audited. |
| **S152** Sandbox | **Accepted as proposed.** The generator is built and read back in M5b; enforcement runs only where a gateway is configured and is listed as not run elsewhere. Not moved to M6. |
| **S153** Initial values | **Accepted**, after E5. Until then S141 is listed as waiting. |
| **S154** Installed packages | **Accepted.** Hashed, not linted; the certificate's limits say the sandbox is what stops a package's own I/O. |
| **S155** Claims and lineage carriage | **Accepted.** `$claims` and `$lineage` are reserved under `PL1208 RESERVED_NAME`: a program that declares them is refused at check, and a dispatch that supplies them from outside is refused before any step. If polyrun refuses reserved keys, it goes on the engine list. |
| **S156** Attribution | **Accepted:** `scope "support" requires attribution`. |
| **S157** Stale code | **Done by the owner** in this commit: `principal_symmetry.py` prints `PL1206`. |

**Next.** Build M5a, steps 0 to 10, each with a test that fails first, then M5a's code review, a clean gate and its close. M5b is not started before M5a closes.

## S147 amended: a stale allow is rechecked a bounded number of times

PT9.7's `OutboxIntent` has no transition from `Allowed` back to `Proposed`, its step property `no-reproposal-after-allow` forbids one, and an unbounded re-proposal breaks `settles`. **The machine changes, with a bound.** A new action `Recheck` takes `Allowed{attempts: n}` back to `Proposed{decision: 1}`, keeping `n`, at most twice per intent. When the bound is spent, the intent is `Denied` with reason `stale-allow` and the failed completion. `no-reproposal-after-allow` becomes "no re-proposal except by `Recheck`". `settles` must still hold, and the state count is re-checked at every bound from 1 to 10, with PT9.7's figures updated in the same commit. The PT9.7 digest pinned for `RESERVED_NAME` (S143) is updated with it.

## PD4-A3 moves to M5b

PD4-A3 ("`Declare` is dispatched only with a person's signature") is met in M5b, where `Declare` is written `on Declare(m) by op: Caller` with the person-key adapter (S107). No interim `signed` modifier is added: grammar that M5b would retire is not built. M5a builds and tests the signed-record half (keyrings, verification, the signer journaled) through approvals. M5a's gate is PD4-A1, PD4-A2 and PD3-A2; PT18 is amended in this commit.

## S149 amended: `never` statements in policies

The decision-table check proves statements a policy states. In M5a, PT8.1 gains `never <id> "<text>": allow when <expr>`. poly-ref proves it over the decision table and gives a witness proposal when the policy allows one. The seeded control drops the rule that enforces a `never`. Two rules carry over: a statement whose `<expr>` is never true over the table is `INCONCLUSIVE` (`vacuous`), never clean (S113); a statement over an open domain is `runtime-only`. PD5.3.3a is written as a `never` in M5b.

## S160 and cross-scope sends in M5a

**S160 accepted:** an instance's trust scope is its module by default. A trust scope is a boundary between parties, not a machine, so scopes are not made per machine.

**Cross-scope sends come from configurations, as PS8.7's second clause states.** In M5a, a configuration may assign `scope "x"` to its instances. The configuration check explores the gate's allow, deny and escalate on every send between instances of different scopes (PS4.4), and a deny delivers `SendDenied`. The runtime's gated message path and `SendDenied` are built in M5a and tested by injecting a cross-scope message below the language, since the runtime has no configuration instances before S153 (E5). M5b adds the end-to-end runtime test once configurations can be instantiated. M5a's record states this limit.

## S161 polycheck runs as stage 5a

**Option 2: pin polycheck and run it.** A `never` statement is proved per proposal, so it cannot express a region over capabilities a program accumulates across steps, such as the lethal trifecta (untrusted input, sensitive data and egress together). That is what polycheck checks, and PT8.4 stays as written.

- polycheck becomes a second optional peer, pinned and hash-checked like Polyaxion (S145), and listed as not run where absent.
- Each effect kind's labels map to polycheck's flags by a fixed table in the spec; an effect kind a policy mentions is marked gated.
- Stage 5a runs polycheck's default regions over that model.
- Controls, as for every check: a seeded program with the trifecta and no gate must be a finding with a witness, and the same program with the egress effect gated must be clean.
- `never` statements keep the state-dependent cases (S149).

## For M6's planning list

- **A second agent host.** M6 (PT18: workflow lowering, MCP server, language server, Claude Code plugin, `poly new`) is planned so that the MCP server and the language server are host-neutral, and the Claude Code plugin is one thin adapter over them. A DeepSeek Harness plugin is planned as a second adapter, built once its plugin API is declared stable. M6's gate then shows the same workflow running unchanged under both hosts.

## M5a closed

**M5a is closed** on `m4` at 038fe86. The gate passes from a clean build: 1,247 tests, 1,243 pass, 0 fail, 4 waiting (E1, E2, FROZEN, and outage O10, which is M5b's). The 28 review fixes and the defect found while fixing them are accepted, each with a test that failed first. The stated limits stand: cross-scope sends tested by injection until S153, escalated sends denied, capabilities enforced in process until the sandbox.

**E8 goes on the owner's engine list.** Polyaxion's discharge check treats an escalation as a deny, so it refuses a scope whose only way to complete a mandate passes through a person's approval. The engine should count an escalation as a path that completes when approved. Until E8 lands, poly's refusal as `PL6001`, with its reason, is correct: it fails closed.

**B13 is deferred to M5b**, fixed with the embedded surface's policy form, with a test that fails first. It changes no meaning and the output is stable.

**Next: M5b**, steps 11 to 18 as ruled, after merging `main` into `m4`. S141 and S153 wait on E5 and are listed as waiting.

## M5b build steps (11 to 17): two corrections to the record

**No embedded policy form.** PT1.1a stands: policies live in `.policy.poly` files only. The M5a closing ruling's phrase "with the embedded surface's policy form" repeated a wording error from the M5a report and is withdrawn. B13 is fixed in the formatter alone (bbe7ad9), with a test that failed first.

**Confirmation tests.** PD5-A3 (numbers already printed by the evidence script) and PD5-A6, A7, A8 (Restore) and A12 (met by steps 11 and 12 with no new code) could not fail first. They are accepted as confirmation tests and are labelled so in the M5b record. Each still gets a seeded control that must fail: a mutant that breaks the property each one checks.

## S162 and closing M5b

**S162 accepted.** In a scope that requires attribution, the runtime refuses an outside dispatch of an effect's completion or of a timer's target before any step, with an audit row, as K9 and K10 refuse theirs. The gate's deny stays as the second line. Built with a test that fails first; PT8's limit is replaced by the rule.

**M5b closes** on `m4` when three things are in the record: S162 built; the seeded controls ruled in de66918 for PD5-A3, A6, A7, A8 (Restore) and A12, each shown to fail its test; and polywatch's findings on the M5b fixes resolved. The gate at 09a7042 (1,322 tests, 0 fail, one skipped for the sandbox gateway, four waiting on E1, E2 and E5) is accepted, rerun once after those changes. The stated limits stand: a configuration's completion input has no origin class, a child created in a cascade starts its own chain, the sandbox policy is generated but not enforced here, and `exec` stays enforced in process.

**M5 then closes.** Next is M6, planned from PT18's row and the M6 planning list in this file (a host-neutral core with thin host adapters).

## S163 The M3 run programs are outside the standing tests

**Ruled.** Merging `main` into `m4` (a71b412) brought the 1,130 programs the M3 arms wrote, 712 of them distinct, under `experiments/m3/runs/`. The standing test then checked 1,438 sources and did not finish in the gate. Those programs are frozen experiment evidence, written by the arms, not repository source, so they are outside the standing tests.

- `test/standing.test.mjs` names `experiments/m3/runs/` as its only exception, with that reason, and a test that failed first requires the list to be exactly that path and a `.poly` file anywhere else to stay covered.
- The slow program is recorded in `plan-m5.md` section 11 as an open checker performance finding for M6, not fixed in M5b.
- No separate job checks the run programs now. Checking the distinct ones outside the gate is optional and can come later.
- The issues of `plan-m6.md` are numbered from S164.

**The M3 account.** The m4 gate gives the same answer whatever state the owner's `~/.poly-m3/claude` is in: `test/m3-runner.test.mjs` loads the runner with a home folder the test creates, and `test/account-independence.test.mjs` runs every test file that loads the runner against a refused stand-in account and against none.

**The merge of `m4` into `main`** is ruled after the M5b report.

## Conclusion

M5 is split so that identity is built on a gate that is already closed. Polyaxion decides in process without being copied into poly, every decision carries a session sequence that replays, and no allow is acted on once the state it read has moved. Approvals are signed by keys the certificate binds.
