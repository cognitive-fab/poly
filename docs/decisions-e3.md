# poly · Decisions for E3, the checked harness

Steps, results and rulings of the branch `e3` (the harness example of `proposals/example-harness.md`), in the order they happen. Each entry names who ruled.

## plan-e3 ruled (owner, 2026-10-11)

The plan (`plan-e3.md`, 62c7d7e3) is accepted. Rulings:

- **Q-E3-1, ruled yes.** One bounded live run (E3.9), reported as a result and not as a test. The cap is $25, enforced by poly's own budget. The owner sets the key. In the suite, cost and stage statistics run on recordings.
- **Q-E3-2, as recommended.** The poly harness owns the loop and reaches tools over MCP as a client. The base is the same harness with the four mechanisms switched off.
- **Q-E3-3.** The 12 offline tasks come from the owner's small personal repositories (todo-app, md2pdf, snip and the like), with a check per stage. The originals are read-only: each is copied into a scratch folder. A negative result at that size is reported as inconclusive.
- **Q-E3-4.** The fallbacks are used. No core changes in E3.
- **Q-E3-5, as recommended.** The PS18.3 price-table format, following `examples/inbox/prices/`, with source and date read from the vendor's page.
- **Q-E3-6, as recommended.** The score is per stage, the failing stage is the first, and regression is reported per stage.
- **S550 to S560, accepted on their fallbacks.** Each limit is stated in the certificate and the README.

Start: E3.0, measure first. One heavy job on the machine at a time, shared with the M7 session.
