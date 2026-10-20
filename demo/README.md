# The demo's stand-in and replay driver

This folder holds what Act 1 of the refund demo runs against: a local stand-in for Stripe, a driver that replays a lost answer against a build, and the container that runs both with no route to anywhere. Nothing here reaches the network, reads a key or costs money.

## What is here

- `stand-in/stripe/`: `stripe.mjs` is the documented behaviour of `GET /v1/charges/{id}` and `POST /v1/refunds` with `Idempotency-Key` (a repeated key with the same parameters returns the first response, with other parameters is an error, and a key lasts 24 hours). `server.mjs` serves it, and a WhatsApp Cloud API sink, behind one TLS listener, keeps a log of every request with no secret in it, and reports the five numbers. `faults.mjs` holds the fault scripts: `lost-answer` applies the first refund request and resets the connection before the answer reaches the client; `hold` keeps the connection open instead. `tls.mjs` makes the throwaway authority.
- `driver/`: `replay.mjs` is the driver. It checks the stand-in's own key behaviour first, then runs the **control** (one ordinary refund, no fault: one `POST`, one refund) and then the fault, each against a fresh process of the build, and reads the stand-in's numbers as outcome O1 (the build refunds twice), O2 (once) or O3 (it could not be driven). `map-hosts.cjs` maps the two names to the stand-in outside a container and refuses every other destination.
- `container/`: the image and the compose file. The run has no network at all; the two names resolve to its own loopback.
- `baseline/orders.json`: the synthetic orders. `PROVENANCE.md` says where every number comes from.

## Run it

```sh
node demo/demo.mjs replay --build <the kept tree> --start "<the command its README gives>" --fault lost-answer [--test-command "npm test"]
```

The report has the five numbers for the control and for the fault: requests received, the `POST`s with their keys, refund objects created, `amount_refunded` on the charge, and the reply the customer got. Exit status 0 is O2, 1 is O1, 3 is O3, 4 means the stand-in failed its own check and no build was reported.

In the container, on the owner's terminal:

```sh
BUILD_DIR=<the kept tree> START="<command>" docker compose -f demo/container/docker-compose.yml run --rm replay
```

The image is built once, with a network, from a pinned base; a run never needs one. The tree under test is mounted read-only and is never edited.

## What the tests show

`test/demo-stand-in.test.mjs` shows the key behaviour (DAC9): the same key and parameters create one refund, other parameters are an error, a fresh key on each retry double-refunds, and the fault script applies. `test/demo-driver.test.mjs` shows the driver on doubles of the baseline (DAC8): the double that retries with no key and the one that sends a fresh key are O1, the one that sends a stable key and the one that does not retry are O2, the one that cannot start is O3 and never meets the fault, and a stand-in that ignores the key is refused before any build is reported. `test/demo-container.test.mjs` reads the container files.

## Stated limits

- The stand-in is read from Stripe's documentation, which the owner dates (K17's evidence); it is not Stripe.
- A build's interface is the one the prompt names: a WhatsApp Cloud API webhook at a local port, replies through the Cloud API, refunds through the Stripe API. A build that needs something the stand-in does not model is O3.
- The container run is not started by the tests: it needs an image. The image is built once with a network (`docker build -t poly-demo-replay:step8 -f demo/container/Dockerfile demo`, from `node:24-slim` pinned by digest in the Dockerfile) and every run after that has none. It was run end to end on 2026-10-15 against the four doubles with `network_mode: none`, and the outcomes were the host-side ones: refunds-twice and fresh-key O1, keys and no-retry O2.

## Conclusion

The replay turns the witness of the check into an event on a server that cannot hurt anyone: the first answer is lost, the retry arrives, and the stand-in counts what the build did.

## Glossary

- **O1, O2, O3:** the outcomes of a replay: the build refunded twice, refunded once, or could not be driven.
- **Control:** the run without a fault.
- **Lost answer:** the stand-in applied the request and dropped the connection before the answer arrived.
- **Five numbers:** requests received, `POST`s with their keys, refund objects created, `amount_refunded`, and the customer's reply.


## The room (Step 9)

`launch.mjs` starts the demo: it prints the diff of the demo copy (`concierge/`, produced by `scripts/make-demo-concierge.mjs`) against `examples/concierge`, checks and admits the copy and prints its verdict with its instance, serves the room page (`host/server.mjs`), and gives the presenter a prompt (`status`, `staff`, `approve <intent>`, `resolve <desk> done|not-done`, `kill`, `quit`). Since v1.3.1 the launcher starts itself again with a heap of 8 GB when it has less (the check of the Desk has 5762 states), `resolve` ends a refund of unknown outcome with the presenter's signed record (DF21), and `--stand-in-fault lost-all|down` (recorded and stub rooms only) makes the Stripe mock-up lose every answer or answer 503, to rehearse that case (DF22). `lint/refund-key.mjs` is the small lint of Act 1 part 4, and `scripts/make-mutation-c.mjs` and `scripts/make-diagrams.mjs` make mutation (c) and the state diagrams of `docs/demo/diagrams/`. `--recorded` (the default) answers every model call from the recorded fixture; `--live` uses `host/live-providers.mjs`, refuses to start while the price tables are placeholders, and reads the model key from the environment once.

- `host/room.mjs` and `host/server.mjs`: a guest gets a persona (`personas.mjs`, numbers from the fiction range), types a message, and the room signs it as the WhatsApp Cloud API signs (`signing.mjs`); the runtime's certified adapter verifies it, and `verifier.mjs` maps the verified number to `cust-guest-NN`. A reply goes back through `transport.mjs` to that guest's page alone (server-sent events). The limits are 280 characters, one message in 5 seconds and 12 messages a guest (`limits.mjs`); the kill switch is the presenter's (`POST /presenter/kill` with the token, loopback only, or `kill` at the prompt) and stops the room for everyone.
- `host/vault.mjs`, `host/admission.mjs`, `host/assemble.mjs`: the development vault holds a synthetic token that only the local stand-in accepts (made at start, in memory, written nowhere), the keys of the run are made at start, and the assembly is the same for the launcher and the recorded run.
- `host/live-providers.mjs` and `host/live-transport.mjs`: the model providers of DF6 over a transport the launcher gives. The transport reaches the provider's host alone; the key is a header and nothing else. `host/price-gate.mjs` refuses placeholder price tables.

Tests: `test/demo-room.test.mjs`, `demo-live-providers.test.mjs`, `demo-vault.test.mjs`, `demo-concierge-copy.test.mjs`, `demo-launch.test.mjs`, `demo-secrets.test.mjs` (the scan for credential shapes, the environment reads, the boundary over `demo/`), and the recorded run `test/after/demo-concierge-e2e.test.mjs` (the copy is `CLEAN`, a forged message is refused, a refund over 100 waits for a signed approval, a value outside 0..500 stops at the domain, no guest reaches another's order, the canary leaks nowhere, and the journal replays with no divergence).

### Glossary additions

- **Persona:** the synthetic guest a browser session is given, with a number, an identity and orders that are made up.
- **Kill switch:** the presenter's control that stops the room for everyone.
- **Demo copy:** the concierge as released with only its budget caps changed, produced by a script and checked as itself.
- **Price gate:** the refusal to launch live on price tables that name a placeholder source.

## The spend cap, the stub model and the spend line (Step 12, DF10)

`--live` and `--stub-model` need `--cap-usd <dollars>`, above 0 and at most 10. Without it, or with a value outside that range, the launcher prints `refused: ...` and returns 2 before it reads a key or makes a folder. `host/spend.mjs` holds the meter: before each request it reserves the request's worst case, so the spend never exceeds the cap, and when the cap is reached the room is killed with `spend-cap`. A line `spend: $0.0002 of $0.01 cap, 11 model calls` follows each reply, and `status` adds it. `--stub-model` runs the live path over `host/stub-model.mjs`, which answers locally: no key, no network, and placeholder prices. Tests: `test/demo-spend.test.mjs` and the heavy `test/after/demo-spend-stub.test.mjs` (a fake meter). The runbook of the rehearsal is `docs/demo/rehearsal.md`.

### Glossary additions (Step 12)

- **Cap:** the most a live or stub launch may spend, in dollars, set with `--cap-usd`, at most 10.
- **Meter:** the code that reserves the worst case of each model request and sums what the responses report.
- **Stub model:** a local stand-in for the model provider, used to prove the launcher at no cost.

### Step 12 follow-up: the room answers, and the start times

The rehearsal found that a status question got no answer in the stub room and in the recorded room (DF11): the stub cited no order, the program refuses an uncited answer and then sends nothing, the recorded room's first guests owned no order that its recorded answers cite, and the orders table served fixed dates that the program's `freshness 1h` refuses on the real clock. The stub now cites the orders it is given, `host/recorded-orders.mjs` gives guests 1 and 2 the fixture's orders, and `ordersDb(personas, { now })` serves every row as of the query. `demo.mjs replay` takes `--listen-timeout <ms>` (default 15000) and reports `startedMs`; `../docs/demo/rehearsal-start-times.md` measures the starts.

### Step 12 live rehearsal: failed decisions, timeouts, latency (DF12)

The live rehearsal gave no reply: the program gives the route `triage` a timeout of `800ms`, the live providers vote with 5 asks in two round trips, and both tiers timed out while the abandoned calls were still billed. Now each failed decision is a line on the terminal (`decision failed: classify, tier small, timed out after 800 ms`; `host/failures.mjs`), a refused key is a line, the stub can have a latency (`--stub-latency <ms>`), the demo copy sets the timeouts (`DEMO_TIMEOUTS` in `scripts/make-demo-concierge.mjs`, shown in the printed diff), and `--measure-latency` measures a whole call of each tier with the owner's key and cap. `docs/demo/calibration-for-release.md` states what to do about the calibration maps for the release.

### Live rehearsal, fourth failure: why an ask was rejected, the amount, the log (DF15)

On the refund path every ask of the amount vote was rejected and the line said only `no allowed answer`. The line now says why, with counts and no word of the reply (`no allowed answer (5 asks: 5 value a string)`); the amount parse accepts a bare number or a string of digits with an optional `.00` and nothing else (the domain still sees 5000); the prompt asks for a bare JSON number and no other text; and `launch.mjs --log <file>` writes the failure lines, the spend lines and the status to a file the owner keeps (`host/run-log.mjs`). The amount request carries the customer's message and the orders: checked offline.
