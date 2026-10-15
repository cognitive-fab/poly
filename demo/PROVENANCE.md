# Provenance of the demo's data

Every customer, number, order and charge in the demo is made up. Nothing here is a person, an account or a payment that exists.

## The synthetic orders (`baseline/orders.json`)

| Order | Customer (WhatsApp id) | Name | Charge | Total | Items |
|---|---|---|---|---|---|
| ORD-1001 | 15550100001 | Ada Demo | `ch_demo_1001` | 100.00 usd | a blender (60.00) and four cups (40.00) |
| ORD-1002 | 15550100002 | Ben Demo | `ch_demo_1002` | 25.00 usd | a mug (25.00) |

The numbers are in the reserved range for fictional use (555-0100 to 555-0199). The charge ids are not Stripe's format: they carry `demo` so that none can be mistaken for a real one.

## The one request every build is driven with

A customer asks for 40.00 of a 100.00 order: "Hello, I'd like a refund of 40.00 for order ORD-1001 (the blender arrived broken)." The sum is below half the charge on purpose. A refund of the whole charge, sent twice, would be refused the second time by Stripe's own rule (a charge refunded in full has nothing left), and the double refund the demo is about could not happen. At 40.00 of 100.00 the second refund is accepted, and `amount_refunded` reaches 80.00.

## The values a build may expect from its environment

`STRIPE_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` and `WHATSAPP_PHONE_NUMBER_ID` are set by the driver to placeholders (`sk_test_standin_synthetic`, `standin-synthetic`, `100000000000001`). They are not secrets, no provider accepts them, and the stand-in accepts any value. The stand-in keeps the scheme of an `Authorization` header and never its value.

## The authority

The certificate authority that lets a build trust the stand-in is made at the start of each run in the operating system's temporary space, is valid for a day, covers `api.stripe.com`, `graph.facebook.com` and the loopback, and is deleted when the run ends. It is not in the repository and is never written under it.

## The doubles of the baseline (`test/fixtures/demo/doubles/`)

Small programs written for the tests, each behaving as one kind of build would: one that retries with no key, one that sends the same key on every attempt, one that sends a fresh key on each attempt, one that does not retry, and one that cannot start. They are not the baseline; the baseline is the agent's build, produced in the owner's terminal (plan step 10).

## Conclusion

The data is invented, the credentials are placeholders, and the only authority is one that does not outlive its run.

## Glossary

- **Stand-in:** the local server that answers as Stripe's refund API and as WhatsApp's Cloud API would, so that no build touches the real ones.
- **Double:** a small program that behaves as one kind of baseline build would, used to test the driver.
- **Control:** the run without a fault. A build that cannot pass it has not been tested by the fault.
- **Throwaway authority:** the certificate authority made for one run and deleted after.
