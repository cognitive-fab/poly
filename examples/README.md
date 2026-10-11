# poly examples

The programs here show what poly checks and what it finds. Some are correct programs. Others are teaching variants: a program with one defect put in on purpose, kept so the checker's finding can be seen, or a field study whose exploration reaches a bound.

## The expected-verdict line

Every `.poly` file here begins with its expected verdict (V10 item 4, ruled 2026-10-10):

```
// expected: CLEAN | FINDING <code> [<code> …] | INCONCLUSIVE <reason>
```

- `CLEAN`: the check finds nothing, and every stage ran.
- `FINDING <code> …`: the check reports exactly these codes, the variant's defect.
- `INCONCLUSIVE <reason>`: the check stops short, for the reason given, and never reads `CLEAN`. A reason that begins with a code, such as `PL3901`, names a code the check must report.

`test/examples-expected.test.mjs` checks each file and compares its verdict with this line, and the V10 gate does the same. A reader can tell a teaching variant from a correct program by its first line, and so can the gate, with no list kept anywhere else. A new example states its line when it is added.

**A policy is part of its program's check.** A policy file, `<name>.policy.poly` beside `<name>.poly`, is never checked alone: the program and its policy are one project, and the check is the project's, with the policy signed as a person signs it. The expected line is the program's. A policy file carries no expected line, and the gate does not list it.

## The examples

- `hello/`: the README's turnstile, with its deadlock (`hello.poly`) and without it (`hello-empty.poly`).
- `checkout/`: PT7a's checkout, with the optimistic order that confirms two orders against one unit.
- `delivery/`: PT9.8's delivery worker, in order and in parallel, with the dedupe table kept or cleared on archive.
- `evidence/`: the outbox intent in its forms, checked against the review's evidence scripts.
- `field-studies/`: hatchet, raft and the turnstile of the polygraph field studies, each with its negative control.
- `oms/` and `orders/`: the order management machines.

## Glossary

- **Expected-verdict line:** the first line of an example, stating the verdict its check must give.
- **Project (of an example):** a program and the policy beside it, checked together.
- **Teaching variant:** an example with a defect put in on purpose, whose expected verdict is a finding.
- **Field study:** a machine taken from a real project's corpus, written in poly and checked against it.
- **Negative control:** a field study with one line changed, as the corpus's broken reference is; its expected line says what the check gives it.
