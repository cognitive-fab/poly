# Decisions: v2.0 proposal 28 (extensions)

*Cognitive Fab · 2026-10-31 · the owner's rulings on `docs/proposals/extensions.md` · on branch `proposal-extensions`, cut from main at v1.5.0 (076f9539) · nothing is built yet*

## S584: a worker in poly-runtime, for extension leaves

**Granted,** as the second ruling of S507's kind. `scripts/check-boundaries.mjs` lists `node:worker_threads` among the process modules, and only poly-new may import one (rule 2, review finding P8). S584 lets one file of poly-runtime, `packages/poly-runtime/src/extensions/host.ts`, start a worker for extension leaves, on the six conditions of section 7 of the proposal:

1. **One place.** Only `host.ts` imports `node:worker_threads`, and it starts a `Worker` only with the bootstrap's file as its entry, `eval` false, `env: {}` and `execArgv: []`.
2. **The bootstrap imports nothing else.** `sandbox.ts` imports `node:worker_threads` and `node:module`, and names no network module and no process module.
3. **No check package starts or names a worker,** and none imports `@poly/runtime/extensions`. No check runs a leaf.
4. **No network in poly-runtime.** A capability's requests are sent by poly-io over the port (S182).
5. **No model call.** No grant's provider profile, std's or the extension's own, may be a model provider, and a leaf's files are linted for model SDKs at admission.
6. **The pin before each start.** The extension's files are compared with the pin before a worker starts, and a mismatch starts nothing.

Each condition is held by the boundary script, as its rule 8 citing S584, or by `test/extension-sandbox.test.mjs` over the escape corpus. The ruling covers Cognitive Fab's own extensions: an extension by another publisher needs WebAssembly isolation first (D14). Rule 8 and its test land with the first build step of proposal 28, not before.

**The number.** S584 is the next free number: the last issued is S583 (`decisions-demo.md`, S572 to S583), and no local branch uses a higher one.

## The owner's other rulings of the same day

| Id | Ruling | Proposal section |
|---|---|---|
| D9 | A pin carries a record signed by `poly admit` with the admission key, verified at load. No person's record of a new kind. | 11.2 |
| D10 | Node 22.15 or later is required. | 6.3 |
| D11 | An extension may carry a provider profile, declared in its manifest's grants. | 3.3 |
| D12 | Mail read with a static AWS key is owned by the principal `poly.json` names for that key. | 4.3, 5.4, 13.1 |
| D13 | A Message-ID is an identity for de-duplication only, never for authority; a hash of sender, date and subject when it is missing. | 10 |
| D14 | Opening extension authorship beyond Cognitive Fab requires WebAssembly isolation. | 6.6, 11.2 |
| D15 | An `Instant` may be carried in a payload, as a typed `Instant` in UTC; the runtime rejects anything that does not parse. | 9.2 |
| D16 | A fresh worker per extension version, recycled after any error or uncaught exception; an extension may keep no state between calls. | 3.2, 6.1, 6.6, 11.4 |
| D17 | A base parameter of a profile takes only the values the manifest lists; `poly admit` shows them, so none changes without a new pin. | 3.3, 11.3 |

One part of one question stays open: whether S458's cut-point reduction extends to instants compared with each other (section 15.2).

## Conclusion

S584 lets poly-runtime start a worker for extension leaves on six conditions that the boundary script and a test will hold, and only for Cognitive Fab's own extensions. The other rulings fix the contract around it: what is pinned and who signs the pin, which Node runs it, what a grant may reach, who owns what a leaf reads, what an identity may decide, how a date travels, and how long a worker lives. Nothing runs under them until proposal 28 is ordered for a release.
