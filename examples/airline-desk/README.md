# The airline desk

A small customer-service program in the style of an airline task: a booking is changed after the customer confirms the change, a booking is cancelled with a reason, and a compensation certificate is issued, which a person approves when it is large. It was written for the risk report (PT34.5, S586) and copies nothing from any other study. Nothing here is a real customer's, no model is called, and nothing leaves the machine.

## What it does

- **A change waits for the customer's confirmation.** `Booking` emits `airline.change` when it is asked, confirmed or not, and the rule `change-confirmed` refuses a change the customer did not confirm.
- **A cancellation needs a checked customer and a reason.** `Cancel(r)` is a customer's step, with the claims the desk's verifier asserts. The rule `cancel-requested` refuses a cancellation by a customer the verifier did not check, or with no reason.
- **A disruption is decided on unknown input.** The airline cancels a booking for a disruption with `Disrupt`, a step of its own that carries no customer's claims. The cancellation rule reads the claims, so its condition is unknown, and its `on unknown deny` decides (PS8.2). This is the rule the report shows reaching its `on unknown` branch at run time. It reads the emitting step's claims, which a step of the program's own does not have; it does not depend on reading another machine's state.
- **A large certificate waits for a person.** `Compensation` emits `airline.certificate`, and the rule `large-certificate-reviewed` sends a large one to a person, who approves it with a signed record (PT12.5) or lets it time out.

## The tags

Each rule says which AI risk it answers and which control it implements (PT8.6):

| Rule | Mitigates | Implements |
|---|---|---|
| `change-confirmed` | `mit:5.2` Loss of human agency and autonomy | `nist:MAP-3.5` human oversight |
| `cancel-requested` | `mit:4.3` Fraud, scams, and targeted manipulation; `mit:7.3` Lack of capability or robustness | `iso:A.9.4` use within what was intended |
| `large-certificate-reviewed` | `mit:7.3` Lack of capability or robustness | `iso:A.9.2`, `nist:MAP-3.5` |

`poly.json` declares the project's exposure, `mit:2.1`, `mit:4.3`, `mit:5.2` and `mit:7.3`. No rule names `mit:2.1`, so the check warns `uncovered: mit:2.1` and the report lists it under *Exposed and not covered*. The tags decide nothing (PS8.10): the policy without them makes the same decisions.

## The report

`docs/examples/risk-report/airline-desk/` keeps a store the runtime wrote over a scripted day, with its certificate, its build and the public keys that verify it, and the report made from them, `report.md` and `report.json`. `node scripts/risk-report-examples.mjs` made them; the store is kept, not made again, since its key is random by design. The report regenerates byte for byte from the kept store:

```sh
node packages/poly-check/dist/src/cli.js report risks --db docs/examples/risk-report/airline-desk/store.db --build docs/examples/risk-report/airline-desk/build --certificate docs/examples/risk-report/airline-desk/certificate.json --trust <ledger key id>=docs/examples/risk-report/airline-desk/ledger.pub.pem --trust <admission key id>=docs/examples/risk-report/airline-desk/admission.pub.pem
```

The key ids are in `trust.json` beside the store.

## Conclusion

The airline desk is three rules, each tagged with the risk it answers, and a scripted day that exercises each: a refusal, a decision on unknown input, a certificate a person approved and one that timed out. The report counts what each rule did and says, in its first line, that the counts are evidence the rules were applied, not proof that a risk was reduced.

## Glossary

- **Exposure:** the risks a project lists in `poly.json` as the ones it considers itself exposed to.
- **On unknown input:** a rule whose condition could not be evaluated, here because a step had no customer's claims; its `on unknown` clause decides.
- **Tag:** a string `"<catalog>:<id>"` after an item's text, naming a risk it mitigates or a control it implements.
