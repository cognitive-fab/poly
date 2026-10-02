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

## Conclusion

M5 is split so that identity is built on a gate that is already closed. Polyaxion decides in process without being copied into poly, every decision carries a session sequence that replays, and no allow is acted on once the state it read has moved. Approvals are signed by keys the certificate binds.
