# Handoff prompt: build poly, milestone M1

*Paste the text below into Claude Code, started in `C:\Users\jjdub\code\poly`.*

---

M0 is closed (see `docs/plan-m0.md`). Your job in this session is **milestone M1** of PT18: effects, composition and configurations. Nothing beyond it.

## Read first, in this order

1. `CLAUDE.md`: the standing rules. They have not changed.
2. `docs/decisions-m1.md`: the six rulings made before M1. They settle S7, the liveness question and the manifest.
3. `docs/04-semantics.md`, especially:
   - PS9.2 (translation validation compares the effect sequence);
   - PS13 and PS14 (configurations, message identities, oldest-copy delivery, the delivery guarantee);
   - PS7 (children) and PS8.7 (sends across trust scopes).
4. `docs/03-technical-spec.md`:
   - PT1.2 (the manifest);
   - PT6 (effects, labels, timers, children);
   - PT7 and PT7a (composition and configurations);
   - PT9.8 (the `Delivery` machine) and PT9.9;
   - PT12.2 (the `PL5xxx` codes);
   - PT18 (M1's gate, as amended).
5. `docs/plan-m0.md` §3.4 and §12: how the explorer was designed for configurations, and what M0 left for M1.
6. `docs/reviews/evidence/config_check.py` and `delivery_check.py`: their outputs are acceptance tests.
7. `polygraph/polyrun/src/kernel.mjs`, `check-effects.mjs` and `check-product.mjs`: how the runtime and its checks consume a step's classification and effects.

Then add an M1 plan to a new `docs/plan-m1.md`: packages touched, the order of work, and how each gate item is tested. Stop and show me the plan.

## The engine change comes first (decision M1-1)

- In `C:\Users\jjdub\code\sam\sam-lib`, add the `unchanged` classification: a step with no rejection, no mutation and no write, whose acceptor declared `unchanged(...)`, is accepted. An empty frame stays `unhandled`.
- Add tests there for all three cases. Bump the version to 2.3.0. Commit in that repository as `kizo-core`. Do not publish and do not push: I release it. Use it from poly through `npm link` until then.
- In polygraph, add a polyrun test that an `unchanged` step is journaled as accepted and derives its effects. If polyrun needs a code change for that, stop and tell me what and why before making it.

## M1 scope (PT18)

1. **Manifest (M1-6).** `poly.json` as PT1.2 states it. `poly check` takes a file or a project directory.
2. **Liveness as not run (M1-2).** Liveness properties are accepted, listed as not run, and fold the verdict to `INCONCLUSIVE` at best. The three `OutboxIntent` examples now get their safety results from `poly check`.
3. **Generated initial-value test (M1-4).** One value inside and one outside the type, for every initial-value shape.
4. **Effects.**
   - Covers `emit`, effect declarations and labels (PT6.1, PT6.2), lowered to `effects.cjs`, `effects.manifest.json` and `effect-invariants.mjs`.
   - Emission invariants.
   - Translation validation now compares the effect sequence of every transition. Add a lowering that drops an effect and one that reorders two effects to the explicit list of deliberately broken lowerings.
5. **Timers and attached children.**
   - Timers: `after` and `cancel`, with `PL2301`.
   - Attached children: `spawn` and `signal`, with compose invariants lowered to `invariants.compose.mjs`, `PL5101` and `PL5201`.
6. **Configurations.**
   - Language: `Ref<M>`, `send`, `spawn detached`, and the `SendDenied` message of PS8.7.
   - Explorer: a second implementation of the explorer interface over `(σ, μ)`, covering:
     - message identities;
     - the multiset of messages in transit with oldest-copy delivery (PS13.2a);
     - transit and instance bounds (`PL5301`, `PL5302`) through the existing `boundHits` path;
     - configuration invariants (`PL5401`);
     - stuck quiescent states (`PL5402`).
   - Group quantifiers: `forall`, `exists`, `count`, `sum`, `all`, `any`, with `PL5403` and `init(e)`.
7. **What M0 refused at lowering:** maps of unions with payloads, nested payload unions and union parameters.

## The M1 gate (all must pass)

- **AC1.** Copy the `polyrun-oms` order machine (`polygraph/examples/polyrun-oms/machines/order`) with its traces into `conformance/field-studies/order/`, with its provenance. Written in poly, it must:
  - replay its trace corpus at 100%;
  - give the same `check-effects` and `check-product` results as the hand-written artefacts.

  Use polyrun's own checks for this, not a reimplementation.
- **AC10 and the checkout evidence.** With the optimistic order, the `checkout` configuration of PT7a reports `PL5401` with the six-step witness of PT7a. With the order waiting for `Taken`, it is clean over 44 global states, with no stuck state. Both results use PT7a's bounds.
- **The `Delivery` machine of PT9.8, safety only (M1-3).**

  | Variant | Expected result |
  |---|---|
  | In-order worker, dedupe kept | 1,147 states; `at-most-once` and `in-order` hold |
  | Parallel worker, dedupe kept | 2,368 states; `at-most-once` holds |
  | Parallel worker, `in-order` required | violated with the witness `Emit(M1), Emit(M2), Send(M2), DeliverReq(M2)` |
  | In-order worker, dedupe cleared on archive | `at-most-once` violated with the 10-step witness that `delivery_check.py` prints |

  `exactly-once` is listed as not run.
- **Translation validation.** It agrees on the post-state and the effect sequence of every transition of every conformance case. Every broken lowering in the explicit list, including the two new effect ones, is caught with `PL2501`.
- **Strict validation.** Every lowered `next.cjs` passes strict `validate()` under sam-pattern 2.3.0. No emit-only step classifies as `unhandled`.
- **No regressions.** Every M0 gate number is unchanged:
  - the field-study windows;
  - the evidence results;
  - the 50 sources reaching no toolchain code.

## Constraints

Everything in the M0 handoff still holds, in particular:

- **Stack:** the same.
- **Import boundary:** poly-ref imports nothing from `poly-lang` or `poly-lower`. The configuration explorer is written from 04-semantics.
- **Engines are dependencies.** The sam-pattern change above is the only one approved. Any other engine change: stop and tell me.
- **Spec issues.** Continue the series at S23 in `docs/plan-m1.md`. Ask before changing a spec file.
- **Disagreements.** If poly-ref disagrees with an evidence script, investigate until one side is shown wrong, then tell me which side and why before changing either.
- **Regression tests.** Every defect found gets a regression test that fails first, as in the M0 review.
- **Commits.** One per coherent step, house style, as `kizo-core`. Do not push.

## Done means

- The M1 gate passes in one command: `npm test` at the root.
- `docs/plan-m1.md` records:
  - what was built;
  - every spec issue and its resolution;
  - the measured numbers (states, transitions, times) for each gate item.
- **Stop for a code review before closing.** Tell me the commit range.
- A short summary: what passed, what surprised you, and what M2 will need.

## Conclusion

M1 turns poly from a language for single machines into one for machines that talk to each other. The engine gets the one classification it was missing. The configuration explorer is the heart of the milestone. Its targets are already measured by independent scripts, so every number it produces can be checked.
