# poly examples

The programs here show what poly checks and what it finds. Some are correct programs. Others are teaching variants: a program with one defect put in on purpose, kept so the checker's finding can be seen, or a field study whose exploration reaches a bound.

## The expected-verdict line

Every `.poly` file here begins with its expected verdict (V10 item 4, ruled 2026-10-10):

```
// expected: CLEAN | FINDING <code> [<code> …] | REFUSED <code> [<code> …] | INCONCLUSIVE <reason>
```

- `CLEAN`: the check finds nothing, and every stage ran.
- `FINDING <code> …`: the check reports exactly these codes, the variant's defect.
- `REFUSED <code> …`: the type stage rejects the program with exactly these codes (an error, not a finding), the verdict is `REFUSED`, and there is no witness. Added with `claim-intake` for `PL1205`.
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

### The ten examples of the batch (`docs/examples/<name>.md` is each one's spec)

Each is a program and its policy, checked `CLEAN`, with host code in TypeScript against the generated types, a recorded provider (or recorded services, or a recorded device), a seeded defect in a copy with its policy beside it, a recorded end-to-end test whose journal replays, and a README. The findings below are the ones the defect copy gets, exactly.

| Example | What it shows | The key property | The seeded defect and its finding |
|---|---|---|---|
| [`appointment-booker/`](appointment-booker/README.md) | A typed date and time decision, an irreversible keyed calendar write | No slot is booked twice (step property `free-slot-only`) | The overlap check removed: `PL3002`, a witness of 6 steps |
| [`expense-approval/`](expense-approval/README.md) | A strict amount, verified claims, a payment a person approves above a threshold | The approver of a claim is never its submitter (invariant) | The same principal can approve: `PL3001`, 3 steps |
| [`incident-oncall/`](incident-oncall/README.md) | Liveness under fair timers, paging once, an unsure report sent to a person | A page is acknowledged or escalated (liveness `page-is-answered`) | An unbounded snooze starves the escalation: `PL3301`, a lasso of 9 steps |
| [`order-fulfilment/`](order-fulfilment/README.md) | A reserve, charge and ship saga with compensations, a configuration of orders and one stock | A cancelled order holds no stock and no charge; the stock is never oversold | The compensation after a failed shipment skipped: `PL3001`, 4 steps (the configuration stays `CLEAN`) |
| [`pr-reviewer/`](pr-reviewer/README.md) | A workflow mapping an agent's tools to effects, a policy and a budget per review and month | The program never merges (path property `never-merges`); the policy denies it | The merge made reachable: `PL4001`, 5 steps |
| [`support-drafts/`](support-drafts/README.md) | Customer messages and private notes at two audiences, drafts escalated to the owner | The notes never reach the external model (a `never` statement) | The notes sent to it, with the rule left out of the policy: `PL6503` and `PL7001`, 1 step each (`CLEAN` beside the program's own policy: the gate refuses it at run time) |
| [`claim-intake/`](claim-intake/README.md) | A calibrated, routed classification; a person below 0.8 and on a fraud flag | A claim is assigned by itself only on a calibrated confidence of at least 0.8 | A confidence added to a margin: `REFUSED`, `PL1205`, no witness; a confidence never compared: `PL3002` and `PL6201`, 2 steps each |
| [`research-agents/`](research-agents/README.md) | A planner and two workers checked together; answers that cite; one shared budget | Every worker that reports has cited (configuration invariant, 699 global states) | A worker that can guess: `PL5401`, 6 global steps |
| [`subscription-cancel/`](subscription-cancel/README.md) | Liveness that a request ends, an offer at most once, a keyed cancellation | A request to cancel always ends; the offer is made once | A decline that offers again: `PL3301`, a lasso of 5 steps, and `PL4001`, 3 steps |
| [`flash-controller/`](flash-controller/README.md) | A pure state machine: erase, program, verify, a retry limit | A block is never programmed unless it is erased (step property) | The erase check removed: `PL3002`, 2 steps |

The language problems the ten met, with their workarounds and proposed fixes, are in `docs/examples/language-findings.md`, and the proposals that came of them are in `docs/proposals/v2.0.md`.

## Conclusion

The examples show one thing from ten sides: the check finds the defect that sits in a comparison, a cycle or a missing line, and it names it with a path, whether the path is two steps (a missing erase check) or a lasso of nine (a snooze that starves an escalation). What it cannot find is what lies outside the program: whether a model is right, whether a service does what it said, whether a person who approves is the right person. Those are shown by the end-to-end tests on recorded traffic, and they are why each README says what is not checked. The edges of the check are themselves findings, and they are written down in `docs/examples/language-findings.md`: a stored range that is not cut at its thresholds, a decision whose inputs the check never follows, a policy whose scope matched nothing. Where one was a defect of the toolchain it is fixed under the rule (the policy scope, `PL6504`); where it is a gap in the language it is a proposal (`docs/proposals/v2.0.md`).

## Glossary

- **Expected-verdict line:** the first line of an example, stating the verdict its check must give.
- **Project (of an example):** a program and the policy beside it, checked together.
- **Teaching variant:** an example with a defect put in on purpose, whose expected verdict is a finding.
- **Recorded traffic:** the answers of a provider (a channel, a mail service, a payment service, a model) written down in advance, so that a test runs the whole program with nothing leaving the machine. The mail and the customers in it are made up.
- **Serial group:** the checks that run apart from the rest of the suite, one at a time, because each takes minutes and a large heap; the concierge's and the inbox's are in it.
- **Seeded defect:** the one change a defect copy makes to its program, so that the checker's finding, with its code and the length of its witness, can be seen and tested.
- **Witness:** the shortest sequence of steps that violates a property; a liveness witness is a lasso, a prefix and a cycle repeated for ever.
- **Refused:** the verdict of a program the type stage rejects (`REFUSED`); an error, not a finding, and it has no witness.
- **Recorded services / recorded device:** the answers of a service or a device written down in advance, as recorded traffic is for a provider.
- **Acceptance:** a person's signed record that a finding is accepted; a program with findings runs only with one for each (PT12.5).
- **Dry run:** the host started on recorded traffic, through the same steps as a live run, with no key of yours.
- **Read-only run:** the inbox host started without `--drafts`, so that no draft can be proposed.
- **At most once:** an irreversible effect that declares `retry { attempts 1 }`: the worker sends it once, and a lost answer ends the exchange with its failed or exhausted completion.
- **Idempotency key:** the intent id the runtime sends as a header on every write of an effect that declares `idempotent header`, so a provider that honours it (an assumption the check prints as K17, and does not prove) executes the request once.
- **Retry-safety rule:** an irreversible effect that may be attempted twice must be at most once, keyed, idempotent by nature in the standard library, or accepted by a person's signature at admission; otherwise the check reports `PL4003` with a witness.
- **Field study:** a machine taken from a real project's corpus, written in poly and checked against it.
- **Negative control:** a field study with one line changed, as the corpus's broken reference is; its expected line says what the check gives it.
