# Support agent: refunds over WhatsApp

Customers message your WhatsApp Business number. The agent reads each message, finds the customer's order in
`orders.json`, refunds it through Stripe, and answers on WhatsApp.

```
Customer: refund ORD-1001
Agent:    I'm refunding $100.00 on order ORD-1001:
          • BLENDER-1 $60.00
          • CUPS-4 $40.00
          I'll message you when the refund is confirmed. It goes back to the card you paid with.
Agent:    Your refund of $60.00 for BLENDER-1 (order ORD-1001) has been issued. …
Agent:    Your refund of $40.00 for CUPS-4 (order ORD-1001) has been issued. …
```

What customers can send:

| Message | What happens |
|---|---|
| `refund ORD-1001` | Every item of the order not yet refunded is refunded |
| `refund ORD-1001 BLENDER-1`, `money back for the blender on order 1001` | That item only |
| `refund please` | With one order on this number, that order; with several, the agent asks which |
| `status ORD-1001` | Each item's refund status |
| anything else | How to ask for a refund |

## Start it

You need Node 24, a Stripe secret key, and a WhatsApp Cloud API app (an access token, the phone number id, the app
secret, and a verify token you choose).

1. **Install.** `npm install`. This also runs `scripts/runtime-model.js` (see [Notes](#notes)).

2. **Make the admission key, once.** It is kept outside the project, in `~/.support-agent/` by default:

   ```sh
   npm run keygen
   ```

   This prints two `export` lines. Run them in your shell:

   ```sh
   export POLY_ADMISSION_KEY="$(cat ~/.support-agent/admission.pem)"   # private key, used to sign
   export POLY_TRUST_KEY=~/.support-agent/admission.pub.pem           # public key, used to load
   ```

3. **Admit the program.** Do this again after any change to `src/`:

   ```sh
   npm run admit
   ```

   This checks `src/support.poly` and lints the effect handlers. If the result is clean, it signs
   `.poly/certificate.json`. The runtime only loads a build that matches its certificate.

4. **Configure and start:**

   ```sh
   export STRIPE_SECRET_KEY=sk_live_…              # or sk_test_… while you try it
   export WHATSAPP_TOKEN=…                         # Cloud API access token
   export WHATSAPP_PHONE_NUMBER_ID=…               # the number customers write to
   export WHATSAPP_APP_SECRET=…                    # Meta app secret: checks X-Hub-Signature-256
   export WHATSAPP_VERIFY_TOKEN=…                  # any string; the same one goes in the Meta dashboard
   export PORT=3000                                # optional, default 3000
   export HOST=127.0.0.1                           # optional; listens on loopback only by default
   npm start
   ```

   It prints `support agent listening on http://127.0.0.1:3000/webhook`.

5. **Connect WhatsApp.** Put a public HTTPS URL in front of the port, for example
   `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Then, in the Meta app dashboard under
   WhatsApp → Configuration, set:
   - the callback URL to `https://<public host>/webhook`;
   - the verify token to the value of `WHATSAPP_VERIFY_TOKEN`;
   - a subscription to the `messages` field.

To edit orders, change `orders.json`. It is read again for every message, so you don't need to restart. Each order
needs `order`, `customer` (the customer's WhatsApp number, digits only), `name`, `charge` (the Stripe charge id),
`currency`, and `items` (each with `sku` and `price` in cents).

The agent keeps its state in `.data/`:
- `runtime.sqlite`: the journal, the ledger and the outbox;
- `tables.json`: the records the replies are written from.

Stop it with Ctrl-C. Anything left unfinished, such as a refund being retried, resumes on the next start.

## Tests

```sh
npm test
```

The tests admit a copy of the project with a key generated for the run. They drive it with stand-ins for Stripe and
the Cloud API, which cover:
- whole-order and single-item refunds, and requests that repeat;
- strangers asking about someone else's order, and items an order doesn't hold;
- webhooks delivered twice, forged webhooks, and the subscription handshake;
- Stripe declining a refund, Stripe failing and being retried under the same idempotency key;
- a restart while a refund is still in progress.

## How it is built

The stateful core is the poly program `src/support.poly`. Check it with `npm run poly check src/support.poly`. It has
two machines:

- **`Line`**: one per item of an order, with instance id `<order>:<index>`.
  - It starts a refund only when the request comes from the number that placed the order (`only-the-owner`).
  - It refunds at most once (`refund-at-most-once`).
  - It always tells the customer the result (`told-when-refunded`, `told-when-not-refunded`).
  - The Stripe refund is an irreversible effect, sent with an `Idempotency-Key` that the runtime sets to the intent id.
    Stripe honours that key for 24 hours, so the up to 3 attempts can't refund twice; the checker verifies this
    (`retry-safe … keyed Idempotency-Key within 24h`).
  - If a refund is declined, or still unconfirmed after its attempts, the line ends `Failed`. The customer is told a
    person will follow up, and the agent never refunds that line again.
- **`Inquiry`**: one per inbound WhatsApp message, keyed by the message id. Each message gets exactly one reply, even
  when Meta delivers the webhook more than once.

What poly doesn't express is plain JavaScript beside it:

| File | Does |
|---|---|
| `src/agent.js` | Works out what a message asks for. These are deterministic rules; no model decides a refund. An item code the order doesn't hold is never read as "the whole order". |
| `src/host.js` | Turns each message into machine steps and keeps the records the replies are written from. A stranger's request is still sent to the `Line`, which refuses it as `not-owner` and journals the attempt. The stranger is told the order wasn't found, so they don't learn it exists. |
| `src/handlers.js` | The effect handlers for `stripe.refund`, `whatsapp.notify` and `whatsapp.reply`. They have no ambient authority (`poly lint handlers`), only the capabilities their effects declare: egress to `https://api.stripe.com/v1/refunds` (exact) or `https://graph.facebook.com/`, the named secrets, and reads of the `lines` and `inquiries` tables. |
| `src/messages.js` | The reply texts. |
| `src/whatsapp.js`, `src/server.js` | The Cloud API webhook: the handshake, the signature check in constant time, and message parsing. |
| `src/app.js`, `src/main.js` | Loading the admitted build, transports, configuration. |

## Notes

- **`scripts/runtime-model.js`.** The vendored `@poly/runtime` package is installed without its `model/` folder.
  That folder holds the lowered builds of the runtime's own outbox model (spec PT9.7), and `load` refuses to start
  without them.
  - The script rebuilds them from the PT9.7 text in `tools/poly/docs/03-technical-spec.md`, at each retry bound from
    1 to 10, using `poly check`.
  - The checker accepts a module named `runtime*` only if its digest is one that `@poly/core` pins for that model, so
    a text that differed from the model would be refused rather than run.
  - The script writes into `node_modules/@poly/runtime/model/` and runs after every `npm install`. Remove it once the
    package ships the folder.
- **WhatsApp's 24-hour window.** The Cloud API allows free-form replies only within 24 hours of the customer's last
  message. Refund notices normally go out within seconds. A notice delayed past the window would need a message
  template, which this agent doesn't send.
- **Graph API version.** The agent calls Graph API `v24.0` (`GRAPH_VERSION` in `src/handlers.js`).
