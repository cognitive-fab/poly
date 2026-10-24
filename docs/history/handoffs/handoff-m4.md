# Handoff prompt: build poly, milestone M4

*Create the worktree first (step 0 below), then paste the text into a new Claude Code session started in `C:\Users\jjdub\code\poly-m4`. Keep the M3 session in `C:\Users\jjdub\code\poly` for M3 only.*

---

M0 to M2 are closed. M3 is prepared and frozen; its runs happen in the other tree and are not yours. Your job in this session is **milestone M4** of PT18: the runtime. Nothing beyond it. M5 comes after M4 closes.

## 0. Where you work (M4-0)

- From `C:\Users\jjdub\code\poly`, run: `git worktree add ../poly-m4 -b m4`. Then work only in `C:\Users\jjdub\code\poly-m4`.
- Never edit `C:\Users\jjdub\code\poly`. Its `packages/`, `vendor/` and `experiments/m3/` are frozen (S100, S114).
- Do not merge `m4` into `main`. The owner merges after M3's runs.
- First commit on `m4`: a test that fails if the current directory is the experiment's tree, used by every M4 script that writes files.

## Read first, in this order

1. `CLAUDE.md`: the standing rules.
2. `docs/history/decisions-m4.md` (M4-0), then `docs/history/decisions-m3.md` from S100 on, and `docs/history/decisions-pd5.md` (S101 and S113 are part of M4).
3. `docs/proposals/pd-model-decisions.md`: PD2 (decision provenance, the `decision` event, K10) and PD3 (model independence, calibration maps). Both are in M4. PD4 is M5; do not build toward it.
4. `docs/04-semantics.md`: PS3.2 (with the reserved reasons), PS9 and PS9.1a, PS10 (kernel assumptions K1 to K9; K10 enters with PD2), PS14 (delivery).
5. `docs/03-technical-spec.md`:
   - PT9.7 (the outbox intent machine) and PT9.8 (the delivery machine);
   - PT12.3 (vacuous verdicts);
   - PT14 and PT15 (command surface, host runtime API, certificate verification at load);
   - PT16 (the ledger: chain per run, signed heads, anchors, replay);
   - PT18, M4's row.
6. `docs/history/plan-m2.md` and `docs/history/plan-m3.md`, their closing sections: what was left for M4.

Then write `docs/history/plan-m4.md`:

- packages touched, and any new package (`poly-runtime`);
- the order of work;
- how each gate item is tested, with the test that fails first;
- engine changes needed, for the owner's list;
- the spec issues you find, continuing at **S118**.

Stop and show me the plan. Build nothing before it is ruled.

## M4 scope

1. **`poly-runtime`.** The polyrun host: load a module, check its certificate at load and refuse a tampered artefact, dispatch, run effects through the outbox, timers.
2. **The ledger** (PT16): a hash chain per run, signed heads, the periodic anchor off the step path, `step` and `advice` events.
3. **Journal verify and replay**: replay reproduces every post-state and every gate decision.
4. **The outbox intent machine** (PT9.7), checked, and the worker conforming to it by trace replay. Adding a worker state without changing the machine first is `PL2401` in the runtime's CI.
5. **Delivery** (PT9.8): runtime delivery traces replay against the `Delivery` machine, including traces captured across an archive.
6. **K9**: an external dispatch of an action wired as a child completion is refused.
7. **PD2 and PD3**: the `decision` event written by the runtime with the completion step, K10, outcome links, calibration maps and the model-swap rule.
8. **The two rules frozen out of M3**: `PL1207 RESERVED_REJECT_REASON` (S101) and vacuous properties reported `INCONCLUSIVE` with reason `vacuous` (S113).

## The M4 gate (PT18, all must pass)

- **M4a.** Journal replay reproduces every post-state and gate decision (AC6); a tampered artefact is refused at load.
- **M4b.** `OutboxIntent` is clean for its invariants and step properties, deadlock-free, and satisfies `settles` under its stated fairness; the worker conforms to it by trace replay.
- **M4c.** Delivery traces replay against `Delivery` (K8), including across an archive.
- **M4d.** External dispatch of a child completion is refused (K9, S45, S80).
- **M4e.** PD2-A1 to PD2-A4 and PD3-A1 to PD3-A3.
- **M4f.** `PL1207` and `vacuous` enforced; the conformance sources and M3's references re-checked under both rules.

## Rules that do not change

- No language model on any check path. Tests use recorded providers.
- No silent clean: a check that did not run is listed as not run.
- A regression test that fails first for every defect.
- Every artefact the runtime reads is checked, by translation validation or by reading it back against the source.
- Engines are vendored, never forked.
- `PL2501` and `PL2001` are for toolchain faults only.
- Commit as kizo-core on `m4`. Do not push.
