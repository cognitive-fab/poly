# Act 3: the program learns

This is the script of Act 3, about one minute. It shows the loop that found a real defect in a shipped example: mine a rule, check it, find the defect, fix it, and let a person promote the rule they meant. Everything on screen is a committed record, except one command. Every number in the timeline carries a tag `[R<n>]`, and each tag is a figure of `docs/demo/act3-figures.json` that `scripts/act3-check.mjs` checks against the record it cites (DAC12).

The mining corpus was a synthetic amplification. The screen says so.

## The timeline

| Time | On screen | What it shows |
|---|---|---|
| 0:00 | The recorded inbox run: 25 episodes [R1] and one draft instance [R2]. `poly mine` proposes nothing [R3] on it. | Thin evidence is reported as thin. |
| 0:10 | The to-do episode that reaches the draft, copied twelve times [R4] under fresh tokens: 37 episodes [R5], labelled `synthetic`. | The amplification, and its label in the candidates and in the certificate. |
| 0:20 | The candidate `count("gmail.createDraft") <= 1`, mined from 13 of 13 runs [R6] of the `synthetic` corpus, promoted into the `Todo` machine. | A rule that every observed run follows. |
| 0:30 | The checker answers `PL4001`: `count("gmail.createDraft")` reaches 2 [R7]. The witness has ten steps [R8]: a draft is posted, the answer is lost, the draft is posted again. | The rule was refuted. The witness was a real defect in a shipped example, recorded as IT4.4 [R9]. |
| 0:45 | The fix as it was made: `retry { attempts 1 }` [R10] and `exhausted -> DraftUncertain()` [R11]. A person promotes the rule they meant, `draft-created-once` [R12], with the verdict real and the reason too strong as written [R13]. | The loop: mine, refute, adjudicate, promote. |
| 0:55 | Live: `poly check examples/retry/draft-unguarded.poly` prints `PL4003` [R14]. The delivery part reads Propose, GateAllow, Start (target may execute), HandlerFailed, Start (target may execute), HandlerOk, SettleOk [R17], with executions of the target: 2 [R15], because the default retry is attempts 5 [R16]. | The defect that took a mined rule to find is now found by the check, with no corpus. |

## What each figure is, and where it comes from

The recorded inbox run, the mining, the promotions and the `PL4001` witness are not run on stage. `test/after/ex-inbox-loop.test.mjs` reproduces them, and the full suite runs it. The only live figures are R14 to R17, from the one command at 0:55, which takes about a second.

- R1, R2, R3: `docs/decisions-m7.md`, the inbox leg of M7: the recorded run proposes nothing.
- R4, R5: `docs/decisions-m7.md` and the copies in `test/after/ex-inbox-loop.test.mjs` (`Array.from({ length: 12 }`).
- R6: `docs/decisions-m7.md` and the support asserted in `test/after/ex-inbox-loop.test.mjs` (`{ holds: 13, of: 13 }`).
- R7, R8, R9: `docs/decisions-m7.md`, the inbox witness and the defect that it showed.
- R10, R11: `examples/inbox/inbox.poly`, the fix in the shipped example.
- R12, R13: `test/after/ex-inbox-loop.test.mjs`, the refinement that a person promotes.
- R14 to R17: the live output of the check of `examples/retry/draft-unguarded.poly`.

## What Act 3 proves, and what it does not

The loop exists and found a real defect, as `docs/decisions-m7.md` records. It does not prove that mining works on a recorded run: on the recorded run it proposed nothing. It does not prove that mining works on anything but this synthetic amplification.

What a mined rule can still find is what a person did not think to state. The check now finds this class of defect with no corpus.

## Conclusion

Act 3 shows a loop with a result. A rule that every observed run followed turned out to be false, and its witness was a defect in a shipped example. The fix is one declared line and one declared outcome. The check now finds the same class of defect from the declaration alone. Every number on screen is a figure with a record, and `scripts/act3-check.mjs` reproduces it, or the number is removed.

## Glossary

- **Corpus:** the set of recorded runs that `poly mine` reads. Here it is synthetic.
- **Synthetic:** made for the purpose by copying a recorded episode under fresh tokens. It is labelled so in every candidate and in the certificate.
- **Candidate:** a rule that every observed run follows, proposed by `poly mine`.
- **Promotion:** a person's signed decision to put a candidate into the program. A rule from a synthetic corpus is promoted only in a test certificate.
- **Witness:** the steps, listed by the checker, by which a rule or a property is broken.
- **`PL4001`:** a path property is violated.
- **`PL4003`:** an irreversible effect may be retried with no guarantee that the target runs it once.
- **Figure:** a number or a string of Act 3 that has a tag and a record.
