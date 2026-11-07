# The risk report's kept examples

Each folder here keeps what `poly report risks` reads for one example (PT34.5, S586), and the report made from it:

- `store.db`: the store the runtime wrote over a scripted day, with a fixed clock, on a store file with a ledger signer, every head signed and an anchor published;
- `certificate.json`: the certificate the runs were admitted under, of the tagged policy signed by a person;
- `build/policies/`: the policy documents of the build the certificate certifies, the only files of the build the report reads, each checked by its certified digest;
- `ledger.pub.pem` and `admission.pub.pem`: the public keys that verify the store and the certificate, named by key id in `trust.json`;
- `report.md` and `report.json`: the report, in its two formats.

| Folder | Example | What its report shows |
|---|---|---|
| `concierge/` | `examples/concierge`, AC27's day on recorded traffic | a refund sent to a person and approved, allows per scope, and an exposed risk no rule names |
| `airline-desk/` | `examples/airline-desk`, written for these docs | a refusal, a decision on unknown input, certificates approved, timed out and left open, and outcomes possibly executed and unknown |
| `pii-guard/` | `examples/pii-guard`, the program and its seeded defect on one store (S587, A5) | the defect's early mail refused under `mit:2.1`, the program's new recipients sent to a person (approved, timed out, open) under the rules that name no risk, and `mit:2.2` exposed and not covered |

`pii-guard/` keeps two certificates, `certificate.json` for the program and `certificate-defect.json` for the defect, admitted once its finding was accepted, and the report is made with both. Its bodies and addresses were erased before the store was kept (S205), so it holds their digests only.

`scripts/risk-report-examples.mjs` made them. A store is kept, not made again: its key is random by design, so each run of the script would change every recipient digest and every signature. `test/s586-examples.test.mjs` regenerates the first two reports from their kept stores and requires the same bytes, and `test/pii-guard-risk-report.test.mjs` does the same for `pii-guard/`, with both certificates.

To read a report again, from the repository's root (the key ids are in each folder's `trust.json`):

```sh
node packages/poly-check/dist/src/cli.js report risks --db docs/examples/risk-report/airline-desk/store.db --build docs/examples/risk-report/airline-desk/build --certificate docs/examples/risk-report/airline-desk/certificate.json --trust <ledger key id>=docs/examples/risk-report/airline-desk/ledger.pub.pem --trust <admission key id>=docs/examples/risk-report/airline-desk/admission.pub.pem --format md
```

## Conclusion

The three folders hold everything the report needs and no private key. No store holds a body or an address: the airline desk's stored none, and the concierge's and the pii-guard store erased their own (S205) and were vacuumed, so not even a deleted page keeps one (PT34). One trace of an address is left in the concierge's journal: the Slack post's provider id, which Slack builds from the staff channel's id and a timestamp, is a record of the effect, not a body, and nothing marks it erasable. The report made from them says, in its first line, that its counts are evidence the rules were applied to the decisions recorded, not proof that a risk was reduced.

## Glossary

- **Kept store:** a store committed with the docs, so a report can be regenerated from it byte for byte.
- **Trust file:** `trust.json`, each key id the report is given with `--trust`, and the file of its public key.
