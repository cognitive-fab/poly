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
