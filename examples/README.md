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
- `oms/` and `orders/`: the order management machines. `orders/` is a teaching variant: its expected verdict is `FINDING PL3102 PL4001 PL4002 PL4003`, the last being `charge`, an irreversible effect on 3 attempts with no guarantee (PS23.5), which it keeps on purpose.
- `concierge/`: a small business's customer assistant on WhatsApp and Slack, with refunds through a Stripe grant that a person approves above 100; checked `CLEAN` with its policy and run end to end on recorded traffic (`concierge/README.md`); its refund is keyed and its sends are attempted once, which the retry-safety rule checks.
- `retry/`: the retry-safety rule (PS23, PT33) in four small programs, each checked in well under a second. `refund-unguarded.poly` is the concierge's refund on the default retry: expected `FINDING PL4003`, with a witness that shows the target executing twice. `refund-at-most-once.poly` (`retry { attempts 1 }`) and `refund-keyed.poly` (`idempotent header "Idempotency-Key" window 24h`) are the same refund fixed in the two ways the author may choose: both expected `CLEAN`. `draft-unguarded.poly` is the inbox's draft before its fix: expected `FINDING PL4003`. `poly witness <id> --test` writes a test for the finding that fails on the unguarded program and passes on both fixes.
- `inbox/`: the owner's daily Gmail assistant, which triages mail, keeps one to-do per thread and prepares drafts the owner approves; checked `CLEAN` with its policy, with steps to run it on your own mailboxes (`inbox/README.md`).
- `appointment-booker/`: a typed date and time decision, an irreversible keyed calendar write and a property against double-booking; checked `CLEAN`, with the overlap check removed in `appointment-booker-defect.poly` (`PL3002`, 6-step witness).

## Glossary

- **Expected-verdict line:** the first line of an example, stating the verdict its check must give.
- **Project (of an example):** a program and the policy beside it, checked together.
- **Teaching variant:** an example with a defect put in on purpose, whose expected verdict is a finding.
- **Recorded traffic:** the answers of a provider (a channel, a mail service, a payment service, a model) written down in advance, so that a test runs the whole program with nothing leaving the machine. The mail and the customers in it are made up.
- **Serial group:** the checks that run apart from the rest of the suite, one at a time, because each takes minutes and a large heap; the concierge's are in it.
- **Dry run:** the host started on recorded traffic, through the same steps as a live run, with no key of yours.
- **Read-only run:** the inbox host started without `--drafts`, so that no draft can be proposed.
- **At most once:** an irreversible effect that declares `retry { attempts 1 }`: the worker sends it once, and a lost answer ends the exchange with its failed or exhausted completion.
- **Idempotency key:** the intent id the runtime sends as a header on every write of an effect that declares `idempotent header`, so a provider that honours it (an assumption the check prints as K17, and does not prove) executes the request once.
- **Retry-safety rule:** an irreversible effect that may be attempted twice must be at most once, keyed, idempotent by nature in the standard library, or accepted by a person's signature at admission; otherwise the check reports `PL4003` with a witness.
- **Field study:** a machine taken from a real project's corpus, written in poly and checked against it.
- **Negative control:** a field study with one line changed, as the corpus's broken reference is; its expected line says what the check gives it.
