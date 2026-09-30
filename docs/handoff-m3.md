# Handoff prompt: prepare milestone M3, the first experiment

*Paste the text below into Claude Code, started in `C:\Users\jjdub\code\poly`.*

---

M2 is closed. Milestone M3 is the experiment of PT13, and everything after M3 depends on its result. This session **prepares** it: prerequisites, tasks, oracles, runner and analysis, all frozen by digest. **No arm runs in this session.** You stop when the frozen set is ready for my approval.

## Read first, in this order

1. `CLAUDE.md`.
2. `docs/decisions-m3.md`: five rulings (M3-1 to M3-5) that amend PT13.
3. `docs/03-technical-spec.md`, PT13 in full, and PT18's M3 row.
4. `docs/plan-m2.md`, the closing summary: what M3 needs that M2 does not provide.
5. The three field studies in `conformance/field-studies/` and the OMS order: the task families are modelled on them.

Then write `docs/plan-m3.md` (the order of work, how each control is run, and the spec issues you find, continuing at S87). Stop and show me the plan.

## Scope, in this order

1. **Prerequisites.**
   - **The polyrun change (M3-2)**, in `C:\Users\jjdub\code\polygraph`, approved:
     - the `sendTo` intent;
     - `self` and child addresses resolved at commit (S58, S78);
     - the K9 refusal of an outside dispatch of a child's completion (S80).

     Include tests in polygraph, commit as `kizo-core`, bump the patch version, and do not publish or push. Then re-vendor into `vendor/polygraph` with its provenance, and show that every multi-machine conformance case now runs under polyrun as well as under poly-ref.
   - **Embedded fixes (M3-3):** the six fixes of S70 on embedded modules, with the random-order test over both surfaces.
   - **The host adapter (M3-4):** generated per task, over polyrun's kernel.
2. **The task set.** Ten tasks, from PT13's three families, at least three of them multi-machine. Each task has:
   - a brief;
   - a host interface (a small TypeScript API);
   - a reference machine in poly;
   - O2 hidden invariants;
   - O3 reference traces;
   - three evolution changes.

   State in the plan whether any task uses detached children, because `createInstance` is built only if one does.
3. **O1, from an independent session (M3-1).** Write `docs/m3/o1-prompt.md`: the prompt an independent session gets, together with the briefs and host interfaces. The session gets nothing else.
   - **Do not write O1 yourself.** I will run that session and commit its output under `experiments/m3/o1/`.
   - Your part is the controls on its output: each O1 suite passes on the reference implementation and fails on a mutated one.
4. **Controls (PT13).**
   - Each reference machine replays its own corpus at 100%, and a mutated reference fails.
   - A task whose controls fail is removed before any arm is scored. Record which tasks were removed, and why.
5. **The runner.**
   - It runs one arm on one task with a given model, token budget and wall-time limit, through the Claude Agent SDK or the `claude` CLI in headless mode.
   - Each run gets its own clean workspace.
   - It records the full journal: prompts, tool calls, tokens, time and the delivered code.
   - The four arms get the same prompt skeleton. They differ only in the language instructions and the tools available (polygraph for arm 2, the poly CLI for arms 3 and 4).
   - Build it and test it on one task with a small budget in a dry-run mode that uses a recorded or stub agent. **Do not spend on real runs.**
6. **The analysis script.**
   - It computes PT13's measures and the fixed tests (Wilcoxon signed-rank, Holm-corrected, the win, surface and stop rules) from run records.
   - Test it on synthetic records whose answer is known.
7. **The freeze (M3-5).** Commit everything and record in `docs/plan-m3.md` the digest of each part:
   - briefs, host interfaces, reference machines, O2, O3 and the O1 prompt;
   - controls, runner, prompts and analysis;
   - a proposed per-run token budget and wall-time limit, with the estimated total cost of 200 runs plus the evolution changes.

   Then stop.

## Constraints

- **Everything in the earlier handoffs holds:** standing rules, regression tests that fail first, `kizo-core` commits, nothing pushed.
- **Engine changes:** only the polyrun change of M3-2 is approved; any other one waits for me.
- **Nothing sees an answer it shouldn't.** A task brief must not reveal its reference machine, and no arm's prompt may contain O1, O2 or O3.
- **No real agent runs, and no spending,** until I approve the freeze and the budget.

## Done means

- Every prerequisite passes its tests, and `npm test` passes.
- The ten tasks (or fewer, if controls removed some, each with its reason) are frozen with their digests.
- The O1 prompt is ready for me to run.
- The runner and the analysis pass their dry-run and synthetic tests.
- `docs/plan-m3.md` has the proposed budget and total cost.
- You have stopped for my approval.

## Conclusion

M3 answers whether an agent writing poly ships fewer escaped defects than the same agent writing TypeScript, and which surface it should write. This session makes that answer trustworthy before a single run: equal tooling in the poly arms, multi-machine tasks that really run, a primary oracle written without seeing any answer, and a design frozen by digest.
