# Support agent: refunds over WhatsApp

Customers write to your WhatsApp Business number. The agent finds their orders in `orders.json` by their WhatsApp number, quotes a refund, and issues it through Stripe once they confirm. When Stripe answers, the agent tells them how it ended.

```
customer: refund ORD-1001
agent:    I can refund $100.00 for ORD-1001 (BLENDER-1, CUPS-4) to the card you paid with.
          Reply YES to confirm or NO to cancel. This offer is valid for 30 minutes.
customer: yes
agent:    Thank you. I'm issuing your refund of $100.00 for ORD-1001 now, and I'll message you as soon as it is done.
agent:    Your refund of $100.00 for ORD-1001 (BLENDER-1, CUPS-4) has been issued. ...
```

The agent also understands `refund CUPS-4 from ORD-1001` (one item), `status`, `NO`, and `YES ORD-1002` when several refunds are waiting. Messages are read by fixed rules (`lib/parse.js`). No language model is on the path to a refund.

## Starting it

You need Node 24.

1. **Install** the packages:

   ```sh
   npm install
   ```

2. **Make an admission key** (once). The runtime only loads a build whose certificate is signed by this key. The pair is written outside the project, to `~/.support-agent/` (set `SUPPORT_AGENT_KEYS` to change the directory), so the private key is never committed.

   ```sh
   npm run keygen
   ```

3. **Admit the program.** This model-checks `src/support.poly`, lints and certifies `handlers/`, and writes the signed `.poly/certificate.json`. Run it again after any change to `src/` or `handlers/`: the runtime refuses a build whose files changed after admission.

   ```sh
   npm run admit
   ```

4. **Set the environment** and start:

   | Variable | What it is |
   |---|---|
   | `WHATSAPP_TOKEN` | Cloud API access token (a system user token with `whatsapp_business_messaging`) |
   | `WHATSAPP_PHONE_NUMBER_ID` | The phone number id of your business number (WhatsApp Manager, API setup) |
   | `WHATSAPP_APP_SECRET` | Your Meta app's secret, used to check `X-Hub-Signature-256` on every webhook |
   | `WHATSAPP_VERIFY_TOKEN` | Any string. Enter the same one as the webhook's verify token in the app dashboard |
   | `STRIPE_SECRET_KEY` | Stripe secret or restricted key with write access to Refunds |
   | `ADMIN_TOKEN` | Optional. Enables the operator route below |
   | `PORT`, `HOST` | Where to listen. Default `127.0.0.1:3000` |
   | `ORDERS_FILE`, `STORE_FILE` | Default `orders.json` and `data/store.sqlite` (the durable state: orders' machines, outbox, timers, ledger) |

   ```sh
   npm start
   ```

5. **Point the webhook at it.** The server listens on loopback, so expose it with a tunnel or a reverse proxy (for example `cloudflared tunnel --url http://127.0.0.1:3000`). In the Meta app dashboard (WhatsApp → Configuration), set the callback URL to `https://<public host>/webhook` and the verify token to `WHATSAPP_VERIFY_TOKEN`, then subscribe to the `messages` field.

Stop with Ctrl-C. Messages already received are finished first. Refunds in flight resume on the next start, because the outbox is in the store.

## How it is built

The stateful core is a [poly](tools/poly/README.md) program, `src/support.poly`. It is one `Order` machine per order, and the instance id is the order id:

```
New ─Open→ Ready ─RequestAll / RequestLine→ Quoted ─Confirm→ Issuing ─Refunded→ Ready or Closed
                    ↑         Cancel, Expire (30 min) ┘              ├─RefundFailed(Declined)→ Ready
                                                                     └─RefundFailed(Unreachable)→ Review ─ResolveIssued / ResolveNotIssued→
```

- `Confirm` emits the `stripe.refund` effect. Its payload names the lines it covers, and the handler prices them from `orders.json`. The machine marks lines refunded only when Stripe confirms. Four `never` rules state that a refunded line is never sent to Stripe again, and `poly check` proves them over every reachable state (158 states). It also proves there is no deadlock and that a refund in flight always settles.
- `stripe.refund` is `irreversible`, retried up to 3 times, with `idempotent header "Idempotency-Key" window 24h`. The runtime sets the header to the intent id on every attempt, so a retry after a timeout never refunds twice. A Stripe 4xx is final (`Declined`: the customer is told and may ask again). If all three attempts fail to get an answer, the refund may or may not have happened, so the order goes to `Review` instead of being retried blindly.
- `whatsapp.notify` tells the customer the outcome. It is sent at most once, because the Cloud API takes no idempotency key.

The JavaScript beside it covers what poly does not express:

| File | What it does |
|---|---|
| `handlers/stripe.js`, `handlers/whatsapp.js` | Effect handlers. They get only the capabilities their effect declares: the exact Stripe URL or the Graph API prefix, one secret, and read access to the orders table. They are certified with the build. |
| `handlers/lines.js` | Pricing and the wording of notices (pure) |
| `lib/server.js`, `lib/webhook.js` | The webhook: handshake, signature check, message extraction, one sender at a time. Also `POST /admin/orders/<id>/resolve` |
| `lib/agent.js`, `lib/parse.js` | Turns a message into an action on the sender's own order, and words the reply. Only `RequestAll`, `RequestLine`, `Confirm` and `Cancel` are reachable from a message. |
| `lib/orders.js` | Loads and checks `orders.json`. An order with more than 4 items, or whose items don't add up to its total, is logged at start and not served. |
| `lib/host.js`, `scripts/` | Loads the certified build, the transports, keygen, admission, start |

Each WhatsApp message id is the action id of the step it takes, so a webhook Meta delivers twice takes its step once.

### When Stripe could not be reached

The customer is told a person is checking. Look the refund up in the Stripe dashboard (search the metadata `order`), then record what you found:

```sh
curl -X POST http://127.0.0.1:3000/admin/orders/ORD-1001/resolve \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"issued": true}'
```

`true` closes the lines as refunded. `false` lets the customer ask again. Either way the customer gets a message.

## Tests

```sh
npm test
```

The tests admit the program in a temporary copy, under a key made for the run, and drive it against fake Stripe and Cloud API endpoints. They cover:

- full and per-item refunds
- another customer's order
- quote expiry
- duplicate webhooks
- Stripe 5xx and dropped connections, retried under one idempotency key
- Stripe refusals
- the review path
- forged signatures and the handshake, over HTTP

To check the poly module alone: `npm run poly check src/support.poly`.
