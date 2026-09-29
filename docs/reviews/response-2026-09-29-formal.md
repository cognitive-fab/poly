# Response to the formal review of draft v0.2

*Cognitive Fab · September 2026 · answers [`review-2026-09-29-formal.md`](review-2026-09-29-formal.md) · produces draft v0.3*

Every requested change was made. The main one is a new document, [`../04-semantics.md`](../04-semantics.md), which defines what a poly program means. The other documents now defer to it.

| # | Review item | Change in v0.3 | Where |
|---|---|---|---|
| 1 | There is no semantics; the lowering defines the language | 04-semantics defines machines, states, handlers as total functions, the labelled transition relation, behaviours, the checked instance, five kinds of property, fairness, composition, policies and replay. PA0.0 makes the semantics the definition. | 04 PS1 to PS11; 02 PA0.0 |
| 1b | Lowering correctness has no content | The lowering is correct for a program when its transition relation equals the semantics' relation on the checked instance, including verdicts, reasons, next states and intents. `poly-ref`, a reference interpreter written from 04 with no shared code, checks this on every `poly check` (`PL2501`, verdict `REFUSED`). | 04 PS9; 02 §4, §5 stage 1b; 01 PF7.8, AC8 |
| 2 | Is a rejected step a step? | Yes: a labelled stuttering step. The state holds only the declared fields. The verdict is in the label. Properties over labels see rejections; properties over states cannot. Terminal and strict-domain rejections are part of the relation. | 04 PS1.2, PS3.2, PS3.3 |
| 3 | "Invariant" names four kinds of object | There are five keywords with distinct meanings: `invariant` (states), `step property` (accepted steps), `reject property` (all steps), `path property` (prefix-closed, on emission paths) and `compose invariant` (joint states). Diagnostic names follow. | 04 PS5; 03 PT2, PT5, PT12.2; 01 PF2; README glossary |
| 4a | No liveness | `liveness n: eventually P under fair { … }` and `P leads to Q under fair { … }`. Fairness is weak fairness of named action groups, and is always stated. The check is the component test on the explored graph, with a lasso witness. Liveness claims about the runtime cite K5 and are listed as assumptions, not guarantees. | 04 PS5.5, PS6; 03 PT5, PT19; 01 G5, PF2.5 |
| 4b | No deadlock check | Deadlock freedom is checked for every machine, with no declaration needed (`PL3201`). | 04 PS5.6; 01 PF2.6 |
| 4c | `OutboxIntent` is stuck after three settle failures | `SettleFailed` now goes to `Dead` when `attempts` is 3, as `HandlerFailed` does. The machine declares `liveness settles: eventually terminal` under its fairness. AC9 requires that removing the fix yields a deadlock witness. | 03 PT9.7; 01 AC9 |
| 5 | No operator precedence | A nine-level precedence table, with `implies` loosest and right-associative. The formatter parenthesises any mix of `implies` with `&&` or `\|\|`. The `OutboxIntent` invariant is now printed `executed implies (decisions <= 1 \|\| approved)`. | 04 PS12; 03 PT2.2, PT9.7 |
| 6 | Unknown in `when` fails open | Full truth table for rule obligations. An unknown `when` yields `on unknown`, which defaults to `escalate` for deny rules. `skip` must be written and is listed in the certificate. In a scope with label-based rules, an unlabelled effect is refused at admission. | 04 PS8; 03 PT6.2, PT8.1, PT8.2; 01 PF4.2 |
| 7 | Gate replay depends on an unrecorded order | Every proposal and settle carries a session sequence number and the digest of the session state before it. A session replays in that order, and a run's gate decisions replay with the sessions it touched. K6 states the gate-function assumption. | 04 PS11, PS10 K6; 03 PT9.3; 02 §7.2; 01 PF8.6, AC6 |
| 8 | Composition rests on unstated kernel assumptions | K1 to K7 are numbered, with their evidence. Composition cites K1 to K3. Every verdict prints the assumptions it relies on. K5 (worker and timer fairness) has no proof and is stated as an operational requirement. | 04 PS10, PS7.4; 03 PT19 |
| 9 | `CLEAN` without its bounds | Every verdict is printed and certified with its checked instance: domains, bounds, state count and kernel assumptions. A `CLEAN` without an instance is not valid output. | 04 PS4.3; 03 PT12.3a; 01 PF7.9 |

## Evidence for item 4c

The v0.3 `OutboxIntent` machine was checked with a short, independent script, [`evidence/outbox_check.py`](evidence/outbox_check.py). It is a breadth-first exploration written directly from 04-semantics, not from poly-ref, which does not exist yet.

- **The v0.3 machine:**
  - 33 reachable states;
  - every invariant and step property holds;
  - no deadlock;
  - no fair non-terminal component, so `settles` holds under its stated fairness.
- **The v0.2 machine** (`SettleFailed` always returning to `Allowed`) has two deadlocked states, `(Allowed, attempts 3, decisions 1)` and `(Allowed, attempts 3, decisions 2, approved)`. Both are also liveness violations. This matches the review.

## A consequence the review implied but did not ask for

The checked instance lets the environment offer any action in any state, including a completion with no matching intent. v0.3 states this as an over-approximation (PS4.4): clean results are sound, and a witness that relies on such an input is marked `environment: unconstrained`.

## A change to a principle

PA0.1 said poly checks nothing itself. v0.3 adds one exception, stated in the principle and in the scope table. `poly-ref` performs the three checks no engine performs today: translation validation, deadlock freedom and liveness. If polygraph gains deadlock or liveness checks, poly defers to it.

## Conclusion

v0.3 answers the review's central point with a definition rather than more description. A poly program now means a deterministic, labelled transition relation over a stated finite instance. Every check is a statement about that relation, and the lowering is validated against it on every run. The bug the review found in the outbox model is fixed. The check that would have found it (deadlock) now runs on every machine, including that one.
