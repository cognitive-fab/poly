# Handoff prompt: plan poly, milestone M5

*Paste the text below into the Claude Code session in `C:\Users\jjdub\code\poly-m4`, after merging `main` into `m4` so the session has this file, the amended PT18 and the M4 closing ruling.*

---

M4 is closed (`docs/decisions-m4.md`, "M4 closed"). Your job is **milestone M5** of PT18: governance. Same worktree, same branch `m4`, same rules as M4. Plan first; build nothing before the plan is ruled.

## Read first, in this order

1. `CLAUDE.md`: the standing rules.
2. `docs/decisions-m4.md`: M4-0 and every ruling since, including what was moved to M5 (S118, S131, S134, S141, S142).
3. `docs/proposals/pd-model-decisions.md`: PD4 (operating modes) and PD4-A1 to PD4-A3; PD3-A2.
4. `docs/proposals/pd5-identity-lineage.md` (v0.2) with `docs/decisions-pd5.md` (S100 to S113). All of PD5 is M5 (S112).
5. `docs/04-semantics.md`: PS8.7 (cross-scope sends), PS10 (K1 to K11).
6. `docs/03-technical-spec.md`: PT6.5 (handler isolation, the OpenShell option), PT8.5, PT9.2, PT9.3, PT9.6, PT9.9, PT12.5, PT18 (M5's row, as amended).
7. `docs/plan-m4.md`, its closing section: what M4 left open.

## Write `docs/plan-m5.md`

- packages touched, and any new package;
- the order of work, with the gate (PT9.3) and person-key signatures (PT12.5) first, since PD4, PD5 and the escalation path rest on them;
- how each gate item is tested, with the test that fails first; the injected-outage test states which outages it injects and how "never fails open" is observed;
- **PD5's acceptance criteria**, proposed as PD5-A1 onward, one per mechanism ruled in S100 to S113;
- whether M5 should be split (for example M5a gate and signatures, M5b PD4 and PD5); propose it as an S-issue if so;
- engine changes needed, for the owner's list (E1 and E2 are already on it);
- the spec issues you find, continuing at **S144**.

Stop and show me the plan.

## The M5 gate (PT18)

- AC4. Gate latency and throughput reported (PT9.6).
- The gate never fails open under an injected outage.
- PD4-A1 to PD4-A3, PD3-A2, and PD5's criteria as ruled.
- Each carried item (S118, S134, S141, S142, PT6.5's sandbox) has its test.

## Rules that do not change

- No language model on any check path. Tests use recorded providers.
- No silent clean: a check that did not run is listed as not run.
- A regression test that fails first for every defect.
- Every artefact the runtime reads is checked.
- Engines are vendored, never forked.
- No private key is ever committed (S126); person keys in tests are generated per run.
- Commit as kizo-core on `m4`. Do not push. Do not merge `m4` into `main`.
